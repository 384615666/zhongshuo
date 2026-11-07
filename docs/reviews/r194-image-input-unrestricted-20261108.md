# R194 图片输入限制移除：所有 AI 成员直接接收图片（2026-11-08）

## 用户要求

2026-11-08，用户发来输入区截图，要求去掉图片相关的全部限制：

- 输入框上方提示条：「部分 AI 暂不能接收图片，可换成员或移除图片。」
- 发送时弹层：「当前所选 AI 尚不能确认接收图片：<成员名>」以及「仅发送文字，图片不送模型 / 移除图片继续 / 换可用成员 / 取消」。

用户原话：「去掉所有 ai 可能不能看图片的限制，现在所有的 ai 都能看图，把这些图片有关的限制都去掉」。

本轮确认的产品口径：图片按普通附件直接随消息发送；所有 AI 成员（Claude、Codex、Pi、DeepSeek Harness）都能收到图片；不再要求历史识图认证证据，也不再提供「仅发送文字（图片不送模型）」「换成员」「移除图片继续」等绕行选择。仅记录（`record_only`）保留，语义仍是「只保存消息与原件、不派发」，与图片能力无关。

## 实现

### daemon 与合同层：删除图片能力门

- `src/daemon/imageCapability.ts`：`memberImageCapability()` 恒返回 `status:'supported'`，reason「图片随消息直接发送给模型；不再区分运行时、模型或渠道」；删除 R76 认证 JSON 的读取与 `claudeImageIdentity` / `claudeCertificationMismatches` / `ImageCapabilityReadContext`；`src/adapter/image-certification-r76.json` 已删除（`src`/`tests`/`scripts` 均无引用，历史证据保留在 Git 历史）。
- `src/daemon/commands.ts`：删除 `assertImageGate()` 及其 3 个调用点（线程串、私信、房间根消息派发路由），一并删除「已选仅发送文字但没有文字」的 `EMPTY_MODEL_INPUT` 分支；`attachMessageRefs` 一律 `'include'`（`record_only` 仍 `'local-only'`）；`message.submit` 的 `imageAck` 保留为可选字段并完全忽略（兼容已持久化的旧信封，代码内已注明「图片能力门已取消」）；`message.imageCapability` 恒 `supported:true`；本地诊断投影改为 `channel:null`、`source:'随消息直接发送'`、`certification:'not-required'`，不再按认证状态推导。
- `src/daemon/turnInput.ts`：删除 `allowImages` 参数与 `IMAGE_INPUT_UNVERIFIED` 分支；`image_mode==='include'` 必读原件字节；历史上持久化的 `omit` 也按 include 发送（旧「仅发送文字」选择失效）；只有 `local-only`（仅记录）仍注入「图片未发送」说明。
- `src/daemon/dispatchWorker.ts`：删除组装期/启动前的图片能力与运行时绑定校验（原 `imageCapabilityAtAssembly` / `imageCapabilityAtLaunch` 与 identityKey 比对），DELIBERATE 研讨段的图片身份校验同样删除；不再向 `TurnRequest` 传 `allowImages` / `imageConfigurationKey`。
- `src/contracts/runtime.ts`：删除 `TurnRequest.imageConfigurationKey`。
- `src/daemon/runtimeOptions.ts`：`imageInput` 各分支统一 `'automatic'`（原先 Codex 按 `inputModalities` 判定、外部运行时与无 CLI 分支为 `unsupported`）。
- `src/daemon/remoteClient.ts`：删除 `IMAGE_INPUT_UNVERIFIED` 的人话映射。
- `src/daemon/attachments.ts`：更新图片能力注释（不再是「未认证/只注入文本」）。
- `src/daemon/commands.ts`（`attachment.previewImage`）：返回的 `modelInput` 由 `'depends-on-target-member'` 改为 `'sent-with-message'`，对应测试断言同步。
- 历史注释清理：`src/daemon/commands.ts` 的 `resolveAttachmentRefs` 头注释改为「图片随消息直接发送给模型，无能力门」；`src/daemon/turnInput.ts` 根消息可空注释去掉旧门描述。

### 四个运行时都真实携带图片

- Claude（`src/adapter/claude/cliAdapter.ts`）：原本已按图片字节协议传图，本轮只删除启动身份与 `imageConfigurationKey` 的匹配校验。
- Codex（`src/adapter/codex/appServerAdapter.ts`）：原本已传图，删除身份校验，以及「模型 `inputModalities` 不含 image 就拒发」的拦截。
- Pi（`src/adapter/pi/adapter.ts`）：原先遇到图片直接抛「Pi 图片输入尚未认证」；改为在 `prompt` 帧携带 `images:[{type:'image',data:<base64>,mimeType}]`（Pi 1.4.0 rpc 支持该字段），字节沿用 `src/adapter/imageInput.ts` 的 hash/mime 校验。
- DeepSeek Harness（`src/adapter/deepseekHarness/adapter.ts`）：原先同样抛「尚未认证」；改为 `execute` 帧携带 `images:[{data,mediaType}]`，仅在 `full` 模式带图，`planning` / `format-repair` 协议只接受文字，保持纯文本，与连接组件既有实现一致。

### 界面：提示条与二选一弹层删除

- `src/ui/hifi/components/Composer.tsx`：删除 `imageStatus` 状态与 `message.imageCapability` 轮询、提示条（`data-zs-image-status`）、`imageGate` 弹层与「仅发送文字，图片不送模型 / 移除图片继续 / 换可用成员 / 取消」按钮、发送前的图片预检与 `imageCheckingKeys` 锁、`submit(imageAck)` 参数与 `omit-images` 分支；保留发送防重锁与其他无关门。
- 信封与发送链：`src/ui/hifi/loader.ts` 的 `buildRoomRootEnvelope` / `buildDmEnvelope` / `buildThreadEnvelope` 删除 `imageAck` 选项，`attachmentRefsFromDraft` 去掉 `intent` 参数与 `hasImages` 返回值；`pages/Room.tsx`、`RoomPage.tsx`、`DmPage.tsx`、`ThreadPage.tsx` 删除 `imageAck` 透传。
- `src/ui/hifi/pages/MemberDetailPage.tsx`：「图片输入」一行恒显示「自动传递图片」。
- `src/ui/hifi/components/LocalDiagnostics.tsx`：图片能力恒显示「可用（直接发送）」，不再按状态映射「可用 / 不可用 / 未能确认」。
- 旧渲染器 `src/ui/renderer/app.js`（`?nohifi=1` 或 hifi 加载失败时的回退界面）：删除 `imageAckPending`、`draftHasImage()` / `showImageGate()`、DM 与主输入区两处发送前门禁、「仅发送文字，不发送图片」按钮，图片预览提示改为「图片会随消息直接发送给 AI」；`src/ui/renderer/index.html` 删除随之无用的死元素 `#dm-gate`（DM 图片门容器）。

### 测试

- 改动：19 个既有测试文件按新行为改写，另新增 `tests/integration/imageUnrestrictedR194.test.ts`（daemon×fake worker 端到端合同：DM/房间根引用图片无需 `imageAck` 直接成功、消息附图 `include`、装配层 `TurnRequest.images` 携带真实图片字节、图片-only 可发、线程跟进带图、`record_only` 记 `local-only` 且后续轮不产生图片字节、`message.imageCapability` 恒 `supported:true`）；删除 3 条只测已删除机制的用例（`imageInputR76` 启动前图片能力/身份复检 2 条、`imageConfigurationR77` R76 证书 1 条），其余均为断言改写，未用删测试掩盖行为变化。
- 结果（测试任务执行，Lead 汇总，2026-11-08）：18 个改动/新增测试文件 **18 passed / 143 tests passed**；相关附件/图片/Office/提交/hifi 集成批量 17 文件 **92 passed**；相关单测+其余集成 20 文件 **255 passed | 8 skipped**；浏览器 R152 **1 file passed（89 checks，0 failed）**。
- 全量 `node node_modules/vitest/vitest.mjs run`：388 文件 **379 passed / 7 failed**；3643 tests **3584 passed / 25 failed / 18 expected fail / 16 skipped**。25 条失败全部为既有且与图片无关：20 条来自本机**未跟踪** WIP 混沌套件（单跑同样失败），5 条为 `coordinationManifestR154` 并行超时 4 条 + `docxWordValidation` 的 Word COM 被 WPS 劫持 1 条（两者单跑均通过）。删除的 3 条用例单列，不算作通过。

## 与历史文档的关系

- R76（附件/图片修复与识图认证）、R77（图片身份 v16）、R82（v21 权限与识图认证分列）、R83（自动识图）以及 `docs/implementation/r76-*`、`r77-*`、`r82-*`、`r83-*` 中的「未认证 / 仅发送文字 / 仅记录 / 换成员」记录都是当时的历史事实，原文保留，**不再作为当前限制依据**。
- `docs/implementation/continuation.md` 中 §6.3 `imageAck` 二选一、图片能力门（`IMAGE_INPUT_UNVERIFIED`）、R84 诊断投影等历史断点同样保留原文。
- 本轮起现行口径：所有 AI 成员随消息直接接收图片。用户手册同步更新（见下），施工总账 [implementation-status](../implementation/implementation-status.md) 已追加 R194 条目。

## 用户手册同步

`docs/user-guide/README.md`，以及由 `scripts/package-user-guide.mjs` 从 README 重新生成的 `docs/user-guide/index.html`：

- 第 3 节「使用 DeepSeek Harness 或 Pi」原文「只读、项目受限编辑和图片暂未开放」改为「只读、项目受限编辑暂未开放」——这两个渠道的图片限制已不存在。
- 第 9 节「把资料交给 AI」补一句：图片也按同样方式直接附带发送，所有 AI 成员都能收到图片，图片内容随消息一起交给 AI，不需要在发送前更换成员或另行选择接收方式。
- 首行「更新于」日期由 2026-11-06 改为 2026-11-08（沿用手册的更新日期约定）。手册其余出现「图片」的地方（头像上传、文件预览、截图看图说明）与图片能力无关，未改。

## 验证范围与未验证边界

本轮做过的验证（2026-11-08，本机，提交前完成）：

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.hifi.json`：**0 错**。
- 根 `node node_modules/typescript/bin/tsc --noEmit`：干净 HEAD worktree **0 错**；当前工作区 **29 项**全部来自本机**未跟踪**的 R130/R180 夹具与被其拉入的 `src/ui/hifi/lib/localOpen.ts`（22+7），与本轮改动前逐行一致、**0 新增**（改动中一度出现的 `imageConfigurationR77` 对已删除导出的引用错误已随测试改写消失）。不是「根 typecheck 全绿」，也不是本轮引入。
- `node scripts/build-ui.mjs`：通过（exit 0，仅既有 `import.meta` CJS 警告）。
- 自动化测试：见上节「测试」——18 个改动/新增文件 143 项通过、相关集成 17 文件 92 项通过、相关单测+其余集成 20 文件 255 项通过/8 跳过、浏览器 R152 89 checks 通过；全量 388 文件 379 通过 / 7 失败，25 条失败全为既有且与图片无关。
- 静态检索：`src` 内 `IMAGE_INPUT_UNVERIFIED`、「暂不能接收图片」、「不能确认接收图片」、`imageGate`/`imageStatus`/「仅发送文字」/`omit-images` 均已无命中；仅剩 `message.submit` 被忽略的兼容字段 `imageAck`（`src/daemon/commands.ts:365`）与 `src/daemon/turnInput.ts:29` 一句解释旧选择失效的注释。`src/adapter/image-certification-r76.json` 已删除、无引用。

明确**没有**做的验证：

- **没有调用真实 Claude / Codex / Pi / DeepSeek Harness 模型验证识图结果**。「所有 AI 都能看图」是产品口径与代码路径打通，不等于真实模型识图已通过。
- 没有在本机安装/升级/卸载，也没有在安装版界面核对提示条消失；安装包已构建并随本轮交付（见「交付」），未覆盖用户已安装的 beta.38 与运行数据。
- 没有使用真实用户项目数据或用户原截图做验收；界面提示条/弹层消失由源码删除、自动化测试与静态检查确认。
- 没有运行 e2e 真实运行时套件。
- Pi / DeepSeek Harness 的图片帧按各自公开 rpc / execute 结构实现，未在真实账号端到端确认模型确实读取了图片字节。

## 交付

- 版本：`0.1.3-beta.39`（`package.json`、`packaging/windows/release.json`，numericVersion `0.1.3.39`）。
- 程序提交 `9beee03`（`fix: send images to every AI member without capability gate (R194)`），共 48 文件：src 24 项（含删除 `src/adapter/image-certification-r76.json`）、tests 20 项（19 个既有文件改写 + 新增 `tests/integration/imageUnrestrictedR194.test.ts`）、`docs/user-guide/README.md` 与 `index.html`（手册图片说明）、`package.json` 与 `packaging/windows/release.json`。仓库内他人未提交的侧栏改动（`App.tsx`、`Icon.tsx`、`base.css` 等）未纳入本次提交，也未进安装包。
- 干净 worktree `dist/r194-source`（`9beee03`，status 0，node_modules junction）构建，`dirty=false`：
  - 便携镜像 BUILD `bld_8a4993c49e6146d5`（clean；632 文件 MANIFEST 独立逐项 SHA256 复核 632/632 全过）；
  - 安装器 BUILD `bld_1cea3992ad51eb5c`；安装镜像 668 文件 MANIFEST 独立逐项 SHA256 复核 668/668 全过；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`；Inno 编译 `Successful compile (58.562 sec)`。
- 安装包：`dist/installers/Zhongshuo-Setup-0.1.3-beta.39-x64.exe`，**160,208,876 字节**，SHA256 `346d22b0e9f997b1fbbe7544d3155008d8f3acb217d25f6de0c8aa19d3df650f`，未签名（NotSigned）；附 `.sha256` 与 `.release.json`。PE 文件版本与 ProductVersion 均为 `0.1.3-beta.39`；`installed-desktop.json` 为 `0.1.3-beta.39` / `0.1.3.39`；native icon 7 帧校验通过；RunAsNode fuse 关闭。
- 包内核对（脚本 / 逐字读取）：`resources/app/dist/ui/renderer/hifi/app.mjs` 与 `renderer/app.js` 中「暂不能接收图片 / 不能确认接收图片 / 图片不送模型 / 换可用成员 / 仅发送文字」**全部无命中**；`resources/app/daemon/daemon.cjs` 中 `IMAGE_INPUT_UNVERIFIED`、`assertImageGate`、`allowImages`、`image-certification-r76` **均无**；包内 `操作手册/README.md` 与 `众说操作手册.html` 均含新句「图片也按同样方式直接附带发送……」，且仍为旧「打开/切换项目」措辞（他人侧栏改动未进包）。
- Git（本记录提交后立即执行）：推送 `main`（程序提交 `9beee03` + 本记录提交）；在程序提交上创建 tag `v0.1.3-beta.39`；创建 GitHub Release「众说 0.1.3-beta.39」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.39.md`）。用户自行安装；本机未安装/升级/卸载，未覆盖用户已装 beta.38 与运行数据，未调用真实模型识图。

## 涉及文件

源码（已随本轮提交 `9beee03`；`App.tsx`、`Icon.tsx`、`base.css`、`LibraryPage.tsx`、`MembersPage.tsx`、`TasksBoard.tsx`、`pages-misc.tsx` 与 `scripts/capture-r193-ui.cjs` 的改动属同仓库其他未提交工作，未纳入本次提交，不属本轮）：

- daemon 与合同：`src/daemon/imageCapability.ts`、`src/daemon/commands.ts`、`src/daemon/turnInput.ts`、`src/daemon/dispatchWorker.ts`、`src/daemon/runtimeOptions.ts`、`src/daemon/remoteClient.ts`、`src/daemon/attachments.ts`、`src/contracts/runtime.ts`；删除 `src/adapter/image-certification-r76.json`（R76 认证证据，Git 历史保留）
- 适配器：`src/adapter/claude/cliAdapter.ts`、`src/adapter/codex/appServerAdapter.ts`、`src/adapter/pi/adapter.ts`、`src/adapter/deepseekHarness/adapter.ts`
- 界面：`src/ui/hifi/components/Composer.tsx`、`src/ui/hifi/components/LocalDiagnostics.tsx`、`src/ui/hifi/loader.ts`、`src/ui/hifi/pages/MemberDetailPage.tsx`、`src/ui/hifi/pages/Room.tsx`、`src/ui/hifi/RoomPage.tsx`、`src/ui/hifi/DmPage.tsx`、`src/ui/hifi/ThreadPage.tsx`、`src/ui/hifi/data/store.ts`（注释）、`src/ui/renderer/app.js`、`src/ui/renderer/index.html`
- 测试：19 个既有文件改写——`tests/integration` 的 `imageAttachments`、`officeAttachments`、`imageInputR76`、`imageConfigurationR77`、`rootAttachmentsR76`、`fileOnlySubmit`、`diagnosticImageEvidenceR84`、`hifiUploadDeepLinkRound52`、`hifiThreadRound51`、`hifiSettlementRound53`、`memberRuntimeBatchR78`、`memberManagementR81`、`runtimeDaemonR136`、`deepseekHarnessR136`；`tests/unit` 的 `runtimeDaemonR136`、`frontendFilesR120`；`tests/browser` 的 `r152UiFeedback` 用例与助手；`tests/fixtures/externalRuntimeR136.mjs`。另新增 `tests/integration/imageUnrestrictedR194.test.ts`。
- 文档（本任务与交付）：`docs/user-guide/README.md`、`docs/user-guide/index.html`、`docs/reviews/r194-image-input-unrestricted-20261108.md`、`docs/releases/0.1.3-beta.39.md`、`docs/implementation/continuation.md`、`docs/implementation/implementation-status.md`
- 版本与安装包：`package.json`、`packaging/windows/release.json`（版本 `0.1.3-beta.39` / `0.1.3.39`）；`dist/installers/Zhongshuo-Setup-0.1.3-beta.39-x64.exe`（未入库）
