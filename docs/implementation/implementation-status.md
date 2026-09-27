# 众说正式工程 · 施工总账

> 本文件是跨会话施工进度唯一真源之一（与 requirements-traceability / continuation 配套）。
> 状态取值：`NOT_STARTED / IN_PROGRESS / IMPLEMENTED / VERIFIED / BLOCKED / DEFERRED_BY_USER`。
> `IMPLEMENTED ≠ VERIFIED`；`BLOCKED` 必须写具体外部条件；`DEFERRED_BY_USER` 引用用户明确决定。

- 施工分支：`codex/full-implementation`（总任务书 §3.3：各包在同一施工分支形成检查点）
- 依据：[施工总任务书 v1.1](../dev-briefs/full-implementation-brief-glm5.3.md) · [主设计 v1.23](../zhongshuo-development-design-v1.md) · [开工契约 v1.23](../development-baseline-v1.23.md) · [分批表 v1.23](../development-delivery-matrix-v1.23.md)
- 当前阶段：**M0（单成员真实工作闭环）**；DEV-01—05/17/21-M0 已实现（见 reports/）
- 最近更新：2026-09-27（收口轮 2 + DEV-21-M0 完成：`pnpm check` 244/244）

## 工作包状态

| 包 | 交付重点 | 状态 | 代码位置 | 验收 | 证据/备注 |
|---|---|---|---|---|---|
| DEV-01 | 类型/schema、目标判别、路由、来源/权限/预算合同、MCP 预留 | **VERIFIED**（G0 范围） | `src/contracts/` `src/domain/` | G0 | [reports/dev-01-result.md](reports/dev-01-result.md) |
| DEV-02 | SQLite migration/事务、组合约束、回执、outbox、重启读取 | **VERIFIED**（存储侧） | `src/persistence/` | G1（存储侧子集） | [reports/dev-02-result.md](reports/dev-02-result.md) |
| DEV-03 | 可脚本化 fake adapter（六类 fixture） | **VERIFIED** | `src/adapter/fake/` + `src/contracts/runtime.ts` | — | [reports/dev-03-result.md](reports/dev-03-result.md) |
| DEV-04 | 目录打开/去重/重定位、物理锁域、基线清单 | **VERIFIED**（修复轮后） | `src/daemon/` | RT-07/09（存储侧） | [reports/dev-04-result.md](reports/dev-04-result.md)+勘误：RT-07 真过期阻塞已修复（原用例假阳性）；parallel_writers 入口已禁用（ADR-I19） |
| DEV-05 | daemon 单实例锁、派发 worker、停止代次、恢复基础、命名管道 IPC | **VERIFIED**（修复轮后） | `src/daemon/` | G1 核心 | [reports/dev-05-result.md](reports/dev-05-result.md)+勘误：独立截止计时/会话竞态复查/派发门禁/重领对账/模式门禁/验收策略/锁原子化/IPC 全部补齐；**真实进程边界随 DEV-06 验证，不提前声称** |
| DEV-17 | 线程关联与隔离（目标绑定、会话隔离、事件归属、上下文过滤接入派发路径） | **VERIFIED**（任务级；阶段级随 DEV-08/09） | `src/domain/isolation/` + worker 接线 | G1/G3 前置 | [reports/dev-17-result.md](reports/dev-17-result.md)+勘误：过滤白名单强化（指令/摘要/文件均验归属）、ContextBundle 已在派发路径组装落库、同成员双任务隔离用例 |
| DEV-06 | 真实 runtime（优先 Codex App Server）、能力/权限检测 | NOT_STARTED | `src/adapter/` | G2/B6/RT-23 | 依赖 DEV-03/05/17 ✅ + DEV-21-M0 合同先行 |
| DEV-07 | 正式 UI 最小接入（保留原型交互，去 mock） | NOT_STARTED | `src/ui/` | G3 | 依赖 DEV-04/05/06 |
| DEV-08 | 独立分析与互评（冻结名单、阶段过滤、报告校验） | NOT_STARTED | `src/domain/` | G4 | M1 |
| DEV-09 | 分歧与整合（争议、轮次预算、确认矩阵） | NOT_STARTED | `src/domain/` | G4 | M1 |
| DEV-10 | 第二 runtime（Claude Code）、跨 runtime 互评 | NOT_STARTED | `src/adapter/` | G2/G4 | M2 |
| DEV-11 | 自动分工（计划校验、子任务 DAG、交接、有限返工） | NOT_STARTED | `src/domain/` | G4 | M2 |
| DEV-12 | 修改与 diff（单写者、前后基线、审查版本、非破坏撤销） | NOT_STARTED | `src/daemon/` | RT-07/08/10 | M2 |
| DEV-13 | 恢复与故障测试（不确定窗口、进程核对、成果一致性） | NOT_STARTED | `src/daemon/` | G1/RT | M3；RT-03 重领对账的存储侧已在修复轮落地 |
| DEV-14 | 三模式完整 UI、任务/成果/确认/诊断、设置、教程帮助 | NOT_STARTED | `src/ui/` | G5 | M3 |
| DEV-15 | Windows 安装/卸载/托盘/升级迁移 | NOT_STARTED | 打包配置 | G5 | M3；native 依赖首次引入即验 ABI |
| DEV-16 | 发布验收（集成、兼容矩阵、性能、G5 结论） | NOT_STARTED | — | G5 | 依赖 DEV-10—15、17—19、21—25 与适用 G0—G4 |
| DEV-18 | 未读与导航（水位、关注、搜索、收藏、深链、待我处理） | NOT_STARTED | `src/ui/` | RT-26/TH | M3 |
| DEV-19 | 房间协作视图（看板、Files 集合、附件、搜索） | NOT_STARTED | `src/ui/` | TH/WPV | M3 |
| DEV-20 | 完整权限加固（ADR-14 后置项） | NOT_STARTED（后续） | — | RT-20 | 首版原生限制不后置（DEV-06/10/14 承担） |
| DEV-21 | 提示词/输出合同（M0 DIRECT → M3 DM/提醒/跟进） | **M0 段 VERIFIED**（fake+存储级；PP-01/12 随 DEV-06） | `src/contracts/prompts.ts` + `src/daemon/turnInput.ts` | PP-02/03/04/05 子集 | [reports/dev-21-m0-and-closure2-result.md](reports/dev-21-m0-and-closure2-result.md)：standing v0.1.1/turn v0.1.2/TaskComplete v1；根消息+历史正文真实注入；hash 一致；组装失败不派发 |
| DEV-22 | DM 持久化与实际执行（串行、暂停、权限、附件） | NOT_STARTED | `src/daemon/` | DM-BASE-01—08 | M3；契约已在 DEV-01 落 |
| DEV-23 | 提醒（一次/循环、occurrence 唯一、错过合并、通知） | NOT_STARTED | `src/daemon/` | REM/FOLLOW | M3 |
| DEV-24 | 七类附件、评论、导出、共享预览 | NOT_STARTED | `src/ui/`+服务 | WPV-01—36 | M3 |
| DEV-25 | 本机/LAN 浏览器、配对/吊销、HTTPS/WSS | NOT_STARTED | `src/daemon/` | RT-21/LAN-01—08 | M3 |

## 收口轮 2（2026-09-27，GPT 复核意见后）

单实例锁（创建中窗口不接管/二次读取/读回核对+受控窗口反例）、恢复门禁覆盖已提交未领取分支（RT-02 改门禁化）、interrupt 挂起宽限仍生效（限时发送+定时器清理）。详见 [reports/dev-21-m0-and-closure2-result.md](reports/dev-21-m0-and-closure2-result.md)。

## M0 核心修复轮（2026-09-27，外部只读审查后）

外部审查发现 8 项缺陷 + 2 项记录错误，全部修复（`tests/integration/m0Fixes.test.ts` 等新增反例；`pnpm check` 222/222）：

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 过期租约被绕过（acquire 只查 active）+ RT-07 测试假阳性（未真正过期） | acquire 检查全部未释放租约（active+expired）；测试先断言 expired 再验阻塞 |
| 2 | worker 超时依赖新事件到达（沉默 runtime 永不超时） | 独立截止计时 + 中断宽限；沉默→中断 CANCELLED、中断无响应→UNKNOWN 两用例 |
| 3 | 会话打开期间停止失效、之后仍启动 | openSession 后复查停止代次/终态→不 startTurn、取消收尾+审计；竞态用例（openSessionDelayMs 400ms 窗口内停止） |
| 4 | 恢复无执行约束（pending 会被直接领取）+ 重领与既有 turn 唯一键冲突 | 迁移 003 daemon_state + 派发门禁（applyRecovery 落 held、openDispatchGate 用户确认放行、worker 检查）；dispatch_key 已有 turn→failOutbox+reconcileRequired 审计（RT-03 语义） |
| 5 | 单实例锁 check-then-write 非原子 | O_EXCL 独占创建 + 陈旧锁原子 rename 接管；真实双进程竞态用例（恰好一个赢家） |
| 6 | 上下文过滤不足（directive/summary/file 无归属校验）+未接入派发路径 | 白名单化（allowedDirectives/Summaries/BaselineIds）+ 3 反例；worker 组装 ContextBundle（过滤+落库+真实输入文本）；同成员双任务 bundle 隔离用例 |
| 7 | replyAdded 事件 ID 与库内消息 ID 不一致 | 事件 payload 用实际 rowId；断言按事件可查到消息 |
| 8 | worker 不拒绝 AUTO/DELIBERATE、完成不按验收策略收尾 | 模式门禁（非 DIRECT→BLOCKED+审计）；user_review→REVIEW+pending 交付、auto_deliver→DONE+not_required |
| 记A | 总账 DEV-04/05/17 双记录、"下一步"指向已完成的 DEV-04 | 本文件整体重写 |
| 记B | parallel_writers 可经调用参数开启（违反延期基线） | 入口一律拒绝（ADR-I19），放行测试改为拒绝测试 |

修复过程中额外发现并修复 2 个新缺陷：worker 事件竞速丢弃 pending 的 iterator.next() 会吞事件（async iterator 禁止并发 next）；IPC 同 socket 并发处理导致响应乱序（改行 FIFO 串行）。

## FULL 阶段（v0.1 后）

| 包 | 完整交付目标 | 状态 | 阻塞/前置 |
|---|---|---|---|
| FULL-01 | 完整导航、频道设置/角色、成员资料、Activity/Saved/Search | NOT_STARTED | 多人身份子项接 FULL-05 |
| FULL-02 | 全部任务入口、认领/审阅、完整看板、DM 与附件 | NOT_STARTED | 私信仍一对一 |
| FULL-03 | 多格式预览、五类锚点评论、消息图片导出 | NOT_STARTED | 每类格式独立验收 |
| FULL-04 | 完整 runtime 目录/配置、Agent 详情、生命周期、诊断 | NOT_STARTED | 每个 runtime 单独认证 |
| FULL-05 | 账号/邀请、多人、多机、浏览器/PWA/移动 | NOT_STARTED | 先补 ADR-10 身份/部署/同步方案 |
| FULL-06 | 外部 Agent、设备授权、桥接与框架接入 | NOT_STARTED | 凭据与范围可验证 |
| FULL-07 | Connected Apps、OAuth/OIDC、市场、manifest | NOT_STARTED | 先稳定 installation/grant 合同 |
| FULL-08 | Agent Events、App Notifications、Service CLI | NOT_STARTED | 依 FULL-07 |
| FULL-09 | 联邦频道与跨空间同步 | NOT_STARTED | 依 FULL-05；先定联邦权限与撤权 |
| FULL-10 | 套餐权益/计费入口、账号数据、完整帮助 | NOT_STARTED | **BLOCKED（商业参数）**：真实商户/价格/收款账户需用户提供；配置模型、权益判断、数据请求、测试支付适配可先行 |
| FULL-11 | MCP 本体（12 工具、连接授权、审计） | NOT_STARTED | 依 M3 命令面 + DEV-25/RT-21；§31.1 五条预留条款已由 DEV-01 落地 |
| DEV-20 | 完整权限加固 | NOT_STARTED | 后续实施，按 runtime/平台逐项验证 |

## 明确延期项（授权范围外，不得擅自恢复）

- 多 Agent 并行写入增强（write_intent、写范围校验、跨任务变更请求、整合闸门）、按任务 worktree（主设计 §14.7，2026-09-26 延期）。当前仅 `single_writer`；`parallel_writers` 在租约入口被拒绝（ADR-I19），契约类型保留待后续批准。

## 阻塞登记

| 事项 | 影响范围 | 状态 |
|---|---|---|
| FULL-10 商业参数（定价/商户/法务）未提供 | FULL-10 生产集成 | 已登记；无依赖部分可先行，不阻塞其他包 |
| 无其他阻塞 | — | — |

## 下一步（按依赖）

1. **DEV-06**（真实 runtime，Codex App Server 专用 fixture 适配认证）：防线与输入合同已就绪（隔离/门禁/停止/恢复/预算/DEV-21-M0 信封）；先 probe 版本/能力，再 initialize→thread.start→turn.start 真实路径；B6/RT-23 档位认证未过前 UI 档位禁用；PP-01/PP-12 注入验证随本包联合完成。
2. **DEV-07**（Electron main/preload + 命名管道 IPC 接线 + hifi-prototype 交互复用接真实命令面）→ G3 演示。
