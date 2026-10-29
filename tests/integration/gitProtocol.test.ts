/**
 * 第十轮·一：Git 只读数据协议与边界（零模型调用）。
 *
 * 覆盖：特殊文件名（中文/空格/引号/制表符/前导横线/glob 类括号）的身份解析；
 * raw/numstat -z 机器格式（重命名先旧后新、二进制 '-'）；字面 pathspec（glob 不扩大范围）；
 * 单文件/整体/文件数上限（截断如实标注）；numstat 失败→unknown（不当文本成功）；
 * 未跟踪文件内容视图（新增语义/二进制/超限/目录拒绝）；子目录项目根的越界标注；
 * 只读展示不执行仓库配置的外部 diff/textconv（标记程序反例）。
 * 全部走正式命令（git.status/git.diff）；fixture 均为临时目录，不触用户真实工作区。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';
import { parseRawZ, parseNumstatZ, gitDiff, captureGit } from '../../src/daemon/gitStatus.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-gitproto-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

let seq = 0;
function makeDb(repoPath: string): ZhongshuoDatabase {
  seq += 1;
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1', 'd', ?, ?, '{}', 0)`).run(repoPath, repoPath);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
  return db;
}

function depsOf(db: ZhongshuoDatabase): { cmd: <T>(m: string, p: unknown) => Promise<T> } {
  const deps: DaemonCommandDeps = { db, localUserId: 'u_gitproto', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  return {
    cmd: async <T,>(m: string, p: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { timeout: 15_000, encoding: 'utf8' });
}

function makeRepo(name: string, files: Record<string, string>): { root: string; db: ZhongshuoDatabase; cmd: <T>(m: string, p: unknown) => Promise<T> } {
  const root = join(tmpRoot, `${name}-${seq}`);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
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
  const db = makeDb(root);
  return { root, db, cmd: depsOf(db).cmd };
}

describe('第十轮·一：Git 只读数据协议与边界', () => {
  it('status：特殊文件名/重命名归属/工作树根定位——身份来自 porcelain -z，不猜测', async () => {
    // 注：文件名含制表符/引号/星号在 NTFS 上不可创建（实测 ENOENT；Windows 禁 < > : " / \ | ? *），
    // 协议侧 -z 为 NUL 分隔、此类路径本可正确往返——此处覆盖 Windows 允许的其余特殊字符。
    const special = '中 文 名.txt';
    const symName = "sym!#$&'()%.txt";
    const dashName = '-dash.txt';
    const { root, db, cmd } = makeRepo('special', {
      [special]: 'old\n',
      [symName]: 'q\n',
      [dashName]: 'd\n',
      'keep.txt': 'k\n',
      'deep dir/sub file.txt': 's\n',
    });
    // 重命名（暂存）：porcelain "R  新\0旧"。
    git(root, 'mv', special, '新 名字.txt');
    // 暂存修改 + 未暂存修改 + 未跟踪特殊名。
    writeFileSync(join(root, dashName), 'd2\n', 'utf8');
    git(root, 'add', '--', dashName); // 前导横线必须 -- 分隔（否则被当作选项）
    writeFileSync(join(root, dashName), 'd3\n', 'utf8');
    writeFileSync(join(root, symName), 'changed\n', 'utf8');
    writeFileSync(join(root, '新 未跟踪 文件.txt'), 'new\n', 'utf8');

    const s = await cmd<{
      branch: string; worktreeRoot: string; projectRootIsWorktreeRoot: boolean;
      staged: Array<{ path: string; renamedFrom?: string; xy: string }>;
      unstaged: Array<{ path: string }>;
      untracked: Array<{ path: string }>;
      truncated: boolean;
    }>('git.status', { projectId: 'p1' });
    expect(s.projectRootIsWorktreeRoot).toBe(true);
    expect(s.worktreeRoot.length).toBeGreaterThan(0);
    const renameEntry = s.staged.find((e) => e.path === '新 名字.txt');
    expect(renameEntry).toBeDefined();
    expect(renameEntry!.renamedFrom).toBe(special);
    expect(s.staged.map((e) => e.path)).toContain(dashName);
    expect(s.unstaged.map((e) => e.path)).toEqual(expect.arrayContaining([dashName, symName]));
    expect(s.untracked.map((e) => e.path)).toContain('新 未跟踪 文件.txt');
    // 只读：查询后索引/工作区不变（非 -z porcelain 对非 ASCII 走八进制转义，只断言结构）。
    const porcelain = git(root, 'status', '--porcelain');
    expect(porcelain).toContain('R  ');
    expect(porcelain).toContain('MM -dash.txt');
    db.close();
  }, 30_000);

  it('status：完整返回超过200条目', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3; i += 1) files[`base${i}.txt`] = 'x\n';
    const { root, db, cmd } = makeRepo('many', files);
    for (let i = 0; i < 205; i += 1) writeFileSync(join(root, `u${i}.txt`), 'n\n', 'utf8');
    const s = await cmd<{ staged: unknown[]; unstaged: unknown[]; untracked: unknown[]; truncated: boolean }>('git.status', { projectId: 'p1' });
    expect(s.untracked.length).toBe(205);
    expect(s.truncated).toBe(false);
    db.close();
  }, 60_000);

  it('status：项目根是仓库子目录——工作树范围如实展示，项目外条目显式标注', async () => {
    const { root, db, cmd } = makeRepo('subdir', { 'pkg/in-scope.txt': 'a\n', 'outside.txt': 'b\n' });
    // 项目根切到 pkg：把 projects.canonical_path 指向子目录。
    const pkgDir = join(root, 'pkg');
    db.prepare('UPDATE projects SET root_path = ?, canonical_path = ? WHERE id = ?').run(pkgDir, pkgDir, 'p1');
    writeFileSync(join(root, 'outside.txt'), 'changed outside\n', 'utf8');
    writeFileSync(join(pkgDir, 'in-scope.txt'), 'changed inside\n', 'utf8');
    const s = await cmd<{
      projectRootIsWorktreeRoot: boolean; worktreeRoot: string;
      unstaged: Array<{ path: string; outsideProjectRoot?: boolean }>;
    }>('git.status', { projectId: 'p1' });
    expect(s.projectRootIsWorktreeRoot).toBe(false);
    const inside = s.unstaged.find((e) => e.path === 'pkg/in-scope.txt');
    const outside = s.unstaged.find((e) => e.path === 'outside.txt');
    expect(inside).toBeDefined();
    expect(inside!.outsideProjectRoot).toBeUndefined();
    expect(outside).toBeDefined();
    expect(outside!.outsideProjectRoot).toBe(true);
    // diff 从项目根也能查（命令以工作树根为执行根）。
    const d = await cmd<{ patches: Array<{ path: string }> }>('git.diff', { projectId: 'p1', path: 'pkg/in-scope.txt' });
    expect(d.patches.map((x) => x.path)).toEqual(['pkg/in-scope.txt']);
    db.close();
  }, 30_000);

  it('diff：raw -z 身份（重命名先旧后新/删除/复制计数）；numstat -z 单元解析含重命名与二进制', async () => {
    // 单元：机器格式解析（实测顺序：raw=R100\0旧\0新；numstat=0\t0\t\0旧\0新）。
    const rawEntries = parseRawZ(':100644 100644 abc def R100\0old name.txt\0新.txt\0:100644 100644 aaa bbb M\0m.txt\0');
    expect(rawEntries).toEqual([
      { status: 'R100', path: '新.txt', origPath: 'old name.txt' },
      { status: 'M', path: 'm.txt' },
    ]);
    const numEntries = parseNumstatZ('1\t2\tbase.txt\0-\t-\tbin.dat\0' + '0\t0\t\0旧 名.txt\0new 名.txt\0');
    expect(numEntries).toEqual([
      { path: 'base.txt', origPath: undefined, added: 1, deleted: 2, binary: false },
      { path: 'bin.dat', origPath: undefined, added: null, deleted: null, binary: true },
      { path: 'new 名.txt', origPath: '旧 名.txt', added: 0, deleted: 0, binary: false },
    ]);
    // 残缺记录解析失败（不静默跳过）。
    expect(() => parseRawZ('garbage\0')).toThrow();
    expect(() => parseNumstatZ('no-tabs-here\0')).toThrow();
    expect(() => parseRawZ(':100644 100644 a b R100\0only-new\0')).toThrow(); // 重命名缺第二条路径

    // 集成：暂存重命名/删除的正文归属。
    const { root, db, cmd } = makeRepo('diffid', { 'rename me.txt': 'content\n', 'delete me.txt': 'gone\n', 'stay.txt': 's\n' });
    git(root, 'mv', 'rename me.txt', 'renamed 目标.txt');
    rmFileSync(join(root, 'delete me.txt'));
    git(root, 'add', '-A');
    const d = await cmd<{ patches: Array<{ path: string; oldPath?: string; change: string; stat: string; binary: boolean }> }>('git.diff', { projectId: 'p1', staged: true });
    const rename = d.patches.find((p) => p.change === 'renamed');
    expect(rename).toBeDefined();
    expect(rename!.path).toBe('renamed 目标.txt');
    expect(rename!.oldPath).toBe('rename me.txt');
    expect(rename!.stat).toBe('text');
    const deleted = d.patches.find((p) => p.change === 'deleted');
    expect(deleted!.path).toBe('delete me.txt');
    db.close();
  }, 30_000);

  it('diff：字面路径语义——文件名中的 glob 字符不扩大查询范围', async () => {
    const { root, db, cmd } = makeRepo('literal', { 'b[a]r.txt': 'bracket\n', 'bar.txt': 'plain\n' });
    writeFileSync(join(root, 'b[a]r.txt'), 'bracket changed\n', 'utf8');
    writeFileSync(join(root, 'bar.txt'), 'plain changed\n', 'utf8');
    // 字面：只命中文括号文件本身；glob 语义会把 bar.txt 一起带进来。
    const d = await cmd<{ patches: Array<{ path: string; text: string }> }>('git.diff', { projectId: 'p1', path: 'b[a]r.txt' });
    expect(d.patches.map((p) => p.path)).toEqual(['b[a]r.txt']);
    expect(d.patches[0]!.text).toContain('+bracket changed');
    expect(d.patches.some((p) => p.text.includes('plain changed'))).toBe(false);
    // 控制组：不加字面语义时 git glob 确实会两文件都匹配（证明测试有效）。
    const globControl = execFileSync('git', ['-C', root, 'diff', '--numstat', '--', 'b[a]r.txt'], { encoding: 'utf8' });
    expect(globControl.trim().split('\n').length).toBe(2);
    // 越界拒绝（含空段/控制字符）。
    for (const bad of ['../x', 'a/../b', 'D:/abs', '/abs', 'a//b', 'a\x01b']) {
      await expect(cmd('git.diff', { projectId: 'p1', path: bad })).rejects.toThrow();
    }
    db.close();
  }, 30_000);

  it('diff：二进制=字段协议（numstat -）；超过原单文件/整体/文件数上限仍完整读取', async () => {
    const { root, db, cmd } = makeRepo('caps', { 'bin.dat': 'ok\n', 'big.txt': 'x\n', 'stay.txt': 's\n' });
    // 二进制（NUL 字节）暂存。
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x0a]));
    git(root, 'add', 'bin.dat');
    const bin = await cmd<{ patches: Array<{ path: string; stat: string; binary: boolean; text: string; source: string }> }>('git.diff', { projectId: 'p1', staged: true });
    const binPatch = bin.patches.find((p) => p.path === 'bin.dat')!;
    expect(binPatch.stat).toBe('binary');
    expect(binPatch.binary).toBe(true);
    expect(binPatch.text).toBe('');

    // 单文件超限（64KB）：正文截断含标记。
    writeFileSync(join(root, 'big.txt'), `${'x'.repeat(60)}\n`.repeat(2000), 'utf8'); // ~120KB diff
    const big = await cmd<{ patches: Array<{ path: string; truncated: boolean; text: string }>; truncatedOverall: boolean }>('git.diff', { projectId: 'p1', path: 'big.txt' });
    const bigPatch = big.patches.find((p) => p.path === 'big.txt')!;
    expect(bigPatch.truncated).toBe(false);
    expect(bigPatch.text).toContain('+' + 'x'.repeat(60));
    expect(bigPatch.text.length).toBeGreaterThan(120 * 1024);
    expect(big.truncatedOverall).toBe(false);

    // 文件数上限（50）：身份仍列出，正文省略并计数（55 个新文件暂存）。
    const many = makeRepo('capsmany', { seed: 's\n' });
    for (let i = 0; i < 55; i += 1) writeFileSync(join(many.root, `n${String(i).padStart(2, '0')}.txt`), `new ${i}\n`, 'utf8');
    git(many.root, 'add', '-A');
    const manyD = await many.cmd<{ patches: Array<{ path: string; truncated: boolean }>; filesOmitted?: number; truncatedOverall: boolean }>('git.diff', { projectId: 'p1', staged: true });
    expect(manyD.patches.length).toBe(55);
    expect(manyD.filesOmitted).toBeUndefined();
    expect(manyD.truncatedOverall).toBe(false);
    expect(manyD.patches.filter((p) => p.truncated).length).toBe(0);
    many.db.close();

    // 整体预算（512KB）：9 个已跟踪文件各 ~77KB diff → 前 8 个单文件截断，第 9 个按预算省略正文。
    const budgetFiles: Record<string, string> = {};
    for (let i = 0; i < 9; i += 1) budgetFiles[`g${i}.txt`] = 'x\n';
    const budgetRepo = makeRepo('capsbudget', budgetFiles);
    for (let i = 0; i < 9; i += 1) writeFileSync(join(budgetRepo.root, `g${i}.txt`), `${'y'.repeat(70)}\n`.repeat(1100), 'utf8'); // 每个 ~77KB diff
    const budgetD = await budgetRepo.cmd<{ patches: Array<{ path: string; truncated: boolean; text: string }>; truncatedOverall: boolean }>('git.diff', { projectId: 'p1' });
    expect(budgetD.patches.length).toBe(9);
    expect(budgetD.patches[0]!.truncated).toBe(false);
    expect(budgetD.patches[0]!.text.length).toBeGreaterThan(77 * 1024);
    expect(budgetD.patches[8]!.truncated).toBe(false);
    expect(budgetD.patches[8]!.text.length).toBeGreaterThan(77 * 1024); // 预算耗尽：正文省略（区别于单文件截断）
    expect(budgetD.truncatedOverall).toBe(false);
    budgetRepo.db.close();
    db.close();
  }, 120_000);

  it('diff：numstat 失败 → stat=unknown（不冒充文本成功），正文仍真实', async () => {
    const { root } = makeRepo('numfail', { 'a.txt': 'a\n' });
    writeFileSync(join(root, 'a.txt'), 'a2\n', 'utf8');
    // 注入 runner：numstat 命令失败，其余正常（测试接缝，正式命令不带 runner）。
    const failing = async (args: readonly string[], opts: { cwd?: string; capBytes?: number; env?: NodeJS.ProcessEnv }) => {
      if (args.includes('--numstat')) {
        return { exitCode: 128, stdout: Buffer.alloc(0), stderr: 'fatal: injected', truncated: false };
      }
      return captureGit(args, opts);
    };
    const r = await gitDiff(root, { runner: failing });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patches.length).toBe(1);
    expect(r.patches[0]!.stat).toBe('unknown');
    expect(r.patches[0]!.binary).toBe(false);
    expect(r.patches[0]!.text).toContain('+a2');
    expect(r.numstatError).toContain('numstat 不可用');
  }, 30_000);

  it('diff：未跟踪文件内容视图（新增语义）——文本/二进制/超限/目录拒绝', async () => {
    const { root, db, cmd } = makeRepo('untracked', { base: 'b\n' });
    writeFileSync(join(root, '未跟踪 说明.txt'), '第一行\nsecond line\n', 'utf8');
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    writeFileSync(join(root, 'large.txt'), `${'z'.repeat(64)}\n`.repeat(2000), 'utf8'); // 130KB
    mkdirSync(join(root, 'dir 新'), { recursive: true });
    writeFileSync(join(root, 'dir 新/inner.txt'), 'i\n', 'utf8');

    const text = await cmd<{ patches: Array<{ path: string; change: string; stat: string; source: string; text: string; truncated: boolean; addedCount: number | null }> }>('git.diff', { projectId: 'p1', path: '未跟踪 说明.txt' });
    expect(text.patches.length).toBe(1);
    expect(text.patches[0]!.source).toBe('worktree-content');
    expect(text.patches[0]!.change).toBe('added');
    expect(text.patches[0]!.stat).toBe('text');
    expect(text.patches[0]!.text).toContain('second line');
    expect(text.patches[0]!.addedCount).toBeNull();

    const bin = await cmd<{ patches: Array<{ stat: string; text: string }> }>('git.diff', { projectId: 'p1', path: 'blob.bin' });
    expect(bin.patches[0]!.stat).toBe('binary');
    expect(bin.patches[0]!.text).toBe('');

    const large = await cmd<{ patches: Array<{ truncated: boolean; text: string }> }>('git.diff', { projectId: 'p1', path: 'large.txt' });
    expect(large.patches[0]!.truncated).toBe(false);
    expect(large.patches[0]!.text).toBe(readFileSync(join(root, 'large.txt'), 'utf8'));

    await expect(cmd('git.diff', { projectId: 'p1', path: 'dir 新' })).rejects.toThrow('目录');
    db.close();
  }, 30_000);

  it('只读反例：查看差异不执行仓库配置的外部 diff/textconv（标记程序证明）', async () => {
    const { root, db, cmd } = makeRepo('nodriver', { 'a.zzz': 'a\n', 'b.zzq': 'b\n' });
    const markerDir = join(tmpRoot, 'markers');
    mkdirSync(markerDir, { recursive: true });
    const textconvMarker = join(markerDir, 'textconv-ran.txt');
    const extdiffMarker = join(markerDir, 'extdiff-ran.txt');
    const convScript = join(markerDir, 'conv.js');
    const extScript = join(markerDir, 'ext.js');
    writeFileSync(convScript, `try{const c=require('fs').readFileSync(0,'utf8');require('fs').writeFileSync(${JSON.stringify(textconvMarker)},'ran');process.stdout.write('CONV:'+c);}catch(e){process.exit(1);}`, 'utf8');
    writeFileSync(extScript, `require('fs').writeFileSync(${JSON.stringify(extdiffMarker)}, 'ran');`, 'utf8');
    // .gitattributes + 驱动配置（绝对路径，正斜杠）。
    writeFileSync(join(root, '.gitattributes'), '*.zzz diff=zzconv\n*.zzq diff=zzext\n', 'utf8');
    const fwd = (p: string): string => p.split('\\').join('/');
    git(root, 'config', 'diff.zzconv.textconv', `node ${fwd(convScript)}`);
    git(root, 'config', 'diff.zzext.command', `node ${fwd(extScript)}`);
    git(root, 'add', '.gitattributes');
    git(root, 'commit', '-q', '-m', 'attrs');
    writeFileSync(join(root, 'a.zzz'), 'changed zzz\n', 'utf8');
    writeFileSync(join(root, 'b.zzq'), 'changed zzq\n', 'utf8');

    // 控制组：普通 git diff（不带禁用旗标）确实会执行驱动——证明 fixture 有效。
    try { git(root, 'diff', '--', 'a.zzz'); } catch { /* textconv 退出码不影响 */ }
    expect(existsSync(textconvMarker)).toBe(true);
    rmFileSync(textconvMarker);
    try { git(root, 'diff', '--', 'b.zzq'); } catch { /* 驱动非零退出可接受 */ }
    expect(existsSync(extdiffMarker)).toBe(true);
    rmFileSync(extdiffMarker);

    // 正式命令：标记程序不得被执行；正文是真实 unified diff（未过滤内容）。
    const d1 = await cmd<{ patches: Array<{ path: string; text: string }> }>('git.diff', { projectId: 'p1', path: 'a.zzz' });
    expect(d1.patches[0]!.text).toContain('+changed zzz');
    const d2 = await cmd<{ patches: Array<{ path: string; text: string }> }>('git.diff', { projectId: 'p1', path: 'b.zzq' });
    expect(d2.patches[0]!.text).toContain('+changed zzq');
    expect(existsSync(textconvMarker)).toBe(false);
    expect(existsSync(extdiffMarker)).toBe(false);
    db.close();
  }, 30_000);
});

function rmFileSync(p: string): void {
  try { rmSync(p, { force: true }); } catch { /* 尽力 */ }
}
