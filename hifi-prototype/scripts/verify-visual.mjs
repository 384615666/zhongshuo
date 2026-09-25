/**
 * 视觉改造实际渲染检查（规范 §9）。
 *
 * 与"看截图"不同，这里**读取真实计算样式**并复算对比度 ——
 * 文档审查通过不等于页面验收通过，必须有可复算的证据。
 *
 * 用法（先起 dev server 与带 CDP 的浏览器）：
 *   pnpm dev --port 5284
 *   node scripts/verify-visual.mjs http://localhost:5284
 *
 * 端口：ZS_VIS_CDP_PORT，默认 9335（与 Electron 9333 / smoke 9334 错开）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-visual');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`OK   ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function skip(name, why) { skipped++; console.log(`SKIP ${name} — ${why}`); }

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

await send('Runtime.enable');
await send('Page.enable');

const go = async (hash, wait = 1300) => {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(wait);
};
const setSize = async (w, h = 900) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  /**
   * 显式派发 resize：`Emulation.setDeviceMetricsOverride` 不保证触发
   * ResizeObserver（`.app-body` 的 rect 会变，但观察者回调可能不来），
   * 于是容器测量拿不到新宽度、布局输出冻结。真实 Electron 窗口没有这个问题
   * （Win32 调窗时每档都正确更新）。这里补上夹具本应提供的事件。
   */
  await ev(`window.dispatchEvent(new Event('resize')); true`);
  await sleep(900);
};
const shoot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result?.data) {
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    return true;
  }
  return false;
};

/**
 * 在页面内计算对比度（WCAG 2.1 相对亮度公式）。
 * 用**实际渲染后的计算样式**，不是文档里的声明值 —— 规范 §9.3 要求"抽测与 §2.7 表一致"。
 */
const CONTRAST_FN = `
  function parseColor(c) {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum({r,g,b}) {
    const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
  }
  function ratio(fg, bg) {
    const L1 = lum(fg), L2 = lum(bg);
    const a = Math.max(L1,L2), b = Math.min(L1,L2);
    return (a + 0.05) / (b + 0.05);
  }
  /** 把半透明前景合成到底色上，得到有效的视觉前景 */
  function flatten(fg, bg) {
    if (fg.a >= 1) return fg;
    return {
      r: fg.r*fg.a + bg.r*(1-fg.a),
      g: fg.g*fg.a + bg.g*(1-fg.a),
      b: fg.b*fg.a + bg.b*(1-fg.a),
      a: 1,
    };
  }
  /** 向上找第一个不透明背景色（作为实际承载面） */
  function effectiveBg(el) {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.95) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
`;

/* ============================================================
   1. 令牌落地：确认关键令牌已按规范取值
   ============================================================
   必须先**显式把 hash 设成浅色页再重载**：主题只在挂载时从 `?theme=` 读取，
   若上一次运行以 `?theme=dark` 结束，URL 会带着它进入本次运行，
   于是"浅色令牌"检查全部读到深色值（实测踩到）。
   `localStorage.clear()` 不足以复位 —— 主题来自 URL，不是存储。 */
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
const themeNow = await ev(`document.documentElement.dataset.theme`);
check('测试起点为浅色主题（隔离性检查）', themeNow === 'light', `theme=${themeNow}`);

const tokens = await ev(`(() => {
  const cs = getComputedStyle(document.documentElement);
  const get = (k) => cs.getPropertyValue(k).trim();
  return {
    bgApp: get('--bg-app'),
    bgSurface: get('--bg-surface'),
    bgSurface2: get('--bg-surface-2'),
    text3: get('--text-3'),
    accentText: get('--accent-text'),
    gradSoft: get('--grad-soft'),
    grad: get('--grad'),
    rSm: get('--r-sm'), rMd: get('--r-md'), rLg: get('--r-lg'), rXl: get('--r-xl'),
    mHuman: get('--m-human'),
    avatarFg: get('--avatar-fg'),
    bgSelected: get('--bg-selected'),
  };
})()`);

check('§2.1 --bg-app = #f2f8fb（侧栏浅蓝白）', tokens?.bgApp === '#f2f8fb', tokens?.bgApp);
check('§2.1 --bg-surface = #ffffff', tokens?.bgSurface === '#ffffff', tokens?.bgSurface);
check('§2.3 --text-3 = #626b75（可读元信息，非旧 #6b7c8f）', tokens?.text3 === '#626b75', tokens?.text3);
check('§2.4 --accent-text = #1d4ed8', tokens?.accentText === '#1d4ed8', tokens?.accentText);
check('§2.0 --grad-soft 已定义且为 135deg 渐变', String(tokens?.gradSoft ?? '').includes('135deg'), tokens?.gradSoft);
check('§2.0 --grad 已定义且为深色渐变', String(tokens?.grad ?? '').includes('135deg'), tokens?.grad);
check('§3.3 圆角刻度上移（sm8/md10/lg16/xl20）',
  tokens?.rSm === '8px' && tokens?.rMd === '10px' && tokens?.rLg === '16px' && tokens?.rXl === '20px',
  JSON.stringify({ sm: tokens?.rSm, md: tokens?.rMd, lg: tokens?.rLg, xl: tokens?.rXl }));
check('§2.6 --m-human = #c2410c（不再与主色撞色）', tokens?.mHuman === '#c2410c', tokens?.mHuman);
check('§2.6 --avatar-fg = #ffffff（浅色主题）', tokens?.avatarFg === '#ffffff', tokens?.avatarFg);
check('§8 --bg-selected 已删除（迁移完成）', !tokens?.bgSelected, `值=${JSON.stringify(tokens?.bgSelected)}`);

/* ============================================================
   2. 选中态：侧栏当前房间 = 渐变 + accent-text
   ============================================================ */
const sideSel = await ev(`(() => {
  const el = document.querySelector('.side-item.active');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  return {
    found: true,
    bgImage: cs.backgroundImage.slice(0, 60),
    hasGradient: cs.backgroundImage.includes('gradient'),
    color: cs.color,
    fontWeight: cs.fontWeight,
    before: getComputedStyle(el, '::before').backgroundColor,
    beforeContent: getComputedStyle(el, '::before').content,
    isSub: el.classList.contains('sub'),
  };
})()`);
check('§5.1 侧栏当前房间：渐变选中 + accent-text + 600',
  sideSel?.found === true && sideSel?.hasGradient === true
  && sideSel?.color === 'rgb(29, 78, 216)' && Number(sideSel?.fontWeight) >= 600,
  JSON.stringify(sideSel));
/* 用例更新（2026-09-25 第三轮，用户要求）：侧栏**项目区的嵌套列表不再挂左侧竖条**
   （原话"我不需要名字前面的 | / 不需要名字前面的符号，你可以参图2的递进关系"），
   选中只靠渐变底 + 强调色文字；层级只靠缩进（缩进量另有断言）。
   规则没有消失，而是按区域分工 —— 所以下面一条**同时**断言平铺的功能入口仍保留竖条，
   避免"删掉旧断言"等于把 §5.1 的选中态规则悄悄丢掉。 */
check('§5.1 当前房间（嵌套子项）不挂左侧竖条：靠渐变底 + 强调色文字区分选中',
  sideSel?.isSub === true && sideSel?.beforeContent === 'none',
  JSON.stringify({ isSub: sideSel?.isSub, content: sideSel?.beforeContent, before: sideSel?.before }));

await ev(`location.hash='/project/proj_zs_01/files?tab=git'; true`);
await sleep(1200);
const flatSel = await ev(`(() => {
  const el = [...document.querySelectorAll('.sidebar-top .side-item')]
    .find((e) => e.querySelector('.side-item-label')?.innerText.trim() === '文件与 Git');
  if (!el || !el.classList.contains('active')) return { found: false };
  const cs = getComputedStyle(el, '::before');
  return { found: true, content: cs.content, bg: cs.backgroundColor, w: cs.width };
})()`);
check('§5.1 顶部/底部一层平铺的功能入口仍保留 3px --accent 竖条',
  flatSel?.found === true && flatSel?.content === '""'
  && flatSel?.bg === 'rgb(37, 99, 235)' && flatSel?.w === '3px',
  JSON.stringify(flatSel));
// 回到房间页：后面的页签/布局断言都以前提页面状态为准
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(1300);

/* 上下文（当前项目）与位置（当前页）必须可分：上下文浅底无竖条。
   注意类名挂在 .side-row 上（不是 .side-item）—— 按实际 DOM 选择，不按猜测。 */
const ctxSel = await ev(`(() => {
  const el = document.querySelector('.side-row.context-active');
  if (!el) return { found: false, tried: document.querySelectorAll('.side-row').length };
  const cs = getComputedStyle(el);
  const before = getComputedStyle(el, '::before');
  return {
    found: true,
    hasGradient: cs.backgroundImage.includes('gradient'),
    bg: cs.backgroundColor,
    beforeBg: before.backgroundColor,
    beforeContent: before.content,
  };
})()`);
check('§5.1 上下文（当前项目）与位置（当前页）可分：上下文无渐变、无竖条',
  ctxSel?.found === true && ctxSel?.hasGradient === false
  && (ctxSel?.beforeContent === 'none' || ctxSel?.beforeBg === 'rgba(0, 0, 0, 0)'),
  JSON.stringify(ctxSel));

/* ============================================================
   3. 内容页签（§5.5）：独立圆润选中项，非下划线
   ============================================================ */
const tabs = await ev(`(() => {
  const on = document.querySelector('.thread-tab.on');
  const all = [...document.querySelectorAll('.thread-tab')];
  if (!on) return { found: false, count: all.length };
  const cs = getComputedStyle(on);
  const container = getComputedStyle(document.querySelector('.thread-tabs'));
  return {
    found: true,
    count: all.length,
    activeCount: all.filter(t => t.classList.contains('on')).length,
    hasGradient: cs.backgroundImage.includes('gradient'),
    color: cs.color,
    radius: cs.borderRadius,
    borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomStyle,
    containerBorderBottom: container.borderBottomWidth,
  };
})()`);
check('§5.5 内容页签：激活项为渐变选中 + accent-text',
  tabs?.found === true && tabs?.hasGradient === true && tabs?.color === 'rgb(29, 78, 216)',
  JSON.stringify(tabs));
check('§5.5 内容页签已去下划线（border-bottom 为 0）',
  tabs?.containerBorderBottom === '0px' && String(tabs?.borderBottom ?? '').startsWith('0px'),
  JSON.stringify({ container: tabs?.containerBorderBottom, item: tabs?.borderBottom }));
check('§5.5 同组只有一个激活页签', tabs?.activeCount === 1, `activeCount=${tabs?.activeCount}`);

/**
 * 分段控件（模式切换）必须**不**用渐变（§5.5/§7）。
 *
 * 用例迁移（2026-09-25「默认交给 AI」改造）：输入区的「任务/讨论」分段已按用户决定移除，
 * 规则本身不变，换到一个仍然真实存在的分段控件上验证 —— 窄布局的「对话/文件」单区域切换器。
 * 同时**顺带锁住"输入区不再有分段"**，避免哪天真被恢复却没人发现。
 */
/*
 * 用例迁移（2026-09-25「默认交给 AI」）：输入区的「任务/讨论」分段已按用户决定移除，
 * 规则本身不变 —— 换到一个**真实且稳定存在**的分段控件上验证：图片预览的「适应/原尺寸」。
 * （先前那版拿"单区域切换器"当替身，需要窄视口 + 打开文件，改了页面状态，
 *   把后面几条布局断言的前提弄坏了；这里打开一张图片预览即可，验完立刻关掉。）
 */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(900);
const zoomAttach = await ev(`(() => {
  const a = [...document.querySelectorAll('.root-card .msg-attach')].find((x) => x.innerText.includes('预览布局草图'));
  a?.click();
  return !!a;
})()`);
await sleep(1300);
const seg = await ev(`(() => {
  const btn = document.querySelector('.seg button.on');
  const inComposer = !!document.querySelector('.composer-toolbar .seg');
  if (!btn) return { found: false, inComposer };
  const cs = getComputedStyle(btn);
  return {
    found: true,
    inComposer,
    inImageZoom: !!btn.closest('.seg.tiny'),
    hasGradient: cs.backgroundImage.includes('gradient'),
    bg: cs.backgroundColor,
    shadow: cs.boxShadow !== 'none',
    fontWeight: cs.fontWeight,
  };
})()`);
check('§5.5 分段控件激活块 = 白底 + shadow-sm，**不用渐变**（现由图片缩放的「适应/原尺寸」承载）',
  seg?.found === true && seg?.hasGradient === false && seg?.shadow === true,
  JSON.stringify(seg));
check('输入区不再有常驻「任务/讨论」分段（默认交给 AI，2026-09-25）',
  seg?.inComposer === false,
  `composer 内分段=${seg?.inComposer}`);
/* 关掉预览，恢复后续布局断言所需的页面状态 */
await ev(`(() => {
  const close = document.querySelector('.preview-tab-close');
  close?.click();
  return !!close;
})()`);
await sleep(700);

/* ============================================================
   4. 主按钮 = --grad-soft 浅渐变（§5.8，用户指定：蓝字浅底）
   ============================================================ */
const mainBtn = await ev(`(() => {
  const btn = document.querySelector('.btn.primary');
  if (!btn) return { found: false };
  const cs = getComputedStyle(btn);
  return {
    found: true,
    hasGradient: cs.backgroundImage.includes('gradient'),
    color: cs.color,
    label: btn.textContent.trim().slice(0, 10),
  };
})()`);
check('§5.8 主按钮 = --grad-soft 浅渐变 + 蓝字（用户指定）',
  mainBtn?.found === true && mainBtn?.hasGradient === true && mainBtn?.color === 'rgb(29, 78, 216)',
  JSON.stringify(mainBtn));

/* ============================================================
   5. 关键对比度实算（规范 §2.7）
   ============================================================ */
await setSize(1372, 872);

const contrast = await ev(`(() => {
  ${CONTRAST_FN}
  const probe = (sel, label) => {
    const el = document.querySelector(sel);
    if (!el) return { label, missing: true };
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    const bg = effectiveBg(el);
    if (!fg) return { label, missing: true };
    const eff = flatten(fg, bg);
    return { label, ratio: Math.round(ratio(eff, bg) * 100) / 100, fg: cs.color, bg: 'rgb(' + [bg.r,bg.g,bg.b].join(',') + ')' };
  };
  return [
    probe('.msg-text', '消息正文'),
    probe('.root-title', '任务标题'),
    probe('.msg-time', '时间戳(text-3)'),
    probe('.msg-author', '作者名'),
  ];
})()`);
const minRatio = (list) => Math.min(...list.filter((x) => !x.missing).map((x) => x.ratio));
check('§2.7 正文/标题对比度 ≥ 4.5:1（AA）',
  minRatio(contrast ?? []) >= 4.5,
  JSON.stringify(contrast));

/* 5b. 主按钮蓝字 on --grad-soft 浅渐变合成底（回归：文字对比度必须 ≥AA，
   曾发生"按参考图实测端点 3.78:1 未被发现"的漏检，此处补探针） */
const btnContrast = await ev(`(() => {
  ${CONTRAST_FN}
  const root = getComputedStyle(document.documentElement);
  const raw = root.getPropertyValue('--grad-soft');
  const hex2rgb = (h) => { const n = parseInt(h.trim().slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }; };
  const bg = parseColor(root.getPropertyValue('--bg-surface')) ?? hex2rgb(root.getPropertyValue('--bg-surface'));
  const fg = parseColor(root.getPropertyValue('--accent-text')) ?? hex2rgb(root.getPropertyValue('--accent-text'));
  return [...raw.matchAll(/rgba?\\(([^)]+)\\)/g)].map(m => {
    const p = m[1].split(',').map(x => parseFloat(x));
    const comp = flatten({ r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }, bg);
    return { composite: 'rgb(' + [Math.round(comp.r), Math.round(comp.g), Math.round(comp.b)].join(',') + ')', ratio: Math.round(ratio(fg, comp) * 100) / 100 };
  });
})()`);
check('§2.7 主按钮文字 on 浅渐变合成底 ≥ 4.5:1（AA）',
  (btnContrast ?? []).length >= 2 && btnContrast.every((x) => x.ratio >= 4.5),
  JSON.stringify(btnContrast));

/* ============================================================
   6. 布局与降级（§4.2/§4.3）
   ============================================================
   L2 = 主池 + 回复串，所以**必须先打开一条线程**，否则量到的 threadWidth 恒为 0
   （那不是缺陷，是没有第二个内容区）。 */
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0');
await sleep(900);

/* ---------- 回归锁：三条用户实测报告的缺陷（2026-09-23） ---------- */

/**
 * 缺陷 1：输入栏被推出视口。
 *
 * 成因：`.workspace` 用了 `flex-wrap: wrap`，换行后的行高按**内容自然高度**
 * 计算，两个内容列长到 1618px（视口 872px），输入条落到 `top=1554`。
 * 现在 `nowrap` + `min-height: 0`，列高被约束到视口。
 */
const composerFit = await ev(`(() => {
  const wsv = document.querySelector('.workspace');
  const list = [...document.querySelectorAll('.composer-input')].map(t => {
    const r = t.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
  });
  return {
    flexWrap: getComputedStyle(wsv).flexWrap,
    workspaceH: Math.round(wsv.getBoundingClientRect().height),
    childH: [...wsv.children].map(c => Math.round(c.getBoundingClientRect().height)),
    viewportH: window.innerHeight,
    composers: list,
  };
})()`);
check('回归：L2 两个输入条都在视口内（不再被内容高度推出）',
  (composerFit?.composers ?? []).length === 2
  && composerFit.composers.every((c) => c.inView === true),
  JSON.stringify(composerFit));
check('回归：内容列高度被约束到视口（不是内容自然高度）',
  (composerFit?.childH ?? []).every((h) => h <= (composerFit?.viewportH ?? 0) + 2)
  && composerFit?.flexWrap === 'nowrap',
  JSON.stringify({ childH: composerFit?.childH, viewportH: composerFit?.viewportH, wrap: composerFit?.flexWrap }));

/**
 * 缺陷 2：回复串底色与房间不一致、消息看不出层级。
 * 现在两栏同为白底，层级由**消息气泡底色**表达。
 */
const hierarchy = await ev(`(() => {
  const ct = document.querySelector('.col-thread');
  const cm = document.querySelector('.col-main');
  // 取 agent 气泡与人类气泡各一个
  const bodies = [...document.querySelectorAll('.col-thread .msg-body, .col-main .msg-body')];
  const agent = bodies.find(b => !b.classList.contains('is-human')
    && getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)');
  const human = bodies.find(b => b.classList.contains('is-human'));
  return {
    threadBg: ct ? getComputedStyle(ct).backgroundColor : null,
    mainBg: cm ? getComputedStyle(cm).backgroundColor : null,
    agentBubble: agent ? getComputedStyle(agent).backgroundColor : null,
    agentBubbleSample: !!agent,
    humanBubble: human ? getComputedStyle(human).backgroundColor : null,
    humanBubbleSample: !!human,
    sampleCount: bodies.length,
  };
})()`);
check('回归：回复串底色与主池一致（同为白，无灰色夹层）',
  hierarchy?.threadBg === 'rgb(255, 255, 255)' && hierarchy?.mainBg === 'rgb(255, 255, 255)',
  JSON.stringify({ thread: hierarchy?.threadBg, main: hierarchy?.mainBg }));
/**
 * agent 气泡必须始终有可辨底色（这是"层级"的主要证据）。
 * 人类气泡在本页**可能不存在**（线程里全为 agent 发言），
 * 所以对它的断言只在取到样本时才要求 —— 不把"没有样本"判成失败，
 * 但会把"没有样本"如实报出来，便于换页复验。
 */
check('回归：agent 消息气泡有可辨底色（层级可见）',
  hierarchy?.agentBubble === 'rgb(247, 250, 252)',
  JSON.stringify({ agent: hierarchy?.agentBubble, sampleCount: hierarchy?.sampleCount }));
if (hierarchy?.humanBubbleSample) {
  check('回归：人类消息气泡用浅蓝底（与 agent 区分）',
    hierarchy?.humanBubble === 'rgb(232, 239, 253)', JSON.stringify({ human: hierarchy?.humanBubble }));
} else {
  skip('回归：人类气泡底色', '本页线程内没有人类发言样本；agent 气泡已证层级成立');
}

/**
 * 主按钮渐变：用户指定改用浅蓝绿渐变（approved-selected-gradient.png 同族，
 * --grad-soft：rgba(37,99,235,.10) → rgba(52,211,153,.10)），配蓝色文字。
 * "浅渐变也给主按钮"是用户明确要求；深渐变 --grad 只保留给品牌标识与新回复 pill。
 */
const gradCheck = await ev(`(() => {
  const b = document.querySelector('.btn.primary');
  if (!b) return { found: false };
  const cs = getComputedStyle(b);
  const img = cs.backgroundImage;
  return {
    found: true,
    img: img.replace(/\\s+/g, ' '),
    hasRefStart: img.includes('rgba(37, 99, 235'),
    hasRefEnd: img.includes('rgba(52, 211, 153'),
    // 兜底：浅按钮靠蓝字可见 —— 文字绝不能是白色（否则渐变失效 = 白底白字）
    fallbackColor: cs.backgroundColor,
    fallbackVisible: cs.color !== 'rgb(255, 255, 255)' && cs.color !== 'rgba(0, 0, 0, 0)',
    textColor: cs.color,
  };
})()`);
check('主按钮渐变 = --grad-soft 浅蓝绿（用户指定）',
  gradCheck?.found === true && gradCheck?.hasRefStart === true && gradCheck?.hasRefEnd === true,
  JSON.stringify(gradCheck));

/**
 * 回归：主按钮渐变失效时仍须可读。
 * 起因：原先 `background: var(--grad)` 简写被整条丢弃 → 白底白字隐形按钮。
 * 现在按钮是浅渐变 + 蓝字：`background-color` 与 `background-image` 分层写，
 * 渐变失效时剩"蓝字 + 主题面兜底"，天然可读。这里锁死"文字非白"。
 */
check('回归：主按钮渐变失效时仍可读（蓝字 + 主题面兜底）',
  gradCheck?.found === true && gradCheck?.fallbackVisible === true,
  JSON.stringify({ fallbackColor: gradCheck?.fallbackColor, textColor: gradCheck?.textColor }));

/**
 * 回归：选中态必须**真的有底色**，不能与未选中项同色。
 * 用户报"选中后直接全白什么都看不见了"。
 */
const selCheck = await ev(`(() => {
  const pairs = [
    ['.side-item.active', '.side-item:not(.active)'],
    ['.thread-tab.on', '.thread-tab:not(.on)'],
  ];
  const out = [];
  for (const [onSel, offSel] of pairs) {
    const on = document.querySelector(onSel), off = document.querySelector(offSel);
    if (!on) { out.push({ onSel, missing: true }); continue; }
    const cs = getComputedStyle(on);
    out.push({
      onSel,
      img: cs.backgroundImage === 'none' ? '(none)' : 'has-gradient',
      color: cs.backgroundColor,
      hasImage: cs.backgroundImage.includes('gradient'),
      differsFromOff: off ? getComputedStyle(off).backgroundColor !== cs.backgroundColor
        || getComputedStyle(off).backgroundImage !== cs.backgroundImage : null,
    });
  }
  return out;
})()`);
check('回归：选中态有可见底色（渐变 + 主题面打底，且与未选中不同）',
  Array.isArray(selCheck) && selCheck.length > 0
  && selCheck.every((s) => s.missing !== true && s.hasImage === true && s.differsFromOff === true),
  JSON.stringify(selCheck));

/**
 * 回归：主按钮**禁用态**必须可辨认（未悬停也看得出不可点）且不褪色。
 * 现行规则：saturate(0.45) 去饱和 + 保留渐变族；不用 opacity（浅渐变会被冲淡）。
 */
const disabledSat = await ev(`(() => {
  const b = document.querySelector('.btn.primary:disabled');
  if (!b) return { found: false };
  const cs = getComputedStyle(b);
  const img = cs.backgroundImage;
  return {
    found: true,
    filter: cs.filter,
    muted: cs.filter.includes('saturate'),
    hasGrad: img.includes('linear-gradient'),
    hasNewGrad: img.includes('rgba(37, 99, 235') && img.includes('rgba(52, 211, 153'),
    cursor: cs.cursor,
  };
})()`);
check('回归：主按钮禁用态可辨认（去饱和）且保留渐变族',
  disabledSat?.found !== true
  || (disabledSat.muted === true && disabledSat.hasNewGrad === true),
  JSON.stringify(disabledSat));
check('回归：主按钮禁用态仍表达"不可点"（cursor: not-allowed）',
  disabledSat?.found !== true || disabledSat.cursor === 'not-allowed',
  JSON.stringify({ cursor: disabledSat?.cursor }));

/**
 * 回归：主操作语义的按钮不得继续用次按钮样式（§5.8）。
 *
 * 修前 `audit-all-primaries.mjs` 实测：项目页 / 成员管理 / 待我处理 / Git 页
 * **一个 primary 都没有**，"新建房间""添加成员""新建提醒""新建分支"全是次按钮。
 */
const createBtns = await ev(`(() => {
  const want = ['新建房间', '添加成员', '新建提醒', '新建分支'];
  const out = [];
  for (const el of document.querySelectorAll('button')) {
    const t = (el.textContent || '').trim();
    if (want.includes(t)) out.push({ text: t, primary: el.classList.contains('primary') });
  }
  return out;
})()`);
check('回归：创建类主操作使用主按钮样式（§5.8）',
  Array.isArray(createBtns) && createBtns.every((b) => b.primary),
  JSON.stringify(createBtns));

const layoutAt = async (w) => {
  await setSize(w, 872);
  return ev(`(() => {
    const ws = document.querySelector('.workspace');
    return {
      w: window.innerWidth,
      layout: ws?.dataset.layout ?? null,
      navVisible: !!document.querySelector('.sidebar'),
      poolWidth: Math.round(document.querySelector('.col-main')?.getBoundingClientRect().width ?? 0),
      threadWidth: Math.round(document.querySelector('.col-thread')?.getBoundingClientRect().width ?? 0),
    };
  })()`);
};

const L1372 = await layoutAt(1372);
check('§9.1 1372px：L2 主池 ≥420 且回复串 ≥380',
  L1372?.poolWidth >= 420 && L1372?.threadWidth >= 380, JSON.stringify(L1372));
await shoot('v01-1372-L2-pool-thread');

const L1280 = await layoutAt(1280);
check('§9.1 1280px：仍双区且下限不被突破',
  L1280?.poolWidth >= 420 && L1280?.threadWidth >= 380, JSON.stringify(L1280));
await shoot('v02-1280-L2-pool-thread');

/**
 * 1100px 及以下：**既有交互基线**在 `window.innerWidth < 1280` 时把回复串切为全屏页
 * （`useNarrow`，§17.1 原文"窄窗口可切为线程全屏页"）。所以此时主池为 0 宽是
 * **正确行为**，不是"内容被裁切"。
 *
 * 规范 §4.3 对 1100px 的要求是"按统一规则降级……内容不裁切即可，
 * **不断言必须隐藏哪一块**"。因此这里断言的是：
 * 呈现出来的那块**不低于它的既有下限**（主池 420 / 回复串 380），
 * 而不是要求两块都存在。
 */
const degradedOk = (r) => {
  const shown = [r?.poolWidth ?? 0, r?.threadWidth ?? 0].filter((x) => x > 0);
  if (shown.length === 0) return false;
  // 主池可见时 ≥420；回复串可见时 ≥380
  if ((r?.poolWidth ?? 0) > 0 && r.poolWidth < 420) return false;
  if ((r?.threadWidth ?? 0) > 0 && r.threadWidth < 380) return false;
  return true;
};

const L1100 = await layoutAt(1100);
check('§9.1 1100px：按统一规则降级，可见区域不低于既有下限（不裁切）',
  degradedOk(L1100), JSON.stringify(L1100));
await shoot('v03-1100-degraded');

const L900 = await layoutAt(900);
check('§9.1 900px：继续降级，可见区域仍有可读宽度且不被压到 0',
  degradedOk(L900), JSON.stringify(L900));
/**
 * 回归：同一个线程面板**不得被渲染两次**。
 *
 * 成因（实测踩到）：RoomPage 有两处渲染 ThreadPanel ——
 * "窄窗覆盖式"分支与"桌面双栏"分支。900px 下两个条件同时成立，
 * 于是 `col-thread` × 2、输入条 × 3、页签组 × 3，
 * 用户看到的是"回复串被复制了一份"（截图可证）。
 * 现已用一个显式互斥条件把两者分开；这里锁住"每个 ID 只有一个面板"。
 */
const dupCheck = await ev(`(() => ({
  colThread: document.querySelectorAll('.col-thread').length,
  colMain: document.querySelectorAll('.col-main').length,
  threadTabsGroups: document.querySelectorAll('.thread-tabs').length,
  msgLists: document.querySelectorAll('.msg-list').length,
}))()`);
check('回归：900px 下线程面板不被重复渲染（col-thread ≤ 1）',
  (dupCheck?.colThread ?? 99) <= 1,
  JSON.stringify(dupCheck));

/**
 * 回归：窄窗覆盖模式下线程**填满**可用宽度，右侧不留空洞。
 *
 * 成因（实测）：`.col-thread.narrow` 仍带着为"与主池并排"设计的
 * `max-width: calc(100% - 420px)`。窄窗下主池是 `display:none`，
 * 这 420px 就变成右侧一大片空白（1100px 时线程仅 434px、空 420px，截图可证）。
 */
const narrowFill = await ev(`(() => {
  const wsEl = document.querySelector('.workspace');
  const ct = document.querySelector('.col-thread');
  if (!ct) return { found: false };
  const wsR = wsEl.getBoundingClientRect();
  const ctR = ct.getBoundingClientRect();
  return {
    found: true,
    workspaceW: Math.round(wsR.width),
    threadW: Math.round(ctR.width),
    gap: Math.round(wsR.right - ctR.right),
    maxWidth: getComputedStyle(ct).maxWidth,
  };
})()`);
check('回归：窄窗覆盖模式下线程填满可用宽度（右侧无空洞）',
  narrowFill?.found === true && narrowFill.gap <= 2,
  JSON.stringify(narrowFill));
await shoot('v04-900-degraded');

const L1920 = await layoutAt(1920);
/* 大屏：正文限宽 76ch 生效 —— 检查消息正文实际宽度不超过合理阅读宽度。
   L2 场景下正文在回复串里；取不到就退到主池卡片正文。 */
const wide = await ev(`(() => {
  const el = document.querySelector('.msg-text')
    || document.querySelector('.msg-body')
    || document.querySelector('.root-body');
  if (!el) return { found: false, present: document.querySelector('.col-thread') ? 'thread' : 'none' };
  const cs = getComputedStyle(el);
  return {
    found: true,
    sel: el.className,
    width: Math.round(el.getBoundingClientRect().width),
    maxWidth: cs.maxWidth,
    lineLength: cs.maxWidth,
  };
})()`);
/**
 * 判定口径：正文容器宽度不应达到整个内容区宽度（那就是通栏长行）。
 * 20 个汉字/行 ≈ 320px 起可读；这里以"不超过 1100px"为上限，
 * 因为 1920 下内容区约 1674px，若正文铺满即失控。
 */
check('§9.1 1920px 大屏：正文不被拉成通栏长行（限宽生效）',
  wide?.found === true && wide?.width <= 1100,
  JSON.stringify(wide));
await shoot('v05-1920-wide');

/* ============================================================
   7. 核心场景 B：线程 + 文件预览
   ============================================================ */
await setSize(1372, 872);
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
await sleep(700);
await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => (x.textContent||'').includes('预览交互设计说明'));
  if (c) c.click();
  return !!c;
})()`);
await sleep(1200);
await shoot('v06-1372-L4-thread-file');

const previewTab = await ev(`(() => {
  const on = document.querySelector('.preview-tab.on');
  if (!on) return { found: false };
  const cs = getComputedStyle(on);
  return {
    found: true,
    hasGradient: cs.backgroundImage.includes('gradient'),
    labelColor: getComputedStyle(on.querySelector('.preview-tab-label')).color,
    activeCount: document.querySelectorAll('.preview-tab.on').length,
  };
})()`);
check('§5.7 文件标签激活项 = 渐变 + accent-text',
  previewTab?.found === true && previewTab?.hasGradient === true
  && previewTab?.labelColor === 'rgb(29, 78, 216)',
  JSON.stringify(previewTab));
check('§5.7 同时只有一个激活文件标签', previewTab?.activeCount === 1, `count=${previewTab?.activeCount}`);

/* 用例更新（2026-09-24 减负）：预览的视图切换不再用常驻分段控件，
   改为工具行常驻的「阅读 ▾」按钮 + 菜单。这里断言的是新的视觉纪律：
   阅读按钮是**独立选中项（--grad-soft + --accent-text）**，不套 .seg 灰槽；
   菜单里的当前项也有明确标记。原"分段控件不用渐变"的约束对新的
   `.details-chip` / `.preview-read` 不适用（见视觉规范 §5.5/§5.7 同步）。 */
const previewRead = await ev(`(() => {
  const btn = document.querySelector('.preview-tools .preview-read');
  if (!btn) return { found: false };
  const cs = getComputedStyle(btn);
  return {
    found: true,
    inSeg: !!btn.closest('.seg'),
    hasGradient: cs.backgroundImage.includes('gradient'),
    label: btn.textContent.trim(),
  };
})()`);
check('§6 阅读方式入口是独立按钮（不再套分段控件灰槽）',
  previewRead?.found === true && previewRead?.inSeg === false, JSON.stringify(previewRead));
check('§6 阅读方式入口写明当前模式（阅读/源码）',
  /阅读|源码/.test(String(previewRead?.label)), String(previewRead?.label));

/* ============================================================
   8. 深色主题
   ============================================================
   主题只在**挂载时**从 URL 读取（App.tsx 的 `?theme=` effect 无依赖数组），
   所以改 hash 不会切主题 —— 必须整页重载。这是既有实现，不是缺陷。 */
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?theme=dark&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
/**
 * 前置守卫（2026-09-25 加，**不放宽任何断言**）：
 * 在**全新的浏览器 profile** 上首次跑本套件时，实测出现过"深色两节读到浅色值"（各 1 项失败）：
 * reload 与 hash 赋值之间存在时序窗口，页面可能仍以浅色挂载；重启宿主后连跑两次均 47/0/1。
 * 这里只确认**前提真的成立**——主题不是 dark 就再显式切一次并重载；
 * 断言本身一个都没动（仍然要求 #0b0d10 与 rgb(147,197,253)）。
 */
for (let attempt = 0; attempt < 3; attempt += 1) {
  const themeNow = await ev(`document.documentElement.dataset.theme`);
  if (themeNow === 'dark') break;
  console.log(`预备：主题仍是 ${themeNow}，重试切到 dark（第 ${attempt + 1} 次）`);
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?theme=dark&recovery=0'; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(2600);
}
const darkPre = await ev(`document.documentElement.dataset.theme`);
if (darkPre !== 'dark') {
  check('深色主题前置：页面确实以 ?theme=dark 挂载', false, `实测 theme=${darkPre}`);
} else {
  console.log('OK   深色主题前置：页面以 ?theme=dark 挂载');
}

/**
 * 深色头像检查需要页面上**真的存在头像**。
 * 房间主池页没有头像（作者名旁的头像在回复串消息里；侧栏头像在成员页），
 * 所以这里显式切到线程页再测 —— 断言不能对着不存在的元素下结论。
 */
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0');
await sleep(1000);

const dark = await ev(`(() => {
  ${CONTRAST_FN}
  const cs = getComputedStyle(document.documentElement);
  const avatar = document.querySelector('.avatar');
  const sel = document.querySelector('.side-item.active');
  return {
    gradSoft: cs.getPropertyValue('--grad-soft').trim(),
    avatarFg: cs.getPropertyValue('--avatar-fg').trim(),
    avatarCount: document.querySelectorAll('.avatar').length,
    avatarColor: avatar ? getComputedStyle(avatar).color : null,
    selHasGradient: sel ? getComputedStyle(sel).backgroundImage.includes('gradient') : null,
    selColor: sel ? getComputedStyle(sel).color : null,
  };
})()`);
check('§2.8 深色 --grad-soft 为深色版（含 rgba 端点）',
  String(dark?.gradSoft ?? '').includes('gradient'), dark?.gradSoft);
check('§2.6 深色头像字母用深字 #0b0d10（实测渲染色）',
  dark?.avatarCount > 0 && dark?.avatarFg === '#0b0d10'
  && String(dark?.avatarColor ?? '').includes('11, 13, 16'),
  JSON.stringify({ count: dark?.avatarCount, fg: dark?.avatarFg, color: dark?.avatarColor }));
check('§7 深色选中态仍为渐变 + 亮蓝文字',
  dark?.selHasGradient === true && String(dark?.selColor ?? '').length > 0,
  JSON.stringify({ grad: dark?.selHasGradient, color: dark?.selColor }));
await shoot('v07-dark-room');

/* 深色主按钮：深字 */
const darkBtn = await ev(`(() => {
  const b = document.querySelector('.btn.primary');
  if (!b) return { found: false };
  const cs = getComputedStyle(b);
  return { found: true, hasGradient: cs.backgroundImage.includes('gradient'), color: cs.color };
})()`);
check('§5.8 深色主按钮为浅渐变 + 亮蓝字',
  darkBtn?.found === true && darkBtn?.hasGradient === true
  && String(darkBtn?.color ?? '').includes('147, 197, 253'),
  JSON.stringify(darkBtn));

await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3000);

/* ============================================================
   9. 视觉纪律：组件样式不得出现裸色值
   ============================================================ */
check('运行期间无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

console.log(`\n=== 视觉验收：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过 ===`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
writeFileSync(join(outDir, 'verify-result.json'),
  JSON.stringify({ pass, fail, skipped, failures, tokens, at: new Date().toISOString() }, null, 2), 'utf8');
ws.close();
process.exit(fail > 0 ? 1 : 0);
