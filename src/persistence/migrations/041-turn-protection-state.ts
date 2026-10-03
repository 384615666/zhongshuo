/**
 * 迁移 041（第四十一轮·review-r40 §2 P1）：agent_turns.protection_state——**保护状态独立持久化**。
 * 背景：恢复保护此前由「UNKNOWN 状态 + 未释放租约」推导——无租约的 UNKNOWN turn 经
 * recovery.reconcile(notStarted, manualRiskAck) 变 FAILED/refunded 且 protectionRetained=true 后，
 * 两个推导源同时消失（状态≠UNKNOWN、无租约），呈现可恢复、task.redispatch 放行（复核反例
 * review-r40/recovery-no-lease-result.json）。**无租约不能代表退出已确认**——保护/准入保留
 * 须是独立、持久、按 turn 归属的权威事实：
 * - NULL：从未进入「保护保留」语义（正常终态/普通失败）；
 * - 'retained'：对账明确保留（人工 notStarted、executed 取证 alive/身份缺失、keepUnknown 不写
 *   ——后者由 UNKNOWN 未闭环分支继续拦）；
 * - 'released'：以服务端程序证据解除（no-os-process / 受管 Job 证据）。
 * 跨重启同判同源（守卫/呈现/准入/恢复中心全部读本列）。
 */
import type { Migration } from '../db.ts';

export const migration041: Migration = {
  id: 41,
  name: 'turn-protection-state',
  up: (db) => {
    db.exec(`ALTER TABLE agent_turns ADD COLUMN protection_state TEXT CHECK (protection_state IS NULL OR protection_state IN ('retained','released'))`);
    db.exec(`CREATE INDEX idx_agent_turns_protection_retained ON agent_turns(protection_state) WHERE protection_state = 'retained'`);
  },
};
