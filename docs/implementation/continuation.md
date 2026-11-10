# 续工记录（continuation）

## 2026-11-09：R213 产品主页 1.0.2 + 自动指向最新 Release

用户反馈 1.0.2 已发布但线上首页仍为 1.0.1，要求更新并让以后发版自动最新。处理：`site/index.html` 3 个下载按钮的静态回退改 v1.0.2、4 处版本号挂到 `data-release-version`、新增 `data-release-page` 的 Release 链接；新增稳定入口 `site/download/index.html`；`site/app.js` 请求 GitHub `releases/latest` 校准版本号/下载地址/Release 链接，按 10 分钟缓存 `sessionStorage`，离线/限流保留静态回退，安装包按 `Zhongshuo-Setup-*-x64.exe` 匹配；README 下载入口改为 `https://zhongshuo.lsjx.xyz/download/`、版本与 SHA256 指向 `releases/latest`；`site/README.md` 记录机制与 gh-pages 发布步骤。验证：`node --check`/eslint 通过；假 DOM 执行 app.js 的成功/失败/缓存三路径通过（`dist/r213-site/check-site.cjs`）；Electron 本地渲染两种页面无横向溢出；`main` `ee86fef` 与 `gh-pages` `22da7b9` 推送后 Pages build `built`，线上首页 4 处版本号与 3 个下载链接均为 1.0.2、`/download/` 200、手册版本行 1.0.2、线上真实浏览器执行 app.js 成功缓存 `v1.0.2`（自动校准已生效）。以后发新 Release 最多 10 分钟自动生效，无需重部署站点。未改应用代码/未打包/未安装升级/未调用真实模型/未操作用户数据。见 [R213](../reviews/r213-homepage-latest-1.0.2-20261109.md)。

## 2026-11-10：R214 AI 设置下拉选中后不自动关闭（1.0.3 已发布）

用户带截图反馈：AI 设置里选择渠道后下拉不会自动关闭，要求修复后打包发版。根因：设置行用 `<label>` 包住自绘下拉，点击选项（普通 div）冒泡到 label 时，label 的激活行为向内部 combobox 按钮补发 click，把 `pick()` 刚关掉的列表重新打开；项目内所有 `Select` 都套在 label 里，渠道、思考等级、权限模式、成员状态筛选等一并受影响。修复：`components/ui.tsx` 的 `Select` 根容器在捕获阶段 `preventDefault()`，早于原生事件到达 label，阻止补发；按钮/选项点击、键盘、外部关闭行为不变。新增浏览器回归 `tests/browser/selectAutoCloseR214.test.ts`（9 项，未修复源码上失败、修复后通过）与真实界面验收 `scripts/capture-r214-ui.cjs`（修复前渠道/权限模式/状态筛选/截图场景 4 项失败，修复后通过；前后截图在 ignored `dist/r214-ui/`）。相关定向 7 文件 55 项通过；完整默认套件 389 文件/3489 项（386 文件通过、2 跳过；3470 通过、3 预期失败、15 跳过），唯一失败 `ledgerLifecycle` 为并发负载下的 daemon 停止时序断言，单文件复跑 6/6 通过，非本轮改动回归；根/hifi 类型、改动文件 lint、diff check 通过。版本升 `1.0.3`（`1.0.3.65535`），手册版本行同步；首页/README 不动。构建使用仓库内 ignored 开发工具目录的 Node.js 24.22.1 与 Inno Setup 6：内部便携装配 `bld_98fc90aad82d8fef`（clean）、安装器 `bld_d882507eae9bbd8f`（clean、670 文件，隐私扫描/fuse/无用户数据通过），安装包 `dist/installers/Zhongshuo-Setup-1.0.3-x64.exe` **160,960,921 字节**，SHA256 `e0039942b2236bd3494d87508c13664f6c2a3f63c5cbfadef11354a33905ffe4`，未签名；安装镜像隔离 21/21、退出 0、真实模型调用 0。源码提交 `1507b41`、tag `v1.0.3` 已推送（基于主页 R213 的 `ed01a6e`）；GitHub Release「众说 1.0.3」已发布为 Latest（draft=false、prerelease=false）：https://github.com/384615666/zhongshuo/releases/tag/v1.0.3 。exe/.sha256/.release.json 三资产服务端 digest 与长度与本机逐一一致，公开下载 302→200、Content-Length=160960921。用户自行安装；未运行安装器、未执行安装/升级/卸载、未操作用户数据。见 [R214](../reviews/r214-select-dropdown-autoclose-20261110.md)。

## 2026-11-09：R212 1.0.2 安装包发布完成

用户明确要求将本轮修复打包发版。合并 R210 Harness 安装入口与 R211 Claude 代理/原生程序占位检测，版本升 1.0.2（1.0.2.65535），手册版本行同步；首页与 README 不动。代码提交 `f2f76da`、测试夹具隔离 `3344950`、原生依赖复制修复 `ceccd48`；tag `v1.0.2` 指向 `ceccd48ca88cf0f4123d1870c92047cf1f1184af`。完整首轮覆盖 388 文件/3488 项，12 条失败涉及的 7 文件补跑 49/49 收口，不冒称单次全量全绿；根/hifi 类型、本轮 lint、Inno 模板编译通过。干净同盘 worktree `dist/r212-source`、Node 24.22.1 构建，内部装配 `bld_f7484fd5f358c59e`（633 文件），安装器 `bld_45eb936fc249956a`（670 文件，隐私扫描/禁用 Node fuse/无用户数据通过），包内隔离 21/21、退出 0、真实调用 0。安装包 `dist/installers/Zhongshuo-Setup-1.0.2-x64.exe` **160,976,533 字节**，SHA256 `662d4e4b5f3fe32df9b319d522b2353239b59fe5602709c53b60fe8665a90a0a`，未签名；源码与 tag 已推送，GitHub Release「众说 1.0.2」已发布并为 Latest，exe/sha256/release.json 三项服务端 digest/长度与本机一致，公开下载 302→200/长度一致。用户自行安装；未运行安装器、升级/卸载程序、修复真实 Claude CLI、修改系统代理或用户数据。详见 [R212](../reviews/r212-runtime-fixes-release-1.0.2-20261109.md)。

## 2026-11-09：R211 Claude 代理误报与原生程序占位检测（源码修复，未打包）

用户报告 ALL/HTTPS/HTTP_PROXY「改变渠道或宿主执行」。确认该提示为众说将普通代理误当 provider/host 接管；本机默认 npm Claude 2.1.318 的 claude.exe 同时为 500 字节“原生程序未安装”占位文本。现合法 HTTP(S) 代理不再阻塞，原样保留及继续按原 v3 算法纳入指纹；provider/host/动态凭据/项目托管覆盖仍拒绝。ALL_PROXY 仅保留透传，不宣称官方支持；代理场景模型清单保留本机配置，不带凭据绕过代理直连。识别默认/显式/shim 的已知占位文本并显示安装不完整，不代装 CLI；修复 probe close 回调重复解析造成的异常风险，将旧回放的本机依赖改隔离夹具。最终 **18 文件/208 项通过**（本轮新增 29 项，含 R210 回归）、本轮 lint/定向 TypeScript/diff check 通过。本机只读新代码 reason=null、代理未变、默认 CLI missing；未真实模型联网、未修复用户 CLI、未修改系统代理或用户数据。版本仍 1.0.1，未打包/提交/推送/Release；保留 R210 改动。见 [R211](../reviews/r211-claude-proxy-native-installation-20261109.md)。

## 2026-11-09：R210 Harness 安装时转发入口识别（源码修复，未打包）

用户安装 1.0.1 收到 Harness 自动配置失败，要求在产品安装时解决。现场 PATH 命中 ProgramData 下 `dsh.cmd`，再 `call` 官方桌面 shim；旧解析器拒绝且 setup 仅在找不到入口时回退。共享解析器新增纯转发的静态解析（绝对/dp0、最多八层、循环/额外命令/未知环境变量拒绝、不执行 shell），整条链和最终脚本/ASAR 纳入指纹，普通 JS 的 package 元数据仍参与。setup 在默认入口缺失或无法识别时查常规桌面/npm 入口，安装器与手动重试共用；显式入口不替换、真实错误不伪装未安装、版本/归档/probe/原配置保留规则不变。定向九文件 **86/86**（新增 22 项）、本轮 lint/定向 TypeScript/diff check 通过；新打包解析模块成功识别本机实际转发链，官方仅 `--version` 在隔离 home 返回 0.2.2-rc.1/退出 0，`--plan` 校验通过。未改用户程序/profile/运行数据，零真实模型；未打包新版安装器、未提交/推送/Release，版本仍 1.0.1。全量依赖恢复受 SheetJS CDN 超时限制，未做全量回归或全仓类型检查。详见 [R210](../reviews/r210-harness-installer-entry-20261109.md)。

## 2026-11-08：R209 操作手册更新 + 产品主页上线（1.0.1）

用户反馈操作手册还是旧版、README 产品主页应指向 `https://zhongshuo.lsjx.xyz/`、线上首页没更新。处理：重新运行 `capture-user-guide.cjs` 采集当前 1.0 界面 24 张场景截图（安装向导/完成保留）；修复截图脚本两处过期定位（文件预览下载入口已并入「更多文件操作」菜单；深色设置页原 `general` 分区改为 `appearance`）。手册正文更新：版本行 1.0.1；设置章节分区改为「外观→通知→AI 设置→数据与存储→帮助与关于」并注明无说明性小字/草稿设置/状态文字；文件预览保存步骤改为「更多文件操作→下载原文件/另存为…」；删除「对话串通知」；重新生成 `docs/user-guide/index.html`。README 两处产品主页链接改为 https://zhongshuo.lsjx.xyz/ 。发现线上主页托管在本仓库 gh-pages 分支（GitHub Pages + 自定义域），此前只更新 main 的 `site/`，gh-pages 仍为 2026-11-01 旧版；本版将 `site/` 与 `docs/user-guide/` 同步到 gh-pages（保留 CNAME），部署后线上应显示 1.0 与下载按钮。版本升 `1.0.1`（`1.0.1.65535`），安装包 `Zhongshuo-Setup-1.0.1-x64.exe`；README/首页下载链接指向 v1.0.1。验证：手册采集 26 场景全部通过；`build:ui`/`pack-daemon` 通过；设置页/界面回归与全量见交付；线上抓取断言 1.0 下载与手册 200。交付：程序提交 `9c69bd5`；干净 worktree `dist/r209-source` 构建便携镜像 `bld_4fc20640e91bbb56`（clean、633 文件 MANIFEST）、安装器 `bld_0707cfc0cf2954c9`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-1.0.1-x64.exe` **160,479,283 字节** SHA256 `90224507bdede1a399ff047f316a6d7ab859c1e85ae583b9329e0043228d9f4c`，未签名；本记录提交后推送 `main`（`9c69bd5` + 记录提交）、创建 tag `v1.0.1` 与 GitHub Release「众说 1.0.1」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/1.0.1.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。见 [R209](../reviews/r209-manual-homepage-1.0.1-20261108.md)。


## 2026-11-08：R208 1.0 发布准备——头像按钮靠右、README/产品主页更新（1.0.0）

用户要求设置页「我的头像」上传/恢复按钮靠右，并更新 README 和首页准备按 1.0 发布。实现：`r170-settings.css` 增加 `.settings-card [data-zs-avatar-picker] > .row { justify-content: flex-end; }`，按钮组与控件列右缘对齐（capture 实测 ≤1.5px）。README：状态徽章 beta→1.0、新增 1.0 下载入口与「下载安装」小节（Windows 10/11、当前用户、未签名提示）、快速开始改为下载优先、页脚 1.0 正式版。产品主页 `site/index.html`：首屏 eyebrow 加 1.0 正式版、主按钮改下载 Windows 版（v1.0.0 资产）、顶栏「从源码开始」→「下载 1.0」、开始使用改为下载优先并保留源码构建（`make-windows-installer.mjs`）、页脚改为 1.0 已发布；`site/README.md` 文案边界同步。版本：package/release 均 `1.0.0`，Windows 文件版本 `1.0.0.65535`，安装包名 `Zhongshuo-Setup-1.0.0-x64.exe`。验证：`capture-r207-settings-layout.cjs` 9/9（新增头像按钮靠右检查；其余无状态小字/行高/间距/版本名继续通过），README/主页静态检查无 beta/0.1.3/持续开发残留，设置相关测试与全量回归见交付。交付：程序提交 `ecf8d30`；干净 worktree `dist/r208-source` 构建便携镜像 `bld_098eac201e6f7b39`（clean、633 文件 MANIFEST）、安装器 `bld_1f1a9083853937ff`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-1.0.0-x64.exe` **160,453,097 字节** SHA256 `e35b576a9612aaff0f0a28298206a55f8778b4bd7da3b2c189d2d090b9d7fa9c`，未签名；本记录提交后推送 `main`（`ecf8d30` + 记录提交）、创建 tag `v1.0.0` 与 GitHub Release「众说 1.0.0」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/1.0.0.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。见 [R208](../reviews/r208-release-1.0-readme-homepage-20261108.md)。


## 2026-11-08：R207 设置页去状态小字 + 重新排版（beta.52）

用户追加要求去掉「当前显示「你」」「已开启」「当前上限…」等状态小字，并把版本名称「众说 · 本地多成员协作工作台」改为「众说 · 本地多Agent协作工作台」，同时指出连续删文字后排版有问题。实现：`ViewerNameRow` 删状态 span（data attr 保留）；三个 Switch 的可见 label 换 `visually-hidden`（无障碍名保留）；`ExecutionConcurrencyPanel` 删当前上限/读取中/尚未确认状态行（保留错误、只读、保存状态）；`ArchiveManager` 嵌入设置时隐藏计数、空归档只显示「没有归档内容」并折叠空筛选行；版本名改「本地多Agent协作工作台」。重排：r170-settings.css R207 规则——行 `align-items:center;min-height:46px;padding:9px 20px`，标签纵向居中；头像/归档/诊断大控件行 `:has()` 顶部对齐并去掉 AvatarPicker 底 margin；分区头 padding 12/8，分区 margin 归零留 18px gap；嵌入并发面板 margin 0、行高 42；归档空筛选折叠。测试：新增 `scripts/capture-r207-settings-layout.cjs` 7/7（无状态小字、无开关文字、简单行中心偏差≤2px/行高≤80、头像行≤130、分区头≤52、分区间距≤36、四张分区截图 `dist/r207-ui/r207-layout4/`）；`settingsSinglePageR157`、`callBudgetSettingsR98`、`executionConcurrencyR153` 21 项通过，R153 helper 同步去掉「读取中/当前上限/来自启动设置」依赖；回归 capture-r204 41/41、r203 7/7、r201 21/21、r193 25/25、r195 41/41、r197 23/23；hifi tsc 0；已跟踪全量通过。交付：版本升 `0.1.3-beta.52`（`0.1.3.52`）；程序提交 `2d99ebd`；干净 worktree `dist/r207-source` 构建便携镜像 `bld_5de1b77f4fc80ca3`（clean、633 文件 MANIFEST）、安装器 `bld_d87befbdf6c715e4`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.52-x64.exe` **160,455,507 字节** SHA256 `e5cddf5e5854df9eede6d1a7439a19baab884fe04cf0a121036a10b9b75e8d67`，未签名。本记录提交后推送 `main`（`2d99ebd` + 记录提交）、创建 tag `v0.1.3-beta.52` 与 GitHub Release「众说 0.1.3-beta.52」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.52.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。见 [R207](../reviews/r207-settings-status-layout-20261108.md)。


## 2026-11-08：R206 设置页行内小字说明全部移除（beta.51）

用户追问上一版删少了：「浅色、深色随时切换」「默认显示个人和 AI 头像，姓名始终保留」「聊天里你自己那一侧显示这张；AI 成员头像在成员管理里设置」等设置行内小字仍在。实现：`SettingsPage.tsx` 删除全部 `SettingsRow hint`（外观/通知/AI/数据/帮助 12 处）、`ViewerNameRow` hint、`APP_LINKS` 的 hint 字段；`AvatarPicker` 新增 `hideHint`（设置页我的头像不再显示 PNG/384KB 小字）；`ExecutionConcurrencyPanel` 删除主 hint、三项上限 hint 与执行规则说明（保留当前上限/错误/只读/保存状态）；`LocalDiagnostics` 删除「只在本机读取…」；`CallBudgetSettingsRow` 删除「默认上限…」可见小字并把 `data-zs-call-budget-defaults` 移到外层容器属性（数值不变）。状态/结果/错误/placeholder 属于功能反馈，保留。测试：`settingsSinglePageR157.test.ts` 新增无行内小字合同、`callBudgetSettingsR98.test.ts` 改为默认上限只保留数据属性；`scripts/capture-r205-settings-copy.cjs` 扩展为 28/28（无 pset-row-hint/field-hint、21 条示例文案消失、分区标题与按钮/状态仍在、数据分组无草稿、清理存储保留）。截图 `dist/r205-ui/r206-v1/`。回归 capture-r204 41/41、r203 7/7、r201 21/21、r193 25/25、r195 41/41、r197 23/23；hifi tsc 0；已跟踪全量通过。交付：版本升 `0.1.3-beta.51`（`0.1.3.51`）；程序提交 `1a05aea`；干净 worktree `dist/r206-source` 构建便携镜像 `bld_bd3609c2785c7aff`（clean、633 文件 MANIFEST）、安装器 `bld_cb5bf6901591ce1c`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.51-x64.exe` **160,438,179 字节** SHA256 `2b5d2f11eca19c0bfe0b9f750111b14b2dd66c5a18b502b2855483ace9896fc9`，未签名。本记录提交后推送 `main`（`1a05aea` + 记录提交）、创建 tag `v0.1.3-beta.51` 与 GitHub Release「众说 0.1.3-beta.51」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.51.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。见 [R206](../reviews/r206-settings-hints-removed-20261108.md)。


## 2026-11-08：R205 设置页去小字文案 + 去草稿设置（beta.50）

用户要求去掉设置页的小字文案（示例：页头「外观、通知、AI、数据与帮助都在这一页；改动会即时保存并回读确认。」、外观分区「主题、头像和名字；只在本机生效。」）并去掉草稿的几个设置。实现：`SectionShell` 删除 `sub` 参数与 `<p class="settings-section-sub">`（5 个分区说明全删），页头 `.page-sub` 删除（保留标题/搜索/chips）；数据分区的「草稿」组整组删除——草稿保存状态、恢复提示、重试/清理（重试保存、清理本地草稿+确认弹窗）；「清理存储」（回收变更前像/过期回执，不是草稿）保留并移入「数据位置与备份」；搜索索引删除两条草稿条目、新增「清理存储」。草稿后端保存/恢复逻辑不变，只去掉设置页展示与手动清理入口。设置行 hint 保留（选项功能解释，不属装饰小字）。验证：新增 `scripts/capture-r205-settings-copy.cjs`（13/13：无页头/分区小字、六条示例文案不再出现、五分区标题仍在、无草稿组/行、清理存储保留、数据分组完整），截图 `dist/r205-ui/r205-v1/`；`settingsSinglePageR157.test.ts` 更新为 14 项通过；回归 capture-r204 41/41、r203 7/7、r201 21/21、r193 25/25、r195 41/41、r197 23/23；hifi tsc 0；已跟踪全量通过。交付：版本升 `0.1.3-beta.50`（`0.1.3.50`）；程序提交 `39afca8`；干净 worktree `dist/r205-source` 构建便携镜像 `bld_c15575e6a3046a1d`（clean、633 文件 MANIFEST）、安装器 `bld_512a86e0e0331d45`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.50-x64.exe` **160,453,993 字节** SHA256 `9c077db1c5071cd0154e18fad14d3acb7d16a4a47ded9f635e7b4856b83683e4`，未签名。本记录提交后推送 `main`（`39afca8` + 记录提交）、创建 tag `v0.1.3-beta.50` 与 GitHub Release「众说 0.1.3-beta.50」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.50.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。见 [R205](../reviews/r205-settings-copy-drafts-20261108.md)。


## 2026-11-08：R204 设置页「我的名字」行排版（beta.49）

用户截图反馈「设置里排版有问题」：外观区「我的名字」行的输入框/保存按钮比其它行更靠右、贴到卡片边缘。根因：设置行统一横向内边距由 `.settings-card-body > .pset-row { padding:13px 20px }` 提供，但名字行包在 `<div data-zs-viewer-name>` 里，不是 `.settings-card-body` 直接子级，规则未命中 → 行退回 `.pset-row` 默认 `padding:10px 0`，控件右缘=卡片内容右缘（1324 实测 1219 vs 主题行 1199，差 20px）。修复：`r170-settings.css` 增加 `.settings-card-body > [data-zs-viewer-name] > .pset-row { padding:13px 20px }`，窄窗（≤760px）同选择器收窄 14px；不改行基元/控件结构/数据逻辑。验证：新增 `scripts/capture-r204-settings-ui.cjs`（隔离 Electron，7 个宽度 41/41：控件不越界、按钮与主题行右对齐、行内边距 20/14、输入与按钮同行），截图 `dist/r204-ui/r204-final/`；新增 `tests/integration/r204SettingsLayout.test.ts`（2 项）；hifi tsc 0；已跟踪全量通过。交付：版本升 `0.1.3-beta.49`（`0.1.3.49`）；程序提交 `c683df1`；干净 worktree `dist/r204-source` 构建便携镜像 `bld_e20d703c604e684f`（clean、633 文件 MANIFEST）、安装器 `bld_0e64d0430289e5d8`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.49-x64.exe` **160,461,460 字节** SHA256 `1111f3f2903cc6130391e017add693fccecad7db0ad57993fd42c9083b24a28e`，未签名。本记录提交后推送 `main`（`c683df1` + 记录提交）、创建 tag `v0.1.3-beta.49` 与 GitHub Release「众说 0.1.3-beta.49」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.49.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。见 [R204](../reviews/r204-settings-name-row-layout-20261108.md)。


## 2026-11-08：R203 成员管理 AI 卡片直达「AI 设置」（beta.48）

用户截图反馈：点击成员管理里的 AI 成员卡片会进入单独的「Codex 配置 / 成员详情」页，要求去掉中间页、点卡片默认跳转 AI 设置。诊断：卡片 onClick/Enter 导航到 `/project/:id/member/:memberId`（MemberDetailPage），而卡片上原本的「AI 设置…」按钮已打开同一个 `BindRuntimeModal`（名称/说明 + 渠道/模型/执行程序/权限），详情页其余功能（停用、模板、返回）卡片上也都有。修复：`MembersPage.tsx` AI 卡片点击（含标题/工作量区域）直接 `openBind(m)`，title 改为「打开 X 的 AI 设置」；人类成员卡片只读；归档/移除时不打开。`App.tsx` 删除 MemberDetailPage 导入与页面，旧深链 `/project/:id/member/:memberId` 重定向 `/project/:id/members`，侧栏成员选中态只匹配 `/members`；删除 `src/ui/hifi/pages/MemberDetailPage.tsx`；命令面板成员条目改为进入成员管理页。手册第 6/12 节改为「点对应成员卡片（或卡片上的 AI 设置…）直接打开 AI 设置」并重新生成 index.html。测试：`tests/browser/memberChannelsR136.test.ts` 改为成员卡片打开 AI 设置（断言 46→47），新增 `tests/integration/r203MemberSettings.test.ts`（4 项）、`scripts/capture-r203-ui.cjs`（7/7）——点击后仍在 `/members`、无详情页、弹出 AI 设置、旧深链重定向，截图 `dist/r203-ui/r203-v6/`。回归：capture-r201 21/21、r193 25/25、r195 41/41、r197 23/23；hifi tsc 0；已跟踪全量测试见交付记录。交付：版本升 `0.1.3-beta.48`（`0.1.3.48`）；程序提交 `fe56893`；干净 worktree `dist/r203-source` 构建便携镜像 `bld_cc3181c6c7cef99c`（clean、633 文件 MANIFEST）、安装器 `bld_d30809365a039de5`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.48-x64.exe` **160,451,966 字节** SHA256 `3c8eedd748d0d4960f8c9b2155d4f5b36809970f9c3d55feeae1d57a8079f4d8`，未签名。本记录提交后推送 `main`（`6bc5a14` + `fe56893` + 记录提交）、创建 tag `v0.1.3-beta.48` 与 GitHub Release「众说 0.1.3-beta.48」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.48.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。


## 2026-11-08：R202 独立代码审计（Codex gpt-6.1-sol/xhigh）+ 修复；beta.47

用户要求「让 codex 子代理让 gpt-6.1-sol /xhigh 做代码审计，并且修复，没问题就打包发版」。Codex 子代理在独立 worktree/分支 `dist/r202-audit`（HEAD 为 beta.46 `4538a42`）完成审计，确认 4 个问题并修复；它受环境限制无法写 worktree Git 索引，主控代提交 `9455277`、复核后合并 `7617788`。

审计发现与修复：F1 P1 Markdown 标签可伪装本机文件真实扩展名（`[报告.pdf](file:///C:/x/run.cmd)` 显示假名、点击执行 run.cmd）→ 本地文件条目始终显示真实路径 basename；F2 P2 `file:` URL 手工解析错误（localhost/查询串/fragment/编码/无效输入）→ 改用 URL 解析，拒绝无盘符相对路径、非法编码、编码分隔符等，不再伪造 UNC；F3 P1 图片副本目录 junction 可越界写入 → `attachment.absolutePath` 写入前 realpath 校验目录、lstat/realpath 校验目标、原子替换且保留旧副本/硬链目标；F4 P2 同大小图片篡改未检测 + 前端永久缓存 → 副本字节一致才复用（否则原子重建），前端只合并在途请求、完成即释放缓存。新增 `tests/browser/localFileLinksR202.test.ts`、`tests/browser/imageAttachmentPathsR202.test.ts`，增强 `tests/integration/imageAttachmentPathR197.test.ts`（真实 junction/同大小篡改/硬链保护）。审计报告：`docs/reviews/r202-audit-findings-20261108.md`（含主控复核附录）。

主控复核（正常权限环境）：定向 4 文件 22 项通过；已跟踪全量 382 文件（380 通过/2 跳过；3410 通过/3 预期失败/16 跳过/0 失败，约 239 秒）；根 tsc 0、hifi tsc 0、build-ui/pack-daemon 通过；界面回归 capture-r201 21/21、r193 25/25、r195 41/41、r197 23/23。Codex 报告中的 187 项失败来自其受限环境（权限/Electron GPU），非产品回归。

交付：版本升 `0.1.3-beta.47`（`0.1.3.47`）；程序提交 `9455277`（审计修复）+ 合并 `7617788`；干净 worktree `dist/r202-source` 构建便携镜像 `bld_5f29966fcc5e5ddd`（clean、633 文件 MANIFEST）、安装器 `bld_1f9c41178db9937c`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.47-x64.exe` **160,445,635 字节** SHA256 `d0303ec076896a07ab41047bbcf3cf479db2ba8f55cebb60ed3c5def35d51981`，未签名。本记录提交后推送 `main`（`91ecc23` + 记录提交）、创建 tag `v0.1.3-beta.47` 与 GitHub Release「众说 0.1.3-beta.47」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.47.md`）；用户自行安装。未安装/升级/卸载、未操作用户数据、未调用真实模型。


## 2026-11-08：R201 界面反馈 6 条（beta.46）

用户带截图反馈 6 条，全部修复并用隔离 Electron 截图验证：①「打开新的工作区」按钮 hover 底色错位（根因：`.side-heading button` 未清通用 button 的 6px/12px padding，20px 盒被撑成 24 宽、图标偏右；修复 `padding:0;flex:none`，实测按钮 20×20、图标/hover 同心 219=219）；②按钮 tooltip 改为「打开新的工作区」；③标题栏删除「当前项目 ▾」项目下拉（TitleBar 删 ProjectMenu/关联状态/ref，titlebar.css 删 `.zs-tb-project*` 规则；项目切换走侧栏）；④命令面板删除「退出键」按钮、「回车键」标签与 placeholder 键盘提示（键盘行为保留）；⑤LiveProgress 活动行单行：长文本 `.live-progress-activity-text` 省略、`.live-progress-ago` nowrap，实测单行 18.7px；⑥`file:///` 本地文件链接只显示文件名：新增 `src/ui/hifi/lib/localFileHref.ts`（仅 file: 绝对路径，盘符/UNC/百分号编码），MarkdownView 渲染 `LocalFileLink`（左键默认程序打开，右键复制文件地址/默认程序打开/文件管理器中显示/其它打开方式），不再出现原始地址或 `!`。

验证：新增 `scripts/capture-r201-ui.cjs`（21/21：按钮几何与 hover、tooltip、标题栏、命令面板、两个 file:/// 链接右键复制到绝对路径、LiveProgress 单行）+ `tests/integration/r201UiFeedback.test.ts`（file:/// 解析 5 例 + 源码合同）；`r90TitlebarButtonContract` 更新为无项目下拉合同；`capture-r193` 25/25、`capture-r195` 41/41、`capture-r197` 23/23 复跑通过；hifi tsc 0；已跟踪全量测试 379 文件执行 377 通过/2 跳过、3394 通过/3 预期失败/16 跳过/0 失败。未安装/升级/卸载、未操作用户数据、未调用真实模型。

交付：版本升 `0.1.3-beta.46`（`0.1.3.46`）；程序提交 `31a6f66`；干净 worktree `dist/r201-source` 构建便携镜像 `bld_c0c51f487c8b5862`（clean、633 文件 MANIFEST）、安装器 `bld_c41c359aa2386e1c`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.46-x64.exe` **160,467,484 字节** SHA256 `112520278f9a5946ed679b2fc273ba20aa3258a0ce78d6b67da283716e289ef2`，未签名。本记录提交后推送 `main`（`31a6f66` + 记录提交）、创建 tag `v0.1.3-beta.46` 与 GitHub Release「众说 0.1.3-beta.46」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.46.md`）；用户自行安装。见 [R201](../reviews/r201-ui-feedback-20261108.md)。


## 2026-11-08：R200 对话串页签简化 + 串内成员管理（另一 AI 改动，主控提交打包；beta.45）

用户：「另一个 ai 也修改了代码，你一起帮他提交打包吧」。工作区有另一 AI 完成的未提交改动（7 个已跟踪文件 + 1 张新手册截图），主控未改其设计，原样提交并在干净 worktree 复验后打包。

改动：`src/ui/hifi/lib/threadNav.ts` + `src/ui/hifi/pages/Room.tsx`（-478 行）把对话串常驻页签收敛为 **回复 / 成果（讨论串为附件）/ 参与成员**，移除「详情」页签与内部分组（任务概况/活动与进展/运行详情/研讨记录）；串顶任务状态条、继续/结束任务与成果确认入口保留；旧 `?tab=task/activity/run/deliberation` 深链落到「参与成员」，`?tab=delivery` 仍打开成果确认。新增「参与成员」页（`data-zs-thread-members`）：列出本串成员、可「移出」「添加到本串」，写入走既有 `thread.members.change` 的 expectedVersion 版本核对（CAS 冲突刷新重试），成员页只读名单不加载任务详情，移出成员不再收本串后续消息。用户手册第 4/6/12 节按新页签改写、新增 `images/26-thread-members.png`、更新 `images/08-progress.png` 并重新生成 `index.html`；`tests/browser/helpers/r153ProductNavigation.cjs` 更新为新导航断言（成员页、版本号 v1→v2、交付仍在成果下、成员页不读 task.details）；`scripts/lib/user-guide-scenes.js` 第 8/26 场景改为新界面。

验证：已跟踪全量测试（含更新后的 R153 helper）**379 文件执行，377 通过/2 跳过；3394 通过/3 预期失败/16 跳过/0 失败**（`--maxWorkers=4`，约 236 秒）；隔离 Electron 界面回归 `capture-r193-ui.cjs` 25/25、`capture-r195-ui.cjs` 41/41、`capture-r197-ui.cjs` 23/23（证据 `dist/r19x-ui/r200/`）；干净 worktree `dist/r200-source`（`ac912d9`，dirty=false）根 tsc 0、hifi tsc 0、`build-ui`/`pack-daemon` 通过、单元+浏览器 140 文件/994 项通过。未在本机安装/升级/卸载、未操作用户数据、未调用真实模型。

交付：程序提交 `ac912d9`（10 文件，提交说明注明原样来自另一 AI 工作区），版本升 `0.1.3-beta.45`（`0.1.3.45`）；干净 worktree `dist/r200-source` 构建便携镜像 `bld_72b5d4d92176992c`（clean、633 文件 MANIFEST 逐项 SHA256）、安装器 `bld_f774d3f688aa2d15`（670 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.45-x64.exe` **160,445,224 字节**，SHA256 `b8f02d1e614b6bbfca913859232da624cbe9033c5f69d5adac4d957ec2ddb0d5`，未签名。本记录提交后推送 `main`（`ac912d9` + 记录提交）、创建 tag `v0.1.3-beta.45` 与 GitHub Release「众说 0.1.3-beta.45」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.45.md`）；用户自行安装。见 [R200](../reviews/r200-thread-tabs-members-20261108.md)。


## 2026-11-08：R199 侧栏「文件与 Git」图标改清晰文件图标（beta.44）

用户发侧栏截图问「文件和 git 的图标是不是有问题」。诊断：该入口此前复用 `diff` 图标（两条竖线 + 两个小圆环 + 折线的分支/差异示意图），14px 侧栏尺寸下线宽 1.8、圆环压成小点，看起来像残缺笔画；且表达「差异」而非「文件」。渲染几何实测 14×14，未被压缩/裁切，属图形选择问题。修复：`src/ui/hifi/App.tsx` 侧栏「文件与 Git」改用 `file-text`（与文件页「文件」页签同一图形），其余图标/名称基线/hover/选中态/导航不变；`diff` 仍用于差异/Git 页面语义位置。验证：`capture-r193-ui.cjs` **25/25**（图标 x=32、名称列、选中条 3px 贴左缘、工作区标题固定、无溢出），截图 `dist/r193-ui/r193-icon-fix/02-sidebar.png`、放大证据 `dist/sidebar-files-icon-new.png`；hifi tsc 0、build-ui/pack-daemon 通过；干净 worktree 根 tsc 0、全量套件与安装包复验见下。交付：版本升 `0.1.3-beta.44`（`0.1.3.44`）；程序提交 `bd281eb`；干净 worktree `dist/r199-source` 构建便携镜像 `bld_71d44b3e1c3e522e`（clean、632 文件 MANIFEST）、安装器 `bld_048ed97dd1f39457`（668 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.44-x64.exe` **160,492,378 字节**，SHA256 `f3febff4b22a905b12628c3bbf9dbece952f24bce42bf4dfb71c615d25358983`，未签名。本记录提交后推送 `main`（`bd281eb` + 记录提交）、创建 tag `v0.1.3-beta.44` 与 GitHub Release「众说 0.1.3-beta.44」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.44.md`）；用户自行安装。未在本机安装/升级/卸载、未操作用户数据、未调用真实模型。见 [R199](../reviews/r199-sidebar-files-icon-20261108.md)。


## 2026-11-08：R199 对话串隐藏详情，直接保留参与成员（源码未打包）

用户要求隐藏对话串详情，只保留截图红框中的本串成员名单。顶部入口由「详情」改为「参与成员」，点击直接显示本串名单、实时状态、移出与添加操作；删除任务概况/活动与进展/运行/研讨的分组导航及「实际执行成员」、任务详情更新时间和刷新栏，不再为成员页挂载 task.details 轮询。旧 task/activity/run/deliberation tab 链接兼容落到成员页。成果确认/修改、交付历史与子任务定位继续由成果入口或原交付/子任务深链进入，显示成果选中态，不恢复详情分组；任务继续/结束与状态提示沿用统一状态条。成员 CAS、权限与运行数据不变。

验证：更新既有 R153 隔离界面验收，覆盖旧链接落到成员页、没有详情文案和额外详情读取、移出/重新添加使用最新版本、交付仍可达；纳入单元/浏览器回归 **140 文件 / 994 项全部通过**（node node_modules/vitest/vitest.mjs run tests/browser tests/unit --maxWorkers=4）。hifi tsc 通过、build-ui 通过（既有 import.meta/CJS 警告保留）；ESLint 相对 HEAD 同为 Room.tsx 的 12 条既有错误，无新增；diff-check、两份修改脚本语法检查通过。隔离真实 daemon + 假运行时重新截图成员页与任务状态页（dist/user-guide-capture/run-f6686b42、run-0b6677a5），已人工查看截图；手册 README/index.html 与 08-progress/26-thread-members 图片同步。R153 浏览器证据在 dist/r153-product-navigation/（ignored）。

交付范围：源码与手册，版本仍 0.1.3-beta.43，尚未提交/推送或制作新安装包；未安装/升级、未操作用户运行数据、未调用真实模型。

## 2026-11-08：R198 Windows 通知图标黑块真正根因（AUMID 注册表键）与 beta.43

用户安装 beta.42 后回复「问题还在」，通知头部仍是黑色方块（正文品牌小图正常）。beta.42 的 ICO DIB 修复经本机对照证明图标文件本身正确（系统图标 API 取 32×32 与 logo 逐像素一致、PE 图标 Frames=7/Verified=true、快捷方式/注册表/exe 都指向新图标）。本机用系统通知做对照：①AUMID 注册表键存在（IconUri=ICO/PNG/exe 三种都试）→ 黑块/占位字形/不显示；②删掉 `HKCU\Software\Classes\AppUserModelId\com.zhongshuo.desktop.app` 整键后用真实 AUMID 发同一条通知 → 同一快捷方式、同一图标，「众说 + 品牌图标」正常。结论：Toast 平台只要看到该 AUMID 键就优先用 IconUri/注册表显示名，而不是快捷方式图标；旧版本每次启动都会写这个键（R162 起），所以升级后黑块持续。证据：`dist/r198-before-black.png` / `dist/r198-after-logo.png`（ignored，系统通知截图裁剪）。

实现：`src/ui/windowsAppIdentity.ts` 用 `windowsNotificationIdentityReset(appId)`（仅限 `com.zhongshuo.*`，生成 `reg delete HKCU\Software\Classes\AppUserModelId\<AUMID> /f`）取代 `windowsIdentityRegistration`；`src/ui/main.ts` 安装版启动调用重置（键不存在时失败静默忽略），不再写 DisplayName/IconUri；`packaging/windows/zhongshuo.iss` 删除 [Registry] 两条写入，快捷方式仍带 AppUserModelID 与品牌图标（通知名称/图标由「众说」快捷方式提供，对照已验证）；通知正文品牌图、点击激活、任务通知逻辑不变。`tests/unit/windowsIdentityR163.test.ts` 改为断言只删本应用 scoped 键、非法 AUMID 拒绝、main 不再写 AUMID DisplayName/IconUri；安装器快捷方式 AUMID 断言保留。

验证：本机系统通知对照（修前黑块/删键后众说+品牌图标）；定向 3 文件 15 项通过；hifi tsc 0、根 tsc 29 条既有本机未跟踪夹具错误（本版 0 新增）；全量已跟踪套件与干净 worktree 构建复验见下。未在本机安装/升级/卸载，未在安装版上实测升级后第一条通知。

交付：版本升 `0.1.3-beta.43`（`package.json`、`packaging/windows/release.json`，numericVersion `0.1.3.43`）；程序提交 `5a095d7`；干净 worktree `dist/r198-source` 构建便携镜像 BUILD `bld_78d3bb1f94d5ef83`（clean、632 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_4963e33c797e994d`（安装镜像 668 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.43-x64.exe` **160,491,524 字节**，SHA256 `b0c2d0aa4e20e8ace178ac336945c212bf8999d43d1b71b6f9aa87c8beac7013`，未签名，附 `.sha256`/`.release.json`。本记录提交后推送 `main`（`5a095d7` + 记录提交）、创建 tag `v0.1.3-beta.43` 与 GitHub Release「众说 0.1.3-beta.43」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.43.md`）；用户自行安装。见 [R198](../reviews/r198-notification-identity-20261108.md)。


## 2026-11-08：R197 图片气泡 / 图片绝对路径 / 右键复制 / 通知图标黑块（beta.42）

用户 2026-11-08 基于已安装 beta.41 发来五项截图反馈：①图片气泡上方空出一大截（并要求修改前端后自己截图核对）；②引用只能引文字、图片不能引用，要求引用内容含图片时附上图片绝对路径；③复制带图片的消息只复制图片名称，要改成绝对路径；④Windows 通知图标显示成黑图；⑤图片右键不能复制，要求添加复制功能。

实现：**①气泡贴合**——`MessageView` 对「本人 + 空正文 + 有图片附件」输出 `data-zs-image-only="1"`，`r195-message.css` 把该气泡内边距 10/14px 收到 4px、图片网格与附件区上间距归零（含对 `.msg-list.is-replies .msg-human-bubble` 高特异性覆盖）；其余消息不变。**②③图片绝对路径**——新增 daemon 只读命令 `attachment.absolutePath`（audience 同 previewImage、仅 image_file、远程 FORBIDDEN；在 `{appData}/attachment-paths/{hash前16}-{安全化原名≤40}.{ext}` 生成带真实扩展名的**真实副本**——不用硬链，避免按路径改写图片影响内容寻址原件；同大小复用；路径必须落在 appData 内），新 lib `imageAttachmentPaths.ts` 收集图片（正式附件 + fileChanges 带 artifactId 的图片，按 id 去重；项目内图片用 sourcePath 经 absoluteProjectPath，上传图片调新命令并缓存），`[图片] 文件名\n绝对路径` 格式；MessageView.copyMessage、Room 主池复制、Room/Thread 引用、DmPage 引用均追加；**⑤右键复制**——消息图片右键菜单（复制图片 / 复制图片路径，`data-zs-image-menu` / `data-zs-copy-image` / `data-zs-copy-image-path`），共享预览大图右键菜单（复制图片 / 另存原件，`data-zs-preview-image-menu` / `data-zs-copy-image` / `data-zs-copy-image-download`）；新增 main `zs:clipboard.copyImage`（可信来源 + data:image 前缀 + 24MB + nativeImage 解码校验，Electron 44 走 W3C `clipboard.write([ClipboardItem])`）+ preload `window.zsClipboard.copyImage`，失败回退 canvas+浏览器剪贴板与中文 toast。**④通知图标**——根因：`scripts/lib/brand-icon.ps1` 把 ICO 7 帧全写成 PNG 压缩帧，Windows 通知身份图标/AUMID `IconUri` 与经典图标 API 按 DIB 解析 → 黑块/噪点；改为传统 BMP/DIB 帧（BITMAPINFOHEADER + 32bpp BGRA + AND 掩码），新增 `scripts/verify-brand-icon-r197.cjs` 三层校验。用户手册「发附件」补充图片右键复制、复制/引用带完整路径、图片-only 气泡说明，`index.html` 重新生成。

验证：新增 `scripts/capture-r197-ui.cjs`（隔离数据 + 假运行时 + 真实 daemon；新增 `scripts/lib/r197-extra-images.ts` 造图片-only 消息）**23/23 断言通过**——气泡内边距 4px/图片顶距 5px、复制消息剪贴板含绝对路径且文件存在、消息图片右键写入系统剪贴板图片、右键路径落盘、引用含 `[图片]`+绝对路径（文件存在）、预览右键菜单在可视层最上方且复制成功、房间主池复制带路径、品牌 ICO 7 帧全 DIB/32bpp/高度=2×宽；截图 `dist/r197-ui/r197-verify7/`。`verify-brand-icon-r197.cjs` **145 项通过**（System.Drawing 32×32 与 logo 距离 0、Electron nativeImage 非空、修复前对照 mean 59.47/max 220.33）；`build-ui`+`pack-daemon`+`pack-desktop` 通过、PE 复核 Frames=7/Verified=true、产物 EXE 关联图标距离 0。新增 `tests/integration/imageAttachmentPathR197.test.ts` 6 项；已跟踪全量 380 文件请求/379 执行 **377 通过/2 跳过；3393 通过/3 预期失败/16 跳过/0 失败**（`--maxWorkers=4`，约 236 秒）；hifi tsc 0、根 tsc 维持既有 29 条本机未跟踪夹具错误、eslint 无新增。截图 harness 关闭 CSS 动画（隐藏窗口动画停在首帧会拍到 opacity 0），不改产品样式。

交付：版本升 `0.1.3-beta.42`（`package.json`、`packaging/windows/release.json`，numericVersion `0.1.3.42`）；程序提交 `9d797f7`；干净 worktree `dist/r197-source` 构建便携镜像 BUILD `bld_e4675a2e79e5f8fe`（clean、632 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_427e44bbcb9e533a`（安装镜像 668 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.42-x64.exe` **160,489,293 字节**，SHA256 `ee47fa06f66ca584e21f889fdc06377f1e8b07971b50ab44ec2ffb26247eb5f5`，未签名，附 `.sha256`/`.release.json`。本记录提交后推送 `main`（`9d797f7` + 记录提交）、创建 tag `v0.1.3-beta.42` 与 GitHub Release「众说 0.1.3-beta.42」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.42.md`）；用户自行安装。未在本机安装/升级/卸载、未操作用户程序与运行数据、未调用真实模型；未实机验证 Windows toast 最终显示（图标格式与 PE 校验已通过，AUMID 图标缓存可能需刷新）、未验证 >24MB 图片复制降级。见 [R197](../reviews/r197-images-paths-notification-20261108.md)。


## 2026-11-08：R196 后端审计修复落地 + 未提交改动收口 + beta.41 发版

用户 2026-11-08：「我让 gpt 审计后修复完了 bug，你把现在所有没提交的一起提交，并且打包发版。」本轮把 GPT 审计修复（请求材料边界、停止后继续保留原成员/模式）、此前一直未提交的侧栏「工作区」改动与相关文案，全部提交并打包发版；审计第 1 项「历史图片随上下文发送」经用户复核符合「全部带图」的既定产品决定，保持现状。

实现：`turnInput.ts` 缺少显式线程水位时固定到任务根消息序号（主池根消息按串内 0），不再读取实时串尾，DELIBERATE 每阶段按所绑定请求的 `input_thread_seq` 装配，提醒按完整派发键绑定当前唤醒消息及序号，协作子任务通过协调运行的正式附件来源保留规划/交接完整详情；`threadReplies.ts` 新增 `selectStoppedThreadRecipients`（按最后实际运行定位请求、路由与候选范围，覆盖协调整合/自动恢复/格式补交来源），`commands.ts` 的正式继续动作与未显式重新指定成员/模式的普通续接共用该选择，保留原成员、模式与研讨子集、忽略未执行后续队列；原成员停用/移出时原子拒绝并整体回滚，显式重新选择可继续；`dispatchWorker.ts` 同步提醒与 DELIBERATE 边界。侧栏：工作区标题固定在导航与滚动列表之间，打开/切换入口收进标题右侧（新增 `folder-plus` 图标），删除旧底部「打开/切换项目」条目，`capture-r193-ui.cjs` 增加 24 项相关断言（标题固定、按钮含图标、旧入口移除、滚动时标题不动）；成员管理/看板/文件页空态与手册「切换项目」文案同步。审计回归新增 `tests/integration/backendAudit20261108.test.ts`（10 项）纳入默认套件，`reminderBoundary` 增补「后来提交的请求不进入已创建提醒输入」；独立入口保留 `scripts/audits/backend-20261108.*`。未改 schema 61、权限/audience、图片能力门与旧信封/停止代次语义。

验证：已跟踪全量测试 + 新增回归 **378 文件 / 3387 通过 / 3 预期失败 / 16 跳过 / 0 失败**（`--maxWorkers=4`，约 222 秒；排除默认禁用的 GitHub 远端沙箱与 Word COM 验收）；干净 worktree 复跑单元+浏览器+审计回归 **142 文件 / 1011 项通过**；干净 worktree 根 `tsc --noEmit` 0 错、hifi tsc 0 错、`build-ui`/`pack-daemon` 通过；干净 worktree 内 `capture-r195-ui.cjs` **41/41**、`capture-r193-ui.cjs` **25/25**（侧栏工作区几何/滚动断言全过）。审计报告自身的修复后验证（新增对抗回归 10/10、关联 4 文件 76 项、扩大回归 377 文件 3385 通过/16 跳过/0 失败）见 [审计报告](../reviews/backend-audit-20261108.md)。

交付：程序提交 `ed51d34`（23 文件：daemon 4、hifi 侧栏 7、daemon 审计回归 2、审计报告/入口 3、手册与版本文件等），版本升 `0.1.3-beta.41`（`package.json`、`packaging/windows/release.json`，numericVersion `0.1.3.41`）；此前 R195 拆分提交时保留在工作区的侧栏「工作区」改动与文案本轮全部提交，工作区不再保留产品代码改动；仍只有此前各轮标注为「本机未跟踪」的 R130/R131/R180 混沌套件、夹具与历史审计报告未提交（依赖本机历史数据，进入默认套件会在干净环境失败，保持未跟踪、未进包）。干净 worktree `dist/r196-source`（`ed51d34`，status 0，dirty=false）构建：便携镜像 BUILD `bld_442c3de79ddbffaa`（clean、632 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_c809db5b12a4bc3b`（安装镜像 668 文件 MANIFEST 逐项 SHA256；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.41-x64.exe` **160,216,471 字节**，SHA256 `a8a9a14bae78e6c03a6e5e479a49018eb07c39a086d35064872b48b44120bb06`，未签名，附 `.sha256`/`.release.json`。本记录提交后推送 `main`（`ed51d34` + 记录提交）、创建 tag `v0.1.3-beta.41` 与 GitHub Release「众说 0.1.3-beta.41」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.41.md`）；用户自行安装。未在本机安装/升级/卸载、未操作用户程序与运行数据、未调用真实模型。见 [R196](../reviews/r196-backend-audit-release-20261108.md)。

## 2026-11-08：后端审计修复——请求材料边界与停止后的原成员续接（源码，未打包；已随 R196 提交发版）

用户复核本轮审计：第 1 项历史图片随上下文发送符合“已去掉仅发送文字、全部带图”的产品决定，保持现状并撤回缺陷判定；授权修复第 2 项后续排队附件提前进入前一轮输入、第 3 项停止后继续会更换执行成员或扩大研讨名单。

实现：`turnInput.ts` 未传显式线程水位时固定到任务根消息序号（主池根消息为串内 0），不再用实时串尾；`dispatchWorker.ts` 为 DELIBERATE 各阶段传入所绑定请求的 `input_thread_seq`，提醒按完整派发键绑定当前唤醒消息及序号；协作子任务通过协调运行的正式附件来源保留规划/交接完整详情。`threadReplies.ts` 新增 `selectStoppedThreadRecipients`，根据最后实际运行找到原线程请求、路由和候选范围，覆盖协调整合/自动恢复/格式补交来源；`commands.ts` 的正式继续动作及未显式重新指定成员/模式的停止后消息续接共用该选择，保留原成员、模式和研讨子集，忽略未执行的后续队列。原成员移出或停用时拒绝并整体回滚，用户可显式重新选择；新派发仍冻结当前配置，不改旧信封、停止代次与旧结果隔离。保留图片直接传递、schema 61、权限/audience 及此前他人未提交的界面文件。

验证：新增正式集成 `tests/integration/backendAudit20261108.test.ts` **10/10 通过**，覆盖当前/未来文字图片、Q2 自身收到附件、历史图片按已确认要求继续传递、私信停止续接对照、按钮/消息两入口保留乙与两人研讨子集、忽略未执行队列、成员停用/移出时原子拒绝与显式更换。原审计脚本转为同一回归的独立入口；`reminderBoundary` 增补排除后来请求。扩大回归首次发现规划详情/提醒来源被新边界排除，已按正式来源补回，相关 **4 文件/76 项通过**。最终已跟踪 unit/browser/integration 加新增回归（默认禁用 GitHub 远端沙箱、排除 Word COM 验收及未跟踪混沌夹具）**377 文件/3385 通过/16 跳过/0 失败**，`--maxWorkers=4`；排除未跟踪夹具的根工程类型检查退出 0，覆盖新回归；ESLint 相对 HEAD 0 新增（`commands.ts` 原有 10 条、`reminderBoundary` 原有 2 条保留，其余本轮文件 0）；diff-check 通过。证据在 ignored `dist/backend-audit-20261108/` 的 `fix-*` 日志/JSON；自有夹具各项 `real_calls=0`，未调用真实模型。

交付范围：源码与测试/文档，版本仍 `0.1.3-beta.40`，未打包、未提交推送、未安装升级或操作用户运行数据；后续安装包需纳入本段源码。详见 [审计及修复](../reviews/backend-audit-20261108.md)。

## 2026-11-08：R195 九项界面反馈（消息图片 / 引用 / 操作条 / Git 提示 / 带鱼屏 / 独立研讨 / 搜索筛选 / 本人名字；beta.40）

用户 2026-11-08 基于已安装 beta.39 发来九项反馈与截图：①对话里图片预览很差（参考聊天截图，应直接显示缩略图）；②房间引用仍直接复制一堆文字，要改成和对话串一致；③对话串/私信引用在消息上方、房间引用按钮在对话串下方，统一到气泡下方；④Git 出现「Git 部分信息读取失败」「读取仓库状态未完成」并带 `fatal: not a git repository`；⑤私信「待我处理」没适配带鱼屏；⑥独立研讨成员界面 DeepSeek Harness 一行和其它成员不一样；⑦搜索「更多筛选」展开后很丑；⑧去掉房间与对话串「⋯」里的「调整独立研讨成员」（已可从「独立研讨·N人」设置）；⑨设置里增加修改用户名字，对话里本人名称都是「你」。口径：只改界面与显示，不改消息/任务合同、schema（保持 61）、权限与 audience，不迁移数据。

实现：**①图片**——`MessageView` 新增 `MessageImages`：正式附件里的图片从文件卡/chip 拆出来直接渲染缩略图（单图原始比例最长边 ≤220px `contain`，多图 104×104 `cover` 网格，点击仍走既有 `onOpenAttachment` 共享预览；读取复用 R192 `AttachmentThumb` 的 `attachment.previewImage` + 懒加载 + LRU，新增 `messageImage` 钩子 `data-zs-message-image=loading|ready|failed`，失败退回图标），原型 resources 通道图片同样出图；房间主池卡片 `image_file` 附件同步改预览块（复用 `.msg-image-grid`，`data-zs-room-card-image`），非图片保留 chip；与 `message.fileChanges` 关联的图片仍留在文件变更卡避免重复。**②③引用与操作条**——房间 `RootCardActions` 删 `queueDraftInsert` 纯文本（旧实现截 400 字），改 `addConversationQuoteToDraft('room:'+roomId,…)` 全文保留、选中优先，`RoomPage` 新增 `roomQuote`（带 roomId，切房不串草稿）经 `RoomPool` 传给 `Composer insertQuote`，toast 与对话串一致；删除 `components.css` 中 `.msg-list.is-replies` 用 grid 把 `.msg-actions` 放到作者行（气泡上方）的两组规则（含 560px 媒体查询与 `zs-message-panel` 容器查询），操作条回到正文之后、悬停/聚焦显形与 human 右对齐保留；房间卡片操作条从 `root-foot`（线程预览之后）移到整条消息内容（正文→图片/附件）之后、预览之前，卡足只留回复数/未读。**④Git**——根因：daemon `NOT_A_GIT_REPO` 经 bridge 落到 `error.code`、消息已被 `userFacingSystemText` 清洗，`refreshGitState` 只认 `msg.startsWith('NOT_A_GIT_REPO')` → 非 Git 目录被当真实失败并双写 `readErrors.status`+`lastOp`；改按 `error.code` 或消息含「不是 git 仓库」/`not a git repository` 判中性（`isGit=false`、`notARepo=true`、清 `readErrors` 与 `git.status` 的 `lastOp`、不弹错，其它写操作 lastOp 保留），`userFacingText` 把非仓库消息收敛为「此目录不是 Git 仓库」并去 `fatal:`/`error:` 前缀（安全信息保留），文件与 Git 页两块失败面板加中性门禁、Git 页失败原因过清洗。**⑤带鱼屏**——`ExecutionStatus` 仅 `surface="thread"` 且视口 ≥2000px 时把状态条内容收到 `--zs-execution-band-max`（1024px）并居中（`data-zs-execution-band-width/centered`、`data-zs-execution-actions`），1360/1873 保持 auto 原布局。**⑥独立研讨成员**——每行拆三列：勾选固定 16px、名称单行省略、运行时提示上限 128px 单行省略号（title 全文），行固定 30px/nowrap/overflow hidden；DeepSeek Harness 长型号不再折行（`data-zs-deliberation-*` 钩子 + chip `data-zs-deliberation-chip`）。**⑦搜索筛选**——「更多筛选」展开行重排：日期（起/至、两个 date 输入同宽 144px）与会话两组，控件/标签同一 30px 基线、组间竖分隔，收起不渲染保持工具栏 48px（`data-zs-library-more-panel`、`data-zs-library-more-group`）。**⑧去重入口**——运行设置菜单 deliberate 已开启时不再出现「调整独立研讨成员」，只留「回到自然协作」；未开启只留「独立研讨」开启项；成员名单只在芯片弹层设置。**⑨我的名字**——新合同 `src/contracts/viewerIdentity.ts`（`ui.viewer.displayName`、归一化去控制字符/折叠空白/上限 24 字、空值回退「你」）；daemon `app.settings.get/set` 白名单加键（set 归一化、空值=恢复默认；其它键校验不变）；store 新增 `viewerName` 投影 + `setViewerName`，`App` 启动与通知开关同一次读取带上名字；设置页「外观」新增「我的名字」行（输入/保存/状态，写后严格回读，搜索索引新增），`MessageView` 作者名与头像名、房间主池预览作者、房间/对话串/私信引用来源都用设置名字。同步更新 `scripts/verify-R135-ui.cjs`（成员菜单改点芯片、断言改「运行设置只剩回到自然协作」）、`tests/browser/uiR135.test.ts` 检查名、`scripts/lib/user-guide-scenes.js` 第 20 场景、用户手册第 5/7/9/10/11 节与图片/引用/名字/Git 说明，`docs/user-guide/index.html` 由 `scripts/package-user-guide.mjs` 重新生成。

验证：新增 `scripts/capture-r195-ui.cjs`（隔离数据 + 假运行时 + 真实 daemon；三阶段 1360×900 主场景 → 页面刷新持久化 → `setZoomFactor(0.42)`≈3238 CSS px 带鱼屏）**41/41 断言通过**（干净 worktree 复跑同样 41/41），覆盖：图片 `<img>` 已解码且宽 ≥96px、操作条在正文/附件下方、房间结构化引用正文完整且来源显示设置名字/输入框无引用正文、非 Git 目录无两块失败提示且无 `fatal:`/`not a git repository`、成员行 30px 等高且注入超长 Harness 型号不折行+省略号、搜索收起 48px/展开控件 30px/日期等宽/不溢出、名字写入后刷新设置与对话串/私信署名仍显示、1360 状态条 auto、宽屏 1024px 且在对话列内居中（偏差 ≤8px）、按钮组在内容块内、无横向溢出；单元+浏览器 **140 文件 / 993 项全过**（含按新行为更新的 `r98PanelAdaptiveReading`、`uiR135`）；定向集成 `gitProtocol`/`gitRt24`/`projectSettings`/`settingsReadQueueR186`/`imageAttachments`/`imageUnrestrictedR194`/`callBudgetFlowR98` **7 文件 / 40 项通过**；hifi tsc 0、`build-ui`/`pack-daemon` 通过、改动文件 eslint 无新增；新增 `tests/unit/viewerIdentityR195.test.ts`、`tests/browser/viewerNameR195.test.ts`，`userFacingTextR119`/`gitReadPartialR78` 增补非 Git 中性态与 stderr 清洗断言。

交付：版本升 `0.1.3-beta.40`（`package.json`、`packaging/windows/release.json`，numericVersion `0.1.3.40`）；程序提交 `552d1a3`（35 文件：src 16 含新增 `contracts/viewerIdentity.ts` 与 4 个 `r195-*.css`、tests 6、scripts 4 含新增 `capture-r195-ui.cjs`、手册 README/index、两个版本文件；仓库中此前未提交的侧栏「工作区」改动所在文件按内容拆分——`App.tsx`/`LibraryPage.tsx`/`pages-misc.tsx`/手册 README 只提交 R195 所需内容，他人未提交的侧栏改动保留在工作区、未进提交）。干净 worktree `dist/r195-source`（`552d1a3`，status 0，`dirty=false`）构建：便携镜像 BUILD `bld_d0deb341c0b3c7e9`（clean、`632` 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_6a58e83daed36a6d`（安装镜像 `668` 文件 MANIFEST 逐项 SHA256；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.40-x64.exe` **160,210,508 字节**，SHA256 `75b7569f5e614b423b40337b06fabc970564a99ccbecf9f6ed2092984fa92724`，未签名，附 `.sha256`/`.release.json`。本记录提交后推送 `main`（`552d1a3` + 记录提交）、创建 tag `v0.1.3-beta.40` 与 GitHub Release「众说 0.1.3-beta.40」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.40.md`）；用户自行安装。未在本机安装/升级/卸载、未操作用户程序与运行数据、未调用真实模型。见 [R195](../reviews/r195-ui-feedback-20261108.md)。


## 2026-11-08：R194 图片输入限制移除（所有 AI 直接接收图片）

用户 2026-11-08 发来输入区截图，要求「去掉所有 ai 可能不能看图片的限制，现在所有的 ai 都能看图，把这些图片有关的限制都去掉」——截图中「部分 AI 暂不能接收图片，可换成员或移除图片。」提示条，以及发送弹层「当前所选 AI 尚不能确认接收图片：xxx / 仅发送文字，图片不送模型 / 移除图片继续 / 换可用成员 / 取消」都要消失。口径：图片按普通附件直接随消息发送，Claude/Codex/Pi/DeepSeek Harness 四个运行时都真实携带图片；不再要求 R76 识图认证；仅记录（`record_only`）仍是「只保存消息与原件、不派发」，与图片能力无关。

实现：`memberImageCapability()` 恒返回 `status:'supported'`（删除 R76 证书读取与 `claudeImageIdentity`/`claudeCertificationMismatches`，`image-certification-r76.json` 已删除——src/tests/scripts 无引用，历史证据留在 Git 历史）；`commands.ts` 删 `assertImageGate` 与 3 个调用点及「仅发送文字但没有文字」的 `EMPTY_MODEL_INPUT` 分支，`attachMessageRefs` 一律 `'include'`（`record_only` 仍 `'local-only'`），`imageAck` 保留为可选并完全忽略（兼容已持久化旧信封），`message.imageCapability` 恒 `supported:true`，诊断投影改「随消息直接发送」，`attachment.previewImage` 的 `modelInput` 改 `'sent-with-message'`；`turnInput.ts` 删 `allowImages`/`IMAGE_INPUT_UNVERIFIED`，历史 `omit` 也按 include 发送，仅 `local-only` 注入「未发送」说明；`dispatchWorker.ts` 删组装期/启动前图片能力与身份校验及 DELIBERATE 段图片校验，不再传 `allowImages`/`imageConfigurationKey`；`contracts/runtime.ts` 删 `imageConfigurationKey`；`runtimeOptions.ts` `imageInput` 各分支统一 `'automatic'`；`remoteClient.ts` 删 `IMAGE_INPUT_UNVERIFIED` 人话映射。适配器：Claude/Codex 原本已传图，只删认证身份校验与 Codex `inputModalities` 拦截；Pi 在 `prompt` 帧带 `images:[{type:'image',data,mimeType}]`；DeepSeek Harness 在 `full` 模式 `execute` 帧带 `images:[{data,mediaType}]`（`planning`/`format-repair` 仍纯文本）。界面：`Composer.tsx` 删 `imageStatus` 轮询/提示条（`data-zs-image-status`）/`imageGate` 弹层/发送前 `message.imageCapability` 预检/`imageCheckingKeys`/`submit(imageAck)`/`omit-images` 分支；`loader.ts` 三个信封构建函数与 `Room`/`RoomPage`/`DmPage`/`ThreadPage` 删 `imageAck` 透传，`attachmentRefsFromDraft` 去 `intent`/`hasImages`；`MemberDetailPage`「图片输入」恒「自动传递图片」、`LocalDiagnostics` 恒「可用（直接发送）」；旧渲染器 `renderer/app.js` 同步删 `imageAckPending`/`showImageGate`/两处发送前门禁与「仅发送文字」按钮（`renderer/index.html` 删死元素 DM 图片门容器 `#dm-gate`）；`commands.ts` 的 `resolveAttachmentRefs` 头注释改为「图片随消息直接发送给模型，无能力门」，`turnInput.ts` 根消息可空注释去掉旧门描述。未改命令合同其它字段、schema 61、迁移、权限/audience 与数据。

验证：hifi `tsc --noEmit -p tsconfig.hifi.json` 0 错；根 `tsc --noEmit` 在干净 HEAD worktree 为 0 错，当前工作区 29 项全部来自本机**未跟踪** R130/R180 夹具与被其拉入的 `src/ui/hifi/lib/localOpen.ts`（22+7），与本轮改动前逐行一致、0 新增（改动中一度出现的 `imageConfigurationR77` 已删除导出引用错误已随测试改写消失）；`node scripts/build-ui.mjs` 通过；`src` 内 `IMAGE_INPUT_UNVERIFIED`/「暂不能接收图片」/「不能确认接收图片」/`imageGate`/`imageStatus`/`omit-images` 静态检索无命中（只剩 `message.submit` 被忽略的兼容字段 `imageAck` 与 `turnInput.ts:29` 一句解释旧选择失效的注释）。测试已改写完成：19 个既有测试文件改写 + 新增 `tests/integration/imageUnrestrictedR194.test.ts`，删除 3 条只测已删除机制的用例（`imageInputR76` 启动前图片能力/身份复检 2 条、`imageConfigurationR77` R76 证书 1 条），其余为断言改写；18 个改动/新增测试文件 18 passed / 143 tests passed，相关附件/图片/Office/提交/hifi 集成 17 文件 92 passed，相关单测+其余集成 20 文件 255 passed | 8 skipped，浏览器 R152 1 file passed（89 checks，0 failed）；全量 `node node_modules/vitest/vitest.mjs run` 388 文件 379 passed / 7 failed、3643 tests 3584 passed / 25 failed / 18 expected fail / 16 skipped，25 条失败全为既有且与图片无关（20 条来自本机未跟踪 WIP 混沌套件，单跑同样失败；5 条为 `coordinationManifestR154` 并行超时 4 + `docxWordValidation` 的 Word COM 被 WPS 劫持 1，两者单跑均通过）。

未验证边界：未调用真实 Claude/Codex/Pi/DeepSeek Harness 模型验证识图，不宣称「真实模型识图通过」；未在本机安装/升级/卸载、未在安装版界面核对提示条消失（安装包已构建，见下行交付）；未使用真实用户数据验收；未运行 e2e 真实运行时套件；Pi/DeepSeek Harness 图片帧按各自公开 rpc/execute 结构实现，未在真实账号端到端确认模型读取图片字节。文档同步：用户手册第 3 节删「图片暂未开放」、第 9 节补「图片直接附带发送，所有 AI 成员都能收到」，首行更新日期 2026-11-08，`docs/user-guide/index.html` 由 `scripts/package-user-guide.mjs` 从 README 重新生成，施工总账 `docs/implementation/implementation-status.md` 追加 R194 条目；详见 [R194](../reviews/r194-image-input-unrestricted-20261108.md)。

交付：版本升 `0.1.3-beta.39`（`package.json`、`packaging/windows/release.json`，numericVersion `0.1.3.39`）；程序提交 `9beee03`（48 文件：src 24 项含删除 `image-certification-r76.json`、tests 20 项（19 改 + 新增 `imageUnrestrictedR194.test.ts`）、手册 README/index、两个版本文件；仓库内他人未提交的侧栏改动未纳入、未进包）。干净 worktree `dist/r194-source`（`9beee03`，status 0，dirty=false）构建：便携镜像 BUILD `bld_8a4993c49e6146d5`（clean、632 文件 MANIFEST 逐项 SHA256 632/632）、安装器 BUILD `bld_1cea3992ad51eb5c`（安装镜像 668 文件 MANIFEST 668/668；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`；Inno `Successful compile (58.562 sec)`）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.39-x64.exe` **160,208,876 字节**，SHA256 `346d22b0e9f997b1fbbe7544d3155008d8f3acb217d25f6de0c8aa19d3df650f`，未签名，附 `.sha256`/`.release.json`；PE 与 `installed-desktop.json` 版本均为 `0.1.3-beta.39`/`0.1.3.39`，native icon 7 帧校验通过、RunAsNode fuse 关闭；包内 `renderer/hifi/app.mjs`、`renderer/app.js` 旧图片提示无命中，`daemon/daemon.cjs` 无 `IMAGE_INPUT_UNVERIFIED`/`assertImageGate`/`allowImages`/`image-certification-r76`，包内手册含新句且仍为旧「打开/切换项目」措辞。本记录提交后推送 `main`（`9beee03` + 记录提交）、创建 tag `v0.1.3-beta.39` 与 GitHub Release「众说 0.1.3-beta.39」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.39.md`）；用户自行安装，未在本机安装/升级/卸载、未覆盖已装 beta.38 与运行数据、未调用真实模型识图。

## 2026-11-08：R193 侧栏旧样式泄漏修复与统一左基线（beta.38）

用户 2026-11-08 发来 beta.37 侧栏截图说「左侧边栏总看得不顺眼」，要求定位原因。诊断：同一份 `dist/ui/renderer/index.html` 先加载旧界面 `renderer/style.css`（其中 `.sidebar { width:240px; ... padding:12px; gap:10px; }`），再由 hifi `main.tsx` 注入 `hifi/app.css`；hifi 的 `.sidebar` 只声明 width/背景/边框/overflow，没有声明 padding/gap，旧规则继续命中新侧栏，导致整条侧栏内缩 12px、选中竖条离开窗口左缘（x=12 而不是 0）、每行名称可用宽度少 24px、顶部/项目区/底栏三段多出 10px gap。用 beta.37 安装版 CSS 在隔离渲染器复现，导航图标 x=44、项目图标/名 48/69、房间名 66、设置图标 28，与用户截图一致。旧 `verify-r135-sidebar.cjs` 自建页面只加载 hifi CSS、不加载 legacy 样式，因此长期未发现；R192 起截图虽然走真实页面，但没有侧栏坐标断言。另有两处与泄漏无关但和注释矛盾：设置比导航左突 16px；房间名比项目名左 3px（`--control-icon-compact` 实为 24px，旧注释按 22px 写 padding）。用户随后要求「一起都靠左一点吧，然后打包发版推送」。

实现：`src/ui/hifi/styles/base.css` 显式给 `.sidebar` 补 `padding: 0; gap: 0`（阻断旧界面同名类泄漏）；`.sidebar-foot > .side-item` 补 `padding-left: 24px`（恢复任务/设置与顶部五个入口同基线）；`.side-row` gap 2→0、`.side-item-label-btn` 左内边距 2→0、`.side-item.sub` padding-left 16→12，最终所有图标（导航/项目/房间状态位/设置）落 x=32，项目名与房间名 x=53，导航/设置名 x=54（1px 来自 14/13px 图标）。版本升 `0.1.3-beta.38`（`package.json`、`packaging/windows/release.json`，numericVersion `0.1.3.38`）。新增 `scripts/capture-r193-ui.cjs`：真实 `index.html` 组合（同时加载 legacy 样式）+ 隔离数据 + 假运行时，断言侧栏 20 项几何（padding/gap=0、全部图标 x=32、名称列、选中条 x=0 宽 3px、无溢出）。未改 daemon 命令合同、schema 61、权限/audience 与数据。

验证：`tsc -p tsconfig.hifi.json` 0 错；`node scripts/build-ui.mjs` 通过；`capture-r193-ui.cjs --run=r193-verify` **20/20 断言通过**（证据 `dist/r193-ui/r193-verify/`）；回归 `capture-r192-ui.cjs --run=r193-sidebar-unified` 10/10 通过；`tests/unit`+`tests/browser` **138 文件 982 项通过**；安装包内 `resources/app/dist/ui/renderer/hifi/app.css` 与主仓构建产物按换行归一后逐字节一致，修复确实进包。本轮只动 CSS/版本/验证脚本，未跑 integration 全量（与 daemon/合同/数据无交集）；旧 `verify-r135-sidebar.cjs` 仍因头像 PNG loader 缺失无法构建，属历史脚本问题，未作为门禁。未安装/升级/卸载、未启动安装版、未操作用户运行数据、零真实模型。

交付：程序提交 `b5ed75c`（含版本 beta.38 与 R193 验证脚本）；干净 worktree `dist/r193-source`（`b5ed75c`，status 0，node_modules junction）构建：便携镜像 BUILD `bld_c0a36980380b43a0`（clean、632 文件 MANIFEST 632/632 逐项 SHA256）、安装器 BUILD `bld_b9e01d704d38ef22`（安装镜像 668 文件 MANIFEST 668/668 逐项复核；payload 审计 668 文件、privacyScanPassed=true、dataFilesIncluded=false、runAsNode=false）；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.38-x64.exe` **160,218,557 字节**，SHA256 `16ddd6a1e76066caf026a2aece82bf695edb0c4eb6a4b881ab6d64ab930dd495`，未签名（NotSigned），附 `.sha256`/`.release.json`；PE 版本与 `installed-desktop.json` 均为 `0.1.3-beta.38` / `0.1.3.38`。推送 `main`，创建 tag `v0.1.3-beta.38` 与 GitHub Release（exe + sha256 + release.json；用户自行安装）。未覆盖用户已安装的 beta.37，未操作用户运行数据。见 [R193](../reviews/r193-sidebar-alignment-20261108.md)。

## 2026-11-07：R192 消息图片预览、收藏搜索、消息头像与设置精简（beta.37）

用户 2026-11-07 基于 beta.36 反馈四项：①发送的消息应支持预览图查看——截图中的图片消息只有文件名与黑色圆点，实际是 `Icon` 缺少 `image` 字形时的回退；②收藏应支持搜索，只要按文字匹配即可；③对话串与私信中的消息头像偏小，用户测得约 35×35，希望改为 50×50；④隐藏设置页「数据与存储」中的「最近一次数据操作」与「从旧版本导入草稿」。

实现：新增 `src/ui/hifi/components/AttachmentThumb.tsx`——图片附件复用 `attachment.previewImage` 按需读取（IntersectionObserver、最多 8 张缓存），失败/解码错误回退图标；`MessageChangedFiles` 图片卡改大预览布局（预览图在上、文件名/元信息与打开按钮在下，点击预览图打开共享预览），`GeneratedFiles`/`ThreadPage` 锚消息/`Room` 根消息附件显示真实小缩略图，`Icon.tsx` 补 `image` 字形；`LibraryPage` 收藏页签新增 `SearchField` 与 `savedItemMatchesText`（标题/ref/类型标签大小写不敏感包含匹配，空词显示全部，范围与收藏数据不变，无匹配显示空态）；`MessageView` 消息头像 `Avatar size 22→50`、`base.css` 新增 `.avatar-50`、`ui.tsx` 类型扩展；`SettingsPage` 删除「最近一次数据操作」「从旧版本导入草稿」两段 UI 及关联状态/导入调用，保留备份/恢复/草稿/清理/归档，`loader.ts` 内部写日志去除已隐藏入口的引导。未改 daemon 命令合同、schema 61、权限/audience 与数据。

验证：`tests/unit` 68 文件 **595 项通过**；`tests/browser` 70 文件 **387 项通过**（新增 `r192Feedback` 5 项）；`tests/integration` 本地全量 249 文件（241 通过/2 跳过/6 失败）、2659 项（2600 通过/25 失败/18 预期失败/16 跳过），25 项失败均为既有本机未跟踪 R130/R180 混沌 20 项与 `coordinationManifestR154` 已知并发 5 项，与本轮无关；`tsc -p tsconfig.hifi.json` 0 错；`node scripts/build-ui.mjs` 通过（仅既有 `import.meta` CJS 警告）；新增 `scripts/capture-r192-ui.cjs` 隔离数据+假运行时 **10/10 断言通过**，证据 `dist/r192-ui/r192-review/`。独立复核 `verify-r192` 复跑 tsc/browser 70 文件 387 项/截图 10 项均通过；其发现的 `verify-daily-r68.cjs`（R68 历史一次性门，G2 依赖已隐藏的旧导入面板）已记为历史不适用，另补 `AttachmentThumb` 的 `img onError` 回退、`ThreadPage` 统一 `isImageAttachment`、清理 `.settings-data-operation` 样式与旧日志引导。

交付：程序提交 `51ecad8`（含版本 beta.37），干净 worktree `dist/r192-source`（`51ecad8`，status 0）构建：便携镜像 BUILD `bld_cbb914d94cdf0c5d`（clean、632 文件 MANIFEST 632/632 逐项 SHA256）、安装器 BUILD `bld_78d6ed1b224c955e`（安装镜像 668 文件 MANIFEST 668/668 逐项复核），安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.37-x64.exe` **160,213,628 字节**，SHA256 `ef76f82c7be7988eade8209584255369e1eb5c86f001ff7d8a21bb4cef9095a4`，未签名；payload 审计 668 文件、privacyScanPassed、dataFilesIncluded=false。未安装/升级/卸载、未操作用户运行数据、零真实模型；未创建 GitHub Release。见 [R192](../reviews/r192-user-feedback-20261107.md)。

## 2026-11-07：R191 前端提示去英文与去括号说明（beta.36）

用户 2026-11-07 截图反馈成员停用协调者时提示「操作失败：VALIDATION_INVALID: 协调者不可停用（房间 自动协作 路由依赖协调者——如需更换请先调整协调者）」，要求各种前端提示里的英文都去掉、括号里的说明也去掉。确认口径：只清提示类文案（报错/toast/错误条/空态/tooltip/placeholder/状态说明），错误码、命令名、参数名、枚举值与技术英文去掉，Git/AI/PDF/Word 等产品名保留；提示里的所有括号及括号内容去掉，安全关键信息不得丢失。

实现：`src/contracts/userFacingText.ts` 中央清洗升级（先保护路径/文件名/URL，去 Electron 包装、错误码前缀、下划线错误码、命令名、参数赋值，阶段/状态/技术词转中文，递归去括号，清理标点；`userFacingTextR119` 测试重写）；hifi 界面去掉 `MembersPage`/`MemberDetailPage`/`RoomPage`/`AddMemberModal`/`MemberManagementForms` 的错误码前缀，提示/空态/tooltip/placeholder 去括号并保留安全信息，渠道去「CLI」、权限档位/思考等级/用量单位/Git HEAD·diff·stash·base·ours·theirs·origin·hooks·runtime·agent·LAN 等技术英文中文化，导出格式菜单改「导出 Markdown/HTML/DOCX 记录…」「Markdown/Word 聊天记录」；旧渲染器约 230 处提示与 `src/ui/main.ts` 数据/启动/另存为对话框同步清理（新增 `userFacingDisplayText` 最小清洗，控制台日志不动）；`callBudget`/`document`/`localDataCopy`/`daemonIpc` 用户可见校验/连接文案去英文标识。`userCopyR119` 新增覆盖全部 hifi `*.tsx/*.ts` 提示上下文的括号、技术英文与错误码插值守卫。未改 daemon 命令合同、schema 61、错误码枚举与数据；未改 `src/contracts/prompts.ts`、用户/AI 消息正文与工具输出。

验证：单元 68 文件 **595 项通过**；浏览器 69 文件 **382 项通过**；集成跟踪测试 242 文件通过、**2605 项通过**（仅本机未跟踪 R130/R180 混沌资产仍有既有 20 项失败，与本轮无关）；hifi tsc 0、根 tsc 仅既有 `localOpen` DOM 错误；改动源文件 eslint 99 项与基线 99 项一致、0 新增；`build-ui.mjs` 通过；`scan-prompts`/`scan-visible-english` 均 0 条。旧断言 `memberChannelsR136`、`taskDetailsDisplayR78`、`preDispatchFailureFactsR107`、`threadReadingAids`、`r91MessageCollaboration`、`r102RecoveryHumanCopy`、`composerCallBudgetDisplayR114`、`composerWriteHintR129`、`gitReadPartialR78`、`callBudgetSettingsR98`、`dmInterruptedNoRunR106`、`threadStatusR132`、`r98PanelAdaptiveReading`、`settingsReadQueueR186`、`hifiThreadRound51`、`hifiUploadDeepLinkRound52`、`rootAttachmentsR76`、`r153ProductNavigation` 等按新口径更新。

交付：程序提交 `2753a2f`（含版本 beta.36），干净 worktree `dist/r191-source`（`2753a2f`，status 0）构建：便携镜像 BUILD `bld_6c15553c55284cce`（clean、668 文件 MANIFEST 逐项 SHA256 复核 668/668）、安装器 BUILD `bld_6a177bed4abd1838`，安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.36-x64.exe` **160,206,843 字节**，SHA256 `2cc020e9f891e5059021598cd466a7d3850d09e0355edf6036cd63966312f73a`，未签名；payload 审计 668 文件、privacyScanPassed、dataFilesIncluded=false。未安装/升级/卸载、未操作用户运行数据、零真实模型；未创建 GitHub Release。见 [R191](../reviews/r191-copy-cleanup-20261107.md)。

## 2026-11-07：R190 七项界面细节（文件与 Git / 搜索与收藏 / Git 空态 / 提示居中；beta.35）

用户 2026-11-07 基于 beta.34 反馈七项：①文件/Git 顶栏与下方面板贴太近；②搜索页两个页签偏上、作者名筛选不要；③搜索输入时不要弹「按 Enter 或点检索开始」；④去掉「范围：「X」· 搜索范围为消息…」「…收藏总计 N 条」「在线程回复消息上点书签按钮…」等开发口径；⑤文件预览 ⋯ 去掉「引用到 选择讨论位置」；⑥Git 页去掉「改动记录不受影响 / 任务改动仍会记录…」；⑦各种提示偏上，应居中。

实现：文件页 fg-body 的 `margin:0 18px` 覆盖了共享 12px 上间距，改为 `var(--sp-3) 18px 0`；工具栏内 `.thread-tabs` 清零基础 `padding:0 12px 6px`（页签因此居中），删除作者筛选（含 author 状态、search.query 的 authorDisplayName 与 searchKey 依赖）；删除输入时的「按 Enter 或点检索开始」块与搜索空态 detail；删除范围说明整行、收藏空态长说明；`PreviewPane.quoteTarget` 改可选，文件页不再传（菜单项与「引用选区」浮标都不渲染）；GitPage 删掉「改动记录不受影响」整块（保留空态标题与读取失败重试）；成员/看板/搜索三页 `.page` 改 flex 列、`.project-split` 撑满（左栏仍 flex-start+sticky），空态 `flex:1` 垂直居中。

验证：新增 `scripts/capture-r190-ui.cjs` **11/11 断言通过**（间隔 12px、页签中心=工具栏中心 82px、作者筛选不存在、无范围/搜索范围/收藏总计/书签文案、预览菜单无引用入口、非 Git 目录 Git 页无提示块且仍说明未初始化、空态居中、输入无提示），证据 `dist/r190-ui/r190-verify4/`；回归 R189 一致性 50/50、R188 14 场景 123 断言、R183 15 场景 86 断言；`memberChannelsR136 + listOrderR183 + r149UiBrandingCopy + r153ProductNavigation` 4 文件 18 项通过；hifi tsc 0、改动文件 eslint 0 新增（既有 16 条与 HEAD 一致）。

交付：程序提交（含版本 beta.35）与安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.35-x64.exe`（干净 worktree 构建，未签名）；未安装/升级/卸载、未操作用户运行数据、零真实模型；未创建 GitHub Release。见 [R190](../reviews/r190-ui-feedback-20261107.md)。

## 2026-11-07：R189 四页视觉统一（成员管理 / 看板 / 文件与 Git / 搜索与收藏；beta.34）

用户 2026-11-07 基于已安装 beta.33 反馈两条：①四个页面的项目卡片和标题样式不一致、有割裂感；②四个页面的顶部栏和搜索栏风格不一致。确认口径：项目卡统一「项目名 + 一行小字」，四页顶部统一为同一条灰底圆角工具栏（页签收进栏内）。

实现：新增共享 `components/ui.tsx` 的 `SearchField`（放大镜+外框、30px）与 `styles/r189-consistency.css`（工具栏内页签对齐、`min-height:48px`、`.search-field`、`.toolbar-tail`/`.toolbar-more`、文件页工具栏单行与 inline 状态条）；成员页搜索框改 `SearchField`；看板「全部项目」卡小字补「侧栏可见项目」、刷新按钮改 `.btn.sm`；文件页白底 42px 顶栏并入 `.page-filters fg-toolbar`（并补页面右内边距 24/40、首行 20px 顶部间距、状态条压单行）；搜索页页签并入工具栏、关键词改 `SearchField`、作者/日期/会话收进「更多筛选」（默认收起）、范围说明移到栏下、无当前项目时自动落到「全部项目」、项目卡小字显示 Git 类型；删除 r188-files/r188-library 里被新结构取代的覆盖。

验证：新增 `scripts/capture-r189-ui.cjs` 四页一致性场景 **50/50 断言通过**（四页工具栏 computed 样式逐项相等、位置/宽度相同、高 48px、控件 30px、与左栏标题顶部对齐、搜索框一致、卡片字体与高度一致且小字非空；功能回归含成员搜索过滤/搜索页回车/看板按钮），证据 `dist/r189-ui/r189-verify2/`；1360×900 与 1873×740 两档实测工具栏 y=58/h=48、四页 x 与宽度完全一致；`capture-r188-ui.cjs` 14 场景 124 断言、`capture-r183-ui.cjs` 15 场景 86 断言回归通过（选择器按新 DOM 更新）；`memberChannelsR136 + listOrderR183 + r149UiBrandingCopy + r153ProductNavigation` 4 文件 18 项通过；hifi tsc 0 错、改动源文件与脚本 eslint 0 新增。

交付：程序提交 `a4435ae`（含版本 beta.34）；干净 worktree `dist/r189-source`（`a4435ae`，status 0）构建，镜像 BUILD `bld_b20575d937068da7`（clean、668 文件清单逐项 SHA256 0 不符），安装器 BUILD `bld_5c8128cce6bb8650`；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.34-x64.exe` **160,197,756 字节**，SHA256 `919d6287564ac5f8832c1a87d10084794090f8eaf84e044fe6cd598994993f29`，未签名。按用户长期偏好只交付安装包，未安装/升级/卸载、未操作用户运行数据、零真实模型；未创建 GitHub Release。见 [R189](../reviews/r189-ui-consistency-20261107.md)。

## 2026-11-07：R188 用户八项界面反馈 + 推送并发布 beta.33 安装包（含此前未提交的 R185–R187）

用户在已安装 beta.32 上提八项界面反馈：①侧栏项目/房间平时不要抓取光标、真正拖动才 grabbing ②成员管理/看板共用的项目卡左右留白收到 16px 且相等 ③看板单卡归档按钮 ×→√ ④该按钮 title/aria-label 改「归档」短文案 ⑤看板去掉「房间」筛选下拉（旧 roomId 链接进入时 URL 归一、不再 toast）⑥文件与 Git 页左栏项目卡列取代顶栏项目下拉，切项目不再横向位移且同时切当前项目 ⑦搜索与收藏页左栏项目卡列取代「范围」下拉，「全部项目」=侧栏可见项目，点卡同时切当前项目 ⑧去掉「此文件夹未初始化 Git」面板。实现集中在 `src/ui/hifi`（并行队员 board-r188 / files-r188 / library-r188 与 Lead 共享 CSS），不改 daemon 命令合同、schema 61、不迁移数据。

验证（独立队员 verify-r188，隔离数据/假运行时/零真实模型）：新 `scripts/capture-r188-ui.cjs` **14/14 场景、124/124 断言**全过；四页几何 1360×900 与 1873×740 实测 `pageLeft=246/paddingLeft=16/卡片 262..526/分隔线 542`→卡片左缘−页面左缘=16、卡片右缘−分隔线=16；光标平时 auto/pointer、拖动中 grabbing；看板归档 check 图标（polyline `20 6 9 17 4 12`）、title 归档；带 roomId 深链被 replace 清掉且无 toast；文件页切项目 rail/topbar/content 左移 0px、页签保留、侧栏+标题栏同步；非 Git 目录无未初始化面板；搜索页 `scope=visible`/`scope=project` 与 focusProject 均符合。更新后的 `capture-r183-ui.cjs` 回归 15/15 场景、86/86 断言；`capture-r170-ui.cjs` members/board 通过；hifi tsc 0、脚本 eslint 0；`memberChannelsR136+listOrderR183` 15 项、`boardView+dev18FollowSearch` 10 项通过。限定：光标为 computed style+合成 DragEvent（非 OS 级真鼠标）；搜索「全部项目=侧栏可见」为参数级（夹具 4 项目全可见，未做隐藏差分）；`verify-r85-daily-extension.cjs`、`verify-r78-board-races.cjs` 仍断言已删除的房间筛选语义，属过时一次性脚本，未跑。

交付与发版：R188 前端提交 `ff1eead`、文档 `ab9575d`；用户要求「带上未推送的推送并发版」，故把此前只在本机候选、从未提交的 R185–R187（Harness 连接组件 0.1.4 新会话隔离、设置读取超时、模型清单/元数据查询阻塞与安装器自动配置组件）一并提交为 `4806a31`，版本升到 beta.33 提交 `e011eff` 并推送 `main`。在干净 worktree `dist/r188-release-source`（`e011eff`，status 0，node_modules junction）构建：装配镜像 BUILD `bld_939cab4058651446`（dirty=false，668 文件清单逐项 SHA256 校验）、安装器 BUILD `bld_5f808bc18b822162`，安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.33-x64.exe` **160,187,422 字节**、SHA256 `d46cb974ae7781ad4bcacf8fd485cb8d0a5dd51bc9781b7f0338f124a19663de`，未签名、仅安装版。tag `v0.1.3-beta.33` 指向 `e011eff`，已创建 GitHub Release `v0.1.3-beta.33`（Latest，附 exe/sha256/release.json，服务端 digest 与本地一致）。**未安装/升级/卸载、未运行静默安装验收、未操作用户程序与运行数据、零真实模型**；用户自行安装。详见 [R188](../reviews/r188-ui-feedback-20261107.md)。

## 2026-11-07：R187 元数据查询阻塞与安装器自动升级 Harness 组件（beta.32 候选）

用户在beta.31仍遇room.list/成员工作量超时，另发现Harness模型列表读不到，随后确认未执行setup.cmd并要求整合进安装包。现场官方0.2.2-rc.1明确拒载旧0.1.3组件；模型查询原等待30秒并阻塞公共FIFO。现将runtimeCatalog/runtimeOptions独立执行、仍等此前写操作；正常写入彼此FIFO不变。明确拒载立即返回升级提示（现场约160ms）。安装器ssPostInstall自动调用随包setup --installer：未装Harness跳过、相同组件哈希只probe、需更新则官方plugin add；失败警告及完成页重试说明。保留原配置/MCP/会话，组件0.1.4，版本/schema61。

定向45项、组件协议/安装22项、官方桌面隔离SDK通过。官方模型清单19个（配置副本+合成凭据占位，无推理）；随包setup隔离首次安装2.7秒、重复current、旧0.1.3→0.1.4升级13.1秒且供应商patch字节保留。包内668hash/21项通过，元数据故意等待18秒时四项普通查询6ms返回、设置写回成功/退出0/真实调用0。跟踪回归分两批覆盖373文件3372项：首批中断无最终JSON，仅94文件完成通过日志1410项/1跳；其余279文件完整退出0、1946通过/1预期失败/15跳。合计3355通过/1预期失败/16跳、无报告非预期失败；不是单次全量成功。hifi类型/本轮lint通过，根类型保留既有29错误。

交付 `dist/installers/Zhongshuo-Setup-0.1.3-beta.32-x64.exe`，160190778字节，SHA256 `f2f89fa3d849f0ccc820f9e2c9286468929a1f8ccffb29ec1454d15d424c01b2`，BUILD `bld_928424cda3b63b37`，dirty候选/未签名，含既有R185/R186。未执行安装/升级/卸载或静默安装验收、未改用户运行数据或真实Harness profile；用户自行安装后自动完成组件更新。未提交推送Release。详见[R187](../reviews/r187-runtime-metadata-installer-20261107.md)。

## 2026-11-07：R186 通知设置读取超时（beta.31 安装包候选）

用户截图 `app.settings.get` 15000ms 超时。复现设置读取排在 AI 初始化/运行时元数据后阻塞；命名管道现允许设置读取独立响应，但等待此前设置写入，保留保存回读顺序、写命令 FIFO、凭据与参数校验，默认超时不变；读取失败改为简明中文。新6项修复前4项超时、修复后全过，最终定向10文件81项通过；hifi类型/本轮lint/diff检查过，根tsc仅既有29条错误，未跑完整套件。包内668hash及22项通过，前请求故意延迟18秒时设置1ms返回、正常退出0/真实调用0。现场beta.30独立诊断认证被拒，未绕过，原请求具体前置操作未证实。

交付 `dist/installers/Zhongshuo-Setup-0.1.3-beta.31-x64.exe`，160183624字节，SHA256 `f60f2a7e17b2b2df493f642b1522007fa2a31819ca41b7300a2190beda21c31e`，BUILD `bld_b1d1b110b77f096c`，当前工作区dirty候选/未签名，含既有R185改动。未安装/操作用户程序和数据、未提交推送Release；用户自行安装。详见 [R186](../reviews/r186-settings-read-timeout-20261107.md)。

## 2026-11-07：R185 众说新建 Harness 会话不进入普通历史列表（beta.30 安装包候选）

用户发现内部会话挤入 Harness“未分组”，并明确选择只处理今后新建的会话。连接组件 0.1.4 通过官方 JSONL/storage 后端把新会话及投影缓存放到 `<DSH_HOME>/connectors/zhongshuo/sessions|storages`；新 ID 前缀 `zhongshuo-session-` 绑定原编号冷续聊，旧 ID 显式使用原目录，不搬迁/归档/删除已有记录。新会话握手要求 privateSessions，旧组件在请求前提示升级。发现本机 Harness 已升级为0.2.2-rc.1，补该精确版本支持；规划/补交采用新 scoped executor 的空工具/拒绝批次，旧0.2.1-rc.5保留原限制。

官方 npm0.2.1-rc.5和桌面0.2.2-rc.1各32 SDK检查+7存储检查通过（隔离home、固定响应、0供应商调用）；协议/安装21过；完整跟踪370文件3345通过/16跳/0失败，最终旧环境路由断言另23/23；hifi类型0、本轮lint0，根类型仅既有localOpen DOM和未跟踪夹具错误。安装器668 hash、组件源码/归档一致、包内IPC17/17过/退出0/0真实调用。交付 `dist/installers/Zhongshuo-Setup-0.1.3-beta.30-x64.exe`，160203449字节，SHA256 `5d3ea06da8064009fb456ae1cc4307ea1a6c00d759b4502775536788515ec277`，BUILD `bld_47ecf506a0d396af`，当前工作区候选dirty如实记录，未签名。未安装/升级/卸载、未安装连接组件、未改用户数据、未提交推送/Release；安装后用户需运行安装目录 `runtime-tools/deepseek-harness/setup.cmd` 升级组件。详见 [R185](../reviews/r185-harness-private-sessions-20261107.md)。

## 2026-11-07：R184 beta.29 复核并发布（仅安装版）

用户确认“gpt 已修复完成，检查一下，没问题就发版”。Lead 复核修复后按干净源码构建并发版：修复提交 `bf0b61d`；干净 worktree `dist/r184-source` 装配镜像 BUILD `bld_0a040e3c761c7200`（clean，632 文件清单逐项长度/SHA256 一致），安装器 BUILD `bld_e492ad807127d466`，668 文件 payload；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.29-x64.exe` **160,196,520 字节**、SHA256 `9b0d02cc075f03ce0d8634936e72d418ea15b36a98a6a16b8d5950e01aa365bf`，未签名。独立 payload 隔离校验 **14/14**（清单、无便携启动器、主题引导、内置 daemon IPC、远程默认关闭且无监听、配对不可用、中文项目路径、重复打开去重、存储清理、零宽正文拒绝、优雅退出、0 真实调用）。回归：完整跟踪套件 370 文件（368 通过/2 跳过）、**3340 通过/3 预期失败/16 跳过/0 非预期失败/0 未处理异常**（`ZS_SKIP_WORD=1`、并发 2、清除 `ELECTRON_RUN_AS_NODE`；不含本机未跟踪 R130/R131/R180 混沌资产）；hifi tsc 0、lint 无新增；根 tsc 仅既有 localOpen DOM 与旧夹具错误。已推送公开 `main`（`92dbb9b..bf0b61d`）并创建 GitHub Release `v0.1.3-beta.29`（安装包+sha256+release.json，仅安装版；旧便携数据导入说明在 README/手册/安装说明）。安装/升级/卸载交互仍由用户自行执行；第24项待确认、不修项保留；未调用真实模型、未操作用户已安装程序与数据。详见 [R184](../reviews/r184-r180-fixes-20261106.md)。

## 2026-11-06：R184 核实并修复 R180 建议（beta.29 安装包候选，未安装）

按用户要求核实 DeepSeek 的修复建议，依文档既有逐项决定实施。确认并修复崩溃后协调占位、停止后继续按钮、Claude 畸形字段、图片启动分类、提醒隔离/归档、成果数据根重定位、项目 50 项去重、Git 超时和异步基线、空库保护、草稿清理及界面/文件名/JPEG/ZIP 问题；关闭远程默认监听与入口，仅显式开发开关允许配置；图片/Office 不新增大小上限。第12项管道吞字节在当前源码已有R134修复，回归后保留；PDF单页/PPT按需缩略图和稳定@路由亦已存在，按真实差异补齐。预览缓存按字节淘汰，表格回退虚拟化，大图缩小展示；存储仅清理过期回执正文和无引用旧前像，保留幂等身份/历史与撤销。第24项仍待确认，明确不修项目保留，schema61不变。

最终完整跟踪+本轮回归370文件通过/2跳，3364通过/6预期失败/16跳/0非预期失败/0未处理异常；Word COM实际为WPS，已有ZS_SKIP_WORD=1用于完整跑，未宣称真Word验收。补充R184专项39/39；UI15场景85断言、安装器668hash与随包后台IPC14/14通过，real_calls=0/正常exit0；hifi类型0、lint新增0，根类型仍有既有localOpen DOM及未跟踪旧夹具错误。400Mpx等整套性能指标未重新压力计量。

交付 `dist/installers/Zhongshuo-Setup-0.1.3-beta.29-x64.exe`，160174869字节，BUILD `bld_44a3a8ec3236334c`，SHA256 `7be72aca5a71c858d3839dea9e685c9d659eee4f5c112e9cc189268ed243e3d9`，未签名，附sha256/release元数据。当前工作区源码候选，BUILD如实dirty；**未提交/推送/创建Release，未安装/升级/卸载、未运行静默安装验收、未操作用户现有程序与运行数据**。完整核实与边界见 [R184](../reviews/r184-r180-fixes-20261106.md)，证据 `dist/r184/`。既有用户未提交内容及未跟踪夹具保留。


## 2026-11-05：R183 用户九项界面反馈（成员管理 / 任务看板 / 侧栏拖动；与 R182 合并 beta.28 统一打包）

用户 2026-11-04 对 beta.27 提九项界面反馈：①侧栏项目与房间可上下拖动调换位置 ②成员管理左栏项目卡左右留白不对称 ③成员页去掉项目名大标题、成员数放进左栏卡 ④去掉「扫描本机 AI」、改为点「添加 AI」时扫描 ⑤刷新与添加 AI 放到搜索同一行 ⑥AI 卡去掉自动说明/★协调者/「编辑资料」（资料编辑并入 AI 设置）⑦模板卡去掉启用/权限/执行程序 ⑧模板卡「在本项目中创建」应打开预填的添加 AI 界面 ⑨任务看板加与成员管理一致的左栏项目卡，顶部「全部项目」卡代替范围筛选。

实现：新增本机顺序偏好 `data/listOrder.ts`（localStorage，不改 daemon/项目数据）与侧栏 HTML5 拖放（项目/同项目房间；置顶项目同步排最前；⋯/+/图钉/箭头按下不起拖）；新增共享 `styles/r183-project-rail.css`，成员管理与看板共用两栏几何（卡片到页面左缘 = 卡片到右栏内容），移除成员页标题块并把成员数按项目缓存进左卡（「N 个房间 · M 名成员」，未知不写 0）；扫描并入添加入口（先 discoverDefaults 再开弹窗，说明去重）；刷新/添加 AI 入 `.page-filters`；AI 卡精简、名称说明编辑移入「AI 设置」弹窗（`allowProfileEdit`；先 member.update 取新 revision，再 member.setRuntime；部分成功如实提示且重试不重复写）；`AddMemberModal` 抽成独立组件并支持 prefill，模板创建改走同一弹窗 + `member.create`，删除 `CreateFromTemplateModal`；看板左栏「全部项目」+项目卡（显示任务数、未知道不写 0），删除范围/项目下拉，点卡只换页内范围不同步侧栏焦点。同步 Room.tsx / daemon projectWriteAccess.ts 里仍指向旧按钮的用户文案。

验证：R183 隔离截图场景 **15/15 场景、85/85 断言通过**（`dist/r183-ui/r183-final/`）；几何旧→新 1360 宽 24/36→**24/24**、1873 宽 40/36→**40/40**（成员页与看板差 0）；浏览器测试 `memberChannelsR136`（46 checks×2 渠道，含扫描并入、模板预填走 member.create、两步写 revision）+ 新增 `listOrderR183` 11 项 → **2 文件 15 测试通过**；hifi tsc 0 错、改动文件 eslint 0 新增，根 tsc 仅既有未跟踪 R130/R180 夹具与既有 localOpen DOM 错误；完整跟踪套件（清 `ELECTRON_RUN_AS_NODE`）382 文件（378 过/2 跳/2 失败）、3570 项（3519 过/26 预期失败/16 跳过/9 失败），9 项失败全在本机未跟踪 R130 夹具（历史数据目录缺失），跟踪 0 非预期失败；`coordinationManifestR154` 并发跑偶发 5s 超时、单跑 8/8（既有 flake）；R170 旧截图脚本回归 15/16（唯一 dm-r177 为 seed 耦合，带 `--r177` 单跑通过）。驱动/焦点语义未变、零真实模型。

交付：用户最新要求（R182 记录）是「等另一位 AI 修复前端后统一打包」；本轮完成前端部分，程序提交 `da8f505`（父提交 `6a0fce6`，含 R182 后端修复），据此统一构建 0.1.3-beta.28 Windows 安装包。干净 worktree `dist/r183-source`（commit `187bb14`，status 0 改动）构建：便携镜像 BUILD `bld_2032d61079bb6402` clean、667 文件 MANIFEST 逐项 SHA256 核验 0 不符；安装器 BUILD `bld_13ac0d2b2a83cf96`，安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.28-x64.exe` **160,168,614 字节**，SHA256 `5d6a1e25429705969ae908fb883e1d4a78227d8ab4aeeaff40f898c81ab32bf5`，未签名，附 `.sha256`/`.release.json`。**未安装/升级/卸载，未运行静默安装验收，未操作用户运行数据与程序，零真实模型；未创建 GitHub Release。** 源码推送 main。见 [R183](../reviews/r183-ui-feedback-20261105.md)。

## 2026-11-05：R182 房间查询超时与协作卡住（仅提交代码，版本预留beta.28）

用户再次报告 room.list 15000ms 超时和 Claude 停在准备执行。只读现场确认：独立连接 room.pool 约 4.7–6.1 秒，完整执行状态约 6.9 秒；readTaskClosure 的 scopedOutbox 对全部历史队列逐行执行六种归属子查询，并随子树重复。改为任务归属身份集合只计算一次，保留完整键语法、历史回复身份、恢复事件、租约和 UNKNOWN 保护。源码只读同库执行状态 55–84ms，room.pool 三次 104/94/81ms，room.list 51/25/16ms，thread.get 2–3ms；未延长 IPC 的 15 秒期限。

Claude 的最新规划 turn 已成功；实际阻断是 DeepSeek Harness 子步骤未收到 ready，最终整合子任务尚未派发。最新状态投影已能正确给出 FAILED 和子成员原因，查询排队使安装版界面滞后。Harness 执行就绪等待原为10秒，而官方组件在完整 appReady 后才报告 ready；与已有元数据读取统一为有界30秒，超时报启动等待失败，不再据此推断协议不兼容。保留停止、退出确认与不重试的规则。未重放原任务、修改运行库、安装更新或触发真实模型；尚不能宣称原串已恢复。

定向11文件231项通过，新增大历史队列成本/租约归属/阻塞协作不展示活动准备状态/超过10秒冷启动/超时退出用例；本轮文件 lint 0。当前主工作区另有其他UI任务和未跟踪R130/R180夹具导致全根类型检查失败，本轮文件无报告错误；独立的本轮已提交源码快照双类型检查0错误，完整已跟踪套件366文件通过/2跳过、3282项通过/3预期失败/16跳过、0非预期失败。程序提交bf131ad，完整JSON在ignored的dist/r182-timeout/isolated-tests.json。用户最新要求只提交代码，待另一位AI的前端修复完成后再统一打包。指示到达前已编译的独立安装器未安装/发布，已移至ignored诊断目录，避免误作最终交付；后续验证见 [R182记录](../reviews/r182-timeout-coordination-20261105.md)。


## 2026-11-04：后续只交付安装包，由用户自行安装

用户明确要求记录长期交付偏好：后续只创建 Windows 安装包，不再单独制作、验收或交付便携包；更新安装包由用户自行安装。未经用户另行明确要求，不执行安装/升级/卸载或静默安装验收，不覆盖现有程序或操作用户运行数据。当前打包脚本依赖的便携目录结构仅作为安装器内部装配中间目录保留，不作为独立交付。已同步到根 AGENTS.md，供后续续工遵守。本轮仅记录约定，未构建、安装或推送。

## 2026-11-04：项目菜单、待处理入口与文件/Git 切换布局修正

按用户反馈完成三项 UI 调整：移除侧栏/命令面板/项目设置中的「待我处理」入口与跳转文案，保留线程内已有验收能力；项目 ⋯ 菜单只保留置顶项目、项目主页、项目设置，编辑信息、归档、移除与归档管理统一收进项目设置，新增移除确认与归档管理入口；标题栏切换项目时识别文件/Git 路由并保留当前页签，避免从 Git 页切换项目后整体布局错位。

验证与交付：hifi 类型检查、UI 构建（既有 import.meta 警告）、浏览器 uiR135 + navigationPinsR160（2文件3项）及隔离文件页截图均通过。最终程序提交 `8059008`，干净便携 BUILD `bld_944405ede541a731`，桌面8项全部通过；beta.27安装 BUILD `bld_df1418cbe5440fb1`，667文件清单逐项核验通过，EXE 160153877字节，SHA256 `8db23078cbd40f2db41c90820007bdcf820dbfc5dea5399d90928d9e67aff3b7`，未签名。beta.26→beta.27合成安装/升级/卸载32/32通过，最终安装镜像与该验收镜像667份payload内容完全一致。verify-pack隔离默认成员发现后15/16通过：旧断言要求无租约的releaseProtection.stateChanged=false，但现行为true，UNKNOWN/settled及进程退出观察正常；重复结果一致，不归因为时序抖动。验收脚本曾改写四个系统快捷方式、卸载登记及AUMID，已依据本机beta.26记录恢复并回读核对；原安装目录与聊天数据未覆盖，真实模型调用0。源码推送main，安装器保留在dist/installers，未创建GitHub Release。


> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

## 2026-11-04：R181 停止后可在原串主动继续（源码修复，未打包安装）

用户反馈 beta.26 独立研讨停止后在原串发送「继续」被 `TASK_STOPPED` 拒绝，并授权修复。现已接通原串新消息与绑定当前任务版本/停止代次的 `task.continue`：确认旧执行收口后重开原任务，新请求沿现有消息队列执行，保留任务/线程/消息/成果、旧运行和停止代次；仅记录、无效发送、过期快照、归档及仍在 STOPPING 的执行不恢复。普通发送不指定新成员时沿用已停止研讨的 DELIBERATE 模式；按钮也使用新消息路径，按最后停止的运行模式继续，避免错误重跑根请求模式。

旧根/子任务 turn 增加续接隔离事件，迟到正文/成功/失败只留审计；旧协调停止收尾不得再次取消已接受的新请求。补测发现研讨续接原先未带上已有成员发言，已将本次请求序号之前的历史文本带入上下文（最近24条、每条至多2000字符，排除仅记录和本轮新初稿）。操作手册同步。schema61与版本号不变。

验证：新 R181 10项通过（含真实 fake worker 停止/续接、已有成员初稿、模式切换、重复提交、迟到事件、再次停止、归档、过期快照、记录/非法输入）；最终相关 **49文件624项通过**；前一修复快照完整跟踪回归纳入367文件（365有执行通过/2整文件跳过），3275通过/16跳过/0失败，之后最终源码另做上述624项定向验证，不冒称最终快照完整重跑。跟踪类型574入口0错误、hifi类型0错误、lint仅10条既有问题/0新增、最终daemon打包通过。证据 `dist/r181/`，报告 [R181](../reviews/r181-stopped-task-continue-20261104.md)。未打安装包、未提交推送、未安装、未操作用户运行程序与数据；原R180等未提交文件保留。

## 2026-11-04：R180 beta.26 暴力/异常操作对抗测试（复测 R130/R131 + 新版本新面；仅测试，未改产品）

用户指出距上次暴力测试已更新多个版本，要求重新暴力测试并复测旧发现。对最新交付 `0.1.3-beta.26`（安装器 `bld_db2ef31489596b19` / 干净便携 `bld_754bf5f9de2d8cd5` / 用户已安装版同 build，产品提交 `80e25ad`，schema 61）用 8 个并行流做了 168 行复测矩阵 + 新面测试：R180 新增 5 个 vitest 文件 135 用例（119 passed + 16 expected fail）+ 导航 33 run/186 断言、输入 17 组/112 步/362 断言、打包 37 场景、数据 42、预览 33、协议 35、新面 38、静态 73 项。全程 fake、0 真实模型调用、产品源码/包/用户数据未改；用户运行中的 Zhongshuo.exe 未触碰。

结论：**上轮发现基本未修**——R130 14 缺陷 12 still + 2 obsolete（PATH-01/02 旧启动器已移除）；R131 73 项唯一发现仅 3 fixed、68 still（含 2 high：Claude 适配器畸形输出可杀死 daemon `cliAdapter.ts:708-753`、Git 选项注入 `gitWrite.ts:1081-1086/1224`）、1 obsolete、1 changed-semantics。汇总去重 168 行：still 145 / fixed 8 / obsolete 9 / changed-semantics 6。新发现 34 缺陷（**3 high**：①远程已配对设备可 `member.setRuntime` 任意 executable 带 effort 即本机执行，`commands.ts` 无 remoteAudit 门禁；②`git.*` 不在 `REMOTE_BLOCKED_METHODS`，远程可达 Git 选项注入；③崩溃恢复后 `task.continue` 被 `UNIQUE coordination_runs` 吞掉、任务无法继续）+ 11 medium（含 `/pair` 落库放大、导出无上限、同步 RSA 阻塞、audience 远程可达、MCP 配置 fail-open、`R180-WRK-N1` 提醒绕过房间归档等）+ 19 low + 1 info；另 18 新边界、15 新限制。R129 修复点与本轮新 UI（pin/未读/房间头/设置单页/成员卡/看板归档/DM 分组/线程分页/回执投影/托盘）全部守住；schema 60→61 迁移与安装版升级数据保留全部通过；产品干净源码全量回归 362/366 passed（唯一 `coordinationManifestR154` 单条 5s 超时，单独 8/8 通过，属并发负载 flake）。

环境事件（已恢复/披露）：合成安装器两次用默认 `/TASKS=desktopicon` 覆盖用户桌面/开始菜单快捷方式与 HKCU 卸载项/AUMID——Lead 记录并恢复、pkg 流卸载全部合成安装并改零副作用参数重跑（最终 shell diff 为空）；另一次便携默认数据根观察写入 `%APPDATA%\zhongshuo`（旧休眠目录，未删文件）。报告 [R180](../reviews/r180-adversarial-beta26-20261104.md)；证据 `dist/r180-adversarial/`（ignored）；新增测试/脚本未 git 提交。下一步需用户决定修复优先级（建议先 RTC-01、Git 远程门禁、CTN-01、UPG-01/ADP-01，再评估旧 R130/R131 清单）。

2026-11-06 补充：用户要求“看不懂，给一份能看懂的”，已输出大白话版 [用户版测试报告](../reviews/r180-用户版测试报告-20261106.md)（同目录 HTML 版）；并说明测试对象是 beta.26、用户当前安装版为 beta.27、最新为 beta.28。在最新 beta.28 源码上抽查：R180 的三个 high（远程 member.setRuntime 执行、远程 git.* 可达、崩溃后 continue 被 UNIQUE 吞）与 R131-A01/GIT/AUD/D01/D02/N01 仍复现，R130 遗留测试维持 old 结论；未做 beta.28 全量暴力复测。

2026-11-06 二次补充：用户逐项决定 49 项清单（修复 3/4/8-12/16-19/21/25-31/36-39/41/42；优化 13/14/20；特殊：1/2 远程默认关闭+隐藏设置入口、40 取消便携版仅安装版；不修 5/6/7/15/22/23/32-35/43-49；24 待确认），并要求只做“bug 描述与修复建议文档”交给 GPT 实施。已产出 [R180 修复建议（给实施者）](../reviews/r180-修复建议-给实施者-20261106.md)：含决策总表、逐项根因/file:line/修复方案/验收标准、不修清单、24 待确认解释、回归与发版要求（beta.29、仅安装版、R180/R131 测试转绿、已知 flake 说明）。本轮未改产品源码、未动用户数据。

## 2026-11-04：R179 已安装 beta.26 的四项修复回归

用户安装 `0.1.3-beta.26` 后指定全部成员使用 DeepSeek。定向自动化 5 文件、114 项通过；真实安装版确认 Harness 普通业务 JSON 保留而内部 `task-complete-v1`/`schemaVersion`/`resultKey` 不显示，Codex 私信占位和列表预览正常，外部未信任临时项目的 Codex 首次配置准备不再误拒。全 DeepSeek 独立研讨在 IND 与 RATIFY 各经一次 `.fx` 格式修复后达到 run `SUCCEEDED / PUBLISH`、task `DONE`，共 19 turn；19 份 change set 的 608 对前后文件记录变化为 0，验收项目未被修改。

仍需保留的边界：Harness 在 `bypassPermissions` 下忽略了“只返回纯文本、不访问文件、不执行命令”的自然语言要求，运行了多次 `pwsh`/Python 探测；记录指向系统临时路径，项目快照未变化，不能据此宣称完整权限受限。自动创建的未配置项目仍继承上游 Codex 默认 `gpt-6.1-sol`，已有 DeepSeek 绑定未受影响。本轮无产品源码、构建、安装或发布变化，未保存模型设置。详见 [R179](../reviews/r179-beta26-installed-regression-20261104.md)。

## 2026-11-03：R178 beta.26 已打包发布

R177 修复已提交并以 `0.1.3-beta.26` 打包。程序提交 `80e25ad`，干净便携包 BUILD `bld_754bf5f9de2d8cd5`，安装器 BUILD `bld_db2ef31489596b19`，667 文件清单通过。安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.26-x64.exe` 为 160172495 字节，SHA256 `d9071159ac426855090c79c09236d11fd9df9d77a60351e83524a3987830754e`，未签名。干净桌面验收和 beta.25→beta.26 合成安装/升级/卸载验收全部通过。已推送 main 并发布 GitHub v0.1.3-beta.26；用户自行安装，未覆盖安装或修改用户运行数据。详见 [R178](../reviews/r178-beta26-release-20261103.md)。

## 2026-11-03：R177 修复 R176 暴露的四项产品问题

用户授权修复后，Pi 越界读取仍保留为渠道权限边界；其余四项已完成：①Codex 配置准备允许 CLI 在全局配置中插入合法项目信任表（含表前插入、首次创建和其他项目初始化），仍拒绝有效执行配置、环境、成员权限和当前项目信任变化；②研讨格式修复保存失败原稿、来源 turn 与哈希，修复轮只按原稿修正协议并启用 `repairOnly`，主持人前阶段已完成时也能正确收口；格式修复静默超过 3 分钟请求中断，未确认终态保留 UNKNOWN；③TaskComplete 支持带合法身份的 fenced JSON，清理内部回执并保留普通业务 JSON，避免短答案误去重；④私信占位和列表预览回退到对端成员名并隐藏控制回执。

定向修复回归 4 个文件、92 项通过；本轮新增研讨修复、fenced 回执和 Codex 初始化测试。完整跟踪回归 **364 文件通过 / 2 跳过；3265 通过 / 3 预期失败 / 16 跳过 / 0 非预期失败**；跟踪源码类型检查、hifi 类型检查、改动 lint、UI 构建和 daemon 打包通过。隔离 Electron 真点击 `dist/r170-ui/r177h/` 通过：占位「给 Codex 发消息…」、普通业务 JSON 可见、`task-complete-v1`/`resultKey` 不可见、正文一次。未覆盖安装、未操作用户运行数据、未调用真实模型。

## 2026-11-03：R176 用户已安装 beta.25，五项目真实 DeepSeek 验收

按用户授权操作实际已运行的安装版；5 个项目、24 份已有成员配置，Claude/Codex 指定 `newapi/deepseek-flash`、Harness 指定 `magpie/workbuddy-ai/deepseek-v4.1-flash-sg`、Pi 指定 `magpie/newapi/deepseek-flash`，保留原权限。各项目新建「beta.25 真实验收 R176」房间及 `zs-real-r176-20261103` 合成代码目录，分别统计待办、比较合成清单、统计整数分、计算有限实数向量 Z 期望值、解析 A1 坐标。全部成员聊天、四渠道各两轮私信上下文通过；5 份代码实际落盘、验收方独立 `node verify.mjs` 全 exit0；额外 59 边界用例全过。AUTO 实际覆盖实施→异成员复核→文档修订→再复核。Codex 私信原生同 ID 归档后恢复上下文成功、结束再归档；专项最终快照 17 个本次精确会话全归档、活动目录0，原 JSONL 保留。

**不能宣称全部通过**：①Pi 原生记录确认两次读取 3 个真实备份算哈希，并在系统临时目录写过2脚本后删除，违反本轮任务范围要求；只读哈希也算读取，记录未显示修改备份。原生完整权限下自然语言约束不等于沙箱，未擅改权限。②Harness FOLDER 终稿泄露 fenced task-complete-v1 JSON 并重复正文，尚未修。③独立研讨完成初稿/互评/3轮争议后整合格式失败，修复原生记录>7分钟无新活动；约20分钟仍无最终稿，正式停止该验收任务后确认已停止，界面最终调用计数24、过程材料保留；此项未通过，停止入口通过。④新项目首次 Codex 配置准备变化被明确拒绝且未提交，准备稳定后重试一次通过；⑤私信占位缺成员名（“给 发消息…”），实际聊天正常。

默认项目起初因本 Codex 桌面 MSIX 虚拟化写到 LocalCache 夹具，真实原生进程看不到；已在正式跟进中精确复制3份自建合成夹具、核对哈希，完成代码；验收方将自己的虚拟影子夹具保留到 ignored `dist/r176-real/default-virtual-fixture-original/` 后解除遮蔽并直接复跑通过。**未迁移运行数据**。独立后台连接凭据视图不一致仍未使用；真实证据来自 UI/原生记录/文件，不拿旧虚拟库当当前业务库。两个 Git 项目排除验收目录后的状态与前一致；不是所有既有文件字节基线，勿夸大“原文件逐字未变”。后续输入已恢复自然协作，DeepSeek 模型选择按用户要求保留，全部验收房间和文件保留。详见 [R176](../reviews/r176-beta25-real-environment-20261103.md)，本机完整报告/证据 `dist/r176-real/`。本轮未改产品源码、打包、推送或覆盖安装；后续若继续应优先处理终稿格式/研讨整合失败，文件范围控制需先明确原生完整权限的边界。

## 2026-11-03：R175 Codex 内部会话自动归档（beta.25 已打包发布，未覆盖安装）

用户确认“调用结束自动归档、续接前恢复、旧记录按精确 ID 整理”。Codex 适配器新增终态后异步空闲核验/有界归档，下一轮读实际归档位置、恢复并原生续接同 ID/模型/权限/常驻指令；在途、UNKNOWN/未确认空闲和旧连接不归档。归档失败不覆盖任务结果或重放模型，回执丢失后读取实际状态；维护与业务共享握手，维护握手超时废弃旧连接。新后台每 tick 最多整理一条本数据根中有正式终态证据、同成员无在途的精确历史 ID，并在归档前重查；随新版运行启用，未先动旧版依赖的会话。其他渠道策略保持。

最终完整跟踪回归 **364 文件过/2 跳；3252 通过/3 预期失败/16 跳/0 非预期失败**；本轮新测试 23 项过，含实际后台 tick/SQLite 历史资格。官方 0.166.0 隔离元数据验证通过（空会话关闭归档→历史整理→新进程恢复同 ID→再归档且 JSONL 保留，0 模型）。跟踪类型/lint/UI 构建通过，根类型仍仅既有未跟踪 R130 的 13 条错误，schema61不变；首轮夹具/握手 4 失败已修正后冻结全量复过，旧日志保留。见 [R175](../reviews/r175-codex-thread-history-20261103.md)，证据 `dist/codex-thread-archive-20261103/`。

**打包发布 beta.25**：程序 `2504c57` clean、源 BUILD `bld_8a664695d9ee11d4`、安装 BUILD `bld_8ad9a950787fc6a9`、667 文件完整 hash 通过。EXE `dist/installers/Zhongshuo-Setup-0.1.3-beta.25-x64.exe` 160164912 字节，SHA256 `b88d16466cd1359dbd6c78de695c9f5cfe8b1f11344b0a799aa9f1b7993e7c92`，附校验/发布元数据。干净快照双类型、Codex149/版本入口11、实际包内两轮私信归档/续接及重启历史整理16、恢复15、界面3场景通过；真实模型0（归档专项中2条台账为本地协议模拟）。已推 main 并发布 GitHub [v0.1.3-beta.25](https://github.com/384615666/zhongshuo/releases/tag/v0.1.3-beta.25)，Latest/3附件服务端hash匹配，tag=程序提交；未覆盖安装。**首轮界面测试漏传隔离数据参数，误连默认数据根并触发2条归档，已正式停机并撤销归档，复读确认恢复；任务/消息/会话行数相同、integrity=ok、0新增模型台账，原日志保留。修正后隔离UI/停机全部过；不得声称从未访问用户数据。** 详见同一R175记录。

## 2026-11-03：R173 beta.23 后四项界面修正（beta.24 已出包并发布，未安装）

beta.23 安装后用户反馈 4 项：①文件/Git 页右上项目下拉太丑 ②看板 ×/清空文案应叫「归档」、去掉「已隐藏 N 项」、恢复改撤销且只撤销上一个操作 ③成员页切项目左卡「N 个房间」偶尔闪 ④成员页切项目右侧成员列表闪。

实现：文件页原生 `<select>` 换成全站共享 `Select`（`pages-misc.tsx` + `.fg-topbar-project` 宽度约束）；看板文案统一归档（×=归档、归档本项目、归档全部，提示如实说明只收起看板卡片、任务保留，可原对话串打开），删除所有「已隐藏 N 项」，撤销只回退最近一次归档（内存记录 taskIds，撤销后入口消失、不做恢复全部，localStorage `zs.board.hidden.v1` 结构不变），新增 `unhideTasks`、删除 `restoreAll/hiddenCount`，选择器改为 `data-zs-board-remove/-archive-project/-archive-all/-undo`；成员页新增 per-project 房间数/房间列表/成员/runtime 缓存与 per-project+room 房间名单缓存，切回已看过的项目先用缓存、后台替换；成员装载错误改 `{projectId,message}`、房间名单错误键改 `projectId:roomId`；`useMemberWorkload` 加 per-project 缓存（切回不闪「尚未读到」）。截图脚本新增 members-no-flash/board-archive/board-undo 场景并移除旧 board-hidden。未改 daemon 事实、未动用户数据、零真实模型。

验证：`tsc -p tsconfig.hifi.json` 0 错；改动文件 lint 0 新增（pages-misc 仅既有未用导入）；`memberChannelsR136`+`boardView`+`boardFormalStates` 3 文件 12 项、board.view 相关 5 文件 87 项通过；截图 `node scripts/capture-r170-ui.cjs --run=r172-a` 15 场景全过：members-no-flash 采样 1.2s 的 `missingRoomCountFrames=0/emptyMemberFrames=0/loadingTextFrames=0`，board-archive 无旧「已隐藏/清空」文案且撤销可见，board-undo 卡片 4/撤销消失；全量测试 **368 文件过 / 2 未跟踪 R130 夹具失败 / 2 跳过；3337 通过 / 8 失败 / 10 预期失败 / 16 跳过**，跟踪测试 0 非预期失败。见[R173](../reviews/r173-ui-feedback-20261103.md)。

**打包交付（0.1.3-beta.24）**：版本 `0.1.3-beta.24` / Windows `0.1.3.24`；干净 worktree `dist/r174-source`（commit `4ec2820`，status 0 改动）构建，镜像 BUILD `bld_5ce11884ed36636c` clean、667 文件、MANIFEST 667/667 SHA256 逐文件通过；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.24-x64.exe` 160,186,549 字节 SHA256 `b8f4719a3773c11e5fc7589469f7fc8d832ddc76ec6dcd244c343d0f75424994`，附 `.sha256`/`.release.json`。包内界面 15 场景全过（members-no-flash 0/0/0、board-archive/undo 一致），隔离库 `real_calls=0`。已推 main 并创建 GitHub Release `v0.1.3-beta.24`（安装包 + sha256 + release.json）。**未安装覆盖用户版本；Windows 通知图标仍待真实安装环境目视。**

## 2026-11-03：R171 用户七项界面改进（beta.23 已出包，按用户要求打包提交，未安装）

beta.22 安装后用户提出 7 项：①成员管理改私信式三段式、每个项目一张独立卡片（不再一张大卡里塞 4 条）②成员管理选中项目脱离侧栏联动 + 侧栏点项目名改回收缩房间列表 ③切项目时左卡「N 个房间」不再先闪 0 ④文件「打开」按钮四边圆角 ⑤「查看变更」与「打开」换位、打开固定最右 ⑥预览顶栏去掉「会话资源」与下载按钮 ⑦线程顶部执行横幅尽量一行。

实现：MembersPage 改 280px 独立项目卡列 + 1px 列分隔（≤980px 横条）；页内 `selectedProjectId` 解耦（成员/房间名单/模板/工作量按页内项目取数，房间列表改本地 `command('room.list')`，不读全局 store.rooms；URL replace 同步但不切全局焦点）；`useFormGuard(projectId,{scopeProjectId})` 可选页内作用域（默认不变），编辑资料/模板/AI 设置/添加 AI 透传；MemberDetailPage 删除路由≠active 就 switchFocusProject 的 effect 并透传页内作用域；App.tsx 侧栏项目名点击改回 toggleProjectExpanded（项目切换走房间点击/项目 ⋯ 菜单/顶栏）；房间数在就绪前不显示数字（当前项目=本地 room.list，其它=sidebarRoomIndexes ready，读取中沿用上次真实值）；`.open-split` 改为仅复合态拍平相邻角（单独「打开」四边圆角）；文件卡与改动行按钮顺序改 查看变更→打开；预览路径行移除来源 Tag 与下载图标（下载仍在「⋯→下载原文件/另存为」）；ExecutionStatus 线程横幅把详情与「下一步」收进同一行（单行省略、完整内容进 title）。截图夹具扩为 4 个隔离演示项目 + members-switch 场景。未改 daemon 事实、未动用户任务/聊天、零真实模型。

验证：`tsc -p tsconfig.hifi.json` 0 错；lint 0 新增（既有 react-hooks 规则缺失与 PreviewPane 旧导入保留）；成员 16 文件 120 项、导航/侧栏 7 文件 34 项、执行状态/阅读辅助/文件卡 4 文件 23 项通过；截图 `node scripts/capture-r170-ui.cjs --run=r171-b` 13 场景全过（`dist/r170-ui/r171-b/`）；全量测试 **368 文件过 / 2 未跟踪 R130 夹具失败 / 2 跳过；3337 通过 / 8 失败 / 10 预期失败 / 16 跳过**，跟踪测试 0 非预期失败。见[R171](../reviews/r171-ui-feedback-20261103.md)。注意：侧栏项目名语义已改，旧验证脚本（verify-dm-project-r158 等）若复用需同步。

**打包交付（0.1.3-beta.23）**：版本 `0.1.3-beta.23` / Windows `0.1.3.23`；在干净 worktree `dist/r173-source`（commit `d9c280b`，status 0 改动）构建安装包，镜像 BUILD `bld_09d752536839d99b` clean、667 文件、MANIFEST 667/667 SHA256 逐文件通过；安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.23-x64.exe` 160,169,680 字节 SHA256 `26b048812da099774e2ac08ba3793cb7071d4fd5105e77c4336818915e26d8c8`，附 `.sha256` / `.release.json`，PE 版本资源与产品名正确。包内界面核对：用镜像内 `resources/app/dist/ui/main.cjs` 在隔离数据下跑 `dist/r171/package-ui.cjs`，13 场景全过（成员 4 张独立项目卡、页内切项目、文件卡圆角/顺序、预览顶栏精简、横幅单行）；隔离库 `real_calls=0`，未触碰用户数据。已推 main 并创建 GitHub Release `v0.1.3-beta.23`（安装包 + sha256 + release.json）。**未安装覆盖用户版本；Windows 通知图标仍待用户在真实安装环境目视。**

## 2026-11-03：R172 R170复核修复与beta.22发版（仅交付，不安装）

按用户授权修复 R170 的长文本二维 diff OOM、空文件误判缺失、编辑器异步启动错误，以及打开方式缺少系统关联应用：有界精确比较/整段退化/上下文折叠/500行分批、空值三态保留文本、spawn/error 完整处理、按扩展名 COM Shell 枚举与调用/默认程序/迟到丢弃/VS Code 别名去重。复用随包 koffi；消息弹窗通栏。截图工具改正式 quit，旧主进程 VM 夹具补新模块映射。保留 R170 十一项界面调整，schema61不变。

冻结04165ea clean，最终完整364文件（362过2跳）3229通过/3预期失败/16跳/0非预期失败、双类型与本轮lint0。包内专项13、界面12、后台IPC15、667hash过，中文空格路径受控程序实际启动；实际包内native依赖隔离开发查找后加载通过；退出0/无强杀/零模型。首轮13项旧夹具加载失败修正后全过，首包发现VS Code重复后已重包并完整重跑。BUILD bld_fe5703ce33721e0e，EXE160166438字节SHA32541259…，根dist/installers附校验/元数据。推main并发布GitHub v0.1.3-beta.22，tag指向程序04165ea；文档后补不改程序身份。遵循用户「先交付安装包，暂不安装」；未改原数据/继续原任务，真实Windows通知图标仍待安装环境目视。详见[R172](../reviews/r172-r170-followup-beta22-20261103.md)。

## 2026-11-03：R170 用户十一项界面反馈（仅源码，未打包未安装）

用户同日反馈 11 条：①Windows 通知图标不是 logo ②成员管理改左边项目卡片+右边 AI 列表 ③任务看板卡片重排 ④看板单卡移除/清空项目/清空全部 ⑤设置页删「通用/对话串通知/AI 成员」并重排 ⑥文件「⋯」去掉摘录/评论 ⑦预览路径改绝对路径 ⑧文件名右键：打开文件夹/默认程序打开/关闭/关闭其他/关闭全部 ⑨文件页/顶部栏/对话顶部栏高度统一 ⑩查看变更红删绿增 ⑪对话串/私信「打开文件」加展开菜单（程序打开+复制相对/绝对路径）。

实现要点：通知显式携带随包 `.ico`（AUMID 注册沿用 R163；真实 Toast 图标待用户目视）；成员页两栏（左项目卡、右 AI 列表，≤980px 横条）；看板三行卡片 + 仅 localStorage `zs.board.hidden.v1` 的看板隐藏（不删任务/不改状态/不发写命令）；设置页删除三段（启动自动打开项目、按串静音、设置页成员列表入口随删，后台数据与命令保留）并改为五分区单页；预览移除摘录与文件评论入口（`actions-preview` 命令函数保留）、路径行显示绝对路径+复制、标签右键五项菜单、文件页三条横带合并为 42px 顶栏（与房间页一致）、变更弹窗用行级彩色 diff；消息文件卡「打开」复合按钮 + 主进程探测的本机打开方式（资源管理器/VS Code/IntelliJ IDEA/PyCharm）+ 复制相对/绝对路径（`src/ui/localOpeners.ts`，IPC `zs:local-files.*`，仅可信窗口、只接受已存在绝对文件路径、可执行文件由固定清单解析）。样式按工作流拆 `styles/r170-*.css`，由 `build-ui.mjs` 合并；未改 daemon 事实、未动用户任务/聊天、零真实模型。

验证：`tsc -p tsconfig.hifi.json` 0 错；根 tsc 仅既有未跟踪 R130 夹具 13 条旧错（`src/` 0）；全量测试清掉本机 `ELECTRON_RUN_AS_NODE` 后 **366 文件通过 / 2 未跟踪 R130 夹具失败 / 2 跳过；3317 通过 / 8 失败 / 10 预期失败 / 16 跳过**，跟踪测试 0 非预期失败。截图 `node scripts/capture-r170-ui.cjs --run=b5` 12 场景全过（`dist/r170-ui/b5/`：两栏成员页、看板与清空恢复、五分区设置、42px 文件顶栏、打开方式菜单、彩色 diff、绝对路径、标签右键菜单、更多菜单已无摘录/评论）。新增测试 `tests/browser/localFilesR170.test.ts`（9 项）。见[R170](../reviews/r170-ui-feedback-20261103.md)；施工单 `docs/implementation/r170-ui-feedback-plan.md`。**未打包、未安装、未触发真实通知**；下一步若用户要包，需先按既有流程打包 beta.22 并请用户目视通知图标。

## 2026-11-03：R169 中断检测与继续任务提示（beta.21已出包，仅交付）

恢复列表补用对话执行事实检测UNKNOWN根任务，侧栏同步、保留原保护/撤销/门禁事实；摘要跳过动作推导。当前中断源/任务版本/停止代次绑定的显式继续，在旧恢复队列已done且无任何新turn/协作执行、有正式源记录时可建新意图，旧行/真实执行不重放。按钮可读提示并刷新，旧详情/私信内部拒绝说明同步转换；普通中断旧retry兼容，无资格仅查看。

最终361文件3198过/3预期失败/16跳/0非预期失败，双类型过，lint新增0（既有12保留）；Electron26+批量22、包内后台IPC15/15与667hash通过，正常退出0、零真实模型。程序8561bdb clean/BUILD bld_f90e7bfad007baa3；EXE160155746字节SHA47a9fe87…，根dist/installers。已推main、仅交付不安装。初轮并行6文件超时及2动作类型失败已修正/限并发完整重跑；普通中断补丁后再完整通过上述3198。原界面只读查看未代恢复，原独立库查询未匹配界面任务，不冒称原串已恢复。见[R169](../reviews/r169-recovery-visibility-20261103.md)。

## 2026-11-03：R168 room.list 15秒超时（beta.20已出包，仅交付）

用户清旧开发文件后出现多项目room.list超时，清理结束仍在。只读核对安装beta.19的667清单文件全一致；独立后台认证仍被拒，未操作用户任务/数据。定位R163把完整执行动作资格查询放入每5秒项目房间状态刷新：历史outbox/子树反复扫描。隔离10根/100子/12000事件/100历史outbox为5351ms/1021查询；新增includeActions=false供房间摘要、待办筛选/原因使用，同数据69ms/331查询。执行事实不变，详情/正式动作仍全守卫，不延长超时或隐藏错误。

最终定向9文件162过、双类型过、lint新增0（commands旧10条保留）。包内随包Node/daemon正式IPC12/12过，同规模5次room.list为51/47/49/47/48ms，退出0/零模型/历史任务保持；667hash过。程序b86187b clean/BUILD bld_d78e51b50323df05，EXE160170202字节SHA81c60459…，根dist/installers附校验元数据。已推送main，仅交付beta.20不安装；本轮未重跑上轮全量/GUI49项，原项目尚待复测。清理完成后复核安装19仍667文件全一致。新建dist/r168诊断目录曾消失，证据留独立诊断目录，不据此归因清理。见[R168](../reviews/r168-room-list-timeout-20261103.md)。

## 2026-11-03：R167 房间顶部合并成一行（beta.18 已出包，按用户选择只交付安装包）

按用户「房间页两条顶部栏叠着太丑」：把房间头与页签行合并成一条 42px（`对话池 任务看板 文件 …… 3 条未读 ｜ Claude · 2 名成员`）；房间名去掉（侧栏已高亮）、房间 ⋯ 去掉（房间设置/归档走成员入口）、成员入口移到最右；≤1080 收紧内边距，≤960 隐藏未读并压页签内边距。只改 Room.tsx 与 components.css，窗口栏/侧栏/设置/私信未动。此前整窗栏改造（commit 036c74e）已被用户否决并在本地回滚，从未推送或打包。

**验证**：干净 worktree 全量回归 **355 文件 / 3154 通过 / 0 失败**（3 预期失败、16 跳过）；开发态 1360/1100/900 三档 `.pool-head--merged` 高 42px 且无横向溢出；打包镜像内隔离验证 **17/17**（版本、单条合并行、房间名/⋯ 不存在、成员为末位、列表紧接、对话串回归、私信白底、设置六段、停机 exit 0）。**交付**：0.1.3-beta.18（Windows `0.1.3.18`），安装包 160,163,958 字节 SHA256 `b69e1e21…`，源码 `3ddae73` clean / BUILD `bld_56274088f1d6e0e6` / 667 文件 hash 全过；未做静默安装（用户选择只交付包）。见 [R167](../reviews/r167-room-head-merge-20261102.md)，证据 `dist/r167/package-qa-e12dd1f5/`。

## 2026-11-03：R166 历史受阻待办与四份纯文字回复（beta.19 已出包，仅交付）

按用户反馈：待办只读筛选当前任务/协作轮，隐藏已结束祖先或新轮替代的旧失败，受阻父子只列一次；真实未知/保护/活动与队列保留。纯文字已完成步骤使用最新成功turn正式终稿绑定作为交接，全部收齐后一次入汇总队列，旧缓存/旧父请求不重唤醒，工作交付、预算、停止与文件保护不变。侧栏六种图形/七种状态说明已补手册。磁盘安装版本17，独立后台认证仍被拒，未实际处理截图原串/原库。

有效修前3失败复现；最终完整358文件3163通过/3预期失败/16跳过/0非预期失败，双类型过，lint新增0（commands既有10条保留），包内49/49及667hash过。程序41b1127 clean/BUILD bld_23d934629afc8123，EXE160157970字节SHA6fbc70c2…，根dist/installers附校验/元数据。完整回归代码快照1f3ab78与最终41b仅文档差异。最终暂存改用C盘，原D盘空间不足/清理被策略拒绝、跨盘依赖路径检查失败记录保留，官方--source-image流程最终全过。保留其他AI beta.18页头合并。已推送main，仅交付beta.19未安装；原库独立认证仍失败，未代恢复截图原串，不冒称原串现场验收。见[R166](../reviews/r166-pending-conversation-handoffs-20261103.md)，证据dist/r166/。

## 2026-11-02：R163 beta.16 反馈与 beta.15/.16 审计（beta.17 已出包，按用户选择暂不安装）

按用户七项反馈修复 Windows 通知来源身份注册、私信仅圆形未读数、本人消息排除与前台渲染后自动已读、跨展示项目总数>20后的5/+10折叠、房间实际执行投影与侧栏独立刷新。明确修正 R161 的单项目门槛理解。审计 beta.14→15/16，修复原始 .lnk 字节/文件名误删风险、首通知晚建入口遗漏、固定任务栏重启丢失显式数据根；设置精修和白色私信底保留。schema61不变，无模型调用。

最终冻结完整357文件，3154通过/3预期失败/16跳过/0非预期失败；包内49/49、667hash、双类型/lint新增0、界面19+21+18+14、手册07/25过。首轮4份旧夹具16失败已同步并完整重跑，记录保留。程序d78b4aa clean / BUILD bld_6235d2fc878e5e19；安装包160164193字节SHA0641dbb3…，根dist/installers附校验与元数据。代码/测试已推送公开main，后续文档只补证。

安装前独立凭据被拒、运行库只读结果与界面不一致且integrity异常；已保留ignored原始DB/WAL/SHM快照，未修库/迁移。旧版内置备份因DATA_LINK_REFUSED（目录联接）失败并按原流程重开，未强杀/未覆盖安装，不能宣称完整备份成功或数据前后校验通过。用户明确选「先交付安装包，暂不安装」，当前安装仍beta.16。Windows隔离Toast show成功/身份注册过，**来源标题未目视**。后续安装须先正常退出、重新核对真实根与完整备份，不自动修复原数据。详见[R163](../reviews/r163-beta16-unread-room-audit-20261102.md)，本机证据dist/r163-*。

## 2026-11-02：R162 开始菜单名字、主区底色与设置页精修（0.1.3-beta.15）

用户装 beta.14 后反馈：①开始菜单里名字还是「Electron」②私信背景色与房间/回复串不一致③设置页排版粗糙要精修；另要顶部栏设计方案（先不开发），最后打包发版。

- **开始菜单**：根因不是安装器写错，而是两枚早期未品牌化构建遗留的快捷方式（`Electron.lnk` 带便携 AUMID、`ElectronApp.lnk` 带安装版 AUMID，都指向安装目录 Zhongshuo.exe），Windows 按 AUMID 去重后显示成 ElectronApp。本机备份后删除并 `SHChangeNotify`，`Get-StartApps` 立刻变「众说/卸载众说/众说操作手册」。安装器 `[Code]` 新增 `RemoveStaleAppShortcut`：只在目标 `TargetPath` 等于 `{app}\Zhongshuo.exe` 时删除同名快捷方式，删后刷新 Shell。
- **私信背景**：私信页根节点原来是无底色的 flex div，透出窗口底色 `#F2F8FB`（房间/回复串是 `#FFFFFF`）。改为 `<div className="main">` 后三处主区一致（实测像素 `#F2F8FB`→`#FFFFFF`）。
- **设置页精修**：页头吸顶（吃掉 `.page` 顶部留白避免漏缝，`scroll-margin-top:104px`）；搜索结果改浮层；每个分区按卡片分组（启动/显示+我的头像/桌面通知+对话串通知+投递记录/调用次数预算+同时运行的AI+AI成员/数据位置与备份+草稿+归档与项目/手册链接+版本+诊断）；主题与显示头像移入右列；重试清理/导入/已移除项目按钮右对齐；「桌面通知」不再重复、状态行去重（挂 data 属性）；投递记录收进折叠区；帮助页诊断块不再卡中卡；段间不再画第二条线（页头已有一条），段距 34px、卡距 12px、卡内标题距 8px。
- **顶部栏提案（未开发）**：`docs/design-proposals/titlebar-r158.md`——按真实类名实测（房间页 38+38+42≈118px 才见首卡；左右两列内容起点差≈38px），给出 A/B/C 三方案、推荐路径（先 B 后 A）与 10 条几何验收标准。

**验证**：完整回归 362 文件 **3252 通过 / 7 失败 / 10 预期失败 / 16 跳过**（7 项仍是本机未跟踪 R130 混沌夹具缺旧目录数据，跟踪测试 0 失败）；设置页 7 档窗口 Electron 校验、排版断言 10 项、安装器清理契约 2 项通过；hifi 类型与改动文件 lint 0 条；`build:ui` 与精修前后截图已目视。**交付**：beta.15 先出包（160,162,399 字节 SHA256 `6cf557a1…`，程序 `399607d`/BUILD `bld_fe631446668cab10`/667hash，包内 14/14）后，发现开始菜单错误项仍可能被系统重新落盘（21:17 再次出现 `ElectronApp.lnk`），随即补 **运行期自愈**（安装版启动清同名错误快捷方式 + 4 秒复查）与 `setAppDetails` 的 `relaunchCommand`，并以 **0.1.3-beta.16** 取代 beta.15：安装包 160,156,369 字节 SHA256 `dca38be2…`，程序 `5f464bf` clean/BUILD `bld_ecb37cd98d922a0a`/667hash，包内隔离验证 14/14，且**实测**：手工放一枚指向包内 exe 的 `ElectronApp.lnk`，启动包内程序后被自动清除。未做静默安装以免改写用户 beta.14 登记；已推送 main 并发布 GitHub Release（latest）：https://github.com/384615666/zhongshuo/releases/tag/v0.1.3-beta.16 。详见 [R162](../reviews/r162-settings-polish-dm-surface-20261102.md)。

## 2026-11-02：R161 直接图钉与项目列表显示更多

用户不要单项菜单/右键：房间与私信行尾改为直接图钉，点击切换置顶，移除右键和私信标题菜单重复置顶入口；原归档/重命名等标题操作保留。单项目普通房间/私信>20时显示5，每次更多+10至全部；<=20全显，项目各自展开、重开分组恢复默认，置顶独立、归档私信同规则。

定向34、新窗口21、更新R160窗口18、R159窗口14、双类型/lint新增0及手册25截图通过。只涉及前端展示，未重跑/冒用上一轮3138全量。最终包内44项全过，含真实26房间/26私信逐步展开；beta.14已按既有授权推送main、覆盖安装并打开，未建Release。详见[R161](../reviews/r161-direct-pin-project-lists-20261102.md)，本机证据dist/r161-*。

程序22cc0f9 clean / BUILD bld_a102470b48df9ac6 / 667hash；EXE160158078字节SHA10ec99cfe686394bb76c45015fdc489d662259c27517f6fd8ff77f15097e0c6b，根dist/installers附校验/元数据。旧版后台和UI均正常退出、无强杀，完整备份4484文件+2联接逐hash/目标一致；安装exit0/原DB字节不变，启动同根/schema61/integrity=ok，业务/聊天/调用3/3/3/3/3/6/3保留，0模型重放。有效备份dist/r161-delivery/pre-upgrade-backup-1793618403762/仅本机ignored，用户置顶对象未代选；交付文档提交仅补证。

## 2026-11-02：R160 房间与私信独立置顶

按用户截图实现：房间跳出项目子列表置于项目上方，私信跳出项目分组置于私信上方；取消回原组，显示所属项目，折叠/隐藏不遮住，跨项目按ID进入。列表更多/右键和私信标题更多均可操作，头像/时间/未读/执行态保留，隐藏项目仅计置顶私信未读。偏好按viewer/client持久于daemon_state，schema61不变；navigation.pin单目标事务/幂等及重放权限核对，navigation.get投影有效目标，普通导航不覆盖置顶；防连点、迟到快照与未知回执重试覆盖。

原生交互17项与原R159的14项、最终定向34项、双类型/lint新增0、手册第25张截图通过；冻结8106125完整353文件（351过/2跳）3138通过/3预期失败/16跳过/0非预期失败，exit0；首轮重放用例1失败已补守卫后从冻结源码重跑，失败记录保留。最终包内35/35通过，含实际历史加载与刷新后置顶保留。详见[R160](../reviews/r160-conversation-pins-20261102.md)，本机证据dist/r160-*。

按本会话既有授权，beta.13已推送main、实际覆盖安装并打开（未建Release）。程序8106125 clean / BUILD bld_225d3a10babec292 / 667hash；安装包160144362字节SHA7391f6dc0b33fd58bd44fba52e354d50ce198c9a3fd137c1b9024e1ea9028621，根dist/installers附校验与元数据。原daemon正常exit0/closed，无窗口UI残留未正常收尾，仅结束三个已核对的旧界面进程（没有强杀daemon或任务）。有效完整备份4485文件+2目录联接、逐hash/目标一致，安装exit0/原DB字节不变；启动同根/schema61/integrity=ok，业务/聊天/调用3/3/3/3/3/6/3保留，0模型重放，未代选置顶对象。有效备份dist/r160-delivery/pre-upgrade-backup-1793616345910/及现场事实仅本机ignored，早期未通过副本不作依据；后续文档提交仅补证，不改包内程序身份。

## 2026-11-02：R159 分组私信、默认头像与按需发现

按用户五项反馈：默认图映射 Claude2/DeepSeek1/Codex3/Pi9，自动旧图修正带显式选择标记与原图CAS；可见项目私信独立缓存分组、最近回复排序及四类时间，各组加号、选成员即创建，连点/同号重试/关闭后迟到保护；成员和看板宽屏网格靠左。用户确认第5项一并调整：DIRECT、DM、DELIB只带项目目录与按需发现说明，不再自动递归注入全文件名，明确附件和权限保留。

定向76项、最终14项原生窗口交互、双类型/新增0 lint、手册07截图与UI/daemon构建通过。完整跟踪351文件3134通过/3预期失败/16跳过/0非预期失败；最后仅追加非当前项目成员选择器默认图补齐，定向76/UI14再次通过，未宣称最后补丁后重跑全量。最终包内隔离25/25通过，版本beta.12已按本会话授权推送、实际覆盖安装并打开。本机证据 `dist/r159-*`，详见 [R159](../reviews/r159-grouped-dm-avatars-discovery-20261102.md)。

程序423218f clean / BUILD bld_985a4885b2aefc75 / 665文件hash全过；EXE160070906字节，SHA256 33661f3d325e2f2a4561d083e41d3216dd9d9968b8a2ab044bd934f682fb64c4，根dist/installers附校验/元数据。安装前完整备份4484文件逐hash一致；安装exit0、原DB字节不变，实际安装665hash通过。启动后原数据根/schema61/integrity_check=ok，项目/房间/任务/工作流/轮次/消息/调用为3/3/3/3/3/6/3均保留，0新增模型调用或重放；默认头像按要求补齐。原生窗口三项目私信分组已显示、程序保持打开。备份与现场证据留ignored dist/r159-delivery，不上传运行数据；已推送main，未建GitHub Release。后续交付文档提交仅补证，不改变包内程序身份。

## 2026-11-02：R158 项目归档、私信头像/状态与项目切换

项目归档/移除允许无在途或排队请求的历史失败记录保留归档，不改 ACTIVE/BLOCKED 或错误历史；真实 OPEN/排队/运行/待处理、未释放 UNKNOWN 与保护继续拦截，已释放旧 UNKNOWN 不永久阻止归档。私信 loader 保留 peerMemberId，列表直接按成员身份取头像；当前私信隐藏「打开私信」，普通完成横幅隐藏、待验收保留。项目名称切换、小箭头展开收起分工，私信/成员页切项目保留页面类型，顶部项目菜单同入口、展开偏好与迟到隔离保留。手册同步。

定向7文件69项、隔离Electron原生点击10/10、hifi类型/跟踪主工程类型0诊断、lint对HEAD新增0、手册生成/build:ui/diff通过；完整跟踪348文件（346通过/2跳过）3125通过、3预期失败、16跳过，0非预期失败（退出0），日志 `dist/r158-tracked-tests.log`。默认根类型仍为既有未跟踪R130夹具13错。界面证据 `dist/r158-dm-project/1793602400250/`，已目视普通私信完成与项目切换；0模型、未改版本/打包安装/提交推送。

只读查询安装版常用数据根时任务表返回 SQLITE_CORRUPT，不能确认截图中那个项目的实际任务；没有修复/导入或改写原库、归档原项目、重放任务。后续现场诊断须保留原件，不能将隔离库通过当成原库恢复。详见 [R158](../reviews/r158-dm-project-archive-20261102.md)。

用户随后授权「推送打包安装给我测试」：0.1.3-beta.11 已实际覆盖安装并打开。程序源码 `5f9c285` clean / BUILD `bld_1959944f73bcdd45` / 665 hash 全过；EXE 160100067 字节，SHA256 `b50d373614e2489f3c1174863aaf3b840943b6f109c8e45bc7fc1a10f98c4139`，位于根 `dist/installers/`。追加版本3/包内隔离20项通过。旧版正式停机 exit0、无强杀；完整本地备份4455文件逐hash一致，安装期间原DB字节不变；新版同数据根/schema61、健康与数据库integrity_check均通过，业务/聊天/调用行数保留、0新增模型调用。此前SQLITE_CORRUPT本次关闭后备份与新版运行库均未复现，未修复/迁移或改写任务；未代归档原项目。公开main已推送（交付文档后续提交仅补证，不改变包内程序身份），未建GitHub Release。备份及本机证据留ignored `dist/r158-delivery/`，不提交。

## 2026-11-02：设置单页化、通知总开关与外部链接（0.1.3-beta.10）

用户要求把应用设置整合成一页（通用/外观/通知等不再作为独立菜单）、隐藏「打开一个定位链接」与整段「连接与设备」、通知加开关、去掉 AI 设置里的本机运行状态详情、操作手册改为外部打开 HTML、帮助与关于加 GitHub 与主页、清掉开发过程文案，最后打包发版。

- **单页设置**：六个分区自上而下排在同一页（`.settings-single`/`.settings-section`），左侧分区菜单移除；页头保留搜索（命中滚动到具体行并高亮）；`?section=` 深链改为滚动定位（`guide/manual→help`、`connections/lan→general`）；正文宽 900px 居中，≤760px 时设置行改上下排。
- **隐藏/删除**：通用里的「打开一个定位链接」整块移除；「连接与设备」整段从界面移除（后端命令保留）；AI 设置不再显示「运行环境详情 → 本机运行状态」。
- **桌面通知总开关**：新增 `ui.taskNotifications.enabled`（app.settings 白名单，未设置=开启）。关闭时 daemon 在下一次 poll 把 pending 全部转 suppressed（`last_error='桌面通知已关闭'`）并返回空 items，游标照常推进，**重开不补发旧通知**；渲染层按 store 投影决定是否 `show`，关闭时只轮询不弹窗。
- **外部链接**：新增 `zs:open-app-link` 窄 IPC（`assertTrustedSender` → 枚举 `manual|github|homepage` → `resolveAppLink` 白名单）；手册固定指向随包 `renderer/user-guide/index.html`（先校验存在，缺失如实报错不回退外网），GitHub/主页写死 https；设置页「帮助与关于」新增手册与项目链接卡片，应用内不再嵌 iframe。
- **文案**：通知空态改「暂无单独设置的对话串。」，删除「还没有设置过对话串通知…」；帮助段删除内部偏好键/本机用户 ID；通知读取态改用户可读措辞；R149 护栏补本轮点名字面量。
- **测试**：新增 `settingsSinglePageR157`(7)、`appLinksR157`(16)、`notificationSwitchR157`(6)；改造 R152 设置布局校验（7 档窗口、深链滚动、手册桥调用）与 R153 并发面板校验（单页不再卸载面板）；为 15 个旧测试/校验脚本补 `.png` loader（头像功能引入的 esbuild 缺口），`roomReplyPreviewR102` 排除后台头像读取。
- **手册**：第 11/14 章与托盘说明改写，重采集 `13/14/15/18/23` 五张并新增 `24-settings-help-dark`，删除已不存在的 `24-settings-guide-dark`；`user-guide-scenes.js` 同步。

**验证**：完整回归 356 文件 **3220 通过 / 7 失败 / 10 预期失败 / 16 跳过**；7 项失败全在本机未跟踪的 R130 混沌夹具（缺旧目录历史包数据），跟踪测试 0 失败。hifi 类型通过、根类型仅既有 13 条未跟踪夹具错误、lint 相对 HEAD 新增 0、`build:ui` 成功、手册截图全部命中并目视。详见 [R157](../reviews/r157-settings-single-page-20261102.md)。

**交付**：版本 0.1.3-beta.10（Windows `0.1.3.10`）。安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.10-x64.exe`，160,106,495 字节，SHA256 `18197ed8948e7205df5c2ebe1e2505b2a6b3279e151d104e5e4d809d316fe069`，程序源码 `fb26a2e` clean，安装镜像 BUILD `bld_5f6885bf512d64a`/665 文件 hash 全过，随包 EXE 版本资源回读为众说/0.1.3-beta.10。包内隔离验证 **18/18** 通过（独立数据根、假运行时、单页设置/通知开关/三个外链/深链滚动/正常停机 exit 0）。本轮未做静默安装（模板未改，安装会改写用户 beta.9 的 HKCU 登记与快捷方式），由用户从托盘退出旧版后覆盖安装。已推送公开 main 并发布 GitHub Release（latest）：https://github.com/384615666/zhongshuo/releases/tag/v0.1.3-beta.10 。

## 2026-11-02：恢复入口按需显示与一键继续

用户最终选择只要“一键继续”，成功后自动清空。恢复入口现在只在确有恢复事项时显示，普通排队/已处理历史不显示；弹窗批量按父任务去重继续任务和队列，未完成撤销先通过既有命令续跑，冲突保留具体提示。提交成功自动关闭弹窗并即时刷新隐藏入口，部分失败只保留剩余项，同号重试/批量与单条互斥/关闭后后台提交均覆盖。补 pendingRelease 的真实 taskId，修正只有 FAILED/retained 时无法载入任务的遗漏。聊天、文件与历史保留，无清空按钮。

最终相关7文件90项通过，新Electron22检查及原恢复交互通过，界面截图已目视、构建/hifi类型/仅跟踪主工程类型通过、lint无新增和diff检查通过；默认主工程类型仍有原未跟踪R130夹具13错。源码与界面构建完成，未打包/安装新EXE、未改用户运行数据或重放原任务，0真实模型、未提交推送。详见[交付记录](../reviews/recovery-bulk-20261102.md)。本次修改保留原有未提交续工内容及未跟踪文件。

随后用户授权推送/打包：beta.9安装器已交付根dist/installers（160184501字节，SHA256 ce8b2f91b5e97608c0a1502f5824d17a815a36597fdec347520189a74972c8b4），程序冻结2006687 clean/BUILD bld_0ecbd85ae8bec21f/665文件hash全过。实际安装隔离45检查通过、正常停机重开及卸载保留合成数据，原登记四快捷方式/文件/进程精确恢复，0任务/轮次/真实模型。完整345文件3079通过5旧UI夹具失败16跳过，头像PNG loader/默认头像写回夹具及旧搜索预期修复后最终9文件80通过；双types通过，未宣称最后重跑全量。两次后续提交只改测试，安装包程序身份仍为2006687。用户正常安装未覆盖、原业务未继续，未发GitHub Release。公开main推送结果以交付收口为准。

## 2026-11-02：R156 中断任务直接继续（替代 R155 前置检查）

用户明确不要依据表单、检查中断、保护解除及Windows重启前置，已改为原任务直接“继续任务”，串内发送跟进也自动处理旧中断；保留UNKNOWN历史和原文件，预算自动只处置一次、旧队列代次隔离、迟到结果不再改业务或重复结算。后台同事务释放本任务/协作子任务旧占用并入队；正在排队的新任务受其他旧中断影响时继续现有请求，不重跑旧任务或重复派发。恢复面板简化任务列表，启动不自动弹窗。旧取证API只为历史兼容，普通继续不依赖；安装器仍须托盘先退出。

beta.5已本地交付：程序93cb16c clean/BUILD bld_f894f04bf51593e3/665hash，EXE159495712字节SHA256 5d5088bd518d97cc0c13fd7713ba62f6d98670ba04b8a2b1d802077b71c56ea9，根dist/installers附EXE/校验/元数据。冻结源码全量344文件3082通过0失败16跳过；双types/lint无新增、direct46/UI20检查通过，实际安装42/42通过。原beta4登记与四快捷方式精确恢复，原安装/进程/数据保留，fixture0。用户安装后直接继续，不再重启Windows；原任务本轮未自动重放。详见[R156](../reviews/r156-direct-continue-20261102.md)，不推送发布。

## 2026-11-01：R155 中断检查与继续入口

用户仍被旧Pi UNKNOWN/settled/retained挡住，且“核对执行结果”没有对象。原库只读确认旧completed stop被beta2空stop覆盖，当前无history/stalelock、同次Windows启动；不能重新开app就补造退出依据。新增本机readonly recovery.inspect与具体结果/最后动作/退出检查，父按钮精确指child/turn，文案改检查中断；明确ready才release、保留UNKNOWN和历史、不重放。新增丢失旧owner证据时的Windows reboot程序证据，系统启动时刻+monotonic/时间边界/当前锁/进程代次及树/重读核验，不把睡眠或重开app当重启，允许真正新PID代次复用。无retained/no lease但UNKNOWN未闭环不再release noop，矛盾none登记拒绝。

用户这条仍须安装beta.4、保存其他工作并重启一次Windows，再检查中断→解除占用→回原任务继续；本轮不改原保护、不重启用户电脑/不执行原请求。安装器保持必须先退出再安装。完整343文件3040通过16跳过1旧夹具失败，补齐只读夹具后10文件60项/R135内部78检查通过；最终恢复6文件152项、inspection10项、UI23项、独立7场景及双types/lint无新增通过，不宣称最终源码重跑全量。

本地beta.4安装包已交付：程序5011619 clean/BUILD bld_d77fafd9e51e88c5/665hash，EXE159495307字节SHA256 311e6689a848e224eaa10909f36de81c090d4ef90643bcaaeffde69607f7fd16。最终实际安装42/42通过，健康/正式停机重开/卸载、包内inspect缺失轮次只读错误路径通过，0任务/轮次/模型；原beta3登记与四快捷方式精确恢复，原安装/进程/数据保留，fixture0。根dist/installers附EXE/校验/元数据。此验收没有解除用户原UNKNOWN；恢复仍按上述重启后显式操作。详见[R155](../reviews/r155-interrupted-recovery-20261101.md)，仅本地不推送发布。

## 2026-11-01：R154 协作交接与恢复诊断

本轮只读核实安装版真实记录，区分并行目录观察误归属、合法兄弟修订后旧版本校验、具体dispatchBlocked未显示和Pi无业务终态的正常停机中断。修复交接成果归属/旧污染缓存只读重投影、因果修订版本及启动前重校验、未启动成员的原因展示；正常停机证据事务保留last/history，仍须显式核查，不自动成功或重放。旧beta2已覆盖证据无法补造。用户最新决定取消自动关闭安装实验：安装器已恢复运行中拒绝安装，必须从托盘先退出，数据保留；实验helper/测试删除。

- 完整340文件2974通过17跳过0失败；独立复核追加同时同路径覆盖与前像提示追加两项边界修补，最终定向验证及产物身份见[R154](../reviews/r154-installer-handoff-recovery-20261101.md)。双types、改动代码lint通过。安装实验已结束，真实登记/四快捷方式/原安装进程全部恢复，0模型调用。
- 本地候选0.1.3-beta.3已完成：程序a8c2130 clean/BUILD bld_fe4c238a6d5bf64d/665hash，EXE159498304字节SHA26d488cb…；最后6文件105交接/兼容回归、恢复安装原逻辑34项与最终实际安装38项通过。安装→健康→停机重开→卸载/保留合成数据、原登记/四快捷方式精确恢复、原安装文件/进程不变，fixture0。根dist/installers含EXE/校验/元数据。用户当前安装/原任务未关闭重放，Pi旧UNKNOWN仍须核查；不推送发布。先托盘退出再安装。

## 2026-11-01：R153 输入右键、执行并发及过渡界面清理

完成输入/textarea/contenteditable 原生右键全选复制剪切粘贴菜单，按 Chromium flags/选区/只读/密码状态启用；执行准入原每项目/渠道2默认改全局/项目/渠道4，AI设置新增三项1–32持久并发上限，CAS/幂等/远程只读，更新只重查排队不释放在途或UNKNOWN及租约；正式父规划→同串四子步骤并发通过。去私信原界面入口和普通任务/房间旧指路，恢复撤销接正式命令；删除房间文件未接保存的假选区评论弹窗，真实文件级留言仍在附件预览菜单，明确新版没有定位批注UI。补设置页早于身份就绪挂载时的自动重读。

- 全量335文件2889通过16跳过0失败；最后仅前端身份订阅修补后8focused通过/组件26检查，双types/lint无新增；原生菜单13、导航49、最终安装器36检查通过。零真实模型，剪贴板未读写，未物理验证复制/剪切/粘贴，不重测MCP/Skill。
- beta.2程序源码4027968 clean；BUILD bld_50d8fd1be68d7d2f/665hash，EXE159491120字节，SHA256 b578c2edb969701eda0907d0c13f0a8d5ce1622ba90d94da3f2b9c92cb2730d8；dist/installers附EXE/校验/release.json。包内正式IPC和实际安装页4/4/4→保存→正常停机重开保留，卸载保留数据；原beta.1登记/四快捷方式精确恢复，原安装/进程/用户数据保持。
- 仅本地提交/整合，不推送发布。原未提交续工/66个未跟踪文件保留；需用户正常从托盘退出旧版后覆盖安装。详见[R153](../reviews/r153-edit-concurrency-cleanup-20261101.md)。

## 2026-11-01：R152 九项反馈与 0.1.3-beta.1 本地候选

完成 Windows X 隐藏到原生托盘/右键退出与常用入口；Harness 连接组件 0.1.3 持久归档及 metadata 分层等待（30/40/45 秒），实际包内正式 IPC 读取 19 模型；协调者先分工再做自己的子步骤、独立步骤一并入队；Office/PDF 交接自动从核实原件补建提取缓存；项目设置新增默认跨串并行/单写者/允许成员并行，migration061、真实权限/租约/恢复保护保留；修深色顶部栏、去图片常驻成功提示、统一手册与其他设置导航位置。根 README/首页及用户运行数据未改。

- 程序源码 `b941251` clean；完整回归 330 文件 **2871 通过/15 跳过/0 失败**（2 workers），双 types 通过，改动代码 lint 相对基线新增 0。原生托盘 9 项、UI 173 项、Pi 官方本地 6 项、组件协议/安装 20 项及正式附件/并发覆盖通过。零真实模型调用，未重测四渠道真实 MCP/Skill。
- 本地安装器 `dist/installers/Zhongshuo-Setup-0.1.3-beta.1-x64.exe`，159510960 字节，SHA256 `819a7158a84b5237b715360a7a1f64692476196b0c501aa74a6bf506a1bda570`；BUILD `bld_e5104766980335db`/665 文件全 hash 通过。0.1.2→候选→卸载隔离实测 71 项通过，schema60→61/聊天/草稿/附件/设置保留，外层恢复原 HKCU 登记和四快捷方式字节，原安装及运行进程未改。
- 未自动安装到用户正常入口、未迁移旧数据、未重放失败任务、未推送/发 GitHub Release。用户正常退出旧版后可覆盖安装。详见 [R152](../reviews/r152-nine-feedback-20261101.md)。

## 2026-11-01：R151 重写随包 EXE 版本资源 + 0.1.2 发版

用户要求在 0.1.1 任务栏图标修复后继续「重写 exe 并发版」：随包 `Zhongshuo.exe` 的 PE 版本资源仍继承 Electron（FileDescription/OriginalFilename/版本 44.4.5），任务栏与文件属性显示 Electron。

- **实现**：`scripts/lib/brand-executable.ps1` 增加 `ZhongshuoNativeVersion`（Win32 UpdateResource 写 `RT_VERSION`，en-US+zh-CN 两套 Unicode 串表，由独立 PowerShell 进程回读 `FileVersionInfo` 校验；`windowsHide`/`-NonInteractive` 下同进程读取会返回空值，已验证规避）；`brand-executable.mjs` 新增 `windowsExecutableBrand(release, originalFilename)`，便携 `electron.exe` 与安装镜像 `Zhongshuo.exe` 均写入；`installed-desktop.json` 增加 `nativeVersion`；`main.ts` 的 `setAppDetails` 增加 `relaunchDisplayName='众说'`；任务栏 AUMID 分离：安装版 `com.zhongshuo.desktop.app`、便携/开发 `com.zhongshuo.desktop.portable`（卸载 AppId 不变），避开旧 Electron 的 AUMID 名称/图标缓存；版本 0.1.1→0.1.2。
- **验证**：EXE 副本回读 ProductName/FileDescription=众说、FileVersion=0.1.2、OriginalFilename=Zhongshuo.exe、公司=众说开源项目，图标 7 帧回读通过；从 `299fcb4` 干净构建安装镜像 `bld_1a71ec20247c33c9`（661 文件，nativeIcon/nativeVersion 规范），安装器 159,327,758 字节 SHA256 `ab4a01c6…`；镜像 EXE + 新 AUMID 隔离启动任务栏显示「众说」；最终安装器隔离安装→卸载→恢复原 0.1.1 登记/快捷方式通过，全量 2911 通过 0 失败（仅未跟踪 R130 缺夹具 4 项）。
- **发布**：https://github.com/384615666/zhongshuo/releases/tag/v0.1.2 （latest；tag=源码提交 `299fcb4`，公开 main 同步；EXE/`.sha256`/`.release.json` 上传且 digest 与本地一致；未签名）。用户当前 0.1.1 安装与数据未动，需正常退出旧版后安装 0.1.2。
- 详见 [R151](../reviews/r151-exe-version-release-20261101.md)。

## 2026-11-01：R150 安装向导美化 + 0.1.1 发版

用户要求：把 R149 的 logo/文案修复做成新安装包发版测试，并重做「很丑」的安装程序。

- **安装器外观**：新增 `packaging/windows/branding/wizard-large-*.png`（164:314，七档 DPI）与 `wizard-small-*.png`（方形七档），由 `scripts/lib/wizard-images.ps1` 从根 `logo.png` 生成；`.iss` 用 `WizardImageFile`/`WizardSmallImageFile` 多档自动适配 DPI，显式恢复 `DisableWelcomePage=no`；删除默认 Inno 许可页与纯文本安装说明页（LICENSE/安装说明仍随包安装）；`[Messages]` 重写欢迎/准备/完成文案，完成页可打开众说或操作手册。安装逻辑/目录/数据策略/图标未变。实拍四页验证：`dist/r150-installer-shots/`。
- **版本**：`package.json`/`packaging/windows/release.json` → `0.1.1`（Windows `0.1.1.65535`）；`releaseVersion` beta 简写改跟随当前核心版本，版本测试同步 0.1.1 基线；新增 `docs/releases/0.1.1.md`。
- **发版**：已从 `a9caca4` 干净 worktree 构建并发布 0.1.1：https://github.com/384615666/zhongshuo/releases/tag/v0.1.1 （latest，tag=源码提交，公开 main 同步）。安装镜像 BUILD `bld_0793defc369ebf44`/clean/661 文件，EXE 159,306,032 字节 SHA256 `ba0c0747d902cee2e9fbb8688eb1aa1519337a95909a1f7d90e1321cd08c027d`，附 `.sha256`/`.release.json`；未签名。payload 已核对 logo/欢迎页/图标/手册/版本。隔离目录静默安装→卸载通过（未覆盖用户安装）；期间向导截图误触模板夹具安装，已用原 beta.3 包重装恢复并核对 667 文件/注册表/四个快捷方式/数据未变。用户旧版与数据未升级。详见 [R150](../reviews/r150-installer-release-20261101.md)。
- **发版后支持（任务栏图标）**：用户装 0.1.1 后任务栏仍显 Electron 原子图标。核实安装版窗口/EXE/快捷方式图标均已是猫咪；根因是用户同时运行的旧 V78 便携版与安装版共用 AppUserModelID `com.zhongshuo.desktop`，被 Windows 合并成同一任务栏按钮并缓存旧 Electron 图标。经用户确认关闭旧 V78、重启安装版并重启 Explorer 刷新任务栏缓存后，图标已变为猫咪；旧数据未改。后续如需彻底避免便携/安装共用任务栏组，可在下一版本按安装形态区分 AUMID 并修正 EXE 版本资源描述（本轮未改）。

## 2026-11-01：R149 用户反馈——正式 logo 补全 + 前端开发说明文字清理

用户反馈 0.1.0 上线后 ①正式 logo 很多地方未替换（欢迎页旧「众」方块、旧构建任务栏 Electron 默认图标）②界面残留开发说明文字（截图：工作量更新时间/统计口径、成员卡「高级状态」、模板与房间名单说明、AI 设置副标题/思考等级来源/权限长说明/「保存后显示 AI 的可用状态」）。本轮已按截图全量清理并在全前端同标准扫除同类文案。

- **logo**：`build-ui` 把根 `logo.png` 复制进 `dist/ui/renderer/assets/`；欢迎页改 `.welcome-brand` 正式 logo 图（保留原图比例/留白）；favicon、数据操作页品牌位、`main.ts` 窗口图标解析（应用根 PNG→渲染器副本→ICO，主窗口与进度窗口共用）、安装器「卸载/操作手册」快捷方式 ICO 全部补齐；`docs/user-guide/images` 20 张截图与手册首页重采集。旧 V78 包属构建产物过期，未改旧包/用户数据；`site/` 与 README 仍归用户安排的其他 AI。
- **文案**：70+ 文件删除/改写实现与验收口径、诊断 details/内部 ID、分页时间戳统计说明、弹窗副标题/页脚、legacy 回退壳同类文案；保留状态/错误/空态/确认/破坏性后果/输入约束/真实数据事实/渠道安装步骤/明确标注的诊断折叠区；`data-*` 与 aria-label 语义未改。删除未引用且含「演示界面」文案的 `ProtoFlag`。活动页补未知事件 kind 与状态枚举的中文兜底。
- **新增护栏**：`tests/browser/r149UiBrandingCopy.test.ts`（欢迎页/窗口/安装器使用正式 logo；禁止截图原句与同类开发文案回到可见字面量）；`scripts/capture-r149-ui.cjs`（隔离数据+fake runtime 的 20 场景 UI 证据脚本，未跟踪）。
- **验证**：`build:ui` 成功且 dist logo SHA256=根 logo；`tsc -p tsconfig.hifi.json` 通过（全量仅余未跟踪 R130 夹具既有错误）；改动文件 lint 对 HEAD 新增 0；清除本机 `ELECTRON_RUN_AS_NODE=1` 后 vitest **2911 通过/0 失败/10 expected fail/14 跳过**（唯一 4 失败来自本机未跟踪且缺旧夹具的 R130 upgrade 测试）；真实界面 20/20 场景 `hifiOn=true/legacyOn=false/HARD=SOFT=0`，截图 `dist/r149-ui/after-cleanup-3/`；打包应用隔离冒烟通过（welcome logo 1254×1254 源图→132×132、EXE 图标回读为正式 logo）。
- **产物**：便携包 `dist/desktop/desktop-daily-win-v79-r149-branding-copy-20261101`（BUILD `bld_9528a0d9ab5d4a0b`，dirty=true 因本机其他 AI 未跟踪工作；628 文件清单核对通过；已附操作手册与指向用户 V78 同一数据目录的 `start-existing-data.vbs`，但本轮未启动、未改用户数据）。未重编译/安装安装器、未发布 GitHub、未改旧包。
- 详见 [R149](../reviews/r149-ui-branding-copy-20261101.md)。下一轮：用户验收 UI 后，如需正式发版再按 R148 流程重打包/装安装器；`scripts/verify-desktop-renderer.mjs` 等历史脚本仍有 `sha256=` 等旧断言待同步（工程脚本，非产品测试）。

## 2026-11-01：R148 以 0.1.0 正式发布

用户明确要求当前图标修复版正式发布0.1.0。独立分支codex/release-0.1.0从公开main合R145—R147，保留最新主页/README。根包/安装/便携统一0.1.0；Windows数字版本0.1.0.65535高于beta.3，新增正式/预发布排序与非法版本回归。计划从冻结源码构建验证后推公开main/tag v0.1.0、发布GitHub Release；用户运行中的安装/数据不改、旧私有历史不引入。见[R148](../reviews/r148-release-0.1.0-20261101.md)，最终身份和发布结果待追加。

0.1.0已正式发布（2026-11-01 14:53上海）：https://github.com/384615666/zhongshuo/releases/tag/v0.1.0 ，stable/latest、公开下载200。tag源码46e96a6、BUILD bld_c3d7de0e4422245c/660hash，EXE158174405字节SHA6da931962e24c6ce10a92844f3176b5e1fd41b4cd77b96f06bedb82c5bcfc4a2，EXE/校验/release.json三个远端digest核对一致。最终全量321文件2800通过14跳过0失败、双types/lint、实际升级32/包内CLI34/原生图标7通过，0模型调用。初轮1旧AppId字符串断言已同步并全量复验。公开main和本机main已同步发布源码，原未提交续工文字/审计保留；备份dist/release-workspace-backup及stash。安装验证临时卸载登记已还原，原beta.3四快捷方式已恢复，用户运行程序与聊天根未改。详细证据/声明见R148，后续本记录不改v0.1.0标签或包。

## 2026-11-01：R147 修复 beta.2 遗漏的原生 EXE/任务栏图标

用户截图反馈旧图。核实确已安装beta.2，新ICO正确但EXE原生资源仍Electron，旧快捷方式复用固定图标路径导致缓存。现发行副本嵌入并回读所有图标组/语言/尺寸，哈希ICO文件名贯穿安装器/快捷方式/卸载，窗口PNG+setAppDetails；既有桌面入口即使未勾新建仍刷新，定向通知Shell，不删全局缓存/不重启Explorer。beta.3准备中，同AppId/数据根，用户运行中beta.2未关闭。见[R147](../reviews/r147-native-icons-beta3-20261101.md)。

beta.3已出包：clean源码08c5cb0，BUILD bld_de7686891fe36cd1/660hash；158187993字节，SHA155dc14a3b8804f63bd6ca4867efeb8d16d683c2925ddd0e2bf2770afa9238e8。完整/界面types、代码lint、17入口回归过，模板及安装器编译过；实际EXE/Shell快捷方式/窗口HICON/任务栏属性7项及退出0通过，三PNG目视核对，dist/r147-ui/e19696f6。0模型、用户beta.2未关闭未覆盖，正常退出后安装新包即可；冻结分支codex/r147-native-icons-beta3，主目录同步R147源码而保留原未提交工作。

## 2026-11-01：R146 CLI 生命周期补测与 beta.2 打包

用户要求打包并关注无CLI/后装/卸载。已修复零CLI建房NOT NULL、后装新PATH旧进程扫不到、先新房发现再扫描原空房间漏入房、建房界面未刷新成员，以及卸载Codex仍受理新任务。扫描只刷新daemon搜索PATH，不改注册表；卸载保留身份/配置/记录，实时程序可用性独立于启停，缺失的新请求入队前拒绝，重装同身份恢复、旧回执仍可重放。320跟踪文件2798通过14跳过0失败，后台/界面types过；无真实模型。独立worktree codex/r146-cli-lifecycle-beta2准备正式beta.2（同AppId/数据根、新logo），主目录其他AI首页/README及旧审计保留。见[R146](../reviews/r146-cli-lifecycle-beta2-20261101.md)，最终包身份待交付追加。

beta.2已交付：clean程序源码89d6135/BUILD bld_30574674228982a6，659hash；EXE158132428字节，SHA256 7c38dce097298c37550ed6d56c3e1fd01997525d1719b0f31d95e8e58fc27433。包内实际Node/daemon生命周期夹具34项、原生窗口UI10项/正常退出0通过，台账零模型、无任务；证据dist/r146-package/673ecb07与dist/r146-ui/1b4822cc、汇总dist/r146/delivery.json。主目录dist/installers含EXE/校验/独立数据测试入口/说明；未覆盖用户当前安装、未远端发布。打包源分支保留，主目录本轮源码改动与原未提交续工/审计保持在位。

## 2026-11-01：R145 正式 logo 与四渠道自动发现

用户指定根目录 logo.png，AGENTS.md/branding.md 已记录，便携/安装构建共享七尺寸 ICO 转换，安装器/快捷方式/卸载/桌面窗口用新图；主页及 README 留给其他 AI。默认发现扩到 Claude/Codex/Harness/Pi，新建房间补扫仅填新房间，显式名单、旧房间与既有成员配置保留；成员页新增「扫描本机 AI」及原因说明。零 CLI 不创建启用绑定，Harness 缺连接组件/Claude或Codex缺可识别模型不猜测，Pi/Harness可沿CLI默认；Codex支持PATH原生入口。远程不自动扫描，无模型请求或用户配置写入。

最终相关123项去重通过（含两组真实Electron各35界面断言），后台跟踪源码+新测试及hifi types通过，lint无新增；全工作区13项原有未跟踪R130测试类型错误保留。UI/daemon构建、新logo ICO目视、Inno模板编译通过。未重包交付/安装/发布，当前已安装beta.1不变；模板beta.2仅验证夹具，不可交付。详见 [R145](../reviews/r145-logo-cli-discovery-20261101.md)，证据dist/r145。原未提交审计、站点与续工内容保留。

## 2026-11-01：R144 Windows 安装 EXE 与安装测试

用户反馈V78仍打不开并要求安装版。最新日志实为已有daemon重复启动锁冲突；安装版原生EXE/稳定根先单实例锁/重复唤起、隔离安装目录与数据、固定LOCALAPPDATA/Zhongshuo/data、清父环境覆盖、按根管道/失败日志及对话框。失败收口核本次daemon归属，无效参数不读旧根，数据后台兼容重命名EXE+明确同根重开。Inno当前用户中文安装/开始菜单/可选桌面/卸载登记，运行中更新卸载先拒绝，不强杀；卸载保留数据和未登记文件。便携原数据/进程不自动处理。见[R144](../reviews/r144-windows-installer-20261101.md)。

安装包dist/installers/Zhongshuo-Setup-0.1.0-beta.1-x64.exe，clean源码a5e6292d81236e51f04c76b3617af33c73f98115，BUILD bld_ba7596538d3921d2，659hash，157626653字节，SHA256 de2780fd4f20ae1075971818d3f671109a589039434fe2a5b232aab008300bd1，未签名/无自动更新/未远端发布。已真实安装默认位置并留桌面众说入口，正式health/身份/659hash/22图手册确认，原新建测试数据不导入旧聊天。

全量318文件2782通过14跳过0失败（最后保护修正前），最终相关40/双types/lint过。最终EXE真实32项安装→重复启动→运行中更新卸载拒绝→beta0到beta1→存储/记录保留→卸载字节保留全过，证据dist/r144-install/db6fdb54-bc4c-4c34-8dbf-869f6e1dcc97；首组83ca...含真实备份后台成功/进度/同根重开/正常退出0。中文UI安装及默认启动目视、合成活动锁错误框/退出1通过，dist/r144-ui与r144-startup-failure-visible。初次hidden宿主隐藏首原生错误框、模板类型编译失败与dirtybeta0夹具均保留说明，最终clean交付无此问题。0真实模型调用，不冒称替代四渠道MCP/Skill验收。仅本地提交，保留原续工与84未跟踪工作。

## 2026-11-01：R143 修复 V78 沿用数据启动器

用户反馈start-existing-data.vbs无法打开。确认原数据pipe-name.txt缺失，R106遗留BAT拼出空管道，Windows listen EACCES；旧VBS隐藏失败且BAT无条件返回0。新增显式安装脚本和随包Node启动器：固定已有数据库目录、核SQLite头、缺标记一次补建/已有字节保留、清父环境覆盖、记录日志并提示失败，提前exit0但未认证亦报错。原默认入口和应用BUILD不改，修复用户指定V78原路径；今后用安装脚本生成，停止复制旧BAT。见[R143](../reviews/r143-existing-launcher-20261101.md)。

13定向回归/types/lint、真实包VBS/BAT含中文空格特殊字符22项通过；原库正式VBS已打开，identity确认原目录，4项目/7房间/42任务/162消息/117调用前后不变，正常停机0、无遗留daemon。验证器早读body/错误project.list字段的失败报告保留，不算产品失败。原默认项目文件夹已不存在（UI目录失效），未猜测重建或改绑定；启动器修复不恢复丢失文件。0新模型调用。V78压缩包同步修正，程序622文件hash保持不变，包内LAUNCHER-FIX.json记独立启动器来源08a1f34。仅本地提交不推送，保留原未提交工作。

## 2026-11-01：R142 MCP/Skill 报告复核与网关配置独立性

用户提供另一轮R141报告并强调Magpie是个人网关。确认产品无Magpie依赖，DSH安装保留既有profile；修复Pi执行配置摘要漏用户/项目mcp.json（有文件才加入，未配置MCP身份不变），4新增配置反例原2失败/修后8通过；修正文档dshweb配模不自动共享zhongshuo profile，保留既有provider/默认模型/MCP条目，不复制凭据或权限。见[R142](../reviews/r142-runtime-config-20261101.md)。

另本机未跟踪R141验收脚本发现清理会删整个skills根、Pi已有同名MCP漏还原；已备份dist/r142-review-backup原件，原文件本机修复不加入本轮提交：只清本次zs-test、拒覆盖已有同名、完整字节还原/仅实际修改才清理，去个人gateway默认值改CLI参数。9临时目录隔离清理检查通过，旧四渠道负例均检出；无用户配置执行。R141九项还原不能证明其他技能完整，16报告/assets无个人技能备份，未推测具体历史损失或自动恢复。

相关4文件66通过、官方Pi本地固定响应5通过（新元数据不启MCP用例原本也通过，不冒称已修复缺陷），双types/lint/UI构建通过，0真实模型调用。原R141报告/脚本及R130/R131等84未跟踪文件与续工原内容保留，独立worktree，仅本地提交不推送。

默认全量316文件2765通过14跳过0失败，证据dist/r142-full.json；官方5项已单独显式通过。原R141脚本本机改动SHA与worktree ignored副本核对一致，不加入发布程序或本轮git提交。

V78：desktop-daily-win-v78-r142-runtime-config-20261101，clean源码e2d7a10339366ada5055372d688f8f77700d7853、BUILD bld_df3992438fc6001d。622hash/ZIP652 CRC通过/220454707字节，SHA256 57eb7184c493a8d8f1ebc3d2cbaf1179de62d48602346cdc2808078ee857637d。包内实际Electron/daemon14项/正常退出0通过，沿用数据入口与V77相同；正常退出旧版后start-existing-data.vbs。R141脚本不打入包，不修改Magpie或其他CLI配置，不新增推理。

## 2026-11-01：R141 正常任务 MCP/Skill 正式验收（四渠道真实调用）

补齐 R140 排队的缺口：四渠道在正常（完整权限）任务中「实际调用 MCP 工具、实际使用 Skill、核对结果与任务状态」。驱动复用 R138/R139 模式（源码内生产 daemon+受管桥+隔离 IPC，台账上限 1）；MCP=本地零依赖 stdio 服务器（每调用新鲜 nonce+JSONL 台账），Skill=令牌仅在正文。结果四渠道全过：Claude（ToolSearch→Skill→mcp 工具→StructuredOutput）、Codex（mcpToolCall+PowerShell 读技能文件）、Harness（mcp 工具+skill 工具，用户真实模型）、Pi（read 技能+codemode 关闭直出工具）；nonce/令牌回传、tool.started/completed 落库（UI 展示源）、resultKey 链、幂等重放、受管停机全保持。真实 turn 共 10（4 通过+4 任务成功但断言过严+2 过程失败），prepare/config-check 零推理；本机配置零残留（九项还原核查全过）。**关键发现：zhongshuo profile 的 cordis.patch.yml 由 Magpie 写入 llm-pi-ai/agent-default-model 行（=渠道 19 模型来源），整文件替换会断渠道（INVALID_MODEL，请求前拒绝零副作用）；正确姿势=追加。Pi mcp.json 无 exposure 默认 codemode。** 见[R141](../reviews/r141-mcp-skill-20261101.md)。证据 dist/r141-mcp-skill/；仅本地不推送。


## 2026-11-01：R140 恢复检查过滤已解决的历史中断

用户反馈“查看中断任务”仍定位到已修复完成的旧任务。原库只读确认唯一INTERRUPTED属于DONE任务，后续最新SUCCEEDED；旧recovery.status无条件列全部历史中断。现仅每任务最新run仍INTERRUPTED且task非DONE/CANCELLED才提醒，历史保留；UNKNOWN/保留保护/撤销/门禁独立查询不隐藏。新正式方法在原库readonly+query_only读取interruptedRuns[]，其余空/门禁false，无写入。见[R140](../reviews/r140-recovery-current-20261101.md)。

新增16项正式恢复回归、既有7文件124项通过；双types/UI手册构建通过，commands lint与HEAD均10既有/无新增。MCP/Skill测试用户明确后排，本轮0真实模型调用。原R130/R131及82未跟踪工作保留，独立worktree实施，仅本地提交不推送。

最终定向8文件140通过。V77包内真实Electron/daemon非主屏合成两组14项通过：已修复不自动提醒/手动无旧链接，未解决仍1链接且正确定位，任务历史/outbox/台账不变；退出0且无遗留daemon，截图已目视。证据dist/r140-ui/26def641-7688-466d-8479-addfccb7d365。启动早期body空/CDP不支持窗口命令/截图动画中间失败保留，修正验证器后通过。MCP/Skill仍未测。

冻结默认全量316文件2761通过13跳过0失败，原件dist/r140-full-final.json；首次全量收集了定稿前fixture产生3唯一键冲突，原报告保留，最终定向与全量均过，不覆盖历史。

V77：desktop-daily-win-v77-r140-recovery-current-20261101，clean源码248c23b8e48d55f03b6c2b5eb74ad988c0138ec5、BUILD bld_4f7e269cfc383220。622hash/ZIP652 CRC通过/220454955字节，SHA256 582726494c4b8bc8dad17df001da37ddab565b9b60490dc9a8b88bd187e2ec10。通用包内入口14项/正常退出0通过，证据dist/r136-package/f7bde406-5633-4d75-a7b3-fa3f944246d1。沿用数据启动器与V76字节相同，正常退出旧版后start-existing-data.vbs，不清旧记录不重跑。

## 2026-11-01：R139 Pi 正式结果与格式补交修复

截图原库只读确认Pi同类链路：自然正文→TaskComplete非JSON→旧repairOnly拒绝，R138只修Harness留下Pi缺口。Pi适配器2逐轮传完整schema系统指令；官方1.4.0补交新会话，禁全部工具/扩展/MCP/上下文/模板并关闭重试压缩，握手历史为空；预检停止不启动。DM补交与后续会话隔离，普通只读/受限/图片不扩权。见[R139](../reviews/r139-pi-output-20261101.md)。

实际Pi问候/强制正文后的真实补交/旧失败后的明确继续共3真实turn+3fixture reservation，全部DONE/SUCCEEDED/resultKey正确/受管退出确认/job及poller0，同号重放无新增。官方本地固定响应4/4通过，9种强制工具全部原生not found，零副作用/真实供应商请求0；相关55/会话25/新DM3通过。默认全量314文件2742通过13跳过0失败（新DM收集后加入另验，不冒称含在全量），双types/lint/UI构建通过。证据dist/r139-formal/r139-1793469174679-2b31ccc2、dist/r139-pi-official/vitest-official.json、dist/r139-full.json。原数据只读不重放，无需安装Pi插件，仅本地提交不推送；原R130/R131及82未跟踪文件保留。

V76：desktop-daily-win-v76-r139-pi-output-20261101，clean源码c48727ef2e78a5b73764bbe0a360b094f2e10166、BUILD bld_759549b0ac2cdf49。622hash/ZIP652 CRC通过/220445393字节，SHA256 29b40d1d44d023e9d33ab8c6b3d29554248b5523b4b2c3eec61594b4b987520c。包内实际Electron/daemon隔离14项/正常退出0通过，证据dist/r136-package/785c6e26-6560-4113-a024-4a32cc06cdf3。沿用数据启动器与V75字节相同，正常退出旧版后start-existing-data.vbs；Pi不需新插件，Harness组件保持0.1.2。

## 2026-11-01：R138 Harness 正式结果与补交修复

用户截图只读诊断确认：DSH自然正文→TaskComplete非JSON→自动补交被repairOnly拒绝；R137底层测试漏正式worker验收。组件0.1.2补完整schema系统指令和强制零工具的新会话format-repair；旧组件握手升级拦截，正常只读/受限/图片边界不扩。DM补交与后续对话分会话，修复DM null线程恢复被转空串的既存拒续接。见[R138](../reviews/r138-harness-output-20261101.md)。

实际Harness问候1、Pi→DSH→Pi3、强制正文失败后真实补交1、旧不支持补交后明确继续1，共6真实turn，全部DONE/SUCCEEDED/受管退出确认/job及poller0；注入fixture另外3reservation。转交脚本误计正式交接消息为重复回复，中止原件保留，离线按handoff身份复核；不再额外调用模型。旧数据只读，无现场重放。协议17/官方SDK27零供应商检查/适配器及worker55通过。全量313文件2733通过1旧UI5000ms超时9跳过，旧UI与新DM定向13通过，第四轮正常DM续接3通过；双types/lint/UI构建通过。原R130/R131及82未跟踪文件保留，独立worktree，仅本地提交不推送。

V75：desktop-daily-win-v75-r138-harness-output-20261101，clean源码509edb17562ba02cf0cdeb63f977b0c7d2923f63、BUILD bld_1e8fbeb795460357。622hash/ZIP652 CRC通过/220450566字节，SHA256 5b3660071732bfa9c2f497b956aca73886b05153694f50e063a8aaf63b364476。包内实际Electron/daemon非主屏隔离14项/正常停机exit0通过，证据dist/r136-package/db4e533f-c269-4cfd-a8c2-19ddb22f2e4c。组件从稳定V75重装0.1.2握手通过；沿用数据启动器与V74字节一致，正常退出旧版后start-existing-data.vbs。未自动运行用户旧任务。

## 2026-10-31：R137 本机安装版真实验证，V74交付

用户已安装Harness桌面版和全局Pi并要求实试。实机版本DSH0.2.1-rc.5/Pi1.4.0，发现并修复桌面Electron Node/ASAR入口、%~dp0缺分隔符、Windows选Unix shim优先级；适配器和setup共用解析器并传受管env，ASAR/Pi版本文件计入配置指纹。Harness provider名称含斜杠按最长已配置前缀解析，off↔none，组件0.1.1。已在用户DSH自有zhongshuo profile安装组件，不改默认或其他profile、不改凭据/模型设置。见 [R137](../reviews/r137-installed-runtimes-20261031.md)。

实际Harness magpie/newapi/deepseek-flash共3turn（读取、冷续接、显式模型low）及Pi magpie/newapi/glm-5.3-flash共2turn（读取、冷续接）全过/退出0；Pi job子进程及句柄归零，额外空闲取消0推理；只传临时marker无用户私有资料。元数据Harness19模型/Pi默认及等级读取通过。默认全量312文件2726通过/9跳过/0失败；相关50项、插件14项、双types/lint通过。原R130/R131及站点未提交工作保留；独立worktree实施，仅本地提交未推送，不再追加真实调用。

V74：desktop-daily-win-v74-r137-installed-runtimes-20261031，clean源码b4929e27a2a6679e346585e04d9db836281dcebd、BUILD bld_144d09aee397afc4。622程序hash一致/ZIP653文件CRC通过/220454087字节，SHA256 4004faaad56591720c2fccafa13b18fffb879dbeb3eab0ce0c24e9fd7b774be4。包内实际Electron/Node/daemon非主屏独立数据14项入口/本机CLI模型目录/正常停机exit0通过；无新增推理。组件从稳定V74目录重装握手0.1.1通过；沿用数据入口与V73一致。证据dist/r137-real、dist/r136-package/1936abb8-e646-4797-bf27-b9d511851ef1。

## 2026-10-31：R136 DeepSeek Harness → Pi 适配完成，V73交付

按用户顺序完成官方 DSH 0.2.1-rc.5 众说专用 profile/JSONL 插件及 Pi 1.4.0 原生 RPC。统一渠道目录，成员/模板/模型/思考等级/工厂/受管执行/配置指纹/调用台账/恢复和停止接通；旧 Claude/Codex 兼容及默认成员不改。首版原生完整权限，只读/受限编辑/图片/格式修复执行前拒绝，不以提示词代替权限。真实 session 冷续接及目录核对、冲突 ID 全记录，无终态退出由 worker UNKNOWN 保留保护而不重跑。Pi Windows 工具后立即 EOF 原生断言经对照确认，host 延迟 300ms 关闭 stdin，真实退出确认不放宽。见 [R136](../reviews/r136-dsh-pi-20261031.md)。

默认全量311文件2722通过/8跳过/0失败（含既有保留反例，7项官方Pi需显式打开、1Windows symlink权限）。双types通过，新增代码lint通过、后台对照10项既有无新增。Harness13协议+官方19检查、Pi官方9项、相关后台/适配器53项、UI两渠道各34检查通过，手册03正文及04图更新目视。官方程序使用独立profile/本地固定响应，0真实供应商模型请求。原R130/R131及站点未提交工作保留。独立worktree实施，仅本轮文件本地提交，未推送。

V73：desktop-daily-win-v73-r136-dsh-pi-20261031，clean源码1a35115b7f660cd612722459c3162d072ae19103、BUILD bld_ea86a2e337eab758。621程序hash一致/ZIP652文件CRC通过/220435025字节，SHA256 5e672f982965f4611d3aa5d0bb3a02f75b6775dc8659bc4910f8e60c9070985e。包内实际Electron/Node/daemon，非主屏独立数据根10项新入口检查及正式停机exit0通过；Harness组件归档/校验与手册通过。沿用数据bat/vbs与V72字节一致，正常退出旧版后start-existing-data.vbs。包验证脚本中间失败（封装exe忽略wrapper、裸管道名、Browser.close绕收口）保留，修正验证方法后完整通过。证据dist/r136-package，官方程序与测试dist/r136-tools、dist/r136-pi-tools，报告R136。

## 2026-10-31：R135 五项状态/交互反馈修复，V72交付

恢复检查四类定位成功后关闭弹窗，失败保留可读原因；“回到自然协作”移到本次运行设置一级，与成员调整并列，成员子菜单只管名单。原库只读确认截图最新继续已建新研讨run但父任务仍BLOCKED，被deliberationMayLaunch取消两位成员startTurn前启动；现prepare成功转ACTIVE，停止/UNKNOWN/配置/预算保护仍有效。状态采用当前run的具体失败/取消原因，全部明确未开始才显示未能开始。回复串一条可读横幅，合并继续/结束/查看原因，兼容fallback最多一条；长问题仍在最新回复完整显示。侧栏项目动作固定占位，长名省略，hover/focus/menu可达，房间状态/未读槽保留。见 [R135](../reviews/r135-status-feedback-20261031.md)。

最终304文件2646通过(含3保留反例)/1Windows symlink权限跳过/0失败，双types、16代码文件lint与HEAD均14项既有无新增。继续4项正式回归(修前3失败)、状态原生Electron/daemon26项、Recovery/Composer78项、侧栏四组2790几何/交互断言及16图、长问句/慢历史25项、宽屏66项通过。手册02/08重采集、新增20图并目视复核。初次菜单控件匹配/裁剪与未构建新图时两处手册布局读取失败均保留，修正采集/构建后原检查通过。未改原数据/自动重放/真实业务调用。

V72：desktop-daily-win-v72-r135-status-feedback-20261031，clean源码acb6014a17e07567e8b4bf3e0e12c50b8cdaf50a，BUILD bld_91abf3df19cf70f4。616程序hash一致、ZIP650文件CRC通过/220902475字节，SHA256 d473d7d1192b92996bc8009c4716d3a003fae42cb62ab663048329529a726a1e。包内实际Electron/daemon、14章20图/正文一致/新说明/原界面/正常退出与包内代码26项复验通过。沿用数据入口与V71字节一致，正常退出旧版后start-existing-data.vbs，原串明确继续。独立worktree实施后ff合入main，只提交本轮文件，82份原审计/站点与原续工未提交内容保留。实现/交付两提交推送公开main；扫描和远端核对证据dist/r135-feedback，详细测试dist/r135-source/dist。

## 2026-10-31：R134 按选择修复消息派发/历史/输出，V71交付

用户批准R133第2项和3/4/6三个确认缺陷；1主动静默、5同消息ID变正文、7终态后文本不改。普通@全体由程序按冻结名单为各成员创建正式独立步骤，根消息全房间/跟进仅本串，独立研讨仍保留互评整合。同名提及绑定草稿身份，唯一名字原样/同名短标识，旧歧义不猜；正式Room接通向前分页与旧消息深链(1205条/12页)，保留滚动/草稿/隔离；Win输出排空非消费PeekNamedPipe。独立复核补修统一验收、失败同伴问题入口、冲突文件误报完成；父成果清单按真实子交付绑定/hash验证，返工意见送入各步骤。见 [R134](../reviews/r134-message-repairs-20261030.md)。

最终302文件2641通过(含3保留预期反例)/1Windows symlink权限跳过/0失败，双types、27代码文件lint与原HEAD均30项既有无新增。广播15项、输出12新项/54相关、历史10新项/39相关及正式Room15组，Composer65检查/8份原信封worker验证、正式Electron/daemon19项、宽屏66项通过。手册05/06重采集目视通过。原数据未改/旧稿不补发/0真实业务调用。中途编辑竞态断言与启动前过早导航的验证失败保留，固定版本与真实侧栏点击复验通过。

V71：desktop-daily-win-v71-r134-message-repairs-20261031，clean源码1059a4441668fed396915d92dfb4c64be054d38e，BUILD bld_b80beb912d7adebf。615程序hash一致，ZIP648文件CRC通过/220848253字节，SHA256 133e102cf95178fd3054c16470567e7d46f80e28ce8677a30c2585a4d29f7290。包内实际Electron/daemon、14章19图与新说明、原界面/正常退出通过；开发Electron加载包内代码19项复验通过。沿用数据入口与V70字节一致；正常退出旧版后用start-existing-data.vbs。独立worktree实施后ff合入main，只提交本轮文件，R130/R131和并行站点保留。实现/交付记录发布公开main；凭据扫描与远端核对证据在dist/r134-feedback，详细测试在dist/r134-source/dist。

## 2026-10-30：R132 待处理横幅与全体短交流修复，V70交付

用户反馈进入串后待处理横幅迟到、@全体仍吞成员回复。只读现场确认两位成员均SUCCEEDED且各有analysis_draft，旧短交流只发主持人消息；write-root延期解释启动等待，未改同串写锁。现ThreadPanel即时显示主池已确认的正式状态并按版本/停止代次/事件水位择新，task.get与history独立收敛；短交流复用阶段消息逐真实成功成员发布，no_reply静默，真实作者/turn/run绑定，失败缺席不伪造、重启幂等、原交付状态保留。旧隐藏稿不自动补发。详见 [R132](../reviews/r132-thread-feedback-20261030.md)。

独立worktree基于干净1416cd2实施，原目录R130/R131未提交审计与并行站点工作不纳入本轮。297文件2578普通通过+3保留预期反例+1权限跳过，无失败；双types、9变更代码文件lint对照均12项既有/无新增；状态7项、短交流20项及相关173项通过。正式Electron/daemon25检查：1400ms延迟下横幅20ms即显，3200ms/失败history不挡task，长问句/详情入口/双作者/刷新去重通过，0真实业务调用；宽屏UI66项和手册19新图目视通过。V69基线失败保留。

V70：desktop-daily-win-v70-r132-thread-feedback-20261030，clean源码cd1525b019b2340a25230bd0620f670ca3169aa1，BUILD bld_cb97c8eba0dcbb86。615程序hash一致、ZIP648文件CRC通过/220837918字节，SHA256 e94b5186977f8c1132dfa923e75c1dc95861bc6dc49b60c012c22f05d4a5e281。实际包内Electron/daemon、14章19图/新说明/原界面/正常退出通过；开发Electron加载包内代码25项复验通过(横幅17ms)，0真实业务调用。首次封装Electron忽略夹具入口未产报告作为验收方式失败保留并正常退出。沿用数据入口与V69字节相同；用户正常退出旧版后start-existing-data.vbs。实现/交付两提交发布公开main，凭据扫描与远端核对证据在dist/r132-feedback；测试证据在dist/r132-source/dist/r132-feedback。

## 2026-10-30：R131 全源码对抗审计 + 动态盲区混沌（仅测试，未改产品）

用户认为 R130 覆盖太窄，要求更大规模扫描。本轮 7 路并行只读源码审计（约 9,300 万 token、约 270 文件全文：daemon 协议/存储迁移/worker 生命周期/renderer 线程/预览+主进程/adapter+contracts/远程入口）+ 主会话动态实证（R130 §7.1 盲区：远程 HTTP 活体、极端缩放、病态文件名）+ 高危项逐条亲核。报告见 [R131](../reviews/r131-full-adversarial-20261030.md)。

**新确认约 57 项：2 high、约 19 medium、约 30 low、6 质量**。High：①R131-A01 Claude 适配器对形状错误 JSON 输出无校验无 catch+daemon 无 uncaughtException 兜底→一行畸形输出杀 daemon（动态实证）；②git 参数选项注入：branch:"-f" 静默销毁未提交改动且回报成功、remote 被当 git 选项解析（动态实证；"任意执行"两形态未复现已如实降级）。动态实证另有：跨身份 rename/archive 他人私信、/cmd 60/150MB body 无上限坐实、/pair 尝试先落库后限速无清理、病态文件名 12/14 接受。修正三处误报：uploadText/readFull 无上限属 R120 用户拍板设计（注释过期记 low）、localhost 白名单属设计、存储流 P0 执行链降级。另发现 R130 helper 有 13 个 tsc 错误（当时 vitest 全绿掩盖）。新增 6 个测试/脚本文件未提交；0 真实模型调用、包只读、无孤儿。


## 2026-10-30：R130 V69 交付包暴力/异常操作对抗测试（仅测试，未改产品）

用户要求对 V69 包（`dist/desktop/desktop-daily-win-v69-r129-room-navigation-20261030`）做暴力测试和正常人不会做的操作。六个并行测试流 + Lead 收尾复核：**260 个场景/用例单元、131 项守住、14 项确认缺陷（1 high / 2 medium / 11 low）、31 项语义边界、16 项限制**；0 真实模型调用、未改产品源码/包目录/用户数据、无孤儿进程。报告见 [R130](../reviews/r130-adversarial-chaos-20261030.md)，共享纪律/证据格式在 ignored `dist/r130-adversarial/BRIEF.md`、包内 Electron 混沌 harness 在 `dist/r130-adversarial/HARNESS.md`。

最高优先级：①UPG-01（high）迁移前备份 `VACUUM INTO` 直接写正式名，升级中断会留下截断备份与完整备份并存，恢复时可能选错；②PV-B05（high 风险边界）1.16MB PNG 声明 20000×20000 可让 renderer 解码出 +2.1GB 工作集；③IN-DEF-04（medium）粘贴 1MB emoji/混合文本同步阻塞 38–70s（ASCII 71ms）。其余 low：启动版本地侧栏仍列归档项目（NAV-D01）、`task.stop` 对无法归属的 targetRunId 假成功（PROTO-DEFECT-01）、深色主题只写不读（IN-DEF-03）、320px 输入区 44px（IN-DEF-02）、英文技术错误直出（IN-DEF-01）、启动器目录含 `&`/`!` 时双击无反应或建错数据目录（PATH-01/02）、图片只校验 IHDR（PV-B02）、previewOffice 20MiB 上限未实现（PV-B11）、启动不校验 DB 完整性（UPG-02）、只读根无启动诊断（UPG-03）、dataCopy 目标消失泄漏原始 ENOENT（UPG-04）。

R129 修复点在暴力场景下守住：侧栏独立索引 1029 采样 0 违规；同项目已载房间 1000ms 延迟下点击→路由 0.4–0.5ms 且 0 次 `room.list`；顶栏/欢迎页迟到读取不抢回；权限说明无常驻警告、错误只进运行设置菜单；“有新消息”浅色与选中房间/发送按钮一致。交付完整性：ZIP SHA256/648 条目 CRC/615 文件 MANIFEST/BUILD 身份全部复核通过，包内无运行数据或凭据。新增测试 3 文件（R130 Commands/Upgrade/Preview）+ 混沌脚本（均未提交）；全量默认回归清除宿主 `ELECTRON_RUN_AS_NODE=1` 后 298 文件 2653 passed + 10 expected fail + 1 skipped，exit 0。实现与测试改动当前只留工作区、未 git 提交，等待用户决定是否修复与是否提交。

另会话独立复核（2026-10-30，结果送达用户前）：三处复跑与报告一致——`chaosR130Upgrade.test.ts` exit 0（28 passed + 4 expected fail）；`chaos-r130-navigation.cjs --only c4-project-dir-and-archive` 15 断言仅 NAV-D01 红、Electron 干净退出；`chaos-r130-input.cjs --group A` 21/21、本机实测 1MB emoji `pasteMs=48668ms`、Tab 峰值 1024MB、`realCalls=0`；r130 孤儿进程 0、包目录未生成 server-data。报告判定可复现。

## 2026-10-30：R129 侧栏/导航与权限说明完成，V69交付并推送

用户反馈权限未刷新提示、切房间卡住、旧深色新消息按钮、房间消失，明确要求本轮与前几版一起推送。原DB只读确认claude-zh-cn默认房间未删除/归档，当前窗口只读观察显示“暂无房间”；V68正式UI已复现active先变而rooms仍旧→侧栏缓存空、每次同项目点击先等room.list、顶栏迟到then导航回抢。现sidebarRoomIndexes只接真实按项目room.list回包，错误保旧、ticket隔离；同项目已载房间同步切换，顶栏/欢迎页同步URL交接，项目刷新代次防串线。权限说明等身份完整才读，revision刷新保留在途/合并重读；移除未请求的输入框常驻chip，错误进已有运行菜单，实际发送授权不改。新消息按钮使用浅色家族，审计其他同类控件无深渐变残留。见 [R129](../reviews/r129-room-navigation-20261030.md)。

最终295文件2551普通通过+3保留预期反例+1权限跳过，无失败；双types、15变更代码文件lint无新增（与HEAD均10项既有），正式导航14场景53检查/2826采样零缺失，配色Electron5项与权限组件15项通过。两宽度125% UI66项、手册02/06重采集目视通过。原数据未动、0真实业务调用。开始HEAD5e87565比origin/main领先14提交，实际已提交未推送；前14提交Gitleaks零告警、业务/个人目录/运行库检查无命中，均noreply作者。本轮统一发布公开main共16提交，不合私有历史或数据。

V69：desktop-daily-win-v69-r129-room-navigation-20261030，clean源码2a1ff387e8bc11a5af0e522f449a25af923b9545，BUILD bld_b60bd4e89a047661。615程序hash一致、ZIP648文件CRC通过/220830706字节，SHA256 92396128bc190637742cddae617ae5e06ecf78d3762af7ce84a2eacfb6e468e3。实际包内Electron/daemon、14章19图及新说明、原界面/正常退出和清理通过；沿用数据入口与V68字节相同。用户正常退出旧版后使用start-existing-data.vbs，原房间/聊天/文件保持原位。推送前15提交1.02MB Gitleaks零告警，最后文档复扫后push并核对远端SHA，证据在dist/r129-feedback。

## 2026-10-30：R128 四项追加反馈完成，V68已交付

用户追加失败任务无法停止/结束/继续、房间圆圈三角蓝色、最新消息不折叠与引用气泡常显×。DeepSeek Flash/max完成界面，sol完成结束内核及正式UI，主代理接续/整合。详见 [R128记录](../reviews/r128-task-actions-20261030.md)。`task.close`按版本/停止代次/最新run绑定，在事务内检查整棵任务树，仅取消安全排队工作并结束未完成事项，原消息文件与失败历史保留；在途/已领取/租约/UNKNOWN保护不绕过。普通BLOCKED失败、PARTIAL、INTERRUPTED支持正式redispatch；恢复检查补齐PENDING/DISPATCHING/WAITING_INPUT/WAITING_APPROVAL。已结束不再重复显示旧运行未完成/待验收横条。

BLOCKED空心八角和ACTIVE静态三角为主题蓝，空闲仍留空；最新可读AI回复完整展开，不被后续系统/空/用户消息挤掉；引用chip末尾×直接清空本草稿引用，hover浮窗/逐条移除保留。首轮发现详情查询21次与窄栏按钮裁切，已合并查询并允许状态行换行，原测试不放宽。最终291文件2536普通通过+3既有预期反例+1权限跳过，无失败；双types、28变更代码文件lint无新增（与HEAD均25项既有）、独立Electron6项、正式Electron/daemon实际点击44项和UI66项通过。手册02/06/08重采集目视通过；原数据未动，0真实业务调用。

V68已交付：desktop-daily-win-v68-r128-task-actions-20261030，clean源码26d17ca28eadbba21c62e41a635195096e094e49，BUILD bld_547074af932c287e；615程序hash一致，ZIP648文件CRC通过，220830082字节，SHA256 bfa4ba2830e127a76ec1c7a07814ea1d6240c3ff7382f876986b2782748ce331。包内实际Electron/daemon、14章19图及新说明、原界面/正常退出和清理通过。沿用数据入口与V67相同，原数据原位，用户正常退出旧版后用start-existing-data.vbs。实现与交付记录仅本地提交，未推送；原记录不自动重跑。

## 2026-10-30：R127 六项对话串反馈修复，V67已交付

用户要求修复Claude分歧缺席/未能开始、同AI跨串串行、引用长文、选区右键和已读延迟；补充明确引用须数量入口+悬停浮窗。实际使用newapi/deepseek-flash max处理前端、gpt-6.1-sol处理并行/独立复核，主代理接线整合。详见 [R127记录](../reviews/r127-thread-feedback-20261030.md)。

源码已稳定：Claude新v3排除已证展示状态并保存分项哈希，旧v1/v2不可变；CR/ISS启动失败在本轮真实成员结束后收口，不单人循环。默认完整权限跨串共享租约，同串及未知保护保持；并行快照不可自动撤销，本轮声明/工具路径分别登记附件。独立复核补修共享源格式补交的继承与静默/分工输出误判，真实worker回归通过；研讨共享文件版本不冒称本轮独占修改。引用按用户纠正采用chip+hover/focus浮窗，选区精确复制/引用；已读缓存即反馈+异步确认，主池真实最新seq接通，旧缓存/延迟/后台/切串等回归齐备，独立通知未暂停。

最终288文件2456普通通过+3保留预期反例+1Windows symlink权限跳过，无失败，结果在ignored dist/r127-feedback/full-final.json；双types通过、33文件lint与HEAD对照31项既有问题/无新增，18项独立Electron及正式UI两宽度125%共66项通过。手册06悬停图已重采集目视复核。首轮后端两个旧串行oracle已保留原意改为受限编辑/项目容量1；首轮全套另发现主池元数据提前创建完整串实体，已保持thread.get边界并复验旧冷启动和新即时未读回归。已实际比对ZCode UI及ZCode/Codex安装包引用组件。

V67已交付：desktop-daily-win-v67-r127-thread-feedback-20261030，clean源码624b829ce5bacb45fedd1e02c64b62d0e6148024，BUILD bld_6bffb21dda811d8e；615程序hash一致，ZIP648文件CRC通过，SHA256 107a4bd9702aadd0702f0cbdf0d0a5576da97b413d1ddcf7a68a7ae88bac6be5。实际Electron/daemon、14章19图、新说明及原界面/正常退出通过。沿用数据入口与V66字节相同，原数据原位、0真实业务模型调用；仅本地提交，未推送。用户正常退出旧版后用start-existing-data.vbs，在原串明确继续；旧失败/未知记录保留。配置误判已修可证部分，凌晨变化具体字段无原文不能反推；新请求留分项hash便于追查。并行不自动合并同一外部文件，重叠快照禁自动撤销。

## 2026-10-30：R126 按用户选择修复，V66已交付

用户明确“15—18不用修，19不确定，其他可以修复”，范围确定为1—14和20；15—18不动、19暂缓，不需再次确认。主会话处理dispatchWorker退出UNKNOWN、归档启动复查、笔记故障隔离和late pending；Averroes完成commands/stopFlow的2/13/14；用户指定执行会话处理adapter及协议测试4—11/20并使用sol和newapi/deepseek-flash max复核。详见 [R126主记录](../reviews/r126-selected-repairs-20261030.md)。

1—14和20修复已通过最终回归：282文件2391普通通过、3个按用户保留的预期反例（16/17/19）及1个Windows文件symlink权限项跳过，无失败；22文件lint无新增、双types通过。独立worker复核发现retained late成功仍会丢笔记，主会话已补“无有效stop且暂时retained保留pending，正式解除后按原store重验合并”，新retainedMemoryR126三项、正式真实Job解除与恰一次合并回归及独立复验均已通过；只读复核无遗留必修项。协议生产已冻结：typed RPC和真实新旧审批回包补齐、未知终态由worker保守UNKNOWN，不放写锁不自动重跑。15通用终态后封口未加、19活动期互斥未加、16/17/18保持。第一完整回归仅R82/R83四项旧无连接参数stub失败（已改夹具保留全部断言、局部16项过）；最终全套已通过。正式UI66项通过、手册08图重采集并目视复核。未改原数据/重放原业务/调用真实业务模型。V66已交付：desktop-daily-win-v66-r126-selected-repairs-20261030，clean源码6019e0475463ee8e497cb637a36495e1fbb35ed0，BUILD bld_5c330b87af22ccc0，615程序hash一致、ZIP648文件CRC通过、SHA256 344562783e3c8a79b4afbc8cc1f872170ff688e126417d7ab61077006e3f2aff。实际Electron/daemon、14章19图及新说明/原界面命令桥/正常退出通过。沿用数据入口与V65字节相同，原数据原位、0真实业务调用；实现及交付记录仅本地提交，未推送。用户正常退出旧版后自行切换，未知结果不自动重跑。

## 2026-10-29：异常清单改为用户能理解的说明（仅文档）

用户明确要求先把全部问题写成能理解的描述，再决定哪些修复。已重写 [当前异常清单](../reviews/anomaly-list-20261029.md)，保留1—20编号，每项说明触发情况、用户会遇到的后果和已证范围；去掉provider/transport/Map/代次等术语，区分正式任务复现、只在连接测试复现、现有规则和能力边界。技术原证据仍保留在R124/R125分项报告。本次不执行修复、不新增测试或模型调用，等待用户选编号。

## 2026-10-29：R125 执行会话补齐两项协议猜想（仅测试）

用户直接指定执行会话01a18789-6fdc-7773-88be-1ec675bbf7b6由本会话指挥；已读取其用户原话确认跨会话派活授权。派发R124尚未认证的两项：同provider thread首轮已响应但未终态再启动、已完成provider turn ID重用。仅测试/证据，不修产品。执行会话实际验证原生spawn可选newapi/deepseek-flash/max，后续无需仅凭本会话早先的旧model列表判定不可用。

五例2守住/3预期反例（不是三个独立漏洞）。S1底层openSession(resume)/startTurn放行重叠，但正式DM队列阻止同会话同时执行，不同房间串可并行。S2同SessionRef底层覆写Map后旧正文归新轮，该分支无正常worker入口；正式DM两轮使用不同transport session、同provider thread时，重用已完成ID导致旧/新映射冲突，新任务ACTIVE/RUNNING、无新回复、占名额；旧回复不变。仅换新ID的正式对照DONE；存活期250ms快照及代码等待路径佐证，不归因于随后清理退出进程。

执行会话和主会话各复跑五例，主审日志parent-review；完整tsc、新代码lint通过，冻结五组47个文件SHA全部一致，全部合成子进程及消费者已清理。详见 [R125](../reviews/r125-protocol-followup-20261029.md)。新增 [当前异常清单](../reviews/anomaly-list-20261029.md) 保留对用户的1–18编号并补19/20；明确正式入口、底层、直接改库和语义边界，不等于20独立漏洞。产品源码/V65包/原数据未改，只有测试与文档，本轮本地收口。

## 2026-10-29：R124 用户要求继续破坏性测试（仅测试）

用户进一步要求发散异常场景并明确指定 `newapi/deepseek-flash`。内置agent工具无该型号，但本机Claude渠道可用；经CLI实际完成两份DeepSeek max隔离上下文设计（一次长请求超时后短重试成功），返回modelUsage记录。三名gpt-6.1-sol代理实际测命令乱序、协议和记忆；主代理实测存储故障蔓延/真实Windows文件锁/DeepSeek终态状态猜想，整合复跑。设计推测不当实测；DeepSeek状态方向几项“缺陷”经复核为既有保护/语义/未证，不计确认问题。

五新文件39项：18守住、21预期反例（含一个强语义边界、一个直接DB篡改完整性项和同漏洞多变体，不能算21个漏洞或产品全通过）；相关七文件77项通过，完整tsc和七新增代码lint通过。确认共享进程退出仍RUNNING挂消费器、OPEN排队根请求穿过房间归档实际写文件、记忆表写错堵全局队列/重启、协议身份/旧审批代次/启动恢复缺口、非法终态假成功、迟到成功未合并笔记等。分项复现、限制及修复顺序见 [R124汇总](../reviews/r124-adversarial-chaos-20261029.md)。

本轮仅测试与文档，未改生产代码、未重包、原数据未动；V65身份保持原样。产品业务执行0真实模型调用，DeepSeek设计请求为真实模型请求，不能声称本轮总调用为0。下一步优先修执行退出收尾、归档启动门禁、故障隔离和协议身份，再修其余已证一致性问题。

## 2026-10-29：R123 已授权实施：跨串并行与共享笔记

用户明确“按这个方案做”，允许gpt-6.1-sol与deepseek-flash/max子代理；当前接口无deepseek，使用多个sol完成归属、准入、记忆存储与回归，主代理整合。修Codex无归属消息和旧进程代次串线；DIRECT取得准入/物理租约后才捕获基线，24/12任务各只24/12基线；同角色按冻结scope跨串并行、串内有序，旧无key UNKNOWN继续保守保护。记忆新增060迁移和schema60、同房间同角色跨串增量事务合并，带来源冲突保留，失败不记，成功待合并可重启补做不重跑模型。详见 [R123说明](../reviews/r123-session-parallel-memory-20261029.md)。

完整272文件2314通过/1个Windows文件symlink权限跳过；双types、变更lint无新增，正式UI33×2共66项通过，手册02/06/08重采集。独立复核发现并修复最终笔记撤回失效及记忆故障漏成果快照，已独立复验；最终完整回归已通过，V65已交付；原任务/数据未动、0真实模型调用。

V65：desktop-daily-win-v65-r123-session-parallel-20261029，clean源码1cfee2214d0f7bb09e82efe226819504696c1094，BUILD bld_b2d6e7d9f27a4b65；615程序hash一致，ZIP648文件CRC通过，SHA256 ae03a855a21f23aa60877e72deec7c0ca9b57b87663247dbb64b298e98c61ea2。实际Electron/daemon、14章19图、新记忆说明、原界面命令桥及正常退出通过；沿用数据入口与V64字节相同，用户退出旧版后自行切换。数据原位，首次正式打开按机制备份并迁移到schema60。实现与交付记录仅本地提交，未推送。

## 2026-10-29：R122 破坏性并发测试与会话并行评估（未改产品）

用户要求模拟多AI/多串多任务撞车，并评估共享角色模板、独立会话和共享记忆。新增17场景，正式命令/SQLite/outbox/worker、真实文件及本地协议进程；0真实模型调用，用户原数据未动。36同角色根请求、12×3成员协作60轮、20串内追问、重复发送/停止、改配置、挂起保护等已核验。24写入最终无丢失但300基线/约74秒，独立Git12写入78基线/约17秒；共享记忆两成功任务丢一次更新；无归属普通消息经实际Codex adapter+worker落进错误串已复现。详见 [R122报告](../reviews/r122-collision-stress-20261029.md)。

仅测试中替换成员准入为会话槽，证明同角色只读峰值可到2；写任务仍串行。产品并行策略、事件处理和记忆功能均未改，未发布V65。下一步建议先修 onNotify 无threadId时默认选第一个session及worker普通消息无turnId归属，再把DIRECT基线捕获移到取得准入/物理租约后；须保留停止/UNKNOWN/重启保护。共享记忆应版本化读、事务合并增量。新17场景含缺陷/风险正复现，不能称产品全通过；相关既有7文件106通过/1权限项跳过，types与新增4文件lint通过。原始早期脚本修正与最终证据在ignored dist/r122-collisions。

## 2026-10-29：R121 房间切换、执行配置与发送提示

修复同项目切房间重载与跨项目侧栏缓存闪现；Codex 新请求使用 v3 指纹，支持独立技能数组下过滤无关项目信任，旧 v1/v2 授权快照不改；权限提示查询不再排队等待发送的 CLI 准备；正常发送不显示恢复查询面板；已完成且无需验收的回复页隐藏横幅。现场确有配置文件改写，但旧快照无原文，未声称已还原具体改写字段。详见 [R121记录](../reviews/r121-room-send-execution-20261029.md)。

完整264文件2225通过/1个Windows文件symlink权限跳过，双types通过，16文件lint无新增；正式UI 33场景×2宽度共66项及成员读取250ms延迟下4项/449次DOM切房间采样检查通过。手册与回复串截图同步；0真实模型调用、原任务和运行数据未改。

V64已交付：desktop-daily-win-v64-r121-room-send-20261029，clean源码114b0adb8b3c0606b7ca97b718598a1b5b0c9e44，BUILD bld_3237b6d84ef16010；615程序hash一致、ZIP648文件CRC通过。实际包内Electron/daemon、手册14章19图、原界面命令桥及正常退出通过；两次辅助入口/主屏参数失败原件保留。沿用数据启动器与V63字节相同，原数据不搬；用户正常退出旧版后自行启动V64，在原串提出继续要求。

## 2026-10-29：R120 文件容量、头像与5次重试

按用户要求移除文件上传/托管读取/预览/解析/ZIP/快照/生成物/导出/远程下载/另存为的固定大小和数量限制，以及文件列表和Git差异截断。头像默认显示且原图保存，明确设置false仍保持。临时网络/服务故障5次额外重试，重启计数与详情共用常量；只读格式补交和副作用/UNKNOWN处理沿用既有语义。

新完整缓存与旧摘录缓存分开验证；历史输入允许已知旧完整/截断缓存，保留真实截断标记，预览重新生成完整缓存。操作手册和19张编号示例图同步。详见 [R120说明](../reviews/r120-file-capacity-20261029.md)。

最终263文件2217通过/1个Windows文件symlink权限跳过（maxWorkers=4），双types通过、60文件lint无新增；默认头像实际参与33场景×2宽度66项界面检查，均通过。主代理已独立复核各子代理结果，实际大文件与超旧数量正例通过；旧固定限额负例已改成完整读取/保存正例，analysisOnly改用真实越界链接提供失败事实。0真实模型调用，原任务/原数据未重放迁移。

V63已交付：desktop-daily-win-v63-r120-file-capacity-20261029，clean源码2af26dbc6256596706156c3ef8a5d3ebdda6dd9b，BUILD bld_ff4262054941e813；615程序hash一致、ZIP648文件CRC通过。包内实际Electron/daemon、手册14章19图、原界面、正常退出通过；现有头像控件实测保存3.6MB原图字节一致，65MiB+17文件另存为逐字节/hash一致，0turn/0real_call。沿用数据入口与V62字节相同，原数据保持原位。完整SHA及验证在R120记录。

## 2026-10-29：R119 固定上限与系统提示

续查5000文件限制后，移除单份8步/8依赖、4交接、12成员（含运行准备漏网路径）、结构化业务说明长度，以及Git清单64MiB缓冲上限；实际仍在运行的研讨成员超过20分钟不再误判缺席，完成后正常计入。删除过时缺席等待控件，保留用户明确配置的单轮时限和真实失败/停止/UNKNOWN处理。

全项目正式与原界面文案清理：规则编号、内部阶段枚举、原型/合同/事务施工说明改为短状态及动作。共享转换只处理系统说明，旧记录即时改善；业务消息、问题、反馈、文件及原始协议不改。手册14章19张编号截图更新。完整剩余限制及影响见 [R119审查](../reviews/r119-limits-and-system-copy-20261029.md)。

最终完整默认回归（maxWorkers=4）257文件2153通过/1个Windows文件symlink权限跳过。高并发I/O测试超时及回放立即读回执的竞态分别记录，回放改等实际回执；最终全部通过。双types和114文件lint与HEAD对照无新增；当前UI+daemon 33场景×2分辨率（125%）66项通过。0真实模型调用，未重放或搬迁用户数据。

V62已交付：desktop-daily-win-v62-r119-limits-copy-20261029，clean源码1d6d28f366f8dc2cdf520a431e104c337e22c459，BUILD bld_2a22340286648ed6；615程序hash一致、ZIP648文件CRC通过。实际包内Electron/daemon、手册14章19图、原界面命令桥及正常退出通过，0turn/0real_call；本机沿用数据入口与V61字节相同，原数据保持原位。辅助原界面标志误用已修正，日志保留。见R119完整校验值及交付记录。

## 2026-10-28：R118 项目基线误扫ignored运行数据

现场V60两位研讨成员均0调用，原因是全目录扫描包括ignored旧包/运行数据，触发默认5000截断（旧递归追加至5007）并遇到外置依赖junction。已实现Git项目文件清单范围、非Git默认完整迭代扫描、持久范围指纹和根身份、after并回before路径、范围变化的新路径unknown，Git失败不更换扫描边界；错误信息包含具体路径。保留真实越界/读取失败保护，手册同步更新。见 [R118记录](../reviews/r118-project-baseline-20261028.md)。

7文件134项通过，Windows文件符号链接权限不足跳过1项；实际目录junction正反例通过。双types和本轮eslint通过。现场只读新清单2657项，0截断/读取失败/越界；未重放用户业务、0真实模型调用。原始事件仅保存在ignored dist/r118-baseline。

V61已交付：desktop-daily-win-v61-r118-project-baseline-20261028，clean源码da12269711dd8fd0133f04ab92507b68fdf3c095，BUILD bld_e017b34044d66776；615程序hash一致、ZIP648文件CRC通过，实际Electron/daemon及14章19图加载、正常退出通过。原数据未迁移，沿用数据启动器与V60字节相同；升级后在原串继续，旧失败记录保留。

## 2026-10-28：R117 补齐确认后的文件交付与同AI多问题接续

用户授权修复V59独立复核中的两处遗漏。文件部分按提问事件持久保存未交付改动集，确认后合并完整版本链，派发及连接后重验文件；旧V59和格式补交通过持久来源恢复，正式交付切断旧链。同AI多个问题按提问顺序逐条接续，已有答复不重复绑定，问题身份冻结并在启动前重验；多AI沿用@选择。没有新增界面控件，手册同步更新。详见 [R117记录](../reviews/r117-confirmation-file-chain-20261028.md)。

主代理最终10文件189项定向回归通过，本轮新增25项；双types通过，eslint与HEAD对照10项既有问题、无新增。未重放原业务，0真实模型调用。原独立复核仅为缺陷复现；本轮才实施修复。

V60已交付：desktop-daily-win-v60-r117-confirmation-20261028，clean源码70c749166cf98941f2afe39ec7bae9b37b32f16a、BUILD bld_5710204bb36d94f3，615程序hash一致；ZIP648文件CRC通过，整包实际Electron隔离启动、14章19图和正常退出通过。沿用数据启动器与V59逐字节相同，原数据保持原位。辅助采集导航竞态诊断保留于ignored证据目录。

## 2026-10-28：R116 连续返工、确认接续与内部限制修复

用户已明确授权修复并全面检查阻碍不同场景的固定规则。已移除一次返工/第四轮强制收尾、隐藏24次上限、累计8步、候选成员总数误限、100文件/32MiB/嵌套12层等门槛。按实际冻结权限允许成员交接实施，累计步骤/交接读取完整。新增userQuestion具体提问；独立工作继续，原串答复接回原子任务及整合，问题历史不覆盖新完成状态；安全待确认重启不变失败。长Retry-After按服务端时刻持久化等待。UNKNOWN/文件版本/授权/用户停止保护保留。

25文件421项定向回归通过，最后接线补改相关3文件91项复核通过；双类型和构建通过，lint22项原基线无新增。手册14章19图及真实UI新增图19已复核，0真实模型调用、未重放原业务。详见 [R116修复与限制审查](../reviews/r116-adaptive-workflow-repair-20261028.md)。原根因报告为历史现场。

V59已构建交付：desktop-daily-win-v59-r116-adaptive-workflow-20261028，clean源码ff0fdbb9983dcdef7391e2af6aaada0b8043f1f1、BUILD bld_fcbe3a60045a3ae3，615项hash一致；通用ZIP648文件、CRC通过。实际包内Electron通过隔离app.health/19图/正常退出，0turn/0real_call；首次wrapper参数兼容失败保留，最终CDP验证通过。沿用数据入口与V58相同，原数据保持原位。用户需正常退出旧版再开新包，在原串继续旧任务；未替用户切换运行版本。

## 2026-10-28：R116 交付再次受阻的根因已定位，尚未修改业务代码

接续用户指定会话的根因调查：现场12次turn全部成功、outbox全部done、调用预算disabled，第二版复核仍有有据可查的内部修改要求；`deliberationRunner.ts`却以`synthesis.revision === 1`只允许一次返工，因此直接发布blocked并结束PARTIAL。R96起保留的限制在V57随包和当前main均存在；旧议题已全部resolved，不是旧议题残留。最终复用整合稿“已完成”摘要及通用失败提示又掩盖了实际停止原因。

隔离Fake复现3项：预算关闭/100次充足预算下第二次要求修改均停止，第二版ready则正常完成。结果只证明缺陷复现，不表示已修复。证据在ignored dist/r116-delivery-rootcause；私有原文留本机，原库只读、无模型调用或业务重放。详见 [R116根因记录](../reviews/r116-delivery-rootcause-20261028.md)。后续修复须处理多轮返工的版本/预算/停止原因与最新反馈展示，不能只再换一个固定轮数；本轮无业务代码修改或新包。

## 2026-10-28：R115 移除分析开关与高分屏逐页检查

按用户要求使用gpt-6.1-sol/medium与deepseek-flash/high子代理，主代理独立审查和验证。移除R107遗留的“本次仅分析”按钮和普通新发送字段，忽略旧草稿标记，保留历史任务权限及未知信封同号同参恢复。宽屏卡片随空间增列、正文限行、文件/Git树适度加宽、项目设置统一居中对齐；没有新增输入设置或功能按钮。

独立测试8文件31项、双types、eslint、UI构建通过。隔离持久化测试库含4项目10房间16成员21任务78消息20成果与12模板，正式UI33场景×2560/3440两种分辨率×100/125/150%三档缩放，最终198项边界/读取/遮挡检查通过；逐页拼图和关键截图复核，原生Windows另核对房间、恢复和看板。最终证据为ignored dist/r115-layout-review/accepted-all.json；旧verified采集存在恢复弹窗遮挡，不作为验收。手册14章18图，其中3张截图同步去掉旧按钮，0真实模型调用，原用户数据未动。详见 [R115记录](../reviews/r115-high-resolution-20261028.md)。

V58已交付：`desktop-daily-win-v58-r115-high-resolution-20261028`，clean源码`a8f72c8450bcf0e259d1928535172ba74926e553`、BUILD `bld_7f3805d606847ecf`，614项独立hash一致；ZIP646文件、CRC通过，整包手册14章18图和正常退出检查通过。沿用数据启动器在ZIP后单独加入，与V57字节相同，原数据保持原位；源码和交付记录推送公开main。

## 2026-10-27：R114 预算关闭态隐藏与已有设置搜索

用户要求隐藏“调用预算未启用”，检查已有设置遗漏，并指定前端deepseek-flash/max、后端及混合gpt-6.1-sol/medium子代理、主代理独立验收。已按指定配置完成代理分工并审查成果：房间/串/私信关闭态不显示预算胶囊和菜单段，开启态功能保持；AI设置预算搜索补齐且定位开关，说明精简；已有头像编辑、归档、已移除项目补齐搜索定位。后端预算读写正常，无需增加后端能力或全局选项。

主代理独立执行5文件17项定向测试、双types、eslint及正式UI+隔离daemon22项检查通过；手册更新14章18图，新图标明设置页开关。示例为Fake、0真实调用，用户原数据未动。详情见 [R114检查与实施](../reviews/r114-budget-settings-20261027.md)。

2026-10-28完成V57交付：`desktop-daily-win-v57-r114-budget-settings-20261027`，clean源码`cbedcc8e44fca979966a933a9985468325423983`、BUILD `bld_b3462f725237f977`，614程序hash一致；通用ZIP646文件、CRC通过。随包隔离启动、14章18图加载、正常退出与pid移除通过，0turn/0real_call。ZIP完成后再单独加入本机沿用数据启动器（与V56逐字节相同），原数据保持原位。源码和交付记录推送公开main。

## 2026-10-27：R113 当前 main 的 V56 实机测试包

用户要求生成当前版本供实机测试。已从公开main `387c037825f451ea3eee5ac013f09db1bdf790da` clean构建V56，BUILD `bld_8e8a703bde78686e`、613项hash全部一致；目录 `dist/desktop/desktop-daily-win-v56-r113-public-main-20261027/`，通用ZIP `dist/desktop/zhongshuo-v56-windows-x64-20261027.zip`，644文件、CRC通过。通用README和许可证随包；本机沿用数据的专用入口在ZIP生成后单独加入交付目录，不在公开资料或通用ZIP中。

隔离随包入口/Node/daemon启动、手册14章17图加载、正文同源、正常退出码0与pid移除通过，0turn/0real_call；未启动用户原数据。当前并发规则已核查：同成员逐轮串行、任务上下文独立，跨项目独立成员可并行；相关4文件54项本地模拟测试通过。完整包身份、校验值和辅助验证修正见 [R113交付记录](../reviews/r113-public-main-package-20261027.md)。后续源码仍在本公开克隆，旧私有仓库不恢复推送。

## 2026-10-26：隐私清理、main合并及公开发布完成

用户授权检查全部历史、合并main并开源。已在隔离副本匿名化远端全部511提交（开发分支相对原main的504提交完整保留），移除个人邮箱/目录/实际服务器地址，清理示例Word作者属性及2张含个人目录的旧截图。真实业务内容只在本地工具检查点，未推到远端且不进入公开库。原始仓库保留私有，公开版本使用独立清理历史；后续从公开main克隆开发，不合回旧历史。

公开版README、MIT及第三方说明、凭据/数据库忽略规则已补齐。旧回归夹具与当前协作规划/导航对齐后，248文件2033项通过，双types与构建通过，产品执行逻辑未改；Word属性清理后另复核3文件20项通过。完整范围与结果见 [公开源码检查记录](../public-source-review-20261026.md)。

全部504个开发提交已合入[公开仓库main](https://github.com/384615666/zhongshuo)，GitHub确认public与MIT。未登录请求验证新版源码可读、原始旧提交404、原始备份未公开。原始私有库已归档保留；后续使用新公开仓库的克隆，不向公开main推送旧私有库的提交历史。最终历史扫描无新增凭据告警。本机现有程序、聊天和任务数据保留原位。

## 2026-10-26：R112 通用新手图文手册

用户要求手册给所有用户阅读，去本机交付路径/专用启动方式，配图让小白能照做，不写推卸责任的话。已重写14章通用教程，以“读书会筹备”为同一示例，17张带编号的真实UI截图对应短步骤和结果；发送后用三格图解。个人升级安排从手册中剥离，交付时单写“本机升级说明”。README与施工约定同步要求图文维护和读者分离。

图文脚本lint、UI构建、正文图片/路径检查通过；正式组件14项及900/1440/3440、深色通过，17张图全部正常加载。采集为独立数据库/项目3次Fake示例、0真实调用，正式桌面身份的私信截图读取正常；编号/裁切与截图已核对。可复用采集脚本 scripts/capture-user-guide.cjs，具体证据和边界见 [R112记录](../reviews/r112-public-illustrated-guide-20261026.md)。不碰原用户数据或任务，保留debug删除和无关untracked。

V55包desktop-daily-win-v55-r112-illustrated-guide-20261026，源码05f21aadcd54dd1988ccab186e30cc6cba009d81，BUILD bld_241fcc311cf698cb，613项hash一致、内外版正文按图片路径归一后一致。整包17图加载及独立手册通过，0新turn/0real_call，正常关窗daemon退出0、pid移除。包内通用README与“本机升级说明.md”分离，当前用户按后者运行start-existing-data.vbs继续原数据；启动器字节与V54一致，未实际切原数据。dirty仍为原基线；按既有授权推送源码与交付记录。

## 2026-10-26：R111 独立操作手册页签

用户嫌V53帮助关于中的手册排版难看，授权独立页签。已实现“设置 → 操作手册”，手册全高阅读、外层不滚动、扁平目录/正文，去灰底卡片/阴影/混排诊断。宽屏目录在左，正文有阅读行宽；窄窗设置导航一行且选中项可见，正文不裁切。使用同份正式tokens并同步主题，14章完整，移除重复导航表；用户手册与维护约定同步改入口、V54/R111。deepseek-flash/high子代理402余额不足未产出，已关闭，由统筹实现。

双types、build、相关lint及12项隔离Electron正式组件检查通过，900/1440/3440无裁切/内外横溢出/外层纵滚动，深色通过。先前窄窗grid最小宽度问题已从截图发现修正；证据和边界见 [R111记录](../reviews/r111-guide-tab-20261026.md)。不跑原任务/真实模型/远端sandbox，保留debug删除及无关untracked。

V54包desktop-daily-win-v54-r111-guide-tab-20261026，源码27e9a086d3eb38a7fee91cce8401fcdb1c86fd91，BUILD bld_4b727a5a3065e6d0，599项hash一致、内外手册正文一致。整包资产/随包daemon隔离启动通过，帮助页与手册分离，0turn/0real_call，正常关窗退出0、pid移除。实际界面截图在ignored dist/r111-guide-smoke/package-data-3d0beda7/package-settings.png。沿用原数据用新包start-existing-data.vbs，旧V44数据不搬；未实际切用户数据。dirty仍为原基线，不称clean；源码与交付记录按既有授权推送GitHub。

## 2026-10-26：R110 设置内完整手册已接入

用户要求手册放进设置且以后更新同步维护，已实施“设置 → 帮助与关于”直接阅读14章完整手册，并接现有设置搜索。`build:ui` 每次从 docs/user-guide/README.md 生成设置内本地资源与离线HTML，打包附带离线版；README及施工总任务书写明功能/入口/交互变更须同步改手册、版本、日期及相关截图。只做此项，不恢复旧52项扩张。

已实际派发 zcode/GLM-5.3-Trial / max，子代理因429重试失败，无修改产出，已关闭，由统筹完成。双类型、构建、本轮代码lint、11项隐藏Electron正式组件及同源手册检查通过；900/1440宽窄无横向溢出。未启动产品真实模型或用户原数据，未跑全量/真实模型e2e/GitHub sandbox；具体检查边界见 [R110记录](../reviews/r110-settings-guide-20261026.md)。

V53包desktop-daily-win-v53-r110-settings-guide-20261026，源码947e2586e08f35fe1b5bad807769d86d4aa84cb9，BUILD bld_27ac1b55c2fedc88，599项独立hash一致，内外手册正文一致。设置整包资产+随包daemon隔离启动检查通过，0turn/0real_call，正常关窗daemon退出0、pid移除；辅助启动器前两次失败及无遗留进程边界保留在报告。start-existing-data.vbs继续原V44数据位置，用户正常退出旧版再开；未实际切换用户数据。BUILD.dirty=true仍为既有debug删除及untracked，不能称clean。提交推送按既有授权进行，保留4个debug删除和无关untracked。

## 2026-10-25：精简7项已实施，V52已交付

用户最新明确说“开始做吧”，已授权实施 [精简7项](../design-proposals/usability-20261025/simplified-scope.md)，不再停在待评审。范围仍以该精简版为准，不恢复旧52项界面设计。当前统筹在D:/zhongshuo直接修改既有源码；保留4个debug删除和无关untracked。用户既有GitHub推送授权继续有效。默认测试已排除githubSandbox，绝不运行专用GitHub sandbox或真实模型/e2e套件。

源码已完成、相关回归19文件189项通过，完整手册14章已生成HTML；具体改动及验证边界见 [R109实施记录](../reviews/r109-simple-implementation-20261025.md)。V52目录desktop-daily-win-v52-r109-simple-20261025，源码6a852d9a37803593509e17c1e086ab1499a05488，BUILD bld_801877b1549cd5e9，595项独立hash一致。整包Fake隔离实例1turn任务DONE并正常退出，daemon.pid移除；无真实模型调用，未切换用户原数据。包内start-existing-data.vbs沿用旧V44数据位置；先退出旧版再开新包，不迁移数据。BUILD.dirty=true来自保留的既有删除/未跟踪材料，不能称clean。

普通发送让模型使用既有协调/交接，原V51显式并发队列通过单独legacy fixture继续验证，不能恢复成按正则或按钮选择顺序。成功找回自动定位并隐藏查询块，新私信上下文保持独立。主工程/hifi类型通过，修改文件32项lint均原基线、无新增；不要再重跑已通过的189项或用户原任务，除非源码变化或出现新问题。原生退出弹窗手点与Windows通知真实点击未验，不冒称通过。旧演示首次误选停用成员的失败已保留并确认无遗留进程，使用显式Fake fixture后通过。

实施中：标题栏X简单退出确认；项目菜单现有行显示完整目录；正常已收发送不常驻找回块、查询成功直接定位原消息；现有回复串自导航过滤；继续原请求移除固定analysisOnly=true（后端会继承原请求原有只读范围）；选区引用不截400字；Toast取消旧计时器；快捷面板成员直达详情。后续继续补协作接线、旧任务成果读取、设置/通知落点及完整手册、必要验证与包交付；尚未验收或提交，不把进行中改动当完成。

## 2026-10-25：用户否定界面扩张，旧52项推荐及原型撤回

**最新权威是 [精简后的7项清单](../design-proposals/usability-20261025/simplified-scope.md) 与同目录 cut-decisions.json。** 用户逐项反馈U01–U22后要求砍掉全部不必要新增界面，先看精简版再修改。不能继续按下方旧推荐、旧优先级或子代理评审施工，也不能把本轮裁剪理解成已批准实现7项。

保留方向仅为：X退出时简短确认；现有位置显示已选文件夹路径；建房沿用原默认AI选择；完整真实操作手册；现有消息派发/完成/继续行为修复；现有入口正确落点；现有内容与重复展示错误修复。新建私信保持独立上下文，不增加标题、搜索或续聊提示。

**用户明确要求：** U02/U03草稿改造不做，U04迁移/启动扩展与U06备份扩展不做；U09不记住上次位置；U10范围不改；U12/U13不加说明/新状态；U14不用防御性产品文案；U15只精简，U16不加功能；U17/U18不改输入框、不加提示、不新增正则或顺序设置，让模型理解并用已有通道派发；U19不新增检查功能，完成判断只反映实际执行；U20不加界面信息，U22不加按钮或功能。后半段的新搜索、筛选、恢复按钮、配对引导、通知例外、表单确认、诊断与设置扩展同样撤掉。

原52项中32项退出本轮，19项仅收窄为7组现有流程修改，U21一项沿用现状。原 decisions.json、详细报告及原型是历史材料；overview.md已改为精简版入口。本轮只更新方案文档，不修改业务代码、不实际删除既有功能或数据、不调用模型或运行项目测试。

## 2026-10-25：统筹逐项决定与界面原型，继续等待用户评审

用户要求给出统筹自己的意见，逐项讲清怎么改、分歧与推荐，并为能看见的前端画小原型。本轮权威入口为 [52项决策速查](../design-proposals/usability-20261025/overview.md)，[详细逐项意见](../design-proposals/usability-20261025/README.md) 与同目录 decisions.json 保留每项两位评审意见、我的取舍、推荐、理由、验收及P01–P11场景。DeepSeek逐项52项；GLM只评论20项，余32项标为未单列，不当作赞同。推荐优先级调整为P0 5 / P1 27 / P2 20。

主要取舍：自然聊天默认识别明确两人顺序，可见预计安排且可调，歧义才确认；复用既有AUTO依赖、结果绑定与完成门。继续原任务不静默切只读、不自动扩权。待确认发送跨页收进现有待处理，查到原消息就精确定位，成功收起异常。现有看板与会话筛选补本人私信，不另建平行系统；新建私信保持独立上下文。成果修改用“提交并开始修改”主动作；文件恢复接现有changeset.undo并显示冲突。表单与键盘随改动同步达标，普通开关仍可即时保存，避免全局强制向导。

对话原型在本线程可写visualizations目录，主工作台11场景加两种协作输入方式对照，均为纯本地虚拟数据，不连接项目、模型或磁盘操作。仓库仅保存决策文档、原型截图及检查记录，不能把这些示意当成已上线界面或已完成真人桌面验收。正式用户手册仍随未来实现更新。

本轮只做设计与原型，没有修改业务代码、封包、运行项目测试或真实模型业务。用户仍要求先看整改方案再修改；“继续”指继续完成当前设计交付，不授权实现全部52项。推送按既有授权只提交本轮方案材料，保留4个debug文件删除和无关untracked。

## 2026-10-25：用户指定 DeepSeek Flash 与 GLM 5.3 Flash 的独立评审已完成

用户明确要求将全项目总结发给这两个子代理，从人类和实际使用角度复核。统筹实际 spawn `newapi/deepseek-flash` / max（`01a1713a-8c93-7d51-b566-9bb2d7558181`）及 `newapi/glm-5.3-flash` / max（`01a1713a-8d12-72f0-a124-c73bbc291f29`），同一52项底稿、互不读对方结论。DeepSeek 交逐项评审；GLM 首次长输出触发 max_output_tokens，同一代理压缩后成功交付。DeepSeek 的 U34 初稿误把已有撤销能力当新功能，统筹独立查正式命令后要求有界复核，该代理已更正。两位均已完成并关闭。

权威取舍见 [双模型评审汇总](../reviews/usability-peer-review-synthesis-20261025.md)，原件为 [DeepSeek逐项评审](../reviews/peer-usability-deepseek-flash-20261025.md) 与 [GLM精简评审](../reviews/peer-usability-glm-5.3-flash-20261025.md)。已有AUTO依赖/上游绑定/完成门、正式changeset.undo/冲突保护/续跑不能被抹成不存在；改为补收件人到计划的接线、上下文动作和正式UI入口。52项仍为候选，不整体批准；U01降按P1处理活动退出，U26视为P0意图问题；合并动作与恢复链，缩小全量发送历史/全文索引/新向导，差异默认范围不强行统一。共享组件在改到处同步补键盘和焦点，不做阻塞核心闭环的大重构。

本轮仍仅方案文档；没有业务代码、封包、测试、用户原任务或数据库操作。GLM原文观点保持，仅由统筹校正四处引用位置。后续等待用户评审具体范围再施工；不能把子代理赞同或本轮授权评审理解成批准实现全部52项。

## 2026-10-25：体验审查扩展为全项目，仍先方案后施工

用户澄清要检查整个项目，不仅是最近功能。新权威总表为 [全项目使用体验排查](../reviews/project-wide-usability-audit-20261025.md)：12 类使用流程、52 项问题与改进点（含前 R109 的 15 项，新增 37 项），另列 12 个待实机体验场景，区分代码路径确认与真实 UI 验收。覆盖首次使用、数据、导航、成员权限、多人协作、私信返工、状态恢复、文件成果、搜索归档、看板待办、设置通知配对、通用表单键盘反馈。当前仍仅交付方案，不改业务代码、不重新封包、不运行模型或原业务。

新增重点包括：清理草稿直接删含未确认发送的持久化键；24h 普通草稿过期规则；最后窗口关闭即后台停机；旧任务成果从项目最近100条再筛导致条件性假空；选区引用静默截400字；快捷面板成员不到详情／24项截断；搜索返回丢筛选；设置搜索手工索引与旧定位词；正式改动详情无内容撤销入口而非Git提示仍承诺撤销；Toast旧计时器可清掉新提示。已核实当前文件页用 FormalChangeDetail，不能误报未挂载旧 ChangeSetDetail 的原型编辑器和未接入撤销按钮。后续应基于全项目总表评审批次，不能收到“都找找”就自动开工或只修最近15项。

## 2026-10-25：用户要求先审查实际使用流程，暂不施工

用户反馈：Claude 说没有向 Codex 派发通道；串内“打开回复串”却去详情；“查询刚才的发送”只在原会话且常驻。**用户明确要求先列问题表和整改方案，看过后再修改。** 当前只交付 [使用流程排查与整改方案](../reviews/r109-usage-audit-proposal-20261025.md)，未改业务代码、未重新封包、未重跑用户任务；不能把早先修复授权解释为本轮可直接开工。

只读原库核实：这次含“然后@Codex”的跟进仅将 Claude 保存为正式 mention，DIRECT/direct.work、只有 Claude 一条执行请求、成员交接 0；其工作结果明确记录 Codex 验证未发生，任务仍 DONE。现有纯 mention 解析函数能复现中文相邻 @ 漏识别。源码确认 thread 状态动作固定 `?tab=run`；找回入口只按当前 draftKey 读取且 accepted 仍显示；找回优先 task 深链落概况；“按原请求继续”实际固定 analysisOnly。方案共 15 项，先解决收件人与有依赖协作／完成判定，再整理上下文动作与跨页找回，其后整理状态、通知、应用内帮助与升级入口。接下来等待用户评审选择，不自动派发给编码会话或启动子代理修复。

## 2026-10-25：用户操作手册随版本交付

用户要求“添加了新功能应该把操作手册一起给我”。操作手册统一放在 [docs/user-guide/README.md](../user-guide/README.md)，配隔离演示项目截图；`node scripts/package-user-guide.mjs` 生成离线 HTML，追加桌面包绝对路径参数即可只补发手册、不重建程序。`make-desktop-daily.mjs` 在各轮旧说明写完后自动附带根目录 `众说操作手册.html` 和 `操作手册/`，并在 README-DAILY 顶部放当前指引。最终 V51 原数据入口仍为 `start-existing-data.vbs`，不改程序、启动器或数据。

**后续新增功能、改变按钮入口或交互时，同步更新操作手册、相关截图和适用版本，生成 HTML 并随包交付；工程验收报告不能代替用户操作手册。** 说明应包含用途、实际入口、分步操作、结果含义、常见异常。通知真实点击仍未实测，不得在手册或交付中写成已验证。

## 2026-10-25：R108 四项实现与最终 V51 交付

指挥会话 `01a16d02-2621-7330-afbe-b2d116627da4` 已接替旧指挥会话；用户已授权“先做123和修复展示问题”。统一权威执行状态、耐久原发送只读找回、daemon事件→Electron桌面通知及精确补交链展示已完成。完整实现/验证/限度见 [R108交付报告](../reviews/r108-usability-20261025.md)。

最终候选 `dist/desktop/desktop-daily-win-v51-r108-usability-final-20261025`，BUILD `bld_b2ef163be3dc2c99`，595项manifest一致，47文件冻结无漂移，daemon SHA `b98ed4b63c65f16fa2acc863735cee0532f9e53c0c15e055429ea4de4c52aab5`。首候选 `desktop-daily-win-v51-r108-usability-20261025` / `bld_170856db95e65228` 保留；最终新增窄修为找回成功按draftKey+commandId清本次旧错误、保留后来错误/草稿，以及通知设置去除内部实现文案。

**沿用原数据仍从最终包 start-existing-data.vbs 进入，原V44 server-data原地不搬。** V50正常退出后完整冷备872文件/255986849B逐项hash匹配；原库58→59，原比较任务DONE/rev6、全部业务/消息/成员配置保持，真实calls仍23，无active/pending，原库通知0。08/09原生图实际显示#3“原答已补交”默认折叠、#4有效；历史原文可展开。最终V51原库窗口留在该任务，未重放原业务。

隔离Fake实机4task/4turn、0realcalls；最终图10/11/12验证重开找回及成功清旧红字，13实际成员活动，14完成且成员名正确，15实际Electron投递4次且均shown/attempts1。旧两条投递跨重开时间和次数不变。**OS通知实际点击未验**：编码与统筹Sky均无可返回系统通知目标，禁止Win快捷键/自造UIA；没有伪造clicked。主进程点击/深链测试与实际show回执单列，不能写成全部原生验收通过。

最终完整回归在末尾UI窄修前为2022过/1失败（246文件245过/1失败），唯一为未改动Codex回放日志即时读取，单文件20/20复核过；窄修后组件3文件16过（含隐藏Chromium真实Composer7断言）、双types过。lint38项均HEAD基线（源32/旧测6），diffcheck过。父会话所有测试显式排除githubSandbox，不为低影响UI重复全量。

**偏离须持续如实记录：两名子代理分别00:44:56与00:49:06裸跑全量，实际向GitHub测试sandbox写入6测试提交/2分支。** TLS发生在后续clone，不能声称无远端写入；初始误判已更正。原始工具票/统筹只读核验见R108报告与ignored证据；未做远端清理，不继续扩大调查。默认测试已排除该suite，专用配置须另获明确运行授权。

统筹已独立核验最终595项程序清单、47项冻结文件、872项完整备份、原库8张业务/配置表及最终原生截图，结果见 [R108统筹独立验收](../reviews/r108-coordinator-review-20261025.md)。本轮源码、测试、默认远端测试排除配置及两份交付报告，由统筹按用户授权统一提交到 `origin/codex/full-implementation` 并核对远端；实际提交号以Git记录及统筹交付回复为准。OS点击仍保留未验边界，编码会话不再改源码/封包/索引/HEAD；保留4个既有debug删除、无关untracked、V50/候选/备份。后续等待用户反馈，不新增模型、重跑原任务或重新调研。

## 2026-10-25：重复回复核查与开源功能吸纳评估

用户截图 #3/#4 确认为同一调查的原答与 format_repair 补交版重复展示：原答 9970 字符、补交 8315 字符；原回合因交接收件人 ID 校验失败，补交工具启动为 0。现有去重只覆盖同 turn 精确正文，跨补交链展示缺口尚未修复；已向编码会话登记，未修改源码或原数据。用户本轮要求判断和功能评估，没有启动新功能施工。

统筹本人核对开源远端仍为 `4e73c4c8`，并重新阅读源码，详细 13 项吸纳表、现有能力差距、优先级/工作量和验收建议见 [吸纳评估](../reviews/multi-agent-adoption-assessment-20261025.md)。首选统一状态卡、原请求找回、完成通知与工具长结果按需读取；代码地图/更多执行端/外部 MCP 属后续扩展。众说上一轮源码已推送到 `origin/codex/full-implementation` 的 `47c7e596`，远端已核实相同；本轮只新增文档，不新增模型调用或包。

## 当前状态：R107 / V50 技术验收通过，等待用户反馈（2026-10-24）

指挥会话 `01a16d02-2621-7330-afbe-b2d116627da4`。完整交付见 [R107 原比较任务恢复与只读分析](../reviews/r107-analysis-preflight-20261024.md)。最终包 `dist/desktop/desktop-daily-win-v50-r107-analysis-20261024`，build `bld_64960bf21b281f99`，595 项清单一致，daemon SHA-256 `e2bc23bc6aa2d04bcc0848c5bffc5269f8cbbc748235a1f6b9dcb60390816fda`。**沿用现有数据使用包内 start-existing-data.vbs；仍指向 V44 server-data，不搬移或覆盖。**

用户实测原任务 `task_993d7e3e-ad2c-4951-a24a-a7d1a760ce0c`（zhongshuo / D:/zhongshuo / 默认房间 #1 / Claude AUTO）已 DONE/rev6，查证子任务 DONE，原串六条回复和 22,296B 完整七维对比文档已可见。初始故障是 changeset 写入基线包含 dist 旧包、5007 文件 truncated，0 run/turn/call；不是 Codex 指纹。根卡/串/详情现在直接显示持久的具体原因与 NOT_STARTED，原失败卡可“仅分析继续”，新根消息可选“本次仅分析”。只读意图在普通继续、同串、AUTO 子任务/交接/整合继承，不从原 full scope 或 bypass 默认升权。

真实新增 calls20–23：3 成功、1 Codex 复制错 Claude 长 ID 的合同失败；已手动通过正式 `task.redispatch(formatRepair=true,useCurrentExecutionSnapshot=true)` 只读补交原结果，补交 toolStarts=0，失败事件/旧 FAILED run 保留。不是全自动无失败。四个 session 的 full/modification 均 false、analysisOnly 均 true。**可写大目录完整基线超限仍拒绝，未放宽或宣称全量写入已修。** 未新增第二个相同业务根。

全量 237 文件 / 1964 项通过（排除 githubSandbox），双 typecheck 通过；lint commands10/Room12/store8 为既有 30 项，store8 已 HEAD 复现，其余定向检查通过。模型窗口 2583 个 tracked+非 ignored untracked 路径（含4个既有删除）前后无字节变化；原 task scope/成员配置不变。activeTurns/pendingOutbox=[]、未释放租约0、备份 integrity=ok。证据根 `dist/review-r107-preflight-20261024`，01–04 原生截图逐张 view_image 核对；完整对比 artifact hash `9b221d7ca3eb5ea6007b9e0efb3f7e06e641a3dffb3a2fa2f805625a9d7ef4c8`。完整数据根升级前冷备、完成后在线备份均保留。

统筹已独立核验包、原图、原scope/绑定/字节清单与最终状态并明确技术验收通过；原生 V50 保持打开在比较文档预览。用户随后于 2026-10-24 明确要求推送 GitHub，由统筹统一选择性提交 R104–R107 源码、测试与八份修复/审查报告到 `origin/codex/full-implementation`，并推送此前尚未同步的本地提交（含 138e999），不改写历史。原数据、打包产物、无关设计/工具目录及既有 debug 文件删除不纳入本次提交；下文各轮“未 commit/push”为当时的历史状态。实际提交号与远端一致性以本轮 Git 交付结果为准。停止新增模型、业务执行、功能或封包，等待用户新指令。

## 历史状态：R106 / V49 技术验收通过（2026-10-24）

当前指挥会话为 `01a16d02-2621-7330-afbe-b2d116627da4`。本轮四项产品修复与最终事实见 [R106 产品修复与验证](../reviews/r106-product-repair-20261024.md)。最终包 `dist/desktop/desktop-daily-win-v49-r106-final-20261024`，build `bld_49b786e55f9b69ef`，595 项 payload 清单一致，daemon SHA-256 `f56a44ae228c240b9f5c6820643324a09c8d2e90569793857bec1eb6b1a30501`。**沿用现有数据使用包内 start-existing-data.vbs，仍指向 V44 的 server-data，不搬移或覆盖它。**

已修标题装饰、主池长正文约五行/长辅助摘要三行、Codex 版本化配置指纹与无推理准备、明确未派发提示、单初稿加其他成员预派发失败时不单人整合/自认，以及跨项目同名房间的首次点击与正式导航持久化。准备返回 proof 并贯穿事务复核；旧无版本/显式 v1 Codex scope 用精确 v1 比较，旧失败不被 v2 自动收养；0-run DM 恢复用独立意图键且保留 UNKNOWN 保护。

最终全量 231 文件 / 1933 项通过（排除禁止的 githubSandbox），双类型与主要变更 lint 通过；commands/Room 仍有 10/12 项历史 lint。原生 UI 最终新票及独立审计在 `dist/review-r106-product-20261024`。旧误标截图保留并在 evidence-errata.json 作废；以逐张打开过的 verified-01/02/04/05/06/07/09/10 为准。

真实新增 5 次调用（4 成功，1 短答 claims 合同失败后同 run fx 补交成功），无在途 turn、未释放租约 0、业务工具 0。Codex 私信与只 @Codex 的房间直接回复均已可见，实际配置 newapi/deepseek-flash/high；双成员短交流仍只发布主持者合并回复，不称每席均可见。原 #4 保持 BLOCKED/原 5 调用；需求文档保持 25556B、SHA `744d45626e056c061facf05f6a0632ab18d80b63298983a7e95364d9b70ab3d2`。原 DM scope 原始字节未改，显式当前配置恢复后 DONE。原两人独立研讨输入偏好已恢复。

本轮保留本地导航提交 `138e999`（子代理创建，未 push），后续本轮补丁为 WIP。不要 reset/revert 共享修改或自动重放旧业务。原配置失配只能证明整体指纹变化；无旧分项前像时不能把某个 trust 块说成唯一原始原因。用户已有启动路径优先级保持：正常重开可按 ui.autoOpenProjectPath 返回默认项目 A，不能为测试改用户启动设置。开源比较由统筹独立完成。

## 历史状态：R105 / V47 已验收，统筹已接管（2026-10-24）

用户已要求新统筹接替旧会话 `01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79`，并回复编码会话 `01a16bd8-dbb4-7553-93eb-aecb1395c860`。当前权威断点见 [R105 统筹接管与验收记录](../reviews/r105-coordinator-takeover-20261024.md) 和 [R105 修复报告](../reviews/r105-recovery-20261024.md)。V47 的 595 项包清单已重新核对，恢复专项重新运行 30/30 通过，原任务已恢复收口。当前等待用户实测反馈；下方 R87 及其后续旧施工段落为历史记录，不能据此自动重开旧任务。沿用原数据须用 V47 的 `start-existing-data.vbs`，并保留其指向的 V44 `server-data`。

## 历史施工：R87 自然协作与电脑小白易用性（2026-10-17）

人类在审阅会话01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79明确说“开始这一轮吧”，已通过read_thread核对原userMessage。权威范围见 [R87完整任务书](r87-product-usability-plan-20261017.md)；原方案“尚未实施”是历史状态，现已授权持续完成施工、真实验收及最终集中交付。唯一产品写入方为本会话，审阅方只读，不启新代理。

**2026-10-18 rc4 当前候选（覆盖下方 rc2/rc3 断点）**：无协议提示反例确认，旧 rc2 虽把 `outputSchema` 传给 Codex `turn/start`，自定义 GLM 路由仍返回 Markdown 并被正确判为 `turn.outputInvalid`。兼容修复提交 **`ecaef7d5ac7683619986608af7fc294a8b209326`** 在 Codex developer 指令层强制结构化终态；随后 **`16700ed86a65de28e6ca506c79f4dbf4804f1175`** 抑制计划步骤重复 handoff 产生的额外 OPEN 子任务。从 `16700ed` 的 clean worktree 构建 **`bld_da8c2e34f5842bd5` / `desktop-daily-win-v26-r87-rc4-20261018` / 595 清单 / `dirty=false` / 无 `server-data`**。

新一轮隔离根的人类正文和成员描述均不含 `TaskComplete/schema/JSON/Markdown/answer` 等协议词；Claude `deepseek-flash` 与 Codex `ccs-new/glm-5.3-flash`（reasoning `high`）共 **6/6** 真实调用与 turn 全部成功。协调 run `run_91c6a570-bf89-42ce-b231-e6ef53009ab8` 完整走完 3 个计划子任务和最终 integration，`coordination_messages=0`，2 条与计划下游目标重复的 handoff 被程序审计后抑制，根下仅 3 个计划子任务且全部 DONE。根 task `task_811f8365-3c39-4dc5-9614-4136282cda37`、thread `thread_8677e0f6-f6df-43ee-8eba-53076b000ccb` 当前为 REVIEW，pending delivery `dlv_turn_2470538f-94fa-4ef5-b48f-70d64d05fc2c`（revision 1，integration run `run_69aa019d-6572-4fcd-9263-29e6e1197ac6`）；`报告复核-v1.md` 26,876 B、SHA-256 `3dc68cdaffdeb3a89a2506aafa97f24f5eb01fcf5628ce020a8b9f15299fa27d`。

最终聚合 [r87-rc4-final-evidence-20261018.json](r87-rc4-final-evidence-20261018.json) 在评审前封存为 `ok=true`、17 项检查全过、`releaseQualified=false`；独立评审后不改原票。全量单线程首次运行 169/170 文件、1258/1259 项，唯一失败是文档测试检出 WPS 而非 Microsoft Office；该文件独立复跑 5/5，随后完整单线程 JSON 回执 **170 文件/1259 项全过**（536 test suites、hash `ecf2e67d53502e0247760b180a614661bf03c173bf68a74b6fd023d35a7e0800`）。rc2 的 8/8 工程提示回路、natural-1/2/3、额度失败、rc3/rc4 提前关窗根和旧保存 CDP timeout 均作为历史保留，不计入 rc4 成功。

**独立评审附录**：[评审原件](r87-rc4-independent-review-appendix-20261018.md)（SHA-256 `dd8f030f363208ebfa2e1fce6851befa4f2669ef2b1a9dd663dfb0f9dc775557`）与 [机器可读结论](r87-rc4-independent-review-status-20261018.json) 确认无阻断项，`independentReviewPassed=true`、`candidateReadyForDailyUse=true`。主审 PASS33；Codex transport 8 组 60 项；动态 handoffs 5 场景 71 项；54 份历史原件 hash 全相等。原封存 JSON 保持 `releaseQualified=false` 与 SHA-256 `9e6c4edce9173d567ba3c01168fe57050d080862d0715a25eca2cbe02d2e2df0` 不变。该结论是有限工程候选评审通过，不是用户已验收任务，也不代表 rc4 原生 UI/保存路径重新跑过；实际 GLM reasoning 为 `high`，rc4 自然根是计划步骤上游传递且 `coordination_messages=0`。

**rc2/d9 历史工程与 UI 基线（覆盖下方 977 收口）**：`d9bc8c8e14f9d68fe34769e1402ee3dfe06d04db` / `bld_2b4d48d74833429d` 的 595 文件 clean 包继续作为非模型 UI、数据、旧包和保存门的来源；rc4 两个 scoped commit 只改 Codex structured-final developer 注入与协调重复 handoff 抑制，按审阅范围未重跑这些非模型门。rc2 mixed-4 的 8/8 调用是带用户正文协议提示的工程正例，不能冒充无协议自然验收。977/`bld_939523319bbbd61d` 从此只算更早前候选，不再称最终。原 rc2 全量单线程为 170 文件/1257 项；同 BUILD 的欢迎/项目取消、添加 AI、键盘与 IME、保存取消、数据备份、旧包导入、看板和恢复摘要证据继续保留，入口见 [逐页便利性登记](r87-page-usability-registry-20261018.md)。

**rc2 工程提示历史正例（不是无协议自然验收）**：全新隔离根曾完成两条精确模型的 8/8 成功调用：Claude 成员 `DeepSeek 审查` 使用 `deepseek-flash`，Codex 成员 `Codex GLM 复核` 使用 `ccs-new/glm-5.3-flash`、reasoning `high`。该回路真实 Codex 子任务、协调步骤 `downstream.upstream`、专项 DOCX/PDF 发现、DeepSeek 合并、普通追问、显式 v2 和精确验收均闭环；task `task_6736c142-f74d-431a-97d5-548eb11263e9`、thread `thread_4c832b06-cf68-43ae-9257-7bdccfa560e3`、accepted delivery `dlv_turn_1e6fd57d-88ae-4e2a-a9b0-0210036a7539`（revision 3），`报告复核-v2.md` 14,085 B、SHA-256 `c62c864f3bcfa8775dc58032ce57510bca4de7f5c688ff73a79202ca4d5ee504`。该用户正文含协议提示，故只作历史工程正例；最终 rc4 票见上。

在上述 rc2 工程正例中 `coordination_messages` 为 0；有用结果通过 `coordination_steps.downstream.upstream` 传递，不把该根称为动态带外 handoff。动态能力只沿用此前独立正式 worker 测试或 977 真实票的范围。历史失败没有删除或改写：mixed natural-1 的 5 分钟 deadline UNKNOWN、natural-2 的 10 分钟 deadline UNKNOWN、natural-3 的 GLM `turn.outputInvalid`、较早 `gpt-6-luna` 周额度 FAILED，以及首次混合保存重开的 CDP timeout，均由最终聚合器按同 BUILD 包数据库/原 JSON 哈希保留。原 natural-4 的自然脚本仍在验收按钮选择器处 `ok=false`，后来的精确 pending-delivery UI 验收单独存证。rc4 当前核验只补无协议自然协作与有用结果；Chromium/系统自动化不等同真人小白认证或用户最终验收。

**2026-10-17 15:50 收口（覆盖下方旧断点）**：新开发席已完成 R87 完整数据引导、设置/恢复/成果简化、首次 AI 创建后的成员投影刷新，以及同包真实双模型报告路线。源码提交 **`9771a8a39caec15c85429580b78827ef9f8baca0`** 已推送；从 clean worktree 构建 **`bld_939523319bbbd61d` / `desktop-daily-win-v26-r87-20261017` / `dirty=false`**。同一 BUILD 的 Claude **`deepseek-flash`** 与 Codex **`gpt-6-luna`** 共 9 次真实调用全成功，完成合成 DOCX/PDF 读取、同串扩员、@本串全体、交接回传、普通追问、明确修改、精确 revision 3 验收、预览保存原件和正常 BAT 重开；重开后调用数仍为 9。数据引导在同一 BUILD 的隔离副本完成 75 文件完整备份、切换到新副本和 BAT 重开，0 模型调用。证据见 `dist/review-r87-final/final-natural-1/result.json` 与 `dist/review-r87-source/r87-data-copy-probe-2026-10-17T15-32-48-812Z/result.json`。全量测试 170 文件/1254 项通过、双类型通过、本轮改动文件 eslint 通过；全仓 eslint 仍有既存历史失败，不能宣称全绿。用户原根、旧包、`.codex-deepseek/` 和凭据未动。最终交付报告见 [R87收口记录](r87-final-delivery-20261017.md)。

**2026-10-17 09:56 最新断点**：28bc59d模板跨渠道修复已提交推送，审阅源级关闭。完整数据引导已有第一层核心src/contracts/localDataCopy.ts与9个正式数据/隔离宿主证明用例：完整字节和空目录、profile不拆分、已关闭证明/活动PID拒绝、重叠/链接拒绝、容量预算、ENOSPC/EACCES、原件变化、schema拒绝、篡改/未完成备份拒恢复；0模型。第一真实工程反例：readonly SQLite检查也在保存payload旁创建wal/shm，导致manifest失配，原data-copy-readonly-sidecar-counterexample票保留；现仅对新建独立scratch复制的DB/WAL/SHM做验证，payload原字节再次核对后才complete，9项过。**尚未宿主/helper/设置入口，不能交付或称完整备份已可用。** 独立审阅额外指出备份容器data/manifest入口先realpath会解引用junction，已在读取前lstat/包含关系拒绝并加容器data-junction负例。需要实现src/ui/main.ts可信窄桥、随包Node关闭后copy worker、独立只读进度窗口、原根同级控制指针及正常BAT记忆数据选择，计划见设计。不得在线cp LevelDB，不得改迁用户原根。

同时强化普通会话型评审/汇总（responseKind=conversation）实际交接仍有正式上游版本的正例，19项成员串回归过；修正审计把只读协作答复误称“已发生文件差异”的文字，workBasis区分coordination-output/project-diff/write-tool，原模型协议不改。2文件27项通过。当前继续设置/恢复/成果与完整数据UI，最后新cleanBUILD原生自然Office两模型闭环；不要停工或重复老包最终宣称。

**2026-10-17 09:49 继续断点**：4840c6a已提交推送，主线7d01→411e8c2→e646d70→1de93be→4840c6a远端一致。审阅对411e8c2五组交接、e646d70十组路由及4840c6a迟布局修复独立PASS，均0模型/非原生。审阅发现模板切渠道只改kind、残留旧model/executable/effort；现已用runtimeChannelPatch修复且正式模板保存/回读Claude↔Codex正例通过，显式plan权限不变、0真实调用，2文件9项（含reading4）过。数据完整引导正在施工设计，详见r87-data-guide-design-20261017.md，**只有设计，尚无代码入口，不能当已完成**。接下去先实现closed-root完整copy+校验+宿主重启指针与本地UI进度，原根不动；再设置/恢复/成果简单化及逐页矩阵、最终同新BUILD真实BAT自然DOCX/PDF两模型流程。不要停在这个提交。

**2026-10-17 09:46 最新断点**：HEAD1de93be（修Codex严格native输出handoffs必填、升级/旧证书保真与旧默认语义回归）；完整第一次源码167文件1230项1223过/7失败，原票保留，逐项修后7文件41项全过。配置及首次入口这组WIP已完成：新member.runtimeCatalog真实元数据（无推理）、搜索模型与等级联动、独立runtime随member.create原事务、首可用协调者默认（不替换旧可用/不改模板合同）、新房间协调者只从自身名单选；8文件38项/双types及新模块lint过。原生尚未验收。OpenFolderModal已改选定后直接打开并保留最新导航意图。审阅精确e646d70发现受控迟布局丢历史锚点，已修8秒有界恢复+用户输入取消，4永久用例过。完整Word测试生成8文件已归档dist后按HEAD原blob恢复，后续新测试输出独立dist目录，用户数据/旧包未动。

下一步：把本阶段提交并给审阅精确版本；继续全应用简单化，**完整已有数据/备份恢复实际入口尚未实现**（需closed-root完整copy+校验，profile草稿未知账本一起保全，原根绝不迁移覆盖；不可只做提示文案）。设置/恢复工程动作收高级诊断，成果就近修改/确认保持精确版本；逐页便利性记录。最后同一新clean BUILD空白数据BAT/真实鼠标键盘/中文IME/窄窗DPI，用合成DOCX/PDF含真实错误做DS+准确gpt-6-luna真实协作→追问→实际修改v2→验收v2→保存原件/reopen。**仍0新增真实模型，旧v25不能当本轮交付**，持续施工授权不需要再问，不启代理、不触碰用户正在使用根。

**2026-10-17 09:31 第二阶段**：411e8c2已提交P0串内消息/真实交接并请求审阅方只读定点核查，81项阶段组合通过。当前第二组主池多@自然AUTO与显式高级研讨已接后端/能力预判/草稿/冻结信封，所选A/B的授权scope不含C；9文件137项及双types、新模块lint通过。共享消息与根卡菜单三操作、主池正序与有界阅读锚点hook、孤立ThreadPage记录串默认发送已改，**原生UI仍未验收**。接下去完成真实模型下拉/一次添加AI配置/默认协调者等P1及逐页简单化，然后同新BUILD空白首用DOCX/PDF两模型真实路线。仍0真实模型调用，不重复旧包宣称交付。详见设计记录追加段。

**2026-10-17 09:25 阶段进度（优先于下方早期记录）**：7d01c04后普通thread_reply_requests正式生产者/消费者接通，原task owner/route/旧信封不改；记录串显式新AI请求可启动首task，不自动发送原private record。真正消息交接新增054 coordination_messages，handoffs原成员→同伴→其他获准成员→回原来源，正式worker A→B→C→B→A夹具通过；给协调者回复进入唯一最终integration。运行真实身份/上游文本与版本/预算/只读角色/停止配置守卫保留。无效结果不误报completed、UNKNOWN blocked不重发；成员移除和会话在途停止均0新增startTurn。主/界面types过，4组78用例及新增3停止边界通过；阶段组合复测及提交接下去执行。具体见r87-dialogue-execution-design。**真实模型仍0，P1、主池多@默认自然AUTO及高级明确研讨、最终新包/空白首用DOCX或PDF两模型路线均未完成，继续推进，不交付旧包冒充。** 当前可用空间32.5GiB，未清理用户文件。增量lint显示既有commands/Room等23项，未宣称全过。

### 历史：01:07早期施工快照

**01:07阶段进度**：standing运输阶段提交4e9f6e6、独立精确快照8格复证pass（0模型）。本串正式thread.members.change已接入已有followers表，读thread.get返回统一members/version/eligible集合，原执行者自动在串，实际coordination_steps子成员由权威绑定恢复（不取整房间候选），显式removed覆盖旧证据；CAS支持ABA、同号重放、归档/跨项目拒绝。ThreadMembers真实添加/移出、Composer线程候选仅取本串eligible接线完成。4个正式名单用例过，尚未真实窗口/派发链验收；旧默认续问限制仍待下一步成组更换，不能宣称@发送已修完。

追加迁移053为新消息级路由请求与可见运行进度提供新语义版本门，001–052未改，不升级用户原根。Claude完整自然assistant块转message.progress，控制对象/残缺JSON不进公开进度；worker只接受当前未停止/未终态turn，按turn保存一个最新有界快照，thread.get把根/真实子turn进展交回复区，终态隐藏，不加假聊天回复/计数。3文件48项（含原CLI运输）通过；首进度fixture漏终态导致测试超时已如实纠正，非真实模型故障。当前新thread_reply_requests表尚未用于普通续问；下一步以每条用户消息冻结收件人/本串范围/配置/原交付身份，允许普通串自然进入工作及多成员，原task/消息不改写。之后开放真实结构化handoff消息、角色提示一致性，P1全部范围和最终新手首用同包仍未验收。采用含可发现问题的合成DOCX或PDF作为最终报告材料，不用greeting代替。

基线 clean4f7da14，运行a2bc376/v25-rc11仅作旧基线。R86模型文件/版本及工程事实保留，但用户七项截图和常驻注入反例证明日常体验未达标，不能拿17门继续宣称日常可用。当前先成组P0：Claude native standing注入、本串持久成员与@范围、普通串自然转工作、消息式真实交接与及时可见反馈；再P1配置发现/简单控件/次序/文案及逐页首次/日常/异常/继续使用。最终新同BUILD从空白数据实际UI起完整路线，不预配项目代替首用。

已重跑未修生产Claude adapter+假进程反例：dist/review-r87-source/claude-standing-prompt-transport-counterexample.json，counterexampleConfirmed=true，0真实模型/0原生进程，原独立票未覆盖。CLI本地help确认native append-system-prompt及文件形式支持。首个可review修复：Claude保存developerInstructions，所有权限参数重建后以native --append-system-prompt-file注入，每session独立系统文件，用户文本/图片stdin不混入规则，首次/续接/长指令/权限档都覆盖；确认退出后只清理自己的临时文件。adapter版本升0.4，使身份变化如实可见。Claude12格（readonly/full/project × text/image × first/resume）和会话隔离/覆盖拒绝、Codex真实RPC start/resume系统参数共源；4文件59项及主types/增量lint通过，日志dist/review-r87-source/standing-transport-tests-20261017.log。真实模型0，尚未业务/最终包验收，不新增交付宣称。下一步本串持久成员与消息式唤醒成组实现；Claude中途message.delta未入消息已确认，须分离自然进度/控制JSON后修，不能裸上屏。

持续授权工程合成真实调用优先Claude/deepseek-flash和准确Codex/gpt-6-luna，必要多次；只用自有合成根，绝不发用户文档，不操作正在使用旧包/数据/凭据。默认CLI完整权限继承，分析/评审只读，single_writer、停止、原号同参UNKNOWN人工处理及精确验收不绕过。001–052冻结，必要追加迁移。

## 历史：R86 桌面多 AI 协作（工程总门通过，用户验收待定）

**持续用户偏好**：后续 Codex 工程真实测试优先使用本机清单的准确 ID `gpt-6-luna`；已在途/未知信封不换配置、不自动重发，确有复杂缺陷或能力阻断才按既有授权使用 Sol，不默认批量发昂贵模型。开发会话自身仍遵守用户既定 GPT-6.1 Sol；不擅改用户成员、模型或账号设置。

**2026-10-16 19:32 当前权威快照**：clean运行源码 a2bc37606baa745357b47cf07cb5db012d857e3c，desktop-daily-win-v25-rc11 / BUILD bld_cf50e93cc0db5723，593程序和4guide哈希一致，候选不带数据。全部严格17门通过（代码根final-gates.json）；双模型DS+Luna真实代码v1/v2/精确v2验收、普通同串、文档6次/真实SaveAs、聚焦DELIB14次/第四native证明、两个根正常BAT重开均完成。协作最终重开票 collaboration-reopen-completed-v2.json PASS/32calls不增；原两张false保留。后续原生读研讨和恢复原requirements标签/表格也已看图。全13自有准备根157次=149success/7failed/1interrupted/0inflight；账本与独立相符，不新增调用。首DELIB5min超时保留，新自有项目10min通过；CR有一项未逐条互评但12RATIFY与6发布分类精确一致，不称一致同意。源码163文件1164、双types/增量lint、额外QA20、同BUILD full/upgrade/6组视觉已通过；用户图片手测继承。白名单117文件/6.77MB及交付记录已提交7766e9e，全部归档工作文件与Git blob逐字节hash一致；RELEASE-VALIDATION绑定此记录提交与冻结BUILD，候选外置/版本管理收据相同。最终收据记录55f6746已推送且远端一致、工作区clean；独立17门/117归档核验通过，独立终审 r86-independent-final-signoff-20261016.json PASS，已补清空白候选首用路线，本轮完成交付；后续等待用户自然使用反馈，不继续发工程模型任务，未以工程通过代记用户验收。最终入口与边界以 r86-desktop-collaboration-v25-20261016.md 为准。下方全部为历史，不再重复模型任务。

### 历史施工快照（原件保留）

**2026-10-16 14:55 当前最高优先断点**：运行冻结仍 a2bc376 / rc11 / bld_cf50e93cc0db5723，记录HEAD55d611e。新协作根第一研讨 task_41da... 在SYN硬截止失败：旧派发300000ms，real_calls创建14:37:49，turn.started回执14:40:18，停止退出14:42:49；源码consumeUntilTerminal硬截止从消费事件时起算，与absence有效执行时钟分离，未证明计时bug，不改runtime。stderr unrecognized_model不能据此判模型不存在（此前同模型多次success）；原12次11success/1failed及budget/时间/error保留 `deliberation-original-failure.json` 和原 `delivery-deliberation.json` false，未重放旧run、无UNKNOWN/在途/保护。

沿已有正式project.collab.set、精确自有项目CAS1→2，将**新派发**turn时限设600000ms，14次调用上限及全局默认5min不变；bounded-new-turn-config.json记录0模型调用配置，原生项目菜单→项目设置→协作限制已实际看到10分钟、native-project-deadline-readback.json/png保留。新原生@全体自然两功能问题 **task_984b01f8-dcc9-4d98-b557-f522b3256719**，watch **25880** 写 `delivery-deliberation-completed.json`，目前IND/CR在途。新正式deliberation-proof/native-proof-deliberation只在此新task真正发布后取票，未写默认proof，不能把旧false改绿。

QA watcher新增最新正式run FAILED/INTERRUPTED/CANCELLED无交付就立即失败，不再纯等45分钟；ledger必保本次SYN两份false。最终archive已改纳入新completed观察、旧失败、10min配置、原生回读、独立文档小票。最终门新增候选4份外置guide的BUILD+hash严格核验；候选与两个own副本已同步说明（各own/guides-before-deadline-note保留旧说明），593程序/BUILD不动。`.gitattributes`新增R86白名单证据 -text，防Git换行破坏hash。改动尚待阶段提交。还需新研讨完成、精确四证明/自然报告、原生关闭+新协作根reopen、全ledger/final门、白名单archive与final文档/RELEASE-VALIDATION/提交推送/独立最终核查。代码根life/nav全pass且21calls保持；文档6call/真实预览SaveAs及独立pass，不再重跑。

**2026-10-16 14:41 最新**：运行BUILD仍不变，记录HEAD b6cf345（另有QA/docs待提交）。新协作根文档已6真实success自然交付，task_5948... / native-proof-document-v1 六精确sessions pass；真实撰写→Luna评审→DS修订→Luna再读→整合。最终requirements.md 5586B / SHA913f7488...，原生文件树/Markdown标题及功能表实际检查，原生系统SaveAs到本own根/native-saved-original.md，document-preview.json pass/hash相同；终版两处整合补文未再第三方评审，reviewCoversCurrentBytes=false如实。独立 rc11-luna-document-original-independent-audit.json pass。DELIB目前12call（11success/DS synthesis在途），watch72134仍等自然结果，不重发。

额外新增QA协作根原生正常AltF4后同BAT重开校验脚本 verify-r86-collaboration-reopen.cjs，待DELIB完成/四证明全收后再关闭；检查正式daemon closed、同根、原doc+DELIB交付、文件hash、零新增call。最终门新增此必要票，20QA正负+eslint过。archive-r86-release.cjs白名单归档脚本需最终门pass才执行，包含既有源/四native证明/六对图/原失败/有限独立票和合成输出；不遍历DB/profile/转录/用户目录，有文件/总体容量及疑似密钥拒绝。当前尚未执行归档/放行。

**2026-10-16 14:25 当前优先断点**：同 a2bc376 / rc11 / bld_cf50e93cc0db5723。上午 Luna 根代码 v1/v2 十次成功、普通两次成功及原生 v2 accepted 均保持；文档 review 和 DELIB 后续各出现一条 Codex quota FAILED。`quota-original-failures.json`、两份 delivery false 原件保留，该根共21实际call（19success/2failed），没有自动重试。用户返回后窗口均无，正常BAT起原根触发恢复保护，旧研讨 RUNNING→INTERRUPTED，未解除。随后原生 AltF4 正常关闭、`reopen-r86-own.cjs` 同BAT重开 PASS，代码v2身份/文件hash保持、21call相同；原生子任务/精确子交付/返回/CtrlR/未发草稿＋分列Chromiumhistory的 `native-navigation.json` PASS。保护保留不影响只读历史，不冒充旧研讨成功。

当时额度API primary已用3%（余97%），ordinaryUsageAllowed=true；仅代表app账户，不冒充custom上游，按用户继续以新明确意图准备 **同BUILD新根 `review-r86-final-rc11-collaboration-20261016` /52864**（不是旧任务重放）。原生新文档 task_5948b2ac-47ee-482c-a584-51e23f578262，watch90934；原生@全体两席DELIB task_41da4d33-ea0e-4fbd-8533-4d99dd773366，watch72134。DS+Luna medium，当前都真实运行。最终门新增显式owned `--collaboration-evidence=<新根>`，只在同BUILD分场景取文档/研讨票，代码根票不变；额外强制所有原生proof及研讨的expectedModels准确匹配，不可换模型拼票。独立发现旧门漏绑DELIB原生proof，原反例保留；现只读投影真实publish delivery/run/manifest，第四native proof严格绑定task+run+delivery+revision+manifest，缺票/错身份负例过，QA19例/lint及双types通过，runtime无改，不再构建。

视觉首次因原型不含root导致等待false；第二目录v2脚本被工程中止，留目录不称有完整票；第三欢迎恢复modal false；v4六对capture成功但滚动不一致，v5已统一thread顶部。**`review-r86-final-rc11-visual-v5-20261016/visual-pairs.json` PASS，12张实际逐张查看**，wide/narrow/1.5DPR模拟，原型缺用户根/真实runtime/交付状态等差异如实记录，DPR1.5原型列宽较窄/横滚不冒充产品像素一致。新总门 `--visual-evidence=<v5根>`，原false保留。

Native新插件版本26.1013.31256已重读skill/guidance/confirmations；globalThis.sky，r86Window=新协作根265514，r86CodeWindow=代码根264714。仅自身这两窗口操作，用户v23不碰。新模型调用自然结束前可继续docs/QA；还需新根文档原生proof/共享预览/原生SaveAs own/native-saved-original.md、DELIB双方阶段/nativeproof和自然报告；新根必要重开可单独记录，不改代码life既有pass。全ownedledger原失败含本轮quota/视觉、严格总门、最终说明/索引/候选RELEASE-VALIDATION、commitpush独立审阅后方可交付。

**2026-10-16 09:22 最新断点，优先于下方历史**：Git b7ba0ef clean，运行源码仍 a2bc376 / v25-rc11 / bld_cf50e93cc0db5723，不为 QA 换 BUILD。当前最终自有根 `dist/desktop/review-r86-final-rc11-luna-20261016`（52854）已完成代码 v1 五次成功、v2 五次成功、普通问候及同串续问两次成功。v1/v2 各五个真实原生会话 proof pass，Luna 独立读文件并运行 Node 测试，v2 六项通过；原生两步验收后原 task_e46a8ea9-c6af-42c7-a8ae-90639b704110 DONE、v2 accepted、v1 changes_requested，`code-lifecycle.json`已记录 accepted，尚未正常关闭重开。关键 `rework-running-window.json/png` pass，独立同步采样、v2原件与测试也通过，不依赖旧根迟到观察。

已通过原生输入另发自然文档协作 `task_e5dca083-a8dd-4b9a-a8d3-e8f9ae3e0080`（requirements.md，不动 greeting），只读 delivery watcher session4547；原生 @全体明确两席、只读DELIB `task_70e1f0c0-d385-45f4-944d-12f6b09d0a3a`，watcher3539。二者正在真实运行，不自动重放。视觉脚本19588，输出 `review-r86-final-rc11-visual-20261015`，需实际看六组成对图才可填inspected/pass。Vite23607/53985。当前 native globalThis.sky/r86Window/r86State，句柄331002，须用 globalThis 维持跨调用；UIA tree有滞后，按新截图输入并再次观察，不能据旧索引重试。

配置 v2-delivered 仍同 env926993...与冻结用户配置hash；正式预热新增工程trust元数据的历史说明保持。旧 rc11-real v2配置guard阻断原false及六次成功不改、不重试。还需当前文档真实字节/native proof/共享预览/系统SaveAs hash，DELIB阶段和原生proof；全部真实调用终态后原生AltF4→同BAT正常重开/no-autocall；原生子任务/精确子成果/草稿/CtrlR历史；实际视觉检查、所有阶段真实调用账本/严格总门、当前矩阵/交付说明/RELEASE-VALIDATION、提交推送及独立最终复核。full/upgrade/源码已过同BUILD，勿重做昂贵无关测试。

**2026-10-16 09:05 最新断点，优先于下方历史**：runtime 仍 a2bc37606baa745357b47cf07cb5db012d857e3c / desktop-daily-win-v25-rc11 / bld_cf50e93cc0db5723，593clean。源163文件1164、双types/quality59files无新增33既有、同BUILD full/upgrade零推理全部已过；不为QA换BUILD。当前QA HEAD56cdf3a，另有待提交QA变动。

旧 rc11-real 根 v1 已4真实成功，native4session及独立原件2/2测试通过；real-code-v1-completed.json pass，原real-code-v1.json 因编号比较QA false保留（无JSON泄漏，raw42ab...相同）。第二只读观察复用了PNG名，原JSONview/hash保持但不冒充原截图，planning-observation-provenance.json如实注明，今后label输出独立PNG。新最终门支持显式 --code-evidence，不能覆写原false。

16日重开时原窗口/进程均无、独立根旧daemon.pid仍在；所有模型calls已成功。正常BAT重开同根，未手删PID/改DB；v1原件、名册2人、hash保持，没自动派发。初次短Node退出太快未起进程、一次PowerShell环境清理命令被工具policy拒绝，未执行；用既有Node launch+等待CDP正式BAT成功（continue-launcher-3.log）。这次不是v2正常close认证。

随后原生返工意见6.5s零新增调用、明确execute同task。**rework-running-window.json/png pass**：原intent done、父WAITING/真子步未完、正式task.get queuedtrue、实际“返工执行中”且无重复按钮；已实际查看画面。独立实时采样来晚时任务后续blocked，其独立false已澄清，仅图片确认有效。v2计划与实施两次真成功后，Codex review启动前被旧配置身份guard拒：task.contextAssemblyFailed write-authorization-changed “有效执行配置已变化；未沿用旧会话”，无review run/turn/第7次call。**delivery-code-v2.json false / configuration-boundary-blocked.json false**永久保留；该旧根总6call均success，父blocked，不自动重试/不改旧scope/不手动恢复凭据。source task_693f... 原配置仍gpt6.1sol。

实际global config.toml mtime 16日00:39:58晚于旧scope冻结15日23:18，旧scope只有opaque key；宿主CODEX_SESSION_ID/THREAD_ID/APP_TOOLS_PIPE_PATH/TASK_WORKSPACE_VERIFYING_IDENTITY也有进程噪声敏感性（独立0call夹具证明）。**无法唯一还原旧阻断是有效配置、元数据或两者变化；不据此改runtimeguard/兼容旧授权**。采用QA-only：独立新意图启动/重开统一engineeringLaunchEnvironment，仅去4宿主会话标识、清ZS覆写/ELECTRON_RUN_AS_NODE；CODEX_HOME、OPENAI_*、代理、其他CODEX变量全部保留。程序/用户原根/凭据不动。OpenAI Docs已读官方config basics/reference，配置优先级来源记录，不把官方页当本次唯一原因证据。

人类在独立评审chat最新直接说后续测试尽可能用便宜GPT-6 Luna，已通过read_thread核原人话；本机正式model/list零调用列出准确 gpt-6-luna 和medium。新独立根 **dist/desktop/review-r86-final-rc11-luna-20261016** / **port52854** / 同rc11真实BAT，0call prepare后，已原生新意图send DS+gpt-6-luna，非旧信封重放。**task_e46a8ea9-c6af-42c7-a8ae-90639b704110 / thread_a9540bba-0f59-4e17-9f76-597e219759f5**，observer **66736**，写real-code-v1.json；当前仅DS planner在途。**保持原生UI replies打开，先取子步未完规划窗口再导航**。

新root progress记录launchEnvironmentRecipe名字/移除变量名，无密钥；configuration-prepared/sent/intent-frozen记录配置文件/环境hash。官方预热为新项目添加trust metadata（user config 7690→7813，sent+frozen sha befab347...一致，env hash926993...始终一致），发生正式发送冻结前，不冒充用户配置byte未变。后续每长阶段与重开用 observe-r86-configuration.cjs own unique-label 只读追加hash，不输出明文/不改配置。17项QA门与原生解析/新intent model override/env recipe测试过、lint过。

Native SKY当前会话 global sky 已初始化；**r86Window handle331002**，app完整路径含review-r86-final-rc11-luna.../copy/ZhongshuoDual/electron.exe，title R86 合成协作验收52854，r86State最新root消息+replies。只用SKY做Windows鼠标/键盘，view_image看落盘图。重启后全局var需用var声明；如失效重新list/get唯一窗口。旧rc11-real handle330288保留blocked，不再操作或重试。用户在用v23根始终不碰，旧rc9用户选中文本的窗口之前保留，不主动关闭。

剩余完成：新Luna root同BUILD v1原生proof→原生意见/0call→explicit v2＋rework-window→真版本交付/proof/两步accept；普通无@你好/同串“我刚才说了什么？”0child/0delivery；新真实文档协作/原生Markdown预览/系统SaveAs own/native-saved-original.md hash；原生@全体两席只读DELIB/双方IND+CR+自然report；全部terminal后正常AltF4/BAT重开hash/0新调用；子任务/精确子成果/返回/未发送草稿/CtrlR/实际历史；6组prototype配对wide/narrow/DPR emulated并实际看图；全owned根ledger（含原旧rc11 v2precall false）、总门、RELEASE-VALIDATION、current matrix/continuation更新、白名单证据、commit/push、独立审核。**不要再停在阶段；不要把rc10/旧rc11拼为新根总pass**。新root默认proof读取progress.expectedModels已是Luna；--codex-model可供独立新intent显式模型，旧p.expectedModels不变；final --code-evidence只在该新root自己QA需要时用。full/upgrade默认rc11固定根可直接复用同BUILD已pass；无需新包/无需再发昂贵Sol。

**最高优先新阻断（23:02，需新冻结，不放行 rc10）**：restored 实际v2运行时，AUTO父规划已消费redispatch outbox，父run WAITING、子任务执行，但成果详情回退“返工意见已记录、尚未执行”并重复显示执行按钮。原生 `native-rework-running-mislabel.json/png` 和独立 `rc10-rework-running-original-failure.json` 保留；正式命令仍安全拒绝重复，无自动重发。根因 reworkPendingOf 仅数未done outbox。最小修复只读派生 queued=pendingIntent OR 同task非source真实活跃run，排除历史/别任务；不动执行、幂等、权限、预算、保护。正式worker永久反例 before确实queued false失败，修后33项（coordinationR86＋reworkExecutionContract）过，含只记录false、outboxdone但父WAITING true、真子任务后true、重复执行拒、自然v2后null、再次记录且别任务活跃仍false。双types在跑。

**最新冻结 a2bc37606baa745357b47cf07cb5db012d857e3c / rc11 / bld_cf50e93cc0db5723（23:09）**：593 clean一致；正式33项和双types已过，source-quality-a2bc376.json PASS（59文件/33既有无新增）。全套full-a2bc376.log已163文件/1164项全过（包含额外QA gate断言；full-a2bc376-context.json记录应用src无变化与QA文件hash），生成Word目录已正确完整复制到ignored证据再restore。新rc11根 review-r86-final-rc11-real-20261015 / port52844 已prepare 0calls，尚未真实send；真实模型等待rc10阶段三链全部自然结束后再发，不抢资源。rc11-upgrade和rc11-full（52845）均完整pass/0真实调用，full保持单独前台未再出现隐藏截图。

独立旧投影16case before有四个新run活跃状态错false、修后16/16过（rework-a2bc376），前一次late动态观察 bugReproduced:false不能当独立复现。新增QA verify-r86-rework-window.cjs 只读等待父WAITING、原intent done、子步未完、正式task.get queued=true＋实际交付面板“返工执行中”/无重复按钮；6项总门正负例过，脚本与总门改动还未commit，属于QA-only不换BUILD。新最终门必须这张窗口票。

rc10 restored代码v2已8familycalls自然完成，native-proof-code-v2.json4sessions过，尚未人工accepted，因rc10不是最终不冒充验收完成；doc5calls已自然交付并watch pass，DELIB约12calls进入末尾。所有旧原件保留。Vite53985 session57883存活。最终仍需rc11同BUILD真实代码v1/返工v2/验收/重开、文档原生预览+SaveAs、DELIB、普通问答、原生导航和6组视觉、ledger/总门/记录提交推送。不要停在此阶段。

当前rc10三条真实链继续自然完成作为阶段证据，不中断、不自动重试。code v2 observer37109、DELIB29962、doc14199，均写restored根。full-v3已全部pass/0调用/同rc10 BUILD（含R79三周期、真实BAT重开、R85 daily），旧两false留存。新runtime冻结后需要最终包复证，不将rc10阶段计作新BUILD成功。Vite参照已重新启动53985（session57883），可用时再做六组视觉。后续源改动仅dm.ts及永久回归，其余QA/记录提交分列。

**2026-10-15 额度恢复后的当前断点（覆盖下方旧施工快照）**：源码已冻结并推送 `ad513c2b858f7dac81e7e1f0d02f9d11b0ad3916`，rc10 BUILD `bld_07ef3cd9b4b08add`，593 文件清单独立核验通过。全套 163 文件 / 1161 测试全过；双 types、57 文件增量 lint 过（33 条已匹配既有问题）。首次 rc10 独立根 `review-r86-final-rc10-real-20261015` 的规划可读窗口真实 pass，但 Codex 评审明确报额度耗尽，整条原 false 保留；不自动重放。用户已说额度恢复，现新建 `review-r86-final-rc10-restored-20261015`，端口 52834，原生 UI 发出同一自然合成任务；任务 `task_f9464a6c-4f3a-4b4e-b617-6549ceb67dbe`，线程 `thread_e48f08d0-e7ea-4348-83f2-afee7e6e9a28`，observer 等待中。当前窗口保持 replies，须先记录子任务尚未完成时的自然规划窗口，再继续代码 v2、文档、DELIB、普通问答、关闭重开、导航与视觉。所有最终门仍待收齐，不能用 rc9 阶段成功替代。

rc10 `review-r86-final-rc10-upgrade-20261015/upgrade.json` 已 pass，用户原数据根从未访问。首次 rc10 full 工程夹具前述房间/DM/历史等业务步骤成功，但 archive 截图窗口 hidden 导致总 false，保留 `review-r86-final-rc10-full-20261015/result.json`。QA 将为已附着的唯一工程窗口补最小化恢复且继续强制 visible+paint；另用新根复证，不覆写首次失败。源码无运行行为更改。全套测试产生的八个已跟踪 Word 样件已恢复仓库基线（尝试保存生成副本因 Git 引号路径失败，不能宣称生成副本已保全；原完整测试日志已保全）。

**进一步进展（22:52）**：restored 根 v1 已 PASS，4 次真实 turn，全子步 DONE，双实际模型、真实原生读取/测试证明 `native-proof-code-v1.json` 4 sessions 过。普通问候+续问两成功，原串根正文/上下文/原成员正确，0子任务0交付；`ordinary-chat-completed.json` 通过。原 `ordinary-chat.json` 因 QA 错把“同串续问”要求成“同 CLI session”而 false 保留；房间原合同每 turn 独立会话、第一轮规划只读→后续配置权限，实际 threadDigest 精确重放，自然答对你好，不改产品或跨权限强续接。

v1返工意见原生保存后6.5秒0新增调用，明确点击执行返工已绑定原v1/manifest/note，`code-lifecycle.json` 已记录；v2 observer 只读等待。另已原生 @全体明确选中两席研讨 task_fce21525-8a3d-49f6-80ab-12d257a35076（只读，14次预算）与默认AUTO文档 task_f2d78498-540f-4b7c-b6cb-23de9da9cf72 自然请求；两个只读watch分别写delivery-deliberation/document-v1。均未最终收口。

full-v2 的 Browser.getWindowForTarget 在该 Electron CDP 不支持，原false保留，已完全撤销此 QA 尝试；待实际 UI 验收后以单一前台工程宿主复证，不再并行争抢画面。最终门增加普通问答保全必需票及显式 owned full 证据参数，5项门测试通过；QA-only 不换ad513c2运行BUILD。

**最新必要修复待冻结（2026-10-15 21:55，优先）**：rc9最终路线实际29turn全成功：DELIB14、代码v1五/返工v2五、文档五。代码v2已原生两步确认accepted/DONE、独立Node7/7；Markdown实际共享预览、系统另存为原件hash一致（document-preview.json），Codex评审旧稿后整合改变字节，reviewCoversCurrentBytes=false照实。已收齐未见其他预览阻断。但原生v2规划窗口暴露TaskComplete JSON，原封存raw-rework-plan-observation及planning-chat-original-failure.json为false；旧chatAnswer独立字段白名单不含新增coordinationPlan，连null普通问答也漏识别，rc9绝不能最终放行。

新源码仅把TaskComplete版本/schema/output工厂抽成browser-safe contracts/taskComplete.ts（纯zod/coordination），prompts保留原API import/re-export，chatAnswer同源safeParse，agent限定/answer优先/legacy回退、human原文、额外/错字段原文保持；不改历史DB原件。单位before2失败保留，修后46定向＋12证据门/原生解析正负过、双types/hifi构建过；独立unfrozen比较8schema指纹完全同旧05b。正式Fake补规划已发表且子任务未执行的自然正文/原协议/主池线程身份，以及普通AUTO coordinationPlan:null无子任务无交付；新总门必须readablePlanningWindow。即将commit/push/构建rc10，先正式实际挂载，然后native发送代码任务并立即点开回复串，在planner已发表而子步未完窗口取主池/线程可读票，不能最终回复盖住后补拍（观察器自动读DOM/screenshot，不自动导航到replies，需原生打开）。随后v2验收、文档预览/save、手选DELIB与2个极简ordinary真实turn（文件任务后默认无@你好→原串“我刚才说了什么？”；核无子分工/工作交付/验收且原成员回答），最终正常关闭/BAT重开、导航/视觉/总账/总门。QA-only整理随后commit不换BUILD。

用户正在选读rc9自有文档窗口，SKY normalClose被user-input保护拒绝一次，已重读看到选中文字，明确保留不再关闭或操作它；没有实际关掉，不能声称rc9关闭/重开过。此不阻塞新独立rc10根。该窗口r86Window=13767508 / own final-rc9-real端口52814；后续Native需重新从list_windows唯一选择新副本，别误关用户在用v23或正在读的rc9。rc9 allcalls终态29，watchers30659/25452/83857均完成，无UNKNOWN。lifecycle-read-before-confirm为QA过早读的原false，后真实确认；现code-lifecycle保留observationFailures引用原件，未reopened。Vite66576/53985仍供视觉。磁盘最后约43GB空余，用户文件/旧包不清理。新stage脚本/leaf/test dirty以git实读。

**当前运行冻结 / 最新断点（优先于下方历史段）**：05b1331d892e8afad0bde9dc47d53d6d018161a2，候选desktop-daily-win-v25-rc9，BUILD bld_19cfe41229996380，独立593 clean/pristine核验过。首个新根`dist/desktop/review-r86-final-rc9-real-20261015`真实BAT端口52814，先原生手选Codex＋DeepSeek发只读DELIB，task_fdbb8db3-808b-475d-a091-0fadacf44a5d / run_aee3b839-2592-4ab0-aaa0-5d8aa1f66091。双方IND、CR、三轮ISS、CHK/SYN/RAT全部完成，14真实turn全succeeded，正式与14个原生session proof均pass，独立audit-v2也pass；主持是本次首选的Codex，房间AUTO协调者仍DeepSeek。只读watcher58531已完成并写delivery-deliberation.json；无自动重放。原生报告已检查、保存native-deliberation-report截图；两处模型正文完整成员UUID经独立判断为非阻断可读性边界，保留原文，不新改runtime。当前已原生发AUTO code task_942e5568-bbf2-41ae-89eb-005beaece98c，watcher30659观察real-code-v1.json，实施和Codex真实评审成功，修正step在途，完成后继续v2/文档/重开等。DELIB已跑过`verify-r86-deliberation-proof.cjs <root> <task>`及`verify-r86-native-proof.cjs <root> --label=deliberation --task=... --deliberation`（显式task允许早于code观察），再同BUILD AUTO code v1→记录意见6.5秒零调用→显式v2→精确accept→文档协作+实际Markdown预览→全部真实调用终态后原生AltF4、BAT重开→原生子任务/成果/返回/CtrlR/草稿与单独Chromium历史→6组原型配对实际看图→总账/严格总门→外置记录提交推送独立复核。不在阶段结果停工。

源码05b首次full163文件1157项全部通过（dist/review-r86-source/full-05b1331.log），双types＋相对R85的51改动文件增量lint无新增，33既有逐rule/message匹配（source-quality-05b1331.json）。Word生成件已复制generated-word-05b1331并仅恢复已跟踪工程样本。最终同BUILD `review-r86-final-rc9-full-20261015/result.json`完整正式Fake/重开pass/0真实调用，`review-r86-final-rc9-upgrade-20261015/upgrade.json`完整根/原UNKNOWN/草稿原件/旧程序拒52/匹配回退pass，独立包清单pass。Vite session66576端口53985已启动供原型配对；未关闭用户任何应用。新增QA-only source/ledger/final汇总脚本未提交；guide generator已补真实UI“项目设置→任务交付→任务交付后需要我确认”，发送前开启，仅新任务冻结，旧auto-deliver不伪称可补验收。已重新生成rc9根外置guides及hash，不改593程序或BUILD；最终own实测副本需同步这几份外置guide，记录后续QA/说明HEAD不冒充runtimeCommit。

**最新断点（2026-10-15 20:26）**：rc8 clean1cca516 / bld_a9b6180a48c8053a，owned final-real端口52804。真实AUTO v1六调用、原生意见零调用→显式v2再六调用均自然交付，native-proof-code-v1-discovery及code-v2-completed精确session过。原v2仍REVIEW，未accept，不冒充闭环。手选DELIB真实Codex IND被invalid_json_schema明确拒绝（nested claims uncertainty未required），已原生精确停止该task CANCELLED，原failed/interrupted保留，不能算双模型成功；全部calls终态，无UNKNOWN重放。新产品最小修复在deliberationRunner：生成transport schema递归required全部properties（optional无值用空串/空数组，不加null，不改历史domain可选字段），六stage正例同时过原Zod/Ajv、错版本拒、8种schema含AUTO递归strict检查，before原失败保留；34定向+双types/lint过。即将冻结新rc9，先正式实际DELIB全阶段成功，再同最终BUILD code v1→意见→执行v2→验收→文档预览→全部调用终态关闭/BAT重开→原生导航→视觉配对→最终总门。QA observe已按准确首AUTO选择，不误选先行DELIB；native proof支持显式DELIB task早于code observation。不要因QA-only另换包。

rc8同BUILD完整Fake final-full-v3 pass/0calls、升级final-upgrade pass、独立593清单pass。源码full首次1153/1154，唯一TLS原false保留；同GitHub随后5/5。此前两次1500ms双RAF screenshot失败保留，5000ms且visible后第三新根完整过。最新QA8原生正负＋完整54定向过。当前dirty含新strict修复/tests与QA脚本，Git实读；准备保存审计后commit/push/build，源码不能冒充仍rc8。最终文档/AUTO/DELIB/视觉/导航总门尚未完成，不交半成品。reviewer01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79只读已获授权；最后建议先DELIB避免尾部才发现同类schema缺陷，已采纳。用户deepseek-flash无需再次确认；必要真实合成调用已充分授权。

当前阶段：运行冻结0f3452b870b3a2b1f99433357a1ee496058956dd / desktop-daily-win-v25-rc7 / bld_9fa40125a99e71b6，593程序文件。用户已指定deepseek-flash替代耗尽的GLM；rc7真实同任务DeepSeek+Codex开发v1→意见仅记录零调用→显式v2→验收v2→原生关闭/BAT重开已通过，8次成功；文档协作另5次成功，旧版评审后整合修改，不能称评审覆盖终版。原生子任务/精确子成果/返回/CtrlR/草稿保持已证，Chromium历史另列，AltLeft不声称支持。源码全套163文件1151通过。现已独立复现并修正project.open每次复活默认房间已移出成员，须冻结rc8最终同BUILD复证；原false与rc7阶段证据均保留。最新HEAD用git实读，后续QA/记录提交不冒充运行源码。分支codex/full-implementation，独立审阅会话01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79只读复核；无其他产品写入者。

立即续工：冻结房间初始化修复（仅首次建房填名册，显式member.create自动加入活动房间合同不变）及永久正负例，rc8 prepare新owned根DeepSeek/Codex medium；最终实际开发v1/v2验收重开、文档及实际预览、显式选两成员DELIBERATE、原生导航、原型成对宽窄/DPR1.5截图实际检查、同BUILD完整源码/Fake/升级回退及593清单、真实调用总账/最终严格总门、提交推送独立复核。rc7 own根review-r86-real-rc7-deepseek-20261015端口52794，文档task_230a20c5-dc9c-4282-ac50-6bd7f8940e7b已REVIEW；不要重放旧任务。native-proof-document-v1原false由编号Get-Content输出解析导致，numbered新票核不可变上游snapshot后pass，QA-only更正不新调用。未完成最终总门，不交半成品。

用户要求一次房间发送→协调成员自主分工→异构成员交接→整合→人工验收，并支持显式选成员研讨。同任务两个不同实际模型必须通过；不限定两个CLI。必要合成真实调用已授权。GLM/glm-5.3-flash当前429周/月额度耗尽，提示2026-10-16 19:42:30重置；保留失败，不拿成功别的渠道冒充GLM。本机正式model/list已零推理确认gpt-6.1-sol与gpt-6-sol，沿现有Codex配置在独立成员/根使用这组，不改用户渠道/模型/凭据。真实调用账目以各owned根SQLite real_calls实读，不再写“0调用”。

实测反例已修：CLI不接受Zod默认draft2020，所有正式输出schema改draft7并有Ajv正负对照；AUTO漏接R84零推理配置准备，首次full thread/start写本工程trust元数据后旧身份被正确拒绝。rc6发送前按同源房间候选完成准备后才freeze，await后核原目标/权限/名单/运行配置，旧快照与guard保持。不得把后者称未证明的外部配置变更。CLI初始化会写选定工程trust，不能宣称全局config完全不变。

rc6真实现场：`dist/desktop/review-r86-real-rc6-two-sol-20261015`，端口52790，原生鼠标键盘自然发送；真实规划已成功，实施第二调用已启动（原断点已越过），后续评审/整合/v2/验收/重开待完成。observer进程session37313只读不自动重放。源脚本preserve原false，不覆盖旧票。

同BUILD隔离回归 `review-r86-rc6-full-20261015/result.json` 已pass：房间DIRECT和DM完整返工v2验收、停止、普通开关/跨项目、持续17.5秒三周期、历史分页/选择/重开、Git/归档/看板/活动全范围，真实调用0。rc5升级`review-r86-v25-upgrade-v2-20261015/upgrade.json`已pass，含完整旧根复制升级52、原UNKNOWN/草稿/字节、匹配旧程序回退和旧daemon拒52；仍须最终rc6同BUILD复证。全套e155074正在session25666，日志dist/review-r86-source/full-e155074.log；不要在完成前恢复其生成Word样本。先前两次全套false保留，不代记首次成功。

待做：最终同BUILD真实异构自然开发v1→返工意见→显式执行v2→精确验收→关闭/BAT重开；第二类型文档协作与预览；显式多选真实独立研讨；原生子task/精确delivery点击与返回/后退/刷新/草稿身份；新UI宽窄与仿真HiDPI成对图并实际看图；最终完整源码、双types/lint、升级复证、原生会话工具/版本/TAP或spec证据、全总门逐项变异、所有调用/原失败清单、提交推送及独立复核。QA-only解析更正不追加已成功模型调用。当前总门必为false，不交半成品。

用户在用v23-rc6/server-data禁止读/复制/迁移/操作/关闭；仅owned review-r86目录工程。001–051冻结，仅追加052；不自动重放、对账、释放保护；默认CLI完整权限、显式只读、原件/草稿/UNKNOWN/图片既有合同保持。共享工程single_writer，研讨/评审/规划实际只读。不做旧价值评分、Android、安装器签名或其他无关延期。最终仅一条约5分钟增量确认路线。

<details><summary>R86早期阶段记录（历史，非当前状态）</summary>

## 当前施工：R86 首个桌面多 AI 协作长批次（尚未交付）

用户明确选择“一次发送→协调成员自主分工→汇总→人工验收”，支持手动选择；必要验收至少 Claude/glm-5.3-flash 与 Codex/gpt-6.1-sol 两种真实模型共同完成同一任务。必要真实调用已授权，旧零调用/两次额度限制不适用；工程仅独立合成根，禁止触碰用户使用中的 v23-rc6/server-data。R86 重新开放 AUTO/必要协作，旧业务价值评分未做仍如实记录，不作为停工理由。

先读 [R86审计与阶段记录](r86-collaboration-audit-20261015.md)。基线60f36eb；阶段提交732b1d6计划合同、0d625a4持久父子调度、7b4f3d7四反例修复、7046054拓扑修复。当前源码以git实读，存在研讨worker/runner未提交施工，勿覆盖。新增052尚未作为候选发布，001–051冻结。独立审阅会话01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79负责复核，已获用户跨会话消息授权；无额外产品写入会话/子代理。

已具备工程阶段 AUTO 计划白名单/DAG、真实子task/依赖、只读规划/评审、沿原权限实施、单写串行交接、父停止/配置/未知守卫、聚合预算与整合attempt绑定、冻结版本覆盖链/present与absent校验、有界公平pump、任务详情初步协作面板。当前协作集成15项通过；原四项独立反例在7b4f3d7通过，前向依赖反例在7046054待独立复跑。真实模型调用本批迄今0，不能称成品或真实异构协作已过。

后续阶段abecc10已实现研讨正式输入/schema/图片/配置/自然报告和v2、界面与父子成果读取，已推送；全量160文件1128通过。v25-rc1工程候选 BUILD bld_6c42cfa0f484ba20 clean abecc10/593清单一致，pristine未启动，非最终交付。独立发现peer openSession跨UNKNOWN误启动、第二研讨run停止读旧run两反例，已修并加正式测试，待最新冻结复核。当前协作集成23项，真实调用仍0。QA准备脚本 scripts/verify-r86-real-launcher.cjs 仅操作owned review-r86根，prepare零推理，observe不自动重试。

继续：新冻结独立复核/全量；独立启动器真实异构开发闭环与第二类型任务，实际文件/测试/返工/验收/重开；再冻结最终clean BUILD候选、清单与独立复核，推送完整交付。不得在审计或单补丁后停止。后续新增变更与记录以git实读为准。


</details>

## 上次交付：R85 / v24-rc2 已完成并独立复核（历史交付记录）

先读 [R85交付记录](r85-desktop-closeout-v24-20261015.md)、[当前矩阵](r85-current-capabilities-20261015.md)、[最终总门](evidence-r85-v24-20261015/release-gates.json)。运行冻结 clean 383f2ee5df3260eb424a2c85f6c68c7f31d71b19 / BUILD bld_5711009e30c663e7，唯一候选 desktop-daily-win-v24-rc2，593程序文件；独立审查记录HEAD c4b9fb9a453ecd9fe4b726d9e5c7953d2d612026已与远端实核一致；随后仅追加外置审查记录，最终HEAD以git实读，不冒充新的运行源码。本次完整156文件1088 + 另14总门正负例、双types、增量lint通过。完整正式Fake闭环/持续历史/daily scope=complete、增强整根v23升级回退、六组原型配对与原生菜单/关闭均通过。真实GLM共4次succeeded，rc1两次保留、最终rc2两次自然文件/Node/返工v2验收与BAT重开，不再追加调用。源/证据真实数据见交付记录，不拿阶段false/旧prototype遮挡票转绿。

用户正在使用的v23-rc6目录及server-data禁止作为工程输入、运行、复制、迁移、清理或关闭对象。升级仅由用户按[指南](r85-v23-to-v24-guide-20261015.md)选择，工程验证用自有完整根。旧包、失败根、草稿/UNKNOWN和迁移001–051保持；不自动派发/重发/继续/对账/解除保护，原权限/图片/同串/返工合同不退回旧设计。R85新建工程窗口与Vite服务均按自有身份关闭，旧R84/用户窗口不动；如独立审查要求核证，读取现有票，不为纯说明/CSS重复模型。

边界：不称OS睡眠/断电、多日或实体HiDPI通过；归档分页/冲突容量如实标注。主页初聚焦名册未读极短0/空态留后续细化，不将其冒充已完全解决。独立最终复核无新增必要阻断，另9文件56项/双types过，见r85-independent-final-audit-20261015.json；整体用户验收仍pending，仅安排一次约5分钟自然增量路线，不索要竞态/故障/图片历史清单。Android/安装器/签名/更新/并行/自动分工等旧延期不扩。

## R84历史交接（2026-10-15，必要门通过，整体用户验收待定）

当前冻结运行源码 clean `05b549f61169b7293521dd42ec38e1a2fe239de1`；候选 `desktop-daily-win-v23-rc6`，BUILD `bld_fcf357a7e1e4ad52`，593清单一致。当前HEAD用git实读，后续QA/记录提交不冒充构建源码。150文件1058确定性测试、双types/增量lint无新增错误通过；外部GitHub TLS旧边界单列。详见 [R84进度](r84-progress-20261014.md)。

rc6 GLM/glm-5.3-flash/high 与 Codex/gpt-6.1-sol/xhigh已各10次真实全部成功，含三轮普通/图片字节/实际文件命令/项目外合成写入/返工v2验收/显式只读及正常关闭BAT重开。两份原生工作会话各证明实际测试退出0；Codex response_model仍null，不反填渠道底层型号。R84去重81次（37Codex/44GLM）全succeeded，旧副本复制7行不重复算。真实v22 UNKNOWN自有根完整备份+复制升级rc6已证原号原参/@/image/record/草稿保全，无自动派发；只在升级副本人工原号回放无重复，原旧根逐文件未变，原件正式字节/hash/浏览器decode与关闭重开通过。新根副本被旧程序明确拒51，匹配完整旧备份真实BAT开回50/原未知信封保持/0调用。不要触碰R83旧中断未知根。

新增：cached thread跨项目定位循环、线程结构化@丢失、诊断将自动图片误报历史认证均已修。普通同串原成员回答/显式仅记录零调用、工作意见后显式返工保留。追加051、001–050冻结。Codex零推理配置准备与耐久关闭保活已冻结，旧失败原件保持。

最终Fake连续观察北京时间08:31:55.208–10:31:55.212，7200004ms/352采样完成，8路径各44次；原线程/README恢复，消息24/模型调用0，请求+8980，daemon RSS85.79–88.07MiB，恢复计时器保持1。关窗后真实BAT再开，历史run4/历史窗口/展开/草稿和最后确认滚动584.8恢复。早先探针误用分页交互前517.6坐标而失败，原件保留，不代记首次成功。详见 [最终收口](r84-desktop-closeout-v23-20261015.md)、[当前矩阵](r84-current-capabilities-20261015.md)、[必要门](evidence-r84-v23-20261015/final-gates.json)。

原生菜单最终副本7步真实输入、最大化/还原/预览Esc/关闭通过；用户2026-10-15已在审查会话对本BUILD鼠标拖动回填“能正常移动”，已单独按human/manual绑定BUILD/manifest，必要门pass=true。原自动化位移仍unverified，封存false结果保持；整体userAcceptance=pending。六对成员/详情原型与共享Composer九组通过，DPR1.5仅仿真。已收唯一待测拖动项，无需再次向用户索取拖动或历史清单；无账号/模型资源阻断。后续只按新用户反馈推进；不要重跑81次调用、2h或旧未知根。

唯一当前候选desktop-daily-win-v23-rc6/start-desktop.bat（旧v23/rc2–rc5保留阶段证据）。五份最终程序593文件均核size/hash、交付前候选未启动无数据根的收据已封存，quickstart与随包两份说明同hash；当前用户已启动产生数据，须原地保留。42份白名单证据已入docs，无DB/profile/密钥。源码/QA/42份证据收口已推送d707005，独立审查在该clean提交另跑总门确认同一唯一鼠标缺口；后续只有审查记录提交，当前HEAD由git实读，不将文档HEAD冒充冻结运行源码。

只读Codex返回work/files=[]并进入REVIEW已独立核实为现有“计划档止于方案”的合法文字方案交付；原answer/未执行原因明确未创建文件，不是伪造文件成果。GLM返回conversation属于允许的分类差异。不按中文关键词改worker/旧状态，不为此追加模型调用；quickstart已说明待审方案不代表实际执行，不承诺旧只读任务提权。完整证据readonly-result-facts.json，独立审查答复保留。

### rc4阶段历史（下段不代表当前候选）

先读 [R84进度](r84-progress-20261014.md)、[完整要求](prompt-r84-daylong-desktop-closeout-20261014.md)。R84基线969302b，当前HEAD用git读取。Codex当前gpt-6.1-sol/xhigh/custom阶段7次真实成功，原生鼠标移动仍未证（可见标准窗口键盘移动+12为观察正例）。人类已确认普通同串默认由原成员回答；现已实现正式持久队列、每消息固定配置/权限/前文边界、停止/归档/UNKNOWN守卫、普通已回复与实际工作分列。工作意见仍记录后显式返工。追加迁移051（001–050不变），完整兼容和最终三轮真实复证待完成。rc4 clean56e1025/bld_9629f3bf0827f192两个渠道各10次真实成功、普通3轮/图片字节/文件命令/返工v2验收/显式只读/仅记录均证；GLM重开通过，Codex关闭exit0无stop落盘/PID残留，故未放行。已零模型子进程反例确认IPC关闭后unref异步dispose让Node过早退出；working entry保活至真实stop落盘/关库/解锁，forced-incomplete仍保锁，永久2项通过。新运行源码待冻结/候选再复证/完整2h（早期阶段或前置失败不挪用）。兼容v50→51业务旧行/凭据/old仅记录sentinel已证，一次真实升级续问不含sentinel；旧程序拒51、696文件完整匹配备份回退v22可读、real_calls保持7。另v22自有unknown renderer原信封/草稿/提及/附件旧根已正式生成并重开保留未重放，待新包完整升级保全。不要套用下文R83为本轮已交付，也不要重跑任何旧未知请求。

## 历史交接入口（2026-10-14，R83主要路线已证，原生拖动门未验证）

先读 [R83交付与剩余门](r83-desktop-experience-v22-20261014.md)、[当前矩阵](r83-current-capabilities-20261014.md)、[总门](r83-v22-delivery-20261014.json)，再按git实读HEAD。运行源码冻结7af617e68697e549cab16bf96d427a67c7429a79，clean BUILD bld_06a536e62475c22f，最新入口dist/desktop/desktop-daily-win-v22-rc6/start-desktop.bat；后续QA/文档提交不是构建源码。1027源码项/双类型/增量lint、最终8次GLM普通语言真实请求、模型实际写文件/Bash/项目外自有写入、图片字节、返工v2验收/重开、593清单、原生菜单8项及必要Fake/UNKNOWN/导航回归已通过。corePass=true，完整pass=false：原生标题栏移动未取得位移证据，最小Electron同样，不能宣布首版已放行。下轮只接该剩余原生验证及新用户反馈，不重跑真实48调用或重新开发六项。

累计48次Claude/glm-5.3-flash尝试46成功、1已知失败、1阶段3中断未确认；后者原根不重开/不重发/不对账/不解保护。没有真实Codex调用，仅metadata/replay。当前工程根review-r83-v22-rc6-20261014保留8个原身份及未发送工程草稿。旧阶段失败、本轮关闭窗口连接失败/探针参数错误记录均保留，不代记首次成功。用户确认待定，最后仅一条10分钟自然路线，故障和历史长清单由工程承担。

用户最新政策：新真实执行任务默认CLI完整权限，可读写电脑并执行命令，保留显式只读/限制及旧任务快照；图片自动输入，不以工程证书名单恒定阻断；思考等级按真实CLI/模型列表并传入参数。必要真实调用已授权，使用独立目录与合成输入，已有Claude/glm-5.3-flash；不发送用户文档、不修改原数据。阶段3中断请求保留原身份，不重发、对账或解除保护。迁移001–050冻结且未变更。

## R82历史交接入口（2026-10-13，v21曾标候选，用户反馈未通过）

当前入口为 [R82交付报告](r82-desktop-write-v21-20261013.md)、[同BUILD必要判据与hash](r82-v21-delivery-20261013.json)、[当前能力矩阵](r82-current-capabilities-20261013.md)。R81与以下内容仅为历史；旧“零真实调用/全部写权限未接/唯一R75快照”等结论不再作为当前状态。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`，R82基线 `411932e`。冻结运行源码 `ab6a2b07db70b899d38e826801608e53d021c4e1`，clean BUILD `bld_13dda5dba459bbd4`，最终入口 `dist/desktop/desktop-daily-win-v21-rc6/start-desktop.bat`。后续HEAD为QA/记录，用git实读，不把记录提交冒充构建源码。首次v21及rc2–rc5阶段包/原失败原地保留，不能误开作当前候选。
- 已接：正式项目目录授权/CAS/幂等/物理身份，默认只读、旧任务不提权、模板只复制偏好；房间/DM输入与启动复查；Claude原生restricted项目文件工具；Codex沙箱协议映射但实际写入未认证；single_writer前后像/差异/交付绑定，退出未确认UNKNOWN保持耐久保护。
- 实际可用：已有Claude/glm-5.3-flash、登记CLI2.1.283字节/有效渠道/固定文件策略。最终同BUILD真实BAT7次全部成功：默认只读/房间v1→明确返工v2→验收、B模板成员真实跨项目拒写、DM原生续接v1/v2→验收、撤销后新只读；真实差异/文件预览/普通关闭重开/实体定位通过。不是Shell、网络工具、委派或全渠道认证。
- 修复真实阻断：revision=1工作区入口导致r2重开失败、Markdown正式交付结构失败、模板后房间名单漏回读、跨项目设置未对齐导致授权禁用、文件页局部投影假0、新差异面板空内容渲染。原失败保留，不能改记首次成功。文件页权威最近100项/audience与选中文件前后快照；100路径/每侧256KiB，缺失/失败/二进制/超限分列，未接mock撤销/暂存。
- 工程门：145文件/1017测试、双类型、变更lint、593清单；最终同BUILD20步Fake自然工作流、UNKNOWN回执丢失/重开/人工原号重放、11导航取消/设置目标、附件稳定/实际PNG/原件hash、3视口原型配对。工程故障/视觉与真实模型分别记录，不代用户验收。
- 调用账：用户R82已授权必要多次合成工程文本调用，无逐次再问/旧两次限制。deepseek返回402后用户指定GLM。累计32真实turn尝试（31GLM、1deepseek），原生探针5/正式worker27按turnId去重；最终7全部正式成功。无真实Codex/新识图调用；资源不再阻断已验证组合。不要自动重试旧FAILED/UNKNOWN，下一轮新调用范围按新需求处理。
- 数据：只追加050，001–049冻结。完整自有旧v20根副本67旧表/92文件、真实旧程序拒绝50、匹配备份回退通过；用户原根未迁移/覆盖，无删除/清理/搬移用户旧包或文件。无需新增schema来读差异。
- 用户已通过图片发送/预览，继承。本轮用户确认尚未回填；最后只一条5–10分钟空测试目录自然“只读→授权/需验收→修改→看实际文件→明确返工/验收v2→重开”路线，不制造竞态或重测图片。
- 边界：仅原生受限项目文件编辑，不认证Shell/自动构建测试/网络/委派/其他CLI模型；Codex写入/识图仍unverified。不新增改动集全文分页/统一行级diff或OS睡眠/多日认证。AUTO/DELIBERATE、并行写入、Android、安装器/签名/更新/通知/价值评价等既有延期保持。不自动发/继续队列/验收/对账/解保护。
- 下一步：收集本轮自然使用反馈；不要再依历史表宣布项目修改未实现。新缺陷先复现；如果扩通用执行工具或其他渠道，需明确机制及独立证据，不能复制GLM文件档认证。

## 历史交接入口（2026-10-13，R81 / v20）

当前入口为 [R81交付记录](r81-member-management-v20-20261013.md)、[必要判据与证据hash](r81-v20-delivery-20261013.json)、[当前能力矩阵](r81-current-capabilities-20261013.md)。R80及以下段落仅为历史，旧矩阵不能当当前状态。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`；基线HEAD `56a8b87`。正式运行源码冻结 `ab418320a827803fb56d9de54a28100822e451ed`，clean BUILD `bld_12c5ceedf87665ec`；入口 `dist/desktop/desktop-daily-win-v20/start-desktop.bat`。后续为QA/记录，当前仓库HEAD先用git读取；不得把记录提交冒充构建源码。
- 已实现：资料编辑的项目/成员/版本合同与CAS、名称/说明/短ID查找、启停/配置/工作量分列；明确来源的白名单模板保存/查看/编辑/停用、明确项目创建独立快照成员、实际重开后再用。原成员ID/runtime/任务/会话/正文不重建，不共享可变profile，不同步既有成员，不复制凭据/认证/私有正文/任务/项目上下文。
- 已修：成员路由项目错配、旧路由抢新打开、深链启动未知账本不可达、写成功读失败可重复创建、Codex正式工厂忽略程序引用。程序可用性与正式解析共源；权限保存值与实际值分列，Codex仍read-only/never、不接新权限认证。未知成员操作独立64项/256KiB原信封，用户人工同号同参；消息/任务旧账本合同保留。
- 工程：992项/139文件确定性门、14项新增、双类型检查、增量lint；最终真实BAT7步正常成员流程、5组故障及手工重放、20步R78/R79闭环；项目取消/交叉10场景，附件/原件hash与阅读必要回归；593文件清单。最终同BUILD视觉6成员/3模板、宽/窄/HiDPI明确viewport、动画完成。失败原件和探针问题保留，不能代记首次成功或用户验收。
- 持久化：仅追加049模板表，001–048冻结。完整旧v19工程根副本86文件/66旧业务表、实际旧程序拒绝49、匹配48备份开回通过；用户原根未迁移。回退只恢复升级前事实，不合并v20新增变更，不开发整根恢复产品功能。
- 用户已通过图片发送/预览，继承。R81工程通过不代用户确认。只一次约5分钟“改名已配置成员→保存配置模板→测试项目创建→核原成员不变→重开”路线，故障竞态由工程承担，不要求用户重测图片或调用模型。
- 真实模型调用0，Codex gpt-6-luna识图仍unverified，旧上游超时保留，不retry/startTurn；Claude仅有效配置身份匹配的旧证据。程序引用存在≠模型可用/认证。模板不伪造使用数量；思考强度/子助手/生命周期重置仍未接。
- 用户旧包/数据/凭据/草稿/未知账本原地保留，无删除/搬移、自动派发/重发/验收/对账/解除保护。D盘用户自行处理。既有AUTO/DELIBERATE、并行写入、工具权限认证、Android、安装器/签名/更新、通知、价值评价仍延期。没有新增OS睡眠/多日认证；外部GitHub sandbox本批排除，不把旧外部失败改为通过。
- 接手先核Git与当前交付JSON；不要按R75/R59旧表重新宣布当前能力缺失，不自动重试真实模型或未知命令。

## 历史交接入口（2026-10-13，R80 / v19）

当前入口为 [R80交付记录](r80-desktop-recovery-v19-20261013.md)、[必要判据与证据hash](r80-v19-delivery-20261013.json)、[当前能力](r80-current-capabilities-20261013.md)。旧R79/v18及更早段落仅为历史。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`；接手HEAD `10d9e8c`。冻结运行源码 `7de88268e1730d227254458d362e20309a1f93b7`，clean BUILD `bld_02c536c5b5eb3ab3`；日常入口 `dist/desktop/desktop-daily-win-v19/start-desktop.bat`。后续提交仅QA/记录，当前仓库HEAD以git读取为准，不把记录提交冒充构建源码。
- 新能力：有界共享连接恢复与明确失败/挂起提示、monotonic截止、只读返回核实；保留确认事实和读时间；阅读位置/所选run/历史页/私信任务按根与实体保存；原件原子提交；本地脱敏诊断查看/复制。已修同线程深链陈旧意图、相同时钟容量淘汰新位置、跨分组清理DOM覆盖旧展开。
- 工程门：978项/136文件确定性套件、双类型检查、本批lint无新增；真实最终BAT完整闭环、受控断连/恢复/重载/重开、真实未知回执同号重放；最终同BUILD持续观察时长与计数以JSON为准。前序30分钟旧BUILD证据保留，不代替最后修复后的最终包。源码、隔离注入、发布形态、OS行为分开记录。
- 用户已通过图片发送与本地预览，继承；不代记R80用户验收。最后只有一条5分钟“查看/复制诊断→正常切换阅读→关窗重开”确认；故障、未知账本和长观察由工程承担。
- 边界：真实模型调用0；Codex gpt-6-luna识图仍unverified，不retry/startTurn；Claude仅继承原有效身份认证。powerMonitor通知明确为模拟，native仅暂停自有PID3秒；未做真实OS睡眠/休眠/断电/多日挂机。阅读元数据64项/512KiB、重开12标签包含活动项；仍重验权限与原件，不是事实缓存。
- 保全：用户旧包、数据、配置、凭据、草稿、未知账本原地保持；R80没有清理、删除或搬移用户/旧包文件。迁移001–048冻结。无自动重发、队列继续、验收、对账或保护解除。既有外部GitHub沙箱2项失败保留未重跑。既有延期范围保持。
- 下一步：收集v19正常使用反馈；不要让用户再制造竞态、配置错配或长任务。真实模型认证须另行明确最小调用需求，本轮不推进。不要因历史段落重做R75/R76/R78/R79。

## 历史交接入口（2026-10-12，R79 / v18，已由上方R80替代）

本段和 [R79交付记录](r79-desktop-stability-v18-20261012.md)、[必要判据](r79-v18-delivery-20261012.json) 是当前入口。下面 R75/v13 及各旧轮次仅作历史，不能作为当前能力矩阵。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`；R79 接手 HEAD `cbc6d15`。当前冻结运行源码 HEAD `83ec701e70f2eb903df5a1017fe99d333f2c008e`，clean BUILD `bld_8f7f491551feeaf7`；日常候选 `dist/desktop/desktop-daily-win-v18/start-desktop.bat`，与旧 v17 独立。此后仓库提交仅工程探针/交付文档，实际仓库 HEAD 请读取 `git rev-parse HEAD`，不要把构建源码身份替换成文档提交身份。
- 当前能力：继承 R78 房间DIRECT/DM完整闭环、项目打开/取消/最新导航意图、附件事实链、图片阅读、草稿与未知原信封保护；新增可见详情5秒有界单飞读取、隐藏/接管暂停、历史run选择保持、失败快照和读取时间、选中run按需明细、运行/活动/交付稳定游标单页历史、详情长列表统一滚动、权威成员工作量、预算/用量及执行摘要。看 [R79当前矩阵](r79-current-capabilities-20261012.md)，完整工作流基面仍对应 R78 当前矩阵而非 R59/R64 旧表。
- 工程验收：962项本地确定性测试、双类型检查、修改文件lint无新增错误；最终真实BAT20步（普通首启/房间与DM两版交付返工验收/失败显式继续/停止/持续活动/历史/重开），10取消交叉场景；正式仅记录工程PNG实际解码、3轮刷新、缩放拖动/Esc/树入口/原件hash。593清单绑定同BUILD。既有外部GitHub沙盒测试初次2项失败原样保留，未称全量967通过。
- 用户已通过：图片发送与本地预览（继承此前明确反馈）；R79工程通过不代记本轮用户验收。用户只需记录里一条约5分钟已有任务阅读路线，不制造长任务/竞态/故障，也不重复图片清单。
- 边界：本批真实模型调用0；Codex `gpt-6-luna`真实识图仍unverified，无retry/startTurn。Claude仅沿用有效配置身份相符的旧认证，不扩大认证范围。普通任务由正式worker产生；26run/3250活动/61交付历史规模夹具明确分列，非真实模型成果。所选run的80轮/每轮50用量、子任务50/改动集100/成果100仍显式截断，没有本轮分页；分钟级交互与恢复验证不等于多日挂机/睡眠唤醒认证。AUTO/DELIBERATE、并行写入、工具权限、Android、安装器/签名/自动更新/价值评价仍延期。
- 保留：用户旧包/数据/配置/草稿/未知账本原地未动，迁移001–048无改动，无自动重发/对账/解除保护。D盘曾ENOSPC，若干本轮生成的重复程序副本可恢复转移到 `C:\Users\user\.codex\tmp\r79-stage-programs-20261012`，工程数据库/截图/失败回执保留在原dist路径，详情见反例记录；不删除用户包。
- 下一步：使用v18自然阅读已有任务，收集实际业务问题；真实模型认证只在另行明确授权最小调用预算后推进。不要因旧报告重做R75/R76/R78，也不要自动启动模型或处理未知命令。

## 历史快照（2026-10-09 第七十五轮；R75/v13 已被下述 R79/v18 替代）

> R75=项目切换落位/取消收口（review-r74 独立复核：从房间经真实弹窗打开 B 被旧 A 路由抢回×2+装载期取消只还原焦点留 A 的 lastPath）。**主交付=desktop-daily-win-v13** `bld_d4510629e370c260`（commit `6ddd41e`，dirty=false，593/593；r63 --src v13 ok realCalls=0；**启动器发布协议复证普通打开路线 ok**：A 房间真实弹窗开已注册 B 全落位/A 保留/零 toast+再开新目录 C 最新意图+重启进 C+console 0+realCalls 0）；交互门 `verify-daily-r75.cjs` **G1–G3 全绿**（ok:true, errs:[]；realCallRoots 3×0）；全量 922/922；r72/r73/r74 门回归全绿。
> - **P1 落位所有权**：openProjectByPath 提交时登记 `openInFlightTarget{projectId,urlSeqAtStart}`（router `currentNavSeq()` 每次 hashchange +1）+收尾按代次清；房间路由/ProjectHomePage 在「他项目打开在途且 URL 自打开发起未变」**让位**；**返回 {id:目标}**——打开弹窗/pickAndOpenFolder 按目标 id 选房间落位（不读异步结束时的 activeProjectId）。**先复现**：stash 后「A 房间→真实弹窗开 B」FAIL（URL/active 留 A+lastPath=B=复核签名）。
> - **P2 回滚完整性**：装载期取消回滚=焦点+**zs.lastProjectPath**+**rooms/members/memberRuntimes/dms 整表投影**（守卫 openedId 已提交/焦点仍指本次目标/无新代次/非同项目重开——不覆盖用户后续选 C；注册表不回滚）；装载**失败**+取消同口径安静收尾。门 G2③：active/lastPath 回 B+侧栏 B 房间投影恢复+i4NavSets=0；集成 S3/S3b/S3c。
> - **衍生真缺陷①ProjectAlign 双态**：R74 窄回滚掩盖的churn 在补齐投影回滚后变 **project.open 无限循环**（探针 cmds.log 47,172 条）——房间路由在「本项目打开在途」**保持对齐分支挂载**（意图存活到波收尾），清理判据=**URL 是否仍指向本项目**（成功交接只释放/用户真跳走才取消）。修后 31 条 6s 进房。
> - **衍生真缺陷②R74 回归：交付文档内「打开文件」**硬编码 files 来源→对话内点击被 R74 自动收起即刻折叠（r72 门 G1 成果文件视图超时暴露——R74 门未覆盖该链）——改按当前预览上下文 openedFrom；r72 门修复后全绿。
> - **坑**：弹窗 autoPick 挂载即取目录（测试再点「浏览…」会多取一行）；ZS_PICK_FOLDER_FILE 按行序供目录（一次运行连开多项目）；member.list 延迟钩子会被 B 基线装载消耗（改 saved.list）；**daemonPipeNameFor 按 home 派生=用户级单例管道**（残留 electron 树占管道→后开的 app 连到旧 daemon→「no such table/directory」假阴性——清杀残留后绿，非代码缺陷）；r72 门 G1 是交付文件链的唯一回归覆盖。
> - **边界**：发布启动器无延迟钩子（bat 清洗 ZS_*，显式直通 ZS_DEV25_DEBUG_PORT/ZS_PICK_FOLDER*）；装载期取消强复现在源码门/集成；触屏/<940px/像素对照（沿用）；15s 上传悬置；既有延期不动。报告 `r75-open-landing-rollback-closeout-20261009.md`+矩阵 `capability-matrix-r75-20261009.md`。

## 历史快照（2026-10-09 第七十四轮）

> R74=两个交叉场景修复与日常使用收口（review-r73 独立复核：project.open 在途取消失效+混合标签自动收起失效，各复现 2 次）。**主交付=desktop-daily-win-v12** `bld_49bb7307dfac1435`（commit `1dbf27b`，dirty=false，593/593；r63 --src v12 ok realCalls=0；**启动器发布协议复证两交叉场景+基本布局 ok**：混合收起/恢复 2 标签/拖动 608→460/放大+Esc/双 hash 取消 prefs=B（与包库核对）/正例 A，console 0，realCalls=0）；交互门 `verify-daily-r74.cjs` **G1–G5 全绿**（ok:true, errs:[]；realCallRoots 5×0）；集成 `hifiNavCancelRound74` 1/1；全量 **922/922**（921+新增 1）；r73 门回归 ok errs:[]。
> - **P1 取消凭据进项目打开内部**：openProjectByPath 收具体 NavIntent——project.open 回执后（焦点/可见集合/zs.lastProjectPath 提交前）与装载刷新波后（persistNav 前）核意图；取消=零提交（不切项目/不写记忆/不写偏好/不弹错/安静返回，recordWrite 'project.open.cancelled' 观测）；**装载期取消还原焦点**（仅当焦点仍指向本次结果且无更新代次）。验证分列：集成 S2/S3/S4（project.open/成员装载/thread.get 等待期）+S5 反序+S6 合同（启动恢复不被无关意图拦、用户级打开仍取消在途）；门 G2 用 **main.ts 既有观测钩子 ZS_UI_DELAY_METHOD_MS**（真实转发层受控延迟——重启注入 project.open:3200/member.list:2500 造确定性窗口）。**先复现**：unfixed 集成 FAIL 于 S2、unfixed 门 G2①② FAIL（active=A+prefs=A=复核签名）。
> - **P2 混合标签收起**：判据改 `shouldAutoHidePreviewFor`（**当前活动预览来源**+explicitShow——保留的历史房间/线程标签不再阻止收起）；Room/线程共用，**DmPage 同判据新增+DM 头部 PreviewReopenButton**（hidden 时 pane 不挂载——单向门反例）。门 G1 矩阵（真实侧栏点击+原生滚轮）：room+files/thread+files/显式再往返/显式保护/跨项目/在途/DM+草稿+阅读位置 240 保持。**先复现**：unfixed G1 FAIL 于①③⑤⑥+截图视觉判读（两标签占房无重开按钮）。
> - **衍生真缺陷：阅读位置恢复**——原 effect 挂载即赋 scrollTop，异步内容装载前被钳 0（r73 实测 reopen=0 未断言）；且钳制赋值触发 scroll→rememberScroll 把钳制值写回=丢位置。修复：逐帧重试到**目标可达**才赋值（≤90 帧），用户滚轮/按下即停。
> - **上传重传口径**：uploadDiagnosed 逐次记录（耗时/错误原文/artifacts 落库/分类）——本轮 3 次 XLSX 首次通过（4.7–5.1s），**15s 未复现→归类悬置**（r73「环境抖动」维持未证实；仪器常驻）；UNKNOWN 合同未动。
> - **坑**：ZS_UI_DELAY_METHOD_MS 只延迟首个匹配方法（重启换钩子）；start-desktop.bat 清洗父环境 ZS_*（发布形态取消复证用同刻双 hash——取消先于任何异步回执）；侧栏房间只列最后聚焦项目（refreshRooms 替换语义——跨项目回房走项目页路由）；合成 scroll 事件不触发 React onScroll（门内滚动用 CDP 原生滚轮）；import.meta.env 在 esbuild 打包链未定义（调试行曾致渲染回退）。
> - **边界**：触屏/触摸板、<940px 分隔条细分、逐页像素级对照（沿用）；既有延期不动。报告 `r74-cross-scenarios-closeout-20261009.md`+矩阵 `capability-matrix-r74-20261009.md`。

## 历史快照（2026-10-09 第七十三轮）

> R73=页面切换/预览布局/导航取消收口（v10 用户实测三项：切房间预览占用+无分隔条+放大无效；review-r72 §P1 已取消定位仍切项目）。**主交付=desktop-daily-win-v11** `bld_87d8fd4ec1c6283c`（commit `ed39838`，dirty=false，593/593；r63 --src v11 ok realCalls=0；**启动器发布协议复证三项修复 ok**：自动收起/拖动 608→460/放大铺满+Esc，console 0）；交互门 `verify-daily-r73.cjs` **G1–G6 全绿**（ok:true, errs:[]；realCallRoots 6×0）；全量 921/921（一次环境 flake 复跑绿）；r72 门回归 ok errs=[]。
> - **A 自动收起**：进对话上下文时纯文件页来源预览 hidden（标签/阅读位置/草稿保留；房间头部重开按钮=显式不乒乓）；explicitShow 两处 openPreview 统一（**actions-preview 漏设是在途回弹根因**——门迭代挖出）+effect 补 s.resources 依赖。
> - **B 真分隔条**：usePreviewWidth 驱动 L3/L4 上下文|预览真实边界（原生 pointer/380 下限/双击复位/窗口缩窄拉宽不棘轮）；旧 L4 回复串左缘反转语义移除。
> - **C 真放大**：paneCls 消费 maximized 铺满 .workspace/.main；**hifi-flag.js 注入的 frameless top:38px!important 需同级 !important 压回**；Esc 还原（.menu/.scrim 打开时不穿透）。
> - **导航取消（真缺陷）**：lib/navIntent 登记簿（navigate/用户级 focus/open 取消全部在途意图；system/fromIntent 标记防自杀；启动恢复标记系统防误杀冷启动深链）；定位链每个 await 后/重试/提交焦点前核意图；LocateThread deps 补 message/tab（同 threadId 取最新）；错误按真实原因分列；冷房间直链条件（active 已恢复但房间未装载——§2 疑点证实）。
> - **PPT 页级 render-ready**：RenderedSlide data-zs-render=pending/ready/error（页+代次绑定，live 防迟到旧页误标；此前 ready 拒绝被吞）——G5 82/82 ready 0 失败。
> - **坑**：window.zs 是 contextBridge 不可重定义（延迟注入改用「同刻 hash 双写」制造在途取消时序）；文件树挂载时扫描（新复制文件需离回重扫）；raw pageCmd 不写前端注册表（重载装载）；r73 门 XLSX 上传 15s 主进程超时=环境抖动（门内重传）。
> - **边界**：触屏/触摸板、<940px 分隔条细分、逐页像素级对照未覆盖；既有延期不动。报告 `r73-layout-navigation-cancellation-20261009.md`+矩阵 `capability-matrix-r73-20261009.md`。

## 历史快照（2026-10-08 第七十二轮）

> R72=原始使用路径修复与桌面日常收口（review-r71 独立复核：文件树 22.54MiB 仍被 20MiB 拒/Git 往返残留/深链不稳定/验证口径纠正）。**主交付=desktop-daily-win-v10** `bld_0558b208779db4a7`（commit `a700a58`，dirty=false，593/593；r63 --src v10 ok realCalls=0；**启动器原始路径复证 ok**：树开真件 82 页 5.4s+p40 图 1/1 解码+console 0 错）；交互门 `verify-daily-r72.cjs` **G1–G7 全绿**（ok:true, errs:[]；realCallRoots 6×0）；全量 921/921；r71 门回归 ok（前两次环境 CPU 争用 flake，第三次干净通过+G1 单段绿，如实登记）。
> - **P1 文件树容量**：PREVIEW_BINARY_EXTENSIONS 接共享合同（Office=OFFICE_MAX_BYTES 32MiB、PDF 分道 20MiB、图片 8MiB）——readFull/originalFile 双通道；r67Contracts 增 20–32MiB 边界永久用例（21MiB 过+33.5 拒+21MiB PDF 仍拒）；G1 用户原始路径真件 82 页 5.4s+另存 sha 一致+上传件/成果件分列。
> - **P2 Git 往返**：成功清 notARepo+已解决的 git.status 读失败（其他操作 lastOp 不抹）；非 Git 重置 emptyGit 投影（留 commitMessage/reflog）；真实错误清中性标记——G2 七步含 objects 损坏=红（`.git` 变文件会被 simple-git 归 NOT_A_GIT_REPO，换 objects 变文件注入）+跨项目 trunk/main 分列。
> - **深链四修（真缺陷）**：loadThread stillCurrent 双门丢跨项目装载→ensureProjectActive（**活跃≠已装载**：applyServerNavPrefs 恢复 active 不装房间→直达房间报不存在；现要求活跃且房间已装载才早退+focusProject 落位校验+openProjectByPath 兜底）+locateThread（探归属→对齐→一次重试）+`/project/:pid/room` ProjectAlign+**Room 挂载期 previewSide 让位**（路由重挂载 prevThreadIdRef 相等不动作→上传芯片 pool 侧把线程面板整个隐藏）+消息高亮有界重试。G6 十步矩阵 10/10（真跨项目/看板/待办[二次派发造未读]/收藏[scope 切全部]/搜索[Enter 检索+scope]/冷启动/不串）。
> - **口径补齐**：G3 82/82 逐页渲染 walk 0 失败；G4 Excel aria 69913+Ctrl+Home 8000→0+横纵滚动+sheet 恢复+**视觉判读首/中/末与 openpyxl 全对上**（末行 DATA_AS2.BIN_01478/内部字段表；绝对底部=~120 行尾部空网格行带——正常形态）；G5 全进程采样 worker 峰 887MiB<896 硬界+收拢回基线；**不再上调任何限额**。
> - **R71 证据错位修正**：六源③实为房间级记录（`.composer-input` 全局选择器命中房间区）→.col-thread 作用域+thread_id DB 断言；②「本次仅记录」按钮 2025-09-25 起已收进 ⋯ 菜单（r71 点击实为 no-op、其二实为 AI 派发）→真实仅记录+DB 落库断言。
> - **边界**：canvas 选择/复制合成输入驱动不了（键盘滚动正常）——视觉判读替代；深链对齐链低频竞态已加产品级吸收（take-18 双轮未达→take-19/启动器稳定）；既有延期不动。报告 `r72-original-path-git-roundtrip-20261008.md`+矩阵 `capability-matrix-r72-20261008.md`。

## 历史快照（2026-10-08 第七十一轮）

> R71=真实文档容量与非 Git 收口（用户 v8 真实样本反馈优先：22.54MiB PPT 被 20MiB 上限拦+非 Git 红横幅）。**主交付=desktop-daily-win-v9** `bld_a03ef3a265fd6513`（commit `f4fa0e4`，dirty=false，593/593；包级门 r63 --src v9 ok）；交互门 `verify-daily-r71.cjs` **G1–G8 全绿**（ok:true, errs:[]；realCallRoots 8×0）；全量 920/920+双类型门 0 错；r70 门回归全绿。
> - **容量分道**：Office 20→32MiB（真 22.54MiB/82 页 PPT 全链：上传 5.9s/首屏 4.5s/中页图文/末页/缩放/回位 82/另存一致/堆 13→111MB）；ZIP 单条目 64→128MiB（真 73MiB 表 XML——9.8MB XLSX 69793 行此前被整份误拒）；解析堆 320→768MB+整进程 896MiB（alloc 反例测试改相对常量）；Office 解析截止 120s；超限错误人话 MiB。
> - **非 Git 中性态**：git.status 保留 NOT_A_GIT_REPO 结构码→UI 中性面板（真 Git 错误仍红）；G3 在真正仓库外临时目录实测（gate 目录在 zhongshuo 仓库内——git 向上发现外层仓库是正确行为）。
> - **登记项收口**：project.open DTO 补 rootPath/canonicalPath（新建+命中两分支+测试）；多远端 upstream 真值（upstreamMultiRemote 永久测试：origin+backup ahead=2/behind=1 与 rev-list 对上）；能力矩阵 `capability-matrix-r71-20261008.md`。
> - **交付真文件+六源**：fake writeFile 支持 contentBase64+ZS_FAKE_WRITE_FILES_JSON；真 DOCX/XLSX/PDF 字节自然落盘（sha256 逐一相等）→成果「打开文件」→同一阅读器→另存一致；六真源逐项判据（草稿/已发/**线程回复附件**/DM/文件树/**成果文件**）全绿。
> - **真窗口回弹真缺陷修复**：useThreadWidth resize 棘轮（620→380 不回弹——R70 疑点确认为产品缺陷）→删收敛写回；1283→760→1283 pane 608→514→**609** 实测；DPR2 背板 780=2×390。
> - **未覆盖**：69793 行引擎滚动逐帧性能（观感待用户）；/thread/:id 深链 G5 场景定位不稳（卡片路径替代，独立登记）；82 页逐页视觉（首/中/末+缩略图断言）。

## 历史快照（2026-10-07 第七十轮）

> R70=文件阅读器可靠性与视觉收口（R69 独立复核五类反例+CSP 图片拦截全部先修后验）。**主交付=desktop-daily-win-v8** `bld_6d502ccefe8159b3`（commit `33230aa`，dirty=false，593/593；包级门 r63 --src v8 ok realCalls=0；升级门 ok 负例 4/4）；交互门 `verify-daily-r70.cjs` **G1–G8 全绿**（ok:true, errs:[]；realCallRoots 8×0——每独立根核 real_calls）；视觉门 `visual-pairs-r70.cjs` 8 帧+Word 红字/高亮补帧全 PASS（逐帧记录整窗 2560×1380/DPR1 与**实际预览 rect x=1932 w=620**——两者分列）；r69 门回归全绿；全量 917/917+双类型门 0 错。
> - **反例修复**：①资源 ID=encodeURIComponent 无损键（中文/标点/跨项目不碰撞）②Excel 切表弹回=render 重建 ArrayBuffer→FileStage 稳定 bytes+装载缓存 ③PPT 图片=CSP `img-src … blob:`（zsres 本地 blob 放行；外部边界不变；真件 p5=3/3 解码）④阅读状态=readerState 按资源+版本存取（PPT/PDF 页缩放、Excel 表、Word scrollTop；切标签/收起重开保持）——**goToPage 嵌套 setState 是真根因**（R69 起存在，r69 门只断言输入框值未暴露）⑤PDF fit 观察器挂常驻节点+DPR ⑥Word wrapper 渲染后内联覆盖+四缺失图标 ⑦交付真文件=fake `writeFile` 脚本项+`ZS_FAKE_WRITE_FILES`+报告「涉及文件」逐项打开文件→同一阅读器 ⑧事实回填 applyWorktreeRead+delivery hashMatch/bytes 真值。
> - **三枚行生真缺陷**：Room 线程附件选择器结构性看不到锚附件（thread_id=null——已发消息入口恒空）；renderStructuredFinal 透传破坏 resultKey 绑定（19 例测试翻红——resultKey 一律以 turn 绑定为准）；探针直接 `input.value=` 被 React valueTracker 去重（假阴性来源——改走真实 UI 路径：缩略图点击/翻页箭头）。
> - **判据纪律**：R69 曾把 xlsxTabSwitch=false 记 ok=true——R70 门全部必要判据进 errs（任一假值 exit≠0）；18 轮迭代每个假阴性先翻 FAIL 再修。
> - **未覆盖**：PDF 连续滚动（单页+页码=参考形态）；Excel 行高差（info）；Emulation 拉宽被窗口钳制（wide 信息项）；既有延期不扩。

## 历史快照（2026-10-07 第六十九轮）

> R69=文件预览集中修复与 ZCode 源码对照（用户五图验收基准）。**主交付=desktop-daily-win-v7** `bld_e6abb00832d9dce2`（commit `70b86b2`，dirty=false，593/593；包级门 r63 --src v7 ok realCalls=0；升级门 ok 负例 4/4）；交互门 `verify-daily-r69.cjs` **G1–G7 全绿**（real_calls=0，用户真 PPT 11.7MB/55 页+PNG+四态文本+PDF/Word/Excel/MD/HTML+文件树+DM+已发消息+宏/损坏负例）；视觉门 `visual-pairs-r69.cjs` 7 对同视口（2560×1380）vision 全 PASS；r68 门适配新外壳后全绿；全量 917/917+双类型门 0 错。
> - **对照源码**：zai-org/ZCode @29628c9（映射表 `zcode-preview-mapping-r69-20261007.md`）；新依赖 @extend-ai/react-xlsx 0.16.0（MIT，PROVENANCE 溯源；worker 构建期预 bundle——裸 import fflate 陷阱）。
> - **P1**：房间首开死锁=store.openPreview 调度层同步开标签；PPT 误判=classifyOfficeMain 按**主 part** content type（嵌入 xlsb 不污染；宏只看主 part）；文本原字节=attachment.uploadTextRaw+decodeTextBytes（BOM/UTF-16/GB18030/0B 允许；控制字节=二进制判据）；Office 软解析失败不再吞上传（extraction:'failed' 分列，注入 fail-closed 保持）。
> - **统一阅读器**：PreviewPane 重写（标签条/面包屑/内容三层=参考结构）；fileSource 统一字节链（附件/工作区 readFull 二进制扩展/交付）；PPT=同库引擎架构（缩略图列/主舞台/底栏）；PDF=真实面板 contain 适应+页码输入；Word=分页纸张全白流（无第二副本）；Excel=WASM 引擎+sheet 页签+回退网格；文件树同阅读器。
> - **未覆盖/延期**：HTML 交互（脚本仍禁）、图片自由缩放、PPT 连续滚动、Excel 回退网格无样式、Android/安装器/价值评价既有延期不扩。

## 历史快照（2026-10-07 第六十八轮）

> R68=真实旧版继承与保全收口（R67 独立复核：跨目录继承四缺口/版本门与坏标记/重试门无牙/成员边界/交付文档第三来源/Select 展开态）。**主交付=desktop-daily-win-v6** `bld_99dadb937ca3bc87`（commit `9c11154`，dirty=false，591/591，verify-desktop-daily 绿）；交互门 `verify-daily-r68.cjs` **G1–G6 全绿**（real_calls=0）；视觉门 `visual-pairs-r68.cjs` 11 场景+vision 复核（含 Select 展开态/表格修复后）；升级门 `verify-upgrade-r67` ok（47→48+负对照 4/4）；全量 912/912+r68Contracts 7/7+双类型门 0 错。
> - **真实旧版继承（§2）**：继承标记 `zs.hifi.inherit.<ns>` 与 v2 键存在解耦；同目录 v1 键自动继承（构造性可信）；旧根无标记→设置页「旧数据目录继承」持久化候选+用户逐键确认导入（hasStateDb 核对）；冻结 v4/v3 包真启动链端到端演练全过（原 commandId 完整、同号重试恰一次、草稿恢复）。
> - **版本/身份保全（§3）**：mergeInheritedSnapshots 版本门同判（v999 整体拒收+原件保持）；坏 root-identity 不覆写不换 ID（rootIdentityHealth=invalid-marker+修复指引）；仅缺失才原子创建。
> - **重试门真牙（§4）**：按按钮正文定位+ZS_COMMAND_LOG_FILE 管道信封日志（commandId/params 逐字比对）+负对照实跑；两封不同命令未知并存（queued 按 commandId 并集）；等待期编辑保留。
> - **成员边界（§5）**：归档/移除/空白名服务端守卫+replayGuard；AddMemberModal 捕获打开目标（切换作废）；同名成员 #短标识（卡片/名单/@/配置）。
> - **第三来源与尾项（§6）**：delivery.document 正式命令+Room/ThreadPage「打开文档」（阅读=TaskComplete 结构/源码 JSON/另存对账/引用带 manifest 绑定）；project.file.stat 脏检测→磁盘已更新提示→保存拦截→重载新快照（修复重载后 pendingRevision 重复追加）；空文件 0B 另存；自绘 Select listbox（原生清零、键盘可达、展开可截图）。
> - **衍生真缺陷**：**preview.css 漏出包**（正式构建全量缺预览样式——MD 表格无边框；build-ui 清单补入，vision 复核修复）；继承候选只存内存→重载即空表永久跳过（标记持久化队列）；重载+偏好恢复后 DM/房间投影无人装载（DmPage/ProjectHome 挂载即刷新）；fake 结构化终态补末条消息（真实 final-result 同构——测试基线同步 912）。
> - **README v6**：情况 A（首次从 v3/v4 升级：复制 server-data→设置页确认导入）/情况 B（v5/v6 自建根整根移动：自动继承）分列；回退=升级前完整根+匹配旧程序。**用户实际数据在 v3——按情况 A 走**。
> - 交互门工程事实：强杀丢 LevelDB 缓冲写（实证）→门内 Browser.close 优雅关窗；v3 侧栏不列注册表项目→autoOpen 记忆路径+「默认房间」通用就绪信号。
> - 下一轮（R69）待办登记：v6 自然使用反馈优先；HTML 交互网页（脚本仍禁用）如实边界；R64 遗留 project.open 响应 rootPath/canonicalPath；多远端 upstream 复核；交付文档 UI 的私信任务线程形态核对。

## 当前真实状态（2026-10-06 第六十七轮，唯一权威快照）

> R67=日常使用与数据继承收口（R66 独立复核四反例+升级门修正+控件/原型补齐）。**主交付=
> desktop-daily-win-v5** `bld_fd6a5557b37a5bb9`（591/591，verify-desktop-daily 绿）；交互门
> `verify-daily-r67.cjs` **G1–G6 全绿**；视觉门 `visual-pairs-r67.cjs` 非空密度 10 场景+vision 10/10；
> 升级门 `verify-upgrade-r67.cjs` 全绿（基线先存/全树对照/负对照 4 实跑拒/回退=完整根/版本门拒/
> guard=1+real_calls=0）；全量 905/905+r67Contracts 6/6+双类型门 0 错。
> - **跨目录继承（P1-B）**：root-identity.json 逻辑身份（app.identity 懒建）+持久化 v2 键+
>   双通道验证（快照内嵌 dataRootId 本地自证——目录改名/移动可继承；旧格式经 app.rootIdentityOf
>   只读核对旧目录标记）；merge=pendingSends 按键取新/账本 commandId 并集/草稿 24h；旧键保留。
>   G1=真实完整目录复制+真实启动器：未知横幅+commandId 逐字恢复、同号重试 0 重复。
> - **工作区完整阅读/原件保存（P1-A/P2-B）**：project.file.readFull（全文+sha256+includeBytes）/
>   originalFile（原字节）；WorktreeBody 三源同风味（MD 排版/HTML 隔离 iframe/源码）+读取时快照
>   字节保存；保存链经 ZS_SAVEAS_AUTO_DIR 测试钩子实际落盘 sha256 逐字核验（不检测桥存在）。
> - **恢复来源稳定（P2-A）**：首次成功快照实体签名固定 startup；同运行新实体=runtime（toast+侧栏
>   永不弹窗/不改判）；G4 六态含真实重启 startup 自动弹一次+关闭不重开。
> - **衍生真缺陷两枚**：①文件-only AI 派发在 turnInput empty-root-message 恒 BLOCKED（R66 只证
>   建卡——复核原话的实证）→允许空正文+附件（无附件仍拒）；②保存过导航偏好+无记忆路径→boot
>   永远 pending（applyServerNavPrefs 已设 activeProjectId 而 ready 条件误要求空）——G4 调试中
>   「direct=true 但 attr=0」定位。
> - **P4**：共享 Select 全页接入（含 pdf-zoom/恢复对账/绑定弹窗）；member.create+迁移 048+
>   AddMemberModal（无用户延期依据的既定原型功能补齐）；search.query scope=visible；搜索空态
>   EmptyState；成员页全局默认缺模型名提示（startupFailed 根因界面正解：claude 未配 ZS_CLAUDE_MODEL，
>   pre-launch 失败——脱敏只读诊断完成）。
> - **坑**：①bash 内联 python 补丁转义反噬多次（正则/引号）——复杂补丁一律 Write .py 文件执行；
>   ②runDaemonOnce 短命模式不能用于需管道命令的阶段（startDaemon 持久+显式 kill）；③`, token)`
>   全局替换会把 pipeConnect 的 token 参数也剥掉（auth 静默失败表现为「已连接未获 auth.ok」）；
>   ④DOM.setFileInputFiles 在 React 重渲染后节点失效——页内 DataTransfer+File 构造直设 input.files
>   同走 onChange；⑤zip：切回预览标签=WorktreeBody 重挂=重读磁盘（新快照新显示）——「保存读取时
>   快照」语义按挂载期理解，断言应核「落盘==保存时刻显示」而非旧字节；⑥原生 select 展开为系统层
>   不可截图——统一性以收起态+aria/键盘断言。
> - **待续 R68+**：HTML 交互网页（如实不支持）；R64 遗留小项（project.open 响应 rootPath）；多远端
>   upstream 复核；正式 AI 成果（自然交付件）三源阅读的第三源 UI 场景（合同层已覆盖注入）。

## 当前真实状态（2026-10-06 第六十六轮，唯一权威快照）

> R66=桌面前端修复长批次（用户八项反馈+文件-only 决定）。**主交付=desktop-daily-win-v4**
> `bld_bfeb48c4bb82b07b`（commit 6536301，dirty=false，591/591，verify-desktop-daily 全绿）；
> 交互门 `verify-parity-r66.cjs` **全绿**（G1–G8）；视觉门 `visual-pairs-r66.cjs` 10 组同视口
> 成对（1280×800@1）+vision 复核 19/19+重拍 9/9；升级演练 `verify-upgrade-r66.cjs` 全绿
> （**用户 v3 真实数据根全量副本** 46→47+备份+回退+原根 hash 不变）；全量 899/899+双类型门 0 错。
> - **迁移 047=R65 真实遗留缺陷修复**：navigation_preferences.pinned_project_ids_json 列从未被
>   创建——navigation.get 恒抛 no such column→applyServerNavPrefs 恒失败→重开侧栏按空集隐藏
>   （R65 门未察：persistNav 服务端写也同因静默失败，仅 localStorage 镜像生效）。047 后
>   服务端导航偏好/重开侧栏装载恢复正常；persistNav 加「空可见集不落服务端」防首启毒化。
> - **八项反馈全闭**（详见 prototype-parity-matrix-r66-20261006.md）：白屏根因（唯一一处内联
>   filter selector 违反快照稳定）+TitleBarBoundary/MenuBoundary 双层隔离+原型形态项目入口；
>   MD 排版阅读/HTML 隔离页（sandbox=""+CSP+base）/阅读源码切换入实际分支/readFull 全文与
>   64KB 提取窗分列/技术说明入文件信息；DM 320/440/480 降级+列表收起+单区切换（自渲染
>   PreviewPane，挂载判定与布局判定分离——否则首个标签永死锁）；文件-only 发送（body 可空
>   superRefine+标题📎文件名+未知信封完整意图身份比较+图片门空正文 EMPTY_MODEL_INPUT 双端）；
>   导出收 ⋯ 菜单命名「导出会话记录」；恢复三态（启动已有/运行中新增 toast 不弹遮挡/普通排队
>   中性分节）；member.runtime.effective（未绑定→全局默认 ZS_RUNTIME 如实分列）；下载原文件
>   （attachment.originalFile+zs:saveAs 窄桥——路径用户选/renderer 不可指定）。
> - **P4 页面**：成员（卡片+筛选行+绑定弹窗+房间名单+不设假「添加成员」）/搜索收藏/活动/待办/
>   归档（新路由 /archive+设置嵌入，恢复=project.lifecycle/room.archive 真命令——纠正此前
>   「未接入」误标）/看板统一 `.page-filters`+seg+EmptyState+card 外壳。
> - **坑（本轮新增）**：①PreviewPane dlBusy useState 加在早退后=hooks 顺序崩（点附件白屏，
>   ErrorBoundary 吞掉无 console——诊断钩子+Runtime.enable 才现形）；②探针管道直注册不经 UI
>   →需 reload 让注册表装载；③房间派发需 @成员（mentions 空→AUTO→BLOCKED 无 run——G7 首次
>   pending 造不出来）；④outbox pending 会被 worker 即租（lease 不看未来租约）——排队 UI 正例
>   须真实占用 worker（stall 任务 A leased+任务 B pending）；⑤打包 daemon 需 ZS_PACKED_ENTRY=1
>   否则静默 exit 0；⑥CDP eval 响应形态 d.result.result.value（r65 门 resolve(d.result)——
>   自写 makeCdp 勿再踩）；⑦vite dev 绑 ::1——探针需 --host 127.0.0.1。
> - **R66 后续（不阻塞用户使用）**：视觉门数据密度对齐（正式侧目前夹具单项目——manifest 已
>   标注）；HTML 交互网页/搜索「侧栏可见」范围档/添加成员（DEV-10）如实限制；R64 遗留
>   project.open 响应 rootPath 等小项不变。

## 当前真实状态（2026-10-06 第六十五轮，唯一权威快照）

> R65=完整桌面前端逐项检查与修复长任务（用户反馈：项目按钮/属性/添加房间/看板/添加项目有缺陷；
> 不再只修点名三页）。**主交付=desktop-daily-win-v3** `bld_cdc7ef00dabddccd`（commit 368ebf05，
> dirty=false，591/591，verify-desktop-daily 全绿）；交互门 `verify-parity-r65.cjs` **全绿**；
> 全量 894/894+双类型门 0 错。v2/用户数据/草稿/CA 稳定保留。
> - **项目与房间闭环（复核 §1A/§4 反例全闭）**：迁移046（projects.description+navigation.pinned）；
>   daemon 增量 project.list/update(CAS)/lifecycle(archive/unarchive/remove/restore/relocate+未结束守卫)、
>   room.update/archive/members.set、navigation.get/set（服务端导航偏好）；前端=注册表合并不替换
>   （开 B 不丢 A）、TitleBar 项目管理菜单（勾选可见/点名切换/搜索）、侧栏 ⋯（置顶/编辑/主页/成员/
>   设置/归档/移除）+「+」建房（在途锁连点恰一次）、项目主页（挂载聚焦+最近项目+重新定位）、
>   项目设置页（信息 CAS/验收开关/协作限制/归档/全停=board.view→逐任务三重绑定停止）、
>   欢迎页真实注册表+OpenFolderModal 真实 pickFolder 幂等注册。
> - **看板还原**：TasksBoardPage 同源（范围/房间筛选/项目×状态分组/待验收版本/退出未确认标注），
>   数据=board.view 权威聚合（+room_task_number 投影）。
> - **Git 合同级**：branch.list 真 upstream/ahead/behind（null=未知不冒充 0——复核 §1 反例闭）；
>   git.remote.list 真清单；owner 字符串批量暂存不再降级全路径；写动作经交互门 UI 实证（暂存→提交
>   →bare origin 收到推送）+STALE 负对照拒绝。
> - **R64 声明纠正**：visual-gate-r64 不能称「七组同尺寸成对全绿」（4 张原型图+视口不同）——
>   visual-gate-r65/manifest.json 已如实登记；本批新场景成对原型图**待补拍**（不冒充成对）。
> - **坑**：daemon 管道单实例——探针第二客户端 ENOENT（改走渲染进程 window.zs=真实用户路径）；
>   暂存后 s.git 投影 10s 轮询才见提交表单（gate 需等 textarea）；applyServerNavPrefs 无偏好=全量可见；
>   房间状态投影缺 description/revision 曾导致设置无锁（room.list 已补）。
> - **待续 R66+**：视觉门成对原型图补拍（同 CSS 视口/DPR/主题）；活动/搜索收藏/待办/归档管理/DM/
>     成员页原型结构逐页核对（现为功能完整但非原型布局——矩阵 F 节待修不因本批收口）；
>     project.open 响应补 rootPath/canonicalPath；upstream/计数在 remotes 多远端场景复核。

## 前轮快照（2026-10-06 第六十四轮）

> R64=**按已批准原型还原前端**（用户明确拒绝「只学会配色」的简化界面；R63 首用 PASS 收案但
> 原型一致性未过）。**主交付=desktop-daily-win-v2** `bld_33e7c538c32dfa09`（commit 4218a360，
> dirty=false，591/591，verify-desktop-daily 全绿）。完整差异矩阵与施工日志=
> `prototype-parity-matrix-r64-20261006.md`（必读）。用户下次只看三处点名场景（回复串/文件
> 与Git/设置）是否回到原型体验。
> - **架构**：AppState 视图模型=唯一边界（原型页面组件原样移植；loader 水合层把 roomPool/
>   thread 快照→threads/messages/tasks/readStates/subscriptions/taskDeliveries/runs；selectors
>   对未装载线程按卡片兜底）；lib layout/threadNav/panels/actions-nav/actions-preview 原样移植
>   （引用=r61 引用卡+摘录独立+评论=源会话仅记录真实提交）；正式产品零依赖原型模块/seeds/
>   mock-tree。
> - **已还原**：Room.tsx（宽窗 L2 主池+context-thread 并列/房间三页签/线程三视图+详情分组/
>   次级菜单/窄窗/分隔条/L3L4 预览并排——出站账本/停止/验收返工/关注静音/收藏/表情/导出/
>   room.create 全真）；PreviewPane 合并（原型壳+正式渲染体+legacy 桥接）；FilesGitPage（真实
>   目录懒装载 project.files.list+工作区 project.file.read 预览）；GitPage 全真（daemon gitWrite
>   全链接回原型入口）；Settings 七分区（真实=启动项目/主题/runtime 绑定+派发防护/数据根+草稿
>   快照+清理/远程监听/诊断；未接命令禁用说明）；App 壳（原型侧栏+路由表 /project/:id/room/
>   :id?thread=，boot/接管/深链/恢复面板保留，旧 /room=/thread= 归一）。
> - **两门全绿**：交互门 verify-parity-r64.cjs ok=true（real_calls=0/优雅退出/零残留）；视觉门
>   dist/desktop/visual-gate-r64/（原型×正式成对 7 场景+manifest）。全量 894/894+双类型门 0 错。
> - **坑（本轮实证）**：①RoomPage 装载 effect 误插 early-return 之后=重开即崩（Rendered more
>   hooks）；②useStore selector 返回新数组（.filter）=useSyncExternalStore 契约违反整树崩——
>   必须 useMemo；③daemon DTO 无 sha256 于 project.file.read（hash 占位如实）；④git 命令面
>   完整存在（gitWrite 全链）——矩阵初稿误标能力限制；⑤heredoc 长脚本会被截断——用 Write 落
>   .py 再执行。
> - **待续（R65+）**：DM/看板/活动/收藏/归档/项目设置页按矩阵 F 节逐页还原；upstream/ahead/
>   behind/remotes 投影补齐；研讨/运行详情只读投影；v2 用户反馈优先。

## 前轮快照（2026-10-06 第六十三轮）

> R63=日常桌面使用批次（review-r62-next-round 全项；主线转用户日常使用，复用已认证 runtime/
> 配置）。**用户收案**：R1/R2 **PASS 继承不再重测**；Android 除发送失败就地提示缺口外报正常
> （不补造细节，低优先级）；G9 维持 NOT_RUN。**主交付=日常桌面便携包
> `desktop-daily-win-v1`** `bld_b285020fd554bda1`（commit 850240f，dirty=false，591/591，
> 验证全绿 r63-daily-20261006043816，real_calls=0）。用户下一步只有**首次使用检查三步**
> （打开自己的项目/成员配置/仅记录保存一条重开可见）——不再有 G/R 清单。v6 及演练包保留作
> 工程验证形态。
> - **[§1 统一成功清算（review-r62 §2 反例）]** settleOutbound 扩为唯一成功结算源（正文/
>   mentions（payload member/all↔id 串映射）/refs/一次性意图（记录串回 record）/上传项/删账
>   一次写）；Composer 成功分支只读结算结果同步 UI；retryUnknown 成功走同一函数；原型同步
>   分支注明非第二源。反例（发送成功旧 @ 芯片残留）闭拢：浏览器门 18/18。
> - **[§2 主键保全锁定（review-r62 §3 分离负例）]** 隔离写失败（新增键败+覆盖可成）→
>   persistLocked：主键永不覆盖/persistSnapshot 短路/编辑仅内存态/**stageOutbound 拒发**
>   （不冒充已落账）；retryDraftPersistence 恢复路径（释放存储→隔离成功→解锁）。20/20。
> - **[§3 日常配置路径]** MembersPage「配置 runtime」（member.setRuntime：渠道/claude 模型
>   必填/executable/permissionMode；fake 仅环境允许时可选）；保存后回读+**refreshMembers
>   刷新 store.memberRuntimes 投影**（发送区提示即时消失）；Composer 发送区未绑定就地原因+
>   「去成员页配置」直达（AUTO=无已绑定 agent、@ 指派=该成员未绑定）；SettingsPage「数据与
>   草稿存储」（app.identity 数据根/快照健康度四态/recoveryNote/重试按钮）。
> - **[§4 ZS_ALLOW_FAKE 打包形态泄漏修复（验证中发现）]** main.ts 原 `?? '1'` 缺省注入使
>   打包形态永远 fakeAllowed=true——现打包形态仅透传显式设置（dev 保持缺省放开；演练包启动
>   器自设不受影响）。日常包 runtime.status 实证 fakeAllowed=false/realDispatchGuard=false。
> - **[§5 日常包（make-desktop-daily.mjs）]** 同构建门；启动器 ZS_RUNTIME=claude（成员绑定
>   优先解析）、无 ALLOW_FAKE/GUARD/BOOTSTRAP、**不运行 seed 不带 seed/samples**；数据根=包内
>   server-data（稳定、与演练根分清）；README-DAILY（首次三步/数据根/常见情况/工程-日常覆盖
>   边界分列）。验证脚本 8 段全绿（欢迎无 seed 双库证/环境自述/打开实际项目引导执行成员+
>   默认房间/绑定表单 fake 选项不存在+落库回读/未绑定提示绑定后消失/仅记录+草稿跨重开/
>   real_calls=0/零残留）。
> - **[§6 Android 就地提示（低优先级顺手修）]** remoteClient 发送失败就地显示发送区
>   （send-error 行，绑定发起目标切走即清；事件流保留诊断）：空正文校验人话化（'Too small:
>   expected string…'→附件非正文替代，正文仍需≥1 字符）、IMAGE_INPUT_UNVERIFIED 三选项
>   （去图/仅记录/继续文字——**不放开图片能力门**）、服务拒绝；草稿附件一律保留；pending
>   重试同路。文本级核对入库（未做移动端重设计；随之后必要产物带出）。
> - **坑（本轮新增）**：main.ts spawn env 的 ?? 缺省会污染打包形态（环境自述要与形态核对）；
>  日常包验证点击必须断言 find 结果（?.click() 静默 false 掩盖路由未达）；CDP eval 在关窗
>   销毁期超时属预期（以进程归零为准）；members 页渲染等待窗口受首启装载影响（45s）；
>  bat pause=启动器不随窗退（exit 判据以副本进程归零为准）。
> - 全量 **894/894**；主+hifi 双门 0 错。Android DEV25 v6/CA/RESULTS 未动。
## 当前真实状态（2026-10-06 第六十二轮，唯一权威快照）

> R62=复核缺口收口+Git 只读入口批次（review-r61-next-round 全项）。**新基线
> hifi-h4-win-v6** `bld_9f70ef7f6d48ff8d`（commit 4c1888a4，dirty=false，591/591，三连
> allPass r61-20261006034542）。v5 R1/R2 与 Android v6 回填仍未收到——用户仍只需 R1/R2
> 两组（v5 已测则继承）；G9 无自然新回复维持 NOT_RUN。v4/v5/旧包/回填原地保留。
> - **[§1 出站信封账本（review-r61 §2 早崩反例闭拢）]** store 出站账本在**交给 bridge 之前**
>   耐久落盘完整信封（stage=sending；落盘失败=取消发送+内存回滚，不冒充已保存）；三态收口
>   ok=settleOutbound（**先剥已发正文/refs/上传项并持久化、最后删账**——中途崩溃=账本仍在→
>   重载横幅→同号重发幂等→再结算）/failed=drop（草稿保留）/unknown=confirm（转 pendingSends
>   横幅）；重载=账本全转 pendingSends（recovered 标记，人工同号确认，不自动发送不退普通
>   草稿）；Composer 守卫=未确认信封存在且正文逐字未改时阻止换新号发送；retryUnknown 清算
>   改先剥内容后清信封。房间/私信/线程三目标共用。**dev 演练 early-crash-r62 全绿**（账本
>   3ms 落盘/同号恢复/守卫拦截/恰一次）+**交付形态 early-crash-pkg-r62 全绿**（v6 包×真实
>   启动器×丢回执：账本 4ms/崩溃自动重载（文档新鲜度证——bat 管道不透传 stderr）/同号恰
>   一次/参数逐字 status=saved）；r61 崩溃演练复跑无回归；浏览器门 15/15。
> - **[§2 快照防护+TTL（review-r61 §3）]** initDraftPersistence：JSON/版本/逐条字段校验
>   （draft/envelope/upload 三类）——不支持版本/整体损坏=**原件逐字隔离** `<键>.quarantine-
>   <ts>` 后才新空态（v2/损坏 JSON 反例闭拢：不覆写唯一原件不伪正常）；部分损坏=恢复有效
>   条目+隔离+recoveryNote 计数；**普通草稿 updatedAt+24h 过期**（批准 brief §3.3——r61
>   注释「亦无过期」系误写并更正；无戳回退 savedAt）；未确认账本独立无 TTL；过期草稿上传项
>   不复活。测试 10/10（未来版本/损坏/部分损坏/TTL 边界+账本超龄/盖戳）。
> - **[§3 类型门（review-r61 §4 前半）]** 主门 22 错清零：浏览器型测试移入 `tests/browser/`
>   （主门 NodeNext/无DOM 排除；hifi 门 DOM+bundler 纳入并开 allowImportingTsExtensions；
>   vitest include 纳入）——双门 0 错，非移出门外伪绿。
> - **[§4 包验证器聚合门（review-r61 §4）]** aggregatePass 函数化；v5favoritesOk/v5quoteOk
>   纳入总 pass；bat 退出码严格 ===0；收藏断言绑定具体消息 id×saved_refs 行消长×kind/viewer
>   （非全库计数）；引用断言绑定线程草稿+引用卡含 artifact hash 前 8 位+摘录含真实幻灯文本；
>   --self-check-negatives 7 例变异矩阵全捕获（两门 false/bat=7/bat 缺项/门缺项/正对照）。
>   重启轮坑：草稿跨重启保留（合同）→引用判据前须显式清残留正文。
> - **[§5 回退凭据闭环（review-r61 §5）]** upgrade-drill-r62：凭据基线**前置**；演练根
>   ensureServerIdentity 生成 CA/服务证书（纯 fs 不触用户 v6）；升级前/后/恢复根三点 CA 指纹
>   （identity.json **caFingerprint** 字段——坑：不是 fingerprint）+五文件哈希一致；token
>   全程保持；SAN 重签与 CA 更换分列注明。宽模式 Esc 补实际矩形+原生键断言位（v6 演练
>   overall=true 含 wide 位）。
> - **[§6 Git 只读入口（review-r61 §6）]** FilesPage Git 标签新增提交历史（git.history；
>   后端加性 HistoryItem.parents 全列）+提交差异（git.commitDiff(parentOid)）+merge 父选择
>   （parentsMeta 芯片+mergeNote；comparedParent 回显+请求参数回执核对）；独立代次快切
>   防污染；非 Git 目录如实失败。fixture 探针全绿：root/normal/side/--no-ff 双父/binary/
>   截断(2 万行)/超限省略(55 文件>50 上限)；**坑：fixture 目录必须在任意 git 仓库之外**
>   （OUT 在 zhongshuo 仓库内会被当工作树子目录）；spawnSync git 提交中文 message 直接可用。
> - **坑（本轮新增）**：探针 heredoc 反斜杠续坑（用 chr(92)/chr(10) 构造）；electron 探针须
>   await app.whenReady()（r61 靠构建耗时碰运气）；fixture 残留目录删不掉（EPERM）→时间戳
>   唯一目录；打包 DB messages 列=status（record_only→'saved'），无 intent/disposition 列；
>   材料门串要与模板实际文案逐字对齐（'未自动粘贴' vs '不再自动粘贴'）；聚合函数引用 runOnce
>   局部 n 会 ReferenceError（参数化 runNo）。
> - 全量 **889/889**（含 githubSandbox）；主+hifi 双类型门 0 错；v6 Esc 演练 overall=true
>  （toolbar/slide/input/upper-dialog/wide 五位；zoom Ctrl+= frameless 宿主不生效=如实边界）。
## 当前真实状态（2026-10-06 第六十一轮，唯一权威快照）

> R61=用户反馈修复批次（review-r60-next-round 全项，用户 v4 G1–G10 手测反馈优先）。
> **用户结果已回填**：G1/G3/G4/G5/G8/G10 PASS、G2 正常观察、G6 PARTIAL（收藏不能取消）、
> G7 FAIL（Esc+引用）、G9 NOT_RUN（无新回复——不造数据）、Android 仍未回填。
> **新基线=hifi-h4-win-v5** `bld_292768533f1c899c`（commit 978c8527，dirty=false，591/591，
> 三连 allPass r61-20261006023342，real_calls=0）——用户只补 R1 收藏切换/R2 文件引用与 Esc
> （约 5–10 分钟），v4 通过项继承；G9 无自然新回复仍 NOT_RUN。v4 与用户回填原地保留。
> - **[§1 G6 收藏切换]** savedMessageRefs 投影（saved.list→message 类，项目打开刷新）+
>   toggleSavedMessage（已收藏→saved.remove 原内容不动/未收藏→saved.add；同消息在途互斥，
>   连点忽略后到点击；失败如实提示状态不变）；MessageView 书签 aria-pressed+data-zs-saved+
>   填充样式；**无处理器入口不渲染**（表情/引用/追加更正——不以本地日志冒充功能）；DmPage
>   补 onSave/onReact/onQuote；收藏页取消→消息行同步。探针 TG6 全绿（按钮态×DB 双断言/
>   reload/收藏页同步/注入失败/连点）。
> - **[§2 G7 文件引用重做]** 「引用文件」=资源引用卡直写目标草稿 attachments（与上传附件
>   同一正式链路：发送进 attachmentRefs，服务端 audience/完整性/范围/图片门终审）——正文
>   保持用户文字；同文件同版本去重；跨会话写入前拒；成果/详情标签引用直落草稿+zs:focus-
>   composer 自动切回回复（消除「无可见结果/回回复才插入/第三次批量灌入」根因——
>   pendingQuotes 队列删除）；「摘录」独立动作：内容真源由各格式子组件上报（文本/PDF 当前页/
>   Word HTML 文本/表格当前窗口/幻灯当前页），不再从 page-stack DOM 抓取。queueDraftInserts/
>   takeDraftInserts 一次性消费。探针 TG7 全绿（成果页连点两次→恰一卡正文零污染/第三击去重/
>   同名不同文件两卡/移除/发送 refs 落库恰一条/注入丢回执→原信封重发恰一次+只清本次引用/
>   摘录不含「模型输入/原文」界面文案）。
> - **[§3 Esc 查明]** v4 交付副本×随包种子 PPT×CDP 原生键×四焦点位（工具栏/幻灯内容/输入框/
>   上层弹窗）**全部正常退出展开**（键真实到达 __escLog）——用户报告未在交付形态复现；缩放
>   Ctrl+= 在 frameless 宿主不生效（scale 恒 1，如实边界）。**语义补全**：wide 下 Esc 也回
>   normal（用户最可能形态=按了「宽」后按 Esc 无动作）；Esc 永不关预览、上层弹窗优先。
>   v5 副本复跑 overall=true（PPT 视觉页真实装载 1/3 页）。
> - **[§4 附件存储位置无关重定位（新发现缺陷）]** v4 副本演练暴露：种子附件 blob_path 记录
>   打包时绝对路径——**包目录复制/搬移后所有附件预览报「路径越出托管存储」**。修复：
>   readStoreBytes 记录位置不在当前根时按当前存储根 {hash}.{ext} 重定位，realpath/受控句柄/
>   实际字节 sha256 校验全保持（绝不读越出当前根的文件）。storeLinks 4 新测试+attachmentChannels
>   旧断言按新合同更新（外部同 hash 名内容不同→返回当前根内容；当前根缺失→如实不可读）。
> - **[§5 草稿/未知信封持久化（纠正 R60 判据——原报告保留）]** store 持久化层：正文/提及/
>   意图/已就绪引用/完整未知信封（含 queued）随变更快照 localStorage；命名空间=数据根+本地
>   用户（新 app.identity 只读命令）；在途上传不落盘（恢复=重新选择）；removed 不复活；持久化
>   失败内存仍生效+「草稿未持久化」如实提示；未知信封不设 TTL；重载不自动发送、仅记录不变 AI。
>   bootRemembered 在打开项目前初始化。**同内容不重写修复**（真缺陷：重挂载照写草稿把代次+1
>   →重试清算「代次未变」判定失效→已发正文残留）。集成测试 5/5+崩溃演练全绿：回执丢失→
>   完整原信封冻结（含 commandId）→Page.crash→自动重载恢复草稿+仅记录意图+横幅（同号）→
>   重发恰一次+正文剥离+record_only 零新 run（draft-recovery-r61-…021136）。
> - **[§6 G9 工程正例]** M0 合同=任务串人类跟进只记录不派发（followUpRecorded）——真实新
>   agent 回复经正式返工链（task.review changes_requested+task.executeRework 完整身份）产生。
>   TG9 全绿：关注→离开→水位不动→真实新回复→待我处理出现→阅读消失；静音排除（daemon
>   mine.pending 真值+UI 双断言）。夹具坑：task_review_enabled 是项目开关、tasks.review_policy
>   是创建时快照（两者都要设）；task_deliveries 部分唯一索引=每任务仅一条 pending（先置
>   superseded）；reworkPending 派生要求 delivery.run_id 非空。
> - **[§7 回退演练外部资源]** upgrade-drill-r61 阶段 D：blobstore manifest（hash 复算+文件名
>   形态）→恢复根逐文件拷贝完整→恢复库附件实读（previewText）→export.create 含附件
>   missing=0→local.token 不变；边界=旧程序系当前源码+子集迁移形态（含 §4 重定位），真实
>   已发布旧 binary 不代宣布。阶段 A 补：附件挂正式消息（导出含附件前提）。
> - **[§8 性能分项+githubSandbox]** 分层实测：daemon 就绪 179ms / history 2/2/1ms / 桌面 UI
>   454→455ms（各自成行不互相冒充）。githubSandbox 复跑 **5/5 全过**（62s）——R60 唯一失败
>   证实瞬时 TLS 抖动，原报告保留。全量 **879/879**。
> - **坑（本轮新增）**：工具层 heredoc 吃反斜杠（python 字符串 
 变换行——用 chr(92) 构造）；
>   CDP Input.dispatchKeyEvent 带 nativeVirtualKeyCode 会 Invalid parameters（去掉即可）；
>   preview visual-state 是 slide-controls 的**兄弟**节点非子节点（选择器写错=60s 假超时）；
>   waitForJs 用 document.querySelector 只看第一个 chip（some() 才对）；CDP 轮询粒度计入 UI
>   耗时；收藏按钮只在**回复**消息上（锚块不是 MessageView）；打包 daemon localUserId=homedir
>   派生（夹具直插 dm_participants 要用 app.identity 真值）；docx-word-evidence 二进制 fixtures
>   每次全量测试再生成（打包前 git checkout -- 恢复可得 dirty=false）。
## 当前真实状态（2026-10-05 第六十轮收尾批次，唯一权威快照）

> R60=升级/兼容/证据收尾批次（review-r60 全项）：版本门+升级回退演练+renderer 故障注入
> +兼容性能实测+矩阵重核。**桌面手测基线固定 hifi-h4-win-v4**（用户 G1–G10 待执行/待回填，
> Android v6 未收到回填）；本轮改动不影响 G1–G10 任何测试路径——**不交新候选**，r60 修复
> 入库待下次打包（若用户反馈需修复，新候选集中带出）。
> - **[§1 数据库版本门（review-r59 §2 反例 future-schema-result.json）]** migrate() 入口先核
>   fromVersion≤支持上限：更高版本在任何写入前抛 SCHEMA_VERSION_UNSUPPORTED（提示用对应
>   程序或恢复匹配备份）；不降版本号/不删未识别迁移记录；openDatabase 失败路径统一关句柄
>   （entry 既有 catch 释放单实例锁）。schemaVersionGate 4/4：当前库重开零迁移不新建备份；
>   子集前缀（1..44）旧库升级+迁移前 VACUUM INTO 备份恰一份；伪造 v46+记录拒写（版本与
>   记录原样保留+零业务写入+一致复拒+**更旧程序同门**——已升 45 的库不能被子集程序打开）；
>   备份目录不可写=安全拒启动（库未被改动）。已发布迁移 001–045 冻结未动。
> - **[§2 升级/回退演练]** upgrade-drill-r60-…153359 全判据过：阶段 A=旧程序形态（子集迁移）
>   建库+当前命令层 v44 真实写入（project.open[中文+空格]/message.submit/uploadText/task.review
>   +保护事实种子：损坏 probe released+完好 probe released）；阶段 B=打包 daemon 同根启动即迁
>   44→45：迁移前备份恰一份、七类事实逐项保持（身份/消息/线程/附件 blobstore hash/任务/预算
>   标记/审计完整行 SELECT* 逐字）、**045 证据分类器实际生效（坏 probe→retained、好 probe→
>   released 不动）**；阶段 C=回退=旧程序+升级前备份（复制快照至独立 restore-data）——事实与
>   升级前一致+旧程序可继续正式写入+**旧程序直开升级库被版本门拒**；升级 daemon 退出码 0。
> - **[§3 renderer 故障注入+产品修复]** 修复前真实崩溃（CDP Page.crash）留白屏——main.ts 补
>   **render-process-gone→reload**（界面重载、daemon 不重启、任务不重派；clean-exit 不重载；
>   枚举实名 'clean-exit' 非 cleanly-exited——typecheck 拦下笔误）。renderer-crash-r60-…155045
>   全判据过：主进程+daemon（daemon.pid+kill(pid,0) 实证——命令行不含数据根，进程表匹配
>   不可靠）存活、任务 runs 不变、门禁未落、自动重载后项目/会话/历史归属恢复（崩溃前标记
>   可见）、内存草稿如实为空（合同=不跨崩溃恢复）、崩溃后可继续正式写入、优雅关窗退出码 0
>   零残留、real_calls=0。dev 形态真实 Electron（electron.exe --remote-debugging-port+
>   dist/ui/main.cjs——package.json 无 main 字段，electron . 非受支持路径；Chromium 开关须在
>   入口路径之前）。
> - **[§4 兼容/性能实测+产品修复]** 修复 project.open 接受文件路径（discovery/写入后续才坏）
>   ——directoryIdentity 补 isDirectory→PROJECT_MISSING 入口即拒。local-compat-r60-…155927：
>   冷启动 230ms/复用 215ms/daemon RSS 75.7MB；非Git 目录可开；文件/不存在路径→
>   PROJECT_MISSING；icacls 拒写目录如实记录（读侧扫描不写该目录，打开成功）；DM 300 条
>   record_only 369ms+history(limit100) 1–2ms×3；**v4 包内 node.exe+daemon.cjs 在 PATH 剥离至
>   系统最小集下 220ms 就绪**（打包 Node/native 无开发 PATH 依赖）。中文+空格/小窗/长历史/
>   预览/首启复用=继承既有认证不重跑。全量 869/870（唯一失败=githubSandbox 真实网络 TLS 波动
>   ——git ls-remote 可用/curl 000，环境级如实登记）；双 typecheck 0 错。
> - **[§5 验收矩阵重核修订]** final-acceptance-matrix-r59（同文件修订，git 历史留 R59 版）：
>   备份条件（仅待迁移+传目录才产生——目录存在≠回退闭环，回退已由演练实证）；042=只回填
>   NULL 与 043–045=证据降级**分列**；G4=授权上限 33/**实际 30**（$8.6578，3 次保留未用），
>   延期维持不重开；M1 分列（DEV-08/09 既有真实证据/演练包 M0 限制/新界面未接入/价值闸门
>   未结论）；DEV-10 按证据（剩余=resumeSession 真实续接+restrict* 拒写对照，不由 UI 入口
>   位置代替）；**merge 多父 diff=gitWrite.ts parentsMeta+legacy 父选择按钮均已存在**（真实
>   缺口=新界面未接入，非未实现）；用户状态=**v4 待执行/待回填、Android 未收到回填**。
>   每行实际实现/已跑证据/尚未覆盖/外部依赖/下一动作。
> - **[§6 发布准备]** operations-readiness-r60：启动形态×数据根×开关×认证边界四列表；
>   备份/升级/回退**可执行步骤**（回退=旧程序+升级前备份，非旧程序直开升级库；无待迁移不
>   新建备份的如实限制）；安装器（NSIS 双形态，工程 1 轮）/签名（OV≈$200–400/EV≈$300–700
>   每年，需用户采购）/自动更新（electron-updater，依赖签名）方案与成本清单——**待用户
>   决定，本轮不购买不发布**。
> - **[坑（本轮）]** ①package.json 无 main 字段——dev 真实主进程=electron.exe 直跑
>   dist/ui/main.cjs（electron . 非受支持路径）；②Chromium 开关须在入口路径之前（放后=应用
>   参数，端口不监听）；③Page.crash 成功回执即 "Target crashed"；④electron.cmd 经 cmd /c
>   相对路径不可用（绝对路径或直跑 dist/electron.exe）；⑤daemon 存活实证用 daemon.pid+
>   kill(pid,0)（命令行不含数据根）；⑥pipex 上 spawn 的 daemon 就绪可晚于 renderer——管道
>   连接必须带重试窗；⑦旧管道连接关后新实例必须重建 client；⑧conversation.history 为 DM
>   专用（房间=room.pool/thread.history）；⑨bash 内联 node -e 的 $_/反斜杠必被吃——复杂
>   探针一律写文件；⑩Electron 44 枚举='clean-exit'。

## 当前真实状态（2026-10-05 第五十九轮长批次，唯一权威快照）

> R59=版本绑定与证据收紧批次（review-r58 全项）：执行返工完整身份绑定+OS 证据判据收紧+
> 手测依赖修正+验收矩阵准备，交候选 **hifi-h4-win-v4**。v3/用户数据/RESULTS 原地稳定。
> - **[§1 执行返工版本绑定（review-r58 §2 反例 stale-rework-result.json）]** 事实：旧页面
>   只传 taskId，另一路把返工推进到 v2 后，命令默默入队 v2 返工（outbox 2→3）。修复：
>   task.executeRework 参数改为**完整快照**（deliveryId/deliveryRevision/manifestHash/
>   sourceRunId 必填——r58 旧形态=VALIDATION_INVALID 安全拒）；事务内核核对归属+「当前最高
>   版本=该 changes_requested」；旧 v1 引用面对 v2=STALE_REVISION、**零 outbox/run/审计
>   副作用、不自动改绑**。意见正文仍取服务端记录；同号同参重放=网关幂等原回执；就绪/停止/
>   在途/保护/预算守卫不变。reworkPendingOf/conversation.list/task.get 补完整执行身份；
>   DmPage/ThreadPage 点击冻结快照。合同 reworkExecutionContract **5/5**：③两轮自然交付
>   旧引用负例+合法 v2 恰一次（runs 1→3）；④同 revision 错 id（RESOURCE_NOT_FOUND）/错
>   hash/错 sourceRun 归属/错 revision 全拒零副作用；⑤重放幂等不二次入队。
> - **[§1b 探针 r59 27/27]** verify-hifi-h4-r59（r58 基线 26+TDM4）：**页面版本漂移反例**——
>   探针转发层受控延迟 conversation.list 6s 冻结面板渲染（真实机制非 mock）→另一路执行 v1+
>   对 v2 提交新意见→冻结面板点击仍携带 v1 完整身份（sentLog 实证四字段齐备）→服务端 STALE
>   拒绝 toast、零 outbox、任务保持 ACTIVE→解除冻结后面板如实显示 v2 意见B→合法执行 v2→
>   **executing 主标题分列**→自然 v3；跨视图一致性（task.get=REVIEW 与库同源）。返工面板
>   状态分列（recorded/executing data 属性——review-r58 §4 文案收尾：已入队不再称「尚未执行」）。
>   全量 **866/866**；主/hifi 双 typecheck 0 错。
> - **[§2 OS 证据收紧（review-r58 §3 五缺口）]** verify-os-crash-restart-r59：①retained 观察
>   窗口**结束后重读**任务二计数+turn 事实（不查等待前旧值）；②审计前缀**完整事件行**比对
>   （SELECT * 全列 JSON 逐字——payload/关联身份/时间都在内）；③退出码**必须===0**+PID 实际
>   退出实证（kill(pid,0) ESRCH——不再直写 pidReaped）；④失败分支先写报告再按**精确 PID**
>   收拢自 spawn 进程；⑤负对照实跑：`--self-check`（8 项篡改全被集中判据 checkFacts 拒，
>   exit 0）、`--negative-no-release`（真实流程跳过正式解除→恰一次判据拒 3 项+优雅停机
>   +exit 7——总 pass 确会失败）。另记录 daemon.cjs sha256 与候选包内 daemon 对应（v3=
>   R58 源码构建 sameBytes=false 如实）；覆盖边界分列：daemonCrash/pipeDisconnect=covered、
>   rendererCrash/managedSubprocess=NOT covered（声明不扩张）。正式全链 exit 0：
>   os-crash-r59-r59-oscrash-20261005144704（checkErrors 空）。
> - **[§3 手测依赖修正（review-r58 §4）]** 包外补充说明已由评审入库
>   （hifi-h4-v3-user-test-addendum-20261005.md）；make 模板同步吸收：G3 先做到 v2 出现→
>   **G4 借用 v2 确认框**→回 G3 验收收尾；G6 起/至先留空→至=昨天→**清空「至」**→起=今天；
>   G2 看 M0 提示前先移除芯片（不必发送）；G7 引用后切「回复」标签再核输入框；G10 只观察
>   退出不查 PID；单项目当前/全部相同不算失败。
> - **[§4 最终验收矩阵准备稿]** final-acceptance-matrix-r59-20261005.md：旧库升级与副本回退
>   （001→045 保守回填链/backups+独立数据根）、源码与产物对应（构建门/BUILD 身份/591 清单/
>   包根材料门/daemon hash 对应/三连）、能力分列（已认证/仅原界面/未开放）、G5 剩余条件
>   （DEV-10/14/15 尾巴+G4 用户匿名评分+价值评价延期+用户回填待办+兼容矩阵未启动）——
>   只列事实不代记 PASS，无变化认证矩阵不重跑。
> - **[§5 交付 hifi-h4-win-v4]** buildId bld_c4eee31c1f63f0e2（commit 94ccbbd8，dirty=false；
>   591/591+包根材料门 v4 期望全 true）。verify-hifi-package-r59 三连结果：
>   **allPass r59-20261005145035**（run1/2/3 全 pass；首启/复用/重启、重启轮真实恢复流、
>   bat=0×3、real_calls=0×3、优雅停机/PID 归零；包根材料 readmeH4/templateMerged/
>   templateReworkStep 全 true）。v3 已测结论继承——v4 只需补测返工执行相关少量项（G3/G4）。
> - **[坑（本轮）]** ①bash 管道吃退出码（`node x | tail` 后 $? 是 tail 的——负对照核退出码
>   必须重定向后单跑）；②git add 混 2>/dev/null 会吞 pathspec 错误（review 文档实际名
>   review-r58-long-batch）；③候选包 daemon 路径=ZhongshuoDual/resources/app/daemon/。

## 当前真实状态（2026-10-05 第五十八轮长批次，唯一权威快照）

> R58=稳定性收口批次（review-r57 全项）：准入恢复失败防护+返工真实执行闭环+OS 级崩溃重启
> 补证+稳定性收尾+材料修正，交最终候选 **hifi-h4-win-v3**。旧包/用户数据/RESULTS 原地稳定。
> **[R57 覆盖声明纠正（review-r57 §3）]** R57 TDM2 的「第二交付」是夹具手工 INSERT/UPDATE——
> 它只证明「意见记录与新交付可验收」，**不证明**「提交意见后真实续跑」。R58 已废除该注入并
> 重写为真实链；R57 探针/报告原样保留。
> - **[§1 恢复读取失败防护（review-r57 §2）]** restoreAdmissionFromDb 吞错按空账本启动=把
>   未知占用当零（独立反例 restore-read-failure-result.json：注入一次 SELECT 失败后确认继续，
>   同成员新任务 DONE、startTurn=2）。修复：占位 SELECT 失败或行级绑定读失败（部分恢复）
>   均**抛错拒绝启动**（「准入占位恢复失败——拒绝按未核实账本启动派发（重启 daemon 重试）」）；
>   预算/保护/审计事实在库中重读不改写。合同④（memberQueueContractR56）：负例 A/B 库事实
>   零变化；重试成功→占位继承→resume 后零新增（member deferral）→retained 期间零新增→
>   正式解除恰一次（startTurn 1→2，任务一恒 1 run）；makeEnv 补 entry 同款 releaseAdmission
>   进程内联动钩子。
> - **[§2 返工真实执行闭环（review-r57 §3 反例 rework-dispatch-result）]** 事实：task.review
>   只写验收账本（意见入账/任务 ACTIVE/零 outbox——连续泵 false）。新增 **task.executeRework**
>   命令：以**库内** changes_requested 验收事实为源（意见/版本服务端为准、客户端只传任务号），
>   沿 task.redispatch 同守卫栈（就绪/在途/停止代次/幂等）与同键命名空间
>   `task:<id>:redispatch:<sourceRunId>` 入队；负例全拒（重复=IDEMPOTENCY_CONFLICT、待新
>   交付/终态=STALE）；domain_events 记 task.reworkEnqueued。**assembleDmTurn 补
>   reviewFeedback 附注**（此前 DM 返工 turn 输入不含意见=无反馈重跑——仅房间路径渲染）。
>   **reworkPendingOf** 派生「意见已记录、尚未执行/已入队」（conversation.list+task.get 暴露；
>   DmPage/ThreadPage 面板+执行返工按钮+toast 文案纠正）。合同 reworkExecutionContract 2/2：
>   DM 全链（意见→泵 false×2→执行→同 task 新 run 且**模型输入含【返工】注记+意见原文+v1
>   版本号**→v2 自然产生（revision 递增、v1 验收记录保留不涂改）→验收 DONE；终态后执行=
>   STALE）+负例（待验收/无返工事实拒）。探针 TDM2 重写（r58）：页面提交意见→「尚未执行」
>   面板→**显式执行**→同 task runs 1→2→v2 自然上屏→验收 DONE——零 INSERT/UPDATE。
> - **[§3 OS 级崩溃重启补证（review-r57 §6-2）]** verify-os-crash-restart-r58.cjs：**真实进程**
>   （dist/pack/daemon.cjs 打包形态）独立数据根+独立管道名；ZS_FAKE_STALL_MS 受控在途→
>   按精确 PID taskkill /F（只操作自 spawn 进程）→重启后 recovery.status 核：门禁 held+旧
>   turn UNKNOWN（命令+直读库双核）→**dispatch.resume 后同成员任务二零新增**（member
>   deferral 留证）→对账 FAILED+refunded+retained 期间零新增→正式解除→恰一次（t2 恰 1
>   run/1 turn，t1 恒 1 run）→domain_events 崩溃前前缀**逐字保留**→renderer 断连/daemon
>   故障分列（客户端关闭后 daemon 存活、事实不变、可重连）→优雅停机退出码 0→real_calls=0。
>   证据 dist/desktop/os-crash-r58-r58-oscrash-20261005134222/result.json 全断言通过。
> - **[§4 稳定性收尾（review-r57 §6-3/4）]** ①DmPage.submitReview 补 try/finally——成功路径
>   reloadAll 抛错曾把 busy 永久卡 'review'（探针实证：执行返工按钮禁用、命令零发出——
>   「不锁死操作忙态」）；②首启后台观察器增加 openInFlight 让位（打开在途时 activeProjectId
>   尚未落位——观察器抢代次会覆盖用户选择；openProjectByPath 入口置位、按代次条件清除）；
>   ③pickAndOpenFolder 失败只在无项目时降级 boot=failed（已有项目保持可用）；④DM 读取失败
>   面板+重试按钮。探针 r58（r57 基线 25+TZ 预览连续开关×3/无叠加/关闭后 Ctrl+K 全局键存活）
>   **26/26 PASS**；全量 **863/863**（含新增 3 项）；主/hifi 双 typecheck 0 错。
> - **[§5 材料修正（review-r57 §4）]** 根因=R57 打包显式 outArg 复用 R56 目录+writeIfAbsent
>   跳过已存在 README/模板→旧材料进新包。修复：README-H*改**总是写当前版**（工程件无用户
>   回填；writeCurrent）；RESULTS 模板保持不覆盖（用户回填就填在模板上）。README-H4=v3 口径
>   （返工两步走）；**H4-TEST-template 重写为 G1–G10 合并清单**（H3-v2 未回填项+H4 新操作一次
>   短测，约 20–25 分钟；G3=返工显式执行步骤）。verify-hifi-package-r58 新增**包根材料门**
>   （README/template 关键词核验，独立于应用 591 清单；不一致退出码 5 拒绝三连——首轮即
>   拦下期望串笔误，门有效）。
> - **[§6 交付 hifi-h4-win-v3]** buildId bld_1f8807e36da4d3af（591/591+包根材料门）。
>   verify-hifi-package-r58 三连结果：**allPass r58-20261005140403**（run1/2/3 全 pass；首启/
>   复用/重启三形态、重启轮真实恢复流、优雅停机/PID 归零/bat=0、real_calls=0×3；包根材料
>   门 readmeH4/templateMerged/templateReworkStep 全 true）。
> - **[坑（本轮）]** ①探针点按钮必须先等 disabled=false（忙态卡死+toast 替换双重教训）；
>   ②recovery.status 字段=gateHeld/pendingDispatchCount（非 held/pending）；③daemon 信封
>   commandId≥8 字符；④Esc 要派发在 document.activeElement 上；⑤预览 Esc 只退展开不关面板
>   （关闭=按钮）；⑥验证器材料门期望串须与源码文案逐字对齐（不自动执行≠不会自动执行）。

## 当前真实状态（2026-10-05 第五十七轮长批次）

> R56=H4-v1；**R57=复误收口批次**：恢复准入继承（P1 缺口）+DM 返工正式链+跨会话操作框
> +面板 DTO+首启欢迎，交独立候选 **hifi-h4-win-v2**。旧包/用户数据/RESULTS 原地稳定。
> **[R56 结论纠正（review-r56 §2）]** R56 的「跨重启同成员保护已核清」声明**不成立**——独立
> 复核 queue-retained-result.json 证实：UNKNOWN+retained 旧 turn 下 dispatch.resume 后
> 新 worker（空 admission 内存）照常派发同成员另一任务（startTurn=2）。R56 测试②当时把该
> 行为当正例，恰好漏掉此层。R57 已修复并重写合同测试；R56 历史报告原样保留。
> - **[§1 恢复准入继承（review-r56 §2）]** `DispatchAdmission.restore(turnId,dims)`+DispatchWorker
>   **构造器**按持久事实恢复占位（UNKNOWN / protection_state='retained' / 非终态在途——
>   恢复不查限额：既成占用如实）；`releaseAdmission`/`reconcileRelease` 增加 **retained 门控**
>   （notStarted→FAILED+refunded 但 retained 期间继续占用；recovery.releaseProtection 解除后
>   经同钩子放行）。memberQueueContractR56 ②重写：dispatch.resume 后同成员**零新增
>   startTurn**（文件库关闭重开+全新 worker 双重证明——同进程共享 adapter 连续计数）→
>   notStarted 对账（FAILED+refunded+retained）继续占用 → 正式解除（no-os-process 服务端
>   证据）后**恰一次**续跑+任务一零新 run。**声明边界**：fresh-worker+恢复库状态模拟（进程内
>   文件库重开），非真实 OS 崩溃重启——后者留待后续批次补证。三个旧测试文件按新合同更新：
>   stopIntentGeneration/boardFormalStates 的「停止结算」（settleStop/恢复后跟进）补
>   recovery.reconcile executed 收口（确认继续≠退出证明，对账后才派发）；lateOutcomePath
>   并行 UNKNOWN 构造改用不同成员（mA/mB/mC 真实派发）。**860/860+主/hifi 双 typecheck 0 错**
>   （R56 的主 typecheck 4 错已随测试重写消除——此前「双干净」声明不实，已纠正）。
> - **[§2 DM 返工正式链（review-r56 §3）]** 旧实现返工传 `reviewComment`（服务端只收 `note`
>   →VALIDATION_INVALID 恒拒）。改为复用 `submitTaskReview` 适配器（note 字段）；失败原因
>   准确呈现+**意见文本保留**可修正重提（不再一律「交付可能更新」丢文本；真更版才作废）。
>   探针 TDM2 全链：返工意见入 domain_events（note 原文可查）→任务回 ACTIVE→新交付 v2
>   （fixture 注入+任务回 REVIEW）→再次验收 DONE。
> - **[§3 跨会话操作框（review-r56 §4）]** DmPage 重命名/验收框捕获**目标快照**
>   （conversationId+revision / 三重身份），切会话 effect 即作废+提交前双核对=零提交；
>   作废判定按**完整身份**（同 revision 不同交付也作废）+作废框可关闭重开。ThreadPage 验收框
>   同判（threadId 绑定+manifestHash 全比较+切线程作废）。探针 TDM3 双侧 DB 反例：A 开验收框+
>   重命名框→切 B→两框消失+**task.review/conversation.rename 命令零发出**+A/B 状态与标题两侧
>   DB 不变（不止断言弹框消失）。
> - **[§4 面板 DTO+失败反馈（review-r56 §5）]** 任务项 hint 映射 board.view 真实
>   taskStatus/runStatus 中文（探针断言无 undefined）；board.view 聚合失败显示错误行（不冒充
>   零任务）；locate 失败 toast 明确反馈（旧注释「全局 toast」不实已改）。
> - **[§5 首启（review-r56 §6.1/6.2）]** bootRemembered 成功读到**空记忆**=立即 boot ready+
>   欢迎面板（data-zs-welcome——探针 TW1：0ms 出现、侧栏无「失败」字样）；**演练包竞态兜底**：
>   欢迎态下 150s 有界后台观察（种子晚写 autoOpen 时自动进入，真实新装环境自然结束不冒充）；
>   记忆路径失效与未就绪分列（真实原因+可操作；不再被外层 catch 归类「连接中」空转）。侧栏
>   常驻「打开/切换项目」入口（folder 图标）。
> - **[§6 探针 r57 25 段 pass]** verify-hifi-h4-r57.cjs（r56 基线 22+TW1 欢迎/TPA 状态核/
>   TDM2 返工链/TDM3 跨会话反例）；**TA 时序修复**（v5 审计失败根因=fake turn 异步收口与夹具
>   UPDATE/INSERT 竞态——新增 untilTaskSettled 等真实终态后再注入，r0/r1 双夹具）；新截图
>   视觉 PASS（欢迎/跨会话两张）。产物 dist/desktop/review-r57/。
> - **[§7 交付 hifi-h4-win-v2]** buildId bld_cbd9f0c1cba4e22b（591/591）；README-H4 v2 短测
>   指南重写（具体前置：H3=「+Guide A 新建空闲会话」避免种子忙碌链、H7 关注未读需**离开后**
>   新回复且无回复=NOT_RUN、H8 日期区分截止昨天/今天+关闭放最后）。**verify-hifi-package-r57
>   三连 allPass r57-20261005121618**（首启/复用/重启——重启轮按真实恢复流：逐 UNKNOWN 对账
>   executed/no-os-process→确认继续派发→同成员排队意图按合同继续 runs≥1；bat=0×3、
>   real_calls=0×3、优雅停机/PID 归零/身份不变）。**过程记录（失败保留）**：候选一
>   bld_69c05a8bd26416f9 因欢迎分支终止 bootRemembered 使「窗口先于种子」竞态下永不入项目
>   （run1 失败 r57-20261005115629）；候选二 bld_cbd9f0c1cba4e22b 首验 run2/3
>   roomDispatch runs=0——**准入继承正确扣住重启后同成员派发**（r57-20261005120231），
>   验证器补真实恢复流后三连全过。另：验证器 procsOfCopy 守卫会误匹配**本会话 shell**
>   ——排除 bash.exe/cmd.exe（包只跑 bat/electron/node）。
> - **[坑（本轮）]** ①python 直写大文件碰 CRLF/引号嵌套易碎（lateOutcomePath seed 曾错序
>   FK+语法错——改用 Read+Edit 精准段）；②验证器 guard 自匹配会话 shell（见上）；③fixture
>   必须等真实 worker 终态再注入（untilTaskSettled）；④TDM2 返工后注新交付需同时把任务
>   回 REVIEW（pendingReview 只看 REVIEW 态）。
> - **[待办（R58）]** 用户 hifi-h4-win-v2 集中短测（README-H4 v2 H1–H8）收案；**真实 OS 崩溃
>   重启**的准入继承补证（进程树级）；多尺寸/缩放截图对照补充；G4/DEV-10/11/并行写入/价值
>   评价延期保持；Android v6 独立。

## 上一轮快照（2026-10-05 第五十六轮长批次，唯一权威快照）

> R55=反馈合并修复+三页归位+hifi-h3-win-v2；**R56=H4 收口长批次**：两确认缺陷修复+同成员排队
> 合同核清+命令面板/恢复界面/H4 外围+日常操作归位+独立候选 **hifi-h4-win-v1**。旧包
> （H2-v2/v6/H3-v1/H3-v2）与用户数据原地稳定；Android 用 v6。能力↔入口↔状态对应清单见
> `hifi-capability-map-r56-20261005.md`。
> - **[§1 两确认缺陷（review-r55 §2）]** ①搜索清空倒灌：runSearch 对空关键词/无效范围**先作废
>   在途代次**（genRef++）再 return——迟到旧响应不再写屏，同时清结果/错误/加载态；②收藏
>   「当前项目」范围：按收藏行 projectId 过滤生效；链接收藏（无项目关联）给「复制链接」动
>   作+计数说明（收窄时不静默消失）。
> - **[§2 同成员排队合同核清（review-r55 §3，换种子成员不能替代）]** 新增
>   `tests/integration/memberQueueContractR56.test.ts`（**受控短暂忙碌 600ms，不增并行/不绕
>   租约**）：①同 Agent 两房间任务——忙时第二项 `run.admissionDeferred{reason:'member'}` 留证
>   +outbox 回 pending+零 run/turn+startTurn 恰 1（真实等待非沉默）；释放后同 worker 领取续跑
>   （恰 2 次、两键各 done 一次、再泵零新增）；②「崩溃」重启（applyRecovery 同款）——在途
>   turn→UNKNOWN/run→INTERRUPTED/门禁落下，门禁期新 worker runOnce 返回 false 零领取，
>   `dispatch.resume{confirm:true}` 后排队意图继续，`task.redispatch` 对未对账旧意图按
>   RECONCILE 拒（不复活），UNKNOWN 不在派发路径改写；③同 DM 连续消息串行+恰一次入库。**机制
>   结论**：成员串行=DispatchAdmission 进程内存（生产单 worker 实例）；跨重启保护=UNKNOWN+
>   门禁+对账（不靠 admission 记忆）——r55 的「永久挂起」实为停机落停滞窗留 UNKNOWN→恢复
>   门禁等用户确认（合同行为），非排队缺陷；测试曾用「新 worker 实例」模拟重启反而绕开了
>   admission——以生产单实例+applyRecovery 组合验证为准。
> - **[§3 命令面板+快捷键]** 复用原型布局，正式数据：页面动作+房间/私信/成员（store）+任务
>   （board.view scope=all）+消息/线程（search.query 防抖 260ms，清空作废在途）；↑↓/Enter/Esc，
>   IME 组合态不触发（compositionStart/End+isComposing 双门）；Ctrl+K 仅 hifi 可见响应
>   （legacy-on 守卫）；**面板只导航/定位**（locate 深链），不承担确认执行/验收/解除保护。
> - **[§4 恢复检查界面]** recovery.status 只读事实（门禁+排队键/UNKNOWN turn 明细/待解除保护
>   retained/中断 run/未收口撤销/租约/上次停止记录）四类动作**分列**：确认继续=dispatch.resume
>   {confirm:true}（不接受空参）、对账=recovery.reconcile（verdict+note 必填+notStarted 风险
>   确认——租约保留）、解除保护=recovery.releaseProtection（服务端取证拒活体）、定位=深链；
>   侧栏常驻入口+有注意项首启自动弹一次（每启动一次）；中断恢复执行（task.redispatch）留在
>   任务自身上下文与对账分离。探针 TRC 全链（fabricated 崩溃→门禁→notStarted 对账 turn
>   FAILED→确认继续 gate open）。
> - **[§5 日常操作归位]** ①DM 头部操作行（重命名 revision CAS/归档恢复/停止三重绑定/继续队列
>   dm.resume 泵一条/待验收返工三重身份冻结框/中断恢复绑来源 run+不可恢复原因/导出
>   MD·HTML·DOCX+openPath exports 白名单开目录）；②线程关注/静音（thread.subscribe 人的阅读
>   订阅）+消息引用插入草稿（insertText）+表情 message.react toggle+导出 MD/DOCX；③预览
>   窄/宽(880px)/全屏展开（Esc 退出、面板/恢复弹窗打开时让位）+「引用到输入框」（按当前路由
>   定草稿键+固定版本+可见摘录，无输入页如实提示）；④搜索补作者/日期窗/会话筛选
>   （search.query 参数一一对应）+长历史定位补读（thread.history beforeSeq 每轮 100 至多 5 轮
>   ——**发现并修复：5s 刷新整表替换会冲掉补读历史，loadThread 改按 id 合并+seq 排序**）；
>   ⑤标题栏防护标识（runtime.status 扩 dispatchGuard 只读自述：fakeAllowed/realDispatchGuard
>   →「演练·模拟派发/真实派发」徽章 data-zs-dispatch-guard）。
> - **[§6 交付 hifi-h4-win-v1]** buildId bld_9505e0b4e980e83c（591/591）；范围=H3-v2 全部+本批
>   全部（README-H4+H4-TEST-template 入 make 脚本与白名单）。**探针 verify-hifi-h4-r56.cjs
>   22/22 pass**（r55 基线 15+TGU 防护标识/TPA 面板四态/TLS 筛选含确定性负例/TLL 补读定位/
>   TTH 关注静音引用表情/TDM 重命名→验收→导出→归档恢复全链/TRC 恢复全链/T8 宽度展开引用）；
>   全量 **857/857+3**（新增 memberQueueContractR56）+typecheck×2；视觉核验：13 张 PASS
>   （恢复弹窗截图=对账后 retained+解除保护状态——合同正确的分列中间态；设置双反斜杠=探针
>   夹具写入字面值非产品问题）。**verify-hifi-package-r56.cjs 三次运行 allPass
>   r56-20261005102739**（首启/复用/重启分列，在 r55 全链上新增：防护标识/面板开-选-关/
>   恢复入口；real_calls=0、优雅停机、run2/3 重启历史）。
> - **[坑（本轮）]** ①**probe 的 daemon.command 返回原始 envelope**（{ok,data}——不自动解包
>   ；conversation.create 取 conversationId 要 .data）；②toast 会顶掉前一条——验收 toast 出现
>   ≠busy 复位（finally 在 reloadAll 后）——探针等按钮 disabled=false 再点；③CompositionEvent/
>   Escape 须派发在焦点元素（window 派发到不了 React 目标）；④Electron probe 焦点键顺序：
>   palette 打开后 activeElement=输入框；⑤loadThread 整表替换冲掉补读（已改合并）；
>   ⑥TLL 目标要排除锚消息（锚块 id 同为 msg-<id>，初始可见≠补读证明）。
> - **[待办（R57）]** 用户 hifi-h4-win-v1 集中短测（README-H4 H1–H8，约 15–20 分钟；旧项不重测）
>   ；收到反馈优先处理实际失败。余项：原型设置/成员视觉细化、多尺寸/缩放截图对照补充（本轮
>   以 1440×900+900×620 为主）、G4/DEV-10/11/并行写入/价值评价按既定延期；Android v6 独立。

## 上一轮快照（2026-10-05 第五十五轮，唯一权威快照）

> R54=无边框标题栏+H3 收尾+hifi-h3-win-v1；**R55=合并用户短测反馈修复（T2 完整版/T4 发送前
> 提示/设置显示同步/附件呈现）+搜索与收藏/活动流/线程成果标签三处归位+独立候选
> hifi-h3-win-v2**。H2-v2/v6/v1/H3-v1 原地稳定（不重建）；Android 用 v6。
> - **[§1 T2 完整修复（页面级复证过）]** 旧正则只覆盖行首/空白后的末尾 @（用户实测「整理任务
>   要点@」中文紧邻残留）。新实现**按触发位置消费**：`mentionTrigger={index,draftKey}` 在
>   detectMentionTrigger（**光标前一位是 @** 即开候选并记下标——不再只认正文末尾）时记录；
>   insertMention 只删该下标处仍为 @ 的那一个字符；工具栏 @ 打开=null（选人不动正文）；Esc=
>   取消（保留 @）；IME 组合中不触发（composingRef 早退）、组合结束重判；切草稿/引用插入/
>   insertText 都清触发；正文其它 @/邮箱永不被全局替换。探针 TM 五例全过（中文邻接/工具栏/
>   Esc/IME 组合中关+结束开/邮箱不触发）；**包级**（真 app bundle）同样复证（t2m0Real）。
> - **[§2 T4 发送前提示（不开放 AUTO）]** M0 边界保持（mode_unavailable_in_m0 服务端合同不
>   动）；UI 在 room_root+ai+**route.mode≠DIRECT**（AUTO 未指派 / DELIBERATE 全体·多人）时
>   输入区上方常驻提示（`data-zs-m0-hint`，文案=服务端同款「M0 模式下房间任务需 @ 指定成员
>   （AUTO/DELIBERATE 未开放）——发送后任务会立即受阻」）+「@ 指定成员」「本次仅记录」两个
>   动作；**不禁发送、不静默改目标**；DIRECT 后提示消失、移除指派回来（探针 TH 三态全过）。
> - **[§3 附件呈现三修]** ①线程锚消息（根消息）附件芯片 kind 标签复用 MessageView 的
>   ATTACHMENT_KIND_LABEL（导出共享——此前只认 code/text，PPT/CSV 显示成「文本」）；
>   ②**预览头真实身份**：PreviewPane 新增 identity 状态，各格式子组件取到数据后上报
>   revision/hash，头部优先用上报值（已发消息无 hint 打开也显示 v1/sha256 真值，不再 v?/空
>   hash——探针 TA 断言头部含 v1 且无 v?/sha256=…）；③过期「R52」文案清除（ThreadPage 占位
>   按钮与 LEGACY_SECTIONS 重写——成果标签成真）。
> - **[§4 设置显示同步+标题栏断连]** saveSetting 成功回读后**当场更新对应控件**
>   （repoStatus.visible→setRepoVisible——此前只写库不更新页面，按钮/「当前」文字停旧值需手
>   动刷新，用户短测确认）；探针 TS 双向（显示→当前：显示+按钮互换；隐藏→复原）+库里
>   true/false 全过。标题栏连接态：store 新增 conn/connInfo，main.tsx 注册 zs.onDisconnect/
>   onReconnected（main 进程管道关闭/重连推送——既有事件，hifi 此前零消费，首启 ready 永远
>   「已连接」）；TitleBar 断线=「已断开——重连中」红点 data-zs-conn=offline，重连恢复（探针
>   TC 注入事件验证）；浏览器宿主收不到事件保持缺省（不假装）。
> - **[§5 review-r54 §5 收尾]** PendingPage 范围显式分列（默认**全部可访问项目**=§17.7 旧判，
>   「当前项目」为显式收窄+省略说明——此前静默 filter 当前项目，其它项目待办无提示消失）；
>   提醒行 key+确认忙锁=**occurrence 身份**（reminderId+scheduledAt——同提醒多项待确认分别
>   可见/可锁）；MembersPage runtime 四态分列（查询失败（留上次事实+原因）≠未绑定≠已绑定·
>   安装缺失≠正常——**installationId=null 不再显示「已绑定」**；房间名单失败≠装载中）。
> - **[§6 三处归位（真实接线）]** ①**LibraryPage 搜索与收藏**（/library，侧栏入口替换 legacy
>   项）：search.query（范围 当前项目/全部可访问项目、类型过滤、分页——附件随所在消息检索
>   如实注明；结果行=正式 locate 深链，「定位 ↗」可视提示）+saved.list（missing/forbidden
>   如实、取消收藏 saved.remove 原内容不动）+**线程回复书签→saved.add**（幂等，ThreadPage
>   onSave 接线）；②**ActivityPage 活动流**（/activity）：activity.list（默认全部可访问项目）
>   (created_at,seq) 双键游标「加载更早」、定位分列（task→#task= 服务端解析/DM→#dm=/房间无
>   任务→本地房间导航——**#conv= 不在深链族不用**、空 id locate 按长度过滤）；③**ThreadPage
>   「成果与附件」真标签**（替换 R52 占位）：会话附件=attachment.listByConversation（带真实
>   v/hash→预览头同源）+本任务交付=files.view 按 taskId 过滤（v2 待验收等）；「查看成果与
>   附件」从详情可达。**daemon 活动流 kindLabel 映射补全**（视觉核对发现 12/14 英文原键——
>   补 task.statusChanged/turn.statusChanged/run.created/thread.created 等约 30 条，纯显示层，
>   DTO 形状不变）。
> - **[§7 H3 短测前置（review-r54 §6）]** ①**种子房间任务卡**：seed-client.cjs regression 段
>   新增幂等种子（member.list 房间名单取**非 agents[0]** 的启用 agent=Guide B→message.submit
>   mentions=[{kind:'member',memberId}]——**必须是对象形状**，纯 id 串会被 discriminatedUnion
>   拒；只等线程出现（≤20s）不等终态；无合适成员=skipped 如实）；README-H3 v2：H1 **关闭放
>   最后一步**、H2 直接点种子卡（R55 短回归·看板房间任务样本）不需自建、H5 无待确认提醒记
>   NOT_RUN、H6 用「显示仓库状态」开关测保存回读（可恢复）+不要求填任意路径、结果明确填
>   **H3-TEST-template.md**。
> - **[§8 交付 hifi-h3-win-v2]** buildId bld_4658299eb53861b8（清单 591/591）；范围=H3-v1 全部
>   +本轮修复与三新页+种子任务卡（README-H3 列明）。verify-hifi-h3-r55.cjs **15/15 pass**
>   （T1 标题栏/TC 断连重连/T2 缩放/TM 提及五例/TH M0 提示三态/T3 成员/TP 待办范围/T5 设置
>   同步/T6 Files+Git/T7 看板 scope=all/TA 成果+预览头身份/TL 搜索收藏全链（saved.add→列表→
>   remove→原消息在）/TY 活动流/T8 预览 38px/T9 legacy；截图×10+原型×5 于 review-r55/，视觉
>   核验 PASS——首轮两 warn 已修：活动流中文映射、搜索行「定位 ↗」提示）。全量 **857/857**
>   +typecheck×2。**verify-hifi-package-r55.cjs 双轮 allPass（r55-20261005090723）**（在 r54
>   全链上新增：种子任务卡在板、真包 T2/M0 复证、搜索命中、活动流条目；run2 重启历史）。
> - **[证据/坑（本轮）]** 探针坑：**CompositionEvent 不冒泡=React onCompositionStart 收不到**
>   （组合态守卫假失败——bubbles:true 修复）；cpSync 参数序（recursive 是 options 不是目标）；
>   r54 复制时漏带第二无交付任务夹具/已补。**包验证坑（最重要）**：bat 的
>   ZS_FAKE_STALL_MS=60000 让每个 fake turn 先停 60s——种子房间任务若给 agents[0]（=恢复/远程
>   演练 owner+UI 短测 @Guide A 派发对象），其停滞 turn 会**按成员级互斥挂起同成员后续派发**
>   （验证器自己的派发 OPEN 永不领取），停机再落在停滞窗内还留下 UNKNOWN turn（run2 起被恢复
>   守卫按成员持有——outbox 永久 pending）。修复=种子选非 agents[0] 成员+不等终态（任务在种子
>   退出后 ~60s 自行 REVIEW）。诊断路径：outbox 表 pending 行+agent_turns UNKNOWN+workflow_runs
>   INTERRUPTED 三件套=成员持有。UI 坑：LibraryPage 搜索结果整卡可点但无可视提示（视觉核验
>   抓到——补「定位 ↗」）。
> - **[证据/坑（本轮）]** 探针坑：**CompositionEvent 不冒泡=React onCompositionStart 收不到**
>   （组合态守卫假失败——bubbles:true 修复）；cpSync 参数序（recursive 是 options 不是目标）；
>   r54 复制时漏带第二无交付任务夹具/已补。UI 坑：portal 静态（沿用）；LibraryPage 搜索结果
>   整卡可点但无可视提示（视觉核验抓到——补「定位 ↗」）。
> - **[用户手测状态]** H2-v2 七项已测（T2 修复入 v2 待用户顺手复证——探针已页面级+真包双证）；
>   **hifi-h3-win-v2 待一次集中短测**（README-H3 H1–H6 新六项，约 10–15 分钟；H2 七项与 H3-v1
>   六项不重测）。收到结果优先处理实际失败，不重复旧验收；用户结果不代记 PASS。
> - **[待办（R56）]** 用户 H3-v2 短测结果收案；原型设置/成员页视觉细化余项；G4 用户评分、
>   DEV-10/DEV-11、并行写入、价值评价与 G5 按既定延期；Android 继续 v6 独立推进。

## 上一轮快照（2026-10-05 第五十四轮，唯一权威快照）

> R53=三 P1 修复+h2-win-v2（复核确认收口，**用户集中短测进行中、结果未回填——不代记 PASS**）；
> **R54=无边框标题栏+H3 收尾+hifi-h3-win-v1 独立候选**。H2-v2/v6/v1 原地稳定；Android 用 v6。
> - **[§2 范围分清（复核 §2）]** H2-v2 的 renderer **不含** H3 三页/标题栏（其 T7 与该版本相
>   符）；H3 源码推进+截图材料=「源码已接入、随 hifi-h3-win-v1 交付」，不并称已随 H2-v2 发给
>   用户。
> - **[§3 无边框标题栏]** 主窗 frame:false（--no-hifi 保留原生框对照）；**窄 IPC zs:window**
>   （枚举动作+assertTrustedSender 同判+只作用可信主窗+状态推送 zs:window-state）；preload 暴露
>   zsWindow；关闭=标题栏关闭键→win.close()→window-all-closed→shutdownDaemon **既有优雅链**
>   （无 app.exit 绕过）。标题栏=**#zs-titlebar 独立挂载点**（index.html，在 #hifi-root/
>   #legacy-root 之外——legacy 接管不隐藏、样式由 hifi-flag.js 注入 <style data-zs-titlebar>
>   承担不随 app.css 禁用）；hifi-flag 先装**最小壳**（React 失败/看门狗兜底可重建——
>   __zsTitlebarMinimal），React TitleBar 经 portal 挂载后移除非 React 兄弟（portal 不清容器）。
>   状态行只用真实事实：项目名+daemon 连接态（boot）——原型种子计数不接。布局偏移：
>   body.zs-frameless 下 hifi-root/#app 下移 38px、preview-pane/.zs-legacy-exit 让位。
> - **[§4 H3 收尾]** MembersPage（member.list 项目/房间两级+coordinatorMemberId——**daemon
>   room.list DTO 补该字段**；setEnabled 往返+协调者正式链拒绝如实；member.runtime 绑定/认证
>   分列）、PendingPage（mine.pending 权威汇总：待验收三重身份/无交付如实禁用+定位**与验收
>   分离**/未读/阻塞/**待确认提醒确认执行**=reminder.confirm 正式链 occurrence→dispatched）、
>   SettingsPage 重组（应用/项目分区+「启动时打开的项目」「显示仓库状态」用户名称+**保存回读
>   核对**+诊断信息折叠层放工程键）、FilesPage（项目文本=**project.file.read 只读快照**；Git
>   标签 patch 全事实 change/stat binary·unknown/renamed/truncated/source/filesOmitted+
>   显示区截断显式标注+「在原界面执行 Git 操作」**直达按钮**）、BoardPage（范围 当前/全部
>   可访问项目+visibleProjectIds 合同）。全部页面**请求代次收口**（genRef——迟到响应不污染）。
> - **[§4 布局对照]** 原型同窗对照（hifi-prototype/dist 经本机 http 同尺寸截图 proto-tasks/
>   members/settings）：视觉核验结论=**同一布局语言/同一信息架构**（侧栏 IA 逐项对应、页面
>   头部三段式同构、密度正常）；可接受简化（看板一级范围选择/成员页无添加成员/38px 桌面壳）
>   已记录；原型截图含恢复检查模态遮挡两处（对照局限如实）。
> - **[§5 交付]** **hifi-h3-win-v1**（buildId bld_2e3982c95dba211f，591/591；README-H3+H3 模板
>   入 make 脚本与包；make 用户回填白名单补 H3 模板名）。verify-hifi-package-r54.cjs 双轮
>   allPass（在 r53 全链上新增：标题栏 React 版三键/拖动区/38px 偏移/真窄 IPC、**关闭走标题栏
>   关闭键→优雅停机链**、看板页 board.view 真内容；run2 重启历史）。h3 探针
>   verify-hifi-h3-r54.cjs **pass=true**（T1 标题栏+zsWindow 桩/T2 900×620 缩放/T3 成员往返+协调
>   者拒/T4 待办定位+确认执行 dispatched/T5 设置保存回读/T6 快照+Git 事实+直达/T7 scope=all/
>   T8 preview-pane top=38/T9 legacy 接管标题栏仍在+⌂可回；截图×6+原型×3 于 review-r54/）。
> - **[证据]** 全量 **857/857**、typecheck×2；**坑（本轮）**：bash heredoc 再次吃反斜杠
>   （join('
')→真换行=整文件语法错——frameless 一度未生效；改 String.fromCharCode(10)）；
>   **selector 返回新数组=useSyncExternalStore 死循环**（MembersPage 崩到 legacy——先取整份
>   再 useMemo 过滤）；portal 不清容器（最小壳+React 栏叠加 6 键——挂载时移除非 React 兄弟）；
>   http keep-alive 让 server.close() 永等（closeAllConnections+有界退出）；listen error 无处理
>   =启动挂死（once('error',rej)）；⌂ 按钮挂 body 不在 #hifi-root；mine.pending 无任务标题字段。
> - **[用户 H2-v2 短测已回填]** `hifi-h2-v2-short-test-record-20261005.md`（T1/T3/T5/T6/T7
>   PASS；T4 图片门 PASS+执行受阻=**M0 不支持未指派 AUTO 的模式边界**（mode_unavailable_in_m0，
>   如实不记缺陷）；**T2 提及呈现缺陷**：选 Guide A 后正文残留孤立「@」——R54 已修
>   （insertMention 剥离末尾孤立 @，仅 typecheck+构建验证，**页面级复证在 R55**）。
> - **[待办]** R55=短测遗留复证（T2 修复页面级+T4 模式边界的界面说明评估）+H3-v1 短测
>   （README-H3 六项）+H3 收尾余项（搜索/收藏、活动流、成果列表归位评估）。

## 上一轮快照（2026-10-05 第五十三轮）

> R52=H2 完成但**三处 P1 被复核证伪**（review-r52-next-round-20261005.md）；**R53=三 P1 修复
> +验证收紧+hifi-h2-win-v2 修正候选**。v2/v6/v1 原地稳定；Android 用 v6。
> - **[R52 覆盖更正（保留原报告）]** R52 报告中「P 六格式真渲染含 pptxVisual=rendered」与
>   「打包环境强制验证 PPT」**均不成立**：pptxVisual 用的宽松谓词（任意 min-height 容器）
>   实际命中预览面板滚动正文容器——PPT 视觉从未渲染（宿主死锁：舞台只在 rendering/done 挂载
>   而 effect 又等舞台存在才启动）；verify-hifi-package-r52.cjs **没有 PPT 视觉步骤**。
>   原 thread-r52-result.json/截图原样保留（thread-with-preview.png 中的「视觉页预览不可用」
>   框即死锁证据）；真实补证=**review-r53**（runId r53-20261005…，严格谓词）。
> - **[§2 PPT 死锁修复]** 舞台与控件行在 visualBytesAvailable 时**常驻挂载**（失败 display:none
>   但不卸载——同 Word 宿主策略）；打开/首页失败→真实 abort（signal 已传入 open）+dispose
>   已建 viewer（含 goToSlide 超时）；对共享 abortRef/viewerRef 的清理带「仍是本轮指针」守卫。
>   新增验证挂钩：data-zs-pptx-stage/data-zs-visual-state/data-zs-slide-page/count/controls、
>   data-zs-docx-host、data-zs-pdf-canvas、data-zs-image-decode（值=ok/mismatch/failed——
>   原 naturalWidth===d.width?'ok':'ok' 恒真已废）。PDF 补 render task cancel+doc.destroy()
>   归属；图片对账逐项宽高+如实 mismatch。
> - **[§3 移除幽灵引用]** store 新增 **settleUploadReady**（原子结算）：一次调用核
>   (draftKey,uploadId) 存在+未 removed+发起会话一致→通过才置 ready **并写草稿 ref**（同一
>   同步事务）；任何不通过=回执整体丢弃零草稿写入。Composer 不再自行写草稿（原无条件
>   setDraftFull 是根因）。页面实证（B3）：芯片消失之外——下一条真实信封 refs=[]、
>   message_attachments 零链接（artifact 保留=上传确实发生，如实）、切走再回不复活。
> - **[§4 清算收口]** settleForKey 不再「rev 变→整份 return 跳过附件清算」：**已发 refs 剥离
>   独立于正文保护**（无论等待期是否编辑，都只剥本次 sentIds 并 clearSettledUploads；正文/
>   提及仍按代次门）；retryUnknown 成功分支补剥冻结 attachmentRefs+清 store。页面实证：
>   B4（按住回执期间改正文+传新附件→放行：正文保留/旧芯片剥离/新芯片保留；下一条信封只带
>   新资源；旧资源恰落库一次不重带）；B5（丢回执→unknown→等待期新附件→重发成功：冻结 refs
>   剥离/新附件保留/下一条只带新资源/retry-1 恰一次）。
> - **[§5 构建/材料]** make-hifi-h1-package.mjs **构建门**：入口先跑 build-ui→pack-daemon
>   （退出码非零即中止，产物必须来自当前源码——R52 曾夹带缺 thread.get 的旧 daemon）。
>   README-H2 v2：T2 真实前置（干净种子 PPT 串=记录串，先 @Guide A 发任务再点新任务卡）；
>   T4/T5 先输入正文（仅附件不发送）；T5 真实表名 `CSV!A1:B2`+仅记录发送核落库；T6 改为
>   「复制定位链接」按钮（ThreadPage 详情——`#task=<实体ID>`，桌面无地址栏，跳转=工程验证，
>   用户核格式即可/NOT_RUN）。本轮把 make 脚本+r53 验证器+样本全部入库。
> - **[§6 交付]** **hifi-h2-win-v2**（buildId bld_398c8b90476b0ef9，591/591 清单一致，独立
>   目录）。verify-hifi-package-r53.cjs（独立副本双轮）在 r52 链上新增：PPT 视觉正常链
>   （真舞台子节点>0+done+页数=3——打包环境强制）、未知重试成功清算（带附件派发丢回执→
>   重发→芯片剥离+下一条只带新资源+恰一次）、就绪态移除负例（零链接+artifact 保留）。
> - **[证据]** 全量 856→858（新增 hifiSettlementRound53 1 项+hifiThreadRound51 拆 2？——以
>   本轮 vitest 实跑数为准）；verify-hifi-thread-r53.cjs 页面审计 **pass=true**（B1 死锁修复
>   实证：舞台/翻页签名变化 2144→1263/页数 3/模块请求；**B2 阻断负对照**：503 掉 pptx 模块
>   →failed+舞台零子节点——证明判据不能被降级冒充；截图 thread-pptx-visual-r53.png 经视觉
>   核验 PASS=真实幻灯片+页码 2/3 无降级框）于 dist/desktop/review-r53/。
> - **[H3 第一批已落地]** BoardPage（board.view 只读聚合：列位/退出未确认/受阻原因/待验收
>   徽标；卡→#task= 定位详情）、FilesPage（文件标签=files.view 四类分列：项目文件/托管附件
>   （→共享预览）/Agent 草稿/交付成果（→深链定位）；Git 标签=git.status 真实状态+git.diff
>   只读——写操作明确留原界面）、SettingsPage（app.settings.get/set 真实往返+
>   remote.config.get 实际事实只读+**打开定位粘贴入口**——T6 闭环；未换装项定向列出）。
>   侧栏三入口换真路由（/board /files /settings）；「复制定位链接」（ThreadPage 详情）→
>   「打开定位」（设置页）成对。探针 verify-hifi-h3-r53.cjs **pass=true**（真实命令计数+
>   卡片定位+Files→预览真内容+Git 分支/未跟踪+设置往返+粘贴 #task=→线程详情；截图×3 视觉
>   全 PASS：h3-board/h3-files/h3-settings-deeplink.png）。**无边框标题栏未动**（需改
>   Electron 窗口配置+拖拽区+托盘评估——R54 专题，避免本轮在交付窗体上冒险）。

## 上一轮快照（2026-10-05 第五十二轮——已按 review-r52 更正，原始结果文件未改动）

> R51=H2 开工（e07186a）；**R52=H2 完成+独立候选包**（review-r51 四反例全修+共享预览全格式
> +imageAck/ranges/重试冻结+**hifi-h2-win-v1** 交付）。v2/v6 原地稳定；Android 用 v6。
> **⚠ 更正（R53）：下述「P 六格式真渲染含 pptxVisual=rendered」的 PPT 视觉与「打包环境强制
> 验证 PPT」不成立（宽松谓词命中外层容器/打包验证器无 PPT 步骤）——真补证见 review-r53；
> 「上传中移除→回执即弃不复活」当时只证了芯片消失，草稿仍被写入已移除引用（幽灵引用）；
> 「成功清算按 refs 身份」在等待期编辑（rev 变）时被整份 return 跳过、重试成功分支完全不清
> 附件——三处均已在 R53 修复并页面实证。其余事实（A/B 归属/阅读门/字节合同/深链三修）经复
> 核保留。**
> - **[§2 附件归属]** store.uploadItems（draftKey+**uploadId**+conversationId）为唯一真源：
>   回执按 (draftKey,uploadId) 精确收敛——A/B 同名迟到回执不串（审计 A1 复证 copyText=B-ONLY）；
>   上传中移除→回执即弃不复活（**R53 更正：芯片层面成立，草稿 ref 层面不成立**）；A→B→A
>   芯片由 store 恢复；草稿只存 ready 引用；**成功清算按 refs 身份**（attachmentId 集合，
>   不再 name/size 匹配；**R53 更正：rev 变时被跳过**）。Composer 附件区全部 store 驱动。
> - **[§4 阅读门]** threadReadGate 要求 tab==='replies'+**容器实际存在**（缺容器=false）+
>   前台+贴底；详情视图/迟到 history 一律不推进（审计 A3：markRead=0、水位不变）；新增贴底
>   滚动主动推进（markThreadReadIfAllowed，节流 1.5s）。
> - **[§5 字节合同]** 文本上传=File.arrayBuffer+**TextDecoder('utf-8',{fatal:true})**——坏
>   字节明确失败零上传零 artifact（审计 A4：uploadDelta=0/artifactsDelta=0/失败芯片）；
>   File.text() 有损路径废弃。fileToBase64=arrayBuffer+btoa（双环境）。
> - **[§3 深链三修]** daemon `#delivery=` SELECT 补 conversation_thread_id；routeForResolved
>   未知归属不默认 DM（房间→/room/:id、DM 任务→/dm、查无→null 报错）；App 用完整 route 解析
>   query（此前 pathOf 已剥 query——tab/message 永远取不到）；ThreadPage 同线程 query 变化
>   同步（?tab= 深链/前进后退）+消息定位有界轮询（超窗如实说明）；**legacy 导航所有权门**
>   （legacyOwnsNavigation——hifi 在位时旧端 hashchange/popstate/深链恢复/标读全停）。
> - **[§6.1 共享预览]** preview/PreviewPane.tsx+renderers.ts（与旧界面同一随包渲染器与合同：
>   pdfjs ESM/pptx-renderer/docx-preview+JSZip；Shadow DOM+renderAltChunks:false+净化回退；
>   pptx=RECOMMENDED_ZIP_LIMITS+pdfjs:false+Abort/dispose+**withTimeout 有界**；代次在**渲染期**
>   推进——父 effect 自增会让子组件闭包误判迟到（R52 实测首轮全丢）；六格式+来源/版本/hash+
>   视觉与模型输入分列；表格注入范围写回草稿；消息芯片（线程+DM）/草稿芯片/锚块均可开。
>   **R53 更正：PPT 视觉宿主存在挂载死锁（舞台只在 rendering/done 挂载），从未真实渲染。**
> - **[§6.3]** imageAck=显式二选一 chip（仅发送文字/改仅记录——选择前不发送，一次性冻结进
>   信封）；attachmentRanges 从预览面板写入草稿→builder 冻结；未知信封重试含 refs 逐字一致
>   +恰一次（审计 A5 paramEqual/exactlyOnce）。各 upload* 首传 revision=1 合同事实补默认。
> - **[§6.5 交付]** **hifi-h2-win-v1**（buildId bld_ce1c059ab99a1df6，独立目录；make 脚本改
>   H2 文案+六类样本随包+README-H2/短测模板七项）。**坑：pack-desktop 用预构建 daemon 产物
>   （pack-daemon.mjs）——不改 daemon 只跑 make 会装进旧 daemon（首验卡锚块=thread.get 缺失
>   抓到）**（**R53 已治：构建门入 make 入口**）。verify-hifi-package-r52.cjs（独立副本双轮）：
>   真 bat→自动项目→线程卡→@Guide A 派发+丢回执重发恰一次→线程跟进零新任务→附件真实上传+
>   消息挂载→预览真内容（**仅文本——无 PPT 视觉步骤，R53 更正**）→图片门 imageAck→#task=
>   深链详情实际选中→window.close 停机 forced!=true→PID 归零→batExit=0→real_calls=0；
>   run2 重启历史。原型同窗对照（阅读空间/预览布局）+视觉验收完成。
> - **[证据]** 全量 **856/856**、typecheck×2；hifiUploadDeepLinkRound52 真实链 1/1（归属/坏
>   字节/分列/冻结/imageAck 端到端/范围/重试）；verify-hifi-thread-r52.cjs 页面审计 pass=true
>   （A1–A5 反例复证+P 六格式真渲染含 pptxVisual=rendered（**R53 更正：该字段谓词宽松，
>   PPT 实际未渲染**）+迟到覆盖+截图×2 于 dist/desktop/review-r52/——**原样保留**）。
> - **[R53 待做]** 打包验证器收尾结果落档（本轮后台运行中）+复核反馈；H3（设置/看板/Files
>   归位、Git/诊断、无边框标题栏）按 hifi-integration-plan 排期。

## 上上轮快照（2026-10-05 第五十一轮）

> R50=H1 证据收口（eecf0e2）；**R51=H2 开工（review-r50 四项全落）**：回复串真实页面链+
> 附件信封/预览骨架+深链规范化入口+验证器五项取证修复+补证三连+v2 版本口径澄清。
> v2（用户包）原地稳定；工程全部在源码/独立副本。Android 仍用 v6。
> - **[§4 回复串]** ThreadPage（`/thread/:id`）：主池 ThreadCard（room.pool 全字段）→
>   锚块（thread.get anchor）+回复（thread.history）+thread 目标发送（buildThreadEnvelope
>   ——**不另建根任务**）；记录串默认仅记录；详情=任务概况+停止（绑定 run/代次）+交付验收
>   （**打开即冻结三重身份**，目标变化作废）；关闭视图不停止执行；readGate=线程独立水位门
>   （不混 DM conversationSeq）。DTO 缺口补齐：新只读命令 `thread.get`（audience 核验）。
> - **[§4 附件/预览骨架]** 格式实际限幅（文本 256KB/图片 8MB/PDF、Office 20MiB/CSV 5MB——
>   不统一 20MiB）；Composer 📎 真实上传（uploadText/Image/Pdf/Office/Csv，回执绑会话进
>   HifiDraft.attachments）→ refs 进**不可变信封**（builder 可选字段）；成功只清已发资源；
>   图片+派发=能力门拦截（二选一文案）；消息芯片=真实附件摘要，点击 previewText 真内联。
> - **[§4 深链]** `lib/deepLink.ts`+App 分流：#dm=/#task=/#delivery=/#msg= → deepLink.resolve
>   （真实命令）→ 跨项目先 openProjectByPath → 内部路由（task/delivery→thread?tab=task，
>   msg→thread?message=）——刷新/前进后退走内部路由，实体身份保留。
> - **[§2 验证器五修]** verify-hifi-package-r50.cjs：①procsOfCopy 真路径匹配（反斜杠不
>   加倍——like 无转义义）+查询失败=未确认不冒充零+PID 身份捕获（procsBeforeClose≥1 才算
>   对照、capturedPids 逐一核退出）；②batExit 启动时订阅+pause 周期喂入+exitCode 判定；
>   ③负对照**实跑** waitFor 不可能条件（轮次/时长留档，不实跑则 exit5）；④run2/3 重启历史
>   按上一轮 messageId+taskId（conversation_threads）+UI 标记可见（主池 DOM id=root-<threadId>
>   非消息号——正文核对）；⑤仅记录核 thread.root_task_id NULL+outbox 前后差；DM 回复按
>   reply.messageId（DOM id=msg-<id>）核可见。**坑：spawnSync options 误入参数数组→argv
>   拼出 "[object Object]"（PS 位置参数绑定错误——逐字节比命令才发现）。**
> - **[§2 补证三连]** **r50-20261004160543 allPass=true**（同 v2 产物 bld_f152ca66662dc4ab
>   独立副本）：run1-3 各 batExit={code:0}+procsBeforeCloseConfirmed+capturedPidsGone+
>   residualZero+shutdown forced!=true+realCalls=0；负对照**实跑**超时（6 轮/2036ms）；run2/3
>   priorRunHistoryOk（上一轮 messageId+taskId+UI 可见）；仅记录 thread.root_task_id NULL+
>   outbox/runs 双零差（详见 dist/desktop/hifi-h1-verify-r50/；旧 runId 原样保留）。
> - **[§2/§3 边界]** 旧危险 verify-hifi-package.cjs 加硬拒绝守卫（默认 exit2，考古需显式
>   ZS_ALLOW_DANGEROUS_LEGACY_VERIFIER=1）；make-hifi-h1-package.mjs：独立输出目录（默认
>   hifi-h1-candidate-<stamp>，显式目录遇 RESULTS 用户回填=拒绝）、run-self-check.bat 改指
>   随包 h1-self-check.cjs、清旧残留 self-check.cjs；v2 版本时间线澄清
>   （dev25-h1-v2-version-note-20261004.md：bld_5f1b092fed6e6240→bld_f152ca66662dc4ab 原位
>   重建于用户开测前+外围文件后补写入如实登记；「零接触」口径=591 清单范围）+ 包外说明
>   （dist/desktop/README-v2-体验期间说明-r51.md）。
> - **[证据]** tests/integration/hifiThreadRound51.test.ts（真实链 1/1：线程卡→thread.get→
>   回复不另建根任务→记录串→水位门→验收三重绑定→附件信封+跨会话拒绝→深链映射）；scripts/
>   verify-hifi-thread-r51.cjs=**实际 React 页面×正式 daemon×fake worker** 页面链 pass=true
>   （T1 线程卡/T2 跟进/T3 记录串/T4 验收 DONE/T5 markRead 水位/T6 附件上传+挂载/T7 #task=
>   深链）+同窗截图×2（CDP Page.captureScreenshot——**坑：隐藏窗口 capturePage 返回首帧**）
>   视觉双 PASS。验证面：**全量 855/855**、typecheck+typecheck:hifi、hifi-shell 9/9（P1 选择
>   器随 H2 线程卡更新）、ui-hidden-layout 7/7。
> - **[R52 待做]** 共享预览完整版（PreviewPane+vendored 渲染器复用）、附件排队按消息输入
>   水位、imageAck 显式确认 UI、H2 独立候选包（新验证器需随 H2 UI 选择器更新——主池已
>   .root-card）。

> R49=可短测首包 v2 交付（bbb6a2d）；R50=review-r49 四项收口：**去假阳性三连（独立副本
> r50-20261004144010 allPass）+打包边界+H1 自检+H2 映射盘点**。用户可开始体验 v2；
> H2 已可开工（映射见 hifi-h2-mapping-20261004.md）。v6/Android 不动。
> - **[P1 验证器去假阳性]** verify-hifi-package-r50.cjs（独立副本 hifi-h1-verify-r50-copy，
>   交付包零接触）：恒真 `||true` 删除；**房间指定 @Guide A 派发**经
>   conversation_threads(anchor→root_task_id) 核任务+run/turn（房间根消息 messages.task_id
>   本就不落任务号——旧断言口径错误）；**仅记录**核该消息 task NULL+runsDelta=0；lose-once
>   移到房间步（先 banner→重发原信封→恰 1 条+无失败行内+锁释放后继续）；DM **新建空闲会话**
>   （+Guide B）正常发送核本轮 commandId→message→task→run→turn→agent 回复身份；全部子项
>   纳入 pass。旧 r49 run1/2/3 原样保留（覆盖范围已按复核更正）。
> - **[P1 停机]** window.close()（用户同型）→ desktop-shutdown.json 存在（forced 非 true）
>   → 副本路径进程树归零（CIM 按 CommandLine 匹配副本路径——**坑：junction 中文路径在 CIM
>   返回 mojibake，须按 ASCII copyRoot 前缀匹配且排除 powershell 自身**）→ bat 退出码留档。
> - **[口径]** 每轮记 launchDir（junction 成败如实+realpath）+BUILD/清单 SHA 前后一致
>   （同产物声明落事实）；新 runId 不覆盖旧档。
> - **[P2 打包/自检]** pack-desktop **退出码检查**（失败不拷旧产物）；模板 write-if-absent
>   （不覆盖用户回填）；PPT 种子**入库**（scripts/dev25-dual/回归幻灯.pptx——不再依赖 v6
>   目录）；随包自检=h1-self-check.cjs（文件+全量清单核对，替代旧远程导出脚本）；README/模板
>   明确入口（T2 @Guide A 步骤、T3 +Guide B 新建空闲会话、T4 未触发记 NOT_RUN 勿断网）。
> - **[三连事实]** r50-20261004144010：run1 junctionOk=true（中文+空格路径实跑）、buildId
>   bld_f152ca66662dc4ab 前后一致；房间 taskId/runs=1/turns=1+mentions member；仅记录
>   task NULL+runsDelta 0；DM 新会话回复带本轮 task/run/turn 身份；shutdown forced!=true；
>   residualZero；real_calls=0；负对照留档。全量 854/854、typecheck×2。
> - **[H2]** 映射盘点完成（hifi-h2-mapping-20261004.md）：回复串（thread.history/task.get/
>   readGate 复用）、交付定位（deepLink.resolve+pendingDelivery）、附件草稿
>   （uploadText/uploadOffice+信封 builder 扩展）、共享预览（PreviewPane+vendored 渲染器
>   复用——不重做解析器）；首版落点 replies+task 两 tab，其余原界面定向。

## 上一轮快照（2026-10-04 第四十九轮）

> R47=H1 合同/异步/接管/类型门（0b8dacb）；R48=首包时序收口+hifi-h1-win-v1 工程候选
> （b264a40——**复核认定未达交付门**：启动器缺 seed 依赖/未跑 bat/信封仍 UI 重造）；R49=
> 按review-r48 五项收口并交 **hifi-h1-win-v2**（可短测首包）。H2/H3 未开始；Android 仍用 v6。
> - **[P0 启动器]** make-hifi-h1-package.mjs 入库：pack-desktop 产物+seed（seed-client.cjs
>   **+回归幻灯.pptx**——缺件会静默跳过导致主池空，v1 的根因）+self-check+README-H1+
>   SHORT-TEST 模板（5 项约 5–10 分钟）+start-server.bat（**清父环境 ZS_\***，保留两个
>   注明的工程直通：CDP 端口/受控丢回执；种子失败 exit /b 1；调试端口尊重直通变量）；
>   清单逐件核对 591/591。
> - **[P1 信封]** loader 唯一正式 builder（buildRoomRootEnvelope/buildDmEnvelope——
>   projectId/conversationId 齐全，不从 ComposerTarget 重造）；页面**发送前**构建不可变
>   信封+unknown 时页侧 park（不再回读 commandIdRef——A 切 B 换号反例收口）；
>   retryUnknownSend=sendEnvelope（同号同参逐字重发）。
> - **[P1 测试去假阳性]** 冒烟 P7：重试信封与原发**全参数 JSON 逐字节一致**+无失败行内
>   错误+队列语义（第二条未知顶上属预期）；真实链用**产品 builder** 生成重放信封（不再
>   手工构造比产品更正确的参数）。
> - **[P2 生命周期]** 每键锁 Set（A 回执 finally 只删 A 键）；草稿编辑代次 rev（等待期
>   有编辑→整份保留不剥离）；连续 unknown 排队不覆盖；标读/刷新浮promise 全 catch
>   （未处理拒绝退出码 1 收口）。
> - **[P2 接管身份]** legacy 侧栏按钮带 data-room-id/data-conversation-id；locate 按
>   **机器身份**精确匹配（CSS.escape；房间缺属性才回退名称并标注）——同成员第二会话/
>   同名房间不再错开。
> - **受控丢回执钩子**：main.ts ipcMain `ZS_H1_LOSE_SUBMIT_ONCE=1` 丢弃首次
>   message.submit 回执（命令仍送达）——真包上验证「提交已成功、回执丢失」重试链。
> - **三连全链（最终冻结产物 bld_5f1b092fed6e6240，591/591 清单）allPass=true**：verify-hifi-package.cjs
>   每轮实跑 bat（run1 预杀+清数据根真首启、经「H1 验证 副本」中文+空格 junction 路径）：
>   首启自动项目→房间样本（150s 种子宽窗）→**丢回执→banner→重发原信封→消息恰一次**→
>   跨目标草稿→仅记录→DM 发送+回复→按会话 ID 接管/返回（hash 归一断言）→Browser.close
>   优雅退出→零残留→real_calls=0（直读包内 state.sqlite）。证据 hifi-h1-verify/run{1..3}.json+summary.json。
> - **视觉对照（vision-tester）**：原型（03/01/07）vs H1 同窗对照——两项明显空间问题已修
>   （h1-overrides.css 消息卡通栏对齐输入区；DmPage 会话列 flexBasis 224px 阅读区占 81%）
>   复核双 PASS；顶栏/房间 tabs/composer 状态行/侧栏分区等为 H1 范围裁剪，登记非缺陷。
> - 验证面全绿：全量 **854/854**、typecheck+typecheck:hifi、hifi-shell 9/9、ui-hidden-layout 7/7、
>   hifiFirstPackage 2/2（无未处理拒绝）。
> - **用户短测**：双击 hifi-h1-win-v2/start-server.bat → 按 RESULTS/SHORT-TEST-template.md
>   五项（约 5–10 分钟）；v1=v1 工程候选保留未删。

## 上一轮快照（2026-10-04 第四十七轮）

> 本轮=**H1 首包收口（review-r45-r46 全部 P1/P2）**：正式命令合同、异步发送、能力如实、
> 首启/归属/水位、定向接管、独立 hifi 类型门与真实链测试。R48 交默认新界面的可运行首包
> （回归+打包身份+真实启动器证据）；Android 仍用 v6。
> - **命令合同**：project.open `{path}`（反向对照 rootPath=VALIDATION_INVALID 已测）；
>   room_root target 补 `roomId`；房间名单=`member.list({projectId,roomId})` 逐房间装载
>   （room.memberIds=@ 候选唯一来源——Lab 式二成员名单不混项目全体）；mentions `all`→
>   `{kind:'all'}`（DB 事实）；history `created_at` 如实映射（未知=0 呈现层标注，不伪造）。
> - **异步发送（Composer 正式适配——保留视觉、行为走真）**：onSend 返回回执 Promise；
>   **成功才清空且只清本次发送内容**（等待期编辑/新 @/新附件保留）；确定失败保留草稿+
>   行内错误+换新命令号；**结果未知保留同 commandId 重试**（后端幂等恰一次）；同步锁到
>   回执才释放（双击/Enter 并发防重）；bridge 区分服务拒绝(failed)/传输失败或超时(unknown，
>   20s 窗)。Composer commandId 贯通信封（不再 Date.now 重造）。
> - **能力如实（formalLimits）**：附件/计划开关/权限档位点击前禁用+原因（附件指向原界面）；
>   仅记录入口保留可用；无成员房间派发前置拒绝（可仅记录）。
> - **首启/归属/水位**：bootRemembered 有界 60×1s+失败可见+重试入口；装载代次+请求时项目
>   双门（迟到响应丢弃——review 探针反例收口）；markRead 仅前台+贴底+页面判定；读取失败
>   保留旧快照+readErrors 就地呈现（不冒充空态）；可见时 5s 轻量刷新（隐藏/接管暂停）。
> - **定向接管**：takeLegacy(target) 按 legacy 既有控件定位（board/files toggle+复核、
>   search/project-settings/help details、pending 滚动）——已可见不重复点击（toggle 竞态），
>   连续 3 次稳定确认（boot 收起竞态）；接管时卸载 hifi/app.css（样式隔离）、返回恢复样式
>   +暂停旧端轮询（__zsLegacySetVisible/schedulePoll 门）+刷新数据；ErrorBoundary+8s 看门狗
>   （模块加载失败回退 legacy）。
> - **验证**：hifi 独立 tsconfig（DOM/JSX/bundler+strict，具体投影类型 Room.conversationId/
>   DmConversation.peerDisplayName/execState、ProjectMember.principalType）入 `check` 链；
>   **hifiFirstPackage.test.ts 真实链 1/1**（esbuild 打包交付 loader/store×真实
>   dispatchDaemonCommand×DispatchWorker：{path} 合同/房间名单/指定成员+@全体 DB 事实/仅记录
>   零 run/DM 派发→worker 回复→created_at 如实+作者映射/传输拒绝=unknown→同号重试恰一次）；
>   **verify-hifi-shell 升级为合同校验型 6/6**（桩按 zod 镜像严格校验+P1 房间名单 @ 候选/
>   P2 成功清已发+保留等待期编辑/P3 record_only/P4 受控失败保留草稿+行内错误/P5 定向接管+
>   样式隔离+返回恢复/P6 DM 合同）；ui-hidden-layout 7/7 不回退。
> - 遗留（R48）：双击/IME 的 UI 级专项断言（同步锁已实现）；legacy 顶层杂项命令
>   （renderRemoteSettings 等启动期单次读取）收口；msg-list 宽度/气泡与原型同窗对照截图；
>   首包候选打包（默认 hifi、--no-hifi 仅对照）+冻结/启动器证据。

## 上一轮快照（2026-10-04 第四十六轮）

> 本轮=**主线切换：原型界面接入正式客户端（H1 首包开工）**（用户补充优先级+
> hifi-integration-plan-20261004.md：接入顺序 H1 外壳/房间/私信/消息/输入（3 轮）→H2 线程/
> 共享预览（2 轮）→H3 设置/看板/Files 归位+**Git 与诊断不再常驻挤占聊天区**（2 轮）→H4 收尾
> （1–2 轮））。Android 仍用 v6 不重测；后端合同/用户数据/证据不动；未接能力如实呈现不 mock。
> - **R46 已落地**：react@18.3.1 入根依赖；esbuild 打包 `src/ui/hifi`（原型组件**原样拷贝**：
>   Icon/ui/NavMarks/MessageView/Composer+types/selectors/format/resource/router+四份 CSS）→
>   `dist/ui/renderer/hifi/app.mjs+app.css`（样式**挂载时注入**——不污染 legacy）；真实侧新增
>   `store.ts`（原型 store 同名 API：useStore/草稿/toast/recordLocalOnly——**无种子无 mock**）、
>   `bridge.ts`（window.zs 类型化）、`loader.ts`（project.open/room.list/member.list/room.pool/
>   conversation.list·create·history·markRead/message.submit 映射到原型视图模型；附件提交
>   **明确拒绝**——H2 才接）、App/RoomPage/DmPage、main.tsx。
> - **共存与接管**：默认 hifi 壳（body.hifi-on）；未换装入口（搜索/Git/看板/成员/待我处理/
>   设置）→「原界面」整体接管（body.legacy-on+首次点击才启动 legacy boot——不双装载双轮询）；
>   hifi 挂载失败自动回退；`?nohifi=1`/`--no-hifi`=工程逃生口（legacy 专项验证器用）。
> - **验证**：新 verify-hifi-shell.cjs（实际打包页面+传输桩，断言真实 envelope）**3/3**——侧栏
>   真实 room.list/主池真实 room.pool/房间+私信发送走真实 message.submit（room_root/dm）/
>   legacy 接管守卫；verify-ui-hidden-layout **7/7 不回退**（P0—U6）；视觉子代理双截图
>   **PASS**（三段式侧栏/消息卡片/输入区=原型样式；已修「未知成员」作者映射；输入区宽度
>   对齐与仅记录入口位置 R47 对照原型收口）。
> - R47 待办：仅记录意图真实闭环+mention 选择核实、房间/私信消息呈现与原型逐项对照
>   （msg-list 宽度/气泡）、refresh 轮询节奏、种子/欢迎页空态；R48：去尾+页面级验证扩展+
>   **首包交付候选**（含真实 daemon 冒烟）。tsconfig 暂排除 src/ui/hifi（esbuild 打包为主，
>   H1 收口时补类型门——如实登记）。

## 当前真实状态（2026-10-04 第四十五轮，唯一权威快照）

> 本轮=**v6 四项短回归收案+Android 就绪+两条工程边界**（review-r44-next-round-20261004.md、
> dev25-v6-short-regression-record-20261004.md）：R6/R7/V1/V2 按用户报告与补确认收案
> （正式记录 v6/RESULTS/SHORT-REGRESSION.md+七张原图；PPT 关闭重开/Word 关闭与颜色隔离/
> 三向切换均确认）。**Android 用现有 v6 推进，不换包不清库**；工程修复在源码，随最终候选
> 交付（Android 回填后一次必要的最终候选：冻结三连+清单+真实启动器+旧库升级验证；若复用
> 演练数据与 CA 先在副本证明迁移/回退）。
> - **Android 指南改实口径**（dev25-android-acceptance-guide.md 重写）：v6 运行中；前置=
>   V2 收尾的仅本机恢复 **LAN（0.0.0.0）**+LAN 自检+实际地址（192.168.1.100，端口以当前
>   面板为准）+**不用 198.18 虚拟网卡地址**；v6 CA SHA-256=`c7655e12c4102fad…`（已只读
>   重算核实）；后台恢复=**桌面代发唯一标记「仅记录」消息**（不依赖已消耗的种子 60s 窗）；
>   吊销放最后+其它设备顺带观察；手机/Android/浏览器版本必填模板。
> - **迁移 045（review-r44 §2 纯函数反例）**：044 把「probe 字段在但损坏」（null/[]/false/
>   字符串）折叠成「缺字段」→reason 兜底误放行。045=`classifyProtectionFactFinal`
>   （045-turn-probe-field-integrity.ts）：`Object.hasOwn(p,'probe')` 分离**真缺字段**（受控
>   旧兼容保留）与**结构损坏**（保守 retained）；完好对象 probe 按 result 判；完整 Job 证据
>   仍优先（含损坏 probe）；只降级修正，已应用 044 的库兼容收口。legacyProtectionUpgrade
>   **8/8**（44→最新含文件库重开同判；40→最新矩阵+corruptprobe1）。
> - **DM 返工目标固定（review-r44 §3 探针反例）**：打开意见框时捕获**会话身份+task/
>   delivery/revision/hash 快照**（旧残留输入框移除重建）；确认只审该快照——同会话刷新换
>   目标不换稿；期间版本更新由后端 STALE_REVISION 拒（UI 标注快照版本）；**跨会话切换明确
>   作废+零提交**。dmReviewContract 重写为五段真实 fake 链（常规/定位漂移诱饵/输入期间版本
>   更新→第 4 版零误审/跨 DM 作废零提交/accept 快照语义；全链审计 3 次正式记录）。
> - **材料纠正（review-r44 §4）**：dirty 对应计数更正（ab89219=21M+4A；二进制 docx/pdf
>   **8 件**全 M、文本 **17=13M+4A**；已证=**13 个修改文本文件** diff 逐字节一致；4 新增
>   构建时未跟踪无 diff 字节可比）+「不能完全重建」取代「差异仅可来自…」（appendix/
>   continuation r44 快照/review-r44 JSON 三处同步修订）；短回归指南 R6 删「表格页显示
>   网格」（随包样本 3 页无表格页——工程测试覆盖，不在样本中要求）。
> - 全量 **852/852**（105 文件；原始日志按 runId 留存 dist/desktop/r45-test-logs/
>   r45-20261004155706/full-suite.log）；typecheck 干净；零新增真实模型调用；**Android 期间
>   v6 应用/数据/证书/
>   既有结果稳定不动**；价值评价/DEV-11/并行写入维持原约定；**G5 按正式集成与兼容矩阵验收
>   （当前不宣布）**。

## 上一轮快照（2026-10-04 第四十四轮）

> 本轮=**review-r43 三条确定性工程边界+共用 review 合同+材料收尾**（review-r43-next-round-20261004.md），
> 用户同步以 v6 补测 R6/R7/V1/V2——**正在验收的 v6、数据与结果原件全程不动**，全部修复在源码
> 与独立目录完成；无新包（用户回填后集中处理实际失败再定最终候选）。
> - **迁移 044（review-r43 §3 纯函数反例）**：043 的 managedEvidence 只查「非空对象」、reason
>   兜底可覆盖已有相反 probe——空对象/数组/releasable:false/activeCount>0/null/缺字段/缺
>   managedJobId 的残缺证据都曾判 released。044 按真实 ReleaseEvidence 结构校验完整条件
>   （releasable/rootExited/handlesReleased 全 true+activeCount 数值 0+同事件 managedJobId 稳定
>   身份）；完整 Job 证据优先于落后的进程观察（probe alive 不否决）；**probe 存在时按 probe
>   判定，reason 兜底仅限旧事件缺 probe 字段**。043 已随 v6 发布冻结不改写——044 只降级修正
>   （V2 released ⊆ 043 released），不动 retained/NULL/预算/审计；幂等。legacyProtectionUpgrade
>   **6/6**（40→最新[+badmev/reasonover 两形态]/41→最新/42→最新/43→最新[已应用 043 的库兼容
>   修复+文件库重开同判]/043 纯函数/044 纯函数全分支）。
> - **DM 返工合同（review-r43 §4）**：dm-review-reject 确认分支补 manifestHash（此前漏传→
>   VALIDATION_INVALID）且改绑**用户所见快照**（currentReview 优先——待我处理定位时 pendingReview
>   可能指向另一交付）。调用方盘点：线程 reviewTask（accept/reject 共用，已带 hash）✓、DM
>   accept ✓、远程两处 accept ✓——唯一缺口即 DM reject，已修。新增
>   tests/integration/dmReviewContract.test.ts：**原样抽取产品 accept/reject 处理器**（与 r43
>   探针同锚点法——改源码即改测试对象）×真实 fake 链（message.submit→DispatchWorker→交付
>   pending→task.review）——返工带 hash/任务回 ACTIVE/意见入账/快照绑定诱饵不误审/旧版本与
>   错 hash 各返回 STALE_REVISION/redispatch 后第 2、3 版交付→accept DONE。
> - **显式工具入口（review-r43 §5）**：DM 视图下点看板/Files/动态曾被
>   `main[data-view=dm]>#board/#files/#activity{display:none!important}` 架空（handler 清
>   hidden 但 data-view 仍 dm）。统一视图状态：showToolPanel/hideToolPanel/resetToolPanels 唯一
>   维护三个布尔守卫+hidden 类+data-view；私信/线程视图下显式打开工具=暂离该视图（data-view
>   切 pool 侧），关闭返回原视图——**会话/线程身份、草稿、导航代次全程不动**；openDm/
>   showPool/openThread 入口一律归零（含修正此前「线程下开看板双区并显」的隐性不同步）。
>   verify-ui-hidden-layout 新增 **U6**：DM→看板显式可见（computed display≠none+尺寸+内容
>   渲染+DM 让位）→看板↔Files↔动态互斥切换→关闭返回 DM（视图身份+dm-input 草稿保留）→
>   侧栏切房工具归零——**P0-U6 七场景 allPass**（桩补 board.view/files.view/activity.list
>   最小数据）；lifecycle/word-isolation allPass 不回退。
> - **材料口径（review-r43 §6）**：打包模板 SHORT_REGRESSION/README 尾部改**四项**（R1—R5
>   沿用 v5 不重测、D1—D10 按 v2 收案）——随下一候选包生效，v6 包内 README 不动（指南已
>   四项化）；指南+模板补 **resize 手柄在面板右下角**（非任意下缘）与 **V2 收尾恢复 LAN**
>   步骤；尺寸口径统一**宽×高、最大高度与实际高度分记**（本轮起报告与 metrics 均按此，
>   R43 快照中「949×1680」已更正为宽×高=1680×949）。
> - **构建 dirty 对应（review-r43 §6；计数与措辞按 review-r44 §4 于第四十五轮修订）**：v6
>   BUILD.json 真实元数据（commit=8f49f5c、dirty=true、dirtyDiffHash=4fa3b1b0…）**原值保留
>   不改写**。只读重建核对（dist/desktop/review-r44/build-dirty-correspondence.json）：
>   ab89219 变更集=25（21 M+4 A；二进制 docx/pdf 8 件全为 M、文本 17=13 M+4 A）；重放脏路径
>   集 25=25（21 ' M'+4 '??'）；**13 个修改文本文件** diff 逐字节一致（cmp 首差异恰在二进制
>   fixture 段起点）；4 个新增文本文件构建时未跟踪（仅 ?? 行，无 diff 字节可比）。dirtyDiffHash
>   完整成分**不能完全重建**（构建时 diff/status 字节未留存；二进制 fixture 检出转换不可逆推）
>   ——「全部文本逐字节一致/差异仅来自二进制」不作已证结论；同源性另有 renderer 三源逐字节+
>   冻结清单 588/588+三连 buildId 佐证。
> - 全量 **850/850**（105 文件；原始日志按 runId 留存 dist/desktop/r44-test-logs/r44-20261004144908/
>   full-suite.log）；typecheck 干净；零新增真实模型调用；v5/v6 包与既有证据原地保留；
>   价值评价/DEV-11/并行写入/G5 维持原约定；**旧库兼容与正常操作合同收口前不宣 G5**。

## 上一轮快照（2026-10-04 第四十三轮）

> 本轮=**v5 用户回填收案+四类现场缺陷修复**（review-r42-next-round-20261004.md）：统一隐藏
> 契约（UI-01）·阅读空间与预览展开（UI-02/03）·监听显示（UI-04）+迁移 043 保守化+种子房间
> 绑定+首启自动装载。交付 **v6 独立候选包**；用户只补测 R6/R7+相邻视图切换+监听显示，随后
> Android。v5 包与其 RESULTS/截图=正式回填记录，原地保留。
> - **用户结果收案（不再等待）**：R1/R2/R4 用户确认 PASS；R3 重启自动恢复 PASS（私信被挤
>   细条的布局缺陷另列=UI-02）；R5 按已观察范围 PASS（监听选择框与运行事实不同步另列=UI-04）；
>   **R6 FAIL**（关闭预览无反应——原包 CSS 反例：.pool/.composer/.attach-preview 加 hidden 后
>   仍 flex/block 占位）；**R7 BLOCKED**（Word 内容已呈现但区域过小——max-height 300/320px
>   嵌套滚动）。原件=v5 包 RESULTS/SHORT-REGRESSION.md+shots/（Codex 按授权代整理，未改模板）。
> - **UI-01 隐藏契约**：style.css 全局 `.hidden{display:none!important}`（此前仅 .thread/.gate/
>   #stop-btn/.resume-info/.send-error 有局部规则）；JS 侧资源释放/代次保护不变。
> - **UI-02/03 阅读空间**：main[data-view=dm] 收起主池输入区（DM 自带输入行）+仓库/Git/看板/
>   Files/Activity（偏好开关不动，返回恢复）；.main.preview-open 预览打开时收起仓库/Git 行；
>   预览面板默认 max-height min(56vh,600px)+resize:vertical+「⤢ 展开预览」expanded 档
>   （min(82vh,1000px)，docx/pptx 视觉区 calc(82vh-210px)）；打开分支统一 showAttachPreviewPanel
>   （面板+工具条同显+preview-open）。
> - **UI-04**：监听编辑控件与已应用配置分离——刷新同步已应用值（运行事实），dirty 编辑不被
>   覆盖并标注「检测到未应用的编辑」；说明行新增「已应用配置：监听 …」。
> - **P0 首启自动装载**：renderer 服务端记忆回退由单次读取改**有界轮询**（60×1s，欢迎页不
>   阻塞、用户手动打开即停）——种子启动后才写记忆的窗口不再造成首启空白；启动器自测
>   assertAppFacts **删除 location.reload()**，首启可见/房间可见改为硬断言（reload 替代首启
>   成功的口径废止）。
> - **迁移 043（review §4 纯函数反例）**：保守分类 classifyProtectionFactStrict——同体矛盾
>   （released:true+protectionRetained:true）→retained；released:true 但证据不足（probe alive/
>   unknown/identity-missing/exited、缺 probe）→retained（**审计曾写释放≠当前合同的完整退出
>   证明**；reconciled executed+exitFact=exited 同不追认）；可信正例不误拦=managedEvidence
>   受管 Job 完整结束/probe no-os-process（旧版缺 probe 字段时按服务端 reason 串）。**已应用
>   042 的库**由 043 只降级 released→retained 修正（不动 retained/NULL/预算/审计；幂等）。
>   legacyProtectionUpgrade 4/4（40→最新矩阵+41→最新复现收口+42→最新降级修正+纯函数 22 分支）。
> - **种子房间绑定**：seed 显式选「默认房间」（找不到=失败不 fallback items[0]——v5 实际落
>   Lab Room 的顺序漂移），房间/线程/附件身份写 seed.json（rg.pptRoom/pptThread）；指南改
>   真实入口（默认房间→打开回复串→根消息📎芯片）。远程浏览器 openThread 补**根消息卡+
>   rootAttachments 只读芯片**（此前只渲染 replies——读取呈现缺口；不扩为远程视觉预览）。
> - **页面级验证**：新 verify-ui-hidden-layout.cjs（实际打包页面+传输桩——DOM/CSS/控制流全
>   真实；**computedStyle+尺寸断言**，1280×800+1920×1080 双档）P0 首启轮询装载/U1 隐藏契约
>   （pool/composer hidden 后 0 尺寸、DM 消息区≥55% 主高、返回恢复）/U2 关闭真正消失+工具行
>   让位恢复/U3 Word·PPT 展开实测（docx 视觉盒实际高度 353→448px；面板展开 maxHeight≈658px、
>   实际 h≈595px；resize vertical）/U4 监听
>   同步+dirty/U5 宽屏（DM 消息区宽×高=1680×949）——连续两次 allPass。lifecycle/word-isolation
>   allPass 不回退。冻结验证器 ATT 新增 4 项 R43 断言（展开/关闭计算样式/视图切换/监听）。
> - **v6 交付**：冻结三连（runId 见 vdr-runs 新记录）+同源核对+真实启动器自测（首启不 reload
>   断言）；包含 042+043、R7 样本、NOTICE 三件、README 修复、材料修订。**用户操作：对 v6 只
>   补测 R6/R7+相邻视图切换+监听显示**（R1—R5 按 v5 范围保留）；通过后 Android；不重复 D1—D10。
> - 全量 847/847（原始日志按 runId 留存 dist/desktop/r43-test-logs/）；typecheck 干净；零新增
>   真实模型调用；价值评价/DEV-11/并行写入/G5 维持原约定。
> 历史快照（第三十八轮起）见下文各节；工程坑与旧轮细节以各轮快照为准。

## 上一轮快照（2026-10-04 第四十二轮）

> 本轮=**review-r41 三块收口**（review-r41-next-round-20261004.md）：旧库升级 P1（迁移 042
> 回填）+Word 验证支架负对照补强+操作材料与真实入口对齐。**v5 包/server-data/RESULTS/截图
> 全部冻结不动**（用户以 v5 全新演练数据做 R1—R7）；工程修复全部在源码与独立目录完成，随
> **下一候选包（v6，待用户回填后决定）**交付。PPT A+Word/B 不集成的决定不变。
> - **P1 旧库升级回填（迁移 042 turn-protection-state-backfill）**：041 只加列不回填——旧库
>   已明确「保护保留」的 FAILED/refunded 无租约 turn 升级后 protection_state=NULL→呈现可恢复、
>   redispatch 放行、releaseProtection 无租约 no-op（复核反例已复现）。042 按
>   recovery.reconciled/recovery.protectionReleased **事件顺序（seq）**继承 retained/released：
>   只回填 NULL 行（041+ 正式写入的权威状态不改写）；keepUnknown 不产生事实；证据损坏/字段
>   缺失/矛盾→retained（不默认安全）；no-os-process/历史 exited（≤第八轮旧全释放路径，忠实
>   继承）/protectionReleased(released:true)→released；曾释放→更晚保留=按最新事实。不清预算、
>   不删数据、不改审计。**tests/integration/legacyProtectionUpgrade.test.ts 3/3**：40→最新
>   （文件库，七形态矩阵：保留/可靠释放/普通失败/executed 保留/keepUnknown/顺序反例/损坏——
>   呈现+守卫+恢复中心+无证据解除拒+none 解除后恰一次恢复+数据预算审计逐字节不变+幂等+重开
>   同判）+41→最新（先**复现漏洞**（redispatch enqueued=true）再同 row 收口）+分类纯函数
>   12 分支。既有 dev25FieldFixes 6/6+budgetGrantAccounting 3/3 不受影响。
> - **P2 Word 验证支架重写（verify-word-isolation.cjs，连续两次 allPass）**：W1 哨兵=实际泄漏
>   目标 `#host-sentinel>span`+**旧非隔离实现负对照必须变红**（rgb(255,0,0) 实测——旧支架
>   id=sentinel 裸按钮=假覆盖已修）+合法样式（zsred）shadow 内 **getComputedStyle 实测**变红；
>   W2 **真实 altChunk**（aFChunk 关系+包内 HTML 部件）：开启对照产生 iframe+srcdoc 含载荷
>   （消费证明）→产品 renderAltChunks:false 零 iframe+**产品 UI 如实标注**（app.js 新增
>   「嵌入 HTML（altChunks）首版不支持」用户可见说明行）；W3 **完整 wp:inline/pic:pic 结构**
>   +内嵌正对照（naturalWidth 320 实测=结构被消费）+外链**无拦截对照窗口**实测：组件把关系
>   目标按**包内路径**解析→不形成网络 URL（可达计数器零命中；缺件产生 src="null" 同源伪影
>   如实记录）；产品镜像窗口零命中+会话拦截兜底。W4 页眉文本实测（3 页眉含样本标记）+图片
>   naturalWidth 实测。metrics=dist/desktop/word-isolation/metrics.json。
> - **操作材料对齐（§5）**：指南/README 模板统一 **v5+七项**；R7 改真实入口「📎附件→选择
>   文件→点击芯片」（产品无拖放上传——wireAttach 只接 fileInput.onchange）；项目名=「DEV25
>   双机验收」；PPT=默认房间**已发仅记录消息**的附件芯片（非发送框）；README 防火墙路径
>   （v5 内被模板转义打成多行坏路径——成因 `\r`/`\n` 转义）模板修复+**生成后字节断言**；
>   R7 无隐私样本入库 scripts/dev25-dual/samples/word-r7-sample.docx（sha256 d66f6248…，W4
>   验证）随下一包；NOTICE 相对引用三件源材料（mtx-decompressor MPL-2.0/ECMA copyright
>   notice/ooxml source-manifest）自**同一钉版 tarball**（入口 sha256 与 PROVENANCE 核对一致
>   后）vendor 入库+逐件 sha256 记录（PROVENANCE.noticesMaterial）+随包 licenses-preview-
>   vendor/pptx-renderer-notices/。**更新说明=dev25-r42-materials-addendum.md（独立提供，
>   不覆盖任何用户回填；不要求重新导入 CA 或重复已完成手测）**。
> - **用户操作**：按更新后指南+补充说明对 **v5（全新演练数据）做 R1—R7**；通过后 Android
>   （记录系统/浏览器版本、包身份、物理 LAN 地址）；不重复 D1—D10；**旧项目数据不迁入演练包**。
> - **下一步（用户回填后）**：集中处理实际失败→决定下一候选包 v6（承载 042 迁移+材料修订+
>   R7 样本+NOTICE 三件+README 修复）→冻结三连+自测后交付。
> - 零新增真实模型调用；旧批次/通知/D1—D10 证据保留；价值评价/DEV-11/并行写入/G5 维持原
>   约定；旧库升级/Android/G5 各自按实际范围收案（不连带宣称）。
> 历史快照（第三十八轮起）见下文各节；工程坑与旧轮细节以各轮快照为准。

## 上一轮快照（2026-10-03 第四十一轮）

> 本轮=**第四十轮复核三缺口修复**（review-r40-next-round-20261003.md）：恢复保护独立持久化+
> 预览生命周期统一收拢+Word CSS 隔离（Shadow DOM）。预览选型已裁决并落地：**PPT=pptx-renderer
> 1.3.0（vendored 入库）+Word=docx-preview 0.4.1；B（libreoffice-kit）首版不集成/不下载**；
> Excel/PDF/Mammoth/模型输入链保持原合同。
> - **P1 保护状态独立持久化（迁移 041 agent_turns.protection_state）**：无租约的 notStarted
>   人工退款（FAILED/refunded+protectionRetained）不再凭「无 UNKNOWN+无租约」推导放行——
>   retained 一律拦（呈现/守卫/准入同源）；releaseProtection 无租约不再 no-op 冒充闭环（须
>   服务端证据，无登记=identity-missing 拒）；恢复中心 pendingRelease 改 protection_state 驱动
>   +无租约保留项独立行；跨重启同判。无租约反例链 6/6（拦/零 outbox/恢复中心可见/无证据解除
>   被拒/none 证据解除后恰一次恢复/文件库重开仍拦）。
> - **P2 预览生命周期（产品函数级）**：previewAttachment 入口统一 releaseActivePreviewResources
>   （abort+dispose——旧 viewer 不被新轮指针覆盖后遗失）；迟到首屏/最终 DOM 提交前代次门
>   （迟到轮只清理自身不动新轮指针/面板）。verify-preview-lifecycle.cjs（原样抽取产品函数+
>   受控延迟）S1 迟到首屏不覆盖 B/S2 打开中关闭不复活/S3 失败降级+指针空——allPass。
> - **P2 Word 隔离**：docx-preview 渲染进 **Shadow DOM**（真正 CSS 边界——复核 styleId 含逗号
>   选择器可命中预览外控件的反例收口）+显式 **renderAltChunks:false**（嵌入 HTML 首版不支持，
>   不建无 sandbox iframe）。verify-word-isolation.cjs：哨兵色不变/W1-W4 allPass（含 Word 外部
>   资源可达计数器零命中——不以 PPT 计数器泛化；word-rich 三节/表/图正例）。
> - **冻结口径（review §5 更正）**：bld_a1fcfa390ddeec46 的 156×3 中 lo0vku/p1hq4y 为旧断言
>   通过、gv7hdx 为修订后通过、an7ju9 失败留档——**不是最终验证器下连续三连**。本轮修复后
>   以最终验证器在同一冻结产物重新取得连续三次完整通过（见 vdr-runs 新记录）。
> - **v4 包事实**：增量 2.074MiB（588 文件字节总量差，vendor 五文件 2.053MiB）；启动器+种子
>   幂等自测通过（二启 newMessages=0——room.pool strictObject 参数+正文标记修复）。**下一包=v5
>   独立修复包**（含许可材料随包），不覆盖 v2/v3/v4 与任何用户回填。
> - **用户操作**：v5 就绪后仅做 R1—R6 受影响项短回归（正常预置 PPT 视觉失败≠R6 通过——
>   降级呈现另列），随后 Android；**不重复 v2 D1—D10（已收案）**。
> - 零新增真实模型调用；价值评价/DEV-11/并行写入/G5 维持原约定（未开放/未宣布）。
> 历史快照（第三十八轮起）见下文各节；工程坑与旧轮细节以各轮快照为准。
## 上一轮快照（2026-10-03 第三十八轮）

> 本轮=**D1—D10 收案（v2 范围通过）+现场八缺陷修复+PPT 缺口收口+v3 修复包**。
> 收案记录=docs/implementation/dev25-dual-acceptance-record-20261003.md（D7 支持事件与
> 「编码阶段零改动」分列——server-data 曾被正式命令修改；Android/缺陷关闭/G5 分别登记不连带）。
> - **现场修复（dev25FieldFixes 3/3+页面级）**：#2 防护拒绑真实 runtime（CAPABILITY_UNSUPPORTED
>   正式错误）+设置 UI 防护包 fake 正路径（member.runtime 带 environment 标志——正式部署不出现
>   该选项）；「审计缺事件」结论不实——turn.startupFailed 本就落库，缺口在呈现（三面上屏）；
>   #7 interrupted 呈现+「恢复执行」=task.redispatch 正式重派链（幂等/不复活已停止——反例全过）；
>   #1/#8 深链跨项目判定改 projectId（原路径字符串比较=二次 loadProject 候选根因）+渲染代次守卫
>   +同项目空结果保留旧列表+审计环 window.__zsNavAudit+启动有界重试+重连补载；
>   #3/#5/#6 远程继续队列+反馈+房间 DIRECT 指派（**mentions 合同={kind:'member',memberId}**——
>   裸 displayName 被 zod 拒）+会话标题区分；#4 statusReason 人话（board.view+mine.pending）；
>   可用性=侧栏可滚+设备列表限高+LAN 虚拟网卡段标注（198.18/169.254/100.64）不推荐+
>   selfcheck pkgRoot 修正+CA 指纹。
> - **PPT（pptxPages 9/9）**：重活进 parsePool（kind='pptx-pages'+outPath 文件——IPC 4MB 上限；
>   **worker 源码指纹已含 pptxPages/zipGuard**）；缓存命中先核原件（篡改副本→命中路径拒绝——
>   反例过）；写回前重读 artifact；五缺陷修+SVG 白名单 svgWellFormed+schema 2（旧缓存全废）；
>   页面深检：首页内容/坐标/图片内联、翻页换内容+实体解码、缩放 width 实变、图表页降级标注、
>   关闭后在途构建不复活、缓存命中复用。
> - **工程坑（四连中止教训）**：①`(await rs(...).includes(X))` 的 await 组把 .includes 一起包住
>   →落在 Promise 上——TypeError 文本会剥 await/括号，按括号计数脚本定位；②多段 python replace
>   一处 assert 失败=整脚本不写盘（前面替换全回滚）；③heredoc 反斜杠折叠——String.fromCharCode(92)
>   构造（JS 模板字面量内单反斜杠=
/ 转义）；④构造中断形态的 agent_turns.member_id 有 FK——
>   假成员使整事务回滚（execSql 要 throw 不吞）；⑤closeAttachPreview 只隐藏不清内容——「重开」
>   断言须等重新可见+新内容标志；⑥ZS_VDR_SESSIONS 缺省只 A–D，全量=12 会话。
> - **数字**：dev25FieldFixes 3/3；pptxPages 9/9；本地全量 **839/839**；冻结基线
>   **bld_f4d26d38592bb521——154×3 全绿**（7opdi7/vrd0jb/lpngj8，REMOTE=28/轮+4 新记录；
>   中止如实保留：bwxt1y=CDP 表达式瞬态/1lyo7m=停止点击零到达偶发（第三十五/三十七轮已知
>   稀疏渲染窗）/m3j81g=HARNESS·D1 时序；旧产物 bld_6ca139d08a85bd7a 双绿后因 remoteClient
>   mentions 合同修复重建）；零真实调用。**v3 包=dist/desktop/dev25-dual-win-v3**（README 已并入
>   第三十七轮补充说明更正：防火墙=daemon node.exe/监听两选项+LAN 列表选址/配对码时机/
>   ca.cer 文件哈希核对法；v2/server-data/RESULTS/截图原地保留）。
> - **下一步**：①用户受影响项短回归（继续队列/中断恢复/侧栏恢复/防护拒绑提示/设备列表可达/
>   PPT 页面行为）——不重复 D1—D10；②Android 实测按指南（适配≠实测）；③其余评论锚点 FULL-03
>   后批；④DEV-25/G5 发布结论待用户短回归+Android 后再出。

## 当前真实状态（2026-10-02 第三十七轮，唯一权威快照）

> 本轮=**验收版本保持稳定+操作补充/Android 指南+PPT 静态页预览**。v2 包（dev25-dual-win-v2，
> bld_4d7928368c7da46f）用户双机人工验收进行中——**不动该包/server-data/RESULTS**；回填后
> 工程侧只读核对（未执行/失败/未确认分记，不代宣称通过）。上一轮快照（第三十六轮）紧随其后。
> - **操作补充（dev25-dual-v2-addendum.md，不重建验收包）**：防火墙监听程序=
>   ZhongshuoDual/resources/app/daemon/node/node.exe（**daemon 监听 HTTPS——不是 electron.exe**）；
>   UI 仅「仅本机/局域网 0.0.0.0」两选项（无填具体 IP 入口）——多网卡从面板 **LAN 地址列表**选
>   实际地址+端口；**CA 核对=ca.cer 文件 SHA-256**（`Get-FileHash -Algorithm SHA256`）与面板
>   「信任根指纹」比较，服务证书指纹单独记录；**信任完成后再生成新配对码**（避免 5 分钟窗内
>   过期）；结果模板追加行（两枚指纹/防火墙规则/使用的 LAN 地址）——不覆盖已有回填。
> - **Android 指南（dev25-android-acceptance-guide.md）**：信任（设置→安全→加密与凭据→安装
>   证书→CA 证书，先逐位核对 CA 指纹）→配对（触摸/上传——图片门提示用文本类）→后台恢复
>   （切后台/锁屏 30—60s 回前台自动重连+检查点续传）→独立吊销（面板吊销手机设备→立即断流
>   终态横幅）；系统与浏览器版本记录模板必填；**「证书格式已适配」与「该 Android 组合已实测」
>   分开**——无任何 Android 实测记录前不记通过；私钥只留服务机/不用绕过开关；PWA/Push 后续。
> - **PPT 静态页预览（attachment.previewSlidesPages，src/daemon/pptxPages.ts）**：slide XML→
>   SVG **受控转换**——sldIdLst 真实页序（跳号正确）+当前页 SVG（形状 EMU→px/文本段落/图片
>   base64 内联/备注页脚）+缩放（SVG 矢量客户端）；**缓存绑定版本**（daemon_state 键
>   pages:slides:<artifactId>，值含 sourceHash——不符即弃；输入=readVerifiedBlob）；**与提取
>   文本分列**（previewOffice slides 通道不变）；预算（60 页/单页 SVG 220KB/图片 2MB+总量
>   6MB）超限 truncated 标注；版面近似如实（SmartArt/图表/主题样式不渲染）。UI 双通道+页导航
>   +缩放。pptxPages 4/4（含版本绑定重传/缺图占位/超页数拒绝）。
> - **工程坑**：①**zipGuard 迁出**——parseWorker 尾部 `process.on('message')+process.exit`
>   入口曾被 commands.ts import 带入主进程（vitest 1538 个 unhandled「process.exit unexpectedly
>   called」+全量 OOM）——safeUnzip 独立成 zipGuard.ts（参数化上限），worker 侧
>   safeUnzipWith(常量)+**ZipGuardError code 透传映射**（parseLifecycle 炸弹用例核对 code——
>   曾退化成 parse-worker-error）；②小盒子文本「装不下即跳过」是受控转换的真实行为——测试
>   样本盒子要够大（10px 盒子文本被截断是如实语义）；③停止点击循环加**零到达守卫**（audit 零
>   task.stop 立即失败留现场——不再空转 95s 等自然完成的假阴性）。
> - **数字**：pptxPages **4/4**；本地全量 **831/831**；冻结三连 **142/142×3**（bld_ad0857541002b79c：
>   created b2luaj+reused 4eovnu/xtpr0x；vcjtsv/0oyein 中止如实保留——旧 ATT 断言过时+停止
>   点击零到达偶发）；零真实调用。
> - **下一步**：①用户 D1—D10 回填→工程侧只读核对；②Android 实测（指南就绪）；③其余评论
>   锚点按 FULL-03 后批；④DEV-25/G5 发布结论待双机人工验收通过后再出。

## 验收支持事件（2026-10-02 深夜 D7，插记于第三十七轮快照后）

> 用户 D7 验收中「任务一直不完成」连续受阻，工程侧只读诊断定位+最小现场恢复。**D7 用户回填
> 通过；real_calls=0**。全量缺陷报告=**docs/implementation/dev25-acceptance-defects-20261003.md**
> （8+2 项：主根因=成员被绑定 claude 后真实派发防护静默拒绝；远程无「继续队列」入口；桌面侧栏
> 列表闪现被清空——根因未定位需 ZS_DEV25_DEBUG_PORT 取证；BLOCKED/失败无解释；继续成功无反馈；
> 侧栏不显示会话标题；停机中断任务永久卡 ACTIVE；启动恢复不重试）。
> - **现场已执行（走正式命令面，回执留 v2 包 RESULTS/）**：`member.setRuntime kind=fake`×2
>   （Guide A/B 原绑定 ri_claude_89ade9281c/deepseek-flash——用户在设置中自绑，防护拒绝所有派发
>   即「不完成」主因）；`dm.resume`×3（DM A 队列解锁重泵——「测试」SUCCEEDED、「测试A」FAILED
>   于绑定恢复前；DM B 无待泵）。**v2 包 server-data 已被修改（绑定+队列状态），续后回填核对
>   需以此为基线**；诊断脚本留 RESULTS/（diag-dm-state/diag-sidebar 只读；diag-resume-dma/
>   assist-fix-runtime 含上述写操作）。
> - **用户侧要点**：房间任务=远程页固定空 mentions→AUTO→M0 门禁 BLOCKED（预期，D 系操作走私信）；
>   每任务 60s 停滞窗（ZS_FAKE_STALL_MS）内勿点停止；D7 关的是**客户端浏览器**（关服务端窗口=
>   daemon 停机，任务 INTERRUPTED）。
> - **约束**：缺陷修复合入前双机包不重交；缺陷排期由评审 AI 依据报告裁定（矩阵已加指针）。

## 上一轮快照（2026-10-02 第三十六轮）

> 本轮=**真实双机验收入口受阻→修复+普通浏览器预检+v2 包重交**。D1—D10 未执行不记通过。
> 上一轮快照（第三十五轮）紧随其后。
> - **受阻登记**：docs/implementation/dev25-access-entry-blocked.md（用户原始描述逐字保留+
>   开发机取证）。根因：旧证书生成 PowerShell New-SelfSignedCertificate 未传 -Subject——
>   实际证书 Subject/Issuer 均空+SAN 非 critical（RFC 5280：空 DN 时 SAN 必须 critical）——
>   普通 Chrome 证书查看/信任流程走不完。
> - **证书两层（remoteIdentity.ts 重写，node-forge 纯 JS）**：本地 CA（CN=Zhongshuo Remote
>   Access CA；CA:TRUE+keyCertSign critical；10 年）=用户导入的信任根（remote/ca.cer）；服务
>   证书（CN=zhongshuo-remote；CA 签发；SAN **critical** 覆盖 DNS:localhost+IP:127.0.0.1/::1/
>   实际 LAN IP——CN 不代替 IP SAN；EKU serverAuth；3 年）。**IP 变化只重签服务证书——CA
>   不变（信任一次）**。复用按实际 DER 核验：空 DN/过期/SAN 不覆盖/非本 CA 签发（X509.verify
>   CA 公钥验签）/证书私钥不配→重签重生成；旧文件入 remote/old-cert-diagnostics/<ts>/ 留
>   诊断证据（业务数据/RESULTS 不动）。私钥/CA 私钥只留服务机；程序不自动安装信任根。
>   **forge 三坑**：IP SAN 必须传二进制字节串（点分文本=畸形 SAN「invalid length=9」）；
>   authorityKeyIdentifier 会被误写为**自身 SKI**（openssl 按 AKI/SKI 配链即「unable to get
>   local issuer」——不设该扩展）；Node X509 把 IPv6 SAN 打印为全展开（canonicalIp 双侧归一）。
> - **分层核验（remoteServer+commands+UI）**：仅本机模式提示「其它设备无法连接」；LAN 启用后
>   remote.config.get 回**实际监听地址+服务证书指纹+CA 指纹+Subject/Issuer+lanSelfCheck**
>   （verifyLanBinding：服务机本机经实际 LAN IP 的 HTTPS 探测——通过=绑定/TLS 层健康；跨机
>   失败需客户端错误码再分层，不预判定性）。README：证书提示=信任层/ERR_CERT_COMMON_NAME_
>   INVALID=名称层/超时=网络层+防火墙**程序或端口+专用网络**精准步骤（不关整墙）。
> - **普通浏览器预检（scripts/dev25-browser-precheck.mjs）**：系统 Edge 无任何证书绕过开关
>   （CDP 附着只读）。Phase A 未授信=net::ERR_CERT_AUTHORITY_INVALID 拦截（区别结构无效——
>   openssl 验链+Subject/SAN 核验先行）；Phase B 工程侧临时装 CA 至 CurrentUser Root
>   （thumbprint=CA DER SHA-1 留痕）→HTTPS 页面加载+配对+WSS 事件流；Phase C 卸载→回拦截态
>   （证明通过确实来自该信任根）。**冻结产物上 8/8 PASS**（dev25-browser-precheck/
>   2026-10-021242/evidence.json）。原自动化回归（remoteAccess 36/36 等）保留，但其证书信任
>   覆盖范围（Node 显式 CA/SPKI 钉选壳）不再代表普通浏览器入口已通过。
> - **v2 包**：dev25-dual-win-v2（**独立版本目录**，不覆盖正在运行的旧包）；README 重写信任/
>   分层排查/防火墙步骤；自测实跑 .bat 全链（证据 dev25-dual-evidence/2026-10-021242-ejx5b5）。
>   坑：--out= 与 --self-test 参数顺序（argv.includes 解析）；新 Edge profile 自带扩展欢迎页
>   抢 CDP target（按 URL hint 选页面）。
> - **数字**：remoteIdentity **5/5**+remoteAccess **36/36**（REMOTE 24/24 回归）；本地全量
>   **827/827**；冻结三连 **142/142×3**（bld_4d7928368c7da46f：5wsc56/1hyhsk/niwrb0——
>   63ztvw 的 E18 跨项目线程单项竞态中止如实保留，等待加固后过）；v2 包逐文件 583/583+
>   selfTest 全链+预检 8/8。零真实调用。
> - **下一步**：①用户用 v2 包执行 D1—D10 并回填（工程侧只读核对）；②Windows+Android 双端
>   （资源已确认）；③DEV-24 最小项编码（提取文本类行评论）。

## 上一轮快照（2026-10-02 第三十五轮）

> 本轮=**两类遗漏收口+数字口径更正**：恢复链读取贯通/自检看板真异步+冻结重交。上一轮快照
> （第三十四轮）紧随其后。
> - **恢复链读取贯通（问题一）**：refreshTargets/refreshTasks 返回 {ok}——conversation.list/
>   board.view/room.list 任一失败上抛（UI 侧保留旧 targets/选项/卡片+顶部「读取失败」标注——
>   不清空、不冒充「暂无任务」；空态「暂无任务。」=成功响应确实无任务，三态分开）；loadMessages
>   包 try/catch→renderReadError+**rethrow**（room.pool 失败不再吞成空线程表）；runSnapshotRound
>   检查 targets/tasks/loadMessages 全链——任一 {ok:false}/throw→pending+原检查点；**恢复轮内
>   restoring=true 抑制 switchTarget 自动 loadMessages**（fire-and-forget 的 catch 曾吞失败并把
>   恢复链的显式 await 挤成第 3 次——计数错位实证）；**项目枚举=DM ∪ board.view(scope=all) 获准
>   项目**（纯读零派发——旧实现只从 DM 推导，房间-only 项目永远不可见）。
> - **自检看板真异步（问题二）**：selfcheckBaseline/finishSelfcheck 改 async+await dispatch
>   （旧实现同步读 Promise.data 恒 undefined→boardGroups=-1，前后 -1 相等被误判 PASS）；查询
>   失败/结构不符→boardGroups=null——**未取得数据不计通过**（detail 标注「看板查询失败/未覆盖」）；
>   反例：正常路径 detail=boardGroups=1->1（真实组数）；前置失败（dispatch 对 board.view 恒抛）
>   与结束失败（首调成功后抛）均 ok=false（1->null / null->null）且整体失败；dispatch 不 reject
>   （错误转结果对象）+try/catch——无未处理 rejection。
> - **验证器（REMOTE）**：failCmdNth(method, nth) 第 N 次命中（boot 放行、恢复链中招——
>   conversation.history/room.list 是 5s 轮询不碰的确定计数命令）；**每页单一 Fetch 守卫**
>   （再 arm 先拆旧监听器——旧监听器会对新目标请求抢先 continueRequest 的多轮竞态实证）；
>   双面判定（conversation.list 的 #1 可能被 5s 轮询的任务面抢走——错误呈现在 #tasks）。
> - **数字口径**：三冻结 report（0gk5lr/d1vbiu/u7jnz1）REMOTE 条目均 **23**——第三十四轮报告
>   写 24 系**报告数字错误**（独立开发运行同为 23 PASS；24 不存在任何统计范围）已更正；
>   本轮 REMOTE=**24**（+1「读取三态呈现」新记录；快照全口径扩四轮）。
> - **DEV-24 M3 盘点**（详见 remaining-matrix DEV-24 行）：已完成有证据=七类上传/解析/预览+
>   文本/代码/Markdown 评论锚点+安全预览/导出；未实现=图片附件级锚点（区域模型留 FULL-03
>   后批）/OCR（先方案）/PPTX 页图；**最小可交付项=提取文本类（pdf/docx/sheet/slides/csv）
>   行评论**——第三十六轮编码。
> - **数字**：remoteAccess **31/31**（+2：自检看板真异步/空态对照）；REMOTE **24/24**；本地全量
>   **822/822**；**冻结三连 142/142×3**：新基线 bld_12d1f5aeeff6a37e（created pnyar8 + reused
>   jjzix5/zd6ppj 各 583 文件核对；首次尝试 uz3rs8 在停止演练中止——TTL 断流下渲染稀疏，
>   48s 点击窗无可点行（审计零 task.stop）——停止循环改「先刷新再点+25 次」后通过，中止
>   记录保留）；**双机包=该冻结产物逐文件核对生成**（583/583+selfTest 实跑全链+证据归档
>   dev25-dual-evidence/2026-10-021005-wc0av5/）。零真实模型调用。
> - **下一步**：①用户双机 D1—D10 回填（工程侧只读核对）；②DEV-24 最小项编码（提取文本类行
>   评论）；③移动浏览器组合（R11 独立范围——手机资源确认后）。

## 上一轮快照（2026-10-02 第三十四轮）

> 本轮=**三问题收口+证据补强**：跨项目安全检查点/快照恢复去假成功/自检不动用户偏好+同请求
> 中途吊销与崩溃/自测证据归档+冻结重交。上一轮快照（第三十三轮）紧随其后。
> - **跨项目安全检查点（问题一）**：服务端按项目投递（projNext latch）+浏览器持久游标**一致**——
>   持久游标=各跟踪项目水位 **min**（localStorage zs-proj-seq 存每项目水位；zs-last-seq=检查点）。
>   根因复现：P2 1—301+P1 302、订阅序 P1→P2：首泵发 P1 302 再发 P2 前 300（单泵页 300），
>   旧客户端存全局 max=302，断线重连后 P2 的 301 永远补不到。min 检查点重连从检查点续，
>   检查点以下重投由 eventId 去重吸收；订阅时新项目水位初始化=连接基线（__connFromSeq）；
>   事件先记水位再去重。反例集：交错/超单泵页/半批断线/重连逐条核对——合并 (project,seq)
>   键集恰 302 条无漏，重投仅检查点以下（P1 302）。
> - **快照恢复去假成功（问题二）**：轮次模型（snapshotRound/snapshotChain）——后续 stale 开
>   新轮、同轮并发合流、旧轮/旧连接迟到结果不覆盖；refreshTargets/refreshTasks 失败**不吞**
>   →pending；subscribeAll 重写：只数 subscribed（cursor-stale≠订阅成功，作为 needRecovery
>   返回 staleFromSeq）、按项目去重（'ack:'+pid）、绑定发起连接（close/readyState 变化即失败）、
>   确认不全即失败；全部确认+连接未换+轮次未过时才 recovered 并把**各跟踪项目水位**推进到
>   已恢复范围（检查点不越过未恢复范围）；失败保留检查点+有界退避（≤10 次）。页面验收=
>   **CDP Fetch.failRequest 按 postData 定点断响应**（activity.list 首枪失败——确定性非时序，
>   其余请求放行）：pending 时 zs-last-seq 保持 0→退避重试成功（recovered ls=29 acks=1/1）→
>   **连续第二次 stale** 同样完整恢复（旧实现在 recovered 后 return 不处理）→每轮恢复后提交
>   新消息核对新的 WSS eventId 到达。恢复期间连接翻换（TTL 8s 自然 churn）由 wsAtStart+轮次
>   守卫吸收。
> - **自检不动用户偏好（问题三）**：根因=visibleProjectIdsOf 取 viewer **最新行**
>   （ORDER BY revision DESC LIMIT 1——不分 client_id）→空 visibleProjectIds 探针行使全项目
>   看板归零。探针改**独立测试对象** remote.pairing.selfcheckProbe：写 daemon_state 专用键
>   selfcheck:probe:<commandId>（REMOTE_BLOCKED_METHODS 封 HTTP 面——runSelfcheck 经进程内
>   dispatch 同一幂等网关+审计写入器调用），finally 清理临时键（审计行保留）；自检**任何退出
>   路径**（成功/失败/中断——finishSelfcheck 统一收口）登记不变性：导航偏好行集/全项目看板
>   组数（经 dispatch board.view）/已配对设备（自检一次性设备除外，原有设备 revokedAt 不变）/
>   在途 run 数。实测：成功+连续执行+停服失败路径均不变、probe 键零残留。
> - **交付证据（问题四）**：①同请求中途吊销反例——export.create 异步等待窗口
>   （writeExport 后/复核前，__zsTestExportHook）内吊销：提交前 run() 门禁拒绝
>   （ok:false DEVICE_REVOKED）+零回执+零新导出目录+拒绝留审计（区别于「吊销后再调用」）；
>   **stopFlow(requestStop)/gitWrite(journal) 自包 runCommand 路径补 commitGate**（异步命令
>   提交事务前同过远程门禁）。②created 轮（v20261002062722-1uolgd）REM 渲染进程中止证据归档
>   crash-evidence/：stderr 零输出/无 Crashpad dump/无 WER(1000/1001)/无资源事件(2004)/daemon
>   正常推进——**原因未能定位如实登记**；退出码未取得（验证器先于退出收账中止）已注明；
>   完整三轮均为 reused（口径保持）。③包 selfTest 证据清理前归档
>   dist/desktop/dev25-dual-evidence/<ts>/（launch1/2 原始启动输出+种子+停机事实+real_calls+
>   summary）。
> - **数字**：remoteAccess **29/29**（+3：跨项目检查点/自检不变性/中途吊销）；REMOTE **24/24**
>   （快照恢复改全口径记录）；本地全量 **820/820**；**冻结三连 141/141×3**：新基线
>   bld_19d8863a997c70af（created v20261002081030-0gk5lr 本次即完整通过 + reused d1vbiu/u7jnz1，
>   各 583 文件核对）；**双机包=该冻结产物逐文件核对生成**（583/583+selfTest 实跑全链+证据归档
>   dev25-dual-evidence/2026-10-020837-69k9b3/）。零真实模型调用。
> - **下一步**：①用户双机 D1—D10 回填（工程侧只读核对）；②等待人工期间可推进 DEV-24 M3
>   无依赖项（评论锚点按 FULL-03 分批、OCR/新视觉渠道先方案）；③移动浏览器组合（R11 独立
>   范围——手机资源确认后）。

## 上一轮快照（2026-10-02 第三十三轮）

> 本轮=**第三十二轮定位缺口全收口+冻结同源双机包重交**：设备级授权代次/共享命令门禁/WSS
> 限额与收拢实装/事件泵按项目游标/下载三修/自检去明文/浏览器信封与清算语义/双机包从最终
> 冻结产物逐文件核对重交。上一轮快照（第三十二轮）紧随其后。
> - **设备级授权代次（迁移 040 remote_devices.auth_epoch）**：invalidateDevice 只递增该设备
>   代次+撤销该设备 token/票据/活连接——**B 的现有 token/票据/WS 继续有效**（旧全局 authEpoch
>   吊销 A 后 B 也 401——多设备互相误伤，双设备正反例实证）。checkToken/票据消费/deviceLive
>   均按设备行核对 revoked_at+auth_epoch；**设备事实优先于 token 检查**（不被联动删除掩盖成
>   TOKEN_INVALID）。
> - **remoteGate 共享命令门禁**：RemoteCallContext={deviceId,deviceEpoch,gate}——dispatch 进入
>   时+**run() 业务提交前**（commands.ts 共享 run——覆盖全部写提交）重查设备/代次/会话；拒绝
>   返回 {ok:false,code:DEVICE_REVOKED} 且**留审计行**；「同上下文吊销后提交→零提交」反例。
>   吊销≠停止（已授权运行任务不受影响）。
> - **WSS 实装与收拢**：每地址未认证限额按**真实来源地址**（2/地址+全局 32——第三地址拒/关后
>   可再连/全局独立小值反例）；closeConn=发起关闭→宽限（3s 可调）terminate→核实后释放计数
>   （连接真正关闭前留在 conns——不「先移除再 close 当已退出」）；daemon.stop 有界等待收拢
>   后强杀清场（不回握客户端+stop 截止均有界完成）。
> - **事件泵按项目游标（projNext latch）**：SQL 直接 `WHERE project_id=? AND seq>?` 按订阅项目
>   过滤（每项目每泵 LIMIT 300）——**600 条未订阅 P1 不再阻塞已订阅 P2**（旧全局 LIMIT 500
>   先取再跳过=卡死）。迟订阅从 latch/authBase 续发；积压超 resumeWindow→按项目 cursor-stale
>   +水位跳当前（不无限重扫）；取消订阅即停；重连续传只补增量。authBase=认证时全局水位。
> - **下载三修**：①主文件 sha256 核验可达（旧实现 bytes 检查后 continue——同长度篡改正文可过，
>   现 410 EXPORT_TAMPERED）；②**单次受控读取**：同句柄读出字节先核验再直接进 ZIP（不再校验
>   后另 readFile——ZIP 字节恒为已验证字节）；③**资产额度与元文件分离**：额度=manifest.files
>   （≤200），index/manifest 不占——200 件资产+正文+清单=202 文件完整下载、201 件明确 413；
>   发送前重查下载权限。
> - **自检去明文（第六组合同）**：remote.pairing.selfcheckExport **废除**（曾把配对码明文写
>   daemon_state——违 R11）。新 remote.pairing.selfcheck 仅 **ZS_REMOTE_SELFCHECK=1 隔离验收
>   模式**开放（双机包启动器注入；正式产品=CAPABILITY_UNSUPPORTED）：remoteServer.runSelfcheck
>   **进程内**执行错码 401（核对配对行 fail_count 递增——证明命中真行）/伪造 Host 403/伪造
>   Origin 403/无 token 401/正码配对→session→同 commandId 恰一次（replayed=true）+
>   **remote_audit_log 本次设备/命令号/成败/重放事实核对**→自检设备吊销清理（后续 401）。
>   明文码只在进程内使用结束即失效；appData/selfcheck-latest.json 无任何凭据（正则核对）；
>   self-check.cjs 只导出结果+脱敏核对（无网络、无码）。
> - **浏览器客户端语义收口**：cmdOnce 区分**明确拒绝**（e.status!=null——信封即删，允许修正后
>   新 commandId 重发）与**结果未知**（响应丢失——信封保留沿原号重试恰一次）；存在未知信封时
>   发送键先收口原信封（不与新草稿暗中混用——新草稿保留）。**按实际提交信封清算**（settleDraft）：
>   正文被修改保留、只移除已发送 refs、B 的上传不受 A 清算影响（pending 按钮重试成功同清算）。
>   停止/验收操作键绑 run/停止代次/delivery/revision/manifestHash（旧失败不劫持新版本）。
>   **房间线程读取入口**：房间目标列线程（room.pool）→点击经 thread.history 正式命令读取→
>   线程内发送（target=thread）。**快照恢复闭环**：cursor-stale→activity.list→refreshTargets+
>   refreshTasks（同范围事实恢复）→saveLastSeq→**subscribeAll 等确认**→snapshot-recovered；
>   失败保留旧游标+pending 态+有界退避重试（≤10 次）——不冒充成功；connectEvents 取票失败也
>   持续有界退避（不只 onclose）。token 续换记 __tokenGen、成功 HTTP 记 __lastHttpOkAt（验收
>   核对新请求事实）。
> - **双机包重写（make-dev25-dual-package）**：**源=最终冻结产物 dist/desktop/vdr-frozen**，
>   拷贝后**逐文件重算 SHA256 对冻结 MANIFEST 核对**（含 daemon.cjs——第三十二轮交付包系陈旧
>   构建 bld_aeba86865045ebbf（daemon.cjs b7aa81dd）而冻结基线 bld_d96713369ac153d0
>   （060e27ef）——「同源冻结产物」声明不实，已纠正；核对事实写 RESULTS/frozen-manifest-check.
>   json）；**RESULTS 永不重建删除**（build 只重建 ZhongshuoDual/seed/selfcheck；模板只在缺失
>   时写；自测含回填保护反例）；启动器管道名按数据根（server-data/pipe-name.txt 首启随机持久
>   ——两份包互不撞）；ZS_REMOTE_SELFCHECK=1 内置；自测钩子 ZS_DEV25_DEBUG_PORT/ZS_DEV25_DRILL
>   仅自测注入。**selfTest 实跑交付 .bat**（清父环境全部 ZS_*+中文空格路径）：窗口打开（CDP）/
>   合成项目经 ui.autoOpenProjectPath 自动打开链 reload 可见/模拟模式 runtime.status=fake 明确/
>   种子+**停止演练**（--drill 真发任务→轮询执行态→task.stop→run 收口）/优雅停机 Browser.close
>   正式关窗链（requestDelivered+exitCode0+complete+非forced+无残留——taskkill 不参与成功路径）/
>   real_calls 子进程成功+stdout 整数结构核验（空不当 0）/**二次启动幂等**（reused 标记+种子私信
>   恰 2+零新 message.submit）。seed-client 幂等（revision 取 project.open 当前行——不固定 0；
>   房间/私信按名查重；附件+种子消息仅首启；认证前 close 立即 reject；写 ui.autoOpenProjectPath）。
> - **验证器坑（本轮四次迭代实证）**：①evalJs 返回 **{value} 包装**——布尔比较必须取 .value
>   （包装对象恒!==true：点击已成功却判失败）；②验收等待只认 DM「待验收交付」行——房间任务
>   看板卡验收按钮会提前满足 ANY 断言；③停止循环在途口径必须含 WAITING/QUEUED/STOPPING——
>   run 排队（同成员前一 turn 未完）时只数 RUNNING 会**未点击先 break**（audit 零 task.stop 为
>   证）；④房间宿主任务要与 DM A 错开成员（同成员串行拖结算）；⑤停止终态等待要覆盖整个 60s
>   停滞窗（停滞脚本被中断不推进——结算等完剩余窗）；⑥任务区 5s 轮询清空重挂窗口内点击会
>   落空（点击自带短重试+每试刷新）。
> - **数字**：remoteAccess **26/26**（+7：设备级代次双设备/每地址限额/有界收拢/泵模型 600 条/
>   主文件同长度篡改+200·201 边界/提交前门禁/进程内自检）；REMOTE 会话 **23/23**（+3 新记录：
>   按实际信封清算·等待期编辑保留/门禁明确拒绝→修正重发·旧稿零提交/房间线程读取入口；快照
>   恢复改「订阅重建确认+新事件经 WSS 到达」、token 续换改 __tokenGen/__lastHttpOkAt 事实）；
>   本地全量 **817/817**（githubSandbox 同次 5/5）；**冻结三连 141/141×3**：新基线
>   bld_412ace063c00ca39（created v20261002062722-1uolgd 轮 REM 渲染进程偶发崩溃中止——
>   如实保留；完整三连 v20261002062951-61bdlm / v20261002063838-hl99h4 / v20261002064717-
>   0vxmjj，各 583 文件核对）；**双机包 dev25-dual-win=冻结产物逐文件核对生成**（583/583+
>   RESULTS 保护反例+selfTest 实跑 .bat 全链通过）。零真实模型调用。
> - **下一步**：①用户按 README 执行双机 D1—D10 并回填 RESULTS/RESULT-template.md（工程侧只读
>   核对——不代宣称通过）；②移动浏览器组合（R11 独立验收范围——手机资源另行确认）；③DEV-24
>   M3 缺口推进（图片/PDF/Office 评论锚点按 FULL-03 分批、OCR/新视觉渠道先方案）。

## 上一轮快照（2026-10-02 第三十二轮）

> 本轮=**DEV-25 收口**：认证与权限补齐（重复码/审计穿透/直查漏口/异步期吊销重查）→WSS 换
> 成熟库补完整合同→浏览器页可操作闭环（20 项页面验收）→设置面纠正→**双机包交付**。
> 上一轮快照（第三十一轮）紧随其后。
> - **认证与权限**：createPairingCode 近期重复检查修复（**用历史行自己的 salt 核验候选码**——
>   旧实现拿新 salt 的 digest 与历史比较，同明文也永不相等，形同虚设；实测 AUDITCODE8 两发
>   复现+修复反例）；迁移 039 remote_audit_log——dispatchDaemonCommand 包装层写审计
>   （remoteAudit={deviceId,authEpoch} 由 remoteServer 服务端构造注入；失败也记；重放记一行
>   不重复执行业务）；events.list（补 conversation_id 列）+task.get/task.stop 按 ID 直查
>   audience 修复（assertTaskAudience——他人 DM 任务拒读拒停）；/cmd 大体（2MB）读取期间
>   吊销→派发前重查 401（读取窗口不放过；吊销≠停止——消息零提交）。
> - **WSS（ws 8.22 成熟库承接握手/帧；应用层合同自持）**：票据完整绑定（device+**origin
>   消费比对**（合法 A 签发→合法 B 使用拒——不能只测白名单外）+sessionTokenHash+会话有效期
>   +authEpoch 授权代次（吊销即全票据/连接失效））；连接保存会话有效期到期关闭→客户端换新
>   token+新票据重连（协议级实测）；**消息结构验证**（null/数组/字符串/错型 type 只关该连接
>   ——旧实现 null 首帧 TypeError 冒泡）；maxPayload=64KB（认证前小消息上限）+订阅上限 200
>   +慢客户端 bufferedAmount>8MB 关闭 1013；**事件归属**：conversation_id 缺席沿 task_id/
>   thread_id 反查真实会话（解析不出不推——不自动视为公开）；**游标按订阅门控**：未订阅项目
>   事件不推进 nextSeq（订阅建立后仍可收到——不丢待续传）；每批 audience 重查不变。
> - **浏览器客户端（remoteClient 重写）**：认证下载（export.create→**认证 fetch→Blob→
>   objectURL 真实保存**——token 不进 URL；**下载端 origin 政策修正：同源 GET fetch 不带
>   Origin 是规范行为——携带才核对，缺席凭 Authorization**）；下载服务端 audience 重查
>   （manifest.conversationId）+realpath 实根+逐文件 sha256 对 manifest 双向对账+文件数超限
>   413 不静默截断+fflate 异步 zip（重活不阻塞）；**房间+DM 任务面**（conversation.list 执行
>   态+pendingReview 验收按钮（绑定 deliveryId/revision/manifestHash）+board.view 房间卡；
>   任务状态事件驱动刷新——thread.replyAdded/message.submitted 也触发）；附件有界 base64
>   （0x8000 分块——整份展开 RangeError）+**键控草稿**（A→B→A 不串；发送成功才清实际发送的
>   正文与 refs——图片门拒绝保留）；**失败信封**（cmdOnce→localStorage pendingOps——响应
>   丢失/刷新沿原 commandId 重试恰一次）；lastSeq/eventsSeen 持久+cursor-stale→activity.list
>   快照→再订阅；token 到期 401 自动续换（**renewSession 内 CREDENTIAL_INVALID 也要进终态
>   ——该路径不走 api 包装的漏修**）；吊销终态横幅（不重连）；history 渲染代次+会话核对。
> - **设置面（四）**：完整 64 位指纹（可复制）+实际客户端地址（可复制）+证书有效期/LAN 地址
>   列表；allowLan=false 拒非回环监听（反向 refine）；currentAddress 按实际监听事实（0.0.0.0
>   给 LAN 地址；stop 清 boundPort——停用不再显示运行中）；「自检码→RESULTS」按钮
>   （remote.pairing.selfcheckExport→daemon_state——双机包 self-check 读取）。
> - **REMOTE 会话 20/20**（真实用户链路）：双私信+验收策略→启用远程+完整指纹→SPKI 钉选壳
>   （**受控自动化证书例外——报告如实标注，正式双机入口不带此开关**）→配对→A→B→A 草稿→
>   真实附件上传+消息📎呈现→**CDP 离线断响应同号重试恰一次（before=0 after=1）**→DM 任务
>   发起/页面停止（run 收口）→页面验收（三重绑定→DONE）→**认证下载解包核对**（zip+正文+
>   附件随包）→关闭客户端任务继续+重开免配对（IndexedDB 复用）→刷新续传→游标过期快照恢复
>   （ZS_REMOTE_RESUME_WINDOW 钩子）→token 到期自动续换（ZS_REMOTE_TOKEN_TTL_MS=8s——
>   **TTL=4s 会把 WS 变成断连风暴的教训**）→吊销终态→壳退出（taskkill /T——electron 多子
>   进程 kill 不收树）→桌面停机+real_calls=0。会话清单含 REMOTE 纳入冻结序列。
> - **双机包（六）**：`node scripts/make-dev25-dual-package.mjs [--self-test]`→
>   dist/desktop/dev25-dual-win（ZhongshuoDual 拷贝+start-server.bat/run-self-check.bat
>   ASCII 启动器+seed-client.cjs/self-check.cjs+RESULTS 模板/buildId+README 双机步骤）。
>   内置 ZS_APP_DATA=server-data/ZS_RUNTIME=fake/ZS_ALLOW_FAKE=1/ZS_REAL_DISPATCH_GUARD=1/
>   独立管道 zs-dev25-dual/两 Agent/首任务 60s 停滞窗（D4 停止演练）；seed 经**正式命令**建
>   合成项目/房间×2/DM A（停止）+DM B（验收）/附件样本（**等 local.token 文件出现再读——
>   seed 先于 daemon 生成 token 的时序坑**；conversation.create 返回 {conversationId} 扁平）；
>   self-check 从 sqlite 读 remote_config/daemon_state 自检码执行错码/伪造 Host/伪造 Origin/
>   无 token 负例（better-sqlite3 从包内 node_modules require）；**自测口径：父环境剔除全部
>   ZS_*（全裸白名单 Electron 不稳——USERPROFILE 系变量必需要）+中文空格临时路径两连过**
>   （seed→优雅退出→real_calls=0）。交付说明=README（服务机/客户端步骤、指纹核对、系统信任、
>   D1—D10 模板；移动端按 R11 独立范围不混入）。
> - **验证数字**：remoteAccess 19/19（11 旧+8 新协议反例）；REMOTE 会话 20/20；双机包自测
>   两连过（清 ZS_* 环境+中文空格路径）；本地全量 **810/810**（githubSandbox 网络恢复 5/5——
>   上一轮间歇失败记录保留）；**冻结三连 138/138×3**（新基线 bld_d96713369ac153d0——
>   created v20261002042441-g3vcxy + reused v20261002043259-7thzqi/v20261002044114-p48rzw；
>   会话清单=A,B1,B2,C,D,E18,REM,FS,BOARD,ATT,HARNESS,**REMOTE**；旧 118/118×3 原样保留）；
>   零新增真实模型调用。
> - **遗留（迭代中修的坑）**：页面任务区冻结在 queued 旧渲染（停滞期无事件）→5s 轮询兜底；
>   fake 停滞脚本中断不推进脚本序（第二任务同停滞）→等待覆盖停滞窗；ATT 刷新后立即读
>   DOM 的空引用→表达式空安全；同源 GET fetch 不带 Origin 属规范→下载端缺席凭 Authorization。

---

## 上一轮快照（2026-10-01 第三十一轮）

> 本轮=**导出目标与完整性收口**+**DOCX 真实 Word 布局验收**+**Activity 稳定游标/看板可见范围
> /消息操作接线**+**DEV-25 远程访问服务端全量落地（HTTPS/WSS/配对/吊销/续传——LAN-01—08+RT-21
> 全反例）**+**本机浏览器闭环（REMOTE 会话）+双机验收材料**。上一轮快照（第三十轮）紧随其后。
> - **导出完整性（exportIntegrity 9/9）**：export.create 归属先于回执（「合法会话 A+其他会话/
>   项目线程 B」整笔拒绝零产物；快照在事务内核取；拷贝后事务复核归属/audience/引用版本
>   （id+revision+hash 不变——EXPORT_CONFLICT 清理））；**回执重放不绕过当前权限**
>   （网关 runCommand 加 replayGuard——旧回执在会话归档/audience 失效后重放同号同参=明确
>   拒绝；同号异参仍冲突；上传/导出/提交三入口接入）；附件不再裸 stat/copyFile——
>   readVerifiedStoreRaw（实根/实身份/受控句柄/实际字节 sha256；**按 kind 区分 .txt/.bin
>   扩展名——text_file 用 .bin 会误判越界的实测坑**）；out-of-store/损坏=整笔失败（不冒充
>   随包也不冒充缺失）；manifest.json 与最终 assets 字节一致（写后重读 sha256 对账）；同内容
>   多引用单随包文件；system 消息保留「系统」来源；预算（消息 2000/件数 200/总量 256MB）
>   超限 EXPORT_TOO_LARGE 提示收窄不静默缩小；重活异步逐件让出。
> - **DOCX 真实 Word 验收（docxWordValidation 5/5）**：OOXML 规范修复（`<w:color w:val=…>`
>   替换非法 `<w color=…>`；表格补 tblPr+tblGrid；styles 关系移 word/_rels/document.xml.rels
>   ——包级 .rels 只留 officeDocument；XML1.0 非法控制字符清洗）。**本机 Word COM 被 WPS 劫持
>   且自动化崩溃不可用**——绕行：spawn 真 WINWORD.EXE /automation → ROT GetActiveObject 附身
>   → 校验 app.Path 为真 Office（word-open-check.ps1）。固定样本实开：长中文 17 页/60 行表格
>   不丢行/特殊字符（&<>"'+vtab 清洗+中文标点保留）/缺失附件 ⚠ 行——全部打开无修复提示+
>   Word 导出 PDF 页图证据（tests/artifacts/docx-word-evidence/ 8 文件）。
> - **Activity/看板/消息操作**：activity.list 稳定游标（(created_at,seq) 双键决定性排序——
>   同毫秒 12 事件翻页无重无漏；渲染器「加载更早」带 beforeSeq）；nav.preferences 落地
>   （navigation_preferences.visibleProjectIds 首次被消费——scope=all 聚合面按可见集过滤、
>   显式 projectId 查询不受限；无偏好行=全量兼容）；**attachMsgActions 此前从未挂载渲染链
>   （第三十轮声称的消息操作组实缺——本轮在 attachSaveButton 接线+表情层跨轮询重绘保持
>   （openEmojiLayers 集合）+md 原文行结构化**；ATT 会话 36/36（新增 Markdown 恶意样本安全
>   （脚本转义/javascript 链不落地/远程图占位）、预览搜索+行引用入正确草稿、三格式导出+
>   打开目录、线程导出守卫、Activity 定位、表情刷新保持）。
> - **DEV-25（remoteAccess 11/11 + REMOTE 页面会话 10/10）**：迁移 038（remote_devices/
>   pairing_codes/config/attempts）；remoteIdentity（PowerShell New-SelfSignedCertificate→PFX
>   +DER+SHA-256 指纹；SAN 覆盖检查复用、覆盖变化重新生成；TextExtension 不能与 -DnsName
>   同用的坑）；remoteServer（HTTPS 强制；Host/Origin 白名单=本机配置推导；/pair 唯一免 token
>   入口——原子消费+加盐摘要+5 次失效+限速 429+Retry-After；/session Device→15min token 仅
>   内存；/ws-ticket 30s 单次票据；/cmd 同 dispatch 同权限同幂等+REMOTE_BLOCKED_METHODS
>   （配对创建/配置/吊销/关停仅本机）；/export/:id/download zip 获准下载；**手写 WSS**
>   （握手+掩码帧解析+分片+ping/pong——ws 包不在依赖；首帧认证 5s 窗口、未认证限额、仅事件
>   与订阅控制、写走 HTTP；事件泵每批 audience 重查（他人 DM 不推）；lastSeq 续传+游标过期
>   cursor-stale 走 HTTP 快照；吊销立即断流；**upgrade head 前导 CRLF 容错**）；命令面
>   remote.config.get/set·pairing.create·devices.list·device.revoke+entry.ts 生命周期接线
>   （配置启用才启动；启动失败=远程面不可用不降级不拖垮本机；stop 链收口）；**Electron 本机
>   可信 UI**：IPC sender 校验（zs:* 仅 zsres://app/ 帧——不以 loopback 替代来源校验）+
>   setWindowOpenHandler 全拒+will-navigate 非 zsres 拦截；设置面「远程访问」（启停/监听地址/
>   配对码一次性展示+地址+指纹/设备清单+吊销；展开即刷新）；remoteClient（同源静态页+严格
>   CSP 无内联脚本；IndexedDB 凭据+内存 token；消息/上传/任务停止验收/导出下载/WSS 订阅
>   feed）；**本机浏览器闭环**：便携包 Chromium 作纯浏览器壳（ZS_REMOTE_SHELL_URL 钩子——
>   无 preload+SPKI 钉选信任（appendSwitch 必须在 app ready 前+标准 base64——url-safe 无效
>   两坑））——桌面造码→浏览器配对→仅记录发消息→事件流→导出下载→吊销拒绝 10/10。
> - **双机材料**：docs/implementation/dev25-dual-machine-acceptance.md（服务机/客户端步骤、
>   证书指纹核对、D1—D10 人工项、留档模板、移动端如实未测）。**用户已确认另一台 Windows
>   同局域网可用**——下轮可执行双机实测。
> - **验证数字**：本地 **797/797**（排除 githubSandbox——本机到 GitHub TLS 间歇失败 schannel
>   SEC_E_ILLEGAL_MESSAGE：波动 2/5→4/5、期间直连 ls-remote 亦败、同窗口 git push 正常——
>   网络层间歇非代码层；待稳定重跑取 5/5）；新增 exportIntegrity 9+docxWord 5+activityCursorScope 2+
>   remoteAccess 11；ATT 会话 36/36；REMOTE 会话 10/10；**冻结三连 118/118×3**（新基线
>   bld_fd894004ea2b7e91——created+reused×2 各 583 文件 SHA256 核对；旧 112/112 报告原样
>   保留；+6 来自 ATT 扩项）；零新增真实模型调用。

---

## 上一轮快照（2026-10-01 第三十轮）

> 本轮=**解析池队列身份与子进程生命周期修复**+**进程总内存硬界（Job Object）+流式 zip 护栏
> +SheetJS 官方发行版**+**缓存强校验与 PPTX 真实性**+**共享预览完善/Markdown 安全预览/
> md·html·docx 导出**+**Activity 流/消息操作/表情**。上一轮快照（第二十九轮）见下分隔线。
> - **解析池重写（parseLifecycle 8/8）**：确认缺陷修复——waiters 只存 resolve、finally 以
>   当前任务参数出队（B 被当 A 解析）且 finally await 拖延原任务返回。现完整 job 队列
>   （每项自带 kind/blob/hash/options/入队时刻/截止/结算）+调度泵串行；**响应与退出分别
>   登记——并发槽在子进程 exit 确认后释放**；非法 jobId/超预算响应 kill 收拢后按错误结算；
>   成功后不退（2s 宽限 kill）；强杀未确认=parse-kill-unconfirmed（有界不虚报）；排队等待
>   纳入端到端截止（入队起算，耗尽不启动）；启动准备期 dispose 取消；dev worker 按源码
>   指纹重建（防新源码跑旧产物）。测试逐项断言内容/类型/sourceHash（不只 ok/计数）。
> - **限额与依赖**：--max-old-space-size 只限 V8 老生代（外部 Buffer 不受约束——旧「内存
>   硬界 320MB」表述撤回）→Job Object PROCESS_MEMORY 384MB+KILL_ON_JOB_CLOSE（整进程
>   提交内存硬界；**句柄存活到子进程 exit 再关**——Assign 后即关=当场杀子进程的实测教训；
>   非 Windows/附加失败=降级仅 V8 上限如实标注）；OOM 反例（allocMB=600 外部 Buffer——
>   收拢/分配拒绝、daemon 后续命令正常）。safeUnzip 单次流式解包（元数据预检+解压过程
>   累计实际输出——超限丢块不收集；解包结果定类+解析复用；resolveZipTarget 逐段栈解析——
>   字符串 replace '../' 会误伤其中 './'）；说谎 zip（声明 1KB 实际 40MB）+合计炸弹
>   （30×20MB）双反例。**SheetJS 0.18.5（npm 端点，官方已声明过时）→0.20.3 官方 CDN**
>   （固定 URL+sha256 留档；officeDependencies 3/3 锁安装版本/锁文件来源/留档；exports
>   封锁子路径——版本字面量常量）。公式/日期/合并/多 sheet/范围注入全复验（office 10/10）。
> - **缓存强校验+PPTX 真实性（cacheIntegrity 6/6）**：parserName/parserVersion 核对适用
>   解析器+真实版本（升级/换解析器=旧缓存作废）；pdf 逐页 bytes=实际字节数+总量=Σ；
>   伪造外壳（改版本名/塞超预算字符串）判无效——组装 fail-closed+预览重提回写；**迟到回写
>   防覆盖**（UPDATE 绑 id+hash+revision——重提期间资源升级=放弃回写用内存结果）。PPTX
>   页序按 sldIdLst（r:id→rels——插页/重排/删除后编号不连续仍真实顺序）；备注经该页自己的
>   slideN.xml.rels 定位 notesSlide（编号与页号无假定）；孤立未引用页排除；**备注计入总预算**
>   （此前只计正文）；样本 slide5→slide2+notesSlide3 错号+slide9 孤立页。
> - **共享预览完善（第三十轮四）**：project.file.read（只读快照：resolve 边界+realpath 实身份
>   +文本白名单+≤256KB+fatal UTF-8——不进模型输入）；Files 面板托管附件点击→统一预览+
>   项目文件点击→快照面板；复制引用（文件名+版本+hash）/预览内搜索（行高亮+行号）/行引用
>   点击入草稿（不发送）；**Markdown 安全预览**（mdToSafeHtml 先整体转义再生成受控标签——
>   脚本/事件属性无处出现、远程图片不加载、代码只展示）；**zsres 访问校验**（host 白名单仅
>   app+路径段 '..' 拒绝+非法编码 400——不以 standard+secure 注册本身当访问校验证明）。
> - **导出（sharedPreviewExport 5/5）**：export.create（md/html/docx）——范围快照+audience
>   逐项（他人 DM 拒；两 DM 互不含）；md 结构+附件 hash 清单；html 静态净化+assets 随包
>   离线可读；docx 手写 OOXML（mammoth 回读中文/表格验证）；附件按 hash 拷入（原件缺失
>   如实标注不中断）；失败清理半截目录；同 commandId 回执幂等；zs:openPath 仅 exports/。
> - **DEV-18/19 剩余首包**：Activity 流（activity.list——domain_events 只读聚合+DM 事件仅
>   本人可见+定位深链；侧栏「动态」入口）；消息操作组（复制/引用/表情 toggle+惰性计数，
>   迁移 037）；看板 scope=all 已有（visibleProjectIds 口径不变，无拖拽直改）。消息操作
>   全集/惰性表情其余形态、跨项目汇总增强仍剩。
> - 全量 **775/775**（新增 20：parseLifecycle 8+cacheIntegrity 6+officeDependencies 3+
>   sharedPreviewExport 5-2 重算；githubSandbox 网络间歇 schannel TLS——单跑通过如实记录）；
>   冻结三连 **112/112×3**（bld_0547e205c16b1171：created+reused×2 均带 SHA256 身份核对）；
>   ATT 页面会话 30/30（本轮无新增页面断言——沿用第二十九轮）。
> - 提交分组：解析池/限额/依赖（fd115ca）→共享预览/导出/Activity/表情（19d46b8）→文档。

---

## 当前真实状态（2026-10-01 第二十九轮，存档·原快照）

> 本轮=**PDF 解析迁入可终止子进程执行边界**+**上传幂等三层与缓存 schema v2**+**真实中文/
> CMap/扫描/加密样本与视觉页面渲染（zsres+canvas）**+**图片能力门（IMAGE_INPUT_UNVERIFIED）**
> +**DOCX/XLSX/CSV/PPTX 四类与表格范围注入**。上一轮快照（第二十八轮）见下分隔线。
> - **解析执行边界（parseWorker/parsePool）**：每任务独立子进程（pdfjs/mammoth/xlsx/fflate
>   只进 worker——daemon 主进程零解析依赖）；父进程墙钟截止 30s（覆盖加载/逐项提取/结果传输/
>   收拢——超时 SIGTERM→2s 宽限→SIGKILL，**exit 确认后才结算超时**）；并发=1（子进程
>   --max-old-space-size 320MB）+队列 4（超=parse-busy）；响应 4MB 防御；daemon.stop 同链
>   disposeParsePool（在途/排队 parse-cancelled、子进程杀净）。受控故障证明 parseBoundary
>   6/6：busyMs=Atomics.wait 同步阻塞子进程时 daemon 命令亚秒响应；exitCode 注入=
>   parse-worker-exited；dispose 30s 忙任务 <5s 收拢。**旧 Promise.race 计时器销毁竞态
>   （成功路径 10s timer 摧毁提取中文档）随之消除——截止由父进程统一管理。**
> - **上传幂等三层+缓存 schema v2（pdfCacheIdempotency 4/4）**：commandId 回执预查（重放
>   不重复解析——解析池 completed 计数为证）→同会话同 hash 去重（不新建记录）→跨会话缓存
>   复用（独立 audience 各建行、JSON 原样复用）；缓存 cacheSchema=2+parserVersion+budgets
>   （预算口径变化=旧缓存作废）+页码连续——预览侧无效即隔离重提回写，组装侧 fail-closed
>   不派发；解析期间归档→事务内重检失败（不留 artifact/半截缓存/错误关联——内容寻址孤儿
>   blob 不构成业务记录）。同 commandId 异参=IDEMPOTENCY_CONFLICT。
> - **托管存储实身份（storeLinks 3/3）**：readVerifiedCopy/readVerifiedBlob 三层——字符串
>   resolve 布局+**realpath 实际文件身份**（blobstore 根被换成指向外部的 junction（Windows
>   免特权）或文件级 symlink 都检出——外部同 hash 同内容文件也拒）+**受控句柄读取**
>   （open→fstat→fd 全量读→hash 实际字节——读取期间被替换=内容不符拒绝）。
> - **真实格式与视觉预览（realFormatDocuments 6/6+ATT 页面 30/30）**：真实中文样本改
>   Identity-H+ToUnicode 码位双射（**旧 makePdf latin1 中文已丢失——第二十八轮"中文可提取"
>   口径作废重立**；CIDFontType2 缺 FontDescriptor 会被 pdfjs 判坏字体走单字节回落——补
>   占位描述符）；CMap 样本=UniGB-UCS2-H+STSong（**随包 cmaps 真被消费**：CMapReaderFactory
>   走本地 fs（Node fetch 不支持 file://）；打包形态只认同目录 cmaps——隔离副本缺资源=
>   提取降级反例）；扫描件=FlateDecode RGB 图像页（文本如实空）；加密=Standard R2/RC4 40bit
>   真实 O/U/对象密钥计算（pdf-encrypted 分类）。**视觉页面渲染**：Electron 特权协议
>   zsres://（file:// 下 ES 模块被 CORS 拦——registerSchemesAsPrivileged standard+secure）
>   +渲染器加载随包 pdfjs ESM/worker/cmaps（build-ui 同步 vendored）→canvas 每页渲染
>   （data-state/page；翻页验证用**构造性色块指纹**（页1红/页2蓝——文本单字形差对采样指纹
>   不敏感的教训）；includeBytes 一次取原件、翻页/缩放本地；扫描件像素可见）。
> - **图片能力门+WebP 补全**：message.submit 引用 image_file 且将派发（DM 默认意图/主池
>   dispatch 路由）→IMAGE_INPUT_UNVERIFIED 拒发（不悄悄省略冒充成功）；imageAck=
>   'omit-images'（UI 门禁确认条：DM 区 dm-gate/主池 send-error——确认后发送）→注入
>   【图片附件未发送】+用户确认说明（hash 资源身份恰出现一次）；record_only/线程跟进不设门。
>   WebP 头解析补 VP8（同步码+宽高 LE14）/VP8L（签名+14bit 打包）；**像素解码以 img.decode()
>   Promise 为准**（规范失败即 reject——比元素存在/onerror 可靠；页面真实 WebP 由 canvas
>   编码产生、解码对账 naturalWidth=声明宽；仅头样本=VP8L 截断（VP8 有损头 Chromium 可容错
>   解码——选样教训）解码失败如实占位）。
> - **Office 四类（officeAttachments 9/9）**：定类在 worker 按解压后 [Content_Types]
>   （zip 条目已压缩——字面嗅探不可靠的教训）；DOCX=mammoth（段落/表格有序+白名单净化
>   HTML+宏/2003 拒绝）；XLSX=SheetJS（值缓存——公式不执行；<f> 无 <v> 的格 SheetJS 整格
>   丢弃→解析器在解压 XML 自查占位「公式无缓存值」+全表标注；日期 numFmt/合并/多 sheet）；
>   CSV=自研（UTF-8/BOM/UTF-16 探测+RFC4180+分隔符嗅探；GBK 字节流明确 unsupported）；
>   PPTX=fflate+XML（按页文字+备注；页图 unsupported 如实）。zip 护栏：条目 1500/单条目
>   64MB/总量 160MB/路径穿越拒绝（fflate 返回 Uint8Array——.toString('base64') 无效的坑：
>   工厂统一回 Buffer）。**表格范围注入**：attachmentRanges（提交时校验格式/越界/超窗口）
>   →迁移 036 message_attachments.range_spec→组装 renderSheetWindow（默认=首表 50×16 有界
>   窗口；窗口外无数据不以空串冒充）。
> - **共享预览规格**：attach-preview 面板视图全局化（存量缺陷：原埋 DM 区内，池/线程视图
>   预览写入但不可见）；预览代次沿用（A/B 交错/关闭/切会话迟到作废）；office/图片/PDF 预览
>   全部经正式命令面（audience+实身份+sha256）。
> - 打包：parse-worker.cjs（esbuild cjs——ESM 输出下 mammoth/xlsx 的 require 垫片炸）+
>   cmaps 随包（pack-daemon/pack-desktop）；build-ui 同步渲染器 assets/pdfjs（vendored
>   入 .gitignore）；选型说明 docs/implementation/office-parsing-choice.md。
> - 全量 **755/755**（+28）；冻结三连与新 build 身份见本轮报告；提交分组：解析边界/幂等与
>   实身份/真实格式与门禁/Office 与范围/视觉与文档。

---

## 当前真实状态（2026-10-01 第二十八轮，存档·原快照）

> 本轮=**通知人工验收归档**+**停止领取层意图代次**+**草稿/预览/评论准确目标**+
> **图片附件首包**+**PDF 附件首包（pdfjs 随包）**。上一轮快照（第二十七轮）见下分隔线。
> - **通知人工验收通过（归档 evidence/notify-manual-acceptance-20261001.md）**：
>   bld_14f26baeb5a8d656——用户回填全符（两条通知出现/点击定位正确/无重复/通知中心留痕/
>   无异常）；工程只读核对一致（10 提醒 fired、real_calls=0；用户顺带验证确认执行链×2：
>   2 dm_turn+reminder_calls settled×2）；范围仅该 build 与该机环境（不推广全部 Windows）。
>   **不再等待新回传，用户无需再跑通知包。**
> - **停止领取层意图代次（迁移 034）**：outbox.stop_generation_at_enqueue（六入队点快照：
>   房间 initial/DM initial+泵/提醒跟进/redispatch/修复）。领取判定按意图自身代次——
>   入队后无新停止（==）=合法：忙碌时释放租约回 pending 沿串行等待（drain busyDeferrals
>   同轮跳过+开轮清空重试），不静默丢弃；被新停止超越（>）=拒绝收口不复活；旧行 -1 回落
>   保守。**预占精确绑定释放**（releaseUnlinkedReminderReservationsForDispatch——按完整
>   身份键只放本派发预占，不按 task 一次释放）。stopIntentGeneration 4/4（历史停止后新 run
>   在途又有提醒=等待不丢终态后恰一次；被超越取消+合法执行+不复活；停止前入队被超越拒绝+
>   停止后新计划对照；重启归属/预占/队列保持）。
> - **草稿/预览/评论准确目标**：draftKey=projectId+roomId+threadId（同房间线程 A/B 不再串
>   草稿）；DM 键带 project/conversation；正文/附件/mention/上传回执/发送清算同键快照
>   （send/retry 按发起键清算）。previewGeneration 预览代次（两次 await 间 A/B 交错/关闭/
>   切会话迟到作废；切会话入口即关——受限资源不留面；来源会话+所见版本标注）。
>   评论 expectedHash/expectedRevision 必填+**事务内重读核对**（VERSION_CONFLICT 不悄悄锚
>   最新）；行锚点按提取文本实际行数；quote 必须存在于正文；stale 同比 hash **与 revision**
>   （同 hash 不同 revision 反例）。readVerifiedCopy 实根校验（storeRoot 注入 previewText+
>   turnInput 经 worker——外部同名 blobstore/链接越界检出）。
> - **图片附件首包（imageAttachments 4/4）**：uploadImage（magic bytes 内容类型+头部尺寸
>   限幅 12000px/40MP/8MB；损坏截断拒绝；内容寻址 {hash}.bin）+previewImage（实根+sha256
>   原件核对；dataUrl——渲染 <img> 浏览器沙箱；OCR=未实现/模型图片输入=未认证如实标注；
>   注入不含图片数据）。消息可带图引用；图片评论随分批归属拒绝。
> - **PDF 附件首包（pdfAttachments 3/3+打包产物独立冒烟）**：pdfjs-dist（纯 JS legacy）
>   打进 daemon bundle+pdf.worker.mjs 随包（pack-daemon/pack-desktop 拷贝；file:// URL
>   workerSrc——Windows 绝对路径动态 import 需 file URL）；uploadPdf（%PDF- magic+隔离解析
>   isEvalSupported=false；加密/损坏/超 200 页/超 20MB 拒绝；提取随上传缓存迁移 035
>   artifacts.extracted_text_json）+previewPdf（分页文本+扫描件空页如实+像素渲染/OCR 未实施
>   标注）+受限注入（[第 N 页] 标注+64KB 预算+缓存脱钩 fail-closed）。
> - 全量 **727/727**（新增 stopIntentGeneration 4+imageAttachments 4+pdfAttachments 3+
>   attachmentChannels 实根用例）；提交分组：归档/停止代次/目标准确/图片/PDF/文档。

---

## 当前真实状态（2026-10-01 第二十七轮，存档·原快照）

> 本轮=**通知验收入口启动器闭环**+**附件四通道正式链/草稿键控/完整性**+**代码附件与基础评论**+
> **看板状态映射修正与动作/Files**+**历史停止代次三层误拦修复**。上一轮快照（第二十六轮）
> 见下方分隔线保留。
> - **通知启动器闭环（关键缺陷两枚）**：①chcp 65001 下 cmd 解析**含中文的批处理行会字节
>   错位**（set 行劈成 "APP_DATA 不是命令"、start 行被吞=electron 从未启动——第二十六轮自测
>   走了自设环境路径未运行交付启动器，缺陷漏网）——启动器内容改**纯 ASCII**+包内目录改
>   ASCII（app/app-data/demo-project/results；中文只留文件名与 txt 内容）；②隔离环境在
>   cmd 顶层显式设置（ZS_RUNTIME=fake/ZS_ALLOW_FAKE/ZS_REAL_DISPATCH_GUARD/ZS_APP_DATA/
>   完整前缀管道/ZS_APP_MODE=fake-sim——seed 与 Electron 同源继承；清空开发终端遗留覆盖型
>   ZS_*）。seed 停机如实化（核对退出码+stop-result；超时=失败不打印已优雅停止；按 runId
>   留档 seed-*.txt 不覆盖 result.txt）；seed 等任务终态再停机（消除恢复横幅）。
>   **backgroundThrottling:false**（实证被遮挡窗口 1.5s 轮询被节流——提醒到点 2m11s 后才
>   通知；修复后 1s/14s）+fake-sim 标题防页面 <title> 覆盖。**干净环境实测全过**（清空 ZS_* 跑
>   交付启动器 auto×2：窗口+模拟验证模式标题+项目自动恢复+无横幅/通知五相+3.5min 去重恰一次/
>   **OS 层吐司显示视觉取证**（超出 Electron shown 事件的新证据）/real_calls=0/优雅关窗
>   electron+daemon 全退）。**待用户人工复核**：Windows 送达/点击定位（双击
>   通知人工验收/启动通知验收.cmd；结果写 results\result.txt）。
> - **附件四通道（attachmentChannels 10/10）**：主池/任务线程/记录线程/DM 共用
>   resolveAttachmentRefs（存在/kind/归属会话一致——不存在/跨会话/不支持明确拒绝+同事务
>   回滚零残留——此前主池/线程发送带 attachmentRefs 被**后端静默忽略**）；输入水位正确
>   轮次（房间=根+线程跟进消息附件随重派进第二轮不回溯已完成轮；DM=水位内全部历史消息
>   ——排队附件随其消息进下一轮不提前进在途轮）；完整性（src/daemon/attachments.ts 共享
>   读取路径：**读取核对 sha256(实际字节)==记录 hash**——损坏拒预览拒组装不以旧 hash 注入
>   新文本；路径限定内容寻址存储（{hash}.txt+父目录 blobstore）；**UTF-8 字节截断保留完整
>   字符**——中文 3 字节/字符，字符串 slice 按字符数截远超字节预算的缺陷修正，原始/提取
>   大小分别注明）；草稿键控（Map 按 room:view 与 dm:{conversationId} 键——A→B→A 恢复 A
>   （切会话不再清空）；上传异步回执**绑定发起时目标键**（file.text/网络期间切换不串草稿）；
>   发送成功只清信封内实际发送 refs（失败保留正文与附件）；**真实文件字节 fatal UTF-8 解码**
>   （File.text() 有损解码缺陷——坏字节明确失败不上传替换字符））；草稿与已发消息附件芯片
>   点击经 previewText 共享文本预览（thread.history/conversation.history 返回附件摘要）。
> - **代码附件+基础评论（codeAttachments 2/2）**：kindForFilename 按扩展名推导 code_file
>   （.ts/.py/.sql 等——同一上传/预览/引用/注入链路，startTurn 实际代码文本验证；其余五类
>   不冒充）；迁移 033 attachment_comments（行号区间+选区引用 quote+正文，**锚定评论时
>   artifact_hash/revision**——资源更新后读取比对当前 hash 标 stale（行号锚点不漂移到新版
>   不重算）；audience=归属会话（他人 DM 评论/列表均拒绝）；lineTo<lineFrom 校验）。
> - **看板映射修正（boardFormalStates 5/5 正式链六形态）**：DONE/FAILED=已完成列（旧实现
>   DONE 落等待）、CANCELLED=已停止、STOPPING=停止中、INTERRUPTED=中断列停止；
>   **exitUnconfirmed=run INTERRUPTED 且该 run 存在 UNKNOWN turn 的事实**（旧检查
>   run_status==='UNKNOWN' 恒假——workflow_runs 状态机无 UNKNOWN，那是 agent_turns 状态）；
>   **stop_generation 是代次不是停止证明**；看板动作行接已有正式命令（停止 task.stop——run
>   在途才出现；通过验收 task.review——绑定展示时 deliveryId/revision/manifestHash；闭包
>   钉死目标，刷新重绘不换目标；未有命令的动作不出现）；files.view 四类分列（项目文件=
>   目录一层条目/托管附件=audience 过滤+私信标注（他人 DM 不进集合）/Agent 草稿=change_sets/
>   交付成果=#delivery= 深链——逐项来源+hash+定位；纯读零运行）。
> - **历史停止代次三层误拦（产品级缺陷，正式链实证）**：停止不响应→崩溃恢复（run
>   INTERRUPTED/turn UNKNOWN/任务回 ACTIVE）后，stop_generation>0 **永久静默丢弃一切新派发**
>   （含第二十五轮已放行的绑定提醒跟进——调度器侧修了、领取侧漏网）：①领取层 stop_generation>0
>   一票否决→改生效判定（在途/停止中 run 或非终态 turn 存在才算停止仍在生效）；②
>   stoppingOrTerminal/迟到完成守卫/两处 INTERRUPTED 用户停止判定→**迁移 032
>   agent_turns.stop_generation_snapshot**（turn 创建时快照；current>snapshot=本次停止；旧行
>   -1 沿用保守旧语义）。正式链证明：恢复后绑定提醒到点跟进派发→新 run RUNNING 列执行中
>   （历史代次仍在、exitUnconfirmed=false）。
> - 验证器升级：ATT 会话改**真实 UI 上传路径**（DataTransfer 驱动 file input change 走
>   wireAttach 全链——旧手插 DOM 芯片不算数）+非法 UTF-8 拒绝+UI 发送键控清算+已发芯片
>   预览+评论区表单+主池通道（解析器.ts→线程芯片→代码标注预览）；BOARD 会话+已完成列+
>   Files 面板断言。
> - 全量 715/715（新增 attachmentChannels 10+boardFormalStates 5+codeAttachments 2）；
>   提交分组：通知入口/附件四通道/看板 Files 停止代次/代码评论/文档；冻结新 build
>   bld_e16fe07c7c47cb17（runs 见 dist/desktop/vdr-runs/）。

---

## 第二十六轮快照（存档）

## 当前真实状态（2026-10-01 第二十六轮，存档）

> 本轮=**提醒派发与预算的准确归属**+**通知修复与人工验收入口**+**搜索过滤一致性**+
> **DEV-19 看板/协作视图首包**+**DEV-24 文本/Markdown 附件首包**+**冻结身份核对**。
> - **准确归属（迁移 030）**：跟进派发键完整身份 `task:{taskId}:reminder:{rid}:{sat}`
>   （原键缺 rid——同任务同刻两提醒撞唯一键）；归属解析：跟进键直取/修复沿源 turn 调用
>   行/追加按未挂钩预占或最近调用行——**不再按 task 唯一推断**（reminderLinkageForTask
>   降级展示用）；acquireReminderTurnSlot 移入 createRun 事务首句（**原子收敛**——组装
>   失败/创建前崩溃/重领不留指向不存在 turn 的 inflight）；无预算也入账（审计）。
>   reminderOwnership 4/4（同任务两提醒不同预算——B 的修复沿源拒绝而 A 不受牵连；
>   同刻两键不撞；绑定前普通轮零台账；重启归属额度保持；组装失败 reserved 可恢复）。
> - **通知修复**：服务端返回**准确 locate**（DM/房间任务串/讨论串区分——点击只定位）+
>   notifyMuted（目标线程静音独立过滤——不用未读聚合过滤代替；待办保留仅禁通知）；
>   五相事实留痕 zs-notify-log（只证客户端各相——**Windows 已显示留人工**）。
>   **连带修复第二十五轮字段名回归**：renderer 仍读蛇形 reminder_id（服务端已驼峰）→
>   确认按钮静默失效+「回复到达」实为 system 唤醒消息渲染成 agent class 的假阳性——
>   驼峰修复+system 独立 class，REM 9/9 恢复（确认即 dispatched）。教训：**改共享
>   命令返回字段名必须同步 renderer 消费方**（本轮第二次踩同型坑）。
> - **通知人工验收入口**：dist/desktop/通知人工验收/（新构建 buildId/独立 appData/合成
>   项目/fake+ZS_REAL_DISPATCH_GUARD=1 **内置**——用户零配置零环境变量；seed 走正式
>   daemon 管道；开发机自测通过（项目自动恢复+两条通知 created+shown+去重+guard）；
>   **人工复核已通过（第二十八轮归档 evidence/notify-manual-acceptance-20261001.md；范围仅该 build 与该机）**
> - **搜索一致性**：线程/任务分支统一作者/会话/日期过滤（线程=锚消息列、任务=根消息
>   LEFT JOIN——无根任务设日期过滤如实排除）；日期**本机时区**（北京凌晨边界用例）；
>   dev18FollowSearch 7/7。
> - **DEV-19 首包**：board.view（只读聚合——列位/退出未确认/pendingDelivery 最高一条；
>   dm_turn 不进房间看板；打开零运行）+thread.collaborators（四列分列）+renderer 看板/
>   协作视图；boardView 3/3+BOARD 会话。剩余：看板动作接正式命令的快捷入口、跨项目
>   拖拽视图（不做状态直改）、Files 集合视图。
> - **DEV-24 文本首包（四能力）**：保存副本（内容寻址 {appData}/blobstore——不在用户
>   项目目录；迁移 031）/预览+提取正文（读获准副本；原文件修改不影响；跨会话拒绝）/
>   经授权交给模型（ContextBundle.attachments→模型输入含副本实际文本+hash/revision/
>   截断说明；副本不可读=组装失败）/上传入口（DM+主池📎；草稿隔离）。textAttachments
>   5/5+ATT 会话（注入断言以 **ContextBundle 服务端留档**为准——fake 回复不引用暗号
>   不冒充）。**文本首包≠DEV-24 完成**——其余六类/评论/共享预览/导出逐项保留。
> - **冻结身份核对**：ZS_VDR_EXPECT_BUILD_ID 运行前拒绝错包（exit 3）——上轮旧冻结
>   目录教训的可执行收口；本轮三连 86/86×3（bld_fbf9a457a7117f96：created+reused×2
>   **均带身份核对通过**；含 E18 17/17+REM 9/9+FS 10/10+BOARD+ATT+HARNESS 15）。
> - 测试：本地全量 **698/698**（+ownership 4+board 3+attachments 5+search 1）；E18
>   17/17；REM 9/9；FS 10/10。
> - 下轮顺序：①通知人工验收结果回收（Windows 送达/点击——用户侧）；②DEV-19 剩余
>  （看板动作快捷入口/Files 集合）；③DEV-24 其余六类附件+评论+共享预览；④真实批次
>   仅明确新认证目标时（不重复 r20-dm/r25-rem）。
> - 坑（第二十六轮）：**改命令返回字段名必须 grep renderer 消费方**（蛇形→驼峰漏改=
>   onclick 静默 undefined——两次同型坑）；Electron details 折叠面板 DOM 仍在但保险
>   展开；CDP 端 evalJs 里模板串 `\n` 是字面反斜杠 n（用 String.fromCharCode(10)）；
>   commandId 最短 8 字符（信封校验）；测试断言「回复到达」必须区分 system/agent
>   渲染 class（唤醒消息≠模型回复）。

---

## （上一轮快照，2026-10-01 第二十五轮）

> 本轮=**提醒预算接到实际调用边界**+**命令重放/取消/确认事务修复**+**目标与授权链补全**+
> **DEV-18 关注/搜索/收藏落地**+**桌面系统通知**+**真实小批次 r25-rem**。
> - **调用台账（迁移 028 reminder_calls）**：预算口径=**模型调用数**（一个任务≠一次调用——
>   修复/追加/重派都产 turn；dispatchedCountOf 的等式不成立，已废）。派发/确认创建时持久
>   预占（reserved）；worker 建 turn 前 `acquireReminderTurnSlot` 统一检查+挂钩（在
>   createRun 前置——初始/确认/跟进/修复/追加/重派全走此处，**不能通过新 run 绕开**）；
>   终态保守计数（casTurn 统一收口：FAILED→failed、UNKNOWN/CANCELLED→unknown 均计数，
>   **重启不清零**）；turn 前取消/成员停用→released（确定未花才归还）。**max_triggers
>   触发上限独立分列**（occurrence 口径）。反例全过（reminderBoundary 8/8，断言**底层
>   startTurn 次数**）：sum=1 首轮无效格式→修复派发被拒（恰 1 次调用+任务 BLOCKED+提醒
>   paused）；追加执行不绕额度（重启不清零）；两待确认 occurrence 争最后一格恰一条获准
>   （第二条 BUDGET_EXCEEDED——预占在确认事务内先占）。
> - **命令事务修复**：confirm/update/snooze 状态类前置移回**事务内重读核对**（并发取消/
>   额度变化不被事务外旧快照放行）——错误码靠**网关领域错透传**保住（commandGateway 识别
>   DaemonCommandError 形状保 code，不再一律包装 STORAGE_UNAVAILABLE）；授权校验（audience）
>   保留在网关外每次重检；**重放先命中持久回执**（runCommand 在 handler 前查
>   command_receipts——同号重试返回首次结果原 taskId，首次成功后的状态变化不阻塞）；
>   cancel 放宽：done+待确认触发可取消并**结算待确认项**（cancelled_by_user——待我处理
>   同步消失）；正式链测试：once→待确认→取消→确认拒（/已取消/）→零 turn。
> - **目标与授权链**：绑定 threadId/taskId 的房间提醒=**跟进既有任务**（线程 system 跟进
>   消息+`task:{id}:reminder:{occ}` 派发键——worker parseInitialTaskId 扩展；不把原串跟进
>   默默变成另一个无来源根任务；讨论串（无任务）schedule 即拒）；owner 检查扩为房间成员
>   （room_members）+任务冻结名单（route_json.frozenMemberIds）+DM 对端；**停止代次按绑定
>   快照**（bound_stop_generation——绑定后**新**停止才判停，历史停止不永久禁止新合法提醒）。
> - **DEV-18 三项**（001 预埋 thread_subscriptions/thread_agent_followers/saved_items 再立功
>   ——建表前 grep 的教训第三次兑现；saved_items 以 message FK 为主键装不下链接/交付→
>   迁移 029 saved_refs 四类引用，saved_items 合同位保留）：**关注/静音**（人的阅读订阅与
>   Agent 执行名单分列；零运行零预算零模型调用；muted 排除 room.pool/mine.pending 未读聚合、
>   followed 有未读进待我处理）；**搜索**（search.query：消息正文/线程锚/任务标题+附件**只随
>   所在消息文件名**检索（正文提取未实施不冒充）；scope=project/all（全部可访问=同
>   mine.pending 口径）；作者（显示名跨项目）/日期（含当日）/会话过滤；created_at+id 确定性
>   排序分页；他人 DM 消息/线程/任务零泄露；结果带 #msg=/#task= 定位）；**收藏**
>   （saved.add/list/remove：幂等 existed；取消不删原内容；missing/forbidden 如实呈现；深链
>   跳转；link 校验 http(s)）。renderer：搜索面板（范围/类型/作者/日期+分页）、收藏面板、
>   消息☆收藏（线程+DM）、线程头关注/静音按钮。dev18FollowSearch 6/6（中文/过滤分页/同名
>   跨项目/他人 DM/失效收藏/重启保持）；**FS 页面会话 10/10**（搜索定位/收藏幂等/取消不删/
>   关注→未读→待我处理/静音清零/零 real_calls/停机）。
> - **桌面系统通知（ATTN-05/06——不再「如需」悬置）**：新待确认触发→web Notification
>   （Electron renderer）：去重（localStorage 集+系统 tag——同 occurrence 恰一次）、点击
>   定位（window.focus+#dm= 深链）、onerror→页内提示（**送达失败不改执行授权、不重复派发**）、
>   权限 denied→页内如实；静音线程不产生通知（服务端聚合已排除）；状态未变无行动项安静。
>   REM 会话验：permission=granted+去重集恰 1；**送达/点击定位的真机人工面待用户复核**
>   （如实标注——不冒充已验）。Web Push 等远程通知单列未做。
> - **真实批次 r25-rem 全过**（持续授权内新目标）：system 来源提醒**自动触发一次**+**待确认
>   →用户确认一次**；恰 2 次 startTurn 全 succeeded（cap=4 未触）、请求/响应自报双向一致
>   deepseek-flash、reminder_calls 各恰一行 settled、owner/目标会话/模板字段（DEV-21-M3）/
>   暗号回流全核对、daemon 优雅退出 exit 0；台账 real-batches/r25-rem-ledger-real.json+
>   纪要 r25-rem-result.md；演练 ledger-rehearsal（fake 零调用）。不重复 r20-dm、不清旧账。
> - **processProbe 首败条件定位**（第二十四轮全量首跑 1 失败）：真身=杀孙进程后**固定 1.2s
>   等待**短于高负载下周期快照滞后——probe 读到的最新快照仍含孙→断言失败；复跑通过≠根因
>   解决。已改**条件轮询**（等孙身份 exit_confirmed_at 落库，上限 10s）。
> - 测试：本地全量 **685/685**（+dev18FollowSearch 6+reminderBoundary 8）；E18 17/17；
>   REM 9/9；FS 10/10。
> - 冻结三连（本轮新 build）：**76/76×3**（bld_e5a7b95968c8655f：afblyq=created →
>   2pf8b3=reused → wzuqxa=reused——逐文件 SHA256 复用核对；含 A/B2/C/D 同步点+E18 17/17+
>   REM 9/9+FS 10/10+HARNESS 15）。前置排障：首两次全序列在 E18「两线程未读」超时两连挂、
>   同构建单跑与 HARNESS+E18 组合全过——**真身=dist/desktop/vdr-frozen 遗留 round-22 旧冻结
>   产物**（bld_3b44ff…，commit ddc36bd，9-30 14:38——不含 23-25 轮 renderer 修复；FROZEN
>   复用逻辑见 MANIFEST 即用旧目录=与当前验收需求不符）。删除后以当前提交重建冻结三连全过。
>   教训：**冻结目录跨轮遗留必须先核 buildId/commit**（新旧源码差一轮以上时旧冻结必不符）。
> - 下轮顺序：①全序列若再现同处失败→专项取证（负载窗口内 room.pool 轮询时序）；②DEV-18
>   交付矩阵未做项如实保留（Activity 流/消息操作全集/惰性表情——不宣布全包）；③通知真机
>   人工复核项交用户；④DEV-19 看板/DEV-24 首类附件（矩阵新序）。
> - 坑（第二十五轮）：**DOM 持久陷阱**——hidden 容器的内容不消失，waitFor 断言必须看
>   classList 视图真伪（'thread' hidden+pool 可见）而非内容存在；**关注行测试时序**——关注
>   须开线程（顺带标读）→关注行只能测「关注之后到达的回复」（素材线程要在测前一刻发）；
>   网关事务内领域错不再包装（但**新命令**的前置校验放事务内才有并发安全——错误码靠透传）；
>   一个任务≠一次调用（修复/追加/重派）——预算必须挂在 turn 边界。

---

## （上一轮快照，2026-10-01 第二十四轮）

> 本轮=**E18 两项遗留收口+验证器缺陷修复**+**DEV-23 核心合同重做（提醒正式化）**+**一处
> 第二十三轮遗留回归修复**。三类错误分别登记（验证器/产品/迁移——不一概归验证器）：
> ①**验证器错误三处**：678 行表达式多一个 `}`（`} })()`→`}))()`——evalJs 报 error 被当空
> DOM 读成「渲染瞬空」；新增 `readStrict`（error/异常即抛——读取失败与空 DOM 分开报告，
> E18 断言读取全部换严格）；跨项目 fixture 用 `directory_identity='{}'` 直插项目（正式
> project.open 按目录身份去重→另建 vdr-fixture-b=跨项目切换必败）——改**段 1 末尾经正式
> project.open 创建项目 B**（真实 projectId/引导成员/默认房间；seed 只补业务数据）。
> ②**验证器环境语义**：段 1 三项失败（线程标读/多待验收计数/前台贴底）两连复现真身=窗口
> 被遮挡（Electron occlusion→原生 document.hidden=true→markRead 全程零发出——后台不标读
> 是**正确合同**；round-23 四连过时窗口恰好可见）——验证器显式声明前台（hidden 固定
> false+`__zsSetHidden` 开关），非产品缺陷。
> ③**产品回归（第二十三轮遗留）**：task.review 服务端必填 manifestHash 但 renderer
> `reviewTask` 未发送+task.get 的 pendingDelivery 未返回 manifest_hash——房间线程验收/
> 拒绝 UI 链路自二十三轮起必失败（A 会话自二二轮冻结全序列后首次重跑才暴露；DM 验收链
> 二十三轮已同步修，房间线程漏了）。双层修复。
> **E18 结果（同一次完整运行）**：17/17 全过（runId v20261001021358-k9k47q；两项遗留
> 收口：13 项可达 head=共 23+第 13 条存在；跨项目深链=正式 project.open fixture 下切换
> 来源项目+线程打开；刷新/前进后退/他人 DM 全形态拒绝/错 hash/重复验收/零 real_calls/
> 双停机事实/无残留）。另次完整基线 65/65（runId v20261001022443-gmvh5i，buildId
> bld_b5b3227bc6b68ed1：A/B2/C/D 同步点+E18+REM+HARNESS 逐次留报告）。
> **DEV-23 正式合同重做**（首包六处实质缺陷全修，调度器整体重写）：
> - **computeNextAt 任意分钟**：09:17/23:59 可达（原 15 分钟步进只能命中特定分钟——「每天
>   此刻」多数分钟必失败）；naive-UTC 起步+分钟差归一化修正算法；**DST 规则明确化**（不再
>   「交给 ICU」）：春季跳变不存在的时刻→当日跳过取下一计划日（gap 内振荡检测）；秋季回拨
>   重复→取较早实例——真实转换日断言（America/New_York 2026-03-08 02:30 无解→03-09；
>   2026-11-01 01:30=05:30Z 第一次出现）；validateSchedule（时分范围/IANA 时区/weekday/
>   once.at——25:99、Nowhere/Zone 拒绝）；weekly 按**本地日历日**星期判定；update 同步
>   timezone 列（旧实现改计划不同步列）。
> - **原子触发（崩溃窗口闭合）**：CAS 领取+计划推进+last_fired_at+唯一 occurrence+派发
>   意图（消息/任务/outbox 键）**同一事务**——原五段事务存在「领取后崩溃=丢触发」「occurrence
>   pending 无恢复路径」；派发中途抛错=整体回滚（测试：注入故障→零 occurrence/零任务/
>   next_at 不动→重试恰一次）；意图提交后执行结算前=worker 既有恢复合同（outbox 持久）；
>   首包遗留 pending occurrence 构造时收案 merged（不重发）。执行复用既有正式链
>   （DM→createDmTurn+`dmtask:` 键；房间→createRoomRootTask+`task:` 键）——不自建第二套。
> - **休眠错过推导**：missed=计划在 (last_fired_at ?? created_at, now] 的触发数-1——
>   countScheduledBetween 从实际计划推导（原实现依赖预插 pending 行=不能证明真实停机）；
>   测试无预插 occurrence 跨日停机→恰一次合并触发。
> - **预算 fail-closed+正确作用域**：作用域=**本提醒已派发 occurrence 数**（每次派发恰一
>   个任务=恰一次 startTurn 计数；与派发同事务=预占原子）——原实现统计**全库 real_calls**
>   （他项目调用消耗本提醒额度）；损坏 budget_json 拒绝派发+paused 取证（原 catch 放行）；
>   超限=paused+budget_exceeded occurrence（不冒充）。并发：独立连接写锁争用让出
>   （busySkipped）+预领取让出（lost-race）——恰一次派发（受控同步点+收紧 busy_timeout）。
> - **权限/幂等（REM-5/6）**：五命令统一 audience（他人 DM 提醒不泄露不可操作——
>   reminderId 不能绕过）；owner=项目成员+启用；**DM 只能唤醒该对话对端 agent**；taskId/
>   threadId 归属校验；sourceRef 字符串不构成授权（autoDispatch=显式授权位，创建时落库
>   冻结）；schedule 的 reminderId **事务内**生成+返回 r.data（重放返原 ID——原网关外
>   重生成=重放返回未持久化新 ID；同号异参=IDEMPOTENCY_CONFLICT）；snooze bump revision；
>   cancelled 不复活（update 显式拒绝）；前置只读校验移出 run()（网关会把事务内领域错包装
>   STORAGE_UNAVAILABLE——保住 FORBIDDEN/SCOPE_MISMATCH/VALIDATION_INVALID/REVISION_CONFLICT
>   正式错误码+状态未变断言）。
> - **正式执行（REM-8/9）**：**不伪装人类**（唤醒消息与任务输入 author_type='system'+
>   author_id=`reminder:{id}`；原实现插 author_type='human' 假冒用户发言却返回 dispatched）；
>   未授权=awaiting_confirmation+唤醒消息（DEV-21-M3 模板携带 occurrenceId/scheduledAt/
>   timezone/missedCount/sourceRef/预算/授权——消息与输入同源）→**正式确认入口**
>   reminder.confirm（确认时刻重查授权+预算；mine.pending reminderAwaits=待我处理可行动项；
>   renderer 确认按钮）；已授权=直接正式派发（DIRECT 只唤醒 owner）；**turnInput 根作者
>   扩展**（isAcceptableRootAuthor：human 或 system+reminder: 前缀——原组装拒绝非 human
>   根消息=提醒任务永远无法执行的产品缺口）；本地协议+fake 正式链验证：创建→到点→获准/
>   确认→恰一次执行（run SUCCEEDED+回复落目标会话+输入=模板体）→停止/重启可解释
>   （reminderFormalChain 4/4）。
> - **管理入口（REM-10）**：侧栏「提醒管理」面板（列表：计划/时区/预算/下次触发/状态+
>   暂停原因/最近 5 条 occurrence 历史；操作：编辑（once/daily/weekly+任意分钟+时区+
>   自动执行开关，revision CAS）/贪睡 1 天/取消/恢复（paused 显式继续——错过的批不补跑，
>   授权类暂停下次触发重查再判））；REM 页面会话 8/8（⏰ 创建→改 once 近未来→到点→待我
>   处理确认→执行回复落会话→面板 dispatched 历史→贪睡/取消→零真实调用→停机事实）。
> - **通知如实（REM-11）**：通知面=会话内系统消息+待我处理入口（**应用内**——不接桌面
>   系统通知，帮助文案如实声明）；状态未变无行动项安静；唤醒消息确定性 id 幂等=送达失败
>   不导致重复执行（执行按 occurrence 一次性）。
> - **daemon.stop**：第一步 reminderScheduler.close()+clearInterval（原只停普通 tick——
>   提醒定时器可能在收拢/关库后继续跑）；单实例调度器（原每 tick new）。
> - 迁移 027（reminders 增 auto_dispatch/last_fired_at；occurrence 增 task_id/confirmed_at
>   ——表 001 预埋，只 ALTER）；批次脚本 callsDetail 列名修正（request_model 不存在→
>   model AS request_model——022 实为 model 列；上轮 finally 静默吞错=callsDetail 恒 null）。
> - 测试：本地全量 **671/671**（+reminderScheduler 重写 20+reminderFormalChain 4；首跑
>   1 失败=processProbe 周期快照断言复跑两轮全过，如实登记）；**桌面完整基线 65/65**；
>   E18 17/17。
> - 下轮顺序：①DEV-18 关注/搜索/收藏（既定首版范围——不扩大完成声明）；②DEV-23 收尾
>   （桌面系统通知如需接入须实证送达/点击定位/失败反馈；真实 deepseek-flash 小批次仅在
>   有明确新认证目标时建立——不重跑 r20-dm）；③冻结序列在新 build 重取三连基线。
> - 坑（第二十四轮）：CDP 读取必须先查 error（readStrict——语法错误≠空 DOM）；验证器驱动
>   的窗口可能被遮挡（Electron occlusion→document.hidden=true）——测前台语义须显式固定；
>   网关 run() 内领域错被包装 STORAGE_UNAVAILABLE（前置只读校验移出去保错误码）；turnInput
>   根消息查询列清单要与校验字段同步（author_id 漏选=恒 undefined）；SQL 别名 AS 要对齐
>   真实列名（real_calls 是 model 不是 request_model）；整轮回归过的会话（A）改了共享
>   合同（task.review 必填参数）后必须同步**所有**调用方（renderer 房间链漏改=下轮全序列
>   才暴露）。

---

## （上一轮快照，2026-09-30 第二十三轮）

> 本轮=**runtime 路径回归修复**（executable 穿透：resolveMemberRuntime 返回实际可执行路径+
> adapterFor 传工厂（缓存键含路径）+resolveClaudeExecutable 显式路径一律按绑定执行**不静默
> 回落全局**（Windows 非 .exe 静默换默认的坑）；memberExecutablePath 3/3——本地协议 shim
> 零真实调用证明绑定 A 执行 A/切 B 执行 B/无效路径明确失败）+**DEV-18 补齐**（后端：
> thread.markRead（001 预埋 thread_read_states——曾误建 026 撞表，已改对齐既有列）+房间主池
> 线程未读聚合；deepLink #task/#delivery/#msg 全分支统一 audience（他人 DM 任何形态不可达）；
> mine.pending 不泄露（他人 DM 任务/未读/标题过滤）+blockedTasks 如实列出（可见≠审批）+
> 无 pending 交付=actionable:false（不因聚合成为可批准对象）；task.review **manifestHash
> 三重绑定**+DM audience；renderer：renderDm 每次 await 后三元组+代次核对（A→B→A）+视口
> 贴底标读（后台窗口/滚看历史不推进水位）+滚动位置保留；renderThread 线程标读；
> hashchange/popstate 统一导航（跨项目=deepLink.rootPath→project.open 切换来源项目——
> canonicalPath 比对）；待我处理全量渲染（无截断/总数头/条目带四重身份+来源项目/进入定位
> 对应交付）；dev18ReadPending 11/11）+**页面验收 E18**（新 build 零真实调用；两段式：
> 段 1=两线程未读/读 A 不影响 B/同会话多待验收/A→B→A/后台不标读+前台贴底清——7/7；段 2=
> 13+ 可达/错 hash 拒/重复验收拒/跨项目深链/刷新/前进后退/他人 DM 拒/零 real_calls——
> 结果见下）+**证据收口**（真实批次 journal 可追回：pid 级「重启共享额度」原始证明——
> 前 3 次 pid=15328/第 4 次 pid=64208；补充材料 real-batches/r20-dm-ledger-real-supplement.md
> （不可追回项如实注明：real_calls 明细/响应自报模型/正文——成功清理规则所致，登记为证据
> 缺口不默认等于请求模型）；批次脚本改清理前抓取 callsDetail/identities；冻结口径纠正
> **28/28**（上轮误报 29/29——report.json 恒 28 项）；全量首跑失败真身=githubSandbox「pull
> 快进」顺序依赖真实仓状态（writeFileSync 前 test/ 目录未建→稳定 ENOENT），已修自包含）+
> **DEV-23 首包**（026 增列（表 001 预埋——同坑二次避开：reminders/occurrences 全在 001，
> ALTER 加 title/paused_reason/owner_user/created_at/updated_at/fired_at/outcome/
> missed_count）；ReminderScheduler：occurrence (id,scheduledAt) 唯一+CAS 领取+并发/重启不
> 重复、休眠错过合并为一个触发（merged+missedCount 不逐次补跑）、触发时重查（会话归档/
> 任务停止/owner 移出→paused+suppressed，恢复不自动补）、预算拒绝（budget-exceeded 不派发
> 不冒充成功）、computeNextAt 服务端 UTC 化（ICU 步进匹配——不依赖模型）、时钟注入假时钟；
> 命令面 reminder.schedule/snooze/update/cancel/list（revision CAS）；entry 15s 接线
> （ZS_REMINDER_DISABLED 可关）；renderer 最小入口（DM 头部⏰每日提醒）；reminderScheduler
> 8/8——假时钟驱动 once/daily/时区/唯一键/重启/合并/停止竞态/预算拒绝/命令面）。
> - 测试：本地全量 **655/655**（+8 reminderScheduler+1 memberExecutablePath+4 dev18 补齐）；
> dev18ReadPending 11/11；E18 段 1 7/7；githubSandbox 网络抖动（TLS SEC_E）复跑通过如实登记。
> - **E18 结果（十一轮迭代后如实）**：段 1 **7/7 连续四次稳定全过**（两线程未读/读 A 不
>   影响 B/同会话多待验收全列/A→B→A 代次/后台 hidden 不标读/前台贴底清/停机事实）；段 2
>   4/6——错 hash 拒绝+重复验收拒绝 PASS、13 项待办渲染与跨项目深链切换**两项遗留**（现象
>   稳定复现、根因未定：13 项=waitFor 判定通过后瞬时读取为空【fragment 原子替换已做仍未
>   解——疑 mine.pending 二轮竞态】；跨项目=页面错误文本为空【deepLink.resolve 未抛——
>   疑 hashchange/loadProject 完成路径】；runId qzvf0h 现场保留）。前序失败均为验证器缺
>   陷逐修（计数挤爆/A→B→A 索引反/hidden 时序反/026 撞表致 daemon 拒启/heredoc 转义）。
> - 下轮顺序：①E18 段 2 两项遗留定位收口（活体诊断法已验证有效——同 appData 起实例直查
>   DOM）；②DEV-18 页面层剩余（关注/搜索/收藏仍保留）；③DEV-23 页面闭环（提醒管理页/
>   通知面）与真实通知；④冻结产物序列在新 build 重取基线。
> - 坑（第二十三轮）：001 预埋表清单要先进 grep（thread_read_states/reminders/
> reminder_occurrences 全在 001——026 两次撞表教训）；mine.pending/页面渲染的瞬时读用
> waitFor 稳定条件；E18 失败现场按 runId 自动留档（截图/进程/stderr 全保存）定位极快。

---

## （上一轮快照，2026-09-30 第二十二轮）

> 本轮=**C/A 间歇根因闭环**（早到点击静默丢失：CDP target 出现≠页面可操作——onclick 未绑定期
> 点击被丢弃；修=open-folder 初始 disabled+`window.__zsReady` 标志+验证器 waitInteractive；
> 另修**管道名形态**：裸名 daemon listen 自动补 `\\.\pipe\` 而 UI connect 不补=永远连不上）+
> 验证器重写（runId 目录留档=stderr 时间戳/截图/进程清单/元数据，报告永不覆盖；ZS_VDR_FROZEN=1
> 冻结产物逐文件 SHA256 核对复用——**同一产物连续三次完整 A→B1→B2→C+D 全绿**：首跑 nji19t
> 27/28（验证器探活时机缺陷，产品行为正确）→修复后 szzu9n/evqq6p/cur0jt 三连 **28/28**（每轮
> results 恒 28 项——上轮汇报"29/29"为口径错误，本轮据 report.json 核实纠正）+D 同步点
> 真窗口（D1=真正 listen 之前延迟（beginStartup 重构）；D2=daemon 侧响应延迟钩子+ZS_DAEMON_
> LOG_COMMANDS 按**实发 commandId** 核对回执恰 1（contextBridge 只读——页面 patch 不可行）；
> D3=ZS_UI_SHUTDOWN_DELAY_MS 受控退出延迟+新旧实例共存探活）+HARNESS 零真实调用自检 12/12
> （fetch/WS/evalJs 死循环全截止、exitWithGuard 已退出 child、三同步点时间线因果）+
> **abort 语义修复**（readyAbort 认证后移除监听——关停不再销毁已建立连接=不再被迫强杀）+
> DM 收口（统一解析层 resolveMemberRuntime：kind/model/installation/**permissionMode**/cwd 一
> 份事实，worker 与 adapterFor 同源；身份冲突 observedSessionIds——init=Y/result=X/resume=X
> 不冒充续接+dm.sessionIdentityConflict；settle 失败明确重试 retryFailedDmSettlements+重启收案
> recoverAbandonedDmVerdicts+取消路径释放 pending；**generation 撞键修复**（结算失败轮行缺
> 失→计数退化→唯一键冲突——代次=行数+在途未结算数））+批次脚本收口（spawn 引用+正式停止链+
> 演练同款断言去 rehearsal||+B 独立性=身份+输入水位+输出归属+报告分列 r20-dm-ledger-{mode}+
> 崩溃注入 a2mid 验证即停与收拢）+**DEV-18 首包落地**（markRead commandId 幂等+未来水位拒绝+
> UPSERT 房间首标+固定目标防 A 迟到标 B；mine.pending 权威汇总——同会话多 REVIEW 逐任务不漏+
> 交付绑定 deliveryId/revision/manifestHash（pending 优先/最新回退/null 如实）+DM 未读；
> deepLink.resolve dm/task/delivery/msg 真实归属+矛盾明确报错；renderer 待我处理区+通用深链+
> 导航代次防护——全部纯读零新增运行）。
> - **真实批次 r20-dm 已执行：17/17 全部通过**（A1 暗号回流+真实 provider 身份持久→A2 原生
> 续接（resume 请求=上报，真实 UUID 一致）→B 独立（身份互不相同+输入水位属 B+回复落 B+不含
> A 暗号）→重启 A3 resumed=2；startTurn 恰 4 次全 succeeded、护栏 reserved=4 未触 cap=8、双
> daemon 优雅退出 exit 0；台账 real-batches/r20-dm-ledger-real.json）。
> - 测试：本地全量 **640/640**（+7 dev18ReadPending；首跑 1 失败复跑两次未复现——第二十三轮
>   定位真身=githubSandbox「pull 快进」用例顺序依赖真实仓状态（writeFileSync 前 test/ 目录
>   未建→稳定 ENOENT），已修为自包含 mkdir——失败记录不因后续通过而抹除）；dmDirect 19/19；
>   claudeResumeFacts 4/4；
> 批次演练 15/15+崩溃注入即停收拢验证；全量首跑 1 失败复跑两次未复现（偶发，如实登记）。
> - 下轮顺序：①DEV-18 首包 renderer 层验证（页面待我处理区/深链/阅读水位实测——本轮 daemon
> 层 7/7 已过，页面层 e2e 待做）；②DEV-23 提醒首版；关注/搜索/收藏仍为 DEV-18 剩余项（不扩大
> 完成声明）。
> - 坑（第二十二轮）：contextBridge 注入对象只读（页面 patch 不可行——用 daemon 命令日志钩子
> 取实发 commandId）；node `replaceAll` 不支持字符类正则语法；CDP target 出现≠load 完成；
> SQL SUM 空集=null；冻结复用模式下验证器自身改动不影响冻结核对（核对的是产物文件）。

---

## （上一轮快照，2026-09-30 第二十一轮）

> 本轮=renderer 无反馈挂起根因修复（IPC handler 先注册+去 alert 阻塞+第十九轮静默丢失的
> dm-create 成员选择器/dm-review 按钮绑定补齐；B2/C 从"验证器内打不开项目"到全链通过）
> +DM 续接身份链终态结算制（空 ID 回填/空串不作候选/openSession 返回≠接受/按安装身份/
> Claude 真实时序 fixture 6/6）。本地 dmDirect 15/15。
> - **独立机回传已归档通过**（第十八轮：bld_c2f364d06ff0014e，daemon 11/11+renderer 9/9+
>   人工 6/6；docs/implementation/evidence/bld_c2f364d06ff0014e/）——**不再等待用户操作**，
>   旧包不作废声明、用户无需再跑旧包；新包=新 buildId。
> - renderer 验证器：ZS_VDR_SESSIONS 会话选择（单独 B2/C 与完整序列分别出报告）；会话 D=
>   受控同步点（daemon 延迟就绪/首命令延迟/上一实例退出延迟）。
> - 下一步：①最小真实 DM 批次（deepseek：A 首轮→A 续接→B 独立→重启续接；经第十九轮
>   fail-closed 护栏记账；身份/协议/预算问题即停）；②DEV-18（待我处理/阅读水位/未读/深链
>   正式闭环——房间/线程/私信+交付版本）；③DEV-23 提醒首版。
> - 坑（第二十轮）：python 文本替换必须 assert 命中（第十九轮两处静默 MISS=按钮无绑定/
>   prompt 残留，验证器 C 卡两轮）；两个验证器实例并发会互相 rebuild/抢端口——自造失败。

---

## （上一轮快照，2026-09-30 第十九轮）


> （历史快照——独立机已于第十八轮回传归档通过，「等待回传」不再有效）
> 本轮=独立交付包重构（最终包 buildId bld_c2f364d06ff0014e/commit 0b99979 clean，开发机自测
> daemon 11/11+renderer 9/9+故障 2 路径）+**真实派发硬隔离 ZS_REAL_DISPATCH_GUARD**（R15 事故
> 收口：spawn 前拒绝真实 runtime；配置读写不受影响；生产不设=正常）+成员启停设置（协作参与
> 闭环）。本地 565/565、零真实调用。**旧独立包作废——用户复制 dist/desktop/独立交付/ 本版**。
> - 协作限制/文件修改策略**均无后端命令**（前快照「后端就绪」有误已修正：单写者硬编码+只读档
>   硬编码）——需设计先行；本轮真实闭环=member.setEnabled（含 UI/校验/持久化）。
> - 坑：run() 内抛领域错被幂等网关包装成 STORAGE_UNAVAILABLE（校验移事务外）；主池 ORDER BY
>   created_at DESC=最新在前（等新卡按数量增加判定）；task.get 增 lastStartupFailureMessage→
>   UI 状态行显示启动失败原因。
> - 下一步：①等待用户回传独立包结果（不阻塞）；②协作限制/文件修改策略设计任务书；③后续真实
>   批次改 **startTurn 级计数**（deepseek-flash 持续授权内自行立批）；④交付矩阵依赖已满足项。

---

## （上一轮快照，2026-09-30 第十五轮）

> 本轮=便携 renderer 真实用户链路验收（17/17）+启动/停机修正（verify-desktop 9/9）+设置交付组
> （成员 runtime 绑定真实闭环）+真实批次 R15（正常链+停止链全过）+独立 Windows 交付材料。
> 授权更新：**Claude Code+deepseek-flash 持续授权**（用户原话「批准，deepseek 的预算很多，可以
> 随意使用」——仅该渠道；旧价值批次 30/33 原样不追改；逐批写目标/上限/停止条件）；**用户有另一台
> Windows 机**——独立交付已备（dist/desktop/独立交付/：MANIFEST+自足 verify-local（开发机自测
> 8/8）+一页说明），待用户回传结果。
> - 数字：本地 562/562（60 文件，githubSandbox 未重跑——远端链未动）；verify-desktop-renderer
>   17/17；verify-desktop 9/9；real-batch-r15 11/11；independent verify-local 8/8；lint/tsc 0。
> - **renderer 验收**：CDP 真实页面操作全链（任务提交/验收经按钮——main 演示仅作宿主 smoke）；
>   残留检测控制组=decoy 先证检测有效；leftover 修正=QUERY-OK 尾标（失败≠0）+排除自身+任意名载体。
> - **停机事实**：desktop-shutdown.json（送达/退出码/超时/强制/未确认/stopRecord）+daemon 尾行
>   stop-result；window-all-closed 先发命令再关管道（否则 requestDelivered 恒 false）。
> - **设置组**：成员 runtime 绑定（读 member.runtime/写 member.setRuntime/校验/失败提示/能力分列/
>   重开保持）；既有=任务验收开关、仓库状态显隐。未接 UI 但后端就绪=协作限制/文件修改策略（下一批）。
> - **真实批次 R15**（台账 docs/implementation/real-batches/r15-ledger.json，脚本硬顶 2 次先记后发）：
>   ①正常链 DONE（受管 job+资源回收+暗号回流+deepseek-flash $0.039）②停止链（RUNNING→task.stop→
>   CANCELLED+零交付+进程收拢）。**事故记账**：renderer 首版 2 笔真实 turn（绑定持久化未隔离——
>   $0.145）；已修复：fake 场景前置/绑定后不发送/停止场景独立 appData。教训=默认验收与真实入口必须隔离。
> - **坑**：contextBridge 对象不可 monkey-patch（CDP tap 无效→全 DOM 信号驱动）；PS -File 参数含空格/
>   中文被拆（pattern 走环境变量）；electron 池卡片第一张=最旧任务（点最新）；并发单例拒绝的退出可能
>   发生在等待 listening 期间（runDaemon 内挂 exit 监听才不丢事实）。

## 当前下一步（历史·第十五轮——已被上方第二十轮快照取代）

1. **无需等待直接开工**：设置页下一组（协作限制/文件修改策略——先补后端命令面）；交付矩阵依赖已
   满足项；真实能力补证（持续授权内按批次台账执行——受管链已过，可扩至依赖已满足且有明确验收
   目标的项：如真实 push 前置检查/git 只读链）。
2. ~~**等待用户**：独立 Windows 环境回传~~（**已完成**：第十八轮归档通过——证据
   docs/implementation/evidence/bld_c2f364d06ff0014e/，用户无需再跑旧包）。
3. **价值评价（用户决定暂缓）**：不放回待办；旧批次剩余 3 次不动用；真实 lateEvents=unsupported；
   写档入口关闭；并行写入延期。

---

## （上一轮快照，2026-09-30 第十四轮）

> 本轮主线=环境块纠正（一）→jobId 正式绑定（二）→打包验收 v2（三）→DEV-15 桌面便携产物（四）→merge 多父 diff（五）。
> 提交：9caa4c3→118effc→262ffa2→dc9e1d9→bb12344→文档组。数字：本地套件 **562/562**（60 文件，
> 排除 githubSandbox 5 例——远端链未动未重跑，最近全绿=十二轮 5/5）；verify-pack **17/17**、
> verify-desktop **6/6**、g3 fake 回归 1/1；零模型调用、零真实认证。
> - **环境（9caa4c3）**：第十三轮「非空块恒 87=koffi 缺陷」**撤回**——根因=缺
>   CREATE_UNICODE_ENVIRONMENT（UTF-16 块被按 ANSI 解释）。规范块（大小写不敏感去重/排序/双
>   NUL/undefined=删除）+真实子进程回读全过；「关闭受管开关绕行」建议已删。
> - **jobId 绑定（118effc）**：迁移 020（managed_job_id 正式列）；登记/adapter 契约
>   （AdapterProcessIdentity.managedJobId）；probe/reconcile/releaseProtection 按 jobId 查找核对
>   （PID 仅辅助——复用/错位/他人 job 拒绝）；retireManagedJob 收尾闸门（per-turn=终态/证据
>   消费后；shared=daemon stop；有共享 open 登记保留）；桥轮询定时器实际 clearInterval+
>   pidIndex 复用守卫+close 时释放根句柄（生产证据链无需手动放句柄）。managedIdentity 3 用例
>   （worker 全链/复用反例/shared+stop）。
> - **打包 v2（262ffa2）**：假通过修复（严格退出码/nmOverride/负例 SQLite 佐证/koffi 版本实际
>   解析）；**daemon.shutdown IPC 正式停机命令**（打包验证与 UI 宿主同路径）；bundle 内受管全链
>   （claude 成员绑定 .cmd shim fixture→受管真实进程 turn DONE→task.stop→CANCELLED→截止
>   UNKNOWN→reconcile/probe/releaseProtection→shutdown 退出 0→无遗留）。顺带修 3 产品缺陷：
>   esbuild cjs import.meta.url=undefined（createRequire 双形态锚定）/管道裸名 EACCES（统一
>   \\.\pipe\ 前缀）/probe 受管观察 rootExited 句柄释放后误报（生命周期备忘优先）。
> - **桌面便携产物（dc9e1d9）**：dist/desktop/众说-便携-win-x64（Electron 全量+resources/app+
>   随包 node.exe——daemon 不依赖开发 PATH；受管默认开=缺失即明确失败 exit 1）。UI main 布局
>   判定（app.isPackaged 在便携 exe 未改名时不可用）；优雅停机（shutdown→有界等待→kill 兜底）。
>   verify-desktop 6/6（首启/正常退出/重复启动/移除断言/负例/无残留）。未验=安装器/签名/独立
>   Windows 机。
> - **多父 diff（bb12344）**：git.commitDiff 增 parentOid——多父未选=parentsMeta+注记；选定=必须
>   本提交的父（跨对象拒）→diff-tree 两树（差异=相对该父实际变更）；UI 父选择行绑定 OID。

## 当前下一步（唯一·第十四轮）

1. **无需等待直接开工**：设置页剩余真实项（协作限制/文件修改策略——先补后端命令面；多父
   diff UI 视觉走查可并入下一 UI 批）；**受管实战补证方案已成文**（round-20260930-round14 §7
   ——两次各 1 turn 上限+停止条件，**待用户批准后执行**）；DEV-15 剩余（安装器/签名/独立
   Windows 机验证——见报告四「未验证」节）；koffi 上游无需跟踪（缺陷结论已撤回）。
2. **价值评价（用户决定暂缓）**：不放回用户待办。
3. **补证（另批）**：真实 CLI 实战按 §7 方案逐次执行；剩余 3 次真实调用额度不动用；
   真实 lateEvents 维持 unsupported；写档入口维持关闭；并行写入维持延期。

---

## （上一轮快照，2026-09-29 第十三轮）

> 本轮主线=受管桥完整化（一）→恢复证据正式链（二）→push 目的地绑定（三）→DEV-15 早期打包（四）。
> 提交：736dddc→1aec264→3635a38→58374bf→文档组。数字：563/563 全量（含 githubSandbox；
> TLS 偶发=环境敏感单跑即过）+managedBridge 6/6+pack 4/4；零模型调用。
> - **桥（1aec264）**：stdin EOF（final→endStdin；EOF-consumer fixture）；**句柄继承修复**
>   （SetHandleInformation 清父侧——否则子进程持自己的 stdin 写端，EOF 永不到来）；字节流输出
>   （1MB 背压+终拍 push(null)+close=排空判定非固定延迟）；koffi 异步写=fn.async 形态（事件循环
>   不挂死）；argv=MSVCRT 约定逐位回读；**环境实证边界**：koffi CreateProcessW 非空 lpEnvironment
>   恒 87（A 变体有效/原生块亦 87）=FFI 缺陷——支持=继承父环境，真实覆盖显式报错。〔十四轮已撤回：根因=缺 CREATE_UNICODE_ENVIRONMENT〕
> - **证据正式链**：lifecycle 分立（rootExited/stdioClosed/evidenceReleased/consumed/finalized）；
>   根退出后保留可查询 job（close≠证据消失）；jobId 稳定身份；正式链验收=spawn→登记 managed-job
>   →UNKNOWN→probe→releaseProtection（managed-job-evidence）→租约解除→排队任务可继续→重复幂等。
> - **push 目的地（3635a38）**：pushUrl=get-url --push --all（pushurl 优先；多目的地拒）；
>   insteadOf/pushInsteadOf 改写拒绝（get-url 不在改写生效面——实证）；远端头核对走显式 URL
>   ls-remote（经远端名会读 fetch URL——核对同源修复）。
> - **打包（58374bf）**：daemon.cjs（esbuild）+verify-pack 4/4——中文+空格安装目录/clean env
>   启动；sqlite+koffi（@koromix 平台包带出）可加载；精确移除 koffi=拒绝启动不降级。
> - **flake 归因修复（736dddc）**：supervisor 两项满载失败=测试等待条件不可靠（sleep 竞态）→
>   grandson.pid 就绪信号+waitAlive 轮询+快照 ack；原失败组合全量 563/563。
> - **四层证据**：底层模块/本地正式链/打包产物三层已验；**真实 CLI 层未验证**（受管 claude/codex
>   实战、真实 lateEvents）——归补证窗口。

## 当前下一步（唯一·第十三轮）

1. **无需等待直接开工**：merge 多父 diff 视图+设置页剩余真实项（本轮未动——如实列首项）；
   受管 Claude Code + deepseek-flash 最小补证方案成文（逐次目的/停止条件——本地收口已具备，
   方案待用户过目后执行）；DEV-15 主体（Electron 壳/安装器/资源目录策略）；koffi env 缺陷
   上游跟踪。
2. **价值评价（用户决定暂缓）**：不放回用户待办。
3. **补证（另批）**：受管 runtime 实战/真实 lateEvents/崩溃现场取证——优先 Claude Code+
   deepseek-flash 单独列目标与上限；剩余 3 次不动用。

---

## （上一轮快照，2026-09-29 第十二轮）

> 本轮主线=Git 执行对象收口（一至四）→REC-LIFE-1 正式实施→真实 GitHub 补证（新授权）。
> - **已实现+本地已验（第十二轮）**：提交绑定显式 refs/heads（同 OID 切分支竞态反例——未批准
>   分支绝不动）；push 推不可变 OID refspec+目的地三重绑定+force-with-lease 严格旧头+输出脱敏；
>   pull 合入固化 OID；commit.undo 弃 reset --mixed 改 ref 级 CAS 软回退（索引/工作区零接触，
>   A/B fixture 无损证明；重叠/merge/崩溃重试三态）；hooks/gpgsign 检测阻塞（不静默绕过）。
>   REC-LIFE-1：koffi Job Object（挂起纳管窗口为零/KILL_ON_JOB_CLOSE 兜底/releaseEvidence
>   句柄语义/纳管失败不降级）；adapter spawnFn 注入（边界不感知）+迁移 019 managed-job +
>   releaseProtection 受管证据分支；ZS_MANAGED_RUNTIME=1 启用（未设=第九轮保守口径）。
>   真实 GitHub：授权沙盒仓 384615666/zhongshuo-git-e2e-sandbox（私有），5/5（命令链/并发反例/
>   ff pull/test/* 分支——全部经众说正式命令）。
> - **未完整确认**：受管路径的真实 CLI（claude/codex）实战未认证（fixture 全绿；真实调用归
>   补证窗口）；electron-builder 打包含 koffi 的可加载性待 DEV-15 首次打包。
> - **真实 unsupported/未验证**：真实 CLI lateEvents；崩溃现场进程树取证；研讨轮迟到收口语义。

- 提交：`727c835`（Git 一至四）→`4fb450e`（REC-LIFE-1）→文档组。数字：550/552（2 个 supervisor
  满载时序 flake 隔离 11/11）+managedLifecycle 9/9+githubSandbox 5/5+e2e 30+3skip+lint 0+tsc 0，
  零模型调用。报告：reports/round-20260929-round12-git-binding-rec-life1-github.md。
- GitHub 沙盒：owner=384615666，name=zhongshuo-git-e2e-sandbox，URL
  https://github.com/384615666/zhongshuo-git-e2e-sandbox.git，main 基线 1d78626；test/* 分支保留
  供复核；清理待指令（不自动删）。github.com 偶发 TLS 握手失败=环境敏感（单用例重跑即过）。

## 当前下一步（唯一·第十二轮）

1. **无需等待直接开工**：设置页其余真实项（协作限制/文件修改策略——先补后端命令面）；
   merge 提交多父 diff 视图；受管路径真实 CLI 补证（ZS_MANAGED_RUNTIME=1 × claude/codex，
   归真实调用窗口）与 DEV-15 打包可加载性；研讨轮迟到收口语义定义后实施。
2. **价值评价（用户决定暂缓）**：不放回用户待办、不反复请求。
3. **补证方案（另批）**：真实 CLI lateEvents/崩溃现场取证/受管 runtime 实战——优先
   Claude Code+deepseek-flash，单独列目标与实际调用上限；不动用剩余 3 次。

---

## （上一轮快照，2026-09-29 第十一轮）

> 恢复与修复链按能力分列口径不变；本轮主线=Git 写操作收口（内容绑定/归属保护/互斥与恢复）+RT-24 剩余。
> - **已实现+本地已验（第十一轮新增）**：提交内容绑定（索引 tree+commit-tree+update-ref CAS、
>   预览一致快照、目标分支绑定、提交后核对含外部竞态 consistent:false 不回滚）；仓库级写互斥
>   （同工作树两项目不绕过、undo 双向协调、目录身份失败拒绝）；stageTask 双向保护（after 冻结
>   核对/多集定型序裁决/链式归属/撤销与跨项目门）；持久意图与崩溃重试（迁移 017；stage 遇新内容
>   拒同号/commit 三态裁决/同号异参数全分支拒绝）；RT-24 剩余（迁移 018：branch/checkout 不自动
>   stash、commitDiff 关联、push/pull 两端头绑定+快进 only+AUTH 语义、conflict 三方+手动解决、
>   commit.undo 软回退）。
> - **未完整确认（工程欠项）**：有子进程 runtime 自动解除路径仍关闭——REC-LIFE-1 已出实施排期
>   （rec-life-1-plan.md：原生依赖/挂起纳管/句柄差异/崩溃事实/失败拒绝五点落实），Git 收口后独立成批。
> - **真实 unsupported/未验证**：push/pull 真实远端凭据路径（本地 bare remote 验证）；真实 CLI
>   lateEvents；崩溃现场进程树取证；研讨轮迟到收口语义。

- **一（内容绑定+保护）**：indexDigest（XY/path 摘要）→ **indexTree（write-tree 内容身份）**；
  执行链=write-tree 复核→commit-tree（预览 tree 直接构造）→update-ref HEAD CAS（旧值期望）；
  空仓库 unborn=ZERO 期望、detached 拒绝；CAS 后外部推进→consistent:false+headAfterActual、
  不把别人 HEAD 记为本次、审计留痕人工核对；反例=暂存 A→预览→暂存 B 拒绝+HEAD 不变、同 HEAD
  切分支拒绝、_between 注入竞态被超越。互斥=工作树身份键串行（6 并发深度≤1）+两项目同树+undo
  双向协调+PROJECT_MISSING 拒绝。**坑**：锁不可重入——嵌套持锁死锁，预览拆持锁包装+内部快照。
- **二（批量暂存双向保护+意图）**：after 冻结核对三反例（改产出/改新增/重建删除）零进索引；
  多集按 rowid 定型序裁决+multiSet 注记+链式归属（基线 dirty=更早定型集 after→任务链不误判）；
  reverted 跳过/partial 与撤销未收口冲突/跨项目拒；pending 意图（017）+重试裁决（stage 新内容
  拒同号——MM 断言/unstage 幂等/commit HEAD 未动续跑·尾标记恢复·外部推进人工核对/无行窗口保留
  尾标记/同号异参数全分支拒）。
- **三（RT-24 剩余，018）**：branch.list/create/checkout（HEAD+分支绑定、不自动 stash 改动随行
  计数）；commitDiff（parents/关联仅操作日志、merge 注记、diff-tree --no-commit-id）；remoteHead/
  push/pull（两端头绑定、快进 only、推送后核对、崩溃重试按远端既成事实、AUTH 语义不改配置不回显
  凭据、分叉拒）；conflict.content/resolve（三方查看+手动内容，无一键覆盖）；commit.undo（mixed
  软回退、仅当前 HEAD、根提交/detached 拒）。UI：分支/远端/冲突/历史 diff+撤销入口。
- 四（REC-LIFE-1 排期）：rec-life-1-plan.md——五点落实（N-API/prebuildify+DEV-15 ABI；CREATE_
  SUSPENDED 挂起纳管窗口为零；per-turn/shared 句柄差异+registry 归属标记；KILL_ON_JOB_CLOSE+
  重启对账；纳管失败拒派发不降级）；普通进程组≠Job Object 跨平台等价，矩阵按平台分列。
- 数字：**539/539**、e2e **30+3skip**、lint 0、tsc 0、零真实调用（未跑 real*；跨进程预算护栏未
  受影响未重跑）。报告：reports/round-20260929-round11-git-binding-rt24.md。上轮 55 次偏差记录
  独立保留。

## 当前下一步（唯一·第十一轮）

1. **无需等待直接开工**：REC-LIFE-1 实施批（排期已定：spike→实现→ADR §3 六条验收→矩阵分列，
   零真实调用）；设置页其余真实项按任务书逐项（协作限制/文件修改策略——先补后端命令面）；
   研讨轮迟到收口语义定义后实施；merge 提交多父 diff 视图（列项，不虚构）。
2. **价值评价（用户决定暂缓）**：不放回用户待办、不反复请求。
3. **补证方案（另批）**：真实 CLI lateEvents/崩溃现场取证/push 真实远端凭据路径/文件发现真实
   有效性——优先 Claude Code+deepseek-flash，单独列目标与实际调用上限；不动用剩余 3 次。

---

## （上一轮快照，2026-09-29 第十轮）

> 恢复与修复链继续按能力分列（口径不变，不写「已收口稳定」总括）：
> - **已实现+本地已验（第十轮新增）**：Git 只读协议重写（raw/numstat -z 机器身份、字面
>   pathspec、采集期容量控制、未跟踪内容视图、外部 diff/textconv 不执行-标记程序反例）；
>   Git 写闭环（stage/unstage/stageTask 跳过 userPreExisting、commitPreview/commit 预览绑定
>   +尾标记崩溃恢复、history 任务关联、git_operations 日志、租约/冲突/身份/范围四类前置）；
>   项目验收开关（CAS+持久化+仅影响新任务）与正式验收/返工 e2e 闭环（不经补库）；返工
>   第二轮交付守卫修正（按 run 创建先后判定）。
> - **未完整确认（工程欠项，ADR-0010 已立）**：有子进程 runtime 的自动解除路径仍**关闭**——
>   Job Object 首选候选已评估（归属/解除/回退/验收六条），承载 DEV-05 子项 REC-LIFE-1，不阻塞。
> - **真实 unsupported/未验证**：真实 CLI lateEvents 未实现（泵如实 unsupported）；真实 CLI
>   崩溃现场进程树取证/文件发现真实有效性归补证窗口；研讨轮 UNKNOWN 迟到收口语义待定义。

- **一（只读协议）**：文件身份全部走机器格式（`--raw -z` 重命名**先旧后新**/`--numstat -z`
  二进制 `-`、重命名=计数后空路径+旧/新两条——od 实测），删除 diff 头正则；查询固定
  `GIT_LITERAL_PATHSPECS=1`+`--no-textconv --no-ext-diff`；容量在采集阶段控制（超限 SIGKILL：
  单文件 64KB/整体 512KB/文件数 50/status 256KB）；numstat 失败→stat=unknown 不冒充文本；
  未跟踪文件按新增语义读内容；子目录项目显式返回工作树根+项目外条目标注。gitProtocol 9/9
  （含标记程序反例：控制组普通 git diff 确实执行驱动，正式命令不执行）。平台事实：NTFS 禁
  `"`/`*`/TAB 文件名（实测），fixture 覆盖 Windows 允许的全部特殊字符。
- **二（写闭环）**：迁移 016 git_operations（id=commandId）。批量暂存分区=纳入任务改动/
  跳过 userPreExisting（基线 porcelain -z dirtyPaths，第十轮起入 manifest）/混合文件=冲突
  不自动分离；旧捕获回退=before 前像 sha vs HEAD blob 逐文件核对。提交=预览绑定
  expectedHead+expectedIndexDigest（变化即拒绝）；`Zhongshuo-Command-Id` 尾标记——崩溃窗口
  （git 已提交、回执/日志未落库）按尾标记+父提交核对既成事实恢复，不重复 commit；重试链=
  回执重放→日志重放→尾标记→执行。前置=租约（执行保护中拒绝写）/冲突（U*/AA/DD）/身份
  （缺失如实报错不代改配置）/范围（子目录项目外路径拒绝）。提交不改 application_status/
  验收状态；history 关联仅来自操作日志（外部提交不虚构归属）。gitWrite 9/9+e2e 写操作闭环。
- **三（验收开关+正式闭环）**：project.reviewPolicy.set（CAS+事件+同值 unchanged+仅影响新
  任务）；「要求修改」必填意见；UI=项目设置面板（开关真实持久化、写入并发如实显示不可点）、
  返工意见行、「追加执行」按钮（task.redispatch 正式派发链——此前 UI 无再执行入口）；
  **修复**：交付守卫「存在其他 run 交付→不交付」挡住返工第二轮——改为按 run rowid 先后
  （旧 run 迟到仍不覆盖新交付，返工新 run 正常递增 revision）。e2e 正式闭环：设置开→重开
  保持→任务→REVIEW→返工（意见记录）→追加执行→第 2 版→验收→DONE（无补库）。
- 四（ADR）：adr-managed-process-lifecycle.md——Job Object 首选（内核归属无盲区、挂失败即
  拒绝派发）/ETW 增强候选/受管启动器不成立；验收六条；承载 DEV-05 子项 REC-LIFE-1。
- 数字：**524/524**、uiE2e **29+3skip**、lint 0、tsc 0、零真实调用（未跑 real*；跨进程预算
  护栏未受影响未重跑）。报告：reports/round-20260929-round10-git-protocol-write-review.md。
  上轮 55 次意外调用偏差记录独立保留，不抵销不复证。

## 当前下一步（唯一·第十轮）

1. **无需等待直接开工**：RT-24 剩余精确列项——git.branch.create/checkout（不自动 stash+带入
   改动数）、git.push/pull（AUTH_REQUIRED、仅临时本地 bare remote）、git.conflict.resolve
   （三方+手动）、git.commit.undo（reflog 软回退）、单提交聚合 diff；项目/应用设置按任务书
   继续逐项；REC-LIFE-1（ADR-0010）排期在全功能交付验收前、实施前出任务书（不需用户重新
   拍板方向）；研讨轮迟到收口语义待定义后实施。
2. **价值评价（用户决定暂缓）**：不放回用户待办、不反复请求。
3. **补证方案（另批）**：真实 CLI lateEvents/崩溃现场取证/文件发现有效性——优先 Claude
   Code+deepseek-flash，单独列目标与实际调用上限；不动用剩余 3 次。

---

## （上一轮快照，2026-09-29 第九轮）

> 恢复与修复链**不写「已收口稳定」总括**——按能力分列（用户令第九轮五）：
> - **已实现+本地已验**：进程树观察/追加式历史身份/盲区如实（真实 node 子进程+正式命令链）；
>   迟到泵同 daemon+重启双路径（fake 持久化会话记录）；版本绑定验收+返工输入注入；
>   git.status/git.diff 只读；设置持久化（repoStatus.visible）；帮助面板（START-07/09 首版）。
> - **未完整确认（设计边界）**：有子进程 runtime 的服务端解除路径**关闭**——周期快照只产生
>   「未观察到存活后代」观察，不构成完整退出证明；受管生命周期机制（Job Object/ETW）另批评估。
> - **真实 unsupported/未验证**：真实 CLI lateEvents 未实现（泵如实 unsupported）；真实 CLI
>   崩溃现场进程树取证/文件发现真实有效性归补证窗口；研讨轮 UNKNOWN 迟到收口语义待定义。

- **一（进程树保守判定）**：probe 对 per-turn/shared **不再返回 exited**（第八轮「全树核对
  无存活=完整退出」表述撤回）；reconcile 的 exited 释放分支删除；releaseProtection 仅凭
  no-os-process（升级前 exited 记录防御性拒绝）。历史身份修复（迁移 014 追加式
  process_tree_identities：按 pid+started_at_ms 代次，从不删除未确认身份——旧 012 快照
  DELETE+INSERT 会丢父链已断的后代）。反例×2：历史身份不覆盖（后续观察只见占位仍发现孙）；
  盲区如实（两次观察之间派生+中间父退出→未完整确认，不凭空声称能发现）。测试
  processTreeSupervisor 11/11+恢复三件套按新语义改写。
- **二（迟到回执原子）**：迁移 015 重建回执表（作用域键 source_scope+turn+eventKey，
  eventKey 不假设全局唯一；outcome applied/ignored 可区分）；**回执与 applyEvent 全部效果
  同一事务**（失败整体回滚、无「有回执无效果」态、可恢复）；归属校验（不认领未归属事件）；
  **泵收口不释放写入租约**（业务结果确定≠执行载体停止——仍走 probe/releaseProtection）。
  lateOutcomePath 9/9（异常回滚→重放恰好一次/同键异 turn/错归属/响应丢失）。
- **三（验收绑定版本）**：task.review 必带 deliveryId+deliveryRevision；事务内条件更新+影响
  行数核对；冲突区分（被替代/已处理/版本不符/跨任务/事务内变化）；同 commandId 重放=原回执、
  不同命令号不重复生效。UI：task.get.pendingDelivery 展示与提交同源、按钮带版本号、新交付
  刷新新对象。返工闭环：changes_requested 说明注入后续派发输入（关联被退回版本；accepted 后
  消失）；不自动派发。dev14Commands 10/10+uiE2e（v1→v2 错稿防护）。
- **四（DEV-14 深化）**：git.diff 只读正文（暂存/未暂存、重命名/删除/二进制/超限截断、路径
  越界拒绝、不改索引/工作区）；变更详情前像可用性汇总+恢复中心未收口撤销行+「继续撤销」
  入口（changeset.undo）；app.settings.get/set（白名单 kv 持久化，重开生效）+仓库状态显隐
  开关；常驻帮助面板（发送/仅记录/DIRECT/研讨/验收/恢复/迟到/Git/未开放边界）。AUTO 按
  闸门未开放并如实标注。
- 数字：**502/502**、uiE2e **19+2skip**、lint 0、tsc 0、零真实调用（未跑 real*）。报告：
  reports/round-20260929-round9-conservative-late-review-dev14.md。

---

## （上一轮快照，2026-09-29 第八轮）

- **supervisor 进程树=全树归属分析**：单层 ParentProcessId 枚举不再是判定来源——单次
  全表 CIM 快照（行标记协议；空输出/残缺行/CIM 错误=failed，**查询失败≠空结果**）+
  现存树 BFS（父退子活/存活中派生）+**活跃期快照历史归属核对**（迁移 012：worker
  startTurn 后首拍+消费期间 5s 周拍；中间代际退出后历史父子边消失，孙进程靠快照锚点+
  创建时间时序核对——排除复用家庭、时间缺失保守计入）；exited=「根退出+现存树空+快照
  代际核对无遗留」，**无快照=unknown（未完整确认）**。三代 fixture（父→子→孙，父子先退
  孙活）经 probe/reconcile/releaseProtection 正式链全拒绝、孙结束后才放行；
  processTreeSupervisor 9/9（含 worker 生产接线用例）。能力边界如实：最后快照之后新派生
  且父链已死的深层链不可发现（能力矩阵已收窄）。
- **迟到成果正式接收路径**：`RuntimeAdapter.lateEvents?`（事件来自 adapter 正式通道=
  fake 持久化会话记录，**不是命令参数**）+`recovery.pumpLateEvents`（entry 接线
  worker.pumpLateEventsForTurn；迁移 013 eventKey 回执）。「谁继续接收」=该泵（正常消费器
  退出后的唯一入口；同 daemon 与**重启**（新实例读同一持久化记录）同实现）。applyEvent
  新守卫：重复终态（含 SUCCEEDED 交付主键保护）/停止代次（stop_generation 事实承载，
  不复活已停止任务）/refunded 冲突留痕（不自动改账，纠正走 correctToExecuted）/被替代
  run 不覆盖新交付（superseded 留痕）；幂等=eventKey 回执+终态 CAS 双层闸。lateOutcomePath
  7/7（实际派发→截止 UNKNOWN→迟到输出→正式泵→收口；含重启路径）。真实 CLI lateEvents
  未实现=泵如实 unsupported（待补证）。
- **真实测试预算护栏（机械硬上限）**：`tests/util/realCallGate.ts`——配置全必填（缺一
  open 即拒）、超限**请求前拦截**、sent/failed/timeout/uncertain 如实落**文件账本**（跨
  进程/跨文件共享额度，账本既定额度为准不得改限）；realCodex 三文件全部 startTurn 过闸
  （gatedStartTurn）；「用例数≠startTurn 次数」旧口径废除（vitest.real.e2e.config 注释
  重写）。realCallBudget 5/5（含跨进程并发子进程实跑）；testIsolation 增护栏层断言→5/5。
  环境变量门禁≠预算硬上限，分别验收。
- **DEV-14 主体起步闭环**：`git.status`（只读真实仓库数据，暂存/未暂存/未跟踪严格区分，
  保留用户未提交内容；非 git 目录明确拒绝）/`task.review`（RT-25：按创建时策略快照处理
  唯一 pending 交付；accept→DONE、changes_requested→ACTIVE；Git 提交不等同验收）/
  `runtime.status`（运行能力真实状态，未验证项如实标注）/listByTask 撤销详情增强；UI：
  主池仓库状态区块（30s 缓存）、REVIEW 验收操作（状态变更后入口收起）、恢复面帮助
  （START-07 首版最小）+运行能力小节。dev14Commands 5/5（临时 git fixture）+uiE2e 新
  2 用例（**19 过+2 skip**）。写档未认证入口保持关闭。
- 数字：集成/单元 **493/493**、UI e2e **19+2skip**、lint 0、tsc 0、本轮零真实调用
  （未运行任何 real* 测试）。报告：reports/round-20260929-supervisor-lateoutcome-dev14.md。
  上轮 55 次意外调用偏差记录独立保留，不抵销不复证。

## （第八轮下一步，已执行完毕）

1. **无需等待直接开工**：按交付矩阵推进依赖已满足的工程包——DEV-14 继续（Git diff 正文
   视图/写操作接入、设置页真实状态深化、START-07/09 完整帮助）；correctToExecuted 的
   恢复面 UI 入口可选；研讨轮迟到输出收口待定义。
2. **价值评价（暂缓中）**：恢复与修复链已稳定（本轮收口 supervisor+迟到链）——可提请
   用户集中安排一次（不重跑实验、证据保留）；DEV-11 仍不开放。
3. **补证方案（另批）**：真实 CLI lateEvents（会话文件回放）/真实崩溃现场进程树取证/
   文件发现真实有效性——优先 Claude Code+deepseek-flash，Codex 专项单独列目标预算。

---

## （上一轮快照，2026-09-29 第七轮·补）

- **上轮核账纠错（重要）**：上轮「零真实调用」声明**错误**——test:e2e 全量收集无门禁的
  realCodex*.test.ts，调试循环中实际发生 **45 会话/55 真实 turn（gpt-6-luna，token in
  4.80M/out 42K，费用=渠道账单 unknown）**；逐次登记+防复发见
  reports/round-20260929-isolation-protection-outcome.md §一。防复发已实施：fake e2e 配置
  排除 real*+独立 `npm run test:real` 入口+三文件 `ZS_REAL_E2E=1` 双层门禁+
  testIsolation.test 4/4（子进程实跑证明隔离）。不从批次剩余 3 次抵销。
- **保护收口**：`recovery.releaseProtection`（预算已处置+保护未解除的遗留租约按服务端
  取证解除——alive/unknown/复用拒绝保留；不改预算/不改写人工声明；重启可续；钩子失败
  DB 事实保持）+`recovery.correctToExecuted`（事实矛盾纠正 refunded→settled U+1，原声明
  事件叠加不改写）；protectionRelease.test 4/4 全链。
- **supervisor 进程树**：父 PID 退出**不再**单独构成完整退出证据——probe exited 追加存活
  子进程枚举（win32 CIM；有子→unknown 保留；枚举不可用→未完整确认）；pre-launch 登记
  （迁移 011：model=unknown/source=pre-launch——startTurn 前占位，崩溃窗口与「从未启动」
  区分）；processTreeSupervisor.test 4/4（真实 node 进程树，工具子 detached 构造孤儿）。
  能力矩阵新增「进程树取证能力」节（真实 CLI 崩溃现场=未验证）。
- **成果一致性八项**（outcomeConsistency.test 7/7）：**发现并修复洞**——已收口
  （FAILED/CANCELLED）turn 的迟到 completed 原会走交付路径复活任务；现改为不复活不交付
  +lateCompletion（refunded 附 factConflictHint）；UNKNOWN 未收口=迟到合法输出收口为确定
  成功（lateOutputResolvesUnknown）；回执丢失重放/交付重领不重复/resultKey 幂等与异载荷/
  停止后不复活/DEV-12 半程续跑均复证。
- **恢复 UI 闭环+DEV-14 前置**：遗留保护行（预算已处置·保护待解除）+「继续核对并解除
  （服务端取证）」正式入口（拒绝行内如实+保留）；`changeset.listByTask` 只读命令+任务串
  「变更记录」区块（状态中文+文件前像/后像+撤销进度；无变更不渲染；只读）。uiE2e 17/17
  （反例全链扩展+DEV-14 前置新用例）。
- 数字：集成/单元 **470/470**、UI e2e **17/17**、lint 0、零新增真实调用（隔离证明固化）。
  报告：reports/round-20260929-isolation-protection-outcome.md（含上轮核账勘误与
  round-20260929-process-evidence-repair-budget.md 顶部勘误注记）。

## （七补轮下一步，已执行完毕）

1. **无需等待直接开工**：按交付矩阵推进依赖已满足的工程包（DEV-13 剩余真实样本归补证
   窗口；DEV-14 前置已起步——变更记录区块可扩展 Git 视图/验收流；correctToExecuted 的
   UI 入口可选）。
2. **价值评价（暂缓中）**与补证方案（另批）口径不变；真实补证优先 Claude Code+
   deepseek-flash，Codex 专项单独列目标预算。

---

## （上一轮快照，2026-09-29 第七轮）

- **OS 退出证据服务端化**（第七轮，迁移 009）：`RuntimeAdapter.processIdentity()`
  可选能力（per-turn=Claude CLI 每 turn 独立子进程/shared=Codex App Server 常驻/none=
  fake 内联）；worker startTurn 成功后登记 `runtime_process_registry`（PID+OS 启动时刻
  3s 短超时；失败=pid-only 如实降级），终态非 UNKNOWN 标 closed；新命令
  `recovery.probeProcess`（只读：按已登记身份 OS 核对→写 `recovery_exit_probes` 服务端
  证据）；`recovery.reconcile` 参数重写——**调用方不能再自报 alive=false**（旧
  exitEvidence 参数层删除），退出释放按 probe 结果矩阵（exited per-turn/shared、
  no-os-process=none 程序事实→释放；alive/unknown/identity-missing/复用→保留）；
  probeId 引用校验（turn 归属/登记一致/≤10min）；notStarted 人工分离（manualRiskAck
  必填：退款+FAILED 但租约/准入保留、recordedAs=manual-claim）。Windows 查询错误分类
  修复（仅 ObjectNotFound=exited；权限/StartTime 失败/解析失败=unknown）+epoch 计算修正。
- **逻辑输出+预算授权账目**（第七轮，迁移 010）：`format_repair_workitems` 重建为
  UNIQUE(task_id, logical_output_id)——修复轮继承根逻辑输出身份，**禁止修复套修复**
  （被拒请求零副作用：无工作项/outbox/启动计数）；refunded turn 豁免（无逻辑输出不挡
  资格）；预算单一真源=逐 turn 处置事实（非退款计数；旧 SUM 快照重复计反例已锁定）；
  budget_run_id 参与授权链校验（断裂=损坏阻塞）；修复轮上限强制（超限=closed+
  repair-budget-exhausted+BLOCKED）。
- **文件清单回授权合同**（第七轮）：`projectScopedFileListing`（§13.4 项目源码默认可读
  ——不再按 change_sets 归属排除[共享源码不永久隐藏]；§6.3 命名排除清单：VCS 内部/依赖
  缓存/构建产物/常见凭据，.env.example/.editorconfig 等可见；大小写归一；上限按过滤后
  计数——排除项不耗名额）；「评分答案在项目外」不再作为通用产品权限保证；两模式一致。
- **恢复 UI 事实分层**（第七轮）：程序观测/人工说明（草稿不丢）/无法确认/保留保护四层；
  「服务端取证」「人工声明未启动（退款·保留租约，confirm 风险确认）」操作精确绑定
  turnId；人工声明后遗留租约行如实显示；alert→行内错误行。renderer e2e 新反例：人工声明
  后保护仍在+界面说明原因；服务端核对完成才按条件收口；executed+identity-missing 不
  提前收口。
- **总账口径（用户已决定）**：价值评分=**用户决定暂缓**（待恢复与修复链稳定后再集中安排
  一次，不再每轮列为阻塞项）；实验原始证据/评分包 v2/已知偏差保留不动；价值闸门未通过、
  DEV-11 不开放；剩余 3 次保留，补证另批（优先 Claude Code+deepseek-flash）。
- 数字：集成/单元 **451/451**、UI e2e **16/16**（+1 恢复面对账反例）、realCodex 4/4、
  lint 0、零真实调用。报告：reports/round-20260929-process-evidence-repair-budget.md。
  realCodex B6-2 曾在一次全量连跑中偶发失败（真实渠道计划档行为漂移），单跑/全文件/
  改动前后均通过——既有真实认证偶发敏感，非回归。

## 当前下一步（唯一）

1. **无需等待直接开工**（用户已决定先工程后评分）：DEV-13 剩余（成果一致性专项用例；
   进程身份与 DEV-05 supervisor 衔接——registry/probes 表已就绪可被 supervisor 消费）；
   DEV-14 前置 UI 工作；按交付矩阵推进依赖已满足的工程包。
2. **价值评价（暂缓中）**：等恢复与修复链稳定、具备可操作用户体验后**集中安排一次**
   （评分包 v2 与证据保留现状，不重跑）；价值闸门未过 DEV-11 不开放；补证方案
   （round-20260928-recovery-repair-final.md §4）待另批——本轮未自动执行。

---

## （上一轮快照，2026-09-28 第六轮·下）
- **格式修复持久工作项**（`768b51a`，迁移 008）：修复用户指认四缺陷——kv 读后即删→
  pending/consumed 与 run/turn 创建同事务；任务级最后一条→同轮精确绑定（源 turn 自身
  outputInvalid+thread.replyAdded 消息+resultKey 与 run.created 核对）；每任务一次→每
  逻辑输出一次（(task,source) 唯一+派发键 task:<id>:repair:<sourceTurn> 版本化）；
  后缀判定→工作项结构化（普通 redispatch 失败=ACTIVE 非 BLOCKED）。损坏上下文→
  blocked+审计不花调用；修复轮预算沿用任务既往累计（repairConsumed.budgetCarryoverUsed）。
- **恢复事实分离**（`a4e8ada`）：reconcile 三事实（执行 notStarted 退款/executed 结算；
  退出 exited 须 osProcessCheck 结构化证据——userManual 拒绝；alive/unknown 保留租约与
  占位；executed 二次=补证不重算；settled→notStarted 矛盾拒绝）；budget_mark 逐 turn
  幂等；keepUnknown 非 UNKNOWN 拒绝；同 daemon releaseAdmission 联动（全链验收：占位→
  reconcile→解除→排队可派发；executed+alive 不放行反例）；processCheck.ts 真实进程
  取证（alive/exited/unknown+PID 复用判 different）。
- **文件授权过滤+恢复面 UI**（`f8f83b0`）：清单排除隐藏项与**其他任务 change_sets 归属**；
  两模式同一规则；不构成沙箱认证如实。恢复中心面板（UNKNOWN 明细+精确绑定操作+
  未确认退出无一键清空）；e2e 崩溃-重启链断言。
- **补证口径纠正**：旧批次 DIRECT 二次=无反馈重派——不能证明新修复机制相对效果；
  围栏规范化=1 次即验；修复全链≥2 次；文件发现=另一目标。最小方案上限 4-12 次**另行
  申请**（批次剩余 3 次只限价值对比，保留不动用）。
- 数字：435/435、UI e2e 15/15、lint 0、零真实调用；报告
  reports/round-20260928-recovery-repair-final.md。上半天（第六轮：台账/评分包 v2/
  修复链 v1/DEV-13 首片）快照见再下一节。
- **批次证据已修正（唯一台账=真源）**：`scripts/value-ledger.mjs` 从六侧原始库生成
  `evidence/value-batch/per-call-ledger.json`——全批 **30≤33**；**A-DELIB 10>9 单侧超限成立**
  （全批余额不抵销）；DELIB 合计 24（23 成功/1 失败）；**全批 FAILED=6**（初版报告「17/17」
  「4 次 FAILED」两处手写数字已勘误）。**A 组=带预算执行偏差样本**（内容/诊断保留，不构成
  符合预算条件的有效配对）；B/C 组内条件分别陈述；三组不汇总为「研讨更优」；预算修复表述=
  「B/C 实测无争议路径未超限；事故分支依赖本地回归证据（cap=9 用例已落地：先断言争议+修复
  真实发生→startTurn 实计数=9、第二 DIS 竞争落选留审计、账目闭合）」。C 组原目标未达成如实
  记录（受阻处理=附加维度）；C 根因四层取证（CLI 声明 observed/运行时清单 unknown/模型侧
  定义 unknown/实际调用仅 Read——根因保持 unknown）。
- **证据包持久化**：`evidence/value-batch/evidence-pack/`（逐 turn/输入输出全文含被拒字段/
  bundle hash/预算事件/版本）+`evidence-classification.json`（observed/reported/claimed/
  unknown 四级）+`direct-repair-path.json`（二次调用取证：三次均 redispatch 新 run/turn——
  输入未绑定原输出/错误=修复绑定缺陷，已修）。
- **评分包 v2（现行口径）**：撤回「可靠盲评」→**已披露实验背景后的人工可用性评价**；
  `evidence/value-batch/scoring-pack-v2.md`+materials-v2/（模式明示、双视角：产品交付
  （A/B DIRECT 无正式交付如实标注）+原始内容诊断（被拒 conclusions 全文保留、可读版仅
  pretty print）；不重新编号不删实质内容。**待用户评价**——价值闸门未通过、DEV-11 不开放。
- **DIRECT 修复链落地**（`15f81d2`）：formatRepair 正式通道（守卫=上 turn FAILED+
  outputInvalid、每任务一次结构化强制；kv 修复上下文→组装注入原输出全文+校验错误+指引
  「结论完整并入 changeSummary 不删短」）；输出合同字段用途强化（修复 A 组「conclusions
  无归属字段」机理）；单层围栏规范化（仅剥整文本包裹的一对围栏→同一严格 schema；
  outputNormalized 审计；C 组形态将直接通过）；修复耗尽→BLOCKED 收口（direct-repair-
  exhausted——A/B DIRECT ACTIVE 悬挂的产品侧答案）。
- **文件发现能力**（后续版本，不倒改批次）：authorizedFileListing（经授权清单：项目根内/
  排除 .git/截断与破口如实）→DIRECT 信封 fileDiscovery+渲染；DELIB IND 首轮同款（两模式
  一致）；root 缺失不加键不阻断。
- **DEV-13 首片实装**（`6a2d0ad`）：recovery.reconcile 三事实处置（notStarted=退款
  refundReservedTurn+租约释放+FAILED 留证；executed=结算；keepUnknown 全不动——不清空
  UNKNOWN 放行）；recovery.status 扩展（UNKNOWN 明细/stopRecord/activeUndos=DEV-12 崩溃
  窗口续跑指引/租约+「daemon 死≠子进程死」如实注记）；applyRecovery 快照扩展；故障注入
  测试 2/2（含 DEV-12 未记账样本经恢复面→changeset.undo 三向续跑联动）。
- **剩余 3 次授权不动用**（不用于探活/凑分/补跑/产品验证）；全套 **427/427**、lint 0、
  零真实调用。
- 上一轮（第五轮·下：批次执行/预算缺陷修复/DEV-12 四项加固）快照见下节——结论不变。

## 当前下一步（唯一）

1. **等待用户**：①评分包 v2 评价（已披露背景的人工可用性评价——材料含模式标签）→价值
   闸门结论；②真实补证方案批准与否（最小具体方案见最终汇报：建议另行申请，不动用批次
   剩余 3 次）。
2. 无需等待直接开工：DEV-13 剩余（进程身份 OS 层取证=DEV-05 supervisor 衔接；成果一致性
   专项用例）；DIRECT 修复链真实补证（围栏规范化+formatRepair 全链在真实渠道各 1 turn——
   待批）；UI 层呈现 BLOCKED/恢复面入口（DEV-14 前置）。

---

## （上一轮快照，2026-09-28 第五轮·下）

- **价值对比批次已执行（授权 33 上限，实耗 30）**：A/B/C 六侧全部经 real-delib harness
  （value 批次模式：成员正式绑定 claude/deepseek-flash、manifest 全字段、逐侧 verify/ledger/
  export）。逐侧：A-DIRECT 2/2（两次 outputInvalid：附加键 conclusions——内容好但严格 schema
  拒绝）；A-DELIB 10（**超限 1=预算缺陷已修**；9+1 修复；qualified 共识交付）；B-DIRECT
  2/2（两次纯散文）；B-DELIB 7/9 unanimous；C-DIRECT 2/2（围栏 JSON→修复后 DONE，本批唯一
  DIRECT 正式交付）；C-DELIB 7/9 unanimous（阻塞如实上报）。全部 usage 响应模型=
  deepseek-flash（零回退）；est 合计 $8.66（渠道账单为准）。版本配对：A 两側=6064529、
  B/C 两側=915f0db（组内配对有效；组间跨版本注明）。**主要观察**：①DIRECT 严格输出合同
  系统性合规失败（三种形态）/DELIB 阶段合同+修复全通过；②C 组文件名不可发现性两侧对称
  受阻（模型自述无 Glob 而 adapter 配置含——工具面认知差）；③争议分支真实出现并触发
  预算缺陷。材料：evidence/value-batch/{anon/*.md, scoring-sheet.md, anon-mapping.json,
  batch-ledger.json}；报告 reports/round-20260928-value-batch.md（含模式标签——评分后再看）。
  **待用户匿名评分（scoring-sheet）→ 揭示映射 → 价值闸门结论（此前不宣布通过、不进 DEV-11）**。
- **预算超发缺陷修复**（A-DELIB 实发 10>9）：前置阶段派发不设占用预留——双成员 DIS 并行
  领取读旧账（TOCTOU）。修复=occupyFrontForDispatch（`915f0db`）+回归（detached 争议+修复
  cap=6：≤cap、终态占用 0、budgetSkipped 留审计）；B/C 两轮 DELIB 实发 7≤9 证实。
- **DEV-12 四项修复完成**（reports/round-20260928-dev12-hardening.md）：①扫描完整性
  （ScanResult failedDirs/rejectedEntries；进入前物理核验；空目录合法基线；不完整→缺失判
  unknown）；②三态 probeCurrent（unknown 拒绝覆盖）+最近存在祖先 realpath 重核（父链换
  junction 拒绝、外部零写入）；③崩溃窗口注入+三向判定（已执行未记账=补记不重执行不误判
  冲突；failed 续跑重置 pending）；④PhysicalWriteRootRegistry 统一物理写入占位（撤销全程
  持有；B6 派发写档共用约束点；跨进程仍靠单实例锁+租约表——保护范围已如实标注）。
- 本轮上半天（准入生命周期/退出收口/工具审计 CDP/DEV-12 主体）见上一快照与
  reports/round-20260928-admission-exit-hardening.md——结论不变。
- 数字：全套 **412/412**、UI e2e **15/15**（真实档 2 例按 env 跳过）、lint 0。

## 当前下一步（唯一）

1. **等待用户**：①匿名评分（evidence/value-batch/scoring-sheet.md——评分前勿看工程报告）；
   评分后揭示 anon-mapping → 价值闸门结论；②可选最小预算：resumeSession 真实续接、
   restrict* 拒写对照（B6 前置）、双任务真实隔离。
2. 无需等待直接开工：**DEV-13 恢复与故障测试**（RT-03 重领对账/崩溃恢复语义系统性用例化
   ——本轮 stopRecord/UNKNOWN/三向恢复现场已备素材）；批次后产品改进评审（DIRECT 输出
   合同容错围栏/字段引导；输入合同明示工具面——修复 C 组认知差）；E4 detached 真实研讨
   复跑准备（价值闸门结论后再跑）。

---

## （上一轮快照，2026-09-28 第五轮）

- **准入占位完整生命周期完成**：DIRECT/DELIB 的 openSession（原来在 try 之外——上轮报告
  「均回收」超出证据，已收口）纳入统一 try/catch/finally；启动失败两分类——确认未启动
  （记录/提示词失败、会话记录失败且关闭确认）=FAILED+释放占位+outbox 完结；不确定
  （openSession/startTurn 抛错、关闭未确认）=UNKNOWN+**保留占位**+租约重领对账（RT-03）；
  detached 启动失败 live 遗留修复；standing 失败 turn 悬挂修复。
- **退出状态机收口**：`startingTurns` 登记（晚返回 openSession 不再对 stop 不可见）+
  `awaitSettlement`（starting∪consuming）；drain 挂起计入 incomplete 判定（drainPending）；
  晚返回 openSession 检查 shutdownStarted→不启动 turn、有界关闭、CANCELLED 清理；force 路径
  **核对后**关库（全收敛={complete:true,forced-closed}；否则 forced-incomplete 不关库不释放锁
  ——崩溃语义现场保留，不声称已杀完/已落库）；`boundedDisposeAll`（dispose 挂起不无限等待）；
  stop 记录实际持久化（daemon:stop:last 四态落盘；applyRecovery 快照 stopRecord 可读）。
  上轮报告「已杀进程/零后台写库」超限表述已加更正注记。
- **工具审计收口**：thread.toolCalls 合并键=turnId+toolCallId（作用域；同名跨 turn 不错并）；
  completed 结果与时间取自同一条选定事件；eventKey 去重；身份不完整=未归属条目（不按时间戳
  合并）；「零泄露面」改为准确字段范围说明；CDP 级 UI 断言 2 例（显示/去重/进行中/失败/
  unknown/切线程/刷新——ZS_FAKE_TOOL_EVENTS 首个-turn 编排钩子，仅 ZS_ALLOW_FAKE=1）。
- **DEV-12 主体完成**（daemon 层 preimage.ts+changeset.ts+迁移 007+changeset.* 四命令；
  domain 只许依赖 contracts——两模块因此归 daemon 层，六边界 lint 强制）：三态基础数据模型
  （unknown 不推导增删改/不自动撤销）；内容寻址前像存储（回读核对+撤销前再核对+大小上限
  contentUnavailable 提前呈现）；Git 基线（HEAD+porcelain+未提交/未跟踪内容前像——不
  stash/reset，撤销不动 Git 历史）；非 Git 整目录扫描（排除 .git、截断如实；扫描完整时基线
  无行=变更前 absent，截断=unknown）；非破坏撤销（逐步执行前重验当前==after、冲突不覆盖、
  撤销新增先确认仍是本次产物、单文件临时+回读+rename、多文件逐步持久化+中断续跑幂等、
  reverted/partial 如实）；单写者（重叠活跃/expired 租约拒绝并列持有者+同项目撤销互斥）。
  验收映射+反例见报告 §4（临时 fixture 含临时 Git 仓库，正式命令路径 9/9+前像单元 6/6）。
- 认证范围保留不扩大；零真实调用、零探活；价值对比 33 未动用；M1/DEV-11 闸门不变。
- 数字：全套 **402/402**、UI e2e **15/15**（真实档 2 例按 env 跳过）、lint 0。
  报告：reports/round-20260928-admission-exit-hardening.md。

## 当前下一步（唯一）

1. **等待用户输入**：① 价值对比 33 批准与否；② 可选最小预算：resumeSession 真实续接（1 turn）、
   restrict* 拒写对照（B6 前置）、双任务真实隔离。
2. 无需等待直接开工（按交付矩阵依赖已满足且零真实调用）：**DEV-13 恢复与故障测试**
   （不确定窗口/进程核对/成果一致性——RT-03 重领对账、崩溃恢复语义的系统性用例化；
   本轮 stopRecord/UNKNOWN 现场已为它备好素材）；或 DEV-12 任务侧接线预备（B6 写档接入时
   派发自动 capture/finalize 的设计落点）；E4 detached 下真实研讨一组复跑准备（价值闸门
   过前不跑）。

---

## （上一轮快照，2026-09-28 第四轮）

- **统一派发准入完成**（admission.ts：global4/project2/provider2/member1+writeRoot 接入口；
  占位覆盖 openSession/startTurn 窗口；UNKNOWN 保留占用；预算与并发不混用；泵必经准入）——
  7 组反例全过；顺带修三真实缺陷（DIRECT 截止中断误判 CANCELLED→UNKNOWN；requestStopAll
  hangInterrupt 死锁；关库后 settle 抛无人接拒绝）。
- **退出状态机完成**（stop→DaemonStopResult：incomplete 不关库不释放锁；force 路径另行定义=
  杀+abortConsumers UNKNOWN 收尾后关库；standalone 退出码 0/3）——本地反例全过（未确认不关库
  锁保留、强制后 UNKNOWN 持久化、关闭期完成事件落库、重复 stop 同结果、关库后零写入）。
- **harness stop 闭环**（real-delib doStop：正式 task.stop 绑定 runId/停止代次→观察至可解释终态；
  taskkill 仅 ZS_CRASH_INJECT=1 崩溃注入）。
- **线程工具审计呈现**（thread.toolCalls 命令：domain_events 真源/线程隔离/toolCallId 去重/
  member 归属；renderer 线程尾只读区块；集成 4/4——CDP 级断言随下次 UI e2e 批次）。
- **DEV-12 起步**：src/domain/preimage.ts（前像捕获/diff 纯函数+临时 fixture）——撤销执行与
  Git/非 Git 基线为主体实施项。
- 认证范围保留不扩大（usage=0=未收到用量报告非零扣费）；零真实调用、零探活；价值对比 33 未动用。
- 数字：全套 **384/384**、lint 0。报告：reports/round-20260928-admission-shutdown-tools.md。

---

## （上一轮快照，2026-09-28 第三轮）

- DEV-10 受控中断真实认证通过（预算 1/1：进程证据后 2ms 停止/CANCELLED 全链/无孤儿/重启不复活）
  →interrupt 按证据 supported；能力逐项修正（resume/restrict*/isolation=unverified）；只读档
  正式机制组合；tool 事件落库审计；E4 调度解耦实装（detached+成员互斥+两缺陷修复）。
---

## （上一轮快照，2026-09-28 深夜·二）

- deepseek-flash 真实认证：意外探活 1 次（settings env 优先级事故）+ turn1 全链成功
  （暗号回流/resultKey/usage 20,875+53,760cache+11,822/$0.4268 est/55.6s）；成员级
  runtime 生产接线完成（member.setRuntime→registry→worker adapterFor）。受控中断当时未
  执行——**本轮已补并全部通过**（见上）。

---

## 刚完成（修复轮 6 + G3 收口）

- **证据口径修正**：ZS_UI_DEMO=宿主内命令链路（main 直连 pipe），不再称等价人工点击；发现并修复正式 renderer app.js 从未成功执行的问题（顶层 const 与 contextBridge 非配置全局冲突 → IIFE 包裹）。
- **R1-R5 renderer 全量接通**（src/ui/renderer/app.js 重写）：停止按钮（点击时快照绑定，切线程不误停）；恢复入口（recovery.status 只读 + 显式 dispatch.resume{confirm:true}）；主池 room.pool + 线程 thread 目标（不新建根任务）；双视图草稿独立/在途去重（同 commandId 重试横幅）/IME/仅记录一次性复位/M0 模式诚实实现（仅 DIRECT，恰一名 agent 时预填 mention）；重载/重启按上次项目恢复（localStorage + userData 隔离）。
- **B1/B2**：管道 commandId 关联+迟到响应丢弃反例（2/2）；daemon 生命周期 drain 收敛/重复 stop/关库后零写入（3/3）。
- **UI e2e（CDP 真点击）**：tests/e2e/uiE2e.test.ts fake 11/11（发送→DONE→线程回复/跟进/草稿/仅记录/双击双 Enter 去重/IME/重载恢复/UI 停止→CANCELLED/SIGKILL 崩溃→重启→门禁→确认→中断任务不重跑+新调度恢复）；**真实 codex 1 turn（UIE2E-CODEX-6666，24.7s）**。
- **隔离**：同成员两任务先排队再派发用例（串行完成/各一 run/顺序正确/会话不因同成员合并）。
- **架构**：IPC 协议共享层下沉 src/contracts/daemonIpc.ts（ui→daemon 边界违规清零）；task.get 补 stopGeneration；recovery.status/room.pool/thread 目标服务端合同；ZS_PIPE_NAME/ZS_FAKE_STALL_MS/daemon.pid/pnpm build:ui 配套。ADR-I41/I42。
- **数字**：pnpm check 全绿 276/276；lint 0（此前 24）。详见 reports/round-20260927-fix6-ui-e2e-g3-closeout.md（五段）。

## 当前故障 / 待停止进程

- 无遗留进程（本轮 electron/daemon 均清理）。

## M1 第一批（已提交，本轮内完成）

- **contracts/deliberation.ts**：§6.4 报告/互评/立场/检查点/整合/确认 payload schema（schemaVersion 字面量，模型自报身份字段一律程序赋值）；E12 预算推导（6N+1+C / 7N+2+C）与尾部账目（M/U/I、S=1/Q=N、R/T/F、stageAvailableTurns、occupyTail/settle 纯函数）。
- **domain/deliberation/stageMachine.ts**：INDEPENDENT/CROSS_REVIEW 屏障（E4 缺席不默认完成、全员无输入 BLOCKED）；争议派生（同 claim 合并、无争议跳过讨论）；第 3 轮检查点资格（host 专属）；共识聚合（unanimous/qualified/disputed/unconfirmed，缺席不覆盖反对）。
- **persistence/stores/deliberation.ts**：artifacts 落 appData 管理目录+hash；synthesis_claims 冻结；RATIFY 矩阵初始化/提交事务（claim 全覆盖且无重复、非预期成员/阶段不符整份拒绝、同 resultKey 重放、已确认不可自然语言覆盖、关屏障 pending→missing 不伪造 turn_id）；issues/positions。
- **DEV-21-M1 模板**：DELIBERATE 六阶段指令（(mode,role,stage,turnPurpose) 选择表扩展，checkpoint host 专属）+ 精确 JSON 输出契约（ADR-I39 口径）。
- 测试 +19：预算 4 / 阶段机 10 / 持久化 5（含 prompts 表更新）。默认 295/295。

## M1 第一轮（已提交）

- **四缺陷收口**（迁移 004 payload_hash / 005 stage_started_at）：屏障冻结参与集合、互评三元组+run 范围 issueId、RATIFY 同键同规范化载荷幂等/异载荷冲突+全前置核对+行数校验、成果发布协议（不可变版本/失败恢复/完整性校验）。零额度反例齐备。
- **DELIBERATE 编排**（deliberationRunner+worker 集成）：PREPARE→IND→CR→（争议）ISS 轮次+第3轮 checkpoint→SYN→RAT→PUBLISH 全链；确定性 dispatch_key；服务端输入隔离+ContextBundle hash；E12 预算单一账（占用/结算/退款/尾部保证/耗尽兜底）；E4 假时钟缺席；停止作用于运行；一次格式修复。集成 9 用例。
- **研讨 UI**：run.progress/report.get 命令、@全体芯片、进度条（成员状态可见）、逐结论共识报告；门禁按证据开放（entry 默认；worker 级默认关，m0Fixes 语义不变）。UI e2e fake 12/12。
- 数字：默认 323/323、lint 0。

## M1 收口轮（2026-09-28，已提交）

- **取证**：三次历史真实尝试 WAL 字符串取证定论（1/2=截止中断误判用户停止缺陷已修；3=CODEX_ERROR 正文未存档）；e2e 失败保留证据目录已修。
- **调度/E4/迟到/身份**（331/331）：时钟注入；排队≠缺席、成员级缺席（截止中断/UNKNOWN 不杀 run）；迟到三分支（未冻结纳入/停止不复活/发布后只展示）；dispatchKey 带 runId（二次运行不复用旧键、旧 run 遗留零执行）；RATIFY 确定性收口；ContextBundle 全文+hash。
- **真实研讨一组完成**：预算 7/9 精确、无争议跳过讨论、unanimous、29/29 逐项审计（scripts/real-delib-audit.mjs）；提交-观察分离 harness（scripts/real-delib.mjs）。

## 下一步（直接开工，无需再确认）

1. **真实补证（按需小额）**：一组带真实分歧的任务（讨论轮+checkpoint 真实路径）、一组真实迟到/缺席观察；完成后把门禁默认开放。
2. **M1 价值闸门材料**（需预算批准后执行）：3—5 组同题同基线 DELIBERATE vs DIRECT——先列任务清单、评判标准（事实准确性/漏项/分歧处理/调用量/耗时）与总预算报给用户，再执行；不预设结论。
3. 价值闸门通过前不进 DEV-11 自动分工；不影响其他独立工程工作（跨房间建房命令等）。

已知小残留（不阻塞 M1，随相关包顺手收）：跨房间切换 UI 场景（正式命令面无建房命令，待房间管理命令落地后补）；UI 发送横栏传输失败路径的 UI 级注入测试（传输层已有单测+smoke）。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 已收口，不再重跑已过认证（steer/allow/resume/usage 等）。
- UI 相关验收：真点击链路用 CDP 方式（ADR-I41）；宿主内 ZS_UI_DEMO 证据只作后台链路口径。

### 2026-10-15 人工回填后收口

[当前总门](evidence-r84-manual-closeout-20261015/final-gates-human-confirmed.json) pass/corePass均true；human-titlebar-drag.json原用户来源已read_thread核对。程序仍05b549f/bld_fcf357a7e1e4ad52，未重包/新增模型/重跑2h。原42封存证据和自动化false原件不改。用户现启动candidate后产生server-data，不能删除、搬移、关闭用户应用或再当工程根运行；新QA只读程序清单并依据同BUILD/manifest交付前无预置数据证明收生命周期门。新增26正负合同/两脚本lint0通过。不要把拖动单项改成整体userAcceptance=passed。
