/**
 * 项目文件树 mock 数据（第十五批 §4）。
 *
 * 为什么要有它：§17.1/§17.2 承诺「文件」标签是**文件树 + 预览 + diff**，
 * 但原型的左列一直只是"改动集列表" —— 那其实只覆盖了"改了什么"，
 * 用户看不到"项目里有什么"（未修改的文件、嵌套目录、空目录）。
 *
 * **明确边界（必须让读者知道这是 mock）**：
 *  - 不扫描真实磁盘，不读用户项目文件内容；
 *  - 树与预览内容都是构造的示例，用于验证交互（展开/选中/大文件/二进制说明）；
 *  - 真实实现需要 `file.tree` / `file.read`（§15.2 目前**没有**这两个命令，
 *    属待补命令面），并受目录锁与权限约束。
 *
 * 2026-09-26 补数据（用户要求「能测向下滚动」）：众说项目从 16 个节点补到 60 个，
 * 并对齐了 Git 侧的工作区改动路径（两边同一份事实）。另外每个项目都补了几层，
 * 免得切换项目后树又变成一屏看完。
 */

export interface MockFileNode {
  /** 相对项目根的路径，作为稳定 key */
  path: string;
  name: string;
  kind: 'dir' | 'file';
  /** 文件大小（字节），目录为 undefined */
  sizeBytes?: number;
  /** 预览内容；二进制/超大文件不给内容，界面显示说明而不是假装能读 */
  preview?: string;
  /** 不可按文本预览的原因（§4：非文本/大文件显示适当说明） */
  notPreviewable?: 'binary' | 'too_large';
  /** 是否为项目中的空目录（也要能显示出来） */
  emptyDir?: boolean;
}

const TREE_ZS: MockFileNode[] = [
  /* ---------- 2026-09-26 补数据：树要够长，向下滚动才测得了 ----------
     原来只有 16 个节点（src 下三层 + scripts + docs），展开后一屏看完。
     本轮补到 60 个节点：多出 app / adapter / components / data / lib /
     persistence / runtime 七个目录、tests、.github、根级配置与 docs 的补充，
     并与 Git 侧数据**对得上**（events.ts、codex-appserver.ts、
     src/components/Composer.tsx、docs/weekly/2026-W39.md、docs/evo-log.md、
     docs/notes/2026-09-24-keyboard.md 在两边都出现）——
     树上的改动标记读的是改动集，两边不一致会一眼看出来。
     仍然只是 mock：不扫描真实磁盘，内容是为验证交互构造的。 */
  {
    path: 'src', name: 'src', kind: 'dir',
  },
  {
    path: 'src/app', name: 'app', kind: 'dir',
  },
  {
    path: 'src/app/main.tsx', name: 'main.tsx', kind: 'file', sizeBytes: 690,
    preview: `import { createRoot } from 'react-dom/client';
import { App } from './shell';

// 主题在挂载前定下来，避免首帧闪白
document.documentElement.dataset.theme = readTheme();
createRoot(document.getElementById('root')!).render(<App />);
`,
  },
  {
    path: 'src/app/routes.tsx', name: 'routes.tsx', kind: 'file', sizeBytes: 2240,
    preview: `/** 深链只认 path 里的来源，不靠"上次看到的页面"兜底（§17.7）。 */
export function resolveRoute(hash: string): Route {
  const [path, query] = hash.replace(/^#/, '').split('?');
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'project' && seg[2] === 'files') {
    return { kind: 'files', projectId: seg[1], tab: new URLSearchParams(query).get('tab') };
  }
  return { kind: 'room', projectId: seg[1], roomId: seg[3] };
}
`,
  },
  {
    path: 'src/app/shell.tsx', name: 'shell.tsx', kind: 'file', sizeBytes: 5120,
    preview: `/** 外壳：标题栏 + 侧栏 + 工作区。顶栏已删除（2026-09-25），
    项目选择器在侧栏最顶部，运行状态移到标题栏。 */
export function App() {
  return (
    <div className="shell">
      <TitleBar />
      <Sidebar />
      <Workspace />
    </div>
  );
}
`,
  },
  {
    path: 'src/adapter', name: 'adapter', kind: 'dir',
  },
  {
    path: 'src/adapter/codex-appserver.ts', name: 'codex-appserver.ts', kind: 'file', sizeBytes: 6120,
    preview: `/** Codex App Server 适配器。
 *  厂商类型只在本层出现：出边一律转成 contracts 的 NormalizedEvent。 */
export class CodexAppServerAdapter {
  private handleNotification(msg: unknown) {
    const ev = normalizeCodexEvent(msg);
    this.onEvent(ev);
  }
}
`,
  },
  {
    path: 'src/adapter/claude-headless.ts', name: 'claude-headless.ts', kind: 'file', sizeBytes: 4480,
    preview: `/** Claude Code headless 适配器：流式事件同样收敛到 NormalizedEvent。 */
export class ClaudeHeadlessAdapter {
  async *run(turn: TurnInput): AsyncIterable<NormalizedEvent> {
    for await (const raw of this.transport(turn)) yield normalizeClaudeEvent(raw);
  }
}
`,
  },
  {
    path: 'src/adapter/provider-registry.ts', name: 'provider-registry.ts', kind: 'file', sizeBytes: 1740,
    preview: `/** 首版只接 Codex App Server 与 Claude Code headless（决策 37）。 */
export const ADAPTERS = {
  [RT_CODEX]: () => new CodexAppServerAdapter(),
  [RT_CLAUDE]: () => new ClaudeHeadlessAdapter(),
} as const;
`,
  },
  {
    path: 'src/components', name: 'components', kind: 'dir',
  },
  {
    // 注意：Git 工作区里这个文件是「重命名」，原路径 src/ui/Composer.tsx
    path: 'src/components/Composer.tsx', name: 'Composer.tsx', kind: 'file', sizeBytes: 7260,
    preview: `/** 输入区：房间 / 线程 / 私信共用同一个组件（三者不再各写一份）。 */
export function Composer({ draftKey, sendAs, onSend }: ComposerProps) {
  // 「仅记录」是一次性意图：不派发，活动页只留 record.save
  const route = deriveRoute(mentions, sendAs);
  return <div className="composer">{/* 附件 / 权限档位 / 运行设置 / 发送 */}</div>;
}
`,
  },
  {
    path: 'src/components/PreviewPane.tsx', name: 'PreviewPane.tsx', kind: 'file', sizeBytes: 5940,
    preview: `/** 共享预览：房间、线程、私信、文件树用的是同一个预览器（§17.9）。
 *  只有一处版本徽标与来源行，不再各写一套。 */
export function PreviewPane({ context, quoteTarget }: PreviewPaneProps) {
  const res = useSelectedResource(context);
  return <section className="preview-pane">{renderContent(res)}</section>;
}
`,
  },
  {
    path: 'src/components/Sidebar.tsx', name: 'Sidebar.tsx', kind: 'file', sizeBytes: 7380,
    preview: `/** 三段式侧栏：上四固定入口 → 项目区滚动 → 下两固定入口。
    项目区的状态提示分三类：名称前状态、行尾蓝点、数字徽标。 */
export function Sidebar() {
  return (
    <nav className="sidebar">
      <SidebarTop />
      <div className="sidebar-scroll">{projects.map(renderProject)}</div>
      <SidebarFoot />
    </nav>
  );
}
`,
  },
  {
    path: 'src/components/TitleBar.tsx', name: 'TitleBar.tsx', kind: 'file', sizeBytes: 2860,
    preview: `/** 自绘标题栏（Electron frame:false）：窗口控制 + 折叠侧栏 + 运行状态。
 *  2026-09-25 顶栏整条删除后，原来的项目菜单与搜索都搬到了侧栏。 */
export function TitleBar() {
  return <header className="titlebar">{/* 折叠 / 运行状态 / 最小化 / 最大化 / 关闭 */}</header>;
}
`,
  },
  {
    path: 'src/data', name: 'data', kind: 'dir',
  },
  {
    path: 'src/data/actions.ts', name: 'actions.ts', kind: 'file', sizeBytes: 9820,
    preview: `/** 写动作：每个动作都要留下"谁改的、改了什么"的痕迹（§15）。 */
export function revertChangeSet(changeSetId: string) {
  const cs = getState().changeSets.find((c) => c.id === changeSetId);
  if (!cs) return;
  // 带版本检查的撤销：文件必须仍匹配 after_ref，否则不做无条件还原
  recordWrite('changeset.revert', 'expectedAfterRef=' + cs.afterRef);
}
`,
  },
  {
    path: 'src/data/actions-git.ts', name: 'actions-git.ts', kind: 'file', sizeBytes: 8140,
    preview: `/** git.* 写操作（内存）。
 *  底线：不 stash / 不 reset --hard / 不自动提交用户原有改动。 */
export function stageByOwner(projectId: string, filter: { taskId?: string }) {
  // userPreExisting 的文件即使匹配 taskId 也不进批量暂存（§14.2）
}
`,
  },
  {
    path: 'src/data/seeds-core.ts', name: 'seeds-core.ts', kind: 'file', sizeBytes: 41_200,
    preview: `/** 种子：项目、成员、房间、线程、任务、运行、成果、改动集。
 *  跨文件的自洽约束写在每个种子文件头部，改一处要同时检查另一处。 */
export const changeSets: ChangeSet[] = [/* ... */];
`,
  },
  {
    path: 'src/data/seeds-git.ts', name: 'seeds-git.ts', kind: 'file', sizeBytes: 26_800,
    preview: `/** Git 种子：HEAD 是 3c91d2e，与 changeSets[0].beforeRef 一致；
 *  工作区必须包含改动集里声明"未提交"的那几个文件。 */
export const gitStates: Record<string, GitState> = { /* ... */ };
`,
  },
  {
    path: 'src/data/selectors.ts', name: 'selectors.ts', kind: 'file', sizeBytes: 6180,
    preview: `/** 派生数据集中在这里：组件不各自算一遍，避免同一条规则两处实现。 */
export function lockOfProject(s: State, projectId: string) {
  return s.locks.find((l) => l.projectId === projectId && l.state === 'held');
}
`,
  },
  {
    path: 'src/data/store.ts', name: 'store.ts', kind: 'file', sizeBytes: 9640,
    preview: `/** 内存 store：原型不落库，刷新即回到种子。 */
export function setState(updater: (s: State) => State) {
  state = updater(state);
  listeners.forEach((l) => l());
}
export function recordWrite(op: string, detail: string) { /* 写留痕 */ }
`,
  },
  {
    path: 'src/data/types.ts', name: 'types.ts', kind: 'file', sizeBytes: 38_400,
    preview: `/** 契约层：实体与命令面都在这里，界面不自己发明字段。
 *  ChangeSet.applicationStatus 只表示"文件是否已应用"；
 *  人工验收一律来自 TaskDelivery（§10.5），两者不能互相冒充。 */
export interface ChangeSet { /* ... */ }
`,
  },
  {
    path: 'src/lib', name: 'lib', kind: 'dir',
  },
  {
    path: 'src/lib/format.ts', name: 'format.ts', kind: 'file', sizeBytes: 3120,
    preview: `/** 展示格式：时间、字节、短路径。中文名走 NFC 归一化，
 *  否则从 macOS 传来的 NFD 文件名在列表里会显示成问号。 */
export function shortName(path: string) {
  const name = path.split('/').pop() ?? path;
  return name.normalize('NFC');
}
`,
  },
  {
    path: 'src/lib/router.ts', name: 'router.ts', kind: 'file', sizeBytes: 2380,
    preview: `/** 极简 hash 路由：navigate 只改 hash，订阅在 App 里统一处理。 */
export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) location.replace('#' + to);
  else location.hash = to;
}
`,
  },
  {
    path: 'src/lib/time.ts', name: 'time.ts', kind: 'file', sizeBytes: 1140,
    preview: `/** 相对时间：超过 7 天给绝对日期，避免"3 周前"这种算不清的表述。 */
export function relTime(at: number, now = Date.now()) {
  const diff = now - at;
  return diff > 7 * 86_400_000 ? new Date(at).toLocaleDateString() : humanize(diff);
}
`,
  },
  {
    path: 'src/contracts', name: 'contracts', kind: 'dir',
  },
  {
    path: 'src/contracts/events.ts', name: 'events.ts', kind: 'file', sizeBytes: 4210,
    preview: `/**
 * 规范化事件：把厂商事件类型收敛到本层，domain 不再引用 provider 联合类型。
 */
export type NormalizedEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string; input?: unknown }
  | { kind: 'done'; usage?: UsageRecord };
`,
  },
  {
    path: 'src/contracts/router.ts', name: 'router.ts', kind: 'file', sizeBytes: 1860,
    preview: `export type RouteMode = 'AUTO' | 'DIRECT' | 'DELIBERATE';

/** 路由由 @ 结构推导，不由界面控件单独决定 */
export function deriveRoute(mentions: string[], sendAs: 'ai' | 'record'):
  { mode: RouteMode; reason: string } {
  if (sendAs === 'record') return { mode: 'AUTO', reason: '仅记录：不唤醒 agent' };
  if (mentions.length === 0) return { mode: 'AUTO', reason: '无 @：由协调者接单' };
  if (mentions.length === 1) return { mode: 'DIRECT', reason: '单个结构化 @' };
  return { mode: 'DELIBERATE', reason: '@全体或多个明确 @' };
}
`,
  },
  {
    path: 'src/domain', name: 'domain', kind: 'dir',
  },
  {
    path: 'src/domain/task.ts', name: 'task.ts', kind: 'file', sizeBytes: 2740,
    preview: `export interface Task {
  id: string;
  projectId: string;
  status: TaskStatus;
  /** 创建时快照的验收策略，之后改项目设置不影响本任务 */
  reviewPolicy: 'user_review' | 'auto_deliver';
}
`,
  },
  {
    path: 'src/domain/usage.ts', name: 'usage.ts', kind: 'file', sizeBytes: 1980,
    preview: `/** 用量必须逐 turn 记录：预算判定读的是这里，不是消息里的自然语言。 */
export function sumUsage(run: WorkflowRun): UsageRecord {
  return run.turns.reduce(
    (acc, t) => ({ tokensIn: acc.tokensIn + t.tokensIn, tokensOut: acc.tokensOut + t.tokensOut }),
    { tokensIn: 0, tokensOut: 0 },
  );
}
`,
  },
  {
    path: 'src/domain/archive.ts', name: 'archive.ts', kind: 'file', sizeBytes: 1620,
    preview: `/** 归档只改变可写性，不把房间从导航里抹掉（只读 + 保留入口）。 */
export function archiveRoom(roomId: string) {
  patchRoom(roomId, { archived: true });
  recordWrite('room.archive', 'room=' + roomId + ' → 只读，仍可在侧栏定位');
}
`,
  },
  {
    path: 'src/domain/approval.ts', name: 'approval.ts', kind: 'file', sizeBytes: 2260,
    preview: `/** 授权卡：写操作需要显式授权，授权记录必须落库并可在活动页回溯。 */
export interface ApprovalCard {
  id: string;
  requestedBy: string;
  scope: 'write' | 'network' | 'spawn';
  decision: 'pending' | 'granted' | 'denied';
}
`,
  },
  {
    path: 'src/ui', name: 'ui', kind: 'dir',
  },
  {
    path: 'src/ui/Dashboard.tsx', name: 'Dashboard.tsx', kind: 'file', sizeBytes: 3120,
    preview: `export const TITLE = "众说 · 工作台";

export function Dashboard() {
  // 注意：此文件当前处于冲突状态（工作区里有标记冲突），
  // 冲突解决前不提供整文件一键覆盖（§14.2）。
  return <main>{TITLE}</main>;
}
`,
  },
  {
    // 空目录也要能展开/显示，不能因为"没有子节点"就从树里消失
    path: 'src/empty-placeholder', name: 'empty-placeholder', kind: 'dir', emptyDir: true,
  },
  {
    path: 'src/ui/MessageList.tsx', name: 'MessageList.tsx', kind: 'file', sizeBytes: 4280,
    preview: `/** 长会话按固定行高虚拟化：只渲染视口内的行，
 *  否则一次派发几十条消息就会卡住主线程。 */
export function MessageList({ messages }: { messages: Message[] }) {
  const [first, last] = visibleRange(scrollTop, viewportH, ROW_H);
  return <>{messages.slice(first, last).map((m) => <Row key={m.id} m={m} />)}</>;
}
`,
  },
  {
    path: 'src/ui/Board.tsx', name: 'Board.tsx', kind: 'file', sizeBytes: 6640,
    preview: `/** 看板：外层按项目分组、内层按状态分组。
 *  分组靠 projectId，不靠任务编号或房间名 —— 两个项目都有 #12 任务。 */
export function Board() {
  return <div className="board">{groupByProject(tasks).map(renderGroup)}</div>;
}
`,
  },
  {
    path: 'src/persistence', name: 'persistence', kind: 'dir',
  },
  {
    path: 'src/persistence/sqlite.ts', name: 'sqlite.ts', kind: 'file', sizeBytes: 5480,
    preview: `/** 本地库：线程、任务、改动记录与阅读水位都在这里。
 *  写入一律走事务；失败时保留原因，不静默吞掉。 */
export function withTx<T>(fn: (db: Db) => T): T {
  const tx = begin();
  try { const r = fn(tx); tx.commit(); return r; } catch (e) { tx.rollback(); throw e; }
}
`,
  },
  {
    path: 'src/persistence/migrations', name: 'migrations', kind: 'dir',
  },
  {
    path: 'src/persistence/migrations/0001_init.sql', name: '0001_init.sql', kind: 'file', sizeBytes: 2340,
    preview: `CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  root_path     TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  is_git        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_projects_root ON projects(root_path);
`,
  },
  {
    path: 'src/persistence/migrations/0002_threads.sql', name: '0002_threads.sql', kind: 'file', sizeBytes: 1860,
    preview: `CREATE TABLE threads (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  task_id    TEXT REFERENCES tasks(id),
  revision   INTEGER NOT NULL DEFAULT 0
);
-- 阅读水位按 (thread_id, member_id) 唯一
CREATE TABLE thread_read_states (
  thread_id  TEXT NOT NULL, member_id TEXT NOT NULL, read_seq INTEGER NOT NULL,
  PRIMARY KEY (thread_id, member_id)
);
`,
  },
  {
    path: 'src/runtime', name: 'runtime', kind: 'dir',
  },
  {
    path: 'src/runtime/dispatch.ts', name: 'dispatch.ts', kind: 'file', sizeBytes: 3920,
    preview: `/** 派发：幂等键必须带尝试次数，重跑的第二次不能被当成重复请求丢掉。 */
export function dispatchKey(input: DispatchInput): string {
  const attempt = input.attempt ?? 1;
  return [input.runId, input.turnId, input.memberId, attempt].join(':');
}
`,
  },
  {
    path: 'src/runtime/budget.ts', name: 'budget.ts', kind: 'file', sizeBytes: 2760,
    preview: `/** 预算：达到上限即停止后续派发，已产生的文件不回收（停止 ≠ 撤销）。 */
export function withinBudget(run: WorkflowRun): boolean {
  return sumUsage(run).tokensOut < run.budget.tokensOut;
}
`,
  },
  {
    path: 'src/runtime/lock.ts', name: 'lock.ts', kind: 'file', sizeBytes: 3180,
    preview: `/** 目录锁：锁域 = 同一物理目录。锁被占时写操作排队，不并发绕开单写者。 */
export function acquire(projectId: string, taskId: string): Lock | null {
  const held = getState().locks.find((l) => l.projectId === projectId && l.state === 'held');
  return held ? null : record({ projectId, taskId, state: 'held' });
}
`,
  },
  {
    /**
     * 长文件（2026-09-26 补数据）：预览区自己有滚动条（`.preview-body` 是
     * `overflow:auto`），但树里所有 preview 都只有几行 —— 预览滚动永远测不到。
     * 这个文件给足 60 行，用来验证"预览区内部滚动 + 行号列不动"。
     */
    path: 'src/runtime/scheduler.ts', name: 'scheduler.ts', kind: 'file', sizeBytes: 9840,
    preview: `/**
 * 调度器（长文件示例：用来验证预览区自己的滚动）。
 *
 * 职责边界：
 *  - 只决定"什么时候派发"，不关心模型怎么跑（那是 adapter 的事）
 *  - 派发一律经过 dispatchKey 幂等校验（重跑不能变成重复请求）
 *  - 达到预算上限即停止后续派发；停止不等于撤销，已产生的文件保留
 */
export type SchedulerEvent =
  | { kind: 'queued'; taskId: string }
  | { kind: 'dispatched'; taskId: string; turnId: string }
  | { kind: 'skipped'; taskId: string; reason: string }
  | { kind: 'blocked'; taskId: string; lockOwner: string }
  | { kind: 'stopped'; runId: string; reason: 'budget' | 'user' | 'failed' };

export interface SchedulerOptions {
  /** 同时派发的 turn 上限：超过就排队，不并发绕过单写者 */
  maxConcurrent: number;
  /** 单任务重试上限：重试也要带 attempt，幂等键因此不同 */
  maxAttempts: number;
}

const DEFAULTS: SchedulerOptions = { maxConcurrent: 2, maxAttempts: 3 };

export class Scheduler {
  private queue: string[] = [];
  private running = new Map<string, string>();

  constructor(private readonly opts: SchedulerOptions = DEFAULTS) {}

  enqueue(taskId: string): SchedulerEvent {
    if (this.queue.includes(taskId) || this.running.has(taskId)) {
      return { kind: 'skipped', taskId, reason: '已经在队列或执行中' };
    }
    this.queue.push(taskId);
    return { kind: 'queued', taskId };
  }

  /** 取下一个可派发项；锁被别的任务持有时不派发，也不静默丢弃 */
  next(projectId: string): SchedulerEvent | null {
    while (this.queue.length > 0) {
      const taskId = this.queue[0];

      if (this.running.size >= this.opts.maxConcurrent) {
        return { kind: 'skipped', taskId, reason: '并发已满，继续排队' };
      }

      const lock = acquire(projectId, taskId);
      if (!lock) {
        const held = lockOfProject(getState(), projectId);
        // 不弹出、不静默重排：如实说明被谁挡住了，让用户自己决定
        return { kind: 'blocked', taskId, lockOwner: held?.ownerTaskLabel ?? '未知任务' };
      }

      this.queue.shift();
      const turnId = makeTurnId(taskId);
      this.running.set(taskId, turnId);
      return { kind: 'dispatched', taskId, turnId };
    }
    return null;
  }

  /** 一个 turn 结束：释放运行位与目录锁，然后看预算是否还允许继续 */
  finish(runId: string, taskId: string, tokensOut: number): SchedulerEvent {
    this.running.delete(taskId);
    release(projectIdOf(taskId), taskId);

    const run = getRun(runId);
    if (run && tokensOut + run.budget.usedOut >= run.budget.tokensOut) {
      // 停止：只取消后续派发，不回收已产生的文件（§10.4 / 停止 ≠ 撤销）
      this.queue = [];
      return { kind: 'stopped', runId, reason: 'budget' };
    }
    return { kind: 'skipped', taskId, reason: '本 turn 结束，继续下一个' };
  }

  /** 用户点停止：同样是取消后续派发，不是撤销 */
  stop(runId: string): SchedulerEvent {
    this.queue = [];
    this.running.clear();
    return { kind: 'stopped', runId, reason: 'user' };
  }

  /** 只读快照：看板与侧栏的运行状态都读它，不各自维护一份 */
  snapshot() {
    return {
      queued: [...this.queue],
      running: [...this.running.entries()].map(([taskId, turnId]) => ({ taskId, turnId })),
    };
  }
}
`,
  },
  {
    path: 'scripts', name: 'scripts', kind: 'dir',
  },
  {
    path: 'scripts/build-report.mjs', name: 'build-report.mjs', kind: 'file', sizeBytes: 2640,
    preview: `// 报告正文按 UTF-8 写盘，终端提示单独转码（中文路径兜底）。
import { writeFile } from 'node:fs/promises';
const outDir = resolve(fileURLToPath(pathToFileURL(process.argv[2] ?? 'dist')));
await writeFile(join(outDir, 'report.md'), md, 'utf8');
`,
  },
  {
    path: 'scripts/lib', name: 'lib', kind: 'dir',
  },
  {
    path: 'scripts/lib/paths.mjs', name: 'paths.mjs', kind: 'file', sizeBytes: 940,
    preview: `/** 路径先规范化再进 fs 调用：Windows 中文路径与盘符大小写都必须处理 */
export function normalize(p) {
  return p.replace(/\\\\/g, '/');
}
`,
  },
  {
    path: 'scripts/dev-server.mjs', name: 'dev-server.mjs', kind: 'file', sizeBytes: 1560,
    preview: `/** 开发服务器：端口从参数读，默认 5280；
 *  桌面调试端口（9333）必须错开，否则 CDP 会连到 Electron 窗口上。 */
const port = Number(process.argv[2] ?? 5280);
await startVite({ port });
`,
  },
  {
    // 任务 #13 待提交的验证脚本（与 Git 工作区对应）
    path: 'scripts/check-paths.mjs', name: 'check-paths.mjs', kind: 'file', sizeBytes: 1240,
    preview: `/** 自检：项目里所有 script 入口在有中文的路径下都能被解析。 */
import { pathToFileURL } from 'node:url';
for (const p of entryPoints) {
  await import(pathToFileURL(p).href);   // 解析失败即抛 ENOENT
}
`,
  },
  {
    path: 'fixtures', name: 'fixtures', kind: 'dir',
  },
  {
    // 大文件 / 二进制不假装能读（§4）
    path: 'fixtures/large-corpus.bin', name: 'large-corpus.bin', kind: 'file',
    sizeBytes: 214_748_364, notPreviewable: 'binary',
  },
  {
    path: 'assets', name: 'assets', kind: 'dir',
  },
  {
    path: 'assets/logo.png', name: 'logo.png', kind: 'file', sizeBytes: 48_210, notPreviewable: 'binary',
  },
  {
    path: 'assets/tray-icon.svg', name: 'tray-icon.svg', kind: 'file', sizeBytes: 1180,
    preview: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <!-- 托盘图标：单色，跟随系统主题反色 -->
  <circle cx="8" cy="8" r="6" fill="currentColor" />
</svg>
`,
  },
  {
    // 空目录同样要能显示（这是第二个：树里多个空目录更容易看出规则）
    path: 'templates', name: 'templates', kind: 'dir', emptyDir: true,
  },
  {
    path: 'tests', name: 'tests', kind: 'dir',
  },
  {
    path: 'tests/unit', name: 'unit', kind: 'dir',
  },
  {
    path: 'tests/unit/task_status.test.ts', name: 'task_status.test.ts', kind: 'file', sizeBytes: 2240,
    preview: `describe('任务状态机', () => {
  it('停止不等于撤销：停止后已产生的文件仍然存在', () => {
    stopTask(task.id);
    expect(filesOf(task)).toHaveLength(1);
  });
});
`,
  },
  {
    path: 'tests/unit/git_ops.test.ts', name: 'git_ops.test.ts', kind: 'file', sizeBytes: 3180,
    preview: `describe('git 写操作', () => {
  it('按任务暂存时跳过用户原有改动', () => {
    stageByOwner('proj_zs_01', { taskId: 'task_13' });
    expect(staged()).not.toContain('docs/README.md');
  });
});
`,
  },
  {
    path: 'tests/e2e', name: 'e2e', kind: 'dir',
  },
  {
    path: 'tests/e2e/thread_isolation.test.ts', name: 'thread_isolation.test.ts', kind: 'file', sizeBytes: 2860,
    preview: `it('两个项目的同号任务不会串线', async () => {
  const board = await openBoard('proj_zs_01');
  expect(board.cards('12')).toHaveLength(1);
  expect(board.cards('12')[0].projectId).toBe('proj_zs_01');
});
`,
  },
  {
    path: '.github', name: '.github', kind: 'dir',
  },
  {
    path: '.github/workflows', name: 'workflows', kind: 'dir',
  },
  {
    path: '.github/workflows/ci.yml', name: 'ci.yml', kind: 'file', sizeBytes: 1130,
    preview: `name: ci
on: [push, pull_request]
jobs:
  check:
    # 中文路径问题只在 Windows 上复现，所以不在 ubuntu 上跑
    runs-on: windows-latest
    steps: [checkout, setup-node, pnpm-test]
`,
  },
  {
    path: '.github/workflows/release.yml', name: 'release.yml', kind: 'file', sizeBytes: 860,
    preview: `name: release
on:
  push:
    tags: ['v*']
jobs:
  package:
    runs-on: windows-latest
    steps: [checkout, build, electron-builder]
`,
  },
  {
    path: 'package.json', name: 'package.json', kind: 'file', sizeBytes: 2140,
    preview: `{
  "name": "zhongshuo",
  "scripts": { "dev": "vite", "build": "vite build", "desktop": "electron ." },
  "devDependencies": { "electron": "33.x", "vite": "5.x" }
}
`,
  },
  {
    // 锁文件按"大文件"处理：不假装把几千行塞进预览
    path: 'pnpm-lock.yaml', name: 'pnpm-lock.yaml', kind: 'file',
    sizeBytes: 486_000, notPreviewable: 'too_large',
  },
  {
    path: 'tsconfig.json', name: 'tsconfig.json', kind: 'file', sizeBytes: 640,
    preview: `{
  "compilerOptions": { "strict": true, "moduleResolution": "bundler", "jsx": "react-jsx" },
  "include": ["src", "electron"]
}
`,
  },
  {
    path: 'vite.config.ts', name: 'vite.config.ts', kind: 'file', sizeBytes: 720,
    preview: `export default defineConfig({
  // 端口与 Electron 调试端口（9333）错开，避免 CDP 连错目标
  server: { port: 5280, strictPort: true },
});
`,
  },
  {
    path: '.gitignore', name: '.gitignore', kind: 'file', sizeBytes: 210,
    preview: `node_modules/
dist/
screenshots*/
archive/
*.local
`,
  },
  {
    path: 'docs', name: 'docs', kind: 'dir',
  },
  {
    path: 'docs/README.md', name: 'README.md', kind: 'file', sizeBytes: 780,
    preview: `# 众说

本地项目群聊多 Agent 协同工作台。

> 本节由你在任务 #13 开始前手动修改，不属于任务改动。
`,
  },
  {
    path: 'docs/zhongshuo-development-design-v1.md', name: 'zhongshuo-development-design-v1.md',
    kind: 'file', sizeBytes: 512_000, notPreviewable: 'too_large',
  },
  {
    path: 'docs/evo-log.md', name: 'evo-log.md', kind: 'file', sizeBytes: 5480,
    preview: `# 演化日志

## 2026-09-20
- 私信沿用房间三模式，以参与者为可见范围。

## 2026-09-25
- 仓库初始化并推送远端；截图与 dist 不入库。
`,
  },
  {
    // 任务 #13 待提交的修复说明（与 Git 工作区对应）
    path: 'docs/path-fix-note.md', name: 'path-fix-note.md', kind: 'file', sizeBytes: 980,
    preview: `# 中文路径修复说明

复现：项目路径含中文时 build 脚本报 ENOENT。
修复：路径先进 pathToFileURL / fileURLToPath 规范化。
验证：scripts/check-paths.mjs 全绿（见任务 #13 验证记录）。
`,
  },
  {
    path: 'docs/weekly', name: 'weekly', kind: 'dir',
  },
  {
    path: 'docs/weekly/2026-W38.md', name: '2026-W38.md', kind: 'file', sizeBytes: 3180,
    preview: `# 第 38 周演化日志（2026-09-14 ~ 2026-09-20）

## 完成
- 可选任务验收（§10.5）：项目开关控制，关闭时满足交付要求即完成

## 下周
- 导航与管理页重排
`,
  },
  {
    path: 'docs/weekly/2026-W39.md', name: '2026-W39.md', kind: 'file', sizeBytes: 4260,
    preview: `# 第 39 周演化日志（2026-09-21 ~ 2026-09-26）

## 完成
- 文件与 Git 合页：三层结构收敛为一条滚动轴
- 侧栏状态提示统一：状态位 / 蓝点 / 数字徽标

## 受阻
- Windows 中文路径：已定位，改动待验收（任务 #13）
`,
  },
  {
    path: 'docs/notes', name: 'notes', kind: 'dir',
  },
  {
    path: 'docs/notes/2026-09-02-lock-domain.md', name: '2026-09-02-lock-domain.md', kind: 'file', sizeBytes: 1920,
    preview: `# 目录锁域判定

结论：锁域 = 同一物理目录（realpath 之后比较）。两个项目指向同一目录时算一把锁，
否则会出现"两个任务同时写一个目录"的假隔离。
`,
  },
  {
    path: 'docs/notes/2026-09-24-keyboard.md', name: '2026-09-24-keyboard.md', kind: 'file', sizeBytes: 1460,
    preview: `# 键盘可达性笔记

- 浮层只认真实 mousedown / Esc：click 会被拖动误触发。
- 只加 disabled 不算禁用，得同时挡住提交路径。
`,
  },
  {
    path: 'docs/notes/2026-09-18-path-incident.md', name: '2026-09-18-path-incident.md', kind: 'file', sizeBytes: 2260,
    preview: `# 中文路径事故复盘

现象：Windows 中文路径导致 ENOENT。
根因：未先规范化路径就进入 fs 调用。
改进：路径先规范化再进 fs；报告正文按 UTF-8 写盘，终端提示单独转码。
`,
  },
  {
    // 第三个空目录：树里多放几个，方便一眼看出"空目录"规则是统一的
    path: 'docs/drafts', name: 'drafts', kind: 'dir', emptyDir: true,
  },
];

/** data-backfill：结构与众说不同，用来证明树是按项目取的 */
const TREE_BACKFILL: MockFileNode[] = [
  { path: 'etl', name: 'etl', kind: 'dir' },
  {
    path: 'etl/backfill-orders.py', name: 'backfill-orders.py', kind: 'file', sizeBytes: 3640,
    preview: `BATCH_SIZE = 50_000

def run(conn, checkpoint: int) -> int:
    """按 updated_at 水位分批；断点写入 etl_checkpoint，重跑从水位续。"""
    cur = conn.cursor()
    cur.execute(SELECT_SQL, (checkpoint, BATCH_SIZE))
    rows = cur.fetchall()
    cur.executemany(INSERT_SQL, rows)   # ON CONFLICT DO NOTHING → 幂等
    return len(rows)
`,
  },
  { path: 'etl/checkpoint.sql', name: 'checkpoint.sql', kind: 'file', sizeBytes: 420,
    preview: `CREATE TABLE IF NOT EXISTS etl_checkpoint (
  job       TEXT PRIMARY KEY,
  watermark TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
` },
  { path: 'tests', name: 'tests', kind: 'dir' },
  { path: 'tests/test_backfill.py', name: 'test_backfill.py', kind: 'file', sizeBytes: 1180,
    preview: `def test_idempotent(conn):
    run(conn, 0)
    before = count(conn)
    run(conn, 0)          # 再跑一遍
    assert count(conn) == before, "重跑不应重复写入"
` },
  /* 2026-09-26 补数据：第二个项目也要有纵深，切换项目后别又只剩一屏 */
  { path: 'etl/lib', name: 'lib', kind: 'dir' },
  { path: 'etl/lib/db.py', name: 'db.py', kind: 'file', sizeBytes: 2480,
    preview: `def connect(dsn: str):
    """单连接、显式事务：回填靠事务边界保证可重跑。"""
    conn = sqlite3.connect(dsn, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn
` },
  { path: 'etl/lib/logger.py', name: 'logger.py', kind: 'file', sizeBytes: 1120,
    preview: `def log_batch(job: str, watermark: str, rows: int) -> None:
    print(f"[{job}] watermark={watermark} rows={rows}", flush=True)
` },
  { path: 'ops', name: 'ops', kind: 'dir' },
  { path: 'ops/runbook.md', name: 'runbook.md', kind: 'file', sizeBytes: 2640,
    preview: `# 回填操作手册

1. 停写窗口：先停上游写入，避免水位漂移。
2. 断点续跑：直接重跑同一命令，脚本从 etl_checkpoint 续。
3. 对账：跑完之后比对行数与最近 updated_at。
` },
  { path: 'ops/checks.sql', name: 'checks.sql', kind: 'file', sizeBytes: 980,
    preview: `-- 幂等自检：同一水位跑两次，行数必须一致
SELECT COUNT(*) FROM orders WHERE updated_at >= :watermark;
` },
  { path: 'pyproject.toml', name: 'pyproject.toml', kind: 'file', sizeBytes: 640,
    preview: `[project]
name = "orders-backfill"
requires-python = ">=3.11"
dependencies = ["psycopg[binary]>=3.1"]
` },
];

/** docs 项目：目录失效，树取不到内容（§17.7：目录失效要有明确状态） */
const TREE_MISSING: MockFileNode[] = [];

/**
 * notes-vault：**非 Git 且目录正常**的项目（§9.4 专用）。
 * 它不是 Git 仓库，但文件树与预览必须照常可用 —— 版本控制的有无不改变
 * "能不能看项目里有什么"这件事。
 */
const TREE_NOTGIT: MockFileNode[] = [
  { path: 'docs', name: 'docs', kind: 'dir' },
  {
    path: 'docs/index.md', name: 'index.md', kind: 'file', sizeBytes: 1240,
    preview: `# 笔记索引

## 架构
- 2026-08-14 六边界与依赖方向.md
- 2026-09-02 目录锁域判定.md

## 排期
- 2026-09-10 M3 批次拆分.md

## 复盘
- 2026-09-18 中文路径事故复盘.md
`,
  },
  {
    path: 'docs/meetings', name: 'meetings', kind: 'dir',
  },
  {
    path: 'docs/meetings/2026-08-14-boundaries.md', name: '2026-08-14-boundaries.md', kind: 'file', sizeBytes: 3180,
    preview: `# 六边界与依赖方向

结论：domain 不得直接引用 provider 联合类型，一律经 contracts 规范化。

待办：核对 persistence 是否被 ui 直接引用（已由任务复核）。
`,
  },
  {
    path: 'docs/meetings/2026-09-18-path-incident.md', name: '2026-09-18-path-incident.md', kind: 'file', sizeBytes: 2260,
    preview: `# 中文路径事故复盘

现象：Windows 中文路径导致 ENOENT。
根因：未先规范化路径就进入 fs 调用。
改进：路径先规范化再进 fs；报告正文按 UTF-8 写盘，终端提示单独转码。
`,
  },
  {
    // 非 Git 项目里也可能有二进制附件
    path: 'attachments', name: 'attachments', kind: 'dir',
  },
  {
    path: 'attachments/whiteboard.png', name: 'whiteboard.png', kind: 'file',
    sizeBytes: 1_842_000, notPreviewable: 'binary',
  },
  {
    // 空目录同样要能显示
    path: 'inbox', name: 'inbox', kind: 'dir', emptyDir: true,
  },
  /* 2026-09-26 补数据：非 Git 项目也要有纵深（树长不长与有没有版本控制无关） */
  {
    path: 'docs/architecture', name: 'architecture', kind: 'dir',
  },
  {
    path: 'docs/architecture/2026-08-02-six-boundaries.md', name: '2026-08-02-six-boundaries.md', kind: 'file', sizeBytes: 4120,
    preview: `# 六边界

ui → app → domain → contracts；adapter 与 persistence 只依赖 contracts。
反向引用一律视为违规，由测试守住。
`,
  },
  {
    path: 'docs/architecture/2026-09-10-batch-split.md', name: '2026-09-10-batch-split.md', kind: 'file', sizeBytes: 2860,
    preview: `# M3 批次拆分

按"可独立验收"拆分，一个批次一件事；跨批次的依赖必须显式登记。
`,
  },
  {
    path: 'docs/plans', name: 'plans', kind: 'dir',
  },
  {
    path: 'docs/plans/2026-09-26-roadmap.md', name: '2026-09-26-roadmap.md', kind: 'file', sizeBytes: 3340,
    preview: `# 路线图（草稿）

- M4：文件与 Git 合页收尾（README 与验证脚本同步）
- M5：可观测性（活动页筛选）
`,
  },
  {
    path: 'README.md', name: 'README.md', kind: 'file', sizeBytes: 520,
    preview: `# notes-vault

个人笔记库：不是 Git 仓库，改动靠整目录快照做前像。
`,
  },
];

const TREES: Record<string, MockFileNode[]> = {
  proj_zs_01: TREE_ZS,
  proj_backfill_02: TREE_BACKFILL,
  proj_docs_03: TREE_MISSING,
  proj_notgit_04: TREE_NOTGIT,
};

export function mockTreeOf(projectId: string): MockFileNode[] {
  return TREES[projectId] ?? [];
}

/**
 * 把扁平节点列表整理成可渲染的树。
 * 只做一层父子归并：路径按 `/` 分段，父目录若未显式出现则补一个隐式目录，
 * 保证树不会因为数据里漏写目录节点而断掉。
 */
export interface TreeNode extends MockFileNode {
  children: TreeNode[];
  depth: number;
}

export function buildTree(nodes: MockFileNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const ensureDir = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const name = path.split('/').pop() ?? path;
    const dir: TreeNode = { path, name, kind: 'dir', children: [], depth: 0 };
    byPath.set(path, dir);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parentPath) ensureDir(parentPath).children.push(dir);
    else roots.push(dir);
    return dir;
  };

  for (const n of nodes) {
    const node: TreeNode = { ...n, children: [], depth: 0 };
    byPath.set(n.path, node);
    const parentPath = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
    if (parentPath) ensureDir(parentPath).children.push(node);
    else roots.push(node);
  }

  const assignDepth = (list: TreeNode[], depth: number) => {
    for (const n of list) {
      n.depth = depth;
      // 目录在前、文件在后，各自按名称排序（与常见文件管理器一致）
      n.children.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1);
      assignDepth(n.children, depth + 1);
    }
  };
  roots.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  assignDepth(roots, 0);
  return roots;
}

/** 文件大小展示。命名与 lib/format 的 formatBytes 区分，避免同名导入冲突。 */
export function fileSizeLabel(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
