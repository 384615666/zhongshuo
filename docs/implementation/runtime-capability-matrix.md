# Runtime 能力矩阵

> 逐 runtime/adapter/平台/版本登记真实验证状态（§9.3/§19）。`unverified` 不得按 supported 处理。
> 本文件只登记**实机验证证据**；契约层定义（RuntimeCapabilities/TierVerification schema）已在 DEV-01 落地（`src/contracts/project.ts`、`src/contracts/permission.ts`）。

## 当前状态（2026-09-27）

| Runtime | 接入方式 | 版本 | 能力验证 | 权限档位验证 | 状态 | 承载包 |
|---|---|---|---|---|---|---|
| Codex（App Server） | 计划 stdio JSON-RPC | 未锁定（2026-09-17 实测环境曾见 0.154/0.155，施工时重新检测锁定） | 无 | 无 | NOT_STARTED | DEV-06 |
| Claude Code（headless） | 计划 `-p` stream-json | 未锁定（设计核对时 2.1.278） | 无 | 无 | NOT_STARTED | DEV-10 |
| fake adapter | 进程内脚本化 | — | — | — | NOT_STARTED | DEV-03 |

## 历史实测存档（不作为当前验证通过）

- 2026-09-17 人工实测（`docs/runtime-verification-2026-09-17.md`）：Codex App Server initialize/thread 事件、codex exec --json 事件映射、Claude --session-id/--resume、双会话暗号隔离——属设计前勘测，非工程认证；Windows spawn .cmd EINVAL、stdin EOF 挂起、--skip-git-repo-check、GBK 解码等坑已记入 §9.5，DEV-06 适配时必须复验。
- 2026-09-20 注入协议核对（`docs/runtime-injection-review-2026-09-20.md`）：developerInstructions/expectedTurnId 存在于当时 schema；B6/RT-23 行为验证未完成，档位保持 unverified。

## B6/RT-23 认证记录

（空——由 DEV-06/10 逐 runtime/adapter/平台/模式填入：计划档写限制、确认前无变更/允许后继续/拒绝后无变更、续接不放宽、故障不回退。）
