/**
 * 评分包 v2（2026-09-28 第六轮）：撤回「可靠盲评」→ **已披露实验背景后的人工可用性评价**。
 * 自包含：共同任务与资料、正式交付状态、完整原始内容（含被拒字段/围栏——不删任何实质内容，
 * 可读版附转换规则）、简短评价表、样本偏差与不可推断事项。模式标签**明示**（盲化前提已失效：
 * 材料含 qualified/unanimous 等模式线索且工程报告已先披露——不重新编号伪造盲态）。
 * 关键词分数只作检索辅助，不冒充事实准确率。C 组原定目标未达成如实记录。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EVID = join(process.cwd(), 'docs', 'implementation', 'evidence', 'value-batch');
const PACK = join(EVID, 'evidence-pack');
const OUTDIR = join(EVID, 'materials-v2');
mkdirSync(OUTDIR, { recursive: true });

const GROUPS = ['A', 'B', 'C'];
const SIDES = ['direct', 'delib'];
const MODE_LABEL = { direct: 'DIRECT（单成员直接执行）', delib: 'DELIBERATE（两成员研讨）' };
const TASK_TEXT = Object.fromEntries(GROUPS.map((g) => [g, readFileSync(join(EVID, 'fixtures', g, 'task.txt'), 'utf8').trim()]));

function sideMeta(group, side) {
  const manifest = JSON.parse(readFileSync(join(PACK, `${group}-${side}`, 'manifest.json'), 'utf8'));
  const outputs = JSON.parse(readFileSync(join(PACK, `${group}-${side}`, 'outputs.json'), 'utf8'));
  const turns = JSON.parse(readFileSync(join(PACK, `${group}-${side}`, 'turns.json'), 'utf8'));
  const ledgerSide = JSON.parse(readFileSync(join(EVID, 'per-call-ledger.json'), 'utf8')).sides.find((s) => s.group === group && s.side === side);
  const formal = side === 'direct'
    ? (turns.some((t) => t.status === 'SUCCEEDED') ? '有（修复 turn 通过 TaskComplete 校验）' : '**无（两次输出均被严格 schema 拒绝——outputInvalid）**')
    : `有（最终报告 artifact，整体共识=${outputs.finalReport?.payload?.overallConsensus ?? '?'}）`;
  return { manifest, outputs, turns, ledgerSide, formal };
}

let sheet = `# 价值对比评分包 v2（已披露实验背景后的人工可用性评价）\n\n> 第六轮修订：撤回 v1「可靠盲评」表述——材料含模式线索且工程报告已先披露，盲化前提失效。\n> 现行口径=**已披露实验背景后的人工可用性评价**：您知道每份材料的模式，请仍按内容质量\n> 独立打分（模式本身不是加分项）。材料：materials-v2/*.md（模式明示、不重新编号）。\n> 关键词命中数=检索辅助，不冒充事实准确率。\n\n## 样本偏差与不可推断事项（评分前须知）\n\n- A 组 DELIB 侧存在预算执行偏差（实发 10>上限 9，产品缺陷已修）——A 不构成符合预算条件的有效配对；\n  B/C 组内条件分别成立（C 组原定日志分析目标两侧均未达成——按「受阻处理」附加维度评）。\n- DIRECT 三侧中两侧（A/B）无正式交付：评分材料含被拒的完整原始输出（诊断视角），\n  不得视为产品交付成功。\n- 三组为小样本受控场景评估（B/C 合成 fixture）；不汇总出「多人优于单人」的一般结论。\n- 费用/调用数等工程数字见 per-call-ledger.json（estimated；渠道计费以账单为准）。\n\n`;

for (const g of GROUPS) {
  sheet += `## ${g} 组\n\n**共同任务（两模式同文）**：${TASK_TEXT[g]}\n\n`;
  sheet += `**原始资料**：fixtures/${g}/materials/（hash 固化于各侧 manifest；仓库路径 docs/implementation/evidence/value-batch/fixtures/${g}/materials/）\n\n`;
  for (const side of SIDES) {
    const m = sideMeta(g, side);
    const calls = m.ledgerSide.calls;
    const cost = m.turns.reduce((a, t) => a + (t.usage?.cost ?? 0), 0).toFixed(3);
    sheet += `### ${g}-${side === 'direct' ? 'DIRECT' : 'DELIBERATE'} —— [材料](${`materials-v2/${g}-${side.toUpperCase()}.md`})\n\n`;
    sheet += `| 项 | 值 |\n|---|---|\n| 调用/上限 | ${calls}/${m.ledgerSide.sideCap}${m.ledgerSide.sideCapExceeded ? '（**超限**）' : ''} |\n| 正式交付 | ${m.formal} |\n| 任务终态 | ${m.ledgerSide.taskStatus} |\n| est. 费用 | $${cost}（estimated） |\n| 失败 turn | ${m.ledgerSide.failedTurns} |\n\n`;
  }
  sheet += `**${g} 组评价表**（每份 1–5 分：准确性/完整性/可行动性/依据质量/误报控制；C 组另加受阻处理维度）：\n\n| 材料 | 准确 | 完整 | 可行动 | 依据 | 误报 | 受阻(C) | 一句话理由 |\n|---|---|---|---|---|---|---|---|\n| ${g}-DIRECT | | | | | | ${g === 'C' ? '' : '—'} | |\n| ${g}-DELIBERATE | | | | | | ${g === 'C' ? '' : '—'} | |\n\n`;
}
sheet += `评分完成后：工程审计与身份细节见 reports/round-20260928-value-batch.md（含模式标签与逐调用台账）。\n`;
writeFileSync(join(EVID, 'scoring-pack-v2.md'), sheet, 'utf8');

// 每侧材料：产品交付视角 + 原始内容诊断视角（完整原文+可读版+转换规则）。
for (const g of GROUPS) {
  for (const side of SIDES) {
    const m = sideMeta(g, side);
    const L = [`# ${g}-${side === 'direct' ? 'DIRECT' : 'DELIBERATE'} 材料（v2）`, '', `模式：${MODE_LABEL[side]}；任务：${TASK_TEXT[g]}`, '', '## A. 产品交付视角', '', `- 正式交付：${m.formal}`, `- 用户在线程中实际看到的：${m.outputs.agentMessages.length} 条 agent 消息（全文见下）`, `- 校验/预算/失败成本：调用 ${m.ledgerSide.calls}/${m.ledgerSide.sideCap}${m.ledgerSide.sideCapExceeded ? '（超限）' : ''}；失败 turn ${m.ledgerSide.failedTurns} 个`, '', '## B. 原始内容诊断视角（完整保留，含被拒字段/围栏——不构成产品交付）', ''];
    let conversion = null;
    m.outputs.agentMessages.forEach((msg, i) => {
      const raw = msg.body.text ?? '';
      L.push(`### 消息 ${i + 1}（原文，未做任何删改）`, '', '```text', raw, '```', '');
      // 可读版：仅当原文是 JSON（TaskComplete/被拒结构化输出）——转换规则=pretty print，字段不增不删。
      try {
        const parsed = JSON.parse(raw);
        L.push(`（可读版=同一 JSON 的 pretty print，转换规则仅格式化、内容零改动：）`, '', '```json', JSON.stringify(parsed, null, 2), '```', '');
        conversion = 'pretty-print';
      } catch { /* 纯文本原样即人可读 */ }
    });
    if (side === 'delib' && m.outputs.finalReport != null) {
      L.push('### 最终报告（正式交付 artifact，程序矩阵生成）', '', '```json', JSON.stringify(m.outputs.finalReport.payload, null, 2), '```', '');
    }
    if (conversion != null) L.push(`> 转换规则说明：可读版仅 JSON pretty print——被拒绝的字段（如 conclusions）与围栏全部保留在上方原文中，未删除任何实质内容。`);
    if (g === 'C') L.push('', '> **C 组特别说明**：原定「一周日志异常分析」目标未达成（两侧均未读到日志文件——文件名不可发现+工具面受限）。本材料按「受阻处理」附加维度评价。');
    writeFileSync(join(OUTDIR, `${g}-${side.toUpperCase()}.md`), L.join('\n'), 'utf8');
  }
}
console.log(JSON.stringify({ ok: true, sheet: join(EVID, 'scoring-pack-v2.md'), materials: OUTDIR }, null, 2));
