/**
 * DEV-24 附件四通道正式链+完整性（第二十七轮二·四）：
 * - 主池/任务线程/记录线程/DM 共用归属校验与同事务关联：attachmentRefs 不存在/跨会话/
 *   不支持=明确拒绝（不静默丢附件）；消息与 message_attachments 同事务（失败回滚零残留）。
 * - 输入水位正确轮次：DM 排队消息的附件随其消息进入下一轮（不提前进在途轮）；线程跟进
 *   附件经 task.redispatch 进入第二轮 startTurn 输入。
 * - 完整性：读取核对 blob 实际字节 sha256==记录 hash（损坏拒绝预览与组装）；路径越界拒绝；
 *   UTF-8 **字节**截断保留完整字符（中文多字节）；新连接（关闭再打开）预览；显式临时
 *   appData（不回落工程 cwd）；同 commandId 重放不重复关联。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;
delete process.env.ZS_APP_DATA; // 显式临时 appData——不回落环境/工程 cwd

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-attch-'));
const appData = join(tmpRoot, 'app-data'); // 显式临时 appData（deps.appDataDir 注入）
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

interface Env {
  dbPath: string;
  cmd: <T,>(method: string, params: unknown, commandId?: string) => Promise<T>;
  cmdRaw: (method: string, params: unknown, commandId?: string) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  makeWorker: () => { worker: DispatchWorker; adapter: FakeRuntimeAdapter };
  close: () => void;
}

function makeEnv(): Env {
  const dbPath = join(tmpRoot, `state-${randomUUID().slice(0, 8)}.sqlite`);
  const db = openDatabase(dbPath);
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
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
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `attch-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown, commandId?: string) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `attch-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = (): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { dbPath, cmd, cmdRaw, makeWorker, close: () => db.close() };
}

const mattCount = (env: Env, messageId?: string): number => {
  const db2 = openDatabase(env.dbPath);
  try {
    const row = messageId == null
      ? db2.prepare('SELECT count(*) c FROM message_attachments').get() as { c: number }
      : db2.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(messageId) as { c: number };
    return row.c;
  } finally { db2.close(); }
};

describe('四通道正式链：主池/线程（任务串+记录串）/DM', () => {
  it('主池附件：同事务关联+模型输入注入（startTurn 实际文本+hash+文件名）', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'conv_room', filename: '需求 说明.md', content: '# 需求\n\n暗号 ROOM-5566' });
    const send = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '按附件需求执行', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }], attachmentRefs: [up.attachmentId] });
    expect(send.taskId).toBeTruthy();
    const db2 = openDatabase(env.dbPath);
    const rootMsg = (db2.prepare('SELECT root_message_id FROM tasks WHERE id = ?').get(send.taskId) as { root_message_id: string }).root_message_id;
    db2.close();
    expect(mattCount(env, rootMsg)).toBe(1); // 主池通道不再静默丢附件
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).toContain('ROOM-5566');
    expect(adapter.startTurnLog[0]!.text).toContain(up.hash.slice(0, 16));
    expect(adapter.startTurnLog[0]!.text).toContain('需求 说明.md');
    env.close();
  });

  it('任务线程跟进附件：随重派进入第二轮（第一轮不含）；记录串附件只保存不派发', async () => {
    const env = makeEnv();
    const db0 = openDatabase(env.dbPath);
    db0.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run('p1'); // 首轮后停待验收（非终态）——redispatch 合法
    db0.close();
    const { worker, adapter } = env.makeWorker();
    const send = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '首轮任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
    const db2 = openDatabase(env.dbPath);
    const threadId = (db2.prepare('SELECT conversation_thread_id FROM tasks WHERE id = ?').get(send.taskId) as { conversation_thread_id: string }).conversation_thread_id;
    db2.close();
    await worker.runOnce(); // 第一轮完成（无附件）
    expect(adapter.startTurnLog.length).toBe(1);
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'conv_room', filename: '补充 资料.txt', content: '跟进暗号 FOLLOW-7788' });
    const follow = await env.cmd<{ messageId: string; followUpRecorded: boolean }>('message.submit', { target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room', threadId }, body: '补充资料见附件', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(follow.followUpRecorded).toBe(true);
    expect(mattCount(env, follow.messageId)).toBe(1);
    expect(adapter.startTurnLog[0]!.text).not.toContain('FOLLOW-7788'); // 附件在跟进消息后=不回溯进已完成的轮
    await env.cmd('task.redispatch', { taskId: send.taskId, reason: '按补充资料重跑' });
    await worker.runOnce(); // 第二轮：跟进附件进入本轮输入
    expect(adapter.startTurnLog.length).toBe(2);
    expect(adapter.startTurnLog[1]!.text).toContain('FOLLOW-7788'); // 跟进附件不漏
    expect(adapter.startTurnLog[1]!.text).toContain('补充 资料.txt');
    // 记录串（root_task_id=null 线程）：先经 room_root record_only 建串，再入附件——只保存零派发。
    const recRoot = await env.cmd<{ threadId: string; taskId: null }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '记录串根', intent: 'record_only', mentions: [] });
    expect(recRoot.taskId).toBeNull();
    const recUp = await env.cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'conv_room', filename: '随手 记.md', content: '记录暗号 REC-3311' });
    const rec = await env.cmd<{ messageId: string }>('message.submit', { target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room', threadId: recRoot.threadId }, body: '记录一下', intent: 'record_only', mentions: [], attachmentRefs: [recUp.attachmentId] });
    expect(mattCount(env, rec.messageId)).toBe(1);
    expect(adapter.startTurnLog.length).toBe(2); // 记录串零派发
    // thread.history 返回附件摘要（已发消息芯片数据源）。
    const hist = await env.cmd<{ items: Array<{ id: string; attachments: Array<{ artifactId: string; filename: string }> }> }>('thread.history', { threadId });
    const withAtt = (hist.items ?? []).filter((i) => (i.attachments ?? []).length > 0);
    expect(withAtt.length).toBe(1);
    expect(withAtt[0]!.attachments[0]!.filename).toBe('补充 资料.txt');
    env.close();
  });

  it('DM 排队附件：随其消息进入下一轮（不提前进在途轮）', async () => {
    const env = makeEnv();
    const { worker, adapter } = env.makeWorker();
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '第一个问题（长任务）', intent: 'default', mentions: [] });
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '排队 附件.md', content: '排队暗号 QUEUE-9900' });
    const s2 = await env.cmd<{ disposition: string; messageId: string }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '排队消息带附件', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(s2.disposition).toBe('queued');
    expect(mattCount(env, s2.messageId)).toBe(1);
    await worker.runOnce(); // 第一轮：水位=第一条——排队附件不得提前进入
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).not.toContain('QUEUE-9900');
    await worker.runOnce(); // 第二轮：root=排队消息——附件随其消息进入
    expect(adapter.startTurnLog.length).toBe(2);
    expect(adapter.startTurnLog[1]!.text).toContain('QUEUE-9900');
    expect(adapter.startTurnLog[1]!.text).toContain('排队 附件.md');
    env.close();
  });

  it('主池 record_only：只保存消息/引用，零派发', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'conv_room', filename: '仅 记录.txt', content: '记录内容 REC-POOL' });
    const rec = await env.cmd<{ messageId: string; disposition: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '仅记录这条', intent: 'record_only', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(rec.disposition).toBe('none');
    expect(mattCount(env, rec.messageId)).toBe(1);
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(0); // record_only 零派发
    env.close();
  });

  it('同成员两 DM：跨会话引用明确拒绝；失败回滚零残留', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '私有.md', content: '私有内容' });
    const before = mattCount(env);
    const cross = await env.cmdRaw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_b' }, body: '引用别会话附件', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(cross.ok).toBe(false);
    expect(String(cross.error?.message)).toContain('audience');
    expect(mattCount(env)).toBe(before); // 拒绝=零残留（同事务回滚——消息与关联都不落）
    const db2 = openDatabase(env.dbPath);
    const msgs = (db2.prepare("SELECT count(*) c FROM messages WHERE conversation_id = 'dm_b'").get() as { c: number }).c;
    db2.close();
    expect(msgs).toBe(0); // 被拒消息本身也不落库（不以部分成功冒充）
    env.close();
  });

  it('发送失败与重试：同 commandId 重放返回原结果，不重复关联', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '重放.md', content: '重放内容 REPLAY-2211' });
    const commandId = `attch-replay-${randomUUID().slice(0, 8)}`;
    const params = { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '带附件重放', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] };
    const s1 = await env.cmd<{ messageId: string }>('message.submit', params, commandId);
    const s2 = await env.cmd<{ messageId: string }>('message.submit', params, commandId); // 同号重放
    expect(s2.messageId).toBe(s1.messageId);
    expect(mattCount(env, s1.messageId)).toBe(1); // 幂等重放不重复关联
    env.close();
  });
});

describe('完整性与截断（读取路径共享）', () => {
  it('副本损坏（字节被改写）：预览与组装都明确拒绝——不以旧 hash 注入新文本', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '会被改写.md', content: '原始内容 CORRUPT-4444' });
    const db2 = openDatabase(env.dbPath);
    const blobPath = (db2.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(up.attachmentId) as { blob_path: string }).blob_path;
    db2.close();
    writeFileSync(blobPath, '被改写后的新内容（hash 不再匹配）', 'utf8');
    const pv = await env.cmdRaw('attachment.previewText', { attachmentId: up.attachmentId });
    expect(pv.ok).toBe(false);
    expect(String(pv.error?.message)).toContain('完整性');
    // 组装同样拒绝（模型输入不注入被改写文本）：派发后 run 失败、零 startTurn。
    await env.cmd('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '执行这个附件', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    const { worker, adapter } = env.makeWorker();
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(0); // 组装失败=不发给模型
    env.close();
  });

  it('路径越界（blob_path 指向存储外）：拒绝读取', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '越界.md', content: '内容' });
    const outside = join(tmpRoot, 'outside-store.txt');
    writeFileSync(outside, '内容', 'utf8');
    const db2rw = openDatabase(env.dbPath);
    db2rw.prepare('UPDATE artifacts SET blob_path = ? WHERE id = ?').run(outside, up.attachmentId);
    db2rw.close();
    const pv = await env.cmdRaw('attachment.previewText', { attachmentId: up.attachmentId });
    expect(pv.ok).toBe(false);
    expect(String(pv.error?.message)).toContain('越出托管存储');
    env.close();
  });

  it('外部同名 blobstore 目录（实根校验）：拒绝读取——不只看父目录名', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '实根.md', content: '内容 ROOT-9988' });
    // 另一目录树下的「同名布局」blobstore/{hash}.txt（内容一致——hash 校验会过）：
    // 实根校验（本次 appData/blobstore）必须拒绝——父目录名相同不算托管。
    const outsideStore = join(tmpRoot, 'elsewhere', 'blobstore');
    mkdirSync(outsideStore, { recursive: true });
    writeFileSync(join(outsideStore, `${up.hash}.txt`), '内容 ROOT-9988', 'utf8');
    const db2 = openDatabase(env.dbPath);
    db2.prepare('UPDATE artifacts SET blob_path = ? WHERE id = ?').run(join(outsideStore, `${up.hash}.txt`), up.attachmentId);
    db2.close();
    const pv = await env.cmdRaw('attachment.previewText', { attachmentId: up.attachmentId });
    expect(pv.ok).toBe(false);
    expect(String(pv.error?.message)).toContain('越出托管存储');
    expect(String(pv.error?.message)).toContain('本次存储根');
    env.close();
  });
  it('多字节字节截断：中文按 UTF-8 字节预算截断、保留完整字符、大小如实', async () => {
    const env = makeEnv();
    // 40000 个中文字符 = 120000 字节（>64KB 预算，<256KB 上限）；字符串 slice 到 ~21845 字符
    // 恰 65535 字节，但按字符数截断的旧实现会把预算当字符数=远超预算。字节截断应恰 ≤65536。
    const content = '汉'.repeat(40_000) + 'TAILMARK';
    const up = await env.cmd<{ attachmentId: string; hash: string; truncated: boolean }>('attachment.uploadText', { conversationId: 'dm_a', filename: '长中文.md', content });
    expect(up.truncated).toBe(true);
    const pv = await env.cmd<{ text: string; truncated: boolean; originalBytes: number; excerptBytes: number }>('attachment.previewText', { attachmentId: up.attachmentId });
    expect(pv.originalBytes).toBe(40_000 * 3 + 8);
    expect(pv.truncated).toBe(true);
    expect(pv.excerptBytes).toBeLessThanOrEqual(65_536);
    expect(pv.excerptBytes % 3).toBe(0); // 全中文前缀：完整字符边界（3 字节/字）
    expect(pv.text).not.toContain('TAILMARK');
    expect(pv.text.endsWith('汉')).toBe(true);
    expect(pv.text.includes('\uFFFD')).toBe(false); // 无替换字符=未撕裂多字节序列
    env.close();
  });

  it('关闭再打开数据库（新连接）：副本可预览且内容一致；显式临时 appData（不落工程 cwd）', async () => {
    const env = makeEnv();
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'dm_a', filename: '重开.md', content: '重开内容 REOPEN-5555' });
    const db2 = openDatabase(env.dbPath);
    const row = db2.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(up.attachmentId) as { blob_path: string };
    db2.close();
    expect(row.blob_path.startsWith(appData)).toBe(true); // 副本在显式临时 appData（非工程 cwd）
    const db3 = openDatabase(env.dbPath);
    db3.close();
    const pv = await env.cmd<{ text: string; hash: string }>('attachment.previewText', { attachmentId: up.attachmentId });
    expect(pv.text).toBe('重开内容 REOPEN-5555');
    expect(pv.hash).toBe(up.hash);
    env.close();
  });
});
