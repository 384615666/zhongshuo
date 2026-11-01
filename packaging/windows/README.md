# Windows 当前用户安装包

源码先冻结/提交，再从该源码构建最终镜像；本脚本不安装程序、不修改依赖、不推送发布。

```powershell
# 完整构建 build-ui → pack-daemon → pack-desktop → 安装镜像 → Inno EXE
node scripts/make-windows-installer.mjs

# 复用 dist/desktop/众说-便携-win-x64（先逐文件校验原 BUILD/MANIFEST）
node scripts/make-windows-installer.mjs --skip-build

# 可选指定冻结镜像；也支持 beta.N 作为当前稳定核心版本（release.json）的 beta 简写
node scripts/make-windows-installer.mjs --skip-build --version beta.0
node scripts/make-windows-installer.mjs --source-image D:/absolute/clean-image --version 0.1.3-beta.2

# 小夹具实际编译模板；不构建完整镜像，不安装或启动
node scripts/make-windows-installer.mjs --validate-template
node scripts/make-windows-installer.mjs --validate-template --version beta.2

# 只输出构建计划；只装配镜像而不编译 Inno
node scripts/make-windows-installer.mjs --prepare-only
node scripts/make-windows-installer.mjs --skip-build --stage-only
```

`--output-dir DIR` 覆盖最终 EXE 目录；`--iscc FILE` 覆盖 Inno 编译器（也可用 `ISCC_EXE`）。默认发现当前用户的 Inno Setup 6 或 Program Files 安装。无需全局 npm/pnpm install。

最终文件为 `dist/installers/Zhongshuo-Setup-0.1.3-beta.2-x64.exe`，附 SHA256 和 `.release.json`。稳定版 `X.Y.Z` 映射 Windows 数字版本 `X.Y.Z.65535`，同核心版本的 beta.N 映射 `X.Y.Z.N`（N < 65535），确保正式版高于已安装 beta.3。所有版本保留相同 AppId `com.zhongshuo.desktop`，写 HKCU 的应用卸载登记；版本不加入 AppId 或安装目录。默认目录 `%LOCALAPPDATA%/Programs/Zhongshuo`，开始菜单快捷方式始终创建，桌面快捷方式可选。安装完成的“打开众说”默认为未勾选，静默安装永不启动应用。

安装向导外观：`branding/wizard-large-*.png`（164:314，多档 DPI）与 `branding/wizard-small-*.png`（方形多档）由 `scripts/lib/wizard-images.ps1` 从根 `logo.png` 生成，`WizardImageFile`/`WizardSmallImageFile` 按当前 DPI 自动选最近档；`[Messages]` 覆盖欢迎/准备/完成页文案，去掉默认 Inno 许可与纯文本说明页（MIT 许可证与安装说明仍随包安装），完成页同时提供“打开众说/打开操作手册”。安装器开始菜单与桌面快捷方式写 `AppUserModelID=com.zhongshuo.desktop.app`；主程序安装形态也用同一 AUMID，便携/开发形态用 `com.zhongshuo.desktop.portable`，避免与旧 Electron/便携包合并任务栏按钮。卸载登记 AppId 仍为 `com.zhongshuo.desktop`，升级路径不变。

数据由主程序管理，默认 `%LOCALAPPDATA%/Zhongshuo/data`。安装器没有任何数据目录的 Files/Dirs/InstallDelete/UninstallDelete/UninstallRun 操作，不导入既有聊天。正常卸载只移除安装日志登记的程序文件，保留数据及未登记的用户文件。隔离 QA 启动应用时传显式 `--data-dir=<absolute ignored QA root>`。安装/卸载前对目标 Zhongshuo.exe 与随包 node.exe 做不写入的独占打开探测，若在使用则拒绝操作，不强杀。未启用会在静默时自动关闭用户应用的 Restart Manager；AppMutex 只有在主程序明确创建同名 mutex 后才允许 `--app-mutex NAME` 启用。

安装器镜像独立复制原便携程序，重命名 electron.exe 为 Zhongshuo.exe，并重写两份 PE 资源后再计算镜像清单：①品牌图标组（七尺寸、全语言回读）；②版本信息资源 `RT_VERSION`（ProductName/FileDescription/OriginalFilename 等改为「众说」，文件版本取发布版本）。版本资源用 `scripts/lib/brand-executable.ps1` 内的 Win32 `BeginUpdateResource`/`UpdateResource` 写入，同时提供 en-US 与 zh-CN Unicode 字符串表并回读 `FileVersionInfo` 校验；这样任务栏、文件属性与 Shell 不再继承 Electron 的默认描述。仅改发行副本，不动 `node_modules` 的 Electron 原程序。仅此副本将官方 Electron fuse V1 的 RunAsNode（索引 0）置 0 并回读，其余 fuse 原样保留，不改共享 node_modules 或便携镜像。Windows 本机 Node 独立承载 daemon，不靠这个 EXE 的 Node 模式。布局为 resources/app，未启用 OnlyLoadAppFromAsar。参考 [Electron 官方 fuse 格式](https://www.electronjs.org/docs/latest/tutorial/fuses)。当前发布没有 Authenticode 签名，发行元数据如实标 `signed:false`，Windows 可能显示未知发布者；不能宣称已签名。

`resources/app/installed-desktop.json` 声明 schemaVersion 1、appId、version/numericVersion、dataDirectory `localAppData/Zhongshuo/data` 等。镜像中加入项目 MIT、保留 Electron 的 LICENSE/LICENSES.chromium.html、Node 许可证以及随包原生依赖许可证、第三方 vendored 许可证与离线手册，再重新计算全文件 BUILD/MANIFEST 并校验。临时计划/日志中可能出现本机编译路径，仅保留 ignored dist，不进 payload。程序镜像发现用户凭据/运行数据/个人源码绝对路径即拒绝构建。

正式图标源是根目录 `logo.png`。Windows 自带 System.Drawing 转为七尺寸 ICO，内容哈希文件名贯穿安装器、卸载入口和快捷方式；发行 EXE 内嵌全部图标组/语言/尺寸并逐项回读，窗口 PNG 和任务栏属性同时采用新 logo。旧 `zhongshuo.svg` 只保留历史用途。没有新增图像依赖。中文 ISL 是项目自写的常用界面翻译覆盖，少见底层诊断继承 Inno Default.isl。`Node-LICENSE.txt` 来自 [Node v24.16.0 官方 LICENSE](https://raw.githubusercontent.com/nodejs/node/v24.16.0/LICENSE)，仅当构建 Node 同版本且本机未附 LICENSE 时使用，换 Node 版本需同步许可证。Inno Setup 本身许可证遵从 [官方发行说明](https://jrsoftware.org/isinfo.php)。

Inno 语法依据：[AppId](https://jrsoftware.org/ishelp/topic_setup_appid.htm)、[PrivilegesRequired](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm)、[AppMutex](https://jrsoftware.org/ishelp/topic_setup_appmutex.htm)、[CloseApplications](https://jrsoftware.org/ishelp/topic_setup_closeapplications.htm)、[Run skipifsilent](https://jrsoftware.org/ishelp/topic_runsection.htm)。
