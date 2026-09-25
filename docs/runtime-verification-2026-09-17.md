# 众说 B 类技术验证报告

> 执行日期：2026-09-17 · 执行方式：本机实测（Windows 10.0.26200，Node 24.14.0）
> 测试目录：`D:\dev\zs-btest`（非同步盘，按 D1 建议）· 原始日志保留在该目录 `logs/`
> 真实模型调用共约 12 次（Codex 5 + Claude 7），均为小 prompt；费用约 $0.75（经中转，口径仅供参考）

## 0. 结论总览

| 项 | 内容 | 判定 |
|---|---|---|
| B1 | Codex 0.150.1（exec 通道 + App Server 协议探测） | ✅ C0/C1/C2 通过（附编码问题及修复） |
| B2 | Claude Code 2.1.267 headless | ✅ C0/C1/C2 通过 |
| B3 | Raft 1.0.32 动态行为只读采集 | ✅ 完成（真实 standing prompt 实物等；未向真实服务器发消息） |
| B4 | 双任务不串线预验证 | ✅ CLI 层通过（双 runtime 并发会话隔离 + 续接互不串线）；迟到事件路由属众说 daemon 职责，留 DEV-17 |
| B5 | ADR-14 影响确认 | ✅ 证据汇总完毕，维持 ADR-14（用户已知情选择） |

**一句话：两条已定的 runtime（Codex、Claude Code）在本机实测全部具备众说所需的会话隔离、续接、结构化输出与用量上报能力；Windows 适配的四个坑（.cmd 启动、stdin 挂起、非 git 目录、GBK 编码）都有明确解法。可以进入 DEV-01。**

## 1. B1 · Codex 0.150.1

### C0 检测
- 版本 `codex-cli 0.150.1`；npm 全局安装，`.cmd` shim 指向 `node …\@openai\codex\bin\codex.js`（内部再启动 vendor 原生 exe）。
- 凭据：未登录 OpenAI 官方（`codex login status` = Not logged in），但 `config.toml` 配置了 custom provider（`requires_openai_auth=false`），实测可用。
- `codex exec` 在非 git 目录必须加 `--skip-git-repo-check`（实测报错确认）。

### C1 对话与文件
- 冒烟：`codex exec --json --skip-git-repo-check "只输出两个字：正常"` → `正常`；中转网络不稳，重连 6 次后成功（279 秒）——调度必须容忍长尾。
- 事件流（`--json`）与设计 §9.4 规范化事件**天然对应**：`thread.started(thread_id)` → `turn.started` → `item.completed(reasoning / command_execution / agent_message)` → `turn.completed(usage: input/cached_input/output/reasoning tokens)`。
- 文件读取：默认沙箱允许在 cwd 执行 PowerShell 读文件，**但 PowerShell 把 UTF-8 文件按 GBK 解码，424242 变成 24242**（模型忠实转述了乱码，不是模型错）。修复验证：提示词要求 `Get-Content -Encoding UTF8` → 正确返回 424242。
- **设计含义（回写 §9.5/§13.2）**：不能依赖 runtime 的 shell 通道转述文件内容；众说应优先经 ContextBundle 直接提供文件内容或校验性 hash。

### C2 会话隔离与续接（兼 B4）
- 并发两个会话各记暗号：A=`SIGMA-5`（thread `01a0afcf-2049-…`）、B=`TANGO-8`（thread `01a0afcf-2055-…`），thread_id 为 UUIDv7、互不相同。
- `codex exec resume <thread_id> "…"` 续接 A：正确回答 SIGMA-5，**并明确否认知道其他会话的暗号**。隔离 ✅ 续接 ✅。

### App Server 协议探测（不烧调用）
- 传输：**换行分隔 JSON-RPC over stdio**（LSP 帧格式被拒，报 deserialize 错误）。
- `initialize`（带 `clientInfo`）立即响应：返回 codexHome、platformFamily 等；并主动推送通知（如 `remoteControl/status/changed`，带 `emittedAtMs`）。
- `thread/start` 的精确参数 schema 未在探测窗口内确认 → **DEV-06 按官方 SDK/固定版本生成协议类型**（与设计 §9.2 的既有要求一致）。

## 2. B2 · Claude Code 2.1.267

### C0/C1
- 入口：npm shim 直指原生 `claude.exe`（比 codex 更干净）。
- 冒烟：`claude -p "…" --output-format json` → 结构化结果完整：`session_id / usage(含 cache_read) / total_cost_usd / result / num_turns / subtype`。
- 文件读取：第一次问"密码是多少"答"42"（模型截断/草率），明确要求引用原文后正确返回 `` `宇宙密码：424242` ``（附 `notes.md:3` 行号）——**再次证明交付必须关联真实内容校验（§5.4）**。
- `--output-format stream-json --verbose`：事件三类 `system`（init×3）/`assistant` /`result`，可直接映射 §9.4。

### C2 会话隔离与续接（兼 B4）
- `--session-id` **强制 UUID 格式**（非法值 219ms 快速失败，不浪费调用）。
- 并发两会话：A（uuid `aaaa…`）记 `BRAVO-9`、B（`bbbb…`）记 `KOALA-3`。
- `--resume <uuid>` 续接 A：回答 BRAVO-9 且明确说"只能看到本会话的暗号"；续接 B（stream-json）：KOALA-3。隔离 ✅ 续接 ✅（resume 时 cache_read≈25600 tokens，上下文确实恢复）。

### Windows 实测注意
- headless 启动会**等 stdin 3 秒**并告警；适配器必须显式重定向/关闭 stdin。
- 后端为中转（deepseek-flash），`costBasis:"unknown"` → 设计的 `reported/estimated/unknown` 三态费用口径是必要的。

## 3. B3 · Raft 1.0.32 动态行为（只读）

未向 `/liushoujing` 服务器发送任何消息；全部为本机文件/日志/进程的读取。

1. **真实 standing prompt 实物**：`~/.slock/cli-transport/<agentId>/<sessionId>/claude-system-prompt.md`（291 行），agent 为 `XP-claude-glm53f`。头部与 1.0.32 二进制模板逐字一致（含 "(former Slock)"），运行时上下文注入 Agent ID / Server ID / Computer（LSJ-XuanPai）/ Hostname / OS / Daemon 版本 / 工作空间路径——详解"仍需实机"的完整展开 prompt 就此闭环。
2. **每会话注入 CLI 包装器**：同一目录下有 `raft/raft.cmd/raft.ps1` 和 `slock/slock.cmd/slock.ps1`（兼容别名）——与提示词中"daemon injects a local raft CLI wrapper into PATH"互证。众说 `zs` CLI（§15.3）可采用同一模式。
3. **完整 CLI 命令面**（提示词实录，超出 42 篇文档目录）：`task assign/unassign/convert/delete`、`message resolve/react/search`、`reminder schedule/list/snooze/update/cancel/log`、`integration list/marketplace/login/env/invoke/app`、`wiki manifest/read/publish`（仅 Wiki Agent）、`inbox check`、`mention pending/notify/add`、`user info`、`auth whoami`、`version`（区分 daemon 与 CLI carrier）、内置应用 `system.reminder`/`system.cleaner`（MEMORY.md 过大告警）。
4. **Agent 工作空间**：`~/.slock/agents/<agentId>/`，本机 4 个 agent，各含 `MEMORY.md + notes/`（内容未读取，尊重私有记忆）。
5. **Daemon 日志**：检测到 6 个 runtime（claude、codex 0.150.1、grok 1.0.25、kimi-sdk 0.34.0-botiverse、pi/builtin 1.0.32）；`machine:runtime_account_usage:refresh` 每 ~16 分钟按 provider 刷新账号用量；升级重启时出现 "Lost connection — agents continue running locally"（本地韧性）。
6. **CODEX_BIN 原生入口**：Raft 直接用 vendor 原生 `codex.exe`，跳过 PATH/desktop 发现——与我们在 B1 的做法、以及设计 §9.5 的建议三方一致。

**未做**（需向真实服务器发消息/建测试 agent，涉及你的真实环境）：消息级 wake/inbox 投递时序、线程↔runtime 会话对应关系。如以后要做，按调查指南 §6 的最小观察实验执行。

## 4. B4 · 双任务不串线

- 已在 B1/B2 同时完成：**两个 runtime 各自的并发双会话 + 暗号交叉验证**，全部通过（A 只知 A 的暗号并否认其他会话）。
- 边界说明：本轮证明的是"CLI 层会话隔离与续接可靠"。迟到事件去重、输出路由到正确 threadId 是**众说 daemon 的职责**，属 DEV-17（fake adapter 双任务测试）范围，本轮不适用。

## 5. B5 · ADR-14 证据汇总

- 实测：codex exec **默认沙箱即可在 cwd 跑 PowerShell**（读文件即用 shell）——"分析成员可执行任意命令"的风险是真实的；Raft 托管更直接是 `approvalPolicy=never + danger-full-access`。
- 众说的实际防线 = 目录单写者 + 分析快照基线 + ChangeSet/diff 记录 + 调用预算；无权限强制拦截（ADR-14，用户知情选择）。
- 结论：**维持 ADR-14**。建议（非强制）：重要项目可在设置里把"分析任务"默认跑在快照工作区而非原目录，成本低一层保险。

## 6. 需回写设计报告的实测发现（建议随 v1.6 / C 类处理）

| # | 发现 | 去处 |
|---|---|---|
| 1 | Node 24 禁止直接 spawn `.cmd`（EINVAL）→ 必须解析到原生 exe / node 入口；Raft 亦如此（CODEX_BIN） | §9.5 |
| 2 | 子进程 stdin 必须显式 ignore/close：codex 会无限等 EOF（实测挂起 12 分钟），claude 等 3 秒并告警 | §9.5 |
| 3 | codex exec 非 git 目录需 `--skip-git-repo-check` | §9.5 |
| 4 | PowerShell 读 UTF-8 按 GBK 解码 → 数据损坏（424242→24242）；修复=显式 `-Encoding UTF8`；根治=文件内容经 ContextBundle 提供 | §9.5、§13.2 |
| 5 | claude `--session-id` 强制 UUID；resume 恢复上下文（cache_read 可观测） | §9.2 |
| 6 | codex `--json` 事件流与 §9.4 规范化事件一一映射；usage 含 cached_input_tokens | §9.4 |
| 7 | App Server 为换行 JSON-RPC；thread/start 参数需 DEV-06 固化 | §9.2 |
| 8 | 中转网络长尾（重连 6 次/4.7 分钟）与 `costBasis:unknown` | §10.4、§9.4 |
| 9 | Raft 完整 CLI 命令面实录（wiki 桥、inbox、mention、内置 system 应用等） | §15.3、§27 |
| 10 | 每会话注入 CLI 包装器目录模式 | §15.3 |

## 7. 环境与花费记录

- 时间：2026-09-17 22:22—23:50；fixture：`D:\dev\zs-btest`（notes.md 含"宇宙密码 424242"、calc.js）。
- 跑器：`run.mjs`（入口解析+stdin ignore）、`parse.mjs`、`appserver-probe.mjs`，日志在 `logs/`（*.log 保留原始 stdout/stderr）。
- 调用数：Codex 5 次（冒烟 1 + 双暗号 2 + 续接 1 + 文件 2，其中 1 次为编码对照）、Claude 7 次（冒烟 1 + 文件 2 + 双暗号 2 + 续接 2）；合计约 $0.75（中转口径）。
