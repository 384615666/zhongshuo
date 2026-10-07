/**
 * PDF 阅读视图（R69，对照 reference-pdf.png / ZCode pdf-viewer.tsx @29628c9 的单页模式）：
 * 白纸单页居中连续阅读、**按真实面板宽度适应**（fit=面板内容宽/纸宽——旧实现固定 480px）、
 * 底部控制条「‹ [页码] / 总数 ›｜− 缩放% ＋」。字节一次取全量（≤20MiB 上传链已限），
 * 翻页/缩放本地 canvas 渲染（服务端零像素解码）；提取文本入文件信息不铺正文。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../components/Icon';
import { loadRendererPdfjs, type PdfLikeDoc } from '../renderers';

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200];

export function PdfView({ bytes, filename, revisionLabel, onDownload, onMeta }: {
  bytes: Uint8Array; filename: string; revisionLabel: string;
  onDownload: () => void; onMeta?: (meta: { pages: number; page: number }) => void;
}): ReactElement {
  const [doc, setDoc] = useState<PdfLikeDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [paperSize, setPaperSize] = useState<{ w: number; h: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);
  const [viewportW, setViewportW] = useState(0);
  const genRef = useRef(0);

  // 文档打开（字节复制防 detach；切换/卸载销毁）。
  useEffect(() => {
    const gen = ++genRef.current;
    let opened: PdfLikeDoc | null = null;
    setDoc(null); setErr(null); setPageNumber(1); setPageInput('1'); setPaperSize(null);
    void loadRendererPdfjs().then(async (lib) => {
      opened = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      if (gen !== genRef.current) { void opened.destroy(); return; }
      setDoc(opened);
      onMeta?.({ pages: opened.numPages, page: 1 });
    }).catch((e: unknown) => { if (gen === genRef.current) setErr(String((e as Error).message).slice(0, 160)); });
    return () => {
      genRef.current += 1;
      try { renderTaskRef.current?.cancel(); } catch { /* 已结束 */ }
      void opened?.destroy().catch(() => { /* 已销毁 */ });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  // 面板宽度观测（fit 基准=真实内容宽）。
  useEffect(() => {
    const el = viewportRef.current;
    if (el == null) return;
    const update = () => setViewportW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 页渲染：fit=面板宽-32 与 fit 高度取小（不放大超 1.5 倍防糊），绝对倍率按步进值。
  useEffect(() => {
    if (doc == null || canvasRef.current == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const canvas = canvasRef.current;
        if (canvas == null) return;
        const pageNo = Math.min(Math.max(1, pageNumber), doc.numPages);
        const page = await doc.getPage(pageNo);
        if (cancelled || canvasRef.current == null) return;
        const base = page.getViewport({ scale: 1 });
        const fitW = viewportW > 0 ? (viewportW - 56) / base.width : 1;
        const fitH = (viewportRef.current?.clientHeight ?? 0) > 0 ? ((viewportRef.current!.clientHeight!) - 56) / base.height : Infinity;
        const fit = Math.min(Math.min(fitW, fitH) || fitW, 2);
        const scale = zoomMode === 'fit' ? Math.max(0.2, fit) : zoomMode / 100;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        setPaperSize({ w: base.width, h: base.height });
        const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (e) {
        if (!cancelled) setErr(`页面渲染失败：${String((e as Error).message).slice(0, 120)}`);
      } finally {
        if (!cancelled) renderTaskRef.current = null;
      }
    })();
    return () => { cancelled = true; try { renderTaskRef.current?.cancel(); } catch { /* 已结束 */ } };
  }, [doc, pageNumber, zoomMode, viewportW]);

  const goToPage = useCallback((target: number) => {
    setDoc((d) => {
      if (d == null) return d;
      const next = Math.min(Math.max(1, Math.round(target)), d.numPages);
      setPageInput(String(next));
      setPageNumber(next);
      onMeta?.({ pages: d.numPages, page: next });
      return d;
    });
  }, [onMeta]);
  const commitPageInput = () => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(parsed)) { setPageInput(String(pageNumber)); return; }
    goToPage(parsed);
  };
  const zoomOut = () => setZoomMode((z) => {
    const cur = z === 'fit' ? 100 : z;
    const next = ZOOM_STEPS.filter((s) => s < cur).pop();
    return next ?? Math.max(25, cur - 25);
  });
  const zoomIn = () => setZoomMode((z) => {
    const cur = z === 'fit' ? 100 : z;
    const next = [...ZOOM_STEPS].reverse().find((s) => s > cur);
    return next ?? Math.min(400, cur + 25);
  });

  if (err != null) {
    return (
      <div className="preview-unsupported" data-zs-pdf-error={err.slice(0, 40)}>
        <Icon name="alert-triangle" size={20} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>PDF 渲染失败</div>
        <div className="small muted" style={{ marginTop: 6, maxWidth: 440, lineHeight: 1.7 }}>{err}——原件已保存（{revisionLabel}），可下载后用系统工具打开。</div>
        <div className="panel-actions"><button className="btn sm" onClick={onDownload}><Icon name="download" size={12} /> 下载原文件</button></div>
      </div>
    );
  }
  if (doc == null) return <div className="panel info" data-zs-pdf-loading="1">正在打开 PDF（{filename}）…</div>;
  return (
    <div className="pdf-view" data-zs-pdf-view="1" data-zs-pdf-pages={doc.numPages}>
      <div className="pdf-stage" ref={viewportRef}>
        <div className="pdf-stage-inner">
          <canvas ref={canvasRef} className="pdf-canvas" data-zs-pdf-canvas="r69" />
        </div>
      </div>
      <div className="preview-bottom-bar" data-zs-pdf-bar="1">
        <button className="preview-icon-btn" aria-label="上一页" disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><Icon name="chevron-left" size={14} /></button>
        <input
          className="pptx-page-input"
          type="text"
          inputMode="numeric"
          aria-label="页码"
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onBlur={commitPageInput}
          onKeyDown={(e) => { if (e.key === 'Enter') { commitPageInput(); e.currentTarget.blur(); } }}
        />
        <span className="pptx-page-total">/ {doc.numPages}</span>
        <button className="preview-icon-btn" aria-label="下一页" disabled={pageNumber >= doc.numPages} onClick={() => goToPage(pageNumber + 1)}><Icon name="chevron-right" size={14} /></button>
        <span className="pptx-bar-sep" />
        <button className="preview-icon-btn" aria-label="缩小" onClick={zoomOut}><Icon name="zoom-out" size={14} /></button>
        <span className="pptx-zoom-label">{zoomMode === 'fit' ? '适应' : `${zoomMode}%`}</span>
        <button className="preview-icon-btn" aria-label="放大" onClick={zoomIn}><Icon name="zoom-in" size={14} /></button>
        <button className="preview-icon-btn" aria-label="适应面板宽度" title="按面板实际宽度适应显示" onClick={() => setZoomMode('fit')}><Icon name="maximize" size={13} /></button>
        <span className="pptx-bar-sep" />
        <button className="preview-icon-btn" aria-label="下载原文件" title="保存这份 PDF 的原件字节（另存为）" onClick={onDownload}><Icon name="download" size={14} /></button>
      </div>
    </div>
  );
}
