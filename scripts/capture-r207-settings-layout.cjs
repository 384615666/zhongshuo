/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** R207 设置页去状态小字 + 重新排版回归（隔离数据 + 假运行时；零真实模型）。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runName = runArg == null ? 'run-' + Date.now() : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r207-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r207-workspace', runName);
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r207-' + randomUUID(),
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
  const extra = {};

  window.run = async () => {
    window.location.hash = '#/settings';
    await until(() => q('[data-settings-section="help"]') && q('[data-settings-section="appearance"]'), '设置页', 30000);
    await wait(1000);
    const page = q('.settings-single') || q('.page');
    const text = page?.innerText || '';

    extra.statusTexts = ['当前显示「你」', '当前显示「', '已开启', '已关闭', '当前上限', '读取中…', '尚未确认当前上限', '共 0 个项目'].filter((copy) => text.includes(copy));
    check('版本名称改为本地多Agent协作工作台', text.includes('众说 · 本地多Agent协作工作台') && !text.includes('本地多成员协作工作台'), text.slice(0, 200));
    check('设置页不再显示状态小字', extra.statusTexts.length === 0, extra.statusTexts);
    const switchLabels = qa('.settings-single .switch > span:not(.switch-track)').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && (el.textContent || '').trim() !== '';
    }).map((el) => (el.textContent || '').trim());
    extra.switchLabels = switchLabels;
    check('开关不再显示可见文字标签', switchLabels.length === 0, switchLabels);

    const rows = qa('.settings-single .pset-row').map((row) => {
      const label = row.querySelector('.pset-row-label');
      const control = row.querySelector('.pset-row-control');
      const labelRect = rect(label), controlRect = rect(control), rowRect = rect(row);
      const labelCenter = labelRect == null ? null : labelRect.y + labelRect.h / 2;
      const controlCenter = controlRect == null ? null : controlRect.y + controlRect.h / 2;
      return {
        id: row.getAttribute('data-settings-row') || row.id || (label?.firstElementChild?.textContent || '').trim().slice(0, 30),
        h: rowRect?.h ?? null,
        labelCenter, controlCenter,
        centerDelta: labelCenter != null && controlCenter != null ? +(controlCenter - labelCenter).toFixed(1) : null,
        hasAvatar: row.querySelector('[data-zs-avatar-settings]') != null,
        hasEmbed: row.querySelector('.settings-embed') != null,
      };
    });
    extra.rows = rows;
    check('简单设置行没有纵向错位（中心偏差 ≤2px）', rows.filter((r) => !r.hasAvatar && !r.hasEmbed && r.centerDelta != null).every((r) => Math.abs(r.centerDelta) <= 2), rows.filter((r) => !r.hasAvatar && !r.hasEmbed && Math.abs(r.centerDelta || 0) > 2));
    check('简单设置行高度紧凑（≤80px）', rows.filter((r) => !r.hasAvatar && !r.hasEmbed).every((r) => r.h != null && r.h <= 80), rows.filter((r) => !r.hasAvatar && !r.hasEmbed && (r.h == null || r.h > 80)));
    const avatar = rows.find((r) => r.hasAvatar);
    check('头像行不再留下大块空档（≤130px）', avatar == null || (avatar.h != null && avatar.h <= 130), avatar);
    const picker = q('[data-zs-avatar-settings] [data-zs-avatar-picker]');
    const pickerRows = picker == null ? [] : Array.from(picker.querySelectorAll(':scope > .row'));
    const actionRow = pickerRows[pickerRows.length - 1];
    const actionRect = rect(actionRow);
    const controlRect = rect(q('[data-settings-row="appearance-avatar-images"] .pset-row-control'));
    extra.avatarActionRow = { action: actionRect, control: controlRect };
    check('头像上传/恢复按钮组靠右对齐', actionRect != null && controlRect != null && Math.abs(actionRect.right - controlRect.right) <= 1.5, extra.avatarActionRow);

    const heads = qa('.settings-section-head').map((el) => rect(el)?.h ?? null);
    extra.sectionHeadHeights = heads;
    check('分区标题行高度紧凑（≤52px）', heads.every((h) => h != null && h <= 52), heads);
    const emptyGaps = [];
    const cards = qa('.settings-section');
    for (let i = 1; i < cards.length; i += 1) {
      const prev = rect(cards[i - 1]), cur = rect(cards[i]);
      if (prev != null && cur != null && cur.y - prev.bottom > 36) emptyGaps.push({ i, gap: +(cur.y - prev.bottom).toFixed(1) });
    }
    extra.sectionGaps = emptyGaps;
    check('分区之间没有过大空档（≤36px）', emptyGaps.length === 0, emptyGaps);

    return { ok: checks.every((c) => c.ok), checks, extra };
  };

  window.gotoSection = (key) => {
    const el = document.getElementById('settings-section-' + key);
    el?.scrollIntoView({ block: 'start' });
    return el != null;
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
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r207-anim\\">*,*::before,*::after{animation:none !important;transition:none !important}</style>")'); } catch {}
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.run()');
      await sleep(900);
      try { win.webContents.invalidate(); await sleep(200); fs.writeFileSync(path.join(OUT, '01-settings-top.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot top fail ' + e); }
      for (const [key, name] of [['runtime', '02-settings-ai.png'], ['data', '03-settings-data.png'], ['help', '04-settings-help.png']]) {
        await js('window.gotoSection(' + JSON.stringify(key) + ')');
        await sleep(700);
        win.webContents.invalidate();
        await sleep(200);
        try { fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot ' + key + ' fail ' + e); }
      }
      const finalResult = { ok: result.ok, checks: result.checks, extra: result.extra };
      fs.writeFileSync(RESULT, JSON.stringify(finalResult, null, 2));
      console.log('R207_RESULT ' + JSON.stringify({ ok: finalResult.ok, checks: finalResult.checks.length, failed: finalResult.checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R207_FAIL ' + String((e && e.stack) || e)); }
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
    fs.writeFileSync(path.join(run, 'r207-scenes.js'), scenesSource);
    fs.writeFileSync(path.join(run, 'main.cjs'), wrapperSource
      .replace('__MAIN__', JSON.stringify(mainCjs))
      .replace('__SCENES__', JSON.stringify(path.join(run, 'r207-scenes.js')))
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
