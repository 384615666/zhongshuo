/**
 * 第十一轮·三：RT-24 剩余功能（零模型调用；临时仓库+临时本地 bare remote，不触用户真实工作区/远端）。
 *
 * 覆盖：分支列表/创建（expectedHead 绑定）/切换（不自动 stash、改动随行计数、绑定校验）；
 * 单提交聚合 diff（parents/任务关联/外部提交不虚构/merge 注记）；push/pull（bare remote、
 * 快进 only、两端头绑定、远端被更新拒绝、崩溃重试远端既成事实恢复、分叉拒绝）；
 * 冲突三方内容+手动解决（非冲突路径拒绝）；commit.undo（软回退：内容回工作区、后续提交阻塞、根提交拒绝）。
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

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-gitrt24-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { timeout: 15_000, encoding: 'utf8' });
}
function gitLax(root: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', ['-C', root, ...args], { timeout: 15_000, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let seq = 0;
interface Fixture {
  root: string; db: ZhongshuoDatabase; projectId: string;
  cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T>;
}
function makeFixture(name: string, files: Record<string, string>): Fixture {
  seq += 1;
  const projectId = `p${seq}`;
  const root = join(tmpRoot, `${name}-${seq}`);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, 'd', ?, ?, '{}', 0)`).run(projectId, root, root);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?,'执行成员','agent',1)`).run(projectId);
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1',?,'大厅','mA')`).run(projectId);
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1',?,'room','r1')`).run(projectId);
  const deps: DaemonCommandDeps = { db, localUserId: 'u_rt24', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  return {
    root, db, projectId,
    cmd: async <T,>(m: string, p: unknown, commandId?: string): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `c-${randomUUID().slice(0, 10)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
  };
}

/** 建临时本地 bare remote 并挂为 origin。 */
function makeBareRemote(root: string): string {
  const bare = mkdtempSync(join(tmpRoot, 'bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'remote', 'add', 'origin', bare.replaceAll('\\', '/'));
  return bare;
}

describe('第十一轮·三：RT-24 剩余功能', () => {
  it('分支：列表/创建（expectedHead 绑定、同名如实失败）/切换（不自动 stash、改动随行、绑定校验）', async () => {
    const f = makeFixture('branch', { 'a.txt': 'v1\n' });
    const head0 = git(f.root, 'rev-parse', 'HEAD').trim();
    const list1 = await f.cmd<{ current: string | null; branches: Array<{ name: string }>; dirtyCount: number }>('git.branch.list', { projectId: f.projectId });
    expect(list1.current).toBe('main');
    expect(list1.branches.map((b) => b.name)).toEqual(['main']);
    expect(list1.dirtyCount).toBe(0);
    // 创建：expectedHead 绑定；不切换。
    const created = await f.cmd<{ name: string; oid: string }>('git.branch.create', { projectId: f.projectId, name: 'feature-x', expectedHead: head0 });
    expect(created).toMatchObject({ name: 'feature-x', oid: head0 });
    expect(git(f.root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    await expect(f.cmd('git.branch.create', { projectId: f.projectId, name: 'feature-x', expectedHead: head0 })).rejects.toThrow(/已存在|失败/);
    await expect(f.cmd('git.branch.create', { projectId: f.projectId, name: 'bad name', expectedHead: head0 })).rejects.toThrow(/不合法/);
    // 切换：未提交改动随行（不自动 stash）——切换后 dirtyCount=1 如实告知。
    writeFileSync(join(f.root, 'a.txt'), 'v2-未提交\n', 'utf8');
    const co = await f.cmd<{ branch: string; headAfter: string | null; carriedDirtyCount: number }>('git.checkout', { projectId: f.projectId, branch: 'feature-x', expectedHead: head0, expectedBranch: 'main' });
    expect(co.branch).toBe('feature-x');
    expect(co.headAfter).toBe(head0);
    expect(co.carriedDirtyCount).toBe(1);
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('v2-未提交\n'); // 改动跟着过来了
    // 绑定校验：expectedBranch 不符（当前已在 feature-x）→ 拒绝。
    await expect(f.cmd('git.checkout', { projectId: f.projectId, branch: 'main', expectedHead: head0, expectedBranch: 'main' })).rejects.toThrow(/当前分支已变化/);
    f.db.close();
  }, 30_000);

  it('单提交聚合 diff：parents/任务关联/正文；外部提交不虚构归属；merge 提交注记不虚构', async () => {
    const f = makeFixture('cdiff', { 'a.txt': 'v1\n' });
    // 本产品提交（带任务关联）。
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '带任务的提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch, taskId: 'tk_cd' });
    const d1 = await f.cmd<{ commit: { oid: string; parents: string[]; subject: string; taskIds: string[]; changeSetIds: string[] }; patches: Array<{ path: string; change: string; text: string }> }>('git.commitDiff', { projectId: f.projectId, oid: c1.commit });
    expect(d1.commit.parents).toEqual([p.head]);
    expect(d1.commit.subject).toBe('带任务的提交');
    expect(d1.commit.taskIds).toEqual(['tk_cd']);
    expect(d1.patches.map((x) => x.path)).toEqual(['a.txt']);
    expect(d1.patches[0]!.text).toContain('+v2');
    // 外部提交：无关联（不虚构归属）。
    writeFileSync(join(f.root, 'ext.txt'), 'e\n', 'utf8');
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-q', '-m', 'external');
    const extOid = git(f.root, 'rev-parse', 'HEAD').trim();
    const d2 = await f.cmd<{ commit: { taskIds: string[] }; patches: Array<{ path: string }> }>('git.commitDiff', { projectId: f.projectId, oid: extOid });
    expect(d2.commit.taskIds).toEqual([]);
    expect(d2.patches.map((x) => x.path)).toEqual(['ext.txt']);
    // merge 提交：多父 → 注记 + 无虚构 diff。
    git(f.root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(f.root, 's.txt'), 's\n', 'utf8');
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-q', '-m', 'side');
    git(f.root, 'checkout', '-q', 'main');
    const mg = gitLax(f.root, 'merge', '--no-ff', '-m', 'merge side', 'side');
    expect(mg.status).toBe(0);
    const mergeOid = git(f.root, 'rev-parse', 'HEAD').trim();
    const d3 = await f.cmd<{ commit: { parents: string[] }; mergeNote?: string; patches: unknown[] }>('git.commitDiff', { projectId: f.projectId, oid: mergeOid });
    expect(d3.commit.parents).toHaveLength(2);
    expect(d3.mergeNote).toContain('合并提交');
    expect(d3.patches).toEqual([]);
    // 非法/不存在 oid 拒绝。
    await expect(f.cmd('git.commitDiff', { projectId: f.projectId, oid: 'nothash' })).rejects.toThrow();
    await expect(f.cmd('git.commitDiff', { projectId: f.projectId, oid: '0'.repeat(40) })).rejects.toThrow(/不存在/);
    f.db.close();
  }, 30_000);

  it('push/pull（临时本地 bare remote）：两端头绑定+快进 only+远端被更新拒绝+分叉拒绝+崩溃既成事实恢复', async () => {
    const f = makeFixture('remote', { 'a.txt': 'v1\n' });
    makeBareRemote(f.root);
    const head0 = git(f.root, 'rev-parse', 'HEAD').trim();
    // 首推（远端分支不存在）→ expectedRemoteHead=null。
    const push1 = await f.cmd<{ from: string | null; to: string }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: head0, expectedRemoteHead: null });
    expect(push1).toMatchObject({ from: null, to: head0 });
    // 本地新提交 → 推送（远端头=head0）。
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '推送用提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    // 远端头报错（expectedRemoteHead 给 null 而实际是 head0）→ 拒绝。
    await expect(f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: null })).rejects.toThrow(/远端分支已被更新/);
    const push2 = await f.cmd<{ from: string | null; to: string }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: head0 });
    expect(push2).toMatchObject({ from: head0, to: c1.commit });
    // 崩溃窗口：回执清理后同号重推 → 远端已=目标 → 既成事实恢复（不重复推送、不报错）。
    const pushCid = 'c-rt24-push-retry1';
    await f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: head0 }, pushCid);
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(pushCid);
    const pushRetry = await f.cmd<{ to: string; recovered?: boolean; replayed?: boolean }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: head0 }, pushCid);
    expect(pushRetry.recovered ?? pushRetry.replayed).toBeTruthy();
    expect(pushRetry.to).toBe(c1.commit);
    f.db.close();
  }, 30_000);

  it('push 非快进拒绝；pull 快进拉取+分叉拒绝（bare remote 双侧）', async () => {
    const f = makeFixture('remote2', { 'a.txt': 'v1\n' });
    const bare = makeBareRemote(f.root);
    const head0 = git(f.root, 'rev-parse', 'HEAD').trim();
    await f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: head0, expectedRemoteHead: null });
    // 远端被另一克隆推进（模拟他人提交）。
    const other = mkdtempSync(join(tmpRoot, 'other-'));
    git(other, 'clone', '-q', bare.replaceAll('\\', '/'), '.');
    git(other, 'config', 'user.email', 'o@t'); git(other, 'config', 'user.name', 'o');
    writeFileSync(join(other, 'b.txt'), 'other\n', 'utf8');
    git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'other commit'); git(other, 'push', '-q', 'origin', 'main');
    const remoteNow = git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
    // 本地也前进 → 分叉：push 非快进拒绝（不强推）。
    writeFileSync(join(f.root, 'a.txt'), 'local\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const cLocal = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '本地提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    await expect(f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: cLocal.commit, expectedRemoteHead: remoteNow })).rejects.toThrow(/不是快进/);
    // pull 分叉（ff-only）→ 拒绝（不自动合并提交）。
    await expect(f.cmd('git.pull', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: cLocal.commit })).rejects.toThrow(/不是快进|分叉/);
    // 本地回到远端（撤销本地提交）→ pull 快进成功。
    const undo = await f.cmd<{ to: string; movedToUnstaged: number }>('git.commit.undo', { projectId: f.projectId, commitOid: cLocal.commit, expectedHead: cLocal.commit });
    expect(undo.to).toBe(p.head);
    git(f.root, 'checkout', '--', 'a.txt'); // 清掉未暂存差异（回到远端基线，等效干净）
    const pulled = await f.cmd<{ to: string; pulledCount: number }>('git.pull', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: undo.to });
    expect(pulled.pulledCount).toBe(1);
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(remoteNow);
    expect(git(f.root, 'log', '-1', '--format=%s')).toContain('other commit');
    f.db.close();
  }, 60_000);

  it('冲突：三方内容查看+手动解决（非冲突路径拒绝；解决后未合并清除）', async () => {
    const f = makeFixture('conflict', { 'c.txt': 'base\n' });
    const mainBranch = git(f.root, 'symbolic-ref', '--short', 'HEAD').trim();
    git(f.root, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(f.root, 'c.txt'), 'theirs\n', 'utf8');
    git(f.root, 'add', '--', 'c.txt'); git(f.root, 'commit', '-q', '-m', 'theirs');
    git(f.root, 'checkout', '-q', mainBranch);
    writeFileSync(join(f.root, 'c.txt'), 'ours\n', 'utf8');
    git(f.root, 'add', '--', 'c.txt'); git(f.root, 'commit', '-q', '-m', 'ours');
    expect(gitLax(f.root, 'merge', 'other').status).not.toBe(0);
    // 非冲突路径拒绝。
    await expect(f.cmd('git.conflict.content', { projectId: f.projectId, path: 'not-conflicted.txt' })).rejects.toThrow(/不处于未合并/);
    // 三方内容。
    const tri = await f.cmd<{ base: string | null; ours: string | null; theirs: string | null }>('git.conflict.content', { projectId: f.projectId, path: 'c.txt' });
    expect(tri.base).toBe('base\n');
    expect(tri.ours).toBe('ours\n');
    expect(tri.theirs).toBe('theirs\n');
    // 手动解决（合并两边的自定义内容）→ add → 未合并清除。
    const resolved = await f.cmd<{ resolved: boolean }>('git.conflict.resolve', { projectId: f.projectId, path: 'c.txt', content: '手工合并后的最终内容\n' });
    expect(resolved.resolved).toBe(true);
    expect(git(f.root, 'status', '--porcelain')).not.toContain('UU');
    expect(git(f.root, 'status', '--porcelain')).toContain('M  c.txt'); // 已暂存解决结果
    expect(readFileSync(join(f.root, 'c.txt'), 'utf8')).toBe('手工合并后的最终内容\n');
    // 崩溃重试：路径已解决 → 既成事实恢复。
    const cid = 'c-rt24-resolve-retry';
    await f.cmd('git.conflict.resolve', { projectId: f.projectId, path: 'c.txt', content: '手工合并后的最终内容\n' }, cid);
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    const retry = await f.cmd<{ resolved: boolean; recovered?: boolean; replayed?: boolean }>('git.conflict.resolve', { projectId: f.projectId, path: 'c.txt', content: '手工合并后的最终内容\n' }, cid);
    expect(retry.recovered ?? retry.replayed).toBeTruthy();
    f.db.close();
  }, 30_000);

  it('commit.undo 软回退：内容回工作区、文件不删；后续提交阻塞；根提交拒绝', async () => {
    const f = makeFixture('undo', { 'a.txt': 'v1\n' });
    writeFileSync(join(f.root, 'b.txt'), 'new\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['b.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '将被撤销', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    const undo = await f.cmd<{ undone: string; to: string; movedToUnstaged: number }>('git.commit.undo', { projectId: f.projectId, commitOid: c1.commit, expectedHead: c1.commit });
    expect(undo.undone).toBe(c1.commit);
    expect(undo.to).toBe(p.head);
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(p.head);
    // 内容回工作区：b.txt 存在且未暂存；文件不删。
    expect(readFileSync(join(f.root, 'b.txt'), 'utf8')).toBe('new\n');
    expect(git(f.root, 'status', '--porcelain')).toContain('?? b.txt');
    // 后续提交阻塞：现在 HEAD 已不是 c1 → 再撤销 c1 拒绝。
    await expect(f.cmd('git.commit.undo', { projectId: f.projectId, commitOid: c1.commit, expectedHead: c1.commit })).rejects.toThrow(/不是当前 HEAD/);
    // 根提交拒绝（init 是根）。
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['b.txt'] });
    const p2 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c2 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: 'again', expectedHead: p2.head, expectedIndexTree: p2.indexTree, expectedBranch: p2.branch });
    const undo2 = await f.cmd<{ to: string }>('git.commit.undo', { projectId: f.projectId, commitOid: c2.commit, expectedHead: c2.commit });
    expect(undo2.to).toBe(p.head);
    const rootOid = git(f.root, 'rev-list', '--max-parents=0', 'HEAD').trim();
    await expect(f.cmd('git.commit.undo', { projectId: f.projectId, commitOid: rootOid, expectedHead: rootOid })).rejects.toThrow(/根提交/);
    f.db.close();
  }, 30_000);
});
