# DEV-10 真实认证轮报告：deepseek-flash 接入 + 启动路径安全 + 成员级 runtime 生产接线（2026-09-28）

预算口径（用户令 2026-09-28）：本轮批准**最多 2 个真实 turn**；探活/排错重试计入上限。
**实际消耗 2/2**：①一次**意外探活**（事故，见 §3.2——本意是零接触本地诊断，实际打到渠
道）；②一次完整的 fixture 只读分析 turn（全链成功）。**受控中断 turn 未执行**（预算耗尽），
其语义已有零额度回放覆盖，脚本就绪待批。

---

## 1. deepseek-flash 的实际接入结论及依据

**结论：deepseek-flash 经当前渠道（Claude Code 2.1.283 + `http://192.0.2.10` 代理 +
settings.json 环境凭据）可用；已按"显式 `--model deepseek-flash`"接入并完成一次真实全链
成功。认证范围仅限实测组合**：当前 Claude Code 版本（2.1.283）+ 当前 adapter 版本
（claude-cli-2.1.283-adapter-0.2）+ 当前渠道 + deepseek-flash + plan 只读档
（--allowedTools Read,Glob,Grep）。不扩大到其他 Claude 模型、其他渠道、其他权限档位。

依据链（零调用配置核对 + 实测）：

| 项 | 结论 | 依据 |
|---|---|---|
| 配置来源 | `~/.claude/settings.json` env 段：`ANTHROPIC_BASE_URL=http://192.0.2.10` + `ANTHROPIC_AUTH_TOKEN`（未读取值、未输出）；无项目级/受管设置覆盖；进程 env 无 ANTHROPIC_*/CLAUDE_* | 脱敏结构化读取 |
| 模型选择链 | `--model` CLI 参数 > settings `model`（当前 `ox-alpha-free[1M]`，会变）> `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` 槽映射（如 opus→`deepseek/deepseek-v4.1-flash[1M]`）。我们的 adapter 用显式 `--model`，最高优先级 | settings 结构 + CLI 帮助 |
| 渠道识别 | `GET /v1/models`（配置级探测，零模型调用）返回 7 个：**`deepseek-flash` 在列**（另有 `deepseek/deepseek-v4.1-flash`、`glm-5.3`、`glm-5`、`glm-5.3-flash`、`xiaomi/mimo-v2.6-flash/pro`）；`deepseek-flash[1m]` **不在列**（`[1m]` 是 CLI 侧上下文窗口后缀语法，非渠道模型名） | 渠道 models 端点 |
| unrecognized_model 来源 | **服务端错误的 CLI 透传**，不是 CLI 本地白名单拦截：二进制取证（245MB 原生 exe 内嵌 JS）找到 `[claude-code:unrecognized_model]` 信号函数——处理 API 错误事件并记 `tengu_api_unrecognized_model` 遥测；另见交互侧 `alias_1m_unsupported`（"X doesn't have a 1M context window…"）属模型选择器本地别名校验，非 headless -p 路径 | 二进制字符串取证（偏移 209459678 等 7 处） |
| 此前"deepseek-flash[1m] 失败后回退成功"记录 | 不能证明裸名不可用（裸名在渠道清单中），也不能证明回退回复来自指定模型——与用户判断一致 | 上述渠道清单 + 回退时无响应模型留存 |
| 实测可用性 | 探活调用（§3.2）：assistant 消息报 `model:"deepseek-flash"`，result 带 usage/cost/session_id，exit 0；turn1（§3.1）全链成功 | 真实证据文件 |

**模型名纪律**：adapter 只接受渠道裸模型名（`/^[A-Za-z0-9][A-Za-z0-9._/-]*$/`），**拒绝
`[1m]` 类后缀语法**（VALIDATION_INVALID）——杜绝把后缀语法误发渠道。别名映射接入必须
有渠道文档或可核对模型元数据依据，本轮未做也不需要（裸名直用）。

## 2. 模型回退：是否发生、如何处理

- **未发生回退**。两次真实调用的响应均未映射到其他模型：探活调用的 assistant 消息显式
  报 `model:"deepseek-flash"`；turn1 响应模型字段未留存（当时实现只读 result.model，而
  本次 result 不带 model——已修复，见下），但请求侧 `--model deepseek-flash` 显式、渠道
  清单含该名、输出内容与 fixture 一致。
- **`unrecognized_model` stderr 告警在成功 turn 上也会出现**（探活取证：`query_source=sdk`，
  SDK 侧校验噪音）。原实现会在该签名上判 PROVIDER_LIMITED 失败——已修正：该告警只进
  stderrTail 取证，**不终结 turn；是否回退以响应报文为准**（assistant.message.model /
  result.model 原样记录，报什么记什么）。若响应报了其他模型名或映射发生 → 该次不计为
  deepseek-flash 通过（本轮未出现此情形）。
- **响应模型取证补强**：result.model 缺失时回退读 assistant 消息内报模型（实测组合：
  result 无 model、assistant.message.model 有）。两者都无 → 如实 undefined，报告写明
  "实际后端模型无法独立确认"。usage_records.normalized_json 落库完整事件（含 model）。

## 3. 真实调用结果、实际消耗与证据（如实记账）

### 3.1 turn1：fixture 只读分析全链（成功）✅

- 路径：`node scripts/dev10-real-auth.ts turn1` → 正式 `startDaemon`（in-process）→ 命名
  管道 + 凭据握手 → `member.setRuntime(m, claude, deepseek-flash, plan)` →
  `message.submit` → worker 按成员绑定选 ClaudeCliAdapter → spawn 原生 claude.exe
  （prompt 经 stdin）→ stream-json → TaskComplete 校验 → 交付。
- 结果：**task DONE / turn SUCCEEDED / run SUCCEEDED**；暗号 `ZS-DEV10-CLAUDE-7749` 原样
  回流（真实读取了 notes.md）；resultKey 匹配（`result_<turnId>`，不匹配不可能 DONE）；
  delivery revision 1 创建（auto_deliver）；回复含 3 条要点 + 可疑点（日志空窗）。
- **实际消耗（usage 如实）**：input **20,875** tokens、cache read **53,760** tokens、
  output **11,822** tokens（含多轮工具调用与 thinking）；CLI 估算成本 **$0.4268**
  （estimated，非渠道账单）；耗时 55.6s。
- 证据：`%TEMP%/zhongshuo-dev10-real/evidence-turn1.json`（checks 全 true）。
- 诚实备注：模型自报的 executedVerifications 含 `ls`/`sha256sum` 等 shell 命令——不在
  本档 allowedTools（Read,Glob,Grep）内，疑为模型夸大陈述；程序侧不采信自报验证（这正是
  输出合同把 executedVerifications 定为 agent 自报字段的原因）。

### 3.2 意外探活（事故记录，计入预算）⚠️

- 本意：对**关闭端口**（`ANTHROPIC_BASE_URL=http://127.0.0.1:9` + 无效 token）做零接触
  诊断，验证 `--verbose` 参数修复。**实际仍打到真实渠道**：Claude Code 的
  **settings.json env 优先于子进程环境变量**（informational 行明示 "your requests go
  through 192.0.2.10"）——环境变量覆盖法对该 CLI 无效。
- 消耗：input 19,649 / output 少量；CLI 估算 $0.0995；model=deepseek-flash 成功。
- 教训已入 memory：今后任何"网络隔离诊断"不得依赖子进程 env 覆盖 settings env；可选
  手段=临时 HOME 重定向（会脱离用户渠道配置，需另行评估）或干脆不跑、直接读二进制/文档。
- 该次调用按用户口径（探活计入上限）占预算 1 格。

### 3.3 turn2：受控中断（未执行）❌→待批

预算耗尽未执行。已有覆盖：零额度回放 8 用例中的中断族（kill 后 close 兜底 failed、启动中
停止、迟到事件不终结）；harness `turn2` 脚本就绪（等 RUNNING → task.stop → 终态/进程
清单/迟到事件核验）。**待用户批准 1 次补做**。

### 3.4 预算外零消耗尝试（如实）

- turn1 第 1 次尝试：`member.setRuntime` 默认 executable='claude' 被 adapter 当显式路径
  → Windows shell:false 无法 spawn .cmd → ENOENT（RUNTIME_NOT_FOUND），**进程未起、零
  HTTP**。已修：非 exe 显式名回落默认入口解析（直指原生 claude.exe）。
- 关闭端口诊断第 1 次：CLI 参数校验即退（`--output-format=stream-json requires
  --verbose`，exit 1，stderr 一行）——**未出网**。已修：args 加 `--verbose`。
- 失败取证缺口修复：turn.failed 审计补 message（含 stderr 尾部 300 字符），不再只有
  code；adapter stderrTail 环形留存 2KB。

## 4. 启动参数安全处理及零额度反例

- **无 shell**：`spawn(entry, args, { shell:false, windowsHide:true })`；入口解析
  （`resolveClaudeExecutable`）：显式 .exe 直用；.cmd/.bat shim 解析出真实目标（exe 直
  用 / js 走 node 前缀）；默认解析 npm 全局**原生 claude.exe**
  （`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`，245MB 原生二
  进制，不经 .cmd、不经 shell）；Windows 下非 exe 显式名回落默认解析。
- **用户文本不进 argv**：prompt 全文经 **stdin** 原样传入（`-p` 无位置参数时读 stdin）；
  argv 只有固定 CLI 参数 + 模型名 + resume id，两者做字符集校验
  （`[1m]` 后缀/空白/引号/分号拒绝）。
- **零额度反例**（回放 16/16 内）：引号/单引号/反引号/`& | ^ % ! < > $VAR $(whoami) &&
  del /q`/中文/制表/CRLF 的 nastier 文本——断言 argv 精确等于
  `['-p','--output-format','stream-json','--verbose','--model','deepseek-flash',
  '--permission-mode','plan','--allowedTools','Read,Glob,Grep']`，stdin 收到**字节级原样**
  全文；shim 解析（exe/js 两型）；`[1m]` 模型名拒绝；非法 resume id 拒绝。
- **resultKey 回放闭环**（用户指出的欠账已清）：Claude 回放模拟器**读取本轮 stdin 输入**，
  从输出契约行解析 `"resultKey":"result_<turnId>"` 构造匹配 TaskComplete → 共用 worker
  schema 校验通过 → **DONE + 交付创建**——跨 runtime 成功链路不再停在 OUTPUT_INVALID；
  保留错误 resultKey 反例（turn.outputInvalid、任务不 DONE、不冒充完成）。

## 5. 跨 runtime 成员绑定：已进入正式 entry ✅

- **生产链路**（不再只是测试注入）：`member.setRuntime`/`member.runtime` 正式 daemon 命令
  → 绑定链落库 `project_members.profile_id → agent_profiles.runtime_installation_id →
  runtime_installations`（schema 001 已有表，本轮首次投入使用；模型/权限档在
  agent_profiles.settings_json）→ `MemberRuntimeRegistry`（src/daemon/memberRuntime.ts，
  按 installation+model+permissionMode 缓存实例）→ `DispatchWorkerOptions.adapterFor`
  （DIRECT 与 DELIBERATE 两条派发路径 + live 表 + interruptTurn + consumeUntilTerminal
  全部按成员取 adapter）→ entry.ts 构建（claude/codex 工厂常注、fake 仅 ZS_ALLOW_FAKE=1）。
  **未绑定成员回落全局默认 adapter（ZS_RUNTIME 语义保留）**；绑定了 daemon 未注册的
  kind → 派发如实抛错，不静默换 runtime。
- 同一项目允许成员 A 绑 codex、成员 B 绑 claude（模型各自配置）；turn1 即经此生产链路
  跑通（成员配置驱动，非全局 ZS_RUNTIME）。
- **能力分开记录**：runtime_installations.capabilities_json 分列
  `toolCapabilities`（三态）/ `modelAvailability`（configured-unverified）/ `permissionAuth`
  （unverified）——不因配置成功或回复成功整体升级。
- daemon stop 收拢：registry.disposeAll()（默认+成员级 adapter 逐一 dispose/closeAll）。
- ui/main.ts 同步支持 ZS_RUNTIME=claude。

## 6. 仍未认证的能力与具体下一步

| 项 | 状态 | 下一步 |
|---|---|---|
| 受控中断真实认证 | 未执行（预算耗尽） | 待批 1 次调用：`node scripts/dev10-real-auth.ts turn2`（脚本就绪） |
| resumeSession（--resume 真实续接） | 回放已验、真实未认证 | turn2 后可顺带：同会话第二 turn 观察上下文延续（需另计预算） |
| interactiveApprovals（审批通道） | unverified | headless 只读档未开审批；B6 权限档扩展时一并做 |
| steerActiveTurn | unsupported（明确拒绝，不模拟） | 无计划（进程模型限制） |
| usageCost | supported（CLI 估算，costQuality=estimated） | 渠道真实账单对账属渠道侧事务，不属 adapter |
| deepseek-flash 之外的模型（glm-5.3 等） | 渠道在列、未实测 | 需要时按成员绑定逐个认证 |
| M1 价值对比 33 调用 | **本轮未批准、未动用** | 等用户批准后执行（fixture+hash 先固化） |

## 7. 本轮代码清单

- `src/adapter/claude/cliAdapter.ts`：入口解析/shell:false/stdin 传 prompt/模型与 resume id
  字符集校验/--verbose/stderr 政策（unrecognized_model 不终结、认证类致命）/cost 映射
  （estimated）/响应模型双源取证（result.model → assistant.message.model）/stderrTail/
  disposeAll（adapter-0.2）。
- `src/contracts/runtime.ts`：usage.updated 增可选 `model`（中性取证字段）。
- `src/daemon/memberRuntime.ts`（新）：绑定链读取 + MemberRuntimeRegistry + disposeAll。
- `src/daemon/dispatchWorker.ts`：adapterFor 成员级选择（两派发路径/live/interrupt/
  consumeUntilTerminal/stoppingRace）；turn.failed 审计补 message。
- `src/daemon/entry.ts`：runtime 三态（fake|codex|claude）+ registry 工厂接线 + 收拢；
  `src/ui/main.ts` 同步。
- `src/daemon/commands.ts`：`member.setRuntime` / `member.runtime` 命令。
- `scripts/dev10-real-auth.ts`（新）：真实认证 harness（turn1/turn2/status，ZS_DEV10_REHEARSE
  零额度彩排档）。
- 测试：claudeCliReplay 13 用例（新增启动安全 4 + 告警不终结 + probe 版本）、
  claudeWorkerIntegration 3 用例（生产 registry 全链 DONE + 错误 resultKey 反例 + 不可用
  kind 拒绝）；全套 **360/360**、typecheck/lint 0。
- 证据：`%TEMP%/zhongshuo-dev10-real/evidence-turn1.json`（及 rehearsal/诊断输出）。
