/**
 * E4 调度解耦（detached turn 消费）集成验证（零额度、假时钟，用户令 2026-09-28 第六节）：
 * - 阶段泵与单个 turn 事件消费解耦：队首成员在途（stall）不阻塞 drain——后续成员照常派发
 *   （inline 语义下此处会被阻塞）；泵经**真实 runOnce 路径**（非测试直调 pumpDeliberation）
 *   在成员在途期间按 absenceGrace 推进屏障：标 absent、入队互评、不强杀成员；
 * - 同成员在途互斥：该成员新步骤/任务放回 pending（skipIds 跳过、不阻塞其他成员），
 *   在途终态后解除并正常派发；
 * - 迟到规则：缺席成员迟到完成走 late（真实事件路径）；
 * - stop 收敛：awaitInFlightTurns 全部收敛后返回空剩余（不确定时如实返回剩余，不假装）。
 * 审批暂停/单轮截止/排队截止/用户停止语义在消费器与泵内部，未改（deliberationE4 既有用例覆盖）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';

import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { frozenStageInputs } from '../../src/daemon/deliberationRunner.ts';
import { listRunArtifacts } from '../../src/persistence/stores/deliberation.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { seed, createDelibTask, done, draft, runIdOf } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-delibdet-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

async function waitUntil(cond: () => boolean, timeoutMs = 5_000, label = ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待超时：${label}`);
}

describe('E4 调度解耦（detached）：泵在途推进 + 成员互斥 + 迟到（真实 runOnce 路径）', () => {
  it('队首 m1 在途不阻塞 m2/m3 派发；泵按宽限标缺席并推进互评（不强杀）；m1 迟到完成=late', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2', 'm3']);
    const taskId = createDelibTask(db, 1, ['m1', 'm2', 'm3']);
    const scripts: FakeTurnScript[] = [];
    let fakeNow = 1_000_000;
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'w-det', enableDeliberate: true, detachedTurnConsumption: true,
      absenceToleranceMs: 200, turnDeadlineMs: 8_000, interruptGraceMs: 50,
      appDataDir: join(tmpRoot, 'a1'), clock: () => fakeNow,
    });

    await worker.runOnce(); // initial → PREPARE（程序步）

    // 队首 m1 IND 在途（stall 1.2s < 单轮截止 8s）：runOnce 立即返回（解耦——inline 会阻塞整轮 drain）。
    scripts.push([{ kind: 'stall', ms: 1_200 }, ...done(draft('甲稿迟到', [{ claimId: 'c1', statement: '甲' }]))]);
    const tDispatch = Date.now();
    expect(await worker.runOnce()).toBe(true);
    expect(Date.now() - tDispatch).toBeLessThan(500); // 不等 turn 终态

    // 跨成员不饿死：m2/m3 IND 照常派发（m1 在途期间）。
    scripts.push(done(draft('乙稿', [{ claimId: 'c1', statement: '乙' }])));
    expect(await worker.runOnce()).toBe(true); // m2 IND
    scripts.push(done(draft('丙稿', [{ claimId: 'c1', statement: '丙' }])));
    expect(await worker.runOnce()).toBe(true); // m3 IND
    await waitUntil(() => {
      const rows = db.prepare("SELECT member_id, status FROM agent_turns WHERE stage_key = 'delib.independent'").all() as Array<{ member_id: string; status: string }>;
      return ['m2', 'm3'].every((m) => rows.find((r) => r.member_id === m)?.status === 'SUCCEEDED');
    }, 5_000, 'm2/m3 IND 完成');

    // 泵经 runOnce（真实调度路径）：m1 在途（仍 RUNNING、stall 未结束）时按宽限标缺席并推进互评。
    const started = db.prepare("SELECT exec_started_at FROM agent_turns WHERE stage_key = 'delib.independent' AND member_id = 'm1'").get() as { exec_started_at: number };
    expect(started.exec_started_at).not.toBeNull();
    fakeNow = started.exec_started_at + 250; // 宽限 200 + ε（假时钟；单轮截止 8s 未到）
    const runId = runIdOf(db);
    // CR 载荷引用冻结清单内真实 artifact（m2 评 m3 稿、m3 评 m2 稿）。
    const drafts = listRunArtifacts(db, runId, 'analysis_draft');
    const m2Art = drafts.find((a) => a.author_id === 'm2')!;
    const m3Art = drafts.find((a) => a.author_id === 'm3')!;
    const reviewOf = (target: string) => done({ schemaVersion: 'cross-review-v1', reviews: [
      { targetArtifactId: target, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: '认同', evidenceIds: [] },
    ] });
    scripts.push(reviewOf(m3Art.id)); // CR m2
    scripts.push(reviewOf(m2Art.id)); // CR m3
    await waitUntil(() => {
      void worker.runOnce(fakeNow); // tick：泵→（屏障开）CR 入队→领取→后台消费
      const cr = db.prepare("SELECT count(*) c FROM agent_turns WHERE stage_key = 'delib.cross_review' AND status = 'SUCCEEDED'").get() as { c: number };
      return cr.c >= 2;
    }, 5_000, 'CR m2/m3 派发完成');

    // 不强杀：m1 turn 仍 RUNNING（缺席推进≠杀成员）；屏障以 m2/m3 推进、冻结清单不含 m1。
    expect(db.prepare("SELECT status FROM agent_turns WHERE member_id = 'm1' AND stage_key = 'delib.independent'").get()).toMatchObject({ status: 'RUNNING' });
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?', ).get(runId, 'm1')).toMatchObject({ status: 'absent' });
    const manifest = frozenStageInputs(db, runId, 'CROSS_REVIEW', 0);
    expect(manifest).not.toBeNull();
    expect(manifest!.entries).toHaveLength(2);
    expect(manifest!.entries.every((e) => !e.artifactId.includes('m1'))).toBe(true);

    // m1 迟到完成（真实事件路径，stall 结束）：absent → late（纳入后续 SYNTHESIS 清单，不复活 IND）。
    const inFlight1 = await worker.awaitInFlightTurns(6_000);
    expect(inFlight1.remaining).toEqual([]);
    await waitUntil(() => (db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?', ).get(runId, 'm1') as { status: string }).status === 'late', 3_000, 'm1 late');
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)).not.toMatchObject({ status: 'CANCELLED' }); // 未整run取消
    const settled = await worker.awaitInFlightTurns(1_000);
    expect(settled.remaining).toEqual([]); // stop 收敛：全部消费器已收口
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('同成员在途互斥：新任务放回 pending（不阻塞其他成员），在途终态后解除派发', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['mA', 'mB']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'w-mux', detachedTurnConsumption: true,
      turnDeadlineMs: 8_000, appDataDir: join(tmpRoot, 'a2'),
    });
    const makeDirect = (n: number, memberId: string): string => {
      const ids = { messageId: `dm${n}`, threadId: `dth${n}`, taskId: `dtk${n}`, taskEventId: `det${n}`, threadEventId: `deh${n}` };
      createRoomRootTask(db, {
        ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
        title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId }],
        author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
        route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] },
        now: n,
      });
      return ids.taskId;
    };
    makeDirect(1, 'mA'); // t1：mA 先
    makeDirect(2, 'mA'); // t2：mA 同成员（应排队）
    makeDirect(3, 'mB'); // t3：另一成员（不应被饿死）

    scripts.push([{ kind: 'stall', ms: 700 }, { kind: 'event', event: { kind: 'turn.completed', finalText: 't1 完成' } }]); // t1 慢后终态
    expect(await worker.runOnce()).toBe(true);  // t1 派发（立即返回）
    expect(await worker.runOnce()).toBe(true);  // t2 领取→mA 在途→放回 pending（跳过）
    // t2 未建 turn、outbox 仍 pending；t3 照常派发完成（跨成员不饿死）。
    expect(db.prepare("SELECT count(*) c FROM agent_turns WHERE member_id = 'mA'").get()).toMatchObject({ c: 1 }); // 只有 t1
    const t2outbox = db.prepare("SELECT status FROM outbox WHERE dispatch_key = 'task:dtk2:initial'").get() as { status: string };
    expect(['pending', 'leased']).toContain(t2outbox.status); // 已放回（lease 由放回语义清空）
    expect(await worker.runOnce()).toBe(true); // t3 派发
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id = ?').get('dtk3') as { status: string }).status === 'DONE', 5_000, 't3 DONE');

    // t1 完成（stall 结束）→ 互斥解除 → t2 派发完成。
    await worker.awaitInFlightTurns(6_000);
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id = ?').get('dtk1') as { status: string }).status === 'DONE', 3_000, 't1 DONE');
    expect(await worker.runOnce()).toBe(true); // t2 现在可派发（脚本走 sequencer 默认回退=合法终态）
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id = ?').get('dtk2') as { status: string }).status === 'DONE', 5_000, 't2 DONE');
    const settled = await worker.awaitInFlightTurns(1_000);
    expect(settled.remaining).toEqual([]);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});
