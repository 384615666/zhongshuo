/**
 * 同成员任务排队合同（R56 §3 起；r57 按 review-r56 §2 重写②）：
 *  ① 同 Agent、两个不同房间任务：忙时真实等待（admissionDeferred member 留证+回 pending+
 *     startTurn 恰 1）；释放后按合同继续（恰 2、不复活）。
 *  ② 「崩溃」重启后的**准入继承**（r57 核心）：新 worker 的 admission 内存为空，但
 *     UNKNOWN/retained/在途 turn 的占用是持久合同——dispatch.resume{confirm:true} 只确认调度，
 *     不是退出证明；同成员另一任务在旧 turn 未收口期间零新增 startTurn（文件库关闭重开与
 *     全新 worker 双重证明）；notStarted 对账后 FAILED+refunded 但 retained 期间继续占用；
 *     recovery.releaseProtection 正式解除（no-os-process 服务端证据）后排队项**恰一次**续跑。
 *     （r56 版②曾把「旧 UNKNOWN 未收口时另一任务成功派发」当正例——独立复核
 *     queue-retained-result.json 证伪，本文件按修复后合同重写；历史报告保留。）
 *  ④ 恢复读取失败防护（r58，review-r57 §2 独立反例）：占位 SELECT 失败或行级绑定读失败
 *     （部分恢复）都**拒绝启动**——不吞错按空账本放行；重试成功后占位继承、正式解除恰一次、
 *     预算/审计事实不被改写。
 *  ③ 同一 DM 连续消息：串行排队、恰一次派发/入库。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { applyRecovery } from '../../src/daemon/stopFlow.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-mq57-'));
mkdirSync(join(tmpRoot, 'app'), { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Row = Record<string, unknown>;
async function until<T>(probe: () => T, ok: (v: T) => boolean, ms: number, label: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（当前=${JSON.stringify(v)}）`);
    await sleep(60);
  }
}
function must<T>(v: T | undefined | null, label: string): T {
  if (v == null) throw new Error(`必然存在但缺失：${label}`);
  return v;
}

function makeEnv(opts: { fileDb?: string; scripts?: FakeTurnScript[]; adapter?: FakeRuntimeAdapter; releaseAdmission?: (turnId: string) => void } = {}) {
  const db: ZhongshuoDatabase = opts.fileDb != null ? openDatabase(opts.fileDb) : openDatabase(':memory:');
  const fresh = (db.prepare('SELECT count(*) c FROM projects').get() as { c: number }).c === 0;
  if (fresh) {
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
    db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  }
  // releaseAdmission=entry 同款进程内联动（对账/解除命令→worker 内存账本）；缺省不接
  //（r57 ②等用「新 worker 构造即恢复」路径证明，不依赖钩子）。
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app'), ...(opts.releaseAdmission != null ? { releaseAdmission: opts.releaseAdmission } : {}) };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `mq57-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(`${r.error?.code}: ${r.error?.message}`);
    return r.data as T;
  };
  /** 受控忙碌：nextScript 队列——测试逐 turn 指定（stall=受控忙碌；无脚本=立即完成）。 */
  // scripts/adapter 可由调用方注入（文件库重开时同一 adapter 才能连续计 startTurn）。
  const scripts: FakeTurnScript[] = opts.scripts ?? [];
  const adapter: FakeRuntimeAdapter = opts.adapter ?? new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? validDone() });
  /** 每个 worker() 都是新实例（独立 admission——重启后的 worker 由构造器按持久事实恢复占用）。 */
  const worker = () => new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: join(tmpRoot, 'app') });
  const submit = (body: string) =>
    cmd<{ taskId: string; threadId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body, intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
  const q1 = (sql: string, ...a: unknown[]): Row => must<Row>(db.prepare(sql).get(...a) as Row | undefined, sql);
  return {
    db, cmd, scripts, adapter, worker, submit,
    outbox: (key: string) => db.prepare('SELECT id, dispatch_key, status, attempt_epoch, turn_id FROM outbox WHERE dispatch_key = ?').get(key) as { id: number; dispatch_key: string; status: string; attempt_epoch: number; turn_id: string | null } | undefined,
    taskRuns: (taskId: string) => db.prepare('SELECT id, status FROM workflow_runs WHERE task_id = ?').all(taskId) as Array<{ id: string; status: string }>,
    taskTurns: (taskId: string) => db.prepare('SELECT t.id, t.status, t.dispatch_key FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?').all(taskId) as Array<{ id: string; status: string; dispatch_key: string }>,
    task: (taskId: string) => q1('SELECT id, status FROM tasks WHERE id = ?', taskId) as { id: string; status: string },
    turnRow: (turnId: string) => q1('SELECT id, status, protection_state, budget_mark FROM agent_turns WHERE id = ?', turnId) as { id: string; status: string; protection_state: string | null; budget_mark: string | null },
    events: (kind: string) => db.prepare('SELECT payload_json FROM domain_events WHERE kind = ? ORDER BY seq').all(kind) as Array<{ payload_json: string }>,
    count: (sql: string) => (db.prepare(sql).get() as { c: number }).c,
  };
}

describe('同成员任务排队合同（r57：准入继承+受控忙碌，不绕租约/恢复保护）', () => {
  it('① 同 Agent 两个房间任务：忙时真实等待（admissionDeferred 留证），释放后按合同继续', async () => {
    const env = makeEnv();
    const w = env.worker();
    env.scripts.push([{ kind: 'stall', ms: 600 }, ...validDone()]);
    const t1 = await env.submit('R57 排队·任务一（先占用成员）');
    void w.runOnce();
    await until(() => env.taskTurns(t1.taskId).length, (n) => n === 1, 8000, '任务一 turn 建立');
    const t2 = await env.submit('R57 排队·任务二（等待成员释放）');
    const key1 = `task:${t1.taskId}:initial`;
    const key2 = `task:${t2.taskId}:initial`;
    await w.runOnce();
    const deferred = env.events('run.admissionDeferred');
    const ob2 = env.outbox(key2);
    expect(deferred.length).toBe(1);
    expect(JSON.parse(must(deferred[0], 'admissionDeferred 事件').payload_json)).toMatchObject({ reason: 'member', dispatchKey: key2 });
    expect(ob2?.status).toBe('pending');
    expect(env.taskRuns(t2.taskId)).toHaveLength(0);
    expect(env.taskTurns(t2.taskId)).toHaveLength(0);
    expect(env.adapter.startTurnLog).toHaveLength(1);
    await until(() => env.task(t1.taskId).status, (s) => s === 'REVIEW' || s === 'DONE', 8000, '任务一终态');
    env.scripts.push(validDone());
    await w.runOnce();
    await until(() => env.task(t2.taskId).status, (s) => s === 'REVIEW' || s === 'DONE', 8000, '任务二终态（按合同继续）');
    expect(env.adapter.startTurnLog).toHaveLength(2);
    expect(env.outbox(key1)?.status).toBe('done');
    expect(env.outbox(key2)?.status).toBe('done');
    await w.runOnce();
    await w.runOnce();
    expect(env.adapter.startTurnLog).toHaveLength(2);
  }, 30_000);

  it('② 崩溃重启准入继承：UNKNOWN/retained 期间同成员零新增 startTurn（含文件库重开）；正式解除后恰一次', async () => {
    // 文件库（真实关闭/重开）。声明：fresh-worker+恢复库状态模拟，非 OS 级崩溃重启（后续批次补）。
    const fileDb = join(tmpRoot, 'mq57-file.sqlite');
    rmSync(fileDb, { force: true });
    // 共享 scripts/adapter：重开后同一 adapter 实例连续计 startTurn（进程内重开声明）。
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? validDone() });
    const openEnv = () => makeEnv({ fileDb, scripts, adapter });
    let env = openEnv();
    scripts.push([{ kind: 'stall', ms: 120_000 }, ...validDone()]); // 崩溃时在途（不等待完成）
    const t1 = await env.submit('R57 重启·任务一（崩溃时在途）');
    void env.worker().runOnce();
    await until(() => env.taskTurns(t1.taskId).length, (n) => n === 1, 8000, '任务一 turn 建立');
    const t2 = await env.submit('R57 重启·任务二（崩溃时排队）');
    const key2 = `task:${t2.taskId}:initial`;
    const turn1 = must(env.taskTurns(t1.taskId)[0], 'turn1');

    // 崩溃+重启（applyRecovery 同 entry 启动路径）：UNKNOWN+门禁；redispatch 在收口前拒绝。
    const snap = applyRecovery(env.db, Date.now());
    expect(snap.unknownTurns).toBeGreaterThanOrEqual(1);
    expect(env.turnRow(turn1.id).status).toBe('UNKNOWN');
    expect((env.db.prepare(`SELECT value FROM daemon_state WHERE key = 'dispatch_gate'`).get() as { value: string } | undefined)?.value).toBe('held');
    await expect(env.cmd('task.redispatch', { taskId: t1.taskId, reason: 'R57 测试：未收口旧意图不得复活' })).rejects.toThrow(/RECONCILE|UNKNOWN|保护|对账/);

    // 确认继续≠退出证明：门禁开放后，新 worker（空 admission 内存）必须从持久事实恢复占用
    //——同成员另一任务零新增 startTurn（r56 版此处曾成功派发=独立复核证伪的缺口）。
    await env.cmd('dispatch.resume', { confirm: true });
    await env.worker().runOnce();
    expect(must(env.outbox(key2), 'outbox key2').status).toBe('pending');
    const deferredAfterResume = env.events('run.admissionDeferred');
    expect(deferredAfterResume.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(must(deferredAfterResume[deferredAfterResume.length - 1], '最近一次 deferral').payload_json)).toMatchObject({ reason: 'member' });
    expect(env.adapter.startTurnLog).toHaveLength(1);

    // 文件库关闭重开 + 全新 worker（同进程内同一 adapter 实例——startTurnLog 连续计数）：
    // UNKNOWN 期间继续零新增。
    env.db.close();
    env = openEnv();
    expect(env.turnRow(turn1.id).status).toBe('UNKNOWN');
    await env.worker().runOnce();
    expect(must(env.outbox(key2), 'outbox key2 重开后').status).toBe('pending');
    expect(env.adapter.startTurnLog).toHaveLength(1);

    // notStarted 对账（人工分离）：FAILED+refunded 但 retained——占用继续（释放路径 retained 门控）。
    await env.cmd('recovery.reconcile', { turnId: turn1.id, verdict: 'notStarted', note: 'R57 测试人工分离：启动窗口外确认未启动', manualRiskAck: true });
    const afterReconcile = env.turnRow(turn1.id);
    expect(afterReconcile.status).toBe('FAILED');
    expect(afterReconcile.budget_mark).toBe('refunded');
    expect(afterReconcile.protection_state).toBe('retained');
    await env.worker().runOnce();
    expect(must(env.outbox(key2), 'outbox key2 retained 期间').status).toBe('pending');
    expect(env.adapter.startTurnLog).toHaveLength(1);

    // 正式解除（no-os-process 服务端证据）→ 排队项恰一次续跑；任务一不复活（其意图早已 done）。
    await env.cmd('recovery.releaseProtection', { turnId: turn1.id, note: 'R57 测试：no-os-process 程序事实解除' });
    expect(env.turnRow(turn1.id).protection_state).toBe('released');
    scripts.push(validDone());
    await env.worker().runOnce();
    await until(() => env.task(t2.taskId).status, (st) => st === 'REVIEW' || st === 'DONE', 8000, '任务二解除后续跑完成');
    expect(env.adapter.startTurnLog).toHaveLength(2);
    expect(env.taskRuns(t1.taskId)).toHaveLength(1);
    expect(env.turnRow(turn1.id).status).toBe('FAILED');
    await env.worker().runOnce();
    expect(env.adapter.startTurnLog).toHaveLength(2);
  }, 60_000);

  it('④ 恢复读取失败防护（r58）：SELECT 失败/部分恢复失败均拒绝启动不按空账本放行；重试成功后占位继承、正式解除恰一次、预算审计不改写', async () => {
    // 文件库（真实关闭/重开；Proxy 只注入指定 SELECT 的失败，其余 DB 操作原样——对应
    // review-r57 §2 独立反例的注入形态：仅占位恢复读失败一次，后续操作正常）。
    const fileDb = join(tmpRoot, 'mq58-restore.sqlite');
    rmSync(fileDb, { force: true });
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? validDone() });
    // entry 同款进程内联动占位：worker 构造后接 reconcileRelease（对账/解除命令→内存账本）。
    let releaseHook: (turnId: string) => void = () => {};
    const openEnv = () => makeEnv({ fileDb, scripts, adapter, releaseAdmission: (turnId) => releaseHook(turnId) });
    let env = openEnv();
    scripts.push([{ kind: 'stall', ms: 120_000 }, ...validDone()]);
    const t1 = await env.submit('R58 恢复失败·任务一（在途→UNKNOWN）');
    void env.worker().runOnce();
    await until(() => env.taskTurns(t1.taskId).length, (n) => n === 1, 8000, '任务一 turn 建立');
    const t2 = await env.submit('R58 恢复失败·任务二（排队）');
    const key2 = `task:${t2.taskId}:initial`;
    const turn1 = must(env.taskTurns(t1.taskId)[0], 'turn1');
    applyRecovery(env.db, Date.now());
    expect(env.turnRow(turn1.id).status).toBe('UNKNOWN');

    // 注入器：armed 时匹配 SQL 的 prepare 直接抛错（其余透传原库）。
    const arm = { sql: '', hits: 0 };
    const dbProxy = new Proxy(env.db, {
      get(target, prop, _receiver) {
        if (prop === 'prepare') {
          return (sql: string, ...rest: unknown[]) => {
            if (arm.sql !== '' && arm.hits > 0 && sql.includes(arm.sql)) {
              arm.hits -= 1;
              throw new Error(`R58 注入：恢复读失败（模拟瞬时库忙）SQL=${sql.slice(0, 40)}`);
            }
            return target.prepare(sql, ...(rest as []));
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as ZhongshuoDatabase;
    const mkWorker = () => new DispatchWorker({ db: dbProxy, adapter, leaseOwner: `w58-${randomUUID().slice(0, 4)}`, appDataDir: join(tmpRoot, 'app') });
    const factsSnapshot = () => ({
      turn1: env.turnRow(turn1.id),
      runs1: env.taskRuns(t1.taskId).length,
      turns2: env.taskTurns(t2.taskId).length,
      events: env.count('SELECT count(*) c FROM domain_events'),
    });
    const before = factsSnapshot();

    // 负例A（占位 SELECT 失败）：构造器抛错拒绝启动——不按空账本放行；库事实零变化。
    arm.sql = "t.status = 'UNKNOWN'";
    arm.hits = 1;
    expect(() => mkWorker()).toThrow(/准入占位恢复失败/);
    expect(factsSnapshot()).toEqual(before);

    // 负例B（部分恢复失败）：占位 SELECT 成功、行级成员绑定读失败——漏一行=漏一个占用，同样拒绝。
    arm.sql = 'FROM project_members pm';
    arm.hits = 1;
    expect(() => mkWorker()).toThrow(/准入占位恢复失败/);
    expect(factsSnapshot()).toEqual(before);
    arm.sql = '';

    // 正例：重试（新构造）成功 → 占位继承。确认继续≠退出证明：同成员任务二零新增 startTurn。
    const w = mkWorker();
    releaseHook = (turnId: string) => w.reconcileRelease(turnId);
    await env.cmd('dispatch.resume', { confirm: true });
    await w.runOnce();
    expect(must(env.outbox(key2), 'outbox key2').status).toBe('pending');
    const deferred = env.events('run.admissionDeferred');
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(must(deferred[deferred.length - 1], 'deferral').payload_json)).toMatchObject({ reason: 'member' });
    expect(adapter.startTurnLog).toHaveLength(1); // 只有崩溃前的任务一

    // 预算/审计不改写：对账（FAILED+refunded+retained——无租约 retained 仍占）后正式解除 → 排队项恰一次续跑；任务一不复活。
    await env.cmd('recovery.reconcile', { turnId: turn1.id, verdict: 'notStarted', note: 'R58 测试：启动窗口外确认未启动', manualRiskAck: true });
    expect(env.turnRow(turn1.id)).toMatchObject({ status: 'FAILED', budget_mark: 'refunded', protection_state: 'retained' });
    await w.runOnce(); // retained 期间继续零新增（无租约占用同守）
    expect(adapter.startTurnLog).toHaveLength(1);
    await env.cmd('recovery.releaseProtection', { turnId: turn1.id, note: 'R58 测试：no-os-process 程序事实解除' });
    expect(env.turnRow(turn1.id).protection_state).toBe('released');
    scripts.push(validDone());
    await w.runOnce();
    await until(() => env.task(t2.taskId).status, (st) => st === 'REVIEW' || st === 'DONE', 8000, '任务二解除后恰一次续跑');
    expect(adapter.startTurnLog).toHaveLength(2);
    expect(env.taskRuns(t1.taskId)).toHaveLength(1);
    expect(env.turnRow(turn1.id)).toMatchObject({ status: 'FAILED', budget_mark: 'refunded' });
    await w.runOnce();
    expect(adapter.startTurnLog).toHaveLength(2);
    env.db.close();
  }, 60_000);

  it('③ 同一 DM 连续消息：串行排队、恰一次派发（同成员合同在 DM 面同样成立）', async () => {
    const env = makeEnv();
    const dm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: 'R57 DM 串行' });
    const dmConvId = dm.conversationId;
    env.scripts.push([{ kind: 'stall', ms: 400 }, ...validDone()]);
    env.scripts.push(validDone());
    const send = (body: string) => env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dmConvId }, body, intent: 'default', mentions: [] });
    await send('R57 DM 第一条');
    void env.worker().runOnce();
    await send('R57 DM 第二条（排队）');
    await env.worker().runOnce();
    expect(env.adapter.startTurnLog).toHaveLength(1);
    await until(() => env.count(`SELECT count(*) c FROM agent_turns WHERE status = 'SUCCEEDED'`), (r) => r >= 1, 8000, '第一条完成');
    await env.worker().runOnce();
    await until(() => env.count(`SELECT count(*) c FROM agent_turns WHERE status = 'SUCCEEDED'`), (r) => r >= 2, 8000, '第二条完成');
    expect(env.adapter.startTurnLog).toHaveLength(2);
    expect(env.count(`SELECT count(*) c FROM messages WHERE conversation_id = '${dmConvId}' AND author_type = 'human'`)).toBe(2);
  }, 30_000);
});
