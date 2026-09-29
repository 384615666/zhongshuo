/**
 * 文件发现能力（第六轮，后续版本——两模式一致规则）：
 * - DIRECT 信封注入经授权清单（排除 .git、截断/破口如实、渲染分节可见、hash 覆盖该事实）；
 * - DELIB IND 首轮输入含同款清单（分析入口一致）；CR 阶段不注入（各阶段材料由冻结清单承担）；
 * - 清单只含项目根内文件（不暴露其他任务/评分答案/越界链接——扫描物理拒绝沿用）；
 * - root 不存在/不可读 → 不加键不阻断派发。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { authorizedFileListing } from '../../src/daemon/fileDiscovery.ts';
import { seed as delibSeed, createDelibTask } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-file-disc-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seedWithDir(db: ZhongshuoDatabase, dir: string): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d',?,?, '{}', 0)`).run(dir, dir);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

function makeDirectTask(db: ZhongshuoDatabase, n: number): void {
  createRoomRootTask(db, {
    ids: { messageId: `fm${n}`, threadId: `fth${n}`, taskId: `ftk${n}`, taskEventId: `fe${n}`, threadEventId: `fh${n}` },
    projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: n,
  });
}

describe('经授权文件发现清单（两模式一致规则）', () => {
  it('authorizedFileListing：排除 .git、截断如实、完整性注记；root 不存在返回 null', () => {
    const dir = join(tmpRoot, 'proj1');
    mkdirSync(join(dir, 'sub', '.git'), { recursive: true });
    writeFileSync(join(dir, 'notes.md'), 'a', 'utf8');
    writeFileSync(join(dir, 'sub', 'app-week.log'), 'b', 'utf8');
    writeFileSync(join(dir, 'sub', '.git', 'HEAD'), 'c', 'utf8');
    const listing = authorizedFileListing(dir)!;
    expect(listing.policy).toBe('authorized-listing');
    expect(listing.files.sort()).toEqual(['notes.md', 'sub/app-week.log']); // C 组文件名现在可发现
    expect(listing.truncated).toBe(false);
    expect(listing.integrityNote).toContain('扫描完整');
    const capped = authorizedFileListing(dir, { maxEntries: 1 })!;
    expect(capped.truncated).toBe(true); // 上限如实
    expect(authorizedFileListing(join(tmpRoot, 'missing-dir'))).toBeNull(); // 不存在不阻断
  });

  it('DIRECT：bundle 文本含清单分节；信封 hash 覆盖该事实（清单变更=不同输入）', async () => {
    const dir = join(tmpRoot, 'proj2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'logs-app-week.log'), 'x', 'utf8');
    const db = openDatabase(':memory:');
    seedWithDir(db, dir);
    makeDirectTask(db, 1);
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w-fd', appDataDir: join(tmpRoot, 'appdata') }).runOnce();
    expect(adapter.startTurnLog).toHaveLength(1);
    const text = adapter.startTurnLog[0]!.text;
    expect(text).toContain('文件发现（经授权的清单，程序侧提供）');
    expect(text).toContain('logs-app-week.log');
    expect(text).toContain('清单完整性');
    const env = JSON.parse((db.prepare('SELECT included_refs_json FROM context_bundles').get() as { included_refs_json: string }).included_refs_json);
    expect(env.fileDiscovery).toMatchObject({ policy: 'authorized-listing', truncated: false });
    await adapter.closeAllSessions();
    db.close();
  }, 15_000);

  it('DELIB：IND 输入含清单（分析入口一致规则）；root 缺失不阻断（无清单仍派发）', async () => {
    const dir = join(tmpRoot, 'proj3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data.txt'), 'y', 'utf8');
    const db = openDatabase(':memory:');
    // 复用 deliberationFlow 的研讨种子 + 项目目录指向真实 dir。
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
    expect(indText).toContain('文件发现（经授权的清单，程序侧提供）');
    expect(indText).toContain('data.txt');
    await adapter.closeAllSessions();
    db.close();
  }, 20_000);
});

describe('文件清单任务授权过滤（第六轮·下：物理边界≠可读范围）', () => {
  it('其他任务变更归属与隐藏项不入清单与模型输入；本任务自己的变更可见；越界/截断如实', async () => {
    const dir = join(tmpRoot, 'proj-scope');
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'app-week.log'), '本周日志', 'utf8');
    writeFileSync(join(dir, '.secret-config'), '内部配置', 'utf8');
    writeFileSync(join(dir, 'taskX-output.md'), '其他任务的产物', 'utf8');
    writeFileSync(join(dir, 'mine-output.md'), '本任务自己的产物', 'utf8');
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('pS','s',?,?, '{}', 0)`).run(dir, dir);
    // 任务 X 曾修改 taskX-output.md（change_sets 归属=taskX，after=present）——本任务（taskY）不可见。
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mS','pS','甲','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','pS','大厅','mS')`).run();
    db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mS')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('cS','pS','room','r1')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title) VALUES ('taskX','pS','cS','room_task','r1','X')`).run();
        db.prepare(`INSERT INTO change_sets (id, project_id, task_id, before_ref, after_ref, application_status) VALUES ('csX','pS','taskX','{}','{"k":1}','applied')`).run();
    db.prepare(`INSERT INTO change_set_files (change_set_id, role, path, state) VALUES ('csX','after','taskX-output.md','present')`).run();
    db.prepare(`INSERT INTO change_set_files (change_set_id, role, path, state) VALUES ('csX','before','taskX-output.md','present')`).run();
    // 本任务自己的归属不排除（csY 归 taskY2——先建任务行再挂归属）。
    createRoomRootTask(db, {
      ids: { messageId: 'sm1', threadId: 'sth1', taskId: 'taskY2', taskEventId: 'se1', threadEventId: 'sh1' },
      projectId: 'pS', conversationId: 'cS', roomId: 'r1', intent: 'default',
      title: '分析日志', body: '分析 logs 一周日志', mentions: [{ kind: 'member', memberId: 'mS' }],
      author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mS', frozenMemberIds: ['mS'], initialWakeMemberIds: ['mS'] },
      now: 1,
    });
    db.prepare(`INSERT INTO change_sets (id, project_id, task_id, before_ref, after_ref, application_status) VALUES ('csY','pS','taskY2','{}','{"k":1}','applied')`).run();
    db.prepare(`INSERT INTO change_set_files (change_set_id, role, path, state) VALUES ('csY','after','mine-output.md','present')`).run();

    const { taskScopedFileListing } = await import('../../src/daemon/fileDiscovery.ts');
    const listing = taskScopedFileListing(db, 'pS', 'taskY2', dir)!;
    expect(listing.files.sort()).toEqual(['logs/app-week.log', 'mine-output.md']); // taskX-output.md 不在
    expect(listing.excludedOtherTask).toBe(1);
    expect(listing.excludedHidden).toBeGreaterThanOrEqual(1); // .secret-config 排除
    expect(listing.integrityNote).toContain('其他任务变更归属 1 项');
    expect(listing.integrityNote).toContain('不构成工具能力声明或文件沙箱认证');

    // DIRECT 组装真实路径：本任务输入只含授权清单（其他任务产物不进模型输入）。
    const adapter = new FakeRuntimeAdapter();
    const w = new DispatchWorker({ db, adapter, leaseOwner: 'w-scope', appDataDir: join(tmpRoot, 'app-scope') });
    await w.runOnce();
    const text = adapter.startTurnLog[0]!.text;
    expect(text).toContain('logs/app-week.log'); // 允许文件可发现（C 组场景修复）
    expect(text).toContain('mine-output.md');
    expect(text).not.toContain('taskX-output.md'); // 其他任务产物不入模型输入
    expect(text).not.toContain('.secret-config'); // 隐藏项不入输入
    await adapter.closeAllSessions();
    db.close();
  }, 20_000);
});
