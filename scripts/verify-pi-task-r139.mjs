/**
 * R139: installed Pi through authenticated daemon IPC and the production worker.
 * node scripts/verify-pi-task-r139.mjs --prepare-only
 * Main executor ONLY, after the Pi fix is ready:
 * node scripts/verify-pi-task-r139.mjs --run-real --pi-ready
 * All three scenarios: at most 3 real startTurn attempts + 3 fixture reservations.
 * No installs, live appData, automatic retries, or source/database state patches.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `R139 formal installed-Pi acceptance (Windows; no package installation).
  --prepare-only          Set up three isolated IPC scenarios; record_only, zero inference.
  --run-real --pi-ready    Main executor opt-in after the Pi implementation is ready.
  --scenario NAME         greeting | repair | continuation; default: all three.
  --pi-model ID           Default: magpie/newapi/glm-5.3-flash.
  --pi-effort LEVEL       Default: low.
  --timeout-ms N          Per scenario, 180000 default, 10000..600000; never retry.
  --evidence-dir PATH     Default: dist/r139-formal/<unique run>.
Greeting: one real Pi turn, no repair. Repair: plain-output fixture -> real tool-free
repair. Continuation: plain-output + unsupported-repair fixtures -> explicit ordinary
task.redispatch -> one real Pi turn. Fixtures are NOT provider requests.
All appData, workspaces, Pi sessions and call journals are freshly allocated under
OS temp; installed Pi configuration is reused. No original task/data is opened.
`;
const values = new Set(['--scenario', '--pi-model', '--pi-effort', '--timeout-ms', '--evidence-dir']);
const flags = new Set(['--help', '--prepare-only', '--run-real', '--pi-ready']);
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  assert.ok(values.has(name) || flags.has(name), `Unknown option: ${name}`);
  assert.ok(!args.has(name), `Repeated option: ${name}`);
  const value = values.has(name) ? process.argv[++index] : true;
  assert.ok(value && !String(value).startsWith('--'), `Missing value for ${name}`);
  args.set(name, value);
}
const sha = value => createHash('sha256').update(value).digest('hex');
const terminal = turn => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(turn.status);
const redact = value => String(value).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '[redacted]')
  .replace(/((?:api[_-]?key|authorization|password|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, '$1[redacted]')
  .replace(/https?:\/\/[^\s<>"']+/g, '[endpoint-redacted]');

function metadata(command, argv, cwd, env) {
  return new Promise((accept, reject) => execFile(command, argv,
    { cwd, env, windowsHide: true, timeout: 15000, maxBuffer: 65536 },
    (error, stdout) => error ? reject(Error(`Local metadata command failed (${error.code ?? 'unknown'})`)) : accept(stdout.trim())));
}
async function within(root, path) {
  const resolved = await realpath(path), below = relative(await realpath(root), resolved);
  assert.ok(below && !below.startsWith('..') && !isAbsolute(below), 'Verifier path escaped its fresh temporary root');
  return resolved;
}

async function main() {
  assert.equal(process.platform, 'win32', 'Requires installed Windows Pi and managed jobs');
  const real = args.has('--run-real');
  assert.ok(!(real && args.has('--prepare-only')), 'Choose one execution mode');
  assert.ok(!real || args.has('--pi-ready'), 'Main executor must confirm the Pi fix is ready with --pi-ready');
  const names = args.has('--scenario') ? [args.get('--scenario')] : ['greeting', 'repair', 'continuation'];
  assert.ok(names.every(name => ['greeting', 'repair', 'continuation'].includes(name)), 'Invalid scenario');
  const timeoutMs = Number(args.get('--timeout-ms') ?? 180000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10000 && timeoutMs <= 600000, 'Invalid timeout');
  const model = args.get('--pi-model') ?? 'magpie/newapi/glm-5.3-flash';
  const effort = args.get('--pi-effort') ?? 'low';
  const caps = { greeting: 1, repair: 2, continuation: 3 };
  const cap = names.reduce((sum, name) => sum + caps[name], 0);
  const runId = `r139-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tempRoot = await mkdtemp(join(tmpdir(), 'zs-r139-pi-formal-'));
  const evidenceDir = resolve(args.get('--evidence-dir') ?? join(sourceRoot, 'dist/r139-formal', runId));
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, 'intent.json'), JSON.stringify({ runId, real, names, tempRoot, model, effort,
    maxRealAttempts: real ? names.length : 0, maxLedgerReservations: real ? cap : 0,
    accounting: 'startTurn boundary; fixture reservations explicitly excluded from real attempts', at: new Date().toISOString() }, null, 2), { flag: 'wx' });
  const report = { runId, mode: real ? 'real' : 'prepare-only', sourceHead: await metadata('git', ['rev-parse', 'HEAD'], sourceRoot),
    verifierSha256: sha(await readFile(fileURLToPath(import.meta.url))), tempRoot, evidenceDir, model, effort,
    maxRealAttempts: real ? names.length : 0, expectedFixtureTurns: real ? cap - names.length : 0,
    maxLedgerReservations: real ? cap : 0, realAttempts: 0, modelTurns: 0, fixtureTurns: 0, status: 'running', scenarios: [] };
  report.sourceSha256 = {};
  for (const path of ['src/adapter/pi/adapter.ts', 'src/daemon/dispatchWorker.ts', 'src/daemon/entry.ts'])
    report.sourceSha256[path] = sha(await readFile(join(sourceRoot, path)));
  const save = () => writeFile(join(evidenceDir, 'report.json'), redact(JSON.stringify(report, null, 2)));
  assert.ok(!real || process.env.ZS_REAL_DISPATCH_GUARD !== '1', 'Inherited dispatch guard is enabled; no inference attempted');
  Object.assign(process.env, { ZS_MANAGED_RUNTIME: '1', ZS_RUNTIME: 'pi', ZS_PI_MODEL: model,
    ZS_DEFAULT_MEMBER_DISCOVERY: '0', ZS_REMINDER_DISABLED: '1', ZS_REAL_BATCH_ID: runId,
    ZS_REAL_BATCH_CAP: String(real ? cap : 1), ZS_REAL_BATCH_DIR: join(tempRoot, 'call-journal'),
    // The production dispatch guard also rejects member.setRuntime itself.
    // Prepare uses record_only plus the factory's unconditional startTurn guard.
    ZS_TURN_DEADLINE_MS: String(timeoutMs), ZS_REAL_DISPATCH_GUARD: '0' });
  for (const key of ['ZS_REAL_BATCH_RUNTIME', 'ZS_REAL_BATCH_MODEL', 'ZS_BOOTSTRAP_AGENTS', 'ZS_DAEMON_LOG_COMMANDS', 'ZS_PACKED_ENTRY', 'ZS_ALLOW_FAKE']) delete process.env[key];
  const { startDaemon } = await import('../src/daemon/entry.ts');
  const bridge = await import('../src/daemon/managed/bridge.ts');
  try {
    assert.equal(bridge.managedBridgeAvailable().ok, true, 'Managed execution unavailable');
    const { resolveAgentExecutable } = await import('../src/adapter/cli/executable.ts');
    const entry = resolveAgentExecutable('pi', process.env.ZS_PI_EXECUTABLE ?? 'pi');
    // --version only: no RPC prompt, model listing, installation, or provider call.
    report.piVersion = await metadata(entry.command, [...entry.prefixArgs, '--version'], tempRoot,
      entry.env ? { ...process.env, ...entry.env } : undefined);
    for (const name of names) {
      const result = { name, cap: caps[name], status: 'running', fixtureTurns: [], actualRequests: [], sessions: [], launches: [], exitProofs: [], toolEvents: [], completed: [] };
      report.scenarios.push(result); await save();
      await scenario({ name, real, result, report, tempRoot, timeoutMs, model, effort, startDaemon, bridge, save });
      console.log(JSON.stringify({ stage: name, status: result.status, ledgerReservations: result.facts.calls.length,
        modelTurns: result.modelTurns, fixtureTurns: result.fixtureTurns.length, taskStatus: result.facts.tasks[0]?.status }));
    }
    report.modelTurns = report.scenarios.reduce((sum, result) => sum + result.modelTurns, 0);
    report.fixtureTurns = report.scenarios.reduce((sum, result) => sum + result.fixtureTurns.length, 0);
    assert.equal(report.modelTurns, report.maxRealAttempts);
    assert.equal(report.fixtureTurns, report.expectedFixtureTurns);
    report.status = real ? 'passed' : 'prepared';
  } catch (error) {
    report.status = 'failed'; report.error = redact(error.message); process.exitCode = 1;
  } finally {
    report.realAttempts = report.scenarios.reduce((sum, result) => sum + result.actualRequests.length, 0);
    report.modelTurns = report.scenarios.reduce((sum, result) => sum + (result.facts?.calls ?? [])
      .filter(call => !result.fixtureTurns.some(turn => turn.turnId === call.turn_id)).length, 0);
    report.fixtureTurns = report.scenarios.reduce((sum, result) => sum + result.fixtureTurns.length, 0);
    report.cleanup = { jobsRemaining: bridge.managedJobsCount(), pollersRemaining: bridge.managedActivePollers() };
    if (report.cleanup.jobsRemaining || report.cleanup.pollersRemaining) { report.status = 'failed'; process.exitCode = 1; }
    await save();
    console.log(JSON.stringify({ status: report.status, report: join(evidenceDir, 'report.json'), tempRoot,
      realAttempts: report.realAttempts, modelTurns: report.modelTurns, fixtureTurns: report.fixtureTurns, cleanup: report.cleanup, error: report.error }));
  }
}

async function scenario({ name, real, result, report, tempRoot, timeoutMs, model, effort, startDaemon, bridge, save }) {
  const root = await mkdtemp(join(tempRoot, `${name}-`));
  for (const child of ['appData', 'workspace', 'pi-sessions']) await mkdir(join(root, child));
  result.appDataDir = await within(tempRoot, join(root, 'appData'));
  result.workspace = await within(tempRoot, join(root, 'workspace'));
  result.piSessionDir = await within(tempRoot, join(root, 'pi-sessions'));
  result.marker = `R139_${name.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
  await writeFile(join(result.workspace, 'marker.txt'), `${result.marker}\n`, { flag: 'wx' });
  let daemon, ipc;
  try {
    daemon = await startDaemon({ appDataDir: result.appDataDir, runtime: 'pi', localUserId: 'r139-isolated',
      pipeName: `zs-${randomUUID()}`, tickMs: 100, drainSettleTimeoutMs: 10000,
      testAdapterFactories: { pi: await piFactory({ name, real, result, report, model, bridge }) } });
    assert.equal(daemon.db.prepare('SELECT count(*) n FROM tasks').get().n, 0, 'AppData must start empty');
    ipc = await connectIpc(daemon);
    const project = (await ipc.command('project.open', { path: result.workspace, agentNames: ['R139 Pi'] })).project;
    const members = (await ipc.command('member.list', { projectId: project.id })).items;
    assert.equal(members.length, 1, 'Only Pi may participate'); result.memberId = members[0].id;
    await ipc.command('member.setRuntime', { memberId: result.memberId, kind: 'pi', executable: process.env.ZS_PI_EXECUTABLE ?? 'pi',
      permissionMode: 'bypassPermissions', model, effort });
    const room = (await ipc.command('room.list', { projectId: project.id })).items[0];
    await ipc.command('room.update', { roomId: room.id, expectedRevision: room.revision, coordinatorMemberId: result.memberId });
    const params = { target: { kind: 'room_root', projectId: project.id, roomId: room.id, conversationId: room.conversationId },
      body: `这是隔离的 Pi 接入验证。只使用本消息材料，不读文件、不使用任何工具、不改文件、不调用外部服务、不向其他成员交接。请用一句中文问候我，包含 ${result.marker}。按本轮正式结果协议如实提交，不声称做过任何工具验证。`,
      intent: real ? 'default' : 'record_only', mentions: [{ kind: 'member', memberId: result.memberId }] };
    result.commandId = randomUUID();
    result.submitted = await ipc.command('message.submit', params, result.commandId);
    if (!real) {
      assert.equal(result.submitted.taskId, null);
      await delay(400);
      result.facts = facts(daemon.db);
      assert.equal(result.facts.calls.length, 0); assert.equal(result.facts.turns.length, 0); assert.equal(result.facts.tasks.length, 0);
      assert.equal(result.actualRequests.length, 0); assert.equal(result.fixtureTurns.length, 0); assert.equal(result.launches.length, 0);
      result.modelTurns = 0; result.status = 'prepared';
    } else {
      assert.ok(result.submitted.taskId && result.submitted.threadId, 'message.submit did not create a formal task/thread');
      // One deadline includes both the fixture failure and explicit continuation.
      const deadline = Date.now() + timeoutMs;
      if (name === 'continuation') {
        await waitUntil(daemon, deadline, result, save, snapshot => snapshot.turns.length === 2 && snapshot.turns.every(terminal)
          && snapshot.turns.at(-1).status === 'FAILED' && snapshot.repairs[0]?.consumed_turn_id === snapshot.turns.at(-1).id && !hasPending(snapshot));
        result.beforeContinuation = facts(daemon.db);
        const old = result.beforeContinuation;
        assert.ok(['ACTIVE', 'BLOCKED'].includes(old.tasks[0].status), 'Unsupported repair must leave the task unfinished');
        assert.equal(result.actualRequests.length, 0, 'Inference occurred before explicit continuation');
        assert.deepEqual(result.fixtureTurns.map(turn => turn.repairOnly), [false, true]);
        const state = await ipc.command('task.get', { taskId: result.submitted.taskId });
        result.redispatch = await ipc.command('task.redispatch', { taskId: result.submitted.taskId, sourceRunId: state.activeRun.id,
          expectedTaskRevision: state.task.revision, expectedStopGeneration: state.task.stopGeneration,
          expectedRunStatus: state.activeRun.status, reason: 'R139 explicit ordinary continuation after consumed unsupported Pi repair' });
        assert.equal(result.redispatch.formatRepair, false);
      }
      await waitUntil(daemon, deadline, result, save, snapshot => snapshot.tasks.length === 1 && snapshot.tasks[0].status === 'DONE'
        && snapshot.turns.length > 0 && snapshot.turns.every(terminal) && !hasPending(snapshot));
      result.facts = facts(daemon.db);
      const state = await ipc.command('task.get', { taskId: result.submitted.taskId });
      assert.equal(state.task.status, 'DONE'); assert.equal(state.activeRun?.status, 'SUCCEEDED');
      result.formalTask = { task: state.task, activeRun: state.activeRun };
      checkAcceptance(name, result, model);
      const history = await ipc.command('thread.history', { threadId: result.submitted.threadId, limit: 100 });
      assert.equal(history.items.filter(item => item.id === result.finalMessageId).length, 1, 'Accepted reply missing from formal thread.history');
      const stable = stableFacts(facts(daemon.db));
      const replay = await ipc.command('message.submit', params, result.commandId);
      assert.equal(replay.taskId, result.submitted.taskId); assert.equal(replay.messageId, result.submitted.messageId);
      await delay(1500);
      assert.deepEqual(stableFacts(facts(daemon.db)), stable, 'Same-command replay/settling changed formal tasks, calls, replies, or repair lineage');
      result.idempotentReplay = true; result.status = 'passed';
    }
    assert.equal(await readFile(join(result.workspace, 'marker.txt'), 'utf8'), `${result.marker}\n`);
  } catch (error) {
    result.status = 'failed'; result.error = redact(error.message);
    if (daemon) result.facts = facts(daemon.db);
    throw error;
  } finally {
    ipc?.close();
    if (daemon) {
      result.stop = await daemon.stop();
      if (!result.stop.complete) result.forcedStop = await daemon.stop({ force: true });
      result.cleanup = { jobsRemaining: bridge.managedJobsCount(), pollersRemaining: bridge.managedActivePollers() };
      await save();
      assert.equal(result.stop.complete, true, 'Daemon did not stop gracefully');
      assert.deepEqual(result.cleanup, { jobsRemaining: 0, pollersRemaining: 0 }, 'Managed jobs/pollers leaked');
    }
    await save();
  }
}

function facts(db) {
  return {
    tasks: db.prepare('SELECT id,parent_task_id,owner_member_id,status,current_delivery_id FROM tasks ORDER BY rowid').all(),
    turns: db.prepare('SELECT a.id,r.task_id,a.run_id,a.member_id,a.status,a.turn_purpose,a.protection_state FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id ORDER BY a.rowid').all(),
    calls: db.prepare('SELECT id,runtime_kind,model,response_model,member_id,task_id,run_id,turn_id,status FROM real_calls ORDER BY id').all(),
    repairs: db.prepare('SELECT id,task_id,source_turn_id,source_result_key,logical_output_id,invalid_event_id,source_output_hash,consumed_turn_id,status FROM format_repair_workitems ORDER BY rowid').all(),
    outbox: db.prepare('SELECT dispatch_key,status,turn_id FROM outbox ORDER BY id').all(),
    processes: db.prepare('SELECT turn_id,run_id,member_id,adapter_kind,process_model,identity_source,pid,closed_at FROM runtime_process_registry ORDER BY id').all(),
    messages: db.prepare("SELECT id,author_id,status,body_json FROM messages WHERE author_type='agent' ORDER BY rowid").all()
      .map(({ body_json, ...row }) => ({ ...row, body: JSON.parse(body_json) })),
    events: db.prepare("SELECT seq,event_id,kind,turn_id,payload_json FROM domain_events WHERE kind IN ('turn.outputInvalid','task.repairConsumed','thread.replyAdded') ORDER BY seq").all()
      .map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) })),
    recovery: db.prepare("SELECT value FROM daemon_state WHERE key LIKE 'automatic-recovery:%'").all().map(row => JSON.parse(row.value))
      .map(job => ({ state: job.state, taskId: job.taskId, sourceTurnId: job.sourceTurnId, kind: job.kind })),
  };
}
function hasPending(snapshot) {
  return snapshot.calls.some(call => call.status === 'inflight') || snapshot.outbox.some(item => ['pending', 'leased'].includes(item.status))
    || snapshot.recovery.some(job => ['waiting', 'queued', 'running'].includes(job.state))
    || snapshot.turns.some(turn => turn.protection_state === 'retained') || snapshot.processes.some(row => row.closed_at == null);
}
function stableFacts({ tasks, turns, calls, repairs, outbox, messages, events }) {
  return { tasks, turns, calls, repairs, outbox, messages, events };
}
async function waitUntil(daemon, deadline, result, save, predicate) {
  let last = '', nextSave = 0;
  while (Date.now() < deadline) {
    const snapshot = facts(daemon.db);
    assert.ok(snapshot.calls.length <= result.cap, 'Scenario reservation cap exceeded; no rerun');
    assert.ok(!snapshot.turns.some(turn => turn.status === 'UNKNOWN'), 'UNKNOWN outcome; preserve evidence, no rerun');
    if (predicate(snapshot)) return;
    const state = JSON.stringify({ tasks: snapshot.tasks.map(row => row.status), turns: snapshot.turns.map(row => row.status), reservations: snapshot.calls.length });
    if (state !== last) { console.log(JSON.stringify({ stage: result.name, progress: JSON.parse(state) })); last = state; }
    if (Date.now() >= nextSave) { result.lastObserved = snapshot; await save(); nextSave = Date.now() + 2000; }
    if (snapshot.turns.length && snapshot.turns.every(terminal) && !hasPending(snapshot)
      && snapshot.tasks.some(task => task.status !== 'DONE')) throw Error('Formal work settled unsuccessfully; no automatic repeat');
    await delay(200);
  }
  throw Error('Formal scenario deadline exceeded; evidence preserved, no automatic rerun');
}

function checkAcceptance(name, result, model) {
  const snapshot = result.facts, fixtureIds = new Set(result.fixtureTurns.map(turn => turn.turnId));
  const calls = snapshot.calls.filter(call => !fixtureIds.has(call.turn_id));
  result.modelTurns = calls.length;
  assert.equal(calls.length, 1); assert.equal(result.actualRequests.length, 1);
  assert.equal(snapshot.calls.length, result.cap); assert.equal(snapshot.turns.length, result.cap);
  assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.tasks[0].status, 'DONE');
  assert.equal(snapshot.tasks[0].id, result.submitted.taskId); assert.equal(snapshot.tasks[0].owner_member_id, result.memberId);
  const call = calls[0], request = result.actualRequests[0], turn = snapshot.turns.find(row => row.id === call.turn_id);
  assert.equal(call.runtime_kind, 'pi'); assert.equal(call.model, model); assert.equal(call.status, 'succeeded');
  assert.equal(call.response_model, model, 'Response must report the selected installed Pi model');
  assert.equal(call.turn_id, request.turnId); assert.equal(call.member_id, result.memberId); assert.equal(call.task_id, result.submitted.taskId);
  assert.equal(call.run_id, turn.run_id); assert.equal(turn.member_id, call.member_id); assert.equal(turn.task_id, call.task_id); assert.equal(turn.status, 'SUCCEEDED');
  assert.equal(result.formalTask.activeRun.id, call.run_id);
  const process = snapshot.processes.find(row => row.turn_id === call.turn_id);
  assert.equal(process?.identity_source, 'managed-job'); assert.equal(process.adapter_kind, 'pi'); assert.equal(process.process_model, 'per-turn');
  assert.equal(process.run_id, call.run_id); assert.equal(process.member_id, call.member_id); assert.ok(process.pid > 0 && process.closed_at != null);
  assert.ok(result.exitProofs.some(proof => proof.turnId === call.turn_id && proof.exitConfirmed && proof.exitCode === 0), 'Missing confirmed Pi exit code 0');
  assert.equal(result.launches.length, 1); assert.equal(result.completed.length, 1); assert.equal(result.toolEvents.length, 0);
  const completed = result.completed[0];
  assert.equal(completed.turnId, call.turn_id); assert.equal(completed.resultKey, request.resultKey); assert.equal(completed.validSchema, true);
  const replies = snapshot.events.filter(event => event.kind === 'thread.replyAdded' && event.turn_id === call.turn_id);
  assert.equal(replies.length, 1, 'Real Pi turn must publish exactly one reply'); result.finalMessageId = replies[0].payload.messageId;
  const message = snapshot.messages.find(row => row.id === result.finalMessageId);
  assert.equal(message?.author_id, result.memberId); assert.notEqual(message.status, 'invalid'); assert.ok(message.body.text.includes(result.marker));
  const visible = snapshot.messages.filter(row => row.status !== 'invalid' && String(row.body.text ?? '').trim());
  const fixtureMessages = new Set(snapshot.events.filter(event => fixtureIds.has(event.turn_id)).map(event => event.payload.messageId));
  assert.equal(visible.filter(row => !fixtureMessages.has(row.id)).length, 1, 'Duplicate/unattributed visible Pi reply');
  const control = JSON.parse(message.body.runtimeControlResult);
  assert.equal(control.resultKey, request.resultKey, 'Persisted accepted resultKey differs from the real terminal');
  if (name === 'greeting') {
    assert.equal(snapshot.repairs.length, 0); assert.equal(result.fixtureTurns.length, 0); assert.equal(request.repairOnly, false);
    assert.equal(request.resultKey, `result_${call.turn_id}`);
    assert.equal(snapshot.events.filter(event => event.kind === 'turn.outputInvalid').length, 0);
  } else {
    assert.equal(snapshot.repairs.length, 1);
    const repair = snapshot.repairs[0], source = result.fixtureTurns[0];
    assert.equal(repair.task_id, call.task_id); assert.equal(repair.source_turn_id, source.turnId);
    assert.equal(repair.source_result_key, source.resultKey); assert.equal(repair.source_result_key, `result_${source.turnId}`);
    assert.equal(repair.logical_output_id, source.turnId); assert.equal(repair.source_output_hash, sha(result.fixtureText));
    const invalid = snapshot.events.filter(event => event.kind === 'turn.outputInvalid');
    assert.equal(invalid.length, 1); assert.equal(invalid[0].turn_id, source.turnId);
    assert.equal(repair.invalid_event_id, invalid[0].event_id);
    assert.ok(invalid[0].payload.issues.some(issue => issue.includes('finalText 不是 JSON')), 'Fixture did not reproduce the original non-JSON failure');
    const consumed = snapshot.events.filter(event => event.kind === 'task.repairConsumed');
    assert.equal(consumed.length, 1); assert.equal(consumed[0].turn_id, repair.consumed_turn_id);
    assert.equal(consumed[0].payload.resultKey, source.resultKey); assert.equal(consumed[0].payload.workitemId, repair.id);
    assert.equal(snapshot.turns.find(row => row.id === source.turnId).status, 'FAILED');
    if (name === 'repair') {
      assert.equal(result.fixtureTurns.length, 1); assert.equal(request.repairOnly, true); assert.equal(turn.turn_purpose, 'format_repair');
      assert.equal(repair.consumed_turn_id, call.turn_id); assert.equal(request.resultKey, repair.source_result_key);
      assert.equal(result.launches[0].toolFree, true); assert.equal(result.launches[0].freshSession, true);
    } else {
      assert.equal(result.fixtureTurns.length, 2); assert.equal(result.fixtureTurns[1].kind, 'unsupported-repair');
      assert.equal(snapshot.turns.find(row => row.id === result.fixtureTurns[1].turnId).status, 'FAILED');
      assert.equal(repair.consumed_turn_id, result.fixtureTurns[1].turnId); assert.equal(repair.id, result.beforeContinuation.repairs[0].id);
      assert.equal(request.repairOnly, false); assert.notEqual(turn.turn_purpose, 'format_repair');
      assert.equal(request.resultKey, `result_${call.turn_id}`); assert.notEqual(request.resultKey, repair.source_result_key);
      assert.equal(result.redispatch.formatRepair, false);
    }
  }
}

async function piFactory({ name, real, result, report, model, bridge }) {
  const { PiAdapter } = await import('../src/adapter/pi/adapter.ts');
  const { FakeRuntimeAdapter } = await import('../src/adapter/fake/runtimeAdapter.ts');
  const { taskCompleteSchema } = await import('../src/contracts/taskComplete.ts');
  let remaining = name === 'continuation' ? 2 : name === 'repair' ? 1 : 0;
  result.fixtureText = `你好，已收到隔离验证消息 ${result.marker}。`;
  return binding => {
    let launching;
    const adapter = new PiAdapter({ cwd: result.workspace, sessionDir: result.piSessionDir,
      executable: binding.executable ?? undefined, model, effort: binding.effort ?? undefined,
      permissionMode: binding.permissionMode ?? undefined, installationId: binding.installationId ?? undefined,
      spawnFn: (command, argv, cwd, env) => {
        assert.ok(real && launching, 'Prepare-only/runtime launch without a bounded real request');
        const at = argv.indexOf('--session-dir'); assert.equal(argv[at + 1], result.piSessionDir, 'Pi session files escaped isolation');
        const systemAt = argv.includes('--system-prompt') ? argv.indexOf('--system-prompt') : argv.indexOf('--append-system-prompt');
        assert.ok(systemAt >= 0, 'Pi schema missing from system instructions');
        const system = readFileSync(argv[systemAt + 1], 'utf8');
        assert.ok(system.includes(launching.resultKey), 'System instructions omit exact resultKey');
        assert.ok(system.includes(JSON.stringify(launching.schema)) || system.includes(JSON.stringify(launching.schema, null, 2)), 'System instructions omit complete outputSchema');
        const toolFree = ['--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve'].every(flag => argv.includes(flag))
          && argv[argv.indexOf('--exclude-tools') + 1] === '*';
        const freshSession = !result.sessions.find(session => session.id === launching.sessionId)?.forwardedResume
          && !argv.includes('--continue') && !argv.includes('--resume') && !argv.includes('--session');
        if (launching.repairOnly) {
          assert.ok(toolFree, 'Repair lacks official tool-disabling flags'); assert.ok(freshSession, 'Repair resumed a provider session');
          assert.ok(argv.includes('--system-prompt'), 'Repair must replace the ordinary system prompt');
          assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], '', 'Repair inherited ordinary appended instructions');
        }
        result.launches.push({ turnId: launching.turnId, toolFree, freshSession, systemSchemaVerified: true, systemSha256: sha(system) });
        return bridge.spawnManagedBridge(command, argv, { cwd, ...(env ? { env } : {}) });
      } });
    const fake = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => result.fixtureTurns.length === 1
      ? [{ kind: 'event', event: { kind: 'turn.completed', finalText: result.fixtureText } }]
      : [{ kind: 'event', event: { kind: 'turn.failed', code: 'CAPABILITY_UNSUPPORTED', message: 'R139 fixture: old Pi rejected repairOnly', retryable: false } }] });
    const sessions = new Map();
    const delegate = session => { const selected = sessions.get(session.id); assert.ok(selected, 'Lost session identity'); return selected; };
    return new Proxy(adapter, { get(target, property) {
      if (property === 'openSession') return async input => {
        const selected = remaining > 0 ? fake : adapter;
        // Synthetic provider IDs are never passed to installed Pi as resume IDs.
        const { resume, ...fresh } = input;
        const forwardedResume = Boolean(resume && sessions.get(resume.id) === selected);
        const session = await selected.openSession(forwardedResume ? input : fresh);
        sessions.set(session.id, selected);
        result.sessions.push({ id: session.id, fixture: selected === fake, forwardedResume }); return session;
      };
      if (property === 'startTurn') return async (session, input) => {
        assert.ok(real, 'Prepare-only MUST NOT start any turn, including fixtures');
        const selected = delegate(session);
        if (selected === fake) {
          assert.ok(remaining > 0); remaining--;
          result.fixtureTurns.push({ turnId: input.turnId, resultKey: input.resultKey, repairOnly: input.repairOnly === true,
            kind: result.fixtureTurns.length === 0 ? 'plain-output' : 'unsupported-repair' });
        } else {
          assert.equal(result.actualRequests.length, 0, 'One real attempt per scenario; automatic repeat blocked');
          assert.ok(report.realAttempts < report.maxRealAttempts, 'Real attempt cap reached'); report.realAttempts++;
          assert.ok(input.outputSchema && input.resultKey, 'Worker must supply schema and resultKey');
          const request = { turnId: input.turnId, sessionId: session.id, resultKey: input.resultKey, repairOnly: input.repairOnly === true };
          result.actualRequests.push(request); launching = { ...request, schema: input.outputSchema };
        }
        try { return await selected.startTurn(session, input); } finally { launching = undefined; }
      };
      if (property === 'events') return async function* (session) {
        for await (const event of delegate(session).events(session)) {
          if (delegate(session) === adapter) {
            if (['tool.started', 'tool.completed'].includes(event.kind)) result.toolEvents.push({ kind: event.kind, turnId: event.turnId });
            if (event.kind === 'turn.completed') {
              // Observe malformed output without intercepting worker acceptance.
              let value;
              try { value = JSON.parse(event.finalText); } catch { value = null; }
              const parsed = taskCompleteSchema.safeParse(value);
              result.completed.push({ turnId: event.turnId, resultKey: parsed.success ? parsed.data.resultKey : null, validSchema: parsed.success,
                finalTextSha256: sha(event.finalText) });
            }
          }
          yield event;
        }
      };
      if (property === 'waitForTurnExit') return async (session, turnId, ms) => {
        if (delegate(session) === fake) return { exitConfirmed: true, exitCode: 0 };
        const proof = await adapter.waitForTurnExit(session, turnId, ms);
        if (proof) result.exitProofs.push(proof); return proof;
      };
      if (['processIdentity', 'interrupt', 'close', 'lateEvents', 'steer'].includes(property)) return (session, ...rest) => delegate(session)[property](session, ...rest);
      if (property === 'disposeAll') return async () => { await fake.closeAllSessions(); return adapter.disposeAll(); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
}

async function connectIpc(daemon) {
  const socket = createConnection(daemon.pipeName); socket.setEncoding('utf8');
  let buffer = '', readyResolve, readyReject;
  const pending = new Map(), ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
  const fail = error => { readyReject(error); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear(); };
  socket.on('error', () => fail(Error('Isolated daemon IPC transport failed')));
  socket.on('close', () => fail(Error('Isolated daemon IPC closed')));
  socket.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'auth.ok') { readyResolve(); continue; }
        const waiter = pending.get(frame.commandId); if (!waiter) continue;
        pending.delete(frame.commandId); clearTimeout(waiter.timer);
        if (frame.ok) waiter.accept(frame.data); else waiter.reject(Error(`IPC ${waiter.method}: ${redact(frame.error?.code)} ${redact(frame.error?.message)}`));
      } catch { fail(Error('Invalid isolated daemon IPC response')); }
    }
  });
  socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', token: daemon.credential.token })}\n`));
  const timer = setTimeout(() => { fail(Error('Isolated daemon handshake deadline')); socket.destroy(); }, 10000);
  try { await ready; } finally { clearTimeout(timer); }
  return {
    command(method, params, commandId = randomUUID()) {
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => { pending.delete(commandId); reject(Error(`IPC ${method} deadline; do not resubmit`)); }, 30000);
        pending.set(commandId, { accept, reject, timer, method });
        socket.write(`${JSON.stringify({ protocolVersion: 1, commandId, method, params })}\n`);
      });
    }, close() { socket.destroy(); },
  };
}

if (args.has('--help') || (!args.has('--prepare-only') && !args.has('--run-real'))) console.log(help);
else await main();
