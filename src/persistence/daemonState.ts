/**
 * daemon 运行态键值（迁移 003）：派发门禁（恢复后等待用户确认继续，§16.4-6/决策 44/E7）。
 */
import type { ZhongshuoDatabase } from './db.ts';

const GATE_KEY = 'dispatch_gate';

export function isDispatchGateHeld(db: ZhongshuoDatabase): boolean {
  const row = db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(GATE_KEY) as { value: string } | undefined;
  return row?.value === 'held';
}

/** 用户确认"继续"后开放调度（DEV-07 UI 接入；恢复流程自动落下 held 门禁）。 */
export function openDispatchGate(db: ZhongshuoDatabase, now = Date.now()): void {
  db.prepare(
    `INSERT INTO daemon_state (key, value, updated_at) VALUES (?, 'open', ?)
     ON CONFLICT (key) DO UPDATE SET value = 'open', updated_at = excluded.updated_at`,
  ).run(GATE_KEY, now);
}

export function holdDispatchGate(db: ZhongshuoDatabase, now = Date.now()): void {
  db.prepare(
    `INSERT INTO daemon_state (key, value, updated_at) VALUES (?, 'held', ?)
     ON CONFLICT (key) DO UPDATE SET value = 'held', updated_at = excluded.updated_at`,
  ).run(GATE_KEY, now);
}
