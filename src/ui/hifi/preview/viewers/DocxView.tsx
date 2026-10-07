/**
 * Word 阅读视图（R69，对照 reference-word.png / ZCode previewPaneOfficeDocxContent.tsx @29628c9）：
 * docx-preview 分页纸张排版（breakPages/页眉脚/ignoreLastRenderedPageBreak——保留 section 边界）、
 * **只缩不放 fit**（面板窄于纸宽时等比缩小并同步包装层宽高，不裁剪不双向溢出）、
 * 去掉 wrapper 默认灰底/padding。主视觉成功时不再铺第二份净化提取副本（提取入文件信息）。
 * Shadow DOM 隔离（样式不入应用文档）；renderAltChunks:false；外部关系不加载。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../components/Icon';
import { loadRendererDocxPreview } from '../renderers';

interface DocxFit { scale: number; width: number; height: number }

export function DocxView({ bytes, filename, revisionLabel, onDownload }: {
  bytes: Uint8Array; filename: string; revisionLabel: string; onDownload: () => void;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [fit, setFit] = useState<DocxFit | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host == null) return;
    let active = true;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // ZCode DOCX 渲染选项的众说适配（同库同版本）：保留分页/边距/页眉脚；去 wrapper 灰底。
    style.textContent = [
      ':host{display:block;height:100%;}',
      '.docx-wrapper{background:transparent;padding:0;}',
      '.docx-wrapper>section.docx{box-shadow:0 2px 10px rgba(15,23,42,.08),0 1px 2px rgba(15,23,42,.05);margin-bottom:14px;}',
      'table{border-collapse:collapse;}',
    ].join('');
    const body = document.createElement('div');
    shadow.replaceChildren(style, body);
    setState('loading'); setErr(null); setFit(null);
    void loadRendererDocxPreview().then(async (dx) => {
      await dx.renderAsync(bytes.slice(), body, body, {
        inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
        breakPages: true, useBase64URL: true, experimental: true, renderAltChunks: false,
        // @ts-expect-error 众说 vendored docx-preview 版本支持该选项（ZCode 同款：不忽略最后
        // 渲染分页符——否则相邻同纸型不同边距的 section 会并页）。
        ignoreLastRenderedPageBreak: true,
      });
      if (!active) return;
      setState('ready');
    }).catch((e: unknown) => {
      if (!active) return;
      setErr(String((e as Error).message).slice(0, 160));
      setState('error');
    });
    return () => {
      active = false;
      shadow.replaceChildren();
    };
  }, [bytes, nonce]);

  const updateFit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (viewport == null || content == null || state !== 'ready') return;
    const avail = viewport.clientWidth - 32;
    const natural = content.offsetWidth;
    const full = content.scrollHeight;
    if (natural <= 0) return;
    const scale = avail < natural ? avail / natural : 1;
    setFit((cur) => (cur != null && Math.abs(cur.scale - scale) < 0.005 ? cur : { scale, width: natural * scale, height: full * scale }));
  }, [state]);
  useLayoutEffect(() => {
    updateFit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateFit);
    if (viewportRef.current != null) ro.observe(viewportRef.current);
    if (contentRef.current != null) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [state, updateFit]);

  if (state === 'error') {
    return (
      <div className="preview-unsupported" data-zs-docx-error={err?.slice(0, 40)}>
        <Icon name="alert-triangle" size={20} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>文档渲染失败</div>
        <div className="small muted" style={{ marginTop: 6, maxWidth: 440, lineHeight: 1.7 }}>{err}——原件已保存（{revisionLabel}），可下载后用系统工具打开；提取文本见「文件信息」。</div>
        <div className="panel-actions">
          <button className="btn sm" onClick={() => setNonce((n) => n + 1)}>重试渲染</button>
          <button className="btn sm" onClick={onDownload}><Icon name="download" size={12} /> 下载原文件</button>
        </div>
      </div>
    );
  }
  return (
    <div className="docx-view" data-zs-docx-view="1" data-zs-docx-state={state}>
      <div className="docx-scroll" ref={viewportRef}>
        <div className="docx-fit-frame" style={fit ? { width: fit.width, height: fit.height } : undefined}>
          <div className="docx-fit-content" ref={contentRef} style={fit ? { position: 'absolute', left: 0, top: 0, transform: `scale(${fit.scale})`, transformOrigin: 'top left' } : undefined}>
            <div ref={hostRef} data-zs-docx-host="1" style={{ minWidth: 1, minHeight: 1 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
