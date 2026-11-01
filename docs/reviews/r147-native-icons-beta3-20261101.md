# R147 EXE、快捷方式和任务栏图标（2026-11-01）

用户安装 beta.2 后仍看到旧对话图标和 Electron 图标。只读核对确认安装 BUILD 正是 bld_30574674228982a6，桌面/开始菜单指向正确安装目录，随包 ICO 已是新猫咪 logo；但从 Zhongshuo.exe 原生资源提取到的仍是 Electron 图标。此前只换了外置 ICO 和 BrowserWindow 参数，未改 EXE 图标资源，快捷方式也持续复用同一图标路径。原验收没有验证这三个实际显示来源，结论不完整。

## 修复

- 用 Windows 资源 API 在发行副本写入全部图标组、语言和七尺寸图像，回读组目录及每个图像的完整字节核对；不改依赖中的 Electron 文件。便携和安装程序都执行此步骤，安装副本随后设置原有 fuse，并纳入全文件 manifest。
- ICO 文件名包含内容 SHA256 前12位，安装元数据、开始菜单、桌面和卸载入口共同引用。已存在的众说桌面快捷方式即使本次没有勾选新建，也更新其图标位置；安装后仅对众说两个快捷方式发送 SHCNE_UPDATEITEM，不删除全局缓存或重启 Explorer。
- 窗口使用源 PNG；Windows setAppDetails 同时给出稳定 AppId 与版本化 ICO，补齐任务栏重开图标属性。
- 发行版本 beta.3，保留 AppId、数据根及 CLI 生命周期修复。

Windows 资源更新遵循 [Microsoft UpdateResourceW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-updateresourcew)；窗口属性遵循 [Electron BrowserWindow.setAppDetails](https://www.electronjs.org/docs/latest/api/browser-window#winsetappdetailsoptions-windows)。

## 验证与交付

`scripts/verify-brand-icons-r147.ps1` 从 Windows Shell 提取 EXE/快捷方式图标，与外置 logo ICO 比较；保留系统快捷方式箭头。可进一步读取真实窗口的 WM_GETICON HICON，与源 logo 作图像误差核对。初期验证器使用不同提取 API及未排除完整快捷箭头的精确比较失败，已修正为相同 Shell API及明确箭头区域，产品图标资源的完整字节检查不依赖此排除。

用户当前 beta.2 仍在运行，未强制关闭或就地改写运行中的 EXE。开始菜单和桌面旧入口已只读确认指向 beta.2；当前没有指向该 EXE 的固定任务栏快捷方式。

## 最终结果

- clean 程序源码 `08c5cb08aeedf440859d5e6292ca42df32d0c278`；安装 BUILD `bld_de7686891fe36cd1`，源镜像 `bld_e38531c45fb3c5ef`；660 文件完整清单与隐私扫描通过。安装副本 RunAsNode=false、其余 fuse 保留。图标资源回读为1组/1语言/7尺寸全部匹配。
- `dist/installers/Zhongshuo-Setup-0.1.0-beta.3-x64.exe`，158187993 字节，SHA256 `155dc14a3b8804f63bd6ca4867efeb8d16d683c2925ddd0e2bf2770afa9238e8`，附校验与 release JSON。未签名、未远端发布，未自动覆盖用户运行中的安装。
- 完整源码和界面 TypeScript 检查、修改代码 lint、17项相关桌面入口回归通过；Inno模板与完整安装器实际编译成功。没有把 R146 的2798项全量称为本轮重跑。
- 实际包内原生 EXE、独立数据根、非主屏启动至 ready/online。Windows Shell EXE/快捷方式图标与logo逐像素核对、真实窗口存在/WM_GETICON、AppId和RelaunchIconResource属性回读、窗口图像匹配共7项通过；正常退出0、daemon.pid消失。证据 `dist/r147-ui/e19696f6-4bb9-4412-b0b9-16ccd03aa016`，三张原生图标 PNG 已目视核对。真实模型调用0。
- 验证器后续修正为按PID枚举真实Chrome窗口，使用64位24字节PROPVARIANT读Shell属性，并避免覆盖PowerShell自动变量；原错误报告保留。最后脚本/记录提交不改变上述程序BUILD。

主目录原有未提交续工、审计及站点工作保持。R147程序改动同步回主目录；冻结包来自 `codex/r147-native-icons-beta3` 分支，没有合并或推送旧私有历史。
