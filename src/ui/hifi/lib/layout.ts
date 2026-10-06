/**
 * 布局测量与宽度契约（UX-PREVIEW-01 / §5.2、§17.9 第 8 条）。
 *
 * 为什么必须换掉 `window.innerWidth < 1280`：
 *  - 那个判定看的是**视口**，而实际可用宽度还要扣掉导航、外层内边距与分隔条；
 *  - 系统缩放/浏览器缩放下 `innerWidth` 与实际 CSS 像素可用宽度不一致；
 *  - 结果就是"数学上放得下、实际读不了"。
 * 因此改为用 `ResizeObserver` 测量**容器实际宽度**，并由唯一的解析器
 * 决定显示哪几个区域（施工说明 §1.2 第 4 条：JS 与 CSS 消费同一个结果，
 * 视觉稿的媒体查询不得独立再开关主池/线程/预览）。
 *
 * 宽度数值（§5.2）：
 *  - L2 主池 420 / 回复串 380 —— **沿用既有常量，未改全局下限**（v1.1 已撤回 360）；
 *  - L4 对话 440、预览 480 —— **候选值**，必须在 1280/1372/1100/900 真实内容下验证。
 *    这里只把它们作为"验证预算"，不当作已批准的产品断点。
 */

export const LAYOUT_MIN = {
  /** 房间主池/房间集合：沿用 Room.tsx 的 MAIN_MIN，不自作主张改小 */
  main: 420,
  /** 回复串：沿用 Room.tsx 的 THREAD_MIN */
  thread: 380,
  /** L4 对话侧候选值（仅预览实验） */
  contextWide: 440,
  /** 通用文件预览候选值 */
  preview: 480,
  /** 项目文件/Git 列表候选值 */
  filesList: 280,
  /** 分隔条 */
  splitter: 8,
} as const;

export type RegionLayout =
  /** L1：只有上下文 */
  | 'context'
  /** L2：主池 + 回复串 */
  | 'context-thread'
  /** L3/L4：上下文 + 预览 */
  | 'context-preview'
  /** 单区域：上下文与文件二选一 */
  | 'single';

export interface LayoutInput {
  /**
   * **导航可见时**的内容区可用宽度（不含导航占宽）。
   *
   * 为什么必须以这个值为准，而不是"当前实际宽度"：
   * 布局决定（隐藏导航）会改变可用宽度，而可用宽度又是布局决定的输入 ——
   * 直接用当前宽度会形成**反馈环**：隐藏→变宽→判定不必隐藏→显示→变窄→再隐藏，
   * 实测在 React 里表现为 "Maximum update depth exceeded"。
   * 固定用"导航可见时的宽度"作为输入，判定就与当前状态无关，不再振荡。
   * 调用方在导航已隐藏时，用 `当前宽度 - SIDEBAR_WIDTH` 还原这个值。
   */
  navVisibleWidth: number;
  /** 是否已打开线程 */
  hasThread: boolean;
  /** 是否已打开预览（且有可见标签） */
  hasPreview: boolean;
  /** 用户锁定了导航展开（此时不允许靠隐藏导航换宽度） */
  navPinned: boolean;
}

export const SIDEBAR_WIDTH = 246;

export interface LayoutDecision {
  layout: RegionLayout;
  /**
   * 是否**需要**临时隐藏左导航。
   * 这是关于 `navVisibleWidth` 的纯函数；调用方据此决定实际隐藏。
   */
  hideNav: boolean;
  /** 上下文区建议宽度（L2/L3/L4） */
  contextWidth: number;
  /** 预览区建议宽度 */
  previewWidth: number;
  /** 人类可读的原因，用于截图取证与报告 */
  reason: string;
}

/**
 * 唯一的布局解析器。
 *
 * 降级顺序（§5.3）：
 *  1. 钳制分隔比例，保证两区最小宽度（本函数算出可用值）；
 *  2. 临时隐藏左导航（若用户未锁定）——**导航隐藏后**的可用宽度参与判定；
 *  3. 仍不足 → 单区域切换。
 */
export function resolveLayout(input: LayoutInput): LayoutDecision {
  const { navVisibleWidth, hasThread, hasPreview, navPinned } = input;
  /** 隐藏导航后能拿到的宽度（导航可见时的宽度 + 导航本身） */
  const navHiddenAvailable = navVisibleWidth + SIDEBAR_WIDTH;
  /** 当前**实际**可用宽度（由是否需要隐藏决定） */
  const available = navVisibleWidth;

  // 没有预览：保持既有 L1/L2 行为，不动主池与线程的既有下限
  if (!hasPreview) {
    if (!hasThread) {
      return {
        layout: 'context', hideNav: false,
        contextWidth: available, previewWidth: 0,
        reason: '无预览：单区域房间上下文',
      };
    }
    const need = LAYOUT_MIN.main + LAYOUT_MIN.thread + LAYOUT_MIN.splitter;
    if (available >= need) {
      const threadW = Math.min(Math.max(LAYOUT_MIN.thread, 620), available - LAYOUT_MIN.main - LAYOUT_MIN.splitter);
      return {
        layout: 'context-thread', hideNav: false,
        contextWidth: available - threadW - LAYOUT_MIN.splitter, previewWidth: threadW,
        reason: `L2：可用 ${available}px ≥ 需要 ${need}px`,
      };
    }
    return {
      layout: 'context-thread', hideNav: !navPinned,
      contextWidth: Math.max(LAYOUT_MIN.main, available - LAYOUT_MIN.thread - LAYOUT_MIN.splitter),
      previewWidth: LAYOUT_MIN.thread,
      reason: `L2 紧张：可用 ${available}px < 需要 ${need}px${navPinned ? '（用户锁定导航，不能靠隐藏换宽度）' : ' → 建议临时隐藏导航'}`,
    };
  }

  // 有预览：L3/L4。对话侧用候选 440，预览侧候选 480
  const need = LAYOUT_MIN.contextWide + LAYOUT_MIN.preview + LAYOUT_MIN.splitter;
  if (available >= need) {
    // 预览优先拿约 56%，但保证对话不低于候选下限
    const previewW = Math.min(
      Math.max(LAYOUT_MIN.preview, Math.round(available * 0.56)),
      available - LAYOUT_MIN.contextWide - LAYOUT_MIN.splitter,
    );
    return {
      layout: 'context-preview', hideNav: false,
      contextWidth: available - previewW - LAYOUT_MIN.splitter, previewWidth: previewW,
      reason: `L3/L4：可用 ${available}px ≥ 需要 ${need}px`,
    };
  }

  // 扣掉导航后可能够：建议自动临时隐藏（不覆盖用户显式偏好）
  if (!navPinned && navHiddenAvailable >= need) {
    return {
      layout: 'context-preview', hideNav: true,
      contextWidth: navHiddenAvailable - LAYOUT_MIN.preview - LAYOUT_MIN.splitter,
      previewWidth: LAYOUT_MIN.preview,
      reason: `L3/L4 需临时隐藏导航：导航可见时 ${navVisibleWidth}px < ${need}px，隐藏后 ${navHiddenAvailable}px`,
    };
  }

  // 仍不足 → 单区域（对话/文件二选一）
  return {
    layout: 'single', hideNav: false,
    contextWidth: available, previewWidth: available,
    reason: `单区域：导航可见时 ${navVisibleWidth}px、隐藏后 ${navHiddenAvailable}px 都不足 ${need}px`,
  };
}

/** 当前是 L3（主池+文件）还是 L4（线程+文件）——用于文案与顶部栏差异 */
export function previewContextKind(hasThread: boolean): 'L3' | 'L4' {
  return hasThread ? 'L4' : 'L3';
}
