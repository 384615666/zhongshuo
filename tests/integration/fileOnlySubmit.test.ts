/**
 * R66 P3/P2/P5 合同测试（用户已批准决定：只有文件也沿用当前模式——默认发 AI，仅记录只保存）。
 * 覆盖：
 *  ① room_root / dm 文件-only 发送：空正文+就绪附件 → 消息落库（body 空）、任务标题=📎 文件名
 *     （不合成假正文）；AI 意图建任务/仅记录零任务零派发键。
 *  ② 真正空白（无正文且无附件）→ VALIDATION_INVALID（不静默、不占位正文）。
 *  ③ 图片门空正文：仅图片附件+「仅发送文字」+空正文 → EMPTY_MODEL_INPUT（不得形成空模型输入）；
 *     加一段正文后同参数通过（有可用文字）。
 *  ④ attachment.readFull：全文无截断（>64KB 文本尾部可读——与提取窗分列）；originalFile：
 *     原件字节 sha256==记录 hash（文本类 .txt）。
 *  ⑤ member.runtime effective：未绑定成员 source='global-default'（ZS_RUNTIME 语义）；
 *     绑定后 source='binding'。
 * fake runtime 零真实调用。
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { randomUUID } from 'node:crypto';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-fileonly-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄释放重试 */ } } });

let savedRuntime: string | undefined;
beforeAll(() => { savedRuntime = process.env.ZS_RUNTIME; process.env.ZS_RUNTIME = 'claude'; });
afterAll(() => { if (savedRuntime == null) delete process.env.ZS_RUNTIME; else process.env.ZS_RUNTIME = savedRuntime; });

const deps = { db: openDatabase(':memory:'), localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: tmpRoot } as never extends never ? { db: ZhongshuoDatabase; localUserId: string; interruptTurn: () => Promise<void>; appDataDir: string } : never;
const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
  const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `fo-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message);
  return r.data as T;
};
const raw = async (method: string, params: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }> =>
  dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `fo-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; error?: { code: string; message: string } }>;

const db = (deps as { db: ZhongshuoDatabase }).db;
db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目甲',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1),('mB','p1','Agent乙','agent',1)`).run();
db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();

describe('R66 P3：只有文件也能发送（用户已批准语义）', () => {
  it('① room_root 文件-only：AI 意图建任务+标题=📎 文件名；仅记录零任务', async () => {
    const up = await cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'conv_room', filename: '说明.md', content: '# 标题\n\n仅文件发送正文为空' });
    const up2 = await cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'conv_room', filename: '数据.csv', content: 'a,b\n1,2' });
    // AI 意图：空正文 + 两份就绪附件 → 可发送；任务标题按文件名推导（不合成假正文）。
    const s = await cmd<{ messageId: string; taskId: string | null }>('message.submit', {
      target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' },
      body: '', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId, up2.attachmentId],
    });
    expect(s.taskId).toBeTruthy();
    const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(s.taskId!) as { title: string };
    expect(task.title).toContain('📎');
    expect(task.title).toContain('说明.md');
    expect(task.title).toContain('数据.csv');
    const msg = db.prepare('SELECT body_json FROM messages WHERE id = ?').get(s.messageId) as { body_json: string };
    expect((JSON.parse(msg.body_json) as { text: string }).text).toBe(''); // 正文如实为空——不占位
    const refs = db.prepare('SELECT COUNT(*) c FROM message_attachments WHERE message_id = ?').get(s.messageId) as { c: number };
    expect(refs.c).toBe(2);
    // 消息-附件关联存在（无任务线程锚消息同样携带）。
    // 仅记录：零任务零派发键。
    const r0 = await cmd<{ messageId: string; taskId: string | null }>('message.submit', {
      target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' },
      body: '', intent: 'record_only', mentions: [], attachmentRefs: [up.attachmentId],
    });
    expect(r0.taskId).toBeNull();
  });

  it('② 真正空白拒绝：无正文且无附件（含纯空白正文）', async () => {
    const e1 = await raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '', intent: 'default', mentions: [] });
    expect(e1.ok).toBe(false);
    expect(e1.error?.message).toMatch(/正文与附件不能同时为空/);
    const e2 = await raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '   \n ', intent: 'default', mentions: [] });
    expect(e2.ok).toBe(false);
  });

  it('③ 图片门空正文：仅图片+仅发送文字 → EMPTY_MODEL_INPUT；有文字则通过', async () => {
    // 1×1 PNG（magic/尺寸合法）。
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    const dm = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const img = await cmd<{ attachmentId: string }>('attachment.uploadImage', { conversationId: dm.conversationId, filename: '图.png', contentBase64: png.toString('base64') });
    const blocked = await raw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body: '', intent: 'default', mentions: [], attachmentRefs: [img.attachmentId], imageAck: 'omit-images' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toMatch(/EMPTY_MODEL_INPUT/);
    // 加一段正文后同参数通过（有可用文字）。
    const ok = await cmd<{ messageId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body: '看这张图说明什么', intent: 'default', mentions: [], attachmentRefs: [img.attachmentId], imageAck: 'omit-images' });
    expect(ok.messageId).toBeTruthy();
    // dm 文件-only（非图片）：空正文+就绪文本附件 → 建任务+标题推导。
    const txt = await cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: dm.conversationId, filename: 'r66.md', content: 'x'.repeat(10) });
    const fo = await cmd<{ messageId: string; taskId: string | null }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: dm.conversationId }, body: '', intent: 'record_only', mentions: [], attachmentRefs: [txt.attachmentId] });
    expect(fo.taskId).toBeNull(); // 仅记录零任务
    const bodySaved = db.prepare('SELECT body_json FROM messages WHERE id = ?').get(fo.messageId) as { body_json: string };
    expect((JSON.parse(bodySaved.body_json) as { text: string }).text).toBe('');
  });

  it('④ attachment.readFull 全文与提取窗分列；originalFile 原件 hash 对账', async () => {
    const dm = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mB' });
    const tail = 'R66-TAIL-MARKER-尾部内容完整可达';
    const big = `${'A'.repeat(70 * 1024)}\n${tail}\n`; // > 64KB 提取窗
    const up = await cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: dm.conversationId, filename: '大文件.md', content: big });
    const excerpt = await cmd<{ text: string; truncated: boolean; originalBytes: number }>('attachment.previewText', { attachmentId: up.attachmentId });
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.text).not.toContain(tail); // 提取窗截断（模型注入口径）
    const full = await cmd<{ text: string; originalBytes: number; complete: boolean }>('attachment.readFull', { attachmentId: up.attachmentId });
    expect(full.complete).toBe(true);
    expect(full.text).toContain(tail); // 屏幕阅读=全文（分列）
    expect(full.originalBytes).toBeGreaterThan(64 * 1024);
    const orig = await cmd<{ bytesBase64: string; hash: string; bytes: number; filename: string | null }>('attachment.originalFile', { attachmentId: up.attachmentId });
    const raw0 = Buffer.from(orig.bytesBase64, 'base64');
    expect(orig.bytes).toBe(raw0.length);
    expect(createHash('sha256').update(raw0).digest('hex')).toBe(orig.hash); // 原件字节 hash 对账
    expect(orig.hash).toBe(up.hash);
    expect(orig.filename).toBe('大文件.md');
    // 跨会话 audience 拒绝。
    const other = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    await expect(cmd('attachment.readFull', { attachmentId: up.attachmentId, conversationId: other.conversationId })).rejects.toThrow(/audience|不属于该会话/);
  });

  it('⑤ member.runtime effective：未绑定=global-default（ZS_RUNTIME 语义）；绑定=binding', async () => {
    const unbound = await cmd<{ binding: { installationId: string | null }; effective: { source: string; kind: string | null; model: string | null } }>('member.runtime', { memberId: 'mA' });
    expect(unbound.binding.installationId).toBeNull();
    expect(unbound.effective.source).toBe('global-default');
    expect(unbound.effective.kind).toBe('claude'); // ZS_RUNTIME=claude（测试进程内设置）
    await cmd('member.setRuntime', { memberId: 'mB', kind: 'fake' }); // ZS_ALLOW_FAKE=1 环境允许
    const bound = await cmd<{ binding: { installationId: string | null }; installation: { kind: string } | null; effective: { source: string } }>('member.runtime', { memberId: 'mB' });
    expect(bound.binding.installationId).not.toBeNull();
    expect(bound.installation?.kind).toBe('fake');
    expect(bound.effective.source).toBe('binding');
  });
});
