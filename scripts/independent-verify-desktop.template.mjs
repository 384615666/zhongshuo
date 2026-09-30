/**
 * 独立 Windows 自动桌面验证（renderer 级 CDP）——随独立交付包分发，用包自带 Node+包内
 * Electron 运行（不依赖开发仓库/开发 PATH）。真实页面操作：打开项目（ZS_PICK_FOLDER 钩子）、
 * 发送、线程回复、成员绑定真实 runtime（配置保存）→ 发送=**真实派发防护拒绝**（spawn 零——
 * 第十六轮四硬隔离的端到端复核）、停机事实、重开绑定保持、停止闭环（独立 appData+stall）。
 * 本脚本运行于 ZS_REAL_DISPATCH_GUARD=1：任何真实 runtime 派发都会在 spawn 前被拒绝。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const deliverRoot = resolve(import.meta.dirname, '..');
const pkgRoot = join(deliverRoot, '众说-便携-win-x64');
const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
const resultDir = join(deliverRoot, '验证结果', `desktop-${stamp}-${randomUUID().slice(0, 4)}`);
mkdirSync(resultDir, { recursive: true });
const tempRoot = mkdtempSync(join(tmpdir(), '众说桌面验证-'));
const fixtureProj = join(tempRoot, '演示项目');
mkdirSync(fixtureProj, { recursive: true });
writeFileSync(join(fixtureProj, 'notes.md'), '# 演示\n\n暗号：IND-DESKTOP-3355\n', 'utf8');

const PLAN = ['cdp-page', 'open-project', 'fake-send-done', 'bind-real-reject', 'shutdown-1', 'reopen-persist', 'stop-cancelled', 'shutdown-2', 'residual-zero'];
const state = { executed: [], failed: [], pending: [...PLAN], exception: null };
const check = async (id, fn) => {
  state.pending = state.pending.filter((x) => x !== id);
  state.executed.push(id);
  try { const d = await fn(); console.log(`PASS ${id}${d ? `：${d}` : ''}`); return true; } catch (e) {
    state.failed.push({ id, message: e instanceof Error ? e.message : String(e) });
    console.log(`FAIL ${id}：${state.failed[state.failed.length - 1].message.slice(0, 200)}`);
    return false;
  }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buildIdentity = (() => { try { return JSON.parse(readFileSync(join(pkgRoot, 'BUILD.json'), 'utf8')); } catch { return { buildId: null }; } })();
const kids = [];
async function launchApp(port, appData, extraEnv = {}) {
  const child = spawn(join(pkgRoot, 'electron.exe'), [`--remote-debugging-port=${port}`], {
    cwd: pkgRoot,
    env: { ...process.env, ZS_APP_DATA: appData, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PICK_FOLDER: fixtureProj, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100; i += 1) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
    if (Array.isArray(list) && list.some((t) => String(t.url).includes('index.html'))) return { child, stderr: () => stderr };
    if (child.exitCode != null) break;
    await sleep(300);
  }
  return { child, stderr: () => stderr, noPage: true };
}
async function connectPage(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const ws = new WebSocket(list.find((t) => String(t.url).includes('index.html')).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push('exception');
  });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const v = r.result?.result;
    if (v?.subtype === 'error') throw new Error(String(v.description).slice(0, 160));
    return v?.value;
  };
  return { evalJs, pageErrors: () => pageErrors, close: () => ws.close() };
}
const waitFor = async (fn, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn() === true) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(400);
  }
};
const closeApp = async (app) => new Promise((res) => {
  const t = setTimeout(() => res({ code: null, signal: null, outcome: 'timeout' }), 40_000);
  app.child.once('exit', (code, signal) => { clearTimeout(t); res({ code, signal, outcome: 'exited' }); });
  spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.child.pid}).CloseMainWindow()`], { timeout: 15_000 });
});

const appDataA = join(tempRoot, '应用数据A');
const appDataB = join(tempRoot, '应用数据B-停止');
let appA = null;
try {
  { // 会话 A：主链。
    const port = 9341;
    appA = await launchApp(port, appDataA);
    assert(appA.noPage !== true, 'Electron 页面未就绪（CDP）');
    const page = await connectPage(port);
    await check('cdp-page', async () => { assert(await page.evalJs('typeof window.zs') === 'object', 'window.zs 缺失（preload 失败）'); return 'renderer+preload 就绪'; });
    await page.evalJs(`document.getElementById('open-folder').click()`);
    await check('open-project', async () => {
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)) === true, 30_000, '项目打开');
      return 'open-folder（目录钩子）→项目打开';
    });
    await page.evalJs(`(() => { document.getElementById('composer-input').value = '请读取 notes.md 报出暗号'; document.getElementById('send').click(); })()`);
    await check('fake-send-done', async () => {
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length > 0`)) === true, 20_000, '池卡片');
      await page.evalJs(`(() => { document.querySelector('#pool .pool-card').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-messages').textContent.includes('完成') || document.getElementById('thread-status').textContent.includes('已完成')`)) === true, 90_000, 'fake 完成');
      return 'fake 成员回复+任务已完成';
    });
    // 成员绑定真实 runtime（配置允许保存）→ 发送必须被防护拒绝（真实 spawn=0）。
    await page.evalJs(`document.getElementById('project-settings').open = true`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('未绑定')`)) === true, 20_000, '绑定区');
    await page.evalJs(`[...document.querySelectorAll('#member-runtime-list button.chip')].find((b) => b.textContent === '绑定…').click()`);
    await page.evalJs(`(() => { const sel = document.querySelector('.member-runtime-edit select'); sel.value = 'claude'; sel.dispatchEvent(new Event('change')); document.querySelector('.member-runtime-edit input').value = 'deepseek-flash'; })()`);
    await page.evalJs(`[...document.querySelectorAll('.member-runtime-edit button.chip')].find((b) => b.textContent === '保存').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('claude · deepseek-flash')`)) === true, 20_000, '绑定保存');
    await page.evalJs(`document.getElementById('thread-back-btn')?.click()`);
    const cardsBefore = await page.evalJs(`document.querySelectorAll('#pool .pool-card').length`);
    await page.evalJs(`(() => { document.getElementById('composer-input').value = '故意发给持久 claude 绑定'; document.getElementById('send').click(); })()`);
    await check('bind-real-reject', async () => {
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length > ${Number(cardsBefore)}`)) === true, 20_000, '新任务卡片出现（数量增加——旧卡不满足）');
      await page.evalJs(`(() => { document.querySelector('#pool .pool-card').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-status').textContent.includes('验收防护') || document.getElementById('thread-messages').textContent.includes('验收防护') || document.getElementById('send-error').textContent.includes('防护')`)) === true, 60_000, '防护拒绝可见');
      return '真实派发防护拒绝（spawn 前拒绝——配置保存成功但派发失败如实显示）';
    });
    assert(page.pageErrors().length === 0, 'renderer 存在未捕获异常');
    page.close();
    await check('shutdown-1', async () => {
      const ex = await closeApp(appA);
      const facts = JSON.parse(readFileSync(join(appDataA, 'desktop-shutdown.json'), 'utf8'));
      assert(ex.code === 0 && facts.exitCode === 0 && facts.daemonStopResult?.complete === true, `exit=${JSON.stringify(ex)} facts=${JSON.stringify(facts).slice(0, 120)}`);
      return '优雅停机事实（exit 0+complete）';
    });
  }
  { // 会话 B：重开绑定保持。
    const port = 9342;
    const app = await launchApp(port, appDataA);
    const page = await connectPage(port);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)) === true, 30_000, '重开');
    await page.evalJs(`document.getElementById('project-settings').open = true`);
    await check('reopen-persist', async () => {
      await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('claude · deepseek-flash')`)) === true, 20_000, '绑定保持');
      return '同 appData 重开：真实绑定持久（且防护仍开——不会真实派发）';
    });
    page.close();
    const ex = await closeApp(app);
    assert(ex.code === 0, `重开退出=${ex.code}`);
  }
  { // 会话 C：停止闭环（独立 appData+stall）。
    const port = 9343;
    const app = await launchApp(port, appDataB, { ZS_FAKE_STALL_MS: '15000' });
    const page = await connectPage(port);
    await page.evalJs(`document.getElementById('open-folder').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)) === true, 30_000, 'C 项目打开');
    await page.evalJs(`(() => { document.getElementById('composer-input').value = '长驻（将被停止）'; document.getElementById('send').click(); })()`);
    await check('stop-cancelled', async () => {
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length > 0`)) === true, 20_000, '池卡片');
      await page.evalJs(`(() => { document.querySelector('#pool .pool-card').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('stop-btn').classList.contains('hidden') === false`)) === true, 20_000, '停止按钮');
      await page.evalJs(`document.getElementById('stop-btn').click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-messages').textContent.includes('已停止') || document.getElementById('thread-status').textContent.includes('已停止')`)) === true, 60_000, '已停止');
      return 'stop-btn→CANCELLED';
    });
    page.close();
    await check('shutdown-2', async () => {
      const ex = await closeApp(app);
      const facts = JSON.parse(readFileSync(join(appDataB, 'desktop-shutdown.json'), 'utf8'));
      assert(ex.code === 0 && facts.daemonStopResult?.complete === true, `exit=${ex.code}`);
      return '停止场景优雅停机';
    });
  }
  await check('residual-zero', async () => {
    await sleep(1500);
    // 统一协议 v2：与独立本地验证同一 PS 查询（QUERY-OK 尾标+显式排除验证器自身/辅助/已跟踪
    // 子进程——不靠相对路径"碰巧匹配不到"；第十八轮一 Git Bash 自身误报修正）。
    const PROC_QUERY_PS = `$ErrorActionPreference = "Stop"
$Pattern = $env:ZS_PROC_PATTERN
$Alt = $env:ZS_PROC_PATTERN_ALT
$Exclude = @($env:ZS_PROC_EXCLUDE -split ',' | Where-Object { $_ -ne '' })
try {
  $p = Get-CimInstance Win32_Process -Filter "CommandLine != NULL" | Where-Object { (($_.CommandLine -like $Pattern) -or ($Alt -ne "" -and $_.CommandLine -like $Alt)) -and $_.ProcessId -ne $PID -and $Exclude -notcontains [string]$_.ProcessId }
  $p | ForEach-Object { "$($_.ProcessId)" + [char]9 + "$($_.Name)" }
  "QUERY-OK"
} catch { "ERR" + [char]9 + $_.Exception.Message }
`;
    const psQueryPath = join(resultDir, 'proc-query.ps1');
    writeFileSync(psQueryPath, PROC_QUERY_PS, 'utf8');
    const exclude = [process.pid, process.ppid, ...kids.map((k) => k.pid)].filter((p) => p != null).join(',');
    const query = (pattern) => {
      const alt = pattern.replaceAll('\\', '/');
      const q = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psQueryPath], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ZS_PROC_PATTERN: pattern, ZS_PROC_PATTERN_ALT: alt !== pattern ? alt : '', ZS_PROC_EXCLUDE: exclude } });
      const out = (q.stdout ?? '').trim();
      if (q.status !== 0 || q.error != null || !out.includes('QUERY-OK') || out.includes('ERR\t')) throw new Error(`进程查询无法确认（${out.slice(0, 60) || '空'}）——按未验证处理`);
      return out.split('\n').filter((l) => /^\d+\t/.test(l.trim())).length;
    };
    const tempCount = query(`*${tempRoot.replaceAll('\\', '/')}*`);
    assert(tempCount === 0, `临时目录残留 ${tempCount} 个`);
    const pkgCount = query(`*${pkgRoot.replaceAll('\\', '/')}*`);
    assert(pkgCount === 0, `包路径残留 ${pkgCount} 个`);
    return '零残留（自身/辅助/已收拢子进程显式排除）';
  });
} catch (error) {
  state.exception = error instanceof Error ? `${error.message}` : String(error);
  console.error(`[verify-desktop-local] 中止：${state.exception}`);
  for (const k of kids) { if (k.exitCode == null) { try { k.kill(); } catch { /* 尽力 */ } } }
} finally {
  if (state.failed.length === 0 && state.exception == null && state.executed.length === PLAN.length) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
}
const overall = state.executed.length === PLAN.length && state.failed.length === 0 && state.exception == null;
writeFileSync(join(resultDir, 'summary.json'), JSON.stringify({ overall, expectedChecks: PLAN.length, executedChecks: state.executed.length, failed: state.failed, notExecuted: state.pending, exception: state.exception, buildIdentity, resultDir, generatedAt: new Date().toISOString() }, null, 2), 'utf8');
console.log('----------------------------------------');
console.log(`整体：${overall ? '通过' : '未通过'}（预期 ${PLAN.length}，完成 ${state.executed.length}，失败 ${state.failed.length}，未执行 ${state.pending.length}）`);
console.log(`结果目录：${resultDir}`);
process.exit(overall ? 0 : 1);
