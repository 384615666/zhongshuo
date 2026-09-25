# Raft 为什么会主动找其他 Agent：提示词与代码分析

核对日期：2026-09-17。证据来自公开发布包 @botiverse/raft-daemon@1.0.17（本次 npm latest）和公开 raft-external-agents 插件。已校验 daemon 压缩包与 npm SHA-512 integrity 一致；静态读取，未安装或执行包代码，未向频道发送消息。

**这次找到了托管 Agent 的实际提示词构造代码，不再只是产品文档推测。** 未检查你本机的版本、角色、MEMORY.md 或实际运行请求，不能断言你收到的内容逐字相同。

[完整提示词源码与原文证据](./raft-prompt-source-evidence-1.0.17.md) · [原查阅指南](./raft-multi-agent-mechanism-and-cli-prompts.md)

## 1. 核心回答

Raft 给 Agent 注入团队协作常驻指令：发现同伴、了解各自专长、把审阅和跟进交给队友、拆分可并行任务、停止前完成阻塞他人的交接，并通过 raft message send 发到频道、线程或私信。

语言模型基于任务、这些规则和团队记忆，决定此刻是否找另一位成员；CLI 把决定变成真实消息；投递与唤醒让对方获得处理机会。对方有同类规则，因此会接手、提问或回传。

“主动”包含两个层面：模型正在运行时选择联系谁；消息或提醒再让接收方获得下一轮运行机会。提示词本身不能在没有进程、没有事件时凭空执行。

在已检查的通用模板中，没有发现“每次必须找另一位 Agent 聊几轮”的规则；相反，规则强调具体交接与可执行内容，并限制无意义闲聊。

## 2. 直接驱动主动协作的真实原文

以下来自包内 package/dist/chunk-NIGZD5D2.js。行号是该 bundle 的行号；英文为模板片段原文（解码转义），中文为解释。

### 2.1 发现同事：buildDiscoverySection，第 7763 行

> Call `raft server info` to see all channels in this server, which ones you have joined, other agents, and humans.

让 Agent 查到服务器成员与频道。这是“知道找谁”的发现入口。

### 2.2 把审阅和跟进交给队友：buildMentionsSection，第 7845 行

> Mention others, not yourself — assign reviews and follow-ups to teammates.

这是最直接的行为要求：提及别人，把审阅和跟进交给同伴。同段说明用成员唯一 name 作为 @ 标识。

### 2.3 停止前检查是否还欠别人交接：buildConversationEtiquetteSection，第 7869 行

> **Before stopping, check for concrete blockers you own.** If you still owe a specific handoff, review, decision, or reply that is currently blocking a specific person, send one minimal actionable message to that person or channel before stopping.

意思是：如果你还欠某个人交接、审阅、决定或回复，正在阻塞对方，本轮停止前先给那个人或频道发一条最小但可执行的消息。这解释了为什么自己的文件工作完成后，它还会主动找下一位成员。

### 2.4 按专长认领并行工作：buildSplittingTasksSection，第 7835 行

> When you need to break down a large task into subtasks, structure them so agents can work **in parallel**:

> When you receive a notification about new tasks, check the task board and claim tasks relevant to your skills.

一个 Agent 拆分可并行任务，其他 Agent 看到通知后按技能认领。协作还可以通过任务看板启动，不一定先发私信。

### 2.5 记住同伴：buildWorkspaceAndMemorySection

> **Other agents** — What other agents do, their specialties, collaboration patterns, how to work with them effectively.

提示词要求记住别人负责什么、擅长什么、如何有效合作。以后选择联系谁，可能来自持久团队记忆。

### 2.6 真实消息必须由工具发送：buildPrompt，第 8033 行

> Always communicate through `raft` CLI commands. This is your only output channel: text you produce outside a `raft` command is not delivered to anyone.

模型文本与群消息之间存在明确工具动作。只在终端里写“我去问 Bob”，不会自动通知 Bob。

## 3. A 怎样真正找 B 对话

buildSendingMessagesSection（第 7688 行）教频道、线程、DM 回复，以及 Start a NEW DM。最新版对 PowerShell 与 Bash 提供不同语法。

以下是基于真实命令契约编写的解释示例，**不是抓取的真实聊天，也没有执行**。Bob 和消息短 ID 都须替换为有权限的真实目标。

~~~powershell
@'
@bob 我完成了登录模块修改，请检查异常处理和回归风险。
重点看 token 失效与刷新失败两条路径，结果回复本线程。
'@ | raft message send --target "#engineering:a1b2c3d4"
~~~

发起新私信的目标写法为 `raft message send --target dm:@bob`，正文同样通过 stdin 传入。

模板还要求：

> To reply to any message, always reuse the exact `target` from the received message.

所以 Agent 不只被鼓励交流，还被教了如何找到人、如何发出去、如何保证回到原线程。

## 4. 从主动请求到对方回应

~~~text
用户给 A 目标
  → A 读取常驻指令、本轮消息和必要记忆
  → A 判断需要 B 的审阅、信息或交接
  → A 调用 message send（@B / dm:@B）或创建新子任务
  → Raft 根据目标和权限投递
  → B 收到消息、唤醒或收件箱更新
  → B 获取正文，判断是否需要自己处理
  → 需要执行工作时认领相应任务，在原串/DM 回复
  → A 获得结果，继续工作或交接
~~~

A 不必直接控制 B 的模型进程；它向协作系统提交消息/任务，B 在自己的运行环境处理。仅凭客户端代码仍不能证明服务器没有额外调度或节流。

托管版 startupSteps 明确写：

> When you receive a message, process it and reply with `raft message send`.

忙碌时可先收到不含正文的收件箱更新，在自然停顿点用 message check/read 获取内容；唤醒已写入不代表模型已读完正文。

公开外部 Claude 插件的 channelBatchContent 会输出：

> If you have not read the Raft manual in this Claude Code session, run `raft manual get raft-cli-overview` before using Raft commands.

> Run `raft message check` to pull the pending message.

插件通过 notifications/claude/channel 注入这段通知。外部短引导、操作手册和托管完整模板应分别理解。

## 5. 如何避免无休止互聊

同一模板包含以下原文：

> **Respect ongoing conversations.** If a human is having a back-and-forth with another person (human or agent) on a topic, their follow-up messages are directed at that person — only join if you are explicitly @mentioned or clearly addressed.

> **Only the person doing the work should report on it.** If someone else completed a task or submitted a PR, don't echo or summarize their work — let them respond to questions about it.

> **Skip idle narration.** Only send messages when you have actionable content — avoid broadcasting that you are waiting or idle.

加上任务认领、无工作停止、提醒代替长时间等待，意图是围绕真实交接推进。提示词不能保证所有模型绝不循环；系统级限制和实际效果还需测试。

## 6. 真实注入路径

以下是 Raft 1.0.17 自己的 driver 代码行为，不是对所有 CLI 版本的通用承诺。

| Runtime | 代码证据 | 含义 |
|---|---|---|
| Claude 托管 | claude-system-prompt.md；--append-system-prompt-file，bundle 第 11785、11845 行附近 | standingPrompt 写入文件再通过启动参数追加，动态输入另走结构化 stdin |
| Codex 托管 | developerInstructions: ctx.standingPrompt，第 13886 行附近 | Raft 构造 thread/start 或 thread/resume 参数传入，不要求生成 AGENTS.md |
| Claude 外部插件 | SessionStart hook 的 additionalContext | 注入简短 orientation；唤醒时提示读手册与收件箱，与托管模式不同 |

buildPrompt 与 buildSlockCliGuideSections 组装身份、运行环境、CLI 使用、关键规则、启动顺序、消息格式、任务、提及、礼仪、记忆、runtime 说明和角色描述。源码末尾还有：

~~~text
## Initial role
${config.description}. This may evolve.
~~~

因此某个 Agent 特别爱组织别人，除了通用模板，还可能由它的 description、MEMORY.md、团队引导消息和本次任务决定。这些动态数据尚未从你机器采集。

## 7. 证据范围与版本

- 已取得：daemon 1.0.17 通用提示词构造代码、协作指南、主动联系同伴的英文规则、Raft driver 注入位置、外部插件唤醒文本。
- 未取得：你当前运行的实际版本、展开后请求、角色和记忆、私有服务器端完整调度实现、当前账号操作手册返回。
- 最初从 raft-computer@0.0.70 的依赖取得 daemon@0.66.0，随后发现 daemon latest 为 1.0.17，已以新版重新核对。两版都包含上述主动交接核心规则；不能因此推定你安装了哪个版本。
- 模板关于“提及仅频道内触达”的说明与部分产品文档关于公开频道提及未加入成员有差异，实际触达范围仍应按运行版本验证。

对众说的启发是：主动协作需要成员发现、行为规则、真实通信工具、投递/唤醒、任务状态和持久团队记忆共同配合。不能只复制一句“你们互相讨论”。众说自己的 DIRECT 禁止委派、AUTO 分工与 DELIBERATE 研讨边界仍须由后端落实。

## 8. 可核验来源

- [daemon 1.0.17 npm 元数据](https://registry.npmjs.org/@botiverse%2fraft-daemon/1.0.17)
- [原始发布包](https://registry.npmjs.org/@botiverse/raft-daemon/-/raft-daemon-1.0.17.tgz)
- [完整源码与原文证据](./raft-prompt-source-evidence-1.0.17.md)，内含包校验值、原始行号、完整 raftCliGuide/systemPrompt 模块和外部插件固定 commit。

原查阅指南解释的是怎么调查；本文补上了实际找到的协作规则。若要解释某次具体行为，下一步仍需对照你的实际 Agent 配置与输入。
## 10. 1.0.32 与 1.0.31 的直接对比

本节基于 CDN manifest 和 1.0.32 Windows x64 自包含二进制的静态检查。二进制按 manifest 下载 gzip、解压并计算 SHA-256，没有执行。

| 项目 | 1.0.31 | 1.0.32 | 结论 |
|---|---:|---:|---|
| Windows x64 大小 | 130,314,752 | 130,405,888 | 增加 91,136 字节 |
| Windows x64 SHA-256 | 49783912d979fac5f70a3995b9efcb1cf0769456f6dbb0984a9e82fcd27d1334 | e1b37c146630baef6a3b251594e7d2cd4978c34e682a429104b04c543d203524 | 二进制已变化 |
| Node runtime | 24.15.0 | 24.15.0 | 未变 |
| photon WASM | 1,881,634 字节 | 1,881,634 字节 | SHA-256 相同 |
| 当前 Hands main | — | 1.0.32 | 安装器默认会选 1.0.32 |

1.0.32 Windows x64 gzip SHA-256 为 d519c0a43856fba807a6d025e77de0c138008bc9b5a2a5157872d490f478cc57。解压后二进制 SHA-256 与 manifest 的 e1b37c... 一致。

### 10.1 协作提示词仍然存在

在 1.0.32 Windows x64 二进制中仍能找到这些模板原文或符号：

- Mention others, not yourself — assign reviews and follow-ups to teammates.
- Before stopping, check for concrete blockers you own.
- Other agents — What other agents do, their specialties, collaboration patterns, how to work with them effectively.
- raft message send、raft task claim、buildPrompt、buildCommunicationSection。

因此 1.0.32 仍保留按专长找同伴、安排审阅/跟进、停止前处理阻塞交接的核心机制。

### 10.2 1.0.32 可见的提示词变化

与此前公开 npm daemon 1.0.17 的模板相比，1.0.32 自包含包可见这些变化：

- runtime 上下文加入 Agent Role，并明确这是 Raft 注入的权威上下文。
- 增加 How these instructions apply，区分用户默认行为规则和服务器策略，说明 Owner/Admin 可设置或豁免服务器策略。
- 启动流程改成处理本轮输入；没有待办就停止，不需要为了等待新消息持续轮询。
- 消息 sender type 增加 third_party_app；频道、DM、线程可见性写得更明确。
- 阅读历史命令统一使用 --target；任务模板增加 closed/reopen、amend/history、确认 claim 输出为 claimed 等审计细节。
- 增加 liveConstraints 区段。

由于本次没有同时对 1.0.31 二进制做完整字符串 diff，不能把每一项精确归因到 1.0.31→1.0.32 的单一提交；可以确定 1.0.32 与 1.0.17 的模板存在这些变化，并且主动协作核心仍然在。

### 10.3 对安装命令的结论

当前 irm https://cdn.raft.build/computer/install.ps1 | iex 会通过 Hands main 解析到 1.0.32，然后安装并校验 1.0.32。要取得某个 Agent 这一次真正展开后的 prompt，仍需在隔离测试 Agent 上记录启动输入；二进制字符串只能确认模板存在和变化，不能看到具体 description、MEMORY.md、频道消息和动态上下文。