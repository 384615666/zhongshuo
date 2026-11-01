# R149 用户反馈：正式 logo 未替换完 + 前端开发说明文字清理（2026-11-01）

## 用户原始反馈

1. 第一版（0.1.0）已上线，但正式 logo（仓库根 `logo.png`，猫咪图）还有很多地方没替换掉。
2. 界面上仍残留很多开发时的说明文字，要求全部找出并从前端剔除。

截图证据：
- 欢迎页顶部仍是旧「众」蓝底方块品牌标识（红框）。
- 任务栏/窗口图标仍是 Electron 默认原子图标（用户当前运行的 V78 旧构建没有随包 logo/图标）。
- 成员管理页：工作量时间戳+统计说明、四张成员卡的「高级状态」诊断块、可复用模板说明、房间名单说明（红框）。
- AI 设置弹窗：顶部说明、思考等级来源说明、权限模式长说明、底部「保存后显示 AI 的可用状态」（红框）。

## 范围

### A. logo 替换（Lead 负责）

正式 logo 唯一源 = 仓库根 `logo.png`（1254×1254，白底，内容区约 1079×605）。本轮把程序内所有仍显示旧图/默认图/无图的位置换成正式 logo：

1. 欢迎页品牌位：旧 CSS `.brand-mark`「众」→ `<img>` 使用随包 `logo.png`（新增 `assets/logo.png` 构建产物）。
2. 渲染页 `index.html`：补 favicon，使浏览器宿主/窗口图标来源一致。
3. `src/ui/main.ts`：窗口图标解析抽成函数，优先 `appRoot/logo.png`，回退 `dist/ui/renderer/assets/logo.png`，再回退 ICO；数据操作进度窗口也设置同一图标。
4. 数据操作页 `data-progress.html`：顶部品牌位显示 logo。
5. 安装器 `packaging/windows/zhongshuo.iss`：卸载快捷方式、操作手册快捷方式也设置正式 logo ICO（现在为空=默认 Inno/文件类型图标）。
6. `scripts/build-ui.mjs`：构建时把根 `logo.png` 复制到 `dist/ui/renderer/assets/logo.png`。
7. 旧构建/旧包（V78）任务栏默认图标属构建产物过期；源码修复后用新构建验证。不修改用户运行中的程序与数据。

不在本轮范围（AGENTS.md 约定）：公开首页 `site/` 与 README 由用户安排的其他 AI 负责。

### B. 前端开发说明文字清理（团队负责）

清理对象是“用户可见的开发/验收说明文字”，不是正常功能文案。判断标准：

**删除**（出现在 JSX/HTML 可见文本、title、subtitle、field-hint、空态说明、details 诊断块中的）：
- 实现/验收口径：`正式 app-server model/list（无模型调用）`、`按当前模型声明提供等级`、`配置成功≠能力已认证`、`保存配置不等于渠道已实测`、`当前为验收防护环境`、`历史证据/识图证书/协议/依据`、`数据根`、`快照`、`首批`、`按页显示`、`口径/边界/分离统计`、`工程`、`DEV-/R\d+/§` 等内部术语；
- 解释系统内部如何工作、如何被验证的长句（例：模板跨项目复用/分页说明、房间成员派发边界说明、权限模式政策长句、模型选项来源说明、工作量更新时间与统计口径）；
- 诊断性 details 块：成员卡「高级状态」（图片输入配置/渠道/协议/依据、项目编辑档证据等）；
- 与操作无关的元数据注脚（时间戳统计说明等），但保留真实错误事实与操作反馈；
- 只重述表单功能的副标题/页脚注（如「选择本机已有渠道和模型，保存后用于之后的工作。」「保存后显示 AI 的可用状态」）。

**保留**：
- 操作标签、值、状态、表单项标签与合法示例（`例如 实现与重构…`）、输入约束（`留空使用本机 CLI`）；
- 错误/失败/空态/禁用原因（可操作即可）、破坏性操作后果确认（归档/移除/清空）、真实数据事实（数量/路径/时间本身）；
- 安全与数据保护的必要提示（不删数据、退出会停止任务等）；
- 「诊断信息」等明确标注仅供排查的折叠区（设置页 Help 内可保留，但去掉日常页面的诊断噪音）；
- 渠道安装/配置的必要步骤说明（如 Pi/DSH 安装指引）——仅删除其中的认证/证据/能力免责说明句；
- 产品名词（渠道名、成员、房间、任务、交付等）。

**要求**：
- 只删文字，不重排布局、不改业务逻辑、不改命令/接口/权限行为。
- 不删除 `data-*` 钩子、aria-label 的可访问名称（如仅含工程术语可改写为用户语言）。
- 同一含义的多余句子一并删除，保留最短可用文案。
- 注释（`/* */`、`//`）不是用户可见内容，本轮不动（除非与可见文案一起被改）。

## 文件分工（write scopes）

- **A 成员与设置**：MembersPage.tsx、pages/MemberDetailPage.tsx、components/MemberManagementForms.tsx、RuntimeChannelHelp.tsx、RuntimeModel.tsx、RuntimeEffort.tsx、lib/runtimePermissions.ts、SettingsPage.tsx、pages/SettingsPage.tsx、pages/ProjectSettingsPage.tsx、components/ProjectWriteAccessPanel.tsx、LocalDiagnostics.tsx、SettingsRow.tsx、useMemberWorkload.ts。
- **B 房间/线程**：pages/Room.tsx、RoomPage.tsx、ThreadPage.tsx、TaskDetailsFacts.tsx、ExecutionStatus.tsx、TaskExecutionStatusView.tsx、LiveProgress.tsx、RecoveryPanel.tsx、PendingGitOperations.tsx、ExecutionWaitActions.tsx、AnalysisContinueAction.tsx、SendRecoveryAction.tsx。
- **C 私信/输入/消息组件**：DmPage.tsx、DmTaskRecords.tsx、DmInterruptedNotice.tsx、Composer.tsx、MessageView.tsx、MessageProtocol.tsx、MessageChangedFiles.tsx、FormalChanges.tsx、GeneratedFiles.tsx、CommandPalette.tsx、NavMarks.tsx、TaskNotificationController.tsx。
- **D 看板/文件/Git/项目页**：BoardPage.tsx、pages/TasksBoard.tsx、PendingPage.tsx、FilesPage.tsx、pages/GitPage.tsx、pages/GitDialogs.tsx、pages/pages-misc.tsx、LibraryPage.tsx、ArchivePage.tsx、ActivityPage.tsx。
- **E 外壳/共享/预览/旧界面**：App.tsx、components/TitleBar.tsx、components/ui.tsx、components/Icon.tsx、shell.ts、main.tsx、preview/**、renderer/index.html、renderer/app.js、renderer/data-progress.html、renderer/hifi-flag.js、loader.ts、lib/*.ts 中用户可见文案。
- **Lead**：logo 全部改动（build-ui.mjs、ProjectHome.tsx、main.ts、index.html、data-progress.html、zhongshuo.iss、brand 相关）、文档、最终构建/测试。

## 验收

1. `pnpm typecheck:hifi` 通过（全量 `pnpm typecheck` 也会跑）。
2. `pnpm lint` 无新增问题。
3. `pnpm test`（vitest）全量通过（允许既有的 Windows symlink 跳过项）。
4. 真实界面截图（隔离数据 + fake runtime）：欢迎页显示新 logo；成员页/AI 设置/设置页/房间/线程/看板/文件/Git/项目设置等页面不再出现上述开发说明；无布局破损。
5. 构建 `pnpm build:ui` 成功；便携包构建时窗口/任务栏图标使用正式 logo（新构建验证，旧 V78 包不改）。

## 结果（2026-11-01）

### 1. 正式 logo 替换（Lead）

- `scripts/build-ui.mjs`：构建时复制根 `logo.png` → `dist/ui/renderer/assets/logo.png`（已实测产出）。
- `src/ui/hifi/pages/ProjectHome.tsx` + `styles/base.css`：欢迎页旧 `.brand-mark`「众」方块 → `.welcome-brand` 正式 logo 图（132×132、保留原图比例/留白、白底圆角托底、`data-zs-welcome-logo` 标记）。
- `src/ui/renderer/index.html`：favicon 指向同一 logo；`data-progress.html` 品牌位显示 logo。
- `src/ui/main.ts`：窗口图标统一解析 `resolveWindowIconPath()`（`appRoot/logo.png` → `dist/ui/renderer/assets/logo.png` → 原生 ICO）；主窗口与数据操作进度窗口共用；`resolveDesktopIconPath()` 保留哈希 ICO。
- `packaging/windows/zhongshuo.iss`：「众说操作手册」「卸载众说」快捷方式补 `IconFilename` = 正式 logo ICO（此前为空=系统默认图标）。
- `docs/user-guide/images/*.png` 20 张界面截图用新构建重采集（`node scripts/capture-user-guide.cjs`，markers 全部命中），手册首页品牌图同步为正式 logo。
- 用户当前运行的是 V78 旧便携包（构建早于 R145 的 logo 打包改动），其 `resources/app` 没有 logo.png，所以任务栏仍是 Electron 默认图标；重新构建的包才会显示正式 logo（源码层不反向修补旧包）。旧包与用户数据未改动。

### 2. 前端开发说明文字清理（团队 A–E）

共 70 个文件（737+/831-，含测试与文档）；删除/改写的类别：

- **用户截图原句**：工作量更新时间+统计口径行、成员卡「高级状态」诊断块、可复用模板说明、房间名单说明、AI 设置弹窗副标题/页脚/思考等级来源/权限长说明、`正式 app-server model/list（无模型调用）`、`完整权限沿用 CLI…`、`保存后显示 AI 的可用状态`。
- **同类实现/验收口径**：交付校验值/manifestHash/版本身份/技术身份/运行身份/复核快照 details、调用预算公式与「在途预占/结算」口径、数据根/草稿快照/旧命名空间/逐键确认、改动集/前像/baseline 引用、git numstat/reset 说明、提交≠验收、证据/认证/协议/读数 hash 等。
- **诊断详情折叠块与内部 ID**：turnId/runId/commandId/deliveryId/changeSetId/roomId/memberId/rev/status 枚举、预算原始 JSON、附件 sha256、链接深链参数等；设置页 Help 的「诊断信息」折叠区按 rubric 保留（明确标注排查用途）。
- **分页/加载/时间戳统计说明**：首批/按页显示/每页 N 条/刷新回到首批/汇总时间/更新于等；真实数量/路径/时间事实保留。
- **旧界面（legacy 回退壳）**：`renderer/app.js`、`renderer/index.html` 侧栏 help/设置里的开发说明与内部字段同步清理；不改变回退行为。
- 顺带删除未被引用且只含「演示界面」文案的 `ProtoFlag` 组件与 `.proto-flag` 样式。

**保留**（按 rubric）：状态/错误/空态/确认/破坏性后果/输入约束与示例、真实路径数量时间、渠道安装步骤、真实能力限制提示（如「项目受限和只读模式尚未认证」）、明确标注的「诊断信息」折叠区、`data-*` 钩子与 aria-label 可访问含义、业务逻辑与命令参数。

### 3. 已知测试/文案同步

- 更新 `tests/browser/taskDetailsSummaryR79.test.ts`：预算文案由「在途预占 未提供」改为「本轮最多 N 次调用」。
- 更新 `tests/integration/dmReviewContract.test.ts`：legacy 验收失败提示由「第 3 版快照」改为「第 3 版」。
- 新增 `tests/browser/r149UiBrandingCopy.test.ts`：护栏 1=欢迎页/窗口/安装器使用正式 logo；护栏 2=扫描 hifi TSX 字面量与 JSX 文本，禁止截图原句与同类开发说明回潮（源码注释天然排除）。
- `scripts/verify-desktop-renderer.mjs` 等历史验证脚本仍有 `sha256=` 等旧断言，属工程脚本非产品测试，未在本轮改；e2e（`pnpm test:e2e`）中部分既有断言早已与当前 UI 不一致，非本轮引入。

### 4. 验证记录（2026-11-01，D:\zhongshuo-public）

- **构建**：`node scripts/build-ui.mjs` 成功；`dist/ui/renderer/assets/logo.png` 1,092,804B，SHA256 与仓库根 `logo.png` 完全一致。
- **类型**：`tsc --noEmit -p tsconfig.hifi.json` 通过；全量 `tsconfig.json` 仅余本机未跟踪 R130 测试夹具的既有类型错误（公开仓库不含这些文件，与 R148 记录一致）。
- **Lint**：对 57 个改动文件与 HEAD 逐文件比较（rule+message 集合）新增 0、减少 1；本机 `eslint .` 的大量报错来自 `src/ui/renderer/assets/**`（gitignored 构建产物，不在 eslint ignores 内）与本机未跟踪 R130 文件，非本轮引入。
- **测试**：本机 DSH 会话自带 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 验证用例被当成 Node 运行；测试前清除后执行 `node node_modules/vitest/vitest.mjs run`：**2911 通过 / 10 expected fail / 14 跳过 / 0 失败**（已跟踪测试）。唯一的 4 个失败全部来自**本机未跟踪**的 `tests/integration/chaosR130Upgrade.test.ts`（依赖 `D:\zhongshuo` 旧私有仓库的旧包 `server-data`，公开克隆中不存在，非本轮引入）。
- **真实界面**（隔离数据 + fake runtime，0 真实模型调用）：`node scripts/capture-r149-ui.cjs --run=after-cleanup-3` → **20/20 场景通过**，`failedScenes=[]`；全部 `hifiOn=true / legacyOn=false / hifiFailed=false`，无错误横幅/装载卡死/非预期对话框/横向溢出；**HARD/SOFT 禁止词均为 0**；欢迎页 logo 7/7 检查通过（src/alt/naturalWidth/渲染尺寸/旧字标消失/favicon）。截图与 result.json：`dist/r149-ui/after-cleanup-3/`。
- **界面人工目视**：欢迎页新 logo；成员页无「高级状态/工作量更新于/模板长说明/房间名单长说明」；AI 设置弹窗（默认态+展开高级）无副标题/页脚/来源/权限长说明；活动页无原始事件键与状态枚举（补了未知 kind 与状态枚举的中文兜底）；线程任务/交付、看板、文件·Git、待我处理、搜索·收藏、归档均正常。
- **操作手册**：`node scripts/capture-user-guide.cjs` 20 张截图全部重采集成功（markers 全部命中），`01-open-project` 等品牌图已换新 logo。
- **便携包**：`node scripts/make-desktop-daily.mjs desktop-daily-win-v79-r149-branding-copy-20261101` 成功（BUILD `bld_9528a0d9ab5d4a0b`，因本机其他 AI 未跟踪工作 dirty=true；628 文件清单核对 0 不符/缺失）。`ZhongshuoDual/resources/app` 含 `logo.png`、哈希 ICO、`desktop-brand.json`；`ZhongshuoDual/electron.exe` 原生图标回读为正式猫咪 logo；`packageUserGuide` 已附手册；`install-existing-data-launcher.mjs` 已把「沿用已有数据」入口指向用户 V78 当前同一数据目录（仅写入新包配置，未启动、未改用户数据）。打包应用隔离冒烟：welcome 页 `[data-zs-welcome-logo]` 真实加载（1254×1254 源图、132×132 渲染），无旧字标，hifi 正常、任务栏 EXE 图标为正式 logo。
- **未做**：安装器重编译/安装、GitHub 发布、旧 V78 包内容修改、`site/` 与 README（用户安排的其他 AI 范围）。新包位置：`D:\zhongshuo-public\dist\desktop\desktop-daily-win-v79-r149-branding-copy-20261101\start-existing-data.vbs`（需先正常退出旧版众说）。


