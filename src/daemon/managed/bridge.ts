/**
 * REC-LIFE-1 接线（第十三轮一重构）：受管 spawn 桥——把 jobManager 的 FFI 进程包装成
 * adapter 契约期望的 ChildProcess 形状。
 *
 * - stdin：Writable.write→writeStdinChunked（64KB 分片+让步）；**end()→endStdin()=子进程
 *   收到 EOF**（不再只实现 write）；
 * - stdout/stderr：**字节流**Readable（push Buffer——跨 chunk 解码由消费者处理，中文跨
 *   字节边界不丢）；根退出后持续轮询排空至管道关闭才 push(null)——**不固定等 200ms**；
 *   exit 与 close 分开发射（exit=根 signaled；close=stdio 排空）；
 * - 背压：Readable 高水位（1MB）满时暂停读取、水位回落继续；单次 FFI 读上限 1MB；
 * - 句柄/证据生命周期：ManagedProcess 注册到 managedJobs（键=jobId 稳定身份，非 PID）；
 *   根退出后**保留实例**（可查询证据）——releaseProtection 消费证据（markConsumed）后仍
 *   保留至 dispose（由持有者显式收尾）——证据不因关输出流而消失；dispose 移除记录防泄漏；
 *   daemon 重启后无内存句柄→旧 turn 查不到→如实「无句柄，进入人工核对」（不追认）。
 * - 门禁：ZS_MANAGED_RUNTIME=1 时桥必须可用（不可用=拒绝派发不降级）；未设=既有路径。
 */
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnManagedProcess, managedRuntimeAvailable, type ManagedProcess } from './jobManager.ts';

export interface ManagedChildProcess extends EventEmitter {
  pid: number;
  /** 受管稳定身份（jobId——PID 可复用，不作为唯一身份）。 */
  managedJobId: string;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: string): boolean;
  exitCode: number | null;
  /** 底层受管句柄（证据/查询联动用；根退出后仍可查询，dispose 前不消失）。 */
  managed: ManagedProcess;
}

const managedJobsByKey = new Map<string, ManagedProcess>();
const pidIndex = new Map<number, string>(); // pid→jobId 注册期索引（dispose 移除；身份以 jobId 为准）

/** 按稳定身份取受管句柄（releaseProtection 联动：无=未纳管/已释放，走既有保守路径）。 */
export function managedJobById(jobId: string): ManagedProcess | undefined {
  return managedJobsByKey.get(jobId);
}

/** 按 pid 取（登记窗口查找用；命中后经 registry 的 jobId 核对身份）。 */
export function managedJobByPid(pid: number | null | undefined): ManagedProcess | undefined {
  if (pid == null) return undefined;
  const key = pidIndex.get(pid);
  return key != null ? managedJobsByKey.get(key) : undefined;
}

export function managedJobsCount(): number {
  return managedJobsByKey.size;
}

/** 受管桥是否可用（ZS_MANAGED_RUNTIME=1 且 koffi 可加载）。不可用时调用方必须拒绝派发。 */
export function managedBridgeRequired(): boolean {
  return process.env.ZS_MANAGED_RUNTIME === '1';
}

export function managedBridgeAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!managedBridgeRequired()) return { ok: false, reason: 'ZS_MANAGED_RUNTIME 未启用（按部署节奏开关）' };
  return managedRuntimeAvailable();
}

const POLL_INTERVAL_MS = 20;
const READ_CHUNK_MAX = 1 << 20;      // 单次 FFI 读上限
const STREAM_HIGH_WATER = 1 << 20;   // Readable 高水位（背压阈值）

/**
 * 受管 spawn 桥（生产 spawnFn 的替换件）。轮询将管道字节 push 进 Readable；
 * exit 在根 signaled 后立即发射；close 在 stdio 排空（管道关闭）后发射。
 */
export function spawnManagedBridge(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): ManagedChildProcess {
  const mp = spawnManagedProcess({ cmd, args, cwd: options.cwd, env: options.env != null ? options.env as Record<string, string> : null });
  managedJobsByKey.set(mp.jobId, mp);
  pidIndex.set(mp.pid, mp.jobId);

  const emitter = new EventEmitter() as ManagedChildProcess;
  let exitCode: number | null = null;
  let exitEmitted = false;
  let polling = true;

  const stdout = new Readable({ highWaterMark: STREAM_HIGH_WATER, read() { /* 轮询驱动 */ } });
  const stderr = new Readable({ highWaterMark: STREAM_HIGH_WATER, read() { /* 同上 */ } });

  const stdin = new Writable({
    decodeStrings: true,
    defaultEncoding: 'utf8',
    write(chunk, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      mp.writeStdinChunkedBytes(buf).then(() => cb(), (error: Error) => cb(error));
    },
    final(cb) {
      try {
        mp.endStdin(); // EOF：父侧写端关闭
        cb();
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  const pump = (): void => {
    if (!polling) return;
    // 背压：任一流高水位满则跳过该流本轮读取（水位回落后继续）。
    if (stdout.readableLength < STREAM_HIGH_WATER) {
      const chunk = mp.pollStdoutBytes(READ_CHUNK_MAX);
      if (chunk == null) {
        if (!stdout.readableEnded) stdout.push(null);
      } else if (chunk.length > 0) {
        stdout.push(chunk);
      }
    }
    if (stderr.readableLength < STREAM_HIGH_WATER) {
      const chunk = mp.pollStderrBytes(READ_CHUNK_MAX);
      if (chunk == null) {
        if (!stderr.readableEnded) stderr.push(null);
      } else if (chunk.length > 0) {
        stderr.push(chunk);
      }
    }
    const r = mp.waitRootExit(0);
    if (!r.timedOut) {
      exitCode = r.code;
      if (!exitEmitted) {
        exitEmitted = true;
        emitter.exitCode = exitCode;
        emitter.emit('exit', exitCode, null);
      }
      // 根退出后继续排空；两管道均关闭后停轮询+发 close（排空完成判定，非固定延迟）。
      const outDone = mp.stdoutDrained() === true;
      const errDone = mp.stderrDrained() === true;
      if (outDone && errDone) {
        polling = false;
        // 终拍：若末块数据与退出同拍到达，流尚未收到 EOF——补 push(null)（push-after-end 由
        // readableEnded 守卫），否则消费者永等 'end'。
        if (!stdout.readableEnded) stdout.push(null);
        if (!stderr.readableEnded) stderr.push(null);
        mp.closeOutputPipes(); // 证据/查询走 job 句柄——不因关输出流而消失
        setImmediate(() => {
          emitter.emit('close', exitCode, null);
        });
      }
    }
  };
  const pollTimer = setInterval(pump, POLL_INTERVAL_MS);
  pollTimer.unref?.();

  emitter.pid = mp.pid;
  emitter.managedJobId = mp.jobId;
  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.exitCode = null;
  emitter.managed = mp;
  emitter.kill = () => {
    mp.terminateAll();
    return true;
  };
  // dispose：从注册表移除（证据已消费后的收尾；防长期泄漏）。
  const origDispose = mp.dispose.bind(mp);
  mp.dispose = () => {
    managedJobsByKey.delete(mp.jobId);
    pidIndex.delete(mp.pid);
    origDispose();
  };
  return emitter;
}
