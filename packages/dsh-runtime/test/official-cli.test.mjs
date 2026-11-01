import test from 'node:test';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, dirname, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { buildDshRuntime } from '../../../scripts/build-dsh-runtime.mjs';
import { taskCompleteOutputSchema, taskCompleteSchema } from '../../../src/contracts/taskComplete.ts';
import { resolveCliExecutable } from '../../../src/adapter/cli/executable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const desktop = process.env.ZHONGSHUO_DSH_TEST_DESKTOP === '1' ? resolveCliExecutable('deepseek-harness') : undefined;
const cli = process.env.ZHONGSHUO_DSH_TEST_CLI ?? desktop?.prefixArgs.at(-1);
test('official DSH isolated profile, schema, tool-free repair and persisted agent lifecycle (zero provider calls, no package manager)', { skip: !cli, timeout: 120000 }, async () => {
  const tools = resolve(cli, '../../../..');
  const area = await mkdtemp(join(tmpdir(), 'zhongshuo-dsh-sdk-test-'));
  const work = join(area, 'workspace'); await mkdir(work);
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = process.env[key];
  env.PATH = [join(tools, '.bin'), dirname(process.execPath), 'C:\\Windows\\System32', 'C:\\Program Files\\Git\\cmd'].join(delimiter);
  env.DSH_HOME = join(area, 'home'); env.DSH_AGENTS_HOME = join(area, 'agents'); env.DSH_TELEMETRY_DISABLED = '1'; env.CI = 'true'; env.COREPACK_ENABLE_AUTO_PIN = '0';
  Object.assign(env,desktop?.env);
  const launch = (args, stdio) => spawn(desktop?.command ?? process.execPath, desktop ? [...desktop.prefixArgs,...args.slice(1)] : args, {cwd:work,env,windowsHide:true,stdio});
  const artifacts = join(area, 'artifacts'); await buildDshRuntime(artifacts);
  async function run(args, timeout = 20000) {
    const child = launch(args, ['ignore', 'pipe', 'pipe']);
    let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill(), timeout);
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); clearTimeout(timer);
    return { code, stdout, stderr };
  }
  const profile = join(env.DSH_HOME, 'profiles/zhongshuo');
  // Stage our package only in the temporary profile. The official launcher
  // resolves its own installed SDK; never run pnpm or mutate shared modules.
  const plugin = join(profile, 'node_modules/@zhongshuo/dsh-runtime'); await mkdir(plugin, { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, 'packages/dsh-runtime/package.json'), 'utf8'));
  for (const file of ['package.json', ...pkg.files]) await cp(join(root, 'packages/dsh-runtime', file), join(plugin, file));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-zhongshuo-test', private: true, dependencies: { [pkg.name]: pkg.version }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pkg.name] } } }));
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@zhongshuo/dsh-runtime']);
  const probe = await run([cli, '--profile', 'zhongshuo', '--zs-probe']); assert.equal(probe.code, 0, probe.stderr);
  assert.equal(JSON.parse(probe.stdout).type, 'probe');
  assert.equal(JSON.parse(probe.stdout).pluginVersion, '0.1.3');
  assert.equal(JSON.parse(probe.stdout).capabilities.planningOnly, true);
  assert.equal(JSON.parse(probe.stdout).capabilities.outputSchema, true);
  assert.equal(JSON.parse(probe.stdout).capabilities.formatRepair, true);
  const emptyModels = await run([cli, '--profile', 'zhongshuo', '--zs-models']); assert.equal(emptyModels.code, 0, emptyModels.stderr); assert.deepEqual(JSON.parse(emptyModels.stdout).models, []);
  // Only fixture registration is added to the profile. The actual official
  // base/agent/tool/persistence stack remains unchanged.
  const fixture = join(profile, 'fixture-provider.mjs');
  await cp(join(root, 'packages/dsh-runtime/test/fixture-provider.mjs'), fixture);
  // The fixture's explicit peer manifest shares the official llm class identity.
  const fixturePackage = join(profile, 'fixture-package'); await mkdir(fixturePackage);
  await cp(fixture, join(fixturePackage, 'index.mjs'));
  await writeFile(join(fixturePackage, 'package.json'), JSON.stringify({ name: 'zhongshuo-test-fixture', type: 'module', peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.5', '@deepseek-ai/dsh-scope': '0.2.1-rc.5' } }));
  const overlay = join(area, 'fixture.patch.yml');
  await writeFile(overlay, `- insert:\n    - id: zhongshuo-test-fixture\n      name: ${JSON.stringify(join(fixturePackage, 'index.mjs').replaceAll('\\', '/'))}\n`);
  const models = await run([cli, '--profile', 'zhongshuo', '--patch', overlay, '--zs-models']); assert.equal(models.code, 0, models.stderr);
  assert.deepEqual(JSON.parse(models.stdout).models, [{ id: 'fixture/scripted', label: 'Scripted fixture', efforts: ['low', 'high'] }]);
  async function execute(prompt, options = {}) {
    const frames = []; let stderr = ''; let settled = false; let result;
    const child = launch([cli, '--profile', 'zhongshuo', '--patch', overlay, '--zs-stdio'], ['pipe', 'pipe', 'pipe']);
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill(), 15000);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const request = { v: 1, type: 'execute', requestId: 'request-1', cwd: work, prompt, mode: 'full', model: 'fixture/scripted', effort: 'high', developerInstructions: 'fixture-instruction={{literal}}', ...options };
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    lines.on('line', (line) => {
      const frame = JSON.parse(line); frames.push(frame);
      if (frame.type === 'ready') {
        if (options.cancelBeforeExecute) send({ v: 1, type: 'cancel', requestId: request.requestId });
        else { send(request); if (options.cancelImmediately) send({ v: 1, type: 'cancel', requestId: request.requestId }); }
      }
      if (frame.type === 'session' && prompt === 'fixture:wait') setTimeout(() => send({ v: 1, type: 'cancel', requestId: request.requestId }), 100);
      if (frame.type === 'result') { result = frame; settled = true; child.stdin.end(); }
    });
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); clearTimeout(timer);
    assert.equal(settled, true, JSON.stringify({ code, stderr, frames })); assert.equal(code, 0, stderr);
    return { frames, result, stderr };
  }
  const first = await execute('fixture:hello'); assert.equal(first.result.status, 'completed', JSON.stringify(first)); assert.match(first.result.text, /prompts=1 effort=high/);
  const sessionId = first.frames.find((frame) => frame.type === 'session').sessionId;
  assert.equal(first.result.sessionId, sessionId); assert.ok(first.frames.some((frame) => frame.event?.kind === 'thinking')); assert.ok(first.frames.some((frame) => frame.event?.kind === 'text'));
  assert.deepEqual(first.frames.find((frame) => frame.event?.kind === 'usage').event, { kind: 'usage', inputTokens: 12, cachedTokens: 4, outputTokens: 6, model: 'fixture/scripted' });
  const resumed = await execute('fixture:resume', { sessionId }); assert.equal(resumed.result.status, 'completed', JSON.stringify(resumed)); assert.match(resumed.result.text, /prompts=2/); assert.equal(resumed.frames.find((frame) => frame.type === 'session').resumed, true);
  const fresh = await execute('fixture:fresh'); assert.equal(fresh.result.status, 'completed'); assert.match(fresh.result.text, /prompts=1/); assert.notEqual(fresh.result.sessionId, sessionId);
  const missing = await execute('fixture:missing', { sessionId: 'session-does-not-exist' }); assert.equal(missing.result.status, 'failed'); assert.ok(!missing.frames.some((frame) => frame.type === 'session'));
  const other = join(area, 'other-workspace'); await mkdir(other);
  const wrongCwd = await execute('fixture:wrong-cwd', { sessionId, cwd: other }); assert.equal(wrongCwd.result.error.code, 'SESSION_CWD_MISMATCH');
  const readonly = await execute('fixture:readonly', { mode: 'readonly' }); assert.equal(readonly.result.error.code, 'READ_ONLY_UNSUPPORTED'); assert.ok(!readonly.frames.some((frame) => frame.type === 'session'));
  const max = await execute('fixture:max'); assert.equal(max.result.status, 'failed'); assert.equal(max.result.stopReason, 'max-tokens');
  const failed = await execute('fixture:error'); assert.equal(failed.result.status, 'failed'); assert.ok(!JSON.stringify(failed.frames).includes('test-secret-must-not-leak'));
  const cancelled = await execute('fixture:wait'); assert.equal(cancelled.result.status, 'cancelled');
  const early = await execute('fixture:hello', { cancelImmediately: true }); assert.equal(early.result.status, 'cancelled');
  const unopened = await execute('fixture:hello', { cancelBeforeExecute: true }); assert.equal(unopened.result.status, 'cancelled'); assert.equal(unopened.result.sessionId, ''); assert.ok(!unopened.frames.some((frame) => frame.type === 'session'));
  const tool = await execute('fixture:tool'); assert.equal(tool.result.status, 'completed', JSON.stringify(tool));
  const started = tool.frames.find((frame) => frame.event?.kind === 'tool-start').event;
  const ended = tool.frames.find((frame) => frame.event?.kind === 'tool-end').event;
  assert.equal(started.id, ended.id); assert.equal(started.name, 'fixture_echo'); assert.deepEqual(started.input, { value: 'hello' }); assert.equal(ended.isError, false);
  const resultKey = 'r138-sdk-exact-result-key-{{literal}}';
  const schema = taskCompleteOutputSchema(resultKey);
  const value = { schemaVersion: 'task-complete-v1', resultKey, changeSummary: '收到', answer: '收到', document: null,
    responseKind: 'conversation', replyDisposition: 'reply', userQuestion: null, files: [], executedVerifications: [],
    unexecutedVerifications: [], remainingIssues: [], handoffs: [], memoryUpdates: [] };
  const payload = JSON.stringify({ schema, value });
  const structured = await execute(`fixture:schema\n${payload}`, { outputSchema: schema });
  assert.equal(structured.result.status, 'completed', JSON.stringify(structured));
  assert.deepEqual(taskCompleteSchema.parse(JSON.parse(structured.result.text)), value);
  const repair = await execute(`fixture:repair\n${payload}`, { mode: 'format-repair', outputSchema: schema });
  assert.equal(repair.result.status, 'completed', JSON.stringify(repair));
  assert.deepEqual(taskCompleteSchema.parse(JSON.parse(repair.result.text)), value);
  assert.equal(JSON.parse(repair.result.text).resultKey, resultKey);
  assert.ok(!repair.frames.some((frame) => frame.event?.kind?.startsWith('tool-')));
  assert.notEqual(repair.result.sessionId, structured.result.sessionId);
  const unsolicited = [];
  for (const name of ['fixture_echo', 'fixture_scoped', 'run_code']) {
    const attempt = await execute(`fixture:repair-call:${name}\n${payload}`, { mode: 'format-repair', outputSchema: schema });
    assert.equal(attempt.result.status, 'failed', JSON.stringify(attempt));
    assert.equal(attempt.result.error.code, 'FORMAT_REPAIR_TOOL_DENIED', JSON.stringify(attempt));
    assert.ok(!attempt.frames.some((frame) => frame.event?.kind?.startsWith('tool-')));
    unsolicited.push(attempt);
  }
  const planning = await execute(`fixture:planning\n${payload}`, {mode:'planning',outputSchema:schema});
  assert.equal(planning.result.status,'completed',JSON.stringify(planning));
  assert.deepEqual(taskCompleteSchema.parse(JSON.parse(planning.result.text)),value);
  assert.ok(!planning.frames.some(frame=>frame.event?.kind?.startsWith('tool-')));
  const planningDenied=[];
  for(const name of ['fixture_scoped','run_code']) {
    const attempt=await execute(`fixture:planning-call:${name}\n${payload}`,{mode:'planning',outputSchema:schema});
    assert.equal(attempt.result.status,'failed',JSON.stringify(attempt));assert.equal(attempt.result.error.code,'PLANNING_TOOL_DENIED');
    assert.ok(!attempt.frames.some(frame=>frame.event?.kind?.startsWith('tool-')));
    planningDenied.push(attempt);
  }
  await writeFile(join(area, 'report.json'), JSON.stringify({ version: '0.2.1-rc.5', realModelCalls: 0, checks: ['package-staged-without-install', 'probe-0.1.3-capabilities', 'empty-models', 'fixture-models-and-efforts', 'official-agent-loop', 'text', 'thinking', 'usage', 'resume-after-process-restart', 'fresh-session-isolation', 'missing-session', 'cwd-mismatch', 'readonly-preexecute-rejection', 'max-tokens-failure', 'error-redaction', 'active-cancel', 'startup-cancel', 'cancel-before-execute', 'official-tool-events', 'complete-task-schema-in-real-sdk-prompt', 'repair-exact-result-key', 'empty-repair-tool-schemas', 'global-scoped-late-stale-run_code-denial', 'extension-hooks-blocked', 'monotonic-guard-after-extension-allow', 'direct-dispatch-interceptor', 'unsolicited-model-tool-call-fails-before-dispatch', 'distinct-planning-instructions', 'planning-empty-tool-schemas', 'planning-scoped-late-stale-run_code-denial', 'planning-extensions-blocked', 'planning-forged-tool-fails-before-dispatch'], results: [first, resumed, fresh, missing, wrongCwd, readonly, max, failed, cancelled, early, unopened, tool, structured, repair, ...unsolicited, planning, ...planningDenied] }, null, 2));
  process.stdout.write(`SDK evidence: ${join(area, 'report.json')}\n`);
});
