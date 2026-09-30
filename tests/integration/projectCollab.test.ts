/**
 * 第十七轮三：项目协作限制（§17.8）——project.collab.get/set 正式闭环+执行侧真实消费。
 * 校验（范围/类型）/CAS 版本冲突/持久化（文件库重开）/单轮时限按项目生效（项目值先于全局
 * 默认触发 UNKNOWN——执行侧消费证明，非只存字段）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';

process.env.ZS_ALLOW_FAKE = '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-collab-'));
afterAll(() => { for (let i = 0; i < 3; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

function seed(db: ReturnType<typeof openDatabase>, review = 0): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at, task_review_enabled) VALUES ('p1','d',?,?,'{}',0,?)`).run(tmpRoot, tmpRoot, review);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mX','p1','执行','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mX')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mX')`).run();
}

describe('项目协作限制（project.collab）', () => {
  it('get/set 闭环：默认 NULL；写读；范围校验拒绝；CAS 冲突；清空回落；事件留痕；重开持久', async () => {
    const dir = join(tmpRoot, 'persist');
    mkdirSync(dir, { recursive: true });
    const db = openDatabase(join(dir, 'state.sqlite'));
    seed(db);
    const deps = { db, localUserId: 'u', interruptTurn: async () => {} };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `cb-${randomUUID()}`, method: m, params: p }) as { ok: boolean; data?: never; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    const g0 = (await cmd('project.collab.get', { projectId: 'p1' })) as unknown as { revision: number; absenceToleranceMs: number | null; turnDeadlineMs: number | null };
    expect(g0.absenceToleranceMs).toBeNull();
    expect(g0.turnDeadlineMs).toBeNull(); // 默认=回落全局
    const s1 = (await cmd('project.collab.set', { projectId: 'p1', absenceToleranceMs: 1_200_000, turnDeadlineMs: 300_000, expectedRevision: g0.revision })) as unknown as { revision: number; absenceToleranceMs: number; turnDeadlineMs: number };
    expect(s1.absenceToleranceMs).toBe(1_200_000);
    expect(s1.turnDeadlineMs).toBe(300_000);
    // 范围/类型校验（服务端）。
    await expect(cmd('project.collab.set', { projectId: 'p1', turnDeadlineMs: 5_000, expectedRevision: s1.revision })).rejects.toThrow();
    await expect(cmd('project.collab.set', { projectId: 'p1', turnDeadlineMs: 90_000_000, expectedRevision: s1.revision })).rejects.toThrow();
    // CAS 冲突（旧 revision）。
    await expect(cmd('project.collab.set', { projectId: 'p1', turnDeadlineMs: 600_000, expectedRevision: g0.revision })).rejects.toThrow(/版本冲突/);
    // 清空回落默认（null）。
    const s2 = (await cmd('project.collab.set', { projectId: 'p1', turnDeadlineMs: null, expectedRevision: s1.revision })) as unknown as { turnDeadlineMs: number | null };
    expect(s2.turnDeadlineMs).toBeNull();
    const evts = db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'project.collabUpdated'`).get() as { c: number };
    expect(evts.c).toBeGreaterThanOrEqual(2);
    db.close();
    // 重开持久。
    const db2 = openDatabase(join(dir, 'state.sqlite'));
    const r2 = (await dispatchDaemonCommand({ db: db2, localUserId: 'u', interruptTurn: async () => {} }, { protocolVersion: 1, commandId: `cb-${randomUUID()}`, method: 'project.collab.get', params: { projectId: 'p1' } })) as unknown as { data: { absenceToleranceMs: number | null } };
    const g2 = r2.data;
    expect(g2.absenceToleranceMs).toBe(1_200_000);
    db2.close();
  }, 30_000);

  it('执行侧消费：项目 turnDeadline（2.5s）先于全局默认（60s）触发——turn 按项目值转 UNKNOWN', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const deps = { db, localUserId: 'u', interruptTurn: async () => {} };
    const setR = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `cb-${randomUUID()}`, method: 'project.collab.set', params: { projectId: 'p1', turnDeadlineMs: 10_000, expectedRevision: 0 } });
    expect((setR as { ok: boolean }).ok, JSON.stringify(setR).slice(0, 120)).toBe(true); // 范围下限 10s（服务端校验）
    createRoomRootTask(db, {
      ids: { messageId: 'm1', threadId: 'th1', taskId: 'tk1', taskEventId: 'e1', threadEventId: 'e2' },
      projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default', title: 'T', body: 'B',
      mentions: [{ kind: 'member', memberId: 'mX' }], author: { authorType: 'human', authorId: 'u' },
      reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mX', frozenMemberIds: ['mX'], initialWakeMemberIds: ['mX'] }, now: 1,
    });
    // stall 脚本：永不终态——只有到点时限能结束它。
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'stall', ms: 30_000 }] });
    const t0 = Date.now();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-cb', turnDeadlineMs: 60_000, detachedTurnConsumption: false, appDataDir: join(tmpRoot, 'app') }); // 全局 60s；项目 2.5s 必须胜出
    await worker.runOnce();
    const elapsed = Date.now() - t0;
    const turn = db.prepare('SELECT status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)').get('tk1') as { status: string };
    expect(turn.status).toBe('UNKNOWN'); // 单轮硬保护按项目值触发（不伪造结果）
    expect(elapsed).toBeLessThan(30_000); // 项目值 10s 先于全局 60s 触发——证明消费的是项目值
    db.close();
  }, 60_000);
});
