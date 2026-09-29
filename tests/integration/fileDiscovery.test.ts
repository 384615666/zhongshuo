/**
 * 项目范围文件发现清单（第七轮：回到既有授权合同——§13.4/§6.3/§13.2，零额度）：
 * - 共享源码默认可读：其他任务 applied 修改过的文件仍可见（不再按 change_sets 归属排除——
 *   归属是溯源维度不是可读性维度）；已撤销（reverted）改动集的文件按项目现状可见；
 * - §6.3 默认排除（命名清单制，不按 "." 前缀一刀切）：VCS 内部/依赖缓存/构建产物目录段
 *   + 常见凭据文件；.editorconfig/.gitignore/.env.example 等非凭据配置可见；
 * - 大小写/别名：Node_Modules/DIST/.ENV 等变体同等排除（Windows 大小写不敏感）；
 * - 上限按过滤后计数：排除项不占用合法文件名额（上限不被 node_modules 耗尽）；
 * - DIRECT 信封注入与 DELIB IND 首轮一致规则（清单入输入、hash 覆盖该事实）；
 * - 不夸大为文件沙箱认证（integrityNote 如实声明）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectScopedFileListing } from '../../src/daemon/fileDiscovery.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { seed as delibSeed, createDelibTask } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-file-disc-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeProjectDir(n: number | string): string {
  const dir = join(tmpRoot, `proj${n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedWithDir(db: ZhongshuoDatabase, dir: string): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(dir, dir);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

describe('项目范围授权清单（§13.4 项目源码默认可读 + §6.3 命名排除）', () => {
  it('共享源码与资料默认可见：含其他任务修改过的文件与已撤销改动集的文件（不再按 change_sets 归属排除）', () => {
    const dir = makeProjectDir(1);
    // 共享源码（任意任务曾修改——文件系统现状即授权面，§13.4 跨任务=同项目可分析同一代码）。
    writeFileSync(join(dir, 'src-main.ts'), '共享源码', 'utf8');
    writeFileSync(join(dir, 'other-task-edited.md'), '其他任务 applied 修改过的共享文档', 'utf8');
    writeFileSync(join(dir, 'reverted-change-file.md'), '已撤销改动集的 after 文件（撤销后仍在项目根=项目现状）', 'utf8');
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'app-week.log'), '本周日志', 'utf8');
    const listing = projectScopedFileListing(dir)!;
    expect(listing.files).toContain('src-main.ts');
    expect(listing.files).toContain('other-task-edited.md');
    expect(listing.files).toContain('reverted-change-file.md'); // 撤销后=项目现状，可见
    expect(listing.files).toContain('logs/app-week.log'); // 合法日志可发现（C 组修复目标）
    expect(listing.integrityNote).toContain('§13.4');
    expect(listing.integrityNote).toContain('不构成工具能力声明或文件沙箱认证'); // 不夸大
  });

  it('§6.3 默认排除：VCS 内部/依赖缓存/构建产物目录段+常见凭据；非凭据隐藏配置可见', () => {
    const dir = makeProjectDir(2);
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref', 'utf8');
    writeFileSync(join(dir, 'node_modules', 'some-pkg', 'index.js'), 'x', 'utf8');
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'x', 'utf8');
    // 凭据类（§6.3 常见凭据文件）。
    writeFileSync(join(dir, '.env'), 'SECRET=1', 'utf8');
    writeFileSync(join(dir, '.env.local'), 'SECRET=1', 'utf8');
    writeFileSync(join(dir, 'server.key'), 'PRIVATE', 'utf8');
    writeFileSync(join(dir, 'id_rsa'), 'PRIVATE', 'utf8');
    // 非凭据隐藏配置/文档惯例：可见（不按 "." 前缀一刀切）。
    writeFileSync(join(dir, '.editorconfig'), 'root=true', 'utf8');
    writeFileSync(join(dir, '.gitignore'), 'node_modules', 'utf8');
    writeFileSync(join(dir, '.env.example'), 'SECRET=', 'utf8');
    writeFileSync(join(dir, 'README.md'), '项目说明', 'utf8');
    const listing = projectScopedFileListing(dir)!;
    expect(listing.files).toContain('.editorconfig');
    expect(listing.files).toContain('.gitignore');
    expect(listing.files).toContain('.env.example'); // 文档惯例非凭据
    expect(listing.files).toContain('README.md');
    for (const f of listing.files) {
      expect(f.startsWith('.git/') || f.startsWith('node_modules/') || f.startsWith('dist/')).toBe(false);
      expect(['.env', '.env.local', 'server.key', 'id_rsa']).not.toContain(f);
    }
    expect(listing.excludedInternal).toBeGreaterThanOrEqual(6); // .git 在扫描层已跳过（不计入过滤计数）
    expect(listing.integrityNote).toContain('VCS 内部');
  });

  it('大小写/别名匹配：Node_Modules/BUILD/.ENV 同等排除（Windows 大小写不敏感）；正常文档可见', () => {
    const dir = makeProjectDir(3);
    mkdirSync(join(dir, 'Node_Modules'), { recursive: true });
    mkdirSync(join(dir, 'BUILD'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'Docs'), { recursive: true });
    writeFileSync(join(dir, 'Node_Modules', 'x.js'), 'x', 'utf8');
    writeFileSync(join(dir, 'BUILD', 'out.js'), 'x', 'utf8');
    writeFileSync(join(dir, 'dist', 'a.js'), 'x', 'utf8');
    writeFileSync(join(dir, '.ENV'), 'SECRET=1', 'utf8');
    writeFileSync(join(dir, 'Docs', 'guide.md'), '文档', 'utf8');
    const listing = projectScopedFileListing(dir)!;
    expect(listing.files).toEqual(['Docs/guide.md']); // 大小写变体同等排除
  });

  it('上限按过滤后计数：排除项不耗尽名额（旧实现会被 node_modules 耗尽）；截断如实标注', () => {
    const dir = makeProjectDir(4);
    mkdirSync(join(dir, 'node_modules', 'pkg-heavy'), { recursive: true });
    for (let i = 0; i < 240; i += 1) writeFileSync(join(dir, 'node_modules', 'pkg-heavy', `f${i}.js`), 'x', 'utf8');
    for (let i = 0; i < 30; i += 1) writeFileSync(join(dir, `legal-${i}.md`), '合法文件', 'utf8');
    const listing = projectScopedFileListing(dir, { maxEntries: 20 })!;
    expect(listing.files.length).toBe(20); // 全是合法文件——排除项没占名额
    expect(listing.files.every((f) => f.startsWith('legal-'))).toBe(true);
    expect(listing.truncated).toBe(true); // 合法文件 30>20——如实标注
    const full = projectScopedFileListing(dir, { maxEntries: 200 })!;
    expect(full.files.length).toBe(30);
    expect(full.truncated).toBe(false);
  });

  it('root 不存在 → null（不阻断组装）；空目录=合法空清单', () => {
    expect(projectScopedFileListing(join(tmpRoot, 'missing'))).toBeNull();
    const empty = makeProjectDir(5);
    const listing = projectScopedFileListing(empty)!;
    expect(listing.files).toEqual([]);
    expect(listing.truncated).toBe(false);
  });
});

describe('两模式输入链路一致（DIRECT 信封 + DELIB IND 首轮）', () => {
  it('DIRECT：bundle 文本含清单分节；信封 hash 覆盖该事实', async () => {
    const dir = makeProjectDir('p2');
    writeFileSync(join(dir, 'logs-app-week.log'), 'x', 'utf8');
    const db = openDatabase(':memory:');
    seedWithDir(db, dir);
    const ids = { messageId: 'fm1', threadId: 'fth1', taskId: 'ftk1', taskEventId: 'fe1', threadEventId: 'fh1' };
    createRoomRootTask(db, {
      ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
      title: 'T1', body: 'B1', mentions: [{ kind: 'member', memberId: 'mA' }],
      author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
      now: 1,
    });
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w-fd', appDataDir: join(tmpRoot, 'appdata') }).runOnce();
    expect(adapter.startTurnLog).toHaveLength(1);
    const text = adapter.startTurnLog[0]!.text;
    expect(text).toContain('文件发现（项目范围清单，程序侧提供）');
    expect(text).toContain('logs-app-week.log');
    expect(text).toContain('清单完整性');
    const env = JSON.parse((db.prepare('SELECT included_refs_json FROM context_bundles').get() as { included_refs_json: string }).included_refs_json);
    expect(env.fileDiscovery).toMatchObject({ policy: 'authorized-listing', truncated: false });
    await adapter.closeAllSessions();
    db.close();
  }, 15_000);

  it('DELIB：IND 输入含清单（分析入口一致规则）', async () => {
    const dir = makeProjectDir('p3');
    writeFileSync(join(dir, 'data.txt'), 'y', 'utf8');
    const db = openDatabase(':memory:');
    delibSeed(db, ['m1', 'm2']);
    db.prepare(`UPDATE projects SET canonical_path = ? WHERE id = 'p1'`).run(dir);
    createDelibTask(db, 7, ['m1', 'm2']);
    const adapter = new FakeRuntimeAdapter({
      turnScriptSequencer: (input) => (input.text.includes('INDEPENDENT') || input.text.includes('独立分析成员')
        ? [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: 'analysis-draft-v1', summary: 's', claims: [{ claimId: 'c1', statement: 'a', kind: 'fact', uncertainty: 'low' }] }) } }]
        : [{ kind: 'event', event: { kind: 'turn.completed', finalText: '{}' } }]),
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-fd2', enableDeliberate: true, appDataDir: join(tmpRoot, 'appdata2'), absenceToleranceMs: 200 });
    await worker.runOnce(); // PREPARE
    await worker.runOnce(); // IND 派发
    expect(adapter.startTurnLog.length).toBeGreaterThanOrEqual(1);
    const indText = adapter.startTurnLog[0]!.text;
    expect(indText).toContain('文件发现（项目范围清单，程序侧提供）');
    expect(indText).toContain('data.txt');
    await adapter.closeAllSessions();
    db.close();
  }, 20_000);
});
