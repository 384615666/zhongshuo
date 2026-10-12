# R78 独立业务流程夹具与事实审计

工程范围：零真实模型调用；`FakeRuntimeAdapter` 与正式 `DispatchWorker` 消费正式命令生成的 outbox。最新持久根为 `D:\zhongshuo\dist\desktop\review-r78-fixture-d4c62f`，`app-data/state.sqlite` 与四个项目文件永久保留供最终启动器重开。该根与用户数据隔离，脚本拒绝覆盖已有根。

## 已验证事实

- 房间 DIRECT 和 DM 各通过 `message.submit` 发送并由 worker 完成 v1；回复含进度与最终消息，最终正文与交付 manifest hash 经 `delivery.document` 核对一致，四个 `results/*.md` 真正写入项目目录。
- 两条链的 v1 均经 `task.review(changes_requested)` 只记录意见；额外 worker 泵返回无待领取。随后 `task.executeRework` 显式入队，同任务自然产生新 run 和 v2，最后 `task.review(accept)` 进入 DONE。送审时 `mine.pending` 和 `board.view` 绑定同一交付 ID。
- 记录消息没有任务；显式失败保留 FAILED run/turn，任务保持 ACTIVE（这是当前状态机事实）；运行中 `task.stop` 经 worker interrupt 后 run 为 CANCELLED；未知回执用同 `commandId`、同参数人工重放返回原消息，改参同号被 `IDEMPOTENCY_CONFLICT` 拒绝。没有自动重试、对账或解除保护。
- 关闭原连接后重开磁盘库，房间主池、回复串、DM、看板、任务详情、运行进度、文件集合、搜索、收藏、待处理、活动流仍定位同一任务和交付；这些只读查询不新增 turn。非 DM 参与者直查 DM 任务被 FORBIDDEN，搜索不泄露 DM 任务。

测试：`pnpm exec vitest run tests/integration/r78WorkflowFixture.test.ts` 1/1；`pnpm typecheck` 与三文件 eslint 通过。夹具生成命令：`node --experimental-strip-types scripts/run-r78-workflow-fixture.ts <全新独立根>`。

## 最终启动器连接约束

预生成持久夹具只用于命令层磁盘重开与只读身份对照。daily 启动器拥有自己的 server-data/pipe，清除外部 ZS_APP_DATA/ZS_RUNTIME 覆盖，因此不能把环境变量指向预生成库冒充最终启动器完整流程。最终形态验证在新副本 server-data 建工程 marker，按下节实际 UI 发送、worker 自然交付并重开；用户原包与原根不参与。
本次重开是命令层磁盘重开；最终发布窗口、BUILD、`--src` 来源及视觉/交互审计由发布总体验证单独记录，不能引用本测试声称已通过。

## 最终启动器工程验证（待 v17 候选来源）

`scripts/verify-r78-workflow-launcher.cjs --src <最终日常包>` 只接受显式来源，校验源包与自有副本的 BUILD/MANIFEST 及 BAT 字节一致。它将 `scripts/lib/r78-live-engineering-daemon.ts` 编译到**副本** `server-data/engineering/daemon.cjs`，创建三字段 `engineering-r78.json`（nonce、规范数据根、入口绝对路径）；正常 daily 包不含 helper 或 marker。该入口由真实 BAT 经过受控 marker gate 传给 UI，UI 正常 spawn 它。入口从同一副本的最终打包 `daemon.cjs` 取得 `startDaemon`，只注入单个工程 Fake adapter，令未绑定成员走这个实例；强制 `ZS_REAL_DISPATCH_GUARD=1`，不透传真实模型权限旗标。

验证脚本先测无 token 且父环境污染时 fake/guard 被清理，以及错 token、缺调试端口、marker 数据根错配时 BAT 拒绝启动；然后在真实 UI 点击房间和 DM 的发送、返工意见、执行返工、验收，核排队/运行/进度/交付两版/成果文档与项目文件；旧交付验收须 `STALE_REVISION`。它关闭并重开同一启动器，比对新 daemon PID/同 BUILD、任务身份及 `real_calls=0`。历史 v16 旧 BAT 负例：`dist/desktop/review-r78-v16-launcher-preflight-3/result.json` 证明无 token 的正常清理；v16 尚无工程直通，正例 ready 超时为预期失败，不能作为 v17 通过证据。最终结果以 v17 的 `result.json` 为准。
