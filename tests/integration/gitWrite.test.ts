/**
 * 第十轮·二：Git 写操作闭环（零模型调用；全部临时 Git fixture，不触用户真实工作区）。
 *
 * 覆盖（RT-24/§14.6/§15.2）：
 * - 单文件/普通按文件暂存与取消暂存（只动索引不动工作区；干净文件如实跳过；同号重放）；
 * - 按任务批量暂存：纳入任务改动、跳过 userPreExisting、用户改动+任务改动同文件=冲突
 *   （不自动纳入用户原有修改）；旧捕获回退核对；执行保护租约拒绝；
 * - 提交预览→提交：真实索引内容、HEAD/暂存区变化拒绝（不提交用户没看到的内容）；
 *   冲突未解决禁止提交；身份缺失如实报错不代改配置；提交不改任务/改动集/验收状态；
 * - 幂等与既成事实：同 commandId 重放原回执；git 副作用已发生、回执/日志未落库的崩溃
 *   窗口按提交尾部标记核对既成事实（不重复 commit、不误报未执行）；
 * - 提交历史与任务/改动集关联（外部提交不虚构归属）；子目录项目范围拒绝。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-gitwrite-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { timeout: 15_000, encoding: 'utf8' });
}
/** 允许非零退出（合并冲突等）——返回 stdout。 */
function gitLax(root: string, ...args: string[]): { status: number; stdout: string } {
  const r = spawnSync('git', ['-C', root, ...args], { timeout: 15_000, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '' };
}

let seq = 0;
interface Fixture {
  root: string; db: ZhongshuoDatabase; projectId: string;
  cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T>;
}
function makeFixture(name: string, files: Record<string, string>, projectRootIsSubdir = false): Fixture {
  seq += 1;
  const projectId = `p${seq}`;
  const root = join(tmpRoot, `${name}-${seq}`);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'core.autocrlf', 'false');
  if (Object.keys(files).length > 0) {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(root, ...rel.split('/'));
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }
  const db = openDatabase(':memory:');
  const projectPath = projectRootIsSubdir ? join(root, 'pkg') : root;
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, 'd', ?, ?, '{}', 0)`).run(projectId, projectPath, projectPath);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?,'执行成员','agent',1)`).run(projectId);
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1',?,'大厅','mA')`).run(projectId);
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1',?,'room','r1')`).run(projectId);
  const deps: DaemonCommandDeps = { db, localUserId: 'u_gitwrite', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  return {
    root, db, projectId,
    cmd: async <T,>(m: string, p: unknown, commandId?: string): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `c-${randomUUID().slice(0, 10)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
  };
}

function insertActiveLease(f: Fixture): void {
  f.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES ('tk_lease', ?, 'c1', 'room_task', 'r1', '租约用任务')`).run(f.projectId);
  f.db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES ('run_lease','tk_lease','c1','DIRECT',0,'RUNNING')`).run();
  f.db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status) VALUES ('turn_lease','run_lease','c1','mA','direct.work','RUNNING')`).run();
  const domain = f.root.replaceAll('\\', '/').toLowerCase();
  f.db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, 'turn_lease', 1, 0, 'active')`).run(domain);
}

describe('第十轮·二：Git 写操作闭环', () => {
  it('单文件暂存/取消暂存：只动索引不动工作区；干净文件如实跳过；同 commandId 重放', async () => {
    const f = makeFixture('stage', { 'a.txt': 'v1\n', 'b.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    writeFileSync(join(f.root, 'new.txt'), 'n\n', 'utf8');
    const cid = `stage-${randomUUID().slice(0, 8)}`;
    const r1 = await f.cmd<{ staged: string[]; skipped: Array<{ path: string; reason: string }> }>('git.stage', { projectId: f.projectId, paths: ['a.txt', 'new.txt', 'b.txt'] }, cid);
    expect(r1.staged.sort()).toEqual(['a.txt', 'new.txt']);
    expect(r1.skipped).toHaveLength(1);
    expect(r1.skipped[0]!.path).toBe('b.txt');
    expect(git(f.root, 'status', '--porcelain')).toContain('M  a.txt');
    expect(git(f.root, 'status', '--porcelain')).toContain('A  new.txt');
    // 工作区内容未被改动。
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('v2\n');
    // 同 commandId 重放：返回原回执，不重复执行。
    const r2 = await f.cmd<{ staged: string[]; replayed?: boolean }>('git.stage', { projectId: f.projectId, paths: ['a.txt', 'new.txt', 'b.txt'] }, cid);
    expect(r2.replayed).toBe(true);
    expect(r2.staged.sort()).toEqual(['a.txt', 'new.txt']);
    // 取消暂存：a.txt 回未暂存、new.txt 回未跟踪。
    const u1 = await f.cmd<{ staged: string[]; skipped: Array<{ path: string }> }>('git.unstage', { projectId: f.projectId, paths: ['a.txt', 'new.txt'] });
    expect(u1.staged.sort()).toEqual(['a.txt', 'new.txt']);
    const porcelain = git(f.root, 'status', '--porcelain');
    expect(porcelain).toContain(' M a.txt');
    expect(porcelain).toContain('?? new.txt');
    // 干净文件取消暂存 → 如实跳过（不报错、不伪造执行）。
    const u2 = await f.cmd<{ staged: string[]; skipped: Array<{ path: string }> }>('git.unstage', { projectId: f.projectId, paths: ['b.txt'] });
    expect(u2.staged).toEqual([]);
    expect(u2.skipped[0]!.path).toBe('b.txt');
    f.db.close();
  }, 30_000);

  it('批量暂存（按任务）：纳入任务改动、跳过 userPreExisting、混合文件=冲突不自动分离', async () => {
    const f = makeFixture('stagetask', { 'user-only.txt': 'u0\n', 'mixed.txt': 'm0\n', 'task-only.txt': 't0\n' });
    // 基线前：用户先改 user-only 与 mixed（=基线时已 dirty）。
    writeFileSync(join(f.root, 'user-only.txt'), 'u1-user\n', 'utf8');
    writeFileSync(join(f.root, 'mixed.txt'), 'm1-user\n', 'utf8');
    // 任务上下文行（change_sets.task_id 外键）。
    f.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES ('tk1', ?, 'c1', 'room_task', 'r1', '批量暂存任务')`).run(f.projectId);
    const base = await f.cmd<{ changeSetId: string }>('changeset.captureBaseline', { projectId: f.projectId, taskId: 'tk1' });
    // 基线后：任务改 task-only、再改 mixed、新建 task-new；用户文件 user-only 不再动。
    writeFileSync(join(f.root, 'task-only.txt'), 't1-task\n', 'utf8');
    writeFileSync(join(f.root, 'mixed.txt'), 'm1-user+m2-task\n', 'utf8');
    writeFileSync(join(f.root, 'task-new.txt'), 'new-task\n', 'utf8');
    await f.cmd('changeset.finalize', { changeSetId: base.changeSetId });

    const r = await f.cmd<{ changeSetIds: string[]; included: string[]; skipped: Array<{ path: string; reason: string }>; conflicts: Array<{ path: string; reason: string }> }>('git.stageTask', { projectId: f.projectId, taskId: 'tk1' });
    expect(r.changeSetIds).toEqual([base.changeSetId]);
    expect(r.included.sort()).toEqual(['task-new.txt', 'task-only.txt']);
    expect(r.skipped.map((s) => s.path)).toEqual(['user-only.txt']);
    expect(r.skipped[0]!.reason).toContain('userPreExisting');
    expect(r.conflicts.map((c) => c.path)).toEqual(['mixed.txt']);
    expect(r.conflicts[0]!.reason).toContain('无法按文件分离');
    // 索引结果：只有任务面两文件入暂存；用户文件原样保留。
    const porcelain = git(f.root, 'status', '--porcelain');
    expect(porcelain).toContain('M  task-only.txt');
    expect(porcelain).toContain('A  task-new.txt');
    expect(porcelain).toContain(' M user-only.txt');
    expect(porcelain).toContain(' M mixed.txt');
    expect(readFileSync(join(f.root, 'user-only.txt'), 'utf8')).toBe('u1-user\n');
    // 按 changeSetId 批量：等价（幂等重复暂存无副作用）。
    const r2 = await f.cmd<{ included: string[] }>('git.stageTask', { projectId: f.projectId, changeSetId: base.changeSetId });
    expect(r2.included.sort()).toEqual(['task-new.txt', 'task-only.txt']);
    f.db.close();
  }, 30_000);

  it('批量暂存：旧捕获（无 dirtyPaths）按 before 前像 vs HEAD 回退核对', async () => {
    const f = makeFixture('legacy', { 'user-edit.txt': 'u0\n', 'task-edit.txt': 't0\n' });
    writeFileSync(join(f.root, 'user-edit.txt'), 'u1-user\n', 'utf8'); // 基线前用户改动
    f.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES ('tk2', ?, 'c1', 'room_task', 'r1', '旧捕获任务')`).run(f.projectId);
    const base = await f.cmd<{ changeSetId: string }>('changeset.captureBaseline', { projectId: f.projectId, taskId: 'tk2' });
    writeFileSync(join(f.root, 'task-edit.txt'), 't1-task\n', 'utf8'); // 基线后任务改动
    await f.cmd('changeset.finalize', { changeSetId: base.changeSetId });
    // 模拟旧捕获：抹掉 manifest 的 dirtyPaths（回退路径必须给出同样的归属结论）。
    f.db.prepare(`UPDATE change_sets SET manifest_json = json_remove(manifest_json, '$.git.dirtyPaths') WHERE id = ?`).run(base.changeSetId);
    const r = await f.cmd<{ included: string[]; conflicts: Array<{ path: string }>; skipped: Array<{ path: string; reason: string }> }>('git.stageTask', { projectId: f.projectId, changeSetId: base.changeSetId });
    expect(r.included).toEqual(['task-edit.txt']);
    expect(r.skipped.map((s) => s.path)).toEqual(['user-edit.txt']);
    expect(r.skipped[0]!.reason).toContain('userPreExisting');
    f.db.close();
  }, 30_000);

  it('写操作受执行保护约束：活跃租约拒绝；只读不受影响', async () => {
    const f = makeFixture('lease', { 'a.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    insertActiveLease(f);
    await expect(f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] })).rejects.toThrow(/执行保护生效中/);
    await expect(f.cmd('git.stageTask', { projectId: f.projectId, taskId: 'tk_lease' })).rejects.toThrow(/执行保护生效中|没有已定型/);
    // 只读仍可用（预览不拒绝执行，但 blockers 指出租约）。
    const preview = await f.cmd<{ leaseHolders: Array<{ ownerTurnId: string }>; canCommit: boolean; blockers: string[] }>('git.commitPreview', { projectId: f.projectId });
    expect(preview.leaseHolders.map((h) => h.ownerTurnId)).toContain('turn_lease');
    expect(preview.canCommit).toBe(false);
    expect(preview.blockers.some((b) => b.includes('执行保护'))).toBe(true);
    // 状态读取不受影响。
    const s = await f.cmd<{ unstaged: Array<{ path: string }> }>('git.status', { projectId: f.projectId });
    expect(s.unstaged.map((e) => e.path)).toEqual(['a.txt']);
    f.db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE owner_turn_id = 'turn_lease'`).run();
    const stage = await f.cmd<{ staged: string[] }>('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    expect(stage.staged).toEqual(['a.txt']);
    f.db.close();
  }, 30_000);

  it('提交闭环：预览→提交→历史关联；提交不改任务/改动集状态；同号重放', async () => {
    const f = makeFixture('commit', { 'a.txt': 'v1\n' });
    f.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('tk3', ?, 'c1', 'room_task', 'r1', '提交关联任务', 'REVIEW')`).run(f.projectId);
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const base = await f.cmd<{ changeSetId: string }>('changeset.captureBaseline', { projectId: f.projectId, taskId: 'tk3' });
    await f.cmd('changeset.finalize', { changeSetId: base.changeSetId });
    f.db.prepare(`UPDATE change_sets SET application_status = 'applied' WHERE id = ?`).run(base.changeSetId);

    const preview = await f.cmd<{ head: string | null; branch: string; staged: Array<{ path: string }>; indexDigest: string; canCommit: boolean; blockers: string[]; identity: { name: string | null; email: string | null } }>('git.commitPreview', { projectId: f.projectId });
    expect(preview.canCommit).toBe(true);
    expect(preview.staged.map((s) => s.path)).toEqual(['a.txt']);
    expect(preview.head).toMatch(/^[0-9a-f]{40}$/);
    expect(preview.identity).toMatchObject({ name: 't', email: 't@t' });

    const cid = `commit-${randomUUID().slice(0, 10)}`;
    const c1 = await f.cmd<{ commit: string; headBefore: string | null; subject: string }>('git.commit', {
      projectId: f.projectId, message: '任务改动提交', expectedHead: preview.head, expectedIndexDigest: preview.indexDigest, taskId: 'tk3', changeSetIds: [base.changeSetId],
    }, cid);
    expect(c1.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(c1.commit).not.toBe(preview.head);
    expect(git(f.root, 'log', '-1', '--format=%B')).toContain(`Zhongshuo-Command-Id: ${cid}`);
    // 提交不改任务/改动集/交付状态（三个维度独立）。
    expect((f.db.prepare(`SELECT status FROM tasks WHERE id = 'tk3'`).get() as { status: string }).status).toBe('REVIEW');
    expect((f.db.prepare(`SELECT application_status FROM change_sets WHERE id = ?`).get(base.changeSetId) as { application_status: string }).application_status).toBe('applied');
    // 同号重放：原回执，不重复提交。
    const c2 = await f.cmd<{ commit: string; replayed?: boolean }>('git.commit', {
      projectId: f.projectId, message: '任务改动提交', expectedHead: preview.head, expectedIndexDigest: preview.indexDigest, taskId: 'tk3', changeSetIds: [base.changeSetId],
    }, cid);
    expect(c2.replayed).toBe(true);
    expect(c2.commit).toBe(c1.commit);
    // 历史：本产品提交带任务/改动集关联；外部提交不虚构归属。
    git(f.root, 'commit', '-q', '--allow-empty', '-m', 'external commit');
    const h = await f.cmd<{ items: Array<{ oid: string; subject: string; taskIds: string[]; changeSetIds: string[] }>; head: string; hasMore: boolean }>('git.history', { projectId: f.projectId, limit: 10 });
    expect(h.items).toHaveLength(3); // init + 本产品提交 + external
    expect(h.items[0]!.subject).toBe('external commit');
    expect(h.items[0]!.taskIds).toEqual([]);
    expect(h.items[1]!.oid).toBe(c1.commit);
    expect(h.items[1]!.taskIds).toEqual(['tk3']);
    expect(h.items[1]!.changeSetIds).toEqual([base.changeSetId]);
    expect(h.head).toBe(h.items[0]!.oid);
    f.db.close();
  }, 30_000);

  it('预览绑定：HEAD 移动/暂存区变化 → 拒绝提交（不提交用户没看到的内容）', async () => {
    const f = makeFixture('stale', { 'a.txt': 'v1\n', 'b.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p1 = await f.cmd<{ head: string | null; indexDigest: string }>('git.commitPreview', { projectId: f.projectId });
    // 场景①：预览后外部又产生提交 → HEAD 移动。
    git(f.root, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p1.head, expectedIndexDigest: p1.indexDigest })).rejects.toThrow(/HEAD 已移动/);
    // 场景②：重新预览后，暂存区又被加料 → 摘要不一致。
    const p2 = await f.cmd<{ head: string | null; indexDigest: string }>('git.commitPreview', { projectId: f.projectId });
    writeFileSync(join(f.root, 'b.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['b.txt'] });
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p2.head, expectedIndexDigest: p2.indexDigest })).rejects.toThrow(/暂存区与预览时不一致/);
    // 用最新预览提交成功（正常闭环不被误伤）。
    const p3 = await f.cmd<{ head: string | null; indexDigest: string; canCommit: boolean }>('git.commitPreview', { projectId: f.projectId });
    expect(p3.canCommit).toBe(true);
    const ok = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '包含 b 的提交', expectedHead: p3.head, expectedIndexDigest: p3.indexDigest });
    expect(ok.commit).toMatch(/^[0-9a-f]{40}$/);
    f.db.close();
  }, 30_000);

  it('冲突未解决禁止提交；身份缺失如实报错（不代改配置）', async () => {
    const f = makeFixture('conflict', { 'c.txt': 'base\n' });
    const mainBranch = git(f.root, 'symbolic-ref', '--short', 'HEAD').trim();
    // 构造真实合并冲突：从 base 分叉，两侧各改同一行（不用 stash/重置——只走 add/commit/checkout -b）。
    git(f.root, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(f.root, 'c.txt'), 'theirs\n', 'utf8');
    git(f.root, 'add', '--', 'c.txt');
    git(f.root, 'commit', '-q', '-m', 'theirs');
    git(f.root, 'checkout', '-q', mainBranch);
    writeFileSync(join(f.root, 'c.txt'), 'ours\n', 'utf8');
    git(f.root, 'add', '--', 'c.txt');
    git(f.root, 'commit', '-q', '-m', 'ours');
    const merge = gitLax(f.root, 'merge', 'other');
    expect(merge.status).not.toBe(0);
    const porcelain = git(f.root, 'status', '--porcelain');
    expect(porcelain).toContain('UU');
    const p1 = await f.cmd<{ head: string | null; conflicts: string[]; canCommit: boolean; blockers: string[] }>('git.commitPreview', { projectId: f.projectId });
    expect(p1.conflicts).toEqual(['c.txt']);
    expect(p1.canCommit).toBe(false);
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p1.head, expectedIndexDigest: p1.indexDigest })).rejects.toThrow(/前置不满足|冲突未解决/);
    // 身份缺失：仓库 unset + 屏蔽全局/系统配置（GIT_CONFIG_* 指向空文件）→ 预览阻塞 +
    // 提交拒绝；不代改用户配置。
    git(f.root, 'config', '--unset', 'user.name');
    git(f.root, 'config', '--unset', 'user.email');
    const emptyCfg = join(tmpRoot, 'empty-git-config');
    writeFileSync(emptyCfg, '', 'utf8');
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const savedSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = emptyCfg;
    process.env.GIT_CONFIG_SYSTEM = emptyCfg;
    try {
      const p2 = await f.cmd<{ head: string | null; identity: { name: string | null; email: string | null }; blockers: string[] }>('git.commitPreview', { projectId: f.projectId });
      expect(p2.identity.name).toBeNull();
      expect(p2.blockers.some((b) => b.includes('user.name'))).toBe(true);
      await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p2.head, expectedIndexDigest: p2.indexDigest })).rejects.toThrow(/前置不满足/);
    } finally {
      if (savedGlobal == null) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedSystem == null) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    }
    f.db.close();
  }, 30_000);

  it('崩溃恢复：git 已提交、回执与日志未落库 → 重试按尾部标记核对既成事实（不重复提交）', async () => {
    const f = makeFixture('crash', { 'a.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const preview = await f.cmd<{ head: string | null; indexDigest: string }>('git.commitPreview', { projectId: f.projectId });
    const cid = `crash-${randomUUID().slice(0, 10)}`;
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexDigest: preview.indexDigest }, cid);
    // 模拟崩溃窗口：git 提交已发生，但回执与操作日志均未落库（手工抹掉）。
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    f.db.prepare(`DELETE FROM git_operations WHERE id = ?`).run(cid);
    const logBefore = git(f.root, 'rev-list', '--count', 'HEAD').trim();
    const retry = await f.cmd<{ commit: string; recovered?: boolean }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexDigest: preview.indexDigest }, cid);
    expect(retry.recovered).toBe(true);
    expect(retry.commit).toBe(c1.commit);
    expect(git(f.root, 'rev-list', '--count', 'HEAD').trim()).toBe(logBefore); // 未重复提交
    // 恢复后日志补记；再重试=正常回执重放。
    expect((f.db.prepare(`SELECT count(*) c FROM git_operations WHERE id = ?`).get(cid) as { c: number }).c).toBe(1);
    const again = await f.cmd<{ commit: string; replayed?: boolean }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexDigest: preview.indexDigest }, cid);
    expect(again.replayed).toBe(true);
    // 仅日志幸存（回执被清理策略删除）的恢复路径。
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    const fromJournal = await f.cmd<{ commit: string; recovered?: boolean }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexDigest: preview.indexDigest }, cid);
    expect(fromJournal.recovered).toBe(true);
    expect(fromJournal.commit).toBe(c1.commit);
    expect(git(f.root, 'rev-list', '--count', 'HEAD').trim()).toBe(logBefore);
    f.db.close();
  }, 30_000);

  it('子目录项目：项目范围外路径拒绝写操作（不悄悄扩大范围）；仓库内路径可用', async () => {
    const f = makeFixture('subdir-w', { 'outside.txt': 'o\n', 'pkg/inside.txt': 'i\n' }, true);
    writeFileSync(join(f.root, 'outside.txt'), 'changed\n', 'utf8');
    writeFileSync(join(f.root, 'pkg', 'inside.txt'), 'changed\n', 'utf8');
    await expect(f.cmd('git.stage', { projectId: f.projectId, paths: ['outside.txt'] })).rejects.toThrow(/项目范围外/);
    // 工作树相对路径 pkg/inside.txt 属于项目范围。
    const r = await f.cmd<{ staged: string[] }>('git.stage', { projectId: f.projectId, paths: ['pkg/inside.txt'] });
    expect(r.staged).toEqual(['pkg/inside.txt']);
    f.db.close();
  }, 30_000);
});
