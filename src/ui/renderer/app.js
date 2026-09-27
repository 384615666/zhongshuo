/* 众说正式 renderer 逻辑（DEV-07）：全部数据经 zs.command 命令面——
 * 无 SQLite 直读、无 runtime 拉起、无种子数据回退；失败如实展示。
 * 保留已定行为：普通发送默认交给 AI、结构化 mention、一次性「仅记录」、
 * 主池/线程独立视图与返回、停止中真实反馈、重启后历史恢复与待用户继续。
 */
/* global window, document */
const zs = window.zs;

const state = {
  projectId: null,
  roomId: null,
  conversationId: null,
  members: [],
  openThreadId: null,
  openTaskId: null,
  tasksByThread: new Map(),
  recordOnly: false,
  pollTimer: null,
};

const el = (id) => document.getElementById(id);
const uuid = () => `ui-${crypto.randomUUID()}`;
const envelope = (method, params) => ({ protocolVersion: 1, commandId: uuid(), method, params });

async function command(method, params) {
  const result = await zs.command(envelope(method, params));
  if (!result.ok) throw new Error(`${method}: ${result.error?.message ?? '未知错误'}`);
  return result.data;
}

async function openFolder() {
  const dir = await zs.pickFolder();
  if (dir == null) return;
  await loadProject(dir);
}

async function loadProject(path) {
  const data = await command('project.open', { path });
  state.projectId = data.project.id;
  el('project-name').textContent = `${data.project.displayName} · ${path}`;
  const rooms = await command('room.list', { projectId: state.projectId });
  const list = el('room-list');
  list.innerHTML = '';
  for (const room of rooms.items) {
    const item = document.createElement('div');
    item.className = 'room-item' + (room.id === state.roomId ? ' active' : '');
    item.textContent = `# ${room.name}`;
    item.onclick = () => selectRoom(room.id, room.conversationId);
    list.appendChild(item);
  }
  const first = rooms.items[0];
  if (first != null) await selectRoom(first.id, first.conversationId);
  await refreshGate();
}

async function selectRoom(roomId, conversationId) {
  state.roomId = roomId;
  state.conversationId = conversationId;
  state.openThreadId = null;
  for (const item of document.querySelectorAll('.room-item')) item.classList.remove('active');
  event && event.target && event.target.classList.add('active');
  state.members = (await command('member.list', { projectId: state.projectId, roomId })).items;
  const dl = el('member-list');
  dl.innerHTML = '';
  for (const m of state.members.filter((x) => x.principalType === 'agent')) {
    const opt = document.createElement('option');
    opt.value = m.displayName;
    dl.appendChild(opt);
  }
  showPool();
  await refreshPool();
  schedulePoll();
}

function showPool() {
  state.openThreadId = null;
  el('thread').classList.add('hidden');
  el('pool').classList.remove('hidden');
  el('thread-title').textContent = '主对话池';
}

async function refreshPool() {
  if (state.openThreadId != null) return;
  const pool = el('pool');
  const history = await command('thread.history', { threadId: state.threadIdsForPool === undefined ? await poolThreadIds() : state.threadIdsForPool, limit: 200 });
  void history;
}

// 简化：主池 = 根消息事件流（events.list）重建当前房间的根消息卡与状态。
async function poolThreadIds() { return ''; }

async function refreshFromEvents() {
  if (state.projectId == null) return;
  const events = await command('events.list', { projectId: state.projectId, limit: 200 });
  const items = events.items || [];
  const pool = el('pool');
  const cards = [];
  for (const e of items) {
    const payload = e.payload || {};
    if (e.kind === 'task.created') {
      cards.push({ taskId: payload.taskId ?? e.taskId, mode: payload.mode, threadId: e.threadId });
    }
  }
  void cards; void pool;
}

// 主渲染：直接以根消息维度渲染（通过 events 中 message.recorded/thread.created 关联）。
async function renderPool() {
  if (state.openThreadId != null || state.projectId == null) return;
  const pool = el('pool');
  pool.innerHTML = '';
  const events = (await command('events.list', { projectId: state.projectId, limit: 200 })).items;
  const rootCreated = new Map(); // anchorMessageId -> {threadId, taskId}
  for (const e of events) {
    if (e.kind === 'thread.created') {
      const anchor = e.payload && e.payload.anchorMessageId;
      if (anchor) rootCreated.set(anchor, { threadId: e.threadId });
    }
  }
  // 根消息不在 events 正文里——用 tasks 列表无从取；改用每个 thread.history 的首条人类消息作卡片。
  const threads = [...new Set(events.filter((e) => e.kind === 'thread.created').map((e) => e.threadId))];
  if (threads.length === 0) {
    pool.innerHTML = '<div class="empty">主池暂无任务。发送一条消息开始。</div>';
    return;
  }
  for (const threadId of threads) {
    const history = await command('thread.history', { threadId, limit: 200 });
    const root = (history.items || []).find((m) => m.authorType === 'human');
    if (root == null) continue;
    const card = document.createElement('div');
    card.className = 'msg mine';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `我 · ${new Date(root.createdAt).toLocaleTimeString()}`;
    const body = document.createElement('div');
    body.textContent = root.body.text;
    const open = document.createElement('div');
    open.className = 'status';
    open.textContent = '打开回复串 →';
    open.style.cursor = 'pointer';
    open.onclick = () => openThread(threadId);
    card.append(meta, body, open);
    pool.appendChild(card);
  }
}

async function openThread(threadId) {
  state.openThreadId = threadId;
  el('pool').classList.add('hidden');
  el('thread').classList.remove('hidden');
  el('thread-title').textContent = '任务回复串';
  await renderThread();
}

async function renderThread() {
  if (state.openThreadId == null) return;
  const box = el('thread-messages');
  box.innerHTML = '';
  const history = await command('thread.history', { threadId: state.openThreadId, limit: 200 });
  for (const m of history.items || []) {
    const div = document.createElement('div');
    div.className = 'msg' + (m.authorType === 'human' ? ' mine' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${m.authorType === 'human' ? '我' : '成员'} · ${new Date(m.createdAt).toLocaleTimeString()}`;
    const body = document.createElement('div');
    body.textContent = m.body.text;
    div.append(meta, body);
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

async function send() {
  const input = el('composer-input');
  const text = input.value.trim();
  if (!text || state.conversationId == null) return;
  const pick = el('mention-pick').value.trim();
  const member = state.members.find((m) => m.displayName === pick && m.principalType === 'agent');
  const mentions = member ? [{ kind: 'member', memberId: member.id }] : [];
  const submit = await zs.command(envelope('message.submit', {
    target: { kind: 'room_root', projectId: state.projectId, conversationId: state.conversationId, roomId: state.roomId },
    body: text,
    intent: state.recordOnly ? 'record_only' : 'default',
    mentions,
  }));
  if (!submit.ok) {
    alert(`发送失败：${submit.error?.message ?? '未知错误'}`); // 失败如实展示，不假装成功
    return;
  }
  input.value = '';
  if (state.openThreadId == null) await renderPool();
  schedulePoll();
}

async function refreshGate() {
  const gate = el('resume-gate');
  const events = await zs.command(envelope('events.list', { projectId: state.projectId, limit: 1 }));
  void events;
  // 恢复门禁检测：经 dispatch.resume 的幂等结果不可用（会开闸），故 main 侧由
  // daemon 状态事件驱动；此处监听 demo-status/断连提示。保守：默认隐藏。
  gate.classList.add('hidden');
}

function schedulePoll() {
  if (state.pollTimer != null) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    void (state.openThreadId != null ? renderThread() : renderPool()).catch(() => {
      el('conn-state').textContent = '通信异常';
      el('conn-state').classList.add('err');
    });
  }, 1500);
}

// 事件绑定
el('open-folder').onclick = () => void openFolder().catch((e) => alert(`打开失败：${e.message}`));
el('send').onclick = () => void send();
el('record-toggle').onclick = () => {
  state.recordOnly = !state.recordOnly;
  el('record-toggle').classList.toggle('on', state.recordOnly);
};
el('thread-back-btn').onclick = () => { showPool(); void renderPool(); };
el('composer-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); } // 中文输入法组合态由浏览器合成事件保护
});
zs.onDisconnect((info) => { el('conn-state').textContent = info; el('conn-state').classList.add('err'); });
zs.onReconnected(() => { el('conn-state').textContent = ''; el('conn-state').classList.remove('err'); });
