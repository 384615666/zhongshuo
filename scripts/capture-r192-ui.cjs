/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R192 四项反馈验证（隔离数据 + 假运行时；零真实模型、不打包、不安装）。
 *
 * 用户 2026-11-07（beta.36 之后）：
 *  1) 发送的消息支持图片预览图查看；
 *  2) 收藏支持按文字匹配的搜索；
 *  3) 对话串与私信的消息头像放大到 50×50；
 *  4) 设置页隐藏「最近一次数据操作」「从旧版本导入草稿」。
 *
 * 用法：node scripts/capture-r192-ui.cjs [--run=name]
 * 产物：dist/r192-ui/<run>/（截图 + summary.json）
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
const run = path.join(root, 'dist', 'r192-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r192-workspace', runName);
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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r192-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

const scenesSource = String.raw`(() => {
  const m = window.r192Meta;
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
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const body = () => document.body.innerText || '';
  const extra = {};

  window.run = async () => {
    // ── 4) 设置页隐藏两行 ──
    await go('/settings?section=data');
    await until(() => q('[data-zs-data-guide]'), '数据分区', 20000);
    await wait(600);
    const settingsText = body();
    extra.settingsText = settingsText.slice(0, 600);
    check('设置页不显示「最近一次数据操作」', !settingsText.includes('最近一次数据操作'));
    check('设置页不显示「从旧版本导入草稿」', !settingsText.includes('从旧版本导入草稿'));
    check('设置页仍保留备份与恢复入口', settingsText.includes('备份全部数据') && settingsText.includes('使用已有数据或从备份恢复'));

    // ── 3a) 对话串消息头像 50×50 ──
    await go('/thread/' + m.chat.threadId);
    await until(() => q('.msg-list.is-replies'), '回复串', 30000);
    await wait(1400);
    const threadAvatars = qa('.msg-list.is-replies .msg:not(.msg-system) .msg-avatar .avatar');
    extra.threadAvatarWidths = threadAvatars.map((el) => rect(el).w);
    check('对话串消息头像为 50×50', threadAvatars.length > 0 && threadAvatars.every((el) => rect(el).w === 50 && rect(el).h === 50), extra.threadAvatarWidths);

    // ── 1a) 对话串图片附件缩略图 ──
    let threadThumb = null;
    try { await until(() => qa('[data-zs-attachment-thumb="ready"]').length > 0, '回复串图片缩略图', 20000); threadThumb = qa('[data-zs-attachment-thumb="ready"]')[0]; } catch {}
    extra.threadThumb = threadThumb == null ? null : { cls: threadThumb.className, hasImg: threadThumb.querySelector('img') != null, srcPrefix: threadThumb.querySelector('img')?.getAttribute('src')?.slice(0, 22) ?? null };
    check('对话串图片附件显示真实缩略图', threadThumb != null && threadThumb.querySelector('img') != null, extra.threadThumb);

    // ── 3b) 私信消息头像 50×50 ──
    await go('/dm/' + m.dm);
    await until(() => q('.msg-list.is-replies'), '私信', 30000);
    await wait(1400);
    const dmAvatars = qa('.msg-list.is-replies .msg:not(.msg-system) .msg-avatar .avatar');
    extra.dmAvatarWidths = dmAvatars.map((el) => rect(el).w);
    check('私信消息头像为 50×50', dmAvatars.length > 0 && dmAvatars.every((el) => rect(el).w === 50 && rect(el).h === 50), extra.dmAvatarWidths);

    // ── 1b) 私信图片附件缩略图 ──
    let dmThumb = null;
    try { await until(() => qa('[data-zs-attachment-thumb="ready"]').length > 0, '私信图片缩略图', 20000); dmThumb = qa('[data-zs-attachment-thumb="ready"]')[0]; } catch {}
    extra.dmThumb = dmThumb == null ? null : { cls: dmThumb.className, hasImg: dmThumb.querySelector('img') != null };
    check('私信图片附件显示真实缩略图', dmThumb != null && dmThumb.querySelector('img') != null, extra.dmThumb);

    // ── 2) 收藏文字搜索 ──
    await go('/library');
    await until(() => q('[data-zs-library]'), '搜索与收藏页', 30000);
    await wait(900);
    const projectCard = q('[data-zs-library-project="' + m.projectId + '"]');
    if (projectCard != null) { projectCard.click(); await wait(700); }
    const savedTab = qa('.page-filters .thread-tab').find((el) => textOf(el).includes('收藏'));
    if (savedTab != null) { savedTab.click(); await wait(1200); }
    const savedSearch = q('[aria-label="搜索收藏"]');
    extra.savedSearchExists = savedSearch != null;
    check('收藏页有按文字搜索的输入框', savedSearch != null);
    if (savedSearch != null) {
      await until(() => qa('.card.tight').length >= 3, '收藏列表', 20000);
      extra.savedBefore = qa('.card.tight').length;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(savedSearch, '预算');
      savedSearch.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
      const filteredText = body();
      extra.savedFilteredText = filteredText.slice(0, 600);
      check('收藏搜索按文字过滤（预算只留读书会预算）', filteredText.includes('读书会预算') && !filteredText.includes('活动照片') && !filteredText.includes('场地清单'), extra.savedFilteredText);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(savedSearch, '');
      savedSearch.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(400);
      check('清空搜索后收藏恢复全部', qa('.card.tight').length === extra.savedBefore, { before: extra.savedBefore, after: qa('.card.tight').length });
    }

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
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style id=\\"r192-anim\\">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
      await js('window.r192Meta = ' + JSON.stringify(JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8'))));
      await js(fs.readFileSync(SCENES, 'utf8'));
      const result = await js('window.run()');
      const meta = JSON.parse(fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8'));
      const shots = [
        ['settings-data', '/settings?section=data'],
        ['thread', '/thread/' + meta.chat.threadId],
        ['dm', '/dm/' + meta.dm],
        ['library-saved', '/library'],
      ];
      let n = 1;
      for (const [name, route] of shots) {
        await js('window.location.hash = ' + JSON.stringify('#' + route));
        await sleep(1300);
        if (name === 'library-saved') {
          const projectSel = JSON.stringify('[data-zs-library-project="' + meta.projectId + '"]');
          await js('(() => { const p = document.querySelector(' + projectSel + '); if (p) p.click(); const t = Array.from(document.querySelectorAll(".page-filters .thread-tab")).find((el) => (el.textContent || "").includes("收藏")); if (t) t.click(); return true; })()');
          await sleep(1200);
        }
        try { const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, String(n).padStart(2,'0') + '-' + name + '.png'), shot.toPNG()); } catch (e) { console.error('shot fail ' + name + ' ' + e); }
        n += 1;
      }
      fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
      console.log('R192_RESULT ' + JSON.stringify({ ok: result.ok, checks: result.checks.length, failed: result.checks.filter((c) => !c.ok).map((c) => c.name) }));
    } catch (e) { console.error('R192_FAIL ' + String((e && e.stack) || e)); }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 420000).unref();`;

const scenesPath = path.join(run, 'r192-scenes.js');
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
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project, '--r192'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
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
