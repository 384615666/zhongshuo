# 品牌图标约定（2026-11-01）

用户指定的正式 logo 为仓库根目录 `logo.png`。源码克隆中的位置即 `D:/zhongshuo-public/logo.png`；构建脚本使用仓库相对位置，交付程序不写入本机绝对路径。

`scripts/lib/brand-icon.mjs` 调用 Windows 自带 PowerShell/System.Drawing，将原图等比缩放居中，生成 16、24、32、48、64、128、256 像素的多尺寸 ICO。只转换格式和尺寸，不裁剪或重绘原图。白色背景和原图留白保持原样。

便携构建与安装构建均使用此转换器，随包保存 `resources/app/logo.png` 和 `Zhongshuo.ico`。安装器、卸载列表、开始菜单和桌面快捷方式使用该 ICO，桌面窗口使用同一图标。旧 `packaging/windows/zhongshuo.svg` 保留为历史素材，构建不再使用。

首页和项目 README 由用户安排的其他 AI 更新。后续如更换 logo，只替换根目录原图并重新构建；不要另设图标源或恢复旧的程序绘制图案。
