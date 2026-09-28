/**
 * 价值对比机核评分 + 匿名材料制作（2026-09-28 第五轮；批准批次已授权）。
 *
 * 纪律：
 * - 先固定答案与规则（fixtures/<G>/key.json，已入库），再看输出；
 * - 机核=关键词命中统计：字符串命中≠事实正确——语义项在 key.manualForHuman 列出，待人工判定；
 * - 材料匿名编号（A1/A2、B1/B2、C1/C2）并隐藏模式标签；身份映射只写入
 *   evidence/value-batch/anon-mapping.json（工程审计另存，用户评分后再揭示）；
 * - 不以 unanimous/篇幅/条目数单独判定优劣；小样本受控场景评估，不外推。
 *
 * 用法：
 *   node scripts/value-batch-export.mjs …（先导出两侧 deliverable）
 *   node scripts/value-score.mjs --group A --A1 <side1.txt> --A2 <side2.txt> --mode1 direct --mode2 delib
 *   （A1/A2 编号与模式的真实映射随机化；--modeX 仅写入 anon-mapping，不出现在材料中）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REPO = process.cwd();
const EVID = process.env.ZS_VALUE_EVID ?? join(REPO, 'docs', 'implementation', 'evidence', 'value-batch'); // 彩排可用 env 覆盖（不污染正式匿名材料）

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}
const a = parseArgs(process.argv.slice(2));
const group = (a.group ?? '').toUpperCase();
if (!['A', 'B', 'C'].includes(group)) { console.error('--group 须为 A|B|C'); process.exit(64); }
const key = JSON.parse(readFileSync(join(EVID, 'fixtures', group, 'key.json'), 'utf8'));

// 随机化编号→模式映射（材料不含模式标签；映射另存）。
const flip = Math.random() < 0.5;
const labels = flip ? { side1: `${group}1`, side2: `${group}2` } : { side1: `${group}2`, side2: `${group}1` };
const text1 = readFileSync(a.file1, 'utf8');
const text2 = readFileSync(a.file2, 'utf8');

function score(text) {
  const lower = text.toLowerCase();
  const hits = [];
  const misses = [];
  for (const f of key.findings) {
    const hit = f.any.some((k) => lower.includes(k.toLowerCase()));
    (hit ? hits : misses).push(f.id);
  }
  return { hitCount: hits.length, total: key.findings.length, hits, misses };
}
const s1 = score(text1);
const s2 = score(text2);

mkdirSync(join(EVID, 'anon'), { recursive: true });
writeFileSync(join(EVID, 'anon', `${labels.side1}.md`), text1, 'utf8');
writeFileSync(join(EVID, 'anon', `${labels.side2}.md`), text2, 'utf8');

// 身份映射（工程审计另存——不进 anon 目录）。
let mapping = {};
try { mapping = JSON.parse(readFileSync(join(EVID, 'anon-mapping.json'), 'utf8')); } catch { /* 首组 */ }
mapping[group] = { [labels.side1]: a.mode1, [labels.side2]: a.mode2, flipped: flip, createdAt: Date.now() };
writeFileSync(join(EVID, 'anon-mapping.json'), JSON.stringify(mapping, null, 2), 'utf8');

const result = {
  group,
  machineScores: { [labels.side1]: s1, [labels.side2]: s2 },
  note: '机核=关键词命中（字符串命中≠事实正确）；语义项待人工：' + key.manualForHuman.length + ' 条见 key.json',
  manualForHuman: key.manualForHuman,
  blinded: { labels: [labels.side1, labels.side2], modeHidden: true },
  materials: [join(EVID, 'anon', `${labels.side1}.md`), join(EVID, 'anon', `${labels.side2}.md`)],
  evalId: randomUUID().slice(0, 8),
};
console.log(JSON.stringify(result, null, 2));
