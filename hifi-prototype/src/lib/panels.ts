/**
 * 覆盖式查看面板的解析与归属。
 *
 * 设计依据 §17.1：
 *   「右侧首先是完整任务回复串；成果、文件和活动是该串的附属 tab 或覆盖式查看面板。」
 *
 * 也就是说：任务详情、研讨详情、运行详情、成果预览这些**不是**独立页面，
 * 而是覆盖在当前房间之上的查看面板。点开它们不应该破坏房间、回复串和阅读位置，
 * 关闭后必须原样回到原处。
 *
 * 每个面板都能从自身实体推出它所属的房间与回复串，
 * 因此即使用户直接深链打开（没有"来路"），也能在正确的房间上叠加显示。
 */

import type { AppState } from '../data/types';
import { byId } from '../data/selectors';

export type PanelKind = 'task' | 'run' | 'deliberation' | 'artifact';

export interface PanelRef {
  kind: PanelKind;
  id: string;
}

/** 面板标题，用于覆盖层的头部与背板说明 */
export const PANEL_LABEL: Record<PanelKind, string> = {
  task: '任务详情',
  run: '运行详情',
  deliberation: '研讨详情',
  artifact: '成果预览',
};

/** 路由 → 面板引用。不是面板路由则返回 null */
export function resolvePanel(path: string): PanelRef | null {
  let m = path.match(/^\/task\/([^/]+)$/);
  if (m) return { kind: 'task', id: m[1] };
  m = path.match(/^\/run\/([^/]+)$/);
  if (m) return { kind: 'run', id: m[1] };
  m = path.match(/^\/deliberation\/([^/]+)$/);
  if (m) return { kind: 'deliberation', id: m[1] };
  m = path.match(/^\/artifact\/([^/]+)$/);
  if (m) return { kind: 'artifact', id: m[1] };
  return null;
}

/**
 * 解析线程直达链接 `#/thread/:threadId?message=:messageId`。
 *
 * §15.5 要求应用内路由含 `thread=:threadId&message=:messageId`；
 * §27.9 MSG-04 的「复制应用内链接」产出的就是这种地址。
 * 原实现生成 `zhongshuo://#/thread/...`，但路由表没有 /thread 分支，
 * 点开会落到欢迎页 —— 属于死链。这里补上解析，让它定位原线程并高亮该消息。
 */
export function resolveThreadLink(
  path: string,
  query: Record<string, string>,
): { threadId: string; messageId?: string } | null {
  const m = path.match(/^\/thread\/([^/]+)$/);
  if (!m) return null;
  return { threadId: m[1], messageId: query.message };
}

/** 面板路由对应的 hash（含 query） */
export function panelHash(panel: PanelRef): string {
  return `/${panel.kind}/${panel.id}`;
}

export interface BaseRoute {
  path: string;
  query: Record<string, string>;
  /** 面板底下垫着的房间名，用于背板文案 */
  roomId: string;
  threadId?: string;
}

/**
 * 由面板实体推出它所属的房间/线程。
 * 拿不到归属时返回 null —— 此时退化为独立页面显示，不做半真半假的叠加。
 */
export function baseRouteForPanel(s: AppState, panel: PanelRef): BaseRoute | null {
  switch (panel.kind) {
    case 'task': {
      const task = byId(s.tasks, panel.id);
      if (!task) return null;
      const thread = byId(s.threads, task.conversationThreadId);
      return roomRoute(task.projectId, task.roomId, thread?.id);
    }
    case 'run':
    case 'deliberation': {
      const run = byId(s.runs, panel.id);
      if (!run) return null;
      const task = byId(s.tasks, run.taskId);
      if (!task) return null;
      return roomRoute(task.projectId, task.roomId, run.threadId);
    }
    case 'artifact': {
      const art = byId(s.artifacts, panel.id);
      if (!art) return null;
      const thread = byId(s.threads, art.threadId);
      return roomRoute(art.projectId, thread?.roomId ?? '', thread?.id);
    }
    default:
      return null;
  }
}

function roomRoute(projectId: string, roomId: string, threadId?: string): BaseRoute | null {
  if (!roomId) return null;
  return {
    path: `/project/${projectId}/room/${roomId}`,
    query: threadId ? { thread: threadId } : {},
    roomId,
    threadId,
  };
}
