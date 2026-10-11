#!/usr/bin/env node
/** R75 接手收尾：自有隐藏 Electron 窗口 × 正式命令 × 独立内存库。
 * node scripts/verify-r75-completion.cjs [--src desktop-daily-win-v14]
 * 每个场景单独 profile/DB；真实按钮 + 确定性保持真实回执；无用户数据/模型调用。
 * 必要判据均进入总 pass 和退出码；发布启动器另行验证，不混称。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { build } = require('esbuild');
const repo = path.resolve(__dirname, '..');
const scenarios = ['normal', 'cancel-open', 'cancel-load', 'cancel-load-failure', 'cancel-external', 'overlap-open', 'overlap-load', 'overlap-registry', 'overlap-late-failure', 'old-modal-new-modal'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function parent() {
  const srcIndex = process.argv.indexOf('--src');
  const renderer = srcIndex < 0 ? path.join(repo, 'dist/ui/renderer')
    : path.join(repo, 'dist/desktop', process.argv[srcIndex + 1], 'ZhongshuoDual/resources/app/dist/ui/renderer');
  const out = path.join(repo, 'dist/desktop', `r75-completion-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const entry = path.join(out, 'daemon.ts');
  fs.writeFileSync(entry, `
import { openDatabase } from ${JSON.stringify(path.join(repo, 'src/persistence/db.ts'))};
import { dispatchDaemonCommand } from ${JSON.stringify(path.join(repo, 'src/daemon/commands.ts'))};
export { openDatabase, dispatchDaemonCommand };
`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(out, 'daemon.cjs'), external: ['better-sqlite3'], logLevel: 'silent' });
  const reports = [];
  for (const name of scenarios) {
    const dir = path.join(out, name); fs.mkdirSync(dir);
    const child = spawn(require('electron'), [__filename, '--child', dir, renderer, name], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    fs.writeFileSync(path.join(dir, 'process.log'), log);
    const reportPath = path.join(dir, 'result.json');
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { pass: false, error: 'missing report' };
    reports.push({ name, code, ...report });
    console.log(JSON.stringify({ name, code, pass: report.pass, error: report.error }));
  }
  const summary = { renderer, scope: 'isolated hidden UI + current formal commands; not launcher certification', pass: reports.length === scenarios.length && reports.every((r) => r.pass && r.code === 0 && r.realCalls === 0), reports };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ out, pass: summary.pass }));
  process.exitCode = summary.pass ? 0 : 1;
}

async function child() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const [, , , out, renderer, name] = process.argv;
  app.setPath('userData', path.join(out, 'profile'));
  await app.whenReady();
  const { openDatabase, dispatchDaemonCommand } = require(path.join(out, '../daemon.cjs'));
  const db = openDatabase(':memory:');
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: out };
  let seq = 0, pick = null, hold = null;
  const raw = async (method, params) => {
    const result = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `own-completion-${++seq}`, method, params });
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    return result;
  };
  const dirs = {}, ids = {};
  for (const label of ['A', 'B', 'C']) {
    dirs[label] = path.join(out, `项目${label}`); fs.mkdirSync(dirs[label]); fs.writeFileSync(path.join(dirs[label], `${label}.md`), `# 项目${label}\n`);
    if (label !== 'C') ids[label] = (await raw('project.open', { path: dirs[label] })).data.project.id;
  }
  await raw('app.settings.set', { key: 'ui.autoOpenProjectPath', value: dirs.A });
  const calls = [], errors = [], facts = {};
  ipcMain.handle('zs-command', async (_e, env) => {
    calls.push({ method: env.method, params: env.params });
    const reply = await dispatchDaemonCommand(deps, env);
    if (hold != null && !hold.entered && hold.match(env)) {
      const current = hold; current.entered = true;
      await current.promise;
      if (current.fail) return { ok: false, error: { code: 'OWN_READ_FAILURE', message: 'own controlled late read failure' } };
    }
    return reply;
  });
  ipcMain.handle('own-pick', () => pick);
  const preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('zs',{command:e=>ipcRenderer.invoke('zs-command',e),pickFolder:()=>ipcRenderer.invoke('own-pick'),openPath:async()=>'',onDisconnect:()=>{},onReconnected:()=>{}});`);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
    fs.readFile(path.join(renderer, rel), (error, data) => {
      if (error) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('content-type', ({ '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' })[path.extname(rel)] ?? 'application/octet-stream'); res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const win = new BrowserWindow({ show: false, width: 1600, height: 900, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, details) => { if (details?.level === 'error') errors.push(details.message); });
  win.webContents.on('render-process-gone', (_e, details) => errors.push(`renderer gone: ${details.reason}`));
  const js = (expr) => win.webContents.executeJavaScript(expr, true);
  const wait = async (fn, label, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(50); }
    throw new Error(`timeout ${label}`);
  };
  const snapshot = () => js(`({hash:location.hash,title:document.querySelector('#zs-titlebar')?.textContent,lastPath:localStorage.getItem('zs.lastProjectPath'),modal:!!document.querySelector('.modal'),toasts:[...document.querySelectorAll('.toast-host .toast')].map(x=>x.textContent)})`);
  const choose = async (label) => {
    pick = dirs[label];
    await js(`[...document.querySelectorAll('.side-item')].find(b=>b.textContent.includes('打开/切换项目')).click();true`);
    await wait(() => js(`document.querySelector('.modal input[readonly]')?.value === ${JSON.stringify(pick)}`), `picker ${label}`);
  };
  const submit = () => js(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.includes('打开这个目录')).click();true`);
  const cancel = () => js(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='取消').click();true`);
  const beginHold = (phase) => {
    let release; const promise = new Promise((r) => { release = r; });
    hold = { entered: false, promise, release, fail: name.includes('failure'), match: (e) => phase === 'external' ? e.method === 'deepLink.resolve' : phase === 'registry' ? e.method === 'project.list' : phase === 'open'
      ? e.method === 'project.open' && e.params.path === dirs.B
      : e.method === 'member.list' && e.params.projectId === ids.B && e.params.roomId == null };
  };
  let pass = false, failure;
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/index.html`);
    await wait(() => js(`document.querySelector('#zs-titlebar')?.textContent.includes('项目A')`), 'boot A');
    const roomA = db.prepare('SELECT id FROM rooms WHERE project_id=? LIMIT 1').get(ids.A).id;
    await js(`location.hash=${JSON.stringify(`#/project/${ids.A}/room/${roomA}`)};true`);
    await wait(() => js(`!!document.querySelector('.pool-head')`), 'A room');
    facts.before = await snapshot();
    if (name !== 'normal') beginHold(name.includes('external') ? 'external' : name.includes('registry') ? 'registry' : name.includes('open') ? 'open' : 'load');
    if (name === 'cancel-external') {
      const room = db.prepare('SELECT id FROM rooms WHERE project_id=? LIMIT 1').get(ids.B);
      const conversation = db.prepare("SELECT id FROM conversations WHERE project_id=? AND kind='room' LIMIT 1").get(ids.B);
      await raw('message.submit', { target: { kind: 'room_root', projectId: ids.B, roomId: room.id, conversationId: conversation.id }, body: 'OWN-EXTERNAL-CANCEL', intent: 'record_only', mentions: [] });
      const msg = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%OWN-EXTERNAL-CANCEL%' LIMIT 1").get();
      await js(`location.hash=${JSON.stringify('#msg=' + msg.id)};true`);
    } else { await choose('B'); await submit(); }
    if (name === 'normal') {
      await wait(() => js(`!document.querySelector('.modal') && document.querySelector('#zs-titlebar')?.textContent.includes('项目B')`), 'B complete');
    } else {
      await wait(() => hold.entered, 'pending B'); facts.pending = await snapshot();
      if (name !== 'cancel-external') {
        await cancel();
        await wait(() => js(`!document.querySelector('.modal')`), 'cancel modal');
      }
      if (name.startsWith('cancel')) {
        await js(`[...document.querySelectorAll('.side-item')].find(b=>b.textContent.trim()==='设置').click();true`);
        await wait(() => js(`location.hash.startsWith('#/settings')`), 'settings');
      } else {
        await choose('C');
        if (name !== 'old-modal-new-modal') {
          await submit();
          await wait(() => js(`!document.querySelector('.modal') && document.querySelector('#zs-titlebar')?.textContent.includes('项目C')`), 'C complete');
          ids.C = db.prepare('SELECT id FROM projects WHERE root_path=?').get(dirs.C).id;
        }
      }
      facts.newer = await snapshot(); hold.release(); await sleep(1600);
    }
    facts.after = await snapshot();
    facts.prefs = db.prepare('SELECT active_project_id FROM navigation_preferences WHERE client_id=?').get('desktop-hifi')?.active_project_id;
    const final = facts.after;
    if (name === 'normal') pass = final.hash.includes(ids.B) && final.lastPath === dirs.B && facts.prefs === ids.B;
    else if (name.startsWith('cancel')) pass = final.hash.startsWith('#/settings') && final.title.includes('项目A') && final.lastPath === dirs.A && facts.prefs !== ids.B;
    else if (name === 'old-modal-new-modal') pass = final.modal && await js(`document.querySelector('.modal input[readonly]')?.value===${JSON.stringify(dirs.C)}`);
    else pass = final.hash.includes(ids.C) && final.title.includes('项目C') && final.lastPath === dirs.C && facts.prefs === ids.C;
    pass = pass && final.toasts.length === 0 && errors.length === 0;
    fs.writeFileSync(path.join(out, 'final.png'), (await win.webContents.capturePage()).toPNG());
  } catch (e) { failure = String(e.stack ?? e); }
  finally {
    hold?.release(); await sleep(150);
    const realCalls = db.prepare('SELECT count(*) n FROM real_calls').get().n;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ pass: pass && !failure && realCalls === 0, realCalls, facts, errors, calls, error: failure }, null, 2));
    win.destroy(); server.close(); db.close(); app.exit(pass && !failure && realCalls === 0 ? 0 : 1);
  }
}
if (process.versions.electron) void child().catch((e) => { console.error(e); require('electron').app.exit(1); });
else void parent().catch((e) => { console.error(e); process.exitCode = 1; });
