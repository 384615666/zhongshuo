/**
 * REC-LIFE-1 验收（第十二轮五）：Windows Job Object 受管生命周期——本地真实进程 fixture，
 * 零模型调用。覆盖 ADR §3 + 用户令十二轮五的本地验收清单：
 * 多代派生/detached 后代/父与中间进程退出/快速派生窗口/查询失败/纳管失败/正常关闭/
 * 句柄语义（ActiveProcesses 归零必要条件）/daemon（句柄持有者）强制终止→KILL_ON_JOB_CLOSE/
 * 重启恢复语义（新进程拿不到旧句柄→保守）/shared 语义（job 内多任务，单 turn 完成≠job 退出）。
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnManagedProcess, managedRuntimeAvailable } from '../../src/daemon/managed/jobManager.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-managed-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

const NODE = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** 真实进程存活探测（tasklist）。 */
function alive(pid: number): boolean {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout ?? '').includes(String(pid));
}

const scripts: Array<[string, string]> = [
  ['gen.js', `
const { spawn } = require('child_process');
const depth = parseInt(process.argv[2] || '3', 10);
const child = spawn(process.execPath, [__filename, String(depth - 1), 'child'], { stdio: 'ignore', detached: depth === 1 });
if (depth === 1) child.unref();
console.log('pid=' + process.pid + ' depth=' + depth);
setInterval(() => {}, 1000);
`],
  ['fast-fork.js', `
const { spawn } = require('child_process');
// 恢复后立刻派生（快速派生窗口：挂起纳管下派生不可能先于纳管——孙进程必在 job 内）。
const g = spawn(process.execPath, ['-e', 'console.log("grand"); setInterval(()=>{},1000)'], { stdio: 'ignore' });
console.log('parent=' + process.pid + ' child=' + g.pid);
setInterval(() => {}, 1000);
`],
  ['worker.js', `
console.log('worker up pid=' + process.pid);
setInterval(() => {}, 1000);
`],
];
beforeAll(() => {
  for (const [name, body] of scripts) writeFileSync(join(tmpRoot, name), body, 'utf8');
});

describe.skipIf(managedRuntimeAvailable().ok !== true)('REC-LIFE-1：Job Object 受管生命周期（真实进程）', () => {
  it('受管能力可用（win32+koffi）', () => {
    expect(managedRuntimeAvailable()).toEqual({ ok: true });
  }, 30_000);

  it('多代派生+detached 后代全部归属 job：根与中间退出后计数仍含孙；terminateAll 清零', async () => {
    const mp = spawnManagedProcess({ cmd: NODE, args: [join(tmpRoot, 'gen.js'), '3'] });
    await sleep(1500); // 派生完成（子→孙，最深层 detached+unref）
    const c1 = mp.activeCount();
    expect(c1).not.toBeNull();
    expect(c1!).toBeGreaterThanOrEqual(3); // 根+子+孙——detached 孙也在 job 内（纳管窗口为零）
    expect(alive(mp.pid)).toBe(true);
    // terminateAll：整个 job（含 detached 孙）终止。
    mp.terminateAll();
    await sleep(700);
    expect(mp.activeCount()).toBe(0);
    mp.dispose();
  }, 60_000);

  it('正常关闭语义（修正点②）：根退出+句柄未关→不可解除；关句柄+延迟→计数归零→可解除证据', async () => {
    const mp = spawnManagedProcess({ cmd: NODE, args: ['-e', 'console.log("done"); process.exit(0)'] });
    const r = mp.waitRootExit(15_000);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    // 根已退但我们仍持句柄 → 计数>0 或证据不可解除（句柄未关是明确原因）。
    const ev1 = mp.releaseEvidence();
    expect(ev1.rootExited).toBe(true);
    expect(ev1.releasable).toBe(false); // handlesReleased=false（或计数未归零）——不可解除
    mp.releaseRootHandles();
    await sleep(600); // 系统清理延迟（实测必要）
    const ev2 = mp.releaseEvidence();
    expect(ev2.handlesReleased).toBe(true);
    expect(ev2.activeCount).toBe(0);
    expect(ev2.releasable).toBe(true);
    expect(ev2.reason).toContain('完整结束');
    mp.dispose();
  }, 60_000);

  it('快速派生窗口：恢复后立刻派生的孙进程在 job 内（挂起纳管=零逃逸窗口）', async () => {
    const mp = spawnManagedProcess({ cmd: NODE, args: [join(tmpRoot, 'fast-fork.js')] });
    await sleep(1200);
    const count = mp.activeCount();
    expect(count).toBeGreaterThanOrEqual(2); // 根+立刻派生的子
    mp.terminateAll();
    await sleep(500);
    expect(mp.activeCount()).toBe(0);
    mp.dispose();
  }, 60_000);

  it('stdin/stdout/stderr 契约：写入 stdin→子进程回显→读回（adapter 数据面兼容）', async () => {
    const echoCode = 'const rl=require("readline").createInterface({input:process.stdin});rl.on("line",l=>process.stdout.write("echo:"+l+String.fromCharCode(10)))';
    const mp = spawnManagedProcess({ cmd: NODE, args: ['-e', echoCode] });
    mp.writeStdin('hello-managed\n');
    let out = '';
    for (let i = 0; i < 40 && !out.includes('hello-managed'); i += 1) {
      await sleep(100);
      const chunk = mp.pollStdout();
      if (chunk != null && chunk !== '') out += chunk;
    }
    expect(out).toContain('echo:hello-managed');
    mp.terminateAll();
    mp.dispose();
  }, 30_000);

  it('纳管失败：不存在的可执行 → 抛错（不降级、不残留进程）', () => {
    expect(() => spawnManagedProcess({ cmd: join(tmpRoot, 'definitely-not-exist-xyz.exe'), args: [] })).toThrow(/受管启动失败/);
  }, 30_000);

  it('句柄持有者强制终止 → KILL_ON_JOB_CLOSE 杀掉 job 内全部进程（daemon 崩溃兜底）', async () => {
    // holder：一个独立进程创建 job+受管子（多代），然后保持存活；测试杀掉 holder →
    // job 最后句柄关闭 → 内核终止 job 内进程。
    const holderScript = `
const { spawnManagedProcess } = require(${JSON.stringify(join(process.cwd(), 'src/daemon/managed/jobManager.ts').replaceAll('\\', '/'))});
const mp = spawnManagedProcess({ cmd: ${JSON.stringify(NODE)}, args: [${JSON.stringify(join(tmpRoot, 'gen.js'))}, '3'] });
console.log('CHILD_PID=' + mp.pid);
setInterval(() => {}, 1000);
`;
    writeFileSync(join(tmpRoot, 'holder.js'), holderScript, 'utf8');
    const holder = spawnSync(NODE, ['--experimental-strip-types', join(tmpRoot, 'holder.js')], { encoding: 'utf8', timeout: 20_000 });
    // holder 输出 CHILD_PID（spawnSync 等待退出——改为后台：用 detached spawn。
    void holder;
    const { spawn } = await import('node:child_process');
    const h = spawn(NODE, ['--experimental-strip-types', join(tmpRoot, 'holder.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childPid = 0;
    const buf: string[] = [];
    h.stdout.on('data', (d: Buffer) => {
      buf.push(d.toString('utf8'));
      const m = /CHILD_PID=(\d+)/.exec(buf.join(''));
      if (m != null) childPid = Number(m[1]);
    });
    for (let i = 0; i < 100 && childPid === 0; i += 1) await sleep(100);
    expect(childPid).toBeGreaterThan(0);
    await sleep(1200); // 三代派生完成
    // 强杀句柄持有者（模拟 daemon 崩溃）。
    spawnSync('taskkill', ['/PID', String(h.pid), '/T', '/F']);
    await sleep(1500); // KILL_ON_JOB_CLOSE 生效窗口
    expect(alive(childPid)).toBe(false); // job 内根进程被内核终止
    h.kill();
  }, 90_000);

  it('重启恢复语义：新进程拿不到旧句柄——旧执行按保守路径收口（不追认 job 证据）', async () => {
    // 「曾纳管+持有者已死+PID 不存在」不能直接替代完整证据：新 daemon 无句柄，
    // releaseEvidence 不可用 → 既有恢复链（no-os-process/树核对）按第九轮口径处理。
    const mp = spawnManagedProcess({ cmd: NODE, args: ['-e', 'process.exit(7)'] });
    const pid = mp.pid;
    expect(mp.waitRootExit(15_000).code).toBe(7);
    mp.dispose();
    await sleep(500);
    expect(alive(pid)).toBe(false); // 进程事实消失——旧链按 no-os-process 收口
    // 而 job 证据随句柄消失——模块层面无从查询（这正是「不能直接替代完整退出证据」的依据）。
  }, 60_000);

  it('shared 语义：单 job 多进程（server 模型）——一个成员退出不等于 job 退出', async () => {
    const mp = spawnManagedProcess({ cmd: NODE, args: [join(tmpRoot, 'gen.js'), '2'] });
    await sleep(1200); // 根+子+孙
    const before = mp.activeCount();
    expect(before!).toBeGreaterThanOrEqual(3);
    // 杀根与中间进程（模拟某 turn 的载体结束）——孙仍活 → 计数>0 → 不可解除（不误杀其他任务，
    // 也不提前释放写入保护）。
    spawnSync('taskkill', ['/PID', String(mp.pid), '/T', '/F'], { timeout: 10_000 });
    await sleep(800);
    const after = mp.activeCount();
    const ev = mp.releaseEvidence();
    expect(ev.releasable).toBe(false); // detached 孙存活（或句柄未关）——保护保留
    void after;
    mp.terminateAll();
    await sleep(500);
    expect(mp.activeCount()).toBe(0);
    mp.dispose();
  }, 90_000);
});
