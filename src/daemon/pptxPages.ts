/**
 * PPTX 静态页预览（DEV-24 M3，第三十七轮四）：slide XML→SVG 的**受控转换**。
 * 范围（此前确定）：真实幻灯片列表（sldIdLst 顺序）+ 当前页内容 + 缩放（SVG 矢量）；
 * **绑定原件版本**（输入=原件字节与 sha256；输出缓存沿 extracted cache 身份——hash 不符即弃）；
 * **提取文本预览与静态页预览分列**（文本提取仍是 parseWorker 的 slides 通道——本模块不改它）。
 *
 * 受控转换边界（如实，不冒充完整渲染）：
 * - 支持：文本框（a:txBody 段落/字号继承占位）/ 图片（pic→blipFill r:embed→media，base64 内联
 *   到 SVG——单图上限与总量上限）/ 简单形状（sp prstGeom 常见矩形/圆/线条→矩形近似/占位描边）
 *   /占位符文本（p:ph 的 idx/bodyPr 锚点近似）；
 * - 不支持（降级为页面上的「未渲染」标注，不静默丢失）：SmartArt/图表/母版继承主题样式/
 *   渐变/艺术字/动画——静态页预览是**版面近似**，非像素级还原；
 * - 单页 SVG 尺寸上限与页数上限（超限页明确标注 truncated，不静默截断列表）。
 *
 * 输出结构（pptxPages JSON）：{schema, sourceHash, size:{emuW,emuH,pxW,pxH}, slides:[{slide,
 * svg(独立完整 SVG 文档), truncated, shapes, images, notes}] }——缓存键=artifact hash。
 */
import { createHash } from 'node:crypto';

export interface PptxPageSlide {
  slide: number;
  svg: string;
  truncated: boolean;
  shapes: number;
  images: number;
  notes: string;
}
export interface PptxPages {
  schema: 1;
  sourceHash: string;
  pxW: number;
  pxH: number;
  slides: PptxPageSlide[];
}

export const PPTX_PAGES_MAX_SLIDES = 60;
const PAGE_SVG_MAX_CHARS = 220_000; // 单页 SVG 上限（图片 base64 计入）——超限该页截断标注
const IMAGE_MAX_BYTES = 2 * 1024 * 1024; // 单图内联上限
const IMAGES_MAX_TOTAL = 6 * 1024 * 1024; // 全篇图片内联总量
const EMU_PER_PX = 9525;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  emf: 'image/emf', wmf: 'image/wmf',
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z0-9_:]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}
/** XML 文本拼接（a:t）——与 parseWorker 的 xmlTexts 同口径（独立实现避免跨 worker 依赖）。 */
function textsOf(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) out.push(m[1] ?? '');
  return out;
}

interface ShapeBox { x: number; y: number; w: number; h: number }
function boxOf(spXml: string): ShapeBox {
  const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(spXml);
  const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(spXml);
  const x = off != null ? Number(off[1]) : 0;
  const y = off != null ? Number(off[2]) : 0;
  const w = ext != null ? Number(ext[1]) : 0;
  const h = ext != null ? Number(ext[2]) : 0;
  return { x, y, w, h };
}

/**
 * 解析整篇为静态页集合。files=已解包条目；zipGet( name )返回 Uint8Array 或 undefined。
 * 失败（结构缺失/超限）抛 Error——调用方决定缓存语义（不吞成空页）。
 */
export function buildPptxPages(
  files: Record<string, Buffer>,
  zipGet: (name: string) => Buffer | undefined,
  sourceHash: string,
): PptxPages {
  const presXml = Buffer.from(files['ppt/presentation.xml'] ?? Buffer.alloc(0)).toString('utf8');
  if (presXml.length === 0) throw new Error('ppt/presentation.xml 缺失——无法构建静态页预览');
  // 页序（sldIdLst→presentation rels）。
  const presRels: Record<string, string> = {};
  const relsXml = Buffer.from(files['ppt/_rels/presentation.xml.rels'] ?? Buffer.alloc(0)).toString('utf8');
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const a = attrsOf(m[1] ?? '');
    if ((a.Type ?? '').endsWith('/slide') && a.Id != null && a.Target != null) presRels[a.Id] = a.Target;
  }
  const slideParts: Array<{ file: string; rels: string }> = [];
  const sldIdLst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(presXml)?.[1] ?? '';
  for (const m of sldIdLst.matchAll(/<p:sldId\b([^>]*)>/g)) {
    const rid = /r:id="([^"]+)"/.exec(m[1] ?? '')?.[1];
    const target = rid != null ? presRels[rid] : undefined;
    if (target == null) continue;
    const file = 'ppt/' + target.replace(/^\.\//, '').replace(/^\/?ppt\//, '');
    slideParts.push({ file, rels: file.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels' });
  }
  if (slideParts.length === 0) throw new Error('sldIdLst 未引用任何幻灯片');
  if (slideParts.length > PPTX_PAGES_MAX_SLIDES) throw new Error(`幻灯片数 ${slideParts.length} 超静态预览上限 ${PPTX_PAGES_MAX_SLIDES}`);
  // 画布尺寸（presentation sldSz）。
  const sz = /<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/.exec(presXml);
  const emuW = sz != null ? Number(sz[1]) : 12192000;
  const emuH = sz != null ? Number(sz[2]) : 6858000;
  const pxW = Math.round(emuW / EMU_PER_PX);
  const pxH = Math.round(emuH / EMU_PER_PX);

  let imagesTotal = 0;
  const slides: PptxPageSlide[] = [];
  for (let i = 0; i < slideParts.length; i += 1) {
    const part = slideParts[i]!;
    const xml = Buffer.from(files[part.file] ?? Buffer.alloc(0)).toString('utf8');
    if (xml.length === 0) throw new Error(`幻灯片缺失：${part.file}`);
    // 图片/备注关系：rId→zip 绝对路径（相对页文件目录解析——与 parseWorker 的 resolveZipTarget 同口径：
    // slide 在 ppt/slides/，Target ../media/x → ppt/media/x）。
    const resolveFromSlide = (target: string): string => {
      const baseParts = part.file.split('/').slice(0, -1); // ppt/slides
      const t = target.replace(/^\//, '');
      const parts = t.split('/');
      const out = [...baseParts];
      for (const seg of parts) {
        if (seg === '..') out.pop();
        else if (seg !== '.') out.push(seg);
      }
      return out.join('/');
    };
    const relTargets: Record<string, string> = {};
    const rels = Buffer.from(files[part.rels] ?? Buffer.alloc(0)).toString('utf8');
    for (const m of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
      const a = attrsOf(m[1] ?? '');
      if (a.Id != null && a.Target != null) relTargets[a.Id] = resolveFromSlide(a.Target);
    }
    // 备注（沿页关系）。
    let notes = '';
    for (const m of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
      const a = attrsOf(m[1] ?? '');
      if (!(a.Type ?? '').endsWith('/notesSlide') || a.Target == null) continue;
      const nf = resolveFromSlide(a.Target);
      const nxml = Buffer.from(files[nf] ?? Buffer.alloc(0)).toString('utf8');
      notes = textsOf(nxml).join(' ').slice(0, 400);
    }
    const body = /<p:spTree>([\s\S]*?)<\/p:spTree>/.exec(xml)?.[1] ?? '';
    const parts: string[] = [];
    let shapeCount = 0;
    let imageCount = 0;
    let truncated = false;
    // 逐形状（sp=文本/形状，pic=图片）。
    for (const m of body.matchAll(/<(p:sp|p:pic)\b[^>]*\/?>([\s\S]*?)<\/\1>|<(p:sp|p:pic)\b[^>]*\/>/g)) {
      const kind = m[1] ?? m[3];
      const inner = m[2] ?? '';
      if (kind == null) continue;
      shapeCount += 1;
      const box = boxOf(inner);
      const x = Math.round(box.x / EMU_PER_PX);
      const y = Math.round(box.y / EMU_PER_PX);
      const w = Math.max(Math.round(box.w / EMU_PER_PX), 1);
      const h = Math.max(Math.round(box.h / EMU_PER_PX), 1);
      if (kind === 'p:pic') {
        const rid = /r:embed="([^"]+)"/.exec(inner)?.[1];
        const mediaName = rid != null ? relTargets[rid] : undefined;
        const media = mediaName != null ? zipGet(mediaName.replace(/^\/?ppt\//, 'ppt/')) : undefined;
        if (media == null) {
          parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#b45309" stroke-dasharray="4 3"/><text x="${x + 4}" y="${y + 14}" font-size="11" fill="#b45309">图片缺失</text>`);
          continue;
        }
        const ext = (mediaName ?? '').split('.').pop()?.toLowerCase() ?? '';
        const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
        imageCount += 1;
        if (media.byteLength > IMAGE_MAX_BYTES || imagesTotal + media.byteLength > IMAGES_MAX_TOTAL || (mime === 'image/emf' || mime === 'image/wmf')) {
          parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#b45309" stroke-dasharray="4 3"/><text x="${x + 4}" y="${y + 14}" font-size="11" fill="#b45309">图片未内联（超限/格式 ${esc(ext)}）</text>`);
          continue;
        }
        imagesTotal += media.byteLength;
        const b64 = Buffer.from(media).toString('base64');
        parts.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${b64}"/>`);
        continue;
      }
      // p:sp：文本框/形状。
      const texts = textsOf(inner);
      const isPlaceholder = /<p:ph\b/.test(inner);
      const prst = /prstGeom prst="([^"]+)"/.exec(inner)?.[1] ?? 'rect';
      const isLine = prst === 'line' || prst === 'straightConnector1';
      let fill = isPlaceholder ? '#f8fafc' : '#ffffff';
      let stroke = '#cbd5e1';
      parts.push(isLine
        ? `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="#64748b" stroke-width="1.5"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" rx="2"/>`);
      if (texts.length > 0) {
        // 段落分行（a:p 边界）——字号近似（长度自适应），锚点 top-left（bodyPr 锚点近似不还原）。
        const paras: string[] = [];
        for (const pm of inner.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) paras.push(textsOf(pm[1] ?? '').join(''));
        if (paras.length === 0) paras.push(texts.join(' '));
        const fs = paras.length > 8 ? 10 : 13;
        let ty = y + Math.round(fs * 1.4);
        for (const p of paras) {
          if (ty > y + h) { truncated = true; break; }
          parts.push(`<text x="${x + 5}" y="${ty}" font-size="${fs}" fill="#1e293b" font-family="system-ui,'Microsoft YaHei',sans-serif">${esc(p.slice(0, 300))}</text>`);
          ty += Math.round(fs * 1.45);
        }
      }
    }
    const svgBody = parts.join('');
    const header = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${pxW} ${pxH}" width="${pxW}" height="${pxH}">`;
    const footer = '</svg>';
    let svg = `${header}<rect x="0" y="0" width="${pxW}" height="${pxH}" fill="#ffffff"/>${svgBody}${notes.length > 0 ? `<text x="8" y="${pxH - 8}" font-size="10" fill="#94a3b8">备注：${esc(notes.slice(0, 80))}</text>` : ''}${footer}`;
    if (svg.length > PAGE_SVG_MAX_CHARS) {
      // 截断策略：丢弃图片内联（保布局与文本）再试；仍超=整页标注。
      const stripped = svg.replace(/xlink:href="data:[^"]+"/g, 'xlink:href=""');
      if (stripped.length <= PAGE_SVG_MAX_CHARS) {
        svg = stripped.replace(/<image ([^>]*)xlink:href=""([^>]*)\/>/g, '<rect x="0" y="0" width="0" height="0" fill="none"/>');
        truncated = true;
      } else {
        svg = `${header}<rect x="0" y="0" width="${pxW}" height="${pxH}" fill="#fff7ed" stroke="#ea580c"/><text x="16" y="32" font-size="14" fill="#9a3412">该页内容超静态预览上限——未渲染（原文本提取可用）</text>${footer}`;
        truncated = true;
      }
    }
    slides.push({ slide: i + 1, svg, truncated, shapes: shapeCount, images: imageCount, notes });
  }
  return { schema: 1, sourceHash, pxW, pxH, slides };
}

/** 缓存校验（版本绑定）：hash/schema 不符→null（调用方弃缓存重算）。 */
export function validatePptxPagesCache(raw: string | null, sourceHash: string): PptxPages | null {
  if (raw == null || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as PptxPages;
    if (parsed == null || parsed.schema !== 1 || parsed.sourceHash !== sourceHash || !Array.isArray(parsed.slides)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function pptxPagesCacheKey(): string {
  return 'pptx-pages';
}

export function hashOf(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}
