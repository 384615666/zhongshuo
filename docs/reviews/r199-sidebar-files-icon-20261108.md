# R199 侧栏「文件与 Git」图标

用户 2026-11-08 发来侧栏截图问「文件和 git 的图标是不是有问题」。

## 诊断

- 侧栏「文件与 Git」此前用的是 `Icon name="diff"`：两条竖线 + 两个 2.4 半径圆环 + 一段折线的「分支/差异」示意图。
- 在 14px 侧栏尺寸、1.8 线宽下，圆环被压成小圆点、折线与竖线挤在一起，整体看起来像一段残缺笔画（用户截图即此现象）；而且它表达「差异」，与「文件与 Git」入口的「文件」语义不一致。
- 检查了渲染几何：该图标实际渲染为 14×14（未被压缩/裁切），所以是图形选择问题，不是布局 bug。

## 修复

- `src/ui/hifi/App.tsx` 侧栏「文件与 Git」改用 `file-text` 图标（与文件页「文件」页签同一图形），14px 下可清楚识别为文件；其余侧栏图标、名称基线、hover/选中态与点击导航不变。
- `diff` 图标继续用于差异/Git 相关处（Git 页「工作区差异」、文件改动卡、项目主页「文件与改动」等），语义不变。
- 未改布局、尺寸、颜色、路由或任何数据/合同。

## 验证

- `capture-r193-ui.cjs` 隔离 Electron 侧栏截图 **25/25 断言通过**（顶部导航/项目/房间/设置图标 x=32、名称列 x=53/54、选中竖条 3px 贴左缘、工作区标题固定、无行溢出）；截图 `dist/r193-ui/r193-icon-fix/02-sidebar.png`。
- 新图标 6× 放大证据：`dist/sidebar-files-icon-new.png`（文件图形完整、无残缺笔画）。
- hifi tsc 0 错；`build-ui` / `pack-daemon` 通过；干净 worktree 根 tsc 0、侧栏截图复跑、全量套件与安装包构建见交付记录。
- 未在本机安装/升级/卸载，未操作用户运行数据，未调用真实模型。

## 交付

- 版本 `0.1.3-beta.44`（numericVersion `0.1.3.44`），程序提交 `bd281eb`。
- 干净 worktree `dist/r199-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `bld_71d44b3e1c3e522e`（clean、632 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_048ed97dd1f39457`（安装镜像 668 文件 MANIFEST；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.44-x64.exe` **160,492,378 字节**，SHA256 `f3febff4b22a905b12628c3bbf9dbece952f24bce42bf4dfb71c615d25358983`，未签名；本记录提交后推送 `main`（`bd281eb` + 记录提交）、创建 tag `v0.1.3-beta.44` 与 GitHub Release「众说 0.1.3-beta.44」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.44.md`）；用户自行安装。
- 记录：本文件；用户手册无需改动。
