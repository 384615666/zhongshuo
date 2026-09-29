# 第七轮施工报告：OS 退出证据服务端化 · 逻辑输出与预算授权账目 · 文件授权与恢复 UI（2026-09-29）

> **勘误（2026-09-29 第七轮·补）**：本报告原声明「零真实调用」**错误**——`npm run test:e2e` 全量收集了无门禁的 realCodex*.test.ts，本报告所述调试过程中实际发生真实调用（45 会话/55 turn/gpt-6-luna，token in 4,804,122/out 41,921——逐次登记与防复发措施见 round-20260929-isolation-protection-outcome.md §一）。本报告的 451/451、uiE2e 16/16 为 fake 档实测；「realCodex 4/4」与 B6-2 验证为真实调用实测，不应与零调用声明并列。

零真实模型调用（本轮纪律：不新增调用、不动用批次剩余 3 次）。全部验证为本地证据：真实本地子进程取证、故障注入、fake/回放 e2e。测试面：集成/单元 451/451、uiE2e 16/16（含 1 个新恢复面对账反例）、realCodex 4/4、lint 0、tsc 0。

---

## 一、OS 退出证据由正式服务端生成和绑定（主线一）

### 正式入口与状态转换

| 入口 | 行为 | 状态转换 |
|---|---|---|
| `RuntimeAdapter.processIdentity()`（可选能力，契约新增） | adapter 如实上报底层子进程模型：`per-turn`（Claude CLI 每 turn 独立子进程）/ `shared`（Codex App Server 常驻、PID 不专属单 turn）/ `none`（fake 内联，无 OS 遗留进程可能） | — |
| worker `registerProcessIdentity`（DIRECT/DELIB 两处 startTurn 成功后；startTurn 抛错路径也尽力登记） | 写 `runtime_process_registry`（turn 唯一）：PID+OS 启动时刻（3s 短超时查询；不可得=pid-only 如实降级）+模型+成员+run 绑定 | 登记开放 |
| worker 终态收口 `closeProcessRegistrationIfTerminal` | 仅 SUCCEEDED/FAILED/CANCELLED 标 closed | UNKNOWN=崩溃遗留候选，保持开放 |
| `recovery.probeProcess`（新命令，只读） | 按该 turn **已登记身份**做 OS 核对→写 `recovery_exit_probes` 服务端证据记录 | 不改任何状态 |
| `recovery.reconcile`（参数重写） | 退出证据**只能**服务端生成：自动取证，或校验调用方引用的 probeId（turn 归属/登记一致/≤10 分钟新鲜） | 见下 |

reconcile 新参数面（旧 `evidence/exitFact/exitEvidence` 全部删除——调用方自报 `alive=false` 在参数层被拒）：
```
{ turnId, verdict: notStarted|executed|keepUnknown, note（人工依据必填）,
  manualRiskAck?（notStarted 人工风险确认）, probeId?（引用服务端取证） }
```

退出释放矩阵（executed 时按服务端 probe 结果）：

| probe 结果 | 依据 | 租约/准入 | turn 终态 |
|---|---|---|---|
| exited（per-turn） | OS 明确报告该 PID 不存在 | 释放 | FAILED（executed-exited-per-turn） |
| exited（shared） | 共享常驻进程退出——执行载体消失，证据按 shared 标注 | 释放 | FAILED（executed-exited-shared） |
| no-os-process | none 模型=程序事实：无 OS 遗留进程可能 | 释放 | FAILED（executed-no-os-process） |
| alive / unknown / identity-missing / PID 复用 | 不可确认 | **保留** | 保持 UNKNOWN（protection-retained） |

### notStarted 人工分离（指令一.5）

启动窗口崩溃遗留的 UNKNOWN turn **没有程序确认未启动的来源**（确认未启动在 `settleStartupFailure` 当场收口，不遗留 UNKNOWN）。因此 notStarted 对 UNKNOWN turn 一律人工语义：
- 无 `manualRiskAck=true` → 参数层拒绝；
- 人工声明（确认+note 留痕）：预算退款 + turn FAILED（`manual-not-started-risk-ack`），但**租约与准入保留**（存在未收口进程可能时不凭人工解除物理写入保护），事件 `recordedAs=manual-claim`——不伪装为程序已确认事实。

### Windows 查询错误分类修复（指令一.4）

第六轮版 PowerShell catch 对任何错误输出 EXITED——已重写为单行标记协议 + `ErrorVariable` 分类：
- **仅** `ObjectNotFound`（明确的 PID 不存在）→ exited；
- 权限不足（X-ERR:*）、StartTime 读取失败（X-STARTTIME-FAIL——进程在但身份不完整）、空输出（X-EMPTY）、解析失败、查询异常、非法 PID → 全部 unknown（不以查询故障推断退出）；
- 顺带修正了原实现的 epoch 计算缺陷（旧式 `ToUniversalTime() - (Get-Date '1970-01-01')` 含本地时区偏移——改为 `[DateTimeOffset]::ToUnixTimeMilliseconds()`；旧实现两次观测同源自洽但绝对值错误）。

### 每个反例实际经过的生产路径（全部走 `dispatchDaemonCommand` 正式命令链）

`tests/integration/recoveryProcessEvidence.test.ts`（9 用例）：活进程（结算+保护保留）/已退出（释放+准入联动）/身份缺失/PID 复用（篡改登记启动时刻构造 different→unknown 保留）/查询失败（deps.processQuery 注入）/错误 turn probe 引用拒绝/自报 alive=false（旧参数 strictObject 拒绝）/notStarted 人工分离（拒绝+退款+租约保留+manual-claim 事件）/none 模型程序事实释放。`recoveryDev13.test.ts` 保留崩溃快照/DEV-12 联动并适配新语义；同 daemon 联动用例验证「查询不可确认→占位保留；none 程序事实→占位解除→排队任务可派发」。

### 账本一致性

- DB（registry/probes/agent_turns.budget_mark/租约）是事实真源；内存（admission 占位）经 `releaseAdmission` 钩子在 DB 事务成功后同步，失败不回滚持久事实（重启后账本自然为空）——与第六轮同一纪律。
- processQuery 可注入（测试）而生产恒为真实 OS 查询；`checkProcessLiveness` 的 queryFn 注入口与注入故障用例分离标注。

---

## 二、格式修复按逻辑输出限制一次（主线二·指令二）

- **根逻辑输出身份**（迁移 010 重建 `format_repair_workitems`，`UNIQUE(task_id, logical_output_id)` 替代按 source_turn 限次）：初始 DIRECT 输出=该 turn；修复轮**继承**其消费的工作项的 logical_output_id——初始输出与修复尝试共享身份。
- 修复 turn 失败后对它再请求 formatRepair → 解析出根身份已有工作项 → **拒绝**（`不得修复套修复`）：被拒请求不创建工作项、不入 outbox、实际启动计数不变（反例逐项断言，`directRepairContract.test.ts` 重写用例）。
- 用户正式发起的独立输出（普通 redispatch——正式业务来源）有自己的身份与修复资格；不靠生成新 turn ID 绕过（断言新工作项 logical_output_id=新 turn 自身）。
- formatRepair 源 turn 选择豁免 refunded（退款 turn 无逻辑输出，不挡更早有效输出的修复资格）。
- 修复耗尽 BLOCKED 收口不变（`direct-repair-exhausted`），UI 一致。

## 三、预算统一授权账目（主线二·指令三）

- **旧缺陷**：`priorUsed=SUM(各 DIRECT run 的 budget_json.usedTurns)`——修复 run 的快照含播种历史值，多轮后 SUM 重复计算（测试里锁定旧算法得 3、真实消耗 2 的反例）。
- **新口径**：单一真源=**逐 turn 处置事实**（`agent_turns` 行）：计入一切非退款 turn（正常终态无 mark / 对账 settled / UNKNOWN 未收口占位），唯一豁免 `budget_mark='refunded'`（确认未启动退款，额度归还）。不读快照求和、不因新 run 重置、不混入其他任务（按 task_id 过滤）。
- **budget_run_id 真正参与校验**：worker 消费工作项时校验其指向的 run 存在且属于本任务（授权链完整性）；断裂=按损坏阻塞（blocked+BLOCKED+审计，不花调用）。
- **上限强制**：修复轮派发前 `非退款计数+1 > maxTurns` → 工作项 closed（repair-budget-exhausted）+任务 BLOCKED——修复资格不绕过授权上限。
- 两份独立逻辑输出及其修复逐次断言（`budgetGrantAccounting.test.ts`）：每次派发快照、carryover（=非退款计数）、agent_turns 行数（实际启动计数）、授权归属（budget_run_id→run→task）。

## 四、文件清单回到既有授权合同（主线三·指令四）

引用条款：**§13.4** 任务上下文隔离矩阵第 1 行（项目源码/指定基线=当前任务默认可用；跨任务「同项目可分析同一代码」）；**§6.3** 分析基线默认排除（VCS 内部目录、依赖缓存、构建目录、常见凭据文件）；**§13.2**（忽略依赖和构建目录；上限并显示排除项）；**§6.2**（CLI 可能绕过应用接口——清单只声明输入过滤范围，不构成文件沙箱认证）。

规则重写（`projectScopedFileListing` 替代 `taskScopedFileListing`）：
- **不再按 change_sets 归属排除**（旧规则把其他任务 applied 修改过的共享源码永久藏起来，超出基线授权——归属/撤销是溯源维度不是可读性维度；其他任务的对话/摘要/报告按 §13.4 属"否"，但存 DB/appData 不在项目根，天然不进清单；已撤销改动集的 after 文件按项目现状可见）；
- **命名排除清单**（不再按 "." 前缀一刀切）：目录段 .git/.hg/.svn、node_modules/.pnpm-store/bower_components、dist/build/out/target/.next/.nuxt/.turbo/.cache/coverage；凭据文件 .env/.env.*（.example/.template 文档惯例不排）、*.pem、*.key、id_rsa/ed25519/ecdsa（.pub 不排）、credentials.*/secrets.*；.editorconfig/.gitignore 等非凭据配置**可见**；
- **大小写/别名**：段与文件名小写比较（Windows 不敏感）——Node_Modules/BUILD/.ENV 同等排除；
- **上限按过滤后计数**：扫描窗口放大（maxEntries*3+128），排除项不耗尽合法文件名额（旧实现 240 个 node_modules 文件会吃光 200 上限使合法日志不可发现——反例覆盖）；
- 「评分答案在项目外」不再作为通用产品权限保证（integrityNote 只声明输入清单过滤范围）。
- 两模式一致（DIRECT 信封 + DELIB IND 首轮同一函数）；清单入输入信封受 hash 校验（用例断言 envelope.fileDiscovery）。

## 五、恢复 UI 与事实一致（主线三·指令五）

恢复面按四层事实呈现：**程序观测**（进程登记模型/PID/启动时刻/最近取证结果）、**人工说明**（行内输入，note 必填留痕；周期重画按草稿恢复）、**无法确认事项**（身份缺失/未取证/查询不可确认——如实说明原因）、**保留保护**（本 turn 租约数+「人工声明不解除物理保护」的遗留租约行）。
操作精确绑定 turnId：「服务端取证」（只读 probe，结果显示在该行+facts 携带最近取证）、「对账：已执行（按服务端取证收口）」、「人工声明未启动（退款·保留租约）」（需说明+风险确认 confirm）、「维持不确定」。「确认未启动」不再是绕过进程核对的一键释放入口。alert 改为行内错误行（无人工处理时对话框会冻结页面——e2e 实测教训）。

**renderer e2e 反例**（`uiE2e.test.ts` 新用例，真实 Electron+崩溃重启链）：
1. 无登记 turn：取证显示 identity-missing（服务端无法确认+原因）→ 人工声明（confirm 桩+note）→ 该 turn 收口（行消失）但**保护仍在**——「遗留保护：turn … 的写入租约仍持有（人工声明不解除物理保护）」如实显示；
2. 有登记（none）：取证 no-os-process（服务端核对完成）→ 已执行对账 → 按条件收口（行消失）；
3. 已执行但服务端无法确认（identity-missing）：结算但**行仍在面板**（不提前收口）+ facts 显示「保留保护」——界面如实说明原因。

## 六、仍未覆盖的真实 runtime 能力（如实）

- **真实 Claude/Codex 崩溃现场的进程登记与取证**：登记/取证/对账全链已接线并有本地真实子进程+故障注入覆盖，但「真实 CLI 子进程崩溃→daemon 重启→probe exited→释放」的端到端真实样本未跑（属历轮待批真实认证；本轮零调用纪律）。
- **PID 复用的自然发生样本**：复用检测逻辑有构造反例（篡改登记启动时刻），自然复用需长时间观测。
- **Codex App Server（shared 模型）的退出证据**：shared-exited 释放路径逻辑已实现，真实 App Server 崩溃场景未跑。
- **文件发现的真实有效性**（C 组遗留）：新授权清单进入输入信封，模型能否据此定位文件仍待真实补证（报告 round-20260928-recovery-repair-final.md §4 方案仍有效——待用户批准另批预算）。
- realCodex B6-2 在本轮一次全量连跑中偶发失败（outcome=success：真实渠道计划档行为漂移），单跑与全文件复跑均通过（改动前后代码均验证）——既有真实认证的偶发敏感性，非本轮回归；不因此增加真实调用。

## 七、总账口径更新（用户指令）

- **价值评分状态改为「用户决定暂缓，待恢复与修复链稳定后再安排」**——不再每轮列为需要用户立即处理的阻塞项；集中安排一次价值评价的时点=恢复与修复链稳定、具备可操作用户体验之后。
- 实验原始证据、评分包 v2 与已知偏差全部保留（不为等待评分重跑/改动实验）。
- **价值闸门仍未通过，DEV-11 保持未开放**。
- 旧批次剩余 3 次保留不自动转作他用；后续确需补证时先列明确目标/次数上限/停止条件，优先 Claude Code + deepseek-flash。
