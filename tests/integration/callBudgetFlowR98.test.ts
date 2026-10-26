import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {simulateDeliberationTurn} from '../../src/adapter/fake/deliberationSim.ts';
import {seedExplicitRecipientCoordination} from '../../src/daemon/coordination.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs();});
async function fixture(deliberate = false) {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake');
  const root = mkdtempSync(join(tmpdir(), 'zs-r98-budget-flow-'));
  cleanups.push(() => rmSync(root, {recursive: true, force: true}));
  const project = join(root, 'project'); mkdirSync(project);
  const db = openDatabase(join(root, 'state.sqlite'));
  cleanups.push(() => {db.close();});
  const adapter = new FakeRuntimeAdapter(deliberate ? {structuredFinal: false, turnScriptSequencer: input => simulateDeliberationTurn(input.text)} : {});
  cleanups.push(() => adapter.closeAllSessions());
  const worker = new DispatchWorker({db, adapter, leaseOwner: 'r98-budget-flow', appDataDir: root, enableDeliberate: deliberate, detachedTurnConsumption: false});
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const result = await dispatchDaemonCommand({db, appDataDir: root, localUserId: 'u_test', interruptTurn: id => worker.interruptTurn(id)}, {protocolVersion: 1, commandId: randomUUID(), method, params}) as {ok: boolean; data: T; error?: unknown};
    expect(result.ok, JSON.stringify(result.error)).toBe(true); return result.data;
  };
  const projectId = (await cmd<{project: {id: string}}>('project.open', {path: project})).project.id;
  const room = (await cmd<{items: Array<{id: string; conversationId: string}>}>('room.list', {projectId})).items[0]!;
  const members: string[] = [];
  for (const displayName of ['合成甲', '合成乙', '合成丙']) {
    const memberId = (await cmd<{memberId: string}>('member.create', {projectId, displayName})).memberId;
    await cmd('member.setRuntime', {memberId, kind: 'fake', permissionMode: 'bypassPermissions'});
    await cmd('room.members.set', {roomId: room.id, memberId, action: 'add'}); members.push(memberId);
  }
  const revision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision: number}).revision;
  await cmd('room.update', {roomId: room.id, expectedRevision: revision, coordinatorMemberId: members[0]});
  const submit = async () => await cmd<{taskId: string; threadId: string; conversationId: string}>('message.submit', {target: {kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId}, body: '合成预算回归', intent: 'default', mentions: members.slice(0, deliberate ? 3 : 2).map(memberId => ({kind: 'member', memberId})), ...(deliberate ? {collaboration: 'deliberate'} : {})});
  return {db, worker, adapter, cmd, submit, room, members};
}

describe('R98 budget policy through formal submission and real worker gates (synthetic adapter)', () => {
  it('does not lose disabled policy when the legacy numeric trigger runs, and dispatches past that number', async () => {
    const f = await fixture(true), sent = await f.submit();
    await f.worker.runOnce();
    const run = f.db.prepare("SELECT id,budget_json FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE'").get(sent.taskId) as {id: string; budget_json: string};
    const budget = JSON.parse(run.budget_json) as Record<string, unknown>;
    expect(budget.callBudget).toMatchObject({enforcement: 'disabled'});
    f.db.prepare('UPDATE workflow_runs SET budget_json=? WHERE id=?').run(JSON.stringify({...budget, usedTurns: 1000}), run.id);
    await f.worker.runOnce();
    expect(f.adapter.startTurnLog, JSON.stringify(f.db.prepare('SELECT kind,payload_json FROM domain_events ORDER BY seq DESC LIMIT 8').all())).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM domain_events WHERE run_id=? AND kind='run.budgetSkipped'").get(run.id)).toEqual({n: 0});
  });

  it('explicit AUTO dispatches after more than 24 historical calls when disabled', async () => {
    const f = await fixture(), sent = await f.submit();
    // Seed the legacy explicit-recipient queue this budget regression is about.
    const root=f.db.prepare('SELECT root_message_id FROM tasks WHERE id=?').get(sent.taskId) as {root_message_id:string};
    f.db.prepare("UPDATE outbox SET status='done' WHERE dispatch_key=? AND status='pending'").run(`task:${sent.taskId}:initial`);
    seedExplicitRecipientCoordination(f.db,sent.taskId,root.root_message_id,'合成预算回归',f.members.slice(0,2));
    const child = f.db.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY rowid LIMIT 1').get(sent.taskId) as {id: string};
    const parentRun = f.db.prepare('SELECT budget_json FROM workflow_runs WHERE task_id=?').get(sent.taskId) as {budget_json: string};
    expect(JSON.parse(parentRun.budget_json).callBudget).toMatchObject({enforcement: 'disabled'});
    f.db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES('prior-run',?,?,'DIRECT','SUCCEEDED')").run(child.id, f.room.conversationId);
    for (let i = 0; i < 30; i++) f.db.prepare("INSERT INTO agent_turns(id,run_id,conversation_id,member_id,stage_key,status,attempt) VALUES(?,'prior-run',?,?,'direct.work','SUCCEEDED',?)").run(`historical-${i}`, f.room.conversationId, f.members[0], i + 1);
    await f.worker.runOnce();
    expect(f.adapter.startTurnLog).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM domain_events WHERE kind='run.dispatchBlocked' AND json_extract(payload_json,'$.message') LIKE '%预算%'").get()).toEqual({n: 0});
  });

  it('derives a three-member enabled cap and keeps the frozen request when the setting later changes', async () => {
    const f = await fixture(true);
    await f.cmd('app.settings.set', {key: 'callBudget.enabled', value: 'true'});
    const sent = await f.submit();
    const before = f.db.prepare('SELECT deliberation_budget_json FROM tasks WHERE id=?').get(sent.taskId) as {deliberation_budget_json: string};
    expect(JSON.parse(before.deliberation_budget_json).callBudget).toMatchObject({enforcement: 'enabled', limit: 24});
    await f.cmd('app.settings.set', {key: 'callBudget.enabled', value: 'false'});
    await f.worker.runOnce();
    const run = f.db.prepare('SELECT budget_json FROM workflow_runs WHERE task_id=?').get(sent.taskId) as {budget_json: string};
    expect(JSON.parse(run.budget_json)).toMatchObject({runMaxTurns: 24, callBudget: {enforcement: 'enabled', limit: 24}});
    expect(f.db.prepare('SELECT deliberation_budget_json FROM tasks WHERE id=?').get(sent.taskId)).toEqual(before);
  });
});
