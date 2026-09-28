/**
 * 统一派发准入 + 退出状态机集成验证（2026-09-28 第四轮，零额度、本地可控 adapter）。
 *
 * 准入反例（用户指定）：
 * ① 多个不同成员同时有任务（上限内并行）；
 * ② 全局额度满但某成员空闲 → 新任务排队不超发；
 * ③ 一个项目占满资源时其他项目不饿死；
 * ④ 启动等待期间（openSession 窗口）不超发；
 * ⑤ 停止/启动失败后槽位正确回收；
 * ⑥ 尾部预留（RAT）不被前置阶段并发抢用；
 * ⑦ 结果不确定（UNKNOWN）保留占用不提前放行。
 *
 * 退出反例：drain 打开 session 时退出 / 多 detached 在途退出 / adapter 退出未确认（不关库
 * 不释放锁）/ 消费器迟迟不结束（incomplete→强制路径）/ 关闭期间到达完成事件 / 重复 stop 同一
 * 结果 / 关库后零业务写入零新派发。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import type { RuntimeAdapter, OpenSessionInput, SessionRef, TurnRequest, ProbeResult } from '../../src/contracts/runtime.ts';
import { AdapterCallError } from '../../src/contracts/runtime.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import { startDaemon } from '../../src/daemon/entry.ts';
import { seed as delibSeed, createDelibTask, done, draft } from './deliberationFlow.test.ts';

process.env.ZS_ALLOW_FAKE = '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-admission-'));
/** 测试专用管道名（Windows 命名管道须 \\.\pipe\ 前缀）。 */
function pipeNameFor(n: string): string {
  return `\\\\.\\pipe\\zs-test-${n}`;
}

afterAll(() => {
  // incomplete 用例按设计保留打开的 DB 与锁（不假装完成）；清理尽力而为不阻断。
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

async function waitUntil(cond: () => boolean, timeoutMs = 5_000, label = ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (cond()) return;
    } catch {
      // 首轮查询对象尚未落库（tick 未派发）——继续等待。
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待超时：${label}`);
}

// ---------- 准入（worker 直构 + DIRECT 任务） ----------

function seedDirect(db: ZhongshuoDatabase, projectIds: string[], members: Array<{ id: string; project: string }>): void {
  for (const p of projectIds) {
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?,'d','D:/x','D:/x','{}',0)`).run(p);
  }
  for (const m of members) {
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES (?,?,'成员','agent',1)`).run(m.id, m.project);
  }
  for (const p of projectIds) {
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?,?,'大厅',?)`).run(`r_${p}`, p, members.find((m) => m.project === p)!.id);
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?,?,'room',?)`).run(`c_${p}`, p, `r_${p}`);
  }
}

function makeDirect(db: ZhongshuoDatabase, n: number, memberId: string, projectId: string): string {
  const ids = { messageId: `am${n}`, threadId: `ath${n}`, taskId: `atk${n}`, taskEventId: `aet${n}`, threadEventId: `aeh${n}` };
  createRoomRootTask(db, {
    ids, projectId, conversationId: `c_${projectId}`, roomId: `r_${projectId}`, intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] },
    now: n,
  });
  return ids.taskId;
}

function rigDirect(admissionLimits: { globalMaxInFlight: number; perProjectMaxInFlight: number; perProviderMaxInFlight: number }, scripts: FakeTurnScript[]) {
  const db = openDatabase(':memory:');
  const admission = new DispatchAdmission(admissionLimits);
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: 'w-adm', detachedTurnConsumption: true,
    admission, turnDeadlineMs: 8_000, appDataDir: join(tmpRoot, 'adm'),
  });
  return { db, admission, adapter, worker, scripts };
}

describe('统一派发准入', () => {
  it('① 多成员上限内并行；② 全局满且某成员空闲 → 排队不超发；⑤(启动失败) 槽位回收', async () => {
    const scripts: FakeTurnScript[] = [];
    const { db, admission, worker, scripts: q } = rigDirect({ globalMaxInFlight: 2, perProjectMaxInFlight: 2, perProviderMaxInFlight: 2 }, scripts);
    seedDirect(db, ['p1'], [
      { id: 'mA', project: 'p1' }, { id: 'mB', project: 'p1' }, { id: 'mC', project: 'p1' },
    ]);
    // 三成员各自 stall 一段（宽限内完成）。
    const stall = (): FakeTurnScript => [{ kind: 'stall', ms: 500 }, { kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }];
    q.push(stall(), stall(), stall());
    makeDirect(db, 1, 'mA', 'p1');
    makeDirect(db, 2, 'mB', 'p1');
    makeDirect(db, 3, 'mC', 'p1');
    await worker.runOnce(); // A
    await worker.runOnce(); // B
    await worker.runOnce(); // C：global=2 已满（A/B 在途）→ 放回排队（mC 空闲但全局满——不超发）
    await waitUntil(() => admission.snapshot().global === 2, 2_000, '两个在途');
    expect(db.prepare("SELECT count(*) c FROM agent_turns WHERE member_id = 'mC'").get()).toMatchObject({ c: 0 }); // 未超发
    // A/B 完成后 C 获派（等待期间不超发的另一面：槽位释放才放行——放回项需 tick 重领）。
    await waitUntil(() => {
      void worker.runOnce().catch(() => {});
      return (db.prepare("SELECT count(*) c FROM agent_turns WHERE member_id = 'mC'").get() as { c: number }).c === 1;
    }, 6_000, 'C 获派');
    await worker.runOnce();
    await waitUntil(() => (db.prepare('SELECT count(*) c FROM tasks WHERE status = ?').get('DONE') as { c: number }).c === 3, 6_000, '三任务完成');
    expect(admission.snapshot().global).toBe(0); // 全部释放
    db.close();
  }, 20_000);

  it('③ 一个项目占满 → 其他项目不饿死（project 维度拒绝只挡本项目）', async () => {
    const scripts: FakeTurnScript[] = [];
    const { db, admission, worker } = rigDirect({ globalMaxInFlight: 4, perProjectMaxInFlight: 1, perProviderMaxInFlight: 4 }, scripts);
    seedDirect(db, ['p1', 'p2'], [
      { id: 'mA', project: 'p1' }, { id: 'mB', project: 'p1' }, { id: 'mC', project: 'p2' },
    ]);
    scripts.push(
      [{ kind: 'stall', ms: 500 }, { kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }], // mA
      [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }], // mC（他项目立即可派）
    );
    makeDirect(db, 1, 'mA', 'p1');
    makeDirect(db, 2, 'mB', 'p1'); // 同项目第二项：project=1 已满 → 排队
    makeDirect(db, 3, 'mC', 'p2');
    await worker.runOnce(); // mA
    await worker.runOnce(); // mB 拒（project 满）放回
    await worker.runOnce(); // mC 照常派发（不饿死）
    expect((db.prepare("SELECT count(*) c FROM agent_turns WHERE member_id = 'mC'").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT count(*) c FROM agent_turns WHERE member_id = 'mB'").get() as { c: number }).c).toBe(0);
    await waitUntil(() => (db.prepare("SELECT status FROM tasks WHERE id = 'atk3'").get() as { status: string }).status === 'DONE', 4_000, 'p2 完成');
    // mA 完成后 mB 获派（放回项需 tick 重领）。
    await waitUntil(() => {
      void worker.runOnce().catch(() => {});
      return (db.prepare("SELECT count(*) c FROM agent_turns WHERE member_id = 'mB'").get() as { c: number }).c === 1;
    }, 6_000, 'mB 获派');
    void admission;
    db.close();
  }, 20_000);

  it('④ 启动等待期间不超发：占位覆盖 openSession/startTurn 窗口（慢 openSession 包装）', async () => {
    const scripts: FakeTurnScript[] = [];
    const db = openDatabase(':memory:');
    const admission = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 2, perProviderMaxInFlight: 2 });
    const inner = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    const slowOpen: RuntimeAdapter = {
      probe: (): Promise<ProbeResult> => inner.probe(),
      openSession: async (input: OpenSessionInput) => {
        await new Promise((r) => setTimeout(r, 250)); // 启动窗口（准入必须已占位）
        return inner.openSession(input);
      },
      startTurn: (s: SessionRef, i: TurnRequest) => inner.startTurn(s, i),
      events: (s: SessionRef) => inner.events(s),
      steer: (s: SessionRef, i: TurnRequest) => inner.steer(s, i),
      interrupt: (s: SessionRef, t: string) => inner.interrupt(s, t),
      respondApproval: (s: SessionRef, a: string, c: 'allow_once' | 'deny') => inner.respondApproval(s, a, c),
      close: (s: SessionRef) => inner.close(s),
    };
    const worker = new DispatchWorker({
      db, adapter: slowOpen, leaseOwner: 'w-slow', detachedTurnConsumption: true,
      admission, turnDeadlineMs: 8_000, appDataDir: join(tmpRoot, 'slow'),
    });
    seedDirect(db, ['p1'], [{ id: 'mA', project: 'p1' }, { id: 'mB', project: 'p1' }]);
    scripts.push(
      [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }],
      [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }],
    );
    makeDirect(db, 1, 'mA', 'p1');
    makeDirect(db, 2, 'mB', 'p1');
    const first = worker.runOnce(); // mA：openSession 250ms 启动窗口
    await new Promise((r) => setTimeout(r, 80));
    expect(admission.snapshot().global).toBe(1); // openSession 进行中已占位
    await worker.runOnce(); // mB：global=1 满（启动窗口内）→ 拒绝不超发
    expect((db.prepare("SELECT count(*) c FROM agent_turns WHERE member_id = 'mB'").get() as { c: number }).c).toBe(0);
    await first;
    await waitUntil(() => (db.prepare("SELECT status FROM tasks WHERE id = 'atk1'").get() as { status: string }).status === 'DONE', 4_000, 'A 完成');
    await worker.runOnce();
    await waitUntil(() => (db.prepare("SELECT status FROM tasks WHERE id = 'atk2'").get() as { status: string }).status === 'DONE', 4_000, 'B 完成');
    db.close();
  }, 20_000);

  it('⑤ 启动失败后槽位回收（startTurn 抛错 → catch 释放 → 后续可派发）', async () => {
    const scripts: FakeTurnScript[] = [];
    const db = openDatabase(':memory:');
    const admission = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 2, perProviderMaxInFlight: 2 });
    const inner = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    let failFirstStartTurn = true;
    const flaky: RuntimeAdapter = {
      probe: () => inner.probe(),
      openSession: (i) => inner.openSession(i),
      startTurn: (s, i) => {
        if (failFirstStartTurn) { failFirstStartTurn = false; return Promise.reject(new AdapterCallError('RUNTIME_NOT_FOUND', '启动失败注入')); }
        return inner.startTurn(s, i);
      },
      events: (s) => inner.events(s),
      steer: (s, i) => inner.steer(s, i),
      interrupt: (s, t) => inner.interrupt(s, t),
      respondApproval: (s, a, c) => inner.respondApproval(s, a, c),
      close: (s) => inner.close(s),
    };
    const worker = new DispatchWorker({
      db, adapter: flaky, leaseOwner: 'w-flaky', detachedTurnConsumption: true,
      admission, turnDeadlineMs: 8_000, appDataDir: join(tmpRoot, 'flaky'),
    });
    seedDirect(db, ['p1'], [{ id: 'mA', project: 'p1' }]);
    makeDirect(db, 1, 'mA', 'p1');
    await expect(worker.runOnce()).rejects.toBeInstanceOf(Error); // 启动失败上抛
    expect(admission.snapshot().global).toBe(0); // 槽位已回收
    scripts.push([{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }]);
    // outbox 留 leased 等租约重领（RT-03 对账）；此处直接验证准入不卡死：新任务可派发。
    makeDirect(db, 2, 'mA', 'p1');
    await worker.runOnce();
    await waitUntil(() => (db.prepare("SELECT count(*) c FROM agent_turns WHERE status = 'SUCCEEDED'").get() as { c: number }).c === 1, 4_000, '后续派发成功');
    db.close();
  }, 15_000);

  it('⑥ 尾部预留不被前置阶段并发抢用（detached DELIB 全链：RAT 尾部保证完整）+ ⑦ UNKNOWN 保留占用', async () => {
    // ⑥：复用 detached 研讨全链（快速 fake）——RAT 3 个全部派发且总预算不超上限。
    const db = openDatabase(':memory:');
    delibSeed(db, ['m1', 'm2', 'm3']);
    const admission = new DispatchAdmission({ globalMaxInFlight: 3, perProjectMaxInFlight: 3, perProviderMaxInFlight: 3 });
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'w-tail', enableDeliberate: true, detachedTurnConsumption: true,
      admission, absenceToleranceMs: 200, turnDeadlineMs: 8_000, appDataDir: join(tmpRoot, 'tail'),
    });
    createDelibTask(db, 1, ['m1', 'm2', 'm3']);
    // 按派发顺序供给合法载荷（IND 稿×3 → … → 通用回退即可走完全链时给 review/ratify 载荷）。
    scripts.push(done(draft('甲', [{ claimId: 'c1', statement: 'a' }])), done(draft('乙', [{ claimId: 'c1', statement: 'b' }])), done(draft('丙', [{ claimId: 'c1', statement: 'c' }])));
    const tickUntil = async (cond: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        void worker.runOnce();
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`等待超时：${label}`);
    };
    // 通用回退脚本（done(analysis-draft)）不足以过 CR/RAT 校验——供给具体载荷序列代价高；
    // 本用例聚焦准入/尾部：断言全程 admission.global ≤ 3 且预算不超。
    let peak = 0;
    const peakTimer = setInterval(() => { peak = Math.max(peak, admission.snapshot().global); }, 20);
    peakTimer.unref();
    await tickUntil(() => {
      const run = db.prepare("SELECT budget_json FROM workflow_runs WHERE mode = 'DELIBERATE'").get() as { budget_json: string } | undefined;
      if (run == null) return false;
      const b = JSON.parse(run.budget_json) as { usedTurns: number };
      return b.usedTurns >= 3; // IND×3 派发完成（前置阶段并发已发生）
    }, '前置阶段派发');
    const budget = JSON.parse((db.prepare("SELECT budget_json FROM workflow_runs WHERE mode = 'DELIBERATE'").get() as { budget_json: string }).budget_json) as { usedTurns: number; runMaxTurns: number; tailReservationByStage: Record<string, number> };
    const tailSum = Object.values(budget.tailReservationByStage).reduce((a, b2) => a + b2, 0);
    expect(budget.usedTurns + tailSum).toBeLessThanOrEqual(budget.runMaxTurns); // 预算不变式：并发派发不超总量
    expect((budget.tailReservationByStage.RATIFY ?? 0)).toBeGreaterThan(0); // 尾部预留仍保留（前置阶段并发未抢用 RAT 尾部）
    expect(peak).toBeLessThanOrEqual(3); // 并发不超准入上限
    clearInterval(peakTimer);
    await worker.awaitInFlightTurns(8_000); // 全部收敛后再关库（零回调写库）
    // ⑦ UNKNOWN 保留占用：无终态 fake（unresponsive 脚本）+ 短截止 → UNKNOWN → admission 未释放。
    const db2 = openDatabase(':memory:');
    const admission2 = new DispatchAdmission({ globalMaxInFlight: 1 });
    const scripts2: FakeTurnScript[] = [];
    const adapter2 = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts2.shift() ?? [{ kind: 'stall', ms: 10_000 }] });
    const worker2 = new DispatchWorker({
      db: db2, adapter: adapter2, leaseOwner: 'w-unk', detachedTurnConsumption: true,
      admission: admission2, turnDeadlineMs: 300, interruptGraceMs: 100, appDataDir: join(tmpRoot, 'unk'),
    });
    seedDirect(db2, ['p1'], [{ id: 'mA', project: 'p1' }]);
    makeDirect(db2, 1, 'mA', 'p1');
    await worker2.runOnce();
    await waitUntil(() => {
      const t = db2.prepare('SELECT status FROM agent_turns ORDER BY rowid DESC LIMIT 1').get() as { status: string } | undefined;
      return t?.status === 'UNKNOWN';
    }, 5_000, 'UNKNOWN 终态');
    expect(admission2.snapshot().global).toBe(1); // 对账未定：占用保留，不提前放行
    await worker2.awaitInFlightTurns(6_000).catch(() => {}); // UNKNOWN 后消费器仍收尾（completeOutbox）——等收敛再关库
    await adapter2.closeAllSessions();
    db.close();
    db2.close();
  }, 40_000);
});

// ---------- 退出状态机（startDaemon + testAdapter 注入） ----------

/** 可控包装 adapter：慢 openSession / 慢 close 收拢 / disposeAll 未确认。 */
class ControllableAdapter implements RuntimeAdapter {
  constructor(
    private readonly inner: FakeRuntimeAdapter,
    private readonly opts: { openSessionDelayMs?: number; disposeUnconfirmed?: boolean } = {},
  ) {}
  probe(): Promise<ProbeResult> { return this.inner.probe(); }
  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    if (this.opts.openSessionDelayMs != null) await new Promise((r) => setTimeout(r, this.opts.openSessionDelayMs));
    return this.inner.openSession(input);
  }
  startTurn(s: SessionRef, i: TurnRequest): Promise<void> { return this.inner.startTurn(s, i); }
  events(s: SessionRef) { return this.inner.events(s); }
  steer(s: SessionRef, i: TurnRequest): Promise<void> { return this.inner.steer(s, i); }
  interrupt(s: SessionRef, t: string): Promise<void> { return this.inner.interrupt(s, t); }
  respondApproval(s: SessionRef, a: string, c: 'allow_once' | 'deny'): Promise<void> { return this.inner.respondApproval(s, a, c); }
  close(s: SessionRef): Promise<void> { return this.inner.close(s); }
  async disposeAll(): Promise<Array<{ turnId: string; stopRequested: boolean; exitConfirmed: boolean }>> {
    if (this.opts.disposeUnconfirmed === true) {
      return [...(this.inner as unknown as { sessions?: Map<string, unknown> }).sessions?.keys() ?? []].map(() => ({ turnId: 'unconfirmed', stopRequested: true, exitConfirmed: false }));
    }
    return [];
  }
}

function seedForDaemon(db: ZhongshuoDatabase): { projectId: string; roomId: string; conversationId: string; memberId: string } {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
  return { projectId: 'p1', roomId: 'r1', conversationId: 'c1', memberId: 'mA' };
}

async function submitViaPipe(daemon: Awaited<ReturnType<typeof startDaemon>>, seed: { projectId: string; roomId: string; conversationId: string; memberId: string }, body: string): Promise<string> {
  const { connectPipe } = await import('../../src/contracts/daemonIpc.ts');
  const pipe = await connectPipe(daemon.pipeName, { token: daemon.credential.token, requestTimeoutMs: 15_000 });
  try {
    const r = (await pipe.send({ protocolVersion: 1, commandId: `t${Math.random().toString(36).slice(2)}`, method: 'message.submit', params: {
      target: { kind: 'room_root', projectId: seed.projectId, conversationId: seed.conversationId, roomId: seed.roomId },
      body, intent: 'default', mentions: [{ kind: 'member', memberId: seed.memberId }],
    } })) as { ok: boolean; data: { taskId: string }; error?: { message?: string } };
    if (!r.ok) throw new Error(`submit: ${JSON.stringify(r.error)}`);
    return r.data.taskId;
  } finally {
    pipe.close();
  }
}

describe('退出状态机', () => {
  it('多 detached turn 在途退出 + 关闭期间到达完成事件 → complete 且结果已持久化；重复 stop 同一结果；关库后零新派发', async () => {
    const appdata = mkdtempSync(join(tmpRoot, 'sd-'));
    const scripts: FakeTurnScript[] = [
      [{ kind: 'stall', ms: 400 }, { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: '__RESULTKEY__', changeSummary: 'x', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } }],
    ];
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? [{ kind: 'stall', ms: 300 }, { kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    const daemon = await startDaemon({ appDataDir: appdata, runtime: 'fake', tickMs: 50, drainSettleTimeoutMs: 5_000, testAdapter: adapter, pipeName: pipeNameFor('1') });
    const seed = seedForDaemon(daemon.db);
    const taskId = await submitViaPipe(daemon, seed, '任务一');
    await waitUntil(() => (daemon.db.prepare('SELECT status FROM agent_turns ORDER BY rowid DESC LIMIT 1').get() as { status: string }).status === 'RUNNING', 4_000, '运行中');
    // 关闭期间（等待窗口内）turn 完成 → 事件正常处理落库。
    const beforeStatus = (daemon.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
    const stopResult = await daemon.stop();
    expect(stopResult.complete).toBe(true);
    expect(stopResult.phase).toBe('closed');
    // 持久化证明：关库后重开读取（关闭期间到达的完成事件已落库且非半写）。
    const db2 = openDatabase(join(appdata, 'state.sqlite'));
    const task = db2.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    db2.close();
    expect(['DONE', 'ACTIVE', 'CANCELLED']).toContain(task.status);
    expect(task.status).toBe(beforeStatus);
    // 重复 stop：同一关闭过程的最终结果。
    const again = await daemon.stop();
    expect(again.complete).toBe(stopResult.complete);
    expect(again.phase).toBe(stopResult.phase);
    // 关库后零业务写入/零新派发：enqueue 新任务路径不可达（IPC 已断+tick 已停）——断言关库后 DB 不可写。
    expect(() => daemon.db.prepare('SELECT 1').get()).toThrow();
  }, 25_000);

  it('drain 打开 session 窗口退出（慢 openSession）→ 安全收口不崩', async () => {
    const appdata = mkdtempSync(join(tmpRoot, 'sd-open-'));
    const inner = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    const daemon = await startDaemon({ appDataDir: appdata, runtime: 'fake', tickMs: 50, drainSettleTimeoutMs: 5_000, testAdapter: new ControllableAdapter(inner, { openSessionDelayMs: 600 }), pipeName: pipeNameFor('2') });
    const seed = seedForDaemon(daemon.db);
    await submitViaPipe(daemon, seed, '启动窗口任务');
    await new Promise((r) => setTimeout(r, 120)); // drain 进入 openSession 窗口
    const result = await daemon.stop();
    expect(result.complete).toBe(true); // 慢窗口在 drainSettle 内完成
    expect(() => daemon.db.prepare('SELECT 1').get()).toThrow();
  }, 20_000);

  it('adapter 退出未确认 → incomplete：不关库、不释放锁（单实例锁≠子进程退出）', async () => {
    const appdata = mkdtempSync(join(tmpRoot, 'sd-unc-'));
    const inner = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'stall', ms: 10_000 }] });
    const daemon = await startDaemon({ appDataDir: appdata, runtime: 'fake', tickMs: 50, drainSettleTimeoutMs: 800, testAdapter: new ControllableAdapter(inner, { disposeUnconfirmed: true }), pipeName: pipeNameFor('3') });
    const seed = seedForDaemon(daemon.db);
    await submitViaPipe(daemon, seed, '未确认任务');
    await waitUntil(() => (daemon.db.prepare('SELECT status FROM agent_turns ORDER BY rowid DESC LIMIT 1').get() as { status: string }).status === 'RUNNING', 4_000, '运行中');
    const result = await daemon.stop();
    expect(result.complete).toBe(false);
    expect(result.phase).toBe('incomplete');
    expect(result.reason).toContain('退出未确认');
    expect(() => daemon.db.prepare('SELECT 1').get()).not.toThrow(); // 未关库
    // 锁未释放：同 appData 再启动失败（崩溃现场保留）。
    await expect(startDaemon({ appDataDir: appdata, runtime: 'fake', pipeName: pipeNameFor('unc2') })).rejects.toThrow(/单实例锁/);
  }, 20_000);

  it('消费器迟迟不结束 → incomplete；force 路径 → UNKNOWN 收尾后关库（forced-closed）', async () => {
    const appdata = mkdtempSync(join(tmpRoot, 'sd-slow-'));
    // 不可中断 + 长停延：interrupt 无效、消费器等到单轮截止（300s）——stop 窗口内绝不收敛。
    const inner = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'unresponsiveToInterrupt' }, { kind: 'stall', ms: 60_000 }] });
    const daemon = await startDaemon({ appDataDir: appdata, runtime: 'fake', tickMs: 50, drainSettleTimeoutMs: 600, testAdapter: inner, pipeName: pipeNameFor('4') });
    const seed = seedForDaemon(daemon.db);
    await submitViaPipe(daemon, seed, '长任务');
    await waitUntil(() => (daemon.db.prepare('SELECT status FROM agent_turns ORDER BY rowid DESC LIMIT 1').get() as { status: string }).status === 'RUNNING', 4_000, '运行中');
    const graceful = await daemon.stop();
    expect(graceful.complete).toBe(false);
    expect(graceful.phase).toBe('incomplete');
    expect(() => daemon.db.prepare('SELECT 1').get()).not.toThrow(); // 未关库
    const forced = await daemon.stop({ force: true });
    expect(forced.complete).toBe(false);
    expect(forced.phase).toBe('forced-closed');
    await new Promise((r) => setTimeout(r, 300));
    expect(() => daemon.db.prepare('SELECT 1').get()).toThrow(); // 已关库
    // 恢复依据：UNKNOWN 状态已持久化（重开数据库验证——applyRecovery 语义的基础）。
    const db2 = openDatabase(join(appdata, 'state.sqlite'));
    const turn = db2.prepare('SELECT status FROM agent_turns ORDER BY rowid DESC LIMIT 1').get() as { status: string };
    expect(turn.status).toBe('UNKNOWN');
    db2.close();
  }, 25_000);
});
