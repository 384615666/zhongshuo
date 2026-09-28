/**
 * Claude CLI 适配器零额度协议回放（DEV-10）：本地模拟进程回放固定 stream-json 样本。
 * 覆盖：正常流式+结构化结果/非零退出/认证失败/坏行/缺终结/分块通知/重复消息/
 * 中断（有/无响应）/启动中停止/续接参数/能力拒绝/两任务隔离（进程级）/迟到不终结/
 * 启动路径安全（用户文本只走 stdin，argv 仅固定 CLI 参数；入口解析无 shell）。
 * 不调用真实模型；不修改全局配置。
 */
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliAdapter, CLAUDE_ADAPTER_VERSION, resolveClaudeExecutable } from '../../src/adapter/claude/cliAdapter.ts';
import { AdapterCallError } from '../../src/contracts/runtime.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

const cwd = mkdtempSync(join(tmpdir(), 'zs-claude-'));

/** 模拟进程工厂：脚本=按序输出的行数组（每项 {delay?, lines?, exit?} 分段）；stdin 记录入参。 */
import { EventEmitter } from 'node:events';

type FakeProc = ChildProcessWithoutNullStreams & { _stdinText(): string };

function makeProc(script: Array<{ lines?: string[]; delayMs?: number; exit?: number | 'kill' }>): FakeProc {
  let killed = false;
  const stdinChunks: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => { stdinChunks.push(s); },
    end: () => { (stdin as EventEmitter).emit('finish'); },
  });
  const fake = {
    stdin,
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    on: (ev: string, cb: (arg?: unknown) => void) => { (fake as unknown as Record<string, unknown>)[`_on_${ev}`] = cb; return fake; },
    kill: () => { killed = true; ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(null); },
    setEncoding: () => undefined,
    _stdinText: () => stdinChunks.join(''),
    _run: async () => {
      for (const seg of script) {
        if (seg.delayMs != null) await new Promise((r) => setTimeout(r, seg.delayMs));
        if (killed) return;
        if (seg.lines != null) for (const l of seg.lines) fake.stdout.emit('data', l + String.fromCharCode(10));
        if (seg.exit === 'kill') { fake.kill(); return; }
        if (typeof seg.exit === 'number') { ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(seg.exit); return; }
      }
    },
  };
  setImmediate(() => void ((fake as unknown as { _run: () => Promise<void> })._run)());
  return fake as unknown as FakeProc;
}

/** 模拟进程工厂：忽略 args（记录由调用方闭包自行做）。 */
function fakeProc(script: Array<{ lines?: string[]; delayMs?: number; exit?: number | 'kill' }>): (args: string[], c: string) => ChildProcessWithoutNullStreams {
  return () => makeProc(script);
}

const openInput = (gen = 0): OpenSessionInput => ({ projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th', sessionGeneration: gen, cwd, policyId: 'policy-analyze' });
const turnInput = (turnId: string): TurnRequest => ({ turnId, dispatchKey: `dk:${turnId}`, inputBundleId: 'b', text: '问题', policyId: 'policy-analyze', taskRevision: 0, resultKey: `result_${turnId}` });

async function collect(adapter: ClaudeCliAdapter, session: SessionRef, until: 'completed' | 'failed', timeoutMs = 5_000): Promise<NormalizedRuntimeEvent[]> {
  const events: NormalizedRuntimeEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const e of adapter.events(session)) {
    events.push(e);
    if (e.kind === `turn.${until}`) break;
    if (e.kind === 'turn.failed') break;
    if (Date.now() > deadline) break;
  }
  return events;
}

const j = (o: unknown) => JSON.stringify(o);

describe('正常流（stream-json）', () => {
  it('init→assistant→result：turn.started 合成、消息、usage、结构化 finalText、session 绑定', async () => {
    const adapter = new ClaudeCliAdapter({ model: 'test-model' }, fakeProc([
      { lines: [j({ type: 'system', subtype: 'init', session_id: 'cs_1', model: 'test-model' })] },
      { lines: [j({ type: 'assistant', message: { model: 'test-model', content: [{ type: 'text', text: '部分', id: 'b1' }] } })] },
      { lines: [j({ type: 'result', subtype: 'success', session_id: 'cs_1', result: '最终答案', usage: { input_tokens: 10, output_tokens: 5 } })], exit: 0 },
    ]));
    const session = await adapter.openSession(openInput());
    await adapter.startTurn(session, turnInput('turn_1'));
    const events = await collect(adapter, session, 'completed');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('turn.started'); // 合成（首 assistant）
    expect(kinds).toContain('message.delta');
    expect(kinds).toContain('message.completed');
    expect(kinds).toContain('usage.updated');
    expect(kinds).toContain('turn.completed');
    expect(events.find((e) => e.kind === 'turn.completed')).toMatchObject({ finalText: '最终答案' });
    expect(session.providerSessionId).toBe('cs_1');
    // 响应模型取证：result 不带 model → 取 assistant 消息内报模型（实测组合口径）。
    expect(events.find((e) => e.kind === 'usage.updated')).toMatchObject({ model: 'test-model', inputTokens: 10, outputTokens: 5 });
    // 所有事件归属本会话本 turn。
    expect(events.every((e) => e.sessionId === session.id && e.turnId === 'turn_1')).toBe(true);
  }, 10_000);

  it('分块通知（半行跨 chunk）与重复消息 id 不产生坏归属', async () => {
    const full = j({ type: 'assistant', message: { content: [{ type: 'text', text: '跨块', id: 'b2' }] } });
    const half = full.slice(0, Math.floor(full.length / 2));
    const rest = full.slice(Math.floor(full.length / 2));
    const emitted = 0;
    const adapter = new ClaudeCliAdapter({ model: 'm' }, () => ({
      stdout: {
        setEncoding: () => undefined,
        on: (ev: string, cb: (d: string) => void) => {
          if (ev === 'data') {
            setImmediate(() => cb(half));
            setImmediate(() => cb(rest + String.fromCharCode(10))); // 跨块补齐完整行
            setImmediate(() => cb(full + String.fromCharCode(10))); // 重复完整行
          }
        },
      },
      stderr: { setEncoding: () => undefined, on: () => undefined },
      on: (ev: string, cb: (c: number | null) => void) => { if (ev === 'close') setImmediate(() => cb(0)); return this; },
      kill: () => undefined,
    } as unknown as ChildProcessWithoutNullStreams));
    const session = await adapter.openSession(openInput());
    await adapter.startTurn(session, turnInput('turn_2'));
    const events = await collect(adapter, session, 'failed'); // 无 result：close 兜底 failed
    const deltas = events.filter((e) => e.kind === 'message.delta');
    expect(deltas.length).toBe(2); // 跨块拼一行 + 重复完整行=2 条
    expect(events.some((e) => e.kind === 'turn.failed')).toBe(true); // 无终态→failed（不冒充完成）
    void emitted;
  }, 10_000);
});

describe('故障反例', () => {
  it('认证失败（stderr 签名）→ AUTH_REQUIRED；非零退出无 result → PROVIDER_ERROR retryable', async () => {
    const a1 = new ClaudeCliAdapter({ model: 'm' }, () => ({
      stdout: { setEncoding: () => undefined, on: () => undefined },
      stderr: { setEncoding: () => undefined, on: (ev: string, cb: (d: string) => void) => { if (ev === 'data') setImmediate(() => cb('Please login / authentication required')); } },
      on: () => undefined, kill: () => undefined,
    } as unknown as ChildProcessWithoutNullStreams));
    const s1 = await a1.openSession(openInput());
    await a1.startTurn(s1, turnInput('t_auth'));
    const e1 = await collect(a1, s1, 'failed');
    expect(e1.find((e) => e.kind === 'turn.failed')).toMatchObject({ code: 'AUTH_REQUIRED' });

    const a2 = new ClaudeCliAdapter({ model: 'm' }, fakeProc([{ delayMs: 20, exit: 2 }]));
    const s2 = await a2.openSession(openInput());
    await a2.startTurn(s2, turnInput('t_exit'));
    const e2 = await collect(a2, s2, 'failed');
    expect(e2.find((e) => e.kind === 'turn.failed')).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
  }, 10_000);

  it('坏行丢弃；额度失败（is_error result subtype=error_usage）→ USAGE 上游码', async () => {
    const a = new ClaudeCliAdapter({ model: 'm' }, fakeProc([
      { lines: ['{not json', j({ type: 'assistant', message: { content: [{ type: 'text', text: 'x', id: 'b' }] } })] },
      { lines: [j({ type: 'result', subtype: 'error_usage', is_error: true, session_id: 'cs', result: '额度不足' })], exit: 1 },
    ]));
    const s = await a.openSession(openInput());
    await a.startTurn(s, turnInput('t_usage'));
    const ev = await collect(a, s, 'failed');
    expect(ev.find((e) => e.kind === 'turn.failed')).toMatchObject({ code: 'USAGE' });
    expect(ev.some((e) => e.kind === 'turn.started')).toBe(true); // 坏行不影响后续解析
  }, 10_000);

  it('中断：kill 后 close 兜底 failed（无 result）；启动中停止（startTurn 后立即 close 会话）资源回收', async () => {
    const a = new ClaudeCliAdapter({ model: 'm' }, fakeProc([{ delayMs: 5_000, lines: [] }]));
    const s = await a.openSession(openInput());
    await a.startTurn(s, turnInput('t_int'));
    await a.interrupt(s, 't_int');
    const ev = await collect(a, s, 'failed');
    expect(ev.some((e) => e.kind === 'turn.failed')).toBe(true);
    // 启动中停止：close 杀活动进程并不再可 events。
    const s2 = await a.openSession(openInput());
    await a.startTurn(s2, turnInput('t_int2'));
    await a.close(s2);
    await expect(a.startTurn(s2, turnInput('t3'))).rejects.toThrow(AdapterCallError);
  }, 10_000);

  it('续接参数：第二 turn 带 --resume <providerSessionId>', async () => {
    const seen: string[][] = [];
    const a = new ClaudeCliAdapter({ model: 'm' }, (args: string[]) => {
      seen.push(args);
      return makeProc([
        { lines: [j({ type: 'result', subtype: 'success', session_id: 'cs_resume', result: 'ok' })], exit: 0 },
      ]);
    });
    const s = await a.openSession(openInput());
    await a.startTurn(s, turnInput('r1'));
    await collect(a, s, 'completed');
    await a.startTurn(s, turnInput('r2'));
    await collect(a, s, 'completed');
    expect(seen[1]!.includes('--resume')).toBe(true);
    expect(seen[1]![seen[1]!.indexOf('--resume') + 1]).toBe('cs_resume');
  }, 10_000);
});

describe('能力边界（不静默放宽）', () => {
  it('steer/respondApproval 明确拒绝；缺模型显式报错；probe 能力三态', async () => {
    const a = new ClaudeCliAdapter({ model: 'm' }, fakeProc([{ exit: 0 }]));
    const s = await a.openSession(openInput());
    await expect(a.steer(s, turnInput('x'))).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(a.respondApproval(s, 'ap', 'allow_once')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    const probe = await a.probe();
    expect(probe.capabilities.steerActiveTurn).toBe('unsupported');
    expect(probe.capabilities.interactiveApprovals).toBe('unverified');
    expect(probe.capabilities.usageCost).toBe('supported'); // CLI total_cost_usd 估算（estimated）
    expect(CLAUDE_ADAPTER_VERSION).toBeTruthy();
    expect(probe.executable).toBeTruthy();
    const noModel = new ClaudeCliAdapter({}, fakeProc([{ exit: 0 }]));
    const s2 = await noModel.openSession(openInput());
    await expect(noModel.startTurn(s2, turnInput('x'))).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  }, 10_000);

  it('unrecognized_model stderr 告警不终结 turn：成功 result 照常 completed（回退与否以 result.model 为准）', async () => {
    // 真实取证（2026-09-28 渠道诊断）：deepseek-flash 成功 turn 伴随该告警（query_source=sdk）。
    const a = new ClaudeCliAdapter({ model: 'deepseek-flash' }, () => {
      const fake = {
        stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
        stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
        on: (ev: string, cb: (arg?: unknown) => void) => { (fake as unknown as Record<string, unknown>)[`_on_${ev}`] = cb; return fake; },
        kill: () => { ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(null); },
        setEncoding: () => undefined,
      };
      setImmediate(() => {
        (fake.stderr as EventEmitter & { emit: (e: string, d: string) => boolean }).emit('data', '[claude-code:unrecognized_model] {"model":"deepseek-flash","query_source":"sdk"}\n');
        (fake.stdout as EventEmitter & { emit: (e: string, d: string) => boolean }).emit('data',
          `${j({ type: 'result', subtype: 'success', session_id: 'cs_ok', result: 'ok', model: 'deepseek-flash', usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0.001 })}\n`);
        ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(0);
      });
      return fake as unknown as ChildProcessWithoutNullStreams;
    });
    const s = await a.openSession(openInput());
    await a.startTurn(s, turnInput('t_warn'));
    const events = await collect(a, s, 'completed');
    expect(events.some((e) => e.kind === 'turn.completed')).toBe(true); // 告警≠失败：以 result 为准
    const usage = events.find((e) => e.kind === 'usage.updated');
    expect(usage).toMatchObject({ model: 'deepseek-flash', cost: 0.001, costQuality: 'estimated' });
  }, 10_000);

  it('两任务隔离：两个会话各自进程/事件流互不串线；迟到事件不终结另一任务', async () => {
    let n = 0;
    const a = new ClaudeCliAdapter({ model: 'm' }, () => {
      n += 1;
      const mine = n;
      return makeProc([
        { delayMs: 60, lines: [j({ type: 'result', subtype: 'success', session_id: `cs_${mine}`, result: `r${mine}` })], exit: 0 },
      ]);
    });
    const sA = await a.openSession(openInput(0));
    const sB = await a.openSession(openInput(1));
    await a.startTurn(sA, turnInput('A'));
    await a.startTurn(sB, turnInput('B'));
    const [eA] = await Promise.all([collect(a, sA, 'completed'), collect(a, sB, 'completed')]);
    const doneA = eA.find((e) => e.kind === 'turn.completed');
    expect(doneA).toBeDefined();
    expect(eventsOf(eA).every((e) => e.turnId === 'A')).toBe(true);
    expect(doneA).toMatchObject({ finalText: 'r1' });
    function eventsOf(list: NormalizedRuntimeEvent[]) { return list; }
  }, 10_000);
});

describe('启动路径安全（用户令 2026-09-28：用户文本不经 shell/argv）', () => {
  const nasty = [
    'line1 "双引号" \'单引号\' `反引号`',
    'line2 & | ^ % ! < > $VAR $(whoami) && del /q',
    'line3 中文\t制表符',
    'line4 CRLF结尾',
  ].join('\r\n');

  it('argv 只含固定 CLI 参数（不含用户文本）；stdin 原样收到全文（引号/换行/中文/shell 特殊字符）', async () => {
    const seenArgs: string[][] = [];
    let proc!: FakeProc;
    const a = new ClaudeCliAdapter({ model: 'deepseek-flash' }, (args: string[]) => {
      seenArgs.push(args);
      proc = makeProc([{ lines: [j({ type: 'result', subtype: 'success', session_id: 'cs_safe', result: 'ok' })], exit: 0 }]);
      return proc;
    });
    const s = await a.openSession(openInput());
    await a.startTurn(s, { ...turnInput('t_safe'), text: nasty });
    await collect(a, s, 'completed');
    expect(seenArgs).toEqual([['-p', '--output-format', 'stream-json', '--verbose', '--model', 'deepseek-flash', '--permission-mode', 'plan', '--allowedTools', 'Read,Glob,Grep']]);
    expect(proc._stdinText()).toBe(nasty); // 字节级原样：不转义、不二次解释
  }, 10_000);

  it('resolveClaudeExecutable：默认解析原生 exe（本机 npm 全局，不经 .cmd/shell）；显式 .cmd 解析真实目标', () => {
    const def = resolveClaudeExecutable();
    expect(def.prefixArgs).toEqual([]);
    if (process.platform === 'win32') {
      expect(def.command.toLowerCase().endsWith('claude.exe')).toBe(true); // 本机已装 @anthropic-ai/claude-code（原生二进制）
    }
    // 伪造 shim：目标 .exe 直用；目标 .js 走 node 前缀。
    const dir = mkdtempSync(join(tmpdir(), 'zs-claudeshim-'));
    try {
      const exeShim = join(dir, 'claude.cmd');
      writeFileSync(exeShim, '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"  %*\r\n', 'utf8');
      const r1 = resolveClaudeExecutable(exeShim);
      expect(r1.command.endsWith('claude.exe')).toBe(true);
      expect(r1.prefixArgs).toEqual([]);
      const jsShim = join(dir, 'claude-js.cmd');
      writeFileSync(jsShim, '@ECHO off\r\nnode "%dp0%\\node_modules\\x\\cli.js" %*\r\n', 'utf8');
      const r2 = resolveClaudeExecutable(jsShim);
      expect(r2.prefixArgs.length).toBe(1);
      expect(r2.prefixArgs[0]!.replaceAll('\\', '/').endsWith('x/cli.js')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('模型名只接受渠道裸名（[1m] 后缀语法拒绝）；--resume id 非法拒绝', async () => {
    const a1 = new ClaudeCliAdapter({ model: 'deepseek-flash[1m]' }, fakeProc([{ exit: 0 }]));
    const s1 = await a1.openSession(openInput());
    await expect(a1.startTurn(s1, turnInput('t_m1'))).rejects.toMatchObject({ code: 'VALIDATION_INVALID' });

    const a2 = new ClaudeCliAdapter({ model: 'deepseek-flash' }, fakeProc([{ exit: 0 }]));
    const badResume = { providerSessionId: 'bad id; rm -rf' } as SessionRef;
    const s2 = await a2.openSession({ ...openInput(), resume: badResume });
    await expect(a2.startTurn(s2, turnInput('t_m2'))).rejects.toMatchObject({ code: 'VALIDATION_INVALID' });
  }, 10_000);

  it('probe：--version 本地执行读取版本（无模型调用）；响应模型随 usage 事件透传', async () => {
    const a = new ClaudeCliAdapter({ model: 'deepseek-flash' }, (args: string[]) => makeProc(
      args[0] === '--version'
        ? [{ lines: ['2.1.283 (Claude Code)'], exit: 0 }]
        : [{ lines: [j({ type: 'result', subtype: 'success', session_id: 'cs_v', result: 'ok', model: 'deepseek-flash', usage: { input_tokens: 3, output_tokens: 2 } })], exit: 0 }],
    ));
    const probe = await a.probe();
    expect(probe.version).toBe('2.1.283 (Claude Code)');
    const s = await a.openSession(openInput());
    await a.startTurn(s, turnInput('t_v'));
    const events = await collect(a, s, 'completed');
    const usage = events.find((e) => e.kind === 'usage.updated');
    expect(usage).toMatchObject({ model: 'deepseek-flash', inputTokens: 3, outputTokens: 2 }); // result.model 原样记录
  }, 10_000);
});
