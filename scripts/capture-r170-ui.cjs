/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R170 界面核对截图（Lead 专用，隔离数据；零真实模型）。
 *
 * 用法：
 *   node scripts/capture-r170-ui.cjs                    # 全量场景
 *   node scripts/capture-r170-ui.cjs --only=members,board
 *   node scripts/capture-r170-ui.cjs --run=after-fix-2
 * 产物：dist/r170-ui/<run>/NN-<scene>.png + result.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg == null ? [] : onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const runArg = process.argv.find((arg) => arg.startsWith('--run='));
const runName = runArg == null ? 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r170-ui', runName);
const data = path.join(run, 'data');
const project = path.join(run, '工作区', '读书会筹备');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(path.dirname(project), { recursive: true });

const mainCjs = path.join(root, 'dist', 'ui', 'main.cjs');
if (!fs.existsSync(mainCjs)) {
  console.error('缺少 dist/ui/main.cjs：请先运行 node scripts/build-ui.mjs');
  process.exit(2);
}

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data,
  ZS_RUNTIME: 'fake',
  ZS_ALLOW_FAKE: '1',
  ZS_REAL_DISPATCH_GUARD: '1',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r170-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

const scenesSource = String.raw`(() => {
  const m = window.r170Meta;
  if (m == null) throw Error('缺少隔离夹具元数据');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check, label, timeout) => {
    const end = Date.now() + (timeout || 20000);
    while (Date.now() < end) {
      let ok = false;
      try { ok = !!check(); } catch { ok = false; }
      if (ok) return;
      await wait(80);
    }
    throw Error('等待超时：' + (label || ''));
  };
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => Array.from(document.querySelectorAll(selector));
  const textOf = (el) => (el == null ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
  const go = async (route) => { window.location.hash = '#' + route; await wait(700); };
  const closeOverlays = async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(250);
  };
  const roomRoute = () => '/project/' + m.projectId + '/room/' + m.roomId;
  const threadRoute = () => roomRoute() + '?thread=' + (m.work && m.work.threadId ? m.work.threadId : '');
  const scenes = [
    { name: 'members', run: async () => {
      await go('/project/' + m.projectId + '/members');
      await until(() => q('[data-zs-members]'), '成员页');
      await until(() => qa('[data-zs-member-card]').length >= 2 || q('[data-zs-member-card]'), '成员卡');
      await until(() => qa('[data-zs-members-project]').length >= 4, '项目卡（含夹具额外项目）', 25000);
      await wait(900);
      window.r170Extra = { projects: qa('[data-zs-members-project]').map(textOf) };
    } },
    { name: 'members-switch', run: async () => {
      await until(() => qa('[data-zs-members-project]').length >= 4, '项目卡', 25000);
      await wait(600);
      const before = textOf(q('.side-row.context-active .side-item-label')) || textOf(q('.side-project .side-row.context-active .side-item-label'));
      const cards = qa('[data-zs-members-project]');
      const target = cards.find((el) => textOf(el).includes('社区运营')) ?? cards[1];
      target.click();
      await until(() => /社区运营|产品手册|数据分析/.test(textOf(q('.members-head-name'))), '切换项目后的标题', 25000);
      await wait(1200);
      window.r170Extra = {
        header: textOf(q('.members-head-name')),
        members: textOf(q('.members-head-meta')),
        projectCards: qa('[data-zs-members-project]').map(textOf),
        sidebarActiveBefore: before,
        sidebarActiveAfter: textOf(q('.side-row.context-active .side-item-label')),
      };
    } },
    { name: 'board', run: async () => {
      await go('/board?scope=all');
      await until(() => q('.page-filters'), '看板筛选');
      await until(() => qa('[data-zs-task-id]').length > 0, '看板卡片');
      await wait(900);
      window.r170Extra = { cards: qa('[data-zs-task-id]').length };
    } },
    { name: 'board-hidden', run: async () => {
      await go('/board?scope=all');
      await until(() => qa('[data-zs-task-id]').length > 0, '看板卡片');
      const remove = q('[data-zs-board-remove]');
      if (remove == null) throw Error('没有「从看板移除」按钮');
      remove.click();
      await wait(500);
      const clear = q('[data-zs-board-clear-all]');
      if (clear != null) { clear.click(); await wait(300); clear.click(); }
      await wait(700);
      window.r170Extra = { hidden: textOf(q('[data-zs-board-hidden]')), cards: qa('[data-zs-task-id]').length };
    } },
    { name: 'settings', run: async () => {
      await go('/settings');
      await until(() => q('.settings-page'), '设置页');
      await wait(900);
      window.r170Extra = { sections: qa('[data-settings-section]').map((el) => el.getAttribute('data-settings-section')) };
    } },
    { name: 'files', run: async () => {
      await go('/project/' + m.projectId + '/files');
      await until(() => q('.fg-page'), '文件页');
      await until(() => q('.fg-body') || q('.git-layout'), '文件双栏');
      await wait(900);
      window.r170Extra = {
        topbar: q('.fg-topbar') == null ? null : Math.round(q('.fg-topbar').getBoundingClientRect().height),
        path: textOf(q('[data-zs-files-path]')),
      };
    } },
    { name: 'room', run: async () => {
      await go(roomRoute());
      await until(() => q('.root-card'), '房间');
      await wait(800);
      window.r170Extra = { headHeight: q('.pool-head') == null ? null : Math.round(q('.pool-head').getBoundingClientRect().height) };
    } },
    { name: 'thread-open-menu', keepOpen: true, run: async () => {
      await go(threadRoute());
      await until(() => qa('[data-zs-open-more]').length > 0, '文件卡「打开」展开按钮', 25000);
      await wait(900);
      q('[data-zs-open-more]').click();
      await wait(800);
      const menu = q('.menu');
      const rect = menu == null ? null : menu.getBoundingClientRect();
      window.r170Extra = {
        menuItems: qa('.menu .menu-item').map(textOf),
        menu: menu == null ? null : {
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          display: getComputedStyle(menu).display,
          opacity: getComputedStyle(menu).opacity,
          z: getComputedStyle(menu).zIndex,
          bodyLast: document.body.lastElementChild === menu || menu.parentElement === document.body,
        },
      };
    } },
    { name: 'thread-diff', keepOpen: true, run: async () => {
      await closeOverlays();
      await go(threadRoute());
      await until(() => qa('button').some((b) => textOf(b) === '查看变更'), '查看变更按钮', 25000);
      await wait(500);
      qa('button').find((b) => textOf(b) === '查看变更').click();
      await until(() => q('[role="dialog"]'), '变更弹窗', 20000);
      await wait(1200);
      window.r170Extra = { addRows: qa('.preview-diff-row.add').length, delRows: qa('.preview-diff-row.del').length };
    } },
    { name: 'thread-preview', run: async () => {
      await closeOverlays();
      await go(threadRoute());
      await until(() => q('[data-zs-change-open]') || q('[data-zs-attachment-open]'), '线程文件卡', 25000);
      await wait(600);
      const open = q('[data-zs-change-open]') || q('[data-zs-attachment-open]');
      open.click();
      await until(() => q('.preview-pane'), '预览面板');
      await until(() => q('.preview-tab-label'), '预览标签');
      await wait(1400);
      window.r170Extra = { crumb: textOf(q('.preview-crumb-path')), copyPath: q('[data-preview-action="copy-path"]') != null };
    } },
    { name: 'files-preview', run: async () => {
      await closeOverlays();
      await go('/project/' + m.projectId + '/files');
      await until(() => qa('.file-row').length > 0, '文件树', 25000);
      await wait(600);
      const row = qa('.file-row').find((el) => textOf(el).includes('活动安排.md'));
      if (row == null) throw Error('文件树里没有 活动安排.md');
      row.click();
      await until(() => q('.preview-pane .preview-tab-label'), '预览标签', 25000);
      await wait(1400);
      window.r170Extra = { crumb: textOf(q('.preview-crumb-path')), copyPath: q('[data-preview-action="copy-path"]') != null };
    } },
    { name: 'preview-tab-menu', keepOpen: true, run: async () => {
      const tab = q('.preview-tab.on .preview-tab-label') || q('.preview-tab-label');
      if (tab == null) throw Error('没有预览标签');
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 880, clientY: 60 }));
      await wait(800);
      window.r170Extra = { menuItems: qa('.menu .menu-item').map(textOf) };
    } },
    { name: 'preview-more', keepOpen: true, run: async () => {
      await closeOverlays();
      await wait(300);
      const more = q('[data-preview-action="more"]');
      if (more == null) throw Error('没有预览更多按钮');
      more.click();
      await wait(600);
      window.r170Extra = { menuItems: qa('.menu .menu-item').map(textOf) };
    } },
  ];
  window.r170Scenes = scenes;
  window.r170Shot = async (index) => {
    const scene = scenes[index];
    window.r170Extra = null;
    let error = null;
    try { await scene.run(); } catch (e) { error = String((e && e.message) || e); }
    await wait(250);
    const visibleText = (document.body.innerText || '').slice(0, 8000);
    const extra = window.r170Extra || null;
    const layout = {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
    return { name: scene.name, keepOpen: scene.keepOpen === true, error, visibleText, extra, layout };
  };
  window.r170Cleanup = async () => { await closeOverlays(); };
})();`;
const scenesPath = path.join(run, 'r170-scenes.js');
fs.writeFileSync(scenesPath, scenesSource);

const wrapperSource = String.raw`const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const OUT = __OUT__;
const RESULT = __RESULT__;
const ONLY = __ONLY__;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
async function capture(win) {
  const results = [];
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const metaJson = fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8');
  const scenesJs = fs.readFileSync(SCENES, 'utf8');
  try {
    win.setContentSize(1360, 900);
    for (let i = 0; i < 120; i++) { if (await js('document.readyState === "complete" && document.body.innerText.length > 20')) break; await sleep(250); }
    await sleep(900);
    let hifi = false;
    for (let i = 0; i < 120; i++) { try { hifi = await js('document.body.classList.contains("hifi-on")'); } catch { hifi = false; } if (hifi) break; await sleep(250); }
    console.log('R170_HIFI ' + hifi);
    // 隐藏窗口里 CSS 动画会停在首帧（菜单 pop 动画 opacity:0 导致截图看不到菜单）。
    // 仅截图环境：把动画/过渡压到 0，让最终态立即可见（不改变产品代码）。
    try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r170-capture-anim\\">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
    await js('window.r170Meta = ' + metaJson);
    await js(scenesJs);
    const names = await js('window.r170Scenes.map(function (s) { return s.name; })');
    const keep = await js('window.r170Scenes.map(function (s) { return s.keepOpen === true; })');
    for (let i = 0; i < names.length; i++) {
      if (ONLY.length && ONLY.indexOf(names[i]) < 0) continue;
      let step = null;
      let failure = null;
      try { step = await js('window.r170Shot(' + i + ')'); } catch (e) { failure = String((e && e.message) || e); }
      if (keep[i] !== true) {
        try { await js('window.r170Cleanup ? window.r170Cleanup() : true'); } catch {}
      }
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {});
      const name = names[i];
      const file = (i + 1 < 10 ? '0' : '') + (i + 1) + '-' + name + '.png';
      let image = null;
      try {
        const shot = await win.webContents.capturePage();
        image = shot.getSize();
        fs.writeFileSync(path.join(OUT, file), shot.toPNG());
      } catch (e) { failure = (failure == null ? '' : failure + '；') + '截图失败：' + String((e && e.message) || e); }
      step = step || { name, error: null, visibleText: '', extra: null, layout: null };
      if (failure != null) step.error = (step.error == null ? '' : step.error + '；') + failure;
      step.screenshot = file;
      step.image = image;
      results.push(step);
      fs.writeFileSync(RESULT, JSON.stringify({ ok: true, partial: true, hifi, names, results }, null, 2));
      console.log('R170_SHOT ' + name + ' ' + (image == null ? 'no-image' : image.width + 'x' + image.height) + (step.error ? ' ERROR=' + step.error : ''));
    }
    fs.writeFileSync(RESULT, JSON.stringify({ ok: true, hifi, names, results, inner: await js('({w: window.innerWidth, h: window.innerHeight})') }, null, 2));
  } catch (e) {
    fs.writeFileSync(RESULT, JSON.stringify({ ok: false, error: String((e && e.stack) || e), results }, null, 2));
    console.error('R170_CAPTURE_FAIL ' + String((e && e.stack) || e));
  }
  // close 仅隐藏到托盘；测试必须走正式退出链，等待后台关库。
  app.quit();
}
app.on('browser-window-created', (_e, win) => {
  win.show = () => {};
  win.webContents.once('did-finish-load', () => { void capture(win); });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(scenesPath))
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
  const result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8'));
  const summary = { ok: electron.status === 0 && result.ok === true && result.partial !== true && result.results?.length > 0 && result.results.every((step) => step.error == null), processExit: electron.status, run: path.relative(root, run), shots: (result.results || []).map((step) => ({ name: step.name, screenshot: step.screenshot, error: step.error, extra: step.extra })) };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
