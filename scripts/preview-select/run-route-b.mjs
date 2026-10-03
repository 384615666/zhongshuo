/**
 * 预览选型验证（2026-10-03）：路线B 采集器。
 * @deepseek-ai/libreoffice-kit（0.1.5，win32-x64 原生引擎）PPTX→PDF：
 * 冷/热转换时延、helper 进程工作集峰值（轮询 Get-Process libreoffice-kit）、
 * 边界（损坏/超限/宏容器）、独立超时小闸、AbortSignal 取消后的进程与缓存清理核验。
 * 产物：dist/desktop/preview-select/route-b/pdf/*.pdf + metrics.json
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kitUrl = new URL('./route-b/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js', import.meta.url);
const { createConverter, ENGINE_VERSION, ENGINE_VERSIONS } = await import(kitUrl.href);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/preview-select');
const SAMPLES = join(ROOT, 'samples');
const OUT = join(ROOT, 'route-b');
const PDF_DIR = join(OUT, 'pdf');
mkdirSync(PDF_DIR, { recursive: true });

// ---- helper process memory sampler (KB per tick line)
const sampler = spawn('powershell', ['-NoProfile', '-Command',
  `while($true){ $p = Get-Process libreoffice-kit,soffice.bin,soffice -ErrorAction SilentlyContinue;`
  + ` if($p){ ($p | Measure-Object WorkingSet64 -Maximum).Maximum } else { 0 };`
  + ` Start-Sleep -Milliseconds 150 }`], { stdio: ['ignore', 'pipe', 'ignore'] });
let peakHelperKb = 0; let samplerBuf = '';
sampler.stdout.on('data', (d) => {
  samplerBuf += d.toString('utf8');
  const lines = samplerBuf.split(/\r?\n/);
  samplerBuf = lines.pop();
  for (const ln of lines) {
    const n = Number(ln.trim());
    if (Number.isFinite(n) && n > peakHelperKb) peakHelperKb = n;
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const metrics = { engineVersion: ENGINE_VERSION, engineVersions: ENGINE_VERSIONS, node: process.version, samples: {}, boundary: {}, timeout: {}, cancel: {}, cleanup: {} };
const abs = (p) => resolve(p);
async function timedRender(converter, inputPath, outputPath, extra) {
  const t0 = Date.now();
  try {
    const r = await converter.render({ inputPath: abs(inputPath), outputPath: abs(outputPath), ...extra });
    return { ok: true, ms: Date.now() - t0, backend: r.backend, missingFonts: r.missingFonts, pdfBytes: existsSync(outputPath) ? statSync(outputPath).size : null };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, code: e && e.code, errorName: e && e.name, errorMessage: String(e && e.message || e), outputExists: existsSync(outputPath) };
  }
}

let converter;
const t0 = Date.now();
converter = await createConverter({ timeoutMs: 120_000 });
metrics.createMs = Date.now() - t0;
metrics.converterBackend = converter.backend;

// ---- cold + warm + other decks
metrics.samples['office-deck.pptx'] = { cold: await timedRender(converter, join(SAMPLES, 'office-deck.pptx'), join(PDF_DIR, 'office-deck.cold.pdf')) };
metrics.samples['office-deck.pptx'].warm = await timedRender(converter, join(SAMPLES, 'office-deck.pptx'), join(PDF_DIR, 'office-deck.warm.pdf'));
metrics.samples['dense-deck.pptx'] = { cold: await timedRender(converter, join(SAMPLES, 'dense-deck.pptx'), join(PDF_DIR, 'dense-deck.pdf')) };
metrics.samples['rich-deck.pptx'] = { cold: await timedRender(converter, join(SAMPLES, 'rich-deck.pptx'), join(PDF_DIR, 'rich-deck.pdf')) };

// ---- boundary inputs
metrics.boundary.corrupt = await timedRender(converter, join(SAMPLES, 'bad/corrupt.pptx'), join(PDF_DIR, 'corrupt.pdf'));
metrics.boundary.huge = await timedRender(converter, join(SAMPLES, 'bad/huge.pptx'), join(PDF_DIR, 'huge.pdf'));
metrics.boundary.macroPptm = await timedRender(converter, join(SAMPLES, 'bad/macro-container.pptm'), join(PDF_DIR, 'macro-container.pdf'));
metrics.peakDuringRendersKb = peakHelperKb;

// ---- tiny-deadline converter: cold office-deck must hit timeout
{
  const c2 = await createConverter({ timeoutMs: 1200 });
  metrics.timeout.officeDeck1200ms = await timedRender(c2, join(SAMPLES, 'office-deck.pptx'), join(PDF_DIR, 'timeout.pdf'));
  await c2.dispose();
}

// ---- cancel: abort mid-render, then verify no helper processes and output removed
{
  const ctl = new AbortController();
  const p = converter.render({ inputPath: abs(join(SAMPLES, 'office-deck.pptx')), outputPath: abs(join(PDF_DIR, 'cancelled.pdf')), signal: ctl.signal });
  await sleep(400);
  ctl.abort();
  try { await p; metrics.cancel.result = 'resolved-unexpectedly'; }
  catch (e) { metrics.cancel.result = { name: e && e.name, code: e && e.code, message: String(e && e.message || e) }; }
  await sleep(2500);
  metrics.cancel.helperGoneAfter = execSync('powershell -NoProfile -Command "@(Get-Process libreoffice-kit,soffice.bin,soffice -ErrorAction SilentlyContinue).Count"').toString().trim();
  metrics.cancel.outputRemoved = !existsSync(join(PDF_DIR, 'cancelled.pdf'));
}

// ---- converter still usable after cancel; then dispose + cleanup check
metrics.cancel.postCancelRender = await timedRender(converter, join(SAMPLES, 'office-deck.pptx'), join(PDF_DIR, 'office-deck.postcancel.pdf'));
await converter.dispose();
await sleep(1000);
metrics.cleanup.processesAfterDispose = execSync('powershell -NoProfile -Command "@(Get-Process libreoffice-kit,soffice.bin,soffice -ErrorAction SilentlyContinue).Count"').toString().trim();
const cacheDir = join(process.env.LOCALAPPDATA || '', 'libreoffice-kit', 'Cache');
metrics.cleanup.cacheDir = existsSync(cacheDir) ? readdirSync(cacheDir) : 'absent';
metrics.cleanup.cacheDirPath = cacheDir;
sampler.kill();
metrics.peakHelperKbTotal = peakHelperKb;
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log('[route-b] OK ' + JSON.stringify({
  createMs: metrics.createMs,
  officeCold: metrics.samples['office-deck.pptx'].cold,
  officeWarm: metrics.samples['office-deck.pptx'].warm,
  dense: metrics.samples['dense-deck.pptx'].cold,
  rich: metrics.samples['rich-deck.pptx'].cold,
  peakKb: metrics.peakHelperKbTotal,
  boundary: { corrupt: metrics.boundary.corrupt.code || metrics.boundary.corrupt.ok, huge: metrics.boundary.huge.code || metrics.boundary.huge.ok, macro: metrics.boundary.macroPptm },
  timeout: metrics.timeout.officeDeck1200ms,
  cancel: metrics.cancel,
  cleanup: metrics.cleanup,
}));
process.exit(0);
