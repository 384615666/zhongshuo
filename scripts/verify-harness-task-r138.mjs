/**
 * R138 installed-runtime acceptance through authenticated daemon IPC + its worker.
 * No live appData, adapter-only acceptance, package installation, or automatic rerun.
 *
 * node scripts/verify-harness-task-r138.mjs --prepare-only
 * After rebuilding/installing the 0.1.2+ connection component in its own profile:
 * node scripts/verify-harness-task-r138.mjs --run-real --plugin-ready
 * Optional, explicitly synthetic failures followed by REAL worker-driven DSH:
 *   --force-format-repair --force-consumed-repair-continuation
 * Select one independently with --scenario greeting|handoff|repair|continuation.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `R138 formal daemon/worker acceptance (Windows, installed DSH + Pi).
  --prepare-only         Fresh temporary appData/workspaces + IPC setup; zero inference.
  --run-real --plugin-ready
                         Run greeting and Pi -> DSH handoff after plugin installation.
  --scenario NAME        greeting, handoff, repair, or continuation (one fresh scenario).
  --force-format-repair  Also inject one plain fixture result, then REAL DSH repair.
  --force-consumed-repair-continuation
                         Also inject a consumed unsupported repair, then REAL ordinary
                         task.redispatch. These injected failures are NOT model calls.
  --dsh-model ID --pi-model ID --dsh-effort LEVEL --pi-effort LEVEL
                         Optional; otherwise use installed runtime defaults.
  --timeout-ms N         Per-scenario deadline, default 180000; no retry on timeout.
  --evidence-dir PATH    Report destination (default dist/r138-formal/<unique run>).
  --audit-report PATH
                         Offline semantic audit of a saved real report and two
                         read-only snapshots of its isolated DB. No daemon starts,
                         no command replay, no inference; NOT IPC replay proof.
Real-call journal and all application data stay below a newly created OS temp root.
Installed CLI configuration is reused; credentials/raw transport logs are never printed.
The ledger cap counts formal worker startTurn reservations, including explicitly
identified fixture turns. Format repair runs as a separate tool-free worker turn.
`;
const valueOptions = new Set(['--scenario', '--dsh-model', '--pi-model', '--dsh-effort', '--pi-effort', '--timeout-ms', '--evidence-dir', '--audit-report']);
const flagOptions = new Set(['--help', '--prepare-only', '--run-real', '--plugin-ready', '--force-format-repair', '--force-consumed-repair-continuation']);
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  assert.ok(valueOptions.has(name) || flagOptions.has(name), `Unknown option: ${name}`);
  assert.ok(!args.has(name), `Repeated option: ${name}`);
  if (valueOptions.has(name)) {
    const value = process.argv[++index];
    assert.ok(value && !value.startsWith('--'), `Missing value for ${name}`);
    args.set(name, value);
  } else args.set(name, true);
}
function redact(value) {
  return String(value).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|password|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/g, '[endpoint-redacted]');
}
const sha = value => createHash('sha256').update(value).digest('hex');
const goodTask = row => ['DONE', 'REVIEW'].includes(row.status);
const terminalTurn = row => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(row.status);

async function main() {
  assert.equal(process.platform, 'win32', 'This acceptance uses the installed Windows runtimes and managed jobs');
  const real = args.has('--run-real');
  assert.ok(!(real && args.has('--prepare-only')), 'Choose --prepare-only or --run-real');
  assert.ok(!real || args.has('--plugin-ready'), 'Build/install the fixed component first, then pass --plugin-ready');
  const timeoutMs = Number(args.get('--timeout-ms') ?? 180000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10000 && timeoutMs <= 600000, 'Invalid timeout');
  const selected = args.get('--scenario');
  assert.ok(!selected || ['greeting', 'handoff', 'repair', 'continuation'].includes(selected), 'Invalid scenario');
  const scenarios = selected ? [selected] : ['greeting', 'handoff',
    ...(args.has('--force-format-repair') ? ['repair'] : []),
    ...(args.has('--force-consumed-repair-continuation') ? ['continuation'] : [])];
  const caps = { greeting: 2, handoff: 4, repair: 2, continuation: 3 };
  const cap = scenarios.reduce((sum, name) => sum + caps[name], 0);
  const runId = `r138-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tempRoot = await mkdtemp(join(tmpdir(), 'zs-r138-formal-'));
  const evidenceDir = resolve(args.get('--evidence-dir') ?? join(sourceRoot, 'dist/r138-formal', runId));
  await mkdir(evidenceDir, { recursive: true });
  // An exclusive intent record prevents an existing evidence directory being reused.
  await writeFile(join(evidenceDir, 'authorization.json'), JSON.stringify({ runId, real, scenarios, cap, tempRoot,
    boundary: 'worker -> RuntimeAdapter.startTurn; fixture reservations separately identified', at: new Date().toISOString() }, null, 2), { flag: 'wx' });
  const report = { runId, mode: real ? 'real' : 'prepare-only', sourceHead: await sourceHead(), tempRoot, evidenceDir,
    cap, expectedModelTurns: scenarios.reduce((sum, name) => sum + (name === 'handoff' ? 3 : 1), 0),
    status: 'running', scenarios: [], plugin: null };
  const save = () => writeFile(join(evidenceDir, 'report.json'), redact(JSON.stringify(report, null, 2)));
  // Override only this verifier process. Never repoint HOME/CODEX_HOME or a live DB.
  Object.assign(process.env, { ZS_MANAGED_RUNTIME: '1', ZS_RUNTIME: 'deepseek-harness', ZS_DEFAULT_MEMBER_DISCOVERY: '0',
    ZS_REMINDER_DISABLED: '1', ZS_REAL_BATCH_ID: runId, ZS_REAL_BATCH_CAP: String(cap),
    ZS_REAL_BATCH_DIR: join(tempRoot, 'call-journal'), ZS_TURN_DEADLINE_MS: String(timeoutMs) });
  for (const key of ['ZS_REAL_BATCH_RUNTIME', 'ZS_REAL_BATCH_MODEL', 'ZS_BOOTSTRAP_AGENTS', 'ZS_DAEMON_LOG_COMMANDS', 'ZS_PACKED_ENTRY']) delete process.env[key];
  assert.notEqual(process.env.ZS_REAL_DISPATCH_GUARD, '1', 'Inherited dispatch guard is enabled; no real request attempted');
  const { startDaemon } = await import('../src/daemon/entry.ts');
  const bridge = await import('../src/daemon/managed/bridge.ts');
  try {
    assert.equal(bridge.managedBridgeAvailable().ok, true, 'Managed execution unavailable');
    // reserveSlot normally binds its new header to the first runtime/model.
    // This fresh mixed-runtime batch intentionally permits BOTH named members;
    // its fixed cap is still enforced by the unchanged production journal.
    const journalDir = process.env.ZS_REAL_BATCH_DIR;
    await mkdir(journalDir);
    const journal = await open(join(journalDir, `${runId}.jsonl`), 'wx');
    try {
      await journal.writeFile(JSON.stringify({ op: 'batch-config', batchId: runId, cap,
        runtimeKind: null, model: null, at: Date.now(), pid: process.pid }) + '\n');
      await journal.sync();
    } finally { await journal.close(); }
    // Probe is metadata only. It never submits a message or creates a model turn.
    if (real) {
      report.plugin = await installedPluginProbe(tempRoot);
      await save();
    }
    for (const name of scenarios) {
      const result = { name, status: 'running', cap: caps[name], fixtureTurns: [], actualRequests: [] };
      report.scenarios.push(result);
      await save();
      await runScenario({ name, real, tempRoot, result, timeoutMs, startDaemon, bridge, save });
      console.log(JSON.stringify({ stage: name, status: result.status, ledgerReservations: result.facts.calls.length,
        fixtureTurns: result.fixtureTurns.length, modelTurns: result.modelTurns, taskStatus: result.facts.tasks[0]?.status }));
    }
    report.status = real ? 'passed' : 'prepared';
  } catch (error) {
    report.status = 'failed'; report.error = redact(error.message); process.exitCode = 1;
  } finally {
    report.cleanup = { jobsRemaining: bridge.managedJobsCount(), pollersRemaining: bridge.managedActivePollers() };
    if (report.cleanup.jobsRemaining || report.cleanup.pollersRemaining) { report.status = 'failed'; process.exitCode = 1; }
    await save();
    console.log(JSON.stringify({ status: report.status, report: join(evidenceDir, 'report.json'), tempRoot,
      cleanup: report.cleanup, error: report.error }));
  }
}

async function sourceHead() {
  try { return (await commandOutput('git', ['rev-parse', 'HEAD'], sourceRoot)).trim(); }
  catch { return 'unavailable'; }
}
function commandOutput(command, argv, cwd, env) {
  return new Promise((accept, reject) => execFile(command, argv, { cwd, env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(Error(`Local metadata command failed (${error.code ?? 'unknown'})`)) : accept(stdout)));
}
async function installedPluginProbe(cwd) {
  const { resolveAgentExecutable } = await import('../src/adapter/cli/executable.ts');
  const entry = resolveAgentExecutable('deepseek-harness', process.env.ZS_DSH_EXECUTABLE ?? 'dsh');
  const frame = JSON.parse((await commandOutput(entry.command, [...entry.prefixArgs, '--profile', 'zhongshuo', '--zs-probe'], cwd,
    entry.env ? { ...process.env, ...entry.env } : undefined)).trim());
  assert.equal(frame.runtime, 'zhongshuo-dsh'); assert.equal(frame.protocol, 1);
  const version = /^0\.(\d+)\.(\d+)(?:$|[-+])/.exec(frame.pluginVersion ?? '');
  assert.ok(version && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 2), 'Install component 0.1.2+ first');
  assert.equal(frame.capabilities?.outputSchema, true, 'Installed component lacks outputSchema');
  assert.equal(frame.capabilities?.formatRepair, true, 'Installed component lacks safe formatRepair');
  return { pluginVersion: frame.pluginVersion, protocol: frame.protocol, outputSchema: true, formatRepair: true };
}

async function runScenario({ name, real, tempRoot, result, timeoutMs, startDaemon, bridge, save }) {
  const scenarioRoot = await mkdtemp(join(tempRoot, `${name}-`));
  const appDataDir = join(scenarioRoot, 'appData'), workspace = join(scenarioRoot, 'workspace');
  await mkdir(appDataDir); await mkdir(workspace);
  const marker = `R138_${name.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
  await writeFile(join(workspace, 'marker.txt'), marker + '\n', { flag: 'wx' });
  result.appDataDir = appDataDir; result.workspace = workspace; result.marker = marker;
  const fixture = ['repair', 'continuation'].includes(name) && real;
  let daemon, ipc;
  try {
    daemon = await startDaemon({ appDataDir, runtime: 'deepseek-harness', localUserId: 'r138-isolated',
      pipeName: `zs-${randomUUID()}`, tickMs: 100, drainSettleTimeoutMs: 10000,
      ...(fixture ? { testAdapterFactories: { 'deepseek-harness': await forcedFactory(name, workspace, marker, result, bridge) } } : {}) });
    assert.equal(daemon.db.prepare('SELECT count(*) n FROM tasks').get().n, 0, 'AppData must start empty');
    ipc = await connectIpc(daemon);
    const projectId = (await ipc.command('project.open', { path: workspace, agentNames: name === 'handoff' ? ['R138 Pi', 'R138 DSH'] : ['R138 DSH'] })).project.id;
    const members = (await ipc.command('member.list', { projectId })).items;
    assert.equal(members.length, name === 'handoff' ? 2 : 1, 'Only the intended agents may exist');
    const dsh = members.find(member => member.displayName === 'R138 DSH').id;
    const pi = members.find(member => member.displayName === 'R138 Pi')?.id;
    for (const [memberId, kind, prefix] of [[dsh, 'deepseek-harness', 'dsh'], ...(pi ? [[pi, 'pi', 'pi']] : [])]) {
      await ipc.command('member.setRuntime', { memberId, kind, permissionMode: 'bypassPermissions',
        executable: prefix === 'dsh' ? process.env.ZS_DSH_EXECUTABLE ?? 'dsh' : process.env.ZS_PI_EXECUTABLE ?? 'pi',
        ...(args.has(`--${prefix}-model`) ? { model: args.get(`--${prefix}-model`) } : {}),
        ...(args.has(`--${prefix}-effort`) ? { effort: args.get(`--${prefix}-effort`) } : {}) });
    }
    const room = (await ipc.command('room.list', { projectId })).items[0];
    await ipc.command('room.update', { roomId: room.id, expectedRevision: room.revision, coordinatorMemberId: pi ?? dsh });
    assert.deepEqual((await ipc.command('member.list', { projectId, roomId: room.id })).items.map(member => member.id).sort(), members.map(member => member.id).sort());
    result.members = { dsh, ...(pi ? { pi } : {}) };
    const target = { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId };
    const common = '这是隔离的接入验证，不是真实业务。只使用当前消息材料，不读文件，不使用任何工具、不改文件，不调用外部服务。按正式结果协议提交真实结论，不要声称做过工具验证。';
    const body = name === 'handoff'
      ? `${common}\nPi：请在本轮最终结果的 handoffs 中，只向成员 R138 DSH（${dsh}）发送一次 purpose=ask 的正式交接，message 内容为“请只回复一句：DSH 已收到 ${marker}_DSH。不要使用工具，不再向任何人交接”。本轮 answer 请只说“已向 DSH 交接 ${marker}_PI”。coordinationPlan 不要填写。待 DSH 真正回复后，你再汇总；汇总 answer 只说“Pi 已收到 DSH 的回复 ${marker}_FINAL”，不要重复先前答复，不再次交接。只允许这两位成员参与。`
      : `${common}\n请用一句简短中文问候我，包含标记 ${marker}。无需协作或同伴交接。`;
    const params = { target, body, intent: real ? 'default' : 'record_only', mentions: [{ kind: 'member', memberId: pi ?? dsh }] };
    const commandId = randomUUID();
    const sent = await ipc.command('message.submit', params, commandId);
    result.submitted = sent; result.commandId = commandId;
    if (!real) {
      assert.equal(sent.taskId, null);
      result.facts = facts(daemon.db); assert.equal(result.facts.calls.length, 0);
      result.modelTurns = 0; result.status = 'prepared';
    } else {
      assert.ok(sent.taskId && sent.threadId, 'Formal submission did not create a task');
      if (name === 'continuation') {
        await waitUntil(daemon, timeoutMs, result, save, snapshot => snapshot.turns.length === 2 && snapshot.turns.every(terminalTurn)
          && snapshot.turns.at(-1).status === 'FAILED' && snapshot.repairs[0]?.consumed_turn_id === snapshot.turns.at(-1).id && !hasPending(snapshot));
        const old = facts(daemon.db); result.beforeContinuation = old;
        assert.ok(['ACTIVE', 'BLOCKED'].includes(old.tasks[0].status), 'Unsupported repair must remain unfinished before explicit continuation');
        const state = await ipc.command('task.get', { taskId: sent.taskId });
        result.redispatch = await ipc.command('task.redispatch', { taskId: sent.taskId, sourceRunId: state.activeRun.id,
          expectedTaskRevision: state.task.revision, expectedStopGeneration: state.task.stopGeneration,
          expectedRunStatus: state.activeRun.status, reason: 'R138 explicit ordinary continuation after unsupported repair was consumed' });
        assert.equal(result.redispatch.formatRepair, false);
      }
      await waitUntil(daemon, timeoutMs, result, save, snapshot => snapshot.tasks.length > 0 && snapshot.tasks.every(goodTask)
        && snapshot.turns.length > 0 && snapshot.turns.every(terminalTurn) && !hasPending(snapshot));
      result.facts = facts(daemon.db);
      const task = await ipc.command('task.get', { taskId: sent.taskId });
      assert.ok(goodTask(task.task), `Formal task.get has unsuccessful status ${task.task.status}`);
      result.formalTask = { task: task.task, activeRun: task.activeRun };
      const history = await ipc.command('thread.history', { threadId: sent.threadId, limit: 100 });
      result.messages = history.items.filter(item => item.authorType === 'agent' || item.author?.type === 'agent')
        .map(item => ({ id: item.id, text: item.body?.text ?? '' }));
      checkAcceptance(name, result, dsh, pi);
      // Replay the SAME accepted command, then allow several real daemon ticks.
      // This cannot authorize a second task or model turn.
      const stable = stableFacts(result.facts);
      const replay = await ipc.command('message.submit', params, commandId);
      assert.equal(replay.taskId, sent.taskId); assert.equal(replay.messageId, sent.messageId);
      await delay(1500);
      assert.deepEqual(stableFacts(facts(daemon.db)), stable, 'Duplicate reply, task, dispatch, or model call appeared after settling/replay');
      result.idempotentReplay = true;
      assert.equal(await readFile(join(workspace, 'marker.txt'), 'utf8'), marker + '\n', 'Fixture marker was modified');
      result.status = 'passed';
    }
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
      assert.deepEqual(result.cleanup, { jobsRemaining: 0, pollersRemaining: 0 }, 'Managed jobs or pollers leaked');
    }
    await save();
  }
}

function facts(db) {
  return {
    tasks: db.prepare('SELECT id,parent_task_id,owner_member_id,status,current_delivery_id FROM tasks ORDER BY rowid').all(),
    turns: db.prepare(`SELECT a.id,r.task_id,a.run_id,a.member_id,a.status,a.turn_purpose,a.protection_state FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id ORDER BY a.rowid`).all(),
    calls: db.prepare('SELECT id,runtime_kind,model,response_model,member_id,task_id,run_id,turn_id,status FROM real_calls ORDER BY id').all(),
    coordinations: db.prepare('SELECT run_id,task_id,state,integration_run_id FROM coordination_runs ORDER BY rowid').all(),
    handoffs: db.prepare('SELECT id,source_member_id,target_member_id,purpose,child_task_id,source_turn_id,target_turn_id,status FROM coordination_messages ORDER BY rowid').all(),
    repairs: db.prepare('SELECT id,task_id,source_turn_id,source_result_key,logical_output_id,invalid_event_id,source_output_hash,consumed_turn_id,status FROM format_repair_workitems ORDER BY rowid').all(),
    outbox: db.prepare('SELECT dispatch_key,status,turn_id FROM outbox ORDER BY id').all(),
    processes: db.prepare('SELECT turn_id,adapter_kind,process_model,identity_source,pid,closed_at FROM runtime_process_registry ORDER BY id').all(),
    messages: db.prepare("SELECT id,author_id,status,body_json FROM messages WHERE author_type='agent' ORDER BY rowid").all()
      .map(({ body_json, ...row }) => ({ ...row, text: JSON.parse(body_json).text ?? '' })),
    events: db.prepare(`SELECT seq,kind,turn_id,payload_json FROM domain_events WHERE kind IN ('turn.outputInvalid','task.repairConsumed','coordination.integrationQueued','member.messageAccepted','thread.replyAdded','recovery.protectionReleased') ORDER BY seq`).all()
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
function stableFacts(snapshot) {
  return { tasks: snapshot.tasks, turns: snapshot.turns, calls: snapshot.calls, handoffs: snapshot.handoffs,
    repairs: snapshot.repairs, messages: snapshot.messages, outbox: snapshot.outbox };
}
async function waitUntil(daemon, timeoutMs, result, save, predicate) {
  const end = Date.now() + timeoutMs; let last = '', nextSave = 0;
  while (Date.now() < end) {
    const snapshot = facts(daemon.db);
    assert.ok(snapshot.calls.length <= result.cap, `Scenario exceeded ${result.cap} ledger reservations; no rerun permitted`);
    if (predicate(snapshot)) return;
    assert.ok(!snapshot.turns.some(turn => turn.status === 'UNKNOWN'), 'Formal turn became UNKNOWN; stop without rerun');
    const state = JSON.stringify({ tasks: snapshot.tasks.map(task => task.status), turns: snapshot.turns.map(turn => turn.status), calls: snapshot.calls.length });
    if (state !== last) { console.log(JSON.stringify({ stage: result.name, progress: JSON.parse(state) })); last = state; }
    if (Date.now() >= nextSave) { result.lastObserved = snapshot; await save(); nextSave = Date.now() + 2000; }
    // Once all work has stopped unsuccessfully, fail immediately; an ACTIVE parent
    // cannot hide its failed handoff child until the deadline.
    if (snapshot.turns.length && snapshot.turns.every(terminalTurn) && !hasPending(snapshot)
      && snapshot.tasks.some(task => !goodTask(task))) throw Error('Formal work settled unsuccessfully; inspect report, do not automatically repeat');
    await delay(200);
  }
  throw Error('Formal task deadline exceeded; task/worker evidence preserved, no automatic rerun');
}

function checkAcceptance(name, result, dsh, pi) {
  const snapshot = result.facts;
  const fixtureIds = new Set(result.fixtureTurns.map(turn => turn.turnId));
  const realCalls = snapshot.calls.filter(call => !fixtureIds.has(call.turn_id));
  result.modelTurns = realCalls.length;
  assert.ok(realCalls.length > 0, 'No actual model turn was submitted');
  assert.ok(realCalls.every(call => call.status === 'succeeded'), 'Actual installed-runtime call did not succeed');
  assert.ok(realCalls.every(call => call.task_id && call.run_id && call.member_id && call.turn_id), 'Missing formal call attribution');
  assert.ok(snapshot.turns.filter(turn => !fixtureIds.has(turn.id)).every(turn => turn.status === 'SUCCEEDED'));
  for (const call of realCalls) {
    const process = snapshot.processes.find(row => row.turn_id === call.turn_id);
    assert.equal(process?.identity_source, 'managed-job', 'Real runtime did not run in a managed job');
    assert.ok(process.closed_at != null, 'Runtime process exit has not been confirmed');
  }
  // A source turn may publish its answer AND an accepted addressed handoff.
  // Exempt only exact message IDs backed by formal coordination identities.
  const fixtureMessageIds = new Set(snapshot.events.filter(event => event.kind === 'thread.replyAdded' && fixtureIds.has(event.turn_id)).map(event => event.payload.messageId));
  const visibleReplies = snapshot.messages.filter(row => row.status !== 'invalid' && !fixtureMessageIds.has(row.id) && row.text.trim());
  const handoffMessageIds = new Set();
  for (const handoff of snapshot.handoffs) {
    const accepted = snapshot.events.filter(event => event.kind === 'member.messageAccepted' && event.turn_id === handoff.source_turn_id
      && event.payload.messageId === handoff.id && event.payload.sourceMemberId === handoff.source_member_id
      && event.payload.targetMemberId === handoff.target_member_id && event.payload.childTaskId === handoff.child_task_id);
    assert.equal(accepted.length, 1, 'Addressed handoff lacks one matching formal acceptance event');
    const messageId = `msg_${handoff.source_turn_id}_${handoff.id}`;
    const messages = visibleReplies.filter(reply => reply.id === messageId && reply.author_id === handoff.source_member_id);
    assert.equal(messages.length, 1, 'Addressed handoff lacks one matching source-authored message');
    assert.equal(snapshot.events.filter(event => event.kind === 'thread.replyAdded' && event.turn_id === handoff.source_turn_id
      && event.payload.messageId === messageId).length, 1, 'Addressed handoff was inserted more than once');
    handoffMessageIds.add(messageId);
  }
  const userAnswers = visibleReplies.filter(reply => !handoffMessageIds.has(reply.id));
  result.replyCounts = { userAnswers: userAnswers.length, addressedHandoffs: handoffMessageIds.size };
  const seen = new Set();
  for (const message of visibleReplies) {
    const text = message.text.trim();
    const key = `${message.author_id}:${sha(text)}`;
    assert.ok(!seen.has(key), 'Duplicate visible reply by the same author'); seen.add(key);
  }
  for (const call of realCalls) {
    const replies = snapshot.events.filter(event => event.kind === 'thread.replyAdded' && event.turn_id === call.turn_id
      && !handoffMessageIds.has(event.payload.messageId));
    assert.ok(new Set(replies.map(event => event.payload.messageId)).size <= 1, 'One actual turn produced duplicate visible replies');
  }
  const containsOnce = (memberId, marker) => assert.equal(userAnswers.filter(message => message.author_id === memberId && message.text.includes(marker)).length, 1, `Expected one visible reply for ${marker}`);
  if (name === 'handoff') {
    assert.equal(snapshot.tasks.length, 2, 'Expected one formal parent and one DSH child');
    assert.equal(snapshot.tasks[0].owner_member_id, pi);
    assert.equal(snapshot.tasks[1].parent_task_id, snapshot.tasks[0].id);
    assert.equal(snapshot.tasks[1].owner_member_id, dsh);
    assert.equal(snapshot.handoffs.length, 1, 'Handoff was missing or duplicated');
    assert.equal(snapshot.handoffs[0].source_member_id, pi); assert.equal(snapshot.handoffs[0].target_member_id, dsh);
    assert.equal(snapshot.handoffs[0].child_task_id, snapshot.tasks[1].id); assert.equal(snapshot.handoffs[0].status, 'completed');
    assert.equal(snapshot.coordinations.length, 1); assert.equal(snapshot.coordinations[0].state, 'completed');
    assert.equal(snapshot.events.filter(event => event.kind === 'coordination.integrationQueued').length, 1);
    // Pi legitimately answers twice: planning/accepted handoff and integration.
    // DSH has one child reply; a whole-task per-author maximum of one is wrong.
    assert.ok(visibleReplies.every(reply => reply.author_id === pi || reply.author_id === dsh), 'Unexpected handoff reply author');
    assert.ok(userAnswers.filter(reply => reply.author_id === pi).length <= 2, 'Pi emitted more than its planning and integration replies');
    assert.ok(userAnswers.filter(reply => reply.author_id === dsh).length <= 1, 'DSH emitted duplicate child replies');
    containsOnce(pi, `${result.marker}_PI`); containsOnce(dsh, `${result.marker}_DSH`); containsOnce(pi, `${result.marker}_FINAL`);
  } else if (name === 'greeting') {
    assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.repairs.length, 0, 'Greeting required an unexpected format repair');
    containsOnce(dsh, result.marker);
  } else {
    assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.repairs.length, 1, 'Repair lineage was missing or recreated');
    const repair = snapshot.repairs[0];
    assert.equal(repair.source_turn_id, result.fixtureTurns[0].turnId);
    assert.equal(repair.logical_output_id, result.fixtureTurns[0].turnId);
    assert.equal(repair.source_output_hash, sha(result.fixtureText));
    assert.equal(snapshot.events.filter(event => event.kind === 'task.repairConsumed').length, 1);
    const request = result.actualRequests[0]; assert.equal(result.actualRequests.length, 1);
    assert.equal(snapshot.calls.filter(call => !fixtureIds.has(call.turn_id)).length, 1, 'Forced scenario made extra real requests');
    assert.ok(request.hasOutputSchema);
    if (name === 'repair') {
      assert.equal(request.repairOnly, true); assert.equal(repair.consumed_turn_id, request.turnId);
      assert.equal(snapshot.turns.find(turn => turn.id === request.turnId).turn_purpose, 'format_repair');
    } else {
      assert.equal(result.fixtureTurns.length, 2);
      assert.equal(repair.consumed_turn_id, result.fixtureTurns[1].turnId);
      assert.equal(request.repairOnly, false);
      assert.notEqual(snapshot.turns.find(turn => turn.id === request.turnId).turn_purpose, 'format_repair');
      assert.equal(snapshot.repairs[0].id, result.beforeContinuation.repairs[0].id);
    }
    const tools = result.repairToolEvents ?? [];
    assert.equal(tools.length, 0, 'Format repair emitted a business tool event');
  }
}

async function connectIpc(daemon) {
  const socket = createConnection(daemon.pipeName); socket.setEncoding('utf8');
  let buffer = '', readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
  const fail = error => { readyReject(error); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear(); };
  socket.on('error', () => fail(Error('Isolated daemon IPC transport failed')));
  socket.on('close', () => fail(Error('Isolated daemon IPC closed')));
  socket.on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
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
    },
    close() { socket.destroy(); },
  };
}

async function forcedFactory(name, cwd, marker, result, bridge) {
  const { DeepSeekHarnessAdapter } = await import('../src/adapter/deepseekHarness/adapter.ts');
  const { FakeRuntimeAdapter } = await import('../src/adapter/fake/runtimeAdapter.ts');
  let remaining = name === 'continuation' ? 2 : 1;
  const fakeText = `已收到隔离验证消息 ${marker}。`;
  result.fixtureText = fakeText;
  result.fixtureAccounting = 'Injected turns reserve normal ledger slots but issue NO provider request; exclude their turn IDs from modelTurns.';
  return binding => {
    const real = new DeepSeekHarnessAdapter({ cwd, executable: binding.executable, model: binding.model ?? process.env.ZS_DSH_MODEL,
      effort: binding.effort ?? undefined, permissionMode: binding.permissionMode ?? undefined, installationId: binding.installationId ?? undefined,
      spawnFn: (command, argv, childCwd, env) => bridge.spawnManagedBridge(command, argv, { cwd: childCwd, ...(env ? { env } : {}) }) });
    const fake = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => result.fixtureTurns.length === 1
      ? [{ kind: 'event', event: { kind: 'turn.completed', finalText: fakeText } }]
      : [{ kind: 'event', event: { kind: 'turn.failed', code: 'CAPABILITY_UNSUPPORTED', message: 'R138 fixture: installed old component did not support format repair', retryable: false } }] });
    const sessions = new Map();
    const delegate = session => { const selected = sessions.get(session.id); assert.ok(selected, 'Fixture routing lost session identity'); return selected; };
    return new Proxy(real, {
      get(target, property) {
        if (property === 'openSession') return async input => {
          const selected = remaining > 0 ? fake : real;
          // A fixture provider ID is not a DSH session and must never be resumed.
          const { resume, ...fresh } = input;
          const session = await selected.openSession(resume && sessions.get(resume.id) === selected ? input : fresh);
          sessions.set(session.id, selected); return session;
        };
        if (property === 'startTurn') return async (session, input) => {
          const selected = delegate(session);
          if (selected === fake) {
            assert.ok(remaining > 0, 'Fixture budget exhausted'); remaining--;
            result.fixtureTurns.push({ turnId: input.turnId, repairOnly: input.repairOnly === true,
              kind: result.fixtureTurns.length === 0 ? 'plain-output' : 'unsupported-repair' });
          } else {
            result.actualRequests.push({ turnId: input.turnId, repairOnly: input.repairOnly === true, hasOutputSchema: Boolean(input.outputSchema) });
          }
          return selected.startTurn(session, input);
        };
        if (property === 'events') return async function* (session) {
          for await (const event of delegate(session).events(session)) {
            if (result.actualRequests.some(request => request.turnId === event.turnId && request.repairOnly) && ['tool.started', 'tool.completed'].includes(event.kind))
              (result.repairToolEvents ??= []).push({ kind: event.kind, turnId: event.turnId });
            yield event;
          }
        };
        if (['processIdentity', 'interrupt', 'close', 'lateEvents', 'steer'].includes(property)) return (session, ...rest) => delegate(session)[property](session, ...rest);
        if (property === 'waitForTurnExit') return (session, ...rest) => delegate(session) === fake
          ? Promise.resolve({ exitConfirmed: true, exitCode: 0 }) : real.waitForTurnExit(session, ...rest);
        if (property === 'disposeAll') return async () => { await fake.closeAllSessions(); return real.disposeAll(); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

async function auditSavedReport() {
  assert.ok(!args.has('--run-real') && !args.has('--prepare-only'), 'Offline audit cannot be combined with an execution mode');
  const reportPath = resolve(args.get('--audit-report'));
  const original = await readFile(reportPath, 'utf8'), saved = JSON.parse(original);
  assert.equal(saved.mode, 'real', 'Audit requires a saved real-run report');
  assert.notEqual(saved.status, 'running', 'Wait for the original verifier to finish before its read-only audit');
  const root = await realpath(saved.tempRoot), temp = await realpath(tmpdir());
  assert.equal(dirname(root).toLowerCase(), temp.toLowerCase(), 'Audit requires an OS temporary root');
  assert.ok(basename(root).startsWith('zs-r138-formal-'), 'Audit refuses non-verifier appData');
  const { default: Database } = await import('better-sqlite3');
  const audit = { mode: 'offline-semantic-assertions', sourceReport: reportPath, sourceReportSha256: sha(original),
    verifierSha256: sha(await readFile(fileURLToPath(import.meta.url))), originalStatus: saved.status,
    status: 'running', newModelTurns: 0, daemonStarted: false, commandReplayPerformed: false, scenarios: [] };
  const output = join(dirname(reportPath), `offline-semantic-audit-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  try {
    for (const recorded of saved.scenarios.filter(item => item.facts?.tasks?.length && item.facts.tasks.every(goodTask))) {
      const databasePath = await realpath(join(recorded.appDataDir, 'state.sqlite'));
      const belowRoot = relative(root, databasePath);
      assert.ok(belowRoot && !belowRoot.startsWith('..') && !isAbsolute(belowRoot), 'Audit DB is outside the verifier temporary root');
      const recordedResult = globalThis.structuredClone(recorded);
      checkAcceptance(recorded.name, recordedResult, recorded.members.dsh, recorded.members.pi);
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        const first = db.transaction(() => facts(db))();
        await delay(300);
        const second = db.transaction(() => facts(db))();
        assert.deepEqual(stableFacts(second), stableFacts(first), 'Isolated DB changed between read-only snapshots');
        assert.deepEqual(stableFacts(first), stableFacts(recorded.facts), 'Saved report differs from the isolated DB');
        const current = { ...globalThis.structuredClone(recorded), facts: second };
        checkAcceptance(recorded.name, current, recorded.members.dsh, recorded.members.pi);
        audit.scenarios.push({ name: recorded.name, status: 'semantic-assertions-passed', modelTurns: current.modelTurns,
          replyCounts: current.replyCounts, databaseSnapshotsStable: true, recordedFactsMatchDatabase: true,
          originalCommandReplayVerified: recorded.idempotentReplay === true,
          replayNote: recorded.idempotentReplay === true ? 'Original real run completed its IPC replay check.'
            : 'IPC replay was not reached in the original run. This offline audit does not establish replay idempotence.' });
      } finally { db.close(); }
    }
    assert.ok(audit.scenarios.length > 0, 'No completed scenario with recorded facts to audit');
    assert.equal(await readFile(reportPath, 'utf8'), original, 'Original report changed during audit');
    audit.status = 'offline-audit-passed';
  } catch (error) { audit.status = 'failed'; audit.error = redact(error.message); process.exitCode = 1; }
  await writeFile(output, redact(JSON.stringify(audit, null, 2)), { flag: 'wx' });
  console.log(JSON.stringify({ ...audit, output }));
}

if (args.has('--help') || (!args.has('--run-real') && !args.has('--prepare-only') && !args.has('--audit-report'))) {
  console.log(help);
} else if (args.has('--audit-report')) {
  await auditSavedReport();
} else {
  await main();
}
