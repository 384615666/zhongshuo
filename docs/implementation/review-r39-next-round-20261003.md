# 第三十九轮复核与第四十轮交付门槛（2026-10-03）

基线：HEAD `f24e7a0`（包含 `ceb1501`）。本次只读检查源码、原型报告和部分归档截图，在独立进程的内存数据库中经真实 dispatchDaemonCommand 复现反例；没有启动模型/worker，没有修改验收包与用户数据。

> 后续选型修正（同日，用户补问 ZCode）：已核对 ZCode 的轻量专用预览组件，默认采用 LibreOffice 的建议暂停，先做轻量组件对比。本文件 §6 中零手动配置/控制体积要求有效，默认引擎路线以 `preview-engine-zcode-comparison-20261003.md` 为准；其他已复现缺口不变。

## 1. 接受的进展与尚未交付的范围

- 在途检查已改为 workflow_runs.task_id 归属；恢复派发键已加入 sourceRunId；DOMPurify 与 markdown-it 已进入真实 renderer 链。
- LibreOffice 原型不是纸面方案：convert-report.json 记录两个样本的成功转换，PDF 与逐页截图存在，本次查看了柱状图和组合形状截图。冷转换约 6 秒、原型工作集约 480—543MB 是该测量方法下的数据，不推广为所有文件性能。
- 原型只有两个合成规范 OOXML 样本、14 页；“可用于视觉预览”是原型结论，不能扩为所有实际 PowerPoint 文档已兼容。母版/主题等实际保存文件、字体缺失、宏与外部资源禁止仍需产品化验证。
- 冻结三连与 v4 尚未交付，用户现在不需要操作。839/839 是 GLM 的本地报告，本次没有重新跑全套。
- 当前 continuation 顶部仍写第三十八轮唯一快照。下轮必须补第三十九轮实际状态（未冻结/未发 v4/原型与产品化分列），避免续工误读。

## 2. P1：预算结算不等于旧执行退出，当前守卫仍会放行

`commands.ts` 的 task.redispatch 只把 UNKNOWN 且 budget_mark 为空或有未释放 lease 判不可恢复。`dm.ts` 的 recoverable 也沿用该条件。

### 2.1 经正式对账：退出身份缺失、保护保留，重派仍成功

内存库中经正式 conversation.create/message.submit 建 DM 任务，登记 INTERRUPTED run+UNKNOWN turn（没有登记进程身份，也没有 workspace lease；只读任务/启动窗口中断等情况不能因无 lease 就视为已退出）。调用正式 recovery.reconcile(executed)，然后读取会话并调用 task.redispatch：

```json
{"reconcile":{"ok":true,"reason":"executed-exit-identity-missing-protection-retained","turnFinalStatus":"UNKNOWN","protectionRetained":true},"budget":{"status":"UNKNOWN","budget_mark":"settled"},"recoverable":true,"redispatch":{"ok":true,"enqueued":true},"realCalls":0}
```

恢复对账本身正确地记录“身份缺失、保护保留”，重派却仅由预算标记和 lease 缺席推成可恢复。这不是手改 settled 的伪造场景，已通过正式对账命令复现。

### 2.2 人工未启动声明：FAILED/refunded，active lease 仍在，重派也成功

同类内存任务登记 active workspace lease，调用 recovery.reconcile(notStarted, manualRiskAck=true)。既有合同保留保护，turn 变 FAILED/refunded。task.redispatch 的 lease 检查只覆盖 UNKNOWN，因而放行：

```json
{"reconcile":{"ok":true,"protectionRetained":true,"turnFinalStatus":"FAILED"},"lease":"active","redispatch":{"ok":true,"enqueued":true}}
```

以上证明命令入口错误接受并新增意图，不是本次已经发生并发模型调用的证据。

### 修复要求

- 预算处置、执行结果、进程退出、保护解除分别检查。不能把 budget_mark 非空、无 lease、turn 已 FAILED 任一项当完整恢复事实。
- 可恢复性查询与实际命令提交共用服务端判定，并在事务提交时重查。
- 任何旧执行仍有在途、退出未确认、结果未对账、保护未解除，都不能新建派发；no-os-process 走既有程序事实，受管进程走正式身份/退出证据。
- UNKNOWN 未闭环、人工退款但保护保留、身份缺失/查询失败、跨重启以及合法完整恢复均补正式链反例；失败零新增 outbox/run/turn。不要用 SQL 改 settled 代替恢复合同。

## 3. P1：sourceRunId 没有验证真实归属，版本化意图可被任意号绕过

命令直接使用 params.sourceRunId，未证明它存在、属于本 task、是当前可恢复执行。对已无在途的同一任务，连续传两个不存在的源 ID，正式命令均成功：

```json
{"case":"nonexistent-source-run","firstAccepted":true,"secondAccepted":true,"newDispatches":2}
```

要求：源 run 必须存在且属于目标任务，符合当前恢复版本/状态；客户端拿到的 sourceRunId 只是引用，不能替代服务端事实。不存在、他任务、过时来源均拒绝且零写入。同源同 commandId 重放返回原结果，双端同源点击恰一个意图；新一次合法中断才生成新来源。检查同任务当前 pending/leased 恢复意图，而不只查客户端指定的某个键。

## 4. 短回归种子尚不可用，不是只修两处验证器就能发包

`scripts/dev25-dual/seed-client.cjs` 的 seedInterruptedShape：

1. INSERT tasks 写 created_at，但当前迁移后的 tasks 没此列。本次在隔离库准备同一 SQL，实际报错：

```json
{"code":"SQLITE_ERROR","message":"table tasks has no column named created_at"}
```

2. 即使删掉错列，root_message_id=NULL，未建用户根消息。assembleDmTurn 明确返回 missing-root-message，R1 不能按指南推进到执行回复。
3. 手写 UNKNOWN+budget_mark='settled' 且不登记退出事实，沿用第 2 节错误合同。任务/消息应走正式命令，必要的故障形态注入应注明；恢复事实经正式 fake/no-os-process 对账链准备。若另造不可恢复负例，要与可恢复正例分开呈现。
4. 已核对 `openDb` 的相对定位与包内 `seed/seed-client.cjs` 布局相符，不将它另判为缺陷；源码目录直接执行与交付路径不同，最终仍须用实际启动器验证包内依赖加载。
5. 指南 R2 桌面先继续后，同一会话不再 paused，远程不能按同样前置再点击；工程侧准备两独立演练状态或明确恢复步骤。成功反馈须在正常刷新后仍可读，不能一写 dm-state 就被 renderDm 覆盖。
6. “PPT 本地+远程桌面均可”须对齐真实入口；没有远程预览 UI 时不要求用户找不存在的控件。

必须从清空 ZS_*、新数据根、普通 shell、真实 start-server.bat 跑完整 R1—R6 前置和操作；再跑一次验证种子幂等。仅 UI 出现按钮/outbox 入队不是 R1 正例，至少 fake startTurn、回复落原会话、终态与重复点击计数正确。

## 5. 验证器修复方式与交付顺序

- 以 f24e7a0 为起点保留原型和指南，不硬重置回 ceb1501 丢新资产。
- 先局部修净化断言的模板转义、版本化键查询，再按正确恢复合同修前置。不要以塞 settled 让按钮出现的方式“修绿”。
- 把 CDP 断言封装成可检查的函数/结构化参数，运行前检查生成脚本语法；Runtime exception/读取错误不得当空值或 PASS。变量文本出现六次不等于声明六次，按作用域核对，不继续叠文本替换。
- HARNESS、REMOTE、ATT 的受影响段先过，再冻结同一最终产物跑三次完整序列，逐 runId 保留失败/中止。完成后交独立 v4，逐文件核对、真实启动器自测、短回归指南/模板随包且路径一致。
- 原 v2/v3、CA、业务库、RESULTS 和截图不覆盖；新数据根新 CA 如实说明，不重复 D1—D10。固定候选包就绪后用户短回归，再 Android。已有 D1—D10 通过不抵消本次新守卫缺口。

## 6. 用户本次明确的部署方向：零手动配置、主安装包控制体积

用户答复：“我需要用户没有感知的，并且软件安装包不会也这么大吧？”

解释口径：1.57GB 是原型解压后的磁盘占用，不是压缩安装包大小；原型 MSI 约 357MB。随主包携带仍会显著增加分发体积，不能未经实测承诺一个很小的完整离线安装包。

建议实施方向：

- 用户只安装众说，预览引擎由软件自动下载/校验/配置，作为受管理的独立组件；不要求用户找 LibreOffice、配 PATH、装 Node/Java 或管理员手工处理。
- 主安装器可保持精简，安装过程自动准备组件；有明确进度/失败重试，避免第一次点 PPT 长时间无反馈。额外完整离线包作为补充：首次无网可用必须携带组件，这个体积代价不能藏掉。
- 引擎只在服务机；客户端/Android 无额外软件安装。文档全本地处理，零模型调用，下载公开引擎不等于上传附件。
- 单独报告主安装器大小、完整离线包大小、组件压缩下载量/展开占盘、字体体积、冷/热转换、全进程树内存。原型按全部 soffice 名称取最大 WorkingSet，不是本次独占进程树完整预算证明，应按受管身份重新度量。
- 引擎版本固定、哈希/签名校验、许可证材料、缓存更新/回滚/卸载设计随产品化完成。宏与外部资源禁止需故障样本实证；仅使用不含宏/外链的样本不证明禁止机制。
- 原型已有实际运行成果，可开始产品化；不能把自写 SVG 的降级占位改写为与成熟引擎同等完整预览。PPT 保存/预览既定范围不降为“可选以后再说”，正文提取与图片模型输入认证仍分列。
- 根据实测设转换子进程预算、截止、并发和停止收拢；不把旧小型解析子进程限额原封照搬给整个 Office 引擎。

CSV/Papa Parse、DOCX/docx 后续分批，不阻塞当前安全修复与短回归包。价值评价暂缓；DEV-11/并行写入增强不开放；OCR/新视觉渠道先方案；DEV-15/16/G5 不提前宣布通过。
