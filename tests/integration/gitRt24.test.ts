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
    // merge 提交：多父 → 父清单+注记（不虚构 diff）；选择比较父 → 差异绑定该父 OID。
    git(f.root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(f.root, 's.txt'), 's\n', 'utf8');
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-q', '-m', 'side');
    git(f.root, 'checkout', '-q', 'main');
    const mg = gitLax(f.root, 'merge', '--no-ff', '-m', 'merge side', 'side');
    expect(mg.status).toBe(0);
    const mergeOid = git(f.root, 'rev-parse', 'HEAD').trim();
    type MergeDiff = { commit: { parents: string[] }; parentsMeta?: Array<{ oid: string; short: string; subject: string }>; comparedParent?: string; mergeNote?: string; patches: Array<{ path: string; text: string }> };
    const d3 = await f.cmd<MergeDiff>('git.commitDiff', { projectId: f.projectId, oid: mergeOid });
    expect(d3.commit.parents).toHaveLength(2);
    expect(d3.mergeNote).toContain('合并提交');
    expect(d3.mergeNote).toContain('选择比较父');
    expect(d3.patches).toEqual([]);
    expect(d3.parentsMeta).toHaveLength(2);
    expect(d3.parentsMeta!.map((x) => x.subject)).toContain('side');
    // 对比父=第一父（main 侧）：side 的变更体现为相对该父的新增（逐父实际差异，非总览）。
    const [pMain, pSide] = d3.commit.parents;
    const d4 = await f.cmd<MergeDiff>('git.commitDiff', { projectId: f.projectId, oid: mergeOid, parentOid: pMain });
    expect(d4.comparedParent).toBe(pMain);
    expect(d4.patches.map((x) => x.path)).toEqual(['s.txt']);
    expect(d4.patches[0]!.text).toContain('+s');
    // 对比父=第二父（side 侧）：main 侧未前进 → 相对该父无差异（同提交换父=换结果，绑定生效）。
    const d5 = await f.cmd<MergeDiff>('git.commitDiff', { projectId: f.projectId, oid: mergeOid, parentOid: pSide });
    expect(d5.comparedParent).toBe(pSide);
    expect(d5.patches).toEqual([]);
    // 非父 oid（跨对象比较）/单父提交传非其父 → 拒绝。
    await expect(f.cmd('git.commitDiff', { projectId: f.projectId, oid: mergeOid, parentOid: c1.commit })).rejects.toThrow(/不是该提交的父/);
    await expect(f.cmd('git.commitDiff', { projectId: f.projectId, oid: extOid, parentOid: pMain })).rejects.toThrow(/不是该提交的父/);
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
    const url0 = git(f.root, 'remote', 'get-url', 'origin').trim();
    const push1 = await f.cmd<{ from: string | null; to: string }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: head0, expectedRemoteHead: null, expectedRemoteUrl: url0 });
    expect(push1).toMatchObject({ from: null, to: head0 });
    // 本地新提交 → 推送（远端头=head0）。
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '推送用提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    // 远端头报错（expectedRemoteHead 给 null 而实际是 head0）→ 拒绝。
    await expect(f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: null, expectedRemoteUrl: url0 })).rejects.toThrow(/远端分支已被更新/);
    const push2 = await f.cmd<{ from: string | null; to: string }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: head0, expectedRemoteUrl: url0 });
    expect(push2).toMatchObject({ from: head0, to: c1.commit });
    // 崩溃窗口：回执清理后同号重推 → 远端已=目标 → 既成事实恢复（不重复推送、不报错）。
    const pushCid = 'c-rt24-push-retry1';
    await f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: head0, expectedRemoteUrl: url0 }, pushCid);
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(pushCid);
    const pushRetry = await f.cmd<{ to: string; recovered?: boolean; replayed?: boolean }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1.commit, expectedRemoteHead: head0, expectedRemoteUrl: url0 }, pushCid);
    expect(pushRetry.recovered ?? pushRetry.replayed).toBeTruthy();
    expect(pushRetry.to).toBe(c1.commit);
    f.db.close();
  }, 30_000);

  it('push 执行对象绑定（第十二轮二）：校验后本地分支前进→未确认提交不被推；远端地址变化拒；推 OID 而非分支名', async () => {
    const f = makeFixture('remote3', { 'a.txt': 'v1\n' });
    makeBareRemote(f.root);
    const url0 = git(f.root, 'remote', 'get-url', 'origin').trim();
    const head0 = git(f.root, 'rev-parse', 'HEAD').trim();
    await f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: head0, expectedRemoteHead: null, expectedRemoteUrl: url0 });
    // 造两个本地提交：确认的 c1 与未确认的 c2（校验后本地分支又前进）。
    async function localCommit(msg: string): Promise<string> {
      writeFileSync(join(f.root, `${msg}.txt`, ), `${msg}\n`, 'utf8');
      const name = `${msg}.txt`;
      await f.cmd('git.stage', { projectId: f.projectId, paths: [name] });
      const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
      return (await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: msg, expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch })).commit;
    }
    const c1 = await localCommit('确认的提交');
    const c2 = await localCommit('未确认的新提交'); // 本地分支已前进到 c2
    // 推送绑定 c1：refspec 源=c1 OID——c2 不可能被发往远端。
    const push = await f.cmd<{ from: string | null; to: string }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1, expectedRemoteHead: head0, expectedRemoteUrl: url0 });
    expect(push.to).toBe(c1);
    const bare = git(f.root, 'remote', 'get-url', 'origin').trim();
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(c1); // 远端=c1，未含 c2
    expect(git(bare, 'log', '--format=%s', 'refs/heads/main')).not.toContain('未确认的新提交');
    // 远端地址变化（remote 指向别处）→ 拒绝执行（目的地与确认不符）。
    const bare2 = mkdtempSync(join(tmpRoot, 'bare2-'));
    git(bare2, 'init', '-q', '--bare', '-b', 'main');
    git(f.root, 'remote', 'set-url', 'origin', bare2.replaceAll('\\', '/'));
    const c3probe = await f.cmd<{ head: string | null }>('git.remoteHead', { projectId: f.projectId, remote: 'origin', branch: 'main' }).catch(() => null);
    void c3probe;
    await expect(f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c2, expectedRemoteHead: c1, expectedRemoteUrl: url0 })).rejects.toThrow(/实际推送地址已变化/);
    git(f.root, 'remote', 'set-url', 'origin', url0);
    f.db.close();
  }, 30_000);

  it('push 目的地绑定（第十三轮三）：fetch=url/push=pushurl 分离；预览后替换 pushurl 拒；多 push URL 拒；insteadOf 改写核对', async () => {
    const f = makeFixture('pushurl', { 'a.txt': 'v1\n' });
    // fetch 地址 A（bare1），push 地址 B（bare2）——git 语义：pushurl 优先。
    const bareA = mkdtempSync(join(tmpRoot, 'bareA-'));
    const bareB = mkdtempSync(join(tmpRoot, 'bareB-'));
    git(bareA, 'init', '-q', '--bare', '-b', 'main');
    git(bareB, 'init', '-q', '--bare', '-b', 'main');
    git(f.root, 'remote', 'add', 'origin', bareA.replaceAll('\\', '/'));
    git(f.root, 'remote', 'set-url', '--push', 'origin', bareB.replaceAll('\\', '/'));
    const head0 = git(f.root, 'rev-parse', 'HEAD').trim();
    const urlB = git(f.root, 'remote', 'get-url', '--push', 'origin').trim();
    expect(urlB).toBe(bareB.replaceAll('\\', '/')); // 确认面=push 侧（B）
    // 首推：走 B（pushurl）——A 不接收任何提交。
    await f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: head0, expectedRemoteHead: null, expectedRemoteUrl: urlB });
    expect(git(bareB, 'rev-parse', 'refs/heads/main').trim()).toBe(head0);
    expect(gitLax(bareA, 'rev-parse', 'refs/heads/main').status).not.toBe(0); // A 未收
    // 预览后替换 pushurl → B'（目的地变化拒绝执行；B' 未收提交）。
    const bareC = mkdtempSync(join(tmpRoot, 'bareC-'));
    git(bareC, 'init', '-q', '--bare', '-b', 'main');
    writeFileSync(join(f.root, 'n.txt'), 'n\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['n.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c1 = (await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: 'pushurl 替换用', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch })).commit;
    git(f.root, 'remote', 'set-url', '--push', 'origin', bareC.replaceAll('\\', '/'));
    await expect(f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1, expectedRemoteHead: head0, expectedRemoteUrl: urlB }))
      .rejects.toThrow(/实际推送地址已变化/);
    expect(gitLax(bareC, 'rev-parse', 'refs/heads/main').status).not.toBe(0); // C 未收
    git(f.root, 'remote', 'set-url', '--push', 'origin', bareB.replaceAll('\\', '/'));
    // 多 push URL：明确拒绝（一次确认只能对应一个目的地）。
    git(f.root, 'remote', 'set-url', '--add', '--push', 'origin', bareC.replaceAll('\\', '/'));
    await expect(f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1, expectedRemoteHead: head0, expectedRemoteUrl: urlB }))
      .rejects.toThrow(/推送地址/);
    git(f.root, 'remote', 'set-url', '--delete', '--push', 'origin', bareC.replaceAll('\\', '/'));
    // 改写规则核对（第十三轮三）：pushInsteadOf 使确认面（get-url 字面量）与实际推送目的地
    // （改写后值）不一致——受管推送**明确拒绝**改写目的地（不静默向不确定目的地发送）。
    git(f.root, 'config', `url.${bareB.replaceAll('\\', '/')}.pushInsteadOf`, 'zs-alias://push-target');
    git(f.root, 'remote', 'set-url', '--push', 'origin', 'zs-alias://push-target');
    await expect(f.cmd<{ to: string }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1, expectedRemoteHead: head0, expectedRemoteUrl: 'zs-alias://push-target' }))
      .rejects.toThrow(/insteadOf 改写规则影响/);
    // 清规则后恢复直连目的地推送成功（最终态核对仍为 B）。
    git(f.root, 'config', '--unset', `url.${bareB.replaceAll('\\', '/')}.pushInsteadOf`);
    git(f.root, 'remote', 'set-url', '--push', 'origin', bareB.replaceAll('\\', '/'));
    const push2 = await f.cmd<{ to: string }>('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: c1, expectedRemoteHead: head0, expectedRemoteUrl: bareB.replaceAll('\\', '/') });
    expect(push2.to).toBe(c1);
    expect(git(bareB, 'rev-parse', 'refs/heads/main').trim()).toBe(c1);
    f.db.close();
  }, 60_000);

  it('push 非快进拒绝；pull 快进拉取+分叉拒绝（bare remote 双侧）', async () => {
    const f = makeFixture('remote2', { 'a.txt': 'v1\n' });
    const bare = makeBareRemote(f.root);
    const head0 = git(f.root, 'rev-parse', 'HEAD').trim();
    await f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: head0, expectedRemoteHead: null, expectedRemoteUrl: git(f.root, 'remote', 'get-url', 'origin').trim() });
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
    await expect(f.cmd('git.push', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: cLocal.commit, expectedRemoteHead: remoteNow, expectedRemoteUrl: git(f.root, 'remote', 'get-url', 'origin').trim() })).rejects.toThrow(/远端包含本地没有的提交/);
    // pull 分叉（ff-only）→ 拒绝（不自动合并提交）。
    await expect(f.cmd('git.pull', { projectId: f.projectId, remote: 'origin', branch: 'main', expectedHead: cLocal.commit })).rejects.toThrow(/不是快进|分叉/);
    // 本地回到远端（撤销本地提交）→ pull 快进成功。
    const undo = await f.cmd<{ to: string; updatedRef: string }>('git.commit.undo', { projectId: f.projectId, commitOid: cLocal.commit, expectedHead: cLocal.commit, expectedBranch: 'main' });
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
    const tri = await f.cmd<{ base: string | null; ours: string | null; theirs: string | null; snapshotHash: string }>('git.conflict.content', { projectId: f.projectId, path: 'c.txt' });
    expect(tri.base).toBe('base\n');
    expect(tri.ours).toBe('ours\n');
    expect(tri.theirs).toBe('theirs\n');
    // 手动解决（合并两边的自定义内容）→ add → 未合并清除。
    const cid = 'c-rt24-resolve-retry';
    const resolveParams = { projectId: f.projectId, path: 'c.txt', content: '手工合并后的最终内容\n', expectedSnapshotHash: tri.snapshotHash };
    const resolved = await f.cmd<{ resolved: boolean }>('git.conflict.resolve', resolveParams, cid);
    expect(resolved.resolved).toBe(true);
    expect(git(f.root, 'status', '--porcelain')).not.toContain('UU');
    expect(git(f.root, 'status', '--porcelain')).toContain('M  c.txt'); // 已暂存解决结果
    expect(readFileSync(join(f.root, 'c.txt'), 'utf8')).toBe('手工合并后的最终内容\n');
    // 新身份不能把已外部/此前解决的路径冒充本次成功；原已完成身份仍可恢复历史回执。
    await expect(f.cmd('git.conflict.resolve', resolveParams)).rejects.toThrow(/不处于原冲突/);
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    const retry = await f.cmd<{ resolved: boolean; recovered?: boolean; replayed?: boolean }>('git.conflict.resolve', resolveParams, cid);
    expect(retry.recovered ?? retry.replayed).toBeTruthy();
    f.db.close();
  }, 30_000);

  it('commit.undo 软回退（第十二轮三）：索引 A 与工作区 B 均无损；重叠拒；merge 拒；崩溃重试不重复退', async () => {
    const f = makeFixture('undo2', { 'base.txt': 'v0\n' });
    // 先造一个待撤销提交（只涉及 c.txt）。
    writeFileSync(join(f.root, 'c.txt'), 'commit 内容\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['c.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '将被撤销', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    // A/B 关键 fixture：a.txt 暂存内容 A（只存在于索引），工作区是 B——与提交文件不相交。
    writeFileSync(join(f.root, 'a.txt'), 'A-暂存版本\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    writeFileSync(join(f.root, 'a.txt'), 'B-工作区版本\n', 'utf8');
    const indexA = git(f.root, 'show', ':a.txt');
    expect(indexA).toContain('A-暂存版本');
    // 软撤销：仅目标 ref 回退（CAS）；索引与工作区不动。
    const undo = await f.cmd<{ undone: string; to: string; updatedRef: string; returnedToStaged: number }>('git.commit.undo', { projectId: f.projectId, commitOid: c1.commit, expectedHead: c1.commit, expectedBranch: 'main' });
    expect(undo.undone).toBe(c1.commit);
    expect(undo.to).toBe(p.head);
    expect(undo.updatedRef).toBe('refs/heads/main');
    expect(undo.returnedToStaged).toBe(1);
    expect(git(f.root, 'rev-parse', 'refs/heads/main').trim()).toBe(p.head);
    // A 未丢失（索引原样）+ B 未丢失（工作区文件原样）——不只检查文件还在。
    expect(git(f.root, 'show', ':a.txt')).toBe(indexA);
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('B-工作区版本\n');
    // 提交内容 c.txt 回到暂存（soft 语义）；a.txt 的暂存+未暂存状态原样（MM）。
    const porcelain = git(f.root, 'status', '--porcelain');
    expect(porcelain).toContain('A  c.txt');
    expect(porcelain).toContain('AM a.txt'); // 新文件：staged A + 工作区 B=AM（暂存与未暂存两态原样保留）
    expect(readFileSync(join(f.root, 'c.txt'), 'utf8')).toBe('commit 内容\n');
    // 后续提交阻塞（ref 已非 c1）。
    await expect(f.cmd('git.commit.undo', { projectId: f.projectId, commitOid: c1.commit, expectedHead: c1.commit, expectedBranch: 'main' })).rejects.toThrow(/目标提交不是/);
    // 崩溃重试：删回执 + 行退回 pending（模拟已回退但未落账）→ 同号重试按 ref=父 恢复，不重复退。
    const cid = 'c-undo-retry-0001';
    await f.cmd('git.commit.undo', { projectId: f.projectId, commitOid: c1.commit, expectedHead: c1.commit, expectedBranch: 'main' }, cid).catch(() => { /* 已撤销——首次调用在上一段，此处用同号补一条 pending 后重试 */ });
    f.db.prepare(`DELETE FROM command_receipts WHERE command_id = ?`).run(cid);
    f.db.prepare(`UPDATE git_operations SET status = 'pending' WHERE id = ?`).run(cid);
    const retry = await f.cmd<{ to: string; recovered?: boolean }>('git.commit.undo', { projectId: f.projectId, commitOid: c1.commit, expectedHead: c1.commit, expectedBranch: 'main' }, cid);
    expect(retry.recovered).toBe(true);
    expect(retry.to).toBe(p.head); // 仍是父——未重复退到更早
    f.db.close();
  }, 30_000);

  it('commit.undo：重叠（提交文件∩当前暂存）明确拒绝；merge 提交拒绝', async () => {
    const f = makeFixture('undo3', { 'a.txt': 'v0\n' });
    // 重叠：提交涉及 a.txt，随后又暂存 a.txt 另一版本 → 撤销无法无损 → 拒绝。
    writeFileSync(join(f.root, 'a.txt'), '提交版本\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    const p = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null }>('git.commitPreview', { projectId: f.projectId });
    const c1 = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '重叠提交', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    writeFileSync(join(f.root, 'a.txt'), '撤销前又暂存\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    await expect(f.cmd('git.commit.undo', { projectId: f.projectId, commitOid: c1.commit, expectedHead: c1.commit, expectedBranch: 'main' })).rejects.toThrow(/重叠/);
    // merge 提交撤销 → 拒绝（语义未定义，不默认选第一个父）。
    await f.cmd('git.unstage', { projectId: f.projectId, paths: ['a.txt'] });
    git(f.root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(f.root, 's.txt'), 's\n', 'utf8');
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-q', '-m', 'side');
    git(f.root, 'checkout', '-q', 'main');
    const mg = gitLax(f.root, 'merge', '--no-ff', '-m', 'merge side', 'side');
    expect(mg.status).toBe(0);
    const mergeOid = git(f.root, 'rev-parse', 'HEAD').trim();
    await expect(f.cmd('git.commit.undo', { projectId: f.projectId, commitOid: mergeOid, expectedHead: mergeOid, expectedBranch: 'main' })).rejects.toThrow(/合并提交/);
    f.db.close();
  }, 30_000);

  it('hooks/签名边界（第十二轮四）：检测到 pre-commit/gpgsign → 内置提交阻塞（不静默绕过）；移除后恢复', async () => {
    const f = makeFixture('hooks', { 'a.txt': 'v1\n' });
    writeFileSync(join(f.root, 'a.txt'), 'v2\n', 'utf8');
    await f.cmd('git.stage', { projectId: f.projectId, paths: ['a.txt'] });
    // ① pre-commit 钩子存在（标记脚本——检测只看存在性，不执行）。
    const hooksDir = join(f.root, '.git', 'hooks');
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho hook-ran\n', 'utf8');
    const p1 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null; canCommit: boolean; blockers: string[]; notes: string[] }>('git.commitPreview', { projectId: f.projectId });
    expect(p1.canCommit).toBe(false);
    expect(p1.blockers.some((x) => x.includes('pre-commit 钩子'))).toBe(true);
    const cid = 'c-hooks-0001';
    await expect(f.cmd('git.commit', { projectId: f.projectId, message: 'x', expectedHead: p1.head, expectedIndexTree: p1.indexTree, expectedBranch: p1.branch }, cid)).rejects.toThrow(/pre-commit 钩子/);
    // ② gpgsign=true（不调用真实签名——在检测层阻塞）。
    rmSync(hookPath);
    git(f.root, 'config', 'commit.gpgsign', 'true');
    const p2 = await f.cmd<{ canCommit: boolean; blockers: string[] }>('git.commitPreview', { projectId: f.projectId });
    expect(p2.canCommit).toBe(false);
    expect(p2.blockers.some((x) => x.includes('commit.gpgsign'))).toBe(true);
    // ③ 清除后内置提交恢复（且预览 notes 始终如实描述实际执行路径）。
    git(f.root, 'config', '--unset', 'commit.gpgsign');
    const p3 = await f.cmd<{ head: string | null; indexTree: string | null; branch: string | null; canCommit: boolean; notes: string[] }>('git.commitPreview', { projectId: f.projectId });
    expect(p3.canCommit).toBe(true);
    expect(p3.notes.some((n) => n.includes('不执行 pre-commit/post-commit 钩子'))).toBe(true);
    const ok = await f.cmd<{ commit: string }>('git.commit', { projectId: f.projectId, message: '无钩子提交', expectedHead: p3.head, expectedIndexTree: p3.indexTree, expectedBranch: p3.branch });
    expect(git(f.root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    void ok;
    f.db.close();
  }, 30_000);
});
