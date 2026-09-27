# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

- 更新：2026-09-27（DEV-17 完成时点）
- 分支：`codex/full-implementation`；检查点：DEV-01 `8e88799` → DEV-02 `0feb053` → DEV-03 `30e5424` → DEV-04 `35df2f3` → DEV-05 `41b58dc` → DEV-17（见 git log）；全部已推送

## 刚完成

- **DEV-17（M0 最小隔离）完成**：五级归属绑定、事件归属、会话复用键、上下文过滤（§13.4 矩阵最小）、ContextBundle 契约骨架、双任务不串线集成测试；`pnpm check` 206/206。隔离测试抓到并修复真实缺陷：回复消息 ID 改 turn 命名空间（跨会话同名 provider id 冲突会静默丢消息）。
- M0 进度：DEV-01/02/03/04/05/17 ✅ → 剩 **DEV-21-M0 最小合同 → DEV-06 真实 runtime → DEV-07/G3**。

## 当前故障 / 待停止进程

- 无遗留进程。

## 下一步（直接开工，无需再确认）

1. **DEV-21-M0（提示词/输出最小合同）**：DIRECT 模板 `zs-direct-v0.1.0`（文本+版本+sha256 记录）、TaskComplete 输出 schema（zod：action/kind/success/verification 分离——模型说"测试通过"不等于验证过）、ContextBundle 拼装纯函数（按 §13.1 优先级组装+hash，消费 filterContextScope）、注入参数（developerInstructions/policyId）拼装。依据 docs/zhongshuo-prompts-v0.1.md §4.4 与主设计 §5.2/§9.2（1.0.32 注入机制）。
2. **DEV-06（真实 runtime）**：Codex App Server stdio 接入（先 probe 版本/能力；App Server 换行 JSON-RPC initialize→thread.start→turn.start 流程按 runtime-injection-review-2026-09-20.md 的 schema；专用 fixture 目录+独立测试会话+有限预算；B6 档位按 §9.6 认证——未过 RT-23 前权限档位在 UI 禁用）。注意 §9.5 的坑：spawn EINVAL（解析原生入口）、stdin EOF、--skip-git-repo-check、GBK。
3. **DEV-07**：Electron main/preload + 命名管道 IPC + hifi-prototype 交互复用接真实命令面 → G3 演示（打开真实 fixture 文件夹→指定成员→读文件→回复入正确线程→停止→重启保留）。
4. 每包结束更新总账四件套 + 本文件。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 前必须具备 DEV-17 最小隔离与 DEV-21-M0 正式合同。
