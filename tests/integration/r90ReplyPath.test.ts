/**
 * R90 P0: an ordinary DM must reach the runtime even when the project contains
 * files larger than the content-level preimage cap. Those files still get a
 * path+hash baseline and remain explicitly non-restorable in the changeset;
 * they must not turn the whole conversation into a pre-CLI startup failure.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createHash} from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { failingTurn, successTurn } from '../../src/adapter/fake/script.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';

process.env.ZS_ALLOW_FAKE = '1';
process.env.ZS_RUNTIME = 'fake';

const root = mkdtempSync(join(tmpdir(), 'zs-r90-reply-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('R90 ordinary reply dispatch', () => {
  it('DM reaches the runtime when only content-level preimages are unavailable', async () => {
    const projectRoot = join(root, 'project');
    const appDataDir = join(root, 'appdata');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'large-synthetic.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    writeFileSync(join(projectRoot, 'small-synthetic.txt'), 'synthetic fixture');

    const db = openDatabase(join(root, 'state.sqlite'));
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => successTurn('R90_DM_REPLY_OK', 'msg_r90_dm') });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r90-reply', appDataDir });
    const deps = { db, localUserId: 'u_r90', appDataDir, interruptTurn: (id: string) => worker.interruptTurn(id) };
    const cmd = async <T>(method: string, params: unknown): Promise<T> => {
      const result = await dispatchDaemonCommand(deps, {
        protocolVersion: 1,
        commandId: `r90-${randomUUID()}`,
        method,
        params,
      }) as { ok: boolean; data: T; error?: { message: string } };
      if (!result.ok) throw new Error(result.error?.message ?? 'command failed');
      return result.data;
    };

    try {
      const project = await cmd<{ project: { id: string } }>('project.open', { path: projectRoot });
      const member = await cmd<{ memberId: string }>('member.create', { projectId: project.project.id, displayName: 'Synthetic Agent' });
      await cmd('member.setRuntime', { memberId: member.memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
      const conversation = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: project.project.id,
        peerMemberId: member.memberId,
      });
      const submitted = await cmd<{ taskId: string; messageId: string; disposition: string }>('message.submit', {
        target: { kind: 'dm', projectId: project.project.id, conversationId: conversation.conversationId },
        body: 'Synthetic ordinary DM',
        intent: 'default',
        mentions: [],
      });

      expect(submitted.disposition).toBe('dispatched');
      await worker.runOnce();

      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(submitted.taskId)).toEqual({ status: 'DONE' });
      expect(db.prepare('SELECT status FROM agent_turns WHERE dispatch_key=?').get(
        `dmtask:${submitted.taskId}:initial`,
      )).toEqual({ status: 'SUCCEEDED' });
      const reply = db.prepare(`SELECT body_json FROM messages
        WHERE conversation_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1`)
        .get(conversation.conversationId) as { body_json: string };
      expect(JSON.parse(reply.body_json)).toMatchObject({ text: 'R90_DM_REPLY_OK' });

      const changeset = db.prepare(`SELECT s.id,
          SUM(CASE WHEN f.content_unavailable IS NOT NULL THEN 1 ELSE 0 END) unavailable
        FROM change_sets s JOIN change_set_files f
          ON f.change_set_id=s.id AND f.role='before'
        WHERE s.task_id=? GROUP BY s.id`).get(submitted.taskId) as { id: string; unavailable: number };
      expect(changeset.unavailable).toBe(0);
      expect(db.prepare(`SELECT content_ref FROM change_set_files
        WHERE change_set_id=? AND role='before' AND path='large-synthetic.txt'`).get(changeset.id))
        .toEqual({ content_ref: createHash('sha256').update(readFileSync(join(projectRoot,'large-synthetic.txt'))).digest('hex') });
      expect(db.prepare(`SELECT count(*) n FROM domain_events
        WHERE task_id=? AND kind='turn.startupFailed'`).get(submitted.taskId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 30_000);

  it('an old confirmed startup failure does not block a later new DM message', async () => {
    const projectRoot = join(root, 'project-old-failure');
    const appDataDir = join(root, 'appdata-old-failure');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'synthetic.txt'), 'synthetic fixture');

    const db = openDatabase(join(root, 'old-failure.sqlite'));
    const scripts = [
      failingTurn('PROVIDER_ERROR', 'synthetic old failure', false),
      successTurn('R90_NEW_MESSAGE_REPLIED', 'msg_r90_new'),
    ];
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? successTurn() });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r90-old-failure', appDataDir });
    const deps = { db, localUserId: 'u_r90', appDataDir, interruptTurn: (id: string) => worker.interruptTurn(id) };
    const cmd = async <T>(method: string, params: unknown): Promise<T> => {
      const result = await dispatchDaemonCommand(deps, {
        protocolVersion: 1,
        commandId: `r90-old-${randomUUID()}`,
        method,
        params,
      }) as { ok: boolean; data: T; error?: { message: string } };
      if (!result.ok) throw new Error(result.error?.message ?? 'command failed');
      return result.data;
    };

    try {
      const project = await cmd<{ project: { id: string } }>('project.open', { path: projectRoot });
      const member = await cmd<{ memberId: string }>('member.create', { projectId: project.project.id, displayName: 'Synthetic Agent' });
      await cmd('member.setRuntime', { memberId: member.memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
      const conversation = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: project.project.id,
        peerMemberId: member.memberId,
      });
      const target = { kind: 'dm' as const, projectId: project.project.id, conversationId: conversation.conversationId };

      const first = await cmd<{ taskId: string }>('message.submit', {
        target, body: 'synthetic failing request', intent: 'default', mentions: [],
      });
      await worker.runOnce();
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(first.taskId)).toEqual({ status: 'ACTIVE' });
      expect(db.prepare(`SELECT r.status FROM workflow_runs r WHERE r.task_id=? ORDER BY r.rowid DESC LIMIT 1`)
        .get(first.taskId)).toEqual({ status: 'FAILED' });
      const failedConversation = await cmd<{
        conversations: Array<{
          conversationId: string;
          interruptedTasks: Array<{
            taskId: string;
            recoverable: boolean;
            lastFailureReason: string | null;
          }>;
        }>;
      }>('conversation.list', { projectId: project.project.id });
      const failedFacts = failedConversation.conversations
        .find((item) => item.conversationId === conversation.conversationId)!
        .interruptedTasks.find((item) => item.taskId === first.taskId)!;
      expect(failedFacts.recoverable).toBe(true);
      expect(failedFacts.lastFailureReason).toContain('synthetic old failure');

      const second = await cmd<{ taskId: string; disposition: string }>('message.submit', {
        target, body: 'synthetic fresh request', intent: 'default', mentions: [],
      });
      expect(second.disposition).toBe('dispatched');
      expect(second.taskId).not.toBe(first.taskId);
      await worker.runOnce();
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(second.taskId)).toEqual({ status: 'DONE' });
      const reply = db.prepare(`SELECT body_json FROM messages
        WHERE conversation_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1`)
        .get(conversation.conversationId) as { body_json: string };
      expect(JSON.parse(reply.body_json)).toMatchObject({ text: 'R90_NEW_MESSAGE_REPLIED' });
      expect(db.prepare(`SELECT status FROM tasks WHERE id=?`).get(first.taskId)).toEqual({ status: 'ACTIVE' });
    } finally {
      db.close();
    }
  }, 30_000);

  it('room write keeps the explicit full-access policy beside an unrelated oversized file', async () => {
    const projectRoot = join(root, 'project-room');
    const appDataDir = join(root, 'appdata-room');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'large-synthetic.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x62));
    writeFileSync(join(projectRoot, 'small-target.txt'), 'unchanged-r90');

    const db = openDatabase(join(root, 'room.sqlite'));
    const workTurn: FakeTurnScript = [
      { kind: 'writeFile', path: 'small-target.txt', content: 'modified-r90' },
      ...successTurn('R90_ROOM_WRITE_OK', 'msg_r90_room'),
    ];
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => workTurn });
    let openedWriteAccess: { fullAccess?: boolean; modificationAuthorized: boolean; policyId?: string } | undefined;
    const originalOpenSession = adapter.openSession.bind(adapter);
    vi.spyOn(adapter, 'openSession').mockImplementation(async (input) => {
      openedWriteAccess = input.writeAccess;
      return originalOpenSession(input);
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r90-room', appDataDir });
    const deps = { db, localUserId: 'u_r90_room', appDataDir, interruptTurn: (id: string) => worker.interruptTurn(id) };
    const cmd = async <T>(method: string, params: unknown): Promise<T> => {
      const result = await dispatchDaemonCommand(deps, {
        protocolVersion: 1,
        commandId: `r90-room-${randomUUID()}`,
        method,
        params,
      }) as { ok: boolean; data: T; error?: { message: string } };
      if (!result.ok) throw new Error(result.error?.message ?? 'command failed');
      return result.data;
    };

    try {
      const project = await cmd<{ project: { id: string } }>('project.open', { path: projectRoot });
      const member = await cmd<{ memberId: string }>('member.create', { projectId: project.project.id, displayName: 'Synthetic Room Agent' });
      await cmd('member.setRuntime', { memberId: member.memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
      const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', {
        projectId: project.project.id,
      })).items[0]!;
      const submitted = await cmd<{ taskId: string; disposition: string }>('message.submit', {
        target: { kind: 'room_root', projectId: project.project.id, roomId: room.id, conversationId: room.conversationId },
        body: '@Synthetic Room Agent synthetic room write',
        intent: 'default',
        mentions: [{ kind: 'member', memberId: member.memberId }],
      });

      expect(submitted.disposition).toBe('queued');
      await worker.runOnce();
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(submitted.taskId)).toEqual({ status: 'DONE' });
      expect(openedWriteAccess).toMatchObject({ fullAccess: true, modificationAuthorized: true, policyId: 'policy-full-access' });
      expect(readFileSync(join(projectRoot, 'small-target.txt'), 'utf8')).toBe('modified-r90');
      const changeset = db.prepare(`SELECT s.id FROM change_sets s
        JOIN change_set_files f ON f.change_set_id=s.id AND f.role='before'
        WHERE s.task_id=? AND f.path='large-synthetic.bin' AND f.content_unavailable IS NULL AND f.content_ref IS NOT NULL`)
        .get(submitted.taskId) as { id: string };
      expect(changeset.id).toBeTruthy();
      const unavailableEvent = db.prepare(`SELECT payload_json FROM domain_events
        WHERE task_id=? AND kind='run.baselineContentUnavailable' ORDER BY seq DESC LIMIT 1`)
        .get(submitted.taskId) as { payload_json: string } | undefined;
      expect(unavailableEvent).toBeUndefined();
      expect(db.prepare(`SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='run.baselineReadonly'`)
        .get(submitted.taskId)).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) n FROM workspace_leases WHERE status='active' AND owner_turn_id IN (SELECT id FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id=?))")
        .get(submitted.taskId)).toEqual({ n: 0 });
      const diff = db.prepare(`SELECT json_extract(payload_json,'$.modified') modified FROM domain_events
        WHERE task_id=? AND kind='changeset.finalized' ORDER BY seq DESC LIMIT 1`).get(submitted.taskId) as { modified: string };
      expect(JSON.parse(diff.modified)).toContain('small-target.txt');
    } finally {
      db.close();
    }
  }, 30_000);

  it('a rejected path makes a write-capable dispatch fail closed before the model starts', async () => {
    const projectRoot = join(root, 'project-rejected-path');
    const appDataDir = join(root, 'appdata-rejected-path');
    const outside = join(root, 'outside-rejected-path');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(projectRoot, 'synthetic.txt'), 'synthetic fixture');
    try {
      symlinkSync(outside, join(projectRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // Directory-link creation is unavailable in this environment.
    }

    const db = openDatabase(join(root, 'rejected-path.sqlite'));
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => successTurn('MUST_NOT_RUN') });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r90-rejected-path', appDataDir });
    const deps = { db, localUserId: 'u_r90_rejected', appDataDir, interruptTurn: (id: string) => worker.interruptTurn(id) };
    const cmd = async <T>(method: string, params: unknown): Promise<T> => {
      const result = await dispatchDaemonCommand(deps, {
        protocolVersion: 1,
        commandId: `r90-rejected-${randomUUID()}`,
        method,
        params,
      }) as { ok: boolean; data: T; error?: { message: string } };
      if (!result.ok) throw new Error(result.error?.message ?? 'command failed');
      return result.data;
    };

    try {
      const project = await cmd<{ project: { id: string } }>('project.open', { path: projectRoot });
      const member = await cmd<{ memberId: string }>('member.create', { projectId: project.project.id, displayName: 'Synthetic Agent' });
      await cmd('member.setRuntime', { memberId: member.memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
      const conversation = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: project.project.id,
        peerMemberId: member.memberId,
      });
      const submitted = await cmd<{ taskId: string }>('message.submit', {
        target: { kind: 'dm', projectId: project.project.id, conversationId: conversation.conversationId },
        body: 'synthetic rejected path request',
        intent: 'default',
        mentions: [],
      });
      await worker.runOnce();
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(submitted.taskId)).toEqual({ status: 'BLOCKED' });
      expect(db.prepare("SELECT count(*) n FROM workflow_runs WHERE task_id=? AND status='FAILED'").get(submitted.taskId)).toEqual({ n: 1 });
      expect(db.prepare('SELECT count(*) n FROM agent_turns WHERE dispatch_key=?')
        .get(`dmtask:${submitted.taskId}:initial`)).toEqual({ n: 1 });
      const failure = db.prepare(`SELECT payload_json FROM domain_events
        WHERE task_id=? AND kind='task.contextAssemblyFailed' ORDER BY seq DESC LIMIT 1`)
        .get(submitted.taskId) as { payload_json: string } | undefined;
      expect(failure).toBeTruthy();
      expect(JSON.parse(failure!.payload_json)).toMatchObject({ reason: 'write-baseline-incomplete' });
    } finally {
      db.close();
    }
  }, 30_000);
});
