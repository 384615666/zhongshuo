/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R183 界面反馈轮截图核对（隔离数据；零真实模型；不碰用户运行数据）。
 *
 * 用法：
 *   node scripts/capture-r183-ui.cjs                     # 全部场景
 *   node scripts/capture-r183-ui.cjs --only=members,add-scan
 *   node scripts/capture-r183-ui.cjs --run=r183-prep     # 产物目录 dist/r183-ui/r183-prep
 * 前置：node scripts/build-ui.mjs（dist/ui/main.cjs）与 dist/pack/daemon.cjs 已存在。
 *
 * 与 r170 脚本的差异：
 *  - 产物目录 dist/r183-ui/<run>，隔离数据根在 run/data（不写 dist/r183-fixture 之外的用户数据）。
 *  - 命令记录不再靠页面侧 patch window.zs（contextBridge 对象只读），而是在 session 级额外 preload
 *    里包一层 ipcRenderer.invoke，只记录 channel='zs:command' 的方法名/参数，再经 contextBridge
 *    暴露成 window.r183（commands()/clear()）。这样场景 JS 能在页面里直接断言命令**顺序**，
 *    也不需要 ZS_COMMAND_LOG_FILE 之类会写文件的产品钩子。
 *  - 每个场景可通过 viewport 指定窗口内容尺寸（布局对称要在 1360x900 与 1873x740 各量一次）。
 *  - 场景可标记 keepOpen（保留弹窗截图）与 reloadAfter（重载页面后再验证本地顺序持久化）。
 *
 * 场景与验收点（用户 2026-11-04 九项）：
 *  - members / members-switch / members-no-flash：第 2、3、5、6、7 项（左栏对称由 layout 场景量化）
 *  - add-scan：第 4 项（点「添加 AI」先 member.discoverDefaults，再开弹窗；页面无「扫描本机 AI」）
 *  - ai-settings / ai-settings-save：第 6 项（AI 设置弹窗内可改名称/说明；只改资料只发 member.update，
 *    改配置先 member.update 再 member.setRuntime，且 setRuntime 用 update 返回的新 revision）
 *  - template-add / template-add-submit：第 8 项（模板卡打开同一个添加 AI 弹窗并预填；提交走 member.create）
 *  - board-rail / board-archive / board-undo：第 9 项（左栏「全部项目」卡 + 项目卡；删除范围/项目下拉）
 *  - layout-symmetry-1360 / layout-symmetry-1873：第 2、9 项几何（卡片左缘到页面内容左缘 =
 *    卡片右缘到右栏内容左缘，±2px；1360 宽按 24px、1873 宽按 40px 页边距）
 *  - sidebar-drag / sidebar-drag-reload：第 1 项（合成 DragEvent 拖动项目/房间；localStorage 落盘；
 *    重载后顺序保持；置顶项目排最前）
 *
 * 注意：场景断言是**验证断言**，不是产品断言；当前代码没实现时失败属预期（--run=r183-prep 基线）。
 * 只允许在隔离数据目录运行；不打包、不安装、不调真实模型、不提交 git。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg == null ? [] : onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const runArg = process.argv.find((arg) => arg.startsWith('--run='));
const runName = runArg == null
  ? 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r183-ui', runName);
const data = path.join(run, 'data');
const project = path.join(run, '工作区', '读书会筹备');
// 同一 --run 名重跑时必须先清掉隔离数据与夹具项目：否则第二次 git commit 会因
// 「nothing to commit」失败，或旧数据库与本次种子混在一起（不是确定性的基线）。
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(path.join(run, '工作区'), { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(path.dirname(project), { recursive: true });

const mainCjs = path.join(root, 'dist', 'ui', 'main.cjs');
if (!fs.existsSync(mainCjs)) {
  console.error('缺少 dist/ui/main.cjs：请先运行 node scripts/build-ui.mjs');
  process.exit(2);
}
const daemonEntry = path.join(root, 'dist', 'pack', 'daemon.cjs');
if (!fs.existsSync(daemonEntry)) {
  console.error('缺少 dist/pack/daemon.cjs：截图脚本不重建打包，请先准备该文件');
  process.exit(2);
}

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data,
  ZS_RUNTIME: 'fake',
  ZS_ALLOW_FAKE: '1',
  ZS_REAL_DISPATCH_GUARD: '1',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r183-' + randomUUID(),
  ZS_DAEMON_ENTRY: daemonEntry,
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

/* ---------------- 会话级记录 preload（只记录 zs:command 信封，不改变行为） ---------------- */
const recordPreloadPath = path.join(run, 'r183-record-preload.cjs');
fs.writeFileSync(recordPreloadPath, String.raw`/* R183 截图专用：记录 renderer 经 preload 发出的 zs:command（方法名+参数）。 */
const { ipcRenderer, contextBridge } = require('electron');
const entries = [];
const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
const plain = (value) => {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
};
ipcRenderer.invoke = (channel, payload) => {
  try {
    if (channel === 'zs:command' && payload != null && typeof payload === 'object' && typeof payload.method === 'string') {
      entries.push({ at: Date.now(), method: payload.method, params: plain(payload.params) });
    }
  } catch { /* 记录失败不能影响产品命令 */ }
  return originalInvoke(channel, payload);
};
contextBridge.exposeInMainWorld('r183', {
  commands: () => entries.slice(),
  clear: () => { entries.length = 0; },
});
`);

/* ---------------- 页面场景 ---------------- */
const key = 'zhongshuo.nav.listOrder.v1';
const scenesSource = String.raw`(() => {
  const m = window.r183Meta;
  if (m == null) throw Error('缺少隔离夹具元数据');
  const KEY = '` + key + String.raw`';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check, label, timeout) => {
    const end = Date.now() + (timeout || 20000);
    while (Date.now() < end) {
      let ok = false;
      try { ok = !!check(); } catch { ok = false; }
      if (ok) return;
      await wait(80);
    }
    throw Error('等待超时：' + (label || ''));
  };
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => Array.from(document.querySelectorAll(selector));
  const textOf = (el) => (el == null ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
  const go = async (route) => { window.location.hash = '#' + route; await wait(700); };
  const checks = [];
  window.r183Checks = checks;
  const check = (name, ok) => { checks.push({ name, ok: !!ok }); if (!ok) throw Error('校验失败：' + name); };
  // 每个场景开始前重置 extra / checks（场景里直接往 extra 上写字段，断言失败时也要留下已观察到的值）。
  let extra = {};
  window.r183Reset = () => { extra = {}; checks.length = 0; window.r183Extra = extra; window.r183Checks = checks; };
  const commands = () => (window.r183 == null ? [] : window.r183.commands());
  const clearCommands = () => { if (window.r183 != null) window.r183.clear(); };
  const methods = () => commands().map((row) => row.method);
  const lastCommand = (method) => commands().filter((row) => row.method === method).slice(-1)[0];
  const untilCommand = async (method, label, timeout) => until(() => commands().some((row) => row.method === method), label || ('命令 ' + method), timeout);
  const WRITE_METHODS = ['member.create', 'member.update', 'member.setRuntime', 'member.setEnabled', 'memberTemplate.saveFromMember', 'memberTemplate.update', 'memberTemplate.createMember', 'project.writeAccess.set', 'app.appearance.set'];
  const writeMethods = () => methods().filter((method) => WRITE_METHODS.indexOf(method) >= 0);
  const sleepFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const closeOverlays = async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(220);
    const dialog = q('[role="dialog"]');
    if (dialog != null) {
      const cancel = qa('[role="dialog"] button').find((button) => textOf(button) === '取消');
      if (cancel != null) { cancel.click(); await wait(180); }
    }
    await sleepFrame();
  };
  const setInput = (el, value) => {
    if (el == null) throw Error('输入框不存在');
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const inputByPlaceholder = (fragment) => qa('input, textarea').find((el) => (el.getAttribute('placeholder') || '').indexOf(fragment) >= 0);
  const fieldInput = (dialog, labelText) => {
    const labels = Array.from((dialog || document).querySelectorAll('label.field'));
    const field = labels.find((el) => textOf(el).indexOf(labelText) >= 0);
    return field == null ? null : field.querySelector('input, textarea');
  };
  const combo = (label) => q('[role="combobox"][aria-label="' + label + '"]');
  const comboText = (label) => textOf(combo(label));
  const chooseOption = async (label, value) => {
    const trigger = combo(label);
    if (trigger == null) throw Error('找不到下拉：' + label);
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    await until(() => qa('[role="listbox"] [role="option"]').length > 0, '下拉选项 ' + label);
    await wait(80);
    const rows = qa('[role="listbox"] [role="option"]');
    const row = rows.find((el) => el.dataset.zsOption === value) || rows.find((el) => textOf(el).indexOf(value) >= 0);
    if (row == null) throw Error('下拉 ' + label + ' 没有选项 ' + value + '（实际：' + rows.map((el) => el.dataset.zsOption).join(',') + '）');
    row.click();
    await wait(160);
  };
  const memberRows = () => qa('[data-zs-member-card]');
  const memberPageReady = async (label) => {
    await until(() => q('[data-zs-members]'), '成员页', 25000);
    await until(() => qa('[data-zs-members-project]').length >= 4, '成员页项目卡（含夹具 4 个项目）', 30000);
    await until(() => memberRows().length >= 1, '成员卡', 30000);
    await wait(700);
  };

  /* 为成员卡「自动说明不显示 / 手填说明保留」准备两位 AI 成员：一个手填说明、一个自动说明。 */
  const prepareMemberDescriptions = async () => {
    const response = await window.zs.command({ protocolVersion: 1, commandId: 'r183-prepare-members-' + Date.now(), method: 'member.list', params: { projectId: m.projectId } });
    const items = (response && response.data && response.data.items) || [];
    const agents = items.filter((member) => member.principalType === 'agent').slice(0, 2);
    if (agents.length < 2) return { skipped: true };
    const hand = '手填说明：负责实现与重构';
    const auto = '由本机默认配置自动添加，可随时修改';
    const applied = [];
    for (let index = 0; index < agents.length; index += 1) {
      const member = agents[index];
      const result = await window.zs.command({ protocolVersion: 1, commandId: 'r183-prepare-desc-' + index + '-' + Date.now(), method: 'member.update', params: { projectId: m.projectId, memberId: member.id, expectedRevision: member.revision, displayName: member.displayName, description: index === 0 ? hand : auto } });
      applied.push(result != null && result.ok === true);
    }
    const refresh = q('[data-zs-members-refresh]') || qa('button').find((button) => textOf(button) === '刷新');
    if (refresh != null) refresh.click();
    await wait(1000);
    return { skipped: false, ids: agents.map((member) => member.id), hand, auto, applied };
  };
  /* 创建一张配置模板（夹具成员绑定 fake；只拿它验证「模板卡片 → 添加 AI 弹窗预填」这条 UI 路径）。 */
  const ensureTemplate = async () => {
    if (qa('[data-zs-template]').length > 0) return { created: false, cards: qa('[data-zs-template]').length };
    const list = await window.zs.command({ protocolVersion: 1, commandId: 'r183-template-list-' + Date.now(), method: 'member.list', params: { projectId: m.projectId } });
    const items = (list && list.data && list.data.items) || [];
    const agent = items.find((member) => member.principalType === 'agent');
    if (agent == null) throw Error('夹具没有可用于保存模板的 AI 成员');
    const saved = await window.zs.command({ protocolVersion: 1, commandId: 'r183-template-save-' + Date.now(), method: 'memberTemplate.saveFromMember', params: { projectId: m.projectId, memberId: agent.id, expectedRevision: agent.revision, name: 'R183 预填模板', description: '模板预填验证' } });
    if (saved == null || saved.ok !== true) throw Error('创建夹具模板失败：' + JSON.stringify(saved && saved.error));
    window.dispatchEvent(new CustomEvent('zs-member-changed', { detail: { projectId: m.projectId } }));
    await until(() => qa('[data-zs-template]').length > 0, '模板卡', 25000);
    await wait(400);
    return { created: true, templateId: saved.data && saved.data.id, kind: saved.data && saved.data.config && saved.data.config.kind, name: saved.data && saved.data.name, description: saved.data && saved.data.description, cards: qa('[data-zs-template]').length };
  };

  /* 合成拖动（Chromium 里 DragEvent 构造器 + DataTransfer；dataTransfer 在部分版本构造器会被忽略，
     所以再用 defineProperty 兜底挂上）。落点按目标行上半→before、下半→after。 */
  const fireDrag = (el, type, y, dataTransfer) => {
    const rect = el.getBoundingClientRect();
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: y == null ? rect.top + rect.height / 2 : y,
    });
    try { Object.defineProperty(event, 'dataTransfer', { value: dataTransfer }); } catch { /* 构造器已带 dataTransfer */ }
    el.dispatchEvent(event);
    return event;
  };
  const projectRows = () => qa('[data-zs-side-project]');
  const projectIds = () => projectRows().map((el) => el.dataset.zsSideProject);
  const findProjectRow = (id) => projectRows().find((el) => el.dataset.zsSideProject === id);
  const roomRows = () => qa('[data-zs-room-row]');
  const findRoomRow = (id) => roomRows().find((el) => el.dataset.zsRoomRow === id);
  /** 合成拖动：dragstart → dragover（产品应 preventDefault，真实浏览器里否则不触发 drop）→ drop。
   *  dragstart 由调用方通过 dataTransfer.setData 带一个 text/plain 负载（Firefox/真实拖拽习惯）。 */
  const dragRow = async (kind, fromId, toId, place) => {
    const findFrom = () => (kind === 'project' ? findProjectRow(fromId) : findRoomRow(fromId));
    const findTo = () => (kind === 'project' ? findProjectRow(toId) : findRoomRow(toId));
    const from = findFrom();
    if (from == null) throw Error('拖动源不存在：' + fromId);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', fromId);
    fireDrag(from, 'dragstart', null, dataTransfer);
    await wait(80);
    const to = findTo();
    if (to == null) throw Error('拖动目标不存在：' + toId);
    const rect = to.getBoundingClientRect();
    const y = place === 'before' ? rect.top + 2 : rect.bottom - 2;
    const over = fireDrag(to, 'dragover', y, dataTransfer);
    const overPrevented = over.defaultPrevented;
    // 真实拖放语义：dragenter/dragover 被 preventDefault 才允许 drop；这里再兜底 preventDefault 一次。
    if (over.cancelable && !overPrevented) over.preventDefault();
    await wait(60);
    const drop = fireDrag(to, 'drop', y, dataTransfer);
    const dropPrevented = drop.defaultPrevented;
    await wait(60);
    try { fireDrag(findFrom() || from, 'dragend', null, dataTransfer); } catch { /* dragend 可有可无 */ }
    await wait(60);
    return { overPrevented, dropPrevented };
  };
  const readOrder = () => {
    try { return JSON.parse(window.localStorage.getItem(KEY) || 'null'); } catch { return null; }
  };

  const scenes = [
    /* ---------- 第 2/3/5/6/7 项：成员管理页 ---------- */
    { name: 'members', run: async () => {
      await go('/project/' + m.projectId + '/members');
      await memberPageReady();
      extra.prepared = await prepareMemberDescriptions();
      extra.template = await ensureTemplate();
      await wait(700);
      const currentCard = q('[data-zs-members-project].is-current') || qa('[data-zs-members-project]').find((el) => el.dataset.zsMembersProject === m.projectId);
      const filters = q('.members-page .page-filters') || q('.page-filters');
      const auto = '由本机默认配置自动添加，可随时修改';
      const hand = '手填说明：负责实现与重构';
      const templateCards = qa('[data-zs-template]');
      extra.headRemoved = q('.members-head') == null;
      extra.memberCountInHead = q('.members-head-meta') == null;
      extra.projectCards = qa('[data-zs-members-project]').map(textOf);
      extra.currentCardText = textOf(currentCard);
      extra.memberCountSpans = qa('[data-zs-members-card-members]').map((el) => ({ project: el.dataset.zsMembersCardMembers, text: textOf(el) }));
      extra.filtersText = textOf(filters);
      extra.refreshInsideFilters = filters != null && q('[data-zs-members-refresh]') != null && filters.contains(q('[data-zs-members-refresh]'));
      extra.addInsideFilters = filters != null && q('[data-zs-members-add]') != null && filters.contains(q('[data-zs-members-add]'));
      extra.scanButtonGone = !qa('button').some((button) => textOf(button) === '扫描本机 AI');
      extra.memberCards = memberRows().map(textOf);
      extra.editButtonCount = qa('[data-zs-member-edit]').length;
      extra.coordinatorTagCount = memberRows().filter((el) => textOf(el).indexOf('协调者') >= 0).length;
      extra.handDescriptionVisible = memberRows().some((el) => textOf(el).indexOf(hand) >= 0);
      extra.autoDescriptionVisible = memberRows().some((el) => textOf(el).indexOf(auto) >= 0);
      extra.templateCards = templateCards.map(textOf);
      extra.templateDescriptionVisible = templateCards.some((el) => textOf(el).indexOf('模板预填验证') >= 0);
      extra.templateExecutableDetails = templateCards.reduce((sum, el) => sum + el.querySelectorAll('details').length, 0);
      extra.filtersTop = filters == null ? null : Math.round(filters.getBoundingClientRect().top);
      check('右栏不再有项目名标题块（.members-head 已移除）', extra.headRemoved);
      check('左栏项目卡 ≥4', qa('[data-zs-members-project]').length >= 4);
      check('左栏当前项目卡片显示「N 个房间」', /\d+\s*个房间/.test(extra.currentCardText));
      check('左栏当前项目卡片显示「M 名成员」', /\d+\s*名成员/.test(extra.currentCardText));
      check('成员数有 data-zs-members-card-members 标记', extra.memberCountSpans.length >= 1);
      check('「刷新」在筛选行内（与搜索同一行）', extra.refreshInsideFilters);
      check('「添加 AI」在筛选行内（与搜索同一行）', extra.addInsideFilters);
      check('页面无「扫描本机 AI」独立按钮', extra.scanButtonGone);
      check('AI 卡不显示「协调者」标签', extra.coordinatorTagCount === 0);
      check('AI 卡无「编辑资料」按钮', extra.editButtonCount === 0);
      check('AI 卡保留手填说明', extra.handDescriptionVisible);
      check('AI 卡隐藏自动生成的说明文字', !extra.autoDescriptionVisible);
      check('模板卡存在', templateCards.length >= 1);
      check('模板卡不显示说明文字', !extra.templateDescriptionVisible);
      check('模板卡无「执行程序」details', extra.templateExecutableDetails === 0);
      check('模板卡不显示启用/权限', !templateCards.some((el) => /启用|权限/.test(textOf(el))));
      window.r183Extra = extra;
    } },
    { name: 'members-switch', run: async () => {
      await closeOverlays();
      await go('/project/' + m.projectId + '/members');
      await memberPageReady();
      const cardOf = (name) => qa('[data-zs-members-project]').find((el) => textOf(el).indexOf(name) >= 0);
      const target = cardOf('社区运营');
      if (target == null) throw Error('左栏没有「社区运营」项目卡');
      const sidebarBefore = textOf(q('.side-row.context-active .side-item-label') || q('.side-row.context-active'));
      target.click();
      await until(() => /社区运营/.test(textOf(q('[data-zs-members-project].is-current'))), '切到社区运营', 30000);
      await wait(1000);
      extra.currentCard = textOf(q('[data-zs-members-project].is-current'));
      extra.memberCards = memberRows().length;
      extra.headGone = q('.members-head') == null;
      extra.sidebarBefore = sidebarBefore;
      extra.sidebarAfter = textOf(q('.side-row.context-active .side-item-label') || q('.side-row.context-active'));
      check('项目卡切换后当前卡为社区运营', /社区运营/.test(extra.currentCard));
      check('切项目后成员卡重新装载', extra.memberCards >= 1);
      check('切换项目不出项目名标题块', extra.headGone);
      check('页内切项目不改侧栏高亮', extra.sidebarAfter === extra.sidebarBefore);
      window.r183Extra = extra;
    } },
    { name: 'members-no-flash', run: async () => {
      await go('/project/' + m.projectId + '/members');
      await memberPageReady();
      const cardOf = (name) => qa('[data-zs-members-project]').find((el) => textOf(el).indexOf(name) >= 0);
      const goProject = async (name) => {
        const card = cardOf(name);
        if (card == null) throw Error('左栏没有项目卡：' + name);
        card.click();
        await until(() => textOf(q('[data-zs-members-project].is-current')).indexOf(name) >= 0, '切到 ' + name, 30000);
        await wait(500);
      };
      await goProject('社区运营');
      await until(() => memberRows().length >= 1, '社区运营成员卡', 30000);
      await goProject('读书会筹备');
      await wait(400);
      let missingMemberCountFrames = 0;
      let emptyMemberFrames = 0;
      const community = cardOf('社区运营');
      if (community == null) throw Error('切回后找不到社区运营卡');
      community.click();
      const start = Date.now();
      while (Date.now() - start < 1200) {
        const card = cardOf('社区运营');
        const count = card == null ? null : card.querySelector('[data-zs-members-card-members]');
        if (count == null || !/\d+\s*名成员/.test(textOf(count))) missingMemberCountFrames += 1;
        if (memberRows().length === 0) emptyMemberFrames += 1;
        await wait(25);
      }
      await wait(700);
      extra.missingMemberCountFrames = missingMemberCountFrames;
      extra.emptyMemberFrames = emptyMemberFrames;
      extra.finalMemberCards = memberRows().length;
      extra.currentCard = textOf(q('[data-zs-members-project].is-current'));
      check('切回已看过的项目时成员数不闪没', missingMemberCountFrames === 0);
      check('切回已看过的项目时成员卡不闪空', emptyMemberFrames === 0);
      check('最终停在社区运营', /社区运营/.test(extra.currentCard));
      window.r183Extra = extra;
    } },
    /* ---------- 第 6 项：AI 设置弹窗（名称/说明） ---------- */
    { name: 'ai-settings', keepOpen: true, run: async () => {
      await closeOverlays();
      await go('/project/' + m.projectId + '/members');
      await memberPageReady();
      const bindButtons = qa('[data-zs-member-bind]');
      if (bindButtons.length === 0) throw Error('成员卡没有「AI 设置…」按钮');
      clearCommands();
      bindButtons[0].click();
      await until(() => q('[role="dialog"]') != null, 'AI 设置弹窗', 20000);
      await wait(500);
      const dialog = q('[role="dialog"]');
      const labels = Array.from(dialog.querySelectorAll('label.field')).map(textOf);
      extra.memberId = bindButtons[0].dataset.zsMemberBind;
      extra.dialogText = textOf(dialog);
      extra.fieldLabels = labels;
      extra.nameFieldPresent = labels.some((label) => label.indexOf('名称') >= 0);
      extra.descriptionFieldPresent = labels.some((label) => label.indexOf('说明') >= 0);
      extra.channelText = comboText('runtime 渠道');
      extra.dialogTop = Math.round(dialog.getBoundingClientRect().top);
      const nameInput = fieldInput(dialog, '名称') || q('[data-zs-member-name]');
      const descInput = fieldInput(dialog, '说明') || q('[data-zs-member-description]');
      extra.nameInputPresent = nameInput != null;
      extra.descriptionInputPresent = descInput != null;
      if (nameInput != null) setInput(nameInput, 'R183 验证成员');
      if (descInput != null) setInput(descInput, 'R183 手填说明');
      await wait(200);
      extra.nameInputValue = nameInput == null ? null : nameInput.value;
      extra.descriptionInputValue = descInput == null ? null : descInput.value;
      check('AI 设置弹窗里有「名称」字段', extra.nameFieldPresent && extra.nameInputPresent);
      check('AI 设置弹窗里有「说明」字段', extra.descriptionFieldPresent && extra.descriptionInputPresent);
      check('AI 设置弹窗仍显示渠道下拉', extra.channelText.length > 0);
      window.r183Extra = extra;
    } },
    { name: 'ai-settings-save', run: async () => {
      await until(() => q('[role="dialog"]') != null, 'AI 设置弹窗仍在', 15000);
      const dialog = q('[role="dialog"]');
      const nameInput = fieldInput(dialog, '名称') || q('[data-zs-member-name]');
      if (nameInput == null) throw Error('弹窗里没有名称输入框');
      setInput(nameInput, 'R183 改名成员');
      await wait(200);
      clearCommands();
      const save = q('[data-zs-member-bindsave]');
      if (save == null) throw Error('弹窗里没有保存 AI 设置按钮');
      save.click();
      await untilCommand('member.update', '保存资料 member.update', 25000);
      await until(() => q('[role="dialog"]') == null, '保存资料后弹窗关闭', 25000);
      await wait(700);
      extra.profileOnlyWrites = writeMethods();
      extra.profileOnlyUpdate = lastCommand('member.update') && lastCommand('member.update').params;
      const reopen = qa('[data-zs-member-bind]');
      if (reopen.length === 0) throw Error('保存后没有重新出现的 AI 设置按钮');
      clearCommands();
      reopen[0].click();
      await until(() => q('[role="dialog"]') != null, '再次打开 AI 设置弹窗', 20000);
      await wait(400);
      // 同一次保存里既改资料又改配置：实现应「先 member.update 拿新 revision，再 member.setRuntime」。
      // 渠道保持打开时的 fake（fixture 绑定就是 fake，选项列里虽不列 fake，但表单初值仍是 fake），
      // 改「执行程序」制造配置变化——避免触发 ZS_REAL_DISPATCH_GUARD 对真实渠道的拒绝。
      const nameAgain = fieldInput(q('[role="dialog"]'), '名称') || q('[data-zs-member-name]');
      if (nameAgain == null) throw Error('第二次打开没有名称输入框');
      setInput(nameAgain, 'R183 资料与配置');
      const executableInput = q('[role="dialog"] details input[placeholder="留空使用本机 CLI"]') || inputByPlaceholder('留空使用本机 CLI');
      const oldExecutable = executableInput == null ? null : executableInput.value;
      if (executableInput != null) setInput(executableInput, 'fake-r183');
      extra.channelBeforeSecondSave = comboText('runtime 渠道');
      extra.executableBeforeSecondSave = oldExecutable;
      await wait(300);
      const saveAgain = q('[data-zs-member-bindsave]');
      if (saveAgain == null) throw Error('第二次打开没有保存按钮');
      saveAgain.click();
      await untilCommand('member.setRuntime', '改配置 member.setRuntime', 25000);
      await until(() => q('[role="dialog"]') == null, '保存资料与配置后弹窗关闭', 25000);
      await wait(700);
      extra.configWrites = writeMethods();
      extra.updateBeforeRuntime = lastCommand('member.update') && lastCommand('member.update').params;
      extra.setRuntimeParams = lastCommand('member.setRuntime') && lastCommand('member.setRuntime').params;
      check('只改资料时命令序列只有 member.update', extra.profileOnlyWrites.length === 1 && extra.profileOnlyWrites[0] === 'member.update');
      check('同次保存时先 member.update 再 member.setRuntime', extra.configWrites.length >= 2 && extra.configWrites[0] === 'member.update' && extra.configWrites[1] === 'member.setRuntime');
      check('member.setRuntime 携带新渠道 fake', extra.setRuntimeParams != null && extra.setRuntimeParams.kind === 'fake');
      check('member.setRuntime 用 member.update 返回的新 revision', extra.updateBeforeRuntime != null && extra.setRuntimeParams != null && extra.setRuntimeParams.expectedRevision === extra.updateBeforeRuntime.expectedRevision + 1);
      /* 真实渠道（codex）在 ZS_REAL_DISPATCH_GUARD=1 下会被 daemon 拒绝：属于预期保护路径，
         只观察「弹窗保留 + 有拒绝提示」，不计入本轮失败。 */
      extra.softChecks = [];
      try {
        const again = qa('[data-zs-member-bind]');
        if (again.length === 0) throw Error('没有可再次打开的 AI 设置按钮');
        clearCommands();
        again[0].click();
        await until(() => q('[role="dialog"]') != null, '真实渠道拒绝路径：弹窗', 20000);
        await wait(300);
        await chooseOption('runtime 渠道', 'codex');
        await wait(300);
        const rejectedSave = q('[data-zs-member-bindsave]');
        if (rejectedSave == null) throw Error('真实渠道拒绝路径：没有保存按钮');
        rejectedSave.click();
        await untilCommand('member.setRuntime', '真实渠道拒绝路径：member.setRuntime 已发出', 25000);
        await wait(1200);
        const dialogStillOpen = q('[role="dialog"]') != null;
        const warningText = getComputedStyle(document.body).display === 'none' ? '' : (textOf(q('[role="dialog"]')) || textOf(document.body));
        extra.softChecks.push({ name: '真实渠道（codex）保存被拒时弹窗保留', ok: dialogStillOpen });
        extra.softChecks.push({ name: '真实渠道保存被拒时有可读提示', ok: /拒绝|不支持|失败|未保存|保护/.test(warningText) });
        await closeOverlays();
      } catch (error) {
        extra.softChecks.push({ name: '真实渠道拒绝路径观察失败（不计入失败）', ok: false, detail: String((error && error.message) || error) });
      }
      window.r183Extra = extra;
    } },
    /* ---------- 第 4 项：点「添加 AI」先扫描 ---------- */
    { name: 'add-scan', keepOpen: true, run: async () => {
      await closeOverlays();
      await go('/project/' + m.projectId + '/members');
      await memberPageReady();
      const add = q('[data-zs-members-add]');
      if (add == null) throw Error('筛选行里没有「添加 AI」按钮');
      extra.scanButtonGone = !qa('button').some((button) => textOf(button) === '扫描本机 AI');
      clearCommands();
      add.click();
      await untilCommand('member.discoverDefaults', '点击添加 AI 触发 member.discoverDefaults', 35000);
      await until(() => q('[role="dialog"]') != null && q('[aria-label="运行渠道"]') != null, '添加 AI 弹窗', 35000);
      await wait(500);
      extra.methodsAtOpen = methods();
      extra.scanRecorded = methods().indexOf('member.discoverDefaults') >= 0;
      extra.discoverBeforeDialogCommands = methods().slice(0, methods().length);
      const scanResult = q('[data-zs-members-scan-result]');
      extra.scanResultText = textOf(scanResult);
      extra.scanResultPresent = scanResult != null;
      extra.addButtonTextWhileScanning = textOf(q('[data-zs-members-add]'));
      extra.dialogTitle = textOf(q('[role="dialog"]'));
      check('页面无「扫描本机 AI」独立按钮', extra.scanButtonGone);
      check('点「添加 AI」先发 member.discoverDefaults', extra.scanRecorded);
      check('添加弹窗仍能打开（扫描后）', q('[aria-label="运行渠道"]') != null);
      check('扫描结果说明留在页面上', extra.scanResultPresent && /扫描/.test(extra.scanResultText) && /完成/.test(extra.scanResultText));
      check('扫描说明不是空话（含新增/已有）', /新增\s*\d+\s*位/.test(extra.scanResultText) && /已有\s*\d+\s*位/.test(extra.scanResultText));
      window.r183Extra = extra;
    } },
    /* ---------- 第 8 项：模板卡 → 预填添加 AI 弹窗 ---------- */
    { name: 'template-add', keepOpen: true, run: async () => {
      await closeOverlays();
      await go('/project/' + m.projectId + '/members');
      await memberPageReady();
      extra.template = await ensureTemplate();
      await wait(500);
      const create = q('[data-zs-template-create]');
      if (create == null) throw Error('模板卡没有「在本项目创建…」按钮');
      clearCommands();
      create.click();
      await until(() => q('[role="dialog"]') != null && q('[aria-label="运行渠道"]') != null, '添加 AI 弹窗（模板预填）', 25000);
      await wait(600);
      const dialog = q('[role="dialog"]');
      const nameInput = inputByPlaceholder('例如 审查者、实现者');
      const descInput = inputByPlaceholder('例如 实现与重构');
      const executableInput = inputByPlaceholder('留空使用本机 CLI');
      extra.dialogText = textOf(dialog);
      extra.prefillName = nameInput == null ? null : nameInput.value;
      extra.prefillDescription = descInput == null ? null : descInput.value;
      extra.prefillChannel = comboText('运行渠道');
      extra.prefillExecutable = executableInput == null ? null : executableInput.value;
      extra.prefillModelInput = q('[aria-label="手动模型 ID"]') == null ? null : q('[aria-label="手动模型 ID"]').value;
      extra.templateName = extra.template.name || 'R183 预填模板';
      check('模板卡点「创建」打开的是添加 AI 弹窗（不是旧模板弹窗）', q('[data-zs-template-create-save]') == null && q('[data-zs-member-addsave]') != null);
      check('弹窗说明已按模板预填', (extra.dialogText || '').indexOf('已按模板') >= 0);
      check('成员名已按模板预填', extra.prefillName === extra.templateName);
      check('说明已按模板预填', extra.prefillDescription === '模板预填验证');
      check('渠道已预填（fake 模板回退到 Claude）', /Claude/i.test(extra.prefillChannel));
      check('执行程序已预填', extra.prefillExecutable === 'claude');
      window.r183Extra = extra;
    } },
    { name: 'template-add-submit', run: async () => {
      await until(() => q('[role="dialog"]') != null, '预填弹窗仍在', 15000);
      const manualModel = q('[aria-label="手动模型 ID"]');
      if (manualModel != null && manualModel.value.trim() === '') {
        setInput(manualModel, 'test-model');
        await wait(300);
      }
      clearCommands();
      const save = q('[data-zs-member-addsave]');
      if (save == null) throw Error('预填弹窗里没有添加按钮');
      save.click();
      await untilCommand('member.create', '提交走 member.create', 30000);
      await wait(1200);
      extra.writes = writeMethods();
      extra.allMethods = methods();
      extra.createParams = lastCommand('member.create') && lastCommand('member.create').params;
      extra.templateCommandUsed = methods().some((method) => method === 'memberTemplate.createMember');
      check('提交命令是 member.create', extra.createParams != null);
      check('没有调用 memberTemplate.createMember', !extra.templateCommandUsed);
      check('member.create 用模板预填名称', extra.createParams != null && extra.createParams.displayName === 'R183 预填模板');
      check('member.create 用预填渠道/执行程序', extra.createParams != null && extra.createParams.runtime != null && extra.createParams.runtime.kind === 'claude' && extra.createParams.runtime.executable === 'claude');
      window.r183Extra = extra;
    } },
    /* ---------- 第 9 项：任务看板左栏项目卡 ---------- */
    { name: 'board-rail', run: async () => {
      await closeOverlays();
      await go('/board?scope=all');
      await until(() => q('.page-filters'), '看板筛选行', 25000);
      await until(() => qa('[data-zs-task-id]').length > 0, '看板卡片', 25000);
      await wait(900);
      const allCard = q('[data-zs-board-scope-all]');
      const projectCards = qa('[data-zs-board-project]');
      extra.allCardText = textOf(allCard);
      extra.projectCards = projectCards.map(textOf);
      extra.scopeSelectGone = q('[aria-label="看板范围"]') == null;
      extra.projectSelectGone = q('[aria-label="看板项目"]') == null;
      extra.roomFilterPresent = q('[aria-label="房间筛选"]') != null;
      extra.filtersText = textOf(q('.tasks-board-page .page-filters') || q('.page-filters'));
      extra.cardsBefore = qa('[data-zs-task-id]').length;
      check('左栏有「全部项目」卡', allCard != null && /全部项目/.test(extra.allCardText));
      check('左栏有项目卡 ≥4', projectCards.length >= 4);
      check('「范围」下拉已删除', extra.scopeSelectGone);
      check('「项目」下拉已删除', extra.projectSelectGone);
      check('房间筛选仍在筛选行', extra.roomFilterPresent);
      const community = projectCards.find((el) => textOf(el).indexOf('社区运营') >= 0);
      if (community == null) throw Error('看板左栏没有「社区运营」项目卡');
      clearCommands();
      community.click();
      await until(() => commands().some((row) => row.method === 'board.view' && row.params != null && row.params.scope === 'project'), '看板切到单项目 board.view', 25000);
      await wait(900);
      extra.viewAfterProject = lastCommand('board.view') && lastCommand('board.view').params;
      extra.currentProjectCard = textOf(q('.project-card.is-current'));
      extra.roomFilterText = comboText('房间筛选');
      extra.cardsAfterProject = qa('[data-zs-task-id]').length;
      extra.hashAfterProject = window.location.hash;
      extra.projectSectionsAfterProject = qa('.board-project').length;
      check('点项目卡后看板 scope=project 且带该项目 ID', extra.viewAfterProject != null && extra.viewAfterProject.scope === 'project' && extra.viewAfterProject.projectId === community.dataset.zsBoardProject);
      check('点项目卡后 URL 带 scope=project 与 roomId=all', /scope=project/.test(extra.hashAfterProject) && /roomId=all/.test(extra.hashAfterProject) && extra.hashAfterProject.indexOf(encodeURIComponent(community.dataset.zsBoardProject)) >= 0);
      check('点项目卡后只显示该项目的看板分组', extra.projectSectionsAfterProject <= 1);
      check('点项目卡后房间筛选清空为全部', /全部/.test(extra.roomFilterText));
      clearCommands();
      allCard.click();
      await until(() => commands().some((row) => row.method === 'board.view' && row.params != null && row.params.scope === 'all'), '点全部项目回到 scope=all', 25000);
      await wait(700);
      extra.viewAfterAll = lastCommand('board.view') && lastCommand('board.view').params;
      extra.hashAfterAll = window.location.hash;
      extra.allCardCurrent = q('[data-zs-board-scope-all]') != null && q('[data-zs-board-scope-all]').classList.contains('is-current');
      check('点「全部项目」回到 scope=all', extra.viewAfterAll != null && extra.viewAfterAll.scope === 'all');
      check('点「全部项目」URL 回到 scope=all', /scope=all/.test(extra.hashAfterAll));
      check('「全部项目」卡显示选中态', extra.allCardCurrent);
      window.r183Extra = extra;
    } },
    { name: 'board-archive', run: async () => {
      await go('/board?scope=all');
      await until(() => qa('[data-zs-task-id]').length > 0, '看板卡片', 25000);
      const remove = q('[data-zs-board-remove]');
      if (remove == null) throw Error('没有「归档」按钮');
      remove.click();
      await wait(500);
      const all = q('[data-zs-board-archive-all]');
      if (all == null) throw Error('没有「归档全部」按钮');
      all.click(); await wait(300); all.click();
      await wait(900);
      extra.cards = qa('[data-zs-task-id]').length;
      extra.undo = q('[data-zs-board-undo]') != null;
      extra.oldHiddenText = (document.body.innerText || '').indexOf('已隐藏') >= 0;
      extra.oldClearText = (document.body.innerText || '').indexOf('清空') >= 0;
      check('归档全部后看板清空', extra.cards === 0);
      check('归档后可撤销', extra.undo);
      check('不再出现旧「已隐藏」文案', !extra.oldHiddenText);
      window.r183Extra = extra;
    } },
    { name: 'board-undo', run: async () => {
      const undo = q('[data-zs-board-undo]');
      if (undo == null) throw Error('没有「撤销」按钮');
      undo.click();
      await wait(900);
      extra.cards = qa('[data-zs-task-id]').length;
      extra.undoGone = q('[data-zs-board-undo]') == null;
      check('撤销后卡片恢复', extra.cards > 0);
      check('撤销按钮消失', extra.undoGone);
      window.r183Extra = extra;
    } },
    /* ---------- 第 2/9 项：左栏几何对称（1360/1873 两种窗口） ---------- */
    { name: 'layout-symmetry-1360', viewport: { width: 1360, height: 900 }, run: async () => { await runLayoutSymmetry(); } },
    { name: 'layout-symmetry-1873', viewport: { width: 1873, height: 740 }, run: async () => { await runLayoutSymmetry(); } },
    /* ---------- 第 1 项：侧栏项目/房间拖动排序 ---------- */
    { name: 'sidebar-drag', reloadAfter: true, run: async () => {
      await closeOverlays();
      await go('/dm');
      await until(() => projectRows().length >= 4, '侧栏项目行（含夹具 4 个项目）', 30000);
      await wait(600);
      const before = projectIds();
      if (before.length < 4) throw Error('侧栏项目行不足 4 个：' + before.join(','));
      extra.stage = 'projects-loaded';
      extra.projectsBefore = before;
      const [firstId, secondId, thirdId] = [before[0], before[1], before[2]];
      /* 合成拖动 1：第 2 个项目拖到第 1 个项目上半（插到前面）。 */
      const drag1 = await dragRow('project', secondId, firstId, 'before');
      await until(() => projectIds()[0] === secondId, '项目拖动后顺序变化', 8000);
      await sleepFrame();
      const afterBefore = projectIds();
      extra.stage = 'drag1-done';
      /* 合成拖动 2：当前第 1 个（原第 2 个）拖到第 3 个项目下半（插到后面）。 */
      const drag2 = await dragRow('project', afterBefore[0], thirdId, 'after');
      await until(() => projectIds()[1] === thirdId, '项目后插拖动生效', 8000);
      await sleepFrame();
      const afterAfter = projectIds();
      extra.stage = 'drag2-done';
      const savedAfterProjectDrag = readOrder();
      /* 置顶：⋯ 菜单 → 置顶项目（应同步把项目排到最前；取消置顶不该走这里）。 */
      const pinTargetId = before[3] || before[before.length - 1];
      const pinRow = findProjectRow(pinTargetId);
      const more = pinRow == null ? null : Array.from(pinRow.querySelectorAll('.side-row-act')).find((button) => (button.getAttribute('title') || '').indexOf('更多操作') >= 0);
      if (more == null) throw Error('项目行没有「更多操作」按钮');
      more.click();
      await until(() => qa('.menu .menu-item').some((item) => textOf(item).indexOf('置顶项目') >= 0), '置顶菜单项', 15000);
      qa('.menu .menu-item').find((item) => textOf(item).indexOf('置顶项目') >= 0).click();
      await until(() => projectIds()[0] === pinTargetId, '置顶后项目排最前', 10000);
      const afterPin = projectIds();
      const savedAfterPin = readOrder();
      extra.stage = 'pin-done';
      /* 房间拖动：展开主项目，把第 2 个房间拖到第 1 个前面。 */
      const mainRow = findProjectRow(m.projectId);
      if (mainRow == null) throw Error('侧栏没有夹具主项目行');
      const caret = mainRow.querySelector('.side-caret');
      if (caret == null) throw Error('项目行没有展开箭头');
      if (caret.getAttribute('aria-expanded') !== 'true') caret.click();
      await until(() => q('[data-zs-project-list="room:' + m.projectId + '"]') != null && roomRows().length >= 2, '展开后的房间列表容器与房间行', 25000);
      await wait(400);
      extra.stage = 'rooms-expanded';
      extra.roomRowsRaw = roomRows().map((el) => ({ attr: el.getAttribute('data-zs-room-row'), ds: el.dataset.zsRoomRow }));
      const roomsBefore = roomRows().map((el) => el.dataset.zsRoomRow);
      if (roomsBefore.length < 2 || roomsBefore[0] == null || roomsBefore[1] == null) throw Error('房间行标识缺失：' + JSON.stringify(extra.roomRowsRaw));
      const drag3 = await dragRow('room', roomsBefore[1], roomsBefore[0], 'before');
      await until(() => roomRows()[0] != null && roomRows()[0].dataset.zsRoomRow === roomsBefore[1], '房间拖动后顺序变化', 8000);
      await sleepFrame();
      const roomsAfter = roomRows().map((el) => el.dataset.zsRoomRow);
      const savedAfterRoomDrag = readOrder();
      extra.stage = 'room-drag-done';
      extra.dragOverPrevented = { projectToFirst: drag1.overPrevented, projectToThird: drag2.overPrevented, room: drag3.overPrevented };
      extra.projectsBefore = before;
      extra.projectsAfterFirstDrag = afterBefore;
      extra.projectsAfterSecondDrag = afterAfter;
      extra.savedAfterProjectDrag = savedAfterProjectDrag;
      extra.pinnedProject = pinTargetId;
      extra.projectsAfterPin = afterPin;
      extra.savedAfterPin = savedAfterPin;
      extra.roomsBefore = roomsBefore;
      extra.roomsAfter = roomsAfter;
      extra.savedRoomOrder = savedAfterRoomDrag && savedAfterRoomDrag.rooms ? savedAfterRoomDrag.rooms[m.projectId] : null;
      check('产品 dragover 处理会 preventDefault（真实浏览器里才允许 drop）', extra.dragOverPrevented.projectToFirst === true && extra.dragOverPrevented.room === true);
      check('拖第 2 个项目到第 1 个之前：DOM 顺序改变', afterBefore.indexOf(secondId) < afterBefore.indexOf(firstId));
      check('拖到目标行下半：插到目标之后', afterAfter.indexOf(thirdId) >= 0 && afterAfter.indexOf(afterBefore[0]) > afterAfter.indexOf(thirdId));
      check('项目顺序写入 localStorage', savedAfterProjectDrag != null && Array.isArray(savedAfterProjectDrag.projects) && JSON.stringify(savedAfterProjectDrag.projects) === JSON.stringify(afterAfter));
      check('置顶后项目排到最前（DOM）', afterPin[0] === pinTargetId);
      check('置顶后项目排到最前（localStorage）', savedAfterPin != null && Array.isArray(savedAfterPin.projects) && savedAfterPin.projects[0] === pinTargetId);
      check('房间拖动改变 DOM 顺序', roomsAfter[0] === roomsBefore[1]);
      check('房间顺序写入 localStorage', Array.isArray(extra.savedRoomOrder) && extra.savedRoomOrder[0] === roomsBefore[1]);
      window.r183Extra = extra;
    } },
    { name: 'sidebar-drag-reload', run: async () => {
      await until(() => projectRows().length >= 4, '重载后侧栏项目行', 30000);
      await wait(600);
      const domIds = projectIds();
      const saved = readOrder();
      const savedProjects = saved != null && Array.isArray(saved.projects) ? saved.projects : [];
      const expected = savedProjects.filter((id) => domIds.indexOf(id) >= 0).concat(domIds.filter((id) => savedProjects.indexOf(id) < 0));
      extra.domAfterReload = domIds;
      extra.savedProjects = savedProjects;
      extra.expectedOrder = expected;
      check('重载后项目顺序按本机偏好', JSON.stringify(domIds) === JSON.stringify(expected));
      check('重载后第一项=已保存的第一项', savedProjects.length > 0 && domIds[0] === savedProjects[0]);
      const mainRow = findProjectRow(m.projectId);
      if (mainRow == null) throw Error('重载后找不到主项目行');
      const caret = mainRow.querySelector('.side-caret');
      if (caret != null && caret.getAttribute('aria-expanded') !== 'true') caret.click();
      await until(() => q('[data-zs-project-list="room:' + m.projectId + '"]') != null && roomRows().length >= 2, '重载后展开的房间行', 25000);
      extra.roomRowsAfterExpand = roomRows().length;
      const roomDom = roomRows().map((el) => el.dataset.zsRoomRow);
      extra.roomDomLength = roomDom.length;
      const savedRooms = saved != null && saved.rooms != null && Array.isArray(saved.rooms[m.projectId]) ? saved.rooms[m.projectId] : [];
      const expectedRooms = savedRooms.filter((id) => roomDom.indexOf(id) >= 0).concat(roomDom.filter((id) => savedRooms.indexOf(id) < 0));
      extra.roomDomAfterReload = roomDom;
      extra.savedRooms = savedRooms;
      extra.expectedRooms = expectedRooms;
      check('重载后房间顺序按本机偏好', JSON.stringify(roomDom) === JSON.stringify(expectedRooms));
      window.r183Extra = extra;
    } },
  ];

  /** 成员页 + 看板页各量一次左栏几何。
   *  左留白 = 项目卡左缘 - .page 盒子左缘（.page 的水平内边距就是页面边缘到内容区的留白，
   *  共享 CSS 的几何目标正是让它等于 24px / 40px）；右留白 = 右栏内容左缘 - 项目卡右缘。
   *  另记「卡片左缘 - 页面内容区左缘」（contentLeftGap，正常应为 0）便于核对。 */
  const measureSplit = (label) => {
    const page = q('.page');
    const card = q('.project-card') || q('[data-zs-members-project]') || q('[data-zs-board-project]');
    const content = q('.project-content') || q('.members-content') || q('.tasks-board-page > .board-project');
    const rail = q('.project-rail') || q('.members-projects');
    if (page == null || card == null || content == null) {
      return { label, ok: false, missing: { page: page == null, card: card == null, content: content == null, rail: rail == null } };
    }
    const pageRect = page.getBoundingClientRect();
    const style = getComputedStyle(page);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const cardRect = card.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const leftGap = Math.round((cardRect.left - pageRect.left) * 10) / 10;
    const contentLeftGap = Math.round((cardRect.left - (pageRect.left + paddingLeft)) * 10) / 10;
    const rightGap = Math.round((contentRect.left - cardRect.right) * 10) / 10;
    return {
      label,
      ok: true,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageLeft: Math.round(pageRect.left),
      paddingLeft,
      cardLeft: Math.round(cardRect.left * 10) / 10,
      cardRight: Math.round(cardRect.right * 10) / 10,
      contentLeft: Math.round(contentRect.left * 10) / 10,
      leftGap,
      contentLeftGap,
      rightGap,
      diff: Math.round(Math.abs(leftGap - rightGap) * 10) / 10,
      railWidth: rail == null ? null : Math.round(rail.getBoundingClientRect().width * 10) / 10,
    };
  };
  const runLayoutSymmetry = async () => {
    await go('/project/' + m.projectId + '/members');
    await until(() => qa('[data-zs-members-project]').length >= 4 && memberRows().length >= 1, '成员页装载', 30000);
    await wait(1000);
    extra.members = measureSplit('members');
    await go('/board?scope=all');
    await until(() => q('[data-zs-task-id]') != null, '看板卡片', 30000);
    await wait(1000);
    extra.board = measureSplit('board');
    extra.membersPage = { leftGap: extra.members.leftGap, rightGap: extra.members.rightGap, diff: extra.members.diff };
    extra.boardPage = { leftGap: extra.board.leftGap, rightGap: extra.board.rightGap, diff: extra.board.diff };
    window.r183Extra = extra;
    const expectedGap = window.innerWidth >= 1700 ? 40 : 24;
    check('成员页左栏几何可测量（.project-rail/.project-content 存在）', extra.members.ok === true);
    check('成员页左留白=右留白（±2px）', extra.members.ok === true && extra.members.diff <= 2);
    check('成员页左右留白等于页边距 ' + expectedGap + 'px（±2px）', extra.members.ok === true && Math.abs(extra.members.leftGap - expectedGap) <= 2 && Math.abs(extra.members.rightGap - expectedGap) <= 2);
    check('看板左栏几何可测量（.project-rail/.project-content 存在）', extra.board.ok === true);
    check('看板左留白=右留白（±2px）', extra.board.ok === true && extra.board.diff <= 2);
    check('看板左右留白等于页边距 ' + expectedGap + 'px（±2px）', extra.board.ok === true && Math.abs(extra.board.leftGap - expectedGap) <= 2 && Math.abs(extra.board.rightGap - expectedGap) <= 2);
  };

  window.r183Scenes = scenes;
  window.r183Shot = async (index) => {
    const scene = scenes[index];
    if (window.r183Reset != null) window.r183Reset();
    let error = null;
    try { await scene.run(); } catch (e) { error = String((e && e.message) || e); }
    await wait(250);
    const visibleText = (document.body.innerText || '').slice(0, 8000);
    const extra = window.r183Extra || null;
    const layout = {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
    return { name: scene.name, keepOpen: scene.keepOpen === true, error, visibleText, extra, layout, checks: checks.slice() };
  };
  window.r183Cleanup = async () => { await closeOverlays(); };
})();`;
const scenesPath = path.join(run, 'r183-scenes.js');
fs.writeFileSync(scenesPath, scenesSource);

/* ---------------- Electron 包装：装记录 preload、逐场景截图、可重载 ---------------- */
const wrapperSource = String.raw`const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const PRELOAD = __PRELOAD__;
const OUT = __OUT__;
const RESULT = __RESULT__;
const ONLY = __ONLY__;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(() => {
  // 记录 preload 必须早于产品 preload：session 级 preload 排在 webPreferences.preload 之前。
  try {
    session.defaultSession.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
  } catch (error) {
    try { session.defaultSession.setPreloads([PRELOAD]); } catch (fallbackError) {
      fs.writeFileSync(RESULT, JSON.stringify({ ok: false, error: '记录 preload 注册失败：' + String(fallbackError) }, null, 2));
    }
  }
});
require(MAIN);
let capturing = false;
const ANIM_STYLE = '<style id="r183-capture-anim">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>';
async function installPageScripts(win, metaJson, scenesJs) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const hifiDeadline = Date.now() + 40000;
  for (let i = 0; i < 160; i++) {
    let ready = false;
    try { ready = await js('document.readyState === "complete" && document.body.innerText.length > 20'); } catch { ready = false; }
    if (ready) break;
    await sleep(200);
  }
  await sleep(500);
  while (Date.now() < hifiDeadline) {
    let hifi = false;
    try { hifi = await js('document.body.classList.contains("hifi-on")'); } catch { hifi = false; }
    if (hifi) break;
    await sleep(200);
  }
  try { await js('document.head.insertAdjacentHTML("beforeend", ' + JSON.stringify(ANIM_STYLE) + ')'); } catch { /* 已有旧样式 */ }
  await js('window.r183Meta = ' + JSON.stringify(JSON.parse(metaJson)));
  await js(scenesJs);
}
async function capture(win) {
  const results = [];
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const metaJson = fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8');
  const scenesJs = fs.readFileSync(SCENES, 'utf8');
  let currentViewport = null;
  const setViewport = async (width, height) => {
    if (currentViewport != null && currentViewport.width === width && currentViewport.height === height) return;
    win.setContentSize(width, height);
    currentViewport = { width, height };
    await sleep(700);
  };
  try {
    await setViewport(1360, 900);
    await installPageScripts(win, metaJson, scenesJs);
    const names = await js('window.r183Scenes.map(function (scene) { return scene.name; })');
    const keep = await js('window.r183Scenes.map(function (scene) { return scene.keepOpen === true; })');
    const viewports = await js('window.r183Scenes.map(function (scene) { return scene.viewport || null; })');
    for (let i = 0; i < names.length; i++) {
      if (ONLY.length && ONLY.indexOf(names[i]) < 0) continue;
      const viewport = viewports[i] || { width: 1360, height: 900 };
      await setViewport(viewport.width, viewport.height);
      try { await js('window.r183 != null ? (window.r183.clear(), true) : true'); } catch { /* 记录器不可用时场景内命令断言会失败并如实报告 */ }
      let step = null;
      let failure = null;
      try { step = await js('window.r183Shot(' + i + ')'); } catch (error) { failure = String((error && error.message) || error); }
      let commandLog = [];
      try { commandLog = await js('window.r183 != null ? window.r183.commands() : []'); } catch { commandLog = []; }
      let sceneReload = false;
      try { sceneReload = await js('window.r183Scenes[' + i + '].reloadAfter === true'); } catch { sceneReload = false; }
      if (keep[i] !== true) {
        try { await js('window.r183Cleanup ? window.r183Cleanup() : true'); } catch { /* 清理失败不影响截图 */ }
      }
      try { await js('new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); })'); } catch { /* ignore */ }
      const name = names[i];
      const file = (i + 1 < 10 ? '0' : '') + (i + 1) + '-' + name + '.png';
      let image = null;
      try {
        const shot = await win.webContents.capturePage();
        image = shot.getSize();
        fs.writeFileSync(path.join(OUT, file), shot.toPNG());
      } catch (error) {
        failure = (failure == null ? '' : failure + '；') + '截图失败：' + String((error && error.message) || error);
      }
      step = step || { name, error: null, visibleText: '', extra: null, layout: null };
      if (failure != null) step.error = (step.error == null ? '' : step.error + '；') + failure;
      step.screenshot = file;
      step.image = image;
      step.commands = (commandLog || []).map((row) => row.method);
      step.commandDetails = commandLog || [];
      results.push(step);
      fs.writeFileSync(RESULT, JSON.stringify({ ok: true, partial: true, names, results }, null, 2));
      console.log('R183_SHOT ' + name + ' ' + (image == null ? 'no-image' : image.width + 'x' + image.height) + (step.error ? ' ERROR=' + step.error : ''));
      if (sceneReload) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 25000);
          win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
          win.webContents.reload();
        });
        await installPageScripts(win, metaJson, scenesJs);
      }
    }
    fs.writeFileSync(RESULT, JSON.stringify({ ok: true, names, results, inner: await js('({w: window.innerWidth, h: window.innerHeight})') }, null, 2));
  } catch (error) {
    fs.writeFileSync(RESULT, JSON.stringify({ ok: false, error: String((error && error.stack) || error), results }, null, 2));
    console.error('R183_CAPTURE_FAIL ' + String((error && error.stack) || error));
  }
  app.quit();
}
app.on('browser-window-created', (_event, win) => {
  win.show = () => {};
  win.webContents.once('did-finish-load', () => {
    if (capturing) return;
    capturing = true;
    void capture(win);
  });
});
setTimeout(() => { app.quit(); }, 720000).unref();`;
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(scenesPath))
  .replace('__PRELOAD__', JSON.stringify(recordPreloadPath))
  .replace('__OUT__', JSON.stringify(run))
  .replace('__RESULT__', JSON.stringify(path.join(run, 'result.json')))
  .replace('__ONLY__', JSON.stringify(only)));

/* ---------------- 执行 ---------------- */
(async () => {
  try {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed.cjs'), logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败：' + (seeded.stderr || seeded.stdout));
  } catch (error) {
    console.error(String(error));
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ok: false, error: String(error) }, null, 2));
    process.exitCode = 1;
    return;
  }
  const electron = spawnSync(require('electron'), [wrapperPath], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 900000 });
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8')); } catch { result = { ok: false, error: '没有 result.json' }; }
  const shots = (result.results || []).map((step) => ({
    name: step.name,
    screenshot: step.screenshot,
    error: step.error,
    checks: step.checks,
    commands: step.commands,
    extra: step.extra,
  }));
  const allChecks = shots.flatMap((step) => step.checks || []);
  const summary = {
    ok: electron.status === 0 && result.ok === true && result.partial !== true && result.results && result.results.length > 0 && result.results.every((step) => step.error == null),
    processExit: electron.status,
    run: path.relative(root, run),
    sceneCount: shots.length,
    checkCount: allChecks.length,
    checkFailed: allChecks.filter((item) => item.ok !== true).length,
    failedScenes: shots.filter((step) => step.error != null).map((step) => step.name),
    shots,
  };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
