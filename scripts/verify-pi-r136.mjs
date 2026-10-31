import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const toolsDir = path.join(root, 'dist/r136-pi-tools');
export const prefix = path.join(toolsDir, 'installation');
export const cli = path.join(prefix, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const guard = fileURLToPath(new URL('../tests/fixtures/piLoopbackOnlyR136.cjs', import.meta.url));
export const safeFlags = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve'];

// An allowlist deliberately excludes ALL provider, proxy, credential, preload,
// cloud and npm authentication variables inherited from the interactive host.
export function cleanEnv(home, agentDir = path.join(home, 'agent')) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TEMP: home, TMP: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', NO_COLOR: '1' };
}

export async function installOfficial() {
  await mkdir(toolsDir, { recursive: true });
  const home = await mkdtemp(path.join(toolsDir, 'install-'));
  const env = cleanEnv(home);
  Object.assign(env, { npm_config_cache: path.join(toolsDir, 'npm-cache'),
    npm_config_userconfig: path.join(home, 'empty.npmrc'), npm_config_globalconfig: path.join(home, 'empty-global.npmrc') });
  await writeFile(env.npm_config_userconfig, '');
  await writeFile(env.npm_config_globalconfig, '');
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const metadata = spawnSync(process.execPath, [npm, 'view', '@earendil-works/pi-coding-agent',
    'version', 'dist-tags', 'dist.integrity', 'dist.tarball', '--json', '--registry=https://registry.npmjs.org'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  const registry = JSON.parse(metadata.stdout);
  assert.equal(registry.version, '1.4.0', 'Review protocol changes before updating the pinned fixture');
  await writeFile(path.join(toolsDir, 'registry.json'), JSON.stringify(registry, null, 2));
  const result = spawnSync(process.execPath, [npm, 'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', `@earendil-works/pi-coding-agent@${registry.version}`], { cwd: home, env, stdio: 'inherit' });
  assert.equal(result.status, 0, 'Isolated install failed');
}

export function rpcChild(args, cwd, env) {
  const child = spawn(process.execPath, ['--require', guard, cli, ...args], { cwd, env, stdio: 'pipe', windowsHide: true });
  const records = [];
  let stderr = '', buffer = '', failure;
  const listeners = new Set();
  const wake = () => { for (const listener of listeners) listener(); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { failure = Error(`Non-JSON stdout: ${line}`); }
    }
    wake();
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { failure = error; wake(); });
  const exited = new Promise(resolve => child.on('close', (code, signal) => { resolve({ code, signal }); wake(); }));
  async function waitFor(predicate, from = 0, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (true) {
      if (failure) throw failure;
      const found = records.slice(from).find(predicate);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`CLI exited before response: ${stderr}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error(`RPC timeout; records=${JSON.stringify(records)}; stderr=${stderr}`);
      await new Promise(resolve => {
        const timer = setTimeout(done, remaining);
        function done() { clearTimeout(timer); listeners.delete(done); resolve(); }
        listeners.add(done);
      });
    }
  }
  async function command(type, data = {}) {
    const id = randomUUID();
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    return waitFor(record => record.type === 'response' && record.id === id);
  }
  async function close() {
    child.stdin.end();
    let timer;
    try {
      return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => {
        child.kill(); reject(Error(`CLI did not exit on EOF: ${stderr}`));
      }, 7000); })]);
    } finally { clearTimeout(timer); }
  }
  return { child, records, command, waitFor, close, exited, get stderr() { return stderr; } };
}

export async function createPiFixture() {
  assert.ok(existsSync(cli), 'Run node scripts/verify-pi-r136.mjs --install first');
  await mkdir(toolsDir, { recursive: true });
  const dir = await mkdtemp(path.join(toolsDir, 'run-'));
  const home = path.join(dir, 'home'), cwd = path.join(dir, 'workspace'), sessionDir = path.join(dir, 'sessions');
  const agentDir = path.join(home, 'agent');
  for (const folder of [home, cwd, sessionDir, agentDir]) await mkdir(folder, { recursive: true });
  const requests = [], active = new Set();
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ path: req.url, payload });
    assert.equal(req.url, '/v1/chat/completions');
    const lastUser = payload.messages.filter(message => message.role === 'user').at(-1);
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
    const system = payload.messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => message.content).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'r136-local', object: 'chat.completion.chunk', created: 1,
      model: 'fixed', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    if (userText.includes('R136_ABORT')) {
      chunk({ content: 'partial-before-abort' });
      active.add(res); res.on('close', () => active.delete(res)); return;
    }
    const userIndex = payload.messages.lastIndexOf(lastUser);
    const toolResult = payload.messages.slice(userIndex + 1).find(message => message.role === 'tool');
    if (userText.includes('R136_TOOL') && !toolResult) {
      chunk({ tool_calls: [{ index: 0, id: 'r136-read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'fixture.txt' }) } }] });
      chunk({}, 'tool_calls');
    } else {
      const historyCount = payload.messages.filter(message => message.role === 'user').length;
      const result = userText.includes('R136_TOOL') ? `tool-result:${JSON.stringify(toolResult.content)}`
        : `R136_FIXED users=${historyCount} file=${system.includes('R136_FILE_INSTRUCTIONS')} literal=${system.includes('R136_LITERAL_INSTRUCTIONS')} 中文🙂\u2028inside`;
      chunk({ content: result.slice(0, 15) }); chunk({ content: result.slice(15) });
      chunk({}, 'stop');
    }
    // OpenAI usage reports prompt_tokens including cache, Pi's input excludes cache.
    res.write(`data: ${JSON.stringify({ id: 'r136-local', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [],
      usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22, prompt_tokens_details: { cached_tokens: 3 } } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'r136-local': {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-fixture-no-credential',
    models: [{ id: 'fixed', name: 'R136 Fixed Local', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false } }],
  } } }));
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'r136-local', defaultModel: 'fixed',
    retry: { enabled: false }, compaction: { enabled: false } }));
  await writeFile(path.join(cwd, 'fixture.txt'), 'R136_TOOL_FILE_CONTENT\n');
  const instructionFile = path.join(dir, 'instructions.txt');
  await writeFile(instructionFile, 'R136_FILE_INSTRUCTIONS 中文\n');
  const env = cleanEnv(home, agentDir);
  const extensionMarker = path.join(dir, 'unexpected-extension-loaded');
  for (const extensionDir of [path.join(agentDir, 'extensions'), path.join(cwd, '.pi/extensions')]) {
    await mkdir(extensionDir, {recursive: true});
    await writeFile(path.join(extensionDir, 'metadata-canary.mjs'), `import {writeFileSync} from 'node:fs';\nexport default function(){writeFileSync(${JSON.stringify(extensionMarker)},'unexpected');}\n`);
  }
  const executable = path.join(dir, 'isolated-pi.mjs');
  await writeFile(executable, `import {spawn} from 'node:child_process';\nconst child=spawn(${JSON.stringify(process.execPath)},['--require',${JSON.stringify(guard)},${JSON.stringify(cli)},...process.argv.slice(2)],{cwd:${JSON.stringify(cwd)},env:${JSON.stringify(env)},stdio:'inherit',windowsHide:true});\nchild.on('error',()=>{process.exitCode=1;});\nchild.on('exit',code=>{process.exitCode=code===0?0:1;});\n`);
  return { dir, home, cwd, agentDir, sessionDir, instructionFile, executable, extensionMarker, env, requests,
    spawn(args) { return rpcChild(args, cwd, env); },
    spawnForAdapter(_command, args, spawnCwd) {
      const cliArgs = args[0] === cli ? args.slice(1) : args;
      return spawn(process.execPath, ['--require', guard, cli, ...safeFlags, ...cliArgs], { cwd: spawnCwd, env, stdio: 'pipe', windowsHide: true });
    },
    async close() { for (const res of active) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export async function verifyOfficial({ metadataOnly = false, immediateEof = false } = {}) {
  const fixture = await createPiFixture();
  const clients = new Set();
  const exitFailures = [];
  const exitResults = [];
  const shutdownMode = metadataOnly ? 'metadata' : immediateEof ? 'original-immediate-eof' : 'host-compatibility';
  const open = args => { const client = fixture.spawn(args); clients.add(client); return client; };
  const close = async client => {
    const toolObserved = client.records.some(event => event.type === 'tool_execution_start');
    const stdinCloseDelayMs = !immediateEof && process.platform === 'win32' && toolObserved ? 300 : 0;
    if (stdinCloseDelayMs) await new Promise(resolve => setTimeout(resolve, stdinCloseDelayMs));
    const result = await client.close(); clients.delete(client);
    exitResults.push({toolObserved, stdinCloseDelayMs, ...result});
    if (result.code !== 0) {
      const evidence = { result, stderr: client.stderr, records: client.records };
      exitFailures.push({code: result.code, signal: result.signal, stderr: client.stderr});
      await writeFile(path.join(fixture.dir, `exit-failure-${exitFailures.length}.json`), JSON.stringify(evidence, null, 2));
    }
  };
  const report = { version: null, cli, sessionDir: fixture.sessionDir, realApiCalls: 0,
    shutdownMode, originalIssueEvidence: path.join(toolsDir, 'eof-matrix-report.json'), exitResults, exitFailures };
  try {
    const version = spawnSync(process.execPath, ['--require', guard, cli, '--version'], { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr); report.version = version.stdout.trim(); assert.equal(report.version, '1.4.0');
    const client = open(['--mode', 'rpc', '--no-session', ...safeFlags]);
    report.state = await client.command('get_state');
    report.models = await client.command('get_available_models');
    report.rpcVersion = await client.command('get_version');
    assert.equal(report.state.success, true); assert.equal(report.models.success, true);
    assert.equal(report.rpcVersion.success, false);
    assert.deepEqual(report.models.data.models.map(model => `${model.provider}/${model.id}`), ['r136-local/fixed']);
    assert.equal(fixture.requests.length, 0); assert.equal(existsSync(fixture.extensionMarker), false);
    await close(client); assert.equal(exitFailures.length, 0, 'Metadata must exit normally');
    if (!metadataOnly) {
      const uuid = randomUUID();
      const args = ['--mode', 'rpc', ...safeFlags, '--session-id', uuid, '--session-dir', fixture.sessionDir,
        '--model', 'r136-local/fixed', '--append-system-prompt', fixture.instructionFile, '--append-system-prompt', 'R136_LITERAL_INSTRUCTIONS'];
      const first = open(args); const state = await first.command('get_state'); report.persistentState = state;
      assert.equal(state.data.sessionId, uuid); assert.equal(path.dirname(state.data.sessionFile), fixture.sessionDir);
      report.sessionFile = state.data.sessionFile;
      const ack = await first.command('prompt', { message: 'R136_TEXT' }); assert.equal(ack.success, true);
      const settled = await first.waitFor(event => event.type === 'agent_settled');
      const assistant = first.records.findLast(event => event.type === 'message_end' && event.message.role === 'assistant').message;
      assert.equal(settled.aborted, false); assert.equal(assistant.stopReason, 'stop');
      assert.match(JSON.stringify(assistant.content), /users=1 file=true literal=true/);
      assert.equal(assistant.usage.input, 14); assert.equal(assistant.usage.cacheRead, 3); assert.equal(assistant.usage.output, 5);
      assert.ok(first.records.findIndex(event => event.type === 'agent_end') < first.records.findIndex(event => event.type === 'agent_settled'));
      report.text = { ack, settled, assistant, eventTypes: first.records.map(event => event.type) };
      await writeFile(path.join(fixture.dir, 'text.json'), JSON.stringify(first.records, null, 2)); await close(first);
      const header = JSON.parse((await readFile(report.sessionFile, 'utf8')).split('\n')[0]);
      assert.equal(header.id, uuid); assert.equal(header.cwd, fixture.cwd); report.header = header;
      const resumed = open(args); const resumedState = await resumed.command('get_state');
      assert.equal(resumedState.data.sessionId, uuid); assert.equal(resumedState.data.sessionFile, report.sessionFile);
      await resumed.command('prompt', { message: 'R136_COLD_RESUME' }); await resumed.waitFor(event => event.type === 'agent_settled');
      const continued = resumed.records.findLast(event => event.type === 'message_end' && event.message.role === 'assistant').message;
      assert.match(JSON.stringify(continued.content), /users=2/); report.coldResume = { state: resumedState.data, assistant: continued }; await close(resumed);
      const tool = open(args); await tool.command('get_state'); await tool.command('prompt', { message: 'R136_TOOL' });
      await tool.waitFor(event => event.type === 'agent_settled');
      assert.ok(tool.records.some(event => event.type === 'tool_execution_start' && event.toolName === 'read'));
      assert.ok(tool.records.some(event => event.type === 'tool_execution_end' && event.isError === false));
      assert.match(JSON.stringify(tool.records), /R136_TOOL_FILE_CONTENT/);
      report.tool = tool.records; await close(tool);
      const aborted = open(args); await aborted.command('get_state');
      await aborted.command('prompt', { message: 'R136_ABORT' });
      await aborted.waitFor(event => event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta');
      await aborted.command('abort'); const abortSettled = await aborted.waitFor(event => event.type === 'agent_settled');
      const abortAssistant = aborted.records.findLast(event => event.type === 'message_end' && event.message.role === 'assistant').message;
      assert.equal(abortSettled.aborted, true); assert.equal(abortAssistant.stopReason, 'aborted');
      report.abort = { settled: abortSettled, assistant: abortAssistant, records: aborted.records }; await close(aborted);
      const missing = path.join(fixture.sessionDir, 'missing-explicit.jsonl');
      const explicit = open(['--mode', 'rpc', ...safeFlags, '--session', missing]); const explicitState = await explicit.command('get_state');
      assert.equal(explicitState.data.sessionFile, missing); assert.match(explicitState.data.sessionId, /^[a-f0-9-]{36}$/);
      report.missingExplicit = explicitState; await close(explicit);
    }
    report.localRequests = fixture.requests.length;
    report.protocolPassed = true;
    report.cleanExitPassed = exitFailures.length === 0;
    await writeFile(path.join(fixture.dir, 'requests.json'), JSON.stringify(fixture.requests, null, 2));
    report.evidenceDir = fixture.dir;
    await writeFile(path.join(fixture.dir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(toolsDir, 'latest-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(toolsDir, `latest-${shutdownMode}-report.json`), JSON.stringify(report, null, 2));
    return report;
  } finally {
    for (const client of clients) { client.child.kill(); await client.exited; }
    await fixture.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--install')) await installOfficial();
  const report = await verifyOfficial({ metadataOnly: process.argv.includes('--metadata'), immediateEof: process.argv.includes('--immediate-eof') });
  console.log(JSON.stringify({ version: report.version, evidenceDir: report.evidenceDir, state: report.state,
    models: report.models, rpcVersion: report.rpcVersion, sessionFile: report.sessionFile,
    localRequests: report.localRequests, realApiCalls: report.realApiCalls,
    shutdownMode: report.shutdownMode, protocolPassed: report.protocolPassed, cleanExitPassed: report.cleanExitPassed,
    exitResults: report.exitResults, exitFailures: report.exitFailures }, null, 2));
  if (!report.cleanExitPassed) process.exitCode = 1;
}
