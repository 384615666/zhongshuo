/**
 * shot.mjs —— 用本机 Chrome/Edge headless 重拍对照图（1372×872，与设计稿一致）
 * 三套方案统一方法出图，保证横向可比。输出到 _shots/。
 * 用法：node shot.mjs [mimo|kimi|hy4|all]
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '_shots');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) { console.error('找不到 Chrome / Edge'); process.exit(1); }

const which = process.argv[2] ?? 'all';
const W = parseInt(process.argv[3] ?? '1372', 10);
const H = parseInt(process.argv[4] ?? '872', 10);
const suffix = W === 1372 ? '' : `-${W}`;
const names = ['mimo', 'kimi', 'hy4'].filter((n) => which === 'all' || n === which);
const themes = ['light', 'dark'];

for (const name of names) {
  for (const theme of themes) {
    const url = `file:///${here.replace(/\\/g, '/')}/${name}.html` + (theme === 'dark' ? '?theme=dark' : '');
    const file = join(outDir, `${name}-${theme}${suffix}.png`);
    try {
      await run(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${W},${H}`,
        '--virtual-time-budget=3000',
        `--screenshot=${file}`,
        url,
      ], { timeout: 60_000 });
      console.log(existsSync(file) ? `OK   ${name}-${theme}${suffix}` : `MISS ${name}-${theme}${suffix}`);
    } catch (e) {
      console.log(`FAIL ${name}-${theme}${suffix}: ${e.message.split('\n')[0]}`);
    }
  }
}
