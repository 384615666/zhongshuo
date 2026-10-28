import { userFacingSystemText } from '../../../../contracts/userFacingText';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readerStateOf, saveReaderState } from '../readerState';

/** Offline browser decoding; persisted view state is bound to resource + revision. */
export function ImageView({ resourceId, revision, dataUrl, filename, onRetry, onDownload }: {
  resourceId: string; revision: number; dataUrl: string; filename: string;
  onRetry: () => void; onDownload: () => void;
}) {
  const saved = readerStateOf(resourceId, revision);
  const initial = saved?.kind === 'image' ? saved : undefined;
  const [zoom, setZoom] = useState(initial?.zoom ?? 0);
  const [offset, setOffset] = useState({ x: initial?.x ?? 0, y: initial?.y ?? 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el == null) return;
    setBox({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    saveReaderState(resourceId, revision, { kind: 'image', zoom, ...offset });
  }, [resourceId, revision, zoom, offset]);
  const fit = size.width > 0 ? Math.min(box.width / size.width, box.height / size.height, 1) : 1;
  const scale = zoom === 0 ? fit : zoom;
  const chooseZoom = (value: number) => { setZoom(value); setOffset({ x: 0, y: 0 }); };
  const visibleLayout = box.width > 0 && box.height > 0;
  return <div className="zs-image-reader" data-zs-image-stage="1" data-zs-image-status={error != null ? 'error' : size.width > 0 && visibleLayout ? 'decoded' : 'decoding'}>
    <div className="zs-image-tools" role="group" aria-label="图片缩放">
      <button className="btn sm" onClick={() => chooseZoom(0)}>适应窗口</button>
      <button className="btn sm" onClick={() => chooseZoom(1)}>原尺寸</button>
      <button className="btn sm" title="缩小图片" onClick={() => setZoom(Math.max(0.05, scale / 1.25))}>−</button>
      <span>{Math.round(scale * 100)}%</span>
      <button className="btn sm" title="放大图片" onClick={() => setZoom(Math.min(16, scale * 1.25))}>＋</button>
      <button className="btn sm" onClick={() => chooseZoom(0)}>复位</button>
      <button className="btn sm" onClick={onDownload}>另存原件</button>
    </div>
    <div ref={viewport} className="zs-image-viewport"
      onPointerDown={(e) => { if (error != null) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }; }}
      onPointerMove={(e) => { const d = drag.current; if (d != null) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <img src={dataUrl} alt={filename} draggable={false} data-zs-image-preview="hifi"
        onLoad={(e) => { const img = e.currentTarget; if (img.naturalWidth === 0 || img.naturalHeight === 0) setError('浏览器未解码出有效图片尺寸'); else { setError(null); setSize({ width: img.naturalWidth, height: img.naturalHeight }); } }}
        onError={() => setError('图片字节已读取，但浏览器无法解码。文件可能损坏或格式不受支持；已保存原件保留。')}
        style={{ width: size.width > 0 ? size.width * scale : undefined, height: size.height > 0 ? size.height * scale : undefined,
          visibility: size.width > 0 && visibleLayout && error == null ? 'visible' : 'hidden', transform: `translate(${offset.x}px, ${offset.y}px)` }} />
      {error != null ? <div className="zs-image-error" role="alert" data-zs-preview-error={error}>{userFacingSystemText(error ?? '')}<button className="btn sm" onClick={onRetry}>重试预览</button><button className="btn sm" onClick={onDownload}>另存原件</button></div> : null}
    </div>
    <div className="small faint">{error != null ? '预览失败' : size.width > 0 && visibleLayout ? `${size.width} × ${size.height} · 拖动查看` : '正在解码和布局图片…'}</div>
  </div>;
}
