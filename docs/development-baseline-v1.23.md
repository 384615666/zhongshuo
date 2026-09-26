# 众说开工契约与实施基线 v1.23

日期：2026-09-26。主设计 §4.6、§8.3、§12、§15、§20、§31 的规范性补充；由主设计引用生效。解决 R4—R11、E11/E13 的设计缺口，设计完成不等于程序实现或行为认证。产品约束延续用户既有决定；本文新增默认值属于实施默认，不另增产品功能。

## 1. 当前范围与工程入口

- 正式工程位于 `D:\zhongshuo` 根目录，pnpm 单仓单包，`src/contracts/domain/persistence/adapter/daemon/ui` 六边界；原型保留独立依赖。Git 已存在，不重复初始化、不覆盖旧文件、不搬移资料。
- 原型是交互基准，正式工程复用经过核对的组件和样式；不能将原型内存 actions/store 直接作为数据库或调度内核。主设计决定业务语义，原型决定已确认的交互；发现两者冲突先定位并记录，不自行用 mock 行为覆盖主设计。
- DEV-01 仅 contracts、路由纯函数、schema 与测试。M0 依次完成契约、持久化/fake adapter、目录/daemon、真实 runtime、线程隔离、界面接入。不要将本次文档收口当作后端已实现。
- `parallel_writers` 及 worktree 增强按 §14.7 延期，当前实现只开放 single_writer；旧配置若为 parallel_writers，显示能力不可用并按单写者调度，不隐式开放。重叠目录锁域、前像、停止旧进程与恢复检查继续必做。
- 提交前逐项确认改动归属；默认新施工分支 `codex/<work-package>`，保留用户未提交改动，不自动全量 add、提交或推送其他会话的工作。

## 2. R4：项目文件夹内的普通一对一对话

### 2.1 用户体验与执行单位

用户选一个项目和一位成员，新建对话后直接发送；没有房间选择、协调者、@ 路由、群聊模式、任务号或任务卡。同一项目同一成员允许多条独立对话；再次打开已有对话恢复原历史，新建才产生新 conversationId。项目路径重定位保持 projectId 与对话不变。

对话的工作目录是所属项目的 canonical_path，遵守该项目权限、预算和单写者限制。聊天历史、附件副本、session 与草稿放应用数据目录，不在用户文件夹自动生成聊天文件。项目成员能读工作目录，不代表能读其他私信；应用输入隔离不承诺 OS 级阻止 CLI 读取项目内历史文件。

每次给 Agent 的用户发送形成一个内部执行任务 `kind=dm_turn`，一个 DIRECT workflow_run；这是复用停止、预算、审批、交付与恢复设施的内部记录，**不分配 room_task_number、不在房间主池或默认群聊任务看板露出**，返回运行状态供对话内展示。UI 和 `resolveDmRoute` 不推导/选择 Mode；daemon 固定唯一对端并使用 DIRECT 内部执行策略。同一对话运行串行；运行中再次发送保存并排队，明确显示等待，不把两条用户要求偷偷合并或并行派发。停止只停止目标运行；已排队消息转为 paused，需用户继续，避免停止后立即又启动。

后续发送可续接同一私信 session，因此能记住该对话上文；不同 conversationId 永不共享 session。重试同一消息不重复创建执行；显式“重试回答”创建新 attempt 并保留旧输出。归档后禁止新发/续跑/提醒，保留历史；正在执行的运行按停止流程收尾，无法确认退出时维持锁和明确故障，不伪称已停止。

人对人只投递保存，不产生 Agent 运行。Agent 对 Agent 的消息默认只投递，不以每条输出继续自动唤醒：需要既有授权任务链的显式派发，并继承链预算/范围/停止代次；不新增无界互聊循环。该扩展随 FULL-02，v0.1 先交付本机用户与项目 Agent 的一对一闭环，保留其他参与者类型契约。

### 2.2 表结构增量（§12.2 的正式增量）

| 实体 | 字段与约束 |
|---|---|
| conversations | id、project_id、kind(room/dm)、room_id?、title、archived_at、revision、last_message_seq；room 类型恰有一个所属 room 且同项目唯一，dm 的 room_id 为 NULL |
| dm_participants | project_id、conversation_id、principal_type(human/agent)、principal_id；组合唯一；dm 创建事务中必须恰好两个不同主体，v0.1 为一个本机用户和一个本项目 Agent；创建后不可追加第三人或替换对端 |
| conversation_threads | 增 conversation_id；房间 thread 保留 room_id；DM 不创建 thread（thread_id 为 NULL） |
| messages | 增 conversation_id、conversation_seq、client_message_id?、via_connection_id?；DM room_id/thread_id 均 NULL；房间消息保留旧关联；(conversation_id,conversation_seq) 唯一；序号由服务端事务分配 |
| tasks | 增 kind(room_task/dm_turn)、conversation_id；dm_turn 的 room_id、conversation_thread_id、room_task_number 均 NULL，root_message_id 指本次用户消息；room_task 继续原约束；部分唯一索引仅约束非 NULL 房间任务号 |
| workflow_runs / agent_turns | 增 conversation_id；DM thread_id 可空，run/turn 必须与 task 同项目同会话；run 内部 mode=DIRECT，唯一参与者为对端 Agent |
| runtime_sessions | 增 conversation_id、scope_kind(task/dm)；房间按 task/member/generation 隔离；DM 按 project/conversation/member/generation 复用，task_id 对 DM session 为空；当前 task 由 turn 绑定，不随会话复用改写历史 turn |
| artifacts / attachments / context_bundles | 增 conversation_id，DM thread_id 可空；audience 从会话关系推导，客户端不能扩展；引用具体版本和 hash |
| domain_events | 增 conversationId；会话事件必填，DM 不伪造 threadId；列表、订阅、未读、搜索和导出均按同一范围过滤 |

组合外键至少验证 `(project_id, conversation_id)`，任务/run/turn 同时校验所属关系；NULL 不表示公开。room/dm 判别约束必须在运行时 schema 和数据库 CHECK/事务中双重执行。给旧房间回填一对一的 room conversation；旧私信按旧稳定 ID 映射，不能按成员合并。原型数据不是生产迁移来源。开发前无真实数据库，可在 DEV-02 首次 migration 直接采用新结构；如发现实际旧库则先备份并独立验迁移。

### 2.3 命令与回执

`MessageTarget` 是判别联合，禁止客户端同时提供多种目标：

```ts
type MessageTarget =
  | { kind: 'room_root'; projectId: string; conversationId: string; roomId: string }
  | { kind: 'thread'; projectId: string; conversationId: string; threadId: string }
  | { kind: 'dm'; projectId: string; conversationId: string };
type DispatchDisposition = 'none' | 'queued' | 'paused';
// 默认发送意图为 default；DM 同样保留菜单内一次性 record_only，不恢复常驻切换。
```

| 命令 | 输入 | 输出与约束 |
|---|---|---|
| conversation.create | projectId、kind=dm、peerMemberId、title?、commandId | conversationId、revision；主体从 CallerContext 推导；重复同 commandId 返回同一对话，不按成员自动合并 |
| conversation.list | projectId、archived?、limit、cursor? | 本人有权看到的会话摘要、最后消息与未读；不返回其他 audience 正文 |
| conversation.history | conversationId、beforeSeq?、limit | 授权历史、nextCursor；Agent 必须同时受其 turn 的上下文范围限制 |
| conversation.archive / restore | conversationId、expectedRevision | revision；归档触发上述停止/暂停规则；restore 不自动续跑 |
| message.submit | target、body、attachmentRefs[]、intent、mentions[]、commandId | messageId、conversationId、threadId?、taskId?、runId?、disposition、resolvedRoute；DM mentions 必须为空；record_only 只保存、不建 task/run、不占预算，成功后意图复位；human 对端无 task/run |
| task.stop | taskId、targetRunId、expectedStopGeneration、commandId | stopping/stopped/already_stopped/target_obsolete；不停止更新的 run |
| task.resume | taskId、expectedRevision、commandId | 新 run 或恢复的受支持 attempt；只允许人类显式继续，重新核对归档、成员、权限和预算 |

预算不足/对端不可用/权限档位未验证时：消息仍可保存，内部任务标 BLOCKED/WAITING_USER、无运行或无派发，回执给出原因；权限与目标校验失败则整笔拒绝，不能先泄露/保存到其他会话。消息、内部任务、预算占用、outbox 和回执须原子提交；“已发送”只证明保存，“正在运行”来自真实 turn.started。

DM-BASE-01—08：新建与重复提交；同成员两会话隔离及本会话续接；跨项目目标拒绝；无 @ 派工/无任务号；连续发送串行及停止后暂停队列；归档只读/恢复不自动执行；附件搜索导出 audience 一致；崩溃重启历史保留且未完成运行等待用户。以上为正式实现验收，原型只能覆盖其中 UI/mock 部分。

## 3. MCP 预留与共用命令契约

### 3.1 CallerContext 与执行范围

`CallerContext` 只由认证后的 daemon 入口生成，不能放进可自报的 CommandEnvelope：actualPrincipal(kind/id)、representedUserId?、entry(ui/zs/mcp)、credentialId、connectionId?、projectIds、conversationScope、operations、dispatchMemberIds、budgetGrantId?、runId?/turnId?/epoch?、grantRevision。zs 任务凭据必须绑定成员、会话、运行与代次；本地 UI 的 credentialId 非空，connectionId 为空不代表可信。LAN 配对客户端映射已认证人类主体；MCP 外部助手的 actualPrincipal 始终 external_connection，不因 representedUserId 变为人类。

有效范围为调用凭据 ∩ 当前授权 ∩ 目标 audience ∩ 运行链上限；枚举、读取、派发、停止分开判断。调用者有项目权限仍不能默认读该项目所有 DM。MCP 首批只暴露房间/线程目标，DM 必须新增显式会话授权与工具契约后才开放，不能经 tasks_get/artifacts_read/events_list 间接读取私信。

预算是第四维：DEV-01 定义 BudgetGrant/Reservation 与纯校验，DEV-02/05 承担事务预占/结算；每次派发同时检查任务预算和发起连接工作链预算，子任务/交接继承上限。检查与占用必须同事务；无真实价格时保留 unknown，不伪造费用为零。读取权限不附带任何模型调用额度。

### 3.2 幂等、查询与停止

回执主键为 `(idempotency_scope, command_id)`，scope 从认证主体/连接推导，所有入口都使用，MCP 工具 idempotencyKey 映射同一机制。payloadHash 对规范化 method/target/params（含 expectedRevision）计算，不包含凭据。相同 scope/key/hash 返回持久结果；同键不同 hash 拒绝 IDEMPOTENCY_CONFLICT。授权每次重检，包括重放，吊销后不能凭旧回执读取结果。已有回执重放先于 expectedRevision 的业务变更检查，避免成功请求重试因旧 revision 被误拒。

领域改动、事件、预算预占和 command_receipts 在一个数据库事务提交，提交后响应丢失可用同键恢复；提交前中断不产生部分任务。长期保留幂等墓碑（至少 scope/key/hash/结果定位），不能因日志保留天数清掉去重后允许再执行。敏感正文可按数据清理策略删除，返回 RESULT_EXPIRED 而非重新执行。DEV-01 定义 `command.result.get(commandId)`，由当前 CallerContext 限定 scope；DEV-02 实现回执查询。

create/send/steer 必须有键；stop 同样使用 commandId 并绑定 runId+stopGeneration。旧 run 的 stop 返回 target_obsolete，不修改新 run、不取消后续运行；同一运行并发 stop 只推进一次停止代次。断连、取消请求和停止业务任务沿用 §31.4，禁止相互等同。

### 3.3 四项查询契约（现在定字段，FULL-11 接 MCP）

| 命令 | 参数 | 结果 |
|---|---|---|
| room.list | projectId、includeArchived=false、limit=50(1..200)、cursor? | items[{id,projectId,conversationId,name,archived,revision}]、nextCursor? |
| member.list | projectId、roomId?、limit、cursor? | items[{id,displayName,enabled,runtimeHealth,capabilities,dispatchable}]、nextCursor?；不暴露凭据/环境变量/私有配置 |
| task.get | taskId | id、conversationId、threadId?、status、revision、activeRunId?、stopGeneration、delivery?、attentionSummary；未交付也可查 |
| events.list | projectId、conversationId?、taskId?、afterSeq? 或 cursor?、limit=100(1..200) | items[]、nextCursor、hasMore、highWatermark；无事件立即空返回，不持有请求 |

游标不透明且绑定主体、过滤条件和授权版本；查询结果只含授权内容，分页不能先截全局前 N 条再漏掉该页全部可见项；events 的 nextCursor 表示扫描位置，无可见事件也能前进，避免反复扫隐藏项。授权缩减重建游标并重新过滤；非法游标 CURSOR_INVALID，历史已清理 SNAPSHOT_REQUIRED，返回同范围快照入口。所有查询先解析目标，再核对项目及 audience，越权与不存在统一 RESOURCE_NOT_FOUND；诊断记录真实拒绝原因但不给调用者枚举线索。

MCP-BASE-01—08：自报身份拒绝；读不附带派发；会话越权拒绝；同键同参/异参及跨连接；提交后丢响应重试；预算并发预占；旧停止不伤新运行；查询游标/撤权/空页/过期。MCP 本体的协议兼容仍按 §31/RT-28 验证，本次不修改既有协议版本选择、不声称实现了 MCP。

## 4. R5：跟进名单与运行参与者

新增 `thread_agent_followers(project_id,conversation_id,thread_id,member_id,status,revision,added_by,updated_at)`，组合唯一。`thread.follow` 继续是人类阅读关注；房间成员决定可参与的上限；followers 决定后续自动跟进候选；run_participants 是本次冻结参与者，三者不得复用一张表。

`thread.members.add/remove(threadId,memberId,expectedRevision)` 仅授权人类可执行，幂等走共用命令。增加只能选当前项目/房间启用成员，不直接发起调用、不重写活跃 roster；下次合法运行冻结时生效。移出后：取消该成员未派发的自动唤醒与提醒，阻止新的自动 turn，已有 turn 不强杀；本次 run_participants 保留并标 follow_removed，当前阶段已有成果有效，后续屏障中尚无响应的席位按 withdrawn 记缺席，不代签。用户需立即停止时使用目标 run/turn 的停止入口。

本次仍在运行的 turn 返回可按既有阶段规则接受；更晚阶段的迟到稿按 §5 保存。移出不剥夺其已获得的 OS 文件权限，不宣称清除了 runtime 记忆。重新加入不自动恢复取消的派发，需要下一条合法输入。DIRECT/DM 永不因 followers 扩员；非 DIRECT 用户扩员仍保留既定确认流程。

FOLLOW-01—04：三名单不混用；移出时待发/在跑/下一阶段分支；重复增删与 revision 冲突；重新加入不重放旧唤醒。

## 5. R6：缺席、超时与迟到结果

- absenceGrace（默认 20 分钟）从成员在该阶段首个真实 turn.started 起算；等待写锁/并发/用户确认不计缺席，等待原因单列。未开始成员由 dispatchWaitDeadline 管理（实施默认 20 分钟，可配置），超过后按 unavailable 缺席处理，不能一直阻挡其他已完成成员。
- turnDeadline 管单次运行超时；两个截止同时发生，先处理终止/超时与进程确认，再计算屏障；该成员不同时计为有效完成和缺席。计时信息持久化，睡眠/重启后核对实际截止，不自动补跑。
- 屏障满足“全员有效完成，或每个未完成席位已有明确失败/缺席/撤出原因”可自动推进；至少要有一份有效输入。全员缺席/无有效输入进入 BLOCKED，无模型合成虚构报告，用户可重试/调整预算/取消。
- 阶段因缺席推进不强杀仍在跑的成员，原输出凭原 turn 凭据与原 resultKey 可上传至迟到收件区，但**不能作为当前阶段提交、推进屏障或触发新派发**。原 attempt 被重试取代、停止或授权撤销后，普通提交拒绝 STALE_EXECUTION；仅 adapter 的受信诊断通道可存原始残留，标 invalid，不当成果。
- 迟到稿到达时下一阶段尚未冻结输入，可由事务将其纳入新输入版本；输入已冻结则本轮不变，作为 late 附录待下一轮显式使用。已经 PUBLISH 后不静默改报告；展示新增迟到材料，用户要求更新才创建新 run/报告 revision，并重做必要确认。
- 同一事件到达/超时竞态由阶段 revision 的事务比较决定；先提交生效的一方决定本轮输入，其余走迟到分支，留 event seq 可复查。

LATE-01—06：未启动排队、全员缺席、两截止同时到达、阶段前后迟到、发布后到达、停止后旧结果；均验证状态、预算及可见报告版本。

## 6. E11：Agent 命令、阶段与结构化互唤

任务凭据必须绑定 project/conversation/task/run/turn/member/attemptEpoch/stopGeneration，服务端生成目标，不接受输出覆盖目的地。私信读取入口命名 `zs conversation read --task <taskId> --after <seq> --json`；旧 `zs room read` 仅房间兼容别名，DM 误用返回 TARGET_KIND_MISMATCH。

新增 `zs message send --task <taskId> --request-file <path> --json`：JSON 为 `{schemaVersion:1,commandId,body,mentions:[{memberId}],requestReply:boolean}`。无 requestReply 或 false 只记录；true 必须有合法 mention、全部目标通过名单/阶段/预算校验。老 `--body-file` 保留为只记录入口。正文内 @ 永不产生执行。

回执 `{messageId,dispatches:[{memberId,disposition:'queued'|'rejected',reason?,dispatchKey?}]}`；仅“queued”代表派发已提交，仍不表示执行已开始。混有越权目标时整笔拒绝，不能部分成功后鼓励改键重发。重复请求返回原回执；dispatchKey 由 command receipt + memberId 派生，预算占用与 outbox 同事务。

| 模式 / 阶段 | 可读取 | 发普通进度 | 主动互唤 | 可提交结果 / 提案 |
|---|---|---|---|---|
| DIRECT（含 DM 内部执行） | 当前获准 task 输入；DM 本会话授权历史 | 是 | 否，其他成员零派发 | TaskComplete；request_participant 仅建议，由人确认另建房间任务，不改变 DM 双人边界 |
| AUTO 计划 | 当前输入、授权项目上下文 | 是 | 否，计划先验证 | DelegatePlan；HandoffPropose（不直接派发） |
| AUTO 执行/整合 | 当前任务链明确授权成果 | 是 | 当前链已冻结且获准的参与者；接收者仍不能读取未获授权子任务 | TaskComplete/HandoffPropose |
| DELIBERATE / INDEPENDENT | 题目、相同基线、自身草稿 | 是（不向其他独立作者注入） | 否 | AnalysisReport |
| CROSS_REVIEW | 已冻结的本轮初稿 | 是 | 否，先保持独立互评 | ReviewItem[] |
| ISSUE_DISCUSSION | 当前争议及已发布轮次材料 | 是 | 当前 run 冻结且未移出的参与者，受预算与轮次限制 | PositionInput；主持 checkpoint 用 CheckpointVerdict |
| SYNTHESIS | 已冻结初稿/互评/立场与缺席事实 | 是 | 否 | 仅整合者 SynthesisDraft |
| RATIFY | 冻结整合稿、引用证据、自身确认项 | 是 | 否 | RatifyResponse，仅本人项 |
| PREPARE / PUBLISH / 终态 | 获准历史只读 | 否 | 否 | daemon 推进，不派发 Agent 提交 |

artifact.read 同样执行阶段可见性；artifact.submit 只接受 outputContract 允许 kind。所有 Agent 永不调用审批、任务验收、预算提升、成员配置、context grant 或阶段推进。HandoffPropose 固定 `{commandId,kind:'request_participant'|'delegate',targetMemberIds,objective,sourceRefs}`；DIRECT 只可 request_participant，AUTO delegate 仍由 daemon 验证名单/依赖，不把提案视为已授权。

resultKey 由 daemon 为逻辑输出分配，绑定 run/stage/member/targetRevision；CLI 和 adapter 最终结果共用。相同 key/hash 返回既有 artifact，不重复发布；不同 hash 返回 RESULT_CONFLICT。修复 turn 共用逻辑 resultKey，但有新的 turnId/attemptEpoch 和 originalTurnId；只有旧稿未发布且运行仍有效时，daemon 原子将预期提交者移交给修复 turn。最多一次格式修复，旧 turn 此后不再有提交资格。迟到稿走 §5 专用分支，不放松 fencing。

E11-01—06：每行正反用例；合法互唤恰好一次；阶段禁止/名单外零派发；DIRECT 零扩员；双提交同 key 去重/异参冲突；旧代次/修复/迟到分支独立。

## 7. E13/R9：提示词、输出与恢复

正式包编号 DEV-21；M0 交付 DIRECT 和权限/注入基础，M1 交付研讨模板，M2 交付 AUTO，M3 交付 DM/提醒/跟进模板。依赖 DEV-01/03/06，验收 PP-01—12；schema 源归正式 contracts，DEV-01 写基础目标/信封，DEV-21 写阶段输出 schema，不要求先把 FULL 都写成字段。

模板选择是程序表：DIRECT/DM→TaskComplete；AUTO.plan→DelegatePlan；AUTO.execute/integrate→TaskComplete；INDEPENDENT→AnalysisReport；CROSS_REVIEW→ReviewItem[]；ISSUE_DISCUSSION→PositionInput；主持 checkpoint→CheckpointVerdict；SYNTHESIS→SynthesisDraft；RATIFY→RatifyResponse。kind 与字段沿提示词 §4.4/主设计 §5.2/6.4，不另起兼容分支；每份正式 schema 必须 additionalProperties 策略明确、版本不可变，并含成功/缺项/越权/旧版本 fixture。

DM 模板 `zs-dm-v0.1.0`：

> 你正在项目 {{projectName}} 的一对一对话 {{conversationId}} 中回应当前用户消息。工作目录 {{cwd}}。仅使用该对话获准历史、当前附件与显式授权资料，不读取或引用其他对话记录。不要 @ 或派发其他成员。按 effectivePermission 与预算执行；需要确认时用已提供的请求通道。说明真实完成的工作、证据和未完成项。自然结束本轮，不轮询等待下一条消息。输出遵循注入的 outputContract。

提醒模板 `zs-reminder-v0.1.0`：

> 这是提醒 {{reminderId}} 的一次触发 {{occurrenceId}}，原定时间 {{scheduledAt}}（{{timezone}}），恢复合并了 {{missedCount}} 次错过计划。来源 {{sourceRef}}，只回应当前授权会话。目标 {{objective}}。只能使用 scope 内资料与 ownerMemberId，遵守本次预算、权限、停止代次；结果表明本次检查的事实。状态未变且无可行动项时不生成通知。不要自行循环或建立未授权的其他提醒。

跟进事实输入：`followersRevision`、`runRosterRevision`、`removedMemberIds`、`absenceFacts[{memberId,reason,effectiveAt}]`、`allowedMentionMemberIds`。只描述已发生状态，模型无权修改名单或判断屏障通过。DM reminder 仅唤醒本会话对端，不能扩大 audience。

REM occurrence 唯一键 `(reminderId,scheduledAt)`；休眠错过多次仅合并为一个待确认/获准触发（沿当前提醒策略），不逐次补跑。停止/归档使触发 paused，恢复不自动启动；触发时重查授权和预算。提醒参数：ownerMemberId、conversationId、taskId?、sourceRef、timezone、schedule、nextAt、status、revision、budgetLimit；scheduledAt 用 UTC，时区用于计算下一次，不依赖模型计算。

隔离验收分层：PP-05 证明应用不注入其他任务/私信；PP-06 的 OS/工具强制读取隔离属于 DEV-20，不作为首版虚假承诺。固定 runtime 版本后分别验证新会话、续接、session reset、崩溃恢复的模板 hash/目标/有效权限；认证完成前对应模式保持 unverified。

## 8. R11：局域网配对与浏览器连接

以下 TTL/限速为实施默认，可由后续实测调整并回写，不改变“配对设备具本机同等权限”的产品决定。首版局域网只在用户启用时监听配置地址，HTTPS/WSS 强制；正常同源客户端的 Host/Origin 精确白名单来自本机配置，不信任请求 Host 自动扩名单。

1. 本机生成 pairingId 与默认随机 8 位码（CSPRNG）；用户可自设 8—64 位，拒绝近期重复码；只保存加盐摘要，5 分钟有效、一次消费。每源地址每分钟 5 次，全局每分钟 30 次；同 pairingId 连续 5 次失败即失效，返回 429/Retry-After，不泄露正确前缀。创建配对码仅本机可信 UI 可做。
2. 用户先在本机查看地址与证书 SHA-256 指纹，在设备上核对并完成系统/浏览器信任；TLS 信任失败即停止，不降级 HTTP、不由程序关闭证书检查。证书更换必须重新核对信任，浏览器无法读取指纹时引导使用证书查看器。桌面/移动浏览器组合必须在 DEV-25 实测，不能把“自签证书提示”当所有平台必然可用。
3. `POST /pair` 提交 pairingId/code/deviceName/clientNonce；原子消费配对码并返回 deviceId 和一次性显示的高熵 deviceCredential。仅该凭据可换短期会话，不接受用户名自报。配对接口核对 Origin/Host、JSON content type 与大小限制，唯一免已有 token 的入口。
4. `POST /session` 用 Authorization 中 deviceCredential 换 15 分钟 accessToken。deviceCredential 客户端存同源 IndexedDB（桌面用 OS 凭据存储），服务端只存摘要；accessToken 仅内存。明确 XSS 可读取浏览器凭据，因此禁第三方脚本、严格 CSP，不把浏览器存储描述为保险箱。会话轮换不撤销 deviceCredential；吊销设备撤销凭据、所有 token、WS ticket 与活跃连接。长期设备授权不自动过期，短期 token 续换不要求重新配对。
5. HTTP 业务请求使用 Authorization header，不能只用 cookie。浏览器 WebSocket 无通用自定义请求头参数，因此先用 HTTPS + Authorization 调用 `POST /ws-ticket` 取 30 秒、单次票据（绑定 device/session/origin/授权版本）。建立 `wss://<host>/events` 后 5 秒内首帧 `{type:'authenticate',ticket}`；认证成功前不发业务事件、不收业务命令，仅允许该小帧。ticket 不放 URL/cookie/日志，消费必须原子。握手先核对 Host/Origin，未认证连接限制每地址 2 个、全局 32 个，超时关闭。
6. WS 只传事件和订阅控制，写操作仍走有 Authorization 的 HTTP；每次订阅及每批事件重查 audience。设备吊销立即关闭 WS；token 到期关闭并重连换票，不让长连接绕过过期。重连带 lastSeq，过期游标走同范围快照；重复事件按 eventId 去重。

LAN-01—08：错误/重复/过期码；限速；证书不信任；Origin/Host 伪造；无/过期/重放票据；吊销后 HTTP+WS 同时拒绝；断连续传与私信过滤；凭据/token 脱敏。并入 RT-21，未通过不得开放 LAN。

依据：[MDN WebSocket 构造器](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket) 的 URL/protocols 参数约束；MCP 入口另遵循[官方授权规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/draft/basic/authorization/index.mdx)的资源/受众绑定与凭据边界。浏览器 WS 票据是众说自有传输设计，不是 MCP 协议新增要求。

## 9. 验证闸门与包完成标准

| 闸门 | 承载 | 通过证据 |
|---|---|---|
| G0 契约 | DEV-01 | schema、路由、目标/主体/范围负例；无模型调用；R4/MCP-BASE 基础断言 |
| G1 存储和进程 | DEV-02—05/17 | 数据重启保留、事务回执、outbox 去重、旧进程确认、跨任务事件不串线 |
| G2 原生权限 B6 | DEV-06/10 | runtime+adapter+OS 版本、实际命令/脱敏事件、文件前后 hash；直接编辑/shell 写、确认允许/拒绝、续接规则、故障不降级；Codex 走 App Server |
| G3 M0 真实闭环 | DEV-07/17/21-M0 | 真实目录→指定成员→读真实 fixture→正确串流→停止进程→重启保留记录；会话不串、失败可解释 |
| G4 协作 | DEV-08—11/21 | FOLLOW/LATE/E11 正反例，M1 用 3—5 个真实任务对比单成员，保留合理分歧 |
| G5 发布 | DEV-16 | M3 全包及 DEV-18—25；AT/RT/TH/PP/WPV 与分批表首版子集逐条通过，不能只看旧 DEV-10—15 |

B6、固定 runtime 注入恢复、Electron/SQLite ABI 和真实 G3 目前仍未实现/未认证；本轮不调用付费模型、不修改全局 CLI 或假造通过。DEV-02 锁 Node/SQLite 版本并跑事务/重启 fixture；DEV-05 锁 Electron，按 SQLite 实际运行进程选择 Node ABI 或 Electron rebuild，至少跑全新依赖安装、建库/读写/退出重启。由独立 daemon 持有 SQLite 时不得错误要求 renderer 加载 native module。安装包 gate 在 DEV-15，不能推迟首次 native 模块验证。

每包报告必须列：基线 SHA 与工作树摘要、修改文件、实现范围、未实现项、命令/退出码/测试数、证据路径、失败原因。原型视觉/mock 回归不能勾 G1/G2/G3；文档完成不勾 runtime 支持。C8 分批总表见 `development-delivery-matrix-v1.23.md`。
