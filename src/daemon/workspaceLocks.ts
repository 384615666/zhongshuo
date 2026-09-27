/**
 * 写入租约（§10.3/§12.2 workspace_leases/RT-07/RT-08/RT-09）。
 * - 锁域=identityKey；重叠判定（父子/junction）在 acquire 时逐租约检查。
 * - single_writer：同一锁域同时最多 1 个活跃租约，其他任务排队并可见持有者。
 * - parallel_writers：允许共存（上限由上层按项目设置执行，ADR-I14）。
 * - RT-07：租约过期不给新写者放行，直到旧持有者被确认终止。
 */
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';
import { lockDomainsOverlap } from './directoryIdentity.ts';

export interface LeaseRow {
  lock_domain: string;
  owner_turn_id: string;
  epoch: number;
  heartbeat_at: number;
  status: 'active' | 'released' | 'expired';
}

export interface AcquireLeaseInput {
  lockDomain: string;
  ownerTurnId: string;
  policy: 'single_writer' | 'parallel_writers';
  now: number;
}

export interface LeaseHolderInfo {
  ownerTurnId: string;
  lockDomain: string;
  status: string;
  heartbeatAt: number;
}

export interface AcquireLeaseOk {
  granted: true;
  epoch: number;
}

/**
 * 申请写入租约。
 * - 冲突时返回 WORKSPACE_BUSY 并列出全部重叠持有者（排队可见）。
 * - RT-07：`active` 与 `expired`（心跳超时但持有者未确认终止）都阻塞新写者；
 *   只有 `released`（正常释放或确认终止）才放行。
 * - parallel_writers 已按 §14.7 延期（ADR-I19）：入口一律拒绝，调用方无法绕过开启。
 */
export function acquireLease(
  db: ZhongshuoDatabase,
  input: AcquireLeaseInput,
): DomainResult<AcquireLeaseOk> {
  if (input.policy !== 'single_writer') {
    return domainErr(
      'CAPABILITY_UNSUPPORTED',
      'parallel_writers 写入并发策略已延期、未批准施工（§14.7/ADR-I19）；当前仅开放 single_writer',
    );
  }
  // 未确认释放的租约（active 或 expired）都是潜在持有者。
  const rows = db
    .prepare("SELECT * FROM workspace_leases WHERE status != 'released'")
    .all() as LeaseRow[];
  const overlapping = rows.filter((row) => lockDomainsOverlap(row.lock_domain, input.lockDomain));
  if (overlapping.length > 0) {
    return busy(overlapping);
  }

  const prev = db
    .prepare('SELECT * FROM workspace_leases WHERE lock_domain = ? AND owner_turn_id = ?')
    .get(input.lockDomain, input.ownerTurnId) as LeaseRow | undefined;
  const epoch = (prev?.epoch ?? 0) + 1;
  db.prepare(
    `INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status)
     VALUES (?, ?, ?, ?, 'active')
     ON CONFLICT (lock_domain, owner_turn_id) DO UPDATE SET
       epoch = excluded.epoch, heartbeat_at = excluded.heartbeat_at, status = 'active'`,
  ).run(input.lockDomain, input.ownerTurnId, epoch, input.now);
  return domainOk({ granted: true, epoch });
}

function busy(holders: LeaseRow[]): DomainResult<never> {
  return domainErr('WORKSPACE_BUSY', '写入目录被占用：排队并显示持有者（§16.5）', {
    details: {
      holders: holders.map<LeaseHolderInfo>((h) => ({
        ownerTurnId: h.owner_turn_id,
        lockDomain: h.lock_domain,
        status: h.status,
        heartbeatAt: h.heartbeat_at,
      })),
    },
  });
}

export function heartbeatLease(
  db: ZhongshuoDatabase,
  input: { lockDomain: string; ownerTurnId: string; now: number },
): void {
  db.prepare(
    `UPDATE workspace_leases SET heartbeat_at = ? WHERE lock_domain = ? AND owner_turn_id = ? AND status = 'active'`,
  ).run(input.now, input.lockDomain, input.ownerTurnId);
}

/** 正常释放（写入者完成/停止确认后）。 */
export function releaseLease(
  db: ZhongshuoDatabase,
  input: { lockDomain: string; ownerTurnId: string },
): void {
  db.prepare(
    `UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`,
  ).run(input.lockDomain, input.ownerTurnId);
}

/** 旧租约心跳超时：标记 expired（仍阻塞新写者，直到确认终止，RT-07）。 */
export function markExpiredLeases(db: ZhongshuoDatabase, now: number, heartbeatTimeoutMs: number): void {
  db.prepare(
    `UPDATE workspace_leases SET status = 'expired'
     WHERE status = 'active' AND heartbeat_at < ?`,
  ).run(now - heartbeatTimeoutMs);
}

/** 确认旧持有者已终止（进程树核实由 DEV-05 supervisor 承担）：解除 RT-07 阻塞。 */
export function confirmLeaseTerminated(
  db: ZhongshuoDatabase,
  input: { lockDomain: string; ownerTurnId: string },
): void {
  db.prepare(
    `UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`,
  ).run(input.lockDomain, input.ownerTurnId);
}

export function listActiveLeases(db: ZhongshuoDatabase): LeaseRow[] {
  return db.prepare("SELECT * FROM workspace_leases WHERE status != 'released'").all() as LeaseRow[];
}
