# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

## 当前真实状态（2026-09-28 第三轮，唯一权威快照）

- **DEV-10 受控中断真实认证通过（本轮预算 1/1 已用）**：真实 claude 进程证据（pid 26792）
  后 2ms 停止→turn/task/run 全 CANCELLED（INTERRUPTED 语义+stderr 尾取证）、无交付、无孤
  儿进程、迟到不复活、重启不复活；usage=0 如实（早停无 result，实际消耗以渠道账单为准）。
  **interrupt 按证据升 supported**（范围=CLI 2.1.283+渠道+Windows kill）。
- **能力声明已逐项按证据修正**（cliAdapter CAPABILITIES 单一真源）：resumeSession/
  restrictWrites/restrictShell/disableDelegation/taskContextIsolation=unverified（参数存在
  ≠认证）；--allowedTools=预授权非总白名单（init.tools 仍含 Bash，取证）；只读档新配方
  （permission-prompts none + disallowedTools + strict-mcp-config + bare +
  disable-slash-commands）；worker 落库 tool.started/completed 审计（模型自述核对依据；
  turn1 的 ls/sha256sum 自述=无记录未采信）。
- **中断/收拢实装**：停止请求与退出确认分离（waitForTurnExit 宽限、不确认不假装）；
  INTERRUPTED 语义；停止后迟到 result 忽略不交付；disposeAll 汇总上报（failed/unconfirmed
  不吞）；entry stop=dispose→awaitInFlightTurns→关库。本地真实进程 fixture 6 用例。
- **E4 调度解耦实装（生产承载完成）**：detachedTurnConsumption（entry 默认开，
  ZS_DETACHED_TURNS=0 关）——泵与 turn 消费解耦、成员级互斥（skipIds+releaseOutbox）、租
  约续期、awaitInFlightTurns；假时钟集成 4 用例（含泵在途推进/不强杀/迟到 late/同成员互
  斥）。**顺带修复 detached 暴露的两真实缺陷**：lateRecorded 被误判格式无效；SYN 在途预
  算误判 synthesisUnavailable。detached 全链预算 20/20 与 inline 一致。
- **零额度纪律固化**：settings env 优先于子进程 env（限本次版本组合）——env 覆盖不是出网
  隔离；零额度测试只用本地模拟/回放/二进制取证。
- 数字：全套 **370/370**、UI e2e fake 13/13、lint 0。报告：
  reports/round-20260928-dev10-interrupt-e4.md。
- 未认证续工点：resumeSession 真实续接、restrict* 真实拒写对照（B6）、双任务真实隔离、
  interactiveApprovals；**M1 价值对比 33 未批准未动用**。

## 当前下一步（唯一）

1. **等待用户输入**：① 价值对比 33 上限批准与否；② 可选新预算：resumeSession 真实续接
   （1 turn）、restrict* 拒写对照（B6 前置）。
2. 无需等待直接开工：harness stop 改进（UI task.stop 优先）；tool 事件审计的 UI 呈现
   （线程内工具调用记录）；ZS_DETACHED_TURNS=1 下真实研讨一组的复跑准备（价值闸门过前
   不跑）。

---

## （上一轮快照，2026-09-28 深夜·二）

- deepseek-flash 真实认证：意外探活 1 次（settings env 优先级事故）+ turn1 全链成功
  （暗号回流/resultKey/usage 20,875+53,760cache+11,822/$0.4268 est/55.6s）；成员级
  runtime 生产接线完成（member.setRuntime→registry→worker adapterFor）。受控中断当时未
  执行——**本轮已补并全部通过**（见上）。

---

## 刚完成（修复轮 6 + G3 收口）

- **证据口径修正**：ZS_UI_DEMO=宿主内命令链路（main 直连 pipe），不再称等价人工点击；发现并修复正式 renderer app.js 从未成功执行的问题（顶层 const 与 contextBridge 非配置全局冲突 → IIFE 包裹）。
- **R1-R5 renderer 全量接通**（src/ui/renderer/app.js 重写）：停止按钮（点击时快照绑定，切线程不误停）；恢复入口（recovery.status 只读 + 显式 dispatch.resume{confirm:true}）；主池 room.pool + 线程 thread 目标（不新建根任务）；双视图草稿独立/在途去重（同 commandId 重试横幅）/IME/仅记录一次性复位/M0 模式诚实实现（仅 DIRECT，恰一名 agent 时预填 mention）；重载/重启按上次项目恢复（localStorage + userData 隔离）。
- **B1/B2**：管道 commandId 关联+迟到响应丢弃反例（2/2）；daemon 生命周期 drain 收敛/重复 stop/关库后零写入（3/3）。
- **UI e2e（CDP 真点击）**：tests/e2e/uiE2e.test.ts fake 11/11（发送→DONE→线程回复/跟进/草稿/仅记录/双击双 Enter 去重/IME/重载恢复/UI 停止→CANCELLED/SIGKILL 崩溃→重启→门禁→确认→中断任务不重跑+新调度恢复）；**真实 codex 1 turn（UIE2E-CODEX-6666，24.7s）**。
- **隔离**：同成员两任务先排队再派发用例（串行完成/各一 run/顺序正确/会话不因同成员合并）。
- **架构**：IPC 协议共享层下沉 src/contracts/daemonIpc.ts（ui→daemon 边界违规清零）；task.get 补 stopGeneration；recovery.status/room.pool/thread 目标服务端合同；ZS_PIPE_NAME/ZS_FAKE_STALL_MS/daemon.pid/pnpm build:ui 配套。ADR-I41/I42。
- **数字**：pnpm check 全绿 276/276；lint 0（此前 24）。详见 reports/round-20260927-fix6-ui-e2e-g3-closeout.md（五段）。

## 当前故障 / 待停止进程

- 无遗留进程（本轮 electron/daemon 均清理）。

## M1 第一批（已提交，本轮内完成）

- **contracts/deliberation.ts**：§6.4 报告/互评/立场/检查点/整合/确认 payload schema（schemaVersion 字面量，模型自报身份字段一律程序赋值）；E12 预算推导（6N+1+C / 7N+2+C）与尾部账目（M/U/I、S=1/Q=N、R/T/F、stageAvailableTurns、occupyTail/settle 纯函数）。
- **domain/deliberation/stageMachine.ts**：INDEPENDENT/CROSS_REVIEW 屏障（E4 缺席不默认完成、全员无输入 BLOCKED）；争议派生（同 claim 合并、无争议跳过讨论）；第 3 轮检查点资格（host 专属）；共识聚合（unanimous/qualified/disputed/unconfirmed，缺席不覆盖反对）。
- **persistence/stores/deliberation.ts**：artifacts 落 appData 管理目录+hash；synthesis_claims 冻结；RATIFY 矩阵初始化/提交事务（claim 全覆盖且无重复、非预期成员/阶段不符整份拒绝、同 resultKey 重放、已确认不可自然语言覆盖、关屏障 pending→missing 不伪造 turn_id）；issues/positions。
- **DEV-21-M1 模板**：DELIBERATE 六阶段指令（(mode,role,stage,turnPurpose) 选择表扩展，checkpoint host 专属）+ 精确 JSON 输出契约（ADR-I39 口径）。
- 测试 +19：预算 4 / 阶段机 10 / 持久化 5（含 prompts 表更新）。默认 295/295。

## M1 第一轮（已提交）

- **四缺陷收口**（迁移 004 payload_hash / 005 stage_started_at）：屏障冻结参与集合、互评三元组+run 范围 issueId、RATIFY 同键同规范化载荷幂等/异载荷冲突+全前置核对+行数校验、成果发布协议（不可变版本/失败恢复/完整性校验）。零额度反例齐备。
- **DELIBERATE 编排**（deliberationRunner+worker 集成）：PREPARE→IND→CR→（争议）ISS 轮次+第3轮 checkpoint→SYN→RAT→PUBLISH 全链；确定性 dispatch_key；服务端输入隔离+ContextBundle hash；E12 预算单一账（占用/结算/退款/尾部保证/耗尽兜底）；E4 假时钟缺席；停止作用于运行；一次格式修复。集成 9 用例。
- **研讨 UI**：run.progress/report.get 命令、@全体芯片、进度条（成员状态可见）、逐结论共识报告；门禁按证据开放（entry 默认；worker 级默认关，m0Fixes 语义不变）。UI e2e fake 12/12。
- 数字：默认 323/323、lint 0。

## M1 收口轮（2026-09-28，已提交）

- **取证**：三次历史真实尝试 WAL 字符串取证定论（1/2=截止中断误判用户停止缺陷已修；3=CODEX_ERROR 正文未存档）；e2e 失败保留证据目录已修。
- **调度/E4/迟到/身份**（331/331）：时钟注入；排队≠缺席、成员级缺席（截止中断/UNKNOWN 不杀 run）；迟到三分支（未冻结纳入/停止不复活/发布后只展示）；dispatchKey 带 runId（二次运行不复用旧键、旧 run 遗留零执行）；RATIFY 确定性收口；ContextBundle 全文+hash。
- **真实研讨一组完成**：预算 7/9 精确、无争议跳过讨论、unanimous、29/29 逐项审计（scripts/real-delib-audit.mjs）；提交-观察分离 harness（scripts/real-delib.mjs）。

## 下一步（直接开工，无需再确认）

1. **真实补证（按需小额）**：一组带真实分歧的任务（讨论轮+checkpoint 真实路径）、一组真实迟到/缺席观察；完成后把门禁默认开放。
2. **M1 价值闸门材料**（需预算批准后执行）：3—5 组同题同基线 DELIBERATE vs DIRECT——先列任务清单、评判标准（事实准确性/漏项/分歧处理/调用量/耗时）与总预算报给用户，再执行；不预设结论。
3. 价值闸门通过前不进 DEV-11 自动分工；不影响其他独立工程工作（跨房间建房命令等）。

已知小残留（不阻塞 M1，随相关包顺手收）：跨房间切换 UI 场景（正式命令面无建房命令，待房间管理命令落地后补）；UI 发送横栏传输失败路径的 UI 级注入测试（传输层已有单测+smoke）。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 已收口，不再重跑已过认证（steer/allow/resume/usage 等）。
- UI 相关验收：真点击链路用 CDP 方式（ADR-I41）；宿主内 ZS_UI_DEMO 证据只作后台链路口径。
