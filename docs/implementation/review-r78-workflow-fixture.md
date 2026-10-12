# R78 独立业务流程夹具与事实审计

工程范围：零真实模型调用；`FakeRuntimeAdapter` 与正式 `DispatchWorker` 消费正式命令生成的 outbox。最新持久根为 `D:\zhongshuo\dist\desktop\review-r78-fixture-d4c62f`，`app-data/state.sqlite` 与四个项目文件永久保留供最终启动器重开。该根与用户数据隔离，脚本拒绝覆盖已有根。

## 已验证事实

- 房间 DIRECT 和 DM 各通过 `message.submit` 发送并由 worker 完成 v1；回复含进度与最终消息，最终正文与交付 manifest hash 经 `delivery.document` 核对一致，四个 `results/*.md` 真正写入项目目录。
- 两条链的 v1 均经 `task.review(changes_requested)` 只记录意见；额外 worker 泵返回无待领取。随后 `task.executeRework` 显式入队，同任务自然产生新 run 和 v2，最后 `task.review(accept)` 进入 DONE。送审时 `mine.pending` 和 `board.view` 绑定同一交付 ID。
- 记录消息没有任务；显式失败保留 FAILED run/turn，任务保持 ACTIVE（这是当前状态机事实）；运行中 `task.stop` 经 worker interrupt 后 run 为 CANCELLED；未知回执用同 `commandId`、同参数人工重放返回原消息，改参同号被 `IDEMPOTENCY_CONFLICT` 拒绝。没有自动重试、对账或解除保护。
- 关闭原连接后重开磁盘库，房间主池、回复串、DM、看板、任务详情、运行进度、文件集合、搜索、收藏、待处理、活动流仍定位同一任务和交付；这些只读查询不新增 turn。非 DM 参与者直查 DM 任务被 FORBIDDEN，搜索不泄露 DM 任务。

测试：`pnpm exec vitest run tests/integration/r78WorkflowFixture.test.ts` 1/1；`pnpm typecheck` 与三文件 eslint 通过。夹具生成命令：`node --experimental-strip-types scripts/run-r78-workflow-fixture.ts <全新独立根>`。

## 最终启动器连接约束

先用上述脚本生成独立根并完成写入，关闭脚本数据库句柄。v17 最终启动器必须核对 BUILD 与 `--src` 对应同一构建，只给此工程实例显式 `ZS_APP_DATA=<独立根>\app-data`；若需让该实例执行新任务，才显式启用 `ZS_RUNTIME=fake` 与 `ZS_ALLOW_FAKE=1`。日常启动器不可默认 fake、seed 或此根。启动时本机默认 `localUserId` 与夹具一致，故 DM audience 可见；换机器或用户身份需重新生成夹具，不能改库冒充成员。

本次重开是命令层磁盘重开；最终发布窗口、BUILD、`--src` 来源及视觉/交互审计由发布总体验证单独记录，不能引用本测试声称已通过。
