# 第五轮（2026-09-28）：准入占位完整生命周期 + 退出状态机收口 + 工具审计去重/CDP + DEV-12 主体

零真实模型调用（本轮预算 0；M1 价值对比 33 仍未批准、未动用）。全部验证在本地受控
adapter / 协议回放 / 临时 fixture（含临时 Git 仓库）完成，未触碰用户真实项目。

## 1. 准入占位的完整生命周期（问题一）

**根因**：DIRECT（dispatchWorker.ts dispatchClaimed）与 DELIB（dispatchDeliberationStep）
的 `openSession` 调用都位于 try 块**之前**；`startTurn` 之后才有 catch。上一轮报告称
「openSession/startTurn 抛错均回收」，实际代码与测试只覆盖了 startTurn——openSession 抛错
时准入占位直接泄漏（成员/全局槽位被永久占用），且 detached 模式下 `live.set` 发生在
startTurn 前、catch 不清理 → live 记录遗留（停止名单误含死条目）。

**修复入口**：`src/daemon/dispatchWorker.ts`
- 准入成功后**整个启动过程**入统一 try/catch/finally：run/turn/session 记录写入 → 常驻提示词
  渲染 → openSession → 会话记录写入 → startTurn → 消费器登记，phase 变量标记当前阶段。
- `settleStartupFailure` / `settleDelibStartupFailure`（两分类，与用户指定一致）：
  - **① 确认没有启动执行、没有遗留活动进程**（记录写入/常驻提示词失败——runtime 从未被调用；
    会话记录失败且会话经有界关闭确认）：终态 FAILED、释放占位、outbox 完结、任务回
    ACTIVE/BLOCKED（DELIB：预算结算+成员 failed+泵推进）；
  - **② 请求可能已被 runtime 接收/进程状态不确定**（openSession 抛错——无法关闭从未拿到的
    会话；startTurn 抛错——请求可能已发出；会话关闭未确认）：**UNKNOWN 收尾（持久化不确定
    状态）+ 保留准入占位（不提前放行）+ outbox 留待租约超时重领 → existingTurn 对账
    （RT-03）**；live 清理（可能残留的进程由 stop 状态机的 adapter 级 dispose 收拢）。
- `closeSessionBounded`（2s 有界）：close 可能挂起——限时返回 closed/close-failed/close-timeout，
  结果入审计，不假装已关闭。
- detached 启动失败后的 live 遗留修复：catch 内未登记消费器即删 live。
- 落库修复（顺带）：standing-prompt 失败路径原实现不 settle turn（RUNNING 悬挂）——现统一
  走 FAILED 收尾。

**关键反例**（tests/integration/admissionShutdown.test.ts，断言覆盖占位/live/数据库/后续派发）：
- `⑤(启动失败-openSession)`：UNKNOWN+run INTERRUPTED+占位保留（global=1）+`requestStopAll()=[]
  （live 不泄漏）`+审计 classification=uncertain；**他成员照常派发完成**（byMember={mA:1}——
  仅失败成员槽保留）。
- `⑤(启动失败-startTurn)`：同上不确定语义（旧断言「槽位回收=0」按新纪律改为保留——请求
  可能已被 runtime 接收）。
- `⑤(部分资源)`：会话记录写入失败（预占 runtime_sessions 主键注入）+会话关闭确认 → FAILED+
  占位释放+outbox done（不进重试循环）。
- 正常完成槽位回收：既有 ①②③④ 用例继续全绿（完成后 admission.global=0）。

## 2. 退出状态机真正收口（问题二）

**根因**（用户指认的两个漏洞，均属实）：
- graceful：drain 等待超时后，最终 incomplete 判定只看 inFlightTurns（消费器）——**仍未结束
  的 drain、以及慢 openSession 所在的启动窗口（尚未登记 live/消费器）不在判定内**；
- force：`disposeAll().catch(()=>{})` 吞掉收拢结果、忽略 awaitInFlightTurns 返回值，仍直接
  db.close+release——上轮报告「已杀进程+零后台写库」未核对即声称（已在
  round-20260928-admission-shutdown-tools.md 顶部加更正注记）。

**修复入口**：`src/daemon/dispatchWorker.ts` + `src/daemon/entry.ts` + `src/daemon/stopFlow.ts`
1. **关闭条件覆盖「启动中的派发」**：新增 `startingTurns` 登记（准入占位后→消费器登记/启动
   收尾；晚返回的 openSession/startTurn 不在 live/inFlightTurns 里，不登记则 stop 对其不可见）；
   `awaitSettlement(timeoutMs)` 同时等待 startingTurns ∪ inFlightTurns（200ms 轮询粒度）。
2. **晚返回的启动必须检查关闭状态**：`shutdownStarted`（stopAccepting 设置）——openSession
   返回后复查 `stoppingOrTerminal || shutdownStarted`：不启动 turn、有界关闭会话（结果入
   审计 reason=daemon-shutdown-during-session-open）、CANCELLED+释放占位+outbox 完结。
3. **drain 挂起计入最终判定**：graceful 在 settlement 之后复查 `inFlightDrain != null` →
   drainPending=true → incomplete（reason「drain 未收敛」）。
4. **force 路径核对后关库**：第二遍有界 disposeAll（`boundedDisposeAll`，超时合成失败项——
   dispose 挂起不无限等待）→ abortConsumers → awaitSettlement → **全收敛才
   {complete:true, phase:'forced-closed'} 关库释放锁；仍有未确认对象（drain 挂起/消费器/
   启动窗口/收拢失败或未确认）→ {complete:false, phase:'incomplete'} 不关库不释放锁**（宿主
   若仍退出=崩溃语义，WAL/UNKNOWN 现场保留；不声称已确认杀完或已完成 UNKNOWN 落库）。
   重复 stop/force 并发共用缓存 Promise（stopPromise/forcePromise 双阶段）。
5. **不确定记录实际持久化**：`daemon:stop:last`（daemon_state，JSON：phase/reason/drainPending/
   inFlightRemaining/startingRemaining/dispose 失败与未确认清单+pid+时间）——graceful incomplete、
   forced-incomplete、closed、forced-closed 四态都落盘；`applyRecovery` 快照新增
   `stopRecord` 字段（重启可读；stderr 不算持久化）。
6. standalone 信号路径：重复 SIGINT/SIGTERM 共用同一 shutdown（幂等）；优雅 incomplete 自动
   进 force 但**不绕过核对**；退出码 0（complete）/3（incomplete=崩溃语义）。

**关键反例**（admissionShutdown.test.ts 退出组，7/7）：
- `openSession 超过 drainSettle(1200ms>300ms) 才返回`：graceful incomplete（**drainPending=true+
  startingRemaining=1**——旧版只查消费器会误判 complete）；未关库；晚返回后按关闭状态清理为
  CANCELLED（审计含 sessionClose 结果）；stop 记录重开连接可读（reason 含「drain 未收敛」）。
- `openSession 永不返回`：graceful incomplete → force 仍 startingRemaining=1 → **forced-incomplete：
  不关库**；`daemon:stop:last` phase=forced-incomplete 可读；`applyRecovery(db2)` 快照携带
  stopRecord 且挂起 turn 按恢复语义收 UNKNOWN（unknownTurns=1）。
- `dispose 挂起`：boundedDisposeAll 超时合成 failed 项（error 含「收拢超时」）→ incomplete，
  总耗时 <15s（不无限等待）。
- `消费器迟迟不结束 → force 核对通过后关库`：forced.complete=**true**（收拢+UNKNOWN 落库已核对
  ——重开 DB 验证 UNKNOWN 持久化+stop 记录 forced-closed）；旧断言 complete=false 已按新语义更正。
- 既有 4 例（在途退出+关闭期间完成事件/慢 openSession 安全收口/退出未确认不关库不释放锁/
  重复 stop 同一结果/关库后零业务写入）继续全绿。

## 3. 工具审计去重与 UI 完成（问题三）

**修复入口**：`src/daemon/commands.ts`（thread.toolCalls）+ `src/ui/renderer/app.js` +
`src/daemon/entry.ts`（ZS_FAKE_TOOL_EVENTS 首个-turn 工具事件编排钩子，仅 ZS_ALLOW_FAKE=1）+
`tests/e2e/uiE2e.test.ts`。

- **带作用域的合并键 `turnId+toolCallId`**：不同 turn/不同成员的同名 toolCallId 各自保留
  （反例：同线程两个 turn（initial+redispatch）同名 toolCallId → 2 张卡、turnId 互异、各自
  取末值 outcome——旧按 toolCallId 全局合并会错并成 1）。
- **统一重复事件规则**：started 取首（时间+工具名同一条事件）；completed 取末（**结果与完成
  时间取自同一条选定事件**）；eventKey 重复不重复计数（Set 语义）；身份不完整（缺 turnId 或
  toolCallId）→ 未归属条目（unattributed=true，按 seq 唯一保留），不按相同毫秒时间强行合并。
- **CDP 级 UI 断言**（新增 describe，独立 Electron+daemon 实例，零额度）：工具审计卡显示
  （3 张：去重后 unknown/进行中/failure 各自正确+工具名来自首条 started+头部计数）、
  **切线程不串记录**（对照线程零记录）、**刷新后仍完整**（reload+重开线程 3 卡不变）。
- **字段范围表述修正**：「零泄露面」→ 准确说明：查询面返回 toolCallId/toolName/outcome/
  eventKey/成员与 turn 归属；工具参数正文不落库（worker 审计不含参数）；错误等其他可显示
  字段按既有脱敏规则处理（commands.ts 注释+renderer 注释+上轮报告更正注记三处同步）。

## 4. DEV-12 主体（问题四）

**验收映射**（对照现行条款先行列出，实施前定边界）：
- **DEV-12**（§19 开发包表：修改与 diff——单写者、前后基线、审查版本、非破坏撤销）：
  本包交付 ①基础数据模型（三态）；②内容级前像（受管理内容+hash 核对+大小上限）；③基线捕获
  接线（Git HEAD+索引状态+工作区内容前像 / 非 Git 整目录扫描）；④变更归属与运行/任务身份
  （change_sets 行携带 taskId/runId+领域事件）；⑤非破坏撤销（§14.5 全语义）；⑥撤销意图/进度/
  失败持久化+确定性恢复；⑦正式命令 changeset.*（captureBaseline/finalize/undo/get）。
  **不在本包**：审查版本 UI（DEV-13/14）、worktree（§14.7 延期）、并行写入（延期）。
- **RT-08**（两房间同改一项目→第二个排队显示持有者）：派发侧完整用例需写档任务（B6）；
  本包提供租约层强制——undo 执行前检查 workspace_leases 重叠活跃/expired 租约（RT-07 语义：
  expired 同样阻塞），有则拒绝并列出持有者；同项目同时只允许一个进行中撤销
  （change_set_undos 活跃行互斥）。admission 的 writeRoot 槽位接入点已就绪（上轮）。
- **RT-24**（Git 客户端九项）：DEV-14 的 Git 页任务，不在本包；本包提供其基础（HEAD 记录、
  porcelain 索引状态、变更归属 changeSetId）。
- **§14.2**：Git 目录 ref+未提交工作区内容前像（含范围内未跟踪文件，不降级为仅 ref）；非 Git
  目录整目录快照（E15，扫描排除 .git、上限截断如实标记）；超大文件 contentUnavailable
  **提前呈现**（内容级撤销不可用不事后失败）。
- **§14.5**：仅当当前仍匹配 after 才按 before 撤销；后续修改→conflict 不覆盖（人工处理）；
  新增/修改/删除分别处理（撤销新增也先确认仍是本次产物）；unknown 不自动撤销；不使用任何
  reset --hard/强制 checkout/删除项目操作（纯文件级内容恢复，Git 历史零触碰）。

**实现**（src/daemon/preimage.ts + src/daemon/changeset.ts + 迁移 007 + commands.ts 四命令；
两模块归 daemon 层——domain 只许依赖 contracts，边界纪律由 eslint 六边界规则强制）：
- **三态基础数据模型**：`PathState = present | absent | unknown`——absent（ENOENT 确认不存在，
  新增文件变更前即此态）与 unknown（读取失败/越界/目录项/符号链接越界）严格区分；**unknown
  不推导删除/新增/安全可撤销**（diff 的 undeterminable 分类+撤销的 manual 步骤）。上版
  `after 读取失败→diff 当 removed`、`before 失败/after 可读→当 added` 的错误推导已消除。
- **可恢复内容**：内容寻址存储 `appData/preimages/<projectId>/<sha256>`（写入后回读核对；
  撤销前再核对——存储损坏不得静默恢复）；`readStoredContent` 双端 hash 校验。
- **基线与恢复记录连接**：change_sets（before_ref/after_ref/manifest：git 基线+scopeKind+
  truncated）+ change_set_files（before/after 两角色逐文件行）+ change_set_undos（意图/逐步
  进度/失败与冲突结果）+ 领域事件（changeset.baselineCaptured/finalized/undoSettled，携带
  taskId/run 归属）。
- **finalize 语义**：directory-scope 重扫目录（任务新增文件须进捕获面）∪ before 路径（被删
  文件须仍被核对）；扫描完整时基线无行=变更前不存在（合成 absent 行持久化）；截断→unknown。
  已定型不重捕（after 冻结）；直接原目录模式 → application_status='applied'（§14.3）。
- **撤销执行**：planUndoSteps 按 before/after 三态推导（restore-content/delete-added/
  restore-removed+expectState/expectSha256）；**逐步执行前重验当前==after**（幂等恢复核心）；
  单文件恢复=同目录临时文件+回读核对+rename；多文件不声称整体原子——**每步即时持久化**
  （steps_json），中断/失败后按步续跑（in_progress/failed 记录恢复，succeeded 不重复执行）；
  冲突/手工/失败步骤如实汇总（status=conflict/failed；application_status=reverted/partial）。

**关键反例**（tests/integration/changesetUndo.test.ts 9/9 + tests/unit/preimage.test.ts 6/6，
全部临时 fixture——含 git init 临时仓库；正式命令路径 dispatchDaemonCommand）：
- 正常恢复：修改/新增/删除混合撤销逐字节还原+清单外文件不受影响+reverted+已撤销不重复执行；
- 用户后续修改冲突：当前≠after → conflict 不覆盖+application_status=partial；
- 撤销新增被用户改写 → conflict 不删（用户内容保留）；
- unknown（after 侧打 unknown）→ manual 不自动撤销不推导；
- 超大文件（maxBytes 策略参数）→ capture 即 contentUnavailable+undo=manual；
- 单写者：重叠活跃租约 → WORKSPACE_BUSY 拒绝（释放后可执行）；同项目进行中撤销互斥；
- 中途失败/重启恢复：failAfterSteps 注入 → failed+进度持久化（第一步文件已还原）→ 关闭连接
  重开 → 续跑剩余步骤 → succeeded（已 done 步骤不重复执行）；
- Git：HEAD 记录（40 位）+未提交/未跟踪文件进前像+撤销后用户未提交改动原样保留+HEAD 不变+
  porcelain 仍含用户文件（无 stash/reset/commit）；
- finalize 幂等：定型后再改不重捕（after 未被 v3 覆盖）。
- 前像单元：三态/内容寻址回读核对+篡改检测/大小上限/越界与 .. 拒绝/符号链接越界不跟随
  （外部文件未被读取）/目录扫描排除 .git+截断如实/同内容去重复用。

## 5. 测试与质量

- 全量 vitest **402/402**（38 文件：单元+集成；新增 admissionShutdown 5 例、changesetUndo 9 例、
  preimage 重写 6 例）；UI e2e（fake 档，Electron+CDP 真实点击链路）新增工具审计 2 例，
  既有 15 例回归；eslint **0**（六边界规则强制——preimage/changeset 因此归 daemon 层）。
- 零真实模型调用；不重跑未受影响的既有真实认证。

## 6. 如实边界与续工点

- **已实现+本地验证范围**：上文全部（本地受控 adapter/回放/临时 fixture——含 Windows 真实
  文件系统与真实 git CLI 的临时仓库）。
- **真实认证范围**：无新增（本轮零调用）；既有结论不变（interrupt=supported 等，见
  runtime-capability-matrix.md）。
- **尚未完成/需外部预算**：resumeSession 真实续接、restrict* 拒写对照（B6 前置）、双任务真实
  隔离（各自最小预算待批）；M1 价值对比 33 调用待批（只阻塞该批实验）；DEV-11 价值闸门。
- **后续工程（不依赖上述批准）**：DEV-12 的任务侧接线（写档任务派发时自动 capture/finalize/
  撤销入口——B6 写档接入时联动）；审查版本/三方内容查看 UI（DEV-13/14）；toolCalls UI 已随
  本轮 CDP 断言收口。
