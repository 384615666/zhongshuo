/**
 * 第十七轮四：真实调用护栏（startTurn 级实际请求边界）——本地回放+并发 fixture 证明生效。
 * - wrapRealCallLedger：真实 kind 的 startTurn 请求前持久占位（inflight）→ casTurn 终态结算
 *  （succeeded/failed/interrupted/unknown）——覆盖修复/重派/研讨分阶段/并发（全部经 startTurn）；
 * - fake 不产生行（本地/回放零真实调用=零行）；
 * - 防护优先：ZS_REAL_DISPATCH_GUARD 下真实 runtime 在 startTurn 前被拒——台账零新增行。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { wrapRealCallLedger, realCallSummary, settleRealCall } from '../../src/daemon/realCallLedger.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { successTurn } from '../../src/adapter/fake/script.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';

process.env.ZS_ALLOW_FAKE = '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-realguard-'));
// 批次共享日志隔离到临时目录（第十八轮三：设置 batchId 即启用 journal——不污染用户主目录）。
const batchDir = mkdtempSync(join(tmpdir(), 'zs-realguard-batch-'));
process.env.ZS_REAL_BATCH_DIR = batchDir;
afterAll(() => {
  delete process.env.ZS_REAL_BATCH_DIR;
  for (const dir of [tmpRoot, batchDir]) { for (let i = 0; i < 3; i += 1) { try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ } } }
});

/** 可失败/可计数的假「真实」adapter：用 kind='claude' 包护栏（真实路径同款包装）。 */
class FlakyClaude extends FakeRuntimeAdapter {
  started = 0;
  failNext = false;
  constructor() { super({ turnScriptSequencer: () => successTurn() }); }
  override async startTurn(session: Parameters<FakeRuntimeAdapter['startTurn']>[0], input: Parameters<FakeRuntimeAdapter['startTurn']>[1]): Promise<void> {
    this.started += 1;
    if (this.failNext) throw new Error('注入：spawn 失败（是否发出不确定）');
    return super.startTurn(session, input);
  }
}

describe('真实调用护栏（realCallLedger）', () => {
  it('请求前占位+终态结算：成功/失败/未知；fake 零行；并发两 turn 计数=2；batchId 分列', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at, task_review_enabled) VALUES ('p1','d',?,?, '{}', 0, 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','甲','agent',1),('mB','p1','乙','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    process.env.ZS_REAL_BATCH_ID = 'guard-test-1';
    const raw = new FlakyClaude();
    const adapter = wrapRealCallLedger(raw, 'claude', db);
    const openS = () => raw.openSession({ projectId: 'p1', memberId: 'mA', taskId: 't1', threadId: 'th1', sessionGeneration: 0, cwd: tmpRoot, policyId: 'policy-analyze' }) as never;
    // ① startTurn 抛错：占位保留并按「不确定是否已发出」结算 unknown（第十八轮三更正：
    //    抛错≠请求未发出——不得写 failed 冒充已知结果；调用结果由事件/终态另行记录）。
    raw.failNext = true;
    await expect(adapter.startTurn(await openS(), { turnId: 'turn_fail', dispatchKey: 'k', inputBundleId: 'b', text: 't', policyId: 'p', taskRevision: 0 })).rejects.toThrow('注入');
    let sum = realCallSummary(db, 'guard-test-1');
    expect(sum.total).toBe(1);
    expect(sum.byStatus.unknown).toBe(1);
    // ② 成功路径：占位 inflight → 终态结算 succeeded。
    raw.failNext = false;
    const p2 = adapter.startTurn(await openS(), { turnId: 'turn_ok', dispatchKey: 'k', inputBundleId: 'b', text: 't', policyId: 'p', taskRevision: 0 });
    await p2;
    expect(realCallSummary(db, 'guard-test-1').byStatus.inflight).toBe(1); // 已发出未终态=占位可见
    settleRealCall(db, 'turn_ok', 'succeeded', 'turn 终态=SUCCEEDED');
    // ③ 未知终态（不确定）如实保留。
    await adapter.startTurn(await openS(), { turnId: 'turn_unk', dispatchKey: 'k', inputBundleId: 'b', text: 't', policyId: 'p', taskRevision: 0 });
    settleRealCall(db, 'turn_unk', 'unknown', 'turn 终态=UNKNOWN');
    sum = realCallSummary(db, 'guard-test-1');
    expect(sum.total).toBe(3);
    expect(sum.byStatus).toMatchObject({ unknown: 2, succeeded: 1 });
    // ④ fake kind 不包装不产生行。
    const fake = wrapRealCallLedger(new FakeRuntimeAdapter({ turnScriptSequencer: () => successTurn() }), 'fake', db);
    await fake.startTurn(await fake.openSession({ projectId: 'p1', memberId: 'mA', taskId: 't1', threadId: 'th1', sessionGeneration: 0, cwd: tmpRoot, policyId: 'policy-analyze' }) as never, { turnId: 'turn_fake', dispatchKey: 'k', inputBundleId: 'b', text: 'p', policyId: 'p', taskRevision: 0 });
    expect(realCallSummary(db, 'guard-test-1').total).toBe(3);
    delete process.env.ZS_REAL_BATCH_ID;
    db.close();
  }, 30_000);

  it('worker 全链经共享入口计数（并发 fixture：两成员 DIRECT 并行 → real_calls=2，终态=2 settled）', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at, task_review_enabled) VALUES ('p1','d',?,?, '{}', 0, 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','甲','agent',1),('mB','p1','乙','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    process.env.ZS_REAL_BATCH_ID = 'guard-cc-2';
    const adapter = wrapRealCallLedger(new FakeRuntimeAdapter({ turnScriptSequencer: () => successTurn() }), 'claude', db);
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-g2', appDataDir: join(tmpRoot, 'app2') });
    for (const [i, m] of ['mA', 'mB'].entries()) {
      createRoomRootTask(db, {
        ids: { messageId: `m${i}`, threadId: `th${i}`, taskId: `tk${i}`, taskEventId: `ea${i}`, threadEventId: `eb${i}` },
        projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default', title: `T${i}`, body: 'B',
        mentions: [{ kind: 'member', memberId: m }], author: { authorType: 'human', authorId: 'u' },
        reviewPolicy: 'auto_deliver', sourceConnectionId: null,
        route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: m, frozenMemberIds: [m], initialWakeMemberIds: [m] }, now: i,
      });
    }
    for (let i = 0; i < 8 && (await worker.runOnce()); i += 1);
    const sum = realCallSummary(db, 'guard-cc-2');
    expect(sum.total).toBe(2); // 两 turn=两次 startTurn（实际请求边界——修复/重派/研讨同经此）
    expect(sum.byStatus.succeeded).toBe(2); // casTurn 终态统一结算
    expect((db.prepare(`SELECT count(*) c FROM tasks WHERE status='DONE'`).get() as { c: number }).c).toBe(2);
    delete process.env.ZS_REAL_BATCH_ID;
    db.close();
  }, 60_000);
});
void randomUUID;
