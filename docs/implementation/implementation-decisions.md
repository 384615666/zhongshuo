# 实施决策记录（施工 ADR）

> 编号 Ixx 为施工层实施决策（区别于主设计 ADR-01—16）。每条含依据与影响；
> 与权威文档冲突时以权威文档为准并在此登记修正。

## ADR-I01 · 工程脚手架形态（2026-09-27）

pnpm 单仓单包 + ESM（`"type":"module"`）+ NodeNext；Node ≥24（实测 24.16.0）、pnpm 11.23.0。
测试 Vitest 5.0.2；schema 库选 **zod 4.6.5**（TS 推导好、discriminatedUnion/strictObject 齐备、运行时校验与类型单一真源）。
依据：DEV-01 任务书「已定工程决策」；主设计 §8.2（JSON Schema 或等价运行时 schema）。
影响：所有跨进程输入经 zod strictObject 校验；多余字段即拒绝（自报 authorId 防线之一）。

## ADR-I02 · ID/时间标量用 string/number 别名，不用 brand（2026-09-27）

DTO 层 ID 为 `type X = string` 别名。理由：跨 IPC/SQLite/JSON 序列化零转换；
引用完整性由 DEV-02 迁移约束承担。时间统一 UTC 毫秒 number（§12.2）。

## ADR-I03 · TypeScript 固定 6.x（2026-09-27）

实测 typescript 7.0.2（原生版）与 typescript-eslint 8.70.1 不兼容（硬报错）。
降级 typescript@6（当前 6.0.3），tsc/vitest/eslint 全链路可用。
重审时机：typescript-eslint 官宣支持 TS ≥7 后升级（issue #10940）。

## ADR-I04 · domain 使用 node:crypto 做 payloadHash 摘要（2026-09-27）

`computeCommandPayloadHash` 用 SHA-256 + 规范化 JSON（键排序、数组保序）。
node:crypto 是纯计算无 IO，不破坏 domain 纯度边界；幂等冲突判定需要低碰撞摘要。
影响：domain 可移植性受限（Node 运行时），本产品本就运行于 Node/Electron，接受。

## ADR-I05 · 纯函数统一 DomainResult，不抛异常（2026-09-27）

`DomainResult<T> = {ok:true,value} | {ok:false,error:CommandError}`；
上游 daemon 映射为 CommandResult.error。路由/范围/停止/幂等/预算全部遵守。

## ADR-I06 · 六边界用 ESLint flat config 内联本地插件强制（2026-09-27）

`eslint.config.mjs` 内联 `zhongshuo/six-boundaries` 规则（相对导入解析 → 边界矩阵），
不引入 eslint-plugin-boundaries 额外依赖。已用反例验证（ui→domain/persistence 均拦截）。
矩阵：contracts→∅；domain→contracts；persistence/adapter→contracts,domain；daemon→全部；ui→contracts；tests→全部。

## ADR-I07 · 权威文档未穷举的状态枚举，取最小诚实集合并标注"DEV-02 定稿"（2026-09-27）

§12.2 有列无枚举的字段（projects.status、conversation_threads.status、messages.status）：
- ProjectStatus = active/archived/directory_missing/removed（SPACE-06、RT-14）
- ThreadStatus = open/closed/archived
- MessageStatus = saved/streaming/final/invalid（§12.6 流式语义）
- WorkflowRunStage = DeliberateStage（§6.1 权威）| string（AUTO/DIRECT 阶段编排未定稿，不用未定枚举冒充契约）
DEV-02 建迁移时如需增删，在此登记并同步 schema。

## ADR-I08 · conversation.create 仅接受 kind=dm（2026-09-27）

房间会话随 room 创建一对一回填（开工契约 §2.2「每个 room 恰有一个会话」），
不提供手工创建 room 会话的入口，避免第二真源。

## ADR-I09 · 停止判定的四态映射（2026-09-27）

`evaluateStopTarget` 纯判定：目标运行≠当前运行且未终态→target_obsolete；
目标已终态→already_stopped（§31.4「目标已终态时返回其最终状态」）；
代次落后且目标已终止→stopped（本次请求的停止已完成）；代次落后且未终止→stopping；
携带未来代次→STALE_REVISION 拒绝。代次推进的持久化归 DEV-05。

## ADR-I10 · tsconfig 附加严格项（2026-09-27）

strict 之外开启 noUncheckedIndexedAccess / noImplicitOverride /
noFallthroughCasesInSwitch / verbatimModuleSyntax / isolatedModules / allowImportingTsExtensions。
未开 exactOptionalPropertyTypes（与 zod optional 语义摩擦大，收益有限；重审于 DEV-02 前如遇可选字段歧义）。

## ADR-I11 · DM 空值约束分两层（2026-09-27）

Message schema 只能表达单实体不变量（thread_id ⇔ thread_message_seq、via_connection_id 仅 human）；
「DM 消息 room/thread/线程序号全空」需要会话 kind，落在 `validateMessageConversationBinding`
跨实体纯函数（服务端提交路径执行）。DB CHECK 约束由 DEV-02 迁移再补第三层。

## ADR-I12 · better-sqlite3 13.0.3（2026-09-27，DEV-02）

版本锁定 13.0.3（包内 prebuilds，无需 node-gyp 源码构建），实测 Node 24.16.0 真实执行 SQL
（SQLite 3.53.4）——ABI 以真实运行为证，非"装上即认"。WAL 对 `:memory:` 不生效（SQLite 限制，
journal_mode 保持 memory），文件库生效——测试分别断言。Electron 场景：daemon 进程持库，
renderer 不加载 native 模块（开工契约 §9），Electron rebuild 需求在 DEV-05/15 引入 Electron 时复验。
pnpm 11 构建许可经 `pnpm-workspace.yaml` 的 `allowBuilds` 授权。

## ADR-I13 · external_connections/external_grants 延后至 FULL-11 迁移（2026-09-27）

§31.8 的两张表不在 §12.2 表结构目录内；§12.2 为唯一权威命名。messages.via_connection_id/
tasks.source_connection_id 列已按 §12.2 落地（无 FK，FULL-11 迁移补引用约束）。

## ADR-I14 · workspace_leases 活跃租约数量约束在服务层（2026-09-27）

single_writer（≤1 活跃租约/锁域）与 parallel_writers（多租约+上限）随项目设置变化，
数据库层无法用单个部分唯一索引同时表达两种策略；表结构保留组合主键 (lock_domain, owner_turn_id)，
数量约束由 DEV-04/12 的服务层按项目策略执行（RT-07/08/09 验证）。

## ADR-I15 · dm_participants「恰两主体」在创建事务执行（2026-09-27）

SQLite 无延迟约束触发器，逐行插入无法在中途满足"恰好两行"；由服务层创建事务保证
（插入恰两行不同主体后提交），测试承载反例（第三人插入拒绝路径随 DEV-22）。

## ADR-I16 · run/turn 会话绑定经组合外键链（2026-09-27）

组合外键 (project_id, conversation_id)→conversations 落在有 project_id 列的表
（threads/messages/tasks/members/dm_participants/read_states/sessions/followers）；
workflow_runs/agent_turns 目录未列 project_id，经 task→tasks 组合外键链绑定，
run.conversation_id==task.conversation_id 由服务层提交路径校验（§2.2「任务/run/turn
同时校验所属关系」的服务层部分）。

## ADR-I17 · pnpm-workspace.yaml 仅承载设置（2026-09-27）

pnpm 10+ 把 onlyBuiltDependencies/allowBuilds 等设置迁到 pnpm-workspace.yaml。
本文件的 `packages: ['.']` 只声明根包自身，**不构成多包 workspace**（C6 单仓单包口径不变）。

## ADR-I18 · reminder_occurrences 表超出 §12.2 字面目录（2026-09-27）

开工契约 §7「occurrence 以 (reminderId,scheduledAt) 唯一、错过合并」需要持久化载体；
001 迁移加了该表（主键即唯一约束）。已在报告标注，属对 §12.2 的工程性补充，
待下次主设计修订时同步回写目录。

## ADR-I19 · parallel_writers 租约入口禁用（2026-09-27，修复轮）

§14.7 将并行写入增强整体延期，但 DEV-04 首版 acquireLease 允许调用方传
`parallel_writers` 开启共存分支——外部审查指出这与"未批准施工"基线不一致。
修复：入口一律 `CAPABILITY_UNSUPPORTED` 拒绝（含测试断言拒绝且不产生租约行）；
§14.1 底线实现逻辑保留在代码注释，待用户重新批准后恢复。

## ADR-I20 · 派发门禁（daemon_state，2026-09-27，修复轮）

恢复流程"重排不自动补跑"原只有注释无执行约束。迁移 003 建 `daemon_state` 表：
`applyRecovery` 检测到任何需人工核对的痕迹（中断 run/未知 turn/重排队列/未释放租约）
即落 `dispatch_gate=held`；worker 每次领取前检查；`openDispatchGate`（用户确认继续）
放行（§16.4-6/决策 44/E7）。崩溃重领（dispatch_key 已有 turn）不重试执行：
failOutbox + `run.reconcileRequired` 审计（RT-03 不确定窗口语义，人工/DEV-13 处理）。

## ADR-I21 · 单实例锁原子化（2026-09-27，修复轮）

check-then-write 在并发启动下可双成功。改为 `open(path,'wx')`（O_CREAT|O_EXCL）
独占创建；持有 pid 存活即 BUSY；已死则先把旧锁原子 rename 移走（并发接管仅一个
成功）再独占创建。双进程竞态用例（真实子进程）验证恰好一个赢家。

## ADR-I22 · worker 模式门禁与验收收尾（2026-09-27，修复轮）

M0 仅 DIRECT：route_json 模式非 DIRECT 的任务派发时转 BLOCKED 并留
`mode_unavailable_in_m0` 审计（明确不可用，不冒充单成员执行后把研讨任务报完成）。
完成收尾按任务 review_policy 快照：user_review → task REVIEW + pending 交付
（manifest_hash=最终回复 sha256，唯一待办）；auto_deliver → DONE + not_required
（reviewed_by/at 为空，不伪造人工通过）。

## ADR-I23 · 事件流竞速不吞事件（2026-09-27，修复轮）

worker 的截止计时用 Promise.race 实现；race 输掉的一侧若是对 async iterator 的
`next()` 调用，该读取仍会消费一条事件但结果被丢弃（async generator 禁止并发 next，
排队执行）——实测导致沉默超时用例吞掉终结事件。修复：保留 pending 的 next promise
跨 race 复用，不重复调用 next()。同类经验适用于一切对 async iterator 的超时控制。


## ADR-I24 · 单实例锁接管纪律（2026-09-27，收口轮 2）

创建中窗口（空/半截锁文件、mtime < createGraceMs）保守 BUSY 不接管（宁可误判占用不可双 daemon）；
陈旧接管三步：判定死 pid → rename 前二次读取确认内容未变 → rename 后读回核对，误移他人新锁则还原并 BUSY。

## ADR-I25 · interrupt 限时发送（2026-09-27，收口轮 2）

adapter.interrupt() 可能永不返回：worker 限时发送（宽限剩余时间为上限、fire-and-forget）后立即回主循环，
宽限计时由主循环承担；事件 race 侧定时器 clearTimeout+unref，不悬挂进程。

## ADR-I26 · 输入组装前置与信封落库格式（2026-09-27，DEV-21-M0）

assembleDirectTurn 在 createRun **之前**执行（必要材料缺失/敏感命中→BLOCKED+task.contextAssemblyFailed 审计，不建 run/turn）；
context_bundles.included_refs_json 存**完整信封**（版本/预算/权限/材料/线程摘要/输出契约），hash=canonical JSON sha256，
与 startTurn 文本同源（PP-04 可核对）；层 A 经 OpenSessionInput.developerInstructions+promptVersion 随会话注入。
追加 turn 用 `task:{id}:redispatch` 键（任务非终态+stop_generation=0 才放行）。

## ADR-I27 · 再交付 revision 递增（2026-09-27，DEV-21-M0 轮发现）

追加 turn 的交付按 (task_id) MAX(revision)+1 递增，旧 pending 标 superseded（§10.5-5「替换当前待办」）；
修复首版固定 revision=1 撞唯一键的缺陷。


## ADR-I28 · 单实例锁目录协议（2026-09-27，修复轮 2 重写）

文件锁的"读-判-rename"接管无法原子化（审查确认）。重写为目录协议：锁=mkdir `daemon.lock.d`（创建即持有，原子）；接管=先 mkdir `claim/`（原子，并发接管唯一赢家；claim 主活着含本进程重入→BUSY；死了→清理重试）→ rename 整目录归档 → 内容复核（与判定不符则不启动）→ 重建。legacy 文件锁兼容迁移。测试用 onClaimed 同步点注入真实竞争窗口。

## ADR-I29 · TaskComplete 输出合同接入完成路径（2026-09-27，修复轮 2）

worker 收到 turn.completed 必须先通过 taskCompleteSchema（JSON 解析→schema→resultKey 与 `result_${turnId}` 绑定）；非法输出（空/散文/缺项/错版本/错 resultKey）→ turn FAILED + 任务回 ACTIVE + `turn.outputInvalid` 审计 + **零交付**（不 DONE/REVIEW）。有限修复 turn（规格 §4.5：最多一次、新 turnId、共用 resultKey）随调度器扩展实现，不在本轮伪造。fake adapter 的 turn.completed 改为结构化终态（structuredFinal 默认开启，TurnRequest.resultKey 驱动），与真实合同同构——单测的 schema fixture 通过不再等于运行路径受约束，两层各有断言。

## ADR-I30 · Codex 适配器能力三态口径（2026-09-27，修复轮 2）

协议字段存在、适配器方法实现、真实行为通过是三个不同状态。probe 能力表仅 structuredEvents=supported（真实进程观察到通知链路）；resumeSession（thread/resume 已接线）、steerActiveTurn（expectedTurnId 已接线）、interrupt、usageTokens、structuredFinal、interactiveApprovals、restrictWrites/Shell、disableDelegation 一律 unverified，按真实用例逐项升级。RT-23 计划档两路径（直接编辑/shell）已 PASS 并记入能力矩阵；确认档维持 UI 禁用。


## ADR-I31 · 响应解析同步点注册 turn 映射（2026-09-27，修复轮 3）

turn/start 响应行与后续通知可能同 stdout chunk 到达：await 微任务不参与行处理顺序。pending 条目增加 onResult 回调，
响应解析时**同步**固化 provider→internal 映射（先于同 chunk 通知处理）。撤销"终态认领 awaiting"——未知归属终态
（ghost turn.id）在 adapter 层不带内部 turnId、worker 层记 turn.unattributedTerminal 审计且不终结当前轮。
mock 回放必须使用真实协议形状（turn/started|completed 无顶层 turnId，provider ID 只在 turn.id），不得为测试便利加伪字段。

## ADR-I32 · 锁身份写入窗口（2026-09-27，修复轮 3）

claim mkdir 与 claimer.json 写入之间存在窗口：身份缺失/半写入 ≠ 持有者已死。规则：目录 mtime 在 identityGraceMs
（默认 2s）内 → 保守 BUSY（不清理不接管）；超宽限仍无有效身份 → 按崩溃清理（rm 竞态由 mkdir claim 原子性兜底）。
owner.json 半写入同规则。测试同步点 onBeforeClaimIdentity 置于身份写入前，验证窗口内无双持有。

## ADR-I33 · B6 证据绑定与确认档语义（2026-09-27，修复轮 3）

沙箱认证证据必须绑定到具体写入工具：tool.started 的 toolName+argumentsSummary（fileChange=changes[].path，
commandExecution=command）含目标路径；同 toolCallId 配对 tool.completed outcome=failure 且 resultRef 带
status:declined|failed（权限拒绝原因）。unknown/语法错误/任意工具失败/口头拒绝不构成证据。确认档正确语义为
read-only+on-request（workspace-write 内的写入被沙箱自动放行，不触发审批）；审批桥 deny 路径已真实验证。


## ADR-I34 · 锁未知身份保守化（2026-09-27，修复轮 4）

owner/claim 身份缺失、半写入、stat/read 失败一律 BUSY（人工核对），不以任何宽限后的自动清理替代互斥——
身份不可读不证明持有者死亡。已确认死亡（身份可读且 pid 死）才接管；claim/死 claim 归档一律原子 rename +
归档内容代次校验（与所确认 pid 不符→还原+放弃），绝不 rmSync 他人 claim。

## ADR-I35 · B6 可辨识拒绝原因（2026-09-27，修复轮 4）

权限拒绝证据 = status:declined（审批/沙箱明确拒绝）或 status:failed;exit:N;sandbox-denial
（aggregatedOutput 命中沙箱/权限签名）。纯 failed（语法错误等）/unknown/无关工具/错路径/口头拒绝不构成
认证证据（共享 verifySandboxRejectionEvidence + 负例回放）。fileChange 直接编辑路径在 read-only+never 下
无可观测工具事件——用 on-request 审批仪器化：审批请求（含目标文件清单）本身即权限门证据。

## ADR-I36 · 恢复重排全部孤儿租约（2026-09-27，DEV-07 smoke 发现）

applyRecovery 原只重排 lease_until 过期的租约——daemon 崩溃重启后未过期孤儿租约（60s）会卡住派发。
单实例锁保证旧持有者已终止，故启动恢复重排**全部** leased 为 pending 并落门禁；worker 内部的租约超时
回收逻辑不变（针对存活的并发 worker）。

## ADR-I37 · daemon 命令面形态（2026-09-27，DEV-07）

命名管道上的统一入口：信封 strict 校验→本地可信 CallerContext→runCommand 同步事务（幂等回执）→
结构化错误（不吞异常）。同步命令经 run() 包装；异步命令（task.stop 含中断回调）自包 runCommand 而不
双层包裹（曾因 async handler 传入同步事务导致 data 序列化为空——已修正并记入测试）。dispatch.resume
是恢复门禁的用户确认入口（§16.4-6 的 IPC 形态）。
