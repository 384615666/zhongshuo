/**
 * 串内导航：回复、成果与参与成员。
 * 旧任务/运行/活动/研讨链接保留解析，统一落到成员页；交付链接保留成果确认。
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

/** details 是内部兼容键；界面常驻入口显示「参与成员」。 */
export type ThreadView = 'replies' | 'artifacts' | 'details';

export type DetailsSection = 'members' | 'delivery';
export const DETAILS_SECTIONS: DetailsSection[] = ['members', 'delivery'];

/** 旧 tab 键 → 顶层视图（任务书 §8 映射表） */
export function viewOfTab(tab: ThreadTabKey): ThreadView {
  if (tab === 'replies') return 'replies';
  if (tab === 'artifacts') return 'artifacts';
  return 'details';
}

/** 旧详情链接落到成员页；交付链接继续保留成果确认入口。 */
export function detailsSectionOfTab(tab: ThreadTabKey): DetailsSection | undefined {
  switch (tab) {
    case 'task':
    case 'activity':
    case 'run':
    case 'deliberation':
    case 'members': return 'members';
    case 'delivery': return 'delivery';
    default: return undefined;
  }
}

/** 顶层视图写回既有 URL 键。 */
export function tabFor(view: ThreadView, section: DetailsSection = 'members'): ThreadTabKey {
  if (view === 'replies') return 'replies';
  if (view === 'artifacts') return 'artifacts';
  return section;
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
