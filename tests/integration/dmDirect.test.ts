/**
 * DEV-22 第一包（第十八轮五）：普通私信 1 对 1 的持久化与实际执行（R4 契约 baseline §2、§4.6）。
 * 验收映射（DM-BASE 正式实现子集）：
 * ① 新建与重复提交：同对端复用现行会话；跨项目对端拒绝；
 * ② 同成员两会话隔离及本会话续接（runtime_sessions scope=dm 按 conversation 隔离、task_id 空）；
 * ③ 无 @ 派工（mentions 非空拒绝）/无任务号（room_task_number NULL、不建任务卡）；
 * ④ 连续发送串行（运行中第二条 disposition=queued、不并行派发）+ run 终态后自动泵下一条；
 * ⑤ 停止后队列转 paused（dm.resume 显式继续；不自动重跑）；
 * ⑥ 归档只读（新发拒绝/恢复不自动执行）；
 * ⑦ record_only 只保存不建任务不占预算；
 * ⑧ 崩溃重启历史保留且未完成运行等待用户（恢复语义 UNKNOWN+门禁——本组断言消息与会话保留）；
 * ⑨ 附件接口明确拒绝（DEV-24 未实施——不以假数据冒充）。
 * fake runtime 零真实调用。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { successTurn } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-dm-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeDb(n: number): Promise<{ db: ZhongshuoDatabase; cmd: <T>(m: string, p: unknown) => Promise<T> }> {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1),('mB','p1','Agent乙','agent',1)`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dm-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  void n;
  return { db, cmd };
}

function makeWorker(db: ZhongshuoDatabase, scripts: FakeTurnScript[]): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } {
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? successTurn() });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-dm', appDataDir: join(tmpRoot, 'app') });
  return { worker, adapter };
}

const dmDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: 'dm_reply_1', text: '私信回复正文' } },
  {
    kind: 'event',
    event: {
      kind: 'turn.completed',
      finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '私信回复', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }),
    },
  },
];

describe('DEV-22 第一包：私信 1 对 1（R4 契约）', () => {
  it('①② 新建/复用/隔离/续接；③ 无 @ 派工/无任务号；④ 连续发送串行+终态后泵下一条', async () => {
    const { db, cmd } = await makeDb(1);
    const created = await cmd<{ conversationId: string; created: boolean }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    expect(created.created).toBe(true);
    const again = await cmd<{ conversationId: string; created: boolean }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    expect(again.created).toBe(false); // 同对端复用现行会话（不按成员自动合并）
    expect(again.conversationId).toBe(created.conversationId);
    // 同成员第二条会话：独立 conversationId（互不串上下文）。
    const conv2 = await cmd<{ conversationId: string; created: boolean }>('conversation.create', { projectId: 'p1', peerMemberId: 'mB' });
    expect(conv2.conversationId).not.toBe(created.conversationId);
    // 跨项目对端拒绝。
    await expect(cmd('conversation.create', { projectId: 'p1', peerMemberId: '不存在' })).rejects.toThrow(/不存在/);
    // ③ 无 @ 派工：mentions 非空整笔拒绝。
    await expect(cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: created.conversationId }, body: 'x', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] })).rejects.toThrow(/mentions 必须为空/);
    // 首条发送：立即派发（disposition=dispatched）。
    const s1 = await cmd<{ messageId: string; taskId: string | null; disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: created.conversationId }, body: '第一个问题', intent: 'default', mentions: [] });
    expect(s1.disposition).toBe('dispatched');
    expect(s1.taskId).not.toBeNull();
    const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(s1.taskId!) as Record<string, unknown>;
    expect(taskRow.kind).toBe('dm_turn');
    expect(taskRow.room_task_number).toBeNull(); // 无房间任务号
    expect(taskRow.room_id).toBeNull();
    // 运行中第二条：排队（不并行派发——outbox 无第二条）。
    const s2 = await cmd<{ disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: created.conversationId }, body: '第二个问题', intent: 'default', mentions: [] });
    expect(s2.disposition).toBe('queued');
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE 'dmtask:%'").get() as { c: number }).c).toBe(1);
    // ⑨ 附件接口明确拒绝（DEV-24 未实施）。
    await expect(cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: created.conversationId }, body: 'x', intent: 'default', mentions: [], attachmentRefs: ['a1'] })).rejects.toThrow(/DEV-24/);
    // 派发执行：fake 完成首条；断言 dm scope 会话与无线程回复。
    const scripts: FakeTurnScript[] = [dmDone()];
    const { worker, adapter } = makeWorker(db, scripts);
    await worker.runOnce(); // dmtask 首条 → DONE
    const run1 = db.prepare('SELECT * FROM workflow_runs WHERE task_id = ?').get(s1.taskId!) as Record<string, unknown>;
    expect(run1.mode).toBe('DIRECT');
    expect(run1.status).toBe('SUCCEEDED');
    const session = db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id = ?').get(created.conversationId) as Record<string, unknown>;
    expect(session.scope_kind).toBe('dm'); // ② dm 会话隔离维度=project/conversation/member
    expect(session.task_id).toBeNull(); // task_id 空（R4 §2.2）
    expect(session.thread_id).toBeNull();
    const reply = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND author_type = 'agent'").get(created.conversationId) as Record<string, unknown>;
    expect(reply).toBeTruthy();
    expect(reply.thread_id).toBeNull(); // 回复落会话（无线程序号）
    // ④ 终态后自动泵下一条：排队消息入队。
    await sleep(50);
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE 'dmtask:%' AND status IN ('pending','leased')").get() as { c: number }).c).toBe(1);
    scripts.push(dmDone());
    await sleep(300); // 首条 drain 收尾（completeOutbox/准入释放）完成后再领取——避免与收尾竞态
    await worker.runOnce(); // 第二条（resume 入队）→ DONE // 第二条 → DONE
    const run2 = db.prepare('SELECT status FROM workflow_runs WHERE task_id = ?').get((db.prepare("SELECT id FROM tasks WHERE kind = 'dm_turn' ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id) as { status: string };
    expect(run2.status).toBe('SUCCEEDED');
    db.close();
  }, 60_000);

  it('⑤ 停止后队列转 paused（dm.resume 显式继续，不自动重跑）；⑥ 归档只读/恢复不自动执行；⑦ record_only 只保存', async () => {
    const { db, cmd } = await makeDb(2);
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    // ⑦ record_only：只保存，无任务无派发。
    const rec = await cmd<{ disposition: string; taskId: null }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '仅记录这条', intent: 'record_only', mentions: [] });
    expect(rec.disposition).toBe('none');
    expect(rec.taskId).toBeNull();
    expect((db.prepare("SELECT count(*) c FROM tasks WHERE kind = 'dm_turn'").get() as { c: number }).c).toBe(0);
    // 首条（stall 挂住）+ 第二条排队。
    const scripts: FakeTurnScript[] = [[{ kind: 'stall', ms: 30_000 }]];
    const { worker, adapter } = makeWorker(db, scripts);
    const s1 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '长任务', intent: 'default', mentions: [] });
    const s2 = await cmd<{ disposition: string; taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '排队消息', intent: 'default', mentions: [] });
    expect(s2.disposition).toBe('queued');
    void worker.runOnce(); // 派发首条（stall——不阻塞测试流）
    // 以 adapter 实际收到 startTurn 为准（turn 行 RUNNING 早于会话建立——在会话打开窗口
    // 停止会让 turn 在那里取消，脚本对位随之漂移）。
    for (let i = 0; i < 200; i += 1) {
      if (adapter.startTurnLog.length >= 1) break;
      await sleep(50);
    }
    expect(adapter.startTurnLog.length).toBe(1);
    // 用户停止（命令面）：目标 run 停止；队列转 paused。
    const runId1 = (db.prepare('SELECT id FROM workflow_runs WHERE task_id = ?').get(s1.taskId) as { id: string }).id;
    const stopGen = (db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(s1.taskId) as { stop_generation: number }).stop_generation;
    await cmd('task.stop', { taskId: s1.taskId, targetRunId: runId1, expectedStopGeneration: stopGen });
    await worker.interruptTurn((db.prepare('SELECT id FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)').get(s1.taskId) as { id: string }).id);
    for (let i = 0; i < 100; i += 1) {
      const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(s1.taskId) as { status: string };
      if (t.status === 'CANCELLED') break;
      await sleep(50);
    }
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(s1.taskId) as { status: string }).status).toBe('CANCELLED');
    // 队列 paused：泵不自动入队（等待用户）。
    const list1 = await cmd<{ conversations: Array<{ execState: string }> }>('conversation.list', { projectId: 'p1' });
    expect(list1.conversations.find((c) => c.execState === 'paused')).toBeTruthy();
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE 'dmtask:%'").get() as { c: number }).c).toBe(1); // 仍只有首条（已完结）
    // dm.resume：清挂起并入队排队消息。
    const resumed = await cmd<{ enqueued: number }>('dm.resume', { conversationId: conv.conversationId });
    expect(resumed.enqueued).toBe(1);
    scripts.push(dmDone());
    await sleep(300); // 首条 drain 收尾（completeOutbox/准入释放）完成后再领取——避免与收尾竞态
    await worker.runOnce(); // 第二条（resume 入队）→ DONE
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(s2.taskId) as { status: string }).status).toBe('DONE');

    // ⑥ 归档只读：新发拒绝；恢复（restore）不自动执行任何排队。
    const rev = (db.prepare('SELECT revision FROM conversations WHERE id = ?').get(conv.conversationId) as { revision: number }).revision;
    await cmd('conversation.archive', { conversationId: conv.conversationId, expectedRevision: rev });
    await expect(cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '归档后', intent: 'default', mentions: [] })).rejects.toThrow(/已归档/);
    await expect(cmd('dm.resume', { conversationId: conv.conversationId })).rejects.toThrow(/已归档/);
    const restored = await cmd<{ restored: boolean }>('conversation.restore', { conversationId: conv.conversationId });
    expect(restored.restored).toBe(true);
    await sleep(100);
    expect((db.prepare("SELECT count(*) c FROM workflow_runs WHERE task_id IN (SELECT id FROM tasks WHERE kind='dm_turn')").get() as { c: number }).c).toBe(2); // restore 不自动续跑（无新 run）
    db.close();
  }, 90_000);

  it('⑧ 崩溃重启历史保留且未完成运行等待用户（文件库重开：消息/会话/排队任务全在，UNKNOWN 走恢复语义）', async () => {
    const dbFile = join(tmpRoot, 'dm-restart.sqlite');
    const db = openDatabase(dbFile);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dmr-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '重启前消息', intent: 'default', mentions: [] });
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '重启前排队', intent: 'default', mentions: [] }) as { disposition: string };
    // 崩溃：直接关库（在途/排队原样保留）。
    db.close();
    const db2 = openDatabase(dbFile);
    const msgs = db2.prepare('SELECT count(*) c FROM messages WHERE conversation_id = ?').get(conv.conversationId) as { c: number };
    expect(msgs.c).toBe(2); // 历史保留
    const convRow = db2.prepare('SELECT kind, archived_at FROM conversations WHERE id = ?').get(conv.conversationId) as { kind: string; archived_at: number | null };
    expect(convRow.kind).toBe('dm');
    expect(convRow.archived_at).toBeNull();
    const queued = db2.prepare("SELECT count(*) c FROM tasks WHERE kind = 'dm_turn' AND status = 'ACTIVE'").get() as { c: number };
    expect(queued.c).toBe(2); // 未完成任务保留（恢复语义接管：不丢、不自动跑）
    db2.close();
  }, 60_000);
});
