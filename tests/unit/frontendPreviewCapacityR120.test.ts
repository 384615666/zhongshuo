import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
const engineModule = '../../src/ui/hifi/preview/viewers/pptxEngine.ts';
const { openPptxDocument } = await import(engineModule);

const engine = vi.hoisted(() => ({ parseZipLazyMedia: vi.fn(), buildPresentation: vi.fn() }));
vi.mock('../../src/ui/hifi/preview/renderers', () => ({
  loadRendererPptx: async () => engine,
}));

describe('R120 frontend PPTX preview capacity', () => {
  it('passes a real ZIP over the former entry and per-entry byte limits to lazy parsing', async () => {
    const vendorPath = pathToFileURL(resolve('src/ui/vendor/pptx-renderer/aiden0z-pptx-renderer.browser.es.js')).href;
    const vendor = await import(vendorPath) as { parseZipLazyMedia: (data: ArrayBuffer) => Promise<unknown> };
    engine.parseZipLazyMedia.mockImplementation(vendor.parseZipLazyMedia);
    engine.buildPresentation.mockResolvedValue({ width: 960, height: 540, slides: [{ slidePath: 'ppt/slides/slide1.xml' }] });
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 4001; i += 1) files[`ppt/slides/slide${i}.xml`] = strToU8('<slide/>');
    files['ppt/media/large.bin'] = new Uint8Array(33 * 1024 * 1024);
    const zip = zipSync(files);
    const bytes = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
    const document = await openPptxDocument(bytes);
    expect(document.pageCount).toBe(1);
    expect(engine.parseZipLazyMedia).toHaveBeenCalledWith(bytes);
    expect(engine.buildPresentation).toHaveBeenCalledWith(expect.anything(), { lazySlides: true });
    document.dispose();
    await expect(openPptxDocument(new ArrayBuffer(12))).rejects.toThrow();
  });
});
