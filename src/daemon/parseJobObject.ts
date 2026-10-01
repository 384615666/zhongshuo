/**
 * 解析子进程的进程总内存硬界（第三十轮二）——Windows Job Object：
 * `--max-old-space-size` 只限制 V8 老生代，**外部 Buffer（Buffer.alloc/TypedArray）不受其
 * 约束**——此前「内存硬界 320MB」的表述不准确。本模块给解析子进程附加
 * JobObjectExtendedLimitInformation（JOB_OBJECT_LIMIT_PROCESS_MEMORY 覆盖**整进程提交内存**
 * + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 防句柄悬挂孤儿）。
 * - 附加失败/非 Windows：不阻断解析——限制降级为仅 V8 上限（调用方与测试须按此缺口断言，
 *   不宣称整进程硬界）。
 * - 句柄生命周期：Assign 成功后即可 CloseHandle（job 对象因 KILL_ON_JOB_CLOSE 与子进程
 *   绑定存续，子进程退出即收口）；Assign 前失败则关闭双方句柄不留孤儿 job。
 */
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

export interface JobAttachOutcome {
  attached: boolean;
  limitBytes: number;
  note: string;
}

interface KoffiMemLib {
  openProcess(pid: number): unknown | null;
  createJob(): unknown | null;
  setMemoryLimit(job: unknown, limitBytes: number): boolean;
  assign(job: unknown, hProcess: unknown): boolean;
  closeHandle(h: unknown): void;
}

let libCache: KoffiMemLib | null | undefined;
function loadLib(): KoffiMemLib | null {
  if (libCache !== undefined) return libCache;
  libCache = null;
  if (process.platform !== 'win32') return libCache;
  try {
    // 动态加载（daemon bundle 下 koffi 为 external——nodeRequire 解析方式沿用 jobManager）。
    const nodeRequire: ReturnType<typeof createRequire> = typeof __filename === 'string'
      ? createRequire(__filename)
      : (() => { try { return createRequire(import.meta.url); } catch { return createRequire(process.argv[1] ?? process.execPath); } })();
    const koffi = nodeRequire('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const PROCESS_SET_QUOTA = 0x0100;
    const PROCESS_TERMINATE = 0x0001;
    const OpenProcess = kernel32.func('OpenProcess', 'void *', ['uint32_t', 'int32_t', 'uint32_t']);
    const CreateJobObjectW = kernel32.func('CreateJobObjectW', 'void *', ['void *', 'const char16_t *']);
    const AssignProcessToJobObject = kernel32.func('AssignProcessToJobObject', 'int32_t', ['void *', 'void *']);
    const CloseHandle = kernel32.func('CloseHandle', 'int32_t', ['void *']);
    const SetInformationJobObject = kernel32.func('SetInformationJobObject', 'int32_t', ['void *', 'int32_t', 'const void *', 'uint32_t']);
    const JobObjectExtendedLimitInformation = 9;
    const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x0100;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION 布局（x64）：BasicLimitInformation 64B
    //（PerProcessUserTimeLimit@0/PerJobUserTimeLimit@8/LimitFlags@16/…）+IoInfo 48B+
    // ProcessMemoryLimit@112/JobMemoryLimit@120/Peak…@128/136——总 144B。
    const EXT_SIZE = 144;
    libCache = {
      openProcess(pid) {
        return OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      },
      createJob() {
        return CreateJobObjectW(null, null);
      },
      setMemoryLimit(job, limitBytes) {
        const buf = Buffer.alloc(EXT_SIZE);
        buf.fill(0);
        buf.writeUInt32LE(JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16); // LimitFlags@16
        buf.writeBigUInt64LE(BigInt(Math.floor(limitBytes)), 112); // ProcessMemoryLimit@112
        return SetInformationJobObject(job, JobObjectExtendedLimitInformation, buf, EXT_SIZE) !== 0;
      },
      assign(job, hProcess) {
        return AssignProcessToJobObject(job, hProcess) !== 0;
      },
      closeHandle(h) {
        try { CloseHandle(h); } catch { /* 尽力 */ }
      },
    };
  } catch {
    libCache = null;
  }
  return libCache;
}

/** 给解析子进程附加整进程提交内存上限（Job Object）。失败=降级仅 V8 上限（如实返回）。 */
export async function attachMemoryJobObject(child: ChildProcess, limitBytes: number): Promise<JobAttachOutcome> {
  const pid = child.pid;
  if (pid == null) return { attached: false, limitBytes, note: '子进程 pid 不可用（未附加）' };
  const lib = loadLib();
  if (lib == null) return { attached: false, limitBytes, note: process.platform === 'win32' ? 'koffi/kernel32 不可用（限制降级为仅 V8 上限）' : `平台 ${process.platform} 无 Job Object（限制降级为仅 V8 上限）` };
  const hProcess = lib.openProcess(pid);
  if (hProcess == null) return { attached: false, limitBytes, note: 'OpenProcess 失败（限制降级为仅 V8 上限）' };
  const job = lib.createJob();
  if (job == null) { lib.closeHandle(hProcess); return { attached: false, limitBytes, note: 'CreateJobObject 失败（限制降级为仅 V8 上限）' }; }
  try {
    if (!lib.setMemoryLimit(job, limitBytes)) { lib.closeHandle(job); return { attached: false, limitBytes, note: 'SetInformationJobObject 失败（限制降级为仅 V8 上限）' }; }
    if (!lib.assign(job, hProcess)) { lib.closeHandle(job); return { attached: false, limitBytes, note: 'AssignProcessToJobObject 失败（限制降级为仅 V8 上限）' }; }
    // **job 句柄必须存活到子进程退出**：KILL_ON_JOB_CLOSE 语义=最后一个句柄关闭即终止全 job——
    // Assign 后立即关闭会当场杀掉子进程（实测教训）。退出时关闭=同时兜底父侧句柄悬挂孤儿
    //（父进程崩溃时 OS 关句柄→job 内子进程被杀，不残留）。
    child.once('exit', () => lib.closeHandle(job));
    return { attached: true, limitBytes, note: `JobObject PROCESS_MEMORY=${limitBytes}B+KILL_ON_JOB_CLOSE（整进程提交内存硬界）` };
  } finally {
    lib.closeHandle(hProcess); // 进程句柄 Assign 后即可关（job 已持有成员关系）
  }
}

/** 测试/诊断：当前平台是否具备 Job Object 能力（不具备时测试须按降级口径断言）。 */
export function jobObjectCapability(): boolean {
  return loadLib() != null;
}
