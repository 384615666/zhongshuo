# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

- 更新：2026-09-27（DEV-06 修复轮 2 + 真实认证通过时点）
- 分支：`codex/full-implementation`；检查点：DEV-01 `8e88799` → DEV-02 `0feb053` → DEV-03 `30e5424` → DEV-04 `35df2f3` → DEV-05 `41b58dc` → DEV-17 `2535a74` → **修复轮**（见 git log）；全部已推送

## 刚完成

- **DEV-06 修复轮 2**：GPT 复核 7 项全整改（终态映射/turn 归属/生命周期+resume/TaskComplete 接入完成路径/B6 收紧/能力收窄/锁目录协议）；协议回放 mock 8 用例（零额度）；`pnpm check` 254/254。
- **真实认证通过（gpt-6-luna，e2e 4/4）**：C1 真实文件内容回流（ZS-DEV06-4242）+ 层 A 行为证据（ZS-ACK）；B6 计划档两路径（直接编辑：内容逐字节未变；shell：文件未创建）+ 工具失败证据。deepseek-flash 在当前渠道 400，已切 gpt-6-luna（ZS_E2E_MODEL 可覆盖）。详见 reports/dev-06-fixround2-result.md。

- **DEV-06 第一阶段**：codex 0.157.1 协议类型固化（generate-ts，tests/fixtures/codex-protocol/，已排除编译）、CodexAppServerAdapter（stdio 换行 JSON-RPC 全生命周期+§9.4 映射+审批通道）、e2e 隔离配置（pnpm test:e2e，默认套件不烧额度）。真实进程验证：probe/initialize/thread/start/turn/start/通知映射全通；**模型 turn 被额度限制阻断**（"try again at 12:29 PM"）——C1 文件回流与 B6 计划档未验证（B6 断言已收紧防额度冒充）。详见 reports/dev-06-stage1-result.md。

- **收口轮 2**：锁接管纪律（受控窗口三反例）、门禁覆盖已提交未领取（RT-02 门禁化）、interrupt 限时发送（hangInterrupt 反例）。
- **DEV-21-M0**：standing v0.1.1/turn v0.1.2/TaskComplete v1 契约 + worker 正式输入组装（根消息+获准历史正文注入、信封 hash 一致、组装失败不派发）；PP-02/03/04/05 自测子集通过。`pnpm check` **244/244**。详见 reports/dev-21-m0-and-closure2-result.md。
- （前一轮）**M0 核心修复轮**：外部只读审查的 8 项缺陷 + 2 项记录错误全部整改（过期租约、独立超时、会话竞态、派发门禁+重领对账、锁原子化、上下文过滤强化+worker 接入 ContextBundle、事件 ID、模式门禁+验收收尾、总账重写、parallel_writers 禁用）；额外修复 race 吞事件与 IPC 乱序两个新缺陷；`pnpm check` **222/222**。详见 [reports/m0-fix-round-result.md](reports/m0-fix-round-result.md) 与总账"修复轮"小节。

## 当前故障 / 待停止进程

- 无遗留进程。

## 下一步（直接开工，无需再确认）

1. **DEV-06 收尾（每项 1 turn，gpt-6-luna，总量 ≤4）**：steer 真实用例（turn/steer+expectedTurnId：正常追加→影响输出；错 ID→拒绝）＝PP-12 局部；thread/resume 续接（暗号跨 turn 保持）＝PP-02 局部；审批桥真实往返（临时开 approvalPolicy=on-request 的 fixture 会话：请求→adapter approval.requested→respondApproval→继续/拒绝）＝RT-23 确认档；通过后按项升级 capability matrix。
2. **DEV-07**：Electron main/preload + 命名管道 IPC 接线（传输层已验证）+ hifi-prototype 交互复用接真实命令面（DispatchWorker×CodexAppServerAdapter 组装进 daemon 入口）→ G3 演示（真实 fixture 文件夹→指定成员→读真实文件→回复入正确线程→停止→重启保留；双任务不串线）。
3. 每包结束更新总账四件套 + 本文件。

（历史）DEV-06 原始指引：
   - 先决探测：本机 codex 可执行入口（勿直接 spawn .cmd——解析到原生 exe，§9.5 EINVAL 坑）、`codex app-server` 子命令存在性与版本。
   - adapter：`src/adapter/codex/`（stdio 换行 JSON-RPC：initialize(clientInfo)→initialized→thread/turn 生命周期；developerInstructions=层 A 快照；turn/start 输入=层 B 渲染文本）；事件映射到 §9.4 规范事件；stdin 显式管理（EOF 坑）。
   - 专用 fixture：tmp 目录小项目+已知内容文件；独立测试会话+有限预算（maxTurns≤2）；断言回复含真实文件内容（不是种子文本）。
   - B6/RT-23：计划档读写限制、确认档（未过前禁用）逐项认证；PP-01/PP-12 注入/steer 真实路径验证。
   - 失败不降级 full_access；档位证据回填 runtime-capability-matrix.md。
2. **DEV-07**：Electron main/preload + 命名管道 IPC 接线 + hifi-prototype 交互复用接真实命令面 → G3 演示。
3. 每包结束更新总账四件套 + 本文件。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 前必须具备 DEV-17 最小隔离与 DEV-21-M0 正式合同。
