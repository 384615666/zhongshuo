/**
 * DEV-18 首包（第二十二轮五）：阅读水位/待我处理/深链。
 * 覆盖：
 * - conversation.markRead：幂等（同水位 advanced:false+commandId 回执重放）、未来水位拒绝
 *   （>last_message_seq 报错且水位不变）、房间会话可标（本地用户）、固定目标语义（标 A 不动 B）、
 *   不得替另一参与者标读（DM 双成员校验）；
 * - mine.pending：权威业务状态汇总——同一会话多 REVIEW 任务不漏（逐任务，非 conversation
 *   LIMIT1）、每条绑定当前交付（pending 优先/最新行回退/null 如实）、DM 未读（agent 消息计
 *   数+最新序）、验收完成后从汇总消失（读卡片≠完成事项——阅读不消待办）；
 * - deepLink.resolve：dm/task/delivery/msg 真实归属定位、不存在/归属矛盾/非本人 DM 明确报错；
 * - 重启持久：新连接读 read_state 保持。
 * 全部零真实调用（纯 DB+命令层）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-dev18-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄释放延迟 */ } } });

function makeDb(): { db: ZhongshuoDatabase; cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T> } {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id, last_message_seq) VALUES ('conv_room','p1','room','room1',0),('conv_dm_a','p1','dm',NULL,0),('conv_dm_b','p1','dm',NULL,0)`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `d18-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw Object.assign(new Error(r.error?.message), { code: r.error?.code });
    return r.data as T;
  };
  return { db, cmd };
}

/** 造消息（agent/human）并推 last_message_seq。 */
function addMsg(db: ZhongshuoDatabase, convId: string, author: 'human' | 'agent', text: string): number {
  const seq = (db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq').get(convId) as { last_message_seq: number }).last_message_seq;
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id, thread_message_seq, author_type, author_id, body_json, status, created_at)
              VALUES (?, 'p1', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 'final', 0)`)
    .run(`msg_${convId}_${seq}`, convId, seq, author, author === 'agent' ? 'mA' : 'u_local', JSON.stringify({ text }));
  return seq;
}
/** 造 REVIEW 任务+交付。 */
function addReviewTask(db: ZhongshuoDatabase, taskId: string, convId: string, kind: 'room_task' | 'dm_turn', deliveries: Array<{ revision: number; status: string }>): void {
  db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES (?, 'p1', ?, ?, NULL, ?, 'REVIEW')`).run(taskId, convId, kind, `任务 ${taskId}`);
  for (const d of deliveries) {
    db.prepare(`INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status, reviewed_by, reviewed_at)
                VALUES (?, ?, ?, ?, '[]', '[]', '[]', ?, ?, ?)`).run(`dlv_${taskId}_${d.revision}`, taskId, d.revision, `mh_${taskId}_${d.revision}`, d.status, d.status === 'accepted' ? 'u_local' : null, d.status === 'accepted' ? 1 : null);
  }
}

describe('DEV-18 首包：阅读水位（markRead）', () => {
  it('幂等：同水位重复=advanced:false；commandId 重放同结果；水位只前进', async () => {
    const { db, cmd } = makeDb();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_a','human','u_local'),('p1','conv_dm_a','agent','mA')`).run();
    const s1 = addMsg(db, 'conv_dm_a', 'agent', '回复一');
    const s2 = addMsg(db, 'conv_dm_a', 'agent', '回复二');
    const r1 = await cmd<{ advanced: boolean }>('conversation.markRead', { conversationId: 'conv_dm_a', throughMessageSeq: s1 });
    expect(r1.advanced).toBe(true);
    const r2 = await cmd<{ advanced: boolean }>('conversation.markRead', { conversationId: 'conv_dm_a', throughMessageSeq: s1 });
    expect(r2.advanced).toBe(false); // 同水位幂等
    const r3 = await cmd<{ advanced: boolean }>('conversation.markRead', { conversationId: 'conv_dm_a', throughMessageSeq: s2 }, 'd18-replay-1');
    const r4 = await cmd<{ advanced: boolean }>('conversation.markRead', { conversationId: 'conv_dm_a', throughMessageSeq: s2 }, 'd18-replay-1'); // 同 commandId 重放
    expect(r3.advanced).toBe(true);
    expect(r4).toEqual(r3); // 回执层幂等（replay 同结果）
    const st = db.prepare("SELECT last_read_seq FROM conversation_read_states WHERE conversation_id='conv_dm_a' AND viewer_id='u_local'").get() as { last_read_seq: number };
    expect(st.last_read_seq).toBe(s2);
    db.close();
  });

  it('未来水位拒绝：>last_message_seq 报错且水位不推进', async () => {
    const { db, cmd } = makeDb();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_a','human','u_local'),('p1','conv_dm_a','agent','mA')`).run();
    const s1 = addMsg(db, 'conv_dm_a', 'agent', '回复一');
    await expect(cmd('conversation.markRead', { conversationId: 'conv_dm_a', throughMessageSeq: s1 + 5 })).rejects.toThrow(/未来水位/);
    const st = db.prepare("SELECT last_read_seq FROM conversation_read_states WHERE conversation_id='conv_dm_a'").get() as { last_read_seq: number } | undefined;
    expect(st?.last_read_seq ?? 0).toBe(0); // 未吞未来
    db.close();
  });

  it('房间会话可标（本地用户）；标 A 不动 B（固定目标语义）；DM 他人会话拒绝', async () => {
    const { db, cmd } = makeDb();
    const rs = addMsg(db, 'conv_room', 'agent', '房间回复');
    const r = await cmd<{ advanced: boolean }>('conversation.markRead', { conversationId: 'conv_room', throughMessageSeq: rs });
    expect(r.advanced).toBe(true); // 房间会话（非 DM）本地用户可标
    // A/B 两 DM：标 A 不影响 B 水位。
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_a','human','u_local'),('p1','conv_dm_a','agent','mA'),('p1','conv_dm_b','human','u_local'),('p1','conv_dm_b','agent','mA')`).run();
    const aSeq = addMsg(db, 'conv_dm_a', 'agent', 'A 回复');
    addMsg(db, 'conv_dm_b', 'agent', 'B 回复');
    await cmd('conversation.markRead', { conversationId: 'conv_dm_a', throughMessageSeq: aSeq });
    const bState = db.prepare("SELECT last_read_seq FROM conversation_read_states WHERE conversation_id='conv_dm_b'").get() as { last_read_seq: number } | undefined;
    expect(bState?.last_read_seq ?? 0).toBe(0); // A 的标读绝不落在 B
    // 他人 DM（本地用户非参与者）：拒绝。
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_dm_x','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_x','human','u_other'),('p1','conv_dm_x','agent','mA')`).run();
    addMsg(db, 'conv_dm_x', 'agent', '他人会话');
    await expect(cmd('conversation.markRead', { conversationId: 'conv_dm_x', throughMessageSeq: 1 })).rejects.toThrow(/另一参与者/);
    db.close();
  });

  it('重启持久：新连接读 read_state 保持', async () => {
    const file = join(tmpRoot, 'dev18-restart.sqlite');
    let db = openDatabase(file);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mR','p1','协调','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mR')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
    db.prepare(`INSERT INTO conversation_read_states (project_id, conversation_id, viewer_id, last_read_seq) VALUES ('p1','conv_room','u_local',3)`).run();
    db.close();
    db = openDatabase(file); // 重启等价：新连接
    const st = db.prepare("SELECT last_read_seq FROM conversation_read_states WHERE conversation_id='conv_room' AND viewer_id='u_local'").get() as { last_read_seq: number };
    expect(st.last_read_seq).toBe(3);
    db.close();
  });
});

describe('DEV-18 首包：待我处理（mine.pending）', () => {
  it('同一会话多 REVIEW 任务不漏（逐任务）；交付绑定 pending 优先/最新回退/null 如实；验收后消失', async () => {
    const { db, cmd } = makeDb();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_a','human','u_local'),('p1','conv_dm_a','agent','mA')`).run();
    addReviewTask(db, 'task_multi_1', 'conv_dm_a', 'dm_turn', [{ revision: 1, status: 'pending' }]);
    addReviewTask(db, 'task_multi_2', 'conv_dm_a', 'dm_turn', [{ revision: 1, status: 'accepted' }, { revision: 2, status: 'pending' }]); // 同会话第二任务
    addReviewTask(db, 'task_no_pending', 'conv_dm_a', 'dm_turn', [{ revision: 1, status: 'changes_requested' }, { revision: 2, status: 'accepted' }]); // 无 pending→最新行回退
    addReviewTask(db, 'task_no_delivery', 'conv_dm_a', 'dm_turn', []); // 无任何交付→null
    const data = await cmd<{ projects: Array<{ projectId: string; reviewTasks: Array<{ task_id: string; delivery_id: string | null; revision: number | null; manifest_hash: string | null }>; dmUnread: unknown[] }> }>('mine.pending', {});
    const proj = data.projects.find((p) => p.projectId === 'p1');
    expect(proj).toBeTruthy();
    const ids = proj!.reviewTasks.map((t) => t.task_id);
    expect(ids).toEqual(['task_multi_1', 'task_multi_2', 'task_no_pending', 'task_no_delivery']); // 逐任务——不被 conversation LIMIT1 漏掉
    const byId = new Map(proj!.reviewTasks.map((t) => [t.task_id, t]));
    expect(byId.get('task_multi_1')!.delivery_id).toBe('dlv_task_multi_1_1'); // pending 绑定
    expect(byId.get('task_multi_2')!.revision).toBe(2); // 多版本取 pending（新版）
    expect(byId.get('task_no_pending')!.revision).toBeNull(); // 无 pending=不可批准对象（不因"最新回退"变成可验收——第二十三轮三）
    expect((byId.get('task_no_pending') as unknown as { actionable: boolean }).actionable).toBe(false); // 如实非 actionable
    expect(byId.get('task_no_delivery')!.delivery_id).toBeNull(); // 无交付如实 null（读卡片≠完成事项）
    expect(byId.get('task_multi_1')!.manifest_hash).toBe('mh_task_multi_1_1');
    // 验收完成后（status 离开 REVIEW）：从汇总消失（阅读不消待办——状态才消）。
    db.prepare(`UPDATE tasks SET status='DONE' WHERE id='task_multi_1'`).run();
    const data2 = await cmd<{ projects: Array<{ projectId: string; reviewTasks: Array<{ task_id: string }> }> }>('mine.pending', {});
    const proj2 = data2.projects.find((p) => p.projectId === 'p1');
    expect(proj2!.reviewTasks.map((t) => t.task_id)).not.toContain('task_multi_1');
    db.close();
  });

  it('DM 未读：agent 消息计数+最新序；阅读（markRead）后未读消失——但 REVIEW 待办仍在（阅读≠验收）', async () => {
    const { db, cmd } = makeDb();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_a','human','u_local'),('p1','conv_dm_a','agent','mA')`).run();
    addMsg(db, 'conv_dm_a', 'human', '用户消息'); // human 不计未读
    const a1 = addMsg(db, 'conv_dm_a', 'agent', '回复一');
    const a2 = addMsg(db, 'conv_dm_a', 'agent', '回复二');
    addReviewTask(db, 'task_rev', 'conv_dm_a', 'dm_turn', [{ revision: 1, status: 'pending' }]);
    const data = await cmd<{ projects: Array<{ dmUnread: Array<{ conversation_id: string; unread: number; last_agent_seq: number }> }> }>('mine.pending', {});
    const u = data.projects[0]!.dmUnread.find((x) => x.conversation_id === 'conv_dm_a');
    expect(u?.unread).toBe(2);
    expect(u?.last_agent_seq).toBe(a2);
    await cmd('conversation.markRead', { conversationId: 'conv_dm_a', throughMessageSeq: a1 }); // 读一部分
    const data2 = await cmd<{ projects: Array<{ dmUnread: unknown[]; reviewTasks: unknown[] }> }>('mine.pending', {});
    const u2 = (data2.projects[0]!.dmUnread as Array<{ conversation_id: string; unread: number }>).find((x) => x.conversation_id === 'conv_dm_a');
    expect(u2?.unread).toBe(1); // 只读到 a1——剩余 1 条未读（未读不因打开/轮询被吞）
    expect((data2.projects[0]!.reviewTasks as unknown[]).length).toBe(1); // 阅读不消待办
    db.close();
  });
});

describe('DEV-18 首包：深链（deepLink.resolve）', () => {
  it('dm/task/delivery/msg 真实归属定位；不存在/归属矛盾/非本人明确报错', async () => {
    const { db, cmd } = makeDb();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_a','human','u_local'),('p1','conv_dm_a','agent','mA')`).run();
    addReviewTask(db, 'task_dl', 'conv_dm_a', 'dm_turn', [{ revision: 3, status: 'pending' }]);
    const seq = addMsg(db, 'conv_dm_a', 'agent', '深链目标消息');
    const dm = await cmd<{ kind: string; projectId: string; conversationId: string }>('deepLink.resolve', { hash: '#dm=conv_dm_a' });
    expect(dm).toMatchObject({ kind: 'dm', projectId: 'p1', conversationId: 'conv_dm_a' });
    const task = await cmd<{ kind: string; taskId: string }>('deepLink.resolve', { hash: '#task=task_dl' });
    expect(task).toMatchObject({ kind: 'task', taskId: 'task_dl', projectId: 'p1' });
    const dlv = await cmd<{ kind: string; deliveryId: string; revision: number; manifestHash: string }>('deepLink.resolve', { hash: '#delivery=dlv_task_dl_3' });
    expect(dlv).toMatchObject({ kind: 'delivery', deliveryId: 'dlv_task_dl_3', revision: 3, manifestHash: 'mh_task_dl_3' });
    const msg = await cmd<{ kind: string; messageId: string; messageSeq: number }>('deepLink.resolve', { hash: `#msg=msg_conv_dm_a_${seq}` });
    expect(msg).toMatchObject({ kind: 'msg', messageId: `msg_conv_dm_a_${seq}`, messageSeq: seq });
    // 失效/矛盾/无权限——明确报错（不静默跳转）。
    await expect(cmd('deepLink.resolve', { hash: '#dm=conv_missing' })).rejects.toThrow(/不存在/);
    await expect(cmd('deepLink.resolve', { hash: '#dm=conv_room' })).rejects.toThrow(/矛盾/); // #dm 指向房间会话
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_dm_y','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_y','human','u_other'),('p1','conv_dm_y','agent','mA')`).run();
    await expect(cmd('deepLink.resolve', { hash: '#dm=conv_dm_y' })).rejects.toThrow(/audience 校验拒绝|不属于当前用户/); // 非本人 DM
    await expect(cmd('deepLink.resolve', { hash: '#bogus=1' })).rejects.toThrow(/格式无效/);
    db.close();
  });
});

describe('第二十三轮：线程水位/audience/交付绑定/不泄露', () => {
  function r23Db(): { db: ZhongshuoDatabase; cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T> } {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room1','p1','大厅','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','room1')`).run();
    // 两线程 + 各自锚消息/回复（conversation_seq 会话级递增）。
    let convSeq = 0;
    for (const tid of ['thA', 'thB']) {
      db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, last_message_seq) VALUES (?, 'p1', 'conv_room', 'room1', ?, 0)`).run(tid, `anchor_${tid}`);
      db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES (?, 'p1', 'conv_room', ?, 'room1', NULL, NULL, 'human', 'u_local', '{}', 'final', 0)`).run(`anchor_${tid}`, ++convSeq);
      const seq = (db.prepare('UPDATE conversation_threads SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq').get(tid) as { last_message_seq: number }).last_message_seq;
      db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES (?, 'p1', 'conv_room', ?, 'room1', ?, ?, 'agent', 'mA', '{}', 'final', 0)`).run(`reply_${tid}`, ++convSeq, tid, seq);
    }
    db.prepare(`UPDATE conversations SET last_message_seq = ? WHERE id = 'conv_room'`).run(convSeq);
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `r23-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
      if (!r.ok) throw Object.assign(new Error(r.error?.message), { code: r.error?.code });
      return r.data as T;
    };
    return { db, cmd };
  }

  it('thread.markRead：首标（无预插行）+同序幂等+未来序拒绝+标 A 不影响 B；mine.pending 线程未读聚合', async () => {
    const { db, cmd } = r23Db();
    const before = await cmd<{ projects: Array<{ threadUnread: Array<{ thread_id: string; unread: number }> }> }>('mine.pending', {});
    const tu = (before.projects[0]?.threadUnread ?? []);
    expect(tu.map((x) => x.thread_id).sort()).toEqual(['thA', 'thB']); // 两线程各 1 条未读（打开房间不读线程）
    const r1 = await cmd<{ advanced: boolean }>('thread.markRead', { threadId: 'thA', throughMessageSeq: 1 });
    expect(r1.advanced).toBe(true); // 首标=UPSERT 插行推进
    const r2 = await cmd<{ advanced: boolean }>('thread.markRead', { threadId: 'thA', throughMessageSeq: 1 });
    expect(r2.advanced).toBe(false); // 同序幂等
    await expect(cmd('thread.markRead', { threadId: 'thA', throughMessageSeq: 99 })).rejects.toThrow(/未来水位/); // 未来序拒绝
    const mid = await cmd<{ projects: Array<{ threadUnread: unknown[] }> }>('mine.pending', {});
    expect((mid.projects[0]?.threadUnread ?? []).map((x) => (x as { thread_id: string }).thread_id)).toEqual(['thB']); // 读 A 后 A 清、B 保持（互不影响）
    db.close();
  });

  it('audience 不泄露：他人 DM 的 REVIEW 任务/未读/深链（#task/#delivery/#msg 全形态）与 task.review 均拒绝', async () => {
    const { db, cmd } = r23Db();
    // 他人 DM：任务+交付+消息齐全。
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_other_dm','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_other_dm','human','u_other'),('p1','conv_other_dm','agent','mA')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status, review_policy) VALUES ('task_other','p1','conv_other_dm','dm_turn',NULL,'他人任务','REVIEW','user_review')`).run();
    db.prepare(`INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES ('dlv_other','task_other',1,'mh-other-0001','[]','[]','[]','pending')`).run();
    const seq = (db.prepare(`UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = 'conv_other_dm' RETURNING last_message_seq`).get() as { last_message_seq: number }).last_message_seq;
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES ('msg_other','p1','conv_other_dm',?,NULL,NULL,NULL,'agent','mA','{}','final',0)`).run(seq);
    // 汇总不泄露：他人 DM 的任务与未读均不出现。
    const pending = await cmd<{ projects: Array<{ reviewTasks: Array<{ task_id: string }>; dmUnread: unknown[] }> }>('mine.pending', {});
    const proj = pending.projects[0] ?? { reviewTasks: [], dmUnread: [] };
    expect(proj.reviewTasks.map((t) => t.task_id)).not.toContain('task_other');
    expect((proj.dmUnread as Array<{ conversation_id: string }>).map((x) => x.conversation_id)).not.toContain('conv_other_dm');
    // 深链全形态拒绝（链接形态不绕过私信限制）。
    await expect(cmd('deepLink.resolve', { hash: '#task=task_other' })).rejects.toThrow(/audience 校验拒绝/);
    await expect(cmd('deepLink.resolve', { hash: '#delivery=dlv_other' })).rejects.toThrow(/audience 校验拒绝/);
    await expect(cmd('deepLink.resolve', { hash: '#msg=msg_other' })).rejects.toThrow(/audience 校验拒绝/);
    // task.review 同一校验处：他人 DM 任务不能验收。
    await expect(cmd('task.review', { taskId: 'task_other', deliveryId: 'dlv_other', deliveryRevision: 1, manifestHash: 'mh-other-0001', decision: 'accept' })).rejects.toThrow(/audience 校验拒绝/);
    db.close();
  });

  it('task.review 三重绑定：manifestHash 错配拒绝；旧交付（superseded）不可验收；mine.pending actionable 区分', async () => {
    const { db, cmd } = r23Db();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_room','human','u_local')`).run(); // 房间无 DM 参与者概念——room 会话 audience=项目可达
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status, review_policy) VALUES ('task_mh','p1','conv_room','room_task','room1','hash 任务','REVIEW','user_review')`).run();
    db.prepare(`INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES ('dlv_mh','task_mh',1,'mh-correct-01','[]','[]','[]','pending')`).run();
    db.prepare(`INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES ('dlv_old','task_mh',2,'mh-superseded','[]','[]','[]','superseded')`).run();
    // hash 错配（同版本号不同内容）：明确拒绝。
    await expect(cmd('task.review', { taskId: 'task_mh', deliveryId: 'dlv_mh', deliveryRevision: 1, manifestHash: 'mh-wrong-9999', decision: 'accept' })).rejects.toThrow(/manifestHash 不匹配|交付内容不符/);
    // 汇总：pending 绑定 actionable=true；旧交付不作为可批准对象。
    const pending = await cmd<{ projects: Array<{ reviewTasks: Array<{ task_id: string; delivery_id: string | null; actionable: boolean }> }> }>('mine.pending', {});
    const row = (pending.projects[0]?.reviewTasks ?? []).find((t) => t.task_id === 'task_mh');
    expect(row?.delivery_id).toBe('dlv_mh');
    expect(row?.actionable).toBe(true);
    // 正确 hash 验收成功。
    const ok = await cmd<{ reviewStatus: string }>('task.review', { taskId: 'task_mh', deliveryId: 'dlv_mh', deliveryRevision: 1, manifestHash: 'mh-correct-01', decision: 'accept' });
    expect(ok.reviewStatus).toBe('accepted');
    db.close();
  });

  it('blockedTasks 如实列出（可见≠审批）：房间 BLOCKED 任务出现、他人 DM BLOCKED 不泄露', async () => {
    const { db, cmd } = r23Db();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('task_blk','p1','conv_room','room_task','room1','被阻塞任务','BLOCKED')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_dm2','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm2','human','u_other'),('p1','conv_dm2','agent','mA')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('task_blk_other','p1','conv_dm2','dm_turn',NULL,'他人阻塞','BLOCKED')`).run();
    const pending = await cmd<{ projects: Array<{ blockedTasks: Array<{ task_id: string }> }> }>('mine.pending', {});
    const ids = (pending.projects[0]?.blockedTasks ?? []).map((t) => t.task_id);
    expect(ids).toContain('task_blk'); // 本项目可见 BLOCKED 如实列出
    expect(ids).not.toContain('task_blk_other'); // 他人 DM 不泄露
    db.close();
  });
});
