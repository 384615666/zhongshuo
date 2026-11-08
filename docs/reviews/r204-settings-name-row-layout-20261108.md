# R204 设置页「我的名字」行排版

用户 2026-11-08 截图反馈「设置里排版有问题」：红框圈出设置 → 外观 →「我的名字」一行，输入框与「保存」按钮比其它行的控件更靠右，几乎贴到卡片右缘，下面的「当前显示「你」」也悬在边缘。

## 诊断

- 设置卡片结构：`section.card.settings-card > .settings-section-head + .settings-card-body > .pset-row`。
- `r170-settings.css` 用 `.settings-card-body > .pset-row { padding: 13px 20px; }` 给行统一横向内边距，保证各行的控件右对齐成一列。
- 「我的名字」组件（`ViewerNameRow`）外面包了一层 `<div data-zs-viewer-name>`，所以 `.pset-row` 不是 `.settings-card-body` 的直接子级，这条规则没命中；行退回 `.pset-row` 基元的 `padding: 10px 0` → 横向内边距 0，输入框/按钮顶到卡片边缘。
- 实测（1324 宽度）：名字行控件右缘 = 1219（= 卡片内容右缘），主题行控件右缘 = 1199，差 20px；行 padding-right = 0px。与用户截图一致（用户 125% 缩放下视觉约 32px 更靠右）。
- 其它包裹型设置行（通知总开关、调用预算）在 r170 CSS 里已有对应 `[data-zs-*] > .pset-row` 规则，仅「我的名字」漏掉。

## 修复

- `src/ui/hifi/styles/r170-settings.css` 增加：
  - `.settings-card-body > [data-zs-viewer-name] > .pset-row { padding: 13px 20px; }`
  - `@media (max-width: 760px)` 的窄窗规则加入同一选择器（14px）。
- 不改设置行基元、控件结构、数据逻辑与其它行样式。

## 验证

- 新增 `scripts/capture-r204-settings-ui.cjs`（隔离 Electron + 假运行时，**41/41**）：在 **1360/1324/1200/1100/1024/900/700** 七个宽度测量：
  - 控件不越出卡片内容右缘；
  - 桌面宽度下保存按钮与主题行控件右对齐（容差 1.5px）；
  - 名字行内边距 ≥20px（窄窗 ≥14px）；
  - 输入与保存按钮同一行、行无横向溢出。
  修复后 1324 实测：行 padding 20px、按钮右缘 1199、主题控件右缘 1199（修复前 1219/1199，差 20px）。截图 `dist/r204-ui/r204-final/01-settings-1324.png`、`02-viewer-name-row-1324.png`。
- 新增 `tests/integration/r204SettingsLayout.test.ts`（2 项）；hifi tsc 0；已跟踪全量见交付记录。
- 未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 版本 `0.1.3-beta.49`（numericVersion `0.1.3.49`），程序提交 PENDING_COMMIT。
- 干净 worktree `dist/r204-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `PENDING_BUILD1`（clean、PENDING_FILES1 文件 MANIFEST）、安装器 BUILD `PENDING_BUILD2`（安装镜像 PENDING_FILES2 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.49-x64.exe` **PENDING_BYTES 字节**，SHA256 `PENDING_SHA`，未签名；PENDING_PUSH。

## 已知边界

- 本次只补「我的名字」行的横向内边距；用户截图没有要求改变输入框宽度、保存按钮位置或状态行位置，保持原设计（输入+保存按钮一行，状态在右下方）。
- 其它设置行若以后新增包裹容器，需要同样在 r170-settings.css 补规则；本次扫描了当前所有包裹型设置行，通知/调用预算已有规则，没有扩大改动。
