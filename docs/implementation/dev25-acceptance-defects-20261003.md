# DEV-25 双机验收现场缺陷报告（2026-10-02 深夜 D7 会话）

> 交付对象：代码检查 / 发包评估 AI。本文自包含，不依赖会话上下文。
> 现场环境：`dist/desktop/dev25-dual-win-v2`（buildId `bld_4d7928368c7da46f`），fake runtime +
> `ZS_REAL_DISPATCH_GUARD=1` + `ZS_FAKE_STALL_MS=60000`（交付包 `start-server.bat` 固定设置）。
> 触发场景：用户执行 D7（发任务→关浏览器→重开→结果可见）过程中连续受阻，工程侧经只读诊断
> 定位并做了最小现场恢复。**D7 最终通过（用户回填）**，real_calls=0（零真实调用口径未破）。

## 0. 现场已执行的动作（透明登记，全部走正式命令面、有回执留档）

| 时间（约） | 动作 | 结果 |
|---|---|---|
| 23:48 | `dm.resume` → DM A 会话（dm_e8291876…，代用户点击其反复尝试的「继续队列」） | enqueued=1，但该任务 turn **FAILED**（当时 runtime 仍为 claude 绑定，见缺陷 2） |
| 23:52 | `member.setRuntime kind=fake` ×2（Guide A=`m_default_prj…_0`、Guide B=`m_default_prj…_1`，原绑定 claude/ri_claude_89ade9281c/deepseek-flash） | 恢复 fake，持久生效 |
| 23:52 | `dm.resume` → DM A（重泵）+ `dm.resume` → DM B | DM A enqueued=1 → 任务「测试」run **SUCCEEDED**；DM B enqueued=0 |
| 全程 | 只读核对：projects=1（demo-project）、dm 会话=9、runs/tasks 状态、conversation.list/room.list 直连返回正常、real_calls=0 | — |

留档脚本（`dev25-dual-win-v2/RESULTS/`）：`diag-dm-state.cjs`（只读库核对）、`diag-sidebar.cjs`
（只读直连 daemon 复现侧栏调用）、`diag-resume-dma.cjs` / `assist-fix-runtime.cjs`（上述写操作）。

用户操作还原（缺陷成因链）：用户在项目设置中给两个成员绑定了 claude 渠道（桌面 `ui-` 前缀回执
两条 `member.setRuntime`，installationId=ri_claude_…）→ 此后所有任务派发被真实派发防护拒绝
→ 用户感知「任务一直不完成」；期间在房间发任务（AUTO 门禁 BLOCKED，预期）、多次点「+ 新私信」
产生 7 个空白会话、在空白会话上点「继续队列」（成功但无事可做）；23:35 重启服务端后桌面侧栏
列表不再出现（缺陷 1）；「退出浏览器2」任务因关掉**服务端窗口**（而非客户端浏览器）被停机中断。

---

## 1. 桌面侧栏房间/私信列表「闪现后被清空」（根因未定位，需带调试端口取证）

- **现象**：服务端重启（23:35）后桌面窗口 `#room-list`/`#dm-list` 为空；View→Reload 后列表短暂
  出现（房间行+Guide A/B 会话行），随后消失回到空侧栏。主区正常（主对话池、Git 状态、待处理卡片
  均有真实数据）。`#project-name` 持续可见（CSS 无隐藏规则，`style.css:7`）。
- **已排除**：
  - 服务端数据/命令面正常——直连管道 `conversation.list {projectId}` 返回 9 会话、`room.list`
    返回 2 房间（`RESULTS/diag-sidebar.cjs` 输出）；
  - localStorage 正常——`zs.lastProjectPath` 持续为 demo-project，未被改写；
  - 进程配对正常——4 个 electron.exe + daemon.cjs 均为 v2 包路径，无双开/错连旧包；
  - 「打开了错误项目」不成立——库中仅 1 个项目（projects 表核对）。主区 Git 状态显示
    「仓库根 D:\zhongshuo」是因为 demo-project 位于开发仓库目录内部，git 向上寻根，属正常显示。
- **代码事实**（`src/ui/renderer/app.js`）：
  - `loadProject`（105-136）：room-list 在 116-125 填充（`innerHTML=''` 后逐项 append）；
    尾部 134 行 fire-and-forget `renderDmSidebar()`；
  - `renderDmSidebar`（228-243）：`state.projectId == null` 直接 return（不清空）；
    `await conversation.list` 失败会抛给外层 `.catch(() => {})`（**不清空**）；只有「命令成功且
    conversations 为空/属另一空项目」才会清空（`replaceChildren()` 后循环零次）；
  - 清空 room-list 的唯一代码路径是再次进入 `loadProject` 116-117。
  - 启动恢复（4006-4022）读 localStorage → `loadProject(lastProject)`，失败仅改 project-name 文案。
  - `zs.onReconnected`（3875-3880）只做 `refreshGate` + 当前视图重渲染，**不含** loadProject /
    renderDmSidebar。
- **疑点（未证实）**：`#dm=<空白会话id>` 深链残留 + `restoreDmDeepLink`（259-305）与启动恢复链的
  交互；以及某条未被记录的二次 `loadProject`/`renderDmSidebar` 空结果调用。
- **影响**：服务机桌面端无法导航到已有房间/会话（远程页面不受影响）。与缺陷 3 叠加时验收者完全
  失去会话入口。
- **取证建议**：以 `ZS_DEV25_DEBUG_PORT` 重启复现，断点 `renderDmSidebar` / `loadProject` 调用栈
  与 `conversation.list` 实参；检查 hashchange/popstate 触发次数。

## 2. 绑定真实 runtime 后任务全部派发拒绝：UI 无事前警示、无事后失败原因

- **现象**：成员绑定 claude（deepseek-flash）后，所有新任务 turn 立即 FAILED（`start-server.bat`
  的 `ZS_REAL_DISPATCH_GUARD=1` 在 spawn 真实 runtime 前拒绝——零真实调用护栏，拒绝本身是设计
  行为）。但：①绑定时 UI 无「当前包为真实派发防护模式，绑定真实渠道会导致任务全部失败」警示；
  ②任务行/会话面看不到失败原因，用户感知仅是「一直不完成」。
- **取证**：绑定链 `project_members.profile_id → agent_profiles.runtime_installation_id →
  runtime_installations`（`src/daemon/memberRuntime.ts`，绑定命令 `member.setRuntime`
  `src/daemon/commands.ts:708-753`，恢复=重设 kind=fake，无解绑参数）。失败 run 的
  `domain_events` 仅有 `run.created`，**无任何 turn.failed/startupFailed 事件**——防护拒绝路径
  未写失败事件（审计缺口）；`task.get` 的 `lastStartupFailure` 上屏机制（commands.ts:786 附近，
  读 `turn.startupFailed`）因此显示不出原因。
- **修复方向**：①`member.setRuntime(kind=claude/codex)` 在 `ZS_REAL_DISPATCH_GUARD=1` 时返回
  明确警告或直接拒绝（防护模式下不可绑真实渠道）；②防护拒绝路径补 `turn.startupFailed`（或等价）
  事件+任务行展示；③run FAILED 零事件的静默面一并排查。
- **影响**：本次验收卡死的**主根因**；且用户完全无法自助诊断。

## 3. 远程页面无「继续队列」入口（dm.resume）

- **事实**：`dm.resume` 不在 `REMOTE_BLOCKED_METHODS`（`src/daemon/remoteServer.ts:168`——命令面
  通），但 `src/daemon/remoteClient.ts` 无任何继续队列 UI。远程任务行有「停止」按钮（DEV-22：
  停止=队列转 paused 挂起，需显式继续），停完只能回服务机桌面恢复；桌面侧栏又踩缺陷 1 →
  **组合成完全无法自救的死锁**（本次用户实际卡死路径）。
- **修复方向**：远程页面会话头/任务行增加「继续队列」（execState=paused 时显示）。

## 4. BLOCKED/失败任务行无解释文案；远程房间任务必然 BLOCKED

- **事实**：房间 AUTO 派发被 M0 模式门禁置 BLOCKED（`src/daemon/dispatchWorker.ts:374-384`，
  reason=`mode_unavailable_in_m0`——M0 仅 DIRECT，设计行为），任务行只显示「blocked」，无
  「房间任务需 @ 指定成员」提示。且远程页面发送固定 `mentions: []`（`remoteClient.ts:534`）——
  **远程页面上发的房间任务 100% 会被拦**，用户无从得知。
- **修复方向**：①BLOCKED 行按 blockedOutbox/admission 原因显示人话；②远程房间发送支持指派
  成员，或发送时明确提示「当前页面房间消息不会派发（需指定成员）」。

## 5. 「继续队列」成功无任何反馈

- **事实**：`dm-resume-btn` handler（`app.js:3598-3602`）成功后仅静默 `renderDm()`；会话无排队
  任务时 `enqueued=0`，界面零变化——用户感知「点了没反应」（本次在空白会话上点击即此现象，
  回执证明命令成功）。
- **修复方向**：更新 `dm-state` 文案（如「已继续（泵出 N 条）」）。

## 6. 侧栏私信行只显示成员名，空白会话与存量会话不可区分

- **事实**：`renderDmSidebar` 按钮文案=`${peerDisplayName}${stateText}`（`app.js:238`），
  不使用 `title`（「DM A - stop drill」等会话标题在数据里但未渲染）。「+ 新私信」每次新建
  独立空白会话（同成员可多条，设计行为），9 行「Guide A/Guide B」无法辨认目标——用户因此
  始终误入空白会话，从未打开过种子会话。
- **修复方向**：有 `title` 或最近消息时在行内区分显示（title/预览/时间）。

## 7. daemon 重启后「ACTIVE 但仅有终态 run」的 dm_turn 永久卡死

- **事实**：「退出浏览器2」任务=ACTIVE + run INTERRUPTED（23:35 服务端停机时中断，
  `applyRecovery` 标记）。`pumpDmQueue`（`src/persistence/stores/dm.ts:224-248`）只泵
  `NOT EXISTS (workflow_runs)` 的任务——**有终态 run 的 ACTIVE 任务永远不被泵**；会话
  execState 显示「排队等待」但无任何推进入口（「继续队列」仅 paused 显示；新任务不受影响可正常
  跑）。重启扫描（`dispatchWorker.ts:2152` 起）只处理「已终态 dm_turn 无结算键」，未覆盖此形态。
- **修复方向**：重启恢复/终态结算对该形态给出 `task.redispatch` 入口或卡死告警。

## 8. 启动项目恢复失败后不重试（疑与缺陷 1 叠加，未单独取证）

- **事实**：启动恢复 `loadProject` 失败仅显示「恢复项目失败：…」（`app.js:4008-4010`）；
  `zs.onReconnected`（3875-3880）恢复视图但**不重新 loadProject**——daemon 就绪后侧栏/项目仍空，
  需手动 Reload。启动竞态窗口（daemon 未就绪时 renderer 先跑恢复链）无重试。

## 附：低置信度杂项

- 侧栏「搜索」折叠项被视觉复核疑读为「搜素」（源码应为「搜索」，`index.html` 待核对——可能为
  截图分辨率误读，列为待核实）。
- 会话操作栏四按钮（停止/继续队列/归档/取消归档）在用户截图中疑似同屏（按渲染逻辑两两互斥，
  `app.js:1893-1896`）——若属实则存在「renderDm 未跑完即残留旧显隐态」的路径，可与缺陷 1
  一并取证。

## 修复排期判断要点（供评审 AI，不代结论）

- 缺陷 2+3+1 的组合在本次验收中实际造成「完全卡死」：2 是主根因（任务静默死亡），3 和 1 分别
  堵死远程/桌面两条自救路径。任何一条单独修掉都能避免本次卡死，但三者都属验收可用性硬伤。
- 缺陷 4/5/6 属可诊断性/可导航性：不造成功能死亡，但验收者无法理解系统状态。
- 缺陷 7/8 属恢复链完整性：影响特定中断形态（停机中断任务/启动竞态）。
- 以上全部不涉及数据损坏与安全面；real_calls=0 口径全程未破。

---

## 勘误（2026-10-03 第三十九轮追加——第三十八轮复核确认，原记录保留）

1. **缺陷 2 的「审计缺事件」结论不实**：对 v2 库三个 FAILED run 逐个核对 domain_events——每个
   run 均有 `turn.startupFailed`（phase=standing-prompt，message=[验收防护]…完整原因）。真实缺口
   是**呈现**（任务行/看板/远程面不显示原因）与**事前拦截**（防护模式允许绑定真实渠道），两者
   已在第三十八轮修复（拒绑+statusReason/failNote 上屏）。原文「无任何 turn.failed/startupFailed
   事件（审计缺口）」一节作废，其余取证保留。
2. **缺陷 1 的根因表述**：本文与收案链中凡将「深链路径字符串比较→二次 loadProject」写成根因
   确认的，一律按**候选根因+防御修复**口径理解——未取得冻结复现的调用栈/时间线实证；第三十八
   轮已落地的是渲染代次守卫/空结果保护/审计环等防御与取证工具（window.__zsNavAudit），
   projectId 判定属高置信修复。侧栏闪现清空的原始触发序列仍待现场取证。
