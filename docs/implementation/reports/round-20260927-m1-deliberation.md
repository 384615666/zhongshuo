# M1 正式施工第一轮：四处缺陷收口 → DELIBERATE 编排 → 研讨 UI → 门禁开放（2026-09-27）

> 本轮按用户六节指令执行：先修缺陷（零额度反例）→ 持久化编排 → UI 呈现 →
> 证据齐备后开放 DELIBERATE → 真实演示与价值闸门材料。
> 分层结论：**纯逻辑通过 / 编排集成通过 / UI 通过（fake 12/12）/ 真实研讨（见文末）；
> M1 价值闸门未做结论**（对比材料待补，见第六节）。
> 默认套件 323/323；lint 0；UI e2e fake 12/12。

## 一、四处缺陷收口（全部零额度反例验证）

1. **互评屏障**：屏障以**程序冻结的阶段参与集合**判定；名单成员缺事实=未完成
  （不靠过滤凑收齐）；重复成员事实按最后出现去重；CROSS_REVIEW 预期集合=
  有有效初稿成员（进入阶段时冻结）。反例：空 participants/少一成员/部分完成/
   明确缺席/全员无输入/重复事实（deliberationStage 10 用例）。
   连带修复两处实现 bug：`completed` 状态泄漏（上一阶段完成不等于本阶段终结）。
2. **成果引用与争议身份**：互评/争议引用绑定 (artifactId, artifactRevision,
   claimId) 三元组并校验属冻结可读版本；issueId=含 runId 的稳定散列。反例：
   两成员同名 c1 不混并、同成果两 revision 不串、两 run 同名 claim 不同身份、
   引用未获准版本整份拒绝。schema/模板/持久化同步（非调度器拼字符串）。
3. **RATIFY 幂等与有效性**：同 resultKey 同规范化载荷=重放原回执、异载荷=
   IDEMPOTENCY_CONFLICT（迁移 004 payload_hash）；前置核对运行有效/阶段/turn
   归属 run+成员/当前冻结版本/成员在名单/claim 全覆盖且无重复/conditional 必有
   条件/object·unconfirmed 必有原因；所有更新核对行数（矩阵为空/已关闭/零行
   不计 accepted）；关屏障 pending→missing 不伪造 stance/turn（与模型显式
   unconfirmed 分开）。反例 9 组（deliberationStores）。
4. **成果文件与数据库一致性**：发布协议=临时写→事务 INSERT→rename；同 ID
   同内容幂等、异内容 ARTIFACT_CONFLICT（不可变版本）；DB 失败删临时回滚；
   rename 前中断=行已入库正文缺失（verifyArtifactIntegrity 检出 +
   repairArtifactBody 恢复）；孤儿临时文件与篡改可检出。反例：重复 ID 异正文/
   插入前与改名前中断/篡改 hash 不一致。

## 二、DELIBERATE 持久化编排（deliberationRunner + dispatchWorker 集成）

- **阶段链**：PREPARE（程序：冻结名单+E12 预算 6N+1+C）→ INDEPENDENT →
  CROSS_REVIEW →（有争议）ISSUE_DISCUSSION（第 3 轮 host checkpoint 为独立
  步骤，stop/continue 按证据）→ SYNTHESIS（claims 冻结 clm_N）→ RATIFY
  （矩阵 N×claims，逐结论提交事务）→ PUBLISH（程序：共识聚合+最终报告+交付）。
  无争议直入 SYNTHESIS。
- **派发身份**：每逻辑步骤一条确定性 dispatch_key（阶段/成员/轮次/用途编码）；
  崩溃重领沿用 RT-03 对账（已有 turn 的 key 不再执行、留审计）。
- **输入隔离在服务端组装**：IND 不含他人草稿；CR 只读冻结初稿（正文标注三元组）；
  SYNTHESIS/RATIFY 绑定当前冻结整合稿版本；每步骤 ContextBundle 全文+hash
  落库（PP-04 可核对）。
- **预算贯通（E12）**：派发前核对 stageAvailableTurns（前置 F / SYN S / RAT Q）；
  尾部派发先占保留；结算/未启动取消退款同一账（budget_json 单一真源）；
  耗尽后不再调用模型——讨论截停转整合（budgetSkipped 审计）、全员无产出
  BLOCKED、整合不可得 FAILED（§6.5"耗尽仍交付带异议报告"兜底）。
- **E4 缺席**：按 stage_started_at（迁移 005）假时钟标记 pending→absent，
  不打断在途成员；迟到语义=late 不默认完成。
- **停止**：作用于指定运行（STOPPING→CANCELLED；派发前拦截也收尾取消）；
  迟到完成不复活（RT-06）。
- **输出合同**：schema 校验通过才计入屏障；一次格式修复为限（复用原阶段模板+
  正文修复指令）；再失败=席位 failed（OUTPUT_INVALID 不冒充）。
- 编排集成 9 用例（deliberationFlow 2 + deliberationScenarios 5 + 修复中场景）：
  全链 14 turn 精确用满预算、共识 qualified、交付 DONE；预算耗尽讨论零调用+
  尾部保证+disputed 如实；E4/修复/停止/全员失败 BLOCKED/无争议跳过。
- fake adapter 新增全局脚本序列器（每步骤新会话语义，§6.2 会话隔离）。

## 三、研讨 UI（正式链路）

- 命令面：`run.progress`（阶段/轮次/成员状态/预算/争议，只读）+ `report.get`
  （最终报告+逐结论确认状态）。程序共识以 ratification 记录聚合为准——
  「模型说一致」不当作共识；反对/条件性同意/未确认/缺席在界面均可见。
- renderer：`@全体研讨` 一次性芯片（mentions=[{kind:'all'}]→DELIBERATE 路由）；
  线程视图进度条（成员状态芯片：已产出/缺席/失败）；最终报告渲染
  （逐结论 consensus 芯片+整体共识+分歧清单）。主池保持根消息聚合，
  协作过程归原线程；停止沿用 R1（绑定运行快照）。
- 多成员引导：project.open 可选 agentNames / ZS_BOOTSTRAP_AGENTS（缺省单成员不变）。

## 四、门禁开放（证据后）

依据=第二节 9 项编排集成 + UI 全链路 e2e（@全体→全阶段→DONE→共识报告，
fake sim 12/12 之一）：entry 默认 `enableDeliberate`（ZS_ENABLE_DELIBERATE=0
可关）；worker 级默认仍关（m0Fixes 的 M0 门禁语义不变——该测试继续通过）。

## 五、真实研讨演示与验证分层

- 零额度全场景：完整正常流程 ✓、无争议跳过 ✓、部分缺席 ✓、全员失败 BLOCKED ✓、
  第 3 轮 checkpoint ✓、预算耗尽 ✓、非法输出及有限修复 ✓、重复提交 ✓（store 层）、
  停止 ✓、迟到 ✓（store 层关屏障后拒绝）、重启恢复（编排步骤幂等+outbox 重领对账，
  与既有 RT-03/E7 语义一致）、跨版本确认 ✓（STALE_REVISION）。
- 集成用例覆盖 命令→调度→adapter→成果→屏障→最终报告；renderer 链路 12/12。
- **真实研讨（三次尝试均未在 e2e 窗口内到达终态——如实记录，不冒充通过）**：
  ①600s/max9：超时；②840s/max7：超时——根因查明=真实 turn（含全部初稿正文的互评/
  整合轮）常超 worker 60s 单轮截止 → UNKNOWN → 运行 INTERRUPTED、界面停留"进行中"。
  已修复：entry 单轮截止默认放宽 300s（ZS_TURN_DEADLINE_MS 可调，本次设 420s）；
  pump 对 INTERRUPTED 研讨如实把任务置 BLOCKED（§10.2 不伪造，不再悬挂）。
  ③840s/max7/截止 420s：仍未达终态——7 个串行真实轮（每轮约 1—7 分钟）超出
  e2e 窗口是主要约束（非已知缺陷）。真实预算消耗：三次各 ≤7 调用（合计 ≤21，
  以渠道账单为准）。**真实研讨演示记为 PENDING**：需以非 e2e 方式（长窗观察）
  或进一步调优（更小 N、更短任务、异步等待）完成；零额度链路（12/12）不受影响。

## 六、M1 价值闸门（未做结论，如实）

技术验收（上文分层）≠ 价值闸门。对比材料方案已就绪：同题目、同基线，
研讨（DELIBERATE）vs 单成员（DIRECT）各跑 3—5 个真实任务，记录质量、漏项、
分歧处理、调用数与耗时（events.list+usage_records+budget_json 可直接出数）。
**本轮只消耗了一组真实研讨演示的预算；3—5 组对比任务需另批预算后执行，
材料齐备前不请求业务价值判断，也不宣称多人优于单成员。**

## 七、数字与提交

- `pnpm check` 323/323（+28）；lint 0；UI e2e fake 12/12（含研讨链路）。
- 提交链：缺陷收口 → 编排 → UI+门禁（git log；分支 codex/full-implementation）。
- 遗留（如实）：跨房间切换 UI 场景仍缺建房命令；迟到成员成果并入当前阶段
  （E4 后半段"能进则进"）在编排层未实现（roster 标 late 但不自动并入，
  待 DEV-08 续）；浏览器/LAN 与第二 runtime 属 M2/M3 不在本轮。
