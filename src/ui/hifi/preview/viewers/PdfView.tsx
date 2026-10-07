/**
 * PDF 阅读视图（R69 建立 / R70 修 fit 观察器+DPR+阅读状态）：白纸单页居中、
 * **按真实面板 contain 适应**（观察器挂在真实渲染节点上——loading 态也先挂壳，宽度与
 * 高度变化都重算；旧实现 observer 初次跑在 null 节点上永不生效，缩窄后画布越界）。
 * 页码/缩放按 资源+读取版本 存取；快翻 renderTask 取消；DPR 感知清晰度。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../components/Icon';
import { loadRendererPdfjs, type PdfLikeDoc } from '../renderers';
import { saveReaderState, type ReaderState } from '../readerState';

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200];

export function PdfView({ bytes, filename, revisionLabel, onDownload, resourceId, revision, initialState }: {
  bytes: Uint8Array; filename: string; revisionLabel: string;
  onDownload: () => void;
  resourceId?: string; revision?: number; initialState?: ReaderState;
}): ReactElement {
  const restored = initialState?.kind === 'pdf' ? initialState : null;
  const [doc, setDoc] = useState<PdfLikeDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(restored?.page ?? 1);
  const [pageInput, setPageInput] = useState(String(restored?.page ?? 1));
  const [zoomMode, setZoomMode] = useState<'fit' | number>(restored?.zoomMode ?? 'fit');
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const genRef = useRef(0);
  const didOpenRef = useRef(false);

  // 观察器挂真实节点：.pdf-stage 壳在 loading 期就渲染（旧实现 loading 早退导致节点缺失，
  // observer 空挂）。doc 就位后再校正一轮尺寸。
  const observeStage = () => {
    const el = stageRef.current;
    if (el == null) return () => {};
    const update = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  };
  useEffect(observeStage, []);
  useEffect(observeStage, [doc != null]);

  // 阅读状态保存（资源+版本）。
  useEffect(() => {
    if (resourceId == null || revision == null || doc == null) return;
    saveReaderState(resourceId, revision, { kind: 'pdf', page: pageNumber, zoomMode });
  }, [resourceId, revision, doc, pageNumber, zoomMode]);

  // 文档打开（bytes=稳定引用；复制防 transfer detach；切换/卸载销毁；迟到只释放自身）。
  useEffect(() => {
    const gen = ++genRef.current;
    let opened: PdfLikeDoc | null = null;
    const firstMount = !didOpenRef.current;
    didOpenRef.current = true;
    setDoc(null); setErr(null);
    // R70 F4：首挂保留 readerState 恢复的页码/缩放；换文件/换快照才复位。
    if (!firstMount || restored == null) { setPageNumber(1); setPageInput('1'); setZoomMode('fit'); }
    void loadRendererPdfjs().then(async (lib) => {
      opened = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      if (gen !== genRef.current) { void opened.destroy(); return; }
      docRef.current = opened;
      setDoc(opened);
      if (firstMount && restored != null) {
        const target = Math.min(Math.max(1, restored.page), opened.numPages);
        setPageInput(String(target));
        setPageNumber(target);
      }
    }).catch((e: unknown) => { if (gen === genRef.current) setErr(String((e as Error).message).slice(0, 160)); });
    return () => {
      genRef.current += 1;
      docRef.current = null;
      try { renderTaskRef.current?.cancel(); } catch { /* 已结束 */ }
      void opened?.destroy().catch(() => { /* 已销毁 */ });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  // 页渲染：fit=舞台内容区 contain（宽/高都受限）；绝对倍率按步进；DPR 感知像素密度。
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
        const margin = 56;
        const fitW = stageSize.w > 0 ? (stageSize.w - margin) / base.width : 1;
        const fitH = stageSize.h > 0 ? (stageSize.h - margin) / base.height : Infinity;
        const fit = Math.max(0.2, Math.min(fitW, fitH === Infinity ? fitW : fitH, 3));
        const scale = zoomMode === 'fit' ? fit : zoomMode / 100;
        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext('2d');
        if (ctx != null) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (ctx == null) return;
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (e) {
        if (!cancelled) setErr(`页面渲染失败：${String((e as Error).message).slice(0, 120)}`);
      } finally {
        if (!cancelled) renderTaskRef.current = null;
      }
    })();
    return () => { cancelled = true; try { renderTaskRef.current?.cancel(); } catch { /* 已结束 */ } };
  }, [doc, pageNumber, zoomMode, stageSize]);

  // R70 修复：直接 set（去 setDoc updater 嵌套 setState——同 PptxView）。
  const docRef = useRef<PdfLikeDoc | null>(null);
  const goToPage = useCallback((target: number) => {
    const d = docRef.current;
    if (d == null) return;
    const next = Math.min(Math.max(1, Math.round(target)), d.numPages);
    setPageInput(String(next));
    setPageNumber(next);
  }, []);
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
  return (
    <div className="pdf-view" data-zs-pdf-view="1" data-zs-pdf-pages={doc?.numPages ?? ''} data-zs-pdf-page={pageNumber} data-zs-pdf-zoom={zoomMode === 'fit' ? 'fit' : `${zoomMode}%`}>
      <div className="pdf-stage" ref={stageRef}>
        <div className="pdf-stage-inner">
          {doc == null ? <div className="panel info" data-zs-pdf-loading="1">正在打开 PDF（{filename}）…</div> : (
            <canvas ref={canvasRef} className="pdf-canvas" data-zs-pdf-canvas="r70" />
          )}
        </div>
      </div>
      <div className="preview-bottom-bar" data-zs-pdf-bar="1">
        <button className="preview-icon-btn" aria-label="上一页" disabled={doc == null || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><Icon name="chevron-left" size={14} /></button>
        <input
          className="pptx-page-input"
          type="text"
          inputMode="numeric"
          aria-label="页码"
          value={pageInput}
          disabled={doc == null}
          onChange={(e) => setPageInput(e.target.value)}
          onBlur={commitPageInput}
          onKeyDown={(e) => { if (e.key === 'Enter') { commitPageInput(); e.currentTarget.blur(); } }}
        />
        <span className="pptx-page-total">/ {doc?.numPages ?? '-'}</span>
        <button className="preview-icon-btn" aria-label="下一页" disabled={doc == null || pageNumber >= (doc?.numPages ?? 1)} onClick={() => goToPage(pageNumber + 1)}><Icon name="chevron-right" size={14} /></button>
        <span className="pptx-bar-sep" />
        <button className="preview-icon-btn" aria-label="缩小" onClick={zoomOut}><Icon name="zoom-out" size={14} /></button>
        <span className="pptx-zoom-label">{zoomMode === 'fit' ? '适应' : `${zoomMode}%`}</span>
        <button className="preview-icon-btn" aria-label="放大" onClick={zoomIn}><Icon name="zoom-in" size={14} /></button>
        <button className="preview-icon-btn" aria-label="适应面板宽度" title="按面板实际宽高适应显示" onClick={() => setZoomMode('fit')}><Icon name="maximize" size={13} /></button>
        <span className="pptx-bar-sep" />
        <button className="preview-icon-btn" aria-label="下载原文件" title="保存这份 PDF 的原件字节（另存为）" onClick={onDownload}><Icon name="download" size={14} /></button>
      </div>
    </div>
  );
}
