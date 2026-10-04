/**
 * 第四十二轮 §3（review-r41）：迁移042——旧库「保护保留」事实回填。
 *
 * 复核反例（dist/desktop/review-r41/legacy-protection-upgrade-probe.mjs）：用实际迁移 001–040
 * 建库并注入旧版 notStarted 正式形态（run=INTERRUPTED、turn=FAILED/refunded、无租约、
 * recovery.reconciled 审计 protectionRetained=true、无释放证据），40→41 后 protection_state=NULL
 * → 呈现可恢复、task.redispatch 放行、releaseProtection 无租约 no-op。042 按事件顺序回填。
 *
 * 覆盖：40→最新（文件库，含重开同判）、41→最新（先复现漏洞再修复）、旧保留项零新派发、
 * 已有可靠释放项不误拦、普通失败/keepUnknown 不误标、证据损坏不默认安全、「曾释放→更晚
 * 保留」顺序规则、数据/预算/审计不丢、幂等重跑；分类纯函数补 exited/缺 verdict 分支。
 * fake/零真实模型调用（本文件不启动 worker，只用命令面与守卫直读）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase, migrate } from '../../src/persistence/db.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/index.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { registerTurnProcess } from '../../src/daemon/processRegistry.ts';
import { assessTaskRedispatchReadiness } from '../../src/persistence/stores/recoveryGuard.ts';
import { classifyProtectionFact } from '../../src/persistence/migrations/042-turn-protection-state-backfill.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-r42upg-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄 */ } } });

/** 按旧版本 schema 建库（镜像 openDatabase 的 pragma 面，只跑到 maxVersion）。 */
function openAtVersion(path: string, maxVersion: number): ZhongshuoDatabase {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, {}, MIGRATIONS.filter((m) => m.id <= maxVersion));
  return db;
}

type EvSpec = { kind: 'recovery.reconciled' | 'recovery.protectionReleased'; payload: unknown | string };

interface Fixture {
  key: string;
  turnStatus: string;
  budgetMark: string | null;
  budgetJson: string | null;
  events: EvSpec[];
  lease?: string;
  expectState: 'retained' | 'released' | null;
}

/** 旧版正式命令已证明会产生的审计/状态形态（复核 §3 反例注入口径）。 */
const NOT_STARTED_AUDIT: EvSpec = {
  kind: 'recovery.reconciled',
  payload: { verdict: 'notStarted', recordedAs: 'manual-claim', protectionRetained: true, turnFinalStatus: 'FAILED', reason: 'manual-not-started-risk-ack', manualNote: '人工声明（风险确认）' },
};
const RELEASED_EVENT: EvSpec = {
  kind: 'recovery.protectionReleased',
  payload: { released: true, releasedLeases: [], reason: 'protection-released-no-os-process', manualNote: 'none 模型程序事实解除' },
};

function seedBase(db: ZhongshuoDatabase, conversationId: string): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Guide A','agent',1)`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, title) VALUES (?, 'p1', 'dm', '旧库升级演练')`).run(conversationId);
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1', ?, 'human', 'u_local'), ('p1', ?, 'agent', 'mA')`).run(conversationId, conversationId);
}

function seedFixture(db: ZhongshuoDatabase, conversationId: string, f: Fixture): { taskId: string; runId: string; turnId: string } {
  const taskId = `task_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const turnId = `turn_${randomUUID()}`;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, title, status) VALUES (?, 'p1', ?, 'dm_turn', ?, 'ACTIVE')`).run(taskId, conversationId, `旧库任务-${f.key}`);
    db.prepare(`INSERT INTO outbox (dispatch_key, status, stop_generation_at_enqueue) VALUES (?, 'done', 0)`).run(`dmtask:${taskId}:initial`);
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status, budget_json) VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED', ?)`).run(runId, taskId, conversationId, f.budgetJson);
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch, budget_mark) VALUES (?, ?, ?, 'mA', 'direct.work', ?, ?, 1, 1, ?)`).run(turnId, runId, conversationId, f.turnStatus, `dmtask:${taskId}:initial`, f.budgetMark);
    if (f.lease != null) {
      db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, ?, 1, ?, 'active')`).run(f.lease, turnId, Date.now());
    }
    let at = Date.now();
    for (const ev of f.events) {
      at += 10;
      db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, task_id, run_id, turn_id, kind, payload_json, created_at) VALUES (?, 1, 'p1', ?, ?, ?, ?, ?, ?)`)
        .run(`evt_${randomUUID()}`, taskId, runId, turnId, ev.kind, typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload), at);
    }
  });
  tx();
  return { taskId, runId, turnId };
}

/** 升级前全量快照（数据/预算/审计不丢——比对迁移前后）。 */
function snapshot(db: ZhongshuoDatabase): { events: number; eventDigest: string; turns: number; budgets: string } {
  const events = (db.prepare('SELECT count(*) c FROM domain_events').get() as { c: number }).c;
  const payloads = (db.prepare('SELECT seq, kind, payload_json FROM domain_events ORDER BY seq').all() as Array<{ seq: number; kind: string; payload_json: string }>).map((r) => `${r.seq}:${r.kind}:${r.payload_json}`).join('|');
  const turns = (db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c;
  const budgets = (db.prepare('SELECT id, budget_json FROM workflow_runs ORDER BY rowid').all() as Array<{ id: string; budget_json: string | null }>).map((r) => `${r.id}=${r.budget_json}`).join('|');
  return { events, eventDigest: payloads, turns, budgets };
}

interface TaskRow { taskId: string; recoverable: boolean; blockReason: string | null }
interface PendingRow { turnId: string; leaseCount: number; protectionState: string }

const cmdOn = (db: ZhongshuoDatabase, appDir: string) => async <T,>(method: string, params: unknown): Promise<T> => {
  const r = await dispatchDaemonCommand({ db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir }, { protocolVersion: 1, commandId: `r42-${randomUUID().slice(0, 8)}`, method, params }) as unknown as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!r.ok) throw new Error(`${r.error?.code ?? ''}: ${r.error?.message ?? 'failed'}`);
  return r.data as T;
};
const cmdRawOn = (db: ZhongshuoDatabase, appDir: string) => async (method: string, params: unknown) =>
  await dispatchDaemonCommand({ db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir }, { protocolVersion: 1, commandId: `r42-${randomUUID().slice(0, 8)}`, method, params }) as unknown as { ok: boolean; data?: never; error?: { code: string; message: string } };

const protectionStateOf = (db: ZhongshuoDatabase, turnId: string): string | null =>
  (db.prepare('SELECT protection_state p FROM agent_turns WHERE id = ?').get(turnId) as { p: string | null }).p;

describe('第四十二轮 §3：分类纯函数（classifyProtectionFact）', () => {
  it('两正式事件类的保留/释放/无事实与不默认安全分支', () => {
    expect(classifyProtectionFact('recovery.reconciled', JSON.stringify({ verdict: 'notStarted', recordedAs: 'manual-claim', protectionRetained: true }))).toBe('retained');
    expect(classifyProtectionFact('recovery.reconciled', JSON.stringify({ verdict: 'executed', protectionRetained: true, exitFact: 'alive' }))).toBe('retained');
    expect(classifyProtectionFact('recovery.reconciled', JSON.stringify({ verdict: 'executed', exitFact: 'no-os-process' }))).toBe('released');
    expect(classifyProtectionFact('recovery.reconciled', JSON.stringify({ verdict: 'executed', exitFact: 'exited', releasedLeases: ['d:1'] }))).toBe('released'); // 旧版全释放路径——忠实继承
    expect(classifyProtectionFact('recovery.reconciled', JSON.stringify({ verdict: 'keepUnknown' }))).toBe(null);
    expect(classifyProtectionFact('recovery.reconciled', JSON.stringify({ verdict: 'executed' }))).toBe('retained'); // exitFact 缺失——不默认安全
    expect(classifyProtectionFact('recovery.reconciled', JSON.stringify({ probe: {} }))).toBe('retained'); // verdict 缺失
    expect(classifyProtectionFact('recovery.reconciled', 'not-json{')).toBe('retained'); // 证据损坏
    expect(classifyProtectionFact('recovery.protectionReleased', JSON.stringify({ released: true }))).toBe('released');
    expect(classifyProtectionFact('recovery.protectionReleased', JSON.stringify({ released: false, protectionRetained: true }))).toBe('retained');
    expect(classifyProtectionFact('recovery.protectionReleased', JSON.stringify({ reason: 'x' }))).toBe('retained'); // released 字段缺失
    expect(classifyProtectionFact('recovery.protectionReleased', 'corrupt')).toBe('retained');
    expect(classifyProtectionFact('task.review', JSON.stringify({}))).toBe(null); // 非保护语义事件
  });
});

describe('第四十二轮 §3：40→最新（文件库）——回填/呈现/准入/恢复中心/重开同判', () => {
  it('旧保留项回填 retained 且零新派发；可靠释放/普通失败不误拦；证据损坏不默认安全；数据预算审计不丢；幂等', async () => {
    const dbPath = join(tmpRoot, 'upg40', 'state.sqlite');
    mkdirSync(join(tmpRoot, 'upg40'), { recursive: true });
    const db = openAtVersion(dbPath, 40);
    seedBase(db, 'convUpg40');
    const fx = seedAll(db, 'convUpg40');
    const before = snapshot(db);
    expect(db.pragma('user_version', { simple: true })).toBe(40);

    const res = migrate(db);
    expect(res.fromVersion).toBe(40);
    expect(res.applied).toEqual([41, 42]);
    expect(db.pragma('user_version', { simple: true })).toBe(42);

    // ① 回填结果：事件顺序推导的每 turn 最新保护事实。
    for (const f of fx.list) expect(protectionStateOf(db, f.turnId)).toBe(f.fixture.expectState);
    // ② 数据/预算/审计不丢（迁移只写 protection_state）。
    const after = snapshot(db);
    expect(after.events).toBe(before.events);
    expect(after.eventDigest).toBe(before.eventDigest);
    expect(after.turns).toBe(before.turns);
    expect(after.budgets).toBe(before.budgets);
    // ③ 呈现（conversation.list 与守卫同源）：保留项不可恢复+人话原因；释放/普通项可恢复。
    const cmd = cmdOn(db, join(tmpRoot, 'upg40', 'app'));
    const list = await cmd<{ conversations: Array<{ conversationId: string; interruptedTasks: Array<{ taskId: string; recoverable: boolean; blockReason: string | null }> }> }>('conversation.list', {});
    const byTask = new Map<string, TaskRow>(list.conversations.find((c) => c.conversationId === 'convUpg40')!.interruptedTasks.map((t) => [t.taskId, t] as [string, TaskRow]));
    expect(byTask.size).toBe(fx.list.length);
    for (const f of fx.list) {
      const row = byTask.get(f.taskId)!;
      expect(row.recoverable, f.fixture.key).toBe(f.fixture.expectRecoverable);
      if (!f.fixture.expectRecoverable) {
        expect(row.blockReason, f.fixture.key).toContain(f.fixture.expectBlockSnippet!);
      }
    }
    // ④ 准入：旧保留项 redispatch 拒绝且零新增派发行（含全部保留形态任务）。
    const cmdRaw = cmdRawOn(db, join(tmpRoot, 'upg40', 'app'));
    for (const key of ['keep1', 'exec1', 'order1', 'corrupt1']) {
      const rej = await cmdRaw('task.redispatch', { taskId: fx.byKey[key]!.taskId, reason: 'x' });
      expect(rej.ok, key).toBe(false);
      expect(rej.error?.code, key).toBe('RECONCILE_REQUIRED');
    }
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:*:redispatch*'").get() as { c: number }).c).toBe(0);
    // ⑤ 恢复中心：保留项可见（无租约 leaseCount=0）；释放/普通项不在列。
    const status = await cmd<{ pendingRelease: Array<{ turnId: string; leaseCount: number; protectionState: string }> }>('recovery.status', {});
    const pend = new Map<string, PendingRow>(status.pendingRelease.map((r) => [r.turnId, r] as [string, PendingRow]));
    expect(pend.has(fx.byKey.keep1!.turnId)).toBe(true);
    expect(pend.get(fx.byKey.keep1!.turnId)!.leaseCount).toBe(0);
    for (const key of ['exec1', 'order1', 'corrupt1']) expect(pend.has(fx.byKey[key]!.turnId), key).toBe(true);
    expect(pend.has(fx.byKey.rel1!.turnId)).toBe(false);
    expect(pend.has(fx.byKey.plain1!.turnId)).toBe(false);
    // ⑥ 无证据解除被拒（不再无租约 no-op 冒充已闭环）→ 服务端程序证据解除 → 恰一次恢复。
    const denied = await cmdRaw('recovery.releaseProtection', { turnId: fx.byKey.keep1!.turnId, note: '测试：无登记解除尝试' });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('STALE_REVISION');
    expect(protectionStateOf(db, fx.byKey.keep1!.turnId)).toBe('retained');
    registerTurnProcess(db, { turnId: fx.byKey.keep1!.turnId, runId: fx.byKey.keep1!.runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    const rel = await cmd<{ stateChanged: boolean }>('recovery.releaseProtection', { turnId: fx.byKey.keep1!.turnId, note: '测试：none 模型程序事实解除' });
    expect(rel.stateChanged).toBe(true);
    expect(protectionStateOf(db, fx.byKey.keep1!.turnId)).toBe('released');
    const rd = await cmd<{ enqueued: boolean; dispatchKey: string }>('task.redispatch', { taskId: fx.byKey.keep1!.taskId, reason: 'legacy-recovery' });
    expect(rd.enqueued).toBe(true);
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:*:redispatch*'").get() as { c: number }).c).toBe(1);
    const dup = await cmdRaw('task.redispatch', { taskId: fx.byKey.keep1!.taskId, reason: 'legacy-recovery' });
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    // ⑦ 幂等：重跑迁移无动作、状态不变。
    const again = migrate(db);
    expect(again.applied).toEqual([]);
    expect(protectionStateOf(db, fx.byKey.order1!.turnId)).toBe('retained');
    db.close();
    // ⑧ 文件库重开同判：更晚保留事实（order1）跨进程仍拦。
    const db2 = openDatabase(dbPath);
    const blocked2 = assessTaskRedispatchReadiness(db2, fx.byKey.order1!.taskId);
    expect(blocked2 != null && blocked2.fact.kind === 'protection-retained').toBe(true);
    expect(protectionStateOf(db2, fx.byKey.order1!.turnId)).toBe('retained');
    db2.close();
  }, 120_000);
});

describe('第四十二轮 §3：41→最新（内存库）——先复现漏洞，升级后同 row 收口', () => {
  it('041 已应用但未回填：升级前放行（复核反例复现）→ 042 回填 retained → 呈现/准入/解除全部收口', async () => {
    const db = openAtVersion(':memory:', 41);
    seedBase(db, 'convUpg41');
    const keep = seedFixture(db, 'convUpg41', {
      key: 'vuln', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT], expectState: 'retained',
    });
    const plain = seedFixture(db, 'convUpg41', {
      key: 'plain', turnStatus: 'FAILED', budgetMark: 'settled', budgetJson: '{"usedTurns":2,"inFlightReservedTurns":0}',
      events: [], expectState: null,
    });
    // 复现（升级前，41 schema 下当前代码可运行）：NULL=「从未进入保护语义」→ 放行。
    expect(protectionStateOf(db, keep.turnId)).toBe(null);
    expect(assessTaskRedispatchReadiness(db, keep.taskId)).toBe(null);
    const cmdRaw = cmdRawOn(db, join(tmpRoot, 'upg41', 'app'));
    const vulnerable = await cmdRaw('task.redispatch', { taskId: keep.taskId, reason: 'legacy-recovery' });
    expect(vulnerable.ok).toBe(true); // ← 漏洞形态（review §3 反例：enqueued=true）
    expect((vulnerable.data as unknown as { enqueued: boolean }).enqueued).toBe(true);
    // 清掉漏洞期派发行，恢复升级前形态（其后由 042 收口重验零新派发）。
    db.prepare(`DELETE FROM outbox WHERE dispatch_key GLOB 'task:${keep.taskId}:redispatch*'`).run();

    const res = migrate(db);
    expect(res.applied).toEqual([42]);
    // 收口：retained 回填 → 呈现不可恢复、准入拒绝且零新派发、恢复中心可见。
    expect(protectionStateOf(db, keep.turnId)).toBe('retained');
    const cmd = cmdOn(db, join(tmpRoot, 'upg41', 'app'));
    const list = await cmd<{ conversations: Array<{ conversationId: string; interruptedTasks: Array<{ taskId: string; recoverable: boolean; blockReason: string | null }> }> }>('conversation.list', {});
    const rows = new Map<string, TaskRow>(list.conversations.find((c) => c.conversationId === 'convUpg41')!.interruptedTasks.map((t) => [t.taskId, t] as [string, TaskRow]));
    expect(rows.get(keep.taskId)!.recoverable).toBe(false);
    expect(rows.get(keep.taskId)!.blockReason).toContain('protection_state=retained');
    expect(rows.get(plain.taskId)!.recoverable).toBe(true); // 普通失败不误拦
    const rej = await cmdRaw('task.redispatch', { taskId: keep.taskId, reason: 'legacy-recovery' });
    expect(rej.ok).toBe(false);
    expect(rej.error?.code).toBe('RECONCILE_REQUIRED');
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:*:redispatch*'").get() as { c: number }).c).toBe(0);
    const status = await cmd<{ pendingRelease: Array<{ turnId: string; leaseCount: number }> }>('recovery.status', {});
    expect(status.pendingRelease.some((r) => r.turnId === keep.turnId && r.leaseCount === 0)).toBe(true);
    db.close();
  }, 60_000);
});

/** 40→最新的七形态矩阵（expectRecoverable/expectBlockSnippet 由 expectState 推导）。 */
function seedAll(db: ZhongshuoDatabase, convId: string): { list: Array<{ key: string; taskId: string; runId: string; turnId: string; fixture: Fixture & { expectRecoverable: boolean; expectBlockSnippet?: string } }>; byKey: Record<string, { taskId: string; runId: string; turnId: string }> } {
  const defs: Array<Fixture> = [
    { key: 'keep1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT], expectState: 'retained' }, // 复核反例本体：无租约人工退款
    { key: 'rel1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, RELEASED_EVENT], expectState: 'released' }, // 可靠释放——不误拦
    { key: 'plain1', turnStatus: 'FAILED', budgetMark: 'settled', budgetJson: '{"usedTurns":2,"inFlightReservedTurns":0}', events: [], expectState: null }, // 普通失败——不误标
    { key: 'exec1', turnStatus: 'UNKNOWN', budgetMark: 'settled', budgetJson: '{"usedTurns":3,"inFlightReservedTurns":0}', events: [{ kind: 'recovery.reconciled', payload: { verdict: 'executed', exitFact: 'identity-missing', protectionRetained: true, reason: 'executed-exit-identity-missing-protection-retained' } }], expectState: 'retained' }, // executed 取证未确认
    { key: 'keepu1', turnStatus: 'UNKNOWN', budgetMark: null, budgetJson: '{"usedTurns":4,"inFlightReservedTurns":1}', events: [{ kind: 'recovery.reconciled', payload: { verdict: 'keepUnknown', note: '维持不确定' } }], expectState: null }, // 不写保护事实（UNKNOWN 未闭环分支继续拦）
    { key: 'order1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":5,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, RELEASED_EVENT, { kind: 'recovery.protectionReleased', payload: { released: false, reason: 'release-denied-identity-missing', protectionRetained: true } }], expectState: 'retained' }, // 曾释放→更晚保留：顺序规则
    { key: 'corrupt1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":6,"inFlightReservedTurns":0}', events: [{ kind: 'recovery.reconciled', payload: 'not-json{' }], expectState: 'retained' }, // 证据损坏——不默认安全
  ];
  const list = defs.map((fixture) => {
    const ids = seedFixture(db, convId, fixture);
    const expectRecoverable = fixture.expectState !== 'retained' && !(fixture.turnStatus === 'UNKNOWN');
    const expectBlockSnippet = fixture.turnStatus === 'UNKNOWN'
      ? (fixture.budgetMark == null ? '预算未处置' : 'protection_state=retained')
      : 'protection_state=retained';
    return { ...ids, key: fixture.key, fixture: { ...fixture, expectRecoverable, expectBlockSnippet } };
  });
  const byKey: Record<string, { taskId: string; runId: string; turnId: string }> = {};
  for (const item of list) byKey[item.key] = { taskId: item.taskId, runId: item.runId, turnId: item.turnId };
  return { list, byKey };
}
