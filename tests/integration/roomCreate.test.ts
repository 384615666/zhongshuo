/**
 * room.create + 跨房间隔离（M1 收口轮）：建房引导（房间/会话/成员关系）、
 * room.pool 房间限定（不混其他房间线程）、UI 跨房间切换的前置数据面。
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1),('m2','p1','乙','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','默认房间','m1')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
}

const env = (method: string, params: unknown) => ({ protocolVersion: 1 as const, commandId: `cmd-room-${Math.random().toString(36).slice(2)}`, method, params });
const deps = (db: ZhongshuoDatabase) => ({ db, localUserId: 'u', interruptTurn: async () => {} });

describe('room.create（建房命令）', () => {
  it('建房引导房间/会话/成员关系；room.list 可见；重复名允许（房间非唯一键）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const r = (await dispatchDaemonCommand(deps(db), env('room.create', { projectId: 'p1', name: '作战室' }))) as { ok: boolean; data?: { room: { id: string; conversationId: string } } };
    expect(r.ok).toBe(true);
    expect(r.data!.room.conversationId).toMatch(/^conv_/);
    // 房间、会话、成员关系三表齐备（只读断言）。
    expect(db.prepare('SELECT count(*) c FROM rooms WHERE id = ?').get(r.data!.room.id)).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT count(*) c FROM conversations WHERE room_id = ? AND kind = ?').get(r.data!.room.id, 'room')).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT count(*) c FROM room_members WHERE room_id = ?').get(r.data!.room.id)).toMatchObject({ c: 2 });
    const listed = (await dispatchDaemonCommand(deps(db), env('room.list', { projectId: 'p1' }))) as { data: { items: Array<{ id: string }> } };
    expect(listed.data.items.some((x) => x.id === r.data!.room.id)).toBe(true);
    // 指定子集成员。
    const r2 = (await dispatchDaemonCommand(deps(db), env('room.create', { projectId: 'p1', name: '小房间', memberIds: ['m2'] }))) as { data: { room: { id: string } } };
    expect(db.prepare('SELECT count(*) c FROM room_members WHERE room_id = ?').get(r2.data.room.id)).toMatchObject({ c: 1 });
    db.close();
  });

  it('room.pool 房间限定：另一房间的线程不混入', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const r2 = (await dispatchDaemonCommand(deps(db), env('room.create', { projectId: 'p1', name: '房间二' }))) as { data: { room: { id: string; conversationId: string } } };
    // 两个房间各放一条根消息（走 insertThreadMessage 之外的最小 SQL：anchor+thread）。
    for (const [roomId, convId, tag] of [['r1', 'c1', 'A'] as const, [r2.data.room.id, r2.data.room.conversationId, 'B'] as const]) {
      db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES (?, 'p1', ?, 1, ?, 'human', 'u', ?, 'saved', 0)`).run(`msg_${tag}`, convId, roomId, JSON.stringify({ text: `根消息${tag}` }));
      db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id) VALUES (?, 'p1', ?, ?, ?)`).run(`th_${tag}`, convId, roomId, `msg_${tag}`);
    }
    const poolA = (await dispatchDaemonCommand(deps(db), env('room.pool', { roomId: 'r1' }))) as { data: { items: Array<{ threadId: string; body: { text: string } }> } };
    const poolB = (await dispatchDaemonCommand(deps(db), env('room.pool', { roomId: r2.data.room.id }))) as { data: { items: Array<{ threadId: string; body: { text: string } }> } };
    expect(poolA.data.items.map((i) => i.body.text)).toEqual(['根消息A']);
    expect(poolB.data.items.map((i) => i.body.text)).toEqual(['根消息B']);
    db.close();
  });
});
