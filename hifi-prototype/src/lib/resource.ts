/**
 * 资源解析与渲染器分发（UX-PREVIEW-01 / §17.9）。
 *
 * 这是"共享预览"的**唯一数据入口**：所有打开文件的入口
 * （主池消息、线程成果、房间文件、项目文件树、DM）都先把
 * "某个东西"解析成一个 `PreviewResource` + 固定版本，
 * 再交给同一个预览器渲染。不允许各页面自己造预览壳
 * （§17.9 第 2 条、施工说明 §6）。
 *
 * 设计要点：
 *  1. **渲染器按内容 kind 分发，不按扩展名猜** —— 扩展名会骗人，
 *     而 §8.1 的格式矩阵是按真实内容类型定义的。
 *  2. **归属校验在这里做**（§8.3）：`origin` 决定资源属于谁，
 *     `audience` 决定谁能看。二者都不由调用方传入的 projectId 决定。
 *  3. 原型只用内存 mock；真实实现要接 `file.read` 等命令面（§15.2 待补）。
 */

import type {
  AppState, ContextLocation, ContextTarget, DraftReference, PreviewResource,
  PreviewTab, ResourceAudience, ResourceContent, ResourceRevision, ReturnSnapshot,
} from '../data/types';
import { byId } from '../data/selectors';

/* ============================================================
   查询
   ============================================================ */

export function resourceOf(s: AppState, id: string | undefined) {
  return byId(s.resources, id);
}

/** 某条消息携带的资源（按 ordinal 排序） */
export function attachmentsOfMessage(s: AppState, messageId: string) {
  return s.messageAttachments
    .filter((a) => a.messageId === messageId)
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * 取资源的指定版本；版本不存在时返回 undefined ——
 * **不静默回退到最新版**（§6.2：不能用旧版本名展示新内容）。
 */
export function revisionOf(
  resource: PreviewResource,
  revision: number,
): ResourceRevision | undefined {
  return resource.revisions.find((r) => r.revision === revision);
}

/** 资源的最新版本号（工作区"当前文件"用；成果快照应始终显式指定版本） */
export function latestRevisionOf(resource: PreviewResource): ResourceRevision | undefined {
  return resource.revisions.reduce<ResourceRevision | undefined>(
    (best, r) => (!best || r.revision > best.revision ? r : best),
    undefined,
  );
}

/**
 * 版本展示名（**全站唯一口径**，2026-09-24 统一）：
 *  · 固定交付/附件版本 → `v3`
 *  · 工作区读取快照   → `读取 r3`
 *
 * 为什么统一：以前标签写 `v3`、工具行写 `R3`、工作区写"读取于 14:20"，
 * 同一个东西三种写法，用户没法确认"这是不是同一版"。现在只有这一个函数产出
 * 版本文字，标签 / 文件信息共用；工具行不再重复显示（去重）。
 */
export function revisionLabel(resource: PreviewResource, revision: number): string {
  return resource.mutable ? `读取 r${revision}` : `v${revision}`;
}

/* ============================================================
   可见性（§17.9 第 7 条）
   ============================================================ */

/**
 * 判断某个 audience 是否允许当前上下文查看该资源。
 *
 * 关键：**同 projectId 不是共享许可**。私信附件不能被同项目的群聊看到，
 * 所以必须比较 audience 本身，而不是项目。
 */
export function audienceAllows(audience: ResourceAudience, target: ContextTarget): boolean {
  switch (audience.kind) {
    case 'project':
      // 项目工作区文件：项目成员可见（含文件/Git 工作区）
      return true;
    case 'room':
      // 房间资源：只有该房间（及其线程）能看；DM 与文件工作区看不到
      if (target.kind === 'room') return target.roomId === audience.roomId;
      if (target.kind === 'thread') return target.roomId === audience.roomId;
      return false;
    case 'dm':
      // 私信资源：只有同一个 conversationId 能看
      return target.kind === 'dm' && target.conversationId === audience.conversationId;
  }
}

/** audience 的可读描述，用于来源栏与"暂藏"提示 */
export function audienceLabel(s: AppState, audience: ResourceAudience): string {
  switch (audience.kind) {
    case 'project':
      return '项目工作区';
    case 'room': {
      const room = byId(s.rooms, audience.roomId);
      return room ? room.name : '未知房间';
    }
    case 'dm': {
      const dm = byId(s.dms, audience.conversationId);
      return dm ? `私信 · ${dm.title}` : '未知私信';
    }
  }
}

/**
 * 切换上下文时，哪些已打开的标签必须**暂藏**（§7.5 / PV-32）。
 *
 * 返回需要暂藏的标签 key：它们既不能显示正文，也不能在"已打开"列表里
 * 露出文件名和缩略图。
 */
export function tabsHiddenForContext(s: AppState, target: ContextTarget): string[] {
  return s.preview.tabs
    .filter((t) => {
      const res = resourceOf(s, t.resourceId);
      return res ? !audienceAllows(res.audience, target) : false;
    })
    .map((t) => t.key);
}

/* ============================================================
   标签身份
   ============================================================ */

/**
 * 标签 key = 资源身份 + 固定版本。
 *
 * 为什么不用 basename：同名不同路径/不同项目的文件不能合并
 * （§6.1、PV-07），所以必须含 projectId 与 resourceId。
 * 工作区资源用可变标记，让"重新读取"更新同一标签而不是新增。
 */
export function tabKeyFor(resource: PreviewResource, revision: number): string {
  const base = `${resource.projectId}:${resource.id}`;
  return resource.mutable ? base : `${base}:r${revision}`;
}

/* ============================================================
   来源描述（§6.3）
   ============================================================ */

/**
 * 「从…打开」是否**补充了新信息**（去重，2026-09-24）。
 *
 * 来源行同时回答两个问题：这份文件**属于哪里**（origin）、**我从哪里点开**（openedFrom）。
 * 当两者指向同一处时（最典型：主池附件的 origin 与 openedFrom 都是"开发大厅"），
 * 原来会写成"来源：开发大厅 · 某人的消息 · 从 开发大厅 主池消息 打开"，同一句话说两遍。
 *
 * 现在只在真的换了位置时补这一段：跨房间、跨会话、或从搜索/收藏结果进来。
 */
export function openedFromAddsInfo(
  s: AppState,
  resource: PreviewResource,
  from: ContextLocation,
): boolean {
  if (from.fromSearch) return true; // 搜索/收藏结果 → 值得说明来路
  const originRoomId =
    resource.origin.kind === 'task' || resource.origin.kind === 'message'
      ? resource.origin.roomId
      : undefined;
  const fromRoomId = (() => {
    if (from.target.kind === 'room') return from.target.roomId;
    if (from.target.kind === 'thread') return byId(s.threads, from.target.threadId)?.roomId;
    return undefined;
  })();
  if (originRoomId && fromRoomId) return originRoomId !== fromRoomId;
  if (resource.origin.kind === 'dm' && from.target.kind === 'dm') {
    return resource.origin.conversationId !== from.target.conversationId;
  }
  // 工作区文件从文件列表打开：两边都已经是"项目工作区"，不必重复
  if (resource.origin.kind === 'workspace' && from.target.kind === 'files') return false;
  return true;
}

/**
 * 来源栏要同时回答：**这份文件属于哪里**（origin）
 * 和 **我从哪里点开的**（openedFrom）。二者可以不同。
 */
export function originLabel(s: AppState, resource: PreviewResource): string {
  const o = resource.origin;
  switch (o.kind) {
    case 'task': {
      const task = byId(s.tasks, o.taskId);
      const room = byId(s.rooms, o.roomId);
      const n = task?.roomTaskNumber;
      return `${room?.name ?? '房间'} › ${n ? `#${n} ` : ''}${task?.title ?? '任务'}`;
    }
    case 'message': {
      const room = byId(s.rooms, o.roomId);
      // 无任务归属的普通附件：如实写"某某的消息"，不补一个假任务号（§4.4）
      return o.threadId
        ? `${room?.name ?? '房间'} › 串内消息`
        : `${room?.name ?? '房间'} · 某人的消息`;
    }
    case 'dm': {
      const dm = byId(s.dms, o.conversationId);
      return `私信 · ${dm?.title ?? o.conversationId}`;
    }
    case 'workspace':
      return '项目工作区';
  }
}

/** openedFrom 的简短描述 */
export function openedFromLabel(s: AppState, from: ContextLocation): string {
  if (from.fromSearch) {
    return from.fromSearch.kind === 'search' ? '搜索结果' : '收藏结果';
  }
  const t = from.target;
  switch (t.kind) {
    case 'room': {
      const room = byId(s.rooms, t.roomId);
      return `${room?.name ?? '房间'}${from.messageId ? ' 主池消息' : ''}`;
    }
    case 'thread': {
      const task = s.tasks.find((x) => x.conversationThreadId === t.threadId);
      return `任务${task ? ` #${task.roomTaskNumber}` : ''} 回复串`;
    }
    case 'dm': {
      const dm = byId(s.dms, t.conversationId);
      return `私信 · ${dm?.title ?? ''}`;
    }
    case 'files':
      return t.view === 'git' ? 'Git 工作区' : '项目文件列表';
  }
}

/* ============================================================
   打开资源（唯一入口）
   ============================================================ */

/**
 * 打开一个资源版本，返回新的标签集合与活动 key。
 *
 * 去重规则（§6.1、PV-07）：同一资源同一版本已打开 → 激活原标签，
 * 不重复创建；同时**更新它的 openedFrom**（本次打开位置变了，
 * 真实 origin 不变 —— §6.1 第 7 条）。
 */
export function openTab(
  tabs: PreviewTab[],
  resource: PreviewResource,
  revision: number,
  openedFrom: ContextLocation,
  nextOrdinal: number,
): { tabs: PreviewTab[]; activeKey: string } {
  const key = tabKeyFor(resource, revision);
  const existing = tabs.find((t) => t.key === key);
  if (existing) {
    return {
      tabs: tabs.map((t) => (t.key === key ? { ...t, openedFrom } : t)),
      activeKey: key,
    };
  }
  const tab: PreviewTab = {
    key,
    resourceId: resource.id,
    revision,
    openedFrom,
    scrollTop: 0,
    ordinal: nextOrdinal,
    requestGeneration: 1,
  };
  return { tabs: [...tabs, tab], activeKey: key };
}

/**
 * 关闭一个标签（§4.5）：切到右邻，无右邻则左邻；
 * 关掉最后一个 → 标签为空（调用方据此退出预览）。
 */
export function closeTab(tabs: PreviewTab[], key: string): { tabs: PreviewTab[]; activeKey?: string } {
  const sorted = [...tabs].sort((a, b) => a.ordinal - b.ordinal);
  const idx = sorted.findIndex((t) => t.key === key);
  if (idx < 0) return { tabs, activeKey: undefined };
  const next = sorted.filter((t) => t.key !== key);
  if (next.length === 0) return { tabs: next, activeKey: undefined };
  // 右邻（原位置的下一项）→ 左邻
  const neighbor = next[Math.min(idx, next.length - 1)];
  return { tabs: next, activeKey: neighbor.key };
}

/* ============================================================
   引用（§7.3）
   ============================================================ */

/** 从资源版本构造结构化引用；固定 hash 与版本，不用"最新版" */
export function buildDraftReference(
  resource: PreviewResource,
  revision: ResourceRevision,
  excerpt?: string,
): DraftReference {
  return {
    resourceId: resource.id,
    revision: revision.revision,
    hash: revision.hash,
    title: resource.title,
    excerpt: excerpt ? excerpt.slice(0, 200) : undefined,
  };
}

/** 引用卡上显示的版本说明 */
export function referenceVersionLabel(resource: PreviewResource, revision: number): string {
  return resource.mutable ? `读取快照 v${revision}` : `v${revision}`;
}

/* ============================================================
   返回快照（§3.4）
   ============================================================ */

export function makeReturnSnapshot(
  target: ContextTarget,
  sizes: Record<string, number>,
): ReturnSnapshot {
  return { target, sizes: { ...sizes } };
}

/** 内容是否可渲染（决定是否显示"不支持"状态） */
export function isRenderable(content: ResourceContent): boolean {
  return content.kind !== 'unsupported';
}
