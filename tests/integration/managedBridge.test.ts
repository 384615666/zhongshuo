/**
 * 第十三轮一/二：受管桥 stdio/argv/证据生命周期 + **正式生产链验收**（零模型调用）。
 *
 * 一（桥）：
 * - stdin EOF：子进程**持续读 stdin 至 EOF** 才输出结构化结果并退出（非行回显 fixture）；
 *   经 bridge（adapter 契约路径：Writable.end→endStdin）验证；大 stdin（>256KB 分片写）
 *   不阻塞事件循环（心跳并发运行）；
 * - 输出：大 stdout（~1.5MB 分次读）、中文跨字节边界——字节流不丢；exit 与 close 分开
 *   （close=排空后，含「末块数据与退出同拍到达」的终拍 push(null)）；
 * - argv：空参数/嵌入引号/引号前反斜杠/带空格+末尾反斜杠路径（经回读核对）；
 * - 环境块（第十四轮一规范调用）：完整替换 env 逐项回读——ASCII/中文/空值/带空格路径/
 *   覆盖父值/删除变量/大块；Path/PATH 大小写不敏感去重；父进程环境不变。
 *
 * 二（正式链）：受管 spawn → 登记 identity_source='managed-job'（note=jobId 稳定身份）→
 * UNKNOWN/租约保留 → 后代结束 → recovery.probeProcess/releaseProtection 凭 releaseEvidence
 * 解除 → 租约释放 → 排队任务可继续；根先退后代仍活（保留可查询证据）；重复解除幂等；
 * 重启语义（dispose 后句柄消失→拒绝，不追认）。
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnManagedBridge, managedJobByPid, managedJobById } from '../../src/daemon/managed/bridge.ts';
import { buildCmdline } from '../../src/daemon/managed/jobManager.ts';
import type { DaemonCommandDeps } from '../../src/daemon/commands.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-mgbridge-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

const NODE = process.execPath;
const BIG_TEXT = '中文边界✓'.repeat(80_000); // ~1.5MB UTF-8（多字节字符跨读块）
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ReadableLike = NodeJS.ReadableStream & { on(ev: 'data', cb: (c: Buffer) => void): void; on(ev: 'end', cb: () => void): void; on(ev: 'close', cb: () => void): void };
async function readAll(readable: ReadableLike): Promise<Buffer> {
  return await new Promise((resolve) => {
    const parts: Buffer[] = [];
    readable.on('data', (c: Buffer) => parts.push(c));
    readable.on('end', () => resolve(Buffer.concat(parts)));
    readable.on('close', () => resolve(Buffer.concat(parts)));
  });
}

beforeAll(() => {
  // EOF 消费者 fixture：读全部 stdin 至 EOF → 输出结构化 JSON（字节数与首尾摘要）→ 退出。
  writeFileSync(join(tmpRoot, 'eof-consumer.js'), `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const all = Buffer.concat(chunks);
  const out = JSON.stringify({ kind: 'EOF_RESULT', bytes: all.length, head: all.subarray(0, 16).toString('hex'), tail: all.subarray(-16).toString('hex') });
  process.stdout.write(out);
  process.exit(0);
});
`, 'utf8');
  writeFileSync(join(tmpRoot, 'argv-echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', 'utf8'); // slice(2)=跳过 node 与脚本路径
  // 大输出脚本落盘（内联 -e 1.5MB 超 Windows 命令行长度限制 lastError=206）。
  writeFileSync(join(tmpRoot, 'big-out.js'), `process.stdout.write(${JSON.stringify(BIG_TEXT)});process.exit(0);`, 'utf8');
});

describe('第十三轮一：受管桥 stdio/argv 生命周期', () => {
  it('stdin EOF（持续读至 EOF 的消费者）：bridge.stdin.end() → 子进程读到 EOF → 结构化结果 → exit+close 分开', async () => {
    const child = spawnManagedBridge(NODE, [join(tmpRoot, 'eof-consumer.js')], { cwd: tmpRoot });
    const outPromise = readAll(child.stdout);
    const events: string[] = [];
    child.on('exit', () => events.push('exit'));
    child.on('close', () => events.push('close'));
    const payload = Buffer.alloc(1_048_576); // 1MB=16 分片：写阶段跨越多个事件循环拍（心跳并发证明）
    for (let i = 0; i < payload.length; i++) payload[i] = 97 + (i % 26);
    let heartbeat = 0;
    const hb = setInterval(() => { heartbeat += 1; }, 10);
    child.stdin.write('begin:' + payload.toString('utf8') + ':end');
    child.stdin.end(); // EOF
    const out = (await outPromise).toString('utf8');
    clearInterval(hb);
    const parsed = JSON.parse(out) as { kind: string; bytes: number; head: string };
    expect(parsed.kind).toBe('EOF_RESULT');
    expect(parsed.bytes).toBe('begin:'.length + Buffer.byteLength(payload.toString('utf8')) + ':end'.length);
    expect(parsed.head).toContain('626567696e'); // "begin" hex
    expect(heartbeat).toBeGreaterThan(5); // 分片异步写——事件循环在写阶段持续运行（vitest 实测 7 拍/1MB；独立进程 300KB 54 拍——同步阻塞写会得 0）
    await sleep(400);
    expect(events[0]).toBe('exit'); // exit 先于 close
    expect(events).toContain('close');
    expect(child.exitCode).toBe(0);
    // 证据生命周期：根退出后注册表仍保留（close≠证据消失）。
    expect(managedJobById(child.managedJobId)).toBeDefined();
    child.managed.dispose();
    expect(managedJobById(child.managedJobId)).toBeUndefined();
  }, 60_000);

  it('stdout 字节流：1.5MB 大输出 + 中文跨字节边界——无丢失', async () => {
    const child = spawnManagedBridge(NODE, [join(tmpRoot, 'big-out.js')], { cwd: tmpRoot });
    const out = await readAll(child.stdout);
    child.managed.dispose();
    expect(out.length).toBe(Buffer.byteLength(BIG_TEXT, 'utf8'));
    expect(out.toString('utf8')).toBe(BIG_TEXT);
  }, 60_000);

  it('argv 编码（Windows 引用规则）：空参数/嵌入引号/引号前反斜杠/带空格+末尾反斜杠路径', async () => {
    const args = ['', 'he said "hi"', 'path\\\\"quoted', 'C:\\Program Files\\Test\\', 'a b c'];
    const child = spawnManagedBridge(NODE, [join(tmpRoot, 'argv-echo.js'), ...args], { cwd: tmpRoot });
    const out = (await readAll(child.stdout)).toString('utf8');
    child.managed.dispose();
    const parsed = JSON.parse(out) as string[];
    expect(parsed).toEqual(args); // 逐位回读核对（含空串与转义组合）
    const line = buildCmdline('node', ['exe', ...args]);
    expect(line).toContain('""'); // 空参数显式引用
  }, 60_000);

  it('环境块规范调用（第十四轮一）：替换 env 回读——ASCII/中文/空值/空格/覆盖/删除/大块/大小写去重；父环境不变', async () => {
    const marker = `MG_${Date.now().toString(36)}`;
    const k = {
      ascii: `${marker}_ASCII`, cn: `${marker}_CN`, empty: `${marker}_EMPTY`,
      space: `${marker}_SPACE`, override: `${marker}_OVERRIDE`, del: `${marker}_DEL`,
      dup: `${marker}_DUP`, big: `${marker}_BIG`,
    };
    // 父环境预置（覆盖/删除语义的核对基准；spawn 后核对父环境原样）。
    process.env[k.override] = 'old-from-parent';
    process.env[k.del] = 'to-delete';
    // ① 缺省 env=继承父环境（生产路径——与未受管 spawn 的 env:process.env 等价）。
    const inheritChild = spawnManagedBridge(NODE, ['-e', `process.stdout.write(process.env[${JSON.stringify(k.override)}] || 'MISSING')`], { cwd: tmpRoot });
    const inheritOut = (await readAll(inheritChild.stdout)).toString('utf8');
    inheritChild.managed.dispose();
    expect(inheritOut).toBe('old-from-parent');
    const bigValue = 'x'.repeat(30_000) + 'y'.repeat(2_000); // 32K 单值（<32767 上限，跨多个写拍）
    const env: Record<string, string | undefined> = {
      ...process.env, // 完整替换（Node 语义）：由父环境组合——SystemRoot/PATH 等保留
      [k.ascii]: 'hello-ascii',
      [k.cn]: '中文值 ✓',
      [k.empty]: '',
      [k.space]: 'C:\\Program Files\\apps 测试\\',
      [k.override]: 'new-value',
      [k.dup]: 'one',
      [k.dup.toLowerCase()]: 'two', // 同名大小写变体——去重后写整行覆盖（后写为准）
      [k.big]: bigValue,
    };
    delete env[k.del]; // 删除：父环境有、传入环境无 → 子进程不可见
    const script = `const r={a:process.env[${JSON.stringify(k.ascii)}],c:process.env[${JSON.stringify(k.cn)}]`
      + `,e:process.env[${JSON.stringify(k.empty)}]===undefined?'MISSING':process.env[${JSON.stringify(k.empty)}]`
      + `,s:process.env[${JSON.stringify(k.space)}],o:process.env[${JSON.stringify(k.override)}]`
      + `,d:process.env[${JSON.stringify(k.del)}]===undefined?'MISSING':process.env[${JSON.stringify(k.del)}]`
      + `,p:process.env[${JSON.stringify(k.dup)}],b:process.env[${JSON.stringify(k.big)}]};`
      + `r.bl=r.b==null?null:r.b.length;r.bh=r.b==null?null:r.b.slice(0,3);r.bt=r.b==null?null:r.b.slice(-3);r.b=null;`
      + `process.stdout.write(JSON.stringify(r))`;
    const child = spawnManagedBridge(NODE, ['-e', script], { cwd: tmpRoot, env: env as unknown as NodeJS.ProcessEnv });
    const out = (await readAll(child.stdout)).toString('utf8');
    child.managed.dispose();
    // 父进程环境不被修改（替换语义只作用于子进程块）。
    expect(process.env[k.override]).toBe('old-from-parent');
    expect(process.env[k.del]).toBe('to-delete');
    delete process.env[k.override];
    delete process.env[k.del];
    const r = JSON.parse(out) as { a: string; c: string; e: string; s: string; o: string; d: string; p: string; bl: number | null; bh: string | null; bt: string | null };
    expect(r.a).toBe('hello-ascii');
    expect(r.c).toBe('中文值 ✓');
    expect(r.e).toBe('');           // 空值保留（与删除可区分）
    expect(r.s).toBe('C:\\Program Files\\apps 测试\\');
    expect(r.o).toBe('new-value');  // 覆盖父值
    expect(r.d).toBe('MISSING');    // 删除变量
    expect(r.p).toBe('two');        // Path/PATH 同名大小写不敏感去重——后写整行覆盖
    expect(r.bl).toBe(32_000);      // 大环境块（UTF-16 64KB）完整到达
    expect(r.bh).toBe('xxx');
    expect(r.bt).toBe('yyy');
  }, 60_000);
});

describe('第十三轮二：恢复证据正式链（spawn→登记→UNKNOWN→probe→release→排队续跑）', () => {
  it('根先退后代仍活：证据不可解除（保留可查询 job）；后代结束后解除；重复解除幂等；重启语义拒绝', async () => {
    const script = 'const{spawn}=require("child_process");const fs=require("fs");'
      + 'const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});g.unref();'
      + `fs.writeFileSync(${JSON.stringify(join(tmpRoot, 'chain-grandson.pid'))},String(g.pid));`
      + 'process.exit(0);';
    const child = spawnManagedBridge(process.execPath, ['-e', script], { cwd: tmpRoot });
    const grandsonPidPath = join(tmpRoot, 'chain-grandson.pid');
    for (let i = 0; i < 100; i += 1) {
      try {
        const pid = Number(readFileSync(grandsonPidPath, 'utf8'));
        if (pid > 0) break;
      } catch { /* 未写 */ }
      await sleep(50);
    }
    await sleep(400); // 根退出（脚本 process.exit(0)）
    const mp = managedJobByPid(child.pid);
    expect(mp).toBeDefined();
    // 根已退、后代仍活 → 不可解除。
    const ev1 = mp!.releaseEvidence();
    expect(ev1.rootExited).toBe(true);
    expect(ev1.releasable).toBe(false);
    expect(ev1.activeCount!).toBeGreaterThanOrEqual(1);
    // close 输出流（stdio 收尾）不使证据消失。
    mp!.closeOutputPipes();
    expect(managedJobById(child.managedJobId)).toBeDefined();
    const ev2 = mp!.releaseEvidence();
    expect(ev2.releasable).toBe(false);
    // 终止整个 job（=停止/清理语义）→ 句柄释放 → 计数归零（延迟）→ 可解除。
    mp!.terminateAll();
    mp!.releaseRootHandles();
    await sleep(700);
    const ev3 = mp!.releaseEvidence();
    expect(ev3.activeCount).toBe(0);
    expect(ev3.releasable).toBe(true);
    mp!.markConsumed(); // 恢复命令消费证据（生命周期审计）
    const lc = mp!.lifecycle();
    expect(lc).toMatchObject({ rootExited: true, stdioClosed: true, evidenceReleased: true, consumed: true, finalized: false });
    mp!.dispose();
    expect(managedJobById(child.managedJobId)).toBeUndefined(); // 重启语义：句柄消失后不追认
  }, 120_000);

  it('正式恢复链：受管 turn UNKNOWN→probe→release 解除租约→排队任务可继续；重复解除幂等', async () => {
    const { openDatabase } = await import('../../src/persistence/db.ts');
    const { dispatchDaemonCommand } = await import('../../src/daemon/commands.ts');
    const { registerTurnProcess } = await import('../../src/daemon/processRegistry.ts');
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    const deps: DaemonCommandDeps = { db, localUserId: 'u_mgchain', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
    const cmd = async <T,>(m: string, p: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    };

    const child = spawnManagedBridge(process.execPath, ['-e', 'process.exit(0)'], { cwd: tmpRoot });
    const turnId = `turn_mg_${randomUUID().slice(0, 8)}`;
    const runId = `run_mg_${randomUUID().slice(0, 8)}`;
    const taskId = `tk_mg_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES (?, 'p1', 'c1', 'room_task', 'r1', '受管链', 'ACTIVE')`).run(taskId);
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', 'DIRECT', 0, 'RUNNING', ?)`).run(runId, taskId, JSON.stringify({ runMaxTurns: 3, usedTurns: 0, inFlightReservedTurns: 1 }));
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch, budget_mark) VALUES (?, ?, 'c1', 'mA', 'direct.work', 'UNKNOWN', 'task:mg:initial', 1, 1, NULL)`).run(turnId, runId);
    const lockDomain = tmpRoot.toLowerCase();
    db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, ?, 1, ?, 'active')`).run(lockDomain, turnId, Date.now());
    // 登记生产口径（第十四轮二）：identity_source='managed-job'+managed_job_id 正式列。
    registerTurnProcess(db, {
      turnId, runId, memberId: 'mA', adapterKind: 'fake',
      processModel: 'per-turn', pid: child.pid, startedAtMs: null,
      identitySource: 'managed-job', managedJobId: child.managedJobId,
    });
    await sleep(500);
    const mp = managedJobById(child.managedJobId);
    expect(mp).toBeDefined();
    mp!.releaseRootHandles();
    await sleep(500);
    await cmd<{ result: string }>('recovery.probeProcess', { turnId }); // 受管证据路径可查询
    db.prepare(`UPDATE agent_turns SET status='FAILED', budget_mark='refunded' WHERE id=?`).run(turnId); // 预算先处置（release 前置）
    const released = await cmd<{ stateChanged: boolean; releasedLeases: string[]; reason: string }>('recovery.releaseProtection', { turnId, note: '受管证据解除' });
    expect(released.stateChanged).toBe(true);
    expect(released.reason).toContain('managed-job');
    expect((db.prepare(`SELECT status FROM workspace_leases WHERE owner_turn_id=?`).get(turnId) as { status: string }).status).toBe('released');
    // 排队任务可继续：锁域已释放 → 新租约可授予（turn_next=排队任务的最小登记行）。
    const runNext = `run_mg_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES (?, ?, 'c1', 'DIRECT', 0, 'RUNNING')`).run(runNext, taskId);
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES ('turn_next', ?, 'c1', 'mA', 'direct.work', 'PENDING', 'task:mg:next', 1, 1)`).run(runNext);
    db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, 'turn_next', 1, ?, 'active')`).run(lockDomain, Date.now());
    expect((db.prepare(`SELECT status FROM workspace_leases WHERE owner_turn_id='turn_next'`).get() as { status: string }).status).toBe('active');
    // 重复解除：幂等 no-op（无未释放租约）。
    const again = await cmd<{ stateChanged: boolean }>('recovery.releaseProtection', { turnId, note: '重复解除' });
    expect(again.stateChanged).toBe(false);
    mp!.markConsumed();
    mp!.dispose();
    db.close();
  }, 120_000);
});
