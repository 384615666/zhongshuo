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
import { claimNextOutbox, completeOutbox, failOutbox } from '../persistence/outbox.ts';
import type { OutboxRow } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { isDispatchGateHeld } from '../persistence/daemonState.ts';
import type { RuntimeAdapter, NormalizedRuntimeEvent } from '../contracts/runtime.ts';
import type { TopLevelRouteOutcome } from '../contracts/routing.ts';
import type { BudgetState } from '../contracts/budget.ts';
import { settleTurns } from '../domain/budget.ts';
import { assembleDirectTurn } from './turnInput.ts';
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
  /** DELIBERATE 总调用上限覆盖（缺省按 E12 核心公式推导）。 */
  deliberateMaxTurns?: number;
  /** 可注入时钟（默认 Date.now）：领取租约/泵判定在判定时点取当前时间，drain 循环不复用旧 now。 */
  clock?: () => number;
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
  private readonly deliberateMaxTurns?: number;
  private readonly clock: () => number;
  private readonly live = new Map<string, { turnId: string; sessionId: string }>();

  constructor(options: DispatchWorkerOptions) {
    this.db = options.db;
    this.adapter = options.adapter;
    this.leaseOwner = options.leaseOwner;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.turnDeadlineMs = options.turnDeadlineMs ?? 60_000;
    this.interruptGraceMs = options.interruptGraceMs ?? 5_000;
    this.maxTurns = options.maxTurns ?? 6;
    this.appDataDir = options.appDataDir ?? join(tmpdir(), 'zhongshuo-appdata');
    this.enableDeliberate = options.enableDeliberate === true;
    this.absenceToleranceMs = options.absenceToleranceMs ?? 20 * 60_000;
    this.deliberateMaxTurns = options.deliberateMaxTurns;
    this.clock = options.clock ?? (() => Date.now());
  }

  private deliberationOptions() {
    return { absenceToleranceMs: this.absenceToleranceMs, runMaxTurns: this.deliberateMaxTurns, blobDir: join(this.appDataDir, 'artifacts') };
  }

  /** 处理一条 outbox 项；返回是否处理了（门禁 held/无项返回 false）。 */
  async runOnce(now?: number): Promise<boolean> {
    if (isDispatchGateHeld(this.db)) return false;
    // 时钟：在判定时点读取（可注入）；drain 循环每轮取新值，不复用进入时的 now。
    const at = now ?? this.clock();
    // DELIBERATE 泵：屏障推进/下一步入队（幂等；不依赖完成事件驱动）。
    if (this.enableDeliberate) this.pumpDeliberations(at);
    const claimed = claimNextOutbox(this.db, {
      leaseOwner: this.leaseOwner,
      leaseUntil: at + this.leaseMs,
      now: at,
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
    await this.adapter.interrupt({ id: liveEntry.sessionId } as never, turnId);
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
    if (!standing.ok) {
      await this.transitionTask(task.id, 'BLOCKED');
      this.audit(task, null, null, 'task.contextAssemblyFailed', {
        reason: 'standing-prompt-render-failed',
        message: standing.error.message,
      });
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    if (scanSensitivePatterns(standing.value.text).length > 0) {
      await this.transitionTask(task.id, 'BLOCKED');
      this.audit(task, null, null, 'task.contextAssemblyFailed', { reason: 'sensitive-standing-prompt', message: '层 A 渲染命中敏感模式（PP-03）' });
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    // 会话：任务/成员/generation 维度（§13.4）。
    const generation = this.db
      .prepare('SELECT count(*) c FROM runtime_sessions WHERE member_id = ? AND conversation_id = ?')
      .get(member.id, task.conversation_id) as { c: number };
    const session = await this.adapter.openSession({
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
    this.db.prepare(
      `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
    ).run(
      session.id, task.project_id, task.conversation_id, task.conversation_thread_id,
      member.id, task.id, generation.c, project.canonical_path,
    );

    // 会话打开竞态复查（修复轮）：停止/终态在 openSession await 期间生效 → 不启动 turn。
    if (this.stoppingOrTerminal(task.id, turnId)) {
      await this.adapter.close(session);
      const cancel = this.db.transaction(() => {
        this.casTurn(turnId, 'CANCELLED');
        this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')`).run(runId);
        this.transitionTask(task.id, 'CANCELLED');
        this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: 'stop-during-session-open' });
      });
      cancel();
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    this.live.set(turnId, { turnId, sessionId: session.id });

    try {
      await this.adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: assembled.value.bundleId,
        text: assembled.value.text,
        policyId: 'policy-analyze',
        taskRevision: 0,
        resultKey: assembled.value.resultKey,
      });
      await this.consumeUntilTerminal(task, runId, turnId, session.id);
    } finally {
      this.live.delete(turnId);
    }
    await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
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
    if (!standing.ok || scanSensitivePatterns(standing.value.text).length > 0) {
      await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      this.audit(task, run.id, null, 'task.contextAssemblyFailed', { reason: 'standing-prompt-invalid' });
      return;
    }
    const generation = this.db
      .prepare('SELECT count(*) c FROM runtime_sessions WHERE member_id = ? AND conversation_id = ?')
      .get(step.memberId, task.conversation_id) as { c: number };
    const session = await this.adapter.openSession({
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
    this.db.prepare(
      `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
    ).run(session.id, task.project_id, task.conversation_id, task.conversation_thread_id, step.memberId, task.id, generation.c, project.canonical_path);

    if (this.stoppingOrTerminal(task.id, turnId)) {
      await this.adapter.close(session);
      const cancel = this.db.transaction(() => {
        this.casTurn(turnId, 'CANCELLED');
        this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')`).run(run.id);
        this.transitionTask(task.id, 'CANCELLED');
        this.audit(task, run.id, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: 'stop-during-session-open' });
      });
      cancel();
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    this.live.set(turnId, { turnId, sessionId: session.id });
    try {
      await this.adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: bundleId,
        text: assembly.value.text,
        policyId: 'policy-analyze',
        taskRevision: 0,
        resultKey: `result_${turnId}`,
      });
      await this.consumeUntilTerminal(task, run.id, turnId, session.id);
    } finally {
      this.live.delete(turnId);
    }
    await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
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
  private async consumeUntilTerminal(task: TaskRow, runId: string, turnId: string, sessionId: string): Promise<void> {
    const deadline = Date.now() + this.turnDeadlineMs;
    const interruptDeadline = deadline + this.interruptGraceMs;
    const iterator = this.adapter.events({ id: sessionId } as never)[Symbol.asyncIterator]();
    let interruptSent = false;
    let pending: Promise<IteratorResult<NormalizedRuntimeEvent, undefined>> | null = null;

    for (;;) {
      const now = Date.now();
      const wakeAt = interruptSent ? interruptDeadline : deadline;
      const waitMs = Math.max(1, wakeAt - now);
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
            this.adapter.interrupt({ id: sessionId } as never, turnId),
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

    const current = this.db
      .prepare('SELECT status FROM agent_turns WHERE id = ?')
      .get(turnId) as { status: string } | undefined;
    if (current != null && !isTurnTerminalStatus(current.status)) {
      const stageKey = (this.db.prepare('SELECT stage_key FROM agent_turns WHERE id = ?').get(turnId) as { stage_key: string }).stage_key;
      const tx = this.db.transaction(() => {
        this.db.prepare(`UPDATE agent_turns SET status = 'UNKNOWN' WHERE id = ?`).run(turnId);
        if (stageKey.startsWith('delib.')) {
          // 研讨轮结果不确定（§10.2 不伪造）：成员级缺席（E4），运行继续——
          // 不因单成员 UNKNOWN 杀死整个研讨；全员无产出由泵走 BLOCKED。
          const memberRow = this.db.prepare('SELECT member_id FROM agent_turns WHERE id = ?').get(turnId) as { member_id: string };
          this.db.prepare("UPDATE run_participants SET status = 'absent' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, memberRow.member_id);
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'UNKNOWN', reason: 'no-terminal-after-deadline', memberAbsenced: memberRow.member_id });
        } else {
          this.db.prepare(`UPDATE workflow_runs SET status = 'INTERRUPTED' WHERE id = ?`).run(runId);
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'UNKNOWN', reason: 'no-terminal-after-deadline' });
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
      this.applyDeliberationTerminal(task, runId, turnId, turnMeta.dispatch_key ?? '', event);
      return;
    }
    switch (event.kind) {
      case 'turn.started': {
        const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
        if (turn.status === 'STOPPING') {
          // 停止先于开始回执生效：不回到 RUNNING，再发中断并留审计。
          this.audit(task, runId, turnId, 'turn.stoppingRace', { note: 'turn.started after stop; re-interrupting' });
          void this.adapter.interrupt({ id: event.sessionId } as never, turnId);
          break;
        }
        this.casTurn(turnId, 'RUNNING');
        break;
      }
      case 'message.completed':
        this.insertThreadReply(task, turnId, event.messageId, event.text);
        break;
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
        const tx = this.db.transaction(() => {
          const interrupted = event.code === 'INTERRUPTED';
          this.casTurn(turnId, interrupted ? 'CANCELLED' : 'FAILED');
          this.db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(interrupted ? 'CANCELLED' : 'FAILED', runId);
          this.settleBudget(runId);
          this.transitionTask(task.id, interrupted ? 'CANCELLED' : 'ACTIVE');
          this.audit(task, runId, turnId, 'turn.statusChanged', {
            status: interrupted ? 'CANCELLED' : 'FAILED',
            code: event.code,
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
