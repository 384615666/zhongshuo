# v14 房间根消息附件闪烁：独立复现（2026-10-11）

用户截图：同一房间任务卡的附件芯片偶尔出现约1秒，多数时候不可见。当前源码HEAD `8d46d1d`，冻结v14 renderer。

## 已确认根因

`Room.tsx` RoomPage与ThreadPanel分别每5000ms调用loadRoomPool/loadThread，两者写入同一个AppState.messages根消息。

- `thread.history`返回rootAttachments，loadThread写入threadAnchors的formalAttachments，hydrateThreadFromSnapshots将其写入根消息，芯片出现。
- `room.pool`返回卡片不含附件摘要；PoolData/ThreadCard映射也没有该字段。hydrateRoomFromPool生成roots时没有formalAttachments，随后按roomId过滤掉旧根消息再写入新roots，已装载附件被丢弃，芯片消失。
- 两个轮询的完成先后和间隔决定显示时长；任务详情读取等异步步骤会影响时序。不是据此判定附件上传失败或附件已删除。

## 独立证据

`dist/desktop/review-attachment-flicker-20261011/ui-result.json`：冻结v14、独立隐藏Electron/profile、正式命令、独立内存库。用自有文本附件正式上传并以record_only发房间根消息；展开其回复串，保持产品原5000ms刷新，无额外延迟钩子，250ms采样16秒。

根消息附件芯片数：0→1→0→1→0→1→0→1；变化约在262、4664、5178、9586、10112、14523、15050ms。消息卡一直存在，visibilityState一直visible。

数据库message_attachments关联数始终1，最终thread.history.rootAttachments仍1，real_calls=0。该探针退出0表示执行完成，报告pass=false表示附件稳定显示判据失败。未读取或修改用户数据库，未调用模型。

## 修复范围建议

统一根消息附件事实链，优先让room.pool携带按anchorMessageId绑定的权威摘要，并贯穿响应类型/卡片/水合层；房间主池即使未展开回复串也应显示实际附件。不只用历史值合并掩盖主池初次加载缺失，也不能以缺少字段当权威空列表。

同时核线程刷新：thread.get重建anchor不含附件；thread.history之后仅在rootAttachments.length>0时写入，需区分未获取、读取失败、权威空集合。避免刷新中先清空后补回，失败保留已确认快照并标错，权威空集合须可正确收口，不保留错误的陈旧附件。

验证至少包含：房间冷开不展开回复串；展开后跨三个5秒周期稳定；纯附件根消息与正文+附件；多附件精确身份与数量；两刷新回执反序；线程历史读取失败；切房间/项目不串；记录串和有任务根消息。数据库关联不变化，点击实际芯片可预览，零真实调用。

本轮只诊断并留证，未修改产品代码、旧包或用户数据。无需用户再上传文件或重复发送。
