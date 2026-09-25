/**
 * 验证：输入框下方那一整行状态条已去掉，
 * 且被去掉的信息（模式、预算、跟进/发起语义）没有丢，改到了输入框内。
 */
const PORT = '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const p = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && p.has(m.id)) {
    p.get(m.id)(m);
    p.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => {
      p.delete(i);
      res({});
    }, 10000);
    p.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

await ev(`window.zhongshuo?.window.show()`);
await sleep(400);
/* 整页重载拿干净会话：本脚本连的是常驻 Electron 窗口，前序脚本可能留下
   "讨论模式"或某个未关闭的菜单（实测过一次：`menus.at(-1)` 抓到的是侧栏项目菜单，
   导致误报）。重载后 composer 回到任务模式，断言才有确定性。 */
await ev(`location.hash='#/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0'; location.reload(); true`);
await sleep(3000);

const probe = await ev(`
  (() => {
    const th = document.querySelector('.col-thread .composer');
    const main = document.querySelector('.col-main .composer');
    return {
      线程状态行还在: !!th?.querySelector('.composer-status'),
      主池状态行还在: !!main?.querySelector('.composer-status'),
      线程placeholder: th?.querySelector('.composer-input')?.placeholder,
      主池placeholder: main?.querySelector('.composer-input')?.placeholder,
      线程有预算chip: !!th?.querySelector('.composer-budget'),
      主池有预算chip: !!main?.querySelector('.composer-budget'),
      主池预算文本: main?.querySelector('.composer-budget')?.textContent?.trim(),
      线程高度: Math.round(th?.getBoundingClientRect().height ?? 0),
      主池高度: Math.round(main?.getBoundingClientRect().height ?? 0),
    };
  })()
`);

check('底部状态行已从线程输入框移除', probe?.线程状态行还在 === false);
check('底部状态行已从主池输入框移除', probe?.主池状态行还在 === false);
check('发起/跟进语义移到 placeholder（线程）',
  String(probe?.线程placeholder).includes('跟进'),
  probe?.线程placeholder);
/**
 * 用例迁移（2026-09-25「默认交给 AI」）：输入区文案改为
 * 「发送消息，可 @ 指定成员…」（不再写"发布新任务 · 模式"）——
 * 因为常驻的「任务/讨论」切换被移除，方式由 @ 结构推导、在 ⋯ 菜单里可见。
 * 断言的**能力**不变：普通发送的语义与本次方式都必须能在发送前看到。
 */
check('发起语义移到 placeholder（主池）',
  String(probe?.主池placeholder).includes('发送消息') && String(probe?.主池placeholder).includes('@'),
  probe?.主池placeholder);
/* 方式仍在发送前可见：打开 ⋯ 菜单读「本次方式」 */
const modeLine = await ev(`(async () => {
  const b = [...document.querySelectorAll('.col-main .composer button')]
    .find((x) => (x.getAttribute('aria-label') || '') === '本次运行设置');
  b?.click();
  await new Promise((r) => setTimeout(r, 350));
  const m = [...document.querySelectorAll('.menu')].at(-1);
  const line = [...(m?.querySelectorAll('.menu-note .row.tight') ?? [])]
    .map((x) => x.innerText.trim()).find((t) => t.startsWith('本次方式')) ?? '';
  document.querySelector('.menu-scrim, .scrim')?.click();
  return line;
})()`);
check('本次方式仍在发送前可查（⋯ → 本次运行设置）',
  /本次方式：/.test(String(modeLine)),
  String(modeLine));
/* 用例更新（2026-09-24 减负 §6.1）：无 @ 的普通任务（AUTO）不再在输入区常驻
   预算明细，明细改在「本次运行设置」里查（下面单独断言它确实可查）；
   DELIBERATE 研讨仍常驻"最多 N 次"，E12 不变。 */
check('普通任务不再常驻预算明细（收进「本次运行设置」）',
  probe?.主池有预算chip === false,
  `主池预算chip=${probe?.主池有预算chip}`);
check('两个输入条仍然等高',
  probe?.线程高度 === probe?.主池高度,
  `${probe?.线程高度} vs ${probe?.主池高度}`);

/* ---------- 减负后的预算可见性（2026-09-24 施工任务书 §6.1） ----------
   口径变化：DELIBERATE 多成员研讨继续在输入区常驻"最多 N 次"（E12 不变）；
   普通任务（AUTO/DIRECT）的明细收进「本次运行设置」，只在超限/接近上限时显式提示。
   两条都要断言，避免"收进菜单"变成"信息丢失"。 */
// ① 普通任务（无 @ = AUTO）：输入区不再常驻明细，但「本次运行设置」里能查到
await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(200);
await ev(`
  (() => {
    const btn = document.querySelector('.col-main .composer-toolbar button[aria-label="本次运行设置"]');
    if (btn) btn.click();
    return !!btn;
  })()
`);
await sleep(400);
const runSettings = await ev(`
  (() => {
    const menus = [...document.querySelectorAll('.menu')];
    // 明确挑"本次运行设置"那个菜单，而不是"最后一个"：
    // 页面上可能同时存在侧栏项目菜单等其它浮层（实测误报来源）。
    const m = menus.find((x) => x.innerText.includes('本次运行设置')) ?? menus.at(-1);
    return { opened: !!m, text: (m?.innerText ?? '').replace(/\\n/g, ' | ') };
  })()
`);
check('「本次运行设置」可从输入区打开',
  runSettings?.opened === true && String(runSettings?.text).includes('本次运行设置'),
  runSettings?.text?.slice(0, 80));
check('普通任务的预算推导明细在「本次运行设置」里可查（不是删除）',
  /预算/.test(String(runSettings?.text)) && /(AUTO|自动)/.test(String(runSettings?.text)),
  runSettings?.text?.slice(0, 120));
await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(250);

// ② DELIBERATE（@全体）：输入区继续常驻"最多 N 次"
await ev(`
  (() => {
    const btn = [...document.querySelectorAll('.col-main .composer-toolbar .icon-btn')]
      .find(b => (b.getAttribute('title') || '').includes('提及'));
    if (btn) btn.click();
    return !!btn;
  })()
`);
await sleep(350);
await ev(`
  (() => {
    const item = [...document.querySelectorAll('.mention-pop .menu-item')].find(x => x.textContent.includes('全体'));
    if (item) item.click();
    return !!item;
  })()
`);
await sleep(450);
const deliberate = await ev(`
  (() => {
    const chip = document.querySelector('.col-main .composer-budget');
    return { exists: !!chip, text: chip?.textContent?.trim() ?? '', placeholder: document.querySelector('.col-main .composer-input')?.placeholder ?? '' };
  })()
`);
check('DELIBERATE 研讨仍在发送前显示推导上限（E12）',
  deliberate?.exists === true && /最多\s*\d+\s*次/.test(String(deliberate?.text)),
  `${deliberate?.text} / ${deliberate?.placeholder?.slice(0, 30)}`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
