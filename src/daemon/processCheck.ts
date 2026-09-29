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

/** 子进程枚举结果：确认无子（checked）/有存活子（列表）/不可枚举（平台/查询失败——未完整确认）。 */
export type ChildScan =
  | { state: 'checked'; children: Array<{ pid: number; startedAt: number | null }> }
  | { state: 'live'; children: Array<{ pid: number; startedAt: number | null }> }
  | { state: 'unsupported' | 'failed'; error?: string };

/**
 * 列出以 pid 为父的存活子进程（工具/派生进程——父退出不证明它们已结束）。
 * win32 走 CIM Win32_Process（ParentProcessId 过滤；孤儿进程的 PPID 保持死父 PID）；
 * 其他平台无枚举能力=unsupported（未完整确认——按保守语义处理，不猜测）。
 * 测试可注入 queryFn（返回标记行协议：C:<pid>:<epochms|null> 多行；空输出=无子）。
 */
export function listLiveChildProcesses(pid: number, queryFn?: (pid: number) => string): ChildScan {
  if (queryFn == null && !IS_WINDOWS) return { state: 'unsupported', error: '平台不支持子进程枚举（仅 win32 CIM）' };
  try {
    const out = (queryFn ?? ((p: number): string => execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${p}" | ForEach-Object { 'C:' + $_.ProcessId + ':' + $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 'null' }) }`,
    ], { encoding: 'utf8', timeout: 10_000 })))(pid);
    const children: Array<{ pid: number; startedAt: number | null }> = [];
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^C:(\d+):(null|\d+)$/);
      if (m != null) children.push({ pid: Number(m[1]), startedAt: m[2] === 'null' ? null : Number(m[2]) });
    }
    return children.length > 0 ? { state: 'live', children } : { state: 'checked', children: [] };
  } catch (error) {
    return { state: 'failed', error: `子进程枚举失败：${String(error).slice(0, 100)}` };
  }
}

// ---------- 第八轮：全表进程快照 + 进程树归属分析 ----------

/**
 * 全表进程查询协议（单次 PowerShell、行标记、错误显式传回）：
 * - `T:<pid>:<ppid>:<epochms|null>` 每存活进程一行；
 * - 脚本 `$ErrorActionPreference='Stop'` + try/catch → `E:<消息>` 行（CIM 非终止错误不静默）；
 * - 解析侧：空输出、E: 行、任何无法识别的行 → failed（**不把查询失败当空结果**；
 *   查询成功且该父无子=0 行 T:，与失败严格区分——第八轮用户指令）。
 */
const PS_TABLE_QUERY =
  `$ErrorActionPreference='Stop'; try { Get-CimInstance Win32_Process | ForEach-Object { ` +
  `'T:' + $_.ProcessId + ':' + $_.ParentProcessId + ':' + $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 'null' }) } } ` +
  `catch { 'E:' + $_.Exception.Message }`;

export interface ProcessTableRow {
  pid: number;
  ppid: number;
  startedAt: number | null;
}

export type ProcessTableResult =
  | { state: 'ok'; rows: ProcessTableRow[] }
  | { state: 'unsupported' | 'failed'; error: string };

/**
 * 一次性全表进程快照（win32 CIM；其他平台 unsupported——树归属分析不可用）。
 * 测试可注入 queryFn 返回上述协议文本（含 E:/malformed 行的故障注入）。
 */
export function snapshotProcessTable(
  queryFn?: () => string,
  timeoutMs = 12_000,
): ProcessTableResult {
  if (queryFn == null && !IS_WINDOWS) return { state: 'unsupported', error: '平台不支持全表进程枚举（仅 win32 CIM）' };
  let raw: string;
  try {
    raw = (queryFn ?? ((): string => execFileSync('powershell', ['-NoProfile', '-Command', PS_TABLE_QUERY], { encoding: 'utf8', timeout: timeoutMs })))();
  } catch (error) {
    return { state: 'failed', error: `全表进程查询失败：${String(error).slice(0, 120)}` };
  }
  const rows: ProcessTableRow[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    if (text.startsWith('E:')) return { state: 'failed', error: `CIM 查询错误：${text.slice(2, 120)}` };
    const m = text.match(/^T:(\d+):(\d+):(null|\d+)$/);
    if (m == null) {
      malformed += 1;
      continue;
    }
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: m[3] === 'null' ? null : Number(m[3]) });
  }
  // 空输出或残缺行=输出损坏（win32 全表必有系统进程；任何残缺都不可信）——不是「无进程」。
  if (rows.length === 0) return { state: 'failed', error: '全表进程查询返回空输出（输出损坏或被截断）——不能当作无存活进程' };
  if (malformed > 0) return { state: 'failed', error: `全表进程输出含 ${malformed} 行无法解析的内容——结果不完整，不当作可用快照` };
  return { state: 'ok', rows };
}

/** 从全表快照收集以 rootPid 为根的树行（worker 快照写入与测试共用；根不在表=已退出 → 占位行）。 */
export function collectTreeRows(
  rows: ProcessTableRow[], rootPid: number,
): Array<{ pid: number; ppid: number; startedAt: number | null }> {
  const root = rows.find((r) => r.pid === rootPid);
  if (root == null) return [{ pid: rootPid, ppid: 0, startedAt: null }];
  const out = [root];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const r of rows) {
      if (r.ppid === cur && !seen.has(r.pid)) {
        seen.add(r.pid);
        out.push(r);
        queue.push(r.pid);
      }
    }
  }
  return out;
}

/** 进程树归属分析结果：全树无存活（含历史代际核对）/仍有存活后代/不可分析。 */
export type TreeScan =
  | { state: 'checked'; survivors: []; verifiedHistoricalPids: number[] }
  | { state: 'live'; survivors: ProcessTableRow[]; via: 'live-tree' | 'historical-attachment'; note?: string }
  | { state: 'unsupported' | 'failed'; error: string };

/**
 * 进程树归属分析（第八轮核心）——回答「该登记根 PID 之下是否还有**存活**的执行载体」：
 *
 * 1. 现存树 BFS：从现存活着的根/种子沿 PPID 边向下收集（覆盖：父退子活——孤儿的 PPID
 *    仍指向死父；存活过程中继续派生的新进程挂在活节点下）。
 * 2. 历史归属核对（覆盖：中间代际已退出、孙进程遗留——现存图上不连通）：对快照登记过的
 *    历史 PID（含根），收集「以该 PID 为 PPID 的存活进程」，并用**创建时间**做归属核对：
 *    - 该 PID 已死：存活子创建时间 ≥ 快照登记的启动时间（容差）→ 属于我们的后代；
 *    - 该 PID 已被复用：存活子创建时间早于复用者启动时间 → 是我们树的后代（复用家庭
 *      的孩子不会早于复用者本人）；否则排除。历史启动时间缺失 → 无法与复用家庭区分，
 *      保守计入（保护保留，不猜测排除）。
 * 能力边界（如实）：最后快照之后新派生、且其父链在快照之后死去的深层链不可发现——
 * 快照间隔内该风险存在，由周期快照缩小；win32 之外=unsupported。
 */
export function analyzeProcessTree(
  rootPid: number,
  historical: Array<{ pid: number; startedAt: number | null }>,
  queryFn?: () => string,
): TreeScan {
  const table = snapshotProcessTable(queryFn);
  if (table.state !== 'ok') return { state: table.state, error: table.error };
  const rows = table.rows;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const survivors: ProcessTableRow[] = [];

  // ① 现存树 BFS（根仍活着 → 结果本身即 alive 证据；根死了也从 PPID=根 抓存活孤儿子）。
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const r of rows) {
      if (r.ppid === cur && !seen.has(r.pid)) {
        seen.add(r.pid);
        survivors.push(r);
        queue.push(r.pid);
      }
    }
  }
  if (survivors.length > 0) return { state: 'live', survivors, via: 'live-tree' };

  // ② 历史归属核对：快照登记过的每个 PID（根也在内；含已死中间代际）的存活子。
  const verified: number[] = [];
  for (const h of historical) {
    verified.push(h.pid);
    if (h.pid === rootPid && byPid.has(rootPid)) continue; // 根活着的情况由 probe 上层判 alive，不在此处理
    const candidates = rows.filter((r) => r.ppid === h.pid);
    if (candidates.length === 0) continue;
    const liveNow = byPid.get(h.pid); // 该历史 PID 当前是否被复用成别的进程
    for (const c of candidates) {
      if (seen.has(c.pid)) continue;
      if (h.startedAt == null) {
        // 历史启动时间缺失：无法用创建时间排除复用家庭——保守计入（保护保留）。
        survivors.push(c);
        continue;
      }
      if (c.startedAt == null) {
        survivors.push(c); // 子进程创建时间不可读：无法核对——保守计入
        continue;
      }
      const childAfterOurProcess = c.startedAt >= h.startedAt - 1500; // 子不早于父（ms 精度容差）
      if (!childAfterOurProcess) continue; // 早于我们进程启动：属于更早家庭（PID 边残留），排除
      if (liveNow != null && liveNow.startedAt != null && c.startedAt >= liveNow.startedAt - 1500) {
        continue; // 不早于复用者启动：属于复用后的新家庭，排除
      }
      survivors.push(c); // 创建时间在我们进程启动之后、复用者启动之前 → 我们的后代
    }
  }
  if (survivors.length > 0) {
    return {
      state: 'live', survivors, via: 'historical-attachment',
      note: '经活跃期快照的历史归属核对发现存活后代（中间代际已退出，现存父子图不连通）',
    };
  }
  return { state: 'checked', survivors: [], verifiedHistoricalPids: verified };
}
