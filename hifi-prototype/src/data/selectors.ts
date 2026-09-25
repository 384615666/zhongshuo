/**
 * 派生查询。全部为纯函数，输入 AppState。
 * 这些函数刻意体现设计报告里的关系约束，便于评审时逐条对照。
 */

import type {
  AppState, Message, ProjectMember, Room, Thread, WorkflowRun, AgentTurn,
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

/** 回复数只统计人类与 agent 的回复；系统/工具事件不计入（TH-10） */
export function replyCount(s: AppState, threadId: string): number {
  return s.messages.filter(
    (m) => m.threadId === threadId && (m.authorType === 'human' || m.authorType === 'agent'),
  ).length;
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
  const watermark = s.readStates[threadId] ?? 0;
  return s.messages.filter(
    (m) => m.threadId === threadId && (m.threadMessageSeq ?? 0) > watermark && m.authorType !== 'system',
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
): { mode: 'AUTO' | 'DELIBERATE' | 'DIRECT'; resolvedMemberIds: string[]; note: string } {
  if (sendAs === 'record') {
    return { mode: 'AUTO', resolvedMemberIds: [], note: '仅记录：不路由、不调用模型' };
  }
  const hasAll = mentionIds.includes('all');
  const named = mentionIds.filter((id) => id !== 'all' && roomMemberIds.includes(id));
  if (hasAll) {
    return { mode: 'DELIBERATE', resolvedMemberIds: roomMemberIds, note: '以全体为准并去重，冻结当前房间启用名单' };
  }
  if (named.length === 0) {
    return { mode: 'AUTO', resolvedMemberIds: [], note: '无 @：默认协调者接单，可自行决定是否分工' };
  }
  if (named.length === 1) {
    return { mode: 'DIRECT', resolvedMemberIds: named, note: '仅该成员被调用，其他成员零调用' };
  }
  return { mode: 'DELIBERATE', resolvedMemberIds: named, note: `仅所选 ${named.length} 人参与研讨` };
}
