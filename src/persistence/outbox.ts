/**
 * Transactional Outbox（§11.2/§11.3）：dispatch_key 唯一（outbox_dispatch_once）；
 * worker CAS 领取、租约超时回收、按 attemptEpoch fencing 完结。
 */
import type { ZhongshuoDatabase } from './db.ts';

export type OutboxStatus = 'pending' | 'leased' | 'done' | 'failed';

export interface OutboxRow {
  id: number;
  dispatch_key: string;
  turn_id: string | null;
  status: OutboxStatus;
  lease_owner: string | null;
  lease_until: number | null;
  attempt_epoch: number;
}

/**
 * 入队：与业务写入同事务调用。重复 dispatchKey 幂等返回既有行
 * （RT-05：重复完成事件不二次派发）。
 */
export function enqueueOutbox(
  db: ZhongshuoDatabase,
  item: { dispatchKey: string; turnId?: string | null },
): OutboxRow {
  const existing = db
    .prepare('SELECT * FROM outbox WHERE dispatch_key = ?')
    .get(item.dispatchKey) as OutboxRow | undefined;
  if (existing != null) return existing;
  const info = db
    .prepare('INSERT INTO outbox (dispatch_key, turn_id) VALUES (?, ?)')
    .run(item.dispatchKey, item.turnId ?? null);
  return {
    id: Number(info.lastInsertRowid),
    dispatch_key: item.dispatchKey,
    turn_id: item.turnId ?? null,
    status: 'pending',
    lease_owner: null,
    lease_until: null,
    attempt_epoch: 0,
  };
}

/**
 * CAS 领取：pending 或租约已过期的行，原子置为 leased 并推进 attemptEpoch。
 * 无可领取项返回 null。
 */
export function claimNextOutbox(
  db: ZhongshuoDatabase,
  claim: { leaseOwner: string; leaseUntil: number; now: number },
): OutboxRow | null {
  const row = db
    .prepare(
      `UPDATE outbox SET status = 'leased', lease_owner = ?, lease_until = ?, attempt_epoch = attempt_epoch + 1
       WHERE id IN (
         SELECT id FROM outbox
         WHERE status = 'pending' OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until < ?)
         ORDER BY id LIMIT 1
       )
       RETURNING *`,
    )
    .get(claim.leaseOwner, claim.leaseUntil, claim.now) as OutboxRow | undefined;
  return row ?? null;
}

/** 完结：仅持当前租约/代次的 worker 可置 done。 */
export function completeOutbox(db: ZhongshuoDatabase, id: number, attemptEpoch: number): boolean {
  const info = db
    .prepare(
      `UPDATE outbox SET status = 'done', lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND attempt_epoch = ?`,
    )
    .run(id, attemptEpoch);
  return info.changes > 0;
}

/** 失败：保留行供重试/审计。 */
export function failOutbox(db: ZhongshuoDatabase, id: number, attemptEpoch: number): boolean {
  const info = db
    .prepare(`UPDATE outbox SET status = 'failed' WHERE id = ? AND attempt_epoch = ?`)
    .run(id, attemptEpoch);
  return info.changes > 0;
}

export function listOutbox(db: ZhongshuoDatabase, status?: OutboxStatus): OutboxRow[] {
  if (status == null) {
    return db.prepare('SELECT * FROM outbox ORDER BY id').all() as OutboxRow[];
  }
  return db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY id').all(status) as OutboxRow[];
}
