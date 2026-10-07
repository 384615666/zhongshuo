/**
 * PPT 阅读视图（R69，对照 reference-ppt.png / ZCode pptx-preview-viewer.tsx @29628c9）：
 * 左缩略图列（IntersectionObserver 懒渲染+当前页描边+页码）+ 主舞台（fit×zoom 居中白页）+
 * 底部控制条「‹ [页码] / 总数 ›｜− 缩放% ＋｜下载原件」。提取文本不再铺在正文（入文件信息）。
 * 外部关系不加载、宏不执行（引擎侧静态渲染——与上传解析护栏同一边界）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../components/Icon';
import { openPptxDocument, type PptxPreviewDocument } from './pptxEngine';

function RenderedSlide({ doc, pageIndex, scale, onReady }: {
  doc: PptxPreviewDocument; pageIndex: number; scale: number; onReady?: () => void;
}): ReactElement {
  const mountRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const mount = mountRef.current;
    if (mount == null) return;
    let handle: ReturnType<PptxPreviewDocument['renderPage']> | null = null;
    try {
      handle = doc.renderPage(pageIndex, mount);
      void handle.ready.then(() => onReady?.(), () => { /* 页内节点失败：引擎按页分列 */ });
    } catch { /* 页码越界等——上层已按 pageCount 收敛 */ }
    return () => { handle?.dispose(); mount.replaceChildren(); };
  }, [doc, pageIndex, onReady]);
  return (
    <div
      className="pptx-slide-frame"
      style={{ width: doc.pageSize.width * scale, height: doc.pageSize.height * scale }}
    >
      <div
        ref={mountRef}
        className="pptx-slide-mount"
        style={{ width: doc.pageSize.width, height: doc.pageSize.height, transform: `scale(${scale})` }}
      />
    </div>
  );
}

function Thumbnail({ doc, pageIndex, selected, scrollRoot, onSelect }: {
  doc: PptxPreviewDocument; pageIndex: number; selected: boolean;
  scrollRoot: HTMLElement | null; onSelect: () => void;
}): ReactElement {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const btn = btnRef.current;
    if (btn == null || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => setVisible(e?.isIntersecting ?? false), { root: scrollRoot ?? undefined, rootMargin: '240px 0px' });
    io.observe(btn);
    return () => io.disconnect();
  }, [scrollRoot]);
  useEffect(() => {
    const btn = btnRef.current;
    if (btn == null) return;
    const update = () => setWidth(Math.max(0, btn.clientWidth - 12));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(btn);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (selected) btnRef.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const scale = width > 0 ? width / doc.pageSize.width : 0;
  return (
    <button
      ref={btnRef}
      type="button"
      className={`pptx-thumb${selected ? ' on' : ''}`}
      aria-current={selected ? 'page' : undefined}
      aria-label={`第 ${pageIndex + 1} 页`}
      onClick={onSelect}
    >
      <span className="pptx-thumb-canvas" style={{ aspectRatio: `${doc.pageSize.width} / ${doc.pageSize.height}` }}>
        {visible && scale > 0 ? <RenderedSlide doc={doc} pageIndex={pageIndex} scale={scale} /> : null}
      </span>
      <span className="pptx-thumb-no">{pageIndex + 1}</span>
    </button>
  );
}

function useElementSize(node: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (node == null) return;
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return size;
}

export function PptxView({ bytes, filename, revisionLabel, onDownload, onMeta }: {
  bytes: ArrayBuffer; filename: string; revisionLabel: string;
  onDownload: () => void; onMeta?: (meta: { pages: number; page: number }) => void;
}): ReactElement {
  const [doc, setDoc] = useState<PptxPreviewDocument | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoomPercent, setZoomPercent] = useState(100);
  const [thumbRoot, setThumbRoot] = useState<HTMLElement | null>(null);
  const [stageViewport, setStageViewport] = useState<HTMLElement | null>(null);
  const viewportSize = useElementSize(stageViewport);
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    let opened: PptxPreviewDocument | null = null;
    setDoc(null); setErr(null); setPageNumber(1); setPageInput('1'); setZoomPercent(100);
    void openPptxDocument(bytes.slice(0))
      .then((d) => {
        opened = d;
        if (gen !== genRef.current) { d.dispose(); return; }
        setDoc(d);
        onMeta?.({ pages: d.pageCount, page: 1 });
      })
      .catch((e: unknown) => { if (gen === genRef.current) setErr(String((e as Error).message).slice(0, 160)); });
    return () => {
      genRef.current += 1; // 迟到结果只能释放资源，不污染新会话
      opened?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  const goToPage = useCallback((target: number) => {
    setDoc((d) => {
      if (d == null || d.pageCount === 0) return d;
      const next = Math.min(Math.max(1, Math.round(target)), d.pageCount);
      setPageInput(String(next));
      setPageNumber(next);
      onMeta?.({ pages: d.pageCount, page: next });
      return d;
    });
  }, [onMeta]);
  const commitPageInput = () => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(parsed)) { setPageInput(String(pageNumber)); return; }
    goToPage(parsed);
  };

  const mainScale = useMemo(() => {
    if (doc == null || viewportSize.width === 0 || viewportSize.height === 0) return 1;
    const fit = Math.min(
      Math.max(1, viewportSize.width - 32) / doc.pageSize.width,
      Math.max(1, viewportSize.height - 32) / doc.pageSize.height,
    );
    return fit * (zoomPercent / 100);
  }, [doc, viewportSize, zoomPercent]);

  if (err != null) {
    return (
      <div className="preview-unsupported" data-zs-pptx-error={err.slice(0, 40)}>
        <Icon name="alert-triangle" size={20} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>幻灯片渲染失败</div>
        <div className="small muted" style={{ marginTop: 6, maxWidth: 440, lineHeight: 1.7 }}>{err}——原件已保存（{revisionLabel}），可下载后用系统工具打开；提取文本见「文件信息」。</div>
        <div className="panel-actions"><button className="btn sm" onClick={onDownload}><Icon name="download" size={12} /> 下载原文件</button></div>
      </div>
    );
  }
  if (doc == null) return <div className="panel info" data-zs-pptx-loading="1">正在打开幻灯片（解析 {filename}）…</div>;
  if (doc.pageCount === 0) return <div className="panel info">这份演示文稿没有任何幻灯片（0 页——如实呈现）。</div>;

  return (
    <div className="pptx-view" data-zs-pptx-view="1" data-zs-pptx-pages={doc.pageCount}>
      <aside className="pptx-thumbs" ref={setThumbRoot} aria-label="幻灯片缩略图">
        {Array.from({ length: doc.pageCount }, (_, i) => (
          <Thumbnail key={i} doc={doc} pageIndex={i} selected={i === pageNumber - 1} scrollRoot={thumbRoot} onSelect={() => goToPage(i + 1)} />
        ))}
      </aside>
      <div className="pptx-main">
        <div className="pptx-stage" ref={setStageViewport}>
          <div className="pptx-stage-inner">
            <RenderedSlide doc={doc} pageIndex={pageNumber - 1} scale={mainScale} />
          </div>
        </div>
        <div className="preview-bottom-bar" data-zs-pptx-bar="1">
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
          <span className="pptx-page-total">/ {doc.pageCount}</span>
          <button className="preview-icon-btn" aria-label="下一页" disabled={pageNumber >= doc.pageCount} onClick={() => goToPage(pageNumber + 1)}><Icon name="chevron-right" size={14} /></button>
          <span className="pptx-bar-sep" />
          <button className="preview-icon-btn" aria-label="缩小" disabled={zoomPercent <= 25} onClick={() => setZoomPercent((z) => Math.max(25, z - 25))}><Icon name="zoom-out" size={14} /></button>
          <span className="pptx-zoom-label">{zoomPercent}%</span>
          <button className="preview-icon-btn" aria-label="放大" disabled={zoomPercent >= 400} onClick={() => setZoomPercent((z) => Math.min(400, z + 25))}><Icon name="zoom-in" size={14} /></button>
          <span className="pptx-bar-sep" />
          <button className="preview-icon-btn" aria-label="下载原文件" title="保存这份 PPT 的原件字节（另存为）" onClick={onDownload}><Icon name="download" size={14} /></button>
        </div>
      </div>
    </div>
  );
}
