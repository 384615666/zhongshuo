/* R90 real-model UI evidence on an isolated synthetic root. Never retries UNKNOWN results. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence'));
if (!Number.isInteger(port) || port <= 0) throw Error('usage: node scripts/verify-r90-real.cjs <port> <fixtureRoot> <out>');
if (!process.argv[3]) throw Error('fixtureRoot is required');

const fixturePath = path.join(fixtureRoot, 'fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const ORDINARY_TIMEOUT = 120000;
const DELIBERATION_TIMEOUT = 600000;
const ROOM_EDITOR = '.composer-editor[contenteditable="true"]';
const THREAD_EDITOR = '.col-thread .composer-editor[contenteditable="true"]';
const ROOM_SEND = '.composer-send';
const THREAD_SEND = '.col-thread .composer-send';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const q = JSON.stringify;
const compact = (value) => String(value ?? '').replace(/\s+/g, '');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let cdp = null;

const coordinator = fixture.members.find((member) => member.id === fixture.coordinatorMemberId) ?? fixture.members[0];
const peer = fixture.members.find((member) => member.id !== coordinator?.id);
if (fixture.members.length !== 2) throw Error(`R90 fixture requires exactly two members, got ${fixture.members.length}`);
if (!coordinator || !peer) throw Error('fixture coordinator/peer missing');

const report = {
  format: 'r90-real-ui-v1',
  ok: false,
  port,
  fixtureRoot,
  fixturePath,
  source: 'R90 working tree',
  startedAt: new Date().toISOString(),
  models: fixture.members.map((member) => ({
    id: member.id,
    displayName: member.displayName,
    model: member.model,
    kind: member.kind,
  })),
  roles: {
    coordinator: { id: coordinator.id, displayName: coordinator.displayName },
    peer: { id: peer.id, displayName: peer.displayName },
  },
  stages: [],
  screenshots: [],
  errors: [],
  uncovered: [],
};

function must(ok, label) {
  if (!ok) throw Error(label);
}

function writeResult() {
  fs.mkdirSync(out, { recursive: true });
  report.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
}

async function connect() {
  return until(async () => {
    try {
      const rows = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json());
      const target = rows.find((row) => row.type === 'page' && row.url.includes('index.html'));
      if (target == null) return null;
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const client = new Cdp(ws);
      await client.send('Runtime.enable');
      await client.send('Page.enable');
      await until(() => client.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi', ORDINARY_TIMEOUT);
      return client;
    } catch {
      return null;
    }
  }, Boolean, 'owned R90 real window', ORDINARY_TIMEOUT);
}

async function command(method, params = {}) {
  const envelope = { protocolVersion: 1, commandId: `r90-real-${randomUUID()}`, method, params };
  const response = await cdp.eval(`window.zs.command(${q(envelope)})`);
  if (!response?.ok) throw Error(`${method}: ${JSON.stringify(response?.error)}`);
  return response.data;
}

async function route(hash, selector = ROOM_EDITOR) {
  await cdp.eval(`location.hash=${q(hash)};true`);
  await until(() => cdp.eval(`document.querySelector(${q(selector)})!=null`), Boolean, hash, ORDINARY_TIMEOUT);
  await sleep(350);
}

async function composerState(selector = ROOM_EDITOR) {
  return cdp.eval(`(()=>{
    const editor=document.querySelector(${q(selector)});
    if(!editor)return null;
    const root=editor.closest('.composer');
    const send=root?.querySelector('.composer-send');
    return {
      text:editor.textContent??'',
      html:editor.innerHTML,
      mode:root?.querySelector('.composer-mode-chip')?.textContent?.trim()??null,
      budget:root?.querySelector('button.composer-budget')?.textContent?.trim()??null,
      sendDisabled:send?.disabled??null,
      error:root?.querySelector('.composer-draft.failed')?.textContent?.trim()??null,
      unknown:root?.textContent?.includes('上次发送结果未知')??false,
      textareaComposer:Boolean(root?.querySelector('textarea.composer-input')),
    };
  })()`);
}

async function setComposer(value, selector = ROOM_EDITOR) {
  await cdp.eval(`(()=>{
    const editor=document.querySelector(${q(selector)});
    if(!editor)throw Error('contenteditable composer missing: ${selector}');
    if(editor.getAttribute('contenteditable')!=='true')throw Error('composer is not editable: ${selector}');
    editor.focus();
    editor.replaceChildren(document.createTextNode(${q(value)}));
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${q(value)}}));
    const range=document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  await until(async () => (await composerState(selector))?.text === value, Boolean, `composer value ${value.slice(0, 30)}`, ORDINARY_TIMEOUT);
  await sleep(180);
}

async function clickSend(selector = ROOM_SEND) {
  const state = await cdp.eval(`(()=>{
    const b=document.querySelector(${q(selector)});
    if(!b)return {ok:false,unknown:false};
    const unknown=b.closest('.composer')?.textContent?.includes('上次发送结果未知')??false;
    if(b.disabled||unknown)return {ok:false,unknown};
    b.click();
    return {ok:true,unknown:false};
  })()`);
  if (state?.unknown) throw Error('UNKNOWN send already retained; refusing to replace the original envelope');
  must(state?.ok, `send unavailable: ${selector}`);
}

async function chooseToolbarMember(memberId, editorSelector = ROOM_EDITOR) {
  const clicked = await cdp.eval(`(()=>{
    const editor=document.querySelector(${q(editorSelector)});
    const root=editor?.closest('.composer');
    const b=[...(root?.querySelectorAll('button')??[])].find((button)=>button.title.includes('提及成员'));
    if(!b||b.disabled)return false;
    b.click();
    return true;
  })()`);
  must(clicked, 'mention toolbar unavailable');
  await until(() => cdp.eval(`document.querySelector('[data-zs-mention-option=${q(memberId)}]')!=null`), Boolean, 'toolbar member candidate', ORDINARY_TIMEOUT);
  const selected = await cdp.eval(`(()=>{const b=document.querySelector('[data-zs-mention-option=${q(memberId)}]');if(!b||b.disabled)return false;b.click();return true})()`);
  must(selected, `toolbar member selection failed: ${memberId}`);
}

async function clickByText(rootSelector, text) {
  const clicked = await cdp.eval(`(()=>{
    const root=document.querySelector(${q(rootSelector)});
    if(!root)return false;
    const wanted=${q(compact(text))};
    const b=[...root.querySelectorAll('button')].find((button)=>button.textContent.replace(/\\s+/g,'').startsWith(wanted));
    if(!b||b.disabled)return false;
    b.click();
    return true;
  })()`);
  must(clicked, `button unavailable: ${text}`);
}

async function pool() {
  return (await command('room.pool', { roomId: fixture.roomId, limit: 30 })).items;
}

async function waitThreadWithBody(text, beforeIds = new Set(), editorSelector = ROOM_EDITOR) {
  return until(async () => {
    const items = await pool();
    const found = items.find((item) => !beforeIds.has(item.threadId) && String(item.body?.text ?? '').includes(text));
    if (found != null) return found;
    const state = await composerState(editorSelector);
    if (state?.unknown) throw Error(`UNKNOWN retained for ${text}; no automatic retry or new envelope`);
    return null;
  }, Boolean, `new thread ${text}`, ORDINARY_TIMEOUT);
}

async function waitTerminal(threadId, timeout = ORDINARY_TIMEOUT) {
  return until(async () => {
    const item = (await pool()).find((row) => row.threadId === threadId);
    if (!item) return null;
    return ['DONE', 'REVIEW', 'BLOCKED', 'CANCELLED'].includes(item.taskStatus) ? item : null;
  }, Boolean, `terminal ${threadId}`, timeout);
}

async function history(threadId) {
  return (await command('thread.history', { threadId, limit: 100 })).items;
}

const agentItems = (items) => items.filter((item) => item.authorType === 'agent');

async function waitAgentCount(threadId, count, timeout = ORDINARY_TIMEOUT) {
  return until(async () => {
    const items = await history(threadId);
    return agentItems(items).length >= count ? items : null;
  }, Boolean, `reply count ${threadId}`, timeout);
}

function taskStage(stage, thread, terminal, items, extra = {}) {
  return {
    stage,
    threadId: thread.threadId,
    taskId: thread.taskId,
    taskStatus: terminal?.taskStatus ?? null,
    latestRun: terminal?.latestRun ?? null,
    protocolVisible: agentItems(items).some((item) => /TaskComplete|task-complete-v1|schemaVersion|resultKey/i.test(String(item.body?.text ?? ''))),
    ...extra,
  };
}

async function screenshot(name) {
  await cdp.send('Page.bringToFront');
  await cdp.eval('document.fonts.ready');
  await cdp.eval('Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))),new Promise(r=>setTimeout(()=>r(false),10000))])');
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = path.join(out, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
  const row = { name: `${name}.png`, file, bytes: fs.statSync(file).size, sha256: sha256(file), at: new Date().toISOString() };
  report.screenshots.push(row);
  return row;
}

async function scrollConversationToBottom() {
  await cdp.eval(`(()=>{
    const editor=document.querySelector('.composer-editor[contenteditable="true"]');
    let node=editor?.parentElement;
    while(node&&node!==document.body){
      const style=getComputedStyle(node);
      if(node.scrollHeight>node.clientHeight&&/auto|scroll/.test(style.overflowY))node.scrollTop=node.scrollHeight;
      node=node.parentElement;
    }
    return true;
  })()`);
  await sleep(200);
}

function messageText(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return String(parsed?.text ?? parsed?.answer ?? parsed?.body ?? value);
    } catch {
      return value;
    }
  }
  return String(value.text ?? value.answer ?? value.body ?? '');
}

async function dmHistory(conversationId) {
  const data = await command('conversation.history', { conversationId, limit: 200 });
  return data.messages.map((row) => ({
    id: row.id,
    conversationSeq: row.conversation_seq,
    authorType: row.author_type,
    authorId: row.author_id,
    text: messageText(row.body_json),
    status: row.status,
    createdAt: row.created_at,
  }));
}

async function conversationTasks(conversationId) {
  return (await command('conversation.tasks', { projectId: fixture.projectId, conversationId })).items;
}

async function waitNewDmTask(conversationId, beforeIds) {
  return until(async () => {
    const items = await conversationTasks(conversationId);
    const fresh = items.find((item) => !beforeIds.has(item.id));
    if (!fresh) return null;
    return fresh.status === 'DONE' && fresh.latestRun?.status === 'SUCCEEDED' ? fresh : null;
  }, Boolean, `DM terminal ${conversationId}`, ORDINARY_TIMEOUT);
}

async function waitDmAgent(conversationId, beforeIds) {
  return until(async () => {
    const items = await dmHistory(conversationId);
    const fresh = agentItems(items).filter((item) => !beforeIds.has(item.id));
    return fresh.length > 0 ? { items, fresh } : null;
  }, Boolean, `DM agent reply ${conversationId}`, ORDINARY_TIMEOUT);
}

function readJson(value) {
  if (value == null || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function analyzeDeliberation(taskId) {
  const db = new Database(path.join(fixture.appData, 'state.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const task = db.prepare('SELECT id,status,route_json,deliberation_budget_json FROM tasks WHERE id=?').get(taskId);
    const runs = db.prepare(`
      SELECT id,mode,status,stage,round_no,budget_json,task_id,conversation_id,thread_id
      FROM workflow_runs WHERE task_id=? ORDER BY rowid
    `).all(taskId);
    const turns = db.prepare(`
      SELECT a.id,a.run_id,a.member_id,a.stage_key,a.turn_purpose,a.attempt,a.status
      FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
      WHERE r.task_id=? AND r.mode='DELIBERATE' ORDER BY a.rowid
    `).all(taskId);
    const participants = db.prepare(`
      SELECT rp.run_id,rp.member_id,rp.role,rp.status,pm.display_name
      FROM run_participants rp
      JOIN project_members pm ON pm.id=rp.member_id
      JOIN workflow_runs r ON r.id=rp.run_id
      WHERE r.task_id=? ORDER BY rp.role,rp.member_id
    `).all(taskId);
    return {
      task,
      taskBudget: readJson(task?.deliberation_budget_json),
      runs: runs.map((run) => ({ ...run, budget: readJson(run.budget_json) })),
      turns,
      participants,
    };
  } finally {
    db.close();
  }
}

async function setNumberInput(selector, value) {
  const changed = await cdp.eval(`(()=>{
    const input=document.querySelector(${q(selector)});
    if(!input)return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${q(String(value))});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  must(changed, `number input missing: ${selector}`);
  await until(() => cdp.eval(`document.querySelector(${q(selector)})?.value===${q(String(value))}`), Boolean, `${selector}=${value}`, ORDINARY_TIMEOUT);
}

async function waitVisibleProgress(marker) {
  return until(async () => {
    const state = await cdp.eval(`(()=>{
      const card=[...document.querySelectorAll('.root-card')].find((node)=>node.textContent.includes(${q(marker)}));
      const live=[...document.querySelectorAll('.col-thread [data-zs-live-progress]')].map((node)=>({
        turnId:node.getAttribute('data-zs-live-progress'),
        status:node.querySelector('[data-zs-live-wait]')?.getAttribute('data-zs-live-wait')??null,
        text:node.textContent?.trim()??'',
      }));
      const source=[card?.textContent??'',...live.map((row)=>row.text)].join('\\n');
      const matched=[...new Set(source.match(/[^\\n]*(?:等待|正在|已运行)[^\\n]*/g)??[])];
      return {matched,live,cardText:card?.textContent?.trim()??'',source};
    })()`);
    return state.matched.length > 0 ? state : null;
  }, Boolean, `visible deliberation progress ${marker}`, DELIBERATION_TIMEOUT);
}

function analyzeLedger() {
  const db = new Database(path.join(fixture.appData, 'state.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const turns = db.prepare(`
      SELECT a.id,a.run_id AS runId,a.member_id AS memberId,a.stage_key AS stageKey,
             a.turn_purpose AS turnPurpose,a.attempt,a.status,r.mode,r.task_id AS taskId
      FROM agent_turns a
      JOIN workflow_runs r ON r.id=a.run_id
      JOIN tasks t ON t.id=r.task_id
      WHERE t.project_id=? ORDER BY a.rowid
    `).all(fixture.projectId);
    const calls = db.prepare(`
      SELECT c.id,c.batch_id AS batchId,c.runtime_kind AS runtimeKind,c.model,c.response_model AS responseModel,
             c.member_id AS memberId,c.task_id AS taskId,c.turn_id AS turnId,c.status,c.detail,
             c.created_at AS createdAt,c.settled_at AS settledAt,t.project_id AS projectId
      FROM real_calls c LEFT JOIN tasks t ON t.id=c.task_id ORDER BY c.id
    `).all();
    const agentMessages = db.prepare(`
      SELECT id,thread_id AS threadId,conversation_id AS conversationId,author_id AS authorId,
             task_id AS taskId,created_at AS createdAt,body_json AS bodyJson
      FROM messages WHERE project_id=? AND author_type='agent' ORDER BY created_at,id
    `).all(fixture.projectId);
    const protocolLeaks = agentMessages.flatMap((row) => {
      const text = messageText(row.bodyJson);
      return /TaskComplete|task-complete-v1|schemaVersion|resultKey/i.test(text)
        ? [{ messageId: row.id, threadId: row.threadId, conversationId: row.conversationId, authorId: row.authorId, text: text.slice(0, 2000) }]
        : [];
    });
    const agentTurnIds = new Set(turns.map((turn) => turn.id));
    const succeededTurns = turns.filter((turn) => turn.status === 'SUCCEEDED');
    const succeededCalls = calls.filter((call) => call.status === 'succeeded');
    const succeededCallTurnIds = new Set(succeededCalls.map((call) => call.turnId).filter(Boolean));
    const unmatchedTurnIds = succeededTurns.filter((turn) => !succeededCallTurnIds.has(turn.id)).map((turn) => turn.id);
    const aggregateKeys = new Set(succeededCalls.filter((call) => !call.turnId).map((call) => `${call.taskId ?? ''}:${call.memberId ?? ''}`));
    const aggregatedUnmappedTurnIds = unmatchedTurnIds.filter((turnId) => {
      const turn = turns.find((row) => row.id === turnId);
      return turn != null && aggregateKeys.has(`${turn.taskId ?? ''}:${turn.memberId ?? ''}`);
    });
    const uncoveredTurnIds = unmatchedTurnIds.filter((turnId) => !aggregatedUnmappedTurnIds.includes(turnId));
    const unexpectedCallTurnIds = [...succeededCallTurnIds].filter((turnId) => !agentTurnIds.has(turnId));
    const countAcceptable = calls.length === turns.length
      || (aggregatedUnmappedTurnIds.length > 0 && calls.length < turns.length && uncoveredTurnIds.length === 0);
    return {
      turns,
      calls,
      agentMessages,
      protocolLeaks,
      counts: {
        agentTurns: turns.length,
        succeededAgentTurns: succeededTurns.length,
        realCallRows: calls.length,
        succeededRealCallRows: succeededCalls.length,
        distinctSucceededCallTurns: succeededCallTurnIds.size,
        unmatchedTurnIds: unmatchedTurnIds.length,
        aggregatedUnmappedTurnIds: aggregatedUnmappedTurnIds.length,
        uncoveredTurnIds: uncoveredTurnIds.length,
      },
      reconciliation: {
        allRealCallsSucceeded: calls.length > 0 && calls.every((call) => call.status === 'succeeded'),
        allAgentTurnsSucceeded: turns.length > 0 && turns.every((turn) => turn.status === 'SUCCEEDED'),
        allAgentTurnsAccountedFor: uncoveredTurnIds.length === 0,
        exactRawCount: calls.length === turns.length,
        countAcceptable,
        aggregatedUnmappedTurnIds,
        uncoveredTurnIds,
        unexpectedCallTurnIds,
        mode: calls.length === turns.length
          ? 'one-to-one'
          : aggregatedUnmappedTurnIds.length > 0
            ? 'aggregated-by-task-member'
            : 'turn-identity-coverage',
      },
    };
  } finally {
    db.close();
  }
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  try {
    cdp = await connect();
    const identity = await command('app.identity', {});
    report.appDataDir = identity.appDataDir;
    report.fixtureAppData = fixture.appData;
    must(path.resolve(identity.appDataDir) === path.resolve(fixture.appData), 'wrong isolated app data root');

    const diagnostics = await cdp.eval('window.zs.diagnostics()');
    report.build = {
      origin: 'window.zs.diagnostics() reading the running package BUILD.json',
      buildId: diagnostics?.build?.buildId ?? null,
      source: diagnostics?.build?.commit ?? null,
      commit: diagnostics?.build?.commit ?? null,
      dirty: diagnostics?.build?.dirty ?? null,
    };
    must(Boolean(report.build.buildId && report.build.source), 'BUILD.json buildId/source unavailable');

    const projectPath = fixture.projectPath ?? path.join(fixtureRoot, 'project');
    const documentPath = path.join(projectPath, 'R90真实合成报告.md');
    must(fs.existsSync(documentPath), `synthetic document missing: ${documentPath}`);
    const documentText = fs.readFileSync(documentPath, 'utf8');
    must(documentText.includes('R90_REAL_DOC_9031'), 'synthetic document marker missing');
    report.syntheticDocument = {
      path: documentPath,
      marker: 'R90_REAL_DOC_9031',
      sha256: sha256(documentPath),
    };

    report.runtimes = [];
    for (const member of fixture.members) {
      const runtime = await command('member.runtime', { memberId: member.id });
      report.runtimes.push({
        memberId: member.id,
        displayName: member.displayName,
        binding: runtime.binding,
        executableStatus: runtime.executableStatus,
      });
    }

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`);
    const roomInitialState = await composerState(ROOM_EDITOR);
    must(roomInitialState?.textareaComposer === false, 'R90 room Composer still uses textarea');
    const beforeFirst = new Set((await pool()).map((item) => item.threadId));
    const firstPrompt = `请只用一句自然中文回复，确认你是 ${coordinator.displayName}，并在句中保留标记 R90_ROOM_GLM_9031。`;
    await setComposer(firstPrompt);
    await clickSend();
    const firstThread = await waitThreadWithBody('R90_ROOM_GLM_9031', beforeFirst);
    const firstTerminal = await waitTerminal(firstThread.threadId);
    const firstHistory = await waitAgentCount(firstThread.threadId, 1);
    const firstAgents = agentItems(firstHistory);
    must(firstTerminal.taskStatus === 'DONE', `coordinator task status ${firstTerminal.taskStatus}`);
    must(firstAgents.length >= 1 && firstAgents.every((item) => item.authorId === coordinator.id), 'room no-@ reply was not authored only by coordinator');
    report.stages.push(taskStage('room-no-mention-coordinator', firstThread, firstTerminal, firstHistory, {
      sentBody: firstPrompt,
      mentions: [],
      agents: firstAgents.map((item) => ({ id: item.id, authorId: item.authorId, text: item.body?.text ?? '' })),
    }));

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${firstThread.threadId}`, THREAD_EDITOR);
    const followBefore = await history(firstThread.threadId);
    const followBeforeIds = new Set(agentItems(followBefore).map((item) => item.id));
    const followPrompt = '继续用一句自然中文说明你仍能收到这条续问，并在句中保留标记 R90_THREAD_GLM_9032。';
    await setComposer(followPrompt, THREAD_EDITOR);
    await clickSend(THREAD_SEND);
    const followHistory = await waitAgentCount(firstThread.threadId, followBeforeIds.size + 1);
    const followFresh = agentItems(followHistory).filter((item) => !followBeforeIds.has(item.id));
    must(followFresh.length >= 1 && followFresh.every((item) => item.authorId === coordinator.id), 'thread follow-up was not authored by coordinator');
    const followTerminal = await waitTerminal(firstThread.threadId);
    must(followTerminal.taskStatus === 'DONE', `thread follow-up task status ${followTerminal.taskStatus}`);
    report.stages.push(taskStage('thread-follow-up-coordinator', firstThread, followTerminal, followHistory, {
      sentBody: followPrompt,
      freshAgents: followFresh.map((item) => ({ id: item.id, authorId: item.authorId, text: item.body?.text ?? '' })),
    }));

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`);
    await scrollConversationToBottom();
    await screenshot('room');

    const beforeSingle = new Set((await pool()).map((item) => item.threadId));
    await setComposer('');
    await chooseToolbarMember(peer.id);
    const afterMention = await composerState(ROOM_EDITOR);
    must(afterMention?.text.includes(`@${peer.displayName}`), 'single-member mention token missing');
    const singlePrompt = `${afterMention.text.trimEnd()} 请用一句自然中文确认你收到了这条单独点名，并保留标记 R90_SINGLE_DS_9033。`;
    await setComposer(singlePrompt);
    await clickSend();
    const singleThread = await waitThreadWithBody('R90_SINGLE_DS_9033', beforeSingle);
    const singleTerminal = await waitTerminal(singleThread.threadId);
    const singleHistory = await waitAgentCount(singleThread.threadId, 1);
    const singleAgents = agentItems(singleHistory);
    must(singleTerminal.taskStatus === 'DONE', `single-member task status ${singleTerminal.taskStatus}`);
    must(singleAgents.length === 1 && singleAgents[0].authorId === peer.id, 'single-member room reply was not exactly the named peer');
    report.stages.push(taskStage('room-single-peer', singleThread, singleTerminal, singleHistory, {
      sentBody: singlePrompt,
      selectedMemberId: peer.id,
      agents: singleAgents.map((item) => ({ id: item.id, authorId: item.authorId, text: item.body?.text ?? '' })),
    }));

    const beforeAll = new Set((await pool()).map((item) => item.threadId));
    const allPrompt = `@全体 请两位各用一句自然中文问候，${coordinator.displayName} 保留 R90_ALL_GLM_9034，${peer.displayName} 保留 R90_ALL_DS_9035。`;
    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`);
    await setComposer(allPrompt);
    await clickSend();
    const allThread = await waitThreadWithBody('R90_ALL_GLM_9034', beforeAll);
    const allTerminal = await waitTerminal(allThread.threadId);
    const allHistory = await waitAgentCount(allThread.threadId, 2);
    const allAgents = agentItems(allHistory);
    const allAuthors = [...new Set(allAgents.map((item) => item.authorId))];
    must(allTerminal.taskStatus === 'DONE', `@全体 task status ${allTerminal.taskStatus}`);
    must(allAuthors.length === 2 && allAuthors.includes(coordinator.id) && allAuthors.includes(peer.id), 'room @全体 did not produce both member replies');
    report.stages.push(taskStage('room-all', allThread, allTerminal, allHistory, {
      sentBody: allPrompt,
      agents: allAgents.map((item) => ({ id: item.id, authorId: item.authorId, text: item.body?.text ?? '' })),
      distinctAuthorIds: allAuthors,
    }));

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`);
    const deliberatePrompt = '请两位只读检查工作区文件 R90真实合成报告.md，确认唯一标记 R90_REAL_DOC_9031 是否存在；不要修改文件，不要输出控制协议，并在最终答复中保留该标记。';
    await setComposer(deliberatePrompt);
    const beforeSettings = await composerState(ROOM_EDITOR);
    const settingsOpened = await cdp.eval(`(()=>{const b=document.querySelector('button[aria-label="本次运行设置"]');if(!b||b.disabled)return false;b.click();return true})()`);
    must(settingsOpened, '本次运行设置 button unavailable');
    await until(() => cdp.eval(`document.querySelector('.menu')?.textContent?.includes('独立研讨')===true`), Boolean, 'run settings menu', ORDINARY_TIMEOUT);
    const alreadyDeliberate = await cdp.eval(`(()=>[...document.querySelectorAll('.menu button')].some((b)=>b.textContent.replace(/\\s+/g,'').startsWith('调整独立研讨成员')))()`);
    if (alreadyDeliberate) {
      await clickByText('.menu', '调整独立研讨成员');
      await until(() => cdp.eval(`document.querySelector('.menu')?.textContent?.includes('独立研讨成员')===true`), Boolean, 'deliberation member menu', ORDINARY_TIMEOUT);
      await clickByText('.menu', '完成');
    } else {
      await clickByText('.menu', '独立研讨');
    }
    await until(async () => (await composerState(ROOM_EDITOR))?.mode != null, Boolean, 'deliberation mode bubble', ORDINARY_TIMEOUT);
    const afterMode = await composerState(ROOM_EDITOR);
    must(afterMode.text === beforeSettings.text, 'enabling 独立研讨 silently changed the composer body');
    must(!afterMode.text.includes('@全体'), 'enabling 独立研讨 silently injected @全体');
    must(compact(afterMode.mode).includes('2人'), `deliberation mode bubble did not show 2人: ${afterMode.mode}`);

    const budgetOpened = await cdp.eval(`(()=>{const b=document.querySelector('.composer button.composer-budget');if(!b||b.disabled)return false;b.click();return true})()`);
    must(budgetOpened, 'deliberation budget bubble unavailable');
    await until(() => cdp.eval(`document.querySelector('.menu .composer-budget-editor input[type="number"]')!=null`), Boolean, 'budget editor', ORDINARY_TIMEOUT);
    await setNumberInput('.menu .composer-budget-editor input[type="number"]', 7);
    await clickByText('.menu', '保存');
    await until(async () => compact((await composerState(ROOM_EDITOR))?.budget).includes('最多7次'), Boolean, 'budget bubble max 7', ORDINARY_TIMEOUT);
    const afterBudget = await composerState(ROOM_EDITOR);
    must(afterBudget.text === beforeSettings.text, 'saving budget changed the composer body');
    await screenshot('deliberation-mode-budget');

    const beforeDeliberate = new Set((await pool()).map((item) => item.threadId));
    await clickSend();
    const deliberateThread = await waitThreadWithBody('R90_REAL_DOC_9031', beforeDeliberate);
    await route(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${deliberateThread.threadId}`, '.col-thread');
    const visibleProgress = await waitVisibleProgress('R90_REAL_DOC_9031');
    await scrollConversationToBottom();
    await screenshot('deliberation-progress');
    const deliberateTerminal = await waitTerminal(deliberateThread.threadId, DELIBERATION_TIMEOUT);
    must(deliberateTerminal.taskStatus === 'DONE', `deliberation task status ${deliberateTerminal.taskStatus}`);
    const deliberateHistory = await waitAgentCount(deliberateThread.threadId, 1, DELIBERATION_TIMEOUT);
    const deliberateDb = analyzeDeliberation(deliberateThread.taskId);
    const deliberateRuns = deliberateDb.runs.filter((run) => run.mode === 'DELIBERATE');
    must(deliberateRuns.length >= 1, 'no DELIBERATE workflow_runs row');
    must(deliberateRuns.some((run) => run.budget?.runMaxTurns === 7), 'workflow_runs.budget_json.runMaxTurns is not 7');
    must(deliberateDb.turns.length >= 5, `deliberation agent_turns ${deliberateDb.turns.length} < 5`);
    must(deliberateDb.turns.every((turn) => turn.status === 'SUCCEEDED'), 'not every deliberation agent_turn succeeded');
    must(deliberateDb.task?.status === 'DONE', `SQLite task status ${deliberateDb.task?.status}`);
    const participantIds = [...new Set(deliberateDb.participants.map((row) => row.member_id))];
    must(participantIds.length === 2 && participantIds.includes(coordinator.id) && participantIds.includes(peer.id), 'deliberation participants are not both fixture members');
    report.stages.push(taskStage('room-deliberate', deliberateThread, deliberateTerminal, deliberateHistory, {
      sentBody: deliberatePrompt,
      ui: {
        modeBubble: afterMode.mode,
        budgetBubble: afterBudget.budget,
        bodyBeforeMode: beforeSettings.text,
        bodyAfterMode: afterMode.text,
        bodyAfterBudget: afterBudget.text,
        bodyContainsAll: afterBudget.text.includes('@全体'),
        budgetSavedMaxTurns: 7,
      },
      visibleProgress,
      sqlite: deliberateDb,
    }));
    await route(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${deliberateThread.threadId}`, THREAD_EDITOR);
    await scrollConversationToBottom();
    await screenshot('deliberation-final');

    report.dms = [];
    for (let index = 0; index < fixture.dms.length; index++) {
      const dm = fixture.dms[index];
      const expectedMember = fixture.members.find((member) => member.id === dm.memberId);
      must(expectedMember != null, `DM member not found: ${dm.memberId}`);
      await route(`/dm/${dm.conversationId}`);
      const beforeTasks = new Set((await conversationTasks(dm.conversationId)).map((item) => item.id));
      const beforeHistory = await dmHistory(dm.conversationId);
      const beforeAgentIds = new Set(agentItems(beforeHistory).map((item) => item.id));
      const marker = `R90_DM_${index + 1}_903${index + 6}`;
      const prompt = `请只用一句自然中文回复，确认你收到了这条私信，并在句中保留标记 ${marker}。`;
      await setComposer(prompt);
      await clickSend();
      const dmResult = await waitDmAgent(dm.conversationId, beforeAgentIds);
      const dmTask = await waitNewDmTask(dm.conversationId, beforeTasks);
      must(dmResult.fresh.every((item) => item.authorId === expectedMember.id), `DM reply author mismatch for ${expectedMember.displayName}`);
      const uiAgent = dmResult.fresh.at(-1);
      await until(() => cdp.eval(`document.getElementById(${q(`msg-${uiAgent.id}`)})!=null`), Boolean, `DM history DOM ${uiAgent.id}`, ORDINARY_TIMEOUT);
      const uiMessageText = await cdp.eval(`document.getElementById(${q(`msg-${uiAgent.id}`)})?.innerText??''`);
      const uiText = await cdp.eval('document.body.innerText');
      await scrollConversationToBottom();
      const screenshotName = `dm-${index + 1}`;
      await screenshot(screenshotName);
      report.dms.push({
        conversationId: dm.conversationId,
        memberId: expectedMember.id,
        displayName: expectedMember.displayName,
        sentBody: prompt,
        task: dmTask,
        agents: dmResult.fresh.map((item) => ({ id: item.id, authorId: item.authorId, text: item.text })),
        uiHistoryVisible: true,
        uiMessageId: uiAgent.id,
        uiMessageText,
        markerVisible: uiText.includes(marker),
        screenshot: `${screenshotName}.png`,
      });
    }

    const ledger = analyzeLedger();
    report.ledger = ledger;
    const requiredScreenshots = [
      'room.png',
      'deliberation-mode-budget.png',
      'deliberation-progress.png',
      'deliberation-final.png',
      ...fixture.dms.map((_, index) => `dm-${index + 1}.png`),
    ];
    const screenshotNames = new Set(report.screenshots.map((row) => row.name));
    report.checks = {
      appDataMatchesFixture: path.resolve(identity.appDataDir) === path.resolve(fixture.appData),
      buildIdentity: Boolean(report.build?.buildId && report.build?.source),
      contenteditableComposer: roomInitialState?.textareaComposer === false,
      roomNoMentionCoordinator: firstTerminal.taskStatus === 'DONE' && firstAgents.every((item) => item.authorId === coordinator.id),
      threadFollowUpCoordinator: followTerminal.taskStatus === 'DONE' && followFresh.every((item) => item.authorId === coordinator.id),
      roomSinglePeerOnly: singleTerminal.taskStatus === 'DONE' && singleAgents.length === 1 && singleAgents[0]?.authorId === peer.id,
      roomAllBothMembers: allTerminal.taskStatus === 'DONE' && allAuthors.length === 2 && allAuthors.includes(coordinator.id) && allAuthors.includes(peer.id),
      deliberationUi: compact(afterMode.mode).includes('2人')
        && compact(afterBudget.budget).includes('最多7次')
        && afterMode.text === beforeSettings.text
        && afterBudget.text === beforeSettings.text
        && !afterBudget.text.includes('@全体')
        && visibleProgress.matched.length > 0,
      deliberationSqlite: deliberateDb.task?.status === 'DONE'
        && deliberateRuns.length >= 1
        && deliberateRuns.some((run) => run.budget?.runMaxTurns === 7)
        && deliberateDb.turns.length >= 5
        && deliberateDb.turns.every((turn) => turn.status === 'SUCCEEDED'),
      dmsAuthorsCorrect: report.dms.length === fixture.dms.length
        && report.dms.every((dm) => dm.agents.length > 0 && dm.agents.every((agent) => agent.authorId === dm.memberId)),
      noProtocolLeak: ledger.protocolLeaks.length === 0,
      realCallsReconciled: ledger.reconciliation.allRealCallsSucceeded
        && ledger.reconciliation.allAgentTurnsSucceeded
        && ledger.reconciliation.allAgentTurnsAccountedFor
        && ledger.reconciliation.countAcceptable,
      screenshotsSaved: requiredScreenshots.every((name) => screenshotNames.has(name)),
    };
    report.uncovered = Object.entries(report.checks)
      .filter(([, ok]) => ok !== true)
      .map(([name]) => name);
    report.ok = report.uncovered.length === 0;
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
    report.uncovered = report.uncovered.length > 0 ? report.uncovered : ['execution aborted before all checks completed'];
    if (cdp != null) {
      try {
        await screenshot('failure');
      } catch (shotError) {
        report.errors.push(`failure screenshot: ${String(shotError?.stack ?? shotError)}`);
      }
    }
  } finally {
    if (cdp != null) {
      try {
        cdp.ws.close();
      } catch {
        /* The owned renderer may already be closed. */
      }
    }
    writeResult();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
}

main().catch((error) => {
  report.errors.push(String(error?.stack ?? error));
  report.uncovered = ['uncaught verifier failure'];
  writeResult();
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
