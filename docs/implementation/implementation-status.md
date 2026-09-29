# 众说正式工程 · 施工总账

> 本文件是跨会话施工进度唯一真源之一（与 requirements-traceability / continuation 配套）。
> 状态取值：`NOT_STARTED / IN_PROGRESS / IMPLEMENTED / VERIFIED / BLOCKED / DEFERRED_BY_USER`。
> `IMPLEMENTED ≠ VERIFIED`；`BLOCKED` 必须写具体外部条件；`DEFERRED_BY_USER` 引用用户明确决定。

- 施工分支：`codex/full-implementation`（总任务书 §3.3：各包在同一施工分支形成检查点）
- 依据：[施工总任务书 v1.1](../dev-briefs/full-implementation-brief-glm5.3.md) · [主设计 v1.23](../zhongshuo-development-design-v1.md) · [开工契约 v1.23](../development-baseline-v1.23.md) · [分批表 v1.23](../development-delivery-matrix-v1.23.md)
- 当前阶段：**M0（单成员真实工作闭环）**；DEV-01—05/17/21-M0 已实现（见 reports/）
- 最近更新：2026-09-29 第九轮（**进程树保守判定**：probe 不再返回 exited——周期快照只产生「未观察到存活后代」观察、不构成完整退出证明，有子进程 runtime 自动解除路径关闭；历史身份追加式登记（迁移 014：pid+started_at 代次、从不删未确认身份）；盲区反例如实返回未完整确认；**迟到回执原子化**（迁移 015 作用域键 source_scope+turn+eventKey，回执与业务效果同事务、失败回滚可恢复；归属校验不认领；泵收口不释放写入租约）；**验收绑定交付版本**（deliveryId+revision 条件更新+冲突区分+同号重放幂等；返工说明注入后续派发输入）；**DEV-14 深化**（git.diff 正文只读/撤销续跑入口/设置持久化/常驻帮助面板）。502/502+uiE2e 19+2skip、lint 0、零真实调用。**恢复与修复链按能力分列（见 continuation）：有子进程解除路径=设计边界关闭；真实 CLI lateEvents=unsupported**。价值评分=用户决定暂缓（不放回待办））
- 上一轮·七（**OS 退出证据服务端化**：adapter 进程身份三模型（per-turn/shared/none）+runtime_process_registry 登记+recovery.probeProcess 服务端取证+reconcile 参数重写（调用方不能自报 alive=false；notStarted 人工分离 manualRiskAck——退款但租约保留）+Windows 查询错误分类修复；**逻辑输出修复限次**（迁移 010 UNIQUE(task,logical_output_id)：禁止修复套修复、被拒零副作用）；**预算统一授权账目**（逐 turn 处置事实单一真源，SUM 快照重复计反例锁定；budget_run_id 授权链校验+上限强制）；**文件清单回授权合同**（§13.4 项目源码默认可读/§6.3 命名排除/大小写归一/上限过滤后计数）；**恢复 UI 事实分层**（程序观测/人工说明/无法确认/保留保护+遗留租约行+renderer e2e 反例）。451/451+uiE2e 16/16+realCodex 4/4、lint 0、零真实调用。**价值评分=用户决定暂缓**（恢复与修复链稳定后集中安排一次；DEV-11 不开放；剩余 3 次保留）
- 上一轮（2026-09-28 第六轮·下：

## 工作包状态

| 包 | 交付重点 | 状态 | 代码位置 | 验收 | 证据/备注 |
|---|---|---|---|---|---|
| DEV-01 | 类型/schema、目标判别、路由、来源/权限/预算合同、MCP 预留 | **VERIFIED**（G0 范围） | `src/contracts/` `src/domain/` | G0 | [reports/dev-01-result.md](reports/dev-01-result.md) |
| DEV-02 | SQLite migration/事务、组合约束、回执、outbox、重启读取 | **VERIFIED**（存储侧） | `src/persistence/` | G1（存储侧子集） | [reports/dev-02-result.md](reports/dev-02-result.md) |
| DEV-03 | 可脚本化 fake adapter（六类 fixture） | **VERIFIED** | `src/adapter/fake/` + `src/contracts/runtime.ts` | — | [reports/dev-03-result.md](reports/dev-03-result.md) |
| DEV-04 | 目录打开/去重/重定位、物理锁域、基线清单 | **VERIFIED**（修复轮后） | `src/daemon/` | RT-07/09（存储侧） | [reports/dev-04-result.md](reports/dev-04-result.md)+勘误：RT-07 真过期阻塞已修复（原用例假阳性）；parallel_writers 入口已禁用（ADR-I19） |
| DEV-05 | daemon 单实例锁、派发 worker、停止代次、恢复基础、命名管道 IPC | **VERIFIED**（修复轮后） | `src/daemon/` | G1 核心 | [reports/dev-05-result.md](reports/dev-05-result.md)+勘误：独立截止计时/会话竞态复查/派发门禁/重领对账/模式门禁/验收策略/锁原子化/IPC 全部补齐；**真实进程边界随 DEV-06 验证，不提前声称** |
| DEV-17 | 线程关联与隔离（目标绑定、会话隔离、事件归属、上下文过滤接入派发路径） | **VERIFIED**（任务级；阶段级随 DEV-08/09） | `src/domain/isolation/` + worker 接线 | G1/G3 前置 | [reports/dev-17-result.md](reports/dev-17-result.md)+勘误：过滤白名单强化（指令/摘要/文件均验归属）、ContextBundle 已在派发路径组装落库、同成员双任务隔离用例 |
| DEV-06 | 真实 runtime（Codex App Server）、能力/权限检测 | **VERIFIED（G2 适用范围）**：C1/层 A、计划档两路径（declined/sandbox-denial 证据绑定）、确认档 allow+deny、steer 正常+服务端拒、resume 续接+不放宽、interrupt、usageTokens | `src/adapter/codex/` | G2（Codex 单 runtime；structuredFinal 真实输出随 G3） | [reports/round-20260927-fix4-dev6finish-dev07backbone.md](reports/round-20260927-fix4-dev6finish-dev07backbone.md)（勘误链完整） |
| DEV-07 | 正式 UI 接入（Electron+IPC+renderer） | **VERIFIED（G3 范围）**：CDP 真点击用户链路 11/11（发送/DONE/线程回复/跟进不新建根任务/草稿独立/仅记录/去重/IME/重载恢复/UI 停止/崩溃恢复门禁）+ 真实 codex UI 一轮（1 turn）；打包随包 Node 属 DEV-15 | `src/ui/` + `src/daemon/` + `src/contracts/daemonIpc.ts` | G3 ✓ | [reports/round-20260927-fix6-ui-e2e-g3-closeout.md](reports/round-20260927-fix6-ui-e2e-g3-closeout.md) |
| DEV-08 | 独立分析与互评（冻结名单、阶段过滤、报告校验） | **真实已验证（一组，29/29 审计）**：IND 隔离/CR 三元组/屏障经真实模型闭环（round-20260928）+fake 集成 | `src/daemon/deliberationRunner.ts` + `src/domain/deliberation/` | G4（价值闸门未做） | [reports/round-20260928-m1-closeout.md](reports/round-20260928-m1-closeout.md) |
| DEV-09 | 分歧与整合（争议、轮次预算、确认矩阵） | **无争议分支真实已验证**（SYN/RAT/共识矩阵 29/29）；讨论轮/checkpoint/缺席/迟到=受控用例已验、真实补证按需另排 | `src/daemon/deliberationRunner.ts` + `src/persistence/stores/deliberation.ts` | G4（价值闸门未做） | 同上 |
| DEV-10 | 第二 runtime（Claude Code）、跨 runtime 互评 | **IN_PROGRESS（真实认证：turn1 全链+受控中断均通过）**：deepseek-flash 实测可用；interrupt 按证据 supported（进程证据后停/无孤儿/不复活）；resume/restrict*/isolation=unverified（逐项按证据）；只读档正式机制组合（--permission-prompts none+--disallowedTools+--bare 等）；E4 调度解耦实装（detached+成员互斥）；剩余=resumeSession 真实续接+restrict* 拒写对照（B6） | `src/adapter/claude/cliAdapter.ts`、`src/daemon/memberRuntime.ts`、`src/daemon/dispatchWorker.ts` | G2/G4 | M2 | [round-20260928-dev10-interrupt-e4.md](reports/round-20260928-dev10-interrupt-e4.md) |
| DEV-11 | 自动分工（计划校验、子任务 DAG、交接、有限返工） | NOT_STARTED | `src/domain/` | G4 | M2 |
| DEV-12 | 修改与 diff（单写者、前后基线、审查版本、非破坏撤销） | **IMPLEMENTED（本地验证；第五轮四项修复后加固：扫描完整性（失败不静默+进入前物理核验+空目录合法）、撤销三态与最近祖先 realpath 重核、崩溃窗口三向恢复判定（补记不重执行/不误判冲突/failed 可续跑）、PhysicalWriteRootRegistry 统一写入占位（B6 接线点）；审查版本 UI 归 DEV-13/14）**：三态前像（present/absent/unknown——unknown 不推导）+内容寻址存储（双端 hash 核对+大小上限提前呈现）+Git 基线（HEAD+porcelain+未提交内容前像，不 stash/reset）+非 Git 整目录扫描（截断如实）+非破坏撤销（逐步重验当前==after、冲突不覆盖、单文件临时+rename、多文件逐步持久化可恢复续跑）+正式命令 changeset.captureBaseline/finalize/undo/get+单写者租约检查；反例 9/9+前像单元 6/6（临时 fixture 含临时 Git 仓库） | `src/daemon/preimage.ts`、`src/daemon/changeset.ts`、migrations/007 | RT-07/08（租约侧）/10 | [round-20260928-admission-exit-hardening.md](reports/round-20260928-admission-exit-hardening.md)；RT-08 派发侧完整用例待 B6 写档接线 |
| DEV-13 | 恢复与故障测试（不确定窗口、进程核对、成果一致性） | **IN_PROGRESS（第九轮保守判定+迟到回执原子）**：adapter 进程身份三模型+runtime_process_registry 登记+recovery.probeProcess 服务端取证+reconcile 服务端证据（probe 结果释放矩阵/probeId 引用校验/notStarted 人工分离=退款但租约保留）+Windows 错误分类+恢复面事实分层 UI（遗留租约行；人工声明不解除物理保护）+崩溃-重启 renderer e2e 反例；**真实 CLI 崩溃现场样本未跑**（零调用纪律）；剩余=成果一致性专项+DEV-05 supervisor 衔接（registry/probes 表已就绪） | `src/daemon/`（processCheck/processRegistry/commands/dispatchWorker） | G1/RT | M3；报告 round-20260929-process-evidence-repair-budget.md |
| DEV-14 | 三模式完整 UI、任务/成果/确认/诊断、设置、教程帮助 | **IN_PROGRESS（第十轮 Git 读写闭环+验收开关）**：第八/九轮 git.status/git.diff/task.review/runtime.status/撤销详情+UI；第十轮①只读协议重写（raw/numstat -z 机器身份、字面 pathspec、采集期容量控制 64KB/512KB/50 文件、numstat 失败=unknown、未跟踪内容视图、外部 diff/textconv 不执行-标记程序反例、子目录项目范围标注）；②写闭环（迁移 016 git_operations；stage/unstage/stageTask 跳过 userPreExisting+混合文件冲突；commitPreview/commit 预览绑定 expectedHead+索引摘要+尾标记崩溃恢复；history 任务关联；租约/冲突/身份/范围四类前置；UI Git 操作区）；③项目验收开关 project.reviewPolicy.set（CAS+仅影响新任务+持久化）+返工意见必填+「追加执行」入口（task.redispatch）+返工第二轮交付守卫修正（run rowid 先后）+e2e 正式闭环不经补库；剩余=RT-24 后半（branch/checkout、push/pull、conflict.resolve、commit.undo、单提交聚合 diff）、设置页其余真实项、完整帮助（START-07/09 随 DEV-15/16 收口） | `src/ui/` + `src/daemon/gitStatus.ts`、`gitWrite.ts` + commands | G5（进行中） | M3；报告 round-20260929-round10-git-protocol-write-review.md（前轮：round9/round8 报告见 reports/） |
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

## 统一准入/退出状态机/harness/工具审计（2026-09-28 第四轮）

详见 [reports/round-20260928-admission-shutdown-tools.md](reports/round-20260928-admission-shutdown-tools.md)。统一派发准入（global/project/provider/member+writeRoot 接入口、启动窗口占位、UNKNOWN 保留占用、预算并发不混用；7 组反例+修三缺陷含 DIRECT 截止中断误判 CANCELLED→UNKNOWN）；退出状态机（incomplete 不关库不释放锁、force 路径=杀+abort UNKNOWN 收尾后关库、退出码 0/3；本地反例全过）；real-delib stop 操作闭环（正式 task.stop 绑定代次→观察至可解释终态、taskkill 仅崩溃注入）；thread.toolCalls 命令+renderer 线程尾只读区块（domain_events 真源、隔离去重、集成 4/4）；DEV-12 前像捕获/diff 纯函数起步（临时 fixture）。

## DEV-10 受控中断认证 + 能力修正 + E4 解耦实装（2026-09-28 第三轮）

详见 [reports/round-20260928-dev10-interrupt-e4.md](reports/round-20260928-dev10-interrupt-e4.md)。受控中断真实认证通过（预算 1/1：进程证据后 2ms 停止、CANCELLED 全链、无交付/孤儿/复活、重启不复活；usage=0 如实）；能力声明逐项按证据修正（interrupt→supported，resume/restrict*/isolation→unverified；单一真源+probe/命令同步）；--allowedTools=预授权非总白名单取证+只读档正式机制组合+tool 事件落库审计（模型自述核对依据）；中断/收拢实装（停止/退出分离、INTERRUPTED、迟到 result 不交付、disposeAll 汇总、本地进程 fixture 6 用例）；E4 调度解耦实装（detached 消费器+成员互斥+租约续期+awaitInFlightTurns，假时钟 4 用例；修复 lateRecorded 误判与 SYN 在途预算误判两缺陷，detached 预算 20/20 与 inline 一致）。370/370、e2e fake 13/13、lint 0。

## DEV-10 真实认证轮：deepseek-flash + 启动安全 + 成员级生产接线（2026-09-28 深夜·二）

详见 [reports/round-20260928-dev10-real-auth.md](reports/round-20260928-dev10-real-auth.md)。渠道核对（http://192.0.2.10 代理、/v1/models 含裸 deepseek-flash、unrecognized_model=服务端透传且成功 turn 亦有该告警、`[1m]`=CLI 后缀语法被 adapter 拒绝）；启动路径安全（shell:false+原生 exe 解析+prompt 全文走 stdin+argv 固定+字符集校验+--verbose，特殊字符零额度反例）；resultKey 回放闭环（模拟器读 stdin 合同→DONE，错误 resultKey 反例）；成员级 runtime 生产接线（member.setRuntime/member.runtime 命令→绑定链→MemberRuntimeRegistry→worker adapterFor 两路径，未绑定回落默认、不可用 kind 如实抛错）；真实预算 2/2（1 次意外探活事故=settings env 优先于子进程 env+1 次 turn1 全链成功）；受控中断待批补 1 次。默认 360/360、lint 0。

## DEV-10 适配器实装 + dispatchWait 合同一致化（2026-09-28 深夜）

详见 [reports/round-20260928-dev10-adapter.md](reports/round-20260928-dev10-adapter.md)。Claude CLI adapter 实装（进程模型/--resume 续接/NDJSON 归一化/合成事件依据注明/能力三态/steer·审批拒绝）；零额度回放 8 用例+共用 worker 跨 runtime 成员绑定（fake+Claude 回放不串线、domain 无厂商分支）；dispatchWait 独立截止→unavailable（合同一致，与 absent 区分、可恢复、不重派旧键）；价值方案 v3（DIRECT 2/组+DELIB 9/组×3=33 待批，A 旧运行无确认选项）；E4 在途推进生产承载如实未完成（串行 drain 限制，M2 前置）。默认 353/353。

## M1 收口轮三：价值方案 v2 + E4 生产接线 + 建房 UI 链路 + DEV-10 启动（2026-09-28 晚）

- 价值方案 v2（m1-value-gate-proposal.md）：中性任务目标（协作流程不入共同正文）、逐行预算（A-DIRECT 3/A-DELIB 9/B/C 各 3+9，总新增 36；旧 A 运行标历史参考不复用）、评定者盲表述、合成 fixture=受控场景声明。**待批准，未调用模型**。
- E4 生产接线：approval.requested/input.requested→暂停起点（kv），续行事件结算 exec_paused_ms 并回 RUNNING——真实审批桥（fake waitApproval+respondApproval）集成验证：121ms 暂停窗正确累计、缺席判定扣除。dispatchWait 合同核对：排队超线只诊断不改成员状态（与"排队非成员责任"一致）；派发不可能（预算耗尽跳过）由屏障按 missing/缺席处理——既有收口语义覆盖。
- 审计 v3 四态（PASS/FAIL/NOT_APPLICABLE/NOT_VERIFIABLE）：历史运行 56 PASS/0 FAIL/2 N/A（清单机制晚于该运行，"历史版本缺此证据，无法验证"——不再计 FAIL 也不宣称通过）；派生证据记录（原始 WAL 三件 hash+重建工具+结论来源区分，evidence/m1-real-run-derived-db.md）。
- 建房用户链路 e2e（fake，13/13 之一）：建房→成员子集→切换→DELIB 发送→回复；两房主池/草稿（按房间键隔离）不串线。
- DEV-10：本机环境确认（零模型预算除 1 次探活）+ 契约核对成文；实施计划登记。
- 默认 344/344；UI e2e fake 13/13。

## M1 收口轮：真实研讨闭环 + 调度/E4/迟到/身份收口（2026-09-28）

详见 [reports/round-20260928-m1-closeout.md](reports/round-20260928-m1-closeout.md)。三次历史真实尝试完成 WAL 取证（两次=截止中断误判用户停止的缺陷、一次=CODEX_ERROR 正文未存档）；时钟注入/排队≠缺席/成员级缺席/迟到三分支/run 作用域派发键/确定性 RATIFY 收口全部零额度反例落地（331/331）；提交-观察分离 harness（scripts/real-delib.mjs）；**一组真实研讨完成**（7/9 预算精确、unanimous、29/29 逐项审计：隔离/三元组/冻结版本/矩阵共识/hash/预算账）；门禁改显式 opt-in。**价值闸门未做结论**。

## M1 第一轮：缺陷收口 + DELIBERATE 编排 + UI + 门禁开放（2026-09-27）

详见 [reports/round-20260927-m1-deliberation.md](reports/round-20260927-m1-deliberation.md)。四处缺陷（屏障冻结集合/三元组引用+run 范围 issueId/RATIFY 幂等+行数核对/成果发布协议）零额度反例收口（迁移 004/005）；DELIBERATE 全阶段持久化编排（确定性 dispatch_key 步骤、服务端输入隔离、E12 预算单一账、E4 假时钟缺席、停止作用于运行、一次格式修复）；研讨 UI（run.progress/report.get/@全体芯片/进度条/逐结论共识报告）；门禁按证据开放（entry 默认，worker 级默认关不变）。默认 323/323；UI e2e fake 12/12。**M1 价值闸门未做结论**（对比材料待预算）。

## 修复轮 6 + G3 收口（2026-09-27）

详见 [reports/round-20260927-fix6-ui-e2e-g3-closeout.md](reports/round-20260927-fix6-ui-e2e-g3-closeout.md)。证据口径修正（ZS_UI_DEMO=宿主内链路，非 UI 端到端；renderer app.js 此前从未成功执行——IIFE 修复）；R1-R5 renderer 全量接通（停止/恢复入口/room.pool+thread 目标/草稿去重 IME/重启恢复）；B1 管道 commandId 关联（超时迟到响应丢弃反例）；B2 生命周期收口（drain 收敛/重复 stop/关库后零写入）；CDP 驱动 UI e2e fake 11/11 + 真实 codex 1 turn（UIE2E-CODEX-6666）；同成员排队用例补齐；IPC 协议下沉 contracts/daemonIpc.ts（边界违规清零，ADR-I41/I42）。默认 276/276。**G3 收口，进入 M1。**

## 修复轮 4 + DEV-06 收口 + DEV-07 骨干（2026-09-27）

详见 [reports/round-20260927-fix4-dev6finish-dev07backbone.md](reports/round-20260927-fix4-dev6finish-dev07backbone.md)。B6 证据绑定共享验证器（declined/sandbox-denial 可辨识原因，7 负例）；锁未知身份一律 BUSY+代次校验接管（ADR-I34）；DEV-06 剩余认证 5/5（steer 正常+服务端拒/审批 allow/resume 不放宽/usageTokens/interrupt）；DEV-07 骨干落地（commands/entry/pipeClient + smoke：project.open→message.submit→worker→事件→重启门禁→resume 续跑）；顺带修复孤儿租约重排与 fake 会话 id 唯一。

## 修复轮 3（2026-09-27，用户复核三项后）

协议/锁/B6 收口（详见 [reports/dev-06-fixround3-result.md](reports/dev-06-fixround3-result.md)）：turn/started|completed 只认 turn.id（mock 去伪字段）+awaiting 按会话隔离+响应解析同步点注册映射（未知归属终态在 adapter 层不带内部 turnId、worker 层审计不终结当前轮）；锁身份写入窗口（半写入≠已死，mtime 宽限，onBeforeClaimIdentity 同步点无双持有）；B6 证据绑定（指定工具+toolCallId 配对+目标路径+resultRef 拒绝原因）。真实认证新增：steer 错误 ID 拒绝、resume 跨进程续接（暗号恢复）、审批桥 deny（read-only+on-request 触发 approval.requested→deny→无写入）。默认 260/260；e2e 7/7（gpt-6-luna）。

## 修复轮 2（2026-09-27，GPT 复核 7 项后）

外部复核的协议与边界缺陷全部整改（详见 [reports/dev-06-fixround2-result.md](reports/dev-06-fixround2-result.md)）：终态按 turn.status 映射、事件按 provider turn 归属（awaiting 机制）、进程代次+initialized 通知+resume 接线、worker 完成
路径接 TaskComplete schema（非法输出 OUTPUT_INVALID 零交付）、B6 断言收紧（工具活动证据+内容变化断言+额度排除）、能力自报收窄（仅 structuredEvents=supported）、单实例锁目录协议重写（mkdir claim 原子接管）。本地协议回放 mock（tests/fixtures/mockAppServer.mjs）8 用例覆盖终态各态/迟到/早到/审批/重建——**零模型额度**。真实 e2e（gpt-6-luna）：C1 文件回流+层 A+计划档直接编辑/shell 两路径 4/4 通过。

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
| deepseek-flash 渠道在当前 ChatGPT 登录态不可用（400） | e2e 模型选择 | 已切换 gpt-6-luna（用户指定型号）通过；可用 ZS_E2E_MODEL 环境变量覆盖 |
| FULL-10 商业参数（定价/商户/法务）未提供 | FULL-10 生产集成 | 已登记；无依赖部分可先行，不阻塞其他包 |

## 下一步（按依赖）

1. **DEV-06**（真实 runtime，Codex App Server 专用 fixture 适配认证）：防线与输入合同已就绪（隔离/门禁/停止/恢复/预算/DEV-21-M0 信封）；先 probe 版本/能力，再 initialize→thread.start→turn.start 真实路径；B6/RT-23 档位认证未过前 UI 档位禁用；PP-01/PP-12 注入验证随本包联合完成。
2. **DEV-07**（Electron main/preload + 命名管道 IPC 接线 + hifi-prototype 交互复用接真实命令面）→ G3 演示。
