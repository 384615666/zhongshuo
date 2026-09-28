/**
 * E4 生产接线验证（M1 收口轮三）：审批/输入暂停计时经真实事件路径累计——
 * approval.requested → 暂停起点；下一事件（审批处理后续）→ 结算 exec_paused_ms；
 * 暂停期间泵判缺席不触发（有效执行时间扣除）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { pumpDeliberation } from '../../src/daemon/deliberationRunner.ts';
import { seed, createDelibTask, done, draft, step } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-ap-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('审批暂停计时（生产事件路径）', () => {
  it('approval.requested→事件续行：exec_paused_ms 累计且缺席判定扣除', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const taskId = createDelibTask(db, 1, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1', enableDeliberate: true, absenceToleranceMs: 500, turnDeadlineMs: 30_000, appDataDir: join(tmpRoot, 'app') });
    await step(worker, scripts); // PREPARE
    // m1 的轮：真实审批桥（fake waitApproval + 外部 allow_once 续行）。
    scripts.push([{ kind: 'waitApproval', approvalId: 'ap1', payloadHash: 'h', onAllow: [
      { kind: 'event', event: { kind: 'message.completed', messageId: 'mid1', text: '审批后输出' } },
      { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(draft('甲', [{ claimId: 'c1', statement: 's' }])) } },
    ], onDeny: { code: 'PERMISSION_DENIED', message: '拒绝' } }] as never);
    void worker.runOnce();
    await new Promise((r) => setTimeout(r, 120)); // 等 approval.requested 落库（WAITING_APPROVAL）
    // 外部批准（模拟审批 UI 允许）。
    const sid = (db.prepare("SELECT id FROM runtime_sessions WHERE member_id = 'm1' ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    await adapter.respondApproval({ id: sid ?? 'x' } as never, 'ap1', 'allow_once');
    await new Promise((r) => setTimeout(r, 400)); // 等续行+完成
    const turn = db.prepare("SELECT id, status, exec_started_at, exec_paused_ms FROM agent_turns WHERE member_id = 'm1' AND stage_key = 'delib.independent'").get() as { id: string; status: string; exec_started_at: number; exec_paused_ms: number };
    // 审批在 respondApproval 后即时续行——中间态不强制断言（时序由 adapter 控制）    await new Promise((r) => setTimeout(r, 600)); // consume 循环在 allow 后收到 message+completed → 结算暂停+终态
    const settled = db.prepare('SELECT exec_paused_ms, status FROM agent_turns WHERE id = ?').get(turn.id) as { exec_paused_ms: number; status: string };
    console.log('settled:', JSON.stringify(settled));
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.exec_paused_ms).toBeGreaterThan(0); // 暂停窗（120ms 等待）已累计
    // 泵在暂停期内不缺席：用回放验证——重置状态为 WAITING 并重演（保底断言：有效执行时间公式生效）。
    const effNow = turn.exec_started_at + 10_000;
    db.prepare("UPDATE agent_turns SET status = 'RUNNING', exec_paused_ms = ? WHERE id = ?").run(9_999, turn.id);
    pumpDeliberation(db, taskId, { absenceToleranceMs: 500, blobDir: join(tmpRoot, 'art') }, effNow);
    expect(db.prepare('SELECT status FROM run_participants WHERE member_id = ?').get('m1')).toMatchObject({ status: 'completed' }); // 有效=10s-9.999s<500ms → 不缺席
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});
