/**
 * 日常桌面便携包（R63 P3c——review-r62 §4）：desktop-daily-win-v1。
 *
 * 与演练包（hifi-h4-win-*）的区别——**这是给用户日常使用的正式入口**：
 *  - 启动器不设 ZS_RUNTIME=fake / ZS_ALLOW_FAKE / ZS_REAL_DISPATCH_GUARD / ZS_BOOTSTRAP_AGENTS
 *    ——daemon 以 ZS_RUNTIME=claude 启动（成员绑定优先解析：memberRuntime.resolveMemberRuntime
 *    成员级 installation 覆盖全局默认；未绑定成员回落全局 claude+渠道默认模型）；
 *  - **不运行 seed**（无 Guide 演练会话/模拟回复/演示项目）、不带 seed/ 与 samples/；
 *  - 独立稳定数据根=<包目录>\server-data（与演练包数据根互不影响；不迁移/不改写任何旧库）；
 *  - 真实模型调用只随用户主动发送发生（启动/打开项目/配置读回/重连零调用）。
 * 复用同一构建门（build:ui→pack-daemon→pack-desktop 自建，产物必须来自当前源码）。
 * 用法：node scripts/make-desktop-daily.mjs [输出目录名]（默认 dist/desktop/desktop-daily-win-v1）。
 */
import { cpSync, mkdirSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
const outArg = process.argv[2];
const out = join(repo, 'dist', 'desktop', outArg ?? 'desktop-daily-win-v1');
if (existsSync(join(out, 'RESULTS')) && readdirSync(join(out, 'RESULTS')).length > 0) {
  console.error('[daily-pkg] 拒绝：目标目录 RESULTS 非空（用户回填保护）');
  process.exit(1);
}

// 0) 构建门：产物必须来自当前源码（与演练包同门——不拷旧产物）。
for (const [label, script] of [['build:ui', 'build-ui.mjs'], ['pack-daemon', 'pack-daemon.mjs']]) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { stdio: 'inherit', cwd: repo });
  if (r.status !== 0) { console.error(`[daily-pkg] ${label} 退出码 ${r.status}——中止`); process.exit(1); }
}
const pack = spawnSync(process.execPath, [join(repo, 'scripts', 'pack-desktop.mjs')], { stdio: 'inherit', cwd: repo });
if (pack.status !== 0) { console.error('[daily-pkg] pack-desktop 退出码 ${pack.status}——中止'); process.exit(1); }
if (!existsSync(join(staging, 'electron.exe'))) { console.error('[daily-pkg] pack-desktop 产物缺失'); process.exit(1); }

mkdirSync(join(out), { recursive: true });
cpSync(staging, join(out, 'ZhongshuoDual'), { recursive: true });

// 1) 日常启动器（ASCII only）：无 seed、无 fake、无演练防护；工程直通仅 ZS_DEV25_DEBUG_PORT（CDP，验证用）。
const BAT = ['@echo off',
  'rem Zhongshuo DAILY desktop launcher (ASCII only - codepage safe). No seed, no fake runtime.',
  'setlocal EnableDelayedExpansion',
  'set PKG=%~dp0',
  'set APP_DIR=%PKG%server-data',
  'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
  'rem Clean parent-environment ZS_* overrides: this package owns its runtime.',
  'rem Engineering pass-through (verification only, documented): ZS_DEV25_DEBUG_PORT (CDP).',
  'for /f "delims== tokens=1" %%V in (\'set ZS_ 2^>nul\') do (',
  '  if /i not "%%V"=="ZS_DEV25_DEBUG_PORT" set "%%V="',
  ')',
  'rem Pipe name is generated once per data root (package copies never collide).',
  'if not exist "%APP_DIR%\\pipe-name.txt" (',
  '  set PIPE_TAG=%RANDOM%%RANDOM%%RANDOM%',
  '  >"%APP_DIR%\\pipe-name.txt" echo zs-daily-!PIPE_TAG!',
  ')',
  'set /p PIPE_SHORT=<"%APP_DIR%\\pipe-name.txt"',
  'set PIPE_NAME=\\\\.\\pipe\\!PIPE_SHORT!',
  'set ZS_APP_DATA=%APP_DIR%',
  'rem Daily runtime: member bindings take priority (configured per member in the app).',
  'rem Global default = claude channel; no fake, no dispatch guard, no demo bootstrap.',
  'set ZS_RUNTIME=claude',
  'set ZS_PIPE_NAME=!PIPE_NAME!',
  'echo Starting Zhongshuo (daily desktop - real runtime config, no demo data)...',
  'if not "%ZS_DEV25_DEBUG_PORT%"=="" (',
  '  start "ZhongshuoDaily" "%PKG%ZhongshuoDual\\electron.exe" --remote-debugging-port=%ZS_DEV25_DEBUG_PORT%',
  ') else (',
  '  start "ZhongshuoDaily" "%PKG%ZhongshuoDual\\electron.exe"',
  ')',
  'echo.',
  'echo Data root: %APP_DIR%   (shown in Settings - Data & draft storage)',
  'echo First run: open your own project folder from the welcome screen.',
  'echo Keep this console open. Closing the app window exits the app.',
  'pause',
  'endlocal'].join('\r\n');
writeFileSync(join(out, 'start-desktop.bat'), BAT + '\r\n', 'utf8');

// 2) README-DAILY
writeFileSync(join(out, 'README-DAILY.md'), `# 众说·日常桌面版 v1

**这是给你日常使用的正式入口**——不是演练包：启动**不会**创建 Guide 演练会话或模拟回复，
也不会自动调用任何模型；真实模型调用只在你主动发送消息给已配置的成员时发生。

## 首次使用（三步，约 3 分钟）

1. **双击 \`start-desktop.bat\`** → 首次出现欢迎页 → 点「打开项目文件夹」选择你自己的项目
   目录（任意本地文件夹；Git 仓库可直接看到历史/差异）。
2. **配置成员 runtime**：左侧「成员」→ 对每个 Agent 成员点「配置 runtime」→ 选渠道
   （claude/codex）→ claude 需填模型名（如你在 CLI 里用的模型）→ 保存。保存后列表会显示
   绑定与能力状态（**配置成功≠能力已认证**——认证状态以实际使用为准，界面如实分列）。
   发送时若成员未绑定，输入区会就地提示并给出直达入口。
3. **验证保存**：在房间输入框选「仅记录，不请求回复」→ 输入一句话 → 发送 → 关闭窗口再
   重开 → 这条记录仍在（同时你的草稿、未确认发送也会跨重开保留）。

## 数据在哪里

所有数据（项目/消息/任务/附件/凭据）都在 \`<本包目录>\\server-data\\\`（设置页
「数据与草稿存储」可随时查看完整路径）。这个数据根与任何演练包互不影响；升级/换包时
**保留整个文件夹**即可延续你的数据。草稿快照普通正文保留 24 小时；「结果未知」的发送
账本不受该时限清理。

## 常见情况（如实）

- **claude CLI 不在 PATH / 找不到可执行文件**：绑定表单里「可执行文件」填完整路径；
  派发失败会显示真实原因，不会静默换用模拟。
- **发送后显示「结果未知」**：可能是服务已收到但回执丢失——点「重发原内容」（同一命令号，
  不会重复）；换新内容发送前请先处理该提示。
- **Git 历史/差异/停止任务/验收/返工/附件/搜索/导出**：都在新界面直接可用；少数未换装
  操作（Git 写操作、远程访问变更等）有直达原界面按钮。

工程验证与日常运行的边界：本包的启动/配置/仅记录/草稿/重开路径已由工程在独立副本验证
（零真实模型调用）；真实模型派发沿用既有认证边界，仅由你主动触发。
`.replaceAll('\n', '\r\n'), 'utf8');

// 3) 清单核对（同 h1 口径：与 pack-desktop MANIFEST 一致性）
const manifestPath = join(out, 'ZhongshuoDual', 'MANIFEST-SHA256.json');
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
let checked = 0; let missing = 0;
for (const entry of (manifest.files ?? [])) {
  const rel = entry.path; const expected = entry.sha256;
  const p = join(out, 'ZhongshuoDual', rel);
  if (!existsSync(p)) { missing += 1; continue; }
  const actual = createHash('sha256').update(await (await import('node:fs/promises')).readFile(p)).digest('hex');
  if (actual === expected) checked += 1; else missing += 1;
}
const build = JSON.parse(await (await import('node:fs/promises')).readFile(join(out, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
console.log(`[daily-pkg] 就绪：${out}`);
console.log(`[daily-pkg] 清单核对 ${checked} 一致，不符/缺失 ${missing}；buildId=${build.buildId} commit=${build.commit} dirty=${build.dirty}`);
if (missing > 0) process.exit(1);
