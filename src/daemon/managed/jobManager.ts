/**
 * REC-LIFE-1（第十二轮五/第十三轮一）：Windows Job Object 受管生命周期。
 *
 * 上游：ADR-0010 + rec-life-1-plan.md。按实测与官方 API 语义实现：
 * - 挂起创建（CREATE_SUSPENDED）→ 建 job（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE）→ 挂靠 →
 *   恢复——纳管窗口为零；失败任一步：终止挂起子进程+回收全部管道/句柄→抛错（不降级）。
 * - **ActiveProcesses 归零必要条件（实测）**：进程终止 + 本模块句柄全关 + 系统清理延迟；
 *   查询失败≠0；句柄未关≠已退出。releaseEvidence 只在「根退出∧句柄已关∧计数 0」可解除。
 * - 生命周期（第十三轮一）分立记录：rootExited / stdioClosed / evidenceReleased /
 *   consumed / finalized——根退出但后代仍活时保留可查询 job 与保护；证据不因关输出流消失；
 *   dispose() 才最终回收句柄与记录。
 * - stdio：字节流 Buffer 传递（跨 chunk 增量解码由消费端处理）；父侧不再使用的子端句柄
 *   在 CreateProcess 成功后立即关闭；stdin.end() 关父侧写端=子进程收到 EOF。
 * - argv 编码：Windows 命令行引用规则（MSVCRT argv 解析约定）——非 shell 引号。
 * - 同步 WriteFile 大输入阻塞：写入按 64KB 分片+批内让步（writeStdinChunked）。
 * - daemon 崩溃兜底：job 句柄仅在 daemon 进程（不被子继承）；KILL_ON_JOB_CLOSE。
 */
import { platform } from 'node:process';
import { createRequire } from 'node:module';

interface KoffiLib {
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
  /** 非阻塞读原始字节（无=空 Buffer；管道关闭/错误=null）。 */
  peekAndReadBytes(pipe: unknown, maxBytes: number): Buffer | null;
  /** 同步写字节（返回写入数；失败=null）。仅小块；大输入走 writePipeBytesAsync。 */
  writePipeBytes(pipe: unknown, data: Buffer): number | null;
  /** 异步写字节（koffi async——阻塞的 WriteFile 不挂死事件循环）；返回 Promise<number|null>。 */
  writePipeBytesAsync(pipe: unknown, data: Buffer): Promise<number | null>;
  closePipe(pipe: unknown): boolean;
  /** 清除句柄继承标志（父侧端不进子进程——EOF/管道方向语义正确的前提）。 */
  clearInherit(handle: unknown): boolean;
  mkPipe(): { childEnd: unknown; parentEnd: unknown };
}

let libCache: KoffiLib | { unavailable: string } | null = null;

/** 受管能力可用性（加载失败/非 win32 → 不可用；调用方须拒绝受管派发，不降级）。 */
export function managedRuntimeAvailable(): { ok: true } | { ok: false; reason: string } {
  if (platform !== 'win32') return { ok: false, reason: `平台 ${platform} 未实现受管生命周期（Job Object 为 Windows 能力；非 win32 按平台分列，不虚构等价）` };
  const l = loadLib();
  return 'unavailable' in l ? { ok: false, reason: l.unavailable } : { ok: true };
}

/** Windows 命令行参数引用（MSVCRT argv 解析约定；非 shell 规则）：
 * 反斜杠仅在紧邻引号时加倍；包裹含空白/引号的参数；参数内引号转义为 \"。 */
function quoteArg(arg: string): string {
  if (arg === '') return '""';
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/** 完整命令行（首参=可执行，同样按 argv 规则引用）。 */
export function buildCmdline(cmd: string, args: string[]): string {
  return [quoteArg(cmd), ...args.map(quoteArg)].join(' ');
}

function loadLib(): KoffiLib | { unavailable: string } {
  if (libCache != null) return libCache;
  try {
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
    const SECURITY_ATTRIBUTES = koffi.struct('ZS_SECURITY_ATTRIBUTES', { nLength: 'uint32_t', lpSecurityDescriptor: 'void*', bInheritHandle: 'int32_t' });

    const CreateProcessW = kernel32.func('CreateProcessW', 'int32_t', ['const char16_t *', 'char16_t *', 'void *', 'void *', 'int32_t', 'uint32_t', 'const char16_t *', 'const char16_t *', koffi.inout(koffi.pointer(STARTUPINFOW)), koffi.out(koffi.pointer(PROCESS_INFORMATION))]);
    const ResumeThread = kernel32.func('ResumeThread', 'uint32_t', ['void *']);
    const WaitForSingleObject = kernel32.func('WaitForSingleObject', 'uint32_t', ['void *', 'uint32_t']);
    const GetExitCodeProcess = kernel32.func('GetExitCodeProcess', 'int32_t', ['void *', 'void *']);
    const TerminateProcess = kernel32.func('TerminateProcess', 'int32_t', ['void *', 'uint32_t']);
    const TerminateJobObject = kernel32.func('TerminateJobObject', 'int32_t', ['void *', 'uint32_t']);
    const QueryInformationJobObject = kernel32.func('QueryInformationJobObject', 'int32_t', ['void *', 'int32_t', koffi.out(koffi.pointer(ACC)), 'uint32_t', 'void *']);
    const SetInformationJobObject = kernel32.func('SetInformationJobObject', 'int32_t', ['void *', 'int32_t', 'const void *', 'uint32_t']);
    const CloseHandle = kernel32.func('CloseHandle', 'int32_t', ['void *']);
    const GetLastError = kernel32.func('GetLastError', 'uint32_t', []);
    const CreatePipeFn = kernel32.func('CreatePipe', 'int32_t', [koffi.out(koffi.pointer('void *')), koffi.out(koffi.pointer('void *')), 'void *', 'uint32_t']);
    const SetHandleInformation = kernel32.func('SetHandleInformation', 'int32_t', ['void *', 'uint32_t', 'uint32_t']);
    const PeekNamedPipe = kernel32.func('PeekNamedPipe', 'int32_t', ['void *', 'void *', 'uint32_t', 'void *', 'void *', 'void *']);
    const ReadFile = kernel32.func('ReadFile', 'int32_t', ['void *', 'void *', 'uint32_t', 'void *', 'void *']);
    const WriteFile = kernel32.func('WriteFile', 'int32_t', ['void *', 'const void *', 'uint32_t', 'void *', 'void *']);
    const WriteFileAsync = kernel32.func('WriteFile', 'int32_t', ['void *', 'const void *', 'uint32_t', 'void *', 'void *']); // 异步形态=WriteFileAsync.async(...)

    const CREATE_SUSPENDED = 4;
    const CREATE_NO_WINDOW = 0x08000000;
    const STARTF_USESTDHANDLES = 0x100;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const JobObjectExtendedLimitInformation = 9;
    const JobObjectBasicAccountingInformation = 1;
    const STILL_ACTIVE = 259;

    const writeChar16Buf = (text: string): unknown => {
      const ptr = koffi.alloc(koffi.types.char16_t, text.length + 1);
      const base = Number(ptr);
      for (let i = 0; i < text.length; i++) koffi.encode(base + i * 2, 'char16_t', text.charCodeAt(i));
      koffi.encode(base + text.length * 2, 'char16_t', 0);
      return ptr;
    };
    const writeByteBuf = (data: Buffer): unknown => {
      const ptr = koffi.alloc('uint8_t', data.length);
      const base = Number(ptr);
      for (let i = 0; i < data.length; i++) koffi.encode(base + i, 'uint8_t', data[i]);
      return ptr;
    };

    const CreateJobObjectW = kernel32.func('CreateJobObjectW', 'void *', ['void *', 'const char16_t *']);
    const AssignProcessToJobObject = kernel32.func('AssignProcessToJobObject', 'int32_t', ['void *', 'void *']);

    const lib: KoffiLib = {
      createProcessSuspended(cmdline, cwd, envLines, stdio) {
        const si: Record<string, unknown> = { cb: koffi.sizeof(STARTUPINFOW), flags: STARTF_USESTDHANDLES, hStdInput: stdio.in, hStdOutput: stdio.out, hStdError: stdio.err };
        const pi: { hProcess?: unknown; hThread?: unknown; dwProcessId?: number } = {};
        let envArg: unknown = null;
        if (envLines != null) envArg = writeChar16Buf(`${envLines.join('\0')}\0\0`);
        let cwdArg: unknown = null;
        if (cwd != null) cwdArg = writeChar16Buf(cwd);
        // lpCommandLine 须可写缓冲（koffi 字符串按 const 传递时实现自有副本）——显式构建。
        const cmdlinePtr = writeChar16Buf(cmdline);
        const ok = CreateProcessW(null, cmdlinePtr, null, null, 1 /* bInheritHandles：stdio 管道 */, CREATE_SUSPENDED | CREATE_NO_WINDOW, envArg, cwdArg, si, pi);
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
        return acc.ActiveProcesses ?? null;
      },
      closeHandle(handle) {
        return CloseHandle(handle) !== 0;
      },
      peekAndReadBytes(pipe, maxBytes) {
        const availPtr = koffi.alloc('uint32_t', 1);
        if (PeekNamedPipe(pipe, null, 0, null, availPtr, null) === 0) return null; // avail=第 5 参 lpTotalBytesAvail
        const avail = koffi.decode(availPtr, 'uint32_t') as number;
        if (avail === 0) return Buffer.alloc(0);
        const n = Math.min(avail, maxBytes);
        const buf = koffi.alloc('uint8_t', n);
        const readPtr = koffi.alloc('uint32_t', 1);
        if (ReadFile(pipe, buf, n, readPtr, null) === 0) return null;
        const got = koffi.decode(readPtr, 'uint32_t') as number;
        const view = koffi.decode(buf, 'uint8_t', n) as Uint8Array;
        return Buffer.from(view.buffer, view.byteOffset, Math.min(got, n));
      },
      writePipeBytes(pipe, data) {
        if (data.length === 0) return 0;
        const ptr = writeByteBuf(data);
        const writtenPtr = koffi.alloc('uint32_t', 1);
        if (WriteFile(pipe, ptr, data.length, writtenPtr, null) === 0) return null;
        return koffi.decode(writtenPtr, 'uint32_t') as number;
      },
      writePipeBytesAsync(pipe, data) {
        if (data.length === 0) return Promise.resolve(0);
        const ptr = writeByteBuf(data);
        const writtenPtr = koffi.alloc('uint32_t', 1);
        // koffi 异步调用形态=fn.async(args…, callback)（后台线程执行——管道满/消费者停滞时
        // 事件循环仍活：daemon 停止/心跳/其他任务不挂死）；参数由 koffi 异步堆保存到回调。
        return new Promise<number | null>((resolve) => {
          WriteFileAsync.async(pipe, ptr, data.length, writtenPtr, null, (err: unknown, rc: number) => {
            if (err != null || rc === 0) {
              resolve(null);
              return;
            }
            resolve(koffi.decode(writtenPtr, 'uint32_t') as number);
          });
        });
      },
      closePipe(pipe) {
        return CloseHandle(pipe) !== 0;
      },
      clearInherit(handle) {
        return SetHandleInformation(handle, 1 /* HANDLE_FLAG_INHERIT */, 0) !== 0;
      },
      mkPipe() {
        const readEnd: unknown[] = [null];
        const writeEnd: unknown[] = [null];
        const saPtr = koffi.alloc(SECURITY_ATTRIBUTES, 1);
        koffi.encode(saPtr, SECURITY_ATTRIBUTES, { nLength: koffi.sizeof(SECURITY_ATTRIBUTES), lpSecurityDescriptor: null, bInheritHandle: 1 });
        if (CreatePipeFn(readEnd, writeEnd, saPtr, 0) === 0) throw new Error('受管启动失败：CreatePipe 失败（lastError=' + GetLastError() + '）');
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
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string> | null;
}

/** 生命周期阶段（第十三轮一：分立记录，供恢复链查询）。 */
export interface ManagedLifecycle {
  /** 根进程已 signaled（退出码已知或句柄已关后以观测备忘）。 */
  rootExited: boolean;
  /** stdio 读端已排空并关闭（输出流结束）。 */
  stdioClosed: boolean;
  /** 释放证据已生成（根退出+句柄已关+计数 0）。 */
  evidenceReleased: boolean;
  /** 恢复命令已消费证据（releaseProtection 解除成功后由调用方标记）。 */
  consumed: boolean;
  /** 资源最终释放（dispose 后=true）。 */
  finalized: boolean;
}

export interface ReleaseEvidence {
  releasable: boolean;
  rootExited: boolean;
  handlesReleased: boolean;
  activeCount: number | null;
  reason: string;
}

export interface ManagedProcess {
  pid: number;
  /** 本受管实例的稳定身份（job 创建时刻+pid——不用可复用 PID 做唯一身份）。 */
  jobId: string;
  writeStdin(data: string): void;
  /** 大输入分片写（64KB/片，片间 setImmediate 让步——防同步 WriteFile 阻塞事件循环）。 */
  writeStdinChunked(data: string): Promise<void>;
  writeStdinChunkedBytes(buf: Buffer): Promise<void>;
  /** 关闭父侧 stdin 写端——子进程 read 收到 EOF。 */
  endStdin(): void;
  /** 非阻塞读增量原始字节（空=暂无；null=管道已关/失败）。跨 chunk 解码由消费端处理。 */
  pollStdoutBytes(maxBytes?: number): Buffer | null;
  pollStderrBytes(maxBytes?: number): Buffer | null;
  /** 便捷文本读（增量拼接由调用方保证——本方法不做跨 chunk 解码承诺）。 */
  pollStdout(maxBytes?: number): string | null;
  pollStderr(maxBytes?: number): string | null;
  /** 输出管道是否已无数据且子端关闭（读完排空判定）。 */
  stdoutDrained(): boolean | null;
  stderrDrained(): boolean | null;
  waitRootExit(timeoutMs: number): { code: number | null; timedOut: boolean };
  terminateAll(): void;
  releaseRootHandles(): void;
  /** 关闭父侧输出读端（流结束；证据/查询不依赖输出流）。 */
  closeOutputPipes(): void;
  activeCount(): number | null;
  releaseEvidence(): ReleaseEvidence;
  /** 恢复命令消费证据后标记（生命周期审计）。 */
  markConsumed(): void;
  lifecycle(): ManagedLifecycle;
  /** stdout/stderr 累计读出字节数（背压/容量观测）。 */
  bytesRead(): { stdout: number; stderr: number };
  dispose(): void;
}

const WRITE_CHUNK = 64 * 1024;

export function spawnManagedProcess(options: ManagedSpawnOptions): ManagedProcess {
  const libOrErr = loadLib();
  if ('unavailable' in libOrErr) throw new Error(`受管启动不可用：${libOrErr.unavailable}`);
  const lib = libOrErr;

  const stdinPipe = lib.mkPipe();   // 子读 childEnd；父写 parentEnd
  const stdoutPipe = lib.mkPipe();  // 子写 parentEnd；父读 childEnd
  const stderrPipe = lib.mkPipe();
  const stdinChildRead = stdinPipe.childEnd;
  const stdinParentWrite = stdinPipe.parentEnd;
  const stdoutChildWrite = stdoutPipe.parentEnd;
  const stdoutParentRead = stdoutPipe.childEnd;
  const stderrChildWrite = stderrPipe.parentEnd;
  const stderrParentRead = stderrPipe.childEnd;

  // 父侧端取消继承（bInheritHandles=TRUE 会继承**全部**可继承句柄——否则子进程持有自己
  // 的 stdin 写端（EOF 永不到来）与 stdout 读端：这正是第十三轮一要求修复的句柄语义）。
  lib.clearInherit(stdinParentWrite);
  lib.clearInherit(stdoutParentRead);
  lib.clearInherit(stderrParentRead);

  const cmdline = buildCmdline(options.cmd, options.args);
  // 环境（第十三轮一实证）：koffi 的 CreateProcessW 对任何非空 lpEnvironment 恒返回
  // ERROR_INVALID_PARAMETER(87)——同指针经 CreateProcessA 有效、GetEnvironmentStringsW 系统
  // 原生块与 VirtualAlloc 页对齐块同样 87（位置无关：同值作 cwd=267 正常读取）。结论=FFI 层
  // W 变体缺陷，非块构造问题。受支持路径=**继承父环境**（env=NULL，语义等价 {...process.env}）；
  // 真实覆盖（与父环境不同的键值）显式报错——不静默错环境、不降级猜测。
  const envOverrides = options.env != null
    ? Object.entries(options.env).filter(([k, v]) => (process.env as Record<string, string | undefined>)[k] !== (v ?? ''))
    : [];
  if (envOverrides.length > 0) {
    throw new Error(`受管环境覆盖暂不支持（koffi CreateProcessW lpEnvironment 缺陷：非空环境块恒 87——同指针 A 变体有效/系统原生块亦 87，实证见 managedBridge 测试与第十三轮报告）。请求覆盖 ${envOverrides.length} 项（${envOverrides.slice(0, 3).map(([k]) => k).join('、')}${envOverrides.length > 3 ? ' 等' : ''}）；当前受管路径继承父环境——如需覆盖请在受管开关关闭的部署上运行`);
  }
  const envLines: string[] | null = null; // 继承父环境（唯一受支持路径）

  let hProcess: unknown = null;
  let hThread: unknown = null;
  // 父侧持有的子端句柄（传给 STARTUPINFO 后必须关闭，否则父进程持子端导致 EOF 永不到来）。
  const childEnds = [stdinChildRead, stdoutChildWrite, stderrChildWrite];
  const closeChildEnds = (): void => {
    for (const h of childEnds) if (h != null) lib.closePipe(h);
  };

  const created = lib.createProcessSuspended(cmdline, options.cwd ?? null, envLines, { in: stdinChildRead, out: stdoutChildWrite, err: stderrChildWrite });
  if (!created.ok) {
    // 创建失败：回收全部管道（含子端——从未交给任何进程）。
    closeChildEnds();
    lib.closePipe(stdinParentWrite); lib.closePipe(stdoutParentRead); lib.closePipe(stderrParentRead);
    throw new Error(`受管启动失败（CreateProcessW lastError=${created.lastError}）：${cmdline.slice(0, 120)}`);
  }
  hProcess = created.hProcess;
  hThread = created.hThread;
  // 子端已继承——父侧副本立即关闭（不持有子端：EOF 语义与句柄计数正确）。
  closeChildEnds();

  let job: unknown = null;
  const failManaged = (step: string): never => {
    if (hProcess != null) lib.terminateProcess(hProcess, 1);
    if (hThread != null) lib.closeHandle(hThread);
    if (hProcess != null) lib.closeHandle(hProcess);
    if (job != null) lib.closeHandle(job);
    lib.closePipe(stdinParentWrite); lib.closePipe(stdoutParentRead); lib.closePipe(stderrParentRead);
    throw new Error(`受管启动失败（${step}）——已终止挂起进程并回收管道/句柄；不降级为不受管执行`);
  };

  job = lib.createJob(true);
  if (job == null || job === 0) failManaged('CreateJobObjectW');
  if (!lib.setKillOnJobClose(job)) failManaged('SetInformationJobObject(KILL_ON_JOB_CLOSE)');
  if (!lib.assignProcessToJob(job, hProcess)) failManaged('AssignProcessToJobObject');
  if (lib.resumeThread(hThread) === 0xFFFFFFFF) failManaged('ResumeThread');

  const lifecycleState: ManagedLifecycle = { rootExited: false, stdioClosed: false, evidenceReleased: false, consumed: false, finalized: false };
  let handlesReleased = false;
  let stdinEnded = false;
  let stdoutPipeClosed = false;
  let stderrPipeClosed = false;
  let outBytes = 0;
  let errBytes = 0;
  const jobId = `job-${Date.now().toString(36)}-${created.pid}`;

  return {
    pid: created.pid,
    jobId,
    writeStdin(data: string): void {
      if (stdinEnded) throw new Error('stdin 已关闭（endStdin 后不可写）');
      const buf = Buffer.from(data, 'utf8');
      if (lib.writePipeBytes(stdinParentWrite, buf) == null) throw new Error('stdin 写入失败（管道已关）');
    },
    async writeStdinChunked(data: string): Promise<void> {
      await this.writeStdinChunkedBytes(Buffer.from(data, 'utf8'));
    },
    async writeStdinChunkedBytes(buf: Buffer): Promise<void> {
      if (stdinEnded) throw new Error('stdin 已关闭（endStdin 后不可写）');
      // 异步分片串行：每片经 writePipeBytesAsync（阻塞不挂死事件循环）+ 微任务让步；
      // 同一管道在途写至多一个（匿名管道无原子并发承诺）。
      for (let off = 0; off < buf.length; off += WRITE_CHUNK) {
        const slice = buf.subarray(off, Math.min(off + WRITE_CHUNK, buf.length));
        const written = await lib.writePipeBytesAsync(stdinParentWrite, slice);
        if (written == null) throw new Error('stdin 分片写入失败（管道已关或写失败）');
      }
    },
    endStdin(): void {
      if (stdinEnded) return;
      stdinEnded = true;
      lib.closePipe(stdinParentWrite); // 关父侧写端=子 read 得 EOF
    },
    pollStdoutBytes(maxBytes = 1 << 20): Buffer | null {
      if (stdoutPipeClosed) return null;
      const r = lib.peekAndReadBytes(stdoutParentRead, maxBytes);
      if (r == null) {
        stdoutPipeClosed = true;
        return null;
      }
      outBytes += r.length;
      return r;
    },
    pollStderrBytes(maxBytes = 1 << 20): Buffer | null {
      if (stderrPipeClosed) return null;
      const r = lib.peekAndReadBytes(stderrParentRead, maxBytes);
      if (r == null) {
        stderrPipeClosed = true;
        return null;
      }
      errBytes += r.length;
      return r;
    },
    pollStdout(maxBytes?: number): string | null {
      const b = this.pollStdoutBytes(maxBytes);
      return b == null ? null : b.toString('utf8');
    },
    pollStderr(maxBytes?: number): string | null {
      const b = this.pollStderrBytes(maxBytes);
      return b == null ? null : b.toString('utf8');
    },
    stdoutDrained(): boolean | null {
      if (stdoutPipeClosed) return true;
      const r = lib.peekAndReadBytes(stdoutParentRead, 1);
      if (r == null) {
        stdoutPipeClosed = true;
        return true;
      }
      return r.length === 0 ? null : false; // null=尚无数据（不能断定排空）
    },
    stderrDrained(): boolean | null {
      if (stderrPipeClosed) return true;
      const r = lib.peekAndReadBytes(stderrParentRead, 1);
      if (r == null) {
        stderrPipeClosed = true;
        return true;
      }
      return r.length === 0 ? null : false;
    },
    waitRootExit(timeoutMs: number): { code: number | null; timedOut: boolean } {
      const r = lib.waitFor(hProcess, timeoutMs);
      if (r !== 0) return { code: null, timedOut: true };
      lifecycleState.rootExited = true;
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
    closeOutputPipes(): void {
      if (!stdoutPipeClosed) {
        stdoutPipeClosed = true;
        lib.closePipe(stdoutParentRead);
      }
      if (!stderrPipeClosed) {
        stderrPipeClosed = true;
        lib.closePipe(stderrParentRead);
      }
      if (!stdinEnded) {
        stdinEnded = true;
        lib.closePipe(stdinParentWrite);
      }
      lifecycleState.stdioClosed = true;
    },
    activeCount(): number | null {
      return lib.queryActiveProcesses(job);
    },
    releaseEvidence(): ReleaseEvidence {
      const count = lib.queryActiveProcesses(job);
      const rootExited = lifecycleState.rootExited || lib.waitFor(hProcess, 0) === 0;
      const releasable = rootExited && handlesReleased && count === 0;
      const reason = releasable
        ? '根进程已退出、本模块句柄已关闭、job 活跃计数 0——受管执行完整结束'
        : count == null ? 'job 活跃计数查询失败——按未完整确认处理（不当作 0）'
          : count > 0 ? `job 内仍有 ${count} 个活跃进程（后代存活或句柄未关）——未完整确认`
            : !rootExited ? '根进程未退出'
              : !handlesReleased ? '本模块仍持有根进程句柄（ActiveProcesses 归零与僵尸回收的必要条件未满足）'
                : '计数 0 但窗口内仍需复核（系统清理延迟）——保守不解除';
      if (releasable) lifecycleState.evidenceReleased = true;
      return { releasable, rootExited, handlesReleased, activeCount: count, reason };
    },
    markConsumed(): void {
      lifecycleState.consumed = true;
    },
    lifecycle(): ManagedLifecycle {
      return { ...lifecycleState };
    },
    bytesRead(): { stdout: number; stderr: number } {
      return { stdout: outBytes, stderr: errBytes };
    },
    dispose(): void {
      if (lifecycleState.finalized) return;
      lifecycleState.finalized = true;
      this.releaseRootHandles();
      this.closeOutputPipes();
      lib.closeHandle(job); // 最后关 job：job 内残留进程由 KILL_ON_JOB_CLOSE 终止
    },
  };
}
