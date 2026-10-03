/**
 * 第三十九轮 §4.1：LibreOffice 替代原型——真实格式样本生成。
 * 样本=合法 OOXML（中文/图片/图表/表格/组合形状/实体字符/跳号页序/备注），供 LO 转换与
 * 自写 SVG 两条路线比对。样本落 dist/desktop/pptx-lo-proto/samples/（原型工作目录）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as craft from '../lib/craftDocuments.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/pptx-lo-proto');
const samplesDir = join(root, 'samples');
mkdirSync(samplesDir, { recursive: true });

const EMU = 9525;
const PNG = craft.makePng(120, 80, [70, 130, 180]);

/** 样本一：丰富版面（中文标题/正文/图片/图表/表格/组合形状/备注）——8 页。 */
const rich = craft.makePptxPagesSample({
  slides: [
    {
      no: 1,
      shapes: [
        { x: 60 * EMU, y: 40 * EMU, cx: 520 * EMU, cy: 90 * EMU, texts: ['众说附件预览替代原型：LibreOffice 路线'] },
        { x: 60 * EMU, y: 150 * EMU, cx: 520 * EMU, cy: 40 * EMU, texts: ['副标题——中文渲染与字体依赖核验页'] },
      ],
      notes: '首页备注：核对中文字形与标题字号。',
    },
    {
      no: 2,
      shapes: [
        { x: 60 * EMU, y: 60 * EMU, cx: 480 * EMU, cy: 300 * EMU, texts: ['图片页：下方为嵌入 PNG（内容寻址副本）'] },
        { x: 80 * EMU, y: 120 * EMU, cx: 240 * EMU, cy: 160 * EMU, kind: 'pic' },
      ],
      image: { name: 'img1.png', ext: 'png', mime: 'image/png', bytes: PNG },
      notes: '图片页备注。',
    },
    {
      no: 3,
      shapes: [
        { x: 60 * EMU, y: 60 * EMU, cx: 480 * EMU, cy: 60 * EMU, texts: ['图表页：柱状图（LO 应渲染图表本体）'] },
        { x: 60 * EMU, y: 130 * EMU, cx: 480 * EMU, cy: 280 * EMU, kind: 'chart' },
      ],
      notes: '图表页备注：自写 SVG 路线此前静默白页的形态。',
    },
    {
      no: 4,
      shapes: [
        { x: 60 * EMU, y: 60 * EMU, cx: 480 * EMU, cy: 60 * EMU, texts: ['表格页'] },
        { x: 60 * EMU, y: 130 * EMU, cx: 480 * EMU, cy: 200 * EMU, kind: 'table', texts: ['列一内容', '列二内容'] },
      ],
    },
    {
      no: 5,
      shapes: [
        { x: 60 * EMU, y: 60 * EMU, cx: 480 * EMU, cy: 60 * EMU, texts: ['组合形状页'] },
        { x: 60 * EMU, y: 130 * EMU, cx: 480 * EMU, cy: 240 * EMU, kind: 'grpSp' },
      ],
    },
    {
      no: 9, // 跳号页序（文件名 slide9.xml——sldIdLst 真实顺序仍为第 6 页）
      shapes: [{ x: 60 * EMU, y: 60 * EMU, cx: 480 * EMU, cy: 60 * EMU, texts: ['第六页（文件名跳号 9）——页序核对'] }],
    },
    {
      no: 10,
      shapes: [{ x: 60 * EMU, y: 60 * EMU, cx: 480 * EMU, cy: 300 * EMU, texts: ['实体字符页：A & B、<标签>、"引号"、中文标点——转换后应与源一致'] , rawText: false }],
    },
    {
      no: 11,
      shapes: [{ x: 60 * EMU, y: 60 * EMU, cx: 480 * EMU, cy: 60 * EMU, texts: ['结束页'] }],
      notes: '尾页备注。',
    },
  ],
});
writeFileSync(join(samplesDir, 'rich-deck.pptx'), rich);

/** 样本二：长文密排（文本密度与分页稳定性）。 */
const dense = craft.makePptxPagesSample({
  slides: Array.from({ length: 6 }, (_, i) => ({
    no: 100 + i,
    shapes: [{ x: 50 * EMU, y: 50 * EMU, cx: 520 * EMU, cy: 360 * EMU, texts: [Array.from({ length: 14 }, (_, j) => `第${i + 1}页 第${j + 1}行：密排中文文本与数字 ${1000 + j * 7}`).join(' ')] }],
    notes: i === 0 ? '密排样本首页备注' : null,
  })),
});
writeFileSync(join(samplesDir, 'dense-deck.pptx'), dense);

console.log('[samples] 2 份样本写入', samplesDir);
