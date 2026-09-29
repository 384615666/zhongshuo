/**
 * REC-LIFE-1（第十二轮五）：Windows Job Object 受管生命周期——最小可运行实现。
 *
 * 上游：ADR-0010 + rec-life-1-plan.md。本模块按实测语义实现（十二轮探针实证）：
 * - 挂起创建（CREATE_SUSPENDED）→ 建 job（KILL_ON_JOB_CLOSE）→ 挂靠 → 恢复——纳管窗口为零，
 *   逃逸派生不可能在纳管前发生；
 * - **ActiveProcesses 归零的必要条件（修正点②）**：进程终止 + 本模块持有的进程/线程句柄全部
 *   关闭 + 系统清理延迟。查询失败不当作 0；句柄未关不当作已退出。判定接口
 *   releaseEvidence() 只在「句柄已关 + 根进程已 signaled + 计数 0」时给出可解除证据。
 * - daemon 崩溃兜底：job 句柄仅在 daemon 进程内（CreateJobObjectW 句柄默认不被子进程继承）；
 *   daemon 终止→最后一个 job 句柄关闭→内核按 KILL_ON_JOB_CLOSE 终止 job 内全部进程。
 * - 纳管失败（建 job/挂靠/恢复任一步）→ 终止挂起子进程并清理全部句柄→抛错——不降级为
 *   未受管运行。
 * - 依赖：koffi（N-API 预编译 FFI）。**按加载进程的宿主构建**（koffi 为 N-API，Node 与
 *   Electron 通用——修正计划中"Electron ABI 双编译"假设，无需 electron-rebuild）；加载
 *   失败=受管能力不可用（调用方拒绝受管路径的派发，不静默退回不受管）。
 * - 仅 win32；其他平台 managedRuntimeAvailable() 返回不可用（能力矩阵按平台分列）。
 */
import { platform } from 'node:process';
import { createRequire } from 'node:module';

interface KoffiLib {
  // 结构与函数绑定在懒加载闭包内建立；此接口仅约束使用面。
  createProcessSuspended(cmdline: string, cwd: string | null, envBlock: string[] | null, stdio: { in: unknown; out: unknown; err: unknown }): { ok: true; hProcess: unknown; hThread: unknown; pid: number } | { ok: false; lastError: number };
  createJob(killOnClose: boolean): unknown;
  setKillOnJobClose(job: unknown): boolean;
  assignProcessToJob(job: unknown, hProcess: unknown): boolean;
  resumeThread(hThread: unknown): number;
  waitFor(handle: unknown, timeoutMs: number): number; // 0=signaled 258=timeout
  getExitCode(hProcess: unknown): number | null;
  terminateJob(job: unknown, exitCode: number): boolean;
  terminateProcess(hProcess: unknown, exitCode: number): boolean;
  queryActiveProcesses(job: unknown): number | null; // null=查询失败
  closeHandle(handle: unknown): boolean;
  peekAndRead(pipe: unknown, maxBytes: number): string | null;
  writePipe(pipe: unknown, data: string): number | null;
  closePipe(pipe: unknown): boolean;
  /** 创建可继承管道对：{ childEnd=读端, parentEnd=写端 }。 */
  mkPipe(): { childEnd: unknown; parentEnd: unknown };
}

let libCache: KoffiLib | { unavailable: string } | null = null;

/** 受管能力可用性（加载失败/非 win32 → 不可用；调用方须拒绝受管派发，不降级）。 */
export function managedRuntimeAvailable(): { ok: true } | { ok: false; reason: string } {
  if (platform !== 'win32') return { ok: false, reason: `平台 ${platform} 未实现受管生命周期（Job Object 为 Windows 能力；非 win32 按平台分列，不虚构等价）` };
  const l = loadLib();
  return 'unavailable' in l ? { ok: false, reason: l.unavailable } : { ok: true };
}

function loadLib(): KoffiLib | { unavailable: string } {
  if (libCache != null) return libCache;
  try {
    // require 走 CJS 入口（koffi 预编译 N-API；按本进程宿主构建）
     
    const nodeRequire = createRequire(import.meta.url);
    const koffi = nodeRequire('koffi');
    const kernel32 = koffi.load('kernel32.dll');

    const STARTUPINFOW = koffi.struct('ZS_STARTUPINFOW', {
      cb: 'uint32_t', reserved: 'void*', desktop: 'char16_t*', title: 'char16_t*',
      x: 'uint32_t', y: 'uint32_t', xSize: 'uint32_t', ySize: 'uint32_t',
      xCountChars: 'uint32_t', yCountChars: 'uint32_t', fillAttribute: 'uint32_t',
      flags: 'uint32_t', showWindow: 'uint16_t', cbReserved2: 'uint16_t',
      lpReserved2: 'void*', hStdInput: 'void*', hStdOutput: 'void*', hStdError: 'void*',
    });
    const PROCESS_INFORMATION = koffi.struct('ZS_PROCESS_INFORMATION', { hProcess: 'void*', hThread: 'void*', dwProcessId: 'uint32_t', dwThreadId: 'uint32_t' });
    const ACC = koffi.struct('ZS_JOB_ACC', {
      TotalUserTime: 'int64_t', TotalKernelTime: 'int64_t', ThisPeriodTotalUserTime: 'int64_t', ThisPeriodTotalKernelTime: 'int64_t',
      TotalPageFaultCount: 'uint32_t', TotalProcesses: 'uint32_t', ActiveProcesses: 'uint32_t', TotalTerminatedProcesses: 'uint32_t',
    });
    const BASIC_LIMIT = koffi.struct('ZS_JOB_BASIC_LIMIT', {
      PerProcessUserTimeLimit: 'int64_t', PerJobUserTimeLimit: 'int64_t', LimitFlags: 'uint32_t',
      MinimumWorkingSetSize: 'uint64_t', MaximumWorkingSetSize: 'uint64_t', ActiveProcessLimit: 'uint32_t',
      Affinity: 'uint64_t', PriorityClass: 'uint32_t', SchedulingClass: 'uint32_t',
    });
    const IO_COUNTERS = koffi.struct('ZS_JOB_IO', { ReadOperationCount: 'uint64_t', WriteOperationCount: 'uint64_t', OtherOperationCount: 'uint64_t', ReadTransferCount: 'uint64_t', WriteTransferCount: 'uint64_t', OtherTransferCount: 'uint64_t' });
    const EXT_LIMIT = koffi.struct('ZS_JOB_EXT_LIMIT', {
      BasicLimitInformation: BASIC_LIMIT, IoInfo: IO_COUNTERS,
      ProcessMemoryLimit: 'uint64_t', JobMemoryLimit: 'uint64_t', PeakProcessMemoryUsed: 'uint64_t', PeakJobMemoryUsed: 'uint64_t',
    });

    const CreateProcessW = kernel32.func('CreateProcessW', 'int32_t', ['const char16_t *', 'char16_t *', 'void *', 'void *', 'int32_t', 'uint32_t', 'const char16_t *', 'const char16_t *', koffi.inout(koffi.pointer(STARTUPINFOW)), koffi.out(koffi.pointer(PROCESS_INFORMATION))]);
    const CreateJobObjectW = kernel32.func('CreateJobObjectW', 'void *', ['void *', 'const char16_t *']);
    const SetInformationJobObject = kernel32.func('SetInformationJobObject', 'int32_t', ['void *', 'int32_t', 'const void *', 'uint32_t']);
    const AssignProcessToJobObject = kernel32.func('AssignProcessToJobObject', 'int32_t', ['void *', 'void *']);
    const ResumeThread = kernel32.func('ResumeThread', 'uint32_t', ['void *']);
    const WaitForSingleObject = kernel32.func('WaitForSingleObject', 'uint32_t', ['void *', 'uint32_t']);
    const GetExitCodeProcess = kernel32.func('GetExitCodeProcess', 'int32_t', ['void *', 'void *']);
    const TerminateProcess = kernel32.func('TerminateProcess', 'int32_t', ['void *', 'uint32_t']);
    const TerminateJobObject = kernel32.func('TerminateJobObject', 'int32_t', ['void *', 'uint32_t']);
    const QueryInformationJobObject = kernel32.func('QueryInformationJobObject', 'int32_t', ['void *', 'int32_t', koffi.out(koffi.pointer(ACC)), 'uint32_t', 'void *']);
    const CloseHandle = kernel32.func('CloseHandle', 'int32_t', ['void *']);
    const GetLastError = kernel32.func('GetLastError', 'uint32_t', []);
    const PeekNamedPipe = kernel32.func('PeekNamedPipe', 'int32_t', ['void *', 'void *', 'uint32_t', 'void *', 'void *', 'void *']);
    const ReadFile = kernel32.func('ReadFile', 'int32_t', ['void *', 'void *', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'void *']);
    const WriteFile = kernel32.func('WriteFile', 'int32_t', ['void *', 'const void *', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'void *']);

    const SECURITY_ATTRIBUTES = koffi.struct('ZS_SECURITY_ATTRIBUTES', { nLength: 'uint32_t', lpSecurityDescriptor: 'void*', bInheritHandle: 'int32_t' });
    const CreatePipeFn = kernel32.func('CreatePipe', 'int32_t', [koffi.out(koffi.pointer('void *')), koffi.out(koffi.pointer('void *')), 'void *', 'uint32_t']);

    const CREATE_SUSPENDED = 4;
    const CREATE_NO_WINDOW = 0x08000000;
    const STARTF_USESTDHANDLES = 0x100;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const JobObjectExtendedLimitInformation = 9;
    const JobObjectBasicAccountingInformation = 1;
    const STILL_ACTIVE = 259;

    const lib: KoffiLib = {
      createProcessSuspended(cmdline, cwd, envLines, stdio) {
        const si: Record<string, unknown> = { cb: koffi.sizeof(STARTUPINFOW), flags: STARTF_USESTDHANDLES, hStdInput: stdio.in, hStdOutput: stdio.out, hStdError: stdio.err };
        const pi: { hProcess?: unknown; hThread?: unknown; dwProcessId?: number } = {};
        // 环境块：char16 "K=V\0K=V\0\0"（null env=继承父环境）。
        // koffi.alloc 返回 bigint 指针（ESM 严格模式不可下标赋值）——encode 逐元素写；char16 步长 2。
        const writeChar16Buf = (text: string): unknown => {
          const ptr = koffi.alloc(koffi.types.char16_t, text.length + 1);
          const base = Number(ptr);
          for (let i = 0; i < text.length; i++) koffi.encode(base + i * 2, 'char16_t', text.charCodeAt(i));
          koffi.encode(base + text.length * 2, 'char16_t', 0);
          return ptr;
        };
        let envArg: unknown = null;
        if (envLines != null) {
          envArg = writeChar16Buf(`${envLines.join('\0')}\0\0`);
        }
        let cwdArg: unknown = null;
        if (cwd != null) {
          cwdArg = writeChar16Buf(cwd);
        }
        const ok = CreateProcessW(null, cmdline, null, null, 1 /* bInheritHandles：继承 stdio 管道 */, CREATE_SUSPENDED | CREATE_NO_WINDOW, envArg, cwdArg, si, pi);
        if (ok === 0) return { ok: false, lastError: GetLastError() };
        return { ok: true, hProcess: pi.hProcess ?? null, hThread: pi.hThread ?? null, pid: pi.dwProcessId ?? 0 };
      },
      createJob() {
        return CreateJobObjectW(null, null);
      },
      setKillOnJobClose(job) {
        const liPtr = koffi.alloc(EXT_LIMIT, 1);
        koffi.encode(liPtr, EXT_LIMIT, { BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } });
        return SetInformationJobObject(job, JobObjectExtendedLimitInformation, liPtr, koffi.sizeof(EXT_LIMIT)) !== 0;
      },
      assignProcessToJob(job, hProcess) {
        return AssignProcessToJobObject(job, hProcess) !== 0;
      },
      resumeThread(hThread) {
        return ResumeThread(hThread);
      },
      waitFor(handle, timeoutMs) {
        return WaitForSingleObject(handle, timeoutMs);
      },
      getExitCode(hProcess) {
        const ptr = koffi.alloc('uint32_t', 1);
        if (GetExitCodeProcess(hProcess, ptr) === 0) return null;
        const v = koffi.decode(ptr, 'uint32_t') as number;
        return v === STILL_ACTIVE ? null : v;
      },
      terminateJob(job, exitCode) {
        return TerminateJobObject(job, exitCode) !== 0;
      },
      terminateProcess(hProcess, exitCode) {
        return TerminateProcess(hProcess, exitCode) !== 0;
      },
      queryActiveProcesses(job) {
        const acc: { ActiveProcesses?: number } = {};
        if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, acc, koffi.sizeof(ACC), null) === 0) return null;
        return acc.ActiveProcesses as number;
      },
      closeHandle(handle) {
        return CloseHandle(handle) !== 0;
      },
      peekAndRead(pipe, maxBytes) {
        // out 参数用 alloc+decode（koffi 程序化 out(pointer) 实测不回填）。
        const availPtr = koffi.alloc('uint32_t', 1);
        if (PeekNamedPipe(pipe, null, 0, null, availPtr, null) === 0) return null; // avail=第5参 lpTotalBytesAvail；管道关闭/错误→null
        const avail = koffi.decode(availPtr, 'uint32_t') as number;
        if (avail === 0) return '';
        const n = Math.min(avail, maxBytes);
        const buf = koffi.alloc('uint8_t', n);
        const readPtr = koffi.alloc('uint32_t', 1);
        if (ReadFile(pipe, buf, n, readPtr, null) === 0) return null;
        const got = koffi.decode(readPtr, 'uint32_t') as number;
        const decodedView = koffi.decode(buf, 'uint8_t', n) as Uint8Array;
        return Buffer.from(decodedView.buffer, decodedView.byteOffset, Math.min(got, n)).toString('utf8');
      },
      writePipe(pipe, data) {
        const buf = Buffer.from(data, 'utf8');
        const ptr = koffi.alloc('uint8_t', buf.length);
        const base = Number(ptr);
        for (let i = 0; i < buf.length; i++) koffi.encode(base + i, 'uint8_t', buf[i]);
        const writtenPtr = koffi.alloc('uint32_t', 1);
        if (WriteFile(pipe, ptr, buf.length, writtenPtr, null) === 0) return null;
        return koffi.decode(writtenPtr, 'uint32_t') as number;
      },
      closePipe(pipe) {
        return CloseHandle(pipe) !== 0;
      },
      mkPipe() {
        const readEnd: unknown[] = [null];
        const writeEnd: unknown[] = [null];
        const saPtr = koffi.alloc(SECURITY_ATTRIBUTES, 1);
        koffi.encode(saPtr, SECURITY_ATTRIBUTES, { nLength: koffi.sizeof(SECURITY_ATTRIBUTES), lpSecurityDescriptor: null, bInheritHandle: 1 });
        if (CreatePipeFn(readEnd, writeEnd, saPtr, 0) === 0) throw new Error('受管启动失败：CreatePipe 失败');
        return { childEnd: readEnd[0], parentEnd: writeEnd[0] };
      },
    };
    libCache = lib;
    return lib;
  } catch (error) {
    libCache = { unavailable: `koffi 加载失败（受管生命周期不可用）：${error instanceof Error ? error.message : String(error)}` };
    return libCache;
  }
}

export interface ManagedSpawnOptions {
  /** 可执行文件（绝对路径或 PATH 可解析名）。 */
  cmd: string;
  args: string[];
  cwd?: string;
  /** 附加环境（在父环境之上；null=完全继承父环境）。 */
  env?: Record<string, string> | null;
}

export interface ReleaseEvidence {
  /** 可解除：根进程已退出 + 本模块句柄已全部关闭 + job 活跃计数为 0。 */
  releasable: boolean;
  rootExited: boolean;
  handlesReleased: boolean;
  activeCount: number | null;
  reason: string;
}

export interface ManagedProcess {
  pid: number;
  writeStdin(data: string): void;
  /** 非阻塞读增量（''=暂无；null=管道已关/失败）。 */
  pollStdout(maxBytes?: number): string | null;
  pollStderr(maxBytes?: number): string | null;
  /** 等根进程退出（signaled）。返回退出码（等待超时=timedOut，code null）。 */
  waitRootExit(timeoutMs: number): { code: number | null; timedOut: boolean };
  /** 终止整个 job（含全部后代）。 */
  terminateAll(): void;
  /** 关闭本模块持有的进程/线程句柄（ActiveProcesses 归零与僵尸回收的必要条件）。 */
  releaseRootHandles(): void;
  /** job 活跃进程数（含全部派生后代；null=查询失败——不当作 0）。 */
  activeCount(): number | null;
  /**
   * 解除证据（修正点②）：只有「根已退出 ∧ 句柄已关 ∧ 计数=0」才 releasable=true；
   * 计数查询失败/句柄未关/根未退出都明确不可解除并给原因。
   */
  releaseEvidence(): ReleaseEvidence;
  /** 丢弃（正常收尾）：关 stdio 写端与进程句柄，最后关 job 句柄（KILL_ON_JOB_CLOSE 兜底）。 */
  dispose(): void;
}

/** 引号拼接命令行（含空格路径安全）。 */
function quoteCmdline(cmd: string, args: string[]): string {
  const q = (s: string): string => (/[\s"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  return [q(cmd), ...args.map(q)].join(' ');
}

/**
 * 受管启动（一体化）：挂起创建 → 建 job(KILL_ON_JOB_CLOSE) → 挂靠 → 恢复执行。
 * 任一步失败：终止挂起的子进程、清理全部句柄与管道、抛错——**不恢复执行、不降级为不受管**。
 */
export function spawnManagedProcess(options: ManagedSpawnOptions): ManagedProcess {
  const libOrErr = loadLib();
  if ('unavailable' in libOrErr) throw new Error(`受管启动不可用：${libOrErr.unavailable}`);
  const lib = libOrErr;

  // 管道对（子进程端需可继承：SA.bInheritHandle=1 + bInheritHandles=TRUE）。
  const stdinPipe = lib.mkPipe();   // 父写 parentEnd，子读 childEnd
  const stdoutPipe = lib.mkPipe();  // 子写 parentEnd，父读 childEnd
  const stderrPipe = lib.mkPipe();
  // mkPipe 返回 {childEnd=读端, parentEnd=写端}；stdio 需要的方向：
  const stdinChildRead = stdinPipe.childEnd; const stdinParentWrite = stdinPipe.parentEnd;
  const stdoutChildWrite = stdoutPipe.parentEnd; const stdoutParentRead = stdoutPipe.childEnd;
  const stderrChildWrite = stderrPipe.parentEnd; const stderrParentRead = stderrPipe.childEnd;

  const cmdline = quoteCmdline(options.cmd, options.args);
  const envLines = options.env != null
    ? [...Object.entries({ ...process.env, ...options.env }).map(([k, v]) => `${k}=${v ?? ''}`)]
    : null;

  let hProcess: unknown = null;
  let hThread: unknown = null;
  const cleanupPipes = (): void => {
    for (const h of [stdinParentWrite, stdoutParentRead, stderrParentRead]) {
      if (h != null) lib.closePipe(h);
    }
  };
  const created = lib.createProcessSuspended(cmdline, options.cwd ?? null, envLines, { in: stdinChildRead, out: stdoutChildWrite, err: stderrChildWrite });
  if (!created.ok) {
    cleanupPipes();
    throw new Error(`受管启动失败（CreateProcessW lastError=${created.lastError}）：${cmdline.slice(0, 120)}`);
  }
  hProcess = created.hProcess;
  hThread = created.hThread;

  let job: unknown = null;
  const failManaged = (step: string): never => {
    // 纳管失败：终止挂起子进程并清理——不恢复执行。
    if (hProcess != null) lib.terminateProcess(hProcess, 1);
    if (hThread != null) lib.closeHandle(hThread);
    if (hProcess != null) lib.closeHandle(hProcess);
    if (job != null) lib.closeHandle(job);
    cleanupPipes();
    throw new Error(`受管启动失败（${step}）——已终止挂起进程并清理句柄；不降级为不受管执行`);
  };

  job = lib.createJob(true);
  if (job == null || job === 0) failManaged('CreateJobObjectW');
  if (!lib.setKillOnJobClose(job)) failManaged('SetInformationJobObject(KILL_ON_JOB_CLOSE)');
  if (!lib.assignProcessToJob(job, hProcess)) failManaged('AssignProcessToJobObject');
  if (lib.resumeThread(hThread) === 0xFFFFFFFF) failManaged('ResumeThread');

  let handlesReleased = false;
  let disposed = false;
  let rootExitedMemo: boolean | null = null;
  return {
    pid: created.pid,
    writeStdin(data: string): void {
      if (lib.writePipe(stdinParentWrite, data) == null) throw new Error('stdin 写入失败（管道已关）');
    },
    pollStdout(maxBytes = 65536): string | null {
      return lib.peekAndRead(stdoutParentRead, maxBytes);
    },
    pollStderr(maxBytes = 65536): string | null {
      return lib.peekAndRead(stderrParentRead, maxBytes);
    },
    waitRootExit(timeoutMs: number): { code: number | null; timedOut: boolean } {
      const r = lib.waitFor(hProcess, timeoutMs);
      if (r !== 0) return { code: null, timedOut: true };
      rootExitedMemo = true; // 句柄关闭后 waitFor 不可再判——以观测备忘为准
      return { code: lib.getExitCode(hProcess), timedOut: false };
    },
    terminateAll(): void {
      lib.terminateJob(job, 1);
    },
    releaseRootHandles(): void {
      if (handlesReleased) return;
      handlesReleased = true;
      lib.closeHandle(hThread);
      lib.closeHandle(hProcess);
    },
    activeCount(): number | null {
      return lib.queryActiveProcesses(job);
    },
    releaseEvidence(): ReleaseEvidence {
      const count = lib.queryActiveProcesses(job);
      const rootExited = rootExitedMemo ?? (lib.waitFor(hProcess, 0) === 0);
      const releasable = rootExited && handlesReleased && count === 0;
      const reason = releasable
        ? '根进程已退出、本模块句柄已关闭、job 活跃计数 0——受管执行完整结束'
        : count == null ? 'job 活跃计数查询失败——按未完整确认处理（不当作 0）'
          : count > 0 ? `job 内仍有 ${count} 个活跃进程（后代存活或句柄未关）——未完整确认`
            : !rootExited ? '根进程未退出'
              : !handlesReleased ? '本模块仍持有根进程句柄（ActiveProcesses 归零与僵尸回收的必要条件未满足）'
                : '计数 0 但窗口内仍需复核（系统清理延迟）——保守不解除';
      return { releasable, rootExited, handlesReleased, activeCount: count, reason };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      this.releaseRootHandles();
      lib.closePipe(stdinParentWrite);
      lib.closePipe(stdoutParentRead);
      lib.closePipe(stderrParentRead);
      lib.closeHandle(job); // 最后关 job：仍在 job 内的进程由 KILL_ON_JOB_CLOSE 终止
    },
  };
}
