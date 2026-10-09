# R73 页面切换、预览布局与导航取消收口（2026-10-09）

> 对应复核：`desktop-v10-user-layout-feedback-20261009.md`（用户实测三项：切房间预览占用/无分隔条/放大无效）+ `review-r72-navigation-cancellation-next-round-20261009.md` §P1（已取消定位仍切项目）+ §2（冷房间直链疑点）+ §3（阅读器完成态）。
> 交付：`desktop-daily-win-v11`（`bld_87d8fd4ec1c6283c`，commit `ed39838`，dirty=false，593/593；r63 --src v11 ok realCalls=0；启动器发布协议复证三项修复 ok）。零新增真实模型调用；迁移 001–048 冻结；旧包/用户数据/凭据/草稿/未知账本原地未动。

## 一、用户反馈三修（A/B/C）

### A. 文件页→房间：自动收起（不占房间）

- **形态确认**（独立复核 ui-result.json：pool=true、preview width=620 占用）：工作区资源 audience=project 在房间上下文可见 + 全局预览会话显示态跨页沿用。
- **修复**：进入对话上下文（房间/线程）时，若预览可见、用户未**显式**要求看见、且当前上下文可见标签**全部**来自文件页 → `autoHidePreviewForConversation`：只改可见性（`hidden:true`），标签/阅读位置/各草稿全保留；房间头部既有「文件预览 N」重开按钮恢复（恢复即显式，本会话不再自动收起——不乒乓）。
- **explicitShow 生命周期**（两处 openPreview 统一）：对话内打开=显式；文件页打开=重新武装自动收起。**门内迭代挖出的根因**：`actions-preview.openPreview`（文件页走的那条）漏设 explicitShow——显式重开后文件页再打开不重新武装，在途大文件装载完成后预览占回房间（G1 在途回弹）。另补 effect 的 `s.resources` 依赖（在途资源到达后重估）。
- DM 资源在房间上下文本就不可见（audience 过滤），无需处理；房间内正常打开的文件（openedFrom=room/thread）永不自动收起。

### B. 真分隔条（真实两区边界）

- **复核证实**：房间主池+文件并排 role=separator 数量 **0**；既有分隔条只在回复串分支（L2），L4 的还在回复串左缘（不在与预览的边界上）。
- **修复**：`usePreviewWidth`（会话内拖动值，默认 620）驱动 **L3（主池+预览）/ L4（上下文列+预览）真实边界**的分隔条（PreviewPane 紧左侧，role=separator）；原生 pointer 拖动直接改宽度；380 下限/上下文列保底 420/双击复位；**窗口缩窄拉宽不棘轮**（R71 纪律：显示侧动态 clamp，拖动值只在用户拖拽/复位时改写）。旧「回复串左缘反转」语义随之移除（L2 分隔条恒不反转）。
- 门 G2 实测：L3 边界贴合（ctx.right≈sp.left±4）、拖右 608→460、拖左回 608、最小宽 380、双击复位、980px 缩窗无横向裁剪且拉宽回拖动宽度、940px 单区域降级（无双线程/多输入条）。

### C. 真放大（占满工作内容区）

- **复核证实**：`preview.maximized` 只改按钮文案，`paneCls` 未消费、布局未读。
- **修复**：`paneCls` 拼接 `maximized`（绝对定位铺满定位锚点 `.workspace`/`.main`——导航在 .main 之外仍可达）；**门内迭代**：hifi-flag.js 运行时注入的 `body.zs-frameless .preview-pane{top:38px!important}`（无边框窗给并排态留标题栏）把放大层往下压 38px——用同级 `!important` 压回。
- Esc 还原（放大态 window keydown；`.menu/.scrim/[role=dialog]/.modal` 打开时不穿透——弹层各自的 Esc 监听先关自身，React 卸载在下一拍，同步查 DOM 即可判别）；还原回并排宽度（±8）。文件页/房间/线程/私信共用同一壳同一按钮，门内核房间（G3 主）+ 私信（dmMax fills+restore）+ 文件页（发布协议复证）。
- 各格式阅读器随区域变化适应（XLSX sheet 保持、PPT 页码保持——G3/G6）。

## 二、导航取消（review-r72 §P1 真缺陷收口）

- **反例机制**（独立复核两次复现）：`LocateThread` 外层 cancelled 只挡最终 navigate；`locateThread` 内部 `ensureProjectActive → focusProject/openProjectByPath` 已改 activeProjectId 与导航偏好——B→A 深链在途回执到达时用户已在设置页，当前项目仍被切成 A。
- **修复**：`lib/navIntent` 登记簿——`navigate()`/用户级 `focusProject`/用户级 `openProjectByPath` 入口 `cancelAllNavIntents()`；定位器挂载 `registerNavIntent`（卸载即失效+释放）。`locateThread`/`ensureProjectActive`/`openProjectByPath` intent 贯穿：**每个 await 之后、每次重试、每次提交焦点/持久化导航之前**核 `navIntentActive`；定位链内部调用带 `system`/`fromIntent` 标记（不取消自己）；启动恢复（bootRemembered）标记系统动作（不误杀冷启动深链）。
- 取消后：不抢焦点、不写 navigation.set、不弹旧错误（toast 按 intent 守卫）、不继续重试；失败原因按服务端/链路原话分列（不再用「不可访问」覆盖）。
- **同 threadId 快速改 message/tab**：LocateThread effect deps 补 messageId/tab——重跑即新意图，旧闭包 cleanup 置 cancelled。
- **冷房间直链**（review §2 源码疑点，先证后修）：`/project/:pid/room/:rid` 对齐条件从 `pid !== active` 扩为 `pid !== active || 房间未装载`（偏好恢复 active 但不装房间时直达房间报「找不到该房间」）——门 G4 冷房间分支实测通过。

## 三、阅读器完成态（review §3）

- `RenderedSlide` 把引擎真实 render 事实暴露到 DOM：`data-zs-render=pending/ready/error`，与**本次挂载的页**绑定（live 标志：迟到的旧页 resolve/reject 不给换页后的 mount 标错状态；此前 `handle.ready` 的拒绝被吞、0 张 img 也可能被当完成）。
- 门 G5 逐页 walk（82 页真件）：每页等真实 ready，页级完整记录 `{p, landed, render, imgs, textLen}`，**82/82 ready、0 失败**（3.96s）；任何 error/超时都会使总门失败。口径如实：这是「页级 render-ready+图片解码」证明，非逐页像素级对照。

## 四、验证总账

- **verify-daily-r73.cjs**：`{"ok":true,"errs":[]}`（run `gate-r73-r73-gate-*`，realCallRoots **6×0**）——G1 自动收起（真实侧栏房间点击+草稿保留+重开标签=1+不乒乓+**在途不回弹**）；G2 分隔条（L3/L4 边界+双向拖动+最小宽+复位+缩窄拉宽不棘轮+940px 降级）；G3 放大（rect 铺满+菜单 Esc 优先+Esc/按钮还原+sheet 保持+私信共用）；G4 导航取消（B 保持+零偏好写入+无旧错误 toast+未取消正例+冷房间+最新 tab）；G5 82 页真实 render；G6 R72 回归（树开 82 页+页码保持 40+另存 sha 一致+XLSX aria 69913/滚动+Git 中性→仓库）。
- 全量 **921/921**（117 文件；一次环境 flake 复跑即绿，如实登记）；主/hifi typecheck 0 错；**r72 门回归 `ok:true` errs=[]**（realCalls 6×0）。
- **交付形态**：v11 = `bld_87d8fd4ec1c6283c`（ed39838，dirty=false，593/593）；r63 --src v11 `ok:true` realCalls=0（独立副本×真实启动器）；**R73 启动器发布协议复证**（`verify-r73-launcher-layout.cjs`，独立副本+start-desktop.bat+zsres://app）：①侧栏房间点击自动收起 ✓ ②分隔条拖动 608→460 ✓ ③放大铺满（1036=1036、顶对齐）+Esc 还原 ✓——console 零错误、realCalls=0。

## 五、未覆盖/边界（如实）

- R73 门迭代的 r73 门 take-9 曾出现 XLSX 上传主进程 15s 超时（环境抖动）——门内加了失败芯片移除+重传（≤3 轮），take-10 干净通过；如复现按独立反例处理。
- 触摸板/触屏拖动、极窄窗（<940px）下的分隔条行为按单区域降级语义未再细分实测。
- 82 页逐页**像素级**对照仍属抽样视觉判读范畴（R72 G4 三段视觉判读沿用）；canvas 引擎选择/复制合成输入驱动不了（R72 登记）。
- （既有延期不动：Android/安装器签名/价值评价/DEV-11/并行写入/G5 等。）
