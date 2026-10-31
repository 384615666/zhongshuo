#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** Never builds. node scripts/verify-r135-status.cjs
 * Optional --main PATH --daemon PATH --out DIR --electron PATH (also supports package entries).
 * Current worktree formal Fake worker seeds unified thread status, then genuine main/daemon render it.
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
const run = option('--out') ?? path.join(root, 'dist/r135-status', randomUUID());
fs.mkdirSync(run, { recursive: true });
const data = path.join(run, 'data');
if (fs.existsSync(data)) throw Error('Refusing existing application data directory: ' + data);
const summaryPath = path.join(run, 'summary.json');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data, ZS_RUNTIME: 'fake', ZS_FAKE_DELIB: '1', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_APP_MODE: 'fake-sim',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r135-status-' + randomUUID(), ZS_DAEMON_ENTRY: daemonEntry, ZS_PACKAGED_UI: '1', ZS_NODE_BIN: process.execPath,
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
      const shot = async name => { win.setSize(1361,920); await delay(50); win.setSize(1360,920); await delay(160); const file=path.join(config.run,name+'.png'); fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG()); result.screenshots.push(file); };
      const notice=()=>js(`(()=>{const bars=Array.from(document.querySelectorAll('[data-zs-execution-status]'));const e=bars[0];const body=e?.querySelector('[data-zs-thread-notice-body]');const r=body?.getBoundingClientRect();return{count:bars.length,phase:e?.dataset.zsExecutionPhase,text:e?.innerText,bodyText:body?.innerText,clipped:body?body.scrollWidth>body.clientWidth+1:true,bodyHeight:r?.height,legacy:document.querySelectorAll('.thread-pending').length};})()`);
      const select=async(item,label)=>{await js(`location.hash=${JSON.stringify('/project/'+meta.projectId+'/room/'+meta.roomId)}`);await until('room cards',()=>js(`!!Array.from(document.querySelectorAll('.root-card')).find(el=>el.innerText.includes(${JSON.stringify(label)}))`));await js(`Array.from(document.querySelectorAll('.root-card')).find(el=>el.innerText.includes(${JSON.stringify(label)})).click()`);await until('selected status',()=>js(`location.hash.includes(${JSON.stringify(item.threadId)})&&!!document.querySelector('[data-zs-execution-status]')`));await delay(250);};
      try {
        win.setSize(1360,920);
        await until('formal app and daemon bridge',()=>js(`!!window.zs?.command&&!!document.querySelector('.side-item.sub')`));
        result.daemonPid=Number(fs.readFileSync(path.join(config.data,'daemon.pid'),'utf8'));
        check('actual daemon separate from Electron',result.daemonPid>0&&result.daemonPid!==process.pid);
        check('hidden fixture window',!win.isVisible());result.before=snapshot();
        check('no queued business work at seed end',result.before.pendingOutbox.length===0);
        await until('startup pool read',()=>result.receipts.some(r=>r.method==='room.pool'&&r.deliveredAt&&r.ok));
        await js(`Array.from(document.querySelectorAll('.side-item.sub')).find(el=>el.innerText.includes('R135 状态验证')).click()`);
        for(const [key,label,phase]of[['failed','R135 失败后继续','FAILED'],['cancelled','R135 尚未开始','NOT_STARTED_FAILED'],['waiting','R135 等待确认','WAITING_FOR_USER'],['review','R135 等待验收','COMPLETED']]){
          await select(meta[key],label);const n=await notice();check(key+': one status and no legacy duplicate',n.count===1&&n.legacy===0,n);check(key+': exact phase',n.phase===phase,n);
          check(key+': readable full reason',!n.clipped&&n.bodyHeight>0&&n.bodyText?.length>0,n);
          if(key==='cancelled')check('confirmed not-started has plain explanation',n.bodyText.includes('AI 尚未开始'));
          if(key==='failed')check('actual member failure replaces generic no-analysis explanation',n.bodyText.includes('合成执行端暂时不可用'));
          if(key==='waiting')check('question remains visible',n.text.includes('仅饮用水还是加茶点'));
          if(key==='review')check('review retains acceptance action',n.text.includes('验收交付'));
          await shot(key+'-one-banner');
        }
        await select(meta.failed,'R135 失败后继续');win.setSize(1050,920);await delay(200);const narrow=await notice();check('narrow reason wraps without clipping',narrow.count===1&&!narrow.clipped,narrow);await shot('failed-narrow');
        await js(`document.querySelector('[data-zs-execution-details]').click()`);
        await until('reason details destination',()=>js(`document.body.innerText.includes('运行详情')&&!document.querySelector('.msg-list.is-replies')`));
        check('reason opens existing task detail',await js(`location.hash.includes(${JSON.stringify(meta.failed.threadId)})`));
        await select(meta.failed,'R135 失败后继续');
        await js(`document.querySelector('[data-zs-execution-action="retry"]').click()`);
        await until('continued run succeeds',()=>{const r=snapshot();return r.tasks.find(t=>t.id===meta.failed.taskId)?.status==='REVIEW'||r.tasks.find(t=>t.id===meta.failed.taskId)?.status==='DONE';},22000);
        const afterRetry=snapshot(),old=result.before.runs.find(r=>r.task_id===meta.failed.taskId),latest=afterRetry.runs.filter(r=>r.task_id===meta.failed.taskId).at(-1);
        check('bound formal retry command used',result.receipts.some(r=>r.method==='task.redispatch'&&r.ok));
        check('new actual member turns started after continue',afterRetry.turns.filter(t=>t.run_id===latest?.id&&t.exec_started_at!=null).length>=2);
        check('original failure preserved',afterRetry.runs.find(r=>r.id===old?.id)?.status==='FAILED');
        await select(meta.cancelled,'R135 尚未开始');await js(`document.querySelector('[data-zs-execution-action="close"]').click()`);
        await until('ended task refreshed',()=>js(`document.querySelector('[data-zs-execution-phase="CANCELLED"]')!=null`));const ended=await notice();check('ending keeps one state and clears old failure text',ended.count===1&&ended.phase==='CANCELLED'&&!ended.text.includes('启动已取消'),ended);
        result.after=snapshot();check('zero real business calls',result.after.realCalls===0);result.realBusinessCalls=result.after.realCalls;result.ok=result.checks.every(c=>c.pass);
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
  await require('esbuild').build({ entryPoints: [path.join(root, 'scripts/lib/r135-status-fixture.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: seed, logLevel: 'silent' });
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
