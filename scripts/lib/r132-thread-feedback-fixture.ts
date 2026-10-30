/** Formal commands + real Fake worker. Opens only a fresh synthetic database. */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {parseDelibStep} from '../../src/daemon/deliberationRunner.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {localUserId} from '../../src/contracts/daemonIpc.ts';

const [mode, dirArg, projectArg] = process.argv.slice(2);
if (!dirArg) throw Error('Expected seed/snapshot and isolated data directory');
const dir = resolve(dirArg);
if (resolve(process.env.ZS_APP_DATA ?? '') !== dir || process.env.ZS_RUNTIME !== 'fake'
  || process.env.ZS_ALLOW_FAKE !== '1' || process.env.ZS_REAL_DISPATCH_GUARD !== '1') throw Error('Explicit isolated Fake environment required');
type Sent = {taskId: string; threadId: string; messageId: string};
function snapshot() {
  const meta = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
  const db = new Database(join(dir, 'state.sqlite'), {readonly: true, fileMustExist: true});
  try {
    return {realCalls: (db.prepare('SELECT count(*) n FROM real_calls').get() as {n: number}).n,
      tasks: db.prepare('SELECT id,status,revision FROM tasks ORDER BY rowid').all(),
      runs: db.prepare('SELECT id,task_id,status,stage FROM workflow_runs ORDER BY rowid').all(),
      turns: db.prepare('SELECT id,run_id,member_id,status FROM agent_turns ORDER BY rowid').all(),
      pendingOutbox: db.prepare("SELECT id,status FROM outbox WHERE status IN ('pending','leased')").all(),
      replies: (db.prepare("SELECT id,author_id,thread_id,body_json,thread_message_seq FROM messages WHERE author_type='agent' ORDER BY thread_message_seq").all() as Array<{body_json: string}>).map(row => ({...row, body: JSON.parse(row.body_json)})),
      events: db.prepare('SELECT seq,kind,task_id FROM domain_events ORDER BY seq').all(),
      threadIds: [meta.waiting.threadId, meta.broadcast.threadId]};
  } finally { db.close(); }
}
async function seed() {
  if (!projectArg || existsSync(join(dir, 'state.sqlite'))) throw Error('Seed requires a fresh database');
  const project = resolve(projectArg);
  if (resolve(project, '..') !== resolve(dir, '..')) throw Error('Synthetic project must be sibling of data root');
  mkdirSync(dir, {recursive: true}); mkdirSync(project, {recursive: true});
  writeFileSync(join(project, 'README.md'), '# R132 isolated UI proof\nNo user data or real model calls.\n');
  const db = openDatabase(join(dir, 'state.sqlite'));
  let script: FakeTurnScript = [];
  const adapterOptions = {structuredFinal: true, turnScriptSequencer: () => script};
  const adapter = new FakeRuntimeAdapter(adapterOptions);
  const worker = new DispatchWorker({db, adapter, leaseOwner: 'r132-ui-seed', appDataDir: dir, enableDeliberate: true, automaticRecovery: false});
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const reply = await dispatchDaemonCommand({db, appDataDir: dir, localUserId: localUserId(), interruptTurn: id => worker.interruptTurn(id)},
      {protocolVersion: 1, commandId: randomUUID(), method, params}) as {ok: boolean; data: T; error?: unknown};
    if (!reply.ok) throw Error(method + ': ' + JSON.stringify(reply.error));
    return reply.data;
  };
  const output = (body: unknown) => { script = [{kind: 'event', event: {kind: 'turn.completed', finalText: JSON.stringify(body)}}]; };
  try {
    await cmd('app.settings.set', {key: 'callBudget.enabled', value: 'false'});
    const {project: opened} = await cmd<{project: {id: string}}>('project.open', {path: project});
    const projectId = opened.id;
    db.prepare("UPDATE project_members SET enabled=0 WHERE project_id=? AND principal_type='agent'").run(projectId);
    const members = [];
    for (const name of ['R132 Claude', 'R132 Codex']) {
      const {memberId} = await cmd<{memberId: string}>('member.create', {projectId, displayName: name});
      await cmd('member.setRuntime', {memberId, kind: 'fake', permissionMode: 'bypassPermissions'});
      members.push({id: memberId, name});
    }
    const {room} = await cmd<{room: {id: string; conversationId: string; revision: number}}>('room.create', {projectId, name: 'R132 反馈验证', memberIds: members.map(m => m.id)});
    const revision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision: number}).revision;
    await cmd('room.update', {roomId: room.id, expectedRevision: revision, coordinatorMemberId: members[0]!.id});
    const target = {kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId};
    const question = '请确认本次读书会的茶点与场地预算。\n\n' + Array.from({length: 9}, (_, i) => `${i + 1}. 请确认第${i + 1}项安排：人数为十人，饮用水、茶点和座位均需在预算确认后再采购，不得擅自付款。`).join('\n') + '\n\n问题结尾校验：请选择仅饮用水或增加茶点，并明确总预算。';
    const waiting = await cmd<Sent>('message.submit', {target, body: 'R132 等待预算：请整理安排并向我确认完整预算问题。', intent: 'default', mentions: [{kind: 'member', memberId: members[0]!.id}]});
    // Genuine earlier task.get snapshot: inject this receipt once to create stale detail cache.
    const staleTask = await cmd('task.get', {taskId: waiting.taskId});
    output({schemaVersion: 'task-complete-v1', resultKey: 'r132-question', answer: '场地与座位已核对，茶点采购需要你确认预算。', changeSummary: '', responseKind: 'conversation', userQuestion: question, document: null, files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: []});
    await worker.drain();
    const waitingTask = await cmd<{task: {status: string}; executionStatus: {phase: string}}>('task.get', {taskId: waiting.taskId});
    if (waitingTask.executionStatus.phase !== 'WAITING_FOR_USER') throw Error('Real worker did not enter user waiting state: ' + JSON.stringify(waitingTask));
    adapterOptions.structuredFinal = false; // Deliberation drafts already carry their own protocol.
    const broadcast = await cmd<Sent>('message.submit', {target, body: 'R132 短交流 @全体：请各自简短介绍自己的核对重点。', intent: 'default', collaboration: 'deliberate', mentions: [{kind: 'all'}]});
    await worker.runOnce();
    const answers = ['Claude 的可读回复：我负责核对场地安排与预算，确认后再执行。', 'Codex 的可读回复：我负责检查座位和饮用水清单，等待你的采购决定。'];
    for (let i = 0; i < members.length; i++) {
      const pending = db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key: string} | undefined;
      const step = pending ? parseDelibStep(pending.dispatch_key) : null;
      const memberIndex = members.findIndex(member => member.id === step?.memberId);
      if (memberIndex < 0) throw Error('Pending independent turn has no fixture member');
      const answer = answers[memberIndex]!;
      output({schemaVersion: 'analysis-draft-v1', summary: answer, document: null, completion: {disposition: 'conversation', reason: '用户只要求简短交流'}, claims: [], recommendations: [], openQuestions: []});
      if (!await worker.runOnce()) throw Error('Expected an independent real member turn');
    }
    const broadcastTask = await cmd<{task: {status: string}}>('task.get', {taskId: broadcast.taskId});
    if (broadcastTask.task.status !== 'DONE') throw Error('Short exchange did not finish');
    await cmd('navigation.set', {clientId: 'desktop-hifi', activeProjectId: projectId, visibleProjectIds: [projectId], expandedProjectIds: [projectId], pinnedProjectIds: [], fileGitTabs: {}});
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({synthetic: true, projectId, roomId: room.id, members, waiting, broadcast, question, answers, staleTask, waitingTask, fakeStartTurns: adapter.startTurnLog.length}, null, 2));
  } finally { await adapter.closeAllSessions(); await worker.awaitInFlightTurns(3000); db.close(); }
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify(snapshot(), null, 2));
  console.log(JSON.stringify({ok: true, data: dir}));
}
if (mode === 'snapshot') console.log(JSON.stringify(snapshot()));
else if (mode === 'seed') void seed().catch(error => { console.error(error); process.exitCode = 1; });
else throw Error('Expected seed or snapshot');
