/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** R204 设置页「我的名字」行排版回归（隔离数据 + 假运行时；零真实模型）。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runName = runArg == null ? 'run-' + Date.now() : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r204-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r204-workspace', runName);
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r204-' + randomUUID(),
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
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
  const extra = { sizes: [] };

  window.run = async () => {
    window.location.hash = '#/settings';
    await until(() => q('[data-zs-viewer-name-input]') && q('[data-settings-row="appearance-viewer-name"]'), '设置页名字行', 30000);
    await wait(900);
    return { ok: true, checks, extra };
  };

  window.measure = () => {
    const row = q('[data-settings-row="appearance-viewer-name"]');
    const control = row?.querySelector('.pset-row-control');
    const inner = row?.querySelector('[data-zs-viewer-name-control="1"]');
    const input = q('[data-zs-viewer-name-input]');
    const button = q('[data-zs-viewer-name-save]');
    const status = inner?.querySelector('.small.faint');
    const themeControl = q('[data-settings-row="appearance-theme"] .pset-row-control');
    const card = row?.closest('.card') ?? row?.parentElement;
    const cs = card == null ? null : getComputedStyle(card);
    const contentRight = card == null ? null : card.getBoundingClientRect().right - parseFloat(cs.paddingRight || '0');
    const data = {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      row: rect(row), card: rect(card), control: rect(control), inner: rect(inner), input: rect(input), button: rect(button), status: rect(status),
      cardPaddingRight: cs == null ? null : cs.paddingRight,
      rowPaddingRight: row == null ? null : getComputedStyle(row).paddingRight,
      themeControlRight: themeControl == null ? null : +themeControl.getBoundingClientRect().right.toFixed(1),
      contentRight: contentRight == null ? null : +contentRight.toFixed(1),
      rowScroll: row == null ? null : { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth },
      inputValue: input?.value ?? null,
      statusText: status?.textContent ?? null,
    };
    data.controlInside = data.control != null && contentRight != null && data.control.right <= contentRight + 1;
    data.alignedWithTheme = data.button != null && data.themeControlRight != null && Math.abs(data.button.right - data.themeControlRight) <= 1.5;
    data.buttonInside = data.button != null && contentRight != null && data.button.right <= contentRight + 1;
    data.rowNoOverflow = data.rowScroll != null && data.rowScroll.scrollWidth <= data.rowScroll.clientWidth + 1;
    data.inputButtonSameLine = data.input != null && data.button != null && Math.abs((data.input.y + data.input.h / 2) - (data.button.y + data.button.h / 2)) <= 2;
    extra.sizes.push(data);
    return data;
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
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r204-anim\\">*,*::before,*::after{animation:none !important;transition:none !important}</style>")'); } catch {}
      await js(fs.readFileSync(SCENES, 'utf8'));
      const start = await js('window.run()');
      const checks = start.checks;
      const sizes = [[1360, 900], [1324, 760], [1200, 800], [1100, 800], [1024, 768], [900, 760], [700, 760]];
      for (const [w, h] of sizes) {
        win.setContentSize(w, h);
        await sleep(500);
        win.webContents.invalidate();
        await sleep(200);
        const data = await js('window.measure()');
        checks.push({ name: w + ' 控件不越出卡片内容右缘', ok: data.controlInside === true, detail: data });
        checks.push({ name: w + ' 保存按钮不越出内容右缘', ok: data.buttonInside === true, detail: data });
        checks.push({ name: w + ' 名字行无横向溢出', ok: data.rowNoOverflow === true, detail: data });
        checks.push({ name: w + ' 输入框与保存按钮同一行', ok: data.inputButtonSameLine === true, detail: data });
        if (w > 760) checks.push({ name: w + ' 保存按钮与其它行的控件右对齐', ok: data.alignedWithTheme === true, detail: data });
        checks.push({ name: w + ' 名字行有卡片内边距', ok: parseFloat(data.rowPaddingRight || '0') >= (w > 760 ? 19.5 : 13.5), detail: data });
        if (w === 1324) {
          try { fs.writeFileSync(path.join(OUT, '01-settings-1324.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot full fail ' + e); }
          try {
            const r = data.row;
            fs.writeFileSync(path.join(OUT, '02-viewer-name-row-1324.png'), (await win.webContents.capturePage({ x: Math.max(0, Math.round(r.x - 20)), y: Math.max(0, Math.round(r.y - 12)), width: Math.round(r.w + 40), height: Math.round(r.h + 24) })).toPNG());
          } catch (e) { console.error('shot row fail ' + e); }
        }
      }
      win.setContentSize(1360, 900);
      await sleep(400);
      const finalResult = { ok: checks.every((c) => c.ok), checks, extra: start.extra };
      fs.writeFileSync(RESULT, JSON.stringify(finalResult, null, 2));
      console.log('R204_RESULT ' + JSON.stringify({ ok: finalResult.ok, checks: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R204_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const wrapperPath = path.join(run, 'main.cjs');
const scenesPath = path.join(run, 'r204-scenes.js');

(async () => {
  try {
    await require('esbuild').build({ entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(run, 'seed.cjs'), logLevel: 'silent' });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project, '--r192'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败：' + (seeded.stderr || seeded.stdout));
    fs.writeFileSync(scenesPath, scenesSource);
    fs.writeFileSync(wrapperPath, wrapperSource
      .replace('__MAIN__', JSON.stringify(mainCjs))
      .replace('__SCENES__', JSON.stringify(scenesPath))
      .replace('__OUT__', JSON.stringify(run))
      .replace('__RESULT__', JSON.stringify(path.join(run, 'result.json'))));
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
  const summary = { ok: electron.status === 0 && result.ok === true && result.error == null, processExit: electron.status, run: path.relative(root, run), checks: result.checks || [], failedChecks: (result.checks || []).filter((c) => !c.ok).map((c) => c.name), extra: result.extra || null, error: result.error ?? null };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, checks: summary.checks.length, failed: summary.failedChecks, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
