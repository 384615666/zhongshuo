/** Fresh synthetic data only: ordinary @all, formal commands and DispatchWorker. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { localUserId } from '../../src/contracts/daemonIpc.ts';

const [mode, dirArg, projectArg] = process.argv.slice(2);
if (!dirArg) throw Error('Expected seed/snapshot and isolated data directory');
const dir = resolve(dirArg);
if (resolve(process.env.ZS_APP_DATA ?? '') !== dir || process.env.ZS_RUNTIME !== 'fake'
  || process.env.ZS_ALLOW_FAKE !== '1' || process.env.ZS_REAL_DISPATCH_GUARD !== '1') throw Error('Explicit isolated Fake environment required');
const marker = 'r134-ordinary-broadcast-synthetic-v1';

function snapshot() {
  const meta = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as { marker: string };
  if (meta.marker !== marker) throw Error('Not this verifier’s synthetic fixture');
  const db = new Database(join(dir, 'state.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return {
      realCalls: (db.prepare('SELECT count(*) n FROM real_calls').get() as { n: number }).n,
      tasks: db.prepare('SELECT id,parent_task_id,status,route_json FROM tasks ORDER BY rowid').all(),
      turns: db.prepare('SELECT id,run_id,member_id,status FROM agent_turns ORDER BY rowid').all(),
      runs: db.prepare('SELECT id,task_id,status,stage FROM workflow_runs ORDER BY rowid').all(),
      coordination: db.prepare('SELECT run_id,task_id,state,plan_json,integration_run_id FROM coordination_runs ORDER BY rowid').all(),
      integrationAttempts: (db.prepare('SELECT count(*) n FROM coordination_integration_attempts').get() as { n: number }).n,
      pendingOutbox: db.prepare("SELECT id,status FROM outbox WHERE status IN ('pending','leased')").all(),
      replies: (db.prepare("SELECT id,author_id,task_id,thread_id,body_json,thread_message_seq FROM messages WHERE author_type='agent' ORDER BY thread_message_seq").all() as Array<{ body_json: string }>).map(row => ({ ...row, body: JSON.parse(row.body_json) })),
      replyEvents: (db.prepare("SELECT event_id,turn_id,run_id,task_id,payload_json FROM domain_events WHERE kind='thread.replyAdded' ORDER BY seq").all() as Array<{ payload_json: string }>).map(row => ({ ...row, payload: JSON.parse(row.payload_json) })),
    };
  } finally { db.close(); }
}

async function seed() {
  if (!projectArg || existsSync(join(dir, 'state.sqlite'))) throw Error('Seed requires a fresh database');
  const project = resolve(projectArg);
  if (resolve(project, '..') !== resolve(dir, '..')) throw Error('Synthetic project must be sibling of data root');
  mkdirSync(dir, { recursive: true }); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# R134 ordinary broadcast synthetic fixture\nNo original data or model calls.\n');
  const db = openDatabase(join(dir, 'state.sqlite'));
  const members: Array<{ id: string; name: string; answer: string }> = [];
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: ({ text }) => {
    const turnId = /\bturn=([^\s]+)/u.exec(text)?.[1];
    const turn = db.prepare('SELECT member_id FROM agent_turns WHERE id=?').get(turnId) as { member_id: string } | undefined;
    const member = members.find(m => m.id === turn?.member_id);
    const resultKey = /resultKey=([^；\n]+)/u.exec(text)?.[1] ?? /"resultKey":"(result_[^"]+)"/u.exec(text)?.[1];
    if (!member || !resultKey) throw Error('Fake reply must bind an actual member turn and result key');
    return [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({
      schemaVersion: 'task-complete-v1', resultKey, responseKind: 'conversation', answer: member.answer,
      changeSummary: '', document: null, files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
    }) } }];
  } });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r134-broadcast-ui-seed', appDataDir: dir, automaticRecovery: false });
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const reply = await dispatchDaemonCommand({ db, appDataDir: dir, localUserId: localUserId(), interruptTurn: id => worker.interruptTurn(id) },
      { protocolVersion: 1, commandId: randomUUID(), method, params }) as { ok: boolean; data: T; error?: unknown };
    if (!reply.ok) throw Error(method + ': ' + JSON.stringify(reply.error));
    return reply.data;
  };
  try {
    await cmd('app.settings.set', { key: 'callBudget.enabled', value: 'false' });
    const { project: opened } = await cmd<{ project: { id: string } }>('project.open', { path: project });
    const projectId = opened.id;
    for (const [name, answer] of [
      ['R134 甲', '甲的独立回复：我核对了场地与人数，这是甲自己的答复。'],
      ['R134 乙', '乙的独立回复：我核对了座位与饮用水，这是乙自己的答复。'],
    ]) {
      const { memberId } = await cmd<{ memberId: string }>('member.create', { projectId, displayName: name });
      await cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
      members.push({ id: memberId, name: name!, answer: answer! });
    }
    const { room } = await cmd<{ room: { id: string; conversationId: string; revision: number } }>('room.create', { projectId, name: 'R134 普通全体广播', memberIds: members.map(m => m.id) });
    const revision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as { revision: number }).revision;
    await cmd('room.update', { roomId: room.id, expectedRevision: revision, coordinatorMemberId: members[0]!.id });
    const submitParams = {
      target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
      body: '@全体 R134 普通广播：请每位成员分别回复自己的核对重点。', intent: 'default', mentions: [{ kind: 'all' }],
    }; // Deliberate collaboration is deliberately absent: this is ordinary @all.
    const broadcast = await cmd<{ taskId: string; threadId: string; messageId: string }>('message.submit', submitParams);
    for (let i = 0; i < 12; i++) {
      await worker.drain();
      const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(broadcast.taskId) as { status: string };
      if (task.status === 'DONE') break;
    }
    const status = (db.prepare('SELECT status FROM tasks WHERE id=?').get(broadcast.taskId) as { status: string }).status;
    if (status !== 'DONE' || adapter.startTurnLog.length !== 2) throw Error('Ordinary @all must finish with exactly two real Fake member turns: ' + status + '/' + adapter.startTurnLog.length);
    await cmd('navigation.set', { clientId: 'desktop-hifi', activeProjectId: projectId, visibleProjectIds: [projectId], expandedProjectIds: [projectId], pinnedProjectIds: [], fileGitTabs: {} });
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ marker, synthetic: true, projectId, roomId: room.id, members, broadcast, submitParams, fakeStartTurns: adapter.startTurnLog.length }, null, 2));
  } finally { await adapter.closeAllSessions(); await worker.awaitInFlightTurns(3000); db.close(); }
  const before = snapshot();
  if (before.realCalls !== 0 || before.replies.length !== 2 || before.pendingOutbox.length !== 0) throw Error('Invalid isolated broadcast seed');
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify(before, null, 2));
  console.log(JSON.stringify({ ok: true, data: dir }));
}
if (mode === 'snapshot') console.log(JSON.stringify(snapshot()));
else if (mode === 'seed') void seed().catch(error => { console.error(error); process.exitCode = 1; });
else throw Error('Expected seed or snapshot');
