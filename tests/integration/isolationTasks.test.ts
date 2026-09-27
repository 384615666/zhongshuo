import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';

/**
 * TH-02/TH-03 存储级：同房间双任务并行/交错，回复、会话、成果各归各线程；
 * 上下文组装不串线（§17.6：切换上下文不改变输出去向）。
 */
function seed(db: ZhongshuoDatabase): void {
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', 'demo', 'D:/x', 'D:/x', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES
       ('m_human', 'p1', '我', 'human', 1), ('m_a', 'p1', '甲', 'agent', 1), ('m_b', 'p1', '乙', 'agent', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_1', 'p1', '大厅', 'm_a')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room_1', 'p1', 'room', 'room_1')`,
  ).run();
}

function directTask(n: number, memberId: string) {
  return {
    ids: {
      messageId: `msg_root_${n}`,
      threadId: `thread_${n}`,
      taskId: `task_${n}`,
      taskEventId: `evt_task_${n}`,
      threadEventId: `evt_thread_${n}`,
    },
    projectId: 'p1',
    conversationId: 'conv_room_1',
    roomId: 'room_1',
    intent: 'default' as const,
    title: `任务${n}`,
    body: `请处理 ${n}`,
    mentions: [{ kind: 'member', memberId }] as const,
    author: { authorType: 'human' as const, authorId: 'm_human' },
    reviewPolicy: 'auto_deliver' as const,
    sourceConnectionId: null,
    route: {
      kind: 'dispatch',
      mode: 'DIRECT',
      targetMemberId: memberId,
      frozenMemberIds: [memberId],
      initialWakeMemberIds: [memberId],
    } as const,
    now: 1000 + n,
  };
}

describe('双任务不串线（TH-02/TH-03 存储级）', () => {
  it('A/B 两任务交错执行：回复各归各线程、各任务一个 run、会话按任务隔离', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    createRoomRootTask(db, directTask(1, 'm_a'));
    createRoomRootTask(db, directTask(2, 'm_b'));

    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1' });
    // 交错：先 A 后 B（worker 串行执行；隔离不依赖前端焦点）。
    expect(await worker.drain()).toBe(2);

    // 每任务恰一个 run，各自成员。
    const runs = db.prepare('SELECT task_id, status, thread_id FROM workflow_runs ORDER BY task_id').all() as Array<{ task_id: string; status: string; thread_id: string }>;
    expect(runs).toEqual([
      { task_id: 'task_1', status: 'SUCCEEDED', thread_id: 'thread_1' },
      { task_id: 'task_2', status: 'SUCCEEDED', thread_id: 'thread_2' },
    ]);

    // 回复落在正确线程：thread_1 一条、thread_2 一条，作者分别为 m_a/m_b。
    const reply1 = db.prepare('SELECT author_id FROM messages WHERE thread_id = ?').get('thread_1');
    const reply2 = db.prepare('SELECT author_id FROM messages WHERE thread_id = ?').get('thread_2');
    expect(reply1).toMatchObject({ author_id: 'm_a' });
    expect(reply2).toMatchObject({ author_id: 'm_b' });
    // 主池（thread_id IS NULL）只有两条根消息，无 agent 长回复泄漏。
    expect(db.prepare('SELECT count(*) c FROM messages WHERE thread_id IS NULL').get()).toMatchObject({ c: 2 });

    // 会话按 (member, conversation, generation) 各自隔离——每任务一个 session，成员不同。
    const sessions = db.prepare('SELECT member_id, task_id, scope_kind FROM runtime_sessions ORDER BY member_id').all() as Array<{ member_id: string; task_id: string; scope_kind: string }>;
    expect(sessions).toEqual([
      { member_id: 'm_a', task_id: 'task_1', scope_kind: 'task' },
      { member_id: 'm_b', task_id: 'task_2', scope_kind: 'task' },
    ]);

    // 双方 DONE。
    expect(db.prepare("SELECT count(*) c FROM tasks WHERE status = 'DONE'").get()).toMatchObject({ c: 2 });
    await adapter.closeAllSessions();
    db.close();
  });

  it('同一成员先后两个任务：输入包互不包含对方线程内容（FIX-6）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    createRoomRootTask(db, directTask(3, 'm_a'));
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1' });
    await worker.runOnce(); // 任务 3 完成（产生串内回复）

    createRoomRootTask(db, directTask(4, 'm_a')); // 同成员第二个任务
    await worker.runOnce();

    // 每个任务一个 bundle；按任务归属断言。
    const perTask = db
      .prepare(
        `SELECT r.task_id AS task_id, cb.included_refs_json
         FROM context_bundles cb
         JOIN agent_turns at ON at.id = cb.turn_id
         JOIN workflow_runs r ON r.id = at.run_id
         ORDER BY r.task_id`,
      )
      .all() as Array<{ task_id: string; included_refs_json: string }>;
    expect(perTask).toHaveLength(2);
    const task3 = perTask.find((x) => x.task_id === 'task_3')!;
    const task4 = perTask.find((x) => x.task_id === 'task_4')!;
    const included3 = JSON.parse(task3.included_refs_json).included as Array<{ kind: string; refId: string }>;
    const included4 = JSON.parse(task4.included_refs_json).included as Array<{ kind: string; refId: string }>;
    // 各自只含自己的指令与本线程消息；任务 4 的输入不含任务 3 线程的任何消息。
    expect(included3.map((x) => x.refId)).toContain('task:task_3:goal');
    const msgRefs4 = included4.filter((x) => x.kind === 'message');
    const task3ThreadMessages = db
      .prepare('SELECT id FROM messages WHERE thread_id = ?')
      .all('thread_3') as Array<{ id: string }>;
    for (const m of task3ThreadMessages) {
      expect(msgRefs4.some((x) => x.refId === m.id)).toBe(false);
    }
    await adapter.closeAllSessions();
    db.close();
  });
});
