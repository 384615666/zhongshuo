/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R201 界面反馈回归（隔离数据 + 假运行时；零真实模型、不安装、不打包）。
 *
 * 覆盖用户 2026-11-08 第 8 轮 6 条：
 *  1. 侧栏「打开新的工作区」按钮 hover 底色与图标对齐（20×20、padding 0、图标居中）
 *  2. 该按钮 title/aria-label 只有「打开新的工作区」
 *  3. 标题栏不再有项目/切换工作区组件
 *  4. 命令面板不再显示「退出键 / 回车键」提示与按钮
 *  5. 对话串「最近活动 X 秒前」单行不换行，长活动文本省略
 *  6. `file:///` 本地文件只显示文件名；右键菜单可复制文件地址/默认程序打开
 *
 * 用法：node scripts/capture-r201-ui.cjs [--run=name]
 * 产物：dist/r201-ui/<run>/（截图 + result.json + summary.json + 日志）
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
const run = path.join(root, 'dist', 'r201-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r201-workspace', runName);
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r201-' + randomUUID(),
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
  const go = async (route) => { window.location.hash = '#' + route; await wait(1100); };
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1) }; };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const extra = {};

  window.run = async () => {
    await go('/library');
    await until(() => q('.sidebar') && q('[data-zs-library]'), '搜索与收藏页', 30000);
    await wait(700);

    // 1/2：工作区打开按钮
    const button = q('.side-heading-action');
    const icon = button?.querySelector('svg');
    const bs = button == null ? null : getComputedStyle(button);
    const bb = rect(button), ib = rect(icon);
    extra.workspaceButton = { button: bb, icon: ib, padding: bs == null ? null : [bs.paddingTop, bs.paddingRight, bs.paddingBottom, bs.paddingLeft], title: button?.getAttribute('title'), aria: button?.getAttribute('aria-label') };
    check('工作区按钮尺寸 20×20（不再被通用内边距撑成 24 宽）', bb != null && bb.w <= 20.5 && bb.h <= 20.5, bb);
    check('工作区按钮内边距清零（hover 底色与图标同心）', extra.workspaceButton.padding != null && extra.workspaceButton.padding.every((v) => parseFloat(v) === 0), extra.workspaceButton.padding);
    check('工作区按钮内图标水平居中', bb != null && ib != null && Math.abs((bb.x + bb.w / 2) - (ib.x + ib.w / 2)) <= 1, { bb, ib });
    check('工作区按钮 tooltip 只有「打开新的工作区」', extra.workspaceButton.title === '打开新的工作区' && extra.workspaceButton.aria === '打开新的工作区', extra.workspaceButton);

    // 3：标题栏去掉项目/切换工作区组件
    const titlebar = q('#zs-titlebar .zs-titlebar');
    extra.titlebar = { text: (titlebar?.innerText || '').trim(), projectButtons: qa('#zs-titlebar .zs-tb-project, #zs-titlebar [data-zs-project-menu-btn]').length, drag: q('#zs-titlebar .zs-tb-drag') != null };
    check('标题栏没有项目/切换工作区下拉', extra.titlebar.projectButtons === 0, extra.titlebar);
    check('标题栏仍显示品名「众说」', extra.titlebar.text.includes('众说'), extra.titlebar.text);
    check('标题栏拖动区保留', extra.titlebar.drag === true);

    // 4：命令面板去掉键盘提示按钮
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }));
    await until(() => q('[data-zs-palette="hifi"]'), '命令面板', 6000);
    await wait(300);
    const palette = q('[data-zs-palette="hifi"]');
    const paletteText = palette.innerText;
    const paletteInput = palette.querySelector('input');
    extra.palette = { text: paletteText.slice(0, 400), placeholder: paletteInput?.getAttribute('placeholder') ?? null };
    check('命令面板没有「退出键」提示', !paletteText.includes('退出键'), extra.palette);
    check('命令面板没有「回车键」按钮', !paletteText.includes('回车键'), extra.palette);
    check('命令面板 placeholder 不再写键盘提示', paletteInput != null && !/回车|退出/.test(extra.palette.placeholder || ''), extra.palette.placeholder);
    paletteInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);

    // 6：file:/// 本地文件链接
    await go('__THREAD_ROUTE__');
    await until(() => qa('[data-zs-local-file-link]').length >= 2, '本地文件链接', 20000);
    await wait(500);
    const links = qa('[data-zs-local-file-link]');
    const bodyText = q('.msg-list')?.innerText || '';
    extra.localFiles = { count: links.length, names: links.map((el) => (el.querySelector('.md-file-link-name')?.textContent || '').trim()), bodyHasFileUrl: bodyText.includes('file:///'), bodyHasBang: bodyText.includes('![') };
    check('两个 file:/// 链接都渲染成本地文件条目', links.length >= 2, extra.localFiles);
    check('本地文件条目只显示文件名', extra.localFiles.names.includes('示例 图片.png') && extra.localFiles.names.includes('说明 文档.txt'), extra.localFiles.names);
    check('正文不再露出 file:/// 原始地址', extra.localFiles.bodyHasFileUrl === false, extra.localFiles);
    const firstButton = links[0]?.querySelector('button');
    const fb = rect(firstButton);
    if (firstButton != null) {
      firstButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(fb.x + 8), clientY: Math.round(fb.y + 8) }));
      await until(() => qa('.menu .menu-item').some((el) => (el.textContent || '').includes('复制文件地址')), '右键文件菜单', 6000);
      const menuItems = qa('.menu .menu-item').map((el) => (el.textContent || '').trim());
      extra.localFiles.menu = menuItems.slice(0, 6);
      check('本地文件右键菜单含「复制文件地址」', menuItems.some((t) => t.includes('复制文件地址')), menuItems);
      check('本地文件右键菜单含「用默认程序打开」与「在文件管理器中显示」', menuItems.some((t) => t.includes('默认程序打开')) && menuItems.some((t) => t.includes('文件管理器中显示')), menuItems);
    } else {
      check('本地文件条目可右键', false);
    }
    window.__r201FirstPath = links[0]?.getAttribute('data-zs-local-file-link') || '';

    // 5：LiveProgress 单行样式（真实渲染时同一 CSS）
    const host = q('.msg-list') || q('.pool-list') || q('.thread-body') || q('main');
    let live = null;
    if (host != null) {
      live = document.createElement('div');
      live.className = 'panel live-progress';
      live.setAttribute('data-zs-live-progress', 'r201-probe');
      live.innerHTML = '<div class="row tight wrap live-progress-head"><span class="strong">Claude</span><span class="small faint">本轮已用时 01:48</span><span class="small faint">等待模型回应</span></div>'
        + '<div class="small live-progress-activity"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"></circle></svg><span class="live-progress-activity-text truncate">执行命令完成 · python -I - &lt;&lt;\'PY\' import os, hashlib d = r"C:\\Users\\LSJ\\Downloads\\新建文件夹\\images" for n in sorted(os.listdir(d)): print(n + os.path.getsize(os.path.join(d, n)))</span><span class="faint live-progress-ago">· 最近活动 11 秒前</span></div>';
      host.appendChild(live);
      await wait(120);
      const agoEl = live.querySelector('.live-progress-ago');
      const activityEl = live.querySelector('.live-progress-activity');
      const textEl = live.querySelector('.live-progress-activity-text');
      const agoStyle = getComputedStyle(agoEl), activityStyle = getComputedStyle(activityEl), textStyle = getComputedStyle(textEl);
      extra.liveCard = { ago: rect(agoEl), activity: rect(activityEl), text: rect(textEl), agoHeight: agoEl.offsetHeight, activityHeight: activityEl.offsetHeight, agoStyle: { whiteSpace: agoStyle.whiteSpace, width: agoStyle.width }, activityStyle: { flexWrap: activityStyle.flexWrap }, textStyle: { whiteSpace: textStyle.whiteSpace, overflow: textStyle.overflow, textOverflow: textStyle.textOverflow } };
      check('CSS：「最近活动」标签不换行', agoStyle.whiteSpace === 'nowrap', extra.liveCard);
      check('CSS：活动行不换行、长文本省略', activityStyle.flexWrap === 'nowrap' && textStyle.whiteSpace === 'nowrap' && textStyle.textOverflow === 'ellipsis', extra.liveCard);
      check('「最近活动」保持一行（高度不增加）', agoEl.offsetHeight <= 22 && activityEl.offsetHeight <= 26, extra.liveCard);
      check('长活动文本被省略（不撑高整行）', textEl.scrollWidth >= textEl.clientWidth && textEl.getBoundingClientRect().height <= 22, extra.liveCard);
    } else {
      check('找到可注入 LiveProgress 的容器', false);
    }

    return { ok: checks.every((c) => c.ok), checks, extra };
  };

  window.copyLocalFilePath = async () => {
    const items = qa('.menu .menu-item');
    const copy = items.find((el) => (el.textContent || '').includes('复制文件地址'));
    if (copy == null) throw Error('没有「复制文件地址」菜单项');
    copy.click();
    await wait(300);
    return window.__r201FirstPath;
  };
})();`;

const liveShotJs = `(() => { const host = document.querySelector(".msg-list") || document.querySelector(".pool-list") || document.querySelector(".thread-body") || document.querySelector("main"); const el = document.createElement("div"); el.className = "panel live-progress"; el.setAttribute("data-zs-live-progress", "r201-shot"); const head = document.createElement("div"); head.className = "row tight wrap live-progress-head"; [["strong","Claude"],["small faint","本轮已用时 01:48"],["small faint","等待模型回应"]].forEach(function(pair){ const s = document.createElement("span"); s.className = pair[0]; s.textContent = pair[1]; head.appendChild(s); }); const row = document.createElement("div"); row.className = "small live-progress-activity"; const svg = document.createElementNS("http://www.w3.org/2000/svg","svg"); svg.setAttribute("width","12"); svg.setAttribute("height","12"); svg.setAttribute("viewBox","0 0 24 24"); svg.setAttribute("fill","none"); svg.setAttribute("stroke","currentColor"); svg.setAttribute("stroke-width","1.8"); const circle = document.createElementNS("http://www.w3.org/2000/svg","circle"); circle.setAttribute("cx","12"); circle.setAttribute("cy","12"); circle.setAttribute("r","9"); svg.appendChild(circle); const activity = document.createElement("span"); activity.className = "live-progress-activity-text truncate"; activity.textContent = "执行命令完成 · python -I - <<'" + "PY" + "' import os, hashlib d = r\\"C:\\\\Users\\\\LSJ\\\\Downloads\\\\新建文件夹\\\\images\\" for n in sorted(os.listdir(d)): print(n + os.path.getsize(os.path.join(d, n)))"; const ago = document.createElement("span"); ago.className = "faint live-progress-ago"; ago.textContent = "· 最近活动 11 秒前"; row.appendChild(svg); row.appendChild(activity); row.appendChild(ago); el.appendChild(head); el.appendChild(row); host.appendChild(el); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`;
const liveRemoveJs = '(() => { document.querySelector(`[data-zs-live-progress="r201-shot"]`)?.remove(); })()';
const wrapperSource = String.raw`const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const OUT = __OUT__;
const RESULT = __RESULT__;
const THREAD_ROUTE = __THREAD_ROUTE__;
const LIVE_JS = __LIVE_JS__;
const LIVE_REMOVE_JS = __LIVE_REMOVE_JS__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const readClipText = async () => { try { return String((await clipboard.readText()) ?? ''); } catch { return ''; } };
app.on('browser-window-created', (_e, win) => {
  win.show = () => {};
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    try {
      win.setContentSize(1360, 900);
      for (let i = 0; i < 160; i++) { if (await js('document.readyState === "complete" && document.body.innerText.length > 20')) break; await sleep(250); }
      await sleep(900);
      for (let i = 0; i < 160; i++) { if (await js('document.body.classList.contains("hifi-on")')) break; await sleep(250); }
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r201-anim\\">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.run()');
      const checks = result.checks;
      const extra = result.extra;

      // 截图 1：侧栏工作区标题 + 监听 hover 状态
      await js('window.location.hash = "#/library"');
      await sleep(1400);
      await js('(() => { const cards = Array.from(document.querySelectorAll("[data-zs-library-project]")); if (cards[0]) cards[0].click(); return cards.length; })()');
      await sleep(900);
      try { fs.writeFileSync(path.join(OUT, '01-sidebar-heading.png'), (await win.webContents.capturePage({ x: 0, y: 200, width: 246, height: 80 })).toPNG()); } catch (e) { console.error('shot sidebar fail ' + e); }
      try {
        const box = await js('(() => { const b = document.querySelector(".side-heading-action"); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, rx: r.x, ry: r.y, w: r.width, h: r.height }; })()');
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x), y: Math.round(box.y) });
        await sleep(600);
        const hover = await js('(() => { const b = document.querySelector(".side-heading-action"); const s = getComputedStyle(b); const r = b.getBoundingClientRect(); const i = b.querySelector("svg").getBoundingClientRect(); return { bg: s.backgroundColor, border: s.borderColor, box: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }, iconCenter: +(i.x + i.width / 2).toFixed(1), boxCenter: +(r.x + r.width / 2).toFixed(1) }; })()');
        extra.hover = hover;
        checks.push({ name: 'hover 底色出现在按钮盒内且与图标同心', ok: hover.bg !== 'rgba(0, 0, 0, 0)' && Math.abs(hover.iconCenter - hover.boxCenter) <= 1, detail: hover });
        fs.writeFileSync(path.join(OUT, '02-workspace-hover.png'), (await win.webContents.capturePage({ x: Math.max(0, Math.round(box.rx - 16)), y: Math.max(0, Math.round(box.ry - 14)), width: 60, height: 52 })).toPNG());
      } catch (e) { console.error('hover fail ' + e); }

      // 截图：标题栏
      try { fs.writeFileSync(path.join(OUT, '03-titlebar.png'), (await win.webContents.capturePage({ x: 0, y: 0, width: 1360, height: 40 })).toPNG()); } catch (e) { console.error('shot titlebar fail ' + e); }

      // 截图：命令面板
      try {
        await js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }))');
        await sleep(500);
        fs.writeFileSync(path.join(OUT, '04-palette.png'), (await win.webContents.capturePage({ x: 240, y: 60, width: 880, height: 420 })).toPNG());
        await js('document.querySelector("[data-zs-palette=\\"hifi\\"] input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
        await sleep(400);
      } catch (e) { console.error('shot palette fail ' + e); }

      // 截图：本地文件链接 + 右键菜单 + 剪贴板
      try {
        await js('window.location.hash = "#" + ' + JSON.stringify(THREAD_ROUTE));
        await sleep(1800);
        fs.writeFileSync(path.join(OUT, '05-local-file-links.png'), (await win.webContents.capturePage({ x: 700, y: 120, width: 660, height: 420 })).toPNG());
        const first = await js('(() => { const b = document.querySelector("[data-zs-local-file-link] button"); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(r.x + 8), clientY: Math.round(r.y + 8) })); return { x: r.x, y: r.y }; })()');
        await sleep(500);
        fs.writeFileSync(path.join(OUT, '06-local-file-menu.png'), (await win.webContents.capturePage({ x: Math.max(0, Math.round(first.x - 60)), y: Math.max(0, Math.round(first.y - 20)), width: 520, height: 300 })).toPNG());
        clipboard.clear();
        const expected = await js('window.copyLocalFilePath()');
        await sleep(300);
        const copied = await readClipText();
        extra.clipboard = { expected, copied };
        checks.push({ name: '右键「复制文件地址」复制到绝对路径', ok: expected !== '' && copied.includes(expected), detail: extra.clipboard });
      } catch (e) { console.error('local file fail ' + e); }

      // 截图：LiveProgress 单行（场景里已量过真实 CSS；这里重新注入一份用于截图）
      try {
        await js('window.location.hash = "#" + ' + JSON.stringify(THREAD_ROUTE));
        await sleep(1500);
        const box = await js(LIVE_JS);
        await sleep(200);
        fs.writeFileSync(path.join(OUT, '07-live-progress.png'), (await win.webContents.capturePage({ x: Math.max(0, Math.round(box.x)), y: Math.max(0, Math.round(box.y)), width: Math.round(box.w), height: 120 })).toPNG());
        await js(LIVE_REMOVE_JS);
      } catch (e) { console.error('shot live progress fail ' + e); }

      const finalResult = { ok: checks.every((c) => c.ok), checks, extra };
      fs.writeFileSync(RESULT, JSON.stringify(finalResult, null, 2));
      console.log('R201_RESULT ' + JSON.stringify({ ok: finalResult.ok, checks: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R201_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const scenesPath = path.join(run, 'r201-scenes.js');
const wrapperPath = path.join(run, 'main.cjs');

(async () => {
  let route;
  try {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed.cjs'), logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project, '--r192'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败：' + (seeded.stderr || seeded.stdout));

    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r201-extra.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed-extra.cjs'), logLevel: 'silent',
    });
    const extraSeed = spawnSync(process.execPath, [path.join(run, 'seed-extra.cjs'), data, project], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed-extra.log'), (extraSeed.stdout || '') + '\n' + (extraSeed.stderr || ''));
    if (extraSeed.status !== 0) throw Error('本地文件夹具装载失败：' + (extraSeed.stderr || extraSeed.stdout));
    const meta = JSON.parse(fs.readFileSync(path.join(data, 'r201-extra.json'), 'utf8'));
    route = `/project/${meta.projectId}/room/${meta.roomId}?thread=${meta.threadId}`;
    fs.writeFileSync(path.join(run, 'r201-scenes.js'), scenesSource.replace('__THREAD_ROUTE__', route));
    fs.writeFileSync(wrapperPath, wrapperSource
      .replace('__MAIN__', JSON.stringify(mainCjs))
      .replace('__SCENES__', JSON.stringify(scenesPath))
      .replace('__OUT__', JSON.stringify(run))
      .replace('__RESULT__', JSON.stringify(path.join(run, 'result.json')))
      .replace('__THREAD_ROUTE__', JSON.stringify(route))
      .replace('__LIVE_JS__', JSON.stringify(liveShotJs))
      .replace('__LIVE_REMOVE_JS__', JSON.stringify(liveRemoveJs)));
  } catch (error) {
    console.error(String(error));
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ok: false, error: String(error), checks: [] }, null, 2));
    process.exitCode = 1;
    return;
  }
  const electron = spawnSync(require('electron'), [wrapperPath], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8')); } catch { result = { ok: false, error: '未产出 result.json（见 process.log）', checks: [] }; }
  const summary = {
    ok: electron.status === 0 && result.ok === true && result.error == null,
    processExit: electron.status,
    run: path.relative(root, run),
    checks: result.checks || [],
    failedChecks: (result.checks || []).filter((c) => !c.ok).map((c) => c.name),
    extra: result.extra || null,
    error: result.error ?? null,
  };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, checks: summary.checks.length, failed: summary.failedChecks, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
