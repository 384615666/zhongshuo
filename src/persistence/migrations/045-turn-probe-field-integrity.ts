/**
 * 迁移 045（第四十五轮·review-r44 §2）：044 probe 字段完整性——「缺字段」与「结构损坏」分离。
 *
 * 044 的遗留缺口（复核纯函数反例 dist/desktop/review-r44-independent/boundary-result.json）：
 * probe 字段**存在**但为 null/数组/false/字符串等非对象形态时，044 的归一化把「字段损坏」
 * 折叠成「字段缺失」（probe 归 null 后落到 reason 兜底）——四种已带 probe 字段的损坏审计
 * 被判 released：
 *   {"released":true,"reason":"protection-released-no-os-process","probe":null|[]|false|"broken"}
 *
 * 修正原则（review §2）：
 * - `Object.hasOwn(p,'probe')` 区分**真正缺字段**（受控旧兼容：reason 兜底允许）与
 *   **已有字段但结构损坏**（证据完整性破坏——保守 retained，不默认安全）；
 * - probe 为对象时按 result 判定（no-os-process→released；其余→retained）——与 044 一致；
 * - 完整受管 Job 证据（结构+全字段+managedJobId）仍优先于 probe 观察（含损坏 probe）；
 * - 同体矛盾最高优先、reconciled 分支语义均与 042/043/044 一致，只收紧本分支。
 *
 * 兼容收口（044 已应用的库）：044 已提交发布冻结、不改写。本迁移对 044 曾按「损坏 probe+
 * reason 兜底」放行的 released 行做**只降级**修正（本版 released ⊆ 044 released——仅收紧）；
 * 不动 retained/NULL、不动正式代码写入的 released 行、不清预算、不删数据、不改写审计。幂等。
 */
import type { Migration } from '../db.ts';

/** 完整受管 Job 释放证据（与 044 同判：结构+全字段+稳定身份）。 */
function isCompleteManagedJobEvidence(p: Record<string, unknown>): boolean {
  const m = p.managedEvidence;
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return false;
  const e = m as Record<string, unknown>;
  if (e.releasable !== true || e.rootExited !== true || e.handlesReleased !== true) return false;
  if (typeof e.activeCount !== 'number' || !Number.isInteger(e.activeCount) || e.activeCount !== 0) return false;
  return typeof p.managedJobId === 'string' && p.managedJobId.length > 0;
}

/** 最终分类（第四十五轮）：单条恢复证据事件 → 保护事实（'retained' | 'released' | null）。 */
export function classifyProtectionFactFinal(kind: string, payloadJson: string): 'retained' | 'released' | null {
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
  // 同体矛盾最高优先：released:true 与 protectionRetained:true 并存=证据自相矛盾——保守保留。
  if (p.protectionRetained === true) return 'retained';
  if (kind === 'recovery.protectionReleased') {
    if (p.released !== true) return 'retained'; // 拒绝（released:false）或字段缺失——保留
    // 可信正例①：受管 Job 完整结束证据（优先于任何 probe 观察——完整 Job 事实层级更高）。
    if (isCompleteManagedJobEvidence(p)) return 'released';
    // 可信正例②：probe **字段在且结构完好**时按 probe 判定；**字段在但损坏**（null/数组/
    // false/字符串等非对象）=证据完整性破坏——保守 retained（与「缺字段」的受控旧兼容分开）。
    if (Object.hasOwn(p, 'probe')) {
      const probe = p.probe;
      if (probe == null || typeof probe !== 'object' || Array.isArray(probe)) return 'retained';
      return (probe as Record<string, unknown>).result === 'no-os-process' ? 'released' : 'retained';
    }
    // reason 兜底：仅**真正缺 probe 字段**的旧事件（服务端生成、非用户可控）。
    if (p.reason === 'protection-released-no-os-process') return 'released';
    // 其余（缺证据）：审计曾写释放≠完整退出证明——保守保留。
    return 'retained';
  }
  if (kind === 'recovery.reconciled') {
    const verdict = p.verdict;
    if (verdict === 'keepUnknown') return null; // 不确定性维持原状（UNKNOWN 未闭环分支继续拦）
    if (verdict === 'notStarted') return 'retained'; // 人工声明（风险确认）——退款但保护保留
    if (verdict === 'executed') {
      if (p.exitFact === 'no-os-process') return 'released'; // 程序事实释放（正例不误拦）
      // 含 exited：周期快照不构成「全部受管执行已结束」的完整证明——不追认（与 042/043/044 同判）。
      return 'retained';
    }
    return 'retained'; // verdict 缺失/不可辨认——证据不完整，不默认安全
  }
  return null;
}

export const migration045: Migration = {
  id: 45,
  name: 'turn-probe-field-integrity',
  up: (db) => {
    const rows = db.prepare(`
      SELECT turn_id AS turnId, kind AS kind, payload_json AS payload
      FROM domain_events
      WHERE kind IN ('recovery.reconciled', 'recovery.protectionReleased') AND turn_id IS NOT NULL
      ORDER BY seq
    `).all() as Array<{ turnId: string; kind: string; payload: string }>;
    // 事件顺序（seq=落库顺序）取每 turn 最新保护事实（与 042/043/044 同规则，分类器换最终版）。
    const latest = new Map<string, 'retained' | 'released'>();
    for (const row of rows) {
      const fact = classifyProtectionFactFinal(row.kind, row.payload);
      if (fact != null) latest.set(row.turnId, fact);
    }
    // 只降级：最终分类判 retained 而 044 曾按「损坏 probe+reason 兜底」放行的行改为 retained。
    // 最终版 released ⊆ 044 released（仅收紧），无反向修正；正式代码写入的 released 行事件
    // 必含完好 probe 或完整 Job 证据，最终版同判 released——不受影响。
    const downgrade = db.prepare(`UPDATE agent_turns SET protection_state = 'retained' WHERE id = ? AND protection_state = 'released'`);
    const tx = db.transaction(() => {
      for (const [turnId, fact] of latest) {
        if (fact === 'retained') downgrade.run(turnId);
      }
    });
    tx();
  },
};
