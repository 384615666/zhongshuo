/**
 * 导出目标与完整性（第三十一轮一）：
 * - 线程归属：合法会话 A + 其他会话/项目线程 B → 整笔拒绝、零产物；
 * - 回执重放不绕过当前权限：上传/导出/提交在归档/audience 失效后重放同号同参=明确拒绝；
 *   同号同参未失效时仍回原结果、同号异参仍 IDEMPOTENCY_CONFLICT；
 * - 附件受控拷贝：副本改写（sha256 不符）与路径越出 blobstore=整笔失败清理（不当作正常
 *   随包副本）；复制期间引用版本变化=EXPORT_CONFLICT 清理；同内容多引用单随包文件；
 * - manifest 与最终 assets 字节一致（重算 sha256 对账）；system 消息保留「系统」来源；
 * - 预算：消息数超限 EXPORT_TOO_LARGE（提示收窄范围，不静默缩小）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { makeAsciiPdf } from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-exportint-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } } });

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目一', ?, ?, '{}',0)`).run(tmpRoot, tmpRoot);
  return { db };
}

/** 完整环境：两项目+房间/DM+两线程（跨会话/跨项目线程反例的舞台）。 */
function makeFullEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目一',?,?,'{}',0),('p2','项目二',?,?,'{}',0)`).run(join(tmpRoot, 'pa'), join(tmpRoot, 'pa'), join(tmpRoot, 'pb'), join(tmpRoot, 'pb'));
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','房间','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL),('dm_b','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA'),('p1','dm_b','human','u_other'),('p1','dm_b','agent','mA')`).run();
  db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, root_task_id, last_message_seq) VALUES ('th_a','p1','dm_a','r1','anc_a',NULL,0),('th_b','p1','dm_b','r1','anc_b',NULL,0)`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const send = (method: string, params: unknown, commandId?: string) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `ei-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; data?: never; replayed?: boolean; error?: { code: string; message: string } }>;
  return { db, send, close: () => db.close() };
}

const exportsDir = join(appData, 'exports');
const exportCount = (): number => { try { return readdirSync(exportsDir).length; } catch { return 0; } };

describe('导出线程归属（合法会话 A + 线程 B）', () => {
  it('跨会话线程/跨项目线程整笔拒绝零产物', async () => {
    const env = makeFullEnv();
    // dm_a 放一条消息；th_b 属 dm_b（本人不可见）——用「合法 dm_a + 线程 th_b」请求导出。
    env.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES ('m1','p1','dm_a',1,'human','u_local',?,'saved',1)`).run(JSON.stringify({ text: '归属反例 A' }));
    const before = exportCount();
    const crossConv = await env.send('export.create', { target: { kind: 'thread', projectId: 'p1', conversationId: 'dm_a', threadId: 'th_b' }, format: 'md' });
    expect(crossConv.ok).toBe(false);
    expect(crossConv.error?.code).toBe('CONVERSATION_SCOPE_MISMATCH');
    const crossProj = await env.send('export.create', { target: { kind: 'thread', projectId: 'p2', conversationId: 'dm_a', threadId: 'th_a' }, format: 'md' });
    expect(crossProj.ok).toBe(false);
    expect(crossProj.error?.code).toBe('CONVERSATION_SCOPE_MISMATCH');
    // 线程消息也只取本会话内的（th_a 归属 dm_a——成功路径可导）。
    env.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES ('m2','p1','dm_a',2,'th_a',1,'human','u_local',?,'saved',2)`).run(JSON.stringify({ text: '线程内消息 OK-TH-331' }));
    env.db.prepare(`UPDATE conversation_threads SET last_message_seq = 1 WHERE id = 'th_a'`).run();
    const ok = await env.send('export.create', { target: { kind: 'thread', projectId: 'p1', conversationId: 'dm_a', threadId: 'th_a' }, format: 'md' });
    expect(ok.ok).toBe(true);
    expect((ok.data as unknown as { stats: { messages: number } }).stats.messages).toBe(1); // 只有线程内消息
    expect(exportCount()).toBe(before + 1); // 拒绝两次零产物，成功恰一目录
    env.close();
  }, 60_000);
});

describe('回执重放不绕过当前权限', () => {
  it('上传：归档后重放同号同参=CONVERSATION_ARCHIVED（不回旧结果）', async () => {
    const env = makeFullEnv();
    const commandId = `up-${randomUUID().slice(0, 8)}`;
    const pdf = makeAsciiPdf([['重放暗号 REPLAY-UP-651']]).toString('base64');
    const first = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '重放件.pdf', contentBase64: pdf }, commandId);
    expect(first.ok).toBe(true);
    env.db.prepare(`UPDATE conversations SET archived_at = 12345 WHERE id = 'dm_a'`).run();
    const replay = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '重放件.pdf', contentBase64: pdf }, commandId);
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe('CONVERSATION_ARCHIVED');
    env.close();
  }, 60_000);
  it('提交：DM 归档后重放 message.submit 同号同参=拒绝；未失效时同号同参原结果、同号异参冲突', async () => {
    const env = makeFullEnv();
    const commandId = `sub-${randomUUID().slice(0, 8)}`;
    const params = { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '重放提交 REPLAY-SUB-774', intent: 'record_only', mentions: [] };
    const first = await env.send('message.submit', params, commandId);
    expect(first.ok).toBe(true);
    const same = await env.send('message.submit', params, commandId);
    expect(same.replayed).toBe(true); // 未失效：同号同参原结果
    expect(((same.data ?? first.data) as unknown as { messageId: string }).messageId).toBe(((first.data) as unknown as { messageId: string }).messageId);
    const conflict = await env.send('message.submit', { ...params, body: '异参' }, commandId);
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    env.db.prepare(`UPDATE conversations SET archived_at = 12345 WHERE id = 'dm_a'`).run();
    const after = await env.send('message.submit', params, commandId);
    expect(after.ok).toBe(false);
    expect(after.error?.code).toBe('CONVERSATION_ARCHIVED'); // 重放守卫拒绝
    env.close();
  }, 60_000);
  it('导出：audience 失效（本人被移出 DM 参与者）后重放同号同参=FORBIDDEN', async () => {
    const env = makeFullEnv();
    env.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES ('m1','p1','dm_a',1,'human','u_local',?,'saved',1)`).run(JSON.stringify({ text: '导出重放 REPLAY-EXP-887' }));
    const commandId = `exp-${randomUUID().slice(0, 8)}`;
    const params = { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' };
    const first = await env.send('export.create', params, commandId);
    expect(first.ok).toBe(true);
    env.db.prepare(`DELETE FROM dm_participants WHERE conversation_id = 'dm_a' AND principal_id = 'u_local'`).run(); // 访问失效
    const replay = await env.send('export.create', params, commandId);
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe('FORBIDDEN');
    env.close();
  }, 60_000);
});

describe('附件受控拷贝与清单', () => {
  it('副本改写（sha256 不符）=整笔失败清理零产物', async () => {
    const env = makeFullEnv();
    const up = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '改写件.pdf', contentBase64: makeAsciiPdf([['改写前暗号 REWRITE-BEFORE-113']]).toString('base64') });
    expect(up.ok).toBe(true);
    const attachmentId = (up.data as unknown as { attachmentId: string }).attachmentId;
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '含改写附件', intent: 'record_only', mentions: [], attachmentRefs: [attachmentId] });
    const blobPath = (env.db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(attachmentId) as { blob_path: string }).blob_path;
    const before = exportCount();
    writeFileSync(blobPath, Buffer.from('被改写的伪造内容——hash 必不符')); // 副本改写
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('EXPORT_ATTACHMENT_INTEGRITY');
    expect(exportCount()).toBe(before); // 半截产物已清理（零新增目录）
    env.close();
  }, 60_000);
  it('blob_path 越出 blobstore（记录被改）=整笔失败', async () => {
    const env = makeFullEnv();
    const up = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '越界件.pdf', contentBase64: makeAsciiPdf([['越界暗号 OOS-224']]).toString('base64') });
    const attachmentId = (up.data as unknown as { attachmentId: string }).attachmentId;
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '含越界附件', intent: 'record_only', mentions: [], attachmentRefs: [attachmentId] });
    const outside = join(tmpRoot, 'outside-store.bin');
    writeFileSync(outside, Buffer.from('越界路径的内容'));
    env.db.prepare(`UPDATE artifacts SET blob_path = ? WHERE id = ?`).run(outside, attachmentId);
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('EXPORT_ATTACHMENT_INTEGRITY'); // 不当作正常随包副本
    expect(r.error?.message).toContain('越出托管存储');
    env.close();
  }, 60_000);
  it('复制期间引用版本变化（revision 前进）=EXPORT_CONFLICT 清理', async () => {
    const env = makeFullEnv();
    const up = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '版本件.pdf', contentBase64: makeAsciiPdf([['版本暗号 VER-339']]).toString('base64') });
    const attachmentId = (up.data as unknown as { attachmentId: string }).attachmentId;
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '含版本附件', intent: 'record_only', mentions: [], attachmentRefs: [attachmentId] });
    const before = exportCount();
    (globalThis as { __zsTestExportHook?: () => void }).__zsTestExportHook = () => {
      env.db.prepare(`UPDATE artifacts SET revision = revision + 1 WHERE id = ?`).run(attachmentId); // 拷贝后/复核前：引用版本前进
    };
    try {
      const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('EXPORT_CONFLICT');
      expect(exportCount()).toBe(before); // 半截产物清理
    } finally {
      delete (globalThis as { __zsTestExportHook?: () => void }).__zsTestExportHook;
    }
    env.close();
  }, 60_000);
  it('同内容多引用=单随包文件；manifest 与最终字节一致；system 消息保留系统来源', async () => {
    const env = makeFullEnv();
    const content = makeAsciiPdf([['同内容暗号 SAME-HASH-456']]).toString('base64');
    const up1 = await env.send('attachment.uploadPdf', { conversationId: 'dm_a', filename: '同内容一.pdf', contentBase64: content });
    const id1 = (up1.data as unknown as { attachmentId: string }).attachmentId;
    // 同会话同 hash 去重（既定行为）：第二个不同名上传返回同一 artifact 行——两条消息引用
    // 同一资源=同内容多引用。
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '第一条引用', intent: 'record_only', mentions: [], attachmentRefs: [id1] });
    await env.send('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '第二条引用同一内容', intent: 'record_only', mentions: [], attachmentRefs: [id1] });
    env.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES ('m_sys','p1','dm_a',3,'system','sys',?,'saved',3)`).run(JSON.stringify({ text: '系统级事件说明 SYSTEM-SRC-902' }));
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'html' });
    expect(r.ok).toBe(true);
    const data = r.data as unknown as { dir: string; manifest: { files: Array<{ file: string; bytes: number; sha256: string }> } };
    expect(data.manifest.files.length).toBe(1); // 同内容多引用=单随包文件
    const assetsOnDisk = readdirSync(join(data.dir, 'assets'));
    expect(assetsOnDisk.length).toBe(1);
    // manifest 与最终 assets 字节一致：重算 sha256 对账。
    for (const f of data.manifest.files) {
      const raw = readFileSync(join(data.dir, f.file.replaceAll('/', String.fromCharCode(92))));
      expect(raw.length).toBe(f.bytes);
      expect(createHash('sha256').update(raw).digest('hex')).toBe(f.sha256);
    }
    const html = readFileSync(join(data.dir, 'index.html'), 'utf8');
    expect(html).toContain('系统'); // system 消息来源保留（非「成员」标注）
    expect(html).toContain('SYSTEM-SRC-902');
    expect(html).not.toMatch(/系统.*[af0-9]{8}…/); // system 行不带用户/成员 ID 尾缀
    env.close();
  }, 120_000);
});

describe('导出预算', () => {
  it('消息数超上限=EXPORT_TOO_LARGE 明确失败（不静默缩小范围）', async () => {
    const env = makeFullEnv();
    const ins = env.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, status, created_at) VALUES (?, 'p1','dm_a',?, 'human','u_local', ?, 'saved', ?)`);
    for (let i = 0; i < 2005; i += 1) ins.run(`m_${i}`, i + 1, JSON.stringify({ text: `消息 ${i}` }), i + 1);
    const r = await env.send('export.create', { target: { kind: 'conversation', projectId: 'p1', conversationId: 'dm_a' }, format: 'md' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('EXPORT_TOO_LARGE');
    expect(r.error?.message).toContain('收窄范围');
    env.close();
  }, 60_000);
});

void makeEnv;
