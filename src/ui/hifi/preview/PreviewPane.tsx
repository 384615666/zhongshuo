import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 共享预览面板（R69 统一阅读器重做）：**壳=参考 ZCode 三层结构**（标签条→面包屑行→内容区，
 * 对照 reference-*.png 五图与 zai-org/ZCode @29628c9 PreviewPane.tsx/AnimatedSidePanePanel），
 * **正文=统一 FileStage**：所有来源（会话附件/工作区/AI 交付）经 fileSource.loadFileForResource
 * 取原字节/解码文本，按 FormatKind 分发到格式视图（PPT 缩略图+主舞台+底部条 / PDF 单页适应 /
 * Word 分页纸张 / Excel WASM 引擎 / MD 排版 / TXT 源码 / HTML 隔离页 / CSV 表格）。
 *
 * 保留的正式合同：打开不发送不执行；audience 隔离；迟到响应不覆盖（代次门）；关闭/切换
 * abort+dispose；引用=r61 引用卡直写草稿；摘录独立通道；版本/hash/快照；收起保留位置与草稿；
 * 下载原文件=原件字节（另存逐字节一致）；工作区脏检测（8s stat 轮询+重载切换）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Menu, MenuItem, Modal, PanelNavButton, Tag, anchorFromElement } from '../components/ui';
import { useStore, getState, toast } from '../data/store';
import {
  activatePreview, closeAllPreviews, closePreviewTab, openWorktreePreview,
  hidePreview, quoteResource, reloadResource, rememberScroll, showPreview,
  togglePreviewMaximized, applyWorktreeRead, markResourceUpdated, applyDeliveryRead,
  registerAttachmentResource, openPreview,
} from '../data/actions-preview';
import {
  audienceAllows, openedFromAddsInfo, originLabel,
  resourceOf, revisionLabel, revisionOf as revOf,
} from '../lib/resource';
import { formatBytes, fullTime } from '../lib/format';
import { command } from '../bridge';
import type { ContextTarget, PreviewResource, ResourceRevision } from '../data/types';
import { MarkdownView } from './MarkdownView';
import { loadFileForResource, formatKindOf, type LoadedFile } from './fileSource';
import { readerStateOf, clearReaderState } from './readerState';
import { PptxView } from './viewers/PptxView';
import { PdfView } from './viewers/PdfView';
import { DocxView } from './viewers/DocxView';
import { ImageView } from './viewers/ImageView';
import { XlsxView } from './viewers/XlsxView';
import { absoluteProjectPath, copyTextToClipboard, openLocalFileDefault, revealLocalFile } from '../lib/localOpen';

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

/** 格式图标与主题色（对照参考图：PPT=橙、PDF=红、Word=蓝、Excel=绿）。 */
function formatBadgeOf(kind: LoadedFile['kind'] | 'delivery' | 'unsupported'): { icon: string; color: string; label: string } {
  switch (kind) {
    case 'pptx': return { icon: 'presentation', color: '#d9730d', label: 'PPT' };
    case 'pdf': return { icon: 'file-text', color: '#d93025', label: 'PDF' };
    case 'docx': return { icon: 'file-text', color: '#1a73e8', label: 'Word' };
    case 'xlsx': return { icon: 'grid', color: '#188038', label: 'Excel' };
    case 'image': return { icon: 'image', color: '#7c4dff', label: '图片' };
    case 'markdown': return { icon: 'file-text', color: '#5f6368', label: 'MD' };
    case 'html': return { icon: 'code', color: '#5f6368', label: 'HTML' };
    case 'csv': return { icon: 'grid', color: '#5f6368', label: 'CSV' };
    case 'code': return { icon: 'code', color: '#5f6368', label: '代码' };
    case 'text': return { icon: 'align-left', color: '#5f6368', label: 'TXT' };
    case 'delivery': return { icon: 'package', color: '#0b8043', label: '交付' };
    default: return { icon: 'file', color: '#5f6368', label: '文件' };
  }
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

/** 从当前 hash 路由推导上下文：R69 P1-A 移入 store 层（contextTargetFromRoute）——组件内
 *  仅保留再导出以兼容旧 import（引用一处不留）。 */
export { contextTargetFromRoute as contextFromRoute } from '../data/store';

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
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [openList, setOpenList] = useState<{ x: number; y: number } | null>(null);
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);
  /** R170：标签右键菜单（打开文件夹 / 按默认程序打开 / 关闭 / 关闭其他 / 关闭全部）。 */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; key: string; resourceId: string } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  const [wrapSource, setWrapSource] = useState(false);
  /** R98：默认铺满预览面板；“限宽阅读”由用户在更多菜单显式开启。 */
  const [readingMeasure, setReadingMeasure] = useState(false);
  /** 下载原文件忙态（R66 P5——顶部声明：hooks 顺序不随后续早退分支变化）。 */
  const [dlBusy, setDlBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<{ resourceId: string; text: string } | null>(null);
  const [selection, setSelection] = useState('');
  const [tabsOverflow, setTabsOverflow] = useState(false);
  // R73-C：放大状态真正进入布局——`.preview-pane.maximized` 以绝对定位铺满当前
  // 工作内容区（.workspace/.page 为定位锚点；导航在 .main 之外仍可达）。
  const paneCls = `preview-pane${session.maximized ? ' maximized' : ''}${readingMeasure ? ' is-reading-measure' : ''}${className ? ` ${className}` : ''}`;

  /**
   * R73-C：放大态按 Esc 还原（既有约定：收起/返回类动作都可用 Esc）。弹层（Menu/Modal/
   * scrim）优先消化自己的 Esc——检测到任一弹层打开时不穿透处理（它们各自注册的 window
   * 监听会先行关闭自身；React 卸载在下一拍，这里同步查询 DOM 即可判别）。
   */
  useEffect(() => {
    if (!session.maximized) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.menu, .scrim, [role=dialog], .modal') != null) return;
      togglePreviewMaximized();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.maximized]);

  /* R69 P1-A：legacy 桥接 effect 已移除——store.openPreview(target) 在调度层同步完成
   * 登记+开标签，首个标签不再依赖"面板挂载后才出现的转换"，房间/草稿首开死锁消除。 */

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
  const messageFiles = [...Object.values(s.threadMessages).flat(), ...Object.values(s.dmHistory).flat()];
  const fileFacts = messageFiles.flatMap(message => message.fileChanges ?? []);
  const currentFile = resource ? fileFacts.find(file => file.artifactId === resource.id) : undefined;
  const newerFile = currentFile ? fileFacts.filter(file => file.projectId === currentFile.projectId
    && file.conversationId === currentFile.conversationId && file.path === currentFile.path
    && file.artifactId && file.artifactId !== currentFile.artifactId && file.afterHash !== currentFile.afterHash
    && file.createdAt >= currentFile.createdAt).sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;
  const newerMessage = newerFile ? messageFiles.find(message => message.fileChanges?.some(file => file.id === newerFile.id)) : undefined;
  const newerAttachment = newerMessage?.formalAttachments?.find(attachment => attachment.artifactId === newerFile?.artifactId);

  // 恢复阅读位置。R74-P2：挂载时内容往往还没长到位（工作区/附件正文异步装载，
  // scrollHeight 尚小）——一次性赋值会被钳到 0（r73 实测 reopen 后 scrollTop=0）。改为
  // 逐帧重试到目标可达为止（有界）；用户一动手（滚轮/按下）即停，不与用户抢滚动。
  useEffect(() => {
    const el = bodyRef.current;
    if (el == null || active == null) return;
    const target = active.scrollTop ?? 0;
    if (target <= 0) return;
    let raf = 0;
    let tries = 0;
    const stop = () => { if (raf !== 0) cancelAnimationFrame(raf); raf = 0; };
    const tick = () => {
      const e = bodyRef.current;
      // 只在目标可达时赋值：内容未长到位就赋值会被钳制，且触发的 scroll 事件会让
      // rememberScroll 把**钳制值**写回标签（等于丢位置——r74 实测反例）。
      if (e != null && e.scrollHeight - e.clientHeight >= target - 1) {
        e.scrollTop = target;
        if (Math.abs(e.scrollTop - target) <= 1) return; // 已落位
      }
      if (tries++ < 90) raf = requestAnimationFrame(tick); // ~1.5s 内内容装载完成即恢复
    };
    tick();
    el.addEventListener('wheel', stop, { once: true, passive: true });
    el.addEventListener('pointerdown', stop, { once: true, passive: true });
    return () => { stop(); el.removeEventListener('wheel', stop); el.removeEventListener('pointerdown', stop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key, revision?.content]);

  const isWorktree = resource?.formalWorktree != null;
  const isDelivery = resource?.formalDelivery != null;
  const isFormalAttachment = resource?.formalAttachment != null;
  /** 文件风味（R66 P2）：同一文件无论来自上传/工作区/正式交付都按此选渲染器。 */
  const flavor = resource != null && revision != null
    ? flavorOf(resource.title, isFormalAttachment ? resource.formalAttachment?.kind ?? '' : '', revision.content.kind)
    : null;
  const imageResource = resource != null && formatKindOf(resource.relativePath ?? resource.title, resource.formalAttachment?.kind) === 'image';
  const canChooseReading = !imageResource && (flavor === 'markdown' || flavor === 'html' || flavor === 'csv' || flavor === 'code' || flavor === 'text');
  const supportsRendered = flavor === 'markdown' || flavor === 'csv' || flavor === 'html';

  useEffect(() => {
    // 默认视图（R66 P2）：MD/HTML/CSV 默认阅读（排版/页面/表格），代码与纯文本默认源码。
    setViewMode(flavor === 'markdown' || flavor === 'html' || flavor === 'csv' ? 'preview' : 'source');
    setSelection('');
  }, [active?.key, flavor]);

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
            这份文件或其指定版本已不存在。
            <div className="panel-actions">
              <button className="btn sm" onClick={() => active && closePreviewTab(active.key)}>关闭此标签</button>
            </div>
          </div>
        </div>
      </aside>
    );
  }

  /**
   * R170：资源对应的**磁盘文件**。预览路径行（第 7 项）与标签右键菜单（第 8 项）都只认真实
   * 文件——工作区相对路径、附件来源路径、消息改动路径三者按顺序取第一个可信值；交付文档与
   * 托管正文没有磁盘文件，不伪造路径。
   */
  const projectRootOf = (projectId: string): string | undefined =>
    s.projects.find((project) => project.id === projectId)?.canonicalPath;
  const sourcePathOf = (target: PreviewResource | undefined): string | null => {
    if (target == null) return null;
    if (target.formalWorktree != null) return target.formalWorktree.path;
    if (target.relativePath != null && target.relativePath !== '') return target.relativePath;
    for (const message of messageFiles) {
      const change = message.fileChanges?.find((file) => file.artifactId === target.id);
      if (change?.path != null && change.path !== '') return change.path;
      const attachment = message.formalAttachments?.find((file) => file.artifactId === target.id);
      if (attachment?.sourcePath != null && attachment.sourcePath !== '') return attachment.sourcePath;
    }
    return null;
  };
  const absolutePathOf = (target: PreviewResource | undefined): string | null =>
    target == null ? null : absoluteProjectPath(projectRootOf(target.projectId), sourcePathOf(target));
  const absolutePath = absolutePathOf(resource);
  const displayPath = absolutePath ?? `${originLabel(s, resource)} · ${resource.relativePath ?? resource.title}`;
  const copyDisplayPath = () => {
    if (absolutePath == null) { toast('这份文件没有可显示的本机路径', 'warn'); return; }
    void copyTextToClipboard(absolutePath).then((ok) => toast(ok ? `已复制完整路径：${absolutePath}` : '复制失败：剪贴板不可用', ok ? 'success' : 'error'));
  };
  /** 引用到目标（r61 合同：引用卡直写；focus-composer）。 */
  const doQuote = (excerpt?: string) => {
    const ok = quoteResource(active.resourceId, active.revision, quoteTarget.draftKey, quoteTarget.label, excerpt);
    if (ok) window.dispatchEvent(new CustomEvent('zs:focus-composer', { detail: quoteTarget.draftKey }));
    return ok;
  };
  /** 摘录通道已按用户反馈（R170 第 6 项）从预览菜单移除。 */

  /**
   * 下载原文件/另存为（R66 P5 / R69 全来源统一）：保存**当前预览这份文件的原件字节**——
   * 附件=attachment.originalFile（sha256 核验原字节）；工作区=读取时快照字节；交付=正文
   * UTF-8 编码。落盘经主进程「另存为」对话框；保存后按服务端返回 bytes/hash 对账。
   */
  const doDownloadOriginal = async () => {
    if (dlBusy) return;
    setDlBusy(true); setDownloadError(null);
    try {
      let name = resource.title;
      let contentBase64 = '';
      let fact = '';
      if (isFormalAttachment) {
        const fa = resource.formalAttachment!;
        const r = await command<{ filename: string | null; hash: string; bytes: number; bytesBase64: string }>('attachment.originalFile', { attachmentId: fa.attachmentId, conversationId: fa.conversationId ?? '' });
        name = r.filename ?? resource.title;
        contentBase64 = r.bytesBase64;
        fact = `原件 ${r.bytes}B`;
      } else if (isWorktree) {
        const snap = worktreeSnapshots.get(`${resource.id}:${active.revision}`);
        if (snap == null) { toast('这份工作区文件的读取内容不可用（重新打开文件后再保存）', 'warn'); return; }
        if (resource.mutable && active.pendingRevision) { toast('磁盘上的文件已更新——请先点上方「重新加载」再保存（不静默另存新字节）', 'warn'); return; }
        contentBase64 = snap.bytesBase64;
        fact = `原文件 ${snap.bytes}B`;
      } else if (isDelivery) {
        const fd = resource.formalDelivery!;
        const doc = deliveryDocs.get(`${resource.id}:${active.revision}`);
        if (doc == null || doc.text == null) { toast('这份交付没有可读文档（无正文可保存）', 'warn'); return; }
        const bytes = new TextEncoder().encode(doc.text);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
        contentBase64 = btoa(bin);
        name = resource.title.endsWith('.md') ? resource.title : `${resource.title}.md`;
        fact = `交付文档 v${fd.revision} · ${doc.bytes}B${doc.hashMatch === false ? '（内容与交付记录不同，请查看文件信息）' : ''}`;
      } else {
        toast('这种来源暂不支持保存原文件（会话导出在会话头部菜单）', 'warn');
        return;
      }
      const dl = (window as unknown as { zsDownload?: { saveAs(p: { suggestedName: string; contentBase64: string }): Promise<{ ok: boolean; cancelled?: boolean; path?: string; bytes?: number }> } }).zsDownload;
      if (dl != null) {
        const r = await dl.saveAs({ suggestedName: name, contentBase64 });
        if (r.cancelled === true) { toast('已取消另存为', 'info'); return; }
        if (!r.ok || r.path == null) { setDownloadError({ resourceId: resource.id, text: '另存为失败（主进程拒绝）；原件保留，可重试' }); return; }
        toast(`已保存原文件：${r.path}（${fact}）`, 'success');
      } else {
        const a = document.createElement('a');
        a.href = `data:application/octet-stream;base64,${contentBase64}`;
        a.download = name;
        a.click();
        toast(`已触发浏览器下载「${name}」（${fact}）`, 'success');
      }
    } catch (e: unknown) {
      setDownloadError({ resourceId: resource.id, text: `保存原文件失败：${userFacingSystemText((e as Error).message ?? '')}。原件保留，可重试。` });
    } finally {
      setDlBusy(false);
    }
  };

  return (
    <aside className={paneCls} style={flexStyle} aria-label="文件预览" data-zs-reading-measure={readingMeasure ? '1' : '0'}>
      {/* ---------- 第一行：文件标签（参考 ZCode：格式图标+截断名+×，右端更多/放大/收起） ---------- */}
      <div className="preview-tabs" role="tablist" aria-label="已打开的文件">
        <div className="preview-tab-strip" ref={tabStripRef}>
          {tabs.map((t) => {
            const r = resourceOf(s, t.resourceId);
            const on = t.key === active.key;
            const shown = tabNames.get(t.key) ?? r?.title ?? '未知文件';
            const ver = r ? revisionLabel(r, t.revision) : '';
            const badge = r != null
              ? formatBadgeOf(
                  r.formalDelivery != null ? 'delivery'
                    : r.formalWorktree != null ? kindOfTitle(r)
                    : r.formalAttachment != null ? attachmentKindToFormat(r.formalAttachment.kind, r.title)
                    : 'unsupported',
                )
              : formatBadgeOf('unsupported');
            const tabPath = absolutePathOf(r);
            return (
              <span key={t.key} className={`preview-tab${on ? ' on' : ''}`}>
                <button
                  role="tab"
                  aria-selected={on}
                  className="preview-tab-label"
                  onClick={() => activatePreview(t.key)}
                  onAuxClick={(e) => { if (e.button === 1) { dropLoadedCache(t.resourceId); clearReaderState(t.resourceId); closePreviewTab(t.key); } }}
                  onContextMenu={(e) => {
                    // R170 第 8 项：右键标签打开文件操作菜单（打开文件夹 / 默认程序打开 / 关闭…）。
                    e.preventDefault();
                    setTabMenu({ x: e.clientX, y: e.clientY, key: t.key, resourceId: t.resourceId });
                  }}
                  title={`${tabPath ?? r?.relativePath ?? r?.title ?? t.key}${ver ? ` · ${ver}` : ''}`}
                >
                  <span className="preview-tab-icon" style={{ color: badge.color }}><Icon name={badge.icon} size={11} /></span>
                  <span className="truncate">{shown}</span>
                  {ver ? <span className="faint mono-sm">{ver}</span> : null}
                </button>
                <button
                  className="preview-tab-close"
                  aria-label={`关闭 ${shown}${ver ? ` ${ver}` : ''}`}
                  title="关闭这个文件（不影响其他标签）"
                  onClick={() => { dropLoadedCache(t.resourceId); clearReaderState(t.resourceId); closePreviewTab(t.key); }}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            );
          })}
        </div>
        <span className="preview-tabs-actions">
          {singleRegion && onBackToContext ? (
            <button className="preview-icon-btn" title="返回对话（预览标签与阅读位置保留）" aria-label="返回对话" onClick={onBackToContext}>
              <Icon name="arrow-left" size={13} />
            </button>
          ) : null}
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
          <button
            className="preview-icon-btn"
            aria-label="更多文件操作"
            title="更多：引用/文件信息/下载/阅读宽度/关闭"
            aria-haspopup="menu"
            data-preview-action="more"
            onClick={(e) => setMoreAt(anchorFromElement(e.currentTarget))}
          >
            <Icon name="more-horizontal" size={13} />
          </button>
          {session.maximized ? (
            <button
              className="preview-icon-btn"
              title="还原预览大小（回到与对话并排）"
              aria-label="还原预览大小"
              aria-pressed
              data-preview-action="restore"
              onClick={togglePreviewMaximized}
            >
              <Icon name="copy" size={13} />
            </button>
          ) : (
            <button
              className="preview-icon-btn"
              title="放大预览（临时占满内容区，便于细读）"
              aria-label="放大预览"
              data-preview-action="maximize"
              onClick={togglePreviewMaximized}
            >
              <Icon name="maximize" size={13} />
            </button>
          )}
          <button
            className="preview-icon-btn"
            title="收起预览区（保留全部标签与阅读位置）"
            aria-label="收起预览区"
            data-preview-action="collapse"
            onClick={hidePreview}
          >
            <Icon name="panel-right" size={13} />
          </button>
        </span>
      </div>

      {/* ---------- 第二行：路径面包屑 + 常用动作（对照参考：路径段+右侧动作） ---------- */}
      <div className="preview-crumb">
        <Icon name="link" size={11} className="faint" />
        {/* R170 第 7 项：这里显示**本机绝对路径**（用户在文件页/对话里看到的真实位置），
            不再拼「默认房间 › 串内消息」这类来源描述。没有磁盘文件时退回原说明。 */}
        <span className="preview-crumb-path truncate" title={displayPath} data-zs-preview-path={absolutePath ?? ''}>
          <span className={`mono-sm${absolutePath == null ? ' faint' : ''}`}>{displayPath}</span>
        </span>
        {absolutePath != null ? (
          <button
            className="preview-icon-btn"
            aria-label="复制完整路径"
            title="复制完整路径"
            data-preview-action="copy-path"
            onClick={copyDisplayPath}
          >
            <Icon name="copy" size={12} />
          </button>
        ) : null}
        <span className="spacer" />
        <Tag plain title={isWorktree ? '项目工作区文件（只读）' : isDelivery ? 'AI 交付文档' : '会话附件或成果'}>
          {isWorktree ? '工作区只读' : isDelivery ? 'AI 交付文档' : '会话资源'}
        </Tag>
        {canChooseReading ? (
          <button
            className="btn ghost sm preview-read"
            title={`切换阅读方式（当前：${viewMode === 'source' ? '源码' : '阅读'}）`}
            onClick={() => setViewMode((v) => (v === 'source' ? 'preview' : 'source'))}
          >
            <Icon name={viewMode === 'source' ? 'align-left' : 'eye'} size={11} />
            {viewMode === 'source' ? '源码' : '阅读'}
          </button>
        ) : null}
        <button
          className="preview-icon-btn"
          aria-label="下载原文件"
          title="保存当前这份文件的原件；可选择保存位置"
          disabled={dlBusy}
          onClick={() => void doDownloadOriginal()}
        >
          <Icon name="download" size={13} />
        </button>
      </div>

      {newerFile && newerAttachment ? <button type="button" className="tag-btn warning preview-dirty-banner" data-zs-new-file-version={newerAttachment.artifactId}
        onClick={() => {
          registerAttachmentResource({attachmentId: newerAttachment.artifactId, filename: newerAttachment.filename, kind: newerAttachment.kind,
            revision: newerAttachment.revision, hash: newerAttachment.hash, audience: context, origin: newerFile.conversationId});
          openPreview(newerAttachment.artifactId, newerAttachment.revision, {target: context, messageId: newerMessage?.id});
        }}>有更新版本{newerAttachment.revision != null ? ` v${newerAttachment.revision}` : ''} · 打开新版</button> : null}
      {resource.mutable && active.pendingRevision ? (
        <button
          className="tag-btn warning preview-dirty-banner"
          title="磁盘上的文件已更新。重新加载会显示最新内容；已插入草稿的引用仍指向原版本"
          onClick={() => { reloadResource(active.pendingRevision!, active.key); }}
        >
          <Icon name="alert-triangle" size={10} /> 磁盘已更新 · 重新加载
        </button>
      ) : null}

      {downloadError?.resourceId === resource.id ? <div className="small" role="alert" style={{ padding: '6px 12px', color: 'var(--warning)' }}>{downloadError.text}</div> : null}
      {/* ---------- 正文：统一 FileStage（所有来源同一阅读链） ---------- */}
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
        <FileStage
          key={`${resource.id}:${active.revision}`}
          resource={resource}
          revision={revision}
          context={context}
          viewMode={viewMode}
          wrapSource={wrapSource}
          onDownload={() => void doDownloadOriginal()}
        />
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
      {tabMenu ? (() => {
        const target = tabs.find((t) => t.key === tabMenu.key);
        const targetResource = target == null ? undefined : resourceOf(s, target.resourceId);
        const targetPath = absolutePathOf(targetResource);
        const closeTab = (key: string, resourceId: string) => { dropLoadedCache(resourceId); clearReaderState(resourceId); closePreviewTab(key); };
        return (
          <Menu anchor={{ x: tabMenu.x, y: tabMenu.y }} onClose={() => setTabMenu(null)}>
            <div className="menu-label">{targetResource?.title ?? '文件操作'}</div>
            {targetPath != null ? (
              <>
                <MenuItem icon="folder" title="在系统文件管理器中选中这个文件" onClick={() => { setTabMenu(null); void revealLocalFile(targetPath).then((r) => { if (!r.ok) toast(`打开文件夹失败：${userFacingSystemText(r.error ?? '')}`, 'error'); }); }}>打开文件夹</MenuItem>
                <MenuItem icon="external-link" title="用系统默认程序打开这个文件（不会改动内容）" onClick={() => { setTabMenu(null); void openLocalFileDefault(targetPath).then((r) => { if (!r.ok) toast(`打开失败：${userFacingSystemText(r.error ?? '')}`, 'error'); }); }}>按默认程序打开</MenuItem>
                <div style={{ height: 1, margin: '4px 6px', background: 'var(--border-subtle)' }} />
              </>
            ) : null}
            <MenuItem icon="x" title="只关闭这个标签，其他标签不受影响" onClick={() => { setTabMenu(null); closeTab(tabMenu.key, tabMenu.resourceId); }}>关闭</MenuItem>
            <MenuItem icon="x" title="关闭除这个文件以外的其他标签" disabled={tabs.length <= 1} onClick={() => {
              setTabMenu(null);
              for (const t of tabs) if (t.key !== tabMenu.key) closeTab(t.key, t.resourceId);
              activatePreview(tabMenu.key);
            }}>关闭其他</MenuItem>
            <MenuItem icon="panel-right" title="清空全部标签、退出预览；不会删除磁盘文件" onClick={() => { setTabMenu(null); for (const t of tabs) closeTab(t.key, t.resourceId); closeAllPreviews(); }}>关闭全部</MenuItem>
          </Menu>
        );
      })() : null}

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
          <MenuItem icon="x" onClick={() => { for (const t of tabs) { dropLoadedCache(t.resourceId); clearReaderState(t.resourceId); } closeAllPreviews(); setOpenList(null); }}>关闭所有文件</MenuItem>
        </Menu>
      ) : null}

      {moreAt ? (
        <Menu anchor={moreAt} onClose={() => setMoreAt(null)}>
          <div className="menu-label">{resource.title}</div>
          <MenuItem icon="corner-down-right" title={`把这份文件的固定版本插入「${quoteTarget.label}」草稿；需你再次点击发送才会进入对话`} onClick={() => { doQuote(); setMoreAt(null); }}>
            引用到 {quoteTarget.label}
          </MenuItem>
          <MenuItem icon="info" title="完整路径、版本、大小、来源与可见范围" onClick={() => { setInfoOpen(true); setMoreAt(null); }}>文件信息</MenuItem>
          <MenuItem
            icon="download"
            title="保存当前这份文件的原件；可选择保存位置"
            disabled={dlBusy}
            onClick={() => { void doDownloadOriginal(); setMoreAt(null); }}
          >
            {dlBusy ? '正在取原件…' : '下载原文件 / 另存为…'}
          </MenuItem>
          {supportsRendered && viewMode === 'preview' ? (
            <MenuItem
              icon="align-left"
              title="文档默认为面板满宽；开启后仅将阅读正文收束到约 82 字符，表格与代码仍可横向滚动"
              hint={readingMeasure ? '当前：限宽' : '当前：铺满'}
              onClick={() => { setReadingMeasure((v) => !v); setMoreAt(null); }}
            >
              {readingMeasure ? '铺满阅读' : '限宽阅读'}
            </MenuItem>
          ) : null}
          {canChooseReading ? (
            <MenuItem icon="align-left" title="长行是否折行显示（只影响源码/纯文本视图）" hint={wrapSource ? '当前：换行' : '当前：不换行'} onClick={() => { setWrapSource((v) => !v); setMoreAt(null); }}>
              {wrapSource ? '取消自动换行' : '自动换行'}
            </MenuItem>
          ) : null}
          {singleRegion ? (
            <MenuItem icon="chevron-right" title="保留全部标签与阅读位置，稍后可重开（不会关闭文件）" onClick={() => { hidePreview(); setMoreAt(null); }}>收起预览</MenuItem>
          ) : null}
          <MenuItem icon="x" title="只关闭当前这个标签，其他标签不受影响" onClick={() => { dropLoadedCache(active.resourceId); clearReaderState(active.resourceId); closePreviewTab(active.key); setMoreAt(null); }}>关闭此文件</MenuItem>
          <MenuItem icon="panel-right" title="清空全部标签、退出预览；不会删除磁盘文件" onClick={() => { for (const t of tabs) { dropLoadedCache(t.resourceId); clearReaderState(t.resourceId); } closeAllPreviews(); setMoreAt(null); }}>关闭所有文件</MenuItem>
        </Menu>
      ) : null}

      {infoOpen && resource != null && revision != null ? (
        <Modal onClose={() => setInfoOpen(false)} size="md" title="文件信息">
          <FileInfoBody resource={resource} revision={revision} />
        </Modal>
      ) : null}
    </aside>
  );
}

/** 标签图标用：资源→格式（工作区按文件名，附件按 kind；工作区装载后按真实 kind 校正）。 */
function kindOfTitle(r: PreviewResource): LoadedFile['kind'] {
  return worktreeKindCache.get(r.id) ?? formatKindOf(r.title);
}
const worktreeKindCache = new Map<string, LoadedFile['kind']>();
function attachmentKindToFormat(kind: string, title: string): LoadedFile['kind'] | 'delivery' | 'unsupported' {
  switch (kind) {
    case 'slides_file': return 'pptx';
    case 'docx_file': return 'docx';
    case 'sheet_file': return /\.(csv|tsv)$/i.test(title) ? 'csv' : 'xlsx';
    case 'pdf_file': return 'pdf';
    case 'image_file': return 'image';
    case 'code_file': return 'code';
    case 'text_file': return /\.(md|markdown)$/i.test(title) ? 'markdown' : /\.(html?)$/i.test(title) ? 'html' : 'text';
    default: return 'unsupported';
  }
}

const scrollTimer = { current: 0 as number | undefined };

/* ============================================================
   工作区快照（R67 P1-A）
   ============================================================ */

const worktreeSnapshots = new Map<string, { bytesBase64: string; sha256: string; bytes: number; mtimeMs: number }>();

/* ============================================================
   文件风味（文本类阅读方式推导——R66 P2 口径保留）
   ============================================================ */

type FileFlavor = 'markdown' | 'html' | 'csv' | 'code' | 'text' | 'binary';

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rs', '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lua', '.r', '.m', '.pl']);

function flavorOf(filename: string, formalKind: string, contentKind: string | undefined): FileFlavor {
  if (contentKind === 'markdown') return 'markdown';
  if (contentKind === 'csv') return 'csv';
  if (contentKind === 'code') return 'code';
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

/* ============================================================
   统一正文：FileStage（R69——所有来源同一装载链+格式分发）
   ============================================================ */

/** 装载缓存（R70 F3/F4）：键=资源:版本 → LoadedFile（含稳定 bytes 引用）。切标签回来自
 * 缓存瞬时恢复（字节身份不变=引擎不重开）；脏重载 bump 版本=新键新快照。上限 12 条
 * 逐出最旧（bytes 持有大文件的内存有界）。 */
const loadedCache = new Map<string, LoadedFile>();
function cachedLoad(key: string, load: () => Promise<LoadedFile>): Promise<LoadedFile> {
  const hit = loadedCache.get(key);
  if (hit != null) return Promise.resolve(hit);
  return load().then((r) => {
    if (loadedCache.size >= 12) loadedCache.delete(loadedCache.keys().next().value as string);
    loadedCache.set(key, r);
    return r;
  });
}
function dropLoadedCache(resourceId: string): void {
  for (const k of [...loadedCache.keys()]) {
    if (k.startsWith(`${resourceId}:`)) loadedCache.delete(k);
  }
}

function FileStage({ resource, revision, context, viewMode, wrapSource, onDownload }: {
  resource: PreviewResource; revision: ResourceRevision;
  context: ContextTarget;
  viewMode: 'preview' | 'source'; wrapSource: boolean;
  onDownload: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [nonce, setNonce] = useState(0);
  const genRef = useRef(0);
  const stateKey = `${resource.id}:${revision.revision}`;

  useEffect(() => {
    const gen = ++genRef.current;
    let done = false;
    setErr(null); setLoaded(null);
    void cachedLoad(`${stateKey}${nonce > 0 ? `:r${nonce}` : ''}`, () => loadFileForResource(resource, revision.revision))
      .then((r) => {
        if (done || gen !== genRef.current) return;
        setLoaded(r);
        // 工作区读取快照回填（另存原件/脏检测的快照对账源——R67 P1-A 合同在统一装载链保持）。
        if (resource.formalWorktree != null && r.bytes != null) {
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < r.bytes.length; i += CH) bin += String.fromCharCode(...r.bytes.subarray(i, i + CH));
          worktreeSnapshots.set(`${resource.id}:${revision.revision}`, { bytesBase64: btoa(bin), sha256: r.hash, bytes: r.originalBytes, mtimeMs: r.mtimeMs ?? 0 });
          worktreeKindCache.set(resource.id, r.kind);
        }
        // R70 F8：读取事实回填 store（hash/大小不再停留占位值；文本类带解码内容供引用/摘录）。
        if (resource.formalWorktree != null) {
          applyWorktreeRead(resource.id, {
            ...(r.kind === 'text' || r.kind === 'code' || r.kind === 'markdown' || r.kind === 'html' || r.kind === 'csv'
              ? { text: r.text ?? '' }
              : { binaryKind: r.kind }),
            hash: r.hash,
            sizeBytes: r.originalBytes,
            revision: revision.revision,
          });
        }
      })
      .catch((e: unknown) => { if (!done && gen === genRef.current) setErr(String((e as Error).message)); });
    return () => { done = true; genRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id, revision.revision, nonce]);

  /** R70 F3：字节身份稳定——同一 loaded 快照只派生一次 ArrayBuffer/Uint8Array（render 期
   * 重建会让 react-xlsx/pptx 引擎把同一文件当新输入重开，切表/页码被重置——独立复核反例）。
   * 各视图内部再按需 slice 也是基于这个稳定引用。 */
  const stableBytes = useMemo(() => loaded?.bytes ?? null, [loaded]);
  const stableArrayBuffer = useMemo(() => {
    if (stableBytes == null) return null;
    return stableBytes.buffer.slice(stableBytes.byteOffset, stableBytes.byteOffset + stableBytes.byteLength) as ArrayBuffer;
  }, [stableBytes]);
  const stablePdfBytes = stableBytes;

  // 工作区脏检测（R68 §6：8s stat 轮询——mtime/bytes 不一致提示而不替换）。
  useEffect(() => {
    const wt = resource.formalWorktree;
    if (wt == null) return;
    const timer = window.setInterval(() => {
      void command<{ mtimeMs: number; bytes: number }>('project.file.stat', { projectId: wt.projectId, path: wt.path })
        .then((st) => {
          const snap = worktreeSnapshots.get(`${resource.id}:${revision.revision}`);
          if (snap == null) return;
          if (st.mtimeMs !== snap.mtimeMs || st.bytes !== snap.bytes) markResourceUpdated(resource.id);
        })
        .catch(() => { /* stat 失败（文件被删等）：读取失败路径由打开/重载呈现 */ });
    }, 8000);
    return () => { window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id, revision.revision]);

  if (err != null) {
    return (
      <div className="preview-unsupported" data-zs-preview-error={err.slice(0, 40)}>
        <Icon name="alert-triangle" size={20} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>这份文件当前不能预览</div>
        <div className="small muted" style={{ marginTop: 6, maxWidth: 460, lineHeight: 1.7 }}>{userFacingSystemText(err ?? '')}</div>
        <div className="panel-actions">
          <button className="btn sm" onClick={() => setNonce((n) => n + 1)}>重试</button>
        </div>
      </div>
    );
  }
  if (loaded == null) return <div className="panel info" data-zs-file-loading="1">正在读取文件（只读）…</div>;

  const revLabel = revisionLabel(resource, revision.revision);
  const dl = onDownload;

  // ---------- 格式分发（R70：字节=稳定引用；阅读状态=按资源+版本恢复/保存） ----------
  const readerProps = {
    resourceId: resource.id,
    revision: revision.revision,
    initialState: readerStateOf(resource.id, revision.revision),
  };
  if (loaded.kind === 'pptx') {
    if (stableArrayBuffer == null) return <BytesUnavailableView reason={loaded.extractionError ?? '未取到原件字节'} onDownload={dl} revLabel={revLabel} />;
    return <PptxView bytes={stableArrayBuffer} filename={loaded.filename} revisionLabel={revLabel} onDownload={dl} {...readerProps} />;
  }
  if (loaded.kind === 'pdf') {
    if (stablePdfBytes == null) return <BytesUnavailableView reason="未取到原件字节" onDownload={dl} revLabel={revLabel} />;
    return <PdfView bytes={stablePdfBytes} filename={loaded.filename} revisionLabel={revLabel} onDownload={dl} {...readerProps} />;
  }
  if (loaded.kind === 'docx') {
    if (stableBytes == null) return <BytesUnavailableView reason={loaded.extractionError ?? '未取到原件字节'} onDownload={dl} revLabel={revLabel} />;
    return <DocxView bytes={stableBytes} filename={loaded.filename} revisionLabel={revLabel} onDownload={dl} {...readerProps} />;
  }
  if (loaded.kind === 'xlsx') {
    if (stableArrayBuffer == null) {
      return <BytesUnavailableView reason={loaded.extractionError ?? '未取到原件字节'} onDownload={dl} revLabel={revLabel} />;
    }
    return (
      <XlsxView
        bytes={stableArrayBuffer}
        filename={loaded.filename}
        revisionLabel={revLabel}
        onDownload={dl}
        fallbackSheets={loaded.office?.sheets ?? []}
        fallbackNote={loaded.extraction === 'failed' ? '文件内容解析失败，暂时无法把内容发送给 AI' : undefined}
        {...readerProps}
      />
    );
  }
  if (loaded.kind === 'image' && loaded.image != null) {
    return <ImageView key={`${stateKey}:${nonce}`} resourceId={resource.id} revision={revision.revision}
      dataUrl={loaded.image.dataUrl} filename={loaded.filename}
      onRetry={() => setNonce((n) => n + 1)} onDownload={dl} />;
  }

  // ---------- 文本类（text/code/markdown/html/csv；交付报告走 delivery 视图） ----------
  const text = loaded.text ?? '';
  if (resource.formalDelivery != null) {
    return <DeliveryDocView resource={resource} revision={revision} rawText={text} delivery={loaded.delivery} viewMode={viewMode} wrapSource={wrapSource} onOpenWorktreeFile={(path, bytes) => openWorktreeFileFromDelivery(resource.projectId, path, bytes, context)} />;
  }
  if (loaded.originalBytes === 0 && text.length === 0) {
    return (
      <div className="preview-empty" data-zs-empty-file="1">
        <Icon name="file-text" size={22} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>空文件（0 字节）</div>
        <div className="small faint" style={{ marginTop: 4, maxWidth: 420, lineHeight: 1.7 }}>
          这份文件没有任何内容（0B）——已按原件保存，可另存 0 字节副本。{loaded.encoding ? `编码检测：${loaded.encoding}。` : ''}
          发送给 AI 不会带上任何可用文本（输入区会提示可行操作）。
        </div>
        <div className="panel-actions">
          <button className="btn sm" onClick={dl}><Icon name="download" size={12} /> 另存 0 字节原件</button>
        </div>
      </div>
    );
  }
  const flavor = flavorByExt(resource.relativePath ?? resource.title, resource.formalAttachment?.kind ?? '');
  if (flavor === 'markdown' && viewMode === 'preview') {
    return <div className="preview-read-doc"><MarkdownView text={text} /></div>;
  }
  if (flavor === 'html' && viewMode === 'preview') {
    return <HtmlPageView html={text} filename={resource.title} />;
  }
  if (flavor === 'csv' && viewMode === 'preview') {
    return <CsvView text={text} />;
  }
  return <SourceView text={text} language={flavor === 'code' ? 'code' : 'text'} wrap={wrapSource} />;
}

function BytesUnavailableView({ reason, onDownload, revLabel }: { reason: string; onDownload: () => void; revLabel: string }): React.ReactElement {
  return (
    <div className="preview-unsupported" data-zs-bytes-unavailable={reason.slice(0, 40)}>
      <Icon name="alert-triangle" size={20} className="faint" />
      <div className="strong" style={{ marginTop: 8 }}>无法读取原件</div>
      <div className="small muted" style={{ marginTop: 6, maxWidth: 440, lineHeight: 1.7 }}>{reason}——这份文件（{revLabel}）已保存，可下载原件；提取文字见「文件信息」。</div>
      <div className="panel-actions"><button className="btn sm" onClick={onDownload}><Icon name="download" size={12} /> 下载原文件</button></div>
    </div>
  );
}

/* ============================================================
   HTML 隔离页面预览（R66 P2 口径保留）
   ============================================================ */

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
        脚本已禁用、外部资源不加载；链接与交互暂不支持——切「源码」可查看原文。
      </div>
    </div>
  );
}

/* ============================================================
   源码/表格视图（保留）
   ============================================================ */

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
   交付文档视图（R68 §6 第三来源：结构化交付报告——保留）
   ============================================================ */

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

/** 交付文档装载缓存（resourceId:revision → 文档）——下载原文件用同一份文本，不二次请求。 */
const deliveryDocs = new Map<string, { text: string | null; hashMatch: boolean | null; bytes: number }>();

function DeliveryDocView({ resource, revision, rawText, delivery, viewMode, wrapSource, onOpenWorktreeFile }: {
  resource: PreviewResource; revision: ResourceRevision; rawText: string;
  delivery?: { hashMatch: boolean | null; bytes: number };
  viewMode: 'preview' | 'source'; wrapSource: boolean;
  onOpenWorktreeFile: (path: string, bytes: number) => void;
}) {
  const fd = resource.formalDelivery!;
  const realBytes = delivery?.bytes ?? rawText.length; // R70 F8：回执真实字节数优先（不丢、不用长度冒充）
  const hashMatch = delivery?.hashMatch ?? null;
  // 装载缓存：FileStage 已取 delivery.document 正文——这里登记供「下载原文件」复用（真实事实）。
  useEffect(() => {
    deliveryDocs.set(`${resource.id}:${revision.revision}`, { text: rawText, hashMatch, bytes: realBytes });
    if (rawText.length > 0) applyDeliveryRead(resource.id, { text: rawText, bytes: realBytes, revision: revision.revision });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id, revision.revision, rawText, realBytes, hashMatch]);
  if (rawText.length === 0) {
    return (
      <div className="preview-unsupported">
        <Icon name="file-text" size={20} className="faint" />
        <div className="strong" style={{ marginTop: 8 }}>这份交付没有可读文档</div>
        <div className="small muted" style={{ marginTop: 6, maxWidth: 440, lineHeight: 1.7 }}>
          这份交付没有可读文档（v{fd.revision}）；验收与引用仍可在「详情」中使用。
        </div>
      </div>
    );
  }
  let tc: TaskCompleteDoc | null = null;
  try {
    const parsed = JSON.parse(rawText) as Partial<TaskCompleteDoc>;
    if (parsed != null && typeof parsed === 'object' && typeof parsed.schemaVersion === 'string' && parsed.schemaVersion.startsWith('task-complete')) tc = parsed as TaskCompleteDoc;
  } catch { tc = null; }
  if (viewMode === 'preview' && tc != null) {
    return (
      <div className="preview-read-doc" data-zs-delivery-doc="1">
        <MarkdownView text={tc.changeSummary ?? '（未提供说明）'} />
        {tc.files != null && tc.files.length > 0 ? (
          <div className="small" style={{ marginTop: 10 }} data-zs-delivery-files="1"><strong>涉及文件（点击打开）</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.files.map((f, i) => (
            <li key={i} className="mono-sm">
              {f}
              <button className="btn ghost sm" style={{ marginLeft: 6 }} data-zs-delivery-file={f} title="以项目文件打开（只读）" onClick={() => onOpenWorktreeFile(f, 0)}>打开文件</button>
            </li>
          ))}</ul></div>
        ) : null}
        {tc.executedVerifications != null && tc.executedVerifications.length > 0 ? (
          <div className="small" style={{ marginTop: 8 }}><strong>已执行验证</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.executedVerifications.map((v, i) => <li key={i}>{v}</li>)}</ul></div>
        ) : null}
        {tc.unexecutedVerifications != null && tc.unexecutedVerifications.length > 0 ? (
          <div className="small" style={{ marginTop: 8 }}><strong>未执行验证</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.unexecutedVerifications.map((v, i) => <li key={i}>{v.item ?? ''}{v.reason != null ? `——${userFacingSystemText(v.reason ?? '')}` : ''}</li>)}</ul></div>
        ) : null}
        {tc.remainingIssues != null && tc.remainingIssues.length > 0 ? (
          <div className="small" style={{ marginTop: 8 }}><strong>遗留问题</strong><ul style={{ marginTop: 4, paddingLeft: 18, listStyle: 'disc' }}>{tc.remainingIssues.map((v, i) => <li key={i}>{v}</li>)}</ul></div>
        ) : null}
        <div className="small faint" style={{ marginTop: 10, borderTop: '1px solid var(--border,#dbe2ea)', paddingTop: 8 }}>
          交付文档 v{fd.revision}；「源码」可查看原始内容。
        </div>
      </div>
    );
  }
  return <SourceView text={rawText} language="json" wrap={wrapSource} />;
}


/** R70 F7：从交付报告打开 AI 实际产出的文件（工作区资源——同一阅读器；不冒充交付快照）。 */
/**
 * 交付文档内「打开文件」：按**当前预览上下文**作为 openedFrom（R74-A 语义——对话内
 * 主动打开=显式，不被自动收起折叠）。此前硬编码 files 来源：R74 上线自动收起后，
 * 线程里点交付文件会**即刻被折叠**（r72 门 G1 成果文件视图超时暴露——files 来源+
 * explicitShow=false 命中自动收起判据）。
 */
function openWorktreeFileFromDelivery(projectId: string, path: string, sizeBytes: number, openedFrom: ContextTarget): void {
  openWorktreePreview(projectId,path,sizeBytes,{target:openedFrom});
}

/* ============================================================
   文件信息（工程字段/提取/模型窗——收进对话框，不占阅读主体）
   ============================================================ */

function FileInfoBody({ resource, revision }: { resource: PreviewResource; revision: ResourceRevision }) {
  const s = useStore((x) => x);
  const url = resource.relativePath ?? resource.title;
  return (
    <dl className="kv">
      <dt>文件名</dt><dd>{resource.title}</dd>
      <dt>完整路径</dt><dd className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{url}</dd>
      <dt>版本</dt>
      <dd>
        {revisionLabel(resource, revision.revision)}
        <span className="faint"> · {resource.mutable ? '随磁盘更新，需手动重新加载' : '固定版本'}</span>
      </dd>
      <dt>大小</dt><dd>{formatBytes(revision.sizeBytes)}</dd>
      <dt>类型</dt><dd className="mono-sm">{resource.formalAttachment ? KIND_LABEL[resource.formalAttachment.kind] ?? resource.formalAttachment.kind : resource.mimeType}</dd>
      <dt>版本时间</dt><dd>{fullTime(revision.createdAt)}</dd>
      <dt>来源</dt><dd>{originLabel(s, resource)}</dd>
      <dt>可见范围</dt>
      <dd>
        {resource.audience.kind === 'room' ? '本房间成员' : resource.audience.kind === 'dm' ? '仅这条私信的参与者' : '项目成员'}
      </dd>
    </dl>
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
