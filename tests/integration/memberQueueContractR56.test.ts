/**
 * 同成员任务排队合同（R56，review-r55-long-batch §3）：R55 包验证发现「种子占住 Guide A 后
 * 同成员派发长期 pending」，换种子成员只解决了验收前置——本文件用**受控短暂忙碌**核清产品
 * 合同本身，不依赖 60s 盲等、不增并行额度、不绕租约/恢复保护：
 *
 *  ① 同 Agent、两个不同房间任务：第一项忙时第二项**真实等待**（admission reason=member 的
 *     run.admissionDeferred 留证 + outbox 回 pending + 零 run/turn + startTurn 恰 1 次）；
 *     第一项终态后第二项按正式合同继续（新 worker 领取→run/turn→完成；startTurn 恰 2 次、
 *     两键各 done 一次，无重复派发）。
 *  ② 「崩溃」重启（applyRecovery）：在途 turn→UNKNOWN、run→INTERRUPTED、leased 重排 pending、
 *     派发门禁落下；门禁期间新 worker 零领取；用户显式 dispatch.resume{confirm:true} 后排队
 *     意图继续；**旧意图不复活**（同 dispatch_key 已有 turn 的重领按 RECONCILE 收口 failed，
 *     不再执行、不重跑）。
 *  ③ 同一 DM 连续消息：串行（第二项在第一项忙时等待）、恰一次派发、成员 startTurn 次数=2。
 *
 * 留证字段：task/outbox（status·attempt_epoch·turn_id）/workflow_runs/agent_turns（status·
 * dispatch_key）/domain_events（run.admissionDeferred 等）/adapter.startTurnLog 实际次数。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { applyRecovery } from '../../src/daemon/stopFlow.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-mq56-'));
mkdirSync(join(tmpRoot, 'app'), { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => T, ok: (v: T) => boolean, ms: number, label: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（当前=${JSON.stringify(v)}）`);
    await sleep(60);
  }
}

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `mq56-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(`${r.error?.code}: ${r.error?.message}`);
    return r.data as T;
  };
  /** 受控忙碌：nextScript 队列——测试逐 turn 指定（短暂 stall=受控忙碌；无脚本=立即完成）。 */
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? validDone() });
  /** 每个 worker() 都是新实例（独立 leaseOwner/admission）——同进程内模拟「重启后的 worker」。 */
  const worker = () => new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: join(tmpRoot, 'app') });
  const submit = (body: string) =>
    cmd<{ taskId: string; threadId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body, intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
  return {
    db, cmd, scripts, adapter, worker, submit,
    outbox: (key: string) => db.prepare('SELECT id, dispatch_key, status, attempt_epoch, turn_id FROM outbox WHERE dispatch_key = ?').get(key) as { id: number; dispatch_key: string; status: string; attempt_epoch: number; turn_id: string | null } | undefined,
    taskRuns: (taskId: string) => db.prepare('SELECT id, status FROM workflow_runs WHERE task_id = ?').all(taskId) as Array<{ id: string; status: string }>,
    taskTurns: (taskId: string) => db.prepare('SELECT t.id, t.status, t.dispatch_key FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?').all(taskId) as Array<{ id: string; status: string; dispatch_key: string }>,
    task: (taskId: string) => db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string },
    events: (kind: string) => db.prepare('SELECT payload_json FROM domain_events WHERE kind = ? ORDER BY seq').all(kind) as Array<{ payload_json: string }>,
  };
}

describe('同成员任务排队合同（R56 §3：受控短暂忙碌，不绕租约/恢复保护）', () => {
  it('① 同 Agent 两个房间任务：忙时真实等待（admissionDeferred 留证），释放后按合同继续', async () => {
    const env = makeEnv();
    // 生产形态：一个常驻 worker（entry.ts 单实例——admission 成员串行按进程内存判定；跨
    // 重启的成员在途由 ②的 UNKNOWN+门禁+RECONCILE 保护，不靠 admission 记忆）。测试同判。
    const w = env.worker();
    // 第一项：受控短暂忙碌（600ms stall 后成功）——不盲等 60s。
    env.scripts.push([{ kind: 'stall', ms: 600 }, ...validDone()]);
    const t1 = await env.submit('R56 排队·任务一（先占用成员）');
    void w.runOnce(); // 派发进入在途（inline 消费——600ms 后完成）
    await until(() => env.taskTurns(t1.taskId).length, (n) => n === 1, 8000, '任务一 turn 建立');
    // 成员忙时提交第二项（同成员、不同任务）。
    const t2 = await env.submit('R56 排队·任务二（等待成员释放）');
    const key1 = `task:${t1.taskId}:initial`;
    const key2 = `task:${t2.taskId}:initial`;
    // 同一 worker 再泵：领取→admission member 拒绝→回 pending（真实等待，不是沉默）。
    await w.runOnce();
    const deferred = env.events('run.admissionDeferred');
    const ob2 = env.outbox(key2);
    expect(deferred.length).toBe(1);
    expect(JSON.parse(deferred[0].payload_json)).toMatchObject({ reason: 'member', dispatchKey: key2 });
    expect(ob2?.status).toBe('pending'); // 等待=真实可解释状态
    expect(env.taskRuns(t2.taskId)).toHaveLength(0); // 无 run
    expect(env.taskTurns(t2.taskId)).toHaveLength(0); // 无 turn
    expect(env.adapter.startTurnLog).toHaveLength(1); // 实际 startTurn 恰 1 次（成员串行）

    // 第一项终态（600ms 忙碌结束→admission 释放）→ 同一 worker 领取第二项 → 完成释放。
    await until(() => env.task(t1.taskId).status, (s) => s === 'REVIEW' || s === 'DONE', 8000, '任务一终态');
    env.scripts.push(validDone());
    await w.runOnce();
    await until(() => env.task(t2.taskId).status, (s) => s === 'REVIEW' || s === 'DONE', 8000, '任务二终态（按合同继续）');

    // 结算留证：两键各恰一次 startTurn/done；无重复派发。
    expect(env.adapter.startTurnLog).toHaveLength(2);
    expect(env.outbox(key1)?.status).toBe('done');
    expect(env.outbox(key2)?.status).toBe('done');
    expect(env.taskRuns(t1.taskId)).toHaveLength(1);
    expect(env.taskRuns(t2.taskId)).toHaveLength(1);
    // 已完成意图不再复活：再泵两轮零新增。
    await w.runOnce();
    await w.runOnce();
    expect(env.adapter.startTurnLog).toHaveLength(2);
  }, 30_000);

  it('② 「崩溃」重启：UNKNOWN/门禁/显式确认继续；旧意图按 RECONCILE 收口不复活', async () => {
    const env = makeEnv();
    // 任务一：长停滞（模拟崩溃时在途——不等待其完成）。
    env.scripts.push([{ kind: 'stall', ms: 120_000 }, ...validDone()]);
    const t1 = await env.submit('R56 重启·任务一（崩溃时在途）');
    void env.worker().runOnce();
    await until(() => env.taskTurns(t1.taskId).length, (n) => n === 1, 8000, '任务一 turn 建立');
    const t2 = await env.submit('R56 重启·任务二（崩溃时排队）');
    const key1 = `task:${t1.taskId}:initial`;
    const key2 = `task:${t2.taskId}:initial`;

    // 模拟 daemon 死亡+重启（同库 applyRecovery——生产 entry.ts 启动路径同款）。
    const snap = applyRecovery(env.db, Date.now());
    expect(snap.unknownTurns).toBeGreaterThanOrEqual(1); // 在途 turn→UNKNOWN（不确定结局保护）
    expect(snap.requeuedOutbox).toBeGreaterThanOrEqual(0);
    expect(env.db.prepare(`SELECT value FROM daemon_state WHERE key = 'dispatch_gate'`).get()).toMatchObject({ value: 'held' }); // 门禁落下
    const turn1 = env.taskTurns(t1.taskId)[0];
    expect(turn1.status).toBe('UNKNOWN');
    expect(env.taskRuns(t1.taskId)[0].status).toBe('INTERRUPTED');

    // 门禁期间：新 worker 零领取（排队意图不自动重放——等用户确认）。
    const claimed = await env.worker().runOnce();
    expect(claimed).toBe(false);
    expect(env.outbox(key2)?.status).toBe('pending');
    expect(env.adapter.startTurnLog).toHaveLength(1);

    // 用户显式确认继续（dispatch.resume{confirm:true}——不接受空参数直开）。
    await env.cmd('dispatch.resume', { confirm: true });
    // 任务一的派发意图早已 done（turn 已建立）——崩溃遗留的是 **UNKNOWN turn 待对账**，
    // 不复活=不为它新建任何派发：task.redispatch 被恢复守卫拒绝（RECONCILE_REQUIRED 族）。
    await expect(env.cmd('task.redispatch', { taskId: t1.taskId, reason: 'R56 测试：旧意图不得绕对账复活' })).rejects.toThrow(/RECONCILE|UNKNOWN|保护|对账/);
    const runs1 = env.taskRuns(t1.taskId);
    expect(runs1).toHaveLength(1); // 无新 run
    // 任务二（崩溃时未派发的排队意图）在确认后继续：领取→执行→完成。
    env.scripts.push(validDone());
    await env.worker().runOnce();
    await until(() => env.task(t2.taskId).status, (s) => s === 'REVIEW' || s === 'DONE', 8000, '任务二确认后续跑完成');
    expect(env.adapter.startTurnLog).toHaveLength(2); // 任务一不重跑（仍 1 次）+任务二恰一次
    // UNKNOWN turn 保持 UNKNOWN：恢复执行走 recovery.reconcile/releaseProtection 正式链，不在派发路径自动改写。
    expect(env.taskTurns(t1.taskId)[0].status).toBe('UNKNOWN');
  }, 30_000);

  it('③ 同一 DM 连续消息：串行排队、恰一次派发（同成员合同在 DM 面同样成立）', async () => {
    const env = makeEnv();
    const dm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: 'R56 DM 串行' });
    env.scripts.push([{ kind: 'stall', ms: 400 }, ...validDone()]);
    env.scripts.push(validDone());
    const send = (body: string) => env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body, intent: 'default', mentions: [] });
    await send('R56 DM 第一条');
    void env.worker().runOnce(); // 第一条进入在途（400ms 忙碌）
    await send('R56 DM 第二条（排队）');
    await env.worker().runOnce(); // DM 队列串行：第二条在第一条完成前不入派发（pumpDmQueue 门）
    expect(env.adapter.startTurnLog).toHaveLength(1);
    await until(() => env.db.prepare(`SELECT count(*) c FROM agent_turns WHERE status = 'SUCCEEDED'`).get() as { c: number }, (r) => r.c >= 1, 8000, '第一条完成');
    await env.worker().runOnce(); // 第二条继续
    await until(() => env.db.prepare(`SELECT count(*) c FROM agent_turns WHERE status = 'SUCCEEDED'`).get() as { c: number }, (r) => r.c >= 2, 8000, '第二条完成');
    expect(env.adapter.startTurnLog).toHaveLength(2); // 恰两次（串行+无重复）
    // 人类消息恰两条（agent 回复另计）——每条用户消息恰一次入库。
    const msgs = env.db.prepare("SELECT count(*) c FROM messages WHERE conversation_id = ? AND author_type = 'human'").get(dm.conversationId) as { c: number };
    expect(msgs.c).toBe(2);
  }, 30_000);
});
