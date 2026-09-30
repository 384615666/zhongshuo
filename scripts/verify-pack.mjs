/**
 * DEV-15 打包验证 v2（第十四轮三重写——修复第十三轮版的假通过条件）：
 *
 * 假通过修复：
 * - 「优雅退出」=正式关闭动作（daemon.shutdown IPC 命令→优雅→强制）+退出码 0 严格确认；
 *   status=null（超时）/signal/spawn error 各自单独分类，一律不算成功；
 * - nmOverride 实际生效（第十三轮版传在第四参被忽略）：移除后 existsSync 断言确实移除；
 * - 负例证明 SQLite 仍可加载（安装目录 sqlite 探针 OK）且失败来自受管依赖缺失
 *   （stderr 含「拒绝启动」、不含 better-sqlite3 错误）；
 * - 正例**调用 bundle 内受管功能**：ZS_MANAGED_RUNTIME=1 启动（koffi 在 bundle 内加载）+
 *   claude 成员绑定 fixture CLI → 受管桥真实进程 turn（stdin EOF/输出）→ task.stop 停止 →
 *   截止 UNKNOWN→reconcile→releaseProtection 受管证据解除 → daemon.shutdown → 退出 0 →
 *   无遗留进程（按 fixture 路径查 Win32_Process）+ 直查 SQLite 断言 managed_job_id；
 * - koffi 平台包路径按实际版本解析（读 node_modules/koffi/package.json——不硬编码 3.3.2）；
 * - 报告如实分层：运行时=开发机 Node（process.execPath）在独立目录+干净 PATH 运行；
 *   「不依赖开发机运行时的安装产物」未验证（独立 Windows 运行时条件见报告 note）。
 *
 * 失败保留 installRoot 与报告；成功按明确范围清理（installRoot）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist', 'pack');
const artifact = join(dist, 'daemon.cjs');
if (!existsSync(artifact)) {
  console.error('[verify-pack] 缺产物：先运行 node scripts/pack-daemon.mjs');
  process.exit(1);
}

/** 安装目录：中文+空格路径（DEV-15 验收项）。 */
const installRoot = mkdtempSync(join(tmpdir(), '装机 目录-'));
const appDir1 = join(installRoot, '应用 数据', '实例一');
const appDir2 = join(installRoot, '应用 数据', '实例二');
const fixtureDir = join(installRoot, 'zs-pack-fixture');
mkdirSync(appDir1, { recursive: true });
mkdirSync(appDir2, { recursive: true });
mkdirSync(fixtureDir, { recursive: true });
cpSync(artifact, join(installRoot, '众说 daemon.cjs'));

/** 最小 node_modules：原生依赖按实际安装解析（版本读自 node_modules/koffi/package.json）。 */
const nm = join(installRoot, 'node_modules');
mkdirSync(nm, { recursive: true });
const koffiVersion = JSON.parse(readFileSync(join(repo, 'node_modules', 'koffi', 'package.json'), 'utf8')).version;
for (const dep of ['koffi', 'better-sqlite3', '@koromix']) {
  const src = join(repo, 'node_modules', dep);
  if (!existsSync(src)) continue;
  cpSync(realpathSync(src), join(nm, dep), { recursive: true, dereference: true });
}
// koffi 平台二进制=同包 @koromix/koffi-win32-x64（pnpm 装在 .pnpm/koffi@<version>/ 下）——按实际版本带出。
{
  const scopedSrc = join(repo, 'node_modules', '.pnpm', `koffi@${koffiVersion}`, 'node_modules', '@koromix');
  if (!existsSync(scopedSrc)) {
    console.error(`[verify-pack] koffi 平台包目录不存在：${scopedSrc}（版本解析失败——不静默跳过）`);
    process.exit(1);
  }
  mkdirSync(join(nm, '@koromix'), { recursive: true });
  cpSync(scopedSrc, join(nm, '@koromix'), { recursive: true, dereference: true });
}
for (const dep of ['koffi', 'better-sqlite3']) {
  if (!existsSync(join(nm, dep, 'package.json'))) {
    console.error(`[verify-pack] ${dep} 复制不完整`);
    process.exit(1);
  }
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pipeOf = (name) => `\\\\.\\pipe\\${name}`;
const appendFile = (path, text) => { try { appendFileSync(path, text); } catch { /* 诊断日志尽力而为 */ } };

/** 干净环境（脱离开发 PATH/源码 cwd；保留系统必需）。 */
const cleanEnv = (extra) => ({
  SystemRoot: process.env.SystemRoot,
  SystemDrive: process.env.SystemDrive,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : undefined,
  ...extra,
});

/**
 * 启动产物并等待 listening（不吞启动失败：退出/超时/无 listening 各自如实报告）。
 * 返回 {child, exited, exitInfo}——exited=true 表示启动即退出（=失败）。
 */
async function startPackedDaemon(pipeName, appData, extraEnv, timeoutMs = 30_000) {
  const logPath = join(installRoot, `daemon-${pipeName}.log`);
  const child = spawn(process.execPath, [join(installRoot, '众说 daemon.cjs')], {
    cwd: installRoot,
    env: cleanEnv({ ZS_PACKED_ENTRY: '1', ZS_APP_DATA: appData, ZS_PIPE_NAME: pipeName, ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let listening = false;
  let exited = false;
  let exitInfo = null;
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; appendFile(logPath, c); if (stderr.includes(`listening ${pipeOf(pipeName)}`)) listening = true; });
  child.stdout.on('data', (c) => { stderr += c; appendFile(logPath, c); });
  child.on('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; });
  const deadline = Date.now() + timeoutMs;
  while (!listening && !exited && Date.now() < deadline) await sleep(100);
  return { child, exited, exitInfo, get stderr() { return stderr; }, get listening() { return listening; } };
}

/** 退出确认（严格：code===0 且无 signal 且未超时；超时=null 分类，不算成功）。 */
async function waitExit(child, timeoutMs) {
  return await new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true, code: null, signal: null }); } }, timeoutMs);
    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal });
    });
  });
}

/** 命名管道 IPC 客户端（auth 首帧+行 JSON+commandId 配对）。 */
async function connectIpc(pipeName, appData) {
  const token = readFileSync(join(appData, 'local.token'), 'utf8').trim();
  const sock = net.connect(pipeOf(pipeName));
  const pending = new Map();
  let buf = '';
  let nextSeq = 0;
  await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
      if (line.length === 0) continue;
      try {
        const resp = JSON.parse(line);
        if (resp.commandId != null && pending.has(resp.commandId)) pending.get(resp.commandId)(resp);
      } catch { /* 非 JSON 行忽略 */ }
    }
  });
  sock.write(JSON.stringify({ type: 'auth', token }) + '\n');
  return {
    call(method, params, timeoutMs = 60_000) {
      const commandId = `vc-${nextSeq++}-${randomUUID().slice(0, 8)}`;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => { pending.delete(commandId); rej(new Error(`IPC 超时：${method}`)); }, timeoutMs);
        pending.set(commandId, (resp) => { clearTimeout(timer); res(resp); });
        sock.write(JSON.stringify({ protocolVersion: 1, commandId, method, params }) + '\n');
      });
    },
    end() { sock.end(); },
  };
}
const unwrap = (resp, what) => {
  if (resp == null || resp.ok !== true) throw new Error(`${what} 失败：${resp?.error?.message ?? JSON.stringify(resp).slice(0, 200)}`);
  return resp.data;
};

/** 只读轮询 SQLite（daemon 运行中——WAL 并发读；退出后可完全打开）。 */
function openStateReadonly(appData) {
  const Database = createRequire(join(repo, 'node_modules', 'better-sqlite3'))('better-sqlite3');
  const path = join(appData, 'state.sqlite');
  try {
    return new Database(path, { readonly: true });
  } catch {
    return new Database(path); // wal/shm 缺席时回退普通打开（只读用途）
  }
}

let failed = false;
try {
  // ---------- ① 启动/依赖/正式关闭（中文+空格安装目录，干净 PATH；受管 ON=koffi 在 bundle 内加载） ----------
  {
    const d = await startPackedDaemon('zs-pack-verify-1', appDir1, { ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_MANAGED_RUNTIME: '1' });
    record('daemon 启动（中文+空格安装目录/干净 PATH/SQLite+koffi-bundle 内可加载）', d.listening,
      d.listening ? 'listening 行已出现（ZS_MANAGED_RUNTIME=1——koffi 于 bundle 内加载成功否则拒绝启动）' : `启动即退或超时：exit=${JSON.stringify(d.exitInfo)} stderr=${d.stderr.slice(-300)}`);
    if (!d.listening) throw new Error('① 启动失败——中止后续检查');
    const ipc = await connectIpc('zs-pack-verify-1', appDir1);
    const ack = unwrap(await ipc.call('daemon.shutdown', {}), 'daemon.shutdown');
    ipc.end();
    const ex = await waitExit(d.child, 30_000);
    record('正式关闭（daemon.shutdown→优雅→退出 0；超时/signal/退出码≠0 均不算成功）',
      ex.code === 0 && ex.signal == null && !ex.timedOut,
      `ack=${ack.accepted === true} exit=${JSON.stringify(ex)} stopRecord=${readFileSync(join(appDir1, 'state.sqlite'), 'utf8').length > 0 ? 'db 存在' : '缺 db'}`);
    if (ex.code !== 0 || ex.signal != null || ex.timedOut) throw new Error('① 正式关闭失败——中止');
    record('pid 文件随干净退出移除（崩溃现场保留语义的反向确认）', !existsSync(join(appDir1, 'daemon.pid')), `daemon.pid=${existsSync(join(appDir1, 'daemon.pid')) ? '仍存在' : '已移除'}`);
  }

  // ---------- ② 正式链：受管 fixture 全链（IPC 驱动：任务→受管桥真实进程→停止→UNKNOWN→证据解除→关闭） ----------
  {
    // fixture：claude shim（.cmd→node+js——resolveClaudeExecutable 正式解析路径）。
    // 生命周期日志落盘（诊断打包链停摆点；成功用例也保留——打包链证据）。
    writeFileSync(join(fixtureDir, 'fixture-cli.js'), `
const { appendFileSync } = require('node:fs');
const LOG = (m) => { try { appendFileSync(${JSON.stringify(join(fixtureDir, 'fixture.log'))}, Date.now() + ' ' + process.pid + ' ' + m + '\\n'); } catch {} };
const args = process.argv.slice(2);
LOG('start args=' + args.join(' ').slice(0, 80));
if (args.includes('--version')) { process.stdout.write('1.0.0 zs-fixture'); LOG('version-end'); process.exit(0); }
const chunks = [];
process.stdin.on('data', (c) => { chunks.push(c); LOG('stdin-data+' + c.length); });
process.stdin.on('end', () => {
  LOG('stdin-end');
  const input = Buffer.concat(chunks).toString('utf8');
  const m = /"resultKey":"(result_[0-9a-zA-Z_-]+)"/.exec(input);
  const resultKey = m != null ? m[1] : 'result_missing';
  const text = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey, changeSummary: '打包验证受管回放', files: [], executedVerifications: ['stdin 合同解析'], unexecutedVerifications: [], remainingIssues: [] });
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '受管回放输出', id: 'cm1' }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cs_pack', result: text, model: 'deepseek-flash', usage: { input_tokens: 5, output_tokens: 2 } }) + '\\n');
  LOG('stdout-written');
  process.exit(0);
});
`, 'utf8');
    // 截止后自行退出（16s>截止 12s）：制造「截止 UNKNOWN→迟到退出→受管证据解除」正式场景。
    writeFileSync(join(fixtureDir, 'fixture-deadline.js'), `
process.stdin.resume();
setTimeout(() => process.exit(0), 16000);
`, 'utf8');
    writeFileSync(join(fixtureDir, 'claude-fixture.cmd'), '@"%dp0%\\fixture-cli.js" %*\r\n', 'utf8');
    writeFileSync(join(fixtureDir, 'claude-deadline.cmd'), '@"%dp0%\\fixture-deadline.js" %*\r\n', 'utf8');

    const d = await startPackedDaemon('zs-pack-verify-2', appDir2, {
      ZS_RUNTIME: 'claude', ZS_CLAUDE_MODEL: 'deepseek-flash', ZS_MANAGED_RUNTIME: '1',
      ZS_TURN_DEADLINE_MS: '12000', ZS_APP_DATA: appDir2,
    });
    record('受管 daemon 启动（ZS_MANAGED_RUNTIME=1+claude）', d.listening, d.listening ? 'listening' : `exit=${JSON.stringify(d.exitInfo)} stderr=${d.stderr.slice(-200)}`);
    if (!d.listening) throw new Error('② 启动失败——中止');
    const ipc = await connectIpc('zs-pack-verify-2', appDir2);

    const opened = unwrap(await ipc.call('project.open', { path: fixtureDir, displayName: '打包验证项目' }), 'project.open');
    const projectId = opened.project.id;
    const memberId = `m_default_${projectId}_0`;
    const roomId = `room_default_${projectId}`;
    const convId = `conv_default_${projectId}`;
    unwrap(await ipc.call('project.reviewPolicy.set', { projectId, taskReviewEnabled: false, expectedRevision: opened.project.revision ?? 0 }), 'project.reviewPolicy.set');
    unwrap(await ipc.call('member.setRuntime', { memberId, kind: 'claude', model: 'deepseek-flash', executable: join(fixtureDir, 'claude-fixture.cmd') }), 'member.setRuntime(fixture)');
    const submit = (body) => ipc.call('message.submit', { target: { kind: 'room_root', projectId, conversationId: convId, roomId }, body, intent: 'default', mentions: [{ kind: 'member', memberId }] });

    // (a) 正常完成：受管桥真实进程 turn（stdin EOF+输出经 Job Object 子进程）。
    // 轮询须等到真终态（OPEN→ACTIVE→DONE；不能在 OPEN 即退出——派发尚未发生）。
    const r1 = unwrap(await submit('打包验证任务一：按合同完成'), 'message.submit#1');
    const taskId1 = r1.taskId;
    let task1 = null;
    for (let i = 0; i < 150; i += 1) {
      task1 = unwrap(await ipc.call('task.get', { taskId: taskId1 }), 'task.get#1');
      if (['DONE', 'BLOCKED', 'CANCELLED'].includes(task1.task.status)) break;
      await sleep(400);
    }
    record('受管 turn 完成（fixture 真实进程：stdin EOF 合同解析→结构化结果→任务 DONE）', task1?.task?.status === 'DONE', `task=${task1?.task?.status}`);

    // 切换成员绑定到长驻 fixture（停止/截止场景共用——设置只影响之后派发的 turn）。
    unwrap(await ipc.call('member.setRuntime', { memberId, kind: 'claude', model: 'deepseek-flash', executable: join(fixtureDir, 'claude-deadline.cmd') }), 'member.setRuntime(deadline)');
    const rdb = openStateReadonly(appDir2);

    // (b) 停止：submit#2 → RUNNING → task.stop→interrupt→受管 job 终止 → CANCELLED。
    const r2 = unwrap(await submit('打包验证任务二：长驻待停'), 'message.submit#2');
    const taskId2 = r2.taskId;
    let task2 = null;
    for (let i = 0; i < 100; i += 1) {
      task2 = unwrap(await ipc.call('task.get', { taskId: taskId2 }), 'task.get#2');
      if (task2.activeRun != null && task2.activeRun.status === 'RUNNING') break;
      await sleep(200);
    }
    unwrap(await ipc.call('task.stop', { taskId: taskId2, targetRunId: task2.activeRun?.id, expectedStopGeneration: task2.task.stopGeneration ?? 0 }), 'task.stop');
    let cancelled = null;
    for (let i = 0; i < 100; i += 1) {
      cancelled = unwrap(await ipc.call('task.get', { taskId: taskId2 }), 'task.get#2b');
      if (cancelled.task.status === 'CANCELLED') break;
      await sleep(300);
    }
    record('task.stop→受管 job 终止→任务 CANCELLED', cancelled.task.status === 'CANCELLED', `task2=${cancelled.task.status}`);

    // (c) 截止 UNKNOWN→迟到退出→reconcile→releaseProtection 受管证据解除。
    const r3 = unwrap(await submit('打包验证任务三：截止'), 'message.submit#3');
    const taskId3 = r3.taskId;
    let turn3 = null;
    for (let i = 0; i < 200; i += 1) { // ≤12s 截止+缓冲
      turn3 = rdb.prepare(`SELECT t.id AS turnId, t.status FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? ORDER BY t.id DESC LIMIT 1`).get(taskId3) ?? null;
      if (turn3 != null && turn3.status === 'UNKNOWN') break;
      await sleep(300);
    }
    record('截止→turn UNKNOWN（保护保留）', turn3?.status === 'UNKNOWN', `turn=${turn3?.status}`);
    for (let i = 0; i < 80; i += 1) { // fixture 16s 自行退出（迟到退出）→bridge close→证据就绪
      const gone = spawnSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*fixture-deadline*' }).Count`], { encoding: 'utf8', timeout: 15_000 });
      if (Number((gone.stdout ?? '').trim()) === 0) {
        await sleep(1500); // 退出后系统清理延迟（ActiveProcesses 归零必要条件）
        break;
      }
      await sleep(500);
    }
    unwrap(await ipc.call('recovery.reconcile', { turnId: turn3.turnId, verdict: 'executed', note: '打包验证：截止后迟到退出对账' }), 'recovery.reconcile');
    const probe = unwrap(await ipc.call('recovery.probeProcess', { turnId: turn3.turnId }), 'recovery.probeProcess');
    // 本配置 turn 无工作区租约（只读执行）→ releaseProtection 走正式入口=幂等 no-op
    //（受管证据解除含租约的完整路径由 managedIdentity/managedBridge 集成测试覆盖）。
    const rel = unwrap(await ipc.call('recovery.releaseProtection', { turnId: turn3.turnId, note: '打包验证：受管证据入口' }), 'recovery.releaseProtection');
    const turn3After = rdb.prepare(`SELECT status, budget_mark FROM agent_turns WHERE id = ?`).get(turn3.turnId) ?? {};
    record('截止恢复链（reconcile 保留保护→probe 受管观察=根已退+计数 0→releaseProtection 正式入口）',
      probe.result === 'unknown' && String(probe.detail ?? '').includes('活跃计数 0')
        && rel.stateChanged === false && turn3After.status === 'UNKNOWN' && turn3After.budget_mark === 'settled',
      `probe=${probe.result}/${String(probe.detail ?? '').slice(0, 40)} rel=${rel.stateChanged} turn=${turn3After.status}/${turn3After.budget_mark}`);
    rdb.close();

    // (d) 正式关闭 + 退出确认。
    unwrap(await ipc.call('daemon.shutdown', {}), 'daemon.shutdown#2');
    ipc.end();
    const ex = await waitExit(d.child, 40_000);
    record('受管 daemon 正式关闭（退出 0）', ex.code === 0 && ex.signal == null && !ex.timedOut, `exit=${JSON.stringify(ex)}`);

    // (e) 无遗留进程（按 fixture 路径查 Win32_Process——精确到本验证产物）。
    const left = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*zs-pack-fixture*' }).Count`], { encoding: 'utf8', timeout: 15_000 });
    record('无遗留受管 fixture 进程（Win32_Process 命令行核对）', Number((left.stdout ?? '').trim()) === 0, `count=${(left.stdout ?? '').trim()}`);

    // (f) 直查 SQLite：登记=managed-job+managed_job_id 正式列；turn 终态齐。
    const Database = createRequire(join(repo, 'node_modules', 'better-sqlite3'))('better-sqlite3');
    const db = new Database(join(appDir2, 'state.sqlite'), { readonly: true });
    const regs = db.prepare(`SELECT identity_source, managed_job_id, closed_at FROM runtime_process_registry`).all();
    const turns = db.prepare(`SELECT status, count(*) c FROM agent_turns GROUP BY status`).all();
    db.close();
    record('登记受管身份（managed-job+managed_job_id 正式列+终态收口）',
      regs.length >= 2 && regs.every((r) => r.identity_source === 'managed-job' && /^job-/.test(r.managed_job_id ?? '')),
      `rows=${JSON.stringify(regs)} turns=${JSON.stringify(turns)}`);
    const stopRec = (() => {
      const Database2 = createRequire(join(repo, 'node_modules', 'better-sqlite3'))('better-sqlite3');
      const d2 = new Database2(join(appDir2, 'state.sqlite'), { readonly: true });
      const v = d2.prepare(`SELECT value FROM daemon_state WHERE key='daemon:stop:last'`).get();
      d2.close();
      return v == null ? null : JSON.parse(v.value);
    })();
    record('daemon:stop:last 记录 phase=closed（确认结果可查）', stopRec?.phase === 'closed', `phase=${stopRec?.phase}`);
  }

  // ---------- ③ 负例：受管依赖缺失=拒绝启动不降级（且 SQLite 仍可加载——失败确来自受管依赖） ----------
  {
    rmSync(join(nm, 'koffi'), { recursive: true, force: true });
    rmSync(join(nm, '@koromix'), { recursive: true, force: true });
    const removed = !existsSync(join(nm, 'koffi')) && !existsSync(join(nm, '@koromix'));
    record('精确移除受管依赖（koffi+@koromix；better-sqlite3 保留）', removed, `koffi=${existsSync(join(nm, 'koffi'))} @koromix=${existsSync(join(nm, '@koromix'))}`);
    if (!removed) throw new Error('③ 移除失败——中止');
    // sqlite 探针：安装目录内 better-sqlite3 仍可加载（失败不来自 SQLite）。
    writeFileSync(join(installRoot, 'sqlite-probe.cjs'), "try { const D = require('better-sqlite3'); const d = new D(':memory:'); d.exec('create table t(x)'); console.log('SQLITE_OK'); } catch (e) { console.log('SQLITE_FAIL ' + e.message); }", 'utf8');
    const sq = spawnSync(process.execPath, [join(installRoot, 'sqlite-probe.cjs')], { cwd: installRoot, env: cleanEnv({ NODE_PATH: nm }), encoding: 'utf8', timeout: 20_000 });
    record('负例前提：安装目录 SQLite 仍可加载', (sq.stdout ?? '').includes('SQLITE_OK'), `${(sq.stdout ?? '').trim().slice(0, 80)}`);
    // koffi 探针（依赖缺失辅助证据）。
    writeFileSync(join(installRoot, 'koffi-probe.cjs'), "try { require('koffi'); console.log('KOFFI_OK'); } catch (e) { console.log('KOFFI_FAIL'); }", 'utf8');
    const kp = spawnSync(process.execPath, [join(installRoot, 'koffi-probe.cjs')], { cwd: installRoot, env: cleanEnv({ NODE_PATH: nm }), encoding: 'utf8', timeout: 20_000 });
    record('负例前提：koffi 探针失败（依赖确实缺席）', (kp.stdout ?? '').includes('KOFFI_FAIL'), `${(kp.stdout ?? '').trim().slice(0, 60)}`);
    // 产物启动：受管 ON+依赖缺失 → 必须失败且明确拒绝（不静默降级）。
    const d = await startPackedDaemon('zs-pack-verify-3', appDir1, { ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_MANAGED_RUNTIME: '1' }, 20_000);
    const ex = d.exited ? d.exitInfo : await waitExit(d.child, 15_000);
    const refused = ex.code != null && ex.code !== 0 && ex.signal == null
      && d.stderr.includes('拒绝启动') && !/better-sqlite3|SQLITE_/i.test(d.stderr);
    record('受管依赖缺失=拒绝启动不降级（退出码≠0+stderr 拒绝；非 SQLite 错误）', refused,
      `exit=${JSON.stringify(ex)} refuseLine=${(d.stderr.split('\n').filter((l) => l.includes('拒绝启动'))[0] ?? '').slice(0, 160)}`);
    if (d.child.exitCode == null && !d.exited) d.child.kill();
  }
} catch (error) {
  failed = true;
  console.error(`[verify-pack] 中止：${error instanceof Error ? error.stack : String(error)}`);
}

const allPassed = results.length > 0 && results.every((r) => r.ok);
const report = {
  builtAt: new Date().toISOString(),
  installRoot,
  results,
  allPassed,
  runtimeLayer: {
    node: process.execPath,
    nodeVersion: process.version,
    note: '运行时=开发机 Node（process.execPath）在独立安装目录+干净 PATH 下运行——「不依赖开发机运行时的安装产物」（独立 Windows 环境/自带 Node 的壳）本轮未验证',
  },
  koffiPlatformPackage: { version: koffiVersion },
};
writeFileSync(join(dist, 'verify-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`[verify-pack] ${allPassed ? '全部通过' : '存在失败'}；报告=${join(dist, 'verify-report.json')}`);
if (allPassed && !failed) {
  rmSync(installRoot, { recursive: true, force: true });
  console.log(`[verify-pack] 成功清理 installRoot=${installRoot}`);
} else {
  console.log(`[verify-pack] 失败——保留诊断目录：${installRoot}`);
}
process.exit(allPassed && !failed ? 0 : 1);
