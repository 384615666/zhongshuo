/* Read-only verification of an existing R89 real-model result. Never dispatches or retries. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const fixtureRoot = path.resolve(process.argv[2] ?? '');
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
const resultPath = path.join(fixtureRoot, 'evidence', 'result.json');
const rawText = fs.readFileSync(resultPath, 'utf8');
const result = JSON.parse(rawText);
const stage = (name) => result.stages.find((item) => item.stage === name);
const greeting = stage('coordinator-greeting');
const followUp = stage('coordinator-follow-up');
const single = stage('explicit-single-non-coordinator');
const roomAll = stage('room-all');
const toolbar = stage('toolbar-multi-select');
const multi = stage('explicit-multi-document');

const db = new Database(path.join(fixture.appData, 'state.sqlite'), { readonly: true, fileMustExist: true });
let dbFacts;
let visibleProtocol;
try {
  const childCount = (taskId) => Number(db.prepare('SELECT count(*) AS count FROM tasks WHERE parent_task_id=?').get(taskId).count);
  const messagesFor = (threadId) => db.prepare(`SELECT body_json FROM messages WHERE thread_id=? AND author_type='agent' ORDER BY thread_message_seq`).all(threadId);
  const visibleBodies = {
    coordinatorGreeting: messagesFor(greeting.threadId),
    coordinatorFollowUp: messagesFor(greeting.threadId),
    single: messagesFor(single.threadId),
    roomAll: messagesFor(allThreadId(roomAll)),
    multi: messagesFor(multi.threadId),
  };
  function allThreadId(value) {
    return value.threadId;
  }
  visibleProtocol = Object.fromEntries(Object.entries(visibleBodies).map(([name, rows]) => [
    name,
    rows.some((row) => /task-complete-v1|schemaVersion|resultKey/.test(String(JSON.parse(row.body_json).text ?? ''))),
  ]));
  dbFacts = {
    realCalls: Number(db.prepare('SELECT count(*) AS count FROM real_calls').get().count),
    succeededCalls: Number(db.prepare("SELECT count(*) AS count FROM real_calls WHERE status='succeeded'").get().count),
    children: {
      single: childCount(single.taskId),
      roomAll: childCount(roomAll.taskId),
      multi: childCount(multi.taskId),
    },
  };
} finally {
  db.close();
}

const checks = {
  rawHasNoExecutionErrors: Array.isArray(result.errors) && result.errors.length === 0,
  coordinatorGreetingDone: greeting?.taskStatus === 'DONE' && greeting?.authorId === fixture.coordinatorMemberId,
  coordinatorFollowUpDone: followUp?.taskStatus === 'DONE' && followUp?.agentCount === 2,
  singleNonCoordinator: single?.taskStatus === 'DONE'
    && single?.agents?.length === 1
    && single.agents[0]?.authorId === fixture.members[1].id,
  roomAllBothMembers: roomAll?.taskStatus === 'DONE'
    && roomAll?.agents?.length === 2
    && new Set(roomAll.agents.map((item) => item.authorId)).size === 2,
  toolbarKeptBoth: String(toolbar?.body ?? '').includes('@GLM')
    && String(toolbar?.body ?? '').includes('@DeepSeek')
    && String(toolbar?.mentions ?? '').includes(fixture.members[0].id)
    && String(toolbar?.mentions ?? '').includes(fixture.members[1].id),
  multiDocumentDone: multi?.taskStatus === 'DONE'
    && multi?.childRows?.length === 2
    && multi?.agents?.length === 2
    && multi?.contexts?.length === 2
    && multi.contexts.every((item) => item.status === 'SUCCEEDED' && item.marker === true),
  visibleTextHasNoControlJson: Object.values(visibleProtocol).every((value) => value === false),
  sevenRealCallsSucceeded: dbFacts.realCalls === 7 && dbFacts.succeededCalls === 7,
  childTaskCountsMatch: dbFacts.children.single === 0 && dbFacts.children.roomAll === 2 && dbFacts.children.multi === 2,
};
const verification = {
  format: 'r89-real-existing-result-verification-v1',
  pass: Object.values(checks).every(Boolean),
  rawResult: 'result.json',
  rawResultSha256: require('node:crypto').createHash('sha256').update(rawText).digest('hex'),
  rawHarnessOk: result.ok,
  harnessCorrection: 'Original harness asserted 6 calls after running 7 real calls. Expected count is 7 (2 coordinator + 1 single + 2 room-all + 2 toolbar-multi). No model call was repeated.',
  checks,
  dbFacts,
  visibleProtocol,
  verifiedAt: new Date().toISOString(),
};
const output = path.join(fixtureRoot, 'evidence', 'result-verification.json');
fs.writeFileSync(output, JSON.stringify(verification, null, 2) + '\n');
process.stdout.write(JSON.stringify({ pass: verification.pass, output, checks, dbFacts }) + '\n');
process.exitCode = verification.pass ? 0 : 1;
