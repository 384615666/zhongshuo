import { userFacingSystemText } from '../../../../contracts/userFacingText';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu, MenuItem } from '../../components/ui';
import { toast } from '../../data/store';
import { readerStateOf, saveReaderState } from '../readerState';

/**
 * R197：图片右键复制。优先走 preload 注入的主进程剪贴板桥（系统剪贴板能力完整），
 * 桥缺失或失败再退回浏览器端 canvas 写剪贴板；两者都失败时给中文提示，不假装成功。
 * 桥由 preload/main 的 zsClipboard.copyImage 提供，这里做局部类型断言，不依赖全局声明。
 */
interface ImageClipboardBridge {
  copyImage?: (dataUrl: string) => Promise<{ ok: boolean; error?: string }>;
}

function imageClipboardBridge(): ImageClipboardBridge | null {
  const candidate = (window as unknown as { zsClipboard?: ImageClipboardBridge }).zsClipboard;
  return candidate != null && typeof candidate.copyImage === 'function' ? candidate : null;
}

/** 浏览器剪贴板降级：解码预览图 → 画到 canvas → 以 PNG 写入系统剪贴板。 */
async function copyImageWithBrowser(source: string): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write == null) return false;
  const blob = await (await fetch(source)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context == null) return false;
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => { canvas.toBlob((next) => resolve(next), 'image/png'); });
    canvas.width = 0;
    canvas.height = 0;
    if (png == null) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } finally {
    bitmap.close();
  }
}

/** Offline browser decoding; persisted view state is bound to resource + revision. */
export function ImageView({ resourceId, revision, dataUrl, filename, onRetry, onDownload, imageWidth, imageHeight }: {
  resourceId: string; revision: number; dataUrl: string; filename: string;
  imageWidth?:number; imageHeight?:number;
  onRetry: () => void; onDownload: () => void;
}) {
  const saved = readerStateOf(resourceId, revision);
  const initial = saved?.kind === 'image' ? saved : undefined;
  const [zoom, setZoom] = useState(initial?.zoom ?? 0);
  const [offset, setOffset] = useState({ x: initial?.x ?? 0, y: initial?.y ?? 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [previewUrl,setPreviewUrl]=useState<string|null>(null);
  const [original,setOriginal]=useState(false);
  const [imageMenu,setImageMenu]=useState<{x:number;y:number}|null>(null);
  useEffect(()=>{
    let live=true,url:string|null=null;
    setPreviewUrl(null);
    if(original||!imageWidth||!imageHeight||Math.max(imageWidth,imageHeight)<=4096){setPreviewUrl(dataUrl);return;}
    const ratio=Math.min(1,4096/Math.max(imageWidth,imageHeight));
    void fetch(dataUrl).then(r=>r.blob()).then(blob=>createImageBitmap(blob,{
      resizeWidth:Math.max(1,Math.round(imageWidth*ratio)),resizeHeight:Math.max(1,Math.round(imageHeight*ratio)),resizeQuality:'high',
    })).then(async bitmap=>{
      try {
        if(!live)return;
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        const ctx=canvas.getContext('2d');if(!ctx)throw Error('无法创建图片预览');ctx.drawImage(bitmap,0,0);
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('图片预览生成失败'))));
        canvas.width=canvas.height=0;
        if(live){url=URL.createObjectURL(blob);setPreviewUrl(url);}
      }finally{bitmap.close();}
    }).catch(()=>{if(live)setError('图片无法解码，文件可能损坏或尺寸过大；可另存原件。');});
    return()=>{live=false;if(url)URL.revokeObjectURL(url);};
  },[dataUrl,imageWidth,imageHeight,original]);
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
  const openImageMenu = (at: { clientX: number; clientY: number }) => {
    setImageMenu({ x: at.clientX, y: at.clientY });
  };
  const copyImage = async (): Promise<void> => {
    setImageMenu(null);
    const bridge = imageClipboardBridge();
    // 主进程桥只认 data URL：预览若是降采样后的 blob 地址，就改复制原件字节。
    const source = previewUrl != null && previewUrl.startsWith('data:') ? previewUrl : dataUrl;
    let ok = false;
    if (bridge?.copyImage != null) {
      try { ok = (await bridge.copyImage(source)).ok === true; } catch { ok = false; }
    }
    if (!ok) {
      try { ok = await copyImageWithBrowser(previewUrl ?? dataUrl); } catch { ok = false; }
    }
    toast(ok ? '图片已复制' : '图片复制失败，剪贴板暂不可用', ok ? 'success' : 'error');
  };
  return <div className="zs-image-reader" data-zs-image-stage="1" data-zs-image-status={error != null ? 'error' : size.width > 0 && visibleLayout ? 'decoded' : 'decoding'}
    onContextMenu={(e) => {
      // R197：图片舞台与画布弹出复制菜单；缩放工具栏保留原生右键，菜单内部右键也不再挪菜单。
      if ((e.target as Element).closest('.zs-image-tools, .menu') != null) return;
      e.preventDefault();
      openImageMenu(e);
    }}>
    <div className="zs-image-tools" role="group" aria-label="图片缩放">
      <button className="btn sm" onClick={() => chooseZoom(0)}>适应窗口</button>
      <button className="btn sm" onClick={() => {setOriginal(true);chooseZoom(1);}}>原尺寸</button>
      <button className="btn sm" title="缩小图片" onClick={() => setZoom(Math.max(0.05, scale / 1.25))}>−</button>
      <span>{Math.round(scale * 100)}%</span>
      <button className="btn sm" title="放大图片" onClick={() => setZoom(Math.min(16, scale * 1.25))}>＋</button>
      <button className="btn sm" onClick={() => chooseZoom(0)}>复位</button>
      <button className="btn sm" onClick={onDownload}>另存原件</button>
    </div>
    <div ref={viewport} className="zs-image-viewport"
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openImageMenu(e); }}
      onPointerDown={(e) => { if (error != null || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }; }}
      onPointerMove={(e) => { const d = drag.current; if (d != null) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {previewUrl ? <img src={previewUrl} alt={filename} draggable={false} data-zs-image-preview="hifi"
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openImageMenu(e); }}
        onLoad={(e) => { const img = e.currentTarget; if (img.naturalWidth === 0 || img.naturalHeight === 0) setError('图片尺寸无法读取'); else { setError(null); setSize({ width: imageWidth??img.naturalWidth, height: imageHeight??img.naturalHeight }); } }}
        onError={() => setError('图片无法解码，文件可能损坏或格式不受支持；原件已保存。')}
        style={{ width: size.width > 0 ? size.width * scale : undefined, height: size.height > 0 ? size.height * scale : undefined,
          visibility: size.width > 0 && visibleLayout && error == null ? 'visible' : 'hidden', transform: `translate(${offset.x}px, ${offset.y}px)` }} /> : null}
      {error != null ? <div className="zs-image-error" role="alert" data-zs-preview-error={error}>{userFacingSystemText(error ?? '')}<button className="btn sm" onClick={onRetry}>重试预览</button><button className="btn sm" onClick={onDownload}>另存原件</button></div> : null}
    </div>
    <div className="small faint">{error != null ? '预览失败' : size.width > 0 && visibleLayout ? `${size.width} × ${size.height} · 拖动查看` : '正在显示图片…'}</div>
    {imageMenu != null ? (
      <Menu anchor={imageMenu} onClose={() => setImageMenu(null)}>
        {/* 共享 MenuItem 不透传 data-*：稳定钩子与动作放在包裹层，点击菜单项冒泡到这里只触发一次。 */}
        <div role="none" data-zs-preview-image-menu="1">
          <div role="none" data-zs-copy-image="1" style={{ display: 'contents' }} onClick={() => void copyImage()}>
            <MenuItem icon="copy" title="把这张图片复制到系统剪贴板，可直接粘贴到其他软件">复制图片</MenuItem>
          </div>
          <div role="none" data-zs-copy-image-download="1" style={{ display: 'contents' }} onClick={() => { setImageMenu(null); onDownload(); }}>
            <MenuItem icon="download" title="把原件保存到本机，内容不变">另存原件</MenuItem>
          </div>
        </div>
      </Menu>
    ) : null}
  </div>;
}
