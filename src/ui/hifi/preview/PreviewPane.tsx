/**
 * 共享预览面板（R64 原型还原合并版）：**壳=已批准原型 PreviewPane**（标签行/工具行/来源行/
 * 正文/引用流程/收起放大/单区域——UX-PREVIEW-01 §4.4/§17.9），**正文渲染=正式渲染器**
 * （attachment.preview* 命令 + 随包 pdfjs/pptx-renderer/docx-preview；工作区文件经
 * project.file.read 实际读取）。旧「单目标固定浮层」形态撤除：store.openPreview(target)
 * 的调用方经桥接 effect 归一到标签会话（DmPage 等未换装页继续可用）。
 *
 * 保留的正式合同：引用=r61 引用卡直写草稿（同文件同版本去重/跨会话拒绝/失败零写入）+
 * 摘录独立通道；打开不发送不执行；迟到响应不覆盖新目标；关闭/切换 abort+dispose；
 * Word=Shadow DOM+renderAltChunks:false；PDF includeBytes 一次/翻页本地。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Menu, MenuItem, Modal, PanelNavButton, Tag, anchorFromElement } from '../components/ui';
import { useStore, getState, closePreview, toast, queueDraftInsert } from '../data/store';
import type { PreviewTarget } from '../data/store';
import {
  activatePreview, closeAllPreviews, closePreviewTab, createFileCommentBridge,
  hidePreview, quoteResource, reloadResource, rememberScroll, showPreview,
  togglePreviewMaximized, registerAttachmentResource, openPreviewTab,
  applyWorktreeRead, markResourceUpdated, applyDeliveryRead,
} from '../data/actions-preview';
import {
  audienceAllows, openedFromAddsInfo, openedFromLabel, originLabel,
  resourceOf, revisionLabel, revisionOf as revOf,
} from '../lib/resource';
import { formatBytes, fullTime } from '../lib/format';
import { command } from '../bridge';
import type { ContextTarget, PreviewResource, ResourceRevision } from '../data/types';
import { MarkdownView } from './MarkdownView';
import { DiffText } from './DiffText';
import { loadRendererPdfjs, loadRendererPptx, loadRendererDocxPreview, base64ToBytes, type PptxViewer } from './renderers';

const KIND_LABEL: Record<string, string> = {
  text_file: '文本', code_file: '代码', image_file: '图片', pdf_file: 'PDF',
  docx_file: 'Word', sheet_file: '表格', slides_file: '幻灯片', csv: 'CSV',
};

/* ---------- 同名标签的最短可区分父路径（原型 §5 减负） ---------- */
function disambiguatedNames(paths: { key: string; name: string; dir: string }[]) {
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const arr = byName.get(p.name) ?? [];
    arr.push(p.key);
    byName.set(p.name, arr);
  }
  const out = new Map<string, string>();
  for (const p of paths) {
    const dup = (byName.get(p.name) ?? []).length > 1;
    if (!dup) { out.set(p.key, p.name); continue; }
    const segs = p.dir ? p.dir.split('/').filter(Boolean) : [];
    let suffix: string[] = [];
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      suffix = [segs[i], ...suffix];
      const candidate = `${suffix.join('/')}/${p.name}`;
      const others = (byName.get(p.name) ?? []).filter((k) => k !== p.key);
      const distinct = others.every((k) => {
        const q = paths.find((x) => x.key === k)!;
        return !q.dir.endsWith(suffix.join('/'));
      });
      if (distinct) { out.set(p.key, candidate); break; }
    }
    out.set(p.key, out.get(p.key) ?? p.name);
  }
  return out;
}

/** 预览区左端的「收起 / 返回」（单区域=返回对话；并排=收起预览）。 */
function PreviewNavControl({
  singleRegion, onBackToContext, onCollapse,
}: {
  singleRegion?: boolean;
  onBackToContext?: () => void;
  onCollapse: () => void;
}) {
  if (singleRegion && onBackToContext) {
    return (
      <PanelNavButton
        className="preview-nav-back"
        icon="arrow-left"
        label="对话"
        ariaLabel="返回对话"
        title="返回对话（预览标签与阅读位置保留）"
        onClick={onBackToContext}
      />
    );
  }
  return (
    <PanelNavButton
      className="preview-nav-back"
      icon="chevron-right"
      label="收起预览"
      ariaLabel="收起预览区"
      title="收起预览区：保留全部标签与阅读位置，稍后可重开（不会关闭文件）"
      onClick={onCollapse}
    />
  );
}

/** 从当前 hash 路由推导上下文（legacy 桥接/引用目标兜底用——正式页面显式传 context）。 */
export function contextFromRoute(projectId: string): ContextTarget {
  const hash = (location.hash ?? '').replace(/^#/, '');
  const path = hash.split('?')[0] ?? '';
  // 旧换装路由（/thread/:id、/room/:id）——线程实体已装载时给出精确上下文
  const oldThread = /^\/thread\/([^/?]+)/.exec(path);
  if (oldThread != null) {
    const ent = getState().threadEntities[oldThread[1]];
    if (ent != null) return { kind: 'thread', projectId: ent.projectId, roomId: ent.roomId, threadId: ent.id, tab: 'replies' };
  }
  const oldRoom = /^\/room\/([^/?]+)/.exec(path);
  if (oldRoom != null) return { kind: 'room', projectId, roomId: oldRoom[1], view: 'chat' };
  const th = /^\/project\/([^/]+)\/room\/([^/]+)$/.exec(path);
  if (th != null) {
    const q = new URLSearchParams(hash.split('?')[1] ?? '');
    const tid = q.get('thread');
    return tid != null
      ? { kind: 'thread', projectId, roomId: th[2], threadId: tid, tab: 'replies' }
      : { kind: 'room', projectId, roomId: th[2], view: 'chat' };
  }
  if (/^\/project\/([^/]+)\/files/.test(path)) return { kind: 'files', projectId, view: 'files' };
  const dm = /^\/dm\/([^/?]+)/.exec(path);
  if (dm != null) return { kind: 'dm', projectId, conversationId: dm[1] };
  if (path.startsWith('/dm')) {
    const st = getState();
    const cur = st.dms.find((d) => d.id === st.ui.activeThreadId) ?? st.dms[0];
    if (cur != null) return { kind: 'dm', projectId, conversationId: cur.id };
  }
  return { kind: 'room', projectId, roomId: getState().ui.activeRoomId, view: 'chat' };
}

export interface PreviewPaneProps {
  /** 当前上下文（决定 audience 可见性与引用目标） */
  context: ContextTarget;
  /** 引用默认目标草稿 key 与展示名（§7.2） */
  quoteTarget: { draftKey: string; label: string };
  /** 单区域模式：与对话二选一显示 */
  singleRegion?: boolean;
  /** 返回对话（单区域模式） */
  onBackToContext?: () => void;
  className?: string;
  showEmpty?: boolean;
  flexStyle?: React.CSSProperties;
}

export function PreviewPane({
  context, quoteTarget, singleRegion, onBackToContext, className, showEmpty, flexStyle,
}: PreviewPaneProps) {
  const s = useStore((x) => x);
  const session = s.preview;
  const legacyTarget = useStore((x) => x.previewPane?.target ?? null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [openList, setOpenList] = useState<{ x: number; y: number } | null>(null);
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);
  const [readAt, setReadAt] = useState<{ x: number; y: number } | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  const [wrapSource, setWrapSource] = useState(false);
  /** 下载原文件忙态（R66 P5——顶部声明：hooks 顺序不随后续早退分支变化）。 */
  const [dlBusy, setDlBusy] = useState(false);
  const [zoom, setZoom] = useState<number>(0);
  const [selection, setSelection] = useState('');
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const paneCls = `preview-pane${className ? ` ${className}` : ''}`;

  /* ---------- legacy 桥接：store.openPreview(target)（未换装页）→ 归一为标签会话 ---------- */
  useEffect(() => {
    if (legacyTarget == null) return;
    const t: PreviewTarget = legacyTarget;
    closePreview(); // 单目标态即弃——标签接管
    registerAttachmentResource({
      attachmentId: t.attachmentId,
      filename: t.filename,
      kind: t.kind,
      hash: t.hashHint,
      revision: typeof t.revisionHint === 'number' ? t.revisionHint : undefined,
      audience: contextFromRoute(s.activeProjectId),
      origin: t.conversationId ?? '',
    });
    openPreviewTab(t.attachmentId, typeof t.revisionHint === 'number' ? t.revisionHint : undefined, {
      target: contextFromRoute(s.activeProjectId),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyTarget != null]);

  /** 只显示当前上下文可见的标签（DM 隔离，§7.5） */
  const tabs = useMemo(
    () =>
      session.tabs
        .filter((t) => {
          const res = resourceOf(s, t.resourceId);
          return res ? audienceAllows(res.audience, context) : false;
        })
        .sort((a, b) => a.ordinal - b.ordinal),
    [session.tabs, s.resources, context],
  );
  const hiddenCount = session.tabs.length - tabs.length;

  const active = tabs.find((t) => t.key === session.activeKey) ?? tabs[0];
  const resource = active ? resourceOf(s, active.resourceId) : undefined;
  const revision = resource && active ? revOf(resource, active.revision) : undefined;

  // 恢复阅读位置
  useEffect(() => {
    if (bodyRef.current && active) bodyRef.current.scrollTop = active.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key]);

  const activeKind = revision?.content.kind;
  const activeFlavor = resource != null && active != null
    ? flavorOf(resource.title, resource.formalAttachment?.kind ?? '', activeKind)
    : null;
  useEffect(() => {
    // 默认视图（R66 P2）：MD/HTML/CSV 默认阅读（排版/页面/表格），代码与纯文本默认源码。
    setViewMode(activeFlavor === 'markdown' || activeFlavor === 'html' || activeFlavor === 'csv' ? 'preview' : 'source');
    setSelection('');
  }, [active?.key, activeFlavor]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const el = strip.querySelector<HTMLElement>('.preview-tab.on');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active?.key, tabs.length]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const measure = () => setTabsOverflow(strip.scrollWidth > strip.clientWidth + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabs.length, session.hidden]);

  const tabNames = useMemo(() => {
    const items = tabs.map((t) => {
      const r = resourceOf(s, t.resourceId);
      const p = (r?.relativePath ?? r?.title ?? '未知文件').split('/');
      const name = p.pop() ?? '未知文件';
      return { key: t.key, name, dir: p.join('/') };
    });
    return disambiguatedNames(items);
  }, [tabs, s.resources]);

  if (tabs.length === 0) {
    if (!showEmpty && !singleRegion) return null;
    return (
      <aside className={paneCls} style={flexStyle} aria-label="文件预览">
        <div className="preview-head">
          <PreviewNavControl singleRegion={singleRegion} onBackToContext={onBackToContext} onCollapse={hidePreview} />
          <span className="preview-head-title">文件预览</span>
        </div>
        <div className="preview-body">
          <div className="preview-empty">
            <Icon name="file-text" size={22} className="faint" />
            <div className="strong" style={{ marginTop: 8 }}>还没有打开文件</div>
            <div className="small faint" style={{ marginTop: 4 }}>
              点对话里的文件名、成果条目或左侧文件树即可在此打开。
              打开文件不会发送给 AI，也不运行任何脚本。
            </div>
          </div>
        </div>
      </aside>
    );
  }

  if (!resource || !revision) {
    return (
      <aside className={paneCls} style={flexStyle} aria-label="文件预览">
        <div className="preview-head">
          <span className="preview-head-title">文件预览</span>
        </div>
        <div className="preview-body">
          <div className="panel warning">
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 资源不可用</div>
            这份资源或其指定版本已不存在。界面<strong>不会</strong>用同名文件顶替。
            <div className="panel-actions">
              <button className="btn sm" onClick={() => active && closePreviewTab(active.key)}>关闭此标签</button>
            </div>
          </div>
        </div>
      </aside>
    );
  }

  const url = resource.relativePath ?? resource.title;
  const isFormalAttachment = resource.formalAttachment != null;
  const isWorktree = resource.formalWorktree != null;
  const isDelivery = resource.formalDelivery != null;
  /** 文件风味（R66 P2）：同一文件无论来自上传/工作区/正式交付都按此选渲染器——
   *  md=排版阅读、html=隔离页面预览、csv=表格、code=源码（带行号）、text=纯文本。 */
  const flavor = flavorOf(resource.title, isFormalAttachment ? resource.formalAttachment?.kind ?? '' : '', revision.content.kind);
  const canChooseReading = flavor === 'markdown' || flavor === 'html' || flavor === 'csv' || flavor === 'code' || flavor === 'text';
  const canWrap = canChooseReading;
  const supportsRendered = flavor === 'markdown' || flavor === 'csv' || flavor === 'html';

  /** 引用到目标（r61 合同：引用卡直写；focus-composer）。 */
  const doQuote = (excerpt?: string) => {
    const ok = quoteResource(active.resourceId, active.revision, quoteTarget.draftKey, quoteTarget.label, excerpt);
    if (ok) window.dispatchEvent(new CustomEvent('zs:focus-composer', { detail: quoteTarget.draftKey }));
    return ok;
  };
  /** 摘录（r61 独立通道）：正文当前内容前 160 字入队——只有正式附件有可摘录文本。 */
  const doExcerpt = () => {
    const text = excerptTextOf(active.resourceId);
    if (text == null || text.trim().length === 0) { toast('本预览还没有可摘录的内容文本（未装载或无文本层——OCR 未实现）', 'warn'); return; }
    const rev = String(revisionLabel(resource, active.revision));
    const r = queueDraftInsert(quoteTarget.draftKey, `> 摘录「${resource.title}」${rev}：${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    if (r.ok) {
      window.dispatchEvent(new CustomEvent('zs:focus-composer', { detail: quoteTarget.draftKey }));
      toast(r.queued === false ? '相同摘录已在待插入队列（不重复）' : '已摘录内容前 160 字到输入框正文', 'success');
    }
  };

  /**
   * 下载原文件/另存为（R66 P5）：保存**当前预览这份文件的原件字节**——
   *  · 正式附件：attachment.originalFile（audience+实根+sha256 核验的原件字节）；
   *  · 工作区文件：project.file.read（文本白名单——读到的就是原文件内容）；
   * 落盘经主进程「另存为」对话框（路径由用户选择——renderer 不能指定路径）；保存后按
   * 服务端返回的 bytes/hash 对账，不用提取窗或会话导出冒充当前文件。浏览器宿主回退
   * <a download>（data: URL——探针环境可用；桌面端优先窄桥）。
   */
  const doDownloadOriginal = async () => {
    if (dlBusy) return;
    setDlBusy(true);
    try {
      let name = resource.title;
      let contentBase64 = '';
      let fact = '';
      if (isFormalAttachment) {
        const fa = resource.formalAttachment!;
        const r = await command<{ filename: string | null; hash: string; bytes: number; bytesBase64: string }>('attachment.originalFile', { attachmentId: fa.attachmentId, conversationId: fa.conversationId ?? '' });
        name = r.filename ?? resource.title;
        contentBase64 = r.bytesBase64;
        fact = `原件 ${r.bytes}B · sha256 ${r.hash.slice(0, 12)}…（服务端核验一致）`;
      } else if (isWorktree) {
        // R67 P1-A：保存=**读取时快照字节**（readFull includeBytes 捕获的原字节——BOM/行尾
        // 保持，不重编码文本、不点击时重读）。磁盘已更新（pendingRevision）时拦截：先重新
        // 加载再保存——旧标签不静默另存新字节。
        const snap = worktreeSnapshots.get(`${resource.id}:${active.revision}`);
        if (snap == null) { toast('这份工作区文件的读取快照不可用（重新打开文件后再保存）', 'warn'); return; }
        if (resource.mutable && active.pendingRevision) { toast('磁盘上的文件已更新——请先点上方「重新加载」再保存（不静默另存新字节）', 'warn'); return; }
        contentBase64 = snap.bytesBase64;
        fact = `工作区原文件 ${snap.bytes}B · sha256 ${snap.sha256.slice(0, 12)}…（读取时快照）`;
      } else if (isDelivery) {
        // R68 §6：交付文档另存=已装载的正文按 UTF-8 编码落盘（文档本体即 turn 最终输出文本；
        // 身份以 manifest 呈现——正文 hash 与 manifest 的核对结果同时说明）。
        const fd = resource.formalDelivery!;
        const doc = deliveryDocs.get(`${resource.id}:${active.revision}`);
        if (doc == null || doc.text == null) { toast('这份交付没有可读文档（无正文可保存）', 'warn'); return; }
        const bytes = new TextEncoder().encode(doc.text);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
        contentBase64 = btoa(bin);
        name = resource.title.endsWith('.md') ? resource.title : `${resource.title}.md`;
        fact = `交付文档 v${fd.revision} · ${doc.bytes}B · manifest ${fd.manifestHash.slice(0, 12)}…${doc.hashMatch === false ? '（正文 hash 与 manifest 不一致——以 manifest 为验收身份）' : ''}`;
      } else {
        toast('这种来源暂不支持保存原文件（会话导出在会话头部菜单）', 'warn');
        return;
      }
      const dl = (window as unknown as { zsDownload?: { saveAs(p: { suggestedName: string; contentBase64: string }): Promise<{ ok: boolean; cancelled?: boolean; path?: string; bytes?: number }> } }).zsDownload;
      if (dl != null) {
        const r = await dl.saveAs({ suggestedName: name, contentBase64 });
        if (r.cancelled === true) { toast('已取消另存为', 'info'); return; }
        if (!r.ok || r.path == null) { toast('另存为失败（主进程拒绝）', 'error'); return; }
        toast(`已保存原文件：${r.path}（${fact}）`, 'success');
      } else {
        const a = document.createElement('a');
        a.href = `data:application/octet-stream;base64,${contentBase64}`;
        a.download = name;
        a.click();
        toast(`已触发浏览器下载「${name}」（${fact}）`, 'success');
      }
    } catch (e: unknown) {
      toast(`保存原文件失败：${(e as Error).message}`, 'error');
    } finally {
      setDlBusy(false);
    }
  };

  return (
    <aside className={paneCls} style={flexStyle} aria-label="文件预览">
      {/* ---------- 第一行：文件标签 ---------- */}
      <div className="preview-tabs" role="tablist" aria-label="已打开的文件">
        <PreviewNavControl singleRegion={singleRegion} onBackToContext={onBackToContext} onCollapse={hidePreview} />
        <div className="preview-tab-strip" ref={tabStripRef}>
          {tabs.map((t) => {
            const r = resourceOf(s, t.resourceId);
            const on = t.key === active.key;
            const shown = tabNames.get(t.key) ?? r?.title ?? '未知文件';
            const ver = r ? revisionLabel(r, t.revision) : '';
            return (
              <span key={t.key} className={`preview-tab${on ? ' on' : ''}`}>
                <button
                  role="tab"
                  aria-selected={on}
                  className="preview-tab-label"
                  onClick={() => activatePreview(t.key)}
                  onAuxClick={(e) => { if (e.button === 1) closePreviewTab(t.key); }}
                  title={`${r?.relativePath ?? r?.title ?? t.key}${ver ? ` · ${ver}` : ''}`}
                >
                  <Icon name="file-text" size={11} />
                  <span className="truncate">{shown}</span>
                  {ver ? <span className="faint mono-sm">{ver}</span> : null}
                </button>
                <button
                  className="preview-tab-close"
                  aria-label={`关闭 ${shown}${ver ? ` ${ver}` : ''}`}
                  title="关闭这个文件（不影响其他标签）"
                  onClick={() => closePreviewTab(t.key)}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            );
          })}
        </div>
        {tabsOverflow || hiddenCount > 0 ? (
          <button
            className="preview-icon-btn"
            title={hiddenCount > 0
              ? `已打开 ${tabs.length} 个标签，另有 ${hiddenCount} 个在当前上下文不可见（已暂藏）`
              : `已打开 ${tabs.length} 个标签（标签条放不下，点这里看全部）`}
            aria-label="已打开的文件"
            onClick={(e) => setOpenList(anchorFromElement(e.currentTarget))}
          >
            <Icon name="list" size={13} />
            {hiddenCount > 0 ? <span className="faint small">{hiddenCount} 暂藏</span> : null}
          </button>
        ) : null}
        {session.maximized ? (
          <button className="btn ghost sm preview-restore" title="还原预览大小（回到与对话并排）" aria-pressed onClick={togglePreviewMaximized}>
            <Icon name="copy" size={12} /> 还原
          </button>
        ) : null}
      </div>

      {/* ---------- 第二行：当前文件的工具 ---------- */}
      <div className="preview-tools">
        {resource.mutable && active.pendingRevision ? (
          <button
            className="tag-btn warning"
            title="磁盘上的文件已更新。点击重新加载会切换到这个标签的读取快照；已插入草稿的引用仍绑定原版本"
            onClick={() => { reloadResource(active.pendingRevision!, active.key); worktreeReadBump(active.resourceId); }}
          >
            <Icon name="alert-triangle" size={10} /> 磁盘已更新 · 重新加载
          </button>
        ) : null}
        <div className="spacer" />
        {canChooseReading ? (
          <button
            className={`btn ghost sm preview-read${readAt ? ' open' : ''}`}
            aria-haspopup="menu"
            title="切换阅读方式（当前已标出）"
            onClick={(e) => setReadAt(anchorFromElement(e.currentTarget))}
          >
            <Icon name={viewMode === 'source' ? 'align-left' : 'eye'} size={11} />
            {viewMode === 'source' ? '源码视图' : '阅读视图'}
            <Icon name="chevron-down" size={11} />
          </button>
        ) : null}
        {revision.content.kind === 'image' ? (
          <div className="seg tiny" role="group" aria-label="图片缩放">
            <button className={zoom === 0 ? 'on' : ''} onClick={() => setZoom(0)} title="适应窗口">适应</button>
            <button className={zoom === 1 ? 'on' : ''} onClick={() => setZoom(1)} title="原始尺寸">1:1</button>
            <button className={zoom === 1.5 ? 'on' : ''} onClick={() => setZoom(1.5)} title="放大 150%">150%</button>
          </div>
        ) : null}
        <button
          className="btn sm primary"
          title={`把这份文件的固定版本插入「${quoteTarget.label}」草稿；需你再次点击发送才会进入对话`}
          onClick={() => doQuote()}
        >
          <Icon name="corner-down-right" size={12} /> 引用到 {quoteTarget.label}
        </button>
        {isFormalAttachment ? (
          <button className="btn ghost sm" title="把当前内容文本的前 160 字摘录到输入框正文（独立于文件引用——只来自内容，不含界面说明）" onClick={doExcerpt}>
            <Icon name="quote" size={11} /> 摘录
          </button>
        ) : null}
        <button
          className="preview-icon-btn"
          aria-label="更多文件操作"
          title="更多：文件信息、复制路径、评论、放大、关闭"
          aria-haspopup="menu"
          onClick={(e) => setMoreAt(anchorFromElement(e.currentTarget))}
        >
          <Icon name="more-horizontal" size={13} />
        </button>
      </div>

      {readAt ? (
        <Menu anchor={readAt} onClose={() => setReadAt(null)}>
          <div className="menu-label">阅读方式</div>
          {supportsRendered ? (
            <>
              <MenuItem icon="eye" title={flavor === 'html' ? '隔离页面预览：脚本禁用、外部资源不加载（保留可支持的页面结构与样式）' : '把 Markdown / CSV 渲染成排版后的样子'} hint={viewMode === 'preview' ? '当前' : undefined} onClick={() => { setViewMode('preview'); setReadAt(null); }}>{flavor === 'html' ? '页面视图（隔离预览）' : '阅读视图'}</MenuItem>
              <MenuItem icon="align-left" title="按原始文本显示（保留空白，带行号）" hint={viewMode === 'source' ? '当前' : undefined} onClick={() => { setViewMode('source'); setReadAt(null); }}>源码视图</MenuItem>
            </>
          ) : (
            <div className="menu-note">这个文件只有代码/纯文本视图，界面不假装能渲染成富文本。需要时可切换自动换行。</div>
          )}
          {canWrap ? (
            <MenuItem icon="align-left" title="长行是否折行显示（只影响源码/纯文本视图）" hint={wrapSource ? '当前：换行' : '当前：不换行'} onClick={() => { setWrapSource((v) => !v); setReadAt(null); }}>
              {wrapSource ? '取消自动换行' : '自动换行'}
            </MenuItem>
          ) : null}
        </Menu>
      ) : null}

      {/* 来源：只显示一次；正式附件=真实会话归属，工作区=项目目录 */}
      <div className="preview-origin">
        <Icon name="link" size={11} className="faint" />
        <span className="truncate" title={`来源：${originLabel(s, resource)}`}>来源：{originLabel(s, resource)}</span>
        {openedFromAddsInfo(s, resource, active.openedFrom) ? (
          <>
            <span className="faint">·</span>
            <span className="truncate" title={`本次从 ${openedFromLabel(s, active.openedFrom)} 打开`}>从 {openedFromLabel(s, active.openedFrom)} 打开</span>
          </>
        ) : null}
        <span className="faint">·</span>
        <span title={isWorktree ? '项目工作区文件——只读快照（project.file.read，安全根内）' : isDelivery ? '正式 AI 交付文档——不可变快照（delivery.document，版本=交付 revision、hash=manifest）' : '会话附件/成果——服务端托管（audience 校验）'}>
          <Tag plain>{isWorktree ? '工作区只读' : isDelivery ? 'AI 交付文档' : '会话资源'}</Tag>
        </span>
      </div>

      {/* ---------- 正文 ---------- */}
      <div
        className="preview-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (scrollTimer.current) window.clearTimeout(scrollTimer.current);
          scrollTimer.current = window.setTimeout(() => rememberScroll(active.key, el.scrollTop), 220);
        }}
        onMouseUp={() => {
          const sel = window.getSelection()?.toString() ?? '';
          setSelection(sel.trim().slice(0, 400));
        }}
      >
        {isFormalAttachment ? (
          <FormalAttachmentBody
            key={`${resource.id}:${active.revision}`}
            resource={resource}
            viewMode={viewMode}
            wrapSource={wrapSource}
            onOpenComment={() => setCommentOpen(true)}
          />
        ) : isWorktree ? (
          <WorktreeBody
            key={`${resource.id}:${active.revision}`}
            resource={resource}
            viewMode={viewMode}
            wrapSource={wrapSource}
            onOpenComment={() => setCommentOpen(true)}
          />
        ) : isDelivery ? (
          <DeliveryBody
            key={`${resource.id}:${active.revision}`}
            resource={resource}
            viewMode={viewMode}
            wrapSource={wrapSource}
            onOpenComment={() => setCommentOpen(true)}
          />
        ) : (
          <ResourceBody
            resource={resource}
            revision={revision}
            viewMode={viewMode}
            wrapSource={wrapSource}
            zoom={zoom}
            onOpenComment={() => setCommentOpen(true)}
          />
        )}
      </div>

      {selection ? (
        <button
          type="button"
          className="preview-quote-selection"
          title={`把选中的文字作为摘录加入「${quoteTarget.label}」草稿；仍需你点击发送`}
          onClick={() => { if (doQuote(selection)) setSelection(''); }}
        >
          <Icon name="corner-down-right" size={12} /> 引用选区
        </button>
      ) : null}

      {/* ---------- 浮层 ---------- */}
      {openList ? (
        <Menu anchor={openList} onClose={() => setOpenList(null)}>
          <div className="menu-label">已打开的文件（{tabs.length}{hiddenCount > 0 ? ` · ${hiddenCount} 个已暂藏` : ''}）</div>
          {tabs.map((t) => {
            const r = resourceOf(s, t.resourceId);
            return (
              <MenuItem key={t.key} icon="file-text" hint={t.key === active.key ? '当前' : undefined} onClick={() => { activatePreview(t.key); setOpenList(null); }}>
                {r?.title ?? t.key}{r && !r.mutable ? ` · v${t.revision}` : ''}
              </MenuItem>
            );
          })}
          <MenuItem icon="x" onClick={() => { closeAllPreviews(); setOpenList(null); }}>关闭所有文件</MenuItem>
        </Menu>
      ) : null}

      {moreAt ? (
        <Menu anchor={moreAt} onClose={() => setMoreAt(null)}>
          <div className="menu-label">{resource.title}</div>
          <MenuItem icon="info" title="完整路径、版本、内容 hash、来源与可见范围" onClick={() => { setInfoOpen(true); setMoreAt(null); }}>文件信息</MenuItem>
          <MenuItem
            icon="copy"
            title={`复制「路径 (版本, hash)」：${resource.relativePath ?? resource.title}`}
            onClick={() => {
              void navigator.clipboard?.writeText(`${resource.relativePath ?? resource.title} (${revisionLabel(resource, active.revision)}, ${revision.hash})`);
              setMoreAt(null);
            }}
          >
            复制路径与版本
          </MenuItem>
          <MenuItem
            icon="download"
            title={`保存当前这份文件的原件字节（${isFormalAttachment ? 'attachment.originalFile：服务端 sha256 核验' : isWorktree ? 'project.file.read：工作区原文件读取快照' : isDelivery ? 'delivery.document：交付文档正文（UTF-8）' : '当前来源'}）；路径经系统另存为对话框由你选择`}
            disabled={dlBusy}
            onClick={() => { void doDownloadOriginal(); setMoreAt(null); }}
          >
            {dlBusy ? '正在取原件…' : '下载原文件 / 另存为…'}
          </MenuItem>
          <MenuItem icon="message-square" title="以这份文件的当前版本为锚点发一条仅记录评论到源会话（不触发模型）" onClick={() => { setCommentOpen(true); setMoreAt(null); }}>评论此文件</MenuItem>
          <MenuItem icon={session.maximized ? 'copy' : 'maximize'} title={session.maximized ? '回到与对话并排的大小' : '临时占满内容区，便于细读长文件'} onClick={() => { togglePreviewMaximized(); setMoreAt(null); }}>
            {session.maximized ? '还原预览大小' : '放大预览'}
          </MenuItem>
          {singleRegion ? (
            <MenuItem icon="chevron-right" title="保留全部标签与阅读位置，稍后可重开（不会关闭文件）" onClick={() => { hidePreview(); setMoreAt(null); }}>收起预览</MenuItem>
          ) : null}
          <MenuItem icon="x" title="只关闭当前这个标签，其他标签不受影响" onClick={() => { closePreviewTab(active.key); setMoreAt(null); }}>关闭此文件</MenuItem>
          <MenuItem icon="panel-right" title="清空全部标签、退出预览；不会删除磁盘文件" onClick={() => { closeAllPreviews(); setMoreAt(null); }}>关闭所有文件</MenuItem>
        </Menu>
      ) : null}

      {infoOpen ? (
        <Modal onClose={() => setInfoOpen(false)} size="md" title="文件信息">
          <dl className="kv">
            <dt>文件名</dt><dd>{resource.title}</dd>
            <dt>完整路径</dt><dd className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{url}</dd>
            <dt>版本</dt>
            <dd>
              {revisionLabel(resource, active.revision)}
              <span className="faint"> · {resource.mutable ? '工作区读取快照（随磁盘更新，需手动重新加载）' : '固定交付/附件版本'}</span>
            </dd>
            <dt>内容 hash</dt><dd className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{revision.hash}</dd>
            <dt>大小</dt><dd>{formatBytes(revision.sizeBytes)}</dd>
            <dt>类型</dt><dd className="mono-sm">{resource.formalAttachment ? KIND_LABEL[resource.formalAttachment.kind] ?? resource.formalAttachment.kind : resource.mimeType}</dd>
            <dt>版本时间</dt><dd>{fullTime(revision.createdAt)}</dd>
            <dt>来源</dt><dd>{originLabel(s, resource)}</dd>
            <dt>可见范围</dt>
            <dd>
              {resource.audience.kind === 'room' ? '本房间成员' : resource.audience.kind === 'dm' ? '仅这条私信的参与者' : '项目成员'}
            </dd>
            {isFormalAttachment && ['text_file', 'code_file'].includes(resource.formalAttachment?.kind ?? '') ? (
              <>
                <dt>屏幕阅读 / 模型注入</dt>
                <dd>屏幕阅读=托管副本<strong>全文</strong>（完整文件，≤256KB 上传上限）；模型注入=前 64KB <strong>提取窗</strong>（预算合同）——两者分列，预览内容不等于发给模型的范围</dd>
              </>
            ) : null}
            <dt>本次打开位置</dt><dd>{openedFromLabel(s, active.openedFrom)}</dd>
          </dl>
        </Modal>
      ) : null}

      {commentOpen ? (
        <CommentDialog resource={resource} revision={revision} onClose={() => setCommentOpen(false)} />
      ) : null}
    </aside>
  );
}

const scrollTimer = { current: 0 as number | undefined };

/* ============================================================
   正文渲染 A：会话附件/成果——正式渲染器（attachment.preview* 异步装载）
   ============================================================ */

/**
 * R67 P1-A：工作区文件**读取时快照**（原字节+sha256）——「下载原文件」用这里的字节，
 * 不在点击时重读磁盘（源文件后来变化不静默另存新字节；界面另有「磁盘已更新·重新加载」
 * 提示链）。键=resourceId:revision（重新加载 bump 后新快照替换）。
 */
const worktreeSnapshots = new Map<string, { bytesBase64: string; sha256: string; bytes: number; mtimeMs: number }>();

/** 各格式子组件装载后上报的摘录文本（src=resourceId——仅当前资源生效）。 */
const excerptReports = new Map<string, string>();
function reportExcerpt(resourceId: string, text: string): void { excerptReports.set(resourceId, text); }
function excerptTextOf(resourceId: string): string | null { return excerptReports.get(resourceId) ?? null; }

function FormalAttachmentBody({ resource, viewMode, wrapSource, onOpenComment }: { resource: PreviewResource; viewMode: 'preview' | 'source'; wrapSource: boolean; onOpenComment: () => void }) {
  const fa = resource.formalAttachment!;
  const [err, setErr] = useState<string | null>(null);
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const viewerRef = useRef<PptxViewer | null>(null);
  const target: { attachmentId: string; filename: string; kind: string; conversationId?: string; origin?: string; hashHint?: string; revisionHint?: number | string } = {
    attachmentId: fa.attachmentId,
    filename: resource.title,
    kind: fa.kind,
    conversationId: fa.conversationId ?? '',
  };
  const releaseResources = () => {
    if (abortRef.current != null) { try { abortRef.current.abort(new Error('preview-superseded')); } catch { /* 已中止 */ } abortRef.current = null; }
    if (viewerRef.current != null) { try { viewerRef.current.dispose(); } catch { /* 已释放 */ } viewerRef.current = null; }
  };
  useEffect(() => () => { genRef.current += 1; releaseResources(); reportExcerpt(fa.attachmentId, ''); }, []);
  const alive = () => true;
  const onErr = (e: string) => setErr(e);
  const onIdentity = () => undefined;

  if (err != null) {
    return (
      <div className="panel warning">
        <div className="panel-title"><Icon name="alert-triangle" size={13} /> 预览失败</div>
        {err}
        <div className="panel-actions">
          <button className="btn sm" onClick={() => setErr(null)}>重试（切标签再切回）</button>
          <button className="btn sm" onClick={onOpenComment}>评论此文件</button>
        </div>
      </div>
    );
  }
  if (fa.kind === 'text_file' || fa.kind === 'code_file') {
    // R66 P2：文本/代码类附件走**完整文件阅读器**（attachment.readFull 全文——与 64KB
    // 模型提取窗分列）：MD 默认排版阅读、HTML 默认隔离页面预览、代码/纯文本源码视图；
    // 阅读/源码切换经 viewMode 进入实际组件分支。
    return (
      <FullTextReader
        attachmentId={fa.attachmentId}
        filename={resource.title}
        conversationId={fa.conversationId ?? ''}
        viewMode={viewMode}
        wrapSource={wrapSource}
        onErr={onErr}
        onOpenComment={onOpenComment}
      />
    );
  }
  if (fa.kind === 'image_file') return <ImagePreview target={target} alive={alive} onErr={onErr} onIdentity={onIdentity} />;
  if (fa.kind === 'pdf_file') return <PdfPreview target={target} alive={alive} onErr={onErr} onIdentity={onIdentity} onContent={() => undefined} />;
  if (fa.kind === 'docx_file' || fa.kind === 'sheet_file' || fa.kind === 'slides_file') {
    return <OfficePreview target={target} alive={alive} onErr={onErr} abortRef={abortRef} viewerRef={viewerRef} onIdentity={onIdentity} onContent={() => undefined} />;
  }
  return (
    <div className="preview-unsupported">
      <Icon name="alert-triangle" size={20} className="faint" />
      <div className="strong" style={{ marginTop: 8 }}>这种格式当前不能预览</div>
      <div className="small muted" style={{ marginTop: 6, maxWidth: 420, lineHeight: 1.7 }}>
        该类型（{fa.kind}）的共享预览未接入。文件本体已在会话中托管（真实 attachmentId），保存与引用不受影响。
      </div>
      <div className="panel-actions">
        <button className="btn sm" onClick={onOpenComment}><Icon name="message-square" size={12} /> 评论此文件（文件级锚点）</button>
      </div>
    </div>
  );
}

/* ============================================================
   完整文件阅读器（R66 P2）：attachment.readFull 全文 + 按风味渲染。
   屏幕阅读=托管副本全文（≤256KB 有界）；模型注入仍走 64KB 提取窗（预算合同不变，
   技术说明收进「文件信息」——不占据阅读主体）。
   ============================================================ */

type FileFlavor = 'markdown' | 'html' | 'csv' | 'code' | 'text' | 'binary';

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rs', '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lua', '.r', '.m', '.pl']);

/** 文件风味：revision 内容 kind（工作区/已装载）优先，否则按文件名扩展名 + 附件 kind 推导。 */
function flavorOf(filename: string, formalKind: string, contentKind: string | undefined): FileFlavor {
  if (contentKind === 'markdown') return 'markdown';
  if (contentKind === 'csv') return 'csv';
  if (contentKind === 'code') return 'code';
  if (contentKind === 'text') {
    // 内容层只知「纯文本」——具体风味按文件名分（.md/.html 上传件走这里）。
    return flavorByExt(filename, formalKind);
  }
  return flavorByExt(filename, formalKind);
}
function flavorByExt(filename: string, formalKind: string): FileFlavor {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.csv') return 'csv';
  if (CODE_EXTS.has(ext)) return 'code';
  if (formalKind === 'code_file') return 'code';
  if (formalKind === 'text_file' || formalKind === '') return 'text';
  return 'binary';
}

function FullTextReader({ attachmentId, filename, conversationId, viewMode, wrapSource, onErr, onOpenComment }: {
  attachmentId: string; filename: string; conversationId: string;
  viewMode: 'preview' | 'source'; wrapSource: boolean;
  onErr: (e: string) => void; onOpenComment: () => void;
}) {
  const flavor = flavorByExt(filename, '');
  const [d, setD] = useState<{ text: string; originalBytes: number; hash: string; revision: number } | null>(null);
  useEffect(() => {
    let done = false;
    void command<{ text: string; originalBytes: number; hash: string; revision: number }>('attachment.readFull', { attachmentId, conversationId })
      .then((r) => { if (!done) { setD(r); reportExcerpt(attachmentId, r.text); } })
      .catch((e: unknown) => { if (!done) onErr(String((e as Error).message)); });
    return () => { done = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId, conversationId]);
  if (d == null) return <div className="panel info">正在读取文件全文（只读）…</div>;
  if (flavor === 'markdown' && viewMode === 'preview') {
    return (
      <div className="preview-read-doc">
        <MarkdownView text={d.text} />
      </div>
    );
  }
  if (flavor === 'html' && viewMode === 'preview') {
    return <HtmlPageView html={d.text} filename={filename} />;
  }
  if (flavor === 'text' || flavor === 'binary') {
    return (
      <>
        <SourceView text={d.text} language="text" wrap={wrapSource} />
        {flavor === 'binary' ? null : null}
      </>
    );
  }
  return <SourceView text={d.text} language={flavor === 'code' ? 'code' : flavor} wrap={wrapSource} />;
}

/**
 * HTML 隔离页面预览（R66 P2）：sandbox iframe（**无** allow-scripts/allow-same-origin/
 * allow-popups——文件脚本不执行、与应用 DOM/IPC/Node 隔离）+ 注入 CSP（default-src 'none'
 * ——外部资源不加载、不联网；内联样式可用以保留页面观感）+ base target=_blank（链接点击
 * 被沙箱拦截——不导航不弹窗）。交互网页暂不支持，如实说明（不退回整页源码）。
 */
function HtmlPageView({ html, filename }: { html: string; filename: string }) {
  const srcDoc = useMemo(() => {
    const guard = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\' data:; img-src data: blob:; font-src data:; media-src data:"><base target="_blank">';
    const headIdx = html.search(/<head[^>]*>/i);
    if (headIdx >= 0) {
      const insertAt = headIdx + html.slice(headIdx).indexOf('>') + 1;
      return `${html.slice(0, insertAt)}${guard}${html.slice(insertAt)}`;
    }
    return `${guard}${html}`;
  }, [html]);
  return (
    <div className="preview-html-host">
      <iframe
        title={`HTML 页面预览：${filename}`}
        sandbox=""
        srcDoc={srcDoc}
        className="preview-html-frame"
        data-zs-html-frame="1"
      />
      <div className="preview-html-note small faint">
        静态页面预览：脚本已禁用、外部资源不加载（隔离渲染）；链接与交互暂不支持——切「源码视图」可看原文。
      </div>
    </div>
  );
}

/* ============================================================
   正文渲染 B：工作区文件——project.file.read 实际读取后按内容 kind 渲染
   ============================================================ */

interface FileReadFullData { projectId: string; path: string; baseName: string; bytes: number; sha256: string; content: string; truncated: false; mtimeMs: number; bytesBase64?: string; note: string }

function WorktreeBody({ resource, viewMode, wrapSource, onOpenComment }: { resource: PreviewResource; viewMode: 'preview' | 'source'; wrapSource: boolean; onOpenComment: () => void }) {
  const wt = resource.formalWorktree!;
  const [err, setErr] = useState<string | null>(null);
  // R68 修正：读取代次取**最新追加版本**（markResourceUpdated 会追加 r2/r3；此前固定读
  // revisions[0] 会在重载切换后拿旧代次——快照键与活动标签错位导致「快照不可用」）。
  const rev = resource.revisions[resource.revisions.length - 1];
  const [loadedFor, setLoadedFor] = useState('');
  useEffect(() => {
    let done = false;
    setErr(null);
    const marker = `${wt.projectId}:${wt.path}:${rev?.revision ?? 0}`;
    void command<FileReadFullData>('project.file.readFull', { projectId: wt.projectId, path: wt.path, includeBytes: true })
      .then((r) => {
        if (done) return;
        if (r.bytesBase64 != null) {
          worktreeSnapshots.set(`${resource.id}:${rev?.revision ?? 0}`, { bytesBase64: r.bytesBase64, sha256: r.sha256, bytes: r.bytes, mtimeMs: r.mtimeMs });
        }
        setLoadedFor(marker);
        applyWorktreeRead(resource.id, { text: r.content, hash: r.sha256, sizeBytes: r.bytes });
        reportExcerpt(resource.id, r.content);
      })
      .catch((e: unknown) => { if (!done) setErr(String((e as Error).message)); });
    return () => { done = true; };
    // 读取按 (project, path, revision)——重新加载 bump revision 后重读（快照键同步替换）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt.projectId, wt.path, rev?.revision]);

  // R68 §6：磁盘脏检测（低频轮询，可见时每 8s）——mtime/bytes 与读取快照不一致 → 追加新
  // 版本并标记 pendingRevision（工具行出现「磁盘已更新·重新加载」；保存被拦截）。用户显式
  // 重载才切换快照；旧引用仍绑原版本（引用在插入时冻结 hash）。不可见/装载失败静默重试。
  useEffect(() => {
    if (loadedFor === '') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void command<{ mtimeMs: number; bytes: number }>('project.file.stat', { projectId: wt.projectId, path: wt.path })
        .then((st) => {
          const snap = worktreeSnapshots.get(`${resource.id}:${rev?.revision ?? 0}`);
          if (snap == null) return;
          if (st.mtimeMs !== snap.mtimeMs || st.bytes !== snap.bytes) markResourceUpdated(resource.id);
        })
        .catch(() => { /* stat 失败（文件被删等）：读取失败路径由打开/重载呈现——轮询静默 */ });
    }, 8000);
    return () => { window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedFor, wt.projectId, wt.path, rev?.revision]);
  if (err != null) {
    return (
      <div className="preview-unsupported">
        <Icon name="alert-triangle" size={20} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>这份文件当前不能预览</div>
        <div className="small muted" style={{ marginTop: 6, maxWidth: 440, lineHeight: 1.7 }}>{err}</div>
        <div className="small faint" style={{ marginTop: 8 }}>
          完整阅读/原件保存白名单=文本类（≤256KB、合法 UTF-8）；二进制/超限请用系统工具打开。
          打开文件不会把内容发送给 AI。
        </div>
        <div className="panel-actions">
          <button className="btn sm" onClick={onOpenComment}>评论此文件</button>
        </div>
      </div>
    );
  }
  if (loadedFor === '') return <div className="panel info">正在读取文件全文（只读快照）…</div>;
  const c = rev?.content;
  if (c == null || c.kind === 'unsupported') return <div className="panel info">正在装载内容…</div>;
  // R67 P2-B：工作区与上传/正式成果**共用同一风味分发**——MD 排版阅读、HTML 隔离页面预览，
  // 其余（csv/code/text）沿用源码/表格视图；阅读/源码切换经 viewMode 进入实际分支。
  const flavor = flavorByExt(resource.relativePath ?? resource.title, '');
  if (flavor === 'markdown' && viewMode === 'preview') {
    return (
      <div className="preview-read-doc">
        <MarkdownView text={c.kind === 'markdown' || c.kind === 'text' || c.kind === 'code' ? c.text : ''} />
      </div>
    );
  }
  if (flavor === 'html' && viewMode === 'preview') {
    return <HtmlPageView html={c.kind === 'text' || c.kind === 'code' || c.kind === 'markdown' ? c.text : ''} filename={resource.title} />;
  }
  return <ResourceBodyContent content={c} viewMode={viewMode} wrapSource={wrapSource} zoom={0} onOpenComment={onOpenComment} />;
}

/** 工作区「重新加载」：bump 读取代次（触发 WorktreeBody 重读）。 */
function worktreeReadBump(resourceId: string): void {
  // reloadResource 已把 tab.revision 指向 pendingRevision；资源侧补一个新读取版本
  markResourceUpdated(resourceId);
}

/* ============================================================
   正文渲染 B2：正式 AI 交付文档（R68 §6 第三来源）——delivery.document 按需装载。
   文档=turn 最终输出（manifestHash 即其 sha256）——hashMatch 如实显示；不可变快照
   （无工作区「重新加载」链），阅读/源码切换与上传/工作区同一风味分发。
   ============================================================ */

interface DeliveryDocData {
  deliveryId: string; revision: number; manifestHash: string; taskIdTitle: string;
  conversationId: string; threadId: string | null; audience: 'dm' | 'room';
  text: string | null; hashMatch: boolean | null; bytes: number; note?: string;
}

/** 交付文档装载缓存（resourceId:revision → 文档）——下载原文件用同一份文本，不二次请求。 */
const deliveryDocs = new Map<string, DeliveryDocData>();

/** TaskComplete 输出合同（自然交付的最终 JSON——阅读视图按字段结构呈现）。 */
interface TaskCompleteDoc {
  schemaVersion?: string;
  resultKey?: string;
  changeSummary?: string;
  files?: string[];
  executedVerifications?: string[];
  unexecutedVerifications?: Array<{ item?: string; reason?: string }>;
  remainingIssues?: string[];
}

function DeliveryBody({ resource, viewMode, wrapSource, onOpenComment }: { resource: PreviewResource; viewMode: 'preview' | 'source'; wrapSource: boolean; onOpenComment: () => void }) {
  const fd = resource.formalDelivery!;
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const rev = resource.revisions[0];
  useEffect(() => {
    let done = false;
    setErr(null);
    void command<DeliveryDocData>('delivery.document', { deliveryId: fd.deliveryId })
      .then((r) => {
        if (done) return;
        deliveryDocs.set(`${resource.id}:${rev?.revision ?? 0}`, r);
        if (r.text != null) {
          applyDeliveryRead(resource.id, { text: r.text, bytes: r.bytes, revision: rev?.revision ?? 1 });
          reportExcerpt(resource.id, r.text);
        }
        setLoaded(true);
      })
      .catch((e: unknown) => { if (!done) setErr(String((e as Error).message)); });
    return () => { done = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fd.deliveryId, rev?.revision, nonce]);
  if (err != null) {
    return (
      <div className="panel warning">
        <div className="panel-title"><Icon name="alert-triangle" size={13} /> 交付文档读取失败</div>
        {err}
        <div className="panel-actions">
          <button className="btn sm" onClick={() => { setErr(null); setLoaded(false); setNonce((n) => n + 1); }}>重试</button>
        </div>
      </div>
    );
  }
  if (!loaded) return <div className="panel info">正在读取交付文档（只读）…</div>;
  const doc = deliveryDocs.get(`${resource.id}:${rev?.revision ?? 0}`);
  if (doc == null || doc.text == null) {
    return (
      <div className="preview-unsupported">
        <Icon name="file-text" size={20} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>这份交付没有可读文档</div>
        <div className="small muted" style={{ marginTop: 6, maxWidth: 440, lineHeight: 1.7 }}>
          {doc?.note ?? '交付的最终输出未持久化为可读文档'}——交付身份仍有效：v{fd.revision} · manifest {fd.manifestHash.slice(0, 12)}…（验收/引用按「详情」与引用通道进行）。
        </div>
        <div className="panel-actions">
          <button className="btn sm" onClick={onOpenComment}>评论此交付（会话锚点）</button>
        </div>
      </div>
    );
  }
  const c = rev?.content;
  if (c == null || c.kind === 'unsupported') return <div className="panel info">正在装载内容…</div>;
  const rawText = c.kind === 'markdown' || c.kind === 'text' || c.kind === 'code' ? c.text : '';
  // 自然交付的最终输出=TaskComplete JSON（dispatchWorker 输出合同校验）——阅读视图按其
  // 字段结构呈现（changeSummary 为主体）；解析失败（非自然链/历史数据）回退原文显示。
  let tc: TaskCompleteDoc | null = null;
  try {
    const parsed = JSON.parse(rawText) as Partial<TaskCompleteDoc>;
    if (parsed != null && typeof parsed === 'object' && typeof parsed.schemaVersion === 'string' && parsed.schemaVersion.startsWith('task-complete')) tc = parsed as TaskCompleteDoc;
  } catch { tc = null; }
  return (
    <>
      {viewMode === 'preview' && tc != null ? (
        <div className="preview-read-doc" data-zs-delivery-doc="1">
          <MarkdownView text={tc.changeSummary ?? '（changeSummary 缺失）'} />
          {tc.files != null && tc.files.length > 0 ? (
            <div className="small" style={{ marginTop: 10 }}><strong>涉及文件</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.files.map((f, i) => <li key={i} className="mono-sm">{f}</li>)}</ul></div>
          ) : null}
          {tc.executedVerifications != null && tc.executedVerifications.length > 0 ? (
            <div className="small" style={{ marginTop: 8 }}><strong>已执行验证</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.executedVerifications.map((v, i) => <li key={i}>{v}</li>)}</ul></div>
          ) : null}
          {tc.unexecutedVerifications != null && tc.unexecutedVerifications.length > 0 ? (
            <div className="small" style={{ marginTop: 8 }}><strong>未执行验证</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.unexecutedVerifications.map((v, i) => <li key={i}>{v.item ?? ''}{v.reason != null ? `——${v.reason}` : ''}</li>)}</ul></div>
          ) : null}
          {tc.remainingIssues != null && tc.remainingIssues.length > 0 ? (
            <div className="small" style={{ marginTop: 8 }}><strong>遗留问题</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.remainingIssues.map((v, i) => <li key={i}>{v}</li>)}</ul></div>
          ) : null}
          <div className="small faint" style={{ marginTop: 10, borderTop: '1px solid var(--border,#dbe2ea)', paddingTop: 8 }}>
            交付文档 v{fd.revision} · {doc.bytes}B · manifest {fd.manifestHash.slice(0, 12)}…{doc.hashMatch === true ? '（正文 hash 与 manifest 核对一致）' : doc.hashMatch === false ? '（**正文 hash 与 manifest 不一致**——以 manifest 为验收身份，正文仅供阅读）' : ''}；「源码视图」查看原始 JSON。
          </div>
        </div>
      ) : (
        <SourceView text={rawText} language="json" wrap={wrapSource} />
      )}
    </>
  );
}

/* ============================================================
   正文渲染 C：内容 kind 分发（原型 §8.1——markdown/code/text/csv/image/diff/unsupported）
   ============================================================ */

function ResourceBody({ resource, revision, viewMode, wrapSource, zoom, onOpenComment }: {
  resource: PreviewResource; revision: ResourceRevision; viewMode: 'preview' | 'source'; wrapSource: boolean; zoom: number; onOpenComment: () => void;
}) {
  return <ResourceBodyContent content={revision.content} viewMode={viewMode} wrapSource={wrapSource} zoom={zoom} onOpenComment={onOpenComment} />;
}

function ResourceBodyContent({ content: c, viewMode, wrapSource, zoom, onOpenComment }: {
  content: import('../data/types').ResourceContent; viewMode: 'preview' | 'source'; wrapSource: boolean; zoom: number; onOpenComment: () => void;
}) {
  switch (c.kind) {
    case 'markdown':
      return viewMode === 'source'
        ? <SourceView text={c.text} language="markdown" wrap={wrapSource} />
        : <MarkdownView text={c.text} />;
    case 'code':
      return <SourceView text={c.text} language={c.language} wrap={wrapSource} />;
    case 'text':
      return <SourceView text={c.text} language="text" wrap={wrapSource} />;
    case 'csv':
      return viewMode === 'source'
        ? <SourceView text={c.text} language="csv" wrap={wrapSource} />
        : <CsvView text={c.text} />;
    case 'image':
      return (
        <div className={`preview-image-wrap${zoom > 1 ? ' scroll' : ''}`}>
          <img
            src={c.dataUrl}
            alt="预览图片"
            className="preview-image"
            style={zoom === 0 ? { maxWidth: '100%', maxHeight: '100%' } : { width: `${c.width * zoom}px` }}
          />
          <div className="preview-image-meta small faint">{c.width} × {c.height}</div>
        </div>
      );
    case 'diff':
      return <DiffText left={c.left} right={c.right} leftLabel={c.leftLabel} rightLabel={c.rightLabel} />;
    case 'unsupported':
      return (
        <div className="preview-unsupported">
          <Icon name="alert-triangle" size={20} className="faint" />
          <div className="strong" style={{ marginTop: 8 }}>这种格式当前不能预览</div>
          <div className="small muted" style={{ marginTop: 6, maxWidth: 420, lineHeight: 1.7 }}>{c.note}</div>
          <div className="panel-actions">
            <button className="btn sm" onClick={onOpenComment}><Icon name="message-square" size={12} /> 评论此文件（文件级锚点）</button>
          </div>
        </div>
      );
  }
}

/** 源码/纯文本视图：带行号，保留空白；可切换自动换行。 */
function SourceView({ text, language, wrap }: { text: string; language: string; wrap: boolean }) {
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <div className={`preview-source${wrap ? ' wrap' : ''}`} data-language={language}>
      {lines.map((l, i) => (
        <div className="preview-source-row" key={i}>
          <span className="preview-source-no">{i + 1}</span>
          <span className="preview-source-text">{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/** CSV 表格视图（真实 CSV 规则：引号内逗号/换行同格）。 */
function CsvView({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) return <div className="small faint">（空文件）</div>;
  const [head, ...body] = rows;
  return (
    <div className="preview-csv-wrap">
      <table className="preview-csv">
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>{head.map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <div className="small faint" style={{ marginTop: 8 }}>逻辑行数与单元格内的换行分别处理；引号内的逗号不作为分隔符。</div>
    </div>
  );
}

/** 最小 CSV 解析：支持双引号包裹、"" 转义、引号内换行 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/* ============================================================
   评论对话框（正式：向源会话仅记录提交，携带引用卡——不触发模型）
   ============================================================ */

function CommentDialog({ resource, revision, onClose }: { resource: PreviewResource; revision: ResourceRevision; onClose: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const s = useStore((x) => x);
  const originText = originLabel(s, resource);
  const isDm = resource.origin.kind === 'dm';
  return (
    <Modal
      size="md"
      title="评论此文件"
      subtitle={`固定 ${resource.title} · v${revision.revision} · ${revision.hash.slice(0, 14)}`}
      onClose={onClose}
      footer={
        <>
          <span className="small faint">评论=向源会话发一条「仅记录」消息并携带本文件引用卡（不触发模型派发）</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!body.trim() || busy}
            onClick={() => {
              setBusy(true);
              void createFileCommentBridge(resource.id, body.trim()).then((r) => {
                setBusy(false);
                if (r.ok) { toast(`评论已保存到源会话（${originText}），锚定 v${revision.revision}——仅记录，未触发模型`, 'success'); onClose(); }
                else toast(`评论提交失败：${r.error ?? '未知错误'}（未提交）`, 'error');
              });
            }}
          >
            提交评论
          </button>
        </>
      }
    >
      <div className="panel info" style={{ marginBottom: 12 }}>
        <div className="panel-title"><Icon name="corner-down-right" size={13} /> 评论将发布到</div>
        <div className="strong" style={{ marginTop: 4 }}>{originText}</div>
        <div className="small faint" style={{ marginTop: 4, lineHeight: 1.65 }}>
          {isDm
            ? '这是私信来源的评论，只会进入该私信会话，不会出现在房间或公共成果列表。'
            : '评论归属由文件来源决定，不因为当前正在看别的任务而改变。'}
        </div>
      </div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="small faint" style={{ lineHeight: 1.65 }}>
          版本固定为 <span className="mono-sm">v{revision.revision}</span>。文件更新后本条评论仍指向这个版本，锚点不会静默漂移。
        </div>
      </div>
      <div className="field">
        <label className="field-label">评论内容</label>
        <textarea
          className="textarea"
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="例如：这里的资源解析应该走受控读取层，不要在界面拼路径。"
        />
      </div>
    </Modal>
  );
}

/* ============================================================
   收起后的重开入口（§4.5：收起保留标签）
   ============================================================ */

export function PreviewReopenButton({ compact }: { compact?: boolean } = {}) {
  const s = useStore((x) => x);
  if (!s.preview.hidden || s.preview.tabs.length === 0) return null;
  return (
    <button
      className="preview-reopen"
      onClick={showPreview}
      title={`重新打开文件预览（${s.preview.tabs.length} 个标签与阅读位置都还在）`}
      aria-label={`重新打开文件预览，共 ${s.preview.tabs.length} 个标签`}
    >
      <Icon name="panel-right" size={12} />
      {compact ? null : '文件预览'}
      <span className="faint">{s.preview.tabs.length}</span>
    </button>
  );
}

/* ============================================================
   正式格式子组件（第五十二轮 H2 起的正式渲染链——从旧 PreviewPane 原样保留：
   Text/Image/Pdf/Office；生命周期合同：代次门+Abort+dispose+Shadow DOM+净化回退）
   ============================================================ */

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    p.then((v) => { window.clearTimeout(t); resolve(v); }, (e) => { window.clearTimeout(t); reject(e); });
  });
}

/** Uint8Array → base64（分块拼接——大文件不用 String.fromCharCode 一次性展开）。 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

type Target = { attachmentId: string; filename: string; kind: string; conversationId?: string; origin?: string; draftKey?: string; hashHint?: string; revisionHint?: number | string };
type Alive = () => boolean;

function ImagePreview({ target, alive, onErr, onIdentity }: { target: Target; alive: Alive; onErr: (e: string) => void; onIdentity: (revision: number | string, hash: string) => void }) {
  const [d, setD] = useState<{ filename: string; mime: string; width: number; height: number; bytes: number; hash: string; revision: number; dataUrl: string } | null>(null);
  const [decode, setDecode] = useState<{ status: 'pending' | 'ok' | 'mismatch' | 'failed'; w?: number; h?: number }>({ status: 'pending' });
  useEffect(() => {
    let done = false;
    void command<{ filename: string; mime: string; width: number; height: number; bytes: number; hash: string; revision: number; dataUrl: string }>('attachment.previewImage', { attachmentId: target.attachmentId })
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
  const [pg, setPg] = useState<{ filename: string; totalPages: number; page: number; text: string; truncated: boolean; hash: string; revision: string | number } | null>(null);
  const [zoom, setZoom] = useState<string>('fit');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocRef = useRef<{ numPages: number; destroy(): Promise<void>; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void } }> } | null>(null);
  const bytesRef = useRef<string | null>(null);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);
  useEffect(() => {
    let done = false;
    void command<{ filename: string; totalPages: number; page: number; text: string; truncated: boolean; hash: string; revision: string | number; bytesBase64?: string }>('attachment.previewPdf', { attachmentId: target.attachmentId, page: 1, includeBytes: true })
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
  useEffect(() => () => {
    try { renderTaskRef.current?.cancel(); } catch { /* 已结束 */ }
    renderTaskRef.current = null;
    const doc = pdfDocRef.current;
    pdfDocRef.current = null;
    if (doc != null) void doc.destroy().catch(() => { /* 已销毁 */ });
  }, []);
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
        renderTaskRef.current = task;
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
    void command<{ filename: string; totalPages: number; page: number; text: string; truncated: boolean; hash: string; revision: string | number }>('attachment.previewPdf', { attachmentId: target.attachmentId, page: n })
      .then((r) => { if (alive()) { setPg(r); onContent?.(`${target.attachmentId}:${r.revision}`, r.text); } })
      .catch((e: unknown) => { if (alive()) onErr(String((e as Error).message)); });
  };
  return (
    <>
      <div className="row tight">
        <button className="btn ghost sm" disabled={pg.page <= 1} onClick={() => goPage(pg.page - 1)}>← 前页</button>
        <button className="btn ghost sm" disabled={pg.page >= pg.totalPages} onClick={() => goPage(pg.page + 1)}>后页 →</button>
        <select className="select sm" aria-label="PDF 缩放" value={zoom} onChange={(e) => setZoom(e.target.value)}>
          <option value="fit">适应宽</option><option value="1">100%</option><option value="1.5">150%</option>
        </select>
        <span className="faint small">第 {pg.page}/{pg.totalPages} 页</span>
      </div>
      <canvas ref={canvasRef} data-zs-pdf-canvas="hifi" style={{ maxWidth: '100%', border: '1px solid var(--border,#dbe2ea)', background: '#fff', display: 'block' }} />
      <pre className="panel info" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '8px 0 0' }}>{pg.text.length === 0 ? '（本页无文本层——可能是扫描件；OCR 未实现，如实空页；页面像素见上方视觉渲染）' : pg.text}</pre>
      <div className="faint small" style={{ marginTop: 6 }}>视觉渲染：浏览器 canvas（服务端零像素解码）· OCR：未实现 · 模型输入=提取文本（与视觉分列）</div>
    </>
  );
}

function OfficePreview({ target, alive, onErr, abortRef, viewerRef, onIdentity, onContent }: { target: Target; alive: Alive; onErr: (e: string) => void; abortRef: React.MutableRefObject<AbortController | null>; viewerRef: React.MutableRefObject<PptxViewer | null>; onIdentity: (revision: number | string, hash: string) => void; onContent?: (src: string, text: string) => void }) {
  const [d, setD] = useState<{
    filename: string; kind: string; hash: string; revision: number; parser?: string; sourceFormat?: string; encoding?: string;
    paragraphCount?: number; htmlTruncated?: boolean; truncatedTotal?: boolean; html?: string;
    sheets?: Array<{ name: string; rowCount: number; colCount: number; cells: string[][]; rowTruncated?: boolean; colTruncated?: boolean; merges?: unknown[]; formulaMissing?: boolean }>;
    slides?: Array<{ slide: number; text: string; notes: string; truncated?: boolean }>;
    visualBytesAvailable?: boolean; visualBytesReason?: string; bytesBase64?: string;
  } | null>(null);
  const [visualState, setVisualState] = useState<'none' | 'rendering' | 'done' | 'failed'>('none');
  const [visualErr, setVisualErr] = useState<string | null>(null);
  const shadowHostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [slidePage, setSlidePage] = useState(1);
  const [sheetIdx, setSheetIdx] = useState(0);
  useEffect(() => {
    let done = false;
    setVisualState('none'); setVisualErr(null);
    void command<NonNullable<typeof d>>('attachment.previewOffice', { attachmentId: target.attachmentId, includeBytes: true })
      .then((r) => { if (!done && alive()) { setD(r); onIdentity(r.revision, r.hash); reportContentOf(r); } })
      .catch((e: unknown) => { if (!done && alive()) onErr(String((e as Error).message)); });
    return () => { done = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.attachmentId]);
  const reportContentOf = (data: NonNullable<typeof d>): void => {
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
  useEffect(() => { if (d != null) reportContentOf(d); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sheetIdx, slidePage]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.kind, d?.bytesBase64, shadowHostRef.current != null]);
  useEffect(() => {
    if (d?.kind !== 'slides_file' || d.visualBytesAvailable !== true || d.bytesBase64 == null || stageRef.current == null) return;
    let cancelled = false;
    setVisualState('rendering');
    const ctl = new AbortController();
    abortRef.current = ctl;
    let viewer: PptxViewer | null = null;
    void (async () => {
      try {
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
        if (abortRef.current === ctl) abortRef.current = null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.kind, d?.bytesBase64, stageRef.current != null]);
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
      <div className="faint small">{kindLabel} · 解析器 {d.parser ?? '?'} · v{d.revision} · sha256={d.hash.slice(0, 12)}…</div>
      {d.kind === 'docx_file' ? (
        <>
          {d.visualBytesAvailable === true ? (
            <>
              {visualState === 'rendering' ? <div className="panel info" style={{ marginTop: 6 }}>视觉预览渲染中…</div> : null}
              {visualState === 'done' ? <div className="faint small" style={{ marginTop: 6 }}>🖼 视觉预览（docx-preview 渲染器侧本地渲染 · Shadow DOM 隔离）——与提取文本同源核验</div> : null}
              {visualState === 'failed' ? <div className="panel info" style={{ borderColor: 'var(--warning)', marginTop: 6 }}>视觉预览不可用（{visualErr ?? '未知'}）——下方净化排版近似仍可用（分列）</div> : null}
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
              <button key={sh.name} className="btn ghost sm" style={i === sheetIdx ? { fontWeight: 600 } : undefined} onClick={() => setSheetIdx(i)}>{sh.name}</button>
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
              <div className="row tight" style={{ marginTop: 8 }} data-zs-slide-controls="hifi">
                <button className="btn ghost sm" onClick={() => setSlidePage((p) => Math.max(1, p - 1))}>◀ 上一页</button>
                <button className="btn ghost sm" onClick={() => setSlidePage((p) => Math.min(viewerRef.current?.slideCount ?? 1, p + 1))}>下一页 ▶</button>
                <span className="faint small" data-zs-slide-page={slidePage} data-zs-slide-count={viewerRef.current?.slideCount ?? ''}>第 {slidePage}/{viewerRef.current?.slideCount ?? '?'} 页</span>
              </div>
              <div className="faint small" data-zs-visual-state={visualState}>🖼 视觉页预览（pptx-renderer 渲染器侧本地渲染）· v{d.revision}（与提取文本同源核验）{visualState === 'rendering' ? ' · 渲染中…' : visualState === 'none' ? ' · 启动中…' : ''}</div>
              {visualState === 'failed' ? <div className="panel info" style={{ borderColor: 'var(--warning)', marginTop: 6 }}>视觉页预览不可用（{visualErr ?? '未知'}）——提取文本卡片不受影响（分列）</div> : null}
              <div ref={stageRef} data-zs-pptx-stage="hifi" style={{ minHeight: 200, border: '1px solid var(--border,#dbe2ea)', background: '#fff', display: visualState === 'failed' ? 'none' : 'block' }} />
              {visualState !== 'failed' ? <div className="faint small" style={{ marginTop: 4 }}>视觉=渲染器侧（版面/图表/表格尽力还原——图表几何与 Office 渲染存在已知近似）· 外部关系不加载 · 宏不执行 · 提取文本=模型输入真源（与视觉分列）</div> : null}
            </>
          ) : <div className="panel info" style={{ borderColor: 'var(--warning)', marginTop: 8 }}>视觉页预览不可用（{d.visualBytesReason ?? '未取到原件字节'}）——提取文本卡片不受影响（分列）</div>}
        </>
      )}
    </>
  );
}
