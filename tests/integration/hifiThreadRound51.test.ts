/**
 * 第五十一轮 H2 真实链测试（review-r50 §4）：**打包的 hifi 前端数据层 × 正式 daemon 命令面
 * × 独立 fake 库/worker**——回复串/任务详情/附件/深链 DTO 与合同本体。
 *
 * 覆盖：
 *  - thread.get：线程实体（含 conversationId）+根消息+水位；audience 越权拒绝。
 *  - 主池线程卡（room.pool→ThreadCard）：记录串 taskId=null 如实投影。
 *  - 线程回复：产品 builder（buildThreadEnvelope）完整目标（projectId/conversationId/
 *    threadId）→ 消息落线程（seq 递增）→ **root_task_id 不变（不另建根任务）**。
 *  - 记录串默认 record_only：零任务/零 run（消息保存但 disposition=none）。
 *  - 线程独立水位门：门关时不发 thread.markRead；未来序号服务端拒绝。
 *  - task.get DTO：pendingDelivery 只有 id/revision/manifest_hash 三重身份。
 *  - task.review 三重绑定：错 manifestHash → STALE_REVISION；对快照 accept → 任务 DONE。
 *  - 附件骨架：attachment.uploadText 真实回执 → attachmentRefs 进信封 → 消息挂附件；
 *    跨会话引用被 audience 拒绝；attachmentRefsFromDraft 图片+派发拦截（能力门同判）。
 *  - 深链映射（routeForResolved）：#task/#delivery → /thread/:id?tab=task；#msg 带线程 →
 *    /thread/:id?message=…。
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
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-hifi2-'));
const bundlePath = join(tmpRoot, 'hifi-bundle.mjs');
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

function chr92slash(): string { return String.fromCharCode(92); }

/** 打包真实 hifi 前端（loader+store+deepLink 映射——与 hifiFirstPackage 同构）。 */
async function buildHifiBundle(): Promise<void> {
  const entry = join(tmpRoot, 'hifi-entry.ts');
  const loaderPath = join(repoRoot, 'src', 'ui', 'hifi', 'loader.ts').replaceAll(chr92slash(), '/');
  const storePath = join(repoRoot, 'src', 'ui', 'hifi', 'data', 'store.ts').replaceAll(chr92slash(), '/');
  const deepLinkPath = join(repoRoot, 'src', 'ui', 'hifi', 'lib', 'deepLink.ts').replaceAll(chr92slash(), '/');
  writeFileSync(entry, `import * as loader from ${JSON.stringify(loaderPath)};
import * as store from ${JSON.stringify(storePath)};
import * as deepLink from ${JSON.stringify(deepLinkPath)};
export { loader, store, deepLink };
`, 'utf8');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', outfile: bundlePath, sourcemap: false, loader: { '.tsx': 'tsx', '.ts': 'ts' } });
}

interface LoaderApi {
  openProjectByPath(path: string): Promise<void>;
  refreshRooms(): Promise<void>;
  loadRoomPool(roomId: string): Promise<void>;
  loadThread(threadId: string, opts?: { markRead?: boolean }): Promise<void>;
  refreshThreadTask(threadId: string): Promise<void>;
  buildThreadEnvelope(commandId: string, threadId: string, body: string, intent: 'default' | 'record_only', attachmentRefs?: string[]): { commandId: string; method: 'message.submit'; params: Record<string, unknown>; targetLabel: string };
  sendEnvelope(env: { commandId: string; method: 'message.submit'; params: Record<string, unknown> }): Promise<{ status: string; code?: string; error?: string }>;
  stopThreadTask(threadId: string): Promise<{ ok: boolean; error?: string }>;
  submitTaskReview(snapshot: { taskId: string; deliveryId: string; deliveryRevision: number; manifestHash: string }, decision: 'accept' | 'changes_requested', note?: string, threadIdForRefresh?: string): Promise<{ ok: boolean; error?: string }>;
  uploadAttachmentFile(conversationId: string, file: File): Promise<{ attachmentId: string; hash: string; revision: number; kind: string }>;
  attachmentRefsFromDraft(draftKey: string, intent: 'default' | 'record_only'): { refs?: string[]; hasImages?: boolean; blockError?: string };
}
interface StoreApi {
  getState(): {
    rooms: Array<{ id: string; conversationId?: string; memberIds: string[] }>;
    roomPool: Record<string, Array<{ threadId: string; taskId: string | null; replyCount: number; unread: number }>>;
    threadEntities: Record<string, { id: string; conversationId?: string; rootTaskId?: string; roomId: string }>;
    threadAnchors: Record<string, { id: string; body: string } | null>;
    threadMessages: Record<string, Array<{ id: string; threadMessageSeq?: number; body: string; authorType: string }>>;
    threadTasks: Record<string, { id: string; status: string; pendingDelivery: { id: string; revision: number; manifestHash: string } | null; activeRun: { id: string; status: string } | null; stopGeneration: number }>;
    threadReadSeq: Record<string, number>;
    readErrors: Record<string, string>;
  };
  setThreadReadGate?(gate: ((threadId: string) => boolean) | null): void;  setDraftFull(key: string, draft: { body?: string; mentions?: string[]; attachments?: Array<{ attachmentId: string; name: string; size?: number; kind?: string }>; access?: string; sendAs?: 'ai' | 'record' }): void;
}
interface DeepLinkApi {
  routeForResolved(res: Record<string, unknown>, s: unknown): string | null;
}
interface Harness {
  bundle: { loader: LoaderApi; store: StoreApi; deepLink: DeepLinkApi };
  raw(method: string, params: unknown, commandId?: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  db: import('better-sqlite3').Database;
  worker(): Promise<void>;
  close(): void;
}

async function makeHarness(): Promise<Harness> {
  const db = openDatabase(':memory:');
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
  const appDir = join(tmpRoot, 'app');
  mkdirSync(appDir, { recursive: true });
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir };
  const raw = (method: string, params: unknown, commandId?: string) =>
    dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `t-${randomUUID().slice(0, 8)}`, method, params }) as unknown as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  (globalThis as unknown as { window: unknown }).window = {
    zs: { command: async (env: { commandId: string; method: string; params: unknown }) => raw(env.method, env.params, env.commandId) },
  };
  const bundle = await import(pathToFileURL(bundlePath).href) as unknown as Harness['bundle'];
  return {
    bundle,
    raw,
    db,
    worker: async () => { await new DispatchWorker({ db, adapter, leaseOwner: 'w-hifi2', appDataDir: appDir }).runOnce(); },
    close: () => { void adapter.closeAllSessions().catch(() => {}); db.close(); },
  } as unknown as Harness;
}

describe('第五十一轮 H2：回复串/任务详情/附件/深链（真实链）', () => {
  it('线程卡→thread.get→回复不另建根任务→记录串默认仅记录→独立水位门→验收三重绑定→附件信封→深链映射', async () => {
    await buildHifiBundle();
    const h = await makeHarness();
    try {
      const projDir = join(tmpRoot, 'proj-a');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'README.md'), '# 第五十一轮线程链样本\n', 'utf8');
      await h.bundle.loader.openProjectByPath(projDir);
      // 正式 schema 造两 agent + 房间 + 会话（镜像 hifiFirstPackage 造数——镜像 boardFormalStates）。
      const projIdRow = h.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
      h.db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?,'Guide A','agent',1), ('mB',?,'Guide B','agent',1)`).run(projIdRow.id, projIdRow.id);
      const roomId = 'room_hifi2';
      const convId = 'convRoomHifi2';
      h.db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, '默认房间', 'mA')`).run(roomId, projIdRow.id);
      h.db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?), (?, ?)').run(roomId, 'mA', roomId, 'mB');
      h.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)`).run(convId, projIdRow.id, roomId);
      await h.bundle.loader.refreshRooms();
      const room = h.bundle.store.getState().rooms.find((r) => r.id === roomId);
      if (room == null) throw new Error('房间未装载（refreshRooms 失败）');
      expect(room.conversationId).toBe(convId);
      expect([...room.memberIds].sort()).toEqual(['mA', 'mB']);

      // ── 房间派发（room_root @成员A）→ worker 执行 → 线程出现 ──
      const cmd1 = `cmd_${randomUUID().slice(0, 8)}`;
      const dispatchEnv = {
        commandId: cmd1, method: 'message.submit' as const,
        params: { target: { kind: 'room_root', projectId: projIdRow.id, conversationId: convId, roomId }, body: '第五十一轮线程链样本', intent: 'default' as const, mentions: [{ kind: 'member' as const, memberId: 'mA' }] },
      };
      const r1 = await h.bundle.loader.sendEnvelope(dispatchEnv as never);
      expect(r1.status).toBe('ok');
      const rootMsg = h.db.prepare("SELECT id FROM messages WHERE body_json LIKE '%第五十一轮线程链样本%'").get() as { id: string };
      expect(rootMsg).toBeDefined();
      // 有界多泵（runOnce=单任务单轮）——直至线程内有 agent 回复。
      let threadReply: unknown;
      for (let i = 0; i < 4; i += 1) {
        await h.worker();
        const thProbe = h.db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(rootMsg.id) as { id: string; root_task_id: string } | undefined;
        if (thProbe != null) {
          const c = (h.db.prepare("SELECT count(*) c FROM messages WHERE thread_id = ? AND author_type = 'agent'").get(thProbe.id) as { c: number }).c;
          if (c > 0) { threadReply = thProbe; break; }
        }
      }
      expect(threadReply).toBeTruthy();
      // root_task_id 关联（conversation_threads.anchor_message_id → root_task_id——房间根消息
      // messages.task_id 本就 NULL，任务身份在线程关系上）。
      const th = h.db.prepare('SELECT id, root_task_id, last_message_seq FROM conversation_threads WHERE anchor_message_id = ?').get(rootMsg.id) as { id: string; root_task_id: string; last_message_seq: number };
      expect(th).toBeDefined();
      expect(th.root_task_id).toBeTruthy();
      const rootTaskId = th.root_task_id;

      // ── 主池线程卡（room.pool→ThreadCard）：任务卡带任务号/回复数 ──
      await h.bundle.loader.loadRoomPool(roomId);
      const card = h.bundle.store.getState().roomPool[room.id]?.find((c) => c.threadId === th.id);
      expect(card).toBeDefined();
      expect(card!.taskId).toBe(rootTaskId);
      expect(card!.replyCount).toBeGreaterThanOrEqual(1); // worker 回复已在线程内

      // ── thread.get：实体（conversationId！发送目标用）+根消息+水位 ──
      await h.bundle.loader.loadThread(th.id);
      const st1 = h.bundle.store.getState();
      expect(st1.threadEntities[th.id]?.conversationId).toBe(convId);
      expect(st1.threadAnchors[th.id]?.body).toContain('第五十一轮线程链样本');
      expect((st1.threadMessages[th.id] ?? []).length).toBeGreaterThanOrEqual(1);

      // ── 线程回复（产品 builder）：完整目标+**不另建根任务** ──
      const cmd2 = `cmd_${randomUUID().slice(0, 8)}`;
      const env2 = h.bundle.loader.buildThreadEnvelope(cmd2, th.id, '跟进：补充一点', 'default');
      const target2 = env2.params.target as Record<string, string>;
      expect(target2).toEqual({ kind: 'thread', projectId: projIdRow.id, conversationId: convId, threadId: th.id });
      const r2 = await h.bundle.loader.sendEnvelope(env2);
      expect(r2.status).toBe('ok');
      const taskCount = (h.db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c;
      const thAfter = h.db.prepare('SELECT root_task_id FROM conversation_threads WHERE id = ?').get(th.id) as { root_task_id: string };
      expect(thAfter.root_task_id).toBe(rootTaskId); // 根任务不变
      const replyRow = h.db.prepare("SELECT thread_message_seq FROM messages WHERE thread_id = ? AND body_json LIKE '%补充一点%'").get(th.id) as { thread_message_seq: number };
      expect(replyRow).toBeDefined();
      // 任务数不因线程回复增加（根任务仍 1——room_root 建的那条；线程跟进零新任务）。
      expect(taskCount).toBe(1);

      // ── 记录串（root_task_id 空）默认仅记录：零任务/零 run ──
      const cmdR = `cmd_${randomUUID().slice(0, 8)}`;
      const rr = await h.raw('message.submit', { target: { kind: 'room_root', projectId: projIdRow.id, conversationId: convId, roomId: room.id }, body: '纯记录串样本', intent: 'record_only', mentions: [] }, cmdR);
      expect(rr.ok).toBe(true);
      const recAnchor = h.db.prepare("SELECT id FROM messages WHERE body_json LIKE '%纯记录串样本%'").get() as { id: string };
      const recThread = h.db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(recAnchor.id) as { id: string; root_task_id: string | null };
      expect(recThread).toBeDefined();
      expect(recThread.root_task_id).toBeNull();
      const cmdR2 = `cmd_${randomUUID().slice(0, 8)}`;
      const rr2 = await h.bundle.loader.sendEnvelope({ commandId: cmdR2, method: 'message.submit', params: { target: { kind: 'thread', projectId: projIdRow.id, conversationId: convId, threadId: recThread.id }, body: '记录串里的追加', intent: 'record_only', mentions: [] } } as never);
      expect(rr2.status).toBe('ok');
      const recAfter = h.db.prepare('SELECT root_task_id FROM conversation_threads WHERE id = ?').get(recThread.id) as { root_task_id: string | null };
      expect(recAfter.root_task_id).toBeNull(); // 永不唤醒——不建任务
      const runsTotal = (h.db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c;
      expect(runsTotal).toBe(1); // 只有首个派发的 run

      // ── 线程独立水位门：门关（缺省拒绝）→ 不发 thread.markRead；未来序号服务端拒绝 ──
      await h.bundle.loader.loadThread(th.id, { markRead: true });
      const wm0 = h.db.prepare('SELECT last_read_message_seq FROM thread_read_states WHERE thread_id = ?').get(th.id) as { last_read_message_seq: number } | undefined;
      expect(wm0).toBeUndefined(); // 门缺省拒绝——零水位写入
      h.bundle.store.setThreadReadGate?.(() => true);
      await h.bundle.loader.loadThread(th.id, { markRead: true });
      await new Promise((r) => setTimeout(r, 200)); // markRead 为发后即忘——有界等待落库
      const wm1 = h.db.prepare('SELECT last_read_message_seq FROM thread_read_states WHERE thread_id = ?').get(th.id) as { last_read_message_seq: number } | undefined;
      expect(wm1?.last_read_message_seq).toBeGreaterThan(0); // 门开——水位推进
      const future = await h.raw('thread.markRead', { threadId: th.id, throughMessageSeq: 99999 });
      expect(future.ok).toBe(false);
      expect(future.error?.code).toBe('VALIDATION_INVALID');

      // ── task.get DTO：pendingDelivery 三重身份（id/revision/manifest_hash——不猜其余） ──
      const tgRaw = await h.raw('task.get', { taskId: rootTaskId });
      expect(tgRaw.ok).toBe(true); // task.get 合同本体可达（DTO 投影经 refreshThreadTask 断言）
      // fake worker 无交付（review_policy 非 user_review）——注入一条 pending 交付验证三重绑定。
      const deliveryId = `dlv_${randomUUID().slice(0, 8)}`;
      h.db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run(projIdRow.id);
      h.db.prepare("UPDATE tasks SET status = ?, review_policy = 'user_review' WHERE id = ?").run('REVIEW', rootTaskId);
      // auto_deliver 首版交付（not_required）已占 revision 1——注入 v2 待验收（用户策略切换后）。
      h.db.prepare('INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES (?, ?, 2, ?, ?, ?, ?, ?)')
        .run(deliveryId, rootTaskId, 'a'.repeat(64), '[]', '[]', '[]', 'pending');
      await h.bundle.loader.refreshThreadTask(th.id);
      const detail = h.bundle.store.getState().threadTasks[th.id];
      expect(detail?.status).toBe('REVIEW');
      expect(detail?.pendingDelivery).toEqual({ id: deliveryId, revision: 2, manifestHash: 'a'.repeat(64) });
      // 错 manifestHash → STALE_REVISION（三重绑定最后一级）。
      const bad = await h.bundle.loader.submitTaskReview({ taskId: rootTaskId, deliveryId, deliveryRevision: 2, manifestHash: 'b'.repeat(64) }, 'accept', undefined, th.id);
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('交付内容不符');
      // 对冻结快照 accept → 任务 DONE（Git 提交不等同验收——只写验收账本与任务状态）。
      const good = await h.bundle.loader.submitTaskReview({ taskId: rootTaskId, deliveryId, deliveryRevision: 2, manifestHash: 'a'.repeat(64) }, 'accept', undefined, th.id);
      expect(good.ok).toBe(true);
      expect((h.db.prepare('SELECT status FROM tasks WHERE id = ?').get(rootTaskId) as { status: string }).status).toBe('DONE');

      // ── 附件骨架：uploadText 回执 → refs 进信封 → 消息挂附件；跨会话引用拒绝；图片门 ──
      const up = await h.bundle.loader.uploadAttachmentFile(convId, new File(['第五十一轮附件样本内容'], '样本.md', { type: 'text/markdown' }));
      expect(up.attachmentId).toMatch(/^art_/);
      expect(up.kind).toBe('text_file');
      // 第五十二轮起 refs 从**草稿**取（store 真源）——先写草稿再读（同真实 Composer 流程）。
      h.bundle.store.setDraftFull(`thread:${th.id}`, { body: '', mentions: [], attachments: [{ name: '样本.md', size: 100, attachmentId: up.attachmentId, kind: 'text_file' }], access: 'default', sendAs: 'ai' });
      const refs = h.bundle.loader.attachmentRefsFromDraft(`thread:${th.id}`, 'default');
      expect(refs.refs).toEqual([up.attachmentId]);
      const cmd3 = `cmd_${randomUUID().slice(0, 8)}`;
      const env3 = h.bundle.loader.buildThreadEnvelope(cmd3, th.id, '带附件的跟进', 'default', refs.refs);
      expect((env3.params as { attachmentRefs?: string[] }).attachmentRefs).toEqual([up.attachmentId]);
      const r3 = await h.bundle.loader.sendEnvelope(env3);
      expect(r3.status).toBe('ok');
      const attMsg = h.db.prepare("SELECT id FROM messages WHERE thread_id = ? AND body_json LIKE '%带附件的跟进%'").get(th.id) as { id: string };
      const linkRow = h.db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(attMsg.id) as { c: number };
      expect(linkRow.c).toBe(1);
      // 图片+派发 → hasImages 标记（第五十二轮：显式二选一由 Composer 呈现——数据层只给事实）。
      h.bundle.store.setDraftFull('t-img', { body: '', mentions: [], attachments: [{ name: 'x.png', size: 100, attachmentId: 'art_img', kind: 'image_file' }], access: 'default', sendAs: 'ai' });
      const imgGate = h.bundle.loader.attachmentRefsFromDraft('t-img', 'default');
      expect(imgGate.hasImages).toBe(true);
      const recImg = h.bundle.loader.attachmentRefsFromDraft('t-img', 'record_only');
      expect(recImg.hasImages !== true).toBe(true); // 仅记录=零派发，不设门
      // 跨会话引用（另一会话上传的 ref 提交到本会话）→ audience 拒绝。
      const conv2 = `conv_other_${randomUUID().slice(0, 6)}`;
      h.db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_other_1', ?, '另一房间', 'mA')").run(projIdRow.id);
      h.db.prepare('INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, ?, ?)').run(conv2, projIdRow.id, 'room', 'room_other_1');
      const upOther = await h.raw('attachment.uploadText', { conversationId: conv2, filename: '他处.md', content: '其它会话内容' });
      expect(upOther.ok).toBe(true);
      const cross = await h.raw('message.submit', { target: { kind: 'thread', projectId: projIdRow.id, conversationId: convId, threadId: th.id }, body: '跨会话引用', intent: 'record_only', mentions: [], attachmentRefs: [(upOther.data as { attachmentId: string }).attachmentId] });
      expect(cross.ok).toBe(false);
      expect(cross.error?.code).toBe('FORBIDDEN');

      // ── 深链映射（routeForResolved 纯函数——服务端事实→内部路由） ──
      const stateForRoute = h.bundle.store.getState();
      const rTask = h.bundle.deepLink.routeForResolved({ kind: 'task', projectId: projIdRow.id, conversationId: convId, threadId: th.id, taskId: rootTaskId }, stateForRoute);
      expect(rTask).toBe(`/thread/${th.id}?tab=task`);
      const rDelivery = h.bundle.deepLink.routeForResolved({ kind: 'delivery', projectId: projIdRow.id, conversationId: convId, threadId: th.id, taskId: rootTaskId, deliveryId, revision: 1, manifestHash: 'a'.repeat(64) }, stateForRoute);
      expect(rDelivery).toBe(`/thread/${th.id}?tab=task`);
      const msgId = h.db.prepare('SELECT id FROM messages WHERE thread_id = ? ORDER BY thread_message_seq DESC LIMIT 1').get(th.id) as { id: string };
      const rMsg = h.bundle.deepLink.routeForResolved({ kind: 'msg', projectId: projIdRow.id, conversationId: convId, threadId: th.id, messageId: msgId.id }, stateForRoute);
      expect(rMsg).toBe(`/thread/${th.id}?message=${msgId.id}`);
      const rDm = h.bundle.deepLink.routeForResolved({ kind: 'dm', projectId: projIdRow.id, conversationId: 'conv_dm_x' }, stateForRoute);
      expect(rDm).toBe('/dm/conv_dm_x');
      // 真实 deepLink.resolve 服务端解析（合同本体）。
      const resolved = await h.raw('deepLink.resolve', { hash: `#task=${rootTaskId}` });
      expect(resolved.ok).toBe(true);
      expect((resolved.data as { threadId: string }).threadId).toBe(th.id);

      // ── task.stop 绑定：无活跃 run → 明确失败（不伪造停止） ──
      const stopNone = await h.bundle.loader.stopThreadTask(th.id);
      expect(stopNone.ok).toBe(false);
      expect(stopNone.error).toContain('已终态'); // DONE 后不再伪造停止入口
    } finally {
      h.close();
    }
  });
});
