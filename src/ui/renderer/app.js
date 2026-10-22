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
  /** 图片能力门一次性确认（第二十九轮三）：确认后随下一条消息消费（imageAck=omit-images）。 */
  imageAckPending: false,
  /** 首启服务端记忆轮询取消位（第四十三轮 P0）：用户手动打开项目后停轮询。 */
  startupMemoryPollCancelled: false,
  /** 导航代次（第二十三轮一）：每次切换视图/会话/项目 +1——异步响应凭 (目标三元组+代次)
   * 核对，A→B→A 时旧 A 的迟到响应不再被误当作当前。 */
  navGeneration: 0,
  /** 项目装载代次（第三十八轮 #1）：每次 loadProject +1——并发的旧装载（深链/重试/用户操作）
   * 在任何 await 之后核对，迟到者不落状态、不清侧栏。 */
  projectLoadGen: 0,
  /** 深链/待我处理定位焦点（一次性消费）：{ kind:'dm'|'msg'|'review'|'task', ... }。 */
  pendingFocus: null,
  /** 当前项目快照（project.open 结果：任务验收开关/revision 等——项目设置的读写来源）。 */
  project: null,
  /** runtime 环境模式（第三十八轮 #2：验收防护包=拒绑真实渠道、设置面提供 fake 正路径）。 */
  runtimeEnvironment: null,
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
  // 私信（DEV-22）：当前打开会话 + 侧栏摘要缓存；dmRecordOnly 为私信自己的仅记录意图。
  openDmId: null,
  dmRecordOnly: false,
  dmConversations: [],
};

const el = (id) => document.getElementById(id);

/** 非阻塞错误呈现（第二十轮一）：alert() 会阻塞 renderer 主线程（自动化/无头环境永久挂死），
 *  一切异步错误一律 conn-state 行内显示——不丢反馈也不挂页面。 */
function showError(message) {
  const box = el('conn-state');
  box.textContent = message;
  box.classList.add('err');
}

const uuid = () => `ui-${crypto.randomUUID()}`;
// 视图=pool/thread/dm（DEV-22：私信独立视图——不与房间输入区共享意图控件）。
const currentView = () => (state.openDmId != null ? 'dm' : state.openThreadId == null ? 'pool' : 'thread');

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
// 导航审计环（第三十八轮 #1：侧栏「闪现后清空」根因未定位——留现场取证）：记录每次
// loadProject/renderDmSidebar 的发起与结果（代次/路径/项目/数量/错误），供调试端口核对；
// 不含任何凭据。上限 60 条滚动覆盖。
const navAudit = [];
function navAuditPush(entry) {
  navAudit.push({ t: new Date().toISOString(), ...entry });
  if (navAudit.length > 60) navAudit.shift();
  window.__zsNavAudit = navAudit;
}

async function openFolder() {
  state.startupMemoryPollCancelled = true; // 用户手动打开——停首启记忆轮询（第四十三轮 P0）
  const dir = await zs.pickFolder();
  if (dir == null) return;
  await loadProject(dir);
}

async function loadProject(path, opts) {
  const gen = ++state.projectLoadGen;
  navAuditPush({ what: 'loadProject.start', gen, path, from: opts?.from ?? 'user' });
  let data;
  try {
    data = await command('project.open', { path });
  } catch (e) {
    navAuditPush({ what: 'loadProject.openFailed', gen, path, error: String(e.message).slice(0, 160) });
    throw e;
  }
  if (gen !== state.projectLoadGen) {
    // 迟到装载（第三十八轮 #1：深链/重试/用户操作并发打开另一项目）：不落任何状态、不碰侧栏
    // ——晚到的旧装载不得清空或覆盖新项目的渲染。
    navAuditPush({ what: 'loadProject.staleAborted', gen, path, projectId: data.project.id });
    return;
  }
  const prevProjectId = state.projectId;
  state.project = data.project; // 项目设置（任务验收开关）的 CAS revision/当前值来源
  state.projectId = data.project.id;
  localStorage.setItem('zs.lastProjectPath', path); // 重启后自动恢复上次项目
  void command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: path }).catch(() => { /* 服务端记忆尽力——localStorage 仍为主 */ });
  el('project-name').textContent = `${data.project.displayName} · ${path}`;
  renderProjectSettings();
  void renderCollabSettings().catch(() => { /* 读取失败已行内显示 */ });
  void renderMemberRuntimeSettings().catch(() => { /* 绑定读取失败按未绑定呈现——不阻断项目加载 */ });
  const rooms = await command('room.list', { projectId: state.projectId });
  if (gen !== state.projectLoadGen) {
    navAuditPush({ what: 'loadProject.staleAbortedAfterRooms', gen, path, rooms: rooms.items.length });
    return;
  }
  const list = el('room-list');
  // 空结果保护（第三十八轮 #1：现场「闪现后被清空」）：同一项目此前渲染过非空房间列表，
  // 本次却返回空——数据矛盾，保留旧列表+标注（不清空、不冒充空项目）；跨项目切换不受限。
  if (rooms.items.length === 0 && prevProjectId === state.projectId && list.children.length > 0) {
    navAuditPush({ what: 'loadProject.emptyRoomsRetained', gen, path, projectId: state.projectId, kept: list.children.length });
    el('project-name').textContent = `${data.project.displayName} · ${path}（房间列表读取异常返回空——已保留原列表）`;
  } else {
    list.innerHTML = '';
    for (const room of rooms.items) {
      const item = document.createElement('div');
      item.className = 'room-item';
      item.dataset.roomId = room.id; // 换装壳定向接管按机器身份定位（review-r48 §4——不用名称 includes）
      item.textContent = `# ${room.name}`;
      item.onclick = () => void selectRoom(room.id, room.conversationId, item);
      list.appendChild(item);
    }
  }
  navAuditPush({ what: 'loadProject.rooms', gen, path, projectId: state.projectId, count: rooms.items.length });
  const first = rooms.items[0];
  if (first != null && gen === state.projectLoadGen) {
    const firstEl = list.querySelector('.room-item');
    await selectRoom(first.id, first.conversationId, firstEl);
  }
  if (gen !== state.projectLoadGen) return;
  void renderDmSidebar().catch((e) => navAuditPush({ what: 'renderDmSidebar.failed', gen, error: String(e.message).slice(0, 160) }));
  void restoreDmDeepLink().catch(() => { /* 深链失效留在主池 */ });
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
      const key = `${state.projectId ?? 'p?'}:${state.roomId ?? 'noroom'}:${view === 'thread' ? (state.openThreadId ?? '-') : '-'}`;
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
  // 完整目标键（第二十八轮三）：projectId+roomId+threadId——同房间线程 A/B 不再共用 'thread'
  // 视图键（正文/mention/附件曾因此串草稿）；主池=thread 位 '-'。DM 键见 attachDraftKey
  //（project/conversation 身份）——正文与附件同键空间。
  return `${state.projectId ?? 'p?'}:${state.roomId ?? 'noroom'}:${state.openThreadId ?? '-'}`;
}

function saveDraft() {
  state.drafts[draftKey()] = { text: el('composer-input').value, mention: el('mention-pick').value };
}

function restoreDraft() {
  const d = state.drafts[draftKey()] ?? { text: '', mention: '' };
  el('composer-input').value = d.text;
  el('mention-pick').value = d.mention;
  renderAttachChips('composer'); // 附件草稿同键恢复（pool/thread 切换——A→B→A 恢复 A）
}

function showPool() {
  closeAttachPreview(); // 预览随会话切换失效（第二十八轮三）——在途代次作废
  state.navGeneration += 1;
  if (state.openThreadId != null) saveDraft();
  state.openThreadId = null;
  state.openTaskId = null;
  state.openTaskSnapshot = null;
  state.openAnchorText = null;
  state.openDmId = null;
  updateStopUi(null);
  // 第四十三轮 UI-02：主视图标记（CSS 视图级收起——DM 视图收起主池输入区/工具面）。
  resetToolPanels(); // 第四十四轮 §3：工具态随视图入口归零（布尔/hidden/data-view 不残留）
  document.querySelector('main.main')?.setAttribute('data-view', 'pool');
  el('thread').classList.add('hidden');
  el('dm').classList.add('hidden');
  el('pool').classList.remove('hidden');
  el('thread-title').textContent = '主对话池';
  if (/^dm=/.test(decodeURIComponent(location.hash.slice(1)))) location.hash = '';
  restoreDraft();
}

async function openThread(threadId, taskId, anchorText) {
  closeAttachPreview(); // 同上：切线程/会话关预览
  state.navGeneration += 1;
  saveDraft();
  state.openThreadId = threadId;
  state.openDmId = null;
  state.reviewConfirm = null; // 换线程清上一线程的验收回执
  state.openTaskId = taskId ?? null;
  state.openTaskSnapshot = null;
  state.openAnchorText = anchorText ?? null;
  resetToolPanels(); // 第四十四轮 §3：工具态随视图入口归零
  document.querySelector('main.main')?.setAttribute('data-view', 'thread');
  el('pool').classList.add('hidden');
  el('dm').classList.add('hidden');
  el('thread').classList.remove('hidden');
  el('thread-title').textContent = '任务回复串';
  restoreDraft();
  await renderThread();
}

// ---------- 私信（DEV-22：1 对 1 会话——conversation.* 命令面；无 @ 派工/无任务号） ----------

const DM_STATE_TEXT = { idle: '', running: '运行中…', queued: '排队等待（串行）', paused: '队列已暂停（停止后）', interrupted: '有中断待恢复的任务' };

async function renderDmSidebar() {
  if (state.projectId == null) return;
  const gen = state.projectLoadGen;
  const projectIdAtRender = state.projectId;
  const data = await command('conversation.list', { projectId: projectIdAtRender }).catch((e) => {
    // 读取失败保留旧列表（第三十八轮 #1：不清空、不冒充「无私信」——失败已入审计环）。
    navAuditPush({ what: 'renderDmSidebar.readFailed', gen, projectId: projectIdAtRender, error: String(e.message).slice(0, 160) });
    return null;
  });
  if (data == null) return;
  if (gen !== state.projectLoadGen || state.projectId !== projectIdAtRender) {
    navAuditPush({ what: 'renderDmSidebar.staleAborted', gen, projectId: projectIdAtRender, count: (data.conversations ?? []).length });
    return; // 迟到重绘（项目已切走）：不覆盖新项目的侧栏
  }
  const conversations = data.conversations ?? [];
  state.dmConversations = conversations;
  const nav = el('dm-list');
  // 空结果保护：同项目此前非空、本次成功但空——数据矛盾，保留旧列表（与项目装载同规则）。
  if (conversations.length === 0 && nav.children.length > 0) {
    navAuditPush({ what: 'renderDmSidebar.emptyRetained', gen, projectId: projectIdAtRender, kept: nav.children.length });
    return;
  }
  navAuditPush({ what: 'renderDmSidebar.render', gen, projectId: projectIdAtRender, count: conversations.length });
  nav.replaceChildren();
  for (const c of conversations) {
    const btn = document.createElement('button');
    btn.className = 'room' + (c.conversationId === state.openDmId ? ' active' : '');
    btn.dataset.conversationId = c.conversationId; // 换装壳定向接管按会话 ID 定位（review-r48 §4）
    const stateText = c.archivedAt != null ? '（已归档）' : DM_STATE_TEXT[c.execState] ?? '';
    // 同成员多会话区分（第三十八轮 #6）：会话标题（有则用）→最近消息预览——一串相同成员名
    // 不可辨认是现场卡死路径之一（用户始终误入空白会话）。
    const distinguish = c.title != null && c.title.length > 0
      ? ` · ${c.title}`
      : (c.lastMessagePreview != null && c.lastMessagePreview.length > 0 ? ` · ${c.lastMessagePreview}` : '');
    btn.textContent = `${c.peerDisplayName}${distinguish}${stateText}${c.unread > 0 ? ` ·${c.unread}` : ''}`;
    btn.title = c.archivedAt != null ? '已归档：只读（可取消归档）'
      : (c.title != null && c.title.length > 0 ? c.title : '一对一私信：发送即交给该成员');
    btn.onclick = () => void openDm(c.conversationId).catch((e) => showError(`打开私信失败：${e.message}`));
    nav.append(btn);
  }
}

async function openDm(conversationId) {
  closeAttachPreview(); // 跨私信切换：受限资源预览不留面
  state.navGeneration += 1;
  state.openDmId = conversationId;
  state.openThreadId = null;
  resetToolPanels(); // 第四十四轮 §3：工具态随视图入口归零（DM 中显式打开的工具不再残留）
  document.querySelector('main.main')?.setAttribute('data-view', 'dm');
  el('pool').classList.add('hidden');
  el('thread').classList.add('hidden');
  el('dm').classList.remove('hidden');
  renderAttachChips('dm'); // 按 dm:{conversationId} 键恢复（A→B→A 恢复 A——不清空）
  location.hash = `dm=${conversationId}`; // 会话深链（第十九轮七：恢复打开位置）
  await renderDm();
  void renderDmSidebar().catch(() => {});
}

/** 深链恢复：#dm=<conversationId> —— 项目加载后回到该会话（不存在则忽略）。 */
/** 导航所有权门（第五十二轮，review-r51 §4）：只有**当前可见客户端**处理导航。
 * 新界面在位（hifi 想要且未失败、未进入原界面接管）时，隐藏的 legacy 不得执行深链恢复/
 * openThread/markRead——此前隐藏端仍沿 hashchange/popstate 推进线程打开与标读，与新界面
 * 双重处理同一导航。接管（legacy-on）、hifi 失败回退、?nohifi 时 legacy 重新拥有导航。 */
function legacyOwnsNavigation() {
  const hifiActive = window.__zsHifiWanted === true
    && window.__zsHifiFailed !== true
    && !document.body.classList.contains('legacy-on');
  return !hifiActive;
}

async function restoreDmDeepLink() {
  // 统一导航（第二十三轮二）：解析并校验目标→聚焦来源项目（跨项目切换）→打开正确线程或
  // DM→定位消息/交付版本。刷新、直接打开链接、前进后退（hashchange/popstate）共用本入口；
  // URL 目标优先于旧 localStorage 恢复。
  if (!legacyOwnsNavigation()) return; // 新界面可见时旧端不处理导航（含隐藏期标读）
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.length === 0) return;
  const m = /^(dm|task|delivery|msg)=([\w:-]+)$/.exec(hash);
  if (m == null) return;
  try {
    const r = await command('deepLink.resolve', { hash: `#${hash}` });
    // 跨项目聚焦（第二十三轮二）：来源项目≠当前项目时切换（project.open 按 rootPath）；
    // 本项目会话与可见项目顺序保留——不回退到当前项目同号任务。
    // 第三十八轮 #1 修正：按**项目身份**（projectId）判定，不再比较路径字符串——canonical
    // 大小写/分隔符/junction 形态差异曾使同项目被误判为跨项目，触发二次 loadProject（侧栏
    // 「闪现后清空」的候选根因——路径等价≠字符串相等）。
    if (r.projectId != null && r.projectId !== state.projectId) {
      if (r.rootPath != null) await loadProject(r.rootPath, { from: 'deepLink' });
    }
    if (r.kind === 'dm') {
      state.pendingFocus = null;
      await openDm(r.conversationId);
      return;
    }
    if (r.kind === 'msg') {
      // 消息：DM 会话→打开+定位 seq；线程消息→打开线程后由线程视图置顶（锚点文本为根）。
      const conv = ((await command('conversation.list', { projectId: r.projectId }).catch(() => ({ conversations: [] }))).conversations ?? []).find((c) => c.conversationId === r.conversationId);
      if (conv != null && r.threadId == null) {
        state.pendingFocus = { kind: 'msg', conversationId: r.conversationId, messageSeq: r.messageSeq };
        await openDm(r.conversationId);
        return;
      }
      if (r.threadId != null) { await openThread(r.threadId, null, ''); return; }
      return;
    }
    if (r.kind === 'task' || r.kind === 'delivery') {
      // 任务/交付：DM 会话→打开（交付经 pendingFocus 定位对应版本）；房间任务→打开线程。
      const conv = ((await command('conversation.list', { projectId: r.projectId }).catch(() => ({ conversations: [] }))).conversations ?? []).find((c) => c.conversationId === r.conversationId);
      if (conv != null && r.threadId == null) {
        state.pendingFocus = r.kind === 'delivery'
          ? { kind: 'review', conversationId: r.conversationId, taskId: r.taskId, deliveryId: r.deliveryId, revision: r.revision, manifestHash: r.manifestHash }
          : null;
        await openDm(r.conversationId);
        return;
      }
      if (r.threadId != null) { await openThread(r.threadId, r.taskId ?? null, ''); return; }
      showPool();
      void renderPool().catch(() => {});
    }
  } catch (e) {
    showError(`深链无法定位：${e.message}`);
  }
}

/** 待我处理（DEV-18 首包；第二十三轮二重写）：权威业务状态汇总（mine.pending——纯读）。
 * 条目保留 project/task/conversation/delivery 身份并显示来源项目；**全部渲染**（无 slice
 * 截断——第 13 项及以后同样可达），头部显示总数；同会话多待验收逐条可达（进入定位对应
 * 交付版本）；读卡片≠完成事项：阅读/重绘不消待办。 */
// ---------- DEV-24 文本附件（第二十六轮五首包；第二十七轮三草稿键控+预览闭环）----------
// 上传=保存副本（attachment.uploadText——内容寻址落应用数据区）；**草稿按目标键隔离**：
// composer 键=room:view（与文本草稿同键空间）、DM 键=dm:{conversationId}——A→B→A 恢复 A
// 的附件（不再全局数组/切 DM 清空）。上传异步回执**绑定发起时的目标键**（file.text/网络期间
// 用户切换会话不会把 A 的附件追加进 B 的草稿）。真实文件字节编码校验：fatal 严格 UTF-8 解码
// （File.text() 是有损解码——无效字节明确失败，不以替换字符冒充编码正确）。发送成功只清发起
// 键的草稿；失败保留正文与附件。芯片点击=经 attachment.previewText（audience+完整性校验）
// 共享文本预览；已发消息附件芯片同样可点（thread.history/conversation.history attachments）。
const draftAttachments = new Map(); // 目标键 -> Array<{attachmentId, filename, hash, truncated}>
function attachDraftKey(kind) {
  // DM 键保留 project/conversation 身份（第二十八轮三）；composer 键=draftKey()（project+room+thread）。
  if (kind === 'dm') return state.openDmId != null ? `dm:${state.projectId ?? 'p?'}:${state.openDmId}` : 'dm:none';
  return draftKey();
}
function attachDraft(kind) {
  const key = attachDraftKey(kind);
  if (!draftAttachments.has(key)) draftAttachments.set(key, []);
  return draftAttachments.get(key);
}
function renderAttachChips(kind) {
  const box = el(kind === 'dm' ? 'dm-attach-chips' : 'composer-attach-chips');
  if (box == null) return;
  const frag = document.createDocumentFragment();
  for (const att of attachDraft(kind)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `📎 ${att.filename}（${att.hash.slice(0, 8)}…${att.truncated ? ' 截断' : ''}）`;
    chip.title = `点按预览副本（sha256=${att.hash}）——原文件修改不影响已发内容`;
    chip.onclick = () => void previewAttachment(att.attachmentId, att.filename, att.kind).catch((e) => showError(`预览失败：${e.message}`));
    frag.append(chip);
  }
  if (attachDraft(kind).length > 0) {
    const clear = document.createElement('button');
    clear.className = 'chip';
    clear.textContent = '清空附件';
    clear.onclick = () => { draftAttachments.delete(attachDraftKey(kind)); renderAttachChips(kind); };
    frag.append(clear);
  }
  box.replaceChildren(frag);
}
/** 预览代次（第二十八轮三）：previewAttachment 两次 await（previewText+评论列表）——
 * A/B 交错、关闭、切换会话后的迟到响应不得重开/覆盖面板。每次打开 +1；关闭/切会话再 +1
 * 使在途代次全部作废（受限资源跨会话不留面：openDm/showPool/openThread 入口即关）。 */
let previewGeneration = 0;
// 第四十轮·选型 A：视觉预览生命周期——pptx-renderer viewer 与打开期 AbortController
// 归属当前面板；关闭/切会话即 dispose+abort（在途解析中止；迟到结果不得重开/覆盖面板）。
let activePptxViewer = null;
let activePreviewAbort = null;
/** 释放当前轮持有的预览资源（第四十一轮 §3：不增代次、不藏面板）——新轮启动前调用：
 * 在途 controller abort + viewer dispose，指针一并收回。旧轮资源不得被新轮指针覆盖后
 * 遗失；迟到轮的清理只作用于自身（activePptxViewer 仍是本轮 viewer 时才动）。 */
function releaseActivePreviewResources() {
  if (activePreviewAbort != null) { try { activePreviewAbort.abort(new Error('preview-superseded')); } catch (e) { /* 已中止 */ } activePreviewAbort = null; }
  if (activePptxViewer != null) { try { activePptxViewer.dispose(); } catch (e) { /* 已释放 */ } activePptxViewer = null; }
}
function closeAttachPreview() {
  previewGeneration += 1; // 在途预览请求全部作废
  releaseActivePreviewResources();
  el('attach-preview')?.classList.add('hidden');
  // 第四十三轮 UI-01/03：工具条与展开态一并收起；main 的 preview-open 移除——仓库/Git
  // 工具行恢复呈现（其收起只随预览存在，不改用户偏好开关）。
  el('attach-preview-bar')?.classList.add('hidden');
  el('attach-preview')?.classList.remove('expanded');
  const expandBtn = el('attach-preview-expand');
  if (expandBtn != null) expandBtn.textContent = '⤢ 展开预览';
  document.querySelector('main.main')?.classList.remove('preview-open');
}
/** 预览面板显示的唯一入口（第四十三轮 UI-03）：面板+工具条同显，并给 main 打 preview-open
 * （收起仓库/Git 工具行，把高度让给预览）。所有打开分支（文本/PDF/图片/Office/项目文件）
 * 统一走这里——此前各分支只 remove('hidden')，且 CSS 未生效（UI-01），工具行也不收起。 */
function showAttachPreviewPanel() {
  el('attach-preview')?.classList.remove('hidden');
  el('attach-preview-bar')?.classList.remove('hidden');
  document.querySelector('main.main')?.classList.add('preview-open');
}
// PDF 视觉渲染（第二十九轮三）：渲染器受限预览侧加载随包 pdfjs ESM（zsres:// 特权协议下
// 模块与 worker 可用——file:// 会被模块 CORS 拦截）；原件字节每附件取一次，翻页/缩放本地。
const pdfBytesCache = new Map();
let rendererPdfjsPromise = null;
async function loadRendererPdfjs() {
  if (rendererPdfjsPromise == null) {
    rendererPdfjsPromise = import(new URL('assets/pdfjs/pdf.min.mjs', document.baseURI).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('assets/pdfjs/pdf.worker.min.mjs', document.baseURI).href;
      return lib;
    });
  }
  return rendererPdfjsPromise;
}

// 第四十轮·选型决定 A：PPTX=pptx-renderer 1.3.0（受管 vendored ESM 单文件——PROVENANCE
// 钉版本+sha256）；Word=docx-preview 0.4.1（UMD+JSZip 3.10.2）。全部本地随包（assets/vendor，
// 不走 CDN）。EMF/内嵌 PDF 回退**显式关闭**（pdfjs:false——不升级既有 PDF.js 4.10 链）。
let rendererPptxLibPromise = null;
function loadRendererPptx() {
  if (rendererPptxLibPromise == null) {
    rendererPptxLibPromise = import(new URL('assets/vendor/pptx-renderer.es.mjs', document.baseURI).href);
  }
  return rendererPptxLibPromise;
}
function loadVendorScript(rel) {
  const existing = document.querySelector(`script[data-zs-vendor="${rel}"]`);
  if (existing != null) {
    if (existing.dataset.loaded === 'true') return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`vendor 脚本加载失败：${rel}`)));
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL(rel, document.baseURI).href;
    s.dataset.zsVendor = rel;
    s.onload = () => { s.dataset.loaded = 'true'; resolve(); };
    s.onerror = () => reject(new Error(`vendor 脚本加载失败：${rel}`));
    document.head.append(s);
  });
}
let rendererDocxPreviewPromise = null;
function loadRendererDocxPreview() {
  if (rendererDocxPreviewPromise == null) {
    rendererDocxPreviewPromise = (async () => {
      await loadVendorScript('assets/vendor/jszip.min.js');
      await loadVendorScript('assets/vendor/docx-preview.min.js');
      if (window.docx == null) throw new Error('docx-preview 全局未就绪');
      return window.docx;
    })();
  }
  return rendererDocxPreviewPromise;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ---------- 共享预览完善（第三十轮四/五）----------
/** 项目文件只读快照（project.file.read：路径限项目根+实身份+文本白名单——非托管副本）。 */
async function projectFilePreview(projectId, name) {
  const myGen = ++previewGeneration;
  const r = await command('project.file.read', { projectId, path: name });
  if (myGen !== previewGeneration) return; // 迟到作废
  const box = el('attach-preview');
  if (box == null) { showError(`项目文件（${name}）：${r.bytes}B——容器缺失`); return; }
  showAttachPreviewPanel();
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `🗂 项目文件 · ${r.baseName} · ${r.bytes}B${r.truncated ? `（超 64KB 截断）` : ''} · 只读快照（非托管副本——源文件变化不追溯；不进模型输入）`;
  const close = document.createElement('button');
  close.className = 'chip';
  close.textContent = '关闭预览';
  close.onclick = () => closeAttachPreview();
  const content = document.createElement('pre');
  content.className = 'attach-preview-text';
  content.textContent = r.content;
  const wrap = document.createElement('div');
  wrap.append(head, close, content);
  wirePreviewTools(wrap, { filename: r.baseName, hash: `project-file:${projectId}/${name}`, revision: null, pre: content });
  box.replaceChildren(wrap);
}

/**
 * Markdown 安全渲染（第三十九轮 §3：markdown-it + DOMPurify 成熟组件——不再自写正则兜底）：
 * - markdown-it html:false（原始 HTML 全转义）+ breaks；链接仅 http(s)/mailto 且新窗口
 *   （renderer 覆写统一加 rel=noopener）；图片**不渲染**——占位文本「远程图片不加载」（离线
 *   合同不变：页面零自动网络访问）；
 * - 输出经 DOMPurify（ALLOWED_TAGS 受控集+ALLOWED_URI_REGEXP 协议白名单）二次收口——
 *   双层（生成约束+净化）任一层都足以拦住恶意样本。
 */
const MD_URI_OK = /^(?:(?:https?|mailto):|[^:\w]*#)/i;
const mdInstance = (() => {
  if (typeof window.markdownit !== 'function') return null; // vendored 脚本未加载（异常环境）——调用方回退纯文本
  const md = window.markdownit({ html: false, breaks: true, linkify: false, typographer: false });
  const defLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIdx = token.attrIndex('href');
    if (hrefIdx >= 0 && !MD_URI_OK.test(String(token.attrs[hrefIdx][1] ?? ''))) {
      token.attrs[hrefIdx][1] = '#'; // 非 http(s)/mailto 协议（javascript: 等）——锚化为不可导航
    }
    token.attrSet('rel', 'noopener noreferrer');
    token.attrSet('target', '_blank');
    return defLink(tokens, idx, options, env, self);
  };
  md.renderer.rules.image = (tokens, idx) => {
    const t = tokens[idx];
    const alt = (t.content || '').slice(0, 60);
    return `[图片占位：${alt}（远程图片不加载）]`;
  };
  return md;
})();
// 注意：不设自定义 ALLOWED_URI_REGEXP——DOMPurify 将该正则作用于**所有**属性值（几何值/rel
// 值等非 URI 文本也过测），窄式正则会误剥正常属性（第三十九轮实测）；协议控制由 markdown-it
// html:false + link_open 规则（非 http(s)/mailto 锚化）+ DOMPurify 默认 scheme 黑名单三层承担。
const MD_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'span', 'div'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  FORBID_ATTR: ['style', 'srcset'],
};
function mdToSafeHtml(md) {
  if (mdInstance == null || typeof window.DOMPurify !== 'function' || typeof window.DOMPurify.sanitize !== 'function') {
    // 组件缺失（异常环境）——纯转义降级，不冒充渲染。
    return `<pre>${String(md).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`;
  }
  const raw = mdInstance.render(md);
  return window.DOMPurify.sanitize(raw, MD_SANITIZE_CONFIG);
}

/**
 * SVG 净化门（第三十九轮 §2：DOMPurify 在真实 DOM 上解析——无引号/单双引号/命名空间/畸形
 * 标签一律按 HTML 解析器语义处理，不再靠正则枚举；图片仅 data:image base64（外链被剥除——
 * 页面零自动网络请求）。服务端 svgWellFormed 保留为缓存结构第一层，不再扩张；本函数是渲染
 * 前的安全边界。暴露 window.__zsSanitizeSvg 供页面级反例验证（同一函数，非旁路副本）。
 */
const SVG_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['svg', 'rect', 'text', 'image', 'line'],
  ALLOWED_ATTR: ['xmlns', 'xmlns:xlink', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
    'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'rx', 'font-size', 'font-family',
    'preserveAspectRatio', 'xlink:href', 'href'],
  FORBID_ATTR: ['style', 'srcset'],
};
/** SVG 专用净化实例（DOMPurify(factory) 独立实例——钩子不影响 Markdown 共用的默认实例）：
 * 钩子精确封 URI 属性（仅 data:image base64 保留——外链/无引号/单双引号一律剥除）与事件属性；
 * 不用窄式 ALLOWED_URI_REGEXP（该正则会作用于全部属性值，几何值被误剥——第三十九轮实测）。 */
const svgPurifier = (() => {
  if (typeof window.DOMPurify !== 'function') return null; // 组件缺失=不渲染（fail-closed）
  try {
    const inst = window.DOMPurify(window);
    inst.addHook('uponSanitizeAttribute', (_node, data) => {
      const n = String(data.attrName ?? '').toLowerCase();
      if (n === 'href' || n === 'xlink:href' || n === 'src') {
        if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]*$/.test(String(data.attrValue ?? ''))) data.keepAttr = false;
      }
      if (/^on/.test(n)) data.keepAttr = false;
    });
    return inst;
  } catch { return null; }
})();
function sanitizeSvg(svgText) {
  if (svgPurifier == null) return null; // 组件缺失=不渲染（fail-closed）
  return svgPurifier.sanitize(String(svgText), SVG_SANITIZE_CONFIG);
}
window.__zsSanitizeSvg = sanitizeSvg;

/** 预览工具条（共享规格：复制引用/预览内搜索/行引用入草稿——版本/hash 准确，不自动发送）。 */
function wirePreviewTools(wrap, { filename, hash, revision, pre }) {
  const tools = document.createElement('div');
  tools.className = 'preview-tools';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'chip';
  copyBtn.textContent = '复制引用';
  copyBtn.title = '复制资源身份引用（文件名+版本+hash——准确锚定所见资源）';
  copyBtn.onclick = () => void (async () => {
    const ref = revision != null ? `${filename} v${revision} sha256:${String(hash).slice(0, 12)}…` : `${filename}（${String(hash).slice(0, 40)}…）`;
    await navigator.clipboard.writeText(ref);
    showError(`已复制引用：${ref}`);
  })().catch((e) => showError(`复制失败：${e.message}`));
  tools.append(copyBtn);
  if (pre != null) {
    // 预览内搜索：定位首个匹配行并高亮（行号 = pre 内 data-line 序）。
    const search = document.createElement('input');
    search.className = 'preview-search';
    search.placeholder = '预览内搜索…';
    search.id = 'preview-search';
    const hit = document.createElement('span');
    hit.className = 'meta';
    hit.id = 'preview-search-hit';
    const doSearch = () => {
      const q = search.value.trim();
      for (const line of pre.querySelectorAll('.preview-line')) line.classList.remove('hit');
      if (q.length === 0) { hit.textContent = ''; return; }
      const target = [...pre.querySelectorAll('.preview-line')].find((l) => l.textContent.includes(q));
      if (target == null) { hit.textContent = `无匹配`; return; }
      target.classList.add('hit');
      target.scrollIntoView({ block: 'center' });
      hit.textContent = `第 ${target.dataset.line} 行命中`;
    };
    search.oninput = () => doSearch();
    tools.append(search, hit);
  }
  wrap.prepend(tools);
}

/** 文本 pre 按行结构化（行号+行引用入草稿——点击行号把引用插入当前输入框，不发送）。 */
function structurePreviewLines(pre, filename) {
  const lines = pre.textContent.split(String.fromCharCode(10));
  pre.textContent = '';
  lines.forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'preview-line';
    row.dataset.line = String(i + 1);
    const no = document.createElement('span');
    no.className = 'preview-line-no';
    no.textContent = String(i + 1);
    no.title = '点击把行引用插入当前输入框（仅草稿——不发送）';
    no.onclick = () => {
      const input = currentView() === 'dm' ? el('dm-input') : el('composer-input');
      if (input == null) return;
      const quote = `> ${filename}:L${i + 1} ${text.trim().slice(0, 60)}`;
      input.value = input.value.length > 0 ? `${input.value}${String.fromCharCode(10)}${quote}` : quote;
      input.focus();
      showError(`已插入行引用（草稿）：${filename}:L${i + 1}`);
    };
    const span = document.createElement('span');
    span.textContent = text.length === 0 ? ' ' : text;
    row.append(no, span);
    pre.append(row);
  });
}

/** 已打开表情层的消息集（第三十一轮二）：轮询重绘 replaceChildren 会拆层——以消息 id
 * 记忆开层状态，重绘后自动重建（点击/刷新不丢交互层）。 */
const openEmojiLayers = new Set();

/** 消息操作组（第三十轮六；第三十一轮二接线渲染链）：复制/引用/表情（惰性拉取计数）。 */
function attachMsgActions(div, message) {
  const bodyText = (() => { try { return (JSON.parse(message.body_json) ?? {}).text ?? ''; } catch { return ''; } })();
  const actions = document.createElement('span');
  actions.className = 'msg-actions';
  const mk = (label, title, onclick) => {
    const b = document.createElement('button');
    b.className = 'msg-action';
    b.textContent = label;
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  actions.append(
    mk('复制', '复制消息正文', () => void navigator.clipboard.writeText(bodyText).then(() => showError('已复制消息正文'), (e) => showError(`复制失败：${e.message}`))),
    mk('引用', '把引用插入当前输入框（草稿——不发送）', () => {
      const input = currentView() === 'dm' ? el('dm-input') : el('composer-input');
      if (input == null) return;
      const quote = `> ${bodyText.split(String.fromCharCode(10))[0]?.slice(0, 80) ?? ''}`;
      input.value = input.value.length > 0 ? `${input.value}${String.fromCharCode(10)}${quote}` : quote;
      input.focus();
      showError('已插入引用（草稿）');
    }),
    mk('😊', '表情反应（点击拉取/切换——本地用户操作）', () => {
      const existing = div.querySelector('.msg-emoji-layer');
      if (existing != null && !existing.classList.contains('hidden')) { existing.classList.add('hidden'); openEmojiLayers.delete(message.id); return; }
      openEmojiLayers.add(message.id);
      void buildEmojiLayer(div, message);
    }),
  );
  div.prepend(actions);
  if (openEmojiLayers.has(message.id)) void buildEmojiLayer(div, message); // 重绘重建（轮询不拆交互层）
}

async function buildEmojiLayer(div, message) {
  let layer = div.querySelector('.msg-emoji-layer');
  if (layer == null) {
    layer = document.createElement('div');
    layer.className = 'msg-emoji-layer';
    div.append(layer);
  }
  layer.classList.remove('hidden');
  layer.textContent = '';
  const reactions = await command('message.reactions', { messageId: message.id }).catch(() => null);
  for (const r of reactions?.items ?? []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${r.emoji}${r.mine ? '（我）' : ''}`;
    layer.append(chip);
  }
  for (const emoji of ['👍', '❤️', '😂', '🎉', '👀', '⚠️']) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = emoji;
    b.onclick = () => void (async () => {
      const r = await command('message.react', { messageId: message.id, emoji });
      showError(r.reacted ? `已回应 ${emoji}` : `已取消 ${emoji}`);
      layer?.remove();
      openEmojiLayers.delete(message.id);
    })().catch((e) => showError(`回应失败：${e.message}`));
    layer.append(b);
  }
}

// ---------- Activity 流（DEV-18 剩余，第三十轮六）----------
let activityVisible = false;
async function renderActivity(more = false) {
  const box = el('activity-list');
  if (box == null || !activityVisible) return;
  const scope = el('activity-scope')?.value ?? 'all';
  // 稳定游标（第三十一轮二）：加载更多带 (before, beforeSeq) 双键——同毫秒多事件不漏。
  const cursor = more && box.dataset.cursor ? JSON.parse(box.dataset.cursor) : null;
  if (more && cursor == null) return;
  const base = scope === 'project' && state.projectId != null ? { scope: 'project', projectId: state.projectId } : { scope: 'all' };
  const data = await command('activity.list', { ...base, limit: 80, ...(cursor != null ? { before: cursor.at, beforeSeq: cursor.seq } : {}) }).catch((e) => null);
  if (data == null) { if (!more) box.textContent = `Activity 读取失败：${scope}`; return; }
  if (!more) box.textContent = '';
  const items = data.items ?? [];
  delete box.dataset.cursor;
  box.querySelector('.activity-more')?.remove();
  if (items.length === 0 && !more) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = '暂无动态。';
    box.append(empty);
    return;
  }
  const last = items.length > 0 ? items[items.length - 1] : null;
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const head = document.createElement('div');
    head.className = 'meta';
    head.textContent = `${new Date(it.at).toLocaleString()} · ${it.kindLabel} · ${it.projectName}`;
    const body = document.createElement('div');
    body.textContent = it.summary.length > 0 ? it.summary : '—';
    row.append(head, body);
    if (it.locate != null) {
      const go = document.createElement('button');
      go.className = 'chip';
      go.textContent = '定位';
      go.onclick = () => { location.hash = String(it.locate).slice(1); };
      row.append(go);
    }
    box.append(row);
  }
  if (last != null) {
    box.dataset.cursor = JSON.stringify({ at: last.at, seq: last.seq });
    if (items.length >= 80) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'chip activity-more';
      moreBtn.textContent = '加载更早';
      moreBtn.onclick = () => void renderActivity(true).catch(() => {});
      box.append(moreBtn);
    }
  }
}

// ---------- 导出（第三十轮五）----------
async function runExport(target, format, label) {
  try {
    const r = await command('export.create', { target, format });
    showError(`导出完成（${label} · ${format}）：${(r.files ?? []).length} 个文件——${r.dir}`);
    const open = el('export-open-last');
    if (open != null) {
      open.classList.remove('hidden');
      open.onclick = () => void window.zs.openPath(r.dir).catch((e) => showError(`打开目录失败：${e.message}`));
    }
  } catch (e) { showError(`导出失败：${e.message}`); }
}
function wireExportControls() {
  const threadBtn = el('thread-export-btn');
  if (threadBtn != null) {
    threadBtn.onclick = () => {
      if (state.openThreadId == null || state.projectId == null || state.conversationId == null) { showError('仅线程视图可导出线程'); return; }
      void runExport({ kind: 'thread', projectId: state.projectId, conversationId: state.conversationId, threadId: state.openThreadId }, (el('thread-export-format')?.value ?? 'md'), '线程');
    };
  }
  const dmBtn = el('dm-export-btn');
  if (dmBtn != null) {
    dmBtn.onclick = () => {
      if (state.openDmId == null || state.projectId == null) { showError('仅私信视图可导出会话'); return; }
      void runExport({ kind: 'conversation', projectId: state.projectId, conversationId: state.openDmId }, (el('dm-export-format')?.value ?? 'md'), '私信会话');
    };
  }
}

/** 共享文本预览（草稿芯片与已发消息附件共用）：previewText 服务端已做 audience+完整性
 * （sha256 实际字节核对+实际存储根校验）+字节截断——这里只呈现原始大小/提取大小/截断事实
 * 与全文。附基础评论区（第二十七轮六；第二十八轮三版本绑定）：行号/选区/正文提交
 * expectedHash/expectedRevision（**用户实际看到的版本**——服务端事务内核对，版本已变=
 * VERSION_CONFLICT 不悄悄锚最新）；资源已更新的旧评论明确标旧（stale 同比 hash 与 revision
 * ——行号锚点不漂移到新版）。 */
async function previewAttachment(attachmentId, filename, kindHint) {
  const myGen = ++previewGeneration;
  // 第四十一轮 §3：新轮启动即回收旧轮资源（在途 abort+viewer dispose）——旧 viewer 不得被
  // 新轮指针覆盖后遗失；迟到旧轮只清理自身（见各 alive 门）。
  releaseActivePreviewResources();
  const alive = () => myGen === previewGeneration;
  const originView = currentView(); // 来源会话快照（受限资源标注）
  if (kindHint === 'pdf_file') {
    // PDF 预览（第二十八轮五→第二十九轮三）：分页文本层 + **视觉页面渲染（受限预览侧
    // 浏览器 canvas——zsres 特权协议下加载随包 pdfjs ESM；服务端零像素解码）**；扫描件
    // 无文本=如实空页但**像素可见**；OCR 单列未实现。原件字节每次打开取一次（includeBytes），
    // 翻页/缩放在渲染器本地完成（预览读操作零新增运行）。
    const pdf = await command('attachment.previewPdf', { attachmentId, page: 1, includeBytes: true });
    if (!alive()) return;
    const pbox = el('attach-preview');
    if (pbox == null) { showError(`PDF 预览（${pdf.filename ?? filename}）：共 ${pdf.totalPages} 页——容器缺失`); return; }
    showAttachPreviewPanel();
    const bytesKey = `${attachmentId}:${pdf.hash}:v${pdf.revision}`;
    if (pdf.bytesBase64 != null) {
      pdfBytesCache.set(bytesKey, pdf.bytesBase64); // 最近 2 份（内存有界）
      for (const k of [...pdfBytesCache.keys()]) if (pdfBytesCache.size > 2 && k !== bytesKey) pdfBytesCache.delete(k);
    }
    let pdfDocPromise = null;
    let zoomMode = 'fit';
    const getPdfDoc = async () => {
      if (pdfDocPromise == null) {
        const b64 = pdfBytesCache.get(bytesKey);
        if (b64 == null) throw new Error('原件字节不可用（includeBytes 未取到——重新打开预览）');
        const lib = await loadRendererPdfjs();
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
        pdfDocPromise = lib.getDocument({ data: u8, isEvalSupported: false }).promise;
      }
      return pdfDocPromise;
    };
    const renderVisual = async (pageNo, canvas) => {
      canvas.dataset.state = 'pending';
      canvas.dataset.page = String(pageNo);
      try {
        const doc = await getPdfDoc();
        if (!alive()) return;
        const pageNum = Math.min(Math.max(pageNo, 1), doc.numPages);
        const page = await doc.getPage(pageNum);
        if (!alive()) return;
        const base = page.getViewport({ scale: 1 });
        const scale = zoomMode === 'fit' ? Math.min(1.25, 680 / base.width) : Number(zoomMode);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        canvas.dataset.state = 'rendered';
      } catch (e) {
        canvas.dataset.state = 'failed';
        canvas.dataset.error = String(e?.message ?? e).slice(0, 160);
      }
    };
    const renderPage = (pg) => {
      if (!alive()) return;
      const wrapP = document.createElement('div');
      const head2 = document.createElement('div');
      head2.className = 'meta';
      head2.textContent = `📄 ${pdf.filename ?? filename} · 共 ${pdf.totalPages} 页 · 第 ${pg.page} 页 · sha256=${pdf.hash.slice(0, 12)}… · v${pdf.revision} · 来源：${originView === 'dm' ? '私信会话' : originView === 'thread' ? '任务线程' : '主池'}`;
      const nav = document.createElement('div');
      nav.className = 'attach-preview-nav';
      const prev = document.createElement('button');
      prev.className = 'chip';
      prev.textContent = '← 前页';
      prev.disabled = pg.page <= 1;
      prev.onclick = () => void refreshPdf(pg.page - 1);
      const next = document.createElement('button');
      next.className = 'chip';
      next.textContent = '后页 →';
      next.disabled = pg.page >= pdf.totalPages;
      next.onclick = () => void refreshPdf(pg.page + 1);
      const zoom = document.createElement('select');
      zoom.className = 'pdf-zoom';
      for (const [v, label] of [['fit', '适应宽'], ['1', '100%'], ['1.5', '150%']]) {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = label;
        if (v === zoomMode) opt.selected = true;
        zoom.append(opt);
      }
      zoom.onchange = () => { zoomMode = zoom.value; void renderVisual(pg.page, canvas); };
      const closeP = document.createElement('button');
      closeP.className = 'chip';
      closeP.textContent = '关闭预览';
      closeP.onclick = () => closeAttachPreview();
      nav.append(prev, next, zoom, closeP);
      const canvas = document.createElement('canvas');
      canvas.id = 'pdf-visual-canvas';
      canvas.className = 'pdf-visual-canvas';
      void renderVisual(pg.page, canvas); // 视觉层异步（文本层先呈现——不互相阻塞）
      const pre = document.createElement('pre');
      pre.className = 'attach-preview-text';
      pre.textContent = pg.text.length === 0 ? '（本页无文本层——可能是扫描件；OCR 未实现，如实空页；页面像素见上方视觉渲染）' : pg.text;
      const note = document.createElement('div');
      note.className = 'meta';
      note.textContent = `视觉渲染：浏览器 canvas（受限预览侧——服务端零像素解码） · OCR：未实现 · 截断：${pg.truncated ? '本页提取文本超 64KB 已截断' : '无'} · 解析器：${pdf.parser ?? '?'} · 提取时刻：${new Date(pdf.extractedAt).toLocaleString()}`;
      wrapP.append(head2, nav, canvas, pre, note);
      pbox.replaceChildren(wrapP);
    };
    const refreshPdf = async (pageNo) => {
      const pg = await command('attachment.previewPdf', { attachmentId, page: pageNo }).catch(() => null);
      if (pg == null || !alive()) return;
      renderPage(pg);
    };
    renderPage(pdf);
    return;
  }
  if (kindHint === 'image_file') {
    // 图片预览（第二十八轮四→第二十九轮三）：previewImage（audience+实根+原件核对）→ <img>
    // 渲染（浏览器沙箱解码）。**格式头通过≠像素解码成功**——解码结果如实记录（data-decode
    // ok/failed + naturalWidth 与服务端头部宽高对账）；OCR=未实现、模型图片输入=未认证。
    const img = await command('attachment.previewImage', { attachmentId });
    if (!alive()) return;
    const ibox = el('attach-preview');
    if (ibox == null) { showError(`图片预览（${img.filename ?? filename}）：${img.width}×${img.height} ${img.bytes}B——页面容器缺失`); return; }
    showAttachPreviewPanel();
    const ihead = document.createElement('div');
    ihead.className = 'meta';
    ihead.textContent = `🖼 ${img.filename ?? filename} · ${img.mime} · 声明 ${img.width}×${img.height} · 原件 ${img.bytes}B · sha256=${img.hash.slice(0, 12)}… · v${img.revision} · 来源：${originView === 'dm' ? '私信会话' : originView === 'thread' ? '任务线程' : '主池'}`;
    const iclose = document.createElement('button');
    iclose.className = 'chip';
    iclose.textContent = '关闭预览';
    iclose.onclick = () => closeAttachPreview();
    const iel2 = document.createElement('img');
    iel2.id = 'image-preview-img';
    iel2.src = img.dataUrl;
    iel2.alt = img.filename ?? '图片附件';
    iel2.style.maxWidth = '100%';
    iel2.style.maxHeight = '280px';
    iel2.dataset.decode = 'pending';
    iel2.dataset.declaredWidth = String(img.width);
    iel2.onload = () => { iel2.dataset.naturalWidth = String(iel2.naturalWidth); iel2.dataset.match = String(iel2.naturalWidth === img.width); };
    // 解码结果以 decode() Promise 为准（规范：不可解码即 reject——比 onerror/元素存在更可靠；
    // 格式头通过≠像素可解码，第二十九轮三）。
    iel2.decode().then(
      () => { iel2.dataset.decode = 'ok'; },
      (e) => {
        iel2.dataset.decode = 'failed';
        iel2.dataset.decodeError = String(e?.message ?? e).slice(0, 120);
        const failNote = document.createElement('div');
        failNote.className = 'meta img-decode-failed';
        failNote.textContent = `像素解码失败（浏览器）——原件完整保存且 sha256 已核对，但格式头通过不等于像素可解码（截断/损坏体）；OCR 与模型图片输入均不可用`;
        iel2.replaceWith(failNote);
      },
    );
    iel2.onerror = () => { iel2.dataset.decode = 'failed'; };
    const inote = document.createElement('div');
    inote.className = 'meta';
    inote.textContent = 'OCR 提取正文：未实现（明确不可用）· 模型图片输入：未认证（发送需明确选择仅发送文字——程序不悄悄省略图片冒充已读）· 图片评论：随分批归属后续开放';
    const iwrap = document.createElement('div');
    iwrap.append(ihead, iclose, iel2, inote);
    ibox.replaceChildren(iwrap);
    return;
  }
  if (kindHint === 'docx_file' || kindHint === 'sheet_file' || kindHint === 'slides_file') {
    // Office 预览（第二十九轮四建立；第四十轮·选型决定 A 增视觉通道）：DOCX=docx-preview
    // 视觉（失败回退白名单净化 HTML）；表格=sheet 分页签+预览窗口+注入范围；PPTX=按页文字
    // 卡片（模型输入真源）+ pptx-renderer 渲染器侧视觉页。宏不执行/公式只读缓存值/外部关系
    // 不加载；字节经 previewOffice includeBytes（audience+实根+sha256+20MiB 前置上限）。
    const doc = await command('attachment.previewOffice', { attachmentId, includeBytes: true });
    if (!alive()) return;
    const obox = el('attach-preview');
    if (obox == null) { showError(`Office 预览（${doc.filename ?? filename}）——页面容器缺失`); return; }
    showAttachPreviewPanel();
    const owrap = document.createElement('div');
    const ohead = document.createElement('div');
    ohead.className = 'meta';
    const kindLabel = doc.kind === 'docx_file' ? 'DOCX 文档' : doc.kind === 'sheet_file' ? `表格（${doc.sourceFormat === 'csv' ? `CSV · ${doc.encoding}` : 'XLSX'}）` : 'PPTX 幻灯片';
    ohead.textContent = `📘 ${doc.filename ?? filename} · ${kindLabel} · sha256=${doc.hash.slice(0, 12)}… · v${doc.revision} · 来源：${originView === 'dm' ? '私信会话' : originView === 'thread' ? '任务线程' : '主池'} · 解析器 ${doc.parser}`;
    const oclose = document.createElement('button');
    oclose.className = 'chip';
    oclose.textContent = '关闭预览';
    oclose.onclick = () => closeAttachPreview();
    owrap.append(ohead, oclose);
    if (doc.kind === 'docx_file') {
      // 视觉预览（第四十轮·选型 A；第四十一轮 §4 隔离修订）：docx-preview 渲染进 **Shadow DOM**
      // （attachShadow open 根=真正的 CSS 边界——文档 <style> 的选择器无法越出 shadow，宿主
      // 控件样式也不受文档 CSS 影响；「style 节点位于 div 内」不构成隔离——复核实证 styleId
      // 含逗号可命中预览外控件）。嵌入 HTML（altChunks）首版不支持：显式 renderAltChunks:false
      // （不创建无 sandbox 的 iframe.srcdoc）；失败回退白名单净化 HTML（通道保留）。
      if (doc.visualBytesAvailable === true && doc.bytesBase64 != null) {
        try {
          const dx = await loadRendererDocxPreview();
          if (!alive()) return;
          const dvBox = document.createElement('div');
          dvBox.className = 'docx-visual-box';
          const shadowHost = document.createElement('div');
          shadowHost.className = 'docx-visual-shadow-host';
          dvBox.append(shadowHost);
          const shadow = shadowHost.attachShadow({ mode: 'open' });
          const shadowStyle = document.createElement('style');
          shadowStyle.textContent = '.docx-wrapper{background:#fff;padding:0;}.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(15,23,42,.12);margin-bottom:8px;padding:10px 14px;}table{border-collapse:collapse;}td,th{border:1px solid #c8ccd4;padding:2px 8px;font-size:12px;}';
          shadow.append(shadowStyle);
          await dx.renderAsync(base64ToBytes(doc.bytesBase64), shadow, shadow, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, breakPages: true, useBase64URL: true, experimental: true, renderAltChunks: false });
          if (!alive()) { dvBox.remove(); return; }
          const dvHead = document.createElement('div');
          dvHead.className = 'meta';
          dvHead.textContent = `🖼 视觉预览（docx-preview 渲染器侧本地渲染·Shadow DOM 隔离）· sha256=${doc.hash.slice(0, 12)}… · v${doc.revision}（与提取文本同源核验）`;
          // 如实分列（第四十二轮 §4）：嵌入 HTML 首版不支持、外部资源不加载——呈现给用户，
          // 不在验证报告里替产品声明未验证的能力。
          const dvNote = document.createElement('div');
          dvNote.className = 'meta';
          dvNote.textContent = '嵌入 HTML（altChunks）首版不支持（renderAltChunks:false）· 外部图片/资源不加载（仅包内媒体）· 页眉页脚尽力还原';
          owrap.append(dvHead, dvNote, dvBox);
        } catch (e) {
          const w = document.createElement('div');
          w.className = 'meta warn';
          w.textContent = `视觉预览不可用（${String(e?.message ?? e).slice(0, 160)}）——下方净化排版近似仍可用（分列）`;
          owrap.append(w);
        }
      }
      const htmlBox = document.createElement('div');
      htmlBox.className = 'office-docx-html';
      htmlBox.innerHTML = doc.html; // 服务端白名单净化（无 href/无事件属性）；下面再剥一次属性
      for (const elx of htmlBox.querySelectorAll('*')) {
        for (const attr of [...elx.attributes]) {
          if (!(elx.tagName === 'TD' && (attr.name === 'colspan' || attr.name === 'rowspan'))) elx.removeAttribute(attr.name);
        }
      }
      const note = document.createElement('div');
      note.className = 'meta';
      note.textContent = `净化排版近似（白名单标记——上方视觉预览失败时的回退通道）· 段落 ${doc.paragraphCount}${doc.htmlTruncated ? ' · HTML 超预算已截断' : ''}${doc.truncatedTotal ? ' · 提取文本超预算已截断（注入同口径）' : ''} · 外部关系不加载、嵌入图片不解码、宏不执行 · 版式丢失如实说明（不虚构分页） · 模型输入=提取文本`;
      owrap.append(htmlBox, note);
    } else if (doc.kind === 'sheet_file') {
      const tabs = document.createElement('div');
      tabs.className = 'sheet-tabs';
      const gridBox = document.createElement('div');
      const drawSheet = (sheet) => {
        const tbl = document.createElement('table');
        tbl.className = 'sheet-grid';
        const win = document.createElement('div');
        win.className = 'meta';
        win.textContent = `工作表「${sheet.name}」· 实际 ${sheet.rowCount}×${sheet.colCount} · 预览窗口 ${sheet.cells.length}×${sheet.cells[0]?.length ?? 0}${sheet.rowTruncated || sheet.colTruncated ? '（窗口外未呈现——不虚构成空表）' : ''}${sheet.merges.length > 0 ? ` · 合并单元格 ${sheet.merges.length} 处` : ''}${sheet.formulaMissing ? ' · ⚠ 存在无缓存值的公式格（公式不执行——如实占位）' : ''}`;
        const cap = Math.ceil(sheet.colCount / 26) > 1 ? 'A' : 'A';
        void cap;
        for (let r = 0; r < sheet.cells.length; r += 1) {
          const tr = document.createElement('tr');
          const th = document.createElement('th');
          th.textContent = String(r + 1);
          tr.append(th);
          for (const cell of sheet.cells[r]) {
            const td = document.createElement('td');
            td.textContent = cell;
            tr.append(td);
          }
          tbl.append(tr);
        }
        gridBox.replaceChildren(win, tbl);
      };
      doc.sheets.forEach((sheet, idx) => {
        const tab = document.createElement('button');
        tab.className = 'chip';
        tab.textContent = sheet.name;
        if (idx === 0) tab.classList.add('on');
        tab.onclick = () => { for (const t of tabs.children) t.classList.remove('on'); tab.classList.add('on'); drawSheet(sheet); };
        tabs.append(tab);
      });
      drawSheet(doc.sheets[0]);
      // 注入范围选择：写回草稿条目（仅该附件仍在当前草稿时可设）。
      const rangeRow = document.createElement('div');
      rangeRow.className = 'sheet-range-row';
      const rangeInput = document.createElement('input');
      rangeInput.id = 'sheet-range-input';
      rangeInput.placeholder = '注入范围，如 Sheet1!A1:D20（留空=有界默认窗口）';
      const rangeBtn = document.createElement('button');
      rangeBtn.className = 'chip';
      rangeBtn.textContent = '设为注入范围';
      const rangeNote = document.createElement('span');
      rangeNote.className = 'meta';
      rangeNote.id = 'sheet-range-note';
      const currentDraftEntry = () => {
        for (const [, list] of draftAttachments) {
          const hit = list.find((a) => a.attachmentId === attachmentId);
          if (hit != null) return hit;
        }
        return null;
      };
      const existing = currentDraftEntry();
      if (existing != null && existing.range != null) { rangeInput.value = existing.range; rangeNote.textContent = `当前注入范围：${existing.range}`; }
      rangeBtn.onclick = () => {
        const entry = currentDraftEntry();
        const spec = rangeInput.value.trim();
        if (entry == null) { rangeNote.textContent = '该附件不在当前草稿（已发送/其他会话）——范围仅对随消息发送的草稿附件生效'; return; }
        if (spec.length === 0) { delete entry.range; rangeNote.textContent = '已清除范围（发送按有界默认窗口注入）'; }
        else { entry.range = spec; rangeNote.textContent = `注入范围已设：${spec}（提交时服务端校验边界）`; }
        renderAttachChips(state.openDmId != null && currentView() === 'dm' ? 'dm' : 'composer');
      };
      rangeRow.append(rangeInput, rangeBtn, rangeNote);
      const note = document.createElement('div');
      note.className = 'meta';
      note.textContent = `公式不执行（仅缓存值，缺失如实占位）· 注入=范围窗口（默认首表 50×16——不把全部工作表无界发送）${doc.truncatedTotal ? ' · 提取超预算已截断' : ''}`;
      owrap.append(tabs, gridBox, rangeRow, note);
    } else {
      // PPTX 双通道（第三十七轮四）：**提取文本**卡片列表（previewOffice——模型输入真源）+
      // **静态页预览**（previewSlidesPages：幻灯片列表/当前页 SVG/缩放——版面近似）分列。
      const listBox = document.createElement('div');
      listBox.className = 'slides-list';
      for (const sl of doc.slides) {
        const card = document.createElement('div');
        card.className = 'slide-card';
        const head3 = document.createElement('div');
        head3.className = 'meta';
        head3.textContent = `幻灯片 ${sl.slide}${sl.truncated ? '（本页文本超预算已截断）' : ''}`;
        const body3 = document.createElement('pre');
        body3.className = 'attach-preview-text';
        body3.textContent = sl.text.length === 0 ? '（本页无文字）' : sl.text;
        card.append(head3, body3);
        if (sl.notes.trim().length > 0) {
          const notes = document.createElement('div');
          notes.className = 'meta';
          notes.textContent = `备注：${sl.notes}`;
          card.append(notes);
        }
        listBox.append(card);
      }
      const note = document.createElement('div');
      note.className = 'meta';
      note.textContent = `按页保留文字与备注（顺序=幻灯片编号）· 提取文本=模型输入真源 · 模型输入=提取文本`;
      owrap.append(listBox, note);
      // ---- 视觉页预览（第四十轮·选型决定 A）：pptx-renderer 渲染器侧本地渲染 ----
      // 原件字节经 previewOffice includeBytes（audience+实根+sha256 核验+20MiB 前置上限）；
      // RECOMMENDED_ZIP_LIMITS=不受信输入 ZIP 限额；EMF/内嵌 PDF 回退**显式关闭**（pdfjs:
      // false——不升级既有 PDF.js 4.10 链）；打开期 AbortController+viewer 归属本面板
      // （关闭/切会话即中止+dispose——迟到结果不重开面板）；页渲染失败如实标注不静默。
      // 旧「静态 SVG 版面近似」通道已由本视觉通道替代（第三十八轮四的受控 SVG 预览退役，
      // 后端 previewSlidesPages 命令保留供兼容）。
      if (doc.visualBytesAvailable === true && doc.bytesBase64 != null) {
        try {
          const lib = await loadRendererPptx();
          if (!alive()) return;
          const ctl = new AbortController();
          activePreviewAbort = ctl;
          const stage = document.createElement('div');
          stage.className = 'pptx-visual-stage';
          const vwrap = document.createElement('div');
          vwrap.className = 'slides-pages';
          const vhead = document.createElement('div');
          vhead.className = 'meta';
          vhead.textContent = `🖼 视觉页预览（pptx-renderer 渲染器侧本地渲染）· sha256=${doc.hash.slice(0, 12)}… · v${doc.revision}（与提取文本同源核验）`;
          const zoomRow = document.createElement('div');
          zoomRow.className = 'git-row';
          const prevBtn = document.createElement('button');
          prevBtn.className = 'chip';
          prevBtn.textContent = '◀ 上一页';
          const nextBtn = document.createElement('button');
          nextBtn.className = 'chip';
          nextBtn.textContent = '下一页 ▶';
          const pageLabel = document.createElement('span');
          pageLabel.className = 'meta';
          const zoomSel = document.createElement('select');
          zoomSel.className = 'pdf-zoom';
          for (const [v, label] of [['fit', '适应'], ['1', '100%'], ['1.5', '150%'], ['2', '200%']]) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = label;
            zoomSel.append(opt);
          }
          const viewer = await lib.PptxViewer.open(base64ToBytes(doc.bytesBase64), stage, {
            renderMode: 'slide',
            zipLimits: lib.RECOMMENDED_ZIP_LIMITS,
            pdfjs: false,
            signal: ctl.signal,
          });
          if (!alive()) { try { viewer.dispose(); } catch (e) { /* 已释放 */ } return; }
          activePptxViewer = viewer;
          activePreviewAbort = null;
          viewer.addEventListener('slideerror', (ev) => {
            const idx = (ev.detail?.index ?? 0) + 1;
            pageLabel.textContent = `${pageLabel.textContent} · ⚠ 第 ${idx} 页渲染失败`;
          });
          let pageNo = 1;
          const syncLabel = () => { pageLabel.textContent = `第 ${pageNo}/${viewer.slideCount} 页 · 缩放 ${viewer.zoomPercent}%`; };
          const show = async (n) => {
            const target = Math.min(Math.max(n, 1), viewer.slideCount);
            await viewer.goToSlide(target - 1);
            if (!alive()) return;
            pageNo = target;
            syncLabel();
          };
          prevBtn.onclick = () => void show(pageNo - 1);
          nextBtn.onclick = () => void show(pageNo + 1);
          zoomSel.onchange = () => {
            if (zoomSel.value === 'fit') void viewer.setFitMode('contain').then(syncLabel).catch(() => {});
            else void viewer.setZoom(Number(zoomSel.value) * 100).then(syncLabel).catch(() => {});
          };
          zoomRow.append(prevBtn, nextBtn, pageLabel, zoomSel);
          const vnote = document.createElement('div');
          vnote.className = 'meta';
          vnote.textContent = '视觉=渲染器侧（版面/图表/表格尽力还原——图表几何与 Office 渲染存在已知近似）· SmartArt/EMF 内嵌 PDF 回退未启用（如实分列）· 外部关系不加载 · 宏不执行（宏容器在保存入口已拒）· 提取文本=模型输入真源（与视觉分列）';
          vwrap.append(vhead, zoomRow, stage, vnote);
          owrap.append(vwrap);
          await show(1);
          // 迟到首屏（§3）：show 完成后代次已失——只清理自身 viewer（仍是本轮指针时），不改面板。
          if (!alive()) {
            if (activePptxViewer === viewer) { try { viewer.dispose(); } catch (e) { /* 已释放 */ } activePptxViewer = null; }
            return;
          }
        } catch (e) {
          const pnote = document.createElement('div');
          pnote.className = 'meta warn';
          pnote.textContent = `视觉页预览不可用（${String(e?.message ?? e).slice(0, 200)}）——提取文本卡片不受影响（分列）`;
          owrap.append(pnote);
        }
      } else {
        const pnote = document.createElement('div');
        pnote.className = 'meta warn';
        pnote.textContent = `视觉页预览不可用（${doc.visualBytesReason ?? '未取到原件字节'}）——提取文本卡片不受影响（分列）`;
        owrap.append(pnote);
      }
    }
    // 最终 DOM 提交前代次门（第四十一轮 §3）：迟到的任何分支不得把根内容替换成旧轮。
    // 迟到轮**不调用** releaseActivePreviewResources（那会回收新轮资源）——自身 viewer 已在
    // 分支内按「仍是本轮指针」条件清理；新轮启动时的入口释放已覆盖更早的旧资源。
    if (!alive()) return;
    obox.replaceChildren(owrap);
    return;
  }
  const r = await command('attachment.previewText', { attachmentId });
  if (!alive()) return; // 迟到作废：已关闭/被新预览取代/已切换会话——不重开不覆盖
  const box = el('attach-preview');
  if (box == null) { showError(`附件预览（${filename}）：原文 ${r.originalBytes}B${r.truncated ? `——截断，提取前 ${r.excerptBytes}B` : ''}\n${r.text.slice(0, 2000)}`); return; }
  showAttachPreviewPanel();
  const head = document.createElement('div');
  head.className = 'meta';
  head.textContent = `📎 ${r.filename ?? filename}${r.kind === 'code_file' ? '（代码）' : ''} · sha256=${r.hash.slice(0, 12)}… · v${r.revision} · 原始 ${r.originalBytes}B${r.truncated ? ` · 截断：提取前 ${r.excerptBytes}B（超 64KB 预算，按字节保留完整字符）` : ' · 全文'} · 来源：${originView === 'dm' ? '私信会话' : originView === 'thread' ? '任务线程' : '主池'}`;
  const close = document.createElement('button');
  close.className = 'chip';
  close.textContent = '关闭预览';
  close.onclick = () => closeAttachPreview();
  const content = document.createElement('pre');
  content.className = 'attach-preview-text';
  content.textContent = r.text;
  const wrap = document.createElement('div');
  wrap.append(head, close, content);
  // Markdown 安全预览（第三十轮四）：先整体转义再生成受控标签——脚本/事件属性无处出现；
  // 远程图片不加载；代码只展示。可切回纯文本。
  const displayName = String(r.filename ?? filename ?? '');
  const isMd = /\.(md|markdown)$/i.test(displayName);
  if (isMd) {
    const mdBox = document.createElement('div');
    mdBox.className = 'office-docx-html md-preview';
    mdBox.innerHTML = mdToSafeHtml(r.text);
    const mdNote = document.createElement('div');
    mdNote.className = 'meta';
    mdNote.textContent = 'Markdown 安全预览（markdown-it html:false + DOMPurify 白名单——脚本/事件属性/远程图片不加载；代码只展示）';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'chip';
    toggleBtn.textContent = '看原文';
    toggleBtn.onclick = () => {
      const showingMd = !mdBox.classList.contains('hidden');
      mdBox.classList.toggle('hidden');
      content.classList.toggle('hidden');
      toggleBtn.textContent = showingMd ? '看渲染' : '看原文';
    };
    // 原文同样行结构化（第三十一轮二：md 的预览搜索/行号引用与纯文本一致——默认隐藏）。
    content.classList.add('hidden');
    structurePreviewLines(content, displayName);
    toggleBtn.onclick = () => {
      const showingMd = !mdBox.classList.contains('hidden');
      mdBox.classList.toggle('hidden');
      content.classList.toggle('hidden');
      toggleBtn.textContent = showingMd ? '看渲染' : '看原文';
    };
    const mdWrap = document.createElement('div');
    mdWrap.append(mdNote, toggleBtn, mdBox);
    wrap.append(mdWrap);
  } else {
    structurePreviewLines(content, displayName); // 行号+行引用
  }
  wirePreviewTools(wrap, { filename: displayName, hash: r.hash, revision: r.revision, pre: content });
  // 评论区（列表 + 新增表单——expectedHash/expectedRevision 沿本次预览所见版本）。
  const comments = await command('attachment.comment.list', { attachmentId }).catch(() => null);
  if (!alive()) return; // 评论列表迟到同作废
  if (comments != null) {
    const sec = document.createElement('div');
    sec.className = 'attach-comments';
    const secHead = document.createElement('div');
    secHead.className = 'meta';
    secHead.textContent = `评论（${(comments.items ?? []).length}）——锚定评论时资源版本（提交按所见 v${r.revision} 核对）；标旧=资源已更新（行号针对旧版）`;
    sec.append(secHead);
    for (const c of comments.items ?? []) {
      const row = document.createElement('div');
      row.className = 'meta';
      const anchor = c.lineFrom != null ? `第 ${c.lineFrom}${c.lineTo != null ? `-${c.lineTo}` : ''} 行` : '';
      row.textContent = `${c.authorId.slice(0, 8)} · v${c.anchoredTo.revision}${anchor ? ` · ${anchor}` : ''}${c.stale ? ' · 【旧版评论——资源已更新，行号针对 v' + c.anchoredTo.revision + '】' : ''}${c.quote != null ? ` · 引「${c.quote.slice(0, 40)}」` : ''}：${c.body}`;
      sec.append(row);
    }
    const bodyInput = document.createElement('input');
    bodyInput.placeholder = '评论正文…';
    bodyInput.className = 'attach-comment-input';
    const fromInput = document.createElement('input');
    fromInput.placeholder = '行(起)';
    fromInput.className = 'attach-comment-line';
    const toInput = document.createElement('input');
    toInput.placeholder = '行(止)';
    toInput.className = 'attach-comment-line';
    const add = document.createElement('button');
    add.className = 'chip';
    add.textContent = '添加评论';
    add.onclick = () => void (async () => {
      const body = bodyInput.value.trim();
      if (body.length === 0) { showError('评论正文不能为空'); return; }
      const num = (v) => { const n = Number(v); return v.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : undefined; };
      try {
        // 版本绑定（第二十八轮三）：expectedHash/expectedRevision=用户实际看到的版本——
        // 服务端事务内核对；版本已变=VERSION_CONFLICT（提示刷新预览，不悄悄锚到最新版）。
        await command('attachment.comment.add', {
          attachmentId, body, expectedHash: r.hash, expectedRevision: r.revision,
          ...(num(fromInput.value) != null ? { lineFrom: num(fromInput.value) } : {}),
          ...(num(toInput.value) != null ? { lineTo: num(toInput.value) } : {}),
        });
        await previewAttachment(attachmentId, filename).catch(() => {});
      } catch (e) {
        showError(e.message.includes('版本已变化') ? `评论未保存：${e.message}` : `评论失败：${e.message}`);
      }
    })().catch(() => {});
    const form = document.createElement('div');
    form.append(bodyInput, fromInput, toInput, add);
    sec.append(form);
    wrap.append(sec);
  }
  box.replaceChildren(wrap);
}
/** 已发消息附件芯片（thread.history/conversation.history 的 attachments 摘要）：点击走
 * previewAttachment（正式 previewText——服务端 audience+完整性+截断，不拿摘要冒充已读）。 */
function appendSentAttachmentChips(div, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return;
  const row = document.createElement('div');
  row.className = 'attach-chips';
  for (const a of attachments) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `📎 ${a.filename ?? a.artifactId}`;
    chip.title = '点按预览已发副本';
    chip.onclick = () => void previewAttachment(a.artifactId, a.filename, a.kind).catch((e) => showError(`预览失败：${e.message}`));
    row.append(chip);
  }
  div.append(row);
}
function wireAttach(kind) {
  const btn = el(kind === 'dm' ? 'dm-attach' : 'composer-attach');
  const fileInput = el(kind === 'dm' ? 'dm-attach-file' : 'composer-attach-file');
  if (btn == null || fileInput == null) return;
  btn.onclick = () => fileInput.click();
  fileInput.onchange = () => void (async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file == null) return;
    // 目标先固定（发起时快照）：上传期间切换会话——回执只进发起键（第二十七轮三）。
    const targetKey = attachDraftKey(kind);
    const convId = kind === 'dm' ? state.openDmId : state.conversationId;
    if (convId == null) { showError('请先打开会话再附加文件'); return; }
    try {
      const buf = await file.arrayBuffer();
      // 判型按**文件真实字节**（file.type 由浏览器按内容嗅探——非扩展名；Office/zip 再核
      // PK 头——扩展名不作依据，服务端 magic 终审）。图片/Office/PDF=原件上传；CSV=编码
      // 探测解析；其余文本走 fatal UTF-8 严格解码（第二十九轮四扩 Office 三类与 CSV）。
      const lower = file.name.toLowerCase();
      const isImage = (file.type || '').startsWith('image/');
      const isPdf = file.type === 'application/pdf' || (lower.endsWith('.pdf') && file.type === '');
      const head4 = new Uint8Array(buf.slice(0, 4));
      const isZip = head4[0] === 0x50 && head4[1] === 0x4b;
      const isOffice = isZip && (lower.endsWith('.docx') || lower.endsWith('.xlsx') || lower.endsWith('.pptx') || (file.type || '').includes('officedocument'));
      const isCsv = lower.endsWith('.csv') && !isZip;
      let r;
      let kindHint = 'text_file';
      if (isImage || isPdf || isOffice || isCsv) {
        let bin = '';
        const u8 = new Uint8Array(buf);
        for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        const method = isPdf ? 'attachment.uploadPdf' : isImage ? 'attachment.uploadImage' : isOffice ? 'attachment.uploadOffice' : 'attachment.uploadCsv';
        r = await command(method, { conversationId: convId, filename: file.name, contentBase64: btoa(bin) });
        kindHint = isPdf ? 'pdf_file' : isImage ? 'image_file' : isOffice ? (r.slides != null ? 'slides_file' : r.sheets != null || r.sourceFormat === 'csv' ? 'sheet_file' : 'docx_file') : 'sheet_file';
      } else {
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch { showError(`「${file.name}」不是有效 UTF-8 文本——文本按明确规则拒绝（图片选 PNG/JPEG/GIF/WebP；Office 选 .docx/.xlsx/.pptx；表格文本选 .csv）`); return; }
        r = await command('attachment.uploadText', { conversationId: convId, filename: file.name, content });
        kindHint = 'text_file';
      }
      if (!draftAttachments.has(targetKey)) draftAttachments.set(targetKey, []);
      draftAttachments.get(targetKey).push({ attachmentId: r.attachmentId, filename: file.name, hash: r.hash, truncated: r.truncated, kind: kindHint });
      if (attachDraftKey(kind) === targetKey) renderAttachChips(kind); // 仍在发起目标才重绘
      const extra = r.pages != null ? `（${r.pages} 页——提取文本已缓存）` : r.width != null ? `（${r.width}×${r.height}）` : r.slides != null ? `（${r.slides} 页幻灯片）` : r.sheets != null ? `（${r.sheets} 个工作表${r.sourceFormat === 'csv' ? ` · ${r.encoding}` : ''}）` : r.paragraphCount != null ? `（${r.paragraphCount} 段）` : '';
      showError(`附件已保存副本：${file.name}${r.truncated ? '（超预算——预览/注入将按口径截断）' : extra}`);
    } catch (e) { showError(`附件上传失败：${e.message}`); }
  })().catch(() => {});
}

// ---------- DEV-19 看板与协作视图首包（第二十六轮四）----------
// 只读聚合：board.view——状态分列（waiting/running/review/blocked/stopped；退出未确认如实
// 标注）；卡片点击 #task= 定位原串；打开看板零运行零唤醒。协作视图=thread.collaborators
// 四列（人的关注/Agent 跟进/冻结参与者/实时执行）在线程头部行内呈现。
const BOARD_COLUMNS = [
  { key: 'waiting', label: '等待' },
  { key: 'running', label: '执行中' },
  { key: 'review', label: '待验收' },
  { key: 'blocked', label: '阻塞' },
  { key: 'stopped', label: '停止' },
  { key: 'done', label: '已完成' },
];
let boardVisible = false;
async function renderBoard() {
  const box = el('board-groups');
  if (box == null || !boardVisible) return;
  const scope = el('board-scope')?.value ?? 'project';
  let data;
  try { data = await command('board.view', scope === 'project' && state.projectId != null ? { scope: 'project', projectId: state.projectId } : { scope: 'all' }); } catch (e) { showError(`看板读取失败：${e.message}`); return; }
  const frag = document.createDocumentFragment();
  for (const g of data.groups ?? []) {
    const gEl = document.createElement('div');
    gEl.className = 'board-group';
    const gHead = document.createElement('div');
    gHead.className = 'sidebar-sec';
    gHead.textContent = `项目：${g.displayName}`;
    gEl.append(gHead);
      for (const room of g.rooms ?? []) {
        const rEl = document.createElement('div');
        rEl.className = 'board-room';
        const rHead = document.createElement('div');
        rHead.className = 'meta';
        rHead.textContent = `房间：${room.name}（${room.roomId.slice(0, 8)}）`;
        rEl.append(rHead);
        const cols = document.createElement('div');
        cols.className = 'board-cols';
        for (const col of BOARD_COLUMNS) {
          const colEl = document.createElement('div');
          colEl.className = 'board-col';
          const colHead = document.createElement('div');
          colHead.className = 'meta';
          const cards = (room.cards ?? []).filter((c) => c.column === col.key);
          colHead.textContent = `${col.label}（${cards.length}）`;
          colEl.append(colHead);
          for (const c of cards) {
            // 卡片=定位；动作行=**已有正式命令**（第二十七轮五）：停止（task.stop——run 在途才
            // 可用）/通过验收（task.review——绑定展示时 deliveryId/revision/manifestHash）。闭包
            // 钉死卡片快照的 task/run/交付版本——刷新重绘换的是新节点，本按钮目标不变。未有
            // 命令的动作不出现（不摆不可用按钮）；返工需意见——走线程内验收入口。
            const wrap = document.createElement('div');
            wrap.className = 'board-card-wrap';
            const card = document.createElement('button');
            card.className = 'board-card' + (c.exitUnconfirmed ? ' exit-unknown' : '');
            card.textContent = `${c.title}${c.exitUnconfirmed ? '（退出未确认）' : ''}${c.pendingDelivery != null ? `（待验收 v${c.pendingDelivery.revision}）` : ''}`;
            card.title = `taskId=${c.taskId} · ${c.taskStatus}${c.runStatus != null ? ` · run=${c.runStatus}` : ''}——点击定位原串`;
            card.onclick = () => { if (c.locate != null) location.hash = String(c.locate).slice(1); };
            wrap.append(card);
            if (c.runId != null && ['RUNNING', 'WAITING', 'QUEUED'].includes(c.runStatus)) {
              const stop = document.createElement('button');
              stop.className = 'chip';
              stop.textContent = '停止';
              stop.title = `task.stop（run=${c.runId.slice(0, 8)}…，停止代次 ${c.stopGeneration ?? 0}）`;
              stop.onclick = () => void (async () => {
                stop.disabled = true;
                try {
                  await command('task.stop', { taskId: c.taskId, targetRunId: c.runId, expectedStopGeneration: c.stopGeneration ?? 0 });
                  showError('停止请求已提交（终态由轮询推进）');
                } catch (e) { showError(`停止失败：${e.message}`); stop.disabled = false; }
                await renderBoard().catch(() => {});
              })().catch(() => {});
              wrap.append(stop);
            }
            if (c.taskStatus === 'REVIEW' && c.pendingDelivery != null) {
              const accept = document.createElement('button');
              accept.className = 'chip';
              accept.textContent = '通过验收';
              accept.title = `task.review accept（交付 ${c.pendingDelivery.deliveryId.slice(0, 8)}… v${c.pendingDelivery.revision}；返工需意见——线程内）`;
              accept.onclick = () => void (async () => {
                accept.disabled = true;
                try {
                  const r = await command('task.review', { taskId: c.taskId, deliveryId: c.pendingDelivery.deliveryId, deliveryRevision: c.pendingDelivery.revision, manifestHash: c.pendingDelivery.manifestHash, decision: 'accept' });
                  showError(`验收通过：交付 v${r.deliveryRevision ?? c.pendingDelivery.revision}——任务 ${r.taskStatusAfter ?? ''}`);
                } catch (e) { showError(`验收失败：${e.message}`); accept.disabled = false; }
                await renderBoard().catch(() => {});
              })().catch(() => {});
              wrap.append(accept);
            }
            colEl.append(wrap);
          }
          cols.append(colEl);
        }
        rEl.append(cols);
        gEl.append(rEl);
      }
    frag.append(gEl);
  }
  if (frag.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = '暂无任务卡。';
    frag.append(empty);
  }
  box.replaceChildren(frag);
}
// ---------- DEV-19 Files 集合（第二十七轮五）：四类分列只读（files.view）----------
let filesVisible = false;
async function renderFiles() {
  const box = el('files-groups');
  if (box == null || !filesVisible) return;
  const scope = el('files-scope')?.value ?? 'project';
  let data;
  try { data = await command('files.view', scope === 'project' && state.projectId != null ? { scope: 'project', projectId: state.projectId } : { scope: 'all' }); } catch (e) { showError(`Files 读取失败：${e.message}`); return; }
  const frag = document.createDocumentFragment();
  for (const g of data.groups ?? []) {
    const gEl = document.createElement('div');
    gEl.className = 'board-group';
    const gHead = document.createElement('div');
    gHead.className = 'sidebar-sec';
    gHead.textContent = `项目：${g.displayName}`;
    gEl.append(gHead);
    const mkRow = (label, text, locate, title) => {
      const row = document.createElement('button');
      row.className = 'chip';
      row.textContent = text;
      row.title = title ?? text;
      if (locate != null) row.onclick = () => { location.hash = String(locate).slice(1); };
      else { row.disabled = true; row.title = `${title ?? ''}（无深链——从所属会话进入）`; }
      const wrap = document.createElement('div');
      wrap.className = 'board-room';
      const tag = document.createElement('span');
      tag.className = 'meta';
      tag.textContent = label;
      wrap.append(tag, row);
      return wrap;
    };
    const sec = (title, rows) => {
      if (rows.length === 0) return null;
      const head = document.createElement('div');
      head.className = 'meta';
      head.textContent = `${title}（${rows.length}）`;
      const wrapEl = document.createElement('div');
      wrapEl.className = 'board-room';
      wrapEl.append(head, ...rows);
      return wrapEl;
    };
    // 共享预览入口（第三十轮四）：托管附件点击→统一预览面板（previewAttachment 按 kind 分流——服务端 audience/实身份/hash 校验）。
    const attRows = (g.attachments ?? []).map((a) => {
      const row = document.createElement('button');
      row.className = 'chip';
      row.textContent = `📎 ${a.filename}（${a.hash.slice(0, 8)}… v${a.revision}${a.audience === 'dm' ? ' · 私信' : ''}）`;
      row.title = `${a.audience === 'dm' ? '私信资源（仅本人可见）' : '房间会话'} · ${a.conversationId}——点击预览`;
      row.onclick = () => void previewAttachment(a.attachmentId, a.filename, a.kind).catch((e) => showError(`预览失败：${e.message}`));
      const wrap = document.createElement('div');
      wrap.className = 'board-room';
      const tag = document.createElement('span');
      tag.className = 'meta';
      tag.textContent = '托管附件';
      wrap.append(tag, row);
      return wrap;
    });
    const draftRows = (g.drafts ?? []).map((d) => mkRow('Agent 草稿', `草稿 ${d.changeSetId.slice(0, 8)}…（${d.applicationStatus}）${d.taskTitle != null ? ` · ${d.taskTitle}` : ''}`, d.locate, `change_set：${d.beforeRef.slice(0, 8)}…→${d.afterRef.slice(0, 8)}…`));
    const delRows = (g.deliveries ?? []).map((d) => mkRow('交付成果', `📦 ${d.title} v${d.revision}（${d.manifestHash.slice(0, 8)}…${d.audience === 'dm' ? ' · 私信' : ''}）`, d.locate, `交付 ${d.deliveryId}`));
    const pfRow = (() => {
      if ((g.projectFiles ?? []).length === 0 && g.projectFilesNote == null) return null;
      const row = document.createElement('div');
      row.className = 'meta';
      row.textContent = g.projectFilesNote != null ? `项目文件：${g.projectFilesNote}` : `项目文件（根目录 ${g.projectFiles.length} 项——来源=用户项目目录本身）：${g.projectFiles.slice(0, 20).map((f) => f.dir ? `${f.name}/` : f.name).join('、')}${g.projectFiles.length > 20 ? ' …' : ''}`;
      const wrapEl = document.createElement('div');
      wrapEl.className = 'board-room';
      wrapEl.append(row);
      for (const f of (g.projectFiles ?? []).slice(0, 40)) {
        if (f.dir) continue;
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = f.name;
        b.title = '点击读取只读快照（文本白名单——二进制走 Git/系统工具）';
        b.onclick = () => void projectFilePreview(g.projectId, f.name).catch((e) => showError(`项目文件读取失败：${e.message}`));
        wrapEl.append(b);
      }
      return wrapEl;
    })();
    for (const s of [sec('托管附件', attRows), sec('Agent 草稿', draftRows), sec('交付成果', delRows), pfRow]) {
      if (s != null) gEl.append(s);
    }
    if (gEl.childElementCount === 1) {
      const empty = document.createElement('div');
      empty.className = 'meta';
      empty.textContent = '（无附件/草稿/交付）';
      gEl.append(empty);
    }
    frag.append(gEl);
  }
  if (frag.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = '暂无资源。';
    frag.append(empty);
  }
  box.replaceChildren(frag);
}
async function renderCollaborators() {
  if (box == null || state.openThreadId == null) return;
  let data;
  try { data = await command('thread.collaborators', { threadId: state.openThreadId }); } catch { return; }
  box.textContent = `协作：我的关注 ${data.humanFollowers} 人 · Agent 跟进 ${(data.agentFollowers ?? []).map((a) => `${a.memberId.slice(0, 6)}（${a.status}）`).join('、') || '无'} · 冻结参与 ${(data.frozenParticipants ?? []).map((m) => m.slice(0, 6)).join('、') || '无'} · 实时执行 ${data.activeRun != null ? (data.activeRun.participants ?? []).map((p) => `${p.memberId.slice(0, 6)}/${p.role}/${p.status}`).join('、') : '无'}`;
  box.classList.remove('hidden');
}

async function renderPendingList() {
  const nav = el('pending-list');
  if (nav == null) return;
  let data;
  try { data = await command('mine.pending', {}); } catch { return; /* 通信异常由连接状态呈现 */ }
  const genAtRender = state.navGeneration;
  const rows = [];
  for (const p of data.projects ?? []) {
    for (const t of p.reviewTasks ?? []) {
      rows.push({
        label: `【${p.displayName}】待验收：${t.task_kind === 'dm_turn' ? '私信任务' : '任务'}${t.revision != null ? `（v${t.revision}）` : ''}${t.actionable === false ? '（无待验收交付——需检查状态）' : ''}`,
        title: t.actionable === false
          ? `任务处于 REVIEW 但无可验收交付（当前绑定=null）——诊断入口，验收将被拒绝`
          : `验收绑定当前交付（revision=${t.revision}）`,
        projectId: p.projectId, conversationId: t.conversation_id, taskId: t.task_id,
        deliveryId: t.delivery_id, revision: t.revision, manifestHash: t.manifest_hash, kind: 'review',
      });
    }
    for (const u of p.dmUnread ?? []) {
      rows.push({ label: `【${p.displayName}】未读私信：${u.title ?? u.conversation_id.slice(0, 8)} ·${u.unread}`, title: '点击进入会话（读到的才算已读）', projectId: p.projectId, conversationId: u.conversation_id, kind: 'dm' });
    }
    for (const b of p.blockedTasks ?? []) {
      // 受阻原因（第三十八轮 #4：无解释的「被阻塞」行——用户无法自助诊断；原因来自服务端
      // 事件映射，null=无事件如实不显示）。
      rows.push({ label: `【${p.displayName}】被阻塞：${b.title}${b.reason != null ? `——${b.reason}` : ''}`, title: '可见≠审批——处理入口为线程本身', projectId: p.projectId, conversationId: b.conversation_id, taskId: b.task_id, kind: 'blocked' });
    }
    // 待确认提醒触发（第二十四轮四）：正式确认入口——点击=reminder.confirm（经正式执行链派发）。
    // 桌面系统通知（第二十五轮五）：新出现的待确认触发通知恰一次（去重/点击定位/失败退页内）。
    notifyReminderAwaits(p.reminderAwaits);
    for (const w of p.reminderAwaits ?? []) {
      rows.push({
        label: `【${p.displayName}】提醒待确认：${w.title ?? w.reminderId}${(w.missedCount ?? 0) > 0 ? `（合并 ${w.missedCount} 次错过）` : ''} → 确认执行`,
        title: '点击确认后经正式执行链派发（system 来源，不伪装人类发言）；不确认=暂不执行',
        projectId: p.projectId, conversationId: w.conversationId, kind: 'reminder-await', reminderId: w.reminderId, scheduledAt: w.scheduledAt,
      });
    }
    // 关注线程有新回复（第二十五轮四）：人的阅读订阅（静音优先排除）——点击定位原串。
    for (const f of p.followedThreads ?? []) {
      rows.push({
        label: `【${p.displayName}】关注的线程有 ${f.unread} 条新回复`,
        title: '阅读订阅（非执行名单）——点击进入原线程',
        projectId: p.projectId, conversationId: null, kind: 'followed',
        locate: f.root_task_id != null ? `task=${f.root_task_id}` : `msg=${f.anchor_message_id}`,
      });
    }
  }
  if (state.navGeneration !== genAtRender) return; // 迟到响应不覆盖当前视图的待办区
  // 原子替换（第二十四轮一）：先在离屏 fragment 组装完成，再一次 replaceChildren——
  // 中间不产生「标题在、条目空」的过渡可见态（此前逐步 append 依赖绘制时序）。
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'sidebar-sec';
  head.textContent = rows.length > 0 ? `共 ${rows.length} 项（全部显示）` : '暂无待办';
  frag.append(head);
  for (const r of rows) {
    const btn = document.createElement('button');
    btn.className = 'room';
    btn.textContent = r.label;
    btn.title = r.title;
    btn.onclick = () => {
      if (r.kind === 'dm' && r.conversationId != null) {
        void openDm(r.conversationId).catch((e) => showError(`打开失败：${e.message}`));
        return;
      }
      if (r.kind === 'review') {
        // 定位对应交付（第二十三轮二）：pendingFocus 由 renderDm 消费——同会话多待验收不串。
        state.pendingFocus = { kind: 'review', conversationId: r.conversationId, taskId: r.taskId, deliveryId: r.deliveryId, revision: r.revision, manifestHash: r.manifestHash };
        location.hash = `delivery=${r.deliveryId}`;
        return;
      }
      if (r.kind === 'blocked' && r.taskId != null) location.hash = `task=${r.taskId}`;
      if (r.kind === 'followed' && r.locate != null) location.hash = r.locate;
      if (r.kind === 'reminder-await' && r.reminderId != null) {
        void (async () => {
          try {
            await command('reminder.confirm', { reminderId: r.reminderId, scheduledAt: r.scheduledAt });
            showError('已确认执行——经正式执行链派发（完成后回复落在目标会话）');
          } catch (e) { showError(`确认执行失败：${e.message}`); }
          await renderPendingList();
        })().catch(() => {});
      }
    };
    frag.append(btn);
  }
  nav.replaceChildren(frag);
}

/** 提醒管理面板（DEV-23 第二包；第二十四轮四）：全部可操作提醒（服务端 audience 过滤）——
 * 计划/时区/owner/预算/下次触发/暂停原因+最近 occurrence 历史；操作=编辑（revision CAS）/
 * 贪睡 1 天/取消/恢复（update 重算 next_at，错过的批不补跑）。纯管理面——执行经正式链。 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ---------- DEV-18 第二包（第二十五轮四）：搜索 / 收藏 / 关注·静音 ----------

/** 搜索（search.query）：纯读零运行——范围/类型/作者/日期过滤+确定性分页；点击定位原消息/原串。 */
const searchState = { page: 1, lastText: '', results: null };
async function doSearch(page = 1) {
  const text = el('search-input').value.trim();
  if (text.length === 0) { showError('请输入搜索关键词'); return; }
  const params = {
    text, page,
    scope: el('search-scope').value,
    kind: el('search-kind').value,
    ...(state.projectId != null ? { projectId: state.projectId } : {}),
    ...(el('search-author').value.trim().length > 0 ? { authorDisplayName: el('search-author').value.trim() } : {}),
    ...(el('search-from').value.length > 0 ? { fromDay: el('search-from').value } : {}),
    ...(el('search-to').value.length > 0 ? { toDay: el('search-to').value } : {}),
  };
  try {
    const r = await command('search.query', params);
    searchState.page = page;
    searchState.lastText = text;
    searchState.results = r;
    renderSearchResults();
  } catch (e) { showError(`搜索失败：${e.message}`); }
}
function renderSearchResults() {
  const box = el('search-results');
  if (box == null || searchState.results == null) return;
  const r = searchState.results;
  const frag = document.createDocumentFragment();
  const addRow = (label, title, locate) => {
    const b = document.createElement('button');
    b.className = 'room';
    b.style.display = 'block';
    b.textContent = label;
    b.title = title;
    if (locate != null) b.onclick = () => { location.hash = locate.startsWith('#') ? locate.slice(1) : locate; };
    frag.append(b);
  };
  for (const m of r.messages ?? []) addRow(`【${m.projectName}】消息：${m.snippet}`, `${new Date(m.createdAt).toLocaleString()} · 作者 ${m.authorId}`, m.locate?.slice(1));
  for (const t of r.threads ?? []) addRow(`【${t.projectName}】线程：${t.snippet}`, `锚于 ${new Date(t.createdAt).toLocaleString()}`, t.locate?.slice(1));
  for (const t of r.tasks ?? []) addRow(`【${t.projectName}】任务：${t.title}（${t.status}）`, '点击定位原任务', t.locate?.slice(1));
  if (frag.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = `无结果（第 ${r.page} 页）——他人私信不进入结果；附件按所在消息文件名检索`;
    frag.append(empty);
  }
  box.replaceChildren(frag);
  el('search-page-info').textContent = `第 ${r.page} 页（每页 ${r.pageSize}）`;
}

/** 收藏（saved_refs）：独立持久；取消不删原内容；失效/越权如实呈现；跳转复用正式深链。 */
async function renderSaved() {
  const nav = el('saved-list');
  if (nav == null) return;
  let data;
  try { data = await command('saved.list', {}); } catch { return; }
  const frag = document.createDocumentFragment();
  if ((data.items ?? []).length === 0) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = '暂无收藏（消息行 ☆ 收藏）';
    frag.append(empty);
    nav.replaceChildren(frag);
    return;
  }
  const KIND_LABEL = { message: '消息', task: '任务', delivery: '交付', link: '链接' };
  const STATUS_LABEL = { ok: '', missing: '（目标已删除）', forbidden: '（无权限访问）' };
  for (const it of data.items) {
    const row = document.createElement('div');
    row.className = 'room';
    row.style.display = 'block';
    const label = document.createElement('button');
    label.className = 'chip';
    label.style.marginRight = '6px';
    label.textContent = it.status === 'ok' && it.locate != null ? `${KIND_LABEL[it.kind] ?? it.kind}：${it.title ?? it.ref}` : `${KIND_LABEL[it.kind] ?? it.kind}：${it.title ?? String(it.ref).slice(0, 48)}${STATUS_LABEL[it.status] ?? ''}`;
    label.title = it.kind === 'link' ? '链接收藏（点击复制地址）' : it.locate != null ? '点击定位（正式深链）' : '目标不可达——仅呈现';
    label.disabled = !(it.status === 'ok');
    label.onclick = () => {
      if (it.kind === 'link') { void navigator.clipboard?.writeText(it.ref).then(() => showError('链接已复制')).catch(() => showError(`链接：${it.ref}`)); return; }
      if (it.locate != null) location.hash = it.locate.slice(1);
    };
    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger';
    removeBtn.textContent = '取消收藏';
    removeBtn.onclick = () => void (async () => {
      try { await command('saved.remove', { kind: it.kind, ref: it.ref }); } catch (e) { showError(`取消收藏失败：${e.message}`); }
      await renderSaved();
    })().catch(() => {});
    row.append(label, removeBtn);
    frag.append(row);
  }
  nav.replaceChildren(frag);
}

/** 消息行收藏按钮（线程+DM 共用）：saved.add 幂等。 */
function attachSaveButton(div, message) {
  const star = document.createElement('button');
  star.className = 'msg-star';
  star.textContent = '☆';
  star.title = '收藏此消息（saved.add——独立保存，不改动原内容）';
  star.onclick = () => void (async () => {
    let text = '';
    try { text = (JSON.parse(message.body_json) ?? {}).text ?? ''; } catch { text = ''; }
    try {
      const r = await command('saved.add', { kind: 'message', ref: message.id, title: text.slice(0, 60), ...(state.projectId != null ? { projectId: state.projectId } : {}) });
      star.textContent = r.existed === true ? '★' : '★';
      showError(r.existed === true ? '已在收藏中（幂等——不重复）' : '已收藏');
      await renderSaved();
    } catch (e) { showError(`收藏失败：${e.message}`); }
  })().catch(() => {});
  div.prepend(star);
  attachMsgActions(div, message); // 消息操作组（第三十一轮二接线：复制/引用/表情——所有消息渲染路径统一挂载）
}

/** 线程关注/静音（thread_subscriptions——人的阅读订阅，与执行名单分列；纯偏好零运行）。 */
// ---------- 桌面系统通知（ATTN-05/06 首版矩阵——第二十五轮五+第二十六轮二修复）----------
// 定位=服务端返回的**准确 locate**（DM/房间线程/任务/讨论串区分——不再统一 #dm=）；点击只
// 定位不确认执行；跨项目由统一深链处理；同窗口重复点击幂等（深链可重放）。
// 事实留痕（zs-notify-log）：permission/created/shown/error/close 各相分别登记——本地日志
// 只证明「已登记尝试/各相事件」，**不证明 Windows 已显示**（真机送达/点击由人工验收入口复核）。
// 通知偏好：目标线程静音（notifyMuted——服务端按提醒实际线程过滤，非未读聚合）→ 不发系统
// 通知（待办事项保留在待我处理）。权限被拒/创建失败/送达失败：页内如实提示，**不改变执行
// 授权、不重复派发**；关闭（onclose）不重发——同 occurrence 去重恰一次。
const notifiedReminders = new Set(JSON.parse(localStorage.getItem('zs-notified-rem') ?? '[]'));
function notifyLog(key, phase, detail = '') {
  try {
    const log = JSON.parse(localStorage.getItem('zs-notify-log') ?? '[]');
    log.push({ key, phase, detail, at: Date.now() });
    localStorage.setItem('zs-notify-log', JSON.stringify(log.slice(-400)));
  } catch { /* 存不住则内存事实仍在 dedup 集 */ }
}
function notifyReminderAwaits(awaits) {
  for (const w of awaits ?? []) {
    const key = `${w.reminderId}@${w.scheduledAt}`;
    if (notifiedReminders.has(key)) continue; // 去重：同 occurrence 恰一次
    notifiedReminders.add(key);
    try { localStorage.setItem('zs-notified-rem', JSON.stringify([...notifiedReminders].slice(-500))); } catch { /* 进程内去重兜底 */ }
    if (w.notifyMuted === true) { notifyLog(key, 'muted', '目标线程静音——不发系统通知（待办保留）'); continue; } // 提醒通知过滤（独立于未读聚合）
    const body = `${w.title ?? '提醒'}${w.missedCount > 0 ? `（合并 ${w.missedCount} 次错过）` : ''}——到点待确认执行`;
    const locate = typeof w.locate === 'string' && w.locate.startsWith('#') ? w.locate.slice(1) : null;
    try {
      if (typeof Notification === 'undefined') {
        notifyLog(key, 'error', '无 Notification API');
        showError(`提醒待确认（系统通知不可用——待我处理仍列出）：${body}`);
        continue;
      }
      notifyLog(key, 'permission', Notification.permission);
      if (Notification.permission === 'denied') {
        notifyLog(key, 'error', 'permission denied');
        showError(`提醒待确认（通知权限被拒——待我处理仍列出）：${body}`);
        continue;
      }
      const n = new Notification('众说：提醒待确认', { body, tag: key });
      notifyLog(key, 'created');
      n.onshow = () => notifyLog(key, 'shown'); // 送达事件（不等于 Windows 中心已显示的证明）
      n.onerror = () => { notifyLog(key, 'error', 'delivery'); showError(`系统通知送达失败（执行不受影响）：${body}`); };
      n.onclose = () => notifyLog(key, 'close'); // 用户关闭：不重发（去重集已登记）
      n.onclick = () => { window.focus(); if (locate != null) location.hash = locate; }; // 只定位（准确深链）——不确认执行
    } catch (e) { notifyLog(key, 'error', e instanceof Error ? e.message : String(e)); showError(`系统通知创建失败（待我处理仍列出）：${e instanceof Error ? e.message : String(e)}`); }
  }
}
// 首次使用请求权限（Electron 通常默认授予；拒绝=退化为页内提示——不阻塞任何执行链）。
try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => {}); } catch { /* 无通知 API */ }

async function refreshThreadSubButtons() {  const followBtn = el('thread-follow-btn');
  const muteBtn = el('thread-mute-btn');
  if (followBtn == null || muteBtn == null) return;
  if (state.openThreadId == null) { followBtn.classList.add('hidden'); muteBtn.classList.add('hidden'); return; }
  followBtn.classList.remove('hidden');
  muteBtn.classList.remove('hidden');
  try {
    const subs = await command('thread.subscriptions', state.projectId != null ? { projectId: state.projectId } : {});
    const cur = (subs.items ?? []).find((x) => x.threadId === state.openThreadId);
    followBtn.textContent = cur?.followed ? '★ 已关注' : '☆ 关注';
    muteBtn.textContent = cur?.muted ? '取消静音' : '静音';
    followBtn.dataset.followed = cur?.followed ? '1' : '0';
    muteBtn.dataset.muted = cur?.muted ? '1' : '0';
  } catch { /* 读取失败保持默认文案 */ }
}
async function renderReminderPanel() {
  const nav = el('reminder-list');
  if (nav == null) return;
  let data;
  try { data = await command('reminder.list', {}); } catch { return; }
  const frag = document.createDocumentFragment();
  const items = data.items ?? [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = '暂无提醒（在私信会话点 ⏰ 设置每日提醒）';
    frag.append(empty);
    nav.replaceChildren(frag);
    return;
  }
  for (const it of items) {
    const box = document.createElement('div');
    box.className = 'room';
    box.style.display = 'block';
    const sched = it.schedule ?? {};
    const planText = sched.kind === 'once'
      ? `一次 · ${sched.at != null ? new Date(sched.at).toLocaleString() : '?'}`
      : sched.kind === 'weekly'
        ? `每周${WEEKDAY_LABELS[sched.weekday] ?? '?'} ${sched.time ?? '?'}（${it.timezone ?? 'UTC'}）`
        : `每天 ${sched.time ?? '?'}（${it.timezone ?? 'UTC'}）`;
    const budgetText = it.budgetLimit != null ? `预算 ${it.budgetLimit.sum} 次执行` : '无预算上限';
    const statusText = it.status === 'active' ? (it.autoDispatch ? 'active·自动执行' : 'active·待确认') : `${it.status}${it.pausedReason != null ? `（${it.pausedReason}）` : ''}`;
    const head = document.createElement('div');
    head.textContent = `${it.title ?? it.reminderId} · ${planText} · ${budgetText} · ${statusText} · 下次 ${it.nextAt != null ? new Date(it.nextAt).toLocaleString() : '—'}`;
    box.append(head);
    const actions = document.createElement('div');
    actions.className = 'git-row';
    const mkBtn = (text, cls, fn, title) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = text;
      if (title != null) b.title = title;
      b.onclick = () => void fn().catch(() => {});
      return b;
    };
    const refresh = async () => { await renderReminderPanel(); await renderPendingList(); };
    if (it.status === 'active') {
      actions.append(mkBtn('贪睡1天', 'chip', async () => {
        try { await command('reminder.snooze', { reminderId: it.reminderId, until: (it.nextAt ?? Date.now()) + 86_400_000 }); } catch (e) { showError(`贪睡失败：${e.message}`); }
        await refresh();
      }, '下次触发推迟一天（revision+1）'));
    }
    if (it.status === 'paused') {
      actions.append(mkBtn('恢复', 'chip', async () => {
        try { await command('reminder.update', { reminderId: it.reminderId, expectedRevision: it.revision, schedule: it.schedule }); } catch (e) { showError(`恢复失败：${e.message}`); }
        await refresh();
      }, '显式继续：重算下次触发（错过的批次不补跑；授权类暂停会在下次触发重查时再判定）'));
    }
    if (it.status === 'active' || it.status === 'paused') {
      actions.append(mkBtn('取消', 'danger', async () => {
        try { await command('reminder.cancel', { reminderId: it.reminderId }); } catch (e) { showError(`取消失败：${e.message}`); }
        await refresh();
      }, '取消后不再触发（不可复活；待确认触发同时作废）'));
    }
    box.append(actions);
    // 编辑表单（details 展开式——revision CAS；once/daily/weekly+任意分钟+时区+自动执行）。
    const edit = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '编辑';
    edit.append(summary);
    const form = document.createElement('div');
    form.className = 'git-row';
    const titleInput = document.createElement('input');
    titleInput.className = 'git-input';
    titleInput.value = it.title ?? '';
    titleInput.maxLength = 200;
    titleInput.placeholder = '标题';
    const kindSel = document.createElement('select');
    for (const [v, label] of [['once', '一次'], ['daily', '每天'], ['weekly', '每周']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      kindSel.append(o);
    }
    kindSel.value = sched.kind ?? 'daily';
    const timeInput = document.createElement('input');
    timeInput.className = 'git-input';
    timeInput.placeholder = 'HH:mm（如 09:17）';
    timeInput.value = sched.time ?? '';
    kindSel.onchange = () => { timeInput.placeholder = kindSel.value === 'once' ? '未来时刻（ISO，如 2026-10-02T09:00）' : 'HH:mm（如 09:17）'; };
    const weekdaySel = document.createElement('select');
    WEEKDAY_LABELS.forEach((label, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = label;
      weekdaySel.append(o);
    });
    weekdaySel.value = String(sched.weekday ?? 1);
    const tzInput = document.createElement('input');
    tzInput.className = 'git-input';
    tzInput.placeholder = 'IANA 时区（缺省 UTC）';
    tzInput.value = sched.tz ?? '';
    const autoChk = document.createElement('input');
    autoChk.type = 'checkbox';
    autoChk.checked = it.autoDispatch === true;
    const autoLabel = document.createElement('label');
    autoLabel.style.marginLeft = '6px';
    autoLabel.append(autoChk, document.createTextNode('自动执行（不勾选=到点待我确认）'));
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = '保存（revision CAS）';
    saveBtn.onclick = () => void (async () => {
      const kind = kindSel.value;
      let schedule;
      if (kind === 'once') {
        const atText = timeInput.value.trim();
        const atMs = Date.parse(atText);
        if (!Number.isFinite(atMs) || atMs <= Date.now()) { showError('一次性提醒需填未来时刻（编辑框填 ISO 时刻）'); return; }
        schedule = { kind: 'once', at: atMs };
      } else {
        if (!/^\d{1,2}:\d{2}$/.test(timeInput.value.trim())) { showError('时刻需为 HH:mm'); return; }
        schedule = kind === 'weekly' ? { kind, weekday: Number(weekdaySel.value), time: timeInput.value.trim() } : { kind, time: timeInput.value.trim() };
        if (tzInput.value.trim().length > 0) schedule.tz = tzInput.value.trim();
      }
      try {
        await command('reminder.update', { reminderId: it.reminderId, expectedRevision: it.revision, title: titleInput.value.trim().length > 0 ? titleInput.value.trim() : undefined, schedule, autoDispatch: autoChk.checked });
        showError('已保存（下次触发已按新计划重算）');
      } catch (e) { showError(`保存失败：${e.message}`); }
      await refresh();
    })().catch(() => {});
    form.append(titleInput, kindSel, timeInput, weekdaySel, tzInput, autoLabel, saveBtn);
    edit.append(form);
    box.append(edit);
    // 最近触发历史（occurrence——含合并/拒绝原因，如实呈现）。
    const hist = it.occurrences ?? [];
    if (hist.length > 0) {
      const h = document.createElement('div');
      h.className = 'meta';
      h.textContent = `最近触发：${hist.slice(0, 5).map((o) => `${new Date(o.scheduled_at).toLocaleString()}→${o.outcome ?? o.status}${o.missed_count > 0 ? `（合并${o.missed_count}）` : ''}`).join('；')}`;
      box.append(h);
    }
    frag.append(box);
  }
  nav.replaceChildren(frag);
}


async function renderDm() {
  // 固定请求目标+导航代次（第二十三轮一）：project+conversation+view 三元组在**每次 await
  // 之后**核对——A→B 挡一次不够，A→B→A 时第一次核对（openDmId!==dmAtRender）会放行第二批
  // 迟到响应，必须比对「代次」而非仅 conversationId。
  const dmAtRender = state.openDmId;
  const projectAtRender = state.projectId;
  const genAtRender = state.navGeneration;
  if (dmAtRender == null || projectAtRender == null) return;
  const stillCurrent = () => state.openDmId === dmAtRender && state.projectId === projectAtRender && state.navGeneration === genAtRender;
  // 执行态/排队数必须取实时值（第二十轮一：缓存由低频侧栏刷新——会话视图每次直查，
  // 不用过期缓存呈现运行/排队状态）。
  const fresh = ((await command('conversation.list', { projectId: projectAtRender })).conversations ?? []).find((c) => c.conversationId === dmAtRender);
  if (!stillCurrent()) return; // 已切走（含 A→B→A：代次不等）：迟到响应不重绘
  if (fresh == null) { state.openDmId = null; showPool(); return; }
  const box = el('dm-messages');
  // 滚动位置保留（第二十三轮一）：用户滚离底部（>80px 视为在读历史）时不强制滚到底；
  // 仅当原本就在底部（新消息跟随）或首次渲染才贴底。
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const wasNearBottom = nearBottom();
  const prevScrollTop = box.scrollTop;
  const history = await command('conversation.history', { conversationId: dmAtRender, limit: 100 });
  if (!stillCurrent()) return; // history 期间切走：不重绘（滚动位置/在途状态不覆盖）
  box.replaceChildren();
  for (const m of history.messages ?? []) {
    const div = document.createElement('div');
    div.className = `msg ${m.author_type === 'human' ? 'mine' : m.author_type === 'system' ? 'system' : 'agent'}`;
    div.dataset.seq = String(m.conversation_seq); // 深链消息定位（scrollIntoView）
    let text = '';
    try { text = (JSON.parse(m.body_json) ?? {}).text ?? ''; } catch { text = String(m.body_json ?? ''); }
    const who = document.createElement('div');
    who.className = 'meta';
    who.textContent = m.author_type === 'human' ? '我' : fresh.peerDisplayName;
    const body = document.createElement('div');
    body.textContent = text;
    div.append(who, body);
    appendSentAttachmentChips(div, m.attachments); // 已发消息附件（点击预览——第二十七轮三）
    attachSaveButton(div, m); // 收藏入口（第二十五轮四——system 提醒消息同样可收藏）
    box.append(div);
  }
  if (wasNearBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevScrollTop; // 读历史时轮询重绘不打断滚动位置
  // 深链消息定位（第二十三轮二）：一次性消费 pendingFocus.messageId/seq。
  if (state.pendingFocus?.messageSeq != null) {
    const target = box.querySelector(`[data-seq="${state.pendingFocus.messageSeq}"]`);
    if (target != null) target.scrollIntoView({ block: 'center' });
    state.pendingFocus = null;
  } else if (state.pendingFocus?.kind === 'dm') state.pendingFocus = null;
  // 已读水位=**已展示且贴底**才推进（第二十三轮一）：后台窗口（document.hidden）、滚看历史、
  // 已切走的会话不自动标读——服务端另拒未来水位。
  const lastSeq = history.messages?.length > 0 ? history.messages[history.messages.length - 1].conversation_seq : fresh.lastMessageSeq;
  if (fresh.unread > 0 && !document.hidden && nearBottom()) {
    void command('conversation.markRead', { conversationId: dmAtRender, throughMessageSeq: lastSeq })
      .then((r) => { if (r?.advanced && stillCurrent()) void renderDmSidebar().catch(() => {}); })
      .catch(() => {});
  }
  // 会话头：标题/执行态/操作（停止/继续队列/恢复执行/归档/取消归档）。
  el('dm-title').textContent = `私信 · ${fresh.peerDisplayName}${fresh.title != null && fresh.title.length > 0 ? ` · ${fresh.title}` : ''}`;
  const queueNote = fresh.queuedCount > 0 && fresh.archivedAt == null && fresh.execState !== 'queued' ? ` · 排队 ${fresh.queuedCount}` : '';
  const interruptedNote = (fresh.interruptedTasks ?? []).length > 0
    ? ` · 中断待恢复 ${fresh.interruptedTasks.length}（${fresh.interruptedTasks.map((t) => `${t.title}（上次运行 ${(t.lastRunStatus ?? '未知').toLowerCase()}${t.recoverable === false && t.blockReason != null ? `——${t.blockReason}` : ''}）`).join('；')}）`
    : '';
  el('dm-state').textContent = fresh.archivedAt != null ? '已归档（禁止新发/续跑）' : `${DM_STATE_TEXT[fresh.execState] ?? ''}${queueNote}${interruptedNote}`;
  el('dm-stop-btn').classList.toggle('hidden', fresh.execState !== 'running');
  el('dm-resume-btn').classList.toggle('hidden', fresh.execState !== 'paused');
  const anyRecoverable = (fresh.interruptedTasks ?? []).some((t) => t.recoverable !== false);
  el('dm-recover-btn').classList.toggle('hidden', fresh.archivedAt != null || !anyRecoverable);
  el('dm-archive-btn').classList.toggle('hidden', fresh.archivedAt != null);
  el('dm-restore-btn').classList.toggle('hidden', fresh.archivedAt == null);
  el('dm-rename-btn').classList.toggle('hidden', false); // 重命名随时可用（不换对端/不重置）
  // 待验收定位（第二十三轮二）：从待我处理条目进入时优先显示对应交付（state.pendingFocus）；
  // 默认=最新 pending；同会话多待验收时提示总数（全部经待我处理可达，不因单数行漏项）。
  const review = (state.pendingFocus?.kind === 'review' && state.pendingFocus.conversationId === dmAtRender)
    ? { taskId: state.pendingFocus.taskId, deliveryId: state.pendingFocus.deliveryId, revision: state.pendingFocus.revision, manifestHash: state.pendingFocus.manifestHash }
    : fresh.pendingReview;
  if (state.pendingFocus?.kind === 'review') state.pendingFocus = null; // 一次性消费
  el('dm-review-row').classList.toggle('hidden', review == null);
  if (review != null) el('dm-review-revision').textContent = `${review.revision}${fresh.reviewCount > 1 ? `（共 ${fresh.reviewCount} 项待验收——见侧栏待我处理）` : ''}`;
  el('dm-input').disabled = fresh.archivedAt != null;
  el('dm-send').disabled = fresh.archivedAt != null;
  state.dmActive = { ...fresh, currentReview: review }; // 停止/验收按钮的 task/run/delivery 来源（review=当前定位交付）
}

async function sendDm() {
  if (state.openDmId == null) return;
  const input = el('dm-input');
  const text = input.value.trim();
  if (text.length === 0) return;
  // 图片能力门（第二十九轮三）：默认意图（会派发）+草稿含图片 → 用户明确选择，不悄悄省略。
  if (draftHasImage('dm') && !state.dmRecordOnly && !state.imageAckPending) {
    showImageGate('dm', () => { state.imageAckPending = true; void sendDm(); });
    return;
  }
  // 发起时快照：目标键与要发送的附件 refs（响应前切会话不动另一键——失败保留正文与附件）。
  const dmKey = attachDraftKey('dm');
  const dmAtts = attachDraft('dm');
  const sentRefs = dmAtts.map((a) => a.attachmentId);
  const ack = state.imageAckPending === true;
  state.imageAckPending = false; // 一次性消费（失败重发会再过门）
  const dmRanges = {};
  for (const a of dmAtts) if (a.range != null && String(a.range).trim().length > 0) dmRanges[a.attachmentId] = String(a.range).trim();
  input.value = '';
  try {
    const r = await command('message.submit', {
      target: { kind: 'dm', projectId: state.projectId, conversationId: state.openDmId },
      body: text, intent: state.dmRecordOnly ? 'record_only' : 'default', mentions: [],
      ...(sentRefs.length > 0 ? { attachmentRefs: sentRefs } : {}),
      ...(ack ? { imageAck: 'omit-images' } : {}),
      ...(Object.keys(dmRanges).length > 0 ? { attachmentRanges: dmRanges } : {}),
    });
    // 成功只清**本次发送的 refs**（失败后新加的附件保留在草稿）。
    const remaining = (draftAttachments.get(dmKey) ?? []).filter((a) => !sentRefs.includes(a.attachmentId));
    if (remaining.length === 0) draftAttachments.delete(dmKey); else draftAttachments.set(dmKey, remaining);
    renderAttachChips('dm');
    if (r.disposition === 'queued') el('dm-state').textContent = '已保存排队（当前运行结束后串行执行）';
    if (state.dmRecordOnly) { state.dmRecordOnly = false; el('dm-record').classList.remove('on'); }
  } catch (e) {
    input.value = text; // 发送失败恢复草稿（不丢字）
    el('dm-state').textContent = `发送失败：${e.message}`;
    return;
  }
  await renderDm();
  void renderDmSidebar().catch(() => {});
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
    meta.textContent = `我 · ${new Date(item.createdAt).toLocaleTimeString()}${item.unread > 0 ? ` · 未读 ${item.unread}` : ''}`;
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
  const threadAtRender = state.openThreadId;
  const genAtRender = state.navGeneration;
  const stillCurrent = () => state.openThreadId === threadAtRender && state.navGeneration === genAtRender;
  const box = el('thread-messages');
  const nearBottomBefore = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevScrollTop = box.scrollTop;
  const history = await command('thread.history', { threadId: threadAtRender, limit: 200 });
  if (!stillCurrent()) return; // 切走线程/视图：迟到响应不重绘（第二十三轮一）
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
    appendSentAttachmentChips(root, history.rootAttachments); // 根消息附件芯片（thread.history rootAttachments——第二十七轮三）
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
    appendSentAttachmentChips(div, m.attachments); // 已发消息附件（点击预览——第二十七轮三）
    attachSaveButton(div, m); // 收藏入口（第二十五轮四）
    box.appendChild(div);
  }
  // 滚动保留（同 DM）：读历史时轮询重绘不打断；贴底+前台才推进线程水位（第二十三轮一）。
  if (nearBottomBefore) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevScrollTop;
  const threadLastSeq = (history.items ?? []).length > 0 ? history.items[history.items.length - 1].seq : null;
  if (threadLastSeq != null && !document.hidden && (box.scrollHeight - box.scrollTop - box.clientHeight < 80)) {
    void command('thread.markRead', { threadId: threadAtRender, throughMessageSeq: threadLastSeq }).catch(() => {});
  }
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
  void refreshThreadSubButtons().catch(() => {}); // 关注/静音按钮随线程刷新（第二十五轮四）
  void renderCollaborators().catch(() => {}); // 协作视图四列（第二十六轮四）
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
  // 验收回执是用户操作的确认（第十九轮八：1.5s 轮询重绘不得瞬间抹掉）——保留展示，
  // 换线程/新发送时清除。
  const confirmNote = state.reviewConfirmFor === snapshot.taskId && state.reviewConfirm != null ? ` · ${state.reviewConfirm}` : '';
  statusLine.textContent = `任务${chip.text}${runText}${failNote}${confirmNote}`;
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
      taskId: snap.taskId, deliveryId: pending.id, deliveryRevision: pending.revision,
      manifestHash: pending.manifest_hash ?? pending.manifestHash ?? '', // 三重绑定（第二十三轮三）：服务端必填核对
      decision,
      ...(decision === 'changes_requested' && note != null ? { note } : {}),
    });
    state.reviewConfirm = `验收已记录：交付 ${r.reviewStatus}（第 ${r.deliveryRevision} 版）· 任务 ${r.taskStatusAfter}`;
    state.reviewConfirmFor = snap.taskId;
    el('thread-status').textContent = state.reviewConfirm;
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

// ---------- 图片能力门（第二十九轮三）----------
// 草稿含图片且本次会派发（DM 默认意图/主池派发路由）时，程序不悄悄省略图片后以任务成功
// 冒充处理完成：用户明确二选一——仅发送文字（imageAck:"omit-images"——注入文本如实注明
// 图片未发送及用户确认）或取消。record_only/线程跟进不派发=无门（保存/预览不受影响）。
function draftHasImage(kind) {
  return attachDraft(kind).some((a) => a.kind === 'image_file');
}
/** 图片能力门确认条（kind 决定容器：DM 区就地呈现——send-error 在主池 footer，DM 视图不可见）。 */
function showImageGate(kind, onConfirm) {
  const box = el(kind === 'dm' ? 'dm-gate' : 'send-error');
  if (box == null) { onConfirm(); return; } // 容器缺失不阻断（服务端门仍在——这里只是无 UI）
  box.classList.remove('hidden');
  box.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = '模型图片输入能力未认证——图片不会发送给模型。请明确选择：';
  const okBtn = document.createElement('button');
  okBtn.id = 'image-gate-confirm';
  okBtn.textContent = '仅发送文字（图片不发送，注入如实注明）';
  okBtn.onclick = () => { box.classList.add('hidden'); box.innerHTML = ''; onConfirm(); };
  const cancel = document.createElement('button');
  cancel.id = 'image-gate-cancel';
  cancel.textContent = '取消发送';
  cancel.onclick = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  box.append(text, okBtn, cancel);
}

async function retrySend() {
  const envelope = state.pendingRetry;
  if (envelope == null) return;
  // 视图从信封目标推导（重试时用户可能已切视图——不得动另一视图的草稿）。
  const view = envelope.params?.target?.kind === 'thread' ? 'thread' : 'pool';
  // 键快照从信封目标推导（重试时用户可能已切线程——不得动另一键）。
  const target = envelope.params?.target ?? {};
  const keyAtSend = `${target.projectId ?? 'p?'}:${state.roomId ?? 'noroom'}:${target.threadId ?? '-'}`;
  clearSendError();
  try {
    const result = await zs.command(envelope); // 同 commandId：服务端幂等重放/去重
    if (!result.ok) {
      showSendError(`发送失败：${result.error?.message ?? '未知错误'}`);
      return;
    }
    afterSendSuccess(view, state.recordOnly, envelope.params?.attachmentRefs, keyAtSend);
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
  const atts = attachDraft('composer'); // 发起时的目标键快照（响应前切视图不动另一键）
  const ranges = {};
  for (const a of atts) if (a.range != null && String(a.range).trim().length > 0) ranges[a.attachmentId] = String(a.range).trim();
  return {
    protocolVersion: 1,
    commandId: uuid(), // 去重锚点：在途重复触发被忽略；传输失败重试沿用同一 id
    method: 'message.submit',
    params: {
      target, body: text, intent: state.recordOnly ? 'record_only' : 'default', mentions,
      ...(atts.length > 0 ? { attachmentRefs: atts.map((a) => a.attachmentId) } : {}),
      ...(state.imageAckPending === true ? { imageAck: 'omit-images' } : {}),
      ...(Object.keys(ranges).length > 0 ? { attachmentRanges: ranges } : {}),
    },
  };
}

function afterSendSuccess(view, recordIntent, sentRefs, keyAtSend) {
  // 视图/意图/目标键在发起时固定（修复轮 6；第二十八轮三：完整键快照——同房间线程 A/B
  // 不再因视图同名串清算）：响应到达前用户可能已切换线程/视图——只清发起键的草稿与输入框，
  // 不动另一键。附件草稿按**信封内实际发送的 refs** 清算（失败后新加的附件不在信封里——
  // 保留在草稿，不随重试成功丢掉）。
  const key = keyAtSend ?? `${state.projectId ?? 'p?'}:${state.roomId ?? 'noroom'}:-`;
  state.drafts[key] = { text: '', mention: state.drafts[key]?.mention ?? '' };
  const remaining = (draftAttachments.get(key) ?? []).filter((a) => !(sentRefs ?? []).includes(a.attachmentId));
  if (remaining.length === 0) draftAttachments.delete(key); else draftAttachments.set(key, remaining);
  renderAttachChips('composer');
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
  // 图片能力门（第二十九轮三）：主池默认意图（派发路由）+草稿含图片 → 明确选择；线程跟进
  // 与仅记录不派发=无门。
  if (state.openThreadId == null && !state.recordOnly && draftHasImage('composer') && state.imageAckPending !== true) {
    showImageGate('composer', () => { state.imageAckPending = true; void send(); });
    return;
  }
  // 发起时固定视图与「仅记录」意图（响应到达前用户可能切换视图）。
  const view = currentView();
  const recordIntent = state.recordOnly;
  const keyAtSend = draftKey(); // 发起时目标键快照（第二十八轮三：完整键——响应前切换线程不清错键）
  const envelope = buildEnvelope();
  state.imageAckPending = false; // 一次性消费（随信封固化；失败重发会再过门）
  clearSendError();
  state.inflightSend = envelope.commandId;
  el('send').disabled = true;
  try {
    const result = await zs.command(envelope);
    if (!result.ok) {
      showSendError(`发送失败：${result.error?.message ?? '未知错误'}`); // 业务失败：保留草稿
      return;
    }
    afterSendSuccess(view, recordIntent, envelope.params?.attachmentRefs, keyAtSend);
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
  // 第四十一轮 §2：无租约的「保护保留」独立行（protection_state=retained——人工退款/取证
  // 未确认退出的 turn 可能没有租约，但恢复必须经正式证据解除；不得从恢复中心消失）。
  const shownTurnIds = new Set([...unknown.map((t) => t.id), ...orphanLeases.map((l) => l.owner_turn_id)]);
  const retainedOnly = (data.pendingRelease ?? []).filter((r) => !shownTurnIds.has(r.turnId));
  if (unknown.length === 0 && undos.length === 0 && orphanLeases.length === 0 && retainedOnly.length === 0) {
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
  head.textContent = `恢复中心：待对账 ${unknown.length} 项${undos.length > 0 ? `；未收口撤销 ${undos.length} 项` : ''}${retainedOnly.length > 0 ? `；保留保护 ${retainedOnly.length} 项（无租约）` : ''}`;
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
  for (const r of retainedOnly) {
    const row = document.createElement('div');
    row.className = 'recovery-orphan-row';
    row.dataset.turnId = r.turnId;
    const facts = document.createElement('div');
    facts.className = 'recovery-facts';
    facts.textContent = `保留保护：${r.turnId}（状态=${r.turnStatus ?? '?'}·预算处置=${r.budgetMark ?? '?'}·无未释放租约——无租约不等于退出已确认）——须服务端程序证据解除（recovery.releaseProtection）后任务才可恢复执行`;
    row.appendChild(facts);
    const b = document.createElement('button');
    b.textContent = '继续核对并解除（服务端取证）';
    b.onclick = () => void releaseRetainedProtection(r.turnId);
    row.appendChild(b);
    panel.appendChild(row);
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
    showError(`恢复失败：${error.message}`);
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
    // 换装壳接管（第四十七轮）：hifi 显示期间暂停旧端轮询（返回 legacy 由
    // __zsLegacySetVisible(true) 恢复）——避免双轮询/后台 markRead/项目漂移。
    if (window.__zsLegacyPaused === true) return;
    state.pollTick += 1;
    window.__zsPollTick = state.pollTick; // 诊断探针（验证器只读——轮询存活证据）
    window.__zsView = `${currentView()}|dm=${state.openDmId ?? '-'}|th=${state.openThreadId ?? '-'}`;
    const view = currentView();
    void (view === 'dm' ? renderDm() : view === 'thread' ? renderThread() : renderPool()).catch(() => {
      el('conn-state').textContent = '通信异常';
      el('conn-state').classList.add('err');
    });
    if (state.pollTick % 4 === 0) { void renderDmSidebar().catch(() => {}); void renderPendingList().catch(() => {}); if (state.pollTick % 20 === 0) { void renderReminderPanel().catch(() => {}); void renderSaved().catch(() => {}); } } // 侧栏未读/执行态+待我处理低频刷新+提醒/收藏面板更低频（纯读）
    // 低频复查门禁（运行中新落门禁的场景极少；启动/重连另有触发）。
    if (state.pollTick % 8 === 0) void refreshGate().catch(() => {});
  }, 1500);
}

// ---------- 事件绑定 ----------

// 初始化即绪声明（第二十二轮一）：open-folder 在 HTML 里初始 disabled（未就绪可见——
// 点击不静默丢失）；app.js 执行到此处=交互绑定完成，随即启用。此后点击必被处理。
el('open-folder').disabled = false;
el('open-folder').removeAttribute('title');
el('open-folder').onclick = () => void openFolder().catch((e) => showError(`打开失败：${e.message}`));
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
    .catch((e) => showError(`建房失败：${e.message}`));
};
el('stop-btn').onclick = () => void stopTask();
// 私信（DEV-22）：新建/返回/发送/仅记录/停止/继续队列/归档/取消归档。
// 新建私信：DOM 成员选择器（第二十轮一正式落地——第十九轮补丁静默未生效，onclick 仍走
// prompt()：原生对话框同样阻塞 renderer）。每个请求创建独立会话（同成员可多条）；打开已
// 有会话点侧栏列表；成员清单在项目加载后半段才就绪——有界等待，不静默不出也不挂住。
el('dm-create').onclick = () => void (async () => {
  const box = el('dm-member-picker');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  for (let i = 0; i < 40 && state.members.filter((x) => x.principalType === 'agent' && x.enabled).length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const agents = state.members.filter((x) => x.principalType === 'agent' && x.enabled);
  box.replaceChildren();
  if (agents.length === 0) { box.textContent = '（本项目没有启用的 Agent 成员）'; box.classList.remove('hidden'); return; }
  for (const a of agents) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.dmPeer = a.id;
    btn.textContent = `与 ${a.displayName} 新建`;
    btn.onclick = () => void (async () => {
      box.classList.add('hidden');
      const r = await command('conversation.create', { projectId: state.projectId, peerMemberId: a.id });
      await renderDmSidebar();
      await openDm(r.conversationId);
    })().catch((e) => showError(`新建私信失败：${e.message}`));
    box.append(btn);
  }
  box.classList.remove('hidden');
})();
el('dm-back-btn').onclick = () => { showPool(); void renderPool().catch(() => {}); void renderDmSidebar().catch(() => {}); };
el('dm-send').onclick = () => void sendDm();
el('dm-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendDm(); } });
el('dm-record').onclick = () => {
  state.dmRecordOnly = !state.dmRecordOnly;
  el('dm-record').classList.toggle('on', state.dmRecordOnly);
};
// DM 版本验收（第二十轮一补齐绑定——第十九轮补丁静默丢失，按钮无 onclick）：accept 绑定
// 展示时 deliveryId/revision；reject 意见必填（行内输入——不用 prompt，避免阻塞）。
// 重命名（补齐绑定）：expectedRevision=展示时 revision；不换对端/不重置历史或 session。
// DEV-23（第二十四轮四）：每日提醒入口——经 reminder.schedule 正式命令（任意分钟可靠；
// 默认**不**自动执行：到点后在「待我处理」确认——autoDispatch 需在提醒管理里显式勾选）。
el('dm-remind-btn').onclick = () => void (async () => {
  if (state.projectId == null || state.openDmId == null || state.dmActive == null) return;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  try {
    const r = await command('reminder.schedule', {
      projectId: state.projectId, conversationId: state.openDmId,
      ownerMemberId: state.dmActive.peerMemberId, title: `每日提醒：${state.dmActive.peerDisplayName ?? '会话'}`,
      schedule: { kind: 'daily', time },
    });
    showError(`已设每日提醒（${time} 本地时刻）——下次 ${new Date(r.nextAt).toLocaleString()}；到点后在「待我处理」确认执行`);
  } catch (e) { showError(`设置提醒失败：${e.message}`); }
})().catch(() => {});
// ---------- DEV-18 第二包绑定（第二十五轮四）：搜索/收藏/关注·静音（纯读+偏好写） ----------
wireAttach('dm');
wireAttach('composer');
// ---------- 工具面板统一视图状态（第四十四轮 §3，review-r43 §5 反例）----------
// 看板/Files/动态与主内容区互斥呈现；工具可见性（三个布尔守卫）、hidden 类与 data-view
// 三者由本组函数唯一维护，不再出现「handler 清了 hidden 但 data-view="dm" 强制隐藏」的
// 架空态。私信/线程视图下显式打开工具=暂离该视图（data-view 切回 pool 侧，DM 收起规则
// 不再适用）；关闭时返回原视图——会话/线程身份、草稿与导航代次全程不动。
let toolActive = null; // 'board' | 'files' | 'activity' | null
let toolReturn = null; // 'dm' | 'thread' | null（打开工具前的主视图——关闭时返回）
function showToolPanel(which) {
  if (toolActive == null) {
    const view = document.querySelector('main.main')?.getAttribute('data-view');
    toolReturn = view === 'dm' ? 'dm' : (view === 'thread' ? 'thread' : null);
    if (toolReturn === 'dm') el('dm').classList.add('hidden');
    if (toolReturn === 'thread') el('thread').classList.add('hidden');
    if (toolReturn != null) document.querySelector('main.main')?.setAttribute('data-view', 'pool');
  }
  toolActive = which;
  boardVisible = which === 'board'; filesVisible = which === 'files'; activityVisible = which === 'activity';
  el('board').classList.toggle('hidden', which !== 'board');
  el('files').classList.toggle('hidden', which !== 'files');
  el('activity').classList.toggle('hidden', which !== 'activity');
  el('pool').classList.add('hidden');
}
function hideToolPanel() {
  const back = toolReturn;
  toolActive = null; toolReturn = null;
  boardVisible = false; filesVisible = false; activityVisible = false;
  el('board').classList.add('hidden');
  el('files').classList.add('hidden');
  el('activity').classList.add('hidden');
  if (back === 'dm') { el('dm').classList.remove('hidden'); document.querySelector('main.main')?.setAttribute('data-view', 'dm'); }
  else if (back === 'thread') { el('thread').classList.remove('hidden'); document.querySelector('main.main')?.setAttribute('data-view', 'thread'); }
  else el('pool').classList.remove('hidden');
  return back;
}
/** 视图入口归零（openDm/showPool/openThread）：工具态与主视图切换互不残留。 */
function resetToolPanels() {
  toolActive = null; toolReturn = null;
  boardVisible = false; filesVisible = false; activityVisible = false;
  el('board').classList.add('hidden');
  el('files').classList.add('hidden');
  el('activity').classList.add('hidden');
}
function closeToolReturn() {
  const back = hideToolPanel();
  el('thread-title').textContent = back === 'dm' ? '私信' : back === 'thread' ? '任务回复串' : '主对话池';
  if (back == null) void renderPool().catch(() => {});
}
el('board-toggle').onclick = () => {
  if (toolActive === 'board') { closeToolReturn(); return; }
  showToolPanel('board');
  void renderBoard().catch(() => {});
  el('thread-title').textContent = '看板';
};
el('board-refresh').onclick = () => void renderBoard().catch(() => {});
el('board-scope').addEventListener('change', () => void renderBoard().catch(() => {}));
el('files-toggle').onclick = () => {
  if (toolActive === 'files') { closeToolReturn(); return; }
  showToolPanel('files');
  void renderFiles().catch(() => {});
  el('thread-title').textContent = 'Files';
};
el('files-refresh').onclick = () => void renderFiles().catch(() => {});
el('files-scope').addEventListener('change', () => void renderFiles().catch(() => {}));
// Activity 流（第三十轮六）：工具区入口——只读聚合（零运行零唤醒）。
el('activity-toggle').onclick = () => {
  if (toolActive === 'activity') { closeToolReturn(); return; }
  showToolPanel('activity');
  void renderActivity().catch(() => {});
  el('thread-title').textContent = '动态';
};
el('activity-refresh').onclick = () => void renderActivity().catch(() => {});
el('activity-scope').addEventListener('change', () => void renderActivity().catch(() => {}));
wireExportControls(); // 导出控件（线程/私信头部——第三十轮五）
el('search-go').onclick = () => void doSearch(1).catch(() => {});
el('search-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void doSearch(1).catch(() => {}); });
el('search-prev').onclick = () => void doSearch(Math.max(1, searchState.page - 1)).catch(() => {});
el('search-next').onclick = () => void doSearch(searchState.page + 1).catch(() => {});
el('thread-follow-btn').onclick = () => void (async () => {
  if (state.openThreadId == null) return;
  const nextFollow = el('thread-follow-btn').dataset.followed !== '1';
  try { await command('thread.subscribe', { threadId: state.openThreadId, follow: nextFollow }); } catch (e) { showError(`关注操作失败：${e.message}`); }
  await refreshThreadSubButtons();
  await renderPendingList();
})().catch(() => {});
el('thread-mute-btn').onclick = () => void (async () => {
  if (state.openThreadId == null) return;
  const nextMute = el('thread-mute-btn').dataset.muted !== '1';
  try { await command('thread.subscribe', { threadId: state.openThreadId, mute: nextMute }); } catch (e) { showError(`静音操作失败：${e.message}`); }
  await refreshThreadSubButtons();
})().catch(() => {});
el('dm-rename-btn').onclick = () => void (async () => {
  const active = state.dmActive;
  if (active == null) return;
  const title = prompt('会话名称：', active.title ?? active.peerDisplayName);
  if (title == null || title.trim().length === 0) return;
  try {
    await command('conversation.rename', { conversationId: active.conversationId, title: title.trim(), expectedRevision: active.revision });
  } catch (e) { showError(`重命名失败：${e.message}`); }
  await renderDm();
  void renderDmSidebar().catch(() => {});
})();
el('dm-review-accept').onclick = () => void (async () => {
  const review = state.dmActive?.currentReview ?? state.dmActive?.pendingReview;
  if (review == null) return;
  try {
    // 三重绑定（第二十三轮三）：id+revision+manifestHash——错稿防线最后一级。
    await command('task.review', { taskId: review.taskId, deliveryId: review.deliveryId, deliveryRevision: review.revision, manifestHash: review.manifestHash, decision: 'accept' });
  } catch (e) { showError(`验收失败：${e.message}`); }
  await renderDm();
})().catch(() => {});
el('dm-review-reject').onclick = () => {
  const row = el('dm-review-row');
  // 目标固定（第四十五轮·review-r44 §3）：**打开意见框时**捕获会话身份+三重绑定快照——
  // 输入期间轮询刷新（currentReview 变化/定位消费）、甚至切换会话都不换稿；确认只审该快照。
  // 上一目标的残留输入框一律移除后按当前展示重建（不再「已存在即返回」）。
  const reviewAtOpen = state.dmActive?.currentReview ?? state.dmActive?.pendingReview;
  if (reviewAtOpen == null) return;
  const conversationAtOpen = state.openDmId;
  row.querySelector('#dm-review-note-input')?.remove();
  const input = document.createElement('input');
  input.id = 'dm-review-note-input';
  input.className = 'git-input';
  input.placeholder = '要求修改的意见（必填——将注入返工输入）';
  input.maxLength = 500;
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'danger';
  confirmBtn.textContent = '提交返工意见';
  const closeNoteRow = () => { input.remove(); confirmBtn.remove(); };
  confirmBtn.onclick = () => void (async () => {
    const note = input.value.trim();
    if (note.length === 0) { input.focus(); return; }
    // 会话已切换：明确拒绝并作废——不能把旧意见提交到另一会话的当前交付。
    if (state.openDmId !== conversationAtOpen) {
      closeNoteRow();
      showError('返工意见已作废：会话已切换——请在目标会话重新发起（意见不自动套用到其它交付）');
      return;
    }
    // 同会话：只审打开时快照；期间版本更新由后端按 revision/hash 拒（STALE_REVISION）——不悄悄换稿。
    try {
      await command('task.review', { taskId: reviewAtOpen.taskId, deliveryId: reviewAtOpen.deliveryId, deliveryRevision: reviewAtOpen.revision, manifestHash: reviewAtOpen.manifestHash, decision: 'changes_requested', note });
      closeNoteRow();
    } catch (e) { showError(`提交返工意见失败（第 ${reviewAtOpen.revision} 版快照）：${e.message}`); }
    await renderDm();
  })().catch(() => {});
  row.querySelector('.git-row').append(input, confirmBtn);
  input.focus();
};
el('dm-stop-btn').onclick = () => void (async () => {
  const active = state.dmActive;
  if (active?.activeTaskId == null) return;
  try {
    await command('task.stop', { taskId: active.activeTaskId, targetRunId: active.activeRunId, expectedStopGeneration: active.activeStopGeneration ?? 0 });
    el('dm-state').textContent = '停止请求已发（排队消息转暂停）';
  } catch (e) { el('dm-state').textContent = `停止失败：${e.message}`; }
  await renderDm();
})().catch(() => {});
el('dm-resume-btn').onclick = () => void (async () => {
  // 继续队列（#5 反馈：成功/泵出条数/无待处理分别可见——不再「点了没反应」）。
  try {
    const r = await command('dm.resume', { conversationId: state.openDmId });
    const n = r?.enqueued ?? 0;
    el('dm-state').textContent = n > 0 ? `已继续队列（泵出 ${n} 条排队消息——串行执行）` : '已继续：当前无待处理的排队消息';
  } catch (e) { el('dm-state').textContent = `继续失败：${e.message}`; }
  await renderDm();
  void renderDmSidebar().catch(() => {});
})().catch(() => {});
// 恢复执行（第三十八轮 #7：中断待恢复任务=ACTIVE 但唯一 run 已终态——泵永不推进；经
// task.redispatch 正式重派链（核对停止代次/在途/终态/幂等），不自动重放、不复活已取消任务）。
el('dm-recover-btn').onclick = () => void (async () => {
  const fresh = state.dmConversations?.find((c) => c.conversationId === state.openDmId);
  const target = (fresh?.interruptedTasks ?? []).find((t) => t.recoverable !== false);
  if (target == null) { el('dm-state').textContent = '无中断待恢复的任务'; return; }
  try {
    // 恢复意图绑源执行（第三十九轮 §2.2：同源重试幂等/新中断=新源 run=新意图）。
    await command('task.redispatch', { taskId: target.taskId, reason: 'interrupted-recovery', ...(target.lastRunId != null ? { sourceRunId: target.lastRunId } : {}) });
    el('dm-state').textContent = `恢复执行已入队（任务「${target.title}」——按原输入重新执行）`;
  } catch (e) { el('dm-state').textContent = `恢复失败：${e.message}`; }
  await renderDm();
  void renderDmSidebar().catch(() => {});
})().catch(() => {});
el('dm-archive-btn').onclick = () => void (async () => {
  const active = state.dmActive;
  if (active == null) return;
  try {
    await command('conversation.archive', { conversationId: active.conversationId, expectedRevision: active.revision });
  } catch (e) { showError(`归档失败：${e.message}`); }
  await renderDm();
  void renderDmSidebar().catch(() => {});
})();
el('dm-restore-btn').onclick = () => void (async () => {
  await command('conversation.restore', { conversationId: state.openDmId });
  await renderDm();
  void renderDmSidebar().catch(() => {});
})().catch((e) => showError(`取消归档失败：${e.message}`));
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
    if (binding?.environment != null) state.runtimeEnvironment = binding.environment; // 防护包模式标志（绑定对话框 fake 选项）
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
      // 验收防护包（第三十八轮 #2）：真实渠道被拒绑——提供 fake 正路径（用户不再需要脚本自救）；
      // 正式部署 environment 两标志皆 false=选项不出现（fake 不入产品设置面原决策不变）。
      const runtimeEnv = state.runtimeEnvironment ?? { realDispatchGuard: false, allowFake: false };
      for (const old of box.querySelectorAll('.member-runtime-edit')) old.remove();
      const edit = document.createElement('div');
      edit.className = 'member-runtime-edit meta';
      const kinds = [['claude', 'claude（CLI 渠道）'], ['codex', 'codex（App Server）']];
      if (runtimeEnv.realDispatchGuard === true && runtimeEnv.allowFake === true) kinds.push(['fake', 'fake（模拟——验收防护包唯一可绑定渠道）']);
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
    { key: 'absenceToleranceMs', label: '成员无响应后继续（分钟；只影响之后开始的等待）', value: data.absenceToleranceMs },
    { key: 'turnDeadlineMs', label: '单轮运行时限（秒，留空=继承；0=关闭；只对之后开始的执行生效）', value: data.turnDeadlineMs },
  ];
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'meta';
    const input = document.createElement('input');
    input.type = 'number';
    const deadlineField = f.key === 'turnDeadlineMs';
    input.min = deadlineField ? '0' : '1';
    input.max = deadlineField ? '86400' : '1440';
    input.step = deadlineField ? '0.001' : '1';
    input.placeholder = deadlineField
      ? (data.effectiveTurnDeadlineMs == null ? '继承（不设上限）' : `继承（${data.effectiveTurnDeadlineMs / 1000} 秒）`)
      : '默认';
    input.value = f.value != null ? (deadlineField ? String(f.value / 1000) : String(Math.round(f.value / 60000))) : '';
    input.title = deadlineField ? '留空=继承；0=关闭；自定义至少 10 秒、最多 24 小时' : '范围 1–1440 分钟；清空使用默认等待时间';
    const err = document.createElement('span');
    err.className = 'meta';
    const submit = async () => {
      err.textContent = '保存中…';
      const raw = input.value.trim();
      const ms = raw === '' ? null : Number(raw) * (deadlineField ? 1000 : 60000);
      if (ms != null && (!Number.isInteger(ms) || (deadlineField ? ms !== 0 && ms < 10_000 : ms < 10_000) || ms > 86_400_000)) {
        err.textContent = deadlineField ? '留空=继承；0=关闭；自定义须为至少 10 秒、最多 24 小时' : '范围要求：1–1440 分钟（整数）；未保存';
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
// 第四十三轮 UI-03：预览工具条——展开/收起（expanded 档放大视觉区，CSS max-height 联动）；
// 关闭=统一收口（代次作废+资源释放+面板/工具条/工具行收起——与消息内「关闭预览」同链）。
{
  const expandBtn = el('attach-preview-expand');
  if (expandBtn != null) {
    expandBtn.onclick = () => {
      const panel = el('attach-preview');
      if (panel == null) return;
      const expanded = panel.classList.toggle('expanded');
      expandBtn.textContent = expanded ? '⤡ 收起预览' : '⤢ 展开预览';
    };
  }
  const collapseBtn = el('attach-preview-collapse');
  if (collapseBtn != null) collapseBtn.onclick = () => closeAttachPreview();
}
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
  // 项目缺失即补载（第三十八轮 #8：重启服务端后启动恢复常在 daemon 未就绪时失败，此前
  // onReconnected 只重绘视图不重载项目——侧栏/房间保持空白直到手动 Reload）。侧栏与私信
  // 列表随后由 loadProject 自行刷新。
  if (state.projectId == null) {
    const p = localStorage.getItem('zs.lastProjectPath');
    if (p != null && p.length > 0) {
      navAuditPush({ what: 'reconnect.reloadProject', path: p });
      void loadProject(p, { from: 'reconnect' }).catch((e) => { el('project-name').textContent = `恢复项目失败：${e.message}`; });
    }
  }
  void (state.openThreadId != null ? renderThread() : renderPool()).catch(showConnError);
});
zs.onDemoStatus((status) => { el('conn-state').textContent = status; });

// R5：重启后恢复上次项目（失败如实展示，不回退种子数据）。
// ---------- 远程访问设置（DEV-25 第三十一轮三/五：本机可信入口）----------
// 第四十三轮 UI-04（v5 图2：实际监听 0.0.0.0/LAN，选择框却显示「仅本机」）：编辑控件与
// 已应用配置分离——刷新把控件同步为**已应用值**（运行事实），正在编辑（dirty）时不覆盖；
// 应用成功后清除 dirty 再刷新。禁止把 LAN 实际运行呈现成已应用回环配置。
let remoteEditDirty = false;
function syncRemoteEditControls(cfg) {
  if (remoteEditDirty) return; // 刷新不覆盖正在编辑的值（未应用编辑）
  const sel = el('remote-host-sel');
  if (sel != null && (cfg.listenHost === '127.0.0.1' || cfg.listenHost === '0.0.0.0')) sel.value = cfg.listenHost;
  const portInput = el('remote-port-input');
  if (portInput != null && cfg.port > 0) portInput.value = String(cfg.port);
}
async function renderRemoteSettings() {
  const row = el('remote-config-row');
  const deviceBox = el('remote-device-list');
  if (row == null) return;
  try {
    const cfg = await command('remote.config.get', {});
    syncRemoteEditControls(cfg);
    // 已应用配置事实行（与上方编辑下拉分列——下拉是「待应用编辑」，本行是服务端已生效值）。
    const appliedNote = document.createElement('div');
    appliedNote.className = 'meta';
    appliedNote.textContent = `已应用配置：监听 ${cfg.listenHost}:${cfg.port}${cfg.allowLan ? ' · 局域网' : ' · 仅本机'}${cfg.running ? '（运行中——上方下拉为待应用编辑，点「启用」生效）' : '（当前停用）'}${remoteEditDirty ? '；检测到未应用的编辑' : ''}`;
    row.replaceChildren(appliedNote);
    if (cfg.running) {
      const addr = document.createElement('button');
      addr.className = 'chip';
      addr.title = '点击复制客户端地址';
      addr.textContent = `运行中 ${cfg.address}`;
      addr.onclick = () => void navigator.clipboard.writeText(String(cfg.address)).then(() => showError(`已复制地址：${cfg.address}`), (e) => showError(`复制失败：${e.message}`));
      const fp = document.createElement('button');
      fp.className = 'chip';
      fp.title = '点击复制完整证书 SHA-256 指纹（64 位十六进制——设备端逐位核对）';
      fp.textContent = `指纹 ${String(cfg.fingerprint ?? '')}`;
      fp.onclick = () => void navigator.clipboard.writeText(String(cfg.fingerprint ?? '')).then(() => showError('已复制完整指纹（64 位）'), (e) => showError(`复制失败：${e.message}`));
      row.append(addr, fp);
      // 信任根（CA）指纹+服务证书签发者（第三十六轮一：两层证书——用户导入 ca.cer 时核对 CA 指纹）。
      const caFp = document.createElement('button');
      caFp.className = 'chip';
      caFp.title = '点击复制信任根（CA）完整 SHA-256 指纹——客户端导入 ca.cer 时逐位核对';
      caFp.textContent = `信任根指纹 ${String(cfg.caFingerprint ?? '')}`;
      caFp.onclick = () => void navigator.clipboard.writeText(String(cfg.caFingerprint ?? '')).then(() => showError('已复制 CA 完整指纹（64 位）'), (e) => showError(`复制失败：${e.message}`));
      row.append(caFp);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `证书 Subject=${cfg.certSubject ?? '?'} · Issuer=${cfg.certIssuer ?? '?'} · 有效期至 ${cfg.certNotAfter ? new Date(cfg.certNotAfter).toLocaleString() : '?'}（监听=${cfg.listenHost}:${cfg.port}${cfg.allowLan ? ' · LAN' : ' · 仅本机'}）`;
      row.append(meta);
      // LAN 地址明细（第三十八轮：多网卡逐地址可复制+虚拟网卡标注——UI 监听选项只有回环与
      // 0.0.0.0 两种，客户端实际访问哪个地址从这份列表选；虚拟段（198.18.x.x 等）明确标注
      // 「不是其它设备可达的地址」，不再混在推荐里）。
      const details = cfg.lanAddressDetails ?? [];
      if (details.length > 0) {
        for (const d of details) {
          const b = document.createElement('button');
          b.className = 'chip';
          b.title = d.note != null ? d.note : '点击复制该地址（客户端浏览器访问）';
          b.textContent = d.url;
          b.onclick = () => void navigator.clipboard.writeText(d.url).then(() => showError(`已复制地址：${d.url}`), (e) => showError(`复制失败：${e.message}`));
          row.append(b);
          if (d.note != null) {
            const n = document.createElement('div');
            n.className = 'meta';
            n.textContent = `${d.address}：${d.note}`;
            row.append(n);
          }
        }
      } else if ((cfg.lanAddresses ?? []).length > 0) {
        const n = document.createElement('div');
        n.className = 'meta';
        n.textContent = `LAN 地址：${cfg.lanAddresses.join(' / ')}`;
        row.append(n);
      }
      // 分层核验（第三十六轮二）：仅本机明确提示；LAN 模式呈现本机经实际 LAN IP 的 HTTPS 自检。
      const lanNote = document.createElement('div');
      lanNote.className = 'meta';
      if (cfg.allowLan) {
        const sc = cfg.lanSelfCheck;
        lanNote.textContent = sc == null ? 'LAN 自检未取得（服务运行中稍候刷新）' : (sc.ok ? `LAN 自检通过（${sc.checkedUrl}——本机经实际 LAN IP 的 HTTPS/TLS 可达）` : `LAN 自检失败：${sc.error}（本机绑定/TLS 层——先修本机，再查跨机防火墙；跨机问题需客户端具体错误码定位）`);
      } else {
        lanNote.textContent = '仅本机模式：仅 127.0.0.1 可访问——其它设备无法连接；需要客户端访问请切换「局域网」并启用';
      }
      row.append(lanNote);
    } else {
      const stopped = document.createElement('div');
      stopped.className = 'meta';
      stopped.textContent = `已停用（监听=${cfg.listenHost}:${cfg.port}${cfg.allowLan ? ' · LAN' : ' · 仅本机'}${cfg.enabled && !cfg.running ? ' · 启用失败见 daemon 日志' : ''}）`;
      row.append(stopped);
    }
    if (deviceBox != null) {
      try {
        const r = await command('remote.devices.list', {});
        deviceBox.textContent = '';
        if ((r.devices ?? []).length === 0) { deviceBox.textContent = '暂无设备。'; }
        for (const d of r.devices) {
          const line = document.createElement('div');
          const name = document.createElement('span');
          name.textContent = `${d.deviceName}（${d.deviceId.slice(0, 12)}… · ${d.revokedAt != null ? '已吊销' : `最近 ${d.lastSeenAt != null ? new Date(d.lastSeenAt).toLocaleString() : '未见'}`}）`;
          line.append(name);
          if (d.revokedAt == null) {
            const btn = document.createElement('button');
            btn.className = 'chip';
            btn.textContent = '吊销';
            btn.onclick = () => void command('remote.device.revoke', { deviceId: d.deviceId }).then(() => renderRemoteSettings()).catch((e) => showError(`吊销失败：${e.message}`));
            line.append(btn);
          }
          deviceBox.append(line);
        }
      } catch (e) { deviceBox.textContent = `设备清单读取失败：${e.message}`; }
    }
  } catch (e) { row.textContent = `远程配置读取失败：${e.message}`; }
}
function wireRemoteSettings() {
  // 第四十三轮 UI-04：编辑 dirty 标记——用户改动下拉/端口后，刷新不再把控件拉回已应用值。
  el('remote-host-sel')?.addEventListener('change', () => { remoteEditDirty = true; });
  el('remote-port-input')?.addEventListener('input', () => { remoteEditDirty = true; });
  const apply = (enabled, allowLan) => void (async () => {
    try {
      const host = el('remote-host-sel')?.value ?? '127.0.0.1';
      const port = Number(el('remote-port-input')?.value ?? '0') || 0;
      await command('remote.config.set', { enabled, listenHost: host, port, allowLan });
      remoteEditDirty = false; // 已应用：编辑值成为已应用配置——刷新可同步
      showError(enabled ? `远程访问已启用（${host}:${port || '自动'}${allowLan ? ' · LAN' : ''}）` : '远程访问已停用');
      await renderRemoteSettings();
    } catch (e) { showError(`远程配置失败：${e.message}`); }
  })();
  el('remote-enable-btn').onclick = () => apply(true, (el('remote-host-sel')?.value ?? '127.0.0.1') !== '127.0.0.1');
  el('remote-disable-btn').onclick = () => apply(false, false);
  const scBtn = el('remote-pair-selfcheck-btn');
  if (scBtn != null) {
    scBtn.onclick = () => void (async () => {
      const out = el('remote-pair-result');
      try {
        const r = await command('remote.pairing.selfcheck', {});
        out.textContent = '';
        const s = document.createElement('div');
        s.textContent = `自检 ${r.pass}/${r.total}${r.ok ? '（全部通过）' : '（存在失败项——见明细）'}`;
        const d = document.createElement('div');
        d.className = 'meta';
        d.textContent = (r.items ?? []).map((i) => `${i.ok ? '✓' : '✗'} ${i.name}`).join('；') + (r.resultsFile ? `——结果文件 ${r.resultsFile}` : '');
        out.append(s, d);
      } catch (e) { showError(`自检失败：${e.message}（仅隔离验收模式开放——正式入口不带）`); }
    })();
  }
  el('remote-pair-btn').onclick = () => void (async () => {
    const out = el('remote-pair-result');
    try {
      const r = await command('remote.pairing.create', {});
      out.textContent = '';
      const line1 = document.createElement('div');
      line1.textContent = `配对码：${r.pairingId} / ${r.code}（${new Date(r.expiresAt).toLocaleTimeString()} 前一次有效）${r.address != null ? ` · 地址 ${r.address}` : ' · 服务未启用'}`;
      const fpLine = document.createElement('div');
      fpLine.className = 'meta';
      fpLine.textContent = r.fingerprint != null ? `证书 SHA-256 指纹（完整逐位核对）：${r.fingerprint}` : '';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'chip';
      copyBtn.textContent = '复制指纹';
      copyBtn.onclick = () => void navigator.clipboard.writeText(String(r.fingerprint ?? '')).then(() => showError('已复制完整指纹（64 位）'), (e) => showError(`复制失败：${e.message}`));
      out.append(line1, fpLine);
      if (r.fingerprint != null) out.append(copyBtn);
    } catch (e) { out.textContent = `配对码创建失败：${e.message}`; }
  })();
  const rs = el('remote-settings');
  if (rs != null) rs.addEventListener('toggle', () => { if (rs.open) void renderRemoteSettings(); }); // 展开即刷新（配对后的设备清单可见）
  void renderRemoteSettings();
}
wireRemoteSettings();

renderProjectSettings(); // 未打开项目时的初始态（loadProject 成功后随项目数据刷新）
// 启动恢复（第三十八轮 #8：有界重试——daemon 就绪竞态不再「失败一次即空白等手动 Reload」）：
// 指数退避 500ms→8s，上限 6 次≈27s；每次失败都可见（project-name 如实呈现第 N 次与原因），
// 成功即止。重连（onReconnected）兜底另接。
// 换装壳接管（第四十六轮 H1）：hifi 壳为默认界面时，legacy 的自动装载/首启轮询延迟到用户
// 首次进入「原界面」才执行（避免双装载双轮询）；hifi 加载失败（__zsHifiFailed）自动回退启动。
const startLegacyBoot = () => {
const lastProject = localStorage.getItem('zs.lastProjectPath');
if (lastProject != null && lastProject.length > 0) {
  void (async () => {
    const delays = [500, 1000, 2000, 4000, 8000, 8000];
    let lastErr = null;
    for (let i = 0; i <= delays.length; i += 1) {
      try {
        await loadProject(lastProject, { from: 'startup' });
        return;
      } catch (e) {
        lastErr = e;
        if (i < delays.length) {
          el('project-name').textContent = `恢复项目失败（第 ${i + 1} 次，${delays[i]}ms 后重试）：${e.message}`;
          navAuditPush({ what: 'startup.retry', attempt: i + 1, error: String(e.message).slice(0, 160) });
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, delays[i]));
        }
      }
    }
    el('project-name').textContent = `恢复项目失败（已重试 ${delays.length + 1} 次）：${lastErr?.message ?? '未知错误'}——服务重新就绪后会自动重试，或手动重开项目`;
  })();
} else {
  // 服务端记忆回退（第二十六轮二）：清缓存/换机后 localStorage 为空——读 daemon 持久设置
  //（ui.autoOpenProjectPath，loadProject 成功时写入）自动恢复上次项目。通知人工验收入口
  //（合成项目）与正常使用同链路，不新增专用分支。
  // 第四十三轮 P0（v5 首启现场：种子在应用启动后才写记忆路径，单次读取早于种子完成→侧栏
  // 空白，用户被迫手动打开）：改**有界后台轮询**——欢迎页照常呈现不阻塞；记忆出现即自动
  // 装载（全新数据首启自动可见，不靠 reload/手动打开）；用户手动打开项目或装载成功即停；
  // 60×1s 上限。与 localStorage 主路径、重启恢复（R3）分别验证。
  const pollCancelled = () => state.projectId != null || state.startupMemoryPollCancelled === true;
  void (async () => {
    for (let i = 0; i < 60; i += 1) {
      if (pollCancelled()) return;
      try {
        const r = await command('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
        const remembered = r?.values?.['ui.autoOpenProjectPath'];
        if (typeof remembered === 'string' && remembered.length > 0) {
          if (pollCancelled()) return;
          await loadProject(remembered);
          return;
        }
      } catch { /* daemon 未就绪/读取失败——继续轮询（有界） */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r2) => setTimeout(r2, 1000));
    }
  })();
}
};
window.__zsLegacyStart = startLegacyBoot;
if (!window.__zsHifiWanted || window.__zsHifiFailed === true) startLegacyBoot();
// 深链导航事件（第二十三轮二）：刷新/直接打开/前进后退共用统一导航入口；导航代次防迟到。
window.addEventListener('hashchange', () => { if (!legacyOwnsNavigation()) return; void restoreDmDeepLink().catch(() => {}); });
window.addEventListener('popstate', () => { if (!legacyOwnsNavigation()) return; void restoreDmDeepLink().catch(() => {}); });

// 页面可操作标志（第二十二轮一）：全部事件绑定完成——验证器/自动化以此为"点击必被处理"
// 的判据（区别于 CDP target 出现：那只是导航开始，onclick 尚未绑定，早到点击会静默丢失）。
window.__zsReady = true;
})();
