/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R195 九项界面反馈的隔离验收（隔离数据 + 假运行时；零真实模型、不安装、不打包）。
 *
 * 覆盖（用户 2026-11-08 反馈）：
 *  1) 对话/对话串/私信/房间主池卡的图片附件 → 真实缩略图（非文件名 chip）
 *  2) 房间主池卡「引用」→ 结构化引用卡（与对话串一致；不再塞纯文本、不截 400 字）
 *  3) 操作条统一在消息内容（气泡/图片/文件）下方：对话串/私信 + 房间卡片
 *  4) 非 Git 目录不再出现「Git 部分信息读取失败 / 读取仓库状态未完成」与英文 stderr
 *  5) 私信执行状态条在带鱼屏（3233 CSS px）下内容宽 ≤1024 且水平居中；1360 保持 auto
 *  6) 独立研讨成员弹层：所有行单行等高、勾选同一 x、长运行时提示省略号截断
 *  7) 搜索「更多筛选」展开行：控件统一 30px、对齐、收起仍是单行 48px
 *  8) 本次运行设置菜单不再有「调整独立研讨成员」重复项
 *  9) 设置里可改本人名字；消息署名、引用来源与私信署名随之显示，刷新后仍生效
 *
 * 用法：node scripts/capture-r195-ui.cjs [--run=name]
 * 产物：dist/r195-ui/<run>/（截图 + result.json + summary.json + seed.log + process.log）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runArg = process.argv.find((a) => a.startsWith('--run='));
const runName = runArg == null
  ? 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
const run = path.join(root, 'dist', 'r195-ui', runName);
const data = path.join(run, 'data');
const workspace = path.join(os.tmpdir(), 'zs-r195-workspace', runName);
const project = path.join(workspace, '读书会筹备');
fs.rmSync(run, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const mainCjs = path.join(root, 'dist', 'ui', 'main.cjs');
if (!fs.existsSync(mainCjs)) { console.error('缺少 dist/ui/main.cjs：请先运行 node scripts/build-ui.mjs'); process.exit(2); }

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data,
  ZS_RUNTIME: 'fake',
  ZS_ALLOW_FAKE: '1',
  ZS_REAL_DISPATCH_GUARD: '1',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r195-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

/* ---------------- 场景脚本（渲染进程） ---------------- */
const scenesSource = String.raw`(() => {
  const m = window.r195Meta;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (check, label, timeout) => {
    const end = Date.now() + (timeout || 30000);
    while (Date.now() < end) { let ok = false; try { ok = !!check(); } catch { ok = false; } if (ok) return; await wait(80); }
    throw Error('等待超时：' + (label || ''));
  };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const textOf = (el) => (el == null ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
  const go = async (route) => { window.location.hash = '#' + route; await wait(1100); };
  const rect = (el) => { if (el == null) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const near = (a, b, t = 1.5) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t;
  const body = () => document.body.innerText || '';
  const extra = {};
  const shotPlan = [];
  const planShot = (key, route, selector) => shotPlan.push({ key, route, selector });
  planShot('settings-name', '/settings?section=appearance', '[data-zs-viewer-name-input="1"]');
  planShot('thread-image', '/thread/' + m.chat.threadId, '[data-zs-message-image="ready"]');
  planShot('room-card', '/project/' + m.projectId + '/room/' + m.roomId, '.root-card');
  planShot('library-filters', '/library', '[data-zs-library]');
  planShot('dm-wide', '/dm/' + m.dm, '[data-zs-execution-status]');

  const roomRoute = '/project/' + m.projectId + '/room/' + m.roomId;
  const threadRoute = '/thread/' + m.chat.threadId;

  /** 设置页写入本人名字。 */
  async function applyViewerName(name) {
    await go('/settings?section=appearance');
    await until(() => q('[data-zs-viewer-name-input="1"]'), '名字设置行', 30000);
    await until(() => { const el = q('[data-zs-viewer-name-input="1"]'); return el != null && el.disabled === false; }, '名字读取完成', 20000);
    const input = q('[data-zs-viewer-name-input="1"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(120);
    q('[data-zs-viewer-name-save="1"]').click();
    await until(() => q('[data-zs-viewer-name="set"]') != null && (q('[data-zs-viewer-name-status]')?.getAttribute('data-zs-viewer-name-status') || '').includes(name), '名字已保存并回读', 20000);
  }

  /** 打开房间输入区的「本次运行设置」菜单。 */
  async function openRunSettingsMenu() {
    const button = q('[aria-label="本次运行设置"]');
    if (button == null) throw Error('找不到本次运行设置按钮');
    button.click();
    await until(() => q('.menu, [role="menu"]') != null, '运行设置菜单', 8000);
    await wait(200);
  }

  window.runMain = async () => {
    // ── 9) 设置里改名字（真值写 daemon，后面用刷新验证持久化） ──
    await applyViewerName('阿众测试');
    extra.savedName = q('[data-zs-viewer-name-status]')?.getAttribute('data-zs-viewer-name-status') || '';

    // ── 3) 对话串：操作条在消息内容下方；1) 对话串图片真预览；9) 本人署名 ──
    await go(threadRoute);
    await until(() => q('.msg-list.is-replies'), '回复串', 30000);
    await wait(1500);
    const humanAuthor = textOf(q('.msg-list.is-replies .msg.msg-human .msg-author'));
    extra.threadHumanAuthor = humanAuthor;
    check('对话串本人消息署名变成设置的名字', humanAuthor === '阿众测试', humanAuthor);
    extra.threadAvatars = qa('.msg-list.is-replies .msg:not(.msg-system) .msg-avatar .avatar').map((el) => rect(el).w);

    // 1) 对话串图片：真实 <img> 且尺寸足够大
    let threadImage = null;
    try {
      await until(() => qa('.msg-list.is-replies [data-zs-message-image="ready"]').length > 0, '对话串图片预览', 25000);
      threadImage = qa('.msg-list.is-replies [data-zs-message-image="ready"]')[0];
    } catch { /* 下面断言会如实失败 */ }
    const threadImg = threadImage?.querySelector('img') ?? null;
    extra.threadImage = threadImage == null ? null : { box: rect(threadImage), img: rect(threadImg), naturalW: threadImg?.naturalWidth ?? 0, naturalH: threadImg?.naturalHeight ?? 0 };
    check('对话串图片附件渲染真实缩略图（<img> 且有自然尺寸）', threadImg != null && threadImg.naturalWidth > 0, extra.threadImage);
    check('对话串图片缩略图尺寸不再是小图标（宽 ≥ 96px 且 ≤ 260px）',
      threadImage != null && rect(threadImage).w >= 96 && rect(threadImage).w <= 260,
      threadImage == null ? null : rect(threadImage));

    // 3) 对话串消息：复制/引用按钮在正文下方（原在作者行 / 气泡上方）
    const replyMsgs = qa('.msg-list.is-replies .msg:not(.msg-system)');
    const actionRows = [];
    for (const msg of replyMsgs) {
      const actions = msg.querySelector('.msg-actions');
      if (actions == null) continue;
      const contentEls = Array.from(msg.querySelectorAll('.md-view, .msg-human-bubble, .msg-text, [data-zs-message-images]'))
        .filter((el) => !actions.contains(el) && rect(el).h > 0);
      if (contentEls.length === 0) continue;
      const contentBottom = Math.max(...contentEls.map((el) => rect(el).bottom));
      actionRows.push({ actions: rect(actions), contentBottom, head: msg.querySelector('.msg-head') == null ? null : rect(msg.querySelector('.msg-head')) });
      break;
    }
    extra.threadActionRow = actionRows[0] ?? null;
    check('对话串操作条在正文下方（不再在作者行/气泡上方）',
      actionRows.length > 0 && actionRows[0].actions.top >= actionRows[0].contentBottom - 2,
      actionRows[0]);

    // ── 2) 房间主池卡「引用」→ 结构化引用卡；1) 主池图片预览；3) 卡片操作条位置 ──
    await go(roomRoute);
    await until(() => qa('.root-card').length > 0, '房间主池', 30000);
    await wait(1500);
    const cards = qa('.root-card');
    const quoteCard = cards.find((card) => textOf(card).includes('请把这次读书会的准备工作整理成三步清单')) ?? cards[0];
    const quoteCardBody = textOf(quoteCard.querySelector('.root-body'));
    extra.quoteCardBody = quoteCardBody.slice(0, 200);
    const actionsRow = quoteCard.querySelector('.root-card-actions-row');
    const rootBody = quoteCard.querySelector('.root-body');
    const inlineAtts = quoteCard.querySelector('[data-zs-inline-attachments], [data-zs-room-card-image], .msg-image-grid');
    extra.rootCardGeometry = { actions: rect(actionsRow), body: rect(rootBody), attachments: rect(inlineAtts) };
    check('房间主池卡片有操作条（复制/引用/收藏）', actionsRow != null && /复制/.test(textOf(actionsRow)) && /引用/.test(textOf(actionsRow)), rect(actionsRow));
    check('房间卡片操作条在消息正文下方', actionsRow != null && rootBody != null && rect(actionsRow).top >= rect(rootBody).bottom - 2, extra.rootCardGeometry);
    check('房间卡片操作条在图片/附件之后（整条消息内容下方）',
      actionsRow != null && (inlineAtts == null || rect(actionsRow).top >= rect(inlineAtts).bottom - 2), extra.rootCardGeometry);
    const quoteButton = Array.from(actionsRow.querySelectorAll('button')).find((b) => textOf(b).includes('引用'));
    check('房间卡片引用按钮存在', quoteButton != null);
    if (quoteButton != null) {
      quoteButton.click();
      await until(() => q('[data-zs-conversation-quote-count]') != null || q('.composer-quote-dock') != null, '结构化引用卡', 12000);
      await wait(300);
      const dock = q('[data-zs-conversation-quote-count]') ?? q('.composer-quote-dock');
      // 引用卡默认收在「N 条对话引用」气泡里；点开浮窗再读卡片正文与来源。
      const summaryBtn = q('.composer-quote-summary') ?? dock?.querySelector('button');
      if (summaryBtn != null) {
        summaryBtn.click();
        try { await until(() => qa('[data-zs-conversation-quote]').length > 0, '引用卡详情', 8000); } catch { /* 下面断言 */ }
        await wait(200);
      }
      const quoteCards = qa('[data-zs-conversation-quote]');
      const quoteText = quoteCards.length > 0 ? textOf(quoteCards[0]) : textOf(dock);
      const textarea = q('.composer textarea, textarea');
      extra.quoteDock = { dock: textOf(dock).slice(0, 120), quoteText: quoteText.slice(0, 200), textarea: (textarea?.value ?? '').slice(0, 80) };
      check('引用后出现结构化引用卡（不是正文里的一堆引用文字）', quoteCards.length > 0 || /条对话引用/.test(textOf(dock)), extra.quoteDock);
      check('引用卡保留完整正文（不是 400 字截断/纯文本粘贴）', quoteText.includes(quoteCardBody.slice(0, 24)), quoteText.slice(0, 120));
      check('引用来源显示本人名字', quoteText.includes('阿众测试'), quoteText.slice(0, 80));
      check('可编辑输入区没有被塞入引用正文', textarea == null || !(textarea.value || '').includes('引用'), (textarea?.value ?? '').slice(0, 80));
    }
    // 1) 房间主池图片消息：直接预览
    let roomImage = null;
    try {
      await until(() => qa('.root-card [data-zs-message-image="ready"], .root-card [data-zs-room-card-image] img').length > 0, '房间主池图片预览', 25000);
      roomImage = qa('.root-card [data-zs-message-image="ready"], .root-card [data-zs-room-card-image] img')[0];
    } catch { /* 下面断言 */ }
    const roomImg = roomImage?.tagName === 'IMG' ? roomImage : roomImage?.querySelector('img') ?? null;
    extra.roomImage = roomImage == null ? null : { box: rect(roomImage), img: rect(roomImg), naturalW: roomImg?.naturalWidth ?? 0 };
    check('房间主池图片消息显示真实预览（<img> 已解码）', roomImg != null && roomImg.naturalWidth > 0, extra.roomImage);
    check('房间主池图片预览不是小图标（宽 ≥ 96px）', roomImage != null && (roomImg != null ? rect(roomImg).w : rect(roomImage).w) >= 96, extra.roomImage);

    // ── 8) 本次运行设置不再有「调整独立研讨成员」；6) 成员弹层行统一 ──
    await openRunSettingsMenu();
    const menuText = textOf(q('.menu, [role="menu"]'));
    extra.runSettingsMenu = menuText.slice(0, 300);
    check('本次运行设置菜单不再出现「调整独立研讨成员」', !menuText.includes('调整独立研讨成员'), menuText.slice(0, 200));
    const deliberateItem = qa('.menu button, [role="menu"] button').find((b) => textOf(b) === '独立研讨');
    check('仍保留「独立研讨」开启入口', deliberateItem != null, menuText.slice(0, 200));
    if (deliberateItem != null) {
      deliberateItem.click();
      await until(() => q('[data-zs-deliberation-chip="1"]') != null, '独立研讨芯片', 10000);
      await wait(300);
      extra.chip = textOf(q('[data-zs-deliberation-chip="1"]'));
      q('[data-zs-deliberation-chip="1"]').click();
      await until(() => q('[data-zs-deliberation-members]') != null, '独立研讨成员弹层', 10000);
      await wait(300);
      const rows = qa('[data-zs-deliberation-member-row]');
      const rowBoxes = rows.map((row) => rect(row));
      extra.memberRows = rows.length;
      extra.memberRowHeights = rowBoxes.map((b) => b.h);
      extra.memberCheckXs = rows.map((row) => rect(row.querySelector('[data-zs-deliberation-member-check]')).left);
      check('独立研讨成员弹层列出行（≥2 位）', rows.length >= 2, rows.length);
      check('所有成员行等高（单行 30px）', rowBoxes.length >= 2 && rowBoxes.every((b) => near(b.h, 30, 1.5)), extra.memberRowHeights);
      check('勾选图标在同一 x 竖线上', extra.memberCheckXs.length >= 2 && extra.memberCheckXs.every((x) => near(x, extra.memberCheckXs[0], 1.5)), extra.memberCheckXs);
      const runtimeSpan = rows[0].querySelector('[data-zs-deliberation-member-runtime]');
      if (runtimeSpan != null) {
        const longHint = 'DeepSeek Harness · magpie/workbuddy-ai/deepseek-v4.1-flash-sg';
        const rowBefore = rect(rows[0]).h;
        runtimeSpan.textContent = longHint;
        await wait(120);
        const rowAfter = rect(rows[0]).h;
        const rs = getComputedStyle(runtimeSpan);
        extra.longRuntime = { rowBefore, rowAfter, overflow: rs.overflow, textOverflow: rs.textOverflow, whiteSpace: rs.whiteSpace, scrollW: runtimeSpan.scrollWidth, clientW: runtimeSpan.clientWidth };
        check('超长运行时提示不再把行折成两行', near(rowBefore, rowAfter, 1.5) && rowAfter <= 32, extra.longRuntime);
        check('超长运行时提示以省略号截断（overflow hidden + ellipsis）',
          rs.overflow === 'hidden' || rs.overflowX === 'hidden' || rs.textOverflow === 'ellipsis', extra.longRuntime);
      } else {
        check('成员行带运行时提示列', false);
      }
      const done = qa('.menu button, [role="menu"] button').find((b) => textOf(b) === '完成');
      if (done != null) done.click();
    }

    // ── 4) 非 Git 目录：不再出现两条失败提示与英文 stderr ──
    const nonGitProjectId = m.extraProjectIds != null && m.extraProjectIds.length > 0 ? m.extraProjectIds[0] : null;
    if (nonGitProjectId != null) {
      await go('/project/' + nonGitProjectId + '/files');
      await until(() => textOf(document.querySelector('.page') ?? document.body).length > 40, '非 Git 项目文件页', 30000);
      await wait(2600);
      const nonGitText = body();
      extra.nonGitSnippet = nonGitText.slice(0, 400);
      extra.nonGitReadErrors = q('[data-zs-git-read-errors]') != null;
      check('非 Git 目录不显示「Git 部分信息读取失败」', !nonGitText.includes('Git 部分信息读取失败'), extra.nonGitReadErrors);
      check('非 Git 目录不显示「读取仓库状态未完成」', !nonGitText.includes('读取仓库状态未完成'));
      check('用户可见文本不含原始 git 英文 stderr', !/fatal:|not a git repository/i.test(nonGitText), (nonGitText.match(/.{0,30}(?:fatal:|not a git repository).{0,40}/i) ?? [null])[0]);
    } else {
      check('夹具含非 Git 项目', false);
    }

    // ── 7) 搜索「更多筛选」展开行 ──
    await go('/library');
    await until(() => q('[data-zs-library]') != null, '搜索与收藏页', 30000);
    await wait(1000);
    const filters = q('.page-filters');
    const collapsedH = rect(filters).h;
    const moreButton = q('[data-zs-library-more]');
    check('搜索工具栏默认单行（高 48px）', near(collapsedH, 48, 2), collapsedH);
    if (moreButton != null) moreButton.click();
    await wait(500);
    const morePanel = q('[data-zs-library-more-panel]');
    extra.moreFilters = { collapsedH, panel: rect(morePanel), expandedToolbarH: rect(filters).h };
    check('「更多筛选」有独立展开面板', morePanel != null, extra.moreFilters);
    if (morePanel != null) {
      const controls = Array.from(morePanel.querySelectorAll('input, select, .select, [role="combobox"]'));
      const controlBoxes = controls.map((el) => rect(el));
      extra.moreFilterControls = controlBoxes;
      check('展开面板控件统一 30px 高', controlBoxes.length >= 3 && controlBoxes.every((b) => near(b.h, 30, 1.5)), controlBoxes.map((b) => b.h));
      const tops = controlBoxes.map((b) => b.top);
      check('展开面板控件基线一致', tops.length >= 2 && tops.every((t) => near(t, tops[0], 1.5)), tops);
      const dates = Array.from(morePanel.querySelectorAll('input[type="date"]')).map((el) => rect(el));
      check('两个日期输入等宽', dates.length === 2 && near(dates[0].w, dates[1].w, 1.5), dates.map((d) => d.w));
      const panelBox = rect(morePanel);
      check('展开面板不溢出工具栏横向范围', panelBox.left >= rect(filters).left - 1 && panelBox.right <= rect(filters).right + 1, { panel: panelBox, toolbar: rect(filters) });
    }
    if (moreButton != null) { moreButton.click(); await wait(400); }
    check('收起筛选后工具栏恢复单行 48px', near(rect(q('.page-filters')).h, 48, 2), rect(q('.page-filters')).h);

    // ── 9) 私信署名 + 5) 常规宽度下状态条保持 auto（宽屏断言在 runWide） ──
    await go('/dm/' + m.dm);
    await until(() => q('.msg-list.is-replies'), '私信', 30000);
    await wait(1400);
    const dmAuthors = qa('.msg-list.is-replies .msg.msg-human .msg-author').map(textOf);
    extra.dmHumanAuthors = dmAuthors;
    check('私信本人消息署名变成设置的名字', dmAuthors.length > 0 && dmAuthors.every((name) => name === '阿众测试'), dmAuthors);
    const band1360 = q('[data-zs-execution-band-width]');
    extra.band1360 = band1360 == null ? null : { width: band1360.getAttribute('data-zs-execution-band-width'), centered: band1360.getAttribute('data-zs-execution-band-centered'), phase: band1360.getAttribute('data-zs-execution-phase') };
    check('常规宽度（1360）状态条保持 auto、不强行收窄', band1360 == null || (band1360.getAttribute('data-zs-execution-band-width') === 'auto' && band1360.getAttribute('data-zs-execution-band-centered') === '0'), extra.band1360);

    return { ok: checks.every((c) => c.ok), checks, extra, shotPlan };
  };

  /** 刷新之后：名字持久化（daemon app.settings）与消息署名仍生效。 */
  window.runAfterReload = async () => {
    checks.length = 0;
    await go('/settings?section=appearance');
    await until(() => q('[data-zs-viewer-name-input="1"]') != null, '名字设置行（刷新后）', 30000);
    await until(() => { const el = q('[data-zs-viewer-name-input="1"]'); return el != null && el.disabled === false; }, '名字读取完成（刷新后）', 20000);
    const input = q('[data-zs-viewer-name-input="1"]');
    extra.reloadedName = input.value;
    check('刷新后设置页输入框仍是已保存的名字', input.value === '阿众测试', input.value);
    check('刷新后状态行显示已设置名字', (q('[data-zs-viewer-name-status]')?.getAttribute('data-zs-viewer-name-status') || '').includes('阿众测试'), q('[data-zs-viewer-name-status]')?.getAttribute('data-zs-viewer-name-status') || '');
    await go(threadRoute);
    await until(() => q('.msg-list.is-replies'), '回复串（刷新后）', 30000);
    await wait(1400);
    const reloadedAuthor = textOf(q('.msg-list.is-replies .msg.msg-human .msg-author'));
    extra.reloadedAuthor = reloadedAuthor;
    check('刷新后对话串本人署名仍显示设置的名字', reloadedAuthor === '阿众测试', reloadedAuthor);
    return { ok: checks.every((c) => c.ok), checks, extra, shotPlan };
  };

  /** 带鱼屏：3233 CSS px 下私信「待你处理」状态条宽 ≤1024 且居中。 */
  window.runWide = async () => {
    checks.length = 0;
    await go('/dm/' + m.dm);
    await until(() => q('[data-zs-execution-status]') != null, '私信执行状态条（宽屏）', 30000);
    await wait(1400);
    const band = q('[data-zs-execution-band-width]');
    const status = q('[data-zs-execution-status]');
    const actions = q('[data-zs-execution-actions]');
    const box = rect(band ?? status);
    // 内容块应在**所在对话列**里居中（私信左栏占位不参与），而不是在整个窗口里居中。
    const parentBox = band?.parentElement == null ? null : rect(band.parentElement);
    const centerOffset = box != null && parentBox != null
      ? (box.left + box.right) / 2 - (parentBox.left + parentBox.right) / 2
      : null;
    extra.wide = { innerWidth: window.innerWidth, innerHeight: window.innerHeight, phase: status?.getAttribute('data-zs-execution-phase'), band: box, parent: parentBox, centerOffset, bandWidth: band?.getAttribute('data-zs-execution-band-width') ?? null, centered: band?.getAttribute('data-zs-execution-band-centered') ?? null, actions: rect(actions), overflow: document.documentElement.scrollWidth };
    check('私信状态条真实进入「等待处理」阶段', status?.getAttribute('data-zs-execution-phase') === 'WAITING_FOR_USER', extra.wide.phase);
    check('带鱼屏下状态条内容宽收到 ≤1024px', box != null && box.w <= 1026, box?.w);
    check('带鱼屏下状态条在对话列内水平居中', centerOffset != null && Math.abs(centerOffset) <= 8, centerOffset);
    check('状态条与操作按钮成组（按钮组在内容块内）', actions != null && box != null && rect(actions).right <= box.right + 1 && rect(actions).left >= box.left - 1, { actions: rect(actions), band: box });
    check('带鱼屏下没有横向溢出', document.documentElement.scrollWidth <= window.innerWidth + 2, extra.wide.overflow);
    return { ok: checks.every((c) => c.ok), checks, extra, shotPlan };
  };

  /** 截图前把界面摆到指定状态。 */
  window.applyShot = async (key) => {
    if (key === 'settings-name') { await go('/settings?section=appearance'); await wait(1200); return true; }
    if (key === 'thread-image') { await go(threadRoute); await until(() => qa('.msg-list.is-replies [data-zs-message-image="ready"]').length > 0, '对话串图片', 25000); await wait(600); return true; }
    if (key === 'room-card') {
      await go(roomRoute);
      await until(() => qa('.root-card').length > 0, '房间主池', 25000);
      await wait(900);
      const cards = qa('.root-card');
      const card = cards.find((c) => textOf(c).includes('请把这次读书会的准备工作整理成三步清单')) ?? cards[0];
      const quote = Array.from(card.querySelectorAll('.root-card-actions-row button')).find((b) => textOf(b).includes('引用'));
      if (quote != null) quote.click();
      await wait(900);
      return true;
    }
    if (key === 'library-filters') { await go('/library'); await until(() => q('[data-zs-library-more]') != null, '搜索页', 25000); await wait(600); const b = q('[data-zs-library-more]'); if (b.getAttribute('data-zs-library-more') !== 'open') b.click(); await wait(700); return true; }
    if (key === 'dm-wide') { await go('/dm/' + m.dm); await until(() => q('[data-zs-execution-status]') != null, '私信状态条', 25000); await wait(900); return true; }
    return false;
  };
})();`;

const metaPath = path.join(data, 'guide-fixture.json');

const wrapperSource = String.raw`const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const OUT = __OUT__;
const META_PATH = __META__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('browser-window-created', (_e, win) => {
  win.show = () => {};
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      try { fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot fail ' + name + ' ' + e); }
    };
    const ready = async () => {
      for (let i = 0; i < 200; i++) { if (await js('document.readyState === "complete" && document.body.innerText.length > 20')) break; await sleep(250); }
      await sleep(800);
      for (let i = 0; i < 200; i++) { if (await js('document.body.classList.contains("hifi-on")')) break; await sleep(250); }
      try { await js('document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation-duration:0.001s !important;animation-delay:0s !important;transition:none !important}</style>")'); } catch {}
    };
    const results = [];
    const injectScene = async () => {
      const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      await js('window.r195Meta = ' + JSON.stringify(meta));
      await js(fs.readFileSync(SCENES, 'utf8'));
    };
    try {
      win.setContentSize(1360, 900);
      await ready();
      await injectScene();

      const main = await js('window.runMain()');
      results.push({ phase: 'main', ...main });
      const plan = main.shotPlan || [];
      for (const item of plan) {
        if (item.key === 'dm-wide') continue;
        try {
          const applied = await js('window.applyShot(' + JSON.stringify(item.key) + ')');
          if (applied) { await sleep(500); await shot('01-' + item.key); }
        } catch (e) { console.error('shot state fail ' + item.key + ' ' + e); }
      }

      // 刷新：验证名字持久化（daemon app.settings）；刷新后重新注入夹具与场景脚本。
      win.webContents.reload();
      await sleep(1200);
      await ready();
      await injectScene();
      const after = await js('window.runAfterReload()');
      results.push({ phase: 'afterReload', ...after });
      await shot('02-after-reload-settings');

      // 带鱼屏：1360 物理宽 / 0.42 缩放 ≈ 3238 CSS px（matchMedia min-width:2000 生效）
      win.webContents.setZoomFactor(0.42);
      await sleep(600);
      const wide = await js('window.runWide()');
      results.push({ phase: 'wide', ...wide });
      await js('window.applyShot("dm-wide")').catch(() => false);
      await sleep(600);
      await shot('03-dm-wide-3233');

      const mergedOk = results.every((r) => r.ok === true);
      const checks = results.flatMap((r) => (r.checks || []).map((c) => ({ ...c, phase: r.phase })));
      const failed = checks.filter((c) => !c.ok).map((c) => c.phase + ':' + c.name);
      const result = {
        ok: mergedOk,
        checks,
        failed,
        phases: results.map((r) => ({ phase: r.phase, ok: r.ok, extra: r.extra })),
        extra: Object.fromEntries(results.map((r) => [r.phase, r.extra])),
      };
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
      console.log('R195_RESULT ' + JSON.stringify({ ok: result.ok, checks: checks.length, failed }));
    } catch (e) {
      console.error('R195_FAIL ' + String((e && e.stack) || e));
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    app.quit();
  });
});
require(MAIN);
setTimeout(() => { app.quit(); }, 600000).unref();`;

const scenesPath = path.join(run, 'r195-scenes.js');
fs.writeFileSync(scenesPath, scenesSource);
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(scenesPath))
  .replace('__META__', JSON.stringify(metaPath))
  .replace('__OUT__', JSON.stringify(run)));

/* 夹具：r170-fixture --r192（图片在房间主池/回复串/私信各一份）+ 把私信任务置为
 * 「等待用户」（仅隔离夹具 DB 内的布局素材；不是真实运行证据）。 */
(async () => {
  try {
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts', 'lib', 'r170-fixture.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      outfile: path.join(run, 'seed.cjs'), logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project, '--r192'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败：' + (seeded.stderr || seeded.stdout));

    // 私信任务置「等待用户」：只为验证 3233px 下状态条布局（隔离数据，不触碰用户数据）。
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const updateScript = path.join(run, 'set-dm-waiting.cjs');
    fs.writeFileSync(updateScript, String.raw`const path=require('node:path');
const Database=require(process.argv[3]);
const db=new Database(path.join(process.argv[2],'state.sqlite'));
const meta=JSON.parse(require('node:fs').readFileSync(path.join(process.argv[2],'guide-fixture.json'),'utf8'));
const row=db.prepare("SELECT id FROM tasks WHERE conversation_id=? AND kind='dm_turn' ORDER BY rowid DESC LIMIT 1").get(meta.dm);
if(row==null){console.error('dm task missing');process.exitCode=2;}
else{db.prepare("UPDATE tasks SET status='WAITING_USER', revision=revision+1 WHERE id=?").run(row.id);console.log('dm task '+row.id+' -> WAITING_USER');}
db.close();`);
    const updated = spawnSync(process.execPath, [updateScript, data, path.join(root, 'node_modules', 'better-sqlite3')], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    fs.writeFileSync(path.join(run, 'dm-waiting.log'), (updated.stdout || '') + '\n' + (updated.stderr || ''));
    if (updated.status !== 0) throw Error('私信等待态夹具失败：' + (updated.stderr || updated.stdout));
  } catch (error) {
    console.error(String(error));
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ok: false, error: String(error) }, null, 2));
    process.exitCode = 1;
    return;
  }

  const electron = spawnSync(require('electron'), [wrapperPath], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 900000 });
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8')); } catch { result = { ok: false, error: '未产出 result.json（见 process.log）' }; }
  const summary = {
    ok: electron.status === 0 && result.ok === true,
    processExit: electron.status,
    run: path.relative(root, run),
    checks: (result.checks || []).length,
    failedChecks: result.failed || (result.checks || []).filter((c) => !c.ok).map((c) => c.name),
    error: result.error || null,
  };
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({ ...summary, details: result }, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, processExit: summary.processExit, checks: summary.checks, failed: summary.failedChecks, error: summary.error }, null, 2));
  if (!summary.ok) process.exitCode = 1;
})();
