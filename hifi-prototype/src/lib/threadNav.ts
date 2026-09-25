/**
 * 线程内的就地导航（§17.1 + 用户反馈）
 *
 * 设计取向：任务详情、研讨详情、运行详情、成果预览**都在回复串的 tab 里就地渲染**，
 * 不再有独立页面，也不再弹覆盖层。好处是点开详情不会丢掉房间、回复串与阅读位置。
 *
 * 因此"打开某个实体"这类动作不再是 `navigate('/task/xxx')`，而是
 * "切到该实体所属房间与线程，并选中对应 tab"。
 */

import type { AppState, ThreadTabKey } from '../data/types';
import { byId } from '../data/selectors';

/**
 * 回复串面板的 tab 取值。
 *
 * 定义已移到 `data/types.ts`：§17.9 的 `ContextTarget` 也要用它，
 * 而 types.ts 不 import 任何模块 —— 定义留在这里会造成
 * types ↔ threadNav 循环引用。此处转出，既有 import 路径不变。
 */
export type { ThreadTabKey };

export const THREAD_TABS: ThreadTabKey[] = [
  'replies',
  'artifacts',
  'activity',
  'members',
  'task',
  'delivery',
  'deliberation',
  'run',
];

export function isThreadTabKey(v: string | undefined): v is ThreadTabKey {
  return Boolean(v && (THREAD_TABS as string[]).includes(v));
}

/* ============================================================
   顶层视图与「详情」分组（界面信息减负施工任务书 §2 / §8）

   回复串原来有 8 个常驻页签（回复/成果/活动/成员/任务详情/交付/研讨详情/运行详情）。
   减负后常驻只剩三个视图，其余进「详情」的分组。

   URL 仍然沿用**既有 tab 键**（不新增、不改名）：
   界面从键推出顶层视图与分组，旧链接因此原样可用、前进/后退不用迁移，
   站内既有的 9 处 `?tab=…` 深链也不必逐个改写。
   ============================================================ */

/** 常驻顶层视图：回复 / 成果（讨论串为附件）/ 详情 */
export type ThreadView = 'replies' | 'artifacts' | 'details';

/** 「详情」内部的分组。默认概况，其余按需展开/定位 */
export type DetailsSection =
  | 'overview'
  | 'members'
  | 'activity'
  | 'run'
  | 'delivery'
  | 'deliberation';

/** 分组导航顺序（也是"自动展开/定位"的目标顺序） */
export const DETAILS_SECTIONS: DetailsSection[] = [
  'overview',
  'members',
  'activity',
  'run',
  'delivery',
  'deliberation',
];

/** 旧 tab 键 → 顶层视图（任务书 §8 映射表） */
export function viewOfTab(tab: ThreadTabKey): ThreadView {
  if (tab === 'replies') return 'replies';
  if (tab === 'artifacts') return 'artifacts';
  return 'details';
}

/** 旧 tab 键 → 详情分组；非详情键返回 undefined */
export function detailsSectionOfTab(tab: ThreadTabKey): DetailsSection | undefined {
  switch (tab) {
    case 'task': return 'overview';
    case 'members': return 'members';
    case 'activity': return 'activity';
    case 'run': return 'run';
    case 'delivery': return 'delivery';
    case 'deliberation': return 'deliberation';
    default: return undefined;
  }
}

/** 顶层视图（＋详情分组）→ 写回 URL 的 tab 键。保持既有键名，不迁移 URL */
export function tabFor(view: ThreadView, section: DetailsSection = 'overview'): ThreadTabKey {
  if (view === 'replies') return 'replies';
  if (view === 'artifacts') return 'artifacts';
  switch (section) {
    case 'members': return 'members';
    case 'activity': return 'activity';
    case 'run': return 'run';
    case 'delivery': return 'delivery';
    case 'deliberation': return 'deliberation';
    default: return 'task';
  }
}

export interface ThreadTarget {
  projectId: string;
  roomId: string;
  threadId: string;
  tab: ThreadTabKey;
  /** 成果 tab 内要就地打开的具体成果 */
  artifactId?: string;
}

/** 生成线程路由（带 tab / artifact 查询参数） */
export function threadHash(t: ThreadTarget): string {
  const q = new URLSearchParams();
  q.set('thread', t.threadId);
  if (t.tab !== 'replies') q.set('tab', t.tab);
  if (t.artifactId) q.set('artifact', t.artifactId);
  const qs = q.toString();
  return `/project/${t.projectId}/room/${t.roomId}${qs ? `?${qs}` : ''}`;
}

/* ---------- 由实体推出"该去哪" ---------- */

export function targetForTask(s: AppState, taskId: string): ThreadTarget | null {
  const task = byId(s.tasks, taskId);
  if (!task) return null;
  const thread = byId(s.threads, task.conversationThreadId);
  if (!thread) return null;
  return { projectId: task.projectId, roomId: task.roomId, threadId: thread.id, tab: 'task' };
}

export function targetForRun(s: AppState, runId: string): ThreadTarget | null {
  const run = byId(s.runs, runId);
  if (!run) return null;
  const task = byId(s.tasks, run.taskId);
  if (!task) return null;
  return {
    projectId: task.projectId,
    roomId: task.roomId,
    threadId: run.threadId,
    tab: 'run',
  };
}

export function targetForDeliberation(s: AppState, runId: string): ThreadTarget | null {
  const run = byId(s.runs, runId);
  if (!run) return null;
  const task = byId(s.tasks, run.taskId);
  if (!task) return null;
  return {
    projectId: task.projectId,
    roomId: task.roomId,
    threadId: run.threadId,
    tab: 'deliberation',
  };
}

export function targetForArtifact(s: AppState, artifactId: string): ThreadTarget | null {
  const art = byId(s.artifacts, artifactId);
  if (!art) return null;
  const thread = byId(s.threads, art.threadId);
  if (!thread) return null;
  return {
    projectId: art.projectId,
    roomId: thread.roomId,
    threadId: thread.id,
    tab: 'artifacts',
    artifactId,
  };
}

export function targetForThread(
  s: AppState,
  threadId: string,
  tab: ThreadTabKey = 'replies',
  artifactId?: string,
): ThreadTarget | null {
  const thread = byId(s.threads, threadId);
  if (!thread) return null;
  return { projectId: thread.projectId, roomId: thread.roomId, threadId, tab, artifactId };
}

/**
 * 旧深链兼容：`#/task/:id`、`#/run/:id`、`#/deliberation/:id`、`#/artifact/:id`
 * 以前会打开覆盖层或独立页面，现在统一重定向到"所属线程 + 对应 tab"，
 * 这样老链接仍然可用，且不再有弹窗。
 */
export function resolveLegacyDeepLink(s: AppState, path: string): ThreadTarget | null {
  let m = path.match(/^\/task\/([^/]+)$/);
  if (m) return targetForTask(s, m[1]);
  m = path.match(/^\/run\/([^/]+)$/);
  if (m) return targetForRun(s, m[1]);
  m = path.match(/^\/deliberation\/([^/]+)$/);
  if (m) return targetForDeliberation(s, m[1]);
  m = path.match(/^\/artifact\/([^/]+)$/);
  if (m) return targetForArtifact(s, m[1]);
  return null;
}

/** 线程直达链接 `#/thread/:id?message=:mid`（§15.5） */
export function resolveThreadLink(
  path: string,
  query: Record<string, string>,
): { threadId: string; messageId?: string } | null {
  const m = path.match(/^\/thread\/([^/]+)$/);
  if (!m) return null;
  return { threadId: m[1], messageId: query.message };
}
