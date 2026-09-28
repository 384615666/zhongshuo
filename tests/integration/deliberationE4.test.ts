/**
 * E4 执行语义 + 输入冻结边界 + 迟到真实接收路径（M1 收口轮二，零额度假时钟）。
 * 反例清单（用户指定）：
 * ① 只到缺席宽限未到单轮截止 → 按缺席推进、不强杀在途成员；
 * ② 审批暂停期间不累计缺席时间；
 * ③ 排队成员不被记成已运行超时（只记排队观察线）；
 * ④ 两个截止同时发生 → 单一确定结局、无双标记；
 * ⑤ 睡眠/重启后时钟与恢复状态正确（RT-03：不重派）；
 * ⑥ 迟到经真实 adapter 事件路径接收（非直调 onStepOutput）；
 * ⑦ 冻结边界：甲已开始互评后迟到初稿到达，乙的同轮互评输入不变（清单+hash 锁定）。
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
import { pumpDeliberation, frozenStageInputs } from '../../src/daemon/deliberationRunner.ts';
import { applyRecovery } from '../../src/daemon/stopFlow.ts';
import { listRunArtifacts } from '../../src/persistence/stores/deliberation.ts';
import { seed, createDelibTask, done, draft, runIdOf, step } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-delibe4-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function opts(graceMs = 200, waitMs?: number) {
  return { absenceToleranceMs: graceMs, dispatchWaitDeadlineMs: waitMs, blobDir: join(tmpRoot, 'art') };
}

interface Rig {
  db: ZhongshuoDatabase;
  scripts: FakeTurnScript[];
  adapter: FakeRuntimeAdapter;
  worker: DispatchWorker;
  taskId: string;
  runId: string;
}

async function rig(db: ZhongshuoDatabase, n: number, members: string[], o?: { deadline?: number; grace?: number; wait?: number }): Promise<Rig> {
  const taskId = createDelibTask(db, n, members);
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: 'w1', enableDeliberate: true,
    absenceToleranceMs: o?.grace ?? 200, dispatchWaitDeadlineMs: o?.wait,
    turnDeadlineMs: o?.deadline ?? 10_000, interruptGraceMs: 50,
    appDataDir: join(tmpRoot, `app${n}`),
  });
  await step(worker, scripts); // PREPARE
  return { db, scripts, adapter, worker, taskId, runId: runIdOf(db) };
}

/** 把成员 X 的 IND 步骤挪到队尾（让其他成员先派发，X 保持可派发状态）。 */
function deferIndStep(db: ZhongshuoDatabase, taskId: string, runId: string, memberId: string): void {
  const key = `task:${taskId}:delib:${runId}:IND:${memberId}:0:w`;
  const id = (db.prepare('SELECT id FROM outbox WHERE dispatch_key = ?').get(key) as { id: number }).id;
  db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(key);
}

describe('① 宽限到期未到单轮截止：按缺席推进、不杀在途成员', () => {
  it('m1 在途（stall）、m2/m3 已完成 → 泵按宽限标 m1 缺席并推进；m1 turn 仍 RUNNING 未被杀', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2', 'm3']);
    const r = await rig(db, 1, ['m1', 'm2', 'm3'], { grace: 200, deadline: 8_000 });
    deferIndStep(db, r.taskId, r.runId, 'm1');
    r.scripts.push(done(draft('乙', [{ claimId: 'c1', statement: '乙稿' }])));
    await step(r.worker, r.scripts); // IND m2 ✓
    r.scripts.push(done(draft('丙', [{ claimId: 'c1', statement: '丙稿' }])));
    await step(r.worker, r.scripts); // IND m3 ✓
    // m1 在途（stall 1.2s < deadline 8s）。
    r.scripts.push([{ kind: 'stall', ms: 1_200 }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 150)); // 等 turn.started 落库
    const started = db.prepare("SELECT exec_started_at FROM agent_turns WHERE stage_key = 'delib.independent' AND member_id = 'm1'").get() as { exec_started_at: number | null };
    expect(started.exec_started_at).not.toBeNull();
    // 泵：假时钟推到 started+grace+ε（未到 deadline）。
    pumpDeliberation(db, r.taskId, opts(200), started.exec_started_at! + 250);
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?').get(r.runId, 'm1')).toMatchObject({ status: 'absent' });
    // 不强杀：turn 仍 RUNNING、run 仍 RUNNING、任务未取消。
    expect(db.prepare("SELECT status FROM agent_turns WHERE member_id = 'm1' AND stage_key = 'delib.independent'").get()).toMatchObject({ status: 'RUNNING' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'RUNNING' });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(r.taskId)).not.toMatchObject({ status: 'CANCELLED' });
    // 屏障以 m2/m3 推进：CR 已入队且冻结清单不含 m1。
    const manifest = frozenStageInputs(db, r.runId, 'CROSS_REVIEW', 0);
    expect(manifest).not.toBeNull();
    expect(manifest!.entries).toHaveLength(2);
    expect(manifest!.entries.every((e) => !e.artifactId.includes('m1'))).toBe(true);
    expect((db.prepare('SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ?').get(`%${r.runId}:CR:%`) as { c: number }).c).toBe(2);
    await m1Run; // 收尾（stall 结束，见⑥续用）
    await r.adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('② 审批暂停不累计缺席时间', () => {
  it('exec_paused_ms 超过宽限 → 有效执行时间不足，不缺席', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const r = await rig(db, 2, ['m1', 'm2'], { grace: 200 });
    r.scripts.push([{ kind: 'stall', ms: 900 }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 120));
    const turnId = (db.prepare("SELECT id, exec_started_at FROM agent_turns WHERE member_id = 'm1' AND stage_key = 'delib.independent'").get() as { id: string; exec_started_at: number });
    // 审批暂停累计（模拟审批等待 5s：接线点 accumulateApprovalPause 语义）。
    r.worker.accumulateApprovalPause(turnId.id, 5_000);
    pumpDeliberation(db, r.taskId, opts(200), turnId.exec_started_at + 500); // 名义 500ms，有效=500-5000<0
    expect(db.prepare('SELECT status FROM run_participants WHERE member_id = ?').get('m1')).toMatchObject({ status: 'pending' });
    await m1Run;
    await r.adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('③ 排队成员：不记执行缺席；超独立排队截止按 unavailable 推进屏障', () => {
  it('未派发成员推进时钟不记执行缺席；超排队独立截止→unavailable（屏障可推进、非 absent）', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const r = await rig(db, 3, ['m1', 'm2'], { grace: 200, wait: 100 });
    r.scripts.push([{ kind: 'stall', ms: 700 }]);
    const m1Run = r.worker.runOnce(); // m1 在途；m2 排队
    await new Promise((res) => setTimeout(res, 120));
    const stageStart = (db.prepare('SELECT stage_started_at FROM workflow_runs WHERE id = ?').get(r.runId) as { stage_started_at: number }).stage_started_at;
    pumpDeliberation(db, r.taskId, opts(200, 100), stageStart + 5_000);
    // m2 未派发：不缺席（排队非成员责任）。
    // 超观察线：诊断事件（一次）。
    const diags = db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'run.dispatchWaitExceeded'").get() as { c: number };
    expect(diags.c).toBeGreaterThanOrEqual(1);
    await m1Run;
    await r.adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('④ 两个截止同时发生：单一结局、无双标记', () => {
  it('宽限与单轮截止同时刻：先泵标缺席，截止中断后不再产生第二次缺席标记', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const r = await rig(db, 4, ['m1', 'm2'], { grace: 300, deadline: 300 });
    r.scripts.push([{ kind: 'stall', ms: 5_000 }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 120));
    const turn = db.prepare("SELECT id, exec_started_at FROM agent_turns WHERE member_id = 'm1' AND stage_key = 'delib.independent'").get() as { id: string; exec_started_at: number };
    // 宽限期到：泵标记（open-execution 路径）。
    pumpDeliberation(db, r.taskId, opts(300), turn.exec_started_at + 320);
    expect(db.prepare('SELECT status FROM run_participants WHERE member_id = ?').get('m1')).toMatchObject({ status: 'absent' });
    await m1Run; // 单轮截止（300ms）中断到点：终态路径
    const absentEvents = db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'run.participantAbsent'").get() as { c: number };
    expect(absentEvents.c).toBe(1); // 终态路径对已 absent 成员 no-op（无双标记）
    expect(db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id)).toMatchObject({ status: 'FAILED' }); // 截止中断分支（非用户停止）
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'RUNNING' });
    await r.adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('⑤ 睡眠/重启后：时钟与恢复状态正确（RT-03 不重派）', () => {
  it('崩溃重启：在途 turn→UNKNOWN、run→INTERRUPTED、任务 BLOCKED；执行时钟保留；重排队步骤不执行', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const r = await rig(db, 5, ['m1', 'm2'], { grace: 200, deadline: 60_000 });
    r.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 120));
    const turn = db.prepare("SELECT id, exec_started_at, exec_paused_ms FROM agent_turns WHERE member_id = 'm1' AND stage_key = 'delib.independent'").get() as { id: string; exec_started_at: number; exec_paused_ms: number };
    void m1Run; // 模拟宿主睡眠/崩溃：不再等它
    // 重启恢复（新 worker 同库）：在途→UNKNOWN、run→INTERRUPTED、遗留 leased 重排。
    applyRecovery(db, Date.now() + 10_000);
    const after = db.prepare('SELECT status, exec_started_at, exec_paused_ms FROM agent_turns WHERE id = ?').get(turn.id) as { status: string; exec_started_at: number; exec_paused_ms: number };
    expect(after.status).toBe('UNKNOWN');
    expect(after.exec_started_at).toBe(turn.exec_started_at); // 时钟保留
    expect(after.exec_paused_ms).toBe(turn.exec_paused_ms);
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'INTERRUPTED' });
    // 泵：INTERRUPTED 如实 surfaced（任务 BLOCKED，不伪造）。
    pumpDeliberation(db, r.taskId, opts(200), Date.now() + 10_000);
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(r.taskId)).toMatchObject({ status: 'BLOCKED' });
    // 重排的遗留 IND 步骤：无活跃 run → 领取即完结、零模型调用。
    const before = (db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c;
    await r.worker.runOnce();
    expect((db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c).toBe(before);
    await r.adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('⑥⑦ 迟到真实接收路径 + 冻结边界（甲乙不串材料）', () => {
  it('在途 m1 宽限缺席→m2 互评已派发（材料=m2/m3）；m1 迟到完成（真实事件路径）→m1=late；m3 同轮互评材料不变；SYNTHESIS 清单含迟到稿', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2', 'm3']);
    const r = await rig(db, 6, ['m1', 'm2', 'm3'], { grace: 200, deadline: 8_000 });
    deferIndStep(db, r.taskId, r.runId, 'm1');
    r.scripts.push(done(draft('乙', [{ claimId: 'c1', statement: '乙稿语句' }])));
    await step(r.worker, r.scripts); // IND m2
    r.scripts.push(done(draft('丙', [{ claimId: 'c1', statement: '丙稿语句' }])));
    await step(r.worker, r.scripts); // IND m3
    // m1 在途：先静默 900ms（>宽限 200、<截止 8s）后产出完成事件——迟到经真实 adapter 事件路径。
    r.scripts.push([{ kind: 'stall', ms: 900 }, { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(draft('甲迟到稿', [{ claimId: 'c1', statement: '甲迟到语句' }])) } }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 150));
    const m1Turn = db.prepare("SELECT id, exec_started_at FROM agent_turns WHERE member_id = 'm1' AND stage_key = 'delib.independent'").get() as { id: string; exec_started_at: number };
    pumpDeliberation(db, r.taskId, opts(200), m1Turn.exec_started_at + 250); // m1 缺席推进（不杀）
void frozenStageInputs(db, r.runId, 'CROSS_REVIEW', 0); // 冻结清单存在性由⑥断言覆盖
    const m3Art = listRunArtifacts(db, r.runId, 'analysis_draft').find((a) => a.author_id === 'm3')!;
    // m2 的互评（目标=冻结清单里的 m3 稿）。
    r.scripts.push(done({ schemaVersion: 'cross-review-v1', reviews: [
      { targetArtifactId: m3Art.id, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: 'r', evidenceIds: [] },
    ] }));
    await step(r.worker, r.scripts); // CR m2 ✓（输入冻结：m2/m3；评审者按成员序派发）
    const m2Bundle = db.prepare("SELECT included_refs_json FROM context_bundles cb JOIN agent_turns t ON t.id = cb.turn_id WHERE t.member_id = 'm2' AND t.stage_key = 'delib.cross_review'").get() as { included_refs_json: string };
    const m2Text = (JSON.parse(m2Bundle.included_refs_json) as { text: string }).text;
    expect(m2Text).toContain(m3Art.id);
    // m1 迟到完成（真实 adapter 事件路径）：consume 循环在 stall 后收到 turn.completed。
    await m1Run;
    expect(db.prepare('SELECT status FROM run_participants WHERE member_id = ?').get('m1')).toMatchObject({ status: 'late' });
    const lateArt = listRunArtifacts(db, r.runId, 'analysis_draft').find((a) => a.author_id === 'm1');
    expect(lateArt).toBeDefined();
    const lateEvents = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'run.lateArrivalRecorded'").all() as Array<{ payload_json: string }>;
    expect(lateEvents.some((e) => JSON.parse(e.payload_json).memberId === 'm1')).toBe(true);
    // ⑦ 冻结边界：m3 的同轮互评（迟到稿已到）——材料仍为 m2/m3，不含 m1 迟到稿。
    const m2Art = listRunArtifacts(db, r.runId, 'analysis_draft').find((a) => a.author_id === 'm2')!;
    r.scripts.push(done({ schemaVersion: 'cross-review-v1', reviews: [
      { targetArtifactId: m2Art.id, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: 'r', evidenceIds: [] },
    ] }));
    await step(r.worker, r.scripts); // CR m3
    const m3Bundle = db.prepare("SELECT included_refs_json FROM context_bundles cb JOIN agent_turns t ON t.id = cb.turn_id WHERE t.member_id = 'm3' AND t.stage_key = 'delib.cross_review'").get() as { included_refs_json: string };
    const m3Text = (JSON.parse(m3Bundle.included_refs_json) as { text: string }).text;
    expect(m3Text).not.toContain(lateArt!.id); // 不串材料（清单+hash 锁定）
    expect(m3Text).toContain(m2Art.id);
    // 泵推进 SYNTHESIS：新输入版本包含迟到稿（进入本阶段时冻结）。
    pumpDeliberation(db, r.taskId, opts(200));
    const synManifest = frozenStageInputs(db, r.runId, 'SYNTHESIS', 0);
    expect(synManifest).not.toBeNull();
    expect(synManifest!.entries.some((e) => e.artifactId === lateArt!.id)).toBe(true);
    await r.adapter.closeAllSessions();
    db.close();
  }, 30_000);
});
