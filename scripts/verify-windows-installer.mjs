import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import WebSocket from 'ws';

// Explicit opt-in: runs a local installer, upgrade and uninstaller using synthetic data.
const initial = resolve(process.argv[2] ?? ''), upgrade = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3] || !existsSync(initial) || !existsSync(upgrade)) throw Error('Pass initial and upgrade Setup EXEs.');
const repo = resolve(import.meta.dirname, '..'), run = join(repo, 'dist', 'r144-install', randomUUID());
const installDir = join(run, '安装 Programs ! & spaces'), data = join(run, 'persistent data ! & 中文'), project = join(run, 'project');
mkdirSync(run, { recursive: true }); mkdirSync(project);
const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('ZS_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
const wait = ms => new Promise(done => setTimeout(done, ms));
const checks = []; function check(name, ok) { checks.push({ name, ok }); if (!ok) throw Error(name); }
function installer(executable, args, label) {
  const result = spawnSync(executable, args, { encoding: 'utf8', env, windowsHide: true, timeout: 180000 });
  check(label, result.status === 0); if (result.error) throw result.error;
}
const screenQuery = join(run, 'screens.cjs');
writeFileSync(screenQuery, "const {app,screen}=require('electron');app.whenReady().then(()=>{console.log('R144 '+JSON.stringify({primary:screen.getPrimaryDisplay().id,displays:screen.getAllDisplays().map(d=>d.id)}));app.quit();});");
const query = spawnSync(join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'), [screenQuery], { encoding: 'utf8', env, windowsHide: true, timeout: 15000 });
const screens = JSON.parse(query.stdout.split(/\r?\n/).find(line => line.startsWith('R144 ')).slice(5));
const display = screens.displays.find(id => id !== screens.primary); if (display == null) throw Error('Need a non-primary display.');
let ws, child, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((done, reject) => { const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error('CDP deadline: ' + method)); }, 15000); pending.set(n, { done, reject, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result?.value; };
async function launch(label) {
  const port = await new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
  child = spawn(join(installDir, 'Zhongshuo.exe'), [`--data-dir=${data}`, `--remote-debugging-port=${port}`], { cwd: dirname(installDir), windowsHide: true, env: { ...env, ZS_TEST_DISPLAY: String(display), ZS_APP_DATA: join(run, 'never-use-inherited-root'), ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_DAEMON_ENTRY: 'wrong-entry', ZS_PIPE_NAME: 'wrong-pipe', ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  let target;
  for (let n = 0; n < 250; n++) { try { target = (await (await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* starting */ } if (child.exitCode != null) throw Error('Application exit ' + child.exitCode); await wait(100); }
  check(label + ' native EXE opens a page', Boolean(target));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done, reject) => { ws.once('open', done); ws.once('error', reject); });
  ws.on('message', bytes => { const f = JSON.parse(bytes.toString()), p = pending.get(f.id); if (p) { pending.delete(f.id); clearTimeout(p.timer); if (f.error) p.reject(Error(JSON.stringify(f.error))); else p.done(f.result); } });
  let ready = false;
  for (let n = 0; n < 200; n++) { if (await evaluate("document.querySelector('[data-zs-boot-phase=ready]')?.getAttribute('data-zs-connection-phase')==='online'")) { ready = true; break; } await wait(100); }
  check(label + ' UI boot ready and connection online', ready);
  const identity = await command('app.identity', {}); check(label + ' uses deliberate data root', resolve(identity.appDataDir) === resolve(data));
  check(label + ' ignores inherited data root', !existsSync(join(run, 'never-use-inherited-root')));
  return { port };
}
async function command(method, params) { return evaluate(`(async()=>{const r=await window.zs.command({protocolVersion:1,commandId:crypto.randomUUID(),method:${JSON.stringify(method)},params:${JSON.stringify(params)}});if(!r.ok)throw Error(JSON.stringify(r.error));return r.data;})()`); }
async function close(label) {
  const stopped = await command('daemon.shutdown', {}); check(label + ' shutdown acknowledged', stopped != null);
  try { await send('Page.close'); } catch { /* closed */ }
  for (let n = 0; n < 150 && child.exitCode == null; n++) await wait(100);
  check(label + ' exits zero', child.exitCode === 0); check(label + ' daemon stopped', !existsSync(join(data, 'daemon.pid'))); ws.close(); ws = null;
}
let result;
try {
  installer(initial, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS=desktopicon', `/DIR=${installDir}`, `/LOG=${join(run, 'install.log')}`], 'initial installer completes');
  check('native EXE and uninstaller installed', existsSync(join(installDir, 'Zhongshuo.exe')) && existsSync(join(installDir, 'unins000.exe')));
  const firstVersion = JSON.parse(readFileSync(join(installDir, 'resources', 'app', 'installed-desktop.json'), 'utf8')).version;
  await launch('initial');
  const opened = await command('project.open', { path: project }), projectId = opened.project.id;
  const rooms = await command('room.list', { projectId }), room = rooms.items[0];
  await command('message.submit', { target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId }, body: '安装升级验证：这条记录需要保留', intent: 'record_only', mentions: [] });
  await evaluate("localStorage.setItem('r144-preserved-draft','draft-byte-marker')");
  const pid = readFileSync(join(data, 'daemon.pid'), 'utf8');
  const duplicate = spawnSync(join(installDir, 'Zhongshuo.exe'), [`--data-dir=${data}`], { env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  check('second launch exits successfully', duplicate.status === 0); check('second launch keeps same daemon', readFileSync(join(data, 'daemon.pid'), 'utf8') === pid);
  check('primary still serves after second launch', (await command('project.list', {})).items.length > 0);
  const beforeUpgradeHash = createHash('sha256').update(readFileSync(join(installDir, 'Zhongshuo.exe'))).digest('hex');
  const refusedUpgrade = spawnSync(upgrade, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/DIR=${installDir}`, `/LOG=${join(run, 'busy-upgrade.log')}`], { env, windowsHide: true, timeout: 30000 });
  check('running app refuses upgrade before file changes', refusedUpgrade.status != null && refusedUpgrade.status !== 0 && createHash('sha256').update(readFileSync(join(installDir, 'Zhongshuo.exe'))).digest('hex') === beforeUpgradeHash);
  const refusedUninstall = spawnSync(join(installDir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${join(run, 'busy-uninstall.log')}`], { env, windowsHide: true, timeout: 30000 });
  check('running app refuses uninstall', refusedUninstall.status != null && refusedUninstall.status !== 0 && existsSync(join(installDir, 'Zhongshuo.exe')));
  check('refused maintenance preserves daemon and data', readFileSync(join(data, 'daemon.pid'), 'utf8') === pid && (await command('project.list', {})).items.some(p => p.id === projectId));
  const shot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(run, 'installed.png'), Buffer.from(shot.data, 'base64'));
  await close('initial');
  writeFileSync(join(data, 'r144-attachment-marker'), 'preserved attachment bytes'); writeFileSync(join(installDir, 'user-untracked.txt'), 'user file kept');
  installer(upgrade, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/DIR=${installDir}`, `/LOG=${join(run, 'upgrade.log')}`], 'upgrade installer completes');
  const upgradedVersion = JSON.parse(readFileSync(join(installDir, 'resources', 'app', 'installed-desktop.json'), 'utf8')).version;
  check('upgrade actually changes version', firstVersion !== upgradedVersion);
  await launch('upgrade');
  check('upgrade preserves draft', await evaluate("localStorage.getItem('r144-preserved-draft')") === 'draft-byte-marker');
  check('upgrade preserves project registry', (await command('project.list', {})).items.some(p => p.id === projectId));
  const history = await command('room.pool', { roomId: room.id });
  check('upgrade preserves recorded message', JSON.stringify(history).includes('安装升级验证'));
  await close('upgrade');
  const dbBytes = readFileSync(join(data, 'state.sqlite')), draft = readFileSync(join(data, 'r144-attachment-marker'));
  installer(join(installDir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${join(run, 'uninstall.log')}`], 'uninstaller completes');
  check('uninstall removes executable', !existsSync(join(installDir, 'Zhongshuo.exe')));
  check('uninstall preserves database bytes', readFileSync(join(data, 'state.sqlite')).equals(dbBytes));
  check('uninstall preserves attachment bytes', readFileSync(join(data, 'r144-attachment-marker')).equals(draft));
  check('uninstall preserves unrelated file', readFileSync(join(installDir, 'user-untracked.txt'), 'utf8') === 'user file kept');
  result = { ok: true, checks, run, firstVersion, upgradedVersion, realModelCalls: 0 };
} catch (error) { result = { ok: false, checks, run, error: String(error) }; }
finally {
  if (ws?.readyState === WebSocket.OPEN) try { await close('failure cleanup'); } catch { /* preserve evidence */ }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('closed')); } pending.clear();
}
writeFileSync(join(run, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
