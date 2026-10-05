/**
 * 统一派发准入（2026-09-28 第四轮）：并发限制的单一账本（与预算分开——预算限调用总量，
 * 准入限同时运行数量，两者不混用）。
 *
 * 维度：
 * - global：应用级总在途 turn 上限；
 * - project：项目级在途上限（一项目占满不饿死其他项目——拒绝方进入 skip 重试，其他项目照常领取）；
 * - provider：runtime kind/installation 级上限（渠道/CLI 并发保护）；
 * - member：成员级串行（恒 1——同成员 runtime 会话串行语义）；
 * - writeRoot：需要写入时的物理目录单写者（同 canonical_path 组串行）。当前全只读档
 *   （plan/analyze）不占写槽；写档接入点就绪（B6 扩展时把 tier=写 的任务带 writeRootKey 准入），
 *   本轮不恢复延期的并行写入增强（默认单写者语义不变）。
 *
 * 占位语义：准入在 openSession/startTurn **启动窗口之前**（dispatchClaimed 解析出成员/项目/
 * provider 即判定并占位）；完成/失败/取消/启动失败由消费器/派发异常路径释放；结果不确定
 * （UNKNOWN）**保留占用**（不提前放行——对账未定，恢复路径另行收口）。
 *
 * 阶段泵只入队 outbox；一切启动必经 worker claim→dispatchClaimed→本准入（泵不能绕过准入
 * 直接启动下一阶段——结构保证）。
 */
export interface AdmissionDimensions {
  memberId: string;
  projectId: string;
  providerKey: string;
  /** 写类任务的物理目录（canonical_path）；只读为 null（不占写槽）。 */
  writeRootKey: string | null;
}

export interface AdmissionLimits {
  globalMaxInFlight: number;
  perProjectMaxInFlight: number;
  perProviderMaxInFlight: number;
}

export type AdmissionDeniedReason = 'global' | 'project' | 'provider' | 'member' | 'write-root';

export type AdmissionDecision = { granted: true } | { granted: false; reason: AdmissionDeniedReason };

export class DispatchAdmission {
  private readonly limits: AdmissionLimits;
  private readonly held = new Map<string, AdmissionDimensions>();

  constructor(limits?: Partial<AdmissionLimits>) {
    this.limits = {
      globalMaxInFlight: limits?.globalMaxInFlight ?? envInt('ZS_MAX_INFLIGHT_GLOBAL', 4),
      perProjectMaxInFlight: limits?.perProjectMaxInFlight ?? envInt('ZS_MAX_INFLIGHT_PROJECT', 2),
      perProviderMaxInFlight: limits?.perProviderMaxInFlight ?? envInt('ZS_MAX_INFLIGHT_PROVIDER', 2),
    };
  }

  /** 判定并占位（原子）：任一维度满即拒绝且不占位。 */
  tryAcquire(turnId: string, dims: AdmissionDimensions): AdmissionDecision {
    if (this.count((d) => d.memberId === dims.memberId) >= 1) return { granted: false, reason: 'member' };
    if (dims.writeRootKey != null && this.count((d) => d.writeRootKey === dims.writeRootKey) >= 1) {
      return { granted: false, reason: 'write-root' };
    }
    if (this.count((d) => d.projectId === dims.projectId) >= this.limits.perProjectMaxInFlight) {
      return { granted: false, reason: 'project' };
    }
    if (this.count((d) => d.providerKey === dims.providerKey) >= this.limits.perProviderMaxInFlight) {
      return { granted: false, reason: 'provider' };
    }
    if (this.held.size >= this.limits.globalMaxInFlight) return { granted: false, reason: 'global' };
    this.held.set(turnId, dims);
    return { granted: true };
  }

  /** 释放占位（完成/失败/取消/启动失败）。未知终态不释放（对账未定，不提前放行）。 */
  release(turnId: string): boolean {
    return this.held.delete(turnId);
  }

  /**
   * 从持久事实恢复占位（r57，review-r56 §2）：重启后 admission 内存清空，但 UNKNOWN/
   * retained/在途 turn 的占用是**持久合同**（对账未定不提前放行；确认继续≠退出证明）。
   * 恢复不查限额——持久事实是既成占用（超限如实，不静默丢弃）；同 turnId 幂等。
   * 释放仍走既有路径（recovery.reconcile/releaseProtection → releaseAdmission 联动）。
   */
  restore(turnId: string, dims: AdmissionDimensions): void {
    if (this.held.has(turnId)) return;
    this.held.set(turnId, dims);
  }

  /** 强制释放（stop 收敛/强制退出路径专用——恢复语义由调用方记录）。 */
  forceReleaseAll(): Array<{ turnId: string; dims: AdmissionDimensions }> {
    const all = [...this.held.entries()].map(([turnId, dims]) => ({ turnId, dims }));
    this.held.clear();
    return all;
  }

  has(turnId: string): boolean {
    return this.held.has(turnId);
  }

  snapshot(): { global: number; byProject: Record<string, number>; byProvider: Record<string, number>; byMember: Record<string, number> } {
    const byProject: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    const byMember: Record<string, number> = {};
    for (const d of this.held.values()) {
      byProject[d.projectId] = (byProject[d.projectId] ?? 0) + 1;
      byProvider[d.providerKey] = (byProvider[d.providerKey] ?? 0) + 1;
      byMember[d.memberId] = (byMember[d.memberId] ?? 0) + 1;
    }
    return { global: this.held.size, byProject, byProvider, byMember };
  }

  private count(where: (d: AdmissionDimensions) => boolean): number {
    let n = 0;
    for (const d of this.held.values()) if (where(d)) n += 1;
    return n;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.length === 0) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 物理目录写入占位注册表（DEV-12 修复④，2026-09-28）：同一物理目录（含 junction/symlink/
 * 父子目录重叠——lockDomainsOverlap 判定）同时只允许一个受管理写入占位者。
 *
 * 这是**统一约束点**：DEV-12 撤销执行在此占位；B6 写档任务派发接入时，worker 准入的
 * writeRoot 维度也经同一注册表占位（派发侧另有 DispatchAdmission 的并发计数——两者不混：
 * 本注册表只管物理目录互斥）。完整接通前写档能力保持关闭（并行写入增强仍延期）。
 */
export class PhysicalWriteRootRegistry {
  private readonly held = new Map<string, string>(); // identityKey → holder 描述
  private readonly overlap: (a: string, b: string) => boolean;

  constructor(overlap: (a: string, b: string) => boolean) {
    this.overlap = overlap;
  }

  tryAcquire(identityKey: string, holder: string): { granted: true } | { granted: false; holders: string[] } {
    const overlapping: string[] = [];
    for (const [key, h] of this.held) {
      if (this.overlap(key, identityKey)) overlapping.push(`${h}（${key}）`);
    }
    if (overlapping.length > 0) return { granted: false, holders: overlapping };
    this.held.set(identityKey, holder);
    return { granted: true };
  }

  release(identityKey: string): boolean {
    return this.held.delete(identityKey);
  }
}
