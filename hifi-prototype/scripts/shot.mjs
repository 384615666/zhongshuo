/**
 * 逐页截图脚本（使用本机已安装的 Chrome headless，不引入额外依赖）。
 *
 * 用法：
 *   pnpm run preview --port 5281        # 另开一个终端
 *   node scripts/shot.mjs http://localhost:5281
 *
 * 输出到 screenshots/<name>.png，命名与路由一一对应，便于评审时对照。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots');
const base = process.argv[2] ?? 'http://localhost:5281';
const theme = process.argv[3] ?? 'light';
const only = process.argv[4];

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const ROUTES = [
  ['01-welcome', '/welcome'],
  ['02-project-home', '/project/proj_zs_01'],
  ['03-room-pool', '/project/proj_zs_01/room/room_dev_hall'],
  ['04-thread-deliberate', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12'],
  ['05-thread-direct', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t13'],
  ['06-thread-auto', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14'],
  ['07-thread-discussion', '/project/proj_zs_01/room/room_dev_hall?thread=thread_d1'],
  ['08-thread-delivered', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t11'],
  ['09-activity', '/activity'],
  ['10-saved', '/saved'],
  ['11-tasks-board', '/tasks'],
  ['12-task-detail', '/task/task_12'],
  ['13-deliberation', '/deliberation/run_12_deliberate'],
  ['14-run-detail', '/run/run_12_deliberate'],
  ['15-artifact-report', '/artifact/artifact_12_team_report'],
  ['16-changes-diff', '/project/proj_zs_01/changes'],
  ['17-members', '/members'],
  ['18-member-detail', '/member/member_codex'],
  ['19-runtimes', '/runtimes'],
  ['20-settings-general', '/settings'],
  ['21-dm', '/dm/member_claude'],
  ['22-project-missing', '/project/proj_docs_03'],
];

/** 需要弹窗本身的画面：不带 recovery=0，用真实交互态出图 */
const OVERLAY_ROUTES = [
  ['23-recovery-check', '/welcome'],
];

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('找不到 Chrome / Edge，无法截图。');
  process.exit(1);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const list = only ? ROUTES.filter(([, r]) => r.includes(only)) : ROUTES;
let ok = 0;

for (const [name, route] of list) {
  const sep = route.includes('?') ? '&' : '?';
  // recovery=0：截图时不让启动恢复弹窗盖住页面本身（顶部栏入口仍可见）
  const params = [`recovery=0`];
  if (theme === 'dark') params.push('theme=dark');
  const url = `${base}/#${route}${sep}${params.join('&')}`;
  const file = join(outDir, `${name}${theme === 'dark' ? '-dark' : ''}.png`);
  try {
    await run(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=1680,1050',
        '--virtual-time-budget=5000',
        `--screenshot=${file}`,
        url,
      ],
      { timeout: 60_000 },
    );
    if (existsSync(file)) {
      ok += 1;
      console.log(`OK   ${name.padEnd(24)} ${url}`);
    } else {
      console.log(`MISS ${name}`);
    }
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

console.log(`\n完成 ${ok}/${list.length} → ${outDir}`);

// 额外拍一张带弹窗的画面（不加 recovery=0）
for (const [name, route] of OVERLAY_ROUTES) {
  const url = `${base}/#${route}`;
  const file = join(outDir, `${name}.png`);
  try {
    await run(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--window-size=1680,1050',
        '--virtual-time-budget=5000',
        `--screenshot=${file}`,
        url,
      ],
      { timeout: 60_000 },
    );
    if (existsSync(file)) console.log(`OK   ${name.padEnd(24)} ${url}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}
