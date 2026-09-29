/**
 * Git 仓库只读状态（DEV-14/RT-24 首个真实数据面，第八轮）。
 *
 * 语义：
 * - 只读——`git status --porcelain` / `rev-parse` 不修改工作区/索引（保留用户已有未提交内容）；
 * - 真实仓库数据：暂存（X 列）/未暂存（Y 列）/未跟踪（??）严格区分；重命名给 to→from；
 * - 非 git 仓库/命令失败：明确错误，不猜测、不返回空状态冒充。
 * 写操作（暂存/提交/撤销）不在本模块——Git 提交不等同任务验收（RT-25），变更撤销走
 * changeset.undo 既有合同。
 */
import { execFileSync } from 'node:child_process';

export interface GitStatusEntry {
  /** porcelain XY（如 'M '、' M'、'??'、'R '）。 */
  xy: string;
  path: string;
  /** 重命名的原路径。 */
  renamedFrom?: string;
  /** 分类：staged（索引有变化）/unstaged（工作树有变化）/untracked（未跟踪）。 */
  category: 'staged' | 'unstaged' | 'untracked';
}

export type GitRepoStatus =
  | {
      ok: true;
      branch: string;
      /** 暂存区有差异的条目（X 非 . 非 ?）。 */
      staged: GitStatusEntry[];
      /** 工作树有差异的条目（Y 非 .）。 */
      unstaged: GitStatusEntry[];
      /** 未跟踪文件/目录。 */
      untracked: GitStatusEntry[];
      truncated: boolean;
    }
  | { ok: false; code: 'NOT_A_GIT_REPO' | 'GIT_COMMAND_FAILED'; message: string };

const MAX_ENTRIES = 200;

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
}

export function gitRepoStatus(root: string, maxEntries = MAX_ENTRIES): GitRepoStatus {
  try {
    git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : String(error);
    return { ok: false, code: 'NOT_A_GIT_REPO', message: `目录不是 git 仓库（${root}）：${message}` };
  }
  let branch = '(unknown)';
  try {
    branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch { /* 分支不可得（如空仓库）——如实标注，不失败 */ }
  let raw: string;
  try {
    raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  } catch (error) {
    return { ok: false, code: 'GIT_COMMAND_FAILED', message: `git status 失败：${error instanceof Error ? error.message.slice(0, 160) : String(error)}` };
  }
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  let truncated = false;
  // -z 格式：每条记录以 NUL 结尾；重命名 "XY to\0from" 占两条。
  const records = raw.split('\0').filter((r) => r !== '');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    let renamedFrom: string | undefined;
    if (xy[0] === 'R' || xy[0] === 'C') {
      renamedFrom = records[i + 1];
      i += 1;
    }
    const entry: GitStatusEntry = { xy, path, ...(renamedFrom != null ? { renamedFrom } : {}), category: 'staged' };
    if (xy === '??') {
      entry.category = 'untracked';
      untracked.push(entry);
    } else {
      if (xy[0] !== ' ' && xy[0] !== '?') staged.push({ ...entry, category: 'staged' });
      if (xy[1] !== ' ' && xy[1] !== '?') unstaged.push({ ...entry, category: 'unstaged' });
    }
    if (staged.length + unstaged.length + untracked.length >= maxEntries) {
      truncated = true;
      break;
    }
  }
  return { ok: true, branch, staged, unstaged, untracked, truncated };
}

export interface GitDiffPatch {
  path: string;
  oldPath?: string;
  /** 变更类型（git 名义：added/modified/deleted/renamed）。 */
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  /** 输出超过上限（截断，完整差异走 git 客户端）。 */
  truncated: boolean;
  /** unified diff 正文（截断时含截断标记；二进制为空）。 */
  text: string;
}

export type GitDiffResult =
  | { ok: true; patches: GitDiffPatch[]; truncatedOverall: boolean }
  | { ok: false; code: 'NOT_A_GIT_REPO' | 'GIT_COMMAND_FAILED' | 'PATH_OUT_OF_REPO'; message: string };

const MAX_DIFF_BYTES = 64 * 1024;

/**
 * Git diff 正文（DEV-14/RT-24，第九轮）：区分暂存/未暂存（staged 开关）；重命名/删除标注；
 * 二进制（numstat 为 '-'）与超限截断如实。路径校验：相对路径、不得含 ..（拒绝越界——
 * 不依赖 git 的宽容）。只读：git diff 不改索引与工作区；未跟踪文件无 diff（走 status）。
 */
export function gitDiff(root: string, options: { staged?: boolean; path?: string } = {}): GitDiffResult {
  try {
    git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    return { ok: false, code: 'NOT_A_GIT_REPO', message: `目录不是 git 仓库（${root}）：${error instanceof Error ? error.message.slice(0, 120) : String(error)}` };
  }
  let filterPath: string | undefined;
  if (options.path != null) {
    if (options.path.includes('\\') || /^[a-zA-Z]:/.test(options.path) || options.path.startsWith('/')) {
      return { ok: false, code: 'PATH_OUT_OF_REPO', message: '只接受仓库内相对路径（拒绝绝对路径）' };
    }
    if (options.path.split('/').some((sg) => sg === '..')) {
      return { ok: false, code: 'PATH_OUT_OF_REPO', message: '路径含 ..（拒绝仓库外越界）' };
    }
    filterPath = options.path;
  }
  const args = ['diff', '--no-color'];
  if (options.staged === true) args.push('--cached');
  if (filterPath != null) args.push('--', filterPath);
  let raw: string;
  try {
    raw = git(root, args);
  } catch (error) {
    return { ok: false, code: 'GIT_COMMAND_FAILED', message: `git diff 失败：${error instanceof Error ? error.message.slice(0, 160) : String(error)}` };
  }
  // 二进制判定：numstat 的 add/del 为 '-'。
  const binaries = new Set<string>();
  try {
    const numstatArgs = ['diff', '--numstat'];
    if (options.staged === true) numstatArgs.push('--cached');
    if (filterPath != null) numstatArgs.push('--', filterPath);
    for (const line of git(root, numstatArgs).split('\n')) {
      const m = line.trim().match(/^- - (.+)$/);
      if (m != null) binaries.add(m[1]!.split('\t').pop()!.trim());
    }
  } catch { /* numstat 失败不阻断：按文本处理 */ }
  const patches: GitDiffPatch[] = [];
  let truncatedOverall = false;
  const blocks = raw.split('\ndiff --git ').filter((b) => b.trim() !== '');
  for (const block of blocks) {
    const text0 = block.startsWith('diff --git ') ? block : `diff --git ${block}`;
    const headerMatch = text0.match(/^diff --git a\/(.+) b\/(.+)$/m);
    const aPath = headerMatch?.[1]?.trim() ?? '';
    const bPath = headerMatch?.[2]?.trim() ?? '';
    let change: GitDiffPatch['change'] = 'modified';
    if (/^new file mode/m.test(text0)) change = 'added';
    else if (/^deleted file mode/m.test(text0)) change = 'deleted';
    else if (/^similarity index/m.test(text0)) change = 'renamed';
    const displayPath = change === 'deleted' ? aPath : bPath;
    const isBinary = binaries.has(displayPath) || /^Binary files .* differ$/m.test(text0);
    let text = text0;
    let truncated = false;
    if (text.length > MAX_DIFF_BYTES) {
      text = `${text.slice(0, MAX_DIFF_BYTES)}\n…（差异超限已截断：完整差异请用 git 客户端查看）`;
      truncated = true;
      truncatedOverall = true;
    }
    patches.push({
      path: displayPath,
      ...(change === 'renamed' && aPath !== bPath ? { oldPath: aPath } : {}),
      change,
      binary: isBinary,
      truncated,
      text: isBinary ? '' : text,
    });
  }
  return { ok: true, patches, truncatedOverall };
}

