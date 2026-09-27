import { describe, expect, it } from 'vitest';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import {
  approvalTurn,
  failingTurn,
  lateFollowUp,
  stuckTurn,
  successTurn,
  unresponsiveTurn,
} from '../../src/adapter/fake/script.ts';
import { AdapterCallError } from '../../src/contracts/runtime.ts';
import type { NormalizedRuntimeEvent, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

function turnRequest(turnId: string): TurnRequest {
  return {
    turnId,
    dispatchKey: `dk-${turnId}`,
    inputBundleId: 'bundle-1',
    text: '请分析',
    policyId: 'policy-analyze',
    taskRevision: 1,
  };
}

async function openSession(adapter: FakeRuntimeAdapter): Promise<SessionRef> {
  return adapter.openSession({
    projectId: 'p1',
    memberId: 'm1',
    taskId: 't1',
    threadId: 'th1',
    sessionGeneration: 0,
    cwd: 'D:/fixture',
    policyId: 'policy-analyze',
  });
}

type EventIterator = AsyncIterator<NormalizedRuntimeEvent>;

/** 从迭代器当前位置读到终结事件（含其后紧随的 process.exited），返回收集到的事件。 */
async function readUntilTerminalFrom(
  iter: EventIterator,
  timeoutMs = 2000,
): Promise<NormalizedRuntimeEvent[]> {
  const collected: NormalizedRuntimeEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iter.next(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
    ]);
    if (next === 'timeout') return collected; // 窗口内无终结：原样返回，由调用方判定
    if (next.done) return collected;
    const event = next.value;
    collected.push(event);
    if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {
      const follow = await Promise.race([
        iter.next(),
        new Promise<'none'>((resolve) => setTimeout(() => resolve('none'), 50)),
      ]);
      if (follow !== 'none' && !follow.done && follow.value.kind === 'process.exited') {
        collected.push(follow.value);
      }
      return collected;
    }
  }
}

/** 消费事件流直到终结事件（含），返回收集到的事件（从积压头部开始）。 */
async function collectUntilTerminal(
  adapter: FakeRuntimeAdapter,
  session: SessionRef,
  timeoutMs = 2000,
): Promise<NormalizedRuntimeEvent[]> {
  return readUntilTerminalFrom(adapter.events(session)[Symbol.asyncIterator](), timeoutMs);
}

describe('fake adapter：成功 fixture', () => {
  it('完整事件序列：ready→started→delta→completed→usage→turn.completed', async () => {
    const adapter = new FakeRuntimeAdapter();
    const session = await openSession(adapter);
    await adapter.startTurn(session, turnRequest('turn_ok'));
    const events = await collectUntilTerminal(adapter, session);

    expect(events.map((e) => e.kind)).toEqual([
      'session.ready', 'turn.started', 'message.delta', 'message.completed',
      'usage.updated', 'turn.completed', 'process.exited',
    ]);
    expect(events.map((e) => e.eventKey)).toHaveLength(new Set(events.map((e) => e.eventKey)).size);
    const turnEvents = events.filter((e) => e.kind.startsWith('turn.'));
    expect(turnEvents.every((e) => e.turnId === 'turn_ok')).toBe(true);
    const completed = events.find((e) => e.kind === 'turn.completed');
    expect(completed).toMatchObject({ finalText: '分析完成' });
    expect(adapter.observe(session.id)?.activeTurnId).toBeNull();
  });

  it('订阅前的积压事件仍可读取（重连语义）', async () => {
    const adapter = new FakeRuntimeAdapter();
    const session = await openSession(adapter);
    await adapter.startTurn(session, turnRequest('turn_backlog'));
    // 等 turn 走完再订阅。
    await new Promise((r) => setTimeout(r, 20));
    const iter = adapter.events(session)[Symbol.asyncIterator]();
    const first = await iter.next();
    const second = await iter.next();
    expect(first.value?.kind).toBe('session.ready');
    expect(second.value?.kind).toBe('turn.started');
  });
});

describe('fake adapter：失败 fixture', () => {
  it('立即终结并携带 retryable', async () => {
    const adapter = new FakeRuntimeAdapter({ turnScripts: [failingTurn('QUOTA_EXCEEDED', '额度不足', true)] });
    const session = await openSession(adapter);
    await adapter.startTurn(session, turnRequest('turn_fail'));
    const events = await collectUntilTerminal(adapter, session);
    const failed = events.find((e) => e.kind === 'turn.failed');
    expect(failed).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: true });
  });
});

describe('fake adapter：审批 fixture（§9.6 最小确认通道）', () => {
  it('allow_once：确认后继续执行并成功', async () => {
    const adapter = new FakeRuntimeAdapter({
      turnScripts: [approvalTurn({ approvalId: 'appr_1', payloadHash: 'h1', finalText: '已写入' })],
    });
    const session = await openSession(adapter);
    const collecting = collectUntilTerminal(adapter, session);
    await adapter.startTurn(session, turnRequest('turn_appr'));
    // 等审批请求出现。
    await waitFor(() => adapter.observe(session.id)?.pendingApprovalId === 'appr_1');
    await adapter.respondApproval(session, 'appr_1', 'allow_once');
    const events = await collecting;
    expect(events.map((e) => e.kind)).toContain('approval.requested');
    expect(events.map((e) => e.kind)).toContain('tool.completed');
    expect(events.find((e) => e.kind === 'turn.completed')).toMatchObject({ finalText: '已写入' });
  });

  it('deny：拒绝后失败，无继续执行', async () => {
    const adapter = new FakeRuntimeAdapter({
      turnScripts: [approvalTurn({ approvalId: 'appr_2', payloadHash: 'h1' })],
    });
    const session = await openSession(adapter);
    const collecting = collectUntilTerminal(adapter, session);
    await adapter.startTurn(session, turnRequest('turn_deny'));
    await waitFor(() => adapter.observe(session.id)?.pendingApprovalId === 'appr_2');
    await adapter.respondApproval(session, 'appr_2', 'deny');
    const events = await collecting;
    expect(events.find((e) => e.kind === 'turn.failed')).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(events.some((e) => e.kind === 'tool.completed')).toBe(false);
  });

  it('无待审批时答复 → RESOURCE_NOT_FOUND', async () => {
    const adapter = new FakeRuntimeAdapter({ turnScripts: [successTurn()] });
    const session = await openSession(adapter);
    await expect(adapter.respondApproval(session, 'appr_x', 'allow_once')).rejects.toMatchObject({
      name: 'AdapterCallError',
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

describe('fake adapter：超时与停止 fixture', () => {
  it('stall 后 interrupt：正常响应中断 → INTERRUPTED 终结', async () => {
    const adapter = new FakeRuntimeAdapter({ turnScripts: [stuckTurn(10_000)] });
    const session = await openSession(adapter);
    const collecting = collectUntilTerminal(adapter, session);
    await adapter.startTurn(session, turnRequest('turn_stuck'));
    await new Promise((r) => setTimeout(r, 20));
    await adapter.interrupt(session, 'turn_stuck');
    const events = await collecting;
    expect(events.find((e) => e.kind === 'turn.failed')).toMatchObject({ code: 'INTERRUPTED' });
  });

  it('停止不响应：interrupt 仅标记，窗口内无终结事件、turn 保持活跃（WORKER_STILL_RUNNING 形态）', async () => {
    const adapter = new FakeRuntimeAdapter({ turnScripts: [unresponsiveTurn()] });
    const session = await openSession(adapter);
    const collecting = collectUntilTerminal(adapter, session, 150);
    await adapter.startTurn(session, turnRequest('turn_unresponsive'));
    await new Promise((r) => setTimeout(r, 20));
    await adapter.interrupt(session, 'turn_unresponsive');
    const events = await collecting; // 150ms 窗口：足以证明无终结事件

    const state = adapter.observe(session.id);
    expect(state).toMatchObject({
      activeTurnId: 'turn_unresponsive',
      interruptRequested: true,
      unresponsive: true,
    });
    expect(events.some((e) => e.kind === 'turn.completed' || e.kind === 'turn.failed')).toBe(false);
    await adapter.close(session);
  });

  it('迟到的 interrupt 目标已非活跃：零影响', async () => {
    const adapter = new FakeRuntimeAdapter({ turnScripts: [successTurn()] });
    const session = await openSession(adapter);
    await adapter.startTurn(session, turnRequest('turn_done'));
    await new Promise((r) => setTimeout(r, 20));
    await expect(adapter.interrupt(session, 'turn_done')).resolves.toBeUndefined();
    expect(adapter.observe(session.id)?.activeTurnId).toBeNull();
  });
});

describe('fake adapter：迟到事件 fixture', () => {
  it('turn1 完成后其迟到结果在 turn2 开始时送达，携带原 turnId', async () => {
    const adapter = new FakeRuntimeAdapter({
      turnScripts: [lateFollowUp(), successTurn('第二轮完成', 'msg_fake_2')],
    });
    const session = await openSession(adapter);
    // 同一迭代器分两阶段消费（消费方连续订阅语义）。
    const iter = adapter.events(session)[Symbol.asyncIterator]();
    await adapter.startTurn(session, turnRequest('turn_1'));
    const first = await readUntilTerminalFrom(iter);
    expect(first.some((e) => e.kind === 'turn.completed')).toBe(true);
    expect(first.some((e) => (e as { messageId?: string }).messageId === 'msg_late')).toBe(false);

    await adapter.startTurn(session, turnRequest('turn_2'));
    const events = await readUntilTerminalFrom(iter);

    const late = events.find(
      (e) => e.kind === 'message.completed' && e.messageId === 'msg_late',
    );
    expect(late).toBeDefined();
    expect(late?.turnId).toBe('turn_1'); // 归属原运行，不冒充新 turn 产物
    // 迟到事件在 turn2 开始之后才出现。
    const turn2Start = events.findIndex((e) => e.kind === 'turn.started');
    const lateIndex = events.findIndex((e) => (e as { messageId?: string }).messageId === 'msg_late');
    expect(lateIndex).toBeGreaterThan(turn2Start);
  });
});

describe('fake adapter：能力与生命周期边界', () => {
  it('steer 支持时被记录', async () => {
    const adapter = new FakeRuntimeAdapter();
    const session = await openSession(adapter);
    await adapter.steer(session, { ...turnRequest('turn_s'), text: '补充要求' });
    expect(adapter.observe(session.id)?.steers).toEqual([{ turnId: 'turn_s', text: '补充要求' }]);
  });

  it('interrupt 能力 unsupported → CAPABILITY_UNSUPPORTED', async () => {
    const adapter = new FakeRuntimeAdapter({ capabilities: { interrupt: 'unsupported' } });
    const session = await openSession(adapter);
    await expect(adapter.interrupt(session, 'any')).rejects.toBeInstanceOf(AdapterCallError);
    await expect(adapter.interrupt(session, 'any')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('steer 能力 unsupported → CAPABILITY_UNSUPPORTED', async () => {
    const adapter = new FakeRuntimeAdapter({ capabilities: { steerActiveTurn: 'unsupported' } });
    const session = await openSession(adapter);
    await expect(adapter.steer(session, turnRequest('x'))).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
  });

  it('同会话并发 turn → WORKSPACE_BUSY', async () => {
    const adapter = new FakeRuntimeAdapter({ turnScripts: [stuckTurn(5_000)] });
    const session = await openSession(adapter);
    await adapter.startTurn(session, turnRequest('turn_a'));
    await expect(adapter.startTurn(session, turnRequest('turn_b'))).rejects.toMatchObject({
      code: 'WORKSPACE_BUSY',
    });
    await adapter.close(session);
  });

  it('close 后事件流与会话操作失效（RESOURCE_NOT_FOUND）', async () => {
    const adapter = new FakeRuntimeAdapter();
    const session = await openSession(adapter);
    await adapter.close(session);
    expect(() => adapter.events(session)[Symbol.asyncIterator]()).toThrow(AdapterCallError);
  });

  it('probe 返回三态能力表（usageCost 默认 unsupported）', async () => {
    const adapter = new FakeRuntimeAdapter();
    const probe = await adapter.probe();
    expect(probe.version).toBe('fake-runtime-1.0.0');
    expect(probe.capabilities.structuredEvents).toBe('supported');
    expect(probe.capabilities.usageCost).toBe('unsupported');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}
