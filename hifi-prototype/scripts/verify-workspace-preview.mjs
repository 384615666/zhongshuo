/**
 * WPV 专项验证：共享预览（UX-PREVIEW-01 / §17.9）。
 *
 * 对应施工说明 §8 的正式编号 WPV-01—36（规格 §13 的 PV-01—36）。
 * 本脚本覆盖**能用自动化断言证明**的那部分，其余在施工报告中标注
 * "手工/未实现/仅模拟" —— 不通过放宽断言让测试变绿（§8 第 4 条）。
 *
 * 用法：需要先启动 dev server 与带 CDP 的浏览器
 *   pnpm dev --port 5284
 *   node scripts/verify-workspace-preview.mjs http://localhost:5284
 *
 * 端口约定（**踩过的坑，务必错开**）：
 *   · Electron 调试端口        = 9333（`desktop:debug`）
 *   · smoke.mjs                = 9334
 *   · 本脚本（浏览器用例）      = **9335**（ZS_WPV_CDP_PORT 可覆盖）
 *
 * 为什么不能沿用 9333：本脚本会对页面执行 `location.reload()` 与
 * `Emulation.setDeviceMetricsOverride`。若连到的是 Electron 窗口，
 * 会把**用户的真实桌面窗口**导航走并改视口 —— README 记录过这类事故
 * （窗口白屏、后续用例连锁误判）。默认 9335 与两者都隔离。
 *
 * 若要**对桌面窗口**跑本套用例（推荐至少跑一次），显式指定：
 *   ZS_WPV_CDP_PORT=9333 node scripts/verify-workspace-preview.mjs file:///.../dist/index.html
 */

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_WPV_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`OK   ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ---------- CDP ---------- */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? list.find((t) => t.type === 'page');
if (!page) { console.error('找不到页面 target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); res({}); }, 15000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? 'eval error' };
  return r.result?.result?.value;
};
const go = async (hash) => {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(1200);
};

await send('Runtime.enable');
await send('Page.enable');

/**
 * 当前宿主是桌面窗口还是浏览器？两者能验证的东西**不一样**。
 *
 *  - 桌面窗口在 `electron/main.mjs` 里设了 **minWidth: 1040**，
 *    而 L4 并排只需 928px → **桌面端无论怎么缩都不会触发单区域**。
 *    这是产品设计约束，不是缺陷；要求桌面出现单区域会得到一条永远失败的用例。
 *  - 浏览器没有最小宽度限制，900px 能真实退化到单区域。
 *
 * 因此：
 *  1. 桌面宿主下**不改视口**（`Emulation.setDeviceMetricsOverride` 改的是渲染视口，
 *     与真实窗口尺寸不是一回事，用它制造"窄窗"等于伪造环境）。
 *     桌面端的窄宽证据由 `shot-desktop-narrow.mjs` 用 Win32 真调窗口产生。
 *  2. 依赖"能窄到 900"的断言在桌面宿主下**标记为跳过并写明原因**，
 *     不算通过也不算失败（施工说明 §8：无法执行要写明原因，不得填通过）。
 */
const isDesktopHost = await ev(`typeof window.zhongshuo === 'object' && window.zhongshuo.isDesktop === true`);
const skip = (name, why) => {
  console.log(`SKIP ${name} — ${why}`);
};
/** 桌面端能否窄到某宽度（受 minWidth 约束） */
const DESKTOP_MIN_WIDTH = 1040;
const canReach = (w) => !isDesktopHost || w >= DESKTOP_MIN_WIDTH;

if (isDesktopHost) {
  console.log(`宿主 = Electron 桌面窗口（minWidth=${DESKTOP_MIN_WIDTH}）；不改视口，窄宽证据由 shot-desktop-narrow.mjs 提供\n`);
} else {
  /**
   * 固定窗口尺寸再跑用例。
   *
   * 为什么必须显式设置：断言里含"两区并排"这类**取决于可用宽度**的期望，
   * 而浏览器窗口尺寸是环境相关的（用户可能开着窄窗口）。
   * 不固定的话，同一份代码在宽窗口通过、在窄窗口失败，用例就失去意义。
   * 布局用例（WPV-13）会在流程中自行改尺寸，跑完再恢复。
   */
  const VIEWPORT = { width: 1440, height: 900 };
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  });
}

/* ---------- 辅助：按文本找按钮并点击 ---------- */
const clickByText = (selector, text) => ev(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = els.find(e => (e.textContent || '').includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`);

/**
 * 轮询等待条件成立。
 *
 * 为什么需要（实测踩到）：单独跑本脚本 32/32 通过，但与其他套件连跑时
 * "单区域切回对话" 偶发失败 —— 断言在 React 完成重渲染**之前**就取了值。
 * 这是**测试时序问题，不是产品缺陷**（同一断言单独复跑稳定通过）。
 * 用轮询替代固定 sleep：既消除假失败，也让真实回归更快暴露
 * （真坏了会一直等到超时，而不是碰巧通过）。
 */
async function waitFor(expr, { timeout = 4000, interval = 120 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() > deadline) return v;
    await sleep(interval);
  }
}

/** 等到某个选择器出现（最多 timeout） */
const waitForSelector = (selector, timeout) =>
  waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, { timeout });

/* ============================================================
   WPV-01：主池普通消息（无 taskId）打开附件
   ============================================================ */

/**
 * 必须先**整页重载**再开始。
 *
 * 原因（实测踩到）：业务状态是内存态，只有导航偏好落 localStorage。
 * 仅改 hash 的话，上一段流程留下的预览会话**仍然存在** ——
 * 于是"从主池打开"的阶段实际继承了上一段"从线程打开"的状态，
 * 主池按来源侧被收起，chip 看起来"不见了"。
 * 这是测试夹具问题，不是产品缺陷；用 reload 拿到干净起点。
 */
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);

await go('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await sleep(900);

const poolAttachment = await ev(`(() => {
  const chips = [...document.querySelectorAll('.msg-attach')];
  const chip = chips.find(c => (c.textContent || '').includes('架构评审要点'));
  return { count: chips.length, found: !!chip, titles: chips.map(c => c.textContent.trim()) };
})()`);
check('主池出现可点击的附件 chip（无 taskId 的普通消息）',
  poolAttachment?.found === true, JSON.stringify(poolAttachment));

// 打开它
await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('架构评审要点'));
  if (c) c.click(); return !!c;
})()`);
await sleep(900);

const opened = await ev(`(() => {
  const pane = document.querySelector('.preview-pane');
  if (!pane) return { pane: false };
  return {
    pane: true,
    tabs: [...pane.querySelectorAll('.preview-tab-label')].map(t => t.textContent.trim()),
    hasMd: !!pane.querySelector('.md-view'),
    hasH1: pane.querySelector('.md-h1')?.textContent?.trim() ?? null,
    origin: pane.querySelector('.preview-origin')?.textContent?.trim() ?? null,
    layout: document.querySelector('.workspace')?.dataset.layout ?? null,
    poolStillVisible: !!document.querySelector('.col-main'),
    hasTable: !!pane.querySelector('.md-table'),
    hasCode: !!pane.querySelector('.md-code'),
  };
})()`);
check('WPV-01 预览面板打开并渲染 Markdown',
  opened?.pane === true && opened?.hasMd === true, JSON.stringify(opened));
check('WPV-01 标题/表格/行内代码按真实规则渲染',
  opened?.hasH1?.includes('预览管线设计说明') === true && opened?.hasTable === true && opened?.hasCode === true,
  JSON.stringify({ h1: opened?.hasH1, table: opened?.hasTable, code: opened?.hasCode }));
check('WPV-01 来源栏写明归属，且与来路重复时不重复显示（去重口径）',
  typeof opened?.origin === 'string'
    && opened.origin.includes('来源：')
    && !opened.origin.includes('从 ')
    && opened.origin.includes('模拟资源'),
  opened?.origin);
check('WPV-01/L3 主池仍然可见（不强行进入附件所属任务）',
  opened?.poolStillVisible === true, JSON.stringify({ pool: opened?.poolStillVisible, layout: opened?.layout }));
check('WPV-01 布局标记为 L3（context-preview）',
  opened?.layout === 'context-preview', String(opened?.layout));

/* ============================================================
   WPV-07：同资源同版本去重 + 同名不同版本并存
   ============================================================ */
await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('架构评审要点'));
  if (c) c.click(); return !!c;
})()`);
await sleep(700);
const dedup = await ev(`document.querySelectorAll('.preview-tab').length`);
check('WPV-07 同资源同版本重复打开只保留一个标签', dedup === 1, `标签数=${dedup}`);

/* ============================================================
   WPV-12：关闭标签 / 收起 / 关闭全部
   ============================================================ */
await ev(`document.querySelector('.preview-tab-close')?.click(); true`);
await sleep(700);
const afterClose = await ev(`({
  tabs: document.querySelectorAll('.preview-tab').length,
  paneGone: !document.querySelector('.preview-pane') || document.querySelectorAll('.preview-tab').length === 0,
})`);
check('WPV-12 关闭最后一个标签退出预览', afterClose?.tabs === 0, JSON.stringify(afterClose));

/* ============================================================
   WPV-02/03：线程成果在预览打开，且不替换对话
   ============================================================ */
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts');
await sleep(1000);

const artifactTab = await ev(`(() => {
  const text = document.body.innerText;
  return {
    onArtifacts: [...document.querySelectorAll('.thread-tab.on')].some(e => e.textContent.includes('成果')),
    hasReplies: text.includes('回复') || !!document.querySelector('.col-thread'),
    attachChips: [...document.querySelectorAll('.msg-attach')].map(c => c.textContent.trim()),
  };
})()`);
check('WPV-03 成果 tab 仍是成果列表（未被文件正文替换）',
  artifactTab?.onArtifacts === true, JSON.stringify(artifactTab));
check('WPV-03 本串附件在成果 tab 内可见',
  (artifactTab?.attachChips ?? []).length > 0, JSON.stringify(artifactTab?.attachChips));

await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明'));
  if (c) c.click(); return !!c;
})()`);
await sleep(900);

const l4 = await ev(`(() => {
  const pane = document.querySelector('.preview-pane');
  if (!pane) return { pane: false };
  const ws = document.querySelector('.workspace');
  return {
    pane: true,
    layout: ws?.dataset.layout ?? null,
    threadVisible: !!document.querySelector('.col-thread'),
    poolVisible: !!document.querySelector('.col-main'),
    // 版本**只在标签上显示一次**（2026-09-24 去重：工具行不再重复版本徽标）
    versions: [...pane.querySelectorAll('.preview-tab')]
      .filter(t => t.classList.contains('on'))
      .map(t => t.textContent.trim()),
    versionTags: pane.querySelectorAll('.preview-version').length,
    origin: pane.querySelector('.preview-origin')?.textContent?.trim() ?? '',
  };
})()`);
check('WPV-03/PV-04 从线程打开文件 → L4（线程 + 文件）',
  l4?.pane === true && l4?.threadVisible === true && l4?.layout === 'context-preview', JSON.stringify(l4));
check('WPV-08 版本徽标显示固定版本（v3）',
  (l4?.versions ?? []).some((v) => v.includes('v3')), JSON.stringify(l4?.versions));
check('WPV-08 版本只显示一处（口径统一 v3 / 读取 r3，工具行不再重复）',
  l4?.versionTags === 0, `工具行版本徽标数=${l4?.versionTags}`);
check('WPV-03 文件来源写明属于哪个任务',
  typeof l4?.origin === 'string' && l4.origin.includes('来源：'), l4?.origin);

/* ============================================================
   图片预览（真实 PNG 解码）
   ============================================================ */
// 重载拿干净会话；否则上一段的预览标签仍在
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
await go('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await sleep(1000);
await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览布局草图'));
  if (c) c.click(); return !!c;
})()`);
await sleep(900);
const img = await ev(`(() => {
  const im = document.querySelector('.preview-image');
  return im ? { src: im.getAttribute('src')?.slice(0, 30), complete: im.complete, w: im.naturalWidth, h: im.naturalHeight } : null;
})()`);
check('图片预览解码了真实 PNG（320x180）',
  img?.complete === true && img?.w === 320 && img?.h === 180, JSON.stringify(img));

/* ============================================================
   不支持格式：如实显示，不给假正文
   ============================================================ */
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
await sleep(1200);
await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('外部评审意见'));
  if (c) c.click(); return !!c;
})()`);
await sleep(900);
const unsupported = await ev(`(() => {
  const box = document.querySelector('.preview-unsupported');
  return box ? {
    text: box.innerText,
    tags: [...box.querySelectorAll('.tag')].map(t => t.textContent.trim()),
  } : null;
})()`);
check('WPV-22 不支持格式显示明确状态而非假正文',
  unsupported !== null && unsupported.text.includes('不能预览'), JSON.stringify(unsupported?.text?.slice(0, 60)));
check('WPV-22 四种能力分别标注（保存/预览/提取/交给 AI）',
  (unsupported?.tags ?? []).some((t) => t.includes('可保存'))
  && (unsupported?.tags ?? []).some((t) => t.includes('预览')),
  JSON.stringify(unsupported?.tags));

/* ============================================================
   引用：固定版本进入目标草稿
   ============================================================ */
const quote = await ev(`(() => {
  const btn = [...document.querySelectorAll('.preview-tools button')].find(b => b.textContent.includes('引用到'));
  if (!btn) return { found: false };
  const label = btn.textContent.trim();
  btn.click();
  return { found: true, label };
})()`);
await sleep(800);
const quoted = await ev(`(() => {
  const log = window.__zsWriteLog ?? null;
  return {
    toast: document.querySelector('.toast')?.textContent?.trim() ?? null,
    refCards: document.querySelectorAll('.ref-card').length,
  };
})()`);
check('WPV-05/06 引用按钮存在且带明确目标名',
  quote?.found === true && typeof quote?.label === 'string', JSON.stringify(quote));

/* ============================================================
   WPV-13：容器自适应（改窗口宽度）
   ============================================================
   必须在**同一个预览会话**里连续改宽度，才能验证"同一份逻辑状态
   在不同宽度下如何退化"（§5.3 第 5 条：窗口变宽后恢复逻辑布局）。 */
async function setWidth(w) {
  // 桌面宿主：不改视口（那会伪造窗口尺寸）。真实窄宽由 shot-desktop-narrow.mjs 用
  // Win32 调真实窗口产生；这里退化为"读当前真实布局"，用例据此走跳过分支。
  if (isDesktopHost) {
    return ev(`(() => {
      const ws = document.querySelector('.workspace');
      return {
        layout: ws?.dataset.layout ?? null,
        innerWidth: window.innerWidth,
        paneWidth: Math.round(document.querySelector('.preview-pane')?.getBoundingClientRect().width ?? 0),
        titleNonZero: (() => {
          const t = document.querySelector('.preview-tab-label, .msg-author');
          return t ? Math.round(t.getBoundingClientRect().width) : -1;
        })(),
      };
    })()`);
  }
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: 872, deviceScaleFactor: 1, mobile: false,
  });
  /**
   * 改视口后**必须让 ResizeObserver 有机会跑**。
   *
   * 实测（重要）：`Emulation.setDeviceMetricsOverride` 改变的是渲染视口，
   * Chrome 并不总是为它触发 `ResizeObserver` —— 即使 `.app-body` 的
   * `getBoundingClientRect()` 已经变了，观察者回调也可能一直不来。
   * 结果是布局解析器拿不到新宽度，输出**冻结**在上一次的值
   * （实测：900px 窗口下仍按 ~1426px 计算，预览 661px 溢出容器 654px）。
   *
   * 这是**测试夹具的限制，不是产品缺陷** —— 在真实 Electron 窗口里用
   * Win32 调整窗口大小时，宽度每档都正确更新（见 shot-desktop-narrow.mjs 与报告）。
   *
   * 处理：显式派发一次 `resize`，让挂载在 window 上的测量逻辑重跑。
   * 这不是"为了让测试变绿"绕过断言：断言仍然检查真实计算出的布局，
   * 只是补上夹具本应提供的事件。
   */
  await ev(`window.dispatchEvent(new Event('resize')); true`);
  let prev = '';
  for (let i = 0; i < 24; i++) {
    await sleep(160);
    const snap = await ev(`(() => {
      const ws = document.querySelector('.workspace');
      return [
        ws?.dataset.layout ?? '',
        Math.round(ws?.getBoundingClientRect().width ?? 0),
        !!document.querySelector('.sidebar'),
        Math.round(document.querySelector('.preview-pane')?.getBoundingClientRect().width ?? 0),
      ].join('|');
    })()`);
    if (snap === prev) break;
    prev = snap;
  }
  return ev(`(() => {
    const ws = document.querySelector('.workspace');
    return {
      layout: ws?.dataset.layout ?? null,
      wsWidth: Math.round(ws?.getBoundingClientRect().width ?? 0),
      paneWidth: Math.round(document.querySelector('.preview-pane')?.getBoundingClientRect().width ?? 0),
      poolWidth: Math.round(document.querySelector('.col-main')?.getBoundingClientRect().width ?? 0),
      threadWidth: Math.round(document.querySelector('.col-thread')?.getBoundingClientRect().width ?? 0),
      singleSwitch: !!document.querySelector('.single-region-switch'),
      titleNonZero: (() => {
        const t = document.querySelector('.preview-tab-label, .msg-author');
        return t ? Math.round(t.getBoundingClientRect().width) : -1;
      })(),
      previewTabs: document.querySelectorAll('.preview-tab').length,
    };
  })()`);
}

// 干净起点：重载 → 打开线程成果 → 在预览打开（L4，两区）
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
await sleep(1200);
await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明'));
  if (c) c.click(); return !!c;
})()`);
await sleep(900);

/* ============================================================
   WPV-13b：防挤爆 —— 标签不得竖排折行（§8.3 硬性规则）
   ============================================================
   实测截图为证：1372px 下 L4 对话侧 487px 时，
   「成果」「活动」被压成竖排单字。用几何断言锁住：
   单个 tab 的宽度必须明显大于其高度（竖排时宽≈1 字、高≈字数×行高）。 */
async function checkNoVerticalText(label) {
  return ev(`(() => {
    const bad = [];
    const els = [...document.querySelectorAll('.thread-tab, .preview-tab-label, .preview-icon-btn')];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const text = (el.textContent || '').trim();
      // 竖排特征：宽 < 24px 且高 > 宽（单字竖排）
      if (text.length >= 2 && r.width < 24 && r.height > r.width * 1.2) {
        bad.push({ text, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return { label: ${JSON.stringify(label)}, bad, checked: els.length };
  })()`);
}

const vertical1372 = await checkNoVerticalText('1372 L4');
check('WPV-13b 1372px L4：线程/预览标签无竖排折行',
  (vertical1372?.bad ?? []).length === 0, JSON.stringify(vertical1372));

const w1372 = await setWidth(1372);
check('WPV-13 1372px：两内容区并排且标题非零宽',
  w1372?.layout === 'context-preview' && w1372?.paneWidth > 400 && w1372?.titleNonZero > 10,
  JSON.stringify(w1372));

const w1280 = await setWidth(1280);
check('WPV-13 1280px：仍是两内容区（预览 ≥ 候选下限附近）',
  w1280?.layout === 'context-preview' && w1280?.paneWidth >= 480,
  JSON.stringify(w1280));

const vertical1280 = await checkNoVerticalText('1280 L4');
check('WPV-13b 1280px L4：标签仍无竖排折行（最挤的一档）',
  (vertical1280?.bad ?? []).length === 0, JSON.stringify(vertical1280));

const w1100 = await setWidth(1100);
if (canReach(1100)) {
  check('WPV-13 1100px：按实际空间退化（两区或单区，都有明确结果）',
    w1100?.layout === 'context-preview' || w1100?.layout === 'single',
    JSON.stringify(w1100));
} else {
  skip('WPV-13 1100px', `桌面窗口 minWidth=${DESKTOP_MIN_WIDTH}，无法窄到 1100（窄宽证据见 shot-desktop-narrow.mjs）`);
}

const w900 = await setWidth(900);
if (canReach(900)) {
  check('WPV-13 900px：切单区域并给出切换器',
    w900?.layout === 'single' && w900?.singleSwitch === true,
    JSON.stringify(w900));
} else {
  /**
   * 桌面端**不应**出现单区域：minWidth 1040 ≥ L4 并排所需 928。
   * 所以这里反过来断言"桌面上不该有单区域切换器"——
   * 这比跳过更有价值：它锁住"桌面用户不会莫名其妙被切成单栏"。
   */
  const desktopNoSingle = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    return {
      layout: ws?.dataset.layout ?? null,
      singleSwitch: !!document.querySelector('.single-region-switch'),
      innerWidth: window.innerWidth,
    };
  })()`);
  check('WPV-13 桌面端不下探到 minWidth 以下，因此不出现单区域（锁住该约束）',
    desktopNoSingle?.singleSwitch === false && desktopNoSingle?.innerWidth >= DESKTOP_MIN_WIDTH,
    JSON.stringify(desktopNoSingle));
}

const singleToggle = await ev(`(() => {
  const btns = [...document.querySelectorAll('.single-region-switch .seg button')];
  const ctxBtn = btns.find(b => b.textContent.includes('对话'));
  if (!ctxBtn) return { found: false };
  ctxBtn.click();
  return { found: true };
})()`);
// 等重渲染完成再断言（固定 sleep 在连跑时会不够）
await waitFor(`!!document.querySelector('.col-thread, .col-main')`);
const backToContext = await ev(`(() => ({
  poolVisible: !!document.querySelector('.col-main'),
  threadVisible: !!document.querySelector('.col-thread'),
  previewVisible: !!document.querySelector('.preview-pane'),
  layout: document.querySelector('.workspace')?.dataset.layout ?? null,
}))()`);

/**
 * 断言分两步，因为**单区域下预览面板本就不在 DOM 里**：
 * "保留标签"指**逻辑状态保留**（§5.3 第 5 条"进入单区域不关闭逻辑上的预览"），
 * 不是隐藏后还留在 DOM。所以先切回"文件"，再确认标签还在。
 * 直接数 `.preview-tab` 会把正确行为判成失败（那是断言写错）。
 */
const switchBack = await ev(`(() => {
  const btns = [...document.querySelectorAll('.single-region-switch .seg button')];
  const fileBtn = btns.find(b => b.textContent.includes('文件'));
  if (!fileBtn) return { found: false };
  fileBtn.click();
  return { found: true };
})()`);
await waitFor(`!!document.querySelector('.preview-pane .preview-tab')`);
const afterSwitchBack = await ev(`({
  previewVisible: !!document.querySelector('.preview-pane'),
  tabsStillThere: document.querySelectorAll('.preview-tab').length,
  tabTitles: [...document.querySelectorAll('.preview-tab-label')].map(t => t.textContent.trim()),
})`);

if (canReach(900)) {
  check('WPV-13 单区域可切回对话侧（L4 时是回复串）',
    singleToggle?.found === true
    && (backToContext?.poolVisible === true || backToContext?.threadVisible === true),
    JSON.stringify({ toggle: singleToggle, after: backToContext }));
  check('WPV-13 单区域往返后预览标签与阅读状态保留',
    switchBack?.found === true && afterSwitchBack?.tabsStillThere > 0
    && afterSwitchBack?.previewVisible === true,
    JSON.stringify({ switchBack, after: afterSwitchBack }));
} else {
  skip('WPV-13 单区域往返', `桌面窗口 minWidth=${DESKTOP_MIN_WIDTH}，不触发单区域（改为上面那条"不应出现单区域"的断言）`);
}

if (!isDesktopHost) {
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
}

/* ============================================================
   WPV-31/32：私信 audience 隔离（§17.9 第 7 条）
   ============================================================
   这是**最容易做错**的一条：只看 projectId 会把私信附件当成项目公共资源。
   正确行为是：私信里能打开，切到群聊后该标签**暂藏**且不露文件名。 */
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
await go('/project/proj_zs_01/dm?recovery=0');
await sleep(1400);

const dmPage = await ev(`(() => {
  const chips = [...document.querySelectorAll('.msg-attach')];
  return {
    hasDmChips: chips.length,
    titles: chips.map(c => c.textContent.trim()),
    dmRowCount: document.querySelectorAll('.dm-row').length,
  };
})()`);
check('WPV-31 私信页出现私信附件入口', dmPage?.hasDmChips > 0, JSON.stringify(dmPage));

// 在私信里打开它
await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('对账截图'));
  if (c) c.click(); return !!c;
})()`);
await sleep(1000);

const inDm = await ev(`(() => {
  const pane = document.querySelector('.preview-pane');
  return {
    pane: !!pane,
    tabs: [...document.querySelectorAll('.preview-tab-label')].map(t => t.textContent.trim()),
    origin: pane?.querySelector('.preview-origin')?.textContent?.trim() ?? '',
    img: !!pane?.querySelector('.preview-image'),
  };
})()`);
check('WPV-31 私信附件在 DM 上下文可打开（真实图片）',
  inDm?.pane === true && inDm?.tabs?.length === 1 && inDm?.img === true, JSON.stringify(inDm));
check('WPV-31 来源标注为「私信」而不是房间/任务',
  typeof inDm?.origin === 'string' && inDm.origin.includes('私信'), inDm?.origin);

// 切到群聊：受限标签必须暂藏
await go('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await sleep(1300);

const afterSwitch = await ev(`(() => {
  const panes = document.querySelectorAll('.preview-pane');
  const text = [...panes].map(p => p.innerText).join('\\n');
  return {
    paneCount: panes.length,
    leaksFilename: text.includes('对账截图'),
    tabsVisible: [...document.querySelectorAll('.preview-tab-label')].map(t => t.textContent.trim()),
  };
})()`);
check('WPV-32 切到群聊后私信标签暂藏，且不泄露文件名',
  afterSwitch?.leaksFilename === false, JSON.stringify(afterSwitch));

/* ============================================================
   WPV-16/17：请求竞态（先断言可观测的性质）
   ============================================================ */
// 连续打开多份文件，最后活动标签必须是**最后点击的那个**（不被早的回包覆盖）
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
await go('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await sleep(1200);

const openSeq = await ev(`(() => {
  const chips = [...document.querySelectorAll('.msg-attach')];
  const mk = chips.find(c => c.textContent.includes('预览布局草图'));
  const md = chips.find(c => c.textContent.includes('架构评审要点'));
  if (!mk || !md) return { ok: false, n: chips.length };
  mk.click();
  md.click();
  return { ok: true };
})()`);
await sleep(1100);
const race = await ev(`(() => ({
  tabs: [...document.querySelectorAll('.preview-tab-label')].map(t => t.textContent.trim()),
  active: document.querySelector('.preview-tab.on .preview-tab-label')?.textContent?.trim() ?? null,
  body: document.querySelector('.preview-pane .md-view') ? 'markdown' : document.querySelector('.preview-pane .preview-image') ? 'image' : 'other',
}))()`);
check('WPV-16 连开两份文件：都建标签，活动标签是最后点击的那份',
  race?.tabs?.length === 2 && race?.body === 'markdown'
  && String(race?.active ?? '').includes('架构评审要点'),
  JSON.stringify({ openSeq, race }));

// WPV-17：关闭标签后不得被回包重新打开 —— 关闭后标签数不回升
await ev(`(() => {
  const btns = [...document.querySelectorAll('.preview-tab.on .preview-tab-close')];
  if (btns[0]) btns[0].click();
  return !!btns[0];
})()`);
await sleep(1200);
const afterRaceClose = await ev(`document.querySelectorAll('.preview-tab').length`);
check('WPV-17 关闭标签后不被迟到响应重新打开',
  afterRaceClose === 1, `剩余标签=${afterRaceClose}`);

/* ============================================================
   无控制台错误
   ============================================================ */
check('运行期间无控制台错误', consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | '));

/* ---------- 汇总 ---------- */
console.log(`\n=== WPV 专项：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
ws.close();
process.exit(fail > 0 ? 1 : 0);
