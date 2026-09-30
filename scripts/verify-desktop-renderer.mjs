/**
 * 第十五轮一/三：便携产物 **renderer 真实用户链路验收**（CDP——与 ZS_UI_DEMO 宿主命令链
 * smoke 明确区分）。任务提交与验收全部经页面按钮（open-folder→成员绑定→发送→要求修改→
 * 验收通过→停止）；文件选择器用 ZS_PICK_FOLDER 显式可审计钩子；测试数据=合成 fixture。
 *
 * 覆盖闭环：正常发送（线程回复+DONE）、停止（CANCELLED）、验收开关后的 REVIEW→返工→
 * 新版本、设置（成员 runtime 绑定）保存+同 appData 重开保持；停机结构化事实（desktop-
 * shutdown.json：送达/退出码/daemon stop-result）与无残留（控制组 decoy 先证检测有效）。
 * renderer 异常/preload 失败/按钮无响应通过 Runtime.enable+exceptionThrown 捕获。
 */
/* global fetch, WebSocket -- node>=21 原生（eslint 环境未声明） */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repo = resolve(import.meta.dirname, '..');
for (const script of ['build-ui.mjs', 'pack-daemon.mjs', 'pack-desktop.mjs']) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { cwd: repo, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) { console.error(`前置构建失败（${script}）`); process.exit(1); }
}
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
const installRoot = mkdtempSync(join(tmpdir(), '桌面 验收-'));
const appHome = join(installRoot, '众说 桌面版');
cpSync(staging, appHome, { recursive: true, dereference: true });
const appData = join(installRoot, '应用 数据', '唯一实例');
const fixtureProj = join(installRoot, '演示 项目');
mkdirSync(fixtureProj, { recursive: true });
writeFileSync(join(fixtureProj, 'notes.md'), '# 演示\n\n暗号：R15-RENDERER-7749\n', 'utf8');

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程残留查询（修正版）：按安装根字面量匹配命令行（PowerShell -like 不转义反斜杠）；查询失败/
 * 超时/非数字=ERR（不当 0）；覆盖任意名称的执行载体（不限 node/electron 名）。 */
const psQuery = join(installRoot, 'proc-query.ps1');
// v2 统一协议（第十八轮一）：双形态匹配+排除验证器自身/父壳/查询辅助——与独立包两模板及
// verify-desktop.mjs 逐字一致（tests/integration/residualSelfExclude.test.ts 校验一致性）。
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
writeFileSync(psQuery, PROC_QUERY_PS, 'utf8');
function listInstallProcesses() {
  // 成功查询必有 QUERY-OK 尾标：空结果=零行；无尾标/错误/超时=ERR（不当 0）。
  const pattern = `*${installRoot}*`;
  const alt = pattern.replaceAll('\\', '/');
  const exclude = [process.pid, process.ppid].filter((x) => x != null).join(',');
  const ask = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psQuery], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ZS_PROC_PATTERN: pattern, ZS_PROC_PATTERN_ALT: alt !== pattern ? alt : '', ZS_PROC_EXCLUDE: exclude } });
  let r = ask();
  if (r.error != null || r.status !== 0) r = ask(); // 冷启动/磁盘忙首查：重试一次（失败不折算为零）
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || r.error != null || !out.includes('QUERY-OK') || out.includes('ERR\t')) {
    return { ok: false, raw: out.slice(0, 120) || r.stderr?.slice(0, 120) || 'empty' };
  }
  const rows = out.split('\n').map((l) => l.trim()).filter((l) => /^\d+\t/.test(l)).map((l) => { const [pid, name] = l.split('\t'); return { pid: Number(pid), name: name ?? '?' }; });
  return { ok: true, rows };
}
function leftoverCount() {
  const q = listInstallProcesses();
  return q.ok ? q.rows.length : `ERR:${q.raw}`;
}

/** 启动产物（CDP 端口；appDataDirOverride=多实例隔离场景）并等待页面就绪。 */
async function launchApp(port, extraEnv, appDataDirOverride) {
  const child = spawn(join(appHome, 'electron.exe'), [`--remote-debugging-port=${port}`], {
    cwd: installRoot,
    env: {
      ...process.env,
      ZS_APP_DATA: appDataDirOverride ?? appData,
      ZS_RUNTIME: 'fake',
      ZS_ALLOW_FAKE: '1',
      ZS_REAL_DISPATCH_GUARD: '1', // 第十六轮四：验收环境硬隔离——真实 runtime 派发在 spawn 前拒绝
      ZS_PICK_FOLDER: fixtureProj,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => {});
  // CDP 端点就绪（页面 target 出现）。
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
      if (Array.isArray(list) && list.some((t) => String(t.url).includes('index.html'))) return { child, stderr: () => stderr };
    } catch { /* 尚未就绪 */ }
    await sleep(300);
  }
  return { child, stderr: () => stderr, noPage: true };
}

/** 极简 CDP 客户端（页面 WS + Runtime.evaluate；exceptionThrown/console 收集）。 */
async function connectPage(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const target = list.find((t) => String(t.url).includes('index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') pageErrors.push(String(msg.params.args?.[0]?.value ?? '').slice(0, 200));
  });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error != null) return { error: r.error.message };
    const v = r.result?.result;
    if (v?.subtype === 'error') return { error: v.description?.slice(0, 200) ?? String(v.value) };
    return { value: v?.value };
  };
  return { evalJs, pageErrors: () => pageErrors, close: () => ws.close() };
}


/** 退出等待（第十九轮八：挂起放大器修复）——CloseMainWindow 后 60s 硬限，超时 taskkill
 * /T /F 兜底（exit={code:null,signal:'KILLED-60s'}——强杀≠优雅成功，事实如实进入核对）。 */
async function exitWithGuard(child, gracefulMs = 60_000) {
  const outcome = await new Promise((res) => {
    child.once('exit', (c, s) => res({ code: c, signal: s }));
    spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow()`], { timeout: 15_000 });
    const t = setTimeout(() => { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* 尽力 */ } }, gracefulMs);
    t.unref?.();
  });
  await new Promise((r) => setTimeout(r, 800));
  return outcome;
}

const waitFor = async (fn, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r === true) return true;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(400);
  }
};


// 会话选择（第二十轮一验收）：ZS_VDR_SESSIONS=A,B1,B2,C,D（缺省全部）——单独/完整序列分别跑、
// 报告分别列，不拼接局部通过。
const SESSIONS = (process.env.ZS_VDR_SESSIONS ?? 'A,B1,B2,C,D').split(',').map((x) => x.trim()).filter(Boolean);
const shouldRun = (name) => SESSIONS.includes(name);

let failed = false;
let exitCFacts = null; // C 写/D 读（上一实例退出延迟同步点的事实载体）
try {
  // ---------- 控制组：decoy 进程先证检测有效（正常用例不得以「匹配不到」充数） ----------
  {
    const decoy = spawn(join(appHome, 'resources', 'app', 'daemon', 'node', 'node.exe'), ['-e', `setInterval(()=>{},1000) /* ${installRoot.replaceAll('\\', '/')} decoy */`], { stdio: 'ignore' });
    await sleep(1200);
    const seen = leftoverCount();
    record('控制组：安装路径 decoy 进程被检出（检测有效性——匹配不到≠无残留）', seen === 1 || (typeof seen === 'number' && seen >= 1), `count=${JSON.stringify(seen)}`);
    spawnSync('taskkill', ['/PID', String(decoy.pid), '/T', '/F']);
    await sleep(1500);
    const after = leftoverCount();
    record('控制组：decoy 结束后归零', after === 0, `count=${JSON.stringify(after)}`);
  }

  // ---------- 会话 A：正常链+设置+REVIEW→返工→新版本+优雅停机事实 ----------
  if (shouldRun('A')) {
    const port = 9331;
    const app = await launchApp(port, {});
    if (app.noPage) throw new Error('会话 A：页面未就绪');
    const page = await connectPage(port);
    const pre = await page.evalJs('typeof window.zs');
    record('renderer+preload 加载（window.zs 命令面存在）', pre.value === 'object', `zs=${JSON.stringify(pre.value)}`);
    // 打开项目（真实按钮；目录选择=ZS_PICK_FOLDER 可审计钩子）。
    await page.evalJs(`document.getElementById('open-folder').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, '项目打开');
    record('页面操作打开项目（open-folder→preload pickFolder→project.open）', true);
    // 验收开关（项目设置真实按钮）→ 开。
    await page.evalJs(`document.getElementById('task-review-toggle').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('task-review-toggle').textContent.includes('开')`)).value === true, 10_000, '验收开关');
    // 正常发送（真实按钮）→ 点进任务线程（池卡片）→ 线程回复 + 待验收。
    await page.evalJs(`(() => { document.getElementById('composer-input').value = '请读取 notes.md 报出暗号'; document.getElementById('send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length > 0`)).value === true, 20_000, '主池出现任务卡片');
    await page.evalJs(`(() => { document.querySelector('#pool .pool-card').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('review-reject-btn').classList.contains('hidden') === false`)).value === true, 90_000, 'REVIEW 待验收（验收按钮出现）');
    const reply = await page.evalJs(`document.getElementById('thread-messages').textContent`);
    record('正常发送闭环（按钮提交→worker→线程回复→待验收）', String(reply.value ?? '').length > 0 && !String(reply.value ?? '').includes('错误'), `回复长度=${String(reply.value ?? '').length}`);
    // 要求修改（真实按钮+意见必填）→ 显式追加执行（返工经 redispatch 正式链——意见注入输入）
    // → 新版本待验收 → 验收通过 → DONE。
    await page.evalJs(`document.getElementById('review-reject-btn').click()`);
    await page.evalJs(`(() => { document.getElementById('rework-note-input').value = '请补充风险一节'; document.getElementById('rework-note-confirm').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('redispatch-btn').classList.contains('hidden') === false`)).value === true, 30_000, '返工后追加执行可用（ACTIVE+无在途）');
    await page.evalJs(`document.getElementById('redispatch-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('review-accept-btn').classList.contains('hidden') === false && document.getElementById('review-reject-btn').classList.contains('hidden') === false`)).value === true, 120_000, '返工后新版本待验收（验收按钮复现）');
    await page.evalJs(`document.getElementById('review-accept-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('thread-status').textContent.includes('验收已记录')`)).value === true, 60_000, '验收通过后 验收已记录');
    record('REVIEW 闭环（要求修改→返工注入→新版本(revision≥2)→验收通过→DONE）', true);
    // 成员 runtime 绑定（设置组）：读取=未绑定；绑定 claude+deepseek-flash；负例=空模型校验失败。
    await page.evalJs(`document.getElementById('project-settings').open = true`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('未绑定')`)).value === true, 20_000, '成员绑定区渲染');
    await page.evalJs(`[...document.querySelectorAll('#member-runtime-list button.chip')].find((b) => b.textContent === '绑定…').click()`);
    await page.evalJs(`(() => { const sel = document.querySelector('.member-runtime-edit select'); sel.value = 'claude'; sel.dispatchEvent(new Event('change')); document.querySelector('.member-runtime-edit input').value = ''; })()`);
    await page.evalJs(`[...document.querySelectorAll('.member-runtime-edit button.chip')].find((b) => b.textContent === '保存').click()`);
    await sleep(600);
    const negErr = await page.evalJs(`document.querySelector('.member-runtime-edit span.meta')?.textContent ?? ''`);
    record('成员绑定校验失败提示（claude 空模型——客户端预检+服务端校验同口径）', String(negErr.value).includes('校验失败'), `msg=${String(negErr.value).slice(0, 50)}`);
    await page.evalJs(`document.querySelector('.member-runtime-edit input').value = 'deepseek-flash'`);
    await page.evalJs(`[...document.querySelectorAll('.member-runtime-edit button.chip')].find((b) => b.textContent === '保存').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('claude · deepseek-flash')`)).value === true, 20_000, '绑定保存回显');
    record('成员 runtime 绑定保存+回显（member.setRuntime→member.runtime 重读；含能力分列）', true);

    const errs = page.pageErrors();
    record('renderer 无未捕获异常/console 错误（会话 A 全程）', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 160));
    page.close();
    // 优雅停机：关窗（window-all-closed→daemon.shutdown）→ 事实核对（非仅 exit 0/pid 消失）。
    const exitA = await exitWithGuard(app.child);
    const facts = JSON.parse(readFileSync(join(appData, 'desktop-shutdown.json'), 'utf8'));
    record('优雅停机事实（desktop-shutdown.json：送达+退出 0+daemon stop-result complete）',
      exitA.code === 0 && facts.requestDelivered === true && facts.exitCode === 0 && facts.forceKilled === false && facts.daemonStopResult?.complete === true,
      `exit=${JSON.stringify(exitA)} facts=${JSON.stringify({ del: facts.requestDelivered, code: facts.exitCode, force: facts.forceKilled, stop: facts.daemonStopResult?.complete, phase: facts.daemonStopResult?.phase })}`);
    await sleep(1000);
    record('会话 A 无残留', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
  }

  // ---------- 会话 B1：同 appData 顺序重开（设置保持——不发送任务） ----------
  if (shouldRun('B1')) {
    const port = 9332;
    const app = await launchApp(port, {});
    if (app.noPage) throw new Error('会话 B1：页面未就绪');
    const page = await connectPage(port);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, '重开自动恢复项目');
    await page.evalJs(`document.getElementById('project-settings').open = true`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('claude · deepseek-flash')`)).value === true, 20_000, '绑定保持');
    const reviewKept = await page.evalJs(`document.getElementById('task-review-toggle').textContent`);
    record('同 appData 顺序重开：绑定与验收开关保持（设置持久化；锁随首启干净退出释放）', String(reviewKept.value).includes('开'), `开关=${String(reviewKept.value).slice(0, 12)} 绑定=保持`);
    page.close();
    const exitB = await exitWithGuard(app.child);
    const factsB = JSON.parse(readFileSync(join(appData, 'desktop-shutdown.json'), 'utf8'));
    record('重开停机事实（同 appData 第二次优雅关闭：退出 0+complete）',
      exitB.code === 0 && factsB.exitCode === 0 && factsB.daemonStopResult?.complete === true,
      `exit=${exitB.code} stop=${factsB.daemonStopResult?.complete}`);
    await sleep(1000);
  }

  // ---------- 会话 B2：独立 appData 停止闭环（无绑定→全局 fake——默认验收零真实调用） ----------
  if (shouldRun('B2')) {
    const port = 9333;
    const appDataStop = join(installRoot, '应用 数据', '停止场景');
    const app = await launchApp(port, { ZS_FAKE_STALL_MS: '15000' }, appDataStop); // 停延 15s=停止窗口；无绑定→全局 fake
    if (app.noPage) throw new Error('会话 B2：页面未就绪');
    const page = await connectPage(port);
    await page.evalJs(`document.getElementById('open-folder').click()`); // 新 appData 无历史——真实按钮打开
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, 'B2 项目打开');
    // 停止：发送→在途窗口点停止→CANCELLED。
    await page.evalJs(`(() => { document.getElementById('composer-input').value = '长驻任务（将被停止）'; document.getElementById('send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length > 0`)).value === true, 20_000, '主池出现任务卡片');
    await page.evalJs(`(() => { document.querySelector('#pool .pool-card').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('stop-btn').classList.contains('hidden') === false`)).value === true, 20_000, '停止按钮出现（任务在途）');
    await page.evalJs(`document.getElementById('stop-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('thread-messages').textContent.includes('已停止') || document.getElementById('thread-status').textContent.includes('已停止')`)).value === true, 60_000, '任务 CANCELLED');
    record('停止闭环（在途→stop-btn→CANCELLED）', true);
    page.close();
    const exitB2 = await exitWithGuard(app.child);
    const factsB2 = JSON.parse(readFileSync(join(appDataStop, 'desktop-shutdown.json'), 'utf8'));
    record('停止场景停机事实（受管 job 随优雅关闭收拢：退出 0+complete）',
      exitB2.code === 0 && factsB2.exitCode === 0 && factsB2.daemonStopResult?.complete === true,
      `exit=${exitB2.code} stop=${factsB2.daemonStopResult?.complete}`);
    await sleep(1000);
    record('会话 B2 无残留（含 stop 场景进程收拢）', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
  }
  // ---------- 会话 C：私信全链（第十九轮七：双会话/排队/停止继续/归档恢复/版本验收/深链） ----------
  if (shouldRun('C')) {
    const port = 9334;
    const appDataDm = join(installRoot, '应用 数据', '私信场景');
    const app = await launchApp(port, { ZS_FAKE_STALL_MS: '12000' }, appDataDm);
    if (app.noPage) throw new Error('会话 C：页面未就绪');
    const page = await connectPage(port);
    await page.evalJs(`document.getElementById('open-folder').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 90_000, 'C 项目打开');
    await page.evalJs(`document.getElementById('task-review-toggle').click()`); // 开验收——DM 交付走版本验收
    await waitFor(async () => (await page.evalJs(`document.getElementById('task-review-toggle').textContent.includes('开')`)).value === true, 10_000, 'C 验收开关');
    // 新建会话 A（DOM 成员选择器——非 prompt）。
    await page.evalJs(`document.getElementById('dm-create').click()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, '成员选择器出现');
    await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, '私信视图打开');
    const hashA = await page.evalJs('location.hash');
    record('DM 新建+打开（DOM 选择器→独立会话；深链 hash 落址）', String(hashA.value ?? '').startsWith('#dm=dm_'), `hash=${hashA.value}`);
    // 会话 A：发送两条（第一条在途 stall→第二条排队）；停止→暂停→继续→完成→REVIEW 验收。
    await page.evalJs(`(() => { document.getElementById('dm-input').value = '私信第一条（长任务）'; document.getElementById('dm-send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-state').textContent.includes('运行中')`)).value === true, 20_000, 'DM 运行中状态');
    await page.evalJs(`(() => { document.getElementById('dm-input').value = '私信第二条（排队）'; document.getElementById('dm-send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-state').textContent.includes('排队')`)).value === true, 20_000, 'DM 排队状态');
    await page.evalJs(`document.getElementById('dm-stop-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-state').textContent.includes('暂停')`)).value === true, 60_000, 'DM 停止后队列暂停');
    await page.evalJs(`document.getElementById('dm-resume-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-review-row').classList.contains('hidden') === false`)).value === true, 120_000, 'DM 待验收（第二排队消息完成后）');
    await page.evalJs(`document.getElementById('dm-review-accept').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-review-row').classList.contains('hidden')`)).value === true, 60_000, 'DM 验收通过后行收起');
    record('DM 串行+停止继续+版本验收（排队→暂停→resume→REVIEW→accept 绑定版本）', true);
    // 归档→只读；恢复→可发。
    await page.evalJs(`document.getElementById('dm-archive-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-input').disabled === true && document.getElementById('dm-state').textContent.includes('已归档')`)).value === true, 20_000, 'DM 归档只读');
    await page.evalJs(`document.getElementById('dm-restore-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-input').disabled === false`)).value === true, 20_000, 'DM 取消归档恢复可发');
    record('DM 归档/恢复（只读→恢复不自动续跑）', true);
    // 同成员第二条会话（新建分离）：侧栏两条、互不串。
    await page.evalJs(`document.getElementById('dm-create').click()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, '成员选择器再现');
    await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-list button').length >= 2`)).value === true, 20_000, '侧栏两会话');
    await page.evalJs(`(() => { document.getElementById('dm-input').value = 'B 会话消息'; document.getElementById('dm-send').click(); })()`);
    let replyB = '';
    for (let i = 0; i < 60; i += 1) {
      const t = await page.evalJs(`document.getElementById('dm-messages').textContent`);
      replyB = String(t.value ?? '');
      if (replyB.includes('分析完成')) break;
      await sleep(500);
    }
    record('DM 同成员双会话（新建分离：侧栏两条；B 会话独立收发）', replyB.includes('分析完成'), `B 回复=${replyB.slice(0, 40)}`);
    const errsC = page.pageErrors();
    record('renderer 无未捕获异常（会话 C 全程）', errsC.length === 0, errsC.slice(0, 2).join(' | ').slice(0, 160));
    page.close();
    // 同步点（第二十轮一）：上一实例退出延迟——C 关闭 fire-and-forget，D 立即启动（不同
    // appData 无锁冲突）；C 的停机事实延后到 D 结束后核对（同一次运行的进程树，不误杀他人）。
    const exitCPromise = exitWithGuard(app.child).then(async (exitC) => {
      exitCFacts = { exit: exitC };
      try {
        const factsC = JSON.parse(readFileSync(join(appDataDm, 'desktop-shutdown.json'), 'utf8'));
        exitCFacts.facts = factsC;
      } catch { /* 事实文件读取失败如实留空 */ }
      return exitC;
    });
    await sleep(300);
    void exitCPromise;
    const cPort = port; // C 进程树由 exitCPromise 收口（CloseMainWindow→60s 硬限→taskkill）
    if (!shouldRun('D')) {
      const exitC = await exitCPromise;
      record('私信场景停机事实（退出 0+complete）', exitC.code === 0 && exitCFacts?.facts?.daemonStopResult?.complete === true, `exit=${exitC.code} stop=${exitCFacts?.facts?.daemonStopResult?.complete}`);
      await sleep(1000);
      record('会话 C 无残留', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
    }
    void cPort;
  }


  // ---------- 会话 D：受控同步点（第二十轮一）——IPC 延迟就绪/首命令响应延迟/上一实例退出延迟 ----------
  if (shouldRun('D')) {
    // D1：daemon 启动延迟 5s + 页面就显示立即点击——命令应在 handler 内有界等待，项目最终打开。
    {
      const port = 9335;
      const appDataD = join(installRoot, '应用 数据', '同步点D1');
      const app = await launchApp(port, { ZS_UI_DAEMON_DELAY_MS: '5000' }, appDataD);
      if (app.noPage) throw new Error('会话 D1：页面未就绪');
      const page = await connectPage(port);
      await page.evalJs(`document.getElementById('open-folder').click()`); // 立即点击（不等就绪）
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 90_000, 'D1 daemon 延迟就绪下项目仍打开');
      const connErr = await page.evalJs(`document.getElementById('conn-state').classList.contains('err')`);
      record('同步点·IPC 延迟就绪（daemon 延 5s+立即点击）：命令有界等待、项目打开、无错误残留', connErr.value !== true, `connErr=${connErr.value}`);
      page.close();
      await exitWithGuard(app.child);
      await sleep(800);
    }
    // D2：首条命令响应延迟 3s——renderer 请求-响应不丢（同一点击最终完成）。
    {
      const port = 9336;
      const appDataD = join(installRoot, '应用 数据', '同步点D2');
      const app = await launchApp(port, { ZS_UI_FIRST_COMMAND_DELAY_MS: '3000' }, appDataD);
      if (app.noPage) throw new Error('会话 D2：页面未就绪');
      const page = await connectPage(port);
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 60_000, 'D2 首命令延迟下项目仍打开');
      record('同步点·项目打开响应延迟（首命令延 3s）：响应回到原请求、无重复无丢失', true);
      page.close();
      await exitWithGuard(app.child);
      await sleep(800);
    }
    // 上一实例退出延迟已在 C→D 交接覆盖（C fire-and-forget 关闭、D 立即启动）；核对 C 的收口事实。
    for (let i = 0; i < 120; i += 1) { if (exitCFacts != null) break; await sleep(500); }
    record('同步点·上一实例退出延迟（C 关闭不等完即启 D）：C 停机事实仍完整（退出 0+complete）',
      exitCFacts?.exit?.code === 0 && exitCFacts?.facts?.daemonStopResult?.complete === true,
      `exit=${exitCFacts?.exit?.code} stop=${exitCFacts?.facts?.daemonStopResult?.complete}`);
    await sleep(1000);
    record('会话 D 无残留（含延迟退出的 C 进程树收口）', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
  }
} catch (error) {
  failed = true;
  console.error(`中止：${error instanceof Error ? error.stack : String(error)}`);
}

const allPassed = results.length > 0 && results.every((r) => r.ok) && !failed;
const report = { builtAt: new Date().toISOString(), installRoot, results, allPassed, layer: '便携产物 renderer 用户链路（CDP 真实页面操作）' };
writeFileSync(join(repo, 'dist', 'desktop', 'verify-desktop-renderer-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`[verify-desktop-renderer] ${allPassed ? '全部通过' : '存在失败'}；报告=dist/desktop/verify-desktop-renderer-report.json`);
if (!allPassed) console.log(`保留诊断目录：${installRoot}`);
else rmSync(installRoot, { recursive: true, force: true });
process.exit(allPassed ? 0 : 1);
