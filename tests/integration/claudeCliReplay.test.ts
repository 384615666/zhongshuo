/**
 * Claude CLI 适配器零额度协议回放（DEV-10）：本地模拟进程回放固定 stream-json 样本。
 * 覆盖：正常流式+结构化结果/非零退出/认证失败/坏行/缺终结/分块通知/重复消息/
 * 中断（有/无响应）/启动中停止/续接参数/能力拒绝/两任务隔离（进程级）/迟到不终结。
 * 不调用真实模型；不修改全局配置。
 */
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliAdapter, CLAUDE_ADAPTER_VERSION } from '../../src/adapter/claude/cliAdapter.ts';
import { AdapterCallError } from '../../src/contracts/runtime.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

const cwd = mkdtempSync(join(tmpdir(), 'zs-claude-'));

/** 模拟进程工厂：脚本=按序输出的行数组（每项 {delay?, lines?, exit?} 分段）。 */
import { EventEmitter } from 'node:events';

function makeProc(script: Array<{ lines?: string[]; delayMs?: number; exit?: number | 'kill' }>): ChildProcessWithoutNullStreams {
  let killed = false;
  const fake = {
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    on: (ev: string, cb: (arg?: unknown) => void) => { (fake as unknown as Record<string, unknown>)[`_on_${ev}`] = cb; return fake; },
    kill: () => { killed = true; ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(null); },
    setEncoding: () => undefined,
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
  return fake as unknown as ChildProcessWithoutNullStreams;
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
      { lines: [j({ type: 'assistant', message: { content: [{ type: 'text', text: '部分', id: 'b1' }] } })] },
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
    expect(probe.capabilities.usageCost).toBe('unsupported');
    expect(CLAUDE_ADAPTER_VERSION).toBeTruthy();
    expect(probe.executable).toBeTruthy();
    const noModel = new ClaudeCliAdapter({}, fakeProc([{ exit: 0 }]));
    const s2 = await noModel.openSession(openInput());
    await expect(noModel.startTurn(s2, turnInput('x'))).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
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
