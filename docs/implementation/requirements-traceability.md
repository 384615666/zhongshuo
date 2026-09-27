# 需求追踪表（137 项 + 首版额外设计项 → 代码 → 验收）

> 批次/包归属以 [分批表 v1.23](../development-delivery-matrix-v1.23.md) 为权威，本表登记**实施状态**。
> 代码列为空 = 未开工；`部分（契约）` = 仅 DEV-01 契约/纯逻辑落地，持久化/UI/执行待后续包。

## 状态图例

- NOT_STARTED：未开工
- IN_PROGRESS：部分落地（见备注列的具体范围）
- IMPLEMENTED / VERIFIED：见对应包报告

## 逐项状态（2026-09-27，DEV-01 完成后）

### START（9 项）

| ID | 首版包 | 状态 | 代码/备注 |
|---|---|---|---|
| START-01 | M0/DEV-04/07 | NOT_STARTED | |
| START-02 | M3/DEV-14 | NOT_STARTED | |
| START-03 | M0/DEV-01/07/17 | **IN_PROGRESS** | 契约+路由纯函数已落（`src/contracts/routing.ts`、`src/domain/routing/`）；真实闭环待 DEV-07/17 |
| START-04 | M0/DEV-04/06/07 | NOT_STARTED | |
| START-05 | FULL-05 | NOT_STARTED | |
| START-06 | M3/DEV-25 | NOT_STARTED | |
| START-07 | M3/DEV-14/15 | NOT_STARTED | |
| START-08 | M3/DEV-23 | NOT_STARTED | |
| START-09 | M3/DEV-14/15 | NOT_STARTED | |

### SPACE（8 项）

SPACE-01..08 全部 NOT_STARTED（SPACE-01/02/03 属 M0/DEV-04/07/18/19；SPACE-04/05 属 FULL-05；SPACE-06 属 M3/DEV-04/14；SPACE-07 属 FULL-10（商业参数 BLOCKED）；SPACE-08 属 M3/DEV-14）。
注：多项目导航的契约层（activeProjectId/visibleProjectIds/scope、NavigationPreferences schema）已随 DEV-01 落地（`src/contracts/project.ts`）。

### MEM（7 项）

MEM-01..07 全部 NOT_STARTED（MEM-01/07 属 M3/DEV-14/18；MEM-02..06 属 FULL-05/10）。

### HOST（9 项）

HOST-01/04/05/09 NOT_STARTED（FULL-05）；HOST-02/06/07/08 NOT_STARTED（M3/DEV-13/14/15）；HOST-03 NOT_STARTED（M0/DEV-05/06/17）。

### AGENT（9 项）

AGENT-01 NOT_STARTED（M0/DEV-04/06/07）；AGENT-02 NOT_STARTED；AGENT-03/04 NOT_STARTED（FULL-04）；AGENT-05/06 NOT_STARTED（M0→M2/DEV-06/10）；AGENT-07/09 NOT_STARTED（M0/DEV-04/17/21）；AGENT-08 NOT_STARTED（M3/DEV-19/24）。
注：成员/Profile/RuntimeInstallation 契约类型已随 DEV-01 落地（`src/contracts/project.ts`）。

### LIFE（5 项）/ REM（3 项）/ DIAG（2 项）

全部 NOT_STARTED（LIFE-01/03 属 M0/DEV-05/06/17；其余 M3/FULL-04）。

### EXT（5 项）

全部 NOT_STARTED（FULL-06）。

### CH（7 项）

CH-02 NOT_STARTED（M0/DEV-04/07）；CH-01/03 NOT_STARTED（M3/DEV-14/17）；CH-06 NOT_STARTED（M3/DEV-18/19）；CH-07 NOT_STARTED（M3/DEV-04/14）；CH-04/05 NOT_STARTED（FULL-01）。
注：Room（含 coordinator_member_id/archived）契约已随 DEV-01 落地。

### MSG（6 项）

| ID | 首版包 | 状态 | 代码/备注 |
|---|---|---|---|
| MSG-01 | M0/DEV-01/07/17 | **IN_PROGRESS** | 输入意图（default/record_only）、MessageTarget 判别联合、正文不路由（AT-09）已落并有测试 |
| MSG-02 | M0→M1/DEV-01/08/21 | **IN_PROGRESS** | 结构化 mention、串内跟进分类（steering/定向/扩大范围提案）已落；跟进名单执行（FOLLOW/E11）待 DEV-08/09/23 |
| MSG-03 | M3/DEV-18 | NOT_STARTED | |
| MSG-04 | M3/DEV-18/24 | NOT_STARTED | |
| MSG-05 | M3/DEV-19/24 | NOT_STARTED | |
| MSG-06 | M0/DEV-01/07/17 | **IN_PROGRESS** | 消息契约 + anchor/串内约束 + via_connection_id 代发约束已落（`src/contracts/message.ts`、`src/domain/routing/messageBinding.ts`） |

### THR（3 项）

| ID | 首版包 | 状态 | 代码/备注 |
|---|---|---|---|
| THR-01 | M0/DEV-01/07/17 | **IN_PROGRESS** | 线程契约 + resolveReplyTarget（新线程预分配/沿用/不匹配拒绝）已落 |
| THR-02 | M0/DEV-01/07/17 | **IN_PROGRESS** | 同上；TH-01/02 的持久化与 UI 验证待 DEV-02/07 |
| THR-03 | M3/DEV-18/19 | NOT_STARTED | |

### DM（2 项）

| ID | 首版包 | 状态 | 代码/备注 |
|---|---|---|---|
| DM-01 | M3/DEV-22/21 | **IN_PROGRESS（契约）** | 私信 1 对 1 路由、dm_turn 契约、会话命令、DM 空值约束已落（`resolveDmRoute` 等）；实际执行/持久化待 DEV-22 |
| DM-02 | M3/DEV-22/21 | **IN_PROGRESS（契约）** | 同上 |

### JOINT（3 项）/ ATTN（6 项）/ TASK（6 项）/ FILE（4 项）/ COMMENT（3 项）

- JOINT-01..03：NOT_STARTED（FULL-09）。
- ATTN-01..06：NOT_STARTED（M3/DEV-18/19/23）。
- TASK-01..06：NOT_STARTED（TASK-01/06 属 M0→M2/DEV-07/08/09/11；契约层 Task/TaskDelivery/ChangeSet/停止/续跑已随 DEV-01 落地）。
- FILE-01..04、COMMENT-01..03：NOT_STARTED（M3/DEV-19/24）。

### APP（10 项）/ DEVAPP（3 项）/ AUTH（8 项）/ MANIFEST（4 项）/ EVENT（4 项）/ NOTIFY（3 项）/ CLI（7 项）/ UI（1 项）

全部 NOT_STARTED（FULL-07/08/01）。

## 首版额外设计项（分批表末节）

| 项 | 承载包 | 状态 | 备注 |
|---|---|---|---|
| Git 客户端 | DEV-12/14（RT-24） | NOT_STARTED | ChangeSet 契约已落（applicationStatus 与验收分离） |
| 可选任务验收 | DEV-14（RT-25） | **IN_PROGRESS（契约）** | Task.reviewPolicy/TaskDelivery.reviewStatus/not_required 不伪造人工通过——schema 级 refine 已落并有测试 |
| 共享预览 | DEV-24（WPV-01—36） | NOT_STARTED | |
| MCP 预留（§31.1 五条） | DEV-01/02/05（MCP-BASE） | **IN_PROGRESS** | 五条预留的契约+纯逻辑已落：CommandEnvelope/CommandResult/CallerContext、via/source_connection_id、validateDispatchScope、command.result.get、发言与执行分离；事务语义待 DEV-02/05，协议本体 FULL-11 |
| 默认单写者与前像 | DEV-04/12/13（RT-07/08/09） | NOT_STARTED | WriteConcurrencyPolicy 契约已落；锁域实现待 DEV-04 |

## 验收编号登记（本包覆盖）

- G0（DEV-01）：schema/路由/目标/主体/范围/预算纯校验——**通过**（127/127，报告见 [reports/dev-01-result.md](reports/dev-01-result.md)）
- AT-09（代码块 @全体 不触发）：通过（`topLevelRoute.test.ts`）
- MCP-BASE 纯逻辑子集（自报身份拒绝/读不派发/同键同参异参/旧停止不伤新 run）：通过；事务与查询部分待 DEV-02/FULL-11
- 其余 AT/RT/TH/DM-BASE/FOLLOW/LATE/E11/LAN/WPV/PP：未执行（随对应包）
