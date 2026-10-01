/**
 * PDF 上传幂等与缓存完整性（第二十九轮二）：
 * - 缓存 schema v2 严格字段（parserName/parserVersion/budgets/页码连续/bytes）；
 * - 幂等三层：同 commandId 回执预查（重放不重复解析）/同会话同 hash 去重（不新建记录）/
 *   跨会话同 hash 缓存复用（独立 audience 各建行、不重复解析——以解析池 completed 计数为证）；
 * - 解析期间归档 → 事务内重检失败，不留 artifact/缓存/错误关联；
 * - 缓存损坏/版本不符 → 预览侧按需隔离重提（回写有效缓存）；原件缺失 → 明确失败；
 * - 同 commandId 异参 → IDEMPOTENCY_CONFLICT。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { getParsePool, disposeParsePool } from '../../src/daemon/parsePool.ts';
import { makeAsciiPdf } from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;
process.env.ZS_TEST_PARSE_HOOKS = '1';
delete process.env.ZS_TEST_PARSE_BUSY_MS;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-pdfcache-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(async () => {
  delete process.env.ZS_TEST_PARSE_BUSY_MS;
  await disposeParsePool();
  for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } }
});

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL),('dm_b','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA'),('p1','dm_b','human','u_local'),('p1','dm_b','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `pc-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw Object.assign(new Error(r.error?.message ?? 'error'), { code: r.error?.code });
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown, commandId?: string) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `pc-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; replayed?: boolean; error?: { code: string; message: string } };
  return { db, cmd, cmdRaw, close: () => db.close() };
}

describe('PDF 上传幂等三层 + 缓存 schema v2', () => {
  it('缓存 schema v2 严格字段；同会话去重/跨会话复用/重放都不再解析（completed 计数为证）', async () => {
    const env = makeEnv();
    const pdfBytes = makeAsciiPdf([[`幂等样本 ${randomUUID().slice(0, 6)}`, 'CACHE-V2-8899'], ['第二页 尾注']]);
    const up1 = await env.cmd<{ attachmentId: string; hash: string; pages: number }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '幂等.pdf', contentBase64: pdfBytes.toString('base64') });
    expect(up1.pages).toBe(2);
    const cacheRaw = (env.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id = ?').get(up1.attachmentId) as { extracted_text_json: string }).extracted_text_json;
    const cache = JSON.parse(cacheRaw) as { cacheSchema: number; kind: string; parserName: string; parserVersion: string; budgets: Record<string, number>; pages: Array<{ page: number; bytes: number; text: string; truncated: boolean }>; totalTextBytes: number };
    expect(cache.cacheSchema).toBe(2);
    expect(cache.parserName).toBe('pdfjs-dist');
    expect(cache.parserVersion).toMatch(/^\d/);
    expect(cache.budgets).toEqual({ pageText: 65536, totalText: 524288 });
    expect(cache.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(cache.pages[0]!.bytes).toBeGreaterThan(0);
    const completed0 = getParsePool().stats().completed;
    // ② 同会话同 hash（新 commandId）→ deduped，不新建记录、不再解析。
    const up2 = await env.cmd<{ attachmentId: string; deduped: boolean }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '重传同份.pdf', contentBase64: pdfBytes.toString('base64') });
    expect(up2.deduped).toBe(true);
    expect(up2.attachmentId).toBe(up1.attachmentId);
    expect((env.db.prepare("SELECT count(*) c FROM artifacts WHERE hash = ?").get(up1.hash) as { c: number }).c).toBe(1);
    expect(getParsePool().stats().completed).toBe(completed0);
    // ③ 跨会话同 hash → 独立 audience 新行 + 缓存复用（completed 仍不增）。
    const upB = await env.cmd<{ attachmentId: string; pages: number }>('attachment.uploadPdf', { conversationId: 'dm_b', filename: '另一会话同内容.pdf', contentBase64: pdfBytes.toString('base64') });
    expect(upB.attachmentId).not.toBe(up1.attachmentId);
    expect((env.db.prepare("SELECT count(*) c FROM artifacts WHERE hash = ?").get(up1.hash) as { c: number }).c).toBe(2);
    expect(getParsePool().stats().completed).toBe(completed0); // 未重复解析
    const cacheB = (env.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id = ?').get(upB.attachmentId) as { extracted_text_json: string }).extracted_text_json;
    expect(cacheB).toBe(cacheRaw); // 缓存原样复用（hash 绑定内容，不随 audience 变）
    // ① 同 commandId 重放：不重复解析不重复建记录。
    const replayId = `replay-${randomUUID().slice(0, 8)}`;
    const first = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '重放.pdf', contentBase64: pdfBytes.toString('base64') }, replayId);
    expect(first.replayed).not.toBe(true); // 新 commandId=正常去重路径
    const replay = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '重放.pdf', contentBase64: pdfBytes.toString('base64') }, replayId);
    expect(replay.replayed).toBe(true);
    expect(getParsePool().stats().completed).toBe(completed0);
    // 同 commandId 异参 → 幂等冲突。
    const conflict = await env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '别的.pdf', contentBase64: makeAsciiPdf([['不同内容']]).toString('base64') }, replayId);
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    env.close();
  }, 60_000);
  it('解析期间归档 → 事务内重检失败：不留 artifact/缓存/错误关联', async () => {
    const env = makeEnv();
    const pdfBytes = makeAsciiPdf([[`归档竞态 ${randomUUID().slice(0, 6)}`, 'ARCHIVE-RACE-3311']]);
    const hash = (await import('node:crypto')).createHash('sha256').update(pdfBytes).digest('hex');
    process.env.ZS_TEST_PARSE_BUSY_MS = '1200';
    try {
      const pending = env.cmdRaw('attachment.uploadPdf', { conversationId: 'dm_a', filename: '竞态.pdf', contentBase64: pdfBytes.toString('base64') });
      await new Promise((r) => setTimeout(r, 250)); // 解析已开始（子进程忙）
      env.db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), 'dm_a');
      const r = await pending;
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('CONVERSATION_ARCHIVED');
      expect((env.db.prepare('SELECT count(*) c FROM artifacts WHERE hash = ?').get(hash) as { c: number }).c).toBe(0); // 不留记录
    } finally {
      delete process.env.ZS_TEST_PARSE_BUSY_MS;
    }
    env.close();
  }, 60_000);
});

describe('PDF 预览：缓存损坏重提/原件缺失', () => {
  it('缓存损坏（非法 JSON/旧 schema）→ 隔离重提回写有效缓存；原件缺失 → 明确失败', async () => {
    const env = makeEnv();
    const pdfBytes = makeAsciiPdf([['重提样本 REEXTRACT-5566']]);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '重提.pdf', contentBase64: pdfBytes.toString('base64') });
    const completed0 = getParsePool().stats().completed;
    env.db.prepare('UPDATE artifacts SET extracted_text_json = ? WHERE id = ?').run('not-json{broken', up.attachmentId);
    const pv = await env.cmd<{ text: string; page: number }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pv.text).toContain('REEXTRACT-5566'); // 重提成功
    expect(getParsePool().stats().completed).toBe(completed0 + 1); // 确实重解析了一次（损坏不虚构）
    const cacheAfter = JSON.parse((env.db.prepare('SELECT extracted_text_json FROM artifacts WHERE id = ?').get(up.attachmentId) as { extracted_text_json: string }).extracted_text_json) as { cacheSchema: number };
    expect(cacheAfter.cacheSchema).toBe(2); // 回写有效缓存
    // 旧 schema（v1 形态）同样判无效 → 重提。
    env.db.prepare('UPDATE artifacts SET extracted_text_json = ? WHERE id = ?').run(JSON.stringify({ sourceHash: 'x', pages: [], extractedAt: 0 }), up.attachmentId);
    const pv2 = await env.cmd<{ text: string }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pv2.text).toContain('REEXTRACT-5566');
    // 原件缺失 → 明确失败（不虚构缓存可用）。
    const blobPath = (env.db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(up.attachmentId) as { blob_path: string }).blob_path;
    rmSync(blobPath, { force: true });
    const missing = await env.cmdRaw('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('STORAGE_UNAVAILABLE');
    env.close();
  }, 60_000);
  it('previewPdf 返回视觉渲染渠道与解析器身份（renderer-canvas）', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadPdf', { conversationId: 'dm_a', filename: '身份.pdf', contentBase64: makeAsciiPdf([['身份样本 VCHANNEL-1']]).toString('base64') });
    const pv = await env.cmd<{ pixelRendering: string; parser: string; bytesBase64?: string }>('attachment.previewPdf', { attachmentId: up.attachmentId, includeBytes: true });
    expect(pv.pixelRendering).toBe('renderer-canvas');
    expect(pv.parser).toContain('pdfjs-dist@');
    expect(typeof pv.bytesBase64).toBe('string');
    const pvNoBytes = await env.cmd<{ bytesBase64?: string }>('attachment.previewPdf', { attachmentId: up.attachmentId });
    expect(pvNoBytes.bytesBase64).toBeUndefined(); // 默认不带原件（翻页走渲染器缓存）
    writeFileSync(join(tmpRoot, 'probe.txt'), 'ok'); // tmpRoot 清理探针
    env.close();
  }, 60_000);
});
