/**
 * 写操作层（内存）。
 *
 * 命名规则：api 字符串逐字来自 §15.2 的 UI 命令清单。
 * 文档还没有列出命令面的功能（提醒、私信、文件评论、附件、导出、浏览器访问 ——
 * 这些的命令面在 M3）一律用 LOCAL_ONLY: 前缀标出，避免界面假装已有正式契约。
 *
 * 原型没有 daemon：这里不做事务、不写 SQLite、不派发 runtime。
 * 但状态转换按 §10.1/§10.2 的语义走，评审时能看清界面与状态的对应关系。
 */

import { getState, setState, recordWrite, recordLocalOnly, toast } from './store';
import { replyCount, roomUnread, unreadCount } from './selectors';
import { materializeAttachments } from './attachments';
import type { Message, Room, Task, WorkflowRun, Thread, AppState, ProjectMember, AgentProfile } from './types';

const now = () => Date.now();
const newId = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

function patchMessage(id: string, updater: (m: Message) => Message) {
  setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? updater(m) : m)) }));
}

function patchTask(id: string, updater: (t: Task) => Task) {
  setState((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? updater(t) : t)) }));
}

function patchRun(id: string, updater: (r: WorkflowRun) => WorkflowRun) {
  setState((s) => ({ ...s, runs: s.runs.map((r) => (r.id === id ? updater(r) : r)) }));
}

function clearAttentionForThread(threadId: string) {
  setState((s) => ({
    ...s,
    attention: s.attention.map((a) => (a.threadId === threadId ? { ...a, readAt: now() } : a)),
  }));
}

/* ============================================================
   message.submit —— 主池发新任务 / 线程内跟进（§4.5、§15.2）
   ============================================================ */

/**
 * 提交一条用户输入（主池 / 线程）。
 *
 * **2026-09-25 起**：参数 `intent: 'task' | 'discussion'` 改为 `sendAs: 'ai' | 'record'`。
 *  - `'ai'`（默认）：沿用既有业务与路由 —— 主池创建根任务（协调者/@ 结构路由/预算不变），
 *    线程跟进当前任务；
 *  - `'record'`：**仅记录**。只保存消息与附件，不创建任务/运行、不调用模型、不计预算、
 *    不 steering；即使正文 @ 了谁也不会因此唤醒 AI（这是"仅记录"的核心承诺）。
 *    保存记录走 `LOCAL_ONLY:` 留痕，不进 `message.submit` 的派发语义。
 *
 * 内部任务引擎、任务号与持久化契约都不因这次改名而改变：`'record'` 复用的正是
 * 旧的 discussion 非派发路径（无 rootTaskId 的记录串）。
 */
export function submitMessage(input: {
  body: string;
  sendAs: 'ai' | 'record';
  mentionIds: string[];
  method: { planFirst: boolean; skipFirstDraft: boolean; splitWork: boolean };
  /** 权限模式（Composer 的四档；见 ACCESS_MODES）。plan 等价于只分析 */
  access: 'plan' | 'confirm' | 'auto_edit' | 'full_access';
  attachments: { name: string; size: number }[];
  commandId: string;
  target: { kind: 'room_root' | 'thread'; roomId: string; threadId?: string };
}): { threadId: string; taskId?: string } {
  const s0 = getState();

  // RT-01：同一 commandId 重复提交返回相同逻辑结果，不创建第二个任务
  // （仅记录同样带 commandId 进留痕，所以重复点击也不会写出第二条记录）
  const existing = s0.ui.writeLog.find((w) => w.detail.includes(input.commandId));
  if (existing) {
    toast('同一 commandId 已提交过，返回原有结果（不重复创建）', 'warn');
    return { threadId: input.target.threadId ?? '' };
  }

  const isRecord = input.sendAs === 'record';
  const body: Message = {
    id: newId('msg'),
    projectId: s0.activeProjectId,
    roomId: input.target.roomId,
    authorType: 'human',
    authorId: 'you',
    kind: 'text',
    body: input.body,
    createdAt: now(),
    // recordOnly 把"非派发"留在数据里：列表据此标「记录」，用例据此断言没有模型派发
    payload: isRecord ? { mentionIds: input.mentionIds, recordOnly: true } : { mentionIds: input.mentionIds },
  };

  if (input.target.kind === 'thread' && input.target.threadId) {
    /* ---- 线程内：交 AI 是跟进；仅记录只保存 ---- */
    const threadId = input.target.threadId;
    const thread = s0.threads.find((t) => t.id === threadId);
    if (!thread) {
      toast('THREAD_SCOPE_MISMATCH：回复目标与当前任务不一致，草稿已保留', 'error');
      return { threadId };
    }
    const nextSeq = thread.lastMessageSeq + 1;
    const followUp: Message = { ...body, threadId, taskId: thread.rootTaskId, threadMessageSeq: nextSeq, replyToMessageId: undefined };
    // 附件真正落地（原来只传进函数就丢掉，消息上不会有任何附件）
    const att = materializeAttachments(
      input.attachments,
      {
        projectId: s0.activeProjectId,
        origin: { kind: 'message', messageId: followUp.id, roomId: input.target.roomId, threadId },
        audience: { kind: 'room', roomId: input.target.roomId },
      },
      followUp.id,
    );
    setState((s) => ({
      ...s,
      messages: [...s.messages, followUp],
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, lastMessageSeq: nextSeq } : t)),
      readStates: { ...s.readStates, [threadId]: nextSeq },
      resources: [...s.resources, ...att.resources],
      messageAttachments: [...s.messageAttachments, ...att.links],
    }));
    if (isRecord) {
      /* 仅记录：**不走派发语义** —— 不写 message.submit、不触碰任务/运行/预算/steering，
         只留一条 LOCAL_ONLY 痕迹（RT-01 的 commandId 去重也依赖它）。 */
      recordLocalOnly(
        'record.save',
        `target=thread:${threadId} commandId=${input.commandId}` +
          `${att.links.length ? ` attachments=${att.links.length}` : ''}` +
          ` mentions=[${input.mentionIds.join(',')}] → 不调用模型、不创建运行、不计预算（@ 也不唤醒）`,
      );
      toast(att.links.length ? `已保存记录（含 ${att.links.length} 个附件）：未调用模型` : '已保存记录：未调用模型、不创建运行', 'info');
      return { threadId, taskId: thread.rootTaskId };
    }
    recordWrite(
      'message.submit',
      `target=thread:${threadId} commandId=${input.commandId}${att.links.length ? ` attachments=${att.links.length}` : ''}`,
    );
    toast(att.links.length ? `已提交到本串（含 ${att.links.length} 个附件）` : '已提交到本串（不创建新任务）', 'success');
    return { threadId, taskId: thread.rootTaskId };
  }

  /* ---- 主池：单次事务创建 RootMessage + Task + Thread（§3.4） ---- */
  const roomTasks = s0.tasks.filter((t) => t.roomId === input.target.roomId && !t.parentTaskId);
  const nextNumber = Math.max(0, ...roomTasks.map((t) => t.roomTaskNumber)) + 1;
  const threadId = newId('thread');

  const anchor: Message = { ...body, id: newId('msg') };

  if (isRecord) {
    /**
     * 仅记录（原 E1「讨论串」路径，2026-09-25 起是显式一次性意图）：
     * root_task_id 为空、无任务号、不唤醒 agent、不创建运行、不计预算。
     * 历史记录串继续用同一形状，因此**不会被自动升级成 AI 任务**。
     */
    const thread: Thread = {
      id: threadId,
      projectId: s0.activeProjectId,
      roomId: input.target.roomId,
      anchorMessageId: anchor.id,
      status: 'open',
      lastMessageSeq: 0,
      revision: 1,
    };
    const att = materializeAttachments(
      input.attachments,
      {
        projectId: s0.activeProjectId,
        origin: { kind: 'message', messageId: anchor.id, roomId: input.target.roomId },
        audience: { kind: 'room', roomId: input.target.roomId },
      },
      anchor.id,
    );
    setState((s) => ({
      ...s,
      messages: [...s.messages, anchor],
      threads: [...s.threads, thread],
      readStates: { ...s.readStates, [threadId]: 0 },
      // 记录串不显示 13B 跟进名单
      subscriptions: { ...s.subscriptions, [threadId]: { followed: false, muted: false } },
      resources: [...s.resources, ...att.resources],
      messageAttachments: [...s.messageAttachments, ...att.links],
    }));
    recordLocalOnly(
      'record.save',
      `target=room_root commandId=${input.commandId}${att.links.length ? ` attachments=${att.links.length}` : ''}` +
        ` mentions=[${input.mentionIds.join(',')}] → 不创建任务/运行、不调用模型、不计预算（@ 也不唤醒）`,
    );
    toast(att.links.length ? `已保存记录（含 ${att.links.length} 个附件）：未调用模型` : '已保存记录：未创建任务、未调用模型', 'info');
    return { threadId };
  }

  const taskId = newId('task');
  const runId = newId('run');
  const isDirect = input.mentionIds.length === 1 && !input.mentionIds.includes('all');
  const isDeliberate = input.mentionIds.includes('all') || input.mentionIds.filter((m) => m !== 'all').length >= 2;

  const room = s0.rooms.find((r) => r.id === input.target.roomId)!;
  /** v1.12 §10.5：reviewPolicy 取自项目开关（不是从 access 推导） */
  const project = s0.projects.find((p) => p.id === s0.activeProjectId)!;
  const rosterCount = input.mentionIds.includes('all')
    ? room.memberIds.length
    : Math.max(1, input.mentionIds.filter((m) => m !== 'all').length);
  // E12：DELIBERATE 上限按冻结名单推导，核心 6N+1，含一次修订 7N+2
  const derivedMax = isDeliberate ? 7 * rosterCount + 2 : isDirect ? 6 : 20;

  const task: Task = {
    id: taskId,
    projectId: s0.activeProjectId,
    roomId: input.target.roomId,
    conversationThreadId: threadId,
    rootMessageId: anchor.id,
    roomTaskNumber: nextNumber,
    ownerMemberId: isDirect ? input.mentionIds[0] : room.coordinatorMemberId,
    title: input.body.slice(0, 42),
    objective: input.body,
    status: 'ACTIVE',
    revision: 1,
    /**
     * v1.12 §10.5：reviewPolicy 由**项目设置开关**在任务创建时快照，
     * 不再通过 `access === 'modify'` 自动推导人工验收。
     *
     * 原来的写法 `input.access === 'plan' ? 'auto_deliver' : 'user_review'`
     * 把"要不要人工验收"和"这次是分析还是改文件"绑死了：任何一个修改类任务
     * 都强制进人工验收，习惯 Git 的用户绕不过去。现在两者解耦 ——
     * 开关关闭时修改类任务也是 auto_deliver，但权限与写入范围不受影响。
     */
    reviewPolicy: project.taskReviewEnabled ? 'user_review' : 'auto_deliver',
    // 模式由 @ 结构推导，不手选（E6）
    mode: isDirect ? 'DIRECT' : isDeliberate ? 'DELIBERATE' : 'AUTO',
    displayNumber: nextNumber,
  };

  const run: WorkflowRun = {
    id: runId,
    taskId,
    threadId,
    mode: task.mode,
    taskRevision: 1,
    status: 'QUEUED',
    stage: 'PREPARE',
    roundNo: 0,
    rosterRevision: 1,
    budget: {
      maxAgentTurns: derivedMax,
      usedAgentTurns: 0,
      formula: isDeliberate
        ? `7N+2（N=${rosterCount}，含一次修订路径）`
        : isDirect
          ? 'DIRECT 固定 6'
          : 'AUTO 固定 20',
      reservedTail: isDeliberate ? 1 + rosterCount : 0,
      mustReserve: isDeliberate ? `SYNTHESIS 1 次 + RATIFY ${rosterCount} 次` : undefined,
    },
  };

  const thread: Thread = {
    id: threadId,
    projectId: s0.activeProjectId,
    roomId: input.target.roomId,
    anchorMessageId: anchor.id,
    rootTaskId: taskId,
    status: 'open',
    lastMessageSeq: 1,
    revision: 1,
  };

  const prep: Message = {
    id: newId('msg'),
    projectId: s0.activeProjectId,
    roomId: input.target.roomId,
    threadId,
    taskId,
    threadMessageSeq: 1,
    authorType: 'system',
    authorId: 'system',
    kind: 'system',
    createdAt: now(),
    body: '路由与预算已确定',
    payload: {
      system: {
        // 减负 §4：新建任务的路由/预算推导属正常过程说明。
        // 它移入「详情 → 活动与进展」，任务概况另有一句派发摘要，
        // 因此不必再占回复区域。发送前的预算推导值仍在输入区可见（§10.4 E12）。
        scope: 'process',
        tone: 'info',
        title: `已创建任务 #${nextNumber} · 模式 ${task.mode}`,
        detail: isDirect
          ? `resolvedRoute = DIRECT / [${input.mentionIds[0]}]。其他房间成员新增调用数为 0，delegationAllowed = false。`
          : isDeliberate
            ? `resolvedRoute = DELIBERATE，冻结名单 ${rosterCount} 人。预算上限按名单推导为 ${derivedMax} 次，尾部为 SYNTHESIS 与 RATIFY 预留 ${1 + rosterCount} 次。`
            : `resolvedRoute = AUTO，由房间协调者接单。它可以直接完成，也可以提交结构化分工计划。`,
      },
    },
  };

  const att = materializeAttachments(
    input.attachments,
    {
      projectId: s0.activeProjectId,
      origin: { kind: 'message', messageId: anchor.id, roomId: input.target.roomId },
      audience: { kind: 'room', roomId: input.target.roomId },
    },
    anchor.id,
  );

  setState((s) => ({
    ...s,
    messages: [...s.messages, anchor, prep],
    threads: [...s.threads, thread],
    tasks: [...s.tasks, task],
    runs: [...s.runs, run],
    readStates: { ...s.readStates, [threadId]: 1 },
    subscriptions: { ...s.subscriptions, [threadId]: { followed: true, muted: false } },
    followers: isDirect ? { ...s.followers, [threadId]: input.mentionIds } : { ...s.followers, [threadId]: room.memberIds },
    resources: [...s.resources, ...att.resources],
    messageAttachments: [...s.messageAttachments, ...att.links],
  }));

  recordWrite(
    'message.submit',
    `target=room_root intent=task mode=${task.mode} access=${input.access} commandId=${input.commandId} → task#${nextNumber}${att.links.length ? ` attachments=${att.links.length}` : ''}`,
  );
  toast(`任务 #${nextNumber} 已创建（${task.mode}），已按预算上限 ${derivedMax} 次排队`, 'success');
  return { threadId, taskId };
}

/* ============================================================
   DM 发送 —— 私信输入区（1 对 1，2026-09-25 收敛）
   ============================================================ */

/**
 * 私信输入区的发送路径（房间与线程走 `submitMessage`）。
 *
 * 口径（2026-09-25 用户决定）：**私聊是 1 对 1 的一问一答**，不做小群、
 * 不区分任务/讨论、没有 @ 提及。发送就是"把这条消息发给这个会话的成员"：
 *  · 成员边界仍是该会话的 audience（消息与附件只对该会话可见，§17.9 第 7 条）；
 *  · 权限档位随消息一起记录（它约束这次唤醒后该成员可做的事）；
 *  · **不创建任务号** —— 私信的任务顶层消息与正式提交接口按设计仍待清单 R4（§4.6 末句），
 *    原型不伪造一个打不开的任务。
 */
export function submitDmMessage(input: {
  dmId: string;
  body: string;
  /** 本次发送意图：ai=发给该成员（沿用私信 audience）；record=仅记录，不唤醒任何人 */
  sendAs: 'ai' | 'record';
  access: 'plan' | 'confirm' | 'auto_edit' | 'full_access';
  attachments: { name: string; size: number }[];
  commandId: string;
}): void {
  const s0 = getState();
  const dm = s0.dms.find((d) => d.id === input.dmId);
  if (!dm) {
    toast('私信不存在或已被移除，草稿已保留', 'error');
    return;
  }
  if (dm.archivedAt) {
    toast('该私信已归档：只能读历史，发送遵守既有只读规则', 'error');
    return;
  }
  // RT-01：同一 commandId 不重复发送
  const existing = s0.ui.writeLog.find((w) => w.detail.includes(input.commandId));
  if (existing) {
    toast('同一 commandId 已提交过，返回原有结果（不重复发送）', 'warn');
    return;
  }

  const isRecord = input.sendAs === 'record';
  const dmRoomId = `dm:${dm.id}`;
  const nextSeq =
    s0.messages
      .filter((m) => m.threadId === dm.threadId)
      .reduce((max, m) => Math.max(max, m.threadMessageSeq ?? 0), 0) + 1;

  const message: Message = {
    id: newId('msg'),
    projectId: dm.projectId,
    roomId: dmRoomId,
    threadId: dm.threadId,
    threadMessageSeq: nextSeq,
    authorType: 'human',
    authorId: 'you',
    kind: 'text',
    body: input.body,
    createdAt: now(),
    ...(isRecord ? { payload: { recordOnly: true } } : {}),
  };

  const att = materializeAttachments(
    input.attachments,
    {
      projectId: dm.projectId,
      // 私信附件按 §17.9 第 7 条归属该会话：切到群聊必须暂藏，连文件名都不露
      origin: { kind: 'dm', conversationId: dm.id, messageId: message.id },
      audience: { kind: 'dm', conversationId: dm.id, memberIds: dm.memberIds },
    },
    message.id,
  );

  setState((s) => ({
    ...s,
    messages: [...s.messages, message],
    resources: [...s.resources, ...att.resources],
    messageAttachments: [...s.messageAttachments, ...att.links],
    dms: s.dms.map((d) => (d.id === dm.id ? { ...d, lastMessageAt: now(), unread: 0 } : d)),
  }));

  const attNote = att.links.length ? ` attachments=${att.links.length}` : '';
  if (isRecord) {
    /* 仅记录：只留在该会话里，不唤醒成员、不进模型上下文（私信 audience 不变） */
    recordLocalOnly(
      'record.save',
      `target=dm:${dm.id} audience=[${dm.memberIds.join(',')}] commandId=${input.commandId}` +
        ` → 不唤醒成员、不调用模型、不创建运行、不计预算${attNote}`,
    );
    toast(`已保存记录${att.links.length ? `（含 ${att.links.length} 个附件）` : ''}：未唤醒成员、未调用模型`, 'info');
    return;
  }
  recordLocalOnly(
    'dm.message.send',
    `conversation=${dm.id} member=[${dm.memberIds.join(',')}] access=${input.access} ` +
      `→ 发给该成员；私信任务提交接口待 R4，未创建任务号${attNote} commandId=${input.commandId}`,
  );
  toast(`已发给 ${dm.memberIds.length ? '该成员' : '该会话'}${att.links.length ? `（含 ${att.links.length} 个附件）` : ''}`, 'success');
}

/* ============================================================
   阅读状态：只改人的阅读偏好，绝不触发模型（TH-11、§15.5）
   ============================================================ */

export function markThreadRead(threadId: string) {
  const s = getState();
  const thread = s.threads.find((t) => t.id === threadId);
  if (!thread) return;
  const before = unreadCount(s, threadId);
  setState((st) => ({ ...st, readStates: { ...st.readStates, [threadId]: thread.lastMessageSeq } }));
  clearAttentionForThread(threadId);
  recordWrite('thread.markRead', `thread=${threadId} 未读 ${before} → 0（不唤醒 agent）`);
}

export function toggleFollow(threadId: string) {
  const s = getState();
  const cur = s.subscriptions[threadId] ?? { followed: false, muted: false };
  setState((st) => ({
    ...st,
    subscriptions: { ...st.subscriptions, [threadId]: { ...cur, followed: !cur.followed } },
  }));
  recordWrite('thread.follow', `thread=${threadId} followed=${!cur.followed}（仅阅读关注，不是执行队列）`);
  toast(!cur.followed ? '已关注该任务的动态（不影响成员是否运行）' : '已取消关注：仍可查看和回复', 'info');
}

export function toggleMute(threadId: string) {
  const s = getState();
  const cur = s.subscriptions[threadId] ?? { followed: false, muted: false };
  setState((st) => ({
    ...st,
    subscriptions: { ...st.subscriptions, [threadId]: { ...cur, muted: !cur.muted } },
  }));
  recordWrite('thread.follow', `thread=${threadId} muted=${!cur.muted}（mute 只改通知偏好）`);
}

/**
 * 13B：移出跟进名单。
 * 语义必须准确：停止后续自动唤醒，保留历史，可再 @ 回来。
 * §15.2 尚未给这条命令编号，故用 LOCAL_ONLY 标出。
 */
export function removeFollower(threadId: string, memberId: string) {
  setState((s) => ({
    ...s,
    followers: { ...s.followers, [threadId]: (s.followers[threadId] ?? []).filter((m) => m !== memberId) },
  }));
  recordLocalOnly(
    'thread.follower.remove',
    `thread=${threadId} member=${memberId}：停止后续自动唤醒，历史保留，可再 @ 回来`,
  );
  toast('已移出跟进：它不再被自动唤醒，历史与已产出的成果都保留，随时可 @ 回来', 'warn');
}

export function saveMessage(messageId: string) {
  const s = getState();
  const m = s.messages.find((x) => x.id === messageId);
  if (!m) return;
  patchMessage(messageId, (x) => ({ ...x, saved: !x.saved }));
  recordWrite('message.save', `message=${messageId} saved=${!m.saved}（收藏不把内容共享给其他成员）`);
}

export function reactMessage(messageId: string, emoji: string) {
  patchMessage(messageId, (m) => {
    const list = m.reactions ? [...m.reactions] : [];
    const idx = list.findIndex((r) => r.emoji === emoji);
    if (idx < 0) return { ...m, reactions: [...list, { emoji, by: ['you'] }] };
    const r = list[idx];
    const has = r.by.includes('you');
    const by = has ? r.by.filter((x) => x !== 'you') : [...r.by, 'you'];
    const next = [...list];
    if (by.length === 0) next.splice(idx, 1);
    else next[idx] = { ...r, by };
    return { ...m, reactions: next };
  });
  recordLocalOnly('message.react', `message=${messageId} emoji=${emoji}（表情不是授权或共识记录）`);
}

/* ============================================================
   控制类：停止 / 全停 / 重试 / 按现有人继续
   ============================================================ */

export function stopTask(taskId: string) {
  const s = getState();
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const run = s.runs.find((r) => r.taskId === taskId);
  // §7.3/§16.3：先进入 STOPPING，确认进程/turn 结束才算 CANCELLED；停止 ≠ 撤销
  if (run) patchRun(run.id, (r) => ({ ...r, status: 'STOPPING' }));
  patchTask(taskId, (t) => ({ ...t, status: 'CANCELLED' }));
  setState((st) => ({
    ...st,
    turns: st.turns.map((t) =>
      t.runId === run?.id && (t.status === 'RUNNING' || t.status === 'DISPATCHING')
        ? { ...t, status: 'STOPPING' }
        : t,
    ),
    members: st.members.map((m) =>
      run && st.turns.some((t) => t.runId === run.id && t.memberId === m.id) ? { ...m, workState: 'stopped' } : m,
    ),
    // 只释放**该任务所属项目**的租约（锁按项目持有）
    writeLocks: Object.fromEntries(
      Object.entries(st.writeLocks).filter(([, l]) => l.ownerTaskId !== taskId),
    ),
  }));
  recordWrite('task.stop', `task=${taskId} → STOPPING；已产生的文件保留，界面展示残留 diff（停止不是撤销）`);
  toast('正在停止：已阻止新派发，等待活跃 turn 实际结束', 'warn');
}

export function stopAll(projectId: string) {
  const s = getState();
  const ids = s.tasks.filter((t) => t.projectId === projectId && !t.parentTaskId).map((t) => t.id);
  /**
   * 成员状态必须**只改这个项目的成员**。
   *
   * 修掉的缺陷（实测）：原来写的是
   *   members: st.members.map((m) => ({ ...m, workState: 'stopped', ... }))
   * 没有按 projectId 过滤 —— 于是停在众说会把 data-backfill 的成员也标成"项目全停"，
   * 而 data-backfill 的任务其实还在跑。这与前面修过的 writeLock 全局单例是同一类问题：
   * **项目级动作污染了其他项目**。
   * 现在只改本项目成员，其他项目的成员状态原样保留。
   */
  const memberIdsInProject = new Set(s.members.filter((m) => m.projectId === projectId).map((m) => m.id));
  setState((st) => ({
    ...st,
    tasks: st.tasks.map((t) => (ids.includes(t.id) ? { ...t, status: 'CANCELLED' } : t)),
    runs: st.runs.map((r) => (ids.includes(r.taskId) ? { ...r, status: 'CANCELLED' } : r)),
    // turn 也要按项目过滤：turn 属于线程，线程属于房间，房间属于项目
    turns: st.turns.map((t) => {
      if (!['RUNNING', 'DISPATCHING', 'WAITING_APPROVAL'].includes(t.status)) return t;
      const th = st.threads.find((x) => x.id === t.threadId);
      const room = th ? st.rooms.find((r) => r.id === th.roomId) : undefined;
      return room?.projectId === projectId ? { ...t, status: 'CANCELLED' } : t;
    }),
    members: st.members.map((m) =>
      memberIdsInProject.has(m.id)
        ? { ...m, workState: 'stopped', workStateReason: '项目全停' }
        : m,
    ),
    // 全停只释放**这个项目**的租约，其他项目正在写入的任务不受影响
    writeLocks: Object.fromEntries(Object.entries(st.writeLocks).filter(([pid]) => pid !== projectId)),
    // §16.4/RT-06：全停后迟到事件只留审计，不启动下一阶段
  }));
  recordWrite(
    'project.stopAll',
    `project=${projectId} 新增 stopGeneration；覆盖所有房间与子任务；` +
      `只改本项目 ${memberIdsInProject.size} 名成员的状态，其他项目不受影响`,
  );
  toast('项目已全停：该代次之前的所有待派发均被阻止，迟到事件只进审计', 'warn');
}

export function retryTask(taskId: string, resumePolicy: 'strict' | 'summary') {
  const s = getState();
  const run = s.runs.find((r) => r.taskId === taskId);
  if (!run) return;
  const newRunId = newId('run');
  setState((st) => ({
    ...st,
    runs: [
      ...st.runs,
      {
        ...run,
        id: newRunId,
        status: 'RUNNING',
        rosterRevision: run.rosterRevision + 1,
        // 重试创建新运行，不覆盖历史运行（§3.2）
        budget: { ...run.budget, usedAgentTurns: Math.max(0, run.budget.usedAgentTurns - 2) },
      },
    ],
    tasks: st.tasks.map((t) => (t.id === taskId ? { ...t, status: 'ACTIVE', revision: t.revision + 1 } : t)),
    members: st.members.map((m) => (m.workState === 'error' ? { ...m, workState: 'running' } : m)),
  }));
  recordWrite(
    'task.retry',
    `task=${taskId} sourceRun=${run.id} resumePolicy=${resumePolicy} → new runId=${newRunId}（保留原运行的审计记录）`,
  );
  toast(
    resumePolicy === 'strict'
      ? '已按严格续跑重试：复用原会话，迟到成果按阶段规则并入'
      : '已按摘要新建会话重试：原会话不再续接，避免带入已经污染的上下文',
    'info',
  );
}

export function allowMissing(runId: string, excludedMemberIds: string[]) {
  patchRun(runId, (r) => ({ ...r, rosterRevision: r.rosterRevision + 1, status: 'RUNNING' }));
  recordWrite(
    'run.allowMissing',
    `run=${runId} excluded=[${excludedMemberIds.join(',')}] → 新 rosterRevision；最终报告须列出缺席成员`,
  );
  toast('已按现有成员继续：生成新 rosterRevision，最终报告会如实列出缺席成员，不会标注全体一致', 'warn');
}

/* ============================================================
   task.steer —— 定向跟进（E3）/ 继续讨论
   ============================================================ */

export function steerSubtask(taskId: string, body: string, deliveryPolicy: 'live' | 'after_turn') {
  const s = getState();
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const thread = s.threads.find((t) => t.id === task.conversationThreadId);
  if (!thread) return;
  const seq = thread.lastMessageSeq + 1;
  const msg: Message = {
    id: newId('msg'),
    projectId: task.projectId,
    roomId: task.roomId,
    threadId: thread.id,
    taskId,
    threadMessageSeq: seq,
    authorType: 'human',
    authorId: 'you',
    kind: 'text',
    createdAt: now(),
    body,
  };
  // deliveryPolicy：支持实时 steering 的 adapter 送入当前 turn，否则排到本轮之后
  const accepted =
    deliveryPolicy === 'live' && s.turns.some((t) => t.threadId === thread.id && t.status === 'RUNNING');
  setState((st) => ({
    ...st,
    messages: [...st.messages, msg],
    threads: st.threads.map((t) => (t.id === thread.id ? { ...t, lastMessageSeq: seq } : t)),
    readStates: { ...st.readStates, [thread.id]: seq },
  }));
  recordWrite(
    'task.steer',
    `task=${taskId} deliveryPolicy=${deliveryPolicy} → ${accepted ? 'accepted' : 'queued'}${accepted ? '' : '（将在本轮结束后处理）'}`,
  );
  toast(
    accepted
      ? '已实时送入该子任务当前 turn（收到接受回执）'
      : '已排队：该 CLI 不支持实时 steering，将在本轮结束后处理',
    accepted ? 'success' : 'warn',
  );
}

/* ============================================================
   approval.respond（§15.2）
   ============================================================ */

export function respondApproval(messageId: string, approvalId: string, choice: 'allow_once' | 'deny') {
  patchMessage(messageId, (m) =>
    m.payload?.approval ? { ...m, payload: { ...m.payload, approval: { ...m.payload.approval, decision: choice } } } : m,
  );

  // 处理完的授权必须从「待我处理」里消失。
  // 原实现 filter((a) => a.kind !== 'approval' || a.threadId !== undefined) 条件恒真，
  // 等于什么都没过滤 —— 授权处理完仍然挂在待办里。
  const msg = getState().messages.find((m) => m.id === messageId);
  const threadId = msg?.threadId;
  setState((s) => ({
    ...s,
    attention: s.attention.map((a) =>
      a.kind === 'approval' && (threadId === undefined || a.threadId === threadId)
        ? { ...a, readAt: now() }
        : a,
    ),
  }));

  recordWrite('approval.respond', `approval=${approvalId} choice=${choice} → ${choice === 'allow_once' ? 'accepted' : 'denied'}`);
  toast(
    choice === 'allow_once'
      ? '已授权本次操作。agent 无权回应授权请求，也不会因此扩大目录权限'
      : '已拒绝：该操作不会执行，等待超时记录为已处理',
    choice === 'allow_once' ? 'success' : 'warn',
  );
}

/* ============================================================
   changes.revert（§14.5 / E15）
   ============================================================ */

export function revertChangeSet(changeSetId: string) {
  const s = getState();
  const cs = s.changeSets.find((c) => c.id === changeSetId);
  if (!cs) return;
  const blocked = cs.files.filter((f) => f.cannotRevert);
  setState((st) => ({
    ...st,
    changeSets: st.changeSets.map((c) => (c.id === changeSetId ? { ...c, status: 'reverted' } : c)),
  }));
  recordWrite(
    'changes.revert',
    `changeSet=${changeSetId} expectedAfterRef=${cs.afterRef} → ${blocked.length > 0 ? `部分失败：${blocked.length} 个大文件无内容级前像` : '已按前像还原'}`,
  );
  toast(
    blocked.length > 0
      ? `已还原可还原的文件；${blocked.map((f) => f.path).join('、')} 超过前像上限，无法内容级撤销`
      : '已按前像还原。撤销是带版本检查的独立操作，与"停止"不是同一件事',
    blocked.length > 0 ? 'warn' : 'success',
  );
}

/* ============================================================
   房间级操作
   ============================================================ */

export function archiveRoom(roomId: string) {
  const s = getState();
  const room = s.rooms.find((r) => r.id === roomId);
  if (!room) return;
  // §25.6：先检查所有根任务、子任务和待派发；有活跃工作时阻止归档并提供停止入口
  const active = s.tasks.filter((t) => t.roomId === roomId && ['ACTIVE', 'WAITING_USER', 'BLOCKED'].includes(t.status));
  if (active.length > 0) {
    toast(
      `不能归档：本房间还有 ${active.length} 个活跃任务（${active.map((t) => `#${t.roomTaskNumber}`).join('、')}）。请先停止它们`,
      'error',
    );
    return;
  }
  setState((st) => ({
    ...st,
    rooms: st.rooms.map((r) => (r.id === roomId ? { ...r, archivedAt: now(), revision: r.revision + 1 } : r)),
  }));
  recordWrite('room.archive', `room=${roomId} archived=true → 只读、不创建新任务、不被提醒唤醒`);
  toast('房间已归档：历史保留只读，提醒已暂停，迟到事件只进审计记录', 'success');
}

/**
 * 取消归档（§25.6）。
 * 归档是只读态，取消归档后可以继续，但**不会**把旧的待派发任务全部重放 ——
 * 只能由用户显式继续某个任务。
 */
export function unarchiveRoom(roomId: string) {
  setState((s) => ({
    ...s,
    rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, archivedAt: undefined, revision: r.revision + 1 } : r)),
  }));
  recordWrite(
    'room.archive',
    `room=${roomId} archived=false → 取消归档；旧的待派发任务不会自动重放，需用户显式继续`,
  );
  toast('已取消归档：可以继续发任务。旧的待派发任务不会自动重放', 'success');
}

/**
 * 循环与预算的可配置项（§10.4）。
 * E4 要求缺席容忍"默认 20 分钟、可设置"；turnDeadline 同样是项目级设置。
 * §15.2 尚无对应命令，按惯例用 LOCAL_ONLY 标注。
 */
export function updateLoopSettings(
  projectId: string,
  changes: Partial<{ absenceGraceMin: number; analysisTurnDeadlineMin: number; modifyTurnDeadlineMin: number; maxConcurrentTurns: number }>,
) {
  /** §10.4 的默认值：缺席容忍与单轮硬保护职责分开 */
  const DEFAULTS = {
    absenceGraceMin: 20,
    analysisTurnDeadlineMin: 20,
    modifyTurnDeadlineMin: 60,
    maxConcurrentTurns: 3,
  };

  setState((s) => ({
    ...s,
    projects: s.projects.map((p) =>
      p.id === projectId
        ? { ...p, loopSettings: { ...DEFAULTS, ...p.loopSettings, ...changes }, revision: p.revision + 1 }
        : p,
    ),
    // 缺席容忍是"当前正在等待"的实时参数：改了要立刻反映到线程提示上
    absence: Object.fromEntries(
      Object.entries(s.absence).map(([tid, a]) => [
        tid,
        changes.absenceGraceMin !== undefined ? { ...a, graceMs: changes.absenceGraceMin * 60_000 } : a,
      ]),
    ),
  }));
  recordLocalOnly(
    'project.loopSettings.set',
    `project=${projectId} ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(' ')}（§10.4 E4）`,
  );
  toast('循环与预算设置已更新：对后续 turn 生效', 'success');
}

export function updateRoom(roomId: string, changes: { name?: string; description?: string; coordinatorMemberId?: string }) {  setState((s) => ({
    ...s,
    rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, ...changes, revision: r.revision + 1 } : r)),
  }));
  recordWrite('room.update', `room=${roomId} ${Object.keys(changes).join(',')} → revision+1`);
  toast('房间设置已更新（协调者是房间级字段，新房间沿用项目当前默认）', 'success');
}

/* ============================================================
   room.members.add / room.members.remove（§15.2）
   房间成员管理：把项目成员加入/移出某个房间。
   注意与"线程跟进名单"（13B）不是一回事：这里改的是房间可见范围与可派发名单。
   ============================================================ */

export function addRoomMember(roomId: string, memberId: string) {
  setState((s) => ({
    ...s,
    rooms: s.rooms.map((r) =>
      r.id === roomId && !r.memberIds.includes(memberId)
        ? { ...r, memberIds: [...r.memberIds, memberId], revision: r.revision + 1 }
        : r,
    ),
  }));
  const name = getState().members.find((m) => m.id === memberId)?.displayName ?? memberId;
  recordWrite('room.members.add', `room=${roomId} memberIds=[${memberId}]（${name}）→ 成员变更结果：已加入`);
  toast(`${name} 已加入本房间。注意：任务中新增房间成员不会自动加入正在运行的研讨`, 'success');
}

export function removeRoomMember(roomId: string, memberId: string) {
  const s0 = getState();
  const room = s0.rooms.find((r) => r.id === roomId);
  if (!room) return;

  // 协调者不能移出房间：否则房间没有接单人
  if (room.coordinatorMemberId === memberId) {
    toast('不能移出协调者：请先把房间协调者改成其他成员', 'error');
    return;
  }
  // 有活跃任务时提示但不阻断（移出只影响后续派发，不打断已有运行）
  const activeOwned = s0.tasks.filter(
    (t) => t.roomId === roomId && t.ownerMemberId === memberId && ['ACTIVE', 'WAITING_USER', 'BLOCKED'].includes(t.status),
  );

  setState((s) => ({
    ...s,
    rooms: s.rooms.map((r) =>
      r.id === roomId ? { ...r, memberIds: r.memberIds.filter((m) => m !== memberId), revision: r.revision + 1 } : r,
    ),
    // 同时从该房间各线程的跟进名单里移除，避免"已不在房间却仍被唤醒"
    followers: Object.fromEntries(
      Object.entries(s.followers).map(([tid, ids]) => [
        tid,
        s.threads.find((t) => t.id === tid)?.roomId === roomId ? ids.filter((i) => i !== memberId) : ids,
      ]),
    ),
  }));

  const name = s0.members.find((m) => m.id === memberId)?.displayName ?? memberId;
  recordWrite(
    'room.members.remove',
    `room=${roomId} memberIds=[${memberId}]（${name}）→ 已移出；历史消息与成果作者保留${activeOwned.length > 0 ? `；该成员名下 ${activeOwned.length} 个活跃任务不受影响` : ''}`,
  );
  toast(
    `${name} 已移出本房间。历史消息与已交付成果保留，不会因此消失${activeOwned.length > 0 ? '；它名下仍在跑的任务继续执行' : ''}`,
    'warn',
  );
}

/* ============================================================
   写入并发策略（v1.9 §14.1，E20）
   默认 single_writer；parallel_writers 需用户在项目设置手动开启，
   且必须同时满足底线约束（界面负责如实告知，不假装安全）。
   ============================================================ */

export function setWriteConcurrencyPolicy(
  projectId: string,
  policy: 'single_writer' | 'parallel_writers',
  maxParallelWriters = 2,
) {
  setState((s) => ({
    ...s,
    projects: s.projects.map((p) =>
      p.id === projectId
        ? { ...p, writeConcurrencyPolicy: policy, maxParallelWriters, revision: p.revision + 1 }
        : p,
    ),
  }));
  recordLocalOnly(
    'project.writeConcurrency.set',
    `project=${projectId} policy=${policy}${policy === 'parallel_writers' ? ` maxParallelWriters=${maxParallelWriters}` : ''}（§14.1 E20）`,
  );
  toast(
    policy === 'single_writer'
      ? '已恢复单写者：同一物理目录同时最多 1 个受管理写入者，其他任务排队'
      : '已开启并行写入：同一目录可多个成员同时修改。同文件冲突会标记为归属不确定并禁用自动撤销',
    policy === 'single_writer' ? 'info' : 'warn',
  );
}

/**
 * 申请写入一个目录。
 * 默认策略下第二个任务排队；并行策略下放行，但超过上限仍排队。
 * 原型用它来演示两种策略的差别。
 */
export function acquireWriteLock(taskId: string, lockDomain: string, taskLabel: string): 'granted' | 'queued' {
  const s = getState();
  const project = s.projects.find((p) => p.id === s.activeProjectId);
  const policy = project?.writeConcurrencyPolicy ?? 'single_writer';
  const maxWriters = project?.maxParallelWriters ?? 2;
  /** 租约按项目持有：判"有没有人持锁"必须只看同一个项目（§10.3 锁域） */
  const projectId = s.activeProjectId;
  const lock = s.writeLocks[projectId] ?? null;

  const setLock = (next: AppState['writeLocks'][string] | null) =>
    setState((st) => {
      const locks = { ...st.writeLocks };
      if (next) locks[projectId] = next;
      else delete locks[projectId];
      return { ...st, writeLocks: locks };
    });

  if (policy === 'single_writer') {
    if (lock && lock.ownerTaskId !== taskId) {
      recordLocalOnly('workspace.lease.wait', `task=${taskId} project=${projectId} → queued（单写者策略下显示锁持有者）`);
      return 'queued';
    }
    setLock({ lockDomain, ownerTaskId: taskId, ownerTaskLabel: taskLabel });
    recordLocalOnly('workspace.lease.acquire', `task=${taskId} project=${projectId} domain=${lockDomain} policy=single_writer → 独占租约`);
    return 'granted';
  }

  // parallel_writers：共享租约，但受写入者上限约束
  const holders = lock?.parallelHolders ?? [];
  if (holders.length >= maxWriters && !holders.includes(taskId)) {
    recordLocalOnly('workspace.lease.wait', `task=${taskId} project=${projectId} → queued（并行上限 ${maxWriters} 已达）`);
    toast(`并行写入者已达上限 ${maxWriters}，该任务排队`, 'warn');
    return 'queued';
  }
  setLock({
    lockDomain,
    ownerTaskId: lock?.ownerTaskId ?? taskId,
    ownerTaskLabel: lock?.ownerTaskLabel ?? taskLabel,
    parallelHolders: holders.includes(taskId) ? holders : [...holders, taskId],
  });
  recordLocalOnly(
    'workspace.lease.acquire',
    `task=${taskId} project=${projectId} domain=${lockDomain} policy=parallel_writers → 共享租约（${holders.length + 1}/${maxWriters}）；同文件冲突将标记 attribution=ambiguous`,
  );
  return 'granted';
}

export function createRoom(projectId: string, name: string, coordinatorMemberId: string) {
  const id = newId('room');
  const s = getState();
  const room: Room = {
    id,
    projectId,
    name,
    coordinatorMemberId,
    memberIds: s.members.filter((m) => m.projectId === projectId).map((m) => m.id),
    revision: 1,
    unread: 0,
  };
  setState((st) => ({ ...st, rooms: [...st.rooms, room] }));
  recordWrite('room.create', `project=${projectId} name=${name} → room=${id}`);
  return id;
}

/* ============================================================
   member.configure（决策 38）
   ============================================================ */

export function configureMember(
  memberId: string,
  changes: Partial<{ displayName: string; model: string; effort: 'low' | 'medium' | 'high'; internalSubagents: boolean; enabled: boolean }>,
) {
  setState((s) => ({
    ...s,
    members: s.members.map((m) => (m.id === memberId ? { ...m, ...changes, workStateReason: '配置已更新，对后续 turn 生效' } : m)),
  }));
  const before = (m: string) =>
    recordWrite('member.configure', `member=${memberId} ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(' ')} → 能力与配置版本已更新（${m}）`);
  before('对后续 turn 生效；运行中切 runtime 需重建会话并留痕');
  toast('成员配置已保存：对后续 turn 生效；运行中切换 runtime 需要重建会话并留痕', 'success');
}

export function clearMemberSession(memberId: string, scope: string) {
  recordLocalOnly(
    'member.session.reset',
    `member=${memberId} scope=${scope} → 新 sessionGeneration；保留工作空间与已交付成果`,
  );
  toast('已重置所选范围的会话：原项目文件、其他线程的会话与已交付成果都保持不变', 'success');
}

/* ============================================================
   新增成员（AGENT-01）
   ============================================================ */

/**
 * 创建一个**项目成员**，并让他加入该项目的**未归档房间**。
 *
 * 为什么用 LOCAL_ONLY 标注：设计报告 **AGENT-01** 明确要求"创建与持久身份"
 * （名称、handle、描述、runtime、provider/model），§17.2 的成员管理也写"无成员提示添加"，
 * 说明这是**必须有的功能**；但 **§15.2 的 UI 命令清单里没有 `member.create`**
 * —— 清单只有 `room.members.add/remove`（房间级加减）与 `member.configure`（改配置）。
 * 于是照本项目的既有纪律（见文件头说明）：文档还没列出命令面的动作一律用
 * `LOCAL_ONLY:` 前缀标出，**不假装已有正式契约**。等 §15.2 补上 member.create 再去掉前缀。
 *
 * 几条必须守住的语义：
 *  1. **身份三层不混用**（§3.2）：Profile 是模板、ProjectMember 是项目内身份、
 *     RuntimeInstallation 是执行程序，三者不能共用 ID。这里新建的是 ProjectMember，
 *     并新建一个与之对应的 Profile（模板），因为模板记录 runtime 归属。
 *  2. **runtime 在模板上、model/effort 在成员上**：所以表单里 runtime 的改动会写进
 *     profile，而模型与思考强度写进 member。这不是实现随意，而是 §3.2 的分层。
 *  3. **同名用 ordinal 消歧**（§3.2）：同一 runtime 可以支持多名成员，
 *     同名实例通过不可变 ID 区分、界面用名称与序号消歧。
 *  4. **只加入未归档房间**：归档房间保留只读历史，不该因新增成员而复活。
 *     §10.4 同时明确：任务中新增房间成员**不自动加入正在运行的研讨**。
 *  5. **不自动成为协调者**：协调者是房间级字段（E5），新增成员一律 `isCoordinatorDefault: false`，
 *     要不要换协调者由用户在房间设置里显式决定。
 */
export function createMember(input: {
  projectId: string;
  displayName: string;
  /** 成员模板名；留空则用显示名 */
  profileName?: string;
  description: string;
  runtimeInstallationId: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
}): string | null {
  const s0 = getState();
  const name = input.displayName.trim();
  if (!name) {
    toast('成员需要一个名称', 'error');
    return null;
  }
  const project = s0.projects.find((p) => p.id === input.projectId);
  if (!project) {
    toast('项目不存在，无法新增成员', 'error');
    return null;
  }
  const rt = s0.runtimeInstallations.find((r) => r.id === input.runtimeInstallationId);
  if (!rt) {
    toast('请选择一个 runtime', 'error');
    return null;
  }
  /**
   * runtime 未就绪时**不阻断创建**，但必须如实告知不能立刻派工。
   * 理由：§9.5 要求"未安装/未登录/未验证分开显示"，用户可能先把成员建好、
   * 再去装 runtime；把创建卡死反而逼用户走弯路。这里创建成功 + 明确提示。
   */
  const blockedReason =
    rt.health === 'ready' ? null
      : rt.health === 'not_installed' ? '本机未安装这个 runtime，成员建好后还不能派工'
        : rt.health === 'not_logged_in' ? '这个 runtime 还没登录，成员建好后还不能派工'
          : rt.health === 'incompatible' ? '版本不兼容，成员建好后还不能派工'
            : '这个 runtime 尚未通过验证，成员建好后还不能派工';

  // 同名实例用 ordinal 消歧（§3.2）
  const sameName = s0.members.filter((m) => m.projectId === input.projectId && m.displayName === name);
  const ordinal = sameName.length > 0 ? Math.max(0, ...sameName.map((m) => m.ordinal ?? 1)) + 1 : undefined;

  const profileId = newId('prof');
  const memberId = newId('member');
  const member: ProjectMember = {
    id: memberId,
    projectId: input.projectId,
    profileId,
    displayName: name,
    ...(ordinal ? { ordinal } : {}),
    enabled: true,
    // 新成员还没跑过任何东西：用 idle 而不是 running，不假装正在工作
    workState: 'idle',
    workStateReason: blockedReason ?? '刚加入项目，还没有参与过任何任务',
    model: input.model,
    effort: input.effort,
    internalSubagents: false,
    // 协调者是房间级字段（E5），新增成员默认不是，要不要换由用户显式决定
    isCoordinatorDefault: false,
  };
  const profile: AgentProfile = {
    id: profileId,
    name: input.profileName?.trim() || name,
    description: input.description.trim() || '（没有填写说明）',
    runtimeInstallationId: input.runtimeInstallationId,
  };

  // 只加入未归档的现有房间；归档房间保持只读，不因新增成员而复活
  const joinableRoomIds = s0.rooms
    .filter((r) => r.projectId === input.projectId && !r.archivedAt)
    .map((r) => r.id);

  setState((s) => ({
    ...s,
    profiles: [...s.profiles, profile],
    members: [...s.members, member],
    rooms: s.rooms.map((r) =>
      joinableRoomIds.includes(r.id) && !r.memberIds.includes(memberId)
        ? { ...r, memberIds: [...r.memberIds, memberId], revision: r.revision + 1 }
        : r,
    ),
  }));

  // §15.2 没有 member.create：用 LOCAL_ONLY 标注，不冒充正式契约
  recordLocalOnly(
    'member.create',
    `project=${input.projectId} member=${memberId} profile=${profileId} ` +
      `runtime=${rt.label} model=${input.model} effort=${input.effort} ` +
      `→ 新增项目成员${ordinal ? `（同名第 ${ordinal} 个实例）` : ''}；` +
      `已加入 ${joinableRoomIds.length} 个未归档房间；未成为协调者；不加入正在运行的研讨`,
  );
  // 房间级动作按 §15.2 的既有命令记一条，因为它确实改了房间成员
  if (joinableRoomIds.length > 0) {
    recordWrite(
      'room.members.add',
      `memberIds=[${memberId}]（${name}）→ 成员变更结果：已加入 ${joinableRoomIds.length} 个未归档房间`,
    );
  }

  toast(
    blockedReason
      ? `已新增成员 ${ordinal ? `${name}#${ordinal}` : name}。注意：${blockedReason}`
      : `已新增成员 ${ordinal ? `${name}#${ordinal}` : name}：已加入未归档房间，未设为协调者`,
    blockedReason ? 'warn' : 'success',
  );
  return memberId;
}

/* ============================================================
   M3 批次：提醒 / 私信 / 文件评论 / 浏览器访问的设备管理
   这些命令面尚未在 §15.2 列出，统一以 LOCAL_ONLY 标注。
   ============================================================ */

export function toggleReminder(reminderId: string) {
  setState((s) => ({
    ...s,
    reminders: s.reminders.map((r) => (r.id === reminderId ? { ...r, enabled: !r.enabled } : r)),
  }));
  recordLocalOnly('reminder.update', `reminder=${reminderId} → 计划变更已持久化；应用关闭期间错过不补跑几十次`);
}

export function createReminder(threadId: string, schedule: string, ownerMemberId: string) {
  const id = newId('rem');
  setState((s) => ({
    ...s,
    reminders: [
      ...s.reminders,
      {
        id,
        ownerMemberId,
        threadId,
        timezone: 'Asia/Shanghai',
        schedule,
        nextRunAt: now() + 3_600_000 * 14,
        enabled: true,
      },
    ],
  }));
  recordLocalOnly('reminder.create', `thread=${threadId} owner=${ownerMemberId} schedule=${schedule} → 只唤醒 owner`);
  toast('提醒已创建：只唤醒指定的 owner，继承本线程的权限与预算；应用关闭期间不会按时执行，恢复后显示过期状态', 'success');
}

export function revokeDevice(deviceId: string) {
  const s = getState();
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev || dev.kind === 'this-machine') {
    toast('本机界面那一台不能吊销（吊销它会把你自己的界面断掉）', 'error');
    return;
  }
  setState((st) => ({ ...st, devices: st.devices.filter((d) => d.id !== deviceId) }));
  recordLocalOnly('device.revoke', `device=${deviceId}（${dev.name}）→ 连接立即失效；已配对的其他设备不受影响`);
  toast(`已吊销「${dev.name}」：该设备的连接立即失效，其他已配对设备不受影响`, 'success');
}

export function rotateToken() {
  const token = `zs_tok_${Math.random().toString(36).slice(2, 6)}`;
  setState((s) => ({
    ...s,
    devices: s.devices.map((d) => (d.kind === 'lan' ? { ...d, tokenPrefix: `${token}_${d.id.slice(-4)}` } : d)),
  }));
  recordLocalOnly('device.token.rotate', `token=${token}*** → 轮换不影响已配对设备；吊销与轮换相互独立`);
  toast('会话令牌已轮换：所有已配对设备无需重新配对，吊销设备仍是单独动作', 'success');
}

export function generatePairingCode() {
  const code = String(Math.floor(10000000 + Math.random() * 89999999));
  recordLocalOnly('device.pairing.code', `生成配对码 ${code}（默认随机 8 位，限时、一次一用）`);
  toast(`配对码 ${code}：限时 5 分钟、一次一用，仅在本机显示。局域网监听强制 HTTPS/WSS，不接受明文 HTTP`, 'info');
  return code;
}

export function testAdminBoundary() {
  recordLocalOnly('device.boundary.test', '尝试未配对设备直连：预期被拒绝并留审计记录（RT-21）');
  toast('未配对设备 / 来源校验失败的请求 / 明文 HTTP：三类全部拒绝并留可查审计记录', 'warn');
}

/* ============================================================
   §16.4 启动恢复（E7：不自动续跑）
   ============================================================ */

export function confirmStartupResume(itemIds: string[]) {
  setState((s) => ({
    ...s,
    startupRecovery: { ...s.startupRecovery, needsAttention: false, awaitingUserConfirm: false },
    runs: s.runs.map((r) =>
      itemIds.some((id) => s.startupRecovery.items.find((i) => i.id === id)?.title.includes(`#${r.taskId}`))
        ? { ...r, status: 'RUNNING' }
        : r,
    ),
  }));
  recordWrite(
    'task.retry',
    `启动恢复：用户确认继续 ${itemIds.length} 项 → 才开放新调度（决策 44：重新排队 ≠ 自动派发）`,
  );
  toast(`已确认继续 ${itemIds.length} 项。恢复阶段不会自动续跑，也不会凭 PID 存在就认定是原进程`, 'success');
}

export function dismissStartupRecovery() {
  setState((s) => ({ ...s, startupRecovery: { ...s.startupRecovery, needsAttention: false } }));
  recordLocalOnly('startup.recovery.dismiss', '用户选择暂不处理：保持暂停新派发，任务不会自行烧调用');
  toast('已关闭提示。未派发的工作仍在队列里，不会自动开始', 'info');
}

/* ============================================================
   项目
   ============================================================ */

export function openProjectAt(projectId: string) {
  setState((s) => ({ ...s, activeProjectId: projectId }));
  const p = getState().projects.find((x) => x.id === projectId);
  const first = p ? getState().rooms.find((r) => r.projectId === projectId && !r.archivedAt) : undefined;
  if (first) setState((s) => ({ ...s, ui: { ...s.ui, activeRoomId: first.id, activeThreadId: undefined } }));
  recordWrite('project.open', `path=${p?.rootPath}`);
  return first?.id;
}

export function relocateProject(projectId: string, newPath: string) {
  setState((s) => ({
    ...s,
    projects: s.projects.map((p) =>
      p.id === projectId
        ? { ...p, rootPath: newPath, canonicalPath: newPath, status: 'ok', revision: p.revision + 1 }
        : p,
    ),
  }));
  const p = getState().projects.find((x) => x.id === projectId);
  recordWrite('project.relocate', `project=${projectId} path=${newPath} expectedRevision=${(p?.revision ?? 1) - 1} → 保留原 projectId`);
  toast(`已重新定位到 ${newPath}：保留原 projectId，历史任务与成果不变`, 'success');
}

/* ============================================================
   导出与诊断
   ============================================================ */

export function exportDiagnostics(projectId: string | undefined) {
  recordWrite(
    'diagnostics.export',
    `project=${projectId ?? 'all'} → 已脱敏凭据、环境变量与敏感路径；报告正文需你另行勾选`,
  );
  toast('诊断已导出：默认脱敏凭据与环境变量，是否包含源码或报告正文由你选择', 'success');
}

export function exportArtifact(artifactId: string, format: 'markdown' | 'word' | 'html') {
  recordLocalOnly('artifact.export', `artifact=${artifactId} format=${format}（决策 34：Markdown + Word/HTML）`);
  toast(`已导出 ${format === 'markdown' ? 'Markdown' : format === 'word' ? 'Word' : 'HTML'}：导出范围由你主动发起`, 'success');
}

/* ============================================================
   纯派生工具（不写状态）
   ============================================================ */

export function threadUnread(threadId: string) {
  return unreadCount(getState(), threadId);
}
export function threadReplies(threadId: string) {
  return replyCount(getState(), threadId);
}
export function projectUnreadCount(projectId: string) {
  const s = getState();
  return s.rooms
    .filter((r) => r.projectId === projectId)
    .reduce((acc, r) => acc + roomUnread(s, r.id), 0);
}
export type { AppState };
