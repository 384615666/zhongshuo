/**
 * 应用设置「版式与信息架构整理」专项回归（任务书 §6 验收 1—10）。
 *
 * 覆盖：
 *  · §3.1 七类骨架与旧深链逐条可达（app/lan/archive/archived/diagnostics/errors/reminders/runtimes）；
 *  · §2.3 归档嵌入模式：只有一个标题、筛选与清除筛选**不跳出设置页**；
 *  · §2.4 控制项如实：日志保留是真实可选值、仅模拟的控件有标注；
 *  · §2.5 开发材料降级：内部编号与验证等级不在正文、导航脚注已删；
 *  · §2.6 危险分级：通用分区不再有常驻橙色块、重置原型数据在「原型工具」折叠组里；
 *  · §3.2 通知：能展示并模拟修改、与房间订阅同一份状态（从房间改、设置里看得到）；
 *  · §3.3 外部 AI 连接：创建 → 查看/改范围 → 吊销 全流程，列表三项齐、明标后台未接入；
 *  · §2.1/§2.2 版式：六档宽度逐档实测（无水平溢出、标签与控件不重叠）、当前值用独立值列。
 *
 * 需要带调试端口的桌面客户端：`pnpm run desktop:debug`（默认 9333）。
 * 端口约定见 README：不要与浏览器用例的 9334+ 混用。
 */
import { existsSync } from 'node:fs';

const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { p.delete(i); res({}); }, 20000);
  p.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 240) };
  return r.result?.result?.value;
};
const go = async (h, wait = 1500) => { await ev(`location.hash=${JSON.stringify(h + (h.includes('?') ? '&' : '?') + 'recovery=0')}; true`); await sleep(wait); };
const clickText = async (sel, text) => ev(`
  (() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.innerText.trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()
`);
/** 用原生 setter 写 input/select，再派发事件 —— 直接改 value 不触发 React onChange */
const setField = async (sel, value) => ev(`
  (() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return true;
  })()
`);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`OK   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `  —— ${detail}` : ''}`); }
};

/* ---------------- 启动到干净状态 ---------------- */
await ev(`window.zhongshuo?.window.show()`);
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/welcome?recovery=0'; true`);
await sleep(400);
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
await ev(`window.zhongshuo?.window.show()`);
await sleep(600);
await ev(`
  (() => {
    const m = document.querySelector('.modal');
    if (!m) return false;
    const b = [...m.querySelectorAll('.btn')].find(x => /暂不处理|关闭|取消/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(400);

/* ============================================================
   §3.1 七类骨架
   ============================================================ */
console.log('\n-- §3.1 七类骨架与分区标题 --');
await go('/settings');
const nav = await ev(`
  (() => {
    const n = document.querySelector('.settings-nav');
    return {
      分区: n ? [...n.querySelectorAll('.settings-nav-text')].map(e => e.innerText.trim()) : [],
      当前: n ? [...n.querySelectorAll('.settings-nav-item.on .settings-nav-text')].map(e => e.innerText.trim()) : [],
      有搜索: !!n?.querySelector('.settings-search input'),
    };
  })()
`);
check('应用设置默认落在「通用」，导航树恰好七类（顺序固定）',
  JSON.stringify(nav?.分区) === JSON.stringify(['通用', '外观', '通知', 'AI 工具', '连接与设备', '数据与存储', '帮助与关于'])
    && JSON.stringify(nav?.当前) === JSON.stringify(['通用']),
  JSON.stringify(nav));
check('设置导航里有搜索框（§3.4 追加项）', nav?.有搜索 === true);

const TITLES = [
  ['general', '通用'], ['appearance', '外观'], ['notifications', '通知'],
  ['runtime', 'AI 工具'], ['connections', '连接与设备'], ['data', '数据与存储'], ['help', '帮助与关于'],
];
for (const [key, title] of TITLES) {
  await go(`/settings?section=${key}`);
  const t = await ev(`document.querySelector('.settings-section-title')?.innerText.trim() ?? null`);
  check(`分区标题：${key} → ${title}`, t === title, `标题=${JSON.stringify(t)}`);
}

/* ============================================================
   §3.4 深链兼容（一个都不许漏）
   ============================================================ */
console.log('\n-- §3.4 深链兼容 --');
for (const [url, expect] of [
  ['/settings?section=app', '通用'],
  ['/settings?section=lan', '连接与设备'],
  ['/settings?section=archive', '数据与存储'],
  ['/settings?section=archived', '数据与存储'],
  ['/settings?section=diagnostics', '帮助与关于'],
  ['/settings?section=runtime', 'AI 工具'],
]) {
  await go(url);
  const t = await ev(`document.querySelector('.settings-section-title')?.innerText.trim() ?? null`);
  check(`旧链接仍可定位：${url} → ${expect}`, t === expect, `标题=${JSON.stringify(t)}`);
}

await go('/settings?section=errors');
const errInfo = await ev(`
  (() => ({
    hash: location.hash,
    标题: document.querySelector('.settings-section-title')?.innerText.trim() ?? null,
    展开: document.querySelector('#settings-errors')?.getAttribute('aria-expanded'),
    表在: !!document.querySelector('#settings-errors')?.nextElementSibling?.querySelector('table'),
  }))()
`);
check('旧 section=errors → help 并**展开速查**（URL 真的规范化）',
  String(errInfo?.hash).includes('section=help') && String(errInfo?.hash).includes('anchor=errors')
    && errInfo?.标题 === '帮助与关于' && errInfo?.展开 === 'true' && errInfo?.表在 === true,
  JSON.stringify(errInfo));

await go('/runtimes');
check('/runtimes → /settings?section=runtime', String(await ev(`location.hash`)).includes('section=runtime'), String(await ev(`location.hash`)));

await go('/settings?section=reminders');
/* 用例更新（2026-09-26）：待我处理页头已删除，改用该页独有的范围标签 + 筛选控件做锚点 */
const rem = await ev(`
  (() => ({
    hash: location.hash,
    在待我处理页: /范围：全部可访问项目/.test(document.body.innerText) && !!document.querySelector('.page-head .seg'),
  }))()
`);
check('section=reminders 仍重定向「待我处理」（未误伤）',
  rem?.hash === '#/activity' && rem?.在待我处理页 === true, JSON.stringify(rem));

for (const [url, expect] of [
  ['/settings?section=project&projectId=proj_zs_01', '/project/proj_zs_01/settings'],
  ['/settings?section=write&projectId=proj_zs_01', '/project/proj_zs_01/settings'],
]) {
  await go(url);
  check(`项目类旧链接仍规范化到项目设置：${url}`, String(await ev(`location.hash`)).includes(expect), String(await ev(`location.hash`)));
}

/* ============================================================
   §2.3 归档嵌入模式
   ============================================================ */
console.log('\n-- §2.3 归档嵌入模式 --');
await go('/settings?section=data');
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.settings-body .section-title')].find(e => e.innerText.includes('归档管理'));
    if (t) t.scrollIntoView({ block: 'center' });
    return !!t;
  })()
`);
await sleep(600);
const embed = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const heads = [...(body?.querySelectorAll('.page-title') ?? [])].map(e => e.innerText.trim());
    const sectionTitles = [...(body?.querySelectorAll('.section-title') ?? [])].map(e => e.innerText.trim());
    return {
      页内大标题: heads,
      含归档标题次数: sectionTitles.filter(x => x.includes('归档管理')).length,
      有筛选行: !!body?.querySelector('.archive-filters'),
      项目下拉宽: Math.round(body?.querySelector('.archive-filter-project')?.getBoundingClientRect().width ?? 0),
      搜索宽: Math.round(body?.querySelector('.archive-filter-search')?.getBoundingClientRect().width ?? 0),
      卡片: [...(body?.querySelectorAll('[data-archive-project]') ?? [])].map(e => e.getAttribute('data-archive-project')),
    };
  })()
`);
check('嵌入模式只有一个「归档管理」标题，没有第二套页头',
  (embed?.页内大标题 ?? []).length === 0 && embed?.含归档标题次数 === 1,
  JSON.stringify(embed));
check('筛选行控件宽度统一（搜索与项目下拉同量级，未被拉满）',
  embed?.有筛选行 === true && embed.项目下拉宽 >= 140 && embed.项目下拉宽 <= 220 && embed.搜索宽 >= 150 && embed.搜索宽 <= 300,
  JSON.stringify({ 搜索宽: embed?.搜索宽, 项目下拉宽: embed?.项目下拉宽 }));

const hashBefore = await ev(`location.hash`);
const filtered = await ev(`
  (() => {
    const sel = document.querySelector('.archive-filter-project');
    if (!sel) return { __no: true };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'proj_zs_01');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()
`);
await sleep(700);
const afterFilter = await ev(`
  (() => ({
    hash: location.hash,
    有清除按钮: [...document.querySelectorAll('.settings-body .archive-filters .btn')].some(b => b.innerText.includes('清除项目筛选')),
    卡片: [...document.querySelectorAll('.settings-body [data-archive-project]')].map(e => e.getAttribute('data-archive-project')),
  }))()
`);
check('嵌入模式改项目筛选**不跳路由**（停留在设置页，只更新局部渲染）',
  filtered?.ok === true && afterFilter?.hash === hashBefore && afterFilter?.有清除按钮 === true,
  JSON.stringify({ filtered, afterFilter, hashBefore }));
check('筛选真的生效（只剩该项目的内容）',
  (afterFilter?.卡片 ?? []).every((x) => x === 'proj_zs_01'), JSON.stringify(afterFilter?.卡片));

const beforeClear = await ev(`location.hash`);
await clickText('.settings-body .archive-filters .btn', '清除项目筛选');
await sleep(700);
const afterClear = await ev(`
  (() => ({
    hash: location.hash,
    下拉值: document.querySelector('.archive-filter-project')?.value,
    有清除按钮: [...document.querySelectorAll('.settings-body .archive-filters .btn')].some(b => b.innerText.includes('清除项目筛选')),
  }))()
`);
check('嵌入模式「清除项目筛选」也在设置页内完成（hash 不变、回到全部）',
  afterClear?.hash === beforeClear && afterClear?.下拉值 === 'all' && afterClear?.有清除按钮 === false,
  JSON.stringify(afterClear));

await go('/archive?project=proj_zs_01');
const standalone = await ev(`
  (() => ({
    标题: document.querySelector('.page .page-head .page-title')?.innerText.trim() ?? null,
    有筛选行: !!document.querySelector('.page-filters'),
    有返回全部: document.body.innerText.includes('返回全部归档'),
    下拉值: document.querySelector('.page-filters select')?.value,
  }))()
`);
/**
 * 用例更新（2026-09-26 用户要求"界面顶部的头部去掉"）：独立 /archive 也不再有大标题与说明
 * （原来 §2.3 只要求嵌入模式去重页头）。断言改为**功能未回归**：
 * 没有重复大标题、筛选行在、项目筛选仍按 URL 生效、清除筛选按钮在。
 */
check('独立 /archive 无重复大标题（按用户要求去掉头部），但筛选行与项目筛选未回归',
  standalone?.标题 === null && standalone?.有筛选行 === true
    && standalone?.有返回全部 === true && standalone?.下拉值 === 'proj_zs_01',
  JSON.stringify(standalone));

/* ============================================================
   §2.4 控制项如实
   ============================================================ */
console.log('\n-- §2.4 可操作 vs 仅模拟 --');
await go('/settings?section=help');
const retention = await ev(`
  (() => {
    const sel = [...document.querySelectorAll('.settings-body select')].find(s => [...s.options].some(o => o.value === '30'));
    if (!sel) return { __no: true };
    return { 值: sel.value, 选项: [...sel.options].map(o => o.textContent.trim()), 行是否可点按钮: !!sel.closest('.pset-row')?.querySelector('button') };
  })()
`);
check('「日志保留」是真实可选值（下拉 7/14/30 天），不再是点击后没有入口的假按钮',
  retention?.值 === '14' && JSON.stringify(retention?.选项) === JSON.stringify(['7 天', '14 天', '30 天'])
    && retention?.行是否可点按钮 === false,
  JSON.stringify(retention));
await setField('.settings-body select', '30');
await sleep(600);
const retentionAfter = await ev(`
  (() => {
    const body = document.querySelector('.settings-body')?.innerText ?? '';
    const sel = [...document.querySelectorAll('.settings-body select')].find(s => [...s.options].some(o => o.value === '30'));
    return { 值: sel?.value, 正文含30: body.includes('保留 30 天'), 含假文案: body.includes('可在此调整') };
  })()
`);
check('改日志保留真的写入状态（正文当前值同步、且不再出现"可在此调整"的假按钮文案）',
  retentionAfter?.值 === '30' && retentionAfter?.正文含30 === true && retentionAfter?.含假文案 === false,
  JSON.stringify(retentionAfter));

await go('/settings?section=runtime');
const runtimeMarks = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const btns = [...(body?.querySelectorAll('.settings-actions button') ?? [])];
    const tags = [...(body?.querySelectorAll('.settings-actions .tag') ?? [])].map(e => e.innerText.trim());
    /* 只做提示的按钮 = 重新检测 / 连接测试；认证方式是配置入口，不该有「原型模拟」 */
    const 只提示按钮数 = btns.filter((b) => /重新检测|连接测试/.test(b.innerText)).length;
    return {
      按钮: btns.map(b => b.innerText.trim()),
      只提示按钮数,
      标记数: tags.filter(t => t.includes('原型模拟')).length,
      正文有验证等级: (body?.innerText ?? '').includes('验证等级'),
      可见C0: (body?.innerText ?? '').includes('C0'),
    };
  })()
`);
/**
 * 用例更新（2026-09-26 第二轮评审修复）：「认证方式」不再是"只弹提示"的按钮 ——
 * 它现在打开工具配置弹窗的认证项（可改、可存），因此**不需要**「原型模拟」标记。
 * 仍然只做提示的两个（重新检测 / 连接测试）必须各有一个标记。
 */
check('执行工具的「重新检测 / 连接测试」各带「原型模拟」标记，而「认证方式」是真实入口（无标记）',
  (runtimeMarks?.按钮 ?? []).length >= 3
    && runtimeMarks?.标记数 === (runtimeMarks?.只提示按钮数 ?? (runtimeMarks?.按钮 ?? []).length - 2),
  JSON.stringify(runtimeMarks));

/* C0—C4 验证记录：默认折在技术详情里，展开后可达（§2.5 + §6 验收 5） */
await go('/settings?section=runtime');
const foldClosed = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const t = body?.innerText ?? '';
    const fold = [...body.querySelectorAll('details.settings-why')].find(d => d.innerText.includes('技术详情'));
    return {
      有折叠: !!fold,
      默认关: fold ? !fold.open : null,
      正文有表内容: t.includes('C1 隔离与续接') && t.includes('2026-09-17 实测'),
      正文有开发约束: t.includes('不要调用模型 API 自建执行循环'),
      摘要有点名: t.includes('验证等级'),
    };
  })()
`);
await ev(`
  (() => {
    const fold = [...document.querySelectorAll('.settings-body details.settings-why')].find(d => d.innerText.includes('技术详情'));
    if (fold) fold.open = true;
    return !!fold;
  })()
`);
await sleep(500);
const foldOpen = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const t = body?.innerText ?? '';
    return { 展开后可达: t.includes('C1 隔离与续接') && t.includes('C2 事件与用量'), 开发约束可达: t.includes('开发约束：不要调用模型 API 自建执行循环') };
  })()
`);
check('C0—C4 验证等级与开发约束默认折进「技术详情」（正文不出现实测记录），展开后可达',
  foldClosed?.有折叠 === true && foldClosed?.默认关 === true && foldClosed?.正文有表内容 === false
    && foldClosed?.摘要有点名 === true && foldOpen?.展开后可达 === true && foldOpen?.开发约束可达 === true,
  JSON.stringify({ foldClosed, foldOpen }));

/* 「打开目录 / 复制路径」必须是真可操作项（§2.5）；浏览器宿主则如实说明限制 */
const bridge = await ev(`window.zhongshuo?.appDataDir ? window.zhongshuo.appDataDir() : null`);
const dataDir = typeof bridge === 'string' ? bridge : null;
check('桌面宿主能给出**真实存在**的应用数据目录（「打开目录」不是假按钮）',
  Boolean(dataDir) && existsSync(dataDir), String(dataDir));

await go('/settings?section=data');
const openedDir = await ev(`
  (() => {
    const btn = [...document.querySelectorAll('.settings-body .btn')].find(b => b.innerText.includes('打开目录'));
    if (!btn) return { __no: true };
    btn.click();
    return { ok: true, disabled: btn.disabled };
  })()
`);
await sleep(1600);
const openResult = await ev(`
  (() => {
    const t = document.body.innerText;
    return {
      已打开: t.includes('已在文件管理器中打开'),
      明确失败: /无法打开目录|没有系统文件管理器能力|没有提供"打开目录"能力/.test(t),
    };
  })()
`);
check('点「打开目录」走宿主的真实能力（报告"已打开"，没有用成功提示冒充）',
  openedDir?.ok === true && (openResult?.已打开 === true || openResult?.明确失败 === true),
  JSON.stringify({ openedDir, openResult }));

/**
 * 用例更新（2026-09-26 第二轮）：回执文案改为「已复制：<真实路径>」——
 * 原来无条件提示"已复制数据目录路径"（哪怕剪贴板接口不存在或写入被拒）。
 * 复制内容与失败路径的完整回归在 `verify-settings-fixes.mjs` ①。
 */
await clickText('.settings-body .btn', '复制路径');
await sleep(600);
const copyResult = await ev(`
  (() => {
    const t = document.querySelector('.toast')?.innerText ?? '';
    return { 有回执: /已复制/.test(t), 带路径: t.includes(${JSON.stringify(String(dataDir))}) };
  })()
`);
check('「复制路径」给出明确回执，且回执里带真实路径',
  copyResult?.有回执 === true && copyResult?.带路径 === true, JSON.stringify(copyResult));

/* ============================================================
   §2.5 开发材料降级与脚注删除
   ============================================================ */
console.log('\n-- §2.5 开发材料与脚注 --');
await go('/settings?section=connections');
const noM3 = await ev(`
  (() => {
    const t = document.querySelector('.settings-body')?.innerText ?? '';
    return { 含M3: t.includes('M3'), 含批次: /批次/.test(t), 含内部编号: /§\d/.test(t) };
  })()
`);
check('正文不再出现「M3 批次」这类内部编号',
  noM3?.含M3 === false && noM3?.含批次 === false && noM3?.含内部编号 === false, JSON.stringify(noM3));

await go('/settings?section=general');
const foot = await ev(`
  (() => {
    const nav = document.querySelector('.settings-nav');
    return {
      有脚注: /项目设置已独立/.test(nav?.innerText ?? ''),
      有高级操作橙块: !!document.querySelector('.settings-body .settings-advanced'),
      退出按钮类: [...document.querySelectorAll('.settings-body .btn')].filter(b => b.innerText.trim() === '退出').map(b => b.className),
      有原型模拟: (document.querySelector('.settings-body')?.innerText ?? '').includes('原型模拟'),
      有值括号: (document.querySelector('.settings-body')?.innerText ?? '').includes('（当前：'),
    };
  })()
`);
check('左导航脚注已删除（同类信息只在页头说一次）', foot?.有脚注 === false, JSON.stringify(foot));
check('通用分区不再有常驻橙色「高级操作」块；退出用 danger 按钮语义',
  foot?.有高级操作橙块 === false && (foot?.退出按钮类 ?? []).some((c) => /danger/.test(c)),
  JSON.stringify(foot));
check('只改内存模拟值的开关带「原型模拟」标记', foot?.有原型模拟 === true);
check('当前值不再塞进 label 括号（值走独立值列）', foot?.有值括号 === false, JSON.stringify(foot));

/* ============================================================
   §2.6 原型工具折叠组
   ============================================================ */
console.log('\n-- §2.6 原型工具 --');
await go('/settings?section=help');
const protoBefore = await ev(`
  (() => {
    const head = [...document.querySelectorAll('.settings-collapse-head')].find(h => h.innerText.includes('原型工具'));
    return {
      有组: !!head,
      默认展开: head?.getAttribute('aria-expanded'),
      展开后可见重置: !!head?.parentElement?.querySelector('.settings-collapse-body'),
      在页尾: head ? head.getBoundingClientRect().top > window.innerHeight * 0.5 : null,
    };
  })()
`);
check('「原型工具」在「帮助与关于」底部、默认折叠、一眼能找到',
  protoBefore?.有组 === true && protoBefore?.默认展开 === 'false' && protoBefore?.展开后可见重置 === false,
  JSON.stringify(protoBefore));
await clickText('.settings-collapse-head', '原型工具');
await sleep(500);
const protoOpen = await ev(`
  (() => {
    const head = [...document.querySelectorAll('.settings-collapse-head')].find(h => h.innerText.includes('原型工具'));
    const body = head?.parentElement?.querySelector('.settings-collapse-body');
    return { 展开: head?.getAttribute('aria-expanded'), 文本: (body?.innerText ?? '').slice(0, 120).replace(/\\n/g, ' | ') };
  })()
`);
check('展开后含「重置原型数据」与「清除导航偏好」',
  protoOpen?.展开 === 'true' && protoOpen?.文本.includes('重置原型数据') && protoOpen?.文本.includes('清除导航偏好'),
  JSON.stringify(protoOpen));

/* ============================================================
   §3.2 通知：模拟修改 + 与房间订阅同一份状态
   ============================================================ */
console.log('\n-- §3.2 通知 --');
await go('/settings?section=notifications');
const notify = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const t = body?.innerText ?? '';
    const switches = [...(body?.querySelectorAll('.switch-track') ?? [])];
    return {
      事件四类: ['需要审批', '任务失败', '任务完成', '被提及'].every(k => t.includes(k)),
      覆盖关系: t.includes('房间静音') && t.includes('线程关注') && /＞/.test(t),
      未接入真实推送: t.includes('未接入真实推送') || t.includes('没有接入真实推送'),
      不等于执行授权: t.includes('不等于执行授权'),
      完整口径: t.includes('私信') && t.includes('已加入频道'),
      开关数: switches.length,
      开态: switches.map(s => s.classList.contains('on')),
      静音线程数: [...body.querySelectorAll('.pset-row')].filter(r => r.innerText.includes('取消静音')).length,
    };
  })()
`);
check('通知分区能展示四类事件与覆盖关系，并明标未接入真实推送/不等于执行授权',
  notify?.事件四类 === true && notify?.覆盖关系 === true && notify?.未接入真实推送 === true
    && notify?.不等于执行授权 === true && notify?.完整口径 === true,
  JSON.stringify(notify));

// 点击第一个事件开关：值真的变
const before = await ev(`[...document.querySelectorAll('.settings-body .switch-track')].map(e => e.classList.contains('on'))`);
await ev(`(() => { const s = document.querySelectorAll('.settings-body .switch')[3]; if (s) s.click(); return !!s; })()`);
await sleep(600);
const after = await ev(`[...document.querySelectorAll('.settings-body .switch-track')].map(e => e.classList.contains('on'))`);
check('通知事件开关点击后真实改变值（不是只弹提示）',
  JSON.stringify(before) !== JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

/* 同一份订阅状态：从房间卡片 ⋯ 改静音 → 应用设置的通知列表里立刻看得到 */
await go('/project/proj_zs_01/room/room_dev_hall');
const openCardMenu = () => ev(`
  (() => {
    const b = document.querySelector('button[title^="更多：关注"]');
    if (!b) return false;
    b.click();
    return true;
  })()
`);
const menuState = () => ev(`
  (() => {
    const items = [...document.querySelectorAll('.menu-item')].map(x => x.innerText.trim());
    return { items: items.slice(0, 6), 静音项: items.find(x => /静音/.test(x)) ?? null };
  })()
`);
const cardMenuOpened = await openCardMenu();
await sleep(600);
const beforeMenu = await menuState();
const mutedClick = await clickText('.menu-item', '静音');
await sleep(600);
await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
await sleep(300);
await openCardMenu();
await sleep(600);
const afterMenu = await menuState();
await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
await sleep(300);

await go('/settings?section=notifications');
const afterRoomMute = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const rows = [...body.querySelectorAll('.pset-row')].filter(r => r.innerText.includes('取消静音'));
    return { 静音线程数: rows.length, 行名: rows.map(r => r.querySelector('.pset-row-name')?.innerText.trim()) };
  })()
`);
check('房间卡片里静音一条线程后，应用设置的通知列表里立刻能看到它（读的是同一份 subscriptions，不另存一份）',
  cardMenuOpened === true && String(beforeMenu?.静音项).includes('静音') && mutedClick === true
    && String(afterMenu?.静音项).includes('取消静音') && (afterRoomMute?.静音线程数 ?? 0) >= 2,
  JSON.stringify({ cardMenuOpened, beforeMenu, afterMenu, mutedClick, afterRoomMute }));

/* ============================================================
   §3.3 外部 AI 连接：创建 → 查看范围 → 吊销
   ============================================================ */
console.log('\n-- §3.3 外部 AI 连接（MCP） --');
await go('/settings?section=connections');
const mcpBefore = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const t = body?.innerText ?? '';
    return {
      后台未接入: t.includes('后台尚未接入') || t.includes('原型没有 MCP 服务端'),
      三项齐: /最后活跃/.test(t) && /累计调用/.test(t) && /当前范围/.test(t),
      权限说明分开: t.includes('配对的设备拥有和本机一样的权限'),
      审批只属于用户: t.includes('审批与验收永远只属于你'),
      两端未合并: [...body.querySelectorAll('.section-title')].filter(x => /设备|外部 AI/.test(x.innerText)).length >= 2,
      连接数: body.querySelectorAll('[data-mcp-connection]').length,
    };
  })()
`);
check('MCP 分区明标「后台尚未接入」，列表含最后活跃时间/累计调用数/当前范围',
  mcpBefore?.后台未接入 === true && mcpBefore?.三项齐 === true && mcpBefore?.连接数 >= 2,
  JSON.stringify(mcpBefore));
check('设备与外部 AI 连接分组展示、权限说明分开写（未混成一张列表）',
  mcpBefore?.两端未合并 === true && mcpBefore?.权限说明分开 === true && mcpBefore?.审批只属于用户 === true,
  JSON.stringify(mcpBefore));

await clickText('.settings-body button', '创建连接');
await sleep(700);
const createOpen = await ev(`({ 弹窗: !!document.querySelector('.modal'), 标题: document.querySelector('.modal .overlay-title')?.innerText.trim() ?? null })`);
check('「创建连接」打开范围授权弹窗', createOpen?.弹窗 === true, JSON.stringify(createOpen));

await setField('.modal input', '测试用外部助手');
await sleep(300);
// 勾一个项目 + 一项操作（默认已勾 read）
await ev(`
  (() => {
    const boxes = [...document.querySelectorAll('.modal .scope-item input[type=checkbox]')];
    // 第一个是项目复选框（未勾），点它
    if (boxes[0] && !boxes[0].checked) boxes[0].click();
    return boxes[0]?.checked;
  })()
`);
await sleep(400);
const scopeState = await ev(`
  (() => {
    const boxes = [...document.querySelectorAll('.modal .scope-item input[type=checkbox]')];
    return { 勾选数: boxes.filter(b => b.checked).length, 总计: boxes.length };
  })()
`);
await clickText('.modal .btn', '创建并生成令牌');
await sleep(900);
const created = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const t = body?.innerText ?? '';
    const cl = [...body.querySelectorAll('[data-mcp-connection]')];
    return {
      弹窗已关: !document.querySelector('.modal'),
      有令牌明文: /zs_mcp_[a-z0-9]{6}/.test(t),
      已隐藏提示: t.includes('关闭后不再显示明文') || t.includes('只显示这一次'),
      连接数: cl.length,
      新连接在列表: cl.some(c => c.innerText.includes('测试用外部助手')),
    };
  })()
`);
check('创建后可走完流程：连接进入列表，令牌只显示一次（明文可见 + 关闭后不再显示）',
  created?.弹窗已关 === true && created?.有令牌明文 === true && created?.已隐藏提示 === true
    && created?.新连接在列表 === true,
  JSON.stringify(created));

const newConnRow = await ev(`
  (() => {
    const card = [...document.querySelectorAll('[data-mcp-connection]')].find(c => c.innerText.includes('测试用外部助手'));
    const t = card?.innerText ?? '';
    return {
      含最后活跃: t.includes('最后活跃'),
      含累计调用: /累计调用/.test(t),
      含当前范围: t.includes('当前范围'),
      含预算: /预算/.test(t),
      范围含项目: t.includes('众说'),
      生效中: t.includes('生效中'),
    };
  })()
`);
check('新连接卡片含最后活跃时间、累计调用数与当前范围（且范围含刚勾的项目）',
  newConnRow?.含最后活跃 === true && newConnRow?.含累计调用 === true && newConnRow?.含当前范围 === true
    && newConnRow?.范围含项目 === true && newConnRow?.生效中 === true,
  JSON.stringify(newConnRow));

// 查看 / 改范围
await ev(`
  (() => {
    const card = [...document.querySelectorAll('[data-mcp-connection]')].find(c => c.innerText.includes('测试用外部助手'));
    const b = [...(card?.querySelectorAll('button') ?? [])].find(x => x.innerText.includes('查看'));
    b?.click();
    return !!b;
  })()
`);
await sleep(700);
const scopeModal = await ev(`
  (() => {
    const modal = document.querySelector('.modal');
    return {
      开: !!modal,
      标题: modal?.querySelector('.overlay-title')?.innerText.trim() ?? null,
      四维齐: ['项目 / 房间集合', '操作集', '可调度成员', '预算上限'].every(k => (modal?.innerText ?? '').includes(k)),
      不开放命令: (modal?.innerText ?? '').includes('首批不开放的命令'),
    };
  })()
`);
/* 「首批不开放的命令」是一条折叠说明：正文只点名，展开后才列出 —— 可达性也要验 */
const notGrantableVisible = await ev(`
  (() => {
    const modal = document.querySelector('.modal');
    const t = modal?.innerText ?? '';
    return { 正文列命令: /approval\.respond/.test(t) };
  })()
`);
await ev(`
  (() => {
    const fold = [...document.querySelectorAll('.modal details.settings-why')].find(d => d.innerText.includes('首批不开放的命令'));
    if (fold) fold.open = true;
    return !!fold;
  })()
`);
await sleep(500);
const notGrantable = await ev(`
  (() => {
    const t = document.querySelector('.modal')?.innerText ?? '';
    return {
      审批: /审批与验收（approval\.respond、task\.delivery\.review）—— 永远只属于你/.test(t),
      git: t.includes('git.push'),
      成员与房间: t.includes('成员配置'),
    };
  })()
`);
check('「查看 / 改范围」弹窗含四维范围；首批不开放命令默认折起、展开后逐条可达（审批与验收永远只属于用户）',
  scopeModal?.开 === true && scopeModal?.四维齐 === true && scopeModal?.不开放命令 === true
    && notGrantableVisible?.正文列命令 === false && notGrantable?.审批 === true
    && notGrantable?.git === true && notGrantable?.成员与房间 === true,
  JSON.stringify({ scopeModal, notGrantableVisible, notGrantable }));
// 改预算后保存
await setField('.modal .pset-number', '25');
await sleep(300);
await clickText('.modal .btn', '保存范围');
await sleep(800);
const scopeSaved = await ev(`
  (() => {
    const card = [...document.querySelectorAll('[data-mcp-connection]')].find(c => c.innerText.includes('测试用外部助手'));
    return { 弹窗已关: !document.querySelector('.modal'), 卡上预算: /0 \\/ 25 次/.test(card?.innerText ?? '') };
  })()
`);
check('范围可改并写回（预算 25 次出现在列表里）',
  scopeSaved?.弹窗已关 === true && scopeSaved?.卡上预算 === true, JSON.stringify(scopeSaved));

// 吊销
await ev(`
  (() => {
    const card = [...document.querySelectorAll('[data-mcp-connection]')].find(c => c.innerText.includes('测试用外部助手'));
    const b = [...(card?.querySelectorAll('button') ?? [])].find(x => x.innerText.trim() === '吊销');
    b?.click();
    return !!b;
  })()
`);
await sleep(700);
const revokeModal = await ev(`
  (() => {
    const modal = document.querySelector('.modal');
    return {
      开: !!modal,
      说清影响: ['立即生效', '不影响的内容', '能不能恢复'].every(k => (modal?.innerText ?? '').includes(k)),
    };
  })()
`);
check('吊销前弹窗逐条说清影响（立即生效 / 不影响的内容 / 不可恢复）',
  revokeModal?.开 === true && revokeModal?.说清影响 === true, JSON.stringify(revokeModal));
await clickText('.modal .btn', '吊销连接');
await sleep(800);
const revoked = await ev(`
  (() => {
    const card = [...document.querySelectorAll('[data-mcp-connection]')].find(c => c.innerText.includes('测试用外部助手'));
    const t = card?.innerText ?? '';
    return {
      已吊销: t.includes('已吊销'),
      有删除记录: [...(card?.querySelectorAll('button') ?? [])].some(b => b.innerText.includes('删除记录')),
      无轮换: ![...(card?.querySelectorAll('button') ?? [])].some(b => b.innerText.includes('轮换')),
    };
  })()
`);
check('吊销后状态与可用操作同步变化（已吊销 / 只剩删除记录 / 不能再轮换）',
  revoked?.已吊销 === true && revoked?.有删除记录 === true && revoked?.无轮换 === true, JSON.stringify(revoked));

/* ============================================================
   §3.4 追加项：设置搜索
   ============================================================ */
console.log(String.fromCharCode(10) + '-- §3.4 设置搜索 --');

await go('/settings?section=general');
await setField('.settings-search input', '备份');
await sleep(600);
const searchHits = await ev(`
  (() => {
    const hits = [...document.querySelectorAll('.settings-search-hit')].map(e => e.innerText.split(String.fromCharCode(10)).join(' ').trim());
    return { 命中: hits, 数: hits.length };
  })()
`);
check('设置搜索能按关键词定位（输入「备份」→ 命中「备份与恢复」）',
  (searchHits?.命中 ?? []).some((h) => h.includes('备份与恢复')), JSON.stringify(searchHits));

await clickText('.settings-search-hit', '备份与恢复');
await sleep(1200);
const jumped = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const title = body?.querySelector('.settings-section-title')?.innerText.trim() ?? null;
    const flashed = document.querySelectorAll('.settings-jump-flash').length;
    const rowName = document.querySelector('.settings-jump-flash .pset-row-name, .settings-jump-flash');
    return { 标题: title, 高亮数: flashed, 落点: rowName?.innerText.trim().slice(0, 20) ?? null, 搜索框已清: document.querySelector('.settings-search input')?.value };
  })()
`);
check('搜索命中后跳到对应分区并高亮目标项（不是只改 URL）',
  jumped?.标题 === '数据与存储' && jumped?.高亮数 === 1 && String(jumped?.落点).includes('备份与恢复'),
  JSON.stringify(jumped));

const missHit = await (async () => {
  await setField('.settings-search input', '字体');
  await sleep(500);
  return ev(`
    (() => {
      const box = document.querySelector('.settings-search-results');
      return { 命中数: box?.querySelectorAll('.settings-search-hit').length ?? -1, 有说明: (box?.innerText ?? '').includes('没找到匹配') };
    })()
  `);
})();
check('搜不到时明确说"没找到"，不摆"即将支持"占位',
  missHit?.命中数 === 0 && missHit?.有说明 === true, JSON.stringify(missHit));
await setField('.settings-search input', '');
await sleep(400);

/* ============================================================
   §2.1 / §2.2 版式：六档宽度逐档实测
   ============================================================ */
console.log('\n-- §2.1 六档宽度（逐档设置并确认生效） --');
const measure = () => ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    if (!body) return { __no: true };
    const b = body.getBoundingClientRect();
    let overflow = 0;
    for (const el of body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > b.right + 1) overflow = Math.max(overflow, Math.round(r.right - b.right));
    }
    let overlap = 0;
    for (const row of body.querySelectorAll('.pset-row')) {
      const label = row.querySelector('.pset-row-label')?.getBoundingClientRect();
      const ctrl = row.querySelector('.pset-row-control')?.getBoundingClientRect();
      if (!label || !ctrl) continue;
      if (label.right > ctrl.left + 1) overlap = Math.max(overlap, Math.round(label.right - ctrl.left));
    }
    return { 视口: window.innerWidth, 正文宽: Math.round(b.width), 水平溢出: overflow, 重叠: overlap };
  })()
`);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(600);
await go('/settings?section=general');
for (const w of [1920, 1600, 1440, 1280, 1100, 900]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const m = await measure();
  check(`${w}px：正文有宽度约束、无水平溢出、标签与控件不重叠`,
    m?.视口 === w && m.正文宽 > 0 && m.正文宽 <= 900 && m.水平溢出 === 0 && m.重叠 === 0,
    JSON.stringify(m));
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

/* 窄窗长内容：展开 20 条错误码速查 + 运行记录表，不撑破布局（§6 验收 7） */
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(600);
await go('/settings?section=help');
await clickText('.settings-collapse-head', '错误码速查');
await sleep(700);
const narrowWide = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const b = body.getBoundingClientRect();
    let worst = 0;
    for (const el of body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > b.right + 1) worst = Math.max(worst, Math.round(r.right - b.right));
    }
    const wide = [...body.querySelectorAll('.settings-wide')];
    return {
      错误码行数: body.querySelectorAll('#settings-errors + div table tbody tr').length,
      运行记录行数: body.querySelectorAll('table tbody tr').length,
      超出正文宽度: worst,
      宽表独立滚动: wide.every(w => getComputedStyle(w).overflowX === 'auto'),
    };
  })()
`);
check('窄窗下长内容（错误码速查 20 条 + 运行记录表）不撑破布局、宽表自带横向滚动',
  narrowWide?.错误码行数 >= 20 && narrowWide?.超出正文宽度 === 0 && narrowWide?.宽表独立滚动 === true,
  JSON.stringify(narrowWide));
await send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

/* 值列已经在上面的断言里查过；这里补一条"共用同一个行基元" */
await go('/project/proj_zs_01/settings');
const psetShared = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.pset-row')];
    return { 行数: rows.length, 有左名称右控件: rows.every(r => !!r.querySelector('.pset-row-name')) };
  })()
`);
check('项目设置仍用同一个设置行基元（.pset-row；未 fork 第三种样式）',
  psetShared?.行数 >= 5 && psetShared?.有左名称右控件 === true, JSON.stringify(psetShared));

console.log(`\n结果：${pass}/${pass + fail} 通过${fail ? `，${fail} 条失败` : ''}`);
process.exit(fail ? 1 : 0);
