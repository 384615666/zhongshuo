/**
 * 远程浏览器客户端（DEV-25 第三十一轮五建；第三十二轮三重写；第三十三轮四按缺口收口）。
 * 同源静态页（GET / + /app.js——script-src 'self' 严格 CSP，禁第三方脚本；无内联脚本）。
 * 第三十三轮四闭环：
 * - **失败信封语义**：区分**明确拒绝**（服务端已应答领域错——信封即删，允许修正后新操作）
 *   与**结果未知**（响应丢失/断网——信封保留，沿原 commandId 重试恰一次）；「重试原操作」
 *   与「发送新草稿」不暗中混用——存在未知信封时发送键先收口原信封，新草稿保留不清；
 * - **按实际提交信封清算**：成功后只清实际发送的正文与 refs——发送等待期间新输入的正文/
 *   新上传的附件保留；切到 B 不清 B 的上传状态；
 * - **操作键绑版本**：停止/验收键含 run/停止代次/delivery/revision/manifestHash——旧失败
 *   操作不劫持新版本动作；
 * - **房间线程读取闭环**：房间目标列出线程（room.pool）→ 点击线程经 thread.history 读取
 *   消息（正式命令）→ 线程内发送（message.submit target=thread）——不再只有「选私信」提示；
 * - **快照恢复闭环**：cursor-stale→activity.list 快照→**恢复订阅并等确认**→新事件继续经
 *   WSS 到达；快照失败保留旧游标与待恢复状态（不冒充成功），有界退避重试；断网重连失败
 *   持续按有界退避恢复（不只 onclose 一次）；
 * - **续换事实**：token 每次成功续换记 __tokenGen、成功 HTTP 记 __lastHttpOkAt（页面验收
 *   核对新请求事实，而非「下拉框有选项」）。
 * 既有能力保留：认证下载（fetch→Blob）、有界 base64、键控草稿、吊销终态、history 代次保护。
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
.thread-row{border-top:1px dashed #e3e6ee;padding:6px 0;font-size:13px;cursor:pointer;color:#2456d6}
#thread-list{margin:6px 0}
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
    <div id="thread-list" class="meta"></div>
    <div id="messages" class="card"></div>
    <div id="composer">
      <textarea id="send-text" placeholder="输入消息（默认交给 AI；房间消息进主池，私信按 1 对 1，线程内跟进串内）"></textarea>
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
let currentThread = null; // 房间目标当前打开的线程（threadId——读取与发送锚定）
/** 键控草稿（第三十二轮三）：A→B→A 不串附件/正文——按目标键存 {text, attachIds, attachNames}。 */
const drafts = new Map();
const draftOf = (k) => { if (!drafts.has(k)) drafts.set(k, { text: '', attachIds: [], attachNames: [] }); return drafts.get(k); };
let revoked = false;
let ws = null;
let wsRetry = 0;
let eventsSeen = loadSeen();
let historyGen = 0; // 迟到 history 响应代次保护
let snapshotState = 'idle'; // idle | pending | recovered（页面验收核对——快照闭环事实）
let snapshotRetry = 0;
window.__tokenGen = 0;      // 成功续换次数（页面验收核对——新请求事实）
window.__lastHttpOkAt = 0;  // 最近一次 HTTP 2xx 时刻（验收核对命令确在续换后成功）
window.__cursorState = '';

// ---------- 本地持久（localStorage——同源） ----------
function loadSeen() { try { return new Set(JSON.parse(localStorage.getItem('zs-seen-events') ?? '[]')); } catch { return []; } }
function saveSeen() { try { const arr = [...eventsSeen]; if (arr.length > 500) arr.splice(0, arr.length - 500); localStorage.setItem('zs-seen-events', JSON.stringify(arr)); } catch (e) { void e; } }
function loadPendingOps() { try { return JSON.parse(localStorage.getItem('zs-pending-ops') ?? '{}'); } catch { return {}; } }
function savePendingOps(ops) { try { localStorage.setItem('zs-pending-ops', JSON.stringify(ops)); } catch (e) { void e; } }
let lastSeq = (() => { const n = Number(localStorage.getItem('zs-last-seq')); return Number.isInteger(n) && n >= 0 ? n : null; })();
/**
 * **安全检查点（第三十四轮一）**：持久游标=各跟踪项目水位的 **min**——不是收到的最大 seq。
 * 服务端按项目分别投递（projNext latch），全局 max 会越过尚未投递的项目事件（复现：P2 1—301
 * +P1 302，先订 P1：首泵发 P1 302 再发 P2 前 300，客户端存 302，断线重连后 P2 的 301 永远
 * 补不到）。min 检查点保证「≤检查点的每个跟踪项目事件都已投递」，重连从检查点续——个别
 * 已收事件重投由 eventId 去重吸收。
 */
let projWm = loadProjWm();
function loadProjWm() { try { const o = JSON.parse(localStorage.getItem('zs-proj-seq') ?? '{}'); return o != null && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } }
function persistCheckpoint() {
  try { localStorage.setItem('zs-proj-seq', JSON.stringify(projWm)); } catch (e) { void e; }
  const vals = Object.values(projWm);
  const cp = vals.length === 0 ? null : Math.min(...vals.map((v) => Number(v) || 0));
  lastSeq = cp;
  if (cp != null) { try { localStorage.setItem('zs-last-seq', String(cp)); } catch (e) { void e; } }
}
function trackProject(pid, base) { if (pid != null && projWm[pid] == null) { projWm[pid] = base; persistCheckpoint(); } }
function untrackProject(pid) { if (pid != null && projWm[pid] != null) { delete projWm[pid]; persistCheckpoint(); } }
function noteEventSeq(pid, seq) { if (pid != null && Number.isInteger(seq)) { const cur = Number(projWm[pid] ?? 0); if (seq > cur) { projWm[pid] = seq; persistCheckpoint(); } } }

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
  window.__tokenGen += 1; // 续换事实（验收核对——新 token 确实取得）
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
  if (r.ok) window.__lastHttpOkAt = Date.now();
  if (data.error && (data.error.code === 'DEVICE_REVOKED' || data.error.code === 'CREDENTIAL_INVALID')) enterRevokedTerminal();
  if (!r.ok) throw Object.assign(new Error((data.error && data.error.message) || ('HTTP ' + r.status)), { status: r.status, code: data.error && data.error.code });
  return data;
}
async function cmd(method, params, commandId) {
  const cid = commandId || ('rc-' + crypto.randomUUID().slice(0, 12));
  const out = await api('/cmd', { commandId: cid, method, params: params || {} }, 'bearer');
  if (out.ok === false) throw Object.assign(new Error((out.error && out.error.message) || '命令失败'), { status: 200, code: out.error && out.error.code });
  return out;
}
/**
 * 写操作信封（第三十三轮四语义收口）：
 * - **结果未知**（响应丢失/断网——e.status == null）：信封保留，沿原 commandId 重试恰一次；
 * - **明确拒绝**（服务端已应答——e.status != null，含领域错/403/401）：信封即删——允许用户
 *   修正后发起新操作（新 commandId）。旧实现所有领域错也永久保留信封：首次 OLD+图片被
 *   门禁拒绝后，改成 NEW 去掉图片再发送仍提交 OLD+图片。
 */
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
    if (e.status != null) {
      // 明确拒绝：信封删除（可修正重发）；吊销终态另有横幅。
      const ops2 = loadPendingOps();
      delete ops2[opKey];
      savePendingOps(ops2);
    }
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
    label.textContent = '结果未知的操作（' + op.method + '）——响应丢失或中断；重试沿原编号恰一次';
    const btn = document.createElement('button');
    btn.textContent = '重试';
    btn.onclick = () => void cmdOnce(k, op.method, op.params).then(() => {
      // 发送类操作：成功后同样按**实际提交信封**清算草稿（与 send() 路径同一语义）。
      if (op.method === 'message.submit' && k.startsWith('send:')) settleDraft(k.slice(5, k.lastIndexOf(':')), op.params);
      if (currentTarget != null) void loadMessages().catch(() => {});
      void refreshTasks().catch(() => {});
    }).catch((e) => feedLine('error', '重试失败：' + e.message));
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

// ---------- 会话与消息（含房间线程——DM/房间任务操作面） ----------
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
/**
 * 会话/项目/房间目标刷新（第三十五轮一：读取失败贯通）：
 * - 项目集 = DM 项目 ∪ **看板获准项目**（board.view scope=all——纯读零派发；没有 DM 的项目
 *   也能进入房间列表——旧实现只从 DM 推导，房间-only 项目永远不可见）；
 * - 任一必需读取（conversation.list/board.view/room.list）失败→**上抛**（返回 {ok:false}）：
 *   UI 侧保留旧 targets/选项并标注读取失败（不冒充空列表）；恢复链据此保持 pending+原检查点；
 * - 正常空数据（确实没有 DM/房间）照常渲染空列表——与读取失败分开。
 */
async function refreshTargets(initial) {
  let dms;
  let board;
  try {
    const dr = await cmd('conversation.list', {});
    dms = (dr.data && dr.data.conversations) || [];
    board = await cmd('board.view', { scope: 'all' });
  } catch (e) {
    renderReadError('targets', e);
    return { ok: false, error: e };
  }
  const boardGroups = (board.data && board.data.groups) || [];
  const projectIds = [...new Set([
    ...dms.map((c) => c.projectId || c.project_id),
    ...boardGroups.map((g) => g.projectId || g.project_id),
  ])].filter((pid) => pid != null && pid !== '');
  const rooms = [];
  for (const pid of projectIds) {
    let rl;
    try {
      // eslint-disable-next-line no-await-in-loop
      rl = (await cmd('room.list', { projectId: pid })).data?.items ?? [];
    } catch (e) {
      renderReadError('targets', e);
      return { ok: false, error: e };
    }
    for (const room of rl) rooms.push({ kind: 'room', projectId: pid, roomId: room.id, conversationId: room.conversationId, label: '房间 ' + room.name + (room.conversationId == null ? '（无会话）' : '') });
  }
  targets = [
    ...dms.map((c) => ({ kind: 'dm', key: 'dm:' + (c.conversationId || c.id), projectId: c.projectId || c.project_id, conversationId: c.conversationId || c.id, label: '私信 ' + (c.peerDisplayName || c.title || String(c.conversationId || c.id).slice(0, 10)) })),
    ...rooms.map((r) => ({ ...r, key: 'room:' + r.roomId })),
  ];
  const sel = document.getElementById('conversation-sel');
  const prev = initial ? (currentTarget == null ? null : currentTarget.key) : sel.value;
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
  clearReadError('targets');
  switchTarget(t);
  return { ok: true };
}
/** 读取失败呈现（第三十五轮一）：保留旧快照+顶部标注——不清空、不冒充空/「暂无任务」。 */
function renderReadError(scope, e) {
  const msg = (e && e.message) || String(e);
  window.__lastReadError = scope + ': ' + msg;
  feedLine('error', '读取失败（' + scope + '）：' + msg + '——保留上次快照（不冒充空数据）');
  const host = scope === 'tasks' ? document.getElementById('tasks') : document.getElementById('messages');
  if (host == null) return;
  let note = document.getElementById('read-fail-note-' + scope);
  if (note == null) {
    note = document.createElement('div');
    note.id = 'read-fail-note-' + scope;
    note.className = 'warn';
    host.insertBefore(note, host.firstChild);
  }
  note.textContent = (scope === 'tasks' ? '任务读取失败：' : '会话/项目/房间读取失败：') + msg + '——以上为上次快照（未冒充空数据）';
}
function clearReadError(scope) {
  const note = document.getElementById('read-fail-note-' + scope);
  if (note != null) note.remove();
  if (window.__lastReadError != null && String(window.__lastReadError).startsWith(scope + ':')) window.__lastReadError = null;
}
let restoring = false; // 恢复轮内抑制自动加载（第三十五轮一：switchTarget 的 fire-and-forget
// loadMessages 会吞掉失败并打乱「恢复链读取」次序——轮次内由显式 await 承载并上抛）
function switchTarget(t) {
  currentTarget = t;
  currentThread = null; // 切目标回到线程列表
  if (t != null) {
    const d = draftOf(t.key);
    document.getElementById('send-text').value = d.text;
    renderChips();
    if (!restoring) void loadMessages().catch(() => {});
  }
}
/** 房间线程列表（第三十三轮四：正式读取入口；第三十五轮一：失败上抛——不再吞成空列表）。 */
async function renderThreadList() {
  const box = document.getElementById('thread-list');
  box.innerHTML = '';
  if (currentTarget == null || currentTarget.kind !== 'room' || currentTarget.roomId == null) return;
  const r = await cmd('room.pool', { roomId: currentTarget.roomId });
  const threads = (r.data && (r.data.threads || r.data.items)) || [];
  const head = document.createElement('div');
  head.textContent = '房间线程 ' + threads.length + ' 条（点击读取——正式 thread.history 命令，零派发）：';
  box.appendChild(head);
  for (const th of threads.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'thread-row';
    const thId = th.threadId || th.id || th.thread_id || '';
    row.textContent = '· ' + (th.title || th.rootTaskId || thId || JSON.stringify(th).slice(0, 60));
    row.onclick = () => void openThread(thId).catch((e) => feedLine('error', '线程读取失败：' + e.message));
    box.appendChild(row);
  }
  window.__roomThreadCount = threads.length;
}
async function openThread(threadId) {
  if (currentTarget == null || threadId == null || threadId === '') return;
  currentThread = threadId;
  const gen = ++historyGen;
  const r = await cmd('thread.history', { threadId, limit: 40 });
  if (gen !== historyGen || currentThread !== threadId) return; // 迟到/切走：不重绘
  renderMessageItems((r.data && r.data.items) || [], '线程 ' + String(threadId).slice(0, 14) + '…（thread.history 正式读取）');
}
async function loadMessages() {
  const box = document.getElementById('messages');
  try {
    await renderThreadList();
    if (currentTarget == null) { box.textContent = ''; return; }
    if (currentTarget.kind === 'room') {
      if (currentThread != null) { await openThread(currentThread); return; }
      box.textContent = '选择上方房间线程读取消息（发送默认进房间主池；打开线程后为线程内跟进）。';
      return;
    }
    const gen = ++historyGen;
    const convId = currentTarget.conversationId;
    const r = await cmd('conversation.history', { conversationId: convId, limit: 30 });
    if (gen !== historyGen || currentTarget == null || currentTarget.kind !== 'dm' || currentTarget.conversationId !== convId) return; // 迟到/切走：不重绘另一会话
    renderMessageItems((r.data && (r.data.messages || r.data.items)) || [], '');
  } catch (e) {
    renderReadError('messages', e);
    throw e; // 恢复链需要知道会话/线程读取失败（保持 pending）；UI 侧调用者 catch
  }
}
function renderMessageItems(items, heading) {
  const box = document.getElementById('messages');
  box.textContent = heading;
  clearReadError('messages');
  for (const m of items.slice().reverse()) {
    const d = document.createElement('div');
    d.className = 'msg';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = new Date(m.createdAt || m.created_at || Date.now()).toLocaleString() + ' · ' + (m.authorType || m.author_type || '') + ' · ' + (m.authorId || m.author_id || '');
    const body = document.createElement('div');
    body.className = 'body';
    const rawBody = m.body_json ?? m.body;
    let bj;
    try { bj = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody || {}); } catch (e) { bj = { text: String(rawBody ?? '') }; void e; }
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

// ---------- 发送（按实际提交信封清算；失败语义分明确拒绝/未知） ----------
async function send(intent) {
  if (currentTarget == null) return;
  const t = currentTarget;
  const d = draftOf(t.key);
  const text = document.getElementById('send-text').value;
  if (text.trim().length === 0 && d.attachIds.length === 0) return;
  const opKey = 'send:' + t.key + ':' + intent;
  const pending = loadPendingOps()[opKey];
  if (pending != null) {
    // 结果未知的原操作未收口：先沿原信封重试恰一次（不与发送新草稿暗中混用——新草稿保留）。
    feedLine('pending', '存在结果未知的发送——先重试原操作（原编号恰一次）；当前草稿保留');
    try {
      await cmdOnce(opKey, 'message.submit', pending.params);
      settleDraft(t.key, pending.params);
      await loadMessages();
      return;
    } catch (e) { showErr(e); return; }
  }
  const target = currentThread != null && t.kind === 'room'
    ? { kind: 'thread', projectId: t.projectId, conversationId: t.conversationId, threadId: currentThread }
    : t.kind === 'dm'
      ? { kind: 'dm', projectId: t.projectId, conversationId: t.conversationId }
      : { kind: 'room_root', projectId: t.projectId, conversationId: t.conversationId, roomId: t.roomId };
  const params = { target, body: text, intent, mentions: [] };
  if (d.attachIds.length > 0) params.attachmentRefs = [...d.attachIds];
  try {
    await cmdOnce(opKey, 'message.submit', params);
    settleDraft(t.key, params); // 按实际提交的信封清算（不是「全清」）
    await loadMessages();
  } catch (e) {
    if (e.code === 'IMAGE_INPUT_UNVERIFIED') feedLine('gate', '图片输入能力未认证——请去掉图片附件或选「仅记录」（草稿与附件已保留，修正后可重发）');
    else showErr(e);
  }
}
/** 按实际提交信封清算（第三十三轮四）：只移除已发送 refs；正文被修改则保留；B 的上传不受 A 清算影响。 */
function settleDraft(targetKey, submittedParams) {
  const d = draftOf(targetKey);
  const sentText = String((submittedParams && submittedParams.body) || '');
  const sentRefs = new Set((submittedParams && submittedParams.attachmentRefs) || []);
  if (d.text === sentText) d.text = ''; // 发送等待期间被修改的正文保留
  const keepIds = [];
  const keepNames = [];
  d.attachIds.forEach((id, i) => { if (!sentRefs.has(id)) { keepIds.push(id); keepNames.push(d.attachNames[i]); } });
  d.attachIds = keepIds;
  d.attachNames = keepNames;
  if (currentTarget != null && currentTarget.key === targetKey) {
    document.getElementById('send-text').value = d.text;
    renderChips();
  }
  if (keepIds.length === 0) document.getElementById('attach-name').textContent = '';
}
document.getElementById('send-btn').onclick = () => void send('default');
document.getElementById('record-btn').onclick = () => void send('record_only');
document.getElementById('send-text').oninput = (ev) => { if (currentTarget != null) draftOf(currentTarget.key).text = ev.target.value; };

// ---------- 任务（房间看板+DM 执行态合并；状态事件驱动刷新；操作键绑版本） ----------
/**
 * 任务面刷新（第三十五轮一：三态呈现）：成功（含**确实无任务**的空态「暂无任务。」）与
 * **读取失败**分开——board.view/conversation.list 任一失败→{ok:false}上抛：保留旧卡片+顶部
 * 标注读取失败（不清空、不冒充「暂无任务」）；恢复链据此保持 pending+原检查点。
 */
async function refreshTasks() {
  if (revoked) return { ok: true };
  const box = document.getElementById('tasks');
  let board;
  let dms;
  try {
    [board, dms] = await Promise.all([
      cmd('board.view', { scope: 'all' }),
      cmd('conversation.list', {}),
    ]);
  } catch (e) {
    renderReadError('tasks', e);
    return { ok: false, error: e };
  }
  box.textContent = '';
  for (const g of (board.data && board.data.groups) || []) {
      for (const room of g.rooms || []) {
        for (const c of room.cards || []) {
          const d = document.createElement('div');
          d.textContent = '[' + g.displayName + '/' + room.name + '] ' + c.title + ' · ' + c.column + (c.exitUnconfirmed ? '（退出未确认）' : '');
          const stop = document.createElement('button');
          stop.textContent = '停止';
          stop.disabled = c.runId == null;
          // 操作键绑 run/停止代次（第三十三轮四）：旧失败操作不劫持新版本动作。
          stop.onclick = () => cmdOnce('stop:' + c.taskId + ':' + c.runId + ':' + c.stopGeneration, 'task.stop', { taskId: c.taskId, targetRunId: c.runId, expectedStopGeneration: c.stopGeneration }).then(() => refreshTasks()).catch(showErr);
          const accept = document.createElement('button');
          accept.textContent = '验收通过';
          accept.disabled = c.pendingDelivery == null;
          accept.onclick = () => cmdOnce('accept:' + c.taskId + ':' + (c.pendingDelivery ? c.pendingDelivery.deliveryId + ':' + c.pendingDelivery.revision + ':' + c.pendingDelivery.manifestHash : ''), 'task.review', { taskId: c.taskId, decision: 'accept', deliveryId: c.pendingDelivery.deliveryId, deliveryRevision: c.pendingDelivery.revision, manifestHash: c.pendingDelivery.manifestHash }).then(() => refreshTasks()).catch(showErr);
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
      stop.onclick = () => cmdOnce('stopdm:' + c.activeTaskId + ':' + c.activeRunId + ':' + c.activeStopGeneration, 'task.stop', { taskId: c.activeTaskId, targetRunId: c.activeRunId, expectedStopGeneration: c.activeStopGeneration }).then(() => refreshTasks()).catch((e) => { window.__lastStopError = e.code + ': ' + e.message; showErr(e); });
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
      accept.onclick = () => cmdOnce('acceptdm:' + c.pendingReview.taskId + ':' + c.pendingReview.deliveryId + ':' + c.pendingReview.revision + ':' + c.pendingReview.manifestHash, 'task.review', { taskId: c.pendingReview.taskId, decision: 'accept', deliveryId: c.pendingReview.deliveryId, deliveryRevision: c.pendingReview.revision, manifestHash: c.pendingReview.manifestHash }).then(() => refreshTasks()).catch(showErr);
      d.appendChild(accept);
      box.appendChild(d);
    }
    if (box.children.length === 0) box.textContent = '暂无任务。'; // 空态=成功响应确实无任务（与读取失败分开）
    clearReadError('tasks');
    return { ok: true };
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

// ---------- WSS 事件流（持久游标+快照恢复+订阅恢复+去重+有界退避重连） ----------
function feedLine(kind, text) {
  const f = document.getElementById('feed');
  const d = document.createElement('div');
  d.textContent = kind + ' · ' + text;
  f.insertBefore(d, f.firstChild);
  while (f.children.length > 60) f.removeChild(f.lastChild);
}
/**
 * 恢复全部跟踪项目订阅并等确认（第三十四轮二收口）：
 * - **只数 subscribed 确认**（cursor-stale 不是订阅成功——该项目需走该范围恢复，作为
 *   needRecovery 信号返回）；按项目去重；
 * - 确认不全/超时→acked<total（调用方保持 pending，不推进游标）；
 * - 绑定发起时的 ws：连接关闭/更换即失败（旧连接迟到确认不算数）。
 */
function subscribeAll() {
  return new Promise((resolve) => {
    const wsAtStart = ws;
    if (wsAtStart == null || wsAtStart.readyState !== 1 || targets.length === 0) { resolve({ acked: 0, total: 0, needRecovery: false, broken: true }); return; }
    const seenP = new Set();
    const pids = [];
    for (const t of targets) { const pid = t.projectId; if (pid && !seenP.has(pid)) { seenP.add(pid); pids.push(pid); } }
    let acked = 0;
    let needRecovery = false;
    let staleFromSeq = null;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; cleanup(); resolve({ acked, total: pids.length, needRecovery, staleFromSeq, broken: ws !== wsAtStart || ws == null || ws.readyState !== 1 }); } };
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { void e; return; }
      if (m.type === 'subscribed' && m.projectId != null && seenP.has(m.projectId) && !seenP.has('ack:' + m.projectId)) {
        seenP.add('ack:' + m.projectId); // 重复确认只计一次
        acked += 1;
        if (acked >= pids.length) finish();
      } else if (m.type === 'cursor-stale' && m.projectId != null && seenP.has(m.projectId)) {
        needRecovery = true; // 该项目需快照恢复——不当作 subscribed
        if (m.fromSeq != null) staleFromSeq = m.fromSeq;
        finish();
      }
    };
    const onClose = () => finish();
    const cleanup = () => { wsAtStart.removeEventListener('message', onMsg); wsAtStart.removeEventListener('close', onClose); };
    wsAtStart.addEventListener('message', onMsg);
    wsAtStart.addEventListener('close', onClose);
    const base = Number(window.__connFromSeq ?? 0);
    for (const pid of pids) { trackProject(pid, base); wsAtStart.send(JSON.stringify({ type: 'subscribe', projectId: pid })); }
    setTimeout(finish, 8000); // 有界等待（全部确认或 8s 截止——不全即失败）
  });
}
/**
 * cursor-stale 同范围快照恢复（第三十四轮二重写——消除假成功）：
 * - **轮次模型**：新的 stale 开启新轮；同轮并发合流；旧轮/旧连接的迟到结果不覆盖新轮状态；
 * - 快照拉取、会话/任务恢复（refreshTargets/refreshTasks）任一失败→保持 pending+保留安全
 *   检查点（**不推进游标**）+有界退避重试——不冒充成功；
 * - 订阅必须**全部项目 subscribed 确认**（去重后 acked===total 且连接未更换）才算成功；
 *   cursor-stale 出现即按需新一轮恢复；
 * - 成功才把各跟踪项目水位与检查点推进到已恢复范围。
 */
let snapshotRound = 0;
let snapshotChain = Promise.resolve();
function snapshotFromStale(fromSeq) {
  const round = ++snapshotRound;
  const prev = snapshotChain;
  let settle = null;
  snapshotChain = new Promise((r) => { settle = r; });
  void (async () => {
    try { await prev; } catch (e) { void e; }
    if (round !== snapshotRound) { settle(); return; } // 已被更新轮接管——让位
    snapshotState = 'pending';
    window.__cursorState = 'pending';
    await runSnapshotRound(round, fromSeq);
    settle();
  })();
  return snapshotChain;
}
async function runSnapshotRound(round, fromSeq) {
  const wsAtStart = ws;
  restoring = true;
  try {
    const r = await cmd('activity.list', { scope: 'all', limit: 80 });
    if (r == null || r.ok === false) throw new Error('activity.list 无结果');
    const items = (r.data && r.data.items) || [];
    for (const it of items.slice().reverse()) {
      if (!eventsSeen.has(it.eventId)) { eventsSeen.add(it.eventId); feedLine('快照', it.kindLabel + ' · ' + (it.projectName || '') + ' seq=' + (it.seq ?? '?')); }
    }
    saveSeen();
    // 下游读取链（第三十五轮一）：目标/项目/房间、任务面、当前会话/线程事实——任一失败
    // （{ok:false} 或 throw）都保持 pending+原检查点，不冒充恢复完成。
    const t = await refreshTargets(false);
    if (t != null && t.ok === false) throw new Error('目标/项目/房间读取失败：' + ((t.error && t.error.message) || ''));
    const k = await refreshTasks();
    if (k != null && k.ok === false) throw new Error('任务面读取失败：' + ((k.error && k.error.message) || ''));
    await loadMessages(); // 当前会话/线程事实（conversation.history/room.pool/thread.history——失败 throw→pending）
    const sub = await subscribeAll();
    if (sub.needRecovery) throw new Error('订阅返回 cursor-stale——按需新一轮恢复');
    if (sub.broken || ws !== wsAtStart || ws == null || ws.readyState !== 1) throw new Error('恢复期间连接关闭/更换——保持待恢复（新连接重连时再走恢复）');
    if (sub.acked < sub.total) throw new Error('订阅确认不全（' + sub.acked + '/' + sub.total + '）');
    if (round !== snapshotRound) { restoring = false; return; } // 旧轮让位——不提交
    // 成功：全部跟踪项目水位推进到已恢复范围；检查点=新 min（不越过未恢复范围）。
    for (const pid of Object.keys(projWm)) projWm[pid] = fromSeq;
    persistCheckpoint();
    snapshotRetry = 0;
    snapshotState = 'recovered';
    window.__cursorState = 'recovered';
    window.__snapshotAcks = sub.acked + '/' + sub.total;
    feedLine('snapshot-recovered', '游标过期——同范围快照 ' + items.length + ' 条已恢复（会话+任务刷新），订阅已重建（确认 ' + sub.acked + '/' + sub.total + '），新事件从 ' + fromSeq + ' 经事件流续');
    restoring = false;
  } catch (e) {
    if (round !== snapshotRound) { restoring = false; return; } // 旧轮让位
    snapshotRetry += 1;
    feedLine('snapshot-pending', '快照恢复未完成（第 ' + snapshotRetry + ' 次）：' + (e && e.message) + '——检查点保持 ' + lastSeq + '，稍后重试');
    if (snapshotRetry <= 10) setTimeout(() => { if (round === snapshotRound && !revoked) void runSnapshotRound(round, fromSeq).catch(() => {}); }, Math.min(2000 * snapshotRetry, 15_000));
    else restoring = false;
  }
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
        noteEventSeq(m.projectId, m.seq); // 每项目水位（先记——重复事件也算已投递）
        if (eventsSeen.has(m.eventId)) return; // 重复事件按 eventId 去重（持久）
        eventsSeen.add(m.eventId);
        saveSeen();
        feedLine(m.kind, (m.projectId || '') + ' seq=' + m.seq);
        if (m.kind === 'message.submitted' || m.kind === 'message.recorded' || m.kind === 'thread.replyAdded') void loadMessages().catch(() => {});
        if (TASK_EVENT_KINDS.has(m.kind)) void refreshTasks().catch(() => {});
      } else if (m.type === 'authenticated') {
        wsRetry = 0; // 重连成功——重试计数重置
        // 注意：fromSeq 是**本连接续传基线**——不推进检查点（快照恢复成功才推进；
        // 新跟踪项目以此为初始水位）。
        window.__connFromSeq = m.fromSeq;
        feedLine('connected', 'from seq=' + m.fromSeq + (m.resume ? '（续传）' : ''));
        void subscribeAll().then((sub) => {
          if (sub != null && sub.needRecovery && sub.staleFromSeq != null) void snapshotFromStale(sub.staleFromSeq).catch(() => {});
        });
      } else if (m.type === 'cursor-stale') { void snapshotFromStale(m.fromSeq).catch(() => {}); }
    };
    ws.onclose = (ev) => {
      if (revoked) return;
      feedLine('disconnected', '事件流断开 code=' + ev.code + '（服务器任务不受影响）——重连中');
      if (wsRetry < 30) { wsRetry += 1; setTimeout(() => void connectEvents(), Math.min(2000 * wsRetry, 15_000)); }
    };
  } catch (e) {
    // 取票/建连失败（断网等）：持续有界退避恢复（第三十三轮三——不只 onclose 一次）。
    if (revoked) return;
    feedLine('error', '事件流建立失败：' + e.message + '——重试中');
    if (wsRetry < 30) { wsRetry += 1; setTimeout(() => void connectEvents(), Math.min(2000 * wsRetry, 15_000)); }
  }
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
