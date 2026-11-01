# R150 安装包美化 + 0.1.1 发版（2026-11-01）

用户要求：R149 的 logo/文案修复做成新安装包发版测试；同时「安装程序现在也很丑」，重做安装向导视觉。

## 1. 安装向导视觉重做

- **品牌图**：新增 `packaging/windows/branding/wizard-large-*.png`（164:314，202–534 七档）与 `wizard-small-*.png`（58–159 七档方形），由 `scripts/lib/wizard-images.ps1` 从根 `logo.png` + 品牌浅色渐变生成；`WizardImageFile`/`WizardSmallImageFile` 多档逗号列表由 Inno 按当前 DPI 自动选最近档，避免模糊。
- **配色/信息层级**：欢迎页左侧品牌栏 = 清透浅蓝渐变 + 白色圆角 logo 卡 + 「众说 / 本地多 Agent 协同工作台 / 本地·协作·离线 / 当前用户安装·无需管理员权限」；页眉小图 = 圆角白底猫咪 logo。
- **页面精简**：去掉默认 Inno 许可页与纯文本「安装说明」页（MIT LICENSE、安装说明仍随程序安装）；Inno 6.6+ 默认隐藏欢迎页，显式 `DisableWelcomePage=no` 恢复品牌欢迎页。
- **文案**：`[Messages]` 覆盖欢迎/准备/完成页为产品向中文（安装只写程序目录、不迁移/删除聊天数据、升级卸载保留数据）；完成页提供「打开众说」「打开操作手册」两个可选动作。
- **安装逻辑不变**：AppId、当前用户安装、目录、数据目录、单写者探测、运行中拒绝升级/卸载、静默不启动、图标、卸载入口等均未改；只是外观与页面。
- 实拍验证（`dist/r150-installer-shots/`）：欢迎页、附加任务页、准备页、完成页四页均正常，欢迎页品牌栏与文字无截断；截图脚本只浏览不点击安装。

## 2. 版本与发版

- 版本 `0.1.0` → `0.1.1`（`package.json`、`packaging/windows/release.json`；Windows 数字版本 `0.1.1.65535`，可覆盖 0.1.0/beta）。
- `releaseVersion` 的 beta 简写改为跟随 `release.json` 当前核心版本（不再硬编码 0.1.0）；`tests/unit/windowsReleaseVersionR148.test.ts` 同步为 0.1.1 基线。
- 发布说明 `docs/releases/0.1.1.md`：品牌/文案/安装向导修复，无任务与数据格式变更。
- 计划：从提交后的干净 worktree 构建 0.1.1 安装器，校验 payload/BUILD/隐私扫描，实际安装冒烟（隔离目录），推公开 main + tag `v0.1.1`，GitHub Release 上传 EXE/SHA256/release.json。

## 3. 发布结果

（构建与发布结果待补）
