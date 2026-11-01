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
  - en-US(040904B0) 与 zh-CN(080404B0) 两套 Unicode 字符串表，写入前删除既有版本语言块，写入后回读 `FileVersionInfo` 校验；
  - 与既有七尺寸 ICO 重写在同一脚本内完成，图标/版本均回读验证，任一不符构建失败。
- `scripts/lib/brand-executable.mjs` 新增 `windowsExecutableBrand(release, originalFilename)`，两个调用点（便携 `electron.exe`、安装镜像改名后的 `Zhongshuo.exe`）传入版本元数据；安装镜像把回读结果写入 `installed-desktop.json` 的 `nativeVersion`。
- `src/ui/main.ts` 的 `win.setAppDetails` 增加 `relaunchDisplayName: '众说'`。
- 版本 `0.1.1` → `0.1.2`（package.json / release.json / 版本测试 / 发布说明 / 安装器 README）；AppId、安装目录、数据目录不变。
- 发布说明 `docs/releases/0.1.2.md`。

## 验证

- 原型：对 `node_modules/electron/dist/electron.exe` 副本执行脚本，回读 `ProductName=众说`、`FileDescription=众说`、`FileVersion=0.1.2`、`OriginalFilename=Zhongshuo.exe`、`CompanyName=众说开源项目`，图标 7 帧/1 组回读通过。
- 构建：从干净 worktree 构建 0.1.2，核对安装镜像内 `Zhongshuo.exe` 的 `FileVersionInfo` 与 `installed-desktop.json.nativeVersion`；安装器身份/版本/哈希/清单/隐私扫描照旧。
- 后续待补：安装包实装到隔离目录验证（本轮不再误触模板安装；仅使用真实安装包的静默安装到隔离目录），GitHub Release 结果。

## 未做

- 未改已发布的 0.1.1 包；未签名；未改 AppId/AUMID（保持升级与快捷方式连续，任务栏缓存刷新仍可能需要退出全部旧窗口）。
- 若用户仍同时运行旧 V78 便携版，它的旧 AUMID/旧 EXE 仍会显示旧身份；建议关闭旧版后使用新安装包。
