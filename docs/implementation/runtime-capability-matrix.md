# Runtime 能力矩阵

> 逐 runtime/adapter/平台/版本登记真实验证状态（§9.3/§19）。`unverified` 不得按 supported 处理。
> 本文件只登记**实机验证证据**；契约层定义（RuntimeCapabilities/TierVerification schema）已在 DEV-01 落地（`src/contracts/project.ts`、`src/contracts/permission.ts`）。

## 当前状态（2026-09-27）

| Runtime | 接入方式 | 版本 | 能力验证 | 权限档位验证 | 状态 | 承载包 |
|---|---|---|---|---|---|---|
| Codex（App Server） | stdio 换行 JSON-RPC（adapter v0.2.0+修复轮3） | **0.157.1**（2026-09-27 实测；协议类型 generate-ts 固化） | 已验证：启动/握手/请求/turn 派发/通知映射 + 真实文件内容回流 + 层 A 行为证据 + **resume 跨进程续接（LUNA-RESUME-7 恢复）** + steer 错误 ID 拒绝（model=gpt-6-luna，e2e 7/7）。协议回放覆盖终态各态/迟到/双会话并发/未知归属终态/审批归属/重建 | **计划档两路径 PASS**（B6 证据绑定：指定工具+toolCallId+目标路径+status:declined）；**确认档 deny 路径 PASS**（read-only+on-request→approval.requested→deny→无写入）。确认档 allow/续接不放宽/steer 正常路径未验证 | **部分 VERIFIED**（待补：steer 正常、审批 allow、structuredFinal、usageTokens 口径） | DEV-06 |
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
