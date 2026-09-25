/**
 * shot-states.mjs —— 重拍「文件预览」状态稿（mimo 专属；出图方法与 shot.mjs 一致）
 * 用法：node shot-states.mjs
 * 输出：_shots/mimo-pv-{light|dark}-{1372|2000|1100|1100-chat}.png
 * 状态经查询参数直达：?state=file&file=…&view=…（body-mimo.html 内脚本处理）
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '_shots');
mkdirSync(outDir, { recursive: true });

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) { console.error('找不到 Chrome / Edge'); process.exit(1); }

const shots = [
  { W: 1372, H: 872, q: 'state=file',              tag: '1372' },     // 并排基准稿
  { W: 2000, H: 872, q: 'state=file',              tag: '2000' },     // 宽窗：对话内容列居中 + 预览
  { W: 1100, H: 872, q: 'state=file',              tag: '1100' },     // 窄窗切换：文件预览视图
  { W: 1100, H: 872, q: 'state=file&view=chat',    tag: '1100-chat' },// 窄窗切换：对话视图（含输入框）
];

for (const s of shots) {
  for (const theme of ['light', 'dark']) {
    const url = `file:///${here.replace(/\\/g, '/')}/mimo.html?${s.q}${theme === 'dark' ? '&theme=dark' : ''}`;
    const file = join(outDir, `mimo-pv-${theme}-${s.tag}.png`);
    try {
      await run(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${s.W},${s.H}`,
        '--virtual-time-budget=3000',
        `--screenshot=${file}`,
        url,
      ], { timeout: 60_000 });
      console.log(existsSync(file) ? `OK   mimo-pv-${theme}-${s.tag}` : `MISS mimo-pv-${theme}-${s.tag}`);
    } catch (e) {
      console.log(`FAIL mimo-pv-${theme}-${s.tag}: ${e.message.split('\n')[0]}`);
    }
  }
}
