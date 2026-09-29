# 第八轮施工报告：supervisor 进程树事实 / 迟到成果正式接收 / 真实测试预算护栏 / DEV-14 主体（2026-09-29）

> 零真实模型调用轮。全部验证经 fake adapter / 真实本地 node 子进程 / 临时 git fixture；
> 入口隔离与预算护栏有子进程实跑证明（`tests/integration/testIsolation.test.ts` 5/5、
> `tests/integration/realCallBudget.test.ts` 5/5）。

## 〇、本轮执行的命令与调用口径

- `npm test`（unit+integration）：**493/493 通过**（本轮新增 26 个用例）。
- `npx vitest run tests/e2e/uiE2e.test.ts --config vitest.e2e.config.ts`：**19 通过 + 2 skip**
  （2 skip=ZS_M1_REAL/ZS_REAL 真实档门禁，未执行）。
- `npm run lint`：0 错误；`npx tsc --noEmit`：0 错误；`npm run build:ui`：成功。
- 本轮**未运行任何 real* 测试**（不设 ZS_REAL_E2E）→ 无真实模型调用。上轮 55 次意外调用
  偏差记录保持独立（不改写、不抵销、不每轮复证）。
- 价值评分：**用户决定暂缓**（恢复与修复链稳定后集中安排一次）——非本轮阻塞项。

## 一、把直接子进程查询补成可信的执行保护依据

### 生产路径

- `listLiveChildProcesses`（单层 ParentProcessId 过滤）**不再是退出证据的判定来源**。新判定
  链（`src/daemon/processCheck.ts` + `src/daemon/processRegistry.ts`）：
  1. `snapshotProcessTable()`：**单次全表进程查询**（`Get-CimInstance Win32_Process`，行标记协议
     `T:<pid>:<ppid>:<startms|null>`，`$ErrorActionPreference='Stop'`+try/catch→`E:` 行）；
  2. `analyzeProcessTree(rootPid, historical)`：
     - **现存树 BFS**：从登记根沿 PPID 边向下收集存活后代（覆盖：父退子活——孤儿的 PPID
       仍指向死父；存活期间继续派生的新进程挂在活节点下）；
     - **历史归属核对**（覆盖：中间代际已退出、孙进程遗留——现存图不连通）：对**活跃期
       快照**登记过的每个 PID 收集「以它为 PPID 的存活进程」，用**创建时间**做归属核对：
       子创建时间须 ≥ 快照登记的启动时间（排除更早家庭的 PID 边残留）；该 PID 已被复用时，
       创建时间早于复用者启动时间的才是我们的后代（排除复用家庭）；历史/子任一侧创建时间
       缺失=无法区分=**保守计入**（保护保留，不猜测排除）；
  3. `probeTurnExit` 的 exited 分支改走上述分析：发现存活后代→`unknown`（保护保留）；
     枚举不可用→`unknown`（未完整确认）；**无活跃期快照→`unknown`**（中间代际遗留不可排除，
     不再用「现存树为空」冒充完整退出——这是对第七轮「无快照 exited」的收紧）。
- 持续归属登记（`process_tree_snapshots`，迁移 012）：worker 在 **startTurn 成功后首拍**
  +**消费期间每 5s 周拍**（`collectTreeRows` 从根 BFS 收集含根的树行；根已退出时写占位行）。
  快照写入走生产函数链，崩溃/截止窗口再短也有历史锚点。
- 查询协议修复：**「查询成功且 0 匹配」与「查询失败/输出损坏」严格区分**——空输出（win32
  全表必有系统进程）与任何无法解析的行都返回 `failed`（不把失败当空结果、不静默忽略残缺行
  后返回 checked）；CIM 错误经 `E:` 行可靠传回。
- 创建时间真正参与归属核对（上轮只采集不使用）：见上述时序规则，纯注入单测覆盖
  复用家庭排除/真后代保留/历史时间缺失保守计入。

### 本地验证（全部经 recovery.probeProcess / reconcile / releaseProtection 正式命令链）

`tests/integration/processTreeSupervisor.test.ts` **9/9**：
- **三代现场**（父→子→孙真实 node 进程；父/子先退、detached 孙继续运行）：probe=unknown
  （历史归属核对发现孙）；reconcile executed=结算但保护保留；releaseProtection **拒绝**；
  孙结束后 probe=exited（含快照 N 个历史身份）→ 解除成功；
- 快照之后继续派生（孙A 在快照内、孙B 在快照后派生，随后父退）：两条路径都不漏；
- shared（共享 server）同型：server 死+工具进程遗留→unknown；server 存活→turn 执行状态未知；
- 无快照→unknown（未完整确认）；树枚举失败注入→unknown；
- 查询协议故障注入（E:/空输出/残缺行→failed）；创建时间规则纯注入单测；
- pre-launch/identity-missing 两窗口区分（复证）；
- **worker 生产接线**（fake processIdentity 上报真实子进程身份）：派发期间快照自动落库。

`tests/integration/recoveryProcessEvidence.test.ts` 9/9、`protectionRelease.test.ts` 4/4
（「无快照 exited」用例已按新语义补拍快照=模拟 worker 生产行为）。

### 能力边界（收窄到实际已覆盖范围，runtime-capability-matrix 同步）

- **最后快照之后新派生、且其父链在快照之后死去的深层链不可发现**（快照间隔 5s 内风险
  存在）；win32 之外平台=unsupported（保护保留语义不受影响）；PID 复用检测依赖创建时间，
  缺失时保守计入。等效完美方案（Job Object/ETW 持续监听）需要原生能力，列为后续可选。

## 二、迟到成果经正式事件路径进入，不重复结算

### 「谁继续接收」的明确答案

`consumeUntilTerminal` 返回（turn 已 UNKNOWN）后，事件继续到达的接收者=**迟到成果泵**
`DispatchWorker.pumpLateEventsForTurn`（正式命令 `recovery.pumpLateEvents`，entry 已接线）：
- 事件来源=adapter **正式通道**（新契约 `RuntimeAdapter.lateEvents?`）：fake 实现为**持久化
  会话记录**（`sessionStoreDir` 的 events 文件，模拟 CLI 会话文件）——**同 daemon 与重启
  （新进程实例读同一持久化记录）两条路径同一实现**；真实 claude/codex adapter 未实现
  lateEvents=泵如实返回 `unsupported`（能力矩阵/UI 标注「真实 CLI 会话文件回放待补证」，
  **不靠直调处理函数冒充生产支持**）；
- 事件**不是命令参数**（调用方自报无从进入——与 alive=false 自报同型拒绝）；
- 会话定位：turn 启动时写入 `agent_turns.session_id`（旧数据回退最近同任务会话记录）。

### 进入完成分支前的核对（applyEvent 统一承载，新增守卫）

- **重复终态**（含 SUCCEEDED——上轮缺口：重复完成会撞交付主键）：记
  `turn.lateCompletion` 审计，不复活/不交付/不重复结算；
- **停止代次**（tasks.stop_generation>0 或任务 CANCELLED，turn 尚未收口）：迟到完成按取消
  收尾（不复活已停止任务；停止意图以 tasks 表事实承载，不依赖事件顺序）；
- **退款冲突**（budget_mark=refunded 后收到合法输出）：留 factConflictHint 审计（走
  recovery.correctToExecuted 正式纠正），**不自动改账**；
- **被替代 run**（任务已有其他 run 的交付）：旧 run 输出收口事实（SUCCEEDED+本 run 结算）
  但**不交付、不迁移任务状态**（`turn.lateCompletionSuperseded` 留痕，不覆盖新结果）；
- **幂等双层闸**：`late_event_receipts`（eventKey 回执，迁移 013）+ turn 终态 CAS——
  同 eventKey 重复拉取与不同 eventKey 重复完成均只生效一次；迟到的 INTERRUPTED 回执
  （非结果事实）不收口。

### 本地验证（可控 fake 走正式 worker 路径）

`tests/integration/lateOutcomePath.test.ts` **7/7**：**实际派发**（真实 DispatchWorker）→
截止进入 UNKNOWN（400ms 截止）→ fake 在截止后产出合法迟到输出（`pushLateEvent`=
模拟真实通道，同时落持久化记录）→ `recovery.pumpLateEvents` → applyEvent 合同校验 → 收口：
- 同 daemon：SUCCEEDED+交付 1+usedTurns=1+租约释放+`lateEventsSettled`；重复 pump 幂等；
- **重启**：daemon A 崩溃前迟到输出已落盘 → daemon B（新库连接/新 adapter 实例）泵同一
  持久化记录 → 同样正式收口；
- 停止代次→CANCELLED 不交付；refunded 冲突留痕不改账；executed 已结算→不重复 U+1；
  多事件重复完成→1 生效+1 skipped-terminal；superseded→不覆盖新交付。
- `outcomeConsistency.test.ts` 7/7（applyEvent 定点单元验证保留，与新守卫语义对齐）。

## 三、真实测试预算护栏（机械硬上限）

- `tests/util/realCallGate.ts`：**用例数≠startTurn 次数**（旧注释口径废除）——上限依据=
  文件内实际 startTurn 调用点数+1；配置（runtime/model/maxStartTurns/budgetLabel/storeDir）
  全必填，缺一在 `open` 即拒绝（**未提供配置=请求前拒绝**）；超限在 `acquireStartTurn`
  抛 RealCallLimitError（**请求前拦截，不发网络请求**）；结果 sent/failed/timeout/uncertain
  如实落**文件账本**（uncertain≠零消耗；已 acquire 的票无论结果都占额度——保守口径）；
  账本+目录锁互斥，**后开进程/文件沿用账本既定额度**（不得改限）；混入不同 runtime/model
  的账本=配置错误拒绝。
- realCodex 三文件接线：全部 `startTurn` 经 `gatedStartTurn`（含直接调用点共 4+6+4 处，
  漏网点由 testIsolation 文本断言防回退）；afterAll 打印账本汇总（核账材料）；跨文件同批
  共享额度须显式同一 `ZS_REAL_BUDGET_DIR`（配置文件注释同口径）。
- `tests/integration/realCallBudget.test.ts` **5/5**（零网络）：配置拒绝/单进程拦截/账本
  持久化重开不重置/混渠道拒绝/gated 包装三态回填/**跨进程并发**（两个真实子进程
  `node --experimental-strip-types` 各争 6 次、总额 8：acquired 合计恰 8、每次尝试二值落账）。
- **「环境变量门禁」与「预算硬上限」分别验收**：testIsolation 验门禁（原 4 用例），本文件
  验护栏；testIsolation 新增护栏层断言（real 文件无未过闸 startTurn）→ **5/5**。

## 四、DEV-14 主体（依赖已满足的功能闭环，非只读占位）

对照任务书列出的本轮已具备依赖项与落点：

1. **任务串变更记录详情**（`changeset.listByTask` 增强）：撤销进度（doneSteps/totalSteps）、
   冲突原因（failure_json 用户可见）、可续跑标注（in_progress/failed）——`dev14Commands` 5/5
   断言 + UI 行内渲染。
2. **Git 状态与差异视图**（`git.status` 只读，RT-24 首个真实数据面）：真实 git 仓库数据，
   **暂存/未暂存/未跟踪严格区分**（porcelain XY 列），重命名 to←from；只读不改工作区
   （**保留用户已有未提交内容**——测试前后 porcelain 对照）；非 git 目录明确拒绝（不返回
   空状态冒充）。写操作不在本命令（Git 提交不等同验收；撤销走 changeset.undo 合同）。
   集成测试用**临时 git fixture**（不触用户真实工作区）；UI 主池区块+30s 缓存+错误不缓存。
3. **可选任务验收**（`task.review`，RT-25）：按**任务创建时策略快照**（review_policy=
   user_review 才有 pending 交付；auto_deliver 拒绝）；唯一 pending 交付（DB 唯一索引保证）
   +任务 REVIEW 前置；accept→交付 accepted（reviewed_by/at/note）+任务 DONE；
   changes_requested→交付留痕+任务回 ACTIVE（返工经 redispatch 正式链）；重复处理=幂等拒绝；
   **Git 提交不等同验收**（命令只写 review 账本与任务状态，审计字段明示）。UI：REVIEW 状态
   显示「验收通过/要求修改」，状态变更后入口收起。
4. **运行能力真实状态**（`runtime.status`，只读、不 spawn 子进程）：成员绑定（含「默认
   runtime」如实显示）、claude 静态能力关键项（restrictWrites/interactiveApprovals=
   unverified 不升级）、daemon 恢复能力（进程树取证按平台如实/迟到回放「真实 CLI 待补证」）。
5. **帮助与故障引导**（START-07/09 首版最小落点）：恢复面随行帮助（UNKNOWN 是什么/为何
   先服务端取证/人工声明为何保留保护/迟到成果如何进入/能力真实性口径）；完整帮助系统归
   DEV-15/16 随包交付。
- 写档未认证入口保持关闭（未新增任何 git 写命令/并行写入增强）；原型既有交互复用
  （恢复面/任务面板样式同源）。
- UI e2e 新增 2 用例（`uiE2e.test.ts` **19 过+2 skip**）：git 分组渲染+只读复证+运行能力+
  帮助显隐；REVIEW→accept→交付 accepted+任务 DONE+入口收起（命令/状态全走正式链路）。

## 五、仍未覆盖（如实）

- **真实 CLI 迟到回放**：claude/codex adapter 的 lateEvents（会话文件/重连存量流解析）未
  实现——泵对真实 runtime 如实 unsupported；本地已验证 fake 双路径（同 daemon+重启）。
- **进程树取证真实 CLI 端到端**（真实崩溃现场的自然 PID 复用/CIM 稳定性）与文件发现真实
  有效性——归真实补证窗口（另批预算，优先 Claude Code+deepseek-flash；Codex 专项单独列）。
- 进程树「最后快照之后新派生且父链已死」的深层链窗口（快照 5s 间隔）——能力矩阵已收窄。
- 研讨轮（delib.*）UNKNOWN 的迟到输出收口=成员缺席语义，不在本轮处理范围（泵如实
  unsupported-mode）。
- DEV-14 的 Git diff 正文视图、Git 写操作（暂存/提交 UI）、START-07/09 完整帮助系统——
  按依赖矩阵后续轮次。

## 六、提交分组

1. supervisor/进程树事实 + 迟到成果接收与幂等结算（生产链一体：迁移 012/013、
   processCheck/processRegistry、contracts lateEvents、fake 会话持久化、dispatchWorker
   快照接线+泵+守卫、commands probe/pumpLateEvents、entry 接线、集成测试 9+7+2 修补）；
2. 真实测试预算护栏（realCallGate+跨进程 runner+realCodex 三文件接线+配置注释+隔离断言）；
3. DEV-14 功能闭环（gitStatus.ts、git.status/task.review/runtime.status/listByTask 增强、
   UI 区块/验收操作/帮助、e2e）；
4. 文档（本报告+能力矩阵+总账/continuation）。
