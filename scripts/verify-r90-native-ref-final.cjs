/* R90 final proof: exact Explorer source -> inline token -> two-AI attachment refs. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence'));
const packageRoot = path.resolve(process.argv[5] ?? 'dist/desktop/desktop-daily-win-v26-r90-final4-20261018');
const appPid = Number(process.argv[6]);
const manualReady = process.argv.includes('--manual-ready');
if (!Number.isInteger(port) || !Number.isInteger(appPid) || port <= 0 || appPid <= 0 || process.argv[3] == null) {
  throw Error('usage: node scripts/verify-r90-native-ref-final.cjs <port> <fixtureRoot> <out> <packageRoot> <appPid> [--manual-ready]');
}

const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const sourceFile = path.join(fixture.projectPath, 'R90_NATIVE_ATTACH_REF.md');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
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
  }, Boolean, 'owned R90 native-ref window', 30000);
}

async function targetPoint() {
  return cdp.eval(`(()=>{
    const editor=document.querySelector('.composer-editor[contenteditable="true"]');
    if(!editor)return null;
    const r=editor.getBoundingClientRect();
    return {
      cssX:r.x+r.width/2,
      cssY:r.y+r.height/2,
      screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio
    };
  })()`);
}

function tokenState() {
  return cdp.eval(`[...document.querySelectorAll('[data-zs-inline-token="1"]')].map((node)=>({
    name:node.dataset.zsFileName??null,
    attachmentId:node.dataset.zsAttachmentId??null,
    uploadId:node.dataset.zsUploadId??null,
    ready:node.classList.contains('is-ready'),
    preparing:node.classList.contains('is-preparing'),
    failed:node.classList.contains('is-failed')
  }))`);
}

async function appendBody(text) {
  await cdp.eval(`(()=>{
    const editor=document.querySelector('.composer-editor[contenteditable="true"]');
    if(!editor)throw Error('composer editor missing');
    editor.focus();
    const range=document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  await cdp.send('Input.insertText', { text: ` ${text}` });
  await until(() => cdp.eval(`document.querySelector('.composer-editor[contenteditable="true"]')?.textContent?.includes(${q(text)})`), Boolean, 'prompt body', 10000);
}

async function click(selector) {
  const target = await cdp.eval(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,disabled:e.disabled}})()`);
  must(target && target.width > 0 && target.height > 0 && target.disabled !== true, `unavailable ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
}

function dbQuery() {
  return new Database(path.join(fixtureRoot, 'app-data', 'state.sqlite'), { readonly: true });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  must(fs.existsSync(sourceFile), 'synthetic attachment missing');
  must(fs.readFileSync(sourceFile, 'utf8').includes('R90_NATIVE_ATTACH_REF_9041'), 'synthetic attachment marker missing');
  cdp = await connect();
  const result = {
    format: 'r90-native-attachment-ref-final-v1',
    ok: false,
    build: JSON.parse(fs.readFileSync(path.join(packageRoot, 'ZhongshuoDual', 'BUILD.json'), 'utf8')),
    fixtureRoot,
    sourceFile: { path: sourceFile, bytes: fs.statSync(sourceFile).size, sha256: sourceHash },
    checks: {},
    facts: {},
    screenshots: [],
  };
  let database = null;
  try {
    await cdp.eval(`location.hash=${q(`/project/${fixture.projectId}/room/${fixture.roomId}`)};true`);
    await until(() => cdp.eval(`document.querySelector('.composer-editor[contenteditable="true"]')!=null`), Boolean, 'room composer', 60000);
    if (manualReady) {
      result.facts.drag = {
        ok: true,
        mode: 'manual-native-explorer',
        fileName: path.basename(sourceFile),
        note: 'The human drag step is attested separately; this verifier still proves the exact token and DB propagation.',
      };
    } else {
      execFileSync('pwsh.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'position-r90-native-app.ps1'),
        '-AppPid', String(appPid),
      ], { encoding: 'utf8', timeout: 15000 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const target = await targetPoint();
      must(target, 'composer target coordinates missing');
      const targetFile = path.join(out, 'drag-target.json');
      fs.writeFileSync(targetFile, JSON.stringify({ filePath: sourceFile, ...target }, null, 2), 'utf8');
      const dragFacts = JSON.parse(execFileSync('pwsh.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'drag-r90-native-ref.ps1'),
        '-AppPid', String(appPid), '-TargetJson', targetFile,
      ], { encoding: 'utf8', timeout: 45000 }).trim());
      result.facts.target = target;
      result.facts.drag = dragFacts;
      must(dragFacts.ok === true && dragFacts.fileName === path.basename(sourceFile), 'native drag did not bind the exact synthetic file');
    }
    await until(async () => {
      const tokens = await tokenState();
      return tokens.length === 1 && tokens[0].name === path.basename(sourceFile) && tokens[0].ready && tokens[0].attachmentId != null;
    }, Boolean, 'exact inline attachment token ready', 60000);
    const tokens = await tokenState();
    result.facts.tokens = tokens;
    result.checks.exactExplorerSource = result.facts.drag.fileName === path.basename(sourceFile);
    result.checks.inlineBubbleReady = tokens[0]?.ready === true;

    database = dbQuery();
    const artifact = database.prepare('SELECT id,hash,source_name,kind FROM artifacts WHERE id=?').get(tokens[0].attachmentId);
    result.facts.artifact = artifact;
    result.checks.artifactHashMatchesSource = artifact?.hash === sourceHash;
    database.close();
    database = null;

    const prompt = '@全体 这是 R90_NATIVE_REF_SEND_9044。请读取正文附件 R90_NATIVE_ATTACH_REF.md，确认其中唯一标记 R90_NATIVE_ATTACH_REF_9041。GLM 的回复保留 R90_NATIVE_GLM_9042，DeepSeek 的回复保留 R90_NATIVE_DS_9043；请各自独立回复，不要只说收到。';
    await appendBody(prompt);
    await click('.composer-send');
    const parent = await until(() => {
      const db = dbQuery();
      try {
        return db.prepare(`SELECT id,status,route_json FROM tasks WHERE conversation_id=? AND title LIKE '%R90_NATIVE_REF_SEND_9044%' ORDER BY rowid DESC LIMIT 1`)
          .get(fixture.conversationId) ?? null;
      } finally {
        db.close();
      }
    }, Boolean, 'native-ref parent task', 60000);
    must(parent, 'native-ref parent task missing');
    const terminal = await until(() => {
      const db = dbQuery();
      try {
        const task = db.prepare('SELECT id,status FROM tasks WHERE id=?').get(parent.id);
        if (task?.status !== 'DONE') return null;
        const children = db.prepare('SELECT id,owner_member_id owner,status FROM tasks WHERE parent_task_id=? ORDER BY rowid').all(parent.id);
        return children.length === 2 && children.every((child) => child.status === 'DONE') ? { task, children } : null;
      } finally {
        db.close();
      }
    }, Boolean, 'native-ref two recipients complete', 300000);
    result.facts.children = terminal.children;

    database = dbQuery();
    const contexts = database.prepare(`SELECT t.owner_member_id owner,c.included_refs_json refs
      FROM tasks t JOIN workflow_runs r ON r.task_id=t.id JOIN agent_turns a ON a.run_id=r.id
      JOIN context_bundles c ON c.turn_id=a.id WHERE t.parent_task_id=? ORDER BY t.rowid`).all(parent.id);
    const replies = database.prepare(`SELECT t.owner_member_id owner,m.body_json
      FROM tasks t JOIN messages m ON m.task_id=t.id WHERE t.parent_task_id=? AND m.author_type='agent' ORDER BY m.rowid`).all(parent.id);
    const calls = database.prepare(`SELECT status,count(*) n FROM real_calls WHERE task_id IN (?,?,?) GROUP BY status`)
      .all(parent.id, ...terminal.children.map((child) => child.id));
    const link = database.prepare(`SELECT count(*) n FROM message_attachments ma JOIN tasks t ON t.root_message_id=ma.message_id WHERE t.id=? AND ma.artifact_id=?`)
      .get(parent.id, tokens[0].attachmentId);
    database.close();
    database = null;
    const replyTexts = replies.map((row) => ({ owner: row.owner, text: JSON.parse(row.body_json).text ?? '' }));
    result.facts.contexts = contexts.map((row) => ({ owner: row.owner, attachmentMarker: String(row.refs).includes('R90_NATIVE_ATTACH_REF_9041') }));
    result.facts.replies = replyTexts;
    result.facts.calls = calls;
    result.facts.messageAttachmentLinks = link.n;
    result.checks.bothContextsContainAttachmentText = contexts.length === 2 && contexts.every((row) => String(row.refs).includes('R90_NATIVE_ATTACH_REF_9041'));
    result.checks.humanMessageLinkedToArtifact = link.n === 1;
    result.checks.twoRealCallsSucceeded = calls.length === 1 && calls[0].status === 'succeeded' && calls[0].n === 2;
    result.checks.bothRepliesVisible = replyTexts.length === 2;
    result.checks.glmReplyMarker = replyTexts.some((row) => row.owner === fixture.coordinatorMemberId && row.text.includes('R90_NATIVE_GLM_9042'));
    result.checks.deepSeekReplyMarker = replyTexts.some((row) => row.owner !== fixture.coordinatorMemberId && row.text.includes('R90_NATIVE_DS_9043'));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'native-ref-final.png'), Buffer.from(shot.data, 'base64'));
    result.screenshots.push({ name: 'native-ref-final.png', file: path.join(out, 'native-ref-final.png') });
    result.ok = Object.values(result.checks).every(Boolean);
    save(result);
    console.log(JSON.stringify({ ok: result.ok, checks: result.checks, facts: result.facts }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    result.error = error.stack ?? String(error);
    save(result);
    throw error;
  } finally {
    database?.close();
    cdp?.ws.close();
  }
})().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
