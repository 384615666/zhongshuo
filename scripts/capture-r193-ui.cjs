/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R193 侧栏对齐回归（隔离数据 + 假运行时；零真实模型、不安装、不打包）。
 *
 * 背景：老界面 renderer/style.css 里也有一条 `.sidebar`（padding:12px / gap:10px），
 * 与 hifi 侧栏同时加载、类名相同。hifi 的 `.sidebar` 没有声明 padding/gap，
 * 于是整个侧栏被旧规则内缩 12px：选中竖条离开窗口左缘、名称可用宽度少 24px、
 * 三段多 10px 间距。本脚本在**真实 index.html 组合**（同时加载 legacy 样式）里断言：
 *  - .sidebar 的 padding/gap 为 0（旧规则不再命中）
 *  - 顶部导航 / 项目树 / 房间 / 底部设置的全部图标落在 x=32 同一条竖线
 *  - 项目名与房间名同为 x=53，导航名/设置名为 x=54
 *  - 选中竖条贴侧栏左缘（item.x=8 + ::before.left=-8 = 0），宽 3px
 *  - 没有行溢出侧栏右缘
 *
 * 用法：node scripts/capture-r193-ui.cjs [--run=name]
 * 产物：dist/r193-ui/<run>/（截图 + summary.json）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runName = runArg == null
  ? 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r193-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r193-workspace', runName);
const project = path.join(workspace, '读书会筹备');
fs.rmSync(run, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const mainCjs = path.join(root, 'dist', 'ui', 'main.cjs');
if (!fs.existsSync(mainCjs)) { console.error('缺少 dist/ui/main.cjs：请先运行 node scripts/build-ui.mjs'); process.exit(2); }

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data,
  ZS_RUNTIME: 'fake',
  ZS_ALLOW_FAKE: '1',
  ZS_REAL_DISPATCH_GUARD: '1',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r193-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

const scenesSource = String.raw`(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (check, label, timeout) => {
    const end = Date.now() + (timeout || 30000);
    while (Date.now() < end) { let ok = false; try { ok = !!check(); } catch { ok = false; } if (ok) return; await wait(80); }
    throw Error('等待超时：' + (label || ''));
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const go = async (route) => { window.location.hash = '#' + route; await wait(1000); };
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1) }; };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const near = (a, b, tolerance = 0.6) => typeof a === 'number' && Math.abs(a - b) <= tolerance;
  const extra = {};

  window.run = async () => {
    await go('/library');
    await until(() => q('.sidebar') && q('[data-zs-library]'), '搜索与收藏页', 30000);
    await wait(900);

    const sidebar = q('.sidebar');
    const sb = getComputedStyle(sidebar);
    const sidebarBox = rect(sidebar);
    extra.sidebar = { box: sidebarBox, padding: [sb.paddingTop, sb.paddingRight, sb.paddingBottom, sb.paddingLeft], gap: [sb.rowGap, sb.columnGap] };
    check('侧栏宽度 246px', sidebarBox.w === 246, sidebarBox.w);
    check('老界面的 .sidebar padding 不再泄漏（四边为 0）',
      [sb.paddingTop, sb.paddingRight, sb.paddingBottom, sb.paddingLeft].every((v) => parseFloat(v) === 0),
      [sb.paddingTop, sb.paddingRight, sb.paddingBottom, sb.paddingLeft]);
    check('老界面的 .sidebar gap 不再泄漏（为 0）',
      [sb.rowGap, sb.columnGap].every((v) => v === 'normal' || parseFloat(v) === 0),
      [sb.rowGap, sb.columnGap]);

    const navItems = qa('.sidebar-top .side-item');
    const navIcons = navItems.map((el) => rect(el.querySelector('svg')));
    const navLabels = navItems.map((el) => rect(el.querySelector('.side-item-label')));
    extra.nav = { items: navItems.length, icons: navIcons, labels: navLabels };
    check('顶部 5 个导航入口齐全', navItems.length === 5, navItems.length);
    check('顶部导航图标都在 x=32', navIcons.length === 5 && navIcons.every((r) => near(r.x, 32)), navIcons.map((r) => r.x));
    check('顶部导航名称都在 x=54', navLabels.length === 5 && navLabels.every((r) => near(r.x, 54)), navLabels.map((r) => r.x));

    const footerItem = q('.sidebar-foot > .side-item');
    const footerIcon = rect(footerItem.querySelector('svg'));
    const footerLabel = rect(footerItem.querySelector('.side-item-label'));
    extra.footer = { icon: footerIcon, label: footerLabel };
    check('底部「设置」图标在 x=32', near(footerIcon.x, 32), footerIcon.x);
    check('底部「设置」名称在 x=54', near(footerLabel.x, 54), footerLabel.x);

    const projectRow = q('.sidebar .side-project > .side-row');
    const projectIcon = rect(projectRow.querySelector('.side-item-label-btn svg'));
    const projectLabel = rect(projectRow.querySelector('.side-item-label'));
    const rowStyle = getComputedStyle(projectRow);
    const labelBtnStyle = getComputedStyle(projectRow.querySelector('.side-item-label-btn'));
    extra.project = { icon: projectIcon, label: projectLabel, rowGap: rowStyle.columnGap, labelBtnPaddingLeft: labelBtnStyle.paddingLeft };
    check('项目图标在 x=32', near(projectIcon.x, 32), projectIcon.x);
    check('项目名在 x=53', near(projectLabel.x, 53), projectLabel.x);
    check('项目行 gap 归零、名称按钮左内边距归零',
      (rowStyle.columnGap === 'normal' || parseFloat(rowStyle.columnGap) === 0) && parseFloat(labelBtnStyle.paddingLeft) === 0,
      [rowStyle.columnGap, labelBtnStyle.paddingLeft]);

    const rooms = qa('.sidebar .side-item.sub');
    const roomIcon = rooms.length > 0 ? rect(rooms[0].firstElementChild) : null;
    const roomLabel = rooms.length > 0 ? rect(rooms[0].querySelector('.side-item-label')) : null;
    const roomPadLeft = rooms.length > 0 ? getComputedStyle(rooms[0]).paddingLeft : null;
    extra.rooms = { count: rooms.length, icon: roomIcon, label: roomLabel, paddingLeft: roomPadLeft };
    check('至少有一个房间行（夹具已展开项目）', rooms.length > 0, rooms.length);
    check('房间状态位/图标位在 x=32', near(roomIcon?.x, 32), roomIcon?.x);
    check('房间名与项目名同列（x=53）', near(roomLabel?.x, 53), roomLabel?.x);
    check('房间行 padding-left=12px（旧注释的 13/16 不再使用）', parseFloat(roomPadLeft) === 12, roomPadLeft);

    const iconXs = [...navIcons.map((r) => r.x), footerIcon.x, projectIcon.x, roomIcon?.x].filter((v) => typeof v === 'number');
    extra.iconXs = iconXs;
    check('全部图标落在同一条 x=32 竖线', iconXs.length >= 8 && iconXs.every((v) => near(v, 32)), iconXs);

    const active = q('.sidebar .side-item.active');
    const activeBox = rect(active);
    const before = getComputedStyle(active, '::before');
    const barX = +(activeBox.x + parseFloat(before.left)).toFixed(1);
    extra.active = { box: activeBox, beforeLeft: before.left, beforeWidth: before.width, barX, backgroundImage: getComputedStyle(active).backgroundImage.slice(0, 80) };
    check('当前页入口有选中态（渐变底）', getComputedStyle(active).backgroundImage.includes('linear-gradient'), extra.active.backgroundImage);
    check('选中竖条宽 3px', parseFloat(before.width) === 3, before.width);
    check('选中竖条左缘 = 侧栏 x=0（不再被 12px 内边距推进来）', near(barX, 0), barX);

    const wsHead = q('.sidebar-workspace-head');
    const wsHeading = wsHead?.querySelector('.side-heading');
    const wsOpen = wsHead?.querySelector('[data-zs-open-project="hifi"]');
    const legacyOpen = q('.sidebar-scroll > .side-item[data-zs-open-project]');
    extra.workspace = {
      text: (wsHeading?.textContent || '').trim(),
      openButton: wsOpen != null,
      icon: wsOpen?.querySelector('svg') != null,
      insideScroll: wsHead?.closest('.sidebar-scroll') != null,
      headingBottom: wsHead == null ? null : +wsHead.getBoundingClientRect().bottom.toFixed(1),
      scrollTop: q('.sidebar-scroll')?.getBoundingClientRect().top ?? null,
    };
    check('侧栏标题为「工作区」', (wsHeading?.textContent || '').includes('工作区'), extra.workspace.text);
    check('工作区标题在滚动区之外（固定）', wsHead != null && wsHead.closest('.sidebar-scroll') === null && extra.workspace.headingBottom <= extra.workspace.scrollTop + 0.5, extra.workspace);
    check('工作区标题右侧有打开/切换按钮（含图标）', wsOpen != null && wsOpen.querySelector('svg') != null, extra.workspace);
    check('旧的底部「打开/切换项目」入口已移除', legacyOpen == null);

    const scroll = q('.sidebar-scroll');
    const headTopBefore = wsHead.getBoundingClientRect().top;
    const oldFlex = scroll.style.flex, oldMaxHeight = scroll.style.maxHeight;
    let scrolled = 0, headTopAfter = headTopBefore;
    try {
      scroll.style.flex = 'none';
      scroll.style.maxHeight = '140px';
      scroll.scrollTop = 99999;
      await wait(150);
      scrolled = scroll.scrollTop;
      headTopAfter = wsHead.getBoundingClientRect().top;
    } finally {
      scroll.scrollTop = 0;
      scroll.style.flex = oldFlex;
      scroll.style.maxHeight = oldMaxHeight;
      await wait(80);
    }
    extra.workspace.scrollCheck = { scrolled, headTopBefore, headTopAfter };
    check('项目列表滚动时工作区标题不动', scrolled > 0 && Math.abs(headTopAfter - headTopBefore) <= 0.5, extra.workspace.scrollCheck);

    const rows = qa('.sidebar .side-item, .sidebar .side-row');
    const overflow = rows.filter((el) => rect(el).right > sidebarBox.right + 0.5).map((el) => ({ cls: el.className, right: rect(el).right }));
    extra.overflow = overflow;
    check('所有行不溢出侧栏右缘', overflow.length === 0, overflow);

    return { ok: checks.every((c) => c.ok), checks, extra };
  };
})();`;

const wrapperSource = String.raw`const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const OUT = __OUT__;
const RESULT = __RESULT__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('browser-window-created', (_e, win) => {
  win.show = () => {};
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    try {
      win.setContentSize(1360, 900);
      for (let i = 0; i < 160; i++) { if (await js('document.readyState === "complete" && document.body.innerText.length > 20')) break; await sleep(250); }
      await sleep(900);
      for (let i = 0; i < 160; i++) { if (await js('document.body.classList.contains("hifi-on")')) break; await sleep(250); }
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r193-anim\\">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.run()');
      await js('window.location.hash = "#/library"');
      await sleep(1400);
      try {
        await js('(() => { const cards = Array.from(document.querySelectorAll("[data-zs-library-project]")); if (cards[0]) cards[0].click(); return cards.length; })()');
        await sleep(1200);
      } catch (e) { console.error('shot select project fail ' + e); }
      try { fs.writeFileSync(path.join(OUT, '01-library.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot library fail ' + e); }
      try { fs.writeFileSync(path.join(OUT, '02-sidebar.png'), (await win.webContents.capturePage({ x: 0, y: 38, width: 246, height: 862 })).toPNG()); } catch (e) { console.error('shot sidebar fail ' + e); }
      fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
      console.log('R193_RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks.length, failed: result.checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R193_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const scenesPath = path.join(run, 'r193-scenes.js');
fs.writeFileSync(scenesPath, scenesSource);
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(scenesPath))
  .replace('__OUT__', JSON.stringify(run))
  .replace('__RESULT__', JSON.stringify(path.join(run, 'result.json'))));

(async () => {
  try {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed.cjs'), logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project, '--r192'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败：' + (seeded.stderr || seeded.stdout));
  } catch (error) {
    console.error(String(error));
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ok: false, error: String(error) }, null, 2));
    process.exitCode = 1;
    return;
  }
  const electron = spawnSync(require('electron'), [wrapperPath], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8')); } catch { result = { ok: false, error: '未产出 result.json（见 process.log）' }; }
  const summary = {
    ok: electron.status === 0 && result.ok === true,
    processExit: electron.status,
    run: path.relative(root, run),
    checks: result.checks || [],
    failedChecks: (result.checks || []).filter((c) => !c.ok).map((c) => c.name),
    extra: result.extra || null,
    error: result.error || null,
  };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, processExit: summary.processExit, checks: summary.checks.length, failed: summary.failedChecks, extra: summary.extra, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
