import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { captureBaseline } from '../../src/daemon/changeset.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r99-delib-observed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup(db: ZhongshuoDatabase, n: number) {
  const projectId = `p_delib_${n}`;
  const projectRoot = join(root, projectId);
  const appDataDir = join(root, `data_${n}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  db.prepare(`INSERT INTO projects (id,display_name,root_path,canonical_path,directory_identity,created_at)
    VALUES(?,?,?,?, '{}',0)`).run(projectId, projectId, projectRoot, projectRoot);
  db.prepare(`INSERT INTO project_members (id,project_id,display_name,principal_type,enabled)
    VALUES(?,?,?,'agent',1),(?,?,?,'agent',1)`).run(`m${n}a`, projectId, `成员甲${n}`, `m${n}b`, projectId, `成员乙${n}`);
  db.prepare('INSERT INTO rooms (id,project_id,name,coordinator_member_id) VALUES(?,?,?,?)').run(`r${n}`, projectId, `r${n}`, `m${n}a`);
  db.prepare("INSERT INTO conversations (id,project_id,kind,room_id) VALUES(?,?,'room',?)").run(`c${n}`, projectId, `r${n}`);
  const taskId = `task_delib_${n}`;
  const created = createRoomRootTask(db, {
    ids: { messageId: `msg_delib_${n}`, threadId: `thread_delib_${n}`, taskId, taskEventId: `evt_task_delib_${n}`, threadEventId: `evt_thread_delib_${n}` },
    projectId, conversationId: `c${n}`, roomId: `r${n}`, intent: 'default', title: `研讨 ${n}`, body: '研讨',
    mentions: [{ kind: 'member', memberId: `m${n}a` }, { kind: 'member', memberId: `m${n}b` }],
    author: { authorType: 'human', authorId: 'u_local' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DELIBERATE', rosterSource: 'all', frozenMemberIds: [`m${n}a`, `m${n}b`], initialWakeMemberIds: [`m${n}a`, `m${n}b`] } as never,
    now: n,
  });
  if (!created.ok) throw new Error(created.error.message);
  const runId = `run_delib_${n}`;
  const turnId = `turn_delib_${n}`;
  db.prepare(`INSERT INTO workflow_runs (id,task_id,conversation_id,thread_id,mode,task_revision,status,stage)
    VALUES(?,?,?,?, 'DELIBERATE',0,'RUNNING','INDEPENDENT')`).run(runId, taskId, `c${n}`, `thread_delib_${n}`);
  const baseline = captureBaseline(db, { projectId, taskId, runId, appDataDir });
  if (!baseline.ok) throw new Error(baseline.error.message);
  db.prepare(`INSERT INTO agent_turns
    (id,run_id,conversation_id,thread_id,member_id,stage_key,turn_purpose,status,dispatch_key,attempt,epoch,collab_absence_ms,collab_turn_deadline_ms,collab_config_revision,stop_generation_snapshot)
    VALUES(?,?,?,?,?, 'delib.independent','stage_work','RUNNING',?,1,1,1200000,0,0,0)`).run(
    turnId, runId, `c${n}`, `thread_delib_${n}`, `m${n}a`, `task:${taskId}:delib:${runId}:IND:m${n}a:0:w`,
  );
  const sessionId = `session_delib_${n}`;
  db.prepare('UPDATE agent_turns SET session_id=? WHERE id=?').run(sessionId, turnId);
  db.prepare(`INSERT INTO runtime_sessions
    (id,project_id,conversation_id,scope_kind,thread_id,member_id,task_id,session_generation,cwd,provider_session_id,capabilities_json)
    VALUES(?,?,?,'task',?,?,?,0,?,?,?)`).run(
    sessionId, projectId, `c${n}`, `thread_delib_${n}`, `m${n}a`, taskId, projectRoot, `provider_${n}`,
    JSON.stringify({
      writeIdentity: 'fixture-write',
      writeAccessMode: { fullAccess: true, modificationAuthorized: true, root: projectRoot, identityKey: 'fixture-write' },
    }),
  );
  db.prepare(`INSERT INTO daemon_state (key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(`write-changeset:${turnId}`, baseline.value.changeSetId, Date.now());
  const content = `# 研讨观察稿 ${n}\n\n${'自造内容\n'.repeat(300)}`;
  writeFileSync(join(projectRoot, '研讨观察稿.md'), content, 'utf8');
  return { db, appDataDir, projectId, projectRoot, taskId, runId, turnId, memberId: `m${n}a`, content };
}

function recordWrite(worker: DispatchWorker, fixture: ReturnType<typeof setup>): void {
  const task = fixture.db.prepare('SELECT * FROM tasks WHERE id=?').get(fixture.taskId);
  worker.applyEvent(task as never, fixture.runId, fixture.turnId, {
    kind: 'tool.started', toolCallId: `write-${fixture.turnId}`, toolName: 'Write', action: 'edit',
    target: '研讨观察稿.md', argumentsSummary: '{"file_path":"研讨观察稿.md"}', paths: ['研讨观察稿.md'],
    eventKey: `start-${fixture.turnId}`, sessionId: `session-${fixture.turnId}`, turnId: fixture.turnId, receivedAt: Date.now(),
  });
  worker.applyEvent(task as never, fixture.runId, fixture.turnId, {
    kind: 'tool.completed', toolCallId: `write-${fixture.turnId}`, outcome: 'success',
    eventKey: `done-${fixture.turnId}`, sessionId: `session-${fixture.turnId}`, turnId: fixture.turnId, receivedAt: Date.now(),
  });
}

describe('R99 DELIB incomplete terminal evidence routing', () => {
  it('DELIB failure captures one non-final card and repeated apply is idempotent', () => {
    const f = setup(openDatabase(':memory:'), 1);
    try {
      const adapter = new FakeRuntimeAdapter();
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'w-delib-fail', appDataDir: f.appDataDir });
      recordWrite(worker, f);
      const task = f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.taskId);
      const failed = {
        kind: 'turn.failed' as const, code: 'PROVIDER_ERROR', message: '合成研讨失败', retryable: false,
        eventKey: 'failed', sessionId: `session-${f.turnId}`, turnId: f.turnId, receivedAt: Date.now(),
      };
      worker.applyEvent(task as never, f.runId, f.turnId, failed);
      worker.applyEvent(task as never, f.runId, f.turnId, { ...failed, eventKey: 'failed-duplicate' });
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(f.turnId)).toMatchObject({ status: 'FAILED' });
      expect(f.db.prepare("SELECT count(*) c FROM messages WHERE id=?",).get(`msg_observed_${f.turnId}`)).toMatchObject({ c: 1 });
      expect(f.db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id=?').get(`msg_observed_${f.turnId}`)).toMatchObject({ c: 1 });
      expect(f.db.prepare('SELECT count(*) c FROM artifacts').get()).toMatchObject({ c: 1 });
      expect(f.db.prepare("SELECT count(*) c FROM domain_events WHERE turn_id=? AND kind='turn.observedFileSnapshot'").get(f.turnId)).toMatchObject({ c: 1 });
    } finally { f.db.close(); }
  });

  it('DELIB user stop captures CANCELLED non-final evidence and does not mark success', () => {
    const f = setup(openDatabase(':memory:'), 2);
    try {
      f.db.prepare("UPDATE tasks SET stop_generation=1 WHERE id=?").run(f.taskId);
      f.db.prepare("UPDATE workflow_runs SET status='STOPPING' WHERE id=?").run(f.runId);
      f.db.prepare("UPDATE agent_turns SET status='STOPPING' WHERE id=?").run(f.turnId);
      const adapter = new FakeRuntimeAdapter();
      const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: 'w-delib-stop', appDataDir: f.appDataDir });
      recordWrite(worker, f);
      const task = f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.taskId);
      worker.applyEvent(task as never, f.runId, f.turnId, {
        kind: 'turn.failed', code: 'INTERRUPTED', message: '用户停止', retryable: false,
        eventKey: 'stop', sessionId: `session-${f.turnId}`, turnId: f.turnId, receivedAt: Date.now(),
      });
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(f.turnId)).toMatchObject({ status: 'CANCELLED' });
      const message = f.db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_observed_${f.turnId}`) as { body_json: string };
      expect((JSON.parse(message.body_json) as { text: string }).text).toContain('本轮执行已停止');
      expect(f.db.prepare('SELECT count(*) c FROM task_deliveries').get()).toMatchObject({ c: 0 });
    } finally { f.db.close(); }
  });
});
