/**
 * PPTX 静态预览：完整页列表和受控 SVG 在可终止 worker 内生成。
 * R120 不按页数、文本、图片或 JSON/SVG 字节数丢弃内容；保留画布数值、
 * SVG 元素/属性/URL 白名单及结构校验。图表、表格、组合等不支持对象显式占位。
 * 转换器版本绑定缓存，旧容量截断产物不得命中。
 */
import { createHash } from 'node:crypto';

export interface PptxPageSlide {
  slide: number;
  svg: string;
  /** 页级布局截断（文字超出原形状高度）。 */
  truncated: boolean;
  /** 保留兼容字段；完整文本不按字节截断。 */
  textTruncated: boolean;
  shapes: number;
  images: number;
  /** 未渲染对象数（图表/表格/SmartArt/组合——显式标注不静默）。 */
  unsupported: number;
  unsupportedKinds: string;
  notes: string;
  notesTruncated: boolean;
}
export interface PptxPages {
  schema: 2;
  /** 转换器版本（变更=旧缓存全量作废——与 parseContracts 的 parserVersion 同口径）。 */
  converterVersion: string;
  sourceHash: string;
  pxW: number;
  pxH: number;
  slides: PptxPageSlide[];
}

export const PPTX_PAGES_CONVERTER_VERSION = 'pptx-pages-v3';
const EMU_PER_PX = 9525;
/** 画布像素界（异常 sldSz 拒绝——防 0/负/超界画布进 SVG viewBox）。 */
const PX_BOUNDS = { min: 320, max: 8192 };

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  emf: 'image/emf', wmf: 'image/wmf',
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** XML 实体解码（第三十八轮：a:t 文本是 XML 转义形态——先解码成真实字符，再由 esc() 安全
 * 输出；此前直接 esc() 未解码=双重转义，正文 A &amp; B 显示成 A &amp;amp; B）。数字字符引用
 * 一并处理（含十六进制）；未知/残缺实体保持原样（不虚构）。 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => {
      const cp = Number.parseInt(h, 16);
      return Number.isFinite(cp) && cp >= 0x20 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      const cp = Number(d);
      return Number.isFinite(cp) && cp >= 0x20 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // amp 最后：&amp;lt; → &lt;（一次解码，不迭代）
}


function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 属性名含连字符（font-size/stroke-width 等）——字符类必须含 '-'，否则 'font-size' 会被
  // 拆成 'size'（第三十八轮实证：白名单误报非白名单属性）。
  for (const m of tag.matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}
/** XML 文本拼接（a:t）——**解码实体**后输出（独立实现避免跨 worker 依赖）。 */
function textsOf(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) out.push(decodeXmlEntities(m[1] ?? ''));
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

/** 未渲染对象占位（图表/表格/SmartArt/组合——显式标注，不静默白页）。 */
function unsupportedBox(box: ShapeBox, kindLabel: string): string {
  const x = Math.round(box.x / EMU_PER_PX);
  const y = Math.round(box.y / EMU_PER_PX);
  const w = Math.max(Math.round(box.w / EMU_PER_PX), 24);
  const h = Math.max(Math.round(box.h / EMU_PER_PX), 18);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="4 3" rx="2"/><text x="${x + 4}" y="${y + 14}" font-size="11" fill="#475569">${esc(`${kindLabel}（静态页不渲染）`)}</text>`;
}

/**
 * 解析整篇为静态页集合。files=已解包条目；zipGet(name)返回 Buffer 或 undefined。
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
    if (target == null) throw new Error('sldIdLst 引用的幻灯片关系缺失');
    const file = 'ppt/' + target.replace(/^\.\//, '').replace(/^\/?ppt\//, '');
    slideParts.push({ file, rels: file.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels' });
  }
  if (slideParts.length === 0) throw new Error('sldIdLst 未引用任何幻灯片');
  // 画布尺寸（presentation sldSz）——异常值拒绝（不进 viewBox）。
  const sz = /<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/.exec(presXml);
  const emuW = sz != null ? Number(sz[1]) : 12192000;
  const emuH = sz != null ? Number(sz[2]) : 6858000;
  const pxW = Math.round(emuW / EMU_PER_PX);
  const pxH = Math.round(emuH / EMU_PER_PX);
  if (!Number.isFinite(pxW) || !Number.isFinite(pxH) || pxW < PX_BOUNDS.min || pxW > PX_BOUNDS.max || pxH < PX_BOUNDS.min || pxH > PX_BOUNDS.max) {
    throw new Error(`画布尺寸异常（${pxW}x${pxH}px）——拒绝构建静态页预览`);
  }

  const slides: PptxPageSlide[] = [];
  for (let i = 0; i < slideParts.length; i += 1) {
    const part = slideParts[i]!;
    const xml = Buffer.from(files[part.file] ?? Buffer.alloc(0)).toString('utf8');
    if (xml.length === 0) throw new Error(`幻灯片缺失：${part.file}`);
    const resolveFromSlide = (target: string): string => {
      const baseParts = part.file.split('/').slice(0, -1);
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
    // 备注沿页关系读取完整文本。
    let notes = '';
    const notesTruncated = false;
    for (const m of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
      const a = attrsOf(m[1] ?? '');
      if (!(a.Type ?? '').endsWith('/notesSlide') || a.Target == null) continue;
      const nf = resolveFromSlide(a.Target);
      const nxml = Buffer.from(files[nf] ?? Buffer.alloc(0)).toString('utf8');
      notes = textsOf(nxml).join(' ');
    }
    const body = /<p:spTree>([\s\S]*?)<\/p:spTree>/.exec(xml)?.[1] ?? '';
    const parts: string[] = [];
    let shapeCount = 0;
    let imageCount = 0;
    let truncated = false;
    const textTruncated = false;
    const unsupportedKinds = new Map<string, number>();
    const noteUnsupported = (k: string): void => { unsupportedKinds.set(k, (unsupportedKinds.get(k) ?? 0) + 1); };
    // 逐形状（sp=文本/形状，pic=图片，graphicFrame=图表/表格，grpSp=组合——后两者显式标注）。
    const elementRe = /<(p:sp|p:pic|p:graphicFrame|p:grpSp)\b[^>]*\/?>([\s\S]*?)<\/\1>|<(p:sp|p:pic|p:graphicFrame|p:grpSp)\b[^>]*\/>/g;
    for (const m of body.matchAll(elementRe)) {
      const kind = m[1] ?? m[3];
      const inner = m[2] ?? '';
      if (kind == null) continue;
      const box = boxOf(inner);
      if (kind === 'p:graphicFrame') {
        // 图表（c:chart/gr:graphic）或表格（a:tbl）——不渲染但显式占位（第三十八轮：
        // 此前不遍历 graphicFrame，纯图表页 shapes=0 输出空白=静默白页）。
        const isTable = /<a:tbl[\s>]/.test(inner);
        const label = isTable ? '表格' : '图表';
        noteUnsupported(label);
        parts.push(unsupportedBox(box, label));
        continue;
      }
      if (kind === 'p:grpSp') {
        noteUnsupported('组合形状');
        parts.push(unsupportedBox(box, '组合形状'));
        continue;
      }
      shapeCount += 1;
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
        if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(mime)) {
          parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#b45309" stroke-dasharray="4 3"/><text x="${x + 4}" y="${y + 14}" font-size="11" fill="#b45309">图片未内联（格式 ${esc(ext)}）</text>`);
          continue;
        }
        const b64 = Buffer.from(media).toString('base64');
        parts.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${b64}"/>`);
        continue;
      }
      // p:sp：文本框/形状。
      const texts = textsOf(inner);
      const isPlaceholder = /<p:ph\b/.test(inner);
      const prst = /prstGeom prst="([^"]+)"/.exec(inner)?.[1] ?? 'rect';
      const isLine = prst === 'line' || prst === 'straightConnector1';
      const fill = isPlaceholder ? '#f8fafc' : '#ffffff';
      const stroke = '#cbd5e1';
      parts.push(isLine
        ? `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="#64748b" stroke-width="1.5"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" rx="2"/>`);
      if (texts.length > 0) {
        // 段落分行（a:p 边界）——字号近似（长度自适应），锚点 top-left。
        const paras: string[] = [];
        for (const pm of inner.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) paras.push(textsOf(pm[1] ?? '').join(''));
        if (paras.length === 0) paras.push(texts.join(' '));
        const fs = paras.length > 8 ? 10 : 13;
        let ty = y + Math.round(fs * 1.4);
        for (const p of paras) {
          if (ty > y + h) { truncated = true; break; }
          parts.push(`<text x="${x + 5}" y="${ty}" font-size="${fs}" fill="#1e293b" font-family="system-ui,'Microsoft YaHei',sans-serif">${esc(p)}</text>`);
          ty += Math.round(fs * 1.45);
        }
      }
    }
    // SmartArt（mc:AlternateContent 包裹的 diagram）——正文内联标注。
    const smartArt = (body.match(/<dgm:relIds\b/g) ?? []).length;
    if (smartArt > 0) {
      noteUnsupported('SmartArt');
      parts.push(unsupportedBox({ x: 40 * EMU_PER_PX, y: (pxH - 90) * EMU_PER_PX, w: 300 * EMU_PER_PX, h: 60 * EMU_PER_PX }, `SmartArt ×${smartArt}`));
    }
    const unsupportedCount = [...unsupportedKinds.values()].reduce((a, b) => a + b, 0);
    const svgBody = parts.join('');
    const header = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${pxW} ${pxH}" width="${pxW}" height="${pxH}">`;
    const footer = '</svg>';
    const notesLine = notes.length > 0
      ? `<text x="8" y="${pxH - 8}" font-size="10" fill="#94a3b8">备注：${esc(notes)}${notesTruncated ? '…（截断）' : ''}</text>`
      : '';
    const svg = `${header}<rect x="0" y="0" width="${pxW}" height="${pxH}" fill="#ffffff"/>${svgBody}${notesLine}${footer}`;
    // 构建产物必须通过白名单校验（自检——违规即 bug，不进缓存）。
    const wellFormed = svgWellFormed(svg);
    if (!wellFormed.ok) throw new Error(`构建产物未过 SVG 白名单（${wellFormed.reason}）——转换器缺陷，拒绝输出`);
    slides.push({
      slide: i + 1, svg, truncated, textTruncated,
      shapes: shapeCount, images: imageCount,
      unsupported: unsupportedCount,
      unsupportedKinds: [...unsupportedKinds.entries()].map(([k, n]) => `${k}×${n}`).join('、'),
      notes, notesTruncated,
    });
  }
  return { schema: 2, converterVersion: PPTX_PAGES_CONVERTER_VERSION, sourceHash, pxW, pxH, slides };
}

// ---------- SVG 白名单（入 DOM 前的受控边界——缓存校验与构建自检共用） ----------
const SVG_ALLOWED_ELEMENTS = new Set(['svg', 'rect', 'text', 'image', 'line']);
const SVG_ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  svg: new Set(['viewBox', 'width', 'height', 'xmlns', 'xmlns:xlink']),
  rect: new Set(['x', 'y', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'rx']),
  text: new Set(['x', 'y', 'font-size', 'fill', 'font-family']),
  image: new Set(['x', 'y', 'width', 'height', 'preserveAspectRatio', 'xlink:href']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
};
const SVG_COLOR_RE = /^(#[0-9a-fA-F]{6}|none)$/;
const SVG_FONT_FAMILY_WHITELIST = new Set(["system-ui,'Microsoft YaHei',sans-serif"]);

/** SVG 结构白名单校验：只允许白名单元素/属性/取值域（data:image/ base64 URL、十六进制颜色、
 * 白名单字体族、有界数值）。任何越界（foreignObject/onclick/javascript:/超界数）→不通过。
 * 缓存命中路径用它拦截被注入/损坏的缓存（第三十八轮：异常缓存曾通过弱校验直达 innerHTML）。 */
export function svgWellFormed(svg: string): { ok: true } | { ok: false; reason: string } {
  if (typeof svg !== 'string' || svg.length === 0) return { ok: false, reason: '空 SVG' };
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:]*)((?:[^>"']|"[^"]*")*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let depth = 0;
  let sawRoot = false;
  while ((m = tagRe.exec(svg)) !== null) {
    const close = m[1]!;
    const name = m[2]!;
    const attrText = m[3] ?? '';
    const selfClose = m[4] != null && m[4].length > 0;
    if (!SVG_ALLOWED_ELEMENTS.has(name)) return { ok: false, reason: `非白名单元素 <${name}>` };
    if (close) depth -= 1;
    else {
      if (name === 'svg') sawRoot = true;
      if (!selfClose) depth += 1; // 自闭合标签无配对深度
    }
    if (depth < 0) return { ok: false, reason: '闭合标签失配' };
    if (close) continue;
    const allowed = SVG_ALLOWED_ATTRS[name]!;
    for (const am of (attrText ?? '').matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) {
      const [attr, value] = [am[1]!, am[2]!];
      if (attr.startsWith('on') || attr.toLowerCase().startsWith('on')) return { ok: false, reason: `事件属性 ${attr}` };
      if (!allowed.has(attr)) return { ok: false, reason: `<${name}> 非白名单属性 ${attr}` };
      if (attr === 'xlink:href') {
        if (!/^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(value)) return { ok: false, reason: 'image href 非受控 data:image base64' };
      } else if (attr === 'fill' || attr === 'stroke') {
        if (!SVG_COLOR_RE.test(value)) return { ok: false, reason: `颜色取值越界 ${attr}=${value.slice(0, 20)}` };
      } else if (attr === 'font-family') {
        if (!SVG_FONT_FAMILY_WHITELIST.has(value)) return { ok: false, reason: 'font-family 不在白名单' };
      } else if (attr === 'xmlns' || attr === 'xmlns:xlink') {
        if (value !== 'http://www.w3.org/2000/svg' && value !== 'http://www.w3.org/1999/xlink') return { ok: false, reason: `命名空间越界 ${value.slice(0, 40)}` };
      } else if (attr === 'preserveAspectRatio') {
        if (value !== 'none') return { ok: false, reason: `preserveAspectRatio 取值越界 ${value.slice(0, 20)}` };
      } else if (attr === 'viewBox') {
        if (!/^0 0 \d{3,4} \d{3,4}$/.test(value)) return { ok: false, reason: `viewBox 取值越界 ${value.slice(0, 30)}` };
      } else if (attr === 'stroke-dasharray') {
        if (!/^(\d+\s*\d*\s*)+$/.test(value)) return { ok: false, reason: 'stroke-dasharray 取值越界' };
      } else if (attr === 'rx' || attr === 'stroke-width' || attr === 'font-size') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 500) return { ok: false, reason: `${attr} 取值越界 ${value.slice(0, 12)}` };
      } else {
        // 几何数值属性：有界（防超大/负数画布外溢出与 NaN）。
        const n = Number(value);
        if (!Number.isFinite(n) || n < -100_000 || n > 100_000) return { ok: false, reason: `${attr} 取值越界 ${value.slice(0, 12)}` };
      }
    }
    // 属性文本里不该再出现裸引号外的危险残留（事件/样式）。
    if (/(on[a-zA-Z]+\s*=|style\s*=|javascript:)/i.test(attrText ?? '')) return { ok: false, reason: '属性区含事件/样式/脚本残留' };
  }
  if (!sawRoot || depth !== 0) return { ok: false, reason: 'SVG 根/配对不完整' };
  // 标签外文本：不允许裸 <（已由结构覆盖）与控制字符。
  const textOutside = svg.replace(tagRe, '');
  if (/<[\s\S]*?>/.test(textOutside) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(textOutside)) return { ok: false, reason: '标签外残留标记或控制字符' };
  return { ok: true };
}

/** 缓存严格校验（schema 2）：hash/转换器版本/结构/页序/尺寸/SVG 白名单全核对——
 * 任一不符→null（调用方弃缓存重算）。第三十八轮：此前只查 schema/sourceHash/slides 是数组，
 * 异常缓存（非法尺寸/页序/含 foreignObject 与 onclick 的 SVG）可直达前端 innerHTML。 */
export function validatePptxPagesCache(raw: string | null, sourceHash: string): PptxPages | null {
  if (raw == null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  if (c.schema !== 2 || c.converterVersion !== PPTX_PAGES_CONVERTER_VERSION || c.sourceHash !== sourceHash) return null;
  if (!Number.isInteger(c.pxW) || !Number.isInteger(c.pxH) || (c.pxW as number) < PX_BOUNDS.min || (c.pxW as number) > PX_BOUNDS.max || (c.pxH as number) < PX_BOUNDS.min || (c.pxH as number) > PX_BOUNDS.max) return null;
  if (!Array.isArray(c.slides) || c.slides.length === 0) return null;
  const slides: PptxPageSlide[] = [];
  for (let i = 0; i < c.slides.length; i += 1) {
    const s = c.slides[i];
    if (s == null || typeof s !== 'object') return null;
    const r = s as Record<string, unknown>;
    if (r.slide !== i + 1) return null; // 页序连续（sldIdLst 顺序——防错序/缺页冒充）
    if (typeof r.svg !== 'string' || typeof r.truncated !== 'boolean' || typeof r.textTruncated !== 'boolean') return null;
    if (!Number.isInteger(r.shapes) || !Number.isInteger(r.images) || !Number.isInteger(r.unsupported) || (r.shapes as number) < 0 || (r.images as number) < 0 || (r.unsupported as number) < 0) return null;
    if (typeof r.notes !== 'string' || typeof r.notesTruncated !== 'boolean' || typeof r.unsupportedKinds !== 'string') return null;
    const well = svgWellFormed(r.svg);
    if (!well.ok) return null; // SVG 白名单：越界元素/属性/URL=缓存不可信
    slides.push({
      slide: i + 1, svg: r.svg, truncated: r.truncated, textTruncated: r.textTruncated,
      shapes: r.shapes as number, images: r.images as number, unsupported: r.unsupported as number,
      unsupportedKinds: r.unsupportedKinds, notes: r.notes, notesTruncated: r.notesTruncated,
    });
  }
  return { schema: 2, converterVersion: PPTX_PAGES_CONVERTER_VERSION, sourceHash, pxW: c.pxW as number, pxH: c.pxH as number, slides };
}

export function pptxPagesCacheKey(): string {
  return 'pptx-pages';
}

export function hashOf(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}
