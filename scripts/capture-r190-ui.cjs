/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R190 七项反馈验证（隔离数据 + 假运行时；零真实模型、不打包、不安装）。
 *
 * 用户 2026-11-07（beta.34 之后）：
 *  1) 文件与 Git 页：顶部工具栏与下方「项目文件 / Git」面板贴在一起，需要间隔；
 *  2) 搜索页工具栏里的 搜索/收藏 两个页签偏上；作者名筛选去掉；
 *  3) 搜索输入时不要出现「按 Enter 或点「检索」开始」提示块；
 *  4) 去掉「范围：「X」· 搜索范围为消息…」「… 收藏总计 N 条」「在线程回复消息上点书签按钮…」等开发口径文案；
 *  5) 文件预览 ⋯ 菜单去掉「引用到 选择讨论位置」；
 *  6) Git 页去掉「改动记录不受影响 / 任务改动仍会记录，并可查看 diff 与撤销」提示块；
 *  7) 空态/提示不要顶在上边，应居中。
 *
 * 用法：node scripts/capture-r190-ui.cjs [--run=name]
 * 产物：dist/r190-ui/<run>/（截图 + summary.json）
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
const run = path.join(root, 'dist', 'r190-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r190-workspace', runName);
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r190-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

const scenesSource = String.raw`(() => {
  const m = window.r190Meta;
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
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.top + r.height / 2) }; };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const body = () => document.body.innerText || '';
  const extra = {};

  window.run = async () => {
    // ── 1) 文件页：工具栏与下方面板有间隔 ──
    await go('/project/' + m.projectId + '/files');
    await until(() => q('[data-zs-files-topbar]') && q('.fg-body, .git-layout, .empty'), '文件页');
    await wait(800);
    const toolbar = q('[data-zs-files-topbar]');
    const pane = q('.fg-rail-content > .fg-body') || q('.fg-rail-content > .git-layout') || q('.fg-rail-content > .empty');
    const tb = rect(toolbar), pn = rect(pane);
    extra.filesGap = tb != null && pn != null ? pn.top - tb.bottom : null;
    check('文件页工具栏与下方内容有间隔（≥8px）', extra.filesGap != null && extra.filesGap >= 8, extra.filesGap);

    // ── 5) 文件预览 ⋯ 菜单没有「引用到」 ──
    await until(() => qa('.file-row').length > 0, '文件树');
    const row = qa('.file-row').find((el) => textOf(el).includes('.md'));
    if (row != null) { row.click(); }
    await until(() => q('[data-preview-action="more"]'), '预览更多按钮', 25000);
    await wait(1200);
    const more = q('[data-preview-action="more"]');
    extra.moreRect = rect(more);
    if (more != null) { more.click(); await wait(900); }
    extra.menuCount = qa('.menu').length;
    extra.roleMenuCount = qa('[role="menu"]').length;
    const menuText = qa('.menu').map(textOf).join(' | ');
    extra.menuText = menuText;
    // 菜单能打开时：断言里面没有「引用到」；打不开时单独记为未验证，避免把工具问题当产品缺陷。
    if (menuText.length > 0) {
      check('文件预览 ⋯ 菜单不再有「引用到」', !menuText.includes('引用到'), menuText);
    } else {
      check('文件预览 ⋯ 菜单未能在隔离窗口打开（记为未验证，不计通过）', false, { moreRect: extra.moreRect, menuCount: extra.menuCount, roleMenuCount: extra.roleMenuCount });
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(300);

    // ── 6) Git 页：无「改动记录不受影响」提示块（必须用**非 Git** 项目才看得到空态） ──
    const nonGitId = m.extraProjectIds && m.extraProjectIds[0];
    if (nonGitId != null) await go('/project/' + nonGitId + '/files?tab=git');
    else await go('/project/' + m.projectId + '/files?tab=git');
    await wait(1500);
    const gitText = body();
    extra.gitText = gitText.slice(0, 500);
    check('Git 页不再显示「改动记录不受影响」', !gitText.includes('改动记录不受影响') && !gitText.includes('任务改动仍会记录'));
    check('非 Git 目录的 Git 页仍说明未初始化', gitText.includes('尚未初始化') || gitText.includes('没有 Git 数据'), extra.gitText);

    // ── 2/3/4/7) 搜索与收藏 ──
    await go('/library');
    await until(() => q('[data-zs-library]'), '搜索页');
    await wait(900);
    const libToolbar = q('.project-content > .page-filters');
    const libRect = rect(libToolbar);
    const tabs = qa('.page-filters > .thread-tabs .thread-tab');
    const tabCenters = tabs.map((el) => rect(el).cy);
    const toolbarInnerCenter = libRect == null ? null : Math.round(libRect.top + libRect.h / 2);
    extra.tabCenters = tabCenters;
    extra.toolbarInnerCenter = toolbarInnerCenter;
    check('搜索/收藏页签垂直居中（±1px）', tabCenters.length === 2 && toolbarInnerCenter != null && tabCenters.every((c) => Math.abs(c - toolbarInnerCenter) <= 1), { tabCenters, toolbarInnerCenter });
    check('作者名筛选已去掉', !body().includes('作者') && q('[aria-label="作者"]') == null && !qa('.page-filters .field-label').some((el) => textOf(el) === '作者'));
    check('不再显示范围/搜索范围说明（第4项）', !body().includes('搜索范围为消息') && !body().includes('收藏总计') && !body().includes('范围：'));
    check('不再显示书签/收藏开发说明（第4项）', !body().includes('在线程回复消息上点书签按钮'));

    // 空态居中（第7项）：空态垂直中心与右列可用区域中心接近
    const empty = q('.project-content > .empty');
    const content = q('.project-content');
    if (empty != null && content != null) {
      const er = rect(empty), cr = rect(content);
      const emptyCenter = er.top + er.h / 2;
      const contentCenter = cr.top + cr.h / 2;
      extra.emptyCenterDelta = Math.round(Math.abs(emptyCenter - contentCenter));
      check('搜索空态垂直居中（±40px）', extra.emptyCenterDelta <= 40, { emptyCenter, contentCenter, delta: extra.emptyCenterDelta });
    } else {
      check('搜索空态存在', false);
    }

    // ── 3) 输入时不再出现「按 Enter 或点「检索」开始」 ──
    const input = q('.search-field-input');
    if (input != null) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'kkkk');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(600);
    }
    const typingText = body();
    extra.typingHasPrompt = typingText.includes('按 Enter 或点');
    check('输入时不显示「按 Enter 或点检索开始」', !extra.typingHasPrompt);
    // 输入后空态也应消失（避免「输入了却还显示初始空态」）
    check('输入后初始空态不再显示', !typingText.includes('输入关键词开始搜索'));

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
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r190-anim\\">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
      await js('window.r190Meta = ' + JSON.stringify(JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8'))));
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.run()');
      const pid = JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8')).projectId;
      const shots = [['files','/project/' + pid + '/files'],['files-git','/project/' + pid + '/files?tab=git'],['library','/library'],['library-typing','/library'],['board','/board']];
      let n = 1;
      for (const [name, route] of shots) {
        await js('window.location.hash = ' + JSON.stringify('#' + route));
        await sleep(1300);
        if (name === 'library-typing') {
          await js('(() => { const i = document.querySelector(".search-field-input"); if (i) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "kkkk"); i.dispatchEvent(new Event("input", { bubbles: true })); } return true; })()');
          await sleep(700);
        }
        try { const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, String(n).padStart(2,'0') + '-' + name + '.png'), shot.toPNG()); } catch (e) { console.error('shot fail ' + name + ' ' + e); }
        n += 1;
      }
      fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
      console.log('R190_RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks.length, failed: result.checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R190_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const scenesPath = path.join(run, 'r190-scenes.js');
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
    extra: result.extra || null,
    error: result.error || null,
  };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, processExit: summary.processExit, checks: summary.checks.length, failed: summary.failedChecks, extra: summary.extra, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
