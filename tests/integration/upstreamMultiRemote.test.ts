/**
 * R71 P5b：多远端 upstream/ahead/behind 真实事实复核（continuation 多轮登记项收口）。
 *
 * 双远端（origin+backup）仓库、本地 ahead=2/behind=1、upstream=origin/main——核
 * daemon git.branch.list 的 for-each-ref+rev-list 真值链与 git.remote.list 的多远端清单。
 * 均为只读命令；fixture 在临时目录（仓库外）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';

const root = mkdtempSync(join(tmpdir(), 'zs-upstream-'));
mkdirSync(root, { recursive: true });
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const work = join(root, 'work');

afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(root, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

describe('R71 多远端 upstream/ahead/behind（真值复核）', () => {
  it('双远端仓库：upstream=origin/main，ahead=2/behind=1，remotes 含 origin+backup', async () => {
    g(root, 'init', '--bare', '-b', 'main', 'origin.git');
    g(root, 'init', '--bare', '-b', 'main', 'backup.git');
    g(root, 'init', '-b', 'main', 'work');
    g(work, 'config', 'user.email', 't@t');
    g(work, 'config', 'user.name', 't');
    writeFileSync(join(work, 'a.txt'), 'A');
    g(work, 'add', '.');
    g(work, 'commit', '-m', 'c1');
    g(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
    g(work, 'remote', 'add', 'backup', join(root, 'backup.git'));
    g(work, 'push', '-q', 'origin', 'main');
    g(work, 'push', '-q', 'backup', 'main');
    g(work, 'branch', '--set-upstream-to=origin/main', 'main');
    // 本地领先 2 提交。
    writeFileSync(join(work, 'b.txt'), 'B');
    g(work, 'add', '.');
    g(work, 'commit', '-m', 'c2');
    writeFileSync(join(work, 'c.txt'), 'C');
    g(work, 'add', '.');
    g(work, 'commit', '-m', 'c3');
    // origin 侧追加 1 条本地没有的提交（behind=1）。
    g(root, 'clone', '-q', join(root, 'origin.git'), 'originClone');
    const oc = join(root, 'originClone');
    g(oc, 'config', 'user.email', 't@t');
    g(oc, 'config', 'user.name', 't');
    writeFileSync(join(oc, 'd.txt'), 'D');
    g(oc, 'add', '.');
    g(oc, 'commit', '-m', 'remote-c4');
    g(oc, 'push', '-q', 'origin', 'main');
    g(work, 'fetch', '-q', 'origin');

    // git 真值（对照基准）。
    const truth = g(work, 'rev-list', '--left-right', '--count', 'origin/main...main');
    expect(truth).toBe('1\t2'); // behind=1 ahead=2

    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','up',?,?, '{}', 0)").run(work, work);
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const cmd = async (method: string, params: unknown) =>
      await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `up-${method}-${Math.random().toString(36).slice(2, 8)}`, method, params }) as { ok: boolean; data?: never; error?: { message: string } };

    const branches = await cmd('git.branch.list', { projectId: 'p1' }) as unknown as { ok: boolean; data?: { branches: Array<{ name: string; upstream: string | null; ahead: number | null; behind: number | null }> } };
    expect(branches.ok).toBe(true);
    const main = branches.data?.branches.find((b) => b.name === 'main');
    expect(main?.upstream).toBe('origin/main');
    expect(main?.ahead).toBe(2);
    expect(main?.behind).toBe(1);

    const remotes = await cmd('git.remote.list', { projectId: 'p1' }) as unknown as { ok: boolean; data?: { remotes: Array<{ name: string; url: string }> } };
    expect(remotes.ok).toBe(true);
    const names = (remotes.data?.remotes ?? []).map((r) => r.name).sort();
    expect(names).toEqual(['backup', 'origin']);
    db.close();
  }, 60_000);

  it('非 Git 目录：git.status 返回 NOT_A_GIT_REPO 结构码（UI 中性态分流的合同锚点）', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'zs-plain-'));
    writeFileSync(join(plain, 'readme.md'), '# plain\n');
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p2','plain',?,?, '{}', 0)").run(plain, plain);
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: 'plain-git-status-r71', method: 'git.status', params: { projectId: 'p2' } }) as { ok: boolean; error?: { code: string; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_A_GIT_REPO');
    expect(String(r.error?.message)).toContain('NOT_A_GIT_REPO');
    db.close();
    for (let i = 0; i < 5; i += 1) { try { rmSync(plain, { recursive: true, force: true }); break; } catch { /* */ } }
  }, 30_000);

  it('project.open 响应含 rootPath/canonicalPath（R64 登记项）', async () => {
    const db = openDatabase(':memory:');
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: 'open-dto-r71', method: 'project.open', params: { path: root } }) as { ok: boolean; data?: { project: { rootPath?: string; canonicalPath?: string; displayName: string } } };
    expect(r.ok).toBe(true);
    expect(typeof r.data?.project.rootPath).toBe('string');
    expect(r.data?.project.canonicalPath).toBeTruthy();
    db.close();
  }, 30_000);
});
