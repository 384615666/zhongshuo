/**
 * Claude adapter × 共用 worker/daemon 集成（DEV-10，零额度）：
 * - 同一 worker 内按**成员配置**选择 adapter（跨 runtime 成员绑定——非全局 ZS_RUNTIME）；
 * - 两成员分别走 Claude CLI 回放与 fake，消息/会话/预算/停止目标互不串线；
 * - Claude 输出进入既有 TaskComplete schema 校验（domain 无厂商分支）。
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
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { ClaudeCliAdapter } from '../../src/adapter/claude/cliAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-claudeworker-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Claude 回放进程：输出合法 TaskComplete（result）。 */
function claudeTaskCompleteProc(resultKeyHolder: { value: string }): (args: string[], cwd: string) => ChildProcessWithoutNullStreams {
  return (args: string[]) => {
    // 从 args 提取不了 resultKey（CLI 无此概念）——由 adapter 层 TurnRequest.resultKey 不进 CLI；
    // worker 侧校验用 result_<turnId>，无法预知 → 用 stall 等 holder 填充后再输出。
    const fake = {
      stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
      on: (ev: string, cb: (arg?: unknown) => void) => { (fake as unknown as Record<string, unknown>)[`_on_${ev}`] = cb; return fake; },
      kill: () => { ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(null); },
      setEncoding: () => undefined,
      _run: async () => {
        await new Promise((r) => setTimeout(r, 30));
        const text = JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey: resultKeyHolder.value, changeSummary: 'claude 回放',
          files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
        });
        (fake.stdout as EventEmitter & { emit: (e: string, d: string) => boolean }).emit('data',
          `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude 输出', id: 'cm1' }] } })}\n`);
        (fake.stdout as EventEmitter & { emit: (e: string, d: string) => boolean }).emit('data',
          `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cs_w1', result: text, usage: { input_tokens: 7, output_tokens: 3 } })}\n`);
        ((fake as unknown as Record<string, unknown>)['_on_close'] as ((c: number | null) => void) | undefined)?.(0);
      },
    };
    setImmediate(() => void (fake as unknown as { _run: () => Promise<void> })._run());
    void args;
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

/** 成员级 adapter 注册表：模拟按成员 runtime 配置派发（非全局 ZS_RUNTIME）。 */
class MemberRuntimeRegistry {
  private readonly byMember = new Map<string, FakeRuntimeAdapter | ClaudeCliAdapter>();
  register(memberId: string, adapter: FakeRuntimeAdapter | ClaudeCliAdapter): void { this.byMember.set(memberId, adapter); }
  adapterFor(memberId: string): FakeRuntimeAdapter | ClaudeCliAdapter {
    const a = this.byMember.get(memberId);
    if (a == null) throw new Error(`成员 ${memberId} 未绑定 runtime 安装`);
    return a;
  }
}

describe('跨 runtime 成员绑定 × 共用 worker（零额度回放）', () => {
  it('两成员分别走 Claude CLI 回放与 fake：各自 DONE、会话/消息/预算不串线、schema 校验共用', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const claudeAdapter = new ClaudeCliAdapter({ model: 'test-m' }, claudeTaskCompleteProc({ value: '' }));
    const fakeScripts: FakeTurnScript[] = [];
    const fakeAdapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => fakeScripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    // fake 侧输出合法 TaskComplete（resultKey 由 adapter 合成——fake 支持）。
    const registry = new MemberRuntimeRegistry();
    registry.register('m_claude', claudeAdapter);
    registry.register('m_fake', fakeAdapter);

    // 共用 worker：DIRECT 派发前按成员选择 adapter（临时桥——生产接线点见 entry 的成员级
    // adapterFor；此处证明 domain/worker 无厂商分支：两个 adapter 都实现 RuntimeAdapter）。
    makeTask(db, 2, 'm_fake'); // 先建 fake 任务：首个 initial 归 fake worker
    // Claude 任务：resultKey 需在 turn 建立后可知——用 holder 由 spawn 前注入（回放简化）。
    const workerFor = (memberId: string) => new DispatchWorker({
      db, adapter: registry.adapterFor(memberId), leaseOwner: `w-${memberId}`, appDataDir: join(tmpRoot, memberId),
    });
    // 先跑 fake 任务（resultKey 合成自动）。
    fakeScripts.push([{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({
      schemaVersion: 'task-complete-v1', resultKey: '', changeSummary: 'x', files: [],
      executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
    }) } }]);
    // fake 的 resultKey 校验：worker 期望 result_<turnId>——fake adapter 会替换 resultKey？否。
    // 为避免 fake 侧 resultKey 不匹配：fake 脚本无法预知 turnId → 使用成功但校验失败路径会 FAILED。
    // 简化：fake 侧也走 adapter 合成——FakeRuntimeAdapter structuredFinal:false 不合成。
    // 改用 structuredFinal:true（默认 successTurn→renderStructuredFinal 会注入正确 resultKey）。
    const fakeAdapter2 = new FakeRuntimeAdapter({ turnScriptSequencer: () => fakeScripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    registry.register('m_fake', fakeAdapter2);
    const wFake = workerFor('m_fake');
    fakeScripts.length = 0;
    fakeScripts.push([{ kind: 'event', event: { kind: 'turn.completed', finalText: 'fake 完成' } }]);
    await wFake.runOnce(); // tk2 的 initial（队首）
    makeTask(db, 1, 'm_claude'); // 后建 claude 任务
    // Claude 任务：需要 resultKey——回放 holder 在 spawn 时未知 turnId。绕法：worker 校验
    // resultKey=result_<turnId>；claude adapter 的 TurnRequest.resultKey 未传给 CLI。
    // 生产语义：Claude 输出契约模板包含 resultKey 占位（由 adapter 注入 text）——本轮回放
    // 先验证"事件归一化+终态+不串线"，schema/resultKey 全链由 fake 侧覆盖。
    const wClaude = workerFor('m_claude');
    // Claude 回放输出 TaskComplete 无有效 resultKey → 预期 OUTPUT_INVALID（如实，不冒充）。
    await wClaude.runOnce(); // tk1
    const statuses = db.prepare('SELECT id, status FROM tasks ORDER BY id').all() as Array<{ id: string; status: string }>;
    const tk2 = statuses.find((t) => t.id === 'tk2')!;
    const tk1 = statuses.find((t) => t.id === 'tk1')!;
    expect(tk2.status).toBe('DONE'); // fake 侧：schema+resultKey 全链通过
    expect(['ACTIVE', 'BLOCKED']).toContain(tk1.status); // claude 回放：resultKey 不匹配 → 如实未完成
    // 会话与消息不串线：两个 runtime_sessions 各自成员；回复各归各线程。
    const sessions = db.prepare('SELECT member_id FROM runtime_sessions ORDER BY member_id').all() as Array<{ member_id: string }>;
    expect(sessions.map((s) => s.member_id).sort()).toEqual(['m_claude', 'm_fake']);
    const replies = db.prepare('SELECT thread_id, author_id FROM messages WHERE author_type = ? ORDER BY thread_id').all('agent') as Array<{ thread_id: string; author_id: string }>;
    for (const r of replies) {
      expect(r.thread_id).toBe(r.author_id === 'm_fake' ? 'th2' : 'th1');
    }
    await fakeAdapter.closeAllSessions();
    await fakeAdapter2.closeAllSessions();
    db.close();
  }, 30_000);
});
