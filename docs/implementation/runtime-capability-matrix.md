# Runtime 能力矩阵

> 逐 runtime/adapter/平台/版本登记真实验证状态（§9.3/§19）。`unverified` 不得按 supported 处理。
> 本文件只登记**实机验证证据**；契约层定义（RuntimeCapabilities/TierVerification schema）已在 DEV-01 落地（`src/contracts/project.ts`、`src/contracts/permission.ts`）。

## 当前状态（2026-09-27）

| Runtime | 接入方式 | 版本 | 能力验证 | 权限档位验证 | 状态 | 承载包 |
|---|---|---|---|---|---|---|
| Codex（App Server） | stdio 换行 JSON-RPC（adapter v0.2.0+r3/r4） | **0.157.1**（2026-09-27 实测；协议类型 generate-ts 固化） | **G2 范围 VERIFIED**（累计 12 真实用例）：启动/握手/请求/turn 派发/通知映射/文件内容回流/层 A/resume 跨进程续接+不放宽/steer 正常+服务端拒/interrupt/usageTokens 口径。协议回放覆盖终态各态/迟到/双会话并发/未知归属/审批归属/重建 | 计划档两路径 PASS（declined + failed;sandbox-denial 证据绑定，共享验证器+7 负例）；确认档 **allow+deny 双路径 PASS**（确认前无变更；allow 后仅获准操作） | **G2 VERIFIED（Codex）**；structuredFinal 真实输出与 UI 集成随 G3 | DEV-06 |
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

## 进程树取证能力（DEV-13 恢复链路；第八轮 2026-09-29 全树归属分析修订）

| 能力 | 状态 | 依据与限制 |
|---|---|---|
| 父进程存活/退出+启动时刻（复用检测） | win32 实测 supported；非 win32 部分（无启动时刻） | PowerShell Get-Process+ErrorVariable 分类（仅 ObjectNotFound=exited）；本地真实子进程用例 |
| 全表进程快照+现存树 BFS | **仅 win32 supported**（单次 CIM 全表，行标记协议；空输出/残缺行/CIM 错误=failed，不把查询失败当空结果） | 从登记根沿 PPID 边收集存活后代（覆盖父退子活、存活期间继续派生）；非 win32=未完整确认（保护保留） |
| 历史身份登记（孙进程遗留核对） | supported（win32；迁移 014 **追加式** process_tree_identities） | 旧 012 快照表 DELETE+INSERT 会丢父链已断的后代——新表按进程代次（pid+startedAt_ms，PID 脱离启动时间不构成身份）追加登记、从不删除未确认身份；退出确认由 probe 写回；反例：第一拍三代→父子退→后续观察只见占位→probe 仍发现孙 |
| 完整退出证明 | **不提供（第九轮收紧）**：周期快照只产生「未观察到存活后代」观察——**不构成完整退出证明**（最后快照之后派生且父链已断的深层链不可排除）。probe 对 per-turn/shared 不再返回 exited；释放保护仅凭程序事实（none 模型 no-os-process），有子进程 runtime 的自动解除路径**已关闭** | 三代 fixture：孙结束后仍拒绝解除（未完整确认）；盲区反例（两次观察之间派生+中间父退出）返回未完整确认、不凭空声称能发现 |
| per-turn 进程树（Claude CLI 每 turn 独立） | 本地 node 进程树 fixture 验证（含 worker 生产接线：fake 上报真实子进程身份→快照自动落库） | 父被杀+工具子进程孤儿仍跑→unknown；全树退出→exited |
| shared 进程树（Codex App Server 常驻） | 本地 node 进程树 fixture 验证 | server 存活但 turn 执行状态未知（unknown 保留）；server 死+工具遗留→unknown |
| pre-launch 崩溃窗口识别 | supported（迁移 011 pre-launch 登记） | openSession 后 startTurn 前登记占位（model=unknown/pid=null）——区分「请求可能已发出」与「从未启动」（identity-missing） |
| 能力边界（如实收窄） | **最后快照之后新派生、且其父链在快照之后死去的深层链不可发现**（快照间隔 5s 内风险存在） | 等效完美方案（Job Object/ETW 持续监听）需原生能力，列为后续可选；快照间隔是当前唯一缓解 |
| 真实 CLI（claude/codex）崩溃现场进程树取证 | **未验证（真实样本未跑——零调用纪律）** | 本地 fixture 覆盖机制；真实 CLI 工具子进程行为随真实补证 |

## 迟到成果接收能力（第八轮 2026-09-29）

| 能力 | 状态 | 依据与限制 |
|---|---|---|
| 迟到成果泵（recovery.pumpLateEvents 正式命令） | supported（fake 双路径验证：同 daemon+重启回放） | **回执与业务效果同事务**（迁移 015：作用域键 source_scope+turn+eventKey，eventKey 不假设全局唯一；失败整体回滚可恢复）；归属校验（不认领未归属事件）；守卫=重复终态/停止代次/refunded 冲突/被替代 run；**收口不释放写入租约**（业务结果确定≠执行载体停止） |
| fake runtime 迟到回放（lateEvents） | supported（会话事件持久化文件，模拟 CLI 会话记录） | 重启后新实例同目录可读——重连/回放的本地演练形态 |
| 真实 CLI 迟到回放（claude/codex lateEvents） | **unsupported（未实现——如实标注，不冒充）** | 会话文件/重连存量流解析待真实补证；泵对未实现 adapter 返回明确 unsupported |
| 研讨轮（delib.*）UNKNOWN 迟到输出收口 | unsupported-mode（本轮范围外） | 研讨轮 UNKNOWN=成员缺席语义（E4）；处理归后续轮次 |
