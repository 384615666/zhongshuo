/**
 * 预览选型验证（2026-10-03）：Word/Excel 适用性烟测——kit（路线B）转换真 Word/Excel 样本。
 * 记录时延/页数/缺失字体；产物落 route-b/pdf/。
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitUrl = new URL('./route-b/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js', import.meta.url);
const { createConverter } = await import(kitUrl.href);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/preview-select');
const S = join(ROOT, 'samples');
const P = join(ROOT, 'route-b/pdf');
const out = { runs: [] };
const converter = await createConverter({ timeoutMs: 120_000 });
for (const [name, input, output] of [
  ['docx', join(S, 'word-sample.docx'), join(P, 'word-sample.pdf')],
  ['xlsx', join(S, 'excel-sample.xlsx'), join(P, 'excel-sample.pdf')],
]) {
  const t0 = Date.now();
  try {
    const r = await converter.render({ inputPath: input, outputPath: output });
    out.runs.push({ name, ok: true, ms: Date.now() - t0, backend: r.backend, missingFonts: r.missingFonts, pdfBytes: statSync(output).size });
  } catch (e) {
    out.runs.push({ name, ok: false, ms: Date.now() - t0, code: e && e.code, errorMessage: String(e && e.message || e) });
  }
}
await converter.dispose();
writeFileSync(join(ROOT, 'route-b/word-excel-metrics.json'), JSON.stringify(out, null, 2));
console.log('[word-excel-kit] ' + JSON.stringify(out.runs));
process.exit(0);
