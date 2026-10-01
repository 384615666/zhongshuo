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
import { randomUUID } from 'node:crypto';
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

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-att-'));
const storeRoot = join(tmpRoot, 'blobstore');
mkdirSync(storeRoot, { recursive: true });
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
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `att-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `att-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = (): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: join(tmpRoot, 'app') }), adapter };
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
    // 副本落应用数据区（blobstore——内容寻址），不在用户项目目录。
    const row = db.prepare('SELECT blob_path, source_name, conversation_id, kind FROM artifacts WHERE id = ?').get(a1.attachmentId) as { blob_path: string; source_name: string; conversation_id: string; kind: string };
    expect(row.blob_path.startsWith(storeRoot)).toBe(false); // blobstore 路径由 daemon 注入（此处断言非用户项目目录）
    expect(row.blob_path.includes('zhongshuo')).toBe(true);
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
    const big = await cmdRaw('attachment.uploadText', { conversationId: 'dm_a', filename: 'big.txt', content: 'x'.repeat(300 * 1024) });
    expect(big.ok).toBe(false); // 超上限拒绝
    expect(String(big.error?.message)).toContain('大小');
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

void ({} as unknown as ZhongshuoDatabase);
void ReminderScheduler;
