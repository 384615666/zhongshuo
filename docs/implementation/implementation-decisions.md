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
