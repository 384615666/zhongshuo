#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** Never builds. node scripts/verify-r132-thread-feedback.cjs [--baseline-v69 [packageDir]]
 * Optional --main PATH --daemon PATH --electron PATH --out DIR.
 * Both baseline and candidate must satisfy identical checks; regressions exit 1.
 */
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? path.resolve(args[i + 1]) : null; };
const baseline = args.includes('--baseline-v69');
const packageRoot = option('--baseline-v69') ?? path.resolve(root, '../../dist/desktop/desktop-daily-win-v69-r129-room-navigation-20261030');
const packagedApp = path.join(packageRoot, 'ZhongshuoDual/resources/app');
const mainEntry = option('--main') ?? path.join(baseline ? packagedApp : root, 'dist/ui/main.cjs');
const daemonEntry = option('--daemon') ?? (baseline ? path.join(packagedApp, 'daemon/daemon.cjs') : path.join(root, 'dist/pack/daemon.cjs'));
const electron = option('--electron') ?? require('electron');
const run = option('--out') ?? path.join(root, 'dist/r132-feedback', (baseline ? 'baseline-v69-' : 'candidate-') + randomUUID());
// An output directory can never double as an existing application's data root.
fs.mkdirSync(run, {recursive: true});
const data = path.join(run, 'data');
if (fs.existsSync(data)) throw Error('Refusing existing data directory: ' + data);
const summaryPath = path.join(run, 'summary.json');
const env = {...process.env};
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {ZS_APP_DATA: data, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_APP_MODE: 'fake-sim',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r132-ui-' + randomUUID(), ZS_DAEMON_ENTRY: daemonEntry, ZS_PACKAGED_UI: '1', ZS_NODE_BIN: process.execPath});

function electronProof(config) {
  const {app, BrowserWindow, ipcMain} = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const {spawnSync} = require('node:child_process');
  const meta = JSON.parse(fs.readFileSync(path.join(config.data, 'fixture.json'), 'utf8'));
  const result = {ok: false, baseline: config.baseline, run: config.run, entryHashes: config.entryHashes,
    startedAt: new Date().toISOString(), checks: [], scenarios: [], screenshots: [], receipts: []};
  const save = () => fs.writeFileSync(config.summaryPath, JSON.stringify(result, null, 2));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, pass, evidence) => { result.checks.push({name, pass: !!pass, evidence}); save(); };
  let policy = null;
  const originalHandle = ipcMain.handle.bind(ipcMain);
  // Intercept the registered official bridge, preserving sender validation,
  // the real daemon pipe, real command execution, and the real reply envelope.
  ipcMain.handle = (channel, handler) => originalHandle(channel, channel !== 'zs:command' ? handler : async (event, envelope) => {
    const p = policy;
    const isThread = envelope.params?.threadId === meta.waiting.threadId;
    const isTask = envelope.params?.taskId === meta.waiting.taskId;
    const affected = p && ((isThread && ['thread.get', 'thread.history'].includes(envelope.method)) || (isTask && envelope.method === 'task.get'));
    const trace = {method: envelope.method, commandId: envelope.commandId, scenario: p?.name ?? null, requestedAt: Date.now(), params: envelope.params};
    result.receipts.push(trace);
    try {
      let reply = await handler(event, envelope);
      trace.executedAt = Date.now(); trace.realOk = reply?.ok;
      if (affected) {
        const ms = p.delays?.[envelope.method] ?? 0;
        if (ms) await delay(ms);
        if (p.historyError && envelope.method === 'thread.history') {
          trace.injected = 'history read failure after real execution';
          throw Error('R132 isolated history read fault');
        }
        if (p.staleTask && envelope.method === 'task.get') {
          trace.injected = 'genuine earlier QUEUED task.get snapshot';
          reply = {...reply, data: meta.staleTask};
        }
      }
      trace.deliveredAt = Date.now(); trace.phase = reply?.data?.executionStatus?.phase;
      return reply;
    } catch (error) { trace.failedAt = Date.now(); trace.error = String(error); throw error; }
  });
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  let handled = false;
  const stop = setInterval(() => { if (fs.existsSync(path.join(config.run, 'close-request'))) for (const win of BrowserWindow.getAllWindows()) win.close(); }, 250);
  app.once('will-quit', () => clearInterval(stop));
  const watchdog = setTimeout(() => { result.error = 'Electron proof exceeded 180 seconds'; save(); for (const win of BrowserWindow.getAllWindows()) win.close(); }, 180000);
  const snapshot = () => {
    const s = spawnSync(config.node, [config.seed, 'snapshot', config.data], {cwd: config.root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 12000});
    if (s.status !== 0) throw Error('Snapshot failed: ' + s.stderr);
    return JSON.parse(s.stdout);
  };
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
      const shot = async name => {
        // Hidden Electron windows can retain an old compositor frame. Match the
        // R128 capture nudge so the PNG reflects the verified DOM and scroll.
        win.setSize(1361, 920); await delay(60); win.setSize(1360, 920); await delay(180);
        const file = path.join(config.run, name + '.png');
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); result.screenshots.push(file); return file;
      };
      const roomRoute = `/project/${meta.projectId}/room/${meta.roomId}`;
      const bannerJs = `Array.from(document.querySelectorAll('[data-zs-execution-phase]')).find(el=>!el.closest('.root-card')&&el.getBoundingClientRect().width>0)`;
      const closeDialog = () => js(`(()=>{const d=document.querySelector('[role="dialog"]');Array.from(d?.querySelectorAll('button')??[]).find(b=>b.textContent.trim()==='关闭')?.click();})()`);
      const roomReady = async (reload = false) => {
        policy = null;
        await js(`location.hash=${JSON.stringify(roomRoute)}`);
        if (reload) { win.webContents.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve)); }
        await until('real room pool ready', () => js(`!!window.zs?.command&&!!Array.from(document.querySelectorAll('.root-card')).find(el=>el.textContent.includes('R132 等待预算')&&el.textContent.includes('等你处理'))`));
        await closeDialog(); await delay(120);
      };
      const state = () => js(`(()=>{const e=${bannerJs};return {at:Date.now(),hash:location.hash,phase:e?.dataset.zsExecutionPhase??null,text:e?.innerText??null,body:document.body.innerText,timing:window.__r132Timing??null};})()`);
      const clickWaiting = async () => js(`(()=>{
        const card=Array.from(document.querySelectorAll('.root-card')).find(el=>el.textContent.includes('R132 等待预算'));
        if(!card)throw Error('Waiting room card missing');
        window.__r132Timing={clickedAt:Date.now(),firstBannerAt:null,poolText:card.innerText,samples:[]};
        const sample=()=>{const e=${bannerJs};const t=window.__r132Timing;if(e?.dataset.zsExecutionPhase==='WAITING_FOR_USER'&&t.firstBannerAt===null)t.firstBannerAt=Date.now();if(t.samples.length<80)t.samples.push({at:Date.now(),phase:e?.dataset.zsExecutionPhase??null});};
        window.__r132Observer?.disconnect();window.__r132Observer=new MutationObserver(sample);window.__r132Observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
        card.click();sample();return window.__r132Timing.clickedAt;
      })()`);
      const scenario = async (name, fn) => {
        const row = {name}; result.scenarios.push(row);
        try { await fn(row); } catch (error) { row.error = error.stack ?? String(error); check(name + ' completed', false, row.error); }
        try { row.finalUi = await state(); row.screenshot = await shot(name); } catch (error) { row.captureError = String(error); }
        save();
      };
      try {
        win.setSize(1360, 920);
        await until('formal bridge ready', () => js(`!!window.zs?.command&&!!document.querySelector('.side-item.sub')`));
        result.daemonPid = Number(fs.readFileSync(path.join(config.data, 'daemon.pid'), 'utf8'));
        check('real daemon process distinct from Electron', result.daemonPid > 0 && result.daemonPid !== process.pid);
        check('window remains hidden', !win.isVisible());
        result.before = snapshot();
        check('seed used three real Fake member turns', meta.fakeStartTurns === 3, meta.fakeStartTurns);
        check('seed has exactly two threads and no executable queued work', result.before.threadIds.length === 2 && result.before.pendingOutbox.length === 0, result.before.pendingOutbox);
        await scenario('pool-immediate-banner', async row => {
          await roomReady(); await shot('room-waiting-card');
          policy = {name: row.name, delays: {'thread.get': 1400, 'thread.history': 1400, 'task.get': 1400}};
          const clickedAt = await clickWaiting(); await delay(230);
          row.early = await state();
          const t = row.early.timing;
          row.bannerLatencyMs = t?.firstBannerAt == null ? null : t.firstBannerAt - clickedAt;
          const reads = result.receipts.filter(r => r.scenario === row.name && ['thread.get', 'thread.history', 'task.get'].includes(r.method));
          row.earlyReads = JSON.parse(JSON.stringify(reads));
          check('banner appears within 200ms after actual room card click', row.bannerLatencyMs !== null && row.bannerLatencyMs < 200, row.bannerLatencyMs);
          check('banner is WAITING_FOR_USER before delayed read receipts', row.early.phase === 'WAITING_FOR_USER' && reads.length > 0 && reads.every(r => !r.deliveredAt), row.earlyReads);
          row.earlyScreenshot = await shot('banner-before-delayed-receipts');
          await until('all official detail reads finish', () => result.receipts.some(r => r.scenario === row.name && r.method === 'thread.history' && r.deliveredAt));
          // The compact banner is intentionally a summary. Readability belongs
          // to the actual latest AI reply, including text below the old fold.
          const questionLines = meta.question.split('\n').filter(Boolean).map(line => line.replace(/^\d+\.\s*/, ''));
          await until('actual latest waiting reply rendered', () => js(`!!Array.from(document.querySelectorAll('.msg-agent .msg-text')).find(e=>e.innerText.includes('问题结尾校验'))`));
          row.question = await js(`(()=>{
            const e=Array.from(document.querySelectorAll('.msg-agent')).find(el=>el.querySelector('.msg-text')?.innerText.includes('问题结尾校验'));
            const d=e?.querySelector('.msg-text');if(!d)return null;
            const norm=t=>t.replace(/\\s+/g,' ').trim();const s=getComputedStyle(d);const r=d.getBoundingClientRect();
            return {id:e.id,author:e.querySelector('.msg-author')?.textContent,readingMode:e.dataset.zsReadingMode,text:d.innerText,
              allQuestionLines:${JSON.stringify(questionLines)}.every(line=>norm(d.innerText).includes(norm(line))),
              folded:!!d.querySelector('.msg-fold.is-folded'),collapsedDetails:!!d.querySelector('details:not([open])'),
              whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,height:r.height,width:r.width,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth};
          })()`);
          const q = row.question;
          const persisted = result.before.replies.find(r => r.thread_id === meta.waiting.threadId);
          check('actual waiting reply contains the complete question including final sentence', q?.allQuestionLines && persisted?.body.text.includes(meta.question), q);
          check('latest waiting question is expanded and wraps without clipping', q?.readingMode === 'latest-expanded' && !q.folded && !q.collapsedDetails && q.height > 45 && q.scrollWidth <= q.clientWidth + 1, q);
          row.questionEnd = await js(`(()=>{
            const msg=document.getElementById(${JSON.stringify('thread-msg-' + persisted?.id)});
            const p=Array.from(msg?.querySelectorAll('.msg-text p')??[]).find(el=>el.innerText.includes('问题结尾校验'));
            if(!p)return null;p.scrollIntoView({block:'center'});return {text:p.innerText};
          })()`);
          await delay(100);
          row.questionEnd = await js(`(()=>{
            const p=Array.from(document.querySelectorAll('.msg-agent .msg-text p')).find(el=>el.innerText.includes('问题结尾校验'));
            if(!p)return null;const r=p.getBoundingClientRect();const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
            return {text:p.innerText,top:r.top,bottom:r.bottom,viewportHeight:innerHeight,hitVisible:hit===p||p.contains(hit)};
          })()`);
          check('question final sentence can actually be scrolled into view and read', row.questionEnd?.top >= 0 && row.questionEnd.bottom <= row.questionEnd.viewportHeight && row.questionEnd.hitVisible, row.questionEnd);
          row.questionScreenshot = await shot('waiting-question-readable');
          row.detailsClick = await js(`(()=>{const e=Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()==='详情'&&el.getBoundingClientRect().width>0);if(!e)throw Error('Existing thread detail action missing');const proof={label:e.textContent.trim(),method:'HTMLElement.click',at:Date.now()};e.click();return proof;})()`);
          await until('existing thread detail destination', () => js(`location.hash.includes(${JSON.stringify(meta.waiting.threadId)})&&document.body.innerText.includes('任务概况')&&document.body.innerText.includes('原始要求（原消息）')`));
          row.detailsUi = await state();
          check('existing detail action really opens this waiting task overview', row.detailsUi.hash.includes(meta.waiting.threadId) && row.detailsUi.body.includes('R132 等待预算'), {click: row.detailsClick, hash: row.detailsUi.hash});
          row.detailsScreenshot = await shot('waiting-details-action');
        });
        await scenario('cached-stale-detail', async row => {
          await roomReady(true);
          policy = {name: row.name, staleTask: true};
          await clickWaiting();
          await until('genuine stale task.get receipt delivered', () => result.receipts.some(r => r.scenario === row.name && r.injected && r.deliveredAt));
          await delay(150); row.afterStale = await state();
          check('new waiting pool beats genuine earlier QUEUED cached detail', row.afterStale.phase === 'WAITING_FOR_USER', {phase: row.afterStale.phase, stalePhase: meta.staleTask.executionStatus?.phase});
          await roomReady();
          policy = {name: row.name + '-reopen', delays: {'thread.get': 1400, 'thread.history': 1400, 'task.get': 1400}};
          await clickWaiting(); await delay(230); row.reopened = await state();
          check('reopening with stale detail cache keeps new pool waiting banner', row.reopened.phase === 'WAITING_FOR_USER' && row.reopened.timing?.firstBannerAt - row.reopened.timing?.clickedAt < 200, row.reopened.timing);
          await delay(2900);
        });
        for (const historyError of [false, true]) await scenario(historyError ? 'cold-history-error' : 'cold-history-delay', async row => {
          await roomReady(true); // destroys the renderer store; task detail really is cold
          policy = {name: row.name, delays: {'thread.history': 3200}, historyError};
          const clickedAt = await clickWaiting(); await delay(650);
          row.early = await state();
          const traces = result.receipts.filter(r => r.scenario === row.name);
          const task = traces.find(r => r.method === 'task.get' && r.deliveredAt);
          const history = traces.find(r => r.method === 'thread.history');
          row.readsBeforeHistory = JSON.parse(JSON.stringify(traces));
          check(row.name + ': real task.get independently ready before history receipt', task?.realOk && task.phase === 'WAITING_FOR_USER' && task.deliveredAt - clickedAt < 1000 && !!history?.executedAt && !history.deliveredAt && !history.failedAt, row.readsBeforeHistory);
          check(row.name + ': waiting status rendered while history pending', row.early.phase === 'WAITING_FOR_USER', row.early.phase);
          row.earlyScreenshot = await shot(row.name + '-task-ready');
          await until('history delay/fault completed', () => result.receipts.some(r => r.scenario === row.name && r.method === 'thread.history' && (historyError ? r.failedAt : r.deliveredAt)));
          await delay(120); row.afterHistory = await state();
          check(row.name + ': history completion/failure preserves waiting status', row.afterHistory.phase === 'WAITING_FOR_USER', row.afterHistory.phase);
        });
        await scenario('broadcast-two-authors', async row => {
          await roomReady(true);
          await js(`(()=>{const e=Array.from(document.querySelectorAll('.root-card')).find(el=>el.textContent.includes('R132 短交流'));if(!e)throw Error('Broadcast card missing');e.click();})()`);
          await until('actual broadcast history receipt', () => result.receipts.some(r => r.method === 'thread.history' && r.params?.threadId === meta.broadcast.threadId && r.deliveredAt));
          await delay(200);
          const messages = () => js(`Array.from(document.querySelectorAll('.msg')).map(e=>({id:e.id,author:e.querySelector('.msg-author')?.textContent?.trim()??null,text:e.innerText,body:e.querySelector('.msg-content')?.innerText??e.innerText}))`);
          row.messages = await messages();
          row.persisted = snapshot().replies.filter(r => r.thread_id === meta.broadcast.threadId);
          check('broadcast persisted exactly two real member replies', row.persisted.length === 2, row.persisted);
          for (const [i, member] of meta.members.entries()) {
            const dbRows = row.persisted.filter(r => r.author_id === member.id);
            const uiRows = row.messages.filter(r => r.author === member.name && r.text.includes(meta.answers[i]));
            const turn = dbRows[0] && result.before.turns.find(t => t.id === dbRows[0].body.collaborationStage?.turnId);
            check(member.name + ': exactly one readable reply with correct author and actual turn', dbRows.length === 1 && dbRows[0].body.text === meta.answers[i] && uiRows.length === 1 && uiRows[0].id === 'thread-msg-' + dbRows[0].id && turn?.member_id === member.id && turn?.status === 'SUCCEEDED', {dbRows, uiRows, turn});
          }
          const ids = row.messages.map(r => r.id);
          check('broadcast has no duplicate rendered message identities', new Set(ids).size === ids.length, ids);
          await delay(5400); row.afterRefresh = await messages();
          const agentMessages = row.afterRefresh.filter(r => meta.members.some(m => m.name === r.author));
          check('broadcast refresh preserves exactly two member replies with no duplication', agentMessages.length === 2 && new Set(agentMessages.map(r => r.id)).size === 2, agentMessages);
        });
        result.after = snapshot();
        check('zero real business model calls before and after UI proof', result.before.realCalls === 0 && result.after.realCalls === 0);
        check('UI reads start no additional Fake turns or workflow runs', JSON.stringify(result.before.turns) === JSON.stringify(result.after.turns) && JSON.stringify(result.before.runs) === JSON.stringify(result.after.runs));
        result.ok = result.checks.every(c => c.pass);
      } catch (error) {
        result.error = error.stack ?? String(error);
        try { result.failureUi = await state(); await shot('failure'); result.failureDb = snapshot(); } catch (captureError) { result.captureError = String(captureError); }
      } finally { result.finishedAt = new Date().toISOString(); save(); clearTimeout(watchdog); win.close(); }
    });
  });
  require(config.main);
}

async function main() {
  for (const file of [mainEntry, daemonEntry]) if (!fs.existsSync(file)) throw Error('Build entry missing (this script never builds): ' + file);
  const seed = path.join(run, 'seed.cjs');
  await require('esbuild').build({entryPoints: [path.join(root, 'scripts/lib/r132-thread-feedback-fixture.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: seed, logLevel: 'silent'});
  const seeded = spawnSync(process.execPath, [seed, 'seed', data, path.join(run, 'synthetic-project')], {cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 45000});
  fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout ?? '') + '\n' + (seeded.stderr ?? ''));
  if (seeded.status !== 0) throw Error('Seed failed: ' + seeded.stderr);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const files = [mainEntry, daemonEntry, path.join(path.dirname(mainEntry), 'renderer/hifi/app.mjs'), path.join(path.dirname(mainEntry), 'renderer/hifi/app.css')];
  const config = {root, run, data, seed, node: process.execPath, main: mainEntry, summaryPath, baseline, seedSource: 'current worktree formal command and Fake worker; UI/daemon entries selected independently',
    entryHashes: Object.fromEntries(files.map(file => [file, hash(file)]))};
  const wrapper = path.join(run, 'electron-main.cjs');
  fs.writeFileSync(wrapper, `(${electronProof.toString()})(${JSON.stringify(config)});`);
  const log = fs.openSync(path.join(run, 'electron.log'), 'w');
  const child = spawn(electron, [wrapper], {cwd: root, env, windowsHide: true, stdio: ['ignore', log, log]});
  let timedOut = false, daemonPid = null;
  const watch = setInterval(() => { try { daemonPid = Number(fs.readFileSync(path.join(data, 'daemon.pid'), 'utf8')); } catch { /* startup/shutdown */ } }, 200);
  const requestClose = () => { timedOut = true; fs.writeFileSync(path.join(run, 'close-request'), 'close'); };
  process.once('SIGINT', requestClose); process.once('SIGTERM', requestClose);
  const deadline = setTimeout(requestClose, 190000);
  const killer = setTimeout(() => { timedOut = true; if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); }, 205000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearInterval(watch); clearTimeout(deadline); clearTimeout(killer); process.removeListener('SIGINT', requestClose); process.removeListener('SIGTERM', requestClose); fs.closeSync(log); }
  const result = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : {ok: false, error: 'No Electron summary'};
  result.daemonPid ??= daemonPid;
  const shutdown = path.join(data, 'desktop-shutdown.json');
  result.cleanup = {electronExitCode: code, timedOut, pidFileRemoved: !fs.existsSync(path.join(data, 'daemon.pid')), shutdown: fs.existsSync(shutdown) ? JSON.parse(fs.readFileSync(shutdown, 'utf8')) : null};
  if (result.daemonPid) { try { process.kill(result.daemonPid, 0); result.cleanup.daemonAlive = true; } catch { result.cleanup.daemonAlive = false; } }
  if (result.cleanup.daemonAlive) { spawnSync('taskkill', ['/PID', String(result.daemonPid), '/T', '/F'], {windowsHide: true, timeout: 10000}); result.cleanup.forcedDaemonCleanup = true; }
  result.entryHashesUnchanged = Object.entries(config.entryHashes).every(([file, old]) => hash(file) === old);
  result.ok = !!result.ok && code === 0 && !timedOut && result.cleanup.pidFileRemoved && result.cleanup.daemonAlive === false && result.cleanup.shutdown?.daemonStopResult?.complete === true && result.entryHashesUnchanged;
  fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ok: result.ok, baseline, run, summary: summaryPath, checks: result.checks?.length, failures: result.checks?.filter(c => !c.pass).map(c => c.name), cleanup: result.cleanup, error: result.error}, null, 2));
  if (!result.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(summaryPath, JSON.stringify({ok: false, error: error.stack, run}, null, 2)); console.error(error); process.exitCode = 1; });
