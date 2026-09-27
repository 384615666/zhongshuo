# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

- 更新：2026-09-27（DEV-05 完成时点）
- 分支：`codex/full-implementation`；检查点：DEV-01 `8e88799` → DEV-02 `0feb053` → DEV-03 `30e5424` → DEV-04 `35df2f3` → DEV-05（见 git log）；均已推送或随本包推送

## 刚完成

- **DEV-05 完成（核心）**：迁移 002（stop_generation+route_json）、派发 worker（outbox→run/turn→adapter→事件落库→预算结算→complete）、停止流程（STOPPING→中断→CANCELLED、代次持久化、幂等重放）、恢复（INTERRUPTED/UNKNOWN、重排不自动补跑）、单实例锁；`pnpm check` 192/192。
- M0 进度：DEV-01/02/03/04/05 ✅ → 剩 **DEV-17 最小隔离 → DEV-21-M0 最小合同 → DEV-06 真实 runtime → DEV-07/G3**。

## 当前故障 / 待停止进程

- 无遗留进程。

## 下一步（直接开工，无需再确认）

1. **DEV-17 最小隔离**（G3 前必备）：thread/conversation/task/run/turn 关联的纯校验补全（agent_turns 会话绑定校验、跨任务上下文过滤的类型级接口——runtime_sessions 复用键已落库）、双任务串线测试（fake adapter 双任务 A/B 交错，回复各归各线程——worker 已天然按 task 派发，补显式用例）、ContextBundle 清单类型骨架（DEV-21-M0 消费）。
2. **DEV-21-M0**：DIRECT 模板最小版（zs-direct-v0.1.0 文本+hash）、TaskComplete 输出 schema、ContextBundle 契约与注入参数拼装纯函数（§13.1 优先级）。
3. **DEV-06**：Codex App Server 真实接入（本机已装 codex；用专用 fixture 目录+独立测试会话；先 probe 版本/能力，B6 档位按 §9.6 认证，未过 RT-23 前档位禁用）。
4. **DEV-07**：Electron main/preload + 命名管道 IPC 传输 + 复用 hifi-prototype 已确认交互接真实命令面。
5. 每包结束更新总账四件套 + 本文件。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 前必须具备 DEV-17 最小隔离与 DEV-21-M0 正式合同。
