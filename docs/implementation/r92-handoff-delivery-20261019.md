# R92 交付记录：deferred coordinator handoff

> 状态：最终审核已批准（records-only 收尾）。产品提交、v28 候选与同 BUILD packaged-daemon 验收均通过；本轮仅提交交付文档与 QA 脚本并正常 push。
> 不包含用户业务正文、凭据或 secret；不改真实 DB，不重放旧串，不新增真实模型调用。

## 0. 结论速览

- 修复“成员向协调者发出真实 deferred reply 后，explicit-recipients 分支直接 completed、integration 永不消费”的断链。
- 无 handoff 的明确多收件人问答仍只各答一次，不额外唤醒协调者。
- 产品提交：`7abed6f07742e7a51fef8ddd18b9a2762a899ad6`，仅 4 文件（3 产品源码 + 1 新测试）。
- 候选：`dist/desktop/desktop-daily-win-v28-r92-20261019`，BUILD `bld_e27d913b24945a3d`，commit 与产品提交一致，dirty=true 如实保留。
- 同 BUILD packaged daemon 合成验收：94/94 checks 通过；deferred 场景 3 turns、无 handoff 场景 2 turns、real_calls=0。
- 旧真实串仍未恢复，只保留可审核恢复方案；本轮不新增恢复入口。

## 1. 真实问题与数据库证据

只读审计副本确认：

- 根消息：`msg_f0d8a94c-3c64-4930-943a-7b259d0490ee`
- 父任务：`task_cb22c4b4-9406-4d56-8b00-2adea69af494`
- 协调运行：`run_1e60ad66-e263-41d5-aba0-cdce3c639e12`
- 两个 explicit child 均 DONE，且各有正式 delivery。
- 两次真实调用均成功：Claude `newapi/deepseek-flash`、Codex `gpt-6.1-sol`；协调聚合预算仅 2/24，不是额度失败。
- deferred handoff：`handoff_af5242c1adf0f03b9854f23268e778cf`，Codex → Claude，purpose=reply，status=accepted，child_task_id/target_turn_id/target_delivery_id 均 NULL。
- `coordination_runs.state=completed`、`integration_run_id=NULL`、integration attempts=0。
- 事件时间线：seq33 member.messageAccepted → seq35/36 child/turn DONE → seq37 coordination.completed；无 integrationQueued。
- 父任务 DONE 但 current_delivery_id=NULL，没有 A 的整合交付。

根因：explicit-recipients 全 DONE 后直接 completed/return，位于正式 integration 分支之前，跳过 deferred message 消费。

## 2. 源码行为

- `pumpCoordinations` 检查 `child_task_id IS NULL` 且 status accepted/queued 的 deferred message；存在时进入既有 integration，不再提前 completed。
- 无 deferred 时保持原行为：明确多收件人每人只回答一次，不额外调用协调者。
- 无 delivery 的合法 conversation+handoff 仍可进入 integration；正式 thread context 包含两位成员完整答复、author 与 deferred 正文。
- integration 前置/启动失败的集中原子收口 helper：assert、write-access、baseline、assembly、settleStartupFailure 共用；不覆盖 CANCELLED/STOPPING/UNKNOWN。
- `replyToMemberId` 与 reply 校验受真实来源、冻结协调者名单和可用性约束。
- `coordinationMessages` 的目标 turn/delivery 只在真实 integration attempt 建立后绑定。

## 3. 测试

- R92 正式链回归：12 tests。
- 独立代码审核：5 文件 / 81 tests；双 typecheck、改动 lint、diff check 通过。
- 开发最终全量：191 文件 / 1388 tests 通过。
- 日志：`dist/review-r92-handoff-20261019/R92-DELIVERY-FULL.log`、`R92-DELIVERY-TYPECHECK.log`、`R92-DELIVERY-LINT.log`。
- 代码审核：`dist/review-r92-coordinator-20261019/{CODE-REVIEW.md,code-approval.json,reviewed-source-hashes.json}`。
- 独立最终审核证据：`dist/review-r92-coordinator-20261019/REVIEW.md`、`package-evidence-v2.json`、`artifact-check.json`；`code-approval.json` 的 packageApproval 已为 `approved`。
- 独立稳定复制 readonly 复核：3+2 turns、deferred completed 且绑定真实 integration turn/delivery、仅 1 integration attempt、无 pending outbox、重开 0、real_calls=0；309 个运行时源码匹配已审核版本。

## 4. 候选 BUILD

| 项 | 值 |
|---|---|
| 候选包 | `dist/desktop/desktop-daily-win-v28-r92-20261019` |
| BUILD | `ZhongshuoDual/BUILD.json` |
| buildId | `bld_e27d913b24945a3d` |
| commit | `7abed6f07742e7a51fef8ddd18b9a2762a899ad6` |
| dirty | `true` |
| dirtyDiffHash | `3a46fbf161e0fee2e7f5182f325259521fef69d47c62fbb5d2351d67503f3819` |
| manifest | 595 文件；missing/mismatch/extra/invalid 0 |
| daemon SHA256 | `4dcaf931a3f1e76cce47b38c0f8a8066dae02eac34c46f03527a3bc35bf738d6` |

候选包不带 `server-data/`、fixtures、tests 或数据库测试数据。旧 v27 R91 包未被修改，595/595 清单仍匹配。

BUILD dirty=true 来自构建时既有用户状态（用户删除的 dbg 文件及既有未跟踪目录/文件），没有改打包逻辑伪装 clean；QA 脚本和交付 docs 在候选构建后新增，不属于候选内容。

## 5. 同 BUILD packaged-daemon 验收

命令：

`node scripts/verify-r92-package.cjs --package dist/desktop/desktop-daily-win-v28-r92-20261019 --out dist/review-r92-package-20261019 --keep-copy`

结果：`result.json`，`ok=true`，94/94 checks，0 failures。

关键事实：

- 注入 `SyntheticRuntimeAdapter` 未被默认 fake 吞掉；`ZS_ALLOW_FAKE` 只在 `startDaemon` 捕获工厂后开启。
- deferred handoff 场景：startTurnLog=3；B reply completed；target turn/delivery 为 A 的真实 integration turn/delivery；thread.history 末条为 A 可读整合。
- integration context 含 A/B 完整合成结果、B deferred reply 和两位 author。
- 无 handoff 场景：场景内 startTurnLog=2；无 integration message/event；无额外协调者。
- 累计 startTurnLog=5；重复 drain 不增加；同隔离 DB 重开 adapterCalls=0。
- real_calls 在 handoff 后、无 handoff 后、重开后均为 0。
- 保留隔离副本：`C:\Users\user\AppData\Local\Temp\zs-r92-package-OOrFDw\candidate`。
- QA 脚本早期失败/查询失败保存在 `result.json.priorAttempts`，最终通过结果没有抹除失败记录。

## 6. 恢复旧串

本轮**未恢复**旧串、未改原 DB、未重放历史成功调用。旧串需要未来经审核的一次性显式恢复入口：

- CAS 校验 task revision / stop_generation / roster / delivery+hash / 无在途或 UNKNOWN；
- 将旧 run 受控转为 integrating，只创建一个 integration attempt 和固定 dispatch key；
- 不重跑两个 child，只新增一次明确授权的整合调用；
- 成功后在原 thread 写入 A 的整合答复；失败/UNKNOWN 明确 BLOCKED，不自动重试。

## 7. 限制

- 未做 GUI/Electron 验收；本轮 UI 未改，不重复 R91 副屏整套输入验证。
- packaged daemon 验收注入 `SyntheticRuntimeAdapter` 合成运行时，零真实模型；源测试使用 FakeRuntimeAdapter。不声称真实完整多模型互评通过。
- 旧串仅方案，未恢复；本轮不新增正式恢复命令。
- 最终审核已批准；本轮仅提交交付文档与 QA 脚本并正常 push。未改产品/BUILD/manifest/候选、未重打包、未恢复旧串。