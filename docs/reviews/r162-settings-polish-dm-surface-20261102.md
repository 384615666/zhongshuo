# 开始菜单名字、主区底色与设置页排版精修

2026-11-02。用户安装 beta.14 后反馈三件事：①Windows 开始菜单里名字还是「Electron」；②私信界面背景色与房间/回复串不一致；③设置页排版粗糙需要精修。另要求顶部栏给设计方案、先不开发，最后打包发版。本轮在公开源码目录 `D:/zhongshuo-public` 实施（HEAD 为 beta.14 `1550c1f`，与本轮改动并行的是 R158–R161 的私信分组/头像/置顶功能，本轮未回退它们）。

## 一、开始菜单显示 Electron

**根因**：不是安装器写错名字，而是两枚**早期未品牌化构建遗留**的开始菜单快捷方式：

| 快捷方式 | 创建/修改 | 指向 | AppUserModelID |
|---|---|---|---|
| `…\Start Menu\Programs\Electron.lnk` | 10-01 创建 / 11-01 12:40 改写 | 安装目录 `Zhongshuo.exe` | `com.zhongshuo.desktop`（便携版） |
| `…\Start Menu\Programs\ElectronApp.lnk` | 11-01 18:14 | 安装目录 `Zhongshuo.exe` | `com.zhongshuo.desktop.app`（安装版） |

安装器写的 `众说\众说.lnk` 与 `ElectronApp.lnk` 共用安装版 AUMID，Windows 按 AUMID 去重后显示成了 `ElectronApp`；`Get-StartApps` 里根本没有「众说」，只有 `Electron`/`ElectronApp`（实测）。

**修复**：
1. 本机清理：备份后删除这两枚快捷方式并 `SHChangeNotify` 刷新 → `Get-StartApps` 立刻变成「众说 / 卸载众说 / 众说操作手册」（备份在 ignored `dist/r157/startmenu-backup/`）。
2. 产品侧防复发：安装器 `[Code]` 新增 `RemoveStaleAppShortcut`，在 `ssPostInstall` 只删除**目标确实等于 `{app}\Zhongshuo.exe`** 的 `Electron.lnk` / `ElectronApp.lnk`（先 `FileExists`、再比 `TargetPath`、删后刷新 Shell），绝不按名字盲删别的软件同名项。`众说.lnk` 继续带 `com.zhongshuo.desktop.app`。

## 二、私信背景色

**实测**（隔离数据 + 真实界面取计算样式）：`.app` = `#F2F8FB`；房间 `.main`/`.col-main`/`.col-thread` = `#FFFFFF`；私信页根节点没有 `.main`，是透明 div → 透出窗口底色，对话区实测像素 `#F2F8FB`。设计规范 §4.1 写明「`--bg-app` 只给侧栏与窗口缝，主区不用它」。

**修复**：私信页根节点改为 `<div className="main">`（背景 `--bg-surface`），与房间/回复串同一主区面。重采集截图后同一位置像素为 `#FFFFFF`。

## 三、设置页排版精修

在 R157 单页结构上逐项修：

- **页头吸顶**：`.settings-head` 改为 `position: sticky`（吃掉 `.page` 顶部 20px 留白，避免吸顶时漏缝），标题与搜索在任何段落都可见；`?section=` 深链的 `scroll-margin-top` 同步到 104px，标题不再被页头盖住。
- **搜索结果浮层**：结果列表改成绝对定位浮层（带底色/描边/阴影），不再把下面所有段落顶下去。
- **卡片分组**：每个分区内的行都收进卡片——启动；显示 + 我的头像；桌面通知 + 对话串通知 + 投递记录；调用次数预算 + 同时运行的 AI + AI 成员；数据位置与备份 + 草稿 + 归档与项目；手册与项目链接 + 版本 + 诊断。原来「当前数据位置」「草稿保存」「归档管理」等裸行不再悬空。
- **控件右对齐**：主题（浅色/深色分段）与显示头像开关移入 `SettingsRow` 的右列；重试/清理、从旧版本导入、已移除的项目按钮同样右对齐。
- **去重**：通知卡片标题「桌面通知」+ 行标签「允许弹出系统通知」（原来卡片标题与行标签都是「桌面通知」）；开关自带的状态文字保留，删掉下面重复的状态行（状态改挂 `data-zs-notification-status` 属性）；「我的头像」卡片里删掉重复的「头像」字段名（`AvatarPicker` 新增 `hideLabel`）。
- **收噪声**：投递记录（本机排查用）收进折叠区；帮助页的诊断块不再卡中卡（`LocalDiagnostics` 自带 `.card`，作为并列卡片）。
- **分层只用留白**：段间不再画第二条线（页头已有一条发丝线，实测 y=116 与 y=142 两条线叠在一起），段间距 34px；卡片之间 12px、卡内标题与首行 8px 统一由 CSS 承担。

## 四、标题栏设计提案（只出方案）

`docs/design-proposals/titlebar-r158.md`：核对源码后按真实类名（`.zs-titlebar` / `.pool-head` / `.thread-tabs` / `.thread-nav` / `.thread-head`）给出「房间页 38+38+42≈118px 才见第一张卡」「左右两列内容起点差约 38px」等实测数据、现状线框图、7 条视觉问题、5 条设计原则、A/B/C 三方案（含线框图、优缺点、改动范围、对 R152/R135/R90/R153 测试的影响）、推荐路径（先 B 后 A）与 10 条可几何断言的验收标准。本轮**不开发**。

## 验证

- **完整回归**：`npx vitest run --maxWorkers=2` → 362 文件 **3252 通过 / 7 失败 / 10 预期失败 / 16 跳过**（467s）。7 项失败仍全部落在本机未跟踪的 `chaosR130Commands` / `chaosR130Upgrade`（缺旧目录历史包夹具），**跟踪测试 0 失败**。
- **设置页 Electron 实测**（R152 校验脚本）：7 档窗口（3440→640）无横向溢出、六段有序、无左侧菜单、正文 ≤900、深链滚动到帮助段、手册按钮经 `window.zsAppLinks` 发出 `manual`、旧入口不出现、640 档设置行上下排——全部通过。
- **排版断言**：`settingsSinglePageR157` 扩到 10 项（卡片分组、控件右列、去重、投递记录折叠、吸顶与浮层 CSS、私信与房间同底色）全部通过；`installerShortcutCleanupR158` 2 项通过（安装器只删指向本程序的 Electron/ElectronApp 快捷方式、众说快捷方式仍带安装版 AUMID）。
- **背景色实测**：隔离数据 + 真实界面取计算样式，私信根节点由透明改为 `.main`（`#FFFFFF`）；重采集截图同一坐标像素由 `#F2F8FB` → `#FFFFFF`。
- **开始菜单**：删除两枚遗留快捷方式并刷新 Shell 后 `Get-StartApps` 由 `Electron / ElectronApp` 变为 `众说 / 卸载众说 / 众说操作手册`。
- **类型与 lint**：`tsc --noEmit -p tsconfig.hifi.json` 通过；改动文件 eslint 0 条消息。
- **界面构建与截图**：`node scripts/build-ui.mjs` 成功；`dist/r158-shots/before|after2/` 为精修前后逐段截图（已逐张目视）。

## 交付

- 版本 **0.1.3-beta.15**（Windows `0.1.3.15`）。
- 安装包与包内验证结果见交付小节（追加于构建后）。
