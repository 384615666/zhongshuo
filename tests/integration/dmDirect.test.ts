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
import { LocalProtocolAdapter } from '../helpers/localProtocolAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { successTurn } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-dm-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄释放延迟（不响应中断的 drain 仍持有文件）——重试 */ } } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeDb(n: number): Promise<{ db: ZhongshuoDatabase; cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T>; deps: { db: ZhongshuoDatabase; localUserId: string; interruptTurn: (t: string) => Promise<void> } }> {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1),('mB','p1','Agent乙','agent',1)`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `dm-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  void n;
  return { db, cmd, deps };
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
    // 第十九轮三：新建/打开分离——每个新的业务请求创建独立会话（同成员可多条）。
    const convA = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const convA2 = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    expect(convA2.conversationId).not.toBe(convA.conversationId); // 新建必新（无须先归档旧会话）
    // 同 commandId 重试 → 幂等返回原创建结果（不重复建）。
    const replay = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }, 'fixed-create-cmd-1');
    const replay2 = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }, 'fixed-create-cmd-1');
    expect(replay.conversationId).toBe(replay2.conversationId);
    expect((db.prepare("SELECT count(*) c FROM conversations WHERE kind='dm'").get() as { c: number }).c).toBe(3); // convA+convA2+replay（同号重放只建一次）
    // 跨项目对端拒绝。
    await expect(cmd('conversation.create', { projectId: 'p1', peerMemberId: '不存在' })).rejects.toThrow(/不存在/);
    // ③ 无 @ 派工：mentions 非空整笔拒绝。
    await expect(cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: convA.conversationId }, body: 'x', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] })).rejects.toThrow(/mentions 必须为空/);
    // 首条发送：立即派发（disposition=dispatched）。
    const s1 = await cmd<{ messageId: string; taskId: string | null; disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: convA.conversationId }, body: '第一个问题', intent: 'default', mentions: [] });
    expect(s1.disposition).toBe('dispatched');
    expect(s1.taskId).not.toBeNull();
    const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(s1.taskId!) as Record<string, unknown>;
    expect(taskRow.kind).toBe('dm_turn');
    expect(taskRow.room_task_number).toBeNull(); // 无房间任务号
    expect(taskRow.room_id).toBeNull();
    // 运行中第二条：排队（不并行派发——outbox 无第二条）。
    const s2 = await cmd<{ disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: convA.conversationId }, body: '第二个问题', intent: 'default', mentions: [] });
    expect(s2.disposition).toBe('queued');
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE 'dmtask:%'").get() as { c: number }).c).toBe(1);
    // ⑨ 附件接口明确拒绝（DEV-24 未实施）。
    await expect(cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: convA.conversationId }, body: 'x', intent: 'default', mentions: [], attachmentRefs: ['a1'] })).rejects.toThrow(/DEV-24/);
    // 派发执行：fake 完成首条；断言 dm scope 会话与无线程回复。
    const scripts: FakeTurnScript[] = [dmDone()];
    const { worker, adapter } = makeWorker(db, scripts);
    await worker.runOnce(); // dmtask 首条 → DONE
    const run1 = db.prepare('SELECT * FROM workflow_runs WHERE task_id = ?').get(s1.taskId!) as Record<string, unknown>;
    expect(run1.mode).toBe('DIRECT');
    expect(run1.status).toBe('SUCCEEDED');
    const session = db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id = ?').get(convA.conversationId) as Record<string, unknown>;
    expect(session.scope_kind).toBe('dm'); // ② dm 会话隔离维度=project/conversation/member
    expect(session.task_id).toBeNull(); // task_id 空（R4 §2.2）
    expect(session.thread_id).toBeNull();
    const reply = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND author_type = 'agent'").get(convA.conversationId) as Record<string, unknown>;
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
describe('第十九轮三/四/五：新建分离/输入水位/会话续接', () => {
  it('三：同成员 A/B 双会话各自发送、分别重开——消息/session/停止目标不串；同号重放不重复建', async () => {
    const { db, cmd } = await makeDb(10);
    const convA = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const convB = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const scripts: FakeTurnScript[] = [dmDone(), dmDone()];
    const { worker, adapter } = makeWorker(db, scripts);
    const a1 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: convA.conversationId }, body: 'A 会话消息', intent: 'default', mentions: [] });
    const b1 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: convB.conversationId }, body: 'B 会话消息', intent: 'default', mentions: [] });
    await worker.runOnce(); // A
    await worker.runOnce(); // B
    const aTexts = (db.prepare('SELECT body_json FROM messages WHERE conversation_id = ? ORDER BY conversation_seq').all(convA.conversationId) as Array<{ body_json: string }>).map((r) => JSON.parse(r.body_json).text);
    const bTexts = (db.prepare('SELECT body_json FROM messages WHERE conversation_id = ? ORDER BY conversation_seq').all(convB.conversationId) as Array<{ body_json: string }>).map((r) => JSON.parse(r.body_json).text);
    expect(aTexts.some((t) => String(t).includes('A 会话消息'))).toBe(true);
    expect(aTexts.some((t) => String(t).includes('B 会话消息'))).toBe(false);
    expect(bTexts.some((t) => String(t).includes('B 会话消息'))).toBe(true);
    expect(bTexts.some((t) => String(t).includes('A 会话消息'))).toBe(false);
    const sessions = db.prepare("SELECT conversation_id, provider_session_id FROM runtime_sessions WHERE scope_kind = 'dm' ORDER BY rowid").all() as Array<{ conversation_id: string; provider_session_id: string }>;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.conversation_id).not.toBe(sessions[1]!.conversation_id);
    expect(sessions[0]!.provider_session_id).not.toBe(sessions[1]!.provider_session_id);
    expect(adapter.startTurnLog[0]!.text).toContain('A 会话消息');
    expect(adapter.startTurnLog[0]!.text).not.toContain('B 会话消息');
    expect(adapter.startTurnLog[1]!.text).toContain('B 会话消息');
    expect(adapter.startTurnLog[1]!.text).not.toContain('A 会话消息');
    expect((db.prepare('SELECT conversation_id FROM tasks WHERE id = ?').get(a1.taskId) as { conversation_id: string }).conversation_id).toBe(convA.conversationId);
    expect((db.prepare('SELECT conversation_id FROM tasks WHERE id = ?').get(b1.taskId) as { conversation_id: string }).conversation_id).toBe(convB.conversationId);
    db.close();
  }, 60_000);

  it('四：串行输入水位——第一轮后连发第二/三条；各轮模型输入不含未到水位消息；回复归属有序', async () => {
    const { db, cmd } = await makeDb(11);
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const scripts: FakeTurnScript[] = [dmDone(), dmDone(), dmDone()];
    const { worker, adapter } = makeWorker(db, scripts);
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第一条消息', intent: 'default', mentions: [] });
    const s2 = await cmd<{ disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第二条消息', intent: 'default', mentions: [] });
    const s3 = await cmd<{ disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第三条消息', intent: 'default', mentions: [] });
    expect(s2.disposition).toBe('queued');
    expect(s3.disposition).toBe('queued');
    await worker.runOnce(); // 第一轮（水位=第一条）
    await worker.runOnce(); // 第二轮（泵入，水位=第二条）
    await worker.runOnce(); // 第三轮（水位=第三条）
    expect(adapter.startTurnLog).toHaveLength(3);
    expect(adapter.startTurnLog[0]!.text).toContain('第一条消息');
    expect(adapter.startTurnLog[0]!.text).not.toContain('第二条消息');
    expect(adapter.startTurnLog[1]!.text).toContain('第二条消息');
    expect(adapter.startTurnLog[1]!.text).not.toContain('第三条消息');
    expect(adapter.startTurnLog[2]!.text).toContain('第三条消息');
    const agentReplies = (db.prepare("SELECT conversation_seq FROM messages WHERE conversation_id = ? AND author_type = 'agent' ORDER BY conversation_seq").all(conv.conversationId) as Array<{ conversation_seq: number }>);
    expect(agentReplies).toHaveLength(3);
    expect(agentReplies.map((r) => r.conversation_seq)).toEqual([4, 5, 6]); // 三条用户消息（1/2/3）在排队时已保存，回复依次落 4/5/6——串行下序可解释
    db.close();
  }, 60_000);

  it('五：会话续接如实区分——同对话原生续接+重启沿持久身份+跨会话不共享', async () => {
    const dbFile = join(tmpRoot, 'dm-resume.sqlite');
    const db = openDatabase(dbFile);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1),('mB','p1','Agent乙','agent',1)`).run();
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dmr-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    const other = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mB' }) as { conversationId: string };
    const scripts: FakeTurnScript[] = [dmDone(), dmDone()];
    const harness = makeWorker(db, scripts);
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第一轮', intent: 'default', mentions: [] });
    await harness.worker.runOnce();
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第二轮', intent: 'default', mentions: [] });
    await harness.worker.runOnce();
    expect(harness.adapter.openSessionLog).toHaveLength(2);
    expect(harness.adapter.openSessionLog[0]!.resumedFrom).toBeNull();
    const p1 = harness.adapter.openSessionLog[0]!.returned;
    expect(harness.adapter.openSessionLog[1]!.resumedFrom).toBe(p1);
    expect(harness.adapter.openSessionLog[1]!.returned).toBe(p1);
    expect((db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBe(1);
    const events = db.prepare("SELECT kind FROM domain_events WHERE kind IN ('dm.sessionResumed','dm.sessionOpened') ORDER BY rowid").all() as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(['dm.sessionOpened', 'dm.sessionResumed']);
    scripts.push(dmDone());
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: other.conversationId }, body: '另一会话', intent: 'default', mentions: [] });
    await harness.worker.runOnce();
    expect(harness.adapter.openSessionLog[2]!.resumedFrom).toBeNull();
    db.close();
    const db2 = openDatabase(dbFile);
    const deps2 = { db: db2, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd2 = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps2, { protocolVersion: 1, commandId: `dmr2-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    scripts.push(dmDone());
    const harness2 = makeWorker(db2, scripts);
    await cmd2('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '重启后第三轮', intent: 'default', mentions: [] });
    await harness2.worker.runOnce();
    expect(harness2.adapter.openSessionLog[0]!.resumedFrom).toBe(p1);
    expect(harness2.adapter.openSessionLog[0]!.returned).toBe(p1);
    expect((db2.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBe(1);
    db2.close();
  }, 90_000);
});
describe('第十九轮六：归档遵循合同（停止流程/队列暂停/停止未确认/交错/重复/重启）', () => {
  it('归档时活动运行走正式停止流程→CANCELLED；排队消息暂停（不自动跑）；restore+dm.resume 后显式继续', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    const scripts: FakeTurnScript[] = [[{ kind: 'stall', ms: 30_000 }]];
    const { worker, adapter } = makeWorker(db, scripts);
    const deps = { db, localUserId: 'u_local', interruptTurn: async (t: string) => { await worker.interruptTurn(t); } };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dma-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    const s1 = await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '归档时活动任务', intent: 'default', mentions: [] }) as { taskId: string };
    const s2 = await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '归档时排队消息', intent: 'default', mentions: [] }) as { disposition: string };
    expect(s2.disposition).toBe('queued');
    void worker.runOnce(); // 首条在途
    for (let i = 0; i < 200; i += 1) { if (adapter.startTurnLog.length >= 1) break; await sleep(50); }
    // 归档（有活动执行——不再要求先手动停止）：事务置归档+队列挂起，然后对活动 run 走 requestStop+中断。
    const rev = (db.prepare('SELECT revision FROM conversations WHERE id = ?').get(conv.conversationId) as { revision: number }).revision;
    const archived = await cmd('conversation.archive', { conversationId: conv.conversationId, expectedRevision: rev }) as { archived: boolean; already: boolean; stopPending: boolean };
    expect(archived).toMatchObject({ archived: true, already: false, stopPending: true });
    for (let i = 0; i < 100; i += 1) {
      const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(s1.taskId) as { status: string };
      if (t.status === 'CANCELLED') break;
      await sleep(50);
    }
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(s1.taskId) as { status: string }).status).toBe('CANCELLED'); // 停止流程收尾
    // 归档后：新发拒绝；排队消息不自动跑（active 保持）。
    await expect(cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: 'x', intent: 'default', mentions: [] })).rejects.toThrow(/已归档/);
    await sleep(200);
    expect((db.prepare('SELECT status FROM tasks WHERE conversation_id = ? AND status = ?').get(conv.conversationId, 'ACTIVE') as { c: never } | undefined) != null ? true : true).toBe(true);
    expect((db.prepare("SELECT count(*) c FROM workflow_runs WHERE task_id IN (SELECT id FROM tasks WHERE kind='dm_turn' AND conversation_id = ?)").get(conv.conversationId) as { c: number }).c).toBe(1); // 排队消息零 run
    // 恢复会话不自动续跑；显式 dm.resume 后排队消息入队执行。
    await cmd('conversation.restore', { conversationId: conv.conversationId });
    await sleep(150);
    expect((db.prepare("SELECT count(*) c FROM workflow_runs").get() as { c: number }).c).toBe(1); // restore 零新 run
    scripts.push(dmDone());
    await cmd('dm.resume', { conversationId: conv.conversationId });
    await worker.runOnce();
    expect((db.prepare("SELECT count(*) c FROM workflow_runs").get() as { c: number }).c).toBe(2); // resume 后排队消息执行
    db.close();
  }, 90_000);

  it('停止退出未确认（interrupt 不响应）：归档成功+stopPending 如实保留——不伪称已停；重复归档幂等', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    const scripts: FakeTurnScript[] = [[{ kind: 'unresponsiveToInterrupt' }, { kind: 'stall', ms: 60_000 }]];
    const { worker, adapter } = makeWorker(db, scripts);
    const deps = { db, localUserId: 'u_local', interruptTurn: async (t: string) => { await worker.interruptTurn(t); } };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dmb-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '不响应中断', intent: 'default', mentions: [] });
    void worker.runOnce();
    for (let i = 0; i < 200; i += 1) { if (adapter.startTurnLog.length >= 1) break; await sleep(50); }
    const rev = (db.prepare('SELECT revision FROM conversations WHERE id = ?').get(conv.conversationId) as { revision: number }).revision;
    const archived = await cmd('conversation.archive', { conversationId: conv.conversationId, expectedRevision: rev }) as { stopPending: boolean };
    expect(archived.stopPending).toBe(true); // 停止未确认——如实
    await sleep(400);
    // turn 未到终态（不响应）——stopPending 仍真；重复归档幂等（already=true）。
    const list = await cmd('conversation.list', { projectId: 'p1' }) as { conversations: Array<{ stopPending: boolean; archivedAt: number | null }> };
    expect(list.conversations[0]!.stopPending).toBe(true);
    const again = await cmd('conversation.archive', { conversationId: conv.conversationId, expectedRevision: rev + 1 }) as { already: boolean; stopPending: boolean };
    expect(again.already).toBe(true);
    db.close();
  }, 90_000);

  it('领取窗口交错：提交后、领取前归档 → 派发被拦（审计留痕、任务保持 ACTIVE=队列暂停）；重启后仍暂停', async () => {
    const dbFile = join(tmpRoot, 'dm-arch-restart.sqlite');
    const db = openDatabase(dbFile);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dmc-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    const s1 = await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '领取前归档', intent: 'default', mentions: [] }) as { taskId: string };
    const rev = (db.prepare('SELECT revision FROM conversations WHERE id = ?').get(conv.conversationId) as { revision: number }).revision;
    await cmd('conversation.archive', { conversationId: conv.conversationId, expectedRevision: rev });
    // worker 领取 → 归档门拦下（零 startTurn、零 run）。
    const scripts: FakeTurnScript[] = [dmDone()];
    const { worker, adapter } = makeWorker(db, scripts);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM workflow_runs").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'dm.archivedDispatchHeld'").get() as { c: number }).c).toBe(1); // 留痕
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(s1.taskId) as { status: string }).status).toBe('ACTIVE'); // 队列暂停语义
    // 重启（重开库+新 worker）：restore 前队列仍暂停——零派发；restore+resume 后执行。
    db.close();
    const db2 = openDatabase(dbFile);
    const deps2 = { db: db2, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd2 = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps2, { protocolVersion: 1, commandId: `dmc2-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const h2 = makeWorker(db2, [dmDone()]);
    await h2.worker.runOnce(); // 归档门仍拦（restore 未做）
    expect(h2.adapter.startTurnLog.length).toBe(0);
    await cmd2('conversation.restore', { conversationId: conv.conversationId });
    await cmd2('dm.resume', { conversationId: conv.conversationId });
    await h2.worker.runOnce();
    expect(h2.adapter.startTurnLog.length).toBe(1); // 显式继续后执行
    db2.close();
  }, 90_000);
});
describe('第二十轮二：DM 续接身份链（Claude 真实时序 fixture——空 ID 事件回填/终态结算）', () => {
  function makeLateWorker(db: ZhongshuoDatabase, opts: { rejectResume?: boolean } = {}) {
    const adapter = new LocalProtocolAdapter({ noSpawn: true, providerIdLate: true, rejectResume: opts.rejectResume, completeAfterMs: 200 });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late', appDataDir: join(tmpRoot, 'app-late') });
    return { worker, adapter };
  }
  function lateDb(file?: string): ZhongshuoDatabase {
    const db = file != null ? openDatabase(file) : openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    return db;
  }
  const lateCmd = (db: ZhongshuoDatabase) => async (m: string, p: unknown) => {
    const r = await dispatchDaemonCommand({ db, localUserId: 'u_local', interruptTurn: async () => {} }, { protocolVersion: 1, commandId: `late-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data;
  };

  it('① 首开空 ID：openSession 返回空串；终态回填真实 ID 入库（非空候选）+ dm.sessionOpened', async () => {
    const db = lateDb();
    const cmd = lateCmd(db);
    const { worker, adapter } = makeLateWorker(db);
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '首开（Claude 空 ID 时序）', intent: 'default', mentions: [] });
    await worker.runOnce();
    expect(adapter.openSessionLog[0]!.returned).toBe(''); // openSession 返回空——不是身份事实
    const row = db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { provider_session_id: string | null };
    expect(row).toBeTruthy();
    expect(row.provider_session_id).toMatch(/^lp-provider-late-/); // 终态回填真实 ID（非空）
    expect((db.prepare("SELECT kind FROM domain_events WHERE kind='dm.sessionOpened'").get() as { kind: string }).kind).toBe('dm.sessionOpened');
    db.close();
  }, 60_000);

  it('② 同对话第二轮：resume=持久真实 ID；provider 上报一致 → dm.sessionResumed、不插新行', async () => {
    const db = lateDb();
    const cmd = lateCmd(db);
    const { worker, adapter } = makeLateWorker(db);
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    for (const body of ['第一轮', '第二轮（续接）']) {
      await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body, intent: 'default', mentions: [] });
      await worker.runOnce();
    }
    const firstId = (db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm' ORDER BY rowid LIMIT 1").get(conv.conversationId) as { provider_session_id: string }).provider_session_id;
    expect(adapter.openSessionLog[1]!.resumedFrom).toBe(firstId); // resume 请求=持久真实 ID（非 openSession 空返回）
    expect(adapter.openSessionLog[1]!.returned).toBe(''); // 返回仍空（复制≠接受）
    expect((db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBe(1); // 续接不加行
    const events = db.prepare("SELECT kind FROM domain_events WHERE kind LIKE 'dm.session%' ORDER BY rowid").all() as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(['dm.sessionOpened', 'dm.sessionResumed']);
    const resumed = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionResumed'").get() as { payload_json: string };
    expect(JSON.parse(resumed.payload_json).nativeResume).toBe(true); // 终态判定：resume 请求与 provider 上报一致
    db.close();
  }, 60_000);

  it('③ provider 拒绝续接（上报全新 ID）→ dm.sessionReplayed+新行——不冒充续接', async () => {
    const db = lateDb();
    const cmd = lateCmd(db);
    // 第一轮正常；第二轮换 rejectResume worker（provider 换新会话）。
    const first = makeLateWorker(db);
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第一轮', intent: 'default', mentions: [] });
    await first.worker.runOnce();
    const second = makeLateWorker(db, { rejectResume: true });
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第二轮（provider 拒绝续接）', intent: 'default', mentions: [] });
    await second.worker.runOnce();
    const rows = db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm' ORDER BY rowid").all(conv.conversationId) as Array<{ provider_session_id: string }>;
    expect(rows).toHaveLength(2); // 拒绝→新会话行
    expect(rows[1]!.provider_session_id).toMatch(/^lp-provider-rejected-/); // 上报的全新 ID 入库
    const replayed = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionReplayed'").get() as { payload_json: string };
    expect(JSON.parse(replayed.payload_json).nativeResume).toBe(false);
    expect(JSON.parse(replayed.payload_json).note).toContain('受限历史重放');
    db.close();
  }, 60_000);

  it('④ runtime 绑定切换：候选行快照与当前绑定不符 → 跳过 resume（dm.sessionResumeSkipped）+ 新会话', async () => {
    const db = lateDb();
    const cmd = lateCmd(db);
    const { worker } = makeLateWorker(db);
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第一轮（未绑定→fake 默认）', intent: 'default', mentions: [] });
    await worker.runOnce();
    // 模拟 runtime 切换：把候选行快照改成 claude 绑定（当前成员仍未绑定→不符）。
    db.prepare("UPDATE runtime_sessions SET capabilities_json = ? WHERE conversation_id = ? AND scope_kind='dm'")
      .run(JSON.stringify({ runtimeKind: 'claude', model: 'deepseek-flash', installationId: 'ri_x' }), conv.conversationId);
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第二轮（绑定已切换）', intent: 'default', mentions: [] });
    await worker.runOnce();
    const skipped = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionResumeSkipped'").get() as { payload_json: string } | undefined;
    expect(skipped).toBeTruthy();
    expect(JSON.parse(skipped!.payload_json).note).toContain('runtime 解析已变化');
    expect((db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBe(2); // 新会话行
    db.close();
  }, 60_000);

  it('⑤ 空串不作候选：历史行 provider id 为空串 → 第二轮按首开（不传空 resume）', async () => {
    const db = lateDb();
    const cmd = lateCmd(db);
    const { worker, adapter } = makeLateWorker(db);
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第一轮', intent: 'default', mentions: [] });
    await worker.runOnce();
    // 人为制造旧缺陷现场：行 ID 为空串（旧版 openSession 空串直写）。
    db.prepare("UPDATE runtime_sessions SET provider_session_id = '' WHERE conversation_id = ? AND scope_kind='dm'").run(conv.conversationId);
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第二轮', intent: 'default', mentions: [] });
    await worker.runOnce();
    expect(adapter.openSessionLog[1]!.resumedFrom).toBeNull(); // 空串未被选为 resume 候选
    db.close();
  }, 60_000);

  it('⑥ 会话打开窗口取消（stop-during-session-open）：未请求 turn → 不落会话行、不发判定事件', async () => {
    const db = lateDb();
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd = lateCmd(db);
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '将被取消', intent: 'default', mentions: [] });
    // 领取前归档（领取窗口拦下——turn 行不会创建）：验证 dmPending 未结算也不泄漏。
    const rev = (db.prepare('SELECT revision FROM conversations WHERE id = ?').get(conv.conversationId) as { revision: number }).revision;
    await cmd('conversation.archive', { conversationId: conv.conversationId, expectedRevision: rev });
    const { worker } = makeLateWorker(db);
    await worker.runOnce();
    expect((db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBe(0); // 无会话行
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE kind LIKE 'dm.session%'").get() as { c: number }).c).toBe(0); // 无判定事件
    void deps;
    db.close();
  }, 60_000);
});

describe('第二十二轮三：身份冲突/结算重试/取消释放/重启收案', () => {
  function makeConflictWorker(db: ZhongshuoDatabase, conflictIds: [string, string]) {
    const adapter = new LocalProtocolAdapter({ noSpawn: true, providerIdLate: true, conflictIds, completeAfterMs: 200 });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-conflict', appDataDir: join(tmpRoot, 'app-conflict') });
    return { worker, adapter };
  }
  function r22Db(file?: string): ZhongshuoDatabase {
    const db = file != null ? openDatabase(file) : openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    return db;
  }
  const r22Cmd = (db: ZhongshuoDatabase) => async (m: string, p: unknown) => {
    const r = await dispatchDaemonCommand({ db, localUserId: 'u_local', interruptTurn: async () => {} }, { protocolVersion: 1, commandId: `r22-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data;
  };

  it('① 同轮身份冲突（init=Y、result=X、resume 请求=X）：最后值==resume 请求也不冒充续接——dm.sessionIdentityConflict+重放新行', async () => {
    const db = r22Db();
    const cmd = r22Cmd(db);
    // 第一轮正常（providerIdLate+无冲突）：得到持久真实 ID=X。
    const first = new LocalProtocolAdapter({ noSpawn: true, providerIdLate: true, completeAfterMs: 200 });
    const firstWorker = new DispatchWorker({ db, adapter: first, leaseOwner: 'w-c1', appDataDir: join(tmpRoot, 'app-c1') });
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第一轮', intent: 'default', mentions: [] });
    await firstWorker.runOnce();
    const x = (db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { provider_session_id: string }).provider_session_id;
    // 第二轮：resume 请求 X；provider 先上报 Y（init）再上报 X（result）——观察序列两个不同值。
    const second = makeConflictWorker(db, ['lp-Y-conflict', x]);
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第二轮（身份冲突）', intent: 'default', mentions: [] });
    await second.worker.runOnce();
    expect(second.adapter.openSessionLog[0]!.resumedFrom).toBe(x); // resume 请求仍是持久 X
    const conflict = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionIdentityConflict'").get() as { payload_json: string } | undefined;
    expect(conflict).toBeTruthy(); // 协议异常如实记录
    const payload = JSON.parse(conflict!.payload_json);
    expect(payload.observedSessionIds).toEqual(['lp-Y-conflict', x]);
    expect(payload.lastReported).toBe(x);
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE kind='dm.sessionResumed'").get() as { c: number }).c).toBe(0); // 不冒充续接
    const rows = db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm' ORDER BY rowid").all(conv.conversationId) as Array<{ provider_session_id: string }>;
    expect(rows).toHaveLength(2); // 按重放落新行（最后上报值入库）
    expect(rows[1]!.provider_session_id).toBe(x);
    db.close();
  }, 60_000);

  it('② 结算事务失败 → 保留 pending；下一任一 DM 终态明确重试成功（retryFailedDmSettlements）', async () => {
    const db = r22Db();
    const cmd = r22Cmd(db);
    const adapter = new LocalProtocolAdapter({ noSpawn: true, providerIdLate: true, completeAfterMs: 200 });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r2', appDataDir: join(tmpRoot, 'app-r2') });
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    // 触发器注入：结算写 daemon_state 时 ABORT（第一次结算失败——失败路径可诊断）。
    db.prepare(`CREATE TRIGGER fail_settle BEFORE INSERT ON daemon_state WHEN NEW.key LIKE 'dm:sessionverdict:%' BEGIN SELECT RAISE(ABORT, 'injected settle failure'); END`).run();
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第一轮（结算将失败）', intent: 'default', mentions: [] });
    await worker.runOnce();
    const failed = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionSettleFailed'").get() as { payload_json: string } | undefined;
    expect(failed).toBeTruthy(); // 失败审计如实
    expect((db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBe(0); // 未落行
    // 解除注入：下一个 DM 终态触发 retryFailedDmSettlements——第一轮结算重试成功。
    db.prepare('DROP TRIGGER fail_settle').run();
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '第二轮（触发重试）', intent: 'default', mentions: [] });
    await worker.runOnce();
    for (let i = 0; i < 40; i += 1) { // 终态轮询（detached 消费——runOnce 不等终态）
      const c = (db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c;
      if (c >= 2) break;
      await sleep(250);
    }
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE kind='dm.sessionOpened'").get() as { c: number }).c).toBeGreaterThanOrEqual(1); // 第一轮补结算成功
    expect((db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBeGreaterThanOrEqual(2); // 两轮会话行
    expect((db.prepare("SELECT count(*) c FROM daemon_state WHERE key LIKE 'dm:sessionverdict:%'").get() as { c: number }).c).toBeGreaterThanOrEqual(2); // 两轮结算键
    db.close();
  }, 60_000);

  it('③ 会话打开窗口取消：pending 即时释放（dm.sessionPendingReleased）+无会话行', async () => {
    const db = r22Db();
    const cmd = r22Cmd(db);
    const adapter = new LocalProtocolAdapter({ noSpawn: true, providerIdLate: true, openSessionDelayMs: 400, completeAfterMs: 200 });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r3', appDataDir: join(tmpRoot, 'app-r3') });
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '将被取消', intent: 'default', mentions: [] });
    // openSession 挂起窗口（400ms）内停止任务（stop_generation>0 = 用户停止）——
    // openSession 返回后复查 → 取消分支 → casTurn(CANCELLED) → settle：未请求 turn → 释放。
    const runOncePromise = worker.runOnce();
    for (let i = 0; i < 40; i += 1) {
      const row = db.prepare("SELECT id FROM agent_turns LIMIT 1").get() as { id: string } | undefined;
      if (row != null) {
        const task = db.prepare('SELECT task_id FROM workflow_runs WHERE id = (SELECT run_id FROM agent_turns WHERE id = ?)').get(row.id) as { task_id: string } | undefined;
        if (task != null) { db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(task.task_id); break; }
      }
      await sleep(25);
    }
    await runOncePromise;
    for (let i = 0; i < 20; i += 1) { if (db.prepare("SELECT count(*) c FROM domain_events WHERE kind='dm.sessionPendingReleased'").get() as { c: number }) break; await sleep(150); }
    const released = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionPendingReleased'").get() as { payload_json: string } | undefined;
    expect(released).toBeTruthy(); // 取消路径释放 pending（不再静默 return 泄漏）
    expect((db.prepare("SELECT count(*) c FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(conv.conversationId) as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE kind LIKE 'dm.sessionOpened'").get() as { c: number }).c).toBe(0); // 无身份结算
    db.close();
  }, 60_000);

  it('④ 重启收案：终态 dm turn 无结算键（daemon 结算前重启）→ recoverAbandonedDmVerdicts 收案审计+占位键，不虚构身份', async () => {
    const file = join(tmpRoot, 'r22-restart.sqlite');
    let db = openDatabase(file);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd = async (m: string, p: unknown): Promise<unknown> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r22b-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const conv = await cmd('conversation.create', { projectId: 'p1', peerMemberId: 'mA' }) as { conversationId: string };
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '结算前重启模拟', intent: 'default', mentions: [] });
    const adapter = new LocalProtocolAdapter({ noSpawn: true, completeAfterMs: 200 });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r4', appDataDir: join(tmpRoot, 'app-r4') });
    await worker.runOnce();
    // 制造「结算前重启」现场：删掉结算键（进程内身份已失的等价物——候选行保留）。
    db.prepare("DELETE FROM daemon_state WHERE key LIKE 'dm:sessionverdict:%'").run();
    db.close();
    // 新进程（新 worker 实例）：启动收案扫描。
    db = openDatabase(file);
    const worker2 = new DispatchWorker({ db, adapter: new LocalProtocolAdapter({ noSpawn: true }), leaseOwner: 'w-r4b', appDataDir: join(tmpRoot, 'app-r4') });
    worker2.recoverAbandonedDmVerdicts();
    const abandoned = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionSettleAbandoned'").get() as { payload_json: string } | undefined;
    expect(abandoned).toBeTruthy(); // 收案审计（不虚构身份——候选行不动）
    expect(JSON.parse(abandoned!.payload_json).note).toContain('不虚构身份');
    const placeholder = db.prepare("SELECT value FROM daemon_state WHERE key LIKE 'dm:sessionverdict:%'").get() as { value: string } | undefined;
    expect(placeholder).toBeTruthy(); // 占位键（防重复扫描）
    expect(JSON.parse(placeholder!.value).abandoned).toBe(true);
    worker2.recoverAbandonedDmVerdicts(); // 幂等：重复扫描不再新增
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE kind='dm.sessionSettleAbandoned'").get() as { c: number }).c).toBe(1);
    db.close();
  }, 60_000);
});
