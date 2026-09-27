/**
 * DEV-06 修复轮：Codex 适配器协议回放反例（本地 mock app-server，零模型额度）。
 * 覆盖外部审查项：终态各态映射、工具真实 outcome、两轮串线/迟到、通知先于响应、
 * 审批归属（threadId 路由/错会话拒绝）、生命周期重建（重握手+initialized）、resume 接线。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import type { NormalizedRuntimeEvent, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

interface TurnScript {
  notifications: Array<Record<string, unknown>>;
  emitBeforeResponse?: boolean;
  responseDelayMs?: number;
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-replay-'));
let scenarioPath = '';
let rpcLogPath = '';
let adapter: CodexAppServerAdapter;

beforeEach(() => {
  scenarioPath = join(tmpRoot, `scenario-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  rpcLogPath = join(tmpRoot, `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
});
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function mockAdapter(): CodexAppServerAdapter {
  return new CodexAppServerAdapter({
    mockEntry: { executable: 'tests/fixtures/mockAppServer.mjs', args: [scenarioPath, rpcLogPath] },
    requestTimeoutMs: 5_000,
  });
}

function scenario(turns: TurnScript[], extra: Record<string, unknown> = {}): void {
  writeFileSync(scenarioPath, JSON.stringify({ turns, ...extra }), 'utf8');
}

async function openMockSession(a: CodexAppServerAdapter, cwd = 'D:/mock'): Promise<SessionRef> {
  return a.openSession({
    projectId: 'p1', memberId: 'm1', taskId: 't1', threadId: 'th1',
    sessionGeneration: 0, cwd, policyId: 'plan',
  });
}

function turnRequest(turnId: string, text = 'x'): TurnRequest {
  return { turnId, dispatchKey: `dk-${turnId}`, inputBundleId: 'b', text, policyId: 'p', taskRevision: 0 };
}

/** 会话级连续读取器：同一 iterator 跨 turn 消费（重放语义下每轮新建迭代器会在旧终态提前停）。 */
class SessionReader {
  private iterator: AsyncIterator<NormalizedRuntimeEvent>;
  constructor(adapter: CodexAppServerAdapter, session: SessionRef) {
    this.iterator = adapter.events(session)[Symbol.asyncIterator]();
  }
  async next(timeoutMs = 4_000): Promise<IteratorResult<NormalizedRuntimeEvent> | 'timeout'> {
    return Promise.race([
      this.iterator.next(),
      new Promise<'timeout'>((resolve) => { const t = setTimeout(() => resolve('timeout'), timeoutMs); t.unref?.(); }),
    ]) as Promise<IteratorResult<NormalizedRuntimeEvent> | 'timeout'>;
  }
  async readTurn(timeoutMs = 4_000): Promise<NormalizedRuntimeEvent[]> {
    const events: NormalizedRuntimeEvent[] = [];
    for (;;) {
      const next = await this.next(timeoutMs);
      if (next === 'timeout' || next.done) return events;
      events.push(next.value);
      if (next.value.kind === 'turn.completed' || next.value.kind === 'turn.failed') return events;
    }
  }
}

async function runOneTurn(a: CodexAppServerAdapter, session: SessionRef, turnId: string, timeoutMs = 4_000): Promise<NormalizedRuntimeEvent[]> {
  const collecting = new SessionReader(a, session).readTurn(timeoutMs);
  await a.startTurn(session, turnRequest(turnId));
  return collecting;
}

function rpcLogEntries(): Array<Record<string, unknown>> {
  if (!existsSync(rpcLogPath)) return [];
  return readFileSync(rpcLogPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('回放：终态按 turn.status 映射（不再一律成功）', () => {
  it('status=failed → turn.failed 携带 error.kind/message', async () => {
    scenario([{ notifications: [{ kind: 'turn.completed', status: 'failed', error: { kind: 'UsageLimit', message: '额度不足' } }] }]);
    adapter = mockAdapter();
    const session = await openMockSession(adapter);
    const events = await runOneTurn(adapter, session, 'turn_1');
    expect(events.find((e) => e.kind === 'turn.failed')).toMatchObject({ code: 'UsageLimit', message: '额度不足', turnId: 'turn_1' });
    expect(events.some((e) => e.kind === 'turn.completed')).toBe(false);
    await adapter.dispose();
  });

  it('status=interrupted → turn.failed{code:"INTERRUPTED"}', async () => {
    scenario([{ notifications: [{ kind: 'turn.completed', status: 'interrupted' }] }]);
    adapter = mockAdapter();
    const session = await openMockSession(adapter);
    const events = await runOneTurn(adapter, session, 'turn_1');
    expect(events.find((e) => e.kind === 'turn.failed')).toMatchObject({ code: 'INTERRUPTED', turnId: 'turn_1' });
    await adapter.dispose();
  });

  it('工具 item status=declined → outcome=failure（不一律 success）', async () => {
    scenario([{ notifications: [
      { kind: 'tool.started', itemId: 'tool_1', command: 'Set-Content b6.txt' },
      { kind: 'tool.completed', itemId: 'tool_1', status: 'declined' },
      { kind: 'turn.completed', status: 'completed', finalText: '无法写入' },
    ] }]);
    adapter = mockAdapter();
    const session = await openMockSession(adapter);
    const events = await runOneTurn(adapter, session, 'turn_1');
    expect(events.find((e) => e.kind === 'tool.completed')).toMatchObject({ outcome: 'failure', turnId: 'turn_1' });
    await adapter.dispose();
  });
});

describe('回放：轮次归属（两轮/迟到/通知先于响应）', () => {
  it('同会话两轮：旧轮迟到事件不冒充新轮', async () => {
    scenario([
      { notifications: [{ kind: 'turn.completed', status: 'completed', finalText: '第一轮完成' }] },
      { notifications: [
        { kind: 'lateMessage', providerTurnId: 'mock-turn-1', itemId: 'item_late', text: '旧轮迟到结果' },
        { kind: 'turn.completed', status: 'completed', finalText: '第二轮完成' },
      ] },
    ]);
    adapter = mockAdapter();
    const session = await openMockSession(adapter);
    const reader = new SessionReader(adapter, session);
    const firstP = reader.readTurn();
    await adapter.startTurn(session, turnRequest('turn_A'));
    const first = await firstP;
    expect(first.find((e) => e.kind === 'turn.completed')?.turnId).toBe('turn_A');

    const secondP = reader.readTurn();
    await adapter.startTurn(session, turnRequest('turn_B'));
    const second = await secondP;
    const late = second.find((e) => e.kind === 'message.completed' && e.text === '旧轮迟到结果');
    expect(late).toBeDefined();
    // 迟到事件归属旧轮（turn_A），绝不冒充新轮 turn_B；消费方按 late/审计处理。
    expect(late?.turnId).toBe('turn_A');
    expect(second.find((e) => e.kind === 'turn.completed')?.turnId).toBe('turn_B');
    await adapter.dispose();
  });

  it('通知先于响应（turn/started 早于 turn/start 响应）也能建立映射', async () => {
    scenario([{ emitBeforeResponse: true, notifications: [
      { kind: 'turn.started' },
      { kind: 'agentMessage.completed', text: '早到消息' },
      { kind: 'turn.completed', status: 'completed', finalText: '完成' },
    ] }]);
    adapter = mockAdapter();
    const session = await openMockSession(adapter);
    const events = await runOneTurn(adapter, session, 'turn_early');
    expect(events.find((e) => e.kind === 'turn.started')?.turnId).toBe('turn_early');
    expect(events.find((e) => e.kind === 'message.completed')?.turnId).toBe('turn_early');
    expect(events.find((e) => e.kind === 'turn.completed')?.turnId).toBe('turn_early');
    await adapter.dispose();
  });
});

describe('回放：审批归属', () => {
  it('threadId 定位正确会话；错会话答复被拒；答复走对应 RPC id', async () => {
    scenario([{ notifications: [
      { kind: 'approvalRequest', method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf' } },
      { kind: 'turn.completed', status: 'completed', finalText: '已拒绝' },
    ] }]);
    adapter = mockAdapter();
    const sessionA = await openMockSession(adapter); // mock-thread-1
    const sessionB = await openMockSession(adapter); // mock-thread-2
    const events = await runOneTurn(adapter, sessionA, 'turn_appr', 6_000);
    const approval = events.find((e) => e.kind === 'approval.requested');
    expect(approval).toBeDefined();
    expect(approval?.turnId).toBe('turn_appr');

    await expect(
      adapter.respondApproval(sessionB, (approval as { approvalId: string }).approvalId, 'allow_once'),
    ).rejects.toMatchObject({ code: 'THREAD_SCOPE_MISMATCH' });
    await adapter.respondApproval(sessionA, (approval as { approvalId: string }).approvalId, 'deny');
    await adapter.dispose();
  });
});

describe('回放：生命周期与 resume', () => {
  it('关最后一个会话→重开：重新 initialize 且发送 initialized 通知（两次握手）', async () => {
    scenario([{ notifications: [{ kind: 'turn.completed', status: 'completed', finalText: 'ok' }] }]);
    adapter = mockAdapter();
    const s1 = await openMockSession(adapter);
    await adapter.close(s1); // 杀进程
    const s2 = await openMockSession(adapter); // 重建 + 重新握手
    expect(s2.providerSessionId).toMatch(/mock-thread-/);
    await adapter.dispose();

    const entries = rpcLogEntries();
    expect(entries.filter((e) => e['method'] === 'initialize').length).toBe(2);
    expect(entries.filter((e) => e['method'] === 'initialized').length).toBe(2);
  });

  it('openSession 带 resume → 发送 thread/resume 且携带 threadId（不再走 thread/start）', async () => {
    scenario([{ notifications: [{ kind: 'turn.completed', status: 'completed', finalText: 'ok' }] }]);
    adapter = mockAdapter();
    const session = await adapter.openSession({
      projectId: 'p1', memberId: 'm1', taskId: 't1', threadId: 'th1',
      sessionGeneration: 1, cwd: 'D:/mock', policyId: 'plan',
      resume: {
        id: 'prev-session', providerSessionId: 'mock-thread-resume-target',
        runtimeInstallationId: 'codex:mock', adapterVersion: 'v',
        threadId: 'th1', sessionGeneration: 0, cwd: 'D:/mock',
      },
    });
    expect(session.providerSessionId).toBe('mock-thread-resume-target');
    await adapter.dispose();
    const entries = rpcLogEntries();
    const resume = entries.find((e) => e['method'] === 'thread/resume');
    expect(resume).toBeDefined();
    expect((resume?.['params'] as Record<string, unknown>)?.['threadId']).toBe('mock-thread-resume-target');
    expect(entries.some((e) => e['method'] === 'thread/start')).toBe(false);
  });
});
