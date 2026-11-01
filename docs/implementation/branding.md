# 品牌图标约定（2026-11-01）

用户指定的正式 logo 为仓库根目录 `logo.png`。源码克隆中的位置即 `D:/zhongshuo-public/logo.png`；构建脚本使用仓库相对位置，交付程序不写入本机绝对路径。

`scripts/lib/brand-icon.mjs` 调用 Windows 自带 PowerShell/System.Drawing，将原图等比缩放居中，生成 16、24、32、48、64、128、256 像素的多尺寸 ICO。只转换格式和尺寸，不裁剪或重绘原图。白色背景和原图留白保持原样。

便携构建与安装构建均使用此转换器，随包保存 `resources/app/logo.png` 和 `Zhongshuo-<图标内容哈希前12位>.ico`。安装器、卸载列表、开始菜单和桌面快捷方式使用该 ICO；升级后刷新既有众说快捷方式，避免沿用旧图标路径的 Shell 缓存。

R147 补齐原生程序品牌：`scripts/lib/brand-executable.mjs` / `.ps1` 只在发行副本上更新全部 Windows PE 图标组、语言与七个尺寸的图标资源，并逐项回读核对。`node_modules` 的 Electron 原程序不改。桌面窗口使用原 PNG，同时以 `setAppDetails` 指定任务栏 AppId 与同一哈希 ICO 路径。不能再仅凭随包存在 ICO，就认为 EXE/任务栏/快捷方式已全部换图；验收需读取原生资源、Windows Shell 快捷方式图标和实际窗口 HICON。

R149 补齐程序内品牌位（用户反馈「logo 还有很多地方没替换」）：`scripts/build-ui.mjs` 把根 `logo.png` 复制到 `dist/ui/renderer/assets/logo.png`；欢迎页用该图替换旧 CSS「众」字方块（`.welcome-brand`，保留原图比例与白底留白）；`index.html` 增加同一 favicon；`src/ui/main.ts` 统一窗口图标解析（优先应用根 `logo.png`，其次随包渲染器副本，最后原生 ICO），主窗口与数据操作进度窗口共用；数据操作页品牌位显示同一图。安装器 `packaging/windows/zhongshuo.iss` 的「卸载众说」「众说操作手册」快捷方式也显式指向正式 logo ICO（此前为空，显示系统默认文件图标）。旧构建/旧便携包（如 V78）没有这些源图，属构建产物过期；重新构建后任务栏与窗口才显示正式 logo，不在源码层修补旧包。

R150 安装向导品牌图：`scripts/lib/wizard-images.ps1` 从根 `logo.png` 生成 `packaging/windows/branding/wizard-large-*.png`（164:314，202–534 七档）与 `wizard-small-*.png`（方形 58–159 七档），`.iss` 用逗号列表交给 Inno 按 DPI 自动选档；品牌浅色渐变、白色圆角 logo 卡与产品中英文层级只做排版，不裁剪/重绘原图。修改 logo 后需重新运行该脚本并重新构建安装器。

R151 原生版本资源：`scripts/lib/brand-executable.ps1` 在同一发行副本上同时重写七尺寸图标组与 PE 版本资源（`RT_VERSION`），把 ProductName/FileDescription/InternalName/OriginalFilename/公司/版权/文件版本从 Electron 默认值改为「众说」；写入 en-US 与 zh-CN 两套 Unicode 字符串表并回读 `FileVersionInfo` 校验。任务栏、文件属性与 Shell 分组不再显示 Electron；只改发行副本，不改 `node_modules` 内 Electron 原程序。修改版本号时更新 `packaging/windows/release.json`，构建器会同时写入安装器与随包 EXE。

旧 `packaging/windows/zhongshuo.svg` 保留为历史素材，构建不再使用。首页和项目 README 由用户安排的其他 AI 更新。

首页和项目 README 由用户安排的其他 AI 更新。后续如更换 logo，只替换根目录原图并重新构建；不要另设图标源或恢复旧的程序绘制图案。
