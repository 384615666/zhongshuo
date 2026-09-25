# 01 · 路线 A：基于 DSH 做「房间」

> 一句话：**DSH 本身已经是一个「Codex 式的本地文件夹 agent 应用」**，
> 我们只需要在它上面加一层「房间」——把它的 workspace 从「一个会话」扩展成「一屋子成员」。
>
> 前置阅读：`00-shared-spec.md`（领域模型与能力清单在两条路线中完全一致）

---

## 1. 为什么这条路比想象中短

我在你本机的 DSH 里发现了三件事，直接改变了这条路的成本估算：

### 发现一：DSH 的原生对象里已经有「本地文件夹」

```
dsh-workspace                      工作区核心
dsh-api-workspace-controller       工作区 API
dsh-api-workspace-files            工作区文件读写
dsh-client-ui-workspace            工作区 UI
dsh-client-ui-directory-picker-native  原生目录选择器
dsh-host-directory-picker-native
dsh-util-workspace-path
```

**这正是 Codex 的「打开本地文件夹」能力，已经做完了。** 你不需要重新发明它——你缺的只是
「在同一个文件夹上坐一屋子 agent」的那一层。

### 发现二：DSH 已经提供了三种「被别的东西驱动」的入口

| profile | 命令 | 协议 | 用途 |
|---|---|---|---|
| `headless` | `dsh --profile headless "任务"` | stdout | 一次性任务，退出码表结果 |
| `acp` | `dsh --profile acp` | ACP over stdio（Zed/JetBrains 生态） | 持久 agent，客户端提供 cwd |
| `sdk` | `dsh --profile sdk` | JSON-RPC over stdio | 嵌入到宿主程序 |
| `web` | `dsh web` | HTTP + WebSocket | 浏览器 UI |

**`acp` profile 尤其关键**：它的文档原文是「ACP client 为每个 session 提供工作区
（workspace）」。也就是说，**一个 per-agent 的工作目录是协议层就支持的**——
这正好对上我们的「每个 agent 绑定到项目文件夹」需求。

### 发现三：`dsh-experimental-agent-team` 已经写好了最难的部分

它的自我描述：

> 「把一个编码会话变成一个小型工作团队：会话中的 agent 成为 Lead，创建具名 teammate
> 处理委派的工作，与它们交换持久消息，并在公共任务板上跟踪共享任务。消息与任务状态
> 能挺过崩溃、reload 与中断，因此离线的 teammate 会在恢复后收到排队的消息。」

它提供的、且我们**直接需要**的机制：

| 机制 | 它怎么做 | 我们能直接用的程度 |
|---|---|---|
| 持久信箱 | `team/message/queued` → `delivered`，先 flush 再投递，目标 Session 去重 | ✅ 语义完全一致 |
| 投递语义 | live 立即 / idle 排队 / inactive 冷恢复，**绝不丢失、绝不重复** | ✅ 这就是我们要的唤醒协议 |
| 任务 CAS | 每次变更带 `expectedRevision`，过期调用报 `TEAM_TASK_STALE_REVISION` | ✅ 直接对应 T4 防重复劳动 |
| 任务 DAG | 依赖满足才可 claim，`writeScopes` 重叠只警告不阻止 | ✅ 对应 T8 |
| 事件溯源 | `team/member`、`team/task`、`team/message/*` 只进日志，不进模型历史 | ✅ 对应 §3.1 |
| roster | `running` / `idle` / `inactive` / `provisioning` / `failed` | ✅ 对应 M1、L1 |
| 崩溃恢复 | provisioning 记录与 child 的持久 Session 对账 | ✅ 对应 L2 |
| 客户端 UI | `./remote` 导出 Web UI 挂载的 Client contribution | ✅ 对应 W3 |

它的**已知限制**（官方原文）恰好就是我们要补的：

> - 单进程、共享 checkout，**不提供 worktree、远端成员、merge 或文件锁**
> - roster 扁平且不可变，**只有 Lead 可以创建直接 teammate**，不支持嵌套/重命名/删除
> - **不会自动释放 owner**（idle、interrupt、进程退出都不释放）
> - mailbox **不保证跨进程 exactly-once**，不支持多进程并发操作同一 Team

**结论：路线 A = 站在 agent-team 的肩膀上，把它从「会话内团队」升级成「持久房间」。**

---

## 2. 形态设计

### 2.1 交付物形态

发布一个 **DSH profile bundle**，让用户一条命令装上：

```sh
dsh plugin --profile web add @yourscope/dsh-room
dsh web
```

界面里多出一个「房间」入口，和现有的会话/工作区并排。

**为什么是 profile 插件而不是独立 app**：你手上的 `dsh-market` 就是「一个 npm 包同时
提供 host 插件 + browser 客户端 bundle」的完整模板（`package.json` 里的 `dsh.bundle.patch`
+ `dsh.client.inject` + `platform: "web"`）。你已经会这个工程形态了。

### 2.2 对象映射

| 我们的领域对象 | DSH 里落在哪 |
|---|---|
| Project（本地文件夹） | **复用** `dsh-workspace` |
| Room（房间） | 新概念，落在我们的 host 插件里 |
| Channel / Thread / Message | 新概念，事件日志 |
| Member（Human） | DSH 的用户身份 |
| Member（Agent） | **复用** agent-team 的 teammate（in-process subagent） |
| Task / TaskBoard | **复用** agent-team 的 task board，扩展状态机 |
| Reminder | **复用** `dsh-schedule` + `dsh-client-ui-schedule` |
| Agent 私有会话 | **复用** `dsh-session` + `dsh-session-persistence-jsonl` |
| Agent 私有记忆区 | 工作区里的 `<workspace>/.room/<agent>/` |
| 预算/熔断 | 新概念，`dsh-token-meter` 可复用做计量 |
| UI | **复用** `dsh-web-app` 外壳 + 一套 `dsh-client-ui-*` 槽位 |

### 2.3 分层落地

```
┌──────────────────────────────────────────────────────────┐
│ 表现层  dsh-client-ui-* 生态（复用外壳 + 槽位）             │
│   @yourscope/dsh-room-ui（新增）                          │
│   频道侧栏 · 消息流 · 线程面板 · 任务看板 · 成员面板 · 预算  │
└───────────────────────┬──────────────────────────────────┘
                        │ DSH remote / typert 协议（复用）
┌───────────────────────┴──────────────────────────────────┐
│ 编排层  @yourscope/dsh-room-orchestrator（新增）           │
│   Scheduler · 上下文装配 · 预算熔断 · @mention 路由         │
│                                                          │
│ 领域层  @yourscope/dsh-room-core（新增）                   │
│   房间事件日志 · 频道 · 线程 · 任务状态机 · reminder        │
│   ↑ 大量借用 dsh-experimental-agent-team 的 mailbox/task   │
└───────────────────────┬──────────────────────────────────┘
                        │
┌───────────────────────┴──────────────────────────────────┐
│ 执行层  ★ 全部复用，一行不写 ★                             │
│   dsh-agent / dsh-agent-loop / dsh-tool-* / dsh-sandbox-* │
│   dsh-session-persistence-jsonl / dsh-subagent-*          │
│   + RuntimeAdapter：in-process subagent | acp | headless  │
└──────────────────────────────────────────────────────────┘
```

### 2.4 插件拆分（5 个包）

| 包 | 侧 | 职责 | 复用度 |
|---|---|---|---|
| `dsh-room-core` | host | 事件日志、房间、频道、线程、消息、成员册 | 新写（借 agent-team） |
| `dsh-room-tasks` | host | 任务状态机（扩展 agent-team 的 DAG）、看板投影 | 改造 agent-team |
| `dsh-room-orchestrator` | host | 调度、装配、预算、熔断、reminder | 新写 |
| `dsh-room-runtime` | host | `RuntimeAdapter`（in-process / acp / headless） | 新写（薄） |
| `dsh-room-ui` | client | 房间 UI | 新写 |

拆成 5 个的好处：可以逐个发布、逐个替换，`dsh-market` 那套「加载顺序 / 依赖诊断」
也能直接管它们。

---

## 3. agent 怎么和房间交互

**关键决策：不要给 agent 注入自定义工具，而是给它一个 CLI。**（理由见 `00-shared-spec.md` §2）

### 3.1 提供 `room` CLI

```sh
room inbox check                     # 有活吗（不读正文）
room message check                   # 排空、读取、ack
room message read --channel general
room message send --channel general --text "..."
room message send --thread <msgId> --text "..."
room task list --channel general
room task claim --task 7
room task update --task 7 --status in_review
room reminder schedule --at "2026-09-11T09:00" --anchor <msgId>
room manual get <topic> --intent "..." --reason "..."
```

这套 CLI 的**规范完全照抄 Raft 的 `raft` CLI**——它已经被验证过是合理的 agent 接口。
对我们额外的好处：

1. **任何能跑 shell 的 runtime 都能当成员**，不需要为每个 runtime 写工具适配。
2. 同一个 CLI 既能给 in-process subagent 用（它本来就能跑 pwsh/bash），
   也能给外部 Claude Code / Codex 用。
3. 调试极其简单：我自己在终端里敲 `room message send` 就能当一回 agent。

内部实现上，CLI 直连本机 daemon（Unix socket / 命名管道 / 环回 HTTP），
**零网络**。这与 Raft「CLI 连云端服务器」形成根本区别。

### 3.2 唤醒链路（复用 agent-team 的投递语义）

```
人类发言
   │
   ▼
Scheduler 解析 @mention → 预算检查 → 写 inbox 条目（先 flush）
   │
   ├─ agent 是 in-process subagent ──▶ ctx.agentTeams.sendMessage() / Agent.steer()
   │                                    （冷恢复、去重、排队都是现成的）
   │
   └─ agent 是外部进程 ──────────────▶ 唤醒信号（不携带正文）
                                        agent 自己跑 `room message check`
```

**这条链路是路线 A 最大的复用红利。** agent-team 明确保证：
「只有目标 Session 在 pending inbox 或已记录历史中持久持有消息身份后，才会确认投递」
「inbox 已接受但模型尚未 claim 时发生崩溃不会复制消息」。

---

## 4. 与目标的差距：必须自己补的部分

| 差距 | agent-team 现状 | 我们要做 |
|---|---|---|
| **不是持久房间** | `TeamId = SessionId`，Lead 是会话；会话结束团队就散 | 引入独立的 Room 实体 + 自己的事件日志；agent 的 Session 挂在 Room 下 |
| **没有频道/线程** | 只有扁平 roster + mailbox | 新写频道/线程/消息模型 |
| **没有任务状态机** | 只有 DAG + claim/complete | 扩展成 Todo/InProgress/InReview/Done/Closed + 看板投影 |
| **没有 reminder** | 无 | 复用 `dsh-schedule` |
| **没有 @mention 路由** | 只能显式点名 sendMessage | 新写 Scheduler |
| **没有人类成员** | Lead 是模型 | 人类作为一等成员进日志 |
| **只有 Lead 能创建** | roster 不可变 | 放开为「房间 Admin 可增删成员」（对应 M2/M3） |
| **不释放 owner** | idle/interrupt 都不释放 | 加租约（lease）+ 超时释放 |
| **共享 checkout 无隔离** | 官方明确不做 | 串行 → 软声明 → git worktree |
| **无预算熔断** | 有 `maxMembers/maxTasks`，无 token 预算 | 新写，`dsh-token-meter` 计量 |
| **单进程** | in-process subagent | 通过 `RuntimeAdapter` 逐步外置 |

**注意「不是持久房间」这一条是最根本的。** agent-team 是「一个会话带几个帮手」，
我们要的是「一个文件夹上常驻的一屋子成员」。**这一层要自己写，但可以大量借用它的
mailbox 和 task CAS 实现。**

---

## 5. 里程碑（路线 A 版）

### A-M0 · 房间跑通（1–2 周）

目标：在 DSH 的 Web UI 里，打开一个本地文件夹，看到一个房间，@一个 agent 让它干活。

- [ ] 新建 `dsh-room-core` 骨架 + cordis patch 注入 web profile
- [ ] 房间事件日志（`room.jsonl`）+ 回放
- [ ] 最小 UI：频道列表 + 消息流 + 输入框（挂 DSH 的 UI 槽位）
- [ ] `RuntimeAdapter` v0：只用 in-process subagent
- [ ] 人类发言 → `@agent` → 派 subagent（cwd = 项目文件夹）→ 流式回复进房间

**验收**：在 `D:\myrepo` 上 @ 一个 agent「读 README 总结」，它真的读了，回复出现在房间里。

### A-M1 · 成员册 + 任务（1–2 周）
- [ ] 成员册（名字/描述/runtime/角色），Agent 可改自己的描述（M4）
- [ ] 任务状态机 + 看板 + CAS 认领（T1–T7）
- [ ] 任务线程：进度更新发线程（T6）
- [ ] inbox ack 语义 + 崩溃恢复
- [ ] 活动流：工具调用作为可折叠事件

**验收**：关掉 `dsh web` 再打开，房间、任务、agent 记忆全在。

### A-M2 · 编排 + 熔断（2 周）
- [ ] Scheduler：@mention 路由、`@全员` 分诊（Lead agent）
- [ ] §3.3 全部熔断项（maxHops/maxTurns/预算/循环检测/stopAll）
- [ ] 上下文装配规则（§3.4）+ 滚动摘要
- [ ] reminder（复用 `dsh-schedule`）

**验收**：我 @全员 一个需求，Lead 分诊成 3 个任务，3 个 agent 分工完成；
我故意让它俩互相 @，熔断生效并上报。

### A-M3 · 隔离 + 审阅（2–3 周）
- [ ] 写操作串行化 → 软声明 → **git worktree per agent**
- [ ] diff 审阅面板 → in_review → approve → done
- [ ] 危险操作审批（复用 `dsh-permission-presets` / `dsh-user-approval`）

### A-M4 · 外部 runtime + 产品化（2 周）
- [ ] `RuntimeAdapter` 接 `dsh --profile acp`（独立进程 + 独立 cwd）
- [ ] 接外部 Claude Code / Codex（都走 `room` CLI）
- [ ] Electron 壳 + 托盘保活（复用 `tray/` 方案）
- [ ] 成员模板：预置「架构师 + 实现 + 评审」

---

## 6. 风险（路线 A 专有）

| 风险 | 说明 | 对策 |
|---|---|---|
| **实验包会变** | `dsh-experimental-*` 官方明说「孵化期间约定可自由变更」 | 所有对 agent-team 的调用包在**我们自己的薄接口**后面，不直接引用其类型 |
| **DSH 版本耦合** | 你的 dsh-market 就在 `package.json` 里做了版本门禁（`^0.1.0-rc.7 \|\| ^0.1.1-rc.2`） | 照做；加运行时版本检测和友好降级 |
| **单进程天花板** | in-process subagent 一崩全崩 | A-M4 必须把外部 runtime 做出来；`RuntimeAdapter` 从第一天就留好 |
| **共享 checkout** | agent-team 明确不做隔离 | 这是我们的主卖点，A-M3 必须做出来，不能拖 |
| **升级会破坏用户状态** | 事件日志格式会演进 | 从第一天就带 `schemaVersion` + 迁移函数 |
| **UI 槽位可能不够** | 房间 UI 不是标准聊天 | 先做 A-M0 探一下 `dsh-client-ui-*` 的扩展点够不够 |

---

## 7. 关键代码骨架（供起步参考）

```ts
// dsh-room-core/src/index.ts —— 插件入口
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-room'
export const inject = ['workspace', 'session', 'agent']

export interface Config {
  maxHops: number          // 默认 4
  maxTurns: number         // 默认 6
  recentWindow: number     // 默认 20
  tokenBudgetPerRoom?: number
}

export function apply(ctx: Context, config: Config) {
  const rooms = new Map<RoomId, Room>()

  ctx.set('room', {
    async open(projectPath: string) { /* 绑定 workspace，创建/加载 room.jsonl */ },
    async post(channelId, authorId, body) { /* 追加事件 → 投影 → 通知 UI */ },
    async claim(taskId, ownerId, expectedRev) { /* CAS */ },
  })

  // 调度器接在消息事件之后
  ctx.on('room/message', async (ev) => {
    for (const m of resolveMentions(ev, rooms)) {
      if (!withinBudget(ev.room, config)) return degrade(ev.room)
      await dispatch(m, assembleContext(ev, config))  // §3.4
    }
  })
}
```

```ts
// dsh-room-runtime/src/adapter.ts —— 执行层唯一抽象
export interface RuntimeAdapter {
  readonly id: string
  detect(): Promise<boolean>                              // X1 已装检测
  spawn(opts: { agent: AgentId; cwd: string; session?: string }): Promise<Handle>
  send(h: Handle, msg: string): Promise<void>
  stream(h: Handle): AsyncIterable<RuntimeEvent>           // 工具调用/文本/错误
  interrupt(h: Handle): Promise<void>
  dispose(h: Handle): Promise<void>
}

// 第一版只实现这个，把 agent-team 的 subagent 包起来
export const inProcessAdapter: RuntimeAdapter = { /* ... */ }
// A-M4 再加：acpAdapter（dsh --profile acp）、cliAdapter（claude/codex + room CLI）
```

**最重要的约束**：`RuntimeAdapter` 这个接口从第一天就要存在，
哪怕第一版只有一个实现。它决定了这条路线将来能不能长出多 runtime。
