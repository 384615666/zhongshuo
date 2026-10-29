# R124 B：协议畸形、乱序与进程失效

基线 `70e7969932771b2837b45d9bc22fd1be28afe6d8`，工作目录始终为 `D:/zhongshuo-public`。10 组已收口：2 组守住目标边界、8 组反例复现；**8 个 expected failure 不等于 8 个独立产品缺陷**。P07/P08 是未清理 awaiting 状态的两条路径；P04 是正式 worker 守住、adapter 仍输出终态后事件的混合结果。下面按实际证据报告，不将测试文件绿色等同于产品通过。

仅新增本专属文件：`tests/integration/chaosProtocolR124.test.ts`、`tests/fixtures/chaosProtocolR124.mjs`、本报告。没有修改生产代码、共享 helper、已有 fixture；没有提交、打包、推送或调用真实模型/远端；未打开或迁移 `D:/zhongshuo` 的运行数据。node_modules junction 只作为既有测试依赖使用，未运行 pnpm 或依赖安装。

执行采用真实 `CodexAppServerAdapter`、实际 Node stdio JSON-RPC 子进程。P02/P03/P04 另走正式 `dispatchDaemonCommand → SQLite/outbox → DispatchWorker → adapter → 子进程 → messages/domain_events`，不是调用 `applyEvent` 或私有映射方法注入。三组均有用户可见消息链及数据库前后快照。正式命令建立只读项目、fake 身份成员并关闭调用预算，实际执行端由 worker 的 adapter 参数指向真实 Codex adapter 的本地 mockEntry；没有真实 runtime 元数据探测或账户读取。

复放命令：

```powershell
Set-Location D:/zhongshuo-public
node node_modules/vitest/vitest.mjs run tests/integration/chaosProtocolR124.test.ts --maxWorkers=1
```

最终结果为 `2 passed | 8 expected fail (10)`，exit 0，见 `dist/r124-chaos/protocol/default-final.log`。8 个 `DEFECT` 标题通过 `defect` 别名注册为 Vitest `it.fails`，健康断言没有取反或删除。可用下列模式将完全相同的断言作为普通测试运行：

```powershell
$env:ZS_R124_HEALTHY_ASSERTIONS='1'
node node_modules/vitest/vitest.mjs run tests/integration/chaosProtocolR124.test.ts --maxWorkers=1
Remove-Item Env:/ZS_R124_HEALTHY_ASSERTIONS
```

该模式最终为 `8 failed | 2 passed`，Vitest exit 1；8 个失败均停在下列健康断言，没有 harness/cleanup 失败。原件为 `dist/r124-chaos/protocol/healthy-assertions-final.log`。每例可在测试命令后加 `-t P01` 至 `-t P10` 单独复放；缺陷模式设置上述环境变量后同样适用。正常 afterEach 强制核对每例 `result.json` 和 `cleanup.json`，hook 不受 `it.fails` 反转，缺证据或清理失败不能冒充预期缺陷。

每组执行前均完成 `initialize → initialized → thread/start`，续接时按表执行 `thread/resume`；下表列增量链。文件 `wire.jsonl` 记录所有实际双向协议帧及 PID、`commands.jsonl` 记录正式命令和结果，`scenario.json` 保存可复放脚本。

| 场景与单例命令参数 | 实际命令／事件链 | 健康断言 | 实际结果、隔离或污染 | 范围与限制 |
| --- | --- | --- | --- | --- |
| P01，`-t P01`：三 session、相同 turn/tool ID、完成先于启动和交叉身份 | A/B 不同 thread 都返回 `shared-provider-turn`；A 先工具 start，B 先同工具 ID completed 再 start；C 使用另一 turn；再发 A.thread+C.turn、B 顶层 turn 与嵌套 turn 矛盾，交错 A/B 工具完成，最后三个合法 terminal | 每流只含自己的 internal turn/stage；A 工具 target 为 TOOL_A，B 首个完成不借 A 摘要，后续完成 target 为 TOOL_B；无两种 POISON；每流恰好一个完成 | **守住。** 三个 tuple 分离；两个错误身份均被无正文诊断拒绝，工具摘要不跨 session | adapter 级、三个本地流；无正式 worker。比 R123 的普通复用增加 completion-before-start、第三个已知 turn 的交叉 tuple 与矛盾嵌套身份组合 |
| P02，`-t P02`：早到启动 ID 与响应 ID 矛盾，正式 worker | 两个正式 `message.submit → worker.runOnce×2`；目标先 `turn/started(early-claim)`，随后 `turn/start` 响应给 `different-response`；响应后继续发 early-claim 的 `POISON_EARLY_ALIAS` 普通消息，再用 different-response 发合法结构化终态；对照串正常完成 | `visiblePoison === false`；对照串不受污染；两库调用计数为 0 | **污染复现。** 两任务均 DONE/SUCCEEDED；目标最终 agent 消息实际为 `POISON_EARLY_ALIAS\n\nSAFE_TOKEN_P02`，异常别名正文被保留并补入正常最终结果；对照串无 POISON | 证明同一内部 turn 接受两个互相矛盾的 provider 身份并污染正式可见正文；没有声称已将另一个真实用户串的内容窃取过来。输入是畸形提供方协议 |
| P03，`-t P03`：共享进程只完成半数时退出，正式 worker | 两个根消息、同角色两串同时启动；只给 DONE 串合法最终 JSON；等待其正式 DONE 且有回复，再让唯一共享进程 `exit(23)`；独立读取两条 adapter 流确认都收到 process.exited；等待 worker 650ms | 完成者保持 DONE/正常正文；共享载体确认退出后 `awaitInFlightTurns(...).remaining` 应为空，未完成者应进入可解释的未知/失败收口而非继续活跃 | **卡住复现。** 完成者 DONE/SUCCEEDED、有一条正常回复；另一个仍 ACTIVE/RUNNING、无 agent 回复；outbox 仍 leased、准入仍占 1，remaining 有一个 turn。两流实际收到 exitCode 23，均被标记 expected:true | 保留生产默认“单轮截止关闭”，未擅自配置短超时。实测观察窗 650ms；源码循环没有 process.exited 收口分支且关闭截止时持续轮询，支持其不会自行因本退出事件收口的结论。清理时显式 abortConsumers 才收为 UNKNOWN；**清理后的 state.sqlite 不能替代 result.json 的清理前事实** |
| P04，`-t P04`：重复消息、终态后正文和矛盾终态，正式 worker | 根消息启动；重复 started、相同 item ID 的合法最终消息两次；成功 terminal；同 turn 再发 delta+completed(POISON_AFTER_TERMINAL)、failed terminal，最后重发成功 terminal；退出进程后收齐原始流 | 正式 messages 恰好一个 agent 回复，仅含 SAFE_TOKEN_P04，不含 POISON；任务仍 DONE；另记录 adapter 实际事件数量 | **worker 守住，adapter 未封口。** 正式可见回复恰好 1 条，后到毒文/失败未覆盖成功；adapter 原流仍有 2 个 turn.completed、1 个 turn.failed 和终态后 delta/message | 不能称 adapter 拒绝了重放，也不能把后续消费者风险宣称为本例已发生的 worker 污染。该组不含持久化故障，未验证 late-event/replay API 对该积压的后续处理。与 DeepSeek 设计第 2 项独立交叉发现 |
| P05，`-t P05`：审批 v2/legacy 身份矛盾 | A/B turn 已映射；server request id7501 同时给 threadId=A、turnId=A、conversationId=B、嵌套 turn=B；调用 A.respondApproval allow_once，读取实际子进程收到的回复 | 矛盾请求不应得到 accept，即 accepted.length 应为 0 | **审批边界失守。** 审批被投给 A，A 答复 fulfilled；子进程确实收到 id7501 的 accept，B 身份字段被忽略 | adapter 公共审批 API，未调用真实工具或正式 UI 审批；同时存在 v2/legacy 字段是畸形输入。本例证明解析器优先取值，未证明正常 provider 必定产生这种输入。与 DeepSeek 第 6 项独立交叉发现 |
| P06，`-t P06`：跨 session 重用未完成审批 RPC ID | A/B 均有已映射 turn；先后发送两份 id7601 的审批，各自带合法不同 tuple；A 先 deny，B 再 allow_once；读取 wire 回复 | 重复未结编号必须拒绝或保留原绑定，不能使替代者产生 accept，即 accepted.length 应为 0 | **绑定覆盖复现。** 两流都收到同名 appr_7601；原 A 答复报 THREAD_SCOPE_MISMATCH，B 答复 fulfilled；子进程收到唯一 id7601 accept | adapter 级畸形 RPC，不等于两个真实命令都获执行。证明原有待答绑定被替换。与 DeepSeek 第 7 项独立交叉发现 |
| P07，`-t P07`：明确启动错误后正常重试 | 同 session 首次 turn/start 直接 JSON-RPC error(-32000)，无 started/turn；随后对同 thread 发送脚本正常的 retry | 首次 CAPABILITY_UNSUPPORTED 拒绝为对照；retry 应到达协议且 fulfilled | **卡住复现。** retry 在 adapter 内被“上一启动尚未绑定 turn”拒绝，wire 只有第一次 turn/start，后续正常脚本未被触达 | adapter 同会话重试；不声称错误本身证明所有真实 provider 都未执行。即便保守拒绝重试，当前没有状态清理/显式恢复语义；与 P08 同归 awaiting 生命周期问题，不重复计独立根因 |
| P08，`-t P08`：未绑定启动跨进程死亡阻塞新代次 | 旧 session 发送 turn/start 不响应、不发 started，进程 exit17；新进程正常握手/创建同名 r124-thread-1；fresh start；然后显式 close(old session) 再次 fresh start | 旧代次状态不能使新代次首个 fresh start 被拒绝；显式移除旧 session 后的正常启动作恢复对照 | **跨代次卡住复现。** 首次 fresh 被旧 awaiting 拒绝；close(old) 后，同一 fresh session 立即正常 started/completed；两进程均实际退出 | 最终稳定版本为直接退出，**不包含迟到旧 stdout/延迟 close 实证**。已避免把失败的管道保活原型当作代次隔离证据。P08 与 P07 合并解释为旧启动占位未清理，另有 startTurn 检查未限定 generation 的路径 |
| P09，`-t P09`：旧审批答复自动拉起未握手新进程 | 旧 turn 收到 id7901 审批，保留不答；进程 exit29、旧流确认 process.exited；调用旧 session 的 respondApproval allow_once；观察第二进程的首个入站帧 | 死代次审批应失效，答复不能启动新载体，children.length 应仍为 1 | **跨代次控制污染复现。** staleReply fulfilled，启动第 2 个实际子进程，其首条输入就是 id7901/result.decision=accept；此前无 initialize/initialized | 证明新进程确实收到旧 RPC 答复，未声称真实 server 接受或真实工具获授权。依 DeepSeek 第 4 项设计实现，主代理转交设计时本测试尚未落地 |
| P10，`-t P10`：旧 session 关闭后迟到 started 抢占 resume awaiting | A 的 closed-old-turn 正常完成；另一个 thread 的 keepalive 保持同进程；close(A)；B 通过 thread/resume 续接 A.thread；B start 响应前，子进程先发旧 closed-old-turn 的 started/message/terminal，再返回 real-new-turn 并发真实 B started/message/terminal | 新 B 流无 POISON_CLOSED_OLD_SESSION；keepalive 无污染；只使用一个实际进程作同代次对照 | **跨 session 污染复现。** 旧正文和旧 terminal 被归为 internal-resumed，随后真实 B 又完成；B 流有两个完成，keepalive 干净，launches=1 | adapter 公共 close/resume/start 流；未把该例冒称正式 worker 可见落库，正式消息链的已证污染见 P02。属于同代次退休身份丢失，与 R123 的旧进程代次过滤不是一回事。依 DeepSeek 第 5 项设计实现 |

源码对应关系：

- P02：`src/adapter/codex/appServerAdapter.ts:467` 的早通知映射与 `:641` 的启动响应 onResult 各自登记；后者无早通知 ID 一致性检查。`src/daemon/dispatchWorker.ts:2306` 接受已映射的普通消息，最终结果补正文时保留毒文。
- P03：`src/adapter/codex/appServerAdapter.ts:185` 广播 process.exited；`src/daemon/dispatchWorker.ts:2103` 允许该无 turn 事件进入 applyEvent，但后者没有相应收口分支。消费循环 `:1997` 在默认无截止时等待下一事件。共享退出应如实走 UNKNOWN/保护，不能假定单 turn 确认成功或强行释放写保护。
- P04：adapter `:416` 等分支始终 push，无 terminal/tombstone 记录；worker `:2124` 之后在第一终态后退出，重复消息另由 message ID/正文合并控制，因此本组数据库边界守住。
- P05/P06：adapter `:281` 只取 threadId 或 conversationId 的优先字段，审批 Map 以 appr_RPC编号覆盖 set；没有矛盾检查和未结编号冲突检查。
- P07/P08：adapter `:618` 的 startTurn 启动占位检查仅判 awaiting.providerTurnId===null；请求拒绝/进程死亡后旧 session awaiting 未清理，此处扫描 session 又没有 generation 限制。
- P09：adapter `:185` 的 close 清 pending，却不撤销 serverRequests；`:681` respondApproval 只检查 session ID，随后 respondToServer/writeLine/ensureProcess 可拉起新进程，无审批代次绑定。
- P10：adapter `:695` close 删除 session 与旧映射；`:482` sessionByThread 在 allowAwaiting 下允许唯一新 awaiting 认领任意完整 turn/started，无法识别已经退休的旧 turn。

建议主代理将 P02/P10 作为身份生命周期的一组相关修复候选，P07/P08 作为启动失败/代次占位清理的一组相关候选；审批矛盾、RPC 编号覆盖与代次隔离分别记录实际触发条件。这里保留 8 个反例，不直接相加成“8 个独立漏洞”。未知终态状态由主代理单独验证，本文件没有重测；没有重复存储失败蔓延、目录移走或另外扩展未证假设。

证据目录为 `dist/r124-chaos/protocol/`。最终接受的具体目录由下面清单冻结，`*-latest.json` 是方便重跑后定位的指针；若重跑发生覆盖，以本表及 `evidence-index.json` 为本次交付证据：

| 场景 | 最终运行目录 |
| --- | --- |
| P01 | `P01-tuple-tools-73vqcf` |
| P02 | `P02-start-alias-worker-7JH27g` |
| P03 | `P03-half-complete-crash-kVjeKl` |
| P04 | `P04-duplicate-terminal-worker-sLtjZb` |
| P05 | `P05-conflicting-approval-lHjm28` |
| P06 | `P06-duplicate-approval-id-bgpuzV` |
| P07 | `P07-failed-start-retry-BQr87G` |
| P08 | `P08-old-unbound-generation-tUnoTB` |
| P09 | `P09-old-approval-generation-4xGRo5` |
| P10 | `P10-closed-resume-late-start-zSVfJA` |

每目录均有 scenario/wire/launches/result/cleanup。正式 worker 的三目录另有命令原文、`result.json.databaseBeforeCleanup`、`after-cleanup.json` 和最终 `state.sqlite`。P03 的当前 SQLite 是测试显式 abort 后的库，因此诊断 ACTIVE/RUNNING 必须看清理前快照；原件保留，无断言篡改。`audit-evidence.mjs` 只核对本代理上述 10 个 latest 结果，生成含 SHA256 的 `evidence-index.json`；可运行 `node dist/r124-chaos/protocol/audit-evidence.mjs` 复核。

0 真实调用证据：最终 10 例共 12 个本地合成 server 子进程，入口全部锁定为 Node + `tests/fixtures/chaosProtocolR124.mjs`；spawnFn 对实际 command/入口/configPath 作硬断言，每次启动的 `launches.json` 记录完整命令和 PID。子进程仅继承 SystemRoot/WINDIR、定向测试 TEMP/TMP、ZS_R124_LOCAL_ONLY，没有认证、API 或代理环境变量；fixture 仅导入 fs/readline，不含网络客户端、真实模型 SDK 或外部执行工具。三个正式测试库查询均为 `SELECT count(*) FROM real_calls = 0`。没有执行远端命令或授权任何真实工具；未做操作系统网络抓包，0 调用结论来自可审计的受限执行路径、完整 wire 与 SQL 台账，不能仅靠 mock 身份台账自证。最新 12 个子进程均已收到实际 close；最后只读进程查询未发现本 fixture 残留。

验证命令均已执行通过：

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/eslint/bin/eslint.js tests/integration/chaosProtocolR124.test.ts tests/fixtures/chaosProtocolR124.mjs
git diff --exit-code -- src tests/helpers tests/fixtures/codexEventAttributionR123.mjs tests/fixtures/collisionAppServerR122.mjs
git rev-parse HEAD
```

最后一条仍为基线 `70e7969...`；前一条无生产/helper/已有 fixture 差异。其他代理的未跟踪文件未修改。用户新指示后未再扩展场景，也未另跑 R122/R123 旧测试。

保留的早期 harness 诊断：首次快照错用了不存在的 outbox.attempts，随后修为真实 attempt_epoch；跨代次控制文件最初重放了旧控制行，随后按新进程启动时的已存在行数定位；P08 管道保活原型未可靠维持 holder/延迟 close，最终收缩成直接 exit17 的最小复现，旧原型目录和 `healthy-assertions-run1.log` 保留但不作为验收。正式计数只使用 `default-final.log`、`healthy-assertions-final.log` 和上述 10 个完整清理目录。无论默认还是健康断言模式，最终都未再出现这些 harness 失败。
