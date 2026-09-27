# 修复轮 6 + G3 收口：renderer 用户链路端到端（2026-09-27）

> 本轮按用户指令完成：证据口径修正、R1–R5 renderer 五项接完整、B1 管道 commandId 关联、
> B2 生命周期收口、UI 端到端真点击验证、隔离受控交错补排队用例。报告分五段（后台命令链路 /
> renderer 用户链路 / 真实 runtime / 停止重启恢复 / 隔离交错）。
> 默认套件 276/276（typecheck+lint+test 全绿）；UI e2e fake 11/11；真实 codex UI 一轮 ✓。

## 〇、证据口径修正（用户指令第 1 条）

**ZS_UI_DEMO 不再声称等价人工点击。**它在 Electron main 进程内直连 `pipe.send`，只证明
「宿主内命令→IPC→daemon→worker→runtime→落库」链路，不经过 renderer 事件处理、preload
contextBridge 与 ipcMain 转发。既往报告中「等价人工点击」的表述作废；该档证据保留为
**宿主内命令链路**（第一段）。真正的用户界面端到端由本轮新增的 CDP 驱动测试承担（第二段）。

排错过程中的重要发现：正式 renderer `app.js` 此前**从未成功执行过**——顶层
`const zs = window.zs` 与 contextBridge 注入 window 的非配置属性 `zs` 冲突
（GlobalDeclarationInstantiation 抛 SyntaxError），而 ZS_UI_DEMO 不执行 renderer JS，
所以一直没暴露。已用 IIFE 包裹修复。教训：宿主内自动化演示覆盖不了页面脚本本身。

## 一、后台命令链路（宿主内，零额度）

- **B1 管道超时错配**：`connectPipe` 重写为按 commandId 关联（`pendingByCommandId`）；
  服务端所有回执（成功/错误/未知命令）携带 commandId（`withCommandId`）。
  反例（tests/unit/pipeClientTimeout.test.ts 2/2）：A 超时→B 随发→A 迟到响应因无等待者被丢弃，
  B 拿到自己结果；超时后断连无 pending 泄漏。daemonSmoke 增 commandId 背靠背配对用例。
  坏帧（非 JSON）丢弃不猜归属。
- **协议共享层下沉 contracts**（架构修正）：`src/contracts/daemonIpc.ts` 承载管道名/本地身份/
  凭据/管道客户端——ui 边界只许依赖 contracts（ESLint zhongshuo/six-boundaries），原先
  `ui/main.ts` import daemon 四处违规已清零（lint 24→0）。
- **task.get 补 `stopGeneration`**（对齐 contracts TaskGetResult）：R1 停止按钮的乐观并发锚点。
- **服务端新合同**：`recovery.status`（只读恢复查询，禁止用尝试恢复命令探测门禁）；
  `room.pool`（房间限定主池：threads JOIN messages LEFT JOIN tasks，含 replyCount/taskStatus，
  不事件拼接、不混其他房间）；`message.submit` 支持 `thread` 目标（THREAD_SCOPE_MISMATCH 校验、
  记录串零唤醒、任务串 M0 落库不派发、不新建根任务）。
- **B2 生命周期**：drain Promise 保存；stop=停 tick→断 IPC→等在途 drain 收敛（上限 10s）→
  收拢 adapter→关库→释放锁；重复 stop 共用同一 Promise；关库后零业务写入（SELECT 即抛 SQLITE）。
  tests/integration/daemonLifecycle.test.ts 3/3（含崩溃现场恢复：INTERRUPTED/UNKNOWN/重排/门禁拦截不重跑）。
- **配套**：`ZS_PIPE_NAME` 显式覆盖（默认按用户不变；多实例/端到端隔离用）；daemon 落
  `appData/daemon.pid`（正常退出删除，SIGKILL 残留即崩溃现场）；fake 专用 `ZS_FAKE_STALL_MS`
  停延编排（仅 ZS_ALLOW_FAKE=1 生效）；`pnpm build:ui`（esbuild .cjs + renderer 拷贝，可复现）。

## 二、renderer 用户链路（CDP 真点击，fake 档零额度，11/11）

`tests/e2e/uiE2e.test.ts`：Electron `--remote-debugging-port` + CDP `Runtime.evaluate` 在
renderer 页面内派发**真实 DOM 事件**（click/input/keydown），链路 =
app.js 事件处理 → preload `zs.command`（contextBridge）→ ipcMain → 管道客户端 → daemon 命令面。
原生目录选择无法自动化：`ZS_PICK_FOLDER` 显式环境钩子替代返回值（main 侧标注，仅测试用），
其后链路全部真实。不从 main/测试脚本发命令冒充点击。页面就绪门时序（onclick 绑定完成）防丢点击。

场景与结果（全部 ✓）：

| 场景 | 断言要点 |
|---|---|
| 点击打开文件夹 | 项目/房间加载、主池空态、mention 预填（M0 诚实实现，见下） |
| 输入+Enter 发送 | 卡片 OPEN→DONE、线程 agent 回复、终态无停止入口 |
| 线程内跟进 | 消息落当前线程（锚点外新增本人消息）、主池卡片数不变（不新建根任务） |
| 双视图草稿独立 | 主池/线程草稿互不覆盖、切换保持 |
| 仅记录 | 讨论串卡片（零任务零派发）、开关一次性自动复位、线程无 agent 回复 |
| 双击/双 Enter 去重 | 恰 +1 卡（在途单飞 + 同 commandId 语义） |
| IME 组合态 | isComposing Enter 不发送、不拦截默认 |
| 页面重载 | 按上次项目路径自动恢复、主池历史完整、无门禁 |
| UI 停止（R1） | 运行中按钮出现→点击（绑定点击时 taskId/runId/停止代次）→STOPPING→已停止→按钮隐藏→卡片 CANCELLED |
| 崩溃恢复（两段） | 见第四段 |

renderer 实现要点（src/ui/renderer/app.js 全量重写）：
- R1 停止：点击时捕获任务快照（task.get 的 runId+stopGeneration）——切线程不误停；STOPPING 期间禁用防重复。
- R2 恢复：`recovery.status` 只读查询→侧栏「恢复待继续」入口+遗留摘要；**用户明确点击**才
  `dispatch.resume{confirm:true}`；重连事件触发复查。
- R3/R5：主池走 `room.pool`；线程内发送固定 thread 目标；删除事件拼接渲染与空 threadId 占位。
- R4：双视图草稿独立（{text, mention} 各一份）；发送在途单飞；传输失败保留同 commandId 重试横幅
  （服务端幂等重放，不自动重发文本）；IME 组合态 Enter 不发送；仅记录一次性复位；**M0 模式明确禁用**
  ——后端模式门禁仅 DIRECT（§6.1，AUTO/DELIBERATE→BLOCKED 不冒充），UI 的「默认交给 AI」在 M0 的
  诚实实现=恰一名启用 agent 时预填 mention（用户可见可改）；清空后发送按 AUTO 提交，服务端如实置「待处理」。
- 发起时固定视图与意图（修复：响应到达前切换视图不得动另一视图草稿）。
- 线程锚点置顶（根消息是房间级消息、不在 thread 历史内——打开时从主池卡片携带，data-anchor 标记）。
- localStorage 记上次项目路径（userData 隔离到 appData/electron-user-data，测试/多实例不串扰）。

已知残留（如实）：跨房间切换场景未测（正式命令面无建房命令，无法经真实面构造第二房间）；
发送横幅的传输失败路径由 pipeClient 单测+smoke 断连用例覆盖，未做 UI 级注入。

## 三、真实 runtime（renderer 真点击链路，gpt-6-luna）

`uiE2e` codex 档（ZS_G3_REAL=1 显式触发）：点击打开目录→真实输入框填写→点击发送→
真实模型读取 notes.md → 回复含 fixture 暗号 **UIE2E-CODEX-6666** 进正确线程 → 任务 DONE。
**1 个真实 turn，耗时 24.7s**（gpt-6-luna；预算受控，测试后进程已清理）。
这是 G3 首次「renderer 用户链路 × 真实模型」闭环：此前真实链路证据均在宿主内命令档。

## 四、停止 / 重启 / 恢复（含崩溃现场）

- **UI 停止**（第二段表格）：运行中→点击→终态全链路真实（task.stop→STOPPING→CANCELLED）。
- **运行中 SIGKILL daemon→重启→待续**（uiE2e，fake+停延）：任务 ACTIVE 时硬杀 daemon
  （daemon.pid 定位）→ renderer 断连提示出现 → 测试侧重启 daemon（同 appData/凭据/管道）→
  renderer 自动重连 → **恢复门禁入口出现**（中断运行/待派发摘要，只读查询）→ 不自动续跑 →
  用户点击确认 → 开闸 → **中断任务不重跑**（决策 44/RT-03：崩溃重领对账 `run.reconcileRequired`，
  保持 ACTIVE 等对账）→ **新调度恢复可用**（恢复后新任务正常派发到 DONE）。
- 与 daemonSmoke 第 5 用例互补：smoke 覆盖「排队未领取」遗留（确认后正常补派），本轮覆盖
  「运行中崩溃」遗留（确认后不重跑、等对账）——两个分支的门禁与确认语义都有证据。

## 五、隔离受控交错（正式并发策略，零额度）

- **同成员上限 1 排队**（新增，isolationTasks 第 3 用例）：同成员两任务**先排队再统一派发**
  ——串行逐个完成、各恰一 run、完成顺序=排队顺序、回复各归线程、会话按任务隔离不因同成员合并。
  M0 正式并发=daemon 单写者串行，未用双 daemon 共享库制造并发（用户纪律）。
- **不同成员受控交错**：isolationTasks 第 1 用例（真实 DispatchWorker×FakeRuntimeAdapter，
  A/B 交错、回复/会话/成果各归各）+ 第 2 用例（同成员先后两任务输入包互不包含对方线程，FIX-6）。
- **旧事件迟到不串**：unit/isolation（其他 turn 事件迟到拒绝改变状态、目标线程漂移拒绝）+
  协议回放 mock（迟到/早到/双会话并发）——归属判定在服务端，不随 UI 切换漂移。
- M0 worker 串行 ⇒「双任务真并发交错」在 M0 不可构造（此前已如实记录）；同成员排队正确性
  与不同成员交错归属均已覆盖。

## 六、验收状态与数字

- `pnpm check`：typecheck ✓ / lint ✓（本轮修复 24 处，含 ui→daemon 边界违规清零）/ 默认测试 **276/276**。
- `pnpm test:e2e tests/e2e/uiE2e.test.ts`：fake 11/11（约 30s）。
- 真实档：`ZS_G3_REAL=1` 单用例 ✓（1 turn）。
- G3 结论：**必要场景全部具备证据**（打开真实目录→选成员→发送→正式输入→真实文件→正确线程→
  交付校验；UI 停止；重启恢复门禁与显式确认；不假成功）。DEV-07 状态升级为 VERIFIED（G3 范围；
  打包随包 Node 属 DEV-15）。**按授权默认进入 M1**（DEV-08/09/21-M1）。
