# DEV-06 修复轮 + 第二阶段真实认证报告

- 日期：2026-09-27 13:30 · 分支：`codex/full-implementation`（基线 `40c376f`）
- 输入：用户转交 GPT 复核意见（7 项：终态映射/事件归属/生命周期/输出校验/B6 假绿/能力声明/锁接管）+ 用户授权真实测试（GPT-6 Luna / deepseek-flash）
- 结果：**全部修复**；默认套件 `pnpm check` **254/254**（新增协议回放 8 用例）；真实 e2e **4/4 通过**（model=gpt-6-luna，共 6 个真实 turn 含诊断重跑）

## 修复对照（外部审查 7 项）

| # | 审查项 | 修复 | 验证 |
|---|---|---|---|
| 1 | turn/completed 一律当成功；工具一律 success | 按 turn.status 映射（completed/interrupted→INTERRUPTED/failed→error.kind+message）；工具按 item.status（completed/failed/declined）映射 outcome | 回放：failed 带 UsageLimit 原文、interrupted→INTERRUPTED、tool declined→failure；无成功事件产生 |
| 2 | 事件不按 provider turn 归属；审批发第一会话 | awaiting turn 机制（通知早于响应也能建映射）+ providerTurnToInternal 映射；未知 provider turn 的事件不带内部 turnId（迟到）；审批按 threadId/conversationId 定位会话+turnId 定位轮次，错会话答复 THREAD_SCOPE_MISMATCH | 回放：两轮串线（迟到事件归 turn_A 不冒充 turn_B）、通知先于响应、双会话审批错答拒绝 |
| 3 | 重启后 protocolVersion 未重置；缺 initialized 通知；旧回调清新进程 | 进程代次（generation）管理：新连接重置握手、旧 close 回调只广播不清理新代次；initialize 响应后发 initialized 通知 | 回放：关最后会话→重开 = 两次 initialize + 两次 initialized（rpc log 断言） |
| 4 | TaskComplete schema 未接入完成路径 | worker 收到 turn.completed 先 parseTaskComplete（JSON 解析→schema→resultKey 绑定 turn），非法输出走 OUTPUT_INVALID（turn FAILED、任务回 ACTIVE、审计 turn.outputInvalid、零交付）；fake adapter 改为发结构化终态（structuredFinal，与真实合同一致），TurnRequest 增加 resultKey | m0Fixes 全链继续绿；fake 断言改为解析 changeSummary；输出合同测试保留在 prompts.test（4 fixture） |
| 5 | B6 可能假绿 | 收紧断言：必须出现真实工具活动（tool.started/completed）、工具结果含 failure/unknown、磁盘无写入、额度/认证失败显式排除；直接编辑与 shell 写入分开两用例；已存在文件的写入按内容变化断言（非存在性） | e2e B6-1（直接编辑：内容未变+工具失败证据）、B6-2（shell：文件未创建+工具失败证据）通过 |
| 6 | 能力声明过满（resume 未实现却标 supported） | 仅 structuredEvents=supported（真实进程观察到）；resumeSession/steer/interrupt/usageTokens 等全部 unverified；**resume 已实现**（openSession 消费 input.resume→thread/resume 携带 threadId），真实续接验证随 PP-02 | 回放：thread/resume 参数断言；probe 断言 unverified |
| 7 | 锁接管非原子；测试未制造真实竞态 | 目录协议重写：锁=mkdir（原子创建）；接管=先 mkdir claim（原子，并发接管唯一赢家）→ rename 归档 → 重建；claim 活着（含本进程重入）→ BUSY；claim 主已死→清理重试；归档内容复核防误移（不符则不启动） | 同步点注入真实竞争窗口（onClaimed 内二次获取→BUSY）；claim 死主清理；双进程并发恰一成功；legacy 文件锁兼容 |

## 真实认证结果（tests/e2e/realCodex.test.ts，model=gpt-6-luna）

| 用例 | 结果 | 证据 |
|---|---|---|
| C0 probe | ✅ | codex-cli 0.157.1；shim→codex.js；未认证能力 unverified |
| C1 文件回流+层 A | ✅ | 回复含 fixture 暗号 **ZS-DEV06-4242**（真实文件内容，非种子文本）+ 层 A 暗语 **ZS-ACK**（行为证据级）；事件序列 turn.started→…→turn.completed |
| B6-1 直接编辑（read-only） | ✅ | 模型真实尝试写 notes.md（工具活动存在），写入被拒：**文件内容逐字节未变**；工具结果含 failure |
| B6-2 shell 写入（read-only） | ✅ | 命令真实执行尝试，b6-shell.txt 未创建；工具结果含 failure |

过程记录：deepseek-flash 经 ChatGPT 渠道被拒（"not supported with a ChatGPT account"——config.toml 旧渠道已不适用）；改用 model/list 确认的 **gpt-6-luna**（用户指定型号之一）通过。B6-1 首跑失败暴露的是测试断言 bug（已存在文件用存在性断言恒真），修正为内容变化断言后通过——修复如实记录，未降低产品要求。

## 本轮新发现（记录在案）

1. thread/start 的 model 覆盖与渠道绑定：config.toml 旧 custom provider 在当前 ChatGPT 登录态下不可用；适配器 model 参数仅在显式指定时传递（默认走配置）。
2. e2e 消耗：本轮真实 turn 共 6 次（C1×3 含模型排错、B6-1×2 含断言修正、B6-2×1），均为小 prompt。

## 口径（按审查建议收窄）

- 默认套件 254/254 = fake+SQLite+**本地协议回放**层（零额度）。
- 真实层已验证：**启动/握手/请求/turn 派发/通知映射全链路 + 真实文件内容回流 + 层 A 行为证据 + read-only 沙箱对直接编辑与 shell 写入的拒绝（RT-23 计划档两路径）**。
- 仍未验证（不勾选）：steer（PP-12）、resume 续接（PP-02）、审批桥真实往返（RT-23 确认档）、structuredFinal、usageTokens 数值口径——各需 1 turn 的真实用例随下一批执行。
