/**
 * Git 仓库只读状态与差异（DEV-14/RT-24 数据面；第十轮协议重写）。
 *
 * 协议原则（第十轮收口）：
 * - 文件身份取自机器可解析输出：`--raw -z`（身份/变更类型/重命名对）与 `--numstat -z`
 *   （计数与二进制标记），不从面向显示的 diff 头正则猜测路径；
 * - 查询用字面路径语义：GIT_LITERAL_PATHSPECS=1，文件名中的 [] 等不被当作通配/magic；
 * - 差异正文固定 `--no-textconv --no-ext-diff`——不执行仓库配置的外部 diff/textconv 程序；
 * - 正式默认完整采集；可选限额仅供测试注入，截断如实标注；
 * - numstat 失败 ≠ 文本成功：stat 区分 text/binary/unknown（未知只表示统计不可用）；
 * - 项目根与工作树根的关系显式返回（子目录项目不悄悄扩大操作范围）；
 * - 只读——不改工作区/索引/HEAD（保留用户已有未提交内容）。
 * 写操作在 gitWrite.ts（Git 提交不等同任务验收，RT-25）。
 */
import { spawn } from 'node:child_process';
import { openSync, readFileSync, closeSync, statSync, fstatSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// ---------- 受控采集 ----------

export interface GitCapture {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  /** stdout 超过上限：子进程被终止，stdout 只保留前 capBytes 字节。 */
  truncated: boolean;
  /** spawn 失败（如 git 不存在）。 */
  spawnError?: string;
}

/**
 * 执行 git 并完整采集 stdout；仅测试显式传 capBytes 时截断并终止。
 * stderr 上限 16KB。读取类命令统一走这里；env 需要显式传入（写命令不剥离用户配置）。
 */
export function captureGit(args: readonly string[], options: { cwd?: string; capBytes?: number; env?: NodeJS.ProcessEnv }): Promise<GitCapture> {
  return new Promise((resolveCapture) => {
    const child = spawn('git', args as string[], { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      resolveCapture({
        exitCode,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        truncated,
        ...(spawnError != null ? { spawnError } : {}),
      });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      outBytes += chunk.length;
      if (options.capBytes != null && outBytes > options.capBytes) {
        // 保留不超过上限的前缀，终止子进程——读取阶段即控制资源。
        const headroom = options.capBytes - (outBytes - chunk.length);
        if (headroom > 0) outChunks.push(chunk.subarray(0, headroom));
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < 16 * 1024) {
        errChunks.push(chunk.subarray(0, 16 * 1024 - errBytes));
        errBytes += chunk.length;
      }
    });
    child.on('error', (error) => { finish(null, error.message); });
    child.on('close', (code) => { finish(code); });
  });
}

/** 读类差异命令的公共参数：禁 textconv/ext-diff/分页；字面 pathspec 由 env 控制。 */
function readDiffEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_PAGER: 'cat' };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE;
  if (extra != null) Object.assign(env, extra);
  return env;
}

const GIT_TIMEOUT_MS = 15_000;

async function runGitOk(args: readonly string[], options: { cwd?: string; capBytes?: number; env?: NodeJS.ProcessEnv; what: string }): Promise<GitCapture> {
  const cap = await withTimeout(captureGit(args, options), GIT_TIMEOUT_MS, options.what);
  if (cap.spawnError != null) {
    throw new GitProtocolError('GIT_COMMAND_FAILED', `git ${options.what} 无法执行（${cap.spawnError}）`);
  }
  return cap;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new GitProtocolError('GIT_COMMAND_FAILED', `git ${what} 超时（>${ms}ms）——按失败处理，不当作空结果`)); }, ms); }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export class GitProtocolError extends Error {
  readonly code: 'NOT_A_GIT_REPO' | 'GIT_COMMAND_FAILED' | 'PATH_OUT_OF_REPO' | 'PATH_IS_DIRECTORY';
  constructor(code: 'NOT_A_GIT_REPO' | 'GIT_COMMAND_FAILED' | 'PATH_OUT_OF_REPO' | 'PATH_IS_DIRECTORY', message: string) {
    super(message);
    this.name = 'GitProtocolError';
    this.code = code;
  }
}

// ---------- 仓库定位 ----------

export interface RepoLocation {
  /** Git 工作树根（已解析为本机路径）。 */
  worktreeRoot: string;
  /** 项目根相对工作树根的前缀（posix 风格；''＝项目根即工作树根）。 */
  projectPrefix: string;
  /** 项目根不在工作树内（异常状态：is-inside-work-tree 为真但 show-toplevel 不可解析）。 */
  projectRootOutsideWorktree: boolean;
}

export async function locateRepo(projectRoot: string): Promise<RepoLocation> {
  const inside = await captureGit(['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], { });
  if (inside.spawnError != null || inside.exitCode !== 0 || !inside.stdout.toString('utf8').trim().endsWith('true')) {
    const detail = inside.spawnError ?? (inside.stderr.trim() !== '' ? inside.stderr.trim().slice(0, 160) : `exit=${inside.exitCode}`);
    throw new GitProtocolError('NOT_A_GIT_REPO', `目录不是 git 仓库（${projectRoot}）：${detail}`);
  }
  const top = await runGitOk(['-C', projectRoot, 'rev-parse', '--show-toplevel'], { what: 'show-toplevel' });
  if (top.exitCode !== 0 || top.stdout.toString('utf8').trim() === '') {
    throw new GitProtocolError('GIT_COMMAND_FAILED', `无法确定工作树根（show-toplevel 失败）：${top.stderr.trim().slice(0, 160)}`);
  }
  const worktreeRoot = resolve(top.stdout.toString('utf8').trim());
  const rel = relative(worktreeRoot, resolve(projectRoot));
  if (rel === '') return { worktreeRoot, projectPrefix: '', projectRootOutsideWorktree: false };
  if (rel.startsWith('..')) return { worktreeRoot, projectPrefix: '', projectRootOutsideWorktree: true };
  return { worktreeRoot, projectPrefix: rel.split(sep).join('/'), projectRootOutsideWorktree: false };
}

/**
 * porcelain -z 记录解析（读/写共用的身份事实源）：每条以 NUL 结尾；重命名/复制
 * "XY 新\0旧" 先新后旧（porcelain 语义；raw -z 才是先旧后新）。截断残段（末段无 NUL
 * 终止）由调用方处理；此处假定输入为完整输出。
 */
export function parsePorcelainEntries(raw: string): GitStatusEntry[] {
  const complete = raw.split('\0').slice(0, -1);
  const entries: GitStatusEntry[] = [];
  for (let i = 0; i < complete.length; i += 1) {
    const record = complete[i]!;
    if (record === '') continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    let renamedFrom: string | undefined;
    if (xy[0] === 'R' || xy[0] === 'C') {
      renamedFrom = complete[i + 1];
      i += 1;
    }
    const entry: GitStatusEntry = { xy, path, ...(renamedFrom != null ? { renamedFrom } : {}), category: 'staged' };
    if (xy === '??') entry.category = 'untracked';
    else {
      if (xy[0] !== ' ' && xy[0] !== '?') entries.push({ ...entry, category: 'staged' });
      if (xy[1] !== ' ' && xy[1] !== '?') entries.push({ ...entry, category: 'unstaged' });
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/** 未合并（冲突未解决）状态：两列任一为 U，或 AA/DD（双方增/删）。 */
export function isUnmergedXy(xy: string): boolean {
  return xy[0] === 'U' || xy[1] === 'U' || xy === 'AA' || xy === 'DD';
}

/** 校验仓库内相对路径：拒绝绝对路径/盘符/反斜杠/../控制字符。 */
export function validateRepoRelativePath(path: string): void {
  if (path === '') throw new GitProtocolError('PATH_OUT_OF_REPO', '路径为空');
  if (path.includes('\\') || /^[a-zA-Z]:/.test(path) || path.startsWith('/')) {
    throw new GitProtocolError('PATH_OUT_OF_REPO', '只接受仓库内相对路径（拒绝绝对路径/盘符/反斜杠）');
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new GitProtocolError('PATH_OUT_OF_REPO', '路径含 .. 或空段（拒绝仓库外越界）');
  }
  // 控制字符（含 NUL/DEL）逐码位比较——不经正则（eslint no-control-regex）。
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    const isControl = (code <= 0x08) || (code >= 0x0b && code <= 0x0c) || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
    if (isControl) throw new GitProtocolError('PATH_OUT_OF_REPO', '路径含控制字符（拒绝）');
  }
}

// ---------- status ----------

export interface GitStatusEntry {
  /** porcelain XY（如 'M '、' M'、'??'、'R '）。 */
  xy: string;
  path: string;
  /** 重命名/复制的原路径（porcelain -z 的第二条记录）。 */
  renamedFrom?: string;
  /** 分类：staged（索引有变化）/unstaged（工作树有变化）/untracked（未跟踪）。 */
  category: 'staged' | 'unstaged' | 'untracked';
  /** 项目根是仓库子目录时：该条目是否在项目范围外（工作树范围如实展示，不悄悄扩大操作范围）。 */
  outsideProjectRoot?: boolean;
}

export type GitRepoStatus = {
  ok: true;
  branch: string;
  /** 工作树根（项目根可能只是其子目录）。 */
  worktreeRoot: string;
  /** 项目根即工作树根。 */
  projectRootIsWorktreeRoot: boolean;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  truncated: boolean;
} | { ok: false; code: 'NOT_A_GIT_REPO' | 'GIT_COMMAND_FAILED'; message: string };


export async function gitRepoStatus(root: string, maxEntries?: number): Promise<GitRepoStatus> {
  let loc: RepoLocation;
  try {
    loc = await locateRepo(root);
  } catch (error) {
    if (error instanceof GitProtocolError) return { ok: false, code: error.code === 'NOT_A_GIT_REPO' ? 'NOT_A_GIT_REPO' : 'GIT_COMMAND_FAILED', message: error.message };
    return { ok: false, code: 'GIT_COMMAND_FAILED', message: String(error) };
  }
  let branch = '(unknown)';
  try {
    const symbolic = await runGitOk(['-C', loc.worktreeRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { what: 'branch' });
    if (symbolic.exitCode === 0) branch = symbolic.stdout.toString('utf8').trim();
    else if (symbolic.exitCode === 1) {
      const b = await runGitOk(['-C', loc.worktreeRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { what: 'detached HEAD' });
      if (b.exitCode === 0) branch = b.stdout.toString('utf8').trim();
    }
  } catch { /* 分支不可得（如空仓库）——如实标注，不失败 */ }
  const porcelain = await runGitOk(
    ['-C', loc.worktreeRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { what: 'status' },
  );
  if (porcelain.exitCode !== 0) {
    return { ok: false, code: 'GIT_COMMAND_FAILED', message: `git status 失败（exit=${porcelain.exitCode}）：${porcelain.stderr.trim().slice(0, 160)}` };
  }
  const outside = (path: string): boolean => {
    if (loc.projectRootOutsideWorktree) return true;
    if (loc.projectPrefix === '') return false;
    return !(path === loc.projectPrefix || path.startsWith(`${loc.projectPrefix}/`));
  };
  // 采集截断时末条可能缺 NUL——只解析完整记录（残段丢弃；truncated 已如实标注）。
  let truncated = porcelain.truncated;
  const parsed = parsePorcelainEntries(porcelain.stdout.toString('utf8'));
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  for (const entry of parsed) {
    const marked = outside(entry.path) ? { ...entry, outsideProjectRoot: true } : entry;
    if (marked.category === 'untracked') untracked.push(marked);
    else if (marked.category === 'staged') staged.push(marked);
    else unstaged.push(marked);
    if (maxEntries != null && staged.length + unstaged.length + untracked.length >= maxEntries && parsed.length > maxEntries) {
      truncated = true;
      break;
    }
  }
  return {
    ok: true,
    branch,
    worktreeRoot: loc.worktreeRoot,
    projectRootIsWorktreeRoot: loc.projectPrefix === '' && !loc.projectRootOutsideWorktree,
    staged,
    unstaged,
    untracked,
    truncated,
  };
}

// ---------- 机器格式解析（身份事实源） ----------

export interface RawDiffEntry {
  /** 变更类型字母（git 名义）：A/C/D/M/R/T/U。 */
  status: string;
  /** 当前路径（重命名=新路径）。 */
  path: string;
  /** 重命名/复制的原路径。 */
  origPath?: string;
}

/** `git diff --raw -z`：`:omode nmode osha nsha STATUS\0path\0[orig\0]`（重命名先旧后新，实测）。 */
export function parseRawZ(text: string): RawDiffEntry[] {
  const records = text.split('\0');
  const entries: RawDiffEntry[] = [];
  let i = 0;
  while (i < records.length) {
    const meta = records[i]!;
    if (meta === '') { i += 1; continue; }
    if (!meta.startsWith(':')) throw new GitProtocolError('GIT_COMMAND_FAILED', `raw -z 记录格式无法解析（以 ':' 开头才有效）：${meta.slice(0, 60)}`);
    const fields = meta.slice(1).split(' ');
    const status = fields[4];
    if (fields.length !== 5 || status == null || status.length < 1) {
      throw new GitProtocolError('GIT_COMMAND_FAILED', `raw -z 元字段残缺（期望 5 段）：${meta.slice(0, 80)}`);
    }
    if (status[0] === 'R' || status[0] === 'C') {
      // 重命名/复制两条路径**先旧后新**（od 实测；porcelain status -z 才是先新后旧）。
      const orig = records[i + 1];
      const path = records[i + 2];
      if (orig == null || orig === '' || path == null || path === '') {
        throw new GitProtocolError('GIT_COMMAND_FAILED', `raw -z 重命名/复制路径记录残缺（期望旧/新两条）：${meta.slice(0, 80)}`);
      }
      entries.push({ status, path, origPath: orig });
      i += 3;
      continue;
    }
    const path = records[i + 1];
    if (path == null || path === '') {
      throw new GitProtocolError('GIT_COMMAND_FAILED', `raw -z 缺路径记录（元字段 ${meta.slice(0, 80)} 后无路径）`);
    }
    entries.push({ status, path });
    i += 2;
  }
  return entries;
}

export interface NumstatEntry {
  path: string;
  origPath?: string;
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

/**
 * `git diff --numstat -z`：`added\tdeleted\tpath\0`；二进制为 `-\t-\t`；重命名为
 * `added\tdeleted\t\0旧路径\0新路径\0`（计数后空路径字段——实测确认）。
 */
export function parseNumstatZ(text: string): NumstatEntry[] {
  const records = text.split('\0');
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < records.length) {
    const record = records[i]!;
    if (record === '') { i += 1; continue; }
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(record);
    if (match == null) {
      throw new GitProtocolError('GIT_COMMAND_FAILED', `numstat -z 记录格式无法解析：${record.slice(0, 60)}`);
    }
    const [, addedRaw, deletedRaw, pathField] = match;
    const added = addedRaw === '-' ? null : Number(addedRaw);
    const deleted = deletedRaw === '-' ? null : Number(deletedRaw);
    if (pathField === '') {
      // 重命名：后两条记录=旧路径、新路径（实测顺序）。
      const orig = records[i + 1];
      const next = records[i + 2];
      if (orig == null || next == null || orig === '' || next === '') {
        throw new GitProtocolError('GIT_COMMAND_FAILED', `numstat -z 重命名记录残缺（期望旧/新两条路径）：${record.slice(0, 40)}`);
      }
      entries.push({ path: next, origPath: orig, added, deleted, binary: addedRaw === '-' });
      i += 3;
      continue;
    }
    entries.push({ path: pathField!, added, deleted, binary: addedRaw === '-' });
    i += 1;
  }
  return entries;
}

// ---------- diff ----------

export interface GitDiffPatch {
  path: string;
  oldPath?: string;
  /** 变更类型（git 名义：added/modified/deleted/renamed/copied）。 */
  change: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  /** 统计事实：text=文本；binary=二进制（numstat '-'）；unknown=numstat 不可用（不是文本成功）。 */
  stat: 'text' | 'binary' | 'unknown';
  /** 兼容字段：stat==='binary'。 */
  binary: boolean;
  /** 采集器是否返回截断内容（正式默认不截断）。 */
  truncated: boolean;
  /** 正文来源：diff=unified diff；worktree-content=未跟踪文件内容（新增语义）。 */
  source: 'diff' | 'worktree-content';
  /** unified diff 正文（二进制为空；截断含标记）。 */
  text: string;
  /** numstat 计数（未知为 null）。 */
  addedCount?: number | null;
  deletedCount?: number | null;
}

export type GitDiffResult =
  | {
      ok: true;
      patches: GitDiffPatch[];
      /** 任一截断/文件被省略。 */
      truncatedOverall: boolean;
      /** 因文件数上限未生成正文的条数（身份仍列出）。 */
      filesOmitted?: number;
      /** numstat 不可用（stat=unknown 的原因；正文仍真实）。 */
      numstatError?: string;
      worktreeRoot: string;
    }
  | { ok: false; code: 'NOT_A_GIT_REPO' | 'GIT_COMMAND_FAILED' | 'PATH_OUT_OF_REPO' | 'PATH_IS_DIRECTORY'; message: string };


/** 测试接缝：注入采集器（正式命令不传）。 */
export type GitRunner = (args: readonly string[], options: { cwd?: string; capBytes?: number; env?: NodeJS.ProcessEnv }) => Promise<GitCapture>;

const CHANGE_OF_STATUS: Record<string, GitDiffPatch['change']> = {
  A: 'added', C: 'copied', D: 'deleted', M: 'modified', T: 'modified', R: 'renamed',
};

export async function gitDiff(
  root: string,
  options: { staged?: boolean; path?: string; runner?: GitRunner } = {},
): Promise<GitDiffResult> {
  const run = options.runner ?? ((args, opts) => runGitOk(args, { ...opts, what: 'diff' }));
  try {
    return await gitDiffInner(root, options, run);
  } catch (error) {
    if (error instanceof GitProtocolError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'GIT_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error) };
  }
}

async function gitDiffInner(root: string, options: { staged?: boolean; path?: string }, run: GitRunner): Promise<GitDiffResult> {
  const loc = await locateRepo(root);
  const baseDiffArgs = ['-C', loc.worktreeRoot, '-c', 'diff.relative=false', 'diff', '--no-color', '--no-textconv', '--no-ext-diff', '-M'];
  if (options.staged === true) baseDiffArgs.push('--cached');

  let filterPath: string | undefined;
  if (options.path != null) {
    validateRepoRelativePath(options.path);
    filterPath = options.path;
    // 未跟踪文件：diff 无输出——按新增文件语义展示工作区内容（§十轮-5：不只列文件名）。
    const statusPath = await run(
      ['-C', loc.worktreeRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', filterPath],
      { env: readDiffEnv({ GIT_LITERAL_PATHSPECS: '1' }) },
    );
    if (statusPath.exitCode !== 0) {
      throw new GitProtocolError('GIT_COMMAND_FAILED', `未跟踪判定失败（status -- path）：${statusPath.stderr.trim().slice(0, 120)}`);
    }
    const statusRecords = statusPath.stdout.toString('utf8').split('\0').filter((r) => r !== '');
    if (statusRecords.some((r) => r.startsWith('??'))) {
      return { ok: true, patches: [await untrackedContentPatch(loc, filterPath)], truncatedOverall: false, worktreeRoot: loc.worktreeRoot };
    }
  }

  const pathArgs = filterPath != null ? ['--', filterPath] : [];
  const literalEnv = readDiffEnv({ GIT_LITERAL_PATHSPECS: '1' });

  // 身份事实源：raw -z（解析失败=命令失败，不静默降级）。
  const rawCap = await run([...baseDiffArgs, '--raw', '-z', ...pathArgs], { env: literalEnv });
  if (rawCap.spawnError != null || rawCap.truncated || rawCap.exitCode !== 0) {
    throw new GitProtocolError('GIT_COMMAND_FAILED', `git diff --raw 失败（exit=${rawCap.exitCode}${rawCap.truncated ? '，输出超采集上限——身份列表不完整，不静默降级' : ''}）：${rawCap.stderr.trim().slice(0, 160)}`);
  }
  let rawEntries: RawDiffEntry[];
  try {
    rawEntries = parseRawZ(rawCap.stdout.toString('utf8'));
  } catch (error) {
    throw new GitProtocolError('GIT_COMMAND_FAILED', error instanceof Error ? error.message : String(error));
  }
  if (rawEntries.length === 0) {
    return { ok: true, patches: [], truncatedOverall: false, worktreeRoot: loc.worktreeRoot };
  }

  // 统计事实源：numstat -z。失败不冒充文本成功——stat=unknown 并记录原因。
  let numstat = new Map<string, NumstatEntry>();
  let numstatError: string | undefined;
  const numCap = await run([...baseDiffArgs, '--numstat', '-z', ...pathArgs], { env: literalEnv });
  if (numCap.spawnError != null || numCap.exitCode !== 0 || numCap.truncated) {
    numstatError = `numstat 不可用（exit=${numCap.exitCode}${numCap.truncated ? '，输出超采集上限' : ''}：${numCap.stderr.trim().slice(0, 120)}）——统计与二进制标记按 unknown 处理`;
  } else {
    try {
      for (const entry of parseNumstatZ(numCap.stdout.toString('utf8'))) numstat.set(entry.path, entry);
    } catch (error) {
      numstatError = `numstat 解析失败（${error instanceof Error ? error.message.slice(0, 120) : String(error)}）——统计与二进制标记按 unknown 处理`;
      numstat = new Map();
    }
  }

  const patches: GitDiffPatch[] = [];
  let truncatedOverall = false;
  for (const entry of rawEntries) {
    const stat = numstat.get(entry.path);
    const patch: GitDiffPatch = {
      path: entry.path,
      ...(entry.origPath != null ? { oldPath: entry.origPath } : {}),
      change: CHANGE_OF_STATUS[entry.status[0]!] ?? 'modified',
      stat: stat == null ? 'unknown' : stat.binary ? 'binary' : 'text',
      binary: stat?.binary === true,
      truncated: false,
      source: 'diff',
      text: '',
      ...(stat != null ? { addedCount: stat.added, deletedCount: stat.deleted } : {}),
    };
    if (patch.stat === 'binary') {
      patches.push(patch); // 二进制无文本差异（正文为空是事实，不是截断）
      continue;
    }
    // 正文按条目自身路径取（字面 pathspec）：路径过滤命中子树多条目时不会重复取整棵子树。
    const textCap = await run([...baseDiffArgs, '--unified=3', '--', entry.path], { env: literalEnv });
    // 真实非零退出或异常终止必须报告失败。
    if (textCap.spawnError != null || textCap.exitCode !== 0) {
      throw new GitProtocolError('GIT_COMMAND_FAILED', `git diff 正文失败（${entry.path}，exit=${textCap.exitCode}）：${textCap.stderr.trim().slice(0, 120)}`);
    }
    patch.text = textCap.stdout.toString('utf8');
    patch.truncated = textCap.truncated;
    truncatedOverall ||= textCap.truncated;
    patches.push(patch);
  }
  return {
    ok: true,
    patches,
    truncatedOverall,
    ...(numstatError != null ? { numstatError } : {}),
    worktreeRoot: loc.worktreeRoot,
  };
}

/** 未跟踪文件内容（新增语义）：完整读取；二进制=NUL 嗅探；目录明确拒绝。 */
async function untrackedContentPatch(loc: RepoLocation, path: string): Promise<GitDiffPatch> {
  const fsPath = join(loc.worktreeRoot, ...path.split('/'));
  try {
    const st = statSync(fsPath);
    if (st.isDirectory()) throw new GitProtocolError('PATH_IS_DIRECTORY', `未跟踪路径是目录（${path}）——请指定具体文件查看内容`);
  } catch (error) {
    if (error instanceof GitProtocolError) throw error;
    throw new GitProtocolError('GIT_COMMAND_FAILED', `未跟踪文件不可读（${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const fd = openSync(fsPath, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    const buf = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || BigInt(buf.length) !== opened.size || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ino !== after.ino || opened.dev !== after.dev) throw new GitProtocolError('GIT_COMMAND_FAILED', '未跟踪文件读取期间变化或读取不完整');
    const binary = buf.includes(0);
    return {
      path,
      change: 'added',
      stat: binary ? 'binary' : 'text',
      binary,
      truncated: false,
      source: 'worktree-content',
      text: binary ? '' : buf.toString('utf8'),
      addedCount: null,
      deletedCount: null,
    };
  } finally {
    closeSync(fd);
  }
}
