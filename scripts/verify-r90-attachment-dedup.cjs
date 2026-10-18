/* Same-BUILD attachment identity proof: equal metadata must not impersonate equal bytes. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence'));
const packageRoot = path.resolve(process.argv[5] ?? 'dist/desktop/desktop-daily-win-v26-r90-final3-20261018');
if (!Number.isInteger(port) || port <= 0 || process.argv[3] == null) {
  throw Error('usage: node scripts/verify-r90-attachment-dedup.cjs <port> <fixtureRoot> <out> <packageRoot>');
}

const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const duplicateA = path.join(fixtureRoot, 'dup-a', 'same.txt');
const duplicateB = path.join(fixtureRoot, 'dup-b', 'same.txt');
const failedA = path.join(fixtureRoot, 'fail-a', 'same.txt');
const failedB = path.join(fixtureRoot, 'fail-b', 'same.txt');
const q = JSON.stringify;
let cdp = null;

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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
  }, Boolean, 'owned R90 dedup window', 30000);
}

async function fileInputNode() {
  const document = await cdp.send('DOM.getDocument', { depth: 1 });
  const found = await cdp.send('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: '[data-zs-file-input="1"]',
  });
  must(found.nodeId > 0, 'visible composer file input missing');
  return found.nodeId;
}

async function selectFiles(files) {
  await cdp.send('DOM.setFileInputFiles', { files, nodeId: await fileInputNode() });
}

async function tokenState() {
  return cdp.eval(`[...document.querySelectorAll('[data-zs-inline-token="1"]')].map((node) => ({
    name: node.dataset.zsFileName ?? null,
    attachmentId: node.dataset.zsAttachmentId ?? null,
    uploadId: node.dataset.zsUploadId ?? null,
    kind: node.dataset.zsFileKind ?? null,
    failed: node.classList.contains('is-failed'),
    ready: node.classList.contains('is-ready'),
    text: node.textContent
  }))`);
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
    format: 'r90-attachment-content-dedup-v1',
    ok: false,
    fixtureRoot,
    build: JSON.parse(fs.readFileSync(path.join(packageRoot, 'ZhongshuoDual', 'BUILD.json'), 'utf8')),
    files: {
      duplicateA: { path: duplicateA, bytes: fs.statSync(duplicateA).size, sha256: digest(duplicateA) },
      duplicateB: { path: duplicateB, bytes: fs.statSync(duplicateB).size, sha256: digest(duplicateB) },
      failedA: { path: failedA, bytes: fs.statSync(failedA).size, sha256: digest(failedA) },
      failedB: { path: failedB, bytes: fs.statSync(failedB).size, sha256: digest(failedB) },
    },
    checks: {},
    screenshots: [],
  };
  try {
    await cdp.eval(`location.hash=${q(`/project/${fixture.projectId}/room/${fixture.roomId}`)};true`);
    await until(() => cdp.eval(`document.querySelector('[data-zs-file-input="1"]')!=null`), Boolean, 'room composer', 60000);
    must(result.files.duplicateA.bytes === result.files.duplicateB.bytes, 'duplicate fixture sizes differ');
    must(result.files.duplicateA.sha256 !== result.files.duplicateB.sha256, 'duplicate fixture bytes should differ');

    await selectFiles([duplicateA, duplicateB]);
    await until(async () => {
      const tokens = await tokenState();
      return tokens.length === 2 && tokens.every((token) => token.ready && token.attachmentId != null);
    }, Boolean, 'two same-name/same-size content-distinct uploads', 60000);
    const distinctTokens = await tokenState();
    result.facts = { distinctTokens };
    result.checks.sameMetadataDifferentBytesAccepted = distinctTokens.length === 2;
    result.checks.distinctAttachmentIds = new Set(distinctTokens.map((token) => token.attachmentId)).size === 2;
    result.screenshots.push(await screenshot('same-name-different-content.png'));
    const db = new Database(path.join(fixtureRoot, 'app-data', 'state.sqlite'), { readonly: true });
    try {
      const rows = db.prepare(`SELECT id,hash,source_name,kind FROM artifacts
        WHERE conversation_id=? AND hash IN (?,?) ORDER BY rowid`).all(
        fixture.conversationId, result.files.duplicateA.sha256, result.files.duplicateB.sha256,
      );
      result.facts.artifacts = rows;
      result.checks.bothContentHashesPersisted = new Set(rows.map((row) => row.hash)).size === 2;
    } finally {
      db.close();
    }

    await cdp.eval(`location.hash=${q(`/project/${fixture.otherProjectId}/room/${fixture.otherRoomId}`)};true`);
    await until(() => cdp.eval(`location.hash.includes(${q(fixture.otherRoomId)})&&document.querySelector('[data-zs-file-input="1"]')!=null`), Boolean, 'failure-test room composer', 60000);
    await selectFiles([failedA]);
    await until(async () => {
      const tokens = await tokenState();
      return tokens.length === 1 && tokens[0].failed === true;
    }, Boolean, 'invalid UTF-8 upload failure', 60000);
    result.facts.failedToken = await tokenState();
    result.checks.failedUploadVisible = result.facts.failedToken[0]?.failed === true;

    await selectFiles([failedB]);
    await until(async () => {
      const tokens = await tokenState();
      return tokens.some((token) => token.failed === true) && tokens.some((token) => token.ready && token.attachmentId != null);
    }, Boolean, 'reselect after failure', 60000);
    result.facts.reselectedTokens = await tokenState();
    result.checks.failedReselectAccepted = result.facts.reselectedTokens.some((token) => token.ready && token.attachmentId != null);
    result.screenshots.push(await screenshot('failed-reselect.png'));
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
