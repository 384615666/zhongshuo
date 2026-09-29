/**
 * OS 层进程身份取证（DEV-13，2026-09-28 第六轮·下；2026-09-29 第七轮错误分类修订）——
 * 恢复对账的退出事实证据来源。
 *
 * 语义（如实，不越权断言）：
 * - alive：进程存在且启动时间可得（完整身份——可作复用检测锚点）；
 * - exited：**仅** OS 明确报告该 PID 不存在（PowerShell ObjectNotFound / POSIX ESRCH）；
 * - unknown：权限不足、StartTime 读取失败、查询异常、解析失败、非终止错误、空输出——
 *   一律不以「查询出了问题」推断进程已退出（第六轮版 catch 无差别输出 EXITED 的缺陷修正）；
 *   进程存在但启动时间不可读时也返回 unknown（身份不完整，退出证据不成立）。
 * PID 复用：PID 相同但启动时间（代次）不同=不是同一进程（身份变化，判定退回 unknown）。
 * 实现差异：win32 走 PowerShell（Get-Process + ErrorVariable 分类）；其他平台 process.kill(pid,0)
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

/** PowerShell 单行标记协议（避免自由文本歧义）：X-EXITED / X-ALIVE:<ms> / X-ERR:<类别> / X-STARTTIME-FAIL / X-EMPTY。
 * 注意 if/elseif/else 链内不能插分号（PowerShell 语法）——语句间分号只在链外。 */
const PS_QUERY = (pid: number): string =>
  `$e=$null; $p=Get-Process -Id ${pid} -ErrorVariable e -ErrorAction SilentlyContinue; ` +
  `if($e){ if($e[0].CategoryInfo.Category -eq 'ObjectNotFound'){'X-EXITED'}else{'X-ERR:'+$e[0].CategoryInfo.Category} } ` +
  `elseif($null -eq $p){'X-EMPTY'} ` +
  `else{ try{ $t=[DateTimeOffset]::new($p.StartTime.ToUniversalTime()); 'X-ALIVE:'+ $t.ToUnixTimeMilliseconds() }catch{ 'X-STARTTIME-FAIL' } }`;

/** 查询进程存活与身份（真实 OS 查询，不做任何推断；测试可注入 queryFn 替换）。 */
export function checkProcessLiveness(pid: number, queryFn?: (pid: number) => string, timeoutMs = 8_000): LivenessResult {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', pid, error: '非法 PID' };
  if (!IS_WINDOWS && queryFn == null) {
    try {
      process.kill(pid, 0);
      return { state: 'alive', identity: { pid, startedAt: null } }; // 非 win32 无启动时间——复用检测不可用
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { state: 'exited', pid };
      return { state: 'unknown', pid, error: `kill(0) 失败：${code ?? String(error)}` };
    }
  }
  try {
    const out = (queryFn ?? ((p: number): string => execFileSync('powershell', ['-NoProfile', '-Command', PS_QUERY(p)], { encoding: 'utf8', timeout: timeoutMs })))(pid);
    const text = out.trim();
    if (text === 'X-EXITED') return { state: 'exited', pid };
    if (text === 'X-STARTTIME-FAIL') return { state: 'unknown', pid, error: '进程存在但 StartTime 读取失败（权限不足）——身份不完整，退出证据不成立' };
    if (text === 'X-EMPTY') return { state: 'unknown', pid, error: '查询返回空结果（非明确的 PID 不存在报告）' };
    if (text.startsWith('X-ERR:')) return { state: 'unknown', pid, error: `查询错误（${text.slice(6, 60)}）——不能据此推断退出` };
    if (text.startsWith('X-ALIVE:')) {
      const ms = Number(text.slice(8));
      if (!Number.isFinite(ms)) return { state: 'unknown', pid, error: `StartTime 解析失败：${text.slice(0, 60)}` };
      return { state: 'alive', identity: { pid, startedAt: Math.round(ms) } };
    }
    return { state: 'unknown', pid, error: `输出无法解析：${text.slice(0, 60)}` };
  } catch (error) {
    return { state: 'unknown', pid, error: `进程查询失败：${String(error).slice(0, 100)}` };
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
