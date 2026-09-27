# 众说正式工程 · 施工总账

> 本文件是跨会话施工进度唯一真源之一（与 requirements-traceability / continuation 配套）。
> 状态取值：`NOT_STARTED / IN_PROGRESS / IMPLEMENTED / VERIFIED / BLOCKED / DEFERRED_BY_USER`。
> `IMPLEMENTED ≠ VERIFIED`；`BLOCKED` 必须写具体外部条件；`DEFERRED_BY_USER` 引用用户明确决定。

- 施工分支：`codex/full-implementation`（总任务书 §3.3：各包在同一施工分支形成检查点）
- 依据：[施工总任务书 v1.1](../dev-briefs/full-implementation-brief-glm5.3.md) · [主设计 v1.23](../zhongshuo-development-design-v1.md) · [开工契约 v1.23](../development-baseline-v1.23.md) · [分批表 v1.23](../development-delivery-matrix-v1.23.md)
- 当前阶段：**M0（单成员真实工作闭环）**；DEV-01—05 已完成（见 reports/）
- 最近更新：2026-09-27

## 工作包状态

| 包 | 交付重点 | 状态 | 代码位置 | 验收 | 证据/备注 |
|---|---|---|---|---|---|
| DEV-01 | 类型/schema、目标判别、路由、来源/权限/预算合同、MCP 预留 | **VERIFIED**（G0 范围） | `src/contracts/` `src/domain/` | G0 | [reports/dev-01-result.md](reports/dev-01-result.md) |
| DEV-02 | SQLite migration/事务、组合约束、回执、outbox、重启读取 | **VERIFIED**（存储侧） | `src/persistence/` | G1（存储侧子集） | [reports/dev-02-result.md](reports/dev-02-result.md) |
| DEV-03 | 可脚本化 fake adapter（六类 fixture） | **VERIFIED** | `src/adapter/fake/` + `src/contracts/runtime.ts` | — | [reports/dev-03-result.md](reports/dev-03-result.md) |
| DEV-04 | 目录打开/去重/重定位、物理锁域、基线清单 | **VERIFIED** | `src/daemon/` | RT-07/09（存储侧） | [reports/dev-04-result.md](reports/dev-04-result.md) |
| DEV-05 | daemon 单实例、派发 worker、停止代次、恢复基础 | **VERIFIED**（核心；IPC 传输随 DEV-07、真实进程注册随 DEV-06） | `src/daemon/` | G1 核心 | [reports/dev-05-result.md](reports/dev-05-result.md)：派发/停止/恢复全链 192/192 |
| DEV-17 | 线程关联与隔离（目标绑定、会话隔离、事件归属） | **VERIFIED**（M0 最小隔离） | `src/domain/isolation/` | G1/G3 前置 | [reports/dev-17-result.md](reports/dev-17-result.md)：五级绑定+事件归属+上下文过滤+双任务不串线；阶段级过滤随 DEV-08/09 |
| DEV-04 | 项目目录打开/去重/重定位、物理锁域、基线、用户内容保护 | NOT_STARTED | `src/daemon/` | G1/RT-07/09 | 依赖 DEV-01 ✅ / DEV-02 |
| DEV-05 | daemon 单实例、IPC、进程/会话注册、派发、停止代次、恢复基础 | NOT_STARTED | `src/daemon/` | G1 | 依赖 DEV-02/03 |
| DEV-06 | 真实 runtime（优先 Codex App Server）、能力/权限检测 | NOT_STARTED | `src/adapter/` | G2/B6/RT-23 | 依赖 DEV-03/05 + 最小隔离（DEV-17）+ 最小合同（DEV-21-M0）先行 |
| DEV-07 | 正式 UI 最小接入（保留原型交互，去 mock） | NOT_STARTED | `src/ui/` | G3 | 依赖 DEV-04/05/06 |
| DEV-08 | 独立分析与互评（冻结名单、阶段过滤、报告校验） | NOT_STARTED | `src/domain/` | G4 | M1 |
| DEV-09 | 分歧与整合（争议、轮次预算、确认矩阵） | NOT_STARTED | `src/domain/` | G4 | M1 |
| DEV-10 | 第二 runtime（Claude Code）、跨 runtime 互评 | NOT_STARTED | `src/adapter/` | G2/G4 | M2 |
| DEV-11 | 自动分工（计划校验、子任务 DAG、交接、有限返工） | NOT_STARTED | `src/domain/` | G4 | M2 |
| DEV-12 | 修改与 diff（单写者、前后基线、审查版本、非破坏撤销） | NOT_STARTED | `src/daemon/` | RT-07/08/10 | M2 |
| DEV-13 | 恢复与故障测试（不确定窗口、进程核对、成果一致性） | NOT_STARTED | `src/daemon/` | G1/RT | M3 |
| DEV-14 | 三模式完整 UI、任务/成果/确认/诊断、设置、教程帮助 | NOT_STARTED | `src/ui/` | G5 | M3 |
| DEV-15 | Windows 安装/卸载/托盘/升级迁移 | NOT_STARTED | 打包配置 | G5 | M3；native 依赖首次引入即验 ABI |
| DEV-16 | 发布验收（集成、兼容矩阵、性能、G5 结论） | NOT_STARTED | — | G5 | 依赖 DEV-10—15、17—19、21—25 与适用 G0—G4 |
| DEV-17 | 线程关联与隔离（目标绑定、会话隔离、事件归属） | NOT_STARTED | `src/domain/`+`src/daemon/` | G1/G3 | M0；最小隔离须在真实调用前具备 |
| DEV-18 | 未读与导航（水位、关注、搜索、收藏、深链、待我处理） | NOT_STARTED | `src/ui/` | RT-26/TH | M3 |
| DEV-19 | 房间协作视图（看板、Files 集合、附件、搜索） | NOT_STARTED | `src/ui/` | TH/WPV | M3 |
| DEV-20 | 完整权限加固（ADR-14 后置项） | NOT_STARTED（后续） | — | RT-20 | 首版原生限制不后置（DEV-06/10/14 承担） |
| DEV-21 | 提示词/输出合同（M0 DIRECT → M3 DM/提醒/跟进） | NOT_STARTED | `src/contracts/`+模板 | PP-01—12 | M0 段先出 DIRECT 最小合同 |
| DEV-22 | DM 持久化与实际执行（串行、暂停、权限、附件） | NOT_STARTED | `src/daemon/` | DM-BASE-01—08 | M3；契约已在 DEV-01 落 |
| DEV-23 | 提醒（一次/循环、occurrence 唯一、错过合并、通知） | NOT_STARTED | `src/daemon/` | REM/FOLLOW | M3 |
| DEV-24 | 七类附件、评论、导出、共享预览 | NOT_STARTED | `src/ui/`+服务 | WPV-01—36 | M3 |
| DEV-25 | 本机/LAN 浏览器、配对/吊销、HTTPS/WSS | NOT_STARTED | `src/daemon/` | RT-21/LAN-01—08 | M3 |

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

- 多 Agent 并行写入增强（write_intent、写范围校验、跨任务变更请求、整合闸门）、按任务 worktree（主设计 §14.7，2026-09-26 延期）。当前仅 `single_writer` 默认策略；`parallel_writers` 的七条底线约束已在契约中定义（`WriteConcurrencyPolicy`）。

## 阻塞登记

| 事项 | 影响范围 | 状态 |
|---|---|---|
| FULL-10 商业参数（定价/商户/法务）未提供 | FULL-10 生产集成 | 已登记；无依赖部分可先行，不阻塞其他包 |
| 无其他阻塞 | — | — |

## 下一步（按依赖）

1. **DEV-04**（项目目录真实打开/去重/重定位、物理锁域 RT-09、基线清单）——依赖已齐（DEV-01/02 ✅）。
2. **DEV-05**（daemon 单实例、IPC、进程/会话注册、派发 worker、停止代次、恢复基础）——依赖 DEV-02 ✅/DEV-03 ✅；与 DEV-04 可并行推进。
3. 随后 DEV-17 最小隔离 + DEV-21-M0 最小合同 → DEV-06 真实 runtime（Codex App Server，专用 fixture）→ DEV-07/G3 用户闭环。
