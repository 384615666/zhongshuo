import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { PiAdapter } from '../../src/adapter/pi/adapter.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { MemberRuntimeRegistry, resolveMemberRuntime } from '../../src/daemon/memberRuntime.ts';
import { wrapRealCallLedger } from '../../src/daemon/realCallLedger.ts';
import { openDatabase } from '../../src/persistence/db.ts';

// Local Node CLI only: --version and Pi RPC are implemented here, including
// persisted session headers. No installed Pi, model, credentials or network.
const peer = String.raw`
const {createInterface}=require('node:readline');
const {appendFileSync,existsSync,readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const append=(suffix,value)=>appendFileSync(__filename+suffix,JSON.stringify(value)+'\n');
if(process.argv.includes('--version')){append('.versions','1.4.0');console.log('1.4.0');process.exit(0);}
const outcomes=OUTCOMES;
const argv=process.argv.slice(2),value=flag=>argv[argv.indexOf(flag)+1];
const index=existsSync(__filename+'.launches')?readFileSync(__filename+'.launches','utf8').trim().split('\n').length:0;
const outcome=outcomes[index];if(!outcome)throw Error('Unexpected additional local execution');
const sessionId=value('--session-id'),sessionFile=join(value('--session-dir'),sessionId+'.jsonl');
const resumed=existsSync(sessionFile),messageCount=resumed?2:0;
const repair=argv.includes('--no-tools');
const system=readFileSync(value(argv.includes('--system-prompt')?'--system-prompt':'--append-system-prompt'),'utf8');
const marker='JSON Schema (literal data):\n',offset=system.lastIndexOf(marker);
if(offset<0)throw Error('Missing literal schema in system instructions');
const outputSchema=JSON.parse(system.slice(offset+marker.length));
append('.launches',{index,argv,sessionId,sessionFile,resumed,messageCount,repair,system,outputSchema});
const reader=createInterface({input:process.stdin});
const send=frame=>process.stdout.write(JSON.stringify(frame)+'\n');
const ack=request=>send({id:request.id,type:'response',command:request.type,success:true});
const setup=new Set();
reader.on('line',line=>{
  const request=JSON.parse(line);append('.commands',{index,...request});
  if(request.type==='set_auto_retry'||request.type==='set_auto_compaction'){
    if(!repair||request.enabled!==false)throw Error('Invalid repair setup');setup.add(request.type);ack(request);return;
  }
  if(request.type==='get_state'){
    if(repair&&(setup.size!==2||messageCount!==0||resumed))throw Error('Repair is not fresh or setup was not acknowledged');
    send({id:request.id,type:'response',command:'get_state',success:true,data:{
      sessionId:outcome==='identity-conflict'?randomUUID():sessionId,sessionFile,
      isStreaming:false,pendingMessageCount:0,messageCount,isCompacting:false}});return;
  }
  if(request.type==='abort'){ack(request);return;}
  if(request.type!=='prompt')throw Error('Unexpected RPC command: '+request.type);
  if(!resumed)writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()})+'\n');
  appendFileSync(sessionFile,JSON.stringify({type:'message',role:'user',text:request.message})+'\n');
  send({id:request.id,type:'response',command:'prompt',success:true,data:{disposition:'started'}});
  send({type:'agent_start'});
  const result={schemaVersion:'task-complete-v1',
    resultKey:outcome==='wrong-key'?'foreign-result-key':outputSchema.properties.resultKey.const,
    changeSummary:'Pi 本地协议结果',answer:'Pi 本地协议结果',document:null,responseKind:'work',replyDisposition:'reply',userQuestion:null,
    files:[],executedVerifications:['local protocol only'],unexecutedVerifications:[],remainingIssues:[],handoffs:[],memoryUpdates:[]};
  const message={role:'assistant',content:[{type:'text',text:JSON.stringify(result)}],stopReason:'stop',
    model:'r139-reported-model',usage:{input:13,output:5,cacheRead:0}};
  appendFileSync(sessionFile,JSON.stringify({type:'message',message})+'\n');
  send({type:'message_end',message});send({type:'agent_settled',aborted:false});
  reader.close();process.stdin.destroy();
});
`;

type Outcome = 'success' | 'wrong-key' | 'identity-conflict';
interface TurnRow { id: string; run_id: string; session_id: string; status: string; turn_purpose: string }
interface SessionRow { id: string; provider_session_id: string | null; capabilities_json: string; session_generation: number }
interface CommandTrace { index: number; type: string; enabled?: boolean; message?: string }
interface LaunchTrace {
  index: number; argv: string[]; sessionId: string; sessionFile: string; resumed: boolean; messageCount: number;
  repair: boolean; system: string; outputSchema: { properties: { resultKey: { const: string } } };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});

async function fixture(outcomes: Outcome[]) {
  const root = mkdtempSync(join(tmpdir(), 'zs-r139-pi-dm-repair-'));
  const project = join(root, 'project'), data = join(root, 'data'), config = join(root, 'config'), sessionDir = join(root, 'sessions');
  for (const path of [project, data, config, sessionDir]) mkdirSync(path);
  for (const name of ['ZS_REAL_DISPATCH_GUARD', 'ZS_REAL_BATCH_ID', 'ZS_MANAGED_RUNTIME', 'ZS_PI_MODEL', 'ZS_CLAUDE_MODEL', 'ZS_E2E_MODEL']) vi.stubEnv(name, undefined);
  vi.stubEnv('ZS_RUNTIME', 'fake'); vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY', '0');
  vi.stubEnv('PI_CODING_AGENT_DIR', config);
  const executable = join(root, 'local-pi.cjs'); writeFileSync(executable, peer.replace('OUTCOMES', JSON.stringify(outcomes)));
  const db = openDatabase(':memory:'), children: ChildProcessWithoutNullStreams[] = [];
  const resources: { registry?: MemberRuntimeRegistry } = {};
  cleanups.push(async () => {
    try {
      const report = await resources.registry?.disposeAll();
      expect(report?.failed ?? []).toEqual([]); expect(report?.unconfirmed ?? []).toEqual([]);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      if (db.open) db.close();
      expect(dirname(root)).toBe(tmpdir());
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
  const cmd = async <T = Record<string, unknown>>(method: string, params: unknown): Promise<T> => {
    const reply = await dispatchDaemonCommand({ db, localUserId: 'r139', appDataDir: data, interruptTurn: async () => {} },
      { protocolVersion: 1, commandId: randomUUID(), method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!reply.ok) throw Error(reply.error?.message ?? method); return reply.data!;
  };
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: project })).project.id;
  const memberId = (await cmd<{ memberId: string }>('member.create', { projectId, displayName: 'Pi R139' })).memberId;
  await cmd('member.setRuntime', { memberId, kind: 'pi', executable, model: 'r139-requested-model', permissionMode: 'bypassPermissions' });
  const conversationId = (await cmd<{ conversationId: string }>('conversation.create', { projectId, peerMemberId: memberId })).conversationId;
  const registry = new MemberRuntimeRegistry(db, new FakeRuntimeAdapter(), {
    pi: binding => wrapRealCallLedger(new PiAdapter({
      executable: binding.executable ?? undefined, model: binding.model ?? undefined, sessionDir,
      installationId: binding.installationId ?? undefined, permissionMode: binding.permissionMode ?? undefined, cwd: project,
      spawnFn: (command, args, cwd, env) => {
        const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: 'pipe' }); children.push(child); return child;
      },
    }), 'pi', db, binding.model),
  }, { defaultKind: 'fake' });
  resources.registry = registry;
  const worker = new DispatchWorker({ db, adapter: new FakeRuntimeAdapter(), adapterFor: id => registry.adapterFor(id),
    leaseOwner: 'r139-pi-dm-repair', appDataDir: data, defaultProviderKey: 'fake', automaticRecovery: false });
  const send = (body: string) => cmd<{ taskId: string }>('message.submit', {
    target: { kind: 'dm', projectId, conversationId }, body, intent: 'default', mentions: [],
  });
  const turns = (taskId: string) => db.prepare(`SELECT t.id,t.run_id,t.session_id,t.status,t.turn_purpose
    FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id=? ORDER BY t.rowid`).all(taskId) as TurnRow[];
  const sessions = () => db.prepare("SELECT id,provider_session_id,capabilities_json,session_generation FROM runtime_sessions WHERE conversation_id=? AND scope_kind='dm' ORDER BY rowid").all(conversationId) as SessionRow[];
  const lines = <T>(suffix: string): T[] => existsSync(executable + suffix)
    ? readFileSync(executable + suffix, 'utf8').trim().split('\n').map(line => JSON.parse(line) as T) : [];
  const traces = () => lines<LaunchTrace>('.launches');
  const commands = (index: number) => lines<CommandTrace>('.commands').filter(command => command.index === index);
  const events = (turnId: string, kind: string) => (db.prepare('SELECT payload_json FROM domain_events WHERE turn_id=? AND kind=? ORDER BY seq').all(turnId, kind) as Array<{ payload_json: string }>).map(row => JSON.parse(row.payload_json));
  const repair = async (taskId: string) => {
    const source = turns(taskId)[0]!;
    expect(source).toMatchObject({ status: 'FAILED', turn_purpose: 'stage_work' });
    expect(events(source.id, 'turn.outputInvalid')).toHaveLength(1);
    const task = db.prepare('SELECT revision,stop_generation FROM tasks WHERE id=?').get(taskId) as { revision: number; stop_generation: number };
    expect(await cmd('task.redispatch', { taskId, sourceRunId: source.run_id, expectedTaskRevision: task.revision,
      expectedStopGeneration: task.stop_generation, expectedRunStatus: 'FAILED', formatRepair: true, reason: 'R139 Pi DM protocol regression' })).toMatchObject({ enqueued: true });
    await worker.runOnce(); return { source, repaired: turns(taskId)[1]! };
  };
  return { db, cmd, worker, send, turns, sessions, traces, commands, events, repair, children, memberId, conversationId, lines };
}

function expectRepairLaunch(trace: LaunchTrace, commands: CommandTrace[], source: TurnRow) {
  expect(trace).toMatchObject({ repair: true, resumed: false, messageCount: 0,
    outputSchema: { properties: { resultKey: { const: `result_${source.id}` } } } });
  expect(trace.argv).toEqual(expect.arrayContaining(['--system-prompt', '--append-system-prompt', '', '--no-tools', '--exclude-tools', '*',
    '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve']));
  expect(commands.map(command => command.type)).toEqual(['set_auto_retry', 'set_auto_compaction', 'get_state', 'prompt']);
  expect(commands.slice(0, 2).map(command => command.enabled)).toEqual([false, false]);
  expect(commands[3]!.message).toContain(source.id); expect(commands[3]!.message).toContain(`result_${source.id}`);
}

describe('R139 Pi DM format repair through formal commands, worker and local RPC child', () => {
  it('isolates source-key repair, then opens a fresh normal session and natively resumes its canonical row', async () => {
    const f = await fixture(['wrong-key', 'success', 'success', 'success']);
    const task = await f.send('完成这个独立任务'); await f.worker.runOnce();
    const original = f.sessions()[0]!, originalProvider = f.traces()[0]!.sessionId;
    expect(original.provider_session_id).toBe(originalProvider);
    expect(JSON.parse(original.capabilities_json).formatOnlyRepair).toBeUndefined();
    const { source, repaired } = await f.repair(task.taskId);
    expect(repaired).toMatchObject({ status: 'SUCCEEDED', turn_purpose: 'format_repair' });
    expectRepairLaunch(f.traces()[1]!, f.commands(1), source);
    const repairSession = f.sessions()[1]!, repairProvider = f.traces()[1]!.sessionId;
    expect(repairProvider).not.toBe(originalProvider);
    expect(repairSession).toMatchObject({ id: repaired.session_id, provider_session_id: repairProvider });
    expect(JSON.parse(repairSession.capabilities_json)).toMatchObject({ formatOnlyRepair: true, runtimeKind: 'pi', model: 'r139-requested-model',
      installationId: resolveMemberRuntime(f.db, f.memberId, 'fake').installationId });
    const { formatOnlyRepair, ...repairBinding } = JSON.parse(repairSession.capabilities_json);
    expect(formatOnlyRepair).toBe(true); expect(repairBinding).toEqual(JSON.parse(original.capabilities_json));
    expect(f.events(repaired.id, 'dm.sessionOpened')).toEqual([expect.objectContaining({ providerSessionId: repairProvider })]);
    expect(f.events(repaired.id, 'dm.sessionResumed')).toEqual([]);
    expect(f.events(repaired.id, 'task.repairConsumed')).toEqual([expect.objectContaining({ sourceTurnId: source.id, sourceResultKey: `result_${source.id}` })]);
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).toEqual({ status: 'DONE' });
    expect(f.db.prepare('SELECT run_id FROM task_deliveries WHERE task_id=?').all(task.taskId)).toEqual([{ run_id: repaired.run_id }]);

    const next = await f.send('这是下一个普通请求'); await f.worker.runOnce();
    const nextTurn = f.turns(next.taskId)[0]!, nextSession = f.sessions()[2]!, nextProvider = f.traces()[2]!.sessionId;
    expect(nextTurn).toMatchObject({ status: 'SUCCEEDED', turn_purpose: 'stage_work', session_id: nextSession.id });
    expect(f.traces()[2]).toMatchObject({ repair: false, resumed: false, messageCount: 0,
      outputSchema: { properties: { resultKey: { const: `result_${nextTurn.id}` } } } });
    expect(nextProvider).not.toBe(repairProvider); expect(nextProvider).not.toBe(originalProvider);
    expect(f.sessions()).toHaveLength(3); expect(nextSession.provider_session_id).toBe(nextProvider);
    expect(JSON.parse(nextSession.capabilities_json).formatOnlyRepair).toBeUndefined();
    expect(f.events(nextTurn.id, 'dm.sessionOpened')).toEqual([expect.objectContaining({ providerSessionId: nextProvider })]);
    expect(f.events(nextTurn.id, 'dm.sessionResumed')).toEqual([]);
    const skipped = f.db.prepare("SELECT payload_json FROM domain_events WHERE task_id=? AND kind='dm.sessionResumeSkipped'").get(next.taskId) as { payload_json: string };
    expect(JSON.parse(skipped.payload_json).prevSnapshot).toMatchObject({ formatOnlyRepair: true });

    const followup = await f.send('继续这个普通会话'); await f.worker.runOnce();
    const followupTurn = f.turns(followup.taskId)[0]!;
    expect(followupTurn).toMatchObject({ status: 'SUCCEEDED', turn_purpose: 'stage_work', session_id: nextSession.id });
    expect(f.traces()[3]).toMatchObject({ repair: false, resumed: true, messageCount: 2, sessionId: nextProvider,
      outputSchema: { properties: { resultKey: { const: `result_${followupTurn.id}` } } } });
    expect(f.sessions()).toHaveLength(3); expect(f.sessions()[2]).toEqual(nextSession);
    expect(f.sessions()[0]).toEqual(original); expect(f.sessions()[1]).toEqual(repairSession);
    expect(f.db.prepare('SELECT thread_id FROM runtime_sessions WHERE id=?').get(nextSession.id)).toEqual({ thread_id: null });
    expect(f.db.prepare('SELECT conversation_thread_id,status FROM tasks WHERE id=?').get(followup.taskId)).toEqual({ conversation_thread_id: null, status: 'DONE' });
    expect(f.events(followupTurn.id, 'dm.sessionResumed')).toEqual([expect.objectContaining({ nativeResume: true, resumeRequested: nextProvider, providerReported: nextProvider })]);
    expect(f.events(followupTurn.id, 'dm.sessionOpened')).toEqual([]); expect(f.events(followupTurn.id, 'dm.sessionReplayed')).toEqual([]);
    for (const [turn, taskId, providerId, resumed] of [
      [source, task.taskId, originalProvider, null], [repaired, task.taskId, repairProvider, null],
      [nextTurn, next.taskId, nextProvider, null], [followupTurn, followup.taskId, nextProvider, nextProvider],
    ] as const) {
      expect(f.db.prepare('SELECT runtime_kind,member_id,task_id,run_id,model,response_model,status FROM real_calls WHERE turn_id=?').get(turn.id))
        .toEqual({ runtime_kind: 'pi', member_id: f.memberId, task_id: taskId, run_id: turn.run_id,
          model: 'r139-requested-model', response_model: 'r139-reported-model', status: turn.status === 'FAILED' ? 'failed' : 'succeeded' });
      const verdict = JSON.parse((f.db.prepare('SELECT value FROM daemon_state WHERE key=?').get(`dm:sessionverdict:${turn.id}`) as { value: string }).value);
      expect(verdict).toEqual({ reported: providerId, observed: [providerId], resumed, identityConflict: false });
    }
    expect(f.lines('.versions')).toEqual(['1.4.0']);
    expect(f.children).toHaveLength(4); expect(f.children.map(child => child.exitCode)).toEqual([0, 0, 0, 0]);
    expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
  }, 30_000);

  it('rejects another repair resultKey and preserves the original failed turn without delivery', async () => {
    const f = await fixture(['wrong-key', 'wrong-key']);
    const task = await f.send('需要严格结果合同的任务'); await f.worker.runOnce();
    const { source, repaired } = await f.repair(task.taskId);
    expect(repaired).toMatchObject({ status: 'FAILED', turn_purpose: 'format_repair' });
    expect(f.turns(task.taskId)[0]).toEqual(source); expectRepairLaunch(f.traces()[1]!, f.commands(1), source);
    expect(f.events(repaired.id, 'turn.outputInvalid')).toEqual([expect.objectContaining({ issues: expect.arrayContaining([expect.stringContaining('resultKey 不匹配')]) })]);
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).toEqual({ status: 'BLOCKED' });
    expect(f.db.prepare('SELECT 1 FROM task_deliveries WHERE task_id=?').get(task.taskId)).toBeUndefined();
    expect(JSON.parse(f.sessions()[1]!.capabilities_json).formatOnlyRepair).toBe(true);
    expect(f.events(repaired.id, 'dm.sessionResumed')).toEqual([]); expect(f.children.map(child => child.exitCode)).toEqual([0, 0]);
  }, 30_000);

  it('rejects a conflicting repair handshake identity before prompt and never claims resume or delivery', async () => {
    const f = await fixture(['wrong-key', 'identity-conflict']);
    const task = await f.send('身份冲突回归'); await f.worker.runOnce();
    const original = f.sessions()[0]!;
    const { source, repaired } = await f.repair(task.taskId);
    expect(repaired).toMatchObject({ status: 'FAILED', turn_purpose: 'format_repair' });
    expect(f.turns(task.taskId)[0]).toEqual(source); expect(f.sessions()[0]).toEqual(original);
    expect(f.commands(1).map(command => command.type)).toEqual(['set_auto_retry', 'set_auto_compaction', 'get_state']);
    expect(f.events(repaired.id, 'turn.statusChanged')).toContainEqual(expect.objectContaining({
      status: 'FAILED', code: 'OUTPUT_INVALID', message: expect.stringContaining('Pi 返回了不同或仍在运行的会话'),
    }));
    expect(f.events(repaired.id, 'dm.sessionResumed')).toEqual([]);
    expect(f.sessions()[1]!.provider_session_id).toBeNull();
    expect(JSON.parse(f.sessions()[1]!.capabilities_json).formatOnlyRepair).toBe(true);
    expect(f.db.prepare('SELECT 1 FROM task_deliveries WHERE task_id=?').get(task.taskId)).toBeUndefined();
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).not.toEqual({ status: 'DONE' });
  }, 30_000);
});
