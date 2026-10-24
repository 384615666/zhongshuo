import {initializeHifiSendPersistence} from '../helpers/hifiSendPersistence.ts';
/**
 * 第五十二轮 H2 真实链测试（review-r51 §2/§3/§5/§6.3）：**打包 hifi 前端数据层 × 正式
 * daemon × fake 库**——附件归属（uploadId 收敛/移除即弃/refs 清算）、fatal UTF-8 字节合同、
 * 深链归属分列（delivery 带 threadId；未知归属不默认 DM）、信封冻结（refs/imageAck/
 * attachmentRanges 逐字重发）、图片能力门端到端合同。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-hifi3-'));
const bundlePath = join(tmpRoot, 'hifi-bundle.mjs');
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄 */ } } });

function chr92slash(): string { return String.fromCharCode(92); }

async function buildHifiBundle(): Promise<void> {
  const entry = join(tmpRoot, 'hifi-entry.ts');
  const q = JSON.stringify;
  writeFileSync(entry, `import * as loader from ${q(join(repoRoot, 'src/ui/hifi/loader.ts').replaceAll(chr92slash(), '/'))};
import * as store from ${q(join(repoRoot, 'src/ui/hifi/data/store.ts').replaceAll(chr92slash(), '/'))};
import * as deepLink from ${q(join(repoRoot, 'src/ui/hifi/lib/deepLink.ts').replaceAll(chr92slash(), '/'))};
export { loader, store, deepLink };
`, 'utf8');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', outfile: bundlePath, sourcemap: false, loader: { '.tsx': 'tsx', '.ts': 'ts' } });
}

interface LoaderApi {
  openProjectByPath(path: string): Promise<void>;
  refreshRooms(): Promise<void>;
  refreshDms(): Promise<void>;
  loadThread(threadId: string, opts?: { markRead?: boolean }): Promise<void>;
  uploadAttachmentFile(conversationId: string, file: File): Promise<{ attachmentId: string; hash: string; revision: number; kind: string }>;
  attachmentRefsFromDraft(draftKey: string, intent: 'default' | 'record_only'): { refs?: string[]; hasImages?: boolean; blockError?: string };
  attachmentRangesFromDraft(draftKey: string): Record<string, string> | undefined;
  setDraftAttachmentRange(draftKey: string, attachmentId: string, range: string): void;
  buildThreadEnvelope(commandId: string, threadId: string, body: string, intent: 'default' | 'record_only', attachmentRefs?: string[], opts?: { imageAck?: 'omit-images'; attachmentRanges?: Record<string, string> }): { commandId: string; method: 'message.submit'; params: Record<string, unknown> };
  sendEnvelope(env: { commandId: string; method: 'message.submit'; params: Record<string, unknown> }): Promise<{ status: string; code?: string; error?: string }>;
  stopThreadTask(threadId: string): Promise<{ ok: boolean; error?: string }>;
}
interface StoreApi {
  initDraftPersistence(namespace:string,rootId?:string):boolean;
  getState(): {
    rooms: Array<{ id: string; conversationId?: string }>;
    dms: Array<{ id: string }>;
    uploadItems: Record<string, Array<{ uploadId: string; draftKey: string; name: string; status: string; attachmentId?: string; removed?: boolean }>>;
    threadEntities: Record<string, { id: string; conversationId?: string; roomId: string }>;
  };
  addUploadItem(item: { uploadId: string; draftKey: string; conversationId: string; name: string; size: number; status: 'uploading' | 'ready' | 'failed'; attachmentId?: string }): void;
  settleUpload(draftKey: string, uploadId: string, patch: { status?: 'uploading' | 'ready' | 'failed'; attachmentId?: string }): void;
  removeUploadItem(draftKey: string, uploadId: string): void;
  hydrateUploadRefs(draftKey: string, conversationId: string, refs: Array<{ name: string; size: number; attachmentId: string; kind?: string }>): void;
  clearSettledUploads(draftKey: string, sentIds: string[]): void;
  getDraftFull(key: string): { attachments: Array<{ attachmentId: string; name: string; range?: string }>; rev?: number };
  setDraftFull(key: string, draft: { body?: string; mentions?: string[]; attachments?: Array<{ attachmentId: string; name: string; kind?: string; range?: string }>; access?: string; sendAs?: 'ai' | 'record' }): void;
}
interface DeepLinkApi {
  routeForResolved(res: Record<string, unknown>, s: unknown): string | null;
}
interface Harness {
  bundle: { loader: LoaderApi; store: StoreApi; deepLink: DeepLinkApi };
  raw(method: string, params: unknown, commandId?: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  sent: Array<{ method: string; params: unknown }>;
  db: import('better-sqlite3').Database;
  close(): void;
}

async function makeHarness(): Promise<Harness> {
  const db = openDatabase(':memory:');
  const appDir = join(tmpRoot, 'app');
  mkdirSync(appDir, { recursive: true });
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir };
  const sent: Array<{ method: string; params: unknown }> = [];
  const raw = (method: string, params: unknown, commandId?: string) => {
    sent.push({ method, params });
    return dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `t-${randomUUID().slice(0, 8)}`, method, params }) as unknown as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  };
  (globalThis as unknown as { window: unknown }).window = {
    zs: { command: async (env: { commandId: string; method: string; params: unknown }) => raw(env.method, env.params, env.commandId) },
  };
  const bundle = await import(pathToFileURL(bundlePath).href) as unknown as Harness['bundle'];
  initializeHifiSendPersistence(bundle.store,`r108-hifiUploadDeepLinkRound52.test.ts|${randomUUID()}`);
  return { bundle, raw, sent, db, close: () => db.close() } as unknown as Harness;
}

/** 最小合法 PNG（1×1，magic bytes 校验可通过）。 */
const MINI_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

describe('第五十二轮 H2：附件归属/字节合同/深链分列/信封冻结（真实链）', () => {
  it('uploadId 收敛+移除即弃+refs 清算；fatal UTF-8；delivery 深链带 threadId；imageAck/ranges 冻结', async () => {
    await buildHifiBundle();
    const h = await makeHarness();
    try {
      // 夹具：项目/成员/房间/会话/线程（record 串——发送零派发，便于独立验证）。
      const projDir = join(tmpRoot, 'proj');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'README.md'), '# r52\n', 'utf8');
      await h.bundle.loader.openProjectByPath(projDir);
      const projId = (h.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }).id;
      h.db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?,'Guide A','agent',1)").run(projId);
      h.db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
      h.db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA')").run();
      h.db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
      await h.bundle.loader.refreshRooms();
      const rr0 = await h.raw('message.submit', { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r52 记录串根', intent: 'record_only', mentions: [] });
      expect(rr0.ok).toBe(true);
      const anchor = h.db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r52 记录串根%'").get() as { id: string };
      const th = h.db.prepare('SELECT id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id) as { id: string };
      // 任务线程夹具（验收深链用）：派发一条 → 线程带根任务。
      const rd = await h.raw('message.submit', { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r52 任务根', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
      expect(rd.ok).toBe(true);
      const anchor2 = h.db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r52 任务根%'").get() as { id: string };
      const th2 = h.db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor2.id) as { id: string; root_task_id: string };

      // 线程实体装载（buildThreadEnvelope 的 conversationId 来源——未装载不发送）。
      await h.bundle.loader.loadThread(th.id);
      // ── ① 附件归属：uploadId 收敛，同名文件不串（store 层反例——A 迟到回执不改 B） ──
      const { store } = h.bundle;
      store.addUploadItem({ uploadId: 'upl_A', draftKey: 'thread:TA', conversationId: 'convA', name: 'same.md', size: 10, status: 'uploading' });
      store.addUploadItem({ uploadId: 'upl_B', draftKey: 'thread:TB', conversationId: 'convA', name: 'same.md', size: 10, status: 'uploading' });
      store.settleUpload('thread:TA', 'upl_A', { status: 'ready', attachmentId: 'art_A' }); // A 的回执先到
      store.settleUpload('thread:TB', 'upl_B', { status: 'ready', attachmentId: 'art_B' }); // B 的回执后到
      const items52 = h.bundle.store.getState().uploadItems;
      expect(items52['thread:TA']?.map((x) => x.attachmentId)).toEqual(['art_A']); // 各归各草稿
      expect(items52['thread:TB']?.map((x) => x.attachmentId)).toEqual(['art_B']); // 不按文件名匹配
      // 上传中移除：回执到达即弃（不复活）。
      store.addUploadItem({ uploadId: 'upl_C', draftKey: 'thread:TC', conversationId: 'convA', name: 'x.md', size: 1, status: 'uploading' });
      store.removeUploadItem('thread:TC', 'upl_C');
      store.settleUpload('thread:TC', 'upl_C', { status: 'ready', attachmentId: 'art_C' });
      expect(h.bundle.store.getState().uploadItems['thread:TC'] ?? []).toHaveLength(0); // 已移除→丢弃
      // refs 清算：只清已发 refs，新附件保留。
      store.clearSettledUploads('thread:TB', ['art_B']);
      expect((h.bundle.store.getState().uploadItems['thread:TB'] ?? []).map((x) => x.attachmentId)).toEqual([]);

      // ── ② fatal UTF-8：坏字节零上传/零 artifact（File.text() 有损路径已废） ──
      const bad = new File([Uint8Array.from([0x41, 0xc3, 0x28])], 'invalid-utf8.md', { type: 'text/markdown' });
      await expect(h.bundle.loader.uploadAttachmentFile('convA', bad)).rejects.toThrow('UTF-8');
      expect(h.sent.filter((e) => e.method === 'attachment.uploadText')).toHaveLength(0); // 零上传命令
      expect((h.db.prepare('SELECT count(*) c FROM artifacts').get() as { c: number }).c).toBe(0); // 零 artifact
      // 合法中文文本照常上传。
      const good = new File(['第五十二轮中文样本'], '样本.md', { type: 'text/markdown' });
      const up = await h.bundle.loader.uploadAttachmentFile('convA', good);
      expect(up.kind).toBe('text_file');

      // ── ③ 深链分列：#delivery= 带 threadId；房间会话未知归属→主池而非空 DM；DM 任务→DM ──
      h.db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run(projId);
      const dlvId = `dlv_${randomUUID().slice(0, 6)}`;
      h.db.prepare("INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES (?, ?, 1, ?, '[]', '[]', '[]', 'pending')").run(dlvId, th2.root_task_id, 'e'.repeat(64));
      const dv = await h.raw('deepLink.resolve', { hash: `#delivery=${dlvId}` });
      expect((dv.data as { threadId: string | null }).threadId).toBe(th2.id); // DTO 补齐（此前缺→空私信）
      const stateRoute = h.bundle.store.getState();
      expect(h.bundle.deepLink.routeForResolved(dv.data as Record<string, unknown>, stateRoute)).toBe(`/thread/${th2.id}?tab=task`);
      // 房间会话、无线程（异常形态）→ 按已装载房间落主池，不默认 DM。
      expect(h.bundle.deepLink.routeForResolved({ kind: 'task', projectId: projId, conversationId: 'convA', threadId: null, taskId: 't_x' }, stateRoute)).toBe('/room/roomA');
      // 完全未知会话 → null（如实报错，不静默跳转）。
      expect(h.bundle.deepLink.routeForResolved({ kind: 'msg', projectId: projId, conversationId: 'conv_unknown', threadId: null }, stateRoute)).toBeNull();
      // DM 任务（dm_turn 无线程）→ DM。
      h.db.prepare("INSERT INTO conversations (id, project_id, kind) VALUES ('convDm1', ?, 'dm')").run(projId);
      h.db.prepare('INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').run(projId, 'convDm1', 'human', 'u_local', projId, 'convDm1', 'agent', 'mA');
      await h.bundle.loader.refreshDms(); // DM 归属按已装载会话分列（真实流程在 openProject 后已载）
      expect(h.bundle.deepLink.routeForResolved({ kind: 'task', projectId: projId, conversationId: 'convDm1', threadId: null, taskId: 't_dm' }, h.bundle.store.getState())).toBe('/dm/convDm1');

      // ── ④ imageAck 端到端：图片+派发无确认=服务端拒；omit-images=接受且消息挂图片 ──
      const img = new File([MINI_PNG], 'mini.png', { type: 'image/png' });
      const upImg = await h.bundle.loader.uploadAttachmentFile('convA', img);
      expect(upImg.kind).toBe('image_file');
      // 图片门作用于**派发路由**（房间根消息 @成员）——记录串零派发不设门（合同口径）。
      const noAck = await h.bundle.loader.sendEnvelope({ commandId: `cmd_${randomUUID().slice(0, 8)}`, method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: '带图片的派发（无确认）', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }], attachmentRefs: [upImg.attachmentId] } });
      expect(noAck.status).toBe('failed');
      expect(noAck.error).toContain('IMAGE_INPUT_UNVERIFIED');
      const withAckRaw = await h.bundle.loader.sendEnvelope({ commandId: `cmd_${randomUUID().slice(0, 8)}`, method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: '带图片的派发（仅发送文字确认）', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }], attachmentRefs: [upImg.attachmentId], imageAck: 'omit-images' } });
      if (withAckRaw.status !== 'ok') console.log('WITHACK_ERR=', JSON.stringify(withAckRaw));
      expect(withAckRaw.status).toBe('ok');

      // ── ⑤ attachmentRanges 冻结：CSV 上传→真实表名范围→信封携带→服务端接受 ──
      const csv = new File(['h1,h2\n1,2\n'], '表.csv', { type: 'text/csv' });
      const upCsv = await h.bundle.loader.uploadAttachmentFile('convA', csv);
      expect(upCsv.kind).toBe('sheet_file');
      const off = await h.raw('attachment.previewOffice', { attachmentId: upCsv.attachmentId });
      const sheetName = ((off.data as { sheets: Array<{ name: string }> }).sheets[0] ?? { name: 'Sheet1' }).name;
      const range = `${sheetName}!A1:B2`;
      const env = h.bundle.loader.buildThreadEnvelope(`cmd_${randomUUID().slice(0, 8)}`, th.id, '带表格范围的记录', 'record_only', [upCsv.attachmentId], { attachmentRanges: { [upCsv.attachmentId]: range } });
      expect((env.params as { attachmentRanges?: Record<string, string> }).attachmentRanges).toEqual({ [upCsv.attachmentId]: range });
      expect((env.params as { attachmentRefs?: string[] }).attachmentRefs).toEqual([upCsv.attachmentId]);
      const r5 = await h.bundle.loader.sendEnvelope(env);
      expect(r5.status).toBe('ok');
      const attMsg = h.db.prepare("SELECT id FROM messages WHERE body_json LIKE '%带表格范围的记录%'").get() as { id: string };
      expect((h.db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(attMsg.id) as { c: number }).c).toBe(1);
      // 草稿范围助手（预览面板「设为注入范围」）：附件先进草稿（真实流程=上传回执写入）→范围写入→信封冻结读取。
      h.bundle.store.setDraftFull('thread:TR', { body: '', mentions: [], attachments: [{ attachmentId: upCsv.attachmentId, name: '表.csv', kind: 'sheet_file' }], access: 'default', sendAs: 'ai' });
      h.bundle.loader.setDraftAttachmentRange('thread:TR', upCsv.attachmentId, range);
      expect(h.bundle.loader.attachmentRangesFromDraft('thread:TR')).toEqual({ [upCsv.attachmentId]: range });
      h.bundle.loader.setDraftAttachmentRange('thread:TR', upCsv.attachmentId, '');
      expect(h.bundle.loader.attachmentRangesFromDraft('thread:TR')).toBeUndefined(); // 清除=默认窗口

      // ── ⑥ 未知信封重试：同号同参（含 refs/imageAck/ranges）逐字一致+业务恰一次 ──
      const cmdR = `cmd_${randomUUID().slice(0, 8)}`;
      const envR = h.bundle.loader.buildThreadEnvelope(cmdR, th.id, 'r52 未知重试样本', 'record_only', [up.attachmentId]);
      const r6 = await h.bundle.loader.sendEnvelope(envR);
      expect(r6.status).toBe('ok');
      const replay = await h.bundle.loader.sendEnvelope(JSON.parse(JSON.stringify(envR)) as typeof envR); // 同号同参重放
      expect(replay.status).toBe('ok');
      const cnt = (h.db.prepare("SELECT count(*) c FROM messages WHERE body_json LIKE '%r52 未知重试样本%'").get() as { c: number }).c;
      expect(cnt).toBe(1); // 幂等恰一次

      // ── ⑦ 停止门：终态拒绝（不伪造停止）沿 R51 合同 ──
      const stopNone = await h.bundle.loader.stopThreadTask(th.id);
      expect(stopNone.ok).toBe(false); // 记录串无任务详情
    } finally {
      h.close();
    }
  });
});
