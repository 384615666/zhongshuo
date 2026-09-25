# 众说 · 第一个开发包（DEV-01）：消息契约与路由

> 起草：2026-09-18；2026-09-20 同步本次私信路由与权限决定。依据：[开发设计报告 v1.10](../zhongshuo-development-design-v1.md) §4、§8.4、§9.6、§12、§15、§20.1、§21.3、§22。清单 R4 公共会话模型等未完成项仍需补齐，本次更新不表示整个开发包已可开工。
> 执行者：AI 编码会话。用户是产品经理，不写代码；技术选型已由用户全权授权（见"已定工程决策"）。
> 大白话定位：这个包做的是"消息长什么样、发给谁"的规则层——定义数据格式（契约）和三种协作模式的判定与回复去向（路由）。全部是纯逻辑 + 自动化测试，不碰界面、不碰数据库、不碰真实 AI。

## 已定工程决策（2026-09-18 用户拍板）

- 代码仓库原定 `D:\zhongshuo`，当前已存在资料和原型；先按清单 D7 确认[目录归属](../workspace-layout-proposal.md)，不能按空目录覆盖初始化。git init、远端配置等步骤在前置完成后执行。
- 远端备份：GitHub 私有仓库，只推代码，不推任何用户数据、凭据、模型 key（.gitignore 先行）。
- 包管理/结构：pnpm + 单仓单包；模块边界用目录 + lint 规则约束（contracts / domain / persistence / adapter / daemon / ui 六个边界，对应设计报告 §8）。
- 工具链：Node 24.x（本机 24.14.0 ✓）、TypeScript（strict）、Vitest；Electron、better-sqlite3、Playwright 等在用到它们的后续开发包时锁定版本。
- 界面开发门槛（2026-09-19 第十批修订）：**简单原型由 AI 绘制，经用户一轮反馈修改并确认后开工**；确认之前不写 DEV-01、不 `git init`、不碰界面代码。本包及随后的后端包（存储、后台进程、runtime 接入）在门槛打开后按序执行，不受界面完成度阻塞。

## 总纲（设计报告 §22.1 模板，版本以主方案为准）

> 为"众说"创建 Windows 本地桌面原型，遵循本报告最新版（当前 v1.10；此处的版本号随报告更新，执行时一律以报告实际最新版为准）。采用独立 contracts、domain、persistence、adapter、daemon 和 UI 边界。实现打开本地目录、默认房间、主对话池、原消息锚定的独立回复串、一个已配置 CLI 成员、结构化 @指定成员、真实文件分析、串内流式回复、任务停止与消息持久化。主池仅保留原消息及回复聚合，每个任务独立会话；主池和线程使用独立输入框及草稿。先用 fake adapter 验证双任务输出归属、上下文隔离、事件和状态，再接入一个经能力检测的真实 runtime。不要调用模型 API 自建执行循环。先完成路由、停止和持久化再扩展自动协作。保留用户已有文件，不安装或修改全局 CLI 配置。

本包只承担其中"契约 + 路由"的第一层落地，为后续所有包提供类型地基。

2026-09-20 补充契约：区分权限档位（plan/confirm/auto_edit/full_access）、期望策略、实际生效策略与 supported/unsupported/unverified；验证证据按 runtime/adapter 版本、平台和模式关联。定义原生确认请求/答复的 turn、请求 ID、payloadHash、有效期及允许选项，不将“参数可设置”当成功验证。计划模式与先给方案再执行分开；不在本包实现真实权限调用。

私信复用同一路由纯函数，输入为私信可派发参与者与协调者，而非房间全体成员：无 @ 为 AUTO，单 @ 为 DIRECT，全体/多个 @ 为 DELIBERATE，讨论不派发。补测试证明私信外成员零派发、全体范围不扩大、无协调者明确不可派发。同一成员的不同私信不得因成员 ID 相同合并上下文；会话实体及接口在清单 R4 完成后同步本包。

2026-09-20 第十四批契约同步（主设计 v1.12 §10.5）：Project.taskReviewEnabled 与 Task.reviewPolicy 创建时快照分开；用户任务不再按 access=modify 自动进入人工验收。新增 TaskDelivery 的版本、清单 hash 和 reviewStatus 类型，ChangeSet.applicationStatus 与验收状态分开。task.delivery.review 仅人类可提交，携带目标版本；移除新契约中的 git.reviewCommit，不将其映射为任务验收。这里只定义契约和纯逻辑，真实持久化/调度由后续包实现；原型交接见 [prototype-optional-task-review.md](./prototype-optional-task-review.md)。

2026-09-20 第十五批契约同步（主设计 v1.13 §17.7）：单个 activeProjectId、有序 visibleProjectIds 与页面查询 scope 分开；tasks.list 的项目集合仅用于人类看板聚合，不成为多项目派工范围。深链按实体 projectId 校验，不用当前焦点替换来源；成员切项目和单项目页面采用统一导航上下文，草稿与命令目标按实体绑定。原型交接见 [prototype-sidebar-project-navigation.md](./prototype-sidebar-project-navigation.md)，本包仍只定义类型与纯逻辑。

## 范围（做什么）

### 0. 工程初始化（若仓库尚是空文件夹）

当前目录不满足此条件。保留现有内容，D7 确认后先检查实际文件与首批跟踪清单，再调整本节初始化步骤；本说明不授权搬移资料或删除依赖。

git init、pnpm 初始化、tsconfig（strict）、Vitest 配置、六边界目录骨架、README（安装与跑测试方法）；提交 pnpm-lock。接 GitHub 私有远端（推送需要用户在场登录一次 GitHub 账号）。

### 1. contracts：核心类型与 schema

以设计报告 §12.2 表结构目录为准，定义 TypeScript 类型 + 运行时校验（schema 库由执行者选定，如 zod）：

- Project、Room（含 coordinator_member_id）、AgentProfile / ProjectMember
- ConversationThread（anchor_message_id、root_task_id、status、last_message_seq）
- Message（author_type：human / agent / system / third_party_app；thread_id 顶层为 NULL；reply_to_message_id；thread_message_seq）
- Task（root_message_id、parent_task_id、room_task_number、review_policy）
- WorkflowRun 与 Mode（AUTO / DELIBERATE / DIRECT）、Mention（memberId 或 "all"，结构化节点）
- 约定：所有 ID 为稳定随机 ID；时间为 UTC 毫秒（§12.2）

### 2. 路由纯函数（无副作用，不做任何 IO）

- `resolveTopLevelRoute`：按 §4.2 路由表逐行实现——
  无 mention → AUTO（默认协调者接单）；单个 mention → DIRECT（仅指定成员）；`@全体` → DELIBERATE（冻结名单）；多个 mention → DELIBERATE（仅所选子集）；`@全体` + 单独 mention → 以全体为准并去重；输入框切"讨论" → 保存但不派工、不调用模型（决策 21）。
- `resolveReplyTarget`：主池发送 → 创建新线程（预分配 threadId，§12.3 单事务关联）；串内跟进 → 沿用该 threadId；目标不匹配 → 返回 THREAD_SCOPE_MISMATCH，绝不兜底发到主池（§4.5）。
- mention 有效性：只有输入框识别的结构化 mention 节点参与路由；代码块、Markdown 引用、文件正文、系统日志/工具输出中的 `@` 永不触发（§4.1、验收 AT-09）。
- 串内跟进：无 mention → 延续当前任务参与者与模式（steering）；点名当前参与者 → 定向提问；点名非参与者 → 产出"待用户确认的扩大参与范围"结果，不直接唤醒（决策 10）。ADR-15 任务内互唤的执行语义留给后续 daemon/domain 包，本包只提供相关类型。

### 3. 测试（Vitest，表驱动）

- §4.2 路由表逐行至少一个用例；
- `@全体` + 单独 mention 的去重；代码块内 `@` 不触发（AT-09）；
- 回复目标绑定：主池新线程 / 串内沿用 / 目标不匹配三分支；
- 幂等键（commandId）类型定义存在，执行语义留给 DEV-02。

## 非目标（本包不做）

界面（等简单原型经用户一轮反馈确认，见"已定工程决策"）、SQLite migration 与仓储（DEV-02）、fake adapter（DEV-03）、daemon 与进程管理（DEV-05）、真实 runtime 接入、任何模型 API 调用、自动分工逻辑（DEV-11）。

## 完成定义

1. `pnpm install && pnpm test` 一条命令全绿；依赖版本锁定并提交锁文件。
2. 三种模式与"讨论"切换的类型和判定函数齐备，路由表全覆盖测试。
3. 回复目标解析含 THREAD_SCOPE_MISMATCH 分支且有测试。
4. 仓库中无任何网络调用、无任何模型调用代码。
5. README 写明：运行方法、六个目录边界的含义、本包对应设计报告的章节索引。

## 给产品经理的验收大白话

以下三条规则各对应一组自动化测试，跑绿即算数：

- 输入"@张三 看看这个文件夹" → 判定为"指定成员模式"，只有张三会被唤起，其他成员零调用；
- 输入"@全体 分析一下" → 判定为"全员研讨"，所有回复都挂在同一条任务串下，主池不出现散落的 AI 长回复；
- 消息正文代码块里出现的"@全体"只是普通文字，不会误触发任何调度。
