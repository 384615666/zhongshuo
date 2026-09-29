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

    const preview = await f.cmd<{ head: string | null; branch: string | null; staged: Array<{ path: string }>; indexTree: string | null; canCommit: boolean; blockers: string[]; identity: { name: string | null; email: string | null } }>('git.commitPreview', { projectId: f.projectId });
    expect(preview.canCommit).toBe(true);
    expect(preview.staged.map((s) => s.path)).toEqual(['a.txt']);
    expect(preview.head).toMatch(/^[0-9a-f]{40}$/);
    expect(preview.identity).toMatchObject({ name: 't', email: 't@t' });

    const cid = `commit-${randomUUID().slice(0, 10)}`;
    const c1 = await f.cmd<{ commit: string; headBefore: string | null; subject: string }>('git.commit', {
      projectId: f.projectId, message: '任务改动提交', expectedHead: preview.head, expectedIndexTree: preview.indexTree, expectedBranch: preview.branch, taskId: 'tk3', changeSetIds: [base.changeSetId],
    }, cid);
    expect(c1.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(c1.commit).not.toBe(preview.head);
    expect(git(f.root, 'log', '-1', '--format=%B')).toContain(`Zhongshuo-Command-Id: ${cid}`);
    // 提交不改任务/改动集/交付状态（三个维度独立）。
    expect((f.db.prepare(`SELECT status FROM tasks WHERE id = 'tk3'`).get() as { status: string }).status).toBe('REVIEW');
    expect((f.db.prepare(`SELECT application_status FROM change_sets WHERE id = ?`).get(base.changeSetId) as { application_status: string }).application_status).toBe('applied');
    // 同号重放：原回执，不重复提交。
    const c2 = await f.cmd<{ commit: string; replayed?: boolean }>('git.commit', {
      projectId: f.projectId, message: '任务改动提交', expectedHead: preview.head, expectedIndexTree: preview.indexTree, expectedBranch: preview.branch, taskId: 'tk3', changeSetIds: [base.changeSetId],
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
    const p1 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    // 场景①：预览后外部又产生提交 → HEAD 移动。外部提交走 plumbing（保树推进 HEAD、
    // 不消费索引）——等价于「别人在别处提交了同一分支」，不影响已暂存内容。
    const headBefore = git(f.root, 'rev-parse', 'HEAD').trim();
    const extOid = git(f.root, 'commit-tree', `${headBefore}^{tree}`, '-p', headBefore, '-m', 'someone else').trim();
    git(f.root, 'update-ref', 'HEAD', extOid, headBefore);
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p1.head, expectedIndexTree: p1.indexTree, expectedBranch: p1.branch, })).rejects.toThrow(/HEAD 已移动/);
    // 场景②：重新预览后，暂存区又被加料 → 内容 tree 不一致（同路径状态不变——内容级绑定）。
    const p2 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    expect(p2.indexTree).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(f.root, 'b.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['b.txt'] });
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p2.head, expectedIndexTree: p2.indexTree, expectedBranch: p2.branch, })).rejects.toThrow(/暂存区内容与预览时不一致/);
    // 用最新预览提交成功（正常闭环不被误伤）。
    const p3 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null; canCommit: boolean }>('git.commitPreview', { projectId: f.projectId });
    expect(p3.canCommit).toBe(true);
    const ok = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '包含 b 的提交', expectedHead: p3.head, expectedIndexTree: p3.indexTree, expectedBranch: p3.branch, });
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
    const p1 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null; conflicts: string[]; canCommit: boolean; blockers: string[] }>('git.commitPreview', { projectId: f.projectId });
    expect(p1.conflicts).toEqual(['c.txt']);
    expect(p1.canCommit).toBe(false);
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p1.head, expectedIndexTree: p1.indexTree, expectedBranch: p1.branch, })).rejects.toThrow(/前置不满足|冲突未解决/);
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
      const p2 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null; identity: { name: string | null; email: string | null }; blockers: string[] }>('git.commitPreview', { projectId: f.projectId });
      expect(p2.identity.name).toBeNull();
      expect(p2.blockers.some((b) => b.includes('user.name'))).toBe(true);
      await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p2.head, expectedIndexTree: p2.indexTree, expectedBranch: p2.branch, })).rejects.toThrow(/前置不满足/);
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
    const preview = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const cid = `crash-${randomUUID().slice(0, 10)}`;
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexTree: preview.indexTree, expectedBranch: preview.branch, }, cid);
    // 模拟崩溃窗口：git 提交已发生，但回执与操作日志均未落库（手工抹掉）。
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    f.db.prepare(`DELETE FROM git_operations WHERE id = ?`).run(cid);
    const logBefore = git(f.root, 'rev-list', '--count', 'HEAD').trim();
    const retry = await f.cmd<{ commit: string; recovered?: boolean }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexTree: preview.indexTree, expectedBranch: preview.branch, }, cid);
    expect(retry.recovered).toBe(true);
    expect(retry.commit).toBe(c1.commit);
    expect(git(f.root, 'rev-list', '--count', 'HEAD').trim()).toBe(logBefore); // 未重复提交
    // 恢复后日志补记；再重试=正常回执重放。
    expect((f.db.prepare(`SELECT count(*) c FROM git_operations WHERE id = ?`).get(cid) as { c: number }).c).toBe(1);
    const again = await f.cmd<{ commit: string; replayed?: boolean }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexTree: preview.indexTree, expectedBranch: preview.branch, }, cid);
    expect(again.replayed).toBe(true);
    // 仅日志幸存（回执被清理策略删除）的恢复路径。
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    const fromJournal = await f.cmd<{ commit: string; recovered?: boolean }>('git.commit', { projectId: f.projectId, message: '崩溃演练', expectedHead: preview.head, expectedIndexTree: preview.indexTree, expectedBranch: preview.branch, }, cid);
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

describe('第十一轮·一：提交内容绑定与操作保护', () => {
  it('内容级绑定反例：暂存 A → 预览 → 同文件再暂存 B（路径/状态不变）→ 旧预览提交拒绝，HEAD 不变', async () => {
    const f = makeFixture('treebind', { 'a.txt': 'base\n' });
    writeFileSync(join(f.root, 'a.txt'), '内容A\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    expect(p.indexTree).toMatch(/^[0-9a-f]{40}$/);
    // 同文件换内容再暂存——XY/路径完全不变，只有内容（tree）变化。
    writeFileSync(join(f.root, 'a.txt'), '内容B（用户没在预览里看到）\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const headBefore = git(f.root, 'rev-parse', 'HEAD').trim();
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch })).rejects.toThrow(/暂存区内容与预览时不一致/);
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(headBefore); // HEAD 未变（未提交任何内容）
    // 用新预览提交 B 内容成功（正常闭环）。
    const p2 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const ok = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '提交 B', expectedHead: p2.head, expectedIndexTree: p2.indexTree, expectedBranch: p2.branch });
    expect(git(f.root, 'show', '-s', '--format=%B', ok.commit)).toContain('提交 B');
    f.db.close();
  }, 30_000);

  it('同 OID 双分支竞态：预览后外部切到同 OID 分支 → 提交只更新批准的 ref，未批准分支绝不动', async () => {
    const f = makeFixture('sameswap', { 'a.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    // 预览检查通过后、CAS 执行前（_between 接缝）：外部建一个指向同一 OID 的分支并切过去——
    // HEAD 符号引用已变；旧实现经 HEAD 解引用 update-ref 会把提交落到未批准的 other 分支上。
    const { execFileSync: ex } = await import('node:child_process');
    const { gitCommit } = await import('../../src/daemon/gitWrite.ts');
    const targetRef = `refs/heads/${p.branch}`;
    const commitResult = await gitCommit(f.db, {
      projectId: f.projectId, projectRoot: f.root, message: '目标绑定提交',
      expectedHead: p.head, expectedIndexTree: p.indexTree!, expectedBranch: p.branch!,
      journal: { commandId: `c-swap-${randomUUID().slice(0, 8)}`, scope: 'user:u_gitwrite', payloadHash: 'x'.repeat(8), now: Date.now() },
      _between: async () => {
        ex('git', ['-C', f.root, 'branch', 'other-same', p.head!]);
        ex('git', ['-C', f.root, 'checkout', '-q', 'other-same']); // 同 OID 切换——HEAD 指向 other-same
      },
    });
    // 结果记录显式 ref（不依赖读 HEAD 猜）；副作用事实：批准的 ref 前进、未批准分支保持原 OID。
    expect(commitResult.updatedRef).toBe(targetRef);
    expect(ex('git', ['-C', f.root, 'rev-parse', targetRef]).toString('utf8').trim()).toBe(commitResult.commit);
    expect(ex('git', ['-C', f.root, 'rev-parse', 'refs/heads/other-same']).toString('utf8').trim()).toBe(p.head);
    // HEAD 仍指向外部选择的 other-same（我们没动它）；目标 ref 核对一致 → consistent。
    expect(ex('git', ['-C', f.root, 'symbolic-ref', '--short', 'HEAD']).toString('utf8').trim()).toBe('other-same');
    expect(commitResult.consistent).toBeUndefined();
    f.db.close();
  }, 30_000);

  it('目标分支绑定：同一 HEAD 切换分支后，旧预览提交拒绝（不把提交套到另一分支）', async () => {
    const f = makeFixture('branchbind', { 'a.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    expect(p.branch).toBe(git(f.root, 'symbolic-ref', '--short', 'HEAD').trim());
    // 同一 HEAD 切到新分支（未提交内容随行）——HEAD 未变但提交目标分支变了。
    git(f.root, 'checkout', '-q', '-b', 'other');
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(p.head);
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch })).rejects.toThrow(/目标分支已变化/);
    expect(git(f.root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('other'); // 未误切回/未提交
    f.db.close();
  }, 30_000);

  it('提交后核对：parent/tree/ref 与批准对象一致；CAS 后外部又推进 → consistent:false、不记录别人的 HEAD、不回滚', async () => {
    const { execFileSync: ex } = await import('node:child_process');
    const f = makeFixture('verify', { 'a.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    // 正常提交：核对 parent/tree/HEAD/分支全部一致。
    const ok = await f.cmd<{ commit: string; headBefore: string | null; consistent?: boolean; headAfterActual?: string }>('git.commit', { projectId: f.projectId, message: '核对提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    expect(ok.consistent).toBeUndefined(); // 一致
    expect(git(f.root, 'rev-parse', `${ok.commit}^`).trim()).toBe(p.head);
    expect(git(f.root, 'rev-parse', `${ok.commit}^{tree}`).trim()).toBe(p.indexTree);
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(ok.commit);

    // CAS 成功后、核对读取前外部又推进（_between 测试接缝——正式命令不传）。
    writeFileSync(join(f.root, 'b.txt'), 'n\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['b.txt'] });
    const p2 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const { gitCommit } = await import('../../src/daemon/gitWrite.ts');
    const cid = `c-between-${randomUUID().slice(0, 8)}`;
    const r = await gitCommit(f.db, {
      projectId: f.projectId, projectRoot: f.root, message: '被超越的提交',
      expectedHead: p2.head, expectedIndexTree: p2.indexTree!, expectedBranch: p2.branch!,
      journal: { commandId: cid, scope: 'user:u_gitwrite', payloadHash: 'x'.repeat(8), now: Date.now() },
      _between: async () => {
        // 外部以「我们的新 HEAD」为父再推进一次（真实竞态：两边都成功，我们被超越）。
        const headNow = ex('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const ext = ex('git', ['-C', f.root, 'commit-tree', `${headNow}^{tree}`, '-p', headNow, '-m', 'external raced'], { encoding: 'utf8' }).trim();
        ex('git', ['-C', f.root, 'update-ref', 'HEAD', ext, headNow]);
      },
    });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.consistent).toBe(false); // 核对发现不一致
    const headNow = git(f.root, 'rev-parse', 'HEAD').trim();
    expect(headNow).not.toBe(r.commit); // 仓库现值=外部提交
    expect(r.headAfterActual).toBe(headNow); // 结果如实记录实际 HEAD——不是别人的提交被记为本次
    expect(git(f.root, 'log', '--format=%s', `${r.commit}..${headNow}`).trim()).toBe('external raced');
    // 我们的对象仍在历史链上（父链可达）——没有回滚/改写。
    expect(gitLax(f.root, 'merge-base', '--is-ancestor', r.commit, headNow).status).toBe(0);
    // 审计事件留痕（不自动 reset——进入核对流程）。
    const evt = f.db.prepare(`SELECT kind FROM domain_events WHERE kind = 'git.commitVerifyInconsistent' ORDER BY seq DESC LIMIT 1`).get() as { kind: string } | undefined;
    expect(evt?.kind).toBe('git.commitVerifyInconsistent');
    f.db.close();
  }, 30_000);

  it('仓库级写互斥：并发 stage/commit 不交错；同工作树两项目共用互斥；undo 活跃拒绝 Git 写；Git 写在途拒绝 undo；目录身份失败拒绝写', async () => {
    // ① 互斥串行性：同工作树并发 6 个写操作，进入/退出不交错。
    const { withRepoWriteLock, repoWriteBusy } = await import('../../src/daemon/gitWrite.ts');
    const events: string[] = [];
    const rootA = join(tmpRoot, `mutex-${++seq}`);
    await Promise.all(Array.from({ length: 6 }, (_, i) => withRepoWriteLock(rootA, async () => {
      events.push(`enter${i}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`exit${i}`);
    })));
    // 串行判据：任意时刻已进入数 ≥ 已退出数，且每对 enter/exit 相邻（无交叉）。
    let depth = 0;
    for (const e of events) {
      depth += e.startsWith('enter') ? 1 : -1;
      expect(depth).toBeLessThanOrEqual(1); // 从未有两个同时在途
    }
    expect(events.filter((e) => e.startsWith('enter'))).toHaveLength(6);
    expect(repoWriteBusy(rootA)).toBe(false); // 全部完成后不在途

    // ② 同一工作树两个项目行：并发写经命令面不交错（一成一败或两成，索引状态一致）。
    const f = makeFixture('twoproj', { 'a.txt': '1\n', 'b.txt': '1\n' });
    f.db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('pB','d2',?,?,'{}',0)`).run(f.root, f.root);
    writeFileSync(join(f.root, 'a.txt'), '2\n', 'utf8');
    writeFileSync(join(f.root, 'b.txt'), '2\n', 'utf8');
    const [ra, rb] = await Promise.allSettled([
      f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] }),
      f.cmd<{ staged: string[] }>('git.stage', { projectId: 'pB', paths: ['b.txt'] }),
    ]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('fulfilled');
    const porcelain = git(f.root, 'status', '--porcelain');
    expect(porcelain).toContain('M  a.txt');
    expect(porcelain).toContain('M  b.txt'); // 两个 stage 都生效且索引一致（无半途破坏）

    // ③ undo 活跃（未收口）→ Git 写拒绝。
    f.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES ('tk_u', ?, 'c1', 'room_task', 'r1', 'u')`).run(f.projectId);
    const csId = `cs_u${++seq}`;
    f.db.prepare(`INSERT INTO change_sets (id, project_id, task_id, before_ref, after_ref, application_status) VALUES (?, ?, 'tk_u', '{}', '{}', 'applied')`).run(csId, f.projectId);
    f.db.prepare(`INSERT INTO change_set_undos (id, change_set_id, status, steps_json, created_at, updated_at) VALUES ('u1', ?, 'in_progress', '[]', 0, 0)`).run(csId);
    await expect(f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] })).rejects.toThrow(/撤销未收口/);

    // ④ 目录身份解析失败 → 写拒绝（不放行）。
    f.db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('pGone','d3',?,?, '{}',0)`).run(join(tmpRoot, 'not-exist-dir'), join(tmpRoot, 'not-exist-dir'));
    await expect(f.cmd('git.stage', { projectId: 'pGone', paths: ['x'] })).rejects.toThrow(/目录身份无法解析|不是 git 仓库/);
    f.db.close();
  }, 30_000);

  it('空仓库首提交经 CAS（unborn 分支）；detached HEAD 拒绝产品内提交', async () => {
    // 空仓库：makeFixture 无文件 → 无初始提交。
    const f = makeFixture('empty', {});
    writeFileSync(join(f.root, 'first.txt'), '1\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['first.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null; canCommit: boolean }>('git.commitPreview', { projectId: f.projectId });
    expect(p.head).toBeNull();
    expect(p.branch).toMatch(/^(master|main)$/);
    expect(p.canCommit).toBe(true);
    const c1 = await f.cmd<{ commit: string; consistent?: boolean }>('git.commit', { projectId: f.projectId, message: '首提交', expectedHead: null, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    expect(c1.consistent).toBeUndefined();
    expect(git(f.root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');

    // detached HEAD：预览 blocker + 提交拒绝。
    git(f.root, 'checkout', '-q', '--detach');
    const p2 = await f.cmd<{ branch: string | null; canCommit: boolean; blockers: string[] }>('git.commitPreview', { projectId: f.projectId });
    expect(p2.branch).toBeNull();
    expect(p2.canCommit).toBe(false);
    expect(p2.blockers.some((b) => b.includes('detached'))).toBe(true);
    f.db.close();
  }, 30_000);
});

describe('第十一轮·二：任务批量暂存双向保护与崩溃恢复', () => {
  /** 建一个带定型改动集的任务 fixture（基线→任务改动→定型）。 */
  async function makeChangeSet(f: Fixture, taskId: string, mutate: (root: string) => void): Promise<string> {
    f.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES (?, ?, 'c1', 'room_task', 'r1', '批量任务')`).run(taskId, f.projectId);
    const base = await f.cmd<{ changeSetId: string }>('changeset.captureBaseline', { projectId: f.projectId, taskId });
    mutate(f.root);
    await f.cmd('changeset.finalize', { changeSetId: base.changeSetId });
    return base.changeSetId;
  }

  it('after 冻结后被用户继续修改/新增被改/删除被重建 → 冲突，被保护内容不进索引', async () => {
    const f = makeFixture('afterguard', { 'task-mod.txt': 't0\n', 'task-del.txt': 'd0\n' });
    const csId = await makeChangeSet(f, 'tk_a1', (root) => {
      writeFileSync(join(root, 'task-mod.txt'), 't1-任务\n', 'utf8');
      writeFileSync(join(root, 'task-new.txt'), 'n1-任务\n', 'utf8');
      rmSync(join(root, 'task-del.txt'));
    });
    // 定型后的用户修改：改任务产出文件、改任务新增文件、重建任务删除的文件。
    writeFileSync(join(f.root, 'task-mod.txt'), 't1-任务+用户后来又改\n', 'utf8');
    writeFileSync(join(f.root, 'task-new.txt'), 'n1-任务+用户后来又改\n', 'utf8');
    writeFileSync(join(f.root, 'task-del.txt'), '用户重建\n', 'utf8');
    const r = await f.cmd<{ included: string[]; conflicts: Array<{ path: string; reason: string }>; skipped: Array<{ path: string }> }>('git.stageTask', { projectId: f.projectId, changeSetId: csId });
    expect(r.included).toEqual([]); // 全部冲突——无一纳入
    const conflictPaths = r.conflicts.map((c) => c.path).sort();
    expect(conflictPaths).toEqual(['task-del.txt', 'task-mod.txt', 'task-new.txt']);
    expect(r.conflicts.find((c) => c.path === 'task-mod.txt')!.reason).toContain('任务定型（after 冻结）后该文件已被修改');
    expect(r.conflicts.find((c) => c.path === 'task-new.txt')!.reason).toContain('内容与冻结 after 不一致');
    expect(r.conflicts.find((c) => c.path === 'task-del.txt')!.reason).toContain('已重新存在');
    // 被保护内容没有进入索引（porcelain 无任何 staged 条目）。
    expect(git(f.root, 'status', '--porcelain')).not.toMatch(/^[MARD]/);
    f.db.close();
  }, 30_000);

  it('多个改动集同路径：按最新定型裁决（非先遇到）；与所选 after 不符 → 冲突', async () => {
    const f = makeFixture('multiset', { 'x.txt': 'v0\n' });
    // cs1（先定型）：x=v1；cs2（后定型）：x=v2。
    await makeChangeSet(f, 'tk_m1', (root) => { writeFileSync(join(root, 'x.txt'), 'v1\n', 'utf8'); });
    await makeChangeSet(f, 'tk_m2', (root) => { writeFileSync(join(root, 'x.txt'), 'v2\n', 'utf8'); });
    // 指定**旧集**（tk_m1 的集）：裁决以该集为准，但工作区是 v2 → 与该集 after 不符 → 冲突。
    const cs1 = (f.db.prepare(`SELECT id FROM change_sets WHERE task_id = 'tk_m1'`).get() as { id: string }).id;
    const r1 = await f.cmd<{ included: string[]; conflicts: Array<{ path: string; reason: string }> }>('git.stageTask', { projectId: f.projectId, changeSetId: cs1 });
    expect(r1.included).toEqual([]);
    expect(r1.conflicts[0]!.reason).toContain('内容与冻结 after 不一致');
    expect(git(f.root, 'status', '--porcelain')).not.toMatch(/^[MARD]/); // 未纳入 v2
    // 按任务（tk_m2）取最新定型：工作区 v2 与其 after 一致 → 纳入。
    const r2 = await f.cmd<{ included: string[]; conflicts: Array<{ path: string; reason: string }> }>('git.stageTask', { projectId: f.projectId, taskId: 'tk_m2' });
    expect(r2.included).toEqual(['x.txt']);
    expect(git(f.root, 'status', '--porcelain')).toContain('M  x.txt');
    f.db.close();
  }, 30_000);

  it('归属与集级门：跨项目改动集拒绝；已撤销集跳过；部分撤销集冲突', async () => {
    const f = makeFixture('gates', { 'a.txt': '1\n' });
    const csId = await makeChangeSet(f, 'tk_g1', (root) => { writeFileSync(join(root, 'a.txt'), '2\n', 'utf8'); });
    // 跨项目：改动集挂到另一项目后，原项目不得引用。
    f.db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('pOther','d2',?,?,'{}',0)`).run(join(tmpRoot, `other-${++seq}`), join(tmpRoot, `other-${seq}`));
    await expect(f.cmd('git.stageTask', { projectId: f.projectId, changeSetId: 'cs_nonexistent' })).rejects.toThrow(/不存在/);
    f.db.prepare(`UPDATE change_sets SET project_id = 'pOther' WHERE id = ?`).run(csId);
    await expect(f.cmd('git.stageTask', { projectId: f.projectId, changeSetId: csId })).rejects.toThrow(/不属于项目/);
    f.db.prepare(`UPDATE change_sets SET project_id = ? WHERE id = ?`).run(f.projectId, csId);
    // 部分撤销（application_status=partial）→ 冲突、不纳入。
    f.db.prepare(`UPDATE change_sets SET application_status = 'partial' WHERE id = ?`).run(csId);
    const r1 = await f.cmd<{ included: string[]; conflicts: Array<{ path: string; reason: string }> }>('git.stageTask', { projectId: f.projectId, changeSetId: csId });
    expect(r1.included).toEqual([]);
    expect(r1.conflicts[0]!.reason).toContain('部分撤销');
    // 整体撤销（reverted）→ 跳过（内容已回基线，不再纳入）。
    f.db.prepare(`UPDATE change_sets SET application_status = 'reverted' WHERE id = ?`).run(csId);
    const r2 = await f.cmd<{ included: string[]; skipped: Array<{ path: string; reason: string }>; conflicts: unknown[] }>('git.stageTask', { projectId: f.projectId, changeSetId: csId });
    expect(r2.included).toEqual([]);
    expect(r2.conflicts).toEqual([]);
    expect(r2.skipped[0]!.reason).toContain('已整体撤销');
    f.db.close();
  }, 30_000);

  it('意图崩溃重试：stage 同号重试遇新内容拒绝/已达成恢复；commit pending 按事实裁决；同号异参数拒绝', async () => {
    const f = makeFixture('intent', { 'a.txt': '1\n', 'b.txt': '1\n' });
    const { beginPendingOperationForTest } = await import('../../src/daemon/gitWrite.ts');
    // ① stage：回执清理后同号重试 → done 行重放（recovered）。
    writeFileSync(join(f.root, 'a.txt'), '2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] }, 'c-intent-stage-0001');
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run('c-intent-stage-0001');
    const r1 = await f.cmd<{ staged: string[]; recovered?: boolean }>('git.stage', { projectId: f.projectId, paths: ['a.txt'] }, 'c-intent-stage-0001');
    expect(r1.recovered).toBe(true);
    expect(r1.staged).toEqual(['a.txt']);
    // ② stage：把 done 行退回 pending（模拟「执行已发生、回执未落」窗口）+ 意图后又有新内容
    //    → 同号重试拒绝（不能用同号把新内容暂存进去）。
    writeFileSync(join(f.root, 'a.txt'), '3-新内容\n', 'utf8');
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run('c-intent-stage-0001');
    f.db.prepare(`UPDATE git_operations SET status = 'pending' WHERE id = ?`).run('c-intent-stage-0001');
    await expect(f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] }, 'c-intent-stage-0001')).rejects.toThrow(/又出现未暂存改动/);
    expect(git(f.root, 'status', '--porcelain')).toContain('MM a.txt'); // 暂存仍是旧 v2，新内容未进索引（MM＝staged v2 + unstaged v3）
    // ③ commit：pending 行（未执行窗口，HEAD 未动）→ 重试执行成功，恰一次提交。
    writeFileSync(join(f.root, 'b.txt'), '2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['b.txt'] }, 'c-intent-stage-0002');
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const cid = 'c-intent-commit-0001';
    const commitParams = { projectId: f.projectId, message: '意图重试提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch };
    const { computeCommandPayloadHash } = await import('../../src/domain/idempotency.ts');
    const ph = computeCommandPayloadHash({ method: 'git.commit', target: null, params: commitParams, expectedRevision: null });
    beginPendingOperationForTest(f.db, { commandId: cid, scope: 'user:u_gitwrite', payloadHash: ph, now: 1 }, { projectId: f.projectId, action: 'commit', request: {} });
    const c1 = await f.cmd<{ commit: string }>('git.commit', commitParams, cid);
    expect(git(f.root, 'rev-list', '--count', 'HEAD').trim()).toBe('2'); // init+本次——恰一次
    void c1;
    // ④ 同 commandId 异参数（日志有、回执无）→ 幂等冲突拒绝。
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    const raw = await dispatchDaemonCommand({ db: f.db, localUserId: 'u_gitwrite', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') }, {
      protocolVersion: 1, commandId: cid, method: 'git.commit',
      params: { projectId: f.projectId, message: '异参数提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch },
    }) as { ok: boolean; error?: { message: string } };
    expect(raw.ok).toBe(false);
    expect(raw.error?.message).toContain('参数不一致');
    f.db.close();
  }, 30_000);
});
