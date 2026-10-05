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
import { cpSync, mkdirSync, existsSync, writeFileSync, copyFileSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
// 输出目录（review-r50 §3）：必须独立——默认带时间戳的新候选目录；不再固定原位覆盖 hifi-h1-win-v2。
// 显式传目录时先核「用户回填保护」：RESULTS 内存在模板之外的文件=拒绝。
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outArg = process.argv[2];
const out = outArg ? join(repo, outArg) : join(repo, 'dist', 'desktop', `hifi-h1-candidate-${stamp}`);
if (existsSync(join(out, 'RESULTS'))) {
  const userFills = readdirSync(join(out, 'RESULTS')).filter((f) => f !== 'SHORT-TEST-template.md' && f !== 'H3-TEST-template.md');
  if (userFills.length > 0) {
    console.error(`[hifi-pkg] 拒绝：目标目录 RESULTS 含用户回填（${userFills.join('、')}）——独立目录输出，不覆盖用户结果。`);
    process.exit(1);
  }
}

// 0) 构建门（review-r53 §5）：入口按 build-ui → pack-daemon → pack-desktop 顺序**自己重建**
// UI 与 daemon 并核对退出码——pack-desktop 只验产物存在，证明不了它来自当前源码（R52 曾因此
// 夹带缺 thread.get 的旧 daemon）。任一步非零即中止，绝不拷旧产物。
for (const [label, script] of [['build:ui（渲染层+主进程壳）', 'build-ui.mjs'], ['pack-daemon（正式命令打包）', 'pack-daemon.mjs']]) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { stdio: 'inherit', cwd: repo });
  if (r.status !== 0) { console.error(`[hifi-pkg] ${label} 退出码 ${r.status}——中止（产物必须来自当前源码）`); process.exit(1); }
}

// 1) 便携产物（含 BUILD.json/MANIFEST——真实 commit/dirty 身份）
const pack = spawnSync(process.execPath, [join(repo, 'scripts', 'pack-desktop.mjs')], { stdio: 'inherit', cwd: repo });
if (pack.status !== 0) { console.error(`[hifi-pkg] pack-desktop 退出码 ${pack.status}——中止（不拷旧产物）`); process.exit(1); }
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
copyFileSync(join(repo, 'scripts', 'dev25-dual', '回归幻灯.pptx'), join(out, 'seed', '回归幻灯.pptx')); // 房间样本附件（入库源——不依赖旧 v6 交付目录）
copyFileSync(join(repo, 'scripts', 'h1-self-check.cjs'), join(out, 'seed', 'h1-self-check.cjs')); // 真正的 H1 清单自检（旧远程导出脚本不随包）
// 旧构建残留清理（review-r50 §3）：旧远程导出 self-check.cjs 一度随包（bat 曾误指它——
// 实测 usage+exit 1）。新候选不携带；对显式复用的目录也先移除该残留。
const staleSelfCheck = join(out, 'seed', 'self-check.cjs');
if (existsSync(staleSelfCheck)) { rmSync(staleSelfCheck, { force: true }); console.log('[hifi-pkg] 已移除旧残留 seed/self-check.cjs'); }
mkdirSync(join(out, 'samples'), { recursive: true });
// H2 预览样本随包（第五十二轮 §6.5）：六类样本供一次性集中手测（📎 上传→预览）。
for (const f of readdirSync(join(repo, 'scripts', 'dev25-dual', 'samples'))) {
  copyFileSync(join(repo, 'scripts', 'dev25-dual', 'samples', f), join(out, 'samples', f));
}
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
  'echo NEXT: the app window opens the new UI (threads/attachments/preview). One focused test per README-H2.md.',
  'echo Mechanical self-check: run run-self-check.bat (optional).',
  'echo Keep this console open. Closing the app window exits the app.',
  'pause',
  'endlocal'].join('\r\n');
writeFileSync(join(out, 'start-server.bat'), BAT + '\r\n', 'utf8');

const SELFCHECK = ['@echo off',
  'rem H1 mechanical self-check (ASCII only): shipped files + full manifest verify.',
  'setlocal',
  'set PKG=%~dp0',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%seed\\h1-self-check.cjs" --pkg "%PKG%"',
  'exit /b %errorlevel%',
  'endlocal'].join('\r\n');
writeFileSync(join(out, 'run-self-check.bat'), SELFCHECK + '\r\n', 'utf8');

// 3) README-H1（准确 H1 口径）
const writeIfAbsent = (file, content) => { const p2 = join(out, file); if (!existsSync(p2)) writeFileSync(p2, content, 'utf8'); };
writeIfAbsent('README-H2.md', `# 众说 H2 候选（新界面·回复串+附件+共享预览·可短测）

**这是什么**：原型风格新界面的 H2 修正候选（v2：修复 PPT 视觉预览宿主、移除附件后的真实
引用、发送/重试成功后的附件清算）。在 H1（侧栏/房间/私信/消息/输入）之上新增**回复串**
（主池卡片→线程→详情/停止/验收/复制定位链接）、**附件上传**（文本/图片/PDF/Word/PPT/CSV——
格式实际限幅：文本 256KB、图片 8MB、PDF/Office 20MiB、CSV 5MB）、**共享预览**（六格式只读
预览：来源/版本/hash/视觉与模型输入分列）、**图片能力门显式二选一**与**表格注入范围**。
数据与命令全部走正式链（fake 运行时+真实派发硬防护——**零真实模型调用**）。尚未换装的能力
（设置/看板/Files/Git/成果列表等）经侧栏或线程详情的「原界面」入口**定向**打开。
## 启动
1. 双击 \`start-server.bat\`（等 "Seeded." 与应用窗口；重复启动幂等）。
   - 首启约 1 分钟内自动进入「DEV25 双机验收」项目（新侧栏出现房间与私信）。
2. 集中手测**仅一次**、约 10–15 分钟：按 \`RESULTS/SHORT-TEST-template.md\` 的 7 项走，结果写回同目录（样本文件在包内 \`samples/\`）。

## 短测项（详见模板；结论可填 PASS / FAIL / BLOCKED / NOT_RUN）
- T1 首启自动进入项目：约 1 分钟内新侧栏出现「默认房间 / Lab Room」与「私信」。
- T2 回复串（**真实前置**）：干净种子里主池的 PPT 附件串是**记录串**（卡上标「记录 · 无任务
  号」），不是任务卡。先在「默认房间」输入一句任务（如「整理 README 要点」）→ 点「@」选
  **Guide A** →「发送」→ 稍候主池出现**新任务卡** → 点开 → 「详情」看到任务概况；在回复串
  输入框发一条跟进（**不会另建任务**）。
- T3 附件+共享预览（**先在输入框输入一句正文**——仅选附件不发任何东西）：点 📎 选
  \`samples/preview-r52-样例.pptx\` → 芯片显示 v1 → 点芯片「预览」→ 右侧面板：上方提取文字
  卡片 + 下方「🖼 视觉页预览」**真实幻灯片**（◀/▶ 可翻页）→「关闭」。（.docx/.pdf 同法。）
- T4 图片能力门（**先输入一句正文**）：📎 选 \`samples/preview-r52-样例.png\` →「发送」→
  出现**图片能力门**选择条 →「仅发送文字（图片不送模型）」→ 发送成功（消息带图片附件）。
- T5 表格注入范围（**先输入一句正文**）：📎 选 \`samples/preview-r52-样例.csv\` → 芯片「预览」
  → 表格下方输入 \`CSV!A1:B2\`（该 CSV 样式的工作表名就叫 **CSV**）→「设为注入范围」→ 关闭
  预览 → ⋯ 菜单选「仅记录，不请求回复」→「保存记录」→ 消息上屏且带 csv 附件（范围随消息
  冻结提交——服务端校验边界；只看「已设」提示不算完成）。
- T6 定位链接：线程「详情」→ 点「**复制定位链接**」→ 粘贴到记事本核对格式 \`#task=task_…\`
  （**实体 ID**——不是详情页的 #N 房间任务序号）。**桌面端没有地址栏**：跳转核验已由工程
  验证完成；用户核对复制出的链接格式即可（不需要开发者工具/SQL/Node；不适用可填 NOT_RUN）。
- T7 定向接管：侧栏点「任务看板」等未换装入口 → 原界面定位对应面板 → 「⌂ 返回新界面」。
## 边界（如实）
- 权限/计划档位等未接通能力在输入区**点击前禁用并说明**，需使用时经「原界面」。
- 预览为只读：视觉尽力还原（图表几何与 Office 有已知近似）；OCR 未实现；模型输入=提取文本
  （图片需显式选择「仅发送文字」——程序不冒充模型已读）。
- 已移除的附件资源不再随任何后续消息发送（上传仍会产生会话附件文件——如实保留，但零消息
  链接）；发送/重试成功后，已发附件自动从草稿剥离，等待期新增的附件保留。
- \`--no-hifi\` 命令行参数为旧界面对照（工程验证用），正常使用不需要。
- 机械自检（可选）：双击 \`run-self-check.bat\`。
- 构建/清单身份：\`ZhongshuoDual/BUILD.json\`（真实 commit+dirty 记录）与
  \`MANIFEST-SHA256.json\`（全文件 SHA-256）；打包入口先重建 UI/daemon（退出码门）。

## 保留
- 旧包（v1 工程候选、v2—v6 双机验收包、hifi-h2-win-v1）与其数据/结果原地保留；本包独立目录、独立数据根。
`.replaceAll('\n', '\r\n'), 'utf8');

// 3b) README-H3（第五十四轮 H3 候选口径：窗口外壳+五页归位——与 H2 模板分列）
writeIfAbsent('README-H3.md', `# 众说 H3 候选（新界面·窗口外壳+五页归位·可短测）

**这是什么**：H3 候选 = H2 全部能力 + 无边框自绘标题栏（拖动/最小化/最大化还原/关闭走既有
优雅停机链；--no-hifi 保留原生框）+ 五页归位（看板/文件与 Git/成员管理/待我处理/设置——正式
命令接线）+ 定位链接闭环（详情「复制定位链接」↔ 设置「打开定位」）。
H2 七项（见 hifi-h2-win-v2 的 README）如已测过不必重测；本包短测项（H1–H6：标题栏/看板/
文件与 Git/成员/待我处理/设置——含保存回读与打开定位）见 RESULTS/H3-TEST-template.md。
边界（如实）：Git 写操作在原界面仓库区（直达按钮）；runtime 绑定在原界面项目设置；看板/
Files/待我处理为只读聚合；零真实模型调用。旧包原地保留；本包独立目录、独立数据根。
`.replaceAll('\n', '\r\n'), 'utf8');
writeIfAbsent(join('RESULTS', 'H3-TEST-template.md'), `# H3 候选短测结果（用户回填——本文件不会被程序覆盖）

- 日期/参与人：
- 包目录/buildId（ZhongshuoDual/BUILD.json）：

| # | 项 | 结论（PASS/FAIL/BLOCKED/NOT_RUN） | 一句话说明 |
|---|---|---|---|
| H1 | 标题栏：拖动/双击最大化/最小化/关闭=优雅停机 | | |
| H2 | 看板：范围切换+卡片→线程详情 | | |
| H3 | 文件与 Git：项目文件快照预览+Git 状态+原界面直达 | | |
| H4 | 成员：停用⇄启用；协调者拒绝如实 | | |
| H5 | 待我处理：定位与确认执行分离 | | |
| H6 | 设置：保存回读一致+打开定位 | | |

异常与备注：
`.replaceAll('\n', '\r\n'), 'utf8');

// 4) 结果模板（不覆盖用户结果）
writeIfAbsent(join('RESULTS', 'SHORT-TEST-template.md'), `# H2 候选短测结果（用户回填——本文件不会被程序覆盖）

- 日期/参与人：
- 包目录/buildId（ZhongshuoDual/BUILD.json）：

| # | 项 | 结论（PASS/FAIL/BLOCKED/NOT_RUN） | 一句话说明 |
|---|---|---|---|
| T1 | 首启自动进入项目：新侧栏出现房间（默认房间/Lab Room）与私信 | | |
| T2 | 回复串（先 @Guide A 发一条任务→新任务卡）：详情/概况；跟进不另建任务；记录串默认仅记录 | | |
| T3 | 附件+共享预览（先输入正文）：📎 pptx 样本→v1 芯片→预览（文字卡片+真实幻灯片可翻页）→关闭 | | |
| T4 | 图片能力门（先输入正文）：png 发送→显式选择「仅发送文字」→消息带附件成功 | | |
| T5 | 表格注入范围（先输入正文）：csv 预览→输入 CSV!A1:B2→设范围→仅记录发送→消息带 csv 附件 | | |
| T6 | 定位链接：详情→「复制定位链接」→粘贴核对 #task=task_…（实体 ID；桌面无地址栏，跳转已工程验证） | | |
| T7 | 定向接管：未换装入口进原界面落点正确；「⌂ 返回新界面」正常 | | |

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
