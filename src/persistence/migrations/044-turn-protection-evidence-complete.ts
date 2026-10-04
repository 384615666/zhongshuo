/**
 * 迁移 044（第四十四轮·review-r43 §3）：043 managedEvidence/reason 分支的完整证据校验。
 *
 * 043 的遗留缺口（复核纯函数反例 dist/desktop/review-r43/protection-evidence-result.json）：
 * - managedEvidence 只查「非 null 且 typeof object」——空对象、数组、releasable:false、
 *   activeCount>0/null、缺 rootExited/handlesReleased 的残缺对象都被当作完整受管 Job 证据判 released；
 * - reason 兜底（'protection-released-no-os-process'）本意是**旧事件缺 probe 字段**的受控兼容，
 *   但 043 在 payload 已带相反 probe（如 result:'alive'）时仍用 reason 覆盖——字符串覆盖已知事实。
 *
 * 修正原则（review §3，按 managed/jobManager.ts ReleaseEvidence 真实结构）：
 * - 可信 Job 事实=对象结构+完整字段成立：releasable/rootExited/handlesReleased 全为 true、
 *   activeCount 为数值 0，且同事件携带稳定身份（managedJobId 非空——正式写入方自 REC-LIFE-1
 *   起与 managedEvidence 同发）。jobManager 的 releasable===true 本就蕴含其余三字段，正例不误拦；
 * - 完整 Job 证据优先于落后的普通进程观察（probe alive/unknown 不否决完整 Job）；
 * - probe 存在时按 probe 判定；reason 兜底**仅在 probe 字段缺失**时生效（受控兼容通道）；
 * - 同体矛盾/其余证据不足 → retained（与 043 一致，继续只收紧）。
 *
 * 兼容收口（043 已应用的库）：043 已随 v6 发布冻结、不改写。本迁移对 043 曾按残缺证据放行的
 * released 行做**只降级**修正（V2 released ⊆ 043 released——managedEvidence/reason 两分支均
 * 只收紧，无反向修正）；不动 retained/NULL、不动 041+ 正式代码写入的 released 行（受管路径
 * 事件必含完整 ReleaseEvidence+managedJobId、no-os 路径必含 probe.result='no-os-process'，
 * V2 同判 released）、不清预算、不删数据、不改写任何审计事件。幂等可重跑。
 */
import type { Migration } from '../db.ts';

/** 完整受管 Job 释放证据：结构+全字段+稳定身份（正式写入方与 managedEvidence 同事件携带 managedJobId）。 */
function isCompleteManagedJobEvidence(p: Record<string, unknown>): boolean {
  const m = p.managedEvidence;
  if (m == null || typeof m !== 'object' || Array.isArray(m)) return false;
  const e = m as Record<string, unknown>;
  if (e.releasable !== true || e.rootExited !== true || e.handlesReleased !== true) return false;
  if (typeof e.activeCount !== 'number' || !Number.isInteger(e.activeCount) || e.activeCount !== 0) return false;
  return typeof p.managedJobId === 'string' && p.managedJobId.length > 0;
}

/** 完整分类（第四十四轮）：单条恢复证据事件 → 保护事实（'retained' | 'released' | null）。 */
export function classifyProtectionFactComplete(kind: string, payloadJson: string): 'retained' | 'released' | null {
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
    // 可信正例①：受管 Job 完整结束证据（结构+全字段+稳定身份成立才放行；优先于普通进程观察）。
    if (isCompleteManagedJobEvidence(p)) return 'released';
    const probe = p.probe != null && typeof p.probe === 'object' && !Array.isArray(p.probe)
      ? (p.probe as Record<string, unknown>)
      : null;
    // 可信正例②：no-os-process 程序事实。**已有 probe 时按 probe 判定**——reason 串只在
    // 旧事件缺 probe 字段时兜底（服务端生成、非用户可控），不覆盖已存在的相反 probe 事实。
    if (probe != null) return probe.result === 'no-os-process' ? 'released' : 'retained';
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
      // 含 exited：周期快照不构成「全部受管执行已结束」的完整证明——不追认（与 043 同判）。
      return 'retained';
    }
    return 'retained'; // verdict 缺失/不可辨认——证据不完整，不默认安全
  }
  return null;
}

export const migration044: Migration = {
  id: 44,
  name: 'turn-protection-evidence-complete',
  up: (db) => {
    const rows = db.prepare(`
      SELECT turn_id AS turnId, kind AS kind, payload_json AS payload
      FROM domain_events
      WHERE kind IN ('recovery.reconciled', 'recovery.protectionReleased') AND turn_id IS NOT NULL
      ORDER BY seq
    `).all() as Array<{ turnId: string; kind: string; payload: string }>;
    // 事件顺序（seq=落库顺序）取每 turn 最新保护事实（与 042/043 同规则，分类器换完整证据版）。
    const latest = new Map<string, 'retained' | 'released'>();
    for (const row of rows) {
      const fact = classifyProtectionFactComplete(row.kind, row.payload);
      if (fact != null) latest.set(row.turnId, fact);
    }
    // 只降级：完整分类判 retained 而 043 曾按残缺证据放行的行改为 retained。
    // 完整分类的 released 集合是 043 的子集（只收紧），无反向修正；041+ 正式代码写入的
    // released 行事件必含完整证据，完整分类同判 released——不受影响。
    const downgrade = db.prepare(`UPDATE agent_turns SET protection_state = 'retained' WHERE id = ? AND protection_state = 'released'`);
    const tx = db.transaction(() => {
      for (const [turnId, fact] of latest) {
        if (fact === 'retained') downgrade.run(turnId);
      }
    });
    tx();
  },
};
