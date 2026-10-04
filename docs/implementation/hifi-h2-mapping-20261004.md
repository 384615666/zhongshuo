# H2 映射盘点（2026-10-04 第四十九轮 R50 编制——H1 证据收口后实施依据）

依据 hifi-integration-plan（H2=回复串+共享预览+附件草稿，2 轮）与 review-r49 §5：**复用已认证
格式能力与正式合同、已选组件，不再重选组件/不重做解析器**。本文件只做映射，不扩 H1 范围。

## 1. 回复串（线程视图）

| 原型资产（hifi-prototype） | 正式合同（已认证） | 映射要点 |
|---|---|---|
| `pages/Room.tsx` 线程区+`lib/threadNav.ts`（tab:replies/artifacts/activity/members/task/delivery） | `thread.history`（含 rootAttachments）、`task.get`（openTaskSnapshot 同构）、`thread.subscribe`（关注/静音）、`task.review`（三重绑定+目标固定=已收口） | H1 的 MessageView/Composer 直接复用；页面状态接 `roomPool`→`threadMessages` 同法装载（loadGen+归属门沿用）；深链 `#/task=…` 与 legacy `resolveThreadLink` 同源 |
| 消息定位（anchor/未读水位） | `thread.markRead`+`readStates` | 复用 DM 已实现的「前台+贴底+当前路由」readGate——线程页注册同一门 |

首包落点：RoomPage 卡片「打开回复串」→ 线程路由（新 `/thread/:id`）→ 首版只开 replies+task
两个 tab；artifacts/activity/members 经「原界面」定向（同 H1 模式，如实标注）。

**实施快照（第五十一轮 R51 已落地）**：
- RoomPage 主池=ThreadCard（room.pool 全字段投影：任务号/状态/回复数/未读/静音）；点击→`/thread/:id`。
- ThreadPage：单行导航（返回主池/回复/详情/成果 R52 禁用）+锚块（thread.get anchor）+回复
  （thread.history items+附件摘要）+Composer thread 目标（`buildThreadEnvelope`——projectId/
  conversationId/threadId 齐全）；记录串默认仅记录（服务端强制同判）；关闭视图不停止执行。
- 详情=任务概况（task.get DTO：status/activeRun/stopGeneration/lastStartupFailure）+停止
  （task.stop 绑定装载的 run+代次；终态拒绝）+交付验收（打开即冻结 id/revision/manifest_hash
  三重快照，目标变化作废不换稿——task.review）；未换装分组经原界面定向。
- readGate=线程独立水位门（store.threadReadGate，ThreadPage 注册：当前线程+前台+贴底+非接管；
  thread.markRead 发起时重查——不与 DM conversationSeq 门混用）。
- DTO 缺口补齐：新只读命令 `thread.get`（实体+根消息+水位；audience 核验）——不猜字段。
- 证据：tests/integration/hifiThreadRound51.test.ts（真实链 1/1）+ scripts/verify-hifi-thread-r51.cjs
  （实际 React 页面×正式 daemon×fake worker 页面链 pass=true + 同窗截图×2 视觉双 PASS，
  dist/desktop/review-r51/）。

## 2. 原消息 / 交付定位

| 原型 | 正式合同 | 映射要点 |
|---|---|---|
| threadNav 的 `targetForThread`/`threadHash` | `deepLink.resolve`（#task/#delivery/#msg 已有） | hifi 路由直接消费同一 hash 族；`delivery` 携带 deliveryId/revision/manifestHash（dmReviewContract 已钉合同） |
| DeliveryPanel 组件（交付版本卡） | `task.get.pendingDelivery`（revision/manifest_hash） | 组件 props 与 pendingDelivery 同构——接 taskReviewEnabled 呈现；验收/返工走已收口合同（打开意见框即冻结快照） |

## 3. 附件草稿（输入区）

| 原型 | 正式合同 | 映射要点 |
|---|---|---|
| Composer attachments 区（R51 已解锁真实通道：格式限幅前置+uploadText/Image/Pdf/Office/CSV 回执绑定会话；图片能力门=派发意图拦截并给出二选一，R52 提供显式 omit-images 确认） | `attachment.uploadText/uploadOffice`（包内字节通道+20MiB 前置+audience 校验——legacy `wireAttach` 已用） | 解锁 formalLimits.attachments；草稿 refs 进 `attachmentRefs`（loader 信封 builder 加可选字段——信封不可变原则不变）；「图片能力门」沿用 legacy 同判（IMAGE_INPUT_UNVERIFIED→仅记录或明确选择） |
| 芯片渲染/移除 | 现有 Composer 芯片（原样） | 上传回执的 attachmentId/revision/hash 进 HifiDraft.attachments（形状对齐 DraftReference） |

## 4. 共享预览（附件芯片→预览面板）

| 原型 | 正式合同/组件 | 映射要点 |
|---|---|---|
| `components/PreviewPane.tsx`（987 行，tabs+分栏+收起/放大） | `attachment.previewText/previewOffice`（H1 已映射 stub 形状）+ **vendored 渲染器**（pptx-renderer/docx-preview/Shadow DOM 隔离+净化——legacy preview 已全链认证） | 不重做解析器：hifi 侧新 `PreviewPanePage` 挂现有预览装载函数（从 legacy `previewAttachment` 抽取正式部分为共享模块，或经「原界面」定向过渡）；生命周期（releaseActivePreviewResources+代次门）原样复用 |
| 预览 tabs/返回快照（returnSnapshot） | 组件内部状态 | 直接复用组件；资源释放钩子挂 hifi 卸载路径 |

首包落点：M2=消息内附件芯片点击 → PreviewPane（文本/Office）；图片/PDF 同 legacy 分流。

**实施快照（第五十一轮 R51 骨架）**：消息芯片=真实附件摘要（thread.history items.attachments/
rootAttachments→Message.formalAttachments，MessageView 优先渲染）；点击→`attachment.previewText`
真实内联预览面板（ThreadPage 内）；非文本类型如实分列（toast+原界面指引，不复制未接服务的原型
resources/actions）。完整 PreviewPane（tabs/分栏/收起放大、Office/PDF/图片渲染器）R52 接入。

## 5. 边界（不扩范围）

- 预览高级导航（搜索/锚点评论/导出）不在 H2；经原界面定向。
- Git/看板/设置归位仍是 H3；H2 不动侧栏结构。
- 每项完成即更新本表「落点」为实施快照；未接通前 formalLimits 如实禁用。
