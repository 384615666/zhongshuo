# R116：再次交付受阻的根因调查

后续用户已授权修复，实施结果见 [R116连续返工与限制修复](r116-adaptive-workflow-repair-20261028.md)。下文保留调查时的现场和结论，不代表修复后的行为。

2026-10-28。接续用户指定会话的“交付又堵塞未完成，查看根本原因”调查。本轮完成现场核验、代码追溯和隔离复现，**未修改业务代码，尚未修复或交付新包**。

## 结论

现场运行已经结束在 `PUBLISH / PARTIAL`，任务为 `BLOCKED`。12 个执行 turn 全部 `SUCCEEDED`，12 个 outbox 项全部 `done`，没有待执行项；冻结调用预算为 `enforcement=disabled`。直接停止原因是第二版整合稿仍收到 `needs_revision`，而调度器只允许第一版进入返工。

`src/daemon/deliberationRunner.ts:1444` 的条件是：

```ts
delivery.status === 'needs_revision' && synthesis.revision === 1 && revisionBudget
```

其中 `nextRound` 也固定为 `1`。第二版的复核即使仍有明确、可由 AI 修复的问题，而且预算充足或已关闭，都会跳过返工，进入 `publishFinalReport`。后者把 `needs_revision` 映射为 `blocked`，并写入 `BLOCKED / PARTIAL`。

现场 V57 随包 `daemon.cjs` 和当前公开 main 都含相同限制。该问题不能通过仅更换为 V58、增加调用上限或等待后台自行推进来解决。

## 现场证据链

1. 第一版整合后，一位成员要求修订，另一位认为可交付。
2. 程序实际安排了一次整合修订，生成第二版，并创建该版本的全新确认矩阵。
3. 第二版复核，一位成员确认，另一位发现排期文档仍混用新估算口径与旧日期推导，并明确要求继续修改。
4. 只读核对实际文件，相关旧日期推导确实保留。此项反馈有原文依据，不能通过忽略反对票或强制标记完成来消除。
5. 最终报告保留第二版整合摘要，其中仍称上一轮修改全部完成；同时交付状态为 blocked、共识为 disputed。摘要未反映最新未通过意见，造成正文与状态的观感冲突。
6. 原有两个讨论议题已 resolved，最终报告 `unresolvedIssues=[]`。本次不是旧议题状态遗留导致的假阻塞；阻塞来自最新版本的交付复核。

用户业务原文、数据库定位及完整事件留在本机 ignored 的 `dist/r116-delivery-rootcause/incident-private.json`，不写入公开报告。原数据库只读打开，没有重跑、修改或搬迁用户任务与文件。

## 为什么之前修过还会出现

- R96（2026-10-20，公开清理历史提交 `8e3f1bb2`）引入交付反馈，并明确采用“最多一次新整合和全新确认”。见 [R96 原实施记录](../implementation/r96-optional-documents-and-goal-delivery-20261020.md)。这是当时保留的流程上限，不是本次某个模型调用失败。
- 后续预算修改允许预算关闭时继续派发，但没有移除 `synthesis.revision === 1`。预算开关与返工次数上限是两道独立条件。
- 现有 `tests/integration/deliberationFlow.test.ts` 覆盖一次返工后 ready、冻结输入一致性、needs_user、预算不足等情形；其成功脚本在第二版明确返回 ready，没有验证第二版仍有具体缺陷时应如何继续。
- `src/daemon/executionStatus.ts:1064` 对此 PARTIAL 状态使用通用失败投影，回退文案为“最近执行未成功完成”；`src/ui/hifi/pages/Room.tsx:2327` 对 BLOCKED 统一显示“需要你处理”。实际返工意见在交付反馈中可见，但界面没有交代是程序的一次返工上限阻止了继续，容易被理解为调用失败或程序仍卡在运行。

## 隔离复现

使用当前正式 DispatchWorker、持久化阶段机与 FakeRuntimeAdapter，内存数据库和独立临时成果目录。复现脚本及配置仅在 ignored `dist/r116-delivery-rootcause/`；不调用真实模型。

| 场景 | 当前实际结果 |
| --- | --- |
| 预算关闭，第二版仍需修订 | 两版后结束，BLOCKED/PARTIAL；没有第三版或待派发项 |
| 预算开启、上限 100 次，第二版仍需修订 | 相同结果；只用 10 次，非预算耗尽 |
| 预算关闭，第二版通过 | DONE/SUCCEEDED，正常交付 |

三项均通过复现断言；“通过”表示现有缺陷被稳定重现，不表示问题已修复。两个失败交付场景的 10 个模拟 turn 全部成功，且再次 `worker.runOnce()` 返回 false。复现省略了现场的两个争议讨论 turn，因此是 10 次而非现场 12 次。

执行命令（退出码 0）：

```powershell
node node_modules/vitest/vitest.mjs run --config dist/r116-delivery-rootcause/vitest.config.ts --reporter=default --reporter=json --outputFile=dist/r116-delivery-rootcause/reproduction-results.json
```

首次 pnpm 启动被现有 node_modules 跨目录链接检查阻止，随后直接使用已有 Vitest；未重装或删除依赖。复现夹具初稿漏填 object 票必需的 reason，三项失败原始结果保留为 `reproduction-invalid-fixture.json`；补齐合法载荷后的三项结果才是本轮证据。

## 后续修复范围与验收

1. 将具体内部返工继续交给原主持者，按最新冻结反馈逐轮递增版本；每版保留独立确认矩阵和审计记录。不能只将固定一次改成另一个固定次数后宣称根治。
2. 预算启用时遵守冻结上限；预算关闭时不把旧计数字段当成额度限制。停止应依据真实执行失败、用户停止、必要外部决策或可解释的无法继续条件，并记录具体原因。
3. 未通过复核时保留真实未完成状态，并让最终展示反映最新返工意见及停止原因，避免复用“全部完成”摘要造成冲突。无需新增按钮或设置。
4. 补充连续两次及以上返工后通过、第二次预算不足、版本投票隔离、重复推进幂等、重启恢复、用户停止和 needs_user 的回归。现有原任务不得在验证时自动重放。

本报告是调查完成状态；当前程序仍有上述限制，修复与新包验证尚未进行。
