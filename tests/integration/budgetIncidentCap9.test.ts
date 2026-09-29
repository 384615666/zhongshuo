/**
 * 预算事故分支 cap=9 回归（第六轮，§三——与 A 组真实事故同构）：
 * 两成员 + 真实争议讨论（DIS×2）+ 一次格式修复 + 前置步骤竞争派发窗口（detached 并行领取）
 * + SYN/RAT 尾部预留保护。**先断言这些分支确实发生**（预算过早截断会走不到事故点——
 * 前置条件本身即测试），再验证：
 * - runtime startTurn **实际调用计数** ≤ 上限（不只数 agent_turns 行）；
 * - 账目合同：usedTurns+尾部预留不变式、终态在途占用=0、budgetSkipped 留审计（不静默）；
 * - 耗尽后不再调用，按合同收尾（RAT 缺席覆盖 → 报告如实非全 unanimous——不伪造全共识）。
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/db.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { simulateDeliberationTurn } from '../../src/adapter/fake/deliberationSim.ts';
import { seed, createDelibTask } from './deliberationFlow.test.ts';

describe('预算事故分支 cap=9（争议+修复+并行前置派发；A 组同构）', () => {
  it('先断言分支发生，再验 startTurn 实计数≤9、账目闭合、耗尽按合同收尾', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    createDelibTask(db, 11, ['m1', 'm2']);
    const CAP = 9;
    let startTurnCalls = 0;
    let firstInd = true;
    let crDone = false;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        if (firstInd && input.text.includes('独立分析成员')) {
          firstInd = false;
          return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '首次输出不是合法研讨载荷（触发一次格式修复）' } }];
        }
        if (!crDone && input.text.includes('cross-review-v1')) {
          // 首个 CR 显式 disagree（与 deliberationFlow 争议用例同构）→ 必然产生 issue → 争议讨论分支。
          crDone = true;
          // 冻结清单为 pretty-print JSON——正则容忍空白跨行。
          const blocks = [...input.text.matchAll(/"artifactId"\s*:\s*"([^"]+)"[\s\S]{0,120}?"revision"\s*:\s*(\d+)/g)];
          const target = blocks[0];
          if (target != null) {
            return [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: 'cross-review-v1', reviews: [{ targetArtifactId: target[1], targetRevision: Number(target[2]), targetClaimId: 'c1', stance: 'disagree', reason: '风险论证不足（注入争议）', evidenceIds: ['ev2'] }] }) } }];
          }
          return [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: 'cross-review-v1', reviews: [] }) } }];
        }
        return simulateDeliberationTurn(input.text);
      },
    });
    const counting = {
      probe: adapter.probe.bind(adapter),
      openSession: (i: Parameters<typeof adapter.openSession>[0]) => adapter.openSession(i),
      startTurn: (s: Parameters<typeof adapter.startTurn>[0], i: Parameters<typeof adapter.startTurn>[1]) => {
        startTurnCalls += 1; // runtime 实际调用计数（先于一切状态行——不经 agent_turns）
        return adapter.startTurn(s, i);
      },
      events: (s: Parameters<typeof adapter.events>[0]) => adapter.events(s),
      steer: (s: Parameters<typeof adapter.steer>[0], i: Parameters<typeof adapter.steer>[1]) => adapter.steer(s, i),
      interrupt: (s: Parameters<typeof adapter.interrupt>[0], t: string) => adapter.interrupt(s, t),
      respondApproval: (s: Parameters<typeof adapter.respondApproval>[0], a: string, c: 'allow_once' | 'deny') => adapter.respondApproval(s, a, c),
      close: (s: Parameters<typeof adapter.close>[0]) => adapter.close(s),
    };
    const worker = new DispatchWorker({
      db, adapter: counting, leaseOwner: 'w-cap9', enableDeliberate: true, detachedTurnConsumption: true,
      absenceToleranceMs: 150, turnDeadlineMs: 8_000, interruptGraceMs: 50,
      deliberateMaxTurns: CAP, appDataDir: process.env.TEMP ? `${process.env.TEMP}/zs-cap9` : '/tmp/zs-cap9',
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      void worker.runOnce();
      const st = db.prepare("SELECT status FROM workflow_runs WHERE mode = 'DELIBERATE'").get() as { status: string } | undefined;
      if (st != null && ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(st.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // ── 前置条件：事故分支确实发生（否则本用例没走到要验的点） ──
    const stageOf = (key: string) => (db.prepare("SELECT count(*) c FROM agent_turns WHERE stage_key LIKE ?").get(key) as { c: number }).c;
    expect(stageOf('delib.independent.fx%')).toBeGreaterThanOrEqual(1); // 真实触发一次格式修复
    expect(stageOf('delib.issue_discussion%')).toBeGreaterThanOrEqual(1); // 争议讨论分支真实进入
    expect(stageOf('delib.synthesis%')).toBe(1); // SYN 尾部仍被执行（预留被保护）
    // 争议分支的竞争落选者（第二 DIS/checkpoint——修复前正是漏发第 10 个调用的形态）：
    const skippedKeys = (db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'run.budgetSkipped'").all() as Array<{ payload_json: string }>)
      .map((r) => (JSON.parse(r.payload_json) as { dispatchKey: string }).dispatchKey);
    const allStages = (db.prepare("SELECT stage_key FROM agent_turns WHERE stage_key LIKE 'delib.%' ORDER BY rowid").all() as Array<{ stage_key: string }>).map((r) => r.stage_key);
    expect(skippedKeys.some((k) => k.includes('issue_discussion') || k.includes('checkpoint') || k.includes(':ISS:') || k.includes(':CHK:')), `stages=${allStages.join(',')} skipped=${skippedKeys.join(',')}`).toBe(true); // 落选=争议分支内部竞争（非其他阶段）
    // ── 上限与实计数 ──
    const turns = (db.prepare("SELECT count(*) c FROM agent_turns WHERE stage_key LIKE 'delib.%'").get() as { c: number }).c;
    expect(turns).toBe(CAP); // 本构型确定性收口：前置 6（IND2+修复1+CR2+DIS1）+ 尾部 3（SYN1+RAT2）= 9
    expect(startTurnCalls).toBe(turns); // 每个 turn 恰一次 runtime 调用（无隐藏重试/重复启动）
    expect(startTurnCalls).toBeLessThanOrEqual(CAP);
    // ── 账目合同 ──
    const run = db.prepare("SELECT id, status, budget_json FROM workflow_runs WHERE mode = 'DELIBERATE'").get() as { id: string; status: string; budget_json: string };
    expect(['SUCCEEDED', 'PARTIAL']).toContain(run.status);
    const b = JSON.parse(run.budget_json) as { usedTurns: number; inFlightReservedTurns: number; tailReservationByStage: Record<string, number> };
    expect(b.usedTurns).toBeLessThanOrEqual(CAP);
    expect(b.inFlightReservedTurns).toBe(0); // 终态在途占用全部结算（含退款）
    // 不变式全程成立（终态复核）：used + 尾部保留 ≤ cap。
    expect(b.usedTurns + Object.values(b.tailReservationByStage).reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(CAP);
    // ── 耗尽收尾：budgetSkipped 留审计；缺席 RAT 覆盖如实（不伪造全共识） ──
    const skipped = (db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'run.budgetSkipped'").get() as { c: number }).c;
    expect(skipped).toBeGreaterThanOrEqual(1); // 竞争落选者（DIS 第二轮/RAT 之一）留审计而非静默
    const ratCount = stageOf('delib.ratify%');
    expect(ratCount).toBeLessThanOrEqual(2);
    const task = db.prepare('SELECT status FROM tasks ORDER BY rowid DESC LIMIT 1').get() as { status: string };
    expect(task.status).toBe('DONE'); // 按合同收尾交付（带异议/缩减覆盖）
    await worker.awaitInFlightTurns(5_000);
    db.close();
  }, 90_000);
});
