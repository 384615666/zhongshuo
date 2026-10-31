import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PiAdapter } from '../src/adapter/pi/adapter.ts';
import { resolveAgentExecutable } from '../src/adapter/cli/executable.ts';
import { spawnManagedBridge, managedJobsCount, managedActivePollers } from '../src/daemon/managed/bridge.ts';
import { managedRuntimeAvailable } from '../src/daemon/managed/jobManager.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = path.join(root, 'dist/r137-real/pi');
const executable = process.env.ZS_PI_EXECUTABLE ?? 'pi';
const safeFlags = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve'];
const cwd = path.join(base, 'project-fixture');
const sessionDir = path.join(base, 'sessions');
await mkdir(cwd, {recursive: true}); await mkdir(sessionDir, {recursive: true});
const redact = value => String(value).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '[redacted]')
  .replace(/((?:api[_-]?key|token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
  .replace(/https?:\/\/[^\s<>"']+/g, '[endpoint-redacted]').slice(0, 600);
const writeEvidence = (name, data) => writeFile(path.join(base, name), JSON.stringify(data, null, 2));
const publicModel = model => model && typeof model.provider === 'string' && typeof model.id === 'string' ? `${model.provider}/${model.id}` : null;

async function defaultState() {
  const entry = resolveAgentExecutable('pi', executable);
  const child = spawn(entry.command, [...entry.prefixArgs, '--mode', 'rpc', '--no-session', '--offline', ...safeFlags], {cwd,env:entry.env?{...process.env,...entry.env}:undefined, windowsHide: true, stdio: 'pipe'});
  const id = randomUUID(); let buffer = '', summary, stderr = '';
  const timer = setTimeout(() => child.kill(), 15000);
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'response' && frame.id === id) {
          summary = frame.success ? {defaultModel: publicModel(frame.data.model), providerId: frame.data.model?.provider,
            modelId: frame.data.model?.id, thinkingLevel: frame.data.thinkingLevel,
            isStreaming: frame.data.isStreaming, pendingMessageCount: frame.data.pendingMessageCount}
            : {error: redact(frame.error)};
          child.stdin.end();
        }
      } catch { /* No raw stdout/config is persisted. */ }
    }
  });
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({id, type: 'get_state'})}\n`);
  const exitCode = await new Promise((resolve, reject) => {child.on('error', reject); child.on('close', resolve);});
  clearTimeout(timer);
  if (!summary || exitCode !== 0) throw Error(`Pi metadata failed (${exitCode}): ${redact(stderr)}`);
  return {...summary, exitCode};
}

async function metadata() {
  const adapter = new PiAdapter({executable, cwd, requestTimeoutMs: 15000});
  const probe = await adapter.probe(); const state = await defaultState();
  const selected = state.defaultModel ? new PiAdapter({executable, cwd, model: state.defaultModel, requestTimeoutMs: 15000}) : adapter;
  const models = await selected.listModels();
  const result = {version: probe.version, ...state, modelIds: models.map(model => model.id),
    selectedEfforts: models.find(model => model.id === state.defaultModel)?.efforts ?? [], inferenceTurns: 0};
  await writeEvidence('metadata.json', result); console.log(JSON.stringify(result));
  assert.ok(state.defaultModel && models.some(model => model.id === state.defaultModel), 'No available configured default; no paid model selected');
  return result;
}

const turnInput = (text, n) => ({turnId: `pi-r137-turn-${n}`, text, dispatchKey: `pi-r137-${n}`,
  inputBundleId: `pi-r137-input-${n}`, policyId: 'full', taskRevision: 0});

async function real() {
  const meta = JSON.parse(await readFile(path.join(base, 'metadata.json'), 'utf8'));
  assert.ok(meta.defaultModel, 'Run metadata first and inspect configured default');
  // Exclusive budget ledger prevents accidental reruns after errors or interruption.
  await writeFile(path.join(base, 'real-authorization-consumed.json'), JSON.stringify({at: new Date().toISOString(), maxTurns: 2, model: meta.defaultModel}), {flag: 'wx'});
  assert.equal(managedRuntimeAvailable().ok, true, 'Windows managed bridge unavailable');
  const marker = `R137_PI_MARKER_${randomUUID().replaceAll('-', '')}`;
  await writeFile(path.join(cwd, 'marker.txt'), marker + '\n');
  const adapters = [], children = [];
  const report = {version: meta.version, model: meta.defaultModel, maxTurns: 2, startedTurns: 0,
    marker, turns: [], cleanup: null, status: 'running'};
  let activeTrace;
  const spawnFn = (command, args, childCwd, env) => {
    const child = spawnManagedBridge(command, [...args, ...safeFlags], {cwd: childCwd, env}); children.push(child);
    const trace = {pid: child.pid, jobId: child.managedJobId, rawEventCounts: {}, assistantMessages: 0,
      assistantStopReasons: [], modelIds: [], settled: null, killedOnRetry: false, maxActiveProcesses: 0};
    activeTrace = trace; child.piTrace = trace;
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data.toString('utf8'); let pos;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        try {
          const event = JSON.parse(line); const type = event.type;
          trace.rawEventCounts[type] = (trace.rawEventCounts[type] ?? 0) + 1;
          if (type === 'message_start' && event.message?.role === 'assistant') trace.assistantMessages++;
          if (type === 'message_end' && event.message?.role === 'assistant') {
            trace.assistantStopReasons.push(event.message.stopReason);
            const model = publicModel({provider: event.message.provider, id: event.message.model}); if (model) trace.modelIds.push(model);
          }
          if (type === 'agent_settled') trace.settled = {aborted: event.aborted};
          if (type === 'auto_retry_start') {trace.killedOnRetry = true; child.kill();}
        } catch { /* Never save raw provider messages. */ }
      }
    });
    return child;
  };
  const newAdapter = () => {const value = new PiAdapter({executable, model: meta.defaultModel, cwd, sessionDir, spawnFn, requestTimeoutMs: 15000}); adapters.push(value); return value;};
  const openInput = {projectId: 'r137-fixture', memberId: 'pi', taskId: 'marker-test', threadId: 'r137-marker',
    sessionGeneration: 0, cwd, policyId: 'full', writeAccess: {fullAccess: true, modificationAuthorized: true, allowedWriteRoots: [cwd], identityKey: 'r137-fixture'}};
  async function turn(adapter, session, text, n) {
    report.startedTurns++; await writeEvidence('real-report.json', report);
    const input = turnInput(text, n); await adapter.startTurn(session, input);
    const trace = activeTrace; const events = [], usage = [];
    const heartbeat = setInterval(() => {const count = children.at(-1).managed.activeCount(); if (typeof count === 'number') trace.maxActiveProcesses = Math.max(count, trace.maxActiveProcesses);}, 50);
    const deadline = setTimeout(() => {children.at(-1).kill();}, 120000);
    let terminal;
    try {
      for await (const event of adapter.events(session)) {
        events.push(event.kind);
        if (event.kind === 'usage.updated') usage.push(event);
        if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {terminal = event; break;}
      }
    } finally {clearInterval(heartbeat); clearTimeout(deadline);}
    const exit = await adapter.waitForTurnExit(session, input.turnId, 7000);
    const job = children.at(-1).managed; let release = job.releaseEvidence();
    for (let i = 0; i < 20 && release.activeCount !== 0; i++) {await delay(50); release = job.releaseEvidence();}
    const entry = {turn: n, sessionId: session.providerSessionId, status: terminal?.kind,
      exactMarker: terminal?.kind === 'turn.completed' && terminal.finalText?.trim() === marker,
      failure: terminal?.kind === 'turn.failed' ? {code: terminal.code, message: redact(terminal.message)} : null,
      usage: usage.map(event => ({inputTokens: event.inputTokens, cachedTokens: event.cachedTokens, outputTokens: event.outputTokens,
        cost: event.cost, costQuality: event.costQuality, model: event.model})),
      toolStarts: events.filter(kind => kind === 'tool.started').length, events, exit, release, trace};
    report.turns.push(entry); await writeEvidence('real-report.json', report);
    await adapter.close(session);
    assert.equal(entry.status, 'turn.completed', 'Actual Pi turn failed; do not retry');
    assert.equal(entry.exactMarker, true, 'Returned text did not exactly equal marker');
    assert.equal(exit?.exitConfirmed, true); assert.equal(exit?.exitCode, 0);
    assert.equal(release.activeCount, 0, 'Managed descendants still active');
    assert.equal(trace.settled?.aborted, false);
    assert.equal(trace.assistantStopReasons.at(-1), 'stop');
  }
  try {
    const firstAdapter = newAdapter(), first = await firstAdapter.openSession(openInput);
    await turn(firstAdapter, first, 'Read only ./marker.txt using the read tool. Return exactly its single marker line and nothing else. Do not read any other file or call shell/network tools.', 1);
    const coldAdapter = newAdapter(), cold = await coldAdapter.openSession({...openInput, resume: first});
    await turn(coldAdapter, cold, 'Without using tools or reading any files, return exactly the marker from the previous turn and nothing else.', 2);
    assert.equal(cold.providerSessionId, first.providerSessionId);
    const candidates = (await readdir(sessionDir)).filter(name => name.endsWith(`_${first.providerSessionId}.jsonl`));
    assert.equal(candidates.length, 1);
    const header = JSON.parse((await readFile(path.join(sessionDir, candidates[0]), 'utf8')).split('\n')[0]);
    assert.equal(header.id, first.providerSessionId); assert.equal(path.resolve(header.cwd), path.resolve(cwd));
    report.sessionFile = path.join(sessionDir, candidates[0]); report.status = 'passed';
  } catch (error) {report.status = 'failed'; report.error = redact(error.message); process.exitCode = 1;}
  finally {
    for (const adapter of adapters) await adapter.disposeAll();
    const proofs = children.map(child => ({jobId: child.managedJobId, release: child.managed.releaseEvidence()}));
    for (const child of children) child.managed.dispose();
    report.cleanup = {proofs, jobsRemaining: managedJobsCount(), pollersRemaining: managedActivePollers()};
    await writeEvidence('real-report.json', report);
    console.log(JSON.stringify(report));
  }
}

async function checkShim() {
  const entry = resolveAgentExecutable('pi', executable);
  const pathEntry = resolveAgentExecutable('pi', 'pi');
  const adapter = new PiAdapter({executable: 'pi', cwd, requestTimeoutMs: 15000});
  const probe = await adapter.probe();
  const models = await adapter.listModels();
  const result = {launcherMatched: entry.command === pathEntry.command && JSON.stringify(entry.prefixArgs) === JSON.stringify(pathEntry.prefixArgs),
    pathLauncherMatched: pathEntry.prefixArgs.every(file => path.isAbsolute(file)),
    version: probe.version, modelIds: models.map(model => model.id), inferenceTurns: 0};
  await writeEvidence('shim-check.json', result); console.log(JSON.stringify(result)); assert.equal(result.launcherMatched, true);
  assert.equal(result.pathLauncherMatched, true);
}

async function killIdle() {
  assert.equal(managedRuntimeAvailable().ok, true);
  const entry = resolveAgentExecutable('pi', 'pi');
  const child = spawnManagedBridge(entry.command, [...entry.prefixArgs, '--mode', 'rpc', '--no-session', '--offline', ...safeFlags], {cwd});
  const result = {inferenceTurns: 0, pid: child.pid, jobId: child.managedJobId};
  const id = randomUUID(); let buffer = '', ready;
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  child.stderr.resume(); child.stdout.setEncoding('utf8'); child.stdin.on('error', () => {});
  const response = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {child.kill(); reject(Error('Idle metadata timeout'));}, 15000);
    child.stdout.on('data', data => {
      buffer += data; let pos;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.id === id && frame.type === 'response') {
            clearTimeout(deadline); ready = frame.success === true; resolve();
          }
        } catch { /* No raw provider/config records are saved. */ }
      }
    });
  });
  try {
    child.stdin.write(`${JSON.stringify({id, type: 'get_state'})}\n`); await response; assert.equal(ready, true);
    result.activeBeforeKill = child.managed.activeCount(); assert.ok(result.activeBeforeKill >= 2, 'Expected managed launcher plus actual CLI');
    result.killRequested = child.kill();
    let deadline;
    try {result.exitCode = await Promise.race([closed, new Promise((_, reject) => {deadline = setTimeout(() => reject(Error('Managed kill did not close pipes')), 7000);})]);}
    finally {clearTimeout(deadline);}
    result.release = child.managed.releaseEvidence(); assert.equal(result.release.activeCount, 0); assert.equal(result.release.releasable, true);
    result.status = 'passed';
  } catch (error) {result.status = 'failed'; result.error = redact(error.message); child.kill(); process.exitCode = 1;}
  finally {
    child.managed.dispose(); result.jobsRemaining = managedJobsCount(); result.pollersRemaining = managedActivePollers();
    await writeEvidence('managed-kill-idle.json', result); console.log(JSON.stringify(result));
  }
}

try {
  if (process.argv.includes('--real')) await real();
  else if (process.argv.includes('--shim-check')) await checkShim();
  else if (process.argv.includes('--kill-idle')) await killIdle();
  else await metadata();
} catch (error) {console.error(JSON.stringify({status: 'failed', error: redact(error.message)})); process.exitCode = 1;}
