/* R89 real-model UI evidence on an isolated synthetic root. Never retries unknown results. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { Cdp, until } = require('./verify-r81-members-launcher.cjs');

const port = Number(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] ?? '');
const out = path.resolve(process.argv[4] ?? path.join(fixtureRoot, 'evidence'));
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const q = JSON.stringify;
let cdp = null;

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
      await until(() => client.eval('document.body?.classList.contains("hifi-on")'), Boolean, 'hifi', 30000);
      return client;
    } catch {
      return null;
    }
  }, Boolean, 'owned R89 real window', 30000);
}

async function command(method, params = {}) {
  const envelope = { protocolVersion: 1, commandId: `r89-real-${randomUUID()}`, method, params };
  const response = await cdp.eval(`window.zs.command(${q(envelope)})`);
  if (!response?.ok) throw Error(`${method}: ${JSON.stringify(response?.error)}`);
  return response.data;
}

async function route(hash, selector = 'textarea.composer-input') {
  await cdp.eval(`location.hash=${q(hash)};true`);
  await until(() => cdp.eval(`document.querySelector(${q(selector)})!=null`), Boolean, hash, 30000);
  await sleep(350);
}

async function setComposer(value, selector = 'textarea.composer-input') {
  await cdp.eval(`(()=>{
    const ta=document.querySelector(${q(selector)});if(!ta)throw Error('composer missing: ${selector}');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,${q(value)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);return true;
  })()`);
  await sleep(180);
}

async function chooseToolbarMember(memberId) {
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title.includes('提及成员'));if(!b)throw Error('mention toolbar unavailable');b.click();return true})()`);
  await until(() => cdp.eval(`document.querySelector('[data-zs-mention-option=${q(memberId)}]')!=null`), Boolean, 'toolbar member candidate', 10000);
  await cdp.eval(`document.querySelector('[data-zs-mention-option=${q(memberId)}]').click();true`);
}

async function clickSend(selector = '.composer-send') {
  await cdp.eval(`(()=>{const b=document.querySelector(${q(selector)});if(!b||b.disabled)throw Error('send unavailable: ${selector}');b.click();return true})()`);
}

async function pool() {
  return (await command('room.pool', { roomId: fixture.roomId, limit: 30 })).items;
}

async function waitThreadWithBody(text, beforeIds = new Set()) {
  return until(async () => {
    const items = await pool();
    return items.find((item) => !beforeIds.has(item.threadId) && String(item.body?.text ?? '').includes(text)) ?? null;
  }, Boolean, `new thread ${text}`, 30000);
}

async function waitTerminal(threadId) {
  return until(async () => {
    const item = (await pool()).find((row) => row.threadId === threadId);
    if (!item) return null;
    return ['DONE', 'REVIEW', 'BLOCKED', 'CANCELLED'].includes(item.taskStatus) ? item : null;
  }, Boolean, `terminal ${threadId}`, 240000);
}

async function history(threadId) {
  return (await command('thread.history', { threadId, limit: 100 })).items;
}

async function waitReplyCount(threadId, count) {
  return until(async () => {
    const items = await history(threadId);
    return items.filter((item) => item.authorType === 'agent').length >= count ? items : null;
  }, Boolean, `reply count ${threadId}`, 240000);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  cdp = await connect();
  const report = {
    format: 'r89-real-ui-v1',
    ok: false,
    port,
    fixtureRoot,
    source: 'R89 working tree',
    startedAt: new Date().toISOString(),
    models: fixture.members.map((member) => ({ displayName: member.displayName, model: member.model, kind: member.kind })),
    stages: [],
    errors: [],
  };
  try {
    const identity = await command('app.identity', {});
    report.appDataDir = identity.appDataDir;
    if (path.resolve(identity.appDataDir) !== path.resolve(fixture.appData)) throw Error('wrong isolated app data root');
    for (const member of fixture.members) {
      const runtime = await command('member.runtime', { memberId: member.id });
      report.stages.push({ stage: `runtime:${member.displayName}`, binding: runtime.binding, executableStatus: runtime.executableStatus });
    }

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`);
    const beforeFirst = new Set((await pool()).map((item) => item.threadId));
    await setComposer('你好。请只用一句自然中文回复，确认你是 GLM 协调者。');
    await clickSend();
    const firstThread = await waitThreadWithBody('确认你是 GLM 协调者', beforeFirst);
    const firstTerminal = await waitTerminal(firstThread.threadId);
    const firstHistory = await waitReplyCount(firstThread.threadId, 1);
    const firstAgent = firstHistory.find((item) => item.authorType === 'agent');
    report.stages.push({
      stage: 'coordinator-greeting',
      threadId: firstThread.threadId,
      taskId: firstThread.taskId,
      taskStatus: firstTerminal.taskStatus,
      latestRunStatus: firstTerminal.latestRunStatus,
      authorId: firstAgent?.authorId ?? null,
      text: firstAgent?.body?.text ?? null,
      protocolVisible: firstHistory.some((item) => item.authorType === 'agent' && /task-complete-v1|schemaVersion|resultKey/.test(String(item.body?.text ?? ''))),
    });

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${firstThread.threadId}`, '.col-thread textarea.composer-input');
    await setComposer('继续用一句自然中文说明你仍能收到这条续问。', '.col-thread textarea.composer-input');
    await clickSend('.col-thread .composer-send');
    const followUpHistory = await waitReplyCount(firstThread.threadId, 2);
    const followUpTerminal = await waitTerminal(firstThread.threadId);
    const followAgents = followUpHistory.filter((item) => item.authorType === 'agent');
    report.stages.push({
      stage: 'coordinator-follow-up',
      taskStatus: followUpTerminal.taskStatus,
      latestRunStatus: followUpTerminal.latestRunStatus,
      agentCount: followAgents.length,
      text: followAgents.at(-1)?.body?.text ?? null,
      protocolVisible: followUpHistory.some((item) => item.authorType === 'agent' && /task-complete-v1|schemaVersion|resultKey/.test(String(item.body?.text ?? ''))),
    });

    await route(`/project/${fixture.projectId}/room/${fixture.roomId}`);
    const beforeMulti = new Set((await pool()).map((item) => item.threadId));
    await setComposer('');
    await chooseToolbarMember(fixture.members[0].id);
    await until(async () => (await cdp.eval('document.querySelector("textarea.composer-input").value')).includes(`@${fixture.members[0].displayName}`), Boolean, 'first toolbar member token');
    await chooseToolbarMember(fixture.members[1].id);
    await until(async () => {
      const body=await cdp.eval('document.querySelector("textarea.composer-input").value');
      const mentions=await cdp.eval('document.querySelector(".composer")?.getAttribute("data-zs-composer-mentions")??""');
      return body.includes(`@${fixture.members[0].displayName}`)
        && body.includes(`@${fixture.members[1].displayName}`)
        && mentions.includes(fixture.members[0].id)
        && mentions.includes(fixture.members[1].id);
    }, Boolean, 'consecutive toolbar members', 10000);
    const toolbarMembersBody = await cdp.eval('document.querySelector("textarea.composer-input").value');
    const toolbarMembersMentions = await cdp.eval('document.querySelector(".composer")?.getAttribute("data-zs-composer-mentions")??""');
    report.stages.push({ stage:'toolbar-multi-select', body:toolbarMembersBody, mentions:toolbarMembersMentions });
    const bodyBeforeDoc = await cdp.eval('document.querySelector("textarea.composer-input").value');
    await setComposer(`${bodyBeforeDoc}@合成`);
    await until(() => cdp.eval(`document.querySelector('[data-zs-mention-document="workspace:合成报告.md"]')!=null`), Boolean, 'real workspace doc candidate');
    await cdp.eval(`document.querySelector('[data-zs-mention-document="workspace:合成报告.md"]').click();true`);
    await until(async () => (await cdp.eval('document.querySelector("textarea.composer-input").value')).includes('@文档：合成报告.md'), Boolean, 'real doc token');
    await until(() => cdp.eval(`document.querySelectorAll('[data-zs-att="ready"]').length>0`), Boolean, 'real doc attachment ready', 20000);
    await setComposer(`${await cdp.eval('document.querySelector("textarea.composer-input").value')} 请分别读取这份合成文档，只回答唯一标记 R89_REAL_DOC_7531 是否存在以及你的姓名。`);
    await clickSend();
    const multiThread = await waitThreadWithBody('R89_REAL_DOC_7531', beforeMulti);
    const multiTerminal = await waitTerminal(multiThread.threadId);
    const multiHistory = await waitReplyCount(multiThread.threadId, 2);
    const multiAgents = multiHistory.filter((item) => item.authorType === 'agent');
    const db = new Database(path.join(fixture.appData, 'state.sqlite'), { readonly: true, fileMustExist: true });
    let childRows;
    let contexts;
    let calls;
    try {
      childRows = db.prepare(`SELECT t.id,t.owner_member_id owner,t.status,m.display_name FROM tasks t JOIN project_members m ON m.id=t.owner_member_id WHERE t.parent_task_id=? ORDER BY t.owner_member_id`).all(multiThread.taskId);
      contexts = db.prepare(`SELECT a.member_id,a.status,c.included_refs_json FROM context_bundles c JOIN agent_turns a ON a.id=c.turn_id
        JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE t.parent_task_id=? ORDER BY a.member_id`).all(multiThread.taskId);
      calls = db.prepare('SELECT id,runtime_kind,model,member_id,status,response_model FROM real_calls ORDER BY id').all();
    } finally { db.close(); }
    report.stages.push({
      stage: 'explicit-multi-document',
      threadId: multiThread.threadId,
      taskId: multiThread.taskId,
      taskStatus: multiTerminal.taskStatus,
      latestRunStatus: multiTerminal.latestRunStatus,
      childRows,
      contexts: contexts.map((row) => ({ memberId: row.member_id, status: row.status, marker: String(row.included_refs_json).includes('R89_REAL_DOC_7531') })),
      agents: multiAgents.map((item) => ({ authorId: item.authorId, text: item.body?.text ?? '' })),
      protocolVisible: multiHistory.some((item) => item.authorType === 'agent' && /task-complete-v1|schemaVersion|resultKey/.test(String(item.body?.text ?? ''))),
    });
    report.realCalls = calls;
    report.ok = report.stages.find((s) => s.stage === 'coordinator-greeting')?.taskStatus === 'DONE'
      && report.stages.find((s) => s.stage === 'coordinator-follow-up')?.taskStatus === 'DONE'
      && report.stages.find((s) => s.stage === 'coordinator-greeting')?.protocolVisible === false
      && report.stages.find((s) => s.stage === 'coordinator-follow-up')?.protocolVisible === false
      && toolbarMembersBody.includes(`@${fixture.members[0].displayName}`)
      && toolbarMembersBody.includes(`@${fixture.members[1].displayName}`)
      && toolbarMembersMentions.includes(fixture.members[0].id)
      && toolbarMembersMentions.includes(fixture.members[1].id)
      && report.stages.find((s) => s.stage === 'explicit-multi-document')?.taskStatus === 'DONE'
      && multiAgents.length === 2
      && new Set(multiAgents.map((item) => item.authorId)).size === 2
      && contexts.length === 2
      && contexts.every((row) => String(row.included_refs_json).includes('R89_REAL_DOC_7531'))
      && childRows.length === 2
      && report.stages.find((s) => s.stage === 'explicit-multi-document')?.protocolVisible === false;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    cdp.ws.close();
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
    cdp.ws.close();
    throw error;
  }
})().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
