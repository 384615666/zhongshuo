/**
 * 第三十八轮：DEV-25 现场缺陷修复的领域级反例（双机验收 2026-10-02 深夜现场实证的补测）。
 * - #2 防护模式拒绑真实 runtime：ZS_REAL_DISPATCH_GUARD=1 时 member.setRuntime claude/codex
 *   明确拒绝（不再「绑定成功→任务全部静默 FAILED」）；fake 恢复路径不受影响；不设防护变量=
 *   真实绑定正常可用（配置层）。
 * - #7 中断卡死形态：dm_turn ACTIVE+只有终态 run（停机中断）——conversation.list 如实呈现
 *   interrupted+interruptedTasks（不再永远「排队等待」）；task.redispatch 正式恢复（幂等/
 *   不复活已停止任务）；恢复后 run 可跑完、任务终态。
 * - #4 受阻原因：M0 房间任务 BLOCKED 的 board.view 卡片与 mine.pending 行带人话 reason
 *   （不再是无解释的「blocked」）。
 * - #6 会话区分：conversation.list 带 title 与 lastMessagePreview（同成员多会话可辨认）。
 * fake runtime 零真实调用。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { registerTurnProcess } from '../../src/daemon/processRegistry.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { successTurn } from '../../src/adapter/fake/script.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-r38fix-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄 */ } } });

interface Ctx {
  db: ZhongshuoDatabase;
  deps: { db: ZhongshuoDatabase; localUserId: string; interruptTurn: (t: string) => Promise<void>; appDataDir?: string };
  cmdRaw: (m: string, p: unknown, commandId?: string) => Promise<{ ok: boolean; data?: never; error?: { code: string; message: string } }>;
  cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T>;
}
async function makeDb(appDataDir?: string): Promise<Ctx> {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Guide A','agent',1),('mB','p1','Guide B','agent',1)`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, ...(appDataDir != null ? { appDataDir } : {}) };
  const cmdRaw = async (method: string, params: unknown, commandId?: string) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `r38-${randomUUID().slice(0, 8)}`, method, params }) as never;
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await cmdRaw(method, params, commandId) as unknown as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(`${r.error?.code ?? ''}: ${r.error?.message ?? 'failed'}`);
    return r.data as T;
  };
  return { db, deps, cmdRaw, cmd };
}
function makeWorker(db: ZhongshuoDatabase): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } {
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => successTurn() });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-r38', appDataDir: join(tmpRoot, 'app') });
  return { worker, adapter };
}
const waitFor = async (f: () => boolean, ms: number, what: string): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
};

describe('第三十八轮 #2：防护模式拒绑真实 runtime', () => {
  it('ZS_REAL_DISPATCH_GUARD=1 时 claude/codex 绑定明确拒绝；fake 不受影响；解除防护后真实绑定可用', async () => {
    const { cmdRaw, cmd } = await makeDb();
    process.env.ZS_REAL_DISPATCH_GUARD = '1';
    try {
      const bad = await cmdRaw('member.setRuntime', { memberId: 'mA', kind: 'claude', model: 'deepseek-flash' });
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe('CAPABILITY_UNSUPPORTED');
      expect(bad.error?.message).toContain('验收防护');
      expect(bad.error?.message).toContain('fake');
      const badCodex = await cmdRaw('member.setRuntime', { memberId: 'mA', kind: 'codex' });
      expect(badCodex.ok).toBe(false);
      // 恢复路径：kind=fake 可绑（现场 23:52 的 assist-fix-runtime 正是这条）。
      const fake = await cmd<{ kind: string }>('member.setRuntime', { memberId: 'mA', kind: 'fake' });
      expect(fake.kind).toBe('fake');
    } finally {
      delete process.env.ZS_REAL_DISPATCH_GUARD;
    }
    // 正式部署（不设防护变量）：真实绑定配置层正常（派发侧另有护栏口径）。
    const real = await cmd<{ kind: string }>('member.setRuntime', { memberId: 'mB', kind: 'claude', model: 'deepseek-flash' });
    expect(real.kind).toBe('claude');
  }, 60_000);
});

describe('第三十八轮 #7：中断卡死形态的呈现与显式恢复', () => {
  it('第四十轮合同（review-r39 §2/§3）：对账≠退出；保护未解除拒；正式闭环后可恢复；sourceRunId 归属；任务级意图', async () => {
    const { db, cmd, cmdRaw } = await makeDb(join(tmpRoot, 'app7'));
    const { worker } = makeWorker(db);
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: '中断恢复演练' });
    const c1 = await cmd<{ taskId: string; disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '会中断的任务', intent: 'default', mentions: [] });
    expect(c1.disposition).toBe('dispatched');
    await worker.runOnce(); // 首条 → DONE（fake successTurn）
    await waitFor(() => (db.prepare("SELECT count(*) c FROM workflow_runs WHERE task_id = ? AND status = 'SUCCEEDED'").get(c1.taskId) as { c: number }).c >= 1, 20_000, '首任务完成');
    // 构造停机中断形态（applyRecovery 同型，标注=故障形态注入）：初始 outbox 已完结、
    // run INTERRUPTED、turn UNKNOWN **且未对账**（budget_mark IS NULL——服务停机时尚未结算）。
    const c2 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '停机中断的任务', intent: 'default', mentions: [] });
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(`dmtask:${c2.taskId}:initial`);
    const runId2 = `run_${randomUUID()}`;
    const turnId2 = `turn_${randomUUID()}`;
    db.transaction(() => {
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId2, c2.taskId, conv.conversationId);
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, ?, 'mA', 'direct.work', 'UNKNOWN', 'dmtask:${c2.taskId}:initial', 1, 1)`).run(turnId2, runId2, conv.conversationId);
    })();
    // ①呈现：interrupted+recoverable=false（UNKNOWN 未对账——服务端分列，前端不得给按钮）。
    const list1 = await cmd<{ conversations: Array<{ conversationId: string; execState: string; interruptedTasks: Array<{ taskId: string; recoverable: boolean; blockReason: string | null; lastRunId: string | null }> }> }>('conversation.list', {});
    const me1 = list1.conversations.find((c) => c.conversationId === conv.conversationId)!;
    expect(me1.execState).toBe('interrupted');
    expect(me1.interruptedTasks.length).toBe(1);
    expect(me1.interruptedTasks[0]!.recoverable).toBe(false);
    expect(me1.interruptedTasks[0]!.blockReason).toContain('对账');
    // ②命令面：未对账 UNKNOWN → RECONCILE_REQUIRED（不新建 outbox——零派发行）。
    const rejected = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('RECONCILE_REQUIRED');
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:*:redispatch*'").get() as { c: number }).c).toBe(0);
    // ③§2.1 反例（正式链复现）：recovery.reconcile(executed)——turn 无进程登记 → 服务端
    // 取证=identity-missing → 预算结算但**保护保留、turn 仍 UNKNOWN**（退出未确认）。
    // 旧守卫把「budget_mark 已置+无租约」当可恢复而放行；新合同=仍拒（显式点击不构成
    // 退出证明），呈现也保持不可恢复。
    const rec1 = await cmd<{ protectionRetained: boolean; turnFinalStatus: string; reason: string }>('recovery.reconcile', { turnId: turnId2, verdict: 'executed', note: '测试：停机中断后按已执行对账（无进程登记）' });
    expect(rec1.protectionRetained).toBe(true);
    expect(rec1.turnFinalStatus).toBe('UNKNOWN');
    const list2 = await cmd<{ conversations: Array<{ conversationId: string; interruptedTasks: Array<{ recoverable: boolean; blockReason: string | null }> }> }>('conversation.list', {});
    const me2 = list2.conversations.find((c) => c.conversationId === conv.conversationId)!;
    expect(me2.interruptedTasks[0]!.recoverable).toBe(false);
    expect(me2.interruptedTasks[0]!.blockReason).toContain('退出未确认');
    const stillRejected = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 });
    expect(stillRejected.ok).toBe(false);
    expect(stillRejected.error?.code).toBe('RECONCILE_REQUIRED');
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:*:redispatch*'").get() as { c: number }).c).toBe(0);
    // ③b 补交退出证据（正式闭环第二段）：取得 none 模型登记后再次 executed 对账（预算不
    // 双算，仅推进退出事实）→ no-os-process → FAILED+释放 → c2 任务此后才真正可恢复。
    registerTurnProcess(db, { turnId: turnId2, runId: runId2, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const rec1b = await cmd<{ protectionRetained: boolean; turnFinalStatus: string }>('recovery.reconcile', { turnId: turnId2, verdict: 'executed', note: '测试：补交退出证据（none 模型）' });
    expect(rec1b.turnFinalStatus).toBe('FAILED');
    expect(rec1b.protectionRetained).toBe(false);
    // ④§2.2 反例（独立任务，正式链）：notStarted 人工声明（manualRiskAck）→ FAILED/refunded
    // 但**租约保留** → 仍不可恢复、仍拒（保护未解除——FAILED 不是恢复事实）。
    const convB = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mB', title: '人工声明演练' });
    const cb = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: convB.conversationId }, body: '人工声明未启动', intent: 'default', mentions: [] });
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(`dmtask:${cb.taskId}:initial`);
    const runIdB = `run_${randomUUID()}`;
    const turnIdB = `turn_${randomUUID()}`;
    db.transaction(() => {
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runIdB, cb.taskId, convB.conversationId);
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, ?, 'mB', 'direct.work', 'UNKNOWN', 'dmtask:${cb.taskId}:initial', 1, 1)`).run(turnIdB, runIdB, convB.conversationId);
      db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES ('test:guard:file', ?, 1, ?, 'active')`).run(turnIdB, Date.now());
    })();
    const recB = await cmd<{ protectionRetained: boolean; turnFinalStatus: string; reason: string }>('recovery.reconcile', { turnId: turnIdB, verdict: 'notStarted', note: '测试：人工声明未启动（风险确认）', manualRiskAck: true });
    expect(recB.protectionRetained).toBe(true);
    expect(recB.turnFinalStatus).toBe('FAILED');
    const listB = await cmd<{ conversations: Array<{ conversationId: string; interruptedTasks: Array<{ recoverable: boolean; blockReason: string | null }> }> }>('conversation.list', {});
    const meB = listB.conversations.find((c) => c.conversationId === convB.conversationId)!;
    expect(meB.interruptedTasks[0]!.recoverable).toBe(false);
    expect(meB.interruptedTasks[0]!.blockReason).toContain('租约');
    const rejectedB = await cmdRaw('task.redispatch', { taskId: cb.taskId, reason: 'manual-recovery' });
    expect(rejectedB.ok).toBe(false);
    expect(rejectedB.error?.code).toBe('RECONCILE_REQUIRED');
    // ⑤正式闭环正例（§2.2 任务续）：fake 执行的诚实登记=none 模型（无 OS 子进程）——
    // recovery.releaseProtection 以服务端 no-os-process 程序事实解除保护 → protectionReleased
    // 事件落库 → 可恢复=true → redispatch 正式入队（键绑最新源 run）。
    registerTurnProcess(db, { turnId: turnIdB, runId: runIdB, memberId: 'mB', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const rel = await cmd<{ stateChanged: boolean; releasedLeases: string[] }>('recovery.releaseProtection', { turnId: turnIdB, note: '测试：none 模型程序事实解除' });
    expect(rel.stateChanged).toBe(true);
    expect(rel.releasedLeases).toContain('test:guard:file');
    const listB2 = await cmd<{ conversations: Array<{ conversationId: string; interruptedTasks: Array<{ recoverable: boolean; lastRunId: string | null }> }> }>('conversation.list', {});
    const meB2 = listB2.conversations.find((c) => c.conversationId === convB.conversationId)!;
    expect(meB2.interruptedTasks[0]!.recoverable).toBe(true);
    const rb = await cmd<{ enqueued: boolean; dispatchKey: string; sourceRunId: string | null }>('task.redispatch', { taskId: cb.taskId, reason: 'manual-recovery' });
    expect(rb.enqueued).toBe(true);
    expect(rb.dispatchKey).toBe(`task:${cb.taskId}:redispatch:${runIdB}`);
    // ⑥§3 sourceRunId 归属（review §3——任意号不得生成意图；双假号连续均拒且零写入）。
    const fake1 = await cmdRaw('task.redispatch', { taskId: cb.taskId, reason: 'x', sourceRunId: 'run_nonexistent_a' });
    const fake2 = await cmdRaw('task.redispatch', { taskId: cb.taskId, reason: 'x', sourceRunId: 'run_nonexistent_b' });
    expect(fake1.ok).toBe(false); expect(fake1.error?.code).toBe('RESOURCE_NOT_FOUND');
    expect(fake2.ok).toBe(false); expect(fake2.error?.code).toBe('RESOURCE_NOT_FOUND');
    const foreign = await cmdRaw('task.redispatch', { taskId: cb.taskId, reason: 'x', sourceRunId: runId2 }); // 他任务 run
    expect(foreign.ok).toBe(false); expect(foreign.error?.code).toBe('RESOURCE_NOT_FOUND');
    // 过时来源：cb 任务先清掉⑥rb 的在途意图，再登记一个更新 run（oldRun 成为最新）→
    // 以更早的 runIdB 作来源 → 非最新 → STALE（且走「最新执行」新校验文案，非 done 撞键）。
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(rb.dispatchKey);
    const oldRun = `run_${randomUUID()}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(oldRun, cb.taskId, convB.conversationId);
    const stale = await cmdRaw('task.redispatch', { taskId: cb.taskId, reason: 'x', sourceRunId: runIdB });
    expect(stale.ok).toBe(false); expect(stale.error?.code).toBe('STALE_REVISION');
    expect(stale.error?.message).toContain('最新执行');
    // ⑦任务级在途意图（不只查指定键）：注入异源 pending 意图 → 任意 source 均 IDEMPOTENCY_CONFLICT。
    const runIdB2 = `run_${randomUUID()}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runIdB2, cb.taskId, convB.conversationId);
    db.prepare(`INSERT INTO outbox (dispatch_key, status, stop_generation_at_enqueue) VALUES (?, 'pending', 0)`).run(`task:${cb.taskId}:redispatch:${runIdB2}`);
    const conflictIntent = await cmdRaw('task.redispatch', { taskId: cb.taskId, reason: 'x', sourceRunId: runIdB2 });
    expect(conflictIntent.ok).toBe(false); expect(conflictIntent.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(`task:${cb.taskId}:redispatch:${runIdB2}`);
    // ⑧新中断=新意图（正式闭环：none 登记→executed 对账→no-os-process 释放+FAILED）。
    const runId3 = `run_${randomUUID()}`;
    const turnId3 = `turn_${randomUUID()}`;
    db.transaction(() => {
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId3, c2.taskId, conv.conversationId);
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, ?, 'mA', 'direct.work', 'UNKNOWN', 'dmtask:${c2.taskId}:r3', 1, 1)`).run(turnId3, runId3, conv.conversationId);
    })();
    registerTurnProcess(db, { turnId: turnId3, runId: runId3, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const rec3 = await cmd<{ protectionRetained: boolean; turnFinalStatus: string }>('recovery.reconcile', { turnId: turnId3, verdict: 'executed', note: '测试：none 模型按已执行对账' });
    expect(rec3.turnFinalStatus).toBe('FAILED');
    expect(rec3.protectionRetained).toBe(false);
    const r3 = await cmd<{ enqueued: boolean; dispatchKey: string }>('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId3 });
    expect(r3.enqueued).toBe(true);
    expect(r3.dispatchKey).toBe(`task:${c2.taskId}:redispatch:${runId3}`);
    // ⑨同 commandId 重放=回执幂等（网关），同源重复点击=幂等冲突。
    const dup = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId3 });
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    const replay = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId3 }, 'r40-recover-fixed-cmd');
    const replay2 = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId3 }, 'r40-recover-fixed-cmd');
    expect((replay as { ok: boolean }).ok).toBe((replay2 as { ok: boolean }).ok);
    expect((db.prepare('SELECT count(*) c FROM outbox WHERE dispatch_key = ?').get(r3.dispatchKey) as { c: number }).c).toBe(1);
    // ⑩同源 done 后再点=STALE（该次恢复已派发——不重复派发）。
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(r3.dispatchKey);
    const again = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId3 });
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe('STALE_REVISION');
    // ⑪在途 DM（旧 turn 仍 RUNNING，dmtask: 键）→ 拒绝（复核 §2.1 第一反例——键前缀漏查已修）。
    const c4 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '在途任务', intent: 'default', mentions: [] });
    const runId4 = `run_${randomUUID()}`;
    const turnId4 = `turn_${randomUUID()}`;
    db.transaction(() => {
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'RUNNING')`).run(runId4, c4.taskId, conv.conversationId);
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, ?, 'mA', 'direct.work', 'RUNNING', 'dmtask:${c4.taskId}:initial', 1, 1)`).run(turnId4, runId4, conv.conversationId);
    })();
    const inFlightReject = await cmdRaw('task.redispatch', { taskId: c4.taskId, reason: 'followup' });
    expect(inFlightReject.ok).toBe(false);
    expect(inFlightReject.error?.code).toBe('WORKER_STILL_RUNNING');
    // ⑫已停止任务不复活（保留既有合同）。
    const c5 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '已停止的中断任务', intent: 'default', mentions: [] });
    db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(c5.taskId);
    const runId5 = `run_${randomUUID()}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId5, c5.taskId, conv.conversationId);
    const revive = await cmdRaw('task.redispatch', { taskId: c5.taskId, reason: 'interrupted-recovery' });
    expect(revive.ok).toBe(false);
    expect(revive.error?.code).toBe('STALE_REVISION');
  }, 180_000);

  it('第四十轮 §2：恢复闭环判定跨重启（protectionReleased 事件持久=新进程同判）', async () => {
    const dbPath = join(tmpRoot, 'cross-restart', 'state.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Guide A','agent',1),('mB','p1','Guide B','agent',1)`).run();
    const cmdOn = <T,>(target: ZhongshuoDatabase) => async (method: string, params: unknown): Promise<T> => {
      const deps = { db: target, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'cross-restart', 'app') };
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r40x-${randomUUID().slice(0, 8)}`, method, params }) as unknown as { ok: boolean; data?: T; error?: { code: string; message: string } };
      if (!r.ok) throw new Error(`${r.error?.code ?? ''}: ${r.error?.message ?? 'failed'}`);
      return r.data as T;
    };
    const conv = await cmdOn<{ conversationId: string }>(db)('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: '跨重启演练' });
    const c = await cmdOn<{ taskId: string }>(db)('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '跨重启中断', intent: 'default', mentions: [] });
    const runId = `run_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(`dmtask:${c.taskId}:initial`);
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId, c.taskId, conv.conversationId);
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, ?, 'mA', 'direct.work', 'UNKNOWN', 'dmtask:${c.taskId}:initial', 1, 1)`).run(turnId, runId, conv.conversationId);
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    // 「进程一」：正式对账闭环（none 模型 → no-os-process → FAILED）。
    const rec = await cmdOn<{ turnFinalStatus: string }>(db)('recovery.reconcile', { turnId, verdict: 'executed', note: '跨重启前对账' });
    expect(rec.turnFinalStatus).toBe('FAILED');
    db.close();
    // 「进程二」：同一库文件重开（模拟 daemon 重启）——判定与「进程一」一致：可恢复。
    const db2 = openDatabase(dbPath);
    const list = await cmdOn<{ conversations: Array<{ conversationId: string; interruptedTasks: Array<{ recoverable: boolean }> }> }>(db2)('conversation.list', {});
    const me = list.conversations.find((x) => x.conversationId === conv.conversationId)!;
    expect(me.interruptedTasks[0]!.recoverable).toBe(true);
    db2.close();
  }, 60_000);

  it('M0 房间 AUTO 任务 BLOCKED → 卡片 statusReason 与待办 reason 含「指派成员」人话', async () => {
    const { db, cmd } = await makeDb(join(tmpRoot, 'app4'));
    const { worker } = makeWorker(db);
    // 房间与房间消息（无 mentions → AUTO → M0 门禁 BLOCKED——现场缺陷 #4 的实际路径）。
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA','p1','大厅','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convRoom','p1','room','roomA')`).run();
    db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA'),('roomA','mB')`).run();
    const r = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'convRoom', roomId: 'roomA' }, body: '房间任务无指派', intent: 'default', mentions: [] });
    await worker.runOnce(); // 领取 → M0 门禁置 BLOCKED（dispatchWorker 374-384 路径）
    await waitFor(() => (db.prepare("SELECT count(*) c FROM tasks WHERE id = ? AND status = 'BLOCKED'").get(r.taskId) as { c: number }).c >= 1, 20_000, '任务 BLOCKED');
    const board = await cmd<{ groups: Array<{ rooms: Array<{ cards: Array<{ taskId: string; column: string; statusReason: string | null }> }> }> }>('board.view', { scope: 'all' });
    const card = board.groups.flatMap((g) => g.rooms).flatMap((rm) => rm.cards).find((c) => c.taskId === r.taskId)!;
    expect(card.column).toBe('blocked');
    expect(card.statusReason).toContain('指派成员'); // 人话：M0 需 @ 指定成员
    const mine = await cmd<{ projects: Array<{ blockedTasks: Array<{ task_id: string; reason: string | null }> }> }>('mine.pending', {});
    const b = mine.projects.flatMap((p) => p.blockedTasks).find((x) => x.task_id === r.taskId)!;
    expect(b.reason).toContain('指派成员');
  }, 60_000);
});
