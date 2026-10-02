/**
 * 远程浏览器客户端（DEV-25 第三十一轮五建；第三十二轮三按可操作闭环重写）。
 * 同源静态页（GET / + /app.js——script-src 'self' 严格 CSP，禁第三方脚本；无内联脚本）。
 * 第三十二轮三闭环：
 * - **认证下载**：导出=认证 fetch→Blob→临时 objectURL 触发真实下载（token 不进 URL；
 *   同源 fetch 自带合规 Origin）；页面保留本次字节供验收核对；
 * - **房间+DM 任务面**：会话选择器含房间（room.list→room_root 发送）与 DM；任务区合并
 *   board.view（房间任务）与 conversation.list 执行态（DM 任务）——页面发起的 DM 任务可
 *   停止/验收；任务状态事件触发刷新（不只新消息）；
 * - **附件与草稿**：有界 base64（分块转换——String.fromCharCode(...整份) 参数上限坑）；
 *   上传固定目标键+异步回执回原键（A→B→A 不串附件）；发送成功才清实际发送的正文与
 *   refs（失败/图片门拒绝保留草稿）；
 * - **重试与恢复**：写操作信封持久（localStorage pendingOps）——响应丢失/刷新后沿原
 *   commandId 重试（恰一次）；lastSeq 持久+cursor-stale 后拉 activity.list 同范围快照
 *   →再订阅+eventId 去重；token 到期自动续换（401 TOKEN_EXPIRED→重换→重发一次）；
 *   吊销明确终态（不再重连）；history 响应带目标/代次保护（迟到不重绘其他会话）。
 */
export const REMOTE_CLIENT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>众说 · 远程访问</title>
<style>
body{font-family:system-ui,'Microsoft YaHei',sans-serif;margin:0;background:#f6f7fa;color:#20242c}
main{max-width:880px;margin:0 auto;padding:24px}
h1{font-size:20px} h2{font-size:15px;margin:18px 0 8px}
.card{background:#fff;border:1px solid #e3e6ee;border-radius:8px;padding:12px 16px;margin:8px 0}
.meta{color:#68708a;font-size:12px}
input,select,button,textarea{font:inherit}
input,select{padding:6px 8px;border:1px solid #c9cfdd;border-radius:6px;margin:2px}
button{padding:6px 12px;border:1px solid #c9cfdd;border-radius:6px;background:#fff;cursor:pointer;margin:2px}
button.primary{background:#2456d6;color:#fff;border-color:#2456d6}
.msg{border-top:1px solid #eef0f6;padding:8px 0}
.msg .body{white-space:pre-wrap;word-break:break-word;font-size:14px}
.msg .att{font-size:12px;color:#47506a;margin-top:4px}
.feed div{border-top:1px dashed #e3e6ee;padding:4px 0;font-size:13px}
.warn{color:#a05a00} .ok{color:#1c7c43} .fatal{color:#b3261e;font-weight:600}
#setup input{width:220px}
#composer textarea{width:100%;min-height:64px;box-sizing:border-box}
.hidden{display:none}
#pending-ops .op{display:flex;gap:8px;align-items:center;font-size:13px;margin:4px 0}
.chip{display:inline-block;border:1px solid #c9cfdd;border-radius:10px;padding:1px 8px;font-size:12px;background:#f2f4f9;margin:1px}
</style>
</head>
<body>
<main>
<h1>众说 · 远程访问（浏览器客户端）</h1>
<div id="identity" class="meta"></div>
<div id="revoked-banner" class="card fatal hidden">设备已被吊销：凭据/会话/事件流全部失效。如需再次访问，请在桌面端重新生成配对码并重新配对。</div>
<div id="pending-ops" class="card hidden"></div>
<section id="setup" class="card">
  <h2>配对</h2>
  <div class="meta">在桌面端「远程访问」面板创建配对码，然后在此输入（5 分钟内一次有效）。</div>
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
      <textarea id="send-text" placeholder="输入消息（默认交给 AI；房间消息进主池，私信按 1 对 1）"></textarea>
      <div>
        <button id="send-btn" class="primary">发送</button>
        <button id="record-btn">仅记录</button>
        <label class="meta"><input type="file" id="attach-file"> 附件</label><span id="attach-name" class="meta"></span>
        <span id="attach-chips"></span>
      </div>
    </div>
  </div>
  <div class="card">
    <h2>任务</h2>
    <div class="meta">房间任务（看板）与私信任务（执行态）合并呈现——可停止；验收绑定 deliveryId/revision/manifestHash。</div>
    <div id="tasks" class="feed"></div>
  </div>
  <div class="card">
    <h2>导出</h2>
    <div><button id="export-md">导出 Markdown</button><button id="export-html">导出 HTML</button><button id="export-docx">导出 DOCX</button></div>
    <div class="meta" id="export-note">认证下载（fetch→Blob→保存）——token 不进 URL。</div>
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
let accessToken = null; // 仅内存（到期自动续换——不撤销 deviceCredential）
let device = null;      // {deviceId, credential}（IndexedDB 同源持久）
let targets = [];       // [{kind:'dm'|'room', key, projectId, conversationId, roomId?, label}]
let currentTarget = null;
/** 键控草稿（第三十二轮三）：A→B→A 不串附件/正文——按目标键存 {text, attachIds, attachNames}。 */
const drafts = new Map();
const draftOf = (k) => { if (!drafts.has(k)) drafts.set(k, { text: '', attachIds: [], attachNames: [] }); return drafts.get(k); };
let revoked = false;
let ws = null;
let wsRetry = 0;
let eventsSeen = loadSeen();
let historyGen = 0; // 迟到 history 响应代次保护

// ---------- 本地持久（localStorage——同源） ----------
function loadSeen() { try { return new Set(JSON.parse(localStorage.getItem('zs-seen-events') ?? '[]')); } catch { return new Set(); } }
function saveSeen() { try { const arr = [...eventsSeen]; if (arr.length > 500) arr.splice(0, arr.length - 500); localStorage.setItem('zs-seen-events', JSON.stringify(arr)); } catch (e) { void e; } }
function loadPendingOps() { try { return JSON.parse(localStorage.getItem('zs-pending-ops') ?? '{}'); } catch { return {}; } }
function savePendingOps(ops) { try { localStorage.setItem('zs-pending-ops', JSON.stringify(ops)); } catch (e) { void e; } }
let lastSeq = (() => { const n = Number(localStorage.getItem('zs-last-seq')); return Number.isInteger(n) && n >= 0 ? n : null; })();
function saveLastSeq(n) { lastSeq = n; try { localStorage.setItem('zs-last-seq', String(n)); } catch (e) { void e; } }

// ---------- IndexedDB（deviceCredential 同源持久） ----------
function idb() { return new Promise((res, rej) => { const q = indexedDB.open('zs-remote', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }
async function idbDel(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').delete(k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }

// ---------- HTTP（token 到期自动续换） ----------
async function renewSession() {
  if (device == null) throw new Error('未配对');
  const r = await fetch('/session', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Device ' + device.credential } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 长期凭据被拒=吊销终态（renewSession 不走 api 包装——这里单独收口）。
    if (data.error && (data.error.code === 'DEVICE_REVOKED' || data.error.code === 'CREDENTIAL_INVALID')) enterRevokedTerminal();
    throw Object.assign(new Error((data.error && data.error.message) || ('session ' + r.status)), { status: r.status, code: data.error && data.error.code });
  }
  accessToken = data.accessToken;
}
async function api(path, body, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth === 'device' && device) headers.authorization = 'Device ' + device.credential;
  if (auth === 'bearer' && accessToken) headers.authorization = 'Bearer ' + accessToken;
  let r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  if (r.status === 401 && auth === 'bearer' && !path.endsWith('/session')) {
    // 自动续换（第三十二轮三）：token 到期→重换→重试一次；吊销=终态。
    await renewSession();
    headers.authorization = 'Bearer ' + accessToken;
    r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  }
  const data = await r.json().catch(() => ({}));
  if (data.error && (data.error.code === 'DEVICE_REVOKED' || data.error.code === 'CREDENTIAL_INVALID')) enterRevokedTerminal();
  if (!r.ok) throw Object.assign(new Error((data.error && data.error.message) || ('HTTP ' + r.status)), { status: r.status, code: data.error && data.error.code });
  return data;
}
async function cmd(method, params, commandId) {
  const cid = commandId || ('rc-' + crypto.randomUUID().slice(0, 12));
  const out = await api('/cmd', { commandId: cid, method, params: params || {} }, 'bearer');
  if (out.ok === false) throw Object.assign(new Error((out.error && out.error.message) || '命令失败'), { code: out.error && out.error.code });
  return out;
}
/** 写操作：信封持久（第三十二轮三）——响应丢失/刷新后沿原 commandId 重试恰一次。 */
async function cmdOnce(opKey, method, params) {
  const ops = loadPendingOps();
  const existing = ops[opKey];
  const commandId = existing != null ? existing.commandId : 'rc-' + crypto.randomUUID().slice(0, 12);
  const payload = existing != null ? existing.params : params;
  ops[opKey] = { commandId, method, params: payload, at: Date.now() };
  savePendingOps(ops);
  try {
    const out = await cmd(method, payload, commandId);
    const ops2 = loadPendingOps();
    delete ops2[opKey];
    savePendingOps(ops2);
    renderPendingOps();
    return out;
  } catch (e) {
    renderPendingOps();
    throw e;
  }
}
function renderPendingOps() {
  const box = document.getElementById('pending-ops');
  const ops = loadPendingOps();
  const keys = Object.keys(ops);
  box.classList.toggle('hidden', keys.length === 0 || revoked);
  box.innerHTML = '';
  for (const k of keys) {
    const op = ops[k];
    const row = document.createElement('div');
    row.className = 'op';
    const label = document.createElement('span');
    label.textContent = '未完成操作（' + op.method + '）——响应丢失或中断；重试沿原编号恰一次';
    const btn = document.createElement('button');
    btn.textContent = '重试';
    btn.onclick = () => void cmdOnce(k, op.method, op.params).then(() => { if (currentTarget != null) void loadMessages().catch(() => {}); }).catch((e) => feedLine('error', '重试失败：' + e.message));
    row.append(label, btn);
    box.append(row);
  }
}

// ---------- 吊销终态 ----------
function enterRevokedTerminal() {
  if (revoked) return;
  revoked = true;
  accessToken = null;
  document.getElementById('revoked-banner').classList.remove('hidden');
  document.getElementById('pending-ops').classList.add('hidden');
  try { if (ws && ws.readyState <= 1) ws.close(); } catch (e) { void e; }
  feedLine('revoked', '设备已吊销——通道终态（不再重连）');
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

// ---------- 会话与消息（含房间——DM 任务操作面） ----------
async function enterMain() {
  await renewSession();
  document.getElementById('setup').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  document.getElementById('identity').textContent = '设备 ' + device.deviceId + ' · ' + location.origin;
  await refreshTargets(true);
  renderPendingOps();
  await connectEvents();
  await refreshTasks();
  // 任务面低频轮询（第三十二轮三补）：停滞/无事件窗口不冻结执行态——running↔queued 演进
  // 与待验收出现都可在 5s 内刷新（事件驱动之外的事实兜底；只读零运行）。
  if (window.__tasksTimer == null) {
    window.__tasksTimer = setInterval(() => { if (!revoked) void refreshTasks().catch(() => {}); }, 5000);
  }
}
async function refreshTargets(initial) {
  const dms = await cmd('conversation.list', {}).then((r) => (r.data && r.data.conversations) || []).catch(() => []);
  const projectIds = [...new Set(dms.map((c) => c.projectId || c.project_id))];
  const rooms = [];
  for (const pid of projectIds) {
    // eslint-disable-next-line no-await-in-loop
    const rl = await cmd('room.list', { projectId: pid }).then((r) => (r.data && r.data.items) || []).catch(() => []);
    for (const room of rl) rooms.push({ kind: 'room', projectId: pid, roomId: room.id, conversationId: room.conversationId, label: '房间 ' + room.name + (room.conversationId == null ? '（无会话）' : '') });
  }
  targets = [
    ...dms.map((c) => ({ kind: 'dm', key: 'dm:' + (c.conversationId || c.id), projectId: c.projectId || c.project_id, conversationId: c.conversationId || c.id, label: '私信 ' + (c.peerDisplayName || c.title || String(c.conversationId || c.id).slice(0, 10)) })),
    ...rooms.map((r) => ({ ...r, key: 'room:' + r.roomId })),
  ];
  const sel = document.getElementById('conversation-sel');
  const prev = initial ? null : sel.value;
  sel.innerHTML = '';
  for (const t of targets) {
    const o = document.createElement('option');
    o.value = t.key;
    o.textContent = t.label + '（' + t.projectId.slice(0, 8) + '…）';
    sel.appendChild(o);
  }
  if (prev != null && targets.some((t) => t.key === prev)) sel.value = prev;
  sel.onchange = () => { const t = targets.find((x) => x.key === sel.value) || null; switchTarget(t); };
  const t = targets.find((x) => x.key === (prev ?? sel.value)) || targets[0] || null;
  switchTarget(t);
}
function switchTarget(t) {
  currentTarget = t;
  if (t != null) {
    const d = draftOf(t.key);
    document.getElementById('send-text').value = d.text;
    renderChips();
    void loadMessages().catch(() => {});
  }
}
async function loadMessages() {
  const box = document.getElementById('messages');
  if (currentTarget == null || currentTarget.kind !== 'dm') {
    if (currentTarget != null && currentTarget.kind === 'room' && currentTarget.conversationId != null) {
      const gen = ++historyGen;
      const r = await cmd('room.pool', { roomId: currentTarget.roomId }).catch(() => null);
      if (gen !== historyGen) return; // 迟到保护
      const threads = (r && r.data && (r.data.threads || r.data.items)) || [];
      box.textContent = '房间主池按线程组织（线程 ' + threads.length + '）：';
      for (const th of threads.slice(0, 20)) box.textContent += String.fromCharCode(10) + '· ' + (th.title || th.rootTaskId || th.threadId || JSON.stringify(th).slice(0, 60));
    } else {
      box.textContent = '请选择私信会话查看消息；房间消息按线程组织（列表见上）。';
    }
    return;
  }
  const gen = ++historyGen;
  const convId = currentTarget.conversationId;
  const r = await cmd('conversation.history', { conversationId: convId, limit: 30 });
  if (gen !== historyGen || currentTarget == null || currentTarget.conversationId !== convId) return; // 迟到/切走：不重绘另一会话
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
    d.appendChild(meta); d.appendChild(body);
    const atts = (m.attachments ?? m.attachmentSummaries) || [];
    for (const a of atts) {
      const att = document.createElement('div');
      att.className = 'att';
      att.textContent = '📎 ' + (a.displayName ?? a.display_name ?? a.filename ?? a.artifactId ?? '') + (a.hash != null ? '（sha256 ' + String(a.hash).slice(0, 12) + '…）' : '');
      d.appendChild(att);
    }
    box.appendChild(d);
  }
}
document.getElementById('refresh-btn').onclick = () => { void refreshTargets(false).catch(showErr); void refreshTasks().catch(() => {}); }; // 刷新=会话+任务（不依赖事件到达的兜底入口）

// ---------- 附件（有界 base64+键控草稿） ----------
function boundedBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // String.fromCharCode 参数上限（整份展开必 RangeError）
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
document.getElementById('attach-file').onchange = async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f || currentTarget == null) return;
  const targetKey = currentTarget.key; // 固定目标（异步回执回原键——A→B→A 不串）
  const nameBox = document.getElementById('attach-name');
  nameBox.textContent = '上传中…';
  try {
    if (accessToken == null) await renewSession();
    const buf = await f.arrayBuffer();
    const b64 = boundedBase64(buf);
    const isImg = /^image\\/(png|jpeg|gif|webp)/.test(f.type);
    const method = isImg ? 'attachment.uploadImage'
      : /\\.pdf$/i.test(f.name) ? 'attachment.uploadPdf'
      : /\\.docx$|\\.xlsx$|\\.pptx$/i.test(f.name) ? 'attachment.uploadOffice'
      : /\\.csv$/i.test(f.name) ? 'attachment.uploadCsv'
      : 'attachment.uploadText';
    const params = { conversationId: currentTarget.conversationId, filename: f.name };
    if (method === 'attachment.uploadText') params.content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    else params.contentBase64 = b64;
    const r = await cmd(method, params);
    draftOf(targetKey).attachIds.push(r.data.attachmentId);
    draftOf(targetKey).attachNames.push(f.name + (r.data.truncated ? '（超预算截断）' : ''));
    nameBox.textContent = '已上传：' + f.name;
    if (currentTarget.key === targetKey) renderChips(); // 仍在原目标才重绘（切走不打扰 B）
  } catch (e) { nameBox.textContent = '上传失败：' + e.message; }
  ev.target.value = '';
};
function renderChips() {
  const box = document.getElementById('attach-chips');
  box.innerHTML = '';
  if (currentTarget == null) return;
  const d = draftOf(currentTarget.key);
  d.attachNames.forEach((name, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = '📎' + name;
    const x = document.createElement('a');
    x.textContent = '×';
    x.style.cursor = 'pointer';
    x.onclick = () => { d.attachIds.splice(i, 1); d.attachNames.splice(i, 1); renderChips(); };
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

// ---------- 发送（成功才清实际发送的内容；失败保留；同号重试） ----------
async function send(intent) {
  if (currentTarget == null) return;
  const t = currentTarget;
  const d = draftOf(t.key);
  const text = document.getElementById('send-text').value;
  if (text.trim().length === 0 && d.attachIds.length === 0) return;
  const target = t.kind === 'dm'
    ? { kind: 'dm', projectId: t.projectId, conversationId: t.conversationId }
    : { kind: 'room_root', projectId: t.projectId, conversationId: t.conversationId, roomId: t.roomId };
  const params = { target, body: text, intent, mentions: [] };
  if (d.attachIds.length > 0) params.attachmentRefs = [...d.attachIds];
  try {
    await cmdOnce('send:' + t.key + ':' + intent, 'message.submit', params);
    // 成功才清实际发送的正文与 refs（图片门拒绝/网络失败保留草稿）。
    d.text = '';
    d.attachIds = [];
    d.attachNames = [];
    if (currentTarget != null && currentTarget.key === t.key) { document.getElementById('send-text').value = ''; renderChips(); }
    document.getElementById('attach-name').textContent = '';
    await loadMessages();
  } catch (e) {
    if (e.code === 'IMAGE_INPUT_UNVERIFIED') feedLine('gate', '图片输入能力未认证——请去掉图片附件或选「仅记录」（草稿与附件已保留）');
    else showErr(e);
  }
}
document.getElementById('send-btn').onclick = () => void send('default');
document.getElementById('record-btn').onclick = () => void send('record_only');
document.getElementById('send-text').oninput = (ev) => { if (currentTarget != null) draftOf(currentTarget.key).text = ev.target.value; };

// ---------- 任务（房间看板+DM 执行态合并；状态事件驱动刷新） ----------
async function refreshTasks() {
  if (revoked) return;
  const box = document.getElementById('tasks');
  try {
    const [board, dms] = await Promise.all([
      cmd('board.view', { scope: 'all' }).catch(() => null),
      cmd('conversation.list', {}).catch(() => ({ conversations: [] })),
    ]);
    box.textContent = '';
    for (const g of (board && board.data && board.data.groups) || []) {
      for (const room of g.rooms || []) {
        for (const c of room.cards || []) {
          const d = document.createElement('div');
          d.textContent = '[' + g.displayName + '/' + room.name + '] ' + c.title + ' · ' + c.column + (c.exitUnconfirmed ? '（退出未确认）' : '');
          const stop = document.createElement('button');
          stop.textContent = '停止';
          stop.disabled = c.runId == null;
          stop.onclick = () => cmdOnce('stop:' + c.taskId, 'task.stop', { taskId: c.taskId, targetRunId: c.runId, expectedStopGeneration: c.stopGeneration }).then(() => refreshTasks()).catch(showErr);
          const accept = document.createElement('button');
          accept.textContent = '验收通过';
          accept.disabled = c.pendingDelivery == null;
          accept.onclick = () => cmdOnce('accept:' + c.taskId, 'task.review', { taskId: c.taskId, decision: 'accept', deliveryId: c.pendingDelivery.deliveryId, deliveryRevision: c.pendingDelivery.revision, manifestHash: c.pendingDelivery.manifestHash }).then(() => refreshTasks()).catch(showErr);
          d.appendChild(stop); d.appendChild(accept);
          box.appendChild(d);
        }
      }
    }
    for (const c of ((dms.data && dms.data.conversations) || [])) {
      const state = c.execState;
      if (state !== 'running' && state !== 'queued' && state !== 'paused') continue;
      const d = document.createElement('div');
      d.textContent = '[私信 ' + (c.peerDisplayName || String(c.conversationId).slice(0, 8)) + '] 执行态=' + state + (c.activeTaskId ? ' · 任务 ' + String(c.activeTaskId).slice(0, 10) + '…' : '');
      const stop = document.createElement('button');
      stop.textContent = '停止';
      stop.disabled = c.activeRunId == null;
      stop.onclick = () => cmdOnce('stopdm:' + c.activeTaskId, 'task.stop', { taskId: c.activeTaskId, targetRunId: c.activeRunId, expectedStopGeneration: c.activeStopGeneration }).then(() => refreshTasks()).catch((e) => { window.__lastStopError = e.code + ': ' + e.message; showErr(e); });
      d.appendChild(stop);
      box.appendChild(d);
    }
    // DM 待验收交付（第三十二轮三：DM 任务验收面——pendingReview 绑定 deliveryId/revision/manifestHash）。
    for (const c of ((dms.data && dms.data.conversations) || [])) {
      if (c.pendingReview == null) continue;
      const d = document.createElement('div');
      d.textContent = '[私信 ' + (c.peerDisplayName || String(c.conversationId).slice(0, 8)) + '] 待验收交付 v' + c.pendingReview.revision;
      const accept = document.createElement('button');
      accept.textContent = '验收通过';
      accept.onclick = () => cmdOnce('acceptdm:' + c.pendingReview.taskId, 'task.review', { taskId: c.pendingReview.taskId, decision: 'accept', deliveryId: c.pendingReview.deliveryId, deliveryRevision: c.pendingReview.revision, manifestHash: c.pendingReview.manifestHash }).then(() => refreshTasks()).catch(showErr);
      d.appendChild(accept);
      box.appendChild(d);
    }
    if (box.children.length === 0) box.textContent = '暂无任务。';
  } catch (e) { if (!revoked) box.textContent = '任务读取失败：' + e.message; }
}
const TASK_EVENT_KINDS = new Set(['task.dispatched', 'task.completed', 'task.stopped', 'task.reviewed', 'delivery.pending', 'delivery.accepted', 'delivery.changes_requested', 'turn.started', 'turn.completed', 'task.created', 'message.submitted', 'thread.replyAdded']);

// ---------- 导出（认证下载 Blob→真实保存） ----------
async function runExport(format) {
  try {
    if (accessToken == null) await renewSession();
    if (currentTarget == null || currentTarget.kind !== 'dm') { feedLine('warn', '导出当前仅私信会话目标——选择私信后重试'); return; }
    const r = await cmd('export.create', { target: { kind: 'conversation', projectId: currentTarget.projectId, conversationId: currentTarget.conversationId }, format });
    const exportId = r.data.exportId;
    let res = await fetch('/export/' + exportId + '/download', { headers: { authorization: 'Bearer ' + accessToken } });
    if (res.status === 401) {
      await renewSession(); // 到期续换：只重试下载本身（不重复 create——同 exportId）
      res = await fetch('/export/' + exportId + '/download', { headers: { authorization: 'Bearer ' + accessToken } });
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err.error && err.error.message) || ('下载 ' + res.status));
    }
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    window.__lastExportBytes = bytes; // 页面验收核对（真实字节+zip 首部）
    window.__lastExportId = exportId;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportId + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    document.getElementById('export-note').textContent = '已下载 ' + exportId + '.zip（' + bytes.length + ' 字节，' + r.data.files.length + ' 文件——认证 fetch→Blob→保存）';
  } catch (e) { showErr(e); document.getElementById('export-note').textContent = '导出失败：' + e.message; }
}
document.getElementById('export-md').onclick = () => void runExport('md');
document.getElementById('export-html').onclick = () => void runExport('html');
document.getElementById('export-docx').onclick = () => void runExport('docx');

// ---------- WSS 事件流（持久游标+快照恢复+去重+自动重连） ----------
function feedLine(kind, text) {
  const f = document.getElementById('feed');
  const d = document.createElement('div');
  d.textContent = kind + ' · ' + text;
  f.insertBefore(d, f.firstChild);
  while (f.children.length > 60) f.removeChild(f.lastChild);
}
async function snapshotFromStale(fromSeq) {
  const r = await cmd('activity.list', { scope: 'all', limit: 80 }).catch(() => null);
  const items = (r && r.data && r.data.items) || [];
  for (const it of items.slice().reverse()) {
    if (!eventsSeen.has(it.eventId)) { eventsSeen.add(it.eventId); feedLine('快照', it.kindLabel + ' · ' + (it.projectName || '') + ' seq=' + (it.seq ?? '?')); }
  }
  saveSeen();
  saveLastSeq(fromSeq);
  feedLine('snapshot', '游标过期——已拉同范围快照 ' + items.length + ' 条，新事件从 ' + fromSeq + ' 续');
}
async function connectEvents() {
  if (revoked) return;
  try {
    if (accessToken == null) await renewSession();
    const t = await api('/ws-ticket', {}, 'bearer');
    ws = new WebSocket('wss://' + location.host + '/events');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'authenticate', ticket: t.ticket, lastSeq }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { void e; return; }
      if (m.type === 'event') {
        if (eventsSeen.has(m.eventId)) return; // 重复事件按 eventId 去重（持久）
        eventsSeen.add(m.eventId);
        saveSeen();
        saveLastSeq(Math.max(lastSeq || 0, m.seq));
        feedLine(m.kind, (m.projectId || '') + ' seq=' + m.seq);
        if (m.kind === 'message.submitted' || m.kind === 'message.recorded') void loadMessages().catch(() => {});
        if (TASK_EVENT_KINDS.has(m.kind)) void refreshTasks().catch(() => {});
      } else if (m.type === 'authenticated') {
        wsRetry = 0; // 重连成功——重试计数重置
        if (m.fromSeq != null) saveLastSeq(Math.max(lastSeq || 0, m.fromSeq));
        feedLine('connected', 'from seq=' + m.fromSeq + (m.resume ? '（续传）' : ''));
        if (ws && ws.readyState === 1) {
          const seenP = new Set();
          for (const t2 of targets) { const pid = t2.projectId; if (pid && !seenP.has(pid)) { seenP.add(pid); ws.send(JSON.stringify({ type: 'subscribe', projectId: pid })); } }
        }
      } else if (m.type === 'cursor-stale') { void snapshotFromStale(m.fromSeq).catch(() => {}); }
    };
    ws.onclose = (ev) => {
      if (revoked) return;
      feedLine('disconnected', '事件流断开 code=' + ev.code + '（服务器任务不受影响）——重连中');
      if (wsRetry < 30) { wsRetry += 1; setTimeout(() => void connectEvents(), Math.min(2000 * wsRetry, 15_000)); }
    };
  } catch (e) { if (!revoked) feedLine('error', e.message); }
}

function showErr(e) { feedLine('error', e.message); console.error(e); }

// ---------- 启动 ----------
(async () => {
  const saved = await idbGet('device');
  if (saved && saved.credential) {
    device = saved;
    try { await enterMain(); return; } catch (e) {
      if (revoked) return; // 终态——横幅已呈现
      document.getElementById('setup-status').textContent = '已存凭据不可用：' + e.message + '——请重新配对';
      document.getElementById('setup-status').className = 'meta warn';
    }
  }
  document.getElementById('setup').classList.remove('hidden');
})();
`;
