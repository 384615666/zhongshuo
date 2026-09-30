/**
 * 第十四轮二：受管身份正式绑定与资源回收归属（正式生产链反例，零模型调用）。
 *
 * 覆盖用户令第十四轮二：
 * - worker 全链（adapter→受管桥→登记→终态 settle→收尾）：真实 node fixture CLI 经
 *   ClaudeCliAdapter+spawnFn=受管桥 → DispatchWorker 派发 → 登记 managed_job_id（稳定身份
 *   正式列）→ turn SUCCEEDED → settle 收尾（closeProcessRegistrationIfTerminal→retireManagedJob）
 *   → job 注册表/轮询定时器归零；后续同成员任务继续派发（准入释放）；
 * - PID 复用/代次反例：pid 查找可命中的**他人 job**不能冒充本 turn 证据——按 jobId 查不到
 *   （旧 job 已收尾）→ 拒绝；jobId 命中但登记 PID 不一致（复用/错位）→ 拒绝；
 * - 登记不完整（managed-job 无 managed_job_id）→ 拒绝自动解除；
 * - probe 身份核对：无句柄/错位 PID/存活观察（不冒充退出）；
 * - shared 两任务：单 turn 证据消费不关共享 job（另一任务仍开放）；stop 全量收尾；
 * - 断言=数据库行/准入钩子/job 注册表计数/轮询定时器计数（非只 releaseEvidence true）。
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnManagedBridge, managedJobByPid, managedJobsCount, managedActivePollers, disposeAllManagedJobs } from '../../src/daemon/managed/bridge.ts';
import { registerTurnProcess } from '../../src/daemon/processRegistry.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import type { DaemonCommandDeps } from '../../src/daemon/commands.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { ClaudeCliAdapter } from '../../src/adapter/claude/cliAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { MemberRuntimeRegistry } from '../../src/daemon/memberRuntime.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-mgident-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});
process.env.ZS_ALLOW_FAKE = '1'; // 默认 adapter 为 fake（显式开发模式；成员绑定走 claude）

const NODE = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 长驻 worker（shared/存活观察用）与一次性退出进程。 */
beforeAll(() => {
  writeFileSync(join(tmpRoot, 'worker.js'), 'console.log("up");setInterval(()=>{},1000);', 'utf8');
  // Claude CLI 回放 fixture：读全部 stdin 至 EOF → 按输入合同匹配 resultKey → 输出
  // stream-json 两行（assistant+result）→ 退出 0。经受管桥（真实进程、真实管道）。
  writeFileSync(join(tmpRoot, 'fixture-cli.js'), `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8');
  const m = /"resultKey":"(result_[0-9a-zA-Z_-]+)"/.exec(input);
  const resultKey = m != null ? m[1] : 'result_missing';
  const text = JSON.stringify({
    schemaVersion: 'task-complete-v1', resultKey, changeSummary: '受管链回放',
    files: [], executedVerifications: ['stdin 合同解析'], unexecutedVerifications: [], remainingIssues: [],
  });
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '受管回放输出', id: 'cm1' }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cs_mg', result: text, model: 'deepseek-flash', usage: { input_tokens: 5, output_tokens: 2 } }) + '\\n');
  process.exit(0);
});
`, 'utf8');
});

/** 命令级测试的 DB 脚手架（项目/成员/房间/会话）。 */
function seedDb(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
}

function makeDeps(db: ZhongshuoDatabase, admissionSpy?: string[]): DaemonCommandDeps {
  return {
    db, localUserId: 'u_mgident', interruptTurn: async () => {},
    appDataDir: join(tmpRoot, 'app'),
    releaseAdmission: admissionSpy != null ? (turnId: string) => { admissionSpy.push(turnId); } : undefined,
  };
}

async function cmd<T,>(deps: DaemonCommandDeps, method: string, params: unknown): Promise<T> {
  const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}
async function cmdErr(deps: DaemonCommandDeps, method: string, params: unknown): Promise<string> {
  const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; error?: { message: string } };
  if (r.ok) throw new Error('预期拒绝，实际成功');
  return r.error?.message ?? '';
}

/** UNKNOWN+active 租约的 turn 脚手架。 */
function seedUnknownTurn(db: ZhongshuoDatabase, lockDomain: string): { turnId: string; runId: string } {
  const turnId = `turn_mgi_${randomUUID().slice(0, 8)}`;
  const runId = `run_mgi_${randomUUID().slice(0, 8)}`;
  const taskId = `tk_mgi_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES (?, 'p1', 'c1', 'room_task', 'r1', '受管身份', 'ACTIVE')`).run(taskId);
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', 'DIRECT', 0, 'RUNNING', ?)`).run(runId, taskId, JSON.stringify({ runMaxTurns: 3, usedTurns: 0, inFlightReservedTurns: 1 }));
  db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch, budget_mark) VALUES (?, ?, 'c1', 'mA', 'direct.work', 'UNKNOWN', ?, 1, 1, NULL)`).run(turnId, runId, `task:${turnId}:initial`);
  db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, ?, 1, ?, 'active')`).run(lockDomain, turnId, Date.now());
  return { turnId, runId };
}
function disposeTurnForRelease(db: ZhongshuoDatabase, turnId: string): void {
  db.prepare(`UPDATE agent_turns SET status='FAILED', budget_mark='refunded' WHERE id=?`).run(turnId);
}

describe('第十四轮二：worker 全链（受管桥×Claude 回放×登记×settle 收尾）', () => {
  it('真实进程经 spawnFn=受管桥：登记 managed_job_id→SUCCEEDED→settle 收尾→注册表/定时器归零→准入释放（后续任务继续）', async () => {
    const jobs0 = managedJobsCount();
    const pollers0 = managedActivePollers();
    const db = openDatabase(':memory:');
    seedDb(db);
    const deps = makeDeps(db);
    const setR = await cmd<{ ok: boolean }>(deps, 'member.setRuntime', { memberId: 'mA', kind: 'claude', model: 'deepseek-flash', permissionMode: 'plan' });
    void setR;
    const defaultAdapter = new FakeRuntimeAdapter();
    const registry = new MemberRuntimeRegistry(db, defaultAdapter, {
      // spawnFn=受管桥（真实 node 进程+真实管道+Job Object 纳管）。
      claude: (binding) => new ClaudeCliAdapter({ model: binding.model ?? 'deepseek-flash', permissionMode: 'plan' }, (args, cwd) =>
        spawnManagedBridge(NODE, [join(tmpRoot, 'fixture-cli.js'), ...args], { cwd }) as never),
      fake: () => new FakeRuntimeAdapter(),
    });
    const mk = (n: number): string => {
      const ids = { messageId: `msg${n}`, threadId: `th${n}`, taskId: `tk${n}`, taskEventId: `et${n}`, threadEventId: `eh${n}` };
      createRoomRootTask(db, {
        ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
        title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId: 'mA' }],
        author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
        route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
        now: n,
      });
      return ids.taskId;
    };
    mk(1); mk(2); // 两任务同成员：第二任务派发成功=准入在首任务终态后已释放
    const worker = new DispatchWorker({ db, adapter: defaultAdapter, leaseOwner: 'w-mg', adapterFor: (m) => registry.adapterFor(m), appDataDir: join(tmpRoot, 'wapp') });
    for (let i = 0; i < 12 && (await worker.runOnce()); i += 1);

    const tasks = db.prepare('SELECT id, status FROM tasks ORDER BY id').all() as Array<{ id: string; status: string }>;
    expect(tasks.find((t) => t.id === 'tk1')!.status).toBe('DONE');
    expect(tasks.find((t) => t.id === 'tk2')!.status).toBe('DONE'); // 准入释放→排队任务继续（非 UNKNOWN 卡死）
    const turns = db.prepare(`SELECT id, status FROM agent_turns WHERE member_id='mA' ORDER BY id`).all() as Array<{ id: string; status: string }>;
    expect(turns.length).toBe(2);
    expect(turns.every((t) => t.status === 'SUCCEEDED')).toBe(true);
    // 登记正式列：managed-job + managed_job_id 稳定身份；终态后 closed_at 已写。
    const regs = db.prepare(`SELECT identity_source, managed_job_id, closed_at FROM runtime_process_registry ORDER BY id`).all() as Array<{ identity_source: string; managed_job_id: string | null; closed_at: number | null }>;
    expect(regs.length).toBe(2);
    for (const r of regs) {
      expect(r.identity_source).toBe('managed-job');
      expect(r.managed_job_id).toMatch(/^job-/);
      expect(r.closed_at).not.toBeNull();
    }
    // settle 收尾归属：per-turn 终态 → retireManagedJob → job 注册表与轮询定时器全部归零。
    expect(managedJobsCount()).toBe(jobs0);
    expect(managedActivePollers()).toBe(pollers0);
    await defaultAdapter.closeAllSessions();
    await registry.disposeAll();
    db.close();
  }, 120_000);
});

describe('第十四轮二：身份核对反例（releaseProtection/probe——命令级正式链）', () => {
  it('PID 复用/代次反例：pid 查找命中的他人 job 不冒充——jobId 查不到旧 job=拒绝；jobId 命中但 PID 不一致=拒绝；登记缺 managed_job_id=拒绝', async () => {
    const db = openDatabase(':memory:');
    seedDb(db);
    const deps = makeDeps(db);
    const liveJob = spawnManagedBridge(NODE, [join(tmpRoot, 'worker.js')], { cwd: tmpRoot });
    await sleep(600); // 存活
    // 旧 turn：其 job 已收尾（dispose——模拟上轮收尾/重启后）。
    const oldChild = spawnManagedBridge(NODE, ['-e', 'process.exit(0)'], { cwd: tmpRoot });
    await sleep(400);
    oldChild.managed.dispose(); // job 句柄消失（证据不再可查——重启/已收尾语义）
    // ① PID 复用反例：登记 pid 指向**仍存活的他人 job**（pidIndex 可命中），jobId 指向已收尾
    //    的旧 job——按 pid 的旧口径会拿 liveJob 的证据冒充（managedJobByPid 可查到），
    //    正式链必须按 jobId 拒绝。
    const t1 = seedUnknownTurn(db, `${tmpRoot}\\a1`.toLowerCase());
    registerTurnProcess(db, { turnId: t1.turnId, runId: t1.runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: liveJob.pid, startedAtMs: null, identitySource: 'managed-job', managedJobId: oldChild.managedJobId });
    disposeTurnForRelease(db, t1.turnId);
    expect(managedJobByPid(liveJob.pid)?.jobId).toBe(liveJob.managedJobId); // 旧口径确实会命中他人 job
    const e1 = await cmdErr(deps, 'recovery.releaseProtection', { turnId: t1.turnId, note: '复用反例' });
    expect(e1).toContain('未持有其 job 句柄');
    // ② 错误 job 引用/身份错位：jobId 命中现存 job 但登记 PID 与 job 实际 PID 不一致。
    const t2 = seedUnknownTurn(db, `${tmpRoot}\\a2`.toLowerCase());
    const deadPid = oldChild.pid;
    registerTurnProcess(db, { turnId: t2.turnId, runId: t2.runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: deadPid, startedAtMs: null, identitySource: 'managed-job', managedJobId: liveJob.managedJobId });
    disposeTurnForRelease(db, t2.turnId);
    const e2 = await cmdErr(deps, 'recovery.releaseProtection', { turnId: t2.turnId, note: '错位反例' });
    expect(e2).toContain('不一致');
    // ③ 登记不完整：managed-job 无 managed_job_id（020 之前的历史形态）——拒绝自动解除。
    const t3 = seedUnknownTurn(db, `${tmpRoot}\\a3`.toLowerCase());
    registerTurnProcess(db, { turnId: t3.turnId, runId: t3.runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: liveJob.pid, startedAtMs: null, identitySource: 'managed-job' });
    disposeTurnForRelease(db, t3.turnId);
    const e3 = await cmdErr(deps, 'recovery.releaseProtection', { turnId: t3.turnId, note: '缺身份' });
    expect(e3).toContain('缺受管稳定身份');
    // 三租约全部保留（拒绝路径不动数据库）。
    const kept = db.prepare(`SELECT count(*) c FROM workspace_leases WHERE owner_turn_id IN (?,?,?) AND status='active'`).get(t1.turnId, t2.turnId, t3.turnId) as { c: number };
    expect(kept.c).toBe(3);
    // probe 身份核对：①无句柄 ②错位——均为 unknown（观察如实，不冒充退出）。
    const p1 = await cmd<{ result: string; detail: string }>(deps, 'recovery.probeProcess', { turnId: t1.turnId });
    expect(p1.result).toBe('unknown');
    expect(p1.detail).toContain('未持有其 job 句柄');
    const p2 = await cmd<{ result: string; detail: string }>(deps, 'recovery.probeProcess', { turnId: t2.turnId });
    expect(p2.result).toBe('unknown');
    expect(p2.detail).toContain('不一致');
    // 存活观察：登记与 job 一致且根仍活 → alive。
    const t4 = seedUnknownTurn(db, `${tmpRoot}\\a4`.toLowerCase());
    registerTurnProcess(db, { turnId: t4.turnId, runId: t4.runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: liveJob.pid, startedAtMs: null, identitySource: 'managed-job', managedJobId: liveJob.managedJobId });
    const p4 = await cmd<{ result: string; detail: string }>(deps, 'recovery.probeProcess', { turnId: t4.turnId });
    expect(p4.result).toBe('alive');
    liveJob.managed.dispose();
    db.close();
  }, 120_000);

  it('shared 两任务：单 turn 证据消费不关共享 job；stop 全量收尾（注册表/定时器归零）；重复解除幂等', async () => {
    const jobs0 = managedJobsCount();
    const pollers0 = managedActivePollers();
    const db = openDatabase(':memory:');
    seedDb(db);
    const admitted: string[] = [];
    const deps = makeDeps(db, admitted);
    const shared = spawnManagedBridge(NODE, [join(tmpRoot, 'worker.js')], { cwd: tmpRoot });
    await sleep(600);
    const ta = seedUnknownTurn(db, `${tmpRoot}\\s1`.toLowerCase());
    const tb = seedUnknownTurn(db, `${tmpRoot}\\s2`.toLowerCase());
    for (const t of [ta, tb]) {
      registerTurnProcess(db, { turnId: t.turnId, runId: t.runId, memberId: 'mA', adapterKind: 'codex', processModel: 'shared', pid: shared.pid, startedAtMs: null, identitySource: 'managed-job', managedJobId: shared.managedJobId });
      disposeTurnForRelease(db, t.turnId);
    }
    // 常驻 job 结束：terminateAll→**pump 先观察到根退出**（句柄关闭前——close 后无法再观测）
    // →释放句柄→计数归零——完整证据成立。
    const exited = new Promise<void>((r) => shared.on('exit', () => r()));
    shared.managed.terminateAll();
    await exited;
    shared.managed.releaseRootHandles();
    for (let i = 0; i < 40 && shared.managed.activeCount() !== 0; i += 1) await sleep(100);
    expect(shared.managed.activeCount()).toBe(0);
    // turn A 证据消费：解除成功，但 shared job **不因单 turn 收口关闭**（B 仍开放）。
    const ra = await cmd<{ stateChanged: boolean; managedRetire: { outcome: string; reason?: string } }>(deps, 'recovery.releaseProtection', { turnId: ta.turnId, note: 'shared A' });
    expect(ra.stateChanged).toBe(true);
    expect(ra.managedRetire.outcome).toBe('retained');
    expect(ra.managedRetire.reason).toContain('shared');
    expect(managedJobsCount()).toBe(jobs0 + 1); // 句柄保留（B 仍需）
    // turn B 解除：最后一个 open 登记消费——shared 仍保留（stop 归属），注册表不减。
    const rb = await cmd<{ stateChanged: boolean; managedRetire: { outcome: string } }>(deps, 'recovery.releaseProtection', { turnId: tb.turnId, note: 'shared B' });
    expect(rb.stateChanged).toBe(true);
    expect(rb.managedRetire.outcome).toBe('retained');
    expect(managedJobsCount()).toBe(jobs0 + 1);
    // 准入联动：两个解除的 turn 各触发一次 releaseAdmission（顺序=证据消费后）。
    expect(admitted).toEqual([ta.turnId, tb.turnId]);
    // 重复解除：幂等 no-op。
    const again = await cmd<{ stateChanged: boolean }>(deps, 'recovery.releaseProtection', { turnId: ta.turnId, note: '重复解除' });
    expect(again.stateChanged).toBe(false);
    // 事件留痕：两次解除各一条 recovery.protectionReleased（含 managedJobId）。
    const evts = db.prepare(`SELECT payload_json FROM domain_events WHERE kind='recovery.protectionReleased'`).all() as Array<{ payload_json: string }>;
    expect(evts.length).toBe(2);
    for (const e of evts) expect(JSON.parse(e.payload_json).managedJobId).toBe(shared.managedJobId);
    // stop 全量收尾：disposeAllManagedJobs——注册表/定时器归零，幂等。
    const disposed = disposeAllManagedJobs();
    expect(disposed).toContain(shared.managedJobId);
    expect(managedJobsCount()).toBe(jobs0);
    expect(managedActivePollers()).toBe(pollers0);
    expect(disposeAllManagedJobs()).toEqual([]);
    db.close();
  }, 120_000);
});
