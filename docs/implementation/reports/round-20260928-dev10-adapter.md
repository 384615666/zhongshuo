# DEV-10 Claude 适配器实装 + 协议回放 + 跨 runtime 绑定（2026-09-28 晚，零额度）

> 默认 353/353（+9）；lint 0。**未标"Claude 真实认证通过"**（全部为本地模拟进程回放）。

## 1. 新增 Claude adapter 代码与已实现能力（src/adapter/claude/cliAdapter.ts）

进程模型（区别于 Codex 常驻 App Server）：每 turn 一次 `claude -p --output-format stream-json`
进程；会话=产品侧记账 + `--resume <providerSessionId>` 续接（result/system init 的
session_id 提取，原地更新调用方持有的 SessionRef）。

已实现：
- 可执行入口解析（默认 PATH `claude`，可注入 executable/spawnFn）；进程启动/退出处理；
- 会话创建/续接/跨任务隔离（会话 Map + 每会话串行 turn，WORKSPACE_BUSY 保护）；
- 输入注入（-p 文本）、流式输出（NDJSON 行解析，跨 chunk 半行缓冲）、assistant 消息
  （delta/completed）、tool_use 块（started/completed，outcome=unknown——CLI 不回传
  结果状态）、result 终态（is_error→turn.failed 按 subtype 映射上游码；usage→
  usage.updated cumulative）、错误归一化（坏行丢弃；进程退出无 result=如实 failed
  不冒充完成）；
- turn/session/进程关联（所有事件带 sessionId+turnId；eventKey=sha256(turnId|salt)）；
- 停止（kill→close 兜底）、启动中停止（close 杀活动进程+会话删除）、资源回收；
- 模型参数显式映射（必须 --model：缺省时 CAPABILITY_UNSUPPORTED 报错——不修改用户
  全局配置）；权限策略显式映射（--permission-mode plan + --allowedTools 只读集）；
- **合成事件依据注明**：turn.started=首条 assistant 消息到达时合成（CLI 无显式开始
  事件）；init 不外发。"进程启动成功"不冒充模型开始或任务完成。
- 能力三态：supported（structuredEvents/taskContextIsolation/resumeSession/interrupt/
  structuredFinal/restrictWrites/restrictShell/disableDelegation/usageTokens）；
  unsupported（steerActiveTurn——明确拒绝不模拟；usageCost）；unverified
  （interactiveApprovals——headless 只读档未开审批通道，respondApproval 拒绝）。

## 2. 零额度协议回放 + worker/daemon 集成证据

- **tests/integration/claudeCliReplay.test.ts（8 用例）**：正常流（turn.started 合成/
  消息/usage/结构化 finalText/session 绑定）；分块通知（半行跨 chunk+重复行）；认证失败
  （stderr 签名→AUTH_REQUIRED）；非零退出无 result（PROVIDER_ERROR retryable）；坏行
  丢弃+额度失败（error_usage→USAGE）；中断（kill 兜底）+启动中停止资源回收；续接参数
  （第二 turn --resume）；能力拒绝（steer/审批/缺模型）+probe 三态；两任务隔离（两会话
  各自进程/事件流，迟到不终结另一任务——进程模型天然隔离+事件 turnId 归属校验）。
- **tests/integration/claudeWorkerIntegration.test.ts（1 用例）**：共用 DispatchWorker
  × 成员级 adapter 注册表——两成员分别走 Claude CLI 回放与 fake：fake 侧 schema+
  resultKey 全链 DONE；Claude 侧（回放 resultKey 无法预知 turnId）如实 OUTPUT_INVALID
  未完成（不冒充）；runtime_sessions 各自成员、回复各归各线程——**domain/worker 无
  厂商分支**（两 adapter 同一 RuntimeAdapter 接口）。
- **跨 runtime 成员绑定**：MemberRuntimeRegistry（成员→adapter 安装绑定）验证"按成员
  配置选择 adapter"；生产接线点=entry 的 adapterFor(member)（当前 entry 仍全局单
  adapter——**列为 DEV-10 剩余接入工作**：project_members 增 runtime 安装字段+派发
  侧注册表注入）。

## 3. 尚未认证的能力（如实）

- Claude 真实模型调用：0 次（本轮无探活——上一轮 1 次已单列）；
- resumeSession：回放验证，真实 --resume 行为未认证；
- interactiveApprovals：unverified（未开通道）；
- steer：unsupported（进程模型不支持，不模拟）；
- B6 权限证据（restrictWrites/shell 的真实拒绝证据）：未做（需真实认证）。

## 4. 真实认证最小用例（待批准）

| 用例 | 调用数 | 说明 |
|---|---|---|
| probe+版本 | 0（本地） | 已做过（上轮 1 次探活单列） |
| 1 turn 只读分析（TaskComplete 全链） | 1 | 显式 --model（建议 claude-sonnet-4 或用户指定）；真实文件回流断言 |
| 1 次中断（运行中 kill→终态） | 1 | interrupt 真实行为 |
| **合计** | **2** | 需用户确认：模型名 + 预算批准 |

## 5. 修正后的价值对比预算清单（m1-value-gate-proposal.md v3）

- 每组 DIRECT：正常 1+修复 1=上限 2；每组 DELIBERATE：正常 7+全组共享修复余量 2=
  上限 9（尾部预留含在总额内不重复加算）；三组全跑：**总新增上限 3×2+3×9=33**。
- A 组旧研讨运行=历史参考，**无"确认后视为同题"选项**（实验条件差异不可主观消除）。
- 批准前不执行、不追加探活（探活=真实调用，计入预算非零额度检查）。

## 6. dispatchWait / E4 实际实现状态

- **dispatchWait（本轮修正）**：未开始成员独立 dispatchWaitDeadline，超出按
  **unavailable** 规则处理（合同一致）：屏障视同终结不再无限等待；与 absent 区分
  （原因=排队调度资源，后续阶段可恢复参与）；后续轮 RAT 派发排除 unavailable；
  资源恢复/重试不重复派发旧步骤（旧键已被屏障消费）。假时钟用例更新：排队不记
  **执行**缺席（absenceGrace 零事件）+超排队截止→unavailable。
- **E4 在途缺席推进（如实未完成的生产行为）**：串行 drain 架构下，泵只能在 turn 之间
  运行——"在途成员达宽限→推进屏障不杀成员"的机制与假时钟测试已验证（deliberationE4 ①），
  但**生产串行调度中该路径不会被自然触发**（worker 阻塞在 consumeUntilTerminal）。
  承载工作（已排 M2 前置）：调度循环改为"泵与 turn 消费解耦"（turn 消费异步化/
  独立协程），不开启无约束并发——缺席推进、事件接收、执行并发限制分别实现。

## 7. 遗留

- entry 成员级 adapterFor 接入（project_members.runtime 安装字段+注册表）；
- Claude 真实认证 2 调用待批；价值对比 33 上限待批；
- E4 在途推进的生产承载（M2 前置调度解耦）。
