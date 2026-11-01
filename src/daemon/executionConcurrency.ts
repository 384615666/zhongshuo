import { z } from 'zod';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { DEFAULT_EXECUTION_CONCURRENCY, EXECUTION_CONCURRENCY_KEY, executionConcurrencyLimitsSchema, type ExecutionConcurrencySettings } from '../contracts/executionConcurrency.ts';

const savedSchema = z.strictObject({ revision: z.number().int().nonnegative(), limits: executionConcurrencyLimitsSchema });
export function readExecutionConcurrency(db: ZhongshuoDatabase): ExecutionConcurrencySettings {
  const row = db.prepare('SELECT value FROM daemon_state WHERE key=?').get(EXECUTION_CONCURRENCY_KEY) as { value: string } | undefined;
  if (row) {
    // Corrupt stored limits must not silently permit more work.
    return { ...savedSchema.parse(JSON.parse(row.value)), source: 'saved' };
  }
  const limits = { ...DEFAULT_EXECUTION_CONCURRENCY };
  let environment = false;
  for (const [key, name] of [
    ['globalMaxInFlight', 'ZS_MAX_INFLIGHT_GLOBAL'],
    ['perProjectMaxInFlight', 'ZS_MAX_INFLIGHT_PROJECT'],
    ['perProviderMaxInFlight', 'ZS_MAX_INFLIGHT_PROVIDER'],
  ] as const) {
    const raw = process.env[name];
    const value = Number(raw);
    if (raw && Number.isInteger(value) && value > 0) { limits[key] = Math.min(value, 32); environment = true; }
  }
  return { revision: 0, limits, source: environment ? 'environment' : 'default' };
}

type Fail = (code: string, message: string) => never;
type Runner = <T>(handler: () => T, replayGuard?: () => void) => { data: T; replayed: boolean };
export function executionConcurrencyCommand(db: ZhongshuoDatabase, method: string, params: unknown, run: Runner, fail: Fail, remote: boolean) {
  if (method !== 'app.executionConcurrency.get' && method !== 'app.executionConcurrency.set') return null;
  if (method === 'app.executionConcurrency.get') {
    z.strictObject({}).parse(params);
    return { data: readExecutionConcurrency(db) };
  }
  if (remote) fail('FORBIDDEN', '执行并发设置仅限本机修改');
  const input = z.strictObject({ expectedRevision: z.number().int().nonnegative(), limits: executionConcurrencyLimitsSchema }).parse(params);
  return run(() => {
    const before = readExecutionConcurrency(db);
    if (before.revision !== input.expectedRevision) fail('STALE_REVISION', '执行并发设置已变化，请重新读取后保存');
    const next = { revision: before.revision + 1, limits: input.limits };
    db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(EXECUTION_CONCURRENCY_KEY, JSON.stringify(next), Date.now());
    return { ...next, source: 'saved' as const };
  });
}
