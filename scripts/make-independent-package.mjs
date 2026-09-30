/**
 * 第十六轮二/五：独立 Windows 交付（可追溯）——本地构建、不发布、不依赖开发环境运行。
 *
 * 产物：dist/desktop/独立交付/
 *   众说-便携-win-x64/          —— 便携包（pack-desktop 产物，含 BUILD.json+MANIFEST-SHA256.json 全文件清单）
 *   tools/verify-local.mjs      —— 自动本地验证（daemon 级：清单核对/设置/fake 全链/关闭/重开/并发拒绝/残留+decoy）
 *   tools/verify-desktop-local.mjs —— 自动桌面验证（renderer 级 CDP：页面操作/真实派发防护拒绝/重开保持/停止）
 *   自动本地验证.cmd / 自动桌面验证.cmd / 本地体验启动.cmd —— 三个入口（真实退出码）
 *   交付清单.json               —— 覆盖验证脚本与启动器（verify-local 核对包清单时一并核对）
 *   一页说明.md                 —— 自动（daemon 级/renderer 级）与人工项目分开列出，不冒充
 * 验证结果固定保存在 独立交付/验证结果/<编号>/summary.json——临时目录清理不影响证据。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
// 从当前工作区构建，但完整记录源码身份（commit+dirty 差异哈希——pack-desktop 写入 BUILD.json）。
for (const script of ['build-ui.mjs', 'pack-daemon.mjs', 'pack-desktop.mjs']) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { cwd: repo, encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) { console.error(`前置构建失败（${script}）：${(r.stdout ?? '') + (r.stderr ?? '')}`); process.exit(1); }
}
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
const build = JSON.parse(readFileSync(join(staging, 'BUILD.json'), 'utf8'));
const out = join(repo, 'dist', 'desktop', '独立交付');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const pkgRoot = join(out, '众说-便携-win-x64');
cpSync(staging, pkgRoot, { recursive: true, dereference: true });

mkdirSync(join(out, 'tools'), { recursive: true });
cpSync(join(repo, 'scripts', 'independent-verify-local.template.mjs'), join(out, 'tools', 'verify-local.mjs'));
cpSync(join(repo, 'scripts', 'independent-verify-desktop.template.mjs'), join(out, 'tools', 'verify-desktop-local.mjs'));

/** 入口 .cmd：UTF-8、保留真实退出码、结束显示结果目录。 */
const cmd = (title, body) => [
  '@echo off',
  'chcp 65001 >nul',
  `title ${title}`,
  'cd /d "%~dp0"',
  ...body,
  'set EC=%ERRORLEVEL%',
  'echo.',
  'echo 验证结果保存在：独立交付\\验证结果\\（各 run-*\\summary.json 可回传）',
  'pause',
  'exit /b %EC%',
].join('\r\n');
writeFileSync(join(out, '自动本地验证.cmd'), cmd('自动本地验证（daemon 级）', [
  'echo 【自动本地验证·daemon 级】清单核对/启动/设置/fake 全链/正式关闭/同 appData 重开/并发拒绝/无残留（含检测控制组）',
  '"众说-便携-win-x64\\resources\\app\\daemon\\node\\node.exe" "tools\\verify-local.mjs"',
]), 'utf8');
writeFileSync(join(out, '自动桌面验证.cmd'), cmd('自动桌面验证（renderer 级）', [
  'echo 【自动桌面验证·renderer 级】真实页面操作/成员绑定真实 runtime 后发送=防护拒绝/重开保持/停止闭环',
  '"众说-便携-win-x64\\resources\\app\\daemon\\node\\node.exe" "tools\\verify-desktop-local.mjs"',
]), 'utf8');
// 本地体验启动：显式模拟验证模式（fake+真实派发防护）——不依赖目标机环境变量。
writeFileSync(join(out, '本地体验启动.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'title 众说（模拟验证模式启动器）',
  'cd /d "%~dp0"',
  'echo 【模拟验证模式】fake runtime + 真实派发防护：即使你在界面里保存了真实 runtime 绑定，发送也只会在 spawn 前被拒绝，不会发出真实模型请求。',
  'set ZS_APP_MODE=fake-sim',
  'set ZS_RUNTIME=fake',
  'set ZS_ALLOW_FAKE=1',
  'set ZS_REAL_DISPATCH_GUARD=1',
  'set ZS_APP_DATA=%~dp0体验数据',
  'start "" "众说-便携-win-x64\\electron.exe"',
].join('\r\n'), 'utf8');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(join(out, '一页说明.md'), [
  '# 众说 便携预览版 · 独立 Windows 验证一页说明',
  '',
  `**本包身份**：buildId \`${build.buildId}\`（源码 commit \`${build.commit}\`${build.dirty ? `，构建时工作区有未提交改动（差异哈希 \`${String(build.dirtyDiffHash).slice(0, 16)}…\`）` : '，工作区干净'}）。包内 \`众说-便携-win-x64/MANIFEST-SHA256.json\` 为全文件 SHA256 清单（含 renderer/原生二进制）；本目录 \`交付清单.json\` 覆盖验证脚本与启动器。自动验证开始时先逐文件核对，篡改/缺失即拒绝。`,
  '',
  '## 自动验证（推荐先跑，合计约 5–8 分钟；结果在 `独立交付\\验证结果\\<编号>\\summary.json`）',
  '1. **自动本地验证.cmd**（daemon 级）：清单核对、残留检测控制组、daemon 启动（原生依赖）、设置读写、本地 fake 任务全链、正式关闭、同 appData 重开与设置保持、并发第二实例拒绝、无残留。退出码 0=通过。',
  '2. **自动桌面验证.cmd**（renderer 级·会开窗口）：页面打开项目、发送并收到 fake 回复、**在界面里把成员绑定到真实 runtime 后发送→被「真实派发防护」拒绝（预期行为——模拟验证模式不发真实模型请求）**、优雅停机、重开绑定保持、停止按钮闭环。退出码 0=通过。',
  '',
  '## 本地体验（人工，约 5 分钟）',
  '3. 双击 **本地体验启动.cmd**（不要直接双击 electron.exe——该入口已预设「模拟验证模式」，窗口标题会显示）。体验：打开一个**空文件夹**→发消息→等 fake 成员回复→项目设置改成员绑定/任务验收开关→关闭再开确认保持→正常关闭。',
  '',
  '## 人工验证清单（做完可勾选回传）',
  '- [ ] 窗口正常显示中文（无乱码/方框）',
  '- [ ] 「打开本地文件夹…」弹出系统目录选择器并能选择',
  '- [ ] 发送后线程出现回复、任务状态变化可见',
  '- [ ] 项目设置：成员绑定保存后有回显；任务验收开关可切换',
  '- [ ] 关闭窗口后再开，上述设置保持',
  '- [ ] 关闭后无残留进程（任务管理器中无本包路径的 node/electron）',
  '',
  '## 请回传',
  '- Windows 版本（如 10 22H2 / 11 24H2）、架构（x64/ARM64）、实体机或虚拟机；',
  '- `验证结果\\` 下各 `summary.json`（两个自动入口各一份）；',
  '- 人工清单勾选情况与任何报错截图原文；',
  '- 若系统/杀软拦截：保留提示原文并注明被拦操作——受影响项如实标注，**不需要关闭杀毒软件**。',
  '',
  '## 边界（如实）',
  '- 本包不含 Git/Claude CLI：Git 操作与真实模型验证不在独立环境范围（需要时另列前置条件）；',
  '- 不登录账号、不上传数据、不修改系统安全策略、不写注册表、不复制开发机凭据；',
  '- 直接双击 electron.exe 而不经「本地体验启动.cmd」时，模拟验证门禁未设置——请使用提供的入口。',
].join('\n'), 'utf8');

const deliveryFiles = ['tools/verify-local.mjs', 'tools/verify-desktop-local.mjs', '自动本地验证.cmd', '自动桌面验证.cmd', '本地体验启动.cmd', '一页说明.md'];
writeFileSync(join(out, '交付清单.json'), JSON.stringify({
  packageBuildId: build.buildId,
  commit: build.commit,
  dirty: build.dirty,
  dirtyDiffHash: build.dirtyDiffHash,
  root: '清单相对本交付目录',
  files: deliveryFiles.map((rel) => ({ path: rel, sha256: sha256(join(out, rel)) })),
}, null, 2), 'utf8');

console.log(`[independent-package] 就绪：${out}`);
console.log(`buildId=${build.buildId} commit=${build.commit}${build.dirty ? ' dirty' : ' clean'}`);
console.log('入口：自动本地验证.cmd / 自动桌面验证.cmd / 本地体验启动.cmd（结果→独立交付/验证结果/）');
