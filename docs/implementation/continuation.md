# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

- 更新：2026-09-27（DEV-03 完成时点）
- 分支：`codex/full-implementation`；检查点：DEV-01 `8e88799` → DEV-02 `0feb053` → DEV-03（见 git log，reports/dev-03-result.md）
- 工作树归属：本包新增 `src/contracts/runtime.ts`、`src/adapter/fake/`、`tests/unit/fakeAdapter.test.ts`；总账更新

## 刚完成

- **DEV-03 完成**：§9.3/§9.4 运行时契约落 contracts；可脚本化 fake adapter（六类 fixture：成功/失败/审批/超时/停止不响应/迟到）+ 16 用例；`pnpm check` 167/167。

## 当前故障 / 待停止进程

- 无。

## 下一步（直接开工，无需再确认）

1. **DEV-04（项目与 workspace）**：目录身份（junction/符号链接/盘符解析→identityKey）、同物理目录去重命中（重开定位已有 projectId）、重定位（保 projectId）、锁域重叠检测（父子目录、junction，RT-09）、基线清单（§6.3 排除规则+hash，Git 目录 ref+工作区前像 §14.2——最小实现先做清单骨架）。依赖 DEV-01/02 ✅。
2. **DEV-05（daemon 与 supervisor）**：单实例锁、命名管道 IPC 骨架、outbox worker（消费 DEV-02 的 claimNextOutbox → 经 DEV-03 fake adapter 派发 → 回写 turn 事件/预算结算——G1 关键路径）、停止代次持久化、恢复读取（§16.4 步骤）。
3. 每包结束更新总账四件套 + 本文件；G3 前必备 DEV-17 最小隔离与 DEV-21-M0 正式合同。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 前必须具备 DEV-17 最小隔离与 DEV-21-M0 正式合同。
