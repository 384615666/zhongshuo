/**
 * 生成真实 PNG fixture（UX-PREVIEW-01，A 阶段）。
 *
 * 为什么需要它：施工说明 §3 要求「可用真实静态文本/图片 fixture 验证读取和显示」，
 * 而预览器要真的解码并显示一张位图，不能用一个 1x1 占位像素糊弄 ——
 * 那样"图片预览可用"就无法被验证（放大、适应窗口、透明背景都测不出来）。
 *
 * 因此这里用 Node zlib 手工编码一张**真实可解码**的 PNG（非第三方库），
 * 带明确可见的结构：渐变底 + 网格 + 两个色块 + 一块半透明区域（验证透明背景可辨）。
 *
 * 用法：node scripts/gen-fixture-png.mjs
 * 输出：把 base64 写进 src/data/resource-fixtures.ts 的 PNG_IMAGE_BASE64。
 * 该脚本只在需要重新生成 fixture 时运行，不参与构建。
 */

import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const W = 320;
const H = 180;

/* ---------- CRC32（PNG 每个 chunk 都要） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/* ---------- 像素 ---------- */
// 8-bit RGBA（color type 6），每行前加一个 filter 字节 0
function render() {
  const raw = Buffer.alloc(H * (1 + W * 4));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const v = y / (H - 1);

      // 对角渐变：蓝 → 青
      let r = Math.round(37 + (16 - 37) * u * 0.7 + 20 * v);
      let g = Math.round(99 + (150 - 99) * u);
      let b = Math.round(235 + (170 - 235) * u * 0.8);
      let a = 255;

      // 网格线（每 32px），浅色
      if (x % 32 === 0 || y % 32 === 0) {
        r = Math.min(255, r + 28);
        g = Math.min(255, g + 28);
        b = Math.min(255, b + 20);
      }

      // 左上白色圆角块（验证实色块渲染）
      if (x > 16 && x < 128 && y > 16 && y < 60) {
        r = 245; g = 247; b = 250;
      }
      // 右下深色块
      if (x > 180 && x < 300 && y > 96 && y < 140) {
        r = 16; g = 24; b = 40;
      }
      // 中部半透明区（alpha=110，验证"透明背景可辨"与棋盘底）
      if (x > 132 && x < 220 && y > 48 && y < 92) {
        r = 255; g = 214; b = 102; a = 110;
      }

      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  return raw;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filter
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(render(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const b64 = png.toString('base64');
writeFileSync('scripts/.fixture-preview.png.base64', b64, 'utf8');

/**
 * 直接生成 TS 模块，而不是让调用方手抄 base64。
 *
 * 这里**不使用模板字符串**包裹：base64 本身不含引号，用普通字符串拼接
 * 可以避免任何转义歧义（早先版本让 shell 生成文件，反引号被 shell 吃掉，
 * 导致 `data:image/png;base64,` 前缀丢失 —— 生成器负责到底更可靠）。
 */
const splitFixed = (s, n) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};
const literal = splitFixed(b64, 92)
  .map((part) => `  '${part}'`)
  .join(' +\n');
const sha = createHash('sha256').update(png).digest('hex');

const module = `/**
 * 真实 PNG fixture 的 base64 数据（由 scripts/gen-fixture-png.mjs 生成）。
 *
 * **不要手工编辑本文件** —— 需要新 fixture 时改生成脚本并重跑：
 *   node scripts/gen-fixture-png.mjs
 *
 * 规格：${W}x${H} RGBA PNG，${png.length} bytes
 * sha256：${sha}
 *
 * 这是**真能解码的位图**（渐变 + 网格 + 实色块 + 半透明区），
 * 用于验证图片预览的适应窗口/原尺寸/透明背景可辨，
 * 而不是用 1x1 占位像素假装图片预览可用。
 */

export const FIXTURE_PNG_WIDTH = ${W};
export const FIXTURE_PNG_HEIGHT = ${H};
export const FIXTURE_PNG_BYTES = ${png.length};
export const FIXTURE_PNG_SHA256 = '${sha}';

export const FIXTURE_PNG_BASE64 =
${literal};

export const FIXTURE_PNG_DATA_URL = 'data:image/png;base64,' + FIXTURE_PNG_BASE64;
`;

writeFileSync('src/data/fixture-png.ts', module, 'utf8');

console.log(`PNG ${W}x${H}, ${png.length} bytes, base64 ${b64.length} chars`);
console.log(`sha256=${sha}`);
console.log('wrote src/data/fixture-png.ts');
