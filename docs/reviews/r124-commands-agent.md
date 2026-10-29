# R124 任务 A：操作序列与调度混沌

工作目录为 `D:/zhongshuo-public`，基线 HEAD 为 `70e7969`。已读取 README、续工记录及当前相关源码；源码克隆下没有 AGENTS.md。仅新增本代理专属测试、报告和 ignored 证据，未改生产代码或共享 helper，未提交、推送、打包，未读写 `D:/zhongshuo` 原运行数据。

**实际执行 9 个新场景：5 个守住、3 个确认缺陷、1 个语义边界反例。** 最终运行显示 `5 passed | 4 expected fail (9)`，退出码 0；这表示预期反例被稳定复现，不表示产品 9 项全部通过。A01/A03/A05 的 `it.fails` 标题明确写 DEFECT；A06 写 BOUNDARY COUNTEREXAMPLE，单列且不计确认缺陷。所有原有业务断言保留，未通过放宽断言消除红灯。

没有随机操作序列，**种子为 `null`（不适用）**。命令顺序固定，A03/A06/A07 使用 Promise 闸门固定 `openSession` 窗口；随机 UUID 和临时目录名仅用来隔离身份，不选择操作顺序。

## 执行与原始记录

均在 `D:/zhongshuo-public` 执行，未使用 pnpm，也未改动 node_modules junction。

```powershell
node node_modules/vitest/vitest.mjs run tests/integration/chaosCommandsR124.test.ts --maxWorkers=1 --reporter=verbose --reporter=json --outputFile=dist/r124-chaos/commands/initial-run.json
node node_modules/vitest/vitest.mjs run tests/integration/chaosCommandsR124.test.ts --maxWorkers=1 --reporter=verbose --reporter=json --outputFile=dist/r124-chaos/commands/confirmed-run.json
node node_modules/vitest/vitest.mjs run tests/integration/chaosCommandsR124.test.ts --maxWorkers=1 --reporter=verbose --reporter=json --outputFile=dist/r124-chaos/commands/final-run.json
node node_modules/eslint/bin/eslint.js tests/integration/chaosCommandsR124.test.ts
node node_modules/typescript/bin/tsc --noEmit -p dist/r124-chaos/commands/tsconfig.json
node dist/r124-chaos/commands/summarize-evidence.mjs
```

- 首轮未标记 expected failure：退出码 1，4 failed / 5 passed；[红灯日志](../../dist/r124-chaos/commands/initial-run.log) 和 [JSON](../../dist/r124-chaos/commands/initial-run.json) 保留。首轮 A01 在错误码断言处即失败，其证据 outcome 为 incomplete，不能充作后续无错串/可推进的完整证明；最终同场景补齐这些断言。
- 缺陷标记后第二轮退出码 0。最终文件收口后再次运行最终命令，退出码 0、耗时 6.78 秒；[最终日志](../../dist/r124-chaos/commands/final-run.log)、[最终 JSON](../../dist/r124-chaos/commands/final-run.json)。final-run 文件为最后一次运行，上一轮同名报告被更新；36 份逐场景 SQLite/JSON 快照均保留。
- lint 最终退出码 0、0 问题，[日志](../../dist/r124-chaos/commands/lint.log)。首次 lint 曾报 1 个测试局部 `prefer-const`，已仅修正该局部声明。
- 本文件独立类型检查退出码 0，[配置](../../dist/r124-chaos/commands/tsconfig.json)、[日志](../../dist/r124-chaos/commands/types.log)。配置只以本测试为入口，检查其实际导入依赖；未运行其他代理的测试或全仓测试。
- [证据索引与 SHA-256](../../dist/r124-chaos/commands/summary.json) 汇总最终 9 场景和全部 36 快照；索引脚本退出码 0。最终测试文件 SHA-256：`5256366b4fd6770a2f8ef35b9f812f2b528e039b921d0d7bc97dcce1efa246e1`。

每场景 `evidence.json` 包含完整 method/params/commandId/回执顺序、adapter 启动身份、任务/运行/turn/outbox/回复/修复项/租约/领域事件，以及本地写入路径和字节数；同目录有真实隔离 SQLite 和项目文件。afterEach 在 `it.fails` 之外独立检查到达业务 oracle、0 real_calls、0 重复 turn 启动、0 启动身份错串、0 消息目标错串，避免基础设施错误被 expected failure 吞掉。

## 已确认缺陷

| 场景 | 实测结果 | 影响及源代码依据 |
| --- | --- | --- |
| A05，优先级建议 P1 | OPEN 根任务已接单但尚无 turn 时，房间归档成功；随后 worker 仍启动 1 次该任务并写入 `archived-output.txt` | 归档的只读边界被已排队根任务穿透。`commands.ts:1277` 的未结束任务筛选漏 OPEN；根派发在 `dispatchWorker.ts:615` 后只读房间 id/name，现有 thread reply 的归档重查没有覆盖根请求。另一房间仍完成。 |
| A03，建议 P2 | 同一个仍在连接的运行，5 个不同 commandId、相同 expectedStopGeneration=0 的停止请求均成功，stopGeneration 依次成为 1/2/3/4/5 | `stopTarget.ts:40` 对旧代次返回 stopping，`stopFlow.ts:67` 将每次 stopping 再次视为需要推进代次；违反“同一运行并发 stop 只推进一次停止代次”的现有说明。本例未发生复活或错误放锁，不扩张成已证明重复执行。 |
| A01，建议 P2 | 同 commandId 的跨项目发送、跨 thread 发送都返回 IDEMPOTENCY_CONFLICT；跨方法 task.stop 却返回 STORAGE_UNAVAILABLE | `stopFlow.ts:97` 将网关拒绝转为 StopCommandError，`commands.ts:5567` 之后未识别此类错误，落通用存储错误映射。实际未发生存储故障、改目标或停止；这是错误合同缺陷，不与其他代理的真实存储故障蔓延重复计数。 |

## 逐场景命令链、断言、实际结果与限制

### A01：跨项目、根/串、跨方法共用 commandId

命令链：P0/R0 `message.submit(C)` → `runOnce` 启动 A → P1/R1 新 id 发送 B → 同 C 分别发 P1 新根、A 串追问、`task.stop(A)` → 同 C 同参重放原根 → drain 两项目。

断言：三种不同载荷均须返回 IDEMPOTENCY_CONFLICT；同参重放仍指向 A；A 停止代次为 0，无追问请求落库，仅 A/B 各执行一次，B 输入不含 A 标记，A/B 均 DONE。

实测：后三项业务隔离断言守住；跨方法停止错误码实际为 STORAGE_UNAVAILABLE，原断言失败，标为确认缺陷。限制：未测试不同登录用户的 idempotency scope、网络断连或真实 IPC；本例使用同一个本地用户的正式 daemon 命令入口。

证据：[a01-cross-target-id-gFeeKb](../../dist/r124-chaos/commands/a01-cross-target-id-gFeeKb/evidence.json)。最终 2 次 Fake start，0 真实调用。

### A02：停止 + 四条排队追问 + 停用/启用 + 旧发送重放

命令链：角色 1 的长根任务启动 → 原串连续提交 4 条追问 → 定位当前 run 停止 → `member.setEnabled(false)` → true → 重放根发送原 commandId → 另一项目角色 2 发送 → 两项目 drain → 旧 run 再停止。

断言：四条追问全 cancelled，根只有 1 次启动且保持 CANCELLED；旧发送重放不产生新任务或 turn，停止代次最终为 1；另一项目 DONE，全部准入最终释放。

实测全部守住。限制：旧 run 再停止发生在取消结算后，不覆盖 STOPPING 未结束窗口；该窗口由 A03 单独证明。未将用户新发的明确继续请求等同于旧请求重放。

证据：[a02-stop-replay-disable-tSKWKw](../../dist/r124-chaos/commands/a02-stop-replay-disable-tSKWKw/evidence.json)。最终 2 次 Fake start，0 真实调用。

### A03：连接闸门内五次不同 id 停止

命令链：提交 A → `runOnce` 在 `openSession` 闸门暂停，已建 DISPATCHING turn、尚未 startTurn → 同 run/相同 expectedStopGeneration=0，依次发送五个新停止 commandId → 记录代次 → 放开连接 → 另一项目发送 B 并 drain。

断言：同运行停止只应推进一次代次；闸门未释放时准入仍持有 1 个槽；A 从未 startTurn，放开后 CANCELLED，B 可 DONE，最终无准入遗留。

实测保护、取消及其他项目推进均守住；代次实际为 5，预期 1 的断言失败，确认缺陷。限制：使用固定顺序的停止重入，而非 OS 线程同时抢写；危险条件是上次停止尚未结束，由闸门确定保证。未声称代次增加已导致副作用重跑。

证据：[a03-stop-generation-gu7YAh](../../dist/r124-chaos/commands/a03-stop-generation-gu7YAh/evidence.json)。A 0 启动，B 1 次 Fake start，0 真实调用。

### A04：同串不同收件人追问 + 移出名单 + 配置增权

命令链：角色 0 根完成 → 同串分别 @角色 1、@角色 2 提交追问 → 冻结两请求 scope/roster → CAS 移出角色 1 → 角色 2 plan 改 bypassPermissions → 另串角色 0 发送 → drain → 角色 2 恢复 plan → 再 drain。

断言：角色 1 请求因已移出 blocked，角色 2 因配置变化 blocked；旧 scope/roster 字节不变；恢复配置不自动复活 blocked 请求；另串 DONE，只有两个根 turn。

实测全部守住。限制：移出的是本串成员，其他房间并不被隐式移出；本例没有同时运行这两个被阻止的追问，也未验证 GUI 名单刷新。

证据：[a04-roster-config-interleave-rDT0A2](../../dist/r124-chaos/commands/a04-roster-config-interleave-rDT0A2/evidence.json)。最终 2 次 Fake start，0 真实调用。

### A05：队列中的写根请求遇到房间归档

命令链：bypassPermissions 角色 1 提交写根 A，保持未领取 → 读取房间 revision 并 `room.archive` → 重放 A 原 commandId → 另一房间角色 2 发送 B → drain。

业务 oracle 接受两种合法保护：有未结束请求时拒绝归档，或者归档成功后阻止旧队列启动。归档后重放还必须明确拒绝，且 B 能前进。

实测：归档成功；重放守卫正确返回 CONVERSATION_UNAVAILABLE；worker 仍首次启动 A，实际落盘内容为 `A05_WRITTEN_AFTER_ARCHIVE`，B 也完成。确认“归档成功后的旧根派发未被围住”，保留原不应启动断言为 it.fails。限制：只实测房间归档，未把源码中相似的项目生命周期条件推断为已实测项目归档/移除漏洞；写入由 Fake 本地脚本完成。

证据：[a05-archive-queued-MESMkL](../../dist/r124-chaos/commands/a05-archive-queued-MESMkL/evidence.json)、[真实隔离项目文件](../../dist/r124-chaos/commands/a05-archive-queued-MESMkL/project-0/archived-output.txt)。最终 2 次 Fake start、1 次项目文件写入，0 真实调用。

### A06：停用发生在 DISPATCHING 与首次 startTurn 之间

命令链：写根 A 在 `openSession` 闸门暂停，确认启动计数 0 → `member.setEnabled(false)` 成功 → 放开闸门 → 另一项目 B 发送并 drain。

更强 oracle：“停用提交后不能首次 startTurn”。实测 A 仍首次启动，成员 enabled=0 时写出 `A06_WRITTEN_WHILE_DISABLED` 并 DONE；B 完成，准入最终归零。

**此项只算语义边界反例，不计确认缺陷。** `commands.ts:1450` 的现有约定为停用不影响在途 turn、以派发时点读取；闸门前已创建 DISPATCHING turn，因此当前行为可被该约定解释。首轮将其暂判缺陷，复核源码约定后改为边界分类；原“启动数应为 0”的严格断言仍保留在明确 BOUNDARY 标题的 it.fails 中。它不能用来宣称停用必然取消已开始连接的工作，也不能自动推出需要更改现有产品语义。

限制：未要求或测试停止现有运行；“派发已开始”和“首次请求已交给 runtime”之间的产品语义需由主代理判断，不能按这条更强 oracle 强行宣布修复需求。

证据：[a06-disable-open-KeGhLe](../../dist/r124-chaos/commands/a06-disable-open-KeGhLe/evidence.json)、[真实隔离项目文件](../../dist/r124-chaos/commands/a06-disable-open-KeGhLe/project-0/disabled-output.txt)。最终 2 次 Fake start、1 次项目文件写入，0 真实调用。

### A07：写者连接失败 → 新写者接锁 → 旧运行迟到停止

命令链：写者 A 在连接闸门暂停 → 将 A 角色 bypassPermissions 改 plan → 放开闸门，捕获明确配置变化拒绝 → 新角色写者 B 启动 → 对 A 旧 run 发送停止 → 同物理根第三写者 C 与另一项目写者 D 入队 → drain → 等 B/C/D 完成。

断言：A 没有 startTurn，配置重查失败释放 A 的准入；对 A 的迟到停止不能移除 B 的准入/活跃 workspace lease；B 活跃期间 C 不能启动；最终 B/C/D 全 DONE，租约全 released、准入归零。

实测全部守住。限制：B 用 1000ms 本地 stall 保持活跃窗口；本例验证写权限和租约交接，不执行实际文件读改写，因此不能推断文件内容并发正确性。启动配置拒绝会使 runOnce reject，本例明确捕获这条已知路径；不与主代理测试的记忆故障蔓延混算。

证据：[a07-writer-lock-handover-QiPfML](../../dist/r124-chaos/commands/a07-writer-lock-handover-QiPfML/evidence.json)。最终 3 次 Fake start，0 真实调用。

### A08：子任务非法格式带 review 交接 → 补交删掉 review → 迟到停止

命令链：三个收件人的根请求生成仅角色 1 执行的真实协调计划 → 子任务输出有效 review handoff 到角色 2，但加非法 schema 字段 → outputInvalid → 正式 `task.redispatch(formatRepair=true)` → 同 commandId 重放修复命令 → 修复只交格式正确答案但删除 review → 另一项目独立任务 → drain → 对失败父 run 迟到停止 → 再尝试修复。

断言：原非法输出不接受交接；修复因遗漏仍有效 review handoff 再次 FAILED、子任务 BLOCKED；错误包含“遗漏…handoffs”；同 id 修复只消费一次工作项；无 review 幽灵执行，无新修复 turn，另一项目 DONE。

实测全部守住：子任务正好 2 次执行，父规划 1 次、另一项目 1 次；coordination_messages 为 0。父 run 此时已 FAILED，迟到停止明确返回 `already_stopped/stopGeneration=0`，父任务仍 BLOCKED；测试已断言这一事实，**不声称该停止把父协作取消了**。再次修复被 STALE_REVISION 拒绝的直接依据是同一逻辑输出修复资格已 consumed，不能归因于停止围栏。

限制：未测试修复新增合法 handoff 后的完整下游成功链；本例目标是保证已有复核义务不被格式补交悄悄丢弃，以及重复命令不重复执行。

证据：[a08-repair-handoff-stop-3T5sGu](../../dist/r124-chaos/commands/a08-repair-handoff-stop-3T5sGu/evidence.json)。最终 4 次 Fake start，0 真实调用。

### A09：UNKNOWN 写者遇到停用、移出、改配置、重复发送/停止

命令链：写者 A 脚本拒绝 interrupt → 正式停止 → 等 UNKNOWN → 停用角色 → 移出原房间 → bypassPermissions 改 plan → 重放原停止 commandId → 重放原发送 commandId → 同项目同物理根另一写者 B、其他项目写者 C 入队 → drain。

断言：A 仍 UNKNOWN、只有一次启动，其原准入与未释放 workspace lease 仍保留；没有 recovery.protectionReleased 事件；B 未启动，C DONE。停用/移出/权限收窄都不能当作旧进程退出证明而误放锁。

实测全部守住。限制：Fake 的不响应终止不代表真实 OS 进程已被杀掉；未进行重启、人工对账或正式保护解除。快照在测试清理之前记录，保留的锁不伪装成 released；fixture 结束仅停止本代理 Fake 会话并关隔离库。

证据：[a09-unknown-mutation-lock-a4PyJg](../../dist/r124-chaos/commands/a09-unknown-mutation-lock-a4PyJg/evidence.json)。最终 2 次 Fake start，0 真实调用。

## 0 真实调用及覆盖边界

本代理最终 9 个隔离库的 `SELECT count(*) FROM real_calls` 全为 0；包括首轮在内 36 份隔离快照也全为 0。最终合计 20 次 Fake start、0 重复 turn 启动、0 启动归属错误、0 消息目标归属错误。所有成员通过正式命令绑定 kind=fake，worker 明确注入本地 FakeRuntimeAdapter 子类；环境固定 `ZS_ALLOW_FAKE=1`、`ZS_RUNTIME=fake`、`ZS_REAL_DISPATCH_GUARD=1`、`ZS_DEFAULT_MEMBER_DISCOVERY=0`。未调用模型 CLI、远端 API 或远端仓库；本报告的 0 调用只适用于任务 A，不替其他代理的独立设计渠道作调用声明。

实测经过正式 daemon 命令网关、SQLite 事务、真实 outbox、生产 DispatchWorker/准入/物理 workspace lease、格式修复及协调校验和本地项目文件。未运行真实 Claude/Codex adapter、远端、UI/Electron、系统故障恢复或全仓回归；没有因源码相似而把未运行分支算作通过或缺陷。没有重复主代理的记忆存储写故障/构造失败蔓延、目录移走场景。

可跟踪新增文件只有 `tests/integration/chaosCommandsR124.test.ts` 和本报告。必要辅助文件、SQLite、日志、合成项目及索引均在 `dist/r124-chaos/commands/`；共享 helper、生产源码、续工文件及其他代理专属路径未修改。
