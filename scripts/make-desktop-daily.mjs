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
import { packageUserGuide } from './package-user-guide.mjs';

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
  'rem Engineering pass-through (verification only, documented): ZS_DEV25_DEBUG_PORT (CDP),',
  'rem ZS_PICK_FOLDER / ZS_PICK_FOLDER_FILE (dir-picker), ZS_SAVEAS_AUTO_DIR (isolated save verification),',
  'rem ZS_TEST_DISPLAY / ZS_TEST_WINDOW_BOUNDS / ZS_TEST_PLACEMENT_FILE (non-primary visible evidence).',
  'for /f "delims== tokens=1" %%V in (\'set ZS_ 2^>nul\') do (',
  '  if /i not "%%V"=="ZS_DEV25_DEBUG_PORT" if /i not "%%V"=="ZS_PICK_FOLDER" if /i not "%%V"=="ZS_PICK_FOLDER_FILE" if /i not "%%V"=="ZS_DATA_PICK_FILE" if /i not "%%V"=="ZS_SAVEAS_AUTO_DIR" if /i not "%%V"=="ZS_TEST_DISPLAY" if /i not "%%V"=="ZS_TEST_WINDOW_BOUNDS" if /i not "%%V"=="ZS_TEST_PLACEMENT_FILE" if /i not "%%V"=="ZS_R78_ENGINEERING_TOKEN" if /i not "%%V"=="ZS_DAEMON_ENTRY" set "%%V="',
  ')',
  'rem R78 explicit engineering entry: own isolated root, nonce marker, debug port, no bundled fixture.',
  'if not "!ZS_R78_ENGINEERING_TOKEN!"=="" (',
  '  if "!ZS_DEV25_DEBUG_PORT!"=="" exit 9',
  "  powershell.exe -NoProfile -NonInteractive -Command \"$ErrorActionPreference='Stop'; try { $root=[IO.Path]::GetFullPath($env:APP_DIR).TrimEnd([char]92); $entry=[IO.Path]::GetFullPath($env:ZS_DAEMON_ENTRY); $m=Get-Content -LiteralPath (Join-Path $root 'engineering-r78.json') -Raw | ConvertFrom-Json; if ($m.token -cne $env:ZS_R78_ENGINEERING_TOKEN -or [IO.Path]::GetFullPath($m.appDataDir).TrimEnd([char]92) -ine $root -or [IO.Path]::GetFullPath($m.daemonEntry) -ine $entry -or -not $entry.StartsWith(($root+[char]92+'engineering'+[char]92),[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { exit 9 }; exit 0 } catch { exit 9 }\"",
  '  if errorlevel 1 (',
  '    echo Engineering root identity mismatch. Startup refused.',
  '    exit 9',
  '  )',
  '  set ZS_APP_MODE=fake-sim',
  ') else (',
  '  set "ZS_DAEMON_ENTRY="',
  ')',
  'rem Pipe name is generated once per data root (package copies never collide).',
  'if not exist "%APP_DIR%\\pipe-name.txt" (',
  '  set "PIPE_TAG="',
  '  for /f %%G in (\'powershell.exe -NoProfile -NonInteractive -Command "[guid]::NewGuid().ToString()"\') do set "PIPE_TAG=%%G"',
  '  if not defined PIPE_TAG (',
  '    echo Failed to generate independent pipe identity.',
  '    exit /b 1',
  '  )',
  '  >"%APP_DIR%\\pipe-name.txt" echo zs-daily-!PIPE_TAG!',
  ')',
  'set /p PIPE_SHORT=<"%APP_DIR%\\pipe-name.txt"',
  'set PIPE_NAME=\\\\.\\pipe\\!PIPE_SHORT!',
  'set ZS_APP_DATA=%APP_DIR%',
  'rem Daily runtime: member bindings take priority (configured per member in the app).',
  'rem Global default = claude channel; no fake, no dispatch guard, no demo bootstrap.',
  'set ZS_RUNTIME=claude',
  'set ZS_PIPE_NAME=!PIPE_NAME!',
  'if not "%ZS_DEV25_DEBUG_PORT%"=="" (',
  '  start "ZhongshuoDaily" "%PKG%ZhongshuoDual\\electron.exe" --remote-debugging-port=%ZS_DEV25_DEBUG_PORT%',
  ') else (',
  '  start "ZhongshuoDaily" "%PKG%ZhongshuoDual\\electron.exe"',
  ')',
  'endlocal',
  'exit /b 0'].join('\r\n');
writeFileSync(join(out, 'start-desktop.bat'), BAT + '\r\n', 'utf8');
writeFileSync(join(out, 'start-desktop.vbs'), [
  'Option Explicit',
  'Dim shell, fso, root',
  'Set shell = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'root = fso.GetParentFolderName(WScript.ScriptFullName)',
  'shell.CurrentDirectory = root',
  'shell.Run "cmd.exe /c """ & root & "\\start-desktop.bat""", 0, False',
  '',
].join('\r\n'), 'utf8');
if(outArg?.startsWith('desktop-daily-win-v21'))writeFileSync(join(out,'README-CANDIDATE.md'),`# Windows 桌面首版候选 · v21

启动入口：start-desktop.bat。本包独立数据根，旧包、旧库、凭据、草稿与未知账本保持原地；没有演示数据或默认 Fake。

项目默认只读。在项目设置明确授权目录，并为所选成员保存项目文件编辑档后，才能派发写入。目前实际验证范围为现有 Claude/glm-5.3-flash、已登记原生 CLI 2.1.283 与 restricted 文件工具策略；程序、模型、有效渠道或策略不匹配会保持未认证。Codex 项目沙箱协议已映射，真实文件写入尚未认证。

仅允许项目内文件创建/编辑；Shell、网络工具、委派、并行写入未开放。模板不复制项目授权。尚在运行、UNKNOWN 或退出未确认时，请先明确停止并确认退出，再撤销授权。重连/重开不自动发送或重放；未知结果只由用户人工原号原参处理。

成果文档、真实文件、返工与验收分别绑定自己的版本。文件入口打开最新已确认读取快照；磁盘更新仍需明确重新加载。图片与既有阅读器保留，文件写入证据不代表新的看图认证。

文件与 Git 的改动集来自正式权限过滤列表（最近最多100项），可逐文件读取hash核验的修改前/后快照。只读展示不会撤销、暂存或派发；内容超出读取预算或不是UTF-8文本时明确显示原因，不冒充空差异。

Android、安装器、签名、自动更新与既有延期不包含在首版候选范围。最终验收证据与真实调用记录见源码仓库 R82 交付报告；工程通过不代记用户验收。
`,'utf8');

// 2) README-DAILY（v6：区分「首次从 v3/v4 升级（旧根无身份标记→设置页确认导入）」与
//    「已有新逻辑身份的数据整根移动（自动继承）」两条路径——R68 真实旧版继承收口）
writeFileSync(join(out, 'README-DAILY.md'), `# 众说·日常桌面版 ${outArg ?? 'desktop-daily-win-v1'}

## R81 成员管理与配置模板（2026-10-13）

成员名称与说明使用正式 project/member/version 合同编辑；同名按稳定短 ID 区分，旧身份、任务、会话与正文不重建。
成员页按名称、说明与短 ID 查找，启用、配置和实际工作量分列。明确选定成员保存白名单配置模板，在明确项目中创建独立成员。
模板为创建时快照；编辑或停用只影响后续创建，已有成员不自动同步。不复制凭据、认证结论、私有正文、会话、任务或未知账本。
程序不可用仍可保存，实际可用性与认证须回读；Codex 明确绑定的程序不再被全局程序替代，执行仍固定只读/审批 never，未开放权限映射。
创建已成功而回读失败时只重试读取；未知结果的原信封耐久保留，重连/重开不自动执行，可人工同号同参重放。
本批工程真实模型调用 0；Codex 真实识图认证不重试，图片用户验收继承。
schema 新增49，001–048冻结。用户旧根/旧包不自动迁移：仅对完整独立副本验证升级、匹配迁移前备份及真实旧程序拒绝高版本。
要沿用旧数据，请按下方整根复制协议由你决定；不要让 v19 打开已升级的49库。回退到匹配备份只恢复升级前事实，不包含随后在v20新增的成员/模板，程序不自动合并或对账。
本批只需一次约5分钟增量确认：改名一个已配置成员 → 从配置保存模板 → 在测试项目创建新成员 → 核原成员不变 → 关窗重开确认。无需调用模型、制造竞态或重测图片。

## 历史 R78 桌面工作流（2026-10-12）

任务、运行与交付分别呈现；详情通过正式只读接口显示实际执行成员、进展、成果版本、验收和返工。
本轮工程验证零新增真实模型调用。日常入口仍使用用户实际配置，不附带演示数据或默认 fake。
成员卡可进入单成员详情，修改运行程序/模型并回读实际认证状态；未接入的系统动作说明真实限制。
主池、看板、活动与任务详情保持同一实体，读取失败保留已确认事实并显示原因。
历史工作流结果继承，本批不安排用户重复这些确认或图片长清单。
工程验证专用直通：只有显式 ZS_R78_ENGINEERING_TOKEN、调试端口和本副本 server-data/engineering-r78.json 的 nonce / appDataDir / daemonEntry 完全匹配，且外部入口在该独立根 engineering/ 下时才允许 ZS_DAEMON_ENTRY；缺少或错配拒绝启动。正常启动清除此变量。工程 helper 不随包。

## R77 图片认证配置与诊断（2026-10-11）

成员页与图片发送区分别显示配置、适配器协议回放、真实识图认证及实际模型 ID / 渠道来源。
Claude deepseek-flash / plan 仅在 CLI 字节、有效渠道与 R76 证据匹配时开放图片输入。
自定义配置目录会按实际读取；项目渠道覆盖、托管或动态来源无法核实时明确保持未认证。
Codex gpt-6-luna 已在本机模型列表找到，R76 失败发生在上游响应等待阶段；仍未认证，不自动追加真实调用。
预览与仅记录始终独立可用。R77 无需用户制造配置错配或重复历史验收。

## R76 附件与图片（2026-10-11）

- 房间主池首次打开即可显示根消息附件；主池与线程刷新使用同一附件事实，空列表与读取失败分开。
- 本地图片阅读：适应窗口、原尺寸、连续缩放、拖动、复位、放大/Esc、另存原件；解码失败就地显示原因与重试，原件保留。
- 只有图片也能发送；「仅记录」只保存，不调用模型。已认证的 Claude/deepseek-flash 组合实际传递图片字节；认证绑定 CLI/适配器/渠道，其他组合保持明确提示。
- Codex/gpt-6-luna 的一次真实图片认证超时，未认证；可仅记录、移除图片继续，或改选可用成员后发送。
- 数据库迁移 001–048 未修改；旧包、旧数据、草稿、未知发送账本保留；无自动发送、对账或解除保护。

R76 图片发送与预览已获用户确认，本轮继承该结果，不重复历史手测清单。

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

## 数据在哪里 / 如何带到当前版本（两条路径，按你的情况选）

所有数据（项目/消息/任务/附件/凭据/草稿/未确认发送账本）都在 \`<本包目录>\\server-data\\\`。
**升级前先完整备份**：关闭旧包后把旧包整个 \`server-data\` 文件夹**复制**一份留底
（运行期间不复制；不要只备份单个 .sqlite 文件——附件 blobstore、凭据、profile、账本
必须与库同源一致）。

### 情况 A：第一次从 v3 / v4 升级（你的旧数据根还没有身份标记）

1. 把旧包的整个 \`server-data\` 文件夹复制到当前包目录同名位置（新包无用户数据时；
   旧包目录本身保持原样不动）。
2. 双击当前包的 \`start-desktop.bat\`——有待执行迁移时生成迁移前一致性备份
   \`server-data\\backups\\state-pre-vNN-*.sqlite\`）。
3. 旧版草稿/未确认发送**不会自动并入**（v3/v4 的数据根没有身份标记，程序无法自动确认
   两个目录确属同一数据根——这是防止混入无关数据的安全设计）。到
   **设置 → 数据与存储 → 旧数据目录继承**：会列出发现的旧目录候选，核对路径后点
   **「确认导入」**——草稿与未确认发送账本随即恢复（未确认横幅原样出现，仍由你决定
   重发/放弃——不会自动发送）；导入后旧键原样保留，可重复核对。
4. 工程已在真实 v3/v4 包生成的旧状态上端到端验证：同目录升级自动继承、整根复制后
   确认导入、未知信封原命令号完整恢复、同号重试业务恰一次。

### 情况 B：已有逻辑身份的数据根整体移动/复制

直接复制整个 \`server-data\` 到新包目录即可——\`server-data\\root-identity.json\`
（身份标记）随目录走，首次启动自动按同一逻辑根恢复草稿与未确认发送（无需手动导入）。

### 回退方式（如需）

回到**升级前的完整数据根备份** + 旧包程序；不要用旧程序直接打开已迁移的数据
（会被版本门拒绝），也不要只替换单个 SQLite 文件。回退即回到升级前时点。

## 常见情况（如实）

- **claude CLI 不在 PATH / 找不到可执行文件**：绑定表单里「可执行文件」填完整路径；
  派发失败会显示真实原因，不会静默换用模拟。
- **发送后显示「结果未知」**：可能是服务已收到但回执丢失——点「重发原内容」（同一命令号，
  不会重复）；换新内容发送前请先处理该提示。
- **文件树打开的文件磁盘上被外部修改**：预览工具行会出现「磁盘已更新 · 重新加载」，
  保存被拦截——点重新加载拿到新快照后再保存（不会静默把新字节当旧版本存出）。
- **Git 历史/差异/停止任务/验收/返工/附件/搜索/导出**：都在新界面直接可用；少数未换装
  操作有直达原界面按钮；Git 写操作和连接设备设置在新界面有正式入口。

工程验证与日常运行的边界：本包的启动/配置/仅记录/草稿/真实旧版继承（v3/v4 端到端）/
文件阅读与原件保存/交付文档/恢复分列路径已由工程在独立副本验证（零真实模型调用）；
真实模型派发沿用既有认证边界，仅由你主动触发。

## v6 更新（R68，2026-10-06）

- **真实旧版继承**：首次从 v3/v4 升级现在完整保留草稿与未确认发送账本——同目录升级自动
  继承；整根复制后到「设置 → 数据与存储」确认导入（旧目录无身份标记，导入由你确认——
  无关目录不混入）。同目标多个未知发送全部保留（各自同号重试）；未来版本快照整体拒收、
  身份标记损坏时原件保全不换 ID（界面给出修复指引）。
- **重发验收修真**：点「重发原内容」确属原命令号逐字重发（同参数；服务幂等恰一次），
  成功后本条账本清理、横幅消失。
- **成员边界**：归档/移除项目不能再新增成员（界面禁用+服务端同判拒绝；旧回执重放同样
  受当前状态约束）；添加成员弹窗打开后项目被切换会作废（不再写错项目）；同名成员在
  卡片/名单/@/配置入口都带 #实例短标识可辨认。
- **AI 交付文档（第三来源）**：任务成果页点「打开文档」在共享预览阅读交付正文（按
  TaskComplete 结构排版：结论/涉及文件/已执行验证/遗留问题），可切源码（原始 JSON）、
  另存为文件（字节对账）、引用进草稿（带版本+manifest 绑定）。
- **工作区文件磁盘变更提示**：外部修改后预览明确提示并拦截保存，重载后按新快照保存；
  空文件（0 字节）也能按原件另存。
- **统一下拉展开态**：全软件下拉改为自绘列表（键盘 ↑↓/Enter/Esc 可达；展开效果统一）。
- 修复：换目录后私信直达链接停在空列表的问题。

## v5 更新（R67，2026-10-06）

- 跨目录继承（逻辑数据根身份）、工作区完整阅读与原件保存、恢复检查三态分列、文件-only
  真实闭环、添加成员入口、搜索「侧栏可见项目」范围。
`.replaceAll('\n', '\r\n'), 'utf8');

// 3) 清单核对（同 h1 口径：与 pack-desktop MANIFEST 一致性）
if(outArg?.startsWith('desktop-daily-win-v22')||outArg?.startsWith('desktop-daily-win-v23')) {
  const r84=outArg.startsWith('desktop-daily-win-v23'),version=r84?'v23':'v22',round=r84?'R84':'R83';
  if(r84)cpSync(join(repo,'docs','desktop-quickstart.md'),join(out,'开始使用.md'));
  writeFileSync(join(out,'README-CANDIDATE.md'),`# Windows 桌面体验候选 · ${version}

从 start-desktop.bat 启动。新任务的执行成员默认使用 CLI 原生完整权限，可以读写整个电脑并执行命令；保留显式 plan 只读和项目编辑模式。旧任务、旧草稿及已经明确保存的限制不自动升级。实际成员权限在配置与发送区显示。

图片默认输入实际字节，不需要手选识图资格；渠道明确不支持或请求失败时如实提示。保存与本地预览独立可用，上传成功不等于真实模型理解成功。

思考等级从本机 Claude CLI / Codex model/list 读取，保存到成员、模板及运行快照并传入正式参数。第三方渠道未回报有效强度时，只报告请求值，不伪造认证。

普通对话显示可读回答；在同一回复串默认由原执行成员结合前文继续回答，明确“仅记录”才只保存。根消息、附件、作者与时间保留。原始成果协议在成果与运行证据中查看。自然交流不创建虚假的工作交付；实质工作仍保留返工、版本绑定验收。

结果未知仍由用户人工同号同参处理；重连、重开不会自动派发或解除保护。single_writer 与改动集只覆盖受管理项目，不能保护或捕获整台电脑的全部修改。

工程使用独立目录、合成输入与真实渠道验收；详见仓库 ${round} 交付记录。用户验收与工程通过分开记录。Android、安装器、签名、自动更新及既有延期未扩展。
`,'utf8');
  const daily=join(out,'README-DAILY.md');
  if(r84){const guide=await (await import('node:fs/promises')).readFile(join(repo,'docs','desktop-quickstart.md'),'utf8');writeFileSync(daily,guide,'utf8');}
  else {
  const previous=await (await import('node:fs/promises')).readFile(daily,'utf8');
  writeFileSync(daily,`# ${round} 当前行为（2026-10-14）\r\n\r\n权限、图片与思考等级以 README-CANDIDATE.md 为准；下列历轮记录保留为历史，旧的图片认证限制已被本轮自动输入替代。\r\n\r\n${previous}`,'utf8');
  }
}
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
if(outArg?.startsWith('desktop-daily-win-v24')){
  const {writeR85ReleaseGuides}=await import('./lib/r85-release-guides.mjs');
  writeR85ReleaseGuides(out);
}
if(outArg?.startsWith('desktop-daily-win-v25')){
  const {writeR86ReleaseGuides}=await import('./lib/r86-release-guides.mjs');
  writeR86ReleaseGuides(out);
}
if(outArg?.startsWith('desktop-daily-win-v26')){
  writeFileSync(join(out,'README-CANDIDATE.md'),`# 众说 R87 Windows 日常候选

从 \`start-desktop.bat\` 启动。这个包使用自己的数据目录，不读取或改写旧包的数据、账号、草稿和附件。

首次使用：打开一个本地文件夹 → 在成员页点“添加 AI” → 选择已检测到的渠道和模型 → 在默认房间里直接说话。添加 AI 后，房间和回复串的成员名单会立即刷新。

数据与恢复：设置 → 数据与存储。可以“备份全部数据”，也可以“选择已有数据”。程序会先正常关闭，随后复制完整数据目录并逐个核对文件，完成后再自动重开。原目录不会被移动、覆盖或删除；切换位置前也会保留当前副本。备份包含本地对话、附件和账号资料，请妥善保管。

成果：完成回复附近可以打开或保存实际文件；需要修改时点“按这些意见修改”；确认无误后点“确认完成”。聊天导出与保存成果文件是两个不同动作。

恢复：普通界面先显示“发送结果待确认”“上次任务中断”等可读状态和下一步；工程级的详细判定在“查看详情”里。程序不会自动重发未知结果，也不会自动解除文件保护。

本候选完成 R87 的真实 Windows UI、Claude \`deepseek-flash\` 与 Codex \`gpt-6-luna\` 合成报告协作、普通追问、修改、验收、保存原件和正常关闭重开验证。模型是否可用仍取决于你本机的渠道、账号、程序路径和权限配置。Android、安装器、签名、自动更新和并行写入增强不在本轮范围。
`,'utf8');
  writeFileSync(join(out,'README-DAILY.md'),`# 众说 R87

双击 \`start-desktop.bat\` 即可使用。

- 打开文件夹后，在成员页添加 AI；模型清单来自本机已有渠道。
- 房间里直接发送消息，@ 用来选择收件人。
- 在“设置 → 数据与存储”中备份全部数据或使用已有数据。
- 在成果与附件中打开、预览、保存实际文件。
- 关闭后重新打开，会保留项目、对话、成员、成果和接受状态。

需要帮助时，先查看界面的“待我处理”或“恢复检查”；详细信息可以展开查看，不会自动替你做有风险的决定。
`,'utf8');
}
if(outArg?.startsWith('desktop-daily-win-v26-r88')){
  writeFileSync(join(out,'README-CANDIDATE.md'),`# 众说 R88 Windows 日常候选

双击 \`start-desktop.vbs\` 启动，测试台窗口和后台进程不会保留控制台。

打开本地文件夹后，程序会读取本机当前 Claude / Codex 默认配置，并为新项目准备可修改的 Claude、Codex 成员；已有人工成员、任务和设置不会被覆盖。若本机配置无法核实，程序只保留原占位成员并在诊断中说明，不伪造模型或权限。

聊天默认按阅读顺序呈现：你的消息在右，AI 消息在左；复制、引用、收藏直接可见。正文支持 Markdown、宽表格、代码块、安全流程图和有界柱状图，复杂源码保持为不可执行文本。

头像默认隐藏但姓名保留。设置 → 外观可显示头像，并为“我”和当前项目 AI 上传/恢复 PNG、JPEG、WebP 图片；图片随数据根保存。

工程可见复核固定在非主屏，主窗、重开与数据进度窗在显示前定位；若目标屏不可用会明确失败，不会静默回到主屏。所有可见证据来自同 BUILD 的隔离测试副本，不使用用户项目或凭据。
`,'utf8');
  writeFileSync(join(out,'README-DAILY.md'),`# 众说 R88

双击 \`start-desktop.vbs\`。

- 新项目优先使用本机真实 Claude / Codex 默认模型；已有成员不自动改名或重绑。
- 直接打开房间或回复串阅读；宽表格和代码只在消息内滚动。
- 设置 → 外观管理头像开关和个人/AI 头像。
- 设置 → 数据与存储可备份全部数据或使用已有数据。
- 结果未知、权限变化和恢复动作仍需你明确处理，程序不会自动重发或替你授权。
`,'utf8');
}
if(outArg?.startsWith('desktop-daily-win-v26-r89')){
  writeFileSync(join(out,'README-CANDIDATE.md'),`# 众说 R89 Windows 日常候选

双击 \`start-desktop.vbs\` 启动。

输入框直接输入 \`@\` 即可选择 AI 或工作区文档；工具条 @ 默认从正文开头插入。可同时选择多位成员，发送后的原消息仍保留可辨别的正文 @。文档引用会先形成带 hash/版本的真实托管快照，再随消息交给被点名 AI。

房间明确 @ 一位或多位 AI 时，所有被点名成员都会实际收到并分别回复；@全体只冻结发送时的房间可用成员。串内 @全体只作用于该串当前参与者。无 @ 时仍由房间协调者接单。

Codex/GLM 等运行时返回自然正文并附带内部 TaskComplete 时，程序会先按本 turn resultKey 验证控制对象，再只展示有来源的自然正文；原始运行结果保留在详情中。非法或身份不匹配仍如实失败。

头像、默认成员、数据迁移、旧私信和用户修改过的成员身份沿用 R88 的保全边界。旧包、旧数据根、草稿和 UNKNOWN 保持不动。
`,'utf8');
  writeFileSync(join(out,'README-DAILY.md'),`# 众说 R89

双击 \`start-desktop.vbs\`。

- 输入 \`@\` 选择成员或工作区文档；可连续选择多位 AI。
- 明确 @ 的成员各自回复；无 @ 由房间协调者处理。
- 串内 @全体只包括当前串参与者。
- 设置 → 外观管理头像；设置 → 数据与存储备份或使用已有数据。
- 结果未知、权限变化和恢复动作仍需你明确处理。
`,'utf8');
}
packageUserGuide(out);
console.log(`[daily-pkg] 就绪：${out}`);
console.log(`[daily-pkg] 清单核对 ${checked} 一致，不符/缺失 ${missing}；buildId=${build.buildId} commit=${build.commit} dirty=${build.dirty}`);
if (missing > 0) process.exit(1);
