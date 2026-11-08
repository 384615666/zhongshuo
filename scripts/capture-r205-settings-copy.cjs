/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** R205 设置页去小字文案 + 去草稿设置回归（隔离数据 + 假运行时；零真实模型）。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runName = runArg == null ? 'run-' + Date.now() : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r205-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r205-workspace', runName);
const project = path.join(workspace, '读书会筹备');
fs.rmSync(run, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
const mainCjs = path.join(root, 'dist', 'ui', 'main.cjs');
if (!fs.existsSync(mainCjs)) { console.error('缺少 dist/ui/main.cjs'); process.exit(2); }
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r205-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1', ZS_NODE_BIN: process.execPath,
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
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const extra = {};

  window.run = async () => {
    window.location.hash = '#/settings';
    await until(() => q('[data-settings-section="appearance"]') && q('[data-settings-section="data"]'), '设置页', 30000);
    await wait(900);
    const page = q('.settings-single') || q('.page');
    const text = (page?.innerText || '').slice(0, 5000);
    extra.text = text.slice(0, 2500);
    extra.pageSubs = qa('.settings-single .page-sub').length;
    extra.sectionSubs = qa('.settings-section-sub').length;
    extra.draftRows = qa('[data-zs-draft-retry],[data-zs-draft-recovery-note]').length;
    extra.sectionTitles = qa('.settings-section-title').map((el) => (el.textContent || '').trim());
    extra.dataGroups = qa('[data-settings-section="data"] .settings-group-title').map((el) => (el.textContent || '').trim());
    extra.storageCleanup = text.includes('清理存储');

    check('设置页不再渲染页头小字', extra.pageSubs === 0, extra.pageSubs);
    check('各分区不再渲染小字说明', extra.sectionSubs === 0, extra.sectionSubs);
    for (const copy of [
      '外观、通知、AI、数据与帮助都在这一页',
      '主题、头像和名字；只在本机生效',
      '桌面通知总开关。',
      '调用预算与同时运行的 AI。',
      '数据位置、备份、草稿与归档。',
      '手册、链接、版本与诊断。',
    ]) check('不再出现小字：' + copy, !text.includes(copy));
    check('分区标题仍在', ['外观', '通知', 'AI 设置', '数据与存储', '帮助与关于'].every((title) => extra.sectionTitles.includes(title)), extra.sectionTitles);
    check('设置页没有草稿设置分组', !extra.dataGroups.includes('草稿'), extra.dataGroups);
    check('没有草稿状态/重试/清理设置', !text.includes('草稿保存') && !text.includes('清理本地草稿') && !text.includes('重试保存') && extra.draftRows === 0, { draftRows: extra.draftRows });
    check('保留清理存储设置', extra.storageCleanup === true);
    check('数据分组仍有数据位置与备份、归档与项目', extra.dataGroups.includes('数据位置与备份') && extra.dataGroups.includes('归档与项目'), extra.dataGroups);
    return { ok: checks.every((c) => c.ok), checks, extra };
  };

  window.scrollData = async () => {
    const dataSection = q('[data-settings-section="data"]');
    dataSection?.scrollIntoView({ block: 'start' });
    await wait(500);
    const header = dataSection?.querySelector('.settings-section-head');
    const title = dataSection?.querySelector('.settings-section-title');
    const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
    return { header: rect(header), title: rect(title), pageScroll: q('.page')?.scrollTop ?? null };
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
      win.setContentSize(1324, 760);
      for (let i = 0; i < 160; i++) { if (await js('document.readyState === "complete" && document.body.innerText.length > 20')) break; await sleep(250); }
      await sleep(900);
      for (let i = 0; i < 160; i++) { if (await js('document.body.classList.contains("hifi-on")')) break; await sleep(250); }
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r205-anim\\">*,*::before,*::after{animation:none !important;transition:none !important}</style>")'); } catch {}
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.run()');
      await sleep(1000);
      try { win.webContents.invalidate(); await sleep(200); fs.writeFileSync(path.join(OUT, '01-settings-top-1324.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot top fail ' + e); }
      const scroll = await js('window.scrollData()');
      await sleep(700);
      try { win.webContents.invalidate(); await sleep(200); fs.writeFileSync(path.join(OUT, '02-settings-data-1324.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot data fail ' + e); }
      const finalResult = { ok: result.ok, checks: result.checks, extra: { ...result.extra, scroll } };
      fs.writeFileSync(RESULT, JSON.stringify(finalResult, null, 2));
      console.log('R205_RESULT ' + JSON.stringify({ ok: finalResult.ok, checks: finalResult.checks.length, failed: finalResult.checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R205_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

(async () => {
  try {
    await require('esbuild').build({ entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(run, 'seed.cjs'), logLevel: 'silent' });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project, '--r192'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败：' + (seeded.stderr || seeded.stdout));
    fs.writeFileSync(path.join(run, 'r205-scenes.js'), scenesSource);
    fs.writeFileSync(path.join(run, 'main.cjs'), wrapperSource
      .replace('__MAIN__', JSON.stringify(mainCjs))
      .replace('__SCENES__', JSON.stringify(path.join(run, 'r205-scenes.js')))
      .replace('__OUT__', JSON.stringify(run))
      .replace('__RESULT__', JSON.stringify(path.join(run, 'result.json'))));
  } catch (error) {
    console.error(String(error));
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ok: false, error: String(error), checks: [] }, null, 2));
    process.exitCode = 1;
    return;
  }
  const electron = spawnSync(require('electron'), [path.join(run, 'main.cjs')], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8')); } catch { result = { ok: false, error: '未产出 result.json（见 process.log）', checks: [] }; }
  const summary = { ok: electron.status === 0 && result.ok === true && result.error == null, processExit: electron.status, run: path.relative(root, run), checks: result.checks || [], failedChecks: (result.checks || []).filter((c) => !c.ok).map((c) => c.name), extra: result.extra || null, error: result.error ?? null };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, checks: summary.checks.length, failed: summary.failedChecks, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
