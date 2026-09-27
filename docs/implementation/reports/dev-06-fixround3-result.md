# 修复轮 3 + DEV-06 收尾认证报告

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `d748ccb`）
- 输入：用户复核三项（协议 turn.id/锁身份窗口/B6 证据绑定）+ 既定认证授权（steer/resume/审批桥）
- 结果：三项收口全落地；默认套件 `pnpm check` **260/260**；真实 e2e **7/7**（gpt-6-luna，本轮真实 turn 共 8 次含排错）

## 三项收口

### 1. turn/completed 的 provider ID 按真实协议读取

- adapter：`turn/started` 与 `turn/completed` 的 provider ID **只从 `turn.id` 读取**（TurnStartedNotification/TurnCompletedNotification 均为 `{ threadId, turn }`，无顶层 turnId）。
- mock：删除了帮助测试通过的伪顶层 turnId；`unattributedTerminal` 反例用真实形状（未知 turn.id）。
- awaiting 按 session 隔离（SessionState.awaitingTurn）：双会话并发 startTurn 互不覆盖（回放反例：两会话同时启动，各自结果/终态归属正确）。
- 未知归属终态不影响当前 turn：终态归属查找改为**响应解析同步点注册**（pending.onResult——响应行与通知同 chunk 到达时，映射先于通知处理，撤销了此前"终态认领 awaiting"的过度认领）；ghost 终态在 adapter 层不带内部 turnId、在 worker 层走 `turn.unattributedTerminal` 审计并继续等待当前轮自己的终结（DispatchWorker×mock 集成用例：任务照常 DONE、审计在案）。

### 2. 目录锁身份写入窗口

- claim mkdir 后、claimer.json 写入前：**身份缺失/半写入 ≠ 持有者已死**——创建宽限（identityGraceMs，默认 2s，按目录 mtime）内不清理、不接管，保守 BUSY；超宽限仍无有效身份才按接管者崩溃清理（rm 竞态由 mkdir claim 原子性兜底）。
- owner 半写入同规则：owner.json 损坏 + 锁目录新鲜 → BUSY；超宽限 → 走 claim 归档（唯一接管者）。
- 受控同步点 `onBeforeClaimIdentity`（身份写入前）：窗口内第二获取 BUSY——**无双持有**；窗口方完成后接管方取得唯一锁。

### 3. B6 证据绑定（收紧）

`assertSandboxRejection(outcome, targetFile, label, expectedTool, targetToken)`：
- 必须存在**指定写入工具**（fileChange=直接编辑 / commandExecution=shell）的 `tool.started` 且 `argumentsSummary` 包含目标文件名；
- 该 toolCallId 必须有配对 `tool.completed`，outcome=`failure` 且 `resultRef` 带权限拒绝原因（`status:declined` 或 `status:failed`）——**unknown/语法错误/任意工具失败/口头拒绝不算**；
- 磁盘无写入 + 额度/认证失败排除。
- adapter 侧配套：fileChange 的 argumentsSummary 取 `changes[].path`；tool.completed 携带 `resultRef: status:<declined|failed>`。
- 真实重跑（2 turn）：B6-1（fileChange→notes.md，内容未变）、B6-2（commandExecution→b6-shell.txt，未创建）通过。

## 既定认证（tests/e2e/realCodexFinish.test.ts，gpt-6-luna）

| 用例 | 结果 | 证据 |
|---|---|---|
| steer 错误 expectedTurnId | ✅ | 未登记 turn 的 steer 被拒（CAPABILITY_UNSUPPORTED；无模型调用） |
| resume 续接（PP-02 局部） | ✅ | 会话关闭（进程退出）→ thread/resume 同一 provider 线程 → **LUNA-RESUME-7 暗号可回忆**（上下文真实恢复） |
| 审批桥 deny（RT-23 确认档局部） | ✅ | read-only + on-request：写文件触发 `approval.requested` → respondApproval(deny) → 文件未创建、turn 正常收尾 |

过程记录：审批桥首两跑未触发——① adapter 硬编码 approvalPolicy:'never'（改为可配置）；② workspace-write 内的写被沙箱自动放行不触发审批（确认档正确语义=read-only+on-request，已修正并记录）；raw 排错 probe 未设 model 走了 config 的 deepseek-flash 渠道 400（与 e2e 无关，e2e 始终显式 gpt-6-luna）。

## 口径

- 默认套件 260/260（fake+SQLite+协议回放，零额度）。
- 真实层累计已验证：C1 文件回流+层 A、RT-23 计划档两路径、steer 拒绝路径、**resume 跨进程续接**、**审批桥 deny 往返**。未验证：steer 正常路径（活跃 turn 追加输入影响输出，1 turn）、审批 allow 路径、structuredFinal/usageTokens 数值口径——随 DEV-07/G3 联合或下一批补。
- 不以测试总数代替范围证据；4/4+3/3 是列明用例的通过，非"完整计划档认证"——确认档仅 deny 路径，allow/续接不放宽待补。
