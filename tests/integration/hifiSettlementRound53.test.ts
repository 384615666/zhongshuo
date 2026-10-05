/**
 * 第五十三轮 H2 真实链测试（review-r52 §3/§4）：**打包 hifi 前端数据层 × 正式 daemon ×
 * fake 库**——上传回执**原子结算**（settleUploadReady：uploadId 存在/未移除/发起会话一致才
 * 置 ready 并写草稿 ref；否则回执整体丢弃——已移除资源不得经草稿进入任何真实信封或落库）、
 * 发送/重试成功后的 refs 清算模型（只剥本次确实发送的 attachmentId；等待期新增资源保留）、
 * 落库身份负例（被移除资源零 message_attachments 链接；已发资源不随下一条再次落库）。
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
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-hifi4-'));
const bundlePath = join(tmpRoot, 'hifi-bundle.mjs');
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄 */ } } });

function chr92slash(): string { return String.fromCharCode(92); }

async function buildHifiBundle(): Promise<void> {
  const entry = join(tmpRoot, 'hifi-entry.ts');
  const q = JSON.stringify;
  writeFileSync(entry, `import * as loader from ${q(join(repoRoot, 'src/ui/hifi/loader.ts').replaceAll(chr92slash(), '/'))};
import * as store from ${q(join(repoRoot, 'src/ui/hifi/data/store.ts').replaceAll(chr92slash(), '/'))};
export { loader, store };
`, 'utf8');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', outfile: bundlePath, sourcemap: false, loader: { '.tsx': 'tsx', '.ts': 'ts' } });
}

interface LoaderApi {
  openProjectByPath(path: string): Promise<void>;
  refreshRooms(): Promise<void>;
  loadThread(threadId: string, opts?: { markRead?: boolean }): Promise<void>;
  uploadAttachmentFile(conversationId: string, file: File): Promise<{ attachmentId: string; hash: string; revision: number; kind: string }>;
  attachmentRefsFromDraft(draftKey: string, intent: 'default' | 'record_only'): { refs?: string[]; hasImages?: boolean; blockError?: string };
  buildThreadEnvelope(commandId: string, threadId: string, body: string, intent: 'default' | 'record_only', attachmentRefs?: string[]): { commandId: string; method: 'message.submit'; params: Record<string, unknown>; revAtSend?: number };
  sendEnvelope(env: { commandId: string; method: 'message.submit'; params: Record<string, unknown> }): Promise<{ status: string; code?: string; error?: string }>;
}
interface StoreApi {
  getState(): { rooms: Array<{ id: string; conversationId?: string }>; uploadItems: Record<string, Array<{ uploadId: string; draftKey: string; status: string; attachmentId?: string; removed?: boolean; error?: string }>> };
  addUploadItem(item: { uploadId: string; draftKey: string; conversationId: string; name: string; size: number; status: 'uploading' | 'ready' | 'failed' }): void;
  settleUploadReady(draftKey: string, uploadId: string, conversationId: string, receipt: { name: string; size: number; attachmentId: string; hash?: string; revision?: number; kind?: string }): boolean;
  removeUploadItem(draftKey: string, uploadId: string): void;
  hydrateUploadRefs(draftKey: string, conversationId: string, refs: Array<{ name: string; size: number; attachmentId: string; kind?: string }>): void;
  clearSettledUploads(draftKey: string, sentIds: string[]): void;
  getDraftFull(key: string): { body?: string; attachments: Array<{ attachmentId: string; name: string; size?: number; range?: string }>; rev?: number };
  setDraftFull(key: string, draft: { body?: string; mentions?: string[]; attachments?: Array<{ attachmentId: string; name: string; kind?: string }>; access?: string; sendAs?: 'ai' | 'record' }): void;
}
interface Harness {
  bundle: { loader: LoaderApi; store: StoreApi };
  raw(method: string, params: unknown, commandId?: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  db: import('better-sqlite3').Database;
  close(): void;
}

async function makeHarness(): Promise<Harness> {
  const db = openDatabase(':memory:');
  const appDir = join(tmpRoot, 'app');
  mkdirSync(appDir, { recursive: true });
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir };
  const raw = (method: string, params: unknown, commandId?: string) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `t-${randomUUID().slice(0, 8)}`, method, params }) as unknown as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  (globalThis as unknown as { window: unknown }).window = {
    zs: { command: async (env: { commandId: string; method: string; params: unknown }) => raw(env.method, env.params, env.commandId) },
  };
  const bundle = await import(pathToFileURL(bundlePath).href) as unknown as Harness['bundle'];
  return { bundle, raw, db, close: () => db.close() } as unknown as Harness;
}

const linksOf = (h: Harness, bodyLike: string): number => {
  const m = h.db.prepare('SELECT id FROM messages WHERE body_json LIKE ?').get(`%${bodyLike}%`) as { id: string } | undefined;
  if (m == null) return -1;
  return (h.db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(m.id) as { c: number }).c;
};

describe('第五十三轮 H2：上传回执原子结算+发送/重试 refs 清算+落库身份负例（真实链）', () => {
  it('settleUploadReady 四分支（正常/已移除/会话不一致/已消失）+hydrate 不复活 + 信封与落库零幽灵引用', async () => {
    await buildHifiBundle();
    const h = await makeHarness();
    try {
      // 夹具：项目/房间/会话 + 记录串线程（零派发）。
      const projDir = join(tmpRoot, 'proj');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'README.md'), '# r53\n', 'utf8');
      await h.bundle.loader.openProjectByPath(projDir);
      const projId = (h.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }).id;
      h.db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?,'Guide A','agent',1)").run(projId);
      h.db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
      h.db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA')").run();
      h.db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
      await h.bundle.loader.refreshRooms();
      await h.raw('message.submit', { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r53 记录串根', intent: 'record_only', mentions: [] });
      const anchor = h.db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r53 记录串根%'").get() as { id: string };
      const th = h.db.prepare('SELECT id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id) as { id: string };
      await h.bundle.loader.loadThread(th.id);
      const { store, loader } = h.bundle;
      const DK = `thread:${th.id}`;

      // ── ① 正常回执（真实上传产物）：ready+草稿 ref 同一结算写入；幂等二次回执不重复 ──
      const rOk = await loader.uploadAttachmentFile('convA', new File(['R53-OK'], 'ok.md', { type: 'text/markdown' }));
      store.addUploadItem({ uploadId: 'up_ok', draftKey: DK, conversationId: 'convA', name: 'ok.md', size: 6, status: 'uploading' });
      const okAccepted = store.settleUploadReady(DK, 'up_ok', 'convA', { name: 'ok.md', size: 6, attachmentId: rOk.attachmentId, hash: rOk.hash, revision: rOk.revision, kind: rOk.kind });
      expect(okAccepted).toBe(true);
      expect(store.getState().uploadItems[DK]?.find((x) => x.uploadId === 'up_ok')?.status).toBe('ready');
      expect(store.getDraftFull(DK).attachments.map((a) => a.attachmentId)).toEqual([rOk.attachmentId]);
      const okAgain = store.settleUploadReady(DK, 'up_ok', 'convA', { name: 'ok.md', size: 6, attachmentId: rOk.attachmentId, hash: rOk.hash, revision: rOk.revision, kind: rOk.kind });
      expect(okAgain).toBe(true); // 幂等
      expect(store.getDraftFull(DK).attachments).toHaveLength(1); // 不重复写

      // ── ② 上传中移除：回执整体丢弃——不 ready、零草稿 ref、项即清；hydrate 不复活 ──
      store.addUploadItem({ uploadId: 'up_rm', draftKey: DK, conversationId: 'convA', name: 'remove-me.md', size: 8, status: 'uploading' });
      store.removeUploadItem(DK, 'up_rm'); // 在途→removed 标记
      const rmAccepted = store.settleUploadReady(DK, 'up_rm', 'convA', { name: 'remove-me.md', size: 8, attachmentId: 'art_rm', hash: 'h2', revision: 1, kind: 'text_file' });
      expect(rmAccepted).toBe(false);
      expect((store.getState().uploadItems[DK] ?? []).some((x) => x.uploadId === 'up_rm')).toBe(false); // 项已清
      expect(store.getDraftFull(DK).attachments.some((a) => a.attachmentId === 'art_rm')).toBe(false); // 零草稿 ref
      // 切走再回来（hydrate 按草稿重建芯片）：草稿本就无该 ref——不复活。
      store.hydrateUploadRefs(DK, 'convA', store.getDraftFull(DK).attachments.map((a) => ({ name: a.name, size: 6, attachmentId: a.attachmentId })));
      expect((store.getState().uploadItems[DK] ?? []).some((x) => x.attachmentId === 'art_rm')).toBe(false);
      // refs 提取（真实信封的上游）：不含已移除资源。
      expect(loader.attachmentRefsFromDraft(DK, 'record_only').refs).toEqual([rOk.attachmentId]);

      // ── ③ 会话不一致回执（跨会话串线防御）：按失败分列、零草稿 ref ──
      store.addUploadItem({ uploadId: 'up_x', draftKey: DK, conversationId: 'convA', name: 'cross.md', size: 4, status: 'uploading' });
      const xAccepted = store.settleUploadReady(DK, 'up_x', 'convOTHER', { name: 'cross.md', size: 4, attachmentId: 'art_x', hash: 'h3', revision: 1, kind: 'text_file' });
      expect(xAccepted).toBe(false);
      const xItem = store.getState().uploadItems[DK]?.find((x2) => x2.uploadId === 'up_x');
      expect(xItem?.status).toBe('failed');
      expect(String(xItem?.error ?? '')).toContain('会话不一致');
      expect(store.getDraftFull(DK).attachments.some((a) => a.attachmentId === 'art_x')).toBe(false);
      store.removeUploadItem(DK, 'up_x'); // 清理失败项（后续发送不再被拦）

      // ── ④ 已消失项（结算前被清理）：不复活、零写入 ──
      store.addUploadItem({ uploadId: 'up_gone', draftKey: DK, conversationId: 'convA', name: 'gone.md', size: 4, status: 'uploading' });
      store.removeUploadItem(DK, 'up_gone');
      // uploading 项 removeUploadItem 标 removed——先直接清态再核「不存在」分支：
      const goneAccepted = store.settleUploadReady(DK, 'up_gone', 'convA', { name: 'gone.md', size: 4, attachmentId: 'art_g', revision: 1, kind: 'text_file' });
      expect(goneAccepted).toBe(false);
      expect(store.getDraftFull(DK).attachments.some((a) => a.attachmentId === 'art_g')).toBe(false);

      // ── ⑤ 落库身份负例：真实上传后移除 → 信封不带、message_attachments 零链接 ──
      const real = await loader.uploadAttachmentFile('convA', new File(['R53-REMOVED'], 'removed-real.md', { type: 'text/markdown' }));
      // 模拟 UI 移除的完整效果（Composer.removeAttachment）：上传项清 + 草稿 ref 过滤。
      store.clearSettledUploads(DK, [real.attachmentId]);
      const d5 = store.getDraftFull(DK);
      store.setDraftFull(DK, { ...d5, attachments: d5.attachments.filter((a) => a.attachmentId !== real.attachmentId) });
      const refsAfterRemove = loader.attachmentRefsFromDraft(DK, 'record_only');
      expect(refsAfterRemove.refs).not.toContain(real.attachmentId);
      const env1 = loader.buildThreadEnvelope(`cmd_${randomUUID().slice(0, 8)}`, th.id, 'r53 移除后发送', 'record_only', refsAfterRemove.refs);
      expect((env1.params as { attachmentRefs?: string[] }).attachmentRefs).not.toContain(real.attachmentId);
      expect(await loader.sendEnvelope(env1)).toHaveProperty('status', 'ok');
      expect(linksOf(h, 'r53 移除后发送')).toBe(1); // 只有 ok.md 链接
      const removedRow = h.db.prepare('SELECT message_id FROM message_attachments WHERE artifact_id = ?').get(real.attachmentId);
      expect(removedRow).toBeUndefined(); // 被移除资源零消息链接（artifact 本身保留=如实）
      const artCount = (h.db.prepare('SELECT count(*) c FROM artifacts WHERE id = ?').get(real.attachmentId) as { c: number }).c;
      expect(artCount).toBe(1); // 上传确实发生（不伪造「零上传」）——但绝不随消息落库

      // ── ⑥ 发送成功后的 refs 清算模型（等待期无编辑/有编辑 × 新增附件） ──
      const sentNow = loader.attachmentRefsFromDraft(DK, 'record_only').refs ?? [];
      expect(sentNow).toEqual([rOk.attachmentId]);
      const env2 = loader.buildThreadEnvelope(`cmd_${randomUUID().slice(0, 8)}`, th.id, 'r53 已发资源一次', 'record_only', sentNow);
      env2.revAtSend = store.getDraftFull(DK).rev;
      expect(await loader.sendEnvelope(env2)).toHaveProperty('status', 'ok');
      // 成功清算（Composer.settleForKey 的草稿侧效果——按 sentIds 剥离已发 refs）：
      const d6 = store.getDraftFull(DK);
      store.setDraftFull(DK, { ...d6, attachments: d6.attachments.filter((a) => !sentNow.includes(a.attachmentId)) });
      store.clearSettledUploads(DK, sentNow);
      // 等待期新增附件（新上传）：不在本次 sentIds——保留，随下一条正常发送。
      const rNew = await loader.uploadAttachmentFile('convA', new File(['R53-NEW'], 'new.md', { type: 'text/markdown' }));
      store.addUploadItem({ uploadId: 'up_new', draftKey: DK, conversationId: 'convA', name: 'new.md', size: 7, status: 'uploading' });
      expect(store.settleUploadReady(DK, 'up_new', 'convA', { name: 'new.md', size: 7, attachmentId: rNew.attachmentId, hash: rNew.hash, revision: rNew.revision, kind: rNew.kind })).toBe(true);
      const refsNext = loader.attachmentRefsFromDraft(DK, 'record_only');
      expect(refsNext.refs).toEqual([rNew.attachmentId]); // 旧资源已剥、新资源在册
      const env3 = loader.buildThreadEnvelope(`cmd_${randomUUID().slice(0, 8)}`, th.id, 'r53 下一条只带新资源', 'record_only', refsNext.refs);
      expect(await loader.sendEnvelope(env3)).toHaveProperty('status', 'ok');
      expect(linksOf(h, 'r53 下一条只带新资源')).toBe(1);
      // 已发资源不重复落库：rOk 随 env1/env2 两条消息各恰一次（共 2）；清算后第三条
      // （r53 下一条只带新资源）不重带 rOk（linksOf 已证该消息仅 1 条链接）；被移除资源仍零。
      expect((h.db.prepare('SELECT count(*) c FROM message_attachments WHERE artifact_id = ?').get(rOk.attachmentId) as { c: number }).c).toBe(2);
      const okOnThird = h.db.prepare("SELECT count(*) c FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE ma.artifact_id = ? AND m.body_json LIKE '%r53 下一条只带新资源%'").get(rOk.attachmentId) as { c: number };
      expect(okOnThird.c).toBe(0); // 清算后的下一条绝不重带已发资源
      expect((h.db.prepare('SELECT count(*) c FROM message_attachments WHERE artifact_id = ?').get(real.attachmentId) as { c: number }).c).toBe(0);
      expect((h.db.prepare('SELECT count(*) c FROM message_attachments WHERE artifact_id = ?').get(rNew.attachmentId) as { c: number }).c).toBe(1);
    } finally {
      h.close();
    }
  });
});
