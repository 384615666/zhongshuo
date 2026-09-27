# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

- 更新：2026-09-27（DEV-04 完成时点）
- 分支：`codex/full-implementation`；检查点：DEV-01 `8e88799` → DEV-02 `0feb053`（已推送）→ DEV-03 `30e5424`、DEV-04（**本地已提交，GitHub TLS 间歇失败未推送——续工先 `git push`**）

## 刚完成

- **DEV-03 完成**：§9.3/§9.4 运行时契约 + fake adapter 六类 fixture（167/167 时点）。
- **DEV-04 完成**：目录身份（junction/大小写/realpath）、项目去重/重定位、写入租约（single_writer/parallel_writers/RT-07 过期阻塞）、基线清单（§6.3 排除+hash+Git HEAD）；`pnpm check` 183/183。

## 当前故障 / 待停止进程

- 无遗留进程。待办：推送 DEV-03/DEV-04 两个本地提交（TLS 间歇失败，重试即可）。

## 下一步（直接开工，无需再确认）

1. **DEV-05（daemon 与 supervisor）**——依赖全齐：单实例锁（用户级命名管道/锁文件）、outbox worker（claimNextOutbox → fake adapter 派发 → 事件落库 → 预算结算 → completeOutbox；RT-02/05 全链路）、停止代次持久化与停止流程（task.stop 接 evaluateStopTarget + adapter.interrupt + 租约释放）、恢复读取（§16.4：读非终态 run/turn/lease，进程身份核对接口，不自动补跑）。这是 G1 的最后核心件（连同 DEV-17）。
2. 之后 DEV-17 最小隔离 + DEV-21-M0 最小合同 → DEV-06（Codex App Server 真实接入，专用 fixture）→ DEV-07/G3。
3. 每包结束更新总账四件套 + 本文件。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 前必须具备 DEV-17 最小隔离与 DEV-21-M0 正式合同。
