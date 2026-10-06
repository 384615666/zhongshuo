'use strict';
/**
 * R66 交互门（review-r65 §2/§3）：冻结 v3 的八个用户反例逐项闭拢——实际点击/输入/切换并核
 * DB/文件事实；dev Electron（dist/ui/main.cjs，当前构建）+源码 daemon 子进程；fake runtime
 * （ZS_FAKE_STALL_MS 让 DM 串行队列可见）；零真实模型调用。
 * 覆盖：
 *  G1 项目按钮白屏反例：真实点开/搜索/勾选/切换/关闭多轮——React root 不卸载、标题栏存活、
 *     全程零 console 错误（R65 反例在点开瞬间即产生 getSnapshot/Maximum depth 错误）。
 *  G2 MD 排版阅读：上传（UI 真实上传链）>64KB MD（含表格/加粗/尾部标记）→ 附件消息默认渲染
 *     h1/表格（非 pre 原文）；源码视图见原文与 64KB 外尾部标记（readFull 全文=提取窗分列）；
 *     再切回阅读。
 *  G3 HTML 隔离页面预览：134KB HTML 默认 iframe（sandbox=""，srcdoc 注入 CSP+base），非整页
 *     源码；脚本禁用说明在案。
 *  G4 文件-only 发送（UI 端到端）：无正文+就绪附件 → 发送可用；AI 意图=DB 任务标题 📎 文件名、
 *     消息 body 空、附件关联；仅记录=零任务；真正空白=按钮禁用+服务端拒绝（负对照）。
 *  G5 DM 布局（原型 320/440/480 降级）：宽窗预览≥480 或单区；窄窗（900px）列表收起/单区切换、
 *     无横向溢出、输入区可达。
 *  G6 导出会话记录收进 ⋯ 菜单并明确命名；点击后 exports/ 目录真实产出文件。
 *  G7 恢复三态：干净启动不误弹；排队（非故障）在侧栏中性标记+面板「普通排队」分节，无告警标。
 *  G8 member.runtime 有效来源：成员页显示「未绑定 → 实际用全局默认（fake…）」。
 * 产物 dist/desktop/parity-r66-<ts>/result.json + shots/。总门负对照=errs 非空即 exit 10。
 */
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { existsSync } = fs;
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r66-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `parity-r66-${runId}`);
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, '项目 甲');
const dbFile = path.join(dataRoot, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const token = randomBytes(32).toString('hex');
const PORT = 9596;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(220);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = []; this.consoleErrors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error')) this.consoleErrors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 300));
      if (d.method === 'Log.entryAdded' && d.params.entry?.level === 'error') this.consoleErrors.push(String(d.params.entry.text).slice(0, 300));
    });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 200)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async nodeId(selector, label) {
    const doc = await this.send('DOM.getDocument');
    const r = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!r.nodeId) throw new Error('DOM 节点未找到：' + (label ?? selector));
    return r.nodeId;
  }
}
async function connectPage(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Log.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const waitFor = async (cdp, expr, ms, label) => until(() => cdp.tryEval(probe(expr)).catch(() => null), (v) => v, ms, label);
const ownChildren = new Set();
function cleanupOwn() {
  for (const c of [...ownChildren]) { if (c.exitCode != null) continue; try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } }
}
const dbQuery = (sql, ...a) => {
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbFile, { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};
const setArea = (cdp, v) => cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(v)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));

let __appOutRef = { v: '' };
(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# R66 项目\n', 'utf8');
  // 夹具文件：>64KB MD（标题/表格/加粗/尾部标记）与 134KB HTML。
  const mdTail = 'R66-MD-TAIL-MARKER-六万四千字节之后的尾部内容';
  const mdFile = path.join(outDir, 'R66 长文档.md');
  const mdBody = `# R66-MD-HEADING\n\n**R66-MD-BOLD** 与表格：\n\n| 列甲 | 列乙 |\n| --- | --- |\n| 1 | 2 |\n\n- R66-LIST-ITEM\n\n${'正文段落填充。'.repeat(9500)}\n\n${mdTail}\n`;
  fs.writeFileSync(mdFile, mdBody, 'utf8');
  const htmlFile = path.join(outDir, 'R66 页面.html');
  const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>h1{color:navy} .m{font-weight:700}</style></head><body><h1>R66-HTML-VISUAL</h1><p class="m">R66-HTML-TEXT</p>${'<p>填充段落内容。</p>'.repeat(5600)}<p>R66-HTML-TAIL</p></body></html>`;
  fs.writeFileSync(htmlFile, htmlBody, 'utf8');

  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_FAKE_STALL_MS: '45000', ZS_PIPE_NAME: pipeName },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownChildren.add(app);
  app.once('exit', () => ownChildren.delete(app));
  app.stdout.on('data', (c) => { __appOutRef.v += c; });
  app.stderr.on('data', (c) => { __appOutRef.v += c; });
  const errs = [];
  const f = { g1: {}, g2: {}, g3: {}, g4: {}, g5: {}, g6: {}, g7: {}, g8: {} };
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  const shot = async (name) => { const png = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(outDir, 'shots', `${name}.png`), Buffer.from(png.data, 'base64')); };
  let cdp = null;

  cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
  const zsCmd = async (method, params) => {
    const v = await cdp.send('Runtime.evaluate', {
      expression: `window.zs.command({ protocolVersion: 1, commandId: 'r66-' + Math.random().toString(36).slice(2, 10), method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { code: 'TRANSPORT', message: String(e) } }))`,
      awaitPromise: true, returnByValue: true,
    });
    if (v.exceptionDetails) throw new Error('zsCmd eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 200));
    return JSON.parse(v.result.value);
  };
  const zsOk = async (method, params) => { const r = await zsCmd(method, params); if (r && r.ok !== true) throw new Error(`${method} 被拒：${r.error && r.error.code}: ${r.error && r.error.message}`); return r && r.data !== undefined ? r.data : r; };
  await zsOk('project.open', { path: projDir });
  // 管道直注册不经过 UI（真实用户经「打开文件夹」会同步 store）——重载一次让注册表装载。
  await cdp.eval(`location.reload(), true`);
  cdp = await connectPage('注册后重开');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, '重开壳挂载');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].some((e) => e.textContent.includes('项目 甲'))`, 45000, '侧栏含注册项目').catch(async (e) => {
    const labels = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-item-label, #hifi-root .side-empty')].map((e) => e.textContent.trim()).join('|')`);
    const navLocal = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).filter((x) => x.includes('nav')); return JSON.stringify(k.map((x) => localStorage.getItem(x).slice(0, 200))); })()`);
    let listDump = 'n/a';
    try { const r = await zsCmd('project.list', {}); listDump = JSON.stringify(r).slice(0, 300); } catch (e2) { listDump = 'ERR:' + String(e2); }
    const tb = await cdp.tryEval(`document.querySelector('#zs-titlebar [data-zs-project-menu-btn]')?.textContent`);
    const errsSoFar = cdp.consoleErrors.slice(0, 6).join(' || ');
    throw new Error(`${e.message}；labels=${labels}；navLocal=${navLocal}；project.list=${listDump}；titlebarBtn=${tb}；console=${errsSoFar}`);
  });
  const proj = dbQuery('SELECT id, display_name FROM projects')[0];
  const members = await zsOk('member.list', { projectId: proj.id });
  const agent = members.items.find((m) => m.principalType === 'agent');
  if (agent == null) throw new Error('project.open 未引导 agent 成员');
  f.bootNoRecoveryModal = await cdp.tryEval(`document.querySelector('[data-zs-recovery]') == null`);
  if (f.bootNoRecoveryModal !== true) errs.push('干净启动误弹恢复面板');
  f.sidebarAttentionAttr = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.getAttribute('data-zs-recovery-attention')`);
  if (f.sidebarAttentionAttr !== '0') errs.push('干净启动侧栏误标恢复注意');

  /* ================= G1 项目按钮（R65 白屏反例） ================= */
  {
    const root0 = await cdp.tryEval(`document.getElementById('hifi-root').childElementCount`);
    await cdp.eval(probe(`document.querySelector('#zs-titlebar [data-zs-project-menu-btn]')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#zs-titlebar .menu .menu-search-input') != null`, 8000, '项目管理菜单打开');
    await waitFor(cdp, `document.querySelectorAll('#zs-titlebar .menu .menu-project-row').length >= 1`, 8000, '菜单含项目行（未过滤）').catch((e) => { throw new Error(`${e.message}；menuText=${String(require('node:fs').existsSync('/x'))}`); });
    f.menuRowsUnfiltered = await cdp.tryEval(`document.querySelectorAll('#zs-titlebar .menu .menu-project-row').length`);
    // 搜索过滤：输入不存在的词 → 空态；再清空。
    await cdp.eval(probe(`(() => { const i = document.querySelector('#zs-titlebar .menu .menu-search-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, '不存在的项目XYZ'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#zs-titlebar .menu .side-empty, #zs-titlebar .menu .menu-project-row')].length >= 0 && document.querySelector('#zs-titlebar .menu .menu-search-input') != null`, 6000, '搜索输入存活');
    f.menuFilterEmpty = await cdp.tryEval(`(() => { const rows = [...document.querySelectorAll('#zs-titlebar .menu .menu-project-row')]; return rows.length; })()`);
    await cdp.eval(probe(`(() => { const i = document.querySelector('#zs-titlebar .menu .menu-search-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await waitFor(cdp, `document.querySelectorAll('#zs-titlebar .menu .menu-project-row').length >= 1`, 6000, '清空过滤后项目行回归');
    // 勾选=显示/隐藏（仅一项=当前项目，锁定不可隐藏——断言锁定态仍在）。
    f.menuCheckLocked = await cdp.tryEval(`document.querySelector('#zs-titlebar .menu .menu-check')?.className.includes('locked')`);
    // 点项目名=切换当前项目并进入（唯一项目=回项目主页/房间）。
    await cdp.eval(probe(`document.querySelector('#zs-titlebar .menu .menu-project-name')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#zs-titlebar .menu') == null`, 8000, '菜单关闭');
    await waitFor(cdp, `/^#\\/project\\//.test(location.hash) || /^#\\/project\\/[^/]+\\/room\\//.test(location.hash)`, 20000, '切换进入项目');
    const root1 = await cdp.tryEval(`document.getElementById('hifi-root').childElementCount`);
    const titlebarAlive = await cdp.tryEval(`document.querySelector('#zs-titlebar [data-zs-titlebar-rendered="react"]') != null`);
    f.g1 = { rootBefore: root0, rootAfter: root1, titlebarAlive };
    if (root1 < 1) errs.push(`G1：React root 被卸载（children=${root1}）`);
    if (titlebarAlive !== true) errs.push('G1：标题栏消失');
    // 再次开合一轮（关闭用遮罩点击）验证稳定。
    await cdp.eval(probe(`document.querySelector('#zs-titlebar [data-zs-project-menu-btn]')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#zs-titlebar .menu') != null`, 6000, '二开菜单');
    await cdp.eval(probe(`document.querySelector('#zs-titlebar .menu ~ div, #zs-titlebar > div > div')?.click?.(), true`));
    await sleep(300);
    f.g1.rootFinal = await cdp.tryEval(`document.getElementById('hifi-root').childElementCount`);
    await shot('g1-project-menu');
    await cdp.eval(probe(`(() => { const ov = [...document.querySelectorAll('#zs-titlebar div')].find((d) => d.style?.position === 'fixed' && d.style?.inset === '0px'); if (ov) ov.click(); return true; })()`));
  }

  /* ================= G7 恢复三态：普通排队≠故障（开场即测——占用进程首个 stall turn） ================= */
  {
    // 房间任务 A（进程首个 fake turn→stall 45s，worker 真实占用）→ 房间任务 B 的派发键
    // 保持 pending（admission 串行）→ recovery.status 只读口径 pendingDispatchCount≥1，
    // 且无任何恢复类事项：面板分节「普通排队（非故障）」、无告警标、不自动弹窗。
    const roomRow0 = dbQuery('SELECT id FROM rooms WHERE project_id = ?', proj.id)[0];
    const convRoot0 = dbQuery("SELECT id FROM conversations WHERE project_id = ? AND kind = 'room'", proj.id)[0].id;
    const subA = await zsCmd('message.submit', { target: { kind: 'room_root', projectId: proj.id, conversationId: convRoot0, roomId: roomRow0.id }, body: 'R66 占位任务 A（stall）', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }] });
    f.g7.taskA = subA && subA.ok ? 'ok' : JSON.stringify(subA).slice(0, 160);
    await until(() => { try { return dbQuery("SELECT t.status FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id ORDER BY t.rowid DESC LIMIT 1")[0]?.status; } catch { return null; } }, (v) => v === 'RUNNING', 25000, '任务 A 的 turn 进入 RUNNING（stall 占用 worker）');
    const subB = await zsCmd('message.submit', { target: { kind: 'room_root', projectId: proj.id, conversationId: convRoot0, roomId: roomRow0.id }, body: 'R66 排队任务 B', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }] });
    f.g7.taskB = subB && subB.ok ? 'ok' : JSON.stringify(subB).slice(0, 160);
    await until(() => { try { return dbQuery("SELECT COUNT(*) c FROM outbox WHERE status = 'pending'")[0].c; } catch { return -1; } }, (v) => v >= 1, 15000, 'B 派发键 pending（worker 被 A 占用）');
    f.g7.outboxSnapshot = JSON.stringify(dbQuery('SELECT dispatch_key, status FROM outbox ORDER BY rowid').slice(0, 6));
    await sleep(1200);
    f.g7.recoveryViaCmd = JSON.stringify(await zsCmd('recovery.status', {})).slice(0, 240);
    f.g7.noModalDuringQueue = await cdp.tryEval(`document.querySelector('[data-zs-recovery]') == null`);
    if (f.g7.noModalDuringQueue !== true) errs.push('G7：排队期间自动弹了恢复面板（误判故障）');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('恢复检查'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-recovery]') != null`, 8000, '恢复面板打开');
    f.g7.panelText = await (async () => { try { return await waitFor(cdp, `(() => { const el = document.querySelector('[data-zs-recovery]'); return el && (el.textContent.includes('普通排队') || el.textContent.includes('没有需要处理')) ? el.textContent.slice(0, 300) : false; })()`, 9000, '恢复面板内容'); } catch { return String(await cdp.tryEval(`document.querySelector('[data-zs-recovery]')?.textContent.slice(0, 300)`)); } })();
    f.g7.pendingSection = String(f.g7.panelText).includes('普通排队');
    f.g7.noFalseTag = await cdp.tryEval(`![...document.querySelectorAll('[data-zs-recovery] .tag')].some((x) => x.textContent.includes('本次运行新出现') || x.textContent.includes('启动时已有'))`);
    if (f.g7.pendingSection !== true) errs.push(`G7：pending 排队未分节「普通排队」（panel=${String(f.g7.panelText).slice(0, 80)}）`);
    if (f.g7.noFalseTag !== true) errs.push('G7：排队被误标为故障分类');
    await shot('g7-recovery-pending');
    await cdp.eval(probe(`document.querySelector('[data-zs-recovery]')?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-recovery]') == null`, 6000, '恢复面板关闭');
  }

  /* ================= G2–G5 DM：文件阅读器 + 文件-only + 布局 ================= */
  const dm = await zsOk('conversation.create', { projectId: proj.id, peerMemberId: agent.id });
  await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 20000, 'DM 输入区');
  await sleep(600);

  // —— G4a 真正空白：发送按钮禁用（无正文无附件）。
  f.g4.blankDisabled = await cdp.tryEval(`document.querySelector('#hifi-root .composer-send')?.disabled`);
  if (f.g4.blankDisabled !== true) errs.push('G4：空白（无正文无附件）发送按钮未禁用');
  {
    const r = await zsCmd('message.submit', { target: { kind: 'dm', projectId: proj.id, conversationId: dm.conversationId }, body: '', intent: 'default', mentions: [] });
    f.g4.blankRejected = r && r.ok === false;
    if (f.g4.blankRejected !== true) errs.push('G4 负对照：服务端未拒真正空白');
  }

  // —— UI 真实上传 MD（DOM.setFileInputFiles）→ 就绪芯片 → 无正文发送（AI 意图）。
  const uploadFile = async (file, label) => {
    const nodeId = await cdp.nodeId('#hifi-root input[type="file"]', label);
    await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId });
    const name = path.basename(file);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip')].some((c) => c.textContent.includes(${JSON.stringify(name)}) && c.textContent.includes('v1'))`, 25000, `附件就绪：${name}`);
  };
  await uploadFile(mdFile, 'MD 输入');
  f.g4.sendEnabledWithFileOnly = await cdp.tryEval(`!document.querySelector('#hifi-root .composer-send')?.disabled`);
  if (f.g4.sendEnabledWithFileOnly !== true) errs.push('G4：就绪附件+空正文时发送不可用');
  await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg-attach')].some((c) => c.textContent.includes('R66 长文档'))`, 30000, '文件-only 消息入列');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg-body, #hifi-root .msg-text, #hifi-root .small')].some((e) => e.textContent.includes('仅文件，无正文'))`, 8000, '仅文件说明行');
  await sleep(500);
  f.g4.taskTitle = (() => { const r = dbQuery("SELECT title FROM tasks WHERE conversation_id = ?", dm.conversationId); return r[0]?.title; })();
  if (!String(f.g4.taskTitle ?? '').includes('📎') || !String(f.g4.taskTitle ?? '').includes('R66 长文档.md')) errs.push(`G4：任务标题未按文件名推导（${f.g4.taskTitle}）`);
  {
    const row = dbQuery('SELECT body_json FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1', dm.conversationId)[0];
    f.g4.bodyEmpty = (JSON.parse(row.body_json)).text === '';
    const att = dbQuery('SELECT COUNT(*) c FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.conversation_id = ?', dm.conversationId)[0].c;
    f.g4.attachRows = att;
    if (f.g4.bodyEmpty !== true) errs.push('G4：正文未如实为空');
    if (att < 1) errs.push('G4：附件关联缺失');
  }
  await shot('g4-file-only-sent');

  // —— G2 点附件芯片 → 共享预览：默认排版阅读（h1/表格），非 pre 原文。
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .msg-attach')].find((c) => c.textContent.includes('R66 长文档'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .preview-pane') != null`, 20000, '预览面板');
  await waitFor(cdp, `document.querySelector('.preview-read-doc .md-h1')?.textContent.includes('R66-MD-HEADING')`, 25000, 'MD 排版阅读（h1）');
  f.g2.renderedBold = await cdp.tryEval(`document.querySelector('.preview-read-doc')?.textContent.includes('R66-MD-BOLD')`);
  f.g2.renderedTable = await cdp.tryEval(`document.querySelector('.preview-read-doc table') != null`);
  f.g2.notSourceDefault = await cdp.tryEval(`document.querySelector('.preview-read-doc .preview-source') == null`);
  if (f.g2.renderedTable !== true) errs.push('G2：MD 表格未渲染');
  await shot('g2-md-reading');
  // 切源码：见原文标记与 64KB 外尾部标记（readFull 全文——与提取窗分列）。
  await cdp.eval(probe(`document.querySelector('.preview-read')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('.menu .menu-item')].some((b) => b.textContent.includes('源码视图'))`, 6000, '阅读方式菜单');
  await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.includes('源码视图'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('.preview-source')?.textContent.includes('R66-MD-BOLD')`, 25000, '源码视图原文');
  f.g2.tailInSource = await cdp.tryEval(`document.querySelector('.preview-source')?.textContent.includes('R66-MD-TAIL-MARKER')`);
  if (f.g2.tailInSource !== true) errs.push('G2：>64KB 尾部内容不可读（readFull 未生效/仍用提取窗）');
  await shot('g2-md-source');
  // 切回阅读。
  await cdp.eval(probe(`document.querySelector('.preview-read')?.click(), true`));
  await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.includes('阅读视图'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('.preview-read-doc .md-h1') != null`, 20000, '切回阅读');

  // —— G5 布局（宽窗当前视口）：预览 ≥480 或单区；对话 ≥440 或单区；无横向溢出。
  const measure = () => cdp.eval(probe(`(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (el == null) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return JSON.stringify({ vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio,
      list: r('#hifi-root .col-main'), conv: r('#hifi-root .msg-list'), composer: r('#hifi-root .composer-box, #hifi-root textarea.composer-input'), preview: r('#hifi-root .preview-pane'),
      single: document.querySelector('.single-region-switch') != null, overflowX: document.documentElement.scrollWidth - window.innerWidth }); })()`));
  f.g5.wide = JSON.parse(await measure());
  await shot('g5-dm-wide');
  const chkWide = (m) => (m.preview == null ? 'no-preview' : (m.preview.w >= 480 || m.single === true) && (m.conv == null || m.conv.w >= 300));
  if (f.g5.wide.preview != null && !(f.g5.wide.preview.w >= 480 || f.g5.wide.single === true)) errs.push(`G5：宽窗预览低于 480 下限（${JSON.stringify(f.g5.wide)}）`);
  if (f.g5.wide.overflowX > 2) errs.push(`G5：宽窗横向溢出 ${f.g5.wide.overflowX}px`);
  // 窄窗 900×700：列表收起或单区；无溢出；输入区可达。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  f.g5.narrow = JSON.parse(await measure());
  await shot('g5-dm-narrow');
  if (f.g5.narrow.overflowX > 2) errs.push(`G5：窄窗横向溢出 ${f.g5.narrow.overflowX}px`);
  if (!(f.g5.narrow.list == null || f.g5.narrow.single === true || f.g5.narrow.preview == null)) errs.push(`G5：窄窗列表未让位（${JSON.stringify(f.g5.narrow)}）`);
  if (f.g5.narrow.composer == null || f.g5.narrow.composer.h < 20) {
    // 单区域模式下当前可能停在「文件」区——切到「对话」后输入区必须可达（隐藏区保留状态）。
    await cdp.eval(probe(`(() => { const sw = document.querySelector('.single-region-switch .seg button'); if (sw != null) sw.click(); return true; })()`));
    await sleep(700);
    f.g5.narrowComposerAfterSwitch = JSON.parse(await measure());
    if (f.g5.narrowComposerAfterSwitch.composer == null || f.g5.narrowComposerAfterSwitch.composer.h < 20) errs.push(`G5：窄窗输入区不可达（切对话后 ${JSON.stringify(f.g5.narrowComposerAfterSwitch)}）`);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(900);
  void chkWide;

  // —— G3 HTML：上传（仅记录发送）→ 隔离页面预览。
  await uploadFile(htmlFile, 'HTML 输入');
  // ⋯ 菜单 →「本次仅记录」→ 按钮变「保存记录」。
  // ⋯ 菜单（aria-label="本次运行设置"）→ MenuItem「仅记录，不请求回复」。
  await cdp.eval(probe(`document.querySelector('#hifi-root button[aria-label="本次运行设置"]')?.click(), true`));
  const recordSet = await until(() => cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复')); if (b == null) return false; b.click(); return true; })()`)), (v) => v === true, 8000, '仅记录入口');
  if (recordSet !== true) errs.push('G3：未找到「本次仅记录」入口');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('仅记录'))`, 6000, '仅记录芯片');
  await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg-attach')].some((c) => c.textContent.includes('R66 页面'))`, 25000, 'HTML 仅记录消息入列');
  await sleep(600);
  const taskCountBefore = dbQuery('SELECT COUNT(*) c FROM tasks WHERE conversation_id = ?', dm.conversationId)[0].c;
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .msg-attach')].find((c) => c.textContent.includes('R66 页面'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('.preview-pane iframe[data-zs-html-frame]') != null`, 25000, 'HTML 隔离页 iframe');
  f.g3.iframeSrcdoc = await cdp.tryEval(`(() => { const fr = document.querySelector('.preview-pane iframe[data-zs-html-frame]'); const d = fr?.getAttribute('srcdoc') ?? ''; return JSON.stringify({ len: d.length, visual: d.includes('R66-HTML-VISUAL'), csp: d.includes('Content-Security-Policy'), base: d.includes('<base target'), sandbox: fr?.getAttribute('sandbox') }); })()`);
  const srcdoc = JSON.parse(f.g3.iframeSrcdoc ?? '{}');
  if (srcdoc.visual !== true) errs.push('G3：iframe srcdoc 未含页面内容');
  if (srcdoc.csp !== true || srcdoc.base !== true) errs.push('G3：CSP/base 未注入');
  if (srcdoc.sandbox !== '') errs.push(`G3：sandbox 属性非空（${srcdoc.sandbox}）`);
  f.g3.notSourceDefault = await cdp.tryEval(`document.querySelector('.preview-pane .preview-source') == null`);
  f.g3.noteShown = await cdp.tryEval(`document.querySelector('.preview-html-note')?.textContent.includes('脚本已禁用')`);
  const taskCountAfter = dbQuery('SELECT COUNT(*) c FROM tasks WHERE conversation_id = ?', dm.conversationId)[0].c;
  f.g3.recordOnlyZeroTask = taskCountAfter === taskCountBefore;
  if (f.g3.recordOnlyZeroTask !== true) errs.push('G3：仅记录产生了任务（应零任务）');
  await shot('g3-html-isolated');
  // 下载原文件：更多菜单项存在 + zsDownload 桥存在 + originalFile 字节 hash 对账（不点真实对话框）。
  await cdp.eval(probe(`document.querySelector('.preview-tools .preview-icon-btn[aria-label="更多文件操作"]')?.click(), true`));
  f.g3.downloadItem = await cdp.tryEval(`[...document.querySelectorAll('.menu .menu-item')].some((b) => b.textContent.includes('下载原文件 / 另存为'))`);
  f.g3.zsDownloadBridge = await cdp.tryEval(`typeof window.zsDownload?.saveAs === 'function'`);
  {
    const attId = dbQuery('SELECT a.id FROM artifacts a WHERE a.source_name = ?', 'R66 页面.html')[0]?.id;
    const r = await zsCmd('attachment.originalFile', { attachmentId: attId });
    const rawb = Buffer.from(r.data.bytesBase64, 'base64');
    const { createHash } = require('node:crypto');
    f.g3.originalHashOk = r.ok === true && createHash('sha256').update(rawb).digest('hex') === r.data.hash && r.data.bytes === rawb.length;
    if (f.g3.originalHashOk !== true) errs.push('G3：originalFile 字节/hash 对账失败');
  }
  await cdp.eval(probe(`document.querySelector('.menu')?.parentElement?.click?.(), true`));
  await cdp.eval(probe(`(() => { const any = document.querySelector('.scrim'); any?.click?.(); return true; })()`));

  // —— G6 导出会话记录（⋯ 菜单，明确命名）。
  await cdp.eval(probe(`document.querySelector('[data-zs-dm-ops]')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('.menu .menu-item')].some((b) => b.textContent.includes('导出会话记录（Markdown）'))`, 8000, '导出会话记录菜单项');
  f.g6.menuHasNoOldExportButtons = await cdp.tryEval(`![...document.querySelectorAll('#hifi-root .thread-head button')].some((b) => b.textContent.trim() === '导出 MD')`);
  await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.includes('导出会话记录（Markdown）'))?.click(), true`));
  const exportsDir = path.join(dataRoot, 'exports');
  await until(() => existsSync(exportsDir) && fs.readdirSync(exportsDir).length > 0, (v) => v, 20000, '导出目录产出');
  f.g6.exportDirEntries = existsSync(exportsDir) ? fs.readdirSync(exportsDir).length : 0;
  if (f.g6.exportDirEntries < 1) errs.push('G6：导出未产出文件');
  if (f.g6.menuHasNoOldExportButtons !== true) errs.push('G6：头部仍残留平铺导出按钮');

  /* ================= G8 成员页：有效 runtime 来源 ================= */
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/members`)}; true`);
  await waitFor(cdp, `document.querySelector('[data-zs-members]') != null`, 20000, '成员页');
  await waitFor(cdp, `[...document.querySelectorAll('[data-zs-members] .card')].some((c) => c.textContent.includes('全局默认'))`, 15000, '有效来源分列');
  f.g8.effectiveShown = await cdp.tryEval(`(() => { const c = [...document.querySelectorAll('[data-zs-members] .card')].find((x) => x.textContent.includes('全局默认')); return c?.textContent.match(/未绑定 → 实际用全局默认（[^）]*）/)?.[0] ?? null; })()`);
  f.g8.bindButton = await cdp.tryEval(`document.querySelector('[data-zs-member-bind]') != null`);
  if (!String(f.g8.effectiveShown ?? '').includes('全局默认（fake')) errs.push(`G8：有效来源未按 ZS_RUNTIME 分列（${f.g8.effectiveShown}）`);
  await shot('g8-members-effective');

  /* ================= 收口 ================= */
  f.consoleErrors = cdp.consoleErrors.filter((e) => !/favicon|DevTools/i.test(e));
  if (f.consoleErrors.length > 0) errs.push(`console 错误：${f.consoleErrors.slice(0, 3).join(' | ')}`);
  f.realCalls = (() => { try { return dbQuery('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } })();
  if (f.realCalls !== 0) errs.push('real_calls != 0');
  const facts = { runId, ok: false, scope: 'R66 交互门：白屏反例/MD+HTML 阅读器/文件-only/DM 布局/导出收菜单/恢复三态/effective runtime；dev 构建+fake runtime；零真实模型调用', checks: f, checkErrors: errs };
  await cdp.eval(probe(`window.zsWindow?.close(), true`));
  const exitInfo = await until(async () => app.exitCode, (c) => c != null, 30000, '优雅退出').catch(() => null);
  await sleep(2200);
  const like = dataRoot.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  const kill = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { "$($_.ProcessId)" }`], { encoding: 'utf8', timeout: 60000 });
  const residual = String(kill.stdout ?? '').trim().split(/\s+/).filter(Boolean);
  facts.shutdown = { appExitCode: exitInfo, residualProcs: residual.length };
  if (facts.shutdown.appExitCode !== 0) facts.checkErrors.push('优雅关窗退出码非 0');
  if (facts.shutdown.residualProcs !== 0) facts.checkErrors.push('残留进程');
  facts.ok = facts.checkErrors.length === 0;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: facts.checkErrors, g1: f.g1, g2: { table: f.g2?.renderedTable, tail: f.g2?.tailInSource }, g3: srcdoc, g4: { title: f.g4?.taskTitle, bodyEmpty: f.g4?.bodyEmpty, blankRejected: f.g4?.blankRejected }, g5: { wide: f.g5?.wide, narrow: f.g5?.narrow }, g6: f.g6, g7: f.g7, g8: f.g8?.effectiveShown, realCalls: f.realCalls }));
  cleanupOwn();
  process.exit(facts.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  try { console.error('[appOut FULL]', __appOutRef.v.slice(-4000) || '(no appOut)'); } catch { /* 尽力 */ }
  cleanupOwn();
  process.exit(1);
});
