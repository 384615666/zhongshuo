/**
 * outbox 派发 worker（§11.2/§11.3）：CAS 领取 → 建 run/turn/session → 经适配器执行 →
 * 规范化事件落库（消息入正确线程）→ 预算结算 → completeOutbox。
 *
 * 防线（修复轮 2026-09-27 收口）：
 * - 派发门禁：恢复后 dispatch_gate=held，worker 不领取，等用户确认继续（§16.4-6/决策 44/E7）。
 * - 崩溃重领对账：dispatch_key 已有 turn（DISPATCHING 不确定窗口）→ 不再执行，标 failed 留审计（RT-03 语义）。
 * - 模式门禁：M0 仅 DIRECT；AUTO/DELIBERATE 任务进 BLOCKED，不冒充执行（总任务书 §6.1）。
 * - 会话打开竞态：openSession 返回后复查停止代次/终态，停止已生效则不 startTurn。
 * - 独立截止计时：沉默 runtime 也会按时中断；中断后宽限内仍无终结 → UNKNOWN（结果不确定，不伪造）。
 * - 验收策略收尾：user_review → REVIEW + pending 交付；auto_deliver → DONE + not_required（§10.5）。
 * - 迟到完成不复活停止：turn 已 STOPPING 时完成事件走取消收尾并留 lateCompletion 审计（RT-06 形态）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { claimNextOutbox, completeOutbox, failOutbox, releaseOutbox } from '../persistence/outbox.ts';
import type { OutboxRow } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { isDispatchGateHeld } from '../persistence/daemonState.ts';
import type { RuntimeAdapter, NormalizedRuntimeEvent, SessionRef } from '../contracts/runtime.ts';
import type { TopLevelRouteOutcome } from '../contracts/routing.ts';
import type { BudgetState } from '../contracts/budget.ts';
import { settleTurns } from '../domain/budget.ts';
import { assembleDirectTurn } from './turnInput.ts';
import { readMemberRuntimeBinding } from './memberRuntime.ts';
import { DispatchAdmission } from './admission.ts';
import { renderStandingPrompt, scanSensitivePatterns, taskCompleteSchema } from '../contracts/prompts.ts';
import {
  assembleStepInput,
  onStepOutput,
  parseDelibStep,
  parseRepairTarget,
  prepareDeliberation,
  pumpDeliberation,
  repairDispatchKey,
  type DelibStep,
} from './deliberationRunner.ts';
import { budgetAccounting, occupyTailForDispatch, settleTurn } from '../contracts/deliberation.ts';
import type { DeliberationBudgetState } from '../contracts/deliberation.ts';

interface TaskRow {
  id: string;
  project_id: string;
  conversation_id: string;
  room_id: string;
  conversation_thread_id: string;
  root_message_id: string | null;
  owner_member_id: string | null;
  status: string;
  review_policy: string;
  stop_generation: number;
  route_json: string | null;
  title: string;
  objective: string | null;
}

interface ProjectRow {
  id: string;
  canonical_path: string;
}

interface MemberRow {
  id: string;
  project_id: string;
  enabled: number;
}

export interface DispatchWorkerOptions {
  db: ZhongshuoDatabase;
  adapter: RuntimeAdapter;
  leaseOwner: string;
  leaseMs?: number;
  /** 单 turn 截止（独立于事件流计时）：超时先中断。 */
  turnDeadlineMs?: number;
  /** 中断后的等待上限：仍无终结 → UNKNOWN。 */
  interruptGraceMs?: number;
  /** DIRECT 预算上限（决策 12：6）。 */
  maxTurns?: number;
  /** 应用数据目录（层 A draftDir 变量与未来快照存储）；DEV-07 接真实 appData。 */
  appDataDir?: string;
  /** DELIBERATE 编排开关（M1）：默认关闭——后端与正式 UI 链路具备证据后才放开。 */
  enableDeliberate?: boolean;
  /** E4 缺席容忍（默认 20 分钟）；测试用小值假时钟推进。 */
  absenceToleranceMs?: number;
  /** 排队等待观察线（只诊断，不记成员缺席）。 */
  dispatchWaitDeadlineMs?: number;
  /** DELIBERATE 总调用上限覆盖（缺省按 E12 核心公式推导）。 */
  deliberateMaxTurns?: number;
  /** 可注入时钟（默认 Date.now）：领取租约/泵判定在判定时点取当前时间，drain 循环不复用旧 now。 */
  clock?: () => number;
  /**
   * 成员级 adapter 选择（DEV-10 生产接线）：按成员 runtime 绑定（memberRuntime.registry）
   * 选择 adapter；缺省回落单一 adapter（历史行为，全部现有测试路径不变）。
   */
  adapterFor?: (memberId: string) => RuntimeAdapter;
  /**
   * E4 调度解耦（M2 前置最小实现）：true=turn 事件消费不阻塞 drain（独立消费器+成员级
   * 在途互斥+租约续期），阶段泵可在 turn 在途期间推进屏障（absenceGrace 到点→缺席推进，
   * 不强杀成员）。默认 false=inline 串行（历史行为）。
   */
  detachedTurnConsumption?: boolean;
  /** 统一派发准入（global/project/provider/member/write-root；默认按 env 上限构建）。 */
  admission?: DispatchAdmission;
  /** 未绑定成员的 provider 维度键（entry 传 runtime 标识）。 */
  defaultProviderKey?: string;
}

export class DispatchWorker {
  private readonly db: ZhongshuoDatabase;
  private readonly adapter: RuntimeAdapter;
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly turnDeadlineMs: number;
  private readonly interruptGraceMs: number;
  private readonly maxTurns: number;
  private readonly appDataDir: string;
  private readonly enableDeliberate: boolean;
  private readonly absenceToleranceMs: number;
  private readonly dispatchWaitDeadlineMs?: number;
  private readonly deliberateMaxTurns?: number;
  private readonly clock: () => number;
  private readonly adapterForMember?: (memberId: string) => RuntimeAdapter;
  private readonly live = new Map<string, { turnId: string; sessionId: string; adapter: RuntimeAdapter }>();
  /** E4 解耦：detached 模式的在途 turn 消费器（成员级互斥+stop 收敛依据）。 */
  private readonly detached: boolean;
  private readonly admission: DispatchAdmission;
  private readonly defaultProviderKey: string;
  private accepting = true;
  /** 强制退出路径：消费器循环检测后按 UNKNOWN 收尾退出（保证关库后零回调写库）。 */
  private aborting = false;
  /** 关闭状态机已启动（stopAccepting）：启动窗口内晚返回的 openSession 不得继续正常启动下一步。 */
  private shutdownStarted = false;
  /**
   * 启动窗口登记（准入占位后 → 消费器登记/启动收尾）：晚返回的 openSession/startTurn
   * 既不在 live 也不在 inFlightTurns——不登记则 stop 收敛对启动中的派发不可见。
   */
  private readonly startingTurns = new Map<string, { memberId: string; projectId: string }>();
  private readonly inFlightTurns = new Map<string, {
    memberId: string;
    promise: Promise<void>;
    outbox: { id: number; attemptEpoch: number } | null;
    leaseKeeper: NodeJS.Timeout | null;
  }>();
  /** 成员在途期间暂不派发的 outbox 行（outboxId → memberId）。 */
  private readonly blockedOutbox = new Map<number, string>();

  constructor(options: DispatchWorkerOptions) {
    this.db = options.db;
    this.adapter = options.adapter;
    this.adapterForMember = options.adapterFor;
    this.detached = options.detachedTurnConsumption === true;
    this.admission = options.admission ?? new DispatchAdmission();
    this.defaultProviderKey = options.defaultProviderKey ?? 'default-runtime';
    this.leaseOwner = options.leaseOwner;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.turnDeadlineMs = options.turnDeadlineMs ?? 60_000;
    this.interruptGraceMs = options.interruptGraceMs ?? 5_000;
    this.maxTurns = options.maxTurns ?? 6;
    this.appDataDir = options.appDataDir ?? join(tmpdir(), 'zhongshuo-appdata');
    this.enableDeliberate = options.enableDeliberate === true;
    this.absenceToleranceMs = options.absenceToleranceMs ?? 20 * 60_000;
    this.dispatchWaitDeadlineMs = options.dispatchWaitDeadlineMs;
    this.deliberateMaxTurns = options.deliberateMaxTurns;
    this.clock = options.clock ?? (() => Date.now());
  }

  private deliberationOptions() {
    return { absenceToleranceMs: this.absenceToleranceMs, dispatchWaitDeadlineMs: this.dispatchWaitDeadlineMs, runMaxTurns: this.deliberateMaxTurns, blobDir: join(this.appDataDir, 'artifacts') };
  }

  /** 成员级 adapter（DEV-10）：有成员绑定解析器时按成员选择，否则全局单 adapter。 */
  private adapterOf(memberId: string): RuntimeAdapter {
    return this.adapterForMember != null ? this.adapterForMember(memberId) : this.adapter;
  }

  /** 处理一条 outbox 项；返回是否处理了（门禁 held/无项返回 false）。 */
  async runOnce(now?: number): Promise<boolean> {
    if (this.accepting === false) return false; // 退出安全边界：拒新领取（在执行的当前项继续）
    if (isDispatchGateHeld(this.db)) return false;
    // 时钟：在判定时点读取（可注入）；drain 循环每轮取新值，不复用进入时的 now。
    const at = now ?? this.clock();
    // DELIBERATE 泵：屏障推进/下一步入队（幂等；不依赖完成事件驱动）。
    // detached 模式下 drain 不被在途 turn 阻塞——泵可在成员在途期间按 absenceGrace 推进（E4）。
    if (this.enableDeliberate) this.pumpDeliberations(at);
    const claimed = claimNextOutbox(this.db, {
      leaseOwner: this.leaseOwner,
      leaseUntil: at + this.leaseMs,
      now: at,
      skipIds: [...this.blockedOutbox.keys()],
    });
    if (claimed == null) return false;
    await this.dispatchClaimed(claimed);
    return true;
  }

  private pumpDeliberations(now: number): void {
    const runs = this.db
      .prepare("SELECT task_id FROM workflow_runs WHERE mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING')")
      .all() as Array<{ task_id: string }>;
    for (const r of runs) {
      pumpDeliberation(this.db, r.task_id, this.deliberationOptions(), now);
    }
  }

  /** 排空当前可领取的 outbox（门禁 held 时为 0）。 */
  async drain(): Promise<number> {
    let processed = 0;
    while (await this.runOnce()) processed += 1;
    return processed;
  }

  /** 停止流程回调：向在途 turn 发送协议中断（§16.3）。 */
  async interruptTurn(turnId: string): Promise<void> {
    const liveEntry = this.live.get(turnId);
    if (liveEntry == null) return;
    await liveEntry.adapter.interrupt({ id: liveEntry.sessionId } as never, turnId);
  }

  private async dispatchClaimed(claimed: OutboxRow): Promise<void> {
    // DELIBERATE 步骤键：task:{id}:delib:{stage}:{member}:{round}:{purpose}
    const repairStep = parseRepairTarget(claimed.dispatch_key);
    const delibStep = parseDelibStep(claimed.dispatch_key);
    if (repairStep != null || delibStep != null) {
      if (!this.enableDeliberate) {
        await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
        return;
      }
      await this.dispatchDeliberationStep(claimed, repairStep ?? delibStep!, repairStep != null ? repairDispatchKey(repairStep) === claimed.dispatch_key : false);
      return;
    }
    const taskId = parseInitialTaskId(claimed.dispatch_key);
    if (taskId == null) {
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    // 崩溃重领对账：dispatch_key 已有 turn（上次领取进入过 DISPATCHING，副作用不确定）→
    // 不再执行；标 failed 留审计，等人工/恢复流程核对（RT-03 RECONCILE 语义）。
    const existingTurn = this.db
      .prepare('SELECT id, status FROM agent_turns WHERE dispatch_key = ?')
      .get(claimed.dispatch_key) as { id: string; status: string } | undefined;
    if (existingTurn != null) {
      failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      const taskRow = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
      if (taskRow != null) {
        this.audit(taskRow, null, existingTurn.id, 'run.reconcileRequired', {
          dispatchKey: claimed.dispatch_key,
          existingTurnId: existingTurn.id,
          reason: 'crash-reclaimed-dispatch',
        });
      }
      return;
    }

    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (task == null || task.stop_generation > 0 || task.status === 'CANCELLED' || task.status === 'DONE') {
      // 全停代次/终态阻止旧派发（§11.4）。
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    const route = task.route_json != null ? (JSON.parse(task.route_json) as TopLevelRouteOutcome) : null;
    // DELIBERATE：编排开关开启时走 PREPARE（程序完成）；关闭时维持模式门禁 BLOCKED。
    if (route != null && route.kind === 'dispatch' && route.mode === 'DELIBERATE' && this.enableDeliberate) {
      const prepared = prepareDeliberation(
        this.db,
        { id: task.id, conversationId: task.conversation_id, threadId: task.conversation_thread_id ?? null },
        route,
        this.deliberationOptions(),
      );
      if (!prepared.ok) {
        await this.transitionTask(task.id, 'BLOCKED');
        this.audit(task, null, null, 'task.deliberationPrepareFailed', { message: prepared.error.message });
      } else {
        this.audit(task, prepared.value.runId, null, 'run.prepared', { mode: 'DELIBERATE' });
      }
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    // 模式门禁：M0 仅 DIRECT；AUTO/DELIBERATE 未实现前明确不可用，不冒充单成员执行。
    if (route == null || route.kind !== 'dispatch' || route.mode !== 'DIRECT') {
      await this.transitionTask(task.id, 'BLOCKED');
      this.audit(task, null, null, 'task.statusChanged', {
        status: 'BLOCKED',
        reason: 'mode_unavailable_in_m0',
        mode: route?.kind === 'dispatch' ? route.mode : null,
      });
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    const project = this.db
      .prepare('SELECT id, display_name, canonical_path FROM projects WHERE id = ?')
      .get(task.project_id) as (ProjectRow & { display_name: string }) | undefined;
    const member = this.db
      .prepare('SELECT id, project_id, display_name, enabled FROM project_members WHERE id = ?')
      .get(task.owner_member_id ?? '') as (MemberRow & { display_name: string }) | undefined;
    if (project == null || member == null || member.enabled !== 1) {
      await this.transitionTask(task.id, 'BLOCKED');
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const room = this.db
      .prepare('SELECT id, name FROM rooms WHERE id = ?')
      .get(task.room_id) as { id: string; name: string } | undefined;
    const conversationKind = (
      this.db.prepare('SELECT kind FROM conversations WHERE id = ?').get(task.conversation_id) as { kind: 'room' | 'dm' } | undefined
    )?.kind;

    const runId = `run_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    const budget: BudgetState = {
      grantId: runId,
      maxTurns: this.maxTurns,
      usedTurns: 0,
      inFlightReservedTurns: 1,
    };

    // 输入组装（DEV-21-M0）：必要材料缺失/敏感命中 → 组装失败，不建 run、不派发。
    const assembled = assembleDirectTurn({
      db: this.db,
      task: {
        id: task.id,
        projectId: task.project_id,
        conversationId: task.conversation_id,
        conversationKind: conversationKind ?? 'room',
        roomId: task.room_id,
        threadId: task.conversation_thread_id,
        rootMessageId: task.root_message_id,
        title: task.title,
        objective: task.objective,
        taskRevision: 0,
      },
      identity: {
        member: { id: member.id, displayName: member.display_name },
        project: { id: project.id, displayName: project.display_name },
        room: room ?? { id: task.room_id, name: '未命名房间' },
      },
      turnId,
      budget,
    });
    if (!assembled.ok) {
      await this.transitionTask(task.id, 'BLOCKED');
      this.audit(task, null, null, 'task.contextAssemblyFailed', {
        reason: (assembled.error.details as { reason?: string } | undefined)?.reason ?? 'assembly-failed',
        message: assembled.error.message,
      });
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    // 统一派发准入（global/project/provider/member/write-root；启动窗口前占位——覆盖
    // openSession/startTurn；拒绝方放回 pending 并 skip，其他成员/项目的项照常领取）。
    const admission = this.admission.tryAcquire(turnId, {
      memberId: member.id,
      projectId: task.project_id,
      providerKey: this.providerKeyOf(member.id),
      writeRootKey: null, // 当前全只读档（plan/analyze）；写档接入点就绪（B6）
    });
    if (!admission.granted) {
      releaseOutbox(this.db, claimed.id, claimed.attempt_epoch);
      this.blockedOutbox.set(claimed.id, `admission:${admission.reason}`);
      this.audit(task, null, null, 'run.admissionDeferred', { reason: admission.reason, dispatchKey: claimed.dispatch_key });
      return;
    }

    // 启动窗口登记（准入后整个启动过程入统一生命周期）：createRun 记录写入 → 常驻提示词 →
    // openSession → 会话记录 → startTurn → 消费器登记。任何一步失败按两分类收尾
    // （settleStartupFailure：确认未启动=清理+释放；不确定=UNKNOWN+保留占位+对账）。
    this.startingTurns.set(turnId, { memberId: member.id, projectId: task.project_id });
    let startupPhase: 'records' | 'standing-prompt' | 'openSession' | 'session-record' | 'startTurn' = 'records';
    let openedSession: { adapter: RuntimeAdapter; session: SessionRef } | null = null;
    try {
      const createRun = this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json)
           VALUES (?, ?, ?, ?, 'DIRECT', 0, 'RUNNING', ?)`,
        ).run(runId, task.id, task.conversation_id, task.conversation_thread_id, JSON.stringify(budget));
        this.db.prepare(
          `INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES (?, ?, 'owner', 1, 'active')`,
        ).run(runId, member.id);
        this.db.prepare(
          `INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch)
           VALUES (?, ?, ?, ?, ?, 'direct.work', 'RUNNING', ?, 1, 1)`,
        ).run(turnId, runId, task.conversation_id, task.conversation_thread_id, member.id, claimed.dispatch_key);
        this.db.prepare('UPDATE outbox SET turn_id = ? WHERE id = ?').run(turnId, claimed.id);
        // ContextBundle 落库：信封全文 + hash（与发给模型的文本同源，PP-04 可核对）。
        this.db.prepare(
          `INSERT INTO context_bundles (id, turn_id, thread_id, task_revision, baseline_id, included_refs_json, scope_grants_json, hash)
           VALUES (?, ?, ?, 0, NULL, ?, '[]', ?)`,
        ).run(assembled.value.bundleId, turnId, task.conversation_thread_id, JSON.stringify(assembled.value.envelope), assembled.value.hash);
        this.transitionTask(task.id, 'ACTIVE');
        this.audit(task, runId, turnId, 'run.created', { mode: 'DIRECT', bundleId: assembled.value.bundleId, resultKey: assembled.value.resultKey });
      });
      createRun();

      // 层 A 常驻提示词：会话绑定渲染快照（规格 §5.1；渲染失败/敏感命中不开会话）。
      startupPhase = 'standing-prompt';
      const draftDir = join(this.appDataDir, 'drafts', task.project_id);
      const standing = renderStandingPrompt({
        conversationKind: conversationKind ?? 'room',
        vars: {
          memberId: member.id,
          memberDisplayName: member.display_name,
          projectId: project.id,
          projectName: project.display_name,
          roomId: task.room_id,
          roomName: room?.name ?? '未命名房间',
          threadId: task.conversation_thread_id,
          taskId: task.id,
          workspacePath: project.canonical_path,
          draftDir,
        },
      });
      if (!standing.ok) throw new Error(`standing-prompt-render-failed: ${standing.error.message}`);
      if (scanSensitivePatterns(standing.value.text).length > 0) throw new Error('sensitive-standing-prompt: 层 A 渲染命中敏感模式（PP-03）');

      // 会话：任务/成员/generation 维度（§13.4）；adapter 按成员 runtime 绑定选择（DEV-10）。
      startupPhase = 'openSession';
      const adapter = this.adapterOf(member.id);
      const generation = this.db
        .prepare('SELECT count(*) c FROM runtime_sessions WHERE member_id = ? AND conversation_id = ?')
        .get(member.id, task.conversation_id) as { c: number };
      const session = await adapter.openSession({
        projectId: task.project_id,
        memberId: member.id,
        taskId: task.id,
        threadId: task.conversation_thread_id,
        sessionGeneration: generation.c,
        cwd: project.canonical_path,
        policyId: 'policy-analyze',
        developerInstructions: standing.value.text,
        promptVersion: standing.value.version,
      });
      openedSession = { adapter, session };
      startupPhase = 'session-record';
      this.db.prepare(
        `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd)
         VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
      ).run(
        session.id, task.project_id, task.conversation_id, task.conversation_thread_id,
        member.id, task.id, generation.c, project.canonical_path,
      );

      // 会话打开竞态复查（修复轮）+ 关闭状态检查（第五轮）：停止/终态/daemon 关闭在
      // openSession await 期间生效 → 不启动 turn（情形①：turn 从未交给 runtime）。
      if (this.stoppingOrTerminal(task.id, turnId) || this.shutdownStarted) {
        const closeOutcome = await this.closeSessionBounded(adapter, session);
        const cancel = this.db.transaction(() => {
          this.casTurn(turnId, 'CANCELLED');
          this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')`).run(runId);
          this.transitionTask(task.id, 'CANCELLED');
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: this.shutdownStarted ? 'daemon-shutdown-during-session-open' : 'stop-during-session-open', sessionClose: closeOutcome });
        });
        cancel();
        this.releaseAdmission(turnId);
        await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
        return;
      }

      this.live.set(turnId, { turnId, sessionId: session.id, adapter });
      startupPhase = 'startTurn';
      await adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: assembled.value.bundleId,
        text: assembled.value.text,
        policyId: 'policy-analyze',
        taskRevision: 0,
        resultKey: assembled.value.resultKey,
      });
      await this.consumeTurn(task, runId, turnId, session.id, adapter, member.id, { id: claimed.id, attemptEpoch: claimed.attempt_epoch });
      // detached：consumeTurn 已登记消费器并返回（live/outbox 完结由消费器收尾）；
      // inline：此处返回时 turn 已终态、outbox 已完结。
    } catch (dispatchError) {
      // 启动失败统一收尾（第五轮：openSession/startTurn/记录写入全覆盖，两分类——
      // 确认未启动=清理+释放占位；不确定=UNKNOWN+保留占位+对账要求）。
      await this.settleStartupFailure(task, runId, turnId, { id: claimed.id, attemptEpoch: claimed.attempt_epoch }, startupPhase, dispatchError, openedSession);
      throw dispatchError;
    } finally {
      if (!this.detached) {
        this.live.delete(turnId); // detached：消费器 finally 删（停止请求须可达）
        this.releaseAdmission(turnId); // inline：终态/启动失败统一回收（幂等——consumeTurn 已释放则 no-op）
      }
      this.startingTurns.delete(turnId); // 成功路径消费器登记时已删（幂等）；失败路径在此兜底
    }
  }

  /**
   * DIRECT 启动失败收尾（统一生命周期，2026-09-28 第五轮）——两分类：
   * ① 确认没有启动执行、没有遗留活动进程（记录写入/常驻提示词失败——runtime 从未被调用；
   *    或会话记录写入失败且会话确认关闭）：终态 FAILED、释放占位、outbox 完结、任务回 ACTIVE/BLOCKED；
   * ② 请求可能已被 runtime 接收或进程状态不确定（openSession 抛错——无法关闭从未拿到的会话；
   *    startTurn 抛错——请求可能已发出；会话记录失败且关闭未确认）：UNKNOWN 收尾（持久化
   *    不确定状态）、保留准入占位（不提前放行）、outbox 留待租约超时重领 → existingTurn
   *    对账（RT-03）。均留审计后上抛原错误（drain 记日志，信号不丢）。
   */
  private async settleStartupFailure(
    task: TaskRow, runId: string, turnId: string,
    outbox: { id: number; attemptEpoch: number },
    phase: 'records' | 'standing-prompt' | 'openSession' | 'session-record' | 'startTurn',
    error: unknown,
    openedSession: { adapter: RuntimeAdapter; session: SessionRef } | null = null,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const finishUncertain = (note: string): void => {
      // ② 不确定：UNKNOWN（settleUnknown 含 DIRECT run→INTERRUPTED/审计）；live 清理
      // （未登记消费器）；可能残留的进程由 stop 状态机的 adapter 级 dispose 收拢。
      this.settleUnknown(task, runId, turnId, `startup-failed-${phase}`);
      this.audit(task, runId, turnId, 'turn.startupFailed', {
        phase, message: message.slice(0, 200), classification: 'uncertain', note,
      });
      this.live.delete(turnId);
      this.releaseAdmission(turnId); // UNKNOWN → 不释放（releaseAdmission 自查）
    };
    if (phase === 'openSession' || phase === 'startTurn') {
      finishUncertain('准入占位保留（UNKNOWN 语义）；outbox 留待租约重领对账（RT-03）');
      return;
    }
    if (phase === 'session-record') {
      // 部分资源（会话）已取得、turn 未启动：有界关闭——确认关闭 → ① 清理收尾；未确认 → ② 不确定。
      const closeOutcome = openedSession != null
        ? await this.closeSessionBounded(openedSession.adapter, openedSession.session)
        : 'close-failed' as const;
      if (closeOutcome !== 'closed') {
        finishUncertain(`会话关闭未确认（${closeOutcome}）——保留占位待对账`);
        return;
      }
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, 'FAILED');
        this.db.prepare(`UPDATE workflow_runs SET status = 'FAILED' WHERE id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')`).run(runId);
        this.transitionTask(task.id, 'ACTIVE');
        this.audit(task, runId, turnId, 'turn.startupFailed', { phase, message: message.slice(0, 200), classification: 'confirmed-not-started', sessionClose: closeOutcome });
      });
      tx();
      this.releaseAdmission(turnId);
      try { await completeOutbox(this.db, outbox.id, outbox.attemptEpoch); } catch { /* db 故障时尽力而为 */ }
      return;
    }
    // ① 确认未启动（记录写入/常驻提示词失败——runtime 从未被调用）：终态 FAILED + 释放占位 + outbox 完结。
    const tx = this.db.transaction(() => {
      this.casTurn(turnId, 'FAILED');
      this.db.prepare(`UPDATE workflow_runs SET status = 'FAILED' WHERE id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')`).run(runId);
      this.transitionTask(task.id, phase === 'standing-prompt' ? 'BLOCKED' : 'ACTIVE');
      this.audit(task, runId, turnId, 'turn.startupFailed', { phase, message: message.slice(0, 200), classification: 'confirmed-not-started' });
    });
    tx();
    this.releaseAdmission(turnId);
    try { await completeOutbox(this.db, outbox.id, outbox.attemptEpoch); } catch { /* db 故障时尽力而为（异常上抛保留信号） */ }
  }

  /**
   * turn 事件消费（E4 解耦入口）：
   * - inline（默认）：await 到终态，返回时 outbox 已完结（历史行为，全部既有测试依赖）；
   * - detached：登记消费器后立即返回（drain 不被阻塞——泵可在在途期间推进屏障）；
   *   outbox 完结/租约续期/成员互斥解除都由消费器 finally 收口。
   */
  private async consumeTurn(
    task: TaskRow, runId: string, turnId: string, sessionId: string, adapter: RuntimeAdapter,
    memberId: string, outbox: { id: number; attemptEpoch: number },
  ): Promise<void> {
    if (!this.detached) {
      this.startingTurns.delete(turnId); // 启动窗口结束（inline 消费阻塞 drain——drainPending 兜底）
      try {
        await this.consumeUntilTerminal(task, runId, turnId, sessionId, adapter);
      } finally {
        this.releaseAdmission(turnId); // 终态/失败/取消统一回收（UNKNOWN 不释放——对账未定不提前放行）
        await completeOutbox(this.db, outbox.id, outbox.attemptEpoch);
      }
      return;
    }
    const settle = (): void => {
      // 关库后到达（强制退出路径残余消费者）不再抛——恢复语义由 UNKNOWN 审计承载。
      try { completeOutbox(this.db, outbox.id, outbox.attemptEpoch); } catch { /* 已关库：恢复语义承载 */ }
      this.live.delete(turnId); // detached：live 由消费器收尾删（inline 已由调用方删，幂等）
      try { this.releaseAdmission(turnId); } catch { /* 已关库：准入账本随进程消亡 */ }
    };
    const promise = this.consumeUntilTerminal(task, runId, turnId, sessionId, adapter)
      .then(() => undefined)
      .catch((error) => {
        process.stderr.write(`[zhongshuo-worker] turn 消费器异常（turnId=${turnId}）：${error instanceof Error ? error.stack : String(error)}\n`);
      })
      .finally(() => {
        const entry = this.inFlightTurns.get(turnId);
        if (entry?.leaseKeeper != null) clearInterval(entry.leaseKeeper);
        this.inFlightTurns.delete(turnId);
        settle();
      });
    // 租约续期：detached 消费可长于租约窗口；完结以 attemptEpoch fencing 保护。
    const leaseKeeper = setInterval(() => {
      this.db
        .prepare(`UPDATE outbox SET lease_until = ? WHERE id = ? AND attempt_epoch = ? AND status = 'leased'`)
        .run(this.clock() + this.leaseMs, outbox.id, outbox.attemptEpoch);
    }, Math.max(1_000, Math.floor(this.leaseMs / 2)));
    leaseKeeper.unref?.();
    this.inFlightTurns.set(turnId, { memberId, promise, outbox, leaseKeeper });
    this.startingTurns.delete(turnId); // 启动窗口结束（消费器已登记——stop 收敛改看 inFlightTurns）
  }

  /**
   * 准入占位释放 + 解除排队 skip（终态时保守清全部——skip 项下一轮重试判定）。
   * UNKNOWN 不释放：结果不确定（对账未定）不提前放行——由恢复/强制退出路径收口。
   */
  private releaseAdmission(turnId: string): void {
    const st = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string } | undefined;
    if (st?.status === 'UNKNOWN') return;
    this.admission.release(turnId);
    this.blockedOutbox.clear();
  }

  /** 成员绑定的 runtime kind（provider 维度准入键；未绑定回落默认 runtime 标识）。 */
  private providerKeyOf(memberId: string): string {
    return readMemberRuntimeBinding(this.db, memberId)?.kind ?? this.defaultProviderKey;
  }

  /** 停止接新派发（退出状态机：drain 安全边界——正在执行的当前项继续，不再领取新项）。 */
  stopAccepting(): void {
    this.accepting = false;
    this.shutdownStarted = true;
  }

  /** 中止全部消费器（强制退出路径专用）：循环内检测→按既有 UNKNOWN 语义收尾后退出。 */
  abortConsumers(): void {
    this.aborting = true;
  }

  /** 对全部在途 turn 发送停止请求（退出状态机第 4 步；只发送，不等退出确认/不挂起）。 */
  async requestStopAll(): Promise<string[]> {
    const ids = [...this.live.keys()];
    for (const turnId of ids) {
      // 发送限时：adapter.interrupt 可能永不返回（hangInterrupt 反例）——不阻塞状态机。
      void Promise.race([
        this.interruptTurn(turnId),
        new Promise((r) => { const t = setTimeout(r, 2_000); t.unref?.(); }),
      ]).catch(() => {});
    }
    return ids;
  }

  /** stop 收敛：等待全部在途消费器终态（有界；超时返回剩余 turnId——不确定，不假装完成）。 */
  async awaitInFlightTurns(timeoutMs = 10_000): Promise<{ settled: number; remaining: string[] }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entries = [...this.inFlightTurns.entries()];
      if (entries.length === 0) return { settled: 0, remaining: [] };
      if (Date.now() > deadline) return { settled: 0, remaining: entries.map(([id]) => id) };
      await Promise.race([
        Promise.allSettled(entries.map(([, e]) => e.promise)),
        new Promise((r) => { const t = setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))); t.unref?.(); }),
      ]);
    }
  }

  /**
   * stop 收敛（graceful/force 共用，2026-09-28 第五轮）：同时覆盖「启动中的派发」
   * （startingTurns——晚返回的 openSession 尚未登记 live/消费器）与「运行中的消费器」；
   * 超时返回剩余（不确定，不假装完成）。
   */
  async awaitSettlement(timeoutMs = 10_000): Promise<{ remaining: Array<{ turnId: string; phase: 'starting' | 'consuming' }> }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = [
        ...[...this.startingTurns.keys()].map((turnId) => ({ turnId, phase: 'starting' as const })),
        ...[...this.inFlightTurns.keys()].map((turnId) => ({ turnId, phase: 'consuming' as const })),
      ];
      if (remaining.length === 0) return { remaining: [] };
      if (Date.now() > deadline) return { remaining };
      await Promise.race([
        Promise.allSettled([...this.inFlightTurns.values()].map((e) => e.promise)),
        new Promise((r) => { const t = setTimeout(r, Math.min(200, Math.max(1, deadline - Date.now()))); t.unref?.(); }),
      ]);
    }
  }

  /** 有界关闭会话（启动窗口取消/失败清理）：close 可能挂起——限时返回结果，不假装已关闭。 */
  private async closeSessionBounded(adapter: RuntimeAdapter, session: SessionRef, timeoutMs = 2_000): Promise<'closed' | 'close-failed' | 'close-timeout'> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        adapter.close(session).then(() => 'closed' as const),
        new Promise<'close-timeout'>((r) => { timer = setTimeout(() => r('close-timeout'), timeoutMs); }),
      ]);
      return outcome;
    } catch {
      return 'close-failed';
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  /** DELIBERATE 步骤派发：预算核对/占用 → turn 建立 → 按成员会话 → 事件消费（复用截止/中断纪律）。 */
  private async dispatchDeliberationStep(claimed: OutboxRow, step: DelibStep, isRepair: boolean): Promise<void> {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(step.taskId) as TaskRow | undefined;
    if (task == null || ['CANCELLED', 'DONE'].includes(task.status)) {
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    if (task.stop_generation > 0) {
      // 停止已生效：完结本步骤并把运行收尾为取消（停止作用于指定运行，§7.3）。
      const run0 = this.db.prepare("SELECT id, status FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE'").get(step.taskId) as { id: string; status: string } | undefined;
      if (run0 != null && !['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(run0.status)) {
        const tx0 = this.db.transaction(() => {
          this.db.prepare("UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?").run(run0.id);
          this.transitionTask(task.id, 'CANCELLED');
          this.audit(task, run0.id, null, 'turn.statusChanged', { status: 'CANCELLED', reason: 'stop-before-dispatch' });
        });
        tx0();
      }
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    // 活跃 run（最新非终态）：阶段查询/派发/预算都绑定它——旧 run 的遗留步骤不执行。
    const run = activeDeliberationRun(this.db, step.taskId);
    if (run == null || ('runId' in step && step.runId != null && step.runId !== run.id)) {
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const repairError = isRepair ? this.kvGet(`delib:repair:${claimed.dispatch_key}`) : undefined;
    const assembly = assembleStepInput(this.db, { taskId: step.taskId, runId: run.id, step, repairError: repairError ?? undefined });
    if (!assembly.ok) {
      await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      this.audit(task, run.id, null, 'task.contextAssemblyFailed', { reason: 'delib-assembly-failed', message: assembly.error.message, stage: step.stage });
      return;
    }
    const budget = (run.budget_json != null ? JSON.parse(run.budget_json) : null) as DeliberationBudgetState | null;
    if (budget == null) {
      await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const accStage = step.stage === 'SYN' ? 'SYNTHESIS' : step.stage === 'RAT' ? 'RATIFY' : 'front';
    const acc = budgetAccounting(budget, accStage);
    if (acc.stageAvailableTurns < 1) {
      this.audit(task, run.id, null, 'run.budgetSkipped', { dispatchKey: claimed.dispatch_key, stageAvailableTurns: acc.stageAvailableTurns, remaining: acc.remainingTurns });
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      pumpDeliberation(this.db, task.id, this.deliberationOptions());
      return;
    }
    const nextBudget = accStage === 'front' ? budget : occupyTailForDispatch(budget, accStage);

    const member = this.db
      .prepare('SELECT id, display_name FROM project_members WHERE id = ?')
      .get(step.memberId) as { id: string; display_name: string } | undefined;
    if (member == null) {
      await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const project = this.db.prepare('SELECT id, display_name, canonical_path FROM projects WHERE id = ?').get(task.project_id) as (ProjectRow & { display_name: string }) | undefined;
    const room = this.db.prepare('SELECT id, name FROM rooms WHERE id = ?').get(task.room_id) as { id: string; name: string } | undefined;
    if (project == null) {
      await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const turnId = `turn_${randomUUID()}`;
    // 统一派发准入（与 DIRECT 同一账本/语义；预算在上方已核对——预算限总量、准入限并发，不混用）。
    const admission = this.admission.tryAcquire(turnId, {
      memberId: step.memberId,
      projectId: task.project_id,
      providerKey: this.providerKeyOf(step.memberId),
      writeRootKey: null, // 只读档；写档接入点就绪（B6）
    });
    if (!admission.granted) {
      releaseOutbox(this.db, claimed.id, claimed.attempt_epoch);
      this.blockedOutbox.set(claimed.id, `admission:${admission.reason}`);
      this.audit(task, run.id, null, 'run.admissionDeferred', { reason: admission.reason, dispatchKey: claimed.dispatch_key });
      return;
    }

    // 启动窗口登记（与 DIRECT 同一生命周期；失败分类见 settleDelibStartupFailure）。
    this.startingTurns.set(turnId, { memberId: step.memberId, projectId: task.project_id });
    let startupPhase: 'records' | 'standing-prompt' | 'openSession' | 'session-record' | 'startTurn' = 'records';
    let openedSession: { adapter: RuntimeAdapter; session: SessionRef } | null = null;
    try {
      const textHash = createHash('sha256').update(assembly.value.text, 'utf8').digest('hex');
      const bundleId = `cb_${randomUUID()}`;
      const createTurn = this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, turn_purpose, status, dispatch_key, attempt, epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, 1, 1)`,
        ).run(turnId, run.id, task.conversation_id, task.conversation_thread_id, step.memberId, assembly.value.stageKey, assembly.value.turnPurpose, claimed.dispatch_key);
        this.db.prepare('UPDATE outbox SET turn_id = ? WHERE id = ?').run(turnId, claimed.id);
        this.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(nextBudget), run.id);
        this.db.prepare(
          `INSERT INTO context_bundles (id, turn_id, thread_id, task_revision, baseline_id, included_refs_json, scope_grants_json, hash)
           VALUES (?, ?, ?, 0, NULL, ?, '[]', ?)`,
        // 全文入 bundle（PP-04：真实输入可核对——审计用 sha256(text) 复核）。
        ).run(bundleId, turnId, task.conversation_thread_id, JSON.stringify({ stage: assembly.value.stage, memberId: step.memberId, roundNo: step.roundNo, turnPurpose: assembly.value.turnPurpose, instruction: assembly.value.instruction, outputContract: assembly.value.outputContract, text: assembly.value.text }), textHash);
        if (task.status === 'PENDING') this.transitionTask(task.id, 'ACTIVE');
      });
      createTurn();

      startupPhase = 'standing-prompt';
      const standing = renderStandingPrompt({
        conversationKind: 'room',
        vars: {
          memberId: member.id,
          memberDisplayName: member.display_name,
          projectId: project.id,
          projectName: project.display_name,
          roomId: task.room_id,
          roomName: room?.name ?? '未命名房间',
          threadId: task.conversation_thread_id,
          taskId: task.id,
          workspacePath: project.canonical_path,
          draftDir: join(this.appDataDir, 'drafts', task.project_id),
        },
      });
      if (!standing.ok) throw new Error(`standing-prompt-render-failed: ${standing.error.message}`);
      if (scanSensitivePatterns(standing.value.text).length > 0) throw new Error('sensitive-standing-prompt: 层 A 渲染命中敏感模式（PP-03）');

      startupPhase = 'openSession';
      const adapter = this.adapterOf(step.memberId);
      const generation = this.db
        .prepare('SELECT count(*) c FROM runtime_sessions WHERE member_id = ? AND conversation_id = ?')
        .get(step.memberId, task.conversation_id) as { c: number };
      const session = await adapter.openSession({
        projectId: task.project_id,
        memberId: step.memberId,
        taskId: task.id,
        threadId: task.conversation_thread_id,
        sessionGeneration: generation.c,
        cwd: project.canonical_path,
        policyId: 'policy-analyze',
        developerInstructions: standing.value.text,
        promptVersion: standing.value.version,
      });
      openedSession = { adapter, session };
      startupPhase = 'session-record';
      this.db.prepare(
        `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd)
         VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
      ).run(session.id, task.project_id, task.conversation_id, task.conversation_thread_id, step.memberId, task.id, generation.c, project.canonical_path);

      if (this.stoppingOrTerminal(task.id, turnId) || this.shutdownStarted) {
        const closeOutcome = await this.closeSessionBounded(adapter, session);
        const cancel = this.db.transaction(() => {
          this.casTurn(turnId, 'CANCELLED');
          this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')`).run(run.id);
          this.transitionTask(task.id, 'CANCELLED');
          this.audit(task, run.id, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: this.shutdownStarted ? 'daemon-shutdown-during-session-open' : 'stop-during-session-open', sessionClose: closeOutcome });
        });
        cancel();
        this.releaseAdmission(turnId);
        await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
        return;
      }

      this.live.set(turnId, { turnId, sessionId: session.id, adapter });
      startupPhase = 'startTurn';
      await adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: bundleId,
        text: assembly.value.text,
        policyId: 'policy-analyze',
        taskRevision: 0,
        resultKey: `result_${turnId}`,
      });
      await this.consumeTurn(task, run.id, turnId, session.id, adapter, step.memberId, { id: claimed.id, attemptEpoch: claimed.attempt_epoch });
    } catch (dispatchError) {
      await this.settleDelibStartupFailure(task, run.id, turnId, step, { id: claimed.id, attemptEpoch: claimed.attempt_epoch }, startupPhase, dispatchError, openedSession);
      throw dispatchError;
    } finally {
      if (!this.detached) {
        this.live.delete(turnId);
        this.releaseAdmission(turnId); // inline：终态/启动失败统一回收（幂等）
      }
      this.startingTurns.delete(turnId); // 成功路径消费器登记时已删（幂等）；失败路径在此兜底
    }
  }

  /**
   * DELIB 启动失败收尾（与 DIRECT 同一分类纪律，2026-09-28 第五轮）：
   * ① 确认未启动（记录写入/常驻提示词/会话记录失败且会话确认关闭）：turn FAILED + 预算结算
   *    + 成员标 failed（run 继续——泵推进缺席/修复路径）+ 释放占位；
   * ② 不确定（openSession/startTurn 抛错、会话关闭未确认）：UNKNOWN + 成员 absent（run 继续）
   *    + 保留占位 + outbox 留待租约重领对账（RT-03）。
   */
  private async settleDelibStartupFailure(
    task: TaskRow, runId: string, turnId: string, step: DelibStep,
    outbox: { id: number; attemptEpoch: number },
    phase: 'records' | 'standing-prompt' | 'openSession' | 'session-record' | 'startTurn',
    error: unknown,
    openedSession: { adapter: RuntimeAdapter; session: SessionRef } | null = null,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const finishConfirmed = (extra: Record<string, unknown>): void => {
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, 'FAILED');
        this.settleDelibBudget(runId);
        this.db.prepare("UPDATE run_participants SET status = 'failed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, step.memberId);
        this.audit(task, runId, turnId, 'turn.startupFailed', { phase, message: message.slice(0, 200), classification: 'confirmed-not-started', ...extra });
      });
      tx();
      this.releaseAdmission(turnId);
      pumpDeliberation(this.db, task.id, this.deliberationOptions());
    };
    const finishUncertain = (note: string): void => {
      // settleUnknown 的 delib.* 分支：成员 absent、run 继续、泵推进。
      this.settleUnknown(task, runId, turnId, `startup-failed-${phase}`);
      this.audit(task, runId, turnId, 'turn.startupFailed', { phase, message: message.slice(0, 200), classification: 'uncertain', note });
      this.live.delete(turnId);
      this.releaseAdmission(turnId); // UNKNOWN → 不释放
    };
    if (phase === 'openSession' || phase === 'startTurn') {
      finishUncertain('准入占位保留（UNKNOWN 语义）；outbox 留待租约重领对账（RT-03）');
      return;
    }
    if (phase === 'session-record') {
      const closeOutcome = openedSession != null
        ? await this.closeSessionBounded(openedSession.adapter, openedSession.session)
        : 'close-failed' as const;
      if (closeOutcome !== 'closed') {
        finishUncertain(`会话关闭未确认（${closeOutcome}）——保留占位待对账`);
        return;
      }
      finishConfirmed({ sessionClose: closeOutcome });
      try { await completeOutbox(this.db, outbox.id, outbox.attemptEpoch); } catch { /* 尽力而为 */ }
      return;
    }
    finishConfirmed({});
    try { await completeOutbox(this.db, outbox.id, outbox.attemptEpoch); } catch { /* 尽力而为 */ }
  }

  /** 审批/等待暂停累计（E4：暂停不计入成员执行时间）。M1 研讨路径未接审批桥——
   *  接线点就绪：approval.requested 记起点、resolved/turn 回 RUNNING 时结算累计。 */
  accumulateApprovalPause(turnId: string, pausedMs: number): void {
    this.db.prepare('UPDATE agent_turns SET exec_paused_ms = exec_paused_ms + ? WHERE id = ?').run(Math.max(0, pausedMs), turnId);
  }

  private kvGet(key: string): string | null {
    return (this.db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  private kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, Date.now());
  }

  private settleDelibBudget(runId: string): void {
    const row = this.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string } | undefined;
    if (row?.budget_json == null) return;
    const state = JSON.parse(row.budget_json) as DeliberationBudgetState;
    this.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(settleTurn(state)), runId);
  }

  private stoppingOrTerminal(taskId: string, turnId: string): boolean {
    const task = this.db
      .prepare('SELECT stop_generation, status FROM tasks WHERE id = ?')
      .get(taskId) as { stop_generation: number; status: string } | undefined;
    if (task == null) return true;
    if (task.stop_generation > 0 || task.status === 'CANCELLED' || task.status === 'DONE') return true;
    const turn = this.db
      .prepare('SELECT status FROM agent_turns WHERE id = ?')
      .get(turnId) as { status: string } | undefined;
    if (turn == null || ['STOPPING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(turn.status)) {
      return true;
    }
    return false;
  }

  /**
   * 消费事件直到终结；截止计时独立于事件流（沉默 runtime 也会按时中断）。
   * 中断后宽限内仍无终结 → UNKNOWN（§10.2 结果不确定，不伪造成功/失败）。
   * 实现注意（修复轮 2 收口）：
   * - async iterator 不允许并发 next——race 输掉的读取必须保留复用，否则吞事件。
   * - race 侧的定时器在事件获胜时 clearTimeout 并 unref，不悬挂进程。
   * - adapter.interrupt() 本身可能永不返回：限时发送（宽限剩余时间为上限）后立即
   *   回到主循环，宽限计时由主循环承担，不因 interrupt 挂起而失效。
   */
  private async consumeUntilTerminal(task: TaskRow, runId: string, turnId: string, sessionId: string, adapter: RuntimeAdapter = this.adapter): Promise<void> {
    const deadline = Date.now() + this.turnDeadlineMs;
    const interruptDeadline = deadline + this.interruptGraceMs;
    const iterator = adapter.events({ id: sessionId } as never)[Symbol.asyncIterator]();
    let interruptSent = false;
    let pending: Promise<IteratorResult<NormalizedRuntimeEvent, undefined>> | null = null;

    for (;;) {
      if (this.aborting) {
        // 强制退出路径（循环内检测，含已进入等待的消费器）：UNKNOWN 收尾后退出——
        // 保证关库后零回调写库。
        this.settleUnknown(task, runId, turnId, 'forced-shutdown-abort');
        return;
      }
      const now = Date.now();
      const wakeAt = interruptSent ? interruptDeadline : deadline;
      // 等待上限 200ms：多醒仅重评估（截止/中断/中止判定不变）——保证强制退出中止
      // 与既有时序在最坏一个轮询周期内被感知。
      const waitMs = Math.min(200, Math.max(1, wakeAt - now));
      const nextPromise: Promise<IteratorResult<NormalizedRuntimeEvent, undefined>> =
        pending ?? iterator.next();
      pending = null;
      let timer: NodeJS.Timeout | undefined;
      const timerPromise = new Promise<'timer'>((resolve) => {
        timer = setTimeout(() => resolve('timer'), waitMs);
        timer.unref?.();
      });
      const winner = await Promise.race([nextPromise, timerPromise]);
      clearTimeout(timer);
      if (winner === 'timer') {
        pending = nextPromise; // 保留进行中的读取，不吞事件
        const at = Date.now();
        if (!interruptSent && at >= deadline) {
          interruptSent = true;
          // interrupt 限时发送：不 await 其完成；宽限由主循环计时（挂起也不影响）。
          void Promise.race([
            adapter.interrupt({ id: sessionId } as never, turnId),
            new Promise((resolve) => {
              const guard = setTimeout(resolve, Math.max(1, interruptDeadline - Date.now()));
              guard.unref?.();
            }),
          ]).catch(() => {
            // 发送失败/超时：宽限到点后按不确定处理。
          });
          continue;
        }
        if (interruptSent && at >= interruptDeadline) break; // 中断后仍无终结：不确定
        continue;
      }
      if (winner.done) break;
      const event = winner.value;
      if (event.sessionId !== sessionId) continue;

      if (event.turnId != null && event.turnId !== turnId) {
        this.audit(task, runId, turnId, 'turn.lateEventArrived', { eventKey: event.eventKey, kind: event.kind });
        continue;
      }
      // 终态事件必须可归属（turnId 匹配本 turn）：未知归属的 turn.completed/turn.failed
      // （provider turn 无法映射，修复轮 3）不得终结/污染当前 turn，只记审计。
      if (
        (event.kind === 'turn.completed' || event.kind === 'turn.failed') &&
        event.turnId == null
      ) {
        this.audit(task, runId, turnId, 'turn.unattributedTerminal', { eventKey: event.eventKey, kind: event.kind });
        continue;
      }
      const turnRow = this.db
        .prepare('SELECT status FROM agent_turns WHERE id = ?')
        .get(turnId) as { status: string } | undefined;
      if (turnRow == null) break;
      if (isTurnTerminalStatus(turnRow.status)) break;

      this.applyEvent(task, runId, turnId, event);
      if (event.kind === 'turn.completed' || event.kind === 'turn.failed') return;
    }

    this.settleUnknown(task, runId, turnId);
  }

  /** UNKNOWN 收尾（§10.2 结果不确定，不伪造）：截止后无终态/强制退出中止共用。 */
  private settleUnknown(task: TaskRow, runId: string, turnId: string, reason = 'no-terminal-after-deadline'): void {
    const current = this.db
      .prepare('SELECT status FROM agent_turns WHERE id = ?')
      .get(turnId) as { status: string } | undefined;
    if (current != null && !isTurnTerminalStatus(current.status)) {
      const stageKey = (this.db.prepare('SELECT stage_key FROM agent_turns WHERE id = ?').get(turnId) as { stage_key: string }).stage_key;
      const tx = this.db.transaction(() => {
        this.db.prepare(`UPDATE agent_turns SET status = 'UNKNOWN' WHERE id = ?`).run(turnId);
        if (stageKey.startsWith('delib.')) {
          // 研讨轮结果不确定：成员级缺席（E4），运行继续——不因单成员 UNKNOWN 杀死整个研讨。
          const memberRow = this.db.prepare('SELECT member_id FROM agent_turns WHERE id = ?').get(turnId) as { member_id: string };
          this.db.prepare("UPDATE run_participants SET status = 'absent' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, memberRow.member_id);
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'UNKNOWN', reason, memberAbsenced: memberRow.member_id });
        } else {
          this.db.prepare(`UPDATE workflow_runs SET status = 'INTERRUPTED' WHERE id = ?`).run(runId);
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'UNKNOWN', reason });
        }
      });
      tx();
      if (stageKey.startsWith('delib.')) pumpDeliberation(this.db, task.id, this.deliberationOptions());
    }
  }

  private applyEvent(task: TaskRow, runId: string, turnId: string, event: NormalizedRuntimeEvent): void {
    // DELIBERATE turn：终态处理走研讨合同（产物校验/屏障/修复），不复用 DIRECT 交付路径。
    const turnMeta = this.db.prepare('SELECT stage_key, dispatch_key FROM agent_turns WHERE id = ?').get(turnId) as { stage_key: string; dispatch_key: string | null } | undefined;
    if (turnMeta?.stage_key != null && turnMeta.stage_key.startsWith('delib.')) {
      // E4 执行时钟：turn.started 起算；审批/等待输入暂停在状态迁移处累计（生产接线）。
      if (event.kind === 'turn.started') {
        this.db.prepare('UPDATE agent_turns SET exec_started_at = ? WHERE id = ? AND exec_started_at IS NULL').run(this.clock(), turnId);
      }
      if (event.kind === 'approval.requested' || event.kind === 'input.requested') {
        // 暂停起点（kv）；等待审批/输入期间不计入有效执行时间。
        const waitKey = `delib:pause:${turnId}`;
        if (this.kvGet(waitKey) == null) this.kvSet(waitKey, String(this.clock()));
        this.db.prepare('UPDATE agent_turns SET status = ? WHERE id = ? AND status = ?').run(event.kind === 'approval.requested' ? 'WAITING_APPROVAL' : 'WAITING_INPUT', turnId, 'RUNNING');
      } else {
        // 非 wait 事件到达=暂停结束（审批已处理/输入已续）：结算累计并回 RUNNING。
        const waitKey = `delib:pause:${turnId}`;
        const pauseStart = this.kvGet(waitKey);
        if (pauseStart != null) {
          this.accumulateApprovalPause(turnId, this.clock() - Number(pauseStart));
          this.db.prepare('DELETE FROM daemon_state WHERE key = ?').run(waitKey);
          const st = (this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string }).status;
          if (st === 'WAITING_APPROVAL' || st === 'WAITING_INPUT') this.casTurn(turnId, 'RUNNING');
        }
      }
      this.applyDeliberationTerminal(task, runId, turnId, turnMeta.dispatch_key ?? '', event);
      return;
    }
    switch (event.kind) {
      case 'turn.started': {
        const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
        if (turn.status === 'STOPPING') {
          // 停止先于开始回执生效：不回到 RUNNING，再发中断并留审计。
          this.audit(task, runId, turnId, 'turn.stoppingRace', { note: 'turn.started after stop; re-interrupting' });
          void (this.live.get(turnId)?.adapter ?? this.adapter).interrupt({ id: event.sessionId } as never, turnId);
          break;
        }
        this.casTurn(turnId, 'RUNNING');
        break;
      }
      case 'message.completed':
        this.insertThreadReply(task, turnId, event.messageId, event.text);
        break;
      case 'tool.started': {
        // 实际工具调用记录（用户令 2026-09-28）：模型自述 executedVerifications 的核对依据——
        // 有记录=实际行为证据；无记录=模型自述、未采信。
        this.audit(task, runId, turnId, 'tool.started', { toolCallId: event.toolCallId, toolName: event.toolName, eventKey: event.eventKey });
        break;
      }
      case 'tool.completed': {
        this.audit(task, runId, turnId, 'tool.completed', { toolCallId: event.toolCallId, outcome: event.outcome, eventKey: event.eventKey });
        break;
      }
      case 'usage.updated':
        this.db
          .prepare(
            `INSERT INTO usage_records (turn_id, provider_event_id, reported_json, normalized_json, cost_quality)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (turn_id, provider_event_id) DO NOTHING`,
          )
          .run(turnId, event.eventKey, JSON.stringify(event), JSON.stringify(event), event.costQuality);
        break;
      case 'turn.completed': {
        const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
        const lateAfterStop = turn.status === 'STOPPING';
        const tx = this.db.transaction(() => {
          if (lateAfterStop) {
            // 停止已生效：迟到完成不复活任务（RT-06 形态），按取消收尾并留审计。
            this.casTurn(turnId, 'CANCELLED');
            this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?`).run(runId);
            this.settleBudget(runId);
            this.transitionTask(task.id, 'CANCELLED');
            this.audit(task, runId, turnId, 'turn.lateCompletion', { finalText: event.finalText ?? null });
            this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: 'late-completion-after-stop' });
            return;
          }
          // 输出合同校验（修复轮）：finalText 必须是合法 TaskComplete 且 resultKey 匹配本 turn。
          // 非法输出（空/散文/缺项/错版本/错 resultKey）走 OUTPUT_INVALID：不产生交付、不 DONE/REVIEW，
          // 原稿保留（消息已入库），任务回 ACTIVE；有限修复 turn 随调度器扩展（规格 §4.5）。
          const finalText = event.finalText ?? '';
          const contract = this.validateTaskCompleteOutput(finalText, `result_${turnId}`);
          if (!contract.ok) {
            this.casTurn(turnId, 'FAILED');
            this.db.prepare(`UPDATE workflow_runs SET status = 'FAILED' WHERE id = ?`).run(runId);
            this.settleBudget(runId);
            this.transitionTask(task.id, 'ACTIVE');
            this.audit(task, runId, turnId, 'turn.outputInvalid', {
              issues: contract.issues,
              rawLength: finalText.length,
            });
            return;
          }
          this.casTurn(turnId, 'SUCCEEDED');
          this.db.prepare(`UPDATE workflow_runs SET status = 'SUCCEEDED' WHERE id = ?`).run(runId);
          this.settleBudget(runId);
          // 交付与验收（§10.5）：按任务快照策略收尾；user_review 进 REVIEW + pending 交付（唯一待办）。
          // 追加 turn 的再交付：revision 递增、旧 pending 标 superseded（§10.5-5 替换当前待办）。
          const manifestHash = createHash('sha256').update(finalText).digest('hex');
          const deliveryId = `dlv_${turnId}`;
          const reviewStatus = task.review_policy === 'user_review' ? 'pending' : 'not_required';
          const prevRevision = (this.db
            .prepare('SELECT COALESCE(MAX(revision), 0) r FROM task_deliveries WHERE task_id = ?')
            .get(task.id) as { r: number }).r;
          if (prevRevision > 0) {
            this.db.prepare(
              `UPDATE task_deliveries SET review_status = 'superseded' WHERE task_id = ? AND review_status = 'pending'`,
            ).run(task.id);
          }
          this.db.prepare(
            `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json,
               change_set_refs_json, verification_refs_json, review_status)
             VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?)`,
          ).run(deliveryId, task.id, runId, prevRevision + 1, manifestHash, JSON.stringify([`turn:${turnId}:final`]), reviewStatus);
          this.db.prepare('UPDATE tasks SET current_delivery_id = ? WHERE id = ?').run(deliveryId, task.id);
          this.transitionTask(task.id, task.review_policy === 'user_review' ? 'REVIEW' : 'DONE');
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'SUCCEEDED', reviewStatus, deliveryRevision: prevRevision + 1 });
        });
        tx();
        break;
      }
      case 'turn.failed': {
        // 用户停止判定（与 DELIB 口径一致）：INTERRUPTED + stop_generation 已推进/任务已
        // CANCELLED。无用户停止的 INTERRUPTED=单轮截止中断——结果不确定（请求可能已发出），
        // UNKNOWN 收尾，不伪造取消/失败。
        const taskNowStop = this.db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(task.id) as { stop_generation: number; status: string } | undefined;
        const userStop = event.code === 'INTERRUPTED' && (taskNowStop != null && (taskNowStop.stop_generation > 0 || taskNowStop.status === 'CANCELLED'));
        if (event.code === 'INTERRUPTED' && !userStop) {
          this.settleUnknown(task, runId, turnId, 'turn-deadline-interrupt');
          break;
        }
        const tx = this.db.transaction(() => {
          const interrupted = userStop;
          this.casTurn(turnId, interrupted ? 'CANCELLED' : 'FAILED');
          this.db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(interrupted ? 'CANCELLED' : 'FAILED', runId);
          this.settleBudget(runId);
          this.transitionTask(task.id, interrupted ? 'CANCELLED' : 'ACTIVE');
          this.audit(task, runId, turnId, 'turn.statusChanged', {
            status: interrupted ? 'CANCELLED' : 'FAILED',
            code: event.code,
            message: event.message.slice(0, 400), // 失败取证（真实跑挂时 stderr 尾部在此，不丢现场）
            retryable: event.retryable,
          });
        });
        tx();
        break;
      }
      default:
        break; // delta/tool 事件 M0 不落库（流式与工具明细归 DEV-07/14 展示层）
    }
  }

  /** DELIBERATE 终态：完成→产物校验计入屏障（或一次格式修复）；失败/中断→缺席或停止语义。 */
  private applyDeliberationTerminal(task: TaskRow, runId: string, turnId: string, dispatchKey: string, event: NormalizedRuntimeEvent): void {
    const baseStep = parseRepairTarget(dispatchKey) ?? parseDelibStep(dispatchKey);
    if (event.kind === 'turn.completed') {
      const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
      if (turn.status === 'STOPPING') {
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'CANCELLED');
          this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?`).run(runId);
          this.settleDelibBudget(runId);
          this.transitionTask(task.id, 'CANCELLED');
          this.audit(task, runId, turnId, 'turn.lateCompletion', { finalText: event.finalText ?? null });
        });
        tx();
        return;
      }
      if (baseStep == null) {
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'FAILED');
          this.audit(task, runId, turnId, 'turn.outputInvalid', { issues: ['dispatch_key 无法解析为研讨步骤'] });
        });
        tx();
        return;
      }
      const out = onStepOutput(this.db, {
        taskId: task.id,
        runId,
        step: baseStep,
        turnId,
        finalText: event.finalText ?? '',
        options: this.deliberationOptions(),
      });
      if (!out.ok) {
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'FAILED');
          this.settleDelibBudget(runId);
          this.db.prepare("UPDATE run_participants SET status = 'failed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, baseStep.memberId);
          this.audit(task, runId, turnId, 'run.stepFailed', { stage: baseStep.stage, message: out.error.message });
        });
        tx();
        pumpDeliberation(this.db, task.id, this.deliberationOptions());
        return;
      }
      if (out.value.counted) {
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'SUCCEEDED');
          this.settleDelibBudget(runId);
          this.audit(task, runId, turnId, 'run.stepArtifact', { stage: baseStep.stage, memberId: baseStep.memberId, roundNo: baseStep.roundNo });
        });
        tx();
        pumpDeliberation(this.db, task.id, this.deliberationOptions());
        return;
      }
      if (out.value.lateRecorded === true) {
        // 运行终态/停止/stale-run 后的迟到输出：材料已记录（run.lateArrivalRecorded）——
        // 不是格式问题，不入格式修复、不复活运行；turn 如实收 SUCCEEDED（已产出，恢复不重跑）。
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'SUCCEEDED');
          this.settleDelibBudget(runId);
          this.audit(task, runId, turnId, 'turn.lateRecorded', { stage: baseStep.stage, memberId: baseStep.memberId, roundNo: baseStep.roundNo });
        });
        tx();
        pumpDeliberation(this.db, task.id, this.deliberationOptions());
        return;
      }
      const repairKey = repairDispatchKey(baseStep);
      const repairTurn = this.db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(repairKey) as { id: string } | undefined;
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, 'FAILED');
        this.settleDelibBudget(runId);
        if (repairTurn == null && baseStep.stage !== 'RAT') {
          this.kvSet(`delib:repair:${repairKey}`, out.value.needsRepair ?? '格式无效');
          this.db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(repairKey);
          this.audit(task, runId, turnId, 'turn.outputInvalid', { issues: [out.value.needsRepair ?? ''], repairEnqueued: repairKey });
        } else {
          this.db.prepare("UPDATE run_participants SET status = 'failed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, baseStep.memberId);
          this.audit(task, runId, turnId, 'turn.outputInvalid', { issues: [out.value.needsRepair ?? ''], repairExhausted: true });
        }
      });
      tx();
      pumpDeliberation(this.db, task.id, this.deliberationOptions());
      return;
    }
    if (event.kind === 'turn.failed') {
      const taskNow = this.db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(task.id) as { stop_generation: number; status: string } | undefined;
      const runNow = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string } | undefined;
      // 用户停止 = stop_generation 已推进或 run 已 STOPPING；否则 INTERRUPTED 是
      // 单轮截止中断（取证轮确认的误判源）——成员级缺席，运行继续。
      const userStop = event.code === 'INTERRUPTED' && (taskNow != null && (taskNow.stop_generation > 0 || taskNow.status === 'CANCELLED') || runNow?.status === 'STOPPING');
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, userStop ? 'CANCELLED' : 'FAILED');
        this.settleDelibBudget(runId);
        if (userStop) {
          this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?`).run(runId);
          this.transitionTask(task.id, 'CANCELLED');
        } else if (baseStep != null) {
          this.db.prepare("UPDATE run_participants SET status = ? WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')")
            .run(event.code === 'INTERRUPTED' ? 'absent' : 'failed', runId, baseStep.memberId);
        }
        this.audit(task, runId, turnId, 'turn.statusChanged', { status: userStop ? 'CANCELLED' : 'FAILED', code: event.code, message: event.message, source: userStop ? 'user-stop' : 'member-terminal' });
      });
      tx();
      if (!userStop) pumpDeliberation(this.db, task.id, this.deliberationOptions());
      return;
    }
    if (event.kind === 'usage.updated') {
      this.db.prepare(
        `INSERT INTO usage_records (turn_id, provider_event_id, reported_json, normalized_json, cost_quality)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (turn_id, provider_event_id) DO NOTHING`,
      ).run(turnId, event.eventKey, JSON.stringify(event), JSON.stringify(event), event.costQuality);
    }
  }

  private insertThreadReply(task: TaskRow, turnId: string, messageId: string, text: string): void {
    // 消息身份以 turn 为命名空间：同 turn 内重放去重（RT-05），跨 turn/会话的同名 provider id 不冲突。
    const rowId = `msg_${turnId}_${messageId}`;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM messages WHERE id = ?')
        .get(rowId) as { id: string } | undefined;
      if (existing != null) return;
      const convSeq = this.db
        .prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_id) as { last_message_seq: number };
      const threadSeq = this.db
        .prepare('UPDATE conversation_threads SET last_message_seq = last_message_seq + 1, revision = revision + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_thread_id) as { last_message_seq: number };
      const author = this.db
        .prepare('SELECT member_id FROM agent_turns WHERE id = ?')
        .get(turnId) as { member_id: string } | undefined;
      this.db.prepare(
        `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
           thread_message_seq, author_type, author_id, body_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, 'final', ?)`,
      ).run(
        rowId, task.project_id, task.conversation_id, convSeq.last_message_seq,
        task.room_id, task.conversation_thread_id, task.id, threadSeq.last_message_seq,
        author?.member_id ?? 'unknown_member', JSON.stringify({ text }), Date.now(),
      );
      appendDomainEvent(this.db, {
        schemaVersion: 1,
        eventId: `evt_${randomUUID()}`,
        projectId: task.project_id,
        conversationId: task.conversation_id,
        threadId: task.conversation_thread_id,
        taskId: task.id,
        turnId,
        kind: 'thread.replyAdded',
        createdAt: Date.now(),
        payload: { messageId: rowId }, // 与数据库行 ID 一致（UI 按事件可定位到消息）
      });
    });
    tx();
  }

  /** TaskComplete 输出合同校验：JSON 解析、schema、版本、resultKey 绑定（修复轮）。 */
  private validateTaskCompleteOutput(finalText: string, expectedResultKey: string): { ok: true } | { ok: false; issues: string[] } {
    const issues: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(finalText);
    } catch {
      return { ok: false, issues: ['finalText 不是 JSON（期望 TaskComplete 结构化输出）'] };
    }
    const result = taskCompleteSchema.safeParse(parsed);
    if (!result.success) {
      issues.push(...result.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`));
      return { ok: false, issues };
    }
    if (result.data.resultKey !== expectedResultKey) {
      issues.push(`resultKey 不匹配：期望 ${expectedResultKey}，实际 ${result.data.resultKey}`);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true };
  }

  private casTurn(turnId: string, status: string): void {
    // 终态不可覆盖（§10.2）；允许 STOPPING→终态迁移。
    this.db
      .prepare(`UPDATE agent_turns SET status = ? WHERE id = ? AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','UNKNOWN')`)
      .run(status, turnId);
  }

  private settleBudget(runId: string): void {
    const row = this.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string } | undefined;
    if (row?.budget_json == null) return;
    const state = JSON.parse(row.budget_json) as BudgetState;
    const settled = settleTurns(state, 1);
    this.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(settled), runId);
  }

  private transitionTask(taskId: string, status: string): void {
    const info = this.db
      .prepare('UPDATE tasks SET status = ?, revision = revision + 1 WHERE id = ? AND status != ?')
      .run(status, taskId, status);
    if (info.changes > 0) {
      const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      this.audit(task, null, null, 'task.statusChanged', { status });
    }
  }

  private audit(
    task: TaskRow,
    runId: string | null,
    turnId: string | null,
    kind: string,
    payload: unknown,
  ): void {
    appendDomainEvent(this.db, {
      schemaVersion: 1,
      eventId: `evt_${randomUUID()}`,
      projectId: task.project_id,
      conversationId: task.conversation_id,
      threadId: task.conversation_thread_id,
      taskId: task.id,
      runId: runId ?? undefined,
      turnId: turnId ?? undefined,
      kind,
      createdAt: Date.now(),
      payload,
    });
  }
}

/** 活跃研讨 run：最新非终态（同任务多 run 时阶段/派发/预算都绑它）。 */
export interface ActiveDelibRun {
  id: string;
  status: string;
  stage: string | null;
  round_no: number | null;
  roster_revision: number | null;
  budget_json: string | null;
}

/** 活跃研讨 run：最新非终态（同任务多 run 时阶段/派发/预算都绑它）。 */
export function activeDeliberationRun(db: ZhongshuoDatabase, taskId: string): ActiveDelibRun | undefined {
  return db.prepare(
    "SELECT id, status, stage, round_no, roster_revision, budget_json FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY revision DESC LIMIT 1",
  ).get(taskId) as ActiveDelibRun | undefined;
}

function parseInitialTaskId(dispatchKey: string): string | null {
  // initial=根任务首派；redispatch=同任务追加 turn（跟进/重试，任务须非终态且 stop_generation=0）。
  const m = dispatchKey.match(/^task:(.+):(?:initial|redispatch)$/);
  return m?.[1] ?? null;
}

function isTurnTerminalStatus(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(status);
}
