import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, migrate } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase, Migration } from '../../src/persistence/db.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/index.ts';
import { runCommand, getReceipt } from '../../src/persistence/commandGateway.ts';
import { claimNextOutbox, completeOutbox, enqueueOutbox, listOutbox } from '../../src/persistence/outbox.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { domainOk } from '../../src/contracts/errors.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev02-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 基础种子：项目 + 人类成员 + agent 成员 + 房间 + 房间会话。 */
function seedBase(db: ZhongshuoDatabase): {
  projectId: string;
  roomId: string;
  conversationId: string;
} {
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', 'demo', 'D:/x', 'D:/x', '{"identityKey":"k1"}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type) VALUES
       ('m_human', 'p1', '我', 'human'),
       ('m_agent', 'p1', 'Codex', 'agent')`,
  ).run();
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_1', 'p1', '开发大厅', 'm_agent')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room_1', 'p1', 'room', 'room_1')`,
  ).run();
  return { projectId: 'p1', roomId: 'room_1', conversationId: 'conv_room_1' };
}

function openMemory(): ZhongshuoDatabase {
  const db = openDatabase(':memory:');
  seedBase(db);
  return db;
}

function makeSubmitInput(overrides: Partial<Parameters<typeof createRoomRootTask>[1]> = {}) {
  return {
    ids: {
      messageId: 'msg_1',
      threadId: 'thread_1',
      taskId: 'task_1',
      taskEventId: 'evt_task_1',
      threadEventId: 'evt_thread_1',
    },
    projectId: 'p1',
    conversationId: 'conv_room_1',
    roomId: 'room_1',
    intent: 'default' as const,
    title: '分析登录模块',
    body: '@全体 分析一下',
    mentions: [{ kind: 'all' }] as const,
    author: { authorType: 'human' as const, authorId: 'm_human' },
    reviewPolicy: 'auto_deliver' as const,
    sourceConnectionId: null,
    route: {
      kind: 'dispatch',
      mode: 'DELIBERATE',
      rosterSource: 'all',
      frozenMemberIds: ['m_agent'],
      initialWakeMemberIds: ['m_agent'],
    } as const,
    now: 1000,
    ...overrides,
  };
}

describe('迁移（§12.5）', () => {
  it('全新库：建全表、user_version=1、外键开启（WAL 断言见文件库用例）', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const expected of [
      'projects', 'conversations', 'dm_participants', 'conversation_threads', 'messages',
      'tasks', 'task_deliveries', 'workflow_runs', 'agent_turns', 'runtime_sessions',
      'domain_events', 'outbox', 'command_receipts', 'workspace_leases', 'synthesis_claims',
      'ratification_records', 'approvals', 'thread_agent_followers', 'reminders', 'reminder_occurrences',
      'file_comments', 'schema_migrations',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBeGreaterThanOrEqual(45);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const audit = db.prepare('SELECT id, name, checksum FROM schema_migrations').all();
    expect(audit.length).toBe(MIGRATIONS.length);
    db.close();
  });

  it('文件库：WAL 生效；:memory: 保持 memory（SQLite 限制，如实记录）', () => {
    const path = join(tmpRoot, 'wal.db');
    const db = openDatabase(path);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
    const mem = openDatabase(':memory:');
    expect(mem.pragma('journal_mode', { simple: true })).toBe('memory');
    mem.close();
  });

  it('重开迁移幂等：无待应用，审计不重复', () => {
    const path = join(tmpRoot, 'reopen.db');
    const first = openDatabase(path);
    expect(first.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    first.close();
    const second = openDatabase(path);
    const result = migrate(second);
    expect(result.applied).toEqual([]);
    expect(second.prepare('SELECT count(*) c FROM schema_migrations').get()).toMatchObject({
      c: MIGRATIONS.length,
    });
    second.close();
  });

  it('迁移失败：事务回滚、user_version 不变（拒绝启动写任务）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const bad: Migration = {
      id: 99,
      name: 'broken',
      up: (d) => {
        d.exec('CREATE TABLE broken (a');
      },
    };
    expect(() => migrate(db, {}, [bad])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(
      db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='broken'").get(),
    ).toMatchObject({ c: 0 });
    db.close();
  });

  it('已有数据的库升级：先备份再迁移（§12.5）', () => {
    const m1: Migration = { id: 1, name: 'm1', up: (d) => d.exec('CREATE TABLE a(x)') };
    const m2: Migration = { id: 2, name: 'm2', up: (d) => d.exec('CREATE TABLE b(y)') };
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, {}, [m1]);
    db.prepare('INSERT INTO a VALUES (1)').run();
    const backupDir = join(tmpRoot, 'backups');
    const result = migrate(db, { backupDir }, [m1, m2]);
    expect(result.applied).toEqual([2]);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    // 备份文件已生成（v1 状态副本，含数据）
    const backups = readdirSync(backupDir).filter((f) => f.startsWith('state-pre-v1-'));
    expect(backups.length).toBe(1);
    const backupDb = new Database(join(backupDir, backups[0]!));
    expect(backupDb.prepare('SELECT count(*) c FROM a').get()).toMatchObject({ c: 1 });
    expect(backupDb.prepare("SELECT count(*) c FROM sqlite_master WHERE name='b'").get()).toMatchObject({ c: 0 });
    backupDb.close();
    db.close();
  });
});

describe('事务命令去重（开工契约 §3.2 / RT-01）', () => {
  it('同 scope+commandId+hash 重复提交 → 一个任务、一个运行性写入，返回相同逻辑结果', () => {
    const db = openMemory();
    let counter = 0;
    const exec = () =>
      runCommand(db, { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'hash_a', now: 1 }, () => {
        counter += 1;
        return createRoomRootTask(db, makeSubmitInput());
      });

    const first = exec();
    expect(first.ok).toBe(true);
    expect(first.ok && first.replayed).toBe(false);
    const second = exec();
    expect(second.ok).toBe(true);
    expect(second.ok && second.replayed).toBe(true);
    expect(counter).toBe(1); // handler 只执行一次
    if (first.ok && second.ok) {
      expect(second.data).toEqual(first.data);
    }
    expect(db.prepare('SELECT count(*) c FROM tasks').get()).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT count(*) c FROM messages').get()).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT count(*) c FROM conversation_threads').get()).toMatchObject({ c: 1 });
    db.close();
  });

  it('同键不同 payloadHash → IDEMPOTENCY_CONFLICT，不产生新业务行', () => {
    const db = openMemory();
    const first = runCommand(
      db,
      { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'hash_a', now: 1 },
      () => createRoomRootTask(db, makeSubmitInput()),
    );
    expect(first.ok).toBe(true);
    const conflict = runCommand(
      db,
      { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'hash_b', now: 2 },
      () => createRoomRootTask(db, makeSubmitInput({ ids: { ...makeSubmitInput().ids, taskId: 'task_2', messageId: 'msg_2', threadId: 'thread_2' } })),
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(db.prepare('SELECT count(*) c FROM tasks').get()).toMatchObject({ c: 1 });
    db.close();
  });

  it('不同 scope 同键互不干扰（幂等记录按主体/连接隔离）', () => {
    const db = openMemory();
    const a = runCommand(db, { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'h', now: 1 }, () => 'A');
    const b = runCommand(db, { idempotencyScope: 'conn:conn_9', commandId: 'cmd-12345678', payloadHash: 'h', now: 1 }, () => 'B');
    expect(a).toMatchObject({ ok: true, data: 'A' });
    expect(b).toMatchObject({ ok: true, data: 'B' });
    db.close();
  });

  it('handler 抛错 → 整事务回滚：无回执、无业务行、报 STORAGE_UNAVAILABLE', () => {
    const db = openMemory();
    const outcome = runCommand(
      db,
      { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'h', now: 1 },
      () => {
        createRoomRootTask(db, makeSubmitInput());
        throw new Error('boom after business write');
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'STORAGE_UNAVAILABLE' } });
    expect(getReceipt(db, 'user:u1', 'cmd-12345678')).toBeUndefined();
    expect(db.prepare('SELECT count(*) c FROM tasks').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT count(*) c FROM messages').get()).toMatchObject({ c: 0 });
    db.close();
  });
});

describe('重启持久化（RT-02/§9.3 G1）', () => {
  it('事务提交后关库重开：任务/消息/线程/事件/outbox 全部保留，outbox 待派发', () => {
    const path = join(tmpRoot, 'restart.db');
    const db = openDatabase(path);
    seedBase(db);
    const outcome = runCommand(
      db,
      { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'h', now: 1 },
      () => createRoomRootTask(db, makeSubmitInput()),
    );
    expect(outcome.ok).toBe(true);
    db.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare('SELECT count(*) c FROM tasks').get()).toMatchObject({ c: 1 });
    expect(reopened.prepare('SELECT count(*) c FROM messages').get()).toMatchObject({ c: 1 });
    expect(reopened.prepare('SELECT count(*) c FROM conversation_threads').get()).toMatchObject({ c: 1 });
    expect(reopened.prepare('SELECT count(*) c FROM domain_events').get()).toMatchObject({ c: 2 });
    const outbox = listOutbox(reopened, 'pending');
    expect(outbox.length).toBe(1);
    expect(outbox[0]?.dispatch_key).toBe('task:task_1:initial');
    reopened.close();
  });
});

describe('outbox（§11.2/§11.3/RT-05）', () => {
  it('重复入队同 dispatchKey → 同一行，不二次派发（RT-05）', () => {
    const db = openMemory();
    const a = enqueueOutbox(db, { dispatchKey: 'k1' });
    const b = enqueueOutbox(db, { dispatchKey: 'k1' });
    expect(a.id).toBe(b.id);
    expect(listOutbox(db)).toHaveLength(1);
    db.close();
  });

  it('CAS 领取：租约内他人不可再领；租约过期可回收；错误代次不可完结', () => {
    const db = openMemory();
    enqueueOutbox(db, { dispatchKey: 'k1' });
    const claimed = claimNextOutbox(db, { leaseOwner: 'w1', leaseUntil: 1000, now: 100 });
    expect(claimed).toMatchObject({ dispatch_key: 'k1', status: 'leased', lease_owner: 'w1', attempt_epoch: 1 });
    // 租约未过期：无可领取
    expect(claimNextOutbox(db, { leaseOwner: 'w2', leaseUntil: 2000, now: 150 })).toBeNull();
    // 过期回收
    const reclaimed = claimNextOutbox(db, { leaseOwner: 'w2', leaseUntil: 5000, now: 2000 });
    expect(reclaimed).toMatchObject({ lease_owner: 'w2', attempt_epoch: 2 });
    // 旧代次完结失败（fencing）
    expect(completeOutbox(db, reclaimed!.id, 1)).toBe(false);
    expect(listOutbox(db, 'done')).toHaveLength(0);
    // 当前代次完结成功
    expect(completeOutbox(db, reclaimed!.id, 2)).toBe(true);
    expect(listOutbox(db, 'done')).toHaveLength(1);
    db.close();
  });
});

describe('createRoomRootTask 单事务写入路径（§3.4/§12.3）', () => {
  it('dispatch 路由：消息+线程+任务+事件+outbox 一次落库，任务号分配', () => {
    const db = openMemory();
    const r = createRoomRootTask(db, makeSubmitInput());
    expect(r).toMatchObject({
      ok: true,
      value: { conversationSeq: 1, taskId: 'task_1', roomTaskNumber: 1, disposition: 'queued' },
    });
    const thread = db
      .prepare('SELECT root_task_id, anchor_message_id FROM conversation_threads WHERE id = ?')
      .get('thread_1') as { root_task_id: string; anchor_message_id: string };
    expect(thread).toMatchObject({ root_task_id: 'task_1', anchor_message_id: 'msg_1' });
    expect(listOutbox(db, 'pending').map((o) => o.dispatch_key)).toEqual(['task:task_1:initial']);
    db.close();
  });

  it('record_only：只存消息与记录串（root_task_id NULL），零任务零 outbox', () => {
    const db = openMemory();
    const r = createRoomRootTask(
      db,
      makeSubmitInput({
        intent: 'record_only',
        route: { kind: 'record_only', reason: 'explicit_record_only' },
        mentions: [{ kind: 'all' }],
      }),
    );
    expect(r).toMatchObject({ ok: true, value: { taskId: null, roomTaskNumber: null, disposition: 'none' } });
    expect(db.prepare('SELECT count(*) c FROM tasks').get()).toMatchObject({ c: 0 });
    expect(listOutbox(db)).toHaveLength(0);
    const thread = db
      .prepare('SELECT root_task_id FROM conversation_threads WHERE id = ?')
      .get('thread_1') as { root_task_id: string | null };
    expect(thread.root_task_id).toBeNull();
    db.close();
  });

  it('归档房间拒绝新增根任务', () => {
    const db = openMemory();
    db.prepare('UPDATE conversations SET archived_at = 5 WHERE id = ?').run('conv_room_1');
    const r = createRoomRootTask(db, makeSubmitInput());
    expect(r).toMatchObject({ ok: false, error: { code: 'ROOM_ARCHIVED' } });
    db.close();
  });

  it('第二个任务：conversation_seq 与房间任务号各自递增', () => {
    const db = openMemory();
    createRoomRootTask(db, makeSubmitInput());
    const r2 = createRoomRootTask(
      db,
      makeSubmitInput({
        ids: { messageId: 'msg_2', threadId: 'thread_2', taskId: 'task_2', taskEventId: 'e2', threadEventId: 'e3' },
      }),
    );
    expect(r2).toMatchObject({ ok: true, value: { conversationSeq: 2, roomTaskNumber: 2 } });
    db.close();
  });
});

describe('组合约束与 CHECK 反例（§12.2/§12.3/开工契约 §2.2）', () => {
  it('dm_turn 任务携带 room 字段 → CHECK 拒绝', () => {
    const db = openMemory();
    db.prepare(
      `INSERT INTO conversations (id, project_id, kind) VALUES ('conv_dm_1', 'p1', 'dm')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title)
         VALUES ('t_dm', 'p1', 'conv_dm_1', 'dm_turn', 'room_1', 'x')`,
      ).run(),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('同一 anchor 第二个线程 → 唯一索引拒绝', () => {
    const db = openMemory();
    createRoomRootTask(db, makeSubmitInput());
    expect(() =>
      db.prepare(
        `INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id)
         VALUES ('thread_dup', 'p1', 'conv_room_1', 'room_1', 'msg_1')`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('同房间重复任务号 / 同根消息第二个根任务 → 拒绝', () => {
    const db = openMemory();
    createRoomRootTask(db, makeSubmitInput());
    expect(() =>
      db.prepare(
        `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, created_at)
         VALUES ('msg_x', 'p1', 'conv_room_1', 2, 'room_1', 'human', 'm_human', '{}', 1)`,
      ).run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, root_message_id, room_task_number, title)
         VALUES ('t_dup_num', 'p1', 'conv_room_1', 'room_task', 'room_1', 'msg_x', 1, 'x')`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db.prepare(
        `INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, root_message_id, room_task_number, title)
         VALUES ('t_dup_root', 'p1', 'conv_room_1', 'room_task', 'room_1', 'msg_1', 2, 'x')`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('消息 thread_id 与 thread_message_seq 必须同生同灭；via_connection_id 仅 human', () => {
    const db = openMemory();
    expect(() =>
      db.prepare(
        `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, created_at)
         VALUES ('m1', 'p1', 'conv_room_1', 1, 'room_1', NULL, 3, 'human', 'm_human', '{}', 1)`,
      ).run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare(
        `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, via_connection_id, body_json, created_at)
         VALUES ('m2', 'p1', 'conv_room_1', 1, 'room_1', 'agent', 'm_agent', 'conn_1', '{}', 1)`,
      ).run(),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('room 会话缺 roomId / dm 会话带 roomId → CHECK 拒绝；同房间第二个会话 → 唯一拒绝', () => {
    const db = openMemory();
    expect(() =>
      db.prepare(`INSERT INTO conversations (id, project_id, kind) VALUES ('c_bad', 'p1', 'room')`).run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare(
        `INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c_bad2', 'p1', 'dm', 'room_1')`,
      ).run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare(
        `INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c_dup', 'p1', 'room', 'room_1')`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('交付：not_required 不得携带人工记录；同任务第二个 pending → 唯一拒绝', () => {
    const db = openMemory();
    createRoomRootTask(db, makeSubmitInput());
    expect(() =>
      db.prepare(
        `INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status, reviewed_by, reviewed_at)
         VALUES ('d1', 'task_1', 1, 'h', '[]', '[]', '[]', 'not_required', 'm_human', 1)`,
      ).run(),
    ).toThrow(/CHECK/i);
    db.prepare(
      `INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
       VALUES ('d1', 'task_1', 1, 'h', '[]', '[]', '[]', 'pending')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
         VALUES ('d2', 'task_1', 2, 'h', '[]', '[]', '[]', 'pending')`,
      ).run(),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('DM session 复用键 (project,conversation,member,generation) 唯一（scope_kind=dm）', () => {
    const db = openMemory();
    db.prepare(`INSERT INTO conversations (id, project_id, kind) VALUES ('conv_dm_1', 'p1', 'dm')`).run();
    const ins = db.prepare(
      `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, member_id, session_generation, cwd)
       VALUES (?, 'p1', 'conv_dm_1', 'dm', 'm_agent', ?, 'D:/x')`,
    );
    ins.run('s1', 0);
    expect(() => ins.run('s2', 0)).toThrow(/UNIQUE/i);
    expect(() => ins.run('s3', 1)).not.toThrow();
    db.close();
  });
});

describe('runCommand 与 domain 纯函数联合（域结果原样落回执）', () => {
  it('DomainResult 数据可序列化重放', () => {
    const db = openMemory();
    const first = runCommand(db, { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'h', now: 1 }, () =>
      domainOk({ a: 1, nested: { b: [1, 2] } }),
    );
    expect(first).toMatchObject({ ok: true, replayed: false });
    const replay = runCommand(db, { idempotencyScope: 'user:u1', commandId: 'cmd-12345678', payloadHash: 'h', now: 2 }, () =>
      domainOk({ a: 999 }),
    );
    expect(replay).toMatchObject({ ok: true, replayed: true, data: { value: { a: 1, nested: { b: [1, 2] } } } });
    db.close();
  });
});
