/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R188 界面反馈轮截图核对（隔离数据；零真实模型；不碰用户运行数据）。
 *
 * 用法：
 *   node scripts/capture-r188-ui.cjs                     # 全部场景
 *   node scripts/capture-r188-ui.cjs --only=members,geometry-1360
 *   node scripts/capture-r188-ui.cjs --run=r188-prep     # 产物目录 dist/r188-ui/r188-prep
 * 前置：node scripts/build-ui.mjs（dist/ui/main.cjs）与 dist/pack/daemon.cjs 已存在。
 *
 * 与 R183 截图脚本的关系：沿用它的隔离数据根 / 夹具（scripts/lib/r170-fixture.ts）/
 * Electron 包装 / 命令记录器（session 级 preload 包一层 ipcRenderer.invoke，暴露 window.r188）。
 * 本轮新增「真实测量」辅助：不只看类名，直接量
 *   · 卡片左缘 − 页面(.page)左缘           期望 16px
 *   · 卡片右缘 − 分隔线(.project-split::before) 期望 16px
 *   1360x900 与 1873x740 两档（R188 第 2 项：左右留白都收到 16px 且相等）。
 *
 * 场景与验收点（用户 2026-11-07 八项反馈）：
 *  - members：R183 成员管理页断言回归（第 2 项页面未被本轮破坏）。
 *  - board-rail：R188 第 5 项——看板去掉「房间」筛选下拉；不再出现 roomId=all；
 *    左栏「全部项目」+ 项目卡仍工作（第 9 项 R183 语义保留）。
 *  - board-archive：R188 第 3、4 项——单卡归档图标 × → √（Icon check），
 *    title / aria-label 缩短为「归档」（有编号时「归档 #N」）；归档/撤销流程仍工作。
 *  - board-roomid：R188 第 5 项——带旧 roomId 的链接进入时 URL 归一（replace 清掉），
 *    不弹「筛选范围已变化」，卡片口径=当前范围全部房间。
 *  - cursor：R188 第 1 项——平时项目/房间行与行内按钮不是 grab/grabbing；
 *    合成 dragstart 后源行/侧栏变 grabbing，dragend 后恢复。
 *  - geometry-1360 / geometry-1873：第 2 项几何（成员/看板/文件/搜索四页）16/16。
 *  - files-rail / files-switch / files-nogit：第 6、8 项——文件与 Git 页左栏项目卡列
 *    取代顶栏项目下拉；切项目无横向位移、同时切当前项目、保留页签；
 *    非 Git 目录不再显示「此文件夹未初始化 Git」面板。
 *  - library-rail / library-all / library-project：第 7 项——搜索与收藏页左栏项目卡列
 *    取代「范围」下拉；「全部项目」=侧栏可见项目（search.query scope=visible）；
 *    点项目卡同时切当前项目，并按该项目范围检索。
 *
 * 注意：场景断言是**验证断言**，不是产品断言；实现未完成时失败属正常（--run=r188-prep 基线）。
 * 只允许在隔离数据目录运行；不打包、不安装、不调真实模型、不提交 git。
 * 隔离数据根 dist/r188-ui/<run>/data；夹具项目在系统临时目录 zs-r188-workspace/<run>/
 * （不在公开仓库工作区里，保证「非 Git 目录」是真非 Git，见下方常量注释）。
 */
const fs = require('node:fs');
const os = require('node:os');
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
const run = path.join(root, 'dist', 'r188-ui', runName);
const data = path.join(run, 'data');
// 夹具项目必须放在**公开仓库工作区之外**（系统临时目录）：本轮第 8 项要验证「普通非 Git 目录」，
// 若把夹具放在 D:/zhongshuo-public/dist/... 下，extra 项目会被 git 识别为外层公开仓库的工作区
// （git.status 会读到外层仓库的改动），既测不出真正的非 Git 目录，也让验证读到本轮源码仓库状态。
const workspace = path.join(os.tmpdir(), 'zs-r188-workspace', runName);
const project = path.join(workspace, '读书会筹备');
// 同一 --run 名重跑时必须先清掉隔离数据与夹具项目：否则旧数据库与本次种子混在一起
// （不是确定性的基线），或第二次 git commit 因「nothing to commit」失败。
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

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
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r188-' + randomUUID(),
  ZS_DAEMON_ENTRY: daemonEntry,
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

/* ---------------- 会话级记录 preload（只记录 zs:command 信封，不改变行为） ---------------- */
const recordPreloadPath = path.join(run, 'r188-record-preload.cjs');
fs.writeFileSync(recordPreloadPath, String.raw`/* R188 截图专用：记录 renderer 经 preload 发出的 zs:command（方法名+参数）。 */
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
contextBridge.exposeInMainWorld('r188', {
  commands: () => entries.slice(),
  clear: () => { entries.length = 0; },
});
`);

/* ---------------- 页面场景 ---------------- */
const key = 'zhongshuo.nav.listOrder.v1';
const scenesSource = String.raw`(() => {
  const m = window.r188Meta;
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
  window.r188Checks = checks;
  const check = (name, ok) => { checks.push({ name, ok: !!ok }); if (!ok) throw Error('校验失败：' + name); };
  // 每个场景开始前重置 extra / checks（场景里直接往 extra 上写字段，断言失败时也要留下已观察到的值）。
  let extra = {};
  window.r188Reset = () => { extra = {}; checks.length = 0; window.r188Extra = extra; window.r188Checks = checks; };
  const commands = () => (window.r188 == null ? [] : window.r188.commands());
  const clearCommands = () => { if (window.r188 != null) window.r188.clear(); };
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
  const memberRows = () => qa('[data-zs-member-card]');
  const memberPageReady = async (label) => {
    await until(() => q('[data-zs-members]'), '成员页', 25000);
    await until(() => qa('[data-zs-members-project]').length >= 4, '成员页项目卡（含夹具 4 个项目）', 30000);
    await until(() => memberRows().length >= 1, '成员卡', 30000);
    await wait(700);
  };

  /* 为成员卡「自动说明不显示 / 手填说明保留」准备两位 AI 成员（R183 断言沿用）。 */
  const prepareMemberDescriptions = async () => {
    const response = await window.zs.command({ protocolVersion: 1, commandId: 'r188-prepare-members-' + Date.now(), method: 'member.list', params: { projectId: m.projectId } });
    const items = (response && response.data && response.data.items) || [];
    const agents = items.filter((member) => member.principalType === 'agent').slice(0, 2);
    if (agents.length < 2) return { skipped: true };
    const hand = '手填说明：负责实现与重构';
    const auto = '由本机默认配置自动添加，可随时修改';
    const applied = [];
    for (let index = 0; index < agents.length; index += 1) {
      const member = agents[index];
      const result = await window.zs.command({ protocolVersion: 1, commandId: 'r188-prepare-desc-' + index + '-' + Date.now(), method: 'member.update', params: { projectId: m.projectId, memberId: member.id, expectedRevision: member.revision, displayName: member.displayName, description: index === 0 ? hand : auto } });
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
    const list = await window.zs.command({ protocolVersion: 1, commandId: 'r188-template-list-' + Date.now(), method: 'member.list', params: { projectId: m.projectId } });
    const items = (list && list.data && list.data.items) || [];
    const agent = items.find((member) => member.principalType === 'agent');
    if (agent == null) throw Error('夹具没有可用于保存模板的 AI 成员');
    const saved = await window.zs.command({ protocolVersion: 1, commandId: 'r188-template-save-' + Date.now(), method: 'memberTemplate.saveFromMember', params: { projectId: m.projectId, memberId: agent.id, expectedRevision: agent.revision, name: 'R188 预填模板', description: '模板预填验证' } });
    if (saved == null || saved.ok !== true) throw Error('创建夹具模板失败：' + JSON.stringify(saved && saved.error));
    window.dispatchEvent(new CustomEvent('zs-member-changed', { detail: { projectId: m.projectId } }));
    await until(() => qa('[data-zs-template]').length > 0, '模板卡', 25000);
    await wait(400);
    return { created: true, templateId: saved.data && saved.data.id, kind: saved.data && saved.data.config && saved.data.config.kind, name: saved.data && saved.data.name, description: saved.data && saved.data.description, cards: qa('[data-zs-template]').length };
  };

  /* 合成拖动（Chromium 里 DragEvent 构造器 + DataTransfer；dataTransfer 在部分版本构造器会被忽略，
     所以再用 defineProperty 兜底挂上）。 */
  const fireDrag = (el, type, dataTransfer, y) => {
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
  const sidebarActiveText = () => textOf(q('.side-row.context-active .side-item-label') || q('.side-row.context-active'));
  const expandRooms = async () => {
    const mainRow = findProjectRow(m.projectId);
    if (mainRow == null) throw Error('侧栏没有夹具主项目行');
    const caret = mainRow.querySelector('.side-caret');
    if (caret == null) throw Error('项目行没有展开箭头');
    if (caret.getAttribute('aria-expanded') !== 'true') caret.click();
    await until(() => q('[data-zs-project-list="room:' + m.projectId + '"]') != null && roomRows().length >= 2, '展开后的房间行', 25000);
    await wait(400);
  };
  /* 文件页：确保停在「文件」页签并等文件树装载（页签会被 rememberFileGitTab 记住，不能假定）。 */
  const ensureFilesTab = async () => {
    const activeTopTab = () => textOf(q('.fg-topbar-tabs .thread-tab.on'));
    if (activeTopTab().indexOf('文件') < 0) {
      const filesTab = qa('.fg-topbar-tabs .thread-tab').find((button) => textOf(button).indexOf('文件') >= 0);
      if (filesTab != null) { filesTab.click(); await wait(600); }
    }
    await until(() => qa('.file-row').length > 0, '文件树', 25000);
    await wait(500);
  };

  /* ---------------- 几何测量（R188 第 2 项）----------------
     页面左缘 = .page 元素的左边界（含页面内边距）；
     卡片左缘 = 左栏第一张 .project-card 的 border-box 左缘；
     分隔线   = .project-split::before 的定位线（left: var(--project-rail-width)），
                用 getComputedStyle(split,'::before').left 取解析值；取不到时退回左栏右缘
                （分隔线就画在 280px 左栏的右缘，两者应当重合，两个值都记录以便交叉核对）。
     目标：leftGap = 16、dividerGap = 16（1360 与 1873 两档相同）。 */
  const rectOf = (el) => {
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
  };
  const pseudoBefore = (el) => {
    if (el == null) return null;
    try {
      const cs = getComputedStyle(el, '::before');
      const content = cs.content;
      const left = parseFloat(cs.left);
      const width = parseFloat(cs.width);
      return { content: content == null ? null : String(content), left: Number.isFinite(left) ? Math.round(left * 10) / 10 : null, width: Number.isFinite(width) ? Math.round(width * 10) / 10 : null };
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
  };
  const measureRail = (label) => {
    const page = q('.page');
    const split = q('.project-split');
    const card = q('.project-rail .project-card') || q('.project-card');
    const rail = q('.project-rail');
    const content = q('.project-content');
    if (page == null || split == null || card == null || rail == null) {
      return { label, ok: false, missing: { page: page == null, split: split == null, card: card == null, rail: rail == null, content: content == null } };
    }
    const pageRect = page.getBoundingClientRect();
    const splitRect = split.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const pageStyle = getComputedStyle(page);
    const paddingLeft = parseFloat(pageStyle.paddingLeft) || 0;
    const pseudo = pseudoBefore(split);
    const dividerX = pseudo != null && pseudo.left != null ? Math.round((splitRect.left + pseudo.left) * 10) / 10 : null;
    const railRight = Math.round(railRect.right * 10) / 10;
    const contentRect = content == null ? null : content.getBoundingClientRect();
    return {
      label,
      ok: true,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageLeft: Math.round(pageRect.left * 10) / 10,
      paddingLeft: Math.round(paddingLeft * 10) / 10,
      splitLeft: Math.round(splitRect.left * 10) / 10,
      cardLeft: Math.round(cardRect.left * 10) / 10,
      cardRight: Math.round(cardRect.right * 10) / 10,
      cardWidth: Math.round(cardRect.width * 10) / 10,
      railLeft: Math.round(railRect.left * 10) / 10,
      railRight,
      dividerPseudo: pseudo,
      dividerX,
      dividerGapPseudo: dividerX == null ? null : Math.round((dividerX - cardRect.right) * 10) / 10,
      dividerGapRail: Math.round((railRight - cardRect.right) * 10) / 10,
      leftGap: Math.round((cardRect.left - pageRect.left) * 10) / 10,
      contentLeftGap: Math.round((cardRect.left - (pageRect.left + paddingLeft)) * 10) / 10,
      rightGapToContent: contentRect == null ? null : Math.round((contentRect.left - cardRect.right) * 10) / 10,
      railWidth: Math.round(railRect.width * 10) / 10,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  };
  const checkGeometry16 = (label, measure) => {
    const dividerGap = measure.ok === true ? measure.dividerGapPseudo : null;
    const gapOk = measure.ok === true
      ? (measure.dividerGapPseudo != null ? measure.dividerGapPseudo : measure.dividerGapRail)
      : null;
    check(label + '：卡片左缘 − 页面左缘 = 16px（实测 ' + (measure.ok === true ? measure.leftGap : 'n/a') + '）', measure.ok === true && Math.abs(measure.leftGap - 16) <= 1);
    check(label + '：卡片右缘 − 分隔线 = 16px（实测 ' + (measure.ok === true ? gapOk : 'n/a') + '）', measure.ok === true && Math.abs(gapOk - 16) <= 1);
    check(label + '：分隔线可测量（.project-split::before 可见）', measure.ok === true && measure.dividerX != null && measure.dividerPseudo != null && measure.dividerPseudo.width != null && measure.dividerPseudo.width > 0);
    check(label + '：分隔线与左栏右缘重合（差 ≤1px，pseudo=' + (measure.ok === true ? measure.dividerX : 'n/a') + '/rail=' + (measure.ok === true ? measure.railRight : 'n/a') + '）', measure.ok === true && Math.abs(measure.dividerX - measure.railRight) <= 1);
  };

  const scenes = [
    /* ---------- 第 2 项回归：成员管理页 R183 断言（本轮未改页面本身） ---------- */
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
      window.r188Extra = extra;
    } },

    /* ---------- 第 5 项：看板去掉房间筛选（R183 第 9 项项目卡列回归） ---------- */
    { name: 'board-rail', run: async () => {
      await closeOverlays();
      await go('/board?scope=all');
      await until(() => q('.page-filters'), '看板筛选行', 25000);
      await until(() => qa('[data-zs-task-id]').length > 0, '看板卡片', 25000);
      await wait(900);
      const allCard = q('[data-zs-board-scope-all]');
      const projectCards = qa('[data-zs-board-project]');
      const filterRow = q('.tasks-board-page .project-content > .page-filters') || q('.page-filters');
      extra.allCardText = textOf(allCard);
      extra.projectCards = projectCards.map(textOf);
      extra.scopeSelectGone = q('[aria-label="看板范围"]') == null;
      extra.projectSelectGone = q('[aria-label="看板项目"]') == null;
      extra.roomFilterPresent = q('[aria-label="房间筛选"]') != null;
      extra.roomComboCount = qa('[role="combobox"][aria-label*="房间"]').length;
      extra.filtersText = textOf(filterRow);
      extra.filterWrap = filterRow == null ? null : getComputedStyle(filterRow).flexWrap;
      extra.filterHasCount = /共\s*\d+\s*项/.test(extra.filtersText);
      extra.filterHasRefresh = extra.filtersText.indexOf('刷新') >= 0;
      extra.filterHasArchiveAll = extra.filtersText.indexOf('归档全部') >= 0;
      extra.cardsBefore = qa('[data-zs-task-id]').length;
      const roomNames = qa('.board-card-room').map(textOf).filter(Boolean);
      extra.cardRoomMetaCount = roomNames.length;
      extra.cardRoomMetaSample = roomNames.slice(0, 3);
      check('左栏有「全部项目」卡', allCard != null && /全部项目/.test(extra.allCardText));
      check('左栏有项目卡 ≥4', projectCards.length >= 4);
      check('「范围」下拉已删除', extra.scopeSelectGone);
      check('「项目」下拉已删除', extra.projectSelectGone);
      check('看板不再有「房间筛选」下拉', !extra.roomFilterPresent);
      check('筛选行文字不含「房间筛选」', extra.filtersText.indexOf('房间筛选') < 0);
      check('筛选行仍有「共 N 项 / 刷新 / 归档全部」（删房间下拉没误删其它控件）', extra.filterHasCount && extra.filterHasRefresh && extra.filterHasArchiveAll);
      check('筛选行明确不换行（flex-wrap: nowrap）', extra.filterWrap === 'nowrap');
      check('卡片 meta 仍显示房间名（房间维度没被删掉）', extra.cardRoomMetaCount > 0);
      const community = projectCards.find((el) => textOf(el).indexOf('社区运营') >= 0);
      if (community == null) throw Error('看板左栏没有「社区运营」项目卡');
      clearCommands();
      community.click();
      await until(() => commands().some((row) => row.method === 'board.view' && row.params != null && row.params.scope === 'project'), '看板切到单项目 board.view', 25000);
      await wait(900);
      extra.viewAfterProject = lastCommand('board.view') && lastCommand('board.view').params;
      extra.currentProjectCard = textOf(q('.project-card.is-current'));
      extra.cardsAfterProject = qa('[data-zs-task-id]').length;
      extra.hashAfterProject = window.location.hash;
      extra.projectSectionsAfterProject = qa('.board-project').length;
      extra.roomFilterAfterProject = q('[aria-label="房间筛选"]') != null;
      extra.filterTextAfterProject = textOf(q('.tasks-board-page .project-content > .page-filters') || q('.page-filters'));
      check('点项目卡后看板 scope=project 且带该项目 ID', extra.viewAfterProject != null && extra.viewAfterProject.scope === 'project' && extra.viewAfterProject.projectId === community.dataset.zsBoardProject);
      check('点项目卡后 URL 带 scope=project 与 projectId，且不再写 roomId', /scope=project/.test(extra.hashAfterProject) && extra.hashAfterProject.indexOf(encodeURIComponent(community.dataset.zsBoardProject)) >= 0 && !/[?&]roomId=/.test(extra.hashAfterProject));
      check('点项目卡后只显示该项目的看板分组', extra.projectSectionsAfterProject <= 1);
      check('点项目卡后仍没有房间筛选下拉', !extra.roomFilterAfterProject);
      check('点项目卡后筛选行不含「房间筛选」', extra.filterTextAfterProject.indexOf('房间筛选') < 0);
      clearCommands();
      allCard.click();
      await until(() => commands().some((row) => row.method === 'board.view' && row.params != null && row.params.scope === 'all'), '点全部项目回到 scope=all', 25000);
      await wait(700);
      extra.viewAfterAll = lastCommand('board.view') && lastCommand('board.view').params;
      extra.hashAfterAll = window.location.hash;
      extra.allCardCurrent = q('[data-zs-board-scope-all]') != null && q('[data-zs-board-scope-all]').classList.contains('is-current');
      check('点「全部项目」回到 scope=all', extra.viewAfterAll != null && extra.viewAfterAll.scope === 'all');
      check('点「全部项目」URL 回到 scope=all 且无 roomId', /scope=all/.test(extra.hashAfterAll) && !/[?&]roomId=/.test(extra.hashAfterAll));
      check('「全部项目」卡显示选中态', extra.allCardCurrent);
      window.r188Extra = extra;
    } },

    /* ---------- 第 3、4 项：单卡归档 × → √ / title=归档 ---------- */
    { name: 'board-archive', run: async () => {
      await go('/board?scope=all');
      await until(() => qa('[data-zs-task-id]').length > 0, '看板卡片', 25000);
      await wait(600);
      const removes = qa('[data-zs-board-remove]');
      if (removes.length === 0) throw Error('没有「归档」按钮');
      const first = removes[0];
      const svg = first.querySelector('svg');
      extra.removeCount = removes.length;
      extra.removeTitle = first.getAttribute('title');
      extra.removeAriaLabel = first.getAttribute('aria-label');
      extra.removeIcon = svg == null ? null : svg.getAttribute('data-icon');
      extra.removeIconTags = removes.map((el) => { const s = el.querySelector('svg'); return s == null ? null : s.getAttribute('data-icon'); });
      extra.removeText = textOf(first).slice(0, 40);
      extra.removeAriaLabels = removes.map((el) => el.getAttribute('aria-label'));
      extra.removeTitles = removes.map((el) => el.getAttribute('title'));
      const polyline = first.querySelector('svg polyline');
      extra.removePolyline = polyline == null ? null : polyline.getAttribute('points');
      check('单卡归档按钮 title = 「归档」', extra.removeTitle === '归档');
      check('单卡归档按钮 aria-label =「归档」或「归档 #N」', extra.removeAriaLabels.every((label) => label != null && /^归档( #\d+)?$/.test(label)));
      check('单卡归档按钮图标是 √（Icon check）', extra.removeIconTags.every((name) => name === 'check'));
      check('单卡归档按钮是 √ 折线（polyline points="20 6 9 17 4 12"）', extra.removePolyline != null && extra.removePolyline.replace(/\s+/g, ' ').trim() === '20 6 9 17 4 12');
      check('单卡归档按钮不再用 ×（Icon x / close 均不出现）', extra.removeIconTags.every((name) => name !== 'x' && name !== 'close' && name !== 'x-circle'));
      check('单卡归档按钮不显示长解释文字', extra.removeText === '');
      first.click();
      await wait(600);
      extra.cardsAfterSingleArchive = qa('[data-zs-task-id]').length;
      extra.undoAfterSingle = q('[data-zs-board-undo]') != null;
      check('单卡 √ 归档后该卡片从看板收起', extra.cardsAfterSingleArchive === extra.removeCount - 1);
      check('单卡归档后可撤销', extra.undoAfterSingle);
      const all = q('[data-zs-board-archive-all]');
      if (all == null) throw Error('没有「归档全部」按钮');
      all.click(); await wait(300); all.click();
      await wait(900);
      extra.cards = qa('[data-zs-task-id]').length;
      extra.undo = q('[data-zs-board-undo]') != null;
      extra.oldHiddenText = (document.body.innerText || '').indexOf('已隐藏') >= 0;
      check('归档全部后看板清空', extra.cards === 0);
      check('归档后可撤销', extra.undo);
      check('不再出现旧「已隐藏」文案', !extra.oldHiddenText);
      window.r188Extra = extra;
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
      window.r188Extra = extra;
    } },

    /* ---------- 第 5 项：旧 roomId 链接进入 → URL 归一 / 不弹提示 / 不按房间过滤 ---------- */
    { name: 'board-roomid', run: async () => {
      // 先量一次干净 scope=all 的卡片数作为对照（同一数据根，房间筛选若仍生效卡片数会变少）。
      await go('/board?scope=all');
      await until(() => qa('[data-zs-task-id]').length > 0, '干净看板卡片', 25000);
      await wait(700);
      const cleanCount = qa('[data-zs-task-id]').length;
      extra.cleanCount = cleanCount;
      extra.cleanHash = window.location.hash;
      // 先离开看板页（卸载组件），再从旧收藏/历史里的 roomId 链接重新进入——等价于「深链首次挂载」。
      await go('/dm');
      await wait(400);
      await go('/board?scope=all&roomId=' + encodeURIComponent(m.roomId));
      await until(() => q('.page-filters'), '带 roomId 的看板筛选行', 25000);
      await until(() => qa('[data-zs-task-id]').length > 0, '带 roomId 的看板卡片', 25000);
      await wait(1000);
      extra.hash = window.location.hash;
      extra.roomIdStillInUrl = /[?&]roomId=/.test(extra.hash);
      extra.roomFilterPresent = q('[aria-label="房间筛选"]') != null;
      extra.oldToastVisible = (document.body.innerText || '').indexOf('筛选范围已变化') >= 0;
      extra.oldToastAnywhere = (document.body.innerText || '').indexOf('房间筛选已清空') >= 0;
      extra.cards = qa('[data-zs-task-id]').length;
      extra.filtersText = textOf(q('.tasks-board-page .project-content > .page-filters') || q('.page-filters'));
      check('旧链接里的 roomId 被 replace 清掉（URL 不再带 roomId）', !extra.roomIdStillInUrl);
      check('URL 归一后 scope=all 仍在', /scope=all/.test(extra.hash));
      check('不再弹「筛选范围已变化」提示', !extra.oldToastVisible && !extra.oldToastAnywhere);
      check('看板筛选行没有房间下拉', !extra.roomFilterPresent);
      check('房间筛选不再生效：卡片数=当前范围全部房间（' + extra.cards + ' / 干净版 ' + cleanCount + '）', extra.cards === cleanCount);
      window.r188Extra = extra;
    } },

    /* ---------- 第 1 项：平时不抓取光标，真正拖动时 grabbing ---------- */
    { name: 'cursor', run: async () => {
      await closeOverlays();
      await go('/dm');
      await until(() => projectRows().length >= 4, '侧栏项目行（含夹具 4 个项目）', 30000);
      await wait(600);
      const row = projectRows()[0];
      const label = row.querySelector('.side-item-label-btn');
      const carets = qa('.side-caret');
      const acts = qa('.side-row-act');
      extra.idleProjectRowCursor = getComputedStyle(row).cursor;
      extra.idleProjectLabelCursor = label == null ? null : getComputedStyle(label).cursor;
      extra.idleProjectCaretCursor = carets.length === 0 ? null : getComputedStyle(carets[0]).cursor;
      extra.idleProjectMoreCursor = acts.length === 0 ? null : getComputedStyle(acts[0]).cursor;
      const idleProjectCursors = [extra.idleProjectRowCursor, extra.idleProjectLabelCursor, extra.idleProjectCaretCursor, extra.idleProjectMoreCursor].filter((value) => value != null);
      extra.idleProjectCursors = idleProjectCursors;
      check('平时项目行/行内按钮都不是抓取光标', idleProjectCursors.every((cursor) => !/grab/.test(cursor)));
      check('平时项目行内项目名按钮仍是普通可点击指针', extra.idleProjectLabelCursor === 'pointer');
      await expandRooms();
      const roomRow = roomRows()[0];
      const roomButton = roomRow == null ? null : roomRow.querySelector('.side-item');
      extra.idleRoomRowCursor = roomRow == null ? null : getComputedStyle(roomRow).cursor;
      extra.idleRoomButtonCursor = roomButton == null ? null : getComputedStyle(roomButton).cursor;
      const idleRoomCursors = [extra.idleRoomRowCursor, extra.idleRoomButtonCursor].filter((value) => value != null);
      extra.idleRoomCursors = idleRoomCursors;
      check('平时房间行/行内按钮都不是抓取光标', idleRoomCursors.length > 0 && idleRoomCursors.every((cursor) => !/grab/.test(cursor)));
      // 合成项目 dragstart：只有真正进入拖动才变 grabbing。
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', row.dataset.zsSideProject);
      fireDrag(row, 'dragstart', dataTransfer);
      await until(() => q('.side-project.is-dragging') != null, '项目行 is-dragging', 8000);
      await wait(120);
      const draggingRow = q('.side-project.is-dragging > .side-row');
      extra.dragProjectRowCursor = draggingRow == null ? null : getComputedStyle(draggingRow).cursor;
      extra.dragSidebarCursor = getComputedStyle(q('.sidebar')).cursor;
      extra.dragProjectRowOpacity = draggingRow == null ? null : getComputedStyle(draggingRow).opacity;
      check('拖动中源项目行 cursor = grabbing', extra.dragProjectRowCursor === 'grabbing');
      check('拖动中整条侧栏 cursor = grabbing（拖过其它行不闪回）', extra.dragSidebarCursor === 'grabbing');
      fireDrag(draggingRow || row, 'dragend', dataTransfer);
      await until(() => q('.side-project.is-dragging') == null, '项目 dragend 清除 is-dragging', 8000);
      await wait(200);
      extra.afterProjectDragRowCursor = getComputedStyle(projectRows()[0]).cursor;
      check('项目拖动结束后恢复非抓取光标', !/grab/.test(extra.afterProjectDragRowCursor));
      // 合成房间 dragstart：同样只在拖动中 grabbing。
      const targetRoom = roomRows()[0];
      if (targetRoom == null) throw Error('没有可拖动的房间行');
      const roomTransfer = new DataTransfer();
      roomTransfer.setData('text/plain', targetRoom.dataset.zsRoomRow);
      fireDrag(targetRoom, 'dragstart', roomTransfer);
      await until(() => q('.conversation-nav-row.is-dragging') != null, '房间行 is-dragging', 8000);
      await wait(120);
      const draggingRoom = q('.conversation-nav-row.is-dragging');
      extra.dragRoomRowCursor = draggingRoom == null ? null : getComputedStyle(draggingRoom).cursor;
      check('拖动中源房间行 cursor = grabbing', extra.dragRoomRowCursor === 'grabbing');
      fireDrag(draggingRoom || targetRoom, 'dragend', roomTransfer);
      await until(() => q('.conversation-nav-row.is-dragging') == null, '房间 dragend 清除 is-dragging', 8000);
      await wait(200);
      extra.afterRoomDragRowCursor = roomRows().length === 0 ? null : getComputedStyle(roomRows()[0]).cursor;
      check('房间拖动结束后恢复非抓取光标', extra.afterRoomDragRowCursor == null || !/grab/.test(extra.afterRoomDragRowCursor));
      window.r188Extra = extra;
    } },

    /* ---------- 第 2 项：四页几何 16/16（1360 与 1873 两档） ---------- */
    { name: 'geometry-1360', viewport: { width: 1360, height: 900 }, run: async () => { await runGeometry(); } },
    { name: 'geometry-1873', viewport: { width: 1873, height: 740 }, run: async () => { await runGeometry(); } },

    /* ---------- 第 6 项：文件与 Git 页左栏项目卡列 ---------- */
    { name: 'files-rail', run: async () => {
      await closeOverlays();
      await go('/project/' + m.projectId + '/files');
      await until(() => q('.page.fg-page'), '文件页', 25000);
      await until(() => qa('[data-zs-files-project]').length >= 4, '文件页左栏项目卡（含夹具 4 个项目）', 30000);
      await until(() => q('.fg-rail-content') != null && (q('.fg-rail-content .fg-body') != null || q('.fg-rail-content .git-layout') != null), '文件页右列内容', 25000);
      await ensureFilesTab();
      await wait(800);
      extra.railPresent = q('[data-zs-files-projects]') != null;
      extra.railCardCount = qa('[data-zs-files-project]').length;
      extra.railCards = qa('[data-zs-files-project]').map(textOf);
      extra.topbarProjectSelectGone = q('.fg-page [aria-label="切换项目"]') == null && q('.fg-topbar-project') == null;
      extra.topbarSelectCount = qa('.fg-page [role="combobox"]').length;
      extra.currentProjectCard = textOf(q('[data-zs-files-project].is-current'));
      extra.currentCardId = q('[data-zs-files-project].is-current') == null ? null : q('[data-zs-files-project].is-current').dataset.zsFilesProject;
      extra.pathText = textOf(q('[data-zs-files-path]'));
      extra.fileRows = qa('.file-row').length;
      extra.geometry = measureRail('files');
      check('文件页左栏是项目卡列（data-zs-files-projects）', extra.railPresent);
      check('文件页左栏有 ≥4 张项目卡', extra.railCardCount >= 4);
      check('文件页顶栏项目下拉已删除（改由左栏卡片切换）', extra.topbarProjectSelectGone);
      check('文件页左栏当前卡是夹具主项目', extra.currentCardId === m.projectId && /读书会筹备/.test(extra.currentProjectCard));
      check('文件树照常装载', extra.fileRows > 0);
      checkGeometry16('文件页', extra.geometry);
      check('文件页横向无溢出', extra.geometry.horizontalOverflow !== true);
      window.r188Extra = extra;
    } },
    { name: 'files-switch', run: async () => {
      const targetId = m.extraProjectIds && m.extraProjectIds[0];
      if (targetId == null) throw Error('夹具没有额外项目');
      const targetName = '社区运营';
      // 先切到 Git 页签，验证换项目后页签保留（与 R183 之后的既有行为一致）。
      const gitTab = qa('.fg-topbar-tabs .thread-tab').find((button) => textOf(button).indexOf('Git') >= 0);
      if (gitTab != null) { gitTab.click(); await wait(700); }
      const snapshot = () => {
        const rectOfLocal = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10 }; };
        return {
          hash: window.location.hash,
          scrollX: window.scrollX,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          rail: rectOfLocal(q('.fg-page .project-rail')),
          topbar: rectOfLocal(q('.fg-topbar')),
          content: rectOfLocal(q('.fg-rail-content')),
          body: rectOfLocal(q('.fg-rail-content .fg-body') || q('.fg-rail-content .git-layout')),
          path: rectOfLocal(q('[data-zs-files-path]')),
          activeTab: textOf(q('.fg-topbar-tabs .thread-tab.on')),
          sidebarActive: sidebarActiveText(),
        };
      };
      await wait(500);
      extra.before = snapshot();
      const card = qa('[data-zs-files-project]').find((el) => el.dataset.zsFilesProject === targetId);
      if (card == null) throw Error('文件页左栏没有目标项目卡');
      card.click();
      await until(() => window.location.hash.indexOf(targetId) >= 0, '切到目标项目的文件页 URL', 25000);
      await until(() => q('[data-zs-files-project].is-current') != null && q('[data-zs-files-project].is-current').dataset.zsFilesProject === targetId, '目标项目卡选中', 25000);
      await until(() => q('[data-zs-files-path]') != null && textOf(q('[data-zs-files-path]')).indexOf(targetName) >= 0, '顶栏路径切到目标项目', 25000);
      await until(() => sidebarActiveText().indexOf(targetName) >= 0, '侧栏当前项目切到目标项目', 25000);
      // 目标项目是非 Git 目录且我们停在 Git 页签：右列是「尚未初始化 Git」空态（不是 .git-layout），
      // 只要求右列挂载出内容，横向位置比较才是有意义的。
      await until(() => q('.fg-rail-content') != null && q('.fg-rail-content').children.length > 0, '目标项目右列内容', 25000);
      await wait(1000);
      extra.after = snapshot();
      extra.targetId = targetId;
      extra.targetName = targetName;
      extra.currentCardId = q('[data-zs-files-project].is-current') == null ? null : q('[data-zs-files-project].is-current').dataset.zsFilesProject;
      extra.sidebarActiveAfter = sidebarActiveText();
      extra.titlebarProjectAfter = textOf(q('.zs-tb-project-name'));
      const titlebarBtn = q('[data-zs-project-menu-btn]');
      extra.titlebarAriaAfter = titlebarBtn == null ? null : titlebarBtn.getAttribute('aria-label');
      const delta = (key) => {
        const before = extra.before[key];
        const after = extra.after[key];
        if (before == null || after == null) return null;
        return Math.round(Math.abs(after.left - before.left) * 10) / 10;
      };
      extra.deltas = { rail: delta('rail'), topbar: delta('topbar'), content: delta('content'), body: delta('body'), path: delta('path') };
      check('切项目后 URL 指向目标项目文件页', extra.after.hash.indexOf('/project/' + targetId + '/files') >= 0);
      check('点项目卡同时切换当前项目（侧栏高亮=社区运营）', extra.after.sidebarActive.indexOf(targetName) >= 0);
      check('点项目卡同时切换当前项目（标题栏项目名=社区运营）', extra.titlebarProjectAfter.indexOf(targetName) >= 0);
      check('目标项目卡显示选中态', extra.currentCardId === targetId);
      check('切项目后左栏项目卡列横向不位移（|Δleft| ≤1px）', extra.deltas.rail != null && extra.deltas.rail <= 1);
      check('切项目后顶栏横向不位移（|Δleft| ≤1px）', extra.deltas.topbar != null && extra.deltas.topbar <= 1);
      check('切项目后右列内容横向不位移（|Δleft| ≤1px）', extra.deltas.content != null && extra.deltas.content <= 1);
      check('切项目后工作区横向不位移（|Δleft| ≤1px）', extra.deltas.body == null || extra.deltas.body <= 1);
      check('切项目后页面无横向溢出/滚动', extra.after.scrollWidth <= extra.after.innerWidth + 2 && extra.after.scrollX === 0);
      check('切项目后保留 Git 页签', /Git/.test(extra.after.activeTab));
      window.r188Extra = extra;
    } },
    { name: 'files-nogit', run: async () => {
      const targetId = m.extraProjectIds && m.extraProjectIds[0];
      if (targetId == null) throw Error('夹具没有额外项目');
      await closeOverlays();
      await go('/project/' + targetId + '/files');
      await until(() => q('.page.fg-page'), '非 Git 项目文件页', 25000);
      await until(() => qa('[data-zs-files-project]').length >= 4, '非 Git 项目左栏项目卡', 30000);
      await ensureFilesTab();
      const bodyText = document.body.innerText || '';
      extra.fileRows = qa('.file-row').length;
      extra.currentCardText = textOf(q('[data-zs-files-project].is-current'));
      extra.currentCardId = q('[data-zs-files-project].is-current') == null ? null : q('[data-zs-files-project].is-current').dataset.zsFilesProject;
      extra.tabText = textOf(q('.fg-topbar-tabs'));
      extra.gitNeutralPanel = q('[data-zs-git-neutral]') != null;
      extra.uninitializedPanelText = bodyText.indexOf('此文件夹未初始化 Git') >= 0;
      extra.mentionsUninitialized = /未初始化 Git/.test(bodyText);
      // Git 页签上同样不应再出现旧中性面板（旧实现两个页签上方都挂这块面板）。
      const gitTab = qa('.fg-topbar-tabs .thread-tab').find((button) => textOf(button).indexOf('Git') >= 0);
      if (gitTab != null) { gitTab.click(); await wait(800); }
      const gitBodyText = document.body.innerText || '';
      extra.gitTabNeutralPanel = q('[data-zs-git-neutral]') != null;
      extra.gitTabUninitializedPanelText = gitBodyText.indexOf('此文件夹未初始化 Git') >= 0;
      check('非 Git 目录不再显示「此文件夹未初始化 Git」面板', !extra.gitNeutralPanel);
      check('页面文字不再出现「此文件夹未初始化 Git」', !extra.uninitializedPanelText && !extra.mentionsUninitialized);
      check('Git 页签上旧中性面板也不再现', !extra.gitTabNeutralPanel && !extra.gitTabUninitializedPanelText);
      check('非 Git 项目卡用一行小字标出「非 Git 目录」（替代面板）', /非 Git 目录/.test(extra.currentCardText));
      check('非 Git 目录的文件树照常可用', extra.fileRows > 0);
      // 截图证据落在「文件」页签（本场景验证的是文件页不再有未初始化 Git 面板；Git 页签只剩它自己的空态）。
      const filesTab = qa('.fg-topbar-tabs .thread-tab').find((button) => textOf(button).indexOf('文件') >= 0);
      if (filesTab != null) { filesTab.click(); await wait(600); }
      await until(() => qa('.file-row').length > 0, '回到文件页签后的文件树', 25000);
      await wait(400);
      window.r188Extra = extra;
    } },

    /* ---------- 第 7 项：搜索与收藏页左栏项目卡列 ---------- */
    { name: 'library-rail', run: async () => {
      await closeOverlays();
      await go('/library');
      await until(() => q('.page.library-page'), '搜索与收藏页', 25000);
      await until(() => qa('[data-zs-library-project]').length >= 4, '搜索页左栏项目卡（含夹具 4 个项目）', 30000);
      await until(() => q('.library-page .thread-tabs') != null, '搜索页页签', 20000);
      await wait(800);
      extra.railCardCount = qa('[data-zs-library-project]').length;
      extra.railCards = qa('[data-zs-library-project]').map(textOf);
      extra.allCardPresent = q('[data-zs-library-scope-all]') != null;
      extra.allCardText = textOf(q('[data-zs-library-scope-all]'));
      extra.oldScopeSelectGone = q('[aria-label="搜索范围"]') == null && !qa('.library-page .field-label').some((el) => textOf(el) === '范围');
      extra.fieldLabels = qa('.library-page .field-label').map(textOf);
      extra.currentCardId = q('[data-zs-library-project].is-current') == null ? null : q('[data-zs-library-project].is-current').dataset.zsLibraryProject;
      extra.currentCardText = textOf(q('[data-zs-library-project].is-current'));
      extra.sidebarActive = sidebarActiveText();
      extra.geometry = measureRail('library');
      check('搜索页左栏有「全部项目」卡', extra.allCardPresent && /全部项目/.test(extra.allCardText));
      check('搜索页左栏有项目卡 ≥4', extra.railCardCount >= 4);
      check('「范围」下拉已删除（无 aria-label=搜索范围、筛选行无「范围」字段）', extra.oldScopeSelectGone);
      // 本页初始范围=当前项目：左栏当前卡必须与侧栏当前项目一致（不假定一定是夹具主项目——
      // 前面的 files-switch 场景会把当前项目切到社区运营，这里检查真实不变量）。
      check('搜索页左栏当前卡=当前项目（与侧栏高亮一致：' + extra.sidebarActive + ' / ' + extra.currentCardText + '）', extra.sidebarActive.length > 0 && extra.currentCardText.indexOf(extra.sidebarActive) >= 0 && extra.currentCardId != null);
      checkGeometry16('搜索页', extra.geometry);
      check('搜索页横向无溢出', extra.geometry.horizontalOverflow !== true);
      window.r188Extra = extra;
    } },
    { name: 'library-all', run: async () => {
      const allCard = q('[data-zs-library-scope-all]');
      if (allCard == null) throw Error('没有「全部项目」卡');
      const sidebarBefore = sidebarActiveText();
      const titlebarBefore = textOf(q('.zs-tb-project-name'));
      clearCommands();
      allCard.click();
      await wait(400);
      // 输入关键词触发检索（空关键词不发 search.query）：范围卡先切到「全部项目」，
      // 再输入关键词，期望命令参数 scope=visible（=侧栏可见项目，不是 all）。
      const searchInput = qa('.library-page .page-filters input').find((el) => (el.getAttribute('placeholder') || '').indexOf('搜') >= 0);
      if (searchInput == null) throw Error('搜索页没有搜索框');
      setInput(searchInput, '读书会');
      await untilCommand('search.query', '搜索命令 search.query', 25000);
      await wait(900);
      const search = lastCommand('search.query');
      extra.searchParams = search && search.params;
      extra.scopeNote = textOf(q('.library-page .filter-note'));
      extra.allCardCurrent = q('[data-zs-library-scope-all]') != null && q('[data-zs-library-scope-all]').classList.contains('is-current');
      extra.sidebarBefore = sidebarBefore;
      extra.sidebarAfter = sidebarActiveText();
      extra.titlebarBefore = titlebarBefore;
      extra.titlebarAfter = textOf(q('.zs-tb-project-name'));
      extra.placeholder = searchInput.getAttribute('placeholder');
      extra.resultRowCount = qa('.library-page .card.tight').length;
      check('「全部项目」卡发出 search.query scope=visible（=侧栏可见项目）', extra.searchParams != null && extra.searchParams.scope === 'visible');
      check('「全部项目」卡显示选中态', extra.allCardCurrent);
      check('范围说明写明「全部项目（侧栏可见）」', /全部项目（侧栏可见）/.test(extra.scopeNote));
      check('点「全部项目」不切换当前项目（侧栏高亮不变）', extra.sidebarAfter === extra.sidebarBefore);
      check('点「全部项目」不切换当前项目（标题栏项目名不变）', extra.titlebarAfter === extra.titlebarBefore);
      check('搜索占位符改为「全部项目」口径', (extra.placeholder || '').indexOf('全部项目') >= 0);
      window.r188Extra = extra;
    } },
    { name: 'library-project', run: async () => {
      const targetId = m.extraProjectIds && m.extraProjectIds[0];
      if (targetId == null) throw Error('夹具没有额外项目');
      const targetName = '社区运营';
      const card = qa('[data-zs-library-project]').find((el) => el.dataset.zsLibraryProject === targetId);
      if (card == null) throw Error('搜索页左栏没有目标项目卡');
      clearCommands();
      card.click();
      await until(() => sidebarActiveText().indexOf(targetName) >= 0, '侧栏当前项目切到社区运营', 25000);
      await untilCommand('search.query', '切项目后重新检索 search.query', 25000);
      await wait(900);
      const search = lastCommand('search.query');
      extra.projectId = targetId;
      extra.searchParams = search && search.params;
      extra.currentCardId = q('[data-zs-library-project].is-current') == null ? null : q('[data-zs-library-project].is-current').dataset.zsLibraryProject;
      extra.currentCardText = textOf(q('[data-zs-library-project].is-current'));
      extra.sidebarActive = sidebarActiveText();
      extra.titlebarProject = textOf(q('.zs-tb-project-name'));
      extra.scopeNote = textOf(q('.library-page .filter-note'));
      extra.placeholder = (qa('.library-page .page-filters input').find((el) => (el.getAttribute('placeholder') || '').indexOf('搜') >= 0) || {}).placeholder || '';
      extra.errorPanel = textOf(q('.library-page .panel.warning'));
      check('点项目卡同时切换当前项目（侧栏高亮=社区运营）', extra.sidebarActive.indexOf(targetName) >= 0);
      check('点项目卡同时切换当前项目（标题栏项目名=社区运营）', extra.titlebarProject.indexOf(targetName) >= 0);
      check('目标项目卡显示选中态', extra.currentCardId === targetId);
      check('切项目后 search.query scope=project 且带目标项目 ID', extra.searchParams != null && extra.searchParams.scope === 'project' && extra.searchParams.projectId === targetId);
      check('范围说明切到该项目', /社区运营/.test(extra.scopeNote));
      check('搜索占位符切到该项目', /社区运营/.test(extra.placeholder));
      check('切项目没有检索错误', extra.errorPanel === '');
      window.r188Extra = extra;
    } },
  ];

  /** 四页几何：成员管理 / 任务看板 / 文件与 Git / 搜索与收藏。
   *  页面就绪标准：左栏出现 .project-card（而不是写死时长）。 */
  const runGeometry = async () => {
    await go('/project/' + m.projectId + '/members');
    await until(() => q('.members-page') != null && qa('[data-zs-members-project]').length >= 4 && memberRows().length >= 1, '成员页装载', 30000);
    await wait(900);
    extra.members = measureRail('members');
    await go('/board?scope=all');
    await until(() => q('.tasks-board-page') != null && qa('[data-zs-board-project]').length >= 4 && qa('[data-zs-task-id]').length > 0, '看板装载', 30000);
    await wait(900);
    extra.board = measureRail('board');
    await go('/project/' + m.projectId + '/files');
    await until(() => q('.page.fg-page') != null && qa('[data-zs-files-project]').length >= 4 && q('.fg-rail-content') != null && q('.fg-rail-content').children.length > 0, '文件页装载', 30000);
    await wait(900);
    extra.files = measureRail('files');
    await go('/library');
    await until(() => q('.page.library-page') != null && qa('[data-zs-library-project]').length >= 4, '搜索页装载', 30000);
    await wait(900);
    extra.library = measureRail('library');
    const expected = 16;
    extra.expectedGap = expected;
    check('成员页：卡片左缘 − 页面左缘 = 16px（实测 ' + extra.members.leftGap + '）', extra.members.ok === true && Math.abs(extra.members.leftGap - expected) <= 1);
    check('成员页：卡片右缘 − 分隔线 = 16px（实测 ' + (extra.members.dividerGapPseudo != null ? extra.members.dividerGapPseudo : extra.members.dividerGapRail) + '）', extra.members.ok === true && Math.abs((extra.members.dividerGapPseudo != null ? extra.members.dividerGapPseudo : extra.members.dividerGapRail) - expected) <= 1);
    check('看板：卡片左缘 − 页面左缘 = 16px（实测 ' + extra.board.leftGap + '）', extra.board.ok === true && Math.abs(extra.board.leftGap - expected) <= 1);
    check('看板：卡片右缘 − 分隔线 = 16px（实测 ' + (extra.board.dividerGapPseudo != null ? extra.board.dividerGapPseudo : extra.board.dividerGapRail) + '）', extra.board.ok === true && Math.abs((extra.board.dividerGapPseudo != null ? extra.board.dividerGapPseudo : extra.board.dividerGapRail) - expected) <= 1);
    check('文件页：卡片左缘 − 页面左缘 = 16px（实测 ' + extra.files.leftGap + '）', extra.files.ok === true && Math.abs(extra.files.leftGap - expected) <= 1);
    check('文件页：卡片右缘 − 分隔线 = 16px（实测 ' + (extra.files.dividerGapPseudo != null ? extra.files.dividerGapPseudo : extra.files.dividerGapRail) + '）', extra.files.ok === true && Math.abs((extra.files.dividerGapPseudo != null ? extra.files.dividerGapPseudo : extra.files.dividerGapRail) - expected) <= 1);
    check('搜索页：卡片左缘 − 页面左缘 = 16px（实测 ' + extra.library.leftGap + '）', extra.library.ok === true && Math.abs(extra.library.leftGap - expected) <= 1);
    check('搜索页：卡片右缘 − 分隔线 = 16px（实测 ' + (extra.library.dividerGapPseudo != null ? extra.library.dividerGapPseudo : extra.library.dividerGapRail) + '）', extra.library.ok === true && Math.abs((extra.library.dividerGapPseudo != null ? extra.library.dividerGapPseudo : extra.library.dividerGapRail) - expected) <= 1);
    check('同一窗口内：成员/看板 卡片左留白与到分隔线留白一致（差 ≤1px）', extra.members.ok === true && extra.board.ok === true
      && Math.abs(extra.members.leftGap - extra.board.leftGap) <= 1
      && Math.abs((extra.members.dividerGapPseudo != null ? extra.members.dividerGapPseudo : extra.members.dividerGapRail) - (extra.board.dividerGapPseudo != null ? extra.board.dividerGapPseudo : extra.board.dividerGapRail)) <= 1);
    extra.viewportWidth = window.innerWidth;
    window.r188Extra = extra;
  };

  window.r188Scenes = scenes;
  window.r188Shot = async (index) => {
    const scene = scenes[index];
    if (window.r188Reset != null) window.r188Reset();
    let error = null;
    try { await scene.run(); } catch (e) { error = String((e && e.message) || e); }
    await wait(250);
    const visibleText = (document.body.innerText || '').slice(0, 8000);
    const extra = window.r188Extra || null;
    const layout = {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
    return { name: scene.name, keepOpen: scene.keepOpen === true, error, visibleText, extra, layout, checks: checks.slice() };
  };
  window.r188Cleanup = async () => { await closeOverlays(); };
})();`;
const scenesPath = path.join(run, 'r188-scenes.js');
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
const ANIM_STYLE = '<style id="r188-capture-anim">*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>';
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
  await js('window.r188Meta = ' + JSON.stringify(JSON.parse(metaJson)));
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
    const names = await js('window.r188Scenes.map(function (scene) { return scene.name; })');
    const keep = await js('window.r188Scenes.map(function (scene) { return scene.keepOpen === true; })');
    const viewports = await js('window.r188Scenes.map(function (scene) { return scene.viewport || null; })');
    for (let i = 0; i < names.length; i++) {
      if (ONLY.length && ONLY.indexOf(names[i]) < 0) continue;
      const viewport = viewports[i] || { width: 1360, height: 900 };
      await setViewport(viewport.width, viewport.height);
      try { await js('window.r188 != null ? (window.r188.clear(), true) : true'); } catch { /* 记录器不可用时场景内命令断言会失败并如实报告 */ }
      let step = null;
      let failure = null;
      try { step = await js('window.r188Shot(' + i + ')'); } catch (error) { failure = String((error && error.message) || error); }
      let commandLog = [];
      try { commandLog = await js('window.r188 != null ? window.r188.commands() : []'); } catch { commandLog = []; }
      let sceneReload = false;
      try { sceneReload = await js('window.r188Scenes[' + i + '].reloadAfter === true'); } catch { sceneReload = false; }
      if (keep[i] !== true) {
        try { await js('window.r188Cleanup ? window.r188Cleanup() : true'); } catch { /* 清理失败不影响截图 */ }
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
      console.log('R188_SHOT ' + name + ' ' + (image == null ? 'no-image' : image.width + 'x' + image.height) + (step.error ? ' ERROR=' + step.error : ''));
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
    console.error('R188_CAPTURE_FAIL ' + String((error && error.stack) || error));
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
    workspace,
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
