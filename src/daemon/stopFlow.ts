/**
 * 停止流程（§7.3/§16.3、开工契约 §3.2）与恢复（§16.4）。
 * 停止：evaluateStopTarget 纯判定 + 状态推进 + worker 中断回调；STOPPING 直到确认退出。
 * 恢复：标记非终态运行、重排过期租约 outbox（不自动补跑，决策 44/E7）。
 */
import { randomUUID } from 'node:crypto';
import { stopCoordinationChildren,settleStoppedCoordination } from './coordination.ts';
import {settleStoppedDeliberation} from './deliberationRunner.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { runCommand } from '../persistence/commandGateway.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { holdDispatchGate } from '../persistence/daemonState.ts';
import { settleRealCall } from './realCallLedger.ts';
import { evaluateStopTarget } from '../domain/scope/stopTarget.ts';
import type { TaskStopOutcome } from '../contracts/task.ts';
import type { RunStatus } from '../contracts/run.ts';

export interface RequestStopInput {
  taskId: string;
  targetRunId: string;
  expectedStopGeneration: number;
  commandId: string;
  idempotencyScope: string;
  payloadHash: string;
  now: number;
  /** worker 提供的在途 turn 中断回调（§16.3：先协议中断，确认退出才算停止）。 */
  interruptTurn: (turnId: string) => Promise<void>;
  /** 远程门禁·业务提交前（第三十四轮四）：自包 runCommand 的异步命令同样过提交前重查
   * （commands.ts 注入——设备吊销/代次变化/会话失效→提交拒绝，吊销≠停止语义不变）。 */
  commitGate?: () => void;
}

export interface RequestStopResult {
  outcome: TaskStopOutcome;
  stopGeneration: number;
}

export async function requestStop(db: ZhongshuoDatabase, input: RequestStopInput): Promise<RequestStopResult> {
  if (input.commitGate != null) input.commitGate();
  const outcome = runCommand<RequestStopResult>(
    db,
    { idempotencyScope: input.idempotencyScope, commandId: input.commandId, payloadHash: input.payloadHash, now: input.now },
    () => {
      const task = db
        .prepare('SELECT id, project_id, conversation_id, conversation_thread_id, stop_generation, status FROM tasks WHERE id = ?')
        .get(input.taskId) as
        | { id: string; project_id: string; conversation_id: string; conversation_thread_id: string; stop_generation: number; status: string }
        | undefined;
      if (task == null) {
        throw new StopCommandError('RESOURCE_NOT_FOUND', '任务不存在');
      }
      const run = db
        .prepare('SELECT id, status FROM workflow_runs WHERE id = ? AND task_id = ?')
        .get(input.targetRunId, input.taskId) as { id: string; status: RunStatus } | undefined;
      const verdict = evaluateStopTarget({
        taskCurrentRunId: currentRunIdOf(db, input.taskId),
        targetRunId: input.targetRunId,
        expectedStopGeneration: input.expectedStopGeneration,
        currentStopGeneration: task.stop_generation,
        targetRunStatus: run?.status ?? 'FAILED',
      });
      if (!verdict.ok) {
        throw new StopCommandError(verdict.error.code, verdict.error.message);
      }
      let stopGeneration = task.stop_generation;
      if (verdict.value === 'stopping') {
        stopGeneration = task.stop_generation + 1;
        const tx = db.transaction(() => {
          db.prepare('UPDATE tasks SET stop_generation = ? WHERE id = ?').run(stopGeneration, task.id);
          stopCoordinationChildren(db,task.id);
          db.prepare("UPDATE conversation_reply_requests SET status='cancelled',error_message='用户已停止；这条排队续问未执行',updated_at=? WHERE task_id=? AND status='queued'").run(input.now,task.id);
            db.prepare("UPDATE thread_reply_requests SET status='cancelled',error_message='用户已停止；这条排队消息未执行',updated_at=? WHERE task_id=? AND status='queued'").run(input.now,task.id);
          db.prepare(`UPDATE workflow_runs SET status = 'STOPPING' WHERE id = ? AND status IN ('QUEUED','RUNNING','WAITING')`).run(input.targetRunId);
          db.prepare(`UPDATE agent_turns SET status = 'STOPPING' WHERE run_id = ? AND status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT')`).run(input.targetRunId);
          appendDomainEvent(db, {
            schemaVersion: 1,
            eventId: `evt_${randomUUID()}`,
            projectId: task.project_id,
            conversationId: task.conversation_id,
            threadId: task.conversation_thread_id,
            taskId: task.id,
            runId: input.targetRunId,
            kind: 'run.statusChanged',
            createdAt: input.now,
            payload: { status: 'STOPPING', stopGeneration },
          });
          settleStoppedDeliberation(db,task.id,input.targetRunId);
          settleStoppedCoordination(db,task.id,input.targetRunId);
        });
        tx();
      }
      return { outcome: verdict.value, stopGeneration };
    },
  );
  if (!outcome.ok) {
    throw new StopCommandError(outcome.error.code, outcome.error.message);
  }
  // 中断在途 turn（事务外执行：协议中断是外部副作用）。
  if (outcome.data.outcome === 'stopping') {
    const turns = db.prepare(`SELECT a.id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
      WHERE (a.run_id=? OR t.parent_task_id=?) AND a.status='STOPPING' ORDER BY a.id LIMIT 100`).all(input.targetRunId,input.taskId) as {id:string}[];
    for(const turn of turns) await input.interruptTurn(turn.id);
  }
  return outcome.data;
}

export class StopCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StopCommandError';
    this.code = code;
  }
}

function currentRunIdOf(db: ZhongshuoDatabase, taskId: string): string | null {
  const row = db
    .prepare(`SELECT id FROM workflow_runs WHERE task_id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED') ORDER BY revision DESC, id DESC LIMIT 1`)
    .get(taskId) as { id: string } | undefined;
  return row?.id ?? null;
}

// ---------- 恢复（§16.4） ----------

export interface RecoverySnapshot {
  interruptedRuns: number;
  unknownTurns: number;
  requeuedOutbox: number;
  heldLeases: Array<{ lockDomain: string; ownerTurnId: string; status: string }>;
  /** 上一次 daemon 停止记录（daemon:stop:last——上次退出未收口时的恢复依据，2026-09-28 第五轮）。 */
  stopRecord: { at: number; phase: string; reason?: string; drainPending?: boolean } | null;
  /** UNKNOWN turn 明细（DEV-13：对账入口——须逐一 reconcile，不清空占位后放行）。 */
  unknownTurnRows: Array<{ turnId: string; runId: string; taskId: string | null; stageKey: string | null; status: string }>;
  /** 未收口撤销记录（DEV-12 崩溃窗口——续跑走 changeset.undo 三向判定）。 */
  activeUndos: Array<{ undoId: string; changeSetId: string; status: string }>;
}

/**
 * 启动恢复：非终态 run→INTERRUPTED、turn→UNKNOWN（进程身份核实随 DEV-06 真实进程补强）；
 * 过期租约的 outbox 重排回 pending 并**落下派发门禁**——恢复后先列出可继续任务等用户
 * 确认「继续」（openDispatchGate）才开放新调度（§16.4-6/决策 44/E7）。
 * 门禁覆盖两种崩溃分支：①曾领取（中断 run/未知 turn/重排队列）②已提交但尚未领取
 * （pending outbox 遗留）——两者都不得直接派发遗留工作。
 */
export function applyRecovery(db: ZhongshuoDatabase, now: number): RecoverySnapshot {
  // 真实调用台账（第十八轮二补漏）：恢复前先取将被标 UNKNOWN 的 turn 清单——崩溃现场的真实
  // startTurn 台账行按「执行不确定」结算（不永久 inflight；崩溃≠请求未发出）。
  const recoveringTurnIds = (db
    .prepare(`SELECT id FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')`)
    .all() as Array<{ id: string }>).map((r) => r.id);
  const tx = db.transaction((): RecoverySnapshot => {
    const interruptedRuns = db
      .prepare(`UPDATE workflow_runs SET status = 'INTERRUPTED' WHERE status IN ('QUEUED','RUNNING','WAITING','STOPPING')`)
      .run().changes;
    const unknownTurns = db
      .prepare(`UPDATE agent_turns SET status = 'UNKNOWN' WHERE status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')`)
      .run().changes;
    // 单实例锁保证旧持有者已终止：启动恢复重排全部 leased（孤儿租约），
    // 不等待 60s 自然过期（修复轮 4 发现：未过期孤儿租约会卡住重启后的派发）。
    const requeuedOutbox = db
      .prepare(`UPDATE outbox SET status = 'pending', lease_owner = NULL, lease_until = NULL WHERE status = 'leased'`)
      .run().changes;
    void now;
    const heldLeases = (db
      .prepare(`SELECT lock_domain, owner_turn_id, status FROM workspace_leases WHERE status != 'released'`)
      .all() as Array<{ lock_domain: string; owner_turn_id: string; status: string }>)
      .map((row) => ({ lockDomain: row.lock_domain, ownerTurnId: row.owner_turn_id, status: row.status }));
    // 已提交未领取的遗留派发工作：同样落下门禁，等用户确认继续。
    const pendingOutbox = (db
      .prepare(`SELECT count(*) c FROM outbox WHERE status = 'pending'`)
      .get() as { c: number }).c;
    // 上次退出的不确定记录（实际持久化在 daemon_state——重启可读，stderr 不算持久化）。
    let stopRecord: RecoverySnapshot['stopRecord'] = null;
    const stopRow = db.prepare(`SELECT value FROM daemon_state WHERE key = 'daemon:stop:last'`).get() as { value: string } | undefined;
    if (stopRow != null) {
      try {
        const parsed = JSON.parse(stopRow.value) as { at?: number; phase?: string; reason?: string; drainPending?: boolean };
        if (typeof parsed.at === 'number' && typeof parsed.phase === 'string') {
          stopRecord = { at: parsed.at, phase: parsed.phase, reason: parsed.reason, drainPending: parsed.drainPending };
        }
      } catch { /* 损坏记录不阻断恢复 */ }
    }
    const gateNeeded =
      interruptedRuns > 0 || unknownTurns > 0 || requeuedOutbox > 0 || heldLeases.length > 0 || pendingOutbox > 0;
    if (gateNeeded) holdDispatchGate(db, now);
    const unknownTurnRows = db
      .prepare(`SELECT t.id AS turnId, t.run_id AS runId, r.task_id AS taskId, t.stage_key AS stageKey, t.status
                FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE t.status = 'UNKNOWN'`)
      .all() as RecoverySnapshot['unknownTurnRows'];
    const activeUndos = db
      .prepare(`SELECT id AS undoId, change_set_id AS changeSetId, status FROM change_set_undos WHERE status IN ('in_progress','failed')`)
      .all() as RecoverySnapshot['activeUndos'];
    return { interruptedRuns, unknownTurns, requeuedOutbox, heldLeases, stopRecord, unknownTurnRows, activeUndos };
  });
  const snapshot = tx();
  for (const turnId of recoveringTurnIds) {
    try { settleRealCall(db, turnId, 'unknown', '恢复：崩溃现场 turn→UNKNOWN（执行不确定——是否发出不可考）'); } catch { /* 台账尽力而为 */ }
  }
  return snapshot;
}
