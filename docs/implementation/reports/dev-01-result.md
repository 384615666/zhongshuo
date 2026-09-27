# DEV-01 完成报告：消息契约与路由

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `afbbdb6`，main）
- 范围：[DEV-01 任务书](../../dev-briefs/dev-01-contracts-and-routing.md)（第四次修订版）+ 总任务书 §5
- 状态：**VERIFIED（G0 范围）** —— 本包为纯契约/纯逻辑层，无模型调用、无 IO、无数据库（按任务书非目标边界）

## 实现范围

### 工程脚手架（范围 0）

- 根 `package.json`（pnpm 单仓单包、ESM、Node ≥24）、`tsconfig.json`（strict+，见 ADR-I10）、`vitest.config.ts`、`eslint.config.mjs`（含 `zhongshuo/six-boundaries` 内联规则，反例验证通过）。
- `src/` 六边界目录齐备：contracts（14 文件）与 domain（11 文件）实装；persistence/adapter/daemon/ui 为带说明骨架。
- `pnpm-lock.yaml` 已提交。`hifi-prototype/` 零改动。

### contracts（范围 1，命名逐项对照 §12.2 与开工契约 §2.2/§3）

| 契约 | 落点 |
|---|---|
| Project/DirectoryIdentity/Room/AgentProfile/ProjectMember/RuntimeInstallation/NavigationPreferences/ProjectQueryScope | `src/contracts/project.ts` |
| Conversation(room/dm)/DmParticipant/ConversationReadState/MessageTarget/DispatchDisposition/conversation create·list·history·markRead·rename·archive·restore | `src/contracts/conversation.ts` |
| ConversationThread（anchor/root_task_id 空=记录串/DM 无 thread）+ThreadSummary | `src/contracts/thread.ts` |
| Message（author_type 四类/via_connection_id 仅 human/anchor⇔线程序号同生灭）+message.submit 契约 | `src/contracts/message.ts` |
| Task（room_task/dm_turn/room_task_number DM 空/review_policy 快照/source_connection_id）+TaskDelivery+ChangeSet+stop/resume/steer | `src/contracts/task.ts` |
| WorkflowRun/AgentTurn/RunParticipant/RuntimeSessionRef（DM scope）+DeliberateStage | `src/contracts/run.ts` |
| Mode 三值/SendIntent 二值（类型层互斥）/MentionNode/三类路由结果 | `src/contracts/routing.ts` |
| CommandEnvelope（strict，拒自报 authorId）/CommandResult/DomainEvent（含 conversationId）/CommandReceipt/command.result.get | `src/contracts/commands.ts` |
| CallerContext（actualPrincipal/entry/四维范围）/USER_ONLY_OPERATIONS/localUiCaller | `src/contracts/caller.ts` |
| BudgetGrant/BudgetState/BudgetReservation | `src/contracts/budget.ts` |
| PermissionTier 四档/TierVerification（runtime/adapter/平台/模式关联）/ApprovalRequest/Response | `src/contracts/permission.ts` |
| 四项查询 DTO（room.list/member.list/task.get/events.list，limit 1..200、不透明游标） | `src/contracts/queries.ts` |

### domain 路由与纯校验（范围 2）

| 函数 | 覆盖规则 | 文件 |
|---|---|---|
| `resolveTopLevelRoute` | §4.2 路由表全部五行 + record_only 零唤醒 + 协调者不可用拒绝 | `src/domain/routing/topLevelRoute.ts` |
| `resolveTopLevelRouteFromMessage` | AT-09：正文不是路由输入（函数形态保证） | 同上 |
| `resolveDmRoute` | §4.6 一对一：agent 对端 dm_turn/human 对端零派发/record_only/归档拒绝/不推导 Mode/无任务号 | `src/domain/routing/dmRoute.ts` |
| `resolveReplyTarget` | 主池新线程（预分配 ID）/串内沿用/DM 无 thread/THREAD·CONVERSATION_SCOPE_MISMATCH/ROOM_ARCHIVED/reply_to 同串校验，绝不兜底主池 | `src/domain/routing/replyTarget.ts` |
| `resolveThreadFollowUp` | steering/定向提问/扩大范围提案（决策 10）/记录串默认保存（含 @全体 零唤醒）/显式 record_only | `src/domain/routing/followUp.ts` |
| `resolveMentionTargets` | 结构化节点解析、去重、未启用成员 INVALID_MENTION | `src/domain/routing/mentions.ts` |
| `validateMessageConversationBinding` | DM 空值约束跨实体校验（ADR-I11） | `src/domain/routing/messageBinding.ts` |
| `validateDispatchScope`/`assertUserOnlyOperation` | 三维分别判断+预算第四维；读不蕴含唤醒；仅用户可做按实际主体 | `src/domain/scope/dispatchScope.ts` |
| `evaluateStopTarget` | stopping/stopped/already_stopped/target_obsolete；旧停止不伤新 run | `src/domain/scope/stopTarget.ts` |
| `deriveTaskSourceConnection` | 本地根任务 null/外部连接记录/派生链继承不清空 | `src/domain/scope/sourceConnection.ts` |
| `canonicalJson`/`computeCommandPayloadHash`/`deriveIdempotencyScope`/`evaluateIdempotency` | 幂等键类型+scope 按连接隔离+同键同参/异参判定 | `src/domain/idempotency.ts` |
| `reserveTurns` 等 | R=M-U-I、双预算同检、结算/归还 | `src/domain/budget.ts` |
| `evaluateApprovalResponse` | 过期/重复/payloadHash 不匹配不得授权 | `src/domain/approval.ts` |

### §31.1 五条预留条款落地对照

1. 命令可结构化调用 → CommandEnvelope/CommandResult + 全部命令参数 schema。
2. 调用者身份可标识 → CallerContext（服务端生成；envelope strict 拒绝自报 authorId，有测试）。
3. 授权范围逐次校验 → validateDispatchScope 三维+预算（MCP-BASE「读不附带派发」用例通过）。
4. 幂等可查询 → commandId 类型/约束、scope 推导、同键判定、command.result.get 契约（事务执行语义交 DEV-02）。
5. 发言与执行分离 → 路由只吃结构化 mention/SendIntent/目标；正文永不进入路由函数（AT-09 用例 + 函数形态）。
6. 字段预留 → Message.via_connection_id（仅 human refine）、Task.source_connection_id + 继承推导，均有测试。

## 验证证据

- 环境：Windows 11 x64（10.0.26100）、Node 24.16.0、pnpm 11.23.0。
- 命令：`pnpm check` = `tsc --noEmit` + `eslint .` + `vitest run`。
- 结果：**typecheck 0 错误；eslint 0 错误（六边界规则含反例验证）；vitest 11 文件 127/127 通过**（2026-09-27 08:49 本机执行）。
- 测试清单（11 文件）：topLevelRoute 15 · dmRoute 8 · replyTarget 13 · followUp 10 · dispatchScope 17 · idempotency 13 · stopTarget 8 · budget 7 · approval 5 · contracts 25 · types 6。
- 关键正反用例：AT-07（DIRECT 其他成员零调用）、AT-09（代码块 @全体 不触发）、record_only 含 @全体 零唤醒、记录串默认保存、私信 human 对端零派发/同成员双会话隔离、THREAD/CONVERSATION_SCOPE_MISMATCH 不兜底主池、读权限拒绝派发、外部连接被拒用户专属操作（含 representedUserId 场景）、同键异参 IDEMPOTENCY_CONFLICT、payloadHash 键序无关、旧停止 target_obsolete、预算耗尽拒派发、approval 过期/payload 不匹配拒绝、dm_turn 带房间字段被 schema 拒绝、not_required 不携带人工验收记录。

## 未实现/明确交接（不是缺陷）

- 事务内去重执行、回执持久化、outbox → **DEV-02**（契约已就绪）。
- fake adapter → DEV-03；目录/锁域/daemon → DEV-04/05。
- ADR-15 任务内互唤的执行语义（E11 允许表）→ 后续 daemon/domain 包（本包只提供分类类型）。
- DELIBERATE 阶段屏障/预算尾部预留公式 → DEV-08/09（BudgetState 已给出基础量）。
- MCP-BASE 中需要数据库/连接的部分（提交后丢响应重试、并发预算预占、游标/撤权/空页）→ DEV-02/FULL-11。
- DM-BASE-01—08 执行语义 → DEV-22；REM/FOLLOW → DEV-23。

## 修改文件

新增：`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`vitest.config.ts`、`eslint.config.mjs`、`src/`（contracts 14 + domain 12 + 4 骨架 README）、`tests/unit/`（11 文件）、`docs/implementation/`（本报告及总账五件套）；修改：`README.md`（正式工程章节）。
未触碰：`hifi-prototype/`、用户既有 docs、archive、未跟踪杂项。
