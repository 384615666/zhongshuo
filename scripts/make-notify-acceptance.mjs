/**
 * 通知人工验收独立入口（第二十六轮二建立；第二十七轮一修启动器闭环）。
 * 产物：dist/desktop/通知人工验收/
 * - app/（当前源码**新构建**——BUILD.json 明确 buildId；不交付旧包）
 * - app-data/（独立——不碰真实数据）；demo-project/（fake 运行时合成项目）
 * - results/（seed-*.txt 每次运行留档 + result.txt 待人工回填 + seed 脚本随包）
 * - 启动通知验收.cmd：**内容纯 ASCII**（第二十七轮实证：chcp 65001 下 cmd 解析含中文的
 *   批处理行会字节错位——set 行被劈成 'APP_DATA' 不是命令、start 行被吞、应用从未启动；
 *   第二十六轮自测走的是自设环境路径未运行本启动器，缺陷漏网）。目录名同步改 ASCII
 *   （app/app-data/demo-project/results）；中文只保留在文件名与 txt 内容（node UTF-8 写出）。
 *   隔离环境（fake/guard/独立 appData/完整前缀管道/fake-sim 标识）在 cmd 顶层显式设置——
 *   seed 与 Electron 从同一环境继承（Node 子进程无法把环境传回父 cmd；上版 start electron
 *   时这些配置全部丢失：干净环境 fake 门禁会退出、也不保证独立数据目录）。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = import.meta.dirname.replace(/\\scripts$/, '');
for (const script of ['build-ui.mjs', 'pack-daemon.mjs', 'pack-desktop.mjs']) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { cwd: repo, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) { console.error(`构建失败：${script}`); process.exit(1); }
}
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
const out = join(repo, 'dist', 'desktop', '通知人工验收');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'results'), { recursive: true });
mkdirSync(join(out, 'app-data'), { recursive: true });
mkdirSync(join(out, 'demo-project'), { recursive: true });
cpSync(staging, join(out, 'app'), { recursive: true, dereference: true });
const buildId = JSON.parse(readFileSync(join(staging, 'BUILD.json'), 'utf8')).buildId;
writeFileSync(join(out, 'BUILD.json'), JSON.stringify({ buildId, purpose: '通知人工验收（fake+guard 内置；ASCII 启动器）', createdAt: new Date().toISOString() }, null, 2), 'utf8');
// seed 脚本随包（results/ 目录=结果留档处；其相对布局 ..=包根）。
cpSync(join(repo, 'scripts', 'notify-acceptance-seed.mjs'), join(out, 'results', 'notify-acceptance-seed.mjs'));

// 纯 ASCII 启动器：中文只出现在变量值/文件名/txt 内容中，不出现在批处理行文本里。
const cmdContent = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'set PKG=%~dp0',
  'set NODEEXE=%PKG%app\\resources\\app\\daemon\\node\\node.exe',
  'rem isolation env - shared by seed and Electron (full-prefix pipe name; ASCII-only launcher content)',
  'set "ZS_APP_DATA=%PKG%app-data"',
  'set "ZS_RUNTIME=fake"',
  'set "ZS_ALLOW_FAKE=1"',
  'set "ZS_REAL_DISPATCH_GUARD=1"',
  'set "ZS_PIPE_NAME=\\\\.\\pipe\\zs-notify-acceptance"',
  'set "ZS_APP_MODE=fake-sim"',
  'rem clear dev overrides possibly inherited from the calling terminal',
  'set ZS_DAEMON_ENTRY=',
  'set ZS_NODE_BIN=',
  'set ZS_MANAGED_RUNTIME=',
  'set ZS_PACKAGED_UI=',
  'set ZS_UI_DEMO=',
  'set ZS_DEMO_DIR=',
  'set ZS_PICK_FOLDER=',
  'set ZS_UI_DAEMON_DELAY_MS=',
  'set ZS_UI_FIRST_COMMAND_DELAY_MS=',
  'set ZS_UI_DELAY_METHOD_MS=',
  'set ZS_UI_SHUTDOWN_DELAY_MS=',
  'set ZS_UI_READY_DEADLINE_MS=',
  'echo [notify-acceptance] buildId:',
  'type "%PKG%BUILD.json"',
  'echo [notify-acceptance] mode: fake runtime + real-dispatch guard + isolated data dir: %ZS_APP_DATA%',
  'echo [notify-acceptance] step 1/2: preparing demo data (10-20s)...',
  '"%NODEEXE%" "%PKG%results\\notify-acceptance-seed.mjs"',
  'if errorlevel 1 (',
  '  echo [notify-acceptance] seed FAILED - screenshot the error above. Do NOT start the app.',
  '  if /i not "%~1"=="auto" pause',
  '  exit /b 1',
  ')',
  'echo [notify-acceptance] step 2/2: starting app. Keep the window visible; two notifications due in ~90/95s.',
  'start "" "%PKG%app\\electron.exe"',
  'echo   - click each notification: (1) room task thread  (2) DM conversation. Locate-only, no confirm.',
  'echo   - wait ~2 more minutes: the same item must NOT notify again.',
  'if not exist "%PKG%results\\result.txt" copy /y "%PKG%results\\result-template.txt" "%PKG%results\\result.txt" >nul',
  'echo   - write your results into results\\result.txt (seed facts per run: results\\seed-*.txt).',
  'echo   - full steps in Chinese: open the guide txt file in this folder.',
  'if /i not "%~1"=="auto" pause',
  'endlocal',
].join('\r\n');
writeFileSync(join(out, '启动通知验收.cmd'), cmdContent, 'utf8');

writeFileSync(join(out, '验收步骤.txt'), `通知人工验收步骤（第二十七轮一修订）

产物身份：BUILD.json（buildId——当前源码新构建，非旧包）。模式：fake 运行时 +
ZS_REAL_DISPATCH_GUARD=1 + 独立数据目录（app-data/）——启动器已内置全部隔离配置
（不依赖任何外部环境变量；不会发起任何真实模型调用；不读取你的真实数据）。
窗口标题带「模拟验证模式」标识。每次运行的 seed 事实（退出码/停机尾行/管道/目录）
自动留档在 results\\seed-*.txt；你的回填写在 results\\result.txt（重复运行不覆盖回填）。

你只需做：
1. 双击「启动通知验收.cmd」（自动：造合成数据→启动应用→自动恢复合成项目）。
2. 保持应用窗口可见，约 90/95 秒后应先后出现两条 Windows 系统通知：
   ①「众说：提醒待确认——房间线程提醒：点击应定位任务线程」
   ②「众说：提醒待确认——私信提醒：点击应定位私信会话」
3. 逐条点击通知：应用窗口聚焦并定位到对应位置（①房间任务线程；②私信会话）。
   点击只定位，不会确认执行。
4. 再等约 2 分钟（应用每 6 秒轮询）：同一事项不应再次弹出系统通知。
5. 可选：侧栏「提醒管理」对任一提醒点「取消」——其后不再有待确认通知。
6. 把结果写入 results\\result.txt：
   - 两条通知是否出现（各一行 是/否）
   - 点击定位是否正确（房间线程/私信各一行）
   - 是否出现重复通知（是/否）
   - Windows 通知中心是否留有记录（是/否）
   - 异常描述（如有）

说明：应用内通知日志只记录客户端各相事件（权限/创建/送达事件/失败/关闭），
不能证明 Windows 已显示——本人工验收即补此证据。等待你复核期间工程继续。
`.trim(), 'utf8');
writeFileSync(join(out, 'results', 'result-template.txt'), `通知人工验收结果（待回填——${new Date().toISOString()} 生成模板）
1. 房间线程通知出现：是/否
2. 私信通知出现：是/否
3. 点击①定位房间任务线程正确：是/否
4. 点击②定位私信会话正确：是/否
5. 出现重复通知：是/否
6. Windows 通知中心留有记录：是/否
7. 异常描述：
`, 'utf8');
writeFileSync(join(out, 'results', 'result.txt'), `通知人工验收结果（待回填——${new Date().toISOString()} 生成模板）
1. 房间线程通知出现：是/否
2. 私信通知出现：是/否
3. 点击①定位房间任务线程正确：是/否
4. 点击②定位私信会话正确：是/否
5. 出现重复通知：是/否
6. Windows 通知中心留有记录：是/否
7. 异常描述：
`, 'utf8');
console.log(`[通知验收] 产物就绪：${out}`);
console.log(`[通知验收] buildId=${buildId}；双击「启动通知验收.cmd」；步骤见 验收步骤.txt`);
