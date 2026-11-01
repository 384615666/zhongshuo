/** Daemon-owned durable stop evidence. Runtime output is never an input. */
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { RegistryDb } from './processRegistry.ts';

const LAST = 'daemon:stop:last';
const HISTORY = 'daemon:stop:history:';

interface CompletedStop {
  pid: number;
  at: number;
  phase: 'closed' | 'forced-closed';
  stopRequestsSentTo: string[];
}

export interface CompletedStopEvidence {
  record: CompletedStop;
  persistedAt: number;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseCompletedStop(raw: string): CompletedStop | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const stop = value as Record<string, unknown>;
  if (!positiveInteger(stop.pid) || !positiveInteger(stop.at)
    || (stop.phase !== 'closed' && stop.phase !== 'forced-closed')
    || !Array.isArray(stop.stopRequestsSentTo) || stop.stopRequestsSentTo.length === 0
    || !stop.stopRequestsSentTo.every(id => typeof id === 'string' && id.length > 0)) return null;
  return { pid: stop.pid, at: stop.at, phase: stop.phase,
    stopRequestsSentTo: [...new Set(stop.stopRequestsSentTo as string[])].sort() };
}

function historyKey(stop: CompletedStop): string { return `${HISTORY}${stop.pid}:${stop.at}`; }
function identity(stop: CompletedStop): string {
  return JSON.stringify([stop.pid, stop.at, stop.phase, stop.stopRequestsSentTo]);
}

/** Preserve original bytes and persistence time; a collision never overwrites evidence. */
export function persistDaemonStopRecord(db: ZhongshuoDatabase, record: Record<string, unknown>, now = Date.now()): void {
  const value = JSON.stringify(record);
  db.transaction(() => {
    const archive = (raw: string, persistedAt: number): void => {
      const stop = parseCompletedStop(raw);
      if (stop == null) return;
      if (!positiveInteger(persistedAt) || persistedAt < stop.at) throw new Error('停机记录持久化时间无效');
      const key = historyKey(stop);
      const existing = db.prepare('SELECT value,updated_at FROM daemon_state WHERE key=?').get(key) as { value: string; updated_at: number } | undefined;
      if (existing != null) {
        const prior = parseCompletedStop(existing.value);
        if (prior == null || identity(prior) !== identity(stop)
          || !positiveInteger(existing.updated_at) || existing.updated_at < prior.at) throw new Error('停机历史身份冲突，保留原记录');
        // Identical repeats retain the earliest actual persistence timestamp.
        if (persistedAt < existing.updated_at) db.prepare('UPDATE daemon_state SET value=?,updated_at=? WHERE key=?').run(raw, persistedAt, key);
        return;
      }
      db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?)').run(key, raw, persistedAt);
    };
    const previous = db.prepare('SELECT value,updated_at FROM daemon_state WHERE key=?').get(LAST) as { value: string; updated_at: number } | undefined;
    if (previous != null) archive(previous.value, previous.updated_at);
    archive(value, now);
    db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(LAST, value, now);
  })();
}

/** Only the daemon DB is trusted. Distinct completed bindings are ambiguous,
 * even if one owner happens to be absent from the current OS process table. */
export function selectCompletedDaemonStop(db: RegistryDb, turnId: string): CompletedStopEvidence | undefined {
  const rows = db.prepare("SELECT key,value,updated_at FROM daemon_state WHERE key='daemon:stop:last' OR key GLOB 'daemon:stop:history:*'").all() as Array<{ key: string; value: string; updated_at: number }>;
  const candidates = new Map<string, CompletedStopEvidence>();
  for (const row of rows) {
    const stop = parseCompletedStop(row.value);
    const historical = row.key.startsWith(HISTORY);
    if (historical && (stop == null || row.key !== historyKey(stop))) throw new Error('停机历史键与身份不符');
    if (stop == null || !stop.stopRequestsSentTo.includes(turnId)) continue;
    if (!positiveInteger(row.updated_at) || row.updated_at < stop.at) throw new Error('停机记录持久化时间无效');
    const key = identity(stop);
    const existing = candidates.get(key);
    if (existing == null || row.updated_at < existing.persistedAt) candidates.set(key, { record: stop, persistedAt: row.updated_at });
  }
  if (candidates.size > 1) throw new Error('目标 turn 存在冲突的已完成停机记录');
  return candidates.values().next().value;
}
