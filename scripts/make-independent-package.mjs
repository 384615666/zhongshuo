/**
 * 第十五轮六：独立 Windows 交付材料——不依赖源码仓库/node_modules/开发 PATH/开发机账号。
 * 产物：dist/desktop/独立交付/
 *   众说-便携-win-x64/            —— 便携包全量（复制自 pack-desktop staging）
 *   MANIFEST.json                 —— 版本/commit/关键文件 SHA256（可复制后核对）
 *   tools/verify-local.mjs        —— 自足本地验证（用产物自带 node.exe 运行；不碰真实模型）
 *   独立验证.cmd                  —— 入口：双击或命令行运行
 *   一页说明.md                   —— 操作步骤+需反馈环境信息+脱敏诊断导出说明
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
if (!existsSync(join(staging, 'electron.exe'))) { console.error('缺便携包：先 node scripts/pack-desktop.mjs'); process.exit(1); }
const out = join(repo, 'dist', 'desktop', '独立交付');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const pkgRoot = join(out, '众说-便携-win-x64');
cpSync(staging, pkgRoot, { recursive: true, dereference: true });

// MANIFEST：commit/版本/关键文件 SHA256。
const commit = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const keyFiles = [
  'electron.exe', 'resources/app/package.json', 'resources/app/dist/ui/main.cjs',
  'resources/app/dist/ui/preload.cjs', 'resources/app/dist/ui/renderer/index.html',
  'resources/app/daemon/daemon.cjs', 'resources/app/daemon/node/node.exe',
  'resources/app/daemon/node_modules/koffi/package.json',
  'resources/app/daemon/node_modules/better-sqlite3/package.json',
];
const manifest = {
  name: '众说 便携预览版（独立 Windows 验证交付）', generatedAt: new Date().toISOString(),
  commit, nodeVersion: process.version,
  files: keyFiles.map((rel) => ({ path: rel, sha256: sha256(join(pkgRoot, rel)) })),
  note: '复制到目标机后可用 Get-FileHash -Algorithm SHA256 核对；本轮独立环境只做本地/fake 验证（不装 Git/Node/Claude、不登 GitHub、不真实模型调用、不复制凭据）',
};
writeFileSync(join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

// 自足验证脚本：模板复制（内容见 scripts/independent-verify-local.template.mjs）。
mkdirSync(join(out, 'tools'), { recursive: true });
cpSync(join(repo, 'scripts', 'independent-verify-local.template.mjs'), join(out, 'tools', 'verify-local.mjs'));

writeFileSync(join(out, '独立验证.cmd'), ['@echo off', 'chcp 65001 >nul', 'cd /d "%~dp0"', '"众说-便携-win-x64\\resources\\app\\daemon\\node\\node.exe" "tools\\verify-local.mjs"', 'pause'].join('\r\n'), 'utf8');

writeFileSync(join(out, '一页说明.md'), [
  '# 众说 便携预览版 · 独立 Windows 验证一页说明',
  '',
  '## 你需要做什么（约 10 分钟）',
  '1. 把整个 `独立交付` 文件夹复制到目标 Windows 电脑（U 盘/共享均可；路径可含中文/空格）。',
  '2. （可选）核对完整性：`Get-FileHash -Algorithm SHA256 <文件>` 对照 `MANIFEST.json`。',
  '3. 双击 `独立验证.cmd`——它只用**包自带**的 Node 运行本地验证（不装 Git/Node/Claude、不登 GitHub、不调用任何真实模型、不上传数据）。结束后回传它打印的 `独立验证结果.json` 路径下文件。',
  '4. 手动体验（可选但推荐）：双击 `众说-便携-win-x64\\electron.exe` →「打开本地文件夹…」选一个空文件夹 → 发一条消息 → 等待 fake 成员回复 → 项目设置里改成员 runtime 绑定/任务验收开关 → 关闭重开确认保持 → 正常关闭。',
  '',
  '## 本轮验证范围（本地/fake——不含真实模型与 Git 远端）',
  '启动、页面操作、设置保存与重开、同 appData 重复启动、并发第二实例拒绝、停止、正常退出、原生依赖（SQLite/koffi）加载、无残留进程。',
  '',
  '## 请回传的信息',
  '- Windows 版本（如 10 22H2 / 11 24H2）、系统架构（x64/ARM64）、实体机或虚拟机；',
  '- `独立验证结果.json`（脚本会打印路径）与任何截图/报错原文；',
  '- 若系统/杀软拦截，保留提示原文并注明被拦的操作——受影响的验证项会如实标注，**不需要关闭杀毒软件**。',
  '',
  '## 边界（如实）',
  '- 便携包不含 Git/Claude CLI：Git 操作与真实模型验证不在本轮独立环境范围（需要时另列前置条件）；',
  '- 不修改系统安全策略、不写注册表、不复制你开发机的凭据或账号配置。',
].join('\n'), 'utf8');

console.log(`[independent-package] 就绪：${out}`);
console.log(`commit=${commit}`);
