/**
 * REC-LIFE-1 接线（第十二轮五·步骤 3/4）：受管 spawn 桥——把 jobManager 的 FFI 进程包装成
 * adapter 契约期望的 ChildProcess 形状（stdin 可写、stdout/stderr Readable、exit 事件、kill）。
 * 进程注册到 managedJobs（按 pid），供 registry/probe/releaseProtection 联动按 pid 取证据。
 *
 * 门禁：环境变量 ZS_MANAGED_RUNTIME=1 时 adapter 生产 spawn 必须走本桥——桥初始化失败
 * （koffi 不可用/非 win32）直接抛错，**不降级为未受管运行**；未设该变量时维持现状
 * （不受管路径与第九轮保守解除口径不变——迁移开关按部署节奏启用）。
 */
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnManagedProcess, managedRuntimeAvailable, type ManagedProcess } from './jobManager.ts';

export interface ManagedChildProcess extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: string): boolean;
  exitCode: number | null;
  /** 底层受管句柄（releaseEvidence/activeCount 联动用）。 */
  managed: ManagedProcess;
}

const managedJobsByPid = new Map<number, ManagedProcess>();

/** 按 pid 取受管句柄（releaseProtection/probe 联动：无=未纳管，走既有保守路径）。 */
export function managedJobByPid(pid: number | null | undefined): ManagedProcess | undefined {
  return pid == null ? undefined : managedJobsByPid.get(pid);
}

export function managedJobsCount(): number {
  return managedJobsByPid.size;
}

/** 受管桥是否可用（ZS_MANAGED_RUNTIME=1 且 koffi 可加载）。不可用时调用方必须拒绝派发。 */
export function managedBridgeRequired(): boolean {
  return process.env.ZS_MANAGED_RUNTIME === '1';
}

export function managedBridgeAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!managedBridgeRequired()) return { ok: false, reason: 'ZS_MANAGED_RUNTIME 未启用（按部署节奏开关）' };
  return managedRuntimeAvailable();
}

/**
 * 受管 spawn 桥（生产 spawnFn 的替换件）。轮询周期 25ms 将管道数据推入 Readable；
 * exit 事件在根进程 signaled 后发（经 setImmediate，保留 close 语义近似）。
 */
export function spawnManagedBridge(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): ManagedChildProcess {
  const mp = spawnManagedProcess({ cmd, args, cwd: options.cwd, env: options.env != null ? options.env as Record<string, string> : null });
  managedJobsByPid.set(mp.pid, mp);

  const emitter = new EventEmitter() as ManagedChildProcess;
  let exitCode: number | null = null;

  const stdout = new Readable({ read() { /* 数据由轮询 push */ } });
  const stderr = new Readable({ read() { /* 同上 */ } });
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      try {
        mp.writeStdin(chunk.toString('utf8'));
        cb();
      } catch (error) {
        cb(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  let pollTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    const pushPipe = (r: Readable, data: string | null): void => {
      if (data == null || data === '') return;
      r.push(data); // Readable 默认无背压上限语义足够（本地 JSON lines 量级）
    };
    pushPipe(stdout, mp.pollStdout());
    pushPipe(stderr, mp.pollStderr());
    const r = mp.waitRootExit(0);
    if (!r.timedOut) {
      exitCode = r.code;
      if (pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // 根退出：drain 余量后收尾（200ms 宽限读尾数据）。
      setTimeout(() => {
        const tail1 = mp.pollStdout();
        const tail2 = mp.pollStderr();
        if (tail1 != null && tail1 !== '') stdout.push(tail1);
        if (tail2 != null && tail2 !== '') stderr.push(tail2);
        stdout.push(null);
        stderr.push(null);
        mp.releaseRootHandles();
        managedJobsByPid.delete(mp.pid);
        emitter.exitCode = exitCode;
        emitter.emit('exit', exitCode, null);
        emitter.emit('close', exitCode, null);
      }, 200);
    }
  }, 25);
  // 供测试快速停轮询
  (emitter as unknown as { _stopPoll(): void })._stopPoll = () => {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  emitter.pid = mp.pid;
  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.exitCode = null;
  emitter.managed = mp;
  emitter.kill = () => {
    mp.terminateAll();
    return true;
  };
  return emitter;
}
