/* 众说正式 renderer 逻辑（DEV-07 修复轮 6：R1–R5 用户操作链路完整接通）。
 * 全部数据经 zs.command 命令面——无 SQLite 直读、无 runtime 拉起、无种子数据回退；
 * 失败如实展示（错误横幅/连接状态），不弹假成功。
 * - R1 停止：绑定点击时捕获的 taskId/runId/停止代次（切线程不误停）；STOPPING 持续轮询到终态。
 * - R2 恢复：recovery.status 只读查询展示遗留；用户明确点击才 dispatch.resume{confirm:true}。
 * - R3 发送分离：主池发 room_root（路由可建根任务）；线程内发必须绑定打开的线程（thread 目标，
 *   提交时固定），不新建根任务。
 * - R4 输入：主池/线程草稿独立；发送在途去重（同 commandId 重试不重复执行）；IME 组合态 Enter
 *   不发送；「仅记录」一次性复位；M0 无模式选择（明确不提供，非禁用残影）。
 * - R5 主池：room.pool 房间限定正式接口（不事件拼接、不混其他房间）；重启后按上次项目路径恢复。
 */
/* global window, document, crypto, alert, setInterval, clearInterval, localStorage */
// 整体包在 IIFE：顶层 const/global 词法声明会与 contextBridge 注入 window 的
// 非配置属性（zs）冲突（GlobalDeclarationInstantiation 抛 SyntaxError）。
(() => {
const zs = window.zs;

// 任务/运行状态 → 展示文案与样式类（终态与非终态分组）。
const TASK_STATUS_TEXT = {
  ACTIVE: '进行中', DONE: '已完成', BLOCKED: '待处理', FAILED: '失败', CANCELLED: '已停止',
};
const RUN_ACTIVE = ['QUEUED', 'RUNNING', 'WAITING', 'WAITING_APPROVAL', 'WAITING_INPUT'];
const TASK_TERMINAL = ['DONE', 'BLOCKED', 'FAILED', 'CANCELLED'];

const state = {
  projectId: null,
  roomId: null,
  conversationId: null,
  members: [],
  openThreadId: null,
  // 当前打开线程绑定的任务（R1/R3）：打开时从主池卡片固定，线程内跟进提交同一线程目标。
  openTaskId: null,
  // 线程锚点正文（根消息是房间级消息、不在 thread 历史内——打开时从主池卡片携带，渲染置顶）。
  openAnchorText: null,
  // 最近一次 task.get 结果（停止按钮的 runId/停止代次来源）。
  openTaskSnapshot: null,
  // 双视图草稿独立（R4）：{ text, mention } 各一份；recordOnly 是一次性意图，不属草稿。
  drafts: { pool: { text: '', mention: '' }, thread: { text: '', mention: '' } },
  recordOnly: false,
  // @全体研讨（M1）：mentions=[{kind:'all'}] → 服务端 DELIBERATE 路由；一次性意图。
  deliberateAll: false,
  pollTimer: null,
  pollTick: 0,
  // 发送在途（R4 去重）：视图内单飞，双击/重复 Enter 直接忽略。
  inflightSend: null,
  // 传输层失败的待重试信封（同 commandId——服务端幂等重放/去重，不会重复执行）。
  pendingRetry: null,
};

const el = (id) => document.getElementById(id);
const uuid = () => `ui-${crypto.randomUUID()}`;
const currentView = () => (state.openThreadId == null ? 'pool' : 'thread');

async function command(method, params) {
  const result = await zs.command({ protocolVersion: 1, commandId: uuid(), method, params });
  if (!result.ok) {
    const err = new Error(`${method}: ${result.error?.message ?? '未知错误'}`);
    err.code = result.error?.code;
    throw err;
  }
  return result.data;
}

// ---------- 项目与房间（R5：重启后恢复读取） ----------

async function openFolder() {
  const dir = await zs.pickFolder();
  if (dir == null) return;
  await loadProject(dir);
}

async function loadProject(path) {
  const data = await command('project.open', { path });
  state.projectId = data.project.id;
  localStorage.setItem('zs.lastProjectPath', path); // 重启后自动恢复上次项目
  el('project-name').textContent = `${data.project.displayName} · ${path}`;
  const rooms = await command('room.list', { projectId: state.projectId });
  const list = el('room-list');
  list.innerHTML = '';
  for (const room of rooms.items) {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.textContent = `# ${room.name}`;
    item.onclick = () => void selectRoom(room.id, room.conversationId, item);
    list.appendChild(item);
  }
  const first = rooms.items[0];
  if (first != null) {
    const firstEl = list.querySelector('.room-item');
    await selectRoom(first.id, first.conversationId, firstEl);
  }
  await refreshGate();
}

async function selectRoom(roomId, conversationId, roomEl) {
  state.roomId = roomId;
  state.conversationId = conversationId;
  for (const item of document.querySelectorAll('.room-item')) item.classList.remove('active');
  if (roomEl != null) roomEl.classList.add('active');
  state.members = (await command('member.list', { projectId: state.projectId, roomId })).items;
  const dl = el('member-list');
  dl.innerHTML = '';
  const enabledAgents = state.members.filter((x) => x.principalType === 'agent' && x.enabled);
  for (const m of enabledAgents) {
    const opt = document.createElement('option');
    opt.value = m.displayName;
    dl.appendChild(opt);
  }
  // M0 模式门禁（§6.1）：仅 DIRECT 可执行；AUTO/DELIBERATE 由服务端 BLOCKED（不冒充）。
  // 「默认交给 AI」在 M0 的诚实实现：恰一名启用 agent 时预填 mention（用户可见、可清空）；
  // 清空后发送=按 AUTO 提交，服务端会如实置为「待处理」。
  if (enabledAgents.length === 1) {
    if (state.drafts.pool.mention === '') state.drafts.pool.mention = enabledAgents[0].displayName;
    if (state.drafts.thread.mention === '') state.drafts.thread.mention = enabledAgents[0].displayName;
  }
  showPool();
  await renderPool();
  schedulePoll();
}

// ---------- 视图切换（R4：草稿独立） ----------

function saveDraft() {
  state.drafts[currentView()] = { text: el('composer-input').value, mention: el('mention-pick').value };
}

function restoreDraft() {
  const d = state.drafts[currentView()];
  el('composer-input').value = d.text;
  el('mention-pick').value = d.mention;
}

function showPool() {
  if (state.openThreadId != null) saveDraft();
  state.openThreadId = null;
  state.openTaskId = null;
  state.openTaskSnapshot = null;
  state.openAnchorText = null;
  updateStopUi(null);
  el('thread').classList.add('hidden');
  el('pool').classList.remove('hidden');
  el('thread-title').textContent = '主对话池';
  restoreDraft();
}

async function openThread(threadId, taskId, anchorText) {
  saveDraft();
  state.openThreadId = threadId;
  state.openTaskId = taskId ?? null;
  state.openTaskSnapshot = null;
  state.openAnchorText = anchorText ?? null;
  el('pool').classList.add('hidden');
  el('thread').classList.remove('hidden');
  el('thread-title').textContent = '任务回复串';
  restoreDraft();
  await renderThread();
}

// ---------- 主池（R5：room.pool 正式接口，房间限定） ----------

function taskChip(status) {
  if (status == null) return { text: '讨论', cls: '' }; // 记录串：无任务
  const known = TASK_STATUS_TEXT[status] ?? status;
  const cls = TASK_TERMINAL.includes(status) ? 'term' : status === 'BLOCKED' ? 'stop' : '';
  return { text: known, cls };
}

async function renderPool() {
  if (state.openThreadId != null || state.projectId == null || state.roomId == null) return;
  const pool = el('pool');
  const data = await command('room.pool', { roomId: state.roomId, limit: 50 });
  pool.innerHTML = '';
  if (data.items.length === 0) {
    pool.innerHTML = '<div class="empty">主池暂无任务。发送一条消息开始。</div>';
    return;
  }
  for (const item of data.items) {
    const card = document.createElement('div');
    card.className = 'msg mine pool-card';
    card.dataset.threadId = item.threadId;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `我 · ${new Date(item.createdAt).toLocaleTimeString()}`;
    const chip = taskChip(item.taskStatus);
    const chipEl = document.createElement('span');
    chipEl.className = `task-chip ${chip.cls}`;
    chipEl.textContent = chip.text;
    chipEl.dataset.taskStatus = item.taskStatus ?? '';
    meta.prepend(chipEl);
    const body = document.createElement('div');
    body.textContent = item.body.text;
    const open = document.createElement('div');
    open.className = 'status';
    open.textContent = `打开回复串（${item.replyCount} 条回复）→`;
    card.append(meta, body, open);
    // taskId 在打开时固定（R1：切线程不误停——每个线程快照自持）。
    card.onclick = () => void openThread(item.threadId, item.taskId, item.body.text).catch(showConnError);
    pool.appendChild(card);
  }
}

// ---------- 线程视图（R1：停止；R3：线程内跟进） ----------

// 研讨呈现（M1）：阶段进度/成员状态/预算（run.progress）与最终报告逐结论确认（report.get）。
// 程序共识以 ratification 记录聚合为准——「模型说一致」不当作共识结果。
const STAGE_TEXT = {
  PREPARE: '准备', INDEPENDENT: '独立分析', CROSS_REVIEW: '互评', ISSUE_DISCUSSION: '分歧讨论',
  SYNTHESIS: '整合', RATIFY: '逐结论确认', PUBLISH: '发布',
};
const MEMBER_STATUS_TEXT = { pending: '待产出', completed: '已产出', late: '迟到', absent: '缺席', failed: '失败' };

async function renderDeliberation() {
  const progress = el('delib-progress');
  const report = el('delib-report');
  if (state.openTaskId == null) {
    progress.classList.add('hidden');
    report.classList.add('hidden');
    return;
  }
  let data;
  try {
    data = await command('run.progress', { taskId: state.openTaskId });
  } catch {
    progress.classList.add('hidden');
    report.classList.add('hidden');
    return;
  }
  if (data.mode !== 'DELIBERATE') {
    progress.classList.add('hidden');
    report.classList.add('hidden');
    return;
  }
  const stage = STAGE_TEXT[data.stage] ?? data.stage ?? '';
  const round = data.stage === 'ISSUE_DISCUSSION' && data.roundNo ? ` 第 ${data.roundNo} 轮` : '';
  const budget = data.budget ? ` · 调用 ${data.budget.usedTurns}/${data.budget.runMaxTurns}` : '';
  const members = (data.participants || []).map((p) =>
    `<span class="member ${p.status}" title="${p.displayName}（${MEMBER_STATUS_TEXT[p.status] ?? p.status}）">${p.displayName}·${MEMBER_STATUS_TEXT[p.status] ?? p.status}</span>`).join('');
  progress.innerHTML = `<span class="stage">研讨·${stage}${round}</span>${budget} · ${members}${(data.issues || []).length > 0 ? ` · 开放争议 ${data.issues.length} 项` : ''}`;
  progress.classList.remove('hidden');
  // 最终报告（存在即渲染）：逐结论确认状态与整体共识。
  let rep = null;
  try {
    rep = (await command('report.get', { taskId: state.openTaskId })).report;
  } catch { /* 报告未发布时隐藏 */ }
  if (rep == null) {
    report.classList.add('hidden');
    return;
  }
  const claims = (rep.claimResults || []).map((c) =>
    `<div class="claim"><span class="consensus ${c.consensus}">${c.consensus}</span><span>${c.statement || c.claimId}${c.missing > 0 ? `（${c.missing} 人未确认）` : ''}${c.objects > 0 ? `（${c.objects} 人反对）` : ''}</span></div>`).join('');
  const disputed = (rep.disputedClaims || []).map((d) => `<div>分歧：${d.statement}——${d.disagreementSummary}</div>`).join('');
  report.innerHTML = `<div>最终报告（整体共识：<b class="consensus ${rep.overallConsensus}">${rep.overallConsensus ?? '-'}</b>）</div>${claims}${disputed ? `<div class="disputed-list">${disputed}</div>` : ''}`;
  report.classList.remove('hidden');
}

async function renderThread() {
  if (state.openThreadId == null) return;
  const box = el('thread-messages');
  const history = await command('thread.history', { threadId: state.openThreadId, limit: 200 });
  box.innerHTML = '';
  // 根消息（锚点）是房间级消息、不在 thread 历史内——打开时从主池卡片携带置顶。
  if (state.openAnchorText != null && state.openAnchorText.length > 0) {
    const root = document.createElement('div');
    root.className = 'msg mine';
    root.dataset.anchor = '1';
    const rootMeta = document.createElement('div');
    rootMeta.className = 'meta';
    rootMeta.textContent = '我 · 原始请求';
    const rootBody = document.createElement('div');
    rootBody.textContent = state.openAnchorText;
    root.append(rootMeta, rootBody);
    box.appendChild(root);
  }
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
  await renderDeliberation();
  if (state.openTaskId != null) {
    // 任务串：拉取任务快照（状态行 + 停止按钮的 runId/停止代次来源）。
    try {
      const data = await command('task.get', { taskId: state.openTaskId });
      const stillOpen = state.openThreadId != null; // 快照期间用户可能已返回主池
      state.openTaskSnapshot = {
        taskId: data.task.id,
        status: data.task.status,
        stopGeneration: data.task.stopGeneration,
        activeRun: data.activeRun,
      };
      if (stillOpen) updateStopUi(state.openTaskSnapshot);
    } catch (taskError) {
      // 任务可能不存在（讨论串误带 taskId 等）：状态行如实展示，不中断消息渲染。
      updateStopUi(null);
      el('thread-status').textContent = `任务查询失败：${taskError.message}`;
    }
  } else {
    updateStopUi(null);
    el('thread-status').textContent = '讨论串（仅记录，不派发）';
  }
}

function updateStopUi(snapshot) {
  const btn = el('stop-btn');
  const statusLine = el('thread-status');
  if (snapshot == null) {
    btn.classList.add('hidden');
    return;
  }
  const chip = taskChip(snapshot.status);
  const run = snapshot.activeRun;
  const runText = run != null ? ` · 运行 ${run.status}` : '';
  const stopping = run != null && run.status === 'STOPPING';
  statusLine.textContent = `任务${chip.text}${runText}`;
  const stoppable = snapshot.status === 'ACTIVE' && run != null && RUN_ACTIVE.includes(run.status);
  if (stoppable || stopping) {
    btn.classList.remove('hidden');
    btn.disabled = stopping; // STOPPING 期间等待终态，防重复点击
    btn.textContent = stopping ? '停止中…' : '停止任务';
  } else {
    btn.classList.add('hidden');
  }
}

async function stopTask() {
  // R1：点击时捕获 taskId/runId/停止代次——之后切换线程不影响本次停止目标。
  const snap = state.openTaskSnapshot;
  if (snap == null || snap.activeRun == null) return;
  const target = { taskId: snap.taskId, targetRunId: snap.activeRun.id, expectedStopGeneration: snap.stopGeneration };
  try {
    await command('task.stop', target);
  } catch (error) {
    // 失败如实展示；STOP_CONFLICT 等竞态由下一轮轮询自然对齐真实状态。
    el('thread-status').textContent = `停止请求失败：${error.message}`;
  }
  // STOPPING → 终态由轮询推进（updateStopUi 在终态隐藏按钮）。
  await renderThread();
}

// ---------- 发送（R3 目标分离；R4 去重/IME/仅记录复位） ----------

function showSendError(message, envelope) {
  state.pendingRetry = envelope ?? null;
  const box = el('send-error');
  box.classList.remove('hidden');
  box.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = message;
  box.appendChild(text);
  if (envelope != null) {
    const retry = document.createElement('button');
    retry.textContent = '重试（同命令号，不会重复执行）';
    retry.onclick = () => { void retrySend(); };
    box.appendChild(retry);
  }
}

function clearSendError() {
  state.pendingRetry = null;
  el('send-error').classList.add('hidden');
}

async function retrySend() {
  const envelope = state.pendingRetry;
  if (envelope == null) return;
  // 视图从信封目标推导（重试时用户可能已切视图——不得动另一视图的草稿）。
  const view = envelope.params?.target?.kind === 'thread' ? 'thread' : 'pool';
  clearSendError();
  try {
    const result = await zs.command(envelope); // 同 commandId：服务端幂等重放/去重
    if (!result.ok) {
      showSendError(`发送失败：${result.error?.message ?? '未知错误'}`);
      return;
    }
    afterSendSuccess(view, state.recordOnly);
  } catch (transportError) {
    // 传输层仍失败：保留同 commandId 供再次重试。
    showSendError(`发送未确认（连接异常）：${transportError.message}`, envelope);
  }
}

function buildEnvelope() {
  const text = el('composer-input').value.trim();
  const mention = el('mention-pick').value.trim();
  const member = state.members.find((m) => m.displayName === mention && m.principalType === 'agent');
  const mentions = state.deliberateAll ? [{ kind: 'all' }] : member ? [{ kind: 'member', memberId: member.id }] : [];
  let target;
  if (state.openThreadId == null) {
    // 主池：room_root——由服务端按 §4.2 路由（无 mention=AUTO、单 mention=DIRECT）。
    target = { kind: 'room_root', projectId: state.projectId, conversationId: state.conversationId, roomId: state.roomId };
  } else {
    // 线程内：必须绑定当前线程（提交时固定；服务端校验 scope，不新建根任务）。
    target = { kind: 'thread', projectId: state.projectId, conversationId: state.conversationId, threadId: state.openThreadId };
  }
  return {
    protocolVersion: 1,
    commandId: uuid(), // 去重锚点：在途重复触发被忽略；传输失败重试沿用同一 id
    method: 'message.submit',
    params: { target, body: text, intent: state.recordOnly ? 'record_only' : 'default', mentions },
  };
}

function afterSendSuccess(view, recordIntent) {
  // 视图/意图在发起时固定（修复轮 6）：响应到达前用户可能已切换视图——
  // 只清发起视图的草稿与输入框，不动另一视图。
  state.drafts[view] = { text: '', mention: state.drafts[view].mention };
  if (currentView() === view) el('composer-input').value = '';
  if (recordIntent) {
    // 「仅记录」是一次性意图：发送后复位，下一条默认交回路由。
    state.recordOnly = false;
    el('record-toggle').classList.remove('on');
  }
  if (state.deliberateAll) {
    // 「@全体研讨」同为一次性意图。
    state.deliberateAll = false;
    el('deliberate-toggle').classList.remove('on');
    el('mention-pick').value = '';
  }
  void (state.openThreadId != null ? renderThread() : renderPool()).catch(showConnError);
  schedulePoll();
}

async function send() {
  if (state.inflightSend != null) return; // 双击/重复 Enter：在途即忽略（同 commandId 语义）
  const text = el('composer-input').value.trim();
  if (!text || state.conversationId == null) return;
  // 发起时固定视图与「仅记录」意图（响应到达前用户可能切换视图）。
  const view = currentView();
  const recordIntent = state.recordOnly;
  const envelope = buildEnvelope();
  clearSendError();
  state.inflightSend = envelope.commandId;
  el('send').disabled = true;
  try {
    const result = await zs.command(envelope);
    if (!result.ok) {
      showSendError(`发送失败：${result.error?.message ?? '未知错误'}`); // 业务失败：保留草稿
      return;
    }
    afterSendSuccess(view, recordIntent);
  } catch (transportError) {
    // 传输层失败（超时/断连）：服务端可能已执行——保留同 commandId 重试，不自动改写文本重发。
    showSendError(`发送未确认（连接异常）：${transportError.message}`, envelope);
  } finally {
    state.inflightSend = null;
    el('send').disabled = false;
  }
}

// ---------- 恢复门禁（R2：只读查询 + 显式确认） ----------

async function refreshGate() {
  const gate = el('resume-gate');
  const info = el('resume-info');
  let data;
  try {
    data = await command('recovery.status', {});
  } catch {
    // 恢复状态查询失败（连接异常）：保守隐藏入口，下次轮询/重连复查。
    gate.classList.add('hidden');
    info.classList.add('hidden');
    return;
  }
  if (!data.gateHeld) {
    gate.classList.add('hidden');
    info.classList.add('hidden');
    return;
  }
  const lines = [];
  if (data.pendingDispatchCount > 0) lines.push(`待派发 ${data.pendingDispatchCount} 项（重启遗留）`);
  if (data.interruptedRuns.length > 0) lines.push(`中断运行 ${data.interruptedRuns.length} 个（不自动重跑）`);
  info.textContent = lines.length > 0 ? lines.join('\n') : '上次退出时有未完成工作';
  info.classList.remove('hidden');
  gate.classList.remove('hidden');
}

async function resumeFromGate() {
  // 用户明确点击才开闸（§16.4-6）：中断运行不重跑，仅放行新调度。
  try {
    await command('dispatch.resume', { confirm: true });
  } catch (error) {
    alert(`恢复失败：${error.message}`);
  }
  await refreshGate();
  void renderPool().catch(showConnError);
}

// ---------- 轮询与连接状态 ----------

function showConnError(error) {
  el('conn-state').textContent = '通信异常';
  el('conn-state').classList.add('err');
  void error;
}

function schedulePoll() {
  if (state.pollTimer != null) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    state.pollTick += 1;
    void (state.openThreadId != null ? renderThread() : renderPool()).catch(() => {
      el('conn-state').textContent = '通信异常';
      el('conn-state').classList.add('err');
    });
    // 低频复查门禁（运行中新落门禁的场景极少；启动/重连另有触发）。
    if (state.pollTick % 8 === 0) void refreshGate().catch(() => {});
  }, 1500);
}

// ---------- 事件绑定 ----------

el('open-folder').onclick = () => void openFolder().catch((e) => alert(`打开失败：${e.message}`));
el('send').onclick = () => void send();
el('record-toggle').onclick = () => {
  state.recordOnly = !state.recordOnly;
  el('record-toggle').classList.toggle('on', state.recordOnly);
};
el('deliberate-toggle').onclick = () => {
  state.deliberateAll = !state.deliberateAll;
  el('deliberate-toggle').classList.toggle('on', state.deliberateAll);
};
el('resume-gate').onclick = () => void resumeFromGate();
el('stop-btn').onclick = () => void stopTask();
el('thread-back-btn').onclick = () => { showPool(); void renderPool().catch(showConnError); };
el('composer-input').addEventListener('keydown', (ev) => {
  // IME 组合态（拼音候选未上屏）的 Enter 不发送：isComposing 或遗留 keyCode 229。
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault();
    void send();
  }
});
zs.onDisconnect((info) => { el('conn-state').textContent = info; el('conn-state').classList.add('err'); });
zs.onReconnected(() => {
  el('conn-state').textContent = '';
  el('conn-state').classList.remove('err');
  // daemon 可能已重启：复查门禁与当前视图（遗留中断由恢复入口接手，不自动续跑）。
  void refreshGate().catch(() => {});
  void (state.openThreadId != null ? renderThread() : renderPool()).catch(showConnError);
});
zs.onDemoStatus((status) => { el('conn-state').textContent = status; });

// R5：重启后恢复上次项目（失败如实展示，不回退种子数据）。
const lastProject = localStorage.getItem('zs.lastProjectPath');
if (lastProject != null && lastProject.length > 0) {
  void loadProject(lastProject).catch((e) => {
    el('project-name').textContent = `恢复项目失败：${e.message}`;
  });
}
})();
