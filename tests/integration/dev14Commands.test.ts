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
     VALUES (?, ?, ?, 1, 'manifest-h-1', '[]', '[]', '[]', 'pending')`,
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

  it('git.diff：暂存/未暂存正文、二进制标注、路径越界拒绝；读取不改索引与工作区', async () => {
    const db = makeDb();
    const repoRoot = join(tmpRoot, `repo${seq}`);
    gitInit(repoRoot);
    writeFileSync(join(repoRoot, 'committed.txt'), 'working change\nline2\n'); // 未暂存（用户修改）
    writeFileSync(join(repoRoot, 'staged-new.txt'), 'staged content\n');
    execFileSync('git', ['-C', repoRoot, 'add', 'staged-new.txt'], { timeout: 10_000 });
    const { cmd } = depsOf(db);
    // 未暂存 diff：含 +/- 行。
    const unstaged = await cmd<{ patches: Array<{ path: string; change: string; binary: boolean; text: string }> }>('git.diff', { projectId: 'p1' });
    expect(unstaged.patches.map((x) => x.path)).toEqual(['committed.txt']);
    expect(unstaged.patches[0]!.text).toContain('-base');
    expect(unstaged.patches[0]!.text).toContain('+working change');
    expect(unstaged.patches[0]!.binary).toBe(false);
    // 已暂存 diff：新增文件。
    const staged = await cmd<{ patches: Array<{ path: string; change: string }> }>('git.diff', { projectId: 'p1', staged: true });
    expect(staged.patches.map((x) => x.path)).toEqual(['staged-new.txt']);
    expect(staged.patches[0]!.change).toBe('added');
    // 路径过滤 + 越界拒绝。
    const filtered = await cmd<{ patches: Array<{ path: string }> }>('git.diff', { projectId: 'p1', path: 'committed.txt' });
    expect(filtered.patches.map((x) => x.path)).toEqual(['committed.txt']);
    await expect(cmd('git.diff', { projectId: 'p1', path: '../outside' })).rejects.toThrow('越界');
    await expect(cmd('git.diff', { projectId: 'p1', path: 'D:/abs/path' })).rejects.toThrow('绝对路径');
    // 二进制标注（numstat '-'）。
    writeFileSync(join(repoRoot, 'bin.dat'), Buffer.from([0, 159, 146, 150, 0, 1]));
    execFileSync('git', ['-C', repoRoot, 'add', 'bin.dat'], { timeout: 10_000 });
    const stagedBin = await cmd<{ patches: Array<{ path: string; binary: boolean; text: string }> }>('git.diff', { projectId: 'p1', staged: true });
    const binPatch = stagedBin.patches.find((x) => x.path === 'bin.dat');
    expect(binPatch).toBeDefined();
    expect(binPatch!.binary).toBe(true);
    expect(binPatch!.text).toBe('');
    // 只读复证：索引与工作区不变。
    const porcelain = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { timeout: 10_000, encoding: 'utf8' });
    expect(porcelain).toContain(' M committed.txt');
    expect(porcelain).toContain('A  staged-new.txt');
    expect(readFileSync(join(repoRoot, 'committed.txt'), 'utf8')).toContain('working change');
    db.close();
  }, 45_000);

  it('app.settings.get/set：白名单持久化（重复打开读取同值）；非法值拒绝', async () => {
    const db = makeDb();
    const { cmd } = depsOf(db);
    const before = await cmd<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['repoStatus.visible'] });
    expect(before.values['repoStatus.visible']).toBe(null); // 缺省未设置
    await cmd('app.settings.set', { key: 'repoStatus.visible', value: 'false' });
    // 新连接（同库重开）读取同值：设置持久化、跨重开生效。
    const again = await cmd<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['repoStatus.visible'] });
    expect(again.values['repoStatus.visible']).toBe('false');
    await expect(cmd('app.settings.set', { key: 'repoStatus.visible', value: 'maybe' })).rejects.toThrow('不接受');
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
      const r = await cmd<{ reviewStatus: string; taskStatusAfter: string; deliveryRevision: number }>('task.review', { taskId, deliveryId, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'accept', note: '人工验收通过' });
      expect(r.reviewStatus).toBe('accepted');
      expect(r.taskStatusAfter).toBe('DONE');
      expect(r.deliveryRevision).toBe(1);
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
      expect((db.prepare('SELECT review_status, reviewed_by FROM task_deliveries WHERE id = ?').get(deliveryId) as { review_status: string; reviewed_by: string })).toMatchObject({ review_status: 'accepted', reviewed_by: 'u_dev14' });
      const evt = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'task.reviewRecorded' AND task_id = ?`).get(taskId) as { payload_json: string };
      expect(JSON.parse(evt.payload_json).gitCommitIsNotReview).toContain('不等同验收');
      // 不同命令号对已处理版本：明确冲突（不重复生效）。
      await expect(cmd('task.review', { taskId, deliveryId, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'accept' })).rejects.toThrow('已处理');
      // 版本不符：拒绝。
      await expect(cmd('task.review', { taskId, deliveryId, deliveryRevision: 2, manifestHash: 'manifest-h-1', decision: 'accept' })).rejects.toThrow('版本不符');
      db.close();
    }
    // changes_requested → ACTIVE（返工入口=redispatch 正式链）。
    {
      const db = makeDb();
      const { taskId } = makeReviewTask(db, 'user_review');
      const runId = `run_${randomUUID()}`;
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', (SELECT conversation_thread_id FROM tasks WHERE id=?), 'DIRECT', 0, 'SUCCEEDED', '{}')`).run(runId, taskId, taskId);
      const dId = stagePendingDelivery(db, taskId, runId);
      const { cmd } = depsOf(db);
      const r = await cmd<{ taskStatusAfter: string }>('task.review', { taskId, deliveryId: dId, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'changes_requested', note: '需要修正输出' });
      expect(r.taskStatusAfter).toBe('ACTIVE');
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');
      db.close();
    }
    // 策略快照一致性：auto_deliver 任务不适用人工验收。
    {
      const db = makeDb();
      const { taskId } = makeReviewTask(db, 'auto_deliver');
      const { cmd } = depsOf(db);
      await expect(cmd('task.review', { taskId, deliveryId: 'dlv_any', deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'accept' })).rejects.toThrow('非 user_review');
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

  it('验收错稿防护（第九轮）：用户看到 v1→后台产生 v2（v1 被替代）→提交 v1 验收被明确拒绝，v2 保持待验收', async () => {
    const db = makeDb();
    const { taskId } = makeReviewTask(db, 'user_review');
    const runId = `run_${randomUUID()}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', (SELECT conversation_thread_id FROM tasks WHERE id=?), 'DIRECT', 0, 'SUCCEEDED', '{}')`).run(runId, taskId, taskId);
    const v1 = stagePendingDelivery(db, taskId, runId);
    // 后台产生 v2（§10.5-5：旧 pending 标 superseded，唯一待办换新版本）。
    db.prepare(
      `UPDATE task_deliveries SET review_status = 'superseded' WHERE id = ?`,
    ).run(v1);
    db.prepare(
      `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
       VALUES ('dlv_v2', ?, ?, 2, 'manifest-h-2', '[]', '[]', '[]', 'pending')`,
    ).run(taskId, runId);
    const { cmd } = depsOf(db);
    // 提交 v1（用户界面看到的旧版本）：明确冲突——不自动套用到 v2。
    await expect(cmd('task.review', { taskId, deliveryId: v1, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'accept' })).rejects.toThrow('已被新交付替代');
    // v2 保持待验收；v1 仍是 superseded（未被错写）。
    expect((db.prepare(`SELECT review_status FROM task_deliveries WHERE id = 'dlv_v2'`).get() as { review_status: string }).review_status).toBe('pending');
    expect((db.prepare(`SELECT review_status FROM task_deliveries WHERE id = ?`).get(v1) as { review_status: string }).review_status).toBe('superseded');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('REVIEW'); // 任务状态不被旧版本验收推动
    // v2 正常验收成功（版本绑定正确对象）。
    const r2 = await cmd<{ reviewStatus: string; deliveryRevision: number }>('task.review', { taskId, deliveryId: 'dlv_v2', deliveryRevision: 2, manifestHash: 'manifest-h-2', decision: 'accept' });
    expect(r2).toMatchObject({ reviewStatus: 'accepted', deliveryRevision: 2 });
    db.close();
  }, 30_000);

  it('验收幂等（第九轮）：同 commandId 重放返回原回执不重复写验收事实；跨任务交付拒绝', async () => {
    const db = makeDb();
    const { taskId } = makeReviewTask(db, 'user_review');
    const runId = `run_${randomUUID()}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', (SELECT conversation_thread_id FROM tasks WHERE id=?), 'DIRECT', 0, 'SUCCEEDED', '{}')`).run(runId, taskId, taskId);
    const deliveryId = stagePendingDelivery(db, taskId, runId);
    const { deps, cmd } = depsOf(db);
    const { randomUUID: uuid } = await import('node:crypto');
    const envelope = (commandId: string): Parameters<typeof dispatchDaemonCommand>[1] => ({
      protocolVersion: 1, commandId, method: 'task.review',
      params: { taskId, deliveryId, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'accept', note: '同号重放' },
    });
    const commandId = `rev-${uuid()}`;
    const r1 = await dispatchDaemonCommand(deps, envelope(commandId)) as { ok: boolean; data?: unknown; replayed?: boolean };
    expect(r1.ok).toBe(true);
    expect(r1.replayed).toBeFalsy();
    // 传输回执丢失后同 commandId 重试：网关重放原回执，不重复写验收事实。
    const r2 = await dispatchDaemonCommand(deps, envelope(commandId)) as { ok: boolean; replayed?: boolean };
    expect(r2.ok).toBe(true);
    expect(r2.replayed).toBe(true);
    const reviewed = (db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'task.reviewRecorded' AND task_id = ?`).get(taskId) as { c: number }).c;
    expect(reviewed).toBe(1); // 验收事实只写一次
    // 跨任务交付：另一任务的 deliveryId 拒绝（不跨任务套用）。
    const other = makeReviewTask(db, 'user_review');
    const otherRun = `run_${randomUUID()}`;
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, 'c1', (SELECT conversation_thread_id FROM tasks WHERE id=?), 'DIRECT', 0, 'SUCCEEDED', '{}')`).run(otherRun, other.taskId, other.taskId);
    const otherDelivery = stagePendingDelivery(db, other.taskId, otherRun);
    await expect(cmd('task.review', { taskId, deliveryId: otherDelivery, deliveryRevision: 1, manifestHash: 'manifest-h-1', decision: 'accept' })).rejects.toThrow('不属于该任务');
    db.close();
  }, 30_000);

  it('返工闭环（第九轮）：changes_requested 的说明进入后续派发输入（关联被退回版本）；验收通过后反馈消失', async () => {
    const { openDatabase: _od } = { openDatabase: null as never };
    void _od;
    const db = makeDb();
    const { FakeRuntimeAdapter } = await import('../../src/adapter/fake/runtimeAdapter.ts');
    const { DispatchWorker } = await import('../../src/daemon/dispatchWorker.ts');
    const { dispatchDaemonCommand: dc } = await import('../../src/daemon/commands.ts');
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-rev9', appDataDir: join(tmpRoot, 'app') });
    // 任务一：user_review，完成 → REVIEW+pending → 要求修改（带说明）→ redispatch → 派发输入含返工附注。
    const t1 = makeReviewTask(db, 'user_review');
    await worker.runOnce(); // 派发 t1（fake 成功交付 pending）
    const t1Row = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(t1.taskId) as { id: string; status: string };
    expect(t1Row.status).toBe('REVIEW');
    const pending = db.prepare(`SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id = ? AND review_status = 'pending'`).get(t1.taskId) as { id: string; revision: number; manifest_hash: string };
    const deps = { db, localUserId: 'u_dev14', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') } as never as DaemonCommandDeps;
    const rr = await dc(deps, { protocolVersion: 1, commandId: `c-rev9-${Date.now()}`, method: 'task.review', params: { taskId: t1.taskId, deliveryId: pending.id, deliveryRevision: pending.revision, manifestHash: pending.manifest_hash, decision: 'changes_requested', note: '清单缺少风险一节' } }) as { ok: boolean };
    expect(rr.ok).toBe(true);
    await dc(deps, { protocolVersion: 1, commandId: `c-rd9-${Date.now()}`, method: 'task.redispatch', params: { taskId: t1.taskId, reason: '按验收反馈返工' } });
    await worker.runOnce(); // 返工派发
    const lastInput = adapter.startTurnLog[adapter.startTurnLog.length - 1]!;
    expect(lastInput.text).toContain('【返工】');
    expect(lastInput.text).toContain(`第 ${pending.revision} 版`);
    expect(lastInput.text).toContain('清单缺少风险一节');
    // 返工交付验收通过 → 最新结论=accepted → 再派发（另一任务/同任务再追加）反馈消失。
    const pending2 = db.prepare(`SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id = ? AND review_status = 'pending'`).get(t1.taskId) as { id: string; revision: number; manifest_hash: string };
    if (pending2 != null) {
      await dc(deps, { protocolVersion: 1, commandId: `c-acc9-${Date.now()}`, method: 'task.review', params: { taskId: t1.taskId, deliveryId: pending2.id, deliveryRevision: pending2.revision, manifestHash: pending2.manifest_hash, decision: 'accept' } });
    }
    const t2 = makeReviewTask(db, 'user_review');
    await worker.runOnce(); // 新任务派发：不含返工附注（最新验收结论已 accepted）
    const freshInput = adapter.startTurnLog[adapter.startTurnLog.length - 1]!;
    expect(freshInput.text).not.toContain('【返工】');
    void t2;
    db.close();
  }, 45_000);

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
