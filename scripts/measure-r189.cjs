/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R189 四页统一性测量（Lead 本机核对用，隔离数据；零真实模型）。
 * 量：四页（成员管理 / 任务看板 / 文件与 Git / 搜索与收藏）的
 *   ① 顶部工具栏 computed 样式是否一致（背景/边框/圆角/内边距/对齐）
 *   ② 项目卡（名称/小字行）字体与卡片高度是否一致、小字行是否都有内容
 *   ③ 搜索框（成员页 / 搜索页）是否同款
 * 用法：node scripts/measure-r189.cjs [--width=1360] [--height=900] [--run=name]
 * 产物：dist/r189-ui/<run>/（截图 + measure.json + summary.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const argOf = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found == null ? fallback : found.slice(name.length + 3);
};
const width = Number(argOf('width', '1360'));
const height = Number(argOf('height', '900'));
const runName = argOf('run', `r189-measure-${width}x${height}`);
const run = path.join(root, 'dist', 'r189-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(run, '工作区');
const project = path.join(workspace, '读书会筹备');
fs.rmSync(run, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(project, { recursive: true });

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

const measureSource = String.raw`(() => {
  window.measure = async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (check, label, timeout) => {
      const end = Date.now() + (timeout || 30000);
      while (Date.now() < end) { let ok = false; try { ok = !!check(); } catch { ok = false; } if (ok) return; await wait(80); }
      throw Error('wait timeout: ' + label);
    };
    const q = (sel) => document.querySelector(sel);
    const qa = (sel) => Array.from(document.querySelectorAll(sel));
    const textOf = (el) => (el == null ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
    const go = async (route) => { window.location.hash = '#' + route; await wait(900); };
    const style = (el, props) => {
      if (el == null) return null;
      const cs = getComputedStyle(el);
      const out = {};
      for (const p of props) out[p] = cs[p];
      return out;
    };
    const TOOLBAR_PROPS = ['backgroundColor','borderTopColor','borderTopWidth','borderTopLeftRadius','borderLeftColor','borderLeftWidth','paddingTop','paddingLeft','paddingBottom','paddingRight','alignItems','gap','height'];
    const CARD_PROPS = ['fontSize','fontWeight','color','lineHeight','fontFamily'];
    const out = { viewport: { w: window.innerWidth, h: window.innerHeight }, pages: {} };
    const meta = window.r189Meta;

    const readPage = (name) => {
      const toolbar = q('.project-content > .page-filters');
      const railTitle = q('.project-rail-title');
      const card = q('.project-card');
      const cardName = q('.project-card-name');
      const cardMeta = q('.project-card-meta');
      const search = q('.search-field');
      const tabsInToolbar = toolbar != null && toolbar.querySelector('.thread-tabs') != null;
      const controls = toolbar == null ? [] : Array.from(toolbar.querySelectorAll('.btn, .select, .search-field, .thread-tab, .input')).map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: el.className,
        h: Math.round(el.getBoundingClientRect().height),
      }));
      const toolbarRect = toolbar == null ? null : (() => { const r = toolbar.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })();
      const railTitleRect = railTitle == null ? null : (() => { const r = railTitle.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })();
      const cardRect = card == null ? null : (() => { const r = card.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })();
      out.pages[name] = {
        toolbarStyle: style(toolbar, TOOLBAR_PROPS),
        toolbarRect,
        railTitleStyle: style(railTitle, ['fontSize','fontWeight','color','lineHeight','paddingLeft']),
        railTitleRect,
        railTitleText: textOf(railTitle),
        tabsInToolbar,
        toolbarControls: controls,
        cardRect,
        cardNameStyle: style(cardName, CARD_PROPS),
        cardMetaStyle: style(cardMeta, CARD_PROPS),
        cardMetaTexts: qa('.project-card').slice(0, 4).map((el) => textOf(el.querySelector('.project-card-meta'))),
        searchStyle: style(search, ['height','borderRadius','borderTopColor','borderLeftColor','paddingLeft','backgroundColor']),
        searchCount: qa('.search-field').length,
        memberSearchPresent: q('[data-zs-member-search]') != null,
        toolbarOverflow: toolbar == null ? null : { scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth },
        toolbarChildren: toolbar == null ? [] : Array.from(toolbar.children).map((el) => {
          const r = el.getBoundingClientRect();
          return { cls: String(el.className), tag: el.tagName.toLowerCase(), h: Math.round(r.height), w: Math.round(r.width) };
        }),
      };
    };

    await go('/project/' + meta.projectId + '/members');
    await until(() => q('[data-zs-member-card]'), 'members cards');
    await wait(1200);
    readPage('members');

    await go('/board');
    await until(() => q('[data-zs-task-id]'), 'board cards');
    await wait(900);
    readPage('board');

    await go('/project/' + meta.projectId + '/files');
    await until(() => q('[data-zs-files-topbar]'), 'files toolbar');
    await wait(900);
    readPage('files');

    await go('/library');
    await until(() => q('[data-zs-library]'), 'library page');
    await wait(900);
    readPage('library');

    return out;
  };
})()`;

const wrapperSource = String.raw`const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const OUT = __OUT__;
const RESULT = __RESULT__;
const WIDTH = __WIDTH__;
const HEIGHT = __HEIGHT__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('browser-window-created', (_e, win) => {
  win.show = () => {};
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    try {
      win.setContentSize(WIDTH, HEIGHT);
      for (let i = 0; i < 160; i++) { if (await js('document.readyState === "complete" && document.body.innerText.length > 20')) break; await sleep(250); }
      await sleep(900);
      for (let i = 0; i < 160; i++) { if (await js('document.body.classList.contains("hifi-on")')) break; await sleep(250); }
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r189-anim\\">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
      await js('window.r189Meta = ' + JSON.stringify(JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8'))));
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.measure()');
      fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
      // 逐页截图
      const routes = [['members','/project/__P__/members'],['board','/board'],['files','/project/__P__/files'],['library','/library']];
      const pid = result.pages == null ? '' : JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8')).projectId;
      let n = 1;
      for (const [name, route] of routes) {
        await js('window.location.hash = ' + JSON.stringify('#' + route.replace('__P__', pid)));
        await sleep(1400);
        try { const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, String(n).padStart(2,'0') + '-' + name + '.png'), shot.toPNG()); } catch (e) { console.error('shot fail ' + name + ' ' + e); }
        n += 1;
      }
      console.log('MEASURE_OK');
    } catch (e) { console.error('MEASURE_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 300000).unref();`;

const measurePath = path.join(run, 'measure.js');
fs.writeFileSync(measurePath, measureSource);
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(measurePath))
  .replace('__OUT__', JSON.stringify(run))
  .replace('__RESULT__', JSON.stringify(path.join(run, 'measure.json')))
  .replace('__WIDTH__', String(width))
  .replace('__HEIGHT__', String(height)));

(async () => {
  try {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed.cjs'), logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('seed failed: ' + (seeded.stderr || seeded.stdout));
  } catch (error) { console.error(String(error)); process.exitCode = 1; return; }
  const electron = spawnSync(require('electron'), [wrapperPath], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  try {
    const m = JSON.parse(fs.readFileSync(path.join(run, 'measure.json'), 'utf8'));
    fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(m, null, 2));
    console.log(JSON.stringify(m, null, 2));
  } catch { console.error('no measure.json; see process.log'); process.exitCode = 1; }
})();
