# 设置单页化、通知总开关与外部链接

2026-11-02。用户要求把应用设置整合成一页（通用/外观/通知等不再作为独立菜单）、隐藏「打开一个定位链接」与「连接与设备」、通知增加开关、去掉 AI 设置里的本机运行状态详情、操作手册改为外部打开 HTML、帮助与关于增加 GitHub 与主页、清理开发过程文案，最后打包发版。本轮在公开源码目录 `D:/zhongshuo-public` 实施，未改动旧目录、运行中的安装版或用户数据库。

## 行为

### 设置单页

- 通用、外观、通知、AI 设置、数据与存储、帮助与关于自上而下排在同一页（`.settings-single` / `.settings-section`），左侧分区菜单整体移除；页头右侧保留设置搜索，命中后滚动到具体那一行并短暂高亮。
- `?section=` 深链保留：侧栏「设置」、托盘「设置」、标题栏「帮助」等入口仍按段落滚动定位；旧写法 `guide/manual` 映射到帮助与关于，`connections/lan` 映射到通用。
- 窄窗（≤760px）时设置行改为上下排（名称在上、控件在下），不再把名称挤成一列竖排文字；正文宽度上限 900px，超宽窗口下居中。

### 隐藏与删除的入口

- 「通用」里的「打开一个定位链接」整块移除（任务/消息定位仍可从任务、看板、活动、命令面板进入）。
- 「连接与设备」整段从界面移除（远程访问、配对码、设备吊销、本机身份与证书详情）；后端命令保持不变，仅不再提供界面入口。
- 「AI 设置」不再显示「运行环境详情 → 本机运行状态」这一行。

### 桌面通知总开关

- 新增稳定设置键 `ui.taskNotifications.enabled`（`app.settings` 白名单，值 `true`/`false`，未设置等于开启，保持原有默认行为）。
- 设置页「通知」一段新增总开关，写入后严格回读；回读不一致会显示错误并保留读取失败提示。
- 关闭时：daemon 在下一次 poll 中把该用户所有 `pending` 通知就地标记为 `suppressed`（`last_error='桌面通知已关闭'`），本次及之后 poll 返回空列表；事件游标照常推进，因此**重新开启后不会补发关闭期间的旧通知**。健康统计与最近投递记录照常真实读取。
- 渲染层：通知控制器按 store 中的开关决定是否调用 `show`；关闭时仍按同一节奏轮询（让 daemon 推进游标并抑制），绝不弹窗。开关状态在启动时读取一次，设置页写入后同步。

### 操作手册与项目链接

- 新增窄 IPC `zs:open-app-link`：只接受枚举目标 `manual | github | homepage`，先 `assertTrustedSender`，再经 `resolveAppLink` 白名单解析；手册固定指向随包 `renderer/user-guide/index.html`（先校验存在），GitHub/主页为写死的 https。不接受调用方传入的任意 URL 或路径。
- 「帮助与关于」新增「手册与项目链接」卡片：打开手册（系统默认浏览器打开离线 HTML）、GitHub 仓库（https://github.com/384615666/zhongshuo ）、产品主页（https://zhongshuo.lsjx.xyz ）；应用内不再嵌入手册 iframe。

### 文案清理

- 通知空态改为「暂无单独设置的对话串。」，删除「还没有设置过对话串通知。可在对话串右上角菜单中设置静音，再到这里统一管理。」。
- 帮助与关于删除内部偏好键与「本机用户 ID」等技术细节；通知读取态改为用户可读措辞（「正在读取对话串通知…」「正在读取桌面投递记录…」）。
- R149 文案护栏新增本轮点名字面量（含上述空态句、`本机当前能否发送真实任务`、`本地偏好键`），防止回流。

## 验证

- **完整回归**：`npx vitest run --maxWorkers=2` → 356 文件 **3220 通过 / 7 失败 / 10 预期失败 / 16 跳过**（424s）。7 项失败全部落在本机未跟踪的 `tests/integration/chaosR130Commands.test.ts` 与 `chaosR130Upgrade.test.ts`：它们要求旧私有目录 `D:\zhongshuo\dist\desktop\desktop-daily-win-v*` 的历史包数据，本公开克隆没有这些夹具，与产品代码无关；**跟踪测试 0 失败**。
- **单页设置 Electron 实测**（R152 校验脚本改造后）：7 档窗口（3440/1920/1440/1280/1100/900/640）下无横向溢出、六个段落按序堆叠、正文宽度 ≤900、无左侧菜单；`?section=help` 深链滚动到帮助段；点「打开手册」经 `window.zsAppLinks` 桥发出 `manual` 目标；旧「连接与设备/打开一个定位链接/本机运行状态」不再出现；640 档设置行改为上下排（名称列宽 ≥150）。
- **通知总开关**：`tests/integration/notificationSwitchR157.test.ts` 6 项通过——默认未设置=开启；关闭后 poll 返回空 items 且 pending 全部转 suppressed（`last_error='桌面通知已关闭'`）、健康统计照常真实；重新开启后旧通知不补发、新事件恢复 pending；非法值被 `VALIDATION_INVALID` 拒绝。
- **外部链接**：`tests/unit/appLinksR157.test.ts` 16 项通过——三种目标解析、未知/非字符串目标拒绝、manual 路径在 rendererRoot 内、main 先 `assertTrustedSender` 且只把枚举目标交给 `resolveAppLink`、preload 只转发枚举、bridge 失败不抛而返回 `{ok:false,error}`。
- **单页结构/文案**：`tests/browser/settingsSinglePageR157.test.ts` 7 项通过（分区齐全且有序、定位链接与连接设备不出现、AI 运行状态不出现、帮助段三个外链、深链别名、搜索定位、开发文案不回流）；R149 护栏新增本轮点名字面量后通过。
- **类型检查**：`tsc --noEmit -p tsconfig.hifi.json` 通过；根 `tsc --noEmit` 仍只有 13 条本机未跟踪 R130 夹具的既有错误，本轮文件 0 条。
- **lint**：改动文件与 HEAD 基线逐条对比消息一致（27 条既有），新增文件 eslint 通过，**新增 0**。
- **界面构建**：`node scripts/build-ui.mjs` 成功（含 `docs/user-guide/index.html` 重新生成）。
- **操作手册截图**：`node scripts/capture-user-guide.cjs --only=13-appearance,14-data,15-help,18-call-budget,23-settings-general-dark,24-settings-help-dark` 全部命中编号目标；截图已逐张目视（单页布局、帮助段外链卡片、深色设置页、预算开关）。

## 影响文件

- 产品：`src/ui/hifi/pages/SettingsPage.tsx`（重写为单页）、`src/ui/hifi/styles/components.css`（单页布局与窄窗设置行）、`src/ui/hifi/data/store.ts`（通知开关投影）、`src/ui/hifi/App.tsx`（启动读取开关、侧栏提示语）、`src/ui/hifi/components/TaskNotificationController.tsx`（按开关弹窗/只轮询）、`src/contracts/taskNotifications.ts`（键与 parse/serialize）、`src/daemon/commands.ts`（app.settings 白名单）、`src/daemon/taskNotifications.ts`（关闭时抑制）、`src/ui/appLinks.ts`（新）、`src/ui/main.ts`、`src/ui/preload.ts`、`src/ui/hifi/bridge.ts`。
- 测试：新增 `tests/browser/settingsSinglePageR157.test.ts`、`tests/unit/appLinksR157.test.ts`、`tests/integration/notificationSwitchR157.test.ts`；更新 R108 通知设置、R149 文案护栏、R152 设置布局 Electron 校验、R153 并发面板校验，并为 15 个旧测试/校验脚本补齐 `.png` loader（头像功能引入的 esbuild 缺口）与 `roomReplyPreviewR102` 的后台头像读取断言。
- 手册：`docs/user-guide/README.md` 第 11、14 章与托盘说明；重采集 `13-appearance / 14-data / 15-help / 18-call-budget / 23-settings-general-dark` 并新增 `24-settings-help-dark`，删除已不存在的 `24-settings-guide-dark`；`scripts/lib/user-guide-scenes.js` 同步。

## 交付（0.1.3-beta.10）

- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.10-x64.exe`，**160,106,495 字节**，SHA256 `18197ed8948e7205df5c2ebe1e2505b2a6b3279e151d104e5e4d809d316fe069`，附 `.sha256`、`.release.json`；未签名。
- 程序源码 `fb26a2e` clean（dirty=false），安装镜像 BUILD `bld_5f6885bf512d64a`、665 文件清单全部核对（脚本内 `verifyManifest` 逐文件 hash）；随包 `Zhongshuo.exe` 版本资源回读 ProductName/FileDescription=众说、FileVersion=`0.1.3-beta.10`、OriginalFilename=`Zhongshuo.exe`。
- **包内隔离验证 18/18 通过**（`dist/r157/package-qa-*`，独立数据目录、假运行时、不装注册表）：包内 EXE 启动、boot ready/连接在线、使用指定数据根且忽略继承根、版本 `0.1.3-beta.10`、设置页为单页（无侧栏菜单、六段有序）、旧入口（连接与设备/打开一个定位链接/本机运行状态）不出现、通知总开关存在、手册/GitHub/主页三个入口与 `zsAppLinks` 桥存在、GitHub 与主页地址可见、通知开关关闭/开启均回读一致、`?section=help` 滚动到帮助段、正常停机 exit 0 且 daemon 已停止。
- 本轮**未**执行静默安装/卸载：安装器模板本轮未改，静默安装会改写用户当前 beta.9 的 HKCU 卸载登记与快捷方式，故只对安装镜像做上述包内验证；用户按正常流程从托盘退出旧版后覆盖安装。
- 已推送公开 `main` 并发布 GitHub Release `v0.1.3-beta.10`（见 release 页）。

