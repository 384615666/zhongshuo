/**
 * E4 调度解耦（detached turn 消费）集成验证（零额度、假时钟，用户令 2026-09-28 第六节）：
 * - 阶段泵与单个 turn 事件消费解耦：队首成员在途（stall）不阻塞 drain——后续成员照常派发
 *   （inline 语义下此处会被阻塞）；泵经**真实 runOnce 路径**（非测试直调 pumpDeliberation）
 *   在成员在途超过 absenceGrace 时仍等待，实际完成后才入队互评；
 * - 同成员在途互斥：该成员新步骤/任务放回 pending（skipIds 跳过、不阻塞其他成员），
 *   在途终态后解除并正常派发；
 * - 正常完成：慢成员完成仍正常计入，不误标 late；
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
  it('队首 m1 在途不阻塞 m2/m3 派发；泵跨宽限仍等待；m1 完成正常计入', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2', 'm3']);
    const taskId = createDelibTask(db, 1, ['m1', 'm2', 'm3']);
    const scripts: FakeTurnScript[] = [];
    let fakeNow = 1_000_000;
    const reviewFromFrozenPeer = (text: string): FakeTurnScript | null => {
      const match = /"artifactId"\s*:\s*"([^"]+)"[\s\S]*?"revision"\s*:\s*(\d+)[\s\S]*?"claimId"\s*:\s*"([^"]+)"/.exec(text);
      if (match == null || !text.includes('待评审初稿')) return null;
      return done({ schemaVersion: 'cross-review-v1', reviews: [{
        targetArtifactId: match[1], targetRevision: Number(match[2]), targetClaimId: match[3],
        stance: 'agree', reason: '按冻结 peer 输入动态评审', evidenceIds: [],
      }] });
    };
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: ({ text }) => reviewFromFrozenPeer(text) ?? scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
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
      void worker.runOnce().catch(() => {}); // 准入排队项（project/provider 上限）由 tick 重领
      const rows = db.prepare("SELECT member_id, status FROM agent_turns WHERE stage_key = 'delib.independent'").all() as Array<{ member_id: string; status: string }>;
      return ['m2', 'm3'].every((m) => rows.find((r) => r.member_id === m)?.status === 'SUCCEEDED');
    }, 8_000, 'm2/m3 IND 完成');

    // 泵经 runOnce（真实调度路径）：m1 在途（仍 RUNNING、stall 未结束）时跨宽限仍等待。
    const started = db.prepare("SELECT exec_started_at FROM agent_turns WHERE stage_key = 'delib.independent' AND member_id = 'm1'").get() as { exec_started_at: number };
    expect(started.exec_started_at).not.toBeNull();
    fakeNow = started.exec_started_at + 250; // 宽限 200 + ε（假时钟；单轮截止 8s 未到）
    const runId = runIdOf(db);
    await worker.runOnce(fakeNow);
    expect(db.prepare("SELECT status FROM agent_turns WHERE member_id='m1' AND stage_key='delib.independent'").get()).toMatchObject({status:'RUNNING'});
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id=? AND member_id=?').get(runId,'m1')).toMatchObject({status:'pending'});
    expect(frozenStageInputs(db,runId,'CROSS_REVIEW',0)).toBeNull();
    const inFlight1 = await worker.awaitInFlightTurns(6_000);
    expect(inFlight1.remaining).toEqual([]);
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id=? AND member_id=?').get(runId,'m1')).toMatchObject({status:'completed'});
    expect(frozenStageInputs(db,runId,'CROSS_REVIEW',0)!.entries).toHaveLength(3);
    expect(listRunArtifacts(db,runId,'analysis_draft')).toHaveLength(3);
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

describe('预算硬上限（A 组真实运行缺陷回归，2026-09-28：前置派发占用）', () => {
  it('争议+修复分支在 runMaxTurns 内闭合：并行前置派发不超发（≤cap、不变式成立、budgetSkipped 留审计）', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    createDelibTask(db, 9, ['m1', 'm2']);
    const { simulateDeliberationTurn } = await import('../../src/adapter/fake/deliberationSim.ts');
    let first = true;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      // 首个 IND 输出非法载荷 → 触发格式修复路径；其余按输入契约模拟（含争议讨论分支）。
      turnScriptSequencer: (input) => (first ? ((first = false), [{ kind: 'event', event: { kind: 'turn.completed', finalText: '不是合法载荷' } }]) : simulateDeliberationTurn(input.text)),
    });
    const CAP = 6; // 人为收紧：正常 7 也放不下——预算竞争必须在 6 内收尾
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'w-cap', enableDeliberate: true, detachedTurnConsumption: true,
      absenceToleranceMs: 150, turnDeadlineMs: 8_000, interruptGraceMs: 50,
      deliberateMaxTurns: CAP, appDataDir: join(tmpRoot, 'cap'),
    });
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      void worker.runOnce();
      const st = db.prepare("SELECT status FROM workflow_runs WHERE mode = 'DELIBERATE'").get() as { status: string } | undefined;
      if (st != null && ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(st.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const run = db.prepare("SELECT id, status, budget_json FROM workflow_runs WHERE mode = 'DELIBERATE'").get() as { id: string; status: string; budget_json: string };
    expect(['SUCCEEDED', 'PARTIAL']).toContain(run.status); // 预算不足按合同收尾（不假装全共识）
    const b = JSON.parse(run.budget_json) as { usedTurns: number; runMaxTurns: number; inFlightReservedTurns: number };
    expect(b.usedTurns).toBeLessThanOrEqual(CAP); // 硬上限：不再出现 usedTurns=10>9
    expect(b.inFlightReservedTurns).toBe(0); // 终态时占用全部结算
    const turns = (db.prepare("SELECT count(*) c FROM agent_turns WHERE stage_key LIKE 'delib.%'").get() as { c: number }).c;
    expect(turns).toBeLessThanOrEqual(CAP); // 实发 turn 数=真实调用数，不超上限
    const skipped = (db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'run.budgetSkipped'").get() as { c: number }).c;
    expect(skipped).toBeGreaterThanOrEqual(1); // 预算竞争的落选者留审计（非静默丢弃）
    const task = db.prepare('SELECT status FROM tasks ORDER BY rowid DESC LIMIT 1').get() as { status: string };
    expect(task.status).toBe('DONE'); // 收尾交付（带异议/缩减覆盖——如实）
    await worker.awaitInFlightTurns(5_000);
    db.close();
  }, 60_000);
});
