import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../../src/adapter/pi/adapter.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

// Explicit opt-in, an already installed pinned CLI, and loopback responses only.
// No installer, real credentials, package manager, or HOME/root overrides.
const enabled = process.env.ZS_PI_REPAIR_OFFICIAL_R139 === '1';
const cli = process.env.ZS_PI_R139_CLI ?? '';
const evidenceBase = fileURLToPath(new URL('../../dist/r139-pi-official/', import.meta.url));
const schema = { type: 'object', additionalProperties: false, required: ['resultKey', 'summary'], properties: {
  resultKey: { const: 'R139_LITERAL_中文_🙂_$()`' }, summary: { type: 'string', description: 'R139_SCHEMA_DESCRIPTION' },
} };
const finalText = JSON.stringify({ resultKey: schema.properties.resultKey.const, summary: 'R139_FIXED_JSON' });
const repairFlags = ['--no-tools', '--exclude-tools', '*', '--no-extensions', '--no-mcp', '--no-skills',
  '--no-context-files', '--no-prompt-templates', '--no-approve', '--no-themes'];
type Frame = Record<string, unknown>;
interface Payload { messages: Array<{ role: string; content?: unknown }>; tools?: unknown[] }
interface Launch {
  args: string[]; sent: Frame[]; frames: Frame[]; stderr: string; child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
}
interface Fixture {
  dir: string; cwd: string; agentDir: string; sessionDir: string; executable: string;
  requests: Array<{ path: string | undefined; payload: Payload }>; launches: Launch[]; markers: string[];
  launch(args: string[], cwd?: string): Launch;
  close(): Promise<void>;
}
const fixtures: Fixture[] = [], adapters: PiAdapter[] = [];
function write(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function env(agentDir: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // Preserve the actual OS home and temp locations. Only Pi's config is isolated.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return { ...result, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', NO_COLOR: '1' };
}
async function fixture(poison = true): Promise<Fixture> {
  expect(existsSync(cli), 'Set ZS_PI_R139_CLI to an already installed official 1.4.0 bundle').toBe(true);
  const manifest = JSON.parse(readFileSync(join(dirname(cli), '../../package.json'), 'utf8')) as { version: string };
  expect(manifest.version).toBe('1.4.0');
  mkdirSync(evidenceBase, { recursive: true });
  const dir = mkdtempSync(join(evidenceBase, 'run-'));
  const cwd = join(dir, 'workspace'), agentDir = join(dir, 'agent'), sessionDir = join(dir, 'sessions');
  for (const path of [cwd, agentDir, sessionDir]) mkdirSync(path, { recursive: true });
  const markers = ['extension-loaded', 'mcp-started', 'forbidden-write', 'forbidden-shell', 'denied-network'].map(name => join(dir, name));
  const guard = join(dir, 'loopback-only.cjs');
  write(guard, `const net=require('node:net'),fs=require('node:fs');const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const normalized=Array.isArray(args[0])?args[0]:args;const first=normalized[0];
const host=typeof first==='object'?first.host:normalized[1];if(!['127.0.0.1','::1','localhost'].includes(host)){
fs.appendFileSync(${JSON.stringify(markers[4])},String(host)+'\\n');throw Error('R139 non-loopback denied');}return connect.apply(this,args);};\n`);
  const requests: Fixture['requests'] = [], launches: Launch[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    const payload = JSON.parse(body) as Payload;
    requests.push({ path: req.url, payload });
    if (req.url !== '/v1/chat/completions' || requests.length > 8) { res.writeHead(400); res.end('Unexpected fixture request'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'r139-local',
      object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    const lastUser = payload.messages.findLastIndex(message => message.role === 'user');
    const malicious = JSON.stringify(payload.messages[lastUser]?.content).includes('R139_FORCE_TOOLS');
    const toolResult = payload.messages.slice(lastUser + 1).some(message => message.role === 'tool');
    if (malicious && !toolResult) {
      const shell = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('${markers[3]!.replaceAll('\\', '/')}', 'executed')"`;
      const calls = [
        ['read', { path: join(cwd, 'secret.txt') }], ['write', { path: markers[2], content: 'executed' }],
        ['edit', { path: join(cwd, 'secret.txt'), oldText: 'R139', newText: 'executed' }],
        ['bash', { command: shell }], ['powershell', { command: shell }],
        ['codemode', { code: 'return await tools.write({path:"forbidden-write",content:"executed"})' }],
        ['tool_search', { query: 'write' }], ['r139_extension_tool', {}], ['mcp__r139__write', {}],
      ];
      chunk({ tool_calls: calls.map(([name, args], index) => ({ index, id: `r139-forced-${index}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) } })) });
      chunk({}, 'tool_calls');
    } else { chunk({ content: finalText }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback port');
  write(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'r139-local': {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-fixture-no-credential',
    models: [{ id: 'fixed', name: 'R139 Local', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false } }],
  } } }));
  write(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'r139-local', defaultModel: 'fixed',
    retry: { enabled: true }, compaction: { enabled: true } }));
  write(join(cwd, 'secret.txt'), 'R139_SECRET_CONTENT_UNKNOWN_TO_PROVIDER');
  if (poison) {
    // Global and project resources are both present; omissions must be caused by
    // adapter flags, not by a conveniently empty config directory.
    for (const base of [agentDir, join(cwd, '.pi')]) {
      for (const name of ['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md']) write(join(base, name), `R139_AUTOLOAD_${name}`);
      write(join(base, 'extensions/canary.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(markers[0])},'loaded');
export default function(pi){pi.registerTool({name:'r139_extension_tool',label:'canary',description:'R139_AUTOLOAD_EXTENSION',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'canary'}]})});}\n`);
      write(join(base, 'skills/r139/SKILL.md'), '---\nname: r139-autoload\ndescription: R139_AUTOLOAD_SKILL\n---\nR139_AUTOLOAD_SKILL_BODY\n');
      write(join(base, 'prompts/r139.md'), '---\ndescription: R139_AUTOLOAD_PROMPT\n---\nR139_AUTOLOAD_PROMPT_BODY\n');
      write(join(base, 'mcp.json'), JSON.stringify({ mcpServers: { r139: { command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markers[1])},'started')`] } } }));
    }
    write(join(cwd, 'AGENTS.md'), 'R139_AUTOLOAD_WORKSPACE_AGENTS');
    // A project setting must not override the CLI's locked zero-tool selection.
    write(join(cwd, '.pi/settings.json'), JSON.stringify({ defaultTools: ['read', 'write', 'bash', 'codemode'],
      extensions: ['+builtin:mcp'], retry: { enabled: true }, compaction: { enabled: true } }));
  }
  const processEnv = env(agentDir), executable = join(dir, 'official-pi.mjs');
  // The adapter's real execFile(--version) runs the official bundle as well.
  // Runtime spawn below adds only the socket guard, never missing safety flags.
  write(executable, `import{spawn}from'node:child_process';import{appendFileSync}from'node:fs';
appendFileSync(${JSON.stringify(join(dir, 'preflight.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');
const child=spawn(${JSON.stringify(process.execPath)},['--require',${JSON.stringify(guard)},${JSON.stringify(cli)},...process.argv.slice(2)],
{env:${JSON.stringify(processEnv)},stdio:'inherit',windowsHide:true});child.on('error',()=>{process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1});\n`);
  const result: Fixture = { dir, cwd, agentDir, sessionDir, executable, requests, launches, markers,
    launch(args, launchCwd = cwd) {
      const actualArgs = args[0] === executable ? args.slice(1) : args;
      const child = spawn(process.execPath, ['--require', guard, cli, ...actualArgs], { cwd: launchCwd, env: processEnv, stdio: 'pipe', windowsHide: true });
      const launch: Launch = { args: actualArgs, child, sent: [], frames: [], stderr: '',
        closed: new Promise(resolve => child.on('close', code => resolve(code))) };
      launches.push(launch);
      let buffer = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data: string) => { buffer += data; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) launch.frames.push(JSON.parse(line) as Frame); } });
      child.stderr.on('data', (data: string) => { launch.stderr += data; });
      const original = child.stdin.write;
      child.stdin.write = function(this: typeof child.stdin, chunk: unknown, ...args: unknown[]) {
        for (const line of String(chunk).trim().split('\n')) { if (line) launch.sent.push(JSON.parse(line) as Frame); }
        return Reflect.apply(original, this, [chunk, ...args]) as boolean;
      } as typeof child.stdin.write;
      return launch;
    },
    async close() {
      for (const launch of launches) if (launch.child.exitCode === null && launch.child.signalCode === null) {
        launch.child.stdin.end();
        await Promise.race([launch.closed, new Promise<void>(resolve => { const timer = setTimeout(() => { launch.child.kill(); resolve(); }, 1000);
          void launch.closed.then(() => { clearTimeout(timer); resolve(); }); })]);
        await launch.closed;
      }
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      write(join(dir, 'evidence.json'), JSON.stringify({ cli, version: manifest.version, realProviderCalls: 0,
        requests, markers: markers.map(path => ({ path, exists: existsSync(path) })),
        launches: launches.map(({ args, sent, frames, stderr, child }) => ({ args, sent, frames, stderr, exitCode: child.exitCode, signal: child.signalCode })),
        preflight: existsSync(join(dir, 'preflight.jsonl')) ? readFileSync(join(dir, 'preflight.jsonl'), 'utf8') : '',
      }, null, 2));
    },
  };
  fixtures.push(result); return result;
}
function adapter(f: Fixture) {
  const a = new PiAdapter({ executable: f.executable, model: 'r139-local/fixed', sessionDir: f.sessionDir,
    spawnFn: (_command, args, cwd) => f.launch(args, cwd).child });
  adapters.push(a); return a;
}
function input(f: Fixture, repair = false): OpenSessionInput {
  return { projectId: 'p', memberId: 'm', taskId: 't', threadId: 'r139-independent', sessionGeneration: 0,
    cwd: f.cwd, policyId: 'full', developerInstructions: 'R139_STANDING_INSTRUCTIONS 中文🙂',
    writeAccess: { fullAccess: !repair, analysisOnly: repair, modificationAuthorized: !repair, allowedWriteRoots: [], identityKey: 'r139' } };
}
function request(repairOnly = false, text = 'R139_FORMAT_EXISTING_TEXT', turnId = randomUUID()): TurnRequest {
  return { turnId, dispatchKey: turnId, inputBundleId: 'r139', policyId: 'full', taskRevision: 0, text, repairOnly, outputSchema: schema };
}
async function terminal(a: PiAdapter, s: SessionRef, turnId: string) {
  const events: NormalizedRuntimeEvent[] = [], iterator = a.events(s)[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('R139 official terminal timeout')), 12000); });
  try { for (;;) { const next = await Promise.race([iterator.next(), timeout]); if (next.done) throw Error('No terminal');
    if (next.value.turnId !== turnId) continue;
    events.push(next.value); if (['turn.completed', 'turn.failed', 'process.exited'].includes(next.value.kind)) return events;
  } } finally { clearTimeout(timer); await iterator.return?.(undefined); }
}
function system(payload: Payload) { return payload.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => String(message.content)).join('\n'); }
function assertSchema(payload: Payload, expected = schema) {
  const text = system(payload);
  // Parse a JSON value embedded in the actual assembled provider prompt. This
  // accepts whitespace choices while detecting dropped schema fields verbatim.
  const start = text.indexOf('{', text.indexOf('R139_STANDING_INSTRUCTIONS'));
  expect(start).toBeGreaterThanOrEqual(0);
  let parsed: unknown;
  for (let end = start + 1; end <= text.length; end++) {
    try { parsed = JSON.parse(text.slice(start, end)); break; } catch { /* incomplete JSON prefix */ }
  }
  expect(parsed).toEqual(expected);
}
function assertLocked(f: Fixture) {
  const launch = f.launches.at(-1)!;
  for (const flag of repairFlags) expect(launch.args).toContain(flag);
  expect(launch.args[launch.args.indexOf('--exclude-tools') + 1]).toBe('*');
  expect(launch.args[launch.args.indexOf('--append-system-prompt') + 1]).toBe('');
  expect(launch.args[launch.args.indexOf('--system-prompt') + 1]).toBeTruthy();
  expect(system(f.requests[0]!.payload)).not.toContain('R139_AUTOLOAD');
  for (const { payload } of f.requests) expect(payload.tools ?? []).toEqual([]);
  expect(f.markers.map(path => existsSync(path))).toEqual(f.markers.map(() => false));
  expect(readFileSync(join(f.cwd, 'secret.txt'), 'utf8')).toBe('R139_SECRET_CONTENT_UNKNOWN_TO_PROVIDER');
}
async function waitFrame(launch: Launch, predicate: (frame: Frame) => boolean) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const found = launch.frames.find(predicate); if (found) return found;
    if (launch.child.exitCode !== null || Date.now() >= deadline) throw Error(`R139 RPC failed: ${launch.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function command(launch: Launch, type: string, data: Frame = {}) {
  const id = randomUUID(); launch.child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
  return waitFrame(launch, frame => frame.type === 'response' && frame.id === id);
}
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.disposeAll();
  for (const f of fixtures.splice(0)) await f.close();
});

describe.skipIf(!enabled)('R139 installed official Pi 1.4.0: literal schema and mechanically locked repair', () => {
  it('sends the literal schema with standing instructions and refreshes it on the next normal turn', async () => {
    const f = await fixture(false), a = adapter(f), s = await a.openSession(input(f));
    const first = request(); await a.startTurn(s, first);
    expect((await terminal(a, s, first.turnId)).at(-1)).toMatchObject({ kind: 'turn.completed', finalText });
    expect(await a.waitForTurnExit(s, first.turnId, 5000)).toMatchObject({ exitConfirmed: true, exitCode: 0 });
    assertSchema(f.requests[0]!.payload);
    const nextSchema = { ...schema, required: ['resultKey', 'summary', 'R139_NEXT_TURN_SCHEMA'] };
    const second = { ...request(), outputSchema: nextSchema }; await a.startTurn(s, second);
    expect((await terminal(a, s, second.turnId)).at(-1)?.kind).toBe('turn.completed');
    expect(await a.waitForTurnExit(s, second.turnId, 5000)).toMatchObject({ exitConfirmed: true, exitCode: 0 });
    expect(f.requests).toHaveLength(2); assertSchema(f.requests[1]!.payload, nextSchema);
    expect(f.requests[0]!.payload.tools?.length).toBeGreaterThan(0);
  }, 25000);

  it('preflights the official version without HTTP, disables retry/compaction, and repairs in a fresh context without autoload', async () => {
    const f = await fixture(), a = adapter(f), s = await a.openSession(input(f, true));
    const turn = request(true); expect(f.requests).toHaveLength(0); await a.startTurn(s, turn);
    expect((await terminal(a, s, turn.turnId)).at(-1)).toMatchObject({ kind: 'turn.completed', finalText });
    expect(await a.waitForTurnExit(s, turn.turnId, 5000)).toMatchObject({ exitConfirmed: true, exitCode: 0 });
    expect(f.requests).toHaveLength(1); assertSchema(f.requests[0]!.payload); assertLocked(f);
    const launch = f.launches[0]!;
    expect(launch.sent.map(frame => frame.type)).toEqual(['set_auto_retry', 'set_auto_compaction', 'get_state', 'prompt']);
    expect(launch.sent.slice(0, 2).map(frame => frame.enabled)).toEqual([false, false]);
    expect(launch.frames.filter(frame => frame.type === 'response').slice(0, 3).map(frame => [frame.command, frame.success]))
      .toEqual([['set_auto_retry', true], ['set_auto_compaction', true], ['get_state', true]]);
    expect(launch.frames.find(frame => frame.command === 'get_state')?.data).toMatchObject({ messageCount: 0, pendingMessageCount: 0 });
    expect(f.requests[0]!.payload.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(readFileSync(join(f.dir, 'preflight.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
      .toContainEqual(['--version']);
  }, 25000);

  it('fails and exits when a malicious local provider forces tools despite empty tool declarations', async () => {
    const f = await fixture(), a = adapter(f), s = await a.openSession(input(f, true)), turn = request(true, 'R139_FORCE_TOOLS');
    await a.startTurn(s, turn); const events = await terminal(a, s, turn.turnId);
    expect(events.at(-1)?.kind).toBe('turn.failed'); expect(events.some(event => event.kind === 'turn.completed')).toBe(false);
    expect(await a.waitForTurnExit(s, turn.turnId, 5000)).toMatchObject({ exitConfirmed: true });
    expect(f.requests).toHaveLength(1); assertLocked(f);
    expect(f.launches[0]!.frames.some(frame => frame.type === 'message_end' && JSON.stringify(frame).includes('r139-forced-'))).toBe(true);
    expect(events.some(event => event.kind === 'tool.started' || event.kind === 'tool.completed')).toBe(false);
    expect(f.launches[0]!.child.exitCode).toBe(0);
  }, 25000);

  it('proves native rejection of every forced tool independent of adapter cancellation, with zero metadata inference', async () => {
    const f = await fixture(); const ownPrompt = join(f.dir, 'own-system.md');
    write(ownPrompt, `R139_STANDING_INSTRUCTIONS\n${JSON.stringify(schema)}`);
    const launch = f.launch(['--mode', 'rpc', '--offline', '--no-session', ...repairFlags,
      '--system-prompt', ownPrompt, '--append-system-prompt', '', '--provider', 'r139-local', '--model', 'fixed']);
    expect(await command(launch, 'set_auto_retry', { enabled: false })).toMatchObject({ success: true });
    expect(await command(launch, 'set_auto_compaction', { enabled: false })).toMatchObject({ success: true });
    expect(await command(launch, 'get_state')).toMatchObject({ success: true, data: { messageCount: 0 } });
    expect(f.requests).toHaveLength(0);
    expect(await command(launch, 'prompt', { message: 'R139_FORCE_TOOLS' })).toMatchObject({ success: true });
    await waitFrame(launch, frame => frame.type === 'agent_settled');
    expect(f.requests).toHaveLength(2); assertLocked(f); assertSchema(f.requests[0]!.payload);
    const ends = launch.frames.filter(frame => frame.type === 'tool_execution_end');
    expect(ends).toHaveLength(9);
    expect(ends.map(frame => frame.isError)).toEqual(ends.map(() => true));
    for (const frame of ends) expect(JSON.stringify(frame.result)).toMatch(/not found|unknown tool/i);
    expect(JSON.stringify(f.requests[1]!.payload.messages)).not.toContain('R139_SECRET_CONTENT_UNKNOWN_TO_PROVIDER');
    const settled = launch.frames.find(frame => frame.type === 'agent_settled'); expect(settled?.aborted).not.toBe(true);
    // Match the existing R136 host compatibility: Windows native callbacks
    // must drain even when every attempted tool was rejected as unregistered.
    if (process.platform === 'win32') await new Promise(resolve => setTimeout(resolve, 300));
    launch.child.stdin.end(); expect(await launch.closed).toBe(0);
  }, 25000);
});
