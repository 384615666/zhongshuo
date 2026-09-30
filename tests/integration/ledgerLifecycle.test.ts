/**
 * 第十八轮二：wrapRealCallLedger 生命周期透传——正式链 entry→registry→包装器→adapter。
 * 回归背景：包装对象缺 dispose/disposeAll/closeAllSessions，注册表停机会把真实 adapter 误判
 * no-dispose-needed（收拢退化为受管 job 兜底）。本组用本地协议进程（node -e 子进程，零真实
 * 模型调用）经正式注入点 testAdapterFactories（仍过 wrapRealCallLedger——与生产同链）验证：
 * 正常关闭/在途停止/启动失败/清理超时（先 incomplete 后 force 收口）/shared+多成员/
 * 受管与未受管两路径；断言底层清理被调用、结果上报准确（含退出确认与收拢超时合成项）、
 * 关库后无后台写入（事件流收敛）。
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/entry.ts';
import type { RunningDaemon } from '../../src/daemon/entry.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { LocalProtocolAdapter, type MinimalProcess } from '../helpers/localProtocolAdapter.ts';
import { managedJobsCount, spawnManagedBridge } from '../../src/daemon/managed/bridge.ts';
import type { MemberAdapterFactory } from '../../src/daemon/memberRuntime.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD; // 生产形态（防护关闭——生命周期测试非防护场景）
delete process.env.ZS_REAL_BATCH_ID;       // 记账不设批次上限（三的配额单测另测）

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-ledger-life-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄释放延迟——重试 */ } } });
afterEach(() => { delete process.env.ZS_MANAGED_RUNTIME; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | null): boolean => {
  if (pid == null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

interface Rig {
  daemon: RunningDaemon;
  adapters: LocalProtocolAdapter[];
  appDataDir: string;
  submit: (taskId: string, memberId: string) => Promise<void>;
  waitTask: (taskId: string) => Promise<string>;
}

/** stop 关库后的取证读取：重开 sqlite 文件（只读事实已持久化——不能凭内存断言）。 */
function reopen(dbFile: string): { get(sql: string, ...args: unknown[]): unknown; close(): void } {
  const db = openDatabase(dbFile);
  return { get: (sql, ...args) => db.prepare(sql).get(...args), close: () => db.close() };
}

function makeRig(adapters: LocalProtocolAdapter[], opts?: { drainSettleTimeoutMs?: number; managed?: boolean }): Promise<Rig> {
  const factories: Record<string, MemberAdapterFactory> = {
    claude: () => {
      const a = adapters[adapters.length - 1]!;
      return a;
    },
  };
  return (async () => {
    if (opts?.managed === true) process.env.ZS_MANAGED_RUNTIME = '1';
    const n = Rig_seq += 1;
    const appDataDir = join(tmpRoot, `app${n}`);
    const daemon = await startDaemon({
      appDataDir, runtime: 'fake', tickMs: 25,
      pipeName: `zs-lp-life-${n}`, // 管道名按路径派生会截断互撞——显式唯一
      drainSettleTimeoutMs: opts?.drainSettleTimeoutMs,
      testAdapterFactories: factories,
    });
    const db = daemon.db;
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    // 成员绑定 claude（模型 lp-model-a）——注入工厂经 entry 包装（同生产链）。
    db.prepare(`INSERT INTO runtime_installations (id, kind, executable, version, adapter_version, capabilities_json, detected_at) VALUES ('ri_lp','claude','lp','','','',0)`).run();
    db.prepare(`INSERT INTO agent_profiles (id, name, runtime_installation_id, settings_json) VALUES ('ap_lp','lp成员','ri_lp','{"model":"lp-model-a"}')`).run();
    db.prepare(`UPDATE project_members SET profile_id = 'ap_lp' WHERE id = 'm1'`).run();
    let seq = 0;
    const submit = async (taskId: string, memberId: string) => {
      seq += 1;
      const r = createRoomRootTask(db, {
        ids: { messageId: `msg${seq}`, threadId: `th${seq}`, taskId, taskEventId: `te${seq}`, threadEventId: `de${seq}` },
        projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
        title: `T${seq}`, body: '生命周期链任务', mentions: [{ kind: 'member', memberId }],
        author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
        route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] } as never,
        now: seq,
      });
      if (!r.ok) throw new Error(`任务创建失败：${JSON.stringify(r).slice(0, 120)}`);
    };
    const waitTask = async (taskId: string) => {
      for (let i = 0; i < 200; i += 1) {
        const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
        if (row != null && ['DONE', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(row.status)) return row.status;
        await sleep(50);
      }
      throw new Error(`任务 ${taskId} 未终态`);
    };
    return { daemon, adapters, appDataDir, submit, waitTask };
  })();
}
let Rig_seq = 0;

const ledgerRow = (d: RunningDaemon, turnId: string) =>
  d.db.prepare('SELECT * FROM real_calls WHERE turn_id = ?').get(turnId) as Record<string, unknown> | undefined;
const turnOf = (d: RunningDaemon, taskId: string) =>
  d.db.prepare('SELECT id, status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)').get(taskId) as { id: string; status: string };

describe('第十八轮二：护栏包装器生命周期透传（正式链）', () => {
  it('正常关闭：底层 disposeAll 被调用、退出确认如实上报、台账归属完整、响应模型与请求模型分列、关库后零后台写入', async () => {
    const adapter = new LocalProtocolAdapter({ disposeStyle: 'disposeAll', selfReportedModel: 'lp-server-x' });
    const rig = await makeRig([adapter]);
    await rig.submit('tk1', 'm1');
    expect(await rig.waitTask('tk1')).toBe('DONE');
    const turn = turnOf(rig.daemon, 'tk1');
    // 台账归属：kind/请求模型（binding）/member/task/run/turn；响应自报模型与用量引用真实事件。
    const row = ledgerRow(rig.daemon, turn.id);
    expect(row?.runtime_kind).toBe('claude');
    expect(row?.model).toBe('lp-model-a');
    expect(row?.member_id).toBe('m1');
    expect(row?.task_id).toBe('tk1');
    expect(row?.run_id).not.toBeNull();
    expect(row?.status).toBe('succeeded');
    expect(row?.response_model).toBe('lp-server-x');
    expect(String(row?.usage_json)).toContain('inputTokens');
    const stop = await rig.daemon.stop();
    expect(stop.complete, `stop 未完成：${stop.reason ?? '?'} | disposeReport=${JSON.stringify(stop.disposeReport)} | remaining=${JSON.stringify(stop.inFlightRemaining)}`).toBe(true);
    // 底层清理被调用（透传生效——不再 no-dispose-needed）且标签保留实现类名。
    expect(adapter.disposeAllCalls).toBe(1);
    expect(adapter.disposeEntered).toBe(1);
    expect(stop.disposeReport?.entries.some((e) => e.adapter === 'LocalProtocolAdapter' && e.outcome === 'disposed' && e.exitConfirmed === true)).toBe(true);
    expect(adapter.children.size).toBeGreaterThan(0);
    for (const child of adapter.children.values() as Iterable<MinimalProcess>) expect(child.exitCode != null || (child as { signalCode?: string | null }).signalCode != null).toBe(true); // 退出事实=码或信号任一
    // 关库确认（stop 收敛=消费器/启动窗口全收敛后才关库；零后台写入由 complete 语义承载）。
    expect(() => rig.daemon.db.prepare('SELECT 1').get()).toThrow();
  }, 60_000);

  it('在途停止（daemon 关闭）：interrupt 透传；子进程被杀且退出确认（closeAllSessions 形态）；turn 按「退出未确认」UNKNOWN（用户级停止才 CANCELLED——关闭路径不冒充取消）', async () => {
    const adapter = new LocalProtocolAdapter({ disposeStyle: 'closeAllSessions', neverTerminal: true });
    const rig = await makeRig([adapter]);
    await rig.submit('tk2', 'm1');
    for (let i = 0; i < 200; i += 1) {
      const st = rig.daemon.db.prepare("SELECT status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = 'tk2')").get() as { status: string } | undefined;
      if (st?.status === 'RUNNING') break;
      await sleep(50);
    }
    const turn = turnOf(rig.daemon, 'tk2');
    expect(turn.status).toBe('RUNNING');
    const stop = await rig.daemon.stop();
    expect(stop.complete).toBe(true);
    expect(adapter.interruptCalls).toBeGreaterThanOrEqual(1); // 停止请求经包装器透传到底层
    expect(adapter.closeAllSessionsCalls).toBe(1); // closeAllSessions 形态（fake 同型）经透传被调
    // stop 已关库——重开文件取证（事实持久化，不凭内存）。
    const after = reopen(join(rig.appDataDir, 'state.sqlite'));
    try {
      // 关闭路径 interrupt 未推进用户停止代次：turn=UNKNOWN（请求已发、退出确认前不冒充取消）。
      expect((after.get('SELECT status FROM agent_turns WHERE id = ?', turn.id) as { status: string } | undefined)?.status).toBe('UNKNOWN');
      expect((after.get('SELECT status FROM real_calls WHERE turn_id = ?', turn.id) as { status: string } | undefined)?.status).toBe('unknown');
    } finally {
      after.close();
    }
    expect(adapter.disposeEntered).toBe(1);
    for (const child of adapter.children.values() as Iterable<MinimalProcess>) expect(child.exitCode != null || (child as { signalCode?: string | null }).signalCode != null).toBe(true); // 退出事实=码或信号任一
  }, 60_000);

  it('启动失败：startTurn 抛错→按「可能已发出」UNKNOWN 收尾（不冒充未启动/不冒充失败）、零子进程、台账 unknown；dispose 照常', async () => {
    const adapter = new LocalProtocolAdapter({ disposeStyle: 'dispose', failStartTurnMessage: 'lp 模拟派发失败（请求前）' });
    const rig = await makeRig([adapter]);
    await rig.submit('tk3', 'm1');
    // 生产合同（第五轮统一生命周期）：startTurn 抛错=请求可能已发出 → turn UNKNOWN、任务保持
    // ACTIVE（不终态）、outbox 留待租约重领对账（RT-03）——不冒充「确认未启动」。
    let turn: { id: string; status: string } | undefined;
    for (let i = 0; i < 100; i += 1) {
      turn = rig.daemon.db.prepare("SELECT id, status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = 'tk3')").get() as { id: string; status: string } | undefined;
      if (turn != null && turn.status === 'UNKNOWN') break;
      await sleep(50);
    }
    expect(turn?.status).toBe('UNKNOWN');
    const row = ledgerRow(rig.daemon, turn!.id);
    expect(row?.status).toBe('unknown'); // 台账同口径：执行不确定性（不写 failed=未发出的暗示）
    expect(String(row?.detail)).toContain('不确定是否已发出');
    expect(adapter.spawnedPids.size).toBe(0); // 零子进程（真实链=零 spawn 证据）
    const task = rig.daemon.db.prepare('SELECT status FROM tasks WHERE id = ?').get('tk3') as { status: string };
    expect(task.status).toBe('ACTIVE'); // 未被冒充终态（对账路径负责）
    const stop = await rig.daemon.stop();
    expect(stop.complete).toBe(true);
    expect(adapter.disposeEntered).toBe(1); // dispose 形态（codex 同型）：底层清理被调用
    expect(adapter.disposeCalls).toBe(1);
    expect(adapter.disposeAllCalls).toBe(0);
  }, 60_000);

  it('清理超时：首次 stop 如实 incomplete（收拢挂起=合成超时项，不挂等不冒充）；force 二次收口完成', async () => {
    const adapter = new LocalProtocolAdapter({ disposeStyle: 'disposeAll', disposeHangMs: 900, neverTerminal: true, hangFirstDisposeOnly: true });
    const rig = await makeRig([adapter], { drainSettleTimeoutMs: 600 });
    await rig.submit('tk4', 'm1');
    for (let i = 0; i < 200; i += 1) {
      const st = rig.daemon.db.prepare("SELECT status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = 'tk4')").get() as { status: string } | undefined;
      if (st?.status === 'RUNNING') break;
      await sleep(50);
    }
    const pid = [...adapter.spawnedPids][0] ?? null;
    const stop = await rig.daemon.stop();
    expect(stop.complete).toBe(false); // 首次收拢挂起 900ms > 上限 600ms=合成超时项（不挂等、不冒充完成）
    expect(stop.reason).toContain('收拢');
    expect(stop.disposeReport?.failed.some((f) => f.error.includes('收拢超时'))).toBe(true);
    expect(adapter.disposeEntered).toBe(1); // 收拢确实被进入且挂起（此刻未完成——incomplete 是如实上报）
    const forced = await rig.daemon.stop({ force: true });
    expect(forced.complete, `force 未完成：${forced.reason ?? '?'} | ${JSON.stringify(forced.disposeReport)}`).toBe(true); // 二次收拢（无挂起）→杀进程+UNKNOWN/取消收尾后关库
    expect(forced.phase).toBe('forced-closed');
    expect(alive(pid)).toBe(false);
    for (const child of adapter.children.values() as Iterable<MinimalProcess>) expect(child.exitCode != null || (child as { signalCode?: string | null }).signalCode != null).toBe(true); // 退出事实=码或信号任一
  }, 90_000);

  it('shared server+多成员：同绑定共享一个 adapter（工厂一次）；不同绑定各自 adapter；两者都被收拢', async () => {
    const shared = new LocalProtocolAdapter({ disposeStyle: 'disposeAll' });
    const other = new LocalProtocolAdapter({ disposeStyle: 'disposeAll' });
    let builds = 0;
    const factories: Record<string, MemberAdapterFactory> = {
      claude: (binding) => {
        builds += 1;
        return (binding.model === 'lp-model-b' ? other : shared) as never;
      },
    };
    const daemon = await startDaemon({ appDataDir: join(tmpRoot, 'app-shared'), runtime: 'fake', tickMs: 25, pipeName: 'zs-lp-life-shared', testAdapterFactories: factories });
    const db = daemon.db;
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO runtime_installations (id, kind, executable, version, adapter_version, capabilities_json, detected_at) VALUES ('ri1','claude','lp','','','',0)`).run();
    db.prepare(`INSERT INTO runtime_installations (id, kind, executable, version, adapter_version, capabilities_json, detected_at) VALUES ('ri2','claude','lp','','','',0)`).run();
    for (const [mid, model, prof, install] of [['mA', 'lp-model-a', 'apA', 'ri1'], ['mA2', 'lp-model-a', 'apA2', 'ri1'], ['mB', 'lp-model-b', 'apB', 'ri2']] as const) {
      db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES (?,'p1',?,'agent',1)`).run(mid, mid);
      db.prepare(`INSERT INTO agent_profiles (id, name, runtime_installation_id, settings_json) VALUES (?,?,?,?)`).run(prof, mid, install, JSON.stringify({ model }));
      db.prepare(`UPDATE project_members SET profile_id = ? WHERE id = ?`).run(prof, mid);
    }
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run(); // 房间在成员之后（FK）
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    let seq = 0;
    for (const mid of ['mA', 'mA2', 'mB']) {
      seq += 1;
      const r = createRoomRootTask(db, {
        ids: { messageId: `m${seq}`, threadId: `t${seq}`, taskId: `tk5-${seq}`, taskEventId: `a${seq}`, threadEventId: `b${seq}` },
        projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
        title: `S${seq}`, body: 'x', mentions: [{ kind: 'member', memberId: mid }],
        author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
        route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: mid, frozenMemberIds: [mid], initialWakeMemberIds: [mid] } as never,
        now: seq,
      });
      if (!r.ok) throw new Error('任务创建失败');
    }
    for (let i = 0; i < 200; i += 1) {
      const c = db.prepare("SELECT count(*) c FROM tasks WHERE status = 'DONE'").get() as { c: number };
      if (c.c >= 3) break;
      await sleep(50);
    }
    const stop = await daemon.stop();
    expect(stop.complete).toBe(true);
    expect(builds).toBe(2); // 同绑定共享（缓存键=installation|model|permission）；不同绑定各一
    expect(shared.startTurnCalls).toBe(2); // mA+mA2 都经共享实例
    expect(other.startTurnCalls).toBe(1);
    expect(shared.disposeEntered).toBe(1);
    expect(other.disposeEntered).toBe(1);
    const perTurnExits = stop.disposeReport?.entries.filter((e) => e.turnId != null) ?? [];
    expect(perTurnExits.length).toBe(3); // disposeAll 形态：每 turn 一条退出确认（shared 2 + other 1）
    expect(perTurnExits.every((e) => e.exitConfirmed === true)).toBe(true);
  }, 90_000);

  it('受管路径：注入 spawn 经受管桥（Job Object）；stop 后受管 job 归零、子进程退出', async () => {
    const adapter = new LocalProtocolAdapter({
      disposeStyle: 'disposeAll',
      spawnFn: (cmd, args, opts) => spawnManagedBridge(cmd, args, { cwd: opts.cwd }) as unknown as MinimalProcess,
    });
    const rig = await makeRig([adapter], { managed: true });
    const jobsBase = managedJobsCount();
    await rig.submit('tk6', 'm1');
    expect(await rig.waitTask('tk6')).toBe('DONE');
    const stop = await rig.daemon.stop();
    expect(stop.complete).toBe(true);
    expect(adapter.disposeEntered).toBe(1); // 正常收拢走 adapter disposeAll（不退化为 job 兜底）
    expect(managedJobsCount()).toBe(jobsBase); // 受管 job 全量收尾（per-turn 退休+stop 收拢）
    for (const child of adapter.children.values() as Iterable<MinimalProcess>) expect(child.exitCode != null || (child as { signalCode?: string | null }).signalCode != null).toBe(true); // 退出事实=码或信号任一
    // 未受管路径=本文件前五个用例（无 ZS_MANAGED_RUNTIME——spawn 走普通 child_process）。
  }, 60_000);
});
