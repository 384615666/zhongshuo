/**
 * 预览选型验证（2026-10-03）：路线B 边界复核（修正版）。
 * 上轮 abort 探针把 signal 误放进请求对象（被忽略）；正确签名=render(request, signal)。
 * 1) timeoutMs=300 冷路径 → 期望 code='timeout' 且产物被删。
 * 2) 冷路径 600ms abort、热路径 300ms abort → 观察真中断行为、产物删除与进程收拢。
 */
import { execSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitUrl = new URL('./route-b/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js', import.meta.url);
const { createConverter } = await import(kitUrl.href);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/preview-select');
const DECK = join(ROOT, 'samples/office-deck.pptx');
const PDF_DIR = join(ROOT, 'route-b/pdf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
const out = { probes: [] };

async function runAbort(label, warmup, abortAfterMs) {
  const converter = await createConverter({
    timeoutMs: 120_000,
    fontMetadataCacheDirectory: warmup ? undefined : false,
  });
  if (warmup) await converter.render({ inputPath: DECK, outputPath: join(PDF_DIR, `abort-warmup-${stamp}.pdf`) });
  const target = join(PDF_DIR, `abort-${label}-${stamp}.pdf`);
  const ctl = new AbortController();
  const t0 = Date.now();
  const p = converter.render({ inputPath: DECK, outputPath: target }, ctl.signal);
  let abortedAt = null;
  setTimeout(() => { abortedAt = Date.now() - t0; ctl.abort(new Error('zs-eval-abort')); }, abortAfterMs);
  let res = 'resolved';
  try { await p; } catch (e) { res = { name: e && e.name, code: e && e.code, message: String(e && e.message || e) }; }
  await sleep(2000);
  const procs = execSync('powershell -NoProfile -Command "@(Get-Process libreoffice-kit -ErrorAction SilentlyContinue).Count"').toString().trim();
  out.probes.push({
    label, warmup, abortAfterMs, abortedAtMs: abortedAt, result: res, wallMs: Date.now() - t0,
    outputExists: existsSync(target), outputBytes: existsSync(target) ? statSync(target).size : null,
    helpersAfter2s: procs,
  });
  await converter.dispose();
}

{
  const converter = await createConverter({ timeoutMs: 300, fontMetadataCacheDirectory: false });
  const target = join(PDF_DIR, 'probe-timeout.pdf');
  const t0 = Date.now();
  let res = 'resolved';
  try { await converter.render({ inputPath: DECK, outputPath: target }); }
  catch (e) { res = { name: e && e.name, code: e && e.code, message: String(e && e.message || e) }; }
  out.probes.push({ label: 'timeout300ms-cold', result: res, wallMs: Date.now() - t0, outputExists: existsSync(target) });
  await converter.dispose();
}
await runAbort('cold-600ms', false, 600);
await runAbort('warm-300ms', true, 300);

writeFileSync(join(ROOT, 'route-b/edge-metrics.json'), JSON.stringify(out, null, 2));
console.log('[route-b-edge] ' + JSON.stringify(out.probes));
process.exit(0);
