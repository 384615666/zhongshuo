/**
 * DEV-14 主体命令（第八轮，零模型调用）：git.status 只读真实仓库视图 / task.review
 * 可选验收（RT-25）/ runtime.status 运行能力真实状态 / changeset.listByTask 撤销详情。
 *
 * 口径：命令、状态都走正式链路；git fixture 只用临时目录（不触用户真实工作区）；
 * 验收与 Git 提交分离（review 只写 review 账本）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-dev14-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

let seq = 0;
function makeDb(): ZhongshuoDatabase {
  seq += 1;
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, 'd', ?, ?, '{}', 0)`)
    .run('p1', join(tmpRoot, `repo${seq}`), join(tmpRoot, `repo${seq}`));
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
  return db;
}

function depsOf(db: ZhongshuoDatabase): { deps: DaemonCommandDeps; cmd: <T>(m: string, p: unknown) => Promise<T> } {
  const deps: DaemonCommandDeps = { db, localUserId: 'u_dev14', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  return {
    deps,
    cmd: async <T,>(m: string, p: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
  };
}

function gitInit(root: string): void {
  mkdirSync(root, { recursive: true });
  const g = (...args: string[]): void => { execFileSync('git', ['-C', root, ...args], { timeout: 10_000 }); };
  g('init', '-q');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(root, 'committed.txt'), 'base\n');
  g('add', '.'); g('commit', '-q', '-m', 'init');
}

function makeReviewTask(db: ZhongshuoDatabase, reviewPolicy: 'user_review' | 'auto_deliver'): { taskId: string; threadId: string } {
  const ids = { messageId: `dm${++seq}`, threadId: `dth${seq}`, taskId: `dtk${seq}`, taskEventId: `de${seq}`, threadEventId: `dh${seq}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `D${seq}`, body: `B${seq}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy, sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: seq,
  });
  return { taskId: ids.taskId, threadId: ids.threadId };
}

function stagePendingDelivery(db: ZhongshuoDatabase, taskId: string, runId: string): string {
  const deliveryId = `dlv_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
     VALUES (?, ?, ?, 1, 'h', '[]', '[]', '[]', 'pending')`,
  ).run(deliveryId, taskId, runId);
  db.prepare(`UPDATE tasks SET status = 'REVIEW', current_delivery_id = ? WHERE id = ?`).run(deliveryId, taskId);
  return deliveryId;
}

describe('DEV-14 主体命令', () => {
  it('git.status：真实仓库的暂存/未暂存/未跟踪严格区分；只读（用户修改保留）；非 git 目录明确拒绝', async () => {
    const db = makeDb();
    const repoRoot = join(tmpRoot, `repo${seq}`);
    gitInit(repoRoot);
    writeFileSync(join(repoRoot, 'committed.txt'), 'working-tree change\n'); // 未暂存修改（用户已有内容）
    writeFileSync(join(repoRoot, 'staged.txt'), 'to be staged\n');
    writeFileSync(join(repoRoot, 'untracked.txt'), 'new file\n');
    execFileSync('git', ['-C', repoRoot, 'add', 'staged.txt'], { timeout: 10_000 });
    const { cmd } = depsOf(db);
    const s = await cmd<{
      branch: string;
      staged: Array<{ path: string; xy: string }>;
      unstaged: Array<{ path: string; xy: string }>;
      untracked: Array<{ path: string }>;
      truncated: boolean;
    }>('git.status', { projectId: 'p1' });
    expect(s.staged.map((e) => e.path)).toEqual(['staged.txt']);
    expect(s.unstaged.map((e) => e.path)).toEqual(['committed.txt']);
    expect(s.untracked.map((e) => e.path)).toEqual(['untracked.txt']);
    expect(s.branch.length).toBeGreaterThan(0);
    // 只读：查询后工作区内容与索引状态原样保留。
    expect(readFileSync(join(repoRoot, 'committed.txt'), 'utf8')).toContain('working-tree change');
    const porcelain = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { timeout: 10_000, encoding: 'utf8' });
    expect(porcelain).toContain('A  staged.txt');
    expect(porcelain).toContain(' M committed.txt');
    expect(porcelain).toContain('?? untracked.txt');
    db.close();
  }, 30_000);

  it('git.status：非 git 目录 → 明确错误（不返回空状态冒充）', async () => {
    const db = makeDb();
    const { cmd } = depsOf(db);
    await expect(cmd('git.status', { projectId: 'p1' })).rejects.toThrow('不是 git 仓库');
    db.close();
  }, 30_000);

  it('task.review（RT-25）：accept→交付 accepted+任务 DONE+审计；changes_requested→任务回 ACTIVE；重复/策略不符拒绝', async () => {
    // accept 链。
    {
      const db = makeDb();
      const { taskId } = makeReviewTask(db, 'user_review');
      const runId = `run_${randomUUID()}`;
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', (SELECT conversation_thread_id FROM tasks WHERE id=?), 'DIRECT', 0, 'SUCCEEDED', '{}')`).run(runId, taskId, taskId);
      const deliveryId = stagePendingDelivery(db, taskId, runId);
      const { cmd } = depsOf(db);
      const r = await cmd<{ reviewStatus: string; taskStatusAfter: string }>('task.review', { taskId, decision: 'accept', note: '人工验收通过' });
      expect(r.reviewStatus).toBe('accepted');
      expect(r.taskStatusAfter).toBe('DONE');
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
      expect((db.prepare('SELECT review_status, reviewed_by FROM task_deliveries WHERE id = ?').get(deliveryId) as { review_status: string; reviewed_by: string })).toMatchObject({ review_status: 'accepted', reviewed_by: 'u_dev14' });
      const evt = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'task.reviewRecorded' AND task_id = ?`).get(taskId) as { payload_json: string };
      expect(JSON.parse(evt.payload_json).gitCommitIsNotReview).toContain('不等同验收');
      // 重复验收：无 pending → 幂等拒绝。
      await expect(cmd('task.review', { taskId, decision: 'accept' })).rejects.toThrow('没有待验收交付');
      db.close();
    }
    // changes_requested → ACTIVE（返工入口=redispatch 正式链）。
    {
      const db = makeDb();
      const { taskId } = makeReviewTask(db, 'user_review');
      const runId = `run_${randomUUID()}`;
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', (SELECT conversation_thread_id FROM tasks WHERE id=?), 'DIRECT', 0, 'SUCCEEDED', '{}')`).run(runId, taskId, taskId);
      stagePendingDelivery(db, taskId, runId);
      const { cmd } = depsOf(db);
      const r = await cmd<{ taskStatusAfter: string }>('task.review', { taskId, decision: 'changes_requested', note: '需要修正输出' });
      expect(r.taskStatusAfter).toBe('ACTIVE');
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');
      db.close();
    }
    // 策略快照一致性：auto_deliver 任务不适用人工验收。
    {
      const db = makeDb();
      const { taskId } = makeReviewTask(db, 'auto_deliver');
      const { cmd } = depsOf(db);
      await expect(cmd('task.review', { taskId, decision: 'accept' })).rejects.toThrow('非 user_review');
      db.close();
    }
  }, 30_000);

  it('runtime.status：成员绑定/能力矩阵/daemon 恢复能力（真实状态标注，不 spawn 子进程）', async () => {
    const db = makeDb();
    const { cmd } = depsOf(db);
    const s = await cmd<{
      installations: Array<{ kind: string }>;
      memberBindings: Array<{ memberId: string; kind: string }>;
      capabilities: { claude: { keyAbilities: Record<string, string> } };
      daemonRecovery: { processTreeEvidence: string; lateEventPump: string };
    }>('runtime.status', {});
    expect(s.memberBindings.length).toBeGreaterThan(0);
    expect(s.memberBindings[0]!.kind).toBe('(默认 runtime)'); // 未配置绑定如实显示
    expect(s.capabilities.claude.keyAbilities.structuredFinal).toBe('supported');
    expect(s.capabilities.claude.keyAbilities.restrictWrites).toBe('unverified'); // 未认证项不升级
    expect(s.daemonRecovery.processTreeEvidence).toMatch(/supported|unsupported/);
    expect(s.daemonRecovery.lateEventPump).toContain('待补证'); // 真实 CLI 能力如实标注
    db.close();
  }, 30_000);

  it('changeset.listByTask：撤销进度/冲突原因/可续跑（undo 详情）', async () => {
    const db = makeDb();
    const { taskId } = makeReviewTask(db, 'auto_deliver');
    const csId = `cs_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO change_sets (id, project_id, task_id, before_ref, after_ref, application_status) VALUES ('${csId}', 'p1', ?, 'ref-a', 'ref-b', 'partial')`,
    ).run(taskId);
    db.prepare(`INSERT INTO change_set_files (change_set_id, role, path, state) VALUES (?, 'after', 'a.txt', 'present'), (?, 'after', 'b.txt', 'unknown')`).run(csId, csId);
    db.prepare(
      `INSERT INTO change_set_undos (id, change_set_id, status, steps_json, created_at, updated_at, failure_json)
       VALUES ('u1', ?, 'conflict', ?, 1, 2, ?)`,
    ).run(csId, JSON.stringify([{ path: 'a.txt', state: 'done' }, { path: 'b.txt', state: 'pending' }]), JSON.stringify({ file: 'b.txt', reason: '当前内容与 after 前像不符（用户手动修改）' }));
    const { cmd } = depsOf(db);
    const r = await cmd<{ items: Array<{ applicationStatus: string; undo: { status: string; totalSteps: number; doneSteps: number; failure: string | null; resumable: boolean } | null; files: Array<{ path: string; state: string }> }> }>('changeset.listByTask', { taskId });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.applicationStatus).toBe('partial');
    expect(r.items[0]!.undo).toMatchObject({ status: 'conflict', totalSteps: 2, doneSteps: 1, resumable: false });
    expect(r.items[0]!.undo!.failure).toContain('after 前像不符');
    expect(r.items[0]!.files.map((f) => f.state)).toEqual(['present', 'unknown']);
    db.close();
  }, 30_000);
});
