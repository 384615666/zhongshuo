import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {pumpDeliberation} from '../../src/daemon/deliberationRunner.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {publishDeliberationArtifact} from '../../src/persistence/stores/deliberation.ts';
import {applyRecovery} from '../../src/daemon/stopFlow.ts';

afterEach(() => vi.unstubAllEnvs());
type Disposition = 'conversation' | 'direct_answer' | 'no_reply';
type Sent = {taskId: string; threadId: string; messageId: string};
const draft = (disposition: Disposition, summary: string, statement = '25×80=2000') => ({
  schemaVersion: 'analysis-draft-v1', summary, document: null,
  completion: {disposition, reason: '按本条用户请求判断'},
  claims: disposition === 'direct_answer' ? [{claimId: 'answer', statement, kind: 'observed', evidenceIds: []}] : [],
  recommendations: [], openQuestions: [],
});

async function fixture() {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake');
  const dir = mkdtempSync(join(tmpdir(), 'zs-r132-short-')), project = join(dir, 'project');
  mkdirSync(project);
  const dbPath = join(dir, 'state.sqlite');
  let db = openDatabase(dbPath), script: FakeTurnScript = [];
  const adapters: FakeRuntimeAdapter[] = [];
  function makeWorker() {
    const adapter = new FakeRuntimeAdapter({structuredFinal: false, turnScriptSequencer: () => script});
    adapters.push(adapter);
    return new DispatchWorker({db, adapter, leaseOwner: `r132-${adapters.length}`, appDataDir: dir, enableDeliberate: true});
  }
  let worker = makeWorker();
  async function cmd<T = unknown>(method: string, params: unknown): Promise<T> {
    const result = await dispatchDaemonCommand({db, localUserId: 'r132-human', appDataDir: dir, interruptTurn: (id: string) => worker.interruptTurn(id)}, {
      protocolVersion: 1, commandId: randomUUID(), method, params,
    }) as {ok: boolean; data: T; error?: unknown};
    if (!result.ok) throw Error(JSON.stringify(result.error));
    return result.data;
  }
  const projectId = (await cmd<{project: {id: string}}>('project.open', {path: project})).project.id;
  const room = (await cmd<{items: {id: string; conversationId: string}[]}>('room.list', {projectId})).items[0]!;
  const defaultMembers = db.prepare('SELECT id FROM project_members WHERE project_id=?').all(projectId) as {id: string}[];
  const members: string[] = [];
  for (const displayName of ['Claude', 'Codex']) {
    const {memberId} = await cmd<{memberId: string}>('member.create', {projectId, displayName});
    members.push(memberId);
    await cmd('member.setRuntime', {memberId, kind: 'fake', permissionMode: 'bypassPermissions'});
  }
  members.sort();
  const revision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision: number}).revision;
  await cmd('room.update', {roomId: room.id, expectedRevision: revision, coordinatorMemberId: members[0]});
  for (const member of defaultMembers) await cmd('member.setEnabled', {memberId: member.id, enabled: false});
  const send = (threadId?: string) => cmd<Sent>('message.submit', {
    target: threadId ? {kind: 'thread', projectId, conversationId: room.conversationId, threadId}
      : {kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId},
    body: '@全体 请分别回复', intent: 'default', collaboration: 'deliberate', mentions: [{kind: 'all'}],
  });
  const run = async (payload: unknown, prefix: FakeTurnScript = []) => {
    script = [...prefix, {kind: 'event', event: {kind: 'turn.completed', finalText: JSON.stringify(payload)}}];
    expect(await worker.runOnce()).toBe(true);
  };
  const count = (table: string, where = '') => (db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get() as {n: number}).n;
  const replies = (runId: string) => (db.prepare(`SELECT m.id,m.author_id,m.body_json FROM messages m
    WHERE json_extract(m.body_json,'$.collaborationStage.runId')=? ORDER BY m.thread_message_seq`).all(runId) as
    Array<{id: string; author_id: string; body_json: string}>).map(row => ({...row, body: JSON.parse(row.body_json)}));
  const runId = () => (db.prepare('SELECT id FROM workflow_runs ORDER BY rowid DESC LIMIT 1').get() as {id: string}).id;
  const pump = (taskId: string) => pumpDeliberation(db, taskId, {absenceToleranceMs: 60_000, blobDir: join(dir, 'artifacts')});
  const restart = async () => {
    await adapters.at(-1)!.closeAllSessions(); db.close(); db = openDatabase(dbPath);
    applyRecovery(db, Date.now()); worker = makeWorker();
  };
  const cleanup = async () => {
    for (const adapter of adapters) await adapter.closeAllSessions();
    db.close(); rmSync(dir, {recursive: true, force: true});
  };
  return {get db() {return db;}, get worker() {return worker;}, dir, project, projectId, room, members,
    adapters, cmd, send, run, count, replies, runId, pump, restart, cleanup};
}

function expectShortCircuit(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  expect(f.db.prepare('SELECT status,stage FROM workflow_runs ORDER BY rowid DESC LIMIT 1').get()).toEqual({status: 'SUCCEEDED', stage: 'PUBLISH'});
  expect(f.db.prepare('SELECT status,response_kind,current_delivery_id FROM tasks WHERE id=?').get(taskId))
    .toEqual({status: 'DONE', response_kind: 'conversation', current_delivery_id: null});
  expect(f.count('artifacts', "WHERE kind IN ('cross_review','synthesis','ratify_response','final_report')")).toBe(0);
  expect(f.count('task_deliveries')).toBe(0);
  expect(f.count('agent_turns')).toBe(2);
  expect(f.count('outbox', "WHERE status IN ('pending','leased')")).toBe(0);
}

describe('R132 short exchange replies through formal @all and fake worker', () => {
  it('publishes both actual member replies with exact turn/run identity; restart and repeated pumps add nothing', async () => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce();
      await f.run(draft('conversation', 'Claude 的可读回复'));
      expect(f.count('messages', "WHERE author_type='agent'")).toBe(0);
      const runId = f.runId();
      await f.run(draft('conversation', 'Codex 的可读回复'));
      const replies = f.replies(runId);
      expect(replies.map(row => [row.author_id, row.body.text])).toEqual([
        [f.members[0], 'Claude 的可读回复'], [f.members[1], 'Codex 的可读回复'],
      ]);
      for (const reply of replies) {
        const turn = f.db.prepare('SELECT id FROM agent_turns WHERE run_id=? AND member_id=? AND status=\'SUCCEEDED\'').get(runId, reply.author_id) as {id: string};
        expect(reply.body.collaborationStage).toEqual({stage: 'INDEPENDENT', roundNo: 0, runId, turnId: turn.id});
        expect(f.db.prepare("SELECT run_id,turn_id FROM domain_events WHERE kind='thread.replyAdded' AND json_extract(payload_json,'$.messageId')=?").get(reply.id))
          .toEqual({run_id: runId, turn_id: turn.id});
      }
      expectShortCircuit(f, root.taskId);
      const sequences = f.db.prepare('SELECT last_message_seq,revision FROM conversation_threads WHERE id=?').get(root.threadId);
      const events = f.count('domain_events');
      await f.restart(); f.pump(root.taskId); f.pump(root.taskId);
      expect(await f.worker.runOnce()).toBe(false);
      expect(f.replies(runId)).toEqual(replies); expect(f.count('domain_events')).toBe(events);
      expect(f.db.prepare('SELECT last_message_seq,revision FROM conversation_threads WHERE id=?').get(root.threadId)).toEqual(sequences);
      expect(f.adapters.reduce((n, adapter) => n + adapter.startTurnLog.length, 0)).toBe(2);
      expect(f.count('messages', "WHERE id LIKE 'msg_report_%'")).toBe(0);
    } finally {await f.cleanup();}
  });

  it('restores only the completed reply after an interrupted restart without replaying the missing peer', async () => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce();
      await f.run(draft('conversation', '重启前真实完成的回复'));
      const runId = f.runId(); await f.restart(); f.pump(root.taskId);
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(runId)).toEqual({status: 'INTERRUPTED'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status: 'BLOCKED'});
      const replies = f.replies(runId);
      expect(replies.map(row => row.body.text)).toEqual(['重启前真实完成的回复']);
      f.pump(root.taskId); await f.worker.runOnce(); f.pump(root.taskId);
      expect(f.replies(runId)).toEqual(replies);
      expect(f.count('agent_turns')).toBe(1);
      expect(f.adapters.reduce((n, adapter) => n + adapter.startTurnLog.length, 0)).toBe(1);
      expect(f.count('task_deliveries')).toBe(0);
    } finally {await f.cleanup();}
  });

  it.each([
    ['no_reply', 'conversation'], ['conversation', 'no_reply'], ['no_reply', 'no_reply'],
    ['conversation', 'direct_answer'], ['direct_answer', 'conversation'],
    ['no_reply', 'direct_answer'], ['direct_answer', 'no_reply'], ['direct_answer', 'direct_answer'],
  ] as const)('respects each member disposition: host=%s peer=%s', async (host, peer) => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce();
      await f.run(draft(host, '主持回复')); await f.run(draft(peer, '成员回复'));
      expect(f.replies(f.runId()).map(row => [row.author_id, row.body.text])).toEqual([
        ...(host === 'no_reply' ? [] : [[f.members[0], '主持回复']]),
        ...(peer === 'no_reply' ? [] : [[f.members[1], '成员回复']]),
      ]);
      expectShortCircuit(f, root.taskId);
    } finally {await f.cleanup();}
  });

  it('keeps conflicting direct answers in the existing review flow', async () => {
    const f = await fixture(); try {
      await f.send(); await f.worker.runOnce();
      await f.run(draft('direct_answer', '2000')); await f.run(draft('direct_answer', '2001', '25×80=2001'));
      expect(f.db.prepare('SELECT status,stage FROM workflow_runs').get()).toEqual({status: 'RUNNING', stage: 'CROSS_REVIEW'});
      expect(f.replies(f.runId())).toHaveLength(2);
      expect(f.count('domain_events', "WHERE kind='run.shortExchangeCompleted'")).toBe(0);
    } finally {await f.cleanup();}
  });

  it.each(['conversation', 'no_reply'] as const)('keeps successful %s honest when the peer fails, including restart', async disposition => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce();
      await f.run(draft(disposition, '真实已完成回复'));
      await f.run(draft('conversation', '不可当作回复'), [{kind: 'event', event: {kind: 'turn.failed', code: 'PROVIDER_FAILED', message: '明确失败', retryable: false}}]);
      expect(f.db.prepare('SELECT status FROM workflow_runs').get()).toEqual({status: 'PARTIAL'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status: 'BLOCKED'});
      expect(f.replies(f.runId()).map(row => row.body.text)).toEqual(disposition === 'no_reply' ? [] : ['真实已完成回复']);
      expect(f.count('domain_events', "WHERE kind='run.shortExchangeCompleted'")).toBe(0);
      const before = f.count('messages'); await f.restart(); f.pump(root.taskId);
      expect(await f.worker.runOnce()).toBe(false); expect(f.count('messages')).toBe(before);
      expect(f.count('task_deliveries')).toBe(0);
    } finally {await f.cleanup();}
  });

  it.each(['absent', 'unavailable'] as const)('does not turn an explicitly %s peer into assent or a visible reply', async status => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce(); await f.run(draft('conversation', '仅此成员真实完成'));
      const runId = f.runId();
      // Explicit terminal absence fixture; elapsed time alone never proves absence.
      f.db.prepare('UPDATE run_participants SET status=? WHERE run_id=? AND member_id=?').run(status, runId, f.members[1]);
      f.db.prepare("UPDATE outbox SET status='failed' WHERE status='pending' AND dispatch_key LIKE ?").run(`%:IND:${f.members[1]}:%`);
      f.pump(root.taskId);
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(runId)).toEqual({status: 'PARTIAL'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status: 'BLOCKED'});
      expect(f.replies(runId).map(row => row.body.text)).toEqual(['仅此成员真实完成']);
      expect(f.count('domain_events', "WHERE kind='run.shortExchangeCompleted'")).toBe(0);
      expect(f.count('agent_turns')).toBe(1); expect(f.count('task_deliveries')).toBe(0);
    } finally {await f.cleanup();}
  });

  it('does not publish silent bookkeeping when actual file work blocks the shortcut', async () => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce();
      await f.run(draft('no_reply', '内部无需回复判断'), [{kind: 'writeFile', path: '真实文件.md', content: '保留文件事实'}]);
      await f.run(draft('conversation', '请核对已有文件'));
      expect(readFileSync(join(f.project, '真实文件.md'), 'utf8')).toBe('保留文件事实');
      expect(f.replies(f.runId()).map(row => row.body.text)).toEqual(['请核对已有文件']);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status: 'BLOCKED'});
      expect(f.count('task_deliveries')).toBe(0);
    } finally {await f.cleanup();}
  });

  it.each(['pending', 'accepted', 'changes_requested'] as const)('keeps an existing %s file delivery and binds a silent-host follow-up to the peer reply', async reviewStatus => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce();
      await f.run(draft('conversation', '旧主持回复')); await f.run(draft('conversation', '旧成员回复'));
      const oldRunId = f.runId(), history = f.replies(oldRunId);
      // Existing immutable delivery, including its original file/version references.
      f.db.prepare(`INSERT INTO task_deliveries(id,task_id,run_id,revision,manifest_hash,artifact_refs_json,change_set_refs_json,verification_refs_json,review_status,reviewed_by,reviewed_at)
        VALUES('existing-delivery',?,?,1,'original-hash','["original-file"]','[]','[]',?,?,?)`)
        .run(root.taskId, oldRunId, reviewStatus, reviewStatus === 'accepted' ? 'r132-human' : null, reviewStatus === 'accepted' ? 1 : null);
      f.db.prepare("UPDATE tasks SET current_delivery_id='existing-delivery',status=?,response_kind='work' WHERE id=?")
        .run(reviewStatus === 'pending' ? 'REVIEW' : reviewStatus === 'accepted' ? 'DONE' : 'ACTIVE', root.taskId);
      const delivery = f.db.prepare('SELECT * FROM task_deliveries').get();
      const followup = await f.send(root.threadId); await f.worker.runOnce();
      // Isolate completion from the existing REVIEW startup gate: this follow-up
      // is executing, while the prior immutable delivery is still pending review.
      if (reviewStatus === 'pending') f.db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id=?").run(root.taskId);
      await f.run(draft('no_reply', '本轮主持明确静默')); await f.run(draft('conversation', '本轮 Codex 回复'));
      expect(f.runId()).not.toBe(oldRunId);
      expect(f.replies(oldRunId)).toEqual(history);
      const replies = f.replies(f.runId()); expect(replies.map(row => row.body.text)).toEqual(['本轮 Codex 回复']);
      expect(f.db.prepare('SELECT status,result_message_id FROM thread_reply_requests WHERE message_id=?').get(followup.messageId))
        .toEqual({status: 'succeeded', result_message_id: replies[0]!.id});
      expect(f.db.prepare('SELECT * FROM task_deliveries').all()).toEqual([delivery]);
      expect(f.db.prepare('SELECT status,current_delivery_id,response_kind FROM tasks WHERE id=?').get(root.taskId))
        .toEqual({status: reviewStatus === 'pending' ? 'REVIEW' : reviewStatus === 'changes_requested' ? 'ACTIVE' : 'DONE', current_delivery_id: 'existing-delivery', response_kind: 'work'});
      expect(f.count('agent_turns')).toBe(4);
    } finally {await f.cleanup();}
  });

  it('ignores duplicate detached drafts and members outside the frozen seats', async () => {
    const f = await fixture(); try {
      const root = await f.send(); await f.worker.runOnce(); await f.run(draft('conversation', '真实主持回复'));
      const outsider = (await f.cmd<{memberId: string}>('member.create', {projectId: f.projectId, displayName: '名单外成员'})).memberId;
      for (const [i, authorId] of [f.members[0]!, outsider].entries()) {
        expect(publishDeliberationArtifact(f.db, {artifactId: `detached-${i}`, projectId: f.projectId,
          conversationId: f.room.conversationId, threadId: root.threadId, taskId: root.taskId, runId: f.runId(),
          authorId, kind: 'analysis_draft', revision: 2, payload: draft('conversation', '不可冒充本轮回复'),
          blobDir: join(f.dir, 'artifacts'), now: Date.now()}).ok).toBe(true);
      }
      await f.run(draft('conversation', '真实成员回复'));
      expect(f.replies(f.runId()).map(row => row.body.text)).toEqual(['真实主持回复', '真实成员回复']);
      expectShortCircuit(f, root.taskId);
    } finally {await f.cleanup();}
  });
});
