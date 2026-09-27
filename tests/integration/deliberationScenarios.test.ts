/**
 * DELIBERATE 编排场景（零额度）：E4 缺席假时钟、非法输出一次修复、停止、
 * 全员失败 BLOCKED、无争议跳过讨论。与 deliberationFlow（全链/预算）互补。
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
import { listRunArtifacts } from '../../src/persistence/stores/deliberation.ts';
import { pumpDeliberation } from '../../src/daemon/deliberationRunner.ts';
import { seed, createDelibTask, done, draft, runIdOf, step } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-delibscn-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function make(db: ZhongshuoDatabase, n: number, members: string[], opts?: { maxTurns?: number; absenceMs?: number }) {
  const taskId = createDelibTask(db, n, members);
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: 'w1', enableDeliberate: true,
    absenceToleranceMs: opts?.absenceMs ?? 60_000, appDataDir: join(tmpRoot, `app-${n}`),
    deliberateMaxTurns: opts?.maxTurns,
  });
  return { taskId, scripts, adapter, worker };
}

describe('E4 缺席容忍（假时钟，不等真实 20 分钟）', () => {
  it('m2 超时缺席：屏障以现有成果推进，roster 标 absent，报告如实 unconfirmed', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    // m2 的 IND 步骤用 stall（不响应）——缺席由假时钟+泵标记，不真实等待。
    const { taskId, scripts, adapter, worker } = make(db, 1, ['m1', 'm2'], { absenceMs: 50 });
    scripts.push(done(draft('甲', [{ claimId: 'c1', statement: '结论' }])));
    await step(worker, scripts); // PREPARE
    await step(worker, scripts); // IND m1 ✓
    // 泵按推进的假时钟标记 m2 缺席并推进屏障（不走真实 wall-clock）。
    pumpDeliberation(db, taskId, { absenceToleranceMs: 50, blobDir: join(tmpRoot, 'app-1', 'artifacts') }, Date.now() + 60_000);
    const runId = runIdOf(db);
    const participant = db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?').get(runId, 'm2') as { status: string };
    expect(participant.status).toBe('absent');
    // 屏障推进：stage 不再停在 INDEPENDENT（以 m1 单人成果继续）。
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'CROSS_REVIEW' });
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('非法输出与一次格式修复（§6.4）', () => {
  it('首输出非法 → 一次修复成功计入；修复仍非法 → 席位 failed（OUTPUT_INVALID 不冒充）', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1']);
    const { scripts, adapter, worker } = make(db, 2, ['m1']);
    await step(worker, scripts); // PREPARE
    scripts.push(done({ schemaVersion: 'analysis-draft-v1', summary: '缺 claims 的非法稿' } as unknown)); // IND m1 首输出非法
    await step(worker, scripts);
    expect((db.prepare("SELECT count(*) c FROM agent_turns WHERE stage_key LIKE 'delib.independent%' AND status = 'FAILED'").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE '%RPR%'").get() as { c: number }).c).toBe(1); // 修复步骤入队
    scripts.push(done(draft('甲修复稿', [{ claimId: 'c1', statement: '结论' }])));
    await step(worker, scripts); // 修复成功 → 计入屏障
    expect(listRunArtifacts(db, runIdOf(db), 'analysis_draft')).toHaveLength(1);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('停止作用于指定运行（UI 切换不改变目标）', () => {
  it('运行中 task.stop → 在途 turn 中断 → run/task CANCELLED，不再派发后续步骤', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const { taskId, scripts, adapter, worker } = make(db, 3, ['m1', 'm2'], { maxTurns: 20 });
    await step(worker, scripts); // PREPARE
    scripts.push(done(draft('甲', [{ claimId: 'c1', statement: 's' }])));
    await step(worker, scripts); // IND m1
    // 用户停止（§7.3）：run 状态推进 + 在途 m2 turn 中断。
    const runId = runIdOf(db);
    db.prepare("UPDATE tasks SET stop_generation = 1 WHERE id = ?").run(taskId);
    db.prepare("UPDATE workflow_runs SET status = 'STOPPING' WHERE id = ?").run(runId);
    const m2Turn = db.prepare("SELECT id FROM agent_turns WHERE stage_key = 'delib.independent' AND member_id = 'm2'").get() as { id: string } | undefined;
    // m2 的 IND 步骤在派发守卫处被停止拦截（不启动模型调用）。
    scripts.push(done(draft('乙', [{ claimId: 'c1', statement: 's2' }])));
    const claimed = await worker.runOnce();
    expect(claimed).toBe(true);
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status).toBe('CANCELLED');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('CANCELLED');
    void m2Turn;
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('全员失败 → 明确阻塞（不合成虚构研讨报告）', () => {
  it('两成员 IND 全失败且修复耗尽 → 任务 BLOCKED、零成果、无整合', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const { taskId, scripts, adapter, worker } = make(db, 4, ['m1', 'm2'], { maxTurns: 20 });
    await step(worker, scripts); // PREPARE
    const bad = () => done({ 不是: '合法载荷' });
    // m1 首输出非法（入队修复）；IND:m2 排在 RPR:m1 前——先失败 m2，再耗尽 m1 的修复。
    scripts.push(bad());
    await step(worker, scripts); // IND m1 非法
    scripts.push([{ kind: 'event', event: { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: 'x', retryable: true } }]);
    await step(worker, scripts); // IND m2 失败
    scripts.push(bad());
    await step(worker, scripts); // RPR m1 修复仍非法 → 耗尽
    console.log('after m2: turns=', JSON.stringify(db.prepare('SELECT member_id, stage_key, status FROM agent_turns').all()), 'outbox=', JSON.stringify(db.prepare('SELECT dispatch_key, status FROM outbox').all()));
    // 泵：全员无有效输入且终结 → BLOCKED。
    pumpDeliberation(db, taskId, { absenceToleranceMs: 60_000, blobDir: join(tmpRoot, 'app-4', 'artifacts') });
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('BLOCKED');
    expect(listRunArtifacts(db, runIdOf(db), 'analysis_draft')).toHaveLength(0);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

describe('无争议跳过分歧讨论（§6.1）', () => {
  it('互评全 agree → 直入 SYNTHESIS（无 issues/讨论步骤）', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const { scripts, adapter, worker } = make(db, 5, ['m1', 'm2'], { maxTurns: 20 });
    await step(worker, scripts); // PREPARE
    scripts.push(done(draft('甲', [{ claimId: 'c1', statement: 's' }])));
    await step(worker, scripts);
    scripts.push(done(draft('乙', [{ claimId: 'c1', statement: 's' }])));
    await step(worker, scripts);
    const runId = runIdOf(db);
    const drafts = listRunArtifacts(db, runId, 'analysis_draft');
    scripts.push(done({ schemaVersion: 'cross-review-v1', reviews: [{ targetArtifactId: drafts.find((a) => a.author_id === 'm2')!.id, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: 'r', evidenceIds: [] }] }));
    await step(worker, scripts);
    scripts.push(done({ schemaVersion: 'cross-review-v1', reviews: [{ targetArtifactId: drafts.find((a) => a.author_id === 'm1')!.id, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: 'r', evidenceIds: [] }] }));
    await step(worker, scripts);
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'SYNTHESIS' });
    expect((db.prepare('SELECT count(*) c FROM issues').get() as { c: number }).c).toBe(0);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});
