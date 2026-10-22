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
 *  - L2 主池 420 / 回复串 380；
 *  - L4 对话 440 / 预览 480；
 *  - 1280/1920/3440 的默认比例与消费值由下方 SplitPanePolicy 统一计算。
 */

export const LAYOUT_MIN = {
  /** 房间主池/房间集合最小可读宽度 */
  main: 420,
  /** 回复串最小可读宽度 */
  thread: 380,
  /** L4 对话侧最小可读宽度 */
  contextWide: 440,
  /** 通用文件预览最小可读宽度 */
  preview: 480,
  /** 项目文件/Git 列表候选值 */
  filesList: 280,
  /** 分隔条 */
  splitter: 8,
} as const;

export interface SplitPanePolicy {
  /** 主面板（回复串或预览）最小可读宽度 */
  primaryMin: number;
  /** 另一侧上下文面板最小可读宽度 */
  secondaryMin: number;
  /** 两侧之间用于拖动的净宽度预算 */
  splitter: number;
  /** 没有任何手调意图时，主面板占当前可用宽度的比例 */
  defaultPrimaryRatio: number;
}

/**
 * 回复串的响应式宽度契约。
 *
 * 40% 的依据：1280 窗口扣除侧栏后约 1034px，回复串约 414px，主池约 612px；
 * 1920 时约 670/996；3440 时约 1278/1908。两列都随容器增长，且不会在
 * 常见宽度上只剩一个勉强达到下限的阅读列。拖动手调的上限不另设像素封顶，
 * 统一由“可用宽度 − 主池下限 − 分隔条”决定，避免宽屏默认值超过手调上限。
 */
export const THREAD_PANE_POLICY: SplitPanePolicy = {
  primaryMin: LAYOUT_MIN.thread,
  secondaryMin: LAYOUT_MIN.main,
  splitter: LAYOUT_MIN.splitter,
  defaultPrimaryRatio: 0.4,
};

/**
 * 预览侧的响应式宽度契约。
 *
 * 56% 的依据：1280 窗口扣除侧栏后约 1034px，预览约 579px、上下文约 447px；
 * 1920 时约 937/729；3440 时约 1789/1397。预览获得略多空间以容纳 Markdown
 * 表格与源码，同时为回复串或主池保留至少 440px 的阅读面。
 */
export const PREVIEW_PANE_POLICY: SplitPanePolicy = {
  primaryMin: LAYOUT_MIN.preview,
  secondaryMin: LAYOUT_MIN.contextWide,
  splitter: LAYOUT_MIN.splitter,
  defaultPrimaryRatio: 0.56,
};

export interface SplitPaneWidths {
  /** 主面板当前应消费的宽度 */
  primary: number;
  /** 另一侧上下文当前应消费的宽度 */
  secondary: number;
  /** 主面板拖动上限；与响应式默认使用同一可用宽度基准 */
  maxPrimary: number;
  /** 未手调时的响应式默认宽度 */
  defaultPrimary: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** 当前可用宽度下，主面板可拖到的最大值。 */
export function maxSplitPanePrimaryWidth(availableWidth: number, policy: SplitPanePolicy): number {
  const available = Math.max(0, Math.round(availableWidth));
  return Math.max(
    policy.primaryMin,
    Math.floor(available - policy.secondaryMin - policy.splitter),
  );
}

/**
 * 手调值的显示宽度。
 *
 * `manualWidth == null` 表示没有用户意图，始终跟随响应式默认；有手调值时，
 * 窗口变窄只在显示侧钳制，原始手调值不被写回，拉宽后自然恢复。
 */
export function displayedSplitPaneWidth(
  availableWidth: number,
  policy: SplitPanePolicy,
  manualWidth: number | null,
): number {
  const available = Math.max(0, Math.round(availableWidth));
  const maxPrimary = maxSplitPanePrimaryWidth(available, policy);
  if (manualWidth == null) {
    return clamp(
      Math.round(available * policy.defaultPrimaryRatio),
      policy.primaryMin,
      maxPrimary,
    );
  }
  return clamp(Math.round(manualWidth), policy.primaryMin, maxPrimary);
}

/** 一次算出双区两列宽度，避免默认值与拖动上限来自两套基准。 */
export function resolveSplitPaneWidths(
  availableWidth: number,
  policy: SplitPanePolicy,
  manualWidth: number | null = null,
): SplitPaneWidths {
  const available = Math.max(0, Math.round(availableWidth));
  const maxPrimary = maxSplitPanePrimaryWidth(available, policy);
  const defaultPrimary = displayedSplitPaneWidth(available, policy, null);
  const primary = displayedSplitPaneWidth(available, policy, manualWidth);
  return {
    primary,
    secondary: Math.max(policy.secondaryMin, available - primary - policy.splitter),
    maxPrimary,
    defaultPrimary,
  };
}

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
  const availableVisible = Math.max(0, Math.round(navVisibleWidth));
  /** 隐藏导航后能拿到的宽度（导航可见时的宽度 + 导航本身） */
  const navHiddenAvailable = availableVisible + SIDEBAR_WIDTH;

  // 没有预览：保持既有 L1/L2 行为，不动主池与线程的既有下限
  if (!hasPreview) {
    if (!hasThread) {
      return {
        layout: 'context', hideNav: false,
        contextWidth: availableVisible, previewWidth: 0,
        reason: `无预览：单区域房间上下文（可用 ${availableVisible}px）`,
      };
    }
    const need = LAYOUT_MIN.main + LAYOUT_MIN.thread + LAYOUT_MIN.splitter;
    if (availableVisible >= need) {
      const widths = resolveSplitPaneWidths(availableVisible, THREAD_PANE_POLICY);
      return {
        layout: 'context-thread', hideNav: false,
        contextWidth: widths.secondary, previewWidth: widths.primary,
        reason: `L2：可用 ${availableVisible}px ≥ 需要 ${need}px；线程默认 ${widths.primary}px`,
      };
    }
    if (!navPinned && navHiddenAvailable >= need) {
      const widths = resolveSplitPaneWidths(navHiddenAvailable, THREAD_PANE_POLICY);
      return {
        layout: 'context-thread', hideNav: true,
        contextWidth: widths.secondary, previewWidth: widths.primary,
        reason: `L2 需临时隐藏导航：导航可见时 ${availableVisible}px < ${need}px，隐藏后 ${navHiddenAvailable}px；线程默认 ${widths.primary}px`,
      };
    }
    const compactWidth = navPinned ? availableVisible : navHiddenAvailable;
    const compact = resolveSplitPaneWidths(compactWidth, THREAD_PANE_POLICY);
    return {
      layout: 'context-thread', hideNav: !navPinned,
      contextWidth: compact.secondary,
      previewWidth: compact.primary,
      reason: `L2 紧张：可用 ${availableVisible}px < 需要 ${need}px；窄屏分支只显示回复串${navPinned ? '（用户锁定导航）' : `并临时隐藏导航，获得 ${compactWidth}px`}`,
    };
  }

  // 有预览：L3/L4。对话侧用候选 440，预览侧候选 480
  const need = LAYOUT_MIN.contextWide + LAYOUT_MIN.preview + LAYOUT_MIN.splitter;
  if (availableVisible >= need) {
    const widths = resolveSplitPaneWidths(availableVisible, PREVIEW_PANE_POLICY);
    return {
      layout: 'context-preview', hideNav: false,
      contextWidth: widths.secondary, previewWidth: widths.primary,
      reason: `L3/L4：可用 ${availableVisible}px ≥ 需要 ${need}px；预览默认 ${widths.primary}px`,
    };
  }

  // 扣掉导航后可能够：建议自动临时隐藏（不覆盖用户显式偏好）
  if (!navPinned && navHiddenAvailable >= need) {
    const widths = resolveSplitPaneWidths(navHiddenAvailable, PREVIEW_PANE_POLICY);
    return {
      layout: 'context-preview', hideNav: true,
      contextWidth: widths.secondary,
      previewWidth: widths.primary,
      reason: `L3/L4 需临时隐藏导航：导航可见时 ${availableVisible}px < ${need}px，隐藏后 ${navHiddenAvailable}px；预览默认 ${widths.primary}px`,
    };
  }

  // 仍不足 → 单区域（对话/文件二选一）
  return {
    layout: 'single', hideNav: false,
    contextWidth: availableVisible, previewWidth: availableVisible,
    reason: `单区域：导航可见时 ${availableVisible}px、隐藏后 ${navHiddenAvailable}px 都不足 ${need}px`,
  };
}

/** 当前是 L3（主池+文件）还是 L4（线程+文件）——用于文案与顶部栏差异 */
export function previewContextKind(hasThread: boolean): 'L3' | 'L4' {
  return hasThread ? 'L4' : 'L3';
}
