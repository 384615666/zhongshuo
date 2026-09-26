/**
 * 应用设置 · 评审复现六项回归（2026-09-26 第二轮）。
 *
 * 为什么单独一个脚本：上一轮的专项（`verify-settings-ia.mjs`）全绿，但这六条都不在它的
 * 覆盖面里 —— 负预算、小数并发、时段外免打扰、复制内容、令牌留痕、AI 工具状态合并，
 * 都是"跑一遍正常流程"发现不了的。这里逐条按评审给出的复现步骤验。
 *
 * 需要 `pnpm run desktop:debug`（9333）。
 */
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
/** 用原生 setter 写值再派发事件 —— 直接改 value 不触发 React onChange */
const setField = async (sel, value, kind = 'input') => ev(`
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

/* ---------------- 干净状态 ---------------- */
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
   ① 数据目录：显示 / 打开 / 复制共用同一个已解析值
   ============================================================ */
console.log('\n-- ① 数据目录与复制路径 --');
await go('/settings?section=data');
const dirShown = await ev(`
  (() => {
    const row = [...document.querySelectorAll('.settings-body .pset-row')].find(r => r.innerText.includes('应用数据目录'));
    return {
      显示值: row?.querySelector('.pset-value')?.innerText.trim() ?? null,
      路径框文本: row?.innerText ?? '',
    };
  })()
`);
const realDir = await ev(`window.zhongshuo?.appDataDir ? window.zhongshuo.appDataDir() : null`);
check('① 显示的是宿主返回的真实路径，不是 <appData> 占位符',
  Boolean(realDir) && dirShown?.显示值 === realDir && !String(dirShown?.路径框文本).includes('<appData>'),
  JSON.stringify({ 显示值: dirShown?.显示值, realDir }));

/** 拦下剪贴板再点「复制路径」：能核对"到底复制了什么" */
const clickCopyWith = (impl) => ev(`
  (async () => {
    const captured = [];
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: async (t) => { ${impl} } }),
    });
    const row = [...document.querySelectorAll('.settings-body .pset-row')].find(r => r.innerText.includes('应用数据目录'));
    [...row.querySelectorAll('button')].find(b => b.innerText.includes('复制路径')).click();
    await new Promise(r => setTimeout(r, 500));
    return { 写入: captured, 显示: row.querySelector('.pset-value').innerText.trim(), 提示: document.querySelector('.toast')?.innerText ?? null };
  })()
`);
const copyOk = await clickCopyWith('captured.push(t);');
check('① 「复制路径」复制的就是显示的那个目录（不是 state.sqlite、不是占位符）',
  (copyOk?.写入 ?? []).length === 1 && copyOk.写入[0] === copyOk.显示 && !String(copyOk.写入[0]).includes('<appData>'),
  JSON.stringify(copyOk));
check('① 成功回执与真实写入内容一致',
  String(copyOk?.提示 ?? '').includes('已复制') && String(copyOk?.提示 ?? '').includes(String(copyOk?.显示)),
  String(copyOk?.提示));
const copyFail = await clickCopyWith("throw new Error('拒绝写入（用例注入）');");
check('① 剪贴板写入失败时明确报错，不再无条件提示"已复制"',
  /复制失败/.test(String(copyFail?.提示)) && !/已复制/.test(String(copyFail?.提示)), String(copyFail?.提示));

/* ============================================================
   ② 令牌不进写操作留痕
   ============================================================ */
console.log('\n-- ② 令牌与写操作留痕 --');
await go('/settings?section=connections');
const rotated = await ev(`
  (async () => {
    const card = [...document.querySelectorAll('[data-mcp-connection]')].find(c => c.innerText.includes('生效中'));
    [...(card?.querySelectorAll('button') ?? [])].find(b => b.innerText.includes('轮换令牌'))?.click();
    await new Promise(r => setTimeout(r, 700));
    const token = document.querySelector('[data-mcp-token]')?.innerText.trim() ?? null;
    [...document.querySelectorAll('.settings-body .btn')].find(b => b.innerText.includes('我已保存'))?.click();
    await new Promise(r => setTimeout(r, 400));
    return { token, 面板还在: [...document.querySelectorAll('.settings-body .btn')].some(b => b.innerText.includes('我已保存')) };
  })()
`);
check('② 轮换后令牌只显示一次（点「我已保存」面板消失）',
  /^zs_mcp_[a-z0-9]{6}$/.test(String(rotated?.token)) && rotated?.面板还在 === false,
  JSON.stringify(rotated));

await go('/activity');
const leak = await ev(`
  (() => {
    const t = document.body.innerText;
    const token = ${JSON.stringify(String(rotated?.token))};
    return {
      留痕区在: /原型写入留痕/.test(t),
      令牌出现在留痕页: token && token.length > 8 ? t.includes(token) : null,
      页面里zs_mcp片段数: (t.match(/zs_mcp_[a-z0-9]{4,}/g) ?? []).length,
      有轮换留痕: /connection\\.rotated|令牌已轮换/.test(t),
    };
  })()
`);
check('② 令牌不出现在写操作留痕里（隐藏后翻页面也找不到完整令牌）',
  leak?.令牌出现在留痕页 === false && leak?.页面里zs_mcp片段数 === 0 && leak?.留痕区在 === true,
  JSON.stringify(leak));

/* ============================================================
   ③ 数量类输入必须是范围内的整数
   ============================================================ */
console.log('\n-- ③ 负预算与小数并发 --');
await go('/settings?section=connections');
const mcpCount0 = await ev(`document.querySelectorAll('[data-mcp-connection]').length`);
await clickText('.settings-body button', '创建连接');
await sleep(700);
await setField('.modal input', '校验用连接');
await ev(`(() => { const b = [...document.querySelectorAll('.modal .scope-item input[type=checkbox]')]; if (b[0] && !b[0].checked) b[0].click(); return true; })()`);
await sleep(300);

const tryBudget = async (value) => {
  await setField('.modal .pset-number', value);
  await sleep(300);
  const inline = await ev(`document.querySelector('.modal [data-scope-error]')?.innerText.trim() ?? null`);
  await clickText('.modal .btn', '创建并生成令牌');
  await sleep(600);
  const state = await ev(`
    (() => ({
      弹窗仍在: !!document.querySelector('.modal'),
      连接数: document.querySelectorAll('[data-mcp-connection]').length,
      弹窗内报错: [...document.querySelectorAll('.modal .panel.danger')].map(e => e.innerText.trim())[0] ?? null,
    }))()
  `);
  return { ...state, 行内错误: inline };
};
const negBudget = await tryBudget('-2');
check('③ 预算 -2 不写入状态：留在编辑态 + 报错，连接数不变',
  negBudget?.弹窗仍在 === true && negBudget?.连接数 === mcpCount0
    && /至少为 1 次|整数/.test(String(negBudget?.行内错误 ?? negBudget?.弹窗内报错)),
  JSON.stringify(negBudget));
const decBudget = await tryBudget('1.5');
check('③ 预算 1.5 同样被拦下（只接受整数）',
  decBudget?.弹窗仍在 === true && decBudget?.连接数 === mcpCount0
    && /整数/.test(String(decBudget?.行内错误 ?? decBudget?.弹窗内报错)),
  JSON.stringify(decBudget));
await setField('.modal .pset-number', '5');
await sleep(300);
await clickText('.modal .btn', '创建并生成令牌');
await sleep(800);
const okBudget = await ev(`
  (() => ({
    弹窗已关: !document.querySelector('.modal'),
    连接数: document.querySelectorAll('[data-mcp-connection]').length,
    新连接预算: [...document.querySelectorAll('[data-mcp-connection]')].some(c => /0 \\/ 5 次/.test(c.innerText)),
  }))()
`);
check('③ 合法整数（5）能创建，列表显示 0 / 5 次',
  okBudget?.弹窗已关 === true && okBudget?.连接数 === mcpCount0 + 1 && okBudget?.新连接预算 === true,
  JSON.stringify(okBudget));
await ev(`(() => { const b = [...document.querySelectorAll('.settings-body .btn')].find(x => x.innerText.includes('我已保存')); b?.click(); return !!b; })()`);
await sleep(300);

/* 共享 NumberField：并发数也必须是整数 */
await go('/settings?section=general');
const setCountTo = (v) => ev(`
  (() => {
    const row = [...document.querySelectorAll('.settings-body .pset-row')].find(x => x.innerText.includes('全应用同时运行的模型调用'));
    const el = row.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    /* 真实焦点 + 真实 blur：React 的 onBlur 绑在 focusout 上，合成 blur 事件不会触发提交 */
    el.focus();
    setter.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    return el.value;
  })()
`);
const readCount = () => ev(`
  (() => {
    const row = [...document.querySelectorAll('.settings-body .pset-row')].find(x => x.innerText.includes('全应用同时运行的模型调用'));
    return { 输入框: row.querySelector('input').value, 行内错误: row.querySelector('.pset-row-error')?.innerText.trim() ?? null };
  })()
`);
await setCountTo('1.5');
await sleep(400);
const decCount = await readCount();
check('③ 并发数 1.5 被拦下（行内报错，编辑态保留）',
  decCount?.输入框 === '1.5' && /整数|不接受小数/.test(String(decCount?.行内错误)),
  JSON.stringify(decCount));
await go('/settings?section=appearance');
await go('/settings?section=general');
const afterLeave = await readCount();
check('③ 非法值没写进状态（离开再回来仍是 3）', afterLeave?.输入框 === '3', JSON.stringify(afterLeave));
await setCountTo('4');
await sleep(500);
await go('/settings?section=appearance');
await go('/settings?section=general');
const afterOk = await readCount();
check('③ 合法整数（4）能保存并留在状态里', afterOk?.输入框 === '4', JSON.stringify(afterOk));
await setCountTo('3');
await sleep(400);

/* ============================================================
   ④ 免打扰：区分「已启用」与「此刻生效」
   ============================================================ */
console.log('\n-- ④ 免打扰时段 --');
await go('/settings?section=notifications');
const dndSet = (fromOffsetMin, toOffsetMin) => ev(`
  (async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const setVal = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const hh = (ms) => { const d = new Date(Date.now() + ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    const rowOf = () => [...document.querySelectorAll('.settings-body .pset-row')].find(r => r.innerText.includes('免打扰时段'));
    /* 开态判据是 .switch-track.on（.switch 是外层 label，永远不带 on） */
    const track = rowOf().querySelector('.switch-track');
    if (!track.classList.contains('on')) { rowOf().querySelector('.switch').click(); await new Promise(r => setTimeout(r, 500)); }
    const times = [...document.querySelectorAll('.settings-body .dnd-time')];
    if (times.length !== 2) return { __err: '时段输入框数量=' + times.length + '（应为 2）' };
    setVal(times[0], hh(${fromOffsetMin} * 60000));
    setVal(times[1], hh(${toOffsetMin} * 60000));
    await new Promise(r => setTimeout(r, 600));
    const body = document.querySelector('.settings-body').innerText;
    return {
      时段行值: rowOf().querySelector('.pset-value')?.innerText.trim() ?? null,
      说此刻生效: body.includes('此刻生效中'),
      说不在时段内: body.includes('当前不在时段内'),
      说照常提醒: body.includes('照常提醒'),
      说不会响: body.includes('下面的条目现在不会响'),
    };
  })()
`);
const dndInside = await dndSet(-30, 30);
check('④ 时段覆盖当下时，才说「此刻生效中 / 现在不会响」',
  dndInside?.说此刻生效 === true && dndInside?.说不会响 === true && dndInside?.说不在时段内 === false,
  JSON.stringify(dndInside));
const dndOutside = await dndSet(180, 240);
check('④ 时段不覆盖当下时，说「当前不在时段内 / 照常提醒」（不再谎报正在免打扰）',
  dndOutside?.说此刻生效 === false && dndOutside?.说不在时段内 === true && dndOutside?.说照常提醒 === true,
  JSON.stringify(dndOutside));
// 关掉免打扰，避免影响后续分区
await ev(`(() => { const row = [...document.querySelectorAll('.settings-body .pset-row')].find(r => r.innerText.includes('免打扰时段')); const t = row.querySelector('.switch-track'); if (t.classList.contains('on')) row.querySelector('.switch').click(); return true; })()`);
await sleep(400);

/* ============================================================
   ⑤ AI 工具：安装 / 认证 / 验证分开，不从综合结论反推
   ============================================================ */
console.log('\n-- ⑤ AI 工具状态映射 --');
await go('/settings?section=runtime');
const rtStates = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const card = body.querySelector('[data-runtime]');
    const rows = [...card.querySelectorAll('.pset-row')].map(r => ({
      名: r.querySelector('.pset-row-name')?.innerText.trim() ?? '',
      值: r.querySelector('.pset-value')?.innerText.trim() ?? '',
    }));
    return {
      行: rows,
      千程含旧说法: /未安装 \\/ 不可用|未登录或认证已过期/.test(body.innerText),
      提不显示账号: /不显示登录的账号名/.test(body.innerText),
    };
  })()
`);
const names = (rtStates?.行 ?? []).map((r) => r.名);
const valOf = (n) => (rtStates?.行 ?? []).find((r) => r.名.includes(n))?.值 ?? null;
check('⑤ 安装 / 认证 / 验证三项分别显示，另有单独的综合结论行',
  ['安装状态', '认证状态', '验证状态', '当前是否可用'].every((n) => names.some((x) => x.includes(n)))
    && valOf('安装状态') === '已安装' && valOf('认证状态') === '已登录'
    && valOf('验证状态') === '已验证' && valOf('当前是否可用') === '可用',
  JSON.stringify(rtStates?.行));
check('⑤ 不再由"不可用"反推单项（旧的「未安装 / 不可用」「未登录或认证已过期」已消失）',
  rtStates?.千程含旧说法 === false, String(rtStates?.千程含旧说法));
check('⑤ 认证状态如实写"不显示登录的账号名"（读不到就不编）', rtStates?.提不显示账号 === true);

/* ============================================================
   ⑥ 工具配置流程：能改、能存、非法不写
   ============================================================ */
console.log('\n-- ⑥ 工具配置流程 --');
const rtConfigFlow = await ev(`
  (async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const setVal = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const saveBtn = () => [...document.querySelectorAll('.modal .btn')].find(b => b.innerText.includes('保存配置'));
    const card = document.querySelector('[data-runtime]');
    [...card.querySelectorAll('button')].find(b => b.innerText.includes('配置')).click();
    await new Promise(r => setTimeout(r, 500));
    const modal = document.querySelector('.modal');
    const 四件事齐 = ['保存结果', '生效时机', '失败处理'].every(k => modal.innerText.includes(k));
    const 有认证选择 = !!modal.querySelector('select');
    const 不给密钥输入框 = modal.innerText.includes('不保存密钥明文') && !modal.querySelector('input[type=password]');
    const pathsInput = () => document.querySelector('.modal input.mono');
    // 非法 1：清空路径
    setVal(pathsInput(), '');
    saveBtn().click();
    await new Promise(r => setTimeout(r, 400));
    const 空路径 = { 弹窗仍在: !!document.querySelector('.modal'), 报错: document.querySelector('[data-runtime-config-error]')?.innerText.trim() ?? null };
    // 非法 2：相对路径
    setVal(pathsInput(), 'codex.cmd');
    saveBtn().click();
    await new Promise(r => setTimeout(r, 400));
    const 相对路径 = { 弹窗仍在: !!document.querySelector('.modal'), 报错: document.querySelector('[data-runtime-config-error]')?.innerText.trim() ?? null };
    // 合法：绝对路径 + 换 API key + 连接参数
    setVal(pathsInput(), 'C:\\\\tools\\\\codex\\\\codex.cmd');
    const sel = document.querySelector('.modal select');
    const selSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    selSetter.call(sel, 'api-key');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    setVal([...document.querySelectorAll('.modal input.mono')][1], '--app-server --port 7411');
    saveBtn().click();
    await new Promise(r => setTimeout(r, 700));
    const body = document.querySelector('.settings-body');
    return {
      四件事齐, 有认证选择, 不给密钥输入框, 空路径, 相对路径,
      保存后弹窗已关: !document.querySelector('.modal'),
      列表反映认证方式: /API key/.test(body.innerText),
      列表反映路径: /codex\\.cmd/.test(body.innerText),
    };
  })()
`);
check('⑥ 工具配置是**可改的流程**：路径 / 认证方式 / 连接参数 + 四件事写全，且不给密钥输入框',
  rtConfigFlow?.四件事齐 === true && rtConfigFlow?.有认证选择 === true && rtConfigFlow?.不给密钥输入框 === true,
  JSON.stringify(rtConfigFlow));
check('⑥ 非法配置不写入：空路径与相对路径都留在弹窗里报错',
  rtConfigFlow?.空路径?.弹窗仍在 === true && /绝对路径|请填/.test(String(rtConfigFlow?.空路径?.报错))
    && rtConfigFlow?.相对路径?.弹窗仍在 === true && /绝对路径/.test(String(rtConfigFlow?.相对路径?.报错)),
  JSON.stringify({ 空: rtConfigFlow?.空路径, 相对: rtConfigFlow?.相对路径 }));
check('⑥ 合法配置能保存并反映在列表（认证方式与路径同步更新）',
  rtConfigFlow?.保存后弹窗已关 === true && rtConfigFlow?.列表反映认证方式 === true && rtConfigFlow?.列表反映路径 === true,
  JSON.stringify({ 关: rtConfigFlow?.保存后弹窗已关, 认证: rtConfigFlow?.列表反映认证方式, 路径: rtConfigFlow?.列表反映路径 }));

await go('/activity');
const configLogged = await ev(`document.body.innerText.includes('runtime.config.update')`);
check('⑥ 配置保存留下写操作留痕（可回溯"谁改了什么"）', configLogged === true, String(configLogged));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
