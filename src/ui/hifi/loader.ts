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
import { setState, getState, toast, recordWrite, canMarkRead, canMarkThreadRead, getDraftFull, setDraftFull as setDraftFullShim } from './data/store';
import type { HifiState, HifiDraftAttachment, ThreadTaskDetail } from './data/store';
import type { AppState, Message, Thread, ThreadCard } from './data/types';
import { routeForResolved, type ResolvedDeepLink } from './lib/deepLink';

/* ---------- 正式响应的最小类型（真实形状字段子集——具体投影，不用 any） ---------- */
interface ProjectOpenData { project: { id: string; displayName: string; revision?: number } }
interface RoomListData { items: Array<{ id: string; name: string; conversationId: string; coordinatorMemberId?: string | null }> }
interface RoomMembersData { items: Array<{ id: string; displayName: string; principalType: string; enabled: boolean }> }
interface PoolData { items: Array<{ threadId: string; anchorMessageId?: string; taskId?: string | null; taskStatus?: string | null; roomTaskNumber?: number | null; body?: { text?: string }; createdAt?: number; replyCount?: number; lastReplyAt?: number | null; unread?: number; muted?: boolean; followed?: boolean }> }
interface ConvListData { conversations: Array<{ conversationId: string; peerDisplayName?: string; title?: string | null; unread?: number; execState?: string; archivedAt?: number | null; lastMessagePreview?: string | null; projectId?: string; revision?: number; activeTaskId?: string | null; activeRunId?: string | null; activeStopGeneration?: number; interruptedTasks?: Array<{ taskId: string; title: string; lastRunStatus: string | null; lastRunId: string | null; recoverable: boolean; blockReason: string | null }>; pendingReview?: { taskId: string; deliveryId: string; revision: number; manifestHash: string } | null; reworkPending?: { taskId: string; deliveryRevision: number; note: string | null; queued: boolean } | null; queuedCount?: number; stopPending?: boolean }> }
interface HistoryMessage { id: string; createdAt?: number; created_at?: number; authorType?: string; author_type?: string; authorId?: string; author_id?: string; bodyJson?: string; body_json?: string; conversationSeq?: number; conversation_seq?: number; attachments?: Array<{ artifactId: string; filename: string; kind: string }> }
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
        try {
          if (getState().boot === 'ready' || getState().boot === 'failed') return;
          await openProjectByPath(path);
        } catch (e) {
          // r57：记忆路径失效≠服务未就绪——如实报错并保持可操作（选择其它目录/重试），
          // 不再被外层 catch 归类成「连接中」空转 60 秒。
          setState((st) => ({ ...st, boot: 'failed', bootError: `记忆的项目路径无法打开：${(e as Error).message}——可打开其它文件夹或修改「启动时打开的项目」` }));
        }
        return;
      }
      // r57：成功读到**空记忆**=正常无项目状态——立即就绪并显示欢迎/打开入口，
      // 不再继续等 60 秒后误报「启动失败」（空项目≠失败）。
      setState((st) => (st.activeProjectId === '' && st.boot === 'pending' ? { ...st, boot: 'ready' } : st));
      // 演练包竞态兜底：启动器窗口先于种子打开（种子晚写 autoOpen）——欢迎态下留一个
      // **有界后台观察**（不阻塞欢迎交互；用户手动打开后 watcher 自停）。真实新装环境
      // 种子不写该键，观察窗口自然结束、欢迎保持——不冒充失败。
      void (async () => {
        for (let i = 0; i < 75; i += 1) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = getState();
          // r58 P4：手动/显式打开在途同样让观察器停（不只看 activeProjectId——打开在途时
          // 它尚未落位，观察器此刻抢 openProjectByPath 会拿更高代次覆盖用户选择）。
          if (st.activeProjectId !== '' || st.boot === 'failed' || st.openInFlight) return; // 用户已打开/已失败/打开在途——停
          try {
            const again = await command<{ values: Record<string, string> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
            const p2 = again?.values?.['ui.autoOpenProjectPath'];
            if (typeof p2 === 'string' && p2.length > 0) {
              if (getState().activeProjectId !== '') return;
              await openProjectByPath(p2).catch(() => { /* 种子写入的路径异常：保持欢迎+如实控制台 */ });
              return;
            }
          } catch { /* 服务暂不可达——继续观察 */ }
        }
      })();
      return;
    } catch { /* 服务未就绪——有界重试；真不可达在窗口尽后如实报告 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  setState((s) => (s.activeProjectId === '' ? { ...s, boot: 'failed', bootError: '服务在 60 秒内未就绪——可重试，或直接打开文件夹' } : s));
}

export async function pickAndOpenFolder(): Promise<void> {
  const dir = await bridge().pickFolder();
  if (dir == null) return;
  await openProjectByPath(dir).catch((e) => {
    toast(`打开项目失败：${(e as Error).message}`, 'error');
    // r58 P4：已有项目在用时打开/切换失败**不降级启动态**——当前项目保持可用（错误走
    // toast）；boot:failed 只描述「首启无项目」场景，避免误导性失败横幅。
    setState((s) => (s.activeProjectId === '' ? { ...s, boot: 'failed', bootError: (e as Error).message } : s));
  });
}

export async function openProjectByPath(path: string): Promise<void> {
  // 代次在**请求入口**分配（review-r47 §4：旧 A 响应不得覆盖后来已打开的 B——先请求 A 延迟、
  // 再请求 B 完成，A 回来须被丢弃）。启动自动恢复同理不能覆盖手动打开。
  const gen = getState().loadGen + 1;
  setState((s) => ({ ...s, loadGen: gen, boot: 'ready', bootError: null, openInFlight: true }));
  try {
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
  } finally {
    // 在途结束（成功/失败/被取代）——按代次条件清：旧调用的收尾不清掉更新调用的标记。
    setState((s) => (s.openInFlight && s.loadGen === gen ? { ...s, openInFlight: false } : s));
  }
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
        coordinatorMemberId: r.coordinatorMemberId ?? (failed ? (oldRoom?.coordinatorMemberId ?? '') : ''),
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
      // r56 H4 操作面投影：revision CAS/停止三重绑定/中断恢复/待验收/排队数。
      revision: c.revision ?? 0,
      activeTaskId: c.activeTaskId ?? null, activeRunId: c.activeRunId ?? null, activeStopGeneration: c.activeStopGeneration ?? 0,
      interruptedTasks: c.interruptedTasks ?? [], pendingReview: c.pendingReview ?? null,
      reworkPending: c.reworkPending ?? null,
      queuedCount: c.queuedCount ?? 0, stopPending: c.stopPending ?? false,
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
    // 主池条目=线程卡（第五十一轮 H2）：room.pool 的真实投影——记录串 taskId=null（E1），
    // 不伪造任务标题；正文缺省空串由呈现层标注。
    const cards: ThreadCard[] = (data.items ?? []).map((it) => ({
      threadId: it.threadId, projectId, roomId,
      anchorMessageId: it.anchorMessageId ?? '',
      taskId: it.taskId ?? null, taskStatus: it.taskStatus ?? null, roomTaskNumber: it.roomTaskNumber ?? null,
      body: it.body?.text ?? '', createdAt: it.createdAt ?? 0,
      replyCount: it.replyCount ?? 0, lastReplyAt: it.lastReplyAt ?? null,
      unread: it.unread ?? 0, muted: it.muted === true, followed: it.followed === true,
    }));
    setState((prev) => {
      const errors = { ...prev.readErrors }; delete errors[roomId];
      return { ...prev, roomPool: { ...prev.roomPool, [roomId]: cards }, readErrors: errors };
    });
  } catch (e) {
    if (!stillCurrent(gen, projectId)) return;
    const msg = (e as Error).message;
    setState((prev) => ({ ...prev, readErrors: { ...prev.readErrors, [roomId]: msg } }));
  }
}

/* ---------- 线程视图（第五十一轮 H2：thread.get/thread.history/task.get 真实 DTO 适配） ---------- */

interface ThreadGetData {
  thread: { id: string; projectId: string; conversationId: string; roomId: string; anchorMessageId: string; rootTaskId: string | null; status: string; lastMessageSeq: number; revision: number };
  anchor: { id: string; authorType: string; authorId: string; body: { text: string }; createdAt: number; conversationSeq: number } | null;
  lastReadSeq: number;
}
interface ThreadHistoryItem { id: string; authorType: string; authorId: string; seq: number; body: { text: string }; createdAt: number; attachments?: Array<{ artifactId: string; filename: string; kind: string }> }
interface ThreadHistoryData { items: ThreadHistoryItem[]; rootAttachments: Array<{ artifactId: string; filename: string; kind: string }> }
interface TaskGetData {
  task: { id: string; title: string; status: string; room_id: string; conversation_thread_id: string | null; room_task_number: number; revision: number; stopGeneration: number };
  activeRun: { id: string; status: string } | null;
  pendingDelivery: { id: string; revision: number; manifest_hash: string } | null;
  reworkPending?: { deliveryRevision: number; note: string | null; queued: boolean } | null;
  lastStartupFailureMessage?: string;
}

const msgOfReply = (projectId: string, roomId: string, threadId: string, it: ThreadHistoryItem): Message => ({
  id: it.id, projectId, roomId, threadId, taskId: undefined,
  authorType: it.authorType as Message['authorType'], authorId: it.authorId, kind: 'text',
  body: it.body?.text ?? '', createdAt: it.createdAt, threadMessageSeq: it.seq,
  attachmentIds: [], formalAttachments: it.attachments ?? [],
});

/**
 * 装载线程视图：thread.get（实体+根消息+水位）→ thread.history（回复+根附件）→
 * task.get（有根任务才查）。readGate 独立水位：thread.markRead 只在**发起此刻**门通过才发
 * （当前线程+前台/贴底/接管——ThreadPage 注册；与 DM conversationSeq 门分开，review-r50 §4）。
 */
export async function loadThread(threadId: string, opts: { markRead?: boolean } = {}): Promise<void> {
  const gen = getState().loadGen;
  try {
    const got = await command<ThreadGetData>('thread.get', { threadId });
    const projectId = got.thread.projectId;
    if (!stillCurrent(gen, projectId)) return; // 项目已切走——丢弃迟到响应
    const thread = {
      id: got.thread.id, projectId, conversationId: got.thread.conversationId, roomId: got.thread.roomId,
      anchorMessageId: got.thread.anchorMessageId, rootTaskId: got.thread.rootTaskId ?? undefined,
      status: (got.thread.status === 'archived' ? 'archived' : 'open') as Thread['status'],
      lastMessageSeq: got.thread.lastMessageSeq, revision: got.thread.revision,
    };
    const anchor: Message | null = got.anchor == null ? null : {
      id: got.anchor.id, projectId, roomId: thread.roomId, threadId: undefined,
      authorType: got.anchor.authorType as Message['authorType'], authorId: got.anchor.authorId,
      kind: 'text', body: got.anchor.body?.text ?? '', createdAt: got.anchor.createdAt,
      attachmentIds: [],
    };
    setState((prev) => {
      const errors = { ...prev.readErrors }; delete errors[`thread:${threadId}`];
      return {
        ...prev,
        threadEntities: { ...prev.threadEntities, [threadId]: thread },
        threadAnchors: { ...prev.threadAnchors, [threadId]: anchor },
        threadReadSeq: { ...prev.threadReadSeq, [threadId]: got.lastReadSeq },
        readErrors: errors,
      };
    });
    const hist = await command<ThreadHistoryData>('thread.history', { threadId, limit: 100 });
    if (!stillCurrent(gen, projectId)) return;
    const replies = (hist.items ?? []).map((it) => msgOfReply(projectId, thread.roomId, threadId, it));
    // r56：**合并**而非整表替换——可见期轻量刷新（5s）会把补读出的更早历史整页冲掉
    //（长历史定位后元素消失）。按 id 去重合并、seq 升序，保留已补读窗口。
    setState((prev) => {
      const cur = prev.threadMessages[threadId] ?? [];
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of replies) byId.set(m.id, m);
      const merged = [...byId.values()].sort((a, b) => (a.threadMessageSeq ?? 0) - (b.threadMessageSeq ?? 0));
      return { ...prev, threadMessages: { ...prev.threadMessages, [threadId]: merged } };
    });    // 根附件挂到根消息（线程视图锚块芯片来源——rootAttachments 与 items 分列返回）。
    if ((hist.rootAttachments ?? []).length > 0 && anchor != null) {
      setState((prev) => ({
        ...prev,
        threadAnchors: { ...prev.threadAnchors, [threadId]: { ...(prev.threadAnchors[threadId] ?? anchor), formalAttachments: hist.rootAttachments } },
      }));
    }
    // 任务详情（记录串无根任务——不查不写键；「详情」分组如实显示记录串说明）。
    if (thread.rootTaskId != null) {
      const tg = await command<TaskGetData>('task.get', { taskId: thread.rootTaskId });
      if (!stillCurrent(gen, projectId)) return;
      const detail: ThreadTaskDetail = {
        id: tg.task.id, title: tg.task.title, status: tg.task.status, roomId: tg.task.room_id,
        threadId: tg.task.conversation_thread_id, roomTaskNumber: tg.task.room_task_number,
        revision: tg.task.revision, stopGeneration: tg.task.stopGeneration,
        activeRun: tg.activeRun, pendingDelivery: tg.pendingDelivery == null ? null
          : { id: tg.pendingDelivery.id, revision: tg.pendingDelivery.revision, manifestHash: tg.pendingDelivery.manifest_hash },
        reworkPending: tg.reworkPending ?? null,
        lastStartupFailureMessage: tg.lastStartupFailureMessage ?? null,
      };
      setState((prev) => ({ ...prev, threadTasks: { ...prev.threadTasks, [threadId]: detail } }));
    } else {
      setState((prev) => { const next = { ...prev.threadTasks }; delete next[threadId]; return { ...prev, threadTasks: next }; });
    }
    // 阅读水位（独立门）：最新回复 seq ≤ thread.lastMessageSeq（未来序号服务端拒绝）。
    const lastSeq = replies.length > 0 ? (replies[replies.length - 1]?.threadMessageSeq ?? 0) : 0;
    if (opts.markRead === true && lastSeq > got.lastReadSeq && canMarkThreadRead(threadId)) {
      void command('thread.markRead', { threadId, throughMessageSeq: lastSeq })
        .then(() => {
          if (!stillCurrent(gen, projectId)) return;
          setState((prev) => ({ ...prev, threadReadSeq: { ...prev.threadReadSeq, [threadId]: lastSeq } }));
          void loadRoomPool(thread.roomId).catch(() => { /* 主池未读汇总下次刷新再对 */ });
        })
        .catch(() => { /* 下次进入再推进 */ });
    }
  } catch (e) {
    const s = getState();
    // 归属未变才记错（迟到失败不污染当前线程）。
    if (s.threadEntities[threadId] == null || stillCurrent(gen, s.threadEntities[threadId]!.projectId)) {
      setState((prev) => ({ ...prev, readErrors: { ...prev.readErrors, [`thread:${threadId}`]: (e as Error).message } }));
    }
  }
}

/** 显式推进线程阅读水位（ThreadPage 贴底滚动时调用——发起此刻重查独立门；未来序号服务端拒）。 */
export async function markThreadReadIfAllowed(threadId: string): Promise<void> {
  const { canMarkThreadRead } = await import('./data/store');
  const s = getState();
  if (s.threadEntities[threadId] == null) return;
  const replies = s.threadMessages[threadId] ?? [];
  const lastSeq = replies.length > 0 ? (replies[replies.length - 1]?.threadMessageSeq ?? 0) : 0;
  const known = s.threadReadSeq[threadId] ?? 0;
  if (lastSeq > known && canMarkThreadRead(threadId)) {
    try {
      await command('thread.markRead', { threadId, throughMessageSeq: lastSeq });
      setState((prev) => ({ ...prev, threadReadSeq: { ...prev.threadReadSeq, [threadId]: lastSeq } }));
    } catch { /* 未来序号/门关——下次再推进 */ }
  }
}

/** 任务详情单项刷新（停止/验收后重查——绑定服务端当前事实）。 */
/** 长历史定位补读（r56 H4 §5）：thread.history beforeSeq 游标向前补一页（100 条），追加到
 * 已装载回复**头部**（保持 seq 升序）。返回补入条数（0=已到头/迟到丢弃）——调用方按此决定
 * 继续补读还是如实「未定位」。补读是纯读：不改水位（标读仍只在前台+贴底时发生）。 */
export async function loadThreadOlder(threadId: string, beforeSeq: number): Promise<number> {
  const gen = getState().loadGen;
  const ent = getState().threadEntities[threadId];
  if (ent == null) return 0;
  const hist = await command<ThreadHistoryData>('thread.history', { threadId, beforeSeq, limit: 100 });
  if (!stillCurrent(gen, ent.projectId)) return 0;
  const older = (hist.items ?? []).map((it) => msgOfReply(ent.projectId, ent.roomId, threadId, it));
  if (older.length === 0) return 0;
  setState((prev) => {
    const cur = prev.threadMessages[threadId] ?? [];
    const known = new Set(cur.map((m) => m.id));
    const fresh = older.filter((m) => !known.has(m.id));
    return { ...prev, threadMessages: { ...prev.threadMessages, [threadId]: [...fresh, ...cur] } };
  });
  return older.length;
}

export async function refreshThreadTask(threadId: string): Promise<void> {
  const s = getState();
  const thread = s.threadEntities[threadId];
  if (thread?.rootTaskId == null) return;
  const tg = await command<TaskGetData>('task.get', { taskId: thread.rootTaskId });
  const projectId = s.activeProjectId;
  if (!stillCurrent(s.loadGen, projectId)) return;
  const detail: ThreadTaskDetail = {
    id: tg.task.id, title: tg.task.title, status: tg.task.status, roomId: tg.task.room_id,
    threadId: tg.task.conversation_thread_id, roomTaskNumber: tg.task.room_task_number,
    revision: tg.task.revision, stopGeneration: tg.task.stopGeneration,
    activeRun: tg.activeRun, pendingDelivery: tg.pendingDelivery == null ? null
      : { id: tg.pendingDelivery.id, revision: tg.pendingDelivery.revision, manifestHash: tg.pendingDelivery.manifest_hash },
    reworkPending: tg.reworkPending ?? null,
    lastStartupFailureMessage: tg.lastStartupFailureMessage ?? null,
  };
  setState((prev) => ({ ...prev, threadTasks: { ...prev.threadTasks, [threadId]: detail } }));
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
      attachmentIds: [], formalAttachments: m.attachments ?? [],
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
 * 附件 refs（第五十一轮 H2）：只在 upload 回执明确成功后进入信封——信封不可变原则不变。
 */
export function buildRoomRootEnvelope(commandId: string, roomId: string, body: string, intent: 'default' | 'record_only', mentionIds: string[], attachmentRefs?: string[], opts?: { imageAck?: 'omit-images'; attachmentRanges?: Record<string, string> }): import('./data/store').PendingSendEnvelope {
  const s = getState();
  const room = s.rooms.find((r) => r.id === roomId);
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'room_root', projectId: s.activeProjectId, conversationId: room?.conversationId ?? '', roomId },
      body, intent, mentions: mentionPayload(mentionIds),
      ...(attachmentRefs != null && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      ...(opts?.imageAck != null ? { imageAck: opts.imageAck } : {}),
      ...(opts?.attachmentRanges != null ? { attachmentRanges: opts.attachmentRanges } : {}),
    },
    targetLabel: `room:${roomId}`,
    at: Date.now(),
  };
}

export function buildDmEnvelope(commandId: string, conversationId: string, body: string, intent: 'default' | 'record_only', attachmentRefs?: string[], opts?: { imageAck?: 'omit-images'; attachmentRanges?: Record<string, string> }): import('./data/store').PendingSendEnvelope {
  const s = getState();
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'dm', projectId: s.activeProjectId, conversationId }, body, intent, mentions: [],
      ...(attachmentRefs != null && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      ...(opts?.imageAck != null ? { imageAck: opts.imageAck } : {}),
      ...(opts?.attachmentRanges != null ? { attachmentRanges: opts.attachmentRanges } : {}),
    },
    targetLabel: `dm:${conversationId}`,
    at: Date.now(),
  };
}

/** 线程跟进信封（第五十一轮 H2）：目标=打开的线程（projectId/conversationId/threadId 来自
 * thread.get 实体——不从界面焦点重造）；记录串（rootTaskId 空）由服务端强制 record_only。 */
export function buildThreadEnvelope(commandId: string, threadId: string, body: string, intent: 'default' | 'record_only', attachmentRefs?: string[], opts?: { imageAck?: 'omit-images'; attachmentRanges?: Record<string, string> }): import('./data/store').PendingSendEnvelope {
  const s = getState();
  const thread = s.threadEntities[threadId];
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'thread', projectId: thread?.projectId ?? s.activeProjectId, conversationId: thread?.conversationId ?? '', threadId },
      body, intent, mentions: [],
      ...(attachmentRefs != null && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      ...(opts?.imageAck != null ? { imageAck: opts.imageAck } : {}),
      ...(opts?.attachmentRanges != null ? { attachmentRanges: opts.attachmentRanges } : {}),
    },
    targetLabel: `thread:${threadId}`,
    at: Date.now(),
  };
}

/**
 * 草稿附件 → 正式 refs（第五十二轮修订，review-r51 §2）：上传中/失败项拦截（store.uploadItems
 * 为真源）；refs 取**草稿里已就绪的 attachmentId 引用**（上传回执写入）。图片+派发意图不再硬拦
 * ——由 Composer 显式二选一（imageAck='omit-images' 一次性冻结进信封，或改仅记录）。
 */
export function attachmentRefsFromDraft(draftKey: string, intent: 'default' | 'record_only'): { refs?: string[]; hasImages?: boolean; blockError?: string } {
  const s = getState();
  const items = (s.uploadItems[draftKey] ?? []).filter((x) => x.removed !== true);
  const uploading = items.filter((x) => x.status === 'uploading');
  if (uploading.length > 0) return { blockError: `附件仍在上传（${uploading.map((x) => x.name).join('、')}）——完成后再发送` };
  const failed = items.filter((x) => x.status === 'failed');
  if (failed.length > 0) return { blockError: `有上传失败的附件（${failed.map((x) => x.name).join('、')}）——请移除或重选后再发送` };
  const d = getDraftFull(draftKey);
  const ready = d.attachments.filter((a) => a.attachmentId != null && a.attachmentId.length > 0);
  if (ready.length === 0) return {};
  return { refs: ready.map((a) => a.attachmentId), hasImages: intent === 'default' && ready.some((a) => a.kind === 'image_file') };
}

/** 表格注入范围（第五十二轮 §6.3）：草稿内已选范围 → attachmentRanges；缺省=服务端有界默认窗。 */
export function attachmentRangesFromDraft(draftKey: string): Record<string, string> | undefined {
  const d = getDraftFull(draftKey);
  const out: Record<string, string> = {};
  for (const a of d.attachments) if (a.range != null && a.range.length > 0) out[a.attachmentId] = a.range;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 为草稿内某附件设定注入范围（预览面板「用此窗口作注入范围」——只写草稿，信封在发送时冻结）。 */
export function setDraftAttachmentRange(draftKey: string, attachmentId: string, range: string): void {
  const d = getDraftFull(draftKey);
  setDraftFullShim(draftKey, { ...d, attachments: d.attachments.map((a) => (a.attachmentId === attachmentId ? { ...a, range } : a)) });
}

/* ---------- 任务动作（第五十一轮 H2）：停止绑定 run/代次；验收绑定交付三重身份 ---------- */

/** 停止任务：targetRunId/expectedStopGeneration 取自**已装载的任务详情**（服务端核对——
 * 过时绑定会被正式链拒绝，不静默套用到新 run）。 */
export async function stopThreadTask(threadId: string): Promise<{ ok: boolean; error?: string }> {
  const s = getState();
  const detail = s.threadTasks[threadId];
  if (detail == null) return { ok: false, error: '任务详情未装载——先打开详情刷新' };
  if (['DONE', 'CANCELLED'].includes(detail.status)) return { ok: false, error: `任务已终态（${detail.status}）——无可停止的执行` };
  if (detail.activeRun == null) return { ok: false, error: '当前没有活跃 run（任务可能已结束）' };
  try {
    await command('task.stop', { taskId: detail.id, targetRunId: detail.activeRun.id, expectedStopGeneration: detail.stopGeneration });
    recordWrite('task.stop', `停止任务 #${detail.roomTaskNumber}（run ${detail.activeRun.id}）`);
    await refreshThreadTask(threadId).catch(() => { /* 刷新失败保留旧详情并就地报错 */ });
    return { ok: true };
  } catch (e) {
    await refreshThreadTask(threadId).catch(() => { /* 停止失败后重查事实 */ });
    return { ok: false, error: (e as Error).message };
  }
}

/** 验收/返工快照（页面打开意见/验收框时冻结——目标变化不悄悄换稿，review-r44/45 同判）。 */
export interface ReviewSnapshot {
  taskId: string;
  deliveryId: string;
  deliveryRevision: number;
  manifestHash: string;
}

/** 提交验收：只带**冻结快照**的三重身份（id+revision+manifest_hash）——不重读当前 review；
 * 冲突（STALE_REVISION 等）如实上屏并刷新详情。 */
export async function submitTaskReview(snapshot: ReviewSnapshot, decision: 'accept' | 'changes_requested', note?: string, threadIdForRefresh?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('task.review', {
      taskId: snapshot.taskId, deliveryId: snapshot.deliveryId, deliveryRevision: snapshot.deliveryRevision,
      manifestHash: snapshot.manifestHash, decision, ...(decision === 'changes_requested' && note != null ? { note } : {}),
    });
    recordWrite('task.review', `${decision === 'accept' ? '验收通过' : '要求返工'}（交付 v${snapshot.deliveryRevision}）`);
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 详情下次进入刷新 */ });
    return { ok: true };
  } catch (e) {
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 冲突后重查事实 */ });
    return { ok: false, error: (e as Error).message };
  }
}

/** 执行返工（r58，验收与执行分离）：意见已由 task.review 入账；本入口只传任务号——
 * 意见/版本以服务端事实为准。入队成功后由轮询自然推进（新交付→再次待验收）。 */
export async function executeTaskRework(taskId: string, threadIdForRefresh?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('task.executeRework', { taskId, reason: '用户点击「执行返工」' });
    recordWrite('task.executeRework', `执行返工（任务 ${taskId.slice(0, 14)}…）`);
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 详情下次进入刷新 */ });
    return { ok: true };
  } catch (e) {
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 冲突后重查事实 */ });
    return { ok: false, error: (e as Error).message };
  }
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

/* ---------- 附件上传/预览适配（第五十一轮 H2 骨架——格式实际限制，服务端为最终裁决） ---------- */

/** 格式上限与 daemon 常量同源核对（UI 只做前置拦截；正式校验在服务端）：文本 256KB、图片
 * 8MB、PDF/Office 20MiB、CSV 5MB——不把 20MiB 当所有格式上限（review-r50 §4）。 */
export const ATTACHMENT_LIMITS = {
  text: 256 * 1024,
  image: 8 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  office: 20 * 1024 * 1024,
  csv: 5 * 1024 * 1024,
} as const;

const TEXT_EXTS = /\.(txt|md|markdown|json|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|sh|ps1|sql|html|css|xml|log|ini|cfg)$/i;
const OFFICE_EXTS = /\.(docx|xlsx|pptx)$/i;

export type AttachmentClass = { cls: 'text' | 'image' | 'pdf' | 'office' | 'csv' | 'unsupported'; reason?: string };

/** 分类+前置限幅（magic bytes 由服务端裁决——此处按扩展名给 UI 预判与说明）。 */
export function classifyAttachmentFile(name: string, size: number): AttachmentClass {
  const lower = name.toLowerCase();
  if (TEXT_EXTS.test(lower)) return size > ATTACHMENT_LIMITS.text ? { cls: 'unsupported', reason: `文本附件超过 ${ATTACHMENT_LIMITS.text / 1024}KB 上限` } : { cls: 'text' };
  if (/\.(png|jpe?g|gif|webp)$/.test(lower)) return size > ATTACHMENT_LIMITS.image ? { cls: 'unsupported', reason: `图片原件超过 ${ATTACHMENT_LIMITS.image / 1024 / 1024}MB 上限` } : { cls: 'image' };
  if (/\.(pdf)$/.test(lower)) return size > ATTACHMENT_LIMITS.pdf ? { cls: 'unsupported', reason: `PDF 超过 ${ATTACHMENT_LIMITS.pdf / 1024 / 1024}MiB 上限` } : { cls: 'pdf' };
  if (/\.(csv|tsv)$/.test(lower)) return size > ATTACHMENT_LIMITS.csv ? { cls: 'unsupported', reason: `CSV 超过 ${ATTACHMENT_LIMITS.csv / 1024 / 1024}MB 上限` } : { cls: 'csv' };
  if (OFFICE_EXTS.test(lower)) return size > ATTACHMENT_LIMITS.office ? { cls: 'unsupported', reason: `Office 原件超过 ${ATTACHMENT_LIMITS.office / 1024 / 1024}MiB 上限` } : { cls: 'office' };
  return { cls: 'unsupported', reason: '未接入的附件类型（文本/图片/PDF/Office/CSV 之外）' };
}

/** File→base64（arrayBuffer+btoa——Electron renderer 与 Node 测试环境双兼容，不依赖 FileReader）。 */
const fileToBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};

export interface UploadReceipt { attachmentId: string; hash: string; revision: number; kind: string }

/** 上传分类 → artifacts.kind（与 daemon kindForFilename 同口径的 UI 侧推导：code 扩展名=
 * code_file，其余文本=text_file；Office 按扩展名三类——服务端按内容嗅探为准）。 */
function kindOfClass(cls: AttachmentClass['cls'], name: string): string {
  const lower = name.toLowerCase();
  switch (cls) {
    case 'image': return 'image_file';
    case 'pdf': return 'pdf_file';
    case 'csv': return 'sheet_file';
    case 'office': return /\.(xlsx)$/.test(lower) ? 'sheet_file' : /\.(pptx)$/.test(lower) ? 'slides_file' : 'docx_file';
    default: return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|sh|ps1|sql)$/.test(lower) ? 'code_file' : 'text_file';
  }
}

/**
 * 上传一个附件到目标会话（回执绑定发起项目/会话——上传时 conversationId 必填，跨会话引用
 * 由服务端 audience 拒绝）。分类→前置限幅→对应 upload 命令；失败原样抛出（页面保留草稿）。
 * receipt.kind 为 UI 侧按同一分类推导（服务端按内容嗅探为准——门禁与展示用，不作归属事实）。
 */
export async function uploadAttachmentFile(conversationId: string, file: File): Promise<UploadReceipt> {
  const cls = classifyAttachmentFile(file.name, file.size);
  if (cls.cls === 'unsupported') throw new Error(cls.reason ?? '不支持的附件类型');
  if (cls.cls === 'text') {
    // 字节合同（review-r51 §5 修复）：不能用 File.text()——它把非法 UTF-8 字节替换成 U+FFFD
    // 后照样上传，服务端持久化有损副本（旧界面第 27 轮已修，换装不得回退）。读真实字节 +
    // fatal 解码：非法字节在此明确失败（零上传命令/零 artifact，草稿保留可换文件）。
    const buf = await file.arrayBuffer();
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new Error('内容不是合法 UTF-8 文本（检测到损坏字节）——请修正文件后重选（未上传任何内容）');
    }
    if (content.length === 0) throw new Error('文本内容为空——未上传');
    const r = await command<Omit<UploadReceipt, 'kind'>>('attachment.uploadText', { conversationId, filename: file.name, content });
    // uploadText 回执不含 revision——服务端事务固定首传 revision=1（artifacts 插入常量），
    // 按合同事实补默认；不为其它 upload* 猜值（它们各自回执字段以实际为准）。
    return { ...r, revision: r.revision ?? 1, kind: kindOfClass('text', file.name) };
  }
  const contentBase64 = await fileToBase64(file);
  const method = cls.cls === 'image' ? 'attachment.uploadImage' : cls.cls === 'pdf' ? 'attachment.uploadPdf' : cls.cls === 'csv' ? 'attachment.uploadCsv' : 'attachment.uploadOffice';
  const r = await command<Omit<UploadReceipt, 'kind'> & { bytes?: number }>(method, { conversationId, filename: file.name, contentBase64 });
  // 各 upload* 首传均为 artifacts 插入 revision=1（响应不带回执字段——按合同事实补默认，不为重传猜值）。
  return { attachmentId: r.attachmentId, hash: r.hash, revision: r.revision ?? 1, kind: kindOfClass(cls.cls, file.name) };
}

/** 文本/代码附件预览（骨架：真实 attachment.previewText——其余类型如实分列到原界面）。 */
export async function previewTextAttachment(attachmentId: string, conversationId: string): Promise<{ filename: string; kind: string; revision: number; text: string; truncated: boolean; originalBytes: number }> {
  return command('attachment.previewText', { attachmentId, conversationId });
}

/* ---------- 深链规范化（review-r50 §4：#dm=/#task=/#delivery=/#msg= → 内部路由） ---------- */

/**
 * 解析外部深链族（与 daemon deepLink.resolve 同一 hash 形态）并规范化为内部路由：
 * 跨项目先经 rootPath 打开真实项目（实体身份保留），再导航到对应页面；失败如实报错
 * （不静默跳转、不猜实体）。刷新/前进后退走内部路由（斜杠形态），不再进本函数。
 */
export async function openExternalDeepLink(hash: string): Promise<void> {
  const res = await command<ResolvedDeepLink>('deepLink.resolve', { hash });
  const s = getState();
  if (res.projectId !== s.activeProjectId) {
    if (res.rootPath == null || res.rootPath.length === 0) throw new Error('深链指向其它项目但未返回项目路径——无法打开');
    await openProjectByPath(res.rootPath); // 归属门+代次在 openProjectByPath 内
  }
  const route = routeForResolved(res, getState());
  if (route == null) throw new Error(`深链解析成功但无对应界面落点（kind=${res.kind}）`);
  const { navigate } = await import('./lib/router');
  navigate(route);
  recordWrite('deepLink.resolve', `深链 ${hash.slice(0, 40)} → ${route}`);
}
