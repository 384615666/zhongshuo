/**
 * 第四十轮·块 D：独立生成器样本——PptxGenJS 表格（「AI 生成文件」是真实用户类型，
 * 不能视为非常规——review-r40 §2.2）。4 页：基本表/中文表头表/填充样式表/长表。
 */
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PptxGenJS = require('./route-a/node_modules/pptxgenjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/preview-select');
const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'W16x9', width: 10, height: 5.625 });
pptx.layout = 'W16x9';

// 第 1 页：基本表格（英文表头——与手造稀疏样本同形态的下限对照）
{
  const s = pptx.addSlide();
  s.addText('PptxGenJS 表格样本 p1/4（基本）', { x: 0.4, y: 0.25, fontSize: 18, bold: true });
  const rows = [
    ['Item', 'Qty', 'Note'],
    ['Widget', '3', 'first'],
    ['Gadget', '5', 'second'],
    ['Doohickey', '2', 'third'],
  ];
  s.addTable(rows, { x: 0.6, y: 1.2, w: 8.5, rowH: 0.4, fontSize: 14, border: { pt: 1, color: '888888' } });
}

// 第 2 页：中文表头+数据（PptxGenJS 默认带显式边框与表头底色）
{
  const s = pptx.addSlide();
  s.addText('PptxGenJS 表格样本 p2/4（中文）', { x: 0.4, y: 0.25, fontSize: 18, bold: true });
  const rows = [
    [{ text: '项目', options: { bold: true, fill: { color: 'DDE7F0' } } }, { text: '数值', options: { bold: true, fill: { color: 'DDE7F0' } } }, { text: '备注', options: { bold: true, fill: { color: 'DDE7F0' } } }],
    ['嵌入图片页', '1', 'PptxGenJS 生成'],
    ['表格页', '4', '本文件'],
    ['图表页', '0', '不在本样本'],
  ];
  s.addTable(rows, { x: 0.6, y: 1.2, w: 8.5, rowH: 0.4, fontSize: 14 });
}

// 第 3 页：显式样式（边框/对齐/列宽）
{
  const s = pptx.addSlide();
  s.addText('PptxGenJS 表格样本 p3/4（样式）', { x: 0.4, y: 0.25, fontSize: 18, bold: true });
  const rows = [
    ['区域', '一季度', '二季度', '合计'],
    ['华东', '182', '245', '427'],
    ['华北', '150', '121', '271'],
  ];
  s.addTable(rows, {
    x: 0.6, y: 1.2, w: 8.5, rowH: 0.42, fontSize: 14, align: 'center', valign: 'middle',
    border: [{ pt: 0 }, { pt: 1, color: '2563EB' }, { pt: 0 }, { pt: 1, color: '2563EB' }],
    fill: { color: 'F5F7FA' },
  });
}

// 第 4 页：长表（10 行——跨页前密度）
{
  const s = pptx.addSlide();
  s.addText('PptxGenJS 表格样本 p4/4（长表）', { x: 0.4, y: 0.25, fontSize: 18, bold: true });
  const rows = [['行号', '说明', '状态']];
  for (let i = 1; i <= 10; i += 1) rows.push([String(i), `第 ${i} 行说明文字（中文混排 row ${i}）`, i % 3 === 0 ? '完成' : '进行中']);
  s.addTable(rows, { x: 0.6, y: 1.0, w: 8.5, rowH: 0.32, fontSize: 12, border: { pt: 1, color: 'AAAAAA' } });
}

await pptx.writeFile({ fileName: join(root, 'samples', 'pptxgenjs-tables.pptx') });
console.log('[generator-samples] OK ->', join(root, 'samples', 'pptxgenjs-tables.pptx'));
