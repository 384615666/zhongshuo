/**
 * DEV-13 保护收口（第七轮·补）：人工声明 notStarted 后「预算已处置（refunded）、
 * 执行保护未解除（租约保留）」的独立推进（零模型调用——真实本地子进程+正式命令链）。
 *
 * 链路：UNKNOWN → 人工声明退款且保护保留 → 进程仍活时拒绝释放 → 服务端确认执行已结束
 * （exited/no-os-process）→ 正式命令解除（不改预算/不改写声明）→ 同 daemon 联动+排队可派发。
 * 反例：重复提交幂等、陈旧证据拒绝、事实矛盾纠正（correctToExecuted）、顺序错误、
 * 内存联动失败后 DB 事实保持（重开库续收口）。
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
import { registerTurnProcess, saveProcessTreeSnapshot } from '../../src/daemon/processRegistry.ts';
import { checkProcessLiveness, collectTreeRows, snapshotProcessTable } from '../../src/daemon/processCheck.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-prot-rel-'));
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

let seq = 0;
function makeUnknownTurn(db: ZhongshuoDatabase): { turnId: string; runId: string; threadId: string; leaseDomain: string } {
  seq += 1;
  const ids = { messageId: `rm${seq}`, threadId: `rth${seq}`, taskId: `rtk${seq}`, taskEventId: `re${seq}`, threadEventId: `rh${seq}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${seq}`, body: `B${seq}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: seq,
  });
  const runId = `run_${randomUUID()}`;
  const turnId = `turn_protrel_${seq}`;
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', ?, 'DIRECT', 0, 'INTERRUPTED', ?)`)
    .run(runId, ids.taskId, ids.threadId, JSON.stringify({ runMaxTurns: 6, usedTurns: 0, inFlightReservedTurns: 1 }));
  db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', ?, 'mA', 'direct.work', 'UNKNOWN', ?, 1, 1)`)
    .run(turnId, runId, ids.threadId, `task:${ids.taskId}:initial`);
  const leaseDomain = `d:/protrel/${seq}`;
  db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, ?, 1, 0, 'active')`).run(leaseDomain, turnId);
  return { turnId, runId, threadId: ids.threadId, leaseDomain };
}

function harness(options: { dbFile?: string; hookThrows?: boolean } = {}): {
  db: ZhongshuoDatabase; deps: DaemonCommandDeps; cmd: <T>(m: string, p: unknown) => Promise<T>; releasedTurns: string[]; hookFailures: number;
} {
  const db = openDatabase(options.dbFile ?? ':memory:');
  seed(db);
  const releasedTurns: string[] = [];
  let hookFailures = 0;
  const deps: DaemonCommandDeps = {
    db, localUserId: 'u_pr', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app'),
    releaseAdmission: (t: string) => {
      if (options.hookThrows === true) { hookFailures += 1; throw new Error('注入：内存联动失败'); }
      releasedTurns.push(t);
    },
  };
  return {
    db, deps,
    cmd: async <T,>(m: string, p: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
    releasedTurns,
    get hookFailures() { return hookFailures; },
  };
}

function aliveChild(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  c.on('error', () => { /* 测试进程管理 */ });
  return c;
}

describe('保护收口：人工声明后按服务端证据解除（正式命令链）', () => {
  it('完整链路：UNKNOWN→人工声明（退款·保护保留）→进程仍活拒绝释放→服务端确认退出→正式解除（预算/声明不动）', async () => {
    const h = harness();
    const { turnId, runId, leaseDomain } = makeUnknownTurn(h.db);
    const child = aliveChild();
    await new Promise((r) => setTimeout(r, 400));
    const liveness = checkProcessLiveness(child.pid!);
    expect(liveness.state).toBe('alive'); // 前置：真实子进程
    if (liveness.state === 'alive') {
      registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: child.pid!, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
      // 第八轮：worker 生产行为——startTurn 后首拍进程树快照（exited 判定须含历史代际核对）。
      const table = snapshotProcessTable();
      if (table.state === 'ok') saveProcessTreeSnapshot(h.db, turnId, child.pid!, collectTreeRows(table.rows, child.pid!));
    }
    // ① 人工声明未启动：退款+FAILED，租约/准入保留。
    const r1 = await h.cmd<{ reason: string; releasedLeases: string[] }>('recovery.reconcile', { turnId, verdict: 'notStarted', manualRiskAck: true, note: '用户人工核对：无相关进程' });
    expect(r1.reason).toBe('manual-not-started-risk-ack');
    expect(r1.releasedLeases).toEqual([]);
    // ② 进程仍活：releaseProtection 拒绝（保护保留）。
    await expect(h.cmd('recovery.releaseProtection', { turnId, note: '尝试解除' })).rejects.toThrow(/未确认执行已结束.*alive|alive.*保护保留/);
    expect(h.db.prepare(`SELECT status FROM workspace_leases WHERE lock_domain = ?`).get(leaseDomain) as { status: string }).toMatchObject({ status: 'active' });
    // ③ 顺序反例：另一未处置 UNKNOWN 直接解除 → 拒绝（先 reconcile）。
    const t2 = makeUnknownTurn(h.db);
    await expect(h.cmd('recovery.releaseProtection', { turnId: t2.turnId, note: '顺序错误' })).rejects.toThrow(/顺序错误/);
    // ④ 服务端确认退出（真实子进程结束）→ probeProcess → 引用 probeId 正式解除。
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
    const probe = await h.cmd<{ probeId: string; result: string }>('recovery.probeProcess', { turnId });
    expect(probe.result).toBe('exited');
    const budgetBefore = (h.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json;
    const r4 = await h.cmd<{ stateChanged: boolean; releasedLeases: string[]; probeResult: string }>('recovery.releaseProtection', { turnId, note: '服务端已确认退出，解除遗留保护', probeId: probe.probeId });
    expect(r4.stateChanged).toBe(true);
    expect(r4.releasedLeases).toEqual([leaseDomain]);
    expect(r4.probeResult).toBe('exited');
    expect(h.db.prepare(`SELECT status FROM workspace_leases WHERE lock_domain = ?`).get(leaseDomain) as { status: string }).toMatchObject({ status: 'released' });
    // 预算处置与原声明不被改写：budget_json 不动、budget_mark 仍 refunded、manual-claim 事件保留。
    expect((h.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json).toBe(budgetBefore);
    expect((h.db.prepare('SELECT budget_mark FROM agent_turns WHERE id = ?').get(turnId) as { budget_mark: string }).budget_mark).toBe('refunded');
    const evt = h.db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'recovery.reconciled' AND turn_id = ?`).get(turnId) as { payload_json: string };
    expect(JSON.parse(evt.payload_json).recordedAs).toBe('manual-claim'); // 原声明保留
    const relEvt = h.db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'recovery.protectionReleased' AND turn_id = ?`).get(turnId) as { payload_json: string };
    expect(JSON.parse(relEvt.payload_json).released).toBe(true);
    // 同 daemon 联动：解除后准入占位释放。
    expect(h.releasedTurns).toEqual([turnId]);
    // ⑤ 重复提交：无未释放租约 → 幂等 no-op。
    const r5 = await h.cmd<{ stateChanged: boolean }>('recovery.releaseProtection', { turnId, note: '重复提交' });
    expect(r5.stateChanged).toBe(false);
    h.db.close();
  }, 45_000);

  it('陈旧证据拒绝：probe 记录超过 10 分钟 → 引用被拒（重新取证后可用）', async () => {
    const h = harness();
    const { turnId, runId } = makeUnknownTurn(h.db);
    await h.cmd('recovery.reconcile', { turnId, verdict: 'notStarted', manualRiskAck: true, note: '声明' });
    registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const probe = await h.cmd<{ probeId: string }>('recovery.probeProcess', { turnId });
    // 篡改为 11 分钟前（构造陈旧证据）。
    h.db.prepare(`UPDATE recovery_exit_probes SET observed_at = ? WHERE id = ?`).run(Date.now() - 11 * 60 * 1000, probe.probeId);
    await expect(h.cmd('recovery.releaseProtection', { turnId, note: '陈旧引用', probeId: probe.probeId })).rejects.toThrow(/已过期/);
    // 自动取证（不引用）不受影响。
    const r = await h.cmd<{ stateChanged: boolean }>('recovery.releaseProtection', { turnId, note: '自动取证解除' });
    expect(r.stateChanged).toBe(true);
    h.db.close();
  }, 30_000);

  it('事实矛盾纠正：refunded→settled（U+1）+fact-conflict-correction 叠加事件；原声明不改写；纠正后仍可解除保护', async () => {
    const h = harness();
    const { turnId, runId, leaseDomain } = makeUnknownTurn(h.db);
    registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    await h.cmd('recovery.reconcile', { turnId, verdict: 'notStarted', manualRiskAck: true, note: '当时判断未启动' });
    const before = JSON.parse((h.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json) as { usedTurns: number; inFlightReservedTurns: number };
    // 后续证据（渠道账单）证明实际执行过 → 纠正。
    const c = await h.cmd<{ corrected: boolean; budgetMark: string }>('recovery.correctToExecuted', { turnId, note: '渠道账单显示该请求已计费——原人工声明与事实冲突', evidence: { source: '渠道账单（测试注入）', at: Date.now(), ref: 'bill#99' } });
    expect(c.corrected).toBe(true);
    expect(c.budgetMark).toBe('settled');
    const after = JSON.parse((h.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json) as typeof before;
    expect(after.usedTurns).toBe(before.usedTurns + 1); // 纠正重记 U+1
    expect(after.inFlightReservedTurns).toBe(before.inFlightReservedTurns); // 预留不重复占用
    // 原 manual-claim 声明事件保留 + 纠正事件叠加（不改写）。
    const events = h.db.prepare(`SELECT kind, payload_json FROM domain_events WHERE turn_id = ? ORDER BY seq`).all(turnId) as Array<{ kind: string; payload_json: string }>;
    expect(events.some((e) => e.kind === 'recovery.reconciled' && JSON.parse(e.payload_json).recordedAs === 'manual-claim')).toBe(true);
    const corr = events.find((e) => e.kind === 'recovery.factConflictCorrected');
    expect(corr).toBeDefined();
    expect(JSON.parse(corr!.payload_json).recordedAs).toBe('fact-conflict-correction');
    // 幂等/前置反例：settled 后再纠正拒绝；非 refunded turn 拒绝。
    await expect(h.cmd('recovery.correctToExecuted', { turnId, note: '重复纠正', evidence: { source: 'x', at: Date.now() } })).rejects.toThrow(/无冲突可纠正|仅适用/);
    // 纠正后保护处置独立：仍走 releaseProtection（服务端退出证据）。
    const rel = await h.cmd<{ releasedLeases: string[] }>('recovery.releaseProtection', { turnId, note: '纠正后按退出证据解除' });
    expect(rel.releasedLeases).toEqual([leaseDomain]);
    h.db.close();
  }, 30_000);

  it('内存联动失败恢复：releaseAdmission 钩子抛错 → DB 事实保持，重开库后仍可继续收口（不依赖内存占位）', async () => {
    const dbFile = join(tmpRoot, 'protrel-restart.sqlite');
    const h = harness({ dbFile, hookThrows: true });
    const { turnId, runId, leaseDomain } = makeUnknownTurn(h.db);
    registerTurnProcess(h.db, { turnId, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    await h.cmd('recovery.reconcile', { turnId, verdict: 'notStarted', manualRiskAck: true, note: '声明（联动将失败）' });
    const rel = await h.cmd<{ stateChanged: boolean; releasedLeases: string[] }>('recovery.releaseProtection', { turnId, note: '解除（钩子注入失败）' });
    expect(rel.stateChanged).toBe(true); // DB 事务成功——钩子失败不回滚持久事实
    expect(rel.releasedLeases).toEqual([leaseDomain]);
    expect(h.hookFailures).toBeGreaterThanOrEqual(1); // 钩子确实失败过
    h.db.close();
    // 「重启」：重开库（新连接=新内存账本），保护已收口（租约 released）、重复解除幂等 no-op。
    const db2 = openDatabase(dbFile);
    const deps2: DaemonCommandDeps = { db: db2, localUserId: 'u_pr', interruptTurn: async () => {}, releaseAdmission: () => {} };
    const cmd2 = async <T,>(m: string, p: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps2, { protocolVersion: 1, commandId: `c2-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    };
    expect(db2.prepare(`SELECT status FROM workspace_leases WHERE lock_domain = ?`).get(leaseDomain) as { status: string }).toMatchObject({ status: 'released' });
    const again = await cmd2<{ stateChanged: boolean }>('recovery.releaseProtection', { turnId, note: '重启后重复解除' });
    expect(again.stateChanged).toBe(false); // 幂等
    // 重启后新 UNKNOWN 保护同样可经正式命令收口（不依赖内存）。
    const h2rows = makeUnknownTurn(db2);
    registerTurnProcess(db2, { turnId: h2rows.turnId, runId: h2rows.runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    await cmd2('recovery.reconcile', { turnId: h2rows.turnId, verdict: 'notStarted', manualRiskAck: true, note: '重启后新声明' });
    const rel2 = await cmd2<{ stateChanged: boolean; releasedLeases: string[] }>('recovery.releaseProtection', { turnId: h2rows.turnId, note: '重启后解除' });
    expect(rel2.stateChanged).toBe(true);
    expect(rel2.releasedLeases).toEqual([h2rows.leaseDomain]);
    db2.close();
  }, 30_000);
});
