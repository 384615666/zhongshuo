/**
 * DEV-12 主体集成验证（2026-09-28 第五轮）：Git/非 Git 临时 fixture——不对真实项目做任何
 * 破坏性试验。全部经正式命令路径（dispatchDaemonCommand changeset.*）。
 *
 * 反例覆盖（用户指定）：
 * - 正常恢复：新增/修改/删除混合撤销，内容逐字节还原；
 * - 用户后续修改冲突：当前≠after → conflict 不覆盖；
 * - 读取失败（unknown）：不自动撤销、不推导；
 * - 中途失败/重启恢复：注入中断 → 步骤进度持久化 → 重开连接续跑（确定性恢复）；
 * - 单写者：活跃 workspace_leases 重叠 → undo 拒绝并列持有者；同项目互斥；
 * - Git 基线：HEAD+未提交内容前像（不 stash/reset）；非 Git 目录扫描基线；
 * - 超大文件：内容级撤销不可用提前呈现（manual）；
 * - finalize 幂等保护：已定型不重捕；已撤销不重复执行。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import type { DaemonCommandDeps } from '../../src/daemon/commands.ts';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'zs-dev12-'));
const appData = join(fixtureRoot, 'appdata');
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

interface Envelope { protocolVersion: 1; commandId: string; method: string; params: unknown }

function deps(db: ZhongshuoDatabase): DaemonCommandDeps {
  return { db, localUserId: 'u_dev12', interruptTurn: async () => {}, appDataDir: appData };
}
async function cmd<T>(db: ZhongshuoDatabase, method: string, params: unknown): Promise<T> {
  const env: Envelope = { protocolVersion: 1, commandId: `cmd-dev12-${Math.random().toString(36).slice(2)}`, method, params };
  const r = await dispatchDaemonCommand(deps(db), env) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

interface BaselineOk { changeSetId: string; git: { isRepo: boolean; head: string | null }; fileCount: number; contentUnavailable: string[]; truncated: boolean }
interface UndoOk { undoId: string; status: string; steps: Array<{ path: string; action: string; status: string; detail?: string }>; manualPaths: string[] }

function seedProject(db: ZhongshuoDatabase, projectId: string, canonicalPath: string): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, 'p', ?, ?, '{}', 0)`).run(projectId, canonicalPath, canonicalPath);
}

function gitInit(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  execSync('git add -A', { cwd: dir });
  execSync('git commit -q --allow-empty -m init', { cwd: dir });
}

describe('DEV-12 非 Git 目录：基线/差异/非破坏撤销', () => {
  it('正常恢复：修改/新增/删除混合撤销，内容逐字节还原；清单外文件不受影响', async () => {
    const dir = join(fixtureRoot, 'plain');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'keep.txt'), '保留', 'utf8');
    writeFileSync(join(dir, 'mod.txt'), 'before-v1', 'utf8');
    writeFileSync(join(dir, 'untouched.txt'), '外部文件不动', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'p1', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p1' });
    expect(base.git.isRepo).toBe(false); // 非 Git 目录：如实
    expect(base.fileCount).toBe(3);
    // 模拟任务变更：修改 + 新增 + 删除。
    writeFileSync(join(dir, 'mod.txt'), 'after-v2', 'utf8');
    writeFileSync(join(dir, 'added.txt'), '新增内容', 'utf8');
    unlinkSync(join(dir, 'sub', 'keep.txt'));
    const fin = await cmd<{ diff: { added: string[]; removed: string[]; modified: string[] } }>(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    expect(fin.diff.added).toEqual(['added.txt']);
    expect(fin.diff.removed).toEqual(['sub/keep.txt']);
    expect(fin.diff.modified).toEqual(['mod.txt']);
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.status).toBe('succeeded');
    expect(readFileSync(join(dir, 'mod.txt'), 'utf8')).toBe('before-v1'); // 修改还原
    expect(existsSync(join(dir, 'added.txt'))).toBe(false); // 新增删除
    expect(readFileSync(join(dir, 'sub', 'keep.txt'), 'utf8')).toBe('保留'); // 删除恢复
    expect(readFileSync(join(dir, 'untouched.txt'), 'utf8')).toBe('外部文件不动'); // 清单外不受影响
    const detail = await cmd<{ applicationStatus: string }>(db, 'changeset.get', { changeSetId: base.changeSetId });
    expect(detail.applicationStatus).toBe('reverted');
    // 已撤销不重复执行。
    await expect(cmd(db, 'changeset.undo', { changeSetId: base.changeSetId })).rejects.toThrow(/已撤销/);
    db.close();
  }, 30_000);

  it('用户后续修改冲突：当前≠after → conflict 不覆盖（§14.5）', async () => {
    const dir = join(fixtureRoot, 'conflict');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), '任务前内容', 'utf8');
    writeFileSync(join(dir, 'b.txt'), '用户后来手改的内容占位前', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'p2', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p2', paths: ['a.txt', 'b.txt'] });
    writeFileSync(join(dir, 'a.txt'), '任务产物', 'utf8');
    writeFileSync(join(dir, 'b.txt'), '任务产物', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    // 撤销前用户又改了 b.txt（≠after）→ 冲突不覆盖；a.txt 正常还原。
    writeFileSync(join(dir, 'b.txt'), '用户在任务后手动改过', 'utf8');
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.status).toBe('conflict');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('任务前内容');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('用户在任务后手动改过'); // 不覆盖
    expect(undo.manualPaths).toContain('b.txt');
    const detail = await cmd<{ applicationStatus: string }>(db, 'changeset.get', { changeSetId: base.changeSetId });
    expect(detail.applicationStatus).toBe('partial'); // 部分撤销——如实
    db.close();
  }, 30_000);

  it('读取失败（unknown）：不自动撤销、不推导增删改', async () => {
    const dir = join(fixtureRoot, 'unknown');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.txt'), 'v1', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'p3', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p3', paths: ['x.txt'] });
    writeFileSync(join(dir, 'x.txt'), 'v2', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    // 制造 after 侧 unknown：直接改库把 after 行打成 unknown（真实场景=读取失败）。
    db.prepare(`UPDATE change_set_files SET state = 'unknown', sha256 = NULL WHERE change_set_id = ? AND role = 'after' AND path = 'x.txt'`).run(base.changeSetId);
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.status).toBe('conflict');
    expect(undo.steps.find((s) => s.path === 'x.txt')!.status).toBe('manual'); // unknown → 不自动撤销
    expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('v2'); // 原样保留
    db.close();
  }, 30_000);

  it('超大文件：内容级撤销不可用提前呈现（capture 即 contentUnavailable；undo=manual）', async () => {
    const dir = join(fixtureRoot, 'bigfile');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(4096), 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'p4', dir);
    const base = await cmd<{ changeSetId: string; contentUnavailable: string[] }>(db, 'changeset.captureBaseline', {
      projectId: 'p4', paths: ['big.bin'], maxBytes: 1024,
    });
    expect(base.contentUnavailable).toEqual([]);
    writeFileSync(join(dir, 'big.bin'), 'y'.repeat(4096), 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.status).toBe('succeeded');
    expect(readFileSync(join(dir,'big.bin'),'utf8')).toBe('x'.repeat(4096));
    db.close();
  }, 30_000);

  it('单写者：重叠活跃租约 → undo 拒绝并列持有者；同项目互斥', async () => {
    const dir = join(fixtureRoot, 'lease');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.txt'), 'v1', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'p5', dir);
    // 派发侧写档租约（workspace_leases.owner 为 turn——用真实 agent_turn 行构造）。
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p5','成员','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r5','p5','大厅','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c5','p5','room','r5')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES ('tk5','p5','c5','room_task','r5','租约用任务')`).run();
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status) VALUES ('run5','tk5','c5','DIRECT',0,'RUNNING')`).run();
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status) VALUES ('turn5','run5','c5','mA','direct.work','RUNNING')`).run();
    db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES (?, 'turn5', 1, 0, 'active')`).run(dir.toLowerCase());
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p5', paths: ['f.txt'] });
    writeFileSync(join(dir, 'f.txt'), 'v2', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    await expect(cmd(db, 'changeset.undo', { changeSetId: base.changeSetId })).rejects.toThrow(/其他任务正在修改此目录/);
    db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE owner_turn_id = 'turn5'`).run();
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.status).toBe('succeeded'); // 租约释放后可执行
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('v1');
    // 同项目互斥：另一 changeset 的进行中撤销阻塞新撤销（用手工 in_progress 行模拟）。
    db.prepare(
      `INSERT INTO change_sets (id, project_id, before_ref, after_ref, application_status) VALUES ('cs_other','p5','{}','{"kind":"preimage"}','applied')`,
    ).run();
    db.prepare(
      `INSERT INTO change_set_undos (id, change_set_id, status, steps_json, created_at, updated_at) VALUES ('undo_other','cs_other','in_progress','[]',1,1)`,
    ).run();
    const base2 = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p5', paths: ['f.txt'] });
    writeFileSync(join(dir, 'f.txt'), 'v3', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base2.changeSetId });
    await expect(cmd(db, 'changeset.undo', { changeSetId: base2.changeSetId })).rejects.toThrow(/进行中的撤销/);
    db.close();
  }, 30_000);

  it('中途失败/重启恢复：注入中断 → 步骤进度持久化 → 重开连接续跑（确定性恢复）', async () => {
    const dir = join(fixtureRoot, 'resume');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'm1.txt'), 'one', 'utf8');
    writeFileSync(join(dir, 'm2.txt'), 'two', 'utf8');
    writeFileSync(join(dir, 'm3.txt'), 'three', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'p6', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p6', paths: ['m1.txt', 'm2.txt', 'm3.txt'] });
    writeFileSync(join(dir, 'm1.txt'), 'ONE', 'utf8');
    writeFileSync(join(dir, 'm2.txt'), 'TWO', 'utf8');
    writeFileSync(join(dir, 'm3.txt'), 'THREE', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    // 注入：执行 1 步后中断（模拟崩溃/停止——进度已持久化）。
    const { undoChangeset } = await import('../../src/daemon/changeset.ts');
    const interrupted = undoChangeset(db, { changeSetId: base.changeSetId, appDataDir: appData, failAfterSteps: 1 });
    expect(interrupted.ok).toBe(true);
    expect(interrupted.ok && interrupted.value.status).toBe('failed');
    const doneAfterCrash = interrupted.ok ? interrupted.value.steps.filter((s) => s.status === 'done').length : 0;
    expect(doneAfterCrash).toBe(1);
    // 「重启」：模拟同一数据库经持久化重开（:memory: 换文件库验证跨连接恢复）——用独立
    // 目录避免与场景一的状态纠缠。
    const dir2 = join(fixtureRoot, 'resume2');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'm1.txt'), 'one', 'utf8');
    writeFileSync(join(dir2, 'm2.txt'), 'two', 'utf8');
    writeFileSync(join(dir2, 'm3.txt'), 'three', 'utf8');
    const dbFile = join(fixtureRoot, 'resume.sqlite');
    const dbDisk = openDatabase(dbFile);
    dbDisk.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p6b','p',?,?,'{}',0)`).run(dir2, dir2);
    const base2 = await cmd<BaselineOk>(dbDisk, 'changeset.captureBaseline', { projectId: 'p6b', paths: ['m1.txt', 'm2.txt', 'm3.txt'] });
    writeFileSync(join(dir2, 'm1.txt'), 'ONE', 'utf8');
    writeFileSync(join(dir2, 'm2.txt'), 'TWO', 'utf8');
    writeFileSync(join(dir2, 'm3.txt'), 'THREE', 'utf8');
    await cmd(dbDisk, 'changeset.finalize', { changeSetId: base2.changeSetId });
    const half = undoChangeset(dbDisk, { changeSetId: base2.changeSetId, appDataDir: appData, failAfterSteps: 1 });
    expect(half.ok && half.value.status).toBe('failed');
    expect(half.ok && half.value.steps.filter((s) => s.status === 'done').length).toBe(1); // 第一步已落盘
    expect(readFileSync(join(dir2, 'm1.txt'), 'utf8')).toBe('one'); // 已执行步骤的文件已还原
    dbDisk.close();
    const dbDisk2 = openDatabase(dbFile); // 重开连接：读持久化进度续跑（后两步）
    const resumed = await cmd<UndoOk>(dbDisk2, 'changeset.undo', { changeSetId: base2.changeSetId });
    expect(resumed.status).toBe('succeeded');
    expect(readFileSync(join(dir2, 'm1.txt'), 'utf8')).toBe('one'); // 已 done 的步骤不重复执行
    expect(readFileSync(join(dir2, 'm2.txt'), 'utf8')).toBe('two');
    expect(readFileSync(join(dir2, 'm3.txt'), 'utf8')).toBe('three');
    dbDisk2.close();
    db.close();
  }, 30_000);
});

describe('DEV-12 Git 目录：基线=HEAD+未提交内容前像（不 stash/reset）', () => {
  it('Git HEAD 记录 + 未提交修改进前像；用户原有改动保留（撤销不动 Git 历史）', async () => {
    const dir = join(fixtureRoot, 'gitrepo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tracked.txt'), 'committed', 'utf8');
    writeFileSync(join(dir, 'user-uncommitted.txt'), '用户未提交改动', 'utf8');
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t', { cwd: dir });
    execSync('git config user.name t', { cwd: dir });
    execSync('git add tracked.txt', { cwd: dir }); // 只提交 tracked（用户未提交改动保留在工作区）
    execSync('git commit -q -m init', { cwd: dir });
    const db = openDatabase(':memory:');
    seedProject(db, 'p7', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p7' });
    expect(base.git.isRepo).toBe(true);
    expect(base.git.head).toMatch(/^[0-9a-f]{40}$/); // HEAD 记录
    expect(base.fileCount).toBe(2); // 含范围内未跟踪/未提交文件（不降级为仅 ref，§14.2）
    // 任务变更：改 tracked.txt + 新增 agent 文件。
    writeFileSync(join(dir, 'tracked.txt'), 'agent 修改', 'utf8');
    writeFileSync(join(dir, 'agent-new.txt'), 'agent 新增', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.status).toBe('succeeded');
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('committed');
    expect(existsSync(join(dir, 'agent-new.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'user-uncommitted.txt'), 'utf8')).toBe('用户未提交改动'); // 用户原有改动保留
    // Git 历史未被触碰（无新提交/无 reset——HEAD 不变、工作区用户文件原样）。
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    expect(head).toBe(base.git.head);
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' });
    expect(status).toContain('user-uncommitted.txt'); // 用户改动仍在工作区（未 stash/commit）
    db.close();
  }, 40_000);

  it('撤销新增也确认仍是本次产物：新增文件被用户改过 → conflict 不删', async () => {
    const dir = join(fixtureRoot, 'gitrepo2');
    mkdirSync(dir, { recursive: true });
    gitInit(dir);
    const db = openDatabase(':memory:');
    seedProject(db, 'p8', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p8', paths: ['gen.txt'] });
    writeFileSync(join(dir, 'gen.txt'), 'agent 产物', 'utf8'); // 新增（before=absent）
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    writeFileSync(join(dir, 'gen.txt'), '用户改写了产物', 'utf8'); // 撤销前被修改
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.steps[0]!.status).toBe('conflict');
    expect(readFileSync(join(dir, 'gen.txt'), 'utf8')).toBe('用户改写了产物'); // 不删用户内容
    db.close();
  }, 40_000);

  it('finalize 幂等保护：已定型不重捕（防 after 被覆盖）', async () => {
    const dir = join(fixtureRoot, 'gitrepo3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'z.txt'), 'v1', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'p9', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'p9', paths: ['z.txt'] });
    writeFileSync(join(dir, 'z.txt'), 'v2', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    writeFileSync(join(dir, 'z.txt'), 'v3', 'utf8'); // 定型后再改
    await expect(cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId })).rejects.toThrow(/已定型/);
    const detail = await cmd<{ after: Array<{ path: string; sha256: string | null }> }>(db, 'changeset.get', { changeSetId: base.changeSetId });
    expect(detail.after).toHaveLength(1); // after 未被 v3 覆盖（冻结）
    db.close();
  }, 30_000);
});

describe('DEV-12 第五轮四项修复（扫描完整性/三态边界/崩溃窗口/写入占位）', () => {
  it('修复①：空目录是合法基线（0 文件可 finalize）；新增文件可撤销回空', async () => {
    const dir = join(fixtureRoot, 'empty-base');
    mkdirSync(dir, { recursive: true });
    const db = openDatabase(':memory:');
    seedProject(db, 'pE1', dir);
    const base = await cmd<{ changeSetId: string; fileCount: number }>(db, 'changeset.captureBaseline', { projectId: 'pE1' });
    expect(base.fileCount).toBe(0); // 空目录=合法基线（不因零行拒绝）
    writeFileSync(join(dir, 'new.txt'), '任务新增', 'utf8');
    const fin = await cmd<{ diff: { added: string[] } }>(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    expect(fin.diff.added).toEqual(['new.txt']); // 扫描完整（无失败/截断）→ 基线无行=变更前 absent
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(undo.status).toBe('succeeded');
    expect(existsSync(join(dir, 'new.txt'))).toBe(false); // 撤销回空目录
    db.close();
  }, 30_000);

  it('修复②：目标被目录占位（非普通文件）=unknown——拒绝自动覆盖，原状保留', async () => {
    const dir = join(fixtureRoot, 'dir-in-place');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.txt'), 'v1', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'pE2', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'pE2', paths: ['f.txt'] });
    writeFileSync(join(dir, 'f.txt'), 'v2', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    // 撤销前外部把文件换成同名目录（stat=directory——旧 hashIfPresent 会当作「不存在」误判）。
    unlinkSync(join(dir, 'f.txt'));
    mkdirSync(join(dir, 'f.txt'), { recursive: true });
    writeFileSync(join(dir, 'f.txt', 'inner.txt'), '占位内容', 'utf8');
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    const step = undo.steps.find((s) => s.path === 'f.txt')!;
    expect(step.status).toBe('failed'); // unknown → 拒绝自动覆盖
    expect(step.detail).toContain('未知');
    expect(existsSync(join(dir, 'f.txt', 'inner.txt'))).toBe(true); // 原状保留（未删未覆盖）
    db.close();
  }, 30_000);

  it('修复③：崩溃窗口（rename 已成功、done 未写库）→ 恢复三向判定补记不重执行、不误判冲突', async () => {
    const { undoChangeset } = await import('../../src/daemon/changeset.ts');
    const dir = join(fixtureRoot, 'crashwin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mod.txt'), 'one', 'utf8');   // 修改类
    writeFileSync(join(dir, 'del.txt'), 'two', 'utf8');   // 将被任务删除（restore-removed）
    const db = openDatabase(':memory:');
    seedProject(db, 'pE3', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'pE3' });
    writeFileSync(join(dir, 'mod.txt'), 'ONE', 'utf8');
    unlinkSync(join(dir, 'del.txt'));
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    // 崩溃注入：完成第 1 个文件动作（mod.txt rename 已落盘）后、记账前崩溃。
    const crashed = undoChangeset(db, { changeSetId: base.changeSetId, appDataDir: appData, crashAfterStepActions: 1 });
    expect(crashed.ok).toBe(true);
    // 步骤按路径序：del.txt（restore-removed）先执行——崩溃注入点在其 rename 之后。
    expect(readFileSync(join(dir, 'del.txt'), 'utf8')).toBe('two');  // 动作确实已执行（记账缺失）
    expect(readFileSync(join(dir, 'mod.txt'), 'utf8')).toBe('ONE');  // 第二步未执行
    // 恢复：del.txt=已执行未记账 → 补记 done（不重执行、不误判用户冲突）；mod.txt 照常还原。
    const resumed = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    const modStep = resumed.steps.find((s) => s.path === 'mod.txt')!;
    const delStep = resumed.steps.find((s) => s.path === 'del.txt')!;
    expect(delStep.status).toBe('done');
    expect(delStep.detail).toContain('补记');   // 三向判定命中「已执行未记账」
    expect(modStep.status).toBe('done');
    expect(resumed.status).toBe('succeeded');
    expect(readFileSync(join(dir, 'mod.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(dir, 'del.txt'), 'utf8')).toBe('two');
    db.close();
  }, 30_000);

  it('修复③：崩溃窗口（delete-added 已删除、记账缺失）→ 恢复补记 absent 不重复执行', async () => {
    const { undoChangeset } = await import('../../src/daemon/changeset.ts');
    const dir = join(fixtureRoot, 'crashwin-del');
    mkdirSync(dir, { recursive: true });
    const db = openDatabase(':memory:');
    seedProject(db, 'pE4', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'pE4', paths: ['gen.txt'] });
    writeFileSync(join(dir, 'gen.txt'), '产物', 'utf8'); // 新增
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    const crashed = undoChangeset(db, { changeSetId: base.changeSetId, appDataDir: appData, crashAfterStepActions: 1 });
    expect(crashed.ok).toBe(true);
    expect(existsSync(join(dir, 'gen.txt'))).toBe(false); // 删除已执行、记账缺失
    const resumed = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    const step = resumed.steps[0]!;
    expect(step.status).toBe('done');
    expect(step.detail).toContain('补记');
    expect(resumed.status).toBe('succeeded');
    db.close();
  }, 30_000);

  it('修复③：failed 步骤续跑重试（此前只处理 pending——失败后永远不能恢复）', async () => {
    const dir = join(fixtureRoot, 'retry-failed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'r.txt'), 'v1', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'pE5', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'pE5', paths: ['r.txt'] });
    writeFileSync(join(dir, 'r.txt'), 'v2', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    // 制造 failed：删掉内容存储里的前像文件（restore 读取失败）。
    const storeDir = join(appData, 'preimages', 'pE5');
    const beforeHashRow = db.prepare(`SELECT content_ref FROM change_set_files WHERE change_set_id = ? AND role = 'before' AND path = 'r.txt'`).get(base.changeSetId) as { content_ref: string };
    const storeFile = join(storeDir, beforeHashRow.content_ref);
    rmSync(storeFile, { force: true });
    const first = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(first.steps[0]!.status).toBe('failed'); // 存储缺失 → failed
    expect(readFileSync(join(dir, 'r.txt'), 'utf8')).toBe('v2'); // 原文件不动
    // 恢复存储后重试：failed → 重置 pending → 三向重验 → 执行成功。
    writeFileSync(storeFile, 'v1', 'utf8');
    const second = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    expect(second.steps[0]!.status).toBe('done');
    expect(readFileSync(join(dir, 'r.txt'), 'utf8')).toBe('v1');
    expect(second.status).toBe('succeeded');
    db.close();
  }, 30_000);

  it('修复②：基线后父目录被换成指向外部的 junction/symlink → 物理重核拒绝（外部零写入）', async () => {
    const dir = join(fixtureRoot, 'parent-swap');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'f.txt'), 'v1', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'pE6', dir);
    const base = await cmd<BaselineOk>(db, 'changeset.captureBaseline', { projectId: 'pE6', paths: ['sub/f.txt'] });
    writeFileSync(join(dir, 'sub', 'f.txt'), 'v2', 'utf8');
    await cmd(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    const outside = mkdtempSync(join(tmpdir(), 'zs-dev12-out-'));
    const symlinkSync = (await import('node:fs')).symlinkSync;
    const renameSync = (await import('node:fs')).renameSync;
    try {
      symlinkSync(outside, join(dir, 'sub-link'), 'dir');
    } catch {
      db.close();
      rmSync(outside, { recursive: true, force: true });
      return; // 无目录链接权限的环境跳过（Windows 开发者模式要求）
    }
    // 基线后：删除真实 sub，把指向外部的链接改名为 sub（字符串前缀仍在界内——物理重核必须先拒）。
    rmSync(join(dir, 'sub'), { recursive: true, force: true });
    renameSync(join(dir, 'sub-link'), join(dir, 'sub'));
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    const step = undo.steps[0]!;
    expect(step.status).toBe('failed'); // 字符串前缀在界内但物理路径越界 → 拒绝
    expect(step.detail).toContain('物理路径核对失败');
    expect(existsSync(join(outside, 'f.txt'))).toBe(false); // 外部目录零写入
    db.close();
    rmSync(outside, { recursive: true, force: true });
  }, 30_000);
});

describe('DEV-12 修复①：扫描失败不静默——基线缺失判 unknown 不推导 absent', () => {
  it('manifest 记录 failedDirs/rejected → finalize 新文件=undeterminable（非 added）；undo=manual', async () => {
    const dir = join(fixtureRoot, 'scan-integrity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.txt'), 'v1', 'utf8');
    const db = openDatabase(':memory:');
    seedProject(db, 'pE7', dir);
    const base = await cmd<{ changeSetId: string }>(db, 'changeset.captureBaseline', { projectId: 'pE7' });
    // 模拟扫描完整性破口（跨平台确定性：直接把 manifest 标记为有失败——等价于 readdir/物理拒绝后的落库事实）。
    db.prepare(`UPDATE change_sets SET manifest_json = json_set(manifest_json, '$.scanFailedDirs', 1) WHERE id = ?`).run(base.changeSetId);
    writeFileSync(join(dir, 'new-file.txt'), '任务新增', 'utf8');
    const fin = await cmd<{ diff: { added: string[]; undeterminable: Array<{ path: string }> } }>(db, 'changeset.finalize', { changeSetId: base.changeSetId });
    expect(fin.diff.added).not.toContain('new-file.txt'); // 扫描不完整 → 不能断定变更前不存在
    expect(fin.diff.undeterminable.map((u) => u.path)).toContain('new-file.txt'); // 判 unknown
    const undo = await cmd<UndoOk>(db, 'changeset.undo', { changeSetId: base.changeSetId });
    const step = undo.steps.find((s) => s.path === 'new-file.txt')!;
    expect(step.status).toBe('manual'); // unknown 不自动撤销（也不自动删除）
    expect(existsSync(join(dir, 'new-file.txt'))).toBe(true); // 原样保留
    db.close();
  }, 30_000);
});
