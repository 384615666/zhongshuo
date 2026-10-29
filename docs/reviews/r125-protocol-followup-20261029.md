# R125：补测两项 DeepSeek 协议猜想

本轮仅补 [R124](r124-adversarial-chaos-20261029.md) 明确未实测的两个方向。工作目录为 `D:/zhongshuo-public`，开始时工作树干净，HEAD 为 `1c0ccdf7b990aaa9f752ce0bde4bfdaa90b84319`。已读取 README、continuation 及 R124 总结/协议记录；公开克隆无 AGENTS.md。没有修改生产代码、既有 helper/fixture、R124 测试、continuation 或实施总账，没有修复、打包、提交或推送，没有访问或迁移旧目录运行数据。

两项均已实测，分成五个用例：**2 项守住，3 项预期反例**。后三个不是三个独立漏洞：S1 是 adapter 的活动期边界，正式 worker 有保护；S2 是已完成 provider 身份复用在两种 session 生命周期下的不同表现。没有把协议夹具产生的畸形输入说成官方提供方已产生，也没有声称真实用户已遭遇这些情况。

## 方法与范围

实际链路为本地 Node stdio JSON-RPC 子进程与 `CodexAppServerAdapter`。S1 worker、S2 worker 复用/不同 ID 对照三例另外经过正式 `dispatchDaemonCommand → 独立 SQLite/outbox → DispatchWorker → adapter → 子进程 → 正式 messages/domain_events`。每例都有独立 SQLite、空项目、命令记录、完整双向协议和清理前数据库快照；adapter 单测的正式业务表保持无 turn/回复，不能当作 worker 复现。

fixture 对第二轮 `turn/start` 支持 `holdResponse`，收到后记录 `response.held`，先发指定通知；只有控制文件的 `release:[key]` 才响应。每次控制后用同一 stdout 管道的 `model/list` 应答作已解析屏障，无随机 seed、无靠任意睡眠抢窗口。首轮终态也只能由显式控制释放。worker 使用正式默认关闭的执行截止，不用短超时制造失败。新轮缺终态的清理前事实在子进程仍活着时冻结；随后退出进程是测试清理，不能归因为 R124 的共享进程退出问题。

GPT 子代理制作独立 fixture，`newapi/deepseek-flash`/`max` 子代理只读推演断言与调用链，主执行会话编写并实际运行全部业务测试，另由 GPT 子代理只读复核。模型建议不作为实测证据。**产品业务执行 0 真实模型调用**；编程/审查及此前能力测试实际使用了模型子代理，不能声称本轮总模型调用为 0。

spawn 硬限制命令为 `process.execPath + tests/fixtures/chaosProtocolFollowupR125.mjs + 本例配置`；子进程只继承 SystemRoot/WINDIR、隔离 TEMP/TMP 和本地标识，未传认证或代理环境。fixture 只用 fs/readline，无网络客户端、真实模型 SDK 或工具子进程。每例 `real_calls=0` 是补充台账，不单凭 fake 成员身份宣称零调用。

## S1：首轮响应已回、尚未终态时再次启动

| 层次 | 最小步骤与对照 | 实际结果与判断 |
| --- | --- | --- |
| 公共 adapter | A 完成 `thread/start → turn/start` 响应，保留无终态；B 用 `openSession({resume:A})` 续接同 provider thread，C 新开不同 thread；同时对 B/C 调 `startTurn` | B/C 均 fulfilled，wire 在任何终态前已有三条启动，B 与 A 的 provider thread 相同，C 不同；最后三条流分别得到自己的完成。**adapter 反例**：绑定 provider turn 后缺少活动期互斥。不能称正式用户重复执行 |
| 正式 worker | 同 DM 第一条启动无终态，再发第二条；另在同项目/成员的房间新串发对照；泵四次，先只完成对照，再完成第一条，最后泵第二条 | 第二条 disposition=queued、未到协议；另一串已同时启动并可先 DONE，第一条仍 ACTIVE。在途峰值为 2，正式默认 global4/project2/provider2 配额未放宽。第一条完成并释放准入后，第二条才出现一条 `thread/resume` 和 `turn/start`，最后两条 DM 回复各自正确、准入归零。**正式入口守住** |

S1 的边界来自 adapter `startTurn` 仅检查同 provider thread 的 `awaitingTurn.providerTurnId === null`（`src/adapter/codex/appServerAdapter.ts:618`）；首轮响应已将其绑定，所以再次启动不被拒绝。worker 的同会话准入/DM 队列在其上游，本例没有绕过它，也没有把 adapter 的反例移作用户已发生的故障。

## S2：第二轮复用已完成的 provider turn ID

两条路径均先让旧轮明确完成；再发新轮，但把新启动响应挂起。响应前交错旧消息、新消息、旧终态；释放响应后再交错旧消息、新消息、旧终态和新轮终态。旧/新 item ID 和正文标记不同，便于追踪；它们的同一 thread/turn 协议身份则按场景故意相同。

| 层次 | 实际观察 | 正式可见结果与限制 |
| --- | --- | --- |
| 同一个公共 adapter SessionRef | 响应前所有同 ID 事件仍属于 `internal-old`；响应后迟到旧消息 `POISON_OLD_AFTER_RESPONSE` 和旧终态被标成 `internal-fresh`，stage 也变成新轮。公共 `interrupt(oldInternal)` 不再发 RPC，而 `interrupt(freshInternal)` 发出同 provider ID，佐证单 Map 已覆盖 | **adapter 反例**：旧输出进入新轮。正式 worker 每轮新建 transport session，未发现它复用同一 SessionRef 的正常入口；因此该污染不冒称正式回复已被污染 |
| 正式 DM 两轮，resume 到新 transport session，provider turn ID 重用 | 两个本地 session ID 不同、provider thread 相同。响应前的新消息 `SAFE_NEW_BEFORE_RESPONSE` 实际进入旧流；响应后出现两个同 tuple 映射，旧/新消息和终态均被 unknown-or-ambiguous 丢弃。新流只有 session.ready，没有归属新 turn 的事件 | **正式 worker 反例**：已解析终态后观察 250ms，新任务 ACTIVE、新 turn RUNNING、outbox leased、消费器 remaining=1、准入占 1，新轮没有可见 agent 回复。旧回复逐字节保持，未含 POISON。清理前进程仍活着。默认无执行截止，源码无将此映射冲突通知 worker 收口的分支；实测只声明该窗口及对应等待路径，不声称做了无限时长测试 |
| 正式 DM 相同步骤，只把第二轮 provider turn ID 改成独立 ID | 响应前新事件进入新流、旧事件只到旧流；响应后新终态正常落库，remaining 为空 | **正常对照守住**：旧回复不变，新任务 DONE。第二轮故意用了两个不同 item ID，因此形成两条可见消息，最终结构化答案追加到最后一条，不能把这个正常行为误判为重复业务执行 |

跨 session 情况没有覆盖旧 session 的 Map，而是两个 Map 同时声称同一个 provider tuple。`sessionByThread` 在响应前优先命中旧映射，响应后多映射返回 undefined；这与同 session 响应回调直接覆盖 `providerTurnToInternal` 是不同事实。对应 `appServerAdapter.ts:467/481/641`。worker 正常终态不会调用 adapter.close，DM 后续调用新的 openSession(resume)，故正式路径可达到第二行；新 session 不等于独立 provider thread。

无法单凭同一 tuple 分辨迟到帧属于哪一轮，因此健康约束允许显式拒绝/失败收口；不要求冒险将重用 ID 当成正常成功。测试保留“不把旧输出标为新轮、解析过终态后不能继续无解释地挂着”的健康断言，没有以实际错误值取代健康期望。

## 证据与复放

仅新增以下三个可跟踪文件：

- `tests/integration/chaosProtocolFollowupR125.test.ts`
- `tests/fixtures/chaosProtocolFollowupR125.mjs`
- 本报告 `docs/reviews/r125-protocol-followup-20261029.md`

原始证据在 ignored 的 `dist/r125-protocol-followup/`；`evidence-index.json` 冻结本次接受的五个目录及逐文件 SHA256。按 label 定位：`S1-adapter-overlap`、`S1-worker-serial`、`S2-adapter-reused-id`、`S2-worker-distinct-id`、`S2-worker-reused-id`，对应 `*-latest.json` 是重跑定位指针。

| 用例 | 本次接受目录 |
| --- | --- |
| S1 adapter 重叠 | `S1-adapter-overlap-VXj7qc` |
| S1 worker 串行及不同串并行 | `S1-worker-serial-Xeesmc` |
| S2 同 session 覆盖 | `S2-adapter-reused-id-Rel9YB` |
| S2 worker 不同 ID 正常对照 | `S2-worker-distinct-id-5BVXEA` |
| S2 worker 复用 ID 反例 | `S2-worker-reused-id-QGHojf` |

每目录包括 `scenario.json`、`wire.jsonl`、`control.jsonl`、`commands.jsonl`、`launches.json`、`result.json`、`cleanup.json`、`after-cleanup.json` 和 `state.sqlite`。三条正式路径的 `result.json.databaseBeforeCleanup` 是故障判断真源；复用 ID 反例最终 SQLite 已被测试显式 abortConsumers 收为 UNKNOWN，不能拿清理后的库替代 ACTIVE/RUNNING 的清理前事实。`streams-after-harness-exit.json` 另存后续排空结果，不反写观察窗口。

```powershell
Set-Location D:/zhongshuo-public
node node_modules/vitest/vitest.mjs run tests/integration/chaosProtocolFollowupR125.test.ts --maxWorkers=1
node dist/r125-protocol-followup/audit-evidence.mjs
```

默认 `default-final.log`：**2 passed | 3 expected fail (5)**，exit 0。三条 `defect` 默认注册为 `it.fails`，绿色表示反例成功固定。另用完全相同健康断言按普通测试执行：

```powershell
$env:ZS_R125_HEALTHY_ASSERTIONS='1'
node node_modules/vitest/vitest.mjs run tests/integration/chaosProtocolFollowupR125.test.ts --maxWorkers=1
Remove-Item Env:/ZS_R125_HEALTHY_ASSERTIONS
```

`healthy-assertions-final.log` 为 **3 failed | 2 passed**，exit 1，三条失败分别精确停在同 thread 第二轮应拒绝、旧正文不应归新轮、新正式消费者应有收口这三个健康业务断言；无 harness/cleanup/unhandled 错误。套件外层 `afterAll` 独立校验每例 result、DEFECT 业务断言到达标记及清理事实，不受 `it.fails` 反转；另有仅在 close 函数所有步骤正常返回后才登记的成功标记，防止 dispose/快照写入错误被 finally 写出的正常 cleanup 字段掩盖。`afterEach` 另作逐例核对。任何早期 setup/SQL/断言或清理错误都不能仅凭预期失败变成套件绿色。存活期快照另记录实际 child.exitCode/signalCode，不依赖日志缺失推断进程存活。

已实际通过完整 TypeScript `node node_modules/typescript/bin/tsc --noEmit --pretty false`、两个新代码文件 ESLint、fixture `node --check`、证据审计和五例的实际子进程关闭。最终五个协议子进程均有 close/退出事实，消费器清理后为空、数据库均已关闭；Windows 进程查询未发现本 fixture 残留。`node_modules` junction 仅作既有依赖使用，没有 pnpm 安装或脚本。未重复 R124 的 39 项与相关旧回归 77 项。

早期 harness 诊断不计产品反例：初版快照误查不存在的 dm_queue，已改为真实 dm_turn 无 run 的队列事实；不同 item ID 的正常对照最初误设消息总数为 2，已按两条消息及最后追加答案的正式语义核验。早期目录保留但未列入接受索引。一个只读子代理因重定向产生的空 `$null` 副产物已由主会话检查并移除，最终 git status 只含上述三个专属文件。

## 指挥会话复核

主会话复核测试和清理逻辑后，独立复跑本文件得到 `2 passed | 3 expected fail (5)`；记录为 `dist/r125-protocol-followup/parent-review.log/.json`。完整 TypeScript 与两个新代码文件 ESLint 通过。另按执行会话冻结的 `evidence-index.json` 校验五组的 47 个 SHA256，全部一致；复跑生成的新目录不替换原冻结索引。

结果已并入 [当前异常清单](anomaly-list-20261029.md) 的 19、20 项；第二项以正式新任务挂起为已证影响，不把底层同 SessionRef 分支的输出污染夸大成正式聊天污染。主会话另更新续工记录和实施总账；未改生产代码、未生成新包。
