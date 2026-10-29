/**
 * 文档解析子进程入口（第二十九轮一/四）——每个任务独立子进程（无跨任务状态/内存残留），
 * 收到一条 ParseJob → 读取托管副本（worker 侧再核 sha256=读取时点完整性）→ 解析 →
 * 一次性响应 → 退出。pdfjs/mammoth/xlsx/fflate 全部只在本进程加载（daemon 主进程零解析
 * 依赖）；父进程（parsePool）以墙钟截止+SIGTERM→SIGKILL 升级强制收拢，Node 端 pdfjs
 * fake-worker（同线程执行）的同步 CPU 阻塞被本进程边界隔离。
 *
 * 受控故障钩子（hooks，仅 ZS_TEST_PARSE_HOOKS=1 时池会附加）：busyMs=Atomics.wait 同步
 * 阻塞本进程（证明父进程仍可响应/截止可杀）；exitCode=不发响应直接退出（证明 worker 退出
 * 分类）。生产不设该环境变量=钩子不可达。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { safeUnzipWith, ZipGuardError } from './zipGuard.ts';
import { buildPptxPages } from './pptxPages.ts';
import {
  CURRENT_PARSER_VERSIONS,
  currentBudgetsFor,
  type ExtractCache, type ParseJob, type ParseResponse, type SheetCacheSheet,
} from './parseContracts.ts';

import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api.js';
import type { WorkBook } from 'xlsx';

class ParseError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// 本文件目录（CJS 打包=__dirname；ESM 源码运行=import.meta.url——两者其一可用）。
const here = typeof __dirname === 'string'
  ? __dirname
  : (() => { try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); } })();
const scriptSelf = (): string => {
  if (typeof __filename === 'string') return __filename;
  try { return fileURLToPath(import.meta.url); } catch { return ''; }
};

function sha256(raw: Buffer): string { return createHash('sha256').update(raw).digest('hex'); }

// ---------- PDF（pdfjs legacy——isEvalSupported=false 不执行 PDF 脚本；disableFontFace/
// useSystemFonts=false 不碰宿主字体；cmaps 随包携带供预定义 CJK CMap 解码） ----------
async function parsePdf(raw: Buffer, sourceHash: string): Promise<ExtractCache> {
  const { getDocument, PasswordResponses, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsPkg = (await import('pdfjs-dist/package.json', { with: { type: 'json' } })).default;
  // CMap 资源：随包 cmaps/（打包同目录）→ 仓库 node_modules（源码/测试运行按 cwd 解析）。
  const bundled = basename(scriptSelf()) === 'parse-worker.cjs';
  const cmapCandidates = bundled
    ? [join(here, 'cmaps')] // 打包形态：只认随包 cmaps（隔离副本缺失=依赖缺失可证，不回落开发机）
    : [join(here, 'cmaps'), join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps')];
  const cmapsDir = cmapCandidates.find((d) => existsSync(join(d, 'UniGB-UCS2-H.bcmap')));
  const workerCandidates = [join(here, 'pdf.worker.mjs'), join(process.cwd(), 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')];
  const workerFile = workerCandidates.find((p) => existsSync(p));
  if (workerFile != null) {
    try { GlobalWorkerOptions.workerSrc = pathToFileURL(workerFile).href; } catch { /* Node 端 fake-worker 回落——隔离由本子进程承载 */ }
  }
  const head = raw.subarray(0, Math.min(raw.length, 1024)).toString('latin1');
  if (!head.includes('%PDF-')) throw new ParseError('pdf-corrupt', '内容不是 PDF（%PDF- 头缺失——不以扩展名冒充）');
  // CMap 读取走本地文件系统工厂（Node fetch 不支持 file://——预定义 CJK CMap 依赖随包
  // cmaps 目录；缺失=字体构建失败、提取降级——依赖真实被消费）。
  const fsCMapFactory = class {
    baseUrl: string;
    isCompressed: boolean;
    constructor(opts: { baseUrl?: string; isCompressed?: boolean }) { this.baseUrl = opts?.baseUrl ?? ''; this.isCompressed = opts?.isCompressed ?? true; }
    async fetch({ name }: { name: string }) {
      if (!this.baseUrl) throw new Error('cMapUrl 未提供');
      if (!name) throw new Error('CMap name must be specified.');
      const path = join(cmapsDir ?? '.', `${name}${this.isCompressed ? '.bcmap' : ''}`);
      let data;
      try { data = readFileSync(path); } catch { throw new Error(`Unable to load ${this.isCompressed ? 'binary ' : ''}CMap at: ${path}`); }
      return { cMapData: new Uint8Array(data), isCompressed: this.isCompressed };
    }
  };
  let doc: PDFDocumentProxy;
  try {
    doc = await getDocument({
      data: new Uint8Array(raw),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
      ...(cmapsDir != null ? { cMapUrl: `${pathToFileURL(cmapsDir).href}/`, cMapPacked: true, CMapReaderFactory: fsCMapFactory } : {}),
    }).promise;
  } catch (error) {
    const name = (error as { name?: string }).name ?? '';
    if (name === 'PasswordException' || (error as { code?: number }).code === PasswordResponses.INCORRECT_PASSWORD) {
      throw new ParseError('pdf-encrypted', 'PDF 已加密：需要密码——明确不支持（不请求密码/不跳过解密）');
    }
    throw new ParseError('pdf-corrupt', `PDF 加载失败（${String((error as Error).message).slice(0, 120)}）——损坏或非标准结构`);
  }
  try {
    const pages: Array<{ page: number; text: string; truncated: boolean; bytes: number }> = [];
    let totalBytes = 0;
    const truncatedTotal = false;
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str === 'string') text += item.str + (item.hasEOL ? '\n' : '');
      }
      const truncated = false;
      const textBytes = Buffer.byteLength(text, 'utf8');
      totalBytes += textBytes;
      pages.push({ page: p, text, truncated, bytes: textBytes });
    }
    return {
      cacheSchema: 2, kind: 'pdf', sourceHash,
      parserName: 'pdfjs-dist', parserVersion: String(pdfjsPkg.version),
      extractedAt: Date.now(), budgets: currentBudgetsFor('pdf'),
      totalTextBytes: totalBytes, truncatedTotal,
      totalPages: doc.numPages, pages,
    };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError('pdf-corrupt', `PDF 页提取失败（${String((error as Error).message).slice(0, 120)}）`);
  } finally {
    void doc.destroy().catch(() => { /* 尽力释放 */ });
  }
}

// ZIP 结构、路径和解压完整性校验由共享模块执行；容量由运行资源边界约束。
export

/** zip 关系 target 相对路径解析（../ 与 ./ 逐段归一——字符串 replace 会误伤 '../' 内的 './'）。 */
function resolveZipTarget(baseFile: string, target: string): string {
  const parts = target.startsWith('/') ? target.slice(1).split('/') : [...baseFile.split('/').slice(0, -1), ...target.split('/')];
  const stack: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { stack.pop(); continue; }
    stack.push(seg);
  }
  return stack.join('/');
}

function requireEntry(files: Record<string, Uint8Array>, name: string): Uint8Array {
  const f = files[name];
  if (f == null) throw new ParseError('zip-corrupt', `缺少必需条目 ${name}——不是对应格式的 Office 文档`);
  return f;
}

/**
 * R69 P1-B：按**包根 officeDocument 关系的主 part content type** 定类。
 *
 * 旧实现用 `[Content_Types].xml` 全文 `includes('macroEnabled')` 拒整份——普通 PPTX 内嵌
 * `Default Extension="xlsb" ContentType="...binary.macroEnabled.12"`（嵌入 Excel 部件声明）
 * 会把整份主演示文稿误判成宏文档（用户实测 11.7MB/55 页正常 PPTX 被拒）。嵌入类型声明
 * 不证明主演示文稿含可执行宏；宏判定只看**主 part 自身**的 content type（.pptm/.docm/.xlsm
 * 的主 part 声明即 macroEnabled.*）。
 */
function attrOf(tagXml: string, name: string): string | null {
  const m1 = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tagXml);
  if (m1 != null) return m1[1]!;
  const m2 = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(tagXml);
  return m2 != null ? m2[1]! : null;
}

export interface OfficeMainClass {
  family: 'docx' | 'xlsx' | 'pptx' | 'unknown';
  macro: boolean;
  mainPart: string;
  contentType: string;
}

export function classifyOfficeMain(files: Record<string, Uint8Array>): OfficeMainClass {
  const ctText = Buffer.from(requireEntry(files, '[Content_Types].xml')).toString('utf8');
  const relsXml = files['_rels/.rels'] != null ? Buffer.from(files['_rels/.rels']!).toString('utf8') : '';
  // 包根 officeDocument 关系 → 主 part 路径（属性顺序不定；Target 可能带前导 / 或 ./）
  let mainPart = '';
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0]!;
    const type = attrOf(tag, 'Type') ?? '';
    if (!/\/officeDocument$/.test(type)) continue;
    const target = attrOf(tag, 'Target');
    if (target == null || target.length === 0) continue;
    mainPart = target.replace(/^\//, '').replace(/^\.\//, '');
    break;
  }
  if (mainPart.length === 0) {
    // 兜底（极少见：关系声明用绝对 part 名或 rels 缺失）——按三个规范主 part 名直查。
    for (const cand of ['word/document.xml', 'xl/workbook.xml', 'ppt/presentation.xml']) {
      if (files[cand] != null) { mainPart = cand; break; }
    }
    if (mainPart.length === 0) {
      throw new ParseError('office-corrupt', '包根关系未声明 officeDocument 主文档，且无规范主 part——不是 Office 文档');
    }
  }
  // 主 part 的 content type：Override 优先，其次按扩展名 Default
  let contentType = '';
  for (const m of ctText.matchAll(/<Override\b[^>]*>/g)) {
    const tag = m[0]!;
    const pn = (attrOf(tag, 'PartName') ?? '').replace(/^\//, '');
    if (pn === mainPart) { contentType = attrOf(tag, 'ContentType') ?? ''; break; }
  }
  if (contentType.length === 0) {
    const dot = mainPart.lastIndexOf('.');
    const ext = dot >= 0 ? mainPart.slice(dot + 1).toLowerCase() : '';
    for (const m of ctText.matchAll(/<Default\b[^>]*>/g)) {
      const tag = m[0]!;
      if ((attrOf(tag, 'Extension') ?? '').toLowerCase() === ext) { contentType = attrOf(tag, 'ContentType') ?? ''; break; }
    }
  }
  const family = contentType.includes('wordprocessingml') ? 'docx'
    : contentType.includes('spreadsheetml') ? 'xlsx'
      : contentType.includes('presentationml') ? 'pptx' : 'unknown';
  return { family, macro: contentType.includes('macroEnabled'), mainPart, contentType };
}

function decodeXmlEntities(s: string): string {
  return s
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** 净化 HTML：白名单标记、除 colspan/rowspan 外零属性、script/style 连内容丢弃。 */
function sanitizeOfficeHtml(html: string): string {
  const allowed = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const tagSrc = html.slice(lt, gt + 1);
    const m = /^<\/?\s*([a-zA-Z0-9]+)/.exec(tagSrc);
    if (m != null) {
      const tag = m[1]!.toLowerCase();
      if (tag === 'script' || tag === 'style') {
        const close = html.toLowerCase().indexOf(`</${tag}`, gt);
        i = close < 0 ? html.length : html.indexOf('>', close) + 1;
        continue;
      }
      if (allowed.has(tag)) {
        if (tagSrc.startsWith('</')) out += `</${tag}>`;
        else if (tagSrc.endsWith('/>') || tag === 'br') out += `<${tag}${tag === 'br' ? ' /' : ''}>`;
        else {
          const span = /colspan\s*=\s*"(\d+)"/i.exec(tagSrc);
          const rspan = /rowspan\s*=\s*"(\d+)"/i.exec(tagSrc);
          const attrs = `${span != null ? ` colspan="${span[1]}"` : ''}${rspan != null ? ` rowspan="${rspan[1]}"` : ''}`;
          out += `<${tag}${attrs}>`;
        }
      }
    }
    i = gt + 1;
  }
  return out;
}

// ---------- DOCX（mammoth：段落/表格有序提取；外部关系不加载、图片不解码、宏文档拒绝） ----------
async function parseDocx(raw: Buffer, sourceHash: string, preUnzipped?: Record<string, Uint8Array>): Promise<ExtractCache> {
  const mammothPkg = (await import('mammoth/package.json', { with: { type: 'json' } })).default;
  const files = preUnzipped ?? safeUnzipWith(raw); // 结构与路径校验先于 mammoth；office 路径复用同一解包
  // R69 P1-B：宏判定按**主 part content type**（classifyOfficeMain）——嵌入部件的
  // macroEnabled 类型声明（如内嵌 xlsb）不再把整份普通文档误判成宏文档。
  const mainCls = classifyOfficeMain(files);
  if (mainCls.family !== 'docx') {
    throw new ParseError('office-corrupt', `主文档不是 Word（主 part ${mainCls.mainPart} = ${mainCls.contentType || '未知类型'}）——不以扩展名冒充`);
  }
  if (mainCls.macro) {
    throw new ParseError('docx-macro', '宏 Word 文档不支持（主文档 content type 为 macroEnabled——.docm 明确拒绝，不执行宏）');
  }
  if (mainCls.contentType.includes('wordprocessingml.2003')) {
    throw new ParseError('docx-macro', '旧版 Word 2003 XML/二进制文档不支持（.doc 明确拒绝）');
  }
  requireEntry(files, 'word/document.xml');
  const mammoth = await import('mammoth');
  let html: string;
  let text: string;
  try {
    const htmlResult = await mammoth.convertToHtml({ buffer: raw }, { convertImage: undefined });
    html = sanitizeOfficeHtml(String(htmlResult.value));
    const textResult = await mammoth.extractRawText({ buffer: raw });
    text = String(textResult.value);
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError('docx-corrupt', `DOCX 解析失败（${String((error as Error).message).slice(0, 120)}）——损坏或非标准结构`);
  }
  const paragraphCount = text.split('\n').filter((l) => l.trim().length > 0).length;
  const htmlTruncated = false;
  return {
    cacheSchema: 2, kind: 'docx', sourceHash,
    parserName: 'mammoth', parserVersion: String(mammothPkg.version),
    extractedAt: Date.now(), budgets: currentBudgetsFor('docx'),
    totalTextBytes: Buffer.byteLength(text, 'utf8'), truncatedTotal: false,
    text, html, htmlTruncated, paragraphCount,
  };
}

// ---------- XLSX（SheetJS：**只读缓存值**——公式不执行；无缓存值如实占位） ----------
async function parseXlsx(raw: Buffer, sourceHash: string, preUnzipped?: Record<string, Uint8Array>): Promise<ExtractCache> {
  const files = preUnzipped ?? safeUnzipWith(raw); // office 路径复用同一解包
  requireEntry(files, 'xl/workbook.xml');
  const XLSX = await import('xlsx');
  let wb: WorkBook;
  try {
    // cellFormula:true 仅保留 .f 标记（识别公式格），值恒取缓存 .v——绝不求值。
    wb = XLSX.read(raw, { cellDates: true, cellFormula: true, cellStyles: false });
  } catch (error) {
    throw new ParseError('sheet-corrupt', `XLSX 解析失败（${String((error as Error).message).slice(0, 120)}）——损坏或非标准结构`);
  }
  const sheetNames = wb.SheetNames;
  if (sheetNames.length === 0) throw new ParseError('sheet-corrupt', '工作簿没有任何工作表');
  // 公式无缓存值自查（SheetJS 会整格丢弃 <f> 无 <v> 的格——不执行公式也不静默吞）：
  // 在解压的 sheet XML 上直接找这类引用，预览窗口内置「公式无缓存值」占位+总标注。
  const relsXml = files['xl/_rels/workbook.xml.rels'] != null ? Buffer.from(files['xl/_rels/workbook.xml.rels']).toString('utf8') : '';
  const relOf = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relOf.set(m[1]!, m[2]!);
  const wbXml = Buffer.from(requireEntry(files, 'xl/workbook.xml')).toString('utf8');
  const sheetFileOf: string[] = []; // 与 wb.SheetNames 顺序对齐（r:id→rels→worksheets/sheetN.xml）
  const nameRe = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g;
  const seen = new Set<string>();
  for (const m of wbXml.matchAll(nameRe)) {
    const name = decodeXmlEntities(m[1]!);
    if (seen.has(name)) continue;
    seen.add(name);
    const target = relOf.get(m[2]!);
    if (target != null) sheetFileOf.push(resolveZipTarget('xl/workbook.xml', target));
  }
  const missingFormulaRefs = (sheetFile: string | undefined): Map<string, true> => {
    const out = new Map<string, true>();
    if (sheetFile == null || files[sheetFile] == null) return out;
    const xml = Buffer.from(files[sheetFile]!).toString('utf8');
    for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const inner = m[2] ?? '';
      if (inner.includes('<f') && !inner.includes('<v')) {
        const ref = /r="([A-Z]+\d+)"/.exec(m[1] ?? '');
        if (ref != null) out.set(ref[1]!, true);
      }
    }
    return out;
  };
  const sheets: SheetCacheSheet[] = [];
  let totalBytes = 0;
  const truncatedTotal = false;
  for (const name of sheetNames) {
    const ws = wb.Sheets[name];
    if (ws == null) throw new ParseError('sheet-corrupt', `工作表缺失：${name}`);
    const idx = sheetNames.indexOf(name);
    const missingRefs = missingFormulaRefs(sheetFileOf[idx]);
    const ref = (ws['!ref'] ?? 'A1').split(':');
    const start = XLSX.utils.decode_cell(ref[0] ?? 'A1');
    const end = ref[1] != null ? XLSX.utils.decode_cell(ref[1]) : start;
    const rowCount = Math.max(0, end.r - start.r + 1);
    const colCount = Math.max(0, end.c - start.c + 1);
    const rowsOut = rowCount;
    const colsOut = colCount;
    const cells: string[][] = [];
    let sheetFormulaMissing = false;
    if (missingRefs.size > 0) sheetFormulaMissing = true; // 全表任一公式格无缓存值即标注
    for (let r = 0; r < rowsOut; r += 1) {
      const row: string[] = [];
      for (let c = 0; c < colsOut; c += 1) {
        const ref = XLSX.utils.encode_cell({ r: start.r + r, c: start.c + c });
        const cell = ws[ref] as { v?: unknown; t?: string; f?: string } | undefined;
        let value: string;
        if (cell != null && cell.v == null && cell.f == null && missingRefs.has(ref)) value = '「公式无缓存值」';
        else if (cell == null || (cell.v == null && cell.f == null)) value = missingRefs.has(ref) ? '「公式无缓存值」' : '';
        else if (cell.f != null && cell.v == null) { value = '「公式无缓存值」'; sheetFormulaMissing = true; }
        else if (cell.v instanceof Date) value = cell.v.toISOString();
        else value = String(cell.v);
        if (value === 'undefined' || value === 'null') value = '';
        row.push(value);
        totalBytes += Buffer.byteLength(value, 'utf8');
      }
      cells.push(row);
    }
    const merges = ((ws['!merges'] ?? []) as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>)
      .map((mg) => [mg.s.r - start.r, mg.s.c - start.c, mg.e.r - start.r, mg.e.c - start.c] as [number, number, number, number]);
    sheets.push({ name, rowCount, colCount, cells, merges, rowTruncated: rowCount > rowsOut, colTruncated: colCount > colsOut, formulaMissing: sheetFormulaMissing });
  }
  return {
    cacheSchema: 2, kind: 'sheet', sourceHash,
    parserName: CURRENT_PARSER_VERSIONS.sheet.name, parserVersion: CURRENT_PARSER_VERSIONS.sheet.version,
    extractedAt: Date.now(), budgets: currentBudgetsFor('sheet'),
    totalTextBytes: totalBytes, truncatedTotal,
    sourceFormat: 'xlsx', encoding: 'internal', sheets,
  };
}

// ---------- CSV（自研：编码探测 UTF-8/BOM/UTF-16——非此列明确 unsupported；RFC4180 引号；分隔符嗅探） ----------
function parseCsv(raw: Buffer, sourceHash: string): ExtractCache {
  let text: string;
  let encoding: string;
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) { text = new TextDecoder('utf-8').decode(raw.subarray(3)); encoding = 'utf-8-bom'; }
  else if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) { text = new TextDecoder('utf-16le').decode(raw.subarray(2)); encoding = 'utf-16le'; }
  else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) { text = new TextDecoder('utf-16be').decode(raw.subarray(2)); encoding = 'utf-16be'; }
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); encoding = 'utf-8'; }
    catch {
      throw new ParseError('csv-encoding-unsupported', `CSV 编码不受支持（前 8 字节 ${raw.subarray(0, 8).toString('hex')}——支持 UTF-8/UTF-8 BOM/UTF-16 BOM；不静默转码）`);
    }
  }
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const delim = [',', ';', '\t'].reduce((a, b) => (firstLine.split(b).length > firstLine.split(a).length ? b : a), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let totalBytes = 0;
  const truncatedTotal = false;
  const pushField = (): void => { row.push(field); totalBytes += Buffer.byteLength(field, 'utf8'); field = ''; };
  const pushRow = (): void => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) pushField();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') { /* CRLF 由 \n 收行 */ }
    else field += ch;
  }
  if (inQuotes) throw new ParseError('sheet-corrupt', 'CSV 引号未闭合');
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) throw new ParseError('sheet-corrupt', 'CSV 无任何数据行');
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    cacheSchema: 2, kind: 'sheet', sourceHash,
    parserName: 'zhongshuo-csv', parserVersion: '1',
    extractedAt: Date.now(), budgets: currentBudgetsFor('sheet'),
    totalTextBytes: totalBytes, truncatedTotal,
    sourceFormat: 'csv', encoding,
    sheets: [{ name: 'CSV', rowCount: rows.length, colCount, cells: rows, merges: [], rowTruncated: false, colTruncated: false, formulaMissing: false }],
  };
}

// ---------- PPTX（zip+XML：a:t 文本节点按文档序；备注页同法；页图渲染=unsupported 如实标注） ----------
function xmlTexts(xml: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < xml.length) {
    const open = xml.indexOf('<a:t>', i);
    if (open < 0) break;
    const close = xml.indexOf('</a:t>', open);
    if (close < 0) break;
    out.push(decodeXmlEntities(xml.slice(open + 5, close)));
    i = close + 6;
  }
  return out;
}
/**
 * PPTX 解析（第三十轮三重写）：页顺序以 **presentation.xml 的 sldIdLst** 为准（r:id→
 * presentation rels→slides/slideN.xml——插页/重排/删除后编号不连续仍按真实顺序）；**备注沿
 * 该页自己的关系表定位**（ppt/slides/_rels/slideN.xml.rels→notesSlide target——文件编号与
 * 页号无假定对应）；未被 sldIdLst 引用的孤立页排除；正文和备注均完整保存并计入字节总量。
 */
function parsePptx(raw: Buffer, sourceHash: string, preUnzipped?: Record<string, Uint8Array>): ExtractCache {
  const files = preUnzipped ?? safeUnzipWith(raw);
  requireEntry(files, 'ppt/presentation.xml');
  const presentationXml = Buffer.from(requireEntry(files, 'ppt/presentation.xml')).toString('utf8');
  // presentation 关系：rId → target（相对 ppt/）。
  const presRels: Record<string, string> = {};
  if (files['ppt/_rels/presentation.xml.rels'] != null) {
    const relsXml = Buffer.from(files['ppt/_rels/presentation.xml.rels']).toString('utf8');
    for (const m of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
      const attrs = m[1] ?? '';
      const id = /Id="([^"]+)"/.exec(attrs)?.[1];
      const target = /Target="([^"]+)"/.exec(attrs)?.[1];
      const type = /Type="([^"]+)"/.exec(attrs)?.[1] ?? '';
      if (id != null && target != null && type.endsWith('/slide')) {
        presRels[id] = resolveZipTarget('ppt/presentation.xml', target);
      }
    }
  }
  // sldIdLst 顺序（真实页序）。
  const slideTargets: string[] = [];
  const sldIdLst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(presentationXml)?.[1] ?? '';
  for (const m of sldIdLst.matchAll(/<p:sldId\b([^>]*)>/g)) {
    const rid = /r:id="([^"]+)"/.exec(m[1] ?? '')?.[1];
    if (rid == null) throw new ParseError('slides-corrupt', '幻灯片缺少关系标识');
    const target = presRels[rid];
    if (target == null) throw new ParseError('slides-corrupt', `幻灯片关系缺失：${rid}`);
    slideTargets.push(target);
  }
  if (slideTargets.length === 0) throw new ParseError('slides-corrupt', 'presentation.xml 的 sldIdLst 未引用任何幻灯片——不是 PPTX（不以孤立 slideN.xml 文件冒充）');
  const slides: Array<{ slide: number; text: string; notes: string; truncated: boolean }> = [];
  let totalBytes = 0;
  const truncatedTotal = false;
  for (let idx = 0; idx < slideTargets.length; idx += 1) {
    const slideFile = slideTargets[idx]!;
    if (files[slideFile] == null) throw new ParseError('slides-corrupt', `sldIdLst 引用的幻灯片缺失：${slideFile}`);
    const slideXml = Buffer.from(files[slideFile]!).toString('utf8');
    // 备注沿该页自己的关系表（slideN.xml.rels→notesSlide target——不假定同号）。
    let notesXml = '';
    const slideRelsFile = slideFile.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels';
    if (files[slideRelsFile] != null) {
      const slideRelsXml = Buffer.from(files[slideRelsFile]!).toString('utf8');
      for (const m of slideRelsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
        const attrs = m[1] ?? '';
        const type = /Type="([^"]+)"/.exec(attrs)?.[1] ?? '';
        const target = /Target="([^"]+)"/.exec(attrs)?.[1];
        if (!type.endsWith('/notesSlide') || target == null) continue;
        const notesFile = resolveZipTarget(slideFile, target);
        if (files[notesFile] != null) notesXml = Buffer.from(files[notesFile]!).toString('utf8');
      }
    }
    const text = xmlTexts(slideXml).join('\n');
    const notes = xmlTexts(notesXml).join('\n');
    const truncated = false;
    const textBytes = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(notes, 'utf8');
    totalBytes += textBytes;
    slides.push({ slide: idx + 1, text, notes, truncated });
  }
  return {
    cacheSchema: 2, kind: 'slides', sourceHash,
    parserName: 'zhongshuo-pptx', parserVersion: '2',
    extractedAt: Date.now(), budgets: currentBudgetsFor('slides'),
    totalTextBytes: totalBytes, truncatedTotal,
    totalSlides: slideTargets.length, slides,
  };
}

// ---------- 入口 ----------
async function handle(job: ParseJob): Promise<ParseResponse> {
  const common = { jobId: job.jobId };
  try {
    if (job.hooks?.exitCode != null) {
      // 受控故障：不发响应直接退出（父进程分类 parse-worker-exited）。
      process.exit(job.hooks.exitCode);
    }
    if (job.hooks?.busyMs != null && job.hooks.busyMs > 0) {
      // 受控故障：同步阻塞本进程（Atomics.wait 不让出事件循环）——父进程须仍可响应并按截止杀。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, job.hooks.busyMs);
    }
    if (job.hooks?.allocMB != null && job.hooks.allocMB > 0) {
      // 受控故障：外部 Buffer 大额分配（--max-old-space-size 不约束 Buffer——整进程提交内存
      // 上限由 Job Object 承载；第三十轮二 OOM 反例）。
      const sink = Buffer.alloc(job.hooks.allocMB * 1024 * 1024);
      sink[0] = 1; // 触碰防消除
    }
    const raw = readFileSync(job.blobPath);
    const hash = sha256(raw);
    if (hash !== job.expectedHash) {
      return { ...common, ok: false, error: { code: 'source-hash-mismatch', message: `托管副本读取时 sha256 与记录不符（${hash.slice(0, 12)}… ≠ ${job.expectedHash.slice(0, 12)}…）——原件已被改写，拒绝解析` } };
    }
    // PPTX 静态页（第三十八轮四：解压+SVG 转换重活进本可终止子进程——内存/截止/终止梯
    // 全沿解析池；载荷走 outPath 文件，IPC 只回小摘要）。与文本提取分列：不产 ExtractCache。
    if (job.kind === 'pptx-pages') {
      if (job.outPath == null || job.outPath.length === 0) {
        return { ...common, ok: false, error: { code: 'pptx-pages-config', message: '缺少输出文件路径' } };
      }
      const files = safeUnzipWith(raw);
      const pages = buildPptxPages(files, (name) => files[name], hash);
      const json = JSON.stringify(pages);
      const outBytes = Buffer.byteLength(json, 'utf8');
      writeFileSync(job.outPath, json, 'utf8');
      return {
        ...common, ok: true,
        pagesSummary: { sourceHash: hash, slides: pages.slides.length, pxW: pages.pxW, pxH: pages.pxH, truncatedPages: pages.slides.filter((s) => s.truncated).length, outBytes },
      };
    }
    let result: ExtractCache;
    switch (job.kind) {
      case 'pdf': result = await parsePdf(raw, hash); break;
      case 'docx': result = await parseDocx(raw, hash); break;
      case 'xlsx': result = await parseXlsx(raw, hash); break;
      case 'csv': result = parseCsv(raw, hash); break;
      case 'pptx': result = await parsePptx(raw, hash); break;
      case 'office': {
        // R69 P1-B：定类按**包根 officeDocument 关系的主 part content type**
        // （classifyOfficeMain）——单次解包结果供定类与逐格式解析复用；宏判定只看主 part
        // 自身（.pptm/.docm/.xlsm 拒），嵌入其它 Office 部件的类型声明不再污染定类。
        const sniffFiles = safeUnzipWith(raw);
        const cls = classifyOfficeMain(sniffFiles);
        if (cls.macro) {
          const extName = cls.family === 'docx' ? '.docm' : cls.family === 'xlsx' ? '.xlsm' : '.pptm';
          throw new ParseError('docx-macro', `宏 Office 文档不支持（主 part ${cls.mainPart} content type 为 macroEnabled——${extName} 明确拒绝，不执行宏；嵌入部件的宏类型声明不在此列）`);
        }
        if (cls.family === 'unknown') {
          throw new ParseError('office-corrupt', `未知 Office 类型（主 part ${cls.mainPart} = ${cls.contentType || '无类型声明'}）——不以扩展名冒充`);
        }
        if (cls.family === 'docx') result = await parseDocx(raw, hash, sniffFiles);
        else if (cls.family === 'xlsx') result = await parseXlsx(raw, hash, sniffFiles);
        else result = parsePptx(raw, hash, sniffFiles);
        break;
      }
    }
    const artifactKind = job.kind === 'pdf' ? 'pdf_file' : job.kind === 'docx' ? 'docx_file' : job.kind === 'pptx' ? 'slides_file' : 'sheet_file';
    return { ...common, ok: true, result: { ...result, artifactKind } };
  } catch (error) {
    const code = error instanceof ParseError ? error.code : error instanceof ZipGuardError ? error.code : 'parse-worker-error';
    return { ...common, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
  }
}

process.on('message', (job: ParseJob) => {
  void handle(job).then((response) => {
    // 响应写出完成再退出（send 回调；通道关闭/未回调由兜底计时器收口——不留僵尸）。
    const exit = (): void => process.exit(0);
    if (process.send == null) { exit(); return; }
    process.send(response, () => exit());
    setTimeout(exit, 2_000);
  }).catch(() => process.exit(0));
});
