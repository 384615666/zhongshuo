/**
 * 第十二轮·真实 GitHub 补证（新授权）：专用私有沙盒仓 384615666/zhongshuo-git-e2e-sandbox。
 * 全部经**众说正式命令**（dispatchDaemonCommand：git.stage/commitPreview/commit/branch.create/
 * remoteHead/push/pull）——不用 gh/git 直接操作代替产品功能；git 仅用于测试环境的**准备与
 * 独立第二克隆模拟并发**（这本身是被验证的一部分：远端被他人推进→众说拒绝旧确认推送）。
 * 零模型调用（fake 档语义：本测试不派发任务）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';

const SANDBOX = 'https://github.com/384615666/zhongshuo-git-e2e-sandbox.git';
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-ghreal-'));

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { timeout: 60_000, encoding: 'utf8' });
}

/** 众说工作克隆（独立于 D:\zhongshuo 与环境准备克隆）。 */
const work = join(tmpRoot, 'work');
let db: ZhongshuoDatabase;
let deps: DaemonCommandDeps;
async function cmd<T>(m: string, p: unknown, commandId?: string): Promise<T> {
  const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `c-${randomUUID().slice(0, 10)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

beforeAll(() => {
  // 环境（准备阶段用 git：这是测试环境搭建，不是代替产品功能——产品操作全部走众说命令）。
  mkdirSync(work, { recursive: true });
  git(work, 'clone', '-q', SANDBOX, '.');
  git(work, 'config', 'user.email', 'zhongshuo@users.noreply.github.com');
  git(work, 'config', 'user.name', 'zhongshuo-e2e');
  git(work, 'config', 'core.autocrlf', 'false');
  db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1', 'sandbox', ?, ?, '{}', 0)`).run(work, work);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  deps = { db, localUserId: 'u_ghreal', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
}, 300_000);

afterAll(() => {
  db?.close();
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

describe('真实 GitHub：众说 Git 命令链（授权沙盒仓）', () => {
  it('远端事实核对：ls-remote（经众说 git.remoteHead）=沙盒基线', async () => {
    const rh = await cmd<{ head: string | null; url: string }>('git.remoteHead', { projectId: 'p1', remote: 'origin', branch: 'main' });
    expect(rh.head).toMatch(/^[0-9a-f]{40}$/);
    expect(rh.url).not.toMatch(/user:pass@|token=/); // 脱敏（https URL 本体无凭据）
    expect(git(work, 'rev-parse', 'HEAD').trim()).toBe(rh.head); // 克隆=基线
  }, 120_000);

  it('众说命令闭环：stage → commitPreview → commit（tree 绑定 CAS）→ remoteHead → push（两端头绑定）', async () => {
    writeFileSync(join(work, 'test', 'e2e-round12.txt'), `真实 GitHub 验证 ${new Date().toISOString()}\n`, 'utf8');
    await cmd('git.stage', { projectId: 'p1', paths: ['test/e2e-round12.txt'] });
    const p = await cmd<{ head: string | null; indexTree: string | null; branch: string | null; canCommit?: boolean }>('git.commitPreview', { projectId: 'p1' });
    expect(p.canCommit ?? true).toBe(true);
    const c = await cmd<{ commit: string; updatedRef: string }>('git.commit', { projectId: 'p1', message: 'test: 众说命令链真实推送（第十二轮）', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    expect(c.updatedRef).toBe('refs/heads/main');
    const rh = await cmd<{ head: string | null }>('git.remoteHead', { projectId: 'p1', remote: 'origin', branch: 'main' });
    const url = git(work, 'remote', 'get-url', 'origin').trim();
    const push = await cmd<{ from: string | null; to: string }>('git.push', { projectId: 'p1', remote: 'origin', branch: 'main', expectedHead: c.commit, expectedRemoteHead: rh.head, expectedRemoteUrl: url });
    expect(push.to).toBe(c.commit);
    // 远端事实：真实 GitHub refs/heads/main = 本次提交。
    const remoteNow = git(work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
    expect(remoteNow).toBe(c.commit);
  }, 300_000);

  it('并发反例：第二克隆推进远端 → 众说旧确认推送拒绝（不覆盖他人结果）；刷新后按新事实推', async () => {
    // 独立第二克隆模拟他人。
    const other = join(tmpRoot, 'other');
    mkdirSync(other, { recursive: true });
    git(other, 'clone', '-q', SANDBOX, '.');
    git(other, 'config', 'user.email', 'other@users.noreply.github.com');
    git(other, 'config', 'user.name', 'other-clone');
    git(other, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(other, 'test', 'other-clone.txt'), '他人提交\n', 'utf8');
    git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'test: other clone advances');
    git(other, 'push', '-q', 'origin', 'main');
    // 众说侧：本地新提交 → 以**过期的远端头确认值**推送 → 必须拒绝。
    writeFileSync(join(work, 'test', 'work-after-other.txt'), '众说侧提交\n', 'utf8');
    await cmd('git.stage', { projectId: 'p1', paths: ['test/work-after-other.txt'] });
    const p = await cmd<{ head: string | null; indexTree: string | null; branch: string | null; canCommit?: boolean }>('git.commitPreview', { projectId: 'p1' });
    const c = await cmd<{ commit: string }>('git.commit', { projectId: 'p1', message: 'test: 众说侧提交（远端已被他人推进）', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    const url = git(work, 'remote', 'get-url', 'origin').trim();
    const staleRemoteHead = p.head; // 故意用过期值（=推送前本地 HEAD，远端实际已在他人提交上）
    await expect(cmd('git.push', { projectId: 'p1', remote: 'origin', branch: 'main', expectedHead: c.commit, expectedRemoteHead: staleRemoteHead, expectedRemoteUrl: url }))
      .rejects.toThrow(/远端分支已被更新|远端旧头与确认值不符/);
    // 远端未被覆盖（仍=他人提交）。
    const remoteNow = git(work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
    expect(git(other, 'rev-parse', 'HEAD').trim()).toBe(remoteNow);
    // 按新事实收口：先 pull（ff-only——他人提交是本地祖先外的分叉？不，本地也前进了 → 分叉，
    // ff-only 拒绝→如实；本用例改用 fetch+reset 收敛（环境准备），再走众说 pull 验证快进）。
    const pullTry = await cmd<{ to: string }>('git.pull', { projectId: 'p1', remote: 'origin', branch: 'main', expectedHead: c.commit }).catch((e: Error) => e.message);
    expect(String(pullTry)).toMatch(/不是快进|分叉/); // 分叉如实拒绝（不自动合并提交）
  }, 300_000);

  it('pull 快进：远端前进、本地未动 → 众说 pull 拉到他人提交（真实认证路径）', async () => {
    // 重置本地到远端共同祖先前的状态：直接用第二克隆再推一个提交，本地保持不动。
    const other = join(tmpRoot, 'other');
    const remoteBefore = git(work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!.trim();
    writeFileSync(join(other, 'test', 'one-more.txt'), '再推一个（供快进拉取）\n', 'utf8');
    git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'test: one more for ff pull');
    git(other, 'push', '-q', 'origin', 'main');
    // 本地回到 remoteBefore（fetch+reset——环境准备；产品操作在后面）。
    git(work, 'fetch', '-q', 'origin');
    git(work, 'reset', '-q', '--hard', remoteBefore);
    const localHead = git(work, 'rev-parse', 'HEAD').trim();
    expect(localHead).toBe(remoteBefore);
    const r = await cmd<{ to: string; pulledCount: number }>('git.pull', { projectId: 'p1', remote: 'origin', branch: 'main', expectedHead: localHead });
    expect(r.pulledCount).toBeGreaterThanOrEqual(1);
    expect(git(work, 'log', '-1', '--format=%s')).toContain('one more for ff pull');
  }, 300_000);

  it('分支链真实推送：branch.create（test/*）→ 提交 → push → 远端核对 → 保留供复核', async () => {
    const head0 = git(work, 'rev-parse', 'HEAD').trim();
    const branchName = `test/round12-${Date.now().toString(36)}`;
    const created = await cmd<{ name: string; oid: string }>('git.branch.create', { projectId: 'p1', name: branchName, expectedHead: head0 });
    expect(created.oid).toBe(head0);
    git(work, 'checkout', '-q', branchName);
    git(work, 'config', 'user.email', 'zhongshuo@users.noreply.github.com'); git(work, 'config', 'user.name', 'zhongshuo-e2e');
    writeFileSync(join(work, 'test', 'branch-round12.txt'), 'test/* 分支真实推送\n', 'utf8');
    await cmd('git.stage', { projectId: 'p1', paths: ['test/branch-round12.txt'] });
    const p = await cmd<{ head: string | null; indexTree: string | null; branch: string | null; canCommit?: boolean }>('git.commitPreview', { projectId: 'p1' });
    const c = await cmd<{ commit: string }>('git.commit', { projectId: 'p1', message: 'test: round12 test/* 分支链路', expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch });
    const rh = await cmd<{ head: string | null }>('git.remoteHead', { projectId: 'p1', remote: 'origin', branch: branchName });
    const url = git(work, 'remote', 'get-url', 'origin').trim();
    await cmd('git.push', { projectId: 'p1', remote: 'origin', branch: branchName, expectedHead: c.commit, expectedRemoteHead: rh.head, expectedRemoteUrl: url });
    const remoteBranch = git(work, 'ls-remote', 'origin', `refs/heads/${branchName}`).split('\t')[0]!.trim();
    expect(remoteBranch).toBe(c.commit);
    // 留证：读回远端文件内容（独立克隆读，不动工作克隆）。
    const verify = join(tmpRoot, 'verify');
    mkdirSync(verify, { recursive: true });
    git(verify, 'clone', '-q', '--branch', branchName, SANDBOX, '.');
    expect(readFileSync(join(verify, 'test', 'branch-round12.txt'), 'utf8')).toContain('test/* 分支真实推送');
  }, 300_000);
});
