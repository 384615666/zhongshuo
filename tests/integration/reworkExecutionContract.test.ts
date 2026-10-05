/**
 * 返工执行闭环合同（r58，review-r57 §3 独立反例）：
 * task.review(changes_requested) 只写验收事实（意见入账、任务回 ACTIVE、**零派发**——
 * 连续泵均 false）；「执行返工」（task.executeRework）以库内验收事实为源（意见/版本服务端
 * 为准），沿 task.redispatch 同守卫栈与键命名空间入队；同任务新 run/turn 的**模型输入包含
 * 被退回交付版本与验收意见**（此前 DM 组装缺注入=无反馈重跑）；新交付由 worker 完成路径
 * **自然产生**（revision 递增、旧 pending 置 superseded、回 REVIEW）——正例全程无手工
 * INSERT/UPDATE 交付或状态；对 v2 验收 DONE 收口。负例：重复执行（幂等冲突）、非返工态
 * 执行（STALE）、终态后执行（STALE）。
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
import { reworkPendingOf } from '../../src/persistence/stores/dm.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-rw58-'));
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
function must<T>(v: T | undefined | null, label: string): T {
  if (v == null) throw new Error(`必然存在但缺失：${label}`);
  return v;
}

function makeEnv() {
  const db: ZhongshuoDatabase = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `rw58-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw Object.assign(new Error(`${r.error?.code}: ${r.error?.message}`), { code: r.error?.code });
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }> =>
    dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `rw58-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; error?: { code: string; message: string } }>;
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? validDone() });
  const worker = () => new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: join(tmpRoot, 'app') });
  return {
    db, cmd, cmdRaw, scripts, adapter, worker,
    taskRow: (taskId: string) => must(db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string } | undefined, `task ${taskId}`),
    deliveries: (taskId: string) => db.prepare('SELECT id, revision, run_id, review_status, review_note FROM task_deliveries WHERE task_id = ? ORDER BY revision').all(taskId) as Array<{ id: string; revision: number; run_id: string; review_status: string; review_note: string | null }>,
    runs: (taskId: string) => db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ id: string }>,
    turns: (taskId: string) => db.prepare('SELECT t.id, t.dispatch_key FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? ORDER BY t.rowid').all(taskId) as Array<{ id: string; dispatch_key: string }>,
    events: (kind: string) => db.prepare('SELECT payload_json FROM domain_events WHERE kind = ? ORDER BY seq').all(kind) as Array<{ payload_json: string }>,
    count: (sql: string) => (db.prepare(sql).get() as { c: number }).c,
  };
}

describe('返工执行闭环（r58：验收与执行分离——意见注入输入、新交付自然产生）', () => {
  it('① DM 全链：记录意见（零派发）→执行返工→同任务新 run 输入含意见与被退版本→v2 自然交付→验收 DONE', async () => {
    const env = makeEnv();
    await env.cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    const dm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: 'R58 返工链' });
    const submit = (body: string) => env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body, intent: 'default', mentions: [] });
    const r1 = await submit('R58 初稿任务');
    const taskId = r1.taskId;

    // v1 自然产生（无手工 INSERT/UPDATE）。
    await env.worker().runOnce();
    await until(() => env.taskRow(taskId).status, (s) => s === 'REVIEW', 8000, 'v1 后任务 REVIEW');
    const d1 = must(env.deliveries(taskId)[0], 'v1 交付');
    expect(d1.review_status).toBe('pending');
    const run1 = must(env.runs(taskId)[0], 'run1').id;

    // 记录返工意见：任务回 ACTIVE、意见入账、**零派发**（连续泵 false）。
    const NOTE = 'R58 返工意见：结论要补充量化数据（AUDIT-REWORK 独立反例复核链）';
    await env.cmd('task.review', { taskId, deliveryId: d1.id, deliveryRevision: d1.revision, manifestHash: must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d1.id) as { manifest_hash: string } | undefined, 'manifest').manifest_hash, decision: 'changes_requested', note: NOTE });
    expect(env.taskRow(taskId).status).toBe('ACTIVE');
    const w = env.worker();
    expect(await w.runOnce()).toBe(false);
    expect(await w.runOnce()).toBe(false);
    expect(env.adapter.startTurnLog).toHaveLength(1); // 仍只有初稿
    // 「意见已记录、尚未执行」派生事实（queued=false）。
    expect(reworkPendingOf(env.db, taskId)).toEqual({ deliveryRevision: 1, note: NOTE, queued: false });

    // 幂等负例：执行返工两次入队=第二次冲突（同键命名空间一意图）。
    const ex1 = await env.cmd<{ enqueued: boolean; dispatchKey: string; deliveryRevision: number; sourceRunId: string }>('task.executeRework', { taskId });
    expect(ex1).toMatchObject({ enqueued: true, deliveryRevision: 1, sourceRunId: run1 });
    expect(ex1.dispatchKey).toBe(`task:${taskId}:redispatch:${run1}`);
    expect(reworkPendingOf(env.db, taskId)).toMatchObject({ queued: true });
    const ex2 = await env.cmdRaw('task.executeRework', { taskId });
    expect(ex2.ok).toBe(false);
    expect(ex2.error?.code).toBe('IDEMPOTENCY_CONFLICT');

    // 执行：同任务新 run/turn；模型输入包含被退回版本与验收意见（DM 注入缺口修复验证）。
    await env.worker().runOnce();
    await until(() => env.deliveries(taskId).length, (n) => n === 2, 8000, 'v2 自然交付');
    expect(env.adapter.startTurnLog).toHaveLength(2);
    const reworkInput = must(env.adapter.startTurnLog[1], '返工 turn 输入').text;
    expect(reworkInput).toContain('【返工】此前交付（第 1 版）未通过人工验收');
    expect(reworkInput).toContain(NOTE);
    const d2 = must(env.deliveries(taskId)[1], 'v2 交付');
    expect(d2.revision).toBe(2);
    expect(d2.review_status).toBe('pending');
    expect(must(env.deliveries(taskId)[0], 'v1')).toMatchObject({ review_status: 'changes_requested', review_note: NOTE }); // 已处理验收记录保留（supersede 只替换 pending——历史不涂改）
    expect(env.taskRow(taskId).status).toBe('REVIEW');
    expect(env.runs(taskId)).toHaveLength(2); // 同任务新 run
    expect(reworkPendingOf(env.db, taskId)).toBeNull(); // 新交付在待验收——返工态消失
    // 意见入账+执行入队审计。
    const reviewEvt = env.events('task.reviewRecorded').map((e) => JSON.parse(e.payload_json) as { note?: string });
    expect(reviewEvt.some((e) => e.note === NOTE)).toBe(true);
    const reworkEvt = env.events('task.reworkEnqueued').map((e) => JSON.parse(e.payload_json) as { reviewNote?: string; sourceRunId?: string });
    expect(reworkEvt.some((e) => e.reviewNote === NOTE && e.sourceRunId === run1)).toBe(true);

    // v2 验收 DONE；终态后执行返工=STALE。
    const mh2 = must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d2.id) as { manifest_hash: string } | undefined, 'manifest2').manifest_hash;
    await env.cmd('task.review', { taskId, deliveryId: d2.id, deliveryRevision: 2, manifestHash: mh2, decision: 'accept' });
    expect(env.taskRow(taskId).status).toBe('DONE');
    const ex3 = await env.cmdRaw('task.executeRework', { taskId });
    expect(ex3.ok).toBe(false);
    expect(ex3.error?.code).toBe('STALE_REVISION');
    expect(env.adapter.startTurnLog).toHaveLength(2); // 收口后零新增执行
  }, 45_000);

  it('② 负例：无返工事实/待验收新交付时拒绝执行（守卫不因入口拆分而放松）', async () => {
    const env = makeEnv();
    await env.cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    const dm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: 'R58 返工负例' });
    const r1 = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body: 'R58 负例任务', intent: 'default', mentions: [] });
    const taskId = r1.taskId;
    await env.worker().runOnce();
    await until(() => env.taskRow(taskId).status, (s) => s === 'REVIEW', 8000, '任务 REVIEW');
    // v1 仍待验收（无 changes_requested 事实）→ 拒绝。
    const e1 = await env.cmdRaw('task.executeRework', { taskId });
    expect(e1.ok).toBe(false);
    expect(e1.error?.code).toBe('STALE_REVISION');
    // accept 后任务 DONE → 拒绝。
    const d1 = must(env.deliveries(taskId)[0], 'v1');
    const mh = must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d1.id) as { manifest_hash: string } | undefined, 'manifest').manifest_hash;
    await env.cmd('task.review', { taskId, deliveryId: d1.id, deliveryRevision: d1.revision, manifestHash: mh, decision: 'accept' });
    const e2 = await env.cmdRaw('task.executeRework', { taskId });
    expect(e2.ok).toBe(false);
    expect(e2.error?.code).toBe('STALE_REVISION');
    expect(env.adapter.startTurnLog).toHaveLength(1);
  }, 30_000);
});
