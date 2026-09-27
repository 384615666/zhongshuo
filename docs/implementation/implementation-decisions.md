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
