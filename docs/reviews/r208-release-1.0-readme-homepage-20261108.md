# R208 1.0 发布准备：头像按钮靠右、README 与产品主页更新

用户 2026-11-08 要求：设置页「我的头像」的上传/恢复按钮靠右显示；更新 README 和产品主页，准备按 1.0 版本发布。

## 界面

- 设置页「我的头像」的「上传自定义 / 恢复默认」按钮组原来在头像行左缘，现改为右对齐：
  - `r170-settings.css` 增加 `.settings-card [data-zs-avatar-picker] > .row { justify-content: flex-end; }`；
  - 头像缩略图行与按钮行使用同一右缘，按钮组右边与控件列右边对齐（capture 实测 ≤1.5px）。
- 其它设置行、头像选择器在成员弹窗中的行为不变。

## README（根目录）

- 状态徽章 `status beta` → `status 1.0`。
- 首屏后新增「⬇ 下载众说 1.0 Windows 安装包」入口，链接到 GitHub Release `v1.0.0` 的 `Zhongshuo-Setup-1.0.0-x64.exe`，并链接版本/SHA256 页面。
- 新增「下载安装」小节：Windows 10/11 x64、当前用户安装、未签名/SmartScreen 提示、源码构建备选。
- 「快速开始」明确「直接下载安装包最快」，保留源码构建步骤。
- 页脚改为「1.0 正式版」。

## 产品主页（`site/index.html`、`site/README.md`）

- 首屏 eyebrow 增加「1.0 正式版」；主按钮改为「下载 Windows 版」（指向 v1.0.0 安装包），次按钮保留操作手册；hero 说明更新为四类 AI 渠道 / Windows 10/11。
- 顶栏按钮「从源码开始」→「下载 1.0」。
- 「开始使用」改为下载优先：下载按钮 + GitHub 源码 + 操作手册；说明改为「直接下载或从源码构建」，代码卡改为 `make-windows-installer.mjs` 构建安装器并注明需要 Inno Setup 6。
- 页脚「项目仍在持续开发中」→「1.0 正式版已发布」。
- `site/README.md` 的「文案边界」同步：记录下载链接指向 v1.0.0 资产、1.0 标注、仍不写「数据不出本机/主题持久化」；后续发版需同步页面版本与链接。

## 版本

- `package.json` / `packaging/windows/release.json`：`1.0.0`；Windows 文件版本 `1.0.0.65535`（稳定版高于所有 beta）。
- 安装包名 `Zhongshuo-Setup-1.0.0-x64.exe`。

## 验证

- 设置页布局 capture（`capture-r207-settings-layout.cjs`，1324×760）**9/9**：新增「头像上传/恢复按钮组靠右对齐」；其余 8 项（无状态小字、无开关文字、行中心/行高/头像行/分区头/间距/版本名）继续通过。
- README/主页静态检查：下载链接使用 v1.0.0 资产；根 README 与 site 页面无 `status beta`/`0.1.3`/「项目仍在持续开发中」残留。
- 设置相关测试（`settingsSinglePageR157`、`callBudgetSettingsR98`、`executionConcurrencyR153`）与全量回归见交付记录；根/hifi tsc 0。
- 未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 版本 `1.0.0`，程序提交 PENDING_COMMIT。
- 干净 worktree `dist/r208-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `PENDING_BUILD1`（clean、PENDING_FILES1 文件 MANIFEST）、安装器 BUILD `PENDING_BUILD2`（安装镜像 PENDING_FILES2 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-1.0.0-x64.exe` **PENDING_BYTES 字节**，SHA256 `PENDING_SHA`，未签名；PENDING_PUSH。
- GitHub Release 使用 tag `v1.0.0`、正文取 `docs/releases/1.0.0.md`；README/主页下载链接与 Release 资产同名，发布后即可访问。

## 已知边界

- 安装包未配置代码签名，SmartScreen 可能提示「未知发布者」；主页与 README 已注明。
- README/主页的下载链接固定指向 `v1.0.0` 资产；后续发版需要同步更新链接与版本号。
- 1.0 不改变数据格式/schema（61），升级保留用户数据。
