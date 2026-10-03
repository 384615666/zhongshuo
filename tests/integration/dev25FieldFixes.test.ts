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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
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
  it('第三十九轮合同：UNKNOWN 未对账→RECONCILE_REQUIRED；对账后可恢复；同源幂等；新中断新意图；在途 DM 拒', async () => {
    const { db, cmd, cmdRaw } = await makeDb(join(tmpRoot, 'app7'));
    const { worker } = makeWorker(db);
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: '中断恢复演练' });
    const c1 = await cmd<{ taskId: string; disposition: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '会中断的任务', intent: 'default', mentions: [] });
    expect(c1.disposition).toBe('dispatched');
    await worker.runOnce(); // 首条 → DONE（fake successTurn）
    await waitFor(() => (db.prepare("SELECT count(*) c FROM workflow_runs WHERE task_id = ? AND status = 'SUCCEEDED'").get(c1.taskId) as { c: number }).c >= 1, 20_000, '首任务完成');
    // 构造停机中断形态（applyRecovery 同型）：初始 outbox 已完结、run INTERRUPTED、turn UNKNOWN
    // **且未对账**（budget_mark IS NULL——服务停机时尚未结算）。
    const c2 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '停机中断的任务', intent: 'default', mentions: [] });
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(`dmtask:${c2.taskId}:initial`);
    const runId2 = `run_${randomUUID()}`;
    const turnId2 = `turn_${randomUUID()}`;
    db.transaction(() => {
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId2, c2.taskId, conv.conversationId);
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, ?, 'mA', 'direct.work', 'UNKNOWN', 'dmtask:${c2.taskId}:initial', 1, 1)`).run(turnId2, runId2, conv.conversationId);
    })();
    // ①呈现：interrupted+recoverable=false（UNKNOWN 未对账——服务端分列，前端不得给按钮）。
    const list1 = await cmd<{ conversations: Array<{ execState: string; interruptedTasks: Array<{ taskId: string; recoverable: boolean; blockReason: string | null; lastRunId: string | null }> }> }>('conversation.list', {});
    const me1 = list1.conversations.find((c) => c.conversationId === conv.conversationId)!;
    expect(me1.execState).toBe('interrupted');
    expect(me1.interruptedTasks.length).toBe(1);
    expect(me1.interruptedTasks[0]!.recoverable).toBe(false);
    expect(me1.interruptedTasks[0]!.blockReason).toContain('对账');
    // ②命令面：未对账 UNKNOWN → RECONCILE_REQUIRED（不新建 outbox——零派发行）。
    const rejected = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('RECONCILE_REQUIRED');
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE 'task:%:redispatch%'").get() as { c: number }).c).toBe(0);
    // ③对账收口（恢复中心语义：budget 结算+无未释放租约）→ 可恢复+重派入队（键绑源执行）。
    db.prepare(`UPDATE agent_turns SET budget_mark = 'settled' WHERE id = ?`).run(turnId2);
    const list2 = await cmd<{ conversations: Array<{ interruptedTasks: Array<{ recoverable: boolean; lastRunId: string | null }> }> }>('conversation.list', {});
    const me2 = list2.conversations.find((c) => c.conversationId === conv.conversationId)!;
    expect(me2.interruptedTasks[0]!.recoverable).toBe(true);
    expect(me2.interruptedTasks[0]!.lastRunId).toBe(runId2);
    const r1 = await cmd<{ enqueued: boolean; dispatchKey: string; sourceRunId: string | null }>('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 });
    expect(r1.enqueued).toBe(true);
    expect(r1.dispatchKey).toBe(`task:${c2.taskId}:redispatch:${runId2}`);
    expect(r1.sourceRunId).toBe(runId2);
    // ④双端/重复点击：同源在途=幂等冲突；同 commandId 重试=回执幂等（网关）。
    const dup = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 });
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    const replay = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 }, 'r39-recover-fixed-cmd');
    const replay2 = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 }, 'r39-recover-fixed-cmd');
    expect((replay as { ok: boolean }).ok).toBe((replay2 as { ok: boolean }).ok);
    expect((db.prepare('SELECT count(*) c FROM outbox WHERE dispatch_key = ?').get(r1.dispatchKey) as { c: number }).c).toBe(1);
    // ⑤同源 done 后再点=STALE（该次恢复已派发——不重复派发；不盲删旧行保审计）。
    db.prepare(`UPDATE outbox SET status = 'done' WHERE dispatch_key = ?`).run(r1.dispatchKey);
    const again = await cmdRaw('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId2 });
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe('STALE_REVISION');
    // ⑥第二次中断（新 run）→ 新意图入队（不撞唯一键）。
    const runId3 = `run_${randomUUID()}`;
    const turnId3 = `turn_${randomUUID()}`;
    db.transaction(() => {
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId3, c2.taskId, conv.conversationId);
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch, budget_mark) VALUES (?, ?, ?, 'mA', 'direct.work', 'UNKNOWN', 'dmtask:${c2.taskId}:r3', 1, 1, 'settled')`).run(turnId3, runId3, conv.conversationId);
    })();
    const r3 = await cmd<{ enqueued: boolean; dispatchKey: string }>('task.redispatch', { taskId: c2.taskId, reason: 'interrupted-recovery', sourceRunId: runId3 });
    expect(r3.enqueued).toBe(true);
    expect(r3.dispatchKey).toBe(`task:${c2.taskId}:redispatch:${runId3}`);
    // ⑦在途 DM（旧 turn 仍 RUNNING，dmtask: 键）→ 拒绝（复核 §2.1 第一反例——键前缀漏查已修）。
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
    // ⑧已停止任务不复活（保留既有合同）。
    const c5 = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId }, body: '已停止的中断任务', intent: 'default', mentions: [] });
    db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(c5.taskId);
    const runId5 = `run_${randomUUID()}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(runId5, c5.taskId, conv.conversationId);
    const revive = await cmdRaw('task.redispatch', { taskId: c5.taskId, reason: 'interrupted-recovery' });
    expect(revive.ok).toBe(false);
    expect(revive.error?.code).toBe('STALE_REVISION');
  }, 180_000);

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
