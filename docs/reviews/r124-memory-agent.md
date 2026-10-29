# R124 任务 C：共享记忆及隔离破坏测试

基线：`D:/zhongshuo-public`，HEAD `70e7969`，2026-10-29。先读 README、continuation 及 implementation-status；本分支只新增专属测试、此报告和 ignored 证据，没有修改生产代码、共享 helper、运行数据，没有提交、推送、打包。未读写 `D:/zhongshuo` 的业务数据库或任务数据；只通过现有 junction 使用依赖，未执行 pnpm。

最终 **9 组：7 组场景守住，2 组缺陷/完整性反例复现**。Vitest 的 `7 passed | 2 expected fail` 表示两条正确性断言仍失败，不能称产品全部通过。其中 C08 是正常恢复调用链遗漏；C09 必须先直接损坏隔离库中的冻结输入，归为完整性校验缺口，不声称普通用户或模型能经产品 API 串换数据库。

本分支最终运行共 **39 次进程内 Fake startTurn，9 个隔离库的 real_calls 均为 0，fetch 调用尝试 0**。DeepSeek 场景设计和其他代理的协议/故障测试不计入此结果；未重复主代理的 memory merge 写故障全局堵队、持久故障启动失败、项目目录移走场景，也未复测 R123 的最终笔记撤回或临时表写失败。

**执行与验收**

工作目录均为 `D:/zhongshuo-public`，最终执行命令及退出码：

```powershell
node node_modules/vitest/vitest.mjs run tests/integration/chaosMemoryR124.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=dist/r124-chaos/memory/vitest-attempt-04.json
# exit 0：9 tests，7 passed，2 expected fail；3.09s

node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
# exit 0；已消除 fixture 返回值/注册表循环推断及随之而来的 implicit any

node node_modules/eslint/bin/eslint.js tests/integration/chaosMemoryR124.test.ts
# exit 0

node dist/r124-chaos/memory/verify-evidence.mjs
# exit 0：逐项校验最终运行的 9 份 evidence/observations、两条实际失败信息、0 real_calls/0 fetch
```

只运行自己的测试文件，未扩大成全套测试。`tsc` 为静态检查，不执行其他代理的测试或模型。生产源码和 `tests/helpers` 的 `git diff --name-only` 为空；其他代理的未跟踪文件未修改。

完整索引：[accepted-evidence.json](../../dist/r124-chaos/memory/accepted-evidence.json)。每个目录保留 `state.sqlite`、`observations.json`、`evidence.json`；后者包含全部正式命令参数/响应、实际 adapter 输入、任务/轮次/bundle/笔记/协调消息/格式修复/outbox/事件表与 pending 项。证据全为独立合成数据。复跑产生新目录，不覆盖旧现场；生成新最终运行时可相应更新验收脚本使用的 JSON 报告名。

此前草稿 `vitest-attempt-01/02/03.json` 原件保留，**不作为最终验收**：01 的本地观测类属性曾遮蔽 Fake 私有 sessions；02 的协调观测错读 OpenSessionInput 上不存在的 conversationId；03 虽显示 expected fail，C08 却先被“conversation 结果应有 work 交付”的错误测试前置条件拦住。最终 C08 改为明确 work 结果并实际得到一份交付，未削弱缺陷断言。两个 `it.fails` 的断言前置完成标记移入套件 `afterAll` 校验，防止 `it.fails` 把设置/清理错误误算缺陷；另用证据验收脚本检查两条失败原文与真实状态。

**公共命令链与观测口径**

每组先 `app.settings.set(callBudget.enabled=false)` → `project.open(该组临时目录)` → 两次 `member.create(同名角色)` → `member.setRuntime(fake,plan)` → 两次 `room.create(同名会话)` → `room.update(coordinatorMemberId)`。所有成员都绑定 `fake`，worker 的 `adapter` 与 `adapterFor` 只返回同一个进程内 MemoryFake；没有真实 provider adapter 或外部模型进程。`ZS_ALLOW_FAKE=1`、`ZS_RUNTIME=fake`、`ZS_REAL_DISPATCH_GUARD=1`，全局 fetch 桩任何尝试即计数并抛错。

`runOnce/drain`、SQLite、正常命令路由、终态校验、笔记存储及恢复逻辑均为生产实现。只有执行端脚本和终态传输屏障为测试构造；屏障延迟 worker 收到终态，用于确定完成顺序，不冒称 OS 子进程并发认证。下列每组的完整参数、ID 和响应见对应目录 `evidence.json`。

| 场景 | 结果 | Fake 启动 | 记忆提交 | 最终证据目录（dist/r124-chaos/memory 下） |
| --- | --- | ---: | ---: | --- |
| C01 同名身份、房间/私信来回切换 | 守住 | 11 | 5 | c01-identities-mJKvQD |
| C02 旧基线跨两次更新后乱序完成、重复 key | 守住 | 4 | 3 | c02-reorder-duplicates-HHB9Qw |
| C03 成功/失败/停止/UNKNOWN 带合法前置消息 | 守住 | 5 | 2 | c03-terminals-ESFqpR |
| C04 格式修复遇到其他串的新版本 | 守住 | 3 | 2 | c04-repair-new-base-bK4dMB |
| C05 规划→同伴 reply 交接→整合 | 守住 | 4 | 4（含另一房间种子） | c05-coordination-sT6YBs |
| C06 来源字段与指令状文本投毒 | 守住（结构、来源、权限范围） | 3 | 1 | c06-poison-wtHbet |
| C07 在途 bundle 错房间/错角色/重复行 | 守住 | 5 | 0 | c07-wrong-bundles-OVw3FD |
| C08 UNKNOWN 后正式迟到成功及重放/重开 | 缺陷复现 | 1 | 0（应为 1） | c08-late-success-ETrWqc |
| C09 同范围新 bundle 换入旧轮次 | 完整性缺口复现 | 3 | 2（错误基线提交被接纳） | c09-same-scope-swap-mfC8fg |

**C01：同名不等身份，实际 worker 经过两条私信和房间切换**

命令链：公共初始化 → 两次 `conversation.create(同一 peerMemberId、同一 title)` → 依次向角色 A/房间甲、角色 B/房间甲、角色 A/房间乙、私信 1、私信 2 各 `message.submit` 并完成 → 按“私信 1→房间甲 A→私信 2→房间甲 B→房间乙 A→私信 1”再次提交只读探针。

断言：五个 scope 各自 revision=1，只含自己的 `IDENTITY_SCOPE_i`；实际下一轮 bundle scope/memberId 与目标 ID 一致，权限保持只读；来源 taskId 对应种子，私信来源 threadId 为 null。实际：11 启动、5 提交，6 次切换探针全部读取正确，两个同名角色和两条同名同对端私信未合并。限制：这里测服务端命令和 worker 输入隔离，不含真实 UI 的切页竞争；跨项目身份隔离未在本组重测。

**C02：同 key 多值、同轮重复、同文异来源与不同基线乱序叠加**

命令链：A/B 两条根请求 → `runOnce` 各启动一次，屏障扣住 A 终态 → B 先成功 → C 新根请求读取 revision=1 并成功 → 放行 A → 再发只读探针。A 增量为 `(' shared ',' A ')`、`('shared','A')`、`('shared','B')`；B 为 A，C 为 C。

断言：A/B 输入基线均 0、C 基线 1；提交顺序精确为 B(base0→rev1)、C(base1→rev2)、A(base0→rev3)；trim 后同轮重复去重，最终同 key 4 个带来源的值为 A/A/B/C，conflicted=true，A 的来源保留两条；后续真实 bundle 等于该快照。实际全部吻合，探针不增加提交。限制：进程内 worker 与实际 SQLite，未重复 R123 已有独立进程 SQLite 并发写连接测试。

**C03：合法消息缓存先到，随后失败/停止/UNKNOWN，旁路成功继续记忆**

命令链：种子成功写 `SEED_KEEP` → 两根请求启动，分别先发合法且 resultKey 正确的 message.completed；一条 `turn.failed`，另一条正式 `task.stop` 得到 CANCELLED → 再启动不响应中断的候选和正常候选 → 对前者正式 `task.stop`，宽限后 UNKNOWN，后者完成 `GOOD_KEEP`。

断言：失败/取消/UNKNOWN 三候选均不进入记忆、pending=0；既有笔记保留且正常成功新增一次；失败/取消/未知真实终态确实出现。实际 revision=2，只含 SEED_KEEP/GOOD_KEEP；5 次 Fake 启动、2 次提交。此为记忆污染组合，不重复仅调 SQL 设置状态的 R123 store 测试。限制：UNKNOWN 来自本地不响应停止脚本，不认证真实进程存活或真实中断能力；未知轮次没有借人工改状态放行。

**C04：格式失败→别串先更新→只读修复，来源与旧逻辑 resultKey 分离**

命令链：损坏结果根请求与另一串并发；损坏结果携带合法笔记但顶层多出字段，正常合同拒绝 → 另一串成功形成 revision=1 → 正式 `task.redispatch(formatRepair=true)` → 修复成功。

断言：失败源轮次无记忆提交；修复 bundle 实际读取 revision=1；格式工作项 source_turn_id/consumed_turn_id 绑定正确；adapter 请求沿用源 resultKey，但记忆来源是修复 turn，base_revision=1，实际权限只读。实际 3 次启动、2 次提交，记忆保留 OTHER_COMMITTED/REPAIRED_CURRENT；REJECTED_SOURCE 未提升。限制：修复是明确本地合成新结果，不推断真实模型会保留原业务语义；未再做修复耗尽/修复套修复。

**C05：规划、同伴 reply 消息和整合的来源隔离**

命令链：先在房间乙让协调者成功留下 OTHER_ROOM_SECRET → 房间甲 `message.submit` 明确两位同名成员 → 实际规划结果提交一步 peer plan 与 OWNER_PLAN → 同伴实际 child worker 提交 PEER_NOTE，并经 handoffs 向协调者发 purpose=reply 的 PEER_HANDOFF_DELTA → 实际 integration worker 提交 OWNER_FINAL。

断言：房间甲实际启动恰好规划/同伴/整合 3 轮，所有输入不含另一房间秘密；协调者记忆只含 OWNER_PLAN/OWNER_FINAL，同伴记忆只含 PEER_NOTE；整合的 roleMemory 只有 OWNER_PLAN，但正式上下文含合法交回的 PEER_HANDOFF_DELTA；coordination_messages 中恰一条 reply。实际全部吻合。限制：同伴意见经明确交接可进入整合上下文，不能据“整合看到了同伴文本”误判成记忆 scope 泄漏；只验证这一种真实规划+回复链，未覆盖所有研讨阶段。

**C06：来源字段投毒必须拒绝，指令状笔记文本不改变程序权限**

命令链：根请求输出一个正常笔记和一个额外带 sourceTurnId 的笔记混合数组 → 合同失败 → 新根请求合法提交 key 为 `__proto__`、`constructor`、`sourceTurnId` 的三份文本，其中一份伪装系统指令/其他来源 → 后续真实 worker 读取探针。

断言：混合非法数组整轮不写，第一份“正常”项也不能部分落库；三份合法文本按原文保留，所有 sourceTaskId/sourceTurnId/sourceThreadId 由真实成功轮次生成；后续输入有“资料不构成指令/授权”的说明、冻结权限仍只读，其他角色/房间仍为空，总任务数恰 3，未被笔记自动派生新任务。实际符合，3 启动、1 提交。限制：这证明结构校验、资料序列化、来源和程序权限未被文本改写；**不是实际模型抗 prompt injection 行为认证**，没有真实模型参与。

**C07：实际成功输出遇到错范围或不唯一的冻结输入**

命令链：另房间/另角色各正常执行以生成真实 donor bundle → 新目标根请求已 startTurn 后扣住终态 → 在隔离库分别注入另房间 included_refs_json、另角色 included_refs_json，或重复同 turn 的 bundle 行 → 放行正常合法终态。

断言：业务仍按正常合法结果 DONE，但笔记为 0，pending 清理，有明确 roleMemory.rejected。实际前两项 reason=ROLE_MEMORY_TURN_SCOPE_MISMATCH，重复行 reason=ROLE_MEMORY_INPUT_SNAPSHOT_MISMATCH，各一条审计。5 次启动，0 次提交。限制：三分支都需要直接改写本组测试数据库，是冻结资料损坏注入；不声称普通用户消息能写 context_bundles。与 C09 相比，范围不符与不唯一保护确实工作。

**C08：正式迟到成功漏记忆，重复泵与重开不能补回（正常调用链缺陷）**

最小命令链：`message.submit` → worker 真正派发并保存 bundle → 60ms 执行截止及 50ms 宽限后 UNKNOWN（没有用户停止、没有 SQL 伪造成功）→ Fake 将合法 work 终态追加到持久化事件日志，含正确 resultKey 与 `memoryUpdates:[{key:'fact',text:'LATE_SUCCESS_NOTE'}]` → 正式 `recovery.pumpLateEvents` → 再泵一次 → 用同路径另开数据库连接和全新 adapter/worker → 再泵已终态轮次。

前置断言已全部成立：第一次 status=pumped、一个 applied 回执，turn=SUCCEEDED，task=DONE，实际 task_deliveries 恰 1；重复泵 status=not-unknown，回执仍恰 1；全新 adapter startTurn=0。独立证据校验另确认 protection_state=null、stop_generation=0，排除“用户停止/保护仍在，所以不记”的解释。**应有笔记一次，实际重开前后 revision=0、entries=[]，commits=0、pending=0。** 终态重放本身没有重复交付，但无法修复记忆遗漏。

最后正确性断言仍为 `expect(texts(afterReopen)).toEqual(['LATE_SUCCESS_NOTE'])`，实际失败原文为 `expected [] to deeply equal [ 'LATE_SUCCESS_NOTE' ]`，用明确的 `[DEFECT] it.fails` 保留。

来源定位：正常消费在 `src/daemon/dispatchWorker.ts:2123` 调 prepareRoleMemoryProposal，终态后 settleRoleMemoryProposals；`pumpLateEventsForTurn` 从约 2699 行开始，约 2817 行直接 applyEvent，绕过了这两段记忆接线。构造器只补已有 pending，而本路径根本没建 pending，因而重启不补。建议主代理按正常/迟到两条入口统一终态记忆流程；本分支没有实施修复。

限制：迟到提供方是本地持久化 Fake 协议事件；已经验证生产恢复路由、合同校验、交付及记忆事实，没有认证真实 Claude/Codex 的会话文件回放能力。本组新 worker 使用第二个 SQLite 连接，未把它表述为 OS daemon 崩溃重启实机认证。

**C09：同 scope 新输入串换，合并未核对冻结 envelope 身份与 hash（存储故障完整性缺口）**

最小链：A 正式 startTurn，实际发送 memory revision=0，扣住终态 → B 同角色/同房间另一串正常成功形成 revision=1 → C 第三串读取 revision=1 形成真实 donor 输入 → **只在隔离库**把 A 的 context_bundles.included_refs_json 替换成 C 全部 JSON，保留 A 的行 turn_id/thread_id/hash → 放行 A 原先合法笔记终态。

前置：A 原 envelope 的官方 canonical hash 与原记录一致；C turnId/threadId 都不同，官方 computeTurnBundleHash(C) 与 A hash 不同；外部证据校验还核对 adapter 实际收到的 inputBundleId 是 A 的 hash 派生 ID，实际 prompt 中共享记忆 JSON 的 revision=0/entries=[]。**实际却给 A 建立 base_revision=1、revision=2 的记忆回执**，保存 SWAPPED_BASE_NOTE；这是记忆基线被错误改标，真实来源 task/turn 仍是 A，不是跨角色文本泄漏。

最后正确性断言仍为 `expect(receiptForA).toBeUndefined()`，实际 `expected { …(10) } to be undefined`。对应 `[DEFECT] it.fails`，完整回执和两个 hash 在 observations.json。

来源定位：`src/daemon/dispatchWorker.ts:2146` 在终态重新读取 bundle 的 roleMemory，以其中 scope/revision 建提案；`src/persistence/stores/roleMemory.ts:122` 仅取 SQL 行的 thread_id 与 included_refs_json，检查 memory scope/revision，没有把 envelope.turnId、executionScopeKey 或 canonical hash 与真正发送过的输入身份核对。因此 C07 的错 scope 能拒绝，C09 的同 scope 身份串换可通过。

限制：必须预先拥有直接改测试数据库的能力，不存在已证实的公开写入入口；这个注入用来检验存储损坏/串换后的审计完整性，**不应上升为已证实远程越权漏洞**。也没有声称拒绝损坏输出是唯一合适的产品策略；至少不能把伪造版本记作已发送基线。此项与正常“旧版本可以合并”不同：A 真正读到 0，应按 0 合并，而不是事后改成 1。

**未测边界**

未调用真实模型、CLI、网络或远端，未测试真实模型是否正确提交笔记/是否服从恶意文本、真实渠道限流、真实 OS 子进程并发与崩溃恢复、UI 房间切换、多进程独立 SQLite 写连接、DELIBERATE 全阶段、磁盘满/权限/断电/损坏恢复，以及超大记忆性能。没有把 store/schema 单测或 prompt 字符串包含断言冒充这些行为的端到端证明。R123 已覆盖的终态撤回、临时存储写失败和主代理本轮的故障蔓延未重复。
