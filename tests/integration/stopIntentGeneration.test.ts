/**
 * 停止领取层·意图代次（第二十八轮二；迁移 034）：领取判定按**派发意图自己的入队代次**——
 * 不能以「stop_generation>0 + 存在任意在途 run/turn」推断停止仍生效（历史停止已结算、合法
 * 新 run 执行中时，新到的合法提醒/跟进意图会被误杀静默丢弃）。
 * 反例（正式链）：①历史停止后新 run 在途又有提醒到点=等待不丢（终态后执行恰一次）；
 * ②③同任务两提醒——被停止超越者取消（预占**精确释放**）+合法者执行；被超越意图不复活；
 * ④新停止仍阻断（gen 再进→停止前入队的当前意图被超越拒绝）；⑤重启后归属/预占/队列保持。
 * 断言 outbox 状态、底层 startTurn 次数与逐条预算归属（reminder_calls.reminder_id）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { ReminderScheduler } from '../../src/daemon/reminderScheduler.ts';
import { applyRecovery } from '../../src/daemon/stopFlow.ts';
import { openDispatchGate } from '../../src/persistence/daemonState.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-stopgen-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

interface Env {
  dbPath: string;
  db: ZhongshuoDatabase;
  cmd: <T,>(method: string, params: unknown) => Promise<T>;
  scripts: FakeTurnScript[];
  worker: () => DispatchWorker;
  adapter: FakeRuntimeAdapter;
  submit: (body: string) => Promise<{ taskId: string; threadId: string }>;
  close: () => void;
}

function makeEnv(): Env {
  const dbPath = join(tmpRoot, `state-${randomUUID().slice(0, 8)}.sqlite`);
  const db = openDatabase(dbPath);
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run('p1');
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `sg-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? validDone() });
  const worker = () => new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData });
  const submit = (body: string) =>
    cmd<{ taskId: string; threadId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body, intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
  return { dbPath, db, cmd, scripts, worker, adapter, submit, close: () => { void adapter.closeAllSessions().catch(() => {}); db.close(); } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gen = (env: Env, taskId: string): number => (env.db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(taskId) as { stop_generation: number }).stop_generation;
const keyOf = (env: Env, title: string): { reminderId: string; key: string } => {
  const reminderId = (env.db.prepare('SELECT id FROM reminders WHERE title = ?').get(title) as { id: string }).id;
  const sat = Number((env.db.prepare('SELECT scheduled_at FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { scheduled_at: number }).scheduled_at);
  const taskId = (env.db.prepare('SELECT task_id FROM reminder_calls WHERE reminder_id = ? LIMIT 1').get(reminderId) as { task_id: string }).task_id;
  return { reminderId, key: `task:${taskId}:reminder:${reminderId}:${sat}` };
};

/** 停止结算（正式链）：当前在途 run → task.stop（代次++，STOPPING）→ applyRecovery
 *（在途→UNKNOWN、run→INTERRUPTED、无在途；任务保持 ACTIVE）→ 开门（用户确认继续）。 */
async function settleStop(env: Env, taskId: string): Promise<void> {
  const runId = (env.db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId) as { id: string }).id;
  await env.cmd('task.stop', { taskId, targetRunId: runId, expectedStopGeneration: gen(env, taskId) });
  applyRecovery(env.db, Date.now());
  openDispatchGate(env.db, Date.now());
}

async function fireReminder(env: Env, clock: { now: number }, title: string, threadId: string, budget = 3): Promise<void> {
  await env.cmd('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId, ownerMemberId: 'mA', title, schedule: { kind: 'once', at: clock.now + 60_000 }, autoDispatch: true, budgetLimit: { sum: budget } });
  clock.now += 61_000;
  const sched = new ReminderScheduler({ db: env.db, now: () => clock.now });
  const out = sched.tick();
  expect(out.fired[0]?.outcome).toBe('dispatched');
}

describe('停止领取层·意图代次（正式链反例）', () => {
  it('①历史停止后新 run 在途又有提醒到点：合法意图等待不丢——终态后执行恰一次', async () => {
    const env = makeEnv();
    const t = await env.submit('停止结算后继续的任务');
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    void env.worker().runOnce();
    await sleep(150);
    await settleStop(env, t.taskId); // 历史停止结算：gen=1、无在途
    expect(gen(env, t.taskId)).toBe(1);
    const clock = { now: Date.now() };
    await fireReminder(env, clock, '跟进A', t.threadId);
    await env.worker().runOnce(); // 重排 initial → 对账失败（RT-03：已有 turn 不重发）
    env.scripts.push([{ kind: 'stall', ms: 400 }, { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: 'A 完成' } }, { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: 'A 完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } }]); // A：短延迟后自然终态——期间 B 到点、终态后 B 可领取
    void env.worker().runOnce();
    await sleep(150); // A 在途（RUNNING）
    await fireReminder(env, clock, '跟进B', t.threadId); // B 意图入队（代次=1=当前——合法）
    // B 领取：任务忙碌（A 在途）→ 等待（回 pending）——旧实现在此被「gen>0+在途」误杀。
    await env.worker().runOnce();
    const b = keyOf(env, '跟进B');
    expect(env.db.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get(b.key)).toMatchObject({ status: 'pending' }); // 不丢不收口
    expect((env.db.prepare('SELECT count(*) c FROM agent_turns WHERE dispatch_key = ?').get(b.key) as { c: number }).c).toBe(0); // 未提前执行
    await sleep(400); // A 的 stall 结束、run 终态
    const processed = await env.worker().drain(); // B 领取执行（等待期结束）
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(env.db.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get(b.key)).toMatchObject({ status: 'done' });
    expect((env.db.prepare('SELECT count(*) c FROM agent_turns WHERE dispatch_key = ?').get(b.key) as { c: number }).c).toBe(1); // 恰一次
    expect(env.adapter.startTurnLog.length).toBe(3); // initial(stall) + A + B——底层次数如实
    const settled = env.db.prepare("SELECT reminder_id FROM reminder_calls WHERE status = 'settled' ORDER BY rowid").all() as Array<{ reminder_id: string }>;
    expect(settled).toHaveLength(2); // A/B 各自结算——逐条归属
    env.close();
  }, 30_000);

  it('②③同任务两提醒：被停止超越者取消+预占精确释放、合法者执行；被超越意图不复活', async () => {
    const env = makeEnv();
    const t = await env.submit('两提醒交错的任务');
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    void env.worker().runOnce(); // initial 在途
    await sleep(150);
    await settleStop(env, t.taskId); // gen=1：历史停止结算（initial turn 已建——后续入队预占不被其挂钩）
    const clock = { now: Date.now() };
    await fireReminder(env, clock, 'A', t.threadId, 3); // A（合法 gen=1）——先执行成为在途新 run
    await env.worker().runOnce(); // initial → 对账失败
    env.scripts.push([{ kind: 'stall', ms: 600 }, { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: 'A 完成' } }, { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: 'A 完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } }]);
    void env.worker().runOnce(); // A 的 run 在途（短延迟后自然终态）
    await sleep(150);
    await fireReminder(env, clock, 'X', t.threadId, 3); // X 入队（gen=1，reserved 未挂钩）
    await settleStop(env, t.taskId); // gen 1→2：X 被超越（A 的 run 停止收案）
    await fireReminder(env, clock, 'Y', t.threadId, 3); // Y 入队（gen=2——新计划合法）
    const x = keyOf(env, 'X');
    const y = keyOf(env, 'Y');
    expect(env.db.prepare('SELECT stop_generation_at_enqueue FROM outbox WHERE dispatch_key = ?').get(x.key)).toMatchObject({ stop_generation_at_enqueue: 1 });
    expect(env.db.prepare('SELECT stop_generation_at_enqueue FROM outbox WHERE dispatch_key = ?').get(y.key)).toMatchObject({ stop_generation_at_enqueue: 2 });
    await sleep(500); // A 的延迟结束
    const processed = await env.worker().drain(); // initial 对账失败；X→被超越取消；Y→执行
    expect(processed).toBeGreaterThanOrEqual(2);
    expect(env.db.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get(x.key)).toMatchObject({ status: 'done' }); // 收口=不复活（再 drain 也不执行）
    expect(env.db.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get(y.key)).toMatchObject({ status: 'done' });
    expect((env.db.prepare('SELECT count(*) c FROM agent_turns WHERE dispatch_key = ?').get(x.key) as { c: number }).c).toBe(0); // X 零执行
    expect((env.db.prepare('SELECT count(*) c FROM agent_turns WHERE dispatch_key = ?').get(y.key) as { c: number }).c).toBe(1); // Y 恰一次
    // 精确释放：X 取消时其预占仍 reserved（未挂钩任何 turn）→ released；Y 的不被 X 的取消带走（settled）。
    expect(env.db.prepare('SELECT status FROM reminder_calls WHERE reminder_id = ?').get(x.reminderId)).toMatchObject({ status: 'released' });
    expect(env.db.prepare('SELECT status FROM reminder_calls WHERE reminder_id = ?').get(y.reminderId)).toMatchObject({ status: 'settled' });
    expect(env.adapter.startTurnLog.length).toBe(3); // initial(stall) + A + Y——X 不产调用
    env.close();
  }, 30_000);

  it('④新停止仍阻断：停止前入队的意图被超越拒绝（零执行+预占释放）；停止后新计划仍合法', async () => {
    const env = makeEnv();
    const t = await env.submit('二次停止的任务');
    const clock = { now: Date.now() };
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    void env.worker().runOnce(); // initial 在途（turn 已建——Z 入队预占不挂钩）
    await sleep(150);
    await fireReminder(env, clock, 'Z1', t.threadId, 2); // Z1 入队（gen=0）
    await fireReminder(env, clock, 'Z2', t.threadId, 2); // Z2 入队（gen=0——尚未领取）
    await settleStop(env, t.taskId); // gen 0→1：Z1/Z2 被本次停止超越
    const z1 = keyOf(env, 'Z1');
    const z2 = keyOf(env, 'Z2');
    expect(env.db.prepare('SELECT stop_generation_at_enqueue FROM outbox WHERE dispatch_key = ?').get(z1.key)).toMatchObject({ stop_generation_at_enqueue: 0 });
    const processed = await env.worker().drain();
    expect(processed).toBeGreaterThanOrEqual(2);
    for (const z of [z1, z2]) {
      expect(env.db.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get(z.key)).toMatchObject({ status: 'done' }); // 拒绝收口
      expect((env.db.prepare('SELECT count(*) c FROM agent_turns WHERE dispatch_key = ?').get(z.key) as { c: number }).c).toBe(0); // 零执行
      expect(env.db.prepare('SELECT status FROM reminder_calls WHERE reminder_id = ?').get(z.reminderId)).toMatchObject({ status: 'released' }); // 各自预占释放（取消时未挂钩）
    }
    expect(env.adapter.startTurnLog.length).toBe(1); // 仅 initial——停止确实阻断
    // 对照：停止后新计划（gen=1 入队）合法执行——阻断只针对被超越意图。
    await fireReminder(env, clock, 'Z3', t.threadId, 2);
    await env.worker().drain();
    const z3 = keyOf(env, 'Z3');
    expect((env.db.prepare('SELECT count(*) c FROM agent_turns WHERE dispatch_key = ?').get(z3.key) as { c: number }).c).toBe(1);
    env.close();
  }, 30_000);

  it('⑤重启后归属、预占与队列保持（文件库重开+新 worker+恢复合同）', async () => {
    const env = makeEnv();
    const t = await env.submit('重启保持的任务');
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    void env.worker().runOnce();
    await sleep(150);
    await settleStop(env, t.taskId);
    const clock = { now: Date.now() };
    await fireReminder(env, clock, '重启R', t.threadId, 2); // 意图入队（gen=1）——尚未领取
    const r = keyOf(env, '重启R');
    const beforeGen = gen(env, t.taskId);
    expect(env.db.prepare('SELECT status FROM reminder_calls WHERE reminder_id = ?').get(r.reminderId)).toMatchObject({ status: 'reserved' }); // 预占在队
    env.close(); // 「重启」：关连接
    const db2 = openDatabase(env.dbPath);
    const scripts2: FakeTurnScript[] = [];
    const adapter2 = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts2.shift() ?? validDone() });
    const worker2 = new DispatchWorker({ db: db2, adapter: adapter2, leaseOwner: 'w-restart', appDataDir: appData });
    applyRecovery(db2, Date.now()); // 重启恢复（收案在途/重排遗留）
    openDispatchGate(db2, Date.now());
    const processed = await worker2.drain();
    expect(processed).toBeGreaterThanOrEqual(2); // initial 对账失败 + 跟进执行
    expect(db2.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get(r.key)).toMatchObject({ status: 'done' });
    expect((db2.prepare('SELECT count(*) c FROM agent_turns WHERE dispatch_key = ?').get(r.key) as { c: number }).c).toBe(1); // 重启不重发不丢（恰一次）
    expect(db2.prepare('SELECT status FROM reminder_calls WHERE reminder_id = ?').get(r.reminderId)).toMatchObject({ status: 'settled' }); // 预占沿归属结算
    expect((db2.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(t.taskId) as { stop_generation: number }).stop_generation).toBe(beforeGen); // 代次保持
    await adapter2.closeAllSessions().catch(() => {});
    db2.close();
  }, 30_000);
});
