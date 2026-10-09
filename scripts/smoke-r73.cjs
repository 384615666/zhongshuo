#!/usr/bin/env node
/** R73 冒烟：A 自动收起 / B 真分隔条拖动 / C 放大还原Esc / 导航取消。 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'dist', 'desktop', `smoke-r73-${Date.now()}`);
const root = path.join(outDir, 'root');
fs.mkdirSync(root, { recursive: true });
const projDir = path.join(outDir, 'projA');
const projDirB = path.join(outDir, 'projB');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(projDirB, { recursive: true });
fs.writeFileSync(path.join(projDir, '说明.md'), '# A 项目文件\n\nFILES-PAGE-MARKER 内容', 'utf8');
fs.writeFileSync(path.join(projDirB, 'B说明.md'), '# B 项目\n', 'utf8');
const PORT = 9713;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) { const t0 = Date.now(); for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error(`超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`); await sleep(250); } }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; } if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.errors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 300)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async shot(p) { try { const png = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(png.data, 'base64')); } catch { /* */ } }
}
async function connect(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
const app = spawn(path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
  cwd: repo, env: { ...process.env, ZS_APP_DATA: root, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
app.stderr.on('data', () => {});
(async () => {
  let cdp = await connect('启动');
  await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 60000, 'hifi');
  const pageCmd = async (method, params) => {
    const v = await cdp.send('Runtime.evaluate', { expression: `window.zs.command({ protocolVersion: 1, commandId: 'r73s-${Math.random().toString(36).slice(2, 10)}', method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`, awaitPromise: true, returnByValue: true });
    return JSON.parse(v.result.value);
  };
  const pageOk = async (m, p) => { const r = await pageCmd(m, p); if (r.ok !== true) throw new Error(`${m}: ${r.error?.message}`); return r.data ?? r; };
  const a = (await pageOk('project.open', { path: projDir })).project;
  await cdp.eval('location.reload(), true');
  cdp = await connect('重载');
  await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 60000, 'hifi 重载');
  await sleep(2500);
  // 聚焦 A → 文件页
  await cdp.eval('location.hash = ' + JSON.stringify(`/project/${a.id}`) + '; true');
  await until(() => cdp.tryEval(probe(`document.body.textContent.includes('默认房间')`)), (v) => v, 45000, '项目A');
  await cdp.eval('location.hash = ' + JSON.stringify(`/project/${a.id}/files`) + '; true');
  await until(() => cdp.tryEval(`document.querySelector('#hifi-root .file-tree') != null`), (v) => v, 30000, '文件页');
  // 打开工作区 MD
  await until(() => cdp.tryEval(probe(`document.body.textContent.includes('说明.md')`)), (v) => v, 30000, '树列');
  await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '说明.md'); rows[rows.length - 1]?.click(); return true; })()`));
  await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .preview-body')?.textContent.includes('FILES-PAGE-MARKER')`)), (v) => v, 45000, '文件页预览打开');

  /* ===== A：切房间自动收起 ===== */
  const roomId = (() => { const db = new Database(path.join(root, 'state.sqlite')); return db.prepare('SELECT id FROM rooms LIMIT 1').get().id; })();
  await cdp.eval('location.hash = ' + JSON.stringify(`/room/${roomId}`) + '; true');
  await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root textarea.composer-input') != null`)), (v) => v, 30000, '房间输入区');
  await sleep(1200);
  const aState = await cdp.eval(probe(`(() => ({
    composer: document.querySelector('#hifi-root textarea.composer-input') != null,
    previewPaneVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(),
    reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null,
    pool: document.querySelector('#hifi-root .col-main') != null,
  }))()`));
  console.log('A1 房间态:', JSON.stringify(aState), (aState.composer && !aState.previewPaneVisible && aState.pool) ? 'PASS' : 'FAIL');
  // 回文件页：显式重开（再点树节点）恢复——标签不重复、内容与阅读位置保留。
  // 离开前先留一个滚动位置（preview-body 记 scrollTop）。
  await cdp.eval('location.hash = ' + JSON.stringify(`/project/${a.id}/files`) + '; true');
  await until(() => cdp.tryEval(probe(`document.body.textContent.includes('说明.md')`)), (v) => v, 30000, '回文件页');
  const scrollBefore = await cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); if (b == null) return null; b.scrollTop = 80; b.dispatchEvent(new Event('scroll', { bubbles: true })); return Math.round(b.scrollTop); })()`));
  await sleep(400);
  // 切走再回来（重选节点=显式重开）
  await cdp.eval('location.hash = ' + JSON.stringify(`/room/${roomId}`) + '; true');
  await until(() => cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`), (v) => v, 30000, '房间2');
  await cdp.eval('location.hash = ' + JSON.stringify(`/project/${a.id}/files`) + '; true');
  await until(() => cdp.tryEval(probe(`document.body.textContent.includes('说明.md')`)), (v) => v, 30000, '文件页2');
  await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '说明.md'); rows[rows.length - 1]?.click(); return true; })()`));
  await until(() => cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); return b != null && b.textContent.includes('FILES-PAGE-MARKER'); })()`)), (v) => v, 45000, '显式重开');
  const tabsCount = await cdp.tryEval(`document.querySelectorAll('#hifi-root .preview-tab').length`);
  console.log('A2 显式重开恢复: tabs=' + tabsCount + '（应=1，不重复）', tabsCount === 1 ? 'PASS' : 'FAIL');

  /* ===== A3：在途读取不回弹（大 PPT 树点击 250ms 后进房间） ===== */
  fs.copyFileSync('C:/Users/user/Documents/文档测试/内蒙古职工互助系统建设方案@1010.pptx', path.join(projDir, '内蒙古职工互助系统建设方案@1010.pptx'));
  await cdp.eval('location.hash = ' + JSON.stringify(`/project/${a.id}/files`) + '; true');
  await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .file-tree') != null`)), (v) => v, 30000, '文件页3');
  await cdp.eval('location.hash = ' + JSON.stringify('/settings') + '; true');
  await sleep(500);
  await cdp.eval('location.hash = ' + JSON.stringify(`/project/${a.id}/files`) + '; true');
  await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .file-tree') != null`)), (v) => v, 30000, '文件页4');
  await until(() => cdp.tryEval(probe(`document.body.textContent.includes('内蒙古职工互助系统建设方案@1010.pptx')`)), (v) => v, 30000, '树列PPT');
  await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '内蒙古职工互助系统建设方案@1010.pptx'); rows[rows.length - 1]?.click(); return true; })()`));
  await sleep(250);
  await cdp.eval(probe(`(() => { const rooms = [...document.querySelectorAll('#hifi-root button.side-item.sub')]; const hit = rooms.find((x) => x.textContent.includes('默认房间')); hit?.click(); return hit != null; })()`));
  await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root textarea.composer-input') != null`)), (v) => v, 30000, '在途后进房间');
  // 逐步观察 hidden 翻转（reopenBtn 出现=hidden；pane 出现=visible）
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const st = await cdp.tryEval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); const rb = document.querySelector('#hifi-root .preview-reopen'); return { pv: p != null && p.getBoundingClientRect().width > 0, rb: rb != null }; })()`));
    if (i % 2 === 0 || (st && st.pv)) console.log(`t+${(i + 1) * 500}ms`, JSON.stringify(st));
  }
  const inflight = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 30), composer: document.querySelector('#hifi-root textarea.composer-input') != null, pvVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(), reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null, attAttr: document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages') }))()`));
  console.log('A3 在途读取后房间态:', JSON.stringify(inflight), (!inflight.pvVisible && inflight.composer) ? 'PASS' : 'FAIL-回弹');

  /* ===== B：房间草稿上传预览 → 真分隔条拖动 ===== */
  await cdp.eval('location.hash = ' + JSON.stringify(`/room/${roomId}`) + '; true');
  await until(() => cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`), (v) => v, 30000, '回房间');
  await sleep(600);
  // 房间内上传 MD（草稿）→ 预览（openedFrom=room → 不自动收起）
  const b64 = Buffer.from('# 房间文件\n\nROOM-FILE-CONTENT', 'utf8').toString('base64');
  await cdp.eval(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], '房间文件.md', { type: 'text/markdown' })); const input = document.querySelector('#hifi-root input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  for (let i = 0; i < 40; i += 1) { await sleep(500); const st = await cdp.tryEval(probe(`(() => { const cs = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')]; return cs.length > 0 && cs.every((c) => c.getAttribute('data-zs-att') === 'ready'); })()`)); if (st === true) break; }
  await cdp.eval(probe(`(() => { const cs = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')]; const c = cs.find((x) => x.getAttribute('data-zs-att') === 'ready'); const b = [...c.querySelectorAll('button')].find((y) => y.textContent.trim() === '预览'); b?.click(); return true; })()`));
  await until(() => cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); return b != null && b.textContent.includes('ROOM-FILE-CONTENT'); })()`)), (v) => v, 45000, '房间预览（不自动收起）');
  await cdp.eval(probe(`(() => { window.__ev = []; const sp = document.querySelector('#hifi-root .splitter[aria-label*="预览"]'); if (sp == null) return 'NO-SP'; const rec = (k) => (e) => window.__ev.push([k, Math.round(e.clientX), e.pointerId ?? -1]); for (const k of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup']) sp.addEventListener(k, rec(k), { capture: true, passive: true }); return 'HOOKED'; })()`));
  const rectOf = async () => cdp.eval(probe(`(() => { const ctx = document.querySelector('#hifi-root .col-main'); const pv = document.querySelector('#hifi-root .preview-pane'); const sp = document.querySelector('#hifi-root .splitter[aria-label*="预览"]'); const r = (el) => el == null ? null : (() => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), w: Math.round(b.width) }; })(); return { ctx: r(ctx), pv: r(pv), splitter: r(sp) }; })()`));
  const before = await rectOf();
  console.log('B0 布局:', JSON.stringify(before), before.splitter != null && before.ctx != null && before.pv != null ? '（分隔条在真实边界）' : 'FAIL-无分隔条');
  // 原生 pointer 拖动（向左拖 200 = 预览变宽）
  const sp = before.splitter;
  const cx = Math.round(sp.l + 2); const cy = Math.round((before.ctx.l + before.ctx.w + before.pv.l) / 2);
  // 用分隔条中心 y：直接取它的 rect
  const spRect = await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .splitter[aria-label*="预览"]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`));
  // 先拖右（预览变窄——初始 608 已在上限附近，直接向左拖会撞 clamp）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spRect.x, y: spRect.y, button: 'left', clickCount: 1 });
  for (const dx of [40, 80, 120, 160]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spRect.x + dx, y: spRect.y, button: 'left', buttons: 1 });
    await sleep(120);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spRect.x + 200, y: spRect.y, button: 'left', clickCount: 1 });
  await sleep(600);
  const afterNarrow = await rectOf();
  console.log('B1 拖右(预览变窄):', JSON.stringify(afterNarrow), afterNarrow.pv.w < before.pv.w - 100 ? 'PASS' : 'FAIL');
  // 反方向拖左（预览变宽，回到接近原宽）
  const spRect2 = await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .splitter[aria-label*="预览"]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spRect2.x, y: spRect2.y, button: 'left', clickCount: 1 });
  for (const dx of [-40, -100, -160, -200]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spRect2.x + dx, y: spRect2.y, button: 'left', buttons: 1 });
    await sleep(120);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spRect2.x - 200, y: spRect2.y, button: 'left', clickCount: 1 });
  await sleep(600);
  const afterWide = await rectOf();
  console.log('B2 拖左(预览变宽):', JSON.stringify(afterWide), afterWide.pv.w > afterNarrow.pv.w + 100 ? 'PASS' : 'FAIL');
  // 双击复位
  await cdp.eval(probe(`(() => { const sp = document.querySelector('#hifi-root .splitter[aria-label*="预览"]'); sp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`));
  await sleep(500);
  const afterReset = await rectOf();
  console.log('B3 双击复位(→620 显示上限内):', JSON.stringify(afterReset), Math.abs(afterReset.pv.w - Math.min(620, before.pv.w)) < 6 ? 'PASS' : 'FAIL');

  /* ===== C：放大/还原/Esc ===== */
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('放大预览')); b?.click(); return b != null; })()`));
  await sleep(500);
  const maxRect = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane');
    const anchor = p.offsetParent == null ? 'none' : (p.offsetParent.className || p.offsetParent.tagName) + '@t' + Math.round(p.offsetParent.getBoundingClientRect().top);
    const cs = getComputedStyle(p); const ws = document.querySelector('#hifi-root .workspace'); const b = p.getBoundingClientRect(); const wb = ws.getBoundingClientRect(); const btn = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('还原预览大小')); return { pv: { l: Math.round(b.left), w: Math.round(b.width), t: Math.round(b.top), h: Math.round(b.height) }, ws: { l: Math.round(wb.left), w: Math.round(wb.width), t: Math.round(wb.top), h: Math.round(wb.height), pt: getComputedStyle(ws).paddingTop }, anchor, pos: cs.position, cssTop: cs.top, cssInset: cs.inset, cssH: cs.height, inline: p.style.cssText.slice(0, 120), matched: (() => { const out = []; for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { continue; } for (const r of rules) { if (r.selectorText != null && r.selectorText.includes('preview-pane') && r.style != null && (r.style.top || r.style.height || r.style.position)) out.push(r.selectorText + '{' + (r.style.top ? 'top:' + r.style.top + ';' : '') + (r.style.height ? 'h:' + r.style.height + ';' : '') + (r.style.position ? 'pos:' + r.style.position + ';' : '') + '}'); } } return out.slice(0, 6); })(), anims: p.getAnimations({ subtree: false }).map((a) => a.constructor.name + ':' + String(a.transitionProperty ?? '')).slice(0, 3), restoreBtn: btn != null, maximizedCls: p.classList.contains('maximized') }; })()`));
  const fills = maxRect.maximizedCls && Math.abs(maxRect.pv.l - maxRect.ws.l) < 4 && Math.abs(maxRect.pv.w - maxRect.ws.w) < 4 && Math.abs(maxRect.pv.t - maxRect.ws.t) < 4;
  console.log('C1 放大铺满工作区:', JSON.stringify(maxRect), fills ? 'PASS' : 'FAIL');
  // Esc 还原
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(600);
  const afterEsc = await rectOf();
  const escOk = afterEsc.pv != null && Math.abs(afterEsc.pv.w - before.pv.w) < 3;
  console.log('C2 Esc 还原:', JSON.stringify(afterEsc), escOk ? 'PASS' : 'FAIL');
  // 再放大 → 按钮还原
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('放大预览')); b?.click(); return true; })()`));
  await sleep(400);
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('还原预览大小')); b?.click(); return true; })()`));
  await sleep(500);
  const afterBtn = await rectOf();
  console.log('C3 按钮还原:', Math.abs(afterBtn.pv.w - before.pv.w) < 3 ? 'PASS' : 'FAIL', JSON.stringify(afterBtn));

  /* ===== 导航取消（B→A 定位在途→设置页） ===== */
  const projB = (await pageOk('project.open', { path: projDirB })).project;
  // raw command 不写前端注册表——重载让 bootRemembered 装载（真实「打开文件夹」链即时 upsert）。
  await cdp.eval('location.reload(), true');
  cdp = await connect('重载B');
  await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 60000, 'hifi 重载B');
  await sleep(2500);
  // 制造 A 的任务线程（fake 派发）
  const db2 = new Database(path.join(root, 'state.sqlite'));
  const conv = db2.prepare('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1').get(a.id, 'room');
  const roomRow = db2.prepare('SELECT id FROM rooms WHERE project_id = ? LIMIT 1').get(a.id);
  const members = await pageOk('member.list', { projectId: a.id });
  const agent = members.items.find((m) => m.principalType === 'agent');
  await pageCmd('message.submit', { target: { kind: 'room_root', projectId: a.id, conversationId: conv.cid, roomId: roomRow.id }, body: 'R73冒烟任务', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }] });
  await until(() => { try { return new Database(path.join(root, 'state.sqlite')).prepare('SELECT count(*) c FROM task_deliveries').get().c; } catch { return 0; } }, (c) => c >= 1, 180000, 'A 交付');
  const threadId = new Database(path.join(root, 'state.sqlite')).prepare('SELECT conversation_thread_id FROM tasks WHERE project_id = ? LIMIT 1').get(a.id).conversation_thread_id;
  // 延迟 thread.get 的转发层
  // 活跃切到 B（真用户动作：经项目主页聚焦）
  await cdp.eval('location.hash = ' + JSON.stringify(`/project/${projB.id}`) + '; true');
  await until(() => cdp.tryEval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .side-row.context-active')]; return rows.length > 0 && (rows[0].querySelector('.side-item-label')?.textContent ?? '').includes('projB'); })()`)), (v) => v, 30000, 'B 聚焦');
  // 打开 A 线程深链 → **同一任务内**立刻转设置页：effect 首个 await（动态 import）后
  // thread.get 已发出（微任务先于 hashchange 任务执行），取消在回执到达之前落位——
  // 与独立复核「回执在途时用户跳走」同一时序，且确定性复现（不走不可重定义的桥）。
  await cdp.eval(probe(`(() => { location.hash = ${JSON.stringify(`/thread/${threadId}`)}; location.hash = '/settings'; return location.hash; })()`));
  await until(() => cdp.tryEval(probe(`location.hash.startsWith('#/settings')`)), (v) => v, 15000, '设置页');
  await sleep(5000); // 等延迟回执+取消窗口
  const navState = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 40), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim(), toast: [...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 40)) }))()`));
  const navOk = navState.hash.startsWith('#/settings') && navState.active.includes('projB') && navState.toast.length === 0;
  console.log('NAV 取消后保持 B+设置页:', JSON.stringify(navState), navOk ? 'PASS' : 'FAIL');
  // 服务端导航偏好未被旧请求改写
  const prefs = await pageCmd('navigation.get', { clientId: 'default' });
  const prefProj = prefs.data?.prefs?.activeProjectId ?? prefs.prefs?.activeProjectId ?? null;
  console.log('NAV navigation.get activeProjectId:', JSON.stringify(prefProj), prefProj == null || prefProj === projB.id ? 'PASS(未写A)' : 'CHECK');
  // 正例：不再取消的同一深链应正常完成（跨项目对齐+线程打开）
  await cdp.eval('location.hash = ' + JSON.stringify(`/thread/${threadId}`) + '; true');
  await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .col-thread') != null`)), (v) => v, 60000, '正例深链线程');
  const posState = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 50), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim(), thread: document.querySelector('#hifi-root .col-thread') != null }))()`));
  console.log('NAV 正例深链完成:', JSON.stringify(posState), posState.thread && posState.active.includes('projA') ? 'PASS' : 'FAIL');
  console.log('console errors:', JSON.stringify(cdp.errors.slice(0, 4)));
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exitCode = 1; }).finally(() => {
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
