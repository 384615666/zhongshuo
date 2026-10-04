/**
 * 第四十七轮 H1 真实链测试（review-r46 §3/§7）：**打包的 hifi 前端代码 × 正式 daemon 命令面 ×
 * 独立 fake 库/worker**——不是传输桩。
 *
 * 方法（与复核探针同构）：esbuild 把 src/ui/hifi/loader.ts（含真实 store/桥/映射）打包为
 * ESM，globalThis.window.zs 转发真实 dispatchDaemonCommand；内存库 + 真实 DispatchWorker
 * （fake adapter）。preload 是该命令面的透传层（信封形状一致），此处直达命令面验证合同本体。
 *
 * 覆盖：打开真实目录（{path} 合同）；房间名单=member.list({roomId})（@ 候选）；
 * room_root 指定成员+@全体派发（mentions kind:all——DB 事实）；仅记录=消息存在且
 * run/预算零新增；DM 派发→worker 回复→history 回读（created_at 如实、作者映射）；
 * 传输拒绝→unknown（保留同号重试）→同 commandId 重试恰一次（幂等回执，单条消息）。
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
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-hifi1-'));
const bundlePath = join(tmpRoot, 'hifi-bundle.mjs');
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

/** Windows 反斜杠字面量经多轮转义易碎——集中一处。 */
function chr92slash(): string { return String.fromCharCode(92); }

/** 打包真实 hifi 前端代码（loader+store+bridge+react 运行时）——验证对象=交付代码本体。 */
async function buildHifiBundle(): Promise<void> {
  const entry = join(tmpRoot, 'hifi-entry.ts');
  const loaderPath = join(repoRoot, 'src', 'ui', 'hifi', 'loader.ts').replaceAll(chr92slash(), '/');
  const storePath = join(repoRoot, 'src', 'ui', 'hifi', 'data', 'store.ts').replaceAll(chr92slash(), '/');
  writeFileSync(entry, `import * as loader from ${JSON.stringify(loaderPath)};
import * as store from ${JSON.stringify(storePath)};
export { loader, store };
`, 'utf8');
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: bundlePath,
    sourcemap: false,
    logLevel: 'silent',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });
}

/** 真实 daemon 命令面（内存库）；transport 拒绝钩子模拟断连（结果未知）。 */
/** loader 的正式面（测试所用子集——类型化，不用 any）。 */
interface LoaderApi {
  openProjectByPath(path: string): Promise<void>;
  refreshRooms(): Promise<void>;
  refreshDms(): Promise<void>;
  loadDmHistory(conversationId: string, opts?: { markRead?: boolean }): Promise<void>;
  sendRoomRoot(commandId: string, roomId: string, body: string, intent: 'default' | 'record_only', mentionIds: string[]): Promise<{ status: string; code?: string; error?: string }>;
  sendDmMessage(commandId: string, conversationId: string, body: string, intent: 'default' | 'record_only'): Promise<{ status: string; code?: string; error?: string }>;
  retryUnknownSend(env: { commandId: string; method: 'message.submit'; params: Record<string, unknown> }): Promise<{ status: string; code?: string; error?: string }>;
  buildDmEnvelope(commandId: string, conversationId: string, body: string, intent: 'default' | 'record_only'): { commandId: string; method: 'message.submit'; params: Record<string, unknown> };
}
interface StoreApi {
  getState(): { projects: Array<{ displayName: string }>; dms: Array<{ id: string; unread: number }>; rooms: Array<{ id: string; memberIds: string[]; conversationId?: string }>; dmHistory: Record<string, Array<{ id: string; authorId: string; createdAt: number }>> };
  setReadGate?(gate: ((conversationId: string) => boolean) | null): void;
}
interface Harness {
  bundle: { loader: LoaderApi; store: StoreApi };
  raw(method: string, params: unknown, commandId?: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  rejectNext: boolean;
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
  const harnessReject: { flag: boolean } = { flag: false };
  const raw = (method: string, params: unknown, commandId?: string) =>
    dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `t-${randomUUID().slice(0, 8)}`, method, params }) as unknown as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  // window.zs 桥桩=转发真实命令面；可注入一次传输拒绝（断连——结果未知）。
  (globalThis as unknown as { window: unknown }).window = {
    zs: {
      command: async (env: { commandId: string; method: string; params: unknown }) => {
        if (harnessReject.flag) { harnessReject.flag = false; throw new Error('TRANSPORT_DISCONNECTED（受控）'); }
        return raw(env.method, env.params, env.commandId);
      },
    },
  };
  const bundle = await import(pathToFileURL(bundlePath).href) as unknown as Harness['bundle'];
  return {
    bundle,
    raw,
    get rejectNext() { return harnessReject.flag; },
    set rejectNext(v: boolean) { harnessReject.flag = v; },
    db,
    worker: async () => { await new DispatchWorker({ db, adapter, leaseOwner: 'w-hifi', appDataDir: appDir }).runOnce(); },
    close: () => { void adapter.closeAllSessions().catch(() => {}); db.close(); },
  } as unknown as Harness;
}

/** 测试注入的门设置（bundle 的 store 模块导出 setReadGate——经 StoreApi 扩展暴露）。 */
function setReadGateForTest(store: StoreApi, allow?: string): void {
  if (typeof store.setReadGate === 'function') store.setReadGate(allow != null ? ((id: string) => id === allow) : null);
}

describe('第四十七轮 H1：打包 hifi 前端 × 正式 daemon × fake 库/worker（真实链）', () => {
  it('打开目录（{path}）→房间名单（member.list roomId）→指定成员+@全体派发→仅记录零运行→DM 回复/历史→unknown 同号重试恰一次', async () => {
    await buildHifiBundle();
    const h = await makeHarness();
    const L = h.bundle.loader;
    try {
      // ---------- ① 打开真实目录（正式 {path} 合同——R46 的 {rootPath} 会在此失败） ----------
      const projDir = join(tmpRoot, 'proj');
      mkdirSync(join(projDir, 'docs'), { recursive: true });
      writeFileSync(join(projDir, 'README.md'), '# hifi 真实链样本\n', 'utf8');
      await L.openProjectByPath(projDir);
      // 正式命令面直接核对（不经 loader）：project.open({path}) 语义已由 loader 成功路径证明；
      // 反向对照：{rootPath} 形态被 zod 拒绝。
      const bad = await h.raw('project.open', { rootPath: projDir });
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe('VALIDATION_INVALID');

      // 项目里造两 agent + 房间成员关系（正式 member.list({projectId, roomId}) 的数据面）。
      const projId = (h.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }).id; // project.open 生成的真实 id
      h.db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?,'Guide A','agent',1), ('mB',?,'Guide B','agent',1)`).run(projId, projId);
      // 正式 schema 造房间（镜像 boardFormalStates 造数：rooms+room_members+conversations(kind=room)）。
      const roomRow = { id: 'room_hifi', conversationId: 'convRoomHifi' };
      h.db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, '默认房间', 'mA')`).run(roomRow.id, projId);
      h.db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?), (?, ?)').run(roomRow.id, 'mA', roomRow.id, 'mB');
      h.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)`).run(roomRow.conversationId, projId, roomRow.id);
      await L.refreshRooms();

      // ---------- ② 房间名单=@ 候选唯一来源（Lab 式二成员名单，不用项目全体冒充） ----------
      const room = h.bundle.store.getState().rooms.find((r) => r.id === roomRow.id);
      expect(room?.memberIds.sort()).toEqual(['mA', 'mB']);
      expect(room?.conversationId).toBe(roomRow.conversationId);

      // ---------- ③ 指定成员 + @全体 派发（mentions kind:all 正式形态——DB 事实） ----------
      const beforeRuns = (h.db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c;
      const send1 = await L.sendRoomRoot('cmd-hifi-1', roomRow.id, '给 A 和全体的正式链消息', 'default', ['mA', 'all']);
      expect(send1.status).toBe('ok');
      const msgRow = h.db.prepare(`SELECT body_json FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1`).get(roomRow.conversationId) as { body_json: string };
      const mentions = (JSON.parse(msgRow.body_json) as { mentions: Array<{ kind: string; memberId?: string }> }).mentions;
      expect(mentions).toContainEqual({ kind: 'member', memberId: 'mA' });
      expect(mentions).toContainEqual({ kind: 'all' });
      expect((h.db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key LIKE '%:initial'`).get() as { c: number }).c).toBeGreaterThanOrEqual(1); // 真派发入队

      // ---------- ④ 仅记录：消息存在，run/预算零新增 ----------
      const runsBeforeRecord = (h.db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c;
      const send2 = await L.sendRoomRoot('cmd-hifi-2', roomRow.id, '只记录不派发', 'record_only', []);
      expect(send2.status).toBe('ok');
      const recMsg = h.db.prepare(`SELECT task_id, body_json FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1`).get(roomRow.conversationId) as { task_id: string | null; body_json: string };
      expect(recMsg.task_id).toBeNull(); // 仅记录：不建任务（正文即「只记录不派发」那条）
      expect((h.db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c).toBe(runsBeforeRecord); // 零新运行
      expect((h.db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c).toBeGreaterThanOrEqual(beforeRuns);

      // ---------- ⑤ DM：正式 conversation.create/派发 → worker 真实回复 → history 回读（created_at 如实） ----------
      const cv = await h.raw('conversation.create', { projectId: projId, peerMemberId: 'mA' });
      expect(cv.ok).toBe(true);
      const dmId = (cv.data as unknown as { conversationId: string }).conversationId;
      const sendDm = await L.sendDmMessage('cmd-hifi-3', dmId, '私信正式链：请回复', 'default');
      expect(sendDm.status).toBe('ok');
      // runOnce=单轮泵（此前 room_root 派发已占一轮）——有界多泵直至 DM 成员回复落库。
      let replyRow: { id: string; created_at: number; author_type: string; author_id: string } | undefined;
      for (let i = 0; i < 4 && replyRow == null; i += 1) {
        await h.worker(); // 真实 DispatchWorker+fake adapter：完成 turn（产生成员回复消息）
        replyRow = h.db.prepare(`SELECT id, created_at, author_type, author_id FROM messages WHERE conversation_id = ? AND author_type = 'agent' ORDER BY rowid DESC LIMIT 1`).get(dmId) as { id: string; created_at: number; author_type: string; author_id: string } | undefined;
      }
      expect(replyRow).toBeTruthy(); // 成员回复已持久化
      const reply = replyRow as { id: string; created_at: number; author_type: string; author_id: string };
      await L.loadDmHistory(dmId);
      const hist = h.bundle.store.getState().dmHistory[dmId] ?? [];
      const mappedReply = hist.find((m) => m.id === reply.id);
      expect(mappedReply).toBeTruthy();
      expect(mappedReply?.authorId).toBe(reply.author_id); // 作者映射（「未知成员」修复）
      expect(mappedReply?.createdAt).toBe(reply.created_at); // created_at 如实（不伪造当前时间）

      // ---------- ⑥ 结果未知（传输拒绝）→ 同 commandId 重试恰一次（幂等回执、单条消息） ----------
      h.rejectNext = true;
      const unknown = await L.sendDmMessage('cmd-hifi-retry', dmId, '断连重试样本', 'default');
      expect(unknown.status).toBe('unknown'); // 桥分类：传输拒绝≠服务拒绝
      const countAfterUnknown = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id = ? AND body_json LIKE '%断连重试样本%'`).get(dmId) as { c: number }).c;
      expect(countAfterUnknown).toBe(0); // 服务端确实没收到
      const retry = await L.sendDmMessage('cmd-hifi-retry', dmId, '断连重试样本', 'default'); // 同号重试
      expect(retry.status).toBe('ok');
      const retryAgain = await L.sendDmMessage('cmd-hifi-retry', dmId, '断连重试样本', 'default'); // 再重放同号
      expect(retryAgain.status).toBe('ok'); // 幂等回执
      const finalCount = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id = ? AND body_json LIKE '%断连重试样本%'`).get(dmId) as { c: number }).c;
      expect(finalCount).toBe(1); // 恰一条
    } finally {
      h.close();
    }
  }, 120_000);

  it('review-r47 反例组：提交后回执丢失的同号重放/改参冲突；迟到 project.open 归属；标读统一门', async () => {
    await buildHifiBundle();
    const h = await makeHarness();
    const L = h.bundle.loader;
    const store = h.bundle.store;
    try {
      const projDir = join(tmpRoot, 'proj2');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'README.md'), '# r47\n', 'utf8');
      await L.openProjectByPath(projDir);
      const projId = (h.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }).id;
      h.db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?,'Guide A','agent',1)`).run(projId);
      const cv = await h.raw('conversation.create', { projectId: projId, peerMemberId: 'mA' });
      const dmId = (cv.data as unknown as { conversationId: string }).conversationId;

      // ---------- ① 提交已成功、回执丢失（review-r47 §2 危险窗口） ----------
      const envBody = '提交后回执丢失的原文';
      const first = await L.sendDmMessage('cmd-r47-win', dmId, envBody, 'default');
      expect(first.status).toBe('ok'); // 服务端确实已保存
      // 同号**改参**（模拟旧实现“重试时重组参数”）→ 服务幂等网关必须拒绝。
      const changed = await h.raw('message.submit', { target: { kind: 'dm', projectId: projId, conversationId: dmId }, body: `${envBody}＋等待期新编辑`, intent: 'default', mentions: [] }, 'cmd-r47-win');
      expect(changed.ok).toBe(false);
      expect((changed.error as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
      // 同号**原信封**重放 → 幂等回执 ok；消息恰一条。信封用**产品 builder** 生成（review-r48 §3：
      // 不手工构造一份比产品更正确的参数）；参数与 builder 再生成结果逐字段一致。
      const env = L.buildDmEnvelope('cmd-r47-win', dmId, envBody, 'default');
      expect(env.params).toEqual({ target: { kind: 'dm', projectId: projId, conversationId: dmId }, body: envBody, intent: 'default', mentions: [] });
      const replay = await L.retryUnknownSend(env);
      expect(replay.status).toBe('ok');
      const count = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id = ? AND body_json LIKE ?`).get(dmId, `%${envBody}%`) as { c: number }).c;
      expect(count).toBe(1);

      // 造真实未读：worker 完成 DM 任务（fake 成员回复）→ unread>0 才有水位可推进。
      let agentReply = false;
      for (let i = 0; i < 4 && !agentReply; i += 1) {
        await h.worker();
        agentReply = (h.db.prepare(`SELECT count(*) c FROM messages WHERE conversation_id = ? AND author_type = 'agent'`).get(dmId) as { c: number }).c > 0;
      }
      expect(agentReply).toBe(true);

      // ---------- ② 迟到 project.open 归属（review-r47 §4） ----------
      const origCommand = h.raw; // 受控延迟：直接调 command 面而非 loader 的 openProjectByPath
      // 用 loader 发起 A（慢）与 B（快）：A 的响应后到不得覆盖 B。
      const dirA = join(tmpRoot, 'projA'); const dirB = join(tmpRoot, 'projB');
      mkdirSync(dirA, { recursive: true }); mkdirSync(dirB, { recursive: true });
      writeFileSync(join(dirA, 'README.md'), 'A\n', 'utf8'); writeFileSync(join(dirB, 'README.md'), 'B\n', 'utf8');
      const globalWindow = (globalThis as unknown as { window: { zs: { command: (env: unknown) => Promise<unknown> } } }).window;
      const realCommand = globalWindow.zs.command.bind(globalWindow.zs);
      const slowA: Array<() => void> = [];
      globalWindow.zs.command = (async (env: { commandId: string; method: string; params: unknown }) => {
        if (env.method === 'project.open' && (env.params as { path: string }).path === dirA) {
          await new Promise<void>((r) => { slowA.push(r); }); // 挂起 A 直到放行
        }
        return realCommand(env);
      }) as typeof globalWindow.zs.command;
      const pA = L.openProjectByPath(dirA);
      await new Promise((r) => setTimeout(r, 50));
      await L.openProjectByPath(dirB); // B 后发先至
      expect(store.getState().projects[0]?.displayName).toBe('projB');
      slowA.forEach((r) => r()); // 放行 A——旧响应必须被丢弃
      await pA;
      expect(store.getState().projects[0]?.displayName).toBe('projB');
      globalWindow.zs.command = realCommand;

      // ---------- ③ 标读统一门（review-r47 §4：发起点重查，不信请求前快照） ----------
      await L.openProjectByPath(projDir); // ② 已切到 projB——回到本测项目并重载会话
      await L.refreshDms();
      // 页面未注册门（readGate=null）→ 即使 opts.markRead=true 也不得推进。
      const markBefore = (h.db.prepare(`SELECT count(*) c FROM messages WHERE id = '__mark__'`).get() as { c: number }).c;
      void markBefore;
      await L.refreshDms(); // 会话列表入 store（unread>0 才会推进水位）
      const convUnread = store.getState().dms.length;
      const marked: string[] = [];
      const origMark = globalWindow.zs.command.bind(globalWindow.zs);
      globalWindow.zs.command = (async (env: { method: string; params: unknown }) => {
        if (env.method === 'conversation.markRead') marked.push(JSON.stringify((env.params as { conversationId: string }).conversationId));
        return origMark(env);
      }) as typeof globalWindow.zs.command;
      await L.loadDmHistory(dmId, { markRead: true }); // 无门（缺省拒绝）
      expect(marked).toHaveLength(0);
      void convUnread;
      setReadGateForTest(store, dmId); // 门此刻放行（当前会话）
      await L.loadDmHistory(dmId, { markRead: true });
      expect(marked).toHaveLength(1);
      setReadGateForTest(store, undefined);
      globalWindow.zs.command = origMark;
    } finally {
      h.close();
    }
  }, 120_000);
});

