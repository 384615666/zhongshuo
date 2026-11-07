/**
 * R194 图片随消息直接发送（用户要求：“去掉所有 AI 可能不能看图的限制，现在所有的 AI 都能看图，
 * 把图片有关的限制都去掉。”）——daemon × fake worker 端到端合同：
 *  ① DM 默认意图引用图片：无需 imageAck 直接成功；消息 imageInput='include'；
 *     装配层 TurnRequest.images 携带**实际图片字节**（不是文件名冒充）。
 *  ② 房间根派发：同上（建任务+派发成员）；图片-only（空正文+仅图片附件）允许发送。
 *  ③ 线程跟进：图片附件随该消息进入下一轮 TurnRequest.images。
 *  ④ record_only：消息 imageInput='local-only'——只保存原件；后续轮装配不产生图片字节
 *     （注入「图片附件未发送」说明），不虚构已读。
 *  ⑤ message.imageCapability 恒 supported:true；members 各项 status='supported'。
 * fake runtime 零真实调用。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import type { TurnRequest } from '../../src/contracts/runtime.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-image194-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

/** 合成最小合法 PNG（1×1 灰度，带正确 CRC）。 */
function makePng(width = 1, height = 1): Buffer {
  const chunk = (type: Buffer, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([type, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(crcBuf) >>> 0);
    return Buffer.concat([len, crcBuf, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(Buffer.from([0, 0xff]));
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
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r194-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `r194-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  /** fake worker + startTurn 输入捕获（装配层产物=TurnRequest）。 */
  const makeWorker = () => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    const inputs: TurnRequest[] = [];
    const original = adapter.startTurn.bind(adapter);
    adapter.startTurn = async (session, input) => { inputs.push(input); await original(session, input); };
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter, inputs };
  };
  const imageInputOf = (messageId: string): string | undefined => {
    const row = db.prepare('SELECT body_json FROM messages WHERE id = ?').get(messageId) as { body_json: string } | undefined;
    return row == null ? undefined : (JSON.parse(row.body_json) as { imageInput?: string }).imageInput;
  };
  return { db, cmd, cmdRaw, makeWorker, imageInputOf, close: () => db.close() };
}

describe('R194 图片随消息直接发送（所有 AI 都能看图）', () => {
  it('① DM 默认意图：引用图片无需 imageAck 直接发送；image_mode=include；字节进入 TurnRequest.images', async () => {
    const env = makeEnv();
    const png = makePng(8, 8);
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '私信图片.png', contentBase64: png.toString('base64') });
    const send = await env.cmd<{ messageId: string; taskId: string | null }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '看这张图', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(send.taskId).toBeTruthy();
    expect(env.imageInputOf(send.messageId)).toBe('include');
    expect((env.db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(send.messageId) as { c: number }).c).toBe(1);
    const { worker, inputs } = env.makeWorker();
    await worker.runOnce();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.images).toHaveLength(1);
    expect(Buffer.from(inputs[0]!.images![0]!.dataBase64, 'base64')).toEqual(png);
    expect(inputs[0]!.images![0]!.hash).toBe(up.hash);
    expect(inputs[0]!.text).toContain('【图片输入附件】');
    expect(inputs[0]!.text).not.toContain('图片附件未发送');
    env.close();
  });

  it('② 房间根派发 + 图片-only（空正文+仅图片附件）都直接发送；字节进入 TurnRequest.images', async () => {
    const env = makeEnv();
    const png = makePng(4, 4);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadImage', { conversationId: 'conv_room', filename: '房间图片.png', contentBase64: png.toString('base64') });
    const withText = await env.cmd<{ messageId: string; taskId: string | null }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '看图执行', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }], attachmentRefs: [up.attachmentId] });
    expect(withText.taskId).toBeTruthy();
    expect(env.imageInputOf(withText.messageId)).toBe('include');
    const imageOnly = await env.cmd<{ messageId: string; taskId: string | null }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }], attachmentRefs: [up.attachmentId] });
    expect(imageOnly.taskId).toBeTruthy(); // 图片-only 允许发送（不要求正文）
    expect(env.imageInputOf(imageOnly.messageId)).toBe('include');
    const { worker, inputs } = env.makeWorker();
    await worker.runOnce();
    await worker.runOnce();
    expect(inputs).toHaveLength(2);
    for (const request of inputs) {
      expect(request.images).toHaveLength(1);
      expect(Buffer.from(request.images![0]!.dataBase64, 'base64')).toEqual(png);
      expect(request.text).not.toContain('图片附件未发送');
    }
    env.close();
  });

  it('③ 线程跟进：图片附件随该消息进入下一轮 TurnRequest.images', async () => {
    const env = makeEnv();
    env.db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run('p1'); // 首轮后停待验收（非终态）——redispatch 合法
    const { worker, inputs } = env.makeWorker();
    const root = await env.cmd<{ taskId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '首轮任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
    const threadId = (env.db.prepare('SELECT conversation_thread_id FROM tasks WHERE id = ?').get(root.taskId) as { conversation_thread_id: string }).conversation_thread_id;
    await worker.runOnce();
    expect(inputs).toHaveLength(1);
    const png = makePng(2, 2);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadImage', { conversationId: 'conv_room', filename: '线程图片.png', contentBase64: png.toString('base64') });
    const follow = await env.cmd<{ messageId: string; disposition: string }>('message.submit', { target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room', threadId }, body: '补充一张图', intent: 'default', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(follow.disposition).toBe('enqueued');
    expect(env.imageInputOf(follow.messageId)).toBe('include');
    await worker.runOnce();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.images).toHaveLength(1);
    expect(Buffer.from(inputs[1]!.images![0]!.dataBase64, 'base64')).toEqual(png);
    expect(inputs[1]!.text).not.toContain('图片附件未发送');
    env.close();
  });

  it('④ record_only：image_mode=local-only 只保存原件；后续轮装配不产生图片字节并如实注入未发送说明', async () => {
    const env = makeEnv();
    const png = makePng(6, 6);
    const up = await env.cmd<{ attachmentId: string }>('attachment.uploadImage', { conversationId: 'dm_a', filename: '仅记录图片.png', contentBase64: png.toString('base64') });
    const rec = await env.cmd<{ messageId: string; taskId: string | null }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '仅记录这张图', intent: 'record_only', mentions: [], attachmentRefs: [up.attachmentId] });
    expect(rec.taskId).toBeNull(); // 零派发
    expect(env.imageInputOf(rec.messageId)).toBe('local-only');
    // 之后同一私信的默认消息水印包含这条仅记录消息——装配层不得把 local-only 图片当作已发送字节。
    const next = await env.cmd<{ taskId: string | null }>('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, body: '继续处理其他内容', intent: 'default', mentions: [] });
    expect(next.taskId).toBeTruthy();
    const { worker, inputs } = env.makeWorker();
    await worker.runOnce();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.images ?? []).toHaveLength(0);
    expect(inputs[0]!.text).toContain('【图片附件未发送】');
    expect(inputs[0]!.text).toContain('仅记录');
    env.close();
  });

  it('⑤ message.imageCapability 恒 supported:true；members 各项 status=supported（不再有图片门）', async () => {
    const env = makeEnv();
    const room = await env.cmd<{ supported: boolean; willDispatch: boolean; members: Array<{ status: string; channel: string; protocol: string; identityKey: string | null }> }>('message.imageCapability', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, mentions: [{ kind: 'member', memberId: 'mA' }] });
    expect(room.supported).toBe(true);
    expect(room.willDispatch).toBe(true);
    expect(room.members.length).toBeGreaterThanOrEqual(1);
    expect(room.members.every((m) => m.status === 'supported')).toBe(true);
    expect(room.members[0]).toMatchObject({ channel: '随消息直接发送', protocol: '适配器图片字节直传', identityKey: null });
    const dm = await env.cmd<{ supported: boolean; members: Array<{ status: string }> }>('message.imageCapability', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_a' }, mentions: [] });
    expect(dm.supported).toBe(true);
    expect(dm.members.length).toBe(1);
    expect(dm.members[0]!.status).toBe('supported');
    env.close();
  });
});
