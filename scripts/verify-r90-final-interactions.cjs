/* R90 final-BUILD visible project interactions. No model request is sent. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence-interactions'));
if (!Number.isInteger(port) || port <= 0 || process.argv[3] == null) {
  throw Error('usage: node scripts/verify-r90-final-interactions.cjs <port> <fixtureRoot> <out>');
}

const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const appData = path.join(fixtureRoot, 'app-data');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const q = JSON.stringify;
let cdp = null;

function must(value, message) {
  if (!value) throw Error(message);
}

function write(result) {
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
  }, Boolean, 'owned R90 visible window', 30000);
}

async function point(expression) {
  return cdp.eval(`(()=>{const e=${expression};if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()`);
}

async function clickAt(value) {
  must(value && value.width > 0 && value.height > 0, 'visible click target');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 });
}

async function click(expression) {
  await clickAt(await point(expression));
}

async function command(method, params = {}) {
  const envelope = { protocolVersion: 1, commandId: `r90-interactions-${Date.now()}-${Math.random()}`, method, params };
  const response = await cdp.eval(`window.zs.command(${q(envelope)})`);
  must(response?.ok, `${method}: ${JSON.stringify(response?.error)}`);
  return response.data;
}

function projectNode(label) {
  return `[...document.querySelectorAll('.side-project')].find((node)=>node.querySelector('.side-item-label')?.textContent?.trim()===${q(label)})`;
}

async function projectState(label) {
  return cdp.eval(`(()=>{const node=${projectNode(label)};if(!node)return null;return{expanded:node.querySelector('.side-caret')?.getAttribute('aria-expanded'),rooms:[...node.querySelectorAll('.side-item.sub')].map((room)=>room.textContent.trim()),active:node.querySelector('.side-row')?.classList.contains('context-active')}})()`);
}

async function activeProjectLabel() {
  return cdp.eval(`document.querySelector('.side-row.context-active .side-item-label')?.textContent?.trim()??null`);
}

async function capture(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, name);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return { file, bytes: fs.statSync(file).size };
}

async function openFolderAndWait() {
  const before = await cdp.eval('location.hash');
  await click(`document.querySelector('[data-zs-open-project="hifi"]')`);
  await until(() => cdp.eval(`document.querySelector('[data-zs-open-project="hifi"]')?.getAttribute('aria-busy')!=='true'`), Boolean, 'folder picker settled', 60000);
  await sleep(500);
  return before;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  cdp = await connect();
  const build = JSON.parse(fs.readFileSync(
    path.join(process.argv[5] ?? path.resolve('dist/desktop/desktop-daily-win-v26-r90-final2-20261018'), 'ZhongshuoDual', 'BUILD.json'),
    'utf8',
  ));
  const result = {
    format: 'r90-final-visible-interactions-v1',
    ok: false,
    build,
    fixtureRoot,
    checks: {},
    facts: {},
    screenshots: [],
  };
  try {
    must((await activeProjectLabel()) === 'R90 日常样例', 'synthetic active project missing');
    const oldBefore = await projectState('R90 旧项目');
    must(oldBefore != null, 'old project row missing');
    if (oldBefore.expanded === 'true') {
      await click(`${projectNode('R90 旧项目')}.querySelector('.side-caret')`);
      await until(async () => (await projectState('R90 旧项目'))?.expanded === 'false', Boolean, 'old project collapsed for test', 15000);
    }
    await click(`${projectNode('R90 旧项目')}.querySelector('.side-caret')`);
    await until(async () => {
      const state = await projectState('R90 旧项目');
      return state?.expanded === 'true' && state.rooms.includes('默认房间');
    }, Boolean, 'old project room expansion', 30000);
    const oldExpanded = await projectState('R90 旧项目');
    result.facts.oldProject = oldExpanded;
    result.checks.oldProjectExpandedRoom = oldExpanded.rooms.includes('默认房间');

    await click(`Array.from((${projectNode('R90 旧项目')}).querySelectorAll('.side-item.sub')).find((room)=>room.textContent.trim()==='默认房间')`);
    await until(() => cdp.eval(`location.hash.includes(${q(fixture.otherProjectId)})&&location.hash.includes(${q(fixture.otherRoomId)})`), Boolean, 'old project room route', 60000);
    result.checks.oldProjectRoomOpened = await activeProjectLabel() === 'R90 旧项目';

    await openFolderAndWait();
    await until(async () => await activeProjectLabel() === 'R90 日常样例', Boolean, 'first consecutive open', 60000);
    result.checks.consecutiveOpenFirst = true;

    await openFolderAndWait();
    await until(async () => await activeProjectLabel() === 'project-third', Boolean, 'second consecutive open', 60000);
    result.checks.consecutiveOpenSecond = true;
    const hash = await cdp.eval('location.hash');
    const projectId = hash.match(/project\/([^/?]+)/)?.[1];
    must(projectId, 'opened project id missing from route');
    const members = await command('member.list', { projectId });
    const rooms = await command('room.list', { projectId });
    result.facts.thirdProject = {
      hash,
      projectId,
      memberCount: members.items.length,
      roomCount: rooms.items.length,
      members: members.items.map((member) => ({ displayName: member.displayName, enabled: member.enabled })),
    };
    result.checks.openedEmptyFolderHasRoom = rooms.items.length >= 1;

    const cancelBefore = await cdp.eval('location.hash');
    await openFolderAndWait();
    const cancelAfter = await cdp.eval('location.hash');
    result.checks.folderPickerCancelPreservesProject = cancelBefore === cancelAfter && await activeProjectLabel() === 'project-third';
    result.checks.folderPickerCancelReenabled = await cdp.eval(`document.querySelector('[data-zs-open-project="hifi"]')?.getAttribute('aria-busy')!=='true'`);

    const db = new Database(path.join(appData, 'state.sqlite'), { readonly: true });
    try {
      result.facts.realCalls = db.prepare('SELECT count(*) n FROM real_calls').get().n;
      result.facts.humanMessages = db.prepare("SELECT count(*) n FROM messages WHERE author_type='human'").get().n;
    } finally {
      db.close();
    }
    result.checks.zeroRealCalls = result.facts.realCalls === 0;
    result.screenshots.push({ name: 'consecutive-open-third.png', ...(await capture('consecutive-open-third.png')) });
    result.screenshots.push({ name: 'folder-cancel.png', ...(await capture('folder-cancel.png')) });
    result.ok = Object.values(result.checks).every(Boolean);
    write(result);
    console.log(JSON.stringify({ ok: result.ok, checks: result.checks, facts: result.facts }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    result.error = error.stack ?? String(error);
    write(result);
    throw error;
  } finally {
    cdp?.ws.close();
  }
})().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
