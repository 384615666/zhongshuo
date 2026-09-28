# 价值对比批次执行报告（value-abc-20260928，2026-09-28 第五轮·下）

> **含模式标签（工程审计）——评分者请先完成匿名评分再看本报告。**
> 授权：上限 33（每组 DIRECT≤2 / DELIB≤9），Claude Code 显式 `--model deepseek-flash`。
> 实耗 **30/33**（A-DELIB 超限 1 次系产品预算缺陷，已修复并留证——见 §3）。
> 全部 30 次调用的 usage 响应模型均为 `deepseek-flash`（result/assistant 双源），**无静默回退**；
> 费用一律 estimated（渠道账单为准）。

## 1. 逐侧台账

| 组·侧 | 调用 | turn 终态 | 任务终态 | est. 费用 | 链路核验 | 代码版本 |
|---|---|---|---|---|---|---|
| A·DIRECT | 2/2 | FAILED,FAILED（均 outputInvalid） | ACTIVE（无正式交付） | $0.409 | 全过（校验拒绝=链路正常） | 6064529 |
| A·DELIB | **10/9（超限 1——预算缺陷）** | 9 SUCCEEDED+1 FAILED（IND 格式失败→修复 1） | DONE（qualified 共识报告） | $2.133 | 除预算两条外全过 | 6064529 |
| B·DIRECT | 2/2 | FAILED,FAILED（均 outputInvalid：纯散文） | ACTIVE | $0.877 | 全过 | 915f0db |
| B·DELIB | 7/9 | 7 SUCCEEDED（无争议/无修复） | DONE（unanimous 报告） | $2.935 | 全过 | 915f0db |
| C·DIRECT | 2/2 | FAILED,**SUCCEEDED**（修复后过校验） | **DONE** | $0.434 | 全过 | 915f0db |
| C·DELIB | 7/9 | 7 SUCCEEDED | DONE（unanimous 报告：阻塞如实上报） | $1.870 | 全过 | 915f0db |
| **合计** | **30** | | | **$8.658** | | |

- 每侧 `verify` 检查项：成员绑定=claude/deepseek-flash、响应模型双源、ContextBundle 线程
  归属、预算对账、调用数≤侧上限、产物/最终交付存在、单任务隔离、fixture hash 未被改动
  （只读档下资料零污染）。证据：各侧 `%TEMP%/zhongshuo-value/<组>/<侧>/manifest.json` +
  verify/ledger 输出（batch-ledger.json 已归档至 evidence/value-batch/）。
- 版本与配对：**A 组两側同为 6064529**（配对有效）；**B/C 两側同为 915f0db**（配对有效）；
  A 与 B/C 跨版本（915f0db=预算占用修复，不影响其他链路）——组间比较时注明。

## 2. 主要观察（有效结果，不重跑）

1. **DIRECT 严格输出合同的系统性合规失败（本批最重要发现）**：三次 DIRECT 各出现不同
   失败形态——A：合法 JSON 但附加 `conclusions` 键（严格 schema 拒绝未知键）；B：两次均
   纯 Markdown 散文（非 JSON）；C：JSON 被 \`\`\`json 围栏包裹。C 的修复 turn 为通过校验
   把内容削薄（交付仅 998 字符摘要，完整分析在被拒的首轮）。**机制对照**：DELIB 的分阶段
   payload schema+编排内一次格式修复在同类模型上全部通过（本批 DELIB 17/17 成功 turn 中
   仅 A 组出现 1 次 IND 格式失败且修复即过）——单轮严格合同 vs 阶段化合同+修复的产品
   差异被真实放大。产品改进项（批次后）：DIRECT 合同容错围栏/引导字段（不属本批授权）。
2. **预算超发缺陷（A·DELIB 实发 10>9）与修复**：前置阶段（IND/CR/DIS/修复）派发不设
   占用预留——双成员争议讨论并行领取时各自读到旧账，第 10 个调用漏出。修复=occupyFrontForDispatch
   （`915f0db`）+回归测试；B/C 两轮 DELIB 实发 7≤9 证实修复有效。A 的第 10 次调用如实
   入账（执行偏差记录，不抹除）。
3. **C 组可发现性阻塞（两侧对称）**：日志文件名 `app-week.log` 不可猜；两侧模型自述仅
   有按已知路径读取能力（无目录枚举/Glob）——与 adapter `--allowedTools Read,Glob,Grep`
   的配置存在**认知差**（模型未尝试/未获知 Glob；tool 审计中两側 tool.started 仅 Read）。
   DIRECT 2 次调用即如实阻塞；DELIB 花约 60–90 个候选名探测后 unanimous 上报阻塞（诚实
   但昂贵）。产品改进项：输入合同中明示可用工具面。
4. 争议分支真实出现（A·DELIB DIS×2）——正是预算缺陷的触发场景；修复后 B/C 无争议分支
   （7 次收口）。修复 turn 消耗：A·DELIB 1、C·DIRECT 1，均一次成功。
5. 全批无 UNKNOWN、无截止中断、无停止链路触发；A·DIRECT 两次失败均为 outputInvalid
   （非链路故障）。

## 3. 机核与匿名材料

- 机核（关键词命中，字符串命中≠事实正确）：A1=3/5、A2=5/5、B1=6/7、B2=7/7、C1=2/6、
  C2=2/6（C 为受阻结构项）。语义项（准确性/可行动性/依据质量/误报/受阻处理）列
  `scoring-sheet.md` 待人工。
- 匿名材料：`evidence/value-batch/anon/{A1,A2,B1,B2,C1,C2}.md`（隐藏模式标签）；身份映射
  `anon-mapping.json`（评分后揭示）。评分表：`evidence/value-batch/scoring-sheet.md`。
- 台账：`evidence/value-batch/batch-ledger.json`（逐侧调用/终态/费用/版本）。

## 4. 纪律执行记录

- 成功/失败/修复全部入账（30 次调用含 4 次 FAILED turn）；无探活、无重跑、无额外诊断调用。
- 请求模型=成员绑定 `--model deepseek-flash`（manifest+usage 双证）；费用=CLI estimated。
- 渠道可用，全程无 AUTH/渠道故障；未动用 resume/B6 等未授权项。
- 实验期间未改动运行 checkout（预算修复发生在 A 组后、B/C 前，B/C 全程版本固定）。

## 5. 下一步

- **等待用户匿名评分**（scoring-sheet）→ 揭示映射 → 价值闸门结论（人工评价及基线要求
  未满足前不宣布通过；DEV-11 仍受闸门约束）。
- 批次后工程（不依赖评分）：DIRECT 输出合同容错（围栏/字段引导）设计评审；工具面认知差
  （输入合同明示可用工具）；DEV-12 四项修复（另见 DEV-12 修复报告）。
