/**
 * 共享预览面板（第五十二轮 H2 §6.1——按批准的原型 PreviewPane 布局：右侧面板+头部身份行+
 * 分列说明+关闭）：数据通道=正式 attachment.preview* 命令（服务端 audience/实根/sha256 核验）；
 * 渲染器=随包 pdfjs / pptx-renderer / docx-preview（与旧界面同一资产与同一选项——不重做解析器）。
 *
 * 生命周期（沿既有合同）：代次门——打开/切换/关闭 +1，迟到响应不重开不覆盖；打开期
 * AbortController（pptx 解析中止）与 viewer 归属本面板，关闭/切换即 abort+dispose；Word=
 * Shadow DOM 隔离+renderAltChunks:false+净化回退（服务端白名单 HTML+本地再剥属性）；PDF
 * includeBytes 每附件一次、翻页/缩放本地；图片 decode() 对账。视觉预览与提取文本/模型输入
 * **分列说明**（提取文本=模型输入真源）。表格注入范围写回草稿（发送时冻结进信封）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { command } from '../bridge';
import { useStore, closePreview, toast, getState, addFileRefToDraft, queueDraftInsert, conversationOfDraftKey } from '../data/store';
import { previewTextAttachment, setDraftAttachmentRange } from '../loader';
import { getDraftFull } from '../data/store';
import { loadRendererPdfjs, loadRendererPptx, loadRendererDocxPreview, base64ToBytes, type PptxViewer } from './renderers';

const KIND_LABEL: Record<string, string> = {
  text_file: '文本', code_file: '代码', image_file: '图片', pdf_file: 'PDF',
  docx_file: 'Word', sheet_file: '表格', slides_file: '幻灯片', csv: 'CSV',
};

interface TextData { filename: string; kind: string; revision: number; hash: string; text: string; truncated: boolean; originalBytes: number; excerptBytes?: number }
interface ImageData { filename: string; mime: string; width: number; height: number; bytes: number; hash: string; revision: number; dataUrl: string }
interface PdfPageData { filename: string; totalPages: number; page: number; text: string; truncated: boolean; hash: string; revision: string | number; parser?: string; truncatedTotal?: number; extractedAt?: number }
interface OfficeSheet { name: string; rowCount: number; colCount: number; cells: string[][]; rowTruncated?: boolean; colTruncated?: boolean; merges?: unknown[]; formulaMissing?: boolean }
interface OfficeData {
  filename: string; kind: string; hash: string; revision: number; parser?: string; sourceFormat?: string; encoding?: string;
  paragraphCount?: number; htmlTruncated?: boolean; truncatedTotal?: boolean; html?: string;
  sheets?: OfficeSheet[]; slides?: Array<{ slide: number; text: string; notes: string; truncated?: boolean }>;
  visualBytesAvailable?: boolean; visualBytesReason?: string; bytesBase64?: string;
}

export function PreviewPane() {
  const open = useStore((s) => s.previewPane != null);
  const target = useStore((s) => s.previewPane?.target ?? null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * 摘录的内容真源（r61 G7）：各格式子组件按数据源上报当前主文本（文本=提取文本、PDF=当前页
   * 文本层、Word=净化 HTML 文本、表格=当前表窗口、幻灯=当前页文字+备注）——摘录只来自内容，
   * 不再从 .page-stack DOM 抓取（那会把解析器/模型输入说明等界面文案混进正文）。
   * 目标切换即清（src 绑定 attachmentId+版本，迟到上报不串目标）。
   */
  const [contentText, setContentText] = useState<{ src: string; text: string } | null>(null);
  /**
   * 头部身份行的**真实版本/hash**（r55：已发消息打开的预览此前头部显示 v?/空 hash——
   * 调用方没带 hint，而真实值其实已在预览命令响应里）。各格式子组件取到数据后上报
   * revision/hash，头部优先用上报值、无上报才回落调用方 hint；目标切换即清。
   */
  const [identity, setIdentity] = useState<{ revision?: number | string; hash?: string } | null>(null);
  /**
   * 阅读宽度/展开（r56 H4 §5）：normal=min(560px,46vw)；wide=min(880px,74vw)——Word/表格
   * 长内容横向可读；full=全屏展开（遮内容区，关闭即回）。会话级状态，不持久化。
   */
  const [widthMode, setWidthMode] = useState<'normal' | 'wide' | 'full'>('normal');
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const viewerRef = useRef<PptxViewer | null>(null);

  const releaseResources = () => {
    if (abortRef.current != null) { try { abortRef.current.abort(new Error('preview-superseded')); } catch { /* 已中止 */ } abortRef.current = null; }
    if (viewerRef.current != null) { try { viewerRef.current.dispose(); } catch { /* 已释放 */ } viewerRef.current = null; }
  };

  // 打开/切换目标：代次在**渲染期**推进（React 子组件 effect 先于父组件 effect 执行——若在
  // 父 effect 里自增，子组件闭包捕获的是旧值，首轮响应会被误判迟到丢弃——R52 实测）。旧轮
  // 资源同时回收；关闭/卸载同样回收（合同：迟到不重开不覆盖）。
  const targetKey = open && target != null ? `${target.attachmentId}:${target.revisionHint ?? ''}` : null;
  const lastTargetRef = useRef<string | null>(null);
  if (lastTargetRef.current !== targetKey) {
    lastTargetRef.current = targetKey;
    genRef.current += 1;
    releaseResources();
    setErr(null);
    setIdentity(null);
    setContentText(null);
    setWidthMode('normal'); // 换目标回默认宽度（r56）
  }
  useEffect(() => () => { genRef.current += 1; releaseResources(); }, []);

  // Esc 退出展开/加宽（r61 P4 语义补齐）：full 或 wide 下 Esc 都回到 normal——「恢复默认阅读
  // 宽度」，**永不关闭预览**（内容仍要读；关闭走按钮）；更上层弹窗（命令面板/恢复面板）打开
  // 时让位——它们各自的 Esc 语义优先。此前 Esc 只认 full，wide 下无动作（v4 手测用户「Esc
  // 不能退出展开」的最可能形态——交付形态四焦点位原生键演练见 review-r61 §4，未复现失败）。
  useEffect(() => {
    if (widthMode === 'normal') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[data-zs-palette=hifi], [data-zs-recovery=hifi]') != null) return;
      e.preventDefault();
      setWidthMode('normal');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [widthMode]);

  if (!open || target == null) return null;
  const gen = genRef.current;
  const alive = () => gen === genRef.current;
  const onIdentity = (revision: number | string, hash: string): void => { if (alive()) setIdentity({ revision, hash }); };
  const idLine = `${KIND_LABEL[target.kind] ?? target.kind} · ${target.filename} · v${identity?.revision ?? target.revisionHint ?? '?'} · sha256=${String(identity?.hash ?? target.hashHint ?? '').slice(0, 12)}… · 来源：${target.origin ?? '会话'}`;

  /** 按当前路由解析引用落点（草稿键）——预览盖着的就是用户正看的目标。 */
  const draftKeyFromRoute = (): string | null => {
    const hash = location.hash ?? '';
    const th = /^#\/thread\/([^?]+)/.exec(hash);
    const rm = /^#\/room\/([^?]+)/.exec(hash);
    const dmM = /^#\/dm\/([^?]+)/.exec(hash);
    if (th != null) return `thread:${decodeURIComponent(th[1])}`;
    if (rm != null) return `room:${decodeURIComponent(rm[1])}`;
    if (dmM != null) return `dm:${decodeURIComponent(dmM[1])}`;
    if (hash.startsWith('#/dm')) {
      const st = getState();
      const currentDm = st.dms.find((d) => d.id === st.ui.activeThreadId) ?? st.dms[0];
      if (currentDm != null) return `dm:${currentDm.id}`;
    }
    return null;
  };

  /**
   * 引用文件（r61 G7 重做，默认动作）：把**文件/版本引用卡**直写目标草稿（正文保持用户
   * 文字——全文/界面说明不自动粘贴）。一次点击一次落账：同文件同版本已在草稿=如实提示
   * 已引用（不积压）；跨会话资源在写入前拒绝（服务端仍按 audience 终审）；找不到输入
   * 目标如实提示、零写入。写入成功才提示成功——不出现「提示成功但输入区没有」的假成功。
   */
  const quoteFileToComposer = (): void => {
    const draftKey = draftKeyFromRoute();
    if (draftKey == null) { toast('当前页面没有输入框可插入引用——回到房间/线程/私信后再引用', 'warn'); return; }
    const draftConv = conversationOfDraftKey(draftKey);
    if (target.conversationId != null && target.conversationId.length > 0 && draftConv != null && draftConv.length > 0 && target.conversationId !== draftConv) {
      toast('该文件属于其它会话——不能引用到当前输入框（跨会话复制受 audience 边界限制）', 'warn');
      return;
    }
    const r = addFileRefToDraft(draftKey, target.conversationId ?? draftConv ?? '', {
      attachmentId: target.attachmentId,
      name: target.filename,
      kind: target.kind,
      revision: Number(identity?.revision ?? target.revisionHint ?? 0) || undefined,
      hash: String(identity?.hash ?? target.hashHint ?? '') || undefined,
    });
    if (!r.ok) { toast(`引用失败：${r.error ?? '未知错误'}（未写入）`, 'error'); return; }
    window.dispatchEvent(new CustomEvent('zs:focus-composer', { detail: draftKey }));
    toast(r.existed === true
      ? `「${target.filename}」已在输入区引用（同文件同版本不重复）——输入区可见引用卡，发送时携带该资源`
      : `已引用「${target.filename}」到输入区（引用卡可移除；发送时按正式附件合同携带版本/hash——正文保持你的文字）`, 'success');
  };

  /**
   * 摘录到正文（r61 G7：与「引用文件」分列的独立动作）：只取**内容真源**当前文本前 160 字
   * （不含解析器/模型输入说明等界面文案），插入目标草稿正文；内容未装载/无文本层如实提示。
   */
  const excerptToComposer = (): void => {
    const draftKey = draftKeyFromRoute();
    if (draftKey == null) { toast('当前页面没有输入框可插入摘录——回到房间/线程/私信后再操作', 'warn'); return; }
    if (contentText == null || contentText.text.trim().length === 0) { toast('本预览还没有可摘录的内容文本（未装载或无文本层——OCR 未实现）', 'warn'); return; }
    const rev = String(identity?.revision ?? target.revisionHint ?? '?');
    const excerpt = contentText.text.replace(/\s+/g, ' ').trim().slice(0, 160);
    const r = queueDraftInsert(draftKey, `> 摘录「${target.filename}」v${rev}：${excerpt}`);
    if (!r.ok) { toast(`摘录失败：${r.error ?? '未知错误'}`, 'error'); return; }
    window.dispatchEvent(new CustomEvent('zs:focus-composer', { detail: draftKey }));
    toast(r.queued === false ? '相同摘录已在待插入队列（不重复）' : '已摘录内容前 160 字到输入框正文（引用不直接触发新任务）', 'success');
  };

  /** 内容上报（各格式子组件→摘录真源）；src 绑定目标附件身份，迟到/异目标上报丢弃。 */
  const onContent = (src: string, text: string): void => {
    if (!alive() || !src.startsWith(`${target.attachmentId}:`)) return;
    setContentText({ src, text });
  };

  const body = (() => {
    if (target.kind === 'text_file' || target.kind === 'code_file') return <TextPreview key={target.attachmentId} target={target} alive={alive} onErr={setErr} onIdentity={onIdentity} onContent={onContent} />;
    if (target.kind === 'image_file') return <ImagePreview key={target.attachmentId} target={target} alive={alive} onErr={setErr} onIdentity={onIdentity} />;
    if (target.kind === 'pdf_file') return <PdfPreview key={target.attachmentId} target={target} alive={alive} onErr={setErr} onIdentity={onIdentity} onContent={onContent} />;
    if (target.kind === 'docx_file' || target.kind === 'sheet_file' || target.kind === 'slides_file') {
      return <OfficePreview key={target.attachmentId} target={target} alive={alive} onErr={setErr} abortRef={abortRef} viewerRef={viewerRef} onIdentity={onIdentity} onContent={onContent} />;
    }
    return <div className="panel info">该类型（{target.kind}）的共享预览未接入——经「原界面」打开。</div>;
  })();

  const paneWidth = widthMode === 'full' ? '100vw' : widthMode === 'wide' ? 'min(880px, 74vw)' : 'min(560px, 46vw)';

  return (
    <aside className="preview-pane" data-zs-preview-width={widthMode} style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: paneWidth, zIndex: 60, display: 'flex', flexDirection: 'column', background: 'var(--bg, #f8fafc)', borderLeft: '1px solid var(--border, #dbe2ea)', boxShadow: '-6px 0 24px rgba(15,23,42,.08)' }} data-zs-preview="hifi">
      <div className="row tight" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border,#dbe2ea)', alignItems: 'center' }}>
        <Icon name="file-text" size={14} />
        <span className="small" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{idLine}</span>
        {/* 阅读宽度/展开（r56）：Word/表格长内容的横向阅读空间。 */}
        <button className="btn ghost sm" title="收窄（默认 560px）" disabled={widthMode === 'normal'} onClick={() => setWidthMode('normal')}>窄</button>
        <button className="btn ghost sm" title="加宽（880px——长行/宽表可读；Esc 恢复默认宽度）" disabled={widthMode === 'wide'} onClick={() => setWidthMode('wide')}>宽</button>
        <button className="btn ghost sm" title={widthMode === 'full' ? '退出全屏展开（Esc 同效）' : '全屏展开（遮内容区——Esc 或本按钮恢复，不关闭预览）'} onClick={() => setWidthMode((m) => (m === 'full' ? 'normal' : 'full'))}>{widthMode === 'full' ? '还原' : '展开'}</button>
        <button className="btn ghost sm" title="把本文件作为资源引用卡加入当前输入框（保留版本/hash，发送时按正式附件合同携带——正文保持你的文字，不自动粘贴全文）" onClick={quoteFileToComposer}>引用文件</button>
        <button className="btn ghost sm" title="把当前内容文本的前 160 字摘录到输入框正文（独立于文件引用——只来自内容，不含界面说明）" onClick={excerptToComposer}>摘录</button>
        <button className="btn ghost sm" title="关闭预览（中止在途解析并释放渲染器资源）" onClick={() => closePreview()}>关闭</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px' }} className="page-stack">
        {err != null ? <div className="panel info" style={{ borderColor: 'var(--warning)' }}>预览失败：{err}（可关闭后重试）</div> : null}
        {body}
      </div>
    </aside>
  );
}

/** 有界等待（第五十二轮）：渲染器打开/翻页不设界会在个别环境挂起整个渲染线程——超时按
 * 失败分列（提取文本不受影响），不冒充渲染成功。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    p.then((v) => { window.clearTimeout(t); resolve(v); }, (e) => { window.clearTimeout(t); reject(e); });
  });
}

type Target = { attachmentId: string; filename: string; kind: string; conversationId?: string; origin?: string; draftKey?: string; hashHint?: string; revisionHint?: number | string };
type Alive = () => boolean;

function TextPreview({ target, alive, onErr, onIdentity, onContent }: { target: Target; alive: Alive; onErr: (e: string) => void; onIdentity: (revision: number | string, hash: string) => void; onContent?: (src: string, text: string) => void }) {
  const [d, setD] = useState<TextData | null>(null);
  useEffect(() => {
    let done = false;
    void previewTextAttachment(target.attachmentId, target.conversationId ?? '')
      .then((r) => { if (!done && alive()) { setD(r as TextData); onIdentity((r as TextData).revision, (r as TextData).hash); onContent?.(`${target.attachmentId}:${(r as TextData).revision}`, (r as TextData).text); } })
      .catch((e: unknown) => { if (!done && alive()) onErr(String((e as Error).message)); });
    return () => { done = true; };
  }, [target.attachmentId]);
  if (d == null) return <div className="panel info">正在加载预览…</div>;
  return (
    <>
      <pre className="panel info" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, maxHeight: '60vh', overflow: 'auto' }}>{d.text}</pre>
      <div className="faint small" style={{ marginTop: 6 }}>
        原文 {d.originalBytes}B{d.truncated ? ` · 预览/注入截断至 ${d.excerptBytes ?? 64 * 1024}B` : ''} · 模型输入=提取文本（与显示同源）
      </div>
    </>
  );
}

function ImagePreview({ target, alive, onErr, onIdentity }: { target: Target; alive: Alive; onErr: (e: string) => void; onIdentity: (revision: number | string, hash: string) => void }) {
  const [d, setD] = useState<ImageData | null>(null);
  // 像素对账三态（r53 §2 收紧）：ok=声明宽高逐项相等；mismatch=能解码但与声明不符（如实
  // 报告，不再两边都写 'ok'）；failed=解码失败。验证器按 data-zs-image-decode 断言真值。
  const [decode, setDecode] = useState<{ status: 'pending' | 'ok' | 'mismatch' | 'failed'; w?: number; h?: number }>({ status: 'pending' });
  useEffect(() => {
    let done = false;
    void command<ImageData>('attachment.previewImage', { attachmentId: target.attachmentId })
      .then((r) => { if (!done && alive()) { setD(r); onIdentity(r.revision, r.hash); } })
      .catch((e: unknown) => { if (!done && alive()) onErr(String((e as Error).message)); });
    return () => { done = true; };
  }, [target.attachmentId]);
  if (d == null) return <div className="panel info">正在加载预览…</div>;
  return (
    <>
      <img
        src={d.dataUrl}
        alt={d.filename}
        data-zs-image-preview="hifi"
        style={{ maxWidth: '100%', maxHeight: '56vh', display: 'block' }}
        onLoad={(e) => {
          const img = e.currentTarget;
          setDecode(img.naturalWidth === d.width && img.naturalHeight === d.height
            ? { status: 'ok', w: img.naturalWidth, h: img.naturalHeight }
            : { status: 'mismatch', w: img.naturalWidth, h: img.naturalHeight });
        }}
        onError={() => setDecode({ status: 'failed' })}
      />
      <div className="faint small" data-zs-image-decode={decode.status} style={{ marginTop: 6 }}>
        {d.mime} · 声明 {d.width}×{d.height} · 原件 {d.bytes}B · 像素解码：{decode.status === 'ok' ? `成功（${decode.w}×${decode.h} 逐项对账）` : decode.status === 'mismatch' ? `⚠ 已解码但与声明不符（实际 ${decode.w ?? '?'}×${decode.h ?? '?'}——如实分列）` : decode.status === 'failed' ? '失败（原件完整保存但格式头通过≠像素可解码）' : '进行中…'}
      </div>
      <div className="faint small">OCR 提取正文：未实现 · 模型图片输入：未认证（发送时显式选择「仅发送文字」或「仅记录」——不冒充模型已读）</div>
    </>
  );
}

function PdfPreview({ target, alive, onErr, onIdentity, onContent }: { target: Target; alive: Alive; onErr: (e: string) => void; onIdentity: (revision: number | string, hash: string) => void; onContent?: (src: string, text: string) => void }) {
  const [pg, setPg] = useState<PdfPageData | null>(null);
  const [zoom, setZoom] = useState<string>('fit');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocRef = useRef<{ numPages: number; destroy(): Promise<void>; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void } }> } | null>(null);
  const bytesRef = useRef<string | null>(null);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);

  useEffect(() => {
    let done = false;
    void command<PdfPageData & { bytesBase64?: string }>('attachment.previewPdf', { attachmentId: target.attachmentId, page: 1, includeBytes: true })
      .then((r) => {
        if (!done && alive()) {
          if (r.bytesBase64 != null) bytesRef.current = r.bytesBase64;
          pdfDocRef.current = null;
          setPg(r);
          onIdentity(r.revision, r.hash);
          onContent?.(`${target.attachmentId}:${r.revision}`, r.text);
        }
      })
      .catch((e: unknown) => { if (!done && alive()) onErr(String((e as Error).message)); });
    return () => { done = true; };
  }, [target.attachmentId]);

  // 卸载清理（r53 §6.1——渲染任务与文档归属本面板）：取消在途 render 任务 + 销毁 pdfjs
  // 文档（worker 端资源）。迟到回调经 alive()/cancelled 双门不再写画布。
  useEffect(() => () => {
    try { renderTaskRef.current?.cancel(); } catch { /* 已结束 */ }
    renderTaskRef.current = null;
    const doc = pdfDocRef.current;
    pdfDocRef.current = null;
    if (doc != null) void doc.destroy().catch(() => { /* 已销毁 */ });
  }, []);

  // 视觉层：pdfjs 渲染器侧 canvas（服务端零像素解码）；翻页/缩放本地。
  useEffect(() => {
    if (pg == null || canvasRef.current == null || bytesRef.current == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const canvas = canvasRef.current;
        if (canvas == null) return;
        if (pdfDocRef.current == null) {
          const lib = await loadRendererPdfjs();
          if (lib == null) throw new Error('pdfjs 未就绪');
          const b64 = bytesRef.current;
          if (b64 == null || cancelled || !alive()) return;
          pdfDocRef.current = await lib.getDocument({ data: base64ToBytes(b64), isEvalSupported: false }).promise;
        }
        const doc = pdfDocRef.current;
        if (doc == null) return;
        const pageNum = Math.min(Math.max(pg.page, 1), doc.numPages);
        const page = await doc.getPage(pageNum);
        if (cancelled || !alive() || canvasRef.current == null) return;
        const base = page.getViewport({ scale: 1 });
        const scale = zoom === 'fit' ? Math.min(1.25, 480 / base.width) : Number(zoom);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
        renderTaskRef.current = task; // 归属本面板——卸载/切换时取消，不让迟到的任务写旧画布
        await task.promise;
      } catch (e) {
        if (!cancelled && alive()) onErr(`视觉页渲染失败：${String((e as Error).message).slice(0, 120)}`);
      } finally {
        if (renderTaskRef.current != null && !cancelled) renderTaskRef.current = null;
      }
    })();
    return () => { cancelled = true; try { renderTaskRef.current?.cancel(); } catch { /* 已结束 */ } renderTaskRef.current = null; };
  }, [pg?.page, zoom, pg != null]);

  if (pg == null) return <div className="panel info">正在加载预览…</div>;
  const goPage = (n: number) => {
    void command<PdfPageData>('attachment.previewPdf', { attachmentId: target.attachmentId, page: n })
      .then((r) => { if (alive()) { setPg(r); onContent?.(`${target.attachmentId}:${r.revision}`, r.text); } })
      .catch((e: unknown) => { if (alive()) onErr(String((e as Error).message)); });
  };
  return (
    <>
      <div className="row tight">
        <button className="btn ghost sm" disabled={pg.page <= 1} onClick={() => goPage(pg.page - 1)}>← 前页</button>
        <button className="btn ghost sm" disabled={pg.page >= pg.totalPages} onClick={() => goPage(pg.page + 1)}>后页 →</button>
        <select className="pdf-zoom" value={zoom} onChange={(e) => setZoom(e.target.value)}>
          <option value="fit">适应宽</option><option value="1">100%</option><option value="1.5">150%</option>
        </select>
        <span className="faint small">第 {pg.page}/{pg.totalPages} 页</span>
      </div>
      <canvas ref={canvasRef} data-zs-pdf-canvas="hifi" style={{ maxWidth: '100%', border: '1px solid var(--border,#dbe2ea)', background: '#fff', display: 'block' }} />
      <pre className="panel info" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '8px 0 0' }}>{pg.text.length === 0 ? '（本页无文本层——可能是扫描件；OCR 未实现，如实空页；页面像素见上方视觉渲染）' : pg.text}</pre>
      <div className="faint small" style={{ marginTop: 6 }}>视觉渲染：浏览器 canvas（服务端零像素解码）· OCR：未实现 · 解析器：{pg.parser ?? '?'} · 模型输入=提取文本（与视觉分列）</div>
    </>
  );
}

function OfficePreview({ target, alive, onErr, abortRef, viewerRef, onIdentity, onContent }: { target: Target; alive: Alive; onErr: (e: string) => void; abortRef: React.MutableRefObject<AbortController | null>; viewerRef: React.MutableRefObject<PptxViewer | null>; onIdentity: (revision: number | string, hash: string) => void; onContent?: (src: string, text: string) => void }) {
  const [d, setD] = useState<OfficeData | null>(null);
  const [visualState, setVisualState] = useState<'none' | 'rendering' | 'done' | 'failed'>('none');
  const [visualErr, setVisualErr] = useState<string | null>(null);
  const shadowHostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [slidePage, setSlidePage] = useState(1);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [rangeInput, setRangeInput] = useState('');
  const [rangeNote, setRangeNote] = useState<string | null>(null);

  useEffect(() => {
    let done = false;
    setVisualState('none'); setVisualErr(null);
    void command<OfficeData>('attachment.previewOffice', { attachmentId: target.attachmentId, includeBytes: true })
      .then((r) => { if (!done && alive()) { setD(r); onIdentity(r.revision, r.hash); reportContentOf(r); } })
      .catch((e: unknown) => { if (!done && alive()) onErr(String((e as Error).message)); });
    return () => { done = true; };
  }, [target.attachmentId]);

  /** 内容真源上报（r61 摘录）：Word=净化 HTML 的文本；表格=当前表窗口单元格；幻灯=当前页
   *  文字+备注。切表/翻页时重报——摘录始终取用户当前所见内容，不含界面说明。 */
  const reportContentOf = (data: OfficeData): void => {
    const src = `${target.attachmentId}:${data.revision}`;
    if (data.kind === 'docx_file') {
      if (data.html != null) {
        const box = document.createElement('div');
        box.innerHTML = data.html;
        onContent?.(src, box.textContent ?? '');
      }
      return;
    }
    if (data.kind === 'sheet_file') {
      const sh = (data.sheets ?? [])[sheetIdx] ?? (data.sheets ?? [])[0];
      if (sh != null) onContent?.(src, sh.cells.map((row) => row.map((c) => String(c ?? '')).join('\t')).join('\n'));
      return;
    }
    const sl = (data.slides ?? [])[slidePage - 1];
    if (sl != null) onContent?.(src, `${sl.text}${sl.notes.trim().length > 0 ? `\n${sl.notes}` : ''}`);
  };
  // 切表/翻页重报当前内容（数据已在——只重组当前窗口文本）。
  useEffect(() => { if (d != null) reportContentOf(d); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sheetIdx, slidePage]);

  // Word 视觉：docx-preview 渲染进 Shadow DOM（CSS 边界）+ renderAltChunks:false。
  useEffect(() => {
    if (d?.kind !== 'docx_file' || d.visualBytesAvailable !== true || d.bytesBase64 == null || shadowHostRef.current == null) return;
    let cancelled = false;
    setVisualState('rendering');
    void (async () => {
      try {
        const dx = await loadRendererDocxPreview();
        if (cancelled || !alive() || shadowHostRef.current == null) return;
        const host = shadowHostRef.current;
        const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
        shadow.replaceChildren();
        const style = document.createElement('style');
        style.textContent = '.docx-wrapper{background:#fff;padding:0;}.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(15,23,42,.12);margin-bottom:8px;padding:10px 14px;}table{border-collapse:collapse;}td,th{border:1px solid #c8ccd4;padding:2px 8px;font-size:12px;}';
        shadow.append(style);
        const docxBytes = d.bytesBase64 as string;
        await dx.renderAsync(base64ToBytes(docxBytes), shadow as unknown as HTMLElement, shadow as unknown as HTMLElement, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, breakPages: true, useBase64URL: true, experimental: true, renderAltChunks: false });
        if (cancelled || !alive()) { shadow.replaceChildren(); return; }
        setVisualState('done');
      } catch (e) {
        if (!cancelled && alive()) { setVisualState('failed'); setVisualErr(String((e as Error).message).slice(0, 160)); }
      }
    })();
    return () => { cancelled = true; };
  }, [d?.kind, d?.bytesBase64, shadowHostRef.current != null]);

  // PPTX 视觉：pptx-renderer viewer（打开期 Abort+dispose 归本面板；slideerror 如实标注）。
  // r53 §2 死锁修复：舞台常驻挂载（见下方 JSX）——effect 不再因「宿主未挂载」直接 return。
  // r53 §6.1 归属收紧：打开/首页失败→真实 abort 在途解析（signal 已传入 open）+dispose 已建
  // viewer（含 goToSlide 超时场景）；对共享 abortRef/viewerRef 的清理只在「仍是本轮指针」时进行
  // ——不误清新目标的资源。
  useEffect(() => {
    if (d?.kind !== 'slides_file' || d.visualBytesAvailable !== true || d.bytesBase64 == null || stageRef.current == null) return;
    let cancelled = false;
    setVisualState('rendering');
    const ctl = new AbortController();
    abortRef.current = ctl;
    let viewer: PptxViewer | null = null;
    void (async () => {
      try {
        // 视觉渲染会让渲染线程忙碌一段——先让提取文本卡片绘制/断言有机会执行（分列合同：
        // 文本=模型输入真源，视觉慢/失败不影响文本），再启动重渲染。
        await new Promise((r) => window.setTimeout(r, 1200));
        if (cancelled || !alive() || stageRef.current == null) return;
        const lib = await loadRendererPptx();
        if (cancelled || !alive() || stageRef.current == null) return;
        const pptxBytes = d.bytesBase64 as string;
        viewer = await withTimeout(lib.PptxViewer.open(base64ToBytes(pptxBytes), stageRef.current, {
          renderMode: 'slide', zipLimits: lib.RECOMMENDED_ZIP_LIMITS, pdfjs: false, signal: ctl.signal,
        }), 20_000, '视觉页打开');
        if (cancelled || !alive()) { try { viewer.dispose(); } catch { /* 已释放 */ } return; }
        viewerRef.current = viewer;
        await withTimeout(viewer.goToSlide(0), 15_000, '首页渲染');
        if (cancelled || !alive()) return;
        if (abortRef.current === ctl) abortRef.current = null; // 打开期已结束；后续释放靠 dispose
        setVisualState('done');
      } catch (e) {
        try { ctl.abort(new Error('visual-open-failed')); } catch { /* 已中止 */ }
        if (viewer != null) {
          try { viewer.dispose(); } catch { /* 已释放 */ }
          if (viewerRef.current === viewer) viewerRef.current = null;
        }
        if (abortRef.current === ctl) abortRef.current = null;
        if (!cancelled && alive()) { setVisualState('failed'); setVisualErr(String((e as Error).message).slice(0, 200)); }
      }
    })();
    return () => {
      cancelled = true;
      try { ctl.abort(new Error('preview-unmounted')); } catch { /* 已中止 */ }
    };
  }, [d?.kind, d?.bytesBase64, stageRef.current != null]);

  // 翻页（viewer 已开）。
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer == null) return;
    void withTimeout(viewer.goToSlide(Math.min(Math.max(slidePage, 1), viewer.slideCount) - 1), 15_000, '翻页').catch(() => { /* 页渲染失败已分列 */ });
  }, [slidePage]);

  const sanitizedHtml = useMemo(() => {
    if (d?.kind !== 'docx_file' || d.html == null) return null;
    const box = document.createElement('div');
    box.innerHTML = d.html; // 服务端白名单净化；本地再剥一次属性（同旧界面合同）
    for (const elx of box.querySelectorAll('*')) {
      for (const attr of [...elx.attributes]) {
        if (!(elx.tagName === 'TD' && (attr.name === 'colspan' || attr.name === 'rowspan'))) elx.removeAttribute(attr.name);
      }
    }
    return box.innerHTML;
  }, [d?.kind, d?.html]);

  if (d == null) return <div className="panel info">正在加载预览…</div>;
  const kindLabel = d.kind === 'docx_file' ? 'DOCX 文档' : d.kind === 'sheet_file' ? `表格（${d.sourceFormat === 'csv' ? `CSV · ${d.encoding ?? '?'}` : 'XLSX'}）` : 'PPTX 幻灯片';

  return (
    <>
      <div className="faint small">{kindLabel} · 解析器 {d.parser ?? '?'}</div>
      {d.kind === 'docx_file' ? (
        <>
          {d.visualBytesAvailable === true ? (
            <>
              {visualState === 'rendering' ? <div className="panel info" style={{ marginTop: 6 }}>视觉预览渲染中…</div> : null}
              {visualState === 'done' ? <div className="faint small" style={{ marginTop: 6 }}>🖼 视觉预览（docx-preview 渲染器侧本地渲染 · Shadow DOM 隔离）——与提取文本同源核验</div> : null}
              {visualState === 'failed' ? <div className="panel info" style={{ borderColor: 'var(--warning)', marginTop: 6 }}>视觉预览不可用（{visualErr ?? '未知'}）——下方净化排版近似仍可用（分列）</div> : null}
              {/* 宿主常驻（渲染完成后填充；失败隐藏）——effect 依赖宿主存在，若只在 done 分支渲染会死锁。 */}
              <div ref={shadowHostRef} data-zs-docx-host="hifi" data-zs-visual-state={visualState} style={{ display: visualState === 'failed' ? 'none' : 'block' }} />
            </>
          ) : <div className="panel info" style={{ borderColor: 'var(--warning)' }}>视觉通道不可用（{d.visualBytesReason ?? '未取到原件字节'}）——净化排版近似如下（分列）</div>}
          {sanitizedHtml != null ? (
            <>
              <div className="office-docx-html panel info" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
              <div className="faint small" style={{ marginTop: 6 }}>净化排版近似（白名单标记——视觉失败时的回退）· 段落 {d.paragraphCount ?? '?'}{d.htmlTruncated ? ' · HTML 超预算已截断' : ''}{d.truncatedTotal ? ' · 提取文本超预算已截断（注入同口径）' : ''} · 外部关系不加载 · 嵌入图片不解码 · 宏不执行 · 模型输入=提取文本</div>
            </>
          ) : null}
        </>
      ) : d.kind === 'sheet_file' ? (
        <>
          <div className="row tight wrap" style={{ marginTop: 6 }}>
            {(d.sheets ?? []).map((sh, i) => (
              <button key={sh.name} className={`btn ghost sm${i === sheetIdx ? '' : ''}`} style={i === sheetIdx ? { fontWeight: 600 } : undefined} onClick={() => setSheetIdx(i)}>{sh.name}</button>
            ))}
          </div>
          {(() => {
            const sh = (d.sheets ?? [])[sheetIdx];
            if (sh == null) return <div className="panel info">无工作表。</div>;
            return (
              <>
                <div className="faint small" style={{ marginTop: 4 }}>工作表「{sh.name}」· 实际 {sh.rowCount}×{sh.colCount} · 预览窗口 {sh.cells.length}×{sh.cells[0]?.length ?? 0}{sh.rowTruncated || sh.colTruncated ? '（窗口外未呈现——不虚构成空表）' : ''}{(sh.merges?.length ?? 0) > 0 ? ` · 合并单元格 ${sh.merges?.length} 处` : ''}{sh.formulaMissing ? ' · ⚠ 存在无缓存值的公式格（公式不执行——如实占位）' : ''}</div>
                <div style={{ overflow: 'auto', maxHeight: '40vh', border: '1px solid var(--border,#dbe2ea)', background: '#fff' }}>
                  <table className="sheet-grid" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                    <tbody>
                      {sh.cells.map((row, r) => (
                        <tr key={r}>
                          <th style={{ border: '1px solid #c8ccd4', padding: '2px 8px', background: '#f1f5f9' }}>{r + 1}</th>
                          {row.map((cell, c) => <td key={c} style={{ border: '1px solid #c8ccd4', padding: '2px 8px' }}>{String(cell ?? '')}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}
          {target.draftKey != null ? (
            <div className="row tight" style={{ marginTop: 8 }}>
              <input className="composer-input" style={{ flex: 1, minWidth: 120 }} placeholder="注入范围，如 Sheet1!A1:D20（留空=有界默认窗口）" value={rangeInput} onChange={(e) => setRangeInput(e.target.value)} />
              <button
                className="btn ghost sm"
                title="把该窗口写为随消息发送的注入范围（提交时服务端校验边界；只作用于当前草稿中的此附件）"
                onClick={() => {
                  const spec = rangeInput.trim();
                  if (spec.length === 0) { setDraftAttachmentRange(target.draftKey!, target.attachmentId, ''); setRangeNote('已清除范围（发送按有界默认窗口注入）'); return; }
                  setDraftAttachmentRange(target.draftKey!, target.attachmentId, spec);
                  setRangeNote(`注入范围已设：${spec}（提交时服务端校验边界）`);
                }}
              >设为注入范围</button>
              {rangeNote != null ? <span className="faint small">{rangeNote}</span> : <span className="faint small">当前：{getDraftFull(target.draftKey!).attachments.find((a) => a.attachmentId === target.attachmentId)?.range ?? '默认有界窗口'}</span>}
            </div>
          ) : null}
          <div className="faint small" style={{ marginTop: 6 }}>公式不执行（仅缓存值，缺失如实占位）· 注入=范围窗口（默认首表 50×16——不把全部工作表无界发送）{d.truncatedTotal ? ' · 提取超预算已截断' : ''} · 模型输入=提取文本</div>
        </>
      ) : (
        <>
          <div className="faint small" style={{ marginTop: 6 }}>按页文字与备注（模型输入真源）</div>
          {(d.slides ?? []).map((sl) => (
            <div key={sl.slide} className="panel info" style={{ marginTop: 6 }}>
              <div className="faint small">幻灯片 {sl.slide}{sl.truncated ? '（本页文本超预算已截断）' : ''}</div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: 12 }}>{sl.text.length === 0 ? '（本页无文字）' : sl.text}</pre>
              {sl.notes.trim().length > 0 ? <div className="faint small">备注：{sl.notes}</div> : null}
            </div>
          ))}
          {d.visualBytesAvailable === true ? (
            <>
              {/* 视觉宿主常驻（r53 §2 死锁修复）：visualBytes 可用即挂载控件行与舞台——不再只在
                  rendering/done 挂载（那形成「没宿主不启动→没启动不挂宿主」的环）。失败时舞台
                  隐藏（display:none）但仍挂载，降级提示与提取文本分列。data-zs-* 为验证器精确
                  挂钩——禁止把外层滚动容器当视觉舞台断言。 */}
              <div className="row tight" style={{ marginTop: 8 }} data-zs-slide-controls="hifi">
                <button className="btn ghost sm" onClick={() => setSlidePage((p) => Math.max(1, p - 1))}>◀ 上一页</button>
                <button className="btn ghost sm" onClick={() => setSlidePage((p) => Math.min(viewerRef.current?.slideCount ?? 1, p + 1))}>下一页 ▶</button>
                <span className="faint small" data-zs-slide-page={slidePage} data-zs-slide-count={viewerRef.current?.slideCount ?? ''}>第 {slidePage}/{viewerRef.current?.slideCount ?? '?'} 页</span>
              </div>
              <div className="faint small" data-zs-visual-state={visualState}>🖼 视觉页预览（pptx-renderer 渲染器侧本地渲染）· sha256={d.hash.slice(0, 12)}… · v{d.revision}（与提取文本同源核验）{visualState === 'rendering' ? ' · 渲染中…' : visualState === 'none' ? ' · 启动中…' : ''}</div>
              {visualState === 'failed' ? <div className="panel info" style={{ borderColor: 'var(--warning)', marginTop: 6 }}>视觉页预览不可用（{visualErr ?? '未知'}）——提取文本卡片不受影响（分列）</div> : null}
              <div ref={stageRef} data-zs-pptx-stage="hifi" style={{ minHeight: 200, border: '1px solid var(--border,#dbe2ea)', background: '#fff', display: visualState === 'failed' ? 'none' : 'block' }} />
              {visualState !== 'failed' ? <div className="faint small" style={{ marginTop: 4 }}>视觉=渲染器侧（版面/图表/表格尽力还原——图表几何与 Office 渲染存在已知近似）· SmartArt/EMF 内嵌 PDF 回退未启用 · 外部关系不加载 · 宏不执行 · 提取文本=模型输入真源（与视觉分列）</div> : null}
            </>
          ) : <div className="panel info" style={{ borderColor: 'var(--warning)', marginTop: 8 }}>视觉页预览不可用（{d.visualBytesReason ?? '未取到原件字节'}）——提取文本卡片不受影响（分列）</div>}
        </>
      )}
    </>
  );
}
