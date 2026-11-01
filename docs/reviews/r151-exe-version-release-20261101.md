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
- 构建：从干净 worktree 构建 0.1.2，安装镜像内 `Zhongshuo.exe` 的 `FileVersionInfo` 与 `installed-desktop.json.nativeVersion` 均为众说/0.1.2；安装器身份/版本/哈希/清单/隐私扫描照旧。
- 任务栏名称：用安装镜像 `Zhongshuo.exe --data-dir=<隔离目录>` + 新 AUMID 启动，任务栏按钮显示「众说 - 1 个运行窗口」（旧 AUMID 仍显示 Electron，证明缓存只影响旧 id）。
- **待补**：0.1.2 安装包静默安装到隔离目录/卸载、GitHub Release 发布结果。

## 未做

- 未改已发布的 0.1.1 包；未签名；卸载登记 AppId 与安装目录/数据目录保持不变（仅任务栏 AUMID 改为新的稳定 id）。
- 旧 V78/旧 0.1.1 仍使用旧 AUMID：只要它们不运行就不影响安装版；若再次运行旧 V78，它会以自己的旧身份单独出现，不会再合并安装版。
