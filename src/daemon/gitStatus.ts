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
