/**
 * 通知人工验收独立入口（第二十六轮二）：一键启动、固定结果目录。
 * 产物：dist/desktop/通知人工验收/
 * - 应用/（当前源码**新构建**——BUILD.json 明确 buildId；不交付旧包）
 * - 应用数据/（独立——不碰真实数据）；合成项目/（fake 运行时）
 * - 验证结果/（seed-ok.txt+结果.txt 待人工回填+本目录即结果留档）
 * - 启动通知验收.cmd：①包内 node 跑 seed（正式 daemon 管道造数，fake+ZS_REAL_DISPATCH_GUARD=1
 *   内置——用户无需配任何环境变量）→ ②启动应用（首启经 ui.autoOpenProjectPath 自动恢复
 *   合成项目）→ ③约 90/95 秒两条系统通知（房间线程+私信各一）
 * - 验收步骤.txt：看到通知→点击回正确位置（只定位不确认）→重复轮询不重复→结果回填。
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
mkdirSync(join(out, '验证结果'), { recursive: true });
mkdirSync(join(out, '应用数据'), { recursive: true });
mkdirSync(join(out, '合成项目'), { recursive: true });
cpSync(staging, join(out, '应用'), { recursive: true, dereference: true });
const buildId = JSON.parse(readFileSync(join(staging, 'BUILD.json'), 'utf8')).buildId;
writeFileSync(join(out, 'BUILD.json'), JSON.stringify({ buildId, purpose: '通知人工验收（fake+guard 内置）', createdAt: new Date().toISOString() }, null, 2), 'utf8');
// seed 脚本随包（验证结果/ 目录=结果留档处；其相对布局 ..=包根）。
cpSync(join(repo, 'scripts', 'notify-acceptance-seed.mjs'), join(out, '验证结果', 'notify-acceptance-seed.mjs'));

const cmdContent = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'set PKG=%~dp0',
  'set NODEEXE=%PKG%应用\\resources\\app\\daemon\\node\\node.exe',
  'echo [通知验收] buildId 见 BUILD.json；fake 运行时+真实派发防护已内置（无需任何配置）。',
  'echo [通知验收] 第 1/2 步：准备合成数据（约 10-20 秒）...',
  '"%NODEEXE%" "%PKG%验证结果\\notify-acceptance-seed.mjs"',
  'if errorlevel 1 (',
  '  echo [通知验收] 种子失败——请把上方错误截图回传，不要启动应用。',
  '  pause & exit /b 1',
  ')',
  'echo [通知验收] 第 2/2 步：启动应用（保持窗口可见；约 90 秒后应出现两条系统通知）。',
  'start "" "%PKG%应用\\electron.exe"',
  'echo   - 点击通知应定位：①房间任务线程 ②私信会话（只定位，不确认执行）。',
  'echo   - 再等约 2 分钟：同一事项不应重复通知。',
  'echo   - 结果请写入 验证结果\\结果.txt（模板已备）。',
  'pause',
  'endlocal',
].join('\r\n');
writeFileSync(join(out, '启动通知验收.cmd'), cmdContent, 'utf8');

writeFileSync(join(out, '验收步骤.txt'), `通知人工验收步骤（第二十六轮二）

产物身份：BUILD.json（buildId——当前源码新构建，非旧包）。模式：fake 运行时 +
ZS_REAL_DISPATCH_GUARD=1（两者内置——不会发起任何真实模型调用；不读取你的真实数据）。

你只需做：
1. 双击「启动通知验收.cmd」（自动：造合成数据→启动应用→自动恢复合成项目）。
2. 保持应用窗口可见，约 90/95 秒后应先后出现两条 Windows 系统通知：
   ①「众说：提醒待确认——房间线程提醒：点击应定位任务线程」
   ②「众说：提醒待确认——私信提醒：点击应定位私信会话」
3. 逐条点击通知：应用窗口聚焦并定位到对应位置（①房间任务线程；②私信会话）。
   点击只定位，不会确认执行。
4. 再等约 2 分钟（应用每 6 秒轮询）：同一事项不应再次弹出系统通知。
5. 可选：侧栏「提醒管理」对任一提醒点「取消」——其后不再有待确认通知。
6. 把结果写入 验证结果\\结果.txt（模板见该文件）：
   - 两条通知是否出现（各一行 是/否）
   - 点击定位是否正确（房间线程/私信各一行）
   - 是否出现重复通知（是/否）
   - Windows 通知中心是否留有记录（是/否）
   - 异常描述（如有）

说明：应用内通知日志只记录客户端各相事件（权限/创建/送达事件/失败/关闭），
不能证明 Windows 已显示——本人工验收即补此证据。等待你复核期间工程继续。
`.trim(), 'utf8');
writeFileSync(join(out, '验证结果', '结果.txt'), `通知人工验收结果（待回填——${new Date().toISOString()} 生成模板）
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
