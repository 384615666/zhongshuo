'use strict';
// 临时诊断（交付前删除）：gate=held 下启动 → recovery.status/attr 实况。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repo = 'D:/zhongshuo';
try { require('node:fs').appendFileSync('D:/zhongshuo/dbg-gate.log', 'SCRIPT LOADED\n'); } catch { /* */ }
const outDir = path.join(repo, 'dist/desktop/dbg-gate-r67');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const D = require(path.join(repo, 'node_modules', 'better-sqlite3'));
const dbPath = path.join(outDir, 'state.sqlite');
{ const db = new D(dbPath); db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE IF NOT EXISTS daemon_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'); db.prepare("INSERT INTO daemon_state (key, value, updated_at) VALUES ('dispatch_gate','held',?)").run(Date.now()); db.close(); }
const PORT = 9633;
const app = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist/ui/main.cjs')], {
  cwd: repo, env: { ...process.env, ZS_APP_DATA: outDir, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; app.stdout.on('data', (c) => out += c); app.stderr.on('data', (c) => out += c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = (m) => { try { require('node:fs').appendFileSync('D:/zhongshuo/dbg-gate.log', m + '\n'); } catch { /* */ } };
(async () => {
  LOG('IIFE start');
  let ws = null;
  for (let i = 0; i < 90; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
      const p = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r)); break; }
    } catch { /* */ }
    await sleep(600);
  }
  let seq = 0; const pend = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, ap = false) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap })).result.value;
  for (let i = 0; i < 60; i += 1) { if (await ev('document.body.classList.contains("hifi-on")')) break; await sleep(500); }
  for (let i = 0; i < 20; i += 1) {
    const attr = await ev('document.querySelector("[data-zs-recovery-attention]")?.getAttribute("data-zs-recovery-attention")');
    const modal = await ev('document.querySelector("[data-zs-recovery]") != null');
    if (i % 5 === 0 || attr === '1') LOG(`t=${i}s attr=${attr} modal=${modal}`);
    if (attr === '1') break;
    await sleep(1000);
  }
  LOG('direct status:', await ev('window.zs ? window.zs.command({protocolVersion:1,commandId:"dbgstat001",method:"recovery.status",params:{}}).then((r)=>JSON.stringify({gateHeld:r.data&&r.data.gateHeld})) : "no-zs"', true));
  const db2 = new D(dbPath, { readonly: true });
  LOG('gate in db:', db2.prepare("SELECT value FROM daemon_state WHERE key='dispatch_gate'").get());
  db2.close();
  LOG('appOut tail:', out.slice(-300));
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
  process.exit(0);
})().catch((e) => { LOG(String(e)); try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } process.exit(1); });
