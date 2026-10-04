/**
 * 真实数据装载与写动作（H1 首包，第四十七轮修订）：正式命令 → 原型视图模型映射。
 *
 * 合同修正（review-r46 §3）：project.open 用 `{path}`；room_root target 带 `roomId`；
 * 房间名单经 `member.list({projectId, roomId})` 装载（room.memberIds=@ 候选唯一来源）；
 * mentions `all` → `{kind:'all'}`；历史 `created_at` 如实映射（不伪造当前时间）。
 *
 * 归属与水位（review-r46 §5）：装载代次+请求时项目身份双重门（迟到响应不误归新项目）；
 * markRead 仅前台+贴底+当前路由；读取失败写入 readErrors（保留旧快照，不冒充空态）。
 * 发送（review-r46 §4）：sendCommand 携带 Composer commandId，返回 ok/failed/unknown。
 */
import { command, sendCommand, bridge } from './bridge';
import type { BridgeOutcome } from './bridge';
import { setState, getState, toast, recordWrite, canMarkRead } from './data/store';
import type { HifiState } from './data/store';
import type { AppState, Message } from './data/types';

/* ---------- 正式响应的最小类型（真实形状字段子集——具体投影，不用 any） ---------- */
interface ProjectOpenData { project: { id: string; displayName: string; revision?: number } }
interface RoomListData { items: Array<{ id: string; name: string; conversationId: string }> }
interface RoomMembersData { items: Array<{ id: string; displayName: string; principalType: string; enabled: boolean }> }
interface PoolData { items: Array<{ threadId: string; taskId?: string; body?: { text?: string }; createdAt?: number; replyCount?: number; unread?: number; taskStatus?: string }> }
interface ConvListData { conversations: Array<{ conversationId: string; peerDisplayName?: string; title?: string | null; unread?: number; execState?: string; archivedAt?: number | null; lastMessagePreview?: string | null; projectId?: string }> }
interface HistoryMessage { id: string; createdAt?: number; created_at?: number; authorType?: string; author_type?: string; authorId?: string; author_id?: string; bodyJson?: string; body_json?: string; conversationSeq?: number; conversation_seq?: number }
interface HistoryData { messages: HistoryMessage[] }
export interface SendResult { taskId?: string; threadId?: string; disposition?: string }

const textOf = (m: HistoryMessage): string => {
  const raw = m.bodyJson ?? m.body_json;
  if (raw == null) return '';
  try { return ((JSON.parse(raw) ?? {}) as { text?: string }).text ?? ''; } catch { return String(raw); }
};
/** created_at 如实映射：响应没有则置 0（「未知」）并由呈现层标注，不用当前时间伪造。 */
const createdAtOf = (m: HistoryMessage): number => m.createdAt ?? m.created_at ?? 0;

/** 归属门：请求发起时的 (gen, projectId) 与当前状态一致才落盘。 */
function stillCurrent(gen: number, projectId: string): boolean {
  const s = getState();
  return s.loadGen === gen && s.activeProjectId === projectId;
}

/* ---------- 首启（有界等待，不靠 reload——review-r46 §5） ---------- */

export async function bootRemembered(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const s = getState();
    if (s.boot === 'ready' || s.boot === 'failed') return; // 已装载/用户已手动打开
    try {
      const remembered = await command<{ values: Record<string, string> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
      const path = remembered?.values?.['ui.autoOpenProjectPath'];
      if (typeof path === 'string' && path.length > 0) {
        if (getState().boot === 'ready' || getState().boot === 'failed') return;
        await openProjectByPath(path);
        return;
      }
    } catch { /* daemon 未就绪——继续有界轮询 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  setState((s) => (s.activeProjectId === '' ? { ...s, boot: 'failed', bootError: '60 秒内未取得服务端项目记忆——可手动打开文件夹或重试' } : s));
}

export async function pickAndOpenFolder(): Promise<void> {
  const dir = await bridge().pickFolder();
  if (dir == null) return;
  await openProjectByPath(dir).catch((e) => {
    toast(`打开项目失败：${(e as Error).message}`, 'error');
    setState((s) => ({ ...s, boot: 'failed', bootError: (e as Error).message }));
  });
}

export async function openProjectByPath(path: string): Promise<void> {
  // 代次在**请求入口**分配（review-r47 §4：旧 A 响应不得覆盖后来已打开的 B——先请求 A 延迟、
  // 再请求 B 完成，A 回来须被丢弃）。启动自动恢复同理不能覆盖手动打开。
  const gen = getState().loadGen + 1;
  setState((s) => ({ ...s, loadGen: gen, boot: 'ready', bootError: null }));
  const data = await command<ProjectOpenData>('project.open', { path }); // 正式合同：{path}
  if (getState().loadGen !== gen) return; // 期间有更新的打开请求——旧响应丢弃
  const p = data.project;
  recordWrite('project.open', `打开项目「${p.displayName}」`);
  setState((s) => ({
    ...s,
    loadGen: gen,
    projects: [{
      id: p.id, displayName: p.displayName, rootPath: path, canonicalPath: path, directoryIdentity: '',
      status: 'ok', revision: p.revision ?? 0, isGit: false,
    }],
    activeProjectId: p.id,
    visibleProjectIds: [p.id],
    expandedProjectIds: [p.id],
    roomPool: {}, dmHistory: {}, readErrors: {},
  }));
  try { localStorage.setItem('zs.lastProjectPath', path); } catch { /* 忽略 */ }
  await Promise.all([refreshMembers(), refreshRooms(), refreshDms()]);
}

export async function refreshMembers(): Promise<void> {
  const gen = getState().loadGen;
  const projectId = getState().activeProjectId;
  if (projectId === '') return;
  const data = await command<RoomMembersData>('member.list', { projectId });
  if (!stillCurrent(gen, projectId)) return; // 迟到响应：项目已切走——丢弃（review-r46 §5 反例）
  setState((prev) => ({
    ...prev,
    members: (data.items ?? []).map((m) => ({
      id: m.id, projectId, profileId: '', displayName: m.displayName, enabled: m.enabled,
      principalType: m.principalType,
      workState: 'idle' as const, model: '', effort: 'medium' as const, internalSubagents: false, isCoordinatorDefault: false,
    })),
  }));
}

export async function refreshRooms(): Promise<void> {
  const gen = getState().loadGen;
  const projectId = getState().activeProjectId;
  if (projectId === '') return;
  const data = await command<RoomListData>('room.list', { projectId });
  if (!stillCurrent(gen, projectId)) return;
  const rooms = data.items ?? [];
  // 房间名单（@ 候选唯一来源——review-r46 §3）：每房间 member.list({projectId, roomId})。
  // 读取失败**保留旧名单**并就地报错（review-r47 §5——不呈现成「暂无成员」）；协调者不伪造
  // （取首个成员不是服务端事实——置空，呈现层不依赖）。
  const rosterErrors: Record<string, string> = {};
  const rosters = await Promise.all(rooms.map(async (r) => {
    try {
      const roster = await command<RoomMembersData>('member.list', { projectId, roomId: r.id });
      return { roomId: r.id, memberIds: (roster.items ?? []).filter((m) => m.enabled).map((m) => m.id) };
    } catch (e) {
      rosterErrors[`roster:${r.id}`] = (e as Error).message;
      const oldRoom = getState().rooms.find((x) => x.id === r.id);
      return { roomId: r.id, memberIds: oldRoom?.memberIds ?? [] }; // 旧名单兜底
    }
  }));
  if (!stillCurrent(gen, projectId)) return;
  setState((prev) => ({
    ...prev,
    rooms: rooms.map((r, i) => {
      const oldRoom = prev.rooms.find((x) => x.id === r.id);
      const roster = rosters[i];
      const failed = rosterErrors[`roster:${r.id}`] != null;
      return {
        id: r.id, projectId, name: r.name, conversationId: r.conversationId,
        coordinatorMemberId: failed ? (oldRoom?.coordinatorMemberId ?? '') : '',
        memberIds: roster?.memberIds ?? [],
        revision: 0, unread: 0,
      };
    }),
    readErrors: { ...prev.readErrors, ...rosterErrors },
  }));
}

export async function refreshDms(): Promise<void> {
  const gen = getState().loadGen;
  const projectId = getState().activeProjectId;
  if (projectId === '') return;
  const data = await command<ConvListData>('conversation.list', { projectId });
  if (!stillCurrent(gen, projectId)) return;
  setState((prev) => ({
    ...prev,
    dms: (data.conversations ?? []).map((c) => ({
      id: c.conversationId, projectId: c.projectId ?? projectId,
      peerDisplayName: c.peerDisplayName ?? '成员', title: c.title ?? '', unread: c.unread ?? 0,
      memberIds: [], threadId: '', createdAt: 0, lastMessageAt: 0,
      execState: c.execState ?? 'idle', archivedAt: c.archivedAt ?? undefined, lastMessagePreview: c.lastMessagePreview ?? '',
    })),
  }));
}

/* ---------- 快照装载（读失败≠空态：保留旧快照+readErrors） ---------- */

export async function loadRoomPool(roomId: string): Promise<void> {
  const gen = getState().loadGen;
  const projectId = getState().activeProjectId;
  const room = getState().rooms.find((r) => r.id === roomId);
  if (room == null) return;
  try {
    const data = await command<PoolData>('room.pool', { roomId, limit: 50 });
    if (!stillCurrent(gen, projectId)) return;
    const msgs: Message[] = (data.items ?? []).map((it) => ({
      id: `root-${it.threadId}`, projectId, roomId, threadId: it.threadId, taskId: it.taskId,
      authorType: 'human', authorId: 'me', kind: 'text', body: it.body?.text ?? '',
      createdAt: it.createdAt ?? 0, attachmentIds: [],
    }));
    setState((prev) => {
      const errors = { ...prev.readErrors }; delete errors[roomId];
      return { ...prev, roomPool: { ...prev.roomPool, [roomId]: msgs }, readErrors: errors };
    });
  } catch (e) {
    if (!stillCurrent(gen, projectId)) return;
    const msg = (e as Error).message;
    setState((prev) => ({ ...prev, readErrors: { ...prev.readErrors, [roomId]: msg } }));
  }
}

export async function loadDmHistory(conversationId: string, opts: { markRead?: boolean } = {}): Promise<void> {
  const gen = getState().loadGen;
  const projectId = getState().activeProjectId;
  try {
    const data = await command<HistoryData>('conversation.history', { conversationId, limit: 100 });
    if (!stillCurrent(gen, projectId)) return;
    const conv = getState().dms.find((d) => d.id === conversationId);
    const msgs: Message[] = (data.messages ?? []).map((m, i) => ({
      id: m.id, projectId, roomId: `dm:${conversationId}`,
      authorType: (m.authorType ?? m.author_type ?? 'system') as Message['authorType'],
      authorId: m.authorId ?? m.author_id ?? '', kind: 'text', body: textOf(m),
      createdAt: createdAtOf(m), threadMessageSeq: m.conversationSeq ?? m.conversation_seq ?? i,
      attachmentIds: [],
    }));
    setState((prev) => {
      const errors = { ...prev.readErrors }; delete errors[conversationId];
      return { ...prev, dmHistory: { ...prev.dmHistory, [conversationId]: msgs }, readErrors: errors };
    });
    // 已读水位（统一门——review-r47 §4）：缓存写入与阅读水位分开；**发起点此刻**重查
    // store.readGate（当前会话+前台/焦点+贴底+接管——页面注册，缺省拒绝），不信任请求前快照。
    if (opts.markRead === true && conv != null && (conv.unread ?? 0) > 0 && canMarkRead(conversationId)) {
      const last = (data.messages ?? [])[(data.messages ?? []).length - 1];
      const lastSeq = last ? (last.conversationSeq ?? last.conversation_seq) : undefined;
      if (lastSeq != null) {
        void command('conversation.markRead', { conversationId, throughMessageSeq: lastSeq })
          .then(() => { if (stillCurrent(gen, projectId)) return refreshDms().catch(() => { /* 归属已变/库关闭——下次再进 */ }); })
          .catch(() => { /* 下次进入再推进 */ });
      }
    }
  } catch (e) {
    if (!stillCurrent(gen, projectId)) return;
    setState((prev) => ({ ...prev, readErrors: { ...prev.readErrors, [conversationId]: (e as Error).message } }));
  }
}

/** 正式侧消息扩展说明：呈现用序号走原型 Message.threadMessageSeq；无额外下划线字段。 */

/* ---------- 发送（正式异步合同：Composer commandId 贯通；ok/failed/unknown） ---------- */

const mentionPayload = (mentionIds: string[]): Array<{ kind: 'member'; memberId: string } | { kind: 'all' }> =>
  mentionIds.map((id) => (id === 'all' ? { kind: 'all' as const } : { kind: 'member' as const, memberId: id }));

/**
 * 唯一正式参数 builder（review-r48 §3）：发送前把**真正要发给 bridge 的完整请求**固化成
 * 不可变信封（原 commandId+完整 target（含 projectId/conversationId/roomId——不从 UI 目标
 * 重造）+body+intent+mentions）。等待/回执/重试/冻结都用这一份。
 */
export function buildRoomRootEnvelope(commandId: string, roomId: string, body: string, intent: 'default' | 'record_only', mentionIds: string[]): import('./data/store').PendingSendEnvelope {
  const s = getState();
  const room = s.rooms.find((r) => r.id === roomId);
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'room_root', projectId: s.activeProjectId, conversationId: room?.conversationId ?? '', roomId },
      body, intent, mentions: mentionPayload(mentionIds),
    },
    targetLabel: `room:${roomId}`,
    at: Date.now(),
  };
}

export function buildDmEnvelope(commandId: string, conversationId: string, body: string, intent: 'default' | 'record_only'): import('./data/store').PendingSendEnvelope {
  const s = getState();
  return {
    commandId,
    method: 'message.submit',
    params: { target: { kind: 'dm', projectId: s.activeProjectId, conversationId }, body, intent, mentions: [] },
    targetLabel: `dm:${conversationId}`,
    at: Date.now(),
  };
}

/** 发送不可变信封（正式管道——重试与首次共用，保证同号同参）。 */
export async function sendEnvelope(env: import('./data/store').PendingSendEnvelope): Promise<BridgeOutcome<SendResult>> {
  const r = await sendCommand<SendResult>(env.commandId, env.method, env.params);
  if (r.status === 'ok') recordWrite('message.submit', `${env.params.target.kind === 'dm' ? '私信' : '房间'} ${env.params.intent === 'record_only' ? '仅记录' : '发送'}（${String(env.params.body).slice(0, 24)}…）`);
  return r;
}

export async function sendRoomRoot(commandId: string, roomId: string, body: string, intent: 'default' | 'record_only', mentionIds: string[]): Promise<BridgeOutcome<SendResult>> {
  const s = getState();
  const room = s.rooms.find((r) => r.id === roomId);
  if (room == null) return { status: 'failed', code: 'NO_ROOM', error: '房间不存在或尚未装载' };
  if (room.memberIds.length === 0 && intent === 'default') {
    return { status: 'failed', code: 'NO_MEMBERS', error: '该房间没有启用成员——无法派发（可先用「仅记录」保存）' };
  }
  return sendEnvelope(buildRoomRootEnvelope(commandId, roomId, body, intent, mentionIds));
}

export async function sendDmMessage(commandId: string, conversationId: string, body: string, intent: 'default' | 'record_only'): Promise<BridgeOutcome<SendResult>> {
  return sendEnvelope(buildDmEnvelope(commandId, conversationId, body, intent));
}

export async function createDm(memberId: string): Promise<string> {
  const s = getState();
  const r = await command<{ conversationId: string }>('conversation.create', { projectId: s.activeProjectId, peerMemberId: memberId });
  await refreshDms();
  return r.conversationId;
}

/** 结果未知信封的严格重发（review-r47 §2/r48 §3）：原 commandId+原参数逐字重发——不重组。 */
export async function retryUnknownSend(env: import('./data/store').PendingSendEnvelope): Promise<BridgeOutcome<SendResult>> {
  return sendEnvelope(env);
}
