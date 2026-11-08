/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R203 成员管理回归（隔离数据 + 假运行时；零真实模型、不安装、不打包）。
 *
 * 用户反馈：点击成员管理里的 AI 成员卡片不再进入单独的「Codex 配置」详情页，
 * 而是直接打开同一个「AI 设置」弹窗。本脚本在真实 UI 中断言：
 *  - 卡片 title 为「打开 X 的 AI 设置」；
 *  - 点击卡片后 URL 仍在 /members，未挂载成员详情页，AI 设置弹窗出现；
 *  - 旧深链 /project/:id/member/:memberId 重定向回 /members。
 *
 * 用法：node scripts/capture-r203-ui.cjs [--run=name]
 * 产物：dist/r203-ui/<run>/（截图 + result.json + summary.json + 日志）
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
const run = path.join(root, 'dist', 'r203-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r203-workspace', runName);
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r203-' + randomUUID(),
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
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const extra = {};
  const membersRoute = '/project/' + __PROJECT_ID__ + '/members';
  const legacyRoute = '/project/' + __PROJECT_ID__ + '/member/' + __MEMBER_ID__;
  window.__r203 = { membersRoute, legacyRoute };

  window.run = async () => {
    window.location.hash = '#' + membersRoute;
    await until(() => q('[data-zs-member-card]') && qa('[data-zs-member-bind]').length > 0, '成员管理卡片', 30000);
    await wait(800);

    const cards = qa('[data-zs-member-card]');
    const agentCard = cards.find((card) => card.querySelector('[data-zs-member-bind]') != null);
    extra.cards = cards.map((card) => ({
      title: card.getAttribute('title'),
      agent: card.querySelector('[data-zs-member-bind]') != null,
      text: (card.innerText || '').slice(0, 120),
    }));
    check('成员卡片存在', cards.length > 0, extra.cards.length);
    check('AI 成员卡片 title 指向「AI 设置」', agentCard != null && /^打开 .+ 的 AI 设置$/.test(agentCard.getAttribute('title') || ''), agentCard?.getAttribute('title'));

    const routeBefore = window.location.hash;
    agentCard?.click();
    await until(() => q('[aria-label="运行渠道"]'), 'AI 设置弹窗', 10000);
    await wait(400);
    extra.afterClick = {
      route: window.location.hash,
      detail: qa('[data-zs-member-detail]').length,
      modal: q('[aria-label="运行渠道"]') != null,
      nameField: q('[data-zs-member-name]') != null,
      text: (q('.modal')?.innerText || document.body.innerText || '').slice(0, 300),
    };
    check('点击卡片后仍停留在成员管理页（未跳成员详情）', extra.afterClick.route === routeBefore && extra.afterClick.route.includes('/members'), extra.afterClick.route);
    check('点击卡片不会挂载成员详情页', extra.afterClick.detail === 0, extra.afterClick.detail);
    check('点击卡片直接打开 AI 设置弹窗', extra.afterClick.modal === true);
    check('AI 设置弹窗包含名称/说明与渠道字段', extra.afterClick.nameField === true && extra.afterClick.text.includes('AI 设置'), extra.afterClick.text);

    return { ok: checks.every((c) => c.ok), checks, extra };
  };

  window.finish = async () => {
    // 关闭弹窗；旧深链应重定向回成员管理。
    const cancel = qa('.modal button').find((b) => (b.textContent || '').trim() === '取消');
    cancel?.click();
    await wait(300);
    window.location.hash = '#' + legacyRoute;
    await until(() => window.location.hash.includes('/members') && q('[data-zs-member-card]') != null, '旧深链重定向', 20000);
    await wait(500);
    const final = {
      route: window.location.hash,
      detail: qa('[data-zs-member-detail]').length,
      cards: qa('[data-zs-member-card]').length,
      modal: q('[aria-label="运行渠道"]') != null,
    };
    checks.push({ name: '旧成员详情深链重定向回成员管理', ok: final.route.includes('/members') && final.detail === 0 && final.cards > 0, detail: final });
    return { ok: checks.every((c) => c.ok), checks, extra, final };
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
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r203-anim\\">*,*::before,*::after{animation:none !important;transition:none !important}</style>")'); } catch {}
      try { await js(fs.readFileSync(SCENES, 'utf8')); console.log('STAGE scenes-ok'); } catch (e) { console.error('STAGE scenes-fail ' + String(e)); throw e; }
      win.webContents.on('console-message', (_e, _level, message) => { try { fs.appendFileSync(path.join(OUT, 'console.log'), message + '\n'); } catch {} });
      console.log('STAGE run-start');
      const result = await js('window.run().catch((e) => ({ ok: false, checks: [], error: String((e && e.stack) || e) }))');
      console.log('STAGE run-done ' + JSON.stringify({ ok: result.ok, error: result.error, checks: (result.checks || []).length }));
      await sleep(1200);
      try { win.webContents.invalidate(); await sleep(300); fs.writeFileSync(path.join(OUT, '01-member-card-ai-settings.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot modal fail ' + e); }
      const finish = await js('window.finish().catch((e) => ({ ok: false, checks: [], error: String((e && e.stack) || e) }))');
      await sleep(1200);
      try { win.webContents.invalidate(); await sleep(300); } catch {}
      try { fs.writeFileSync(path.join(OUT, '02-legacy-route-redirected.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot redirect fail ' + e); }
      const checks = [...(result.checks || []), ...((finish.checks || []).slice((result.checks || []).length))];
      if (result.error || finish.error) { console.error('SCENE_ERROR ' + (result.error || finish.error)); fs.writeFileSync(RESULT, JSON.stringify({ ok: false, checks, extra: { ...(result.extra || {}), finish }, error: result.error || finish.error }, null, 2)); app.quit(); return; }
      const finalResult = { ok: checks.every((c) => c.ok), checks, extra: { ...result.extra, finish } };
      fs.writeFileSync(RESULT, JSON.stringify(finalResult, null, 2));
      console.log('R203_RESULT ' + JSON.stringify({ ok: finalResult.ok, checks: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R203_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const wrapperPath = path.join(run, 'main.cjs');
const scenesPath = path.join(run, 'r203-scenes.js');

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
    const meta = JSON.parse(fs.readFileSync(path.join(data, 'guide-fixture.json'), 'utf8'));
    fs.writeFileSync(scenesPath, scenesSource
      .split('__PROJECT_ID__').join(JSON.stringify(meta.projectId))
      .split('__MEMBER_ID__').join(JSON.stringify(meta.claude)));
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
