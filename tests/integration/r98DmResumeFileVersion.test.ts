import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { LocalProtocolAdapter, type LocalProtocolOptions } from '../helpers/localProtocolAdapter.ts';
import type { SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const root = mkdtempSync(join(tmpdir(), 'zs-r98-dm-version-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function commandFor(db: ZhongshuoDatabase) {
  const deps = { db, localUserId: 'u_r98_version', interruptTurn: async () => {} };
  return async <T>(method: string, params: unknown): Promise<T> => {
    const result = await dispatchDaemonCommand(deps, {
      protocolVersion: 1,
      commandId: `r98-version-${randomUUID()}`,
      method,
      params,
    }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!result.ok) throw new Error(result.error?.message ?? method);
    return result.data as T;
  };
}

class WritingResumeAdapter extends LocalProtocolAdapter {
  private readonly contents: string[];
  constructor(private readonly file: string, contents: string[]) {
    super({ noSpawn: true, providerIdLate: true });
    this.contents = contents;
  }
  override async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    const next = this.contents.shift();
    if (next == null) throw new Error('missing synthetic file version');
    writeFileSync(this.file, next, 'utf8');
    await super.startTurn(session, input);
  }
}

class WritingContractAdapter extends LocalProtocolAdapter {
  constructor(private readonly file: string, options: LocalProtocolOptions) {
    super({ ...options, noSpawn: true });
  }
  override async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    writeFileSync(this.file, '自然语言写入的真实文件\n', 'utf8');
    await super.startTurn(session, input);
  }
}

class RepairProbeAdapter extends LocalProtocolAdapter {
  repairOnlySeen = false;
  override async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    this.repairOnlySeen = input.repairOnly === true;
    await super.startTurn(session, input);
  }
}

describe('R98 DM native resume file lineage', () => {
  it('keeps v1 bytes and registers the second task as v2 with the real change artifact', async () => {
    const db = openDatabase(':memory:');
    const projectPath = join(root, 'project');
    const filePath = join(projectPath, '值班安排说明.md');
    mkdirSync(projectPath, { recursive: true });
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
      VALUES ('p1','项目',?,?, '{}',0)`).run(projectPath, projectPath);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
      VALUES ('mA','p1','Claude','agent',1)`).run();
    const cmd = commandFor(db);
    await cmd('member.setRuntime', { projectId: 'p1', memberId: 'mA', kind: 'fake', permissionMode: 'bypassPermissions' });
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const adapter = new WritingResumeAdapter(filePath, ['# v1\n', '# v2\n']);
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r98-version', appDataDir: join(root, 'app') });

    const first = await cmd<{ taskId: string }>('message.submit', {
      target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId },
      body: '写值班安排', intent: 'default', mentions: [],
    });
    await worker.runOnce();
    const second = await cmd<{ taskId: string }>('message.submit', {
      target: { kind: 'dm', projectId: 'p1', conversationId: conv.conversationId },
      body: '周三改到西馆', intent: 'default', mentions: [],
    });
    await worker.runOnce();

    const session = db.prepare("SELECT id FROM runtime_sessions WHERE conversation_id=? AND scope_kind='dm'").get(conv.conversationId) as { id: string };
    expect(session).toBeTruthy();
    const secondTurn = db.prepare(`SELECT a.session_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
      WHERE r.task_id=? ORDER BY a.rowid DESC LIMIT 1`).get(second.taskId) as { session_id: string };
    expect(secondTurn.session_id).toBe(session.id);

    const changes = db.prepare(`SELECT f.state,a.revision,f.artifact_id,a.blob_path,a.hash
      FROM message_file_changes f LEFT JOIN artifacts a ON a.id=f.artifact_id
      WHERE f.task_id IN (?,?) ORDER BY f.created_at`).all(first.taskId, second.taskId) as Array<{
        state: string; revision: number | null; artifact_id: string | null; blob_path: string | null; hash: string | null;
      }>;
    expect(changes).toHaveLength(2);
    expect(changes[0]?.state).toBe('added');
    expect(changes[1]?.state).toBe('modified');
    expect(changes[1]?.revision).toBe(2);
    expect(changes[1]?.artifact_id).toBeTruthy();
    expect(changes[1]?.hash).toBeTruthy();
    expect(readFileSync(changes[0]!.blob_path!, 'utf8')).toBe('# v1\n');
    expect(readFileSync(changes[1]!.blob_path!, 'utf8')).toBe('# v2\n');

    const snapshotEvents = db.prepare(`SELECT payload_json FROM domain_events WHERE task_id=? AND kind='turn.generatedFileSnapshot' ORDER BY seq DESC LIMIT 1`)
      .get(second.taskId) as { payload_json: string };
    expect(snapshotEvents.payload_json).not.toContain('PERMISSION_UNAVAILABLE');
    expect(snapshotEvents.payload_json).toContain('registered');
    db.close();
  });

  it('completes a no-write DM natural answer and preserves a failed natural answer with real file evidence', async () => {
    const naturalDb = openDatabase(':memory:');
    const naturalProject = join(root, 'natural-project');
    mkdirSync(naturalProject, { recursive: true });
    naturalDb.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
      VALUES ('p2','自然项目',?,?, '{}',0)`).run(naturalProject, naturalProject);
    naturalDb.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
      VALUES ('mA2','p2','Claude','agent',1)`).run();
    const naturalCmd = commandFor(naturalDb);
    await naturalCmd('member.setRuntime', { projectId: 'p2', memberId: 'mA2', kind: 'fake', permissionMode: 'bypassPermissions' });
    const naturalConversation = await naturalCmd<{ conversationId: string }>('conversation.create', { projectId: 'p2', peerMemberId: 'mA2' });
    const naturalAdapter = new LocalProtocolAdapter({
      noSpawn: true,
      messageText: () => '你好，我可以直接回答。',
      finalText: () => '你好，我可以直接回答。',
    });
    const naturalWorker = new DispatchWorker({ db: naturalDb, adapter: naturalAdapter, leaseOwner: 'r98-natural', appDataDir: join(root, 'natural-app') });
    const naturalTask = await naturalCmd<{ taskId: string }>('message.submit', {
      target: { kind: 'dm', projectId: 'p2', conversationId: naturalConversation.conversationId },
      body: '你好', intent: 'default', mentions: [],
    });
    await naturalWorker.runOnce();
    expect((naturalDb.prepare('SELECT status FROM tasks WHERE id=?').get(naturalTask.taskId) as { status: string }).status).toBe('DONE');
    const naturalMessage = naturalDb.prepare("SELECT body_json FROM messages WHERE task_id=? AND author_type='agent'").get(naturalTask.taskId) as { body_json: string };
    expect(JSON.parse(naturalMessage.body_json).text).toBe('你好，我可以直接回答。');

    const failedDb = openDatabase(':memory:');
    const failedProject = join(root, 'failed-natural-project');
    mkdirSync(failedProject, { recursive: true });
    failedDb.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
      VALUES ('p3','失败自然项目',?,?, '{}',0)`).run(failedProject, failedProject);
    failedDb.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
      VALUES ('mA3','p3','Claude','agent',1)`).run();
    const failedCmd = commandFor(failedDb);
    await failedCmd('member.setRuntime', { projectId: 'p3', memberId: 'mA3', kind: 'fake', permissionMode: 'bypassPermissions' });
    const failedConversation = await failedCmd<{ conversationId: string }>('conversation.create', { projectId: 'p3', peerMemberId: 'mA3' });
    const failedFile = join(failedProject, '自然语言产出.md');
    const failedAdapter = new WritingContractAdapter(failedFile, {
      messageText: () => '我已经写好了自然语言产出.md',
      finalText: () => '我已经写好了自然语言产出.md',
    });
    const failedWorker = new DispatchWorker({ db: failedDb, adapter: failedAdapter, leaseOwner: 'r98-failed-natural', appDataDir: join(root, 'failed-natural-app') });
    const failedTask = await failedCmd<{ taskId: string }>('message.submit', {
      target: { kind: 'dm', projectId: 'p3', conversationId: failedConversation.conversationId },
      body: '写一份自然语言产出', intent: 'default', mentions: [],
    });
    await failedWorker.runOnce();
    const taskRow = failedDb.prepare('SELECT status FROM tasks WHERE id=?').get(failedTask.taskId) as { status: string };
    const runRow = failedDb.prepare('SELECT status FROM workflow_runs WHERE task_id=?').get(failedTask.taskId) as { status: string };
    const turnRow = failedDb.prepare('SELECT status FROM agent_turns WHERE run_id=(SELECT id FROM workflow_runs WHERE task_id=?)').get(failedTask.taskId) as { status: string };
    const changes = failedDb.prepare('SELECT f.state,f.artifact_id,f.after_sha256,t.status AS execution_status FROM message_file_changes f JOIN agent_turns t ON t.id=f.turn_id WHERE f.task_id=?').all(failedTask.taskId) as Array<{ state: string; artifact_id: string | null; after_sha256: string | null; execution_status: string }>;
    expect(taskRow.status).toBe('ACTIVE');
    expect(runRow.status).toBe('FAILED');
    expect(turnRow.status).toBe('FAILED');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.state).toBe('added');
    expect(changes[0]?.artifact_id).toBeTruthy();
    expect(changes[0]?.after_sha256).toBeTruthy();
    expect(changes[0]?.execution_status).toBe('FAILED');
    expect((failedDb.prepare('SELECT count(*) c FROM task_deliveries WHERE task_id=?').get(failedTask.taskId) as { c: number }).c).toBe(0);
    expect((failedDb.prepare("SELECT count(*) c FROM domain_events WHERE task_id=? AND kind='turn.outputInvalid'").get(failedTask.taskId) as { c: number }).c).toBe(1);
    naturalDb.close();
    failedDb.close();
  });

  it('makes a read-only DM format repair bind the source changeset without writing again', async () => {
    const db = openDatabase(':memory:');
    const projectPath = join(root, 'repair-project');
    mkdirSync(projectPath, { recursive: true });
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
      VALUES ('p4','修复项目',?,?, '{}',0)`).run(projectPath, projectPath);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
      VALUES ('mA4','p4','Claude','agent',1)`).run();
    const cmd = commandFor(db);
    await cmd('member.setRuntime', { projectId: 'p4', memberId: 'mA4', kind: 'fake', permissionMode: 'bypassPermissions' });
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p4', peerMemberId: 'mA4' });
    const file = join(projectPath, '源文件.md');
    const failedAdapter = new WritingContractAdapter(file, {
      messageText: () => '文件已写好',
      finalText: () => '文件已写好',
    });
    const failedWorker = new DispatchWorker({ db, adapter: failedAdapter, leaseOwner: 'r98-repair-source', appDataDir: join(root, 'repair-app') });
    const submitted = await cmd<{ taskId: string }>('message.submit', {
      target: { kind: 'dm', projectId: 'p4', conversationId: conv.conversationId },
      body: '写源文件', intent: 'default', mentions: [],
    });
    await failedWorker.runOnce();
    const task = db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(submitted.taskId) as { status: string; revision: number; stop_generation: number };
    const sourceRun = db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(submitted.taskId) as { id: string };
    expect(task.status).toBe('ACTIVE');
    const sourceSet = db.prepare("SELECT payload_json FROM domain_events WHERE run_id=? AND kind='changeset.baselineCaptured' ORDER BY seq DESC LIMIT 1").get(sourceRun.id) as { payload_json: string };
    const sourceChangeSetId = (JSON.parse(sourceSet.payload_json) as { changeSetId: string }).changeSetId;
    await expect(cmd('task.redispatch', {
      taskId: submitted.taskId, formatRepair: true, sourceRunId: 'run_foreign', reason: 'foreign source must fail',
    })).rejects.toThrow(/不属于|最新/);
    const rep = await cmd<{ enqueued: boolean }>('task.redispatch', {
      taskId: submitted.taskId, sourceRunId: sourceRun.id, expectedTaskRevision: task.revision,
      expectedStopGeneration: task.stop_generation, expectedRunStatus: 'FAILED', formatRepair: true,
      reason: 'test repair',
    });
    expect(rep.enqueued).toBe(true);
    const probe = new RepairProbeAdapter({ noSpawn: true });
    const repairWorker = new DispatchWorker({ db, adapter: probe, leaseOwner: 'r98-repair-run', appDataDir: join(root, 'repair-app') });
    await repairWorker.runOnce();
    expect(probe.repairOnlySeen).toBe(true);
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(submitted.taskId) as { status: string }).status).toBe('DONE');
    const delivery = db.prepare('SELECT change_set_refs_json FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(submitted.taskId) as { change_set_refs_json: string };
    expect(JSON.parse(delivery.change_set_refs_json)).toContain(sourceChangeSetId);
    const repairChanges = db.prepare('SELECT f.artifact_id,f.after_sha256 FROM message_file_changes f JOIN agent_turns t ON t.id=f.turn_id WHERE f.task_id=? AND t.turn_purpose=?').all(submitted.taskId, 'format_repair') as Array<{ artifact_id: string | null; after_sha256: string | null }>;
    expect(repairChanges).toHaveLength(1);
    expect(repairChanges[0]?.artifact_id).toBeTruthy();
    expect(repairChanges[0]?.after_sha256).toBeTruthy();
    db.close();
  });

  it('rejects a natural-language format-repair turn instead of treating it as an ordinary DM answer', async () => {
    const db = openDatabase(':memory:');
    const projectPath = join(root, 'repair-natural-project');
    mkdirSync(projectPath, { recursive: true });
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
      VALUES ('p5','自然修复项目',?,?, '{}',0)`).run(projectPath, projectPath);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
      VALUES ('mA5','p5','Claude','agent',1)`).run();
    const cmd = commandFor(db);
    await cmd('member.setRuntime', { projectId: 'p5', memberId: 'mA5', kind: 'fake', permissionMode: 'bypassPermissions' });
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p5', peerMemberId: 'mA5' });
    const file = join(projectPath, '修复源文件.md');
    const failedAdapter = new WritingContractAdapter(file, {
      messageText: () => '文件已写好',
      finalText: () => '文件已写好',
    });
    const failedWorker = new DispatchWorker({ db, adapter: failedAdapter, leaseOwner: 'r98-natural-repair-source', appDataDir: join(root, 'repair-natural-app') });
    const submitted = await cmd<{ taskId: string }>('message.submit', {
      target: { kind: 'dm', projectId: 'p5', conversationId: conv.conversationId },
      body: '写修复源文件', intent: 'default', mentions: [],
    });
    await failedWorker.runOnce();
    const sourceTask = db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(submitted.taskId) as { status: string; revision: number; stop_generation: number };
    const sourceRun = db.prepare('SELECT id,status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(submitted.taskId) as { id: string; status: string };
    const sourceTurn = db.prepare('SELECT id,status,turn_purpose FROM agent_turns WHERE run_id=?').get(sourceRun.id) as { id: string; status: string; turn_purpose: string };
    const originalBytes = readFileSync(file, 'utf8');
    expect(sourceTask.status).toBe('ACTIVE');
    expect(sourceRun.status).toBe('FAILED');
    expect(sourceTurn).toMatchObject({ status: 'FAILED', turn_purpose: 'stage_work' });
    expect((db.prepare('SELECT count(*) c FROM task_deliveries WHERE task_id=?').get(submitted.taskId) as { c: number }).c).toBe(0);

    await cmd('task.redispatch', {
      taskId: submitted.taskId, sourceRunId: sourceRun.id, expectedTaskRevision: sourceTask.revision,
      expectedStopGeneration: sourceTask.stop_generation, expectedRunStatus: 'FAILED', formatRepair: true,
      reason: 'test natural repair rejection',
    });
    const repairProbe = new RepairProbeAdapter({
      noSpawn: true,
      messageText: () => '仍然不是 JSON',
      finalText: () => '仍然不是 JSON',
    });
    const repairWorker = new DispatchWorker({ db, adapter: repairProbe, leaseOwner: 'r98-natural-repair', appDataDir: join(root, 'repair-natural-app') });
    await repairWorker.runOnce();

    const repairRun = db.prepare('SELECT id,status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(submitted.taskId) as { id: string; status: string };
    const repairTurn = db.prepare('SELECT status,turn_purpose FROM agent_turns WHERE run_id=?').get(repairRun.id) as { status: string; turn_purpose: string };
    expect(repairProbe.repairOnlySeen).toBe(true);
    expect(repairRun.status).toBe('FAILED');
    expect(repairTurn).toEqual({ status: 'FAILED', turn_purpose: 'format_repair' });
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(submitted.taskId) as { status: string }).status).toBe('BLOCKED');
    expect((db.prepare('SELECT count(*) c FROM domain_events WHERE run_id=? AND kind=\'turn.outputInvalid\'').get(repairRun.id) as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT count(*) c FROM task_deliveries WHERE task_id=?').get(submitted.taskId) as { c: number }).c).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(originalBytes);
    expect((db.prepare('SELECT count(*) c FROM domain_events WHERE run_id=? AND kind=\'turn.outputNaturalConversation\'').get(repairRun.id) as { c: number }).c).toBe(0);
    db.close();
  });
});
