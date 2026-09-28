# M1 收口轮：真实研讨可观察闭环 + 缺席/迟到/恢复/预算核实（2026-09-28）

> 本轮不宣布"M1 全部完成"：**真实研讨已到达可解释终态并通过逐项审计（29/29）**；
> 分歧/缺席/迟到的分支以受控用例证明（真实补证按需另排）；价值闸门材料方案就绪未执行。

## 一、三次历史真实尝试的取证（不再盲目重跑）

背景事实：三次尝试的 fixture 均被 e2e teardown 清理；**幸存的 WAL 文件（taskkill 后未检查点）
经表恢复失败，改为字符串级取证**。已修掉"失败即销毁证据"（uiE2e 真实用例失败保留目录）。

| 尝试 | 时间 | 已核实事实（WAL 字符串） | 结束原因 |
|---|---|---|---|
| 1 | 09-27 23:02 | run.prepared→INDEPENDENT；**1 个 IND turn 派发**；出现 `code:INTERRUPTED` | 60s 单轮截止中断被**误判为用户停止**→run/task CANCELLED（缺陷，本轮已修） |
| 2 | 09-27 23:13 | 同上：1 个 IND turn，INTERRUPTED | 同上（当时截止仍 60s） |
| 3 | 09-27 23:28 | **两名成员 IND turn 均真实派发**；双双 `CODEX_ERROR`（错误正文未入审计——当时审计只记 code，已补 message 字段） | adapter 侧错误，根因正文无法事后核实（如实记录） |

已知数：三次各自真实派发 turn 数 = 1 / 1 / 2（来自 WAL turn 行）；**无法核实部分**：每 turn
是否完成模型计费、渠道侧精确消耗（以账单为准）。此前"各≤7"为上界推断，不再引用。

## 二、长时间调度与 E4（零额度收口，默认套件 331/331）

- **时钟注入**：DispatchWorker `clock` 可注入；runOnce 在领取/泵判定时点取当前时间，
  drain 循环不复用进入时的 now；假时钟测试与生产同一代码路径（租约断言用例）。
- **缺席语义**：删除按 stage_started_at 批量标记 pending 的逻辑（**排队≠缺席**）；
  缺席只来自成员自己的执行事实：单轮截止中断 / UNKNOWN → **成员级 absent，run 继续**
  （修复取证发现的"中断误判用户停止→杀 run"缺陷：以 stop_generation/STOPPING 判用户停止）；
  UNKNOWN 研讨轮同样成员级缺席；全员无产出才 BLOCKED。
- **迟到后半段**：onStepOutput 守卫（运行终结/任务停止/旧 run 键 → 只留迟到材料，
  不计数不复活）；未冻结时到达 → absent→late 纳入后续组装（后续 SYNTHESIS 可见）；
  发布后到达 → 只展示（报告更新须走新运行）。三分支各有反例用例。
- **运行/版本身份**：dispatchKey 携带 runId——**新运行不复用旧运行派发键**；pump/派发/预算
  绑定最新非终态 run；终态后再提交=新 run（roster_revision+1，承接新证据语义）；旧 run 遗留
  步骤被领取即完结、零模型调用。RATIFY 屏障收口改确定性判定（无在途/无待派/席位终结→missing）。
- ContextBundle 改存研讨输入**全文**（hash=sha256(text) 可复核，PP-04）。

## 三、提交-观察分离（harness）

`scripts/real-delib.mjs submit|observe|stop|status`：一次提交（renderer 真实操作链）保存
manifest（taskId/pid/配置/预算声明）；observe 只读（run.progress/report.get），退出≠失败；
stop 按停止规则收尾。实例与 manifest 在 %TEMP%/zhongshuo-m1-real 跨观察持久。
本轮实际使用：submit 后 taskId 采集段崩溃（已定位 harness 字符串注入 bug），app 未死、
任务已提交——**按"已有运行仍有效则只读核对、不重开"处理**，手工补 manifest 后纯观察至终态。

## 四、一组小型真实研讨（完成，gpt-6-luna，两名成员）

预算（提交前声明）：上限 9=正常 7（IND2+CR2+SYN1+RAT2）+修复余量 2；尾部 S=1/Q=2；
单轮截止 420s；整体窗 45min。**实际消耗 7/9（零修复、无争议跳过讨论）**，usage_records
7 turn 与预算账一致。

过程（manifest+只读观察）：提交（renderer 点击 @全体研讨）→ IND 甲/乙完成（2/9）→
CR 完成（4/9）→ 无争议 → SYNTHESIS（5/9）→ RATIFY×2（7/9）→ PUBLISH，任务 DONE。

真实结论摘录（fixture=迁移备忘录）：整合稿 5 条结论全部围绕"记录缺少独立佐证"（旧机下线/
备份未校验/证书续期无日志佐证/夜间日志空窗成因不明/整体待核实）——**两条独立分析+互评后
形成的怀疑性共识，非模型套话**；10/10 确认格 submitted/confirm → unanimous（无争议任务
验证了无争议分支，未人为制造分歧）。

**逐项审计（scripts/real-delib-audit.mjs，29/29 全过）**：
IND 隔离（每成员 IND 全文不含对方草稿语句）✓；互评三元组全部解析到本 run 冻结草稿 ✓；
RAT 输入绑定冻结稿 clm_* ✓；报告共识==ratification 矩阵重算聚合 ✓（unanimous）；
ContextBundle hash==sha256(全文) ✓；artifacts 磁盘 hash==DB ✓；预算 usedTurns==终态 turn 数 ✓；
阶段计数 IND2/CR2/SYN1/RAT2 ✓。UI 链：提交与观察均经真实 renderer（zs.command 页面上下文）；
进度/报告 DOM 渲染断言由 fake e2e 覆盖（真实 DOM 截图受 RDP 合成器限制，如实记录）。

## 五、能力状态分层（门禁=能力合同）

| 能力 | 状态 |
|---|---|
| DELIBERATE 代码 | 已实现（全阶段链/预算/E4/迟到/停止/恢复） |
| fake 集成 + 协议回放 + 存储 + UI | **已验证**（331/331；UI e2e fake 13 用例） |
| 真实研讨 | **已验证一组**（本报告四节；分歧/缺席/迟到分支为受控用例证明，真实补证按需另排） |
| M1 价值闸门 | **未做结论**（对比材料未执行） |

门禁：`ZS_ENABLE_DELIBERATE=1` 显式 opt-in（真实闭环已有一组证据；默认开放待分歧/缺席
真实补证或用户确认后切换）。

## 六、价值闸门（未执行，方案就绪）

3—5 组同题同基线 DELIBERATE vs DIRECT 对比：任务清单、评判标准（事实准确性/漏项/分歧处理/
调用量/耗时）与总预算待列明后**请求预算批准**再执行；不预设研讨优于单成员。价值闸门未通过前
不开放受其约束的自动分工（DEV-11）；不影响其他独立工程工作。

## 补记（2026-09-28 下午：审计 v2 + E4/冻结收口）

**证据强度修正（WAL 取证）**：三次历史尝试的取证依据为 WAL 字符串片段——可支持
"存在某 turn/事件"的观察事实；**未恢复完整数据库与提交状态前，不据此证明完整派发总数
或精确计费**（"1/1/2"为提取到的 turn 记录数，渠道侧以账单为准）。根因不再猜测。

**真实运行数据保全与恢复**：taskkill 后主库未检查点（WAL 2MB、主文件空）——手工按
WAL 帧重放重建独立 DB（492 帧全部为提交帧； rebuilt3.sqlite 留档于
%TEMP%/zs-recover/）。经验：强杀收尾应先优雅 stop（harness stop 已是；本轮收尾用了
taskkill——已记入 harness 改进项：stop 优先 UI task.stop）。

**审计 v2（显式定位+存在性断言+强化核对，零新额度）**：对既有真实运行（36c19de 代码）
显式指定 task/run 复跑：**56/58**。唯二失败=CR/RAT 冻结清单不存在——清单机制在该
运行之后才实现（属预期 N/A，非数据缺陷）。v1 的"29/29"范围=hash/三元组/共识重算/预算；
v2 新增=存在性断言（防空循环假通过）、IND 源白名单（artifactId/claim 正文/summary
三重不包含）、CR 清单绑定（id@rev#hash）、RAT 精确三元组+hash 前缀、预算==事件账
（stepArtifact/usage/迟到）。

**E4 执行语义与冻结边界（同日收口，默认 339/339）**：
- absenceGrace 按成员**在途 turn 有效执行时间**（迁移 006：exec_started_at/exec_paused_ms；
  审批/等待暂停扣除）判定，到期标记缺席并推进屏障、**不强杀**在途成员（后续完成走迟到
  路径）；与单轮 turnDeadline（中断分支）分离；排队成员永不记执行超时（只记
  dispatchWait 观察线诊断）；两截止同发=单一结局无双标记；崩溃重启时钟保留、
  INTERRUPTED 如实 BLOCKED、RT-03 不重派。
- **未完成（如实）**：并行执行下"执行中成员缺席推进"的调度观测（M1 串行架构中泵在
  turn 间运行，机制与测试已备，生产观测需 M2 并行调度）；审批暂停的**事件接线**
  （accumulateApprovalPause 就绪，M1 研讨路径无审批桥，语义以测试锁定）。
- 输入冻结清单（daemon_state manifest：entries=artifactId@revision#hash+总 hash）：
  CR 阶段进入时冻结初稿集合——迟到初稿不改任何同轮成员材料；SYNTHESIS 进入时新版本
  （含迟到稿）；RATIFY 绑定精确整合稿三元组（frozenSynthesisOf，不凭 clm 名/文本片段）；
  迟到经真实 adapter 事件路径集成验证（非仅直调 onStepOutput）。

## 七、遗留与下一步

- 真实补证（按需、小额）：一组带真实分歧的任务（两位模型立场不同）验证讨论轮+checkpoint
  真实路径；一组真实迟到/缺席观察。
- harness submit 的 taskId 采集段字符串注入 bug 已修复（路径经 JSON 注入转义，SYNTAX-OK）。

- 价值闸门对比执行（待预算）→ M1 收口判断。
