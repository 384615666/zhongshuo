/**
 * 深链规范化（第五十一轮 H2，review-r50 §4）：正式深链族是 `#dm=`/`#task=`/`#delivery=`/
 * `#msg=`（与 daemon deepLink.resolve 同一形态）；hifi 内部路由是斜杠形态。本模块只做
 * 「外部 hash → 内部路由」的**纯映射**——实体身份以 deepLink.resolve 的服务端事实为准，
 * 不在前端猜归属；跨项目/前进后退/刷新都保留实体身份（内部路由可再解析）。
 */
import type { HifiState } from '../data/store';

/** 外部深链 hash 形态（与 src/daemon/commands.ts deepLink.resolve 同一正则口径）。 */
export const EXTERNAL_DEEP_LINK_RE = /^#?(dm|task|delivery|msg)=([A-Za-z0-9_:-]+)$/;

/** deepLink.resolve 的真实返回（各 kind 的可选字段按服务端实际返回）。 */
export interface ResolvedDeepLink {
  kind: 'dm' | 'task' | 'delivery' | 'msg';
  projectId: string;
  conversationId: string;
  rootPath?: string | null;
  threadId?: string | null;
  taskId?: string;
  deliveryId?: string;
  revision?: number;
  manifestHash?: string;
  messageId?: string;
  messageSeq?: number;
}

/** 外部 hash 是否属于深链族（App 据此分流——内部路由不进深链解析）。 */
export function isExternalDeepLink(hash: string): boolean {
  return EXTERNAL_DEEP_LINK_RE.test(hash.trim());
}

/**
 * 解析结果 → 内部路由。只读服务端事实+已装载状态；无落点返回 null（调用方如实报错，
 * 不静默跳转）。任务/交付定位到线程「详情」（任务概况+交付与验收——R51 首版落点）。
 */
export function routeForResolved(res: ResolvedDeepLink, s: HifiState): string | null {
  if (res.kind === 'dm') return `/dm/${res.conversationId}`;
  if (res.kind === 'task' || res.kind === 'delivery') {
    if (res.threadId != null && res.threadId.length > 0) return `/thread/${res.threadId}?tab=task`;
    // DM 任务（dm_turn）无线程——落回会话本身。
    return `/dm/${res.conversationId}`;
  }
  // msg：线程内消息 → 线程回复视图+定位；顶层消息 → 所属房间主池或私信会话。
  if (res.threadId != null && res.threadId.length > 0) {
    return `/thread/${res.threadId}${res.messageId != null ? `?message=${res.messageId}` : ''}`;
  }
  const room = s.rooms.find((r) => r.conversationId === res.conversationId);
  if (room != null) return `/room/${room.id}`;
  return `/dm/${res.conversationId}`;
}
