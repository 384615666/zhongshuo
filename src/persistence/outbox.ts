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
  /** 意图入队时的任务停止代次（迁移 034；-1=旧行无快照）。 */
  stop_generation_at_enqueue?: number;
}

/** 任务的当前停止代次（无任务行=0——首派意图）。 */
export function stopGenerationOfTask(db: ZhongshuoDatabase, taskId: string | null | undefined): number {
  if (taskId == null) return 0;
  const row = db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(taskId) as { stop_generation: number } | undefined;
  return row?.stop_generation ?? 0;
}

/**
 * 入队：与业务写入同事务调用。重复 dispatchKey 幂等返回既有行
 * （RT-05：重复完成事件不二次派发）。stopGenerationAtEnqueue=意图入队代次快照（迁移 034
 * ——领取判定据此区分「合法等待」与「被新停止超越」；缺省读任务当前代次）。
 */
export function enqueueOutbox(
  db: ZhongshuoDatabase,
  item: { dispatchKey: string; turnId?: string | null; stopGenerationAtEnqueue?: number },
): OutboxRow {
  const existing = db
    .prepare('SELECT * FROM outbox WHERE dispatch_key = ?')
    .get(item.dispatchKey) as OutboxRow | undefined;
  if (existing != null) return existing;
  const gen = item.stopGenerationAtEnqueue ?? -1;
  const info = db
    .prepare('INSERT INTO outbox (dispatch_key, turn_id, stop_generation_at_enqueue) VALUES (?, ?, ?)')
    .run(item.dispatchKey, item.turnId ?? null, gen);
  return {
    id: Number(info.lastInsertRowid),
    dispatch_key: item.dispatchKey,
    turn_id: item.turnId ?? null,
    status: 'pending',
    lease_owner: null,
    lease_until: null,
    attempt_epoch: 0,
    stop_generation_at_enqueue: gen,
  };
}

/**
 * CAS 领取：pending 或租约已过期的行，原子置为 leased 并推进 attemptEpoch。
 * skipIds：跳过指定行（成员级在途互斥的排队项——不领取、不推进，保持 pending）。
 * 无可领取项返回 null。
 */
export function claimNextOutbox(
  db: ZhongshuoDatabase,
  claim: { leaseOwner: string; leaseUntil: number; now: number; skipIds?: number[] },
): OutboxRow | null {
  const skip = (claim.skipIds ?? []).filter((id) => Number.isInteger(id));
  const notIn = skip.length > 0 ? `AND id NOT IN (${skip.map(() => '?').join(',')})` : '';
  const row = db
    .prepare(
      `UPDATE outbox SET status = 'leased', lease_owner = ?, lease_until = ?, attempt_epoch = attempt_epoch + 1
       WHERE id IN (
         SELECT id FROM outbox
         WHERE (status = 'pending' OR (status = 'leased' AND lease_until IS NOT NULL AND lease_until < ?))
         ${notIn}
         ORDER BY id LIMIT 1
       )
       RETURNING *`,
    )
    .get(claim.leaseOwner, claim.leaseUntil, claim.now, ...skip) as OutboxRow | undefined;
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

/** 放回 pending（成员级互斥暂不派发）：仅持当前代次可放回，防跨 worker 误放。 */
export function releaseOutbox(db: ZhongshuoDatabase, id: number, attemptEpoch: number): boolean {
  const info = db
    .prepare(
      `UPDATE outbox SET status = 'pending', lease_owner = NULL, lease_until = NULL
       WHERE id = ? AND attempt_epoch = ? AND status = 'leased'`,
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
