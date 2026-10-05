# 第52轮复核与第53轮要求（2026-10-05）

对象：`e12837d`，H2 候选 `dist/desktop/hifi-h2-win-v1`，build `bld_ce1c059ab99a1df6`。结论：回复串与四项旧反例的主要路径已经改善，但**PPT 视觉预览、移除附件后的真实引用、重试成功后的附件清算仍有实际缺陷**。先修正再让用户做一次集中短测；H3 的界面归位继续推进，不等待 Android。

## 1. 已核实的进展与范围

- 独立计算候选 MANIFEST 全部 **591/591** 文件 SHA256，无不符；身份事实保存在 `dist/desktop/review-r52-audit-20261005/package-identity.json`。没有修改候选。
- 独立重跑 H1/H2 三个真实链文件：`hifiFirstPackage`、`hifiThreadRound51`、`hifiUploadDeepLinkRound52`，**4/4，退出 0**；hifi strict typecheck 退出 0。没有冒充重跑全量 856 项。
- 隔离页面取证直接读取**当前候选中的 renderer/hifi/app.mjs 与资产**，连接自己创建的正式 daemon 内存库/FakeRuntimeAdapter；独立 userData/blobstore。A/B 同名上传现在确实得到 B 内容；任务/交付深链实际选中详情；新界面可见时旧界面不再抢该深链；详情期间零 markRead；非法 UTF-8 零上传/零 artifact。这些修复保留。
- 原最终包双轮材料证明的预览是 **Markdown 的真实正文**。`verify-hifi-package-r52.cjs:181–196` 没有 PPT 视觉步骤，不能代表在 zsres 环境已强制验证 PPT 正常视觉渲染。
- 原双轮的真实启动、文本附件、图片门、深链与退出材料保留，不能因下面的问题全部抹除，也不能反过来把未覆盖项宣布完成。

## 2. P1：PPT 视觉宿主死锁 + 验证器把正文容器当成视觉页

### 产品根因

`src/ui/hifi/preview/PreviewPane.tsx`：

- 初始 `visualState='none'`（230 行）。
- PPT effect 在 `stageRef.current == null` 时直接 return（276 行），只有进去后才 `setVisualState('rendering')`。
- 视觉宿主却只在 `visualState==='rendering' || 'done'` 时挂载（406–414 行）。

形成「没宿主不启动 → 没启动不挂宿主」。不是格式限制，也不是 HTTP 环境慢。

### 实际页面证据

在候选 renderer 上打开合法 `r52.pptx`：

- `stageExists=false`、`stageChildren=0`；
- `rendererRequests=[]`，pptx-renderer 模块根本没请求；
- 画面正文为「视觉页预览不可用（未知）——提取文本卡片不受影响」。

证据：`dist/desktop/review-r52-audit-20261005/audit-result.json` 的 `auditPptVisual`。

GLM 自己的 `dist/desktop/review-r52/thread-with-preview.png` 右侧也清楚显示同一个「视觉页预览不可用（未知）」框，没有幻灯片视觉。它不能作为正常 PPT 视觉预览 PASS 的截图。

### 验证器为何误报

`verify-hifi-thread-r52.cjs:378` 查任意 `[style*="min-height"]` 且有子节点：实际命中**整个预览面板的滚动正文容器**（min-height:0），而不是 PPT 舞台。反例里 `broadPredicatePass=true`，真正舞台仍不存在。随后 `P_previews.pass` 还没有把 `pptxVisual==='rendered'` 纳入通过条件。

修复要求：视觉宿主稳定挂载；按具体资源/渲染器的完成事实验证合法样本实际内容、页数、翻页变化。工程验证必须能在故意阻断渲染器时失败；禁止把任何容器、文字提取、降级提示判为正常视觉成功。最终打包产物补同一正常链。

顺带收紧已有松断言：PDF canvas 默认就有正尺寸，不能只判 `width>0`；Word 不能只判 shadow 里有 style/空容器；图片 `naturalWidth === d.width ? 'ok' : 'ok'`（141 行）两边恒成功，应核实际宽高并如实反馈。正常渲染与明确降级分别统计。

## 3. P1：上传中移除仅删除芯片，资源仍被悄悄发送

`Composer.tsx:333–336` 先 `settleUpload`，紧接着**无条件**向 `getDraftFull(draftKey).attachments` 加入上传回执。

`settleUpload` 的确会删除标记 removed 的上传项，但返回 void，调用方不知道这笔回执已被弃掉，于是仍把它写进正式草稿。`attachmentRefsFromDraft` 的最终 refs 来自草稿，而不是当前可见芯片。

确定性页面复现：

1. 上传 `remove-me.md`，暂缓回执；
2. 点击该上传芯片的移除；
3. 放回回执，芯片确实不再显示（原测试因此记 DISCARDED/PASS）；
4. 在同线程发送一条「仅记录」消息，查询 `message_attachments → artifacts`；
5. **消息依然挂上 `remove-me.md`**，尽管用户已经移除。

证据：同一 `audit-result.json` 的 `auditRemovedRef`，`chipVisible=false`、`actualLinks=[remove-me.md]`、预期 0；第二份独立窗口也复现。

修复：上传结算同时核该 uploadId 是否仍存在、是否 removed、发起草稿/会话是否一致；就绪项和草稿 ref 在同一次结算中更新。已移除/取消/消失项不能写任何草稿 ref，切走再回来也不能由 hydrate 复活。负例要断言下一次真实信封与落库附件均不含已移除引用，不能只看芯片消失。

## 4. P1：未知回执重试成功不清附件，下一条消息再次带上旧资源

`Composer.tsx:634–655` 的 `retryUnknown` 成功分支只清队首信封、正文和意图，既不剥草稿附件 refs，也不调用 `clearSettledUploads`。

实际页面：含 `same.md` 与 `r52-envelope.md` 的原信封重试成功，恰一次已经落库；此后选择一些其它新样本，再发下一条记录消息。**两个已经发送成功的旧 attachmentId 同时进入下一条信封并再次落库**。

证据：`dist/desktop/review-r52-audit-20261005/refs-case-2/audit-result.json` 的 `auditRetrySettlement`，记录了原已发送 refs、下一条完整信封、落库列表和两个 unexpectedRepeatedRefs。

正常回执的 `settleForKey`（568 行）在任何 draft rev 变化时提前整份 return，也会跳过附件清算；该源码路径需要一起收口，而不是只修重试分支。正文编辑保护与已确认附件清算分别处理：只剥本次确实发送的 refs，保留后来新增的资源、范围及正文；同 attachmentId 的复用意图用明确的选择身份/代次区分。

覆盖：确定成功/未知后重试成功 × 等待期无编辑/新增正文/新增附件/跨目标；核实际信封和落库身份。已经发出的 refs 不应默默留在下一条草稿里。

## 5. 材料与可重复构建也要随修正版落实

- 当前 `scripts/make-hifi-h1-package.mjs` **仍为未提交修改**，其中是 H2 README、样本与模板变更。下一提交把实际构建材料纳入版本；不要笼统说整套脚本已经推送。已有 BUILD dirty 元数据保留真实值，不伪 clean。
- 包生成入口目前只调用 pack-desktop；后者只检查预构建 UI/daemon 是否存在，并不会保证它们来自当前源码。本轮「先手工跑 pack-daemon」修好这次候选，尚未防止下次再夹带旧 daemon。把 build-ui → pack-daemon → pack-desktop 的顺序和退出码落实到入口，或做等价的源码指纹不符即拒绝门。
- T2 需给用户真实前置：干净种子主池的 PPT 是**仅记录串**，先在默认房间 @Guide A 发送一条短任务，再点击它的任务卡；不要要求用户找一个未说明如何产生的任务卡。
- T4/T5 明确先输入一句正文；仅选择附件而正文为空，Composer 不发送。T5 给实际工作表名和可直接使用的范围，并核正式提交/注入范围，不只看「已设」提示。
- T6 现在要求桌面客户端改「地址栏 hash」，但正式 Electron 没有这个地址栏；详情里的 `#1` 也是房间任务序号，不是 `task_…` 实体 ID。提供可复制/打开的正式定位入口；若暂未做入口，将该项如实列工程验证/用户 NOT_RUN，不要求用户开 DevTools、SQL 或 Node。

## 6. 第53轮交付顺序

1. 优先修第2–4节，工程自行对真正产品链复证。复用已验收的渲染与资源释放逻辑，避免换装再独立写出另一套生命周期；PPT 打开超时/迟到结果要真实 abort/dispose，PDF 加载/渲染任务清理也需有明确归属。
2. 更正 R52 「六格式视觉真渲染全部通过」「打包环境强制验证 PPT」的范围，保留原报告和截图；以新的 runId 留真实补证，不覆盖历史。
3. 交独立 `hifi-h2-win-v2` 修正版，最终产物跑真实启动、正常视觉内容、发送/清算与优雅退出验证。一个明确冻结的版本给用户做一次集中短测；不让用户替工程确认已能复现的问题，不重复旧 D1—D10。
4. H3 同时按原型推进设置、看板/Files、Git 与诊断入口归位、标题栏；等待手测期间继续可独立完成的正式命令接线。不要为了验证器反复修正又推迟所有界面施工，也不要把未换装能力直接删掉。

不需要新增用户决策或设备。H1 v2、DEV25 v6、现有 CA/数据/RESULTS/截图保持稳定；Android v6 范围独立，不阻塞 H3。A+Word 不变、B 不集成、无新 OCR/视觉服务、零新增真实调用；DEV-11/并行写入/价值评价与 G5 保持既定范围。

## 独立取证范围说明

本次只读使用 H2 候选的 renderer 静态文件，临时 daemon 为正式源码打包 × 内存库 × fake adapter，所有写入只在 `dist/desktop/review-r52-audit-20261005/`。未双击候选启动器、未连接正在运行的用户 daemon，未动用户包/数据。

第一探针原 A1–A5 的既有条件仍 pass，新增字段才揭示上述缺口；不能把报告顶层 pass 当成新增审计通过。一次追加探针 `refs-case` 停在准备步骤（详情页没有输入菜单），原样保留为未完成；修正探针导航准备后在新的 `refs-case-2` 留证，未覆盖它。隐藏窗口截图存在超时，未拿到的截图没有被补写成成功；关键证据为实际 DOM、模块请求与真实附件落库，并另只读查看了 GLM 已有截图。
