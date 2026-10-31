#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** Never builds. node scripts/verify-r134-broadcast.cjs
 * Optional --main PATH --daemon PATH --out DIR --electron PATH (also supports package entries).
 * Current worktree formal Fake worker seeds ordinary @all, then genuine main/daemon render it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? path.resolve(args[i + 1]) : null; };
const mainEntry = option('--main') ?? path.join(root, 'dist/ui/main.cjs');
const daemonEntry = option('--daemon') ?? path.join(root, 'dist/pack/daemon.cjs');
const electron = option('--electron') ?? require('electron');
const run = option('--out') ?? path.join(root, 'dist/r134-broadcast', randomUUID());
fs.mkdirSync(run, { recursive: true });
const data = path.join(run, 'data');
if (fs.existsSync(data)) throw Error('Refusing existing application data directory: ' + data);
const summaryPath = path.join(run, 'summary.json');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_APP_MODE: 'fake-sim',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r134-broadcast-' + randomUUID(), ZS_DAEMON_ENTRY: daemonEntry, ZS_PACKAGED_UI: '1', ZS_NODE_BIN: process.execPath,
  NODE_PATH: [path.join(root, 'node_modules'), env.NODE_PATH].filter(Boolean).join(path.delimiter),
});

function electronProof(config) {
  const { app, ipcMain } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const meta = JSON.parse(fs.readFileSync(path.join(config.data, 'fixture.json'), 'utf8'));
  const result = { ok: false, syntheticOnly: true, run: config.run, main: config.main, daemon: config.daemon, entryHashes: config.entryHashes,
    seedSource: config.seedSource, startedAt: new Date().toISOString(), checks: [], receipts: [], screenshots: [] };
  const save = () => fs.writeFileSync(config.summaryPath, JSON.stringify(result, null, 2));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, pass, evidence) => { result.checks.push({ name, pass: !!pass, evidence }); save(); };
  // Observe the official bridge without modifying requests, receipts or renderer state.
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, channel !== 'zs:command' ? handler : async (event, envelope) => {
    const trace = { method: envelope.method, params: envelope.params, requestedAt: Date.now() };
    result.receipts.push(trace);
    try { const reply = await handler(event, envelope); trace.deliveredAt = Date.now(); trace.ok = reply?.ok; return reply; }
    catch (error) { trace.error = String(error); throw error; }
  });
  const snapshot = () => {
    const read = spawnSync(config.node, [config.seed, 'snapshot', config.data], { cwd: config.root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 12000 });
    if (read.status !== 0) throw Error('Synthetic DB snapshot failed: ' + read.stderr);
    return JSON.parse(read.stdout);
  };
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const closer = setInterval(() => { if (fs.existsSync(path.join(config.run, 'close-request'))) app.quit(); }, 250);
  app.once('will-quit', () => clearInterval(closer));
  const watchdog = setTimeout(() => { result.error = 'Electron verifier exceeded 60 seconds'; save(); app.quit(); }, 60000);
  let handled = false;
  app.on('browser-window-created', (_event, win) => {
    win.show = () => {};
    win.webContents.setBackgroundThrottling(false);
    win.webContents.once('did-finish-load', async () => {
      if (handled) return; handled = true;
      const js = code => win.webContents.executeJavaScript(code, true);
      const until = async (name, fn, timeout = 12000) => {
        const start = Date.now(); let last;
        while (Date.now() - start < timeout) { last = await fn(); if (last) return last; await delay(30); }
        throw Error('Timeout: ' + name + '; last=' + JSON.stringify(last));
      };
      const messages = () => js(`Array.from(document.querySelectorAll('.msg')).map(e=>({id:e.id,author:e.querySelector('.msg-author')?.textContent?.trim()??null,text:e.innerText,body:e.querySelector('.msg-content')?.innerText??e.innerText}))`);
      const shot = async name => {
        win.setSize(1361, 920); await delay(60); win.setSize(1360, 920); await delay(180);
        const file = path.join(config.run, name + '.png');
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); result.screenshots.push(file); return file;
      };
      const verifyReplies = async stage => {
        const rows = await messages();
        for (const member of meta.members) {
          const persisted = result.before.replies.filter(r => r.author_id === member.id);
          const visible = rows.filter(r => r.author === member.name && r.text.includes(member.answer));
          const event = persisted[0] && result.before.replyEvents.find(e => e.payload.messageId === persisted[0].id);
          const turn = event && result.before.turns.find(t => t.id === event.turn_id);
          const run = turn && result.before.runs.find(r => r.id === turn.run_id);
          check(stage + ': ' + member.name + ' real author/turn and one visible reply', persisted.length === 1 && persisted[0].body.text === member.answer
            && visible.length === 1 && visible[0].id === 'thread-msg-' + persisted[0].id
            && turn?.member_id === member.id && turn?.status === 'SUCCEEDED' && run?.status === 'SUCCEEDED'
            && event?.task_id === run?.task_id && persisted[0].task_id === run?.task_id, { persisted, visible, event, turn, run });
        }
        const agents = rows.filter(r => meta.members.some(m => m.name === r.author));
        check(stage + ': exactly two distinct rendered member replies', agents.length === 2 && new Set(agents.map(r => r.id)).size === 2, agents);
        return rows;
      };
      try {
        win.setSize(1360, 920);
        await until('formal app and daemon bridge', () => js(`!!window.zs?.command&&!!document.querySelector('.side-item.sub')`));
        result.daemonPid = Number(fs.readFileSync(path.join(config.data, 'daemon.pid'), 'utf8'));
        check('real daemon is a separate process', result.daemonPid > 0 && result.daemonPid !== process.pid, result.daemonPid);
        check('independent test window stays hidden', !win.isVisible());
        result.before = snapshot();
        check('ordinary @all has no deliberate collaboration', !Object.hasOwn(meta.submitParams, 'collaboration') && meta.submitParams.mentions.length === 1 && meta.submitParams.mentions[0].kind === 'all', meta.submitParams);
        check('formal Fake worker started exactly the two member turns', meta.fakeStartTurns === 2 && result.before.turns.length === 2 && new Set(result.before.turns.map(t => t.member_id)).size === 2, result.before.turns);
        check('ordinary broadcast has no synthesis turn or pending executable work', result.before.integrationAttempts === 0 && result.before.pendingOutbox.length === 0 && result.before.coordination.every(r => r.integration_run_id === null && r.state === 'completed'), result.before.coordination);
        // The first sidebar paint precedes the restored startup destination.
        // Wait for its real pool read before choosing the fixture room as a user.
        await until('startup room pool loaded', () => result.receipts.some(r => r.method === 'room.pool' && r.deliveredAt && r.ok));
        await js(`(()=>{const e=Array.from(document.querySelectorAll('.side-item.sub')).find(el=>el.textContent.includes('R134 普通全体广播'));if(!e)throw Error('Fixture sidebar room missing');e.click();})()`);
        await until('ordinary broadcast root card', () => js(`!!Array.from(document.querySelectorAll('.root-card')).find(e=>e.textContent.includes('R134 普通广播'))`));
        result.click = await js(`(()=>{const e=Array.from(document.querySelectorAll('.root-card')).find(e=>e.textContent.includes('R134 普通广播'));const proof={method:'HTMLElement.click',id:e.id,text:e.innerText};e.click();return proof;})()`);
        await until('real thread history and both replies', () => js(`${JSON.stringify(meta.members)}.every(m=>Array.from(document.querySelectorAll('.msg')).some(e=>e.querySelector('.msg-author')?.textContent.trim()===m.name&&e.innerText.includes(m.answer)))`));
        check('genuine thread.history receipt came through official daemon bridge', result.receipts.some(r => r.method === 'thread.history' && r.params?.threadId === meta.broadcast.threadId && r.ok), result.receipts.filter(r => r.method === 'thread.history'));
        result.initialUi = await verifyReplies('initial');
        await shot('ordinary-broadcast-two-authors');
        const reads = result.receipts.filter(r => r.method === 'thread.history' && r.params?.threadId === meta.broadcast.threadId && r.ok).length;
        await delay(5400);
        const laterReads = result.receipts.filter(r => r.method === 'thread.history' && r.params?.threadId === meta.broadcast.threadId && r.ok).length;
        check('automatic refresh performs another genuine history read', laterReads > reads, { reads, laterReads });
        result.afterPollUi = await verifyReplies('automatic refresh');
        win.webContents.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await until('cold renderer reload shows both replies', () => js(`${JSON.stringify(meta.members)}.every(m=>Array.from(document.querySelectorAll('.msg')).some(e=>e.querySelector('.msg-author')?.textContent.trim()===m.name&&e.innerText.includes(m.answer)))`));
        result.afterReloadUi = await verifyReplies('renderer reload');
        await shot('ordinary-broadcast-after-reload');
        result.after = snapshot();
        check('no persisted replies duplicated after poll/reload', JSON.stringify(result.before.replies) === JSON.stringify(result.after.replies));
        check('UI reads do not create more turns or workflow runs', JSON.stringify(result.before.turns) === JSON.stringify(result.after.turns) && JSON.stringify(result.before.runs) === JSON.stringify(result.after.runs));
        check('zero real business calls before and after official UI', result.before.realCalls === 0 && result.after.realCalls === 0);
        result.realBusinessCalls = result.after.realCalls;
        result.ok = result.checks.every(c => c.pass);
      } catch (error) {
        result.error = error.stack ?? String(error);
        try { result.failureUi = await js('document.body.innerText'); result.failureDb = snapshot(); await shot('failure'); } catch (captureError) { result.captureError = String(captureError); }
      } finally { clearTimeout(watchdog); result.finishedAt = new Date().toISOString(); save(); win.close(); }
    });
  });
  require(config.main);
}

async function main() {
  for (const entry of [mainEntry, daemonEntry]) if (!fs.existsSync(entry)) throw Error('Build entry missing (verifier never builds): ' + entry);
  const seed = path.join(run, 'seed.cjs');
  await require('esbuild').build({ entryPoints: [path.join(root, 'scripts/lib/r134-broadcast-fixture.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: seed, logLevel: 'silent' });
  const seeded = spawnSync(process.execPath, [seed, 'seed', data, path.join(run, 'synthetic-project')], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout ?? '') + '\n' + (seeded.stderr ?? ''));
  if (seeded.status !== 0) throw Error('Synthetic worker seed failed: ' + seeded.stderr);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const files = [mainEntry, daemonEntry, path.join(path.dirname(mainEntry), 'renderer/hifi/app.mjs'), path.join(path.dirname(mainEntry), 'renderer/hifi/app.css')];
  const config = { root, run, data, seed, node: process.execPath, main: mainEntry, daemon: daemonEntry, summaryPath,
    seedSource: 'current worktree formal commands and DispatchWorker; runtime main/daemon entries selected independently', entryHashes: Object.fromEntries(files.map(file => [file, hash(file)])) };
  const wrapper = path.join(run, 'electron-main.cjs');
  fs.writeFileSync(wrapper, `(${electronProof.toString()})(${JSON.stringify(config)});`);
  const log = fs.openSync(path.join(run, 'electron.log'), 'w');
  const child = spawn(electron, [wrapper], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
  let timedOut = false, daemonPid = null;
  const watch = setInterval(() => { try { daemonPid = Number(fs.readFileSync(path.join(data, 'daemon.pid'), 'utf8')); } catch { /* startup/shutdown */ } }, 200);
  const requestClose = () => { timedOut = true; fs.writeFileSync(path.join(run, 'close-request'), 'close'); };
  process.once('SIGINT', requestClose); process.once('SIGTERM', requestClose);
  const deadline = setTimeout(requestClose, 70000);
  const killer = setTimeout(() => { timedOut = true; if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); }, 85000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearInterval(watch); clearTimeout(deadline); clearTimeout(killer); process.removeListener('SIGINT', requestClose); process.removeListener('SIGTERM', requestClose); fs.closeSync(log); }
  const result = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : { ok: false, error: 'No Electron summary' };
  result.daemonPid ??= daemonPid;
  const shutdown = path.join(data, 'desktop-shutdown.json');
  result.cleanup = { electronExitCode: code, timedOut, pidFileRemoved: !fs.existsSync(path.join(data, 'daemon.pid')), shutdown: fs.existsSync(shutdown) ? JSON.parse(fs.readFileSync(shutdown, 'utf8')) : null };
  if (result.daemonPid) { try { process.kill(result.daemonPid, 0); result.cleanup.daemonAlive = true; } catch { result.cleanup.daemonAlive = false; } }
  if (result.cleanup.daemonAlive) { spawnSync('taskkill', ['/PID', String(result.daemonPid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); result.cleanup.forcedDaemonCleanup = true; }
  result.entryHashesUnchanged = Object.entries(config.entryHashes).every(([file, old]) => hash(file) === old);
  result.ok = !!result.ok && code === 0 && !timedOut && result.cleanup.pidFileRemoved && result.cleanup.daemonAlive === false && result.cleanup.shutdown?.daemonStopResult?.complete === true && result.entryHashesUnchanged;
  fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, run, summary: summaryPath, checks: result.checks?.length, failures: result.checks?.filter(c => !c.pass).map(c => c.name), realBusinessCalls: result.realBusinessCalls, cleanup: result.cleanup, error: result.error }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(summaryPath, JSON.stringify({ ok: false, error: error.stack, run }, null, 2)); console.error(error); process.exitCode = 1; });
