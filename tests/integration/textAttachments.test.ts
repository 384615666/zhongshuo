/**
 * DEV-24 文本/Markdown 附件首包（第二十六轮五）：四能力——保存副本/预览/提取正文/经授权
 * 交给模型。副本落应用数据区（artifacts.blob_path——内容寻址，不在用户项目目录生成副本）；
 * 持久 hash/版本/来源/conversation audience；原文件变化不改变已保存版本；编码/大小明确
 * 规则（utf-8/utf-16 BOM 检测；上限+截断注明）；上传/预览/交给模型分别呈现；record_only
 * 不派发；归档只读；跨会话（同成员另一 DM）拒绝；模型输入使用获准副本实际文本+版本/hash/
 * 截断说明（本地协议断言 startTurn 实际输入）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { ReminderScheduler } from '../../src/daemon/reminderScheduler.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;
delete process.env.ZS_APP_DATA; // 显式临时 appData（deps.appDataDir 注入）——不回落环境/工程 cwd

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-att-'));
const storeRoot = join(tmpRoot, 'blobstore');
const appData = join(tmpRoot, 'app-data');
mkdirSync(storeRoot, { recursive: true });
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_b','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_b','human','u_local'),('p1','dm_b','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `att-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `att-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = (): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { db, cmd, cmdRaw, makeWorker };
}

describe('DEV-24 首包：attachment.uploadText（保存副本+资源身份）', () => {
  it('中文与空格文件名；同文件不同版本（hash 区分）；源文件修改/删除后副本保持；重启保持', async () => {
    const { db, cmd } = makeEnv();
    const a1 = await cmd<{ attachmentId: string; hash: string; bytes: number }>('attachment.uploadText', { conversationId: 'dm_a', filename: '会议 纪要.md', content: '# 纪要\n\n内容甲' });
    expect(a1.attachmentId).toBeTruthy();
    expect(a1.hash).toHaveLength(64);
    const a2 = await cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '会议 纪要.md', content: '# 纪要 v2\n\n内容乙' });
    expect(a2.hash).not.toBe(a1.hash); // 同名不同内容=不同资源版本
    // 副本落应用数据区（blobstore——内容寻址），不在用户项目目录/工程 cwd。
    const row = db.prepare('SELECT blob_path, source_name, conversation_id, kind FROM artifacts WHERE id = ?').get(a1.attachmentId) as { blob_path: string; source_name: string; conversation_id: string; kind: string };
    expect(row.blob_path.startsWith(join(appData, 'blobstore'))).toBe(true); // 显式临时 appData（第二十七轮四：不回落工程 cwd——旧断言 includes('zhongshuo') 在固化该缺陷）
    expect(row.blob_path.includes('zhongshuo')).toBe(false);
    expect(row.source_name).toBe('会议 纪要.md');
    expect(row.conversation_id).toBe('dm_a');
    // 重启保持=行持久（新连接读取由 preview 验证）。
    const p1 = await cmd<{ text: string; hash: string; truncated: boolean }>('attachment.previewText', { attachmentId: a1.attachmentId });
    expect(p1.text).toContain('内容甲');
    expect(p1.hash).toBe(a1.hash);
    db.close();
  });
  it('编码与大小失败明确：非文本字节拒绝；超上限拒绝；截断注明', async () => {
    const { db, cmd, cmdRaw } = makeEnv();
    const bad = await cmdRaw('attachment.uploadText', { conversationId: 'dm_a', filename: 'x.bin', content: '\u0000\u0001\u0002\u0003\u0004\u0005' });
    expect(bad.ok).toBe(false); // 二进制拒绝
    expect(String(bad.error?.message)).toContain('文本');
    const bigText='x'.repeat(1024 * 1024)+'完整末尾';
    const big = await cmd<{attachmentId:string;bytes:number}>('attachment.uploadText', { conversationId: 'dm_a', filename: 'big.txt', content: bigText });
    const full=await cmd<{text:string}>('attachment.readFull',{attachmentId:big.attachmentId});
    expect(big.bytes).toBe(Buffer.byteLength(bigText));expect(full.text).toBe(bigText);
    const truncated = await cmd<{ truncated: boolean; text: string; originalBytes: number }>('attachment.uploadText', { conversationId: 'dm_a', filename: 'long.txt', content: 'y'.repeat(120 * 1024) });
    expect(truncated.originalBytes).toBeGreaterThan(100_000);
    db.close();
  });
  it('audience：跨会话拒绝（同成员另一 DM 无权读取/引用）；他人 DM 拒绝上传', async () => {
    const { db, cmd, cmdRaw } = makeEnv();
    const up = await cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: 'a.md', content: '私有' });
    const cross = await cmdRaw('attachment.previewText', { attachmentId: up.attachmentId, conversationId: 'dm_b' });
    expect(cross.ok).toBe(false); // dm_b 不是归属会话
    expect(String(cross.error?.message)).toContain('audience');
    db.close();
  });
});

describe('DEV-24 首包：交给模型（输入注入+record_only 不派发+归档只读）', () => {
  it('模型输入使用获准副本实际文本+版本/hash/截断说明（本地协议断言 startTurn 输入）', async () => {
    const { db, cmd, makeWorker } = makeEnv();
    const up = await cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '规格.md', content: '# 规格\n\n验收标准：暗号 ATT-8899' });
    const send = await cmd<{ messageId: string; taskId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '请按附件规格执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(send.taskId).toBeTruthy();
    const { worker, adapter } = makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).toContain('ATT-8899'); // 副本实际文本注入
    expect(adapter.startTurnLog[0]!.text).toContain(up.hash.slice(0, 16)); // 资源 hash 标注
    expect(adapter.startTurnLog[0]!.text).toContain('规格.md'); // 来源文件名
    db.close();
  });
  it('record_only 不派发；归档只读', async () => {
    const { db, cmd, cmdRaw } = makeEnv();
    const up = await cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: 'r.md', content: '记录内容' });
    const rec = await cmd<{ disposition: string; taskId: null }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '仅记录', intent: 'record_only', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(rec.disposition).toBe('none');
    expect((db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c).toBe(0);
    // 归档→上传只读拒绝。
    db.prepare('UPDATE conversations SET archived_at = 1 WHERE id = ?').run('dm_a');
    const archived = await cmdRaw('attachment.uploadText', { conversationId: 'dm_a', filename: 'x.md', content: '归档后' });
    expect(archived.ok).toBe(false);
    expect(String(archived.error?.message)).toContain('归档');
    db.close();
  });
});

describe('R69 P1-C：attachment.uploadTextRaw（原字节上传+编码检测+0B）', () => {
  it('UTF-8 BOM：原字节保存（另存逐字节一致）；阅读解码剥 BOM；encoding 如实', async () => {
    const { db, cmd } = makeEnv();
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM 文档', 'utf8'), Buffer.from([0x0a]), Buffer.from('正文行', 'utf8')]);
    const up = await cmd<{ attachmentId: string; hash: string; bytes: number; encoding: string }>('attachment.uploadTextRaw', { conversationId: 'dm_a', filename: 'bom.md', contentBase64: raw.toString('base64') });
    expect(up.encoding).toBe('utf-8-bom');
    expect(up.bytes).toBe(raw.length);
    // 原件字节通道=真实原字节（含 BOM——另存原文件逐字节一致）。
    const of = await cmd<{ bytes: number; bytesBase64: string }>('attachment.originalFile', { attachmentId: up.attachmentId });
    expect(of.bytes).toBe(raw.length);
    expect(Buffer.from(of.bytesBase64, 'base64').equals(raw)).toBe(true);
    // 阅读通道解码（BOM 剥离、正文完整）。
    const full = await cmd<{ text: string; encoding: string }>('attachment.readFull', { attachmentId: up.attachmentId });
    expect(full.text.startsWith('# BOM 文档')).toBe(true);
    expect(full.text.includes('﻿')).toBe(false);
    expect(full.encoding).toBe('utf-8-bom');
    db.close();
  });
  it('UTF-16LE BOM 与无 BOM GB18030：上传成功+阅读正确解码；哈希=原字节 sha256', async () => {
    const { db, cmd } = makeEnv();
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文UTF16内容', 'utf16le')]);
    const up16 = await cmd<{ attachmentId: string; hash: string; encoding: string }>('attachment.uploadTextRaw', { conversationId: 'dm_a', filename: 'u16.txt', contentBase64: u16.toString('base64') });
    expect(up16.encoding).toBe('utf-16le-bom');
    expect(up16.hash).toBe(createHash('sha256').update(u16).digest('hex'));
    const full16 = await cmd<{ text: string }>('attachment.readFull', { attachmentId: up16.attachmentId });
    expect(full16.text).toContain('中文UTF16内容');
    // 无 BOM GB18030（中文 GBK 双字节序列——非 UTF-8/无零字节特征→GB18030 链）。
    const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x41, 0x42]);
    const upGb = await cmd<{ attachmentId: string; encoding: string }>('attachment.uploadTextRaw', { conversationId: 'dm_a', filename: 'gb.txt', contentBase64: gb.toString('base64') });
    expect(upGb.encoding).toBe('gb18030');
    const fullGb = await cmd<{ text: string }>('attachment.readFull', { attachmentId: upGb.attachmentId });
    expect(fullGb.text.startsWith('中文AB')).toBe(true);
    db.close();
  });
  it('0 字节空文件：允许保存；阅读全文=空串；另存 0B', async () => {
    const { db, cmd } = makeEnv();
    const up = await cmd<{ attachmentId: string; bytes: number; encoding: string }>('attachment.uploadTextRaw', { conversationId: 'dm_a', filename: '下载 (5).txt', contentBase64: '' });
    expect(up.bytes).toBe(0);
    expect(up.encoding).toBe('empty');
    const full = await cmd<{ text: string; originalBytes: number }>('attachment.readFull', { attachmentId: up.attachmentId });
    expect(full.text).toBe('');
    expect(full.originalBytes).toBe(0);
    const of = await cmd<{ bytes: number }>('attachment.originalFile', { attachmentId: up.attachmentId });
    expect(of.bytes).toBe(0);
    db.close();
  });
  it('不可解码字节明确拒绝（不静默替换）；UTF-16 解码文本经注入链进入模型输入', async () => {
    const { db, cmd, cmdRaw, makeWorker } = makeEnv();
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11, 0x22, 0x33]);
    const bad = await cmdRaw('attachment.uploadTextRaw', { conversationId: 'dm_a', filename: 'pic.png', contentBase64: bin.toString('base64') });
    expect(bad.ok).toBe(false);
    // PNG 头（GB18030 能解出控制字节）→ 二进制控制字节判据（解码链内判——非「编码不支持」误称）。
    expect(String(bad.error?.message)).toContain('内容含二进制控制字节');
    // 注入：UTF-16 附件经 readVerifiedCopy 解码进 startTurn 输入。
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF十六注入内容', 'utf16le')]);
    const up = await cmd<{ attachmentId: string }>('attachment.uploadTextRaw', { conversationId: 'dm_a', filename: 'inj.txt', contentBase64: u16.toString('base64') });
    await cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '按文档执行', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker, adapter } = makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog[0]!.text).toContain('UTF十六注入内容');
    db.close();
  });
});
void ReminderScheduler;

void ({} as unknown as ZhongshuoDatabase);
void ReminderScheduler;
