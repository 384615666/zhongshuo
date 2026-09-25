/**
 * Git 集成种子数据（用户要求「加 git」）。
 *
 * 自洽约束（不能与已有种子打架）：
 *  - HEAD 是 `3c91d2e`，与 changeSets[0].beforeRef 的 `git:HEAD@3c91d2e` 一致
 *  - 任务 #13 的改动集 changeset_13 是 **未提交** 状态（afterRef = git:WORKTREE@uncommitted），
 *    所以工作区里必须有 scripts/build-report.mjs 与 scripts/lib/paths.mjs 两个待提交文件
 *  - 任务 #11 的改动集是 reverted，对应提交 88a0f31 已回退，不能再出现在 HEAD 历史里
 *  - `fixtures/large-corpus.bin`（无前像）和 `docs/README.md`（用户原有改动）也要在工作区里，
 *    否则「文件与改动」页和 Git 页会互相矛盾
 *  - 分支 `feat/orders-etl` 属于第二个项目 data-backfill，不放在本项目里
 */

import * as I from './ids';
import type { GitState } from './types';

const NOW = Date.now();
const min = (n: number) => n * 60_000;
const hour = (n: number) => n * 3_600_000;
const day = (n: number) => n * 86_400_000;

/** 哈希用固定值，避免每次刷新都变（原型可复现） */
const H = {
  head: '3c91d2e',
  headFull: '3c91d2e8b41c7f0a62d95e13bb47c1098af2e6d4',
  prev: '88a0f31',
  prevFull: '88a0f3194ce02b7d15a8f3e6c2091b7d4e5a6f88',
  older: 'b7104ac',
  olderFull: 'b7104ac2f81de35b906a4c7e2d18f03b95c6e741',
  root: '0d9e3b8',
  rootFull: '0d9e3b8a4c2e1f9073b5d86a1c4e7f20935b8ac1',
  agent: 'a5f81c3',
  agentFull: 'a5f81c37d92b04e1c68a5f3097d24b1e08c6a753',
} as const;

const DIFF_PATHS = [
  {
    header: '@@ -0,0 +1,7 @@',
    lines: [
      { type: 'add' as const, text: "import { fileURLToPath, pathToFileURL } from 'node:url';", newNo: 1 },
      { type: 'add' as const, text: '', newNo: 2 },
      { type: 'add' as const, text: '/** 把任意用户输入路径收敛为本机绝对路径。 */', newNo: 3 },
      { type: 'add' as const, text: 'export function toLocalPath(input) {', newNo: 4 },
      { type: 'add' as const, text: '  const url = pathToFileURL(input);', newNo: 5 },
      { type: 'add' as const, text: '  return fileURLToPath(url);', newNo: 6 },
      { type: 'add' as const, text: '}', newNo: 7 },
    ],
  },
];

const DIFF_BUILD = [
  {
    header: "@@ -11,9 +11,18 @@ import { readFile, writeFile } from 'node:fs/promises';",
    lines: [
      { type: 'ctx' as const, text: "import { readFile, writeFile } from 'node:fs/promises';", oldNo: 11, newNo: 11 },
      { type: 'ctx' as const, text: "import { resolve, join } from 'node:path';", oldNo: 12, newNo: 12 },
      { type: 'del' as const, text: "const outDir = resolve(process.argv[2] ?? 'dist');", oldNo: 13 },
      { type: 'add' as const, text: '// Windows 中文路径：必须先规范化为本地文件系统路径，', newNo: 13 },
      { type: 'add' as const, text: "// 否则 Node 会把 'D:\\\\众说' 当成 URL 编码后的无效路径。", newNo: 14 },
      { type: 'add' as const, text: 'const outDir = resolve(fileURLToPath(pathToFileURL(process.argv[2] ?? \'dist\')));', newNo: 15 },
      { type: 'ctx' as const, text: '', oldNo: 14, newNo: 16 },
      { type: 'add' as const, text: '// GBK 输出兜底：报告正文按 UTF-8 写盘，终端提示单独转码。', newNo: 17 },
      { type: 'ctx' as const, text: "await writeFile(join(outDir, 'report.md'), md, 'utf8');", oldNo: 15, newNo: 18 },
    ],
  },
];

export const gitStates: Record<string, GitState> = {
  [I.P_ZS]: {
    currentBranch: 'main',
    branches: [
      {
        name: 'main',
        head: H.head,
        upstream: 'origin/main',
        ahead: 2,
        behind: 0,
        isCurrent: true,
        updatedAt: NOW - min(105),
      },
      {
        // §14.4 方向的预演：本产品为任务建的隔离分支
        name: 'zs/task-12-module-boundaries',
        head: H.agent,
        ahead: 1,
        behind: 1,
        isCurrent: false,
        createdByZhongshuo: true,
        updatedAt: NOW - hour(3),
      },
      {
        name: 'feat/config-export',
        head: H.older,
        ahead: 0,
        behind: 4,
        isCurrent: false,
        updatedAt: NOW - day(2),
      },
    ],
    remotes: [
      { name: 'origin', url: 'git@github.com:lsj/zhongshuo.git', authState: 'ok' },
      { name: 'backup', url: 'https://git.internal.example/zs.git', authState: 'missing' },
    ],
    commits: [
      {
        hash: H.headFull,
        shortHash: H.head,
        subject: 'chore: 收敛 Windows 中文路径解析',
        body: '由任务 #12 的分析结论驱动：路径必须先规范化再进入 fs 调用。\n本次仅调整 scripts/ 下两个文件，不动 src/。',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - min(105),
        parents: [H.prevFull],
        refs: ['HEAD', 'main', 'origin/main'],
        files: [
          { path: 'scripts/build-report.mjs', change: 'modified', additions: 14, deletions: 5, diff: DIFF_BUILD },
          { path: 'scripts/lib/paths.mjs', change: 'added', additions: 22, deletions: 0, diff: DIFF_PATHS },
        ],
        // 这条提交由任务 #13 的改动集产生（#13 的改动此前已被采纳并提交）
        changeSetId: 'changeset_12_paths',
        taskId: I.TASK_12,
      },
      {
        hash: H.agentFull,
        shortHash: H.agent,
        subject: 'refactor: 抽出 contracts 规范化事件类型',
        body: '**由 agent 产出，等你审阅。**\n把厂商事件类型收敛为 contracts 层的规范化事件，domain 不再直接引用 provider 联合类型。',
        authorName: 'Codex',
        authorEmail: 'agent+codex@zhongshuo.local',
        authoredBy: 'agent',
        memberId: I.M_CODEX,
        committedAt: NOW - hour(3),
        parents: [H.prevFull],
        refs: ['zs/task-12-module-boundaries'],
        files: [
          {
            path: 'src/contracts/events.ts',
            change: 'modified',
            additions: 31,
            deletions: 12,
            diff: [
              {
                header: '@@ -1,6 +1,9 @@',
                lines: [
                  { type: 'ctx' as const, text: 'export type NormalizedEvent =', oldNo: 1, newNo: 1 },
                  { type: 'del' as const, text: '  | CodexEvent', oldNo: 2 },
                  { type: 'del' as const, text: '  | ClaudeStreamEvent;', oldNo: 3 },
                  { type: 'add' as const, text: '  | { kind: "message"; text: string }', newNo: 2 },
                  { type: 'add' as const, text: '  | { kind: "tool"; name: string }', newNo: 3 },
                  { type: 'add' as const, text: '  | { kind: "done"; usage?: UsageRecord };', newNo: 4 },
                ],
              },
            ],
          },
        ],
        taskId: I.TASK_12,
        /* v1.12 §10.5：此处原有 pendingReview:true（commit 级审批），已随
           验收单位改为任务交付而移除。这条提交是 agent 产出的，由 authoredBy
           描述；它对应的任务 #12 走 auto_deliver，不在 Git 里等审阅。 */
      },
      {
        hash: H.prevFull,
        shortHash: H.prev,
        subject: 'feat: 线程阅读水位与未读计数',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(1) - hour(4),
        parents: [H.olderFull],
        refs: [],
        files: [
          {
            path: 'src/data/store.ts',
            change: 'modified',
            additions: 18,
            deletions: 2,
            diff: [
              {
                header: '@@ -596,3 +596,5 @@',
                lines: [
                  { type: 'add' as const, text: '  /** 线程阅读水位：thread_read_states */', newNo: 597 },
                  { type: 'add' as const, text: '  readStates: Record<string, number>;', newNo: 598 },
                ],
              },
            ],
          },
        ],
      },
      {
        hash: H.olderFull,
        shortHash: H.older,
        subject: 'docs: 同步 §14 撤销与并发策略',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(2) - hour(6),
        parents: [H.rootFull],
        refs: ['feat/config-export'],
        files: [
          { path: 'docs/zhongshuo-development-design-v1.md', change: 'modified', additions: 96, deletions: 12, diff: [] },
        ],
      },
      {
        hash: H.rootFull,
        shortHash: H.root,
        subject: 'chore: 初始化仓库',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(9),
        parents: [],
        refs: [],
        files: [],
      },
    ],
    /**
     * 工作区状态：必须与 changeSets 自洽。
     * changeset_13 是 pending_review 且 afterRef=git:WORKTREE@uncommitted，
     * 所以那两个文件此刻是「已修改、未提交」。
     */
    status: [
      {
        path: 'scripts/build-report.mjs',
        state: 'modified',
        staged: false,
        additions: 14,
        deletions: 5,
        diff: DIFF_BUILD,
        changeSetId: I.CS_13,
        taskId: I.TASK_13,
      },
      {
        path: 'scripts/lib/paths.mjs',
        state: 'untracked',
        staged: false,
        additions: 22,
        deletions: 0,
        diff: DIFF_PATHS,
        changeSetId: I.CS_13,
        taskId: I.TASK_13,
      },
      {
        path: 'fixtures/large-corpus.bin',
        state: 'modified',
        staged: false,
        additions: 0,
        deletions: 0,
        diff: [],
        changeSetId: I.CS_13,
        taskId: I.TASK_13,
      },
      {
        // RT-10：用户自己的改动，不能和 agent 的混为一谈
        path: 'docs/README.md',
        state: 'modified',
        staged: false,
        additions: 3,
        deletions: 1,
        diff: [
          {
            header: '@@ -1,4 +1,6 @@',
            lines: [
              { type: 'ctx' as const, text: '# 众说', oldNo: 1, newNo: 1 },
              { type: 'del' as const, text: '开发中。', oldNo: 2 },
              { type: 'add' as const, text: '本地项目群聊多 Agent 协同工作台。', newNo: 2 },
              { type: 'add' as const, text: '', newNo: 3 },
              { type: 'add' as const, text: '> 本节由你在任务 #13 开始前手动修改，不属于任务改动。', newNo: 4 },
            ],
          },
        ],
        userPreExisting: true,
      },
      {
        path: 'src/ui/Dashboard.tsx',
        state: 'conflicted',
        staged: false,
        additions: 6,
        deletions: 6,
        diff: [],
        // 冲突：保留三方内容，不给一键覆盖（§14.2 attribution=ambiguous）
        conflict: {
          base: 'export const TITLE = "众说";',
          ours: 'export const TITLE = "众说 · 工作台";',
          theirs: 'export const TITLE = "众说 ZhonShuo";',
        },
      },
    ],
    commitMessage: '',
    reflog: [
      { at: NOW - min(105), op: 'commit', ref: H.head, detail: 'chore: 收敛 Windows 中文路径解析' },
      { at: NOW - hour(3), op: 'commit', ref: H.agent, detail: 'refactor: 抽出 contracts 规范化事件类型（agent）' },
      { at: NOW - day(1) - hour(4), op: 'commit', ref: H.prev, detail: 'feat: 线程阅读水位与未读计数' },
      { at: NOW - day(2), op: 'checkout', ref: 'main', detail: '从 feat/config-export 切回 main' },
    ],
  },

  /* 第二个项目：非 Git 目录，用于验证界面如实说明"不是仓库"而不是假装能用 */
  [I.P_MISSING]: {
    currentBranch: '',
    branches: [],
    remotes: [],
    commits: [],
    status: [],
    commitMessage: '',
    reflog: [],
  },

  /* 第三个项目：Git 仓库（分支 feat/orders-etl），用于验证分支切换等操作不是写死在 main 上 */
  [I.P_BACKFILL]: {
    currentBranch: 'feat/orders-etl',
    branches: [
      {
        name: 'feat/orders-etl',
        head: 'c41a7e2',
        upstream: 'origin/feat/orders-etl',
        ahead: 1,
        behind: 0,
        isCurrent: true,
        updatedAt: NOW - hour(5),
      },
      { name: 'main', head: '9f03b6d', upstream: 'origin/main', ahead: 0, behind: 12, isCurrent: false, updatedAt: NOW - day(3) },
    ],
    remotes: [{ name: 'origin', url: 'git@github.com:lsj/data-backfill.git', authState: 'ok' }],
    commits: [
      {
        hash: 'c41a7e2d90b13f58a7c204e6b9d51837f0a2c4e9',
        shortHash: 'c41a7e2',
        subject: 'feat: 订单表增量回填脚本',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - hour(5),
        parents: ['9f03b6d'],
        refs: ['HEAD', 'feat/orders-etl', 'origin/feat/orders-etl'],
        files: [
          { path: 'etl/backfill-orders.py', change: 'added', additions: 84, deletions: 0, diff: [] },
        ],
      },
      {
        hash: '9f03b6d2c7a45e10b83f9d64021ec7a5b3d8f016',
        shortHash: '9f03b6d',
        subject: 'chore: 初始化仓库',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(3),
        parents: [],
        refs: ['main', 'origin/main'],
        files: [],
      },
    ],
    status: [],
    commitMessage: '',
    reflog: [{ at: NOW - hour(5), op: 'commit', ref: 'c41a7e2', detail: 'feat: 订单表增量回填脚本' }],
  },
};
