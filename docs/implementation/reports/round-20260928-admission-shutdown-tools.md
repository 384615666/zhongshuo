# 统一派发准入 + 退出状态机 + harness stop 闭环 + 线程工具审计（2026-09-28 第四轮）

零真实模型调用（本轮未批预算、未探活、未重跑任何已通过认证）；M1 价值对比 33 仍未批准未动用。
全套 **384/384**、lint 0。本报告即六节交付清单。

## 1. 统一派发准入（src/daemon/admission.ts + worker 接线）

四维并发账本（**与预算分开**：预算限调用总量、准入限同时运行数量，不混用）：
global（ZS_MAX_INFLIGHT_GLOBAL=4）/ project（=2）/ provider=runtime kind（=2）/ member（恒 1，
同成员串行）+ writeRoot 接入口（需要写入时的物理目录单写者——当前全只读档不占写槽，B6 写档
接入点就绪；**默认单写者不变，未恢复并行写入增强**）。占位覆盖 **openSession/startTurn 启动
窗口**（dispatchClaimed 解析维度即判定+占位，早于 openSession）；释放语义：完成/失败/取消/启动
失败回收（consumeTurn settle + 各 early-return + 启动异常 catch，inline/detached 双路径）；
**UNKNOWN 保留占用**（对账未定不提前放行——releaseAdmission 查终态跳过）；拒绝方 releaseOutbox
放回 pending+skipIds（其他成员/项目不饿死——skip 终态时保守清空重试）。阶段泵只入队，一切启动
必经 claim→准入（结构性保证）。

零额度反例（admissionShutdown.test.ts ①-⑦ 全过）：多成员上限内并行；全局满但成员空闲→排队
不超发；一项目占满他项目不饿死；**慢 openSession 窗口不超发**（占位先行验证）；启动失败
（startTurn 抛错注入）槽位回收后续可派发；**尾部预留不被前置并发抢用**（detached 研讨 IND 并发
期预算不变式 usedTurns+Σtail ≤ runMaxTurns 且 RATIFY 预留保留）；UNKNOWN 保留占用。
过程修复三处被暴露的真实缺陷：① DIRECT 把单轮截止中断误判用户停止→CANCELLED（现与 DELIB 口径
一致：无 stop_generation 推进的 INTERRUPTED=UNKNOWN，不伪造取消——m0Fixes 期望同步更新）；
② requestStopAll 阻塞等待 adapter.interrupt（hangInterrupt 死锁风险——改限时发送不挂起）；
③ settle 的 completeOutbox 在关库后抛无人接拒绝（防御捕获，恢复语义由 UNKNOWN 审计承载）。

## 2. 退出状态机（entry.stop 重写）

`stop(): Promise<DaemonStopResult>`（幂等缓存；`{complete, phase, stopRequestsSentTo,
disposeReport, inFlightRemaining, reason}`）：停 tick→**worker.stopAccepting()（drain 安全边界
拒新领取）**→IPC 关→drain 有界收敛→**requestStopAll（对在途发停止请求，请求≠确认）**→
disposeAll（杀+等退出确认，失败/未确认汇总不吞）→awaitInFlightTurns（消费器写库收敛）→
收敛确认后关库+释放锁；超时=**incomplete：不关库、不释放锁**（单实例锁≠子进程退出；
恢复依据=崩溃恢复语义 WAL+applyRecovery）——修正了原"只写日志仍关库"路径。

> **第五轮更正（2026-09-28，见 round-20260928-admission-exit-hardening.md）**：本节原表述
> 有两处超出证据：①「零后台写库确认」当时只检查了 inFlightTurns（消费器）——晚返回的
> openSession/startTurn 所在启动窗口不在其内，drain 超时也未计入最终判定；②强制路径原文
> 「杀进程→abortConsumers→……保证关库后零回调写库→关库+释放锁→{complete:false,
> phase:'forced-closed'}」——实际实现吞掉 disposeAll 结果、忽略 awaitInFlightTurns 返回值
> 即直接关库，「零回调写库」与「已杀进程」均未核对即声称。两处已在第五轮收口：关闭判定
> 覆盖 startingTurns+inFlightTurns+drain 挂起；force 路径核对收拢/消费器/启动窗口结果，
> 全收敛才关库（complete:true）否则 incomplete 不关库（崩溃语义现场保留）。

本地反例（可控 adapter/慢窗口/不可中断脚本，全过）：drain 打开 session 窗口退出不崩；多 detached
在途退出+**关闭期间到达完成事件正常落库**（关库后重开 DB 证明持久化）；adapter 退出未确认→
incomplete+不关库+**锁未释放（二次启动失败=崩溃现场保留）**；消费器迟迟不结束→incomplete→
force→UNKNOWN 收尾后关库（重开 DB 验证 UNKNOWN 持久化）；重复 stop 同一结果；关库后零业务写入
（prepare 抛=已关，tick/租约/派发全停）。

## 3. harness stop 操作闭环（scripts/real-delib.mjs doStop 重写）

默认经**正式 task.stop 命令**：先 task.get 现场取 targetRunId/stopGeneration（绑定明确目标与
停止代次，防双停竞态）→task.stop→**观察到可解释终态**（CANCELLED/FAILED/BLOCKED/DONE 落库，
60s 上限；超时=未确认，不假装已停止）；UI 不可达=如实记录 stop-request-unreachable（观察退出
不重复提交、不自动开新任务）；**taskkill 仅限 ZS_CRASH_INJECT=1 显式崩溃注入**，与正常停止的
证据/状态/恢复路径分开记录。dev10-real-auth.ts turn2 本就经正式 task.stop（上轮证据）。
语法级验证通过；下次真实使用时按新闭环取证（无额外消耗）。

## 4. 线程工具审计呈现（服务端+renderer）

> **第五轮更正（2026-09-28）**：本节原文两处口径已收紧——①「同 toolCallId 去重」在跨
> turn 场景会把不同 turn/成员的同名 toolCallId 错并成一张卡，第五轮改为
> **turnId+toolCallId 作用域键**（started 取首/completed 取末，结果与时间取自同一条选定
> 事件；身份不完整保留为未归属条目，不按时间戳合并）；②「无参数正文落库=无泄露面」改为
> 准确字段范围说明：**查询面返回 toolCallId/toolName/outcome/eventKey/成员与 turn 归属**
> ——工具参数正文不落库（worker 审计不含参数），错误等其他可显示字段按既有脱敏规则处理。
> CDP 级 UI 断言已随第五轮补齐（见 round-20260928-admission-exit-hardening.md §3）。

- 命令 `thread.toolCalls`（commands.ts）：**真源=worker 落库的 tool.started/tool.completed 审计
  （domain_events）**，不从模型 executedVerifications 自述生成；按线程→task 限定（切换任务/房间/
  项目不串记录）；同 toolCallId 迟到/重复事件去重（started 取首/completed 取末）；返回
  memberId（turn 归属）/turnId/toolName/outcome（success/failure/unknown/进行中）/时间/eventKey
  关联（审计 payload 仅 id/名称/结果键）。
- renderer（renderThread 尾部只读区块"工具调用记录"）：成员/工具名/结果/时间/toolCallId，
  title 携带 turn+eventKeys——**线程信息组织内追加，不新增抢占主界面的监控页**。
- 验证（零额度）：集成用例（fake tool 事件→worker 审计→命令查询）：单卡去重（重复 completed
  取末值如实）、成员归属、**跨线程隔离**（th6 零记录）——4/4。renderer 逻辑为纯追加只读区块
  （语法+服务端全链已验）；CDP 级 UI 断言随下次 UI e2e 批次纳入（不消耗真实调用）。

## 5. 认证范围精确保留（不扩大）

上轮真实中断证据仅支持：已观察的 Claude 进程/任务停止路径（CLI 2.1.283+当前渠道+deepseek-flash+
Windows kill）。不自动证明 resume、所有工具子进程树、所有权限档位、跨任务隔离已认证。早停时无
assistant/result——口径保持"请求 deepseek-flash / 响应未提供可核实模型信息"；**usage=0=未收到
用量报告，非渠道零扣费**（渠道账单为准）。已认证能力零重复探活；未认证项维持 unverified，
后续按必要性另列最小预算（见 §6）。

## 6. 续工点

- 待真实认证（各自最小预算，另行报批）：resumeSession 真实续接（1 turn）；restrictWrites/
  restrictShell/disableDelegation 拒写对照（B6 前置）；双任务真实隔离。
- DEV-12 已起步（本轮）：`src/domain/preimage.ts` 前像捕获（显式路径列表+sha256+不可读项如实
  记录）/diff（added/removed/modified）纯函数+临时 fixture 测试（不碰真实项目）——撤销执行
  （前像还原的原子替换/失败回滚）与 Git/非 Git 基线随 DEV-12 主体实施。
- M1 价值对比 33：待批准（只阻塞该批实验）；DEV-11 仍遵守价值闸门。
