# R203 成员管理 AI 卡片直达「AI 设置」

用户 2026-11-08 截图反馈：点击成员管理里的 AI 成员卡片会进入单独的「Codex 配置 / 成员详情」页（含身份与执行程序、模型与能力、返回成员管理、停用成员等），要求去掉这个中间页，点卡片默认跳转 AI 设置。

## 诊断

- 成员卡片（`MembersPage.tsx`）原来的 onClick/Enter 导航到 `/project/:id/member/:memberId`，即 `MemberDetailPage`（截图页）。
- 卡片上原本已有「AI 设置…」按钮打开 `BindRuntimeModal`（弹窗内包含名称/说明编辑与渠道/模型/执行程序/权限配置），与详情页的「AI 设置」入口是同一个组件。
- 详情页的其余功能（停用/启用、保存配置模板、返回成员管理）在成员卡片/工具栏都有；因此直接移除页面即可，无需迁移字段。

## 修复

- `MembersPage.tsx`：AI 成员卡片点击（含标题、工作量和空白区域）直接调用 `openBind(m)` 打开 AI 设置弹窗，不再导航；卡片 title 改为「打开 X 的 AI 设置」；人类成员无 AI 设置，卡片只读（保留「人类」标识），不再产生无效跳转；项目归档/移除时不打开。
- `App.tsx`：删除 `MemberDetailPage` 导入与页面；旧深链 `/project/:id/member/:memberId` 改为 `<RedirectTo to="/project/:id/members" />`；侧栏成员管理选中态只匹配 `/members`。
- 删除 `src/ui/hifi/pages/MemberDetailPage.tsx`。
- `CommandPalette.tsx`：成员条目改为进入成员管理页，不再拼接已移除的详情路由。
- 用户手册：改为「点对应成员卡片（或卡片上的 AI 设置…）直接打开 AI 设置」，重新生成 `docs/user-guide/index.html`。
- `tests/browser/memberChannelsR136.test.ts`：原来的「成员详情页打开 AI 设置」路径改为「成员卡片打开 AI 设置」，保留 Harness 渠道/模型/执行程序/权限断言，断言数 46→47。
- 新增 `tests/integration/r203MemberSettings.test.ts`：详情页文件不存在、路由重定向、卡片调用 openBind、命令面板/手册文案合同。

## 验证

- 新增 `scripts/capture-r203-ui.cjs`（隔离 Electron + 假运行时，**7/7**）：成员卡片存在且 AI 卡片 title 正确；点击卡片后 hash 仍为 `/members`、无 `data-zs-member-detail`、弹出「AI 设置 · Codex」且含名称/说明/渠道字段；旧深链重定向回成员管理。截图 `dist/r203-ui/r203-v6/01-member-card-ai-settings.png`（弹窗叠加在成员管理页上）、`02-legacy-route-redirected.png`。
- `tests/browser/memberChannelsR136.test.ts` 4/4 通过；`tests/integration/r203MemberSettings.test.ts` 4/4 通过。
- 回归：`capture-r201` 21/21、`capture-r193` 25/25、`capture-r195` 41/41、`capture-r197` 23/23；已跟踪全量测试见交付记录。
- hifi tsc 0；根 tsc 维持既有 29 条本机未跟踪夹具错误（本版 0 新增）；`build-ui`/`pack-daemon` 通过。
- 未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 版本 `0.1.3-beta.48`（numericVersion `0.1.3.48`），程序提交 `fe56893`。
- 干净 worktree `dist/r203-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `bld_cc3181c6c7cef99c`（clean、633 文件 MANIFEST）、安装器 BUILD `bld_d30809365a039de5`（安装镜像 670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.48-x64.exe` **160,451,966 字节**，SHA256 `3c8eedd748d0d4960f8c9b2155d4f5b36809970f9c3d55feeae1d57a8079f4d8`，未签名；本记录提交后推送 `main`（`6bc5a14` + `fe56893` + 记录提交）、创建 tag `v0.1.3-beta.48` 与 GitHub Release「众说 0.1.3-beta.48」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.48.md`）；用户自行安装。

## 已知边界

- 成员卡片不再承担键盘打开（card 非 focusable）；键盘用户仍可用卡片内「AI 设置…」按钮完成同一操作，按钮文案/位置不变。
- 人类成员卡片保持只读；其项目管理仍在成员管理页的筛选/房间名单与相关设置中。
- 旧 `/member/:id` 深链统一回成员管理列表，不会自动打开对应成员的 AI 设置（避免重定向后意外弹窗）；需要时可点卡片。
