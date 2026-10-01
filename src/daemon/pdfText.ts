/**
 * PDF 附件文本提取（第二十八轮五）——pdfjs-dist（纯 JS legacy 构建，随 daemon 打包携带，
 * 无网络/无系统字体/无原生 canvas 依赖；解析在进程内隔离：isEvalSupported=false（不执行
 * PDF 内脚本）、disableFontFace/useSystemFonts=false（不碰宿主字体），文本层提取）。
 * - 像素级页面渲染=未实施（需 canvas 原生依赖——明确 unsupported，预览为文本层+页结构）；
 * - 加密（PasswordException）→ 明确错误；损坏/截断 → 解析错误如实；页数/大小/单页文本上限
 *   明确规则；整体超时 10s（挂起解析不拖垮命令）。
 * 提取结果缓存于 artifacts.extracted_text_json（迁移 035——同 hash 不重复解析）。
 */
import { getDocument, PasswordResponses, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// worker 随包（第二十八轮五）：打包产物同目录 pdf.worker.mjs 存在则指定；源码/测试
// 运行（node_modules 可解析）走 pdfjs 默认。esbuild cjs 输出下 __dirname=产物目录。
try {
  const bundledWorker = join(typeof __dirname === 'string' ? __dirname : '.', 'pdf.worker.mjs');
  if (existsSync(bundledWorker)) GlobalWorkerOptions.workerSrc = pathToFileURL(bundledWorker).href; // Windows 绝对路径须 file:// URL（pdfjs 动态 import）
} catch { /* 指向失败回落默认解析 */ }

export const PDF_MAX_BYTES = 20 * 1024 * 1024; // 原件上限
export const PDF_MAX_PAGES = 200; // 页数上限
export const PDF_PAGE_TEXT_MAX = 64 * 1024; // 单页提取文本上限（字节）
export const PDF_EXTRACT_TIMEOUT_MS = 10_000;

export interface PdfExtractPage { page: number; text: string; truncated: boolean }
export interface PdfExtractResult { pages: PdfExtractPage[]; extractedAt: number; sourceHash: string; modelVersion: string }

export type PdfExtractError =
  | { code: 'pdf-encrypted'; message: string }
  | { code: 'pdf-corrupt'; message: string }
  | { code: 'pdf-too-many-pages'; message: string }
  | { code: 'pdf-timeout'; message: string };

function isPdfMagic(raw: Buffer): boolean {
  // %PDF- 应在前 1024 字节内（规范允许前导空白/注释；实操取头部窗口）
  const head = raw.subarray(0, Math.min(raw.length, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

/** 提取全文（逐页文本层；每页独立截断注明）。失败三态：加密/损坏/超页数；整体超时。 */
export async function extractPdfText(raw: Buffer, sourceHash: string): Promise<{ ok: true; result: PdfExtractResult } | { ok: false; error: PdfExtractError }> {
  if (!isPdfMagic(raw)) return { ok: false, error: { code: 'pdf-corrupt', message: '内容不是 PDF（%PDF- 头缺失——不以扩展名冒充）' } };
  let doc: import('pdfjs-dist/types/src/display/api.js').PDFDocumentProxy;
  try {
    const task = getDocument({
      data: new Uint8Array(raw), // 拷贝给 pdfjs（其转移所有权）
      isEvalSupported: false, // 隔离：不执行 PDF 内脚本
      disableFontFace: true,
      useSystemFonts: false, // 不读宿主字体
      verbosity: 0,
    });
    doc = await Promise.race([
      task.promise,
      new Promise<never>((_, reject) => setTimeout(() => { void task.destroy(); reject(new Error('pdf-extract-timeout')); }, PDF_EXTRACT_TIMEOUT_MS).unref?.()),
    ]);
  } catch (error) {
    const name = (error as { name?: string }).name ?? '';
    if (name === 'PasswordException' || (error as { code?: number }).code === PasswordResponses.INCORRECT_PASSWORD) {
      return { ok: false, error: { code: 'pdf-encrypted', message: 'PDF 已加密：需要密码——明确不支持（不请求密码/不跳过解密）' } };
    }
    if ((error as Error).message === 'pdf-extract-timeout') {
      return { ok: false, error: { code: 'pdf-timeout', message: `PDF 解析超时（${PDF_EXTRACT_TIMEOUT_MS}ms）——资源限制如实拒绝` } };
    }
    return { ok: false, error: { code: 'pdf-corrupt', message: `PDF 解析失败（${(error as Error).message?.slice(0, 120)}）——损坏或非标准结构` } };
  }
  try {
    if (doc.numPages > PDF_MAX_PAGES) {
      return { ok: false, error: { code: 'pdf-too-many-pages', message: `PDF 页数 ${doc.numPages} 超过上限 ${PDF_MAX_PAGES}（明确规则拒绝）` } };
    }
    const pages: PdfExtractPage[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str === 'string') text += item.str + (item.hasEOL ? '\n' : '');
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      const truncated = bytes > PDF_PAGE_TEXT_MAX;
      if (truncated) {
        // 按字节截断（复用文本附件口径——保留完整字符）
        const buf = Buffer.from(text, 'utf8');
        let end = PDF_PAGE_TEXT_MAX;
        while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
        text = buf.subarray(0, end).toString('utf8');
      }
      pages.push({ page: p, text, truncated });
    }
    return { ok: true, result: { pages, extractedAt: Date.now(), sourceHash, modelVersion: 'pdfjs-dist/legacy' } };
  } catch (error) {
    return { ok: false, error: { code: 'pdf-corrupt', message: `PDF 页提取失败（${(error as Error).message?.slice(0, 120)}）` } };
  } finally {
    void doc.destroy().catch(() => { /* 尽力释放 */ });
  }
}
