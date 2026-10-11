/**
 * 第七十四轮 P1 集成测试（review-r73 §P1：取消凭据没有进入项目打开内部）。
 *
 * 打包真实 hifi loader/store/navIntent（同一 bundle → 同一模块实例，intent 登记簿与
 * openProjectByPath 内部是同一份）× 正式 daemon 命令面 × 独立内存库。转发层（window.zs
 * 包装）提供**受控保持**：指定请求的真实回执按测试节奏放行——内容不 mock，只控时序。
 *
 * 覆盖（review-r74 要求「分别验证 thread.get、project.open、成员/房间装载等待阶段取消；
 * 两条链接回执反序时只落实最新意图」）：
 *  - S1 正例：用户级打开正常提交焦点/本地记忆/导航偏好（基线，非取消不可用）。
 *  - S2 project.open 等待期取消（review-r73 复现的反例本体）：回执到达时意图已取消——
 *    零提交（不切项目、不写 zs.lastProjectPath、零 navigation.set、不弹错、安静 resolve）。
 *  - S3 成员装载等待期取消：焦点已提交后取消——不写偏好，焦点还原到打开前项目。
 *  - S4 thread.get 等待期取消（locateThread 安静停）：不进入对齐链、零 project.open。
 *  - S5 反序回执：C 在途→用户点 D→C 回执晚到只落实 D（最新意图）。
 *  - S6 合同保持：启动恢复型 {fromIntent:true} 无具体意图不被无关活跃意图拦；用户级
 *    打开仍取消在途意图（R73 合同不回退）。
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

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-hifi-r74-'));
const bundlePath = join(tmpRoot, 'hifi-bundle.mjs');
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄 */ } } });

function chr92slash(): string { return String.fromCharCode(92); }

/** 打包真实 hifi 前端（loader+store+navIntent 同 bundle——intent 登记簿共享实例）。 */
async function buildHifiBundle(): Promise<void> {
  const entry = join(tmpRoot, 'hifi-entry.ts');
  const loaderPath = join(repoRoot, 'src', 'ui', 'hifi', 'loader.ts').replaceAll(chr92slash(), '/');
  const storePath = join(repoRoot, 'src', 'ui', 'hifi', 'data', 'store.ts').replaceAll(chr92slash(), '/');
  const navIntentPath = join(repoRoot, 'src', 'ui', 'hifi', 'lib', 'navIntent.ts').replaceAll(chr92slash(), '/');
  writeFileSync(entry, `import * as loader from ${JSON.stringify(loaderPath)};
import * as store from ${JSON.stringify(storePath)};
import * as navIntent from ${JSON.stringify(navIntentPath)};
export { loader, store, navIntent };
`, 'utf8');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', outfile: bundlePath, sourcemap: false, loader: { '.tsx': 'tsx', '.ts': 'ts' } });
}

interface NavIntentLike { cancelled: boolean }
interface OpenResult { id: string; isCurrent(): boolean }
interface LoaderApi {
  openProjectByPath(path: string, opts?: { fromIntent?: boolean; intent?: NavIntentLike }): Promise<OpenResult>;
  ensureProjectActive(projectId: string, intent?: NavIntentLike): Promise<void>;
  locateThread(threadId: string, intent?: NavIntentLike): Promise<{ projectId: string; roomId: string }>;
  sendEnvelope(env: { commandId: string; method: 'message.submit'; params: Record<string, unknown> }): Promise<{ status: string; error?: { message: string } }>;
}
interface StoreApi {
  getState(): {
    activeProjectId: string; openInFlight: boolean; loadGen: number;
    rooms: Array<{ id: string; projectId: string }>;
    members: Array<{ id: string }>;
    memberRuntimes: Record<string, unknown>;
    dms: Array<{ id: string; projectId: string }>;
    projects: Array<{ id: string }>;
    ui: { toast?: { text: string }; writeLog: Array<{ api: string; detail: string }> };
  };
}
interface NavIntentApi {
  registerNavIntent(): NavIntentLike;
  beginUserNavIntent(): NavIntentLike;
  cancelNavIntent(t: NavIntentLike): void;
  releaseNavIntent(t: NavIntentLike): void;
  cancelAllNavIntents(): void;
  navIntentActive(t?: NavIntentLike): boolean;
}

interface Hold { match: (env: { method: string; params: Record<string, unknown> }) => boolean; promise: Promise<void>; release: () => void; fail?: boolean; after?: boolean; once?: boolean; entered?: boolean }
interface Harness {
  bundle: { loader: LoaderApi; store: StoreApi; navIntent: NavIntentApi };
  raw(method: string, params: unknown, commandId?: string): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  sent: Array<{ method: string; params: Record<string, unknown> }>;
  holds: Hold[];
  hold(match: Hold['match']): Hold;
  db: import('better-sqlite3').Database;
  localStorageBacked: Map<string, string>;
  close(): void;
}

async function makeHarness(): Promise<Harness> {
  const db = openDatabase(':memory:');
  const appDir = join(tmpRoot, 'app');
  mkdirSync(appDir, { recursive: true });
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir };
  const raw = (method: string, params: unknown, commandId?: string) =>
    dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `t-${randomUUID().slice(0, 8)}`, method, params }) as unknown as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;

  const sent: Harness['sent'] = [];
  const holds: Hold[] = [];
  // localStorage 桩（Node 无全局）：zs.lastProjectPath 断言用（loader 侧 try/catch 已兜底）。
  const localStorageBacked = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (localStorageBacked.has(k) ? localStorageBacked.get(k)! : null),
    setItem: (k: string, v: string) => { localStorageBacked.set(k, String(v)); },
    removeItem: (k: string) => { localStorageBacked.delete(k); },
    clear: () => { localStorageBacked.clear(); },
    key: (i: number) => [...localStorageBacked.keys()][i] ?? null,
    get length() { return localStorageBacked.size; },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = ls;
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    zs: {
      command: async (env: { commandId: string; method: string; params: Record<string, unknown> }) => {
        sent.push({ method: env.method, params: env.params });
        const h = holds.find((x) => !(x.once && x.entered) && x.match(env));
        if (h != null) h.entered = true;
        const reply = h?.after ? await raw(env.method, env.params, env.commandId) : null;
        if (h != null) await h.promise; // 受控保持：真实回执按测试节奏放行（内容不 mock）
        if (h?.fail) throw new Error('OWN_HELD_READ_FAILURE');
        return reply ?? raw(env.method, env.params, env.commandId);
      },
    },
  };
  const bundle = await import(`${pathToFileURL(bundlePath).href}?run=${randomUUID()}`) as unknown as Harness['bundle'];
  const hold = (match: Hold['match']): Hold => {
    let release!: () => void;
    const promise = new Promise<void>((res) => { release = res; });
    const h: Hold = { match, promise, release };
    holds.push(h);
    return h;
  };
  return { bundle, raw, sent, holds, hold, db, localStorageBacked, close: () => db.close() };
}

const settle = async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); };
const navSetsOf = (h: Harness) => h.sent.filter((x) => x.method === 'navigation.set');
const waitForSent = async (h: Harness, pred: (x: { method: string; params: Record<string, unknown> }) => boolean, label: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (h.sent.some(pred)) return;
    await settle(20);
  }
  throw new Error(`等待派发超时：${label}（sent=${h.sent.map((x) => x.method).join(',')}）`);
};

const mkProj = (name: string) => {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `# ${name}\n`, 'utf8');
  return dir;
};

describe('第七十四轮 P1：取消凭据贯穿项目打开内部（真实链）', () => {
  it('project.open/成员装载/thread.get 等待期取消分列 + 反序回执 + 正例', async () => {
    await buildHifiBundle();
    const h = await makeHarness();
    try {
      const dirB = mkProj('projB'); const dirA = mkProj('projA'); const dirC = mkProj('projC'); const dirD = mkProj('projD'); const dirE = mkProj('projE'); const dirF = mkProj('projF');
      const open = (dir: string) => h.raw('project.open', { path: dir });
      const b = ((await open(dirB)).data as { project: { id: string } }).project;
      const a = ((await open(dirA)).data as { project: { id: string } }).project;
      const c = ((await open(dirC)).data as { project: { id: string } }).project;
      const d = ((await open(dirD)).data as { project: { id: string } }).project;
      const e = ((await open(dirE)).data as { project: { id: string } }).project;
      const f = ((await open(dirF)).data as { project: { id: string } }).project;
      const st = () => h.bundle.store.getState();

      /* ── S1 正例：用户级打开正常提交（基线） ── */
      await h.bundle.loader.openProjectByPath(dirB);
      await settle(80);
      expect(st().activeProjectId).toBe(b.id);
      expect(h.localStorageBacked.get('zs.lastProjectPath')).toBe(dirB);
      const navAfterS1 = navSetsOf(h).length;
      expect(navAfterS1).toBeGreaterThanOrEqual(1);
      expect(navSetsOf(h).some((x) => x.params.activeProjectId === b.id)).toBe(true);

      /* ── S2 project.open 等待期取消（review-r73 反例本体：URL 已跳走、回执迟到） ── */
      const intent1 = h.bundle.navIntent.registerNavIntent();
      const holdA = h.hold((env) => env.method === 'project.open' && String(env.params.path) === dirA);
      const pA = h.bundle.loader.ensureProjectActive(a.id, intent1);
      await waitForSent(h, (x) => x.method === 'project.open' && x.params.path === dirA, 'S2 project.open 派发');
      h.bundle.navIntent.cancelAllNavIntents(); // 用户 navigate(settings)/新链接
      holdA.release(); // 3.2s 延迟的回执现在到达
      await pA; // 安静 resolve（不抛错——取消不弹旧错误）
      await settle(80);
      expect(st().activeProjectId).toBe(b.id); // 不切项目
      expect(h.localStorageBacked.get('zs.lastProjectPath')).toBe(dirB); // 本地导航记忆不写
      expect(navSetsOf(h).length).toBe(navAfterS1); // 取消后零 navigation.set
      expect(st().ui.toast).toBeUndefined(); // 不弹旧错误
      expect(st().ui.writeLog.some((w) => w.api === 'project.open.cancelled')).toBe(true); // 可观测登记
      h.bundle.navIntent.releaseNavIntent(intent1);

      /* ── S3 成员装载等待期取消：焦点已提交 → 不写偏好 + 焦点还原 ── */
      // 先让 A 的房间不在 state（S2 取消未装载）——保持全链 open 路径。
      const intent2 = h.bundle.navIntent.registerNavIntent();
      const beforeS3 = st();
      const beforeS3Path = h.localStorageBacked.get('zs.lastProjectPath');
      const holdRoster = h.hold((env) => env.method === 'member.list' && env.params.projectId === a.id && env.params.roomId == null);
      const pA2 = h.bundle.loader.ensureProjectActive(a.id, intent2);
      await waitForSent(h, (x) => x.method === 'member.list' && x.params.projectId === a.id && x.params.roomId == null, 'S3 成员装载派发');
      const activeMid = st().activeProjectId; // project.open 已提交（A）——装载刷新在途
      expect(activeMid).toBe(a.id);
      const navAfterS3open = navSetsOf(h).length;
      h.bundle.navIntent.cancelAllNavIntents();
      holdRoster.release();
      await pA2;
      await settle(80);
      expect(navSetsOf(h).length).toBe(navAfterS3open); // 取消后零 navigation.set
      expect(st().activeProjectId).toBe(b.id); // 焦点还原到打开前项目
      expect(h.localStorageBacked.get('zs.lastProjectPath')).toBe(beforeS3Path);
      expect(st().rooms).toEqual(beforeS3.rooms);
      expect(st().members).toEqual(beforeS3.members);
      expect(st().memberRuntimes).toEqual(beforeS3.memberRuntimes);
      expect(st().dms).toEqual(beforeS3.dms);
      expect(st().projects.some((p) => p.id === a.id)).toBe(true); // 注册事实不回滚
      h.bundle.navIntent.releaseNavIntent(intent2);

      /* ── S4 thread.get 等待期取消（locateThread 安静停，不进对齐链） ── */
      // A 房间根消息（record_only——真实线程，零任务派发）。
      const roomA = h.db.prepare('SELECT id FROM rooms WHERE project_id = ? LIMIT 1').get(a.id) as { id: string };
      const convA = h.db.prepare("SELECT id FROM conversations WHERE project_id = ? AND kind = 'room' LIMIT 1").get(a.id) as { id: string };
      const recEnv = {
        commandId: `cmd_${randomUUID().slice(0, 8)}`, method: 'message.submit' as const,
        params: { target: { kind: 'room_root' as const, projectId: a.id, conversationId: convA.id, roomId: roomA.id }, body: 'R74定位线程', intent: 'record_only' as const, mentions: [] },
      };
      expect((await h.bundle.loader.sendEnvelope(recEnv)).status).toBe('ok');
      const threadA = h.db.prepare("SELECT ct.id FROM conversation_threads ct JOIN messages m ON m.id = ct.anchor_message_id WHERE m.body_json LIKE '%R74定位线程%'").get() as { id: string } | undefined;
      expect(threadA).toBeDefined();
      const openBeforeS4 = h.sent.filter((x) => x.method === 'project.open').length;
      const intent3 = h.bundle.navIntent.registerNavIntent();
      const holdTg = h.hold((env) => env.method === 'thread.get' && env.params.threadId === threadA!.id);
      const pLoc = h.bundle.loader.locateThread(threadA!.id, intent3);
      await waitForSent(h, (x) => x.method === 'thread.get' && x.params.threadId === threadA!.id, 'S4 thread.get 派发');
      h.bundle.navIntent.cancelAllNavIntents();
      holdTg.release();
      const loc = await pLoc;
      expect(loc).toEqual({ projectId: '', roomId: '' }); // 安静停
      await settle(60);
      expect(h.sent.filter((x) => x.method === 'project.open').length).toBe(openBeforeS4); // 未进入对齐链
      expect(st().activeProjectId).toBe(b.id);
      h.bundle.navIntent.releaseNavIntent(intent3);

      /* ── S5 反序回执：C 在途 → 用户点 D → C 回执晚到只落实 D ── */
      const intent4 = h.bundle.navIntent.registerNavIntent();
      const holdC = h.hold((env) => env.method === 'project.open' && String(env.params.path) === dirC);
      const pC = h.bundle.loader.ensureProjectActive(c.id, intent4);
      await waitForSent(h, (x) => x.method === 'project.open' && x.params.path === dirC, 'S5 C 派发');
      h.bundle.navIntent.cancelAllNavIntents(); // 第二条链接（用户级新意图）
      const intent5 = h.bundle.navIntent.registerNavIntent();
      const pD = h.bundle.loader.ensureProjectActive(d.id, intent5);
      await pD; // D 正常落位
      holdC.release(); // C 的迟到回执
      await pC;
      await settle(80);
      expect(st().activeProjectId).toBe(d.id);
      const navNow = navSetsOf(h);
      expect(navNow.some((x) => x.params.activeProjectId === c.id)).toBe(false); // C 零偏好写入
      expect(navNow.some((x) => x.params.activeProjectId === d.id)).toBe(true); // 最新意图落位
      h.bundle.navIntent.releaseNavIntent(intent4);
      h.bundle.navIntent.releaseNavIntent(intent5);

      /* ── S6 合同保持：启动恢复型打开不被无关活跃意图拦；用户级打开仍取消在途意图 ── */
      const intent6 = h.bundle.navIntent.registerNavIntent();
      await h.bundle.loader.openProjectByPath(dirE, { fromIntent: true }); // bootRemembered 形态：无具体意图
      expect(st().activeProjectId).toBe(e.id);
      expect(h.bundle.navIntent.navIntentActive(intent6)).toBe(true); // 无关活跃意图不被误伤
      const intent7 = h.bundle.navIntent.registerNavIntent();
      await h.bundle.loader.openProjectByPath(dirF); // 用户级（打开文件夹/项目菜单）
      expect(st().activeProjectId).toBe(f.id);
      expect(h.bundle.navIntent.navIntentActive(intent7)).toBe(false); // 在途定位被取消（R73 合同）
      h.bundle.navIntent.releaseNavIntent(intent6);
      h.bundle.navIntent.releaseNavIntent(intent7);

      /* ── 未取消正例收口：定位链正常完成（对齐+线程实体返回） ── */
      const intent8 = h.bundle.navIntent.registerNavIntent();
      const locOk = await h.bundle.loader.locateThread(threadA!.id, intent8);
      expect(locOk.projectId).toBe(a.id);
      expect(locOk.roomId).toBe(roomA.id);
      expect(st().activeProjectId).toBe(a.id);
      h.bundle.navIntent.releaseNavIntent(intent8);
    } finally {
      h.close();
    }
  });
});

describe('R75 接手收尾：用户打开生命周期与真实交叉', () => {
  it.each(['open', 'load', 'load-failure'] as const)('取消 %s 等待：恢复基线且零旧导航写入', async (phase) => {
    await buildHifiBundle();
    const h = await makeHarness();
    try {
      const aDir = mkProj(`cancel-${phase}-A`), bDir = mkProj(`cancel-${phase}-B`);
      const a = await h.bundle.loader.openProjectByPath(aDir);
      await settle();
      const baseline = h.bundle.store.getState();
      const navCount = navSetsOf(h).length;
      const hold = h.hold((e) => phase === 'open'
        ? e.method === 'project.open' && e.params.path === bDir
        : e.method === 'member.list' && e.params.roomId == null);
      hold.fail = phase === 'load-failure';
      const intent = h.bundle.navIntent.beginUserNavIntent();
      const sentStart = h.sent.length;
      const pending = h.bundle.loader.openProjectByPath(bDir, { intent });
      await waitForSent(h, (e) => h.sent.indexOf(e) >= sentStart && hold.match(e), '取消等待窗');
      h.bundle.navIntent.cancelNavIntent(intent);
      // 取消即时还原；下一次打开不能把尚未回滚的B当成基线。
      expect(h.bundle.store.getState().activeProjectId).toBe(a.id);
      expect(h.localStorageBacked.get('zs.lastProjectPath')).toBe(aDir);
      hold.release();
      const result = await pending;
      await settle();
      expect(result.id).toBe('');
      expect(result.isCurrent()).toBe(false);
      const after = h.bundle.store.getState();
      expect(after.activeProjectId).toBe(a.id);
      expect(after.rooms).toEqual(baseline.rooms);
      expect(after.members).toEqual(baseline.members);
      expect(after.memberRuntimes).toEqual(baseline.memberRuntimes);
      expect(after.dms).toEqual(baseline.dms);
      expect(after.openInFlight).toBe(false);
      expect(navSetsOf(h).length).toBe(navCount);
      expect(after.ui.toast).toBeUndefined();
      if (phase !== 'open') expect(after.projects.length).toBeGreaterThan(baseline.projects.length);
      h.bundle.navIntent.releaseNavIntent(intent);
    } finally { h.holds.forEach((x) => x.release()); h.close(); }
  });

  it.each(['open', 'load', 'registry', 'late-failure'] as const)('重叠 B→C，B %s 迟到只落实 C', async (phase) => {
    await buildHifiBundle();
    const h = await makeHarness();
    try {
      const aDir = mkProj(`overlap-${phase}-A`), bDir = mkProj(`overlap-${phase}-B`), cDir = mkProj(`overlap-${phase}-C`);
      await h.bundle.loader.openProjectByPath(aDir);
      const b = ((await h.raw('project.open', { path: bDir })).data as { project: { id: string } }).project;
      const hold = h.hold((e) => phase === 'registry' ? e.method === 'project.list' : phase === 'open'
        ? e.method === 'project.open' && e.params.path === bDir
        : e.method === 'member.list' && e.params.projectId === b.id && e.params.roomId == null);
      hold.after = phase === 'registry'; hold.once = phase === 'registry';
      hold.fail = phase === 'late-failure';
      const oldIntent = h.bundle.navIntent.beginUserNavIntent();
      const sentStart = h.sent.length;
      const pending = h.bundle.loader.openProjectByPath(bDir, { intent: oldIntent });
      await waitForSent(h, (e) => h.sent.indexOf(e) >= sentStart && hold.match(e), 'B仍在途');
      const newIntent = h.bundle.navIntent.beginUserNavIntent();
      const c = await h.bundle.loader.openProjectByPath(cDir, { intent: newIntent });
      expect(c.id).not.toBe('');
      expect(c.isCurrent()).toBe(true);
      const atC = h.bundle.store.getState();
      await settle();
      const navCount = navSetsOf(h).length;
      hold.release();
      const stale = await pending;
      await settle();
      expect(stale.id).toBe('');
      expect(stale.isCurrent()).toBe(false);
      expect(h.bundle.store.getState().activeProjectId).toBe(c.id);
      expect(h.localStorageBacked.get('zs.lastProjectPath')).toBe(cDir);
      expect(h.bundle.store.getState().rooms).toEqual(atC.rooms);
      expect(h.bundle.store.getState().members).toEqual(atC.members);
      expect(h.bundle.store.getState().dms).toEqual(atC.dms);
      expect(h.bundle.store.getState().projects.some((p) => p.id === c.id)).toBe(true);
      expect(navSetsOf(h).length).toBe(navCount);
      expect(h.bundle.store.getState().ui.toast).toBeUndefined();
      h.bundle.navIntent.releaseNavIntent(oldIntent);
      h.bundle.navIntent.releaseNavIntent(newIntent);
    } finally { h.holds.forEach((x) => x.release()); h.close(); }
  });

  it('打开已返回后仍须核最终落位所有权', async () => {
    await buildHifiBundle();
    const h = await makeHarness();
    try {
      const a = await h.bundle.loader.openProjectByPath(mkProj('return-A'));
      expect(a.isCurrent()).toBe(true);
      const b = await h.bundle.loader.openProjectByPath(mkProj('return-B'));
      expect(a.isCurrent()).toBe(false);
      expect(b.isCurrent()).toBe(true);
      const intent = h.bundle.navIntent.beginUserNavIntent();
      const c = await h.bundle.loader.openProjectByPath(mkProj('return-C'), { intent });
      h.bundle.navIntent.cancelNavIntent(intent);
      expect(c.isCurrent()).toBe(false);
      h.bundle.navIntent.releaseNavIntent(intent);
    } finally { h.close(); }
  });
});
