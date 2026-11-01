import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import type { EffectiveWriteConcurrency, ProjectWriteConcurrency, WriteConcurrencyOverride } from '../contracts/writeConcurrency.ts';
import { lockDomainsOverlap } from './directoryIdentity.ts';

type Fail = (code: string, message: string) => never;
type Runner = <T>(handler: () => T, replayGuard?: () => void) => { data: T; replayed: boolean };
type ProjectRow = { id: string; status: string; canonical_path: string; revision: number; write_concurrency_override: WriteConcurrencyOverride };

export function projectWriteConcurrency(db: ZhongshuoDatabase, projectId: string): ProjectWriteConcurrency | null {
  const row = db.prepare('SELECT id,revision,write_concurrency_override FROM projects WHERE id=?').get(projectId) as ProjectRow | undefined;
  return row ? { projectId: row.id, revision: row.revision, override: row.write_concurrency_override, effectivePolicy: row.write_concurrency_override ?? 'session_scope' } : null;
}

/** Compute once before admission, then pass the same policy to acquireLease. */
export function resolveWriteConcurrency(db: ZhongshuoDatabase, input: {
  projectId: string; fullAccess: boolean; eligible: boolean; sessionScopeKey: string;
}): { writePolicy: EffectiveWriteConcurrency; writeSessionScopeKey?: string; writeFullAccess?: true } {
  if (!input.fullAccess || !input.eligible) return { writePolicy: 'single_writer' };
  const settings = projectWriteConcurrency(db, input.projectId);
  if (!settings) return { writePolicy: 'single_writer' };
  return { writePolicy: settings.effectivePolicy, ...(settings.effectivePolicy !== 'single_writer' ? { writeSessionScopeKey: input.sessionScopeKey, writeFullAccess: true as const } : {}) };
}

/** Pure synchronous command handler: caller supplies the receipt transaction. */
export function projectWriteConcurrencyCommand(db: ZhongshuoDatabase, method: string, params: unknown, run: Runner, fail: Fail, remote = false): { data: ProjectWriteConcurrency; replayed?: boolean } | null {
  if (method !== 'project.writeConcurrency.get' && method !== 'project.writeConcurrency.set') return null;
  if (remote) fail('FORBIDDEN', '文件修改并发设置仅限本机操作');
  if (method === 'project.writeConcurrency.get') {
    const p = z.strictObject({ projectId: z.string().min(1) }).parse(params);
    const current = projectWriteConcurrency(db, p.projectId);
    if (!current) fail('RESOURCE_NOT_FOUND', '项目不存在');
    return { data: current };
  }
  const p = z.strictObject({ projectId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), override: z.enum(['single_writer', 'parallel_writers']).nullable() }).parse(params);
  return run(() => {
    const project = db.prepare('SELECT id,status,canonical_path,revision,write_concurrency_override FROM projects WHERE id=?').get(p.projectId) as ProjectRow | undefined;
    if (!project) fail('RESOURCE_NOT_FOUND', '项目不存在');
    if (project.status !== 'active') fail('FORBIDDEN', '请先恢复项目并确认目录，再修改文件并发设置');
    if (project.revision !== p.expectedRevision) fail('STALE_REVISION', '项目设置已变化，请重新读取后保存');
    // Check every overlapping root, including orphan/expired leases and legacy
    // protected executions without a lease. Changing settings never releases one.
    const leases = db.prepare("SELECT lock_domain FROM workspace_leases WHERE status!='released'").all() as Array<{ lock_domain: string }>;
    const turns = db.prepare(`SELECT p.canonical_path FROM agent_turns a
      JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
      WHERE a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')
        OR (a.status='UNKNOWN' AND a.protection_state IS NOT 'released') OR a.protection_state='retained'`).all() as Array<{ canonical_path: string }>;
    if (leases.some(l => lockDomainsOverlap(l.lock_domain, project.canonical_path)) || turns.some(t => lockDomainsOverlap(t.canonical_path, project.canonical_path))) {
      fail('WORKER_STILL_RUNNING', '此目录仍有运行或未确认结束的任务，请待执行结束并解除保护后再修改');
    }
    const changed = db.prepare('UPDATE projects SET write_concurrency_override=?,revision=revision+1 WHERE id=? AND revision=?').run(p.override, p.projectId, p.expectedRevision);
    if (changed.changes !== 1) fail('STALE_REVISION', '项目设置已变化，请重新读取后保存');
    const current = projectWriteConcurrency(db, p.projectId)!;
    appendDomainEvent(db, { schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: p.projectId, kind: 'project.writeConcurrencyChanged', createdAt: Date.now(), payload: {
      previousOverride: project.write_concurrency_override, override: current.override, effectivePolicy: current.effectivePolicy, previousRevision: project.revision, revision: current.revision,
    } });
    return current;
  });
}
