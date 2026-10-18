/* Same-BUILD visible DM proof: a retained old failure does not block a new message. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence'));
const packageRoot = path.resolve(process.argv[5] ?? 'dist/desktop/desktop-daily-win-v26-r90-final2-20261018');
if (!Number.isInteger(port) || port <= 0 || process.argv[3] == null) {
  throw Error('usage: node scripts/verify-r90-old-failure-ui.cjs <port> <fixtureRoot> <out> <packageRoot>');
}

const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      await client.send('Page.enable');
      await until(() => client.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi shell', 30000);
      return client;
    } catch {
      return null;
    }
  }, Boolean, 'owned R90 failure window', 30000);
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

async function command(method, params = {}) {
  const envelope = { protocolVersion: 1, commandId: `r90-old-ui-${Date.now()}-${Math.random()}`, method, params };
  const response = await cdp.eval(`window.zs.command(${q(envelope)})`);
  must(response?.ok, `${method}: ${JSON.stringify(response?.error)}`);
  return response.data;
}

async function screenshot(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, name);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return { name, file, bytes: fs.statSync(file).size };
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  cdp = await connect();
  const result = {
    format: 'r90-old-failure-new-message-ui-v1',
    ok: false,
    fixtureRoot,
    build: JSON.parse(fs.readFileSync(path.join(packageRoot, 'ZhongshuoDual', 'BUILD.json'), 'utf8')),
    checks: {},
    facts: {},
    screenshots: [],
  };
  try {
    await cdp.eval(`location.hash=${q(`/dm/${fixture.conversationId}`)};true`);
    await until(() => cdp.eval(`document.querySelector('.composer-editor[contenteditable="true"]')!=null`), Boolean, 'DM composer', 60000);
    await until(() => cdp.eval(`document.querySelector('[data-zs-dm-interrupted="hifi"]')!=null`), Boolean, 'interrupted panel', 30000);
    const failurePanel = await cdp.eval(`document.querySelector('[data-zs-dm-interrupted="hifi"]')?.innerText??''`);
    result.facts.failurePanel = failurePanel;
    result.checks.oldFailureReasonVisible = failurePanel.includes(fixture.oldFailureText);
    result.checks.oldFailureOffersNewMessage = failurePanel.includes('直接发送一条新消息');
    result.checks.failurePanelsDeduplicated = await cdp.eval(`document.querySelectorAll('[data-zs-dm-interrupted="hifi"]').length===1&&document.querySelectorAll('[data-zs-dm-failed="hifi"]').length===0`);
    result.screenshots.push(await screenshot('old-failure-before-new-message.png'));

    const beforeSend = await command('conversation.tasks', { projectId: fixture.projectId, conversationId: fixture.conversationId });
    const alreadySucceeded = beforeSend.items.some((item) => item.id !== fixture.oldTaskId && item.status === 'DONE' && item.latestRun?.status === 'SUCCEEDED');
    result.facts.reusedUiCreatedMessage = alreadySucceeded;
    if (!alreadySucceeded) {
      const editor = '.composer-editor[contenteditable="true"]';
      await click(editor);
      await cdp.eval(`(()=>{const e=document.querySelector(${q(editor)});e.replaceChildren(document.createTextNode('R90 synthetic new message after retained failure'));e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'R90 synthetic new message after retained failure'}));return true})()`);
      await until(() => cdp.eval(`document.querySelector(${q(editor)})?.textContent?.includes('new message after retained failure')`), Boolean, 'new DM text', 10000);
      await click('.composer-send');
    }
    await until(async () => {
      const tasks = await command('conversation.tasks', { projectId: fixture.projectId, conversationId: fixture.conversationId });
      const fresh = tasks.items.filter((item) => item.id !== fixture.oldTaskId);
      return fresh.some((item) => item.status === 'DONE' && item.latestRun?.status === 'SUCCEEDED') ? tasks.items : null;
    }, Boolean, 'new DM terminal success', 120000);
    await until(() => cdp.eval(`document.body.innerText.includes('R90_NEW_MESSAGE_AFTER_FAILURE_OK')||document.body.innerText.includes('分析完成')`), Boolean, 'new DM visible reply', 60000);
    const tasks = await command('conversation.tasks', { projectId: fixture.projectId, conversationId: fixture.conversationId });
    const old = tasks.items.find((item) => item.id === fixture.oldTaskId);
    const fresh = tasks.items.filter((item) => item.id !== fixture.oldTaskId);
    result.facts.tasks = tasks.items.map((item) => ({ id: item.id, status: item.status, latestRun: item.latestRun }));
    result.checks.oldFailureRetained = old?.status === 'ACTIVE' && old?.latestRun?.status === 'FAILED';
    result.checks.newMessageSucceeded = fresh.some((item) => item.status === 'DONE' && item.latestRun?.status === 'SUCCEEDED');
    const db = new Database(path.join(fixtureRoot, 'app-data', 'state.sqlite'), { readonly: true });
    try {
      result.facts.oldFailureEvent = db.prepare(`SELECT payload_json FROM domain_events WHERE task_id=? AND kind='turn.statusChanged' ORDER BY seq DESC LIMIT 1`).get(fixture.oldTaskId);
      result.facts.realCalls = db.prepare('SELECT count(*) n FROM real_calls').get().n;
      result.facts.agentMessages = db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND author_type='agent'").get(fixture.conversationId).n;
    } finally {
      db.close();
    }
    result.checks.zeroRealCalls = result.facts.realCalls === 0;
    await sleep(400);
    result.screenshots.push(await screenshot('new-message-after-failure.png'));
    result.ok = Object.values(result.checks).every(Boolean);
    save(result);
    console.log(JSON.stringify({ ok: result.ok, checks: result.checks, facts: result.facts }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    result.error = error.stack ?? String(error);
    save(result);
    throw error;
  } finally {
    cdp?.ws.close();
  }
})().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
