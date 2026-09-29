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
    const capped = authorizedFileListing(dir, 1)!;
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
