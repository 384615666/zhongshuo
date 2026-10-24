import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCliAdapter,
  claudeLaunchIdentity,
  type ClaudeCliAdapterOptions,
} from '../../src/adapter/claude/cliAdapter.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

type FakeProc = ChildProcessWithoutNullStreams & { stdinText(): string };

const fixtureLines = readFileSync(new URL('../fixtures/claude-analysis-only-r107.ndjson', import.meta.url), 'utf8')
  .trim()
  .split(/\r?\n/);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { cwd: string; executable: string } {
  const root = mkdtempSync(join(tmpdir(), 'zs-claude-r107-'));
  roots.push(root);
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const executable = join(root, 'claude-fixture.js');
  writeFileSync(executable, 'fixture executable v1\n', 'utf8');
  return { cwd, executable };
}

function protocolProc(lines: string[]): FakeProc {
  let stdin = '';
  const listeners = new Map<string, (arg?: unknown) => void>();
  const stdinStream = Object.assign(new EventEmitter(), {
    write: (chunk: string) => { stdin += chunk; return true; },
    end: () => undefined,
  });
  const fake = {
    stdin: stdinStream,
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    on: (event: string, listener: (arg?: unknown) => void) => {
      listeners.set(event, listener);
      return fake;
    },
    kill: () => listeners.get('close')?.(null),
    stdinText: () => stdin,
  };
  setImmediate(() => {
    for (const line of lines) fake.stdout.emit('data', `${line}\n`);
    listeners.get('close')?.(0);
  });
  return fake as unknown as FakeProc;
}

function optionsFor(executable: string, overrides: Partial<ClaudeCliAdapterOptions> = {}): ClaudeCliAdapterOptions {
  return {
    executable,
    model: 'deepseek-flash',
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

function openInput(cwd: string, writeAccess: NonNullable<OpenSessionInput['writeAccess']>): OpenSessionInput {
  return {
    projectId: 'project',
    memberId: 'codex',
    taskId: 'task',
    threadId: 'thread',
    sessionGeneration: 0,
    cwd,
    policyId: 'policy',
    writeAccess,
  };
}

function turnInput(turnId = 'r107-turn'): TurnRequest {
  return {
    turnId,
    dispatchKey: `dispatch:${turnId}`,
    inputBundleId: `bundle:${turnId}`,
    text: 'Analyze the public repository without modifying files.',
    policyId: 'policy',
    taskRevision: 0,
    resultKey: `result_${turnId}`,
  };
}

async function collect(adapter: ClaudeCliAdapter, session: SessionRef): Promise<NormalizedRuntimeEvent[]> {
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of adapter.events(session)) {
    events.push(event);
    if (event.kind === 'turn.completed' || event.kind === 'turn.failed') break;
  }
  return events;
}

function analysisAccess(planKey: string, overrides: Partial<NonNullable<OpenSessionInput['writeAccess']>> = {}): NonNullable<OpenSessionInput['writeAccess']> {
  return {
    analysisOnly: true,
    fullAccess: false,
    modificationAuthorized: false,
    allowedWriteRoots: [],
    identityKey: 'binding-bypass',
    launchConfigurationKey: planKey,
    ...overrides,
  };
}

describe('R107 Claude request-level analysisOnly', () => {
  it('uses the plan argv, allows read plus public web tools, and preserves the protocol fixture', async () => {
    const { cwd, executable } = workspace();
    const options = optionsFor(executable);
    const planKey = claudeLaunchIdentity({ ...options, permissionMode: 'plan' }, cwd).identityKey;
    let args: string[] = [];
    let proc!: FakeProc;
    const adapter = new ClaudeCliAdapter(options, captured => {
      args = [...captured];
      proc = protocolProc(fixtureLines);
      return proc;
    });
    const session = await adapter.openSession(openInput(cwd, analysisAccess(planKey)));
    await adapter.startTurn(session, turnInput());
    const events = await collect(adapter, session);

    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'deepseek-flash',
      '--permission-mode', 'plan', '--permission-prompts', 'none',
      '--tools', 'Read,Glob,Grep,WebFetch,WebSearch',
      '--allowedTools', 'Read,Glob,Grep,WebFetch,WebSearch',
      '--disallowedTools', 'Bash,PowerShell,REPL,Write,Edit,MultiEdit,NotebookEdit,Task,Agent,Skill,TodoWrite,mcp__*',
      '--strict-mcp-config', '--bare', '--disable-slash-commands',
    ]);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--mcp-config');
    expect(proc.stdinText()).toBe('Analyze the public repository without modifying files.');
    expect(events.filter(event => event.kind === 'tool.started').map(event => event.kind === 'tool.started' ? event.toolName : ''))
      .toEqual(['Read', 'WebSearch', 'WebFetch']);
    expect(events.filter(event => event.kind === 'tool.completed')).toHaveLength(3);
    expect(events.some(event => event.kind === 'turn.completed')).toBe(true);
    expect(session.providerSessionId).toBe('r107_session');
  });

  it('rejects payloads that claim analysis only while carrying writable scope', async () => {
    const { cwd, executable } = workspace();
    const options = optionsFor(executable);
    const planKey = claudeLaunchIdentity({ ...options, permissionMode: 'plan' }, cwd).identityKey;
    let spawns = 0;
    const adapter = new ClaudeCliAdapter(options, () => {
      spawns += 1;
      return protocolProc(fixtureLines);
    });
    for (const inconsistent of [
      { fullAccess: true, modificationAuthorized: false },
      { fullAccess: false, modificationAuthorized: true },
    ]) {
      const session = await adapter.openSession(openInput(cwd, analysisAccess(planKey, inconsistent)));
      await expect(adapter.startTurn(session, turnInput())).rejects.toMatchObject({
        code: 'CAPABILITY_UNSUPPORTED',
        message: expect.stringContaining('不一致'),
      });
    }
    expect(spawns).toBe(0);
  });

  it('matches plan launch identity and rejects the member bypass identity', async () => {
    const { cwd, executable } = workspace();
    const options = optionsFor(executable);
    const bypassKey = claudeLaunchIdentity(options, cwd).identityKey;
    const planKey = claudeLaunchIdentity({ ...options, permissionMode: 'plan' }, cwd).identityKey;
    let spawns = 0;
    const adapter = new ClaudeCliAdapter(options, () => {
      spawns += 1;
      return protocolProc(fixtureLines);
    });
    const wrong = await adapter.openSession(openInput(cwd, analysisAccess(bypassKey)));
    await expect(adapter.startTurn(wrong, turnInput())).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
      message: expect.stringContaining('只读分析启动配置'),
    });
    expect(spawns).toBe(0);

    const right = await adapter.openSession(openInput(cwd, analysisAccess(planKey)));
    await adapter.startTurn(right, turnInput('r107-plan'));
    await collect(adapter, right);
    expect(spawns).toBe(1);
  });

  it('rejects extraArgs so they cannot override plan, tool, or MCP restrictions', async () => {
    const { cwd, executable } = workspace();
    const options = optionsFor(executable, {
      extraArgs: ['--dangerously-skip-permissions', '--mcp-config', 'untrusted.json'],
    });
    const planKey = claudeLaunchIdentity({ ...options, permissionMode: 'plan' }, cwd).identityKey;
    let spawns = 0;
    const adapter = new ClaudeCliAdapter(options, () => {
      spawns += 1;
      return protocolProc(fixtureLines);
    });
    const session = await adapter.openSession(openInput(cwd, analysisAccess(planKey)));
    await expect(adapter.startTurn(session, turnInput())).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
      message: expect.stringContaining('额外启动参数'),
    });
    const repairSession = await adapter.openSession(openInput(cwd, analysisAccess(planKey)));
    await expect(adapter.startTurn(repairSession, { ...turnInput('r107-repair-extra'), repairOnly: true })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
      message: expect.stringContaining('额外启动参数'),
    });
    expect(spawns).toBe(0);
  });

  it('rejects a real executable change after the plan identity was frozen', async () => {
    const { cwd, executable } = workspace();
    const options = optionsFor(executable);
    const planKey = claudeLaunchIdentity({ ...options, permissionMode: 'plan' }, cwd).identityKey;
    let spawns = 0;
    const adapter = new ClaudeCliAdapter(options, () => {
      spawns += 1;
      return protocolProc(fixtureLines);
    });
    const session = await adapter.openSession(openInput(cwd, analysisAccess(planKey)));
    writeFileSync(executable, 'fixture executable changed after identity freeze\n', 'utf8');
    await expect(adapter.startTurn(session, turnInput())).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
      message: expect.stringContaining('启动配置已变化'),
    });
    expect(spawns).toBe(0);
  });

  it('keeps R104 full and scoped write branches unchanged', async () => {
    const { cwd, executable } = workspace();

    const fullOptions = optionsFor(executable);
    const fullKey = claudeLaunchIdentity(fullOptions, cwd).identityKey;
    let fullArgs: string[] = [];
    const fullAdapter = new ClaudeCliAdapter(fullOptions, args => {
      fullArgs = [...args];
      return protocolProc(fixtureLines);
    });
    const full = await fullAdapter.openSession(openInput(cwd, {
      analysisOnly: false,
      fullAccess: true,
      modificationAuthorized: true,
      allowedWriteRoots: [],
      identityKey: 'binding-bypass',
      launchConfigurationKey: fullKey,
    }));
    await fullAdapter.startTurn(full, turnInput('r107-full'));
    await collect(fullAdapter, full);
    expect(fullArgs).toContain('bypassPermissions');
    expect(fullArgs).toContain('--dangerously-skip-permissions');
    expect(fullArgs).not.toContain('--tools');
    expect(fullArgs).not.toContain('--allowedTools');

    const scopedOptions = optionsFor(executable, { permissionMode: 'dontAsk' });
    const scopedKey = claudeLaunchIdentity(scopedOptions, cwd).identityKey;
    let scopedArgs: string[] = [];
    const scopedAdapter = new ClaudeCliAdapter(scopedOptions, args => {
      scopedArgs = [...args];
      return protocolProc(fixtureLines);
    });
    const scoped = await scopedAdapter.openSession(openInput(cwd, {
      analysisOnly: false,
      fullAccess: false,
      modificationAuthorized: true,
      allowedWriteRoots: [cwd],
      identityKey: 'binding-scoped',
      launchConfigurationKey: scopedKey,
    }));
    await scopedAdapter.startTurn(scoped, turnInput('r107-scoped'));
    await collect(scopedAdapter, scoped);
    expect(scopedArgs).toContain('--restricted');
    expect(scopedArgs[scopedArgs.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(scopedArgs[scopedArgs.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,Write,Edit');
  });

  it('keeps repairOnly on the stricter local-only read set', async () => {
    const { cwd, executable } = workspace();
    const options = optionsFor(executable);
    const planKey = claudeLaunchIdentity({ ...options, permissionMode: 'plan' }, cwd).identityKey;
    let args: string[] = [];
    const adapter = new ClaudeCliAdapter(options, captured => {
      args = [...captured];
      return protocolProc(fixtureLines);
    });
    const session = await adapter.openSession(openInput(cwd, analysisAccess(planKey)));
    await adapter.startTurn(session, { ...turnInput('r107-repair'), repairOnly: true });
    await collect(adapter, session);
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    const disallowed = args[args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(disallowed).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'Bash', 'Write', 'mcp__*']));
  });
});
