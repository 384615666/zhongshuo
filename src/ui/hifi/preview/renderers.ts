/**
 * 共享预览渲染器装载（第五十二轮 H2 §6.1）：与旧界面 previewAttachment **同一合同/同一随包
 * 渲染器**——pdfjs ESM（特权协议下加载，worker 同源）、pptx-renderer 1.3.0（vendored ESM）、
 * docx-preview 0.4.1+JSZip（UMD）。不重做解析器、不引新渠道；EMF/内嵌 PDF 回退沿用显式关闭
 * （pdfjs:false）。加载路径相对 document.baseURI（与旧界面完全一致——同 index.html 基准）。
 */

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return u8;
}

type PdfjsLib = { getDocument: (opts: { data: Uint8Array; isEvalSupported?: boolean }) => { promise: Promise<PdfLikeDoc> }; GlobalWorkerOptions: { workerSrc: string } };
let pdfjsPromise: Promise<PdfjsLib> | null = null;
export interface PdfLikeDoc { numPages: number; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> } }> }
export function loadRendererPdfjs() {
  if (pdfjsPromise == null) {
    pdfjsPromise = import(new URL('assets/pdfjs/pdf.min.mjs', document.baseURI).href).then((lib) => {
      const typed = lib as unknown as PdfjsLib;
      typed.GlobalWorkerOptions.workerSrc = new URL('assets/pdfjs/pdf.worker.min.mjs', document.baseURI).href;
      return typed;
    });
  }
  return pdfjsPromise;
}

let pptxPromise: Promise<PptxLib> | null = null;
export interface PptxViewer {
  slideCount: number;
  zoomPercent: number;
  goToSlide(i: number): Promise<void>;
  setZoom(pct: number): Promise<void>;
  setFitMode(mode: 'contain'): Promise<void>;
  addEventListener(kind: 'slideerror', cb: (ev: { detail?: { index?: number } }) => void): void;
  dispose(): void;
}
export interface PptxLib {
  PptxViewer: { open(data: Uint8Array, stage: HTMLElement, opts: { renderMode: 'slide'; zipLimits: unknown; pdfjs: false; signal: AbortSignal }): Promise<PptxViewer> };
  RECOMMENDED_ZIP_LIMITS: unknown;
}
export function loadRendererPptx() {
  if (pptxPromise == null) pptxPromise = import(new URL('assets/vendor/pptx-renderer.es.mjs', document.baseURI).href) as Promise<PptxLib>;
  return pptxPromise;
}

function loadVendorScript(rel: string): Promise<void> {
  const existing = document.querySelector(`script[data-zs-vendor="${rel}"]`) as (HTMLScriptElement & { dataset: DOMStringMap }) | null;
  if (existing != null) {
    if (existing.dataset.loaded === 'true') return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`vendor 脚本加载失败：${rel}`)));
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL(rel, document.baseURI).href;
    s.dataset.zsVendor = rel;
    s.onload = () => { s.dataset.loaded = 'true'; resolve(); };
    s.onerror = () => reject(new Error(`vendor 脚本加载失败：${rel}`));
    document.head.append(s);
  });
}

interface DocxRenderer {
  renderAsync(data: Uint8Array, body: HTMLElement, host: HTMLElement, opts: { inWrapper: boolean; ignoreWidth: boolean; ignoreHeight: boolean; ignoreFonts: boolean; breakPages: boolean; useBase64URL: boolean; experimental: boolean; renderAltChunks: boolean }): Promise<void>;
}
let docxPromise: Promise<DocxRenderer> | null = null;
export function loadRendererDocxPreview() {
  if (docxPromise == null) {
    docxPromise = (async () => {
      await loadVendorScript('assets/vendor/jszip.min.js');
      await loadVendorScript('assets/vendor/docx-preview.min.js');
      const w = window as unknown as { docx?: DocxRenderer };
      if (w.docx == null) throw new Error('docx-preview 全局未就绪');
      return w.docx;
    })();
  }
  return docxPromise;
}
