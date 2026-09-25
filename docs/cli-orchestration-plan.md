# 轻量编排方案：用现成 CLI 跑多 AI 互评

> 状态：**方案待确认，尚未写任何代码。**
> 与 `docs/agent-room/` 四份文档的关系：那四份是「完整替代 Raft」的重方案（daemon / 事件日志 / worktree 隔离），
> **本文是它们的轻量替代**——不造执行层、不造持久层，只写编排。
>
> 本文所有 CLI 行为均为**本机实测**（2026-09 环境），命令与返回值逐条跑过，非文档推测。
> 标 ⚠️ 的是实测踩到的坑，标 ❓ 的是尚未验证、需要动手前先确认的。

---

## 1. 目标与非目标

### 目标

让多个 AI CLI **在同一个问题上互相看见、互相挑刺、最后收敛出一个结论**，
整个过程由一个薄脚本驱动，输出直接可读。

### 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 自己调模型 API | 那就是自己写 L1（agent loop / 工具 / 沙箱 / 重试 / 压缩），一个季度起步 |
| daemon、房间对象、事件日志 | 只有单机、单人、一次性会话，不需要跨进程持久化 |
| worktree 隔离、任务看板、预算面板 | 没有并发的写操作需要隔离 |
| 桌面壳 / Web UI | 终端输出足够 |
| 替代 Raft | 目标只是"验证辩论是否真的让答案更好" |

### 判断标准（写歪了的信号）

> **脚本里如果出现 `http` 请求、`tool_calls` 解析、或者自己读写文件当上下文，就是写歪了。**
> 那些都是 CLI 已经做完的事。

---

## 2. 实测结论：四个 CLI 的真实能力矩阵

### 2.1 基本可用性

| CLI | 版本 | 非交互入口 | 实测 | 耗时 |
|---|---|---|---|---|
| `claude` | 2.1.268 | `claude -p "..."` | ✅ 返回 `CLAUDE_OK` | 3s |
| `codex` | 0.154.0 | `codex exec "..."` | ✅ 返回 `CODEX_OK` | 21s |
| `grok` | — | `grok -p "..."` | ✅ 返回 `GROK_OK` | — |
| `dsh` | 0.1.5-rc.1 | `dsh --profile headless "..."` | ✅ 返回 `DSH_OK` | — |

四者**都从 stdin 读 prompt**（实测 `"提示词" | claude -p` 和 `| codex exec` 均正常），
所以长提示词一律走管道或文件，不要塞进命令行参数（见 §5.1）。

### 2.2 上下文保持能力 ⚠️ 差异很大

| CLI | 新会话 | 续会话 | 实测结果 |
|---|---|---|---|
| `claude` | `--session-id <uuid>` | `--resume <uuid>` | ✅ 记住 `42` |
| `codex` | 从 `--json` 的 `thread_id` 取 | `codex exec resume <id> "..."` | ✅ 记住 `1234` |
| `grok` | `--session-id <uuid>` | `--resume <uuid>` | ✅ 记住 `99` |
| `dsh` | ❌ 无 | ❌ **无** | 只有 `-h/--help`，**不支持续会话** |

**`dsh --profile headless` 是一次性的**——它的 help 只有：
```
Usage: dsh --profile headless [options] [task...]
Options:
  -h, --help  show this help
```
没有 resume、没有 model、没有结构化输出。**要么每轮重喂上下文，要么改用 `dsh --profile acp`。**
这直接决定了 §4.2 的进程模型选择。

### 2.3 结构化输出

| CLI | 机制 | 实测结果 |
|---|---|---|
| `claude` | `--json-schema '<inline json>'` | ✅ 真按 schema 返回 |
| `grok` | `--json-schema '<inline json>'` | ✅ 但结果是**套在 `text` 字段里的字符串**，要二次 parse |
| `codex` | `--output-schema <文件>` | ⚠️ **不强制**——返回被 ```json 围栏包住，不是合法 JSON |
| `dsh` | ❌ 无 | 只能读 stdout 再自己解析 |

### 2.4 计量与预算（实测字段名）

**`claude --output-format json`** 返回可直接解析的单对象：
```
result            ← 答案正文
is_error          ← 失败判定，不用猜退出码
session_id        ← 下次 --resume 用
total_cost_usd    ← 0.094585（实测值）
num_turns
usage.input_tokens / cache_read_input_tokens / output_tokens
usage.output_tokens_details.thinking_tokens
modelUsage / stop_reason / permission_denials / num_turns
```
另外 `--max-budget-usd <amount>` 是**原生的美元预算硬闸**。

**`codex exec --json`** 是 JSONL 事件流，含：
```
{"type":"thread.started","thread_id":"..."}
{"type":"turn.completed","usage":{"input_tokens":13504,"cached_input_tokens":13312,"output_tokens":23}}
```

**`grok --output-format json`** 返回：
```
text / thought / sessionId / stopReason / num_turns
total_cost_usd / total_cost_usd_ticks
usage.{input_tokens,output_tokens,reasoning_tokens,total_tokens,cache_read_input_tokens}
modelUsage.{<model>:{costUSD,...}}
```

### 2.5 实测基线成本 ⚠️ 决定了整个设计的性价比

单次"hi"的真实开销：

| CLI | 输入 tokens | 输出 | 实测费用 |
|---|---|---|---|
| `claude`（默认） | **18,772** | 29 | **$0.0946** |
| `claude --bare` | **1,132** | 166 | **$0.0098** |
| `codex exec` | 13,504（其中 13,312 命中缓存） | 23 | — |
| `grok -p` | 12,322 | 49 | $0.0085 |

**`claude --bare` 比默认便宜约 10 倍**（输入从 18.7k 降到 1.1k）。
实测 `--bare` **仍能正常用工具**：
```powershell
claude --bare -p "Read README.md, reply with ONLY its first heading" --allowedTools "Read"
# → # 众说 · 本地群聊多 Agent 协同编排
```

默认模式那 18.7k 的来源已查明：本机无全局/项目 `CLAUDE.md`，但启用了插件
`raft-channel@raft`（来自 `botiverse/raft-external-agents` 市场），加上 skills 与工具定义。

> **结论：机械性角色（写方案、按模板挑刺）一律用 `--bare`；需要读代码库干活时才用默认模式。**

---

## 3. 架构：只写 L3

沿用 `00-shared-spec.md` 的分层，但把上下三层全部删掉：

```
L4 表现层   ❌ 不要（终端输出即可）
L3 编排层   ✅ 唯一要写的：调度顺序 · 上下文装配 · 熔断
L2 持久层   ❌ 不要（用 CLI 自带的 session，或干脆不用）
L1 执行层   ✅ 全部外包给四个 CLI，一行不碰
```

### 3.1 角色设计

四个角色，每个绑定一个 CLI。默认配置（可改）：

| 角色 | 默认 CLI | 模式 | 职责 |
|---|---|---|---|
| 方案手 A | `claude` | `--bare` | 独立出一版方案 |
| 方案手 B | `grok` | `-p` | 独立出一版方案（**与 A 不同模型**） |
| 评审 | `codex` | `exec` | 对两版方案挑刺、给结构化 verdict |
| 裁决 | `claude` | 默认模式 | 综合分歧点，出最终结论 |

**为什么 A/B 要用不同厂商的模型**：同源模型的盲区高度相关，
两个 DeepSeek 互相评审容易一起漏掉同一个东西。异源互评才有增量。
（本机可用：claude 中继有 `deepseek/deepseek-v4.1-flash`、`glm-5`、`glm-5.3-flash`、`deepseek-flash`；
codex 走 `deepseek/deepseek-v4.1-flash`；grok 有 `grok-4.5` / `grok-4.6`。）

### 3.2 流程（三轮，可配）

```
        人给题目
           │
   ┌───────┴───────┐
   ▼               ▼
 方案手 A        方案手 B          ← 第 1 轮：并行，互不可见（防锚定）
   │               │
   └───────┬───────┘
           ▼
   ┌───────┴───────┐
   ▼               ▼
 A 看 B 的方案    B 看 A 的方案      ← 第 2 轮：并行交叉评审
 提意见          提意见
   │               │
   └───────┬───────┘
           ▼
        评审 C                     ← 第 3 轮：汇总分歧，出结构化结论
           ▼
        裁决 D（可选）              ← 只在 C 判定"有硬分歧"时才跑
           ▼
        终端输出
```

**第 1 轮必须互不可见。** 这是整个流程的关键：如果 B 先看了 A 的方案，
它就会沿着 A 的框架走，两个方案高度趋同，第 2 轮的评审就变成走过场。

### 3.3 并行与串行

| 轮次 | 并行？ | 理由 |
|---|---|---|
| 第 1 轮 | ✅ 并行 | A、B 必须互不影响 |
| 第 2 轮 | ✅ 并行 | A 评 B、B 评 A，互不依赖 |
| 第 3 轮 | ❌ 串行 | 要等两边的评审都回来 |
| 第 4 轮 | 条件触发 | 只在评审报"硬分歧"时跑 |

并行用 PowerShell `Start-Job` 或 Node `Promise.all` 都行。
**注意并行会让成本同时到达**，熔断必须在派发前检查，不是派发后（见 §4.4）。

---

## 4. 关键设计决策

### 4.1 上下文装配（最重要的一节）

**这是成本的唯一决定因素，也是 `00-shared-spec.md` §3.4 唯一值得保留的部分。**

每个 CLI 每次调用都是一个**全新进程**，不主动喂它就不记得任何东西。
所以每一轮"喂什么"必须显式规定：

| 轮次 | 喂给谁 | 内容 |
|---|---|---|
| 第 1 轮 | A / B | **只给题目**，不给任何其他人的输出 |
| 第 2 轮 | A | 题目 + A 自己的方案 + **B 的方案全文** |
| 第 2 轮 | B | 题目 + B 自己的方案 + **A 的方案全文** |
| 第 3 轮 | 评审 | 题目 + 两版方案 + 两份评审意见 |
| 第 4 轮 | 裁决 | 评审的结构化结论 + 分歧点 |

**绝不喂全量历史。** 也**绝不把上一轮的原始 stdout 直接拼进去**——
claude 的 `--output-format json` 会带 `modelUsage`、`permission_denials` 等一堆元数据，
直接拼会把 token 白白放大数倍。**取 `.result` 字段再拼。**

> 这正好呼应 `00-shared-spec.md` §3.4 的结论：
> 「全量历史 → token 爆炸 + 互相污染 + 成本失控」。轻量方案里这条依然成立，
> 而且因为没有事件日志兜底，**只能靠装配规则本身控制**。

### 4.2 进程模型：无状态，还是用 resume？

两条路：

| | **无状态（每轮新进程）** | **有状态（resume）** |
|---|---|---|
| 实现 | 每轮把该喂的上下文拼进 prompt | 首轮 `--session-id`，后续 `--resume` |
| 覆盖度 | 四个 CLI **全部支持** | `dsh` 不支持；`codex resume` 有坑（见 §5.4） |
| 行为 | 完全可预测 | 依赖 CLI 内部状态，可能漂移 |
| 成本 | 每轮重付一次上下文 | 可能命中缓存，更便宜 |
| 与 L3 的关系 | 装配规则就是全部 | 状态藏在 CLI 里，装配规则变模糊 |

**推荐：先用无状态。**

理由：它让"喂什么"完全落在你自己手里——而这正是本方案唯一的价值所在；
四个 CLI 行为一致，没有例外分支；调试时看到的输入就是全部输入。
等跑顺了、发现重复喂上下文太贵，再对 claude/grok 单独开 resume 优化。

### 4.3 输出归一化

四个 CLI 的输出格式完全不同，需要一层薄适配：

```
claude  →  ConvertFrom-Json → .result
grok    →  ConvertFrom-Json → .text  （若用了 --json-schema，还要再 parse 一次）
codex   →  读 -o 指定的文件（推荐），或从 --json 流里取最后一条 agent_message
dsh     →  直接读 stdout
```

**`codex` 一律用 `-o <文件>` 拿结果，不要解析 JSONL。**
实测 `-o` 写出的文件内容就是干净的最终回答（`CODEX_OK`，一个字符不多），
而 `--json` 流里混着 `item.completed` / `turn.completed` 等事件，解析成本高得多。

### 4.4 熔断（必须在第一版就有）

多 AI 互相接话最容易失控。以下全部在**派发前**检查：

| 机制 | 建议默认 | 说明 |
|---|---|---|
| `maxRounds` | 3 | 硬上限，第 3 轮后强制收敛 |
| `maxCostUSD` | 可配 | 用 `total_cost_usd` 累计；claude 另有原生 `--max-budget-usd` |
| `maxTokensPerCall` | 可配 | 用 `usage` 字段累计 |
| `timeoutPerCall` | 300s | ⚠️ 实测 claude 配置错误时会**一直挂到超时**，必须有超时 |
| 循环检测 | 开 | 第 2 轮意见若与第 1 轮语义重复，直接跳到评审 |
| 全局急停 | — | Ctrl+C 要能杀掉所有子进程（注意并行时不止一个） |

**超预算时的降级**：不是报错停下，而是跳过第 4 轮、直接输出评审结论。

---

## 5. 实测踩到的坑

### 5.1 ⚠️ PowerShell 引号：最烦的一个

`claude --json-schema` 和 `grok --json-schema` 都要求**内联** JSON，
但 PowerShell 会把内联 JSON 的引号吃掉：

```powershell
# ❌ 失败：Error: --json-schema is not valid JSON: Expected '}'
claude -p "..." --json-schema '{"type":"object"}' --output-format json

# ✅ 成功：反斜杠转义
$schema = '{\"type\":\"object\",\"properties\":{\"verdict\":{\"type\":\"string\"}},\"required\":[\"verdict\"]}'
claude -p "..." --json-schema $schema --output-format json
```

**规避方式（按推荐度）**：
1. 长 prompt 走 stdin（实测四个 CLI 都支持），彻底绕开命令行长度与引号问题
2. 结构化输出的 prompt 不用 `--json-schema`，改为在 prompt 里要求 JSON，然后自己 parse
3. 必须用 `--json-schema` 时，用反斜杠转义形式

### 5.2 ⚠️ 当前目录不是 git 仓库

`D:\众说` **不是** git 仓库（`git rev-parse` 失败）。
`codex` 因此必须带 `--skip-git-repo-check`，否则报
`Not inside a trusted directory and --skip-git-repo-check was not specified`。

### 5.3 ⚠️ `codex exec resume` 的 flag 集合不同

`codex exec resume` **不接受 `-s/--sandbox`**（报 `unexpected argument '-s' found`）。
它有自己的 flag 集：`--skip-git-repo-check`、`-o`、`--json`、`-m`、`-i`、`-c`、
`--ephemeral`、`--output-schema`、`--worktree`、`--last`、`--all`。

**安全含义**：resume 时无法显式指定沙箱策略，只能用配置默认值。
如果打算让 codex 动手改代码，这一点要先想清楚。

### 5.4 ⚠️ `codex --output-schema` 不强制

实测它会返回被 ```json 围栏包住的文本，**不是合法 JSON**。
无论有没有用 schema，都要：剥围栏 → `ConvertFrom-Json` → 失败则重试或降级。
不要相信 schema 一定生效。

### 5.5 ⚠️ stderr 有噪音，但 stdout 干净

claude 会往 stderr 打 `unrecognized_model`（它在猜上下文窗口），
codex 会打 `Model metadata not found`。**都只影响 stderr**，
stdout 与退出码正常（实测全部 `exit 0`）。

**所以：脚本里一律 `2>$null`（或重定向到日志），只读 stdout。**

### 5.6 ⚠️ Windows 上的可执行文件路径

`.ps1` / `.cmd` shim 在 Node 里 spawn 容易出问题（实测 `spawnSync("claude.cmd", ..., {shell:false})` 报 `EINVAL`；
`shell:true` 又会把内联 JSON 重新拆开）。稳妥做法是直接指向真实可执行文件：

```
claude → C:\Users\user\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
codex  → C:\Users\user\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js   （用 node 跑）
grok   → C:\Users\user\AppData\Roaming\npm\node_modules\@xai-official\grok\bin\grok
dsh    → C:\Users\user\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js  （用 node 跑）
```

> ❓ 待确认：若脚本在受限沙箱下运行，Node 用 `stdio:'pipe'` 捕获子进程输出会 EPERM。
> 当前是 `danger-full-access`，不受影响；但换环境要留意。

### 5.7 ❓ 未验证项

- 并行跑 3–4 个 CLI 时的实际稳定性与互相影响（本机中继的并发能力未知）
- `claude --bare` 在**需要读多个文件**的任务上是否仍够用（只测了单文件读取）
- claude 中继 `192.0.2.10` 在高并发下是否会限流
- grok 的 `--max-turns` 实际行为

---

## 6. 交付物形态

### 目录

```
D:\众说\
├─ room.config.json        # 角色 → CLI 映射、轮次、预算上限
├─ room.ps1                # 编排脚本（约 100–200 行）
├─ prompts\                # 各角色提示词模板（纯文本，可单独改）
│   ├─ proposer.md
│   ├─ critic.md
│   └─ judge.md
└─ runs\<时间戳>\          # 每次运行的产物
    ├─ round1-a.md
    ├─ round1-b.md
    ├─ round2-a-critique.md
    ├─ round2-b-critique.md
    ├─ verdict.json
    └─ transcript.md       # 汇总，给人读
```

**`prompts/` 必须外置成纯文本。** 改提示词是这套东西最高频的操作，
埋在脚本里字符串里改一次要动代码。

### `room.config.json` 草案

```json
{
  "topic": "",
  "maxRounds": 3,
  "maxCostUSD": 2.0,
  "timeoutPerCallSec": 300,
  "roles": {
    "proposerA": { "cli": "claude", "mode": "bare",   "model": "deepseek/deepseek-v4.1-flash" },
    "proposerB": { "cli": "grok",   "mode": "print",  "model": "grok-4.6" },
    "critic":    { "cli": "codex",  "mode": "exec",   "model": "deepseek/deepseek-v4.1-flash" },
    "judge":     { "cli": "claude", "mode": "default","model": "deepseek/deepseek-v4.1-flash" }
  }
}
```

### 脚本骨架（伪码，**不是最终实现**）

```
读 config → 建 runs/<时间戳>/
成本 = 0

# 第 1 轮：并行，互不可见
[方案A, 方案B] = 并行(
    cli(proposerA, prompts/proposer.md + 题目),
    cli(proposerB, prompts/proposer.md + 题目)
)

# 第 2 轮：并行交叉评审
[意见A, 意见B] = 并行(
    cli(proposerA, prompts/critic.md + 题目 + 方案A + 方案B),
    cli(proposerB, prompts/critic.md + 题目 + 方案B + 方案A)
)

# 熔断检查（派发前，不是派发后）
if 成本 > maxCostUSD: 降级输出并退出

# 第 3 轮：串行汇总
裁决 = cli(critic, prompts/judge.md + 题目 + 方案A + 方案B + 意见A + 意见B)

# 第 4 轮：条件触发
if 裁决.有硬分歧 and 轮次 < maxRounds:
    最终 = cli(judge, ...)
else:
    最终 = 裁决

写 transcript.md → 打印
```

**统一出口 `cli(角色, 完整prompt) -> {文本, 费用, tokens}`**：
所有 CLI 的差异（参数拼装、结果提取、错误处理）都关在这一个函数里。
换 CLI、加 CLI 只动这里。

---

## 7. 里程碑

### M0 · 打通链路（半天）
- [ ] 写 `cli()` 统一出口，四个 CLI 各跑通一次"输入问题 → 拿到干净文本"
- [ ] 验证 `--bare` 与默认模式的成本差异在真实任务上是否成立
- [ ] 输出归一化：确认四种格式都能稳定拿到纯文本

**验收**：`./room.ps1 -Test` 依次调用四个 CLI，各返回一句话，全部成功。

### M1 · 三轮流程（1 天）
- [ ] 第 1/2 轮并行派发
- [ ] 提示词外置到 `prompts/`
- [ ] `runs/<时间戳>/` 落盘 + `transcript.md` 汇总
- [ ] 熔断：`maxRounds` / `maxCostUSD` / 超时

**验收**：拿一个真实纠结的问题跑完整流程，产出一份可读的 `transcript.md`。

### M2 · 调优（按需，不预设）
- [ ] 对比"三轮辩论"与"单模型直接回答"的质量差异 —— **这才是本项目的真正目的**
- [ ] 若上下文重复喂太贵，再对 claude/grok 开 resume
- [ ] 只在确有收益时才加第 4 轮

**决策闸门**：如果辩论出来的答案**并不比单模型更好**，这个项目就该停在这里，
而不是继续加功能。这正是最初那句"用 dsh 验证想法"的真正含义。

---

## 8. 与原四份文档的关系

| 文档 | 处置 |
|---|---|
| `00-shared-spec.md` §3.3 熔断 | ✅ **保留**，§4.4 直接沿用其默认值 |
| `00-shared-spec.md` §3.4 上下文装配 | ✅ **保留**，§4.1 是其轻量化版本 |
| `00-shared-spec.md` 其余 | 📦 归档（Raft 能力对齐表，本项目不需要） |
| `01-plan-a-dsh.md` | 📦 归档（DSH 插件路线） |
| `02-plan-b-daemon.md` | 📦 归档（daemon 路线） |
| `03-compare-and-decide.md` | 📦 归档（两条路线都不走） |

**注意**：原文档里有个事实错误需要同时修正——
`README.md` 第 114 行称 `@deepseek-ai/dsh-experimental-agent-team`「本机 DSH 里有」，
但实测本机两处 `node_modules`（各 239 / 249 个包）**均未安装该包**，它在 npm 上独立发布
（`0.1.5-alpha.2` / `rc.1` / `rc.2`），且**未随 DSH 一起安装**。

---

## 9. 待你确认的问题

1. **角色分配**：A/B/C/D 四个角色绑哪个 CLI、哪个模型？（§3.1 是默认建议）
2. **进程模型**：先走无状态（§4.2 推荐），还是一开始就上 resume？
3. **脚本语言**：PowerShell（本机原生、无依赖）还是 Node.js（`@anthropic-ai` 等包已在本地，JSON 处理更顺）？
4. **输入方式**：题目从命令行参数传，还是从一个 `topic.md` 读？
5. **是否要保留 `dsh`**：它不支持续会话，只能当无状态角色用——要留吗？
6. **交付位置**：`D:\众说\` 根目录，还是新开 `tools/` 子目录？
