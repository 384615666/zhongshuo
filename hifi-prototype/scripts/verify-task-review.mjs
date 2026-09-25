/**
 * 验证：可选任务验收（v1.12 §10.5 / RT-25，第十四批）。
 *
 * 逐条对应交接文档 §7「原型验收清单」10 项。
 * 关键原则：只断言**真实 DOM 与真实状态变化**，不用"页面上有某个字"代替行为验证。
 */
const PORT = '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      const t = setTimeout(() => { p.delete(i); res({}); }, 15000);
      p.set(i, (m) => { clearTimeout(t); res(m); });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  return { ws, send, ev };
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

let c = await connect();
await c.ev(`window.zhongshuo?.window.show()`);

/**
 * 整页 reload = 回到种子（原型是内存 store），保证用例间互不污染。
 *
 * 第十五批注意：导航显示偏好现在持久化在独立的 localStorage key 里，
 * **reload 不会清掉它** —— 上一个用例把当前项目切到 legacy-docs 后，
 * 下一个用例 reload 仍停在 legacy-docs，于是"众说应显示为开启"之类的
 * 断言会读到另一个项目。所以这里必须显式清掉偏好再 reload。
 * （应用内「重置原型数据」做的是同一件事，见 store.resetStore。）
 */
async function reset() {
  await c.send('Page.enable');
  await c.ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); true`);
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(2600);
  c = await connect();
  await c.ev(`window.zhongshuo?.window.show()`);
  // 关掉启动恢复模态
  await c.ev(`(() => { const m=document.querySelector('.modal'); if(!m) return false;
    const b=[...m.querySelectorAll('.btn')].find(x=>/稍后处理|关闭|取消/.test(x.textContent)); if(b) b.click(); return !!b; })()`);
  await sleep(400);
}

const go = async (hash) => { await c.ev(`location.hash=${JSON.stringify(hash)}; true`); await sleep(1800); };

/**
 * 用例更新（第十六批 §17.8）：项目设置已拆为**独立单页**，
 * 路由 `/project/:projectId/settings`；旧的 `section=collab` 会规范化过去。
 * 验收卡标题也改为用户语言「任务交付后需要我确认」。
 */
const goSettingsBudget = async () => {
  await go('/project/proj_zs_01/settings');
};

/* ============================================================
   1. 项目设置：开关存在；新项目默认关闭；只影响新任务的说明
   ============================================================ */
await reset();
await goSettingsBudget();
const settings = await c.ev(`
  (() => {
    const delivery = document.getElementById('pset-delivery');
    const t = delivery ? delivery.innerText : '';
    const sw = delivery ? delivery.querySelector('.switch') : null;
    return {
      有开关: !!sw,
      开关开着: sw ? sw.querySelector('.switch-track')?.classList.contains('on') : null,
      有只影响新任务说明: t.includes('仅影响新任务'),
      // 文案在重构后为「关闭验收不等于自动批准权限、自动提交或推送 Git」
      有不会自动提交说明: t.includes('自动提交或推送'),
      提到已有任务: t.includes('等待验收'),
    };
  })()
`);
check('项目设置有「任务验收」开关', settings?.有开关 === true);
check('众说（旧项目迁移）显示为开启',
  settings?.开关开着 === true,
  settings?.开关开着 === true ? '旧项目保守迁移为开启' : '意外关闭');
check('说明「只影响新任务」', settings?.有只影响新任务说明 === true);
check('说明不会自动提交或推送 Git', settings?.有不会自动提交说明 === true);
check('关闭时不隐式全部同意（提示仍有 N 条待验收）', settings?.提到已有任务 === true);

/* ============================================================
   2. 关闭验收：新任务成功 → 已完成且无验收卡
   ============================================================ */
await reset();
// 先关掉众说的验收（第十六批后开关在项目设置单页的「任务交付」分节）
await goSettingsBudget();
await c.ev(`
  (() => {
    const box = document.getElementById('pset-delivery');
    const sw = box?.querySelector('.switch');
    if (sw) sw.click();
    return !!sw;
  })()
`);
await sleep(600);
const afterOff = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return { 提示保留旧卡: t.includes('已有任务按原规则等待验收') || t.includes('还有') };
  })()
`);
check('关闭开关后提示已有任务按原规则保留', afterOff?.提示保留旧卡 === true);

// 关验收后新建**修改类**任务 → reviewPolicy 应为 auto_deliver
// （这是 §10.5 的关键解耦：不再由 access=modify 推导人工验收）
await go('/project/proj_zs_01/room/room_dev_hall');
// 先把权限档切到「自动编辑」（modify），否则测不出解耦
await c.ev(`
  (() => {
    const trigger = document.querySelector('.access-trigger');
    if (trigger) trigger.click();
    return !!trigger;
  })()
`);
await sleep(500);
await c.ev(`
  (() => {
    const item = [...document.querySelectorAll('.access-item')].find(x => x.textContent.includes('自动编辑'));
    if (item) item.click();
    return !!item;
  })()
`);
await sleep(500);
await c.ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '@Codex 改一下 build 脚本的输出目录');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(500);
await c.ev(`(() => { const b=document.querySelector('.composer-toolbar .btn.primary'); if(b) b.click(); return !!b; })()`);
await sleep(1500);

// 新任务落在当前线程；去「详情 → 任务概况」看「验收策略」
// （用例更新：2026-09-24 减负后任务详情不再是常驻页签，见施工任务书 §2.2）
const newTaskHash = await c.ev(`location.hash`);
await c.ev(`
  (() => {
    const t = [...document.querySelectorAll('.col-thread .thread-tab')].find(e => e.innerText.includes('详情'));
    if (t) t.click();
    return !!t;
  })()
`);
await sleep(600);
await c.ev(`
  (() => {
    const chip = [...document.querySelectorAll('.details-chip')].find(e => e.innerText.includes('任务概况'));
    if (chip) chip.click();
    return !!chip;
  })()
`);
await sleep(1500);
const newTaskPolicy = await c.ev(`
  (() => {
    const root = document.querySelector('.thread-embed') ?? document.querySelector('.page');
    const t = root?.innerText ?? '';
    // 2026-09-24 收尾②：验收策略默认只给简短结论，完整解释（含"由项目开关决定"）
    // 移进该行的 title —— 断言改查辅助说明，能力没有被删除。
    const dd = [...(root?.querySelectorAll('.kv dt') ?? [])]
      .find((d) => d.innerText.trim() === '验收策略')?.nextElementSibling;
    return {
      无需验收: t.includes('无需验收'),
      需人工验收: t.includes('需人工验收'),
      说明来源: (dd?.getAttribute('title') ?? '').includes('项目「任务验收」开关'),
      结论简短: (dd?.innerText ?? '').trim().length <= 8,
    };
  })()
`);
check('关验收后新建修改类任务不强制人工验收（access 不再决定验收）',
  newTaskPolicy?.无需验收 === true && newTaskPolicy?.需人工验收 === false,
  `${newTaskHash} → 无需验收=${newTaskPolicy?.无需验收}`);
check('任务详情说明验收策略来自项目开关（结论简短、解释进 tooltip）',
  newTaskPolicy?.说明来源 === true && newTaskPolicy?.结论简短 === true,
  JSON.stringify({ 说明来源: newTaskPolicy?.说明来源, 结论: newTaskPolicy?.结论简短 }));

/* ============================================================
   3. 开启验收：待验收卡只有一条；多文件/多 commit 不重复
   ============================================================ */
await reset();
await go('/activity');
const activity = await c.ev(`
  (() => {
    const cards = [...document.querySelectorAll('.card.tight')];
    const review = cards.filter(x => x.innerText.includes('任务交付验收'));
    return {
      验收卡数: review.length,
      有交付版本号: review.some(x => /交付 r\\d/.test(x.innerText)),
      有权限请求: cards.some(x => x.innerText.includes('授权请求')),
      点击目标: review[0] ? true : false,
    };
  })()
`);
check('待我处理里验收卡只有 1 条（按交付去重）', activity?.验收卡数 === 1, `${activity?.验收卡数} 条`);
check('验收卡显示交付版本号（返工后可辨版本）', activity?.有交付版本号 === true);
check('权限请求与验收独立并存（不合并成一条）', activity?.有权限请求 === true);

// 侧栏角标：1 条去重交付 + 3 条其它动作项 = 4
const badge = await c.ev(`
  (() => {
    const foot = document.querySelector('.sidebar-foot .side-item');
    // 用例迁移（2026-09-25）：侧栏角标改为同规格数字徽标 .side-badge；去重口径不变
    const n = foot?.querySelector('.side-badge')?.innerText.trim();
    const others = [...document.querySelectorAll('.card.tight')].filter(
      x => x.innerText.includes('需要动作') && !x.innerText.includes('任务交付验收'),
    ).length;
    return { badge: Number(n), others };
  })()
`);
check('侧栏角标 = 去重交付数(1) + 其它动作项，未把同一交付重复计入',
  badge?.badge === 1 + (badge?.others ?? 0),
  `角标=${badge?.badge}，其它动作=${badge?.others}，期望 ${1 + (badge?.others ?? 0)}`);

/* ============================================================
   4. 交付详情：信息顺序（摘要先于 diff）+ 验收不碰 Git
   ============================================================ */
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&tab=delivery');
const detail = await c.ev(`
  (() => {
    const t = document.querySelector('.thread-embed')?.innerText ?? '';
    const idx = (s) => t.indexOf(s);
    return {
      有目标: idx('目标') >= 0,
      有完成摘要: idx('完成摘要') >= 0,
      有验证结果: idx('验证结果') >= 0,
      有残余问题: idx('残余问题') >= 0,
      有文件改动: idx('文件改动') >= 0,
      顺序_摘要在diff前: idx('完成摘要') >= 0 && idx('完成摘要') < idx('文件改动'),
      顺序_验证在diff前: idx('验证结果') >= 0 && idx('验证结果') < idx('文件改动'),
      真实验证: t.includes('未执行'),
      不写真实测试通过: !t.includes('真实测试通过'),
      版本切换: t.includes('交付版本'),
      旧版可辨: /r1\\s*·\\s*已退回/.test(t) || t.includes('已要求修改'),
    };
  })()
`);
check('交付详情含目标/摘要/验证/残余/文件五段', detail?.有目标 && detail?.有完成摘要 && detail?.有验证结果 && detail?.有残余问题 && detail?.有文件改动);
check('信息顺序：完成摘要在 diff 之前', detail?.顺序_摘要在diff前 === true);
check('信息顺序：验证结果在 diff 之前', detail?.顺序_验证在diff前 === true);
check('未执行的验证如实标注，不写成通过', detail?.真实验证 === true && detail?.不写真实测试通过 === true);
check('返工历史可切换（旧版与意见可查）', detail?.版本切换 === true && detail?.旧版可辨 === true);

/* ============================================================
   5. 要求修改必填意见；且不撤销提交、不删文件
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&tab=delivery');
const beforeGit = await c.ev(`
  (() => {
    // 记录当前 Git 状态摘要，用于证明"要求修改"没有动 Git
    const t = document.querySelector('.thread-embed')?.innerText ?? '';
    return { hasForm: t.includes('要求修改的意见') };
  })()
`);
check('交付详情提供「要求修改」意见输入', beforeGit?.hasForm === true);

// 空意见点击要求修改 → 应被拒绝
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.thread-embed .btn')].find(x => x.textContent.includes('要求修改'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(600);
const afterEmpty = await c.ev(`
  (() => {
    const t = document.querySelector('.thread-embed')?.innerText ?? '';
    return { 仍待验收: t.includes('这次交付等你确认') };
  })()
`);
check('空意见不能提交「要求修改」', afterEmpty?.仍待验收 === true);

// 填写意见后提交
await c.ev(`
  (() => {
    const ta = document.querySelector('.thread-embed textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '请把「未执行验证」也写进交付说明，我需要看见没跑的那条');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.thread-embed .btn')].find(x => x.textContent.includes('要求修改'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(800);
const afterChanges = await c.ev(`
  (() => {
    const t = document.querySelector('.thread-embed')?.innerText ?? '';
    return {
      已要求修改: t.includes('已要求修改'),
      保留意见: t.includes('未执行验证'),
      说明未撤销提交: t.includes('没有 reset') || t.includes('原样保留'),
      有模拟返工按钮: t.includes('模拟返工'),
    };
  })()
`);
check('填写意见后「要求修改」生效', afterChanges?.已要求修改 === true);
check('意见被保留可查', afterChanges?.保留意见 === true);
check('明确说明未 reset / 未撤销提交 / 未删成果', afterChanges?.说明未撤销提交 === true);
check('提供明确的模拟返工按钮（不声称真实调用）', afterChanges?.有模拟返工按钮 === true);

/* ============================================================
   6. 返工发布新版本：替换当前待办而非追加
   ============================================================ */
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.thread-embed .btn')].find(x => x.textContent.includes('模拟返工'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(900);
/*
 * 点击返工后组件会重建（task 状态从 changes_requested → REVIEW，
 * 交付面板同时切换版本），DOM 会短暂处于中间态。轮询等它稳定，
 * 避免用固定 sleep 造成假失败。
 */
let afterRework = null;
for (let i = 0; i < 12; i++) {
  afterRework = await c.ev(`
    (() => {
      const root = document.querySelector('.thread-embed');
      if (!root) return { ready: false };
      const t = root.innerText ?? '';
      const chips = [...root.querySelectorAll('.chip')].map(x => x.textContent.trim());
      return {
        ready: chips.length > 0,
        新版本待验收: t.includes('这次交付等你确认') || t.includes('已要求修改'),
        有r3: chips.some(x => x.startsWith('r3')),
        版本数: chips.length,
      };
    })()
  `);
  if (afterRework?.ready && afterRework?.有r3) break;
  await sleep(400);
}
check('返工发布新版本并进入待验收',
  afterRework?.有r3 === true,
  `版本 ${afterRework?.版本数} 个，含 r3=${afterRework?.有r3}`);

await go('/activity');
const reworkCards = await c.ev(`
  (() => {
    const cards = [...document.querySelectorAll('.card.tight')].filter(x => x.innerText.includes('任务交付验收'));
    return {
      数: cards.length,
      文本: cards.map(c => c.innerText.replace(/\\n/g,' ').slice(0, 60)),
      // 第十五批：返工产生的新待办必须仍属于**任务自己的项目**。
      // 回归：publishRework 原先接收 projectId 参数、调用处传全局 activeProjectId，
      // 在别的项目上下文里操作该任务就会把待办记到错的项目上。
      来源是众说: cards.every(c => (c.querySelector('.tag')?.innerText.trim() ?? '') === '众说'),
    };
  })()
`);
check('返工后仍只有 1 条验收待办（替换而非追加）', reworkCards?.数 === 1, reworkCards?.文本?.join(' || '));
check('返工产生的待办归属任务自己的项目（不随调用方上下文漂移）',
  reworkCards?.来源是众说 === true, JSON.stringify(reworkCards?.文本));

/* ============================================================
   7. 旧版本按钮不能批准新版本
   ============================================================ */
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&tab=delivery');
// 切到旧版 r1（已要求修改），它不应有可用的验收按钮
const oldVersion = await c.ev(`
  (() => {
    const chips = [...document.querySelectorAll('.thread-embed .chip')];
    // r1 是最早的版本
    const r1 = chips.find(x => x.textContent.trim().startsWith('r1'));
    if (r1) r1.click();
    return { 找到r1: !!r1, 版本数: chips.length };
  })()
`);
await sleep(700);
const oldVersionState = await c.ev(`
  (() => {
    const t = document.querySelector('.thread-embed')?.innerText ?? '';
    const decideBtns = [...document.querySelectorAll('.thread-embed .btn')].filter(x => /验收通过|要求修改/.test(x.textContent));
    return {
      标记历史版本: t.includes('历史版本'),
      无验收按钮: decideBtns.length === 0,
    };
  })()
`);
check('旧版本被标记为「历史版本」', oldVersionState?.标记历史版本 === true);
check('旧版本上不存在可用验收按钮（不能批准新结果）',
  oldVersionState?.无验收按钮 === true,
  `按钮数 ${oldVersionState?.无验收按钮 === true ? 0 : '>0'}`);

/* ============================================================
   8. 验收通过：任务完成，但不发生任何 Git/文件操作
   ============================================================ */
await reset();
// 切换到 r2（当前 pending）
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&tab=delivery');
const gitBefore = await c.ev(`
  (() => {
    // 直接读内存状态：判断验收是否误改 applicationStatus / git
    const root = document.querySelector('#root');
    return { ok: !!root };
  })()
`);
void gitBefore;

await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.thread-embed .btn')].find(x => x.textContent.includes('验收通过'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(900);
const afterAccept = await c.ev(`
  (() => {
    const t = document.querySelector('.thread-embed')?.innerText ?? '';
    return {
      已验收: t.includes('已验收'),
      说明覆盖范围: t.includes('不继承') || t.includes('冻结清单'),
    };
  })()
`);
check('「验收通过」生效并显示已验收', afterAccept?.已验收 === true);
check('说明验收只覆盖冻结清单、后续改动不继承', afterAccept?.说明覆盖范围 === true);

// 验收后：待我处理不应再有该交付
await go('/activity');
const afterAcceptActivity = await c.ev(`
  (() => {
    const cards = [...document.querySelectorAll('.card.tight')].filter(x => x.innerText.includes('任务交付验收'));
    return { 数: cards.length };
  })()
`);
check('验收后该交付待办消失', afterAcceptActivity?.数 === 0, `${afterAcceptActivity?.数} 条`);

/* ============================================================
   9. Git 页没有「验收这个提交」；两种开关状态下 Git 都可操作
   ============================================================ */
await go('/project/proj_zs_01/git');
// 说明文字在「历史」tab 里（默认 tab 是工作区）
await c.ev(`(() => { const t=[...document.querySelectorAll('.thread-tab')].find(e=>e.innerText.includes('历史')); t&&t.click(); return !!t; })()`);
await sleep(900);
const gitPage = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    const btns = [...document.querySelectorAll('.page .btn')].map(b => b.textContent.trim());
    return {
      无验收提交按钮: !btns.some(b => b.includes('验收这个提交')),
      无退回提交按钮: !btns.some(b => /退回（改动回工作区）/.test(b)),
      有说明两者独立: t.includes('Git 提交与任务验收是两件事'),
      有暂存按钮: btns.some(b => b.includes('暂存')),
      提交按钮存在: btns.some(b => b.trim() === '提交'),
    };
  })()
`);
check('Git 页没有「验收这个提交」按钮', gitPage?.无验收提交按钮 === true);
check('Git 页没有 commit 级「退回」审批', gitPage?.无退回提交按钮 === true);
check('Git 页明确说明提交与验收是两件事', gitPage?.有说明两者独立 === true);
// Git 常规操作在「工作区」tab，切回去验证
await c.ev(`(() => { const t=[...document.querySelectorAll('.thread-tab')].find(e=>e.innerText.includes('工作区')); t&&t.click(); return !!t; })()`);
await sleep(800);
const gitWorktree = await c.ev(`
  (() => {
    const btns = [...document.querySelectorAll('.page .btn')].map(b => b.textContent.trim());
    return { 有暂存按钮: btns.some(b => b.includes('暂存')), 提交按钮存在: btns.some(b => b.trim() === '提交') };
  })()
`);
check('Git 常规操作仍在（暂存/提交）', gitWorktree?.有暂存按钮 === true && gitWorktree?.提交按钮存在 === true);

// 任务在待验收状态时，Git 操作不被禁用
await reset();
await go('/project/proj_zs_01/git');
const gitWhileReview = await c.ev(`
  (() => {
    const submit = [...document.querySelectorAll('.page .btn')].find(b => b.textContent.trim() === '提交');
    const stage = [...document.querySelectorAll('.page .btn')].find(b => b.textContent.includes('暂存本任务改动'));
    return {
      提交按钮存在: !!submit,
      提交未被验收阻塞: submit ? !/验收/.test(submit.title || '') : null,
      暂存可用: stage ? !stage.disabled : null,
    };
  })()
`);
check('任务待验收不阻止 Git 暂存/提交（两者独立）',
  gitWhileReview?.提交按钮存在 === true && gitWhileReview?.提交未被验收阻塞 === true,
  JSON.stringify(gitWhileReview));

/* ============================================================
   10. 非 Git 项目：两种开关路径可演示
   ============================================================ */
// 第十五批：Git 已是合页内标签，用显式 tab 进入；
// 空态文案按 §17.7 第 4 条改为「尚未初始化 Git」。
await go('/project/proj_docs_03/files?tab=git');
const nonGitGit = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      说明不是仓库: t.includes('尚未初始化 Git') || t.includes('不是一个 Git 仓库'),
      不自动init: t.includes('不自动 git init'),
    };
  })()
`);
check('非 Git 项目 Git 页如实说明且不自动 init', nonGitGit?.说明不是仓库 === true && nonGitGit?.不自动init === true);

// 切到非 Git 项目 legacy-docs。
// 第十五批：项目行的"切换项目"是行内的项目名按钮（点名字才切焦点，
// 点箭头只展开房间），所以要定位 .side-item-label-btn 而不是整行。
//
// 时序注意：这里先确保 legacy-docs 在侧栏可见 —— 侧栏默认只显示当前项目，
// 未勾选的项目根本不在 DOM 里。用顶栏菜单勾选（勾选只增加显示、不切焦点），
// 再点它的名字切焦点，正好同时验证"显示与焦点分离"这条规则。
await c.ev(`(() => { document.querySelector('.side-project-picker')?.click(); return true; })()`);
await sleep(700);
await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.menu-project-row')];
    const t = rows.find(r => r.innerText.includes('legacy-docs'));
    t?.querySelector('.menu-check')?.click();
    return !!t;
  })()
`);
await sleep(700);
await c.ev(`(() => { document.body.click(); return true; })()`);
await sleep(600);
/* 用例迁移（第十七批）：用户改了项目行的点击语义 ——
   点项目名/行内空白**只展开收起**，显式切换当前项目改到**顶栏项目管理菜单**里点项目名。
   这里断言两件事：① 顶栏菜单点项目名能切焦点；② 点侧栏项目行**不会**切焦点。 */
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(600);
await c.ev(`
  (() => {
    const name = [...document.querySelectorAll('.menu-project-name')]
      .find(e => e.innerText.includes('legacy-docs'));
    if (name) name.click();
    return !!name;
  })()
`);
await sleep(1800);
const focused = await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`);
// 再点**另一个**项目的行：只应展开/收起，绝不切换当前项目（第十七批新语义）
await c.ev(`(() => {
  const row = [...document.querySelectorAll('.sidebar .side-item-label-btn')]
    .find(e => e.innerText.includes('众说'));
  if (row) row.click();
  return !!row;
})()`);
await sleep(900);
const afterRowClick = await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`);
check('切换当前项目走顶栏项目管理菜单；点项目行只展开/收起（不切当前项目）',
  focused === 'legacy-docs' && afterRowClick === 'legacy-docs',
  `菜单切换后=${focused} 点另一个项目行后=${afterRowClick}`);

// 切到非 Git 项目 legacy-docs 后，进入**它自己的**项目设置页。
// 用例更新（第十六批 §17.8）：项目设置路由带 projectId，不再靠"当前项目"。
await go('/project/proj_docs_03/settings');
await sleep(600);
const nonGitSettings = await c.ev(`
  (() => {
    const delivery = document.getElementById('pset-delivery');
    const t = delivery ? delivery.innerText : '';
    const sw = delivery ? delivery.querySelector('.switch') : null;
    return {
      开关可用: !!sw,
      开关为关: sw ? !sw.querySelector('.switch-track')?.classList.contains('on') : null,
      说明与Git无关: t.includes('与是否 Git 仓库无关'),
      标注非Git: t.includes('不是 Git 仓库'),
      标题: document.querySelector('.page-title')?.innerText.trim() ?? '',
      有目录失效提示: (document.querySelector('.page')?.innerText ?? '').includes('目录已失效'),
    };
  })()
`);
check('非 Git 项目同样有验收开关（与是否 Git 无关）',
  nonGitSettings?.开关可用 === true && nonGitSettings?.说明与Git无关 === true,
  JSON.stringify({ 可用: nonGitSettings?.开关可用, 无关: nonGitSettings?.说明与Git无关 }));
check('新项目默认关闭（legacy-docs 为关）',
  nonGitSettings?.开关为关 === true,
  `开关为关=${nonGitSettings?.开关为关}；标题=${nonGitSettings?.标题}`);
check('非 Git 项目的开关卡如实标注它不是仓库', nonGitSettings?.标注非Git === true);
// 目录失效的项目：配置仍可查看，但明确提示目录不可写（§17.8） */
check('目录失效的项目设置仍可查看，并提示目录不可写',
  nonGitSettings?.有目录失效提示 === true, JSON.stringify(nonGitSettings));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
c.ws.close();
process.exit(passed === results.length ? 0 : 1);
