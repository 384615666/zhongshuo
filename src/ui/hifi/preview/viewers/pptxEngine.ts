/**
 * PPTX 预览引擎（R69）：ZCode 同架构（packages/ui/src/presentation/pptxRendererPreviewEngine.ts
 * @29628c9）——`parseZipLazyMedia`→ `buildPresentation
 * ({lazySlides:true})`（按页惰性物化）→ 每页 `renderSlide` 挂载（缩略图/主舞台同引擎双用）。
 * 引擎库=众说 R40 已 vendored 的 @aiden0z/pptx-renderer 1.3.0（同一上游——ZCode 用 1.2.4），
 * 经 renderers.loadRendererPptx 的 URL 动态加载（应用图外独立加载，不重复进 bundle）。
 */
import { loadRendererPptx } from '../renderers';

export interface PptxPageSize { width: number; height: number }
export interface PptxRenderHandle { ready: Promise<void>; dispose(): void }
export interface PptxSlide { slidePath: string }
export interface PptxPresentationLike { width: number; height: number; slides: PptxSlide[] }

export interface PptxPreviewDocument {
  readonly pageCount: number;
  readonly pageSize: PptxPageSize;
  renderPage(pageIndex: number, container: HTMLElement): PptxRenderHandle;
  dispose(): void;
}

interface UpstreamSlideHandle { element: HTMLElement; ready: Promise<void>; dispose(): void }
interface UpstreamLib {
  parseZipLazyMedia(data: ArrayBuffer, limits?: unknown): Promise<unknown>;
  buildPresentation(files: unknown, opts?: { lazySlides?: boolean }): Promise<PptxPresentationLike>;
  renderSlide(presentation: PptxPresentationLike, slide: PptxSlide, opts?: Record<string, unknown>): UpstreamSlideHandle;
}

class Document implements PptxPreviewDocument {
  readonly pageCount: number;
  readonly pageSize: PptxPageSize;
  private readonly handles = new Set<PptxRenderHandle>();
  private disposed = false;
  constructor(private readonly lib: UpstreamLib, private readonly presentation: PptxPresentationLike) {
    this.pageCount = presentation.slides.length;
    this.pageSize = { width: presentation.width, height: presentation.height };
  }
  renderPage(pageIndex: number, container: HTMLElement): PptxRenderHandle {
    if (this.disposed) throw new Error('PptxPreviewDocument 已释放');
    const slide = this.presentation.slides[pageIndex];
    if (slide == null) throw new RangeError(`页码越界：${pageIndex}`);
    const upstream = this.lib.renderSlide(this.presentation, slide);
    container.append(upstream.element);
    let disposedOnce = false;
    const handle: PptxRenderHandle = {
      ready: upstream.ready,
      dispose: () => {
        if (disposedOnce) return;
        disposedOnce = true;
        upstream.dispose();
        upstream.element.remove();
        this.handles.delete(handle);
      },
    };
    this.handles.add(handle);
    return handle;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const h of [...this.handles]) h.dispose();
    this.handles.clear();
  }
}

/** 打开一份 PPTX 字节 → 每页可渲染文档（保留格式校验，按需加载页面与媒体）。 */
export async function openPptxDocument(data: ArrayBuffer): Promise<PptxPreviewDocument> {
  const lib = (await loadRendererPptx()) as unknown as UpstreamLib;
  const files = await lib.parseZipLazyMedia(data);
  const presentation = await lib.buildPresentation(files, { lazySlides: true });
  return new Document(lib, presentation);
}
