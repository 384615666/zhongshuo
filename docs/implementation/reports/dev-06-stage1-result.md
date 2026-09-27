# DEV-06 阶段报告：Codex App Server 真实适配（第一轮）

- 日期：2026-09-27 10:21 · 分支：`codex/full-implementation`（基线 `09fa5d1`）
- 状态：**IMPLEMENTED（协议层 VERIFIED；模型行为认证 BLOCKED——外部额度限制）**
- 外部条件：本机 codex 渠道额度用尽（"try again at 12:29 PM"，2026-09-27 12:29 重置）；重置后 `pnpm test:e2e` 一键重跑认证

## 已真实验证（无模型调用或真实进程行为）

| 项 | 证据 |
|---|---|
| C0 probe | codex-cli **0.157.1**；npm shim 解析到 `node_modules/@openai/codex/bin/codex.js`（`%dp0%` 相对布局，绕开 .cmd spawn EINVAL，§9.5）；`--version` 实跑 |
| 协议类型固化 | `codex app-server generate-ts` 生成于 `tests/fixtures/codex-protocol/`（约 130 文件）；关键形状核对：thread/start 含 `developerInstructions`；turn/start 输入 `input:[{type:'text',text,text_elements:[]}]`；turn/steer 必填 `expectedTurnId`；turn/interrupt(threadId,turnId)；审批=ServerRequest（applyPatchApproval 等 6 通道）；SandboxMode 含 `read-only`；tokenUsage 通知含 input/cached/output 细分 |
| stdio 链路 | initialize(clientInfo)→真实响应（codexHome/userAgent）；thread/start→真实 thread.id；turn/start→真实 provider turn；通知流（turn/started、error）被适配器收到并映射 §9.4 事件（`turn.failed{code,message}` 携带 provider 原文）——**全链路在真实 app-server 进程上工作** |
| 失败如实 | 额度耗尽时 turn 以 turn.failed 终结、消息原样上抛，无伪造成功（§16.5 PROVIDER_LIMITED 形态） |

## 受阻（外部条件，非缺陷）

- **C1（真实文件内容回流+层 A 生效）**：turn 已正确派发但模型调用被额度限制拒绝（消息原文已捕获）。**未验证，不得勾选**。额度重置后重跑。
- **B6/RT-23 计划档**：read-only 沙箱下指示写文件——磁盘确认无写入，但终结原因同为额度失败，**不能证明是沙箱拒绝**。断言已收紧（额度失败显式报错，不得冒充沙箱证据）；认证待重跑。

## 适配器实现（`src/adapter/codex/appServerAdapter.ts`）

- 换行 JSON-RPC：请求/响应按 id 挂接（超时=60s 可配）；ServerRequest→approval.requested（respondApproval 回 ServerRequest id）；通知映射 §9.4（session.ready/turn.started/message.delta/message.completed/tool.started/completed/usage.updated/turn.completed/turn.failed/process.exited）。
- 事件流复用共享 `EventStream`（backlog 回放+eventKey 稳定）。
- 会话：providerThreadId 映射；内部 turnId→providerTurnId 登记（steer 的 expectedTurnId 前提）。
- 权限映射（M0）：plan→sandbox=read-only、approvalPolicy=never（审批桥 B6 认证后再开）。
- 能力自报：structuredEvents/steer/interrupt/usageTokens=**supported**；taskContextIsolation/interactiveApprovals/structuredFinal/restrictWrites/restrictShell/disableDelegation=**unverified**（认证前不升级，§9.3）。
- 进程纪律：stderr 尾部入错误消息（排障）；close 广播 process.exited；dispose 收尾无残留。
- e2e 隔离：`vitest.e2e.config.ts` + `pnpm test:e2e`，默认 `pnpm test` 不含真实调用（§19.2）。

## 修复过程记录（真实排障）

1. shim 解析正则不匹配实际布局（`%dp0%\node_modules\...`）→ 改为目录确定性解析+正则兜底。
2. 注释里 `item/*/requestApproval` 的 `*/` 提前闭合块注释导致语法错（TS1127）——改写措辞。
3. spawn 参数漏传脚本路径（`'app-server'` 被当主模块，`Cannot find module 'D:\zhongshuo\app-server'`）→ stderr 尾部入错定位后修复。

## 下一步

1. **12:29 后重跑 `pnpm test:e2e`**：C1（真实文件内容 ZS-DEV06-4242 回流 + 层 A 暗语行为证据）与 B6（read-only 沙箱写拒绝——断言已防额度冒充）。
2. 认证通过后：capability matrix 回填 supported；再补 steer（PP-12 局部）与 thread/resume（PP-02）真实用例（各 1 turn，预算有界）。
3. 之后进 DEV-07（Electron main/preload + 命名管道 IPC + UI 接线）→ G3。
