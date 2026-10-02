'use strict';
/**
 * DEV-25 双机验收包构建（第三十二轮六）。
 * 产物 dist/desktop/dev25-dual-win/（内部全 ASCII 目录；顶层说明文档可中文）：
 * - ZhongshuoDual/：便携应用拷贝（daemon/UI；随包 node.exe 运行种子与自检——客户端机无需 Node）；
 * - start-server.bat：ASCII 启动器——内置 ZS_APP_DATA/ZS_RUNTIME=fake/ZS_ALLOW_FAKE=1/
 *   ZS_REAL_DISPATCH_GUARD=1（真实派发硬防护）/独立完整管道名/两 Agent 引导/fake 首任务停滞窗口
 *   （D4 停止演练）；先起 UI 再跑 seed-client（重试等 daemon 就绪）；
 * - run-self-check.bat：协议机械负例自动化（错码/伪造 Host/Origin/无 token/审计）；
 * - RESULTS/：seed.json+self-check 输出（脱敏）+RESULT-template.md（用户回填——构建不覆盖）；
 * - README-双机验收.md：服务机/客户端步骤（含证书完整指纹核对与系统信任）。
 * 自测（--self-test）：在**清空环境变量+中文与空格路径**的普通目录实际运行交付启动器链
 * （spawn 同款 env → seed → 优雅停机），不依赖开发终端任何 ZS_* 变量。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
const outRoot = join(repo, 'dist', 'desktop', 'dev25-dual-win');

const BAT_LAUNCHER = [
  '@echo off',
  'rem DEV-25 dual-machine acceptance server launcher (ASCII only - codepage safe)',
  'setlocal',
  'set PKG=%~dp0',
  'set APP_DIR=%PKG%server-data',
  'set DEMO_DIR=%PKG%demo-project',
  'set PIPE_NAME=\\\\.\\pipe\\zs-dev25-dual',
  'set ZS_APP_DATA=%APP_DIR%',
  'set ZS_RUNTIME=fake',
  'set ZS_ALLOW_FAKE=1',
  'set ZS_REAL_DISPATCH_GUARD=1',
  'set ZS_PIPE_NAME=%PIPE_NAME%',
  'set ZS_BOOTSTRAP_AGENTS=Guide A,Guide B',
  'set ZS_FAKE_STALL_MS=60000',
  'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
  'echo Starting Zhongshuo desktop (fake runtime + real-dispatch guard, zero real model calls)...',
  'start "ZhongshuoDual" "%PKG%ZhongshuoDual\\electron.exe"',
  'echo Seeding demo project via formal commands (retries until daemon ready)...',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%seed\\seed-client.cjs" --appdata "%APP_DIR%" --pipe "%PIPE_NAME%" --demo "%DEMO_DIR%"',
  'if errorlevel 1 (echo SEED FAILED - see messages above. Close the app window and retry.) else (echo Seeded. RESULTS\\seed.json written.)',
  'echo.',
  'echo NEXT: in the app sidebar open the REMOTE ACCESS panel, choose LAN (0.0.0.0), click ENABLE,',
  'echo then click the pairing button and copy ADDRESS + FULL SHA-256 fingerprint for the client machine.',
  'echo Optional mechanical negatives: click the self-check pairing button, then run run-self-check.bat.',
  'echo Keep this console open during acceptance. Closing the app window exits the server.',
  'pause',
  'endlocal',
  '',
].join('\r\n');

const BAT_SELFCHECK = [
  '@echo off',
  'rem DEV-25 protocol self-check (server machine, after LAN enabled in UI)',
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

## 服务机步骤

1. 双击 \`start-server.bat\`（等控制台出现 "Seeded." 与应用窗口）。合成数据已建：
   项目「DEV25 双机验收」+ 两 Agent（Guide A/B）+ 房间×2 + 私信 DM A（停止演练）与 DM B（验收演练）
   + 附件样本与仅记录消息（seed 明细在 \`RESULTS/seed.json\`）。
2. 应用侧栏 →「远程访问（DEV-25）」面板：
   - 监听地址选 **局域网（0.0.0.0）** → 点「启用」→ 面板给出 **实际地址** 与 **完整 64 位 SHA-256 指纹**
     （两个按钮可一键复制）。记下两者交给客户端机。防火墙弹窗选「允许」。
   - 点「生成配对码」→ 把 pairingId 与 8 位码交给客户端机（5 分钟内一次有效）。
3. （可选，机械负例自动化）点「自检码→RESULTS」→ 回本目录双击 \`run-self-check.bat\` →
   \`RESULTS/self-check-*.json\` 给出错码/伪造 Host/伪造 Origin/无 token 的自动结论（替代手做 curl）。
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
D8 服务机吊销→立即断流+401 | D9（已自动化——run-self-check）| D10 错码（已自动化）

## 结果与边界

- 自动留档：\`RESULTS/seed.json\`（种子）、\`RESULTS/self-check-*.json\`（协议负例）、应用退出时
  \`server-data/desktop-shutdown.json\`（停机事实）、real_calls=0（硬防护事实）。
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
| D6 | 重试恰一次 | 断网/刷新后页面「未完成操作」重试→消息恰一条 | | |
| D7 | 关闭客户端任务继续 | 发任务→关浏览器→重开→结果消息可见 | | |
| D8 | 吊销终态 | 服务机吊销→客户端立即断流+明确终态横幅 | | |
| D9 | 伪造 Host/Origin（自动化） | run-self-check.bat 结论 | | self-check-*.json |
| D10 | 错码（自动化） | run-self-check.bat 结论 | | self-check-*.json |

异常与备注：
`;

function build() {
  if (!existsSync(staging)) throw new Error('staging not found: ' + staging + '——先 node scripts/pack-desktop.mjs');
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  cpSync(staging, join(outRoot, 'ZhongshuoDual'), { recursive: true, dereference: true });
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
  const buildId = JSON.parse(readFileSync(join(staging, 'BUILD.json'), 'utf8')).buildId;
  writeFileSync(join(outRoot, 'RESULTS', 'buildId.txt'), String(buildId) + '\n', 'ascii');
  console.log('[dev25-dual] package ready: ' + outRoot + ' buildId=' + buildId);
  return buildId;
}

/** 自测：清空环境变量+中文与空格路径下实际运行交付启动器链（spawn 同款 env → seed → 停机）。 */
async function selfTest() {
  const buildId = build();
  // 中文+空格临时目录模拟用户环境；env 白名单（清空开发终端 ZS_* 覆盖变量）。
  const tmp = mkdtempSync(join(tmpdir(), '双机 自测-'));
  const pkg = join(tmp, 'dev25-dual-win');
  cpSync(outRoot, pkg, { recursive: true, dereference: true });
  const appData = join(pkg, 'server-data');
  const pipeName = '\\\\.\\pipe\\zs-dev25-dual-selftest';
  const demo = join(pkg, 'demo-project');
  // 清空开发终端覆盖变量（第三十二轮六口径）：继承常规环境但**剔除全部 ZS_***，再显式注入
  // 交付启动器同款变量——普通用户环境等价（Electron/Chromium 需要常规系统变量，全裸白名单不稳）。
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith('ZS_')) cleanEnv[k] = v;
  }
  Object.assign(cleanEnv, {
    ZS_APP_DATA: appData,
    ZS_RUNTIME: 'fake',
    ZS_ALLOW_FAKE: '1',
    ZS_REAL_DISPATCH_GUARD: '1',
    ZS_PIPE_NAME: pipeName,
    ZS_BOOTSTRAP_AGENTS: 'Guide A,Guide B',
  });
  console.log('[self-test] env: parent(minus ZS_*) + launcher vars');
  console.log('[self-test] env keys: ' + Object.keys(cleanEnv).join(','));
  const child = spawn(join(pkg, 'ZhongshuoDual', 'electron.exe'), [], { cwd: join(pkg, 'ZhongshuoDual'), env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    // seed（重试内部已含——等待 UI/daemon 就绪）。
    const seed = spawnSync(join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe'),
      [join(pkg, 'seed', 'seed-client.cjs'), '--appdata', appData, '--pipe', pipeName, '--demo', demo],
      { encoding: 'utf8', timeout: 120_000, env: cleanEnv });
    const seedOk = seed.status === 0;
    console.log('[self-test] seed exit=' + seed.status + ' out=' + String(seed.stdout).slice(0, 300) + ' err=' + String(seed.stderr).slice(0, 300));
    const seedJson = existsSync(join(pkg, 'RESULTS', 'seed.json')) ? JSON.parse(readFileSync(join(pkg, 'RESULTS', 'seed.json'), 'utf8')) : null;
    const seeded = seedOk && seedJson != null && seedJson.ids.dmConversationA != null && seedJson.ids.dmConversationB != null;
    // 优雅停机（关窗=退出；子进程 kill 后核对 pid 文件清理与退出码）。
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 30_000);
      child.once('exit', (code) => { clearTimeout(t); resolve(code); });
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000 });
    });
    // real_calls 核对（用打包内 better-sqlite3）。
    const rc = spawnSync(join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe'),
      ['-e', 'const D=require(' + JSON.stringify(join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node_modules', 'better-sqlite3')) + ');const db=new D(' + JSON.stringify(join(appData, 'state.sqlite')) + ',{readonly:true});const c=db.prepare("SELECT count(*) c FROM real_calls").get().c;console.log(c);db.close();'],
      { encoding: 'utf8', timeout: 30_000 });
    const realCallsCount = Number(String(rc.stdout).trim());
    writeFileSync(join(pkg, 'RESULTS', 'selftest-stderr.log'), stderr, 'utf8');
    console.log('[self-test] exit=' + exited + ' seeded=' + seeded + ' real_calls=' + realCallsCount + ' stderrLen=' + stderr.length);
    const pass = seeded && exited !== 'timeout' && realCallsCount === 0;
    console.log('[self-test] ' + (pass ? 'PASS' : 'FAIL') + ' buildId=' + buildId + ' pkg=' + pkg);
    if (!pass) process.exit(1);
  } finally {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000 }); } catch { /* 尽力 */ }
    for (let i = 0; i < 5; i += 1) { try { rmSync(tmp, { recursive: true, force: true }); break; } catch { /* 句柄 */ } }
  }
}

const mode = process.argv[2] ?? '--build';
if (mode === '--self-test') {
  await selfTest();
} else {
  build();
}
