/**
 * 文档解析共享合同（第二十九轮一/二/四）——父进程（commands/turnInput/parsePool）与
 * 解析子进程（parseWorker）共用：运行资源常量、提取缓存 schema（v2）与严格校验、任务/
 * 响应形状。本文件**零重依赖**（pdfjs/mammoth/xlsx/fflate 只进 parseWorker 子进程——
 * 隔离边界第二十九轮一：解析不占 daemon 主线程，截止/取消由父进程执行边界强制）。
 *
 * 缓存 schema v2（第二十九轮二）：sourceHash 一致**不能**代替结构与版本校验——
 * cacheSchema/kind/parserName/parserVersion/budgets/页码连续性/完整提取口径全部核对；
 * 校验不过=缓存无效（预览侧按需重提，组装侧 fail-closed 不派发）。
 */

// ---------- 执行边界限额（父进程强制） ----------
export const PARSE_CONCURRENCY = 1; // 串行解析：单 worker 内存受下面资源常量约束（并发=排队）
export const PARSE_QUEUE_MAX = 4; // 等待队列上限：超=parse-busy 明确拒绝（不悬挂）
export const PARSE_DEADLINE_MS = 30_000; // 整体截止：覆盖加载、逐页/逐项提取、结果传输与收拢
export const PARSE_KILL_GRACE_MS = 2_000; // SIGTERM→SIGKILL 升级窗口
export const PARSE_MEMORY_LIMIT_MB = 768; // 子进程 --max-old-space-size（R71：真实 XLSX 单表 73MiB XML+全表对象超 320——按真件上调；仍为硬界，非无界）
export const PARSE_TOTAL_MEMORY_LIMIT_BYTES = 896 * 1024 * 1024; // 整进程提交内存硬界（R71 随 V8 上限同步上调；Job Object PROCESS_MEMORY 仍为硬界）
// ---------- 模型输入摘录窗（不限制原件、完整解析缓存或本地预览） ----------
export const SHEET_INJECT_DEFAULT_ROWS = 50;
export const SHEET_INJECT_DEFAULT_COLS = 16;

/** 提取缓存公共头。 */
export interface ExtractCacheCommon {
  cacheSchema: 2;
  kind: 'pdf' | 'docx' | 'sheet' | 'slides';
  sourceHash: string;
  parserName: string;
  parserVersion: string;
  extractedAt: number;
  /** 提取口径标记（有限数值）；变化使旧缓存失效，容量不写 Infinity/JSON null。 */
  budgets: Record<string, number>;
  totalTextBytes: number;
  truncatedTotal: boolean;
}

export interface PdfCachePayload {
  totalPages: number;
  pages: Array<{ page: number; text: string; truncated: boolean; bytes: number }>;
}

export interface DocxCachePayload {
  /** 有序纯文本（段落+表格单元格按文档序——注入用）。 */
  text: string;
  /** 安全排版预览 HTML（服务端白名单净化——仅 p/br/strong/em/u/ul/ol/li/table/thead/tbody/tr/td/th/h1-h6/blockquote；无 href/无事件属性）。 */
  html: string;
  htmlTruncated: boolean;
  paragraphCount: number;
}

export interface SheetCacheSheet {
  name: string;
  rowCount: number;
  colCount: number;
  /** 完整工作表单元格值（字符串化；公式无缓存值=「公式无缓存值」占位）。 */
  cells: string[][];
  merges: Array<[number, number, number, number]>; // [r1,c1,r2,c2] 0 基含端
  rowTruncated: boolean;
  colTruncated: boolean;
  formulaMissing: boolean;
}

export interface SheetCachePayload {
  sourceFormat: 'xlsx' | 'csv';
  /** CSV 实际解码编码（utf-8/utf-8-bom/utf-16le/utf-16be；xlsx 恒 internal）。 */
  encoding: string;
  sheets: SheetCacheSheet[];
}

export interface SlidesCacheSlide {
  slide: number;
  /** 幻灯片文字（按 XML 文档序拼接）。 */
  text: string;
  /** 备注页文字。 */
  notes: string;
  truncated: boolean;
}

export interface SlidesCachePayload {
  totalSlides: number;
  slides: SlidesCacheSlide[];
}

export type ExtractCache = ExtractCacheCommon & (
  | ({ kind: 'pdf' } & PdfCachePayload)
  | ({ kind: 'docx' } & DocxCachePayload)
  | ({ kind: 'sheet' } & SheetCachePayload)
  | ({ kind: 'slides' } & SlidesCachePayload)
);

/** 当前预算口径（校验既有缓存是否按现口径产出）。 */
export function currentBudgetsFor(kind: ExtractCache['kind']): Record<string, number> {
  // R120: 完整本地解析口径；预览重提旧预算缓存，模型输入另行兼容历史摘录。
  void kind;
  return { completePreview: 1 };
}

// 当前解析器身份（第三十轮三：缓存校验核对**适用解析器与真实版本**——非空字符串不算）。
import pdfjsPkg from 'pdfjs-dist/package.json' with { type: 'json' };
import mammothPkg from 'mammoth/package.json' with { type: 'json' };
// xlsx@0.20.3（官方 CDN 发行物）的 exports 不含 ./package.json 子路径——版本以字面量为
// 单一事实（安装来源 https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz，sha256=
// 8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8）；officeDependencies.test.ts
// 同步核对 node_modules 实际版本与来源一致（升级须改此常量并复验）。
const XLSX_VERSION = '0.20.3';
export const CURRENT_PARSER_VERSIONS: Record<ExtractCache['kind'] | 'csv', { name: string; version: string }> = {
  pdf: { name: 'pdfjs-dist', version: String(pdfjsPkg.version) },
  docx: { name: 'mammoth', version: String(mammothPkg.version) },
  sheet: { name: 'xlsx', version: XLSX_VERSION }, // sheet 缓存的 parserName=xlsx（CSV 分支=zhongshuo-csv）
  csv: { name: 'zhongshuo-csv', version: '1' },
  slides: { name: 'zhongshuo-pptx', version: '2' },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 仅识别已发布的 v2 预算；这些数值不作为新文件或预览上限。 */
function legacyBudgetsFor(kind: ExtractCache['kind']): Record<string, number> {
  switch (kind) {
    case 'pdf': return { pageText: 65536, totalText: 524288 };
    case 'docx': return { totalText: 524288 };
    case 'sheet': return { cellText: 4096, totalText: 524288 };
    case 'slides': return { slideText: 65536, totalText: 524288 };
  }
}
function sameBudgets(actual: Record<string, unknown>, expected: Record<string, number>): boolean {
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** 输入允许已知历史摘录，原样保留预算和截断信息；预览仍使用严格入口。 */
export function validateExtractCacheForInput(rawJson: string | null | undefined, expectedHash: string, kind: ExtractCache['kind']): ExtractCache | null {
  return validateExtractCache(rawJson, expectedHash, kind, { allowLegacyInput: true });
}

/** 历史 sheet 未逐格保存截断标记，不能声称完整。 */
export function extractCacheIsTruncated(cache: ExtractCache): boolean {
  return cache.truncatedTotal || (cache.kind === 'pdf' ? cache.pages.some((p) => p.truncated)
    : cache.kind === 'docx' ? cache.htmlTruncated
    : cache.kind === 'slides' ? cache.slides.some((s) => s.truncated)
    : cache.budgets.completePreview !== 1 || cache.sheets.some((s) => s.rowTruncated || s.colTruncated));
}

/**
 * 提取缓存严格校验（第二十九轮二）：结构/版本/预算/来源 hash 逐项核对。
 * 返回 null=缓存无效（调用方决定重提或 fail-closed）；**不抛错**（损坏缓存是数据态）。
 */
export function validateExtractCache(rawJson: string | null | undefined, expectedHash: string, kind: ExtractCache['kind'], options?: { allowLegacyInput?: boolean }): ExtractCache | null {
  const byteLen = (v: unknown): number => typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : -1;
  if (rawJson == null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  const c = parsed as Record<string, unknown>;
  if (c.cacheSchema !== 2 || c.kind !== kind || typeof c.sourceHash !== 'string' || c.sourceHash !== expectedHash) return null;
  // 适用解析器与真实版本（第三十轮三：非空字符串不算——升级/降级/换解析器=旧缓存作废；
  // sheet 依 sourceFormat 分流 xlsx/zhongshuo-csv）。
  const variant = kind === 'sheet' && c.sourceFormat === 'csv' ? 'csv' : kind;
  const expectedParser = CURRENT_PARSER_VERSIONS[variant as ExtractCache['kind']];
  if (typeof c.parserName !== 'string' || c.parserName !== expectedParser.name) return null;
  if (typeof c.parserVersion !== 'string' || c.parserVersion !== expectedParser.version) return null;
  if (typeof c.extractedAt !== 'number' || !Number.isFinite(c.extractedAt)) return null;
  if (!isPlainObject(c.budgets)) return null;
  const legacy = options?.allowLegacyInput === true && sameBudgets(c.budgets, legacyBudgetsFor(kind));
  if (!legacy && !sameBudgets(c.budgets, currentBudgetsFor(kind))) return null;
  if (!Number.isSafeInteger(c.totalTextBytes) || (c.totalTextBytes as number) < 0 || typeof c.truncatedTotal !== 'boolean'
    || (!legacy && c.truncatedTotal)) return null;
  if (kind === 'pdf') {
    if (typeof c.totalPages !== 'number' || !Array.isArray(c.pages)) return null;
    let pagesSum = 0;
    for (let i = 0; i < c.pages.length; i += 1) {
      const p = c.pages[i];
      if (!isPlainObject(p) || p.page !== i + 1 || typeof p.text !== 'string' || typeof p.truncated !== 'boolean' || typeof p.bytes !== 'number') return null;
      // 逐层字节一致；bytes 与实际不符即拒。
      if (p.bytes !== byteLen(p.text)) return null;
      if (!legacy && p.truncated) return null;
      if (legacy && p.bytes > 65536) return null;
      pagesSum += p.bytes as number;
    }
    if (!Number.isSafeInteger(c.totalPages) || (c.totalPages as number) < c.pages.length
      || (c.totalPages !== c.pages.length && !(legacy && c.truncatedTotal))) return null;
    // 旧 PDF 在总预算切断末页时，totalTextBytes 未累计该页；只接受这个已知形态。
    const tail = c.pages.at(-1) as { bytes: number; truncated: boolean } | undefined;
    if (c.totalTextBytes !== pagesSum && !(legacy && c.truncatedTotal && tail?.truncated
      && pagesSum === 524288 && c.totalTextBytes === pagesSum - tail.bytes)) return null;
    if (legacy && (pagesSum > 524288 || c.pages.length > 200)) return null;
    return parsed as unknown as ExtractCache;
  }
  if (kind === 'docx') {
    if (typeof c.text !== 'string' || typeof c.html !== 'string' || typeof c.htmlTruncated !== 'boolean' || typeof c.paragraphCount !== 'number') return null;
    if (c.totalTextBytes !== byteLen(c.text)) return null;
    if ((!legacy && c.htmlTruncated) || !Number.isSafeInteger(c.paragraphCount) || (c.paragraphCount as number) < 0) return null;
    if (legacy && ((c.totalTextBytes as number) > 524288 || byteLen(c.html) > 786432 || (c.paragraphCount as number) > 10000)) return null;
    return parsed as unknown as ExtractCache;
  }
  if (kind === 'sheet') {
    if (c.sourceFormat !== 'xlsx' && c.sourceFormat !== 'csv') return null;
    if (typeof c.encoding !== 'string' || !Array.isArray(c.sheets) || c.sheets.length === 0) return null;
    let sheetsSum = 0;
    for (const sh of c.sheets) {
      if (!isPlainObject(sh) || typeof sh.name !== 'string' || typeof sh.rowCount !== 'number' || typeof sh.colCount !== 'number'
        || !Array.isArray(sh.cells) || !Array.isArray(sh.merges) || typeof sh.rowTruncated !== 'boolean' || typeof sh.colTruncated !== 'boolean' || typeof sh.formulaMissing !== 'boolean') return null;
      if (!Number.isSafeInteger(sh.rowCount) || !Number.isSafeInteger(sh.colCount) || (sh.rowCount as number) < 0 || (sh.colCount as number) < 0 || (!legacy && (sh.rowTruncated || sh.colTruncated || sh.cells.length !== sh.rowCount))
        || sh.cells.length > (sh.rowCount as number)) return null;
      if (legacy && (sh.cells.length > 200 || (!c.truncatedTotal && sh.cells.length !== Math.min(sh.rowCount as number, 200))
        || sh.rowTruncated !== ((sh.rowCount as number) > 200) || sh.colTruncated !== ((sh.colCount as number) > 32))) return null;
      let sheetSum = 0;
      for (const row of sh.cells) {
        if (!Array.isArray(row) || row.length > (sh.colCount as number) || (legacy && row.length > 32)) return null;
        for (const cell of row) {
          if (typeof cell !== 'string') return null;
          const b = byteLen(cell);
          if (legacy && b > 4096) return null;
          sheetSum += b;
        }
      }
      sheetsSum += sheetSum;
      for (const merge of sh.merges) {
        if (!Array.isArray(merge) || merge.length !== 4 || !merge.every((v: unknown) => Number.isSafeInteger(v))) return null;
      }
    }
    if (legacy && (c.sheets.length > 40 || (c.totalTextBytes as number) > (c.sourceFormat === 'csv' ? 528384 : 655360))) return null;
    // 旧 CSV 总字节统计包含预览窗口之外的已解析行/列。
    if (c.totalTextBytes !== sheetsSum && !(legacy && c.sourceFormat === 'csv' && (c.totalTextBytes as number) >= sheetsSum)) return null;
    return parsed as unknown as ExtractCache;
  }
  // slides
  if (typeof c.totalSlides !== 'number' || !Array.isArray(c.slides) || c.slides.length === 0) return null;
  let slidesSum = 0;
  for (let i = 0; i < c.slides.length; i += 1) {
    const sl = c.slides[i];
    if (!isPlainObject(sl) || sl.slide !== i + 1 || typeof sl.text !== 'string' || typeof sl.notes !== 'string' || typeof sl.truncated !== 'boolean') return null;
    const tb = byteLen(sl.text);
    const nb = byteLen(sl.notes);
    if (tb < 0 || nb < 0 || (!legacy && sl.truncated) || (legacy && (tb > 65536 || nb > 65536))) return null;
    slidesSum += tb + nb; // 备注计入总量（第三十轮三）
  }
  if (c.totalTextBytes !== slidesSum || !Number.isSafeInteger(c.totalSlides) || (c.totalSlides as number) < c.slides.length
    || (c.totalSlides !== c.slides.length && !(legacy && c.truncatedTotal))) return null;
  if (legacy && (slidesSum > 524288 || c.slides.length > 200)) return null;
  return parsed as unknown as ExtractCache;
}

// ---------- 任务/响应形状（父↔子） ----------
export type ParseJobKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'office' | 'pptx-pages'; // office=由 worker 按解压后的 [Content_Types] 定类（zip 条目已压缩——字面嗅探不可靠）；pptx-pages=静态页预览（第三十八轮：解压+SVG 转换重活进可终止子进程）

export interface ParseJob {
  jobId: string;
  kind: ParseJobKind;
  /** 托管副本绝对路径（worker 自读并核对 sha256——读取时点完整性）。 */
  blobPath: string;
  expectedHash: string;
  /** pptx-pages 专用：pages JSON 输出文件（大载荷走文件，
   * 父进程在响应后读取并校验）。 */
  outPath?: string;
  /** 受控故障注入（仅 ZS_TEST_PARSE_HOOKS=1 时由池附加——生产不设）。 */
  /** 受控故障注入（仅 ZS_TEST_PARSE_HOOKS=1 时由池附加——生产不设；allocMB=外部 Buffer 大额分配（整进程内存反例））。 */
  hooks?: { busyMs?: number; exitCode?: number; allocMB?: number };
}

export interface ParseResponse {
  jobId: string;
  ok: boolean;
  result?: ExtractCache & { artifactKind?: string };
  /** pptx-pages 成功回执（小载荷摘要——完整 JSON 在 outPath 文件）。 */
  pagesSummary?: { sourceHash: string; slides: number; pxW: number; pxH: number; truncatedPages: number; outBytes: number };
  error?: { code: string; message: string };
}

/** artifact kind ↔ 解析 kind/缓存 kind 映射（命令层与组装层共用）。 */
export const ARTIFACT_PARSE_KINDS: Record<string, { parse: ParseJobKind; cache: ExtractCache['kind'] }> = {
  pdf_file: { parse: 'pdf', cache: 'pdf' },
  docx_file: { parse: 'docx', cache: 'docx' },
  sheet_file: { parse: 'xlsx', cache: 'sheet' }, // csv 上传按 sourceFormat 进同一 kind
  slides_file: { parse: 'pptx', cache: 'slides' },
};

// ---------- 表格注入范围（第二十九轮四：范围选择进模型输入——不把全部工作表无界发送） ----------
export interface SheetRange { sheetName: string | null; r1: number; c1: number; r2: number; c2: number } // 0 基含端

export function colNameOf(c: number): string {
  let s = '';
  let n = c;
  for (;;) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; if (n < 0) break; }
  return s;
}
export function colOf(name: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(name)) return null;
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 解析 "Sheet1!A1:D20" / "A1:D20"（缺省工作表=首表）。null=格式不合法（错误文案）。 */
export function parseSheetRangeSpec(spec: string): SheetRange | { error: string } {
  const trimmed = spec.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return { error: '注入范围为空或超长' };
  let sheetName: string | null = null;
  let rangePart = trimmed;
  const bang = trimmed.lastIndexOf('!');
  if (bang >= 0) {
    sheetName = trimmed.slice(0, bang).replace(/^['"]|['"]$/g, '');
    rangePart = trimmed.slice(bang + 1);
    if (sheetName.length === 0) return { error: `注入范围工作表名为空：${spec}` };
  }
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(rangePart);
  if (m == null) return { error: `注入范围格式不合法（应为 工作表!A1:D20 或 A1:D20）：${spec}` };
  const c1 = colOf(m[1]!); const r1 = Number(m[2]!) - 1;
  const c2 = colOf(m[3]!); const r2 = Number(m[4]!) - 1;
  if (c1 == null || c2 == null || r1 < 0 || r2 < 0) return { error: `注入范围单元格引用不合法：${spec}` };
  return { sheetName, r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
}

/**
 * 表格缓存 → 有界注入文本。spec=null=有界默认窗口（首表前 50×16，如实标注截断）；
 * 范围越界/工作表不存在=错误文案（提交时校验、组装时 fail-closed）。
 */
export function renderSheetWindow(
  cache: ExtractCache & { kind: 'sheet' },
  spec: string | null | undefined,
  maxBytes: number,
): { ok: true; text: string; usedWindow: string; truncated: boolean } | { ok: false; error: string } {
  const NL = String.fromCharCode(10);
  let range: SheetRange;
  let windowLabel: string;
  let bounded = false;
  if (spec == null || spec.trim().length === 0) {
    const first = cache.sheets[0]!;
    range = { sheetName: first.name, r1: 0, c1: 0, r2: Math.min(first.rowCount, first.cells.length, SHEET_INJECT_DEFAULT_ROWS) - 1, c2: Math.min(first.colCount, SHEET_INJECT_DEFAULT_COLS) - 1 };
    if (range.r2 < 0) range.r2 = 0;
    if (range.c2 < 0) range.c2 = 0;
    bounded = true;
    windowLabel = `默认窗口 ${colNameOf(range.c1)}1:${colNameOf(range.c2)}${range.r2 + 1}（未选范围=有界默认，非全量）`;
  } else {
    const parsed = parseSheetRangeSpec(spec);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    range = parsed;
    windowLabel = `${colNameOf(range.c1)}${range.r1 + 1}:${colNameOf(range.c2)}${range.r2 + 1}`;
  }
  const sheet = range.sheetName == null ? cache.sheets[0]! : cache.sheets.find((s) => s.name === range.sheetName);
  if (sheet == null) return { ok: false, error: `注入范围引用的工作表不存在：「${range.sheetName}」（可用：${cache.sheets.map((s) => s.name).join('、')}）` };
  if (range.r1 >= sheet.rowCount || range.c1 >= sheet.colCount) {
    return { ok: false, error: `注入范围越界：${windowLabel} 超出工作表「${sheet.name}」实际 ${sheet.rowCount}×${sheet.colCount}` };
  }
  // 完整缓存范围之外不得以空串冒充。
  const winR = Math.min(sheet.rowCount, sheet.cells.length);
  const winC = cache.budgets.completePreview === 1 ? sheet.colCount : Math.min(sheet.colCount, 32);
  if (range.r2 >= winR || range.c2 >= winC) {
    return { ok: false, error: `注入范围超出可注入窗口（${colNameOf(range.c1)}${range.r1 + 1}:${colNameOf(range.c2)}${range.r2 + 1} → 窗口上限 ${colNameOf(winC - 1)}${winR}；更大数据请拆分范围或导出为文本附件）——不以窗口外空数据冒充` };
  }
  const rEnd = range.r2;
  const cEnd = range.c2;
  const clipped = bounded;
  let text = `【表格 ${cache.sourceFormat === 'csv' ? 'CSV' : 'XLSX'}】工作表「${sheet.name}」${windowLabel}（实际 ${sheet.rowCount}×${sheet.colCount}${clipped ? '，窗口有界截取' : ''}；公式不执行，值为缓存结果）${NL}`;
  let bytes = Buffer.byteLength(text, 'utf8');
  let truncated = false;
  for (let r = range.r1; r <= rEnd; r += 1) {
    const rowCells: string[] = [];
    for (let c = range.c1; c <= cEnd; c += 1) {
      const v = sheet.cells[r]?.[c] ?? '';
      rowCells.push(v);
    }
    const line = `${colNameOf(range.c1)}${r + 1} | ${rowCells.join(' | ')}${NL}`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (bytes + lineBytes > maxBytes) { truncated = true; break; }
    text += line;
    bytes += lineBytes;
  }
  if (truncated) text += `（注入窗口超出 ${maxBytes}B 字节预算——已截断，如需完整请缩小范围）${NL}`;
  return { ok: true, text, usedWindow: `${sheet.name}!${colNameOf(range.c1)}${range.r1 + 1}:${colNameOf(range.c2)}${rEnd + 1}`, truncated };
}
