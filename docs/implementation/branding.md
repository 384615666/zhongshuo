# 品牌图标约定（2026-11-01）

用户指定的正式 logo 为仓库根目录 `logo.png`。源码克隆中的位置即 `D:/zhongshuo-public/logo.png`；构建脚本使用仓库相对位置，交付程序不写入本机绝对路径。

`scripts/lib/brand-icon.mjs` 调用 Windows 自带 PowerShell/System.Drawing，将原图等比缩放居中，生成 16、24、32、48、64、128、256 像素的多尺寸 ICO。只转换格式和尺寸，不裁剪或重绘原图。白色背景和原图留白保持原样。

便携构建与安装构建均使用此转换器，随包保存 `resources/app/logo.png` 和 `Zhongshuo-<图标内容哈希前12位>.ico`。安装器、卸载列表、开始菜单和桌面快捷方式使用该 ICO；升级后刷新既有众说快捷方式，避免沿用旧图标路径的 Shell 缓存。

R147 补齐原生程序品牌：`scripts/lib/brand-executable.mjs` / `.ps1` 只在发行副本上更新全部 Windows PE 图标组、语言与七个尺寸的图标资源，并逐项回读核对。`node_modules` 的 Electron 原程序不改。桌面窗口使用原 PNG，同时以 `setAppDetails` 指定任务栏 AppId 与同一哈希 ICO 路径。不能再仅凭随包存在 ICO，就认为 EXE/任务栏/快捷方式已全部换图；验收需读取原生资源、Windows Shell 快捷方式图标和实际窗口 HICON。

旧 `packaging/windows/zhongshuo.svg` 保留为历史素材，构建不再使用。首页和项目 README 由用户安排的其他 AI 更新。

首页和项目 README 由用户安排的其他 AI 更新。后续如更换 logo，只替换根目录原图并重新构建；不要另设图标源或恢复旧的程序绘制图案。
