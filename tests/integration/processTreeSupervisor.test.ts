/**
 * DEV-13 supervisor 衔接：进程树证据（第八轮，零模型调用——真实本地 node 进程树）。
 *
 * 核心语义：**父进程退出不证明其工具/派生子进程已结束**；仅靠退出时刻递归扫描现存
 * 父子关系也不够——**中间代际退出后其历史父子边随进程消失**（孙进程的 PPID 指向
 * 已死 PID，从登记根不可连通）。覆盖（全部经 recovery.probeProcess / reconcile /
 * releaseProtection 正式命令链）：
 * - 三代现场（父→子→孙，父子先退、孙继续运行）：活跃期快照的历史归属核对发现孙进程
 *   → unknown（保护保留，releaseProtection 拒绝）；孙结束后才 exited / 允许解除；
 * - 快照之后继续派生（子进程在快照后再 spawn 新孙，随后父子均退）→ 历史归属核对发现；
 * - detached 工具进程遗留（脱离父 Job 的孤儿）；
 * - shared（共享 server）与 per-turn（CLI）各自的归属模型；
 * - PID 复用（时序排除复用家庭）/历史启动时间缺失（保守计入）/枚举失败/输出损坏；
 * - 无活跃期快照 → 未完整确认（中间代际遗留不可排除）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';
import { registerTurnProcess, recordProcessTreeObservation, getTurnProcessRegistration, getProcessTreeIdentities } from '../../src/daemon/processRegistry.ts';
import { analyzeProcessTree, checkProcessLiveness, collectTreeRows, snapshotProcessTable, listLiveChildProcesses } from '../../src/daemon/processCheck.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-tree8-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

// 三代 fixture 脚本：父 spawn 子（detached 脱离父 Job），父 ~1.5s 后退出；子 ~1.5s 后退出；
// 孙长活并把 PID 写文件（测试可精确收尾）。时序保证：快照时刻（父启动 ~0.9s）三代均在表。
const GEN3_PARENT = `const{spawn}=require("child_process");
const c=spawn(process.execPath,[${JSON.stringify(join(tmpRoot, 'gen3-child.js'))}],{stdio:"ignore",detached:true});c.unref();
setTimeout(()=>{},1500);`;
const GEN3_CHILD = `const{spawn}=require("child_process");const fs=require("fs");
const later=spawn(process.execPath,[${JSON.stringify(join(tmpRoot, 'gen3-grandson.js'))}],{stdio:"ignore",detached:true});later.unref();
setTimeout(()=>{},1500);`;
const GEN3_GRANDSON = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(join(tmpRoot, 'grandson.pid'))},String(process.pid));
setInterval(()=>{},1000);`;
writeFileSync(join(tmpRoot, 'gen3-parent.js'), GEN3_PARENT);
writeFileSync(join(tmpRoot, 'gen3-child.js'), GEN3_CHILD);
writeFileSync(join(tmpRoot, 'gen3-grandson.js'), GEN3_GRANDSON);

// 盲区现场脚本：父启动即 spawn 子（detached）后 200ms 退出；子立即 spawn 孙（detached
// 长活）后 150ms 退出——父/子/孙全部在观察②之前完成派生与中间代际退出（孙=盲区进程）。
writeFileSync(join(tmpRoot, 'blind-parent.js'), `const{spawn}=require("child_process");
const c=spawn(process.execPath,[${JSON.stringify(join(tmpRoot, 'blind-child.js'))}],{stdio:"ignore",detached:true});c.unref();
setTimeout(()=>{},200);`);
writeFileSync(join(tmpRoot, 'blind-child.js'), `const{spawn}=require("child_process");
const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});g.unref();
setTimeout(()=>{},150);`);

// 快照后派生现场：父直接派生两个孙——孙A 立即、孙B 延迟 1.6s（快照在两者之间拍）。
writeFileSync(join(tmpRoot, 'late-parent.js'), [
  'const { spawn } = require("child_process");',
  `const INNER = 'const fs=require("fs");fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);';`,
  `const mk = (f) => { const c = spawn(process.execPath, ["-e", INNER, f], { stdio: "ignore", detached: true }); c.unref(); };`,
  `mk(${JSON.stringify(join(tmpRoot, 'late-gc-a.pid'))});`,
  `setTimeout(() => mk(${JSON.stringify(join(tmpRoot, 'late-gc-b.pid'))}), 1600);`,
  'setInterval(() => {}, 4000);',
].join('\n'));

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

let seq = 0;
function makeTurn(db: ZhongshuoDatabase): { turnId: string; runId: string; leaseDomain: string } {
  seq += 1;
  const ids = { messageId: `tm${seq}`, threadId: `tth${seq}`, taskId: `ttk${seq}`, taskEventId: `te${seq}`, threadEventId: `th${seq}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${seq}`, body: `B${seq}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: seq,
  });
  const runId = `run_${randomUUID()}`;
  const turnId = `turn_tree8_${seq}`;
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', ?, 'DIRECT', 0, 'INTERRUPTED', ?)`)
    .run(runId, ids.taskId, ids.threadId, JSON.stringify({ runMaxTurns: 6, usedTurns: 0, inFlightReservedTurns: 1 }));
  db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', ?, 'mA', 'direct.work', 'UNKNOWN', ?, 1, 1)`)
    .run(turnId, runId, ids.threadId, `task:${ids.taskId}:initial`);
  const leaseDomain = `d:/tree8/${seq}`;
  db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, ?, 1, 0, 'active')`).run(leaseDomain, turnId);
  return { turnId, runId, leaseDomain };
}

function depsOf(db: ZhongshuoDatabase, overrides: Partial<DaemonCommandDeps> = {}): { deps: DaemonCommandDeps; cmd: <T>(m: string, p: unknown) => Promise<T> } {
  const deps: DaemonCommandDeps = { db, localUserId: 'u_tree', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app'), ...overrides };
  return {
    deps,
    cmd: async <T,>(m: string, p: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
  };
}

/** 模拟 worker 生产行为：活跃期进程树观察（生产函数链：全表快照→收集→追加式身份登记）。 */
function takeSnapshot(db: ZhongshuoDatabase, turnId: string, rootPid: number): void {
  const table = snapshotProcessTable();
  if (table.state !== 'ok') throw new Error(`观察失败（测试前置）：${table.error}`);
  recordProcessTreeObservation(db, turnId, rootPid, collectTreeRows(table.rows, rootPid));
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('supervisor 进程树证据（第八轮：全树归属分析 + 活跃期快照登记）', () => {
  it('三代现场：父子先退、孙继续运行 → probe/reconcile/releaseProtection 全部拒绝；孙结束后也仅「未观察到存活后代」（周期快照≠完整退出，解除路径关闭）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    const { cmd } = depsOf(db);
    // 父进程启动（父→子→孙三代链；父 200ms 后退出、子 ~600ms 后退出、孙长活）。
    const parent = spawn(process.execPath, [join(tmpRoot, 'gen3-parent.js')], { stdio: 'ignore' });
    const parentPid = parent.pid!;
    await wait(900); // 等父登记窗口 + 子/孙已派生（孙此时在跑）
    const liveness = checkProcessLiveness(parentPid);
    expect(liveness.state).toBe('alive'); // 前置：登记时父仍活（模拟 startTurn 成功后登记）
    if (liveness.state !== 'alive') throw new Error('前置失败');
    registerTurnProcess(db, {
      turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn',
      pid: parentPid, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime',
    });
    takeSnapshot(db, turnId, parentPid); // worker 生产行为：startTurn 后首拍（此时父+子+孙均在表）
    await wait(1_500); // 父（200ms）与子（~800ms）已退出，孙（detached 孤儿）继续运行
    expect(checkProcessLiveness(parentPid).state).toBe('exited'); // 前置：登记根确已退出
    // 父退出不构成执行结束证据：现存树从死根只能抓到已退出的子——孙靠快照历史归属核对发现。
    const p1 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p1.result).toBe('unknown');
    expect(p1.detail).toContain('历史身份核对');
    // 对账 executed：退出未知 → 结算但保护保留。
    const rec = await cmd<{ turnFinalStatus: string; protectionRetained: boolean }>('recovery.reconcile', {
      turnId, verdict: 'executed', note: '三代现场：孙进程仍在运行',
    });
    expect(rec.turnFinalStatus).toBe('UNKNOWN');
    expect(rec.protectionRetained).toBe(true);
    // 解除保护：拒绝（执行载体未全部结束）。
    await expect(cmd('recovery.releaseProtection', { turnId, note: '孙仍在运行，应拒绝' }))
      .rejects.toThrow('保护保留');
    // 孙结束 → **仍不释放**（第九轮：周期快照不构成完整退出证明——「未观察到存活后代」
    // ≠「已确认全部受管执行结束」；probe 报告观察事实但保持 unknown，解除路径关闭）。
    const grandsonPid = Number(readFileSync(join(tmpRoot, 'grandson.pid'), 'utf8'));
    try { process.kill(grandsonPid); } catch { /* 已退出 */ }
    await wait(1_200);
    const p2 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p2.result).toBe('unknown');
    expect(p2.detail).toContain('未观察到存活后代');
    expect(p2.detail).toContain('未完整确认');
    // 历史身份全集已确认退出（含孙——追加式登记不丢身份）。
    const identities = getProcessTreeIdentities(db, turnId);
    expect(identities.length).toBeGreaterThanOrEqual(3); // 父+子+孙
    expect(identities.every((row) => row.exit_confirmed_at != null)).toBe(true);
    await expect(cmd('recovery.releaseProtection', { turnId, note: '全部结束后尝试解除' }))
      .rejects.toThrow('保护保留');
    db.close();
  }, 90_000);

  it('历史身份不被后续快照覆盖（第一拍父→子→孙；父子退出后再观察只见占位；probe 仍发现孙——旧 DELETE+INSERT 会丢）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    const { cmd } = depsOf(db);
    const parent = spawn(process.execPath, [join(tmpRoot, 'gen3-parent.js')], { stdio: 'ignore' });
    const parentPid = parent.pid!;
    await wait(900);
    const liveness = checkProcessLiveness(parentPid);
    if (liveness.state !== 'alive') throw new Error('前置失败');
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: parentPid, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
    takeSnapshot(db, turnId, parentPid); // 第一拍：三代全在（父+子+孙均登记身份）
    await wait(1_600); // 父（1.5s）与子（~1.55s）退出，孙继续运行
    // 后续周期观察（worker 生产行为）：根已退出 → BFS 只见占位行（孙在现存图不可达）。
    takeSnapshot(db, turnId, parentPid);
    const grandsonPid = Number(readFileSync(join(tmpRoot, 'grandson.pid'), 'utf8'));
    // 追加式登记：孙身份保留自第一拍（不因后续观察缺席而丢失）。
    const ids = getProcessTreeIdentities(db, turnId);
    expect(ids.some((row) => row.pid === grandsonPid)).toBe(true);
    const p = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p.result).toBe('unknown'); // 孙仍活——历史身份核对发现（保护保留）
    expect(p.detail).toContain('仍在运行');
    try { process.kill(grandsonPid); } catch { /* 已退出 */ }
    db.close();
  }, 90_000);

  it('盲区如实（两次观察之间完成派生与中间父退出）：系统返回未完整确认，不凭空声称能发现', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    const { cmd } = depsOf(db);
    // 现场：父存活期间观察①（只见父）；随后父 spawn 子、子 spawn 孙（观察②之前）且
    // 父与子都在观察②之前退出——孙从未被任何观察登记（盲区进程）。
    const parent = spawn(process.execPath, [join(tmpRoot, 'blind-parent.js')], { stdio: 'ignore' });
    const parentPid = parent.pid!;
    await wait(100); // 观察①窗口：父活着、子尚未派生（子 spawn 前拍）
    const liveness = checkProcessLiveness(parentPid);
    if (liveness.state !== 'alive') throw new Error('前置失败');
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: parentPid, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
    takeSnapshot(db, turnId, parentPid); // 观察①：只见父
    await wait(1_500); // 父（200ms 后退）与子（父退前 spawn，150ms 后退）均已退出；孙（盲区）继续运行
    takeSnapshot(db, turnId, parentPid); // 观察②：根死 → 占位（孙不可见）
    const p = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    // 盲区进程不可发现——系统**不得**凭空声称能发现，也不得把「未观察到」冒充完整退出：
    // 返回未完整确认（周期快照机制边界如实说明），保护保留。
    expect(p.result).toBe('unknown');
    expect(p.detail).toContain('未完整确认');
    expect(p.detail).toContain('周期快照机制');
    const recBlind = await cmd<{ turnFinalStatus: string; protectionRetained: boolean }>('recovery.reconcile', { turnId, verdict: 'executed', note: '盲区场景：观察完成但无法排除遗漏' });
    expect(recBlind.protectionRetained).toBe(true);
    await expect(cmd('recovery.releaseProtection', { turnId, note: '盲区场景尝试解除' }))
      .rejects.toThrow('保护保留');
    // 清理盲区孙：从观察①文件之外不可知——按 detached 孤儿扫尾（进程树枚举）。
    const scan = listLiveChildProcesses(parentPid);
    if (scan.state === 'live') for (const c of scan.children) { try { process.kill(c.pid); } catch { /* 已退出 */ } }
    db.close();
  }, 90_000);

  it('快照之后继续派生：子进程在快照后再 spawn 新孙、随后父子均退 → 历史归属核对仍发现新孙', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    const { cmd } = depsOf(db);
    // 变体现场：父长活；孙A 立即派生、孙B 延迟 1.6s——快照在孙B 派生前拍。
    const parent = spawn(process.execPath, [join(tmpRoot, 'late-parent.js')], { stdio: 'ignore' });
    const parentPid = parent.pid!;
    await wait(700); // 孙A 已派生、孙B 尚未（1.6s）
    const liveness = checkProcessLiveness(parentPid);
    if (liveness.state !== 'alive') throw new Error('前置失败：父应存活');
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: parentPid, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
    takeSnapshot(db, turnId, parentPid); // 快照含 父+子?（父的子=两个 -e node 孙A/孙B 由父直接 spawn——简化为父直接两孙）
    await wait(1_800); // 孙B 已派生（快照之后）
    parent.kill();
    await wait(800); // 父退出；孙A/孙B（detached 孤儿）继续运行
    // 孙A 在快照内（历史身份直接核对）；孙B 在快照后派生、挂在（已死的）父 PID 上——
    // 现存树 BFS 从死根抓 PPID=父 的存活孤儿 → 发现。两条路径都必须不漏。
    const p = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p.result).toBe('unknown');
    for (const f of ['late-gc-a.pid', 'late-gc-b.pid']) {
      try { process.kill(Number(readFileSync(join(tmpRoot, f), 'utf8'))); } catch { /* 已退出 */ }
    }
    db.close();
  }, 60_000);

  it('shared（共享 server）：server 死+工具进程遗留→unknown（含快照核对）；server 存活→unknown（turn 执行状态未知）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    const { cmd } = depsOf(db);
    // 共享 server 自身存活并 spawn 工具子（detached——server 崩溃后工具进程遗留）。
    const server = spawn(process.execPath, ['-e', 'const{spawn}=require("child_process");const t=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});t.unref();setInterval(()=>{},1000);'], { stdio: 'ignore' });
    await wait(800);
    const liveness = checkProcessLiveness(server.pid!);
    if (liveness.state !== 'alive') throw new Error('前置失败');
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'codex', processModel: 'shared', pid: server.pid!, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
    takeSnapshot(db, turnId, server.pid!);
    const p1 = await cmd<{ result: string }>('recovery.probeProcess', { turnId });
    expect(p1.result).toBe('alive'); // server 存活：不因常驻进程活着判定该 turn 执行结束
    server.kill();
    await wait(900);
    const p2 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p2.result).toBe('unknown'); // server 死但工具子遗留（detached 孤儿）
    expect(p2.detail).toContain('仍在运行');
    const scan = listLiveChildProcesses(server.pid!);
    if (scan.state === 'live') for (const c of scan.children) { try { process.kill(c.pid); } catch { /* 已退出 */ } }
    await wait(900);
    const p3 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p3.result).toBe('unknown'); // 第九轮：未观察到存活后代≠完整退出（解除路径关闭）
    expect(p3.detail).toContain('未完整确认');
    db.close();
  }, 60_000);

  it('无活跃期快照：登记 PID 已退出且现存树无存活后代 → 仍 unknown（中间代际遗留不可排除，未完整确认）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: 424242, startedAtMs: null, identitySource: 'pid-only' });
    const { cmd } = depsOf(db, {
      processQuery: (pid) => ({ state: 'exited' as const, pid }), // 根 PID 确认退出（注入）
    });
    const p = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p.result).toBe('unknown');
    expect(p.detail).toContain('0 个历史身份'); // 无任何活跃期观察记录（如实）
    expect(p.detail).toContain('未完整确认');
    db.close();
  }, 30_000);

  it('树枚举失败/平台不支持（注入）→ exited 降级 unknown（未完整确认，不猜测）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: 424242, startedAtMs: null, identitySource: 'pid-only' });
    const { cmd } = depsOf(db, {
      processQuery: (pid) => ({ state: 'exited' as const, pid }),
      processTree: () => ({ state: 'failed', error: '注入：CIM 查询失败' }),
    });
    const p = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p.result).toBe('unknown');
    expect(p.detail).toContain('未完整确认');
    db.close();
  }, 30_000);

  it('查询协议：E: 错误行/空输出/残缺行 → failed（不把查询失败当空结果）；查询成功 0 匹配=checked（严格区分）', () => {
    // CIM 错误可靠传回（非终止错误不静默成空输出）。
    expect(snapshotProcessTable(() => 'E:Access denied')).toEqual({ state: 'failed', error: expect.stringContaining('Access denied') });
    // 空输出=输出损坏（win32 全表必有系统进程），不是「无进程」。
    expect(snapshotProcessTable(() => '')).toEqual({ state: 'failed', error: expect.stringContaining('空输出') });
    // 残缺行不静默忽略——结果不完整即 failed。
    expect(snapshotProcessTable(() => 'T:1:2:300\nnot-a-protocol-line\nT:4:1:500')).toEqual({ state: 'failed', error: expect.stringContaining('无法解析') });
    // 合法全表：成功。
    const ok = snapshotProcessTable(() => 'T:1:2:300\nT:4:1:500');
    expect(ok).toEqual({ state: 'ok', rows: [{ pid: 1, ppid: 2, startedAt: 300 }, { pid: 4, ppid: 1, startedAt: 500 }] });
  }, 30_000);

  it('归属核对的创建时间规则（纯注入）：排除复用家庭、保留真后代、历史时间缺失保守计入', () => {
    const q = (text: string) => (): string => text;
    // 中间代际（pid 100，快照登记 startedAt=1000）已死，孙（200）挂其上 → 历史归属发现。
    expect(analyzeProcessTree(1, [{ pid: 100, startedAt: 1000 }], q('T:1:2:0\nT:200:100:1500')))
      .toMatchObject({ state: 'live', via: 'historical-attachment' });
    // pid 100 被复用（现启动 5000）：其新孩子 300（启动 6000 ≥ 复用者）→ 排除；真孙 200（1500 < 复用者）→ 保留。
    const reuse = analyzeProcessTree(1, [{ pid: 100, startedAt: 1000 }], q('T:1:2:0\nT:100:2:5000\nT:300:100:6000'));
    expect(reuse).toMatchObject({ state: 'checked' }); // 复用家庭的孩子被时序规则排除
    const reuseKeepsOurs = analyzeProcessTree(1, [{ pid: 100, startedAt: 1000 }], q('T:1:2:0\nT:100:2:5000\nT:200:100:1500'));
    expect(reuseKeepsOurs).toMatchObject({ state: 'live' }); // 早于复用者启动的后代仍算我们的
    // 历史启动时间缺失（pid-only 登记）：无法排除复用家庭 → 保守计入（保护保留）。
    expect(analyzeProcessTree(1, [{ pid: 100, startedAt: null }], q('T:1:2:0\nT:100:2:5000\nT:300:100:6000')))
      .toMatchObject({ state: 'live' });
    // 早于我们进程启动的 PID 边残留（非我们后代）→ 排除。
    expect(analyzeProcessTree(1, [{ pid: 100, startedAt: 9000 }], q('T:1:2:0\nT:200:100:1500')))
      .toMatchObject({ state: 'checked' });
  }, 30_000);

  it('崩溃窗口：pre-launch（pid=null）→ unknown 且 detail 区分「启动窗口」；从未登记→identity-missing', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const t1 = makeTurn(db);
    const t2 = makeTurn(db);
    const { cmd } = depsOf(db);
    registerTurnProcess(db, { turnId: t1.turnId, runId: t1.runId, memberId: 'mA', adapterKind: 'claude', processModel: 'unknown', pid: null, startedAtMs: null, identitySource: 'pre-launch' });
    const p1 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId: t1.turnId });
    expect(p1.result).toBe('unknown');
    expect(p1.detail).toContain('启动窗口身份未持久化');
    const p2 = await cmd<{ result: string }>('recovery.probeProcess', { turnId: t2.turnId });
    expect(p2.result).toBe('identity-missing');
    db.close();
  }, 30_000);

  it('worker 生产接线：startTurn 成功后首拍快照+消费期间周期重拍（真实 node 子进程身份上报）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const ids = { messageId: 'wm1', threadId: 'wth1', taskId: 'wtk1', taskEventId: 'we1', threadEventId: 'wh1' };
    createRoomRootTask(db, {
      ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
      title: 'WT', body: 'WB', mentions: [{ kind: 'member', memberId: 'mA' }],
      author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
      now: 1,
    });
    // 真实 node 子进程当「CLI 进程」：fake 上报 per-turn 身份（processIdentityOverride）。
    const fakeCli = spawn(process.execPath, ['-e', 'const{spawn}=require("child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});setInterval(()=>{},1000);'], { stdio: 'ignore' });
    await wait(600); // 工具子已派生
    const adapter = new FakeRuntimeAdapter({
      processIdentityOverride: () => ({ model: 'per-turn', pid: fakeCli.pid! }),
      turnScripts: [[{ kind: 'stall', ms: 7_000 }]], // 消费窗口拉开（周期快照可跑）
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-tree8', appDataDir: join(tmpRoot, 'app'), turnDeadlineMs: 400, interruptGraceMs: 400 });
    await worker.runOnce();
    const turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${ids.taskId}:initial`) as { id: string }).id;
    // UNKNOWN 截止收尾后：登记身份与快照均已落库（崩溃取证的事实锚点在生产路径自动产生）。
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string }).status).toBe('UNKNOWN');
    const reg = getTurnProcessRegistration(db, turnId);
    expect(reg?.pid).toBe(fakeCli.pid!);
    const treeIds = getProcessTreeIdentities(db, turnId);
    expect(treeIds.some((r) => r.pid === fakeCli.pid)).toBe(true); // 根身份已登记（追加式）
    const { cmd } = depsOf(db);
    // ① CLI 进程仍活（UNKNOWN 后运行载体还在）：alive——保护保留。
    const probe1 = await cmd<{ result: string }>('recovery.probeProcess', { turnId });
    expect(probe1.result).toBe('alive');
    // ② CLI 被杀、工具子（detached 孤儿）遗留：unknown——父退出不证明执行结束。
    fakeCli.kill();
    await wait(800);
    const probe = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(probe.result).toBe('unknown');
    expect(probe.detail).toContain('仍在运行');
    // ③ 全部结束后：exited（生产快照参与全树核对）。
    const scan = listLiveChildProcesses(fakeCli.pid!);
    if (scan.state === 'live') for (const c of scan.children) { try { process.kill(c.pid); } catch { /* 已退出 */ } }
    await wait(1_000);
    const probe2 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(probe2.result).toBe('unknown'); // 第九轮：扫描为空≠完整退出（保护保留，路径关闭）
    expect(probe2.detail).toContain('未完整确认');
    db.close();
  }, 60_000);
});
