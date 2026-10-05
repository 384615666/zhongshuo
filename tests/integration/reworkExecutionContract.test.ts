/**
 * 返工执行闭环合同（r58 起；r59 按 review-r58 §2 反例 stale-rework-result.json 扩充版本绑定）：
 * task.review(changes_requested) 只写验收事实（意见入账、任务回 ACTIVE、**零派发**——
 * 连续泵均 false）；「执行返工」（task.executeRework）**绑定用户所见交付完整身份**
 * （deliveryId/revision/manifestHash/sourceRunId——r59：旧页面只传 taskId 曾默默改绑新
 * 返工，独立反例证伪），事务内核核对归属与「当前最高版本=该 changes_requested」；沿
 * task.redispatch 同守卫栈与键命名空间入队；同任务新 run/turn 的**模型输入包含被退回
 * 交付版本与验收意见**；新交付由 worker 完成路径**自然产生**（revision 递增、旧 pending
 * 置 superseded、回 REVIEW）——正例全程无手工 INSERT/UPDATE。
 * 负例（r59）：③两轮自然交付后旧 v1 引用=STALE 零副作用不改绑 v2+合法 v2 恰一次；
 * ④同 revision 错 id/hash/sourceRun 归属/revision 全拒；⑤同号同参重放=网关幂等原回执。
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
    // 「意见已记录、尚未执行」派生事实（queued=false；r59 含完整执行身份）。
    const rp1 = reworkPendingOf(env.db, taskId);
    expect(rp1).toMatchObject({ deliveryId: d1.id, deliveryRevision: 1, note: NOTE, queued: false });
    if (rp1 != null) expect(rp1.manifestHash).toHaveLength(64);

    // r59：执行快照=派生 DTO 的完整身份（页面点击即冻结此快照）。
    const snapOf = (rev: number) => {
      const d = must(env.deliveries(taskId).find((x) => x.revision === rev), `v${rev} 交付行`);
      return { taskId, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d.id) as { manifest_hash: string } | undefined, `mh v${rev}`).manifest_hash, sourceRunId: must(d.run_id, `v${rev} run`) };
    };

    // 幂等负例：执行返工两次入队=第二次冲突（同键命名空间一意图）。
    const ex1 = await env.cmd<{ enqueued: boolean; dispatchKey: string; deliveryRevision: number; sourceRunId: string }>('task.executeRework', snapOf(1));
    expect(ex1).toMatchObject({ enqueued: true, deliveryRevision: 1, sourceRunId: run1 });
    expect(ex1.dispatchKey).toBe(`task:${taskId}:redispatch:${run1}`);
    expect(reworkPendingOf(env.db, taskId)).toMatchObject({ queued: true });
    const ex2 = await env.cmdRaw('task.executeRework', snapOf(1));
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

    // v2 验收 DONE；终态后执行返工（带完整快照）=STALE。
    const mh2 = must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d2.id) as { manifest_hash: string } | undefined, 'manifest2').manifest_hash;
    await env.cmd('task.review', { taskId, deliveryId: d2.id, deliveryRevision: 2, manifestHash: mh2, decision: 'accept' });
    expect(env.taskRow(taskId).status).toBe('DONE');
    const ex3 = await env.cmdRaw('task.executeRework', snapOf(2));
    expect(ex3.ok).toBe(false);
    expect(ex3.error?.code).toBe('STALE_REVISION');
    // 旧形态请求（只传 taskId——r58 版页面）不再被接受：执行授权必须带完整快照。
    const exOld = await env.cmdRaw('task.executeRework', { taskId, reason: '旧页面形态' });
    expect(exOld.ok).toBe(false);
    expect(exOld.error?.code).toBe('VALIDATION_INVALID');
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
    const snapV1 = () => {
      const d = must(env.deliveries(taskId)[0], 'v1');
      return { taskId, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d.id) as { manifest_hash: string } | undefined, 'mh').manifest_hash, sourceRunId: must(d.run_id, 'run') };
    };
    // v1 仍待验收（无 changes_requested 事实）→ 拒绝。
    const e1 = await env.cmdRaw('task.executeRework', snapV1());
    expect(e1.ok).toBe(false);
    expect(e1.error?.code).toBe('STALE_REVISION');
    // accept 后任务 DONE → 拒绝。
    const d1 = must(env.deliveries(taskId)[0], 'v1');
    const mh = must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d1.id) as { manifest_hash: string } | undefined, 'manifest').manifest_hash;
    await env.cmd('task.review', { taskId, deliveryId: d1.id, deliveryRevision: d1.revision, manifestHash: mh, decision: 'accept' });
    const e2 = await env.cmdRaw('task.executeRework', snapV1());
    expect(e2.ok).toBe(false);
    expect(e2.error?.code).toBe('STALE_REVISION');
    expect(env.adapter.startTurnLog).toHaveLength(1);
  }, 30_000);

  it('③ r59 版本绑定（review-r58 §2 反例）：两轮自然交付后旧 v1 引用=STALE 零副作用，不改绑 v2', async () => {
    const env = makeEnv();
    await env.cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    const dm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: 'R59 旧引用负例' });
    const r1 = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body: 'R59 旧引用任务', intent: 'default', mentions: [] });
    const taskId = r1.taskId;
    const snapOf = (rev: number) => {
      const d = must(env.deliveries(taskId).find((x) => x.revision === rev), `v${rev} 交付`);
      return { taskId, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d.id) as { manifest_hash: string } | undefined, `mh${rev}`).manifest_hash, sourceRunId: must(d.run_id, `run${rev}`) };
    };
    const facts = () => ({
      outbox: env.count('SELECT count(*) c FROM outbox'),
      runs: env.runs(taskId).length,
      reworkEvents: env.events('task.reworkEnqueued').length,
    });
    // 第一轮：v1→意见A→执行→v2（全部自然产生）。task.review 参数不带 sourceRunId（strictObject）。
    const reviewOf = (rev: number, decision: 'accept' | 'changes_requested', note?: string) => {
      const s = snapOf(rev);
      return env.cmd('task.review', { taskId: s.taskId, deliveryId: s.deliveryId, deliveryRevision: s.deliveryRevision, manifestHash: s.manifestHash, decision, ...(note != null ? { note } : {}) });
    };
    await env.worker().runOnce();
    await until(() => env.taskRow(taskId).status, (s) => s === 'REVIEW', 8000, 'v1 REVIEW');
    await reviewOf(1, 'changes_requested', 'R59 意见A（针对 v1）');
    await env.cmd('task.executeRework', snapOf(1));
    await env.worker().runOnce();
    await until(() => env.deliveries(taskId).length, (n) => n === 2, 8000, 'v2 自然交付');
    // 第二轮：对 v2 提交意见B（另一路合法操作——当前返工事实=v2）。
    await reviewOf(2, 'changes_requested', 'R59 意见B（针对 v2）');
    expect(reworkPendingOf(env.db, taskId)).toMatchObject({ deliveryRevision: 2, note: 'R59 意见B（针对 v2）' });
    const before = facts();
    // 旧页面仍按 v1 快照点击执行（未刷新客户端）→ 必须 STALE、零副作用、不改绑 v2。
    const stale = await env.cmdRaw('task.executeRework', { ...snapOf(1), reason: 'AUDIT 点击未刷新的 v1 返工' });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('STALE_REVISION');
    expect(String(stale.error?.message)).toContain('不自动改绑');
    expect(facts()).toEqual(before); // outbox/runs/审计事件零新增
    expect(reworkPendingOf(env.db, taskId)).toMatchObject({ deliveryRevision: 2, queued: false });
    // 合法同版本执行恰一次：v2 快照→恰一个新 outbox；重复=IDEMPOTENCY_CONFLICT。
    const ok2 = await env.cmd<{ enqueued: boolean; dispatchKey: string }>('task.executeRework', snapOf(2));
    expect(ok2.enqueued).toBe(true);
    const dup = await env.cmdRaw('task.executeRework', snapOf(2));
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    await env.worker().runOnce();
    await until(() => env.deliveries(taskId).length, (n) => n === 3, 8000, 'v3 自然交付');
    expect(env.runs(taskId)).toHaveLength(3); // 两轮执行各恰一个新 run
  }, 60_000);

  it('④ r59 身份负例：同 revision 错 id/hash/sourceRunId 归属全拒（零副作用）', async () => {
    const env = makeEnv();
    await env.cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    const dm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: 'R59 身份负例' });
    const r1 = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body: 'R59 身份任务', intent: 'default', mentions: [] });
    const taskId = r1.taskId;
    await env.worker().runOnce();
    await until(() => env.taskRow(taskId).status, (s) => s === 'REVIEW', 8000, 'v1 REVIEW');
    const d1 = must(env.deliveries(taskId)[0], 'v1');
    const mh1 = must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d1.id) as { manifest_hash: string } | undefined, 'mh1').manifest_hash;
    await env.cmd('task.review', { taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: mh1, decision: 'changes_requested', note: 'R59 身份负例意见' });
    const before = { outbox: env.count('SELECT count(*) c FROM outbox'), events: env.events('task.reworkEnqueued').length };
    // 同 revision、错 deliveryId（不存在）。
    const eId = await env.cmdRaw('task.executeRework', { taskId, deliveryId: 'dlv_nonexistent_r59', deliveryRevision: 1, manifestHash: mh1, sourceRunId: must(d1.run_id, 'run1') });
    expect(eId.ok).toBe(false);
    expect(eId.error?.code).toBe('RESOURCE_NOT_FOUND');
    // 同 revision 正确 id、错 manifestHash（同版本不同内容不可执行）。
    const eHash = await env.cmdRaw('task.executeRework', { taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: 'f'.repeat(64), sourceRunId: must(d1.run_id, 'run1') });
    expect(eHash.ok).toBe(false);
    expect(eHash.error?.code).toBe('STALE_REVISION');
    // 错 sourceRunId（归属不符——另一任务的 run）。
    const otherRun = `run_not_belonging_${Date.now()}`;
    const eRun = await env.cmdRaw('task.executeRework', { taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: mh1, sourceRunId: otherRun });
    expect(eRun.ok).toBe(false);
    expect(eRun.error?.code).toBe('STALE_REVISION');
    // 错 revision。
    const eRev = await env.cmdRaw('task.executeRework', { taskId, deliveryId: d1.id, deliveryRevision: 2, manifestHash: mh1, sourceRunId: must(d1.run_id, 'run1') });
    expect(eRev.ok).toBe(false);
    expect(eRev.error?.code).toBe('STALE_REVISION');
    // 全部拒绝后零副作用；正确快照仍可恰一次执行。
    expect(env.count('SELECT count(*) c FROM outbox')).toBe(before.outbox);
    expect(env.events('task.reworkEnqueued').length).toBe(before.events);
    const ok = await env.cmd<{ enqueued: boolean }>('task.executeRework', { taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: mh1, sourceRunId: must(d1.run_id, 'run1') });
    expect(ok.enqueued).toBe(true);
  }, 45_000);

  it('⑤ r59 重放幂等：同 commandId 同参重放=原回执，不二次入队', async () => {
    const env = makeEnv();
    await env.cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    const dm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: 'R59 重放' });
    const r1 = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body: 'R59 重放任务', intent: 'default', mentions: [] });
    const taskId = r1.taskId;
    await env.worker().runOnce();
    await until(() => env.taskRow(taskId).status, (s) => s === 'REVIEW', 8000, 'v1 REVIEW');
    const d1 = must(env.deliveries(taskId)[0], 'v1');
    const mh1 = must(env.db.prepare('SELECT manifest_hash FROM task_deliveries WHERE id = ?').get(d1.id) as { manifest_hash: string } | undefined, 'mh1').manifest_hash;
    await env.cmd('task.review', { taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: mh1, decision: 'changes_requested', note: 'R59 重放意见' });
    const deps = { db: env.db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
    const params = { taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: mh1, sourceRunId: must(d1.run_id, 'run1') };
    const first = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: 'rw59-replay-fixed-001', method: 'task.executeRework', params }) as { ok: boolean; replayed?: boolean; data?: { enqueued: boolean } };
    expect(first.ok).toBe(true);
    expect(first.replayed ?? false).toBe(false);
    const replay = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: 'rw59-replay-fixed-001', method: 'task.executeRework', params }) as { ok: boolean; replayed?: boolean; data?: { enqueued: boolean } };
    expect(replay.ok).toBe(true);
    expect(replay.replayed).toBe(true); // 网关幂等原回执
    expect(env.count(`SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:${taskId}:redispatch*'`)).toBe(1); // 不二次入队
  }, 30_000);
});
