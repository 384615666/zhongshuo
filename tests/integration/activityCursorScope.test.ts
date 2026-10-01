/**
 * Activity 稳定游标与可见项目范围（第三十一轮二）：
 * - 同毫秒多事件不漏：(created_at, seq) 双键决定性排序；before+beforeSeq 翻页连续无重无漏；
 * - nav.preferences：get（无偏好=allWhenNoPreference）/set 覆盖（未知项目拒绝）；
 * - 看板与 Activity 的 scope=all 按 visibleProjectIds 过滤（隐藏项目不进聚合面）；显式
 *   projectId 查询不受限（query≠visible 既定区别）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-actcur-'));
mkdirSync(tmpRoot, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } } });

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目一',?,?,'{}',0),('p2','项目二',?,?,'{}',0)`).run(tmpRoot, tmpRoot, tmpRoot, tmpRoot);
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: tmpRoot };
  const send = (method: string, params: unknown, commandId?: string) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `ac-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; data?: never; replayed?: boolean; error?: { code: string; message: string } }>;
  return { db, send, close: () => db.close() };
}

function seedEvent(db: ReturnType<typeof openDatabase>, eventId: string, projectId: string, at: number): void {
  db.prepare(`INSERT INTO domain_events (event_id, schema_version, project_id, kind, payload_json, created_at) VALUES (?,1,?,'message.submitted','{}',?)`).run(eventId, projectId, at);
}

describe('Activity 稳定游标', () => {
  it('同毫秒多事件：双键翻页连续无重无漏（确定性排序）', async () => {
    const env = makeEnv();
    const at = 1750000000000;
    for (let i = 0; i < 12; i += 1) seedEvent(env.db, `evt-same-ms-${String(i).padStart(2, '0')}`, 'p1', at); // 全部同毫秒
    seedEvent(env.db, 'evt-older', 'p1', at - 1000);
    const page1 = await env.send('activity.list', { scope: 'all', limit: 5 });
    const p1 = (page1.data as unknown as { items: Array<{ eventId: string; seq: number; at: number }> }).items;
    expect(p1.length).toBe(5);
    const seen = new Set(p1.map((i) => i.eventId));
    let last = p1[p1.length - 1]!;
    let total = p1.length;
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await env.send('activity.list', { scope: 'all', limit: 5, before: last.at, beforeSeq: last.seq });
      const items = (page.data as unknown as { items: Array<{ eventId: string; seq: number; at: number }> }).items;
      for (const it of items) {
        expect(seen.has(it.eventId), `重复：${it.eventId}`).toBe(false);
        seen.add(it.eventId);
      }
      total += items.length;
      if (items.length === 0) break;
      last = items[items.length - 1]!;
    }
    expect(total).toBe(13); // 12 同毫秒 + 1 更早——全部翻出（同毫秒不漏）
    env.close();
  }, 60_000);
});

describe('可见项目范围（scope=all ≠ 全部项目）', () => {
  it('nav.preferences get/set；隐藏项目不进看板/Activity 聚合面；显式查询不受限', async () => {
    const env = makeEnv();
    seedEvent(env.db, 'evt-vis-1', 'p1', 100);
    seedEvent(env.db, 'evt-vis-2', 'p2', 200);
    // 无偏好行：全量可见（向后兼容）。
    const before = await env.send('activity.list', { scope: 'all', limit: 10 });
    expect((before.data as unknown as { items: unknown[] }).items.length).toBe(2);
    const boardBefore = await env.send('board.view', { scope: 'all' });
    expect((boardBefore.data as unknown as { groups: unknown[] }).groups.length).toBe(2);
    // set：只保留 p1（隐藏 p2）。
    const set = await env.send('nav.preferences', { clientId: 'desktop-main', visibleProjectIds: ['p1'], activeProjectId: 'p1' });
    expect(set.ok).toBe(true);
    const after = await env.send('activity.list', { scope: 'all', limit: 10 });
    const items = (after.data as unknown as { items: Array<{ projectId: string }> }).items;
    expect(items.every((i) => i.projectId === 'p1')).toBe(true); // p2 事件不进聚合面
    const boardAfter = await env.send('board.view', { scope: 'all' });
    const groups = (boardAfter.data as unknown as { groups: Array<{ projectId: string }> }).groups;
    expect(groups.map((g) => g.projectId)).toEqual(['p1']);
    // 显式 projectId 查询（query 范围）不受可见集限制。
    const direct = await env.send('activity.list', { scope: 'project', projectId: 'p2', limit: 10 });
    expect((direct.data as unknown as { items: unknown[] }).items.length).toBe(1);
    const boardDirect = await env.send('board.view', { scope: 'project', projectId: 'p2' });
    expect((boardDirect.data as unknown as { groups: unknown[] }).groups.length).toBe(1);
    // 未知项目拒绝；读取回显。
    const bad = await env.send('nav.preferences', { clientId: 'desktop-main', visibleProjectIds: ['p1', 'pX'] });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('VALIDATION_INVALID');
    const got = await env.send('nav.preferences', { clientId: 'desktop-main' });
    const gd = got.data as unknown as { visibleProjectIds: string[]; activeProjectId: string | null };
    expect(gd.visibleProjectIds).toEqual(['p1']);
    expect(gd.activeProjectId).toBe('p1');
    env.close();
  }, 60_000);
});
