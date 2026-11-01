import {isRealRuntimeKind} from '../../contracts/runtimeKinds.ts';
/** Recovery of anonymous Windows jobs after owner exit or a verified later OS boot.
 * Owner recovery uses KILL_ON_JOB_CLOSE; the boot branch proves all previous
 * process generations ended. Neither relies on PID/tree absence alone. The managed
 * registry is written only after the local bridge has verified job membership.
 * jobManager creates a non-inheritable unnamed job, enables kill-on-close before
 * resuming the root, never duplicates its handle and never enables breakaway.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { checkProcessLiveness, analyzeProcessTree } from '../processCheck.ts';
import { getProcessTreeIdentities, type ProcessRegistryRow, type QueryFn, type RegistryDb } from '../processRegistry.ts';
import type { TreeScan } from '../processCheck.ts';
import { selectCompletedDaemonStop } from '../stopHistory.ts';

type PreviousOwner =
  | { basis: 'archived-lock'; pid: number; startedAt: number; archivedAt: number }
  | { basis: 'completed-stop-record'; pid: number; startedAt: null; archivedAt: null;
    stoppedAt: number; persistedAt: number; phase: 'closed' | 'forced-closed'; turnId: string }
  | { basis: 'windows-system-reboot'; pid: null; startedAt: null; archivedAt: null;
    bootStartedAt: number; clockMarginMs: number };

export interface PreviousOwnerExitEvidence {
  source: 'windows-job-kill-on-owner-exit' | 'windows-system-reboot';
  managedJobId: string;
  registryId: number;
  owner: PreviousOwner;
  currentOwner: { pid: number; startedAt: number };
  rootPid: number;
  observedAt: number;
  checkedHistoricalProcesses: number;
  reusedProcesses: Array<{ pid: number; startedAt: number }>;
  treeCheck: 'checked' | 'superseded-by-reboot-root-reuse';
  killOnJobClose: true;
  handleInherited: false;
  releasable: true;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// Legacy registrations have wall-clock timestamps, not a persisted boot ID.
// Require agreement between the OS boot timestamp and monotonic uptime, plus a
// ten-second separation. Sleep/hibernation do not reset GetTickCount64. This
// cannot reconstruct a lost owner identity or certify the old business result.
// Legacy wall-clock history still assumes a stable local clock: a clock rollback
// during the historical run cannot be disproved without a persisted boot ID.
const BOOT_CLOCK_MARGIN_MS = 10_000;
const MIN_BOOT_TIME = Date.UTC(2000, 0, 1);
function windowsBootStartedAt(): number {
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ZSBoot { [DllImport("kernel32.dll")] public static extern ulong GetTickCount64(); }'; `
    + `$boot=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime; `
    + `$ticks=[ZSBoot]::GetTickCount64(); $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); `
    + `@{boot=[DateTimeOffset]::new($boot.ToUniversalTime()).ToUnixTimeMilliseconds();ticks=$ticks;now=$now}|ConvertTo-Json -Compress`;
  const before = Date.now();
  const output = execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 4096 });
  const after = Date.now();
  const sample = JSON.parse(output.trim().replace(/^\uFEFF/, '')) as { boot?: number; ticks?: number; now?: number };
  if (!positiveInteger(sample.boot) || sample.boot < MIN_BOOT_TIME || !positiveInteger(sample.ticks)
    || !positiveInteger(sample.now) || after < before || after - before > 5000
    || sample.now < before || sample.now > after || sample.boot > sample.now
    || Math.abs(sample.boot - (sample.now - sample.ticks)) > BOOT_CLOCK_MARGIN_MS) throw new Error('Windows 启动时刻与单调运行时间不一致，无法核实重启');
  return sample.boot;
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
    /** Internal test seam only; never accepted from a command/IPC caller. */
    bootStartedAt?: () => number;
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
  const historical = getProcessTreeIdentities(db, reg.turn_id);
  const readBoot = options.bootStartedAt ?? windowsBootStartedAt;
  if (owners.length === 1) {
    const archived = owners[0]!;
    if (archived.pid === current.pid || archived.startedAt > reg.started_at_ms! || archived.archivedAt > now) fail('旧锁代次边界或持有者不符');
    owner = { basis: 'archived-lock', ...archived };
  } else {
    // Normal shutdown removes its lock instead of archiving it. Prefer a local
    // completed stop bound to this exact turn; if it was lost, require a later
    // system boot instead. Neither branch invents the missing owner start time.
    stopSnapshot = selectCompletedDaemonStop(db, reg.turn_id);
    if (stopSnapshot != null) {
      const stop = stopSnapshot.record;
      if (stop.pid === current.pid || stop.pid === reg.pid) fail('已完成停机记录未绑定旧持有者');
      if (stop.at < reg.registered_at || stop.at >= current.startedAt
        || stopSnapshot.persistedAt >= current.startedAt) fail('停机记录与登记/当前 daemon 的时间边界不符');
      owner = { basis: 'completed-stop-record', pid: stop.pid, startedAt: null, archivedAt: null,
        stoppedAt: stop.at, persistedAt: stopSnapshot.persistedAt,
        phase: stop.phase, turnId: reg.turn_id };
    } else {
      let boot: number;
      try { boot = readBoot(); } catch { return fail('旧版退出记录缺失，无法核实 Windows 重启；请重启 Windows 后再检查；不会重发任务'); }
      if (!positiveInteger(boot) || boot < MIN_BOOT_TIME || boot > current.startedAt || boot > now) fail('Windows 启动时刻无效或晚于当前 daemon');
      const lastObserved = Math.max(reg.registered_at, ...historical.map(p => Math.max(p.first_seen_at, p.last_seen_alive_at, p.started_at_ms ?? 0)));
      if (!Number.isSafeInteger(lastObserved)) fail('旧执行历史时间无效，无法核实 Windows 重启');
      if (boot <= lastObserved) fail('旧版退出记录缺失，请重启 Windows 后再检查；不会重发任务（尚未确认较新的 Windows 启动代次）');
      if (boot <= lastObserved + BOOT_CLOCK_MARGIN_MS) fail('本次 Windows 启动距旧执行最后记录不足或等于10秒，无法自动确认退出；请至少等待10秒再重启 Windows 后检查；不会重发任务。仅等待后重新检查或重新打开应用不会改变启动代次证据');
      owner = { basis: 'windows-system-reboot', pid: null, startedAt: null, archivedAt: null,
        bootStartedAt: boot, clockMarginMs: BOOT_CLOCK_MARGIN_MS };
    }
  }
  const query = options.query ?? checkProcessLiveness;
  const reusedProcesses: Array<{ pid: number; startedAt: number }> = [];
  const verifyProcess = (pid: number, previousStart: number | null, reason: string): boolean => {
    const observed = query(pid);
    if (observed.state === 'exited') return false;
    // Only a separately verified OS reboot makes a new PID generation harmless.
    // Never kill it or follow its new tree. Other evidence branches stay strict.
    if (owner.basis === 'windows-system-reboot' && observed.state === 'alive'
      && observed.identity.pid === pid && positiveInteger(observed.identity.startedAt)
      && observed.identity.startedAt > owner.bootStartedAt && observed.identity.startedAt <= now
      && observed.identity.startedAt !== previousStart) {
      reusedProcesses.push({ pid, startedAt: observed.identity.startedAt });
      return true;
    }
    return fail(reason);
  };
  if (owner.pid != null && query(owner.pid).state !== 'exited') fail('旧 daemon PID 仍存在、已复用或无法核实');
  const rootReused = verifyProcess(reg.pid!, reg.started_at_ms, '旧 job 根 PID 仍存在或新代次无法核实');
  for (const child of historical) {
    if (child.pid !== reg.pid) verifyProcess(child.pid, child.started_at_ms, '已登记后代仍存在或新代次无法核实');
  }
  // A reboot proves all old descendants ended, including unsampled ones. A
  // live reused root belongs to another execution; scanning it would falsely
  // attribute that execution's children to this turn. Exclude reused historical
  // seeds as well when the old root PID itself is absent.
  if (!rootReused) {
    const reusedPids = new Set(reusedProcesses.map(p => p.pid));
    const tree = (options.treeScan ?? analyzeProcessTree)(reg.pid!, historical
      .filter(p => !reusedPids.has(p.pid)).map(p => ({ pid: p.pid, startedAt: p.started_at_ms })));
    if (tree.state !== 'checked') fail('当前后代检查未确认无存活执行');
  }
  if (owner.basis === 'windows-system-reboot') {
    let bootAfter: number;
    try { bootAfter = readBoot(); } catch { return fail('复查 Windows 启动代次失败'); }
    if (bootAfter !== owner.bootStartedAt || selectCompletedDaemonStop(db, reg.turn_id) != null) fail('核查期间 Windows 启动代次或停机证据已变化');
  }
  // Re-read the lock after OS calls: a changed generation invalidates this proof.
  const after = readOwner(join(locks, 'daemon.lock.d', 'owner.json'));
  if (after.pid !== current.pid || after.startedAt !== current.startedAt) fail('核查期间单实例锁已变化');
  if (stopSnapshot != null) {
    const stopAfter = selectCompletedDaemonStop(db, reg.turn_id);
    if (JSON.stringify(stopAfter) !== JSON.stringify(stopSnapshot)) fail('核查期间停机记录已变化');
  }
  return {
    source: owner.basis === 'windows-system-reboot' ? 'windows-system-reboot' : 'windows-job-kill-on-owner-exit', managedJobId: reg.managed_job_id!, registryId: reg.id,
    owner, currentOwner: current, rootPid: reg.pid!, observedAt: now,
    checkedHistoricalProcesses: historical.length, reusedProcesses,
    treeCheck: rootReused ? 'superseded-by-reboot-root-reuse' : 'checked',
    killOnJobClose: true, handleInherited: false, releasable: true,
  };
}
