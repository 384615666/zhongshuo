/* R90 post-send proof: manual native drop -> attachmentRefs -> two real AI contexts. */
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
const humanReport = path.resolve(process.argv[6] ?? 'dist/review-r90-independent-final4/human-drag-reported.json');
if (!Number.isInteger(port) || port <= 0 || process.argv[3] == null) {
  throw Error('usage: node scripts/verify-r90-native-ref-post-send.cjs <port> <fixtureRoot> <out> <packageRoot> [humanReport]');
}

const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const sourceFile = path.join(fixture.projectPath, 'R90_NATIVE_ATTACH_REF.md');
const sourceBytes = fs.readFileSync(sourceFile);
const sourceHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
const sourceMarker = 'R90_NATIVE_ATTACH_REF_9041';
let cdp = null;
let database = null;

function must(value, message) {
  if (!value) throw Error(message);
}

function save(result) {
  fs.mkdirSync(out, { recursive: true });
  result.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'post-send-result.json'), JSON.stringify(result, null, 2), 'utf8');
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
  }, Boolean, 'owned R90 native-ref page', 30000);
}

(async () => {
  must(fs.existsSync(sourceFile), 'synthetic attachment missing');
  must(sourceBytes.length === 184, `synthetic attachment bytes changed: ${sourceBytes.length}`);
  must(sourceBytes.toString('utf8').includes(sourceMarker), 'synthetic attachment marker missing');
  const human = fs.existsSync(humanReport) ? JSON.parse(fs.readFileSync(humanReport, 'utf8')) : null;

  cdp = await connect();
  database = new Database(path.join(fixtureRoot, 'app-data', 'state.sqlite'), { readonly: true });
  const result = {
    format: 'r90-native-attachment-ref-post-send-v1',
    ok: false,
    build: JSON.parse(fs.readFileSync(path.join(packageRoot, 'ZhongshuoDual', 'BUILD.json'), 'utf8')),
    fixtureRoot,
    sourceFile: { path: sourceFile, bytes: sourceBytes.length, sha256: sourceHash },
    humanStep: human,
    checks: {},
    facts: {},
  };

  try {
    const parent = database.prepare(`
      SELECT id,status,root_message_id,title
      FROM tasks
      WHERE conversation_id=? AND title LIKE '%R90_NATIVE_REF_SEND_9044%'
      ORDER BY rowid DESC LIMIT 1
    `).get(fixture.conversationId);
    must(parent, 'native-ref parent task missing');

    const attachments = database.prepare(`
      SELECT ma.artifact_id, a.hash, a.source_name, a.kind, a.revision
      FROM message_attachments ma
      JOIN artifacts a ON a.id=ma.artifact_id
      WHERE ma.message_id=?
      ORDER BY ma.rowid
    `).all(parent.root_message_id);
    must(attachments.length === 1, `expected one linked artifact, found ${attachments.length}`);
    const artifact = attachments[0];

    const children = database.prepare(`
      SELECT id,owner_member_id owner,status
      FROM tasks WHERE parent_task_id=? ORDER BY rowid
    `).all(parent.id);
    must(children.length === 2, `expected two child tasks, found ${children.length}`);

    const contexts = database.prepare(`
      SELECT t.id task_id,t.owner_member_id owner,c.included_refs_json refs,c.hash bundle_hash
      FROM tasks t
      JOIN workflow_runs r ON r.task_id=t.id
      JOIN agent_turns a ON a.run_id=r.id
      JOIN context_bundles c ON c.turn_id=a.id
      WHERE t.parent_task_id=?
      ORDER BY t.rowid
    `).all(parent.id);
    const contextFacts = contexts.map((row) => {
      const bundle = JSON.parse(row.refs);
      const attachment = bundle.attachments?.find((item) => item.ref === artifact.artifact_id);
      return {
        taskId: row.task_id,
        owner: row.owner,
        bundleHash: row.bundle_hash,
        attachmentRef: attachment?.ref ?? null,
        filename: attachment?.filename ?? null,
        hash: attachment?.hash ?? null,
        originalBytes: attachment?.originalBytes ?? null,
        markerPresent: typeof attachment?.text === 'string' && attachment.text.includes(sourceMarker),
      };
    });

    const replies = database.prepare(`
      SELECT t.owner_member_id owner,m.body_json
      FROM tasks t JOIN messages m ON m.task_id=t.id
      WHERE t.parent_task_id=? AND m.author_type='agent'
      ORDER BY m.rowid
    `).all(parent.id).map((row) => ({
      owner: row.owner,
      text: JSON.parse(row.body_json).text ?? '',
    }));
    const calls = database.prepare(`
      SELECT status,count(*) n
      FROM real_calls
      WHERE task_id IN (?,?,?)
      GROUP BY status
    `).all(parent.id, ...children.map((child) => child.id));

    result.facts.parent = parent;
    result.facts.artifact = artifact;
    result.facts.children = children;
    result.facts.contexts = contextFacts;
    result.facts.replies = replies;
    result.facts.calls = calls;
    result.checks.parentDone = parent.status === 'DONE';
    result.checks.humanNativeDragReported = typeof human?.humanStatement === 'string'
      && human.humanStatement.includes('拖')
      && human?.humanPerformedNativeDrag === true
      && human?.reviewerPerformedNativeDrag === false;
    result.checks.oneHumanMessageAttachment = attachments.length === 1;
    result.checks.artifactHashMatchesSource = artifact.hash === sourceHash;
    result.checks.artifactBytesMatchSource = contextFacts.every((row) => row.originalBytes === sourceBytes.length);
    result.checks.twoChildTasksDone = children.length === 2 && children.every((child) => child.status === 'DONE');
    result.checks.twoContextsHaveExactAttachmentRef = contextFacts.length === 2
      && contextFacts.every((row) => row.attachmentRef === artifact.artifact_id && row.filename === path.basename(sourceFile));
    result.checks.twoContextsContainAttachmentText = contextFacts.length === 2
      && contextFacts.every((row) => row.markerPresent && row.hash === sourceHash);
    result.checks.glmReplyMarker = replies.some((row) => row.owner === fixture.coordinatorMemberId && row.text.includes('R90_NATIVE_GLM_9042'));
    result.checks.deepSeekReplyMarker = replies.some((row) => row.owner !== fixture.coordinatorMemberId && row.text.includes('R90_NATIVE_DS_9043'));
    result.checks.twoRealCallsSucceeded = calls.length === 1 && calls[0].status === 'succeeded' && calls[0].n === 2;

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const screenshot = path.join(out, 'native-ref-post-send.png');
    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
    result.screenshots = [{ name: 'native-ref-post-send.png', file: screenshot }];
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
