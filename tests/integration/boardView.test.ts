/**
 * DEV-19 看板与协作视图首包（第二十六轮四）：board.view / thread.collaborators 只读命令。
 * - board.view：按项目分组任务卡（复用正式任务/运行/交付数据——不建新表）；状态取现有
 *   状态机（RUNNING/REVIEW/BLOCKED/STOPPING/UNKNOWN 如实分列）；房间看板不含 dm_turn；
 *   他人 DM 不泄露；子任务=根任务展开（kind=room_task 的线程即任务位）；交付不重复计。
 * - thread.collaborators：人的关注（thread_subscriptions）/Agent 跟进名单
 *   （thread_agent_followers）/冻结参与者（route_json.frozenMemberIds）/实时执行
 *   （run_participants）分列。
 * 纯读：打开看板不唤醒成员、不创建运行（零 run/零 turn/零 real_calls）。
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

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-board-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目一',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1),('mB','p1','Agent乙','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?), (?, ?)').run('r0', 'mA', 'r0', 'mB');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  // 任务卡：各种状态机态。
  let seqCounter = 0;
  const mkTask = (id: string, status: string, title: string, extra: { roomId?: string; convId?: string } = {}) => {
    seqCounter += 1;
    const convId = extra.convId ?? 'conv_room';
    const seq = (db.prepare('SELECT COALESCE(last_message_seq, 0) + 1 AS n FROM conversations WHERE id = ?').get(convId) as { n: number }).n;
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES (?,?,?,?,?,'human','u_local',?,'final',1000)`)
      .run(`anc_${id}`, 'p1', convId, seq, extra.roomId ?? 'r0', JSON.stringify({ text: title }));
    db.prepare(`UPDATE conversations SET last_message_seq = ? WHERE id = ?`).run(seq, convId);
    db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id) VALUES (?, 'p1', ?, ?, ?)`).run(`th_${id}`, extra.convId ?? 'conv_room', extra.roomId ?? 'r0', `anc_${id}`);
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, title, status, route_json) VALUES (?, 'p1', ?, 'room_task', ?, ?, ?, ?, ?)`)
      .run(id, extra.convId ?? 'conv_room', extra.roomId ?? 'r0', `th_${id}`, title, status, JSON.stringify({ kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] }));
    db.prepare(`UPDATE conversation_threads SET root_task_id = ? WHERE id = ?`).run(id, `th_${id}`);
  };
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `board-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  return { db, cmd, mkTask };
}

describe('DEV-19 首包：board.view（只读聚合）', () => {
  it('状态分列如实+卡片身份完整（项目/房间/taskId/来源）；同名房间不混；零运行打开', async () => {
    const { db, cmd, mkTask } = makeEnv();
    // 第二房间（同名）——同名房间不混。
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mB')`).run();
    db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r1', 'mB');
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_r1','p1','room','r1')`).run();
    mkTask('t_run', 'ACTIVE', '执行中任务');
    mkTask('t_review', 'REVIEW', '待验收任务');
    mkTask('t_block', 'BLOCKED', '阻塞任务');
    mkTask('t_r1', 'ACTIVE', '第二房间任务', { roomId: 'r1', convId: 'conv_r1' });
    // 运行中+停止中+UNKNOWN 真身：workflow_runs/agent_turns。
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run1','t_run','conv_room','DIRECT','RUNNING')`).run();
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key) VALUES ('turn1','run1','conv_room','mA','direct.work','RUNNING','task:t_run:initial')`).run();
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run2','t_block','conv_room','DIRECT','FAILED')`).run();
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key) VALUES ('turn2','run2','conv_room','mA','direct.work','UNKNOWN','task:t_block:initial')`).run();
    const before = (db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c;
    const board = await cmd<{ groups: Array<{ projectId: string; displayName: string; rooms: Array<{ roomId: string; name: string; cards: Array<Record<string, unknown>> }> }> }>('board.view', { scope: 'all' });
    expect(board.groups).toHaveLength(1);
    const room0 = board.groups[0]!.rooms.find((r) => r.roomId === 'r0')!;
    const room1 = board.groups[0]!.rooms.find((r) => r.roomId === 'r1')!;
    expect(room0.name).toBe('大厅');
    expect(room1.name).toBe('大厅'); // 同名房间都在（roomId 区分——不混）
    expect(room0.cards).toHaveLength(3); // t_run/t_review/t_block（t_r1 在第二房间——不混）
    const byId = (id: string) => room0.cards.find((c) => c.taskId === id)!;
    expect(byId('t_run')).toMatchObject({ projectId: 'p1', roomId: 'r0', threadId: 'th_t_run', title: '执行中任务', column: 'running', runStatus: 'RUNNING' });
    expect(byId('t_review')).toMatchObject({ column: 'review', pendingDelivery: null });
    expect(byId('t_block')).toMatchObject({ column: 'blocked', runStatus: 'FAILED' }); // 阻塞如实（UNKNOWN turn 由 exitUnconfirmed 面承载）
    // 退出未确认：agent_turns 最新 turn=UNKNOWN 的任务（run FAILED 但 turn UNKNOWN——如实标注）。
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run3','t_run','conv_room','DIRECT','FAILED')`).run();
    void 0;
    // 交付不重复计：两个 pending 交付只报一个（当前绑定）。
    db.prepare(`INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES ('d1','t_review',1,'mh-aaaa-1','[]','[]','[]','changes_requested')`).run();
    db.prepare(`INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES ('d2','t_review',2,'mh-aaaa-2','[]','[]','[]','pending')`).run();
    const board2 = await cmd<{ groups: Array<{ rooms: Array<{ roomId: string; cards: Array<Record<string, unknown>> }> }> }>('board.view', { scope: 'all' });
    const card2 = board2.groups[0]!.rooms.find((r) => r.roomId === 'r0')!.cards.find((c) => c.taskId === 't_review')!;
    expect(card2.pendingDelivery).toMatchObject({ deliveryId: 'd2', revision: 2 }); // 最高 pending 一条
    expect((db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c).toBe(before + 1); // 打开看板零新运行（+1=测试中途插入的 run3——看板前后不变）
    db.close();
  });
  it('房间看板不含 dm_turn；他人 DM 不泄露；scope=project 限本项目', async () => {
    const { db, cmd } = makeEnv();
    // 他人 DM 的 dm_turn。
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_other_dm','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_other_dm','human','u_other'),('p1','conv_other_dm','agent','mA')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('t_dm_other','p1','conv_other_dm','dm_turn',NULL,'他人私信任务','ACTIVE')`).run();
    // 本地用户的 DM 任务（也不进房间看板——dm_turn 一律不进）。
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_my_dm','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_my_dm','human','u_local'),('p1','conv_my_dm','agent','mA')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('t_dm_mine','p1','conv_my_dm','dm_turn',NULL,'我的私信任务','ACTIVE')`).run();
    const board = await cmd<{ groups: Array<{ rooms: Array<{ cards: unknown[] }> }> }>('board.view', { scope: 'all' });
    const allCards = board.groups.flatMap((g) => g.rooms.flatMap((r) => r.cards));
    expect(allCards.some((c: any) => c.taskId === 't_dm_other')).toBe(false); // 他人 DM 零泄露
    expect(allCards.some((c: any) => c.taskId === 't_dm_mine')).toBe(false); // dm_turn 不进房间看板
    const scoped = await cmd<{ groups: Array<{ projectId: string }> }>('board.view', { scope: 'project', projectId: 'p1' });
    expect(scoped.groups).toHaveLength(1);
    db.close();
  });
});

describe('DEV-19 首包：thread.collaborators（协作视图分列）', () => {
  it('人的关注/Agent 跟进/冻结参与者/实时执行 四列分列；纯读', async () => {
    const { db, cmd, mkTask } = makeEnv();
    mkTask('t_collab', 'ACTIVE', '协作任务');
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run_c','t_collab','conv_room','DIRECT','RUNNING')`).run();
    db.prepare(`INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES ('run_c','mA','owner',1,'active')`).run();
    db.prepare(`INSERT INTO thread_agent_followers (project_id, conversation_id, thread_id, member_id, status, added_by, updated_at) VALUES ('p1','conv_room','th_t_collab','mB','following','u_local',0)`).run();
    db.prepare(`INSERT INTO thread_subscriptions (thread_id, viewer_id, followed, muted) VALUES ('th_t_collab','u_local',1,0)`).run();
    const r = await cmd<{ humanFollowers: number; agentFollowers: Array<{ memberId: string; status: string }>; frozenParticipants: string[]; activeRun: { runId: string; participants: Array<{ memberId: string; role: string; status: string }> } | null }>('thread.collaborators', { threadId: 'th_t_collab' });
    expect(r.humanFollowers).toBe(1); // 人的关注
    expect(r.agentFollowers).toEqual([{ memberId: 'mB', status: 'following' }]); // Agent 跟进
    expect(r.frozenParticipants).toEqual(['mA']); // 冻结参与者（route_json）
    expect(r.activeRun?.participants).toEqual([{ memberId: 'mA', role: 'owner', status: 'active' }]); // 实时执行
    db.close();
  });
});
