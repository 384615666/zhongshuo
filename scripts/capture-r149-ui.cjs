/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * R149 真实界面验证：正式 logo + 前端开发说明文字清理（独立验证员脚本）。
 *
 * - 隔离：临时数据根 dist/r149-ui/<run>/data，项目目录也在 <run> 内；绝不读取用户运行数据。
 * - 零真实模型调用：ZS_RUNTIME=fake + ZS_ALLOW_FAKE=1 + ZS_REAL_DISPATCH_GUARD=1；夹具用
 *   FakeRuntimeAdapter 预置数据，本脚本只读页面、不提交任何消息。
 * - 用 Electron 加载本机 dist/ui（开发形态），ZS_APP_DATA 指向临时目录，
 *   ZS_DAEMON_ENTRY=dist/pack/daemon.cjs。
 * - 覆盖：欢迎页/成员页/AI 设置弹窗/成员详情/设置页 general·data·help/项目设置/房间/
 *   线程 task·delivery/任务看板/文件/Git/待我处理/搜索/收藏/活动/归档。
 * - 每个场景：截图 <run>/NN-<scene>.png + result.json（hash、可见文本、错误横幅/装载中/
 *   对话框检测、关键元素、禁止词命中位置）。
 *
 * 用法：
 *   node scripts/capture-r149-ui.cjs                 # 全量
 *   node scripts/capture-r149-ui.cjs --only=welcome,members
 *   node scripts/capture-r149-ui.cjs --run=after-fix  # 指定 run 目录名（便于对照）
 * 退出码：0=全部通过；1=有场景失败或命中禁止词；2=缺少 dist/ui 构建。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const startedAt = Date.now();
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg == null
  ? []
  : onlyArg.slice(7).split(',').map((item) => item.trim()).filter(Boolean);
const runArg = process.argv.find((arg) => arg.startsWith('--run='));
const runName = runArg == null
  ? 'run-' + new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + randomUUID().slice(0, 8)
  : runArg.slice(6).replace(/[^A-Za-z0-9._-]/g, '');
if (runName === '') {
  console.error('--run= 名称不能为空（只允许字母/数字/._-）');
  process.exit(2);
}
const run = path.join(root, 'dist', 'r149-ui', runName);
const data = path.join(run, 'data');
const project = path.join(run, '工作区', '读书会筹备');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(path.dirname(project), { recursive: true });

const mainCjs = path.join(root, 'dist', 'ui', 'main.cjs');
if (!fs.existsSync(mainCjs)) {
  console.error('缺少 dist/ui/main.cjs：请先构建界面（pnpm build:ui）。');
  process.exit(2);
}

/* 与 capture-homepage-shots.cjs 相同的隔离约定：清掉调用方所有 ZS_*，再显式给本 run 的值。 */
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ZS_APP_DATA: data,
  ZS_RUNTIME: 'fake',
  ZS_ALLOW_FAKE: '1',
  ZS_REAL_DISPATCH_GUARD: '1',
  ZS_PIPE_NAME: '\\\\.\\pipe\\zs-r149-' + randomUUID(),
  ZS_DAEMON_ENTRY: path.join(root, 'dist', 'pack', 'daemon.cjs'),
  ZS_PACKAGED_UI: '1',
  ZS_NODE_BIN: process.execPath,
});

const relPath = (target) => path.relative(root, target).split(path.sep).join('/');
const fileInfo = (target) => {
  try {
    const stat = fs.statSync(target);
    return { path: relPath(target), exists: true, bytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return { path: relPath(target), exists: false, bytes: null, mtime: null };
  }
};

/* ============================================================
   一、场景脚本（只在隔离截图窗口内执行；不修改页面数据）
   ============================================================ */
const sceneSource = String.raw`(() => {
  const m = window.r149Meta;
  if (m == null) throw Error('缺少隔离夹具元数据（guide-fixture.json）');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check, label, timeout) => {
    const end = Date.now() + (timeout || 15000);
    while (Date.now() < end) {
      let ok = false;
      try { ok = !!check(); } catch { ok = false; }
      if (ok) return;
      await wait(80);
    }
    throw Error('等待超时：' + (label || '界面未就绪'));
  };
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => Array.from(document.querySelectorAll(selector));
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const shown = (el) => {
    if (el == null) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  };
  const has = (text) => (document.body.innerText || '').includes(text);
  const textOf = (el) => (el == null ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim());
  const go = async (route) => { window.location.hash = '#' + route; await wait(450); };
  const roomRoute = () => '/project/' + m.projectId + '/room/' + m.roomId;
  const threadRoute = (threadId, tab) => roomRoute() + '?thread=' + threadId + (tab ? '&tab=' + tab : '');
  const setInput = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const findButton = (label, scope) => Array.from((scope || document).querySelectorAll('button, [role="tab"], [role="button"], a'))
    .find((el) => textOf(el) === label);
  const dismissToast = () => {
    const toast = q('.toast-host .toast');
    if (toast != null) toast.click();
  };
  const closeDialogs = async () => {
    for (const dialog of qa('[role="dialog"]').filter(shown)) {
      const close = dialog.querySelector('[aria-label="关闭"]') || dialog.querySelector('.overlay-head .icon-btn');
      if (close != null) close.click();
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(160);
  };
  const resetScroll = () => {
    window.scrollTo(0, 0);
    qa('*').forEach((el) => {
      if (el.scrollTop) el.scrollTop = 0;
      if (el.scrollLeft) el.scrollLeft = 0;
    });
  };

  const ERROR_PATTERNS = [
    '读取失败：', '装载失败：', '看板读取失败：', '活动流读取失败：', '归档读取失败：',
    '搜索失败：', '收藏读取失败：', '成员装载失败：', '任务概况读取失败：', '打开回复串失败：',
    '界面渲染失败', '命令失败：', '操作失败：', 'FORBIDDEN', 'EPERM', 'ENOENT',
  ];
  const LOADING_PATTERNS = [
    '正在读取看板…', '正在读取本项目任务概况…', '正在打开项目…', '正在打开所属项目…',
    '正在定位线程', '正在读取成员', '正在装载…', '（装载中…）', '正在检索…', '正在读取收藏…',
  ];

  const logoInfo = () => {
    const img = q('[data-zs-welcome-logo]') || q('[data-zs-welcome] img');
    const legacy = q('[data-zs-welcome] .brand-mark');
    const favicon = q('link[rel="icon"]');
    return {
      found: img != null,
      tag: img == null ? null : img.tagName,
      src: img == null ? null : img.getAttribute('src'),
      alt: img == null ? null : img.getAttribute('alt'),
      complete: img == null ? null : img.complete === true,
      naturalWidth: img == null ? null : img.naturalWidth,
      naturalHeight: img == null ? null : img.naturalHeight,
      shown: img == null ? false : shown(img),
      rect: img == null ? null : rect(img),
      legacyBrandText: legacy == null ? null : textOf(legacy),
      legacyBrandShown: legacy == null ? false : shown(legacy),
      faviconHref: favicon == null ? null : favicon.getAttribute('href'),
    };
  };

  const settle = async () => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const text = document.body.innerText || '';
      if (!LOADING_PATTERNS.some((pattern) => text.includes(pattern))) return;
      await wait(120);
    }
  };

  const collect = (scene) => {
    const visibleText = (document.body.innerText || '').replace(/\r\n/g, '\n');
    const errorHits = ERROR_PATTERNS.filter((pattern) => visibleText.includes(pattern));
    const loadingHits = LOADING_PATTERNS.filter((pattern) => visibleText.includes(pattern));
    const dialogs = qa('[role="dialog"], .overlay').filter(shown).map((el) => ({
      tag: el.tagName,
      cls: String(el.className || ''),
      rect: rect(el),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    }));
    const required = [];
    for (const [label, selector] of (scene.require == null ? [] : scene.require.selectors || [])) {
      const el = q(selector);
      required.push({ kind: 'selector', label, target: selector, found: el != null, visible: el != null && shown(el) });
    }
    for (const [label, text] of (scene.require == null ? [] : scene.require.texts || [])) {
      required.push({ kind: 'text', label, target: text, found: visibleText.includes(text) });
    }
    const missing = required.filter((item) => !item.found || (item.kind === 'selector' && !item.visible))
      .map((item) => item.kind + ':' + item.target);
    const app = q('.app');
    const main = qa('.main').find(shown) || qa('.app-body').find(shown) || app || q('#hifi-root');
    const layout = {
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      app: app == null ? null : rect(app),
      main: main == null ? null : rect(main),
      mainTextLength: main == null ? 0 : (main.innerText || '').length,
    };
    return {
      name: scene.name,
      allowDialog: scene.allowDialog === true,
      hash: window.location.hash,
      visibleText: visibleText.length > 60000 ? visibleText.slice(0, 60000) : visibleText,
      visibleTextLength: visibleText.length,
      visibleTextTruncated: visibleText.length > 60000,
      errors: errorHits,
      loading: loadingHits,
      dialogs,
      required,
      missing,
      layout,
      hifiOn: document.body.classList.contains('hifi-on'),
      legacyOn: document.body.classList.contains('legacy-on'),
      hifiFailed: window.__zsHifiFailed === true,
      bodyClass: document.body.className,
      hifiRootTextSnippet: (q('#hifi-root') == null ? '' : (q('#hifi-root').textContent || '')).replace(/\s+/g, ' ').trim().slice(0, 3000),
      extra: scene.extra == null ? null : scene.extra,
    };
  };

  const scenes = [
    { name: 'welcome', run: async (scene) => {
      await go('/welcome');
      await until(() => q('[data-zs-welcome]'), '欢迎页根节点', 25000);
      await until(() => has('最近项目'), '最近项目分区');
      await until(() => has('读书会筹备'), '最近项目卡片', 20000);
      await wait(500);
      // 新 logo 是随包资源：等图片解码完成再断言 naturalWidth（限时，避免旧构建长时间空等）。
      const logoImage = q('[data-zs-welcome-logo]') || q('[data-zs-welcome] img');
      if (logoImage != null) {
        const logoDeadline = Date.now() + 8000;
        while (Date.now() < logoDeadline && !(logoImage.complete === true && logoImage.naturalWidth > 0)) await wait(100);
      }
      scene.extra = { logo: logoInfo(), recentProjectCards: qa('[data-zs-welcome] .card').length };
    }, require: {
      selectors: [['欢迎页根节点', '[data-zs-welcome]']],
      texts: [['最近项目', '最近项目'], ['项目卡片', '读书会筹备'], ['打开文件夹', '打开文件夹']],
    } },
    { name: 'members', run: async (scene) => {
      await go('/project/' + m.projectId + '/members');
      await until(() => q('[data-zs-members]'), '成员页根节点');
      await until(() => qa('[data-zs-member-card]').length >= 2, '成员卡', 20000);
      await until(() => has('添加 AI'), '添加 AI 入口');
      await wait(700);
      scene.extra = {
        memberCards: qa('[data-zs-member-card]').length,
        bindButtons: qa('[data-zs-member-bind]').length,
        advancedBlocks: qa('[data-zs-member-advanced]').length,
        templateButtons: qa('[data-zs-member-template]').length,
      };
    }, require: {
      selectors: [['成员页根节点', '[data-zs-members]'], ['成员卡', '[data-zs-member-card]'], ['AI 设置按钮', '[data-zs-member-bind]']],
      texts: [['添加 AI', '添加 AI'], ['成员 Claude', 'Claude'], ['成员 Codex', 'Codex']],
    } },
    { name: 'member-ai-settings', allowDialog: true, run: async (scene) => {
      await go('/project/' + m.projectId + '/members');
      await until(() => q('[data-zs-member-bind]'), '成员 AI 设置按钮', 20000);
      q('[data-zs-member-bind]').click();
      await until(() => qa('[role="dialog"]').some(shown), 'AI 设置弹窗', 20000);
      await until(() => has('AI 设置'), 'AI 设置标题', 20000);
      await wait(1200);
      const dialog = qa('[role="dialog"]').filter(shown)[0];
      scene.extra = {
        dialogText: dialog == null ? '' : (dialog.innerText || ''),
        dialogRect: dialog == null ? null : rect(dialog),
        dialogTitle: textOf(q('.overlay-title')),
        saveButton: findButton('保存 AI 设置', dialog) != null,
      };
    }, require: {
      selectors: [['AI 设置弹窗', '[role="dialog"]']],
      texts: [['AI 设置标题', 'AI 设置']],
    } },
    { name: 'member-ai-settings-advanced', allowDialog: true, run: async (scene) => {
      await go('/project/' + m.projectId + '/members');
      await until(() => q('[data-zs-member-bind]'), '成员 AI 设置按钮', 20000);
      q('[data-zs-member-bind]').click();
      await until(() => qa('[role="dialog"]').some(shown), 'AI 设置弹窗', 20000);
      await until(() => has('AI 设置'), 'AI 设置标题', 20000);
      await wait(900);
      const dialog = qa('[role="dialog"]').filter(shown)[0];
      const fold = Array.from(dialog.querySelectorAll('details'))
        .find((el) => textOf(el.querySelector('summary')).includes('高级'));
      if (fold == null) throw Error('AI 设置弹窗缺少「高级」折叠区');
      if (!fold.open) fold.querySelector('summary').click();
      await wait(500);
      scene.extra = {
        dialogText: dialog.innerText || '',
        dialogRect: rect(dialog),
        advancedSummary: textOf(fold.querySelector('summary')),
        advancedOpen: fold.open === true,
      };
    }, require: {
      selectors: [['AI 设置弹窗', '[role="dialog"]']],
      texts: [['AI 设置标题', 'AI 设置']],
    } },
    { name: 'member-detail', run: async () => {
      await go('/project/' + m.projectId + '/member/' + m.claude);
      await until(() => q('[data-zs-member-detail]'), '成员详情根节点', 20000);
      await until(() => has('Claude'), '成员名');
      await until(() => has('AI 设置'), '成员详情 AI 设置入口');
      await wait(600);
    }, require: {
      selectors: [['成员详情根节点', '[data-zs-member-detail]']],
      texts: [['成员名', 'Claude'], ['AI 设置入口', 'AI 设置']],
    } },
    { name: 'settings-general', run: async () => {
      await go('/settings?section=general');
      await until(() => q('.settings-body'), '设置主体', 20000);
      await until(() => has('通用'), '通用分区');
      await until(() => has('启动时打开的项目'), '启动设置项');
      await wait(600);
    }, require: {
      selectors: [['设置分区导航', '.settings-nav'], ['设置主体', '.settings-body']],
      texts: [['通用分区', '通用'], ['启动设置项', '启动时打开的项目']],
    } },
    { name: 'settings-data', run: async () => {
      await go('/settings?section=data');
      await until(() => q('[data-zs-data-guide]'), '数据分区', 20000);
      await until(() => has('数据与存储'), '数据与存储标题');
      await wait(700);
    }, require: {
      selectors: [['数据分区卡片', '[data-zs-data-guide]'], ['备份按钮', '[data-zs-data-backup]'], ['导入按钮', '[data-zs-data-import]']],
      texts: [['数据与存储标题', '数据与存储'], ['当前数据位置', '当前数据位置']],
    } },
    { name: 'settings-help', run: async (scene) => {
      await go('/settings?section=help');
      await until(() => q('.settings-body'), '帮助分区', 20000);
      await until(() => has('帮助与关于'), '帮助与关于标题');
      await wait(800);
      scene.extra = {
        openDetails: qa('.settings-body details[open]').map((el) => textOf(el.querySelector('summary'))),
        detailFolds: qa('.settings-body details').length,
        localDiagnostics: qa('[data-zs-local-diagnostics]').length,
      };
    }, require: {
      selectors: [['设置主体', '.settings-body']],
      texts: [['帮助与关于标题', '帮助与关于']],
    } },
    { name: 'project-settings', run: async () => {
      await go('/project/' + m.projectId + '/settings');
      await until(() => q('.page-head'), '项目设置页头', 25000);
      await until(() => has('项目设置'), '项目设置标题');
      await until(() => has('项目信息'), '项目信息区');
      await wait(700);
    }, require: {
      selectors: [['项目设置页头', '.page-head']],
      texts: [['项目设置标题', '项目设置'], ['项目信息区', '项目信息']],
    } },
    { name: 'room', run: async () => {
      await go(roomRoute());
      await until(() => q('.root-card') && q('.composer-editor'), '房间根视图', 25000);
      await until(() => has('活动筹备'), '房间标题');
      await wait(800);
    }, require: {
      selectors: [['房间根视图', '.root-card'], ['输入区', '.composer-editor'], ['输入框容器', '.composer']],
      texts: [['房间标题', '活动筹备']],
    } },
    { name: 'thread-task', run: async (scene) => {
      await go(threadRoute(m.work.threadId, 'task'));
      await until(() => q('.thread-details'), '线程详情面板', 25000);
      await until(() => q('.details-subnav'), '详情分组导航', 20000);
      await until(() => has('任务概况') && has('交付与验收'), '任务/交付分组');
      await until(() => !has('正在打开项目…') && !has('正在打开所属项目…'), '项目对齐完成');
      await wait(900);
      scene.extra = { activeGroup: textOf(q('.details-subnav [aria-selected="true"]')), panelTextLength: (q('.thread-details') == null ? 0 : (q('.thread-details').innerText || '').length) };
    }, require: {
      selectors: [['线程详情面板', '.thread-details'], ['详情分组导航', '.details-subnav']],
      texts: [['任务概况分组', '任务概况'], ['交付与验收分组', '交付与验收']],
    } },
    { name: 'thread-delivery', run: async (scene) => {
      await go(threadRoute(m.work.threadId, 'delivery'));
      await until(() => q('.thread-details'), '线程详情面板', 25000);
      await until(() => q('.details-subnav'), '详情分组导航', 20000);
      await until(() => has('交付与验收'), '交付与验收分组', 20000);
      await until(() => {
        const active = q('.details-subnav [aria-selected="true"]');
        return active != null && textOf(active).includes('交付与验收');
      }, '交付分组选中', 20000);
      await wait(900);
      scene.extra = { activeGroup: textOf(q('.details-subnav [aria-selected="true"]')), panelTextLength: (q('.thread-details') == null ? 0 : (q('.thread-details').innerText || '').length) };
    }, require: {
      selectors: [['线程详情面板', '.thread-details'], ['详情分组导航', '.details-subnav']],
      texts: [['交付与验收分组', '交付与验收']],
    } },
    { name: 'board', run: async (scene) => {
      await go('/board');
      await until(() => q('.page-filters'), '看板筛选条', 25000);
      await until(() => qa('[data-zs-task-id]').length > 0, '看板任务卡', 20000);
      await wait(800);
      scene.extra = { taskCards: qa('[data-zs-task-id]').length };
    }, require: {
      selectors: [['看板筛选条', '.page-filters']],
      texts: [['刷新按钮', '刷新']],
    } },
    { name: 'files', run: async () => {
      await go('/project/' + m.projectId + '/files');
      await until(() => q('.fg-page'), '文件页根节点', 25000);
      await until(() => q('.fg-body'), '文件双栏');
      await until(() => has('活动安排.md') || has('活动资料.md'), '项目文件条目', 20000);
      await wait(900);
    }, require: {
      selectors: [['文件页根节点', '.fg-page'], ['文件双栏', '.fg-body']],
      texts: [['文件页签', '文件'], ['Git 页签', 'Git'], ['项目文件条目', '活动安排.md']],
    } },
    { name: 'files-git', run: async () => {
      await go('/project/' + m.projectId + '/files?tab=git');
      await until(() => q('.fg-page') && q('.git-layout'), 'Git 页', 25000);
      await until(() => has('工作区'), 'Git 工作区标签');
      await wait(900);
    }, require: {
      selectors: [['Git 布局', '.git-layout']],
      texts: [['Git 页签', 'Git'], ['工作区标签', '工作区'], ['历史标签', '历史']],
    } },
    { name: 'pending', run: async (scene) => {
      await go('/pending');
      await until(() => q('[data-zs-pending]'), '待我处理根节点', 25000);
      await until(() => q('[data-zs-pending-scope]'), '待我处理范围筛选');
      await wait(800);
      scene.extra = { hasReviewTask: has('待验收'), hasEmptyState: has('没有需要你处理的事情') };
    }, require: {
      selectors: [['待我处理根节点', '[data-zs-pending]'], ['范围筛选', '[data-zs-pending-scope]']],
      texts: [['全部可访问项目', '全部可访问项目']],
    } },
    { name: 'library', run: async (scene) => {
      await go('/library');
      await until(() => q('[data-zs-library]'), '搜索与收藏根节点', 25000);
      await until(() => q('[data-zs-library] .page-filters input'), '搜索输入框', 20000);
      setInput(q('[data-zs-library] .page-filters input'), '读书会');
      await wait(250);
      const search = findButton('检索');
      if (search == null) throw Error('缺少「检索」按钮');
      search.click();
      await until(() => has('回原处') || has('本页没有命中'), '搜索结果', 20000);
      await wait(600);
      scene.extra = { searchResults: qa('[data-zs-library] .card').length, query: '读书会' };
    }, require: {
      selectors: [['搜索与收藏根节点', '[data-zs-library]']],
      texts: [['搜索页签', '搜索'], ['收藏页签', '收藏'], ['检索按钮', '检索']],
    } },
    { name: 'library-saved', run: async (scene) => {
      await go('/library');
      await until(() => q('[data-zs-library]'), '搜索与收藏根节点', 25000);
      const savedTab = findButton('收藏');
      if (savedTab == null) throw Error('缺少「收藏」页签');
      savedTab.click();
      await until(() => has('还没有收藏') || has('取消收藏') || has('收藏总计'), '收藏页内容', 20000);
      await wait(700);
      scene.extra = { emptyState: has('还没有收藏'), savedCountText: has('收藏总计') };
    }, require: {
      selectors: [['搜索与收藏根节点', '[data-zs-library]']],
      texts: [['收藏页签', '收藏']],
    } },
    { name: 'activity', run: async (scene) => {
      await go('/activity');
      await until(() => q('[data-zs-activity]'), '活动根节点', 25000);
      await until(() => qa('[data-zs-activity-item]').length > 0 || has('当前范围内还没有活动事件'), '活动内容', 20000);
      await wait(800);
      scene.extra = { items: qa('[data-zs-activity-item]').length };
    }, require: {
      selectors: [['活动根节点', '[data-zs-activity]']],
      texts: [['刷新按钮', '刷新']],
    } },
    { name: 'archive', run: async (scene) => {
      await go('/archive');
      await until(() => q('.archive-filters'), '归档筛选条', 25000);
      await until(() => has('没有归档内容') || has('已读取') || q('[data-archive-project]') != null, '归档读取完成', 20000);
      await wait(700);
      scene.extra = { hasArchivedContent: qa('[data-archive-project]').length > 0 };
    }, require: {
      selectors: [['归档筛选条', '.archive-filters']],
      texts: [['刷新归档按钮', '刷新归档']],
    } },
  ];

  window.r149Scenes = scenes;
  window.r149Shot = async (index) => {
    const scene = scenes[index];
    scene.extra = null;
    let runError = null;
    try { await scene.run(scene); } catch (error) { runError = String((error && error.message) || error); }
    await settle();
    dismissToast();
    await wait(150);
    const step = collect(scene);
    step.error = runError;
    return step;
  };
  window.r149PrepareShot = async () => {
    dismissToast();
    resetScroll();
    if (document.fonts != null && document.fonts.ready != null) {
      await Promise.race([document.fonts.ready, wait(1500)]);
    }
    await wait(250);
  };
  window.r149Cleanup = async () => {
    await closeDialogs();
    dismissToast();
    resetScroll();
    await wait(120);
  };
})();`;
const scenesPath = path.join(run, 'r149-scenes.js');
fs.writeFileSync(scenesPath, sceneSource);

/* ============================================================
   二、Electron 包装器（隐藏窗口；逐场景截图；写原始 capture-result.json）
   ============================================================ */
const wrapperSource = String.raw`const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAIN = __MAIN__;
const SCENES = __SCENES__;
const OUT = __OUT__;
const RESULT = __RESULT__;
const ONLY = __ONLY__;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rendererConsole = [];
async function capture(win) {
  const results = [];
  const failures = [];
  let names = [];
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const metaJson = fs.readFileSync(path.join(process.env.ZS_APP_DATA, 'guide-fixture.json'), 'utf8');
  const scenesJs = fs.readFileSync(SCENES, 'utf8');
  const injectScenes = async () => {
    await js('window.r149Meta = ' + metaJson);
    await js(scenesJs);
  };
  try {
    win.setContentSize(1360, 920);
    for (let i = 0; i < 120; i++) {
      const ready = await js('document.readyState === "complete" && document.body.innerText.length > 40');
      if (ready) break;
      await delay(250);
    }
    await delay(800);
    for (let i = 0; i < 8; i++) {
      const size = await js('({ w: window.innerWidth, h: window.innerHeight })');
      if (size.w === 1360 && size.h === 920) break;
      win.setContentSize(1360 + (1360 - size.w), 920 + (920 - size.h));
      await delay(120);
    }
    let hifi = false;
    for (let i = 0; i < 120; i++) {
      try { hifi = await js('document.body.classList.contains("hifi-on")'); } catch { hifi = false; }
      if (hifi) break;
      await delay(250);
    }
    console.log('R149_HIFI_READY ' + String(hifi));
    await injectScenes();
    names = await js('window.r149Scenes.map(function (scene) { return scene.name; })');
    const total = names.length;
    for (let i = 0; i < total; i++) {
      if (ONLY.length && ONLY.indexOf(names[i]) < 0) continue;
      const sceneStarted = Date.now();
      let step = null;
      let failure = null;
      try {
        step = await js('window.r149Shot(' + i + ')');
      } catch (error) {
        failure = String((error && error.message) || error);
      }
      try {
        await js('window.r149PrepareShot ? window.r149PrepareShot() : true');
      } catch { /* 页面可能在重载中；截图仍保留当前状态 */ }
      win.setContentSize(1361, 920);
      await delay(50);
      win.setContentSize(1360, 920);
      await delay(150);
      for (let attempt = 0; attempt < 5; attempt++) {
        const size = await js('({ w: window.innerWidth, h: window.innerHeight })');
        if (size.w === 1360 && size.h === 920) break;
        win.setContentSize(1360 + (1360 - size.w), 920 + (920 - size.h));
        await delay(120);
      }
      try {
        await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      } catch { /* 保留当前绘制 */ }
      const fileName = (i + 1 < 10 ? '0' : '') + (i + 1) + '-' + names[i] + '.png';
      let imageSize = null;
      try {
        const image = await win.webContents.capturePage();
        imageSize = image.getSize();
        fs.writeFileSync(path.join(OUT, fileName), image.toPNG());
      } catch (error) {
        failure = (failure == null ? '' : failure + '；') + '截图失败：' + String((error && error.message) || error);
      }
      if (step == null) {
        step = {
          name: names[i], allowDialog: false, hash: null, visibleText: '', visibleTextLength: 0,
          visibleTextTruncated: false, errors: [], loading: [], dialogs: [], required: [], missing: [],
          layout: null, hifiOn: null, legacyOn: null, hifiFailed: null, extra: null,
        };
      }
      step.screenshot = fileName;
      step.image = imageSize;
      step.durationMs = Date.now() - sceneStarted;
      if (failure != null) {
        step.error = (step.error == null ? '' : step.error + '；') + failure;
      }
      results.push(step);
      console.log('R149_SHOT ' + names[i] + ' ' + (imageSize == null ? 'no-image' : imageSize.width + 'x' + imageSize.height) + (step.error ? ' ERROR=' + step.error : ''));
      // 每场景落盘：即使后续意外中止，已完成场景的截图/文本/错误仍可核查。
      fs.writeFileSync(RESULT, JSON.stringify({ ok: true, partial: true, names, results, failures, rendererConsole }, null, 2));
      // 旧界面回退/渲染失败后重载并重新注入场景脚本，避免一个坏页面污染后面所有场景。
      let fellBack = false;
      try { fellBack = await js('document.body.classList.contains("legacy-on") || window.__zsHifiFailed === true'); } catch { fellBack = false; }
      try {
        await js('window.r149Cleanup ? window.r149Cleanup() : true');
      } catch { /* 下一场景导航会重置页面 */ }
      if (fellBack) {
        console.log('R149_RECOVER ' + names[i] + ' renderer fell back to legacy UI; reloading');
        try { await js('window.location.reload()'); } catch { /* 文档上下文被重载替换 */ }
        await delay(1500);
        for (let k = 0; k < 80; k++) {
          let ok = false;
          try { ok = await js('document.body.classList.contains("hifi-on") && document.body.innerText.length > 40'); } catch { ok = false; }
          if (ok) break;
          await delay(300);
        }
        await delay(600);
        try { await injectScenes(); } catch (error) { console.error('R149_REINJECT_FAIL ' + String((error && error.message) || error)); }
      }
      await delay(120);
    }
    const inner = await js('({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })');
    fs.writeFileSync(RESULT, JSON.stringify({ ok: true, names, results, failures, rendererConsole, inner }, null, 2));
  } catch (error) {
    console.error('R149_CAPTURE_FAIL ' + String((error && error.stack) || error));
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'capture-error.png'), image.toPNG());
    } catch { /* 保留原始错误 */ }
    fs.writeFileSync(RESULT, JSON.stringify({ ok: false, partial: true, error: String((error && error.stack) || error), names, results, failures, rendererConsole }, null, 2));
  }
  win.close();
}
app.on('browser-window-created', (_event, win) => {
  win.show = () => {};
  try {
    win.webContents.on('console-message', (...args) => {
      try {
        let level = '';
        let message = '';
        let source = '';
        let line = 0;
        if (args.length >= 5) {
          level = args[1];
          message = args[2];
          line = args[3];
          source = args[4];
        } else if (args[1] != null && typeof args[1] === 'object') {
          level = args[1].level;
          message = args[1].message;
          line = args[1].lineNumber;
          source = args[1].sourceId;
        }
        const text = message == null ? '' : String(message);
        if (text === '') return;
        const levelText = String(level);
        if (levelText === 'error' || levelText === 'warning' || levelText === '3' || levelText === '2' || /渲染错误|Uncaught|ReferenceError|TypeError/.test(text)) {
          if (rendererConsole.length < 80) rendererConsole.push({ level: levelText, message: text.slice(0, 1200), source: String(source || ''), line });
        }
      } catch { /* console-message 事件签名随 Electron 版本变化，忽略解析失败 */ }
    });
  } catch { /* 旧 Electron 无该事件；忽略 */ }
  win.webContents.once('did-finish-load', () => { void capture(win); });
});
require(MAIN);
setTimeout(() => {
  for (const win of BrowserWindow.getAllWindows()) win.close();
}, 540000);`;
const wrapperPath = path.join(run, 'main.cjs');
fs.writeFileSync(wrapperPath, wrapperSource
  .replace('__MAIN__', JSON.stringify(mainCjs))
  .replace('__SCENES__', JSON.stringify(scenesPath))
  .replace('__OUT__', JSON.stringify(run))
  .replace('__RESULT__', JSON.stringify(path.join(run, 'capture-result.json')))
  .replace('__ONLY__', JSON.stringify(only)));

/* ============================================================
   三、禁止词（用户截图原句 + rubric 工程术语）
   hard 命中即失败；soft 只作提示（宽泛词可能有合法用法，交 Lead 判断）
   ============================================================ */
const HARD_RULES = [
  { term: '选择本机已有渠道和模型', reason: 'AI 设置副标题（用户截图原句）' },
  { term: '保存后用于之后的工作', reason: 'AI 设置副标题（用户截图原句）' },
  { term: '保存后显示 AI 的可用状态', reason: 'AI 设置页脚（用户截图原句）' },
  { term: '正式 app-server', reason: '模型来源说明（用户截图原句）' },
  { term: 'app-server', reason: '模型来源说明（工程术语）' },
  { term: 'model/list', reason: '模型来源说明（工程术语）' },
  { term: '完整权限沿用 CLI', reason: '权限模式说明（用户截图原句）' },
  { term: '工作量更新于', reason: '成员页工作量说明（用户截图原句）' },
  { term: '分开统计', reason: '成员页工作量统计说明（用户截图原句）' },
  { term: '高级状态', reason: '成员卡诊断块（用户截图原句）' },
  { term: '从选定成员的', reason: '模板说明（用户截图原句）' },
  { term: '成员参与派发的实际边界', reason: '房间名单说明（用户截图原句）' },
  { term: '项目编辑档', reason: '成员卡诊断块（用户截图原句）' },
  { term: '交付校验值', reason: '交付校验说明（用户截图/rubric）' },
  { term: 'manifestHash', reason: '契约字段名（rubric）', ci: true },
  { term: '保留上次事实', reason: '装载/恢复说明（用户截图原句）' },
  { term: '数据根身份', reason: '设置诊断（rubric）' },
  { term: '数据根', reason: '内部术语（rubric）' },
  { term: '快照', reason: '内部术语（rubric）' },
  { term: '首批', reason: '内部术语（rubric）' },
  { term: '按页显示', reason: '分页口径（rubric）' },
  { term: '分离统计', reason: '统计口径（rubric）' },
  { term: '统计口径', reason: '统计口径（rubric）' },
  { term: '口径', reason: '工程术语（rubric）' },
  { term: '边界', reason: '工程术语（rubric）' },
  { term: '工程', reason: '工程术语（rubric）' },
  { term: '历史证据', reason: '证据术语（rubric）' },
  { term: '识图证书', reason: '证据术语（rubric）' },
  { term: '取证', reason: '证据术语（rubric）' },
  { term: '配置成功≠能力已认证', reason: '实现口径（rubric）' },
  { term: '保存配置不等于渠道已实测', reason: '实现口径（rubric）' },
  { term: '当前为验收防护环境', reason: '实现口径（rubric）' },
  { term: '按当前模型声明提供等级', reason: '实现口径（rubric）' },
  { term: '只读聚合', reason: '内部实现说明（rubric）' },
  { term: 'domain_events', reason: '内部表名（rubric）', ci: true },
  { term: 'member.setRuntime', reason: '命令名（rubric）' },
  { term: '校验值', reason: '校验术语（rubric）' },
  { term: '协议：', reason: '内部术语（用户截图原句）' },
  { term: '依据：', reason: '内部术语（用户截图原句）' },
  { term: 'DEV-', reason: '内部编号（rubric）' },
  { term: '§', reason: '内部章节标记（rubric）' },
];
const SOFT_RULES = [
  { term: '协议', reason: '宽泛词：日常主面不应出现；仅允许出现在明确折叠的诊断区' },
  { term: '依据', reason: '宽泛词：日常主面不应出现；仅允许出现在明确折叠的诊断区' },
  { term: '证据', reason: '宽泛词：日常主面不应出现；仅允许出现在明确折叠的诊断区' },
  { term: '认证', reason: '能力/认证免责说明（rubric 宽泛词）' },
  { term: '读活动≠执行动作', reason: '工程口径标语（rubric）' },
  { term: '验收防护', reason: '实现口径（rubric）' },
  { term: '能力已认证', reason: '实现口径（rubric）' },
  { term: '无真实 CLI', reason: '思考等级来源说明（rubric）' },
  { term: '三重身份', reason: '交付身份工程术语（rubric）' },
  { term: '改动集身份', reason: '交付身份工程术语（rubric）' },
  { term: '技术身份', reason: '交付身份工程术语（rubric）' },
  { term: '权限制', reason: '权限工程术语（rubric）' },
  { term: '预占', reason: '调用预算工程术语（rubric）' },
  { term: '结算', reason: '调用预算工程术语（rubric）' },
  { term: '租约', reason: '工程术语（宽泛）' },
  { term: '幂等', reason: '工程术语（宽泛）' },
  { pattern: /\b[a-z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+\b/, reason: '疑似内部标识（如 changeset.finalized）——宽泛提示' },
  { pattern: /\b(?:ACTIVE|DONE|REVIEW|BLOCKED|CANCELLED|QUEUED|RUNNING|WAITING_USER|WAITING_APPROVAL|INTERRUPTED|SUCCEEDED|FAILED|PENDING|UNKNOWN)\b/, reason: '疑似原始状态枚举——宽泛提示' },
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ruleLabel = (rule) => (rule.term == null ? String(rule.pattern) : rule.term);
const ruleRegex = (rule) => {
  if (rule.pattern != null) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    return new RegExp(rule.pattern.source, flags);
  }
  return new RegExp(escapeRegExp(rule.term), rule.ci ? 'gi' : 'g');
};
const scanText = (text, rules) => {
  const hits = [];
  for (const rule of rules) {
    const re = ruleRegex(rule);
    const contexts = [];
    let count = 0;
    let match = re.exec(text);
    while (match != null) {
      count += 1;
      if (contexts.length < 3) {
        const start = Math.max(0, match.index - 30);
        const end = Math.min(text.length, match.index + match[0].length + 30);
        const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
        if (!contexts.includes(snippet)) contexts.push(snippet);
      }
      match = re.exec(text);
    }
    if (count > 0) hits.push({ term: ruleLabel(rule), reason: rule.reason, count, contexts });
  }
  return hits;
};
const mergeHit = (map, hit, location) => {
  const existing = map.get(hit.term);
  if (existing == null) {
    map.set(hit.term, { term: hit.term, reason: hit.reason, count: hit.count, locations: [location], contexts: hit.contexts.slice() });
    return;
  }
  existing.count += hit.count;
  if (!existing.locations.includes(location)) existing.locations.push(location);
  for (const context of hit.contexts) {
    if (!existing.contexts.includes(context) && existing.contexts.length < 3) existing.contexts.push(context);
  }
};

/* ============================================================
   四、场景判定（关键元素/错误/装载中/遮挡/logo）
   ============================================================ */
const logoChecks = (step) => {
  const logo = step.extra == null ? null : step.extra.logo;
  const checks = [];
  if (logo == null) {
    checks.push({ id: 'logo-present', ok: false, detail: '欢迎页未找到 logo 元素' });
    return checks;
  }
  checks.push({ id: 'logo-present', ok: logo.found === true && logo.tag === 'IMG', detail: JSON.stringify({ tag: logo.tag, src: logo.src }) });
  checks.push({ id: 'logo-alt', ok: logo.alt === '众说', detail: String(logo.alt) });
  checks.push({
    id: 'logo-loaded',
    ok: Number(logo.naturalWidth) > 0 && Number(logo.naturalHeight) > 0,
    detail: Number(logo.naturalWidth) + 'x' + Number(logo.naturalHeight),
  });
  checks.push({ id: 'logo-src', ok: typeof logo.src === 'string' && /assets\/logo\.png\b/.test(logo.src), detail: String(logo.src) });
  checks.push({ id: 'logo-visible', ok: logo.shown === true && logo.rect != null && logo.rect.width > 0 && logo.rect.height > 0, detail: JSON.stringify(logo.rect) });
  checks.push({ id: 'legacy-brand-gone', ok: logo.legacyBrandShown !== true, detail: logo.legacyBrandShown === true ? '旧「众」方块仍可见：' + String(logo.legacyBrandText) : '未出现旧「众」方块' });
  checks.push({ id: 'favicon', ok: typeof logo.faviconHref === 'string' && /assets\/logo\.png\b/.test(logo.faviconHref), detail: String(logo.faviconHref) });
  return checks;
};

const evaluateScene = (step, index) => {
  const problems = [];
  if (step.error != null) problems.push('场景异常：' + step.error);
  if (Array.isArray(step.missing) && step.missing.length > 0) problems.push('缺少关键元素：' + step.missing.join(', '));
  if (Array.isArray(step.errors) && step.errors.length > 0) problems.push('错误横幅：' + step.errors.join(', '));
  if (Array.isArray(step.loading) && step.loading.length > 0) problems.push('仍显示装载中：' + step.loading.join(', '));
  if (step.allowDialog === true) {
    if (!Array.isArray(step.dialogs) || step.dialogs.length === 0) problems.push('AI 设置弹窗未出现');
  } else if (Array.isArray(step.dialogs) && step.dialogs.length > 0) {
    problems.push('有对话框遮挡：' + step.dialogs.length);
  }
  if (step.hifiOn !== true) problems.push('hifi 外壳未启用（可能回退旧界面）');
  if (step.legacyOn === true || step.hifiFailed === true) {
    const snippet = step.hifiRootTextSnippet == null || step.hifiRootTextSnippet === ''
      ? ''
      : '；渲染错误信息：' + String(step.hifiRootTextSnippet).slice(0, 400);
    problems.push('界面回退旧版/渲染失败' + snippet);
  }
  let logo = null;
  if (step.name === 'welcome') {
    logo = logoChecks(step);
    for (const check of logo) if (!check.ok) problems.push('logo 检查失败：' + check.id + '（' + check.detail + '）');
  }
  return { problems, logo, order: index + 1 };
};

/* ============================================================
   五、主流程：隔离夹具 → Electron 逐场景截图 → 禁止词扫描 → result.json
   ============================================================ */
(async () => {
  let seedMs;
  try {
    const seedStart = Date.now();
    await require('esbuild').build({
      entryPoints: [path.join(root, 'scripts/lib/homepage-fixture.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      outfile: path.join(run, 'seed.cjs'),
      logLevel: 'silent',
    });
    const seeded = spawnSync(process.execPath, [path.join(run, 'seed.cjs'), data, project], {
      cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 180000,
    });
    seedMs = Date.now() - seedStart;
    fs.writeFileSync(path.join(run, 'seed.log'), (seeded.stdout || '') + '\n' + (seeded.stderr || ''));
    if (seeded.status !== 0) throw Error('隔离夹具装载失败（status=' + seeded.status + '）：' + (seeded.stderr || seeded.stdout));
  } catch (error) {
    const failed = {
      format: 'r149-ui-evidence-v1',
      ok: false,
      error: String((error && error.stack) || error),
      run: relPath(run),
      durationMs: Date.now() - startedAt,
      scenes: [],
    };
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(failed, null, 2));
    console.error(JSON.stringify(failed, null, 2));
    process.exitCode = 1;
    return;
  }

  const captureStart = Date.now();
  const electron = spawnSync(require('electron'), [wrapperPath], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 600000,
  });
  const captureMs = Date.now() - captureStart;
  fs.writeFileSync(path.join(run, 'process.log'), (electron.stdout || '') + '\n' + (electron.stderr || ''));
  const resultPath = path.join(run, 'capture-result.json');
  const raw = fs.existsSync(resultPath)
    ? JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    : { ok: false, error: '没有生成 capture-result.json（Electron 未完成截图）', results: [], failures: [] };
  const rawScenes = Array.isArray(raw.results) ? raw.results : [];

  const sceneEntries = [];
  const failedScenes = [];
  const hardMap = new Map();
  const softMap = new Map();
  for (let i = 0; i < rawScenes.length; i += 1) {
    const step = rawScenes[i];
    const evaluated = evaluateScene(step, i);
    const entry = {
      index: i + 1,
      name: step.name,
      screenshot: step.screenshot == null ? null : relPath(path.join(run, step.screenshot)),
      image: step.image,
      hash: step.hash,
      durationMs: step.durationMs,
      ok: evaluated.problems.length === 0,
      failedReasons: evaluated.problems,
      error: step.error == null ? null : step.error,
      missing: step.missing,
      errors: step.errors,
      loading: step.loading,
      dialogs: step.dialogs,
      hifiOn: step.hifiOn,
      legacyOn: step.legacyOn,
      hifiFailed: step.hifiFailed,
      bodyClass: step.bodyClass,
      hifiRootTextSnippet: step.hifiRootTextSnippet,
      layout: step.layout,
      required: step.required,
      logo: evaluated.logo,
      extra: step.extra,
      visibleTextLength: step.visibleTextLength,
      visibleTextTruncated: step.visibleTextTruncated === true,
      visibleText: step.visibleText,
      dialogScan: null,
      forbidden: { hard: [], soft: [] },
    };
    if (step.extra != null && typeof step.extra.dialogText === 'string' && step.extra.dialogText.length > 0) {
      entry.dialogScan = {
        textLength: step.extra.dialogText.length,
        hard: scanText(step.extra.dialogText, HARD_RULES),
        soft: scanText(step.extra.dialogText, SOFT_RULES),
      };
    }
    const sceneHard = new Map();
    const sceneSoft = new Map();
    for (const hit of scanText(step.visibleText || '', HARD_RULES)) mergeHit(sceneHard, hit, 'visible');
    for (const hit of scanText(step.visibleText || '', SOFT_RULES)) mergeHit(sceneSoft, hit, 'visible');
    entry.forbidden.hard = Array.from(sceneHard.values());
    entry.forbidden.soft = Array.from(sceneSoft.values());
    for (const hit of entry.forbidden.hard) mergeHit(hardMap, hit, step.name);
    for (const hit of entry.forbidden.soft) mergeHit(softMap, hit, step.name);
    sceneEntries.push(entry);
    if (!entry.ok) failedScenes.push({ name: step.name, reasons: evaluated.problems });
  }

  const hardHits = Array.from(hardMap.values());
  const softHits = Array.from(softMap.values());
  const durationMs = Date.now() - startedAt;
  const coverage = raw.names == null ? sceneEntries.map((item) => item.name) : raw.names;
  const skipped = coverage.filter((name) => !sceneEntries.some((item) => item.name === name));
  const report = {
    format: 'r149-ui-evidence-v1',
    ok: sceneEntries.length > 0 && failedScenes.length === 0 && hardHits.length === 0 && raw.ok === true,
    run: {
      name: runName,
      dir: relPath(run),
      screenshots: sceneEntries.map((item) => item.screenshot),
      result: relPath(path.join(run, 'result.json')),
      processLog: relPath(path.join(run, 'process.log')),
      seedLog: relPath(path.join(run, 'seed.log')),
    },
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    timing: { seedMs, captureMs },
    isolation: {
      appData: relPath(data),
      project: relPath(project),
      runtime: 'fake',
      allowFake: true,
      realDispatchGuard: true,
      daemonEntry: relPath(path.join(root, 'dist', 'pack', 'daemon.cjs')),
      uiEntry: relPath(mainCjs),
      zeroRealModelCalls: 'fake runtime only; script never submits messages, fixture seed uses FakeRuntimeAdapter',
    },
    build: {
      distUi: {
        mainCjs: fileInfo(mainCjs),
        rendererIndexHtml: fileInfo(path.join(root, 'dist', 'ui', 'renderer', 'index.html')),
        logoAsset: fileInfo(path.join(root, 'dist', 'ui', 'renderer', 'assets', 'logo.png')),
      },
      buildUiScript: fileInfo(path.join(root, 'scripts', 'build-ui.mjs')),
      rootLogo: fileInfo(path.join(root, 'logo.png')),
    },
    coverage: {
      expected: coverage,
      captured: sceneEntries.map((item) => item.name),
      skipped,
      only,
    },
    summary: {
      scenes: sceneEntries.length,
      passed: sceneEntries.filter((item) => item.ok).length,
      failed: failedScenes.length,
      hardHits: hardHits.length,
      softHits: softHits.length,
      screenshots: sceneEntries.filter((item) => item.screenshot != null).length,
      captureExitCode: electron.status,
    },
    window: raw.inner == null ? null : raw.inner,
    rendererConsole: Array.isArray(raw.rendererConsole) ? raw.rendererConsole : [],
    scenes: sceneEntries,
    forbidden: {
      hard: hardHits,
      soft: softHits,
      hardOk: hardHits.length === 0,
      softOk: softHits.length === 0,
      scanned: 'body.innerText（仅可见文本；未展开的 details 折叠内容不计入）',
    },
    failedScenes,
    captureError: raw.ok === true ? null : raw.error == null ? null : String(raw.error),
    notes: [
      'hard 命中即失败；soft 为 rubric 宽泛词（可能含合法用法）的提示，不阻塞，供 Lead 人工判断。',
      '设置页 help 的「诊断信息/查看诊断」在未展开时不计入可见文本；展开后的技术细节属允许范围。',
      '窗口/任务栏图标不在此脚本的 DOM 断言范围（需人工或包内检查）。',
      '截图按 1360x920 逻辑尺寸、1x 像素输出，便于逐张目视复核。',
    ],
  };
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: report.ok,
    run: report.run.dir,
    durationMs,
    timing: report.timing,
    summary: report.summary,
    failedScenes,
    hardForbidden: report.forbidden.hard.map((hit) => ({ term: hit.term, scenes: hit.locations, count: hit.count })),
    softForbidden: report.forbidden.soft.map((hit) => ({ term: hit.term, scenes: hit.locations, count: hit.count })),
    screenshots: report.run.screenshots,
  }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
})().catch((error) => {
  console.error(error);
  try {
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({
      format: 'r149-ui-evidence-v1',
      ok: false,
      error: String((error && error.stack) || error),
      run: relPath(run),
      durationMs: Date.now() - startedAt,
    }, null, 2));
  } catch { /* 保留原始错误 */ }
  process.exitCode = 1;
});
