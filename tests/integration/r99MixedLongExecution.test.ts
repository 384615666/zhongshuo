import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r99-mixed-long-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const done = (payload: unknown): FakeTurnScript => [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(payload) } }];

function deliberationSequencer(): (input: { text: string }) => FakeTurnScript {
  return ({ text }) => {
    if (text.includes('"schemaVersion":"analysis-draft-v1"')) {
      return done({
        schemaVersion: 'analysis-draft-v1',
        summary: '独立分析稿',
        document: null,
        claims: [{ claimId: 'c1', statement: '同目录串行结论', kind: 'observed', evidenceIds: ['ev1'] }],
        recommendations: [],
        openQuestions: [],
      });
    }
    if (text.includes('"schemaVersion":"cross-review-v1"')) {
      const peer = /"artifactId"\s*:\s*"([^"]+)"[\s\S]*?"revision"\s*:\s*(\d+)[\s\S]*?"claimId"\s*:\s*"([^"]+)"/.exec(text);
      if (peer == null) throw new Error('cross-review frozen peer missing');
      return done({
        schemaVersion: 'cross-review-v1',
        summary: '互评完成',
        document: null,
        reviews: [{
          targetArtifactId: peer[1], targetRevision: Number(peer[2]), targetClaimId: peer[3],
          stance: 'agree', reason: '同目录单写与长轮收口符合预期', evidenceIds: [],
        }],
      });
    }
    throw new Error(`unexpected deliberate stage: ${text.slice(0, 120)}`);
  };
}

describe('R99 formal mixed 2 DELIBERATE + 1 AUTO long execution', () => {
  it('crosses the old 300s boundary, persists AUTO completion, and then dispatches CROSS_REVIEW', async () => {
    const dir = join(root, 'fixture');
    const projectRoot = join(dir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const db = openDatabase(join(dir, 'state.sqlite'));
    let codex: FakeRuntimeAdapter | null = null;
    let claude: FakeRuntimeAdapter | null = null;
    let auto: FakeRuntimeAdapter | null = null;
    try {
      codex = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: deliberationSequencer() });
      claude = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: deliberationSequencer() });
      auto = new FakeRuntimeAdapter({ turnScripts: [[
        { kind: 'stall', ms: 301_000 },
        { kind: 'event', event: { kind: 'turn.completed', finalText: 'AUTO 长调用完成；没有创建工作细分派' } },
      ]] });
      const adapters = { codex, claude, auto };
      const adapterByMember = new Map<string, FakeRuntimeAdapter>();
      const worker = new DispatchWorker({
        db, adapter: codex, adapterFor: (memberId) => adapterByMember.get(memberId) ?? adapters.auto,
        leaseOwner: 'r99-mixed', enableDeliberate: true, turnDeadlineMs: null,
        appDataDir: dir, detachedTurnConsumption: true,
      });

      const deps = { db, localUserId: 'u_local', appDataDir: dir, interruptTurn: (turnId: string) => worker.interruptTurn(turnId) };
      const cmd = async <T>(method: string, params: unknown): Promise<T> => {
        const result = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r99-mixed-${randomUUID()}`, method, params }) as {
          ok: boolean; data?: T; error?: { message?: string };
        };
        if (!result.ok) throw new Error(`${method}: ${result.error?.message ?? 'unknown'}`);
        return result.data as T;
      };
      const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projectRoot })).project.id;
      const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId })).items[0]!;
      const codexMember = (await cmd<{ memberId: string }>('member.create', { projectId, displayName: 'Codex 长轮' })).memberId;
      const claudeMember = (await cmd<{ memberId: string }>('member.create', { projectId, displayName: 'Claude 互评' })).memberId;
      const autoMember = (await cmd<{ memberId: string }>('member.create', { projectId, displayName: 'AUTO 协调' })).memberId;
      adapterByMember.set(codexMember, adapters.codex);
      adapterByMember.set(claudeMember, adapters.claude);
      adapterByMember.set(autoMember, adapters.auto);
      await cmd('member.setRuntime', { memberId: codexMember, kind: 'codex', model: 'gpt-6.1-sol', permissionMode: 'bypassPermissions' });
      await cmd('member.setRuntime', { memberId: claudeMember, kind: 'claude', model: 'claude-sonnet-4-5', permissionMode: 'bypassPermissions' });
      await cmd('member.setRuntime', { memberId: autoMember, kind: 'codex', model: 'gpt-6-sol', permissionMode: 'bypassPermissions' });
      const roomRevision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as { revision: number }).revision;
      await cmd('room.update', { roomId: room.id, expectedRevision: roomRevision, coordinatorMemberId: autoMember });
      const target = { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId };
      const deliberate = async (body: string) => cmd<{ taskId: string }>('message.submit', {
        target, body, intent: 'default', collaboration: 'deliberate',
        mentions: [{ kind: 'member', memberId: codexMember }, { kind: 'member', memberId: claudeMember }],
      });
      const first = await deliberate('第一次同目录研讨');
      const second = await deliberate('第二次同目录研讨');
      const autoTask = await cmd<{ taskId: string }>('message.submit', {
        target, body: '同目录自动协作长执行', intent: 'default', mentions: [],
      });
      expect(db.prepare('SELECT count(*) c FROM tasks WHERE project_id=?').get(projectId)).toMatchObject({ c: 3 });
      expect(new Set((db.prepare('SELECT canonical_path FROM projects WHERE id=?').all(projectId) as Array<{ canonical_path: string }>).map((row) => row.canonical_path))).toEqual(new Set([projectRoot]));

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
      await worker.runOnce(); // DELIB 1 PREPARE
      await worker.runOnce(); // DELIB 2 PREPARE
      const longRun = worker.runOnce(); // AUTO initial -> long planning call
      await longRun; // detached consumption: returns while the model call stays in flight
      const autoTurn = db.prepare(`SELECT a.id turn_id,a.run_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
        WHERE r.task_id=? ORDER BY a.rowid DESC LIMIT 1`).get(autoTask.taskId) as { turn_id: string; run_id: string };
      expect(db.prepare("SELECT count(*) c FROM workspace_leases WHERE owner_turn_id=? AND status='active'").get(autoTurn.turn_id)).toMatchObject({ c: 1 });
      const startsBeforeBlockedAttempt = codex.startTurnLog.length;
      await worker.runOnce(); // pending IND must defer on the same-root write admission
      expect(codex.startTurnLog.length).toBe(startsBeforeBlockedAttempt);
      expect(db.prepare("SELECT count(*) c FROM outbox WHERE status='pending' AND dispatch_key LIKE '%:IND:%'").get()).toMatchObject({ c: 4 });
      await vi.advanceTimersByTimeAsync(301_200);
      await worker.awaitInFlightTurns(2_000);
      expect(db.prepare('SELECT status FROM workflow_runs WHERE task_id=?').get(autoTask.taskId)).toMatchObject({ status: 'SUCCEEDED' });
      expect(db.prepare("SELECT count(*) c FROM workspace_leases WHERE owner_turn_id=? AND status!='released'").get(autoTurn.turn_id)).toMatchObject({ c: 0 });
      expect(db.prepare("SELECT count(*) c FROM domain_events WHERE task_id=? AND kind='turn.statusChanged' AND json_extract(payload_json,'$.status')='UNKNOWN'").get(autoTask.taskId)).toMatchObject({ c: 0 });

      const runDetached = async (): Promise<void> => {
        await worker.runOnce();
        await worker.awaitInFlightTurns(2_000);
      };
      for (let i = 0; i < 4; i += 1) await runDetached(); // four IND turns
      const queuedCrossReview = db.prepare(`SELECT dispatch_key FROM outbox
        WHERE status='pending' AND dispatch_key LIKE '%:CR:%' ORDER BY id LIMIT 1`).get() as { dispatch_key: string } | undefined;
      expect(queuedCrossReview).toBeDefined();
      await runDetached(); // first CROSS_REVIEW after the long AUTO completed
      const crossReview = db.prepare(`SELECT stage_key,status FROM agent_turns
        WHERE run_id IN (?,?) AND stage_key='delib.cross_review' ORDER BY rowid DESC LIMIT 1`).get(
        (db.prepare("SELECT id FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE'").get(first.taskId) as { id: string }).id,
        (db.prepare("SELECT id FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE'").get(second.taskId) as { id: string }).id,
      );
      expect(crossReview).toMatchObject({ stage_key: 'delib.cross_review', status: 'SUCCEEDED' });
      expect(db.prepare("SELECT count(*) c FROM domain_events WHERE task_id IN (?,?) AND kind='turn.statusChanged' AND json_extract(payload_json,'$.status')='UNKNOWN'").get(first.taskId, second.taskId)).toMatchObject({ c: 0 });
    } finally {
      vi.useRealTimers();
      await codex?.closeAllSessions();
      await claude?.closeAllSessions();
      await auto?.closeAllSessions();
      db.close();
    }
  }, 30_000);
});
