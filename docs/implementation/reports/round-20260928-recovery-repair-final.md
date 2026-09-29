# 第六轮·下（2026-09-28）：修复链持久绑定 / 恢复事实分离 / 文件授权与 UI

零真实调用（批次剩余 3 次保留不动用）。四笔提交：`768b51a`（修复链）、`a4e8ada`
（恢复+进程取证）、`f8f83b0`（文件授权+UI）、外加本报告与总账同步。全套 **435/435**、
UI e2e **15/15**（fake 档）、lint 0。

## 1. 格式修复改持久工作项（修复用户指认四缺陷）

| 缺陷 | 修复 |
|---|---|
| kv 读后即删（组装/准入前丢失） | 迁移 008 `format_repair_workitems`：pending→consumed 与 run/turn 创建**同事务**原子落位；准入延期/组装失败/崩溃重领不丢失不降级 |
| 按"任务最后一条"取证（不同轮混用） | 同轮精确绑定：源 turn=最后一个 FAILED 且**其自身** outputInvalid 事件（turn_id 绑定）；源输出=该 turn 的 `thread.replyAdded` 最后消息；resultKey=`result_<turnId>` 与 run.created 审计核对（散文也可修复） |
| "每逻辑输出一次"实现为每任务一次 | `(task_id, source_turn_id)` 唯一约束+修复派发键版本化 `task:<id>:repair:<sourceTurn>`；后续独立输出有自己的修复资格 |
| `:redispatch` 后缀误标修复轮 | worker 结构化查工作项（`consumed_turn_id` 绑定）；普通 redispatch 失败保持 ACTIVE 非 BLOCKED |

其余：损坏上下文（hash 不符/事件缺失）→ 工作项 blocked+任务 BLOCKED+审计
`task.repairContextCorrupt`（不花调用不忽略）；修复轮预算**沿用原授权**（usedTurns=
任务既往 DIRECT run 累计播种，`task.repairConsumed` 审计 `budgetCarryoverUsed` 可核）。
反例 9 用例（directRepairContract）：同轮取证+预算沿用／二次拒绝+重启不丢上下文全文／
普通重派区分／损坏阻塞零新调用。

## 2. 恢复对账事实分离（执行≠退出≠成果）

`recovery.reconcile` 三事实解耦：
- **执行事实**：notStarted=退款（I-1；DELIB 尾部 turn 恢复 S/Q 预留）；executed=结算——
  先结算无论退出事实；
- **退出事实**：exited 须**结构化 OS 证据**（`osProcessCheck`: pid+observedAt+alive=false；
  `userManual` 不能单独证明——参数层拒绝）；alive/unknown → **保留租约与准入占位**、
  turn 保持 UNKNOWN；executed 二次调用=补交退出证据（合法不重算，budget_mark 防双算）；
  settled→notStarted 事实矛盾拒绝；
- **成果事实**：确认执行不自动等于业务失败也不伪造成功——FAILED 仅记录
  `executed-exited-no-recorded-outcome`（留证可复核）；
- 逐 turn `budget_mark`（settled/refunded）幂等；keepUnknown 守卫一致（非 UNKNOWN 一律拒绝）。

**同 daemon 联动**：对账事务成功后 `releaseAdmission` 钩子（entry→worker.reconcileRelease）；
DB 先于内存（崩溃间最坏=占位保留至重启，不早放行）。验收：同 daemon 全链
（UNKNOWN 占位→正式 reconcile→解除→原排队任务可派发）+「executed 但进程活着」反例
（占位不解除、新任务仍被挡）。

**OS 进程取证**（`processCheck.ts`，真实本地子进程验证）：win32 PowerShell
StartTime；alive/exited/unknown 三态；PID 复用按启动时间判 different（判退回
unknown）；`buildExitEvidence` 组装（复用/无启动时间如实降级）。

## 3. 文件授权过滤 + UI

- `authorizedFileListing` 作用域化：隐藏项+**其他任务 change_sets 归属文件**（after=present）
  不入清单；`taskScopedFileListing` 两模式同一规则；integrityNote 声明范围与排除规则
  （进信封受 hash 校验）；明示「不构成文件沙箱认证」。反例：其他任务产物/隐藏项不入
  清单与模型输入、本任务产物可见。
- **恢复面 UI**：恢复中心面板（UNKNOWN 明细+受影响任务/阶段+需人工判断动作分行）；
  操作精确绑定行 turnId；**未确认退出不提供一键清空**（文案明示需 OS 证据）；未收口
  撤销计数+续跑指引。e2e 崩溃-重启链断言（15/15）。

## 4. 补证方案口径纠正（§六）

- **旧批次 DIRECT 二次调用=无反馈重派（非正式修复）**——旧批次比较的是**当时实际产品
  行为**，不能拿它直接证明新修复机制的相对效果；
- 预算纠正：「首 turn 失败→修复 turn 通过」**至少 2 次调用**；「合法 JSON 仅被单层围栏
  包裹」按新规则**直接通过**（1 次调用即验规范化——不能同时声称借此验证了格式修复）；
  文件发现+日志分析=**另一验证目标**；
- 历史输出回放已可覆盖格式分支大部分验证（本报告三笔提交全部用回放/本地反例）。

**最小真实补证方案（待批，不自动执行；优先 Claude Code+deepseek-flash）**：
1. **DIRECT 围栏规范化**（1 次）：A 类 fixture，期望输出=合法 TaskComplete 被单层
   \`\`\`json 围栏包裹→程序剥壳过校验 DONE。失败停止：非围栏形态失败即停（回放已覆盖其余形态）。
2. **DIRECT 格式修复全链**（上限 2 次）：首 turn 附加键被拒（或散文）→`task.redispatch
   formatRepair`（输入含原输出+校验错误）→修复 turn 通过。失败停止：修复 turn 仍非法
   即停（BLOCKED 收口为有效观察）。
3. **文件发现+日志分析**（DIRECT 1 次，可选 DELIB 7-9 次）：C 类 fixture，期望模型经
   授权清单定位 `logs/app-week.log` 并产出分析。失败停止：清单在输入中确认存在但模型
   未使用即停（工具面认知差仍存的证据）。
合计上限 4-12 次，**从批次剩余 3 次之外另行申请**（批次授权只用于价值对比）。

## 5. 状态分层

- 已实现+本地已验：上述全部（435/435、e2e 15/15）。
- 真实未验：围栏规范化/修复全链/文件发现（方案见 §4）；resumeSession 续接、restrict*
  拒写（B6 前置）、双任务真实隔离（历轮待批项不变）。
- 待用户：评分包 v2 评价（价值闸门未过、DEV-11 不开放）；§4 补证预算批准与否。
