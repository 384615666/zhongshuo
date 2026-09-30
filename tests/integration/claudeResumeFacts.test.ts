/**
 * 第二十一轮三：ClaudeCliAdapter 续接事实（零额度协议回放）。
 * 覆盖：①resume 请求 ID 不进 openSession 返回值（init 前失败不会虚假 resumed）；
 * ②result-only 回填（原地更新 worker 持有对象）；③init=X、result=Y 身份冲突——冲突身份
 * 不得冒充续接（resumeRequested 与 providerSessionId 分离后可判定）；④未上报身份=空串。
 */
import { describe, expect, it, afterAll } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ClaudeCliAdapter } from '../../src/adapter/claude/cliAdapter.ts';
import type { NormalizedRuntimeEvent, SessionRef } from '../../src/contracts/runtime.ts';

const cwd = mkdtempSync(join(tmpdir(), 'zs-claude21-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type FakeProc = ChildProcessWithoutNullStreams & { _argv(): string[] };
function makeProc(script: Array<{ lines?: string[]; delayMs?: number; exit?: number | 'kill' }>): FakeProc {
  let killed = false;
  const argv: string[] = [];
  const stdin = Object.assign(new EventEmitter(), { write: () => undefined, end: () => { (stdin as EventEmitter).emit('finish'); } });
  const fake = {
    stdin,
    argv,
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    on: (ev: string, cb: (arg?: unknown) => void) => { (fake as unknown as Record<string, unknown>)[`_on_${ev}`] = cb; return fake; },
    kill: () => { killed = true; ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(null); },
    setEncoding: () => undefined,
    _argv: () => argv,
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

const OK_RESULT = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'PROV-RESULT-1', is_error: false });

async function collect(adapter: ClaudeCliAdapter, session: SessionRef, turnId: string): Promise<NormalizedRuntimeEvent[]> {
  const out: NormalizedRuntimeEvent[] = [];
  for await (const ev of adapter.events(session)) {
    out.push(ev);
    if (ev.kind === 'turn.completed' || ev.kind === 'turn.failed') break;
  }
  void turnId;
  return out;
}

function adapterWith(script: Array<{ lines?: string[]; delayMs?: number; exit?: number | 'kill' }>) {
  let spawnedArgv: string[] | null = null;
  const adapter = new ClaudeCliAdapter({ model: 'deepseek-flash' }, ((args: string[]) => { spawnedArgv = args; return makeProc(script); }) as never);
  return { adapter, argv: () => spawnedArgv };
}

describe('第二十一轮三：ClaudeCliAdapter 续接事实分离（协议回放，零额度）', () => {
  it('① resume 请求 ID 不进 openSession 返回值——init 前失败不会虚假 resumed', async () => {
    // init 前失败（坏行→丢弃、close 兜底 failed）：无任何 provider 上报。
    const { adapter, argv } = adapterWith([{ lines: ['not-json'], exit: 1 }]);
    const session = await adapter.openSession({ projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th', sessionGeneration: 0, cwd, policyId: 'policy-analyze', resume: { id: 'prev', providerSessionId: 'PROV-PREV', runtimeInstallationId: 'ri', adapterVersion: 'v', threadId: 'th', sessionGeneration: 0, cwd } });
    expect(session.providerSessionId).toBe(''); // 请求续接 ID 不冒充 provider 已接受
    await adapter.startTurn(session, { turnId: 'turn1', dispatchKey: 'k', inputBundleId: 'b', text: 'x', policyId: 'p', taskRevision: 0 });
    const events = await collect(adapter, session, 'turn1');
    expect(events.some((e) => e.kind === 'turn.failed')).toBe(true);
    expect(session.providerSessionId).toBe(''); // 失败终态：仍未上报——resumed 判定不可能成立
    expect(argv()?.includes('--resume')).toBe(true);
    expect(argv()?.includes('PROV-PREV')).toBe(true); // --resume 请求确实携带了请求 ID
    await adapter.disposeAll();
  }, 30_000);

  it('② result-only 回填：无 init 行时 result.session_id 原地更新 worker 持有对象', async () => {
    const { adapter } = adapterWith([{ lines: [
      JSON.stringify({ type: 'assistant', message: { model: 'deepseek-flash', content: [{ type: 'text', text: 'ok', id: 'm1' }] } }),
      OK_RESULT,
    ], exit: 0 }]);
    const session = await adapter.openSession({ projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th', sessionGeneration: 0, cwd, policyId: 'policy-analyze' });
    expect(session.providerSessionId).toBe('');
    await adapter.startTurn(session, { turnId: 'turn2', dispatchKey: 'k', inputBundleId: 'b', text: 'x', policyId: 'p', taskRevision: 0 });
    const events = await collect(adapter, session, 'turn2');
    expect(events.some((e) => e.kind === 'turn.completed')).toBe(true);
    expect(session.providerSessionId).toBe('PROV-RESULT-1'); // 同一对象被原地回填
    await adapter.disposeAll();
  }, 30_000);

  it('③ init=X、result=Y 身份冲突：最终以上报链末值为准（Y）——冲突不得冒充续接 X', async () => {
    const { adapter } = adapterWith([{ lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'PROV-INIT-X' }),
      JSON.stringify({ type: 'assistant', message: { model: 'deepseek-flash', content: [{ type: 'text', text: 'ok', id: 'm1' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'PROV-RESULT-Y', is_error: false }),
    ], exit: 0 }]);
    const session = await adapter.openSession({ projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th', sessionGeneration: 0, cwd, policyId: 'policy-analyze', resume: { id: 'prev', providerSessionId: 'PROV-INIT-X', runtimeInstallationId: 'ri', adapterVersion: 'v', threadId: 'th', sessionGeneration: 0, cwd } });
    await adapter.startTurn(session, { turnId: 'turn3', dispatchKey: 'k', inputBundleId: 'b', text: 'x', policyId: 'p', taskRevision: 0 });
    const events = await collect(adapter, session, 'turn3');
    expect(events.some((e) => e.kind === 'turn.completed')).toBe(true);
    expect(session.providerSessionId).toBe('PROV-RESULT-Y'); // 末次上报为准——≠请求的 X → resumed 判定不成立（replayed）
    await adapter.disposeAll();
  }, 30_000);
});
