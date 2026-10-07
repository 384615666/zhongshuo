/**
 * Word 阅读视图（R69 建立 / R70 修 wrapper 灰底+滚动位置）：docx-preview 分页纸张排版、
 * 只缩不放 fit、**全白连续文档流**。
 *
 * R70 F6：docx-preview 在 renderAsync 后会向样式容器追加**默认样式**（.docx-wrapper 灰底
 * rgb(128,128,128)+30px padding）——覆盖顺序晚于我们先注入的样式。修法=ZCode 同款**渲染后
 * 内联覆盖**（inline 优先级高于任何样式表）：wrapper.background/padding/width 直接写到元素
 * 上；页面纸张阴影样式也在渲染后追加（晚于库样式）。
 * R70 F4：内部滚动位置按 资源+读取版本 存取（切标签/收起重开不回顶）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../components/Icon';
import { loadRendererDocxPreview } from '../renderers';
import { saveReaderState, type ReaderState } from '../readerState';

interface DocxFit { scale: number; width: number; height: number }

export function DocxView({ bytes, filename, revisionLabel, onDownload, resourceId, revision, initialState }: {
  bytes: Uint8Array; filename: string; revisionLabel: string; onDownload: () => void;
  resourceId?: string; revision?: number; initialState?: ReaderState;
}): ReactElement {
  const restoredScroll = initialState?.kind === 'docx' ? initialState.scrollTop : 0;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [fit, setFit] = useState<DocxFit | null>(null);
  const [nonce, setNonce] = useState(0);
  const restoredRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host == null) return;
    let active = true;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      ':host{display:block;height:100%;}',
      'table{border-collapse:collapse;}',
    ].join('');
    const body = document.createElement('div');
    shadow.replaceChildren(style, body);
    setState('loading'); setErr(null); setFit(null); restoredRef.current = false;
    void loadRendererDocxPreview().then(async (dx) => {
      await dx.renderAsync(bytes.slice(), body, body, {
        inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
        breakPages: true, useBase64URL: true, experimental: true, renderAltChunks: false,
        // @ts-expect-error vendored docx-preview 支持该选项（ZCode 同款：不忽略最后渲染
        // 分页符——否则相邻同纸型不同边距的 section 会并页）。
        ignoreLastRenderedPageBreak: true,
      });
      if (!active) return;
      // R70 F6：渲染后内联覆盖库默认样式（灰底+30px padding → 全白连续文档流），并把纸张
      // 阴影样式追加到库样式之后（顺序即优先级）。
      const wrapper = body.querySelector('.docx-wrapper') as HTMLElement | null;
      if (wrapper != null) {
        wrapper.style.background = 'transparent';
        wrapper.style.padding = '0';
        wrapper.style.width = 'max-content';
      }
      const pageStyle = document.createElement('style');
      pageStyle.textContent = '.docx-wrapper>section.docx{box-shadow:0 2px 10px rgba(15,23,42,.08),0 1px 2px rgba(15,23,42,.05);margin-bottom:14px;background:#fff;}';
      shadow.append(pageStyle);
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
    // bytes=稳定引用（FileStage）；重试 nonce 才重渲染。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, nonce]);

  // R70 F4：内部滚动位置——恢复（ready 后一次）与保存（滚动防抖）。
  useEffect(() => {
    if (state !== 'ready') return;
    const sc = scrollRef.current;
    if (sc == null) return;
    if (!restoredRef.current && restoredScroll > 0) {
      sc.scrollTop = restoredScroll;
      restoredRef.current = true;
    }
    let timer = 0;
    const onSave = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (resourceId != null && revision != null) {
          saveReaderState(resourceId, revision, { kind: 'docx', scrollTop: sc.scrollTop });
        }
      }, 220);
    };
    sc.addEventListener('scroll', onSave, { passive: true });
    return () => { sc.removeEventListener('scroll', onSave); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, resourceId, revision]);

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
      <div className="docx-scroll" ref={(el) => { scrollRef.current = el; viewportRef.current = el; }}>
        <div className="docx-fit-frame" style={fit ? { width: fit.width, height: fit.height } : undefined}>
          <div className="docx-fit-content" ref={contentRef} style={fit ? { position: 'absolute', left: 0, top: 0, transform: `scale(${fit.scale})`, transformOrigin: 'top left' } : undefined}>
            <div ref={hostRef} data-zs-docx-host="1" style={{ minWidth: 1, minHeight: 1 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
