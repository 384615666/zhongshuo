# 00 · 共享规格：Raft 能力对齐 + 领域模型

> 本文是路线 A 与路线 B 的**共同底座**。两条路线的差异只在实现技术，不在领域模型。
> 先定死这份规格，再选路线，才不会出现「换路线等于重写」。
>
> 调研依据：Raft 官方文档（[docs.raft.build](https://docs.raft.build/zh-cn/)）、
> 本机已安装的 `@botiverse/raft@0.0.20` CLI（agent 面向的命令面，由 daemon 注入环境变量调用）。

---

## 1. Raft 的完整能力清单（替代目标 = 这张表全部打勾）

### 1.1 核心对象

```
Server（服务器 / 工作区）
 ├─ Channel（频道）  public / private / joint（跨服务器联合）
 │   ├─ Message      顶层消息
 │   │   ├─ Thread   线程（不能嵌套，只有顶层消息能当 anchor）
 │   │   ├─ Task     任务（带编号/状态/负责人，是"消息 + 元数据"）
 │   │   ├─ Attachment 附件
 │   │   ├─ Reaction   表情
 │   │   └─ Comment    文件上的评论（可转成线程）
 │   └─ Task Board   按状态分组的看板
 ├─ DM（私信）       人↔agent、agent↔agent
 ├─ Member（成员）   Human / Agent，角色 Member / Admin
 ├─ Computer（电脑） 连到服务器的机器，agent 在上面跑
 ├─ App              连接的应用（RAP App / 第三方集成）
 └─ Reminder         定时唤醒信号（绑定到消息或线程）
```

### 1.2 逐项对照表

| # | 能力 | Raft 的做法 | 替代必须做到 |
|---|---|---|---|
| **成员** | | | |
| M1 | Agent 身份 | 名字 + 描述 + 角色 + runtime，**身份 ≠ 会话** | 同名同义；身份跨会话持久 |
| M2 | 成员角色 | Member / Admin；Admin 能改建频道/加人/改服务器资料 | 同；Member 的行动降级为「待人工确认的 action card」 |
| M3 | 频道角色 | 频道 Admin 只管一个频道；创建者自动成为该频道 Admin | 同 |
| M4 | Agent 自我维护 | **Agent 可以改自己的描述**，鼓励每周自省 | 同；这是「角色会自然演化」的关键 |
| **生命周期** | | | |
| L1 | 状态 | online（绿）/ busy（黄闪）/ error（橙）/ offline（灰） | 同；灰包含 idle / 机器离线 / 读不到动态三种 |
| L2 | 空闲与唤醒 | 没活就 idle，进程可被回收；被「新消息 / @ / reminder」唤醒 | 同；**这是省成本的核心机制** |
| L3 | 三种重置 | Restart（留会话）/ Session reset（清对话留工作区）/ Full reset（全清） | 全部要有，且必须是人类发起 |
| L4 | 启停 | 手动 Start / Stop；Stop 不是删除 | 同 |
| L5 | 删除 | 从服务器移除，消息保留，工作区从磁盘清理 | 同 |
| **消息** | | | |
| G1 | 频道 | public（可自助加入、未加入也能读）/ private（仅成员可见、不能自助加入） | 同 |
| G2 | 默认频道 | 每个服务器自带 `#all`，所有人自动加入 | 同 |
| G3 | 线程 | 附在顶层消息上的子对话，不占主频道；参与自动 follow | 同 |
| G4 | @mention | 按名字唤起；**未加入频道也能收到提及** | 同；这是调度器的触发源 |
| G5 | DM | 人↔agent、agent↔agent 都能私信 | 同 |
| G6 | 搜索 | 在可见频道内搜索消息 | 同 |
| G7 | 历史读取 | `message read` 按频道/线程/DM 读历史 | 同 |
| G8 | 附件 | 上传/查看附件 | 同 |
| G9 | 表情反应 | `message react` | 同（低优先级） |
| G10 | 文件评论 | 在文件某处留评论，可转成线程 | **本地版独有优势**：直接锚到真实文件+行号 |
| **任务** | | | |
| T1 | 任务即消息 | 任务获得编号（频道内递增）、状态、负责人 | 同 |
| T2 | 创建方式 | ①转换消息 ②勾选 As Task 发送 ③从零创建 | 三种都要 |
| T3 | 状态机 | Todo → In progress → In review → Done；Closed（可 reopen） | 同；**In review 是人类的审批闸门，不能省** |
| T4 | 认领 | 一个任务同时只有一个负责人；认领失败就转去别的工作 | 同；靠 CAS 保证 |
| T5 | 自动认领 | **Agent 收到要行动的消息时，先认领任务再开工** | 同；这是防止重复劳动的关键 |
| T6 | 任务线程 | 每个任务自带线程，进度更新发在线程里 | 同 |
| T7 | 看板 | 按状态分组的一屏视图 | 同 |
| T8 | 子任务 | Agent 可以把大任务拆成可并行的子任务 | 同（DAG 依赖） |
| T9 | 审计 | `task history` 追加式生命周期与修订历史 | 同 |
| T10 | 结构化回执 | `task receipt` 记录资源创建类任务的结果 | 同（可选） |
| **提醒** | | | |
| R1 | Reminder | 绑定到消息/线程的计时器，触发时**只唤醒创建者** | 同 |
| R2 | 持久 | 跨 restart 和 sleep/wake 保留 | 同 |
| R3 | 管理 | schedule（一次性/循环）/ snooze / update / cancel / list / log | 全都要 |
| R4 | 自建 | **Agent 会自己为自己排 reminder** | 同；这是 agent 「有主动性」的来源 |
| **注意力** | | | |
| A1 | Inbox | 待处理目标的汇总；`inbox check` 不读正文只看有无 | 同；这是唤醒协议的关键设计 |
| A2 | 静音 | 频道可 mute/unmute 普通投递 | 同 |
| A3 | 取消关注 | 线程 unfollow | 同 |
| A4 | 唤醒投递 | `message check` 排空 inbox，**返回前先 ack**，保证不重复不丢失 | 同；核心可靠性设计 |
| **Runtime** | | | |
| X1 | 已装检测 | 创建 agent 时列出该电脑上已装的 runtime | 同 |
| X2 | 混合 runtime | 同一服务器上不同 agent 用不同 runtime | 同；这是卖点 |
| X3 | 切换 | 可换 runtime，下次启动生效，身份/工作区/记忆保留 | 同 |
| X4 | 凭据归属 | **订阅和 API key 是你的，Raft 不中介** | 同；本地版本天然满足 |
| X5 | 外部 Agent | 自己跑进程，用 CLI 接入，成为完整成员 | 同；见下方 §4 |
| **工作区** | | | |
| W1 | 持久工作区 | 每个 agent 一个目录，跨会话/跨重置（除 Full reset）保留 | 同 |
| W2 | 隔离 | 同机器上各 agent 工作区互相独立 | 同 |
| W3 | 应用内浏览 | file tree 面板 | 同 |
| W4 | 磁盘直访 | 就是普通目录 | 同 |
| **服务器** | | | |
| S1 | 服务器资料 | 名字、描述、图标 | 同 |
| S2 | 成员管理 | 增删、角色提升/降级 | 同 |
| S3 | 电脑管理 | 连接/重命名/移除/重启/升级 | **本地版大幅简化**：只有本机 |
| S4 | 联合频道 | 跨服务器连接频道 | **不需要**（本地单机场景无意义） |
| **开发者** | | | |
| D1 | 面向 agent 的 CLI | `raft message send` / `task claim` / `reminder schedule` … | 同；见 §2 |
| D2 | 操作手册 | `raft manual get <topic>`，带 intent/reason 强约束 | 同；很聪明的设计，见 §3 |
| D3 | 应用/集成 | RAP App、第三方集成、Login with Raft | 大幅简化 |

---

## 2. Raft 架构的关键洞察：agent 是靠 CLI 操作房间的

我从本机 `@botiverse/raft` 导出了完整命令面。这是最值得抄的部分：

```
raft version | auth | agent | channel | thread | server | user | manual
     | inbox | message | attachment | task | mention | profile
     | integration | reminder | app | wiki | migrate | action
```

关键在于它的**两种运行形态**（CLI 自己的 help 原文）：

> **(A)** external agent via `raft agent login --profile-slug <slug>` 创建 profile，
> 之后用 `raft --profile <slug>`（或 `RAFT_PROFILE=<slug>`）使用；
> **(B)** daemon-injected runner，本地 managed-runner wrapper 会替你设置 `SLOCK_AGENT_*` 环境变量。

**这意味着 agent 完全不需要我们的 SDK。** 它是一个普通进程，通过 CLI 与房间交互：

| agent 想做的事 | 它执行 |
|---|---|
| 看有没有人找我 | `raft inbox check` / `raft message check` |
| 读上下文 | `raft message read --channel ...` |
| 发言 | `raft message send --channel ...` |
| 认领工作 | `raft task claim --task N` |
| 报进度 | `raft message send --thread ...` |
| 交活等审 | `raft task update --status in_review` |
| 排个跟进 | `raft reminder schedule ...` |
| 查怎么用 | `raft manual get <topic> --intent ... --reason ...` |

**对我们的直接好处：**
1. 任何能跑 shell 的 agent（Claude Code / Codex / 甚至一个 shell 脚本）都能当成员。
2. 我们不用为每个 runtime 写一套工具注入。
3. 编排逻辑全部收在 daemon 里，agent 侧极薄。
4. 这也解释了 Raft 为什么不方便：**控制面在云端，CLI 只是个客户端**。我们把它反过来——CLI 连本机 daemon，零网络。

> 附带发现：`raft manual get` 强制要求 `--intent` 和 `--reason` 两个字段，缺了直接报
> `KNOWLEDGE_CONTEXT_INVALID` 并给出重试指引。这是一个防止 agent 乱查文档的**带宽控制**设计，
> 值得直接借鉴。

---

## 3. 共享领域模型（两条路线完全一致）

### 3.1 事件日志（唯一真源）

所有状态都是事件溯源的，append-only：

```ts
type RoomEvent =
  // 成员
  | { kind: 'member/joined';   memberId: MemberId; name: string; desc: string; runtime?: RuntimeId; role: 'member'|'admin' }
  | { kind: 'member/updated';  memberId: MemberId; patch: Partial<MemberProfile> }
  | { kind: 'member/state';    memberId: MemberId; state: AgentState; reason: WakeReason }
  | { kind: 'member/removed';  memberId: MemberId }
  // 消息
  | { kind: 'msg/posted';      msgId: MsgId; channelId: ChannelId; authorId: MemberId; body: Block[]; threadId?: MsgId; taskId?: TaskId }
  | { kind: 'msg/acked';       memberId: MemberId; upToSeq: number }
  // 任务
  | { kind: 'task/created';    taskId: TaskId; num: number; channelId: ChannelId; title: string; deps: TaskId[]; anchorMsgId?: MsgId }
  | { kind: 'task/claimed';    taskId: TaskId; ownerId: MemberId; expectedRev: number }
  | { kind: 'task/status';     taskId: TaskId; status: TaskStatus; expectedRev: number }
  | { kind: 'task/amended';    taskId: TaskId; patch: object; expectedRev: number }
  // 提醒
  | { kind: 'reminder/scheduled'; remId: ReminderId; ownerId: MemberId; anchor: Anchor; at: number; cron?: string }
  | { kind: 'reminder/fired';     remId: ReminderId }
  // 频道 / 注意力
  | { kind: 'channel/created'; channelId: ChannelId; visibility: 'public'|'private'; desc?: string }
  | { kind: 'channel/joined';  channelId: ChannelId; memberId: MemberId }
  | { kind: 'channel/muted';   channelId: ChannelId; memberId: MemberId; muted: boolean }
```

**规则**
- 每个事件带 `seq`（单调递增）和 `ts`。
- 所有可变对象（任务）走 **compare-and-set**：`expectedRev` 不匹配就拒绝（`STALE_REVISION`），
  绝不静默覆盖。这是 Raft `task claim` 防重复劳动的机制。
- 派生视图（看板、成员册、inbox）**每次从日志回放**，缓存只是加速。
- Agent 的私有会话**不进事件日志**，它属于 runtime 自己。

### 3.2 唤醒协议（这是整个系统的心脏）

```
             ┌──────────────────────────────────────────┐
  人类发言 ──▶│ 调度器 Scheduler                          │
             │  1. 解析 @mention / 频道规则              │
             │  2. 预算与终止检查（见下）                │
             │  3. 对目标 agent：先写 inbox 条目          │
             └───────────────┬──────────────────────────┘
                             │ 唤醒（不含正文！）
                             ▼
                    ┌─────────────────┐
                    │ agent 进程       │
                    │  raft inbox check│   ← 只看"有没有"，不读正文
                    │  raft message check│ ← 排空、读取、ack
                    │  ...干活...      │
                    │  raft message send│ ← 发言回房间
                    └─────────────────┘
```

两条不可动摇的规则：

1. **投递语义**：`message check` 必须在返回前 ack 已投递的 seq。这样进程中途崩溃也不会重复消费。
2. **唤醒不携带正文**：唤醒信号只说「你有活」，正文由 agent 主动去拉。
   好处：省 token（唤醒本身极廉价）、agent 能决定读多少、便于跨 runtime。

### 3.3 调度与熔断（Raft 没明说，我们必须显式做）

Raft 有一篇专门的博客讨论「房间里有了 Agent 就一定会混乱吗」。
我们的调度器必须把下面这些当成一等公民，而不是事后补：

| 机制 | 默认值 | 作用 |
|---|---|---|
| `maxHops` | 4 | 一次人类消息引发的 agent→agent 传递最多几跳 |
| `maxTurns` | 6 | 一次人类输入最多触发几个 agent 轮次 |
| `tokenBudgetPerRoom` | 可配 | 房间级 token 上限 |
| `costBudgetPerDay` | 可配 | 日费用上限 |
| `loopDetect` | 开 | A→B→A 相同意图重复 2 次即中断并上报 |
| `stopAll` | UI 按钮 | 立刻中止所有在跑轮次，保留 inbox |

**超预算时的降级**：不是报错停下，而是切到「只汇报不行动」——agent 仍可发言，但禁写文件/命令。

### 3.4 上下文装配规则（决定成本上限）

房间消息是**共享**的，agent 会话是**私有**的。给某 agent 一次发言机会，喂什么：

| 层级 | 内容 | 是否默认给 |
|---|---|---|
| 必给 | 被 @ 的那条消息全文 | ✅ |
| 必给 | 它自己尚未回应的消息 | ✅ |
| 必给 | 任务板中属于它的任务 | ✅ |
| 必给 | 房间摘要（滚动维护，可配长度） | ✅ |
| 可选 | 最近 N 条公共消息（默认 N=20） | ✅ |
| 可选 | 它被 @ 的那条消息的整个线程 | ✅ |
| 可选 | 更早历史 / 其他频道 | ❌ 需要 agent 主动 `message read` |
| **绝不给** | 全量历史 | ❌ |

**这是产品成败的分水岭。** 全量历史 → token 爆炸 + 互相污染 + 成本失控。

---

## 4. 本地化改造：我们比 Raft 好在哪里

| 维度 | Raft | 我们 |
|---|---|---|
| 顶层对象 | Server | **Project（本地文件夹）**，房间挂在项目下 |
| 控制面 | 云端 | **全本机**，CLI 直连 daemon，零网络 |
| 离线 | 需要连服务器 | **完全离线可用** |
| Windows | 官方标注「过渡状态」 | **一等公民** |
| 上下文来源 | Agent 自己 clone 仓库到工作区 | **直接绑定项目文件夹**，无需 clone |
| 多 agent 并发写 | 明确不解决（共享 cwd，writeScope 仅提示） | **串行 → 软声明 → git worktree** |
| 文件评论 | 锚到工作区文件 | 锚到**真实项目文件的真实行号** |
| 成本可见性 | 不透明 | **预算面板 + 实时花费 + 熔断** |
| 数据 | 在别人服务器上 | **全在本地磁盘，可 git 版本化** |
| 跨机器 | Computer 连服务器 | 可选的 P2P/自建 relay（后期） |
| 联合频道 | 支持 | 不需要（S4 砍掉） |

**注意：W1「工作区」在本地版要重新设计。** Raft 给每个 agent 一个独立工作区目录，
所以 agent 要 clone 仓库。我们直接绑项目文件夹，那么「工作区」就变成：
- **项目目录**（共享，agent 在这里干活）
- **agent 私有区**（不共享，存 MEMORY.md / 草稿 / 笔记）

两者都要有，否则 agent 的记忆会污染项目。

---

## 5. 砍掉的范围（明确不做）

| 砍掉 | 原因 |
|---|---|
| 联合频道（跨服务器） | 单机场景无意义 |
| 云端账号 / 登录 | 本地优先 |
| RAP App 生态 / 第三方集成市场 | MVP 不需要 |
| 多电脑管理 | 只有本机；后期可加 SSH 远端 |
| 文件上传到服务器 | 本地文件直接引用路径 |
| Wiki / 规范化 manifest | 后期 |
| 表情反应 | 最末尾 |

---

## 6. 验收标准（替代 Raft 的判定）

能做到下面这些，才算「可以替代 Raft」：

1. 我在 `D:\myrepo` 上开一个项目，创建 3 个 agent（Claude Code / Codex / DSH 各一个）。
2. 我在 `#general` 发一句需求，`@全员`。Lead agent 分诊，把活拆成 3 个任务发到任务板。
3. 三个 agent 各自认领、开工、在各自任务线程里报进度，**主频道保持干净**。
4. 其中两个改了同一文件 → 系统提前警告或隔离，**没有冲突损坏**。
5. 全部交到 `in review`，我在看板上审 diff，逐个 approve 到 `done`。
6. 中途我关掉软件再打开，**房间历史、任务状态、每个 agent 的记忆全在**。
7. 我说「明天早上提醒我检查」，其中一个 agent 排了 reminder，第二天它自己醒来跟进。
8. 我让 agent 停，它立刻停；我重置它的会话，它的记忆文件还在。
9. 整个过程**一个字节都没出过本机**，我在预算面板上看到花了多少钱。
