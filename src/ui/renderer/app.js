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
/* global window, document, crypto, alert, prompt, setInterval, clearInterval, localStorage */
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
  // 草稿独立（R4+建房轮）：按「房间:视图」双键——切房间/切视图互不覆盖；
  // recordOnly/@全体是一次性意图，不属草稿。
  drafts: {},
  recordOnly: false,
  // @全体研讨（M1）：mentions=[{kind:'all'}] → 服务端 DELIBERATE 路由；一次性意图。
  deliberateAll: false,
  pollTimer: null,
  /** 恢复面人工说明草稿（按 turnId）——周期重画不丢输入。 */
  recoveryNotes: {},
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
  if (state.roomId !== roomId) saveDraft(); // 切房间前存当前草稿（按旧房间键）
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
    // 预填到「当前房间」的池/线程草稿键（建房轮：草稿按房间隔离）。
    for (const view of ['pool', 'thread']) {
      const key = `${state.roomId ?? 'noroom'}:${view}`;
      if ((state.drafts[key]?.mention ?? '') === '') {
        state.drafts[key] = { ...(state.drafts[key] ?? { text: '' }), mention: enabledAgents[0].displayName };
      }
    }
  }
  showPool();
  await renderPool();
  schedulePoll();
}

// ---------- 视图切换（R4：草稿独立） ----------

function draftKey() {
  return `${state.roomId ?? 'noroom'}:${currentView()}`;
}

function saveDraft() {
  state.drafts[draftKey()] = { text: el('composer-input').value, mention: el('mention-pick').value };
}

function restoreDraft() {
  const d = state.drafts[draftKey()] ?? { text: '', mention: '' };
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

/** 线程内工具审计（2026-09-28）：真源=服务端 tool.started/tool.completed 审计（非模型自述）。
 *  只读区块置于线程消息尾部——不新增监控页面；服务端按 turnId+toolCallId 作用域键去重
 *  （迟到/重复事件不重复生成卡）。展示字段=成员/工具名/结果/时间/toolCallId——工具参数
 *  正文不落库因此不在此呈现；错误与其他字段按服务端脱敏规则原样显示。 */
async function renderToolCalls(box) {
  let data = null;
  try {
    data = await command('thread.toolCalls', { threadId: state.openThreadId });
  } catch { /* 命令不可用（旧 daemon）：区块不渲染 */ }
  const items = data?.items ?? [];
  if (items.length === 0) return;
  const section = document.createElement('div');
  section.className = 'tool-audit';
  section.dataset.section = 'tool-audit';
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `工具调用记录（程序侧实录 ${items.length} 条）`;
  section.appendChild(head);
  for (const t of items) {
    const row = document.createElement('div');
    row.className = 'tool-audit-row';
    row.dataset.toolCallId = t.toolCallId;
    const outcome = t.outcome ?? (t.startedAt != null && t.completedAt == null ? '进行中' : '未知');
    const when = t.startedAt != null ? new Date(t.startedAt).toLocaleTimeString() : '';
    row.textContent = `${t.memberId ?? '?'} · ${t.toolName ?? '?'} · ${outcome}${when ? ' · ' + when : ''} · ${t.toolCallId}`;
    row.title = `turn=${t.turnId ?? '?'} eventKeys=${(t.eventKeys ?? []).join(',')}`;
    section.appendChild(row);
  }
  box.appendChild(section);
  box.scrollTop = box.scrollHeight;
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
  await renderToolCalls(box);
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
  const key = `${state.roomId ?? 'noroom'}:${view}`;
  state.drafts[key] = { text: '', mention: state.drafts[key]?.mention ?? '' };
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
  // 恢复面（DEV-13·下）：受影响任务/运行+证据+未确认事项；操作精确绑定目标行。
  const panel = el('recovery-panel');
  renderRecoveryPanel(panel, data);
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

/** 恢复面（第七轮：事实分层——程序观测 / 人工说明 / 无法确认 / 保留保护）。
 *  纪律：
 *  - 退出事实只能由服务端取证（recovery.probeProcess：按已登记进程身份 OS 核对）产生；
 *    界面不提供自报 alive=false 的入口；
 *  - 「人工声明未启动」是独立人工语义（需说明+风险确认）：退款但**保留租约保护**——
 *    不伪装为程序已确认，不成为绕过进程核对的一键释放入口；
 *  - 操作只作用于该行绑定的 turnId（不因切线程漂移）。 */
function renderRecoveryPanel(panel, data) {
  const unknown = (data.unknownTurns ?? []);
  const undos = (data.activeUndos ?? []);
  // 遗留保护（如实）：对账已收口（人工声明等）但租约仍持有的 turn——人工路径不解除物理
  // 写入保护，界面不得暗示已恢复完成。
  const orphanLeases = (data.heldLeases ?? []).filter((l) => !unknown.some((t) => t.id === l.owner_turn_id));
  if (unknown.length === 0 && undos.length === 0 && orphanLeases.length === 0) {
    // 全部收口：清空并隐藏（保留旧 DOM 会让已收口 turn 仍被读到——表现为“行不消失”）。
    panel.innerHTML = '';
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  panel.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = `恢复中心：待对账 ${unknown.length} 项${undos.length > 0 ? `；未收口撤销 ${undos.length} 项（续跑走撤销命令，三向判定）` : ''}`;
  panel.appendChild(head);
  if (orphanLeases.length > 0) {
    const orphan = document.createElement('div');
    orphan.className = 'recovery-facts';
    orphan.textContent = `遗留保护：${orphanLeases.map((l) => l.owner_turn_id).join('、')} 的写入租约仍持有（人工声明不解除物理保护——需 OS 退出证据或租约治理收口）`;
    panel.appendChild(orphan);
  }
  for (const t of unknown) {
    const row = document.createElement('div');
    row.className = 'recovery-row';
    row.dataset.turnId = t.id;

    const meta = document.createElement('span');
    meta.textContent = `任务 ${t.taskId ?? '?'} · ${t.stageKey ?? '?'} · 状态未知（需对账）`;
    row.appendChild(meta);

    // 程序观测事实（服务端登记与取证）与无法确认事项、保留保护——分行如实呈现。
    const reg = (data.processRegistry ?? []).find((r) => r.turnId === t.id);
    const leases = (data.heldLeases ?? []).filter((l) => l.owner_turn_id === t.id);
    const facts = document.createElement('div');
    facts.className = 'recovery-facts';
    const factLines = [];
    if (reg == null) {
      factLines.push('程序观测：无进程身份登记（身份缺失——退出事实无从 OS 核对，只能维持保护）');
    } else {
      factLines.push(`程序观测：${reg.processModel === 'per-turn' ? '该 turn 专属子进程' : reg.processModel === 'shared' ? '共享常驻进程（PID 不专属本 turn）' : '无子进程模型（内联执行）'}${reg.pid != null ? ` PID ${reg.pid}` : ''}${reg.startedAtMs != null ? '（登记含启动时刻，可测复用）' : ''}`);
      if (reg.lastProbeResult != null) {
        factLines.push(`最近取证：${reg.lastProbeResult}${reg.lastProbeDetail ? `——${reg.lastProbeDetail}` : ''}`);
      } else {
        factLines.push('无法确认：退出事实尚未取证（点「服务端取证」）');
      }
    }
    factLines.push(leases.length > 0 ? `保留保护：写入租约 ${leases.length} 条（未确认退出/无程序事实前不解除）` : '保留保护：无本 turn 租约（预算/准入占位仍按对账结果处理）');
    facts.textContent = factLines.join('\n');
    row.appendChild(facts);

    // 人工说明（人工判断依据——必填留痕，不冒充程序事实；周期重画按草稿恢复）。
    const noteInput = document.createElement('input');
    noteInput.className = 'recovery-note';
    noteInput.dataset.turnId = t.id;
    noteInput.placeholder = '人工依据说明（必填）：如渠道账单已扣费 / 任务管理器亲见进程';
    noteInput.value = state.recoveryNotes[t.id] ?? '';
    noteInput.oninput = () => { state.recoveryNotes[t.id] = noteInput.value; };
    row.appendChild(noteInput);

    const noteOf = () => {
      const v = noteInput.value.trim();
      if (v.length === 0) throw new Error('人工依据说明必填（人工判断留痕，不冒充程序事实）');
      return v;
    };
    const mkBtn = (label, action) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { try { void action(); } catch (error) { showRecoveryError(error.message); } };
      return b;
    };
    row.appendChild(mkBtn('服务端取证', () => probeTurn(t.id)));
    row.appendChild(mkBtn('对账：已执行（按服务端取证收口）', () => reconcileTurn(t.id, { verdict: 'executed', note: noteOf() })));
    row.appendChild(mkBtn('人工声明未启动（退款·保留租约）', () => {
      const note = noteOf();
      if (!window.confirm('程序无法确认未启动。人工声明将退款并把 turn 记为 FAILED，但写入租约保护保留（不解除）。确认继续？')) return;
      void reconcileTurn(t.id, { verdict: 'notStarted', manualRiskAck: true, note });
    }));
    row.appendChild(mkBtn('维持不确定', () => reconcileTurn(t.id, { verdict: 'keepUnknown', note: noteOf() })));
    panel.appendChild(row);
  }
  panel.classList.remove('hidden');
}

/** 服务端 OS 取证（只读）：按该 turn 已登记身份核对，结果显示在该行并刷新状态。
 *  refreshGate 会整面板重画（facts 中含「最近取证」）——结果元素在重画后补挂，避免被清。 */
async function probeTurn(turnId) {
  let r;
  let failure = null;
  try {
    r = await command('recovery.probeProcess', { turnId });
  } catch (error) {
    failure = `取证失败：${error.message}`;
  }
  await refreshGate();
  if (failure != null) { showRecoveryError(failure); return; }
  const row = document.querySelector(`#recovery-panel .recovery-row[data-turn-id="${turnId}"]`);
  if (row != null) {
    const el = document.createElement('div');
    el.className = 'recovery-probe-result';
    el.textContent = `服务端取证结果：${r.result}${r.detail ? `——${r.detail}` : ''}（观测时刻 ${new Date(r.observedAt).toLocaleTimeString()}）`;
    row.appendChild(el);
  }
}

/** 恢复面错误行（非阻塞——不使用 alert：无人工处理时对话框会冻结页面）。 */
function showRecoveryError(message) {
  const panel = document.getElementById('recovery-panel');
  if (panel == null) return;
  let el = panel.querySelector('.recovery-error');
  if (el == null) {
    el = document.createElement('div');
    el.className = 'recovery-error';
    panel.insertBefore(el, panel.firstChild);
  }
  el.textContent = message;
}

async function reconcileTurn(turnId, base) {
  let failure = null;
  try {
    await command('recovery.reconcile', {
      turnId,
      ...base,
    });
  } catch (error) {
    failure = `对账失败：${error.message}`;
  }
  await refreshGate();
  if (failure != null) showRecoveryError(failure);
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
el('room-create').onclick = () => {
  // 建房（M1）：经命令面创建并切换——跨房间切换/隔离场景的正式数据面。
  const name = prompt('新房间名称：', '');
  if (name == null || name.trim().length === 0) return;
  void command('room.create', { projectId: state.projectId, name: name.trim() })
    .then(() => loadProject(localStorage.getItem('zs.lastProjectPath') ?? ''))
    .catch((e) => alert(`建房失败：${e.message}`));
};
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
