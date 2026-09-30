/**
 * 独立 Windows 本地验证（随独立交付包分发——只用包自带 Node 运行；本地/fake 子集）。
 * 范围：daemon 启动（原生依赖加载）/设置读写持久化/本地 fake 任务全链/正式关闭/同 appData
 * 重复启动/并发第二实例拒绝/重开设置保持/无残留。不装 Git/Node/Claude、不登 GitHub、
 * 不真实模型调用、不复制凭据。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const pkgRoot = resolve(import.meta.dirname, '..', '众说-便携-win-x64');
const daemonDir = join(pkgRoot, 'resources', 'app', 'daemon');
const results = [];
const record = (n, ok, d) => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? `：${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDaemon(appData, pipeName) {
  const child = spawn(join(daemonDir, 'node', 'node.exe'), [join(daemonDir, 'daemon.cjs')], {
    cwd: pkgRoot,
    env: { ...process.env, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1', ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_APP_DATA: appData, ZS_PIPE_NAME: pipeName },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  let exitInfo = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; }); // 等待期退出也不丢事实
  for (let i = 0; i < 100 && !err.includes('listening') && exitInfo == null; i += 1) await sleep(200);
  return { child, err: () => err, exitInfo: () => exitInfo };
}

function ipc(pipeName, appData) {
  return new Promise((res, rej) => {
    const token = readFileSync(join(appData, 'local.token'), 'utf8').trim();
    const sock = net.connect(`\\\\.\\pipe\\${pipeName}`);
    sock.setEncoding('utf8');
    let buf = '';
    let seq = 0;
    const pending = new Map();
    sock.on('connect', () => {
      sock.write(JSON.stringify({ type: 'auth', token }) + '\n');
      res({
        call(method, params, timeoutMs = 120_000) {
          return new Promise((res2, rej2) => {
            const id = `v-${seq++}-${randomUUID().slice(0, 8)}`;
            const t = setTimeout(() => rej2(new Error(`超时 ${method}`)), timeoutMs);
            pending.set(id, (r) => { clearTimeout(t); if (r.ok !== true) rej2(new Error(`${method}:${r.error?.message ?? '?'}`)); else res2(r.data); });
            sock.write(JSON.stringify({ protocolVersion: 1, commandId: id, method, params }) + '\n');
          });
        },
        end: () => sock.end(),
      });
    });
    sock.on('error', rej);
    sock.on('data', (c) => {
      buf += c;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
        if (line.length === 0) continue;
        try { const r = JSON.parse(line); if (r.commandId != null && pending.has(r.commandId)) { pending.get(r.commandId)(r); pending.delete(r.commandId); } } catch { /* 忽略 */ }
      }
    });
  });
}

const installRoot = mkdtempSync(join(tmpdir(), '众说独立验证-'));
try {
  const appData = join(installRoot, '应用数据');
  const d = await runDaemon(appData, 'zs-independent-1');
  record('daemon 启动（自带 Node+SQLite+koffi——原生依赖在本机可加载；受管默认开）', d.err().includes('listening'));
  const c = await ipc('zs-independent-1', appData);
  const opened = await c.call('project.open', { path: installRoot });
  const pid = opened.project.id;
  const member = `m_default_${pid}_0`;
  await c.call('app.settings.set', { key: 'repoStatus.visible', value: 'false' });
  const st = await c.call('app.settings.get', { keys: ['repoStatus.visible'] });
  record('设置读写持久化（app.settings）', st.values['repoStatus.visible'] === 'false');
  const t = await c.call('message.submit', { target: { kind: 'room_root', projectId: pid, conversationId: `conv_default_${pid}`, roomId: `room_default_${pid}` }, body: '本地 fake 任务', intent: 'default', mentions: [{ kind: 'member', memberId: member }] });
  let task = null;
  for (let i = 0; i < 120; i += 1) {
    task = await c.call('task.get', { taskId: t.taskId }, 30_000);
    if (['DONE', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(task.task.status)) break;
    await sleep(1000);
  }
  record('本地 fake 任务全链（提交→派发→DONE）', task.task.status === 'DONE', task.task.status);
  await c.call('daemon.shutdown', {});
  c.end();
  const exit1 = await new Promise((r) => { const t2 = setTimeout(() => r(null), 30_000); d.child.once('exit', (code) => { clearTimeout(t2); r(code); }); });
  record('正式关闭（daemon.shutdown→退出 0）', exit1 === 0, `exit=${exit1}`);
  // 同 appData 重复启动（锁随干净退出释放）。
  const d2 = await runDaemon(appData, 'zs-independent-2');
  record('同 appData 重复启动（单例锁已释放）', d2.err().includes('listening'));
  const c2 = await ipc('zs-independent-2', appData);
  const st2 = await c2.call('app.settings.get', { keys: ['repoStatus.visible'] });
  record('重开后设置保持', st2.values['repoStatus.visible'] === 'false');
  // 并发第二实例=单例拒绝（不污染第一实例）。
  const d3 = await runDaemon(appData, 'zs-independent-3');
  let exit3 = d3.exitInfo() != null ? d3.exitInfo().code : null;
  if (exit3 == null) exit3 = await new Promise((r) => { const t3 = setTimeout(() => r(null), 15_000); d3.child.once('exit', (code) => { clearTimeout(t3); r(code); }); });
  const tail3 = (d3.err().split('\n').filter(Boolean).slice(-1)[0] ?? '').slice(0, 80);
  record('并发第二实例被单例拒绝（退出≠0，不启动第二 daemon）', exit3 != null && exit3 !== 0, `exit=${exit3} stderr=${tail3}`);
  await c2.call('daemon.shutdown', {});
  c2.end();
  await new Promise((r) => { d2.child.once('exit', r); });
  await sleep(1200);
  const q = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "CommandLine != NULL" | Where-Object { $_.CommandLine -like '*${installRoot.replaceAll('\\', '/')}*' -and $_.ProcessId -ne $PID }).Count`], { encoding: 'utf8', timeout: 30_000 });
  record('无遗留进程（安装根路径匹配）', (q.stdout ?? '').trim() === '0', `count=${(q.stdout ?? '').trim()}`);
} catch (e) {
  console.error(`中止：${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
}
writeFileSync(join(installRoot, '独立验证结果.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2), 'utf8');
console.log(`结果文件：${join(installRoot, '独立验证结果.json')}`);
if (!results.every((r) => r.ok)) {
  console.log(`保留诊断目录：${installRoot}`);
  process.exitCode = 1;
} else {
  try { rmSync(installRoot, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
}
