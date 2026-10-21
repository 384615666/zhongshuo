import type { ZhongshuoDatabase } from '../persistence/db.ts';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
  parseCallBudgetEnabledSetting,
  parseFrozenCallBudgetPolicy,
  resolveCallBudgetPolicy,
  type CallBudgetMode,
  type FrozenCallBudgetPolicy,
} from '../contracts/callBudget.ts';

export interface PersistedCallBudgetSnapshot {
  /** Legacy numeric projection retained for migration 056/057 and old readers. */
  maxTurns: number | null;
  /** Null only for historical rows written before R98. */
  callBudget: FrozenCallBudgetPolicy | null;
}

/** Earlier-schema upgrade fixtures retain their original behavior until migration. */
export function supportsCallBudgetSnapshots(db: ZhongshuoDatabase): boolean {
  return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{name: string}>).some(column => column.name === 'deliberation_budget_json');
}

/**
 * The application setting is authoritative only when a new request is frozen.
 * Missing means default-off. Invalid stored values are surfaced instead of
 * silently becoming either a hidden cap or an unbounded execution.
 */
export function readCallBudgetEnabled(db: ZhongshuoDatabase): boolean {
  const row = db.prepare('SELECT value FROM daemon_state WHERE key = ?')
    .get(`app:setting:${CALL_BUDGET_ENABLED_SETTING_KEY}`) as { value: string } | undefined;
  return parseCallBudgetEnabledSetting(row?.value ?? null);
}

export function resolveNewCallBudget(
  db: ZhongshuoDatabase,
  mode: CallBudgetMode,
  overrideLimit?: number | null,
): FrozenCallBudgetPolicy {
  return parseFrozenCallBudgetPolicy(resolveCallBudgetPolicy({
    mode,
    enabled: readCallBudgetEnabled(db),
    overrideLimit,
  }));
}

/**
 * Disabled requests still carry the product default as a nominal numeric
 * projection for the old migration 056 trigger. It is not an enforcement cap:
 * every dispatch path must read `callBudget.enforcement` before rejecting.
 */
export function taskCallBudgetSnapshotJson(policy: FrozenCallBudgetPolicy): string {
  return JSON.stringify(callBudgetSnapshotObject(policy));
}

export function callBudgetSnapshotObject(policy: FrozenCallBudgetPolicy): {
  maxTurns: number;
  callBudget: FrozenCallBudgetPolicy;
} {
  return {
    maxTurns: policy.enforcement === 'enabled' ? policy.limit : DEFAULT_CALL_BUDGET_LIMITS[policy.mode],
    callBudget: policy,
  };
}

export function parsePersistedCallBudgetSnapshot(value: string | null | undefined): PersistedCallBudgetSnapshot {
  if (value == null || value.trim() === '') return { maxTurns: null, callBudget: null };
  const parsed = JSON.parse(value) as { maxTurns?: unknown; callBudget?: unknown };
  const maxTurns = typeof parsed.maxTurns === 'number' && Number.isSafeInteger(parsed.maxTurns) && parsed.maxTurns > 0
    ? parsed.maxTurns
    : null;
  const callBudget = parsed.callBudget == null ? null : parseFrozenCallBudgetPolicy(parsed.callBudget);
  return { maxTurns, callBudget };
}

export function taskCallBudgetSnapshot(db: ZhongshuoDatabase, taskId: string): PersistedCallBudgetSnapshot {
  if (!supportsCallBudgetSnapshots(db)) return {maxTurns: null, callBudget: null};
  const row = db.prepare('SELECT deliberation_budget_json FROM tasks WHERE id = ?')
    .get(taskId) as { deliberation_budget_json: string | null } | undefined;
  return parsePersistedCallBudgetSnapshot(row?.deliberation_budget_json ?? null);
}

export function runCallBudgetPolicy(budgetJson: string | null): FrozenCallBudgetPolicy | null {
  if (budgetJson == null || budgetJson.trim() === '') return null;
  try {
    const parsed = JSON.parse(budgetJson) as { callBudget?: unknown };
    return parsed.callBudget == null ? null : parseFrozenCallBudgetPolicy(parsed.callBudget);
  } catch {
    return null;
  }
}

/** Persist the request snapshot on the task inside the caller's transaction. */
export function freezeTaskCallBudget(
  db: ZhongshuoDatabase,
  taskId: string,
  policy: FrozenCallBudgetPolicy,
): void {
  if (!supportsCallBudgetSnapshots(db)) return;
  const changed = db.prepare(
    'UPDATE tasks SET deliberation_budget_json = ? WHERE id = ?',
  ).run(taskCallBudgetSnapshotJson(policy), taskId);
  if (changed.changes !== 1) throw new Error(`任务不存在，无法冻结调用预算：${taskId}`);
}

export function callBudgetEnforced(policy: FrozenCallBudgetPolicy | null | undefined): boolean {
  return policy?.enforcement === 'enabled';
}

export function callBudgetLimit(policy: FrozenCallBudgetPolicy | null | undefined): number | null {
  return policy?.enforcement === 'enabled' ? policy.limit : null;
}
