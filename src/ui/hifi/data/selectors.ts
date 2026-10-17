/**
 * 派生查询。全部为纯函数，输入 AppState。
 * 这些函数刻意体现设计报告里的关系约束，便于评审时逐条对照。
 */

import type {
  AppState, Message, ProjectMember, Room, Task, Thread, WorkflowRun, AgentTurn,
  RuntimeInstallation, Artifact,
} from './types';

export const byId = <T extends { id: string }>(list: T[], id: string | undefined) =>
  id ? list.find((x) => x.id === id) : undefined;

/* ---------- 项目 / 房间 / 线程 ---------- */

export const projectOf = (s: AppState, id: string) => byId(s.projects, id);
export const roomOf = (s: AppState, id: string) => byId(s.rooms, id);
export const threadOf = (s: AppState, id: string | undefined) => byId(s.threads, id);

export const roomsOfProject = (s: AppState, projectId: string) =>
  s.rooms.filter((r) => r.projectId === projectId);

/* ---------- 项目生命周期（第十七批 §八/§九） ---------- */

/** 移除的项目：应用里不再列出，但数据仍在（可在设置里重新关联） */
export const isProjectRemoved = (p: { removedAt?: number }) => Boolean(p.removedAt);
/** 归档的项目：退出日常项目树，历史只读 */
export const isProjectArchived = (p: { archivedAt?: number; removedAt?: number }) =>
  Boolean(p.archivedAt) && !p.removedAt;
/** 日常项目树里出现的项目（未移除、未归档） */
export const dailyProjects = (s: AppState) =>
  s.projects.filter((p) => !isProjectRemoved(p) && !isProjectArchived(p));
/** 归档的项目（不含已移除） */
export const archivedProjects = (s: AppState) => s.projects.filter(isProjectArchived);
/** 已移除的项目（仅用于设置里的"重新关联"） */
export const removedProjects = (s: AppState) => s.projects.filter(isProjectRemoved);

/** 活跃房间（不含已归档）：侧栏项目树、看板房间筛选都用它 */
export const activeRoomsOfProject = (s: AppState, projectId: string) =>
  s.rooms.filter((r) => r.projectId === projectId && !r.archivedAt);

/** 项目是否只读（归档项目 / 移除项目的历史）：写入路径与界面都据此显示只读态 */
export function projectReadOnlyReason(s: AppState, projectId: string): string | null {
  const p = s.projects.find((x) => x.id === projectId);
  if (!p) return null;
  if (p.removedAt) return '这个项目已从应用里移除，仅在归档/设置中可见';
  if (p.archivedAt) return `「${p.displayName}」已归档：只读，可继续查看历史`;
  return null;
}

/** 私信未读（统一入口用）：只算未归档会话与未归档项目 */
export function dmUnreadTotal(s: AppState): number {
  return s.dms
    .filter((d) => !d.archivedAt && !isProjectArchived(s.projects.find((p) => p.id === d.projectId) ?? {})
      && !isProjectRemoved(s.projects.find((p) => p.id === d.projectId) ?? {}))
    .reduce((n, d) => n + d.unread, 0);
}

/** 某个项目的私信未读（侧栏项目行折叠汇总**不再**包含它：私信已搬到统一入口） */
export const dmUnreadOfProject = (s: AppState, projectId: string) =>
  s.dms.filter((d) => d.projectId === projectId && !d.archivedAt).reduce((n, d) => n + d.unread, 0);

export const membersOfProject = (s: AppState, projectId: string) =>
  s.members.filter((m) => m.projectId === projectId);

export const membersOfRoom = (s: AppState, room: Room): ProjectMember[] =>
  room.memberIds.map((id) => byId(s.members, id)).filter(Boolean) as ProjectMember[];

export const coordinatorOfRoom = (s: AppState, room: Room) => byId(s.members, room.coordinatorMemberId);

export const runtimeOfMember = (s: AppState, member: ProjectMember): RuntimeInstallation | undefined => {
  const profile = byId(s.profiles, member.profileId);
  return profile ? byId(s.runtimeInstallations, profile.runtimeInstallationId) : undefined;
};

/* ---------- 消息 ---------- */

/** 主池 = 房间内 thread_id 为空的顶层消息（§3.4） */
export const rootMessages = (s: AppState, roomId: string): Message[] =>
  s.messages
    .filter((m) => m.roomId === roomId && !m.threadId)
    .sort((a, b) => a.createdAt - b.createdAt);

export const threadMessages = (s: AppState, threadId: string): Message[] =>
  s.messages
    .filter((m) => m.threadId === threadId)
    .sort((a, b) => (a.threadMessageSeq ?? 0) - (b.threadMessageSeq ?? 0));

/**
 * 普通过程说明（界面信息减负施工任务书 §4）。
 *
 * 判定依据是数据里的**显式标记** `scope: 'process'`，不是"tone 是 info
 * 就当噪声"——后者会把"议题已标记为 needs_user""代码需人工审阅"这类
 * 需要用户处理的卡片一起藏起来。未标记的一律留在回复视图。
 */
export const isProcessNote = (m: Message): boolean =>
  m.authorType === 'system' && m.payload?.system?.scope === 'process';

/**
 * 回复视图真正渲染的消息。
 *
 * 普通过程说明移入「详情 → 活动与进展」，因此**不能**再拿
 * `threadMessages` 当回复列表用：首条未读、未读分隔线与"跳转首条未读"
 * 都是按 `threadMessageSeq` 找 DOM 的（`msg-seq-<thread>-<seq>`），
 * 藏起来的消息若还参与计算，跳转会指向一个不存在的元素而静默失效。
 * 消息本体、序号与未读水位都不动，只是"在哪里渲染"变了。
 */
export const replyThreadMessages = (s: AppState, threadId: string): Message[] =>
  threadMessages(s, threadId).filter((m) => !isProcessNote(m));

/** 被移入详情的过程说明（按时间升序，供「活动与进展」展示） */
export const processNotesOfThread = (s: AppState, threadId: string): Message[] =>
  threadMessages(s, threadId).filter(isProcessNote);

export const anchorOf = (s: AppState, thread: Thread) => byId(s.messages, thread.anchorMessageId);

/** 未装载回复的线程 → room.pool 卡片真实聚合（R64：水合层只装根锚，回复按需装载）。 */
function poolCardOf(s: AppState, threadId: string): { unread: number; replyCount: number } | undefined {
  const pool = (s as import('./store').HifiState).roomPool ?? {};
  for (const cards of Object.values(pool)) {
    const c = cards.find((x) => x.threadId === threadId);
    if (c != null) return c;
  }
  return undefined;
}

/** 回复数只统计人类与 agent 的回复；系统/工具事件不计入（TH-10）。
 *  R64：未装载回复的线程按 room.pool 卡片 replyCount（服务端真实计数）。 */
export function replyCount(s: AppState, threadId: string): number {
  const loaded = s.messages.filter((m) => m.threadId === threadId);
  if (loaded.length === 0) return poolCardOf(s, threadId)?.replyCount ?? 0;
  return loaded.filter((m) => m.authorType === 'human' || m.authorType === 'agent').length;
}

/** 主池卡片上的 2—3 条预览：线程消息的投影，不是副本（§3.4） */
export function replyPreview(s: AppState, threadId: string, limit = 3): Message[] {
  const list = s.messages.filter(
    (m) => m.threadId === threadId && (m.authorType === 'human' || m.authorType === 'agent'),
  );
  return list.slice(-limit);
}

export function unreadCount(s: AppState, threadId: string): number {
  const thread = threadOf(s, threadId);
  if (!thread) return 0;
  const loaded = s.messages.filter((m) => m.threadId === threadId);
  if (loaded.length === 0) return poolCardOf(s, threadId)?.unread ?? 0; // R64：未装载线程按卡片未读
  const watermark = s.readStates[threadId] ?? 0;
  return loaded.filter(
    (m) => (m.threadMessageSeq ?? 0) > watermark && m.authorType !== 'system',
  ).length;
}

export function hasUnread(s: AppState, threadId: string): boolean {
  return unreadCount(s, threadId) > 0;
}

export function firstUnreadSeq(s: AppState, threadId: string): number | undefined {
  const watermark = s.readStates[threadId] ?? 0;
  // 必须用**回复视图实际渲染**的列表：过程说明不在这里渲染，
  // 它上面的 seq 也就不该成为"跳转首条未读"的目标（否则跳转静默失效）
  const list = replyThreadMessages(s, threadId);
  return list.find((m) => (m.threadMessageSeq ?? 0) > watermark)?.threadMessageSeq;
}

/* ---------- 任务 ---------- */

export const taskOfThread = (s: AppState, thread: Thread) => byId(s.tasks, thread.rootTaskId);
export const taskOf = (s: AppState, id: string | undefined) => byId(s.tasks, id);

export const rootTasksOfRoom = (s: AppState, roomId: string) =>
  s.tasks
    .filter((t) => t.roomId === roomId && !t.parentTaskId)
    .sort((a, b) => b.roomTaskNumber - a.roomTaskNumber);

export const childTasksOf = (s: AppState, parentTaskId: string) =>
  s.tasks.filter((t) => t.parentTaskId === parentTaskId);

export const activeTasksOfProject = (s: AppState, projectId: string) =>
  s.tasks.filter(
    (t) => t.projectId === projectId && !t.parentTaskId &&
      (t.status === 'ACTIVE' || t.status === 'WAITING_USER' || t.status === 'BLOCKED' || t.status === 'REVIEW'),
  );

/**
 * 侧栏任务状态标记（2026-09-25 用户要求：把"有未结束任务"拆成"执行中/等待/受阻/待验收"）。
 *
 * 三条口径都写在这里，房间行与"折叠后的项目行"共用同一份判断：
 *
 * 1. **不改"未结束任务"的定义** —— 仍是顶部状态条用的那四种状态
 *    （ACTIVE / WAITING_USER / BLOCKED / REVIEW，见上面的 `activeTasksOfProject`）。
 *    OPEN（待开始）不参与：它还没派发，侧栏不把它说成"在跑"。
 * 2. **优先级**：先"需要用户处理或关注"（受阻 → 等待用户 → 待验收），最后才是执行中。
 *    项目里此前没有这类规则，本次按用户方案新建；数组顺序即优先级，
 *    且选状态只看"哪种状态有几条"，与任务在数组里的先后无关 ——
 *    同一个房间有多个任务时，结果不会随数组顺序抖动。
 * 3. **只算顶层任务**：子任务（分工卡）跟着根任务走，父子同时计入会虚报数量。
 */
export const NAV_TASK_STATE_RANK = ['BLOCKED', 'WAITING_USER', 'REVIEW', 'ACTIVE'] as const;
export type NavTaskState = (typeof NAV_TASK_STATE_RANK)[number];

export interface NavTaskStateSummary {
  /** 优先级最高的状态；没有未结束任务时为 undefined（侧栏回到默认占位） */
  state?: NavTaskState;
  /** 各状态的任务数（只列非零项，按 NAV_TASK_STATE_RANK 顺序） */
  counts: { state: NavTaskState; count: number }[];
  /** 顶层未结束任务总数 */
  total: number;
}

export function navTaskStateOf(tasks: Task[]): NavTaskStateSummary {
  const unfinished = tasks.filter(
    (t) => !t.parentTaskId && (NAV_TASK_STATE_RANK as readonly string[]).includes(t.status),
  );
  const counts = NAV_TASK_STATE_RANK.map((state) => ({
    state,
    count: unfinished.filter((t) => t.status === state).length,
  })).filter((c) => c.count > 0);
  return { state: counts[0]?.state, counts, total: unfinished.length };
}

export const navTaskStateOfRoom = (s: AppState, roomId: string) =>
  navTaskStateOf(s.tasks.filter((t) => t.roomId === roomId));

/** 项目级聚合：只用于**折叠**后的项目行（展开时房间行各自显示，不在项目行重复） */
export const navTaskStateOfProject = (s: AppState, projectId: string) =>
  navTaskStateOf(s.tasks.filter((t) => t.projectId === projectId));


/* ---------- 运行 ---------- */

export const runOfTask = (s: AppState, taskId: string): WorkflowRun | undefined =>
  s.runs.find((r) => r.taskId === taskId);

export const turnsOfRun = (s: AppState, runId: string): AgentTurn[] => s.turns.filter((t) => t.runId === runId);
export const turnsOfThread = (s: AppState, threadId: string): AgentTurn[] => s.turns.filter((t) => t.threadId === threadId);

/** 在线成员中仍在运行的 turn（用于"等待成员"提示） */
export const runningTurns = (s: AppState): AgentTurn[] =>
  s.turns.filter((t) => t.status === 'RUNNING' || t.status === 'DISPATCHING' || t.status === 'STOPPING');

/* ---------- 成果 ---------- */

export const artifactsOfThread = (s: AppState, threadId: string): Artifact[] =>
  s.artifacts.filter((a) => a.threadId === threadId).sort((a, b) => b.createdAt - a.createdAt);

export const artifactsOfTask = (s: AppState, taskId: string): Artifact[] =>
  s.artifacts.filter((a) => a.taskId === taskId).sort((a, b) => b.createdAt - a.createdAt);

/* ---------- 未读与待办聚合 ---------- */

export function roomUnread(s: AppState, roomId: string): number {
  const list = s.threads.filter((t) => t.roomId === roomId);
  return list.reduce((acc, t) => acc + unreadCount(s, t.id), 0);
}

export function projectUnread(s: AppState, projectId: string): number {
  return s.rooms
    .filter((r) => r.projectId === projectId)
    .reduce((acc, r) => acc + roomUnread(s, r.id), 0);
}

export const pendingActionItems = (s: AppState) => s.attention.filter((a) => a.requiresAction);

/* ---------- 写入锁（§10.3 / RT-08 / RT-09） ---------- */

/**
 * 取某个项目的写入租约。
 * 必须按 projectId 取：锁域是"同一物理原目录"，跨项目共用一份锁
 * 会把"众说的任务正在写入"显示到别的项目页面上（实测过的串项目缺陷）。
 */
export function lockOfProject(s: AppState, projectId: string) {
  return s.writeLocks[projectId] ?? null;
}

/* ---------- 成员显示名消歧（§3.2 同名成员用序号） ---------- */

export function memberLabel(member: ProjectMember | undefined): string {
  if (!member) return '未知成员';
  return member.ordinal && member.ordinal > 1 ? `${member.displayName}#${member.ordinal}` : member.displayName;
}

export function displayNameOf(s: AppState, memberId: string): string {
  if (memberId === 'system') return '系统';
  if (memberId === 'you') return '你';
  return memberLabel(byId(s.members, memberId));
}

/**
 * 按当前 @ 结构推导协作模式（§4.2；E6：模式不手选）。
 *
 * 2026-09-25：参数从"任务/讨论意图"改为**发送意图** —— `record`（仅记录）
 * 不参与路由：它不会调用模型，@ 了谁也不会因此唤醒谁。
 */
export function deriveRoute(
  mentionIds: string[],
  sendAs: 'ai' | 'record',
  roomMemberIds: string[],
  collaboration?: 'deliberate',
): { mode: 'AUTO' | 'DELIBERATE' | 'DIRECT'; resolvedMemberIds: string[]; note: string } {
  if (sendAs === 'record') {
    return { mode: 'AUTO', resolvedMemberIds: [], note: '仅记录：不路由、不调用模型' };
  }
  const hasAll = mentionIds.includes('all');
  const named = mentionIds.filter((id) => id !== 'all' && roomMemberIds.includes(id));
  if (hasAll) {
    return { mode: collaboration==='deliberate'?'DELIBERATE':'AUTO', resolvedMemberIds: roomMemberIds, note: collaboration==='deliberate'?'独立研讨：先独立分析再互评汇总':'全体参与本条协作，由协调成员接收并按需交接' };
  }
  if (named.length === 0) {
    return { mode: 'AUTO', resolvedMemberIds: [], note: '无 @：默认协调者接单，可自行决定是否分工' };
  }
  if (named.length === 1) {
    return { mode: 'DIRECT', resolvedMemberIds: named, note: '仅该成员被调用，其他成员零调用' };
  }
  return { mode: collaboration==='deliberate'?'DELIBERATE':'AUTO', resolvedMemberIds: named, note: `所选 ${named.length} 人${collaboration==='deliberate'?'参与独立研讨':'参与本条协作'}` };
}
