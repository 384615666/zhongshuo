# DEV-10 第二 runtime（Claude Code）契约核对与环境状态（2026-09-28，零模型预算）

> **2026-09-28 第二轮修订**：下表"模型配置"行的初步判断已被真实取证修正——
> `deepseek-flash[1m]` 的 unrecognized_model 为**服务端错误透传**（渠道 /v1/models 不含带
> `[1m]` 后缀的名，含裸 `deepseek-flash`）；该告警在**成功** turn 上也会出现（SDK 噪音）。
> 渠道/模型选择链/二进制取证/实测结论见 reports/round-20260928-dev10-real-auth.md §1-§2。

## 一、本机环境检查（不读/不改凭据与全局配置）

| 项 | 结果 | 来源 |
|---|---|---|
| CLI 存在性 | ✅ `claude`（npm 全局：C:\Users\user\AppData\Roaming\npm\claude.cmd） | `where claude` |
| 版本 | **2.1.283 (Claude Code)** | `claude --version` |
| 认证状态 | ✅ 可执行（探活一次极小调用成功返回；计费侧以账单为准） | `claude -p "hi" --output-format text`（限时） |
| 模型配置 | ⚠️ 默认配置指向 `deepseek-flash[1m]`——CLI 报 `unrecognized_model` 后**回退**成功回复 | 探活输出 |
| 密钥/环境变量 | 未读取、未输出（进程 env 无 ANTHROPIC_*/CLAUDE_* 键） | `node -e Object.keys(process.env)` 过滤 |

**结论**：环境可用，但**必须显式 `--model`**（默认模型配置不被当前 CLI 接受；适配器以
`ZS_CLAUDE_MODEL` 注入，正式认证前不消费额外调用）。本检查共消耗 1 次极小真实调用。

## 二、与 contracts/runtime.ts 适配合同核对（零额度，基于 CLI 2.1.283 文档口径）

| 合同点 | Claude Code headless 对应 | 核对结论 |
|---|---|---|
| 启动/会话 | `claude -p --output-format stream-json`（单次进程即一会话；**无常驻 app-server**，与 Codex 不同） | 需 per-turn 进程模型：openSession=延迟 spawn；会话复用=同 thread 的 resume（`--resume`/session id） |
| turn 生命周期 | stream-json 事件流（init/message/result） | `result` 事件含 is_error/subtype → 映射 turn.completed/failed；**无显式 turn.started**（以首 message 事件近似，需在 adapter 内合成） |
| 中断 | 进程 SIGINT/SIGTERM（CLI 优雅终止并输出 result） | interrupt=杀进程+等待最终 result；超时窗=UNKNOWN 语义可复用 |
| 审批 | `--permission-mode` + 权限提示（headless 下默认拒绝/允许策略） | read-only 分析档=`--permission-mode` 受限；确认档需 tools 审批通道（2.x stream-json 有 permission_request 事件则映射，否则 M1 只开只读档——**待零额度回放核实**） |
| 用量 | result 事件 usage 字段（input/output tokens） | 映射 usage.updated ✓ |
| 身份/目标/输出/权限/预算边界 | 与 Codex 相同的 contracts 面 | 复用 RuntimeAdapter 接口；六边界由 worker/daemon 既有层承担，不因 runtime 改变 |

## 三、实施计划（不依赖账号的部分先行）

1. `src/adapter/claude/`：进程模型 adapter（openSession=记账、startTurn=spawn `claude -p
   --model $ZS_CLAUDE_MODEL --output-format stream-json`、事件归一化、interrupt=SIGINT+宽限）。
2. 零额度协议回放：`tests/fixtures/claude-protocol/`（stream-json 样例：init/message/result/
   error/permission_request 若有）+ mock CLI（.cmd shim 回放固定 JSON 行）。
3. 故障反例：进程不存在/非零退出/坏帧/超时无 result/中断后迟到 result。
4. 真实认证：**待用户确认模型与预算**（最小用例=probe+1 turn 只读分析+1 次中断，约 3 调用）。

## 四、能力矩阵登记（runtime-capability-matrix 同步）

- Claude Code 2.1.283：环境已确认可用（显式 --model）；契约核对完成（本文）；**适配实现与
  回放未开工**（本轮登记，下轮实施）；真实认证未开始。
- Codex 认证保留不变（未受本轮任何改动影响，未重跑）。
