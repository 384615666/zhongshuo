/**
 * 远程浏览器客户端（DEV-25 第三十一轮五）：同源静态页（GET / + /app.js——script-src 'self'
 * 严格 CSP，禁第三方脚本；无内联脚本）。
 * 链路：配对（IndexedDB 存 deviceCredential——同源；accessToken 仅内存）→ /session →
 * /cmd（与桌面同一命令面/幂等 scope）+ /ws-ticket → WSS /events（lastSeq 续传+eventId
 * 去重；cursor-stale 走 HTTP 快照）。写操作全部走认证 HTTP；浏览器退出≠停止服务器任务。
 * 本页是双机验收的客户端载体（不含本机保留方法——服务端 REMOTE_BLOCKED_METHODS 拒绝）。
 */
export const REMOTE_CLIENT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>众说 · 远程访问</title>
<style>
body{font-family:system-ui,'Microsoft YaHei',sans-serif;margin:0;background:#f6f7fa;color:#20242c}
main{max-width:860px;margin:0 auto;padding:24px}
h1{font-size:20px} h2{font-size:15px;margin:18px 0 8px}
.card{background:#fff;border:1px solid #e3e6ee;border-radius:8px;padding:12px 16px;margin:8px 0}
.meta{color:#68708a;font-size:12px}
input,select,button,textarea{font:inherit}
input,select{padding:6px 8px;border:1px solid #c9cfdd;border-radius:6px;margin:2px}
button{padding:6px 12px;border:1px solid #c9cfdd;border-radius:6px;background:#fff;cursor:pointer;margin:2px}
button.primary{background:#2456d6;color:#fff;border-color:#2456d6}
.msg{border-top:1px solid #eef0f6;padding:8px 0}
.msg .body{white-space:pre-wrap;word-break:break-word;font-size:14px}
.feed div{border-top:1px dashed #e3e6ee;padding:4px 0;font-size:13px}
.warn{color:#a05a00} .ok{color:#1c7c43}
#setup input{width:220px}
#composer textarea{width:100%;min-height:64px;box-sizing:border-box}
.hidden{display:none}
</style>
</head>
<body>
<main>
<h1>众说 · 远程访问（浏览器客户端）</h1>
<div id="identity" class="meta"></div>
<section id="setup" class="card">
  <h2>配对</h2>
  <div class="meta">在桌面端「设置 → 远程访问」创建配对码，然后在此输入（5 分钟内一次有效）。</div>
  <div><input id="pairing-id" placeholder="pairingId"><input id="pairing-code" placeholder="配对码"><input id="device-name" placeholder="设备名（如 客厅电脑）"></div>
  <div><button id="pair-btn" class="primary">配对并保存</button><button id="forget-btn">清除本机凭据</button></div>
  <div id="setup-status" class="meta"></div>
</section>
<section id="main" class="hidden">
  <div class="card">
    <h2>会话与消息</h2>
    <select id="conversation-sel"></select><button id="refresh-btn">刷新</button>
    <div id="messages" class="card"></div>
    <div id="composer">
      <textarea id="send-text" placeholder="输入消息（默认交给 AI）"></textarea>
      <div><button id="send-btn" class="primary">发送</button><button id="record-btn">仅记录</button><label class="meta"><input type="file" id="attach-file"> 附件</label><span id="attach-name" class="meta"></span></div>
    </div>
  </div>
  <div class="card">
    <h2>任务</h2>
    <div id="tasks" class="feed"></div>
  </div>
  <div class="card">
    <h2>导出</h2>
    <div><button id="export-md">导出 Markdown</button><button id="export-html">导出 HTML</button><a id="export-link" class="hidden">下载导出包</a></div>
  </div>
  <div class="card">
    <h2>事件流（WSS）</h2>
    <div id="feed" class="feed"></div>
  </div>
</section>
</main>
<script src="/app.js"></script>
</body>
</html>`;

export const REMOTE_CLIENT_JS = `'use strict';
// ---------- 状态 ----------
let accessToken = null; // 仅内存（会话轮换不撤销 deviceCredential）
let device = null;      // {deviceId, credential}（credential 存 IndexedDB——同源）
let conversations = [];
let currentConversation = null;
let eventsSeen = new Set(); // eventId 去重
let lastSeq = null;
let ws = null;
let wsTicketRetry = 0;

// ---------- IndexedDB（deviceCredential 同源持久；不称保险箱——禁第三方脚本+严格 CSP） ----------
function idb() { return new Promise((res, rej) => { const q = indexedDB.open('zs-remote', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }
async function idbDel(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').delete(k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }

// ---------- HTTP ----------
async function api(path, body, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth === 'device' && device) headers.authorization = 'Device ' + device.credential;
  if (auth === 'bearer' && accessToken) headers.authorization = 'Bearer ' + accessToken;
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((data.error && data.error.message) || ('HTTP ' + r.status)), { status: r.status, code: data.error && data.error.code });
  return data;
}
async function cmd(method, params, commandId) {
  const cid = commandId || ('rc-' + crypto.randomUUID().slice(0, 12));
  const out = await api('/cmd', { commandId: cid, method, params: params || {} }, 'bearer');
  if (out.ok === false) throw Object.assign(new Error((out.error && out.error.message) || '命令失败'), { code: out.error && out.error.code });
  return out;
}
async function ensureSession() {
  if (accessToken) return;
  const r = await api('/session', {}, 'device');
  accessToken = r.accessToken;
}

// ---------- 配对 ----------
document.getElementById('pair-btn').onclick = async () => {
  const st = document.getElementById('setup-status');
  try {
    const pairingId = document.getElementById('pairing-id').value.trim();
    const code = document.getElementById('pairing-code').value.trim();
    const deviceName = document.getElementById('device-name').value.trim() || '浏览器设备';
    const clientNonce = crypto.randomUUID();
    const r = await api('/pair', { pairingId, code, deviceName, clientNonce });
    if (r.clientNonce !== clientNonce) throw new Error('clientNonce 不匹配——响应可能被重放');
    device = { deviceId: r.deviceId, credential: r.deviceCredential };
    await idbSet('device', device);
    st.textContent = '配对成功：' + r.deviceId;
    await enterMain();
  } catch (e) { st.textContent = '配对失败：' + e.message; st.className = 'meta warn'; }
};
document.getElementById('forget-btn').onclick = async () => { await idbDel('device'); device = null; accessToken = null; location.reload(); };

// ---------- 主界面 ----------
async function enterMain() {
  await ensureSession();
  document.getElementById('setup').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  document.getElementById('identity').textContent = '设备 ' + device.deviceId + ' · ' + location.origin;
  await refreshConversations();
  await connectEvents();
  await refreshTasks();
}
async function refreshConversations() {
  const r = await cmd('conversation.list', {});
  const sel = document.getElementById('conversation-sel');
  conversations = (r.data && r.data.conversations) || [];
  sel.innerHTML = '';
  for (const c of conversations) {
    const o = document.createElement('option');
    const convId = c.conversationId || c.id;
    o.value = convId;
    o.textContent = '私信 ' + (c.peerName || c.title || convId.slice(0, 10)) + '（项目 ' + (c.projectId || c.project_id || '') + '）';
    sel.appendChild(o);
  }
  if (conversations.length > 0) { currentConversation = conversations[0]; await loadMessages(); }
  sel.onchange = () => { currentConversation = conversations.find((c) => c.conversationId === sel.value) || null; void loadMessages(); };
}
async function loadMessages() {
  if (!currentConversation) return;
  const box = document.getElementById('messages');
  box.textContent = '加载中…';
  try {
    const r = await cmd('conversation.history', { conversationId: currentConversation.conversationId, limit: 30 });
    const items = (r.data && (r.data.messages || r.data.items)) || [];
    box.textContent = '';
    for (const m of items.slice().reverse()) {
      const d = document.createElement('div');
      d.className = 'msg';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = new Date(m.createdAt || m.created_at || Date.now()).toLocaleString() + ' · ' + (m.authorType || m.author_type || '') + ' · ' + (m.authorId || m.author_id || '');
      const body = document.createElement('div');
      body.className = 'body';
      const rawBody = m.body_json ?? m.body;
      const bj = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody || {});
      body.textContent = bj.text || '';
      d.appendChild(meta); d.appendChild(body); box.appendChild(d);
    }
  } catch (e) { box.textContent = '消息读取失败：' + e.message; }
}
document.getElementById('refresh-btn').onclick = () => { void refreshConversations().then(loadMessages).catch(showErr); };

let attachArtifactId = null;
document.getElementById('attach-file').onchange = async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  document.getElementById('attach-name').textContent = '上传中…';
  try {
    await ensureSession();
    const buf = await f.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const isPng = f.type === 'image/png', isJpg = f.type === 'image/jpeg', isGif = f.type === 'image/gif', isWebp = f.type === 'image/webp';
    const method = isPng || isJpg || isGif || isWebp ? 'attachment.uploadImage'
      : /\\.pdf$/i.test(f.name) ? 'attachment.uploadPdf'
      : /\\.docx$|\\.xlsx$|\\.pptx$/i.test(f.name) ? 'attachment.uploadOffice'
      : /\\.csv$/i.test(f.name) ? 'attachment.uploadCsv'
      : 'attachment.uploadText';
    const params = { conversationId: currentConversation.conversationId, filename: f.name };
    if (method === 'attachment.uploadText') params.content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    else params.contentBase64 = b64;
    const r = await cmd(method, params);
    attachArtifactId = r.data.attachmentId;
    document.getElementById('attach-name').textContent = '已上传：' + f.name + (r.data.truncated ? '（超预算截断）' : '');
  } catch (e) { document.getElementById('attach-name').textContent = '上传失败：' + e.message; }
};
async function send(intent) {
  const text = document.getElementById('send-text').value;
  if (!currentConversation || text.trim().length === 0) return;
  try {
    await ensureSession();
    const target = { kind: 'dm', projectId: currentConversation.projectId || currentConversation.project_id, conversationId: currentConversation.conversationId };
    const params = { target, body: text, intent, mentions: [] };
    if (attachArtifactId != null) { params.attachmentRefs = [attachArtifactId]; attachArtifactId = null; document.getElementById('attach-name').textContent = ''; }
    await cmd('message.submit', params);
    document.getElementById('send-text').value = '';
    await loadMessages();
  } catch (e) { if (e.code === 'IMAGE_INPUT_UNVERIFIED') { alert('图片输入能力未认证——请去掉图片附件或选择「仅记录」'); } else showErr(e); }
}
document.getElementById('send-btn').onclick = () => void send('default');
document.getElementById('record-btn').onclick = () => void send('record_only');

async function refreshTasks() {
  const box = document.getElementById('tasks');
  try {
    const r = await cmd('board.view', { scope: 'all' });
    box.textContent = '';
    for (const g of (r.data && r.data.groups) || []) {
      for (const room of g.rooms || []) {
        for (const c of room.cards || []) {
          const d = document.createElement('div');
          d.textContent = '[' + g.displayName + '/' + room.name + '] ' + c.title + ' · ' + c.column + (c.exitUnconfirmed ? '（退出未确认）' : '');
          const stop = document.createElement('button');
          stop.textContent = '停止';
          stop.disabled = c.runId == null;
          stop.onclick = () => cmd('task.stop', { taskId: c.taskId, targetRunId: c.runId, expectedStopGeneration: c.stopGeneration }).then(() => refreshTasks()).catch(showErr);
          const accept = document.createElement('button');
          accept.textContent = '验收通过';
          accept.disabled = c.pendingDelivery == null;
          accept.onclick = () => cmd('task.review', { taskId: c.taskId, decision: 'accept', deliveryId: c.pendingDelivery.deliveryId, deliveryRevision: c.pendingDelivery.revision, manifestHash: c.pendingDelivery.manifestHash }).then(() => refreshTasks()).catch(showErr);
          d.appendChild(stop); d.appendChild(accept);
          box.appendChild(d);
        }
      }
    }
    if (box.children.length === 0) box.textContent = '暂无任务卡片。';
  } catch (e) { box.textContent = '任务读取失败：' + e.message; }
}

async function runExport(format) {
  try {
    await ensureSession();
    if (!currentConversation) return;
    const r = await cmd('export.create', { target: { kind: 'conversation', projectId: currentConversation.projectId || currentConversation.project_id, conversationId: currentConversation.conversationId }, format });
    const a = document.getElementById('export-link');
    a.href = '/export/' + r.data.exportId + '/download';
    a.download = r.data.exportId + '.zip';
    a.textContent = '下载导出包（' + r.data.exportId + '）';
    a.className = '';
  } catch (e) { showErr(e); }
}
document.getElementById('export-md').onclick = () => void runExport('md');
document.getElementById('export-html').onclick = () => void runExport('html');

// ---------- WSS 事件流 ----------
function feedLine(kind, text) {
  const f = document.getElementById('feed');
  const d = document.createElement('div');
  d.textContent = kind + ' · ' + text;
  f.insertBefore(d, f.firstChild);
  while (f.children.length > 50) f.removeChild(f.lastChild);
}
async function connectEvents() {
  try {
    await ensureSession();
    const t = await api('/ws-ticket', {}, 'bearer');
    const proto = location.protocol === 'https:' ? 'wss:' : 'wss:';
    ws = new WebSocket(proto + '//' + location.host + '/events');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'authenticate', ticket: t.ticket, lastSeq }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'event') {
        if (eventsSeen.has(m.eventId)) return; // 重复事件按 eventId 去重
        eventsSeen.add(m.eventId);
        lastSeq = Math.max(lastSeq || 0, m.seq);
        feedLine(m.kind, (m.projectId || '') + ' seq=' + m.seq);
        if (m.kind === 'message.submitted') void loadMessages().catch(() => {});
      } else if (m.type === 'authenticated') { lastSeq = Math.max(lastSeq || 0, m.fromSeq || 0); feedLine('connected', 'from seq=' + m.fromSeq + (m.resume ? '（续传）' : '')); }
      else if (m.type === 'cursor-stale') { lastSeq = m.fromSeq; feedLine('cursor-stale', '游标过期——新事件从 ' + m.fromSeq + ' 开始（历史走 activity.list 快照）'); }
      else if (m.type === 'subscribed') feedLine('subscribed', m.projectId);
      // 订阅全部项目（演示面；细粒度订阅控制按项目提交）
      if (m.type === 'authenticated' && ws && ws.readyState === 1) {
        const seenP = new Set();
        for (const c of conversations) { const pid = c.projectId || c.project_id; if (pid && !seenP.has(pid)) { seenP.add(pid); ws.send(JSON.stringify({ type: 'subscribe', projectId: pid })); } }
      }
    };
    ws.onclose = () => {
      feedLine('disconnected', '事件流断开（服务器任务不受影响）——重连中');
      if (wsTicketRetry < 30) { wsTicketRetry++; setTimeout(() => void connectEvents(), 2000); }
    };
  } catch (e) { feedLine('error', e.message); }
}

function showErr(e) { feedLine('error', e.message); console.error(e); }

// ---------- 启动 ----------
(async () => {
  const saved = await idbGet('device');
  if (saved && saved.credential) {
    device = saved;
    try { await enterMain(); return; } catch (e) {
      document.getElementById('setup-status').textContent = '已存凭据不可用（可能已吊销）：' + e.message + '——请重新配对';
      document.getElementById('setup-status').className = 'meta warn';
    }
  }
  document.getElementById('setup').classList.remove('hidden');
})();
`;
