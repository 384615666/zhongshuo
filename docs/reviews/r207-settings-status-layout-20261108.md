# R207 设置页去状态小字 + 重新排版 + 版本名称

用户 2026-11-08 追加：`当前显示「你」`、`已开启`、`当前上限…` 也要去掉；「众说 · 本地多成员协作工作台」改为「众说 · 本地多Agent协作工作台」；并指出删掉大量文字后界面排版有问题，需要重排。

## 诊断

- 状态小字来源：
  - `ViewerNameRow` 的 `.small.faint` 状态 span（当前显示「你」）；
  - 三个 `Switch` 的可见 `label`（显示/隐藏、已开启/已关闭、开启/关闭）；
  - `ExecutionConcurrencyPanel` 的 `当前上限：…` / `读取中…` / `尚未确认当前上限`；
  - `ArchiveManager` 嵌入设置时的「共 0 个项目 · 0 个房间」和空归档筛选行/大空态。
- 排版问题来源：
  - 所有说明/状态删掉后，设置行仍沿用含 hint 时的 spacing：行高 46–53px、`align-items:flex-start`，标签与控件不垂直居中；头像行 `AvatarPicker .field` 的 margin-bottom 留空；
  - 分区 `.settings-sections { gap:18px }` 与 `.settings-section + .settings-section { margin-top:22px }` 叠加成 40px 空档；
  - 嵌入并发面板保留卡片 inline margin 14px，归档空态占 440px 高。
- 版本名称只在 `SettingsPage` 的版本 ReadOnlyRow 中。

## 修复

- 删除 `ViewerNameRow` 状态 span（data 属性仍保留）；三个开关把可见 label 换成 `visually-hidden` 文本（无障碍名称仍在）。
- `ExecutionConcurrencyPanel` 删除 `current limits`/`loading/unknown` 状态行；保留错误、只读提示、保存状态（`role=status`）。
- `ArchiveManager` 增加 `archive-manager/archive-embedded` 类与 `data-zs-archive-manager`；embedded 时隐藏计数，空归档只显示「没有归档内容」，并给筛选行加 `archive-filters-empty` 在空时折叠；独立归档页行为不变。
- 版本文案改为「众说 · 本地多Agent协作工作台」。
- `r170-settings.css` R207 重排：
  - 行 `align-items:center; min-height:46px; padding:9px 20px`；标签列纵向居中；
  - 头像/归档/诊断等 `:has(...)` 大控件行顶部对齐并去掉 AvatarPicker 底部 margin；
  - 分区头 padding 12/8，分区 margin 归零（只留 18px gap）；
  - 嵌入并发面板 `margin:0 !important`、行高 42px；归档空时折叠筛选。
- 测试同步：`settingsSinglePageR157` 增加状态小字/版本名称断言；`executionConcurrencyR153` 静态测试与 helper 去掉「读取中/当前上限/来自启动设置」依赖，改为验证真实输入值与无状态文案；`callBudgetSettingsR98` 保持默认上限数据属性合同。

## 验证

- 新增 `scripts/capture-r207-settings-layout.cjs`（1324×760，隔离数据+假运行时，**7/7**）：
  - 无「当前显示 / 已开启 / 已关闭 / 当前上限 / 读取中… / 尚未确认当前上限」；
  - 开关无可见文字标签；
  - 简单行中心偏差 ≤2px、行高 ≤80px；头像行 ≤130px；分区头 ≤52px；分区间距 ≤36px（实测 18px）；
  - 截图 `dist/r207-ui/r207-layout4/01-settings-top.png`、`02-settings-ai.png`、`03-settings-data.png`、`04-settings-help.png`。
- `settingsSinglePageR157`、`callBudgetSettingsR98`、`executionConcurrencyR153` **21 项通过**；hifi tsc 0。
- 回归：`capture-r204` 41/41、`capture-r203` 7/7、`capture-r201` 21/21、`capture-r193` 25/25、`capture-r195` 41/41、`capture-r197` 23/23；已跟踪全量见交付记录。
- 未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 版本 `0.1.3-beta.52`（numericVersion `0.1.3.52`），程序提交 `2d99ebd`。
- 干净 worktree `dist/r207-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `bld_5de1b77f4fc80ca3`（clean、633 文件 MANIFEST）、安装器 BUILD `bld_d87befbdf6c715e4`（安装镜像 670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.52-x64.exe` **160,455,507 字节**，SHA256 `e5cddf5e5854df9eede6d1a7439a19baab884fe04cf0a121036a10b9b75e8d67`，未签名；本记录提交后推送 `main`（`2d99ebd` + 记录提交）、创建 tag `v0.1.3-beta.52` 与 GitHub Release「众说 0.1.3-beta.52」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.52.md`）；用户自行安装。

## 已知边界

- 空归档提示「没有归档内容」保留（内容为空时的必要状态），不再显示计数与空筛选。
- 开关的可见文字去掉，但 `visually-hidden` 文本保留，键盘/读屏仍能识别开关用途。
- 状态数据属性（`data-zs-viewer-name-status`/`data-zs-notification-status`/`data-zs-call-budget-status`）保留，验收脚本仍可读，但不再显示为可见小字。
- 设置行 hint 仍由共享基元支持，其它页面（项目设置等）不受本版影响。
