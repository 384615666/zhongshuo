/**
 * 共享预览面板（UX-PREVIEW-01 / §17.9）。
 *
 * 这是**唯一的预览容器**。所有入口（主池消息、线程成果、房间文件、
 * 项目文件树、DM、搜索）都复用本组件，不各建预览壳（施工说明 §6）。
 *
 * 三段结构对应 §4.4 的"标签行 + 文件工具行 + 正文"：
 *   1. 标签行：只处理文件标签及整个预览区域（关闭/收起/放大/已打开）
 *   2. 工具行：只处理**当前文件**（路径、版本、视图切换、引用、更多）
 *   3. 正文：按内容 kind 分发渲染器
 *
 * 必须如实的地方：
 *  · 未接通的格式（PDF/Office/视频）显示 unsupported，不给伪正文页（§8.1）；
 *  · 内容来源标注"模拟资源"，不宣称真实磁盘解析通过（施工说明 §3）；
 *  · 打开文件不发送、不验收、不执行脚本（§17.9 第 5 条）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Menu, MenuItem, Modal, PanelNavButton, Tag, anchorFromElement } from './ui';
import { useStore } from '../data/store';
import {
  activatePreview, closeAllPreviews, closePreviewTab, contextTargetOf, createFileComment,
  hidePreview, quoteResource, reloadResource, rememberScroll, showPreview,
  togglePreviewMaximized,
} from '../data/actions-preview';
import {
  audienceAllows, openedFromAddsInfo, openedFromLabel, originLabel,
  resourceOf, revisionLabel, revisionOf as revOf,
} from '../lib/resource';
import { formatBytes, fullTime } from '../lib/format';
import type { PreviewResource, ResourceRevision } from '../data/types';
import { MarkdownView } from './preview/MarkdownView';
import { DiffText } from './preview/DiffText';

/**
 * 同名标签的**最短可区分父路径**（减负 §5）。
 *
 * 文件名只显示一次（以标签为主），所以同名文件必须能在标签上区分开：
 * 逐级向前加父目录，直到彼此不同；加到底仍相同就不再重复展示。
 * 完整路径始终可以在文件「⋯ → 文件信息」里看到，不靠标签承担路径展示。
 */
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
    if (!dup) {
      out.set(p.key, p.name);
      continue;
    }
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
      if (distinct) {
        out.set(p.key, candidate);
        break;
      }
    }
    out.set(p.key, out.get(p.key) ?? p.name);
  }
  return out;
}

/**
 * 预览区左端的「收起 / 返回」——与回复串的收起**同一个组件、同一侧**。
 *
 * 两种布局下是**两个不同的动作**，所以文案与可访问名称必须分开：
 *  · 单区域：占满内容区的文件页 → 左端是「对话」（回到对话区，预览标签保留）；
 *  · L3/L4 并排：预览是一列 → 左端是「收起预览」（隐藏这一列，保留标签与阅读位置，
 *    稍后可从重开入口恢复）。
 * 单区域下「收起预览」仍在文件 ⋯ 菜单里可达，避免左端出现两个都像"返回"的控件。
 */
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

export interface PreviewPaneProps {  /** 当前上下文（决定 audience 可见性与引用目标） */
  context: ReturnType<typeof contextTargetOf>;
  /** 引用默认目标草稿 key 与展示名（§7.2） */
  quoteTarget: { draftKey: string; label: string };
  /** 单区域模式：与对话二选一显示 */
  singleRegion?: boolean;
  /** 返回对话（单区域模式） */
  onBackToContext?: () => void;
  /** 打开标签列表时用（键盘可达） */
  className?: string;
  /**
   * 没有可见标签时是否仍渲染空态。
   *
   * DM 页默认不渲染：那里预览是按需出现的第三列，常驻一块"还没有打开文件"
   * 会白占宽度。房间页也不渲染（由调用方用 hasPreview 控制）。
   * 只有显式需要"预览入口常驻"的场景才设 true。
   */
  showEmpty?: boolean;
  /**
   * 两区并排时的宽度约束（由 lib/layout.ts 的解析结果给出）。
   *
   * 为什么必须由调用方注入：§5.2 要求"用户拖动比例分模式保存"、
   * "各自按最小宽度钳制"，这些只有布局解析器知道；组件自己写死 CSS
   * 会与解析结果脱节（实测出现过解析算出宽度却没用上、预览把内容挤成 0 宽）。
   */
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
  const [readAt, setReadAt] = useState<{ x: number; y: number } | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  /** 文件信息（完整路径、版本、hash、来源、audience）：从标签上收走的路径信息在这里 */
  const [infoOpen, setInfoOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  /** 源码视图自动换行（减负 §5：从常驻分段控件收进「阅读 ▾」菜单） */
  const [wrapSource, setWrapSource] = useState(false);
  const [zoom, setZoom] = useState<number>(0); // 0 = 适应窗口
  /** 选中的正文文字：可"引用选区"加入目标草稿（仍需用户发送） */
  const [selection, setSelection] = useState('');
  /** 标签条是否溢出：只在真的放不下时才占用"已打开文件"入口 */
  const [tabsOverflow, setTabsOverflow] = useState(false);
  /**
   * ⚠ 这里曾尝试用 `entered` 状态类做入场淡入/滑入，**已回退**。
   * 原因（实测）：页面处于 `visibilityState: hidden` 时（后台窗口、CDP 驱动）
   * `setTimeout` 被冻结，`.entered` 永远加不上，而基类的 `opacity:0`
   * 会让整块预览**永久隐形**（实测 2.5s 内 opacity 恒为 0）。
   * 入场动画需要"元素保持挂载、只改宽度"的结构，见 preview.css 注释。
   */
  const paneCls = `preview-pane${className ? ` ${className}` : ''}`;

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

  // 活动标签必须也在可见集合里；否则用第一个可见标签（标签被暂藏时不显示它）
  const active = tabs.find((t) => t.key === session.activeKey) ?? tabs[0];
  const resource = active ? resourceOf(s, active.resourceId) : undefined;
  const revision = resource && active ? revOf(resource, active.revision) : undefined;

  // 恢复阅读位置（关闭/收起后不丢）
  useEffect(() => {
    if (bodyRef.current && active) bodyRef.current.scrollTop = active.scrollTop;
    // 只在切换标签时恢复，滚动过程不写回（避免每个滚动帧 setState）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key]);

  /**
   * 默认视图按**内容类型**决定（减负 §5）：
   *  · Markdown / CSV → 阅读视图（原来所有类型都默认"预览"，看起来一样但其实对代码无效）；
   *  · 代码 / 纯文本 → 源码视图（本来 ResourceBody 对它们恒渲染源码，
   *    这里让控件的当前态与真实渲染一致，不再出现"点了没反应"的选项）。
   * 换标签时重置，避免上一个文件的选择误用到这一个。
   */
  const activeKind = revision?.content.kind;
  useEffect(() => {
    setViewMode(activeKind === 'code' || activeKind === 'text' ? 'source' : 'preview');
    setSelection('');
  }, [active?.key, activeKind]);

  /** 活动标签滚进可视区（标签只显示一次文件名，看不见它就等于不知道在看哪个文件） */
  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const el = strip.querySelector<HTMLElement>('.preview-tab.on');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active?.key, tabs.length]);

  /** 标签溢出检测：入口只在需要时显示（减负 §5） */
  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const measure = () => setTabsOverflow(strip.scrollWidth > strip.clientWidth + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabs.length, s.preview.hidden]);

  /**
   * 标签显示名：同名补父路径，避免"两个 README.md"分不清。
   *
   * ⚠ 这个 useMemo 必须待在**所有 early return 之前**。
   * 原来它写在 `tabs.length === 0` / `!resource` 两个 return 之后 ——
   * 于是"关掉最后一个标签"或"资源失效"时 hook 数量变少，
   * React 抛 #300（Rendered fewer hooks than expected）把**整页**打崩。
   * 文件页关掉最后一个预览标签就能稳定复现。
   */
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
    // 不需要常驻空态时，整块不渲染（DM 页靠这个保持简洁）
    if (!showEmpty && !singleRegion) return null;
    return (
      <aside className={paneCls} style={flexStyle} aria-label="文件预览">
        <div className="preview-head">
          <PreviewNavControl
            singleRegion={singleRegion}
            onBackToContext={onBackToContext}
            onCollapse={hidePreview}
          />
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
    // 资源失效：只让这个标签进入错误态，其他标签仍可用（§9.2）
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
              <button className="btn sm" onClick={() => active && closePreviewTab(active.key)}>
                关闭此标签
              </button>
            </div>
          </div>
        </div>
      </aside>
    );
  }

  /**
   * 文件名只在这里出现一次（减负 §5）。
   * 工具行不再重复 `dir / tail`：同名文件在标签上补最短可区分父路径，
   * 完整路径进「⋯ → 文件信息」。`url` 仍保留给文件信息与 tooltip 用。
   */
  const url = resource.relativePath ?? resource.title;

  /**
   * 阅读方式入口只在**真的有可切换的内容**时出现：
   * 图片有独立缩放控件、不支持的类型没有任何视图可选 ——
   * 都不给一个点了没反应的菜单（减负 §5：能力缺失不伪造可用动作）。
   */
  const canChooseReading =
    resource.mutable || ['markdown', 'csv', 'code', 'text'].includes(revision.content.kind);
  const canWrap = ['markdown', 'csv', 'code', 'text'].includes(revision.content.kind);
  /**
   * 是否有"渲染阅读视图"可选。
   * 代码/纯文本没有富文本视图 —— 菜单里就不摆一个点了没反应的"阅读视图"，
   * 而是说明当前只有代码视图并给出换行开关（减负 §5 后半句）。
   */
  const supportsRendered = revision.content.kind === 'markdown' || revision.content.kind === 'csv';

  return (
    <aside className={`preview-pane${className ? ` ${className}` : ''}`} style={flexStyle} aria-label="文件预览">
      {/* ---------- 第一行：文件标签 ---------- */}
      <div className="preview-tabs" role="tablist" aria-label="已打开的文件">
        {/* 区域级「收起/返回」在**左端**，与回复串的收起同一侧、同一组件（见 ui.tsx 注释） */}
        <PreviewNavControl
          singleRegion={singleRegion}
          onBackToContext={onBackToContext}
          onCollapse={hidePreview}
        />

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
                  {ver ? (
                    <span className="faint mono-sm">
                      {/* 版本**只在这里显示一次**（去重）：口径统一走 revisionLabel ——
                          固定交付/附件 `v3`，工作区读取快照 `读取 r3`。 */}
                      {ver}
                    </span>
                  ) : null}
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

        {/**
         * 「已打开的文件」只在**标签溢出或存在暂藏资源**时出现（减负 §5）。
         * 标题里只报数量，不回显被暂藏标签的名字（§17.9 第 7 条：
         * 受限资源在别的上下文里连名字都不该泄露）。
         */}
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

        {/* 放大后必须能一眼找到"还原"：不只换 tooltip（减负 §5） */}
        {session.maximized ? (
          <button
            className="btn ghost sm preview-restore"
            title="还原预览大小（回到与对话并排）"
            aria-pressed
            onClick={togglePreviewMaximized}
          >
            <Icon name="copy" size={12} /> 还原
          </button>
        ) : null}
      </div>

      {/* ---------- 第二行：当前文件的工具 ----------
          文件名与版本都**不在这里重复**：文件名在标签上一次，版本也在标签上一次
          （口径统一 `v3` / `读取 r3`，见 revisionLabel）；完整路径与 hash 进「⋯ → 文件信息」。
          这里只留"需要动作"的东西：版本变了要重新加载、阅读方式、引用目标、更多。 */}
      <div className="preview-tools">
        {resource.mutable && active.pendingRevision ? (
          <button
            className="tag-btn warning"
            title="磁盘上的文件已更新。点击重新加载会切换到这个标签的读取快照；已插入草稿的引用仍绑定原版本"
            onClick={() => reloadResource(active.pendingRevision!, active.key)}
          >
            <Icon name="alert-triangle" size={10} /> 磁盘已更新 · 重新加载
          </button>
        ) : null}

        <div className="spacer" />

        {/**
         * 「阅读 ▾」：视图模式收进菜单（减负 §5），菜单里明确当前模式。
         * 按钮上只写一次模式名（不再出现"阅读：阅读"这种重复）：
         *  · 阅读视图 → `阅读视图`
         *  · 源码视图 → `源码视图`
         * 不支持切换的格式（图片/不支持）不渲染该入口，也不给禁用占位。
         */}
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

        {/* 引用目标必须明确（§5）：并排对话时显示"引用到 任务 #14" */}
        <button
          className="btn sm primary"
          title={`把这份文件的固定版本插入「${quoteTarget.label}」草稿；需你再次点击发送才会进入对话`}
          onClick={() => {
            const ok = quoteResource(active.resourceId, active.revision, quoteTarget.draftKey, quoteTarget.label);
            if (ok) {
              // 引用进入草稿后焦点回目标输入框（§12）
              window.dispatchEvent(new CustomEvent('zs:focus-composer', { detail: quoteTarget.draftKey }));
            }
          }}
        >
          <Icon name="corner-down-right" size={12} /> 引用到 {quoteTarget.label}
        </button>

        <button
          className="preview-icon-btn"
          aria-label="更多文件操作"
          title="更多：文件信息、导出下载、复制路径、放大、关闭"
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
              <MenuItem
                icon="eye"
                title="把 Markdown / CSV 渲染成排版后的样子"
                hint={viewMode === 'preview' ? '当前' : undefined}
                onClick={() => { setViewMode('preview'); setReadAt(null); }}
              >
                阅读视图
              </MenuItem>
              <MenuItem
                icon="align-left"
                title="按原始文本显示（保留空白，带行号）"
                hint={viewMode === 'source' ? '当前' : undefined}
                onClick={() => { setViewMode('source'); setReadAt(null); }}
              >
                源码视图
              </MenuItem>
            </>
          ) : (
            <div className="menu-note">
              这个文件只有代码/纯文本视图，界面不假装能渲染成富文本。
              需要时可切换自动换行。
            </div>
          )}
          {canWrap ? (
            <MenuItem
              icon="align-left"
              title="长行是否折行显示（只影响源码/纯文本视图）"
              hint={wrapSource ? '当前：换行' : '当前：不换行'}
              onClick={() => { setWrapSource((v) => !v); setReadAt(null); }}
            >
              {wrapSource ? '取消自动换行' : '自动换行'}
            </MenuItem>
          ) : null}
        </Menu>
      ) : null}

      {/**
       * 来源：**只显示一次**（去重）。
       *
       * 原来固定写「来源：X · 从 Y 打开」，而当 X 与 Y 本来就是同一处时
       * （最典型：主池附件"来源：开发大厅 · 某人的消息 · 从 开发大厅 主池消息 打开"）
       * 就是同一句话说两遍。现在只在**来路与真实归属确实不同**时才补"从…打开"，
       * 例如从搜索/收藏结果跳进来源房间、或跨房间打开。
       */}
      <div className="preview-origin">
        <Icon name="link" size={11} className="faint" />
        <span className="truncate" title={`来源：${originLabel(s, resource)}`}>来源：{originLabel(s, resource)}</span>
        {openedFromAddsInfo(s, resource, active.openedFrom) ? (
          <>
            <span className="faint">·</span>
            <span className="truncate" title={`本次从 ${openedFromLabel(s, active.openedFrom)} 打开`}>
              从 {openedFromLabel(s, active.openedFrom)} 打开
            </span>
          </>
        ) : null}
        <span className="faint">·</span>
        <span title="原型内嵌的模拟资源；内容真实可渲染，但不代表读取了你的磁盘文件">
          <Tag plain>模拟资源</Tag>
        </span>
      </div>

      {/* ---------- 正文 ---------- */}
      <div
        className="preview-body"
        ref={bodyRef}
        onScroll={(e) => {
          // 节流：只在停止滚动后记录位置，避免每帧写 state
          const el = e.currentTarget;
          if (scrollTimer.current) window.clearTimeout(scrollTimer.current);
          scrollTimer.current = window.setTimeout(() => rememberScroll(active.key, el.scrollTop), 220);
        }}
        onMouseUp={() => {
          // 选中文字即可"引用选区"（只加入草稿，仍需用户发送；§5）
          const sel = window.getSelection()?.toString() ?? '';
          setSelection(sel.trim().slice(0, 400));
        }}
        onKeyUp={undefined}
      >
        <ResourceBody
          resource={resource}
          revision={revision}
          viewMode={viewMode}
          wrapSource={wrapSource}
          zoom={zoom}
          onOpenComment={() => setCommentOpen(true)}
        />
      </div>

      {selection ? (
        <button
          type="button"
          className="preview-quote-selection"
          title={`把选中的文字作为引用加入「${quoteTarget.label}」草稿；仍需你点击发送`}
          onClick={() => {
            const ok = quoteResource(
              active.resourceId, active.revision, quoteTarget.draftKey, quoteTarget.label, selection,
            );
            if (ok) {
              window.dispatchEvent(new CustomEvent('zs:focus-composer', { detail: quoteTarget.draftKey }));
              setSelection('');
            }
          }}
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
              <MenuItem
                key={t.key}
                icon="file-text"
                hint={t.key === active.key ? '当前' : undefined}
                onClick={() => { activatePreview(t.key); setOpenList(null); }}
              >
                {r?.title ?? t.key}{r && !r.mutable ? ` · v${t.revision}` : ''}
              </MenuItem>
            );
          })}
          <MenuItem icon="x" onClick={() => { closeAllPreviews(); setOpenList(null); }}>
            关闭所有文件
          </MenuItem>
        </Menu>
      ) : null}

      {moreAt ? (
        <Menu anchor={moreAt} onClose={() => setMoreAt(null)}>
          <div className="menu-label">{resource.title}</div>
          {/* 菜单项名称保持简短，解释走 tooltip（用户要求：操作名短、解释进辅助说明） */}
          <MenuItem
            icon="info"
            title="完整路径、版本、内容 hash、来源与可见范围"
            onClick={() => { setInfoOpen(true); setMoreAt(null); }}
          >
            文件信息
          </MenuItem>
          <MenuItem
            icon="copy"
            title={`复制「路径 (版本, hash)」：${resource.relativePath ?? resource.title}`}
            onClick={() => {
              void navigator.clipboard?.writeText(`${resource.relativePath ?? resource.title} (v${active.revision}, ${revision.hash})`);
              setMoreAt(null);
            }}
          >
            复制路径与版本
          </MenuItem>
          <MenuItem
            icon="download"
            title="原型未接通真实文件：这里不会真的导出或下载"
            hint="未接通"
            onClick={() => setMoreAt(null)}
          >
            导出 / 下载
          </MenuItem>
          <MenuItem
            icon="message-square"
            title="以这份文件的当前版本为锚点发一条评论；来源会话与版本会被固定下来"
            onClick={() => { setCommentOpen(true); setMoreAt(null); }}
          >
            评论此文件
          </MenuItem>
          {/* 放大从标签行收进菜单；放大后标签行会常驻一个「还原」按钮（§5） */}
          <MenuItem
            icon={session.maximized ? 'copy' : 'maximize'}
            title={session.maximized ? '回到与对话并排的大小' : '临时占满内容区，便于细读长文件'}
            onClick={() => { togglePreviewMaximized(); setMoreAt(null); }}
          >
            {session.maximized ? '还原预览大小' : '放大预览'}
          </MenuItem>
          {/* 收起预览的主入口在标签行左端；单区域下左端是「对话」，
              这里再给一条同名入口，保证"收起预览"在任何布局都可达（不会两个都像返回） */}
          {singleRegion ? (
            <MenuItem
              icon="chevron-right"
              title="保留全部标签与阅读位置，稍后可重开（不会关闭文件）"
              onClick={() => { hidePreview(); setMoreAt(null); }}
            >
              收起预览
            </MenuItem>
          ) : null}
          <MenuItem
            icon="x"
            title="只关闭当前这个标签，其他标签不受影响"
            onClick={() => { closePreviewTab(active.key); setMoreAt(null); }}
          >
            关闭此文件
          </MenuItem>
          <MenuItem
            icon="panel-right"
            title="清空全部标签、退出预览；不会删除磁盘文件"
            onClick={() => { closeAllPreviews(); setMoreAt(null); }}
          >
            关闭所有文件
          </MenuItem>
        </Menu>
      ) : null}

      {infoOpen ? (
        <Modal onClose={() => setInfoOpen(false)} size="md" title="文件信息">
          <dl className="kv">
            <dt>文件名</dt>
            <dd>{resource.title}</dd>
            <dt>完整路径</dt>
            <dd className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{url}</dd>
            <dt>版本</dt>
            <dd>
              {revisionLabel(resource, active.revision)}
              <span className="faint"> · {resource.mutable ? '工作区读取快照（随磁盘更新，需手动重新加载）' : '固定交付/附件版本'}</span>
            </dd>
            <dt>内容 hash</dt>
            <dd className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{revision.hash}</dd>
            <dt>大小</dt>
            <dd>{formatBytes(revision.sizeBytes)}</dd>
            <dt>类型</dt>
            <dd className="mono-sm">{resource.mimeType}</dd>
            <dt>版本时间</dt>
            <dd>{fullTime(revision.createdAt)}</dd>
            <dt>来源</dt>
            <dd>{originLabel(s, resource)}</dd>
            <dt>可见范围</dt>
            <dd>
              {resource.audience.kind === 'room' ? '本房间成员'
                : resource.audience.kind === 'dm' ? '仅这条私信的参与者'
                  : '项目成员'}
            </dd>
            <dt>本次打开位置</dt>
            <dd>{openedFromLabel(s, active.openedFrom)}</dd>
          </dl>
        </Modal>
      ) : null}

      {commentOpen ? (
        <CommentDialog
          resource={resource}
          revision={revision}
          onClose={() => setCommentOpen(false)}
        />
      ) : null}
    </aside>
  );
}

const scrollTimer = { current: 0 as number | undefined };

/* ============================================================
   正文渲染：按 content kind 分发（§8.1）
   ============================================================ */

function ResourceBody({
  resource, revision, viewMode, wrapSource, zoom, onOpenComment,
}: {
  resource: PreviewResource;
  revision: ResourceRevision;
  viewMode: 'preview' | 'source';
  /** 源码视图自动换行（从「阅读 ▾」菜单切换） */
  wrapSource: boolean;
  zoom: number;
  onOpenComment: () => void;
}) {
  const c = revision.content;

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
            alt={resource.title}
            className="preview-image"
            style={zoom === 0 ? { maxWidth: '100%', maxHeight: '100%' } : { width: `${c.width * zoom}px` }}
          />
          <div className="preview-image-meta small faint">
            {c.width} × {c.height} · {resource.mimeType} · 含半透明区域（棋盘底显示透明）
          </div>
        </div>
      );

    case 'diff':
      return <DiffText left={c.left} right={c.right} leftLabel={c.leftLabel} rightLabel={c.rightLabel} />;

    case 'unsupported':
      return (
        <div className="preview-unsupported">
          <Icon name="alert-triangle" size={20} className="faint" />
          <div className="strong" style={{ marginTop: 8 }}>这种格式当前不能预览</div>
          <div className="small muted" style={{ marginTop: 6, maxWidth: 420, lineHeight: 1.7 }}>
            {c.note}
          </div>
          <div className="row tight wrap" style={{ marginTop: 10 }}>
            <Tag plain icon="check">可保存</Tag>
            <Tag tone="warning" icon="slash">预览：{c.reason === 'not_connected' ? '服务未接通' : c.reason === 'binary' ? '二进制' : c.reason === 'too_large' ? '文件过大' : '内容损坏'}</Tag>
            <Tag plain icon="help-circle">提取正文：未实现</Tag>
            <Tag plain icon="help-circle">交给 AI：按成员能力另行判断</Tag>
          </div>
          <div className="small faint" style={{ marginTop: 10, lineHeight: 1.7 }}>
            保存、预览、提取正文、交给 AI 是四种独立能力，这里分别如实标注。
            界面不会用一段假正文冒充已解析。
          </div>
          <div className="panel-actions">
            <button className="btn sm" onClick={onOpenComment}>
              <Icon name="message-square" size={12} /> 评论此文件（文件级锚点）
            </button>
          </div>
        </div>
      );
  }
}

/** 源码/纯文本视图：带行号，保留空白；可切换自动换行（减负 §5 的「阅读 ▾」项） */
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

/**
 * CSV 表格视图。
 *
 * 按**真实 CSV 规则**解析：引号内的逗号与换行属于同一个单元格
 * （fixture 里刻意放了这两种情况，用来验证不是简单 split(',')）。
 */
function CsvView({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) return <div className="small faint">（空文件）</div>;
  const [head, ...body] = rows;
  return (
    <div className="preview-csv-wrap">
      <table className="preview-csv">
        <thead>
          <tr>
            {head.map((h, i) => <th key={i}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {head.map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small faint" style={{ marginTop: 8 }}>
        逻辑行数与单元格内的换行分别处理；引号内的逗号不作为分隔符。
      </div>
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
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/* ============================================================
   评论对话框（§7.4：固定源会话与版本）
   ============================================================ */

function CommentDialog({
  resource, revision, onClose,
}: {
  resource: PreviewResource;
  revision: ResourceRevision;
  onClose: () => void;
}) {
  const s = useStore((x) => x);
  const [body, setBody] = useState('');

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
          <span className="small faint">评论是文件线程的普通回复，带 re: 引用可回到精确位置</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!body.trim()}
            onClick={() => {
              createFileComment(resource.id, revision.revision, undefined, body.trim());
              onClose();
            }}
          >
            提交评论
          </button>
        </>
      }
    >
      {/* 归属必须写清：在看 B 的对话里评论 A 的文件，评论仍归 A（PV-20） */}
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
          版本固定为 <span className="mono-sm">v{revision.revision}</span>。
          文件更新后旧评论会标记「基于 v{revision.revision}」，锚点不会静默漂移到新版本。
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

/**
 * 注意：它**不再浮在右下角**。
 *
 * 原实现是 `position:absolute; right:12px; bottom:14px`，正好压在输入区的
 * 发送按钮上（用户截图反馈"文件预览挡住发送按钮"）。现在它是房间头部里的
 * 一个普通 chip（由 Room.tsx 放进 `.pool-head`），参与正常布局、不会遮挡任何控件。
 */
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

