# 第五十一轮复核与第五十二轮施工要求（2026-10-05）

复核对象：提交 `e07186a`。本轮主线继续 H2：完成新界面中的回复串、附件与共享预览，交独立候选包。H1 的补证已达到本次要求，不再占用一整轮。此次没有修改产品源码，也没有运行或改写用户的 H1 v2、DEV25 v6、server-data、RESULTS 或截图。

## 1. 可以收案的部分

- 独立重跑 `hifiThreadRound51.test.ts` 与 `hifiFirstPackage.test.ts`：两文件 **3/3**，进程退出 0；独立 hifi strict typecheck 退出 0。这是本次重跑的范围，不冒充重新跑过全量 855 项。
- 回复串已经是实际 React 页面与正式命令链：`thread.get` 补齐实体、根消息和归属；任务回复沿原线程，记录串默认仅记录；交付提交带三重身份。GLM 原始七步页面报告保留。
- H1 补证 `r50-20261004160543` 三轮报告：同 build `bld_f152ca66662dc4ab`，batExit=0、关窗前进程查询取得实际 PID、关窗后捕获 PID 核退、run2/3 按前轮身份核历史；负对照实跑 6 次、2036ms 超时。源脚本对应修复存在，旧危险验证器默认硬拒绝。**本次只读核对这些材料，没有再次启动用户包或重跑该三连。**
- v2 的原位重建和旧自检误接已登记在版本说明；后续独立输出。用户现在仍不要运行 v2 的旧可选自检，T4 未触发记 NOT_RUN。

## 2. 已复现 P1：上传回执改写另一个线程的附件

产品位置：`src/ui/hifi/components/Composer.tsx:311`。上传函数直接更新当前组件的 `attachments`，回执匹配条件仅为 `name + uploading`；没有捕获发起草稿键，也没有独立上传项 ID。

确定性复现（实际页面 × 正式 daemon，拦住两笔上传的回执，不靠猜时序）：

1. 线程 A 选择 `same.md`，内容 `A-ONLY-content`，上传回执暂缓。
2. 切到同房间线程 B，选择同名文件，内容 `B-ONLY-content`，其回执也暂缓。
3. 先放 A 的回执，再放 B 的回执。A 回执把 B 的 uploading 芯片改成 ready；B 回执再找不到 uploading 项。
4. 在 B 发「仅记录」消息。只读查询 `message_attachments → artifacts → 已保存副本`，**B 消息实际带的是 `A-ONLY-content`**。同会话内两个线程的 audience 相同，服务端归属检查无法替 UI 纠正选错资源。

证据：`dist/desktop/review-r51-audit-20261005/audit-result.json` 的 `auditUploadOwnership`，包含两笔原请求、最终 attachmentId、hash 路径和副本文本。

修复必须按「项目/会话/草稿键 + 上传项 ID」收敛到发起草稿。切走、卸载、同名文件、移除芯片、取消、晚到回执都不能改当前其它草稿或复活已移除项。A→B→A 应能正确恢复 A 的上传结果。发送/重试清算也用实际 ref/上传身份，不能继续以文件名和大小识别资源。

## 3. 已复现 P1：深链地址正确但落点错误

### 3.1 交付链接落到空私信

`deepLink.resolve #delivery=` 的实际 DTO 没有 `threadId`：`src/daemon/commands.ts:3251` 查询没有选 `conversation_thread_id`。新 `routeForResolved` 却依赖它，缺省转 `/dm/:conversationId`。

实际房间任务交付的解析结果为 `conversationId=convA`、taskId/交付三重身份均有效；页面最终变成 **`#/dm/convA`**，显示「本项目暂无私信会话 / 选择或新建一个私信会话」。测试里手造带 threadId 的 delivery DTO 不能证明正式链正确。

按真实归属补 DTO 或调用正式 `task.get` 查线程，DM 与房间明确分列；不能把未知归属直接当 DM。交付版本身份应保留，不能静默换成其它版本。

### 3.2 query 被丢弃，详情/消息定位未生效

`App.tsx` 先执行 `pathOf(route)` 去掉查询串，随后又从这个已去 query 的 `path` 解析线程参数。`tab=task` 与 `message=…` 永远取不到。`ThreadPage.tsx:54` 还只用初始参数初始化 tab，后续同一线程的路由参数变化也不会同步。

实际页面：`#task=<有效任务>` 已规范化成 `#/thread/<id>?tab=task`，**aria-selected 仍是「回复」**。原七步验证器 T7 只判 URL 与 resolve 命令，因此此缺陷仍能得到 pass=true。

用完整 route 解析参数，并验证真正显示详情/真正定位目标消息。补同线程 query 改变、前进后退、刷新、跨项目和迟到解析的代次；根消息/历史消息定位要等目标数据存在，不能仅靠固定 350ms。超过首屏 history 范围时有界补读或明确说明，不能冒充已定位。

证据：同一 `audit-result.json` 的 `auditTaskRoute`、`auditDeliveryRoute`；第二个独立窗口记录在 `read-case/audit-result.json`。这些报告里的 `pass` 是原始七步的汇总，**新增 audit 字段记录了反例，不是新增反例通过**。

## 4. 已复现 P1：回复未呈现却推进阅读水位

独立延迟 `thread.history`，先在新界面切「详情」，再放回历史响应。此刻实际选中详情、`.msg-list` 不存在，仍发出新界面的 `rd-* thread.markRead(throughMessageSeq=3)`，数据库水位从 0 变成 3。

根因：`ThreadPage.tsx:73` 对 `listRef.current == null` 返回 true，详情/未挂载容器被视为贴底。门必须要求当前线程、当前回复视图、实际可见容器、前台与贴底；容器缺失缺省拒绝。之后真的阅读/滚到最新回复才推进。

同一次取证还出现两个旧界面的 `ui-* thread.markRead`。旧 `app.js:4480` 的 hashchange/popstate 监听没有接管所有权门；隐藏的 legacy 仍执行 `restoreDmDeepLink → openThread → renderThread → markRead`。这也解释原 T7 的多次 resolve。

导航只由当前可见客户端处理：hifi 可见时 legacy 深链恢复和标读不得运行；接管后 hifi 暂停；异步返回前再次核代次和所有权。只暂停轮询不够。

证据：`dist/desktop/review-r51-audit-20261005/read-case-hidden/audit-result.json` 的 `auditDetailsRead`：`selectedTabs=[详情]`、`visibleReplies=false`、三笔 markRead（其中一笔 rd-*）、最终水位 3。

## 5. 已复现 P2：新文本上传回退到有损解码

`src/ui/hifi/loader.ts:576` 使用 `File.text()`。页面选择原始字节 `41 C3 28` 的 `invalid-utf8.md` 后，发送 `content="A�("`，服务端接受并持久化替换后的副本。旧正式界面在第27轮已经用 fatal UTF-8 修过此合同，换装不能丢失。

改为读取真实字节，再 `TextDecoder('utf-8', {fatal:true})`；非法字节明确失败并保留草稿，零上传命令/零 artifact。合法中文/BOM/边界大小沿既有合同复验。证据在第一份 `audit-result.json` 的 `auditInvalidUtf8`。

## 6. 第52轮仍交 H2 完整体验候选

以上反例先修，同时完成已经排定的共享预览，不把第52轮又变成只有修复/盘点的一轮。

1. 用批准的原型 PreviewPane 接入文本/代码/Markdown、图片、PDF、Word、PPT、Excel/CSV 的已有只读服务与既有渲染器，保留来源、版本、hash；视觉预览与提取/模型输入分别说明。房间主池、线程根消息/回复、DM、草稿芯片都应能打开对应资源。正常样本真实渲染，明确降级不能算正常预览通过。
2. Preview 的晚到 A→B、关闭、切会话、取消、dispose、Word Shadow DOM、禁 altChunk、净化与外链阻断沿现有合同，不重做解析器、不恢复自造 PPT SVG、不引入 B/OCR/视觉模型渠道。
3. 把 attachmentRefs、表格 attachmentRanges、imageAck 与明确派发/仅记录意图一起冻结进正式信封。显式确认必须准确说明图片没有送给模型；未知回执重试逐参数一致、恰一次；成功清实际已发 refs，新草稿/新附件不被清掉。上传/解析排队失败可恢复，不能显示假成功。
4. 在实际 React 页面与正式 daemon 上证明本次负例，并保留正常链：回复不新建根任务、记录串零派发、读取失败保留快照、绑定停止与验收、前进后退与消息定位。深链验证以实际选中视图/可见目标为准，标读验证需要详情/后台/历史阅读的拒绝对照。
5. 输出独立 `hifi-h2-win-v1` 候选（或同等明确新目录）；只验证最终产物身份一致的完整链、真实启动器、优雅停机与 real_calls=0。材料按真实新入口写用户短测，种子样本随包、仅一次集中手测，不复跑 D1—D10/R1—R5。原型同窗截图核阅读空间和预览布局。

H1 v2 与 DEV25 v6 原地保持稳定。Android 继续使用既有 v6 单独回填，不作为 H2 施工阻塞。A+Word 方案不变、B 不集成、零新增真实模型调用、价值评价/DEV-11/并行写入仍暂缓，G5 不连带宣布。

## 本次隔离探针说明

新取证均在 `dist/desktop/review-r51-audit-20261005/`：独立 Electron userData、当前源码新建 UI bundle、正式 daemon 内存库、FakeRuntimeAdapter、独立 blobstore。准备脚本与运行脚本一并留存；原 `dist/desktop/review-r51/` 报告及截图未覆盖。没有连接用户正在运行的 daemon、没有修改用户数据或启动用户包。
