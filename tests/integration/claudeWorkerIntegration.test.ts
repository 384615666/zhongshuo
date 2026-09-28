/**
 * Claude adapter × 共用 worker 集成（DEV-10，零额度）：
 * - **成员级 runtime 生产链路**：member.setRuntime 命令落库 → MemberRuntimeRegistry
 *   （project_members→agent_profiles→runtime_installations）→ DispatchWorker.adapterFor
 *   按成员选择 adapter——不再由全局 ZS_RUNTIME 决定所有成员；
 * - 同一 worker 两成员分别走 Claude CLI 回放与 fake，消息/会话互不串线；
 * - Claude 模拟器**读取本轮 stdin 输入**，按测试合同解析 resultKey 构造匹配 TaskComplete——
 *   跨 runtime 成功链路走完 schema 校验与任务交付（DONE），不再以 resultKey 不可预知为由停在 OUTPUT_INVALID；
 * - 保留错误 resultKey 拒绝反例（turn.outputInvalid，不冒充完成）。
 * 本阶段不标"Claude 真实认证通过"（模拟进程回放）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { ClaudeCliAdapter } from '../../src/adapter/claude/cliAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { MemberRuntimeRegistry } from '../../src/daemon/memberRuntime.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { randomUUID } from 'node:crypto';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-claudeworker-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
// fake runtime 显式开发模式（member.setRuntime 的 fake 档门禁；vitest 每文件独立进程）。
process.env.ZS_ALLOW_FAKE = '1';

/**
 * Claude 回放进程：读取本轮 stdin 输入（prompt 全文），从输出契约行解析
 * `"resultKey":"result_<turnId>"`，按合同构造匹配的 TaskComplete 结构化结果。
 * mode='wrong' 时故意输出错误 resultKey（拒绝反例）。
 */
function claudeContractProc(mode: 'match' | 'wrong'): (args: string[], cwd: string) => ChildProcessWithoutNullStreams {
  return () => {
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
      kill: () => { ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(null); },
      setEncoding: () => undefined,
      _run: async () => {
        await new Promise((r) => setTimeout(r, 30));
        const input = stdinChunks.join('');
        const parsed = /"resultKey":"(result_[0-9a-zA-Z_-]+)"/.exec(input);
        const resultKey = mode === 'match' ? (parsed?.[1] ?? 'result_parse_failed') : 'result_wrong_key';
        const text = JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey, changeSummary: 'claude 回放：读取输入合同并匹配 resultKey',
          files: [], executedVerifications: ['stdin 输入合同解析'], unexecutedVerifications: [], remainingIssues: [],
        });
        (fake.stdout as EventEmitter & { emit: (e: string, d: string) => boolean }).emit('data',
          `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude 输出', id: 'cm1' }] } })}\n`);
        (fake.stdout as EventEmitter & { emit: (e: string, d: string) => boolean }).emit('data',
          `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cs_w1', result: text, model: 'deepseek-flash', usage: { input_tokens: 7, output_tokens: 3 } })}\n`);
        ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(0);
      },
    };
    setImmediate(() => void (fake as unknown as { _run: () => Promise<void> })._run());
    return fake as unknown as ChildProcessWithoutNullStreams;
  };
}

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m_claude','p1','克劳德','agent',1),('m_fake','p1','费克','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m_claude')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
}

function makeTask(db: ZhongshuoDatabase, n: number, memberId: string): string {
  const ids = { messageId: `msg${n}`, threadId: `th${n}`, taskId: `tk${n}`, taskEventId: `et${n}`, threadEventId: `eh${n}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] },
    now: n,
  });
  return ids.taskId;
}

async function runCommand(db: ZhongshuoDatabase, method: string, params: unknown): Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> {
  const envelope = { protocolVersion: 1 as const, commandId: `cmd-${randomUUID()}`, method, params };
  return dispatchDaemonCommand({ db, localUserId: 'u_test', interruptTurn: async () => {} }, envelope) as Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>;
}

describe('跨 runtime 成员绑定 × 共用 worker（生产 registry，零额度回放）', () => {
  it('member.setRuntime 落库 → registry 按成员选 adapter：Claude 回放按 stdin 合同匹配 resultKey 全链 DONE；fake 并行 DONE；互不串线', async () => {
    const db = openDatabase(':memory:');
    seed(db);

    // 服务端保存的成员配置（正式命令路径，非测试注入直写）。
    const setC = await runCommand(db, 'member.setRuntime', { memberId: 'm_claude', kind: 'claude', model: 'deepseek-flash', permissionMode: 'plan' });
    expect(setC.ok, JSON.stringify(setC.error)).toBe(true);
    const setF = await runCommand(db, 'member.setRuntime', { memberId: 'm_fake', kind: 'fake' });
    expect(setF.ok, JSON.stringify(setF.error)).toBe(true); // ZS_ALLOW_FAKE=1（测试环境显式）

    // 生产 registry：DB 绑定链 + adapter 工厂；未绑定成员回落默认（fake——测试环境）。
    const defaultAdapter = new FakeRuntimeAdapter();
    const registry = new MemberRuntimeRegistry(db, defaultAdapter, {
      claude: (binding) => new ClaudeCliAdapter(
        { model: binding.model ?? 'deepseek-flash', permissionMode: 'plan', installationId: binding.installationId ?? undefined },
        claudeContractProc('match'),
      ),
      fake: () => new FakeRuntimeAdapter(),
    });

    makeTask(db, 1, 'm_claude');
    makeTask(db, 2, 'm_fake');

    // 单一共用 worker：派发时按成员绑定选择 adapter（adapterFor 生产接线）。
    const worker = new DispatchWorker({
      db, adapter: defaultAdapter, leaseOwner: 'w-rt',
      adapterFor: (memberId) => registry.adapterFor(memberId),
      appDataDir: join(tmpRoot, 'shared'),
    });
    for (let i = 0; i < 8 && (await worker.runOnce()); i += 1);

    const tasks = db.prepare('SELECT id, status FROM tasks ORDER BY id').all() as Array<{ id: string; status: string }>;
    expect(tasks.find((t) => t.id === 'tk1')!.status).toBe('DONE'); // Claude 回放：schema+resultKey 全链通过
    expect(tasks.find((t) => t.id === 'tk2')!.status).toBe('DONE'); // fake：默认脚本结构化终态

    // 会话与消息不串线：两个 runtime_sessions 各自成员；回复各归各线程。
    const sessions = db.prepare('SELECT member_id FROM runtime_sessions ORDER BY member_id').all() as Array<{ member_id: string }>;
    expect(sessions.map((s) => s.member_id).sort()).toEqual(['m_claude', 'm_fake']);
    const replies = db.prepare('SELECT thread_id, author_id FROM messages WHERE author_type = ? ORDER BY thread_id').all('agent') as Array<{ thread_id: string; author_id: string }>;
    for (const r of replies) {
      expect(r.thread_id).toBe(r.author_id === 'm_fake' ? 'th2' : 'th1');
    }
    // usage 落库含响应模型（result.model 透传取证）。
    const usage = db.prepare("SELECT normalized_json FROM usage_records WHERE turn_id IN (SELECT id FROM agent_turns WHERE member_id = 'm_claude')").all() as Array<{ normalized_json: string }>;
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(usage[0]!.normalized_json).model).toBe('deepseek-flash');

    await defaultAdapter.closeAllSessions();
    await registry.disposeAll();
    db.close();
  }, 30_000);

  it('拒绝反例：Claude 输出错误 resultKey → turn.outputInvalid，任务不 DONE（不冒充完成）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const setC = await runCommand(db, 'member.setRuntime', { memberId: 'm_claude', kind: 'claude', model: 'deepseek-flash' });
    expect(setC.ok).toBe(true);
    const defaultAdapter = new FakeRuntimeAdapter();
    const registry = new MemberRuntimeRegistry(db, defaultAdapter, {
      claude: (binding) => new ClaudeCliAdapter({ model: binding.model ?? 'deepseek-flash' }, claudeContractProc('wrong')),
      fake: () => new FakeRuntimeAdapter(),
    });
    makeTask(db, 1, 'm_claude');
    const worker = new DispatchWorker({
      db, adapter: defaultAdapter, leaseOwner: 'w-bad',
      adapterFor: (memberId) => registry.adapterFor(memberId),
      appDataDir: join(tmpRoot, 'bad'),
    });
    for (let i = 0; i < 4 && (await worker.runOnce()); i += 1);
    const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get('tk1') as { id: string; status: string };
    expect(['ACTIVE', 'BLOCKED']).toContain(task.status); // 输出合同拒绝：不 DONE
    const turn = db.prepare("SELECT status FROM agent_turns WHERE member_id = 'm_claude'").get() as { status: string };
    expect(turn.status).toBe('FAILED');
    const audited = db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'turn.outputInvalid'").get() as { c: number };
    expect(audited.c).toBeGreaterThanOrEqual(1);
    await defaultAdapter.closeAllSessions();
    await registry.disposeAll();
    db.close();
  }, 30_000);

  it('线程工具审计：fake tool 事件→worker 落库→thread.toolCalls 呈现（隔离/去重/成员归属）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const adapter = new FakeRuntimeAdapter({
      turnScriptSequencer: () => ([
        { kind: 'event', event: { kind: 'tool.started', toolCallId: 'tool_read_1', toolName: 'Read', argumentsSummary: '' } },
        { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'tool_read_1', outcome: 'success' } },
        // 迟到/重复：同 toolCallId 的重复 completed 不得生成第二张卡（服务端取末值去重）。
        { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'tool_read_1', outcome: 'unknown' } },
        { kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } },
      ]),
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-tool', appDataDir: join(tmpRoot, 'tool') });
    makeTask(db, 5, 'm_fake');
    makeTask(db, 6, 'm_fake'); // 另一线程：不串记录
    await worker.runOnce();
    await new Promise((r) => setTimeout(r, 150));
    const r5 = await runCommand(db, 'thread.toolCalls', { threadId: 'th5' }) as { data: { items: Array<{ toolCallId: string; toolName: string | null; outcome: string | null; memberId: string | null; turnId: string | null }> } };
    expect(r5.data.items.length).toBe(1); // 去重：一次 toolCallId 一张卡
    const item = r5.data.items[0]!;
    expect(item).toMatchObject({ toolCallId: 'tool_read_1', toolName: 'Read', memberId: 'm_fake' });
    expect(item.outcome).toBe('unknown'); // 迟到重复取末值（如实）
    expect(item.turnId).toBeTruthy();
    const r6 = await runCommand(db, 'thread.toolCalls', { threadId: 'th6' }) as { data: { items: unknown[] } };
    expect(r6.data.items.length).toBe(0); // 线程隔离：th6 无记录
    await adapter.closeAllSessions();
    db.close();
  }, 15_000);

  it('绑定不可用 kind（daemon 未注册工厂）→ 派发如实失败，不静默换 runtime', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const setX = await runCommand(db, 'member.setRuntime', { memberId: 'm_claude', kind: 'claude', model: 'deepseek-flash' });
    expect(setX.ok).toBe(true);
    const defaultAdapter = new FakeRuntimeAdapter();
    // 故意不注册 claude 工厂（模拟旧 daemon 不认识新 kind）。
    const registry = new MemberRuntimeRegistry(db, defaultAdapter, { fake: () => new FakeRuntimeAdapter() });
    expect(() => registry.adapterFor('m_claude')).toThrow(/不可用/);
    await defaultAdapter.closeAllSessions();
    db.close();
  });
});
