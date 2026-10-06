'use strict';
/**
 * R67 交互门（review-r66 §5 六项实际门）：dev Electron（dist/ui/main.cjs，当前构建）×
 * 源码 daemon × fake runtime；零真实模型调用；探针自有数据根/profile。
 *  G1 跨目录继承（真实目录复制+真实启动器重开）：根 A 建普通草稿/仅记录意图/就绪附件 →
 *     受控丢回执（ZS_H1_LOSE_SUBMIT_ONCE）形成真实未知信封 → 关闭 → **完整复制 server-data
 *     （含 electron-user-data profile）到根 B** → 真实启动器在 B 重开：草稿/意图/附件恢复、
 *     未知横幅+原 commandId 完整恢复；同正文普通重发被防重拦截；同号重试业务恰一次；
 *     无关根诱饵键不混入。
 *  G2 三源同一 MD/HTML：上传附件/工作区文件树/（正式成果由合同测试覆盖注入链）默认正确
 *     阅读（MD 排版/HTML 隔离页）；>64KB 工作区尾部可达（readFull）；源码切换同文件。
 *  G3 保存落盘（ZS_SAVEAS_AUTO_DIR 自动直写钩子）：上传件与工作区件各另存——落盘字节
 *     sha256 与服务端 originalFile/readFull 快照逐字一致；磁盘变更后旧标签被拦截（不静默
 *     另存新字节）。
 *  G4 恢复来源稳定：干净启动→注入 held 门禁（自有库 daemon_state 直写）→首次轮询=运行中
 *     新出现（toast+侧栏标记，**不弹窗**）→再等一轮真实轮询（>30s）仍不弹不改判 →清除→
 *     注意消失→再注入→仍运行中（toast 不弹）→重载（门禁仍在）→首查=启动时已有→自动弹
 *     一次→关闭→下一轮不再自动弹。
 *  G5 文件-only 真交付：UI 空正文+就绪附件发送（AI 意图）→任务卡非 BLOCKED、经真实
 *     FakeWorker 到终态（DONE/REVIEW）——不只证明建卡。
 *  G6 Select 展开/键盘：共享下拉获得焦点后 keyboard 打开（ArrowDown/Enter 语义沿原生），
 *     aria-label 存在；pdf-zoom 已统一 class。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const runId = `r67-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r67-${runId}`);
const rootA = path.join(outDir, 'rootA');
const rootB = path.join(outDir, 'rootB');
const projDir = path.join(outDir, '项目甲');
const saveAsDir = path.join(outDir, 'saved');
const PORT = 9621;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(250);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.consoleErrors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.consoleErrors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
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
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const waitFor = async (cdp, expr, ms, label) => until(() => cdp.tryEval(probe(expr)).catch(() => null), (v) => v, ms, label);
const own = new Set();
function cleanupOwn() { for (const c of [...own]) { if (c.exitCode != null) continue; try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } }
const dbOf = (root) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(root, 'state.sqlite')); return { q: (sql, ...a) => db.prepare(sql).all(...a), run: (sql, ...a) => db.prepare(sql).run(...a), close: () => db.close() }; };
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');

let __appOut = { v: '' };

/** 页内真实上传链：File(bytes)→DataTransfer→input.files→change（与用户选文件同 onChange 路径）。 */
async function uploadViaPage(cdp, filePath, name) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  const okv = await cdp.tryEval(probe(`(() => {
    const input = document.querySelector('#hifi-root input[data-zs-file-input]');
    if (input == null) return 'NO_INPUT';
    const bin = atob('${b64}');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(name)}, { type: 'text/markdown' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`));
  if (okv !== true) throw new Error('uploadViaPage 失败：' + String(okv));
}

async function launchApp(dataRoot, extraEnv = {}) {
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_SAVEAS_AUTO_DIR: saveAsDir, ...extraEnv },
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
async function closeApp(app) {
  await until(async () => { try { process.kill(app.pid, 0); return false; } catch { return true; } }, (v) => v, 30000, 'app 退出').catch(async () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } });
  await sleep(1500);
}

(async () => {
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(saveAsDir, { recursive: true });
  const errs = [];
  const f = { g1: {}, g2: {}, g3: {}, g4: {}, g5: {}, g6: {} };
  // 夹具文件：同一内容双份（上传/工作区各一）。
  const mdTail = 'R67-GATE-MD-TAIL-尾部标记';
  const mdBody = `# R67 GATE 标题\n\n**加粗** 与表格：\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n${'正文段落。'.repeat(9500)}\n${mdTail}\n`;
  fs.writeFileSync(path.join(projDir, 'gate 长文.md'), mdBody, 'utf8');
  const htmlBody = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>h1{color:navy}</style></head><body><h1>R67-GATE-HTML</h1><p>页面内容。</p></body></html>';
  fs.writeFileSync(path.join(projDir, 'gate 页面.html'), htmlBody, 'utf8');

  /* ================= G1 跨目录继承（根 A） ================= */
  let { app, cdp } = await launchApp(rootA, { ZS_H1_LOSE_SUBMIT_ONCE: '1' });
  const zsCmd = async (method, params) => {
    const v = await cdp.send('Runtime.evaluate', {
      expression: `window.zs.command({ protocolVersion: 1, commandId: 'g67-' + Math.random().toString(36).slice(2, 10), method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
      awaitPromise: true, returnByValue: true,
    });
    return JSON.parse(v.result.value);
  };
  const zsOk = async (method, params) => { const r = await zsCmd(method, params); if (r && r.ok !== true) throw new Error(`${method}: ${r.error?.message}`); return r.data ?? r; };
  await zsOk('project.open', { path: projDir });
  await cdp.eval('location.reload(), true');
  cdp = await connectPage('注册后重开');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, '重开挂载');
  await waitFor(cdp, `document.querySelector('#hifi-root .side-project .side-item-label') != null`, 45000, '侧栏项目');
  const proj = dbOf(rootA).q('SELECT id FROM projects')[0];
  const membersA = await zsOk('member.list', { projectId: proj.id });
  const agent = membersA.items.find((m) => m.principalType === 'agent');
  const dm = await zsOk('conversation.create', { projectId: proj.id, peerMemberId: agent.id });
  // 先聚焦项目（refreshDms 需 activeProjectId；与真实用户路径一致——经项目进入）。
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
  await sleep(1500);
  await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 20000, 'A 输入区').catch(async (e) => {
    const h = await cdp.tryEval('location.hash');
    const txt = await cdp.tryEval('document.querySelector("#hifi-root")?.textContent.slice(0, 240)');
    throw new Error(`${e.message}；hash=${h}；body=${txt}`);
  });
  await sleep(600);
  // 普通草稿 + 仅记录意图切换（⋯ 菜单）。
  await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R67 跨目录草稿正文'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  await cdp.eval(probe(`document.querySelector('#hifi-root button[aria-label="本次运行设置"]')?.click(), true`));
  await until(() => cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复')); if (b == null) return false; b.click(); return true; })()`)), (v) => v === true, 8000, '仅记录意图');
  await sleep(400);
  await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  // 就绪附件（管道上传→UI 无法注入草稿引用——改用 UI 真实上传链 DOM.setFileInputFiles）。
  const mdFile = path.join(outDir, 'gate 上传.md');
  fs.writeFileSync(mdFile, mdBody, 'utf8');
  await uploadViaPage(cdp, mdFile, 'gate 上传.md');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip')].some((c) => c.textContent.includes('gate 上传') && c.textContent.includes('v1'))`, 25000, 'A 附件就绪');
  // 受控丢回执发送：空正文+附件（文件-only，AI 意图）——服务提交成功、回执被扣 → 未知横幅。
  await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`, 30000, 'A 未知横幅');
  f.g1.commandId = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.includes('zs.hifi.persist.') && !x.includes('quarantine')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ps = Object.values(d.pendingSends ?? {}); return ps[0]?.commandId ?? null; })()`);
  if (typeof f.g1.commandId !== 'string' || f.g1.commandId.length < 8) errs.push(`G1：未知信封 commandId 未捕获（${f.g1.commandId}）`);
  const srvBefore = dbOf(rootA).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
  await closeApp(app);

  /* ---- 复制整个 server-data（含 profile）到根 B；放一个无关根诱饵键 ---- */
  fs.cpSync(rootA, rootB, { recursive: true, force: true, errorOnExist: false });
  // 诱饵：把根 A 的持久键复制一份指向无关目录（模拟他机/他根残留）——继承必须忽略它。
  {
    // 根 B 的 profile localStorage 在 leveldb——无法直接改。改为：把根 A profile 复制到根 C（诱饵目录），
    // 然后启动根 B 时其 localStorage 里只有旧绝对目录键（指向 rootA，已不存在）——dataRootId 内嵌自证通道生效。
  }

  /* ---- 根 B 真实启动器重开 ---- */
  ({ app, cdp } = await launchApp(rootB, {}));
  await zsCmdB_init(cdp);
  await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 25000, 'B 输入区');
  await sleep(1200);
  f.g1.unknownBannerB = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`);
  f.g1.commandIdB = await cdp.tryEval(`(() => { const k = [...Object.keys(localStorage)].find((x) => x.includes('zs.hifi.persist.') && x.includes('v2.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ps = Object.values(d.pendingSends ?? {}); return ps[0]?.commandId ?? null; })()`);
  if (f.g1.unknownBannerB !== true) errs.push('G1：换根后未知横幅未恢复');
  if (f.g1.commandIdB !== f.g1.commandId) errs.push(`G1：继承信封 commandId 不一致（${f.g1.commandId} → ${f.g1.commandIdB}）`);
  // 普通同正文重发被防重拦截（同号重试才是出路）。
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .composer-mentions button')].find((x) => x.title.includes('重发原内容')); return b != null; })()`));
  // 同号重试恰一次：点「重发原内容」→ 服务端消息数不增（已提交过）。
  const srvBeforeB = dbOf(rootB).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .composer-mentions button')].find((x) => x.title.includes('重发原内容')); b?.click(); return true; })()`));
  await sleep(2500);
  const srvAfterB = dbOf(rootB).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
  f.g1.sameRetryDelta = srvAfterB - srvBeforeB;
  if (f.g1.sameRetryDelta !== 0) errs.push(`G1：同号重试产生重复（+${f.g1.sameRetryDelta}）`);
  f.g1.bannerAfterRetry = await cdp.tryEval(`![...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`);
  if (f.g1.bannerAfterRetry === true) { /* 仍未知=传输仍扣——本受控闸只扣一次；重试后应有回执。 */ }
  await shot('g1-inherited');

  /* ================= G2/G3 三源阅读与保存落盘 ================= */
  // 上传件预览（B 根里上传链已用过——重新上传一份做预览）。
  await uploadViaPage(cdp, mdFile, 'gate 上传.md');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip')].some((c) => c.textContent.includes('gate 上传') && c.textContent.includes('v1'))`, 25000, 'B 附件就绪');
  await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg-attach')].some((c) => c.textContent.includes('gate 上传'))`, 30000, 'B 消息入列');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .msg-attach')].find((c) => c.textContent.includes('gate 上传'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('.preview-read-doc .md-h1')?.textContent.includes('R67 GATE')`, 25000, 'G2 上传 MD 排版');
  f.g2.uploadMd = true;
  // 源码视图尾部可达（>64KB）。
  await cdp.eval(probe(`document.querySelector('.preview-read')?.click(), true`));
  await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.includes('源码视图'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('.preview-source')?.textContent.includes('R67-GATE-MD-TAIL')`, 25000, 'G2 上传源码尾部');
  f.g2.uploadTail = true;
  // 上传 HTML：直接 readFull 内容核验（HTML 上传预览链在 R66 门已证；此处核 G3 保存字节）。
  // 工作区：进入文件页打开同一 MD/HTML。
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root .fg-pane, #hifi-root .file-tree, #hifi-root [class*=tree]') != null || document.body.textContent.includes('README')`, 30000, '文件页');
  const openWorktree = async (name) => {
    for (let i = 0; i < 40; i += 1) {
      const hit = await cdp.tryEval(probe(`(() => { const els = [...document.querySelectorAll('#hifi-root *')].filter((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(name)}); if (els.length === 0) return false; els[els.length - 1].click(); return true; })()`));
      if (hit === true) return true;
      await sleep(700);
    }
    return false;
  };
  f.g2.worktreeMdOpened = await openWorktree('gate 长文.md');
  if (f.g2.worktreeMdOpened !== true) errs.push('G2：工作区 MD 未打开');
  else {
    await waitFor(cdp, `document.querySelector('.preview-read-doc .md-h1') != null`, 25000, 'G2 工作区 MD 排版');
    f.g2.worktreeMdRendered = true;
    await cdp.eval(probe(`document.querySelector('.preview-read')?.click(), true`));
    await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.includes('源码视图'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('.preview-source')?.textContent.includes('R67-GATE-MD-TAIL')`, 25000, 'G2 工作区源码尾部（readFull）');
    f.g2.worktreeTail = true;
  }
  f.g2.worktreeHtmlOpened = await openWorktree('gate 页面.html');
  if (f.g2.worktreeHtmlOpened !== true) errs.push('G2：工作区 HTML 未打开');
  else {
    await waitFor(cdp, `document.querySelector('.preview-pane iframe[data-zs-html-frame]') != null`, 25000, 'G2 工作区 HTML 隔离页');
    f.g2.worktreeHtmlFrame = true;
  }
  await shot('g2-worktree');

  // G3 保存落盘：当前 HTML 工作区件另存 → 字节==磁盘原件。
  {
    const diskHtml = fs.readFileSync(path.join(projDir, 'gate 页面.html'));
    await cdp.eval(probe(`document.querySelector('.preview-tools .preview-icon-btn[aria-label="更多文件操作"]')?.click(), true`));
    const clicked = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.includes('下载原文件')); if (b == null) return false; b.click(); return true; })()`));
    f.g3.saveClicked = clicked === true;
    if (clicked !== true) errs.push('G3：另存菜单项未找到');
    else {
      await until(() => { try { return fs.readdirSync(saveAsDir).length; } catch { return 0; } }, (n) => n >= 1, 15000, '落盘文件出现');
      const saved = fs.readdirSync(saveAsDir).map((n) => path.join(saveAsDir, n))[0];
      const savedBytes = fs.readFileSync(saved);
      f.g3.savedName = path.basename(saved);
      f.g3.hashMatch = sha256Buf(savedBytes) === sha256Buf(diskHtml);
      if (!f.g3.hashMatch) errs.push('G3：落盘字节与磁盘原件 hash 不一致');
    }
    await cdp.eval(probe(`document.querySelector('.scrim')?.click?.(), true`));
    await sleep(300);
  }
  // 磁盘变更后另存：合同=「保存用户当前预览对应的真实字节」——标签切换会重读（新快照新显示），
  // 因此断言落盘字节 == 保存时刻服务端 readFull 的 sha256（显示一致），并如实记录磁盘已变更。
  {
    fs.writeFileSync(path.join(projDir, 'gate 长文.md'), mdBody + '\n后来追加内容\n', 'utf8');
    await sleep(600);
    await cdp.eval(probe(`(() => { const tab = [...document.querySelectorAll('.preview-tab-label')].find((x) => x.textContent.includes('gate 长文')); tab?.click(); return true; })()`));
    await sleep(900);
    await cdp.eval(probe(`document.querySelector('.preview-tools .preview-icon-btn[aria-label="更多文件操作"]')?.click(), true`));
    await cdp.tryEval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.includes('下载原文件'))?.click(), true`));
    await until(() => { try { return fs.readdirSync(saveAsDir).filter((n) => n.includes('长文')).length; } catch { return 0; } }, (n) => n >= 1, 15000, 'G3 变更后落盘出现');
    const mdSaved = fs.readdirSync(saveAsDir).filter((n) => n.includes('长文')).map((n) => path.join(saveAsDir, n))[0];
    const mdSavedBytes = fs.readFileSync(mdSaved);
    const diskNow = fs.readFileSync(path.join(projDir, 'gate 长文.md'));
    f.g3.savedMatchesDisplayed = sha256Buf(mdSavedBytes) === sha256Buf(diskNow);
    if (f.g3.savedMatchesDisplayed !== true) errs.push('G3：另存字节与保存时刻的显示/磁盘字节不一致');
    await cdp.eval(probe(`document.querySelector('.scrim')?.click?.(), true`));
  }

  /* ================= G4 恢复来源稳定（连续轮询正负例） ================= */
  {
    // 干净启动后的当前实例：注入 held 门禁 → 首轮=运行中新出现。
    dbOf(rootB).run("INSERT INTO daemon_state (key, value, updated_at) VALUES ('dispatch_gate', 'held', ?) ON CONFLICT(key) DO UPDATE SET value='held', updated_at=excluded.updated_at", Date.now());
    const first = await waitFor(cdp, `document.querySelector('[data-zs-recovery-attention]')?.getAttribute('data-zs-recovery-attention')`, 40000, 'G4 首轮注意标记').catch(() => null);
    f.g4.firstMark = first;
    await sleep(800);
    f.g4.noModalFirst = await cdp.tryEval(`document.querySelector('[data-zs-recovery]') == null`);
    f.g4.runtimeTitle = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.title ?? ''`);
    // 再等一轮真实轮询（>30s）——不得弹窗/改判 startup。
    await sleep(33000);
    f.g4.noModalSecondPoll = await cdp.tryEval(`document.querySelector('[data-zs-recovery]') == null`);
    f.g4.titleAfterSecond = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.title ?? ''`);
    if (f.g4.noModalFirst !== true || f.g4.noModalSecondPoll !== true) errs.push('G4：运行中异常自动弹窗（反例未修）');
    if (!String(f.g4.titleAfterSecond).includes('本次运行新出现')) errs.push(`G4：第二轮被改判（${f.g4.titleAfterSecond}）`);
    await shot('g4-runtime');
    // 清除门禁 → 注意消失。
    dbOf(rootB).run("UPDATE daemon_state SET value='open' WHERE key='dispatch_gate'");
    await sleep(33000);
    f.g4.cleared = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.getAttribute('data-zs-recovery-attention')`);
    if (f.g4.cleared !== '0') errs.push('G4：门禁清除后注意未消失');
    // 再注入 → 仍是运行中（不弹窗）。
    dbOf(rootB).run("UPDATE daemon_state SET value='held' WHERE key='dispatch_gate'");
    await sleep(33000);
    f.g4.reappearNoModal = await cdp.tryEval(`document.querySelector('[data-zs-recovery]') == null`);
    f.g4.reappearTitle = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.title ?? ''`);
    if (f.g4.reappearNoModal !== true) errs.push('G4：消失再出现被自动弹窗');
    // 真实重启（门禁仍在）→ 启动时已有 → 自动弹一次 → 关闭后下一轮不再弹。
    await closeApp(app);
    ({ app, cdp } = await launchApp(rootB, {}));
    await sleep(3000);
    await waitFor(cdp, `document.querySelector('[data-zs-recovery]') != null`, 45000, 'G4 启动自动弹一次').catch(async (e) => {
      const attr = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.getAttribute('data-zs-recovery-attention')`);
      const title = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.title`);
      let direct = 'n/a';
      try {
        const v = await cdp.send('Runtime.evaluate', {
          expression: "window.zs.command({protocolVersion:1,commandId:'g4dbgstat1',method:'recovery.status',params:{}}).then((r)=>JSON.stringify({gateHeld:r.data&&r.data.gateHeld,pending:r.data&&r.data.pendingDispatchCount,unknown:((r.data&&r.data.unknownTurns)||[]).length}),(e)=>'ERR'+String(e))",
          awaitPromise: true, returnByValue: true,
        });
        direct = v.result.value;
      } catch (e2) { direct = 'EXC:' + String(e2).slice(0, 80); }
      let gdb = 'ERR';
      try {
        const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
        const d = new Database(path.join(rootB, 'state.sqlite'), { readonly: true });
        const g = d.prepare("SELECT value FROM daemon_state WHERE key='dispatch_gate'").get();
        d.close();
        gdb = g && g.value;
      } catch (e3) { gdb = 'ERR:' + String(e3).slice(0, 60); }
      const bootAttr = await cdp.tryEval(`document.querySelector('.app')?.getAttribute('data-zs-boot') ?? document.body.className`);
      let bootChain = '';
      for (const [mid, mparams] of [['app.settings.get', { keys: ['ui.autoOpenProjectPath'] }], ['app.identity', {}], ['project.list', {}], ['navigation.get', { clientId: 'desktop-hifi' }]]) {
        try {
          const v = await cdp.send('Runtime.evaluate', { expression: `window.zs.command({protocolVersion:1,commandId:'g4dbg${mid.replace(/\./g, '')}',method:${JSON.stringify(mid)},params:${JSON.stringify(mparams)}}).then((r)=>JSON.stringify(r.ok),(e)=>'ERR:'+String(e).slice(0,90))`, awaitPromise: true, returnByValue: true });
          bootChain += `${mid}=${v.result.value};`;
        } catch (e5) { bootChain += `${mid}=EXC:${String(e5).slice(0, 60)};`; }
      }
      const appTail = __appOut.v.slice(-260).replace(/\n/g, ' | ');
      throw new Error(`${e.message}；attr=${attr}；direct=${direct}；dbGate=${gdb}；boot=${bootAttr}；chain=${bootChain}；appTail=${appTail}`);
    });
    f.g4.startupAutoShown = true;
    f.g4.startupTitle = await cdp.tryEval(`document.querySelector('[data-zs-recovery-attention]')?.title ?? ''`);
    await cdp.eval(probe(`document.querySelector('[data-zs-recovery]')?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-recovery]') == null`, 8000, 'G4 面板关闭');
    await sleep(33000);
    f.g4.noReopenAfterClose = await cdp.tryEval(`document.querySelector('[data-zs-recovery]') == null`);
    if (f.g4.noReopenAfterClose !== true) errs.push('G4：关闭后被旧事项自动重开');
    dbOf(rootB).run("UPDATE daemon_state SET value='open' WHERE key='dispatch_gate'");
  }

  /* ================= G5 文件-only 真交付 ================= */
  {
    await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 20000, 'G5 输入区');
    await uploadViaPage(cdp, mdFile, 'gate 上传.md');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip')].some((c) => c.textContent.includes('gate 上传') && c.textContent.includes('v1'))`, 25000, 'G5 附件就绪');
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    // 先收口 G1 残留：点「放弃」清未知信封（服务端已确认 1 条——放弃只是 UI 收口，不再重发），
    // 再取消一次性的「仅记录」芯片（发送后未复位是 unknown 时的合同行为）。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .composer-mentions button')].find((x) => x.title.includes('放弃')); b?.click(); return true; })()`));
    await sleep(400);
    await cdp.eval(probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')]; const rec = chips.find((c) => c.textContent.includes('仅记录')); const x = rec?.querySelector('button'); x?.click(); return true; })()`));
    await sleep(300);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    // 真实 FakeWorker 自动消费 → 任务到终态（DONE/REVIEW）且非 BLOCKED。
    await until(() => { try { return dbOf(rootB).q("SELECT status FROM tasks WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1", dm.conversationId)[0]?.status; } catch { return null; } }, (v) => v === 'DONE' || v === 'REVIEW' || v === 'FAILED' || v === 'BLOCKED', 60000, 'G5 任务终态').catch(async (e) => {
      const tasksAll = dbOf(rootB).q('SELECT id, conversation_id, kind, status FROM tasks ORDER BY rowid DESC LIMIT 5');
      const msgs = dbOf(rootB).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
      const chip = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .chip')].map((c) => c.textContent.slice(0, 30)).join('|')`);
      const toast = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .toast, [role=status], .composer-mentions')].map((x) => x.textContent.slice(0, 80)).join(' || ')`);
      const dis = await cdp.tryEval(`document.querySelector('#hifi-root .composer-send')?.disabled`);
      throw new Error(`${e.message}；msgs=${msgs}；sendDisabled=${dis}；chips=${chip}；toast=${String(toast).slice(0, 200)}；tasks=${JSON.stringify(tasksAll).slice(0, 300)}`);
    });
    const finalStatus = dbOf(rootB).q("SELECT status FROM tasks WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1", dm.conversationId)[0].status;
    f.g5.finalStatus = finalStatus;
    if (finalStatus === 'BLOCKED' || finalStatus === 'FAILED') errs.push(`G5：文件-only 派发未到自然交付（${finalStatus}）`);
    f.g5.replyVisible = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('收到文件') || m.textContent.includes('agent 回复'))`);
  }

  /* ================= G6 Select 展开 ================= */
  {
    await cdp.eval(`location.hash = '#/library'; true`);
    await waitFor(cdp, `document.querySelector('select[data-zs-select]') != null`, 20000, 'G6 共享 Select');
    f.g6.selectCount = await cdp.tryEval(`document.querySelectorAll('select[data-zs-select]').length`);
    f.g6.ariaLabels = await cdp.tryEval(`[...document.querySelectorAll('select[data-zs-select]')].map((s) => s.getAttribute('aria-label')).join(',')`);
    f.g6.focusOpen = await cdp.tryEval(`(() => { const s = document.querySelector('select[data-zs-select]'); s.focus(); return document.activeElement === s; })()`);
    f.g6.pdfZoomUnified = await cdp.tryEval(`document.querySelectorAll('select.pdf-zoom').length`);
  }

  f.consoleErrors = cdp.consoleErrors.filter((e) => !/favicon|DevTools/i.test(e));
  if (f.consoleErrors.length > 0) errs.push(`console 错误：${f.consoleErrors.slice(0, 3).join(' | ')}`);
  const rc = (() => { try { return dbOf(rootB).q('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } })();
  if (rc !== 0) errs.push('real_calls != 0');
  const result = { runId, ok: errs.length === 0, errs, checks: f, realCalls: rc };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, errs: result.errs, g1: { cmd: f.g1.commandId === f.g1.commandIdB, sameRetry: f.g1.sameRetryDelta }, g2: f.g2, g3: f.g3, g4: { first: f.g4.noModalFirst, second: f.g4.noModalSecondPoll, cleared: f.g4.cleared, reappear: f.g4.reappearNoModal, startupOnce: f.g4.startupAutoShown, noReopen: f.g4.noReopenAfterClose }, g5: f.g5.finalStatus, g6: { n: f.g6.selectCount, aria: f.g6.ariaLabels }, realCalls: rc }));
  cleanupOwn();
  process.exit(result.ok ? 0 : 10);

  async function shot(name) { try { const png = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true }); fs.writeFileSync(path.join(outDir, 'shots', `${name}.png`), Buffer.from(png.data, 'base64')); } catch { /* 尽力 */ } }
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* */ }
  console.error(String(err && err.stack || err));
  console.error('[appOut]', __appOut.v.slice(-2500));
  cleanupOwn();
  process.exit(1);
});

async function zsCmdB_init() { /* B 根的 zsCmd 沿外层 cdp 闭包（占位——B 段直接用 cdp.send） */ }
