/**
 * 第三十九轮 §4.1：自写转换路线导出（buildPptxPages——现行产品实现）。
 * node --experimental-strip-types 运行（pptxPages.ts 仅依赖 node:crypto）。
 * 每样本导出 out/<case>/own-slides/slide-<n>.svg + meta.json。
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeUnzipWith } from '../../src/daemon/zipGuard.ts';
import { buildPptxPages } from '../../src/daemon/pptxPages.ts';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/pptx-lo-proto');
const samplesDir = join(root, 'samples');
const outDir = join(root, 'out');

for (const f of readdirSync(samplesDir).filter((x) => x.endsWith('.pptx'))) {
  const caseName = f.replace(/\.pptx$/, '');
  const raw = await (await import('node:fs')).promises.readFile(join(samplesDir, f));
  const files = safeUnzipWith(raw, { maxEntries: 1500, entryMax: 64 * 1024 * 1024, totalMax: 160 * 1024 * 1024 });
  const hash = createHash('sha256').update(raw).digest('hex');
  const pages = buildPptxPages(files, (name) => files[name], hash);
  const dir = join(outDir, caseName, 'own-slides');
  mkdirSync(dir, { recursive: true });
  for (const s of pages.slides) {
    writeFileSync(join(dir, `slide-${String(s.slide).padStart(2, '0')}.svg`), s.svg, 'utf8');
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schema: pages.schema, converterVersion: pages.converterVersion, pxW: pages.pxW, pxH: pages.pxH, slides: pages.slides.map((s) => ({ slide: s.slide, truncated: s.truncated, textTruncated: s.textTruncated, unsupported: s.unsupported, unsupportedKinds: s.unsupportedKinds, shapes: s.shapes, images: s.images })) }, null, 2));
  console.log(`[own-svg] ${caseName}: ${pages.slides.length} 页 -> ${dir}`);
}
