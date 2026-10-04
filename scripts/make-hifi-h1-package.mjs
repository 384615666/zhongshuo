/**
 * H1 首包打包脚本（第四十九轮，入库——review-r48 §2：启动器依赖完整、可重复构建）。
 *
 * 产物：dist/desktop/hifi-h1-win-v2/（独立目录；旧 v1 候选保留为未完成工程候选不动）：
 *  - ZhongshuoDual/：pack-desktop 便携产物（默认启动 hifi 换装壳；--no-hifi 为旧界面对照）；
 *  - seed/seed-client.cjs：正式命令种子（幂等；经 daemon 管道，不直写库）；
 *  - start-server.bat：唯一用户入口——清父环境 ZS_* 覆盖项（保留两个工程直通用变量并注明）、
 *    独立数据根+按数据根持久管道名、fake+真实派发硬防护、种子失败非零退出；
 *  - run-self-check.bat + self-check.cjs：机械自检（文件/清单存在性）；
 *  - README-H1.md + RESULTS/SHORT-TEST-template.md：H1 短测说明与结果模板（不覆盖用户结果）；
 *  - samples/：R7 Word 样本（经原界面预览用）。
 * 逐件文件清单核对：与 pack-desktop MANIFEST-SHA256.json 一致性由 self-check 抽验+全量核对脚本负责。
 */
import { cpSync, mkdirSync, existsSync, writeFileSync, copyFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
const out = join(repo, 'dist', 'desktop', 'hifi-h1-win-v2');

// 1) 便携产物（含 BUILD.json/MANIFEST——真实 commit/dirty 身份）
spawnSync(process.execPath, [join(repo, 'scripts', 'pack-desktop.mjs')], { stdio: 'inherit', cwd: repo });
if (!existsSync(join(staging, 'electron.exe'))) { console.error('[hifi-pkg] pack-desktop 产物缺失'); process.exit(1); }

mkdirSync(out, { recursive: true });
// 幂等重建：先清旧产物目录（残留 electron 锁定时报错退出——先提示杀进程）。
try { cpSync(staging, join(out, 'ZhongshuoDual'), { recursive: true }); }
catch (e) {
  console.error('[hifi-pkg] 拷贝失败（可能有上次运行的 electron 锁定文件）：' + e.message);
  console.error('[hifi-pkg] 请结束 electron.exe 后重跑。');
  process.exit(1);
}
mkdirSync(join(out, 'seed'), { recursive: true });
copyFileSync(join(repo, 'scripts', 'dev25-dual', 'seed-client.cjs'), join(out, 'seed', 'seed-client.cjs'));
copyFileSync(join(repo, 'dist', 'desktop', 'dev25-dual-win-v6', 'seed', '回归幻灯.pptx'), join(out, 'seed', '回归幻灯.pptx')); // 房间样本附件（源=v6 包内种子件——只读拷贝；seed 按同目录查找，缺件会静默跳过导致主池空）
copyFileSync(join(repo, 'scripts', 'dev25-dual', 'self-check.cjs'), join(out, 'seed', 'self-check.cjs'));
mkdirSync(join(out, 'samples'), { recursive: true });
copyFileSync(join(repo, 'scripts', 'dev25-dual', 'samples', 'word-r7-sample.docx'), join(out, 'samples', 'word-r7-sample.docx'));
mkdirSync(join(out, 'RESULTS'), { recursive: true });

// 2) 启动器（ASCII only——代码页安全；父环境 ZS_* 清理；种子失败非零退出）
const BAT = ['@echo off',
  'rem H1 first-package launcher (ASCII only - codepage safe)',
  'setlocal EnableDelayedExpansion',
  'set PKG=%~dp0',
  'set APP_DIR=%PKG%server-data',
  'set DEMO_DIR=%PKG%demo-project',
  'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
  'rem Clean parent-environment ZS overrides (review-r48 #2): the package owns its runtime.',
  'rem Engineering pass-throughs (verification only, documented): ZS_DEV25_DEBUG_PORT (CDP),',
  'rem ZS_H1_LOSE_SUBMIT_ONCE (controlled lost-ack for envelope-retry verification).',
  'for /f "delims== tokens=1" %%V in (\'set ZS_ 2^>nul\') do (',
  '  if /i not "%%V"=="ZS_DEV25_DEBUG_PORT" if /i not "%%V"=="ZS_H1_LOSE_SUBMIT_ONCE" set "%%V="',
  ')',
  'rem Pipe name is generated once per data root (two package copies never collide).',
  'if not exist "%APP_DIR%\\pipe-name.txt" (',
  '  set PIPE_TAG=%RANDOM%%RANDOM%%RANDOM%',
  '  >"%APP_DIR%\\pipe-name.txt" echo zs-hifi-!PIPE_TAG!',
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
  'echo Starting Zhongshuo H1 (default new UI, fake runtime + real-dispatch guard, zero real model calls)...',
  'if not "%ZS_DEV25_DEBUG_PORT%"=="" (',
  '  start "ZhongshuoDual" "%PKG%ZhongshuoDual\\electron.exe" --remote-debugging-port=%ZS_DEV25_DEBUG_PORT%',
  ') else (',
  '  start "ZhongshuoDual" "%PKG%ZhongshuoDual\\electron.exe"',
  ')',
  'echo Seeding demo project via formal commands (retries until daemon ready; idempotent)...',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%seed\\seed-client.cjs" --appdata "%APP_DIR%" --pipe "!PIPE_NAME!" --demo "%DEMO_DIR%" --regression',
  'if errorlevel 1 (',
  '  echo SEED FAILED - see messages above. Close the app window and retry.',
  '  exit /b 1',
  ') else (echo Seeded. RESULTS\\seed.json written.)',
  'echo.',
  'echo NEXT: the app window opens the new (prototype-style) UI. Short test ~5-10 min per README-H1.md.',
  'echo Mechanical self-check: run run-self-check.bat (optional).',
  'echo Keep this console open. Closing the app window exits the app.',
  'pause',
  'endlocal'].join('\r\n');
writeFileSync(join(out, 'start-server.bat'), BAT + '\r\n', 'utf8');

const SELFCHECK = ['@echo off',
  'rem Mechanical self-check (ASCII only): shipped files + manifest spot check.',
  'setlocal',
  'set PKG=%~dp0',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%seed\\self-check.cjs" --pkg "%PKG%"',
  'exit /b %errorlevel%',
  'endlocal'].join('\r\n');
writeFileSync(join(out, 'run-self-check.bat'), SELFCHECK + '\r\n', 'utf8');

// 3) README-H1（准确 H1 口径）
writeFileSync(join(out, 'README-H1.md'), `# 众说 H1 首包（新界面·可短测）

**这是什么**：原型风格新界面接入正式客户端的首个可运行包（H1）。默认启动即新界面
（侧栏/房间/私信/消息/输入区），数据与命令全部走正式链（fake 运行时+真实派发硬防护——
**零真实模型调用**）。尚未换装的能力（线程/预览/设置/看板/Files/Git/附件/停止/验收等）
经侧栏或房间/私信头部的「原界面」入口**定向**打开，不丢失落点。

## 启动
1. 双击 \`start-server.bat\`（等 "Seeded." 与应用窗口；重复启动幂等）。
   - 首启约 1 分钟内自动进入「DEV25 双机验收」项目（新侧栏出现房间与私信）。
2. 短测约 5–10 分钟：按 \`RESULTS/SHORT-TEST-template.md\` 的 5 项走，结果写回同目录。

## 短测项（详见模板）
T1 首启自动进入项目+侧栏真实房间/私信；T2 房间发送（指定成员/@全体）与仅记录；
T3 私信发送与成员回复出现；T4 发送失败/未知时的草稿保留与「重发原内容」；
T5 「原界面」定向接管与返回（样式互不污染）。

## 边界（如实）
- 附件上传、权限/计划档位等未接通能力在输入区**点击前禁用并说明**，需使用时经「原界面」。
- \`--no-hifi\` 命令行参数为旧界面对照（工程验证用），正常使用不需要。
- 机械自检（可选）：双击 \`run-self-check.bat\`。
- 构建/清单身份：\`ZhongshuoDual/BUILD.json\`（真实 commit+dirty 记录）与
  \`MANIFEST-SHA256.json\`（全文件 SHA-256）。

## 保留
- 旧包（v1 工程候选、v2—v6 双机验收包）与其数据/结果原地保留；本包独立目录、独立数据根。
`.replaceAll('\n', '\r\n'), 'utf8');

// 4) 结果模板（不覆盖用户结果）
writeFileSync(join(out, 'RESULTS', 'SHORT-TEST-template.md'), `# H1 首包短测结果（用户回填——本文件不会被程序覆盖）

- 日期/参与人：
- 包目录/buildId（ZhongshuoDual/BUILD.json）：

| # | 项 | 结论（PASS/FAIL） | 一句话说明 |
|---|---|---|---|
| T1 | 首启自动进入项目：新侧栏出现房间（默认房间/Lab Room）与私信 | | |
| T2 | 房间发送：输入→发送后消息出现在主池；「仅记录」保存且不派发 | | |
| T3 | 私信：新建/打开会话→发送→成员回复在当前视图出现 | | |
| T4 | 草稿保护：断网/失败时内容保留+行内错误；「重发原内容」可用（如未遇到可注“未触发”） | | |
| T5 | 定向接管：点「任务看板」等进入原界面且落点正确；返回新界面正常 | | |

异常与备注：
`.replaceAll('\n', '\r\n'), 'utf8');

// 5) 清单核对（交付时逐件核对 pack-desktop MANIFEST 与实际拷贝一致）
const manifest = JSON.parse(readFileSync(join(out, 'ZhongshuoDual', 'MANIFEST-SHA256.json'), 'utf8'));
let checked = 0; let bad = 0;
for (const f of manifest.files) {
  const p = join(out, 'ZhongshuoDual', f.path);
  if (!existsSync(p)) { bad += 1; console.error(`[hifi-pkg] 缺失 ${f.path}`); continue; }
  const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
  if (hash !== f.sha256 || statSync(p).size !== f.bytes) { bad += 1; console.error(`[hifi-pkg] 不符 ${f.path}`); }
  checked += 1;
}
const build = JSON.parse(readFileSync(join(out, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
console.log(`[hifi-pkg] 就绪：${out}`);
console.log(`[hifi-pkg] 清单核对 ${checked}/${manifest.files.length} 一致，不符 ${bad}；buildId=${build.buildId} commit=${build.commit.slice(0, 8)} dirty=${build.dirty}`);
if (bad > 0) process.exit(1);
