/**
 * DEV-15 桌面便携产物装配（第十四轮四）：本地可复核、不发布、不安装、不改用户环境。
 *
 * 产物：dist/desktop/众说-便携-win-x64/
 *   electron.exe + locales/ + 资源文件…（node_modules/electron/dist 全量拷贝）
 *   resources/app/package.json            —— main=dist/ui/main.cjs（Electron 壳）
 *   resources/app/dist/ui/*              —— build:ui 产物（main/preload/renderer）
 *   resources/app/daemon/daemon.cjs      —— pack-daemon 产物（CJS bundle）
 *   resources/app/daemon/node/node.exe   —— 随包 Node 宿主（daemon 运行不依赖开发机 PATH/
 *                                            系统 Node——ABI 与 node_modules 原生模块自洽）
 *   resources/app/daemon/node_modules/{koffi,@koromix/better-sqlite3}
 *                                          —— 按实际版本解析（读 package.json——不硬编码）
 *
 * 前置：node scripts/build-ui.mjs && node scripts/pack-daemon.mjs（缺产物明确报错退出）。
 * 验收：node scripts/verify-desktop.mjs（中文/空格安装目录/首启/重复启动/正常退出/受管缺失负例）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');

const uiMain = join(repo, 'dist', 'ui', 'main.cjs');
const daemonCjs = join(repo, 'dist', 'pack', 'daemon.cjs');
const electronDist = join(repo, 'node_modules', 'electron', 'dist');
for (const [what, path] of [['UI 产物', uiMain], ['daemon 产物', daemonCjs], ['electron 发行目录', electronDist]]) {
  if (!existsSync(path)) {
    console.error(`[pack-desktop] 缺${what}：${path}（先运行 node scripts/build-ui.mjs / node scripts/pack-daemon.mjs）`);
    process.exit(1);
  }
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// ① Electron 运行时全量拷贝（electron.exe + dll + locales + resources/default_app…）。
cpSync(electronDist, staging, { recursive: true, dereference: true });

// ② 应用目录：resources/app（存在时 Electron 优先于 default_app）。
const appDir = join(staging, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: 'zhongshuo',
  productName: '众说',
  version: '0.1.0',
  description: '众说——本地多 Agent 协同工作台（便携预览版）',
  main: 'dist/ui/main.cjs',
  private: true,
}, null, 2), 'utf8');
cpSync(join(repo, 'dist', 'ui'), join(appDir, 'dist', 'ui'), { recursive: true });

// ③ daemon：bundle + 随包 Node 宿主 + 原生依赖（相对 daemon.cjs 向上解析 node_modules）。
const daemonDir = join(appDir, 'daemon');
mkdirSync(daemonDir);
cpSync(daemonCjs, join(daemonDir, 'daemon.cjs'));
mkdirSync(join(daemonDir, 'node'), { recursive: true });
cpSync(process.execPath, join(daemonDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
const nm = join(daemonDir, 'node_modules');
mkdirSync(nm, { recursive: true });
const koffiVersion = JSON.parse(readFileSync(join(repo, 'node_modules', 'koffi', 'package.json'), 'utf8')).version;
for (const dep of ['koffi', 'better-sqlite3', '@koromix']) {
  const src = join(repo, 'node_modules', dep);
  if (!existsSync(src)) continue;
  cpSync(realpathSync(src), join(nm, dep), { recursive: true, dereference: true });
}
const koffiPlatform = join(repo, 'node_modules', '.pnpm', `koffi@${koffiVersion}`, 'node_modules', '@koromix');
if (!existsSync(koffiPlatform)) {
  console.error(`[pack-desktop] koffi 平台包缺失：${koffiPlatform}（版本按实际解析——不硬编码）`);
  process.exit(1);
}
mkdirSync(join(nm, '@koromix'), { recursive: true });
cpSync(koffiPlatform, join(nm, '@koromix'), { recursive: true, dereference: true });

for (const path of [
  join(appDir, 'dist', 'ui', 'main.cjs'),
  join(appDir, 'dist', 'ui', 'preload.cjs'),
  join(appDir, 'dist', 'ui', 'renderer', 'index.html'),
  join(daemonDir, 'daemon.cjs'),
  join(daemonDir, 'node', 'node.exe'),
  join(nm, 'koffi', 'package.json'),
  join(nm, 'better-sqlite3', 'package.json'),
]) {
  if (!existsSync(path)) {
    console.error(`[pack-desktop] 装配不完整：${path}`);
    process.exit(1);
  }
}
console.log(`[pack-desktop] 便携产物就绪：${staging}`);
console.log('[pack-desktop] 审收：node scripts/verify-desktop.mjs');
