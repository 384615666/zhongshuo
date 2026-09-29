/**
 * DEV-13 第七轮：OS 退出证据由正式服务端生成与绑定（零额度——真实本地子进程+故障注入）。
 * 全部用例经正式命令链（dispatchDaemonCommand → recovery.probeProcess / recovery.reconcile），
 * 不以直调辅助函数的通过冒充正式链路已接通。覆盖：
 * - 活进程（结算但保留保护）/ 已退出（释放+准入联动）/ 身份缺失 / PID 复用（不同启动时刻=
 *   不是原进程→不可据此判退出）/ 查询失败（注入 unknown——不以查询故障推断退出）；
 * - 错误 turn 的 probe 引用拒绝；调用方自报 alive=false（旧参数）参数层拒绝；
 * - notStarted 人工分离：无 manualRiskAck 拒绝；人工声明（风险确认）=退款+FAILED 但**租约
 *   保留**、事件 recordedAs=manual-claim——不伪装为程序已确认事实；
 * - none 模型（无子进程）：程序事实释放；
 * - probeProcess 只读（不改 turn/租约/预算）。
 * 进程登记用正式 registerTurnProcess（对账命令按 turn 已登记身份取证——登记函数本身不是
 * 被测对账对象；worker 登记接线由 uiE2e 崩溃链与 unit 路径覆盖）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';
import { registerTurnProcess, recordProcessTreeObservation } from '../../src/daemon/processRegistry.ts';
import { checkProcessLiveness, collectTreeRows, snapshotProcessTable } from '../../src/daemon/processCheck.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-probe7-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

let taskSeq = 0;
function makeUnknownTurn(db: ZhongshuoDatabase): { turnId: string; runId: string; leaseDomain: string } {
  taskSeq += 1;
  const ids = { messageId: `pm${taskSeq}`, threadId: `pth${taskSeq}`, taskId: `ptk${taskSeq}`, taskEventId: `pe${taskSeq}`, threadEventId: `ph${taskSeq}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${taskSeq}`, body: `B${taskSeq}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: taskSeq,
  });
  const runId = `run_${randomUUID()}`;
  const turnId = `turn_probe7_${taskSeq}`;
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', ?, 'DIRECT', 0, 'INTERRUPTED', ?)`)
    .run(runId, ids.taskId, ids.threadId, JSON.stringify({ runMaxTurns: 6, usedTurns: 0, inFlightReservedTurns: 1 }));
  db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', ?, 'mA', 'direct.work', 'UNKNOWN', ?, 1, 1)`)
    .run(turnId, runId, ids.threadId, `task:${ids.taskId}:initial`);
  const leaseDomain = `d:/probe7/${taskSeq}`;
  db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, ?, 1, 0, 'active')`).run(leaseDomain, turnId);
  return { turnId, runId, leaseDomain };
}

interface Harness {
  db: ZhongshuoDatabase;
  cmd: <T>(method: string, params: unknown) => Promise<T>;
  raw: (method: string, params: unknown) => Promise<{ ok: boolean; error?: { message: string } }>;
  releasedTurns: string[];
}

function makeHarness(overrides: Partial<DaemonCommandDeps> = {}): Harness {
  const db = openDatabase(':memory:');
  seed(db);
  const releasedTurns: string[] = [];
  const deps: DaemonCommandDeps = {
    db, localUserId: 'u_probe7', interruptTurn: async () => {},
    appDataDir: join(tmpRoot, 'app'),
    releaseAdmission: (turnId: string) => { releasedTurns.push(turnId); },
    ...overrides,
  };
  return {
    db,
    cmd: async <T,>(method: string, params: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `cmd-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
    raw: async (method: string, params: unknown) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `cmd-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; error?: { message: string } }>,
    releasedTurns,
  };
}

/** 模拟 worker 生产行为：startTurn 后进程树观察（追加式身份登记，生产函数链）。 */
function takeSnapshot(db: ZhongshuoDatabase, turnId: string, rootPid: number): void {
  const table = snapshotProcessTable();
  if (table.state === 'ok') recordProcessTreeObservation(db, turnId, rootPid, collectTreeRows(table.rows, rootPid));
}

function spawnAliveChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  child.on('error', () => { /* 测试进程管理 */ });
  return child;
}

describe('DEV-13 第七轮：服务端退出取证与恢复对账（正式命令链）', () => {
  it('活进程：probe=alive；reconcile executed → 预算结算但租约/准入保留，turn 保持 UNKNOWN', async () => {
    const h = makeHarness();
    const { turnId, runId, leaseDomain } = makeUnknownTurn(h.db);
    const child = spawnAliveChild();
    await new Promise((r) => setTimeout(r, 400));
    const liveness = checkProcessLiveness(child.pid!);
    expect(liveness.state).toBe('alive'); // 前置：真实子进程可观测
    if (liveness.state === 'alive') {
      registerTurnProcess(h.db, {
        turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn',
        pid: child.pid!, startedAtMs: liveness.identity.startedAt, identitySource: liveness.identity.startedAt != null ? 'os-starttime' : 'pid-only',
      });
    }
    const probe = await h.cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(probe.result).toBe('alive');
    const r = await h.cmd<{ turnFinalStatus: string; releasedLeases: string[]; reason: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: '渠道账单已计费（测试注入）' });
    expect(r.turnFinalStatus).toBe('UNKNOWN'); // 不提前收口
    expect(r.releasedLeases).toEqual([]);
    expect(r.reason).toContain('protection-retained');
    expect(h.db.prepare(`SELECT status FROM workspace_leases WHERE lock_domain = ?`).get(leaseDomain) as { status: string }).toMatchObject({ status: 'active' });
    expect((h.db.prepare('SELECT budget_mark FROM agent_turns WHERE id = ?').get(turnId) as { budget_mark: string }).budget_mark).toBe('settled');
    expect(JSON.parse((h.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json).usedTurns).toBe(1);
    expect(h.releasedTurns).toEqual([]); // 准入占位不解除
    child.kill();
    h.db.close();
  }, 30_000);

  it('已退出：probe=exited；reconcile executed → FAILED+租约释放+准入联动（同 daemon 正常解除）', async () => {
    const h = makeHarness();
    const { turnId, runId, leaseDomain } = makeUnknownTurn(h.db);
    const child = spawnAliveChild();
    await new Promise((r) => setTimeout(r, 400));
    const liveness = checkProcessLiveness(child.pid!);
    if (liveness.state === 'alive') {
      registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: child.pid!, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
      takeSnapshot(h.db, turnId, child.pid!); // 第八轮：worker 生产行为——startTurn 后首拍进程树快照
    }
    child.kill();
    await new Promise((r) => setTimeout(r, 900));
    const probe = await h.cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    // 第九轮：周期快照不构成完整退出证明——「未观察到存活后代」仍=unknown（路径关闭）。
    expect(probe.result).toBe('unknown');
    expect(probe.detail).toContain('未完整确认');
    // probe 只读：状态未变。
    expect((h.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string }).status).toBe('UNKNOWN');
    const r = await h.cmd<{ turnFinalStatus: string; releasedLeases: string[]; reason: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: 'OS 观察完成（周期快照机制边界内）' });
    expect(r.turnFinalStatus).toBe('UNKNOWN'); // 结算但保护保留（解除路径关闭）
    expect(r.releasedLeases).toEqual([]);
    expect(r.reason).toBe('executed-exit-unknown-protection-retained');
    expect(h.db.prepare(`SELECT status FROM workspace_leases WHERE lock_domain = ?`).get(leaseDomain) as { status: string }).toMatchObject({ status: 'active' });
    expect(h.releasedTurns).toEqual([]); // 不触发准入解除
    h.db.close();
  }, 30_000);

  it('身份缺失：无登记 → probe=identity-missing；executed → 保留保护（如实不推断）', async () => {
    const h = makeHarness();
    const { turnId } = makeUnknownTurn(h.db);
    const probe = await h.cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(probe.result).toBe('identity-missing');
    expect(probe.detail).toContain('无进程身份登记');
    const r = await h.cmd<{ turnFinalStatus: string; reason: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: '人工确认执行过，但无进程身份可核对' });
    expect(r.turnFinalStatus).toBe('UNKNOWN');
    expect(r.reason).toContain('identity-missing');
    h.db.close();
  }, 30_000);

  it('PID 复用：登记启动时刻与当前不符 → probe=unknown（复用检测），executed → 保留保护', async () => {
    const h = makeHarness();
    const { turnId, runId } = makeUnknownTurn(h.db);
    const child = spawnAliveChild();
    await new Promise((r) => setTimeout(r, 400));
    const liveness = checkProcessLiveness(child.pid!);
    if (liveness.state === 'alive') {
      // 篡改历史启动时刻（模拟 PID 被复用：同 PID、不同代次）。
      registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: child.pid!, startedAtMs: (liveness.identity.startedAt ?? Date.now()) - 3_600_000, identitySource: 'os-starttime' });
    }
    const probe = await h.cmd<{ result: string; reuseCheck: string | null; detail: string }>('recovery.probeProcess', { turnId });
    expect(probe.result).toBe('unknown'); // 复用=不是原进程，退出事实不可据此判定
    expect(probe.reuseCheck).toBe('different');
    expect(probe.detail).toContain('复用');
    const r = await h.cmd<{ turnFinalStatus: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: '复用场景测试' });
    expect(r.turnFinalStatus).toBe('UNKNOWN');
    child.kill();
    h.db.close();
  }, 30_000);

  it('查询失败（注入）：processQuery=unknown → probe=unknown；executed → 保留保护（不以查询故障推断退出）', async () => {
    const h = makeHarness({ processQuery: (pid) => ({ state: 'unknown' as const, pid, error: '权限不足（测试注入）' }) });
    const { turnId, runId } = makeUnknownTurn(h.db);
    registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: 999999, startedAtMs: null, identitySource: 'pid-only' });
    const probe = await h.cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(probe.result).toBe('unknown');
    expect(probe.detail).toContain('权限不足');
    const r = await h.cmd<{ turnFinalStatus: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: '查询故障注入' });
    expect(r.turnFinalStatus).toBe('UNKNOWN');
    h.db.close();
  }, 30_000);

  it('错误 turn 证据与自报 alive=false：其他 turn 的 probe 引用拒绝；旧 exitEvidence 参数拒绝', async () => {
    const h = makeHarness();
    const a = makeUnknownTurn(h.db);
    const b = makeUnknownTurn(h.db);
    registerTurnProcess(h.db, { turnId: a.turnId, runId: a.runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const probeA = await h.cmd<{ probeId: string }>('recovery.probeProcess', { turnId: a.turnId });
    // b 的 executed 引用 a 的 probe → 拒绝（其他 turn 的证据不能冒充）。
    await expect(h.cmd('recovery.reconcile', { turnId: b.turnId, verdict: 'executed', note: '引用错 turn', probeId: probeA.probeId })).rejects.toThrow(/不属于目标 turn/);
    // 调用方自报 alive=false（旧参数）→ strictObject 参数层拒绝。
    const forged = await h.raw('recovery.reconcile', { turnId: b.turnId, verdict: 'executed', note: '伪造', exitEvidence: { kind: 'osProcessCheck', pid: 1, observedAt: Date.now(), alive: false } });
    expect(forged.ok).toBe(false);
    expect(forged.error?.message).toContain('exitEvidence');
    h.db.close();
  }, 30_000);

  it('notStarted 人工分离：无 manualRiskAck 拒绝；人工声明（风险确认）=退款+FAILED 但租约/准入保留', async () => {
    const h = makeHarness();
    const { turnId, runId, leaseDomain } = makeUnknownTurn(h.db);
    await expect(h.cmd('recovery.reconcile', { turnId, verdict: 'notStarted', note: '我认为没启动' })).rejects.toThrow(/manualRiskAck/);
    await expect(h.cmd('recovery.reconcile', { turnId, verdict: 'notStarted', manualRiskAck: true, note: '' })).rejects.toThrow();
    const r = await h.cmd<{ turnFinalStatus: string; releasedLeases: string[]; reason: string; protectionRetained: boolean }>('recovery.reconcile', { turnId, verdict: 'notStarted', manualRiskAck: true, note: '用户人工核对：该请求从未到达 runtime（任务管理器无相关进程）' });
    expect(r.turnFinalStatus).toBe('FAILED');
    expect(r.reason).toBe('manual-not-started-risk-ack');
    expect(r.protectionRetained).toBe(true);
    expect(r.releasedLeases).toEqual([]); // 存在未收口进程可能时不凭人工解除写入保护
    expect(h.db.prepare(`SELECT status FROM workspace_leases WHERE lock_domain = ?`).get(leaseDomain) as { status: string }).toMatchObject({ status: 'active' });
    expect(h.releasedTurns).toEqual([]); // 准入占位同样保留
    const budget = JSON.parse((h.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(budget.inFlightReservedTurns).toBe(0); // 退款
    expect((h.db.prepare('SELECT budget_mark FROM agent_turns WHERE id = ?').get(turnId) as { budget_mark: string }).budget_mark).toBe('refunded');
    // 事件如实记录人工声明语义（不伪装为程序已确认）。
    const evt = h.db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'recovery.reconciled' AND turn_id = ?`).get(turnId) as { payload_json: string };
    expect(JSON.parse(evt.payload_json).recordedAs).toBe('manual-claim');
    h.db.close();
  }, 30_000);

  it('none 模型（无子进程）：probe=no-os-process；executed → FAILED+释放（程序事实：无 OS 遗留进程可能）', async () => {
    const h = makeHarness();
    const { turnId, runId, leaseDomain } = makeUnknownTurn(h.db);
    registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const probe = await h.cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(probe.result).toBe('no-os-process');
    const r = await h.cmd<{ turnFinalStatus: string; releasedLeases: string[]; reason: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: '无子进程模型——程序事实释放' });
    expect(r.turnFinalStatus).toBe('FAILED');
    expect(r.releasedLeases).toEqual([leaseDomain]);
    expect(r.reason).toBe('executed-no-os-process');
    expect(h.releasedTurns).toEqual([turnId]);
    h.db.close();
  }, 30_000);

  it('probeId 引用正常路径 + keepUnknown：fresh 引用可用；keepUnknown 状态全不动', async () => {
    const h = makeHarness();
    const { turnId, runId } = makeUnknownTurn(h.db);
    registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const probe = await h.cmd<{ probeId: string }>('recovery.probeProcess', { turnId });
    const r = await h.cmd<{ turnFinalStatus: string; reason: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: '引用取证记录', probeId: probe.probeId });
    expect(r.turnFinalStatus).toBe('FAILED'); // no-os-process → 释放
    const k = makeUnknownTurn(h.db);
    const rk = await h.cmd<{ stateChanged: boolean }>('recovery.reconcile', { turnId: k.turnId, verdict: 'keepUnknown', note: '证据不足，保持观察' });
    expect(rk.stateChanged).toBe(false);
    expect((h.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(k.turnId) as { status: string }).status).toBe('UNKNOWN');
    h.db.close();
  }, 30_000);
});
