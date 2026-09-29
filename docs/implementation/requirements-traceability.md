# 需求追踪表（137 项 + 首版额外设计项 → 代码 → 验收）

> 批次/包归属以 [分批表 v1.23](../development-delivery-matrix-v1.23.md) 为权威，本表登记**实施状态**。
> 代码列为空 = 未开工；`部分（契约）` = 仅 DEV-01 契约/纯逻辑落地，持久化/UI/执行待后续包。

## 状态图例

- NOT_STARTED：未开工
- IN_PROGRESS：部分落地（见备注列的具体范围）
- IMPLEMENTED / VERIFIED：见对应包报告

## 逐项状态（最近核对：2026-09-27 修复轮 6/G3 收口；包级权威状态见 implementation-status.md 工作包表）

### START（9 项）

| ID | 首版包 | 状态 | 代码/备注 |
|---|---|---|---|
| START-01 | M0/DEV-04/07 | NOT_STARTED | |
| START-02 | M3/DEV-14 | NOT_STARTED | |
| START-03 | M0/DEV-01/07/17 | **VERIFIED（G3）** | 契约+路由纯函数 + renderer 用户链路真实闭环（CDP 真点击 11/11 + 真实 codex UI 一轮，reports/round-20260927-fix6-ui-e2e-g3-closeout.md） |
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
| Git 客户端 | DEV-12/14（RT-24） | **IN_PROGRESS（读面+写闭环主体）** | 只读 status/diff（第十轮协议重写：raw/numstat -z 机器身份、字面 pathspec、采集期容量控制、未跟踪内容视图、no-textconv/ext-diff 反例）；写闭环 stage/unstage/stageTask（跳过 userPreExisting）/commitPreview+commit（预览绑定 HEAD/索引摘要、尾标记崩溃恢复）/history（任务关联）；git_operations 日志。剩余=branch/checkout、push/pull（bare remote 验证）、conflict.resolve、commit.undo、单提交聚合 diff（报告 round-20260929-round10） |
| 可选任务验收 | DEV-14（RT-25） | **IN_PROGRESS（全链可用）** | 契约+DB 约束（第八轮）；版本绑定验收+返工注入（第九轮）；项目开关 project.reviewPolicy.set+持久化+仅影响新任务、要求修改必填意见、返工再执行 UI 入口（task.redispatch 按钮）、返工第二轮正常递增交付（第十轮交付守卫修正）；e2e 正式闭环不经补库 |
| 共享预览 | DEV-24（WPV-01—36） | NOT_STARTED | |
| MCP 预留（§31.1 五条） | DEV-01/02/05（MCP-BASE） | **IN_PROGRESS** | DEV-01 契约+纯逻辑；DEV-02 落 command_receipts 事务语义（重放/冲突/隔离/清理过期）；预算事务预占与协议本体待 DEV-05/FULL-11 |
| 默认单写者与前像 | DEV-04/12/13（RT-07/08/09） | **IN_PROGRESS（表结构）** | workspace_leases 表已落（组合主键）；锁域判定与数量策略待 DEV-04（ADR-I14） |

## 验收编号登记（DEV-01 + DEV-02 覆盖）

- G0（DEV-01）：schema/路由/目标/主体/范围/预算纯校验——**通过**（127/127，[reports/dev-01-result.md](reports/dev-01-result.md)）
- G1 存储侧子集（DEV-02）：迁移幂等/回滚/升级备份、RT-01 幂等重放、RT-02 重启保留、RT-05 单次派发、约束反例——**通过**（[reports/dev-02-result.md](reports/dev-02-result.md)）；G1 整体（进程/隔离）待 DEV-03/04/05/17
- AT-09（代码块 @全体 不触发）：通过（`topLevelRoute.test.ts`）
- RT-13（磁盘满）：未模拟（错误映射+回滚已测；物理注入待 DEV-13）
- MCP-BASE 纯逻辑子集（自报身份拒绝/读不派发/同键同参异参/旧停止不伤新 run/提交后丢响应重试的存储语义）：通过；查询游标/撤权/空页待 FULL-11
- 其余 AT/RT/TH/DM-BASE/FOLLOW/LATE/E11/LAN/WPV/PP：未执行（随对应包）
