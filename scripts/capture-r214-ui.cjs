/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R214 下拉选择回归（隔离数据 + 假运行时；零真实模型、不安装、不打包）。
 *
 * 用户反馈：AI 设置里选择渠道后，下拉选项不会自动关闭（截图里 Codex 已选中，
 * 列表仍然展开）。根因是设置行的 <label> 包裹了自绘 listbox：点击选项的 click
 * 冒泡到 label 后，label 的激活行为会向内部 combobox 按钮补发一次 click，把
 * `open` 重新打开。本脚本在真实 UI 里断言：
 *  - 点击渠道选项后 `.select-pop` 消失、`aria-expanded=false`、按钮显示新渠道；
 *  - 同一弹窗里的「思考等级」等其它 label 内下拉同样自动关闭；
 *  - 选项点击只触发一次选择（值变化正确，不需要再点一次）。
 *
 * 用法：node scripts/capture-r214-ui.cjs [--run=name]
 * 产物：dist/r214-ui/<run>/（截图 + result.json + summary.json + 日志）
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
const run = path.join(root, 'dist', 'r214-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r213-workspace', runName);
const project = path.join(workspace, '读书会筹备');
fs.rmSync(run, { recursive: true, force: true });
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r213-' + randomUUID(),
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
  const combo = (label) => q('[role="combobox"][aria-label="' + label + '"]');
  const popup = () => q('.select-pop');
  /** 模拟一次真实鼠标点击：click 冒泡到 label 后浏览器会向内部按钮补发 click。 */
  const userClick = (el) => {
    el.scrollIntoView({ block: 'center' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, detail: 1, view: window }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, view: window }));
  };
  /** 关闭当前任何展开的下拉（点击外部），让每项检查互不影响。 */
  const closeAnyPopup = async () => {
    if (popup() == null) return;
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(180);
  };
  /** 打开下拉并点选某个选项，返回选择前后的可观察状态。 */
  const choose = async (label, value) => {
    await closeAnyPopup();
    const button = combo(label);
    if (button == null) throw Error('缺少下拉：' + label);
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    await until(() => popup(), label + ' 下拉展开');
    const target = qa('.select-pop [role="option"]').find((o) => o.dataset.zsOption === value);
    if (target == null) throw Error('缺少选项：' + label + ':' + value + '（' + qa('.select-pop [role="option"]').map((o) => o.dataset.zsOption).join(',') + '）');
    const before = { expanded: button.getAttribute('aria-expanded'), pop: popup() != null, value: (button.textContent || '').trim() };
    userClick(target);
    // 真实交互里点击在下一帧完成；等两帧再看结果（修复前这里会重新展开）。
    await wait(260);
    const afterButton = combo(label);
    const after = { expanded: afterButton?.getAttribute('aria-expanded'), pop: popup() != null, value: (afterButton?.textContent || '').trim() };
    return { before, after, option: value };
  };
  window.__r213 = {};
  window.run = async () => {
    const membersRoute = '/project/' + __PROJECT_ID__ + '/members';
    window.location.hash = '#' + membersRoute;
    await until(() => q('[data-zs-member-card]') != null && qa('[data-zs-member-bind]').length > 0, '成员管理卡片', 30000);
    await wait(800);
    qa('[data-zs-member-bind]')[0].click();
    await until(() => combo('运行渠道') != null, 'AI 设置弹窗', 10000);
    await wait(500);
    check('AI 设置弹窗打开', combo('运行渠道') != null);

    // ① 重新选一个与当前值不同的渠道：选择后必须自动关闭。
    const current = combo('运行渠道').textContent.trim();
    const targetChannel = /Codex/i.test(current) ? 'claude' : 'codex';
    window.__r213.currentChannel = current;
    const channel = await choose('运行渠道', targetChannel);
    window.__r213.channel = channel;
    check('渠道：选择前下拉展开', channel.before.expanded === 'true' && channel.before.pop === true, channel.before);
    check('渠道：选择后下拉自动关闭', channel.after.expanded === 'false' && channel.after.pop === false, channel.after);
    check('渠道：按钮显示新渠道', channel.after.value.length > 0 && channel.after.value !== channel.before.value, { before: channel.before.value, after: channel.after.value });
    await wait(300);

    // ② 同一弹窗里的「思考等级」下拉（同样在 <label> 里）：选择后也必须自动关闭。
    const effort = await choose('思考等级', 'medium').catch(async (error) => {
      // 模型清单读取失败时可能只有「渠道默认」；容器/状态仍要保证能关。
      await closeAnyPopup();
      const button = combo('思考等级');
      button.click();
      await until(() => popup(), '思考等级下拉展开');
      const option = qa('.select-pop [role="option"]').find((o) => o.dataset.zsOption !== '');
      if (option == null) { await closeAnyPopup(); return { before: null, after: { expanded: button.getAttribute('aria-expanded'), pop: popup() != null }, option: null, error: String(error) }; }
      userClick(option);
      await wait(260);
      return { before: null, after: { expanded: combo('思考等级')?.getAttribute('aria-expanded'), pop: popup() != null }, option: option.dataset.zsOption };
    });
    window.__r213.effort = effort;
    if (effort.option == null) checks.push({ name: '思考等级：无可用选项时跳过', ok: true, skipped: true, detail: effort });
    else check('思考等级：选择后下拉自动关闭', effort.after.expanded === 'false' && effort.after.pop === false, effort.after);
    await closeAnyPopup();

    // ②b 高级设置里的「权限模式」下拉（同样在 <label> 里，选项更多）：选择后也必须自动关闭。
    const advanced = qa('details').find((d) => ((d.querySelector('summary') || {}).textContent || '').includes('高级'));
    if (advanced != null) advanced.open = true;
    await wait(250);
    const permission = await choose('权限模式', 'plan');
    window.__r213.permission = permission;
    check('权限模式：选择后下拉自动关闭', permission.after.expanded === 'false' && permission.after.pop === false, permission.after);
    if (advanced != null) advanced.open = false;
    await wait(150);

    // ③ 关闭弹窗，成员列表的状态筛选下拉（label.field.inline 包裹）也要自动关闭。
    const cancel = qa('.modal button').find((b) => (b.textContent || '').trim() === '取消');
    cancel?.click();
    await wait(400);
    const filter = await choose('成员启用状态筛选', 'enabled');
    window.__r213.filter = filter;
    check('成员状态筛选：选择后下拉自动关闭', filter.after.expanded === 'false' && filter.after.pop === false, filter.after);
    return { ok: checks.every((c) => c.ok), checks, extra: window.__r213 };
  };
  /** 截图前：重新打开 AI 设置并展开渠道下拉。 */
  window.finish = async () => {
    await closeAnyPopup();
    const bind = qa('[data-zs-member-bind]')[0];
    if (bind == null) return { ok: false, reason: '缺少 AI 成员卡片' };
    bind.click();
    await until(() => combo('运行渠道') != null, 'AI 设置弹窗', 10000);
    await wait(500);
    const button = combo('运行渠道');
    button.click();
    await until(() => popup(), '渠道下拉展开');
    const options = qa('.select-pop [role="option"]').map((o) => o.dataset.zsOption);
    const target = options.find((v) => v === 'codex') ?? options[0];
    window.__r213.finishTarget = target;
    qa('.select-pop [role="option"]').find((o) => o.dataset.zsOption === target)?.scrollIntoView({ block: 'center' });
    await wait(300);
    return { ok: true, target, expanded: button.getAttribute('aria-expanded'), pop: popup() != null, value: (button.textContent || '').trim() };
  };
  /** 截图前：点选目标渠道，返回点击后的状态（修复前下拉会重新展开）。 */
  window.finish2 = async () => {
    const target = window.__r213.finishTarget;
    const option = qa('.select-pop [role="option"]').find((o) => o.dataset.zsOption === target);
    if (option == null) return { ok: false, reason: '缺少目标选项' };
    userClick(option);
    await wait(400);
    const button = combo('运行渠道');
    const state = { ok: true, target, expanded: button?.getAttribute('aria-expanded'), pop: popup() != null, value: (button?.textContent || '').trim() };
    window.__r213.finish2 = state;
    return state;
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
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r213-anim\\">*,*::before,*::after{animation:none !important;transition:none !important}</style>")'); } catch {}
      try { await js(fs.readFileSync(SCENES, 'utf8')); console.log('STAGE scenes-ok'); } catch (e) { console.error('STAGE scenes-fail ' + String(e)); throw e; }
      win.webContents.on('console-message', (_e, _level, message) => { try { fs.appendFileSync(path.join(OUT, 'console.log'), message + '\n'); } catch {} });
      console.log('STAGE run-start');
      const shot = async (name) => { try { win.webContents.invalidate(); await sleep(300); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot fail ' + name + ' ' + e); } };
      const result = await js('window.run().catch((e) => ({ ok: false, checks: [], error: String((e && e.stack) || e) }))');
      console.log('STAGE run-done ' + JSON.stringify({ ok: result.ok, error: result.error, checks: (result.checks || []).length }));
      if (result.error) await shot('99-error.png');
      const checks = result.checks || [];
      if (result.error) { fs.writeFileSync(RESULT, JSON.stringify({ ok: false, checks, extra: result.extra || {}, error: result.error }, null, 2)); app.quit(); return; }
      const finish = await js('window.finish().catch((e) => ({ ok: false, error: String((e && e.stack) || e) }))');
      await sleep(1200);
      await shot('01-channel-dropdown-open.png');
      const finish2 = await js('window.finish2().catch((e) => ({ ok: false, error: String((e && e.stack) || e) }))');
      await sleep(800);
      await shot('02-after-picking-channel.png');
      checks.push({ name: '截图场景：点选渠道后下拉关闭', ok: finish2 && finish2.expanded === 'false' && finish2.pop === false && finish2.ok === true, detail: { finish, finish2 } });
      const finalResult = { ok: checks.every((c) => c.ok), checks, extra: { ...(result.extra || {}), finish, finish2 } };
      fs.writeFileSync(RESULT, JSON.stringify(finalResult, null, 2));
      console.log('R214_RESULT ' + JSON.stringify({ ok: finalResult.ok, checks: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R214_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const wrapperPath = path.join(run, 'main.cjs');
const scenesPath = path.join(run, 'r213-scenes.js');

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
      .split('__PROJECT_ID__').join(JSON.stringify(meta.projectId)));
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
