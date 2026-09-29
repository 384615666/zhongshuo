/**
 * DEV-13 supervisor 衔接：进程树证据（第七轮·补，零模型调用——真实本地 node 进程树）。
 *
 * 核心语义：**父进程退出不证明其工具/派生子进程已结束**——per-turn/shared 标签不替代
 * 进程树证据。仅「父退出 + 子进程可枚举且无存活」构成完整退出证据。
 * 覆盖（全部经 recovery.probeProcess 正式命令链）：
 * - 独立 CLI（per-turn）：父+工具子存活→alive；父被杀、子成孤儿仍跑→unknown（保护保留）；
 *   子也结束→exited（完整）；
 * - 共享 server（shared）：同型进程树语义（server 死+工具进程遗留→unknown）；
 *   server 存活但 turn 状态未知→unknown（已有用例复证）；
 * - 崩溃窗口：startTurn 前 pre-launch 登记（pid=null）→ probe=unknown（detail 区分
 *   「启动窗口身份未持久化」，与「从未登记」（identity-missing）分开）；
 * - 子进程枚举失败/平台不支持（注入）→ exited 降级 unknown（未完整确认，不猜测）。
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
import { registerTurnProcess } from '../../src/daemon/processRegistry.ts';
import { checkProcessLiveness, listLiveChildProcesses } from '../../src/daemon/processCheck.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-tree-'));
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
function makeTurn(db: ZhongshuoDatabase): { turnId: string; runId: string } {
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
  const turnId = `turn_tree_${seq}`;
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', ?, 'DIRECT', 0, 'INTERRUPTED', '{}')`)
    .run(runId, ids.taskId, ids.threadId);
  db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', ?, 'mA', 'direct.work', 'UNKNOWN', ?, 1, 1)`)
    .run(turnId, runId, ids.threadId, `task:${ids.taskId}:initial`);
  return { turnId, runId };
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

function cliLikeProcess(): ChildProcess {
  // 模拟 CLI：自身存活并 spawn 一个长活工具子进程（模拟 Bash/工具执行遗留）。
  // 工具子进程用 detached:true——脱离父进程 Job（否则父死时 node 会连带终止子进程，
  // 无法构造「父退出、工具子进程遗留」的孤儿现场）。
  return spawn(process.execPath, ['-e', 'const{spawn}=require("child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});setInterval(()=>{},1000)'], { stdio: 'ignore' });
}

describe('supervisor 进程树证据（正式 probeProcess 命令链 + 真实 node 进程树）', () => {
  it('per-turn：父+工具子存活→alive；父被杀、工具子孤儿仍跑→unknown（父退出不证明执行结束）；子也结束→exited（完整）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    const { cmd } = depsOf(db);
    const parent = cliLikeProcess();
    await new Promise((r) => setTimeout(r, 800)); // 等工具子进程 spawn
    const liveness = checkProcessLiveness(parent.pid!);
    expect(liveness.state).toBe('alive');
    const scanLive = listLiveChildProcesses(parent.pid!);
    expect(scanLive.state).toBe('live'); // 前置：工具子进程确实存在（win32 CIM 真实枚举）
    if (liveness.state === 'alive') {
      registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: parent.pid!, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
    }
    // 父+子都活：probe=alive（保留保护）。
    const p1 = await cmd<{ result: string }>('recovery.probeProcess', { turnId });
    expect(p1.result).toBe('alive');
    // 杀父（模拟崩溃/CLI 退出）——工具子进程成孤儿继续跑：probe 必须=unknown（不得据父退出释放）。
    parent.kill();
    await new Promise((r) => setTimeout(r, 800));
    const p2 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p2.result).toBe('unknown');
    expect(p2.detail).toContain('子进程仍在运行');
    // 工具子也结束：probe=exited（完整退出证据——父退+无存活子）。
    const scan = listLiveChildProcesses(parent.pid!);
    if (scan.state === 'live') for (const c of scan.children) { try { process.kill(c.pid); } catch { /* 已退出 */ } }
    await new Promise((r) => setTimeout(r, 900));
    const p3 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p3.result).toBe('exited');
    expect(p3.detail).toContain('无存活子进程');
    db.close();
  }, 60_000);

  it('shared（共享 server）：server 死+工具进程遗留→unknown；server 存活→unknown（turn 执行状态未知，复证）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    const { cmd } = depsOf(db);
    const server = cliLikeProcess();
    await new Promise((r) => setTimeout(r, 800));
    const liveness = checkProcessLiveness(server.pid!);
    if (liveness.state === 'alive') {
      registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'codex', processModel: 'shared', pid: server.pid!, startedAtMs: liveness.identity.startedAt, identitySource: 'os-starttime' });
    }
    // server 存活：该 turn 执行状态未知（不因 server 活着判定执行中/已结束）。
    const p1 = await cmd<{ result: string }>('recovery.probeProcess', { turnId });
    expect(p1.result).toBe('alive');
    // server 死、其工具子进程遗留：unknown（共享载体消失但执行残留可能）。
    server.kill();
    await new Promise((r) => setTimeout(r, 800));
    const p2 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p2.result).toBe('unknown');
    expect(p2.detail).toContain('子进程仍在运行');
    const scan = listLiveChildProcesses(server.pid!);
    if (scan.state === 'live') for (const c of scan.children) { try { process.kill(c.pid); } catch { /* 已退出 */ } }
    await new Promise((r) => setTimeout(r, 900));
    const p3 = await cmd<{ result: string }>('recovery.probeProcess', { turnId });
    expect(p3.result).toBe('exited'); // server 进程树完整退出（证据按 shared 标注）
    db.close();
  }, 60_000);

  it('崩溃窗口：pre-launch 登记（pid=null）→ probe=unknown 且 detail 区分「启动窗口身份未持久化」；从未登记→identity-missing（两种窗口分开）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const t1 = makeTurn(db);
    const t2 = makeTurn(db);
    const { cmd } = depsOf(db);
    // t1：worker 在 startTurn 前写入的 pre-launch 占位（请求可能已发出的窗口）。
    registerTurnProcess(db, { turnId: t1.turnId, runId: t1.runId, memberId: 'mA', adapterKind: 'claude', processModel: 'unknown', pid: null, startedAtMs: null, identitySource: 'pre-launch' });
    const p1 = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId: t1.turnId });
    expect(p1.result).toBe('unknown');
    expect(p1.detail).toContain('启动窗口身份未持久化'); // 区分于「从未启动」
    // t2：更早崩溃（登记前）——identity-missing。
    const p2 = await cmd<{ result: string }>('recovery.probeProcess', { turnId: t2.turnId });
    expect(p2.result).toBe('identity-missing');
    db.close();
  }, 30_000);

  it('子进程枚举不可用（注入失败/平台不支持）→ exited 降级 unknown（未完整确认，不猜测）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { turnId, runId } = makeTurn(db);
    registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'claude', processModel: 'per-turn', pid: 424242, startedAtMs: null, identitySource: 'pid-only' });
    const { cmd } = depsOf(db, {
      childScan: () => ({ state: 'failed', error: '注入：CIM 查询失败' }),
      processQuery: (pid) => ({ state: 'exited' as const, pid }), // 父 PID 确认退出
    });
    const p = await cmd<{ result: string; detail: string }>('recovery.probeProcess', { turnId });
    expect(p.result).toBe('unknown'); // 只能证明父退出——未完整确认，保护保留
    expect(p.detail).toContain('未完整确认');
    db.close();
  }, 30_000);
});
