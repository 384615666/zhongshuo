/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R189 四页视觉统一验证（隔离数据 + 假运行时；零真实模型、不打包、不安装）。
 *
 * 用户 2026-11-07 反馈：
 *  1) 四个页面（成员管理 / 任务看板 / 文件与 Git / 搜索与收藏）的项目卡片和标题样式不一致；
 *  2) 四个页面的顶部栏和搜索栏风格不一致。
 *
 * 本脚本断言的「统一口径」（已与用户确认）：
 *  - 顶部工具栏：四页都是同一条 .page-filters（灰底/1px 边框/8px 圆角/8px 10px 内边距/48px 高），
 *    位置与宽度一致，页签（文件/Git、搜索/收藏）在工具栏内部；
 *  - 搜索框：成员页与搜索页都用共享 .search-field（30px 高、同圆角/边框/内边距）；
 *  - 项目卡：四页 .project-card-name / .project-card-meta 字体一致、卡片同高，
 *    每张卡的小字行都有内容（成员=房间/成员数、看板=项数、文件/搜索=Git 类型）；
 *  - 左栏标题「项目」样式一致；工具栏与左栏标题顶部对齐。
 *
 * 用法：node scripts/capture-r189-ui.cjs [--run=name] [--only=a,b]
 * 产物：dist/r189-ui/<run>/（截图 + summary.json + checks）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg == null ? [] : onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runName = runArg == null
  ? 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r189-ui', runName);
const data = path.join(run, 'data');
// 夹具放在系统临时目录：避免 extra 项目被识别成公开仓库工作区（同 capture-r188 的说明）。
const workspace = path.join(os.tmpdir(), 'zs-r189-workspace', runName);
const project = path.join(workspace, '读书会筹备');
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r189-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

const scenesSource = String.raw`(() => {
  const m = window.r189Meta;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (check, label, timeout) => {
    const end = Date.now() + (timeout || 30000);
    while (Date.now() < end) { let ok = false; try { ok = !!check(); } catch { ok = false; } if (ok) return; await wait(80); }
    throw Error('等待超时：' + (label || ''));
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const textOf = (el) => (el == null ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
  const go = async (route) => { window.location.hash = '#' + route; await wait(1000); };
  const cs = (el, props) => {
    if (el == null) return null;
    const s = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = s[p];
    return out;
  };
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); };
  const TOOLBAR = ['backgroundColor','borderTopColor','borderTopWidth','borderTopLeftRadius','paddingTop','paddingLeft','paddingBottom','paddingRight','alignItems','gap','height'];
  const CARD_NAME = ['fontSize','fontWeight','color','lineHeight'];
  const CARD_META = ['fontSize','fontWeight','color','lineHeight'];

  const readPage = (name) => {
    const toolbar = q('.project-content > .page-filters');
    const card = q('.project-card');
    return {
      name,
      toolbarRect: rect(toolbar),
      toolbarStyle: cs(toolbar, TOOLBAR),
      toolbarOverflow: toolbar == null ? null : { scroll: toolbar.scrollWidth, client: toolbar.clientWidth },
      tabsInToolbar: toolbar != null && toolbar.querySelector('.thread-tabs') != null,
      tabHeights: toolbar == null ? [] : qa('.project-content > .page-filters .thread-tab').map((el) => Math.round(el.getBoundingClientRect().height)),
      controlHeights: toolbar == null ? [] : qa('.project-content > .page-filters .btn, .project-content > .page-filters .select, .project-content > .page-filters .search-field').map((el) => Math.round(el.getBoundingClientRect().height)),
      railTitle: { rect: rect(q('.project-rail-title')), style: cs(q('.project-rail-title'), ['fontSize','fontWeight','color','lineHeight']), text: textOf(q('.project-rail-title')) },
      cardRect: rect(card),
      cardNameStyle: cs(q('.project-card-name'), CARD_NAME),
      cardMetaStyle: cs(q('.project-card-meta'), CARD_META),
      cardMetas: qa('.project-card').map((el) => textOf(el.querySelector('.project-card-meta'))),
      cardCount: qa('.project-card').length,
      searchCount: qa('.search-field').length,
      searchStyle: cs(q('.search-field'), ['height','borderTopColor','borderTopLeftRadius','paddingLeft','backgroundColor']),
      memberSearchPresent: q('[data-zs-member-search]') != null,
      toolbarText: textOf(toolbar),
    };
  };

  window.run = async () => {
    const pages = {};
    await go('/project/' + m.projectId + '/members');
    await until(() => q('[data-zs-member-card]'), '成员卡');
    await wait(1200);
    pages.members = readPage('members');

    await go('/board');
    await until(() => q('[data-zs-task-id]'), '看板卡');
    await wait(900);
    pages.board = readPage('board');

    await go('/project/' + m.projectId + '/files');
    await until(() => q('[data-zs-files-topbar]'), '文件页工具栏');
    await wait(900);
    pages.files = readPage('files');

    await go('/library');
    await until(() => q('[data-zs-library]'), '搜索页');
    await wait(900);
    pages.library = readPage('library');

    // ── 1) 工具栏：四页同款 ──
    const names = ['members','board','files','library'];
    const base = pages.members;
    for (const n of names.slice(1)) {
      const p = pages[n];
      check('工具栏外观与成员页一致：' + n, JSON.stringify(p.toolbarStyle) === JSON.stringify(base.toolbarStyle), { got: p.toolbarStyle, expected: base.toolbarStyle });
      check('工具栏位置/尺寸与成员页一致：' + n, p.toolbarRect != null && p.toolbarRect.y === base.toolbarRect.y && p.toolbarRect.x === base.toolbarRect.x && p.toolbarRect.w === base.toolbarRect.w, { got: p.toolbarRect, expected: base.toolbarRect });
    }
    for (const n of names) {
      const p = pages[n];
      check('工具栏高度=48：' + n, p.toolbarRect != null && p.toolbarRect.h === 48, p.toolbarRect);
      check('工具栏无横向溢出：' + n, p.toolbarOverflow != null && p.toolbarOverflow.scroll <= p.toolbarOverflow.client + 2, p.toolbarOverflow);
      check('工具栏内控件均 30px：' + n, p.controlHeights.every((h) => h === 30), p.controlHeights);
      check('工具栏与左栏标题顶部对齐：' + n, p.toolbarRect != null && p.railTitle.rect != null && Math.abs(p.toolbarRect.y - p.railTitle.rect.y) <= 2, { toolbar: p.toolbarRect, title: p.railTitle.rect });
    }
    check('文件页页签在工具栏内', pages.files.tabsInToolbar);
    check('搜索页页签在工具栏内', pages.library.tabsInToolbar);
    check('工具栏内页签高 26px', [...pages.files.tabHeights, ...pages.library.tabHeights].every((h) => h === 26), { files: pages.files.tabHeights, library: pages.library.tabHeights });

    // ── 2) 搜索框：成员页与搜索页同款 ──
    check('成员页使用共享搜索框', pages.members.searchCount === 1 && pages.members.memberSearchPresent);
    check('搜索页使用共享搜索框', pages.library.searchCount === 1);
    check('两页搜索框样式一致', JSON.stringify(pages.members.searchStyle) === JSON.stringify(pages.library.searchStyle), { members: pages.members.searchStyle, library: pages.library.searchStyle });
    check('搜索框高 30px', pages.members.searchStyle != null && pages.members.searchStyle.height === '30px');

    // ── 3) 项目卡：字体/高度/小字行一致 ──
    for (const n of names.slice(1)) {
      check('项目卡名称字体一致：' + n, JSON.stringify(pages[n].cardNameStyle) === JSON.stringify(base.cardNameStyle));
      check('项目卡小字字体一致：' + n, JSON.stringify(pages[n].cardMetaStyle) === JSON.stringify(base.cardMetaStyle));
      check('项目卡高度一致：' + n, pages[n].cardRect != null && Math.abs(pages[n].cardRect.h - base.cardRect.h) <= 1, { got: pages[n].cardRect, expected: base.cardRect });
      check('左栏标题样式一致：' + n, JSON.stringify(pages[n].railTitle.style) === JSON.stringify(base.railTitle.style) && pages[n].railTitle.text === '项目');
    }
    check('每张项目卡都有小字行：members', pages.members.cardMetas.every((t) => t.length > 0) && pages.members.cardMetas.some((t) => t.includes('个房间')));
    check('每张项目卡都有小字行：board', pages.board.cardMetas.every((t) => t.length > 0) && pages.board.cardMetas.some((t) => t.includes('项')));
    check('文件页卡片小字=Git 类型', pages.files.cardMetas.every((t) => /Git 仓库|非 Git 目录/.test(t)), pages.files.cardMetas);
    check('搜索页卡片小字=Git 类型', pages.library.cardMetas.slice(1).every((t) => /Git 仓库|非 Git 目录/.test(t)), pages.library.cardMetas);
    check('「全部项目」卡小字：看板', pages.board.cardMetas[0].includes('侧栏可见项目') && pages.board.cardMetas[0].includes('共'), pages.board.cardMetas[0]);
    check('「全部项目」卡小字：搜索', pages.library.cardMetas[0] === '侧栏可见项目', pages.library.cardMetas[0]);

    // ── 4) 功能回归：搜索过滤 / 回车检索 / 看板工具栏 ──
    check('看板工具栏仍有计数/刷新/归档全部', pages.board.toolbarText.includes('共') && pages.board.toolbarText.includes('刷新') && pages.board.toolbarText.includes('归档全部'), pages.board.toolbarText);

    await go('/project/' + m.projectId + '/members');
    await until(() => q('[data-zs-member-search]'), '成员搜索框');
    const before = qa('[data-zs-member-card]').length;
    const input = q('[data-zs-member-search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '不存在的名字ZZZ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(400);
    const after = qa('[data-zs-member-card]').length;
    check('成员页搜索过滤仍生效', before > 0 && after === 0, { before, after });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);

    await go('/library');
    await until(() => q('[data-zs-library]'), '搜索页');
    const searchInput = q('.search-field-input');
    const beforeText = document.body.innerText;
    if (searchInput != null) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(searchInput, '读书会');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(1500);
    }
    const afterText = document.body.innerText;
    // 回车是否真的触发检索：初始空态（"输入关键词开始搜索"）必须消失，并出现结果/无命中/失败之一。
    const leftEmptyState = !afterText.includes('输入关键词开始搜索');
    const hasOutcome = qa('.card.tight').length > 0 || afterText.includes('本页没有命中') || afterText.includes('搜索失败') || afterText.includes('正在检索');
    check('搜索页回车仍触发检索（离开初始空态）', leftEmptyState && hasOutcome, { leftEmptyState, hasOutcome, cards: qa('.card.tight').length });

    return { ok: checks.every((c) => c.ok), checks, pages };
  };
})();`;

const preloadSource = String.raw`const { contextBridge } = require('electron');
const commands = [];
window_r189 = null;
try {
  // 记录渲染进程发出的命令：bridge 走 window.zs.command，这里包一层。
  const install = () => {
    if (window.r189Patched) return;
    if (!window.zs || typeof window.zs.command !== 'function') return;
    const original = window.zs.command;
    window.zs.command = async (envelope) => {
      try { commands.push({ method: envelope && envelope.method }); } catch {}
      return original(envelope);
    };
    window.r189Patched = true;
  };
  window.addEventListener('DOMContentLoaded', install);
  setInterval(install, 200);
  Object.defineProperty(window, 'r189Commands', { get: () => commands });
} catch (e) { /* preload 失败不阻断验证 */ }`;

const wrapperSource = String.raw`const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const PRELOAD = __PRELOAD__;
const OUT = __OUT__;
const RESULT = __RESULT__;
const ONLY = __ONLY__;
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
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r189-anim\\">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
      await js('window.r189Meta = ' + JSON.stringify(JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8'))));
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.run()');
      // 逐页截图（四页工具栏 + 左栏）
      const pid = JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8')).projectId;
      const shots = [['members','/project/' + pid + '/members'],['board','/board'],['files','/project/' + pid + '/files'],['library','/library']];
      let n = 1;
      for (const [name, route] of shots) {
        if (ONLY.length && ONLY.indexOf(name) < 0) { n += 1; continue; }
        await js('window.location.hash = ' + JSON.stringify('#' + route));
        await sleep(1500);
        try { const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, String(n).padStart(2,'0') + '-' + name + '.png'), shot.toPNG()); } catch (e) { console.error('shot fail ' + name + ' ' + e); }
        n += 1;
      }
      fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
      console.log('R189_RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks.length, failed: result.checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R189_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const scenesPath = path.join(run, 'r189-scenes.js');
fs.writeFileSync(scenesPath, scenesSource);
const preloadPath = path.join(run, 'r189-preload.cjs');
fs.writeFileSync(preloadPath, preloadSource);
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(scenesPath))
  .replace('__PRELOAD__', JSON.stringify(preloadPath))
  .replace('__OUT__', JSON.stringify(run))
  .replace('__RESULT__', JSON.stringify(path.join(run, 'result.json')))
  .replace('__ONLY__', JSON.stringify(only)));

(async () => {
  try {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed.cjs'), logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
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
    pages: result.pages || null,
    error: result.error || null,
  };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, processExit: summary.processExit, checks: summary.checks.length, failed: summary.failedChecks, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
