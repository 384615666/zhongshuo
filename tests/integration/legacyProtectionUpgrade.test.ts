/**
 * 第四十二轮 §3 + 第四十三轮 §4（review-r42）+ 第四十四轮 §1（review-r43 §3）：
 * 迁移 042/043/044——旧库「保护保留」事实回填、保守化修正与完整释放证据校验。
 *
 * - 042：按事件顺序回填（041 只加列不回填→旧 notStarted 人工退款形态放行的复核反例）。
 * - 043（review-r42 §4 纯函数反例）：042 宽松 released 判定修正——released:true 与
 *   protectionRetained:true 同体矛盾→retained；released:true 但证据不足（probe alive/
 *   unknown/identity-missing/exited、缺 probe）→retained（审计曾写释放≠当前合同的完整退出
 *   证明）；可信正例（managedEvidence 受管 Job 完整结束 / no-os-process 程序事实）不误拦；
 *   reconciled executed+exitFact='exited' 不追认为 released。已应用 042 的库由 043 只降级
 *   released→retained 修正（不动 retained/NULL/预算/审计；幂等）。
 * - 044（review-r43 §3 纯函数反例）：043 的 managedEvidence 只查非空对象、reason 兜底可覆盖
 *   已有相反 probe——空对象/数组/releasable:false/activeCount>0/缺字段/缺 managedJobId 的
 *   残缺证据都曾判 released。044 按真实 ReleaseEvidence 结构校验完整条件（四字段全成立+
 *   稳定身份），probe 存在时 reason 不覆盖；已应用 043 的库由 044 只降级修正。
 *
 * 覆盖：40→最新（042+043+044 链）、41→最新（先复现漏洞再收口）、42→最新（042 已误回填→
 * 043 修正）、43→最新（043 已按残缺证据放行→044 修正）、分类纯函数（保守化+完整证据全分支）。
 * fake/零真实模型调用（不启动 worker，只用命令面与守卫直读）。
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
import { classifyProtectionFactStrict } from '../../src/persistence/migrations/043-turn-protection-release-evidence.ts';
import { classifyProtectionFactComplete } from '../../src/persistence/migrations/044-turn-protection-evidence-complete.ts';
import { migration042 } from '../../src/persistence/migrations/042-turn-protection-state-backfill.ts';
import { migration043 } from '../../src/persistence/migrations/043-turn-protection-release-evidence.ts';
import { classifyProtectionFactFinal, migration045 } from '../../src/persistence/migrations/045-turn-probe-field-integrity.ts';
import { migration044 } from '../../src/persistence/migrations/044-turn-protection-evidence-complete.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-r43upg-'));
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
/** 可靠释放（no-os-process 程序事实——releaseProtection emit 包装必附 probe 记录）。 */
const RELEASED_NO_OS_EVENT: EvSpec = {
  kind: 'recovery.protectionReleased',
  payload: { released: true, releasedLeases: [], reason: 'protection-released-no-os-process', manualNote: 'none 模型程序事实解除', probe: { probeId: 'probe_seed', turnId: 't', registryId: 1, processModel: 'none', pid: null, observedAt: 0, result: 'no-os-process', startedAtMs: null, reuseCheck: null, detail: 'fake：无子进程模型' } },
};
/** 可靠释放（受管 Job 完整结束证据——ReleaseEvidence 全字段+稳定身份；probe 观察为 unknown 也不拦：证据层级以 managedEvidence 为准）。 */
const RELEASED_MANAGED_EVENT: EvSpec = {
  kind: 'recovery.protectionReleased',
  payload: { released: true, releasedLeases: [], reason: 'protection-released-managed-job-evidence', managedJobId: 'job_seed', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: '根进程已退出、本模块句柄已关闭、job 活跃计数 0——受管执行完整结束' }, probe: { probeId: 'probe_m', result: 'unknown', detail: '受管 job 根已退出且活跃计数 0（观察）' } },
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
  const r = await dispatchDaemonCommand({ db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir }, { protocolVersion: 1, commandId: `r43-${randomUUID().slice(0, 8)}`, method, params }) as unknown as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!r.ok) throw new Error(`${r.error?.code ?? ''}: ${r.error?.message ?? 'failed'}`);
  return r.data as T;
};
const cmdRawOn = (db: ZhongshuoDatabase, appDir: string) => async (method: string, params: unknown) =>
  await dispatchDaemonCommand({ db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir }, { protocolVersion: 1, commandId: `r43-${randomUUID().slice(0, 8)}`, method, params }) as unknown as { ok: boolean; data?: never; error?: { code: string; message: string } };

const protectionStateOf = (db: ZhongshuoDatabase, turnId: string): string | null =>
  (db.prepare('SELECT protection_state p FROM agent_turns WHERE id = ?').get(turnId) as { p: string | null }).p;

describe('第四十三轮 §4：保守分类纯函数（classifyProtectionFactStrict）', () => {
  it('矛盾→retained；可信正例（managed/no-os-process）→released；exited/alive/缺证据→retained', () => {
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, protectionRetained: true }))).toBe('retained'); // review-r42 反例①：同体矛盾
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'alive' } }))).toBe('retained'); // 反例②：证据不足
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'exited' } }))).toBe('retained'); // 历史观察不追认
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'unknown' } }))).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'identity-missing' } }))).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true }))).toBe('retained'); // 缺 probe/证据
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process' }))).toBe('released'); // 旧版无 probe 字段：服务端生成 reason 串
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'no-os-process' } }))).toBe('released'); // 正例②
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, managedEvidence: { releasable: true }, probe: { result: 'unknown' } }))).toBe('released'); // 正例①：受管证据优先于 probe 观察
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: true, managedEvidence: { releasable: true }, protectionRetained: true }))).toBe('retained'); // 矛盾仍最高优先
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ released: false, protectionRetained: true }))).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.protectionReleased', JSON.stringify({ reason: 'x' }))).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.protectionReleased', 'corrupt')).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.reconciled', JSON.stringify({ verdict: 'executed', exitFact: 'exited', releasedLeases: ['d:1'] }))).toBe('retained'); // 不追认（042 曾判 released）
    expect(classifyProtectionFactStrict('recovery.reconciled', JSON.stringify({ verdict: 'executed', exitFact: 'no-os-process' }))).toBe('released'); // 正例不误拦
    expect(classifyProtectionFactStrict('recovery.reconciled', JSON.stringify({ verdict: 'executed', protectionRetained: true, exitFact: 'alive' }))).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.reconciled', JSON.stringify({ verdict: 'notStarted', recordedAs: 'manual-claim', protectionRetained: true }))).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.reconciled', JSON.stringify({ verdict: 'keepUnknown' }))).toBe(null);
    expect(classifyProtectionFactStrict('recovery.reconciled', JSON.stringify({ verdict: 'executed' }))).toBe('retained');
    expect(classifyProtectionFactStrict('recovery.reconciled', 'not-json{')).toBe('retained');
    expect(classifyProtectionFactStrict('task.review', JSON.stringify({}))).toBe(null);
  });
});

describe('第四十四轮 §1：完整证据分类纯函数（classifyProtectionFactComplete）', () => {
  it('残缺/否定 managedEvidence→retained；完整 Job 证据（含 probe alive）优先放行；reason 不覆盖已有相反 probe', () => {
    // review-r43 §3 反例组：043 曾全部误判 released。
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedEvidence: {}, managedJobId: 'job_x' }))).toBe('retained'); // 空对象
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedEvidence: [], managedJobId: 'job_x' }))).toBe('retained'); // 数组
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: 'job_x', managedEvidence: { releasable: false, rootExited: true, handlesReleased: true, activeCount: 0, reason: 'x' } }))).toBe('retained'); // 明确否定
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: 'job_x', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 2, reason: 'job 内仍有 2 个活跃进程' } }))).toBe('retained'); // 活跃计数>0
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: 'job_x', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: null, reason: '查询失败' } }))).toBe('retained'); // 计数未知≠0
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: '', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: 'x' } }))).toBe('retained'); // 稳定身份为空串
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: 'x' } }))).toBe('retained'); // 同上（无 managedJobId 字段）
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedEvidence: 'complete', managedJobId: 'job_x' }))).toBe('retained'); // 非对象
    // reason 兜底不覆盖已有相反 probe（review-r43 §3 反例④）。
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: { result: 'alive' } }))).toBe('retained');
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: { result: 'unknown' } }))).toBe('retained');
    // 可信正例①：完整 Job 证据优先于落后的普通进程观察（alive probe 不否决完整 Job）。
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: 'job_ok', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: '受管执行完整结束' }, probe: { result: 'alive', detail: '普通进程扫描滞后观察' } }))).toBe('released');
    // 可信正例②：probe 事实与缺 probe 的受控 reason 兼容通道。
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'no-os-process' } }))).toBe('released');
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process' }))).toBe('released'); // 旧事件缺 probe
    // 矛盾/损坏/其余证据不足与 043 同判（只收紧 managedEvidence/reason 两分支）。
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, protectionRetained: true, managedJobId: 'job_x', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: 'x' } }))).toBe('retained'); // 矛盾仍最高优先
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: false }))).toBe('retained');
    expect(classifyProtectionFactComplete('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'exited' } }))).toBe('retained');
    expect(classifyProtectionFactComplete('recovery.protectionReleased', 'corrupt')).toBe('retained');
    expect(classifyProtectionFactComplete('recovery.reconciled', JSON.stringify({ verdict: 'executed', exitFact: 'no-os-process' }))).toBe('released');
    expect(classifyProtectionFactComplete('recovery.reconciled', JSON.stringify({ verdict: 'executed', exitFact: 'exited' }))).toBe('retained');
    expect(classifyProtectionFactComplete('recovery.reconciled', JSON.stringify({ verdict: 'keepUnknown' }))).toBe(null);
    expect(classifyProtectionFactComplete('task.review', JSON.stringify({}))).toBe(null);
  });
});

describe('第四十五轮 §2：最终分类纯函数（classifyProtectionFactFinal）——probe 缺字段与结构损坏分离', () => {
  it('probe 字段在但损坏（null/数组/false/字符串）→retained；真缺字段才 reason 兜底；完好 probe 按判定；完整 Job 仍优先', () => {
    // review-r44 §2 反例组：044 曾把「字段损坏」折叠成「缺字段」→ reason 兜底误放行。
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: null }))).toBe('retained');
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: [] }))).toBe('retained');
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: false }))).toBe('retained');
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: 'broken' }))).toBe('retained');
    // 完好对象 probe 的 result 非字符串等形态：不等于 no-os-process——保守 retained。
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 1 } }))).toBe('retained');
    // 真正缺 probe 字段：受控旧兼容正例保留。
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process' }))).toBe('released');
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, probe: { result: 'no-os-process' } }))).toBe('released');
    // 完整 Job 证据优先于任何 probe 观察（含损坏 probe）。
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: 'job_ok', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: '受管执行完整结束' }, probe: null }))).toBe('released');
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: 'job_ok', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: 'x' }, probe: { result: 'alive' } }))).toBe('released');
    // reason 兜底不覆盖已有（完好）相反 probe——044 已收紧，最终版维持。
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: { result: 'alive' } }))).toBe('retained');
    // 残缺 Job 证据/矛盾/损坏 JSON/reconciled 分支与 044 同判。
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, managedJobId: 'job_x', managedEvidence: {}, probe: null }))).toBe('retained');
    expect(classifyProtectionFactFinal('recovery.protectionReleased', JSON.stringify({ released: true, protectionRetained: true, managedJobId: 'job_x', managedEvidence: { releasable: true, rootExited: true, handlesReleased: true, activeCount: 0, reason: 'x' } }))).toBe('retained');
    expect(classifyProtectionFactFinal('recovery.protectionReleased', 'corrupt')).toBe('retained');
    expect(classifyProtectionFactFinal('recovery.reconciled', JSON.stringify({ verdict: 'executed', exitFact: 'no-os-process' }))).toBe('released');
    expect(classifyProtectionFactFinal('recovery.reconciled', JSON.stringify({ verdict: 'keepUnknown' }))).toBe(null);
    expect(classifyProtectionFactFinal('task.review', JSON.stringify({}))).toBe(null);
  });
});

/** 40→最新的形态矩阵（expectRecoverable/expectBlockSnippet 由 expectState 推导）。 */
function seedAll(db: ZhongshuoDatabase, convId: string): { list: Array<{ key: string; taskId: string; runId: string; turnId: string; fixture: Fixture & { expectRecoverable: boolean; expectBlockSnippet?: string } }>; byKey: Record<string, { taskId: string; runId: string; turnId: string }> } {
  const defs: Array<Fixture> = [
    { key: 'keep1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT], expectState: 'retained' }, // 复核反例本体：无租约人工退款
    { key: 'rel1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, RELEASED_NO_OS_EVENT], expectState: 'released' }, // 可靠释放（no-os-process probe）——不误拦
    { key: 'managed1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":2,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, RELEASED_MANAGED_EVENT], expectState: 'released' }, // 可靠释放（受管 Job 完整证据）——不误拦
    { key: 'plain1', turnStatus: 'FAILED', budgetMark: 'settled', budgetJson: '{"usedTurns":3,"inFlightReservedTurns":0}', events: [], expectState: null }, // 普通失败——不误标
    { key: 'exec1', turnStatus: 'UNKNOWN', budgetMark: 'settled', budgetJson: '{"usedTurns":4,"inFlightReservedTurns":0}', events: [{ kind: 'recovery.reconciled', payload: { verdict: 'executed', exitFact: 'identity-missing', protectionRetained: true, reason: 'executed-exit-identity-missing-protection-retained' } }], expectState: 'retained' }, // executed 取证未确认
    { key: 'exited1', turnStatus: 'FAILED', budgetMark: 'settled', budgetJson: '{"usedTurns":5,"inFlightReservedTurns":0}', events: [{ kind: 'recovery.reconciled', payload: { verdict: 'executed', exitFact: 'exited', releasedLeases: ['d:old'], turnFinalStatus: 'FAILED', reason: 'executed-exit-confirmed' } }], expectState: 'retained' }, // 第四十三轮：历史 exited 观察不追认（042 曾判 released——043 修正）
    { key: 'keepu1', turnStatus: 'UNKNOWN', budgetMark: null, budgetJson: '{"usedTurns":6,"inFlightReservedTurns":1}', events: [{ kind: 'recovery.reconciled', payload: { verdict: 'keepUnknown', note: '维持不确定' } }], expectState: null }, // 不写保护事实（UNKNOWN 未闭环分支继续拦）
    { key: 'order1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":7,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, RELEASED_NO_OS_EVENT, { kind: 'recovery.protectionReleased', payload: { released: false, reason: 'release-denied-identity-missing', protectionRetained: true } }], expectState: 'retained' }, // 曾释放→更晚保留：顺序规则
    { key: 'contra1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":8,"inFlightReservedTurns":0}', events: [{ kind: 'recovery.protectionReleased', payload: { released: true, protectionRetained: true, reason: 'conflicting-legacy-write' } }], expectState: 'retained' }, // review-r42 反例①：同体矛盾
    { key: 'alive1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":9,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, reason: 'protection-released-alive', probe: { probeId: 'p_a', result: 'alive', detail: '受管 job 根进程仍存活' } } }], expectState: 'retained' }, // review-r42 反例②：released:true 但 probe alive
    { key: 'badmev1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":11,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, releasedLeases: [], reason: 'protection-released-managed-job-evidence', managedJobId: 'job_bad', managedEvidence: {}, probe: { probeId: 'p_m', result: 'unknown', detail: '残缺对象' } } }], expectState: 'retained' }, // review-r43 §3 反例：残缺 managedEvidence（042/043 曾判 released——044 修正）
    { key: 'reasonover1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":12,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, reason: 'protection-released-no-os-process', probe: { probeId: 'p_r', result: 'alive', detail: 'reason 覆盖相反 probe' } } }], expectState: 'retained' }, // review-r43 §3 反例：reason 覆盖已有 alive probe（042/043 曾判 released——044 修正）
    { key: 'corruptprobe1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":13,"inFlightReservedTurns":0}', events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, releasedLeases: [], reason: 'protection-released-no-os-process', probe: null } }], expectState: 'retained' }, // review-r44 §2 反例：probe 字段在但损坏（044 曾折叠成缺字段放行——045 修正）
    { key: 'corrupt1', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":10,"inFlightReservedTurns":0}', events: [{ kind: 'recovery.reconciled', payload: 'not-json{' }], expectState: 'retained' }, // 证据损坏——不默认安全
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

describe('第四十三/四十四轮：40→最新（文件库）——回填/修正/呈现/准入/恢复中心/重开同判', () => {
  it('旧保留项（含矛盾/exited/alive/残缺证据形态）回填 retained 且零新派发；可靠释放/普通失败不误拦；数据预算审计不丢；幂等', async () => {
    const dbPath = join(tmpRoot, 'upg40', 'state.sqlite');
    mkdirSync(join(tmpRoot, 'upg40'), { recursive: true });
    const db = openAtVersion(dbPath, 40);
    seedBase(db, 'convUpg40');
    const fx = seedAll(db, 'convUpg40');
    const before = snapshot(db);
    expect(db.pragma('user_version', { simple: true })).toBe(40);

    const res = migrate(db);
    expect(res.fromVersion).toBe(40);
    expect(res.applied).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49]); // 46=R65 projects.description；47=R66 navigation.pinned；48=R67 member.description（加性列，不影响保护状态判定）
    expect(db.pragma('user_version', { simple: true })).toBe(49);

    // ① 回填结果：事件顺序+保守分类推导的每 turn 最新保护事实。
    for (const f of fx.list) expect(protectionStateOf(db, f.turnId), f.fixture.key).toBe(f.fixture.expectState);
    // ② 数据/预算/审计不丢（迁移只写 protection_state）。
    const after = snapshot(db);
    expect(after.events).toBe(before.events);
    expect(after.eventDigest).toBe(before.eventDigest);
    expect(after.turns).toBe(before.turns);
    expect(after.budgets).toBe(before.budgets);
    // ③ 呈现（conversation.list 与守卫同源）：保留项不可恢复+人话原因；释放/普通项可恢复。
    const cmd = cmdOn(db, join(tmpRoot, 'upg40', 'app'));
    const list = await cmd<{ conversations: Array<{ conversationId: string; interruptedTasks: TaskRow[] }> }>('conversation.list', {});
    const byTask = new Map<string, TaskRow>(list.conversations.find((c) => c.conversationId === 'convUpg40')!.interruptedTasks.map((t) => [t.taskId, t] as [string, TaskRow]));
    expect(byTask.size).toBe(fx.list.length);
    for (const f of fx.list) {
      const row = byTask.get(f.taskId)!;
      expect(row.recoverable, f.fixture.key).toBe(f.fixture.expectRecoverable);
      if (!f.fixture.expectRecoverable) {
        expect(row.blockReason, f.fixture.key).toContain(f.fixture.expectBlockSnippet!);
      }
    }
    // ④ 准入：旧保留项（含第四十三/四十四/四十五轮新增形态）redispatch 拒绝且零新增派发行。
    const cmdRaw = cmdRawOn(db, join(tmpRoot, 'upg40', 'app'));
    for (const key of ['keep1', 'exec1', 'exited1', 'order1', 'contra1', 'alive1', 'corrupt1', 'badmev1', 'reasonover1', 'corruptprobe1']) {
      const rej = await cmdRaw('task.redispatch', { taskId: fx.byKey[key]!.taskId, reason: 'x' });
      expect(rej.ok, key).toBe(false);
      expect(rej.error?.code, key).toBe('RECONCILE_REQUIRED');
    }
    expect((db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:*:redispatch*'").get() as { c: number }).c).toBe(0);
    // ⑤ 恢复中心：保留项可见（无租约 leaseCount=0）；释放/普通项不在列。
    const status = await cmd<{ pendingRelease: PendingRow[] }>('recovery.status', {});
    const pend = new Map<string, PendingRow>(status.pendingRelease.map((r) => [r.turnId, r] as [string, PendingRow]));
    expect(pend.get(fx.byKey.keep1!.turnId)!.leaseCount).toBe(0);
    for (const key of ['exec1', 'exited1', 'order1', 'contra1', 'alive1', 'corrupt1', 'badmev1', 'reasonover1', 'corruptprobe1']) expect(pend.has(fx.byKey[key]!.turnId), key).toBe(true);
    expect(pend.has(fx.byKey.rel1!.turnId)).toBe(false);
    expect(pend.has(fx.byKey.managed1!.turnId)).toBe(false);
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

describe('第四十三轮 §4：41→最新（内存库）——先复现漏洞，升级后同 row 收口', () => {
  it('041 已应用但未回填：升级前放行（复核反例复现）→ 042+043 回填 retained → 呈现/准入/解除全部收口', async () => {
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
    // 清掉漏洞期派发行，恢复升级前形态（其后由 042+043 收口重验零新派发）。
    db.prepare(`DELETE FROM outbox WHERE dispatch_key GLOB 'task:${keep.taskId}:redispatch*'`).run();

    const res = migrate(db);
    expect(res.applied).toEqual([42, 43, 44, 45, 46, 47, 48, 49]);
    // 收口：retained 回填 → 呈现不可恢复、准入拒绝且零新派发、恢复中心可见。
    expect(protectionStateOf(db, keep.turnId)).toBe('retained');
    const cmd = cmdOn(db, join(tmpRoot, 'upg41', 'app'));
    const list = await cmd<{ conversations: Array<{ conversationId: string; interruptedTasks: TaskRow[] }> }>('conversation.list', {});
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

describe('第四十三轮 §4：42→最新——042 已按宽松判定误回填的库由 043 只降级修正', () => {
  it('042 后 exited/矛盾/alive 误写 released → 043 降级 retained；可靠释放行不动；预算审计不变；幂等；守卫重新拦截', async () => {
    const db = openAtVersion(':memory:', 42);
    seedBase(db, 'convUpg42');
    const exited = seedFixture(db, 'convUpg42', {
      key: 'exited', turnStatus: 'FAILED', budgetMark: 'settled', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}',
      events: [{ kind: 'recovery.reconciled', payload: { verdict: 'executed', exitFact: 'exited', releasedLeases: ['d:old'], turnFinalStatus: 'FAILED', reason: 'executed-exit-confirmed' } }], expectState: 'retained',
    });
    const contra = seedFixture(db, 'convUpg42', {
      key: 'contra', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":2,"inFlightReservedTurns":0}',
      events: [{ kind: 'recovery.protectionReleased', payload: { released: true, protectionRetained: true } }], expectState: 'retained',
    });
    const alive = seedFixture(db, 'convUpg42', {
      key: 'alive', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":3,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, probe: { result: 'alive' } } }], expectState: 'retained',
    });
    const good = seedFixture(db, 'convUpg42', {
      key: 'good', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":4,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, RELEASED_NO_OS_EVENT], expectState: 'released',
    });
    const goodMev = seedFixture(db, 'convUpg42', {
      key: 'goodmev', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":5,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, RELEASED_MANAGED_EVENT], expectState: 'released',
    });
    // 模拟「042 已应用且按宽松判定回填」的历史状态：直接执行 042 的 up（同一代码路径）。
    migration042.up(db);
    expect(protectionStateOf(db, exited.turnId)).toBe('released'); // 042 宽松判定（误）
    expect(protectionStateOf(db, contra.turnId)).toBe('released'); // 反例①（误）
    expect(protectionStateOf(db, alive.turnId)).toBe('released'); // 反例②（误）
    expect(protectionStateOf(db, good.turnId)).toBe('released'); // 正例（042/043/044 同判）
    expect(protectionStateOf(db, goodMev.turnId)).toBe('released'); // 正例（完整受管证据同判）
    const before = snapshot(db);

    const res = migrate(db);
    expect(res.applied).toEqual([43, 44, 45, 46, 47, 48, 49]);
    // 只降级修正：误回填行→retained；可靠释放行保持 released；预算/审计逐字节不变。
    expect(protectionStateOf(db, exited.turnId)).toBe('retained');
    expect(protectionStateOf(db, contra.turnId)).toBe('retained');
    expect(protectionStateOf(db, alive.turnId)).toBe('retained');
    expect(protectionStateOf(db, good.turnId)).toBe('released');
    expect(protectionStateOf(db, goodMev.turnId)).toBe('released');
    const after = snapshot(db);
    expect(after.eventDigest).toBe(before.eventDigest);
    expect(after.budgets).toBe(before.budgets);
    // 误回填修正后在守卫/呈现面重新拦截（升级前该库处于放行状态）。
    expect(assessTaskRedispatchReadiness(db, exited.taskId)?.fact.kind).toBe('protection-retained');
    const cmdRaw = cmdRawOn(db, join(tmpRoot, 'upg42', 'app'));
    const rej = await cmdRaw('task.redispatch', { taskId: exited.taskId, reason: 'x' });
    expect(rej.ok).toBe(false);
    expect(rej.error?.code).toBe('RECONCILE_REQUIRED');
    // 可靠释放行不误拦。
    const ok2 = await cmdRaw('task.redispatch', { taskId: good.taskId, reason: 'x' });
    expect(ok2.ok).toBe(true);
    // 幂等：重跑 043 无变化。
    const again = migrate(db);
    expect(again.applied).toEqual([]);
    expect(protectionStateOf(db, exited.turnId)).toBe('retained');
    expect(protectionStateOf(db, good.turnId)).toBe('released');
    db.close();
  }, 60_000);
});

describe('第四十四轮 §1：43→最新（文件库）——043 已按残缺证据放行的库由 044 只降级修正', () => {
  it('残缺 managedEvidence/reason 覆盖 probe 曾写 released → 044 降级 retained；完整证据正例不动；预算审计不变；幂等；重开同判', async () => {
    const dbPath = join(tmpRoot, 'upg43', 'state.sqlite');
    mkdirSync(join(tmpRoot, 'upg43'), { recursive: true });
    const db = openAtVersion(dbPath, 43);
    seedBase(db, 'convUpg43');
    const badmev = seedFixture(db, 'convUpg43', {
      key: 'badmev', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, releasedLeases: [], reason: 'protection-released-managed-job-evidence', managedJobId: 'job_bad', managedEvidence: {}, probe: { probeId: 'p_m', result: 'unknown' } } }], expectState: 'retained',
    });
    const reasonover = seedFixture(db, 'convUpg43', {
      key: 'reasonover', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":2,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, reason: 'protection-released-no-os-process', probe: { probeId: 'p_r', result: 'alive', detail: 'reason 覆盖相反 probe' } } }], expectState: 'retained',
    });
    const mevFalse = seedFixture(db, 'convUpg43', {
      key: 'mevfalse', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":3,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, reason: 'protection-released-managed-job-evidence', managedJobId: 'job_f', managedEvidence: { releasable: false, rootExited: false, handlesReleased: false, activeCount: 2, reason: 'job 内仍有 2 个活跃进程' }, probe: { probeId: 'p_f', result: 'unknown' } } }], expectState: 'retained',
    });
    const goodMev = seedFixture(db, 'convUpg43', {
      key: 'goodmev', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":4,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, RELEASED_MANAGED_EVENT], expectState: 'released',
    });
    const goodNoOs = seedFixture(db, 'convUpg43', {
      key: 'goodnoos', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":5,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, RELEASED_NO_OS_EVENT], expectState: 'released',
    });
    // 模拟「已应用 043 的库」：042 宽松回填把上述行全部写 released，随后 043 的 up（同一代码
    // 路径）只降级其保守分类判 retained 的行——残缺证据两分支在 043 下仍判 released（复核反例）。
    migration042.up(db);
    migration043.up(db);
    expect(protectionStateOf(db, badmev.turnId)).toBe('released'); // 043 未修正（缺口本体）
    expect(protectionStateOf(db, reasonover.turnId)).toBe('released'); // 043 未修正（缺口本体）
    expect(protectionStateOf(db, mevFalse.turnId)).toBe('released'); // 043 未修正（缺口本体）
    expect(protectionStateOf(db, goodMev.turnId)).toBe('released'); // 正例（043/044 同判）
    expect(protectionStateOf(db, goodNoOs.turnId)).toBe('released'); // 正例（043/044 同判）
    const before = snapshot(db);

    const res = migrate(db);
    expect(res.applied).toEqual([44, 45, 46, 47, 48, 49]);
    expect(db.pragma('user_version', { simple: true })).toBe(49);
    // 只降级修正：残缺证据行→retained；完整正例不动；预算/审计逐字节不变。
    expect(protectionStateOf(db, badmev.turnId)).toBe('retained');
    expect(protectionStateOf(db, reasonover.turnId)).toBe('retained');
    expect(protectionStateOf(db, mevFalse.turnId)).toBe('retained');
    expect(protectionStateOf(db, goodMev.turnId)).toBe('released');
    expect(protectionStateOf(db, goodNoOs.turnId)).toBe('released');
    const after = snapshot(db);
    expect(after.events).toBe(before.events);
    expect(after.eventDigest).toBe(before.eventDigest);
    expect(after.turns).toBe(before.turns);
    expect(after.budgets).toBe(before.budgets);
    // 修正后守卫重新拦截（升级前该库对残缺证据行处于放行状态）；正例不误拦。
    expect(assessTaskRedispatchReadiness(db, badmev.taskId)?.fact.kind).toBe('protection-retained');
    expect(assessTaskRedispatchReadiness(db, goodMev.taskId)).toBe(null);
    const cmdRaw = cmdRawOn(db, join(tmpRoot, 'upg43', 'app'));
    for (const t of [badmev, reasonover, mevFalse]) {
      const rej = await cmdRaw('task.redispatch', { taskId: t.taskId, reason: 'x' });
      expect(rej.ok).toBe(false);
      expect(rej.error?.code).toBe('RECONCILE_REQUIRED');
    }
    const okNoOs = await cmdRaw('task.redispatch', { taskId: goodNoOs.taskId, reason: 'x' });
    expect(okNoOs.ok).toBe(true);
    // 幂等：重跑无动作。
    const again = migrate(db);
    expect(again.applied).toEqual([]);
    db.close();
    // 文件库重开同判：残缺证据行跨进程仍拦、正例仍放行。
    const db2 = openDatabase(dbPath);
    expect(protectionStateOf(db2, badmev.turnId)).toBe('retained');
    expect(protectionStateOf(db2, reasonover.turnId)).toBe('retained');
    expect(protectionStateOf(db2, goodMev.turnId)).toBe('released');
    expect(assessTaskRedispatchReadiness(db2, badmev.taskId)?.fact.kind).toBe('protection-retained');
    db2.close();
  }, 120_000);
});

describe('第四十五轮 §2：44→最新（文件库）——044 已按「损坏 probe+reason 兜底」放行的库由 045 只降级修正', () => {
  it('probe 字段在但损坏（null/数组）曾写 released → 045 降级 retained；真缺字段正例/完整 Job/完好 no-os probe 不动；预算审计不变；幂等；重开同判', async () => {
    const dbPath = join(tmpRoot, 'upg44', 'state.sqlite');
    mkdirSync(join(tmpRoot, 'upg44'), { recursive: true });
    const db = openAtVersion(dbPath, 44);
    seedBase(db, 'convUpg44');
    const corruptNull = seedFixture(db, 'convUpg44', {
      key: 'corruptnull', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":1,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, releasedLeases: [], reason: 'protection-released-no-os-process', probe: null } }], expectState: 'retained',
    });
    const corruptArr = seedFixture(db, 'convUpg44', {
      key: 'corruptarr', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":2,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, reason: 'protection-released-no-os-process', probe: [] } }], expectState: 'retained',
    });
    const legacyNoProbe = seedFixture(db, 'convUpg44', {
      key: 'legacynoprobe', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":3,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, { kind: 'recovery.protectionReleased', payload: { released: true, reason: 'protection-released-no-os-process' } }], expectState: 'released', // 真缺 probe 字段——受控旧兼容正例
    });
    const goodMev = seedFixture(db, 'convUpg44', {
      key: 'goodmev', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":4,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, RELEASED_MANAGED_EVENT], expectState: 'released',
    });
    const goodNoOs = seedFixture(db, 'convUpg44', {
      key: 'goodnoos', turnStatus: 'FAILED', budgetMark: 'refunded', budgetJson: '{"usedTurns":5,"inFlightReservedTurns":0}',
      events: [NOT_STARTED_AUDIT, RELEASED_NO_OS_EVENT], expectState: 'released',
    });
    // 模拟「已应用 044 的库」：042 宽松回填全写 released，043/044 的 up（同一代码路径）对
    // 「损坏 probe」行未降级——复核反例复现（probe 归一化把损坏折叠成缺字段→reason 兜底）。
    migration042.up(db);
    migration043.up(db);
    migration044.up(db);
    expect(protectionStateOf(db, corruptNull.turnId)).toBe('released'); // 044 未修正（缺口本体）
    expect(protectionStateOf(db, corruptArr.turnId)).toBe('released'); // 044 未修正（缺口本体）
    expect(protectionStateOf(db, legacyNoProbe.turnId)).toBe('released'); // 正例（044/045 同判）
    expect(protectionStateOf(db, goodMev.turnId)).toBe('released');
    expect(protectionStateOf(db, goodNoOs.turnId)).toBe('released');
    const before = snapshot(db);

    const res = migrate(db);
    expect(res.applied).toEqual([45, 46, 47, 48, 49]);
    expect(db.pragma('user_version', { simple: true })).toBe(49);
    // 只降级修正：损坏 probe 行→retained；三类正例不动；预算/审计逐字节不变。
    expect(protectionStateOf(db, corruptNull.turnId)).toBe('retained');
    expect(protectionStateOf(db, corruptArr.turnId)).toBe('retained');
    expect(protectionStateOf(db, legacyNoProbe.turnId)).toBe('released');
    expect(protectionStateOf(db, goodMev.turnId)).toBe('released');
    expect(protectionStateOf(db, goodNoOs.turnId)).toBe('released');
    const after = snapshot(db);
    expect(after.events).toBe(before.events);
    expect(after.eventDigest).toBe(before.eventDigest);
    expect(after.turns).toBe(before.turns);
    expect(after.budgets).toBe(before.budgets);
    // 修正后守卫重新拦截；正例不误拦。
    expect(assessTaskRedispatchReadiness(db, corruptNull.taskId)?.fact.kind).toBe('protection-retained');
    expect(assessTaskRedispatchReadiness(db, legacyNoProbe.taskId)).toBe(null);
    const cmdRaw = cmdRawOn(db, join(tmpRoot, 'upg44', 'app'));
    for (const t of [corruptNull, corruptArr]) {
      const rej = await cmdRaw('task.redispatch', { taskId: t.taskId, reason: 'x' });
      expect(rej.ok).toBe(false);
      expect(rej.error?.code).toBe('RECONCILE_REQUIRED');
    }
    const okLegacy = await cmdRaw('task.redispatch', { taskId: legacyNoProbe.taskId, reason: 'x' });
    expect(okLegacy.ok).toBe(true);
    // 幂等：重跑无动作。
    const again = migrate(db);
    expect(again.applied).toEqual([]);
    db.close();
    // 文件库重开同判。
    const db2 = openDatabase(dbPath);
    expect(protectionStateOf(db2, corruptNull.turnId)).toBe('retained');
    expect(protectionStateOf(db2, legacyNoProbe.turnId)).toBe('released');
    expect(assessTaskRedispatchReadiness(db2, corruptArr.taskId)?.fact.kind).toBe('protection-retained');
    db2.close();
  }, 120_000);
});
