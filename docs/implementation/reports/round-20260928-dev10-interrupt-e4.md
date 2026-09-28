# DEV-10 受控中断认证 + 能力声明修正 + E4 调度解耦实装（2026-09-28 第三轮）

预算口径：本轮补批**最多 1 个真实 turn（受控中断）**——已执行并通过（消耗 1/1，CLI 侧无
usage 回报，实际消耗以渠道账单为准）；**未增加探活、未换模型、未因失败重跑**。M1 价值
对比 33 调用仍**未批准、未动用**。全套 370/370、UI e2e fake 13/13、typecheck/lint 0。

---

## 0. 零额度诊断出网防护（纪律落款）

上一轮"关闭端口"诊断意外出网的事故结论已固化：**Claude Code 的 settings.json env 优先于
子进程环境变量**（该结论仅限本次实测组合：CLI 2.1.283 + 本机 settings 结构，不概括为所有
版本规则）；子进程 env 覆盖（BASE_URL/token）不能作为出网隔离手段。本轮零额度验证全部使
用本地模拟进程/协议回放（fake adapter、真实 node 子进程 fixture、二进制字符串取证、DB 取
证），不再做任何"指向关闭端口"类测试；也不通过"发一次看收费"验证隔离。凭据未读取、未输
出；用户全局配置未修改（只读档配方全部经 CLI 参数注入子进程）。

## 1. 能力声明与实际开放状态修正（逐项按证据）

| 能力 | 修正后 | 依据（单一真源=cliAdapter CAPABILITIES，probe/命令登记共用） |
|---|---|---|
| structuredEvents | supported（不变） | 真实 turn1 stream-json 全链 |
| structuredFinal | supported（不变） | 真实 turn1 TaskComplete 校验+交付 |
| usageTokens | supported（不变） | 真实 turn1 usage 落库 |
| usageCost | supported（不变，estimated） | CLI total_cost_usd 估算字段真实存在；**估算≠渠道账单**（报告与 costQuality 一致区分） |
| **interrupt** | unverified → **supported** | **本轮真实受控中断认证通过**（§4）；另有本地真实进程 fixture 6 用例。范围=CLI 2.1.283+当前渠道+Windows kill 语义 |
| **resumeSession** | supported → **unverified** | --resume 仅回放验证，真实续接未认证 |
| **restrictWrites/restrictShell/disableDelegation** | supported → **unverified** | 参数存在≠已认证；--allowedTools 只是预授权免审批清单非总白名单（§2）；新配方已实现但真实侧仅一次只读成功+一次中断，不整体升级 |
| **taskContextIsolation** | supported → **unverified** | 回放验证两任务隔离；真实侧仅单任务（cwd 正确） |
| interactiveApprovals | unverified（不变） | headless 只读档未开审批通道 |
| steerActiveTurn | unsupported（不变） | 设计性拒绝，不模拟 |

同步面：probe（读同一 CAPABILITIES）；`member.setRuntime` 的 capabilities_json 改用
`claudeCapabilities()` 单一真源（toolCapabilities 三态 / modelAvailability /
permissionAuth 分开记录，配置成功≠已认证）；契约核对文档矩阵已更新（§6 续工点处）。UI 无
runtime 能力展示面（renderer grep 证实），无需改。permissionMode 枚举修正为 2.1.283 实际
值（`plan/manual/acceptEdits/auto/dontAsk/bypassPermissions`——原 'default' 不存在）。

## 2. 工具限制核对及实际工具证据

- **--allowedTools 真实语义（取证）**：它是"预授权免审批"清单，**不是禁用其余工具的总白
  名单**——上一轮诊断的 init 事件 `tools` 列表仍含 Task/Bash/CronCreate 等执行类工具。仅凭
  该参数不能宣称禁止 shell/写入/委派（用户判断正确）。
- **正式机制组合（新只读档配方，全部经 CLI 参数，不动全局配置）**：
  `--permission-mode plan` + `--permission-prompts none`（headless 下任何需审批动作自动拒
  绝）+ `--allowedTools Read,Glob,Grep`（只读三件套预授权）+ `--disallowedTools
  Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,Skill,TodoWrite,mcp__*`
  （明确拒绝执行/写入/网络/委派/技能类）+ `--strict-mcp-config`（不加载任何附加 MCP）+
  `--bare`（跳过 hooks/插件/LSP/auto-memory 等用户 settings 附加能力——上一轮已观察到
  SessionStart hooks 实际运行）+ `--disable-slash-commands`（禁用技能）。
  `--restricted` 能移除执行类内置工具但会忽略 user settings（渠道凭据在其中）——不可用。
- **实际工具证据（turn1 复盘）**：turn1 数据库**无任何 tool.* 事件**——当时实现不落库工
  具事件，"模型自述 ls/sha256sum"无对应记录可核对 → 按用户口径记为**模型自述、未采信**
  （暗号回流证明 Read 发生过，但程序侧无记录）。**本轮已补**：worker applyEvent 增加
  tool.started/tool.completed 审计（toolCallId/toolName/outcome/eventKey 入
  domain_events）——后续每个真实 turn 的工具调用有程序侧实录，模型自述可逐条核对。本轮真
  实中断 turn 的 toolEvents=0（早停前无工具调用，如实）。
- **费用口径**：cost 全部标 `estimated`（CLI 按价目表估算）；真实渠道账单对账不在 adapter
  范围，报告不把估算写成已核实扣费。

## 3. 中断/关闭/收拢的实际实现与本地验证（零额度）

实现（adapter-0.3）：
- **停止请求与退出确认分离**：`interrupt()` 只置 stopRequested+kill（不等退出）；
  `waitForTurnExit(session, turnId, timeoutMs)` 等 close 回执——超时=无法确认退出，如实
  返回 `exitConfirmed:false`（不假装已停止）；
- **INTERRUPTED 语义**：停止请求后无 result 的进程退出 → `turn.failed code=INTERRUPTED
  retryable=false`（worker 映射 turn/task/run CANCELLED）——区别于故障 PROVIDER_ERROR；
- **停止请求后的迟到 result 不产生成功交付**：stopRequested 后到达的 result 被忽略（留
  stderrTail 取证 `[late-result-after-stop ignored]`），由 close 兜底发 INTERRUPTED——
  本地反例证实迟到 turn.completed 不出现；
- **close/disposeAll 有界等待退出**（close 3s 宽限、汇总逐会话 TurnExitState）；
  **MemberRuntimeRegistry.disposeAll 返回汇总**（entries/failed/unconfirmed，继续清理其余
  但上报不吞）；entry stop 顺序=停 tick→停 IPC→drain 收敛→**disposeAll（杀进程）→
  awaitInFlightTurns（消费器写库收敛）→关库→释放锁**——不在回调写库时关库；
- 失败审计补 message（含 stderr 尾 300 字符，上轮取证丢失问题的收口）。

本地验证（claudeCliReplay 19 用例中新增 6 个，**真实 node 子进程 fixture** + 不响应 fake
反例）：运行中停止（kill→close 回执=INTERRUPTED+退出确认）；启动中停止+重复停止+close
幂等（单终态不抛）；**退出无响应**（kill 后 close 不达：宽限耗尽 exitConfirmed=false 不确
定，不假装）；**跨成员误停防护**（停 A 不影响 B 完成真实进程）；迟到输出不交付；disposeAll
汇总（活动进程退出确认入汇总）。

## 4. 唯一一次真实中断：结果与实际消耗 ✅

- **执行**：`node scripts/dev10-real-auth.ts turn2`——正式 daemon（detached 调度）+ 成员
  绑定 claude/deepseek-flash + 专用 fixture（只读分析任务）+ 显式 `--model deepseek-flash`
  （不回退、不改全局配置）。
- **停止时机**：等到**双重真实运行证据**（agent_turn RUNNING + 新 claude.exe 进程
  pid=26792 实际出现）后立即停止——不等大段输出。停止请求→task.stop 确认 **2ms**。
- **通过标准逐项（checks 全 true）**：正确目标被中断（turn/task/run 全 CANCELLED，audit
  code=INTERRUPTED 含 stderr 尾取证）；其他成员不受影响（单成员任务，跨成员防护在本地
  fixture 验证）；停止后无成功交付（deliveries=0）无运行复活（迟到事件仅中断审计本身，
  无 SUCCEEDED）；进程收尾有证据（pid 26792 退出、**无孤儿 claude 进程**、stopAudit 记录
  进程退出）；事件消费收敛（awaitInFlightTurns 空）；**重启不复活**（重启 daemon+恢复后：
  任务仍 CANCELLED、turns=1、无新 run、无交付）。
- **实际消耗（如实）**：CLI 侧 usage=0（早停无 result 回报）；请求已发出（进程运行数秒），
  **实际消耗以渠道账单为准**；响应自报模型=null（中断早停无 assistant 消息到达——不以请
  求模型冒充响应模型）。证据：`docs/implementation/evidence/dev10-real-auth/evidence-turn2.json`。
- harness 顺带修复：turn2 收尾段二次 close 的 void-catch 崩溃（不影响本次证据完整性）。

## 5. E4 调度解耦：实际代码与集成证据（不止设计稿）

**实现边界**：泵与单个 turn 的事件消费解耦；不靠重入 drain 形成无约束并发；在途成员到
absenceGrace 时屏障可推进、不强杀成员、后续成果走冻结版本+迟到规则；审批暂停/单轮截止/
排队截止/用户停止语义不变；并发与预算仍经统一准入（outbox 租约+fencing）；同物理目录默认
单写者不变（并行写入增强未恢复）。

代码（dispatchWorker + outbox + entry + deliberationRunner）：
- `detachedTurnConsumption` 模式（entry 默认开，ZS_DETACHED_TURNS=0 显式关）：turn 事件消
  费器独立后台跑（consumeTurn 登记 inFlightTurns），**drain 不被在途 turn 阻塞**——阶段泵
  每 tick 都能跑（E4 生产承载）；inline 语义默认保留给直接构造 worker 的既有路径；
- **成员级在途互斥**：同成员有未终态 turn → 新项 `releaseOutbox` 放回 pending + 记
  blockedOutbox（claimNextOutbox 新增 skipIds 跳过）——同成员串行与 inline 等价、其他成员
  不饿死；
- **租约续期**：detached 消费器每 leaseMs/2 续租（长 turn 不丢租约，attemptEpoch fencing
  完结）；
- **stop 收敛**：`awaitInFlightTurns(timeoutMs)` 有界等待（超时返回剩余 turnId，如实不确定）；
  entry stop 顺序如 §3。

集成证据（零额度、假时钟，tests/integration/deliberationE4Detached.test.ts 4 用例）：
- **泵在途推进（真实 runOnce 路径，非测试直调泵）**：队首 m1 stall 在途时 m2/m3 IND 照常
  派发（runOnce 毫秒级返回，inline 会阻塞整轮 drain）→ 假时钟到宽限 → 泵标 m1 absent、
  入队互评（冻结清单不含 m1）、CR 完成 → **m1 turn 仍 RUNNING 未被强杀** → m1 迟到完成
  =late（真实事件路径）→ 全部消费器收敛；
- 同成员互斥：mA 在途时 mA 新任务放回 pending（不建 turn）、mB 任务照常 DONE；mA 终态后
  解除并派发完成；awaitInFlightTurns 收敛空。

**过程中修复两处被 detached 时序暴露的真实缺陷**（inline 下从未触发）：
1. `lateRecorded` 误判：运行终态后的合法迟到记录（材料已发布+审计）被 worker 当格式无效
   处理（空 issues+入格式修复+repairExhausted）——现按迟到语义收 SUCCEEDED（不复活、恢
   复不重跑）+ `turn.lateRecorded` 审计；
2. SYN 在途预算误判：detached 高频泵把"SYN 已派发在途"的预算占用算成"预算不足以整合"
   （synthesisUnavailable→run FAILED）——泵补在途守卫（SYN 键在 outbox 未 done 或 turn
   非终态→等待不判失败）。修复后 detached 全链 DONE、预算 20/20 与 inline 完全一致
  （ZS_FAKE_DELIB 诊断对照），UI e2e 研讨全链/建房跨房间两用例恢复 13/13。

## 6. 剩余未认证项与准确续工点

| 项 | 状态 | 续工点 |
|---|---|---|
| resumeSession（--resume 真实续接） | unverified（回放已验） | 下一次真实 turn 预算内可顺带：同会话第二 turn 观察上下文延续 |
| restrictWrites/restrictShell/disableDelegation | unverified（新配方已实现） | 需要一次"尝试写/shell 被拒"的真实对照（属 B6 权限档扩展，另行报预算） |
| taskContextIsolation | unverified（回放已验两任务隔离） | 两个成员两个真实任务并行的隔离对照（需预算） |
| interactiveApprovals | unverified | headless 审批通道未开；B6 时一并 |
| M1 价值对比 33 调用 | **未批准、未动用** | 等用户批准（fixture+hash 先固化） |
| 零额度诊断纪律 | 已固化（§0） | 任何"真实 CLI 离线行为"测试需先建立可验证的出网隔离条件（如独立 HOME/沙箱），不以 env 覆盖代替 |

已通过且未受本轮修改影响的成果未重跑（turn1 证据、真实研讨一组、审计 v3 等保留）。
