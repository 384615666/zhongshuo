/**
 * 私信（DM）持久化与执行编排（DEV-22 第一包；R4 契约 baseline §2、§4.6 一对一）。
 *
 * 会话：一对一会话（dm_participants 恰两个主体、创建后不可变更）；同成员可多条私信、
 * 互不串上下文（续接按 conversationId）。执行：用户每次给 Agent 的发送=内部任务
 * kind=dm_turn + DIRECT run（复用停止/预算/审批/交付/恢复设施）；不分配房间任务号、
 * 不建任务卡。同一对话串行：活动 run 存在时保存并排队（disposition=queued）；用户停止
 * 后队列转 paused（dm.resume 显式继续）。人对人只投递保存。
 */
import { randomUUID } from 'node:crypto';
import type { ZhongshuoDatabase } from '../db.ts';

export interface DmParticipantRow {
  principal_type: 'human' | 'agent';
  principal_id: string;
}

/**
 * 新建私信会话（第十九轮三：新建/打开分离——每个新的业务请求创建独立 conversationId；
 * 打开已有会话用其明确 conversationId；不要求先归档旧会话）。同 commandId 重试的幂等
 * 由命令网关（runCommand）承载——同号返回原创建结果，新号新建不同会话。
 */
export function createDmConversation(
  db: ZhongshuoDatabase,
  input: { projectId: string; peerMemberId: string; title?: string; localUserId: string },
): { ok: true; conversationId: string } | { ok: false; code: string; message: string } {
  // 对端必须是本项目的启用 Agent 成员（v0.1：本机用户 × 项目 Agent）。
  const peer = db.prepare("SELECT principal_type, enabled FROM project_members WHERE id = ? AND project_id = ?").get(input.peerMemberId, input.projectId) as
    | { principal_type: string; enabled: number }
    | undefined;
  if (peer == null) return { ok: false, code: 'MEMBER_NOT_FOUND', message: '对端成员不存在或不属于该项目' };
  if (peer.principal_type !== 'agent' || peer.enabled !== 1) {
    return { ok: false, code: 'MEMBER_NOT_DISPATCHABLE', message: 'v0.1 私信对端必须是本项目的启用 Agent 成员（人对人/Agent 对 Agent 的其他组合随 FULL-02）' };
  }
  const conversationId = `dm_${randomUUID()}`;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'dm', NULL)`).run(conversationId, input.projectId);
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES (?, ?, 'human', ?), (?, ?, 'agent', ?)`)
      .run(input.projectId, conversationId, input.localUserId, input.projectId, conversationId, input.peerMemberId);
    if (input.title != null) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(input.title, conversationId);
    db.prepare(`INSERT INTO conversation_read_states (project_id, conversation_id, viewer_id) VALUES (?, ?, ?)`).run(input.projectId, conversationId, input.localUserId);
  });
  tx();
  return { ok: true, conversationId };
}

export interface DmConversationSummary {
  conversationId: string;
  projectId: string;
  title: string | null;
  peerMemberId: string;
  peerDisplayName: string;
  archivedAt: number | null;
  revision: number;
  lastMessageSeq: number;
  lastReadSeq: number;
  unread: number;
  /** 会话执行态：idle=无活动 run；running=活动 dm_turn；queued=有排队消息；paused=停止后队列挂起。 */
  execState: 'idle' | 'running' | 'queued' | 'paused';
  /** 活动执行的 task/run（execState=running 时非空——UI 停止入口用）。 */
  activeTaskId: string | null;
  activeRunId: string | null;
  activeStopGeneration: number;
  /** 归档后停止退出未确认（如实呈现——不伪称已停）。 */
  stopPending: boolean;
}

export function listDmConversations(db: ZhongshuoDatabase, localUserId: string, projectId?: string): DmConversationSummary[] {
  const rows = (projectId != null
    ? db.prepare(`SELECT * FROM conversations WHERE kind = 'dm' AND project_id = ? ORDER BY rowid DESC`).all(projectId)
    : db.prepare(`SELECT * FROM conversations WHERE kind = 'dm' ORDER BY rowid DESC`).all()) as Array<{ id: string; project_id: string; title: string | null; archived_at: number | null; revision: number; last_message_seq: number }>;
  const out: DmConversationSummary[] = [];
  for (const row of rows) {
    const peer = db.prepare(
      `SELECT p.principal_id, m.display_name FROM dm_participants p JOIN project_members m ON m.id = p.principal_id
       WHERE p.conversation_id = ? AND p.principal_type = 'agent'`,
    ).get(row.id) as { principal_id: string; display_name: string } | undefined;
    if (peer == null) continue;
    const read = db.prepare('SELECT last_read_seq FROM conversation_read_states WHERE conversation_id = ? AND viewer_id = ?').get(row.id, localUserId) as { last_read_seq: number } | undefined;
    const pending = db.prepare(
      `SELECT count(*) c FROM tasks t WHERE t.conversation_id = ? AND t.kind = 'dm_turn' AND t.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.task_id = t.id AND r.status IN ('RUNNING','WAITING','STOPPING'))`,
    ).get(row.id) as { c: number };
    const paused = dmPauseGateHeld(db, row.id);
    const activeRow = db.prepare(
      `SELECT t.id AS taskId, r.id AS runId, r.status AS runStatus, t.stop_generation AS stopGen FROM workflow_runs r JOIN tasks t ON t.id = r.task_id
       WHERE t.conversation_id = ? AND t.kind = 'dm_turn' AND r.status IN ('RUNNING','WAITING','STOPPING') LIMIT 1`,
    ).get(row.id) as { taskId: string; runId: string; runStatus: string; stopGen: number } | undefined;
    out.push({
      conversationId: row.id,
      projectId: row.project_id,
      title: row.title,
      peerMemberId: peer.principal_id,
      peerDisplayName: peer.display_name,
      archivedAt: row.archived_at,
      revision: row.revision,
      lastMessageSeq: row.last_message_seq,
      lastReadSeq: read?.last_read_seq ?? 0,
      unread: Math.max(0, row.last_message_seq - (read?.last_read_seq ?? 0)),
      execState: paused ? 'paused' : activeRow != null ? 'running' : pending.c > 0 ? 'queued' : 'idle',
      activeTaskId: activeRow?.taskId ?? null,
      activeRunId: activeRow?.runId ?? null,
      activeStopGeneration: activeRow?.stopGen ?? 0,
      stopPending: row.archived_at != null && activeRow != null, // 归档后停止未确认——如实呈现
    });
  }
  return out;
}

export function dmConversationOf(db: ZhongshuoDatabase, conversationId: string): {
  id: string; project_id: string; kind: string; archived_at: number | null; revision: number; title: string | null;
} | undefined {
  return db.prepare('SELECT id, project_id, kind, archived_at, revision, title FROM conversations WHERE id = ?').get(conversationId) as never;
}

export function dmPeerOf(db: ZhongshuoDatabase, conversationId: string): DmParticipantRow | undefined {
  return db.prepare("SELECT principal_type, principal_id FROM dm_participants WHERE conversation_id = ? AND principal_type = 'agent'").get(conversationId) as DmParticipantRow | undefined;
}

export function dmLocalUserOf(db: ZhongshuoDatabase, conversationId: string): string | undefined {
  return (db.prepare("SELECT principal_id FROM dm_participants WHERE conversation_id = ? AND principal_type = 'human'").get(conversationId) as { principal_id: string } | undefined)?.principal_id;
}

export function dmHasActiveRun(db: ZhongshuoDatabase, conversationId: string): boolean {
  return (db.prepare(
    `SELECT count(*) c FROM workflow_runs r JOIN tasks t ON t.id = r.task_id
     WHERE t.conversation_id = ? AND t.kind = 'dm_turn' AND r.status IN ('RUNNING','WAITING','STOPPING')`,
  ).get(conversationId) as { c: number }).c > 0;
}

/** 会话已有待执行的 dm 派发（已入队且**尚未建 run**——串行门含"提交→领取"窗口，防并行；
 * 已建 run 的项由 dmHasActiveRun 判定，终态后残留 leased 不阻塞泵）。 */
export function dmQueueBusy(db: ZhongshuoDatabase, conversationId: string): boolean {
  return (db.prepare(
    `SELECT count(*) c FROM outbox o JOIN tasks t ON ('dmtask:' || t.id || ':initial') = o.dispatch_key
     WHERE t.conversation_id = ? AND t.kind = 'dm_turn' AND o.status IN ('pending','leased')
       AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.task_id = t.id)`,
  ).get(conversationId) as { c: number }).c > 0;
}

/** 停止后的队列挂起（R4：已排队消息转 paused，需用户继续——dm.resume 清除）。 */
export function dmPauseGateHeld(db: ZhongshuoDatabase, conversationId: string): boolean {
  return db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(`dm:pause:${conversationId}`) != null;
}

export function holdDmPauseGate(db: ZhongshuoDatabase, conversationId: string, reason: string): void {
  db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(`dm:pause:${conversationId}`, JSON.stringify({ reason, at: Date.now() }), Date.now());
}

export function releaseDmPauseGate(db: ZhongshuoDatabase, conversationId: string): void {
  db.prepare('DELETE FROM daemon_state WHERE key = ?').run(`dm:pause:${conversationId}`);
}

export interface CreateDmTurnInput {
  conversationId: string;
  projectId: string;
  peerMemberId: string;
  localUserId: string;
  body: string;
  intent: 'default' | 'record_only';
  reviewPolicy: string;
}

export interface CreateDmTurnResult {
  messageId: string;
  disposition: 'none' | 'queued' | 'dispatched';
  taskId: string | null;
  /** 派发处置说明（blocked 场景给原因）。 */
  note?: string;
}

/** message.submit(dm) 的原子提交：消息 + （agent 对端且非 record_only 时）dm_turn 任务与派发键。 */
export function createDmTurn(db: ZhongshuoDatabase, input: CreateDmTurnInput): CreateDmTurnResult {
  const messageId = `msg_${randomUUID()}`;
  const taskId = `task_${randomUUID()}`;
  const dispatch = input.intent !== 'record_only';
  const tx = db.transaction((): CreateDmTurnResult => {
    const seq = db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1, revision = revision + 1 WHERE id = ? RETURNING last_message_seq').get(input.conversationId) as { last_message_seq: number };
    db.prepare(
      `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id, thread_message_seq, author_type, author_id, body_json, status, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, 'human', ?, ?, 'saved', ?)`,
    ).run(messageId, input.projectId, input.conversationId, seq.last_message_seq, dispatch ? taskId : null, input.localUserId, JSON.stringify({ text: input.body }), Date.now());
    if (!dispatch) {
      return { messageId, disposition: 'none', taskId: null, note: 'record_only：只保存不建任务（意图一次性，不占预算）' };
    }
    db.prepare(
      `INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, root_message_id, room_task_number, owner_member_id, title, status, revision, review_policy, route_json, input_through_seq)
       VALUES (?, ?, ?, 'dm_turn', NULL, NULL, ?, NULL, ?, ?, 'ACTIVE', 0, ?, ?, ?)`,
    ).run(
      taskId, input.projectId, input.conversationId, messageId, input.peerMemberId,
      input.body.slice(0, 60), input.reviewPolicy,
      JSON.stringify({ kind: 'dispatch', mode: 'DIRECT', targetMemberId: input.peerMemberId, frozenMemberIds: [input.peerMemberId], initialWakeMemberIds: [input.peerMemberId] }),
      seq.last_message_seq, // 输入水位（第十九轮四）：本轮输入边界=本次用户消息的 seq
    );
    const busy = dmHasActiveRun(db, input.conversationId) || dmQueueBusy(db, input.conversationId) || dmPauseGateHeld(db, input.conversationId);
    if (busy) {
      // 排队：任务已建、消息已存；派发键不立即入队（dm 泵在会话空闲时入队——不偷偷并行）。
      return { messageId, disposition: 'queued', taskId, note: dmPauseGateHeld(db, input.conversationId) ? '会话队列已暂停（dm.resume 继续）' : '会话运行中：消息已保存排队，串行执行' };
    }
    db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(`dmtask:${taskId}:initial`);
    return { messageId, disposition: 'dispatched', taskId };
  });
  return tx();
}

/** dm 泵：会话空闲（无活动 run、无待执行派发、无挂起）时，把排队中的 dm_turn 入队（串行一次一条，幂等）。 */
export function pumpDmQueue(db: ZhongshuoDatabase, conversationId: string): { enqueued: number } {
  if (dmHasActiveRun(db, conversationId) || dmQueueBusy(db, conversationId) || dmPauseGateHeld(db, conversationId)) return { enqueued: 0 };
  const pending = db.prepare(
    `SELECT t.id FROM tasks t WHERE t.conversation_id = ? AND t.kind = 'dm_turn' AND t.status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.task_id = t.id)
     ORDER BY t.rowid`,
  ).all(conversationId) as Array<{ id: string }>;
  let enqueued = 0;
  for (const t of pending) {
    const key = `dmtask:${t.id}:initial`;
    const existing = db.prepare('SELECT id, status FROM outbox WHERE dispatch_key = ?').get(key) as { id: number; status: string } | undefined;
    if (existing == null) {
      db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(key);
      enqueued += 1;
    } else if (existing.status === 'done' || existing.status === 'failed') {
      // 键回收（第十九轮六）：该派发曾被归档门/取消拦下而任务从未建 run——队列行可安全重建
      //（dispatch_key 唯一约束；业务状态由 tasks/runs 承载，此处只重排）。
      db.prepare('DELETE FROM outbox WHERE id = ?').run(existing.id);
      db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(key);
      enqueued += 1;
    }
    break; // 串行：一次只放一条（其 run 终态后再泵下一条）
  }
  return { enqueued };
}
