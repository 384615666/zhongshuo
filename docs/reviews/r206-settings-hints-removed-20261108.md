# R206 设置页行内小字说明全部移除

用户 2026-11-08 追问：上一版只删了页头/分区说明，「浅色、深色随时切换」「默认显示个人和 AI 头像，姓名始终保留」「聊天里你自己那一侧显示这张；AI 成员头像在成员管理里设置」等设置行内小字还在。本轮把设置页所有行内说明文案一并去掉。

## 诊断

- 设置行的灰字说明由 `SettingsRow` 的 `hint` 渲染为 `.pset-row-hint`；上一版只删了 `SectionShell` 的 `sub`（`.settings-section-sub`）和页头 `.page-sub`，没有处理 `hint`。
- 部分小字来自嵌入组件：
  - `AvatarPicker` 的 `.field-hint`（PNG/JPEG/WebP、384KB 说明）；
  - `ExecutionConcurrencyPanel` 的主 hint、「三项上限」字段 hint 与执行规则说明；
  - `LocalDiagnostics` 的「只在本机读取…」说明；
  - `CallBudgetSettingsRow` 的「默认上限：单人执行…」小字。
- 状态/结果/错误（当前值、当前上限、已保存/失败、清理结果、空状态等）属于功能反馈，不是装饰性文案，保留。

## 修复

- `SettingsPage.tsx`：删除全部 `SettingsRow hint` 属性（外观、通知、AI、数据、帮助共 12 处）；`ViewerNameRow` 的 hint 一并删除；`APP_LINKS` 删除 `hint` 字段（链接 URL 不再作为小字显示）。
- `AvatarPicker`：新增 `hideHint` 属性，设置页「我的头像」传 `hideHint`，不再渲染 `.field-hint`；成员弹窗/模板仍保留该说明。
- `ExecutionConcurrencyPanel`：删除主 hint、字段 hint 和执行规则说明；保留当前上限、错误、只读提示与保存状态。
- `LocalDiagnostics`：删除「只在本机读取…」说明；按钮、状态、错误与诊断详情保留。
- `CallBudgetSettingsRow`：删除「默认上限…」可见小字；把 `data-zs-call-budget-defaults` 属性移到外层容器，数值不变（验收钩子仍可读）。
- 测试：`settingsSinglePageR157.test.ts` 增加「无行内小字」合同（15 条示例文案 + `pset-row-hint`/`field-hint` 不出现）；`callBudgetSettingsR98.test.ts` 改为断言默认上限只保留数据属性；帮助链接测试不再期待 URL 小字。

## 验证

- `scripts/capture-r205-settings-copy.cjs` 扩展为 R206 回归：1324×760 真实 UI，**28/28**：
  - `.pset-row-hint` / `.field-hint` 元素数量均为 0；
  - 页头/分区 6 条 + 行内 15 条示例文案全部不出现；
  - 五个分区标题、开关/按钮、状态仍在；
  - 数据分组无草稿、清理存储保留、归档与项目仍在。
  截图：`dist/r205-ui/r206-v1/01-settings-top-1324.png`（外观：只剩标题/开关/头像/名字输入）、`02-settings-data-1324.png`（数据：只剩标题/按钮/状态）。
- `settingsSinglePageR157.test.ts` + `callBudgetSettingsR98.test.ts` **19 项通过**；hifi tsc 0。
- 回归：`capture-r204` 41/41、`capture-r203` 7/7、`capture-r201` 21/21、`capture-r193` 25/25、`capture-r195` 41/41、`capture-r197` 23/23；已跟踪全量见交付记录。
- 未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 版本 `0.1.3-beta.51`（numericVersion `0.1.3.51`），程序提交 `1a05aea`。
- 干净 worktree `dist/r206-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `bld_bd3609c2785c7aff`（clean、633 文件 MANIFEST）、安装器 BUILD `bld_cb5bf6901591ce1c`（安装镜像 670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.51-x64.exe` **160,438,179 字节**，SHA256 `2b5d2f11eca19c0bfe0b9f750111b14b2dd66c5a18b502b2855483ace9896fc9`，未签名；本记录提交后推送 `main`（`1a05aea` + 记录提交）、创建 tag `v0.1.3-beta.51` 与 GitHub Release「众说 0.1.3-beta.51」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.51.md`）；用户自行安装。

## 已知边界

- 状态/结果/错误与输入框占位符（如「未设置时显示「你」」）保留；它们是功能反馈而非说明文案。
- 成员管理弹窗里的头像说明保留（不在设置页范围）；设置页使用 `hideHint` 关闭。
- 设置行 hint 是共享基元的能力，其它页面（项目设置等）未受影响；本版只在设置页去除。
- 若用户还想去掉输入框 placeholder、状态行或空状态文字，需要再明确范围；本轮按"设置项/分区/页头的小字说明"处理。

补充（R206 验证）：`tests/browser/helpers/executionConcurrencyR153.cjs` 的说明文案检查同步改为「面板保留可编辑控件、但不再出现执行规则说明」，R153 并发测试通过。
