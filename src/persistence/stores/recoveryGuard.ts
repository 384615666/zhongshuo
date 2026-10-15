/**
 * 恢复派发就绪判定（第四十轮 §2——review-r39 两 P1 反例收口）。
 *
 * 恢复事实**四分离**，任一未收口即不可新建派发：
 * 1. 在途（run/turn 真实归属——workflow_runs.task_id，不由键前缀推测）；
 * 2. 保护未解除：该任务任意 turn 存在未释放 workspace_leases——**不论 turn 状态**
 *    （§2.2：notStarted 人工声明→FAILED/refunded 但租约保留，同样拦）；
 * 3. 结果未对账：UNKNOWN turn 预算未处置（budget_mark IS NULL）；
 * 4. 退出未确认：UNKNOWN turn 即使已结算（§2.1：executed 对账遇身份缺失/取证
 *    alive——protectionRetained，turn 保持 UNKNOWN），也须有正式
 *    recovery.protectionReleased(released=true) 事件（服务端 no-os-process/
 *    受管 Job 证据解除）才算恢复闭环；事件持久化=跨重启同判。
 *
 * dm.ts 的可恢复性呈现与 commands.ts 的 task.redispatch 守卫**共用本判定**
 * （单一真相源）；命令侧在事务内 INSERT 前调用=提交时重查。
 */
import type { ZhongshuoDatabase } from '../db.ts';

export interface RecoveryBlockReason {
  code: 'WORKER_STILL_RUNNING' | 'RECONCILE_REQUIRED';
  message: string;
  /** 界定用事实（不进用户文案）：未释放租约数/未闭环 turn。 */
  fact: { kind: 'in-flight-runs' | 'in-flight-turns' | 'protection-retained' | 'held-lease' | 'unclosed-unknown'; count?: number; turnId?: string; lockDomain?: string };
}

/** 任务是否可新建派发（redispatch/恢复）：null=可；否则返回阻断原因。 */
export function assessTaskRedispatchReadiness(db: ZhongshuoDatabase, taskId: string, options: { queueOnly?: boolean } = {}): RecoveryBlockReason | null {
  // A parent cannot acquire a fresh planning identity around an unresolved child.
  // Existing formal UNKNOWN / process-exit / lease checks remain authoritative.
  const children=db.prepare(`SELECT DISTINCT child.id FROM tasks child JOIN workflow_runs r ON r.task_id=child.id
    LEFT JOIN agent_turns a ON a.run_id=r.id WHERE child.parent_task_id=? AND
    (r.status IN ('RUNNING','WAITING','STOPPING','QUEUED') OR a.status IN ('RUNNING','WAITING','STOPPING','QUEUED','UNKNOWN')
      OR a.protection_state='retained' OR EXISTS(SELECT 1 FROM workspace_leases l WHERE l.owner_turn_id=a.id AND l.status!='released'))`).all(taskId) as {id:string}[];
  for(const child of children){const blocked=assessTaskRedispatchReadiness(db,child.id,options);if(blocked)return {...blocked,message:`协作子任务尚未安全收口：${blocked.message}`};}
  const inFlightRuns = db.prepare(
    `SELECT count(*) c FROM workflow_runs WHERE task_id = ? AND status IN ('RUNNING','WAITING','STOPPING','QUEUED')`,
  ).get(taskId) as { c: number };
  if (inFlightRuns.c > 0 && !options.queueOnly) {
    return { code: 'WORKER_STILL_RUNNING', message: `该任务已有在途执行（run ${inFlightRuns.c} 个）：不得并发追加`, fact: { kind: 'in-flight-runs', count: inFlightRuns.c } };
  }
  const inFlightTurns = db.prepare(
    `SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id
     WHERE r.task_id = ? AND t.status IN ('RUNNING','WAITING','STOPPING','QUEUED')`,
  ).get(taskId) as { c: number };
  if (inFlightTurns.c > 0 && !options.queueOnly) {
    return { code: 'WORKER_STILL_RUNNING', message: `该任务已有在途/未收口 turn（${inFlightTurns.c} 个）：不得并发追加`, fact: { kind: 'in-flight-turns', count: inFlightTurns.c } };
  }
  // 保护未解除（第四十一轮 §2 P1——权威持久事实）：对账明确保留（protectionRetained）的
  // turn 一律拦——**无租约不能代表退出已确认**（复核反例：notStarted 人工退款后 FAILED/
  // refunded 且保护保留，旧推导（UNKNOWN+租约）双源齐失而放行）。
  const retained = db.prepare(
    `SELECT t.id AS turnId FROM agent_turns t
     JOIN workflow_runs r ON r.id = t.run_id
     WHERE r.task_id = ? AND t.protection_state = 'retained'
     LIMIT 1`,
  ).get(taskId) as { turnId: string } | undefined;
  if (retained != null) {
    return {
      code: 'RECONCILE_REQUIRED',
      message: `存在对账后仍保留的保护（turn ${retained.turnId.slice(0, 14)}… protection_state=retained——人工退款/取证未确认退出时保护保留，无租约不等于退出已确认）——须先在桌面「恢复中心」以服务端程序证据解除（recovery.releaseProtection）再恢复执行`,
      fact: { kind: 'protection-retained', turnId: retained.turnId },
    };
  }
  // 保护未解除（§2.2）：未释放租约按任务全量核对——FAILED/refunded 的人工声明同样拦
  // （旧数据/未走 041 语义路径的兜底——protection_state 为 NULL 但租约未释放）。
  const heldLease = db.prepare(
    `SELECT l.lock_domain AS lockDomain, t.id AS turnId FROM workspace_leases l
     JOIN agent_turns t ON t.id = l.owner_turn_id
     JOIN workflow_runs r ON r.id = t.run_id
     WHERE r.task_id = ? AND l.status != 'released'
       AND (? = 0 OR t.status IN ('SUCCEEDED','FAILED','CANCELLED','UNKNOWN'))
     LIMIT 1`,
  ).get(taskId, options.queueOnly ? 1 : 0) as { lockDomain: string; turnId: string } | undefined;
  if (heldLease != null) {
    return {
      code: 'RECONCILE_REQUIRED',
      message: `存在未解除的物理写入保护（turn ${heldLease.turnId.slice(0, 14)}… 的租约「${heldLease.lockDomain}」未释放）——人工退款/对账后保护保留的，须先在桌面「恢复中心」以服务端证据解除（recovery.releaseProtection）再恢复执行`,
      fact: { kind: 'held-lease', turnId: heldLease.turnId, lockDomain: heldLease.lockDomain },
    };
  }
  // UNKNOWN 未闭环（§2.1/§3 旧检查）：预算未处置，或已结算但无正式保护解除事件（退出未确认）。
  const unclosed = db.prepare(
    `SELECT t.id AS turnId, t.budget_mark AS budgetMark FROM agent_turns t
     JOIN workflow_runs r ON r.id = t.run_id
     WHERE r.task_id = ? AND t.status = 'UNKNOWN'
       AND NOT EXISTS (
         SELECT 1 FROM domain_events e
         WHERE e.kind = 'recovery.protectionReleased' AND e.turn_id = t.id
           AND e.payload_json LIKE '%"released":true%'
       )
     LIMIT 1`,
  ).get(taskId) as { turnId: string; budgetMark: string | null } | undefined;
  if (unclosed != null) {
    const tail = unclosed.budgetMark == null
      ? '预算未处置（budget 未对账）'
      : `预算已结算但退出未确认（对账取证为身份缺失/存活观察——保护保留，turn 仍 UNKNOWN）`;
    return {
      code: 'RECONCILE_REQUIRED',
      message: `存在结果不确定且未闭环的执行（turn ${unclosed.turnId.slice(0, 14)}…：${tail}）——先在桌面「恢复中心」完成服务端取证/对账并以程序证据解除保护后再恢复执行——显式点击不构成旧执行已退出的证明，不自动重放`,
      fact: { kind: 'unclosed-unknown', turnId: unclosed.turnId },
    };
  }
  return null;
}
