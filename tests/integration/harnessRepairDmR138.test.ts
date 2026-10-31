import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { externalRuntimeAdapter } from '../../src/daemon/externalRuntime.ts';
import { MemberRuntimeRegistry, resolveMemberRuntime } from '../../src/daemon/memberRuntime.ts';
import { wrapRealCallLedger } from '../../src/daemon/realCallLedger.ts';
import { openDatabase } from '../../src/persistence/db.ts';

// A local Node protocol peer replaces the CLI, including its provider terminal
// and late session identity. No installed Harness, model or network is used.
const peer = String.raw`
const {createInterface}=require('node:readline');
const {appendFileSync,existsSync,readFileSync}=require('node:fs');
const outcomes=OUTCOMES;
const trace=__filename+'.trace';
const reader=createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
reader.on('line',line=>{
  const request=JSON.parse(line);
  if(request.type!=='execute')throw Error('Unexpected command: '+request.type);
  const index=existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').length:0;
  const outcome=outcomes[index];
  if(!outcome)throw Error('Unexpected additional execution');
  appendFileSync(trace,JSON.stringify(request)+'\n');
  const sessionId=request.sessionId||'r138-provider-'+index;
  send({v:1,type:'session',requestId:request.requestId,sessionId,resumed:Boolean(request.sessionId)});
  send({v:1,type:'event',requestId:request.requestId,event:{kind:'usage',inputTokens:13,outputTokens:5,model:'r138-reported-model'}});
  const result={schemaVersion:'task-complete-v1',
    resultKey:outcome==='wrong-key'?'foreign-result-key':request.outputSchema.properties.resultKey.const,
    changeSummary:'本地协议结果',answer:'本地协议结果',document:null,responseKind:'work',replyDisposition:'reply',userQuestion:null,
    files:[],executedVerifications:['local protocol only'],unexecutedVerifications:[],remainingIssues:[],handoffs:[],memoryUpdates:[]};
  send({v:1,type:'result',requestId:request.requestId,
    sessionId:outcome==='identity-conflict'?sessionId+'-conflict':sessionId,
    status:'completed',stopReason:'completed',text:JSON.stringify(result)});
  reader.close();process.stdin.destroy();
});
send({v:1,type:'ready',runtime:'zhongshuo-dsh',protocol:1,
  capabilities:{structuredEvents:true,sessionResume:true,sessionCancel:true,outputSchema:true,formatRepair:true}});
`;

type Outcome = 'success' | 'wrong-key' | 'identity-conflict';
interface RequestTrace {
  mode: string;
  sessionId?: string;
  prompt: string;
  developerInstructions: string;
  outputSchema: { properties: { resultKey: { const: string } } };
}
interface TurnRow { id: string; run_id: string; session_id: string; status: string; turn_purpose: string }
interface SessionRow { id: string; provider_session_id: string; capabilities_json: string; session_generation: number }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});

async function fixture(outcomes: Outcome[]) {
  const root = mkdtempSync(join(tmpdir(), 'zs-r138-dm-repair-'));
  const project = join(root, 'project'), data = join(root, 'data'), config = join(root, 'config');
  for (const directory of [project, data, config]) mkdirSync(directory);
  for (const name of ['ZS_REAL_DISPATCH_GUARD', 'ZS_REAL_BATCH_ID', 'ZS_MANAGED_RUNTIME', 'ZS_DSH_MODEL', 'ZS_CLAUDE_MODEL', 'ZS_E2E_MODEL']) vi.stubEnv(name, undefined);
  vi.stubEnv('ZS_RUNTIME', 'fake'); vi.stubEnv('ZS_ALLOW_FAKE', '1');
  for (const name of ['DSH_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) vi.stubEnv(name, config);
  const executable = join(root, 'local-harness.cjs');
  writeFileSync(executable, peer.replace('OUTCOMES', JSON.stringify(outcomes)));
  const db = openDatabase(':memory:');
  const children: ChildProcessWithoutNullStreams[] = [];
  const resources: { registry?: MemberRuntimeRegistry } = {};
  cleanups.push(async () => {
    try {
      const report = await resources.registry?.disposeAll();
      expect(report?.failed ?? []).toEqual([]);
      expect(report?.unconfirmed ?? []).toEqual([]);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      if (db.open) db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
  const cmd = async <T = Record<string, unknown>>(method: string, params: unknown): Promise<T> => {
    const reply = await dispatchDaemonCommand({ db, localUserId: 'r138', appDataDir: data, interruptTurn: async () => {} },
      { protocolVersion: 1, commandId: randomUUID(), method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!reply.ok) throw Error(reply.error?.message ?? method);
    return reply.data!;
  };
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: project })).project.id;
  const memberId = (await cmd<{ memberId: string }>('member.create', { projectId, displayName: 'Harness R138' })).memberId;
  await cmd('member.setRuntime', { memberId, kind: 'deepseek-harness', executable, model: 'r138-requested-model', permissionMode: 'bypassPermissions' });
  const conversationId = (await cmd<{ conversationId: string }>('conversation.create', { projectId, peerMemberId: memberId })).conversationId;
  const registry = new MemberRuntimeRegistry(db, new FakeRuntimeAdapter(), {
    'deepseek-harness': binding => wrapRealCallLedger(externalRuntimeAdapter('deepseek-harness', {
      executable: binding.executable ?? undefined, model: binding.model ?? undefined,
      installationId: binding.installationId ?? undefined, permissionMode: binding.permissionMode ?? undefined, cwd: project,
      spawnFn: (command, args, cwd, env) => {
        const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: 'pipe' });
        children.push(child); return child;
      },
    }), 'deepseek-harness', db, binding.model),
  }, { defaultKind: 'fake' });
  resources.registry = registry;
  const worker = new DispatchWorker({ db, adapter: new FakeRuntimeAdapter(), adapterFor: id => registry.adapterFor(id),
    leaseOwner: 'r138-dm-repair', appDataDir: data, defaultProviderKey: 'fake', automaticRecovery: false });
  const send = (body: string) => cmd<{ taskId: string }>('message.submit', {
    target: { kind: 'dm', projectId, conversationId }, body, intent: 'default', mentions: [],
  });
  const turns = (taskId: string) => db.prepare(`SELECT t.id,t.run_id,t.session_id,t.status,t.turn_purpose
    FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id=? ORDER BY t.rowid`).all(taskId) as TurnRow[];
  const sessions = () => db.prepare("SELECT id,provider_session_id,capabilities_json,session_generation FROM runtime_sessions WHERE conversation_id=? AND scope_kind='dm' ORDER BY rowid").all(conversationId) as SessionRow[];
  const traces = () => readFileSync(executable + '.trace', 'utf8').trim().split('\n').map(line => JSON.parse(line) as RequestTrace);
  const events = (turnId: string, kind: string) => (db.prepare('SELECT payload_json FROM domain_events WHERE turn_id=? AND kind=? ORDER BY seq').all(turnId, kind) as Array<{ payload_json: string }>).map(row => JSON.parse(row.payload_json));
  const repair = async (taskId: string) => {
    const source = turns(taskId)[0]!;
    expect(source).toMatchObject({ status: 'FAILED', turn_purpose: 'stage_work' });
    expect(events(source.id, 'turn.outputInvalid')).toHaveLength(1);
    const task = db.prepare('SELECT revision,stop_generation FROM tasks WHERE id=?').get(taskId) as { revision: number; stop_generation: number };
    expect(await cmd('task.redispatch', { taskId, sourceRunId: source.run_id, expectedTaskRevision: task.revision,
      expectedStopGeneration: task.stop_generation, expectedRunStatus: 'FAILED', formatRepair: true, reason: 'R138 protocol regression' })).toMatchObject({ enqueued: true });
    await worker.runOnce();
    return { source, repaired: turns(taskId)[1]! };
  };
  return { db, cmd, worker, send, turns, sessions, traces, events, repair, children, memberId, conversationId };
}

describe('R138 Harness DM format repair through formal commands, worker and local protocol', () => {
  it('isolates format repair, then opens a fresh normal session and resumes that normal session natively', async () => {
    const f = await fixture(['wrong-key', 'success', 'success', 'success']);
    const task = await f.send('完成这个独立任务');
    await f.worker.runOnce();
    const original = f.sessions()[0]!;
    expect(original.provider_session_id).toBe('r138-provider-0');
    expect(JSON.parse(original.capabilities_json).formatOnlyRepair).toBeUndefined();
    const { source, repaired } = await f.repair(task.taskId);
    expect(repaired).toMatchObject({ status: 'SUCCEEDED', turn_purpose: 'format_repair' });
    expect(repaired.id).not.toBe(source.id);
    const [normalRequest, repairRequest] = f.traces();
    expect(normalRequest).toMatchObject({ mode: 'full' });
    expect(repairRequest).toMatchObject({ mode: 'format-repair', outputSchema: { properties: { resultKey: { const: `result_${source.id}` } } } });
    expect(repairRequest!.sessionId).toBeUndefined();
    expect(repairRequest!.prompt).toContain(source.id);
    expect(repairRequest!.prompt).toContain(`result_${source.id}`);
    const repairSession = f.sessions()[1]!;
    expect(repairSession).toMatchObject({ id: repaired.session_id, provider_session_id: 'r138-provider-1' });
    expect(repairSession.id).not.toBe(original.id);
    expect(JSON.parse(repairSession.capabilities_json)).toMatchObject({ formatOnlyRepair: true,
      runtimeKind: 'deepseek-harness', model: 'r138-requested-model',
      installationId: resolveMemberRuntime(f.db, f.memberId, 'fake').installationId });
    const { formatOnlyRepair, ...repairBinding } = JSON.parse(repairSession.capabilities_json);
    expect(formatOnlyRepair).toBe(true);
    expect(repairBinding).toEqual(JSON.parse(original.capabilities_json));
    expect(f.events(repaired.id, 'dm.sessionOpened')).toEqual([expect.objectContaining({ providerSessionId: 'r138-provider-1' })]);
    expect(f.events(repaired.id, 'dm.sessionResumed')).toEqual([]);
    expect(f.events(repaired.id, 'task.repairConsumed')).toEqual([expect.objectContaining({ sourceTurnId: source.id, sourceResultKey: `result_${source.id}` })]);
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).toEqual({ status: 'DONE' });
    expect(f.db.prepare('SELECT run_id FROM task_deliveries WHERE task_id=?').all(task.taskId)).toEqual([{ run_id: repaired.run_id }]);

    const next = await f.send('这是下一个普通请求');
    await f.worker.runOnce();
    const nextTurn = f.turns(next.taskId)[0]!;
    expect(nextTurn).toMatchObject({ status: 'SUCCEEDED', turn_purpose: 'stage_work' });
    expect(f.traces()[2]).toMatchObject({ mode: 'full', outputSchema: { properties: { resultKey: { const: `result_${nextTurn.id}` } } } });
    expect(f.traces()[2]!.sessionId).toBeUndefined();
    expect(f.sessions()).toHaveLength(3);
    expect(f.sessions()[2]).toMatchObject({ id: nextTurn.session_id, provider_session_id: 'r138-provider-2' });
    expect(JSON.parse(f.sessions()[2]!.capabilities_json).formatOnlyRepair).toBeUndefined();
    expect(f.events(nextTurn.id, 'dm.sessionOpened')).toEqual([expect.objectContaining({ providerSessionId: 'r138-provider-2' })]);
    expect(f.events(nextTurn.id, 'dm.sessionResumed')).toEqual([]);
    const skipped = f.db.prepare("SELECT payload_json FROM domain_events WHERE task_id=? AND kind='dm.sessionResumeSkipped'").get(next.taskId) as { payload_json: string };
    expect(JSON.parse(skipped.payload_json).prevSnapshot).toMatchObject({ formatOnlyRepair: true });
    expect(f.sessions()[0]).toEqual(original);

    // Positive control uses the real CLI adapter scope guard. The next regular
    // DM must resume the normal provider session and bind to its canonical row.
    const nextSession = f.sessions()[2]!;
    const followup = await f.send('继续这个普通会话');
    await f.worker.runOnce();
    const followupTurn = f.turns(followup.taskId)[0]!;
    expect(followupTurn).toMatchObject({ status: 'SUCCEEDED', turn_purpose: 'stage_work', session_id: nextSession.id });
    expect(f.traces()[3]).toMatchObject({ mode: 'full', sessionId: nextSession.provider_session_id,
      outputSchema: { properties: { resultKey: { const: `result_${followupTurn.id}` } } } });
    expect(f.sessions()).toHaveLength(3);
    expect(f.sessions()[2]).toEqual(nextSession);
    expect(f.db.prepare('SELECT thread_id FROM runtime_sessions WHERE id=?').get(nextSession.id)).toEqual({ thread_id: null });
    expect(f.db.prepare('SELECT conversation_thread_id,status FROM tasks WHERE id=?').get(followup.taskId))
      .toEqual({ conversation_thread_id: null, status: 'DONE' });
    expect(f.events(followupTurn.id, 'dm.sessionResumed')).toEqual([expect.objectContaining({
      nativeResume: true, resumeRequested: 'r138-provider-2', providerReported: 'r138-provider-2',
    })]);
    expect(f.events(followupTurn.id, 'dm.sessionOpened')).toEqual([]);
    expect(f.events(followupTurn.id, 'dm.sessionReplayed')).toEqual([]);
    expect(f.sessions()[0]).toEqual(original);
    expect(f.sessions()[1]).toEqual(repairSession);
    for (const [turn, taskId, providerId, resumed] of [
      [source, task.taskId, 'r138-provider-0', null],
      [repaired, task.taskId, 'r138-provider-1', null],
      [nextTurn, next.taskId, 'r138-provider-2', null],
      [followupTurn, followup.taskId, 'r138-provider-2', 'r138-provider-2'],
    ] as const) {
      expect(f.db.prepare('SELECT runtime_kind,member_id,task_id,run_id,model,response_model,status FROM real_calls WHERE turn_id=?').get(turn.id))
        .toEqual({ runtime_kind: 'deepseek-harness', member_id: f.memberId, task_id: taskId, run_id: turn.run_id,
          model: 'r138-requested-model', response_model: 'r138-reported-model', status: turn.status === 'FAILED' ? 'failed' : 'succeeded' });
      const verdict = JSON.parse((f.db.prepare('SELECT value FROM daemon_state WHERE key=?').get(`dm:sessionverdict:${turn.id}`) as { value: string }).value);
      expect(verdict).toEqual({ reported: providerId, observed: [providerId], resumed, identityConflict: false });
    }
    expect(f.children).toHaveLength(4);
    expect(f.children.map(child => child.exitCode)).toEqual([0, 0, 0, 0]);
    expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
  }, 30_000);

  it('rejects a repair with another resultKey and preserves the original failure without delivery', async () => {
    const f = await fixture(['wrong-key', 'wrong-key']);
    const task = await f.send('需要严格结果合同的任务');
    await f.worker.runOnce();
    const { source, repaired } = await f.repair(task.taskId);
    expect(repaired).toMatchObject({ status: 'FAILED', turn_purpose: 'format_repair' });
    expect(f.turns(task.taskId)[0]).toEqual(source);
    expect(f.traces()[1]!.sessionId).toBeUndefined();
    expect(f.traces()[1]!.outputSchema.properties.resultKey.const).toBe(`result_${source.id}`);
    expect(f.events(repaired.id, 'turn.outputInvalid')).toEqual([expect.objectContaining({ issues: expect.arrayContaining([expect.stringContaining('resultKey 不匹配')]) })]);
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).toEqual({ status: 'BLOCKED' });
    expect(f.db.prepare('SELECT 1 FROM task_deliveries WHERE task_id=?').get(task.taskId)).toBeUndefined();
    expect(JSON.parse(f.sessions()[1]!.capabilities_json).formatOnlyRepair).toBe(true);
    expect(f.events(repaired.id, 'dm.sessionResumed')).toEqual([]);
    expect(f.children.map(child => child.exitCode)).toEqual([0, 0]);
  }, 30_000);

  it('records conflicting repair identities as a conflict and never claims native resume or successful delivery', async () => {
    const f = await fixture(['wrong-key', 'identity-conflict']);
    const task = await f.send('身份冲突回归');
    await f.worker.runOnce();
    const { repaired } = await f.repair(task.taskId);
    expect(repaired.status).toBe('FAILED');
    expect(f.events(repaired.id, 'dm.sessionIdentityConflict')).toEqual([expect.objectContaining({
      resumeRequested: null, nativeResume: false, observedSessionIds: ['r138-provider-1', 'r138-provider-1-conflict'], lastReported: 'r138-provider-1-conflict',
    })]);
    expect(f.events(repaired.id, 'dm.sessionResumed')).toEqual([]);
    expect(f.sessions()[1]!.provider_session_id).toBe('r138-provider-1-conflict');
    expect(JSON.parse(f.sessions()[1]!.capabilities_json).formatOnlyRepair).toBe(true);
    expect(f.db.prepare('SELECT 1 FROM task_deliveries WHERE task_id=?').get(task.taskId)).toBeUndefined();
  }, 30_000);
});
