/**
 * OS 层进程身份取证（DEV-13，2026-09-28 第六轮·下）——恢复对账的退出事实证据来源。
 *
 * 语义（如实，不越权断言）：
 * - alive：进程存在（可再取 StartTime/CreationDate 供复用检测）；
 * - exited：OS 报告该 PID 不存在；
 * - unknown：查询失败/平台不支持——不以 daemon 自身存活推断子进程状态。
 * PID 复用：PID 相同但进程启动时间（代次）不同=不是同一进程（身份变化，判定退回 unknown）。
 * 实现差异：win32 走 PowerShell（含 StartTime）；其他平台 process.kill(pid,0) 判活
 * （无启动时间——复用检测不可用，如实返回 unknown 而非猜测）。
 */
import { execFileSync } from 'node:child_process';

export interface ProcessIdentity {
  pid: number;
  /** 进程启动时间（epoch ms；null=平台不可得）。 */
  startedAt: number | null;
}

export type LivenessResult =
  | { state: 'alive'; identity: ProcessIdentity }
  | { state: 'exited'; pid: number }
  | { state: 'unknown'; pid: number; error: string };

const IS_WINDOWS = process.platform === 'win32';

/** 查询进程存活与身份（真实 OS 查询，不做任何推断）。 */
export function checkProcessLiveness(pid: number): LivenessResult {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', pid, error: '非法 PID' };
  if (IS_WINDOWS) {
    try {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; $s = $p.StartTime; [Console]::Write(($s.ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds) } catch { [Console]::Write('EXITED') }`,
      ], { encoding: 'utf8', timeout: 8000 });
      const text = out.trim();
      if (text === 'EXITED') return { state: 'exited', pid };
      const ms = Number(text);
      if (!Number.isFinite(ms)) return { state: 'unknown', pid, error: `StartTime 解析失败：${text.slice(0, 60)}` };
      return { state: 'alive', identity: { pid, startedAt: Math.round(ms) } };
    } catch (error) {
      return { state: 'unknown', pid, error: `PowerShell 查询失败：${String(error).slice(0, 100)}` };
    }
  }
  try {
    process.kill(pid, 0);
    return { state: 'alive', identity: { pid, startedAt: null } }; // 非 win32 无启动时间——复用检测不可用
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'exited', pid };
    return { state: 'unknown', pid, error: `kill(0) 失败：${code ?? String(error)}` };
  }
}

/**
 * PID 复用检测：同一 PID 的两次身份观测（历史 vs 当前）是否同一进程。
 * 任一侧启动时间缺失 → 无法确认=unknown（不猜测「相同」）。
 */
export function sameProcessIdentity(
  historical: ProcessIdentity,
  current: ProcessIdentity,
  toleranceMs = 1500,
): 'same' | 'different' | 'unknown' {
  if (historical.pid !== current.pid) return 'different';
  if (historical.startedAt == null || current.startedAt == null) return 'unknown';
  return Math.abs(historical.startedAt - current.startedAt) <= toleranceMs ? 'same' : 'different';
}

/**
 * 组装 recovery.reconcile 的 exitEvidence（osProcessCheck）：
 * 观测当前存活状态；若提供历史身份则先做复用检测（复用=不是原进程→unknown，不得据此判退出）。
 */
export function buildExitEvidence(pid: number, historicalIdentity?: ProcessIdentity): {
  kind: 'osProcessCheck';
  pid: number;
  observedAt: number;
  alive: boolean;
  reuseCheck?: 'same' | 'different' | 'unknown';
  note?: string;
} | { error: string } {
  const r = checkProcessLiveness(pid);
  if (r.state === 'unknown') return { error: `进程查询不可确认：${r.error}` };
  let reuseCheck: 'same' | 'different' | 'unknown' | undefined;
  let note: string | undefined;
  if (historicalIdentity != null && r.state === 'alive') {
    reuseCheck = sameProcessIdentity(historicalIdentity, r.identity);
    if (reuseCheck === 'different') {
      return { error: `PID ${pid} 已被复用（启动时间不同）——不是原进程，退出事实不可据此判定` };
    }
    if (reuseCheck === 'unknown') note = '平台无启动时间：PID 复用不可检测，退出判定可信度降低';
  }
  return { kind: 'osProcessCheck', pid, observedAt: Date.now(), alive: r.state === 'alive', reuseCheck, note };
}
