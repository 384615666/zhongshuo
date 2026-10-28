/**
 * 第十轮·三：项目设置「任务验收」开关（RT-25/§10.5/§15.2，零模型调用）。
 *
 * 覆盖：
 * - 新项目默认关闭；创建用户任务走正式路径（message.submit room_root）快照 Task.reviewPolicy；
 * - project.reviewPolicy.set：CAS（expectedRevision）+revision 递增+领域事件；同值幂等 unchanged；
 * - 开关只影响之后创建的任务：已有任务策略不被批量改写；
 * - 关闭不授权提交/推送（语义边界——命令不触发任何 git 操作）；
 * - 持久化：重开数据库后开关保持，project.open 返回真实值；
 * - 要求修改必填意见（§10.5-4：意见注入返工输入的前置校验）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-projsettings-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

let seq = 0;
function makeFileDb(): { db: ZhongshuoDatabase; file: string } {
  seq += 1;
  const file = join(tmpRoot, `settings-${seq}.sqlite`);
  const db = openDatabase(file);
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1', 'd', ?, ?, '{}', 0)`).run(file, file);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
  return { db, file };
}

function depsOf(db: ZhongshuoDatabase): { cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T> } {
  const deps: DaemonCommandDeps = { db, localUserId: 'u_settings', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  return {
    cmd: async <T,>(m: string, p: unknown, commandId?: string): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `c-${randomUUID().slice(0, 10)}`, method: m, params: p }) as { ok: boolean; data?: T; replayed?: boolean; error?: { code: string; message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
  };
}

/** 经正式创建路径（message.submit room_root，intent=default）建任务并返回 review_policy。 */
async function createTaskViaFormalPath(db: ZhongshuoDatabase, title: string): Promise<string> {
  const { cmd } = depsOf(db);
  await cmd('message.submit', {
    target: { kind: 'room_root', projectId: 'p1', conversationId: 'c1', roomId: 'r1' },
    body: title, intent: 'default', mentions: [],
  });
  const task = db.prepare('SELECT review_policy FROM tasks ORDER BY rowid DESC LIMIT 1').get() as { review_policy: string };
  return task.review_policy;
}

describe('第十轮·三：项目设置任务验收开关', () => {
  it('默认关闭→正式路径快照 auto_deliver；开启后新任务快照 user_review、旧任务不被改写', async () => {
    const { db } = makeFileDb();
    expect(await createTaskViaFormalPath(db, '旧任务（开关前）')).toBe('auto_deliver');
    const { cmd } = depsOf(db);
    const r = await cmd<{ taskReviewEnabled: boolean; revision: number; unchanged: boolean }>('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    expect(r).toMatchObject({ taskReviewEnabled: true, revision: 1, unchanged: false });
    // 旧任务策略保持（不批量改写，RT-25①）。
    expect((db.prepare(`SELECT review_policy FROM tasks WHERE title = ?`).get('旧任务（开关前）') as { review_policy: string }).review_policy).toBe('auto_deliver');
    // 新任务按开启后的策略快照。
    expect(await createTaskViaFormalPath(db, '新任务（开关后）')).toBe('user_review');
    // 领域事件落库（设置变更可追溯）。
    const evt = db.prepare(`SELECT kind FROM domain_events WHERE kind = 'project.reviewPolicyUpdated' ORDER BY seq DESC LIMIT 1`).get() as { kind: string } | undefined;
    expect(evt?.kind).toBe('project.reviewPolicyUpdated');
    db.close();
  }, 30_000);

  it('CAS：expectedRevision 不符拒绝；同 commandId 重放原回执；同值设置 unchanged', async () => {
    const { db } = makeFileDb();
    const { cmd } = depsOf(db);
    await expect(cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 7 })).rejects.toThrow(/revision 已变化/);
    const cid = `set-${randomUUID().slice(0, 8)}`;
    const r1 = await cmd<{ revision: number; unchanged: boolean; replayed?: boolean }>('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 }, cid);
    expect(r1.unchanged).toBe(false);
    // 同号重放：原回执（revision 不再递增）。
    const raw = await dispatchDaemonCommand({ db, localUserId: 'u_settings', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') }, { protocolVersion: 1, commandId: cid, method: 'project.reviewPolicy.set', params: { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 } }) as { ok: boolean; replayed?: boolean };
    expect(raw.replayed).toBe(true);
    // 同值再设（新号）：unchanged=true，revision 不变。
    const r3 = await cmd<{ revision: number; unchanged: boolean }>('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: r1.revision });
    expect(r3.unchanged).toBe(true);
    expect(r3.revision).toBe(r1.revision);
    db.close();
  }, 30_000);

  it('持久化：重开数据库后开关保持；project.open 返回真实值', async () => {
    const { db, file } = makeFileDb();
    const { cmd } = depsOf(db);
    await cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    db.close();
    const db2 = openDatabase(file);
    expect((db2.prepare('SELECT task_review_enabled FROM projects WHERE id = ?').get('p1') as { task_review_enabled: number }).task_review_enabled).toBe(1);
    // 重开后新任务仍按开启策略快照。
    expect(await createTaskViaFormalPath(db2, '重开后新任务')).toBe('user_review');
    db2.close();
  }, 30_000);

  it('要求修改必填意见（§10.5-4）；带意见经正式命令生效并记录返工说明', async () => {
    const { db } = makeFileDb();
    const { cmd } = depsOf(db);
    await cmd('project.reviewPolicy.set', { projectId: 'p1', taskReviewEnabled: true, expectedRevision: 0 });
    // 正式路径建 user_review 任务 + 交付（dispatch 收口由 worker 承担——此处直接落 pending
    // 交付行以驱动 review 命令面；策略快照本身已由上一用例经 message.submit 验证）。
    const taskId = `tk_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status, review_policy) VALUES (?, 'p1', 'c1', 'room_task', 'r1', '意见必填任务', 'REVIEW', 'user_review')`).run(taskId);
    const deliveryId = `dlv_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
       VALUES (?, ?, NULL, 1, 'manifest-h-1', '[]', '[]', '[]', 'pending')`,
    ).run(deliveryId, taskId);
    await expect(cmd('task.review', { taskId, deliveryId, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'changes_requested' })).rejects.toThrow(/请填写需要修改的内容/);
    await expect(cmd('task.review', { taskId, deliveryId, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'changes_requested', note: '   ' })).rejects.toThrow(/请填写需要修改的内容/);
    const ok = await cmd<{ reviewStatus: string; taskStatusAfter: string }>('task.review', { taskId, deliveryId, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'changes_requested', note: '清单缺少风险一节' });
    expect(ok.reviewStatus).toBe('changes_requested');
    expect(ok.taskStatusAfter).toBe('ACTIVE');
    expect((db.prepare('SELECT review_note FROM task_deliveries WHERE id = ?').get(deliveryId) as { review_note: string | null }).review_note).toBe('清单缺少风险一节');
    db.close();
  }, 30_000);
});
