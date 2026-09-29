# 价值对比评分包 v2（已披露实验背景后的人工可用性评价）

> 第六轮修订：撤回 v1「可靠盲评」表述——材料含模式线索且工程报告已先披露，盲化前提失效。
> 现行口径=**已披露实验背景后的人工可用性评价**：您知道每份材料的模式，请仍按内容质量
> 独立打分（模式本身不是加分项）。材料：materials-v2/*.md（模式明示、不重新编号）。
> 关键词命中数=检索辅助，不冒充事实准确率。

## 样本偏差与不可推断事项（评分前须知）

- A 组 DELIB 侧存在预算执行偏差（实发 10>上限 9，产品缺陷已修）——A 不构成符合预算条件的有效配对；
  B/C 组内条件分别成立（C 组原定日志分析目标两侧均未达成——按「受阻处理」附加维度评）。
- DIRECT 三侧中两侧（A/B）无正式交付：评分材料含被拒的完整原始输出（诊断视角），
  不得视为产品交付成功。
- 三组为小样本受控场景评估（B/C 合成 fixture）；不汇总出「多人优于单人」的一般结论。
- 费用/调用数等工程数字见 per-call-ledger.json（estimated；渠道计费以账单为准）。

## A 组

**共同任务（两模式同文）**：分析 notes.md 的内容要点与可疑之处，形成带依据的结论清单（不超过 8 条）

**原始资料**：fixtures/A/materials/（hash 固化于各侧 manifest；仓库路径 docs/implementation/evidence/value-batch/fixtures/A/materials/）

### A-DIRECT —— [材料](materials-v2/A-DIRECT.md)

| 项 | 值 |
|---|---|
| 调用/上限 | 2/2 |
| 正式交付 | **无（两次输出均被严格 schema 拒绝——outputInvalid）** |
| 任务终态 | ACTIVE |
| est. 费用 | $0.409（estimated） |
| 失败 turn | 2 |

### A-DELIBERATE —— [材料](materials-v2/A-DELIB.md)

| 项 | 值 |
|---|---|
| 调用/上限 | 10/9（**超限**） |
| 正式交付 | 有（最终报告 artifact，整体共识=qualified） |
| 任务终态 | DONE |
| est. 费用 | $2.133（estimated） |
| 失败 turn | 1 |

**A 组评价表**（每份 1–5 分：准确性/完整性/可行动性/依据质量/误报控制；C 组另加受阻处理维度）：

| 材料 | 准确 | 完整 | 可行动 | 依据 | 误报 | 受阻(C) | 一句话理由 |
|---|---|---|---|---|---|---|---|
| A-DIRECT | | | | | | — | |
| A-DELIBERATE | | | | | | — | |

## B 组

**共同任务（两模式同文）**：对比 src-todo/ 下三个实现方案的优缺点，指出各自最可能出错的一处，并给出推荐与理由

**原始资料**：fixtures/B/materials/（hash 固化于各侧 manifest；仓库路径 docs/implementation/evidence/value-batch/fixtures/B/materials/）

### B-DIRECT —— [材料](materials-v2/B-DIRECT.md)

| 项 | 值 |
|---|---|
| 调用/上限 | 2/2 |
| 正式交付 | **无（两次输出均被严格 schema 拒绝——outputInvalid）** |
| 任务终态 | ACTIVE |
| est. 费用 | $0.877（estimated） |
| 失败 turn | 2 |

### B-DELIBERATE —— [材料](materials-v2/B-DELIB.md)

| 项 | 值 |
|---|---|
| 调用/上限 | 7/9 |
| 正式交付 | 有（最终报告 artifact，整体共识=qualified） |
| 任务终态 | DONE |
| est. 费用 | $2.935（estimated） |
| 失败 turn | 0 |

**B 组评价表**（每份 1–5 分：准确性/完整性/可行动性/依据质量/误报控制；C 组另加受阻处理维度）：

| 材料 | 准确 | 完整 | 可行动 | 依据 | 误报 | 受阻(C) | 一句话理由 |
|---|---|---|---|---|---|---|---|
| B-DIRECT | | | | | | — | |
| B-DELIBERATE | | | | | | — | |

## C 组

**共同任务（两模式同文）**：分析 logs/ 一周日志，找出异常模式并按严重度排序，给出需人工确认的清单

**原始资料**：fixtures/C/materials/（hash 固化于各侧 manifest；仓库路径 docs/implementation/evidence/value-batch/fixtures/C/materials/）

### C-DIRECT —— [材料](materials-v2/C-DIRECT.md)

| 项 | 值 |
|---|---|
| 调用/上限 | 2/2 |
| 正式交付 | 有（修复 turn 通过 TaskComplete 校验） |
| 任务终态 | DONE |
| est. 费用 | $0.434（estimated） |
| 失败 turn | 1 |

### C-DELIBERATE —— [材料](materials-v2/C-DELIB.md)

| 项 | 值 |
|---|---|
| 调用/上限 | 7/9 |
| 正式交付 | 有（最终报告 artifact，整体共识=unanimous） |
| 任务终态 | DONE |
| est. 费用 | $1.870（estimated） |
| 失败 turn | 0 |

**C 组评价表**（每份 1–5 分：准确性/完整性/可行动性/依据质量/误报控制；C 组另加受阻处理维度）：

| 材料 | 准确 | 完整 | 可行动 | 依据 | 误报 | 受阻(C) | 一句话理由 |
|---|---|---|---|---|---|---|---|
| C-DIRECT | | | | | |  | |
| C-DELIBERATE | | | | | |  | |

评分完成后：工程审计与身份细节见 reports/round-20260928-value-batch.md（含模式标签与逐调用台账）。
