import { describe, expect, it } from 'vitest';
import {
  PREVIEW_PANE_POLICY,
  SIDEBAR_WIDTH,
  THREAD_PANE_POLICY,
  displayedSplitPaneWidth,
  maxSplitPanePrimaryWidth,
  resolveLayout,
  resolveSplitPaneWidths,
} from '../../src/ui/hifi/lib/layout.ts';

const contentWidth = (viewportWidth: number): number => viewportWidth - SIDEBAR_WIDTH;

describe('R101 responsive wide-room width allocation', () => {
  it('grows both panes from the real content width at 1280/1920/3440', () => {
    const cases = [
      { viewport: 1280, available: contentWidth(1280), thread: 414, main: 612, preview: 579, context: 447 },
      { viewport: 1920, available: contentWidth(1920), thread: 670, main: 996, preview: 937, context: 729 },
      { viewport: 3440, available: contentWidth(3440), thread: 1278, main: 1908, preview: 1789, context: 1397 },
    ];

    for (const width of cases) {
      const thread = resolveSplitPaneWidths(width.available, THREAD_PANE_POLICY);
      const preview = resolveSplitPaneWidths(width.available, PREVIEW_PANE_POLICY);

      expect(thread.primary).toBe(width.thread);
      expect(thread.secondary).toBe(width.main);
      expect(preview.primary).toBe(width.preview);
      expect(preview.secondary).toBe(width.context);
      expect(thread.primary + thread.secondary + THREAD_PANE_POLICY.splitter).toBe(width.available);
      expect(preview.primary + preview.secondary + PREVIEW_PANE_POLICY.splitter).toBe(width.available);

      const layout = resolveLayout({
        navVisibleWidth: width.available,
        hasThread: true,
        hasPreview: true,
        navPinned: false,
      });
      expect(layout.layout).toBe('context-preview');
      expect(layout.previewWidth).toBe(width.preview);
      expect(layout.contextWidth).toBe(width.context);
    }
  });

  it('uses the same available-width basis for the responsive default and manual maximum', () => {
    const available = contentWidth(3440);
    const widths = resolveSplitPaneWidths(available, THREAD_PANE_POLICY);

    expect(widths.defaultPrimary).toBe(1278);
    expect(widths.defaultPrimary).toBeGreaterThan(1100);
    expect(widths.maxPrimary).toBe(2766);
    expect(widths.defaultPrimary).toBeLessThanOrEqual(widths.maxPrimary);
    expect(maxSplitPanePrimaryWidth(available, THREAD_PANE_POLICY)).toBe(widths.maxPrimary);
  });

  it('clamps a manual value only for current display and restores its intent when widened', () => {
    const wide = contentWidth(3440);
    const compact = contentWidth(1280);
    const manual = 1500;

    expect(displayedSplitPaneWidth(wide, THREAD_PANE_POLICY, manual)).toBe(manual);
    expect(displayedSplitPaneWidth(compact, THREAD_PANE_POLICY, manual)).toBe(606);
    expect(displayedSplitPaneWidth(wide, THREAD_PANE_POLICY, manual)).toBe(manual);
  });

  it('uses measured responsive defaults at the minimum two-pane width', () => {
    const available = THREAD_PANE_POLICY.primaryMin + THREAD_PANE_POLICY.secondaryMin + THREAD_PANE_POLICY.splitter;
    const widths = resolveSplitPaneWidths(available, THREAD_PANE_POLICY);

    expect(widths.primary).toBe(380);
    expect(widths.secondary).toBe(420);
  });

  it('degrades from the real container budget, not a viewport media query', () => {
    const hiddenNavPreview = resolveLayout({
      navVisibleWidth: 754,
      hasThread: true,
      hasPreview: true,
      navPinned: false,
    });
    expect(hiddenNavPreview.layout).toBe('context-preview');
    expect(hiddenNavPreview.hideNav).toBe(true);
    expect(hiddenNavPreview.previewWidth).toBe(552);
    expect(hiddenNavPreview.contextWidth).toBe(440);

    const single = resolveLayout({
      navVisibleWidth: 654,
      hasThread: true,
      hasPreview: true,
      navPinned: false,
    });
    expect(single.layout).toBe('single');
    expect(single.hideNav).toBe(false);

    const narrowThread = resolveLayout({
      navVisibleWidth: 554,
      hasThread: true,
      hasPreview: false,
      navPinned: false,
    });
    expect(narrowThread.layout).toBe('context-thread');
    expect(narrowThread.hideNav).toBe(true);
  });
});
