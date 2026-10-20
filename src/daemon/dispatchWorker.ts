import { effectiveTaskWriteAccess } from './projectWriteAccess.ts';
import { acceptCoordinationPlan, assertCoordinationDispatch, beginCoordination, childCoordination, coordinationDispatchContext, explicitRecipientChild, pumpCoordinations, settleIntegrationLaunchFailure } from './coordination.ts';
import { validatePlanForRun,coordinationDeliveryRefs,coordinationRoster,coordinationCallsUsed,coordinationCallLimit } from './coordination.ts';
import { conversationFacts,conversationBlock,conversationReplyForDispatch,setConversationReplyState,settleConversationReplyForTurn } from './conversationReplies.ts';
import {visibleRuntimeProgress} from '../contracts/runtimeProgress.ts';
import {threadReplyForDispatch,threadReplyBlock,settleThreadReplyForTurn,bindThreadReplyRun,setThreadReplyState,settleThreadReplyForRun} from './threadReplies.ts';
import {communicationForTurn,validateMemberHandoffs,acceptMemberHandoffs,bindMemberMessageTurn,markMemberMessageStarted,settleMemberMessageTurn} from './coordinationMessages.ts';
import {persistDetailMarkdown} from './detailMarkdownAttachments.ts';
import type { DocumentArtifact } from '../contracts/document.ts';
import { captureBaseline, finalizeChangeset } from './changeset.ts';
import { snapshotGeneratedFiles, type SnapshotOutcome } from './generatedFileSnapshots.ts';
import { acquireLease } from './workspaceLocks.ts';
import { comparisonKey } from './directoryIdentity.ts';
/**
 * outbox 派发 worker（§11.2/§11.3）：CAS 领取 → 建 run/turn/session → 经适配器执行 →
 * 规范化事件落库（消息入正确线程）→ 预算结算 → completeOutbox。
 *
 * 防线（修复轮 2026-09-27 收口）：
 * - 派发门禁：恢复后 dispatch_gate=held，worker 不领取，等用户确认继续（§16.4-6/决策 44/E7）。
 * - 崩溃重领对账：dispatch_key 已有 turn（DISPATCHING 不确定窗口）→ 不再执行，标 failed 留审计（RT-03 语义）。
 * - 路由门：DIRECT、AUTO 正式执行；显式关闭的研讨或未知路由保留受阻事实。
 * - 会话打开竞态：openSession 返回后复查停止代次/终态，停止已生效则不 startTurn。
 * - 独立截止计时：沉默 runtime 也会按时中断；中断后宽限内仍无终结 → UNKNOWN（结果不确定，不伪造）。
 * - 验收策略收尾：user_review → REVIEW + pending 交付；auto_deliver → DONE + not_required（§10.5）。
 * - 迟到完成不复活停止：turn 已 STOPPING 时完成事件走取消收尾并留 lateCompletion 审计（RT-06 形态）。
 */
import { memberImageCapability } from './imageCapability.ts';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { claimNextOutbox, completeOutbox, failOutbox, releaseOutbox } from '../persistence/outbox.ts';
import type { OutboxRow } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { holdDmPauseGate, pumpDmQueue } from '../persistence/stores/dm.ts';
import { isDispatchGateHeld } from '../persistence/daemonState.ts';
import { AdapterCallError } from '../contracts/runtime.ts';
import type { RuntimeAdapter, NormalizedRuntimeEvent, SessionRef } from '../contracts/runtime.ts';
import type { TopLevelRouteOutcome } from '../contracts/routing.ts';
import type { BudgetState } from '../contracts/budget.ts';
import { settleTurns } from '../domain/budget.ts';
import { assembleDirectTurn } from './turnInput.ts';
import { readMemberRuntimeBinding, resolveMemberRuntime } from './memberRuntime.ts';
import { DispatchAdmission } from './admission.ts';
import {agentReplyText,chatAnswer,extractAppendedTaskComplete,isExplicitTaskCompleteOutput} from '../contracts/chatAnswer.ts';
import { renderStandingPrompt, scanSensitivePatterns, taskCompleteSchema, taskCompleteOutputSchema } from '../contracts/prompts.ts';
import {
  assembleStepInput,
  onStepOutput,
  parseDelibStep,
  parseRepairTarget,
  prepareDeliberation,
  deliberationOutputSchema,
  pumpDeliberation,
  settleStoppedDeliberation,
  repairDispatchKey,
  type DelibStep,
} from './deliberationRunner.ts';
import { budgetAccounting, dispatchBudgetStage, occupyFrontForDispatch, occupyTailForDispatch, settleTurn,refundReservedTurn } from '../contracts/deliberation.ts';
import type { DeliberationBudgetState } from '../contracts/deliberation.ts';
import { acquireReminderTurnSlot, releaseUnlinkedReminderReservations, releaseUnlinkedReminderReservationsForDispatch, settleReminderCallForTurn } from './reminderDispatch.ts';
import { checkProcessLiveness, collectTreeRows, snapshotProcessTable } from './processCheck.ts';
import { closeTurnProcessRegistration, getTurnProcessRegistration, registerTurnProcess, recordProcessTreeObservation } from './processRegistry.ts';
import { managedJobById } from './managed/bridge.ts';
import { retireManagedJob } from './managedRetirement.ts';
import { settleRealCall, recordRealCallUsage } from './realCallLedger.ts';

export interface TaskRow {
  revision:number;
  id: string;
  project_id: string;
  conversation_id: string;
  /** room_task/dm_turn（DEV-22）；dm_turn 的 room_id/thread 各字段运行时为 NULL。 */
  kind: string;
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
  /** DM 输入水位（第十九轮四）：本轮用户消息的 conversation_seq——组装边界。 */
  input_through_seq: number | null;
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
  /** New AUTO parent envelope cap, including planning, every child and integration/repair. */
  coordinationMaxCalls?:number;
  /** 应用数据目录（层 A draftDir 变量与未来快照存储）；DEV-07 接真实 appData。 */
  appDataDir?: string;
  /** DELIBERATE 宿主开关：worker 独立构造默认关闭，正式 daemon 在 R86 接通后默认开放。 */
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
  private readonly coordinationMaxCalls:number;
  private readonly appDataDir: string;
  private readonly enableDeliberate: boolean;
  private readonly absenceToleranceMs: number;
  private readonly dispatchWaitDeadlineMs?: number;
  private readonly deliberateMaxTurns?: number;
  private readonly clock: () => number;
  private readonly adapterForMember?: (memberId: string) => RuntimeAdapter;
  private readonly live = new Map<string, { turnId: string; sessionId: string; adapter: RuntimeAdapter }>();
  /** Adapters such as Codex may deliver the structured contract in message.completed
   * while turn.completed carries only the visible natural text. Cache only validated,
   * turn-bound control objects for that terminal reconciliation. */
  private readonly controlFromMessages = new Map<string, string>();
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
  /** 任务忙碌而合法推迟的意图（第二十八轮二）：本轮 drain 跳过重领（防队首热转）——drain 开轮清空重试。 */
  private readonly busyDeferrals = new Map<number, string>();

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
    const coordinationCap=options.coordinationMaxCalls??24;
    if(!Number.isSafeInteger(coordinationCap)||coordinationCap<0)throw Error('协作调用预算必须是非负整数');
    this.coordinationMaxCalls=Math.min(24,coordinationCap);
    this.appDataDir = options.appDataDir ?? join(tmpdir(), 'zhongshuo-appdata');
    this.enableDeliberate = options.enableDeliberate === true;
    this.absenceToleranceMs = options.absenceToleranceMs ?? 20 * 60_000;
    this.dispatchWaitDeadlineMs = options.dispatchWaitDeadlineMs;
    this.deliberateMaxTurns = options.deliberateMaxTurns;
    this.clock = options.clock ?? (() => Date.now());
    this.restoreAdmissionFromDb();
  }

  /**
   * 按持久事实恢复准入占位（r57，review-r56 §2 独立反例）：新 worker 的 admission 内存
   * 为空，但「UNKNOWN（结局不确定）/ protection_state='retained'（保护未解除）/ 非终态在途」
   * 的 turn 占用是**持久合同**——否则 dispatch.resume{confirm:true} 后同成员另一任务会被
   * 新实例派发（确认继续≠退出证明；旧任务 redispatch 被拒不覆盖此路径）。
   *
   * 恢复的占用带真实 turnId：后续 recovery.reconcile/releaseProtection 的 releaseAdmission
   * 联动照常收口（两个释放路径都有 retained/UNKNOWN 门控——notStarted→FAILED+refunded
   * 但 retained 期间继续占用，正式解除后释放）。
   * 只读档无 writeRoot 占位；已完成 turn 不占（其 dispatch 已收口）。
   * 恢复读取失败=占用无法核实：**抛错拒绝启动**（r58，review-r57 §2）——不按空账本放行。
   */
  private restoreAdmissionFromDb(): void {
    // r58（review-r57 §2 独立反例）：占位查询失败**不得按空账本启动**——UNKNOWN/retained
    // 的占用是持久合同，未知占用≠零占用；吞错会让 dispatch.resume 后同成员新任务直接派发
    //（租约/门禁都不代守无租约 retained）。无法核实即沿启动错误路径抛错拒绝启动，由
    // daemon 重启显式重试；行级恢复（providerKeyOf 的成员绑定读）失败同网（部分恢复失败
    // 同样拒绝——漏一行就是漏一个占用）。预算/保护/审计事实在库中，重读不改写。
    try {
      const rows = this.db.prepare(
        `SELECT t.id AS turnId, t.member_id AS memberId, tk.project_id AS projectId,
          (SELECT lock_domain FROM workspace_leases w WHERE w.owner_turn_id=t.id AND w.status!='released' LIMIT 1) AS writeRootKey
         FROM agent_turns t
         JOIN workflow_runs r ON r.id = t.run_id
         JOIN tasks tk ON tk.id = r.task_id
         WHERE t.status = 'UNKNOWN'
            OR t.protection_state = 'retained'
            OR t.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')`,
      ).all() as Array<{ turnId: string; memberId: string; projectId: string;writeRootKey:string|null }>;
      for (const row of rows) {
        this.admission.restore(row.turnId, {
          memberId: row.memberId,
          projectId: row.projectId,
          providerKey: this.providerKeyOf(row.memberId),
          writeRootKey: row.writeRootKey,
        });
      }
    } catch (err) {
      throw new Error(`准入占位恢复失败——拒绝按未核实账本启动派发（重启 daemon 重试）：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /** 项目级协作限制（§17.8，第十七轮三）：项目列优先，NULL/查询失败回落全局默认。 */
  private collabFor(projectId: string): { absenceToleranceMs: number; turnDeadlineMs: number } {
    try {
      const row = this.db.prepare('SELECT collab_absence_tolerance_ms, collab_turn_deadline_ms FROM projects WHERE id = ?').get(projectId) as { collab_absence_tolerance_ms: number | null; collab_turn_deadline_ms: number | null } | undefined;
      return {
        absenceToleranceMs: row?.collab_absence_tolerance_ms ?? this.absenceToleranceMs,
        turnDeadlineMs: row?.collab_turn_deadline_ms ?? this.turnDeadlineMs,
      };
    } catch {
      return { absenceToleranceMs: this.absenceToleranceMs, turnDeadlineMs: this.turnDeadlineMs };
    }
  }

  /**
   * 派发时限快照（第十八轮四）：解析后的最终值（项目值或全局默认——NULL 回落也记最终解析值）
   * + 配置版本（projects.revision）。与 turn 同事务写入：在途判定（单轮截止/缺席/暂停扣除）
   * 全用快照；泵不再每次读最新项目配置——「新派发 turn 起生效（在途不变）」由数据承载，
   * 重启沿持久快照恢复，不重新套当前配置。
   */
  private collabSnapshotFor(projectId: string): { absenceToleranceMs: number; turnDeadlineMs: number; configRevision: number } {
    try {
      const row = this.db.prepare('SELECT collab_absence_tolerance_ms, collab_turn_deadline_ms, revision FROM projects WHERE id = ?').get(projectId) as { collab_absence_tolerance_ms: number | null; collab_turn_deadline_ms: number | null; revision: number } | undefined;
      return {
        absenceToleranceMs: row?.collab_absence_tolerance_ms ?? this.absenceToleranceMs,
        turnDeadlineMs: row?.collab_turn_deadline_ms ?? this.turnDeadlineMs,
        configRevision: row?.revision ?? 0,
      };
    } catch {
      return { absenceToleranceMs: this.absenceToleranceMs, turnDeadlineMs: this.turnDeadlineMs, configRevision: 0 };
    }
  }

  /** 在途 turn 的时限快照读取（消费/缺席判定用；快照前历史行回落现行配置）。 */
  collabSnapshotOfTurn(turnId: string): { absenceToleranceMs: number; turnDeadlineMs: number; snapshotted: boolean } {
    try {
      const row = this.db.prepare('SELECT collab_absence_ms, collab_turn_deadline_ms FROM agent_turns WHERE id = ?').get(turnId) as { collab_absence_ms: number | null; collab_turn_deadline_ms: number | null } | undefined;
      if (row != null && row.collab_absence_ms != null && row.collab_turn_deadline_ms != null) {
        return { absenceToleranceMs: row.collab_absence_ms, turnDeadlineMs: row.collab_turn_deadline_ms, snapshotted: true };
      }
    } catch { /* 回落 */ }
    return { absenceToleranceMs: this.absenceToleranceMs, turnDeadlineMs: this.turnDeadlineMs, snapshotted: false };
  }

  private deliberationOptions(projectId?: string) {
    return { absenceToleranceMs: projectId != null ? this.collabFor(projectId).absenceToleranceMs : this.absenceToleranceMs, dispatchWaitDeadlineMs: this.dispatchWaitDeadlineMs, runMaxTurns: this.deliberateMaxTurns, blobDir: join(this.appDataDir, 'artifacts') };
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
    pumpCoordinations(this.db);
    const claimed = claimNextOutbox(this.db, {
      leaseOwner: this.leaseOwner,
      leaseUntil: at + this.leaseMs,
      now: at,
      skipIds: [...this.blockedOutbox.keys(), ...this.busyDeferrals.keys()],
    });
    if (claimed == null) return false;
    await this.dispatchClaimed(claimed);
    return true;
  }

  private pumpDeliberations(now: number): void {
    const cursor=Number(this.kvGet('deliberation:pump-cursor')??0);
    let runs=this.db.prepare("SELECT rowid cursor_id,id,task_id,status FROM workflow_runs WHERE mode='DELIBERATE' AND status IN ('RUNNING','WAITING','STOPPING') AND rowid>? ORDER BY rowid LIMIT 100").all(cursor) as Array<{cursor_id:number;id:string;task_id:string;status:string}>;
    if(!runs.length)runs=this.db.prepare("SELECT rowid cursor_id,id,task_id,status FROM workflow_runs WHERE mode='DELIBERATE' AND status IN ('RUNNING','WAITING','STOPPING') ORDER BY rowid LIMIT 100").all() as typeof runs;
    if(runs.length)this.kvSet('deliberation:pump-cursor',String(runs.at(-1)!.cursor_id));
    for (const r of runs) {
      if(r.status==='STOPPING'){settleStoppedDeliberation(this.db,r.task_id,r.id);continue;}
      const projOf = (this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(r.task_id) as { project_id: string } | undefined)?.project_id;
      pumpDeliberation(this.db, r.task_id, this.deliberationOptions(projOf), now);
    }
  }

  /** 排空当前可领取的 outbox（门禁 held 时为 0）。 */
  async drain(): Promise<number> {
    this.busyDeferrals.clear(); // 新一轮 drain 重试上轮忙碌项（前一轮 run 可能已终态）
    let processed = 0;
    while (await this.runOnce()) processed += 1;
    this.busyDeferrals.clear();
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
      const ordinary=conversationReplyForDispatch(this.db,claimed.dispatch_key)??threadReplyForDispatch(this.db,claimed.dispatch_key);if(ordinary)setConversationReplyState(this.db,ordinary.messageId,'unknown','该原请求已有执行身份，结果待核实；不会自动重发');
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
    const generalRequest=threadReplyForDispatch(this.db,claimed.dispatch_key);
    const conversationRequest=conversationReplyForDispatch(this.db,claimed.dispatch_key)??generalRequest;
    // Per-message execution view only. Do not mutate the task's original owner,
    // route, write scope, anchor or any already queued envelope in the database.
    if(task&&generalRequest){task.owner_member_id=generalRequest.memberId;task.route_json=generalRequest.routeJson;}
    const coordination=task?coordinationDispatchContext(this.db,task.id,claimed.dispatch_key):null;
    if(task&&coordination?.request){task.owner_member_id=coordination.request.memberId;}
    // 意图代次判定（§11.4；第二十七轮五修历史代次误拦后第二十八轮二收口——不能以
    // 「stop_generation>0 + 存在任意在途 run/turn」推断停止仍生效：历史停止已结算、合法新
    // run 正在执行时，新到的合法提醒/跟进意图会被误杀静默丢弃）。判定按**派发意图自己的
    // 入队代次**（迁移 034 outbox.stop_generation_at_enqueue）：
    // - 入队后无新停止（task.stop_generation == 入队代次）=合法——忙碌（活跃 run/turn）时
    //   沿既有串行等待（释放租约回 pending，周期 drain 重试），不丢弃；
    // - 入队后被新停止超越（> 入队代次）=旧意图拒绝（completeOutbox 收口——不复活）；
    // - 旧行无快照（-1，迁移前遗留）回落第二十七轮保守判定（在途即视为被超越）。
    const intentGen0 = claimed.stop_generation_at_enqueue ?? -1;
    const taskBusy = task != null && ((
      this.db.prepare(`SELECT count(*) c FROM workflow_runs WHERE task_id = ? AND status IN ('QUEUED','RUNNING','WAITING','STOPPING')`).get(taskId) as { c: number }).c > 0
      || (this.db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? AND t.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','UNKNOWN')`).get(taskId) as { c: number }).c > 0
    );
    const superseded = task != null && task.stop_generation > 0 && (intentGen0 >= 0 ? task.stop_generation > intentGen0 : taskBusy);
    if (task == null || superseded || task.status === 'CANCELLED' || task.status === 'DONE'&&!conversationRequest) {
      if(conversationRequest)setConversationReplyState(this.db,conversationRequest.messageId,'cancelled','请求已被停止或目标不再可执行');
      // 被取消派发的调用预占**精确绑定释放**（第二十八轮二）：只放归属本派发键的提醒预占
      //——同任务其他合法提醒（排队等待中）的预占不动，不按 task 一次释放。
      releaseUnlinkedReminderReservationsForDispatch(this.db, claimed.dispatch_key);
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    if (taskBusy && (coordination?.kind!=='integration'||this.db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING') LIMIT 1`).get(task.id))) {
      // 合法意图 + 任务忙碌（活跃 run/turn 含停止中）：沿既有串行等待——释放租约回 pending，
      // 周期 drain/事件重试（意图入队代次未变，重试判定不变）；本轮不执行也不收口。
      releaseOutbox(this.db, claimed.id, claimed.attempt_epoch);
      this.busyDeferrals.set(claimed.id, task.id); // 本轮 drain 跳过该 id（防队首热转）
      return;
    }
    try { assertCoordinationDispatch(this.db,task.id,claimed.dispatch_key); }
    catch(error) {
      const reason=String(error).slice(0,1000);
      if(coordination?.kind==='integration'&&coordination.run)settleIntegrationLaunchFailure(this.db,coordination.run.run_id,reason);
      else this.transitionTask(task.id,'BLOCKED');
      this.audit(task,null,null,'coordination.dispatchBlocked',{message:reason});await failOutbox(this.db,claimed.id,claimed.attempt_epoch);return;
    }
    if(coordination?.kind==='planning'&&this.coordinationMaxCalls===0){this.transitionTask(task.id,'BLOCKED');this.audit(task,null,null,'coordination.dispatchBlocked',{message:'本轮协作预算为0；未启动模型'});await failOutbox(this.db,claimed.id,claimed.attempt_epoch);return;}
    let conversationInput:{text:string;seq:number}|undefined;
    if(coordination?.request&&!generalRequest){
      const source=threadReplyForDispatch(this.db,`task:${task.id}:thread-reply:${coordination.request.messageId}`);
      const blocked=source?threadReplyBlock(this.db,source,this.defaultKindOf()):{code:'THREAD_SCOPE_MISMATCH',message:'协作原请求身份缺失'};
      if(blocked){if(source)setConversationReplyState(this.db,source.messageId,'blocked',blocked.message);this.transitionTask(task.id,'BLOCKED');this.audit(task,null,null,'coordination.dispatchBlocked',blocked);await failOutbox(this.db,claimed.id,claimed.attempt_epoch);return;}
      conversationInput={text:coordination.request.text,seq:coordination.request.seq};
    }
    if(conversationRequest){
      const current=conversationFacts(this.db,conversationRequest.threadId);
      const message=this.db.prepare('SELECT task_id,thread_id,project_id,conversation_id,author_id,body_json,thread_message_seq FROM messages WHERE id=?').get(conversationRequest.messageId) as {task_id:string;thread_id:string;project_id:string;conversation_id:string;author_id:string;body_json:string;thread_message_seq:number}|undefined;
      const mismatch=!current||!message||current.taskId!==task.id||current.memberId!==conversationRequest.memberId||message.task_id!==task.id||message.thread_id!==conversationRequest.threadId||message.project_id!==task.project_id||message.conversation_id!==task.conversation_id||message.thread_message_seq!==conversationRequest.inputSeq;
      const generalMismatch=generalRequest&&(!message||message.task_id!==task.id||message.thread_id!==generalRequest.threadId||message.project_id!==task.project_id||message.conversation_id!==task.conversation_id||message.thread_message_seq!==generalRequest.inputSeq);
      const blocked=generalRequest?(generalMismatch?{code:'THREAD_SCOPE_MISMATCH',message:'消息或对话目标已变化；未派发'}:threadReplyBlock(this.db,generalRequest,this.defaultKindOf(),message!.author_id)):
        mismatch?{code:'CONVERSATION_SCOPE_CHANGED',message:'对话已产生工作成果或目标身份变化；不会自动返工'}:conversationBlock(this.db,current!,this.defaultKindOf(),message!.author_id,conversationRequest.writeScopeJson);
      if(blocked){setConversationReplyState(this.db,conversationRequest.messageId,'blocked',blocked.message);this.audit(task,null,null,'conversation.replyBlocked',{messageId:conversationRequest.messageId,...blocked});if(current&&!generalRequest)this.transitionTask(task.id,'BLOCKED');failOutbox(this.db,claimed.id,claimed.attempt_epoch);return;}
      conversationInput={text:(JSON.parse(message!.body_json) as {text:string}).text,seq:conversationRequest.inputSeq};
    }
    // DM 归档门（第十九轮六）：归档即禁止新派发——领取/会话建立/startTurn 各窗口统一拦下
    //（任务保持 ACTIVE=队列暂停语义，续跑由 restore 后 dm.resume 显式控制）。
    if (task.kind === 'dm_turn') {
      const convArchived = this.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(task.conversation_id) as { archived_at: number | null } | undefined;
      if (convArchived?.archived_at != null) {
        await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
        this.audit(task, null, null, 'dm.archivedDispatchHeld', { conversationId: task.conversation_id, note: '会话已归档：不派发（队列暂停——restore+dm.resume 后方可继续）' });
        return;
      }
    }

    const route = task.route_json != null ? (JSON.parse(task.route_json) as TopLevelRouteOutcome) : null;
    // DELIBERATE：编排开关开启时走 PREPARE（程序完成）；关闭时维持模式门禁 BLOCKED。
    if (route != null && route.kind === 'dispatch' && route.mode === 'DELIBERATE' && this.enableDeliberate) {
      if(generalRequest&&task.status==='DONE'){
        this.transitionTask(task.id,'ACTIVE');
        task.status='ACTIVE';
      }
      let requestBudget:number|undefined;
      if(generalRequest?.deliberationBudgetJson!=null){
        try{
          const parsed=JSON.parse(generalRequest.deliberationBudgetJson) as {maxTurns?:unknown};
          if(typeof parsed.maxTurns==='number'&&Number.isSafeInteger(parsed.maxTurns)&&parsed.maxTurns>0)requestBudget=parsed.maxTurns;
        }catch{/* invalid snapshot is rejected below */}
      }
      if(generalRequest?.deliberationBudgetJson!=null&&requestBudget==null){
        setThreadReplyState(this.db,generalRequest.messageId,'failed','本次研讨预算快照损坏；未启动模型，原请求不会自动重放');
        this.transitionTask(task.id,'BLOCKED');
        this.audit(task,null,null,'task.deliberationPrepareFailed',{message:'invalid-thread-deliberation-budget',messageId:generalRequest.messageId});
        await completeOutbox(this.db,claimed.id,claimed.attempt_epoch);
        return;
      }
      const baseOptions=this.deliberationOptions(task.project_id);
      const prepared = prepareDeliberation(
        this.db,
        { id: task.id, conversationId: task.conversation_id, threadId: task.conversation_thread_id ?? null },
        route,
        {
          ...baseOptions,
          ...(requestBudget!=null?{runMaxTurns:requestBudget}:{}),
          ...(generalRequest?{dispatchIdentity:generalRequest.dispatchIdentity}:{}),
        },
      );
      if (!prepared.ok) {
        if(generalRequest)setThreadReplyState(this.db,generalRequest.messageId,'failed',prepared.error.message);
        await this.transitionTask(task.id, 'BLOCKED');
        this.audit(task, null, null, 'task.deliberationPrepareFailed', { message: prepared.error.message });
      } else {
        if(generalRequest)bindThreadReplyRun(this.db,generalRequest.messageId,prepared.value.runId);
        this.audit(task, prepared.value.runId, null, 'run.prepared', {
          mode: 'DELIBERATE',
          ...(generalRequest?{dispatchIdentity:generalRequest.dispatchIdentity,budgetMaxTurns:requestBudget}:{}),
        });
      }
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    // 未知路由或宿主显式关闭的研讨不可执行；不冒充单成员执行。
    if (route == null || route.kind !== 'dispatch' || !['DIRECT','AUTO'].includes(route.mode)) {
      if(generalRequest)setThreadReplyState(this.db,generalRequest.messageId,'failed',route?.kind==='dispatch'&&route.mode==='DELIBERATE'?'独立研讨当前未启用；原请求未启动，不会自动重放':'当前路由不可执行；原请求未启动');
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
      // 停用/缺失成员的已排队 DIRECT（第十七轮二）：阻塞留证（含修复/返工/重派同路径）——
      // 重新启用后经 task.redispatch 正式续跑，不自动重放。提醒调用预占归还（未花）。
      if (member != null && member.enabled !== 1) {
        this.audit(task as TaskRow, null, null, 'task.memberDisabledBlocked', { memberId: member.id, note: '成员停用：已排队任务阻塞（不派发）；重新启用后经追加执行续跑' });
      }
      releaseUnlinkedReminderReservations(this.db, task.id);
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

    // 提醒调用格（第二十五轮一+第二十六轮一）：任务源于提醒→在**实际 startTurn 边界**统一
    // 检查+持久入账（初始/确认/跟进/修复/追加/重派全走此处——不能通过新 run 绕开）。
    // **原子收敛**：acquireReminderTurnSlot 在 createRun 事务内首句执行（挂钩与 run/turn
    // 创建同事务——组装失败/创建前崩溃/重领不留下指向不存在 turn 的 inflight，亦不释放
    // 可能已发出的调用）；hold=ReminderSlotHeldError 回滚后在 catch 内走 hold 路径。

    // 格式修复工作项（第六轮·下：结构化判定——不靠 dispatch_key 字符串后缀）。
    // pending：本派发即修复轮——先做一致性复核（损坏→阻塞留证不花调用），上下文与预算
    // 沿用从工作项读取；consumed（他 turn 已消费）：existingTurn 对账路径兜底。
    const repairItem = this.db
      .prepare(`SELECT * FROM format_repair_workitems WHERE target_dispatch_key = ? AND status IN ('pending','consumed') ORDER BY created_at DESC LIMIT 1`)
      .get(claimed.dispatch_key) as {
        id: string; source_turn_id: string; source_result_key: string; invalid_event_id: string;
        source_output_hash: string; source_output_text: string; invalid_issues_json: string;
        status: string; consumed_turn_id: string | null; budget_run_id: string;
      } | undefined;
    if (repairItem != null && repairItem.status === 'consumed' && repairItem.consumed_turn_id != null) {
      // 已被其他 turn 消费（崩溃后重领等）：交由下方 existingTurn 对账纪律——不重复消费。
    } else if (repairItem != null && repairItem.status === 'pending') {
      const invalidStill = this.db
        .prepare(`SELECT count(*) c FROM domain_events WHERE event_id = ? AND kind = 'turn.outputInvalid' AND turn_id = ?`)
        .get(repairItem.invalid_event_id, repairItem.source_turn_id) as { c: number };
      const textHash = createHash('sha256').update(repairItem.source_output_text, 'utf8').digest('hex');
      // 授权链校验（第七轮：budget_run_id 真正参与校验——它标识修复预算沿用的授权快照，
      // 对应 run 必须存在且属于本任务；断裂=按损坏阻塞留证，不花调用）。
      const budgetRun = this.db
        .prepare(`SELECT task_id FROM workflow_runs WHERE id = ?`)
        .get(repairItem.budget_run_id) as { task_id: string } | undefined;
      if (invalidStill.c !== 1 || textHash !== repairItem.source_output_hash || budgetRun?.task_id !== task.id) {
        // 损坏/不一致：明确阻塞并留证——不忽略后继续花模型调用（不降级为普通重跑）。
        const tx = this.db.transaction(() => {
          this.db.prepare(`UPDATE format_repair_workitems SET status = 'blocked', note = ?, updated_at = ? WHERE id = ?`)
            .run(
              `一致性复核失败（invalidEvent=${invalidStill.c === 1 ? '在' : '缺失'}，hashMatch=${textHash === repairItem.source_output_hash}，budgetRunMatch=${budgetRun?.task_id === task.id}）`,
              Date.now(), repairItem.id,
            );
          this.transitionTask(task.id, 'BLOCKED');
          this.audit(task, null, null, 'task.repairContextCorrupt', { workitemId: repairItem.id, sourceTurnId: repairItem.source_turn_id, reason: '修复上下文与源记录不一致或授权链断裂——阻塞留证' });
        });
        tx();
        failOutbox(this.db, claimed.id, claimed.attempt_epoch);
        return;
      }
    }
    const isRepairDispatch = repairItem != null && repairItem.status === 'pending';
    // 修复轮预算沿用原授权（第七轮：统一授权账目——以**逐 turn 处置事实**为单一真源，
    // 不累加各 run 的 usedTurns 快照[快照含播种历史值，SUM 会重复计]；不含其他任务）：
    // 计入=本任务 DIRECT run 中一切非退款 turn——正常终态（settleBudget 已结算、无 mark）、
    // 对账 settled（含 UNKNOWN 保留）、UNKNOWN 未收口（对账未定=额度仍被占用）；
    // 唯一豁免=budget_mark='refunded'（确认未启动退款，额度归还）。在途=本 run 预占 1。
    const settledCount = isRepairDispatch
      ? (this.db.prepare(
        `SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id
         WHERE r.task_id = ? AND r.mode = 'DIRECT' AND (t.budget_mark IS NULL OR t.budget_mark != 'refunded')`,
      ).get(task.id) as { c: number }).c
      : 0;
    if (isRepairDispatch && settledCount + 1 > this.maxTurns) {
      // 授权额度已耗尽：修复资格被预算吞噬——如实收口（不绕过上限花调用）。
      const tx = this.db.transaction(() => {
        this.db.prepare(`UPDATE format_repair_workitems SET status = 'closed', note = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
          .run(`修复预算耗尽（已用 ${settledCount}+1 > 上限 ${this.maxTurns}）——修复资格按统一授权账目收口`, Date.now(), repairItem!.id);
        this.transitionTask(task.id, 'BLOCKED');
        this.audit(task, null, null, 'task.repairBudgetExhausted', { workitemId: repairItem!.id, settledCount, maxTurns: this.maxTurns });
      });
      tx();
      failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const priorUsed = settledCount;
    const budget: BudgetState = {
      grantId: runId,
      maxTurns: coordination?.run?coordinationCallLimit(this.db,coordination.run.run_id):coordination?.kind==='planning'?this.coordinationMaxCalls:this.maxTurns,
      usedTurns: coordination?.run?coordinationCallsUsed(this.db,coordination.run.run_id):priorUsed,
      inFlightReservedTurns: 1,
    };

    // 输入组装（DEV-21-M0）：必要材料缺失/敏感命中 → 组装失败，不建 run、不派发。
    // 修复上下文来自持久工作项（组装失败/准入延期/崩溃重领不丢失——工作项保持 pending
    // 直至 run/turn 创建同事务置 consumed）。
    const repairContext = isRepairDispatch && repairItem != null
      ? {
          originalTurnId: repairItem.source_turn_id,
          sourceResultKey: repairItem.source_result_key,
          issues: JSON.parse(repairItem.invalid_issues_json) as string[],
          originalText: repairItem.source_output_text,
        }
      : undefined;
    let writeAccess: ReturnType<typeof effectiveTaskWriteAccess>;
    try { writeAccess=effectiveTaskWriteAccess(this.db,task.id,member.id,this.defaultKindOf(),(conversationRequest?.writeScopeJson??coordination?.request?.writeScopeJson)); }
    catch(e) {
      const reason=String(e);
      if(conversationRequest)setConversationReplyState(this.db,conversationRequest.messageId,'blocked',reason);
      if(coordination?.kind==='integration'&&coordination.run)settleIntegrationLaunchFailure(this.db,coordination.run.run_id,reason);
      else this.transitionTask(task.id,'BLOCKED');
      this.audit(task,null,null,'task.contextAssemblyFailed',{reason:'write-authorization-changed',message:reason});
      await completeOutbox(this.db,claimed.id,claimed.attempt_epoch);return;
    }
    let baselineChangeSetId: string | null = null;
    let baselineContentUnavailable: string[] = [];
    if (writeAccess.modificationAuthorized) {
      const baseline = captureBaseline(this.db, {
        projectId: task.project_id,
        taskId: task.id,
        runId,
        appDataDir: this.appDataDir,
      });
      if (!baseline.ok) {
        if (conversationRequest) setConversationReplyState(this.db, conversationRequest.messageId, 'blocked', baseline.error.message);
        if(coordination?.kind==='integration'&&coordination.run)settleIntegrationLaunchFailure(this.db,coordination.run.run_id,baseline.error.message);
        else this.transitionTask(task.id, 'BLOCKED');
        this.audit(task, null, null, 'task.contextAssemblyFailed', {
          reason: 'write-baseline-failed',
          message: baseline.error.message,
        });
        await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
        return;
      }
      if (baseline.value.truncated) {
        const message = '写入基线不完整：目录扫描失败、路径被拒绝或文件清单超出安全范围，未启动模型';
        if (conversationRequest) setConversationReplyState(this.db, conversationRequest.messageId, 'blocked', message);
        if(coordination?.kind==='integration'&&coordination.run)settleIntegrationLaunchFailure(this.db,coordination.run.run_id,message);
        else this.transitionTask(task.id, 'BLOCKED');
        this.audit(task, null, null, 'task.contextAssemblyFailed', {
          reason: 'write-baseline-incomplete',
          message,
        });
        await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
        return;
      }
      baselineChangeSetId = baseline.value.changeSetId;
      baselineContentUnavailable = baseline.value.contentUnavailable;
    }
    const baselineContentNote = baselineContentUnavailable.length === 0 ? null
      : `项目内有 ${baselineContentUnavailable.length} 个文件超过内容级前像上限，无法内容级撤销；这不降低用户明确选择的执行权限，只有在用户目标或协作角色明确只读时才按只读执行。`;
    const imageBindingAtAssembly = JSON.stringify(resolveMemberRuntime(this.db, member.id, this.defaultKindOf()));
    const imageCapabilityAtAssembly = memberImageCapability(this.db, member.id);
    const executionBasis=generalRequest||coordination?.request?this.db.prepare(`SELECT t.current_delivery_id deliveryId,d.revision,d.manifest_hash manifestHash FROM tasks t LEFT JOIN task_deliveries d ON d.id=t.current_delivery_id WHERE t.id=?`).get(task.id) as {deliveryId:string|null;revision:number|null;manifestHash:string|null}:null;
    const assembled = assembleDirectTurn({
      db: this.db,
      writeAccess,
      allowImages: imageCapabilityAtAssembly.status === 'supported',
      coordinationNote:[coordination?.note,baselineContentNote,executionBasis?`本条为用户新发的消息，按当前问题回应；只有明确要求修改时才修改文件。执行时读取的当前成果：${JSON.stringify(executionBasis)}。历史返工意见是上下文，不是本条的自动执行授权。`:null].filter(Boolean).join('\n')||undefined,
      coordination:coordination?{phase:coordination.kind,runId:coordination.run?.run_id??null,role:coordination.kind==='child'?coordination.run.role:'coordinator'}:undefined,
      communicationContract:communicationForTurn(this.db,task.id,member.id,coordination?.kind,coordination?.run?.run_id,claimed.dispatch_key),
      blobRoot: join(this.appDataDir, 'blobstore'), // 附件读取按本次 appData 实根校验（第二十八轮三）
      repairContext,
      // 返工反馈（第九轮 RT-25）：最近人工验收=changes_requested → 注入被退回版本与说明。
      reviewFeedback: generalRequest||coordination?.request?undefined:this.latestReviewFeedback(task.id),
      task: {
        id: task.id,
        projectId: task.project_id,
        conversationId: task.conversation_id,
        conversationKind: conversationKind ?? 'room',
        roomId: task.room_id,
        threadId: task.conversation_thread_id,
        rootMessageId: task.root_message_id,
        title: task.title,
        objective: conversationInput?.text??task.objective,
        taskRevision: conversationRequest?task.revision:0,
        inputThreadMessageSeq:conversationInput?.seq,
        inputThroughSeq: task.input_through_seq,
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
      if(conversationRequest)setConversationReplyState(this.db,conversationRequest.messageId,'blocked',assembled.error.message);
      if(coordination?.kind==='integration'&&coordination.run)settleIntegrationLaunchFailure(this.db,coordination.run.run_id,assembled.error.message);
      else await this.transitionTask(task.id, 'BLOCKED');
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
      writeRootKey: writeAccess.modificationAuthorized ? comparisonKey(writeAccess.root) : null,
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
      const collabSnap = this.collabSnapshotFor(task.project_id);
      const createRun = this.db.transaction(() => {
        // 调用格首句（原子收敛——第二十六轮一）：与 run/turn 创建同事务；hold=抛错整体回滚。
        acquireReminderTurnSlot(this.db, turnId, claimed.dispatch_key);
        this.db.prepare(
          `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json)
           VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?)`,
        ).run(runId, task.id, task.conversation_id, task.conversation_thread_id, coordination&&coordination.kind!=='child'?'AUTO':'DIRECT', conversationRequest?task.revision:0, JSON.stringify(budget));
        if(coordination?.kind==='planning'||coordination?.kind==='integration')beginCoordination(this.db,task.id,runId,coordination.kind,coordination.run?.run_id);
        this.db.prepare(
          `INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES (?, ?, 'owner', 1, 'active')`,
        ).run(runId, member.id);
        this.db.prepare(
          `INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch, collab_absence_ms, collab_turn_deadline_ms, collab_config_revision, stop_generation_snapshot)
           VALUES (?, ?, ?, ?, ?, 'direct.work', 'RUNNING', ?, 1, 1, ?, ?, ?, ?)`,
        ).run(turnId, runId, task.conversation_id, task.conversation_thread_id, member.id, claimed.dispatch_key, collabSnap.absenceToleranceMs, collabSnap.turnDeadlineMs, collabSnap.configRevision, task.stop_generation);
        bindMemberMessageTurn(this.db,task.id,runId,turnId);
        this.db.prepare('UPDATE outbox SET turn_id = ? WHERE id = ?').run(turnId, claimed.id);
        if(conversationRequest)setConversationReplyState(this.db,conversationRequest.messageId,'running',undefined,runId,turnId);
        // ContextBundle 落库：信封全文 + hash（与发给模型的文本同源，PP-04 可核对）。
        this.db.prepare(
          `INSERT INTO context_bundles (id, turn_id, thread_id, task_revision, baseline_id, included_refs_json, scope_grants_json, hash)
           VALUES (?, ?, ?, ?, NULL, ?, '[]', ?)`,
        ).run(assembled.value.bundleId, turnId, task.conversation_thread_id, conversationRequest?task.revision:0, JSON.stringify(assembled.value.envelope), assembled.value.hash);
        if(writeAccess.modificationAuthorized) {
          const lease=acquireLease(this.db,{lockDomain:comparisonKey(writeAccess.root),ownerTurnId:turnId,policy:'single_writer',now:Date.now()});
          if(!lease.ok) throw Object.assign(new Error('写入目录已有持有者'),{name:'WriteLeaseHeld'});
          this.kvSet(`write-lease:${turnId}`,comparisonKey(writeAccess.root));
        }
        this.transitionTask(task.id, 'ACTIVE');
        this.audit(task, runId, turnId, 'run.created', { mode: 'DIRECT', bundleId: assembled.value.bundleId, resultKey: assembled.value.resultKey });
        if (baselineContentUnavailable.length > 0) {
          this.audit(task, runId, turnId, 'run.baselineContentUnavailable', {
            paths: baselineContentUnavailable,
            changeSetId: baselineChangeSetId,
            note: '路径与 hash 已冻结，但这些文件没有内容级前像；不伪造可撤销，也不覆盖用户明确选择的执行权限',
          });
        }
        // 修复工作项原子消费：与 run/turn 创建同事务（崩溃时二者一致——要么都成、要么
        // 工作项保持 pending 可重领，不丢失不降级）；resultKey 关联=consumed_turn_id 绑定。
        if (isRepairDispatch && repairItem != null) {
          this.db.prepare(`UPDATE format_repair_workitems SET status = 'consumed', consumed_turn_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
            .run(turnId, Date.now(), repairItem.id);
          this.audit(task, runId, turnId, 'task.repairConsumed', { workitemId: repairItem.id, sourceTurnId: repairItem.source_turn_id, sourceResultKey: repairItem.source_result_key, resultKey: assembled.value.resultKey, budgetCarryoverUsed: priorUsed });
        }
      });
      try {
        createRun();
      } catch (slotError) {
        if((slotError as Error).name==='WriteLeaseHeld') {
          this.releaseAdmission(turnId);releaseOutbox(this.db,claimed.id,claimed.attempt_epoch);this.blockedOutbox.set(claimed.id,'write-root');this.audit(task,null,null,'run.admissionDeferred',{reason:'write-root'});return;
        }
        // 提醒调用格 hold（原子收敛路径）：createRun 已回滚（无 run/turn/inflight）——走留证。
        if ((slotError as { name?: unknown }).name === 'ReminderSlotHeld') {
          const held = slotError as { reason: 'budget_exceeded' | 'budget_corrupt'; reminderId: string };
          this.startingTurns.delete(turnId);
          const txHold = this.db.transaction(() => {
            this.db.prepare("UPDATE reminders SET status = CASE WHEN status = 'done' THEN 'done' ELSE 'paused' END, paused_reason = ?, updated_at = ? WHERE id = ? AND status IN ('active','done')").run(held.reason, Date.now(), held.reminderId);
            this.transitionTask(task.id, 'BLOCKED');
            this.audit(task, null, null, 'reminder.budgetGateHeld', { reminderId: held.reminderId, reason: held.reason, dispatchKey: claimed.dispatch_key, note: '提醒调用额度已尽/损坏：不派发（提高额度后经追加执行续跑）' });
          });
          txHold();
          await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
          return;
        }
        throw slotError;
      }

      if (baselineChangeSetId != null) this.kvSet(`write-changeset:${turnId}`, baselineChangeSetId);
      // 层 A 常驻提示词：会话绑定渲染快照（规格 §5.1；渲染失败/敏感命中不开会话）。
      // DM（DEV-22）：私信模板——无房间/线程上下文，不填伪造 roomId。
      startupPhase = 'standing-prompt';
      const draftDir = join(this.appDataDir, 'drafts', task.project_id);
      const isDm = task.kind === 'dm_turn' || conversationKind === 'dm';
      const standing = isDm
        ? renderStandingPrompt({
          conversationKind: 'dm',
          vars: {
            memberId: member.id,
            memberDisplayName: member.display_name,
            projectId: project.id,
            projectName: project.display_name,
            conversationId: task.conversation_id,
            workspacePath: project.canonical_path,
            draftDir,
          },
        })
        : renderStandingPrompt({
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
      // adapter 解析=runtime 调用**之前**（第十六轮四：真实派发防护在构建 adapter 前抛错——
      // 属「确认未启动」分类，不得按 openSession 不确定语义留 UNKNOWN）。
      const adapter = this.adapterOf(member.id);
      startupPhase = 'openSession';
      // 代次=已落行数+在途未结算数（第二十二轮三）：行插入延迟到终态结算——上一轮结算失败时
      // 行缺失，仅数行会让本轮与失败轮同代次，终态插入撞 dm_session_reuse_key 唯一键。
      // dmPending 中的同会话条目（正常路径终态即清，失败留存重试）即在途未结算数。
      const generation = (this.db
        .prepare('SELECT count(*) c FROM runtime_sessions WHERE member_id = ? AND conversation_id = ?')
        .get(member.id, task.conversation_id) as { c: number }).c
        + [...this.dmPending.values()].filter((p) => p.memberId === member.id && p.task.conversation_id === task.conversation_id).length;
      // DM 会话续接（第十九轮五建立；第二十轮二改终态结算制）——resume 候选=同 conversation/
      // member 上一 provider 会话身份（**非空**：Claude 首开 openSession 返回空串，真实 ID 由
      // init/result 事件原地回填——openSession 返回值复制 resume 请求 ID ≠ provider 已接受）。
      // 续接判定挪到 turn 终态（见 settleDmSession）：以 provider 实际上报身份核对，终态回填
      // runtime_sessions。候选按成员当前 runtime 绑定与行内绑定快照（capabilities_json）校验
      // 兼容——runtime 切换不续接（新会话+历史重放）。房间会话维持任务隔离，不 resume。
      // 快照=统一解析层的实际结果（第二十二轮三：resolveMemberRuntime——kind/model/
      // installationId/permissionMode/cwd 一份事实；adapter 选择（adapterFor）同源，不再由
      // worker 从环境变量拼第二套身份）。
      const dmResolved = isDm ? resolveMemberRuntime(this.db, member.id, this.defaultKindOf()) : null;
      const resolvedKind = dmResolved?.kind ?? null;
      const resolvedModel = dmResolved?.model ?? null;
      const dmBindingSnap = JSON.stringify({
        runtimeKind: resolvedKind,
        model: resolvedModel,
        installationId: dmResolved?.installationId ?? null,
        promptVersion: standing.value.version,
        promptTemplateHash: standing.value.templateHash,
        writeIdentity: writeAccess.identityKey,
        writeAccessMode: { fullAccess: writeAccess.fullAccess, modificationAuthorized: writeAccess.modificationAuthorized, root: writeAccess.root, identityKey: writeAccess.identityKey },
        permissionMode: dmResolved?.permissionMode ?? null,
        effort:dmResolved?.effort??null,
        cwd: project.canonical_path,
      });
      const dmPrevSession = isDm
        ? this.db.prepare(
          "SELECT id, provider_session_id, session_generation, thread_id, member_id, cwd, capabilities_json FROM runtime_sessions WHERE conversation_id = ? AND member_id = ? AND scope_kind = 'dm' AND provider_session_id IS NOT NULL AND provider_session_id != '' ORDER BY rowid DESC LIMIT 1",
        ).get(task.conversation_id, member.id) as { id: string; provider_session_id: string; session_generation: number; thread_id: string | null; member_id: string; cwd: string; capabilities_json: string | null } | undefined
        : undefined;
      let resumeRef: SessionRef | undefined;
      if (dmPrevSession != null) {
        // 绑定兼容：候选快照必须与当前 runtime、权限、工作目录及常驻提示词版本/hash 全一致。
        // 旧快照缺失 prompt 绑定或任一变化 → 不 resume（新会话+获准历史重放，不重放旧工具调用）。
        let prevSnap: { runtimeKind?: string | null; model?: string | null; installationId?: string | null; promptVersion?: string; promptTemplateHash?: string; permissionMode?: string | null; cwd?: string | null; writeIdentity?: string } | null = null;
        let snapDamaged = false;
        if (dmPrevSession.capabilities_json != null) {
          try {
            prevSnap = JSON.parse(dmPrevSession.capabilities_json) as { runtimeKind?: string | null; model?: string | null; installationId?: string | null; promptVersion?: string; promptTemplateHash?: string; permissionMode?: string | null; cwd?: string | null; writeIdentity?: string };
            if (typeof prevSnap.runtimeKind !== 'string' && prevSnap.runtimeKind !== null) snapDamaged = true;
          } catch { snapDamaged = true; }
        }
        // 缺失/损坏快照不默认兼容：按不兼容处理——新会话+历史重放，不冒充续接。
        const compatible = !snapDamaged
          && prevSnap != null
          && (prevSnap.runtimeKind ?? null) === resolvedKind
          && (prevSnap.model ?? null) === resolvedModel
          && (prevSnap.installationId ?? null) === (dmResolved?.installationId ?? null)
          && prevSnap.promptVersion === standing.value.version
          && prevSnap.promptTemplateHash === standing.value.templateHash
          && (prevSnap.permissionMode ?? null) === (dmResolved?.permissionMode ?? null)
          && (prevSnap.cwd ?? null) === project.canonical_path
          && prevSnap.writeIdentity === writeAccess.identityKey;
        if (compatible) {
          resumeRef = {
            id: dmPrevSession.id,
            providerSessionId: dmPrevSession.provider_session_id,
            runtimeInstallationId: dmResolved?.installationId ?? (resolvedKind != null ? `default:${resolvedKind}` : 'unbound'), // 实际解析身份（绑定或全局默认——不用伪造常量）
            adapterVersion: 'resume-of-record',
            threadId: dmPrevSession.thread_id ?? '',
            sessionGeneration: dmPrevSession.session_generation,
            cwd: dmPrevSession.cwd,
          };
        } else {
          this.audit(task, null, null, 'dm.sessionResumeSkipped', {
            conversationId: task.conversation_id, memberId: member.id,
            prevSnapshot: prevSnap,
            currentResolved: dmResolved != null ? { kind: dmResolved.kind, model: dmResolved.model, installationId: dmResolved.installationId, permissionMode: dmResolved.permissionMode, bound: dmResolved.bound } : null,
            currentPrompt: { version: standing.value.version, templateHash: standing.value.templateHash },
            note: 'runtime 解析或常驻提示词版本已变化（kind/model/installation/prompt/权限档/cwd 之一）：不续接——新会话+获准历史重放，不重放旧工具调用',
          });
        }
      }
      const session = await adapter.openSession({
        projectId: task.project_id,
        memberId: member.id,
        taskId: task.id,
        threadId: task.conversation_thread_id,
        sessionGeneration: generation,
        cwd: project.canonical_path,
        policyId: writeAccess.policyId,
        writeAccess,
        ...(resumeRef != null ? { resume: resumeRef } : {}),
        developerInstructions: standing.value.text,
        promptVersion: standing.value.version,
      });
      openedSession = { adapter, session };
      startupPhase = 'session-record';
      // DM 会话行与续接判定=终态结算（settleDmSession）：openSession 返回值既可能是空 ID
      //（Claude 首开）也可能是复制的 resume 请求 ID——都不能作为身份事实；终态时 adapter 已
      // 原地回填 provider 实际上报身份（init/result session_id），据此回填/插行/判定。
      // 房间会话维持任务隔离：每任务一行，openSession 后即插（身份立即可用/无续接语义）。
      if (!isDm) {
        this.db.prepare(
          `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd, provider_session_id, capabilities_json)
           VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(session.id, task.project_id, task.conversation_id, task.conversation_thread_id, member.id, task.id, generation, project.canonical_path, (session.providerSessionId ?? '').trim() !== '' ? session.providerSessionId : null,JSON.stringify({runtime:resolveMemberRuntime(this.db,member.id,this.defaultKindOf()),writeIdentity:writeAccess.identityKey,writeAccessMode:{fullAccess:writeAccess.fullAccess,modificationAuthorized:writeAccess.modificationAuthorized,root:writeAccess.root,identityKey:writeAccess.identityKey},effortVerification:'requested-not-provider-certified'}));
      } else {
        this.dmPending.set(turnId, { task, session, resumeRef, bindingSnap: dmBindingSnap, cwd: project.canonical_path, generation, memberId: member.id, turnRequested: false });
      }

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

      const imageCapabilityAtLaunch = memberImageCapability(this.db, member.id);
      if ((assembled.value.images?.length ?? 0) > 0 && (imageCapabilityAtLaunch.status !== 'supported'
        || imageCapabilityAtLaunch.identityKey !== imageCapabilityAtAssembly.identityKey
        || JSON.stringify(resolveMemberRuntime(this.db, member.id, this.defaultKindOf())) !== imageBindingAtAssembly)) {
        startupPhase = 'session-record'; // No turn request has been made; close the opened session normally.
        throw new AdapterCallError('CAPABILITY_UNSUPPORTED', '图片输入认证或成员运行时在派发前已变化；原消息与原件保留，未发送图片');
      }
      if(effectiveTaskWriteAccess(this.db,task.id,member.id,this.defaultKindOf(),(conversationRequest?.writeScopeJson??coordination?.request?.writeScopeJson)).identityKey!==writeAccess.identityKey) { startupPhase='session-record'; throw new AdapterCallError('CAPABILITY_UNSUPPORTED','项目授权、配置或目录在启动前变化；未派发'); }
      assertCoordinationDispatch(this.db,task.id,claimed.dispatch_key,turnId);
      const liveThreadRequest=generalRequest??(coordination?.request?threadReplyForDispatch(this.db,`task:${task.id}:thread-reply:${coordination.request.messageId}`):undefined);
      if(liveThreadRequest){const blocked=threadReplyBlock(this.db,liveThreadRequest,this.defaultKindOf());if(blocked)throw new AdapterCallError(blocked.code as ConstructorParameters<typeof AdapterCallError>[0],blocked.message,true);}
      if(executionBasis){const current=this.db.prepare('SELECT current_delivery_id FROM tasks WHERE id=?').get(task.id) as {current_delivery_id:string|null};if(current.current_delivery_id!==executionBasis.deliveryId)throw new AdapterCallError('STALE_REVISION','连接期间成果已更新；本条尚未发给 AI，请确认新版后重试',true);}
      this.live.set(turnId, { turnId, sessionId: session.id, adapter });
      // pre-launch 登记（supervisor 衔接）：请求可能已发出的窗口可区分「从未启动」——
      // startTurn 成功后由 registerProcessIdentity REPLACE 为完整身份。
      this.preRegisterTurnProcess(turnId, runId, member.id);
      startupPhase = 'startTurn';
      const dmPendingEntry = this.dmPending.get(turnId);
      if (dmPendingEntry != null) dmPendingEntry.turnRequested = true; // resume 请求即将发出（provider 接触窗口开始）
      await adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: assembled.value.bundleId,
        text: assembled.value.text,
        images: assembled.value.images,
        imageConfigurationKey: imageCapabilityAtLaunch.identityKey ?? undefined,
        policyId: writeAccess.policyId,
        taskRevision: 0,
        resultKey: assembled.value.resultKey,
        outputSchema:taskCompleteOutputSchema(assembled.value.resultKey,coordination?.kind==='planning'),
      });
      this.registerProcessIdentity(turnId, runId, member.id, adapter, session);
      // 会话绑定（第八轮迟到成果泵：UNKNOWN turn 的 lateEvents 按 session 找回 adapter 通道）。
      try { this.db.prepare('UPDATE agent_turns SET session_id = ? WHERE id = ?').run(session.id, turnId); } catch { /* 尽力而为 */ }
      await this.consumeTurn(task, runId, turnId, session.id, adapter, member.id, { id: claimed.id, attemptEpoch: claimed.attempt_epoch });
      // detached：consumeTurn 已登记消费器并返回（live/outbox 完结由消费器收尾）；
      // inline：此处返回时 turn 已终态、outbox 已完结。
    } catch (dispatchError) {
      // 启动失败统一收尾（第五轮：openSession/startTurn/记录写入全覆盖，两分类——
      // 确认未启动=清理+释放占位；不确定=UNKNOWN+保留占位+对账要求）。
      if (startupPhase === 'startTurn' && openedSession != null) {
        // startTurn 已过但抛错（请求可能已发出）：adapter 已知的进程身份尽力登记——UNKNOWN 对账增强。
        this.registerProcessIdentity(turnId, runId, member.id, openedSession.adapter, openedSession.session);
      }
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
    if(phase==='startTurn'&&error instanceof AdapterCallError&&error.notStarted)phase='session-record';
    const integrationAttempt=this.db.prepare('SELECT coordination_run_id FROM coordination_integration_attempts WHERE execution_run_id=?').get(runId) as {coordination_run_id:string}|undefined;
    const blockIntegrationStart=()=>integrationAttempt?settleIntegrationLaunchFailure(this.db,integrationAttempt.coordination_run_id,message,true):false;
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
        if(integrationAttempt)blockIntegrationStart();
        else this.transitionTask(task.id,'ACTIVE');
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
      if(integrationAttempt)blockIntegrationStart();
      else this.transitionTask(task.id, phase === 'standing-prompt' ? 'BLOCKED' : 'ACTIVE');
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
    // 进程树周期快照（第八轮）：捕获消费期间新派生的代际（工具子进程/孙进程），使退出
    // 时刻的归属核对有历史锚点。仅真实子进程模型；none 无 OS 遗留可能、unknown 尚无 PID。
    let treeKeeper: NodeJS.Timeout | null = null;
    try {
      const reg = getTurnProcessRegistration(this.db, turnId);
      const rootPid = reg?.pid != null && reg.process_model !== 'none' && reg.process_model !== 'unknown' ? reg.pid : null;
      if (rootPid != null) {
        treeKeeper = setInterval(() => this.snapshotProcessTree(turnId, rootPid), 5_000);
        treeKeeper.unref?.();
      }
    } catch { /* 登记读取失败不阻断消费 */ }
    try {
      if (!this.detached) {
        this.startingTurns.delete(turnId); // 启动窗口结束（inline 消费阻塞 drain——drainPending 兜底）
        try {
          await this.consumeUntilTerminal(task, runId, turnId, sessionId, adapter);
        } finally {
          this.releaseAdmission(turnId); // 终态/失败/取消统一回收（UNKNOWN 不释放——对账未定不提前放行）
          this.closeProcessRegistrationIfTerminal(turnId);
          await completeOutbox(this.db, outbox.id, outbox.attemptEpoch);
        }
        return;
      }
      const settle = (): void => {
        // 关库后到达（强制退出路径残余消费者）不再抛——恢复语义由 UNKNOWN 审计承载。
        try { completeOutbox(this.db, outbox.id, outbox.attemptEpoch); } catch { /* 已关库：恢复语义承载 */ }
        this.live.delete(turnId); // detached：live 由消费器收尾删（inline 已由调用方删，幂等）
        try { this.releaseAdmission(turnId); } catch { /* 已关库：准入账本随进程消亡 */ }
        this.closeProcessRegistrationIfTerminal(turnId);
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
    } finally {
      if (treeKeeper != null) clearInterval(treeKeeper);
    }
  }

  /**
   * 准入占位释放 + 解除排队 skip（终态时保守清全部——skip 项下一轮重试判定）。
   * UNKNOWN 不释放：结果不确定（对账未定）不提前放行——由恢复/强制退出路径收口。
   * r57：protection_state='retained' 同样不释放（预算已处置但保护未解除的遗留保护——
   * 正式解除 recovery.releaseProtection 后经同钩子释放，与重启恢复的占位口径一致）。
   */
  private releaseAdmission(turnId: string): void {
    const st = this.db.prepare('SELECT status, protection_state FROM agent_turns WHERE id = ?').get(turnId) as { status: string; protection_state: string | null } | undefined;
    if (st?.status === 'UNKNOWN' || st?.protection_state === 'retained') return;
    const changeset=this.kvGet(`write-changeset:${turnId}`);
    if(changeset) {
      const result=finalizeChangeset(this.db,{changeSetId:changeset,appDataDir:this.appDataDir});
      if(result.ok || result.error.code==='STALE_REVISION') this.db.prepare('DELETE FROM daemon_state WHERE key=?').run(`write-changeset:${turnId}`);
    }
    const root=this.kvGet(`write-lease:${turnId}`);
    if(root) {
      this.db.prepare("UPDATE workspace_leases SET status='released' WHERE owner_turn_id=? AND lock_domain=?").run(turnId,root);
      this.db.prepare('DELETE FROM daemon_state WHERE key=?').run(`write-lease:${turnId}`);
    }
    this.admission.release(turnId);
    this.blockedOutbox.clear();
  }

  /** 成员绑定的 runtime kind（provider 维度准入键；未绑定回落默认 runtime 标识）。 */
  private providerKeyOf(memberId: string): string {
    return readMemberRuntimeBinding(this.db, memberId)?.kind ?? this.defaultProviderKey;
  }

  /**
   * turn 进程身份登记（DEV-13 第七轮：OS 退出证据的事实锚点）——startTurn 成功后调用；
   * startTurn 抛错但 adapter 已知进程身份时也尽力登记（UNKNOWN 对账增强）。
   * 登记尽力而为：取证失败不阻断执行（对账时如实 identity-missing / pid-only 降级）。
   * 启动时刻查询用短超时（3s）——启动路径不为取证付出长阻塞代价。
   */
  private registerProcessIdentity(
    turnId: string, runId: string, memberId: string, adapter: RuntimeAdapter, session: SessionRef,
  ): void {
    try {
      const identity = adapter.processIdentity?.(session, turnId) ?? null;
      if (identity == null) return; // adapter 未上报：无登记（对账时如实 identity-missing）
      let startedAtMs: number | null = null;
      if (identity.model !== 'none' && identity.pid != null) {
        const r = checkProcessLiveness(identity.pid, undefined, 3_000);
        if (r.state === 'alive') startedAtMs = r.identity.startedAt;
      }
      // REC-LIFE-1（第十四轮二）：受管身份正式绑定——adapter 上报 managedJobId（稳定身份）
      // 随登记持久化（managed_job_id 列；PID 仅辅助）。标记 managed-job 的条件=上报身份
      // **且**本进程受管注册表确有其 job（防 adapter 误报/已收尾的追认）。
      const managedJobId = identity.managedJobId ?? null;
      const isManaged = managedJobId != null && managedJobById(managedJobId) != null;
      registerTurnProcess(this.db, {
        turnId, runId, memberId,
        adapterKind: this.providerKeyOf(memberId),
        processModel: identity.model,
        pid: identity.pid,
        startedAtMs,
        identitySource: isManaged ? 'managed-job' : identity.model === 'none' ? 'none' : startedAtMs != null ? 'os-starttime' : 'pid-only',
        managedJobId: isManaged ? managedJobId : null,
        note: isManaged ? `job=${managedJobId}` : undefined,
      });
      // 首张进程树快照（第八轮）：崩溃/截止窗口再短也有归属锚点（周期重拍在消费期间进行）。
      if (identity.model !== 'none' && identity.pid != null) this.snapshotProcessTree(turnId, identity.pid);
    } catch { /* 取证失败不阻断派发（登记缺失在对账侧如实降级） */ }
  }

  /**
   * 进程树快照（第八轮：持续归属登记）——从登记根 BFS 收集当时的存活树（含根）。
   * 中间代际退出后其历史父子边随进程消失，退出时刻的现存树扫描看不见孙进程；
   * 活跃期快照是「孙进程遗留」归属核对的唯一锚点。尽力而为：失败不阻断执行
   * （probe 侧无快照=未完整确认，保护保留——如实降级）。
   */
  /** 最近一次人工验收结论为「要求修改」→ 返工反馈（新交付验收通过后自动消失）。 */
  private latestReviewFeedback(taskId: string): { deliveryRevision: number; note: string | null } | undefined {
    try {
      const row = this.db
        .prepare(`SELECT revision, review_status, review_note FROM task_deliveries WHERE task_id = ? AND review_status IN ('accepted','changes_requested') ORDER BY reviewed_at DESC, revision DESC LIMIT 1`)
        .get(taskId) as { revision: number; review_status: string; review_note: string | null } | undefined;
      if (row == null || row.review_status !== 'changes_requested') return undefined;
      return { deliveryRevision: row.revision, note: row.review_note };
    } catch {
      return undefined; // 查询失败不阻断派发（无反馈注入）
    }
  }

  private snapshotProcessTree(turnId: string, rootPid: number): void {
    try {
      const table = snapshotProcessTable();
      if (table.state !== 'ok') return;
      // 追加式历史身份登记（第九轮）：不删旧——根退出后 BFS 只见占位，父链已断但仍存活
      // 的后代必须靠先前观察保留身份；退出确认由 probe 核对后写回。
      recordProcessTreeObservation(this.db, turnId, rootPid, collectTreeRows(table.rows, rootPid));
    } catch { /* 观察失败不阻断执行（probe 侧按身份缺失如实降级） */ }
  }

  /** pre-launch 登记：startTurn 前写入 unknown 模型占位（崩溃窗口可识别「请求可能已发出」）。 */
  private preRegisterTurnProcess(turnId: string, runId: string, memberId: string): void {
    try {
      registerTurnProcess(this.db, {
        turnId, runId, memberId, adapterKind: this.providerKeyOf(memberId),
        processModel: 'unknown', pid: null, startedAtMs: null, identitySource: 'pre-launch',
      });
    } catch { /* 登记失败不阻断派发（对账侧如实 identity-missing/降级） */ }
  }

  /** 进程登记收口：仅终态（非 UNKNOWN）turn 标 closed——UNKNOWN=崩溃遗留候选，保持开放待对账。
   * 受管 job 收尾归属（第十四轮二）：per-turn job 在终态 settle 时经闸门收尾（shared/有共享
   * 者时保留——闸门内部判定）；UNKNOWN 不收口（证据待 releaseProtection 消费）。 */
  private closeProcessRegistrationIfTerminal(turnId: string): void {
    try {
      const s = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string } | undefined;
      if (s != null && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(s.status)) {
        closeTurnProcessRegistration(this.db, turnId);
        retireManagedJob(this.db, turnId); // 尽力而为：失败不影响执行（下次收口/stop 全量兜底）
      }
    } catch { /* 簿记失败不影响执行（登记对账按 open 语义处理） */ }
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

  /**
   * 对账后内存联动（DEV-13，recovery.reconcile 钩子）：turn 已被对账置 FAILED（非 UNKNOWN）
   * 时释放准入占位并解除排队 skip——DB 事务先于此调用，持久状态不受此失败影响。
   */
  reconcileRelease(turnId: string): void {
    const st = this.db.prepare('SELECT status, protection_state FROM agent_turns WHERE id = ?').get(turnId) as { status: string; protection_state: string | null } | undefined;
    // 双保险：仅持久状态确认后释放；r57——retained 期间不释放（与重启恢复口径一致，
    // recovery.releaseProtection 解除后经同钩子放行）。
    if (st == null || st.status === 'UNKNOWN' || st.protection_state === 'retained') return;
    this.admission.release(turnId);
    this.blockedOutbox.clear();
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
    const stopSnapshot=this.db.prepare('SELECT stop_generation FROM deliberation_run_scopes WHERE run_id=?').get(step.runId) as {stop_generation:number}|undefined;
    if (task.stop_generation > (stopSnapshot?.stop_generation??0)) {
      // 停止已生效：完结本步骤并把运行收尾为取消（停止作用于指定运行，§7.3）。
      const run0 = this.db.prepare("SELECT id, status FROM workflow_runs WHERE id=? AND task_id = ? AND mode = 'DELIBERATE'").get(step.runId,step.taskId) as { id: string; status: string } | undefined;
      if (run0 != null && !['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(run0.status)) {
        const tx0 = this.db.transaction(() => {
          settleStoppedDeliberation(this.db,task.id,run0.id);
          this.audit(task, run0.id, null, 'turn.dispatchCancelled', { reason: 'stop-before-dispatch',note:'仅作废本步骤；在途执行未收口时仍显示停止中' });
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
    // 停用成员的冻结名单步骤（第十七轮二）：与 DIRECT/路由同口径——不 startTurn、不占预算，
    // 按既有 unavailable 语义收口（屏障推进不占席位；后续阶段可恢复参与=重新启用后参与**新**
    // 步骤；本步骤出队完结不重放）。在途 turn 不受停用影响（终态路径照常）。
    const memberEnabledRow = this.db.prepare('SELECT enabled FROM project_members WHERE id = ?').get(step.memberId) as { enabled: number } | undefined;
    if (memberEnabledRow == null || memberEnabledRow.enabled !== 1) {
      const changed = this.db.prepare("UPDATE run_participants SET status = 'unavailable' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late','completed')").run(run.id, step.memberId).changes; // 含上一阶段 completed：停用覆盖（completed 非屏障终结，不覆盖会永远等待）
      if (changed > 0) {
        this.audit(task, run.id, null, 'run.memberDisabledSkip', {
          memberId: step.memberId, stage: step.stage,
          note: '成员停用：步骤按 unavailable 收口（不派发/不占预算；屏障推进；重新启用不重放本步骤）',
        });
      }
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
      return;
    }
    const repairError = isRepair ? this.kvGet(`delib:repair:${claimed.dispatch_key}`) : undefined;
    const assembly = assembleStepInput(this.db, { taskId: step.taskId, runId: run.id, step, repairError: repairError ?? undefined });
    if (!assembly.ok) {
      this.db.prepare("UPDATE run_participants SET status='failed' WHERE run_id=? AND member_id=? AND status IN ('pending','late')").run(run.id,step.memberId);
      await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      this.audit(task, run.id, null, 'task.contextAssemblyFailed', { reason: 'delib-assembly-failed', message: assembly.error.message, stage: step.stage });
      pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
      return;
    }
    const budget = (run.budget_json != null ? JSON.parse(run.budget_json) : null) as DeliberationBudgetState | null;
    if (budget == null) {
      this.db.transaction(()=>{
        this.db.prepare("UPDATE workflow_runs SET status='FAILED' WHERE id=?").run(run.id);
        this.transitionTask(task.id,'BLOCKED');
        settleThreadReplyForRun(this.db,run.id,'failed','研讨预算记录损坏；未启动模型，原请求不会自动重放');
        this.audit(task,run.id,null,'run.stepFailed',{stage:step.stage,memberId:step.memberId,message:'missing-deliberation-budget'});
      })();
      await failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    // 格式修复只能使用 non-tail F，不借用尚未执行的 SYN/RAT 保留额。
    const accStage = dispatchBudgetStage(step.stage === 'SYN' ? 'SYNTHESIS' : step.stage === 'RAT' ? 'RATIFY' : 'front', isRepair);
    const acc = budgetAccounting(budget, accStage);
    if (acc.stageAvailableTurns < 1) {
      this.audit(task, run.id, null, 'run.budgetSkipped', { dispatchKey: claimed.dispatch_key, stageAvailableTurns: acc.stageAvailableTurns, remaining: acc.remainingTurns });
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
      return;
    }
    // 前置派发也占用（I+1）：防并行领取读到旧账（A 组真实运行缺陷：双成员 DIS 并行
    // 派发时第 10 个调用漏出 runMaxTurns=9）；settleTurn 结算时释放占用。
    const nextBudget = accStage === 'front' ? occupyFrontForDispatch(budget) : occupyTailForDispatch(budget, accStage);

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
    const frozen=coordinationRoster(this.db,task.id);
    const memberScope=frozen.find(m=>m.memberId===step.memberId);
    let writeAccess:ReturnType<typeof effectiveTaskWriteAccess>;
    let materials:ReturnType<typeof assembleDirectTurn>;
    const imageBinding=JSON.stringify(resolveMemberRuntime(this.db,step.memberId,this.defaultKindOf()));
    const imageCapability=memberImageCapability(this.db,step.memberId);
    try{
      if(frozen.length && !memberScope?.writeScope)throw Error(memberScope?.unavailableReason??'成员未包含在发送时的配置快照内');
      writeAccess=effectiveTaskWriteAccess(this.db,task.id,step.memberId,this.defaultKindOf(),memberScope?.writeScope??undefined);
      materials=assembleDirectTurn({db:this.db,blobRoot:join(this.appDataDir,'blobstore'),allowImages:imageCapability.status==='supported',writeAccess,
        task:{id:task.id,projectId:task.project_id,conversationId:task.conversation_id,conversationKind:'room',roomId:task.room_id,threadId:task.conversation_thread_id,rootMessageId:task.root_message_id,title:task.title,objective:task.objective,taskRevision:task.revision,inputThroughSeq:task.input_through_seq},
        identity:{member:{id:member.id,displayName:member.display_name},project:{id:project.id,displayName:project.display_name},room:{id:task.room_id,name:room?.name??'未命名房间'}},turnId,
        budget:{grantId:run.id,maxTurns:budget.runMaxTurns,usedTurns:budget.usedTurns,inFlightReservedTurns:budget.inFlightReservedTurns}});
      if(!materials.ok)throw Error(materials.error.message);
      // App-managed R93 details are derived from earlier visible answers, not
      // canonical stage material for any DELIB step; user uploads remain.
      const stageAttachments=(materials.value.envelope.attachments??[]).filter((attachment)=>attachment.detail!==true);
      const permissionText=writeAccess.fullAccess
        ? '本轮有效权限为 CLI 完整权限。围绕用户目标直接完成必要查证、命令、修改和验证；分析/评审角色标签不降低 runtime 权限。'
        : writeAccess.modificationAuthorized
          ? `本轮已获项目写入授权（${writeAccess.root}）。在授权根目录内直接完成修改和验证；分析/评审角色标签不降低 runtime 权限。`
          : '本轮有效权限为只读/计划；按实际选择分析，不修改文件。';
      assembly.value.text+=`\n\n【本轮有效权限】${permissionText}\n【附件材料】${JSON.stringify(stageAttachments)}\n图片内容通过独立图片输入块提供（${materials.value.images?.length??0}张）。`;
    }catch(error){
      this.db.prepare("UPDATE run_participants SET status='failed' WHERE run_id=? AND member_id=?").run(run.id,step.memberId);
      this.audit(task,run.id,null,'run.stepFailed',{stage:step.stage,memberId:step.memberId,message:String(error)});await failOutbox(this.db,claimed.id,claimed.attempt_epoch);pumpDeliberation(this.db,task.id,this.deliberationOptions(task.project_id));return;
    }
    // 统一派发准入（与 DIRECT 同一账本/语义；预算在上方已核对——预算限总量、准入限并发，不混用）。
    const admission = this.admission.tryAcquire(turnId, {
      memberId: step.memberId,
      projectId: task.project_id,
      providerKey: this.providerKeyOf(step.memberId),
      writeRootKey: writeAccess.modificationAuthorized ? comparisonKey(writeAccess.root) : null,
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
      const collabSnap = this.collabSnapshotFor(task.project_id);
      const createTurn = this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, turn_purpose, status, dispatch_key, attempt, epoch, collab_absence_ms, collab_turn_deadline_ms, collab_config_revision, stop_generation_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, 1, 1, ?, ?, ?, ?)`,
        ).run(turnId, run.id, task.conversation_id, task.conversation_thread_id, step.memberId, assembly.value.stageKey, assembly.value.turnPurpose, claimed.dispatch_key, collabSnap.absenceToleranceMs, collabSnap.turnDeadlineMs, collabSnap.configRevision, task.stop_generation);
        this.db.prepare('UPDATE outbox SET turn_id = ? WHERE id = ?').run(turnId, claimed.id);
        this.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(nextBudget), run.id);
        this.db.prepare(
          `INSERT INTO context_bundles (id, turn_id, thread_id, task_revision, baseline_id, included_refs_json, scope_grants_json, hash)
           VALUES (?, ?, ?, 0, NULL, ?, '[]', ?)`,
        // 全文入 bundle（PP-04：真实输入可核对——审计用 sha256(text) 复核）。
        ).run(bundleId, turnId, task.conversation_thread_id, JSON.stringify({ stage: assembly.value.stage, memberId: step.memberId, roundNo: step.roundNo, turnPurpose: assembly.value.turnPurpose, instruction: assembly.value.instruction, outputContract: assembly.value.outputContract, text: assembly.value.text }), textHash);
        if(writeAccess.modificationAuthorized){
          const lease=acquireLease(this.db,{lockDomain:comparisonKey(writeAccess.root),ownerTurnId:turnId,policy:'single_writer',now:Date.now()});
          if(!lease.ok)throw Object.assign(new Error('研讨写入目录已有持有者'),{name:'WriteLeaseHeld'});
          this.kvSet(`write-lease:${turnId}`,comparisonKey(writeAccess.root));
        }
        if (task.status === 'OPEN') this.transitionTask(task.id, 'ACTIVE');
      });
      try{
        createTurn();
      }catch(turnError){
        if((turnError as Error).name==='WriteLeaseHeld'){
          this.releaseAdmission(turnId);
          releaseOutbox(this.db,claimed.id,claimed.attempt_epoch);
          this.blockedOutbox.set(claimed.id,'write-root');
          this.audit(task,run.id,null,'run.admissionDeferred',{reason:'write-root',dispatchKey:claimed.dispatch_key});
          return;
        }
        throw turnError;
      }
      startupPhase = 'standing-prompt';
      if(writeAccess.modificationAuthorized){
        const baseline=captureBaseline(this.db,{projectId:task.project_id,taskId:task.id,runId:run.id,appDataDir:this.appDataDir});
        if(!baseline.ok)throw Error(`研讨写入基线失败：${baseline.error.message}`);
        if(baseline.value.truncated)throw Error('研讨写入基线不完整：目录扫描失败、路径被拒绝或文件清单超出安全范围');
        const baselineChangeSetId=baseline.value.changeSetId;
        const baselineContentUnavailable=baseline.value.contentUnavailable;
        this.kvSet(`write-changeset:${turnId}`,baselineChangeSetId);
        if(baselineContentUnavailable.length>0)this.audit(task,run.id,turnId,'run.baselineContentUnavailable',{paths:baselineContentUnavailable,changeSetId:baselineChangeSetId,note:'这些文件没有内容级前像；不降低已授权执行权限，变更按实际差异留证'});
      }
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
        policyId: writeAccess.policyId,
        writeAccess,
        developerInstructions: standing.value.text,
        promptVersion: standing.value.version,
      });
      openedSession = { adapter, session };
      startupPhase = 'session-record';
      this.db.prepare(
        `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd,capabilities_json)
         VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?,?)`,
      ).run(session.id, task.project_id, task.conversation_id, task.conversation_thread_id, step.memberId, task.id, generation.c, project.canonical_path,
        JSON.stringify({runtime:resolveMemberRuntime(this.db,step.memberId,this.defaultKindOf()),writeIdentity:writeAccess.identityKey,writeAccessMode:{fullAccess:writeAccess.fullAccess,modificationAuthorized:writeAccess.modificationAuthorized,root:writeAccess.root,identityKey:writeAccess.identityKey},effectivePolicy:writeAccess.policyId,effortVerification:'requested-not-provider-certified'}));
      this.db.prepare('UPDATE agent_turns SET session_id=? WHERE id=? AND run_id=?').run(session.id,turnId,run.id);

      if (this.stoppingOrTerminal(task.id, turnId) || this.shutdownStarted) {
        const closeOutcome = await this.closeSessionBounded(adapter, session);
        if(closeOutcome!=='closed'){this.settleUnknown(task,run.id,turnId,'stop-open-session-close-unconfirmed');await failOutbox(this.db,claimed.id,claimed.attempt_epoch);return;}
        const cancel = this.db.transaction(() => {
          this.casTurn(turnId, 'CANCELLED');
          this.refundDelibReservation(run.id,turnId,accStage,accStage!=='front'&&budget.tailReservationByStage[accStage]>0);
          if(this.shutdownStarted)this.db.prepare("UPDATE workflow_runs SET status='STOPPING' WHERE id=? AND status IN ('RUNNING','WAITING')").run(run.id);
          settleStoppedDeliberation(this.db,task.id,run.id);
          this.audit(task, run.id, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: this.shutdownStarted ? 'daemon-shutdown-during-session-open' : 'stop-during-session-open', sessionClose: closeOutcome });
        });
        cancel();
        this.releaseAdmission(turnId);
        await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
        return;
      }

      const cancelUnavailablePeer=async()=>{
        const closeOutcome=await this.closeSessionBounded(adapter,session);
        if(closeOutcome!=='closed'){
          this.settleUnknown(task,run.id,turnId,'peer-run-invalid-session-close-unconfirmed');
          await failOutbox(this.db,claimed.id,claimed.attempt_epoch);return;
        }
        this.db.transaction(()=>{
          this.casTurn(turnId,'CANCELLED');
          const marked=this.refundDelibReservation(run.id,turnId,accStage,accStage!=='front'&&budget.tailReservationByStage[accStage]>0);
          this.db.prepare("UPDATE run_participants SET status='unavailable' WHERE run_id=? AND member_id=? AND status IN ('pending','late')").run(run.id,step.memberId);
          this.audit(task,run.id,turnId,'turn.startupCancelled',{reason:'研讨已中断或同轮结果未知；未请求startTurn',classification:'confirmed-not-started',sessionClose:closeOutcome,budgetRefunded:Boolean(marked)});
        })();
        this.releaseAdmission(turnId);await completeOutbox(this.db,claimed.id,claimed.attempt_epoch);
      };
      if(!this.deliberationMayLaunch(task.id,run.id)){await cancelUnavailablePeer();return;}

      if(effectiveTaskWriteAccess(this.db,task.id,step.memberId,this.defaultKindOf(),memberScope?.writeScope??undefined).identityKey!==writeAccess.identityKey
        ||JSON.stringify(resolveMemberRuntime(this.db,step.memberId,this.defaultKindOf()))!==imageBinding
        ||(materials.value.images?.length&&memberImageCapability(this.db,step.memberId).identityKey!==imageCapability.identityKey))throw Error('研讨成员实际配置在启动前变化；未发送');
      if(!this.deliberationMayLaunch(task.id,run.id)){await cancelUnavailablePeer();return;}
      this.live.set(turnId, { turnId, sessionId: session.id, adapter });
      this.preRegisterTurnProcess(turnId, run.id, step.memberId);
      startupPhase = 'startTurn';
      await adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: bundleId,
        text: assembly.value.text,
        images:materials.value.images,
        imageConfigurationKey:imageCapability.identityKey??undefined,
        outputSchema:deliberationOutputSchema(step.stage),
        policyId: writeAccess.policyId,
        taskRevision: 0,
        resultKey: `result_${turnId}`,
      });
      this.registerProcessIdentity(turnId, run.id, step.memberId, adapter, session);
      await this.consumeTurn(task, run.id, turnId, session.id, adapter, step.memberId, { id: claimed.id, attemptEpoch: claimed.attempt_epoch });
    } catch (dispatchError) {
      if (startupPhase === 'startTurn' && openedSession != null) {
        this.registerProcessIdentity(turnId, run.id, step.memberId, openedSession.adapter, openedSession.session);
      }
      await this.settleDelibStartupFailure(task, run.id, turnId, step, { id: claimed.id, attemptEpoch: claimed.attempt_epoch }, startupPhase, dispatchError, openedSession, {
        stage: accStage,
        restoreTail: accStage !== 'front' && budget.tailReservationByStage[accStage] > 0,
      });
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
    reservation?: { stage: 'front' | 'SYNTHESIS' | 'RATIFY'; restoreTail: boolean },
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const finishConfirmed = (extra: Record<string, unknown>): void => {
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, 'FAILED');
        if (reservation != null) this.refundDelibReservation(runId, turnId, reservation.stage, reservation.restoreTail);
        else this.settleDelibBudget(runId);
        this.db.prepare("UPDATE run_participants SET status = 'failed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, step.memberId);
        this.audit(task, runId, turnId, 'turn.startupFailed', { phase, message: message.slice(0, 200), classification: 'confirmed-not-started', ...extra });
      });
      tx();
      this.releaseAdmission(turnId);
      pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
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

  private refundDelibReservation(runId:string,turnId:string,stage:'front'|'SYNTHESIS'|'RATIFY',restoreTail:boolean):boolean {
    const marked=this.db.prepare("UPDATE agent_turns SET budget_mark='refunded' WHERE id=? AND budget_mark IS NULL").run(turnId).changes;
    if(!marked)return false;
    const current=this.db.prepare('SELECT budget_json FROM workflow_runs WHERE id=?').get(runId) as {budget_json:string};
    const next=refundReservedTurn(JSON.parse(current.budget_json) as DeliberationBudgetState);
    if(stage!=='front'&&restoreTail)next.tailReservationByStage[stage]++;
    this.db.prepare('UPDATE workflow_runs SET budget_json=? WHERE id=?').run(JSON.stringify(next),runId);return true;
  }

  private deliberationMayLaunch(taskId:string,runId:string):boolean {
    const run=this.db.prepare(`SELECT r.status,t.status task_status,t.stop_generation,s.stop_generation snapshot FROM workflow_runs r
      JOIN tasks t ON t.id=r.task_id LEFT JOIN deliberation_run_scopes s ON s.run_id=r.id WHERE r.id=? AND r.task_id=? AND r.mode='DELIBERATE'`).get(runId,taskId) as {status:string;task_status:string;stop_generation:number;snapshot:number|null}|undefined;
    return Boolean(run&&['RUNNING','WAITING'].includes(run.status)&&!['BLOCKED','CANCELLED','DONE','REVIEW'].includes(run.task_status)
      &&run.stop_generation===(run.snapshot??0)&&!this.db.prepare("SELECT 1 FROM agent_turns WHERE run_id=? AND status='UNKNOWN' LIMIT 1").get(runId));
  }

  private stoppingOrTerminal(taskId: string, turnId: string): boolean {
    const task = this.db
      .prepare('SELECT stop_generation, status FROM tasks WHERE id = ?')
      .get(taskId) as { stop_generation: number; status: string } | undefined;
    if (task == null) return true;
    const child=childCoordination(this.db,taskId);
    if(child){const parent=this.db.prepare('SELECT stop_generation,status FROM tasks WHERE id=?').get(child.task_id) as {stop_generation:number;status:string};if(parent.stop_generation!==child.stop_generation||parent.status==='CANCELLED'||child.state!=='running')return true;}
    if (task.status === 'CANCELLED' || task.status === 'DONE') return true;
    const turn = this.db
      .prepare('SELECT status, stop_generation_snapshot FROM agent_turns WHERE id = ?')
      .get(turnId) as { status: string; stop_generation_snapshot: number } | undefined;
    if (turn == null || ['STOPPING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(turn.status)) {
      return true;
    }
    // 停止作用于本 turn=代次**已超越快照**（第二十七轮五：历史代次（==快照）不禁止新 turn
    // ——停止结算后的合法跟进派发不再被误停）。旧行无快照（-1）沿用保守旧语义（>0 即停）。
    const gen0 = turn.stop_generation_snapshot ?? -1;
    if (gen0 >= 0 ? task.stop_generation > gen0 : task.stop_generation > 0) return true;
    // run 级停止事实（用户停止把 run 置 STOPPING——本 turn 属于它即停）。
    const runStatus = (this.db.prepare('SELECT r.status AS s FROM workflow_runs r JOIN agent_turns t ON t.run_id = r.id WHERE t.id = ?').get(turnId) as { s: string } | undefined)?.s;
    if (runStatus === 'STOPPING') return true;
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
    // 时限快照（第十八轮四）：在途 turn 用派发时快照——执行中改配置不改变既有 turn；
    // 快照前历史行（无快照列）回落现行项目配置。排队截止（dispatchWaitDeadline）是全局
    // 调度资源观察线，与本执行截止分属不同机制，不混用。
    const turnCollab = this.collabSnapshotOfTurn(turnId);
    const deadline = Date.now() + turnCollab.turnDeadlineMs;
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

      if((event.kind==='turn.completed'||event.kind==='turn.failed') && this.kvGet(`write-lease:${turnId}`)) {
        const ref={id:sessionId} as SessionRef;
        const identity=adapter.processIdentity?.(ref,turnId);
        if(identity?.model==='per-turn') {
          const exit=adapter as RuntimeAdapter & {waitForTurnExit?:(s:SessionRef,t:string,ms:number)=>Promise<{exitConfirmed:boolean}|null>};
          let proof=await exit.waitForTurnExit?.(ref,turnId,5000);
          if(!proof?.exitConfirmed){await adapter.interrupt(ref,turnId);proof=await exit.waitForTurnExit?.(ref,turnId,3000);}
          if(!proof?.exitConfirmed){this.audit(task,runId,turnId,'turn.writeExitUnconfirmed',{observedTerminal:event.kind});this.settleUnknown(task,runId,turnId,'write-process-exit-unconfirmed');return;}
        }
      }
      this.applyEvent(task, runId, turnId, event);
      if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {
        // R91：成功交付后做生成文件快照（事务外；失败只留可读状态，不影响已完成聊天）。
        if (event.kind === 'turn.completed') {
          try { await this.snapshotCompletedFiles(task, runId, turnId); } catch { /* 快照失败不得阻断终态收口 */ }
        }
        this.pumpDmAfterTerminal(task);
        return;
      }
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
        this.db.prepare("UPDATE coordination_runs SET state='blocked',error_message='协调执行结果未知；不会自动继续' WHERE (run_id=? OR integration_run_id=?) AND state IN ('planning','running','integrating')").run(runId,runId);
        settleConversationReplyForTurn(this.db,turnId,'UNKNOWN');
        settleThreadReplyForTurn(this.db,turnId,'UNKNOWN');
        settleMemberMessageTurn(this.db,task.id,turnId,'UNKNOWN','执行结果待核实；不会自动重发');
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
      // 真实调用台账（第十八轮二补漏）：settleUnknown 直接 UPDATE 绕过 casTurn——UNKNOWN 路径
      // （截止中断/强制中止/启动不确定）的 startTurn 台账行必须同样结算，不得永久 inflight。
      try { settleRealCall(this.db, turnId, 'unknown', `turn UNKNOWN（${reason}）`); } catch { /* 台账尽力而为 */ }
      this.settleDmSession(turnId); // UNKNOWN 终态同样结算会话身份（provider 可能已上报）
      this.pumpDmAfterTerminal(task); // dm 会话空闲恢复（UNKNOWN=会话不再占用——泵下一条）
      if (stageKey.startsWith('delib.')) pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
      if(stageKey.startsWith('delib.')){
        const peers=this.db.prepare("SELECT id FROM agent_turns WHERE run_id=? AND id!=? AND status IN ('RUNNING','WAITING_APPROVAL','WAITING_INPUT')").all(runId,turnId) as {id:string}[];
        for(const peer of peers){const live=this.live.get(peer.id);if(live){this.audit(task,runId,peer.id,'run.peerUnknownInterrupt',{unknownTurnId:turnId,note:'同轮结果未知，停止其他已知在途工作；不重发或解除未知保护'});void live.adapter.interrupt({id:live.sessionId} as SessionRef,peer.id).catch(()=>{});}}
      }
    }
  }

  /** 事件应用（public：迟到输出一致性用例经生产方法定点注入——不绕过状态机）。 */
  applyEvent(task: TaskRow, runId: string, turnId: string, event: NormalizedRuntimeEvent): void {
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
      case 'message.progress': {
        const text=visibleRuntimeProgress(event.text);
        if(!text)break;
        const live=this.db.prepare(`SELECT a.status,a.stop_generation_snapshot,t.stop_generation,t.status task_status
          FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
          WHERE a.id=? AND r.id=? AND t.id=?`).get(turnId,runId,task.id) as {status:string;stop_generation_snapshot:number;stop_generation:number;task_status:string}|undefined;
        if(!live||!['RUNNING','WAITING_APPROVAL','WAITING_INPUT'].includes(live.status)||live.task_status==='CANCELLED'||live.stop_generation>live.stop_generation_snapshot)break;
        this.db.prepare(`INSERT INTO turn_visible_progress(turn_id,source_message_id,text,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(turn_id) DO UPDATE SET source_message_id=excluded.source_message_id,text=excluded.text,updated_at=excluded.updated_at
          WHERE turn_visible_progress.text!=excluded.text`).run(turnId,event.messageId,text,this.clock());
        break;
      }
      case 'session.ready':
        if(event.providerSessionId)this.db.prepare('UPDATE runtime_sessions SET provider_session_id=? WHERE id=? AND task_id=? AND project_id=?').run(event.providerSessionId,event.sessionId,task.id,task.project_id);
        break;
      case 'turn.started': {
        const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
        if (turn.status === 'STOPPING') {
          // 停止先于开始回执生效：不回到 RUNNING，再发中断并留审计。
          this.audit(task, runId, turnId, 'turn.stoppingRace', { note: 'turn.started after stop; re-interrupting' });
          void (this.live.get(turnId)?.adapter ?? this.adapter).interrupt({ id: event.sessionId } as never, turnId);
          break;
        }
        this.casTurn(turnId, 'RUNNING');
        markMemberMessageStarted(this.db,turnId);
        break;
      }
      case 'message.completed':
        {
          const expected=`result_${turnId}`;
          const candidate=event.controlResult??event.text;
          const fenced=stripSingleJsonFence(candidate).text.trim();
          const appended=extractAppendedTaskComplete(fenced,expected)?.controlText;
          let valid:string|null=null;
          for(const text of [candidate.trim(),fenced,appended].filter((value):value is string=>typeof value==='string'&&value.length>0)){
            try{
              const parsed=taskCompleteSchema.safeParse(JSON.parse(text));
              if(parsed.success&&parsed.data.resultKey===expected){valid=text;break;}
            }catch{ /* not a control object */ }
          }
          if(valid!=null)this.controlFromMessages.set(turnId,valid);
        }
        this.insertThreadReply(task, turnId, event.messageId, event.text,event.controlResult,{finalMessage:true});
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
        // 真实调用台账（第十八轮三）：响应自报模型/用量引用真实事件原文——与请求模型分列，不猜测。
        recordRealCallUsage(this.db, turnId, event);
        break;
      case 'turn.completed': {
        const turn = this.db.prepare('SELECT status, budget_mark FROM agent_turns WHERE id = ?').get(turnId) as { status: string; budget_mark: string | null };
        const lateAfterStop = turn.status === 'STOPPING';
        // 停止代次守卫（第八轮；第二十七轮五快照化）：用户停止已推进（**代次超越本 turn 快照**
        // /CANCELLED）而 turn 尚未收口（UNKNOWN 等非终态）时，迟到输出不复活已停止的任务——按
        // 取消收尾（与 STOPPING 同型）。历史代次（==快照，停止早已结算）不算——新 turn 的合法
        // 输出不因历史停止被吞。旧行无快照（-1）沿用保守旧语义。
        const taskNow = this.db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(task.id) as { stop_generation: number; status: string } | undefined;
        const turnGen0 = (this.db.prepare('SELECT stop_generation_snapshot AS g FROM agent_turns WHERE id = ?').get(turnId) as { g: number } | undefined)?.g ?? -1;
        const stopGenerationInEffect = taskNow != null && (taskNow.status === 'CANCELLED'
          || (turnGen0 >= 0 ? taskNow.stop_generation > turnGen0 : taskNow.stop_generation > 0));
        if (!lateAfterStop && !stopGenerationInEffect && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(turn.status)) {
          // 成果一致性（第七轮·专项+第八轮补 SUCCEEDED）：已收口 turn（对账/停止/失败/成功
          // 交付后）的迟到/重复完成——**不复活、不交付、不重复结算**（交付/预算/状态只生效
          // 一次）；若输出可解析为合法合同且该 turn 已按未启动退款（budget_mark=refunded），
          // 这是「声明未启动但输出到达」的事实矛盾信号——留审计提示走 correctToExecuted
          // 纠正流程，不自动改账。
          this.audit(task, runId, turnId, 'turn.lateCompletion', {
            finalText: (event.finalText ?? '').slice(0, 200),
            turnStatus: turn.status,
            eventKey: event.eventKey,
            factConflictHint: turn.budget_mark === 'refunded' ? 'refunded-turn-received-output——与「未启动」声明矛盾，走 recovery.correctToExecuted 纠正' : null,
          });
          break;
        }
        if (!lateAfterStop && turn.status === 'UNKNOWN') {
          // 不确定窗口的迟到合法输出=把不确定收口为确定：回迁 RUNNING 走正常合同校验/
          // 交付/结算（casTurn 的终态保护不含 UNKNOWN 迁出——此处显式回迁并留审计）。
          this.db.prepare(`UPDATE agent_turns SET status = 'RUNNING' WHERE id = ? AND status = 'UNKNOWN'`).run(turnId);
          this.audit(task, runId, turnId, 'turn.lateOutputResolvesUnknown', { note: 'UNKNOWN 窗口收到完成输出——不确定收口为确定（走合同校验）' });
        }
        // R91 生成文件卡：只在“确实要交付/收尾为成功答复”的分支登记候选（不在事务内做文件 I/O）。
        const snapshotRef: { current: { files: string[]; diff: { added: string[]; modified: string[] } | null } | null } = { current: null };
        const tx = this.db.transaction(() => {
          if (lateAfterStop || stopGenerationInEffect) {
            // 停止已生效：迟到完成不复活任务（RT-06 形态），按取消收尾并留审计。
            this.casTurn(turnId, 'CANCELLED');
            this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?`).run(runId);
            this.settleBudget(runId);
            this.transitionTask(task.id, 'CANCELLED');
            this.audit(task, runId, turnId, 'turn.lateCompletion', { finalText: event.finalText ?? null, stopGeneration: taskNow?.stop_generation ?? null });
            this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: 'late-completion-after-stop' });
            return;
          }
          // 输出合同校验（修复轮）：finalText 必须是合法 TaskComplete 且 resultKey 匹配本 turn。
          // 非法输出（空/散文/缺项/错版本/错 resultKey）走 OUTPUT_INVALID：不产生交付、不 DONE/REVIEW，
          // 原稿保留（消息已入库）。首 turn 失败→任务回 ACTIVE（可有限修复）；**修复 turn
          // （redispatch）再失败→BLOCKED（修复耗尽，预算不再允许派发——不能在界面持续表现为
          // 可执行/正在执行，第六轮收口）**。
          const finalTextRaw = event.finalText ?? '';
          // 单层围栏规范化（第六轮，边界严格）：仅当围栏包裹**整个**文本（```json?\n…\n```）
          // 才剥壳后走同一严格 schema；围栏外还有正文/截取首个 JSON 段/删未知字段一律不做。
          const expectedResultKey=`result_${turnId}`;
          const fenced=stripSingleJsonFence(finalTextRaw);
          const appended=extractAppendedTaskComplete(fenced.text,expectedResultKey);
          const explicitTerminalControl=isExplicitTaskCompleteOutput(fenced.text);
          let finalText=appended?.controlText??fenced.text;
          let contract=this.validateTaskCompleteOutput(finalText,expectedResultKey);
          const messageControl=this.controlFromMessages.get(turnId);
          // A cached message-completed control may reconcile a natural-only terminal event.
          // When the terminal event itself presents a TaskComplete-shaped object with the
          // wrong schema/resultKey, that explicit failure must remain authoritative.
          if(!contract.ok&&messageControl!=null&&!explicitTerminalControl){
            finalText=messageControl;
            contract=this.validateTaskCompleteOutput(finalText,expectedResultKey);
            if(contract.ok)this.audit(task,runId,turnId,'turn.outputNormalized',{
              originalLength:finalTextRaw.length,normalizedLength:finalText.length,visibleTextLength:finalTextRaw.length,
              rule:'use-validated-control-from-message-completed; same strict schema/resultKey',
            });
          }
          const normalized=fenced.normalized||appended!=null;
          if (normalized) {
            this.audit(task, runId, turnId, 'turn.outputNormalized', {
              originalLength: finalTextRaw.length, normalizedLength: finalText.length,
              visibleTextLength: appended?.visibleText.length??finalText.length,
              rule: appended!=null
                ? 'separate-valid-appended-taskcomplete; same strict schema/resultKey after'
                : 'strip-single-fence-wrapping-entire-text; same strict schema after',
            });
          }
          const planningRun=this.db.prepare("SELECT 1 FROM coordination_runs WHERE run_id=? AND state='planning'").get(runId);
          if(contract.ok && planningRun) {
            const proposed=taskCompleteSchema.parse(JSON.parse(finalText)).coordinationPlan;
            if(proposed)try{validatePlanForRun(this.db,task.id,runId,proposed);}catch(error){contract={ok:false,issues:[String(error)]};}
          }
          if(contract.ok){const result=taskCompleteSchema.parse(JSON.parse(finalText));if(result.handoffs?.length)try{validateMemberHandoffs(this.db,task.id,runId,turnId,result.handoffs,Boolean(result.coordinationPlan));}catch(error){contract={ok:false,issues:[String(error)]};}}
          const naturalText=finalTextRaw.trim();
          const integrationRun=this.db.prepare('SELECT 1 FROM coordination_runs WHERE integration_run_id=?').get(runId);
          const ordinaryReplyRequest=this.db.prepare(`SELECT 1 FROM conversation_reply_requests WHERE (run_id=? OR turn_id=?) AND status='running'
            UNION ALL SELECT 1 FROM thread_reply_requests WHERE (run_id=? OR turn_id=?) AND status='running' LIMIT 1`).get(runId,turnId,runId,turnId);
          const naturalOrdinaryReply=!contract.ok&&!planningRun&&!integrationRun&&messageControl==null&&!explicitTerminalControl
            &&(explicitRecipientChild(this.db,task.id)||ordinaryReplyRequest!=null)
            &&naturalText.length>0&&!/^[{[]/.test(naturalText)&&!/task-complete-v1|schemaVersion|resultKey/i.test(naturalText);
          if(naturalOrdinaryReply){
            const successfulWriteActions=(this.db.prepare(`SELECT count(*) n FROM domain_events started JOIN domain_events completed
              ON completed.turn_id=started.turn_id AND completed.kind='tool.completed'
              AND json_extract(completed.payload_json,'$.toolCallId')=json_extract(started.payload_json,'$.toolCallId')
              WHERE started.turn_id=? AND started.kind='tool.started'
              AND json_extract(started.payload_json,'$.toolName') IN ('Write','Edit','MultiEdit','NotebookEdit','fileChange')
              AND json_extract(completed.payload_json,'$.outcome')='success'`).get(turnId) as {n:number}).n;
            const changesetId=this.kvGet(`write-changeset:${turnId}`);
            const changes=changesetId?finalizeChangeset(this.db,{changeSetId:changesetId,appDataDir:this.appDataDir}):null;
            const changedFiles=changes?.ok?changes.value.diff.added.length+changes.value.diff.removed.length+changes.value.diff.modified.length:0;
            if(successfulWriteActions===0&&changedFiles===0){
              const previousWork=(this.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(task.id) as {n:number}).n;
              this.casTurn(turnId,'SUCCEEDED');
              this.db.prepare(`UPDATE workflow_runs SET status='SUCCEEDED' WHERE id=?`).run(runId);
              this.settleBudget(runId);
              this.audit(task,runId,turnId,'turn.outputNaturalConversation',{
                rawLength:naturalText.length,
                rule:'explicit-recipient-or-ordinary-chat-natural-output; no write evidence; no TaskComplete fabricated',
              });
              if(previousWork>0){
                this.db.prepare("UPDATE tasks SET response_kind='work' WHERE id=?").run(task.id);
                const request=this.db.prepare('SELECT 1 FROM thread_reply_requests WHERE turn_id=?').get(turnId);
                const currentDelivery=request?this.db.prepare('SELECT d.review_status FROM tasks t JOIN task_deliveries d ON d.id=t.current_delivery_id WHERE t.id=?').get(task.id) as {review_status:string}|undefined:undefined;
                this.transitionTask(task.id,request&&currentDelivery?(currentDelivery.review_status==='pending'?'REVIEW':['accepted','not_required'].includes(currentDelivery.review_status)?'DONE':currentDelivery.review_status==='changes_requested'?'ACTIVE':'WAITING_USER'):'WAITING_USER');
                this.audit(task,runId,turnId,'turn.workClarification',{note:'普通追问按自然正文回答；旧交付保持'});
                this.audit(task,runId,turnId,'turn.statusChanged',{status:'SUCCEEDED',responseKind:'conversation',note:'工作待补充，旧交付保持；没有产生新交付'});
              }else{
                this.db.prepare("UPDATE tasks SET response_kind='conversation' WHERE id=?").run(task.id);
                const pendingConversation=(this.db.prepare("SELECT (SELECT count(*) FROM conversation_reply_requests WHERE task_id=? AND status='queued')+(SELECT count(*) FROM thread_reply_requests WHERE task_id=? AND status='queued') n").get(task.id,task.id) as {n:number}).n;
                this.transitionTask(task.id,pendingConversation?'ACTIVE':'DONE');
                this.audit(task,runId,turnId,'turn.statusChanged',{status:'SUCCEEDED',responseKind:'conversation',note:'普通问答按自然正文完成；没有工作交付或验收待办'});
              }
              return;
            }
          }
          if (!contract.ok) {
            this.casTurn(turnId, 'FAILED');
            this.db.prepare(`UPDATE workflow_runs SET status = 'FAILED' WHERE id = ?`).run(runId);
            this.settleBudget(runId);
            this.db.prepare("UPDATE coordination_runs SET state='blocked',error_message=? WHERE run_id=? AND state='planning'").run(contract.issues.join('; '),runId);
            // 修复轮判定=本 turn 被修复工作项消费（结构化绑定——普通 redispatch 不受影响）。
            const isRepairTurn = (this.db.prepare(`SELECT count(*) c FROM format_repair_workitems WHERE consumed_turn_id = ?`).get(turnId) as { c: number }).c > 0;
            if (isRepairTurn || planningRun) {
              this.transitionTask(task.id, 'BLOCKED');
              this.audit(task, runId, turnId, 'task.statusChanged', { status: 'BLOCKED', reason: 'direct-repair-exhausted' });
            } else {
              this.transitionTask(task.id, 'ACTIVE');
            }
            this.audit(task, runId, turnId, 'turn.outputInvalid', {
              issues: contract.issues,
              rawLength: finalTextRaw.length,
            });
            return;
          }
          this.casTurn(turnId, 'SUCCEEDED');
          this.db.prepare(`UPDATE workflow_runs SET status = 'SUCCEEDED' WHERE id = ?`).run(runId);
          this.settleBudget(runId);
          // 旧 run 迟到输出不覆盖新 run 结果（第八轮）：任务已有**更晚创建的 run** 的交付
          // （修复轮/redispatch 已完成）时，本输出收口事实（SUCCEEDED+结算）但不交付、不迁
          // 移任务状态——用户可见结果保持最新交付，迟到材料以审计留痕（不自动重跑、不伪造
          // 覆盖）。
          // 第十轮修正：判定按 run 创建先后（rowid）而非「存在任何其他 run 的交付」——返工
          // 第二轮（新 run）不能被旧 run 的 v1 交付挡住：旧交付属于更早的 run，不是「更新
          // 交付」，新输出应正常递增 revision 再交付（§10.5-5）。
          const newerDeliveries = (this.db
            .prepare(
              `SELECT count(*) c FROM task_deliveries d
               JOIN workflow_runs r ON r.id = d.run_id
               WHERE d.task_id = ? AND d.run_id != ?
                 AND r.rowid > (SELECT rowid FROM workflow_runs WHERE id = ?)`,
            )
            .get(task.id, runId, runId) as { c: number }).c;
          if (newerDeliveries > 0) {
            this.audit(task, runId, turnId, 'turn.lateCompletionSuperseded', {
              note: '旧 run 的迟到输出：任务已有更晚 run 的交付——不覆盖新结果，材料留痕',
              finalText: (event.finalText ?? '').slice(0, 400),
              newerDeliveryCount: newerDeliveries,
            });
            return;
          }
          // 交付与验收（§10.5）：按任务快照策略收尾；user_review 进 REVIEW + pending 交付（唯一待办）。
          // 追加 turn 的再交付：revision 递增、旧 pending 标 superseded（§10.5-5 替换当前待办）。
          const result=taskCompleteSchema.parse(JSON.parse(finalText));
          // R93: planning (coordinationPlan/handoffs) also needs its visible answer
          // and complete detail bound before any downstream child/queue is created.
          this.ensureStructuredFinalReply(task, turnId, finalText, result);
          if (Object.prototype.hasOwnProperty.call(result, 'document')) this.bindDocument(task, runId, turnId, result);
          else this.bindDetailMarkdown(task, runId, turnId, result);
          if(result.handoffs?.length){
            const messages=acceptMemberHandoffs(this.db,task.id,runId,turnId,result.handoffs);
            for(const message of messages){const recipient=this.db.prepare('SELECT display_name FROM project_members WHERE id=?').get(message.toMemberId) as {display_name:string};this.insertThreadReply(task,turnId,message.id,`给 ${recipient.display_name}：\n${message.text}`);}
            if(planningRun)return;
          }
          if(planningRun && result.coordinationPlan) {
            acceptCoordinationPlan(this.db,task.id,runId,result.coordinationPlan);
            return;
          }
          if(planningRun)this.db.prepare("UPDATE coordination_runs SET state='completed' WHERE run_id=?").run(runId);
          // Read/calculation commands and rejected write attempts are not proof of
          // a work result. Capture actual project differences before deciding;
          // model-declared work retains its formal work/verification contract.
          const changesetId=this.kvGet(`write-changeset:${turnId}`);
          const changes=changesetId?finalizeChangeset(this.db,{changeSetId:changesetId,appDataDir:this.appDataDir}):null;
          const changedFiles=changes?.ok?changes.value.diff.added.length+changes.value.diff.removed.length+changes.value.diff.modified.length:0;
          const successfulWriteActions=(this.db.prepare(`SELECT count(*) n FROM domain_events started JOIN domain_events completed
            ON completed.turn_id=started.turn_id AND completed.kind='tool.completed'
            AND json_extract(completed.payload_json,'$.toolCallId')=json_extract(started.payload_json,'$.toolCallId')
            WHERE started.turn_id=? AND started.kind='tool.started'
            AND json_extract(started.payload_json,'$.toolName') IN ('Write','Edit','MultiEdit','NotebookEdit','fileChange')
            AND json_extract(completed.payload_json,'$.outcome')='success'`).get(turnId) as {n:number}).n;
          const previousWork=(this.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(task.id) as {n:number}).n;
          // 成功合同已确认、任务身份在本 turn 内：记录候选（正式结果 .files + 本 turn 已验证差异）。
          snapshotRef.current = { files: [...result.files], diff: changes?.ok ? { added: [...changes.value.diff.added], modified: [...changes.value.diff.modified] } : null };
          if(result.responseKind==='conversation'&&changedFiles===0&&successfulWriteActions===0
            &&(!childCoordination(this.db,task.id)||explicitRecipientChild(this.db,task.id))&&!integrationRun) {
            if(previousWork>0){
              this.db.prepare("UPDATE tasks SET response_kind='work' WHERE id=?").run(task.id);
              // A clarification is an answer, not a replacement delivery or an
              // acceptance. Preserve the existing version and its review state.
              const request=this.db.prepare('SELECT 1 FROM thread_reply_requests WHERE turn_id=?').get(turnId);
              const currentDelivery=request?this.db.prepare('SELECT d.review_status FROM tasks t JOIN task_deliveries d ON d.id=t.current_delivery_id WHERE t.id=?').get(task.id) as {review_status:string}|undefined:undefined;
              this.transitionTask(task.id,request&&currentDelivery?(currentDelivery.review_status==='pending'?'REVIEW':['accepted','not_required'].includes(currentDelivery.review_status)?'DONE':currentDelivery.review_status==='changes_requested'?'ACTIVE':'WAITING_USER'):'WAITING_USER');
              this.audit(task,runId,turnId,'turn.workClarification',{note:'等待明确补充后执行；旧交付保持'});
              this.audit(task,runId,turnId,'turn.statusChanged',{status:'SUCCEEDED',responseKind:'conversation',note:'工作待补充，旧交付保持；没有产生新交付'});
              return;
            }
            this.db.prepare("UPDATE tasks SET response_kind='conversation' WHERE id=?").run(task.id);
            const pendingConversation=(this.db.prepare("SELECT (SELECT count(*) FROM conversation_reply_requests WHERE task_id=? AND status='queued')+(SELECT count(*) FROM thread_reply_requests WHERE task_id=? AND status='queued') n").get(task.id,task.id) as {n:number}).n;
            this.transitionTask(task.id,pendingConversation?'ACTIVE':'DONE');
            this.audit(task,runId,turnId,'turn.statusChanged',{status:'SUCCEEDED',responseKind:'conversation',note:'正常回答，无工作交付与验收待办'});
            return;
          }
          if(result.responseKind==='conversation')this.audit(task,runId,turnId,'turn.conversationWorkObserved',{changedFiles,successfulWriteActions,trackingScope:'仅当前项目基线；成功写工具可能在范围外',changeSetId:changesetId,workBasis:childCoordination(this.db,task.id)||integrationRun?'coordination-output':changedFiles>0?'project-diff':'write-tool',note:childCoordination(this.db,task.id)||integrationRun?'按正式协作步骤保存答复成果；不据此声称修改文件，原协议不改写':changedFiles>0?'实际项目文件差异已发生，保留工作交付；原协议不改写':'检测到成功写工具，保留工作交付；不据此声称存在项目内文件差异'});
          this.db.prepare("UPDATE tasks SET response_kind='work' WHERE id=?").run(task.id);
          const collaboration=coordinationDeliveryRefs(this.db,runId);
          const manifestHash = createHash('sha256').update(collaboration?JSON.stringify({finalText,collaboration}):finalText).digest('hex');
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
             VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
          ).run(deliveryId, task.id, runId, prevRevision + 1, manifestHash, JSON.stringify([`turn:${turnId}:final`,...(collaboration?.artifactRefs??[])]), JSON.stringify([...new Set([...(this.kvGet(`write-changeset:${turnId}`)?[this.kvGet(`write-changeset:${turnId}`)]:[]),...(collaboration?.changeSetRefs??[])])]), reviewStatus);
          this.db.prepare('UPDATE tasks SET current_delivery_id = ? WHERE id = ?').run(deliveryId, task.id);
          this.transitionTask(task.id, task.review_policy === 'user_review' ? 'REVIEW' : 'DONE');
          const parentCoordination=this.db.prepare("SELECT run_id FROM coordination_runs WHERE integration_run_id=? AND state='integrating'").get(runId) as {run_id:string}|undefined;
          if(parentCoordination){
            this.db.prepare("UPDATE coordination_runs SET state='completed' WHERE run_id=?").run(parentCoordination.run_id);
            this.db.prepare("UPDATE workflow_runs SET status='SUCCEEDED',stage='整合完成' WHERE id=?").run(parentCoordination.run_id);
          }
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'SUCCEEDED', reviewStatus, deliveryRevision: prevRevision + 1 });
        });
        tx();
        // 生成文件快照在事务提交后、后台步骤中执行（见 snapshotCompletedFiles）：文件读取/复制
        // 不阻塞关键事务；失败只产生可读状态，绝不回滚已成功的聊天/交付。
        if (snapshotRef.current != null) {
          this.kvSet(`final-files:${turnId}`, JSON.stringify(snapshotRef.current.files));
          this.kvSet(`turn-diff:${turnId}`, JSON.stringify(snapshotRef.current.diff));
        }
        settleThreadReplyForTurn(this.db,turnId,'SUCCEEDED');
        const actualTurn=this.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(turnId) as {status:string};
        settleMemberMessageTurn(this.db,task.id,turnId,actualTurn.status);
        break;
      }
      case 'turn.failed': {
        // 用户停止判定（与 DELIB 口径一致；第二十七轮五快照化）：INTERRUPTED + 停止代次
        // **超越本 turn 快照**/任务已 CANCELLED/本 run STOPPING。历史代次（==快照）不算——
        // 否则停止结算后的新 turn 被 deadline 中断时误判为用户停止（实际是结果不确定，须 UNKNOWN
        // 收尾不伪造取消）。无用户停止的 INTERRUPTED=单轮截止中断——结果不确定（请求可能已
        // 发出），UNKNOWN 收尾，不伪造取消/失败。
        const taskNowStop = this.db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(task.id) as { stop_generation: number; status: string } | undefined;
        const gen0f = (this.db.prepare('SELECT stop_generation_snapshot AS g FROM agent_turns WHERE id = ?').get(turnId) as { g: number } | undefined)?.g ?? -1;
        const runStopping = (this.db.prepare('SELECT status AS s FROM workflow_runs WHERE id = ?').get(runId) as { s: string } | undefined)?.s === 'STOPPING';
        const userStop = event.code === 'INTERRUPTED' && (runStopping
          || (taskNowStop != null && (taskNowStop.status === 'CANCELLED' || (gen0f >= 0 ? taskNowStop.stop_generation > gen0f : taskNowStop.stop_generation > 0))));
        if (event.code === 'INTERRUPTED' && !userStop) {
          this.settleUnknown(task, runId, turnId, 'turn-deadline-interrupt');
          break;
        }
        const tx = this.db.transaction(() => {
          const interrupted = userStop;
          this.casTurn(turnId, interrupted ? 'CANCELLED' : 'FAILED');
          settleConversationReplyForTurn(this.db,turnId,interrupted?'CANCELLED':'FAILED',event.message);
          settleThreadReplyForTurn(this.db,turnId,interrupted?'CANCELLED':'FAILED',event.message);
          settleMemberMessageTurn(this.db,task.id,turnId,interrupted?'CANCELLED':'FAILED',event.message);
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

  /** 迟到泵结果（recovery.pumpLateEvents 返回面；unsupported 各态如实标注）。 */
  async pumpLateEventsForTurn(turnId: string): Promise<{
    status: 'pumped' | 'not-found' | 'not-unknown' | 'unsupported-mode' | 'no-session' | 'unsupported';
    turnStatus?: string;
    reason?: string;
    applied?: Array<{ eventKey: string; outcome: string }>;
  }> {
    const turn = this.db
      .prepare('SELECT id, run_id, member_id, stage_key, status, session_id FROM agent_turns WHERE id = ?')
      .get(turnId) as { id: string; run_id: string; member_id: string; stage_key: string; status: string; session_id: string | null } | undefined;
    if (turn == null) return { status: 'not-found' };
    if (turn.stage_key.startsWith('delib.')) {
      return { status: 'unsupported-mode', reason: '研讨轮 UNKNOWN=成员缺席语义（E4）：迟到输出收口不在本轮处理范围' };
    }
    if (turn.status !== 'UNKNOWN') {
      // 已收口 turn 的迟到材料：留痕不生效（refunded 冲突提示走 correctToExecuted 纠正）。
      try {
        const run0 = this.db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get(turn.run_id) as { task_id: string } | undefined;
        const task0 = run0 != null ? this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(run0.task_id) as TaskRow | undefined : undefined;
        const mark = (this.db.prepare('SELECT budget_mark FROM agent_turns WHERE id = ?').get(turnId) as { budget_mark: string | null }).budget_mark;
        const adapter0 = this.adapterOf(turn.member_id);
        if (task0 != null && adapter0.lateEvents != null && turn.session_id != null) {
          const pulled0 = await adapter0.lateEvents({ id: turn.session_id }, turnId);
          if (pulled0.supported) {
            for (const e of pulled0.events) {
              if (e.kind === 'turn.completed') {
                this.audit(task0, turn.run_id, turnId, 'turn.lateCompletion', {
                  turnStatus: turn.status,
                  finalText: (e.finalText ?? '').slice(0, 200),
                  factConflictHint: mark === 'refunded' ? 'refunded-turn-received-output——与「未启动」声明矛盾，走 recovery.correctToExecuted 纠正' : null,
                });
              }
            }
          }
        }
      } catch { /* 留痕尽力而为 */ }
      return { status: 'not-unknown', turnStatus: turn.status };
    }
    // 会话定位：turn 启动时写入 session_id；旧数据回退最近同任务会话记录。
    let sessionId = turn.session_id;
    if (sessionId == null) {
      const run = this.db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get(turn.run_id) as { task_id: string } | undefined;
      const taskRow = run != null ? this.db.prepare('SELECT conversation_thread_id FROM tasks WHERE id = ?').get(run.task_id) as { conversation_thread_id: string } | undefined : undefined;
      if (run != null && taskRow != null) {
        sessionId = (this.db
          .prepare('SELECT id FROM runtime_sessions WHERE task_id = ? AND thread_id = ? ORDER BY rowid DESC LIMIT 1')
          .get(run.task_id, taskRow.conversation_thread_id) as { id: string } | undefined)?.id ?? null;
      }
    }
    if (sessionId == null) return { status: 'no-session', reason: '该 turn 无会话记录（无法定位 runtime 通道）' };
    const adapter = this.adapterOf(turn.member_id);
    if (adapter.lateEvents == null) {
      return { status: 'unsupported', reason: '该 runtime 未实现迟到事件回放（lateEvents）——真实 CLI 会话文件接入待补证，如实标注' };
    }
    const pulled = await adapter.lateEvents({ id: sessionId }, turnId);
    if (!pulled.supported) return { status: 'unsupported', reason: pulled.reason };

    const run = this.db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get(turn.run_id) as { task_id: string };
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(run.task_id) as TaskRow;
    // 回执作用域键（第九轮）：adapter kind+会话——eventKey 不跨事件源全局唯一。
    const sourceScope = `${this.providerKeyOf(turn.member_id)}:${sessionId}`;
    const receiptSeen = this.db.prepare(
      'SELECT outcome FROM late_event_receipts WHERE source_scope = ? AND turn_id = ? AND event_key = ?',
    );
    const recordReceipt = this.db.prepare(
      'INSERT INTO late_event_receipts (source_scope, turn_id, event_key, outcome, note, received_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const applied: Array<{ eventKey: string; outcome: string }> = [];
    for (const event of pulled.events) {
      const seen = receiptSeen.get(sourceScope, turnId, event.eventKey) as { outcome: string } | undefined;
      if (seen != null) {
        // 已处理（applied/ignored）——效果已生效，跳过（「回执已存在」只表示**已处理完成**，
        // 处理失败的事务整体回滚、回执不残留——不存在「有回执无效果」状态）。
        applied.push({ eventKey: event.eventKey, outcome: `duplicate-${seen.outcome}` });
        continue;
      }
      // 归属校验（第九轮）：不替未归属事件强行认领——事件须声明且匹配本 turn/本会话。
      if ((event.turnId != null && event.turnId !== turnId) || (event.sessionId != null && event.sessionId !== sessionId)) {
        const tx = this.db.transaction(() => {
          recordReceipt.run(sourceScope, turnId, event.eventKey, 'ignored', `归属不符：event.turnId=${event.turnId ?? 'null'} sessionId=${event.sessionId ?? 'null'}`, this.clock());
          this.audit(task, turn.run_id, turnId, 'turn.lateEventIgnored', { eventKey: event.eventKey, kind: event.kind, reason: 'wrong-attribution' });
        });
        tx();
        applied.push({ eventKey: event.eventKey, outcome: 'ignored-wrong-attribution' });
        continue;
      }
      if (event.kind !== 'turn.completed' && event.kind !== 'turn.failed') {
        const tx = this.db.transaction(() => {
          recordReceipt.run(sourceScope, turnId, event.eventKey, 'ignored', '非终态事件不在泵范围', this.clock());
        });
        tx();
        applied.push({ eventKey: event.eventKey, outcome: 'ignored-non-terminal' });
        continue;
      }
      const fresh = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
      if (fresh.status !== 'UNKNOWN') {
        // 本轮已被前一个事件收口：后续事件回执（ignored）+审计，同一事务。
        const tx = this.db.transaction(() => {
          recordReceipt.run(sourceScope, turnId, event.eventKey, 'ignored', `turn 已 ${fresh.status}`, this.clock());
          this.audit(task, turn.run_id, turnId, 'turn.lateEventSkippedTerminal', { eventKey: event.eventKey, kind: event.kind, turnStatus: fresh.status });
        });
        tx();
        applied.push({ eventKey: event.eventKey, outcome: 'skipped-terminal' });
        continue;
      }
      if (event.kind === 'turn.failed' && event.code === 'INTERRUPTED') {
        // 迟到的中断回执不是结果事实（用户停止语义由 stop 状态机承载）——不收口。
        const tx = this.db.transaction(() => {
          recordReceipt.run(sourceScope, turnId, event.eventKey, 'ignored', '迟到的中断回执不是结果事实', this.clock());
        });
        tx();
        applied.push({ eventKey: event.eventKey, outcome: 'skipped-interrupt-receipt' });
        continue;
      }
      // 回执+业务效果**同一事务**（第九轮）：applyEvent 抛错=整体回滚（无回执残留）——
      // 重放重新处理，交付/预算恰好一次；失败留审计（事务外），可恢复不静默丢弃。
      try {
        const tx = this.db.transaction(() => {
          recordReceipt.run(sourceScope, turnId, event.eventKey, 'applied', null, this.clock());
          this.applyEvent(task, turn.run_id, turnId, event);
        });
        tx();
        applied.push({ eventKey: event.eventKey, outcome: 'applied' });
      } catch (error) {
        this.audit(task, turn.run_id, turnId, 'turn.lateEventFailed', {
          eventKey: event.eventKey,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          note: '回执与业务效果同事务整体回滚——重放将重新处理（不静默丢弃）',
        });
        applied.push({ eventKey: event.eventKey, outcome: 'failed' });
      }
    }
    // 业务收口（turn 终态）：释放准入占位与进程登记收口。**写入租约不随之释放**——业务
    // 结果已确定与执行载体已停止是不同事实（第九轮二）：保护解除仍走 probe/releaseProtection
    // 判定（none 程序事实可解除；有子进程模型路径已关闭）。
    const after = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
    if (after.status !== 'UNKNOWN') {
      this.releaseAdmission(turnId);
      this.closeProcessRegistrationIfTerminal(turnId);
      this.audit(task, turn.run_id, turnId, 'turn.lateEventsSettled', {
        turnStatus: after.status,
        events: applied,
        note: '写入租约保护不随业务收口解除——仍按进程保护判定处理（业务结果确定≠执行载体已停止）',
      });
    }
    return { status: 'pumped', applied };
  }

  /** DELIBERATE 终态：完成→产物校验计入屏障（或一次格式修复）；失败/中断→缺席或停止语义。 */
  private applyDeliberationTerminal(task: TaskRow, runId: string, turnId: string, dispatchKey: string, event: NormalizedRuntimeEvent): void {
    const baseStep = parseRepairTarget(dispatchKey) ?? parseDelibStep(dispatchKey);
    if (event.kind === 'turn.completed') {
      const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
      if (turn.status === 'STOPPING') {
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'CANCELLED');
          this.settleDelibBudget(runId);
          settleStoppedDeliberation(this.db,task.id,runId);
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
        options: this.deliberationOptions(task.project_id),
      });
      if (!out.ok) {
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'FAILED');
          this.settleDelibBudget(runId);
          this.db.prepare("UPDATE run_participants SET status = 'failed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, baseStep.memberId);
          this.audit(task, runId, turnId, 'run.stepFailed', { stage: baseStep.stage, message: out.error.message });
        });
        tx();
        pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
        return;
      }
      if (out.value.counted) {
        const stageMessageId=`msg_delib_${runId}_${baseStep.stage}_${baseStep.memberId}_${baseStep.roundNo}`;
        if(this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(stageMessageId))this.kvSet(`final-message:${turnId}`,stageMessageId);
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'SUCCEEDED');
          this.settleDelibBudget(runId);
          this.audit(task, runId, turnId, 'run.stepArtifact', { stage: baseStep.stage, memberId: baseStep.memberId, roundNo: baseStep.roundNo });
        });
        tx();
        pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
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
        pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
        return;
      }
      const repairKey = repairDispatchKey(baseStep);
      const repairTurn = this.db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(repairKey) as { id: string } | undefined;
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, 'FAILED');
        this.settleDelibBudget(runId);
        if (repairTurn == null) {
          this.kvSet(`delib:repair:${repairKey}`, out.value.needsRepair ?? '格式无效');
          this.db.prepare('INSERT INTO outbox (dispatch_key, stop_generation_at_enqueue) VALUES (?, ?)').run(repairKey, task.stop_generation); // 意图入队代次（迁移 034）
          this.audit(task, runId, turnId, 'turn.outputInvalid', { issues: [out.value.needsRepair ?? ''], repairEnqueued: repairKey });
        } else {
          this.db.prepare("UPDATE run_participants SET status = 'failed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, baseStep.memberId);
          this.audit(task, runId, turnId, 'turn.outputInvalid', { issues: [out.value.needsRepair ?? ''], repairExhausted: true });
        }
      });
      tx();
      pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
      return;
    }
    if (event.kind === 'turn.failed') {
      const taskNow = this.db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(task.id) as { stop_generation: number; status: string } | undefined;
      const runNow = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string } | undefined;
      // 用户停止 = 停止代次**超越本 turn 快照**（第二十七轮五快照化——历史代次不算，否则
      // 停止结算后的新 turn 被 deadline 中断时误判用户停止）或 run 已 STOPPING；否则
      // INTERRUPTED 是单轮截止中断（取证轮确认的误判源）——成员级缺席，运行继续。
      const gen0d = (this.db.prepare('SELECT stop_generation_snapshot AS g FROM agent_turns WHERE id = ?').get(turnId) as { g: number } | undefined)?.g ?? -1;
      const userStop = event.code === 'INTERRUPTED' && (runNow?.status === 'STOPPING'
        || (taskNow != null && (taskNow.status === 'CANCELLED' || (gen0d >= 0 ? taskNow.stop_generation > gen0d : taskNow.stop_generation > 0))));
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, userStop ? 'CANCELLED' : 'FAILED');
        this.settleDelibBudget(runId);
        if (userStop) {
          settleStoppedDeliberation(this.db,task.id,runId);
        } else if (baseStep != null) {
          this.db.prepare("UPDATE run_participants SET status = ? WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')")
            .run(event.code === 'INTERRUPTED' ? 'absent' : 'failed', runId, baseStep.memberId);
        }
        this.audit(task, runId, turnId, 'turn.statusChanged', { status: userStop ? 'CANCELLED' : 'FAILED', code: event.code, message: event.message, source: userStop ? 'user-stop' : 'member-terminal' });
      });
      tx();
      if (!userStop) pumpDeliberation(this.db, task.id, this.deliberationOptions(task.project_id));
      return;
    }
    if (event.kind === 'usage.updated') {
      this.db.prepare(
        `INSERT INTO usage_records (turn_id, provider_event_id, reported_json, normalized_json, cost_quality)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (turn_id, provider_event_id) DO NOTHING`,
      ).run(turnId, event.eventKey, JSON.stringify(event), JSON.stringify(event), event.costQuality);
      recordRealCallUsage(this.db,turnId,event);
    }
    if(event.kind==='tool.started')this.audit(task,runId,turnId,'tool.started',{toolCallId:event.toolCallId,toolName:event.toolName,eventKey:event.eventKey});
    if(event.kind==='tool.completed')this.audit(task,runId,turnId,'tool.completed',{toolCallId:event.toolCallId,outcome:event.outcome,eventKey:event.eventKey});
    if(event.kind==='session.ready'&&event.providerSessionId)this.db.prepare('UPDATE runtime_sessions SET provider_session_id=? WHERE id=? AND task_id=?').run(event.providerSessionId,event.sessionId,task.id);
  }

  /** 全局默认 runtime kind（未绑定成员回落；ZS_RUNTIME 归一——fake 限开发模式）。 */
  private defaultKindOf(): 'fake' | 'codex' | 'claude' | null {
    const raw = process.env.ZS_RUNTIME;
    return raw === 'codex' || raw === 'claude' || raw === 'fake' ? raw : null;
  }

  /** DM 会话终态结算（第二十轮二）：turnId → 会话身份待结算（终态时 provider 已实际上报）。 */
  private readonly dmPending = new Map<string, { task: TaskRow; session: SessionRef; resumeRef?: SessionRef; bindingSnap: string; cwd: string; generation: number; memberId: string; turnRequested: boolean }>();

  /**
   * DM 会话身份终态结算：以 provider 实际上报的 session_id（adapter 在 init/result 事件中原地
   * 回填 session.providerSessionId）为唯一身份事实——
   * - 无 resume：插首开会话行（provider id=上报值；空串归一 null）+ dm.sessionOpened；
   * - resume 请求 X 且上报==X：原生续接（不插行；回填候选行 provider id）+ dm.sessionResumed；
   * - resume 请求 X 且上报≠X/未上报：受限历史重放（插新行）+ dm.sessionReplayed（不冒充续接；
   *   provider 未上报时行 id 留空、不污染候选——下一轮不会拿空串 resume）。
   * - 同轮多个不同非空上报（observedSessionIds>1）：协议异常——不取任何单值冒充原生续接（即便
   *   最后值恰等于 resume 请求），按重放落新行（id=最后上报）+ dm.sessionIdentityConflict 如实。
   * - turn 从未请求（会话打开窗口取消）：无 provider 接触——立即释放 pending + 审计（不泄漏）。
   * 幂等：每 turn 一次（daemon_state 键）；结算失败保留 pending，由 retryFailedDmSettlements
   *（每次终态后）与启动扫描 recoverAbandonedDmVerdicts（重启处理）明确重试/收案。
   */
  private settleDmSession(turnId: string): void {
    const pending = this.dmPending.get(turnId);
    if (pending == null) return;
    const key = `dm:sessionverdict:${turnId}`;
    if (this.db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(key) != null) {
      this.dmPending.delete(turnId); // 已结算（幂等重入）——清理登记
      return;
    }
    const { task, session, resumeRef, bindingSnap, cwd, generation, memberId } = pending;
    if (!pending.turnRequested) {
      // turn 从未请求（会话打开窗口被停止/取消）：无 provider 接触——不落会话行、不发判定事件
      //（下一次派发重新按首开/续接候选处理）；及时释放 pending（第二十二轮三——此前 return 不删
      // = Map 泄漏+重启扫描误判失败待重试）。
      this.dmPending.delete(turnId);
      this.audit(task, null, turnId, 'dm.sessionPendingReleased', {
        conversationId: task.conversation_id, memberId,
        note: 'turn 从未交给 runtime（会话打开窗口取消）——无身份结算，pending 已释放',
      });
      return;
    }
    const raw = (session.providerSessionId ?? '').trim();
    const reported = raw.length > 0 ? raw : null;
    const observedDistinct = [...new Set((session.observedSessionIds ?? []).map((x) => x.trim()).filter((x) => x.length > 0))];
    const identityConflict = observedDistinct.length > 1;
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify({ reported, observed: observedDistinct, resumed: resumeRef?.providerSessionId ?? null, identityConflict }), Date.now());
      if (identityConflict) {
        // 协议异常（第二十二轮三）：同轮 provider 报了多个不同身份——不可判定哪个真实；
        // 按重放落新行（provider id=最后上报值），绝不因最后值==resume 请求而声称原生续接。
        this.db.prepare(
          `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd, provider_session_id, capabilities_json)
           VALUES (?, ?, ?, 'dm', NULL, ?, NULL, ?, ?, ?, ?)`,
        ).run(session.id, task.project_id, task.conversation_id, memberId, generation, cwd, reported, bindingSnap);
        this.audit(task, null, turnId, 'dm.sessionIdentityConflict', {
          conversationId: task.conversation_id, resumeRequested: resumeRef?.providerSessionId ?? null,
          observedSessionIds: observedDistinct, lastReported: reported, nativeResume: false,
          note: '同轮 provider 上报多个不同 session_id（协议异常）——按受限重放落行，不冒充原生续接',
        });
        return;
      }
      if (resumeRef == null) {
        this.db.prepare(
          `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd, provider_session_id, capabilities_json)
           VALUES (?, ?, ?, 'dm', NULL, ?, NULL, ?, ?, ?, ?)`,
        ).run(session.id, task.project_id, task.conversation_id, memberId, generation, cwd, reported, bindingSnap);
        this.audit(task, null, turnId, 'dm.sessionOpened', { conversationId: task.conversation_id, providerSessionId: reported, note: reported != null ? '会话首开（provider 身份已上报并持久化）' : '会话首开（provider 未上报身份——行 id 留空，不作续接候选）' });
        return;
      }
      if (reported === resumeRef.providerSessionId) {
        // 原生续接：回填候选行（身份不变；capabilities 快照刷新为当前绑定）。
        this.db.prepare(
          "UPDATE runtime_sessions SET provider_session_id = ?, capabilities_json = ? WHERE id = ? AND scope_kind = 'dm'",
        ).run(reported, bindingSnap, resumeRef.id);
        this.audit(task, null, turnId, 'dm.sessionResumed', { conversationId: task.conversation_id, resumeRequested: resumeRef.providerSessionId, providerReported: reported, nativeResume: true, note: '同对话原生续接：resume 请求与 provider 上报身份一致' });
        return;
      }
      // 受限历史重放（provider 新会话/拒绝续接/未上报）。
      this.db.prepare(
        `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd, provider_session_id, capabilities_json)
         VALUES (?, ?, ?, 'dm', NULL, ?, NULL, ?, ?, ?, ?)`,
      ).run(session.id, task.project_id, task.conversation_id, memberId, generation, cwd, reported, bindingSnap);
      this.audit(task, null, turnId, 'dm.sessionReplayed', {
        conversationId: task.conversation_id, resumeRequested: resumeRef.providerSessionId, providerReported: reported,
        nativeResume: false,
        note: reported != null ? '受限历史重放：provider 换新会话（续接未被接受）——上下文经输入水位重放' : '受限历史重放：provider 未上报身份（续接结果不确定）——不回填候选',
      });
    });
    try {
      tx();
      this.dmPending.delete(turnId); // 结算成功才清理（第二十一轮三：失败保留 pending=可恢复，不静默丢失）
    } catch (error) {
      // 身份持久化失败=可诊断可恢复：留审计 + 保留 pending——由 retryFailedDmSettlements 明确重试
      //（每次任一 DM turn 终态后触发，不依赖同一终态偶然再来一次）。
      try {
        this.audit(pending.task, null, turnId, 'dm.sessionSettleFailed', {
          conversationId: pending.task.conversation_id, resumeRequested: pending.resumeRef?.providerSessionId ?? null,
          error: String(error instanceof Error ? error.message : error).slice(0, 160),
          note: '会话身份结算事务失败——保留待重试（pending 不清除；下次任一 DM 终态触发 retryFailedDmSettlements）',
        });
      } catch { /* 审计尽力而为 */ }
    }
  }

  /**
   * 失败结算的明确重试（第二十二轮三）：每次 DM turn 终态结算后调用——遍历 dmPending 中
   * 尚未结算的条目重试（幂等键保证已结算的跳过）。与"同一终态再来一次"的偶然性解耦。
   */
  private retryFailedDmSettlements(): void {
    for (const turnId of [...this.dmPending.keys()]) {
      try { this.settleDmSession(turnId); } catch { /* 单条失败不阻断其余重试（下轮终态再试） */ }
    }
  }

  /**
   * 重启处理（第二十二轮三）：启动时扫描「已终态的 dm_turn 但无结算键」的 turn——进程内
   * pending 身份已随进程丢失（无法恢复 provider 上报值），如实收案：落 abandoned 结算键
   *（占位防重复扫描）+审计说明；不虚构身份、不冒充已结算。候选行保持原状——下一轮派发按
   * 候选表处理，不丢失。
   */
  recoverAbandonedDmVerdicts(): void {
    const rows = this.db.prepare(
      `SELECT a.id AS turn_id, t.id AS task_id, t.project_id AS project_id, t.conversation_id AS conversation_id
       FROM agent_turns a
       JOIN workflow_runs r ON r.id = a.run_id
       JOIN tasks t ON t.id = r.task_id AND t.kind = 'dm_turn'
       WHERE a.status IN ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')
         AND NOT EXISTS (SELECT 1 FROM daemon_state ds WHERE ds.key = 'dm:sessionverdict:' || a.id)`,
    ).all() as Array<{ turn_id: string; task_id: string; project_id: string; conversation_id: string }>;
    for (const row of rows) {
      const key = `dm:sessionverdict:${row.turn_id}`;
      const tx = this.db.transaction(() => {
        this.db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify({ abandoned: true, reason: 'daemon-restart-before-settle' }), Date.now());
        this.audit({ id: row.task_id, project_id: row.project_id, conversation_id: row.conversation_id } as TaskRow, null, row.turn_id, 'dm.sessionSettleAbandoned', {
          conversationId: row.conversation_id, turnId: row.turn_id,
          note: 'daemon 在结算前重启：进程内 provider 身份不可恢复——按收案处理（不虚构身份）；候选行保持原状，下一轮派发按候选表处理',
        });
      });
      try { tx(); } catch { /* 收案失败下次启动再扫（幂等：已收案的不再命中） */ }
    }
  }

  /** DM 会话终态后的队列泵（DEV-22 串行）：run 状态已落定后调用——空闲则入队下一条排队消息。 */
  private pumpDmAfterTerminal(task: TaskRow): void {
    if (task.kind !== 'dm_turn') return;
    try { pumpDmQueue(this.db, task.conversation_id); } catch { /* 泵尽力而为（下一次终态/提交重试） */ }
  }

  private dmConversationOfTurn(turnId: string): string | null {
    const row = this.db.prepare(
      `SELECT t.conversation_id AS cid FROM tasks t JOIN workflow_runs r ON r.task_id = t.id JOIN agent_turns a ON a.run_id = r.id
       WHERE a.id = ? AND t.kind = 'dm_turn'`,
    ).get(turnId) as { cid: string } | undefined;
    return row?.cid ?? null;
  }

  /**
   * R91：结构化终态没有（或只有状态前缀的）message.completed 时，用已通过 schema/resultKey
   * 校验的 TaskComplete 生成**本轮最终可见回复**（消息 id 属于本轮命名空间），供文件卡绑定。
   * 只在成功交付/成功答复路径调用；不是把失败/停止输出转成成功消息。
   */
  /** R93: bind one complete Markdown detail before DONE; on failure keep the full text in the final message. */
  private bindDocument(task:TaskRow,runId:string,turnId:string,result:{document?:DocumentArtifact|null}):void{
    const document=result.document;
    if(document==null||document.markdown.trim().length===0)return;
    const finalMessageId=this.kvGet(`final-message:${turnId}`);
    const memberId=(this.db.prepare('SELECT member_id FROM agent_turns WHERE id=?').get(turnId) as {member_id:string}|undefined)?.member_id;
    if(memberId==null||finalMessageId==null)return;
    this.db.prepare(`UPDATE messages SET body_json=json_set(body_json,'$.document',json(?)) WHERE id=?`).run(JSON.stringify(document),finalMessageId);
    const outcome=persistDetailMarkdown({
      db:this.db,appDataDir:this.appDataDir,projectId:task.project_id,conversationId:task.conversation_id,
      threadId:task.conversation_thread_id,taskId:task.id,runId,turnId,messageId:finalMessageId,memberId,
      filename:document.filename,markdown:document.markdown,
    });
    if(outcome.status==='ready'){
      this.db.prepare(`UPDATE messages SET body_json=json_set(json_remove(body_json,'$.document.markdown'),'$.document.artifactId',?) WHERE id=?`).run(outcome.artifactId,finalMessageId);
      this.audit(task,runId,turnId,'turn.document',{status:'ready',artifactId:outcome.artifactId,attachmentId:outcome.attachmentId,filename:outcome.filename,hash:outcome.hash,bytes:outcome.bytes,reused:outcome.reused});
      return;
    }
    this.audit(task,runId,turnId,'turn.document',{status:'inline-fallback',code:outcome.status==='too-large'?'TOO_LARGE':outcome.code,message:outcome.message,bytes:Buffer.byteLength(document.markdown,'utf8')});
  }

  /** R93 legacy: older stored TaskComplete payloads may carry detailMarkdown without document. */
  private bindDetailMarkdown(task:TaskRow,runId:string,turnId:string,result:{detailMarkdown?:string}):void{
    const markdown=result.detailMarkdown;
    if(typeof markdown!=='string'||markdown.trim().length===0)return;
    const finalMessageId=this.kvGet(`final-message:${turnId}`);
    const memberId=(this.db.prepare('SELECT member_id FROM agent_turns WHERE id=?').get(turnId) as {member_id:string}|undefined)?.member_id;
    if(memberId==null){
      this.audit(task,runId,turnId,'turn.detailMarkdown',{status:'failed',code:'MEMBER_MISSING',bytes:Buffer.byteLength(markdown,'utf8')});
      return;
    }
    if(finalMessageId==null){
      this.audit(task,runId,turnId,'turn.detailMarkdown',{status:'failed',code:'FINAL_MESSAGE_MISSING',bytes:Buffer.byteLength(markdown,'utf8')});
      return;
    }
    const outcome=persistDetailMarkdown({
      db:this.db,appDataDir:this.appDataDir,projectId:task.project_id,conversationId:task.conversation_id,
      threadId:task.conversation_thread_id,taskId:task.id,runId,turnId,messageId:finalMessageId,memberId,markdown,
    });
    if(outcome.status==='ready'){
      this.audit(task,runId,turnId,'turn.detailMarkdown',{status:'ready',artifactId:outcome.artifactId,attachmentId:outcome.attachmentId,hash:outcome.hash,bytes:outcome.bytes,reused:outcome.reused});
      return;
    }
    try{
      this.db.prepare(`UPDATE messages SET body_json=json_set(body_json,'$.detailMarkdown',?) WHERE id=?`).run(markdown,finalMessageId);
      this.audit(task,runId,turnId,'turn.detailMarkdown',{status:'inline-fallback',code:outcome.status==='too-large'?'TOO_LARGE':outcome.code,message:outcome.message,bytes:Buffer.byteLength(markdown,'utf8')});
    }catch(error){
      this.audit(task,runId,turnId,'turn.detailMarkdown',{status:'failed',code:outcome.status==='too-large'?'TOO_LARGE':outcome.code,message:`${outcome.message}; fallback persistence failed: ${String(error)}`,bytes:Buffer.byteLength(markdown,'utf8')});
    }
  }

  private ensureStructuredFinalReply(task: TaskRow, turnId: string, finalText: string, result: { answer?: string; changeSummary: string; detailMarkdown?: string; document?: DocumentArtifact|null }): void {
    const hasDocumentField = Object.prototype.hasOwnProperty.call(result, 'document');
    const visible = (result.answer ?? '').trim() || result.changeSummary.trim()
      || (hasDocumentField
        ? (result.document?.markdown.trim() ? `文档：${result.document.filename}` : '')
        : (result.detailMarkdown?.trim() ? '完整详情见下方 Markdown 附件。' : ''));
    if (visible.length === 0) return;
    const key = `final-message:${turnId}`;
    const expectedResultKey = `result_${turnId}`;
    const normalize = (text: string) => text.replace(/\s+/g, '').replace(/[。！？.!?]+$/u, '');
    const existingFinalId = this.kvGet(key);
    if (existingFinalId != null) {
      const row = this.db.prepare('SELECT body_json FROM messages WHERE id = ?').get(existingFinalId) as { body_json: string } | undefined;
      if (row != null) {
        try {
          const body = JSON.parse(row.body_json) as { text?: unknown; runtimeControlResult?: unknown };
          const text = typeof body.text === 'string' ? body.text : '';
          if (text.length > 0) {
            // R90 final5 回归修复：复用 agentReplyText 的**完整答案/段落**判定，不用任意子串 includes——
            // “不是最终结论。”不能因为包含“是”就吞掉真实 answer='是。'。
            const projected = isExplicitTaskCompleteOutput(text)
              ? chatAnswer(text, 'agent', expectedResultKey).trim()
              : text;
            const supplemented = agentReplyText(projected, finalText, expectedResultKey).trim() || visible;
            if (normalize(supplemented) === normalize(text)) return; // 完整答案已可见，不重复
            const nextBody = JSON.stringify({
              ...body,
              text: supplemented,
              runtimeControlResult: typeof body.runtimeControlResult === 'string' ? body.runtimeControlResult : finalText,
            });
            this.db.prepare('UPDATE messages SET body_json = ? WHERE id = ?').run(nextBody, existingFinalId);
            this.audit(task, null, turnId, 'turn.structuredFinalSupplemented', {
              messageId: existingFinalId,
              previousText: text.slice(0, 200),
              supplementedText: supplemented.slice(0, 200),
              rule: 'agentReplyText(existingText, validatedTaskComplete, resultKey)——完整答案/段落判定，非任意子串',
            });
            return; // 保持同一最终回复消息绑定（文件卡不挂前缀）
          }
        } catch { /* 残缺正文按缺失处理 */ }
      }
    }
    const memberId = (this.db.prepare('SELECT member_id FROM agent_turns WHERE id = ?').get(turnId) as { member_id: string } | undefined)?.member_id
      ?? task.owner_member_id ?? 'unknown_member';
    const messageId = `msg_${turnId}_structured_final`;
    const bodyJson = JSON.stringify({ text: visible, runtimeControlResult: finalText });
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT 1 AS ok FROM messages WHERE id = ?').get(messageId);
      if (existing != null) return;
      const isDm = task.kind === 'dm_turn';
      const conversationSeq = (this.db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_id) as { last_message_seq: number }).last_message_seq;
      if (isDm) {
        this.db.prepare(
          `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
             thread_message_seq, author_type, author_id, body_json, status, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, 'agent', ?, ?, 'final', ?)`,
        ).run(messageId, task.project_id, task.conversation_id, conversationSeq, task.id, memberId, bodyJson, Date.now());
        return;
      }
      const threadSeq = (this.db.prepare('UPDATE conversation_threads SET last_message_seq = last_message_seq + 1, revision = revision + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_thread_id) as { last_message_seq: number }).last_message_seq;
      this.db.prepare(
        `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
           thread_message_seq, author_type, author_id, body_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, 'final', ?)`,
      ).run(messageId, task.project_id, task.conversation_id, conversationSeq, task.room_id, task.conversation_thread_id, task.id, threadSeq, memberId, bodyJson, Date.now());
      appendDomainEvent(this.db, {
        schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: task.project_id, conversationId: task.conversation_id,
        threadId: task.conversation_thread_id, taskId: task.id, turnId, kind: 'thread.replyAdded', createdAt: Date.now(),
        payload: { messageId, source: 'structured-final-fallback' },
      });
    });
    tx();
    this.kvSet(key, messageId);
  }

  /**
   * 本 turn 的**执行时**写权限事实（R91 审核⑤）：
   * - 优先读 dispatch 时写入 runtime_sessions.capabilities_json 的 writeAccessMode（含 identityKey）；
   * - 旧会话没有 mode 时，只有"当前有效配置 identityKey == 会话记录的 writeIdentity"才承认，
   *   避免执行后配置升级被追溯成"本次也拥有 fullAccess"；
   * - 当前配置变化/不可核实 → null（不登记，给可读状态；不破坏已成功结果）。
   */
  private turnRecordedWriteAccess(task: TaskRow, turnId: string, memberId: string): { fullAccess: boolean; modificationAuthorized: boolean; root: string } | null {
    try {
      const turn = this.db.prepare('SELECT session_id FROM agent_turns WHERE id = ?').get(turnId) as { session_id: string | null } | undefined;
      if (turn?.session_id == null) return null;
      const session = this.db.prepare('SELECT project_id, conversation_id, member_id, task_id, capabilities_json FROM runtime_sessions WHERE id = ?')
        .get(turn.session_id) as { project_id: string; conversation_id: string; member_id: string; task_id: string | null; capabilities_json: string | null } | undefined;
      if (session == null) return null;
      if (session.project_id !== task.project_id || session.conversation_id !== task.conversation_id || session.member_id !== memberId) return null;
      if (session.task_id != null && session.task_id !== task.id) return null;
      let caps: { writeIdentity?: unknown; writeAccessMode?: unknown } = {};
      try { caps = (JSON.parse(session.capabilities_json ?? '{}') ?? {}) as typeof caps; } catch { caps = {}; }
      const recordedKey = typeof caps.writeIdentity === 'string' ? caps.writeIdentity : null;
      const rawMode = caps.writeAccessMode != null && typeof caps.writeAccessMode === 'object' && !Array.isArray(caps.writeAccessMode)
        ? caps.writeAccessMode as Record<string, unknown>
        : null;
      if (rawMode != null
        && typeof rawMode.fullAccess === 'boolean'
        && typeof rawMode.modificationAuthorized === 'boolean'
        && typeof rawMode.root === 'string') {
        const modeKey = typeof rawMode.identityKey === 'string' ? rawMode.identityKey : null;
        if (recordedKey == null || modeKey == null || modeKey === recordedKey) {
          return { fullAccess: rawMode.fullAccess, modificationAuthorized: rawMode.modificationAuthorized, root: rawMode.root };
        }
      }
      if (recordedKey != null) {
        const current = effectiveTaskWriteAccess(this.db, task.id, memberId, this.defaultKindOf());
        if (current.identityKey === recordedKey) {
          return { fullAccess: current.fullAccess, modificationAuthorized: current.modificationAuthorized, root: current.root };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 本轮成功合同路径写入的生成文件候选（.files + 已验证差异）；非成功路径不写键。 */
  private turnFileSnapshotContext(turnId: string): { files: string[]; diff: { added: string[]; modified: string[] } | null } | null {
    const raw = this.kvGet(`final-files:${turnId}`);
    if (raw == null) return null;
    let files: string[] = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) files = parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    } catch {
      return null;
    }
    let diff: { added: string[]; modified: string[] } | null = null;
    const diffRaw = this.kvGet(`turn-diff:${turnId}`);
    if (diffRaw != null) {
      try {
        const parsed = JSON.parse(diffRaw) as { added?: unknown; modified?: unknown } | null;
        if (parsed != null && typeof parsed === 'object') {
          const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
          diff = { added: strings(parsed.added), modified: strings(parsed.modified) };
        }
      } catch { diff = null; }
    }
    return { files, diff };
  }

  /**
   * R91 生成文件快照（终态后、事务外）：
   * - 只处理本 turn 已成功且完成权限/build 校验的结果（失败/停止/UNKNOWN/迟到不登记；
   *   DELIB 可写轮从已验证 changeset 取差异）；
   * - 依据本次有效写权限（fullAccess 可本轮明确列出的项目外文件；受限权限只收项目内且有本
   *   turn 变更证据的路径；显式只读不登记产出），读取真实字节/hash 后复制到内容寻址存储；
   * - 只挂到本轮绑定的最终回复消息（final-message 键），不挂会话全部回复；
   * - 一切失败只产可读状态 + 审计，绝不影响已成功的聊天/交付。
   */
  private async snapshotCompletedFiles(task: TaskRow, runId: string, turnId: string): Promise<void> {
    const context = this.turnFileSnapshotContext(turnId);
    const keys = [`final-files:${turnId}`, `turn-diff:${turnId}`, `final-message:${turnId}`];
    const cleanup = (): void => {
      for (const key of keys) { try { this.db.prepare('DELETE FROM daemon_state WHERE key = ?').run(key); } catch { /* 尽力清理 */ } }
    };
    try {
      const turn = this.db.prepare('SELECT status, member_id, stage_key FROM agent_turns WHERE id = ?').get(turnId) as
        | { status: string; member_id: string; stage_key: string } | undefined;
      if (turn == null || turn.status !== 'SUCCEEDED') return;
      const project = this.db.prepare('SELECT canonical_path, status FROM projects WHERE id = ?').get(task.project_id) as
        | { canonical_path: string; status: string } | undefined;
      // 审核⑤：按本 turn 执行时记录的权限（不是执行后当前配置）决定 fullAccess/受限/只读。
      const access = project == null ? null : this.turnRecordedWriteAccess(task, turnId, turn.member_id);
      let contextForFiles = context;
      if (contextForFiles == null) {
        const changesetId = this.kvGet(`write-changeset:${turnId}`);
        if (changesetId != null) {
          const finalized = finalizeChangeset(this.db, { changeSetId: changesetId, appDataDir: this.appDataDir });
          if (finalized.ok) {
            contextForFiles = {
              files: [...finalized.value.diff.added, ...finalized.value.diff.modified],
              diff: { added: [...finalized.value.diff.added], modified: [...finalized.value.diff.modified] },
            };
          }
        }
      }
      // 绑定消息必须属于本轮（DIRECT 最终回复或 DELIB 可见阶段消息），否则不挂附件。
      const rawMessageId = this.kvGet(`final-message:${turnId}`);
      const messageId = rawMessageId != null && (rawMessageId.startsWith(`msg_${turnId}_`) || rawMessageId.startsWith('msg_delib_')) ? rawMessageId : null;
      const outcome = snapshotGeneratedFiles({
        db: this.db,
        appDataDir: this.appDataDir,
        projectId: task.project_id,
        projectRoot: project?.canonical_path ?? '',
        taskId: task.id,
        runId,
        turnId,
        memberId: turn.member_id,
        conversationId: task.conversation_id,
        messageId,
        declaredFiles: contextForFiles?.files ?? [],
        turnDiff: contextForFiles?.diff ?? null,
        access,
      });
      if (outcome.failures.length > 0 || outcome.status === 'blocked') {
        this.insertFileSnapshotNotice(task, turnId, messageId, outcome);
      }
      if (outcome.status !== 'no-candidates') {
        this.audit(task, runId, turnId, 'turn.generatedFileSnapshot', {
          status: outcome.status,
          accessMode: outcome.accessMode,
          registered: outcome.registered.map((r) => ({ artifactId: r.artifactId, filename: r.filename, kind: r.kind, revision: r.revision, hash: r.hash.slice(0, 16), bytes: r.sizeBytes, source: r.source })),
          failures: outcome.failures.map((f) => ({ path: f.path, code: f.code, message: f.message, declared: f.declared })),
          skipped: outcome.skipped,
          rule: '仅正式结果显式 .files 或本 turn changeset added；真实读取+sha256；fullAccess 可项目外；受限/只读按原权限',
        });
      }
    } catch (error) {
      try {
        this.audit(task, runId, turnId, 'turn.generatedFileSnapshot', { status: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      } catch { /* 审计尽力而为 */ }
    } finally {
      cleanup();
    }
  }

  /** 文件快照失败/未登记的可读状态（system 消息；不伪造成功附件，也不阻塞原回复）。 */
  private insertFileSnapshotNotice(task: TaskRow, turnId: string, boundMessageId: string | null, outcome: SnapshotOutcome): void {
    const messageId = `msg_filesnap_${turnId}`;
    try {
      if (this.db.prepare('SELECT 1 AS ok FROM messages WHERE id = ?').get(messageId) != null) return;
      const bound = boundMessageId != null
        ? this.db.prepare('SELECT thread_id, room_id FROM messages WHERE id = ?').get(boundMessageId) as { thread_id: string | null; room_id: string | null } | undefined
        : undefined;
      const threadId = bound?.thread_id ?? task.conversation_thread_id ?? null;
      const roomId = bound?.room_id ?? task.room_id ?? null;
      const failures = outcome.failures.slice(0, 6);
      const lines = ['【文件卡未登记】以下本轮产出没有生成可点击附件（原回复与交付不受影响）：'];
      for (const f of failures) lines.push(`- ${f.path}：${f.message}`);
      if (outcome.failures.length > failures.length) lines.push(`- 另有 ${outcome.failures.length - failures.length} 项未登记`);
      if (outcome.registered.length > 0) lines.push(`已成功登记 ${outcome.registered.length} 个文件。`);
      const text = lines.join('\n');
      const tx = this.db.transaction(() => {
        const conversationSeq = (this.db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq')
          .get(task.conversation_id) as { last_message_seq: number }).last_message_seq;
        let threadSeq: number | null = null;
        if (threadId != null) {
          threadSeq = (this.db.prepare('UPDATE conversation_threads SET last_message_seq = last_message_seq + 1, revision = revision + 1 WHERE id = ? RETURNING last_message_seq')
            .get(threadId) as { last_message_seq: number }).last_message_seq;
        }
        this.db.prepare(
          `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
             thread_message_seq, author_type, author_id, body_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?, 'final', ?)`,
        ).run(messageId, task.project_id, task.conversation_id, conversationSeq, roomId, threadId, task.id, threadSeq, 'system:file-snapshot', JSON.stringify({ text }), Date.now());
        if (threadId != null) {
          appendDomainEvent(this.db, {
            schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: task.project_id, conversationId: task.conversation_id,
            threadId, taskId: task.id, turnId, kind: 'thread.replyAdded', createdAt: Date.now(), payload: { messageId, system: 'file-snapshot' },
          });
        }
      });
      tx();
    } catch { /* 可读状态尽力而为：不因提示失败影响原成功结果 */ }
  }

  private insertThreadReply(task: TaskRow, turnId: string, messageId: string, text: string,controlResult?:string,options?:{finalMessage?:boolean}): void {
    const expectedResultKey=`result_${turnId}`;
    const visibleText=agentReplyText(text,controlResult,expectedResultKey);
    const original=controlResult??(visibleText!==text?text:null);
    const bodyJson=JSON.stringify({text:visibleText,...(original?{runtimeControlResult:original}:{})});
    // 消息身份以 turn 为命名空间：同 turn 内重放去重（RT-05），跨 turn/会话的同名 provider id 不冲突。
    const rowId = `msg_${turnId}_${messageId}`;
    const isDm = task.kind === 'dm_turn';
    const runId=(this.db.prepare('SELECT run_id FROM agent_turns WHERE id=?').get(turnId) as {run_id:string}|undefined)?.run_id??null;
    const parseBody=(raw:string):{text:string;runtimeControlResult?:string}|null=>{
      try {
        const parsed=JSON.parse(raw) as {text?:unknown;runtimeControlResult?:unknown};
        if(typeof parsed.text!=='string')return null;
        return{text:parsed.text,...(typeof parsed.runtimeControlResult==='string'?{runtimeControlResult:parsed.runtimeControlResult}:{})};
      } catch {
        return null;
      }
    };
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id,body_json FROM messages WHERE id = ?')
        .get(rowId) as { id: string;body_json:string } | undefined;
      if (existing != null) {
        const existingBody=parseBody(existing.body_json);
        if(original!=null&&existingBody!=null&&existingBody.runtimeControlResult==null&&existingBody.text===visibleText){
          this.db.prepare('UPDATE messages SET body_json=? WHERE id=?').run(bodyJson,rowId);
          this.audit(task,runId,turnId,'turn.duplicateVisibleReplyMerged',{
            keptMessageId:rowId,incomingMessageId:rowId,action:'added-control-to-existing-message',incomingBody:bodyJson,
          });
        }
        return existing.id;
      }
      const priorRows=this.db.prepare(`SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent'
        AND id LIKE ? ORDER BY rowid`).all(task.id,`msg_${turnId}_%`) as Array<{id:string;body_json:string}>;
      const duplicate=priorRows.find(row=>parseBody(row.body_json)?.text===visibleText);
      if(duplicate!=null){
        const duplicateBody=parseBody(duplicate.body_json)!;
        const addControl=original!=null&&duplicateBody.runtimeControlResult==null;
        if(addControl)this.db.prepare('UPDATE messages SET body_json=? WHERE id=?').run(bodyJson,duplicate.id);
        this.audit(task,runId,turnId,'turn.duplicateVisibleReplyMerged',{
          keptMessageId:duplicate.id,
          incomingMessageId:rowId,
          action:addControl?'added-control-to-existing-message':'kept-existing-visible-message',
          incomingBody:bodyJson,
        });
        return duplicate.id;
      }
      const convSeq = this.db
        .prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_id) as { last_message_seq: number };
      const author = this.db
        .prepare('SELECT member_id FROM agent_turns WHERE id = ?')
        .get(turnId) as { member_id: string } | undefined;
      if (isDm) {
        // DM 回复落会话（无线程序号——R4 §2.2：DM 消息 thread 各字段为 NULL）。
        this.db.prepare(
          `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
             thread_message_seq, author_type, author_id, body_json, status, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, 'agent', ?, ?, 'final', ?)`,
        ).run(rowId, task.project_id, task.conversation_id, convSeq.last_message_seq, task.id, author?.member_id ?? 'unknown_member', bodyJson, Date.now());
        return rowId;
      }
      const threadSeq = this.db
        .prepare('UPDATE conversation_threads SET last_message_seq = last_message_seq + 1, revision = revision + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_thread_id) as { last_message_seq: number };
      this.db.prepare(
        `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
           thread_message_seq, author_type, author_id, body_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, 'final', ?)`,
      ).run(
        rowId, task.project_id, task.conversation_id, convSeq.last_message_seq,
        task.room_id, task.conversation_thread_id, task.id, threadSeq.last_message_seq,
        author?.member_id ?? 'unknown_member', bodyJson, Date.now(),
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
      return rowId;
    });
    const keptMessageId = tx();
    // R91 生成文件卡绑定：只记“本轮最终可见回复消息”（去重时记实际保留的那条），
    // 交付后快照只挂这一条（不上全部回复）。
    if (options?.finalMessage === true && keptMessageId != null) this.kvSet(`final-message:${turnId}`, keptMessageId);
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
    // 真实调用护栏（第十七轮四）：终态在唯一收口点结算 startTurn 台账行（inflight→终态；
    // 未知/中断如实保留——覆盖修复/重派/研讨/并发全部路径）。
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(status)) {
      this.controlFromMessages.delete(turnId);
      if(status!=='SUCCEEDED')this.db.prepare("UPDATE coordination_runs SET state=?,error_message=? WHERE (run_id=(SELECT run_id FROM agent_turns WHERE id=?) OR integration_run_id=(SELECT run_id FROM agent_turns WHERE id=?)) AND state IN ('planning','running','integrating')").run(status==='CANCELLED'?'cancelled':'blocked',status==='CANCELLED'?'协调执行已停止':'协调执行未完成，请查看运行原因',turnId,turnId);
      settleConversationReplyForTurn(this.db,turnId,status);
      if(status!=='SUCCEEDED'){
        settleThreadReplyForTurn(this.db,turnId,status);
        const bound=this.db.prepare('SELECT r.task_id FROM workflow_runs r JOIN agent_turns a ON a.run_id=r.id WHERE a.id=?').get(turnId) as {task_id:string}|undefined;
        if(bound)settleMemberMessageTurn(this.db,bound.task_id,turnId,status,status==='UNKNOWN'?'执行结果待核实；不会自动重发':status==='CANCELLED'?'执行已停止':'执行未完成，请查看运行原因');
      }
      try { settleRealCall(this.db, turnId, status === 'SUCCEEDED' ? 'succeeded' : status === 'FAILED' ? 'failed' : status === 'CANCELLED' ? 'interrupted' : 'unknown', `turn 终态=${status}`); } catch { /* 台账尽力而为——不影响业务事务 */ }
      try { settleReminderCallForTurn(this.db, turnId, status); } catch { /* 提醒调用台账跟随——尽力而为（UNKNOWN/CANCELLED=保守计数） */ }
      // DM 会话身份终态结算（第二十轮二）：所有终态路径统一在此核对 provider 上报身份。
      this.settleDmSession(turnId);
      this.retryFailedDmSettlements(); // 明确重试触发（第二十二轮三）：每任一 DM 终态后全量重试失败结算
      // DM 停止语义（DEV-22）：取消=用户停止——队列挂起（paused，dm.resume 继续）。
      // 队列泵在消费器终态后/UNKNOWN 收尾后执行（此时 run 状态已落定——见 pumpDmAfterTerminal）。
      if (status === 'CANCELLED') {
        try {
          const dmConv = this.dmConversationOfTurn(turnId);
          if (dmConv != null) holdDmPauseGate(this.db, dmConv, `dm run 取消（turn=${turnId}）——队列转 paused`);
        } catch { /* 尽力而为 */ }
      }
    }
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
    "SELECT id, status, stage, round_no, roster_revision, budget_json FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1",
  ).get(taskId) as ActiveDelibRun | undefined;
}

function parseInitialTaskId(dispatchKey: string): string | null {
  // initial=根任务首派；redispatch=同任务追加 turn（跟进/重试，任务须非终态且 stop_generation=0；
  // 第三十九轮 §2.2：恢复意图版本化 redispatch:<sourceRunId> 后缀——同源幂等/新中断新意图）；
  // reminder:{reminderId}:{occurrence}=提醒跟进派发（第二十六轮一：**完整身份键**——含
  // reminderId（同任务可绑多提醒，同刻触发不撞唯一键），归属/预算沿键解析）。
  // dmtask:=私信内部执行（DEV-22：dm_turn 同走 DIRECT 派发路径，key 前缀区分房间任务）。
  const m = dispatchKey.match(/^(?:dm)?task:(.+):(?:initial|redispatch(?::[^:]+)?|repair:[^:]+|conversation:[^:]+|thread-reply:[^:]+|reminder:[^:]+:[^:]+)$/);
  return m?.[1] ?? null;
}

function isTurnTerminalStatus(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(status);
}

/**
 * 单层围栏规范化（第六轮）：仅当 **整个** 文本被一对 ```（或 ```json）围栏包裹时剥壳；
 * 剥壳后走同一严格 schema 校验（不截取首个 JSON 段、不删未知字段、不伪造必填值、
 * 不放松 resultKey）。其余形态（围栏外有正文、散文、多重包裹内容物）原样返回。
 */
export function stripSingleJsonFence(text: string): { text: string; normalized: boolean } {
  const FENCE_RE = /^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*$/;
  const m = FENCE_RE.exec(text);
  if (m == null) return { text, normalized: false };
  const inner = m[1] ?? '';
  if (inner.includes('```')) return { text, normalized: false }; // 内部还有围栏=非单层包裹，不剥
  return { text: inner, normalized: true };
}
