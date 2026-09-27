# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

- 更新：2026-09-27（M0 核心修复轮完成时点）
- 分支：`codex/full-implementation`；检查点：DEV-01 `8e88799` → DEV-02 `0feb053` → DEV-03 `30e5424` → DEV-04 `35df2f3` → DEV-05 `41b58dc` → DEV-17 `2535a74` → **修复轮**（见 git log）；全部已推送

## 刚完成

- **M0 核心修复轮**：外部只读审查的 8 项缺陷 + 2 项记录错误全部整改（过期租约、独立超时、会话竞态、派发门禁+重领对账、锁原子化、上下文过滤强化+worker 接入 ContextBundle、事件 ID、模式门禁+验收收尾、总账重写、parallel_writers 禁用）；额外修复 race 吞事件与 IPC 乱序两个新缺陷；`pnpm check` **222/222**。详见 [reports/m0-fix-round-result.md](reports/m0-fix-round-result.md) 与总账"修复轮"小节。

## 当前故障 / 待停止进程

- 无遗留进程。

## 下一步（直接开工，无需再确认；采纳审查建议的顺序）

1. **DEV-21-M0（提示词/输出最小合同）**：先读 `docs/zhongshuo-prompts-v0.1.md`；DIRECT 模板 `zs-direct-v0.1.0`（文本+版本+sha256）、TaskComplete 输出 schema（zod strict：success 与 verification 分离——模型说"测试通过"不算验证）、ContextBundle 正式拼装（消费 filterContextScope 与 contextBundle.ts 骨架，替换 worker 中的 zs-context-v0 过渡文本）、注入参数拼装（developerInstructions/policyId）。验收 PP 子集可自测的部分。
2. **DEV-06（真实 runtime，Codex App Server）**：防线已就绪（隔离/门禁/停止/恢复/预算）。专用 fixture 目录 + 独立测试会话 + 有限预算；先 probe 版本/能力；App Server 换行 JSON-RPC（initialize→thread.start→turn.start）按 runtime-injection-review-2026-09-20.md schema；§9.5 四坑（spawn EINVAL/stdin EOF/--skip-git-repo-check/GBK）；B6/RT-23 档位认证未过前 UI 档位禁用（RT-23 矩阵逐项跑）。
3. **DEV-07**：Electron main/preload + 命名管道 IPC 接线（传输层已验证）+ hifi-prototype 交互复用接真实命令面 → G3 演示（真实 fixture 文件夹→指定成员→读真实文件→回复入正确线程→停止→重启保留记录；双任务不串线）。
4. 每包结束更新总账四件套 + 本文件。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 前必须具备 DEV-17 最小隔离与 DEV-21-M0 正式合同。
