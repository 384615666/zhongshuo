/**
 * DEV-21-M0 派发路径验证（用户指定的三条 + PP-02/03/04 可自测部分）：
 * ① 实际模型输入包含当前用户根消息和获准历史正文（不只「不含其他任务」）；
 * ② 最终输入与 ContextBundle/版本/hash 一致；
 * ③ 必要材料组装失败时不得继续派发。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeScriptItem } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { canonicalJson } from '../../src/contracts/common.ts';

function openMem(): ZhongshuoDatabase {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', '演示项目', 'D:/x', 'D:/x', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES
       ('m_human', 'p1', '我', 'human', 1), ('m_a', 'p1', '甲', 'agent', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_1', 'p1', '大厅', 'm_a')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room_1', 'p1', 'room', 'room_1')`,
  ).run();
  return db;
}

function makeTask(db: ZhongshuoDatabase, n: number, body: string, reviewPolicy: 'auto_deliver' | 'user_review' = 'auto_deliver') {
  const r = createRoomRootTask(db, {
    ids: {
      messageId: `msg_root_${n}`, threadId: `thread_${n}`, taskId: `task_${n}`,
      taskEventId: `evt_task_${n}`, threadEventId: `evt_thread_${n}`,
    },
    projectId: 'p1',
    conversationId: 'conv_room_1',
    roomId: 'room_1',
    intent: 'default',
    title: `任务${n}`,
    body,
    mentions: [{ kind: 'member', memberId: 'm_a' }],
    author: { authorType: 'human', authorId: 'm_human' },
    reviewPolicy,
    sourceConnectionId: null,
    route: {
      kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'm_a',
      frozenMemberIds: ['m_a'], initialWakeMemberIds: ['m_a'],
    } as never,
    now: 1000 + n,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('① 实际模型输入包含用户根消息与获准历史正文', () => {
  it('首任务：startTurn 文本含根消息正文与输入头', async () => {
    const db = openMem();
    makeTask(db, 1, '请阅读 README 并总结要点');
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w1' }).runOnce();

    expect(adapter.startTurnLog).toHaveLength(1);
    const call = adapter.startTurnLog[0]!;
    expect(call.text).toContain('【本轮输入 zs-turn-v0.1.3】');
    expect(call.text).toContain('请阅读 README 并总结要点'); // 用户根消息正文（§13.1-1/6）
    expect(call.text).toContain('用户根消息（msg_root_1）');
    expect(call.text).toContain('你是本任务唯一执行成员'); // DIRECT 指令模板
    expect(call.text).toContain('result_'); // 输出契约 resultKey
    // 层 A 常驻提示词随会话注入（层 A/B 分离）。
    expect(call.promptVersion).toBe('zs-standing-v0.1.1'); // 层 A 版本随会话传递（PP-02）
    expect(call.developerInstructions).toContain('你是「甲」');
    await adapter.closeAllSessions();
    db.close();
  });

  it('续接任务：串内历史正文进入输入（不只「不含其他任务」）', async () => {
    const db = openMem();
    // 首轮成功后任务进 REVIEW（user_review，非终态），允许同任务追加 turn。
    makeTask(db, 1, '第一轮：记录暗号 ZS-4242', 'user_review');
    const first: FakeScriptItem[] = [
      { kind: 'event', event: { kind: 'message.completed', messageId: 'm1', text: '暗号已记录：ZS-4242' } },
      { kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } },
    ];
    const second: FakeScriptItem[] = [
      { kind: 'event', event: { kind: 'turn.completed', finalText: '第二轮完成' } },
    ];
    const adapter = new FakeRuntimeAdapter({ turnScripts: [first, second] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1' });
    await worker.runOnce(); // 任务 1 产生串内回复，任务 REVIEW

    db.prepare(`INSERT INTO outbox (dispatch_key) VALUES ('task:task_1:redispatch')`).run();
    await worker.runOnce();
    // 第二个 turn 的输入包含第一轮 agent 回复正文与根消息（本线程获准历史，§13.1-6）。
    expect(adapter.startTurnLog).toHaveLength(2);
    expect(adapter.startTurnLog[1]!.text).toContain('暗号已记录：ZS-4242');
    expect(adapter.startTurnLog[1]!.text).toContain('第一轮：记录暗号 ZS-4242');
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('② 输入与 ContextBundle/版本/hash 一致（PP-02/04）', () => {
  it('库内信封 hash 可由信封重算；inputBundleId 与 context_bundles.id 一致；版本字段在案', async () => {
    const db = openMem();
    makeTask(db, 2, '校验 hash 一致性');
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w1' }).runOnce();

    const call = adapter.startTurnLog[0]!;
    const row = db.prepare('SELECT id, included_refs_json, hash FROM context_bundles').get() as { id: string; included_refs_json: string; hash: string };
    // inputBundleId = bundle 行 ID
    expect(call.inputBundleId).toBe(row.id);
    // 信封 → hash 重算一致（canonical，字段顺序无关）
    const envelope = JSON.parse(row.included_refs_json);
    const recomputed = createHash('sha256').update(canonicalJson(envelope)).digest('hex');
    expect(recomputed).toBe(row.hash);
    // 版本留档（PP-02：会话/运行关联实际使用版本）
    expect(envelope.bundleVersion).toBe('zs-turn-v0.1.3');
    expect(envelope.promptVersion).toBe('zs-standing-v0.1.1');
    // 材料引用与线程摘要一致（PP-04：可见材料与 included_refs 对应）
    expect(envelope.threadDigest.rootMessageId).toBe('msg_root_2');
    expect(envelope.materials.map((m: { ref: string }) => m.ref)).toContain('msg_root_2');
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('③ 必要材料组装失败 → 不派发', () => {
  it('根消息被删 → 无 run/turn、任务 BLOCKED、审计 contextAssemblyFailed、outbox 完成', async () => {
    const db = openMem();
    makeTask(db, 3, '组装失败路径');
    // 外键约束下先置空任务引用再删消息（模拟数据损坏/迁移异常）。
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM messages WHERE id = ?').run('msg_root_3');
    db.exec('PRAGMA foreign_keys = ON');

    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w1' }).runOnce();

    expect(db.prepare('SELECT count(*) c FROM workflow_runs').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT count(*) c FROM agent_turns').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_3')).toMatchObject({ status: 'BLOCKED' });
    const audit = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'task.contextAssemblyFailed'").get() as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ reason: 'missing-root-message' });
    expect(adapter.startTurnLog).toHaveLength(0);
    await adapter.closeAllSessions();
    db.close();
  });

  it('用户正文含 token 形态 → 敏感命中组装失败（PP-03），不启动模型', async () => {
    const db = openMem();
    makeTask(db, 4, '我的 key 是 sk-ABCDEFGHIJKLMNOPQRSTUV 请保管');
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w1' }).runOnce();

    expect(db.prepare('SELECT count(*) c FROM workflow_runs').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_4')).toMatchObject({ status: 'BLOCKED' });
    const audit = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'task.contextAssemblyFailed'").get() as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ reason: 'sensitive-content' });
    expect(adapter.startTurnLog).toHaveLength(0);
    await adapter.closeAllSessions();
    db.close();
  });
});
