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

## 3. 发布结果（2026-11-01）

- **发布**：https://github.com/384615666/zhongshuo/releases/tag/v0.1.1 （draft=false、prerelease=false、latest=true）。tag `v0.1.1` 指向源码提交 `a9caca4b030799af800a2850c4f8894f4d146e25`，公开 main 同步该提交；资产三项已上传并核对本地/服务端 digest 一致：`Zhongshuo-Setup-0.1.1-x64.exe`（159,306,032 字节，SHA256 `ba0c0747d902cee2e9fbb8688eb1aa1519337a95909a1f7d90e1321cd08c027d`）、`.exe.sha256`、`.release.json`。未登录访问 Release/latest API 与安装包下载 302→200 正常。
- **构建身份**：从 `a9caca4` 干净 worktree（node_modules 目录联接）构建；便携源镜像 `bld_333c33bae5aab647` clean，安装镜像 BUILD `bld_0793defc369ebf44`、commit `a9caca4…`、`dirty=false`、661 文件逐项 SHA256 与隐私扫描通过、`runAsNode=false`（fuse 回读）、`dataFilesIncluded=false`。安装器 EXE 文件版本 0.1.1 / ProductVersion 0.1.1 / OriginalFilename 正确，图标回读为正式猫咪 logo；未签名（如实标 `signed:false`）。
- **payload 核对**：`resources/app/logo.png` 1,092,804B 与根图同哈希；`dist/ui/renderer/assets/logo.png` 存在；渲染器 bundle 含 `welcome-brand`、不含旧 `brand-mark`；`installed-desktop.json` version 0.1.1/numeric 0.1.1.65535、nativeIcon 7 帧 Verified；操作手册 20 张新截图与 `众说操作手册.html` 入包；`安装说明.txt` 首行为「众说 0.1.1」。
- **安装冒烟（隔离）**：真实安装器 `/VERYSILENT /DIR=<隔离目录> /TASKS=""` 装到临时目录（不覆盖用户安装），校验程序/版本/logo/图标/卸载登记/开始菜单与桌面快捷方式后静默卸载；卸载成功、隔离目录清空。**过程中一次向导截图自动化在模板夹具上误触发了模板安装（默认目录），发现后立即用原 `0.1.0-beta.3` 安装包重装恢复**：原程序 667 文件、`Zhongshuo.exe` 246,140,416 字节、注册表 `DisplayVersion=0.1.0-beta.3`/DisplayIcon/安装目录、桌面与开始菜单四个快捷方式（含图标/AppId）均已核对回原值；用户数据目录未改动（安装器无数据操作、未启动应用）。
- 用户当前运行/安装的旧版与数据未升级；安装 0.1.1 需自行正常退出旧版后运行新安装包。未做 Authenticode 签名，仍无自动更新。

## 4. 未决/后续

- `scripts/lib/wizard-images.ps1` 需要 Windows PowerShell 5.1 且脚本带 UTF-8 BOM（生成脚本已入库）；更换 logo 后重跑并重新构建安装器。
- 安装器页面截图脚本仅用于内部视觉核对，属本机 `dist/` 证据，不入库。
- 历史验证脚本（`scripts/verify-desktop-renderer.mjs` 等）仍断言旧可见文案；e2e 部分既有断言陈旧，均非产品测试范围。

## 5. 发版后支持：任务栏仍显示 Electron 原子图标（2026-11-01）

用户安装 0.1.1 后反馈任务栏图标仍是旧原子图标。排查：

- 正在运行的安装版窗口 HICON 已是正式猫咪 logo（从 HWND 直接取出 1254×1254 原图），安装 EXE 图标、开始菜单/桌面快捷方式图标也都是品牌 ICO。
- 根因：用户同时运行着 10:44 启动、窗口隐藏的旧 **V78 便携版**（`ZhongshuoDual\electron.exe`）；它与安装版都使用 `com.zhongshuo.desktop` 这个 AppUserModelID，Windows 把两者合并到同一个任务栏按钮，并按旧 Electron 进程的图标/描述显示为「Electron + 原子图标」，任务栏缓存持续沿用。
- 处理（用户确认后）：关闭旧 V78（无在途 run；3 个 ACTIVE 任务为历史空闲状态，数据保留）→ 关闭并重启安装版 0.1.1 → 重启 Explorer 刷新任务栏缓存（同时记录并重新打开原有 4 个文件资源管理器窗口）。任务栏按钮现显示正式猫咪 logo；安装版仍在运行，旧数据未改动。
- 未改代码/未再发包：该现象由本机旧开发构建与任务栏缓存导致，不是 0.1.1 安装包内容缺失。后续如需让便携版与安装版永不共用任务栏组，可在下一版本按安装形态区分 AppUserModelID，并考虑修正 EXE 版本资源中的 Electron 描述（本轮未做）。
- 证据：`dist/r150-taskbar-diagnose/taskbar-final-crop.png`（本机 ignored 证据）。

