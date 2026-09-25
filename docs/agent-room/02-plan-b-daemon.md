# 02 · 路线 B：独立 daemon + 多 runtime

> 一句话：**自己写一台「本机的 Raft 服务器」**——daemon 持有房间状态，
> agent 是它拉起的子进程，通过 CLI 与房间交互；runtime 用 **ACP 统一接入**。
>
> 前置阅读：`00-shared-spec.md`（领域模型与能力清单在两条路线中完全一致）

---

## 1. 决定性发现：ACP 让「多 runtime」几乎免费

我原本以为这条路线的最大成本是「为 Claude Code / Codex / Gemini / … 各写一套适配器」。
调研后发现这个前提已经过时了。

**Agent Client Protocol（ACP）已是事实标准**，官方 Agents 列表里有 40+ 个 agent，其中
——**Raft 支持的 runtime 列表几乎被完全覆盖**：

| Raft 支持 | ACP 状态 |
|---|---|
| Claude Code | ✅ [Claude Agent via Zed's SDK adapter](https://github.com/zed-industries/claude-agent-acp) |
| Codex CLI | ✅ [codex-acp](https://github.com/agentclientprotocol/codex-acp) |
| Gemini CLI | ✅ 原生 |
| Kimi CLI | ✅ 原生 |
| Copilot CLI | ✅ [public preview](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/) |
| Cursor CLI | ✅ 原生 |
| OpenCode | ✅ 原生 |
| Pi | ✅ [pi-acp](https://github.com/svkozak/pi-acp) |
| Antigravity | ❌ 暂缺（用 CLI 适配器兜底） |

外加 Goose、Cline、Qwen Code、Junie（JetBrains）、Kiro、Factory Droid、Mistral Vibe、
OpenHands、Augment、Poolside、Qoder 等等。JetBrains 和 Zed 还联合发布了
[ACP Registry](https://gihyo.jp/article/2026/01/acp-registry)。

ACP v1 的关键能力，正好逐条对上我们的需求：

| 我们的需求 | ACP v1 |
|---|---|
| 每个 agent 绑定一个工作目录 | `session/new` **接受绝对 `cwd`** |
| 独立进程、独立会话 | 每个 session 独立 |
| 切模型 | 公开的 `model` 选择 |
| 切推理强度 | 公开的 `reasoning_effort` |
| 观察进度 | 标准语义更新（streaming） |
| 恢复会话 | `session/list` + `session/resume`（resume 重连 MCP，不重放历史） |
| 中断 | ACP 标准中断 |
| MCP 工具 | 标准 stdio/HTTP MCP 声明 |

**结论：L1（执行层）= 一个 ACP 客户端 + 一个 CLI 兜底适配器。** 不是 9 个适配器。

**而且 DSH 自己就实现了 ACP**：`dsh --profile acp` 的文档原文是
「ACP client 为每个 session 提供工作区」。所以 **DSH 可以作为这条路线的第一个 runtime 直接接入**——
你不需要在两条路线之间二选一，路线 B 可以把路线 A 的执行核心当成一个普通 runtime 用。

---

## 2. 架构

```
┌────────────────────────────────────────────────────────────────┐
│ L4 表现层                                                       │
│   ① Electron 桌面壳（MVP：浏览器）                              │
│   ② room CLI（给 agent 用，也可以人肉用）                        │
└────────────────────────┬───────────────────────────────────────┘
                         │ 命名管道 / Unix socket（UI 走环回 HTTP+WS）
┌────────────────────────┴───────────────────────────────────────┐
│ L3 编排层  roomd（常驻 daemon，「本机的 Raft」）                  │
│   项目注册表 · 成员册 · Scheduler · 上下文装配 · 预算熔断          │
│   频道/线程/消息 · 任务状态机 · Reminder · 注意力(mute/follow)     │
│   Supervisor（拉起/休眠/重启 agent 进程）· Worktree 管理器         │
└────────────────────────┬───────────────────────────────────────┘
                         │
┌────────────────────────┴───────────────────────────────────────┐
│ L2 持久层                                                       │
│   room.jsonl（事件日志，唯一真源）                               │
│   index.sqlite（派生索引，可重建）                               │
│   inbox/<agent>.jsonl + .ack（跨进程信箱）                       │
│   会话映射：runtime session id ↔ 我方 agent id                   │
└────────────────────────┬───────────────────────────────────────┘
                         │ ACP over stdio（主）/ 子进程 CLI（兜底）
┌────────────────────────┴───────────────────────────────────────┐
│ L1 执行层  agent 进程                                            │
│   dsh --profile acp │ claude-agent-acp │ codex-acp │ gemini …    │
│   每个 = 独立进程 + 独立 cwd + 独立 session                       │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. 项目结构

```
room/
  packages/
    protocol/           # 共享类型：事件、消息、任务、CLI 契约
    core/               # 领域逻辑：房间、频道、线程、任务状态机、事件溯源
    daemon/             # roomd：服务、调度器、supervisor、worktree
    runtime-acp/        # ACP 客户端（主要 runtime）
    runtime-cli/        # 子进程 CLI 兜底（Antigravity 等）
    cli/                # room CLI（agent 面向）
    server-api/         # UI 用的环回 HTTP + WebSocket
  apps/
    desktop/            # Electron 壳
    web/                # UI（可独立跑在浏览器）
  docs/
```

**目录依赖方向单向**：`protocol ← core ← daemon ← {cli, server-api} ← apps`。
`runtime-*` 只依赖 `protocol`。这条约束保证了 runtime 可以随便换。

---

## 4. 关键模块设计

### 4.1 持久层：日志是真的，索引是派生的

```
~/.room/
  config.yaml
  projects.json                 # 项目注册表：id → 本地路径、默认 runtime、git 信息
  projects/<project-id>/
    room.jsonl                  # ★ 唯一真源
    index.sqlite                # 派生索引，删了能重建
    members.json
    inbox/
      <agent>.jsonl             # 待投递
      <agent>.ack               # 已投递水位
    agents/<agent>/
      session.json              # runtime session id + 恢复参数
      memory/                   # 私有记忆区（MEMORY.md / notes/）
      activity.jsonl            # 工具调用轨迹（UI 活动流）
    worktrees/<agent>/          # git worktree 隔离（A-M3 阶段）
```

**为什么日志用 JSONL 而不是只上 SQLite**：
- append-only 天然抗崩溃（写一半最多丢最后一行）
- 可以直接 `git init` 让整个房间历史可版本化、可 diff、可同步
- 出问题时用文本工具就能查
- SQLite 只做「查询加速」，任何时刻都能 `rm index.sqlite && roomd reindex`

### 4.2 跨进程信箱：这是路线 B 最难的地方

agent 是独立进程，所以 **agent-team 那套「进程内 exactly-once」用不了**。
诚实地说：**跨进程 exactly-once 投递是不可能做到的**，只能选一边。

| 方案 | 语义 | 丢消息风险 | 重复风险 |
|---|---|---|---|
| **ack-on-read**（Raft 的做法） | at-most-once | agent 读完后崩溃 → 丢 | 无 |
| **lease + 显式 ack** | at-least-once | 无 | 有，需要 agent 侧去重 |

**推荐：默认 ack-on-read，提供 `--lease` 模式。**
理由：Raft 的 `message check` 就是「返回前先 ack 已投递的 seq」，且它被验证过够用；
丢一条「@你来看一下」比让 agent 重复干一遍活代价小。
对关键任务（`task claim` 类）走 lease + 显式 ack，并在消息里带稳定 `msgId` 让 agent 能自查。

```
room message check                 # 读 + ack，返回前落盘 ack 水位（默认）
room message check --lease 60      # 读 + 加 60s 租约，不 ack
room message ack --up-to <seq>     # 显式确认
```

守护进程重启时，读 ack 水位恢复；租约过期的消息重新变为待投递。

### 4.3 Supervisor：agent 进程的生死

这是路线 B 相对路线 A 的最大工程负担，也是最不可省的部分。

```ts
interface AgentProcess {
  agentId: AgentId
  runtime: RuntimeId
  cwd: string                // 项目目录 或 worktree
  state: 'stopped'|'starting'|'idle'|'busy'|'error'
  pid?: number
  sessionRef?: string        // runtime 侧 session id
  lastActivity: number
  restartCount: number
}

interface SupervisorPolicy {
  idleShutdownMs: number       // 默认 10min：idle 超时杀掉进程省内存（状态保留）
  maxRestarts: number          // 默认 3
  backoffMs: [number, number]  // 默认 [1000, 30000] 指数退避
  startupTimeoutMs: number     // 默认 60_000
  crashLoopWindowMs: number    // 默认 300_000：窗口内超次数 → 标记 error 并停止重试
}
```

必须处理的情况（每条都要有测试）：
- agent 进程启动后不响应 → 超时杀 + 标记 `error`
- agent 崩溃 → 重启，`restartCount++`；超阈值进 `error` 并停止重试（避免无限重启烧钱）
- 停止 agent 时进程不听 SIGTERM → 宽限期后强杀
- 唤醒时进程已死 → 重新拉起 + `session/resume` 恢复上下文
- 项目文件夹被删除/移动 → 所有 agent 进 `error`，提示人类处理
- 优雅退出：收到退出信号 → 中止在跑的轮次 → flush 日志 → 释放锁

**Windows 特别注意**：没有 POSIX 信号。用 `taskkill /T /F` 杀进程树，
子进程用 `windowsHide: true`，别让每个 agent 弹黑框。

### 4.4 ACP runtime 适配器

```ts
export interface RuntimeAdapter {
  readonly id: string
  readonly displayName: string
  detect(): Promise<{ installed: boolean; version?: string }>   // X1
  spawn(opts: { agentId: AgentId; cwd: string; model?: string;
                reasoningEffort?: string; resumeSession?: string }): Promise<AgentHandle>
  prompt(h: AgentHandle, blocks: ContentBlock[]): Promise<void>
  updates(h: AgentHandle): AsyncIterable<SessionUpdate>          // 流式语义更新
  interrupt(h: AgentHandle): Promise<void>
  close(h: AgentHandle): Promise<void>
}

export class AcpAdapter implements RuntimeAdapter {
  constructor(private cmd: string, private args: string[] = []) {}
  // 内部：stdio 上跑 ACP v1 —— initialize → session/new(绝对 cwd) → session/prompt
  //       session/list / session/resume 用于恢复
}
```

registry 就是一张表，加一个 runtime 只加一行：

```ts
export const RUNTIMES: RuntimeDescriptor[] = [
  { id: 'dsh',        cmd: 'dsh',    args: ['--profile','acp'], acp: true },
  { id: 'claude',     cmd: 'npx',    args: ['-y','@zed-industries/claude-agent-acp'], acp: true },
  { id: 'codex',      cmd: 'npx',    args: ['-y','@agentclientprotocol/codex-acp'],   acp: true },
  { id: 'gemini',     cmd: 'gemini', args: ['--experimental-acp'], acp: true },
  { id: 'opencode',   cmd: 'opencode', args: ['acp'],              acp: true },
  { id: 'kimi',       cmd: 'kimi',   args: ['acp'],                acp: true },
  { id: 'cursor',     cmd: 'cursor-agent', args: ['acp'],          acp: true },
  { id: 'copilot',    cmd: 'copilot', args: ['--acp'],             acp: true },
  { id: 'antigravity',cmd: 'antigravity', args: [], acp: false },  // CLI 兜底
]
```

**`dsh` 放在第一行不是偶然**：它已经装在你机器上，实现了 ACP，
所以你可以**用路线 B 的架构，第一天就跑起来，而不需要先写 8 个适配器**。

### 4.5 room CLI：agent 的接口面

命令面照抄 Raft 的 `raft` CLI（已被验证合理），按 `00-shared-spec.md` §1.2 逐项覆盖：

```
room inbox check
room message check [--lease N] | ack --up-to <seq>
room message read --channel <c> | --thread <m> | --dm <u>
room message send --channel <c> [--thread <m>] [--text ...] [--as-task]
room message search <kw> | resolve <id> | react
room task list|create|claim|unclaim|assign|update|convert|history|receipt
room channel info|members|create|join|leave|mute|unmute
room thread unfollow
room reminder schedule|list|cancel|snooze|update|log
room profile show|update
room server info
room manual get|search        # 带 --intent/--reason 强约束
```

**两条实现原则**：
1. **CLI 不实现业务逻辑**，它只是 daemon 的瘦客户端。所有状态变更都走 daemon，
   保证 CAS 和事件日志的唯一性。
2. **CLI 必须能在没有任何环境变量时工作**，配置从 `~/.room/config.yaml` 读；
   daemon 拉起 agent 时再注入 `ROOM_AGENT_ID` / `ROOM_PROJECT_ID` 作为默认身份。
   这样「外部 agent」（对应 Raft 的 X5）和「托管 agent」用同一套代码。

### 4.6 UI

路线 B 的 UI 要从零写，这是它相对路线 A 最大的额外成本。

| 视图 | 内容 |
|---|---|
| 项目切换 | 侧栏列出已注册的本地文件夹 |
| 房间 | 频道列表 / 消息流 / 线程面板 / 输入框（支持 `--as-task`） |
| 任务看板 | 按状态分列，拖拽改状态（走 CAS） |
| 成员面板 | 人类 + agent，状态点、角色、runtime、当前在干啥 |
| **活动流** | 每个 agent 的工具调用实时流（可折叠），这是「看得见它在干活」的关键 |
| **diff 审阅** | in_review 任务的文件变更，逐 hunk 接受/拒绝 |
| 预算面板 | 本房间/本日 token 与费用，熔断状态 |
| reminder | 待触发列表 |

技术选型建议：**React 18 + 你熟悉的 dsh-market 那套构建链（tsdown + vitest + playwright）**，
Web 先跑，稳定后套 Electron。别一上来就 Electron。

### 4.7 并发写隔离（主卖点）

```ts
interface WorktreeManager {
  prepare(agentId: AgentId, base: string): Promise<string>   // git worktree add
  diff(agentId: AgentId): Promise<Diff>
  merge(agentId: AgentId, strategy: 'merge'|'cherry-pick'): Promise<MergeResult>
  discard(agentId: AgentId): Promise<void>
}
```

三级演进，**不要跳级**：

| 阶段 | 机制 | 保证 |
|---|---|---|
| 0 | 串行：一个房间同一时刻只有一个 agent 能写 | 永不冲突，最简单 |
| 1 | 软声明：开工前声明触及的路径前缀，重叠则排队/警告 | 大幅减少冲突 |
| 2 | **git worktree per agent** + 完成后合并/挑拣 | 并行且不打架 |

阶段 2 的实现细节要注意：
- 每个 worktree 从同一个 base commit 建
- agent 完成后 `in_review`，展示 diff
- 合并时先 rebase 到最新，冲突则退回人类处理
- **绝不要自动强推**；永远是人类点 approve

---

## 5. 里程碑（路线 B 版）

### B-M0 · daemon + 单 agent 跑通（2 周）
- [ ] `roomd` 骨架：项目注册表、`room.jsonl`、一个频道
- [ ] IPC：命名管道（Windows）/ Unix socket，UI 走环回 HTTP+WS
- [ ] `runtime-acp` v0：**只接 `dsh --profile acp`**（你本机就有）
- [ ] Supervisor v0：spawn / prompt / 流式 updates / interrupt / 优雅关闭
- [ ] `room` CLI v0：`message check` / `read` / `send`
- [ ] 最小 Web UI：频道 + 消息流

**验收**：`roomd start` → 在 `D:\myrepo` 建房间 → 建 2 个 agent → @它 → 它读文件并回复。

### B-M1 · 持久化 + 成员 + 任务（2–3 周）
- [ ] 跨进程信箱：ack 水位、lease、daemon 重启恢复
- [ ] 成员册 + 角色（M1–M4）
- [ ] 任务状态机 + 看板 + CAS 认领（T1–T7, T9）
- [ ] inbox 唤醒链路：写条目 → 唤醒 agent → agent 拉取 → ack
- [ ] 活动流 UI

**验收**：`roomd stop` → `roomd start`，房间/任务/agent 记忆全在，未投递的消息补投。

### B-M2 · 编排 + 熔断 + reminder（2–3 周）
- [ ] Scheduler：@mention 路由、`@全员` Lead 分诊
- [ ] §3.3 全部熔断项
- [ ] 上下文装配（§3.4）+ 滚动摘要
- [ ] Reminder 全生命周期（R1–R4）
- [ ] 注意力：mute / follow（A1–A3）

### B-M3 · 多 runtime（1–2 周）
- [ ] ACP registry：claude / codex / gemini / opencode / kimi / cursor / copilot
- [ ] 已装检测 UI（X1）
- [ ] runtime 切换（X3），身份/记忆保留
- [ ] CLI 兜底适配器（Antigravity 等）
- [ ] **外部 agent 接入**（X5）：`room agent login` 等价物

**验收**：同一个房间里 Claude Code、Codex、DSH 三种 agent 协同完成一个任务。

### B-M4 · 隔离 + 审阅（2–3 周）
- [ ] 串行 → 软声明 → git worktree
- [ ] diff 审阅 UI → in_review → approve → merge
- [ ] 危险操作审批

### B-M5 · 产品化（2–3 周）
- [ ] Electron 壳 + 托盘保活 + 开机自启（复用 `tray/`）
- [ ] 一键安装与 runtime 自动检测/引导
- [ ] 团队模板（架构师/实现/评审）
- [ ] 导出/导入房间；房间历史 git 化

**总计约 11–16 周**（路线 A 约 7–10 周）。

---

## 6. 风险（路线 B 专有）

| 风险 | 说明 | 对策 |
|---|---|---|
| **UI 从零写** | 最大的额外成本 | 先 Web 后 Electron；复用 dsh-market 的构建链；UI 与 daemon 严格解耦，可以后做 |
| **进程管理复杂度** | 崩溃循环、僵尸进程、Windows 信号 | 每个失败模式都要有测试；`crashLoopWindowMs` 防无限重启烧钱 |
| **跨进程投递** | 无法做到 exactly-once | 明确选 at-most-once（默认）+ lease 模式；文档写清 |
| **ACP 生态还在动** | 协议与适配器会演进 | 只依赖 ACP v1 公开面；适配器表是数据不是代码 |
| **范围失控** | 「替代 Raft」= 23 个 CLI 域 | 严格按 §1.2 优先级；S4 联合频道等直接砍掉 |
| **Windows 一等公民的代价** | 路径、信号、管道、换行、编码 | 从第一天在 Windows 上开发，不要事后移植 |
| **自己写调度容易出 bug** | 无限循环、重复劳动 | 熔断从 B-M0 就在，不要留到 M2 |

---

## 7. 建议：把路线 A 当作路线 B 的一个 runtime

这是我在调研后最强的建议。

```
路线 B 的架构（自己的 daemon / 领域模型 / CLI / UI）
        │
        └── RuntimeAdapter
              ├── ACP ──▶ dsh --profile acp      ← 第一天就能用（你本机已有）
              ├── ACP ──▶ claude-agent-acp       ← 加一行配置
              ├── ACP ──▶ codex-acp              ← 加一行配置
              └── CLI ──▶ antigravity 等          ← 兜底
```

这样你**同时得到两条路的优点**：

| 得到 | 来自 |
|---|---|
| 快速起步（DSH 现成可用） | A |
| 不碰 experimental 包 | B |
| 多 runtime 横向扩展 | B（ACP） |
| 自己的领域模型与控制面 | B |
| DSH 的本地工作区能力 | A（作为 runtime） |
| 未来不受任何单一 harness 绑定 | B |

**代价**：路线 A 里那些「白拿」的 UI 组件（`dsh-client-ui-*`）你确实要自己重写。
但换来的是**架构上永远不会被锁死**。

**如果你要的是「尽快验证体验」→ 先做路线 A 的 A-M0/A-M1，把编排体验跑通。
如果你要的是「做出一款能长期迭代的产品」→ 直接走路线 B + DSH-as-runtime。**
