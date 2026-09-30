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
  /** 当前项目快照（project.open 结果：任务验收开关/revision 等——项目设置的读写来源）。 */
  project: null,
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
  // 仓库状态缓存（DEV-14 git.status 只读视图）：projectId 切换时失效。
  repoStatusCache: null,
  repoStatusVisible: true,
  /** 主池任务清单（第十轮：Git 按任务批量暂存的选择来源）。 */
  poolTasks: [],
  /** 提交预览快照（第十轮）：提交绑定预览时的 HEAD/暂存区摘要——变化即拒绝。 */
  gitCommitPreview: null,
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
  state.project = data.project; // 项目设置（任务验收开关）的 CAS revision/当前值来源
  state.projectId = data.project.id;
  localStorage.setItem('zs.lastProjectPath', path); // 重启后自动恢复上次项目
  el('project-name').textContent = `${data.project.displayName} · ${path}`;
  renderProjectSettings();
  void renderCollabSettings().catch(() => { /* 读取失败已行内显示 */ });
  void renderMemberRuntimeSettings().catch(() => { /* 绑定读取失败按未绑定呈现——不阻断项目加载 */ });
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
  void renderMemberRuntimeSettings().catch(() => { /* 绑定读取失败按未绑定呈现——不阻断房间切换 */ });
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
  void (async () => {
    await renderRepoStatus().catch(() => { /* 仓库状态失败不阻断主池 */ });
    await renderGitOps().catch(() => { /* Git 操作区失败不阻断主池 */ });
  })();
  const pool = el('pool');
  const data = await command('room.pool', { roomId: state.roomId, limit: 50 });
  // 任务清单缓存（第十轮：Git 按任务批量暂存的选择来源——不重复拉取）。
  state.poolTasks = data.items.filter((i) => i.taskId != null).map((i) => ({ taskId: i.taskId, title: i.body.text, status: i.taskStatus }));
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
  await renderChangeSets();
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
        pendingDelivery: data.pendingDelivery ?? null, // 验收操作绑定展示时版本（第九轮）
        lastStartupFailureMessage: data.lastStartupFailureMessage ?? null, // 启动失败原因如实上屏（第十六轮四）
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

/** DEV-14 前置：任务串变更记录区块（changeset.listByTask 只读——变更清单/恢复撤销限制/当前状态）。
 *  无变更不渲染（不占版面）；状态如实中文映射，不做任何写操作。 */
async function renderChangeSets() {
  if (state.openTaskId == null) return;
  const box = el('thread-messages');
  if (document.getElementById('changeset-block') != null) document.getElementById('changeset-block').remove();
  let data;
  try {
    data = await command('changeset.listByTask', { taskId: state.openTaskId });
  } catch {
    return; // 查询失败不阻断消息渲染（区块缺席=无可见变更，不伪造）
  }
  if ((data.items ?? []).length === 0) return;
  const APP_STATUS = { applied: '已应用', not_applied: '未应用', reverted: '已撤销', partial: '部分应用' };
  const block = document.createElement('div');
  block.id = 'changeset-block';
  block.className = 'changeset-block';
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `变更记录 ${data.items.length} 组（只读；撤销经恢复面/命令续跑，不在此操作）`;
  block.appendChild(head);
  for (const cs of data.items) {
    const row = document.createElement('div');
    row.className = 'changeset-row';
    row.dataset.changeSetId = cs.id;
    const UNDO_LABEL = { in_progress: '撤销进行中', failed: '撤销中断（待恢复续跑）', succeeded: '已撤销', conflict: '撤销冲突（不可自动继续）' };
    const undoText = cs.undoStatus != null ? `；撤销=${UNDO_LABEL[cs.undoStatus] ?? cs.undoStatus}` : '';
    const label = document.createElement('div');
    label.textContent = `${cs.id.slice(0, 14)}… · ${APP_STATUS[cs.applicationStatus] ?? cs.applicationStatus} · ${cs.fileCount} 文件${undoText}`;
    row.appendChild(label);
    const files = document.createElement('div');
    files.className = 'recovery-facts';
    files.textContent = cs.files.map((f) => `${f.role === 'after' ? '改后' : '改前'} ${f.path}（${f.state}）`).join(String.fromCharCode(10));
    row.appendChild(files);
    // 前像可用性（第九轮）：撤销/恢复依赖改前内容快照——不可得（unknown）的文件如实标注。
    const beforeFiles = cs.files.filter((f) => f.role === 'before');
    if (beforeFiles.length > 0) {
      const available = beforeFiles.filter((f) => f.state === 'present').length;
      const pre = document.createElement('div');
      pre.className = 'recovery-facts';
      pre.textContent = `前像可用：${available}/${beforeFiles.length}${available < beforeFiles.length ? '（部分改前内容不可得=unknown——对应文件撤销时将按冲突处理，不猜测恢复）' : ''}`;
      row.appendChild(pre);
    }
    // 撤销详情（第八轮）：恢复进度/冲突原因（不可撤销的具体说明）——只读呈现，续跑走撤销命令。
    if (cs.undo != null) {
      const undoDetail = document.createElement('div');
      undoDetail.className = 'recovery-facts';
      const lines = [`撤销进度：${cs.undo.doneSteps}/${cs.undo.totalSteps} 步（${UNDO_LABEL[cs.undo.status] ?? cs.undo.status}）`];
      if (cs.undo.failure != null) lines.push(`不可继续原因：${cs.undo.failure}`);
      if (cs.undo.resumable) lines.push('恢复方式：中断后可续跑（逐步幂等重验，不覆盖用户改动）');
      undoDetail.textContent = lines.join(String.fromCharCode(10));
      row.appendChild(undoDetail);
    }
    block.appendChild(row);
  }
  box.appendChild(block);
}

function updateStopUi(snapshot) {
  const btn = el('stop-btn');
  const statusLine = el('thread-status');
  const acceptBtn = el('review-accept-btn');
  const rejectBtn = el('review-reject-btn');
  const redispatchBtn = el('redispatch-btn');
  if (snapshot == null) {
    btn.classList.add('hidden');
    acceptBtn.classList.add('hidden');
    rejectBtn.classList.add('hidden');
    redispatchBtn.classList.add('hidden');
    return;
  }
  const chip = taskChip(snapshot.status);
  const run = snapshot.activeRun;
  const runText = run != null ? ` · 运行 ${run.status}` : '';
  const stopping = run != null && run.status === 'STOPPING';
  // 启动失败原因如实上屏（第十六轮四：验收防护拒绝等——「待处理」无解释=用户不可知）。
  const failNote = snapshot.lastStartupFailureMessage != null ? ` · ${snapshot.lastStartupFailureMessage}` : '';
  statusLine.textContent = `任务${chip.text}${runText}${failNote}`;
  const stoppable = snapshot.status === 'ACTIVE' && run != null && RUN_ACTIVE.includes(run.status);
  if (stoppable || stopping) {
    btn.classList.remove('hidden');
    btn.disabled = stopping; // STOPPING 期间等待终态，防重复点击
    btn.textContent = stopping ? '停止中…' : '停止任务';
  } else {
    btn.classList.add('hidden');
  }
  // 追加执行（第十轮·三返工闭环）：任务 ACTIVE 且无在途执行时可用——经 task.redispatch
  // 正式派发链（返工意见/跟进上下文由服务端组装注入），不是重跑开关。
  const redispatchable = snapshot.status === 'ACTIVE' && (run == null || (!RUN_ACTIVE.includes(run.status) && run.status !== 'STOPPING'));
  redispatchBtn.classList.toggle('hidden', !redispatchable);
  // 可选验收（RT-25，第九轮绑定版本）：REVIEW 且存在待验收交付——按钮带当时展示的
  // 版本号，提交时绑定该 deliveryId/revision（服务端条件更新校验，错稿/被替代均明确冲突）。
  const pending = snapshot.pendingDelivery ?? null;
  const reviewable = snapshot.status === 'REVIEW' && pending != null;
  acceptBtn.classList.toggle('hidden', !reviewable);
  rejectBtn.classList.toggle('hidden', !reviewable);
  if (reviewable) {
    acceptBtn.textContent = `验收通过（第 ${pending.revision} 版）`;
    rejectBtn.textContent = `要求修改（第 ${pending.revision} 版）`;
  }
  // 返工意见行（第十轮·三）：无待验收交付时一并收起。
  if (!reviewable) el('rework-note-row')?.classList.add('hidden');
}

/** 人工验收（task.review 正式命令，绑定展示时版本）：accept→DONE；changes_requested→ACTIVE
 * （意见必填——经返工意见行输入，注入后续派发输入）。返回后线程重渲染；按钮随 pendingDelivery 收起。 */
async function reviewTask(decision, note) {
  const snap = state.openTaskSnapshot;
  const pending = snap?.pendingDelivery ?? null;
  if (snap == null || pending == null) return; // 无待验收版本（快照已过期——重渲染后按钮收起）
  try {
    const r = await command('task.review', {
      taskId: snap.taskId, deliveryId: pending.id, deliveryRevision: pending.revision, decision,
      ...(decision === 'changes_requested' && note != null ? { note } : {}),
    });
    el('thread-status').textContent = `验收已记录：交付 ${r.reviewStatus}（第 ${r.deliveryRevision} 版）· 任务 ${r.taskStatusAfter}`;
  } catch (error) {
    el('thread-status').textContent = `验收失败（第 ${pending.revision} 版）：${error.message}`;
  }
  el('rework-note-row').classList.add('hidden');
  await renderThread();
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

/** 运行能力真实状态（DEV-14/第八轮）：成员绑定+能力矩阵关键项+daemon 恢复能力——
 *  未验证项如实标注，不因成功回复整体升级；查询失败隐藏（不伪造）。 */
async function renderRuntimeStatus() {
  const box = el('runtime-status');
  let data;
  try {
    data = await command('runtime.status', {});
  } catch {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.innerHTML = '<b>运行能力（当前 daemon·实测口径）</b>';
  box.appendChild(head);
  const facts = document.createElement('div');
  facts.className = 'recovery-facts';
  const lines = [];
  for (const b of data.memberBindings ?? []) {
    lines.push(`${b.displayName}：${b.kind}${b.model ? ` · ${b.model}` : ''}`);
  }
  lines.push(`进程树取证：${data.daemonRecovery?.processTreeEvidence ?? '?'}`);
  lines.push(`迟到成果接收：${data.daemonRecovery?.lateEventPump ?? '?'}`);
  const claudeCap = data.capabilities?.claude?.keyAbilities;
  if (claudeCap != null) {
    lines.push(`claude 能力（关键项）：结构化终态=${claudeCap.structuredFinal}；写入限制=${claudeCap.restrictWrites}；交互审批=${claudeCap.interactiveApprovals}`);
  }
  facts.textContent = lines.join(String.fromCharCode(10));
  box.appendChild(facts);
}

/** 仓库状态只读视图（DEV-14/RT-24）：真实 git 数据——暂存/未暂存/未跟踪严格区分；
 *  只读不改工作区（用户未提交内容保留）。非 git 仓库如实说明。30s 缓存防轮询抖动。 */
async function renderRepoStatus() {
  if (state.projectId == null) return;
  const box = el('repo-status');
  const now = Date.now();
  if (state.repoStatusCache != null && state.repoStatusCache.projectId === state.projectId && now - state.repoStatusCache.at < 30_000) {
    return; // 同项目缓存内：不重复拉取（git 子进程开销）
  }
  let data;
  try {
    data = await command('git.status', { projectId: state.projectId });
  } catch (error) {
    box.classList.toggle('hidden', !(state.repoStatusVisible ?? true)); // 尊重设置开关
    box.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'meta';
    line.textContent = `仓库状态：${error.message.includes('不是 git 仓库') ? '当前项目目录不是 git 仓库' : `查询失败（${error.message}）`}`;
    box.appendChild(line);
    return;
  }
  state.repoStatusCache = { at: now, projectId: state.projectId, data };
  const total = data.staged.length + data.unstaged.length + data.untracked.length;
  box.classList.toggle('hidden', !(state.repoStatusVisible ?? true)); // 尊重设置开关
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `仓库状态（只读·分支 ${data.branch}）：已暂存 ${data.staged.length} · 未暂存 ${data.unstaged.length} · 未跟踪 ${data.untracked.length}${data.truncated ? '（列表截断）' : ''}`;
  box.appendChild(head);
  // 第十轮：项目根是仓库子目录时显式说明——范围不悄悄扩大到项目外（条目带（项目外）标注）。
  if (data.projectRootIsWorktreeRoot === false) {
    const scope = document.createElement('div');
    scope.className = 'meta';
    scope.textContent = `项目根是仓库子目录（仓库根 ${data.worktreeRoot}）：下列条目为整个工作树状态，标注（项目外）者在项目目录之外`;
    box.appendChild(scope);
  }
  if (total === 0) {
    const clean = document.createElement('div');
    clean.className = 'recovery-facts';
    clean.textContent = '工作区干净（相对最近提交无差异）';
    box.appendChild(clean);
    return;
  }
  const list = document.createElement('div');
  list.className = 'recovery-facts';
  const markOutside = (e) => (e.outsideProjectRoot === true ? '（项目外）' : '');
  const lines = [];
  if (data.staged.length > 0) lines.push(`已暂存：${data.staged.map((e) => e.path + (e.renamedFrom != null ? `（← ${e.renamedFrom}）` : '') + markOutside(e)).join('、')}`);
  if (data.unstaged.length > 0) lines.push(`未暂存：${data.unstaged.map((e) => e.path + markOutside(e)).join('、')}`);
  if (data.untracked.length > 0) lines.push(`未跟踪：${data.untracked.map((e) => e.path + markOutside(e)).join('、')}`);
  list.textContent = lines.join(String.fromCharCode(10));
  box.appendChild(list);
  // diff 正文（第九轮 DEV-14）：分别查看暂存/未暂存差异——二进制/超限/重命名/删除如实标注。
  const mkDiffBtn = (label, staged) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.onclick = () => void toggleDiff(box, staged, b);
    box.appendChild(b);
  };
  if (data.staged.length > 0) mkDiffBtn('查看已暂存差异', true);
  if (data.unstaged.length > 0) mkDiffBtn('查看未暂存差异', false);
  // 未跟踪文件内容（第十轮）：按新增语义逐文件查看（Git diff 不含未跟踪——不只列文件名）。
  const untrackedShown = data.untracked.slice(0, 10);
  for (const entry of untrackedShown) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `未跟踪内容：${entry.path}`;
    b.title = '按新增文件语义查看内容（二进制/超限如实标注）';
    b.onclick = () => void togglePathDiff(box, entry.path, b);
    box.appendChild(b);
  }
  if (data.untracked.length > 10) {
    const more = document.createElement('div');
    more.className = 'meta';
    more.textContent = `（未跟踪共 ${data.untracked.length} 个，仅列前 10 个内容入口）`;
    box.appendChild(more);
  }
}

/** 单路径差异/内容展开（第十轮）：未跟踪走内容视图；重复点击收起。 */
async function togglePathDiff(box, path, btn) {
  const id = `diff-path-${path}`;
  const existing = document.getElementById(id);
  if (existing != null) { existing.remove(); btn.classList.remove('active'); return; }
  btn.classList.add('active');
  let r;
  try {
    r = await command('git.diff', { projectId: state.projectId, path });
  } catch (error) {
    const err = document.createElement('div');
    err.className = 'recovery-facts';
    err.id = id;
    err.textContent = `查看失败：${error.message}`;
    box.appendChild(err);
    return;
  }
  const block = document.createElement('div');
  block.id = id;
  block.className = 'diff-block';
  appendPatches(block, r);
  box.appendChild(block);
}

/** diff 展开/收起（git.diff 只读命令；重复点击收起）。 */
async function toggleDiff(box, staged, btn) {
  const id = `diff-block-${staged ? 'staged' : 'unstaged'}`;
  const existing = document.getElementById(id);
  if (existing != null) { existing.remove(); btn.textContent = btn.textContent.replace('收起', '查看'); return; }
  btn.textContent = btn.textContent.replace('查看', '收起');
  let r;
  try {
    r = await command('git.diff', { projectId: state.projectId, staged });
  } catch (error) {
    const err = document.createElement('div');
    err.className = 'recovery-facts';
    err.id = id;
    err.textContent = `差异查询失败：${error.message}`;
    box.appendChild(err);
    return;
  }
  const block = document.createElement('div');
  block.id = id;
  block.className = 'diff-block';
  if (r.patches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recovery-facts';
    empty.textContent = '无差异（或仅未跟踪文件——未跟踪无 diff）';
    block.appendChild(empty);
  }
  appendPatches(block, r);
  box.appendChild(block);
}

/** 差异条目渲染（第十轮：统计 unknown/未跟踪内容语义如实标注；截断含说明）。 */
function appendPatches(block, r) {
  const CHANGE = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名', copied: '复制' };
  for (const patch of r.patches) {
    const head = document.createElement('div');
    head.className = 'meta';
    const statNote = patch.stat === 'unknown' ? '（统计未知：numstat 不可用，未当作文本成功）' : patch.binary ? '（二进制文件，无文本差异）' : '';
    const sourceNote = patch.source === 'worktree-content' ? '〔未跟踪文件内容·新增语义〕' : '';
    const countNote = patch.source !== 'worktree-content' && patch.addedCount != null ? `（+${patch.addedCount}/-${patch.deletedCount ?? 0}）` : '';
    head.textContent = `${sourceNote}${CHANGE[patch.change] ?? patch.change} ${patch.path}${patch.oldPath != null ? `（← ${patch.oldPath}）` : ''}${statNote}${countNote}${patch.truncated ? '（超限截断）' : ''}`;
    block.appendChild(head);
    if (r.numstatError != null && patch.stat === 'unknown') {
      const warn = document.createElement('div');
      warn.className = 'meta';
      warn.textContent = r.numstatError;
      block.appendChild(warn);
    }
    if (!patch.binary && patch.text.length > 0) {
      const pre = document.createElement('div');
      pre.className = 'diff-text';
      pre.textContent = patch.text;
      block.appendChild(pre);
    }
  }
}

// ---------- Git 写操作（第十轮·二：暂存/取消暂存/按任务批量/提交/历史） ----------

/** 写操作后刷新（读视图+操作区一起重建；缓存失效强制重拉）。 */
async function refreshGitViews() {
  state.repoStatusCache = null;
  await renderRepoStatus().catch(() => { /* 读失败不阻断操作区 */ });
  await renderGitOps(true).catch(() => { /* 操作区失败不阻断主池 */ });
}

/** 当前 HEAD（轻量：history limit=1 的 head 字段）。 */
async function currentHeadOfRepo() {
  const h = await command('git.history', { projectId: state.projectId, limit: 1 });
  return h.head;
}

/** Git 操作区：暂存/取消暂存（普通按文件）+按任务批量+提交（预览绑定）+历史。
 * 轮询不重复重建（按项目戳记）；写操作后 force 重建（重建保留提交说明/任务选择）。 */
async function renderGitOps(force = false) {
  const box = el('git-ops');
  if (state.projectId == null) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.projectId = ''; return; }
  if (!force && box.dataset.projectId === state.projectId) return; // 轮询不重建（预览文本/输入不丢）
  const savedMsg = document.getElementById('git-commit-message')?.value ?? '';
  const savedTask = document.getElementById('git-commit-task')?.value ?? '';
  const savedHistory = document.getElementById('git-history-block')?.textContent ?? null;
  box.dataset.projectId = state.projectId;
  let status;
  try {
    status = state.repoStatusCache != null && state.repoStatusCache.projectId === state.projectId
      ? state.repoStatusCache.data
      : await command('git.status', { projectId: state.projectId });
  } catch (error) {
    box.classList.remove('hidden');
    box.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'meta';
    line.textContent = `Git 操作：${error.message.includes('不是 git 仓库') ? '当前项目目录不是 git 仓库' : `不可用（${error.message}）`}`;
    box.appendChild(line);
    return;
  }
  state.repoStatusCache ??= { at: Date.now(), projectId: state.projectId, data: status };
  box.classList.remove('hidden');
  box.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'meta';
  title.textContent = 'Git 操作（暂存/提交/历史 · 提交不等同任务验收，不会自动推送）';
  box.appendChild(title);

  const mkBtn = (label, titleText, onClick) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    if (titleText != null) b.title = titleText;
    b.onclick = () => void onClick().catch(showConnError);
    box.appendChild(b);
    return b;
  };
  const say = (text) => {
    const line = document.createElement('div');
    line.className = 'git-result';
    line.textContent = text;
    box.appendChild(line);
  };
  const wrapPath = (p) => (p.length > 42 ? `${p.slice(0, 18)}…${p.slice(-20)}` : p);

  // 普通按文件：暂存（未暂存/未跟踪）、取消暂存（已暂存）。
  const stagedTop = status.staged.slice(0, 15);
  for (const entry of stagedTop) {
    mkBtn(`取消暂存 ${wrapPath(entry.path)}`, '只改索引：该文件回到未暂存/未跟踪（工作区内容不动）', async () => {
      const r = await command('git.unstage', { projectId: state.projectId, paths: [entry.path] });
      await refreshGitViews();
      say(`已取消暂存 ${r.staged.length} 个文件${r.skipped.length > 0 ? `；跳过：${r.skipped.map((s) => `${s.path}（${s.reason}）`).join('、')}` : ''}`);
    });
  }
  for (const entry of [...status.unstaged, ...status.untracked].slice(0, 15)) {
    mkBtn(`暂存 ${wrapPath(entry.path)}`, '把该文件当前内容加入暂存区（不动其他文件）', async () => {
      const r = await command('git.stage', { projectId: state.projectId, paths: [entry.path] });
      await refreshGitViews();
      say(`已暂存 ${r.staged.length} 个文件${r.skipped.length > 0 ? `；跳过：${r.skipped.map((s) => `${s.path}（${s.reason}）`).join('、')}` : ''}`);
    });
  }

  // 按任务批量暂存：任务选择（来源=主池任务卡）+ 执行（跳过 userPreExisting，冲突列出）。
  const taskRow = document.createElement('div');
  taskRow.className = 'git-row';
  const taskSelect = document.createElement('select');
  taskSelect.className = 'git-input';
  taskSelect.id = 'git-task-select';
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '按任务批量暂存：选择任务…';
  taskSelect.appendChild(emptyOpt);
  for (const t of (state.poolTasks ?? [])) {
    const opt = document.createElement('option');
    opt.value = t.taskId;
    const label = t.title.length > 26 ? `${t.title.slice(0, 26)}…` : t.title;
    opt.textContent = `${label}（${taskChip(t.status).text}）`;
    taskSelect.appendChild(opt);
  }
  taskRow.appendChild(taskSelect);
  const batchBtn = document.createElement('button');
  batchBtn.className = 'chip';
  batchBtn.textContent = '按任务暂存';
  batchBtn.title = '暂存该任务改动面的文件；任务开始前已存在的用户改动默认跳过，用户改动+任务改动同文件列为冲突不自动分离';
  batchBtn.onclick = () => void (async () => {
    const taskId = taskSelect.value;
    if (taskId === '') { say('请先选择任务（主池任务卡）——没有可选任务时，说明本项目还没有任务。'); return; }
    const r = await command('git.stageTask', { projectId: state.projectId, taskId });
    await refreshGitViews();
    say(`按任务暂存完成：纳入 ${r.included.length} 个${r.included.length > 0 ? `（${r.included.map(wrapPath).join('、')}）` : ''}；跳过 ${r.skipped.length} 个${r.skipped.length > 0 ? `（${r.skipped.map((s) => `${wrapPath(s.path)}：${s.reason}`).join('；')}）` : ''}；冲突 ${r.conflicts.length} 个${r.conflicts.length > 0 ? `（${r.conflicts.map((c) => `${wrapPath(c.path)}：${c.reason}`).join('；')}）` : ''}`);
  })().catch(showConnError);
  taskRow.appendChild(batchBtn);
  box.appendChild(taskRow);

  // 提交：说明文字 → 预览 → 确认提交（绑定预览 HEAD/暂存区摘要）。
  const commitRow = document.createElement('div');
  commitRow.className = 'git-row';
  const msgInput = document.createElement('input');
  msgInput.className = 'git-input';
  msgInput.id = 'git-commit-message';
  msgInput.placeholder = '提交说明…';
  msgInput.maxLength = 500;
  commitRow.appendChild(msgInput);
  const taskBind = document.createElement('select');
  taskBind.className = 'git-input';
  taskBind.id = 'git-commit-task';
  const bindEmpty = document.createElement('option');
  bindEmpty.value = '';
  bindEmpty.textContent = '不关联任务';
  taskBind.appendChild(bindEmpty);
  for (const t of (state.poolTasks ?? [])) {
    const opt = document.createElement('option');
    opt.value = t.taskId;
    opt.textContent = `关联任务：${(t.title.length > 22 ? `${t.title.slice(0, 22)}…` : t.title)}`;
    taskBind.appendChild(opt);
  }
  commitRow.appendChild(taskBind);
  const previewBtn = document.createElement('button');
  previewBtn.className = 'chip';
  previewBtn.textContent = '预览提交';
  previewBtn.title = '展示真实索引内容与提交前置检查（冲突/身份/保护）；提交时绑定本次预览的 HEAD 与暂存区摘要';
  const doBtn = document.createElement('button');
  doBtn.className = 'chip';
  doBtn.textContent = '提交';
  doBtn.disabled = true;
  doBtn.title = '按预览内容提交；预览后 HEAD 或暂存区变化会拒绝并要求重新预览';
  const previewBox = document.createElement('div');
  previewBox.className = 'git-result';
  previewBox.id = 'git-commit-preview';
  previewBtn.onclick = () => void (async () => {
    const p = await command('git.commitPreview', { projectId: state.projectId });
    state.gitCommitPreview = p;
    doBtn.disabled = !p.canCommit;
    const stagedLines = p.staged.slice(0, 10).map((s) => `${s.xy} ${s.path}${s.renamedFrom != null ? `（← ${s.renamedFrom}）` : ''}`).join('\n');
    previewBox.textContent = [
      `将提交（分支 ${p.branch ?? '（detached）'}，HEAD ${p.head == null ? '空仓库' : p.head.slice(0, 8)}，索引内容 tree ${p.indexTree == null ? '—' : p.indexTree.slice(0, 8)}）：`,
      stagedLines || '（暂存区为空）',
      p.staged.length > 10 ? `（另 ${p.staged.length - 10} 个）` : '',
      p.canCommit ? '前置检查通过：可提交（提交内容绑定预览时的索引 tree；变化即拒绝）。' : `暂不可提交：\n${p.blockers.map((b) => `· ${b}`).join('\n')}`,
      ...p.notes.map((n) => `· ${n}`),
    ].filter((s) => s !== '').join('\n');
  })().catch((error) => { previewBox.textContent = `预览失败：${error.message}`; });
  if (savedMsg !== '') msgInput.value = savedMsg;
  if (savedTask !== '') taskBind.value = savedTask;
  doBtn.onclick = () => void (async () => {
    const message = msgInput.value.trim();
    if (message === '') { previewBox.textContent = '请填写提交说明。'; return; }
    const p = state.gitCommitPreview;
    if (p == null || p.indexTree == null || p.branch == null) { previewBox.textContent = '请先预览提交（提交绑定预览时的内容/分支）。'; return; }
    const taskId = taskBind.value === '' ? undefined : taskBind.value;
    const r = await command('git.commit', {
      projectId: state.projectId, message,
      expectedHead: p.head, expectedIndexTree: p.indexTree, expectedBranch: p.branch,
      ...(taskId != null ? { taskId } : {}),
    });
    state.gitCommitPreview = null;
    doBtn.disabled = true;
    await refreshGitViews();
    const verifyNote = r.consistent === false
      ? `（警告：提交后核对不一致——本次提交对象 ${r.commit.slice(0, 8)} 已落库，但仓库当前 HEAD 为 ${(r.headAfterActual ?? '?').slice(0, 8)}（外部又推进）；不自动回滚，请人工核对）`
      : '';
    say(`已提交 ${r.commit.slice(0, 8)}${r.recovered === true ? '（崩溃恢复：核对到已存在的提交，未重复执行）' : r.replayed === true ? '（重放原回执）' : ''}${verifyNote}`);
    msgInput.value = '';
  })().catch((error) => { previewBox.textContent = `提交失败：${error.message}`; });
  commitRow.append(previewBtn, doBtn);
  box.append(commitRow, previewBox);

  // 分支（第十一轮·三）：列表/创建/切换——创建与切换绑定当前 HEAD（变化即拒绝）。
  const branchRow = document.createElement('div');
  branchRow.className = 'git-row';
  const branchSelect = document.createElement('select');
  branchSelect.className = 'git-input';
  branchSelect.id = 'git-branch-select';
  branchRow.appendChild(branchSelect);
  const branchNameInput = document.createElement('input');
  branchNameInput.className = 'git-input';
  branchNameInput.id = 'git-branch-name';
  branchNameInput.placeholder = '新分支名…';
  branchRow.appendChild(branchNameInput);
  const branchRefresh = async () => {
    const b = await command('git.branch.list', { projectId: state.projectId });
    branchSelect.innerHTML = '';
    for (const item of b.branches) {
      const opt = document.createElement('option');
      opt.value = item.name;
      opt.textContent = `${item.name}${item.name === b.current ? '（当前）' : ''}`;
      branchSelect.appendChild(opt);
    }
    if (b.current != null) branchSelect.value = b.current;
    return b;
  };
  await branchRefresh();
  const mkRowBtn = (label, titleText, onClick) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    if (titleText != null) b.title = titleText;
    b.onclick = () => void onClick().catch((error) => { say(`${label}失败：${error.message}`); });
    branchRow.appendChild(b);
    return b;
  };
  mkRowBtn('建分支', '在当前 HEAD 创建分支（不切换；HEAD 与确认一致才创建）', async () => {
    const name = branchNameInput.value.trim();
    if (name === '') { say('请填写新分支名。'); return; }
    const r = await command('git.branch.create', { projectId: state.projectId, name, expectedHead: await currentHeadOfRepo() });
    await branchRefresh();
    say(`已创建分支 ${r.name}（未切换）`);
    branchNameInput.value = '';
  });
  mkRowBtn('切换分支', '切换到所选分支；未提交改动随行（不自动 stash，冲突时 git 拒绝并如实报错）', async () => {
    const target = branchSelect.value;
    if (target === '') { say('请选择目标分支。'); return; }
    const b = await command('git.branch.list', { projectId: state.projectId });
    if (b.current === target) { say(`当前就在 ${target}。`); return; }
    const head = await currentHeadOfRepo();
    const r = await command('git.checkout', { projectId: state.projectId, branch: target, expectedHead: head, expectedBranch: b.current });
    await refreshGitViews();
    say(`已切换到 ${r.branch}（未提交改动 ${r.carriedDirtyCount} 项随行——不自动 stash）`);
  });
  box.appendChild(branchRow);

  // 远端（第十一轮·三）：推送/拉取绑定两端头（仅快进；凭据失败如实报错不改配置）。
  const remoteRow = document.createElement('div');
  remoteRow.className = 'git-row';
  const remoteInput = document.createElement('input');
  remoteInput.className = 'git-input';
  remoteInput.id = 'git-remote-name';
  remoteInput.value = 'origin';
  remoteInput.title = '远端名（git remote 配置的名称）';
  remoteRow.appendChild(remoteInput);
  const remoteBtn = (label, titleText, onClick) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.title = titleText;
    b.onclick = () => void onClick().catch((error) => { say(`${label}失败：${error.message}`); });
    remoteRow.appendChild(b);
  };
  remoteBtn('推送', '推送当前分支到远端（仅快进、不强推；绑定本地 HEAD 与远端当前头，任一变化即拒绝）', async () => {
    const remote = remoteInput.value.trim();
    const b = await command('git.branch.list', { projectId: state.projectId });
    const head = await currentHeadOfRepo();
    const rh = await command('git.remoteHead', { projectId: state.projectId, remote, branch: b.current });
    const r = await command('git.push', { projectId: state.projectId, remote, branch: b.current, expectedHead: head, expectedRemoteHead: rh.head, expectedRemoteUrl: rh.url });
    say(`已推送 ${b.current}：${(r.from ?? '（空）').slice(0, 8)} → ${r.to.slice(0, 8)}（远端 ${remote}）`);
  });
  remoteBtn('拉取', '快进拉取当前分支（分叉时不自动合并——如实拒绝，请人工处理）', async () => {
    const remote = remoteInput.value.trim();
    const b = await command('git.branch.list', { projectId: state.projectId });
    const head = await currentHeadOfRepo();
    const r = await command('git.pull', { projectId: state.projectId, remote, branch: b.current, expectedHead: head });
    await refreshGitViews();
    say(`已拉取 ${r.pulledCount} 个提交 → ${r.to.slice(0, 8)}（远端 ${remote}）`);
  });
  box.appendChild(remoteRow);

  // 冲突解决（第十一轮·三）：未合并路径的三方查看+手动内容提交（无整文件一键覆盖）。
  const conflicted = [...new Set((status.staged ?? []).filter((e) => (e.xy[0] === 'U' || e.xy[1] === 'U' || e.xy === 'AA' || e.xy === 'DD')).map((e) => e.path))];
  if (conflicted.length > 0) {
    const conTitle = document.createElement('div');
    conTitle.className = 'meta';
    conTitle.textContent = `冲突未解决（${conflicted.length} 个路径）——查看三方内容后手动提交解决文本：`;
    box.appendChild(conTitle);
    for (const path of conflicted) {
      mkBtn(`三方内容 ${wrapPath(path)}`, 'base / ours / theirs 三方内容（只读）', async () => {
        const tri = await command('git.conflict.content', { projectId: state.projectId, path });
        const existing = document.getElementById(`conflict-block-${path}`);
        if (existing != null) { existing.remove(); return; }
        const block = document.createElement('div');
        block.id = `conflict-block-${path}`;
        block.className = 'diff-block';
        const mkPart = (label, text) => {
          const h = document.createElement('div');
          h.className = 'meta';
          h.textContent = `〔${label}〕${text == null ? '（该侧无内容）' : ''}`;
          block.appendChild(h);
          if (text != null) {
            const pre = document.createElement('div');
            pre.className = 'diff-text';
            pre.textContent = text;
            block.appendChild(pre);
          }
        };
        mkPart('base 共同祖先', tri.base);
        mkPart('ours 本方', tri.ours);
        mkPart('theirs 对方', tri.theirs);
        const area = document.createElement('textarea');
        area.className = 'git-input';
        area.id = `conflict-resolve-${path}`;
        area.style.width = '100%';
        area.rows = 4;
        area.placeholder = '在此填写解决后的完整文件内容（手动合并；不提供整文件一键用某边覆盖）';
        const submit = document.createElement('button');
        submit.className = 'chip';
        submit.textContent = `提交解决 ${wrapPath(path)}`;
        submit.onclick = () => void (async () => {
          const content = area.value;
          if (content === '') { say('解决内容为空——如需删除该文件请用你自己的 git 客户端处理。'); return; }
          await command('git.conflict.resolve', { projectId: state.projectId, path, content });
          await refreshGitViews();
          say(`已解决冲突：${path}（写入内容并暂存）`);
        })().catch((error) => { say(`解决失败：${error.message}`); });
        block.append(area, submit);
        box.appendChild(block);
      });
    }
  }

  // 历史：按钮 + 列表（任务关联来自本产品操作日志——外部提交不虚构归属）。
  mkBtn('查看提交历史', '最近提交与任务/改动集关联（只展示关联，不表示整提交已人工审阅）', async () => {
    const existing = document.getElementById('git-history-block');
    if (existing != null) { existing.remove(); return; }
    const h = await command('git.history', { projectId: state.projectId, limit: 20 });
    const block = document.createElement('div');
    block.id = 'git-history-block';
    block.className = 'git-result';
    if (h.items.length === 0) {
      block.textContent = '（无提交历史）';
    } else {
      block.innerHTML = '';
      for (const item of h.items) {
        const line = document.createElement('div');
        line.className = 'git-row';
        const label = document.createElement('span');
        label.textContent = `${item.oid.slice(0, 8)} ${new Date(item.timestamp * 1000).toLocaleString()} ${item.subject}${item.taskIds.length > 0 ? `〔关联任务 ${item.taskIds.join('、')}〕` : ''}`;
        line.appendChild(label);
        const diffBtn = document.createElement('button');
        diffBtn.className = 'chip';
        diffBtn.textContent = 'diff';
        diffBtn.title = '单提交聚合差异（parents/关联/正文；merge 提交选择比较父——差异绑定所选父）';
        diffBtn.onclick = () => void (async () => {
          const ex = document.getElementById(`commitdiff-${item.oid}`);
          if (ex != null) { ex.remove(); return; }
          const d = await command('git.commitDiff', { projectId: state.projectId, oid: item.oid });
          const sub = document.createElement('div');
          sub.id = `commitdiff-${item.oid}`;
          sub.className = 'diff-block';
          const CHANGE = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名', copied: '复制' };
          const metaOf = () => {
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = `parents: ${d.commit.parents.map((p2) => p2.slice(0, 8)).join('、') || '（根提交）'} · ${d.commit.authorName}`;
            return meta;
          };
          const renderPatches = (data) => {
            for (const patch of data.patches) {
              const ph = document.createElement('div');
              ph.className = 'meta';
              ph.textContent = `${CHANGE[patch.change] ?? patch.change} ${patch.path}${patch.oldPath != null ? `（← ${patch.oldPath}）` : ''}${patch.binary ? '（二进制）' : ''}${patch.truncated ? '（超限截断）' : ''}`;
              sub.appendChild(ph);
              if (!patch.binary && patch.text.length > 0) {
                const pre = document.createElement('div');
                pre.className = 'diff-text';
                pre.textContent = patch.text;
                sub.appendChild(pre);
              }
            }
            if (data.patches.length === 0) {
              const empty = document.createElement('div');
              empty.className = 'meta';
              empty.textContent = '（相对该父无差异）';
              sub.appendChild(empty);
            }
          };
          sub.appendChild(metaOf());
          if (d.commit.parents.length > 1) {
            // 多父（第十四轮五）：父选择行——点击按该父 OID 重新加载；数据与展示绑定所选父。
            const note = document.createElement('div');
            note.className = 'meta';
            note.textContent = d.mergeNote ?? '合并提交：请选择比较父';
            sub.appendChild(note);
            const pickRow = document.createElement('div');
            pickRow.className = 'meta';
            pickRow.textContent = '比较父：';
            const body = document.createElement('div');
            body.className = 'meta';
            const renderParents = (activeOid) => {
              pickRow.textContent = '';
              pickRow.append('比较父：');
              for (const pm of d.parentsMeta ?? []) {
                const b = document.createElement('button');
                b.className = 'chip';
                b.textContent = `${pm.short} ${pm.subject.slice(0, 24)}`;
                if (pm.oid === activeOid) { b.disabled = true; b.title = '当前比较父'; }
                else { b.title = '以该父为基准查看差异（差异=本提交相对该父的实际变更）'; }
                b.onclick = () => void (async () => {
                  const d2 = await command('git.commitDiff', { projectId: state.projectId, oid: item.oid, parentOid: pm.oid });
                  body.textContent = '';
                  const head = document.createElement('div');
                  head.className = 'meta';
                  head.textContent = `对比父 ${d2.comparedParent.slice(0, 8)}（${(d2.parentsMeta ?? []).find((x) => x.oid === d2.comparedParent)?.subject ?? ''}）——差异相对该父`;
                  body.appendChild(head);
                  renderPatchesInto(body, d2, CHANGE);
                  renderParents(pm.oid);
                })().catch((error) => { say(`父比较加载失败：${error.message}`); });
                pickRow.appendChild(b);
              }
            };
            const renderPatchesInto = (target, data, changeMap) => {
              for (const patch of data.patches) {
                const ph = document.createElement('div');
                ph.className = 'meta';
                ph.textContent = `${changeMap[patch.change] ?? patch.change} ${patch.path}${patch.oldPath != null ? `（← ${patch.oldPath}）` : ''}${patch.binary ? '（二进制）' : ''}${patch.truncated ? '（超限截断）' : ''}`;
                target.appendChild(ph);
                if (!patch.binary && patch.text.length > 0) {
                  const pre = document.createElement('div');
                  pre.className = 'diff-text';
                  pre.textContent = patch.text;
                  target.appendChild(pre);
                }
              }
              if (data.patches.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'meta';
                empty.textContent = '（相对该父无差异）';
                target.appendChild(empty);
              }
            };
            renderParents(null);
            sub.appendChild(pickRow);
            sub.appendChild(body);
          } else {
            if (d.mergeNote != null) {
              const note = document.createElement('div');
              note.className = 'meta';
              note.textContent = d.mergeNote;
              sub.appendChild(note);
            }
            renderPatches(d);
          }
          box.appendChild(sub);
        })().catch((error) => { say(`diff 查看失败：${error.message}`); });
        line.appendChild(diffBtn);
        if (item.oid === h.head) {
          const undoBtn = document.createElement('button');
          undoBtn.className = 'chip';
          undoBtn.textContent = '撤销此提交（软回退）';
          undoBtn.title = '仅限当前 HEAD 提交：内容回工作区、文件不删（reset --mixed 语义；不做任何历史改写/强推）';
          undoBtn.onclick = () => void (async () => {
            const r = await command('git.commit.undo', { projectId: state.projectId, commitOid: item.oid, expectedHead: item.oid });
            await refreshGitViews();
            say(`已软回退到 ${r.to.slice(0, 8)}（${r.movedToUnstaged} 项改动回到未暂存；文件未删除）`);
          })().catch((error) => { say(`撤销失败：${error.message}`); });
          line.appendChild(undoBtn);
        }
        block.appendChild(line);
      }
    }
    box.appendChild(block);
  });
  if (savedHistory != null) {
    const block = document.createElement('div');
    block.id = 'git-history-block';
    block.className = 'git-result';
    block.textContent = savedHistory;
    box.appendChild(block);
  }
}

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
  // 运行能力真实状态（DEV-14：只读、不 spawn 子进程；与恢复帮助同侧——故障排查入口）。
  void renderRuntimeStatus().catch(() => { /* 状态查询失败不阻断恢复面 */ });
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
    el('recovery-help').classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  el('recovery-help').classList.remove('hidden'); // START-07 首版：恢复场景可读帮助随恢复面出现
  panel.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = `恢复中心：待对账 ${unknown.length} 项${undos.length > 0 ? `；未收口撤销 ${undos.length} 项` : ''}`;
  panel.appendChild(head);
  // 未收口撤销行（第九轮）：in_progress/failed 可续跑（changeset.undo 逐步幂等重验，不覆盖
  // 用户改动；conflict 不可自动继续——展示冲突原因，人工处置后重新发起）。
  for (const u of undos) {
    const row = document.createElement('div');
    row.className = 'recovery-row recovery-undo-row';
    row.dataset.changeSetId = u.changeSetId;
    const meta = document.createElement('span');
    meta.textContent = `未收口撤销：${u.changeSetId}（${u.status === 'failed' ? '中断——待恢复续跑' : '进行中'}；执行前逐文件重验 当前==改后，冲突不覆盖）`;
    row.appendChild(meta);
    if (u.status !== 'conflict') {
      const b = document.createElement('button');
      b.textContent = '继续撤销（幂等续跑）';
      b.onclick = () => void resumeUndo(u.changeSetId);
      row.appendChild(b);
    }
    panel.appendChild(row);
  }
  if (orphanLeases.length > 0) {
    // 「预算已处置、保护待解除」遗留保护行（第七轮·补）：正式继续核对入口=服务端取证后
    // 按条件解除（recovery.releaseProtection——拒绝时不解除并如实说明原因）。
    const pendingMark = new Map((data.pendingRelease ?? []).map((r) => [r.turnId, r]));
    for (const l of orphanLeases) {
      const mark = pendingMark.get(l.owner_turn_id);
      const row = document.createElement('div');
      row.className = 'recovery-orphan-row';
      row.dataset.turnId = l.owner_turn_id;
      const facts = document.createElement('div');
      facts.className = 'recovery-facts';
      const conflictHint = mark?.budgetMark === 'refunded'
        ? String.fromCharCode(10) + '（该 turn 已按未启动退款；若后来取得执行证据（账单/迟到产物），走 recovery.correctToExecuted 纠正账目——不自动改写）'
        : '';
      facts.textContent = `遗留保护：${l.owner_turn_id} 的写入租约仍持有（预算处置=${mark?.budgetMark ?? '已完成'}·${mark?.turnStatus ?? '?'}）——人工声明不解除物理保护；需服务端确认执行已结束（父进程+子进程）后按条件解除${conflictHint}`;
      row.appendChild(facts);
      const b = document.createElement('button');
      b.textContent = '继续核对并解除（服务端取证）';
      b.onclick = () => void releaseRetainedProtection(l.owner_turn_id);
      row.appendChild(b);
      panel.appendChild(row);
    }
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

/** 遗留保护正式解除：服务端取证按条件（exited/no-os-process）——查询不可确认即拒绝并保留。 */
async function releaseRetainedProtection(turnId) {
  let failure = null;
  try {
    await command('recovery.releaseProtection', { turnId, note: '恢复面「继续核对并解除」（用户操作）' });
  } catch (error) {
    failure = `解除被拒（保护保留）：${error.message}`;
  }
  await refreshGate();
  if (failure != null) showRecoveryError(failure);
}

/** 撤销续跑（changeset.undo 正式命令）：逐步幂等重验；结果/冲突如实展示并刷新恢复面。 */
async function resumeUndo(changeSetId) {
  let failure = null;
  let outcome = null;
  try {
    outcome = await command('changeset.undo', { changeSetId });
  } catch (error) {
    failure = `撤销未完成：${error.message}`;
  }
  await refreshGate();
  if (failure != null) { showRecoveryError(failure); return; }
  if (outcome != null && outcome.status === 'conflict') {
    showRecoveryError(`撤销冲突（不覆盖用户改动）：${JSON.stringify(outcome.failure ?? {}).slice(0, 200)}`);
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
// 仓库状态显隐（应用设置持久化，重开生效——app.settings.get/set 正式命令）。
async function applyRepoStatusVisibility() {
  let stored = null;
  try {
    const r = await command('app.settings.get', { keys: ['repoStatus.visible'] });
    stored = r.values['repoStatus.visible'] ?? null;
  } catch { /* 设置读取失败按缺省 */ }
  const visible = stored !== 'false'; // 缺省开
  state.repoStatusVisible = visible;
  const btn = el('repo-status-toggle');
  btn.textContent = `仓库状态：${visible ? '开' : '关'}`;
  el('repo-status').classList.toggle('hidden', !visible);
}
el('repo-status-toggle').onclick = () => void (async () => {
  const next = !(state.repoStatusVisible ?? true);
  try {
    await command('app.settings.set', { key: 'repoStatus.visible', value: String(next) });
    state.repoStatusVisible = next;
    el('repo-status-toggle').textContent = `仓库状态：${next ? '开' : '关'}`;
    el('repo-status').classList.toggle('hidden', !next);
  } catch (error) {
    el('thread-status').textContent = `设置保存失败：${error.message}`;
  }
})();
void applyRepoStatusVisibility().catch(() => { /* 设置读取失败按缺省 */ });
el('review-accept-btn').onclick = () => void reviewTask('accept');
// 要求修改：意见必填（§10.5-4）——展开返工意见行，确认后经正式命令提交。
el('review-reject-btn').onclick = () => {
  const pending = state.openTaskSnapshot?.pendingDelivery ?? null;
  if (pending == null) return;
  el('rework-note-revision').textContent = String(pending.revision);
  el('rework-note-input').value = '';
  el('rework-note-row').classList.remove('hidden');
  el('rework-note-input').focus();
};
el('rework-note-confirm').onclick = () => {
  const note = el('rework-note-input').value.trim();
  if (note === '') { el('rework-note-input').focus(); return; }
  void reviewTask('changes_requested', note);
};
el('rework-note-cancel').onclick = () => { el('rework-note-row').classList.add('hidden'); };

// 追加执行（返工闭环）：正式派发链——服务端组装输入（返工意见经 latestReviewFeedback 注入）。
el('redispatch-btn').onclick = () => void (async () => {
  const snap = state.openTaskSnapshot;
  if (snap == null) return;
  try {
    await command('task.redispatch', { taskId: snap.taskId, reason: '返工跟进（UI 追加执行）' });
    el('thread-status').textContent = '已追加执行（经正式派发链；返工意见随输入注入）';
  } catch (error) {
    el('thread-status').textContent = `追加执行失败：${error.message}`;
  }
  await renderThread();
})();

// ---------- 项目设置（第十轮·三：任务验收开关，RT-25/§10.5） ----------

// ---------- 成员 runtime 绑定设置（第十五轮四：member.runtime 读/member.setRuntime 写正式闭环） ----------

/**
 * 成员 runtime 绑定设置（设置组交付项之一）：
 * - 读取=member.runtime（安装/支持能力/已验证能力分列——配置成功≠已认证，不探活）；
 * - 保存=member.setRuntime（claude/codex 必填模型——服务端校验+客户端预检；fake 仅开发模式出现）；
 * - 作用范围=该成员**之后派发**的 turn（在途不变）；失败就地显示；绑定持久化（重开项目即重读）。
 */
async function renderMemberRuntimeSettings() {
  const box = el('member-runtime-list');
  if (box == null) return;
  box.textContent = '';
  if (state.projectId == null) { box.textContent = '（未打开项目）'; return; }
  const members = state.members ?? [];
  const agents = members.filter((m) => m.principalType === 'agent');
  if (agents.length === 0) { box.textContent = '（本项目无 agent 成员）'; return; }
  for (const m of agents) {
    const row = document.createElement('div');
    row.className = 'meta';
    let binding = null;
    try {
      binding = await command('member.runtime', { memberId: m.id });
    } catch { /* 读取失败按未绑定展示 */ }
    const kind = binding?.binding?.kind ?? null;
    const model = binding?.binding?.model ?? null;
    const caps = binding?.installation?.capabilities_json != null
      ? (() => { try { return JSON.parse(binding.installation.capabilities_json); } catch { return null; } })()
      : null;
    const current = kind == null ? '未绑定（派发回落全局 runtime）' : `${kind}${model != null ? ` · ${model}` : ''}`;
    const capNote = caps == null ? '' : ` ｜ 模型可用性：${caps.modelAvailability ?? '未记录'} · 权限认证：${caps.permissionAuth ?? '未记录'}（配置≠已认证，不自动探活）`;
    const label = document.createElement('span');
    label.textContent = `${m.displayName ?? m.id}：${current}${capNote}${m.enabled === false ? ' ｜ 已停用（不参与之后派发）' : ''}`;
    row.appendChild(label);
    // 协作参与开关（第十六轮六）：停用=该成员不再参与之后派发（协调者不可停用——服务端校验）。
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'chip';
    toggleBtn.textContent = m.enabled === false ? '启用' : '停用';
    toggleBtn.title = '停用后该成员不再参与之后的任务派发（在途任务不受影响）；协调者不可停用';
    toggleBtn.onclick = () => void (async () => {
      try {
        await command('member.setEnabled', { memberId: m.id, enabled: m.enabled === false });
        await renderMemberRuntimeSettings();
      } catch (error) {
        el('thread-status').textContent = `成员状态保存失败：${error.message}`;
      }
    })();
    row.appendChild(toggleBtn);
    const editBtn = document.createElement('button');
    editBtn.className = 'chip';
    editBtn.textContent = '绑定…';
    editBtn.title = '成员 runtime 绑定：作用范围=该成员之后派发的 turn；claude/codex 必须显式模型';
    editBtn.onclick = () => {
      // 编辑行（每次一个成员）：kind 下拉+模型输入+保存/取消；错误就地显示。
      for (const old of box.querySelectorAll('.member-runtime-edit')) old.remove();
      const edit = document.createElement('div');
      edit.className = 'member-runtime-edit meta';
      const kinds = [['claude', 'claude（CLI 渠道）'], ['codex', 'codex（App Server）']]; // fake 不入产品设置面（仅开发模式命令面可用——daemon 侧门禁）
      const sel = document.createElement('select');
      for (const [v, text] of kinds) {
        const o = document.createElement('option');
        o.value = v; o.textContent = text;
        if (v === kind) o.selected = true;
        sel.appendChild(o);
      }
      const modelInput = document.createElement('input');
      modelInput.placeholder = '模型（如 deepseek-flash）';
      modelInput.value = model ?? '';
      const save = document.createElement('button');
      save.className = 'chip';
      save.textContent = '保存';
      const cancel = document.createElement('button');
      cancel.className = 'chip';
      cancel.textContent = '取消';
      const err = document.createElement('span');
      err.className = 'meta';
      edit.append(sel, ' ', modelInput, ' ', save, ' ', cancel, ' ', err);
      cancel.onclick = () => edit.remove();
      save.onclick = () => void (async () => {
        err.textContent = '';
        const nextKind = sel.value;
        const nextModel = modelInput.value.trim();
        if (nextKind === 'claude' || nextKind === 'codex') {
          if (nextModel.length === 0) { err.textContent = '校验失败：该 runtime 必须显式模型（不默认、不猜测）'; return; }
          if (!/^[a-zA-Z0-9._-]+$/.test(nextModel)) { err.textContent = '校验失败：模型名含不接受的字符'; return; }
        }
        try {
          await command('member.setRuntime', { memberId: m.id, kind: nextKind, ...(nextModel.length > 0 ? { model: nextModel } : {}) });
          await renderMemberRuntimeSettings();
        } catch (error) {
          err.textContent = `保存失败：${error.message}`;
        }
      })();
      row.after(edit);
    };
    row.appendChild(editBtn);
    box.appendChild(row);
  }
}

/** 任务验收开关渲染：标签/说明随项目数据；CAS revision 来自 project.open 快照。 */
// ---------- 协作限制设置（§17.8，第十七轮三：project.collab.get/set 项目级闭环） ----------
/**
 * 缺席等待/单轮运行时限（分钟）：即时保存（失焦/Enter 校验提交；空=回落全局默认）；
 * 行内范围提示与失败原因；CAS 版本冲突提示刷新；新派发生效（在途不变）。projectId 绑定
 * 当前打开项目——不从全局状态回退其他项目。
 */
async function renderCollabSettings() {
  const box = el('collab-settings');
  if (box == null) return;
  box.textContent = '';
  if (state.project == null) { box.textContent = '（未打开项目）'; return; }
  let data;
  try {
    data = await command('project.collab.get', { projectId: state.projectId });
  } catch (e) {
    box.textContent = `读取失败：${e.message}`;
    return;
  }
  const revision = data.revision;
  const fields = [
    { key: 'absenceToleranceMs', label: '缺席等待（分钟，E4：超时按缺席推进、不打断在途成员）', value: data.absenceToleranceMs },
    { key: 'turnDeadlineMs', label: '单轮运行时限（分钟，硬保护：到点转状态未知不伪造结果）', value: data.turnDeadlineMs },
  ];
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'meta';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.placeholder = '默认';
    input.value = f.value != null ? String(Math.round(f.value / 60000)) : '';
    input.title = '范围 1–1440 分钟；清空=回落 daemon 全局默认';
    const err = document.createElement('span');
    err.className = 'meta';
    const submit = async () => {
      err.textContent = '保存中…';
      const raw = input.value.trim();
      const ms = raw === '' ? null : Number(raw) * 60000;
      if (ms != null && (!Number.isInteger(ms) || ms < 10_000 || ms > 86_400_000)) {
        err.textContent = '范围要求：1–1440 分钟（整数）；未保存';
        return;
      }
      try {
        const r = await command('project.collab.set', { projectId: state.projectId, [f.key]: ms, expectedRevision: revision });
        err.textContent = r.changed ? '已保存' : '无变更';
        await renderCollabSettings(); // 重读 revision（后续保存用新版本）
      } catch (e2) {
        err.textContent = /版本冲突/.test(e2.message) ? `保存失败：${e2.message}（已刷新，请重试）` : `保存失败：${e2.message}`;
        if (/版本冲突/.test(e2.message)) void renderCollabSettings();
      }
    };
    input.onblur = () => void submit();
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } if (ev.key === 'Escape') { input.value = f.value != null ? String(Math.round(f.value / 60000)) : ''; err.textContent = ''; } };
    row.append(`${f.label}：`, input, err);
    box.appendChild(row);
  }
}
function renderProjectSettings() {
  const btn = el('task-review-toggle');
  const note = el('task-review-note');
  if (state.project == null) {
    btn.textContent = '任务验收：—（未打开项目）';
    btn.disabled = true;
    note.textContent = '';
    return;
  }
  btn.disabled = false;
  const on = state.project.taskReviewEnabled === true;
  btn.textContent = `任务验收：${on ? '开' : '关'}`;
  note.textContent = on
    ? '当前开启：新任务交付进入待验收（创建时快照）。已有任务保持创建时的策略。'
    : '当前关闭：新任务满足交付要求即完成（无需验收）。关闭不授权自动提交或推送。';
}

el('task-review-toggle').onclick = () => void (async () => {
  if (state.project == null) return;
  const next = !(state.project.taskReviewEnabled === true);
  try {
    const r = await command('project.reviewPolicy.set', {
      projectId: state.project.id, taskReviewEnabled: next, expectedRevision: state.project.revision,
    });
    state.project = { ...state.project, taskReviewEnabled: r.taskReviewEnabled, revision: r.revision };
    renderProjectSettings();
  } catch (error) {
    if (error.code === 'STALE_REVISION') {
      // 项目已被并发修改：重开项目取最新快照后提示重试（不盲目覆盖他人改动）。
      const last = localStorage.getItem('zs.lastProjectPath');
      if (last != null) await loadProject(last);
    }
    el('task-review-note').textContent = `设置失败：${error.message}`;
  }
})().catch((error) => { el('task-review-note').textContent = `设置失败：${error.message}`; });
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
renderProjectSettings(); // 未打开项目时的初始态（loadProject 成功后随项目数据刷新）
const lastProject = localStorage.getItem('zs.lastProjectPath');
if (lastProject != null && lastProject.length > 0) {
  void loadProject(lastProject).catch((e) => {
    el('project-name').textContent = `恢复项目失败：${e.message}`;
  });
}
})();
