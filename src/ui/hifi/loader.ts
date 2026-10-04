/**
 * 真实数据装载与写动作（H1 首包）：把正式命令响应映射为原型视图模型（types.ts 形状），
 * 写进真实 store。**只映射真实存在的字段；未接通集合保持空**。
 *
 * 命令面（均为既有正式合同，不新增）：app.settings.get / project.open / room.list /
 * member.list / room.pool / conversation.list / conversation.create / conversation.history /
 * conversation.markRead / message.submit（room_root / dm；intent=record_only）。
 */
import { command, bridge } from './bridge';
import { setState, getState, toast, recordWrite } from './data/store';

/* ---------- 命令响应的最小类型（真实形状的字段子集） ---------- */
interface ProjectOpenData { project: { id: string; displayName: string } }
interface RoomListData { items: Array<{ id: string; name: string; conversationId: string }> }
interface MemberListData { items: Array<{ id: string; displayName: string; principalType: string; enabled: boolean }> }
interface PoolData { items: Array<{ threadId: string; taskId?: string; body?: { text?: string }; createdAt?: number; replyCount?: number; unread?: number; taskStatus?: string }> }
interface ConvListData { conversations: Array<{ conversationId: string; peerDisplayName?: string; title?: string | null; unread?: number; execState?: string; archivedAt?: number | null; lastMessagePreview?: string | null; projectId?: string }> }
interface HistoryData { messages: Array<{ id: string; createdAt?: number; authorType?: string; author_type?: string; authorId?: string; author_id?: string; bodyJson?: string; body_json?: string; conversationSeq?: number; conversation_seq?: number }> }
export interface SendOutcome { taskId?: string; threadId?: string; disposition?: string }

const textOf = (m: HistoryData['messages'][number]): string => {
  const raw = m.bodyJson ?? m.body_json;
  if (raw == null) return '';
  try { return ((JSON.parse(raw) ?? {}) as { text?: string }).text ?? ''; } catch { return String(raw); }
};

/* ---------- 装载 ---------- */

export async function bootRemembered(): Promise<void> {
  try {
    const remembered = await command<{ values: Record<string, string> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
    const path = remembered?.values?.['ui.autoOpenProjectPath'];
    if (typeof path === 'string' && path.length > 0) { await openProjectByPath(path); return; }
    setState((s) => ({ ...s, ui: { ...s.ui, booted: true } } as typeof s));
  } catch (e) {
    setState((s) => ({ ...s, ui: { ...s.ui, booted: true, bootError: String((e as Error).message) } } as typeof s));
  }
}

export async function pickAndOpenFolder(): Promise<void> {
  const dir = await bridge().pickFolder();
  if (dir == null) return;
  await openProjectByPath(dir);
}

export async function openProjectByPath(path: string): Promise<void> {
  const data = await command<ProjectOpenData>('project.open', { rootPath: path });
  const p = data.project;
  recordWrite('project.open', `打开项目「${p.displayName}」`);
  setState((s) => ({
    ...s,
    projects: [p],
    activeProjectId: p.id,
    visibleProjectIds: [p.id],
    expandedProjectIds: [p.id],
    ui: { ...s.ui, booted: true, bootError: null },
  } as typeof s));
  try { localStorage.setItem('zs.lastProjectPath', path); } catch { /* 忽略 */ }
  await Promise.all([refreshMembers(), refreshRooms(), refreshDms()]);
}

export async function refreshMembers(): Promise<void> {
  const s = getState();
  if (s.activeProjectId === '') return;
  const data = await command<MemberListData>('member.list', { projectId: s.activeProjectId });
  setState((prev) => ({
    ...prev,
    members: (data.items ?? []).filter((m) => m.enabled).map((m) => ({
      id: m.id, displayName: m.displayName, principalType: m.principalType, enabled: true, projectId: prev.activeProjectId,
    })),
  } as typeof prev));
}

export async function refreshRooms(): Promise<void> {
  const s = getState();
  if (s.activeProjectId === '') return;
  const data = await command<RoomListData>('room.list', { projectId: s.activeProjectId });
  setState((prev) => ({
    ...prev,
    rooms: (data.items ?? []).map((r) => ({ id: r.id, name: r.name, conversationId: r.conversationId, projectId: prev.activeProjectId })),
  } as typeof prev));
}

export async function refreshDms(): Promise<void> {
  const s = getState();
  if (s.activeProjectId === '') return;
  const data = await command<ConvListData>('conversation.list', { projectId: s.activeProjectId });
  setState((prev) => ({
    ...prev,
    dms: (data.conversations ?? []).map((c) => ({
      id: c.conversationId, conversationId: c.conversationId, projectId: c.projectId ?? prev.activeProjectId,
      peerDisplayName: c.peerDisplayName ?? '成员', title: c.title ?? null, unread: c.unread ?? 0,
      execState: c.execState ?? 'idle', archivedAt: c.archivedAt ?? null, lastMessagePreview: c.lastMessagePreview ?? null,
    })),
  } as typeof prev));
}

export async function loadRoomPool(roomId: string): Promise<void> {
  const room = getState().rooms.find((r) => r.id === roomId);
  if (room == null) return;
  const data = await command<PoolData>('room.pool', { roomId, limit: 50 });
  setState((prev) => {
    const msgs = (data.items ?? []).map((it, i) => ({
      id: `root-${it.threadId}`, authorType: 'human', body: it.body?.text ?? '', createdAt: it.createdAt ?? Date.now() - i * 60_000,
      roomId, threadId: it.threadId, taskId: it.taskId ?? null, replyCount: it.replyCount ?? 0, unread: it.unread ?? 0,
      taskStatus: it.taskStatus ?? null, seq: i,
    }));
    return { ...prev, roomPool: { ...prev.roomPool, [roomId]: msgs } } as typeof prev;
  });
}

export async function loadDmHistory(conversationId: string): Promise<void> {
  const data = await command<HistoryData>('conversation.history', { conversationId, limit: 100 });
  const conv = getState().dms.find((d) => d.conversationId === conversationId);
  setState((prev) => {
    const msgs = (data.messages ?? []).map((m, i) => ({
      id: m.id, authorType: (m.authorType ?? m.author_type ?? 'system') as string,
      authorId: m.authorId ?? m.author_id ?? null,
      body: textOf(m),
      createdAt: m.createdAt ?? Date.now() - i * 60_000, dmId: conversationId,
      seq: m.conversationSeq ?? m.conversation_seq ?? i,
    }));
    return { ...prev, dmHistory: { ...prev.dmHistory, [conversationId]: msgs } } as typeof prev;
  });
  // 已读水位（贴底读取即推进——与服务端合同一致；失败不阻塞呈现）
  const lastSeq = (data.messages ?? []).length > 0
    ? ((data.messages ?? [])[(data.messages ?? []).length - 1]!).conversationSeq ?? ((data.messages ?? [])[(data.messages ?? []).length - 1]!).conversation_seq
    : undefined;
  if (conv != null && (conv.unread ?? 0) > 0 && lastSeq != null) {
    void command('conversation.markRead', { conversationId, throughMessageSeq: lastSeq })
      .then(() => refreshDms())
      .catch(() => { /* 已读推进失败下次再试 */ });
  }
}

/* ---------- 写动作（真实命令；附件未接通——携带附件的提交明确拒绝） ---------- */

function rejectAttachments(attachments: Array<{ name: string; size: number }>): boolean {
  return attachments != null && attachments.length > 0;
}

export async function sendRoomRoot(roomId: string, body: string, intent: 'default' | 'record_only', mentionIds: string[], attachments: Array<{ name: string; size: number }>): Promise<SendOutcome> {
  if (rejectAttachments(attachments)) { toast('附件发送尚未接入正式链（H2）——本包请用纯文本发送', 'warn'); throw new Error('ATTACHMENTS_NOT_PORTED'); }
  const s = getState();
  const room = s.rooms.find((r) => r.id === roomId);
  if (room == null) throw new Error('房间不存在');
  const r = await command<SendOutcome>('message.submit', {
    target: { kind: 'room_root', projectId: s.activeProjectId, conversationId: room.conversationId },
    body, intent,
    mentions: mentionIds.map((id) => ({ kind: 'member', memberId: id })),
  });
  recordWrite('message.submit', `房间「${room.name}」${intent === 'record_only' ? '仅记录' : '发送'}（${body.slice(0, 24)}…）`);
  await loadRoomPool(roomId);
  return r;
}

export async function sendDmMessage(conversationId: string, body: string, intent: 'default' | 'record_only', attachments: Array<{ name: string; size: number }>): Promise<SendOutcome> {
  if (rejectAttachments(attachments)) { toast('附件发送尚未接入正式链（H2）——本包请用纯文本发送', 'warn'); throw new Error('ATTACHMENTS_NOT_PORTED'); }
  const s = getState();
  const r = await command<SendOutcome>('message.submit', {
    target: { kind: 'dm', projectId: s.activeProjectId, conversationId },
    body, intent, mentions: [],
  });
  recordWrite('message.submit', `私信 ${intent === 'record_only' ? '仅记录' : '发送'}（${body.slice(0, 24)}…）`);
  await loadDmHistory(conversationId);
  return r;
}

export async function createDm(memberId: string): Promise<string> {
  const s = getState();
  const r = await command<{ conversationId: string }>('conversation.create', { projectId: s.activeProjectId, peerMemberId: memberId });
  await refreshDms();
  return r.conversationId;
}
