import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PiAdapter } from '../../src/adapter/pi/adapter.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

// No npm install or network access occurs in the default suite. The explicit
// opt-in runs the pinned official CLI against an isolated loopback-only server.
const enabled = process.env.ZS_PI_OFFICIAL_R136 === '1';
const script = fileURLToPath(new URL('../../scripts/verify-pi-r136.mjs', import.meta.url));
interface Fixture {
  dir: string; cwd: string; sessionDir: string; executable: string; extensionMarker: string;
  requests: Array<{ payload: { messages: Array<{ role: string; content: unknown }> } }>;
  spawnForAdapter(command: string, args: string[], cwd?: string): ChildProcessWithoutNullStreams;
  close(): Promise<void>;
}
interface Helpers {
  cli: string;
  cleanEnv(home: string): Record<string, string>;
  createPiFixture(): Promise<Fixture>;
  verifyOfficial(options?: {metadataOnly?: boolean}): Promise<{version: string; localRequests: number; realApiCalls: number; rpcVersion: {success: boolean; error: string}}>;
}
const helpers = await import(script) as Helpers;
const fixtures: Fixture[] = [], adapters: PiAdapter[] = [];
const input = (fixture: Fixture, threadId = 'pi-official'): OpenSessionInput => ({ projectId: 'p', memberId: 'm', taskId: 't', threadId,
  sessionGeneration: 0, cwd: fixture.cwd, policyId: 'policy-full',
  writeAccess: { fullAccess: true, modificationAuthorized: true, allowedWriteRoots: [fixture.cwd], identityKey: 'test' },
});
const request = (text: string, turnId = 'turn-1'): TurnRequest => ({ turnId, text, dispatchKey: turnId,
  inputBundleId: 'bundle', policyId: 'policy-full', taskRevision: 0 });
async function setup() {
  const fixture = await helpers.createPiFixture(); fixtures.push(fixture);
  const adapter = new PiAdapter({ executable: helpers.cli, model: 'r136-local/fixed', sessionDir: fixture.sessionDir,
    cwd: fixture.cwd, spawnFn: fixture.spawnForAdapter });
  adapters.push(adapter); return {fixture, adapter};
}
async function terminal(adapter: PiAdapter, session: SessionRef) {
  const events: NormalizedRuntimeEvent[] = [];
  const iterator = adapter.events(session)[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Official Pi terminal timeout')), 12000); });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next.done) throw Error('Pi stream closed without terminal');
      events.push(next.value);
      if (next.value.kind === 'turn.completed' || next.value.kind === 'turn.failed') return events;
    }
  } finally { clearTimeout(timer); await iterator.return?.(undefined); }
}
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.disposeAll();
  for (const fixture of fixtures.splice(0)) await fixture.close();
  vi.unstubAllEnvs();
});

describe.skipIf(!enabled)('Pi 1.4.0 official CLI with isolated local fixed responses', () => {
  it('performs zero-inference metadata, detects unsupported RPC get_version and exits on EOF', async () => {
    const report = await helpers.verifyOfficial({metadataOnly: true});
    expect(report).toMatchObject({version: '1.4.0', localRequests: 0, realApiCalls: 0,
      rpcVersion: {success: false, error: 'Unknown command: get_version'}});
  }, 20000);

  it('probes and lists actual authenticated local models with project extensions disabled', async () => {
    const {fixture} = await setup();
    const metadata = new PiAdapter({executable: fixture.executable, cwd: fixture.cwd}); adapters.push(metadata);
    expect(await metadata.listModels()).toEqual([{id: 'r136-local/fixed', label: 'R136 Fixed Local'}]);
    expect(await metadata.probe()).toMatchObject({version: '1.4.0'});
    expect(fixture.requests).toHaveLength(0);
    expect(existsSync(fixture.extensionMarker)).toBe(false);
  }, 20000);

  it('queries actual selected non-reasoning model efforts without issuing any HTTP request', async () => {
    const {fixture} = await setup();
    const metadata = new PiAdapter({executable: fixture.executable, cwd: fixture.cwd, model: 'r136-local/fixed'});
    adapters.push(metadata);
    expect(await metadata.listModels()).toEqual([{id: 'r136-local/fixed', label: 'R136 Fixed Local', efforts: ['none']}]);
    expect(fixture.requests).toHaveLength(0);
    expect(existsSync(fixture.extensionMarker)).toBe(false);
  }, 20000);

  it('passes instructions and Unicode text through the real CLI, reports exact usage and confirms process exit', async () => {
    const {fixture, adapter} = await setup();
    const session = await adapter.openSession({...input(fixture), developerInstructions: 'R136_FILE_INSTRUCTIONS 中文\n'});
    await adapter.startTurn(session, request('R136_TEXT 中文🙂\n$() `literal` &'));
    const events = await terminal(adapter, session);
    expect(events.at(-1)).toMatchObject({kind: 'turn.completed', finalText: expect.stringContaining('users=1 file=true')});
    expect(events.find(event => event.kind === 'usage.updated')).toMatchObject({inputTokens: 14, cachedTokens: 3, outputTokens: 5, model: 'r136-local/fixed'});
    expect(events.filter(event => event.kind === 'message.delta').map(event => event.kind === 'message.delta' ? event.text : '').join('')).toContain('中文🙂\u2028inside');
    expect(await adapter.waitForTurnExit(session, 'turn-1', 5000)).toMatchObject({exitConfirmed: true});
    expect(fixture.requests).toHaveLength(1);
  }, 20000);

  it('cold resumes a persisted native UUID in a new adapter and new child without losing history', async () => {
    const {fixture, adapter} = await setup();
    const first = await adapter.openSession(input(fixture));
    await adapter.startTurn(first, request('R136_TEXT')); expect((await terminal(adapter, first)).at(-1)?.kind).toBe('turn.completed');
    expect(await adapter.waitForTurnExit(first, 'turn-1', 5000)).toMatchObject({exitConfirmed: true}); await adapter.close(first);
    const cold = new PiAdapter({executable: helpers.cli, model: 'r136-local/fixed', sessionDir: fixture.sessionDir, spawnFn: fixture.spawnForAdapter}); adapters.push(cold);
    const resumed = await cold.openSession({...input(fixture), resume: first});
    await cold.startTurn(resumed, request('R136_COLD_RESUME', 'turn-2'));
    expect((await terminal(cold, resumed)).at(-1)).toMatchObject({kind: 'turn.completed', finalText: expect.stringContaining('users=2')});
    expect(resumed.providerSessionId).toBe(first.providerSessionId);
    const files = (await import('node:fs/promises')).readdir(fixture.sessionDir);
    const file = (await files)[0]!; const header = JSON.parse((await readFile(`${fixture.sessionDir}/${file}`, 'utf8')).split('\n')[0]!);
    expect(header).toMatchObject({type: 'session', id: first.providerSessionId, cwd: fixture.cwd});
  }, 20000);

  it('executes a real native read tool and normalizes tool events and two assistant usage records', async () => {
    const {fixture, adapter} = await setup(); const session = await adapter.openSession(input(fixture));
    await adapter.startTurn(session, request('R136_TOOL')); const events = await terminal(adapter, session);
    expect(events.at(-1)).toMatchObject({kind: 'turn.completed', finalText: expect.stringContaining('R136_TOOL_FILE_CONTENT')});
    expect(events.find(event => event.kind === 'tool.started')).toMatchObject({toolName: 'read', action: 'read'});
    expect(events.find(event => event.kind === 'tool.completed')).toMatchObject({outcome: 'success'});
    expect(events.filter(event => event.kind === 'usage.updated')).toHaveLength(2);
    expect(await adapter.waitForTurnExit(session, 'turn-1', 5000)).toMatchObject({exitConfirmed: true, exitCode: 0});
  }, 20000);

  it('aborts an actual open SSE response and receives a provider-terminal interrupted outcome', async () => {
    const {fixture, adapter} = await setup(); const session = await adapter.openSession(input(fixture));
    await adapter.startTurn(session, request('R136_ABORT'));
    const iterator = adapter.events(session)[Symbol.asyncIterator]();
    for await (const event of {[Symbol.asyncIterator]: () => iterator}) {
      if (event.kind === 'message.delta') break;
    }
    await adapter.interrupt(session, 'turn-1');
    expect((await terminal(adapter, session)).at(-1)).toMatchObject({kind: 'turn.failed', code: 'INTERRUPTED', failureEvidence: {source: 'provider-terminal'}});
    expect(await adapter.waitForTurnExit(session, 'turn-1', 5000)).toMatchObject({exitConfirmed: true});
  }, 20000);

  it('rejects a missing resume file before spawning or issuing any model request', async () => {
    const {fixture, adapter} = await setup(); const first = await adapter.openSession(input(fixture));
    await adapter.startTurn(first, request('R136_TEXT')); await terminal(adapter, first);
    await adapter.waitForTurnExit(first, 'turn-1', 5000); await adapter.close(first);
    const fs = await import('node:fs/promises'); for (const file of await fs.readdir(fixture.sessionDir)) await unlink(`${fixture.sessionDir}/${file}`);
    const resumed = await adapter.openSession({...input(fixture), resume: first});
    await expect(adapter.startTurn(resumed, request('R136_COLD_RESUME', 'turn-2'))).rejects.toMatchObject({code: 'RESOURCE_NOT_FOUND', notStarted: true});
    expect(fixture.requests).toHaveLength(1);
  }, 20000);
});

it('strips provider credentials, cloud profiles, preloads and proxies from official child environments', () => {
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'NODE_OPTIONS', 'HTTPS_PROXY', 'PI_CODING_AGENT_DIR']) vi.stubEnv(key, 'fixture-poison-value');
  const env = helpers.cleanEnv('isolated-home');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'NODE_OPTIONS', 'HTTPS_PROXY']) expect(env[key]).toBeUndefined();
  expect(env.HOME).toBe('isolated-home'); expect(env.USERPROFILE).toBe('isolated-home');
  expect(env.PI_CODING_AGENT_DIR).not.toBe('fixture-poison-value');
});
