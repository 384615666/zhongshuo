# Runtime 能力矩阵

> 逐 runtime/adapter/平台/版本登记真实验证状态（§9.3/§19）。`unverified` 不得按 supported 处理。
> 本文件只登记**实机验证证据**；契约层定义（RuntimeCapabilities/TierVerification schema）已在 DEV-01 落地（`src/contracts/project.ts`、`src/contracts/permission.ts`）。

## 当前状态（2026-09-27）

| Runtime | 接入方式 | 版本 | 能力验证 | 权限档位验证 | 状态 | 承载包 |
|---|---|---|---|---|---|---|
| Codex（App Server） | stdio 换行 JSON-RPC（adapter 已实现） | **0.157.1**（2026-09-27 实测；协议类型 generate-ts 固化） | 协议链路 VERIFIED（initialize/thread/turn/通知映射真实进程通过）；**模型行为 BLOCKED**（额度限制，12:29 重置后重跑 pnpm test:e2e） | 计划档 read-only：待重跑（磁盘无写入已确认，但失败原因需排除额度冒充） | IN_PROGRESS | DEV-06 |
| Claude Code（headless） | 计划 `-p` stream-json | 未锁定（设计核对时 2.1.278） | 无 | 无 | NOT_STARTED | DEV-10 |
| fake adapter | 进程内脚本化 | — | — | — | NOT_STARTED | DEV-03 |

## 历史实测存档（不作为当前验证通过）

- 2026-09-17 人工实测（`docs/runtime-verification-2026-09-17.md`）：Codex App Server initialize/thread 事件、codex exec --json 事件映射、Claude --session-id/--resume、双会话暗号隔离——属设计前勘测，非工程认证；Windows spawn .cmd EINVAL、stdin EOF 挂起、--skip-git-repo-check、GBK 解码等坑已记入 §9.5，DEV-06 适配时必须复验。
- 2026-09-20 注入协议核对（`docs/runtime-injection-review-2026-09-20.md`）：developerInstructions/expectedTurnId 存在于当时 schema；B6/RT-23 行为验证未完成，档位保持 unverified。

## B6/RT-23 认证记录

（空——由 DEV-06/10 逐 runtime/adapter/平台/模式填入：计划档写限制、确认前无变更/允许后继续/拒绝后无变更、续接不放宽、故障不回退。）

## native 模块记录

| 模块 | 版本 | 运行环境 | 验证 | 日期 |
|---|---|---|---|---|
| better-sqlite3 | 13.0.3（prebuilds，SQLite 3.53.4） | Node 24.16.0（daemon 进程；renderer 不加载 native） | 真实执行 SQL 通过（`pnpm check` 151/151 含 24 集成用例）；Electron 场景 DEV-05/15 复验 | 2026-09-27 |
