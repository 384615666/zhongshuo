/**
 * 第十六轮六：成员启停（协作参与设置）——member.setEnabled 正式闭环。
 * 协调者拒绝；停用成员不参与之后派发（在途不受影响=派发时点读取）；启用恢复；持久化（DB）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';

process.env.ZS_ALLOW_FAKE = '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-memberenabled-'));
describe('成员启停设置（member.setEnabled）', () => {
  it('协调者拒绝；停用后 DIRECT 指派失败如实（不派发）；启用恢复派发；持久化', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mCoord','p1','协调者','agent',1),('mX','p1','执行','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mCoord')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mCoord'),('r1','mX')`).run();
    const deps = { db, localUserId: 'u_me', interruptTurn: async () => {} };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `me-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: never; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    // 协调者停用=合法值校验拒绝（失败提示明确）。
    await expect(cmd('member.setEnabled', { memberId: 'mCoord', enabled: false })).rejects.toThrow(/协调者不可停用/);
    // 停用执行成员 → member.list 回读 enabled=false（读取面）。
    const off = await cmd('member.setEnabled', { memberId: 'mX', enabled: false }) as unknown as { enabled: boolean };
    expect(off.enabled).toBe(false);
    // 项目级列表（不经 room_members 过滤）
    const list = await cmd('member.list', { projectId: 'p1' }) as unknown as { items: Array<{ id: string; enabled: boolean }> };
    expect(list.items.find((x) => x.id === 'mX')?.enabled).toBe(false);
    // 停用后 message.submit @mX：路由阶段拒绝（enabledAgents 过滤——不派发不冒充）。
    await expect(cmd('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'c1', roomId: 'r1' }, body: 'B', intent: 'default', mentions: [{ kind: 'member', memberId: 'mX' }] })).rejects.toThrow();
    // 启用恢复 → 同提交成功（经命令面正式路由）→ 派发 DONE。
    await cmd('member.setEnabled', { memberId: 'mX', enabled: true });
    const submitted = await cmd('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'c1', roomId: 'r1' }, body: 'B2', intent: 'default', mentions: [{ kind: 'member', memberId: 'mX' }] }) as unknown as { taskId: string };
    expect(submitted.taskId).toBeTruthy();
    const worker = new DispatchWorker({ db, adapter: new FakeRuntimeAdapter(), leaseOwner: 'w-me', appDataDir: join(tmpRoot, 'app') });
    for (let i = 0; i < 6 && (await worker.runOnce()); i += 1);
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(submitted.taskId) as { status: string }).status).toBe('DONE');
    // 持久化（DB 事实，重开生效）。
    expect((db.prepare('SELECT enabled FROM project_members WHERE id = ?').get('mX') as { enabled: number }).enabled).toBe(1);
    db.close();
  }, 30_000);
});
afterAll(() => { for (let i = 0; i < 3; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* retry */ } } });
