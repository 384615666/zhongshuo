import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import { openProject, relocateProject, getProject } from '../../src/daemon/projectStore.ts';
import {
  acquireLease,
  confirmLeaseTerminated,
  markExpiredLeases,
  releaseLease,
} from '../../src/daemon/workspaceLocks.ts';
import { buildBaselineManifest, createBaselineRecord } from '../../src/daemon/baseline.ts';
import { isSameOrAncestorPath, lockDomainsOverlap } from '../../src/daemon/directoryIdentity.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev04-'));
const db = openDatabase(':memory:');

beforeAll(() => {
  mkdirSync(join(tmpRoot, 'ProjA', 'src'), { recursive: true });
  mkdirSync(join(tmpRoot, 'other'), { recursive: true });
  writeFileSync(join(tmpRoot, 'ProjA', 'src', 'a.ts'), 'export const v = 424242;\n', 'utf8');
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  db.close();
});

describe('目录身份（§3.3）', () => {
  it('路径边界判定：不做裸前缀', () => {
    expect(isSameOrAncestorPath('D:/x/ab', 'D:/x/abc')).toBe(false);
    expect(isSameOrAncestorPath('D:/x/ab', 'D:/x/ab/deep')).toBe(true);
    expect(isSameOrAncestorPath('D:\\X\\AB', 'd:/x/ab/deep')).toBe(true); // win32 大小写折叠
  });

  it('锁域重叠：父子项目互为重叠（RT-09）', () => {
    expect(lockDomainsOverlap('d:/x/ab', 'd:/x/ab/sub')).toBe(true);
    expect(lockDomainsOverlap('d:/x/ab/sub', 'd:/x/ab')).toBe(true);
    expect(lockDomainsOverlap('d:/x/ab', 'd:/x/cd')).toBe(false);
  });
});

describe('项目打开与去重（§3.3）', () => {
  it('同一目录二次打开 → 命中同一 projectId，不新建', () => {
    const first = openProject(db, { rootPath: join(tmpRoot, 'ProjA'), now: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.created).toBe(true);

    const second = openProject(db, { rootPath: join(tmpRoot, 'ProjA'), now: 2 });
    expect(second).toMatchObject({ ok: true });
    if (second.ok) {
      expect(second.value.created).toBe(false);
      expect(second.value.project.id).toBe(first.value.project.id);
    }
  });

  it('大小写不同的入口 → 命中（win32 折叠比较键；首次登记的原始路径保留）', () => {
    const lower = join(tmpRoot, 'proja');
    const r = openProject(db, { rootPath: lower, now: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.created).toBe(false);
      // 命中返回既有记录：rootPath 保持首次登记的原样，不被小写入口改写。
      expect(r.value.project.directoryIdentity.rootPath).toBe(join(tmpRoot, 'ProjA'));
    }
  });

  it('junction 入口 → realpath 解析后命中同一项目（RT-09 前置）', () => {
    const link = join(tmpRoot, 'ProjA junction');
    symlinkSync(join(tmpRoot, 'ProjA'), link, 'junction');
    const r = openProject(db, { rootPath: link, now: 4 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.created).toBe(false);
    }
  });

  it('不同物理目录 → 新项目；目录不存在 → PROJECT_MISSING', () => {
    const other = openProject(db, { rootPath: join(tmpRoot, 'other'), now: 5 });
    expect(other.ok && other.value.created).toBe(true);
    const missing = openProject(db, { rootPath: join(tmpRoot, 'nope'), now: 6 });
    expect(missing).toMatchObject({ ok: false, error: { code: 'PROJECT_MISSING' } });
  });
});

describe('重定位（RT-14）', () => {
  it('移动目录后 relocate：projectId 不变、revision+1、路径更新', () => {
    const opened = openProject(db, { rootPath: join(tmpRoot, 'other'), now: 10 });
    if (!opened.ok) throw new Error('openProject 失败');
    const projectId = opened.value.project.id;

    renameSync(join(tmpRoot, 'other'), join(tmpRoot, 'other-moved'));
    const relocated = relocateProject(db, {
      projectId,
      newRootPath: join(tmpRoot, 'other-moved'),
      expectedRevision: opened.value.project.revision,
    });
    expect(relocated.ok).toBe(true);
    if (relocated.ok) {
      expect(relocated.value.id).toBe(projectId);
      expect(relocated.value.revision).toBe(opened.value.project.revision + 1);
      expect(relocated.value.directoryIdentity.canonicalPath).toContain('other-moved');
    }
  });

  it('STALE_REVISION / 不存在 / 撞其他项目目录', () => {
    const p = getProject(db, 'nope');
    expect(p).toBeUndefined();
    const opened = openProject(db, { rootPath: join(tmpRoot, 'ProjA'), now: 20 });
    if (!opened.ok) throw new Error('setup 失败');
    const id = opened.value.project.id;
    const stale = relocateProject(db, {
      projectId: id,
      newRootPath: join(tmpRoot, 'other-moved'),
      expectedRevision: 99,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    const conflict = relocateProject(db, {
      // other-moved 已是另一项目目录
      projectId: id,
      newRootPath: join(tmpRoot, 'other-moved'),
      expectedRevision: 0,
    });
    expect(conflict).toMatchObject({ ok: false });
    const missing = relocateProject(db, {
      projectId: id,
      newRootPath: join(tmpRoot, 'ghost'),
      expectedRevision: 0,
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'PROJECT_MISSING' } });
  });
});

describe('写入租约（RT-07/08/09，single_writer 默认）', () => {
  beforeAll(() => {
    seedTurn('pw1');
seedTurn('pw2');
seedTurn('pw3');
seedTurn('pw4');
seedTurn('turn_a');
seedTurn('turn_b');
seedTurn('turn_c');
seedTurn('turn_ch');
seedTurn('turn_ch2');
seedTurn('turn_ep');
seedTurn('turn_new');
seedTurn('turn_old');
seedTurn('turn_p');
  });
  const parentDomain = join(tmpRoot, 'ProjA').toLowerCase();
  const childDomain = join(tmpRoot, 'ProjA', 'src').toLowerCase();

  /** workspace_leases.owner_turn_id 外键指向 agent_turns：播种最小任务/运行/turn 链。 */
  let turnSeq = 0;
  function seedTurn(turnId: string): void {
    turnSeq += 1;
    const n = turnSeq;
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
                VALUES (?, ?, ?, ?, '{}', 0)`)
      .run(`p_lock_${n}`, `锁域测试${n}`, `D:/lock/${n}`, `D:/lock/${n}`);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type) VALUES (?, ?, 'm', 'agent')`)
      .run(`m_lock_${n}`, `p_lock_${n}`);
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, 'r', ?)`)
      .run(`room_lock_${n}`, `p_lock_${n}`, `m_lock_${n}`);
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)`)
      .run(`conv_lock_${n}`, `p_lock_${n}`, `room_lock_${n}`);
    db.prepare(
      `INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES (?, ?, ?, 'room_task', ?, '锁域')`,
    ).run(`task_lock_${n}`, `p_lock_${n}`, `conv_lock_${n}`, `room_lock_${n}`);
    db.prepare(
      `INSERT INTO workflow_runs (id, task_id, conversation_id, mode) VALUES (?, ?, ?, 'DIRECT')`,
    ).run(`run_lock_${n}`, `task_lock_${n}`, `conv_lock_${n}`);
    db.prepare(
      `INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status)
       VALUES (?, ?, ?, ?, 'direct', 'PENDING')`,
    ).run(turnId, `run_lock_${n}`, `conv_lock_${n}`, `m_lock_${n}`);
  }

  it('同域第二个写入者 → WORKSPACE_BUSY（携带持有者）；不同域互不阻塞', () => {
    const a = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_a', policy: 'single_writer', now: 100 });
    expect(a).toMatchObject({ ok: true });
    const b = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_b', policy: 'single_writer', now: 101 });
    expect(b).toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_BUSY', details: { holders: [{ ownerTurnId: 'turn_a' }] } },
    });
    const c = acquireLease(db, { lockDomain: join(tmpRoot, 'elsewhere').toLowerCase(), ownerTurnId: 'turn_c', policy: 'single_writer', now: 102 });
    expect(c).toMatchObject({ ok: true });
    releaseLease(db, { lockDomain: join(tmpRoot, 'elsewhere').toLowerCase(), ownerTurnId: 'turn_c' });
    releaseLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_a' });
  });

  it('父子项目锁域重叠 → 并发被拒（RT-09）', () => {
    const a = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_p', policy: 'single_writer', now: 200 });
    expect(a).toMatchObject({ ok: true });
    const child = acquireLease(db, { lockDomain: childDomain, ownerTurnId: 'turn_ch', policy: 'single_writer', now: 201 });
    expect(child).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    releaseLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_p' });
    const childAfter = acquireLease(db, { lockDomain: childDomain, ownerTurnId: 'turn_ch2', policy: 'single_writer', now: 202 });
    expect(childAfter).toMatchObject({ ok: true });
    releaseLease(db, { lockDomain: childDomain, ownerTurnId: 'turn_ch2' });
  });

  it('RT-07：租约心跳过期仍阻塞，确认终止后放行', () => {
    const a = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_old', policy: 'single_writer', now: 300 });
    expect(a).toMatchObject({ ok: true });
    // 心跳 300，超时阈值 60s：now=400 时已过期。
    markExpiredLeases(db, 400, 60_000);
    const b = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_new', policy: 'single_writer', now: 401 });
    expect(b).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } }); // 过期不放行
    confirmLeaseTerminated(db, { lockDomain: parentDomain, ownerTurnId: 'turn_old' });
    const c = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_new', policy: 'single_writer', now: 402 });
    expect(c).toMatchObject({ ok: true });
    releaseLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_new' });
  });

  it('parallel_writers：同域共存至上限、跨父子域仍拒绝（§14.1 底线）', () => {
    const ok1 = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'pw1', policy: 'parallel_writers', now: 500, parallelMaxWriters: 2 });
    expect(ok1).toMatchObject({ ok: true });
    const ok2 = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'pw2', policy: 'parallel_writers', now: 501, parallelMaxWriters: 2 });
    expect(ok2).toMatchObject({ ok: true });
    const ok3 = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'pw3', policy: 'parallel_writers', now: 502, parallelMaxWriters: 2 });
    expect(ok3).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } }); // 上限 2，超出排队
    const cross = acquireLease(db, { lockDomain: childDomain, ownerTurnId: 'pw4', policy: 'parallel_writers', now: 503, parallelMaxWriters: 2 });
    expect(cross).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } }); // 锁域判定不变
    releaseLease(db, { lockDomain: parentDomain, ownerTurnId: 'pw1' });
    releaseLease(db, { lockDomain: parentDomain, ownerTurnId: 'pw2' });
  });

  it('同一 owner 重取租约：epoch 递增（fencing）', () => {
    const a = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_ep', policy: 'single_writer', now: 600 });
    releaseLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_ep' });
    const b = acquireLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_ep', policy: 'single_writer', now: 601 });
    if (a.ok && b.ok) {
      expect(b.value.epoch).toBe(a.value.epoch + 1);
    }
    releaseLease(db, { lockDomain: parentDomain, ownerTurnId: 'turn_ep' });
  });
});

describe('基线清单（§6.3 最小 + §14.2 Git ref）', () => {
  it('排除规则/大文件/凭据/符号链接如实入清单；内容 hash 可核对', () => {
    const fixture = join(tmpRoot, 'baseline-fixture');
    mkdirSync(join(fixture, 'src', 'deep'), { recursive: true });
    mkdirSync(join(fixture, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'deep', 'note.md'), '# 说明\n', 'utf8');
    writeFileSync(join(fixture, 'src', 'data.bin'), Buffer.alloc(4));
    writeFileSync(join(fixture, '.env'), 'SECRET=1', 'utf8');
    writeFileSync(join(fixture, 'node_modules', 'pkg', 'x.js'), 'x', 'utf8');
    const big = join(fixture, 'src', 'big.log');
    writeFileSync(big, Buffer.alloc(64), 'utf8');
    // Windows 文件符号链接需特权；目录 junction 同为 reparse point（isSymbolicLink=true），
    // 走同一「不跟随外部链接」分支（§6.3）。
    symlinkSync(join(fixture, 'src', 'deep'), join(fixture, 'src_link'), 'junction');

    const r = buildBaselineManifest(fixture, { perFileMaxBytes: 32, totalMaxBytes: 1024, maxEntries: 100 }, 12345);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value;
    expect(m.kind).toBe('plain');
    // 包含 note.md（真实内容 hash）
    expect(m.entries.map((e) => e.path)).toContain('src/deep/note.md');
    const note = m.entries.find((e) => e.path === 'src/deep/note.md')!;
    expect(note.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 排除项
    const reasons = new Map(m.excluded.map((e) => [e.path, e.reason]));
    expect(reasons.get('node_modules')).toBe('excluded_dir');
    expect(reasons.get('.env')).toBe('credential_like');
    expect(reasons.get('src/data.bin')).toBe('binary');
    expect(reasons.get('src/big.log')).toBe('oversize_file');
    expect(reasons.get('src_link')).toBe('symlink');
    expect(m.createdAt).toBe(12345);
  });

  it('Git 目录：kind=git 并记录 HEAD（读 .git 文件，不依赖 git 二进制）', () => {
    const repo = join(tmpRoot, 'git-fixture');
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), '0123456789abcdef0123456789abcdef01234567\n', 'utf8');
    writeFileSync(join(repo, 'readme.md'), '# R\n', 'utf8');

    const r = buildBaselineManifest(repo, {}, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('git');
    expect(r.value.git).toEqual({ head: '0123456789abcdef0123456789abcdef01234567', branch: 'main' });
  });

  it('清单落盘 + baselines 行；同内容 hash 稳定', () => {
    const fixture = join(tmpRoot, 'baseline-fixture');
    const m1 = buildBaselineManifest(fixture, { perFileMaxBytes: 32, totalMaxBytes: 1024 }, 1);
    const m2 = buildBaselineManifest(fixture, { perFileMaxBytes: 32, totalMaxBytes: 1024 }, 1);
    if (!m1.ok || !m2.ok) throw new Error('manifest 失败');
    const storageDir = join(tmpRoot, 'baselines');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
                VALUES ('p_dev04', '基线测试', 'D:/bl', 'D:/bl', '{}', 0)`).run();
    const r1 = createBaselineRecord(db, { projectId: 'p_dev04', manifest: m1.value, taskRevision: 0, storageDir });
    const r2 = createBaselineRecord(db, { projectId: 'p_dev04', manifest: m2.value, taskRevision: 0, storageDir });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.manifestHash).toBe(r2.value.manifestHash);
      const written = JSON.parse(readFileSync(r1.value.manifestPath, 'utf8'));
      expect(written.schemaVersion).toBe(1);
      const row = db.prepare('SELECT manifest_hash, status FROM baselines WHERE id = ?').get(r1.value.baselineId);
      expect(row).toMatchObject({ manifest_hash: r1.value.manifestHash, status: 'ready' });
    }
  });
});
