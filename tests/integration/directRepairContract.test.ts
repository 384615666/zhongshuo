/**
 * DIRECT 输出合同修复链（第六轮，worker 正式路径，零额度）：
 * - 单层围栏规范化：仅剥「包裹整个文本」的一对 ``` 围栏，剥壳后走**同一**严格 schema；
 *   围栏外有正文/散文/附加键一律照旧拒绝（原始输出保留）——正反例全覆盖；
 * - formatRepair（task.redispatch formatRepair:true）：守卫（上 turn FAILED+outputInvalid、
 *   每任务一次）+ 修复上下文注入（原输出全文+校验错误+字段用途——不叫模型删短内容）；
 * - 修复耗尽收口：修复 turn 再失败 → 任务 BLOCKED（不再表现为可执行）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { stripSingleJsonFence } from '../../src/daemon/dispatchWorker.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-direct-repair-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

function makeTask(db: ZhongshuoDatabase, n: number): string {
  const ids = { messageId: `rm${n}`, threadId: `th${n}`, taskId: `tk${n}`, taskEventId: `re${n}`, threadEventId: `te${n}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: n,
  });
  return ids.taskId;
}

async function cmd<T>(db: ZhongshuoDatabase, method: string, params: unknown): Promise<T> {
  const r = await dispatchDaemonCommand(
    { db, localUserId: 'u_test', interruptTurn: async () => {} },
    { protocolVersion: 1, commandId: `cmd-dr-${randomUUID().slice(0, 8)}`, method, params },
  ) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

function rig(scripts: FakeTurnScript[]) {
  const db = openDatabase(':memory:');
  seed(db);
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? [{ kind: 'event', event: { kind: 'turn.completed', finalText: '兜底' } }] });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-dr', appDataDir: join(tmpRoot, 'a') });
  return { db, adapter, worker, scripts };
}

const validComplete = (resultKey: string, summary = '完成：三条结论均附行号依据。') =>
  JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey, changeSummary: summary, files: ['notes.md'], executedVerifications: ['读取 notes.md 并核对行号'], unexecutedVerifications: [], remainingIssues: [] });

describe('单层围栏规范化（worker 正式路径）', () => {
  it('纯函数：整文本单层围栏剥壳；内部含围栏/围栏外正文不剥', () => {
    const wrapped = '```json\n{"a":1}\n```';
    expect(stripSingleJsonFence(wrapped)).toEqual({ text: '{"a":1}', normalized: true });
    expect(stripSingleJsonFence('```\n{"a":1}\n```')).toEqual({ text: '{"a":1}', normalized: true });
    // 围栏外有正文（前缀/后缀）→ 不剥。
    expect(stripSingleJsonFence('说明如下：\n```json\n{"a":1}\n```').normalized).toBe(false);
    expect(stripSingleJsonFence('```json\n{"a":1}\n```\n补充说明').normalized).toBe(false);
    // 内部还有围栏 → 非单层包裹，不剥。
    expect(stripSingleJsonFence('```json\n{"a":"x```y"}\n```').normalized).toBe(false);
    expect(stripSingleJsonFence('纯散文').normalized).toBe(false);
  });

  it('正例：围栏包裹的合法 TaskComplete → 剥壳过校验（turn.outputNormalized 留审计）', async () => {
    const { db, worker, scripts } = rig([]);
    const taskId = makeTask(db, 1);
    const rk = (db.prepare('SELECT id FROM agent_turns LIMIT 1').get() as { id: string } | undefined)?.id;
    void rk;
    // resultKey 依赖 turnId（运行时生成）——用 sequencer 动态读取输入契约里的 resultKey。
    const adapter2 = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '```json\n' + validComplete(key) + '\n```' } }];
      },
    });
    const worker2 = new DispatchWorker({ db, adapter: adapter2, leaseOwner: 'w-dr2', appDataDir: join(tmpRoot, 'b') });
    await worker2.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    const norm = db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.outputNormalized'`).get() as { c: number };
    expect(norm.c).toBe(1); // 规范化留审计（原始长度+规则）
    void worker;
    void scripts;
    db.close();
  }, 15_000);

  it('反例：围栏外带正文 → 照旧拒绝；散文/附加键 → 照旧拒绝（原始输出保留）', async () => {
    const { db, worker } = rig([]);
    const taskId = makeTask(db, 2);
    const adapter2 = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '```json\n' + validComplete(key) + '\n```\n以上为结果。' } }];
      },
    });
    const worker2 = new DispatchWorker({ db, adapter: adapter2, leaseOwner: 'w-dr3', appDataDir: join(tmpRoot, 'c') });
    await worker2.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');
    expect((db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.outputInvalid'`).get() as { c: number }).c).toBe(1);
    void worker;
    db.close();
  }, 15_000);
});

describe('formatRepair 修复绑定（命令守卫+上下文注入+耗尽收口）', () => {
  it('完整链：首 turn 附加键被拒 → formatRepair（输入含原输出全文+校验错误+指引）→ 修正后 DONE', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 3);
    let turnCount = 0;
    let capturedInput = '';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        if (turnCount === 1) {
          // A 组真实失败形态：合法 JSON + 附加 conclusions 键（先落消息再终局——真实批次同构）。
          const out = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: '完成分析', files: ['notes.md'], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], conclusions: ['结论一（依据 L3）', '结论二（依据 L5）'] });
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: 'm_bad', text: out } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
          ];
        }
        capturedInput = input.text;
        // 修复轮：按指引把结论并入 changeSummary（内容不删短）。
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key, '完成分析。结论：结论一（依据 L3）；结论二（依据 L5）。') } }];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-fr', appDataDir: join(tmpRoot, 'd') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');
    // 守卫反例：非 FAILED 前置不可用（此刻上 turn FAILED ✓ 可用——先测错误路径：对无任务 id）。
    await expect(cmd(db, 'task.redispatch', { taskId: 'tk_missing', formatRepair: true })).rejects.toThrow(/不存在/);
    const ack = await cmd<{ enqueued: boolean; formatRepair: boolean }>(db, 'task.redispatch', { taskId, formatRepair: true, reason: '测试修复' });
    expect(ack.formatRepair).toBe(true);
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    // 修复绑定证据：修复轮输入包含原输出全文+校验错误+字段指引。
    expect(capturedInput).toContain('【格式修复轮】');
    expect(capturedInput).toContain('Unrecognized key'); // 校验错误原文
    expect(capturedInput).toContain('结论二（依据 L5）'); // 原输出全文（不截短）
    expect(capturedInput).toContain('不要缩短或删除内容'); // 指引=搬字段，不是删短
    // 每任务一次：再修被结构化拒绝。
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true })).rejects.toThrow(/已用过一次格式修复|已终态/);
    db.close();
  }, 20_000);

  it('守卫：上 turn 非 FAILED（SUCCEEDED 后）不可 formatRepair；耗尽收口：修复轮再失败 → BLOCKED', async () => {
    const { db } = rig([]);
    const taskId = makeTask(db, 4);
    let turnCount = 0;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        if (turnCount === 1) return [{ kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key) } }];
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '仍然不是 JSON' } }];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-fr2', appDataDir: join(tmpRoot, 'e') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    // 任务终态：任何 redispatch 都不可。
    await expect(cmd(db, 'task.redispatch', { taskId, formatRepair: true })).rejects.toThrow(/已终态/);

    // 耗尽收口：另一任务首 turn 失败→formatRepair→再失败→BLOCKED（不再 ACTIVE 表现为可执行）。
    const taskId2 = makeTask(db, 5);
    const adapter2 = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        void key;
        return [{ kind: 'event', event: { kind: 'turn.completed', finalText: '一直都不是 JSON' } }];
      },
    });
    const worker2 = new DispatchWorker({ db, adapter: adapter2, leaseOwner: 'w-fr3', appDataDir: join(tmpRoot, 'f') });
    await worker2.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as { status: string }).status).toBe('ACTIVE');
    await cmd(db, 'task.redispatch', { taskId: taskId2, formatRepair: true, reason: '再修一次' });
    await worker2.runOnce();
    const finalStatus = (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as { status: string }).status;
    expect(finalStatus).toBe('BLOCKED'); // 修复耗尽：收口为 BLOCKED（UI 不再表现为正在执行/可执行）
    const blockedEvt = db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'task.statusChanged' AND payload_json LIKE '%direct-repair-exhausted%'`).get() as { c: number };
    expect(blockedEvt.c).toBeGreaterThanOrEqual(1);
    db.close();
  }, 20_000);
});
