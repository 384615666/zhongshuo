#!/usr/bin/env node
/**
 * verify-daily-r75.cjs —— R75「项目切换落位/取消收口」门（2026-10-09）
 *
 * 对应复核：review-r74-project-open-and-rollback-next-round-20261009.md
 *  - G1 普通打开路线（**真实弹窗+pickFolder 桥，零延迟钩子**——review-r74 §P1 反例本体）：
 *    从 A 房间/线程/文件页/设置页打开已注册 B；首次打开新目录 C；连续 B→C 最新意图落位。
 *    每项核 URL/当前项目/输入区/zs.lastProjectPath/旧项目保留/零 toast。
 *  - G2 取消三相位分列（thread.get / project.open / member.list 受控延迟——main.ts 工程观测
 *    钩子）+ 回滚完整性：焦点/本地启动记忆/房间投影（B 房间在侧栏）一致还原、
 *    取消后零 navigation.set；重启后仍进入正确项目（偏好=最后用户意图）。
 *  - G3 冷启动恢复 + 跨项目线程深链 + 冷房间直链正例。
 *
 * ZS_R75_ONLY=g1|g2|g3 可单段运行。零真实模型调用；不动用户数据根。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const runId = `r75-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r75-${runId}`);
const ONLY = process.env.ZS_R75_ONLY || '';

const PORT = 9718;
const shotsDir = path.join(outDir, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`);
    await sleep(250);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.consoleErrors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.consoleErrors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 300)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async shot(name) { try { const png = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(png.data, 'base64')); return true; } catch { return false; } }
}
async function connectPage(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const waitFor = async (cdp, expr, ms, label) => until(() => cdp.tryEval(probe(expr)).catch(() => null), (v) => v, ms, label);
const own = new Set();
function cleanupOwn() { for (const c of [...own]) { if (c.exitCode != null) continue; try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } }
const dbOf = (root) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(root, 'state.sqlite')); return { q: (sql, ...a) => db.prepare(sql).all(...a), get: (sql, ...a) => db.prepare(sql).get(...a), run: (sql, ...a) => db.prepare(sql).run(...a), close: () => db.close() }; };
let __appOut = { v: '' };
let f = { g1: { scenarios: [] }, g2: {}, g3: {} };

async function launchApp(dataRoot, extraEnv = {}) {
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  own.add(app);
  app.once('exit', () => own.delete(app));
  app.stdout.on('data', (c) => { __appOut.v += c; });
  app.stderr.on('data', (c) => { __appOut.v += c; });
  const cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
  return { app, cdp };
}
async function closeApp(app, cdp) {
  try { if (cdp != null && !cdp.closed) await cdp.send('Browser.close'); } catch { /* 已退 */ }
  await until(async () => { try { process.kill(app.pid, 0); return false; } catch { return true; } }, (v) => v, 20000, 'app 优雅退出').catch(async () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } });
  await sleep(1800);
}
async function pageCmd(cdp, method, params, commandId) {
  const v = await cdp.send('Runtime.evaluate', {
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g75-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
    awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(v.result.value);
}
const pageOk = async (cdp, method, params) => { const r = await pageCmd(cdp, method, params); if (r && r.ok !== true) throw new Error(`${method}: ${r.error?.message}`); return r.data ?? r; };
async function bootProject(cdp) {
  await cdp.eval('location.reload(), true');
  const c = await connectPage('boot 重载');
  await waitFor(c, `document.querySelector('#hifi-root .side-project .side-item-label') != null`, 45000, '侧栏项目');
  await sleep(900);
  return c;
}
const activeSideLabel = (cdp) => cdp.tryEval(probe(`(document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim()`));
const lastPathOf = (cdp) => cdp.tryEval(`localStorage.getItem('zs.lastProjectPath')`);
const toastsOf = (cdp) => cdp.tryEval(probe(`[...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 50))`));
const realCallsOf = (root) => { try { return dbOf(root).get('SELECT count(*) c FROM real_calls').c; } catch { return -1; } };

/** 真实弹窗打开：点侧栏「打开/切换项目」→ 弹窗挂载即 autoPick（pickFolder 桥按
 *  ZS_PICK_FOLDER_FILE 清单顺序供目录）→ 等「打开这个目录」可用并点击 → 等打开完成。 */
async function modalOpenCurrentPick(cdp) {
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .side-item')].find((x) => x.textContent.includes('打开/切换项目')); b?.click(); return b != null; })()`));
  await waitFor(cdp, `document.querySelector('#hifi-root .modal input.input') != null`, 10000, '打开弹窗');
  await waitFor(cdp, `(() => { const i = document.querySelector('#hifi-root .modal input.input'); return i != null && i.value.length > 3; })()`, 20000, '目录选择回填（autoPick）');
  await cdp.eval(probe(`(() => { const m = [...document.querySelectorAll('#hifi-root .modal')].find((x) => x.textContent.includes('打开文件夹')); const b = [...(m?.querySelectorAll('button') ?? [])].find((x) => x.textContent.includes('打开这个目录')); b?.click(); return b != null; })()`));
  await waitFor(cdp, `document.querySelector('#hifi-root .modal') == null`, 45000, '弹窗关闭（打开完成）');
}

(async () => {
  const errs = [];
  const realCallRoots = {};
  process.on('SIGINT', () => { cleanupOwn(); process.exit(130); });

  /* 共用夹具目录（每场景独立数据根——ZS_PICK_FOLDER_FILE 每实例一份） */
  const mkProjDir = (name) => { const d = path.join(outDir, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${name}.md`), `# ${name}\n`, 'utf8'); return d; };
  const dirA = mkProjDir('projA');
  const dirB = mkProjDir('projB');
  const dirC = mkProjDir('projC');
  const pickList = (dirs) => { const p = path.join(outDir, `pick-${Math.random().toString(36).slice(2, 8)}.txt`); fs.writeFileSync(p, dirs.join('\r\n'), 'utf8'); return p; };

  /* ================= G1 普通打开路线（真实弹窗，零延迟钩子） ================= */
  if (ONLY === '' || ONLY === 'g1') {
    const scenarios = [
      { name: 'room→已注册B', from: 'room', pick: [dirB], wantLabel: 'projB', wantDir: dirB },
      { name: 'thread→新目录C', from: 'thread', pick: [dirC], wantLabel: 'projC', wantDir: dirC },
      { name: 'files→已注册B', from: 'files', pick: [dirB], wantLabel: 'projB', wantDir: dirB },
      { name: 'settings→已注册B', from: 'settings', pick: [dirB], wantLabel: 'projB', wantDir: dirB },
      { name: '连开B→C（最新意图）', from: 'room', pick: [dirB, dirC], wantLabel: 'projB', wantDir: dirB, second: { label: 'projC', dir: dirC } },
    ].filter((sc) => process.env.ZS_R75_SCENARIO == null || sc.name.includes(process.env.ZS_R75_SCENARIO));
    const root1 = path.join(outDir, 'root1');
    let aId = null; let bId = null; let roomA = null;
    for (const sc of scenarios) {
      let { app, cdp } = await launchApp(root1, { ZS_PICK_FOLDER_FILE: pickList(sc.pick) });
      try {
        if (aId == null) {
          aId = (await pageOk(cdp, 'project.open', { path: dirA })).project.id;
          bId = (await pageOk(cdp, 'project.open', { path: dirB })).project.id;
          cdp = await bootProject(cdp);
          roomA = dbOf(root1).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', aId).id;
          // B 造记录线程（thread 场景用）
          const convB = dbOf(root1).get("SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = 'room' LIMIT 1", bId);
          await pageCmd(cdp, 'message.submit', { target: { kind: 'room_root', projectId: bId, conversationId: convB.cid, roomId: dbOf(root1).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', bId).id }, body: `R75线程-${sc.name}`, intent: 'record_only', mentions: [] });
        } else {
          cdp = await bootProject(cdp);
        }
        // 起点页：场景要求的不同上下文
        await cdp.eval(`location.hash = ${JSON.stringify(`/project/${aId}/room/${roomA}`)}; true`);
        try {
          await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 60000, `${sc.name} 起点房间`);
        } catch (e) {
          const dump = await cdp.tryEval(probe(`(() => ({ hash: location.hash.slice(0, 60), body: document.body.textContent.replace(/\\s+/g, ' ').slice(0, 260) }))()`));
          throw new Error(`${sc.name} 起点房间：${JSON.stringify(dump)}；console=${JSON.stringify((cdp.consoleErrors ?? []).slice(0, 3))}；appOut=${__appOut.v.slice(-1200)}`);
        }
        if (sc.from === 'thread') {
          await cdp.eval(`location.hash = ${JSON.stringify(`/project/${bId}`)}; true`);
          await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'B 装载');
          const thB = dbOf(root1).get('SELECT ct.id FROM conversation_threads ct JOIN messages m ON m.id = ct.anchor_message_id WHERE m.body_json LIKE ?', `%R75线程-%`);
          await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${thB.id}`)}; true`);
          await waitFor(cdp, `document.querySelector('#hifi-root .col-thread') != null`, 60000, `${sc.name} 起点线程`);
        } else if (sc.from === 'files') {
          await cdp.eval(`location.hash = ${JSON.stringify(`/project/${aId}/files`)}; true`);
          await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, `${sc.name} 起点文件页`);
        } else if (sc.from === 'settings') {
          await cdp.eval(`location.hash = '/settings'; true`);
          await waitFor(cdp, `location.hash.startsWith('#/settings')`, 15000, `${sc.name} 起点设置页`);
        }
        const originHash = await cdp.tryEval(`location.hash.slice(0, 40)`);
        const originActive = await activeSideLabel(cdp);
        // 真实弹窗打开
        await modalOpenCurrentPick(cdp);
        await sleep(1500);
        let fact = {
          name: sc.name, from: sc.from, originHash, originActive,
          hash: await cdp.tryEval(`location.hash.slice(0, 60)`),
          active: await activeSideLabel(cdp),
          composer: await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`),
          lastPath: await lastPathOf(cdp),
          projAKept: await cdp.tryEval(probe(`[...document.querySelectorAll('#hifi-root .side-item-label')].some((x) => x.textContent.includes('projA'))`)),
          toasts: await toastsOf(cdp),
        };
        // 连开场景：再开第二个目录（pickList 下一行）——最新意图落位
        if (sc.second != null) {
          await modalOpenCurrentPick(cdp);
          await sleep(1500);
          fact = { ...fact, secondHash: await cdp.tryEval(`location.hash.slice(0, 60)`), secondActive: await activeSideLabel(cdp), secondLastPath: await lastPathOf(cdp) };
        }
        f.g1.scenarios.push(fact);
        const wantRoomHash = fact.hash.startsWith('#/project/') && fact.hash.includes('/room/');
        const okMain = fact.active.includes(sc.wantLabel) && fact.composer === true && fact.lastPath === sc.wantDir && fact.projAKept === true && (fact.toasts ?? []).length === 0 && wantRoomHash;
        const okSecond = sc.second == null || (fact.secondActive.includes(sc.second.label) && fact.secondLastPath === sc.second.dir && String(fact.secondHash).includes('/room/'));
        if (!okMain) errs.push(`G1[${sc.name}]：${JSON.stringify(fact)}`);
        if (!okSecond) errs.push(`G1[${sc.name}]第二次打开未落最新意图：${JSON.stringify(fact)}`);
        await cdp.shot(`g1-${sc.name}`);
      } finally {
        realCallRoots.root1 = realCallsOf(root1);
        await closeApp(app, cdp);
      }
    }
  }

  /* ================= G2 取消三相位 + 回滚完整性 + 重启恢复 ================= */
  if (ONLY === '' || ONLY === 'g2') {
    const root2 = path.join(outDir, 'root2');
    // instance-1：注册 A/B + B 记录线程；经**真实弹窗**进入 B 建立基线（review-r74 §P2 同型）
    {
      let { app, cdp } = await launchApp(root2, { ZS_PICK_FOLDER_FILE: pickList([dirB]) });
      const a = (await pageOk(cdp, 'project.open', { path: dirA })).project;
      const b = (await pageOk(cdp, 'project.open', { path: dirB })).project;
      const roomA = dbOf(root2).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', a.id).id;
      const convA = dbOf(root2).get("SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = 'room' LIMIT 1", a.id);
      await pageCmd(cdp, 'message.submit', { target: { kind: 'room_root', projectId: a.id, conversationId: convA.cid, roomId: roomA }, body: 'R75G2线程', intent: 'record_only', mentions: [] });
      const threadA = dbOf(root2).get("SELECT ct.id FROM conversation_threads ct JOIN messages m ON m.id = ct.anchor_message_id WHERE m.body_json LIKE ?", '%R75G2线程%').id;
      cdp = await bootProject(cdp);
      await cdp.eval(`location.hash = '/settings'; true`);
      await waitFor(cdp, `location.hash.startsWith('#/settings')`, 15000, 'G2 设置页');
      await modalOpenCurrentPick(cdp);
      await sleep(1500);
      f.g2.baseline = { hash: await cdp.tryEval(`location.hash`), active: await activeSideLabel(cdp), lastPath: await lastPathOf(cdp) };
      const prefs0 = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
      f.g2.baselinePrefs = prefs0.data?.prefs?.activeProjectId ?? null;
      if (!(String(f.g2.baseline.active).includes('projB') && f.g2.baseline.lastPath === dirB && f.g2.baseline.hash.includes('/room/'))) {
        errs.push(`G2 基线（真实弹窗进 B）：${JSON.stringify(f.g2.baseline)}`);
      }
      f.g2.ids = { aId: a.id, bId: b.id, roomA, threadA };
      await closeApp(app, cdp);
    }
    const { aId, bId, roomA, threadA } = f.g2.ids;

    // instance-2：thread.get 在途取消（受控延迟 3.2s）——零提交（含本地记忆）
    {
      let { app, cdp } = await launchApp(root2, { ZS_UI_DELAY_METHOD_MS: 'thread.get:3200' });
      await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 60000, 'G2① 重启就绪');
      await sleep(1500);
      await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadA}`)}; true`);
      await sleep(900); // thread.get 在途
      await cdp.eval(`location.hash = '/settings'; true`);
      await waitFor(cdp, `location.hash.startsWith('#/settings')`, 15000, 'G2① 设置页');
      await sleep(4600);
      f.g2.threadCancel = { hash: await cdp.tryEval(`location.hash.slice(0, 30)`), active: await activeSideLabel(cdp), lastPath: await lastPathOf(cdp), toasts: await toastsOf(cdp) };
      const prefs = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
      f.g2.threadCancelPrefs = prefs.data?.prefs?.activeProjectId ?? null;
      const tc = f.g2.threadCancel;
      if (!(String(tc.hash).startsWith('#/settings') && String(tc.active).includes('projB') && tc.lastPath === dirB && (tc.toasts ?? []).length === 0 && f.g2.threadCancelPrefs !== aId)) {
        errs.push(`G2① thread.get 取消：${JSON.stringify(tc)} prefs=${f.g2.threadCancelPrefs}`);
      }
      await closeApp(app, cdp);
    }

    // instance-3：project.open 在途取消——零提交（含本地记忆）
    {
      let { app, cdp } = await launchApp(root2, { ZS_UI_DELAY_METHOD_MS: 'project.open:3200' });
      await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 60000, 'G2② 重启就绪');
      await sleep(1500);
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${aId}/room/${roomA}`)}; true`);
      await sleep(900); // project.open 在途
      await cdp.eval(`location.hash = '/settings'; true`);
      await waitFor(cdp, `location.hash.startsWith('#/settings')`, 15000, 'G2② 设置页');
      await sleep(4600);
      f.g2.openCancel = { hash: await cdp.tryEval(`location.hash.slice(0, 30)`), active: await activeSideLabel(cdp), lastPath: await lastPathOf(cdp), toasts: await toastsOf(cdp) };
      const prefs = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
      f.g2.openCancelPrefs = prefs.data?.prefs?.activeProjectId ?? null;
      const oc = f.g2.openCancel;
      if (!(String(oc.hash).startsWith('#/settings') && String(oc.active).includes('projB') && oc.lastPath === dirB && (oc.toasts ?? []).length === 0 && f.g2.openCancelPrefs !== aId)) {
        errs.push(`G2② project.open 取消：${JSON.stringify(oc)} prefs=${f.g2.openCancelPrefs}`);
      }
      await closeApp(app, cdp);
    }

    // instance-4：装载期取消（saved.list:2500 受控延迟）——焦点+本地记忆+房间投影还原
    {
      let { app, cdp } = await launchApp(root2, { ZS_UI_DELAY_METHOD_MS: 'saved.list:2500', ZS_COMMAND_LOG_FILE: path.join(outDir, 'g2i4-cmds.log') }); // 延迟 saved.list（打开波成员；B 基线装载不调用它——钩子留给 A 的装载波）
      await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 60000, 'G2③ 重启就绪');
      await sleep(1500);
      // 会话内恢复 B 基线（装载 B 房间——回滚快照应含 B 投影；review-r74 §P2 同型基线）
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${bId}`)}; true`);
      await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G2③ B 基线装载');
      await sleep(900);
      f.g2.refreshBaseline = { active: await activeSideLabel(cdp), lastPath: await lastPathOf(cdp) };
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${aId}/room/${roomA}`)}; true`);
      let flipped = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const lab = await activeSideLabel(cdp);
        if (String(lab).includes('projA')) { await cdp.eval(`location.hash = '/settings'; true`); flipped = true; break; }
        await sleep(12);
      }
      if (!flipped) errs.push('G2③ 未捕获装载期翻转');
      else {
        await sleep(4500);
        f.g2.refreshCancel = {
          hash: await cdp.tryEval(`location.hash.slice(0, 30)`),
          active: await activeSideLabel(cdp),
          lastPath: await lastPathOf(cdp),
          roomsProjection: await cdp.tryEval(probe(`(() => { const rooms = [...document.querySelectorAll('#hifi-root button.side-item.sub')].map((x) => x.textContent.trim()); return rooms.some((x) => x.includes('默认房间')) ? rooms : rooms; })()`)),
          projAKept: await cdp.tryEval(probe(`[...document.querySelectorAll('#hifi-root .side-item-label')].some((x) => x.textContent.includes('projA'))`)),
          toasts: await toastsOf(cdp),
        };
        const prefs = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
        f.g2.refreshCancelPrefs = prefs.data?.prefs?.activeProjectId ?? null;
        const rc = f.g2.refreshCancel;
        // 房间投影：还原后侧栏应列 **B 的** 默认房间（A 的房间不应残留为唯一事实）
        const roomsB = await cdp.tryEval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .side-project')]; const rowB = rows.find((r) => (r.querySelector('.side-item-label')?.textContent ?? '').includes('projB')); return rowB != null && [...rowB.querySelectorAll('button.side-item.sub')].some((x) => x.textContent.includes('默认房间')); })()`));
        f.g2.refreshRoomsB = roomsB;
        if (!(String(rc.hash).startsWith('#/settings') && String(rc.active).includes('projB') && rc.lastPath === dirB && (rc.toasts ?? []).length === 0 && f.g2.refreshCancelPrefs !== aId)) {
          errs.push(`G2③ 装载期取消回滚：${JSON.stringify(rc)} prefs=${f.g2.refreshCancelPrefs}`);
        }
        if (roomsB !== true) errs.push('G2③ 房间投影未还原到 B（侧栏无 B 房间）');
        if (rc.projAKept !== true) errs.push('G2③ 项目注册表误删 A');
        try {
          const raw = fs.readFileSync(path.join(outDir, 'g2i4-cmds.log'), 'utf8');
          const lines = raw.trim().split(String.fromCharCode(10));
          f.g2.i4CmdsTail = lines.slice(-14).map((l2) => { try { const j = JSON.parse(l2); return j.method + String(JSON.stringify(j.params)).slice(0, 60); } catch { return '?'; } });
          f.g2.i4NavSets = lines.filter((l2) => l2.includes('"navigation.set"')).length;
        } catch { /* */ }
        await cdp.shot('g2-refresh-cancel');
      }
      await closeApp(app, cdp);
    }

    // instance-5：重启（无钩子）——仍进入正确项目（最后用户意图 B）
    {
      let { app, cdp } = await launchApp(root2, {});
      await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 60000, 'G2④ 重启就绪');
      await sleep(1500);
      f.g2.restartActive = await activeSideLabel(cdp);
      f.g2.restartLastPath = await lastPathOf(cdp);
      if (!String(f.g2.restartActive).includes('projB')) errs.push(`G2④ 重启进入正确项目（active=${f.g2.restartActive}）`);
      if (f.g2.restartLastPath !== dirB) errs.push(`G2④ 重启本地记忆（lastPath=${f.g2.restartLastPath}）`);
      await closeApp(app, cdp);
    }
    realCallRoots.root2 = realCallsOf(root2);
  }

  /* ================= G3 冷启动恢复 + 跨项目深链 + 冷房间直链正例 ================= */
  if (ONLY === '' || ONLY === 'g3') {
    const root3 = path.join(outDir, 'root3');
    let { app, cdp } = await launchApp(root3, {});
    const a = (await pageOk(cdp, 'project.open', { path: dirA })).project;
    const b = (await pageOk(cdp, 'project.open', { path: dirB })).project;
    const roomA = dbOf(root3).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', a.id).id;
    const convA = dbOf(root3).get("SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = 'room' LIMIT 1", a.id);
    await pageCmd(cdp, 'message.submit', { target: { kind: 'room_root', projectId: a.id, conversationId: convA.cid, roomId: roomA }, body: 'R75G3线程', intent: 'record_only', mentions: [] });
    const threadA = dbOf(root3).get("SELECT ct.id FROM conversation_threads ct JOIN messages m ON m.id = ct.anchor_message_id WHERE m.body_json LIKE ?", '%R75G3线程%').id;
    cdp = await bootProject(cdp);
    // ① 跨项目线程深链（B 活跃→A 线程）正例
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G3 B 聚焦');
    await sleep(900);
    await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadA}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .col-thread') != null`, 60000, 'G3 跨项目线程');
    f.g3.crossThreadActive = await activeSideLabel(cdp);
    // ② 冷房间直链（active 已恢复但房间未装载）：切 B → 直达 A 房间
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G3 回 B');
    await sleep(900);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${a.id}/room/${roomA}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 60000, 'G3 冷房间直链');
    f.g3.coldRoomActive = await activeSideLabel(cdp);
    // ③ 重启冷启动：A 活跃（最后意图）+ 偏好恢复
    await closeApp(app, cdp);
    ({ app, cdp } = await launchApp(root3, {}));
    await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 60000, 'G3 冷启动就绪');
    await sleep(1500);
    f.g3.coldBootActive = await activeSideLabel(cdp);
    const prefs3 = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
    f.g3.coldBootPrefs = prefs3.data?.prefs?.activeProjectId ?? null;
    // ④ 冷启动后冷房间直链（房间未装载，active=A）
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${a.id}/room/${roomA}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 60000, 'G3 冷启动直链');
    f.g3.coldBootRoomOk = true;
    f.g3.consoleErrors = (cdp.consoleErrors ?? []).filter((e) => !e.includes('React DevTools')).slice(0, 3);
    if (!String(f.g3.crossThreadActive).includes('projA')) errs.push(`G3① 跨项目深链（active=${f.g3.crossThreadActive}）`);
    if (!String(f.g3.coldRoomActive).includes('projA')) errs.push(`G3② 冷房间直链（active=${f.g3.coldRoomActive}）`);
    if (!String(f.g3.coldBootActive).includes('projA') || f.g3.coldBootPrefs !== a.id) errs.push(`G3③ 冷启动恢复（active=${f.g3.coldBootActive} prefs=${f.g3.coldBootPrefs}）`);
    if (f.g3.coldBootRoomOk !== true) errs.push('G3④ 冷启动直链');
    if ((f.g3.consoleErrors ?? []).length > 0) errs.push(`G3 console（${JSON.stringify(f.g3.consoleErrors)}）`);
    realCallRoots.root3 = realCallsOf(root3);
    await cdp.shot('g3-end');
    await closeApp(app, cdp);
  }

  const result = { runId, ok: errs.length === 0, errs, checks: f, realCallRoots, shotsDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: result.ok, errs, g1: f.g1, g2: { baseline: f.g2.baseline, threadCancel: f.g2.threadCancel, openCancel: f.g2.openCancel, refreshCancel: f.g2.refreshCancel, refreshRoomsB: f.g2.refreshRoomsB, i4CmdsTail: f.g2.i4CmdsTail, i4NavSets: f.g2.i4NavSets, restart: [f.g2.restartActive, f.g2.restartLastPath] }, g3: f.g3, realCallRoots }, null, 2));
  cleanupOwn();
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('gate 崩溃：', e); try { fs.writeFileSync(path.join(outDir, 'crash.txt'), String(e?.stack ?? e)); } catch { /* */ } cleanupOwn(); process.exit(1); });
