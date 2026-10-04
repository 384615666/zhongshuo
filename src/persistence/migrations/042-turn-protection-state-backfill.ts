/**
 * 迁移 042（第四十二轮·review-r41 §3 P1）：旧库「保护保留」事实回填。
 *
 * 背景：041 只加列不回填——旧版本库升级后，历史上已明确「保护保留」的 turn（典型：
 * notStarted 人工对账 → FAILED/refunded、无租约，持久审计 protectionRetained=true）全部
 * protection_state=NULL；NULL 被解释为「从未进入保护保留语义」，于是呈现可恢复、
 * task.redispatch 放行（复核反例 dist/desktop/review-r41/legacy-protection-upgrade-probe.mjs
 * ——40→41 后 releaseProtection 甚至按「无租约」no-op 冒充已闭环）。
 *
 * 回填规则（按同一 turn 的持久审计/正式证据**事件顺序**继承，不能只看最终 FAILED/refunded，
 * 也不能因历史上「曾释放」就忽略更晚的保留事实）：
 * - 只看 recovery.reconciled / recovery.protectionReleased 两类正式证据事件，按 seq（落库顺序）
 *   逐条推导保护事实，取每 turn **最新**事实；
 * - keepUnknown 等「不确定性维持」事件不产生保护事实，也不清除先前事实（由 UNKNOWN 未闭环
 *   分支继续拦）；
 * - 证据损坏/字段缺失/矛盾 → retained（不默认安全——须走恢复中心服务端证据解除，不得静默放行）；
 * - 只回填 protection_state IS NULL 的行：041+ 正式代码写入的权威状态不改写；无任何保护证据的
 *   普通失败/正常终态保持 NULL（不误拦）；不清预算、不删数据、不改写任何审计事件。
 * 二次运行幂等（无可回填行）。
 */
import type { Migration } from '../db.ts';

/** 单条恢复证据事件 → 保护事实（'retained' | 'released' | null=无保护语义事实）。 */
export function classifyProtectionFact(kind: string, payloadJson: string): 'retained' | 'released' | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return 'retained'; // 证据损坏——不默认安全
  }
  const p = payload != null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
  if (p == null) return 'retained';
  if (kind === 'recovery.protectionReleased') {
    if (p.released === true) return 'released';
    return 'retained'; // released:false（解除被拒=保留）或字段缺失/矛盾——不默认安全
  }
  if (kind === 'recovery.reconciled') {
    const verdict = p.verdict;
    if (verdict === 'keepUnknown') return null; // 不确定性维持原状（UNKNOWN 未闭环分支继续拦）
    if (verdict === 'notStarted') return 'retained'; // 人工声明（风险确认）——退款但保护保留
    if (verdict === 'executed') {
      if (p.protectionRetained === true) return 'retained'; // alive/身份缺失等取证未确认退出
      // no-os-process=程序事实释放；exited=旧版（≤第八轮）全释放路径——忠实继承历史审计
      //（该路径第九轮起已关闭、不再新产生；其后若有更晚保留事实，事件顺序已覆盖）。
      if (p.exitFact === 'no-os-process' || p.exitFact === 'exited') return 'released';
      return 'retained'; // exitFact 缺失/不可辨认——证据不完整，不默认安全
    }
    return 'retained'; // verdict 缺失/不可辨认——证据不完整，不默认安全
  }
  return null;
}

export const migration042: Migration = {
  id: 42,
  name: 'turn-protection-state-backfill',
  up: (db) => {
    const rows = db.prepare(`
      SELECT turn_id AS turnId, kind AS kind, payload_json AS payload
      FROM domain_events
      WHERE kind IN ('recovery.reconciled', 'recovery.protectionReleased') AND turn_id IS NOT NULL
      ORDER BY seq
    `).all() as Array<{ turnId: string; kind: string; payload: string }>;
    // 事件顺序（seq=落库顺序）：每 turn 取最新保护事实；无事实事件（keepUnknown）不清除先前事实。
    const latest = new Map<string, 'retained' | 'released'>();
    for (const row of rows) {
      const fact = classifyProtectionFact(row.kind, row.payload);
      if (fact != null) latest.set(row.turnId, fact);
    }
    const update = db.prepare(`UPDATE agent_turns SET protection_state = ? WHERE id = ? AND protection_state IS NULL`);
    const tx = db.transaction(() => {
      for (const [turnId, fact] of latest) update.run(fact, turnId);
    });
    tx();
  },
};
