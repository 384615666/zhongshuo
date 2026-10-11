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
import type { Database } from 'better-sqlite3';
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
  loadThreadOlder(threadId: string, beforeSeq: number): Promise<number>;
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
  setState(fn: (s: ReturnType<StoreApi['getState']>) => ReturnType<StoreApi['getState']>): void;
  getState(): {
    activeProjectId: string; loadGen: number;
    messages: Array<{id: string; projectId: string; body: string; authorId: string; formalAttachments?: Array<{artifactId: string}>}>;
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
  db: Database;
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

describe('R76 atomic attachment roots', () => {
  it('cold pool, alternating loads, authoritative empty, read failure and reversed replies', async () => {
    await buildHifiBundle(); const h = await makeHarness();
    try {
      const project = join(tmpRoot, 'r76'); mkdirSync(project, { recursive: true });
      await h.bundle.loader.openProjectByPath(project);
      const pid = (h.db.prepare('SELECT id FROM projects LIMIT 1').get() as {id:string}).id;
      const made = await h.raw('room.create', {projectId:pid,name:'R76'});
      const {room} = made.data as {room:{id:string;conversationId:string}};
      await h.bundle.loader.refreshRooms();
      const ids: string[] = [];
      for (const filename of ['中文一.md','中文二.md']) {
        const up=await h.raw('attachment.uploadText',{conversationId:room.conversationId,filename,content:filename});
        ids.push((up.data as {attachmentId:string}).attachmentId);
      }
      const submitted=await h.raw('message.submit',{target:{kind:'room_root',projectId:pid,conversationId:room.conversationId,roomId:room.id},body:'',intent:'record_only',mentions:[],attachmentRefs:ids});
      expect(submitted.ok).toBe(true);
      const th=h.db.prepare('SELECT id,anchor_message_id FROM conversation_threads WHERE room_id=?').get(room.id) as {id:string;anchor_message_id:string};
      // Real counterexample: imported author is not the local user's synthetic "you".
      h.db.prepare("UPDATE messages SET author_id='original-author' WHERE id=?").run(th.anchor_message_id);
      const root=()=>h.bundle.store.getState().messages.find(m=>m.id===th.anchor_message_id)!;
      const current=()=>root().formalAttachments?.map(a=>a.artifactId);
      await h.bundle.loader.loadRoomPool(room.id);
      expect(current()).toEqual(ids); expect(root().authorId).toBe('original-author'); expect(root().body).toBe('');
      for(let i=0;i<4;i++){await h.bundle.loader.loadThread(th.id);expect(current()).toEqual(ids);await h.bundle.loader.loadRoomPool(room.id);expect(current()).toEqual(ids);}
      let release: (()=>void)|undefined; let captured: unknown;
      const bridge=(globalThis as unknown as {window:{zs:{command:(env:{commandId:string;method:string;params:unknown})=>Promise<unknown>}}}).window.zs;
      bridge.command=async env=>{const r=await h.raw(env.method,env.params,env.commandId);if(env.method==='room.pool'){captured=r;await new Promise<void>(res=>{release=res;});}return r;};
      const old=h.bundle.loader.loadRoomPool(room.id);
      while(captured==null)await new Promise(r=>setTimeout(r,5));
      h.db.prepare('DELETE FROM message_attachments WHERE message_id=?').run(th.anchor_message_id);
      bridge.command=env=>h.raw(env.method,env.params,env.commandId);
      await h.bundle.loader.loadThread(th.id); expect(current()).toEqual([]);
      release!();await old;expect(current()).toEqual([]);
      h.db.prepare('INSERT INTO message_attachments(id,message_id,artifact_id,display_name,source_hash) VALUES(?,?,?,?,?)').run('r76-restore',th.anchor_message_id,ids[0],'中文一.md',(h.db.prepare('SELECT hash FROM artifacts WHERE id=?').get(ids[0]) as {hash:string}).hash);
      await h.bundle.loader.loadRoomPool(room.id);expect(current()).toEqual([ids[0]]);
      bridge.command=env=>env.method==='thread.history'?Promise.resolve({ok:false,error:{code:'STORAGE_UNAVAILABLE',message:'R76 read failure'}}):h.raw(env.method,env.params,env.commandId);
      await h.bundle.loader.loadThread(th.id);expect(current()).toEqual([ids[0]]);expect(h.bundle.store.getState().readErrors[`thread:${th.id}`]).toContain('R76 read failure');
      bridge.command=env=>env.method==='room.pool'?Promise.resolve({ok:false,error:{code:'STORAGE_UNAVAILABLE',message:'pool failed'}}):h.raw(env.method,env.params,env.commandId);
      await h.bundle.loader.loadRoomPool(room.id);expect(current()).toEqual([ids[0]]);expect(h.bundle.store.getState().readErrors[room.id]).toContain('pool failed');
      // Reverse direction: old thread.get must not seed a stale anchor that older-history hydration resurrects.
      captured=undefined;release=undefined;
      bridge.command=async env=>{const r=await h.raw(env.method,env.params,env.commandId);if(env.method==='thread.get'){captured=r;await new Promise<void>(res=>{release=res;});}return r;};
      const staleThread=h.bundle.loader.loadThread(th.id);while(captured==null)await new Promise(r=>setTimeout(r,5));
      h.db.prepare('DELETE FROM message_attachments WHERE message_id=?').run(th.anchor_message_id);
      bridge.command=env=>h.raw(env.method,env.params,env.commandId);
      await h.bundle.loader.loadRoomPool(room.id);expect(current()).toEqual([]);release!();await staleThread;expect(current()).toEqual([]);
      await h.bundle.loader.loadThreadOlder(th.id,1);expect(current()).toEqual([]);
      const madeB=await h.raw('room.create',{projectId:pid,name:'B'});const roomB=(madeB.data as {room:{id:string;conversationId:string}}).room;
      const upB=await h.raw('attachment.uploadText',{conversationId:roomB.conversationId,filename:'B.md',content:'B'});const idB=(upB.data as {attachmentId:string}).attachmentId;
      await h.raw('message.submit',{target:{kind:'room_root',projectId:pid,roomId:roomB.id,conversationId:roomB.conversationId},body:'B root',intent:'record_only',mentions:[],attachmentRefs:[idB]});
      await h.bundle.loader.refreshRooms();await h.bundle.loader.loadRoomPool(roomB.id);await h.bundle.loader.loadRoomPool(room.id);
      const other=h.bundle.store.getState().messages.find(m=>m.body==='B root')!;
      expect(other.formalAttachments?.map(a=>a.artifactId)).toEqual([idB]);expect(current()).toEqual([]);
      // A pending read is discarded when project generation changes, including failed reads.
      let finish:(()=>void)|undefined;
      bridge.command=async env=>{const r=await h.raw(env.method,env.params,env.commandId);await new Promise<void>(res=>{finish=res;});return r;};
      const late=h.bundle.loader.loadRoomPool(room.id);while(finish==null)await new Promise(r=>setTimeout(r,5));
      h.bundle.store.setState(s=>({...s,activeProjectId:'elsewhere',loadGen:s.loadGen+1}));finish();await late;expect(current()).toEqual([]);
      let foreignReads=0;bridge.command=async env=>{foreignReads+=1;return h.raw(env.method,env.params,env.commandId);};
      await h.bundle.loader.loadRoomPool(room.id);expect(foreignReads).toBe(0);expect(root().projectId).toBe(pid);
      expect((h.db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c).toBe(0);
    } finally { h.close(); }
  });
});
