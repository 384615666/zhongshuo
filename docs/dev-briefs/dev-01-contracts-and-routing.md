# 众说 · 第一个开发包（DEV-01）：消息契约与路由

> 起草：2026-09-18；2026-09-20 同步本次私信路由与权限决定；2026-09-26 第三次修订：同步私信 1 对 1（§4.6/§0.21）、输入区默认交给 AI 与一次性「仅记录」（§4.2/§0.22）、仓库现状（已 init / 已接远端）、§31.1 MCP 五条预留条款的本包落地项。依据：[开发设计报告](../zhongshuo-development-design-v1.md)（当前 v1.23；执行时一律以报告实际最新版为准）§4（含 §4.2 默认交给 AI、§4.6 私信 1 对 1）、§8.4、§9.6、§12、§15、§20.1、§21.3、§22、§31.1。2026-09-26 第四次修订：R4/MCP-BASE/C8 已由 [开工契约](../development-baseline-v1.23.md) 与 [分批表](../development-delivery-matrix-v1.23.md) 收口，本包按该增量执行；不把文档通过当作正式工程代码完成。
> 执行者：AI 编码会话。用户是产品经理，不写代码；技术选型已由用户全权授权（见"已定工程决策"）。
> 大白话定位：这个包做的是"消息长什么样、发给谁"的规则层——定义数据格式（契约）、三种协作模式的判定、一次性「仅记录」意图、私信 1 对 1 投递与回复去向（路由）。全部是纯逻辑 + 自动化测试，不碰界面、不碰数据库、不碰真实 AI。

## 已定工程决策（2026-09-18 用户拍板；2026-09-26 按仓库现状修订）

- 仓库（2026-09-26 更新，取代原"先按 D7 确认目录归属、前置完成后才 git init"的口径）：`D:\zhongshuo` 已于 2026-09-25 初始化 Git（分支 `main`），docs 与原型同仓管理，已有提交历史；**不得再次 git init、不得改写既有提交历史**。正式工程脚手架在仓库根与现有内容并存（见"范围 0"）。清单 D7 的收口勾选仍由清单自己维护，不因本条自动完成。
- 远端备份：GitHub 私有仓库 `384615666/zhongshuo` 已配置并完成过推送，gh 已登录，无需用户再在场登录。"只推代码，不推任何用户数据、凭据、模型 key"的口径继续有效（.gitignore 已先行：忽略 node_modules/dist/日志/archive/可再生成截图）。
- 包管理/结构：pnpm + 单仓单包；模块边界用仓库根 `src/` 下六个目录 + lint 规则约束（contracts / domain / persistence / adapter / daemon / ui，对应设计报告 §8.4 C6 口径）。正式工程与 `hifi-prototype/`（原型，自带 package.json）并存、互不依赖，不建 workspace。
- 工具链：Node 24.x（本机 24.14.0 ✓）、TypeScript（strict）、Vitest；Electron、better-sqlite3、Playwright 等在用到它们的后续开发包时锁定版本。
- 开工条件（2026-09-26 更新，取代原第十批"确认之前不写 DEV-01、不 git init、不碰界面代码"）：原型（hifi-prototype/）已经多批次施工并经用户逐轮确认，验证状态见其 README；仓库亦已初始化——门槛的历史条件已被实际进展超越。**本包及后续后端包写代码的开工条件改为**：清单设计前置完成（R4 与 C8 本轮已设计收口）且收到正式工程实施指令。修订本任务书本身不属于开工。

## 总纲（设计报告 §22.1 模板，版本以主方案为准）

> 为"众说"创建 Windows 本地桌面原型，遵循本报告最新版（当前 v1.23；此处的版本号随报告更新，执行时一律以报告实际最新版为准）。采用独立 contracts、domain、persistence、adapter、daemon 和 UI 边界。实现打开本地目录、默认房间、主对话池、原消息锚定的独立回复串、一个已配置 CLI 成员、结构化 @指定成员、真实文件分析、串内流式回复、任务停止与消息持久化。主池仅保留原消息及回复聚合，每个任务独立会话；主池和线程使用独立输入框及草稿。先用 fake adapter 验证双任务输出归属、上下文隔离、事件和状态，再接入一个经能力检测的真实 runtime。不要调用模型 API 自建执行循环。先完成路由、停止和持久化再扩展自动协作。保留用户已有文件，不安装或修改全局 CLI 配置。

本包只承担其中"契约 + 路由"的第一层落地，为后续所有包提供类型地基。

2026-09-20 补充契约：区分权限档位（plan/confirm/auto_edit/full_access）、期望策略、实际生效策略与 supported/unsupported/unverified；验证证据按 runtime/adapter 版本、平台和模式关联。定义原生确认请求/答复的 turn、请求 ID、payloadHash、有效期及允许选项，不将“参数可设置”当成功验证。计划模式与先给方案再执行分开；不在本包实现真实权限调用。

输入意图（2026-09-25 用户决定，§4.2/§0.22，**覆盖原决策 21**）：**普通发送默认与 AI 交流**——主池发送＝创建新根任务并按 @ 结构路由（AUTO/DIRECT/DELIBERATE 判定规则不变）；已有 AI 任务串内发送＝跟进当前任务，不新建根任务。**「任务/讨论」常驻切换取消**，不再是任何路由函数的输入；"只保存不派发"改为一次性显式意图「仅记录，不请求回复」（`SendIntent = 'record_only'`，是意图不是第四种 Mode）：不创建任务/运行、不调用模型、不计预算、不 steering，**正文含 @ 成员/@全体 也不唤醒**，保存后意图自动复位为默认。历史记录串（root_task_id 为空的原讨论串）内跟进默认仍是保存记录（兼容例外）。

私信路由（v1.23）：项目文件夹内一对一普通对话，采用开工契约 §2。resolveDmRoute 返回唯一对端、conversationId 与 intent，不在 UI 推导 Mode；daemon 为 default Agent 消息建立内部 dm_turn/DIRECT 执行，无房间任务号、无任务卡。record_only 只保存不派发；人类对端只投递。同对话续接、不同对话独立，执行时按对话串行。Conversation/参与者/消息/任务/运行/session 的关联与空值约束、创建和提交接口均已确定，不再留 R4 待定。

2026-09-20 第十四批契约同步（主设计 v1.12 §10.5）：Project.taskReviewEnabled 与 Task.reviewPolicy 创建时快照分开；用户任务不再按 access=modify 自动进入人工验收。新增 TaskDelivery 的版本、清单 hash 和 reviewStatus 类型，ChangeSet.applicationStatus 与验收状态分开。task.delivery.review 仅人类可提交，携带目标版本；移除新契约中的 git.reviewCommit，不将其映射为任务验收。这里只定义契约和纯逻辑，真实持久化/调度由后续包实现；原型交接见 [prototype-optional-task-review.md](./prototype-optional-task-review.md)。

2026-09-20 第十五批契约同步（主设计 v1.13 §17.7）：单个 activeProjectId、有序 visibleProjectIds 与页面查询 scope 分开；tasks.list 的项目集合仅用于人类看板聚合，不成为多项目派工范围。深链按实体 projectId 校验，不用当前焦点替换来源；成员切项目和单项目页面采用统一导航上下文，草稿与命令目标按实体绑定。原型交接见 [prototype-sidebar-project-navigation.md](./prototype-sidebar-project-navigation.md)，本包仍只定义类型与纯逻辑。

2026-09-26 补充契约（主设计 v1.19–v1.21 §31.1 五条预留条款，即时生效、与 MCP 是否落地无关；本包只落契约与纯逻辑，MCP 本体不进 v0.1）：

1. **命令可结构化调用**：按 §15.1 定义 `CommandEnvelope` / `CommandResult`（commandId、expectedRevision、IDEMPOTENCY_CONFLICT 错误码类型）；事务内去重的执行语义留给 DEV-02。
2. **调用者身份可标识**：定义服务端生成的调用上下文类型 `CallerContext`（实际调用主体、所代表用户、连接 ID、有效授权范围）；桌面 UI 与 `zs` CLI 用本地变体（无连接 ID）。契约层不接受自报 authorId 作为授权依据；"仅用户可做"按实际调用主体判断，不按消息 author_type 判断。
3. **授权范围逐次校验**：提供纯函数按「可读上下文 / 可执行操作 / 可调度成员」三维度分别判断，并定义第四维预算 BudgetGrant/Reservation（事务预占由 DEV-02/05 实现）；读不蕴含唤醒，发起不蕴含扩权。
4. **幂等可查询**：commandId 幂等键类型（同第 1 条）；本包固定按认证 scope + commandId 去重的类型与 command.result.get 契约；MCP 工具层映射在 FULL-11 实现。
5. **发言与执行分离**：路由只由结构化参数（mention 节点、SendIntent、目标）决定，正文文本不构成执行指令——§4.1/AT-09 的口径扩展到所有写入来源（含外部 AI 写入的文本）。
6. **字段预留**：`Message.via_connection_id`（author_type=human 时标记代发，author_type 不新增取值）、`Task.source_connection_id`（发起连接）；本地入口恒为 null。`external_connections` / `external_grants` 表结构、MCP 服务器本体、首批 12 工具与协议适配均不在本包（FULL-11）。

## 范围（做什么）

### 0. 工程脚手架（仓库已初始化；2026-09-26 更新）

仓库现状：`D:\zhongshuo` 已有 Git 仓库（main 分支）与远端，docs/、hifi-prototype/ 等内容受版本管理，archive/ 仅在磁盘并被忽略，.gitignore 已就位。**本节不包含任何 git init / 远端配置步骤**；不得搬移、清理既有目录，不得改动 `hifi-prototype/` 的构建与验证脚本。

本包开工时在仓库根新增正式工程脚手架：

- 根 package.json（pnpm、单仓单包）、tsconfig（strict）、Vitest 配置、eslint（六边界 import 规则）；提交 pnpm-lock。
- `src/` 六边界目录骨架（contracts / domain / persistence / adapter / daemon / ui）；本包实际只填充 contracts 与承载路由纯函数的 domain 目录，其余为带说明的空骨架。
- README 增补正式工程的安装与测试方法（根目录 `pnpm install && pnpm test`；不进入 hifi-prototype，两者各自独立 package.json）。
- 默认施工分支 codex/dev-01（或用户指定分支）；先核对已有工作树，不重写历史、不一并提交其他会话改动，推送遵循用户授权。

### 1. contracts：核心类型与 schema

以设计报告 §12.2 表结构目录为准（§12.2 为唯一权威命名，不得按旧名建类型），定义 TypeScript 类型 + 运行时校验（schema 库由执行者选定，如 zod）：

- Project、Room（含 coordinator_member_id）、AgentProfile / ProjectMember
- Conversation(room/dm)、DmParticipant、MessageTarget 判别联合、dm_turn 任务类型、DM session 作用域；会话关联及 null 约束按 v1.23 §2.2
- ConversationThread（anchor_message_id、root_task_id 可为空＝记录串；DM 无 thread、status、last_message_seq）
- Message（author_type：human / agent / system / third_party_app；thread_id 顶层为 NULL；reply_to_message_id；thread_message_seq；via_connection_id 预留字段）
- Task（root_message_id、parent_task_id、room_task_number（DM 为 null）、review_policy、source_connection_id 预留字段）
- WorkflowRun 与 Mode（AUTO / DELIBERATE / DIRECT）——**Mode 仅这三种**；`SendIntent`（'default' | 'record_only'）是发送意图，与 Mode 分开建模
- Mention（memberId 或 "all"，结构化节点）
- TaskDelivery（版本、清单 hash、reviewStatus）与 ChangeSet.applicationStatus（第十四批）
- 单 activeProjectId / 有序 visibleProjectIds 与查询 scope（第十五批）
- CommandEnvelope / CommandResult / CallerContext、BudgetGrant/Reservation、scope 幂等、command.result.get 与 targetRunId/expectedStopGeneration；四项只读查询 DTO 见 v1.23 §3.3
- DM-BASE/MCP-BASE 的契约及纯逻辑部分；需要数据库/真实进程的用例明确交接 DEV-02/05/22，不用 mock 冒充已验证
- 约定：所有 ID 为稳定随机 ID；时间为 UTC 毫秒（§12.2）

### 2. 路由纯函数（无副作用，不做任何 IO）

- `resolveTopLevelRoute`：按 §4.2 路由表逐行实现——
  普通发送（SendIntent='default'）按 @ 结构判定：无 mention → AUTO（默认协调者接单）；单个 mention → DIRECT（仅指定成员）；`@全体` → DELIBERATE（冻结名单）；多个 mention → DELIBERATE（仅所选子集）；`@全体` + 单独 mention → 以全体为准并去重。
  SendIntent='record_only'（一次性「仅记录，不请求回复」）→ 保存记录：不建任务/运行、不派发任何成员、不调用模型；**正文中的 mention 节点（含 @全体）不参与判定、零唤醒**；意图保存后自动复位（复位由调用方持久化，函数本身无状态）。
  历史记录串（root_task_id 为空）内跟进 → 默认仍是保存记录（兼容例外）。
  原"输入框切讨论档"（决策 21）已取消，**不得**把'讨论'实现为 Mode 取值或常驻切换参数。
- `resolveDmRoute`（私信 1 对 1）：输入为 conversationId 与对端成员；输出＝投递给该会话唯一成员，**不推导 Mode、不涉及协调者、无群聊冻结名单选择**；对端为 human 时派发集合为空；正文/粘贴文本中的 `@` 对结果零影响；同一成员的多条私信按 conversationId 隔离；default Agent 发送由 daemon 建内部 dm_turn，record_only 不建执行，不分配房间任务号。
- `resolveReplyTarget`：主池发送 → 创建新线程（预分配 threadId，§12.3 单事务关联）；串内跟进 → 沿用该 threadId；目标不匹配 → 返回 THREAD_SCOPE_MISMATCH，绝不兜底发到主池（§4.5）。
- `validateDispatchScope`（§31.1 第 3 条的最小落地）：对计划派发结果按「可读上下文 / 可执行操作 / 可调度成员」分别校验，读权限不蕴含唤醒。
- mention 有效性：只有输入框识别的结构化 mention 节点参与路由；代码块、Markdown 引用、文件正文、系统日志/工具输出中的 `@` 永不触发（§4.1、验收 AT-09）；该口径同样适用于外部 AI 写入的文本。
- 串内跟进：无 mention → 延续当前任务参与者与模式（steering）；点名当前参与者 → 定向提问；点名非参与者 → 产出"待用户确认的扩大参与范围"结果，不直接唤醒（决策 10）。ADR-15 任务内互唤的执行语义留给后续 daemon/domain 包，本包只提供相关类型。

### 3. 测试（Vitest，表驱动）

- §4.2 路由表逐行至少一个用例（含 @全体+单独 mention 去重；代码块内 `@` 不触发 AT-09）；
- SendIntent='record_only'：保存不派发、正文含 @全体 零唤醒、意图与 Mode 分开（类型层面不得把 record_only 当 Mode）；记录串内跟进默认保存（兼容例外）；
- 私信 1 对 1：路由结果仅含该会话成员、human 对端派发集合为空、正文 @ 文本零影响、同成员多私信按 conversationId 隔离不合并、不产出房间任务号，record_only 不建执行；
- 回复目标绑定：主池新线程 / 串内沿用 / 目标不匹配三分支；
- MCP 预留契约：CommandEnvelope/CommandResult/CallerContext 类型齐备、via_connection_id/source_connection_id 字段存在且本地入口为 null、validateDispatchScope 三分支（读不蕴含唤醒）、契约层不接受自报 authorId、预算不足拒派发、旧 stop 目标不匹配拒绝影响新 run；
- 幂等键（commandId）类型定义存在，执行语义留给 DEV-02。

## 非目标（本包不做）

界面（hifi-prototype/ 原型另行推进，本包不碰界面代码；开工条件见"已定工程决策"）、SQLite migration 与仓储（DEV-02）、fake adapter（DEV-03）、daemon 与进程管理（DEV-05）、真实 runtime 接入、任何模型 API 调用、自动分工逻辑（DEV-11）、MCP 服务本体与协议适配（`zs mcp` 桥接、Streamable HTTP、external_connections/external_grants、首批 12 工具——全部属 FULL-11，不进 v0.1）。

## 完成定义

1. 根目录 `pnpm install && pnpm test` 一条命令全绿；依赖版本锁定并提交锁文件；不改动 `hifi-prototype/` 与 `docs/` 下任何文件（根配置与 `src/` 除外）。
2. 三种协作模式、一次性「仅记录」意图、私信 1 对 1 路由的类型和判定函数齐备，路由表全覆盖测试。
3. 回复目标解析含 THREAD_SCOPE_MISMATCH 分支且有测试。
4. 本包新增 contracts/domain 不含网络或模型调用，不以整个既有原型仓库作为该断言范围。
5. README 写明：运行方法、六个目录边界的含义、本包对应设计报告的章节索引。
6. §31.1 五条预留条款的本包落地项齐备：CommandEnvelope/CommandResult/CallerContext、via_connection_id/source_connection_id 预留字段、validateDispatchScope 与预算/目标纯校验、command.result.get 和四项查询 DTO、DM 目标判别，均有测试。

## 给产品经理的验收大白话

以下规则各对应一组自动化测试，跑绿即算数：

- 输入"@张三 看看这个文件夹" → 判定为"指定成员模式"，只有张三会被唤起，其他成员零调用；
- 输入"@全体 分析一下" → 判定为"全员研讨"，所有回复都挂在同一条任务串下，主池不出现散落的 AI 长回复；
- 消息正文代码块里出现的"@全体"只是普通文字，不会误触发任何调度；
- 选了「仅记录，不请求回复」再发一条正文带"@全体"的消息 → 只是保存了一条记录，没有任何成员被唤醒、没有任务和预算产生；
- 给某位成员发私信 → 只有这位成员收到；正文里粘贴的"@全体"也只是文字；同一条对话里的后续消息沿用上下文；与同一成员另建的对话按 conversationId 独立。
