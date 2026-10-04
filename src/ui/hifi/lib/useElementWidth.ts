/**
 * 工作区容器测量（UX-PREVIEW-01 / §5.2、§17.9 第 8 条）。
 *
 * 存在的理由（施工说明 §5.A.5 要求"实现容器空间测量"）：
 * 旧的 `useNarrow()` 只看 `window.innerWidth < 1280`，它不知道：
 *  - 左侧导航是否展开（占 246px）；
 *  - 系统缩放/浏览器缩放造成的 CSS 像素差；
 *  - 外层内边距。
 * 于是出现"算出来放得下、实际主池被挤成一条缝"。
 *
 * 这里用 ResizeObserver 测量**工作区元素自身**的宽度，作为布局解析的输入。
 * JS 与 CSS 消费同一个结果，视觉稿的媒体查询不得独立再开关区域
 * （施工说明 §1.2 第 4 条）。
 */

import { useEffect, useRef, useState } from 'react';

/**
 * 观察某个元素的宽度。
 *
 * 首帧就要有正确值：用 `getBoundingClientRect()` 同步取一次，
 * 避免首帧按 0 计算导致布局闪成单区域。
 *
 * **测哪个元素很关键**：布局解析的输入必须是一个**不随布局决定而变**的量。
 * 例如"收起左导航"会改变工作区宽度 —— 若把工作区宽度当输入，
 * 就会形成 隐藏→变宽→判定不必隐藏→显示→变窄→再隐藏 的反馈环
 * （实测表现为 React "Maximum update depth exceeded"）。
 * 因此这里测的是 **`.app-body`**：它由视口决定，与导航是否收起无关。
 */
export function useElementWidth<T extends HTMLElement>(selector?: string) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 1200 : window.innerWidth,
  );

  useEffect(() => {
    /**
     * 解析要测量的元素。
     *
     * **必须每次测量时重新解析，不能在 effect 开头解析一次就退出。**
     * 早先写法是 `const el = ...; if (!el) return;` —— 如果 effect 执行时
     * 目标元素尚未挂载（或祖先关系还没建立），就直接 return，
     * 而依赖只有 `[selector]`，于是**永远不会再试**：
     * 宽度冻结在 useState 初值（window.innerWidth），
     * 后续任何窗口缩放都不再影响布局。
     * 实测表现：900px 窗口下布局仍按 ~1426px 计算，
     * 预览宽 661px 溢出容器 654px（自动隐藏侧栏与单区域切换都不触发）。
     */
    const resolveEl = () => {
      if (selector) {
        return (ref.current?.closest(selector)
          ?? document.querySelector(selector)) as HTMLElement | null;
      }
      return ref.current as HTMLElement | null;
    };

    const measure = () => {
      const el = resolveEl();
      if (!el) return false;
      const w = el.getBoundingClientRect().width;
      // 宽度为 0 说明还没布局完成；保持上一次有效值，不用 0 触发单区域闪动
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
      return true;
    };

    // 首帧同步测一次；若元素还没出现，下一帧重试（最多 20 帧）
    if (!measure()) {
      let tries = 0;
      const retry = () => {
        if (measure() || ++tries > 20) return;
        raf = window.requestAnimationFrame(retry);
      };
      let raf = window.requestAnimationFrame(retry);
      // 兜底清理：effect 卸载时取消未完成的探测
      var cancelRetry = () => window.cancelAnimationFrame(raf);
    }

    const ro = new ResizeObserver(() => measure());
    const el = resolveEl();
    if (el) ro.observe(el);
    /** 元素出现得比首帧晚时，也要挂上观察者（同样用 rAF 重试） */
    let observeTries = 0;
    let observeRaf = 0;
    const ensureObserved = () => {
      if (el) return;
      const now = resolveEl();
      if (now) { ro.observe(now); measure(); return; }
      if (++observeTries > 40) return;
      observeRaf = window.requestAnimationFrame(ensureObserved);
    };
    if (!el) ensureObserved();

    // 窗口缩放（含系统缩放/DPR 变化）也重测
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      if (cancelRetry) cancelRetry();
      if (observeRaf) window.cancelAnimationFrame(observeRaf);
    };
  }, [selector]);

  return { ref, width };
}
