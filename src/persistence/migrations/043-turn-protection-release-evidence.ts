/**
 * 迁移 043（第四十三轮·review-r42 §4）：保护回填分类的保守化修正。
 *
 * 042 的宽松判定缺口（复核纯函数反例 dist/desktop/review-r42/protection-classification-result.json）：
 * - `recovery.protectionReleased` 只要 released===true 即判 released——未检查矛盾
 *   （released:true 与 protectionRetained:true 同体=矛盾，按合同应保守 retained）；
 * - released:true 但 probe.result=alive/unknown/identity-missing/exited 等非完整释放证据时
 *   仍判 released——「审计曾写释放」与「当前合同下的完整退出证明」不是同一事实
 *   （recovery.releaseProtection 明确拒绝周期快照 exited 观察，含旧版本观察）；
 * - reconciled executed+exitFact='exited' 被追认为 released——同样不构成完整退出证明。
 *
 * 修正原则（review §4）：**保守分类+可信正例不误拦**：
 * - 同体矛盾（protectionRetained===true）一律 retained——优先于一切释放证据；
 * - 可信完整释放正例=受管 Job 证据（payload.managedEvidence 对象——服务端在
 *   evidence.releasable 核验通过后才写入）或 no-os-process 程序事实（probe.result，或旧版
 *   事件缺 probe 字段时的服务端生成 reason 串）——保持 released，不误拦；
 * - 其余 released:true（alive/unknown/identity-missing/exited、缺证据）→ retained——
 *   历史观察不追认为新标准下的完整证据；
 * - 证据损坏/字段缺失/不可辨认 → retained（不默认安全，与 042 一致）。
 *
 * 兼容收口（042 已应用的库）：本迁移**只把 released 降级为 retained**（strict 分类下证据
 * 不足的行）；不动 retained/NULL、不动 041+ 正式代码写入的 released 行（其事件必含可信
 * 证据，strict 分类同判 released）、不清预算、不删数据、不改写任何审计事件。幂等可重跑。
 */
import type { Migration } from '../db.ts';

/** 保守分类（第四十三轮）：单条恢复证据事件 → 保护事实（'retained' | 'released' | null）。 */
export function classifyProtectionFactStrict(kind: string, payloadJson: string): 'retained' | 'released' | null {
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
    // 可信正例①：受管 Job 完整结束证据（releaseEvidence().releasable 核验通过才写入）。
    if (p.managedEvidence != null && typeof p.managedEvidence === 'object') return 'released';
    const probe = p.probe != null && typeof p.probe === 'object' && !Array.isArray(p.probe)
      ? (p.probe as Record<string, unknown>)
      : null;
    // 可信正例②：no-os-process 程序事实（无子进程模型——无 OS 遗留进程可能）。
    if (probe != null && probe.result === 'no-os-process') return 'released';
    // 可信正例②兜底：旧版事件缺 probe 字段时的服务端生成 reason 串（非用户可控输入）。
    if (p.reason === 'protection-released-no-os-process') return 'released';
    // 其余（alive/unknown/identity-missing/exited、缺证据）：审计曾写释放≠完整退出证明——保守保留。
    return 'retained';
  }
  if (kind === 'recovery.reconciled') {
    const verdict = p.verdict;
    if (verdict === 'keepUnknown') return null; // 不确定性维持原状（UNKNOWN 未闭环分支继续拦）
    if (verdict === 'notStarted') return 'retained'; // 人工声明（风险确认）——退款但保护保留
    if (verdict === 'executed') {
      if (p.exitFact === 'no-os-process') return 'released'; // 程序事实释放（正例不误拦）
      // 含 exited：周期快照不构成「全部受管执行已结束」的完整证明（第九轮起该路径已关闭、
      // releaseProtection 对含旧版本的 exited 观察防御性拒绝）——不追认为完整退出证据。
      return 'retained';
    }
    return 'retained'; // verdict 缺失/不可辨认——证据不完整，不默认安全
  }
  return null;
}

export const migration043: Migration = {
  id: 43,
  name: 'turn-protection-release-evidence',
  up: (db) => {
    const rows = db.prepare(`
      SELECT turn_id AS turnId, kind AS kind, payload_json AS payload
      FROM domain_events
      WHERE kind IN ('recovery.reconciled', 'recovery.protectionReleased') AND turn_id IS NOT NULL
      ORDER BY seq
    `).all() as Array<{ turnId: string; kind: string; payload: string }>;
    // 事件顺序（seq=落库顺序）取每 turn 最新保护事实（与 042 同规则，分类器换保守版）。
    const latest = new Map<string, 'retained' | 'released'>();
    for (const row of rows) {
      const fact = classifyProtectionFactStrict(row.kind, row.payload);
      if (fact != null) latest.set(row.turnId, fact);
    }
    // 只降级：strict 判 retained 而 042/宽松路径曾写 released 的行改为 retained。
    // strict 的 released 集合是宽松版的子集（只收紧），故不存在需要反向修正的行；
    // 041+ 正式代码写入的 released 行事件必含可信证据，strict 同判 released——不受影响。
    const downgrade = db.prepare(`UPDATE agent_turns SET protection_state = 'retained' WHERE id = ? AND protection_state = 'released'`);
    const tx = db.transaction(() => {
      for (const [turnId, fact] of latest) {
        if (fact === 'retained') downgrade.run(turnId);
      }
    });
    tx();
  },
};
