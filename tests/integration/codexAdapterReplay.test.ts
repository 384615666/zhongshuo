/**
 * DEV-06 修复轮：Codex 适配器协议回放反例（本地 mock app-server，零模型额度）。
 * 覆盖外部审查项：终态各态映射、工具真实 outcome、两轮串线/迟到、通知先于响应、
 * 审批归属（threadId 路由/错会话拒绝）、生命周期重建（重握手+initialized）、resume 接线。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_STRUCTURED_FINAL_INSTRUCTION, CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
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
    expect(events.find((e) => e.kind === 'turn.failed')).toMatchObject({
      code: 'INTERRUPTED',
      turnId: 'turn_1',
      terminalEvidence: { source: 'provider-turn-completed', status: 'interrupted', providerTurnId: 'mock-turn-1' },
    });
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
  it('同 provider thread 尚未绑定的启动请求不可并发发送', async () => {
    scenario([{ responseDelayMs: 80, notifications: [{ kind: 'turn.started' }, { kind: 'turn.completed', finalText: 'first' }] }]);
    adapter = mockAdapter();
    try {
      const first = await openMockSession(adapter);
      const second = await adapter.openSession({ projectId: 'p1', memberId: 'm1', taskId: 't1', threadId: 'th1', sessionGeneration: 1, cwd: 'D:/mock', policyId: 'plan', resume: first });
      const events = new SessionReader(adapter, first).readTurn();
      const starting = adapter.startTurn(first, turnRequest('first'));
      await expect(adapter.startTurn(second, turnRequest('second'))).rejects.toMatchObject({ notStarted: true });
      await starting;
      expect((await events).find(e => e.kind === 'turn.completed')).toMatchObject({ turnId: 'first' });
      expect(rpcLogEntries().filter(e => e['method'] === 'turn/start')).toHaveLength(1);
    } finally { await adapter.dispose(); }
  });

  for (const emitBeforeResponse of [false, true]) {
    it(`续接同一 provider thread 的新 session 接收新轮通知（early=${emitBeforeResponse}），旧轮迟到仍归旧 session`, async () => {
      scenario([
        { notifications: [{ kind: 'turn.started' }, { kind: 'turn.completed', finalText: 'first' }] },
        { emitBeforeResponse, notifications: [
          { kind: 'approvalRequest', params: { turnId: 'unknown-old-turn' } },
          { kind: 'tool.started', providerTurnId: 'unknown-old-turn', command: 'echo ghost' },
          { kind: 'lateMessage', providerTurnId: 'unknown-old-turn', text: 'ghost' },
          { kind: 'turn.started' },
          { kind: 'lateMessage', providerTurnId: 'mock-turn-1', text: 'late first' },
          { kind: 'approvalRequest' },
          { kind: 'tool.started', command: 'echo second' },
          { kind: 'agentMessage.completed', text: 'second' },
          { kind: 'turn.completed', finalText: 'second' },
        ] },
      ]);
      adapter = mockAdapter();
      try {
        const first = await openMockSession(adapter);
        const firstReader = new SessionReader(adapter, first);
        const firstResult = firstReader.readTurn();
        await adapter.startTurn(first, turnRequest('first'));
        await firstResult;
        const second = await adapter.openSession({
          projectId: 'p1', memberId: 'm1', taskId: 't1', threadId: 'th1',
          sessionGeneration: 1, cwd: 'D:/mock', policyId: 'plan', resume: first,
        });
        expect(second.id).not.toBe(first.id);
        expect(second.providerSessionId).toBe(first.providerSessionId);
        const events = await runOneTurn(adapter, second, 'second', 500);
        expect(events.find(e => e.kind === 'turn.started')).toMatchObject({ sessionId: second.id, turnId: 'second' });
        expect(events.find(e => e.kind === 'message.completed')).toMatchObject({ text: 'second', turnId: 'second' });
        expect(events.find(e => e.kind === 'turn.completed')).toMatchObject({ finalText: 'second', turnId: 'second' });
        const approval = events.find(e => e.kind === 'approval.requested');
        expect(approval).toMatchObject({ sessionId: second.id, turnId: 'second' });
        expect(events.find(e => e.kind === 'tool.started')).toMatchObject({ sessionId: second.id, turnId: 'second' });
        expect(events.filter(e => e.kind === 'approval.requested')).toHaveLength(1);
        expect(events.filter(e => e.kind === 'tool.started')).toHaveLength(1);
        expect(events.some(e => e.kind === 'message.completed' && e.text === 'ghost')).toBe(false);
        if (approval?.kind === 'approval.requested') {
          // The terminal was consumed above: both sessions must now see an expired token.
          await expect(adapter.respondApproval(first, approval.approvalId, 'deny')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
          await expect(adapter.respondApproval(second, approval.approvalId, 'deny')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
        }
        // The adapter write completes before the child has necessarily consumed
        // stdin and appended its receipt. Wait for that evidence, not a timer.
        await expect.poll(() => rpcLogEntries().find(e => e['id'] === 9000), {timeout:2000,interval:10})
          .toMatchObject({ result: { decision: 'decline' } });
        expect(rpcLogEntries().filter(e => e['id'] === 9001 && e['result'] != null)).toEqual([]);
        const late = await firstReader.next(500);
        expect(late).toMatchObject({ value: { kind: 'message.completed', text: 'late first', sessionId: first.id, turnId: 'first' } });
      } finally {
        await adapter.dispose();
      }
    });
  }

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
    ] }]);
    adapter = mockAdapter();
    try {
      const sessionA = await openMockSession(adapter); // mock-thread-1
      const sessionB = await openMockSession(adapter); // mock-thread-2
      const reader = new SessionReader(adapter, sessionA);
      await adapter.startTurn(sessionA, turnRequest('turn_appr'));
      let approval: Extract<NormalizedRuntimeEvent, { kind: 'approval.requested' }> | undefined;
      for (;;) {
        const next = await reader.next();
        if (next === 'timeout' || next.done) throw Error('Missing live approval before terminal');
        expect(['turn.completed', 'turn.failed']).not.toContain(next.value.kind);
        if (next.value.kind === 'approval.requested') { approval = next.value; break; }
      }
      expect(approval).toMatchObject({ turnId: 'turn_appr', sessionId: sessionA.id });
      await expect(adapter.respondApproval(sessionB, approval.approvalId, 'allow_once')).rejects.toMatchObject({ code: 'THREAD_SCOPE_MISMATCH' });
      await adapter.respondApproval(sessionA, approval.approvalId, 'deny');
      await expect.poll(() => rpcLogEntries().find(e => e['id'] === 9000 && e['result'] != null)).toMatchObject({ result: { decision: 'decline' } });
      expect(rpcLogEntries().filter(e => (e['result'] as { decision?: string } | undefined)?.decision === 'accept')).toEqual([]);
    } finally { await adapter.dispose(); }
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


describe('R87 native developer instructions', () => {
  for (const fullAccess of [false,true]) for (const resume of [false,true]) {
    it(`${fullAccess?'full':'readonly'} / ${resume?'resume':'first'} keeps system instructions out of user input`, async () => {
      scenario([{notifications:[{kind:'turn.completed',status:'completed',finalText:'ok'}]}]);
      adapter=mockAdapter();
      const session=await adapter.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:1,cwd:'D:/mock',policyId:'plan',
        developerInstructions:'R87_NATIVE_DEVELOPER_ONLY',writeAccess:{fullAccess,modificationAuthorized:fullAccess,allowedWriteRoots:[],identityKey:'test'},
        ...(resume?{resume:{id:'previous',providerSessionId:'r87-native-resume',runtimeInstallationId:'mock',adapterVersion:'old',threadId:'th',sessionGeneration:0,cwd:'D:/mock'}}:{}),
      });
      await runOneTurn(adapter,session,'r87-standing'); await adapter.dispose();
      const rows=rpcLogEntries(),start=rows.find(e=>e['method']===(resume?'thread/resume':'thread/start'));
      expect(start?.['params']).toMatchObject({sandbox:fullAccess?'danger-full-access':'read-only'});
      expect((start?.['params'] as Record<string,unknown>).developerInstructions).toContain('R87_NATIVE_DEVELOPER_ONLY');
      expect((start?.['params'] as Record<string,unknown>).developerInstructions).toContain(CODEX_STRUCTURED_FINAL_INSTRUCTION);
      const turns=rows.filter(e=>e['method']==='turn/start');
      expect(JSON.stringify(turns)).not.toContain('R87_NATIVE_DEVELOPER_ONLY');
      expect(JSON.stringify(turns)).not.toContain(CODEX_STRUCTURED_FINAL_INSTRUCTION);
    });
  }

  it('keeps outputSchema on the native turn request', async () => {
    scenario([{notifications:[{kind:'turn.completed',status:'completed',finalText:'{"ok":true}'}]}]);
    adapter=mockAdapter();
    const session=await adapter.openSession({
      projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:1,cwd:'D:/mock',policyId:'plan',
      developerInstructions:'BASE_DEVELOPER_INSTRUCTIONS',
    });
    const outputSchema={type:'object',additionalProperties:false,required:['ok'],properties:{ok:{type:'boolean'}}};
    const reader=new SessionReader(adapter,session);
    const collecting=reader.readTurn();
    await adapter.startTurn(session,{...turnRequest('turn_schema'),outputSchema});
    await collecting;
    await adapter.dispose();
    const start=rpcLogEntries().find(entry=>entry['method']==='turn/start');
    expect(start?.['params']).toMatchObject({outputSchema});
  });
});

describe('回放（修复轮 3）：真实协议形状反例', () => {
  it('双会话同时启动 turn：归属互不串扰', async () => {
    scenario([
      { notifications: [{ kind: 'turn.started' }, { kind: 'agentMessage.completed', text: '会话A的结果' }, { kind: 'turn.completed', status: 'completed', finalText: 'A完成' }] },
      { notifications: [{ kind: 'turn.started' }, { kind: 'agentMessage.completed', text: '会话B的结果' }, { kind: 'turn.completed', status: 'completed', finalText: 'B完成' }] },
    ]);
    adapter = mockAdapter();
    const sessionA = await openMockSession(adapter);
    const sessionB = await openMockSession(adapter);
    const readerA = new SessionReader(adapter, sessionA);
    const readerB = new SessionReader(adapter, sessionB);
    // 并发启动（Promise.all，两会话的 awaiting 互不覆盖）。
    const collectA = readerA.readTurn();
    const collectB = readerB.readTurn();
    await Promise.all([
      adapter.startTurn(sessionA, turnRequest('turn_sA')),
      adapter.startTurn(sessionB, turnRequest('turn_sB')),
    ]);
    const [eventsA, eventsB] = await Promise.all([collectA, collectB]);
    expect(eventsA.find((e) => e.kind === 'message.completed')?.text).toBe('会话A的结果');
    expect(eventsA.find((e) => e.kind === 'turn.completed')?.turnId).toBe('turn_sA');
    expect(eventsB.find((e) => e.kind === 'message.completed')?.text).toBe('会话B的结果');
    expect(eventsB.find((e) => e.kind === 'turn.completed')?.turnId).toBe('turn_sB');
    await adapter.dispose();
  });

  it('未知归属的终态（ghost turn）不影响当前轮：当前轮仍得到自己的终结', async () => {
    scenario([{ notifications: [
      // 先到一条无法归属的失败终态（turn.id=ghost，未登记）。
      { kind: 'unattributedTerminal', unknownTurnId: 'ghost-turn-999', status: 'failed', error: { kind: 'Ghost', message: '幽灵终态' } },
      { kind: 'agentMessage.completed', text: '当前轮正常消息' },
      { kind: 'turn.completed', status: 'completed', finalText: '当前轮完成' },
    ] }]);
    adapter = mockAdapter();
    const session = await openMockSession(adapter);
    // 连续读取（reader 跨多个终态）：幽灵终态后继续读，直到拿到归属当前轮的终结。
    const reader = new SessionReader(adapter, session);
    const reading = (async () => {
      const events: NormalizedRuntimeEvent[] = [];
      for (;;) {
        const next = await reader.next(4_000);
        if (next === 'timeout' || next.done) return events;
        events.push(next.value);
        if (next.value.kind === 'turn.completed' && next.value.turnId === 'turn_current') return events;
      }
    })();
    await adapter.startTurn(session, turnRequest('turn_current'));
    const events = await reading;
    // 无法精确归属的幽灵终态不进入当前会话。
    const ghost = events.find((e) => e.kind === 'turn.failed');
    expect(ghost).toBeUndefined();
    // 当前轮消息与终结归属正确。
    expect(events.find((e) => e.kind === 'message.completed')?.turnId).toBe('turn_current');
    const completed = events.find((e) => e.kind === 'turn.completed' && e.turnId === 'turn_current');
    expect(completed).toBeDefined();
    await adapter.dispose();
  });

  it('worker 側：未知归属终态不投递且不终结当前 turn（DispatchWorker×mock 集成）', async () => {
    const { openDatabase } = await import('../../src/persistence/db.ts');
    const { createRoomRootTask } = await import('../../src/persistence/stores/roomRootTask.ts');
    const { DispatchWorker } = await import('../../src/daemon/dispatchWorker.ts');
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m_human','p1','我','human',1),('m_a','p1','甲','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_1','p1','大厅','m_a')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room_1','p1','room','room_1')`).run();
    const t = createRoomRootTask(db, {
      ids: { messageId: 'msg_root_1', threadId: 'thread_1', taskId: 'task_1', taskEventId: 'e1', threadEventId: 'e2' },
      projectId: 'p1', conversationId: 'conv_room_1', roomId: 'room_1', intent: 'default',
      title: 'T', body: 'x', mentions: [{ kind: 'member', memberId: 'm_a' }],
      author: { authorType: 'human', authorId: 'm_human' }, reviewPolicy: 'auto_deliver',
      sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'm_a', frozenMemberIds: ['m_a'], initialWakeMemberIds: ['m_a'] } as never,
      now: 1,
    });
    if (!t.ok) throw new Error(t.error.message);
    scenario([{ notifications: [
      { kind: 'unattributedTerminal', unknownTurnId: 'ghost-turn-999', status: 'failed', error: { kind: 'Ghost', message: '幽灵失败' } },
      { kind: 'turn.completed', status: 'completed', finalText: JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: '{RESULT_KEY}', changeSummary: '当前轮完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) },
    ] }]);
    adapter = mockAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-replay', turnDeadlineMs: 8_000, interruptGraceMs: 2_000 });
    await worker.runOnce();
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_1')).toMatchObject({ status: 'DONE' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE task_id = ?').get('task_1')).toMatchObject({ status: 'SUCCEEDED' });
    const audit = db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'turn.unattributedTerminal'").get();
    expect(audit).toMatchObject({ c: 0 });
    await adapter.dispose();
    db.close();
  });
});


describe('R76 zero-call image protocol', () => {
  it('formal adapter sends inline image item, not filename or model-readable claim', async () => {
    scenario([{notifications:[{kind:'turn.completed',status:'completed'}]}]);adapter=mockAdapter();
    const session=await openMockSession(adapter);
    const raw=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=','base64');
    const {createHash}=await import('node:crypto');
    await adapter.startTurn(session,{...turnRequest('image',''),images:[{artifactId:'a',hash:createHash('sha256').update(raw).digest('hex'),mime:'image/png',dataBase64:raw.toString('base64')}]});
    const entry=rpcLogEntries().filter(e=>e['method']==='turn/start').at(-1)!;
    const params=entry['params'] as {input:Array<{type:string;url:string}>};
    expect(params.input).toHaveLength(1);expect(params.input[0]!.type).toBe('image');
    expect(params.input[0]!.url).toBe('data:image/png;base64,'+raw.toString('base64'));
    await adapter.dispose();
  });
});
