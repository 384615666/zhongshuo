'use strict';
/**
 * DEV-25 双机验收包构建（第三十二轮六建；第三十三轮一按缺口重写）。
 * **源=最终冻结产物**（dist/desktop/vdr-frozen——冻结三连逐文件 SHA256 复用的同一目录）：
 * - 拷贝后**逐文件重算 SHA256 对冻结 MANIFEST-SHA256.json 核对**（含 daemon.cjs——第三十二轮
 *   交付包是陈旧构建 bld_aeba86865045ebbf，daemon.cjs 与冻结基线 bld_d96713369ac153d0 不同而
 *   报告宣称同源——本轮起以逐文件核对为准，不再只改 buildId 文本）；
 * - **RESULTS 永不重建删除**（build 只重建应用与脚本目录；用户回填/截图/历史日志保留；
 *   RESULT-template.md 仍只在不存在时写入）——自测含「已有回填文件保护」反例；
 * - start-server.bat：管道名按独立数据根生成（server-data/pipe-name.txt 首启随机持久——两份
 *   包互不撞名）；内置 ZS_REMOTE_SELFCHECK=1（隔离验收模式——UI 自检按钮只在此模式开放，
 *   正式产品代码不带）；自测钩子 ZS_DEV25_DEBUG_PORT/ZS_DEV25_DRILL 仅自测注入。
 * 自测（--self-test）：**实际运行交付 .bat**（非自拼环境）：
 * - 清空开发终端全部 ZS_* 覆盖变量（继承常规系统环境）+中文与空格路径；
 * - 断言窗口打开（CDP）、合成项目实际可见、模拟模式明确（runtime.status=fake）、种子成功、
 *   停止演练可操作（--drill 真发任务→task.stop→收口）；
 * - 优雅停机走正式关窗链（Browser.close）：退出 0+requestDelivered+complete+非 forced+
 *   无残留进程（taskkill 仅失败兜底并如实记失败）；
 * - real_calls 核对子进程成功+结果结构（空 stdout 不当 0）；
 * - 同一包第二次启动：种子幂等（不重造房间/DM/消息——reused 标记+房间/私信计数不变）。
 */
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const frozenDefault = join(repo, 'dist', 'desktop', 'vdr-frozen');
const outRoot = join(repo, 'dist', 'desktop', 'dev25-dual-win');

const BAT_LAUNCHER = [
  '@echo off',
  'rem DEV-25 dual-machine acceptance server launcher (ASCII only - codepage safe)',
  'setlocal EnableDelayedExpansion',
  'set PKG=%~dp0',
  'set APP_DIR=%PKG%server-data',
  'set DEMO_DIR=%PKG%demo-project',
  'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
  'rem Pipe name is generated once per data root (two package copies never collide).',
  'if not exist "%APP_DIR%\\pipe-name.txt" (',
  '  set PIPE_TAG=%RANDOM%%RANDOM%%RANDOM%',
  '  >"%APP_DIR%\\pipe-name.txt" echo zs-dev25-!PIPE_TAG!',
  ')',
  'set /p PIPE_SHORT=<"%APP_DIR%\\pipe-name.txt"',
  'set PIPE_NAME=\\\\.\\pipe\\!PIPE_SHORT!',
  'set ZS_APP_DATA=%APP_DIR%',
  'set ZS_RUNTIME=fake',
  'set ZS_ALLOW_FAKE=1',
  'set ZS_REAL_DISPATCH_GUARD=1',
  'set ZS_PIPE_NAME=!PIPE_NAME!',
  'set ZS_BOOTSTRAP_AGENTS=Guide A,Guide B',
  'set ZS_FAKE_STALL_MS=60000',
  'set ZS_REMOTE_SELFCHECK=1',
  'set SEED_FLAGS=',
  'if "%ZS_DEV25_DRILL%"=="1" set SEED_FLAGS=--drill',
  'echo Starting Zhongshuo desktop (fake runtime + real-dispatch guard, zero real model calls)...',
  'if not "%ZS_DEV25_DEBUG_PORT%"=="" (',
  '  start "ZhongshuoDual" "%PKG%ZhongshuoDual\\electron.exe" --remote-debugging-port=%ZS_DEV25_DEBUG_PORT%',
  ') else (',
  '  start "ZhongshuoDual" "%PKG%ZhongshuoDual\\electron.exe"',
  ')',
  'echo Seeding demo project via formal commands (retries until daemon ready; idempotent)...',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%seed\\seed-client.cjs" --appdata "%APP_DIR%" --pipe "!PIPE_NAME!" --demo "%DEMO_DIR%" %SEED_FLAGS%',
  'if errorlevel 1 (echo SEED FAILED - see messages above. Close the app window and retry.) else (echo Seeded. RESULTS\\seed.json written.)',
  'echo.',
  'echo NEXT: in the app sidebar open the REMOTE ACCESS panel, choose LAN (0.0.0.0), click ENABLE,',
  'echo then click the pairing button and copy ADDRESS + FULL SHA-256 fingerprint for the client machine.',
  'echo Mechanical negatives: click the SELF-CHECK button in the panel (runs in-process), then run run-self-check.bat.',
  'echo Keep this console open during acceptance. Closing the app window exits the server.',
  'pause',
  'endlocal',
  '',
].join('\r\n');

const BAT_SELFCHECK = [
  '@echo off',
  'rem DEV-25 self-check results export (server machine, after clicking the SELF-CHECK button in UI)',
  'setlocal',
  'set PKG=%~dp0',
  'set APP_DIR=%PKG%server-data',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%selfcheck\\self-check.cjs" --appdata "%APP_DIR%"',
  'pause',
  'endlocal',
  '',
].join('\r\n');

const README = `# DEV-25 双机验收包（Windows 服务机 + 同局域网客户端浏览器）

包目录全 ASCII（中文/空格路径可用）；服务机自备**无需** Node/Git/模型账号；不包含任何私钥、
local.token（首次启动生成于 server-data/）或真实工程数据。fake runtime + 真实派发硬防护——
零真实模型调用（RESULTS 会留 real_calls=0 证据）。

**产物来源**：\`ZhongshuoDual/\` 由最终冻结产物（vdr-frozen，buildId 见 \`RESULTS/buildId.txt\`）
逐文件 SHA256 核对后拷贝——\`RESULTS/frozen-manifest-check.json\` 留核对事实。本包与冻结基线
同源（第三十三轮起强制逐文件核对，不再只对 buildId 文本）。

## 服务机步骤

1. 双击 \`start-server.bat\`（等控制台出现 "Seeded." 与应用窗口）。合成数据已建（重复启动幂等
   ——不重造房间/私信）：项目「DEV25 双机验收」+ 两 Agent（Guide A/B）+ 房间×2 + 私信 DM A
   （停止演练）与 DM B（验收演练）+ 附件样本与仅记录消息（seed 明细在 \`RESULTS/seed.json\`）。
   窗口若停在欢迎页：点「打开本地文件夹…」选择包内 \`demo-project\` 文件夹，或重启应用
   （种子已写服务端自动打开记忆——二次启动直接进入合成项目）。
2. 应用侧栏 →「远程访问（DEV-25）」面板：
   - 监听地址选 **局域网（0.0.0.0）** → 点「启用」→ 面板给出 **实际地址** 与 **完整 64 位 SHA-256 指纹**
     （两个按钮可一键复制）。记下两者交给客户端机。防火墙弹窗选「允许」。
   - 点「生成配对码」→ 把 pairingId 与 8 位码交给客户端机（5 分钟内一次有效）。
3. （可选，机械负例自动化）点「**自检（机械负例）**」→ 面板给出逐项结论（错码/伪造 Host/
   Origin/无 token/同号恰一次+审计核对/吊销清理——进程内执行，结果不含任何凭据）→ 回本目录
   双击 \`run-self-check.bat\` 把结论导出到 \`RESULTS/self-check-*.json\`。
4. Windows 防火墙如未弹窗：放行面板显示的端口（专用网络）。

## 客户端机步骤（Edge/Chrome，无需安装任何东西）

1. 浏览器打开服务机给的地址（如 \`https://192.168.x.x:端口\`）。
2. **证书信任**：出现自签证书警告时，先展开证书详情核对 **SHA-256 指纹与服务机面板完全一致**
   （逐位）；然后二选一：①把 server-data/remote/identity.cer 复制到客户端机双击导入
   「受信任的根证书颁发机构」后重开页面；②仅在本次会话点「高级→继续前往」（信任失败即停——
   程序不降级 HTTP、不关闭证书检查）。证书更换（如改监听地址重新生成）须重新核对。
3. 配对页输入 pairingId + 配对码 + 设备名 →「配对并保存」→ 进入主界面。
4. 按 \`RESULTS/RESULT-template.md\` 逐项执行 D1—D10 并回填（截图放 RESULTS/shots/）。

## 双机检查项（摘要——完整口径见模板）

D1 同一数据可见 | D2 仅记录消息+事件流 | D3 上传附件并发送 | D4 DM A 发起任务→客户端停止 |
D5 DM B 任务完成→客户端验收通过 | D6 断网/刷新后重试恰一次 | D7 关闭客户端任务继续+重开恢复 |
D8 服务机吊销→立即断流+401 | D9（自动化——自检按钮+run-self-check）| D10 错码（自动化）

## 结果与边界

- 自动留档：\`RESULTS/seed.json\`（种子+演练）、\`RESULTS/self-check-*.json\`（协议负例）、
  \`server-data/selfcheck-latest.json\`（自检报告）、应用退出时 \`server-data/desktop-shutdown.json\`
  （停机事实）、real_calls=0（硬防护事实）。
- RESULT-template.md 永不被程序覆盖——用户回填唯一真源；工程侧只读核对。
- 手机/移动浏览器组合按 R11 属独立验收范围，本包不覆盖；PWA/Push 按后续归属排产。
`;

const RESULT_TEMPLATE = `# DEV-25 双机验收结果（用户回填——本文件不会被程序覆盖）

- 日期/参与人：
- 服务机（包路径/系统）：
- 客户端机（浏览器与版本）：
- 服务地址：
- 证书 SHA-256 指纹（完整 64 位，两端核对一致）：____
- buildId（RESULTS/buildId.txt）：

| # | 项 | 操作摘要 | 结论 | 证据（截图文件名/说明） |
|---|---|---|---|---|
| D1 | 同一数据可见 | 打开页面后会话/任务/事件与服务机一致 | | |
| D2 | 仅记录消息+事件流 | 发「仅记录」→双端出现+事件流 message.submitted | | |
| D3 | 附件上传并发送 | 上传小文本→发送→双端 📎 呈现 | | |
| D4 | 停止演练 | DM A 发任务（首任务有 60s 停滞窗）→客户端「停止」→状态停 | | |
| D5 | 验收演练 | DM B 发任务→完成待验收→客户端「验收通过」→DONE | | |
| D6 | 重试恰一次 | 断网/刷新后页面「结果未知的操作」重试→消息恰一条 | | |
| D7 | 关闭客户端任务继续 | 发任务→关浏览器→重开→结果消息可见 | | |
| D8 | 吊销终态 | 服务机吊销→客户端立即断流+明确终态横幅 | | |
| D9 | 伪造 Host/Origin 等（自动化） | UI 自检按钮结论+run-self-check.bat 导出 | | self-check-*.json |
| D10 | 错码（自动化） | UI 自检按钮结论+run-self-check.bat 导出 | | self-check-*.json |

异常与备注：
`;

function sha256File(p) {
  return new Promise((resolveP, rejectP) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolveP(h.digest('hex'))).on('error', rejectP);
  });
}

/** 构建：源=冻结产物；逐文件 SHA256 核对；RESULTS 永不删除。 */
async function build(frozenDir = frozenDefault) {
  if (!existsSync(frozenDir)) throw new Error('frozen artifact not found: ' + frozenDir + '——先完成冻结序列（freeze 三连）');
  const buildMeta = JSON.parse(readFileSync(join(frozenDir, 'BUILD.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(frozenDir, 'MANIFEST-SHA256.json'), 'utf8'));
  const buildId = buildMeta.buildId;
  // 只重建应用与脚本目录——RESULTS（用户回填/截图/历史日志）保留。
  rmSync(join(outRoot, 'ZhongshuoDual'), { recursive: true, force: true });
  rmSync(join(outRoot, 'seed'), { recursive: true, force: true });
  rmSync(join(outRoot, 'selfcheck'), { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  cpSync(frozenDir, join(outRoot, 'ZhongshuoDual'), { recursive: true, dereference: true });
  mkdirSync(join(outRoot, 'seed'), { recursive: true });
  mkdirSync(join(outRoot, 'selfcheck'), { recursive: true });
  mkdirSync(join(outRoot, 'RESULTS'), { recursive: true });
  mkdirSync(join(outRoot, 'RESULTS', 'shots'), { recursive: true });
  cpSync(join(repo, 'scripts', 'dev25-dual', 'seed-client.cjs'), join(outRoot, 'seed', 'seed-client.cjs'));
  cpSync(join(repo, 'scripts', 'dev25-dual', 'self-check.cjs'), join(outRoot, 'selfcheck', 'self-check.cjs'));
  writeFileSync(join(outRoot, 'start-server.bat'), BAT_LAUNCHER, 'ascii');
  writeFileSync(join(outRoot, 'run-self-check.bat'), BAT_SELFCHECK, 'ascii');
  writeFileSync(join(outRoot, 'README-双机验收.md'), README, 'utf8');
  const tplPath = join(outRoot, 'RESULTS', 'RESULT-template.md');
  if (!existsSync(tplPath)) writeFileSync(tplPath, RESULT_TEMPLATE, 'utf8'); // 不覆盖用户回填
  writeFileSync(join(outRoot, 'RESULTS', 'buildId.txt'), String(buildId) + '\n', 'ascii');
  // **逐文件核对（第三十三轮一）**：包内每个清单文件重算 SHA256 对冻结清单——含 daemon.cjs。
  const appDir = join(outRoot, 'ZhongshuoDual');
  let verified = 0;
  const mismatches = [];
  const listed = new Set();
  for (const entry of manifest.files ?? []) {
    listed.add(entry.path);
    const target = join(appDir, entry.path);
    if (!existsSync(target)) { mismatches.push(`缺失 ${entry.path}`); continue; }
    const actual = await sha256File(target);
    if (actual !== entry.sha256) mismatches.push(`SHA256 不符 ${entry.path}（清单 ${entry.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`);
    else verified += 1;
  }
  const extras = [];
  const walkExtras = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel.length === 0 ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walkExtras(join(d, e.name), r);
      else if (!listed.has(r) && r !== 'BUILD.json' && r !== 'MANIFEST-SHA256.json') extras.push(r);
    }
  };
  walkExtras(appDir, '');
  const checkReport = { at: new Date().toISOString(), source: frozenDir, buildId, filesInManifest: (manifest.files ?? []).length, verified, mismatches, extras, result: mismatches.length === 0 && extras.length === 0 ? 'pass' : 'fail' };
  writeFileSync(join(outRoot, 'RESULTS', 'frozen-manifest-check.json'), JSON.stringify(checkReport, null, 2), 'utf8');
  if (checkReport.result !== 'pass') {
    throw new Error(`冻结产物逐文件核对失败（${mismatches.length} 不符 / ${extras.length} 多余）：${[...mismatches, ...extras].slice(0, 5).join('；')}`);
  }
  console.log(`[dev25-dual] package ready: ${outRoot} buildId=${buildId}（逐文件核对 ${verified}/${manifest.files?.length ?? 0} 通过）`);
  return { buildId, verified };
}

// ---------- 自测 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpCall(port, method, params = {}) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const out = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('cdp timeout: ' + method)), 20_000);
    ws.once('message', (d) => { clearTimeout(t); try { res(JSON.parse(String(d))); } catch (e) { rej(e); } });
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return out;
}

async function cdpEvalPage(port, expr) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (page == null) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const out = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('cdp eval timeout')), 20_000);
    ws.once('message', (d) => {
      clearTimeout(t);
      try {
        const m = JSON.parse(String(d));
        if (m.result?.exceptionDetails) rej(new Error(String(m.result.exceptionDetails.text)));
        else res(m.result?.result?.value);
      } catch (e) { rej(e); }
    });
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return out;
}

/** 等桌面页面就绪：窗口打开→种子完成（seed.json）→reload 走自动打开链→项目可见+模拟模式明确。 */
async function assertAppFacts(port, appData) {
  const t0 = Date.now();
  let pageOk = false;
  while (Date.now() - t0 < 60_000) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (pages.some((p) => p.type === 'page')) { pageOk = true; break; }
    } catch (e) { /* 未就绪 */ }
    await sleep(1000);
  }
  if (!pageOk) throw new Error('窗口未打开（60s 无 page target）');
  // 种子完成（seed.json 落盘=UI 自动打开记忆已写）。
  const seedPath = join(appData, '..', 'RESULTS', 'seed.json');
  while (Date.now() - t0 < 150_000) {
    if (existsSync(seedPath)) break;
    await sleep(3000);
  }
  if (!existsSync(seedPath)) throw new Error('种子未完成（150s 无 seed.json）');
  // reload 走「服务端记忆回退」同链路（ui.autoOpenProjectPath）——合成项目实际可见。
  await cdpEvalPage(port, 'location.reload()').catch(() => { /* 已导航 */ });
  let projectName = '';
  while (Date.now() - t0 < 210_000) {
    try {
      projectName = await cdpEvalPage(port, `(document.getElementById('project-name')?.textContent ?? '')`);
      if (String(projectName).includes('DEV25 双机验收')) break;
    } catch (e) { /* 页面切换中 */ }
    await sleep(2000);
  }
  if (!String(projectName).includes('DEV25 双机验收')) throw new Error('合成项目不可见：project-name=' + String(projectName).slice(0, 80));
  // 模拟模式明确：runtime.status 成员绑定无任何真实渠道（claude/codex），未绑定成员显示
  // 「(默认 runtime)」=走 daemon 默认（启动器内置 ZS_RUNTIME=fake）；真实渠道绑定出现即失败。
  const runtimeRaw = await cdpEvalPage(port, `window.zs && window.zs.command ? window.zs.command({ protocolVersion: 1, commandId: 'selftest-runtime-status-' + Math.floor(Math.random() * 1e6), method: 'runtime.status', params: {} }).then((r) => JSON.stringify((r.data && r.data.memberBindings) || [])) : 'no-bridge'`);
  if (String(runtimeRaw) === 'no-bridge') throw new Error('桌面页面无命令桥（未就绪）');
  const bindings = JSON.parse(String(runtimeRaw));
  const fakeBinding = bindings.length > 0 && bindings.every((b) => String(b.kind ?? '') === 'fake' || String(b.kind ?? '') === '(默认 runtime)');
  if (!fakeBinding) throw new Error('模拟模式不明确（出现真实渠道绑定或无绑定）：' + String(runtimeRaw).slice(0, 200));
  return { projectName: String(projectName).slice(0, 40), fakeBinding };
}

/** 本包 electron 进程清单（按包路径过滤——不影响开发机其他实例）。 */
function listElectronPids(pkg) {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '${pkg.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8', timeout: 30_000 });
  return String(ps.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 优雅停机：页面 window.close()（等价用户关窗——window-all-closed→daemon.shutdown 正式链；
 * CDP Browser.close 会直杀浏览器进程绕过停机链——不用于成功路径）。 */
async function gracefulStop(port, pkg) {
  await cdpEvalPage(port, 'window.close()').catch(() => { /* 页面随关窗销毁——以停机事实为准 */ });
  const t0 = Date.now();
  let facts = null;
  let residual = ['(unchecked)'];
  while (Date.now() - t0 < 45_000) {
    facts = readShutdownFacts(join(pkg, 'server-data'));
    residual = listElectronPids(pkg);
    if (facts != null && residual.length === 0) break;
    await sleep(1000);
  }
  const ok = facts != null && residual.length === 0
    && facts.requestDelivered === true && facts.exitCode === 0
    && facts.forceKilled !== true && facts.timedOut !== true
    && facts.daemonStopResult?.complete === true && facts.daemonStopResult?.forced !== true;
  return { ok, facts, residual, detail: `del=${facts?.requestDelivered} exit=${facts?.exitCode} forced=${facts?.forceKilled} timedOut=${facts?.timedOut} stop=${facts?.daemonStopResult?.complete}/${facts?.daemonStopResult?.forced} 残留=${residual.length}` };
}

function readShutdownFacts(appData) {
  const p = join(appData, 'desktop-shutdown.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function realCallsCheck(pkg, appData) {
  const node = join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe');
  const rc = spawnSync(node, ['-e', 'const D=require(' + JSON.stringify(join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node_modules', 'better-sqlite3')) + ');const db=new D(' + JSON.stringify(join(appData, 'state.sqlite')) + ',{readonly:true});const c=db.prepare("SELECT count(*) c FROM real_calls").get().c;console.log(c);db.close();'],
    { encoding: 'utf8', timeout: 30_000 });
  // 结构核验（第三十三轮一）：子进程成功+stdout 是整数——空/坏输出不当 0。
  if (rc.status !== 0 || rc.error != null) return { ok: false, detail: `rc.status=${String(rc.status)} err=${String(rc.stderr).slice(0, 120)}` };
  const n = Number(String(rc.stdout).trim());
  if (!Number.isInteger(n)) return { ok: false, detail: `stdout 非整数：${String(rc.stdout).slice(0, 60)}` };
  return { ok: n === 0, detail: `real_calls=${n}` };
}

/** 实跑交付 .bat（清空开发 ZS_*——启动器自注入全部变量；自测只加调试端口/演练钩子）。 */
async function runLauncher(pkg, debugPort, drill) {
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith('ZS_')) cleanEnv[k] = v;
  }
  cleanEnv.ZS_DEV25_DEBUG_PORT = String(debugPort);
  if (drill) cleanEnv.ZS_DEV25_DRILL = '1';
  const child = spawn('cmd.exe', ['/c', join(pkg, 'start-server.bat')], { cwd: pkg, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.write('\r\n'); // pause 预供（到达即过）
  return { child, getOut: () => out };
}

async function selfTest() {
  // 阶段 0：RESULTS 保护反例——已有回填文件在重建后必须原样保留。
  const markerPath = join(outRoot, 'RESULTS', '用户回填保护反例.md');
  const tplPath = join(outRoot, 'RESULTS', 'RESULT-template.md');
  const pristineTpl = existsSync(tplPath) ? readFileSync(tplPath, 'utf8') : RESULT_TEMPLATE;
  mkdirSync(join(outRoot, 'RESULTS'), { recursive: true });
  writeFileSync(markerPath, '用户回填标记 SELFTEST-KEEP-951\n', 'utf8');
  writeFileSync(tplPath, pristineTpl + '\n<!-- 用户已回填 SELFTEST-TPL-952 -->\n', 'utf8');
  const built = await build();
  const markerKept = existsSync(markerPath) && readFileSync(markerPath, 'utf8').includes('SELFTEST-KEEP-951');
  const tplKept = readFileSync(tplPath, 'utf8').includes('SELFTEST-TPL-952');
  console.log('[self-test] results-protection ' + (markerKept && tplKept ? 'PASS' : 'FAIL') + `（marker=${markerKept} template=${tplKept}）`);
  // 还原洁净模板与移除反例标记（交付包不带自测痕迹）。
  writeFileSync(tplPath, pristineTpl, 'utf8');
  rmSync(markerPath, { force: true });
  if (!markerKept || !tplKept) throw new Error('RESULTS 保护反例失败——重建删除了用户结果');
  // 阶段 1：中文+空格临时目录（普通用户环境等价）；副本与包本体互不撞管道名。
  const tmp = mkdtempSync(join(tmpdir(), '双机 自测-'));
  const pkg = join(tmp, 'dev25-dual-win');
  cpSync(outRoot, pkg, { recursive: true, dereference: true });
  const appData = join(pkg, 'server-data');
  const seedJson = () => {
    const p = join(pkg, 'RESULTS', 'seed.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };
  try {
    let facts1 = null;
    {
      console.log('[self-test] 启动 1/2（实跑 start-server.bat + 演练）…');
      const run = await runLauncher(pkg, 9391, true);
      void run;
      const appFacts = await assertAppFacts(9391, appData);
      console.log('[self-test] app-facts PASS（project=' + appFacts.projectName + ' runtime=fake）');
      const t0 = Date.now();
      while (Date.now() - t0 < 150_000) {
        facts1 = seedJson();
        if (facts1 != null && facts1.drill != null) break;
        await sleep(3000);
      }
      if (facts1 == null || facts1.ids?.dmConversationA == null) throw new Error('种子失败：seed.json 缺失或不完整');
      if (facts1.drill.stopAccepted !== true || facts1.drill.stoppedAtExecState !== 'terminal') {
        throw new Error('停止演练未收口：' + JSON.stringify(facts1.drill));
      }
      console.log('[self-test] seed+drill PASS（reused=' + String(facts1.reused) + ' drill=' + facts1.drill.stoppedAtExecState + ' ' + facts1.drill.elapsedMs + 'ms）');
      // 优雅停机（正式关窗链——非 taskkill）。
      const stop1 = await gracefulStop(9391, pkg);
      console.log('[self-test] graceful-stop 1 ' + (stop1.ok ? 'PASS' : 'FAIL') + '（' + stop1.detail + '）');
      if (!stop1.ok) throw new Error('优雅停机 1 失败（强杀兜底不参与成功路径——见事实）');
      const rc1 = realCallsCheck(pkg, appData);
      console.log('[self-test] real_calls 1 ' + (rc1.ok ? 'PASS' : 'FAIL') + '（' + rc1.detail + '）');
      if (!rc1.ok) throw new Error('real_calls 核对失败：' + rc1.detail);
      await sleep(2000); // 端口/句柄释放余量。
    }
    {
      // 阶段 2：同一包第二次启动——种子幂等（不重造房间/DM/消息）。
      console.log('[self-test] 启动 2/2（同包二次启动——种子幂等）…');
      rmSync(join(pkg, 'RESULTS', 'seed.json'), { force: true }); // 等本启新鲜结果（不读旧文件）
      const run2 = await runLauncher(pkg, 9392, false);
      void run2;
      await assertAppFacts(9392, appData);
      const t0 = Date.now();
      let facts2 = null;
      while (Date.now() - t0 < 150_000) {
        facts2 = seedJson();
        if (facts2 != null) break;
        await sleep(3000);
      }
      if (facts2 == null) throw new Error('二次启动种子未完成');
      // 事实核对：种子私信恰 2 条且标题命中（不重造）。
      const dms = await cdpEvalPage(9392, `window.zs.command({ protocolVersion: 1, commandId: 'selftest-2nd-list-1', method: 'conversation.list', params: {} }).then((r) => JSON.stringify((r.data && r.data.conversations) || []))`);
      const convList = JSON.parse(String(dms));
      const seededDmTitles = convList.filter((c) => c.title === 'DM A - stop drill' || c.title === 'DM B - accept drill').length;
      const seedMsgCount = facts2.commands?.['message.submit'] ?? 0;
      console.log('[self-test] second-launch idempotent ' + (facts2.reused === true && seededDmTitles === 2 && seedMsgCount === 0 ? 'PASS' : 'FAIL') + `（reused=${String(facts2.reused)} seededDms=${seededDmTitles} newMessages=${seedMsgCount}）`);
      if (facts2.reused !== true || seededDmTitles !== 2 || seedMsgCount !== 0) throw new Error('二次启动种子不幂等（reused=' + String(facts2.reused) + ' dms=' + seededDmTitles + ' newMessages=' + seedMsgCount + '）');
      const stop2 = await gracefulStop(9392, pkg);
      console.log('[self-test] graceful-stop 2 ' + (stop2.ok ? 'PASS' : 'FAIL') + '（' + stop2.detail + '）');
      if (!stop2.ok) throw new Error('优雅停机 2 失败');
    }
    const rc = realCallsCheck(pkg, appData);
    const pass = rc.ok;
    writeFileSync(join(pkg, 'RESULTS', 'selftest-summary.txt'),
      `buildId=${built.buildId}\nverified=${built.verified}\nlaunch1: seed+drill PASS, graceful-stop PASS, real_calls ${rc.detail}\nlaunch2: idempotent PASS, graceful-stop PASS\nresults-protection: PASS\nat=${new Date().toISOString()}\n`, 'utf8');
    console.log('[self-test] ' + (pass ? 'PASS' : 'FAIL') + ' buildId=' + built.buildId + ' pkg=' + pkg);
    if (!pass) process.exit(1);
  } finally {
    // 清理：先确保进程收口（失败兜底强杀并如实记录），再删临时目录。
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '${pkg.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
      { timeout: 30_000 });
    for (let i = 0; i < 5; i += 1) { try { rmSync(tmp, { recursive: true, force: true }); break; } catch { /* 句柄 */ } }
  }
}

const mode = process.argv[2] ?? '--build';
const frozenArg = process.argv.find((a) => a.startsWith('--frozen='));
if (mode === '--self-test') {
  await selfTest();
} else {
  await build(frozenArg != null ? resolve(repo, frozenArg.slice('--frozen='.length)) : frozenDefault);
}
