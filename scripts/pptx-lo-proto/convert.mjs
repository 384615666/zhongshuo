/**
 * 第三十九轮 §4.1：LibreOffice 无界面转换原型（PPTX→PDF）。
 * - soffice --headless --convert-to pdf，独立 UserInstallation profile（不抢占用户已开实例/
 *   不写用户配置）；独立临时 outdir；超时强杀进程树（可终止性——taskkill /T）。
 * - 度量：墙钟耗时、soffice 进程工作集峰值（轮询 Get-Process）、产物大小；逐样本记录。
 * - 输入仅 .pptx（宏容器 .pptm 不入——宏执行面如实验收后再谈）；样本媒体全部内嵌（无外部
 *   资源加载）。产物与元数据落 dist/desktop/pptx-lo-proto/out/。
 * 用法：node scripts/pptx-lo-proto/convert.mjs <sofficeDir> [sampleFile...]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/pptx-lo-proto');
const outDir = join(root, 'out');
mkdirSync(outDir, { recursive: true });

const sofficeDir = process.argv[2];
if (sofficeDir == null || !existsSync(join(sofficeDir, 'soffice.exe'))) {
  console.error('usage: node convert.mjs <含 soffice.exe 的目录> [sampleFile...]');
  process.exit(2);
}
const sampleFiles = process.argv.slice(3);
const samples = sampleFiles.length > 0 ? sampleFiles : readdirSync(join(root, 'samples')).filter((f) => f.endsWith('.pptx')).map((f) => join(root, 'samples', f));

const TIMEOUT_MS = 120_000;
const results = [];
for (const input of samples) {
  const caseName = basename(input, '.pptx');
  const caseOut = join(outDir, caseName);
  mkdirSync(caseOut, { recursive: true });
  const profileDir = join(caseOut, 'lo-profile');
  const t0 = Date.now();
  let peakWsKb = 0;
  const child = spawn(join(sofficeDir, 'soffice.exe'), [
    '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--convert-to', 'pdf:impress_pdf_Export', '--outdir', caseOut, input,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-400); });
  const wsTimer = setInterval(() => {
    const q = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-Process | Where-Object { $_.Name -in 'soffice.bin','soffice' } | Measure-Object WorkingSet64 -Maximum | Select-Object -ExpandProperty Maximum`], { encoding: 'utf8' });
    const n = Number((q.stdout ?? '').trim());
    if (Number.isFinite(n) && n > 0) peakWsKb = Math.max(peakWsKb, Math.round(n / 1024));
  }, 700);
  wsTimer.unref();
  const exit = await new Promise((resolveExit) => {
    const killer = setTimeout(() => {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
      resolveExit({ code: -1, timedOut: true });
    }, TIMEOUT_MS);
    child.once('exit', (code) => { clearTimeout(killer); resolveExit({ code, timedOut: false }); });
    child.once('error', (e) => { clearTimeout(killer); resolveExit({ code: -2, error: String(e) }); });
  });
  clearInterval(wsTimer);
  const pdfPath = join(caseOut, `${caseName}.pdf`);
  const ok = exit.code === 0 && existsSync(pdfPath);
  const entry = {
    sample: basename(input),
    ok,
    exitCode: exit.code,
    timedOut: exit.timedOut === true,
    ms: Date.now() - t0,
    peakWorkingSetKb: peakWsKb,
    pdfBytes: ok ? statSync(pdfPath).size : 0,
    stderrTail: stderrTail.slice(-200),
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
}
writeFileSync(join(outDir, 'convert-report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log('[convert] 报告 ->', join(outDir, 'convert-report.json'));
