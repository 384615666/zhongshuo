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

最终包身份、原生窗口与资源检查结果待交付追加。用户当前 beta.2 仍在运行，未强制关闭或就地改写运行中的 EXE。
