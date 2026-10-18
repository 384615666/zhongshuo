/* R90 final-BUILD visible proof for the async hash preparation window. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence'));
const packageRoot = path.resolve(process.argv[5] ?? 'dist/desktop/desktop-daily-win-v26-r90-final4-20261018');
if (!Number.isInteger(port) || port <= 0 || process.argv[3] == null) {
  throw Error('usage: node scripts/verify-r90-hash-pending-ui.cjs <port> <fixtureRoot> <out> <packageRoot>');
}

const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const slowFile = path.join(fixtureRoot, 'slow-hash', 'slow.txt');
const slowHash = crypto.createHash('sha256').update(fs.readFileSync(slowFile)).digest('hex');
const q = JSON.stringify;
let cdp = null;

function must(value, message) {
  if (!value) throw Error(message);
}

function save(result) {
  fs.mkdirSync(out, { recursive: true });
  result.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
}

async function connect() {
  return until(async () => {
    try {
      const rows = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json());
      const page = rows.find((row) => row.type === 'page' && row.url.includes('index.html'));
      if (page == null) return null;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const client = new Cdp(ws);
      await client.send('Runtime.enable');
      await client.send('DOM.enable');
      await client.send('Page.enable');
      await until(() => client.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi shell', 30000);
      return client;
    } catch {
      return null;
    }
  }, Boolean, 'owned R90 hash-pending window', 30000);
}

async function fileInputNode() {
  const document = await cdp.send('DOM.getDocument', { depth: 1 });
  const found = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '[data-zs-file-input="1"]' });
  must(found.nodeId > 0, 'composer file input missing');
  return found.nodeId;
}

async function selectSlowFile() {
  await cdp.send('DOM.setFileInputFiles', { files: [slowFile], nodeId: await fileInputNode() });
}

async function point(selector) {
  return cdp.eval(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()`);
}

async function click(selector) {
  const target = await point(selector);
  must(target && target.width > 0 && target.height > 0, `visible target ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
}

async function typeBody(text) {
  await click('.composer-editor[contenteditable="true"]');
  await cdp.send('Input.insertText', { text });
  await until(() => cdp.eval(`document.querySelector('.composer-editor[contenteditable="true"]')?.textContent?.includes(${q(text)})`), Boolean, 'draft body', 10000);
}

async function keyEnter() {
  const event = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

function humanMessages() {
  const db = new Database(path.join(fixtureRoot, 'app-data', 'state.sqlite'), { readonly: true });
  try {
    return db.prepare("SELECT count(*) n FROM messages WHERE author_type='human'").get().n;
  } finally {
    db.close();
  }
}

function artifactsForHash() {
  const db = new Database(path.join(fixtureRoot, 'app-data', 'state.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT id,hash FROM artifacts WHERE hash=?').all(slowHash);
  } finally {
    db.close();
  }
}

async function installSlowHash(delayMs) {
  await cdp.eval(`(()=>{
    window.__zsOrigArrayBuffer = window.__zsOrigArrayBuffer ?? File.prototype.arrayBuffer;
    const original = window.__zsOrigArrayBuffer;
    File.prototype.arrayBuffer = function(){
      const reading = original.call(this);
      if(this.name!=='slow.txt') return reading;
      return new Promise((resolve,reject)=>setTimeout(()=>reading.then(resolve,reject),${delayMs}));
    };
    return true;
  })()`);
}

async function restoreHash() {
  await cdp.eval(`(()=>{if(window.__zsOrigArrayBuffer){File.prototype.arrayBuffer=window.__zsOrigArrayBuffer;delete window.__zsOrigArrayBuffer}return true})()`);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  cdp = await connect();
  const result = {
    format: 'r90-hash-pending-ui-v1',
    ok: false,
    fixtureRoot,
    build: JSON.parse(fs.readFileSync(path.join(packageRoot, 'ZhongshuoDual', 'BUILD.json'), 'utf8')),
    file: { path: slowFile, bytes: fs.statSync(slowFile).size, sha256: slowHash },
    checks: {},
    facts: {},
    screenshots: [],
  };
  try {
    await cdp.eval(`location.hash=${q(`/project/${fixture.projectId}/room/${fixture.roomId}`)};true`);
    await until(() => cdp.eval(`document.querySelector('.composer-editor[contenteditable="true"]')!=null`), Boolean, 'main composer', 60000);
    await installSlowHash(1800);
    const messagesBefore = humanMessages();
    await typeBody('HASH_PENDING_SEND_GUARD');
    await selectSlowFile();
    await until(() => cdp.eval(`document.querySelector('.composer-file-token.is-preparing')!=null`), Boolean, 'visible preparing token', 10000);
    const preparing = await cdp.eval(`(()=>{const t=document.querySelector('.composer-file-token.is-preparing');const b=document.querySelector('.composer-send');return{token:t?.textContent??null,disabled:b?.disabled??null,title:b?.title??null}})()`);
    result.facts.preparing = preparing;
    result.checks.preparingVisible = preparing.token?.includes('准备中') === true;
    result.checks.sendDisabledWhilePreparing = preparing.disabled === true;
    await keyEnter();
    await new Promise((resolve) => setTimeout(resolve, 350));
    result.checks.enterDoesNotSendWhilePreparing = humanMessages() === messagesBefore;
    result.checks.noArtifactBeforeHashCompletes = artifactsForHash().length === 0;
    result.screenshots.push({ name: 'hash-preparing.png', file: path.join(out, 'hash-preparing.png') });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'hash-preparing.png'), Buffer.from(shot.data, 'base64'));

    await click('.composer-file-token.is-preparing [data-zs-file-remove="1"]');
    await until(() => cdp.eval(`document.querySelector('.composer-file-token.is-preparing')==null`), Boolean, 'remove preparing token', 10000);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    result.checks.removedPreparationStaysGone = await cdp.eval(`document.querySelector('.composer-file-token')==null`);
    result.checks.removedPreparationDidNotUpload = artifactsForHash().length === 0;

    await typeBody('HASH_SWITCH_TARGET_GUARD');
    await selectSlowFile();
    await until(() => cdp.eval(`document.querySelector('.composer-file-token.is-preparing')!=null`), Boolean, 'second preparing token', 10000);
    await cdp.eval(`location.hash=${q(`/project/${fixture.otherProjectId}/room/${fixture.otherRoomId}`)};true`);
    await until(() => cdp.eval(`location.hash.includes(${q(fixture.otherRoomId)})&&document.querySelector('.composer-editor[contenteditable="true"]')!=null`), Boolean, 'other room', 60000);
    result.checks.noPreparationCrossedTarget = await cdp.eval(`document.querySelector('.composer-file-token')==null`);
    await cdp.eval(`location.hash=${q(`/project/${fixture.projectId}/room/${fixture.roomId}`)};true`);
    await until(() => cdp.eval(`document.querySelector('.composer-file-token.is-preparing')!=null`), Boolean, 'preparation retained on original target', 60000);
    await click('.composer-file-token.is-preparing [data-zs-file-remove="1"]');
    await until(() => cdp.eval(`document.querySelector('.composer-file-token.is-preparing')==null`), Boolean, 'clear switched preparation', 10000);
    await restoreHash();
    await selectSlowFile();
    await until(() => cdp.eval(`document.querySelector('.composer-file-token.is-ready')!=null`), Boolean, 'original target upload ready', 60000);
    result.checks.originalTargetEventuallyReady = true;
    await cdp.eval(`location.hash=${q(`/project/${fixture.otherProjectId}/room/${fixture.otherRoomId}`)};true`);
    await until(() => cdp.eval(`location.hash.includes(${q(fixture.otherRoomId)})&&document.querySelector('.composer-editor[contenteditable="true"]')!=null`), Boolean, 'second other room', 60000);
    await cdp.eval(`location.hash=${q(`/project/${fixture.projectId}/room/${fixture.roomId}`)};true`);
    await until(() => cdp.eval(`document.querySelector('.composer-file-token.is-ready')!=null`), Boolean, 'ready token survives target switch', 60000);
    result.checks.readyAttachmentSurvivesTargetSwitch = true;
    result.screenshots.push({ name: 'hash-ready-original-target.png', file: path.join(out, 'hash-ready-original-target.png') });
    const readyShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'hash-ready-original-target.png'), Buffer.from(readyShot.data, 'base64'));
    result.ok = Object.values(result.checks).every(Boolean);
    save(result);
    console.log(JSON.stringify({ ok: result.ok, checks: result.checks, facts: result.facts }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    result.error = error.stack ?? String(error);
    save(result);
    throw error;
  } finally {
    await restoreHash().catch(() => {});
    cdp?.ws.close();
  }
})().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
