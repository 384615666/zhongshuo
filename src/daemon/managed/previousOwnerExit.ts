import {isRealRuntimeKind} from '../../contracts/runtimeKinds.ts';
/** Recovery of anonymous Windows jobs after the only handle owner has exited.
 * This is a KILL_ON_JOB_CLOSE proof, not a PID/tree-absence proof. The managed
 * registry is written only after the local bridge has verified job membership.
 * jobManager creates a non-inheritable unnamed job, enables kill-on-close before
 * resuming the root, never duplicates its handle and never enables breakaway.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkProcessLiveness, analyzeProcessTree } from '../processCheck.ts';
import { getProcessTreeIdentities, type ProcessRegistryRow, type QueryFn, type RegistryDb } from '../processRegistry.ts';
import type { TreeScan } from '../processCheck.ts';
import { selectCompletedDaemonStop } from '../stopHistory.ts';

type PreviousOwner =
  | { basis: 'archived-lock'; pid: number; startedAt: number; archivedAt: number }
  | { basis: 'completed-stop-record'; pid: number; startedAt: null; archivedAt: null;
    stoppedAt: number; persistedAt: number; phase: 'closed' | 'forced-closed'; turnId: string };

export interface PreviousOwnerExitEvidence {
  source: 'windows-job-kill-on-owner-exit';
  managedJobId: string;
  registryId: number;
  owner: PreviousOwner;
  currentOwner: { pid: number; startedAt: number };
  rootPid: number;
  observedAt: number;
  checkedHistoricalProcesses: number;
  killOnJobClose: true;
  handleInherited: false;
  releasable: true;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readOwner(path: string): { pid: number; startedAt: number } {
  const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; startedAt?: number };
  if (!Number.isSafeInteger(value.pid) || value.pid! <= 0 || !Number.isSafeInteger(value.startedAt) || value.startedAt! <= 0) {
    throw new Error('daemon 锁身份不完整');
  }
  return { pid: value.pid!, startedAt: value.startedAt! };
}

export function verifyPreviousManagedOwnerExit(
  db: RegistryDb, reg: ProcessRegistryRow, options: {
    appDataDir: string; instance: { pid: number; startedAt: number }; now?: number; query?: QueryFn;
    treeScan?: (rootPid: number, historical: Array<{ pid: number; startedAt: number | null }>) => TreeScan;
  },
): PreviousOwnerExitEvidence {
  const fail = (reason: string): never => { throw new Error(`上次受管执行退出核查未通过：${reason}`); };
  if (process.platform !== 'win32') fail('当前平台没有 Windows job 关闭保证');
  const now = options.now ?? Date.now();
  if (reg.identity_source !== 'managed-job' || !['shared', 'per-turn'].includes(reg.process_model)
    || !isRealRuntimeKind(reg.adapter_kind) || reg.pid == null || reg.started_at_ms == null
    || !positiveInteger(reg.pid) || !positiveInteger(reg.started_at_ms) || !positiveInteger(reg.registered_at)
    || reg.managed_job_id == null || reg.note !== `job=${reg.managed_job_id}`) fail('缺少完整的本机受管登记');
  const job = /^job-([0-9a-z]+)-(\d+)$/.exec(reg.managed_job_id!);
  const jobCreatedAt = job == null ? NaN : parseInt(job[1]!, 36);
  if (job == null || Number(job[2]) !== reg.pid || !Number.isSafeInteger(jobCreatedAt)
    || jobCreatedAt <= 0 || reg.started_at_ms! > jobCreatedAt || jobCreatedAt > reg.registered_at) fail('job 稳定身份与根进程/登记时间不符');
  const locks = join(options.appDataDir, 'locks');
  const current = readOwner(join(locks, 'daemon.lock.d', 'owner.json'));
  if (current.pid !== process.pid || current.pid !== options.instance.pid || current.startedAt !== options.instance.startedAt
    || current.startedAt <= reg.registered_at || current.startedAt > now) fail('当前 daemon 不持有较新的单实例锁');
  const owners: Array<{ pid: number; startedAt: number; archivedAt: number }> = [];
  for (const entry of readdirSync(locks, { withFileTypes: true })) {
    const match = /^daemon\.lock\.d\.stale-(\d+)-(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || match == null) continue;
    const archivedAt = Number(match[1]);
    const owner = readOwner(join(locks, entry.name, 'owner.json'));
    if (owner.startedAt <= jobCreatedAt && reg.registered_at <= archivedAt) owners.push({ ...owner, archivedAt });
  }
  if (owners.length > 1) fail('没有唯一覆盖 job 创建及登记的旧锁代次');
  let owner: PreviousOwner;
  let stopSnapshot: ReturnType<typeof selectCompletedDaemonStop>;
  if (owners.length === 1) {
    const archived = owners[0]!;
    if (archived.pid === current.pid || archived.startedAt > reg.started_at_ms! || archived.archivedAt > now) fail('旧锁代次边界或持有者不符');
    owner = { basis: 'archived-lock', ...archived };
  } else {
    // Normal shutdown removes its lock instead of archiving it. Only a locally
    // persisted completed stop bound to this exact turn can replace that lock
    // evidence; it does not supply an owner start time or prove OS exit itself.
    stopSnapshot = selectCompletedDaemonStop(db, reg.turn_id);
    if (stopSnapshot == null) return fail('缺少绑定目标 turn 的可信已完成停机记录');
    const stop = stopSnapshot.record;
    if (stop.pid === current.pid || stop.pid === reg.pid) fail('已完成停机记录未绑定旧持有者');
    if (stop.at < reg.registered_at || stop.at >= current.startedAt
      || stopSnapshot.persistedAt >= current.startedAt) fail('停机记录与登记/当前 daemon 的时间边界不符');
    owner = { basis: 'completed-stop-record', pid: stop.pid, startedAt: null, archivedAt: null,
      stoppedAt: stop.at, persistedAt: stopSnapshot.persistedAt,
      phase: stop.phase, turnId: reg.turn_id };
  }
  const query = options.query ?? checkProcessLiveness;
  // Reject live/reused/unknown identities. A user request is not exit evidence.
  if (query(owner.pid).state !== 'exited') fail('旧 daemon PID 仍存在、已复用或无法核实');
  if (query(reg.pid!).state !== 'exited') fail('旧 job 根 PID 仍存在、已复用或无法核实');
  const historical = getProcessTreeIdentities(db, reg.turn_id);
  for (const child of historical) {
    if (child.pid !== reg.pid && query(child.pid).state !== 'exited') fail('已登记后代仍存在、已复用或无法核实');
  }
  const tree = (options.treeScan ?? analyzeProcessTree)(reg.pid!, historical.map(p => ({ pid: p.pid, startedAt: p.started_at_ms })));
  if (tree.state !== 'checked') fail('当前后代检查未确认无存活执行');
  // Re-read the lock after OS calls: a changed generation invalidates this proof.
  const after = readOwner(join(locks, 'daemon.lock.d', 'owner.json'));
  if (after.pid !== current.pid || after.startedAt !== current.startedAt) fail('核查期间单实例锁已变化');
  if (stopSnapshot != null) {
    const stopAfter = selectCompletedDaemonStop(db, reg.turn_id);
    if (JSON.stringify(stopAfter) !== JSON.stringify(stopSnapshot)) fail('核查期间停机记录已变化');
  }
  return {
    source: 'windows-job-kill-on-owner-exit', managedJobId: reg.managed_job_id!, registryId: reg.id,
    owner, currentOwner: current, rootPid: reg.pid!, observedAt: now,
    checkedHistoricalProcesses: historical.length, killOnJobClose: true, handleInherited: false, releasable: true,
  };
}
