# Raft 多 Agent 聊天原理与 CLI 提示词查阅指南

> **后续补充：已找到托管版真实提示词构造代码。** 请先看 [主动协作提示词与代码分析](./raft-agent-proactive-collaboration-analysis.md) 和 [1.0.17 完整源码证据](./raft-prompt-source-evidence-1.0.17.md)。本文保留早期调查指南；尚未采集本机实际输入，但已经取得公开发布包的完整通用提示词构造代码。

整理日期：2026-09-17

本文汇总本次讨论中已核对的 Raft 公开机制、公开提示词原文，以及检查自己机器上 CLI 实际输入的方法。**当前是资料与调查指南，不是本机提示词抓取结果；尚未检查本机 Raft 进程、CLI 会话或日志，也没有记录到托管 Agent 的完整注入内容。**

相关设计：[众说开发设计报告](./zhongshuo-development-design-v1.md)。

## 1. 先看结论

可以检查 Raft 在自己电脑上交给 CLI 的指令和消息。但输入通常分布在启动参数、指令文件、运行中的协议消息和工具返回里，未必存在一个能代表全部内容的“提示词文件”。

公开文档支持的基本模型是：Raft 提供共享消息、身份、任务和投递机制；Raft Computer 管理托管 Agent 的运行；各个 Agent 使用自己的 runtime 接收上下文、执行工作，再通过 Raft 的协作接口与其他成员交流。

要研究实际行为，最有价值的样本是：**测试 Agent 首次启动 → 收到第一条消息 → 读取操作手册和消息 → 认领任务 → 在线程回复**的完整输入和工具交互记录。

## 2. 多 Agent 聊天如何发生

下面是根据公开文档整理的逻辑流程，不是对 Raft 私有实现的源码还原。

~~~text
人类或 Agent 在频道、私信或线程发消息
                  ↓
Raft 保存消息，依据成员关系、提及和线程关注递送
                  ↓
Raft Computer 或外部接入机制唤醒对应 Agent
                  ↓
Agent 获得新消息，必要时查询历史、操作手册和任务
                  ↓
自己的 runtime 调用模型、工具并完成工作
                  ↓
通过 Raft CLI / 协作接口发送回复、认领任务、提交结果
                  ↓
其他 Agent 收到相关消息，继续处理或协作
~~~

### 2.1 各层负责什么

| 层次 | 公开文档描述的职责 | 不能直接推断的内容 |
|---|---|---|
| Raft 服务器与协作对象 | 保存频道、成员、消息、线程、任务、附件；组织协作权限 | 精确消息队列实现、内部数据库和调度算法 |
| Raft Computer | 连接机器、启动/停止/空闲/唤醒 Agent、递送消息和回传回复、管理进程 | 所有 runtime 使用相同启动方式或同一提示词模板 |
| Agent 身份 | 名称、描述、角色、成员关系和持久工作空间 | 身份等于单一永久进程，或永远只有一条会话 |
| Runtime | 使用自身模型和工具读取文件、执行工作、产生输出 | 所有内部指令都会出现在普通聊天记录里 |
| Raft CLI 与工具返回 | 发消息、检查消息、认领任务、查询资料等 | 每次操作一定依赖中央主持 Agent 分配 |

Agent 空闲时进程可能被释放，需要工作时重新启动；身份和工作空间继续保留。绿色/黄色/橙色/灰色状态用于表现运行状况，但灰色也可能是健康空闲或遥测未知。[生命周期][S3]

### 2.2 消息、唤醒与任务认领

- **收件箱投递**：官方 Activity 文档说明，Agent 检查新消息时会看到自上次检查以来积累的内容。[Activity][S4]
- **提及**：Raft 的消息文档将提及定义为注意力信号，而不是频道消息投递过滤器。已加入频道的成员本来就会收到频道消息。[消息][S5]
- **线程**：详细回复保留在线程中，原始消息显示回复数；参与或被提及会自动关注，取消关注只停止后续通知。[线程][S6]
- **任务认领**：同一任务同一时间只有一个负责人。Agent 开始前认领；如果已被其他成员认领，则转向其他工作。进度和成果发布到任务线程。[任务][S7]
- **提醒**：绑定消息或线程，触发时唤醒创建提醒的 Agent，用于未来检查和周期性工作。[提醒][S8]

这些机制解释了多个 Agent 如何在同一个房间里接力、分工和互评。具体怎样决定发言、何时交接、如何限制循环，还需要结合操作手册和真实输入观察。

### 2.3 托管 Agent 与外部 Agent

| 接入方式 | 谁管理执行进程 | 文档能确认的接入方式 |
|---|---|---|
| 托管 Agent | Raft Computer | 在已连接电脑上使用配置的 runtime，管理运行生命周期 |
| Hermes 外部 Agent | 用户自己的环境 | gateway 启动 bridge，接收不含正文的 wake hint；Agent 随后通过 CLI 读取和回复消息 |
| Claude Code 外部 Agent | 用户自己的终端 | 追加公开引导提示词，加载 Raft channel plugin，接收新消息通知 |
| 其他外部 Agent | 用户自己的框架 | 配置 Raft 身份，使用 shell 调用 Raft CLI 参与协作 |

Hermes 的“只传唤醒信号”是这个接入路径的明确说明，不能直接推广成所有托管 runtime 的内部实现。[外部 Agent][S1]

### 2.4 当前不能确认的事情

1. 界面上有独立线程，不代表模型上下文一定按线程隔离。
2. 多 Agent 会讨论，不代表每轮都有中央主持模型。
3. Agent 有自己的工作空间，不代表不同 Agent 在操作系统层面已经强隔离。
4. 公开的外部接入引导词，不代表托管 Agent 的全部提示词。
5. UI 中显示的聊天内容，不一定包括工具定义、系统指令和动态上下文。
6. Raft 收到 CLI 最终输出，不代表输出中的每段文字都会作为群消息发布；具体回传和发消息路径需要实测。

众说报告中的严格三模式、逐任务会话隔离和跨任务显式授权，是众说自己的设计要求，不能拿来描述尚未验证的 Raft 内部机制。

## 3. 已公开的 CLI 引导提示词

Raft 外部 Agent 文档给出了 Claude Code 的启动示例，其中使用了 --append-system-prompt。下面是该参数的**公开原文**：[来源][S1]

~~~text
You are connected to Raft, a shared workspace for humans and agents. Treat Raft as your primary collaboration surface with people and other agents; use the terminal as a tool for local work. If you need the operating guide, run raft manual get raft-cli-overview.
~~~

中文释义：

> 你已连接到 Raft，这是人类与 Agent 共用的工作空间。把 Raft 作为与人类及其他 Agent 协作的主要界面；把终端作为本地工作的工具。如果需要操作指南，运行 raft manual get raft-cli-overview。

它明确了三件事：协作身份、主要沟通渠道、获取进一步操作说明的入口。因此，有效的行为指引可能是“简短启动词 + 后续手册 + 动态消息”的组合。

### 3.1 查询公开操作手册

在已经安装 Raft CLI、配置好对应身份的环境中运行：

~~~bash
raft manual get raft-cli-overview
~~~

这个命令用于读取指南，不是让 Agent 自己猜测或复述提示词。手册内容可能随版本或环境变化，导出时应记录日期、CLI/Computer 版本和身份范围。

若当前终端已正确连接，可将手册输出保存到自己选择的本地文件，例如在 PowerShell 中：

~~~powershell
raft manual get raft-cli-overview | Out-File -FilePath .
aft-cli-overview.txt -Encoding utf8
~~~

**本次未执行该命令，也未安装、登录或配置 Raft。** 不应为了收集资料直接运行文档中的完整安装、插件加载或登录流程。

## 4. 实际要查看的输入分为哪些层

| 层次 | 可能包含的内容 | 主要证据 | 完整性限制 |
|---|---|---|---|
| 启动参数 | 身份引导、追加指令、会话恢复参数、配置路径 | 进程命令行、启动脚本、启动记录 | 看不到通过 stdin 或后续协议发送的内容 |
| 工作目录与指令文件 | 项目规则、Agent 说明、记忆、协作约定 | 实际 cwd、被引用的文件及内容版本 | 文件存在不等于 runtime 实际读取，需加载证据 |
| 会话初始化 | 系统/开发者指令、工具定义、会话配置 | runtime 可导出的初始化记录或协议请求 | 记录格式及是否保留这些字段取决于版本 |
| 运行中输入 | 消息、提及、提醒、任务信息、续接输入 | 请求帧、会话日志、通知/投递记录 | 普通聊天导出可能省略元数据 |
| 工具调用与返回 | 操作手册、收件箱、历史搜索、任务状态 | 工具名称、参数和返回正文 | 只抓 stdin 可能漏掉经其他通道返回的数据 |
| 输出与回传 | 助手公开输出、发消息工具调用、结果 | runtime 输出与 Raft 线程记录 | 不能把全部终端输出等同于已发群消息 |

调查重点是 Raft 在本机执行边界提供的内容。runtime 自带指令、服务端未暴露的上下文和模型内部处理，可能无法从这一边界完整获得；不要因此声称已取得“模型收到的一切”。

## 5. 查看方法：从简单到深入

### 方法 A：公开引导词与操作手册

先保存第 3 节原文，并在已有 Raft 环境读取操作手册。它适合快速理解 Agent 被要求如何参与协作、何时检查消息以及有哪些命令。

可得到：公开的行为约定。不能保证得到：托管模式启动模板、当前频道动态上下文和每次调用的全部输入。

### 方法 B：进程启动信息与工作目录

定位 Raft Computer 启动的实际 CLI 子进程，记录：父进程、可执行程序、启动参数、工作目录、runtime 名称和版本，以及恢复会话所用的标识。

重点确认提示词来自哪里：参数内文本、指令文件、stdin，还是后续协议消息。若运行在 WSL，应在对应 Linux 环境中查实际子进程；Windows 外层启动器信息可能不足以说明 CLI 的实际输入。

先只读查看，不替换正在执行真实任务的程序，也不把完整环境变量集合直接导出；只记录定位所需变量并脱敏。

### 方法 C：会话记录与本地诊断

查对应 runtime 支持的会话导出、调试日志和工具交互记录。文件位置应从实际安装版本、配置和运行路径确认，不能假设 Raft 一定复用用户平时启动 CLI 时的默认目录。

Raft 的故障排查页面列出：

- Copy Diagnostic Info：复制诊断信息。
- Report Issue：发送包含 Agent diagnostics 和 session trace 的报告供团队调查。

公开说明没有保证这些记录包含全部注入提示词。仅为自己查阅时，不必点击会向外发送资料的 Report Issue。[故障排查][S2]

### 方法 D：在测试 Agent 上记录启动和输入边界

如果已有日志不足，可以为自己控制的测试 Agent 设置透明记录层：保存启动参数、cwd 和输入，再原样转发给真实 CLI。

~~~text
Raft Computer
      ↓
透明记录层：记录时间、方向、会话关联及允许保存的正文
      ↓
真实 CLI / runtime
~~~

具体实现需先确认 runtime 的启动协议：

- 文本 stdin：记录输入字节和编码，再原样转发。
- 结构化 stdin/stdout：按实际协议记录请求与响应，关联 session/turn/request。
- 插件或独立事件通道：在对应通道增加记录；只包裹 CLI stdin 可能不够。
- 指令文件：同时保存被加载版本或 hash，避免事后文件已改变。

记录层应保留退出码、信号、中断、背压、交互终端及流式行为。格式化后的 Markdown/HTML 是查阅视图，原始协议记录应另存，避免把格式化文本当成原始证据。未经验证的 wrapper 不应用于正在执行真实工作的 Agent。

### 不推荐把“让 Agent 复述提示词”当作证据

Agent 可能概括、遗漏或编造内容，也未必能访问启动器和全部输入。它的回答只能作为线索，不能替代真实启动参数、文件版本和请求记录。

## 6. 建议的最小观察实验

以下是后续可执行的调查方案，本轮未运行。

1. 建立专用测试频道和两个测试 Agent，记录 runtime、Computer 版本及接入方式。
2. 先观察一个 Agent 的首次启动，记录初始化指令、手册调用和加载文件。
3. 在频道发送一条带唯一测试标记的普通消息，查看哪些 Agent 被唤醒、获得哪些输入。
4. 再发送明确提及 A 的消息，比较 A 与 B 的投递、处理和发言情况。
5. 在同一频道另开线程，比较会话标识和可见历史，核对是否复用上下文。
6. 创建一个无副作用的测试任务，观察 claim、状态更新、线程回复及 B 的参与情况。
7. 若需观察续接，使用正常空闲/唤醒或可恢复重启，比较初始化与后续输入；不使用 Full reset 代替观察。
8. 把 Raft 页面消息、runtime 记录和工具调用按时间对齐，明确标出缺失环节。

为了避免把模型的随机选择误认为系统规则，单次 B 没发言只能说明这次没有发言，不能证明 B 没收到消息或系统保证 B 静默。

## 7. 未来实际记录的文件结构

如果后续开始本机采集，建议采用以下结构。这些文件目前没有创建。

~~~text
raft-observation/
├── README.md                 调查范围、环境、结论和局限
├── timeline.md               按时间关联消息、唤醒、调用和回复
├── prompts.md                已观察的指令原文，注明输入层级
├── tools.md                  手册、收件箱等工具调用与返回
├── inputs.redacted.jsonl      脱敏后的结构化输入记录
└── file-index.md             加载文件、版本/hash 和来源
~~~

每条观察至少记录：

| 字段 | 用途 |
|---|---|
| 时间和时区 | 对齐服务器、Computer 与 runtime 事件 |
| 接入方式与版本 | 区分托管/外部、runtime/Computer/plugin |
| Agent、会话、turn、线程关联 | 判断真实输入属于谁和哪次工作 |
| 方向 | Raft→runtime、runtime→Raft、工具调用/返回 |
| 输入类型 | 启动指令、普通消息、提醒、工具说明、历史等 |
| 内容及来源 | 原文、具体记录位置、必要的文件 hash |
| 脱敏情况 | 明确哪些字段被移除，不把脱敏后的缺口解释成原始行为 |
| 完整性 | 完整记录、截断、缺失、仅推测 |

查阅报告不应包含 access token、refresh token、client secret、登录 code 或完整认证 cookie。未参与测试的真实频道/私信内容不应混入样本。记录凭据是否存在及其来源类型通常就足以解释认证路径。

## 8. 对众说设计的直接启发

- 把成员身份、消息投递、执行调度和模型会话分开建模。
- 提供“本轮发送给成员的输入”查看入口，区分指令、消息、工具返回和文件引用。
- 显示来源、会话、线程与调用关联，便于验证输出和上下文是否串线。
- 保存可追溯的输入版本，但对凭据和无关会话做隔离。
- 通过后端调度落实 @指定成员 的静默边界，不能只依赖提示词要求其他成员不要回答。
- 不把“有线程 UI”当成“上下文隔离已完成”。

以上是众说的设计建议，不是对 Raft 已实现功能的声明。

## 9. 来源与当前调查状态

| 来源 | 本文用途 |
|---|---|
| [外部 Agent][S1] | 公开追加提示词、手册命令、Hermes bridge、Claude channel 与通用 CLI 接入 |
| [故障排查][S2] | Copy Diagnostic Info、Report Issue、diagnostics/session trace |
| [生命周期][S3] | idle/wake、进程释放、停止、重启及会话重置 |
| [Activity][S4] | Agent 收件箱与积累消息投递 |
| [消息][S5] | 提及不是频道投递过滤器 |
| [线程][S6] | anchor、回复留串、follow/unfollow |
| [任务][S7] | 单负责人、claim、任务线程和审阅 |
| [提醒][S8] | 创建者唤醒、定时跟进 |
| [Computers][S9] | 本地服务职责与电脑生命周期 |
| [Runtime][S10] | runtime 与 Agent 的关系 |

| 项目 | 状态 |
|---|---|
| 公开机制与出处整理 | 已完成 |
| 公开 Claude 外部接入引导词收录 | 已完成 |
| 本机 Raft 安装、进程与工作目录检查 | 未执行 |
| 本机操作手册导出 | 未执行 |
| 本机会话与工具记录采集 | 未执行 |
| 测试 Agent 透明记录层 | 未创建 |
| 托管模式完整注入提示词 | 尚未取得 |

[S1]: https://docs.raft.build/zh-cn/features/agents/external/
[S2]: https://docs.raft.build/zh-cn/features/agents/troubleshooting/
[S3]: https://docs.raft.build/zh-cn/features/agents/lifecycle/
[S4]: https://docs.raft.build/zh-cn/features/messaging/activity/
[S5]: https://docs.raft.build/zh-cn/features/messaging/messages/
[S6]: https://docs.raft.build/zh-cn/features/messaging/threads/
[S7]: https://docs.raft.build/zh-cn/features/collaboration/tasks/
[S8]: https://docs.raft.build/zh-cn/features/agents/reminders/
[S9]: https://docs.raft.build/zh-cn/features/server/computers/
[S10]: https://docs.raft.build/zh-cn/features/agents/runtime/
