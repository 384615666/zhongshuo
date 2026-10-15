/**
 * 深链规范化（第五十一轮 H2，review-r50 §4）：正式深链族是 `#dm=`/`#task=`/`#delivery=`/
 * `#msg=`（与 daemon deepLink.resolve 同一形态）；hifi 内部路由是斜杠形态。本模块只做
 * 「外部 hash → 内部路由」的**纯映射**——实体身份以 deepLink.resolve 的服务端事实为准，
 * 不在前端猜归属；跨项目/前进后退/刷新都保留实体身份（内部路由可再解析）。
 */
interface DeepLinkState { rooms: Array<{id:string;conversationId?:string}>; dms:Array<{id:string}> }

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
  parentTaskId?:string|null;
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
 * 归属分列（review-r51 §3.1 修复）：DM 任务（无线程）只落 DM；房间会话按 conversationId
 * 匹配已装载房间落主池——**未知归属不得默认当 DM**（此前房间交付被错送到空私信页）。
 */
export function routeForResolved(res: ResolvedDeepLink, s: DeepLinkState): string | null {
  if (res.kind === 'dm') return `/dm/${res.conversationId}`;
  const roomOf = (conversationId: string) => s.rooms.find((r) => r.conversationId === conversationId);
  const isDmConversation = (conversationId: string) => s.dms.some((d) => d.id === conversationId);
  if (res.kind === 'task' || res.kind === 'delivery') {
    if (res.threadId != null && res.threadId.length > 0) return `/thread/${res.threadId}?tab=task${res.parentTaskId&&res.taskId?`&task=${encodeURIComponent(res.taskId)}${res.kind==='delivery'&&res.deliveryId?`&delivery=${encodeURIComponent(res.deliveryId)}`:''}`:''}`;
    // 无线程：DM 任务（dm_turn）落会话；房间会话（异常形态）落主池；都查不到=无落点。
    if (isDmConversation(res.conversationId)) return `/dm/${res.conversationId}`;
    const room = roomOf(res.conversationId);
    if (room != null) return `/room/${room.id}`;
    return null;
  }
  // msg：线程内消息 → 线程回复视图+定位；顶层消息 → 所属房间主池或私信会话（同上分列）。
  if (res.threadId != null && res.threadId.length > 0) {
    return `/thread/${res.threadId}${res.messageId != null ? `?message=${res.messageId}` : ''}`;
  }
  const room = roomOf(res.conversationId);
  if (room != null) return `/room/${room.id}`;
  if (isDmConversation(res.conversationId)) return `/dm/${res.conversationId}`;
  return null;
}
