/**
 * 第十六轮四：runtime 派发硬隔离（ZS_REAL_DISPATCH_GUARD）——R15 事故的产品级收口。
 *
 * 反例（用户令原文场景）：同 appData 持久保存 Claude 绑定 → 重开（新 registry/worker 实例，
 * 读同一 DB 绑定）→ 故意提交任务 → **派发必须在 spawn/请求前拒绝**：turn FAILED+防护信息、
 * runtime_process_registry 零登记、受管 job 计数不变（真实 spawn=0）。
 * 正例：无绑定成员照常 fake 完成；真实配置的保存与读取不受防护影响（可回读 claude 绑定）。
 * 生产分离：不设 ZS_REAL_DISPATCH_GUARD 的 registry，claude 绑定正常构建 adapter（factory 被调）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { MemberRuntimeRegistry } from '../../src/daemon/memberRuntime.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { ClaudeCliAdapter } from '../../src/adapter/claude/cliAdapter.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { managedJobsCount } from '../../src/daemon/managed/bridge.ts';

process.env.ZS_ALLOW_FAKE = '1';
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-guard-'));
afterAll(() => { for (let i = 0; i < 3; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* retry */ } } });

/** spawn 计数工厂：真实 adapter 构建即视为真实派发尝试（防护必须使其为 0）。 */
let realFactoryBuilds = 0;

function makeStack(db: ReturnType<typeof openDatabase>, guard: boolean) {
  const defaultAdapter = new FakeRuntimeAdapter();
  const registry = new MemberRuntimeRegistry(db, defaultAdapter, {
    fake: () => new FakeRuntimeAdapter(),
    claude: (binding) => { realFactoryBuilds += 1; return new ClaudeCliAdapter({ model: binding.model ?? 'deepseek-flash' }); },
  }, { defaultKind: 'fake', realDispatchGuard: guard });
  const worker = new DispatchWorker({ db, adapter: defaultAdapter, leaseOwner: `w-${randomUUID().slice(0, 6)}`, adapterFor: (m) => registry.adapterFor(m), appDataDir: join(tmpRoot, 'app') });
  return { registry, worker };
}

describe('第十六轮四：真实派发防护（ZS_REAL_DISPATCH_GUARD）', () => {
  it('反例：持久 claude 绑定→重开→提交=派发前拒绝（spawn 零：registry 零登记+受管计数不变）；配置读写不受影响', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    const deps = { db, localUserId: 'u_guard', interruptTurn: async () => {} };
    const cmd = async (m: string, p: unknown) => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `g-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: never; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data;
    };
    // ① 保存真实绑定（配置写不受防护影响）——会话一（无防护亦可保存；此处直接命令面）。
    await cmd('member.setRuntime', { memberId: 'mA', kind: 'claude', model: 'deepseek-flash' });
    const rt = (await cmd('member.runtime', { memberId: 'mA' })) as unknown as { binding: { kind: string; model: string } };
    expect(rt.binding.kind).toBe('claude');
    expect(rt.binding.model).toBe('deepseek-flash'); // ② 回读不受防护影响
    // ③ 重开=新实例读同一持久绑定，防护开 → 提交任务必须派发前拒绝。
    const jobs0 = managedJobsCount();
    const builds0 = realFactoryBuilds;
    const { worker } = makeStack(db, true);
    const ids = { messageId: 'm1', threadId: 'th1', taskId: 'tk1', taskEventId: 'e1', threadEventId: 'e2' };
    createRoomRootTask(db, {
      ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
      title: '反例', body: '故意在防护环境提交给持久 claude 绑定成员', mentions: [{ kind: 'member', memberId: 'mA' }],
      author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
      now: 1,
    });
    for (let i = 0; i < 6; i += 1) {
      try { if (!(await worker.runOnce())) break; } catch (dispatchError) { void dispatchError; break; } // 防护拒绝上抛亦不冒充执行
    }
    const turn = db.prepare('SELECT id, status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)').get('tk1') as { id: string; status: string } | undefined;
    expect(turn?.status).toBe('FAILED'); // 派发拒绝=turn FAILED（不冒充执行）
    const regRows = db.prepare(`SELECT count(*) c FROM runtime_process_registry`).get() as { c: number };
    expect(regRows.c).toBe(0); // 零登记=零 spawn 事实
    expect(realFactoryBuilds).toBe(builds0); // 真实 adapter 构建计数不变（spawn 前拒绝）
    expect(managedJobsCount()).toBe(jobs0);
    // ④ 无绑定成员照常 fake 完成（防护不误伤正常模拟链）。
    db.prepare(`UPDATE project_members SET profile_id = NULL WHERE id = 'mA'`).run();
    const ids2 = { messageId: 'm2', threadId: 'th2', taskId: 'tk2', taskEventId: 'e3', threadEventId: 'e4' };
    createRoomRootTask(db, {
      ids: ids2, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
      title: '正例', body: '无绑定回落 fake', mentions: [{ kind: 'member', memberId: 'mA' }],
      author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
      now: 2,
    });
    for (let i = 0; i < 6 && (await worker.runOnce()); i += 1);
    const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('tk2') as { status: string };
    expect(task2.status).toBe('DONE');
    db.close();
  }, 60_000);

  it('生产分离：不设防护时 claude 绑定正常解析（工厂构建——真实部署不受影响）', () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p2','d',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mB','p2','成员','agent',1)`).run();
    db.prepare(`INSERT INTO runtime_installations (id, kind, executable, version, adapter_version, capabilities_json, detected_at) VALUES ('ri_g','claude','claude','','','',0)`).run();
    db.prepare(`INSERT INTO agent_profiles (id, name, runtime_installation_id, settings_json) VALUES ('ap1','p','ri_g','{"model":"deepseek-flash"}')`).run();
    db.prepare(`UPDATE project_members SET profile_id = 'ap1' WHERE id = 'mB'`).run();
    const builds0 = realFactoryBuilds;
    const { registry } = makeStack(db, false); // 生产：无防护
    const adapter = registry.adapterFor('mB');
    expect(adapter).toBeInstanceOf(ClaudeCliAdapter);
    expect(realFactoryBuilds).toBe(builds0 + 1); // 工厂被调=真实 adapter 可用
    // 防护开=同一绑定被拒（对照）。
    const { registry: guarded } = makeStack(db, true);
    expect(() => guarded.adapterFor('mB')).toThrow(/验收防护.*拒绝/);
    db.close();
  }, 30_000);
});
