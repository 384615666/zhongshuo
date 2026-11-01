# R151 重写随包 EXE 版本资源 + 0.1.2 发版（2026-11-01）

用户反馈：任务栏仍显示 Electron 原子图标/名称，要求重写 EXE 并发版。0.1.1 已修复程序内 logo；本轮解决打包 EXE 的 **PE 版本信息**仍继承 Electron 的问题。

## 根因

- 0.1.1 的 `Zhongshuo.exe` 只替换了图标资源（R147），版本资源仍是 Electron：`ProductName=Electron?`、`FileDescription=Electron`、`InternalName/OriginalFilename=electron.exe`、文件版本 44.4.5。
- Windows 任务栏分组、任务管理器与文件属性会读取这些描述；任务栏在旧 AUMID 缓存/旧便携版并存时显示为「Electron」。
- 与 0.1.1 发版后支持记录一致：旧 V78 与安装版共用 AUMID、任务栏缓存旧图标；本轮从 EXE 元数据层面消除 Electron 身份。

## 实现

- `scripts/lib/brand-executable.ps1` 新增 `ZhongshuoNativeVersion`：用 Win32 `BeginUpdateResourceW` / `UpdateResourceW`（`RT_VERSION=16, id=1`）写入构造的 `VS_VERSIONINFO`：
  - `VS_FIXEDFILEINFO` 签名/结构版本/文件与产品版本（取 release.numericVersion 四段）；
  - `StringFileInfo`：CompanyName、FileDescription、FileVersion、InternalName、LegalCopyright、OriginalFilename、ProductName、ProductVersion、Comments；
  - en-US(040904B0) 与 zh-CN(080404B0) 两套 Unicode 字符串表，写入前删除既有版本语言块；
  - 与既有七尺寸 ICO 重写在同一脚本内完成，图标回读在进程内完成，版本资源由新 PowerShell 进程 `verify-exe-version.ps1` 回读校验（PowerShell 5.1 在 `windowsHide`/`-NonInteractive` 下会对刚提交的资源返回空值，不能在同一进程内判定）。
- `scripts/lib/brand-executable.mjs` 新增 `windowsExecutableBrand(release, originalFilename)`，两个调用点（便携 `electron.exe`、安装镜像改名后的 `Zhongshuo.exe`）传入版本元数据；安装镜像把回读结果写入 `installed-desktop.json` 的 `nativeVersion`。
- `src/ui/main.ts` 的 `win.setAppDetails` 增加 `relaunchDisplayName: '众说'`。
- **AUMID 隔离**（任务栏名称被 Windows 旧缓存固定为 Electron 的根因）：安装版改用新的稳定 `com.zhongshuo.desktop.app`，便携/开发版用 `com.zhongshuo.desktop.portable`；安装器开始菜单/桌面快捷方式同步写安装版 AUMID。旧 V78/旧 0.1.1 的旧 AUMID 不再参与安装版任务栏分组，Windows 会按新 EXE 的 FileDescription/快捷方式解析出「众说」。AppId（卸载登记）保持 `com.zhongshuo.desktop` 不变。
- 版本 `0.1.1` → `0.1.2`（package.json / release.json / 版本测试 / 发布说明 / 安装器 README）；安装目录、数据目录不变。
- 发布说明 `docs/releases/0.1.2.md`。

## 验证

- 原型：对 `node_modules/electron/dist/electron.exe` 副本执行脚本，新进程回读 `ProductName=众说`、`FileDescription=众说`、`FileVersion=0.1.2`、`OriginalFilename=Zhongshuo.exe`、`CompanyName=众说开源项目`，图标 7 帧/1 组回读通过。
- 构建：从 `299fcb4` 干净 worktree 构建 0.1.2，便携源镜像 `bld_073b2d0d45e27d21` clean，安装镜像 BUILD `bld_1a71ec20247c33c9`/commit `299fcb4`/dirty=false/661 文件；镜像内 `Zhongshuo.exe` 的 `FileVersionInfo` 为众说/0.1.2/Zhongshuo.exe/众说开源项目；`installed-desktop.json` 的 `nativeIcon`（7 帧 Verified）与 `nativeVersion`（众说/0.1.2）均为规范化结构；安装器 EXE 159,327,758 字节、SHA256 `ab4a01c6fd0f4992f4417290c6ef71a6e5f25634d19f05717d8ae28461ae054f`、FileVersion/ProductVersion 0.1.2、FileDescription 众说 Windows 安装程序。
- 任务栏身份：用安装镜像 `Zhongshuo.exe --data-dir=<隔离目录>` 启动，默认安装版 AUMID 下任务栏按钮显示「众说 - 1 个运行窗口」且图标为正式猫咪 logo（截图 `dist/r151-tools/taskbar-0.1.2-aumid.png`）；旧 AUMID 仍显示 Electron，确认新 AUMID 生效。
- 安装/卸载：最终 0.1.2 安装器静默装到隔离目录（665 文件；EXE 元数据/installed-desktop/nativeVersion/logo 均正确；卸载登记与开始菜单临时指向隔离目录）→ 静默卸载 exit 0、隔离目录清空；随后恢复原 0.1.1 的卸载登记与快捷方式（DisplayVersion=0.1.1、原图标、桌面上原本没有快捷方式则保持没有）。未启动安装后的程序，未动用户数据。
- 全量测试：清除本机 `ELECTRON_RUN_AS_NODE=1` 后 vitest **2911 通过 / 0 失败 / 10 expected fail / 14 跳过**（唯一 4 项失败仍来自本机未跟踪、缺旧夹具的 `chaosR130Upgrade.test.ts`）；`tsconfig.hifi.json` 通过。

## 发布结果（2026-11-01）

- GitHub Release：https://github.com/384615666/zhongshuo/releases/tag/v0.1.2 （draft=false、prerelease=false、latest=true）。
- tag `v0.1.2` 指向源码提交 `299fcb487161fc4132ec92fcaf744b3637d4c1c0`，公开 main 已同步；三项资产已上传，服务端 digest 与本地一致：EXE（159,327,758 字节，sha256:ab4a01c6…）、`.exe.sha256`、`.release.json`；未登录下载 HEAD 302→200、Content-Length 正确。
- 未签名（如实 `signed:false`）。用户当前安装的 0.1.1 与数据未动；需正常退出旧版后运行 0.1.2 安装包升级。

## 未做

- 未改已发布的 0.1.1 包；未签名；卸载登记 AppId 与安装目录/数据目录保持不变（仅任务栏 AUMID 改为新的稳定 id）。
- 旧 V78/旧 0.1.1 仍使用旧 AUMID：只要它们不运行就不影响安装版；若再次运行旧 V78，它会以自己的旧身份单独出现，不会再合并安装版。
