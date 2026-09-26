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
 *
 * 2026-09-26 补数据（用户要求「能测向下滚动」）：
 *  合页改造后全页只剩一条滚动条，而种子原本只有 5 条提交、5 条工作区改动 ——
 *  列表撑不出高度，向下滚动、吸顶状态条、左清单/右详情的高度关系都无从实测。
 *  本轮把众说项目的 Git 数据加厚到「真的要滚」：14 条提交、13 条工作区改动
 *  （4 个任务的待提交分组 + 3 条用户原有改动 + 1 个冲突）、7 个分支、3 个远端、
 *  11 条 reflog。加厚只加**数量与样例**，上面那些自洽约束一条没动：
 *  HEAD 仍是 3c91d2e；冲突**有且只有一个**（提交前必须被解决，多一个就会让
 *  「解决冲突后能提交」的用例失败）；任务 #13 的两个文件仍待提交；用户原有改动
 *  仍然单独分组、不进批量暂存。新增提交一律插在 `88a0f31` **之前**（更老），
 *  所以 HEAD 与各分支尖端不变。
 */

import * as I from './ids';
import type { GitCommit, GitState } from './types';

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
  /* --- 2026-09-26 补的历史提交（比 b7104ac 更老，链尾接到 root） --- */
  list: 'c2f9a41',
  listFull: 'c2f9a41d3e8b5704af1c92d6e0b73f8451a9c2e6',
  unread: 'e1d47a9',
  unreadFull: 'e1d47a9b6c204f8139e5a7d0b4c6f29183e07a54',
  dispatch: '74bb0e6',
  dispatchFull: '74bb0e66a1c93d5f820b7e4c09d61f38a25c7b90',
  isotest: '9c2aef8',
  isotestFull: '9c2aef8704bd13c6e95a2f81c7d0b46392e5a18f',
  permdocs: 'd3f0c77',
  permdocsFull: 'd3f0c77a9e614b02d85c3fa7901e6b24d5c80f31',
  deps: '5b81d29',
  depsFull: '5b81d29e4f0371bac96d2580193fe7a46b0d5c29',
  archive: 'a07c3e5',
  archiveFull: 'a07c3e5b28d914f70a6c3e10b5d84972f1c6e03a',
  cjkname: 'b6d54f0',
  cjknameFull: 'b6d54f0c7a195e43b80d2f61c9e0473b5a8d1e26',
  ci: 'f42a8bd',
  ciFull: 'f42a8bd9250c7e34a1f8b6d0921ce5f37b4a8d60',
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

/* ---------- 2026-09-26 补数据用到的 diff ----------
   只写"点开能看到东西"所必需的几行：原型不追求 diff 完整，追求每条
   可展开项都有真实文本 diff，而不是一句"无文本 diff"敷衍过去。 */
const DIFF_LIST = [
  {
    header: '@@ -1,6 +1,14 @@',
    lines: [
      { type: 'ctx' as const, text: 'export function MessageList({ messages }: { messages: Message[] }) {', oldNo: 1, newNo: 1 },
      { type: 'del' as const, text: '  return <div>{messages.map((m) => <Row key={m.id} m={m} />)}</div>;', oldNo: 2 },
      { type: 'add' as const, text: '  // 长会话按固定行高虚拟化：只渲染视口内的行，', newNo: 2 },
      { type: 'add' as const, text: '  // 否则一次派发几十条消息就会卡住主线程。', newNo: 3 },
      { type: 'add' as const, text: '  const [first, last] = visibleRange(scrollTop, viewportH, ROW_H);', newNo: 4 },
      { type: 'add' as const, text: '  return <>{messages.slice(first, last).map((m) => <Row key={m.id} m={m} />)}</>;', newNo: 5 },
    ],
  },
];

const DIFF_UNREAD = [
  {
    header: '@@ -612,7 +612,9 @@',
    lines: [
      { type: 'ctx' as const, text: 'export function markRead(threadId: string, seq: number) {', oldNo: 612, newNo: 612 },
      { type: 'del' as const, text: '  setState((s) => ({ ...s, readStates: { ...s.readStates, [threadId]: seq } }));', oldNo: 613 },
      { type: 'add' as const, text: '  // 窗口重新聚焦时会再收到一次 visible 事件；', newNo: 613 },
      { type: 'add' as const, text: '  // 不比较水位就会把"已读"又清一遍，未读计数短暂闪回。', newNo: 614 },
      { type: 'add' as const, text: '  const prev = getState().readStates[threadId] ?? 0;', newNo: 615 },
      { type: 'add' as const, text: '  if (seq <= prev) return;', newNo: 616 },
    ],
  },
];

const DIFF_DISPATCH = [
  {
    header: '@@ -18,9 +18,14 @@',
    lines: [
      { type: 'ctx' as const, text: 'export function dispatchKey(input: DispatchInput): string {', oldNo: 18, newNo: 18 },
      { type: 'del' as const, text: '  return `${input.runId}-${input.turnId}-${input.memberId}`;', oldNo: 19 },
      { type: 'add' as const, text: '  // 同一轮里成员可以重跑：幂等键必须带上尝试次数，', newNo: 19 },
      { type: 'add' as const, text: '  // 否则重跑的第二次派发会被当成重复请求丢掉（§12.2 幂等口径）。', newNo: 20 },
      { type: 'add' as const, text: '  const attempt = input.attempt ?? 1;', newNo: 21 },
      { type: 'add' as const, text: '  return [input.runId, input.turnId, input.memberId, attempt].join(":");', newNo: 22 },
    ],
  },
];

/** 任务 #12 第二轮（未提交）：events.ts 继续收敛事件类型 */
const DIFF_EVENTS_R2 = [
  {
    header: '@@ -3,9 +3,14 @@',
    lines: [
      { type: 'ctx' as const, text: 'export type NormalizedEvent =', oldNo: 3, newNo: 3 },
      { type: 'ctx' as const, text: '  | { kind: "message"; text: string }', oldNo: 4, newNo: 4 },
      { type: 'del' as const, text: '  | { kind: "tool"; name: string };', oldNo: 5 },
      { type: 'add' as const, text: '  | { kind: "tool"; name: string; input?: unknown }', newNo: 5 },
      { type: 'add' as const, text: '  | { kind: "error"; code: string; retriable: boolean }', newNo: 6 },
      { type: 'add' as const, text: '  | { kind: "usage"; tokensIn: number; tokensOut: number };', newNo: 7 },
    ],
  },
];

const DIFF_APPSERVER = [
  {
    header: '@@ -41,8 +41,14 @@ export class CodexAppServerAdapter {',
    lines: [
      { type: 'ctx' as const, text: '  private handleNotification(msg: unknown) {', oldNo: 41, newNo: 41 },
      { type: 'del' as const, text: '    const ev = msg as CodexEvent;', oldNo: 42 },
      { type: 'add' as const, text: '    // 厂商类型只在本层出现：出边一律转成 NormalizedEvent，', newNo: 42 },
      { type: 'add' as const, text: '    // domain 不 import 任何 provider 联合类型（§6 边界）。', newNo: 43 },
      { type: 'add' as const, text: '    const ev = normalizeCodexEvent(msg);', newNo: 44 },
      { type: 'ctx' as const, text: '    this.onEvent(ev);', oldNo: 43, newNo: 45 },
    ],
  },
];

/** 删除文件：diff 是整段删除（不是"无文本 diff"） */
const DIFF_DELETE_LEGACY = [
  {
    header: '@@ -1,7 +0,0 @@',
    lines: [
      { type: 'del' as const, text: '/** 早期实验：用 zod 校验厂商事件，已由 contracts 层取代。 */', oldNo: 1 },
      { type: 'del' as const, text: "import { z } from 'zod';", oldNo: 2 },
      { type: 'del' as const, text: 'export const codexEvent = z.object({ type: z.string() });', oldNo: 3 },
      { type: 'del' as const, text: 'export const parseCodex = (raw: unknown) => codexEvent.parse(raw);', oldNo: 4 },
    ],
  },
];

/** 重命名 + 小改动：git 会把它显示成 rename with changes */
const DIFF_RENAME_COMPOSER = [
  {
    header: '@@ -1,5 +1,6 @@',
    lines: [
      { type: 'ctx' as const, text: '/** 输入区：房间 / 线程 / 私信共用同一个组件。 */', oldNo: 1, newNo: 1 },
      { type: 'add' as const, text: '// 移动原因：输入区不再只服务 ui 内部，放在 components 下供三处 import。', newNo: 2 },
      { type: 'ctx' as const, text: 'export function Composer(props: ComposerProps) {', oldNo: 2, newNo: 3 },
    ],
  },
];

const DIFF_WEEKLY = [
  {
    header: '@@ -0,0 +1,12 @@',
    lines: [
      { type: 'add' as const, text: '# 第 39 周演化日志（2026-09-21 ~ 2026-09-26）', newNo: 1 },
      { type: 'add' as const, text: '', newNo: 2 },
      { type: 'add' as const, text: '## 完成', newNo: 3 },
      { type: 'add' as const, text: '- 文件与 Git 合页：三层结构收敛为一条滚动轴', newNo: 4 },
      { type: 'add' as const, text: '- 侧栏状态提示统一：状态位 / 蓝点 / 数字徽标', newNo: 5 },
      { type: 'add' as const, text: '', newNo: 6 },
      { type: 'add' as const, text: '## 受阻', newNo: 7 },
      { type: 'add' as const, text: '- Windows 中文路径：已定位，改动待验收（任务 #13）', newNo: 8 },
    ],
  },
];

const DIFF_EVOLOG = [
  {
    header: '@@ -8,6 +8,11 @@',
    lines: [
      { type: 'ctx' as const, text: '## 2026-09-20', oldNo: 8, newNo: 8 },
      { type: 'ctx' as const, text: '- 私信沿用房间三模式，以参与者为可见范围。', oldNo: 9, newNo: 9 },
      { type: 'add' as const, text: '', newNo: 10 },
      { type: 'add' as const, text: '## 2026-09-25', newNo: 11 },
      { type: 'add' as const, text: '- 仓库初始化并推送远端；截图与 dist 不入库。', newNo: 12 },
    ],
  },
];

const DIFF_NOTES_KEYBOARD = [
  {
    header: '@@ -1,4 +1,7 @@',
    lines: [
      { type: 'ctx' as const, text: '# 键盘可达性笔记', oldNo: 1, newNo: 1 },
      { type: 'del' as const, text: '- 浮层用 Esc 关闭（好像可以用 onBlur）。', oldNo: 2 },
      { type: 'add' as const, text: '- 浮层只认真实 mousedown / Esc：`click` 会被拖动误触发。', newNo: 2 },
      { type: 'add' as const, text: '- 只加 `disabled` 不算禁用，得同时挡住提交路径。', newNo: 3 },
    ],
  },
];

const DIFF_FORMAT = [
  {
    header: '@@ -22,7 +22,9 @@',
    lines: [
      { type: 'ctx' as const, text: 'export function shortName(path: string) {', oldNo: 22, newNo: 22 },
      { type: 'del' as const, text: '  return path.split("/").pop() ?? path;', oldNo: 23 },
      { type: 'add' as const, text: '  // 中文文件名要走 NFC 归一化：macOS 传来的 NFD 会显示成问号。', newNo: 23 },
      { type: 'add' as const, text: '  const name = path.split("/").pop() ?? path;', newNo: 24 },
      { type: 'add' as const, text: '  return name.normalize("NFC");', newNo: 25 },
    ],
  },
];

const DIFF_CI = [
  {
    header: '@@ -0,0 +1,9 @@',
    lines: [
      { type: 'add' as const, text: 'name: ci', newNo: 1 },
      { type: 'add' as const, text: 'on: [push, pull_request]', newNo: 2 },
      { type: 'add' as const, text: 'jobs:', newNo: 3 },
      { type: 'add' as const, text: '  check:', newNo: 4 },
      { type: 'add' as const, text: '    runs-on: windows-latest', newNo: 5 },
      { type: 'add' as const, text: '    steps: [checkout, setup-node, pnpm test]', newNo: 6 },
    ],
  },
];

/* ============================================================
   历史列表的填充提交（2026-09-26 补数据）
   ============================================================
   为什么需要：页面骨架是"整页一条滚动轴 + 吸顶状态条"，但历史原本只有 5 条，
   整个视图还没铺满一屏 —— 滚动、吸顶、左清单随页滚动这几件事**根本无法实测**。
   手写 46 条完整提交（含 diff）既啰嗦又会把种子文件淹掉，于是改用一张表生成：
   主题/作者/日期/文件都有真实感，parent 链线性（最老的接在 `0d9e3b8` 上），
   哈希由序号确定性生成 —— 刷新不会变，原型仍可复现。

   两条刻意的克制（不是遗漏）：
     - 填充提交**不带 taskId / changeSetId**：历史详情里因此不会出现
       「来自任务」「关联改动集」——只有真正的任务产出才可回溯，不伪造这条能力。
     - **不给 diff**：46 份 diff 会把文件撑爆；展开时显示「无文本 diff。」，
       真实 diff 由前面那 14 条手工提交承担。
*/
const FILLERS: [subject: string, dayAgo: number, author: 'you' | 'codex' | 'claude', file: string, change: 'added' | 'modified' | 'deleted'][] = [
  ['fix: 归档房间不再进入默认列表', 9, 'you', 'src/domain/archive.ts', 'modified'],
  ['chore: 补 tsconfig 严格模式', 9, 'you', 'tsconfig.json', 'modified'],
  ['docs: 写清楚「停止 ≠ 撤销」', 10, 'you', 'docs/zhongshuo-development-design-v1.md', 'modified'],
  ['refactor: 侧栏状态提示收敛到一张优先级表', 10, 'codex', 'src/components/Sidebar.tsx', 'modified'],
  ['fix: 未读蓝点不再跟随 --danger', 11, 'you', 'src/styles/components.css', 'modified'],
  ['test: 补「隐藏项目仍可见待办」用例', 11, 'you', 'tests/unit/git_ops.test.ts', 'modified'],
  ['feat: 看板外层按项目分组', 12, 'you', 'src/ui/Board.tsx', 'modified'],
  ['fix: 同名房间不再合并计数', 12, 'claude', 'src/components/Sidebar.tsx', 'modified'],
  ['chore: 截图目录加入 .gitignore', 13, 'you', '.gitignore', 'modified'],
  ['refactor: 阅读水位从消息表拆到独立表', 13, 'you', 'src/persistence/migrations/0002_threads.sql', 'added'],
  ['fix: 私信列表不再显示空群聊', 14, 'you', 'src/ui/DmList.tsx', 'modified'],
  ['docs: 补运行手册（端口与调试）', 14, 'you', 'docs/notes/2026-09-02-lock-domain.md', 'modified'],
  ['feat: 预览面板加版本徽标', 15, 'claude', 'src/components/PreviewPane.tsx', 'modified'],
  ['fix: 长名称任务不撑坏看板卡片', 15, 'you', 'src/ui/Board.tsx', 'modified'],
  ['chore: 统一 npm 脚本命名', 16, 'you', 'package.json', 'modified'],
  ['refactor: 目录锁判定改用 realpath', 16, 'codex', 'src/runtime/lock.ts', 'modified'],
  ['fix: 停止任务后不再派发后续 turn', 17, 'you', 'src/runtime/dispatch.ts', 'modified'],
  ['test: 补预算停止的边界用例', 17, 'you', 'tests/unit/task_status.test.ts', 'modified'],
  ['docs: 六边界图改成方向说明', 18, 'you', 'docs/notes/2026-09-02-lock-domain.md', 'modified'],
  ['feat: 授权卡支持「拒绝并说明」', 18, 'claude', 'src/domain/approval.ts', 'modified'],
  ['fix: 附件芯片不再挤掉发送按钮', 19, 'you', 'src/components/Composer.tsx', 'modified'],
  ['chore: 把 dev server 端口抽成参数', 19, 'you', 'scripts/dev-server.mjs', 'added'],
  ['refactor: 事件类型收敛进 contracts', 20, 'codex', 'src/contracts/events.ts', 'modified'],
  ['fix: 线程切换后草稿不再串线', 20, 'you', 'src/data/store.ts', 'modified'],
  ['feat: 活动页加动作类型筛选', 21, 'you', 'src/ui/Activity.tsx', 'added'],
  ['docs: 记录 CDP 端口踩坑', 21, 'you', 'docs/notes/2026-09-02-lock-domain.md', 'modified'],
  ['fix: 二进制文件不再假装能预览', 22, 'you', 'src/components/PreviewPane.tsx', 'modified'],
  ['chore: 清掉未使用的图标', 22, 'you', 'src/components/Icon.tsx', 'modified'],
  ['refactor: 格式化函数按用途拆开', 23, 'claude', 'src/lib/format.ts', 'modified'],
  ['fix: 相对时间超过 7 天显示日期', 23, 'you', 'src/lib/time.ts', 'modified'],
  ['feat: 任务卡显示当前交付版本', 24, 'you', 'src/ui/Board.tsx', 'modified'],
  ['test: 补项目隔离的用例', 24, 'you', 'tests/e2e/thread_isolation.test.ts', 'modified'],
  ['fix: 空目录不再从树里消失', 25, 'you', 'src/data/mock-tree.ts', 'modified'],
  ['docs: 拆出 §12 数据模型的备注', 25, 'you', 'docs/zhongshuo-development-design-v1.md', 'modified'],
  ['refactor: 命令留痕统一走 recordWrite', 26, 'codex', 'src/data/actions.ts', 'modified'],
  ['fix: 迁移脚本可重复执行', 26, 'you', 'src/persistence/migrations/0001_init.sql', 'modified'],
  ['chore: 补 TypeScript 版本到 engines', 27, 'you', 'package.json', 'modified'],
  ['feat: 侧栏折叠后仍显示聚合未读', 27, 'you', 'src/components/Sidebar.tsx', 'modified'],
  ['fix: 折叠状态不再吞掉运行中标志', 28, 'you', 'src/components/Sidebar.tsx', 'modified'],
  ['refactor: 适配器注册表去掉 switch', 29, 'claude', 'src/adapter/provider-registry.ts', 'modified'],
  ['fix: 通知去重按 turnId 而不是时间窗', 29, 'you', 'src/runtime/dispatch.ts', 'modified'],
  ['docs: 补失败路径的样例文案', 30, 'you', 'docs/zhongshuo-development-design-v1.md', 'modified'],
  ['chore: 移除废弃的桥接实验代码', 31, 'you', 'src/adapter/legacy-zod.ts', 'deleted'],
  ['feat: 搜索支持按房间过滤', 32, 'you', 'src/ui/Search.tsx', 'added'],
  ['fix: 中文标题不再截断成半个字', 33, 'you', 'src/lib/format.ts', 'modified'],
  ['chore: 初始化 lint 规则集', 34, 'you', '.github/workflows/ci.yml', 'added'],
];

/** 由序号生成稳定的 40 位十六进制（原型不需要真 SHA-1，但刷新必须看出同一串）。
    第一版直接乘 FNV 素数后取低 4 位，结果短哈希每 13 条就重复一次
    （乘奇数不改变低位的周期，截图里一眼就看出来了）——
    改成 xorshift32 取**高位** nibble，序列足够长，46 条不重样。 */
function stableHash(seed: number): { hash: string; shortHash: string } {
  let x = (Math.imul(seed, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
  let full = '';
  for (let i = 0; i < 40; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    full += '0123456789abcdef'[(x >>> 28) & 0xf];
  }
  return { hash: full, shortHash: full.slice(0, 7) };
}

const AUTHOR_OF = {
  you: { authorName: '你', authorEmail: 'you@local', authoredBy: 'human' as const },
  codex: { authorName: 'Codex', authorEmail: 'agent+codex@zhongshuo.local', authoredBy: 'agent' as const, memberId: I.M_CODEX },
  claude: { authorName: 'Claude', authorEmail: 'agent+claude@zhongshuo.local', authoredBy: 'agent' as const, memberId: I.M_CLAUDE },
};

/** 从最老的一条往前接（parent = 上一条），最后整个反转成"新的在前"。
    表里是"新的在前"的写法，所以先 reverse 一次再按序号接链。 */
const FILLER_COMMITS: GitCommit[] = (() => {
  const oldestFirst: GitCommit[] = FILLERS.slice().reverse().map(([subject, dayAgo, author, file, change], i) => {
    const { hash, shortHash } = stableHash(i + 101);
    return {
      hash,
      shortHash,
      subject,
      ...AUTHOR_OF[author],
      committedAt: NOW - day(dayAgo) - hour((i % 7) + 1),
      parents: [] as string[],
      refs: i === 0 ? ['v0.0.9-alpha'] : [],
      files: [{ path: file, change, additions: 6 + (i % 11), deletions: change === 'added' ? 0 : (i % 5), diff: [] }],
    };
  });
  oldestFirst.forEach((c, i) => {
    c.parents = [i === 0 ? H.rootFull : oldestFirst[i - 1].hash];
  });
  return oldestFirst.reverse();
})();

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
      /* 2026-09-26 补数据：分支列表也要能滚，且把三种同步状态都凑齐
         （领先 / 落后 / 与上游一致），免得只看得到一种。 */
      {
        name: 'zs/task-14-weekly-digest',
        head: H.list,
        ahead: 2,
        behind: 1,
        isCurrent: false,
        createdByZhongshuo: true,
        updatedAt: NOW - day(3) - hour(2),
      },
      {
        name: 'fix/unread-focus-double-clear',
        head: H.unread,
        ahead: 1,
        behind: 3,
        isCurrent: false,
        updatedAt: NOW - day(3) - hour(6),
      },
      {
        name: 'chore/deps-electron-33',
        head: H.deps,
        upstream: 'origin/chore/deps-electron-33',
        ahead: 0,
        behind: 6,
        isCurrent: false,
        updatedAt: NOW - day(6),
      },
      {
        name: 'release/0.1-preview',
        head: H.ci,
        upstream: 'origin/release/0.1-preview',
        ahead: 0,
        behind: 9,
        isCurrent: false,
        updatedAt: NOW - day(8),
      },
      /* 2026-09-26 补数据：分支列表再厚一点，并把"没有上游 / 本地分支"这类
         形态也凑出来（不是每个分支都有 upstream）。尖端取历史里真实存在的哈希 */
      {
        name: 'spike/worktree-isolation',
        head: H.older,
        ahead: 0,
        behind: 14,
        isCurrent: false,
        createdByZhongshuo: true,
        updatedAt: NOW - day(2) - hour(9),
      },
      {
        name: 'feat/board-project-grouping',
        head: FILLER_COMMITS[8].shortHash,
        ahead: 1,
        behind: 6,
        isCurrent: false,
        updatedAt: NOW - day(12) - hour(2),
      },
      {
        name: 'fix/sidebar-unread-dot',
        head: H.unread,
        upstream: 'origin/fix/sidebar-unread-dot',
        ahead: 0,
        behind: 5,
        isCurrent: false,
        updatedAt: NOW - day(4),
      },
      {
        name: 'refactor/contracts-normalize',
        head: H.agent,
        ahead: 0,
        behind: 3,
        isCurrent: false,
        updatedAt: NOW - day(3) - hour(10),
      },
      {
        name: 'docs/weekly-digest',
        head: H.permdocs,
        ahead: 0,
        behind: 12,
        isCurrent: false,
        updatedAt: NOW - day(5) - hour(3),
      },
      {
        name: 'chore/ci-windows-only',
        head: H.ci,
        upstream: 'origin/chore/ci-windows-only',
        ahead: 0,
        behind: 8,
        isCurrent: false,
        updatedAt: NOW - day(8) - hour(1),
      },
      {
        name: 'dependabot/npm_and_yarn/vite-5.4.12',
        head: H.deps,
        upstream: 'origin/dependabot/npm_and_yarn/vite-5.4.12',
        ahead: 0,
        behind: 10,
        isCurrent: false,
        updatedAt: NOW - day(6) - hour(4),
      },
      {
        name: 'experiment/board-lanes',
        head: FILLER_COMMITS[20].shortHash,
        ahead: 0,
        behind: 21,
        isCurrent: false,
        updatedAt: NOW - day(21),
      },
      /* 再补 10 条，让分支视图自己也能滚起来（尖端都指向历史里真实存在的提交，
         所以点开任何一条分支，都能在历史里找到它的提交） */
      {
        name: 'feat/activity-filters',
        head: FILLER_COMMITS[24].shortHash,
        ahead: 0,
        behind: 18,
        isCurrent: false,
        updatedAt: NOW - day(20) - hour(2),
      },
      {
        name: 'fix/attachment-chip-overflow',
        head: FILLER_COMMITS[20].shortHash,
        upstream: 'origin/fix/attachment-chip-overflow',
        ahead: 0,
        behind: 19,
        isCurrent: false,
        updatedAt: NOW - day(19) - hour(4),
      },
      {
        name: 'refactor/format-split',
        head: FILLER_COMMITS[28].shortHash,
        ahead: 1,
        behind: 16,
        isCurrent: false,
        updatedAt: NOW - day(22) - hour(1),
      },
      {
        name: 'test/project-isolation-e2e',
        head: FILLER_COMMITS[31].shortHash,
        ahead: 0,
        behind: 15,
        isCurrent: false,
        updatedAt: NOW - day(24) - hour(3),
      },
      {
        name: 'docs/runbook-ports',
        head: FILLER_COMMITS[11].shortHash,
        ahead: 0,
        behind: 25,
        isCurrent: false,
        updatedAt: NOW - day(14) - hour(6),
      },
      {
        name: 'spike/virtual-list',
        head: FILLER_COMMITS[2].shortHash,
        ahead: 0,
        behind: 30,
        isCurrent: false,
        updatedAt: NOW - day(10) - hour(5),
      },
      {
        name: 'fix/search-room-filter',
        head: FILLER_COMMITS[43].shortHash,
        ahead: 0,
        behind: 12,
        isCurrent: false,
        updatedAt: NOW - day(32) - hour(2),
      },
      {
        name: 'chore/lint-baseline',
        head: FILLER_COMMITS[45].shortHash,
        upstream: 'origin/chore/lint-baseline',
        ahead: 0,
        behind: 9,
        isCurrent: false,
        updatedAt: NOW - day(34),
      },
      {
        name: 'feat/delivery-version-badge',
        head: FILLER_COMMITS[30].shortHash,
        ahead: 2,
        behind: 14,
        isCurrent: false,
        updatedAt: NOW - day(23) - hour(7),
      },
      {
        name: 'release/0.0.9-alpha',
        head: FILLER_COMMITS[45].shortHash,
        ahead: 0,
        behind: 40,
        isCurrent: false,
        updatedAt: NOW - day(34) - hour(1),
      },
    ],
    remotes: [
      { name: 'origin', url: 'git@github.com:lsj/zhongshuo.git', authState: 'ok' },
      { name: 'backup', url: 'https://git.internal.example/zs.git', authState: 'missing' },
      // 三种凭据状态都出现（ok / missing / expired），免得「凭据已过期」永远测不到
      { name: 'upstream', url: 'git@github.com:zhongshuo/zhongshuo.git', authState: 'expired' },
      { name: 'lab', url: 'ssh://git@lab.internal/zhongshuo.git', authState: 'ok' },
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
        // 2026-09-26 补数据：链尾从 root 改接到下面补的历史提交（更老的一串）
        parents: [H.listFull],
        refs: ['feat/config-export'],
        files: [
          { path: 'docs/zhongshuo-development-design-v1.md', change: 'modified', additions: 96, deletions: 12, diff: [] },
        ],
      },

      /* ================= 2026-09-26 补的历史提交（用于测试向下滚动） =================
         位置：全部插在 `88a0f31` 之前、`0d9e3b8`（初始提交）之后，
         因此 HEAD、`zs/task-12-module-boundaries`、`feat/config-export` 的尖端
         都不受影响；parent 链保持线性，`undoLastCommit` 的软回退仍走同一套。
         其中两条是 agent 产出（authoredBy:'agent' + memberId），
         用来验证列表行的 cpu 图标与详情里的「agent 提交」Tag **在长列表里也能扫到**。 */
      {
        hash: H.listFull,
        shortHash: H.list,
        subject: 'feat: 房间消息列表改为虚拟滚动',
        body: '长会话一次派发几十条消息时主线程会卡住；改为固定行高虚拟化，只渲染视口内的行。',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(3) - hour(2),
        parents: [H.unreadFull],
        refs: [],
        files: [
          { path: 'src/ui/MessageList.tsx', change: 'added', additions: 96, deletions: 0, diff: DIFF_LIST },
        ],
      },
      {
        hash: H.unreadFull,
        shortHash: H.unread,
        subject: 'fix: 窗口聚焦时不再重复清未读',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(3) - hour(6),
        parents: [H.dispatchFull],
        refs: [],
        files: [
          { path: 'src/data/store.ts', change: 'modified', additions: 9, deletions: 4, diff: DIFF_UNREAD },
        ],
      },
      {
        hash: H.dispatchFull,
        shortHash: H.dispatch,
        subject: 'refactor: dispatchKey 生成收敛到单一函数',
        body: '**由 agent 产出。** 幂等键原先在三处各拼一次，重跑时会漏掉尝试次数。',
        authorName: 'Codex',
        authorEmail: 'agent+codex@zhongshuo.local',
        authoredBy: 'agent',
        memberId: I.M_CODEX,
        committedAt: NOW - day(4) - hour(1),
        parents: [H.isotestFull],
        refs: [],
        files: [
          { path: 'src/runtime/dispatch.ts', change: 'modified', additions: 24, deletions: 11, diff: DIFF_DISPATCH },
        ],
        taskId: I.TASK_12,
      },
      {
        hash: H.isotestFull,
        shortHash: H.isotest,
        subject: 'test: 补线程与任务不串线的回归用例',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(4) - hour(7),
        parents: [H.permdocsFull],
        refs: [],
        files: [
          { path: 'tests/e2e/thread_isolation.test.ts', change: 'added', additions: 58, deletions: 0, diff: [] },
        ],
      },
      {
        hash: H.permdocsFull,
        shortHash: H.permdocs,
        subject: 'docs: 补 §16 权限与恢复的失败路径',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(5) - hour(3),
        parents: [H.depsFull],
        refs: [],
        files: [
          { path: 'docs/zhongshuo-development-design-v1.md', change: 'modified', additions: 142, deletions: 18, diff: [] },
        ],
      },
      {
        hash: H.depsFull,
        shortHash: H.deps,
        subject: 'chore(deps): 升级 electron 到 33.x',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(6),
        parents: [H.archiveFull],
        refs: [],
        files: [
          { path: 'package.json', change: 'modified', additions: 3, deletions: 3, diff: [] },
          { path: 'pnpm-lock.yaml', change: 'modified', additions: 128, deletions: 96, diff: [] },
        ],
      },
      {
        hash: H.archiveFull,
        shortHash: H.archive,
        subject: 'feat: 归档房间只读并保留入口',
        body: '**由 agent 产出，由你合并。** 归档只改变可写性，不从侧栏抹掉房间。',
        authorName: 'Claude',
        authorEmail: 'agent+claude@zhongshuo.local',
        authoredBy: 'agent',
        memberId: I.M_CLAUDE,
        committedAt: NOW - day(6) - hour(8),
        parents: [H.cjknameFull],
        refs: [],
        files: [
          { path: 'src/domain/archive.ts', change: 'added', additions: 47, deletions: 0, diff: [] },
          { path: 'src/components/Sidebar.tsx', change: 'modified', additions: 18, deletions: 6, diff: [] },
        ],
      },
      {
        hash: H.cjknameFull,
        shortHash: H.cjkname,
        subject: 'fix: 中文文件名在附件列表里显示为问号',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(7) - hour(4),
        parents: [H.ciFull],
        refs: [],
        files: [
          { path: 'src/lib/format.ts', change: 'modified', additions: 6, deletions: 2, diff: DIFF_FORMAT },
        ],
      },
      {
        hash: H.ciFull,
        shortHash: H.ci,
        subject: 'chore: 加 CI 工作流（lint + 单测）',
        authorName: '你',
        authorEmail: 'you@local',
        authoredBy: 'human',
        committedAt: NOW - day(8),
        // 链尾接的是填充提交里**最新**的一条（它自己再往老接，最后落到初始提交）
        parents: [FILLER_COMMITS[0].hash],
        // 一个 tag，用来验证详情里 refs 的展示不只认分支名
        refs: ['v0.1.0-preview'],
        files: [
          { path: '.github/workflows/ci.yml', change: 'added', additions: 34, deletions: 0, diff: DIFF_CI },
        ],
      },

      /* 填充提交：只为把列表撑过一屏（见文件上方注释，无 taskId / 无 diff） */
      ...FILLER_COMMITS,

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
     * changeset_13 的 afterRef=git:WORKTREE@uncommitted，所以那两个文件此刻是
     * 「已修改、未提交」；2026-09-26 补的 changeset_12_r2 / changeset_14 同理。
     *
     * 顺序有讲究：**任务 #13 的三条必须排在最前面** —— Git 页给每个任务
     * 分组一个「暂存本任务改动」按钮，自动化用例点的是第一个，
     * 把别的任务排到前面会让那些用例暂存错对象。
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
        // 任务 #13 的验证脚本：修复中文路径时顺带加的
        path: 'scripts/check-paths.mjs',
        state: 'added',
        staged: false,
        additions: 26,
        deletions: 0,
        diff: [
          {
            header: '@@ -0,0 +1,6 @@',
            lines: [
              { type: 'add' as const, text: '/** 自检：项目里所有 script 入口在有中文的路径下都能被解析。 */', newNo: 1 },
              { type: 'add' as const, text: "import { pathToFileURL } from 'node:url';", newNo: 2 },
              { type: 'add' as const, text: 'for (const p of entryPoints) {', newNo: 3 },
              { type: 'add' as const, text: '  await import(pathToFileURL(p).href);   // 解析失败即抛 ENOENT', newNo: 4 },
              { type: 'add' as const, text: '}', newNo: 5 },
            ],
          },
        ],
        changeSetId: I.CS_13,
        taskId: I.TASK_13,
      },
      {
        path: 'docs/path-fix-note.md',
        state: 'added',
        staged: false,
        additions: 18,
        deletions: 0,
        diff: [
          {
            header: '@@ -0,0 +1,5 @@',
            lines: [
              { type: 'add' as const, text: '# 中文路径修复说明', newNo: 1 },
              { type: 'add' as const, text: '', newNo: 2 },
              { type: 'add' as const, text: '复现：项目路径含中文时 build 脚本报 ENOENT。', newNo: 3 },
              { type: 'add' as const, text: '修复：路径先进 pathToFileURL / fileURLToPath 规范化。', newNo: 4 },
              { type: 'add' as const, text: '验证：scripts/check-paths.mjs 全绿（见任务 #13 验证记录）。', newNo: 5 },
            ],
          },
        ],
        changeSetId: I.CS_13,
        taskId: I.TASK_13,
      },

      /* ---- 2026-09-26 补数据：任务 #12 第二轮（仍待提交） ----
         原目录直接写入模式（§14.3）下，agent 改完就落在工作区，
         所以「已应用但未提交」是常态，不是矛盾状态。
         这几条刻意覆盖多种状态点：修改 / 删除 / 重命名 / 未跟踪。 */
      {
        path: 'src/contracts/events.ts',
        state: 'modified',
        staged: false,
        additions: 31,
        deletions: 12,
        diff: DIFF_EVENTS_R2,
        changeSetId: I.CS_12_R2,
        taskId: I.TASK_12,
      },
      {
        path: 'src/adapter/codex-appserver.ts',
        state: 'modified',
        staged: false,
        additions: 18,
        deletions: 6,
        diff: DIFF_APPSERVER,
        changeSetId: I.CS_12_R2,
        taskId: I.TASK_12,
      },
      {
        path: 'src/adapter/legacy-zod.ts',
        state: 'deleted',
        staged: false,
        additions: 0,
        deletions: 4,
        diff: DIFF_DELETE_LEGACY,
        changeSetId: I.CS_12_R2,
        taskId: I.TASK_12,
      },
      {
        // 重命名：路径是新路径，原路径写在 diff 头里（类型没有 renameFrom 字段）
        path: 'src/components/Composer.tsx',
        state: 'renamed',
        staged: false,
        additions: 3,
        deletions: 3,
        diff: DIFF_RENAME_COMPOSER,
        changeSetId: I.CS_12_R2,
        taskId: I.TASK_12,
      },
      {
        path: 'src/contracts/router.ts',
        state: 'modified',
        staged: false,
        additions: 11,
        deletions: 4,
        diff: [
          {
            header: '@@ -2,7 +2,10 @@',
            lines: [
              { type: 'ctx' as const, text: '/** 路由由 @ 结构推导，不由界面控件单独决定 */', oldNo: 2, newNo: 2 },
              { type: 'del' as const, text: 'export function deriveRoute(mentions: string[], sendAs: "ai" | "record") {', oldNo: 3 },
              { type: 'add' as const, text: 'export function deriveRoute(mentions: Speech[], sendAs: "ai" | "record") {', newNo: 3 },
              { type: 'add' as const, text: '  // 结构化 @ 才算路由语义：纯文本里的 @ 词不算（§4.1）', newNo: 4 },
              { type: 'ctx' as const, text: '  if (sendAs === "record") return { mode: "AUTO", reason: "仅记录：不唤醒 agent" };', oldNo: 4, newNo: 5 },
            ],
          },
        ],
        changeSetId: I.CS_12_R2,
        taskId: I.TASK_12,
      },
      {
        path: 'src/domain/usage.ts',
        state: 'modified',
        staged: false,
        additions: 7,
        deletions: 3,
        diff: [
          {
            header: '@@ -4,5 +4,8 @@',
            lines: [
              { type: 'ctx' as const, text: 'export function sumUsage(run: WorkflowRun): UsageRecord {', oldNo: 4, newNo: 4 },
              { type: 'del' as const, text: '  return run.turns.reduce(add, empty);', oldNo: 5 },
              { type: 'add' as const, text: '  // 预算判定读的是逐 turn 用量，不等于"最后一条消息里说的数"', newNo: 5 },
              { type: 'add' as const, text: '  return run.turns.filter((t) => t.status === "done").reduce(add, empty);', newNo: 6 },
            ],
          },
        ],
        changeSetId: I.CS_12_R2,
        taskId: I.TASK_12,
      },
      {
        path: 'src/ui/Board.tsx',
        state: 'modified',
        staged: false,
        additions: 9,
        deletions: 2,
        diff: [
          {
            header: '@@ -6,6 +6,10 @@',
            lines: [
              { type: 'ctx' as const, text: 'export function Board() {', oldNo: 6, newNo: 6 },
              { type: 'del' as const, text: '  return <div className="board">{renderGroup(tasks)}</div>;', oldNo: 7 },
              { type: 'add' as const, text: '  // 外层按 projectId 分组：两个项目都有 #12，靠编号分组会合并（§9.5）', newNo: 7 },
              { type: 'add' as const, text: '  return <div className="board">{groupBy(tasks, (t) => t.projectId).map(renderGroup)}</div>;', newNo: 8 },
            ],
          },
        ],
        changeSetId: I.CS_12_R2,
        taskId: I.TASK_12,
      },

      /* ---- 2026-09-26 补数据：任务 #14（周报）也还没提交 ---- */
      {
        path: 'docs/weekly/2026-W39.md',
        state: 'added',
        staged: false,
        additions: 64,
        deletions: 0,
        diff: DIFF_WEEKLY,
        changeSetId: I.CS_14,
        taskId: I.TASK_14,
      },
      {
        path: 'docs/evo-log.md',
        state: 'modified',
        staged: false,
        additions: 12,
        deletions: 4,
        diff: DIFF_EVOLOG,
        changeSetId: I.CS_14,
        taskId: I.TASK_14,
      },
      {
        path: 'docs/weekly/2026-W38.md',
        state: 'modified',
        staged: false,
        additions: 5,
        deletions: 2,
        diff: [
          {
            header: '@@ -8,4 +8,6 @@',
            lines: [
              { type: 'ctx' as const, text: '## 下周', oldNo: 8, newNo: 8 },
              { type: 'del' as const, text: '- 导航重排（待定）', oldNo: 9 },
              { type: 'add' as const, text: '- 导航重排：侧栏三段式 + 顶栏项目菜单（已完成，见 W39）', newNo: 9 },
              { type: 'add' as const, text: '- 文件与 Git 合页（进行中）', newNo: 10 },
            ],
          },
        ],
        changeSetId: I.CS_14,
        taskId: I.TASK_14,
      },
      {
        path: 'docs/notes/2026-09-02-lock-domain.md',
        state: 'modified',
        staged: false,
        additions: 6,
        deletions: 1,
        diff: [
          {
            header: '@@ -1,5 +1,8 @@',
            lines: [
              { type: 'ctx' as const, text: '# 目录锁域判定', oldNo: 1, newNo: 1 },
              { type: 'del' as const, text: '（待补：与快照的关系）', oldNo: 2 },
              { type: 'add' as const, text: '补充：非 Git 目录用整目录快照做内容级前像，锁域仍按物理目录算。', newNo: 2 },
              { type: 'add' as const, text: '两个项目指向同一目录时，锁必须合并为一把（否则是假隔离）。', newNo: 3 },
            ],
          },
        ],
        changeSetId: I.CS_14,
        taskId: I.TASK_14,
      },

      /* ---- 2026-09-26 补数据：子任务 #12（adapter 层类型泄漏核对）----
         子任务是真实存在的任务（同一 thread 下的 SUB_12_ARCH），
         于是「按任务分组」多出一组，长列表的分组头与组内操作也被覆盖到。 */
      {
        path: 'src/adapter/claude-headless.ts',
        state: 'modified',
        staged: false,
        additions: 14,
        deletions: 5,
        diff: [
          {
            header: '@@ -12,7 +12,11 @@ export class ClaudeHeadlessAdapter {',
            lines: [
              { type: 'ctx' as const, text: '  async *run(turn: TurnInput): AsyncIterable<NormalizedEvent> {', oldNo: 12, newNo: 12 },
              { type: 'del' as const, text: '    for await (const raw of this.transport(turn)) yield raw as any;', oldNo: 13 },
              { type: 'add' as const, text: '    // 泄漏点：这里原来把厂商流事件直接 yield 出去，', newNo: 13 },
              { type: 'add' as const, text: '    // domain 因此能看到 ClaudeStreamEvent（§6 违规）。', newNo: 14 },
              { type: 'add' as const, text: '    for await (const raw of this.transport(turn)) yield normalizeClaudeEvent(raw);', newNo: 15 },
            ],
          },
        ],
        changeSetId: I.CS_12_ARCH,
        taskId: I.SUB_12_ARCH,
      },
      {
        path: 'src/adapter/provider-registry.ts',
        state: 'modified',
        staged: false,
        additions: 4,
        deletions: 4,
        diff: [
          {
            header: '@@ -1,6 +1,6 @@',
            lines: [
              { type: 'ctx' as const, text: '/** 首版只接 Codex App Server 与 Claude Code headless（决策 37）。 */', oldNo: 1, newNo: 1 },
              { type: 'del' as const, text: 'export const ADAPTERS: Record<string, () => Adapter> = {', oldNo: 2 },
              { type: 'add' as const, text: 'export const ADAPTERS: Record<RuntimeId, () => Adapter> = {', newNo: 2 },
              { type: 'ctx' as const, text: '  [RT_CODEX]: () => new CodexAppServerAdapter(),', oldNo: 3, newNo: 3 },
            ],
          },
        ],
        changeSetId: I.CS_12_ARCH,
        taskId: I.SUB_12_ARCH,
      },
      {
        path: 'tests/unit/task_status.test.ts',
        state: 'modified',
        staged: false,
        additions: 21,
        deletions: 0,
        diff: [
          {
            header: '@@ -12,3 +12,8 @@',
            lines: [
              { type: 'ctx' as const, text: "describe('任务状态机', () => {", oldNo: 12, newNo: 12 },
              { type: 'add' as const, text: "  it('adapter 层不得把厂商类型带出边界', () => {", newNo: 13 },
              { type: 'add' as const, text: '    expect(importsOf("src/domain").some(isProviderType)).toBe(false);', newNo: 14 },
              { type: 'add' as const, text: '  });', newNo: 15 },
            ],
          },
        ],
        changeSetId: I.CS_12_ARCH,
        taskId: I.SUB_12_ARCH,
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
        // 2026-09-26 补数据：用户原有改动不止一个 —— 分组里要有可展开的"多个"
        path: 'docs/notes/2026-09-24-keyboard.md',
        state: 'modified',
        staged: false,
        additions: 3,
        deletions: 1,
        diff: DIFF_NOTES_KEYBOARD,
        userPreExisting: true,
      },
      {
        // 未跟踪 + 用户原有：验证"未跟踪"状态点与"跳过批量暂存"同时成立
        path: '.env.local',
        state: 'untracked',
        staged: false,
        additions: 0,
        deletions: 0,
        diff: [],
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
    /* reflog：右栏只显示前 8 条，这里给 11 条 —— 让"只显示最近 8 条"这件事
       在界面上看得出来（下面还有更老的记录，不是数据没了）。 */
    reflog: [
      { at: NOW - min(105), op: 'commit', ref: H.head, detail: 'chore: 收敛 Windows 中文路径解析' },
      { at: NOW - min(140), op: 'stage', ref: 'scripts/build-report.mjs', detail: '按任务暂存（tasks #13）' },
      { at: NOW - hour(3), op: 'commit', ref: H.agent, detail: 'refactor: 抽出 contracts 规范化事件类型（agent）' },
      { at: NOW - hour(3) - min(20), op: 'branch', ref: 'zs/task-12-module-boundaries', detail: '从 main 创建隔离分支（任务 #12）' },
      { at: NOW - day(1) - hour(4), op: 'commit', ref: H.prev, detail: 'feat: 线程阅读水位与未读计数' },
      { at: NOW - day(1) - hour(9), op: 'pull', ref: H.prev, detail: '从 origin 快进合并 1 个提交' },
      { at: NOW - day(2), op: 'checkout', ref: 'main', detail: '从 feat/config-export 切回 main' },
      { at: NOW - day(2) - hour(6), op: 'commit', ref: H.older, detail: 'docs: 同步 §14 撤销与并发策略' },
      { at: NOW - day(3) - hour(2), op: 'commit', ref: H.list, detail: 'feat: 房间消息列表改为虚拟滚动' },
      { at: NOW - day(3) - hour(6), op: 'commit', ref: H.unread, detail: 'fix: 窗口聚焦时不再重复清未读' },
      { at: NOW - day(8), op: 'commit', ref: H.ci, detail: 'chore: 加 CI 工作流（lint + 单测）' },
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
