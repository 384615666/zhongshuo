/**
 * DELIBERATE 迟到/运行身份/时钟（修复轮 M1-2，零额度）：
 * 迟到三分支（未冻结纳入/停止不复活/发布后只展示）、二次运行不复用旧键、
 * 时钟注入（drain 循环不复用进入时 now）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { onStepOutput, prepareDeliberation, type DelibStep } from '../../src/daemon/deliberationRunner.ts';
import { listRunArtifacts } from '../../src/persistence/stores/deliberation.ts';
import { seed, createDelibTask, done, draft, runIdOf, step } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-delibid-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function opts(absenceMs = 60_000) {
  return { absenceToleranceMs: absenceMs, blobDir: join(tmpRoot, 'art') };
}

/** 让 m2 的 IND 轮截止中断缺席，run 推进到 CROSS_REVIEW（m1 单人成果）。 */
async function setupWithAbsentM2(db: ZhongshuoDatabase): Promise<{ scripts: FakeTurnScript[]; adapter: FakeRuntimeAdapter; worker: DispatchWorker; runId: string; taskId: string }> {
  const taskId = createDelibTask(db, 1, ['m1', 'm2']);
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1', enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app'), turnDeadlineMs: 80, interruptGraceMs: 40 });
  await step(worker, scripts);
  scripts.push(done(draft('甲', [{ claimId: 'c1', statement: '结论' }])));
  await step(worker, scripts); // IND m1 ✓
  scripts.push([{ kind: 'stall', ms: 60_000 }]);
  await step(worker, scripts); // IND m2 截止 → absent
  return { scripts, adapter, worker, runId: runIdOf(db), taskId };
}

describe('迟到成果（E4 后半段）', () => {
  it('未冻结时到达：发布计入 run、absent→late、后续整合可见（不污染已冻结输入）', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const { adapter, runId, taskId } = await setupWithAbsentM2(db);
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'CROSS_REVIEW' });
    // m2 的迟到 IND 成果（其 turn 曾被截止；此处以原 turnId 直接交付模拟迟到到达）。
    const lateStep: DelibStep = { taskId, runId, stage: 'IND', memberId: 'm2', roundNo: 0, purpose: 'stage_work' };
    const out = onStepOutput(db, { taskId, runId, step: lateStep, turnId: 'turn_late_1', finalText: JSON.stringify(draft('乙迟到稿', [{ claimId: 'c1', statement: '迟到结论' }])), options: opts() });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.counted).toBe(true);
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?').get(runId, 'm2')).toMatchObject({ status: 'late' });
    expect(listRunArtifacts(db, runId, 'analysis_draft').some((a) => a.author_id === 'm2')).toBe(true);
    const lateEvents = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'run.lateArrivalRecorded'").all() as Array<{ payload_json: string }>;
    expect(lateEvents.some((e) => JSON.parse(e.payload_json).memberId === 'm2')).toBe(true);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('任务已停止后到达：只留迟到记录，不复活运行/不计数', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const { adapter, runId, taskId } = await setupWithAbsentM2(db);
    db.prepare('UPDATE tasks SET stop_generation = 1, status = ? WHERE id = ?').run('CANCELLED', taskId);
    db.prepare("UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?").run(runId);
    const lateStep: DelibStep = { taskId, runId, stage: 'IND', memberId: 'm2', roundNo: 0, purpose: 'stage_work' };
    const out = onStepOutput(db, { taskId, runId, step: lateStep, turnId: 'turn_late_2', finalText: JSON.stringify(draft('乙迟到稿2', [{ claimId: 'c1', statement: '迟到' }])), options: opts() });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.counted).toBe(false);
    expect((out.value as { lateRecorded?: boolean }).lateRecorded).toBe(true);
    // 运行不被复活；参与者保持 absent（迟到材料已留档但不并入）。
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ status: 'CANCELLED' });
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?').get(runId, 'm2')).toMatchObject({ status: 'absent' });
    expect(db.prepare('SELECT kind FROM artifacts WHERE id = ?').get('art_turn_late_2')).toMatchObject({ kind: 'analysis_draft' });
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('发布后到达：只展示迟到材料（报告不变，更新须走新运行）', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const { adapter, runId, taskId } = await setupWithAbsentM2(db);
    db.prepare("UPDATE workflow_runs SET stage = 'PUBLISH', status = 'SUCCEEDED' WHERE id = ?").run(runId);
    const lateStep: DelibStep = { taskId, runId, stage: 'IND', memberId: 'm2', roundNo: 0, purpose: 'stage_work' };
    const out = onStepOutput(db, { taskId, runId, step: lateStep, turnId: 'turn_late_3', finalText: JSON.stringify(draft('发布后迟到', [{ claimId: 'c1', statement: '迟到' }])), options: opts() });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error.message);
    expect((out.value as { lateRecorded?: boolean }).lateRecorded).toBe(true);
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ status: 'SUCCEEDED' });
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('运行与版本身份（同任务多 run）', () => {
  it('终态后再次提交=新运行：新键不复用旧派发；旧 run 遗留步骤不执行不复活', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const { scripts, adapter, worker, runId: run1, taskId } = await setupWithAbsentM2(db);
    // 停止 run1 并终结任务。
    db.prepare('UPDATE tasks SET stop_generation = 1, status = ? WHERE id = ?').run('CANCELLED', taskId);
    db.prepare("UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?").run(run1);
    // 旧 run 的遗留 pending IND 步骤：被领取后因 run 非活跃/键过期而直接完结（零模型调用）。
    const staleKey = `task:${taskId}:delib:${run1}:IND:m2:0:w`;
    db.prepare('INSERT OR IGNORE INTO outbox (dispatch_key) VALUES (?)').run(staleKey);
    const before = (db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c;
    // 需要任务可派发才能走到 delib 分支：恢复任务状态为 ACTIVE（新提交场景）。
    db.prepare('UPDATE tasks SET stop_generation = 0, status = ? WHERE id = ?').run('ACTIVE', taskId);
    // 新提交 → 新 run（承接新证据；roster_revision+1）。
    const prepared = prepareDeliberation(db, { id: taskId, conversationId: 'c1', threadId: 'thread_1' }, { kind: 'dispatch', mode: 'DELIBERATE', rosterSource: 'all', frozenMemberIds: ['m1', 'm2'], initialWakeMemberIds: ['m1', 'm2'] }, opts());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const run2 = prepared.value.runId;
    expect(run2).not.toBe(run1);
    expect(db.prepare('SELECT roster_revision FROM workflow_runs WHERE id = ?').get(run2)).toMatchObject({ roster_revision: 2 });
    // 新 run 的 IND 键含 run2；不与 run1 键冲突。
    const keys = (db.prepare('SELECT dispatch_key FROM outbox WHERE dispatch_key LIKE ?').all(`task:${taskId}:delib:${run2}:%`) as Array<{ dispatch_key: string }>).map((r) => r.dispatch_key);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys.every((k) => k.includes(run2))).toBe(true);
    // 消费 stale 键：无新 turn、无模型调用（sequencer 空）、状态完结。
    const claimedStale = await worker.runOnce();
    expect(claimedStale).toBe(true);
    expect((db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c).toBe(before);
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run1)).toMatchObject({ status: 'CANCELLED' });
    // 新 run 步骤正常派发。
    scripts.push(done(draft('新运行甲', [{ claimId: 'c1', statement: '新' }])));
    await step(worker, scripts);
    expect(db.prepare('SELECT run_id FROM agent_turns ORDER BY rowid DESC LIMIT 1').get()).toMatchObject({ run_id: run2 });
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('时钟注入（drain 不复用进入时的 now）', () => {
  it('租约按领取时点的注入时钟计算；连续领取随时钟推进', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const taskId = createDelibTask(db, 9, ['m1', 'm2']);
    void taskId;
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    let t = 1_000_000;
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1', enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app9'), clock: () => (t += 5_000), leaseMs: 60_000 });
    await step(worker, scripts); // PREPARE
    // 在途轮保持续有租约：stall + 短截止，飞行中轮询 lease_until（领取时点的注入时钟）。
    (worker as unknown as { turnDeadlineMs: number }).turnDeadlineMs = 300;
    scripts.push([{ kind: 'stall', ms: 60_000 }]);
    const inFlight = worker.runOnce();
    const readLease = () => (db.prepare("SELECT lease_until FROM outbox WHERE dispatch_key LIKE '%delib%' AND status = 'leased'").get() as { lease_until: number } | undefined)?.lease_until;
    let l1: number | undefined;
    for (let i = 0; i < 400 && l1 == null; i += 1) { l1 = readLease(); await new Promise((r) => setTimeout(r, 5)); }
    expect(l1).toBeDefined();
    await inFlight; // 截止中断后完结（租约随之释放）
    scripts.push(done(draft('甲', [{ claimId: 'c1', statement: 's' }])));
    const inFlight2 = worker.runOnce();
    let l2: number | undefined;
    for (let i = 0; i < 400 && l2 == null; i += 1) { l2 = readLease(); await new Promise((r) => setTimeout(r, 5)); }
    expect(l2).toBeDefined();
    // 注入时钟每次读取 +5000：第二次领取的租约严格晚于第一次（非同一 now 平铺）。
    expect(l2!).toBeGreaterThan(l1!);
    void inFlight2;
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});
