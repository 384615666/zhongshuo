# R126 独立只读复核：worker / commands / stopFlow

复核范围：用户授权的 1—14、20 中与 worker、停止、归档、笔记恢复有关的变更；完整读取三个生产文件的当前 diff、continuation 最新段、异常清单、README 项目约定及相关实现。公开克隆没有 AGENTS.md。adapter 仅查进程事件和 lateEvents 接口边界，没有重复大规模协议评审。15—18 不修、19 暂缓；特别不修 17 的 bundle hash。

## 原确认问题：1 项（后续已修并独立复验关闭）

当前结论以文末补充为准：主会话已完成下述 P1 最小修复，本复核新增三项正式回归及真实 Windows Job 复跑均通过；本次限定 worker/commands/stopFlow 范围没有遗留必须修复项。以下保留原缺陷及原始证据。

**[P1 / 12] retained 保护下的合法迟到成功，笔记 pending 被永久删除。**

精确位置：`src/daemon/dispatchWorker.ts:2225`—`:2229`，`settleRoleMemoryProposals` 把全部 RoleMemoryError 当作永久无效提案；同文件 `:2852` 正式 late pump 新增提案，`:2879` 立即尝试合并。store 的 `src/persistence/stores/roleMemory.ts:113`—`:117` 正确地把用户停止和 retained 保护均拒绝为 `ROLE_MEMORY_TURN_CANCELLED_OR_PROTECTED`；问题在 worker 不区分暂时保护就删除 pending，**不应放宽 store**。

独立实证全链：Fake 执行 + 本地 Node 合成载体（真实 Windows Job）、正式 message.submit/worker/SQLite → UNKNOWN → `recovery.reconcile{verdict:'executed'}`（真实载体仍活，正式生成 retained；没有 SQL 修改保护字段）→ 注入合法同 turn 迟到结果 → 正式 `recovery.pumpLateEvents` → turn=SUCCEEDED、protection_state=retained、准入继续保留，但 pending=0、commits=0、roleMemory.rejected 原因为上述保护错误。随后本地载体真实完整退出、正式 `recovery.releaseProtection` 成功 → protection_state=released、准入释放；runOnce 和第二连接重开 worker 均无笔记、无 pending、commits=0。只有一次 startTurn，real_calls=0。

证据：`dist/r126-review/retained-late.mjs`；`dist/r126-review/retained-j9HAhA/result.json`。脚本当前断言的是缺陷事实，不是修复后健康断言。

可达性口径：生产 commands/worker 的正式恢复链允许这个状态组合，未假造 retained/成功状态或绕过 pump。当前内置真实 Claude/Codex adapter 未实现可选 lateEvents，只有 Fake 实现；所以证据不是“真实 CLI 已复现”，也不要求本轮扩展 adapter。它是本轮 12 明确承诺修复的正式 pump 逻辑遗漏，C08 使用无 retained 的 Fake 因而漏测。没有关联 17 的输入篡改或 bundle hash 加固。

最小修法：仅在已经 SUCCEEDED、无本轮有效用户 stop、task 非 CANCELLED、run 非 STOPPING/CANCELLED、当前 protection_state=retained 的情况下，把该保护拒绝当作可重试，持久保留 pending，待正式解除保护后让现有 runOnce/启动扫描重新走 mergeRoleMemory。停止判断继续按 stop_generation_snapshot（含旧 -1 回落）比较，不要以历史 stop_generation>0 一概拒绝。可在 worker 预检查该暂态或在 catch 中重查；其他 RoleMemoryError/非法 schema/来源错误仍永久拒绝，SQL 故障仍延后。保留 store 的全部保护、scope、输入、幂等校验，pending 删除与 merge 继续同事务。应补 retained→成功→重开仍保留→正式解除→恰一次合并，以及 retained 同时存在有效 stop 的负例。

## 已核查边界与结果

- **1 退出收尾**：process.exited 经 session/turn 归属检查后收 UNKNOWN，消费者结束；现有 finally 完结 outbox，但 releaseAdmission 对 UNKNOWN/retained 保留占用，写租约不释放。没有进入自动 transient/output 重试。workerRecovery 的写入项目反例确认其他项目可继续、同根任务不启动。
- **2 归档**：room/project lifecycle 的 OPEN 检查在命令事务内；房间只挡本房间任务，DM 挡项目归档/移除、不挡无关房间。DIRECT 已归档根派发前阻断，openSession 返回后再次检查；尚未 startTurn 的确认关闭分支仅释放自身 turn 的准备占位/租约。已有 OPEN 任务无法经正式归档命令并发穿过。没有把直接修改恢复库的研讨/项目状态当作新的正式入口缺陷。
- **3 笔记 SQL 故障**：合并/删除 pending 同事务；独立 trigger 在 values 插入中途失败，scope/revision/commit 不留下半次提交，pending 保留；另一 scope 正常提交，故障仍在时新 worker 可启动，故障撤销后一次提交、不重跑模型。独立 Proxy 仅让 core admission 恢复读取失败，构造器仍明确抛“准入占位恢复失败”，没有吞掉核心恢复失败。
- **12 其余边界**：独立 trigger 分别使 pending INSERT、task_deliveries INSERT 失败，正式 pump 的回执、UNKNOWN 迁出、提案/交付全部回滚；撤销后重放只合并一次。正式 task.stop→UNKNOWN→迟到合法成功保持 CANCELLED、不合并笔记；late failure 不提升成功/笔记。无 retained 的 C08 在 replay/reopen 后仍恰一次；retained 遗漏如上。
- **13 停止身份**：相同/刷新代次重复停止不再推进；旧运行/旧回执不影响同 revision 后继运行及后继 STOPPING 子任务；新明确目标可推进下一代。rowid 用作与现有历史一致的创建顺序，无 UUID/revision 顺序假设。
- **14 错误与回滚**：StopCommandError 继承标准业务错误身份；冲突、未来代次、过期回执保留业务码。真实 SQL trigger 故障回滚代次、run、回执且不泄露诊断；中断回调故障仍报告失败并保留已持久 STOPPING，不伪称释放保护。

独立执行结果：

| 检查 | 结果 |
| --- | --- |
| chaosStorageR124 + workerRecoveryR126 + stopArchiveR126 | 3 文件 19 普通通过 |
| chaosMemoryR124 仅 C08 | 1 通过，8 未选中 |
| lateOutcomePath / recoveryDev13 / recoveryProcessEvidence / r99UserStopBounded / chaosCommandsR124 | 5 文件 49 普通通过，1 原 expected fail（A06，即未授权改变的 16） |
| 独立 memory-boundaries.mjs | 6 组边界全部断言通过 |
| retained-late.mjs | 确证上述 P1，正式解除/重开仍丢失 |
| 三个生产文件及两新增测试 diff --check | 退出 0 |

合计 69 普通测试通过 + 1 既有预期反例，不把该反例算修复通过。原始 JSON 与全部新增脚本/临时库均在 `dist/r126-review/`；运行已有测试时它们依自己的 fixture 另写既定 ignored 证据目录。没有修改生产或已有测试，无提交/推送、真实模型、原业务数据或旧私有历史访问。

补充边界脚本：`dist/r126-review/memory-boundaries.mjs`，最终证据 `dist/r126-review/memory-boundaries-result.json`。最初脚本以 conversation 答复测试 task_deliveries INSERT，但该分支不产生工作交付，修正为合法 work 成果后覆盖到真正交付故障；late failure 原本额外断言 FAILED，当前既有 UNKNOWN 终态保护保持 UNKNOWN，改为本次所需的“不提升成功/不合并”断言，没有把既有失败收口规则列为新问题。

本次核查结束时生产文件 SHA256：

```text
dispatchWorker.ts 9275E811A8CBED2087C37FDE3C4A49FCA1EE2CC01AF5042CFDF0A50A9DED5315
commands.ts       E0A9A37F9E7A247FB6498356D99F85C34367582AA01313028D98CE3D7609AB7A
stopFlow.ts       E4B204182E64E087B748929A6005CF3DA81F3C52CC05557BBAA41A430C8B5F27
roleMemory.ts     66A2CDDCC7E3C416C06C6D027C0BDF394D697443FDE3DD9B1F7CB622095F1C43
```

源码并发施工；以上结论对应这些当前字节，不对之后修订冒称复验。

## 后续补充：非法终态保护及 retained 笔记修复已复验

主会话新增 `applyEvent` 入口固定码 `CODEX_INVALID_TERMINAL_STATUS` → UNKNOWN，在 DELIB 分流之前处理；没有经过普通 FAILED 或自动恢复分支。已复核 DIRECT 的消费 finally、DELIB 缺席/准入与写租约、正式 late pump 和回执重放：未知终态不能证明写入停止，均保留 UNKNOWN/写租约/占位，不合并笔记、不重跑；明确 failed/provider-confirmed interrupted 对照仍为原 FAILED 语义。workerRecoveryR126 的两个可写保护测试开启 automaticRecovery，并验证其他项目继续、同根不启动、原任务仅一次执行。

`workerRecoveryR126 + chaosDeepseekR124` 初次复跑时，DeepSeek 文件尚未同步 UNKNOWN 断言，出现 5 项“期望 FAILED、实际 UNKNOWN”，属于并发施工的旧测试预期；另 7 项通过。协议执行会话更新后，两文件 12/12 通过，证据为 `dist/r126-review/invalid-terminal-regression-updated.json`。独立 `invalid-terminal-boundaries.mjs` 的 DELIB/late（含重复 pump）、明确 failed、明确 interrupted 四组均通过，最终结果为 `dist/r126-review/invalid-terminal-boundaries-result.json`。未修改 workerRecovery/DeepSeek 文件或 adapter。

主会话修复 retained 时仅对 store 抛出的 `ROLE_MEMORY_TURN_CANCELLED_OR_PROTECTED`，在已 parse 合法提案后复查 SUCCEEDED+retained、task 非 CANCELLED、run 非 STOPPING/CANCELLED、stop_generation 没有超过 turn 快照，保留 pending 并延后 1 秒；其他永久拒绝分支、store、bundle hash 均保持。解除后重新经过原 store 事务/来源/幂等校验；历史快照 -1 继续用旧保守规则。

本复核依用户新增授权，独占新增 `tests/integration/retainedMemoryR126.test.ts`，没有改生产文件或其他已有测试。三项均使用独立 SQLite、Fake 输出、真实本地 Node Windows Job，通过正式 reconcile 制成 retained、正式 late pump 接纳成功、真实退出证据与正式 releaseProtection 解除，无 SQL 伪造保护状态：

1. 保护未解除时不合并且 pending 保留，超过 1 秒重试及关闭数据库重开后仍保留；同成员另一房间/独立 scope 的任务照常 DONE。
2. 真实 Job 完整退出并正式解除后，原 worker 的下一次定时重试提交一次；关库重开、重复 pump、再重开都维持一个 commit/revision=1、无模型重跑。
3. 保护等待期间注入明确的有效用户停止边界（tasks.stop_generation=turn.stop_generation_snapshot+1，不改成功状态/保护/提案/输入），下一次重试删除被停止提案、不合并；另一 scope 继续，正式解除及关库重开仍不合并。成功终态无法经 task.stop 形成新停止代次，所以这里按授权明确使用边界注入，没有把它说成正式停止命令端到端证据。

三项最终与 chaosStorageR124 同跑 7/7；C08 再跑 1/1（8 未选中）；新增文件 eslint、完整主工程 tsc、hifi tsc 均退出 0。最终测试 JSON 为 `dist/r126-review/retained-memory-final.json` 和 `dist/r126-review/c08-fixed.json`，每项单独目录在 `dist/r126-review/retained-test-*` 下保存关键阶段状态和正式命令响应。前述初次三项独跑结果在 `retained-memory-regression.json`。

原最小脚本仅增加 `--expect-fixed` 健康断言模式，保留原默认缺陷断言和原证据不动。修前 `retained-j9HAhA/result.json` 是 pending=0 / commits=0 且解除重开仍丢失；修后运行 `node dist/r126-review/retained-late.mjs --expect-fixed` 退出 0，`retained-emZILy/result.json` 显示 retained 时 pending=1 / commits=0 / 准入保留，正式解除后准入释放、同 worker 未满退避仍保留 pending，重开立即 commits=1 / pending=0 / revision=1。原任务总 startTurn=1、fresh adapter starts=0、real_calls=0。

原 P1 因上述实证关闭，非法终态保护新增接线未发现必须修复项；不扩大为全产品认证，真实 CLI lateEvents 可用性边界仍按原报告说明。本次补充仍无真实模型/原数据/旧私有历史访问，无提交推送。

最终补充复验生产字节：dispatchWorker.ts SHA256 `4D944B518632F4224CD9BDBC360FE5C5274A430D43D188547AC071EA97F3B165`；commands/stopFlow/roleMemory 保持上表 SHA256。
