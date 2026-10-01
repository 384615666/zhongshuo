/**
 * DEV-24 图片附件首包（第二十八轮四）：四能力如实分列——
 * ①保存原件（magic bytes 内容类型校验——扩展名不作依据；尺寸/面积按格式头限幅；损坏/截断/
 * 超限明确拒绝；内容寻址 {appData}/blobstore/{hash}.bin）②预览（audience+实根+sha256 原件
 * 核对；mime/尺寸/dataUrl——渲染由 <img>）③OCR=未实现（明确 unsupported）④模型图片输入=
 * 未认证（注入链路只注文本——startTurn 输入不含图片数据，不发路径冒充已读）。
 * 消息可带图引用（四通道沿用）；图片评论随分批归属（comment.add 对 image 明确拒绝）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-imgatt-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

/** 合成最小合法 PNG（1×1 灰度，带正确 CRC——服务端 magic+IHDR 解析即可；<img> 渲染由页面层）。 */
function makePng(width = 1, height = 1): Buffer {
  const chunk = (type: Buffer, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([type, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(crcBuf) >>> 0);
    return Buffer.concat([len, crcBuf, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit 灰度
  const idat = zlib.deflateSync(Buffer.from([0, 0xff])); // 单行滤波字节+1 像素
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(Buffer.from('IHDR'), ihdr),
    chunk(Buffer.from('IDAT'), idat),
    chunk(Buffer.from('IEND'), Buffer.alloc(0)),
  ]);
}

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ia-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ia-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = () => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { db, cmd, cmdRaw, makeWorker, close: () => db.close() };
}

describe('DEV-24 图片首包：保存原件（magic 校验+限幅+内容寻址）', () => {
  it('PNG 原件保存：kind/尺寸/去重；同内容同 hash（内容寻址）', async () => {
    const env = makeEnv();
    const png = makePng(640, 480);
    const up = await env.cmd<{ attachmentId: string; hash: string; bytes: number; width: number; height: number; mime: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '截图 演示.png', contentBase64: png.toString('base64') });
    expect(up.mime).toBe('image/png');
    expect(up.width).toBe(640);
    expect(up.height).toBe(480);
    expect(up.bytes).toBe(png.length);
    const up2 = await env.cmd<{ hash: string; attachmentId: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '同一张图.png', contentBase64: png.toString('base64') });
    expect(up2.hash).toBe(up.hash); // 内容寻址——同内容同 hash
    const row = env.db.prepare('SELECT kind, blob_path FROM artifacts WHERE id = ?').get(up.attachmentId) as { kind: string; blob_path: string };
    expect(row.kind).toBe('image_file');
    expect(row.blob_path.endsWith(`${createHash('sha256').update(png).digest('hex')}.bin`)).toBe(true);
    env.close();
  });
  it('反例：扩展名 .png 但内容是文本（magic 拒绝）；截断 PNG；超尺寸；超面积', async () => {
    const env = makeEnv();
    const fake = await env.cmdRaw('attachment.uploadImage', { conversationId: 'dm_a', filename: '假图.png', contentBase64: Buffer.from('这不是图片内容——只是文本').toString('base64') });
    expect(fake.ok).toBe(false);
    expect(String(fake.error?.message)).toContain('magic');
    const truncated = makePng(10, 10).subarray(0, 18); // IHDR 中途截断
    const broken = await env.cmdRaw('attachment.uploadImage', { conversationId: 'dm_a', filename: '截断.png', contentBase64: truncated.toString('base64') });
    expect(broken.ok).toBe(false);
    expect(String(broken.error?.message)).toContain('图片');
    const huge = await env.cmdRaw('attachment.uploadImage', { conversationId: 'dm_a', filename: '巨图.png', contentBase64: makePng(20000, 20000).toString('base64') });
    expect(huge.ok).toBe(false);
    expect(String(huge.error?.message)).toContain('单边超限');
    const wide = await env.cmdRaw('attachment.uploadImage', { conversationId: 'dm_a', filename: '宽条.png', contentBase64: makePng(12000, 4000).toString('base64') }); // 边不超但 48MP>40MP
    expect(wide.ok).toBe(false);
    expect(String(wide.error?.message)).toContain('面积超限');
    env.close();
  });
});

describe('DEV-24 图片首包：预览/OCR/模型输入如实分列', () => {
  it('预览返回 mime/尺寸/dataUrl+原件 hash 核对；OCR=unsupported；模型输入=unverified；跨会话拒绝', async () => {
    const env = makeEnv();
    const png = makePng(32, 32);
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '预览用.png', contentBase64: png.toString('base64') });
    const pv = await env.cmd<{ mime: string; width: number; height: number; dataUrl: string; ocr: string; modelInput: string; revision: number }>('attachment.previewImage', { attachmentId: up.attachmentId });
    expect(pv.mime).toBe('image/png');
    expect(pv.width).toBe(32);
    expect(pv.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(pv.ocr).toBe('unsupported'); // OCR 如实未实现
    expect(pv.modelInput).toBe('unverified-unsupported'); // 模型图片输入未认证
    expect(pv.revision).toBe(1);
    // 原件被改写 → 完整性拒绝。
    const blobPath = (env.db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(up.attachmentId) as { blob_path: string }).blob_path;
    const fs = await import('node:fs');
    fs.writeFileSync(blobPath, makePng(4, 4)); // 同为合法 PNG 但字节不同
    const pvBad = await env.cmdRaw('attachment.previewImage', { attachmentId: up.attachmentId });
    expect(pvBad.ok).toBe(false);
    expect(String(pvBad.error?.message)).toContain('完整性');
    // 跨会话预览拒绝（他人 DM——audience）。
    env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_b','p1','dm',NULL)`).run();
    env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_b','human','u_other'),('p1','dm_b','agent','mA')`).run();
    const cross = await env.cmdRaw('attachment.previewImage', { attachmentId: up.attachmentId, conversationId: 'dm_b' });
    expect(cross.ok).toBe(false);
    expect(String(cross.error?.message)).toContain('audience');
    env.close();
  });
  it('消息可带图引用（四通道沿用）+ 能力门：无确认拒发；确认后注入「图片未发送」说明；图片评论随分批归属拒绝', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '带图执行.png', contentBase64: makePng(8, 8).toString('base64') });
    // 能力门（第二十九轮三）：未确认 → 拒发（不悄悄省略图片冒充成功）。
    const blocked = await env.cmdRaw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '看这张图', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error?.message)).toContain('IMAGE_INPUT_UNVERIFIED');
    // 确认仅发送文字 → 落库+派发；注入明示图片未发送（不含图片数据/hash）。
    const send = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '看这张图', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId], imageAck: 'omit-images' });
    expect(send.taskId).toBeTruthy();
    const att = (env.db.prepare('SELECT count(*) c FROM message_attachments WHERE artifact_id = ?').get(up.attachmentId) as { c: number }).c;
    expect(att).toBe(1); // 消息-图片关联落库（四通道沿用）
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).toContain('【图片附件未发送】'); // 明示未发送+用户确认
    expect(adapter.startTurnLog[0]!.text).not.toContain('data:image'); // 注入不含图片数据
    // hash 只随「未发送」附件条目出现一次（资源身份可追溯），不作为已读材料重复注入。
    {
      const t = adapter.startTurnLog[0]!.text;
      const marker = up.hash.slice(0, 16);
      const count = t.split(marker).length - 1;
      expect(count).toBe(1);
    }
    const fs = await import('node:fs');
    void fs;
    // 图片评论随分批归属——本批明确拒绝（文本/代码/Markdown 首批）。
    const cmt = await env.cmdRaw('attachment.comment.add', { attachmentId: up.attachmentId, body: '图片评论', expectedHash: up.hash, expectedRevision: 1 });
    expect(cmt.ok).toBe(false);
    expect(String(cmt.error?.message)).toContain('不支持评论');
    env.close();
  });
});
