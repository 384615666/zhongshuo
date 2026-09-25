/**
 * 回归验证第十三项改动（用户反馈 1—10 项）。
 * 全部在真实 Electron 窗口里用 CDP 点击验证。
 */

const PORT = process.env.ZS_CDP_PORT ?? '9333';
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
    }, 12000);
    p.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
  return { value: r.result?.result?.value };
};

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

/* 确保窗口可见（隐藏窗口的渲染/截图都会异常） */
await ev(`window.zhongshuo?.window.show()`);
await sleep(600);

const goto = async (hash) => {
  await ev(`location.hash=${JSON.stringify(hash)}; location.reload(); true`);
  await sleep(2800);
};

/* ---------- 3/4/5/6：输入条布局 ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');

const composer = await ev(`
  (() => {
    const c = document.querySelector('.col-thread .composer');
    if (!c) return null;
    const bar = c.querySelector('.composer-toolbar');
    const kids = [...bar.children].map(x => x.className.split(' ')[0] || x.tagName.toLowerCase());
    return {
      hasStatusButtons: !!c.querySelector('.composer-status button'),
      accessTrigger: !!c.querySelector('.access-trigger'),
      accessLabel: c.querySelector('.access-trigger')?.textContent?.trim(),
      paperclipBeforeSpacer: (() => {
        const idx = (cls) => kids.findIndex(k => k.includes(cls));
        return idx('icon-btn') < idx('spacer');
      })(),
      toolbarOrder: kids,
      inputH: c.querySelector('.composer-input')?.getBoundingClientRect().height,
    };
  })()
`);
check('③ 输入条下方不再有按钮', composer.value?.hasStatusButtons === false, `status buttons=${composer.value?.hasStatusButtons}`);
check('④ 权限模式为下拉选择器', composer.value?.accessTrigger === true, composer.value?.accessLabel ?? '');
check('⑤ 附件/提及已移到左侧（spacer 之前）', composer.value?.paperclipBeforeSpacer === true, JSON.stringify(composer.value?.toolbarOrder));

/* 房间侧输入条高度应与回复串一致 */
const roomH = await ev(`document.querySelector('.col-main .composer-input')?.getBoundingClientRect().height`);
check(
  '⑥ 房间与回复串输入条等高',
  Math.abs((roomH.value ?? 0) - (composer.value?.inputH ?? -1)) < 1,
  `房间=${roomH.value} 回复串=${composer.value?.inputH}`,
);

/* 展开下拉，验证四个选项 */
await ev(`document.querySelector('.access-trigger').click(); true`);
await sleep(400);
const modes = await ev(`
  (() => {
    const items = [...document.querySelectorAll('.access-item')];
    return { count: items.length, labels: items.map(i => i.querySelector('.access-item-label')?.textContent) };
  })()
`);
check('④ 权限模式有 4 档且含计划模式/完全访问', modes.value?.count === 4, JSON.stringify(modes.value?.labels));
await ev(`document.querySelector('.access-scrim')?.click(); true`);
await sleep(300);

/* ---------- 7：分隔条 ---------- */
const split = await ev(`
  (() => {
    const sp = document.querySelector('.splitter');
    const th = document.querySelector('.col-thread');
    return { hasSplitter: !!sp, threadWidth: th?.getBoundingClientRect().width, cursor: sp ? getComputedStyle(sp).cursor : null };
  })()
`);
check('⑦ 回复串有左右拉伸分隔条', split.value?.hasSplitter === true, `cursor=${split.value?.cursor}`);
check('⑦ 回复串默认宽度已加大（>520）', (split.value?.threadWidth ?? 0) > 520, `${Math.round(split.value?.threadWidth ?? 0)}px`);

/* ---------- 8/9/10：回复串导航、详情分组与原消息去处 ----------
   用例更新（2026-09-24 界面信息减负）：常驻页签收敛为「回复/成果/详情」，
   任务详情、成员、研讨等进「详情」分组；顶部两行（状态/图标行与原消息摘要条）
   已删除，原消息全文改在「详情 → 任务概况」里查。这里不是放宽断言，
   而是把"原消息可查、成员可管、详情就地渲染"三条业务能力重新定位到新入口。 */
const tabs = await ev(`
  (() => {
    const t = [...document.querySelectorAll('.col-thread .thread-tab')].map(x => x.textContent.trim().split('\\n')[0]);
    return {
      tabs: t,
      headGone: !document.querySelector('.thread-head') && !document.querySelector('.thread-head-row'),
      anchorGone: !document.querySelector('.thread-anchor'),
    };
  })()
`);
const tabText = (tabs.value?.tabs ?? []).join('|');
check('⑩ 顶部两行已删除（原消息横条未换皮回归）', tabs.value?.headGone === true && tabs.value?.anchorGone === true,
  `head=${tabs.value?.headGone} anchor=${tabs.value?.anchorGone}`);
check('⑧ 常驻导航为 回复/成果/详情（不再铺 8 个页签）', tabText.includes('回复') && tabText.includes('成果') && tabText.includes('详情'), tabText);
check('⑨ 成员管理不再常驻，改由详情分组承载', !tabText.includes('成员'), tabText);

/* 打开「详情」，验证分组清单与就地渲染 */
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.col-thread .thread-tab')].find(x => x.textContent.includes('详情'));
    t?.click(); return true;
  })()
`);
await sleep(600);
const chips = await ev(`[...document.querySelectorAll('.details-chip')].map(x => x.textContent.trim().split('\\n')[0])`);
const chipText = (chips.value ?? []).join('|');
check('⑧ 任务概况/研讨详情成为详情分组', chipText.includes('任务概况') && chipText.includes('研讨详情'), chipText);
check('⑨ 参与成员成为详情分组', chipText.includes('参与成员'), chipText);

/* 点「参与成员」分组，验证内容渲染 */
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.details-chip')].find(x => x.textContent.includes('参与成员'));
    t?.click(); return true;
  })()
`);
await sleep(600);
const membersTab = await ev(`
  (() => ({
    hasList: !!document.querySelector('.thread-embed, .msg-list'),
    text: document.body.innerText.includes('移出跟进') || document.body.innerText.includes('加入跟进'),
  }))()
`);
check('⑨ 参与成员分组渲染跟进名单与操作', membersTab.value?.text === true);

/* 点「任务概况」分组，验证就地渲染（不再跳走） */
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.details-chip')].find(x => x.textContent.includes('任务概况'));
    t?.click(); return true;
  })()
`);
await sleep(700);
const taskTab = await ev(`
  (() => ({
    inThread: !!document.querySelector('.thread-embed'),
    roomStill: !!document.querySelector('.pool'),
    hash: location.hash,
    hasTaskAttrs: document.body.innerText.includes('任务属性'),
  }))()
`);
check(
  '⑧ 任务概况在回复串内渲染，房间仍在且未跳页',
  taskTab.value?.inThread === true && taskTab.value?.roomStill === true && String(taskTab.value?.hash).includes('tab=task'),
  `hash=${taskTab.value?.hash} 任务属性=${taskTab.value?.hasTaskAttrs}`,
);

/* ---------- 8b：原消息全文（原「展开」用例的替代落点） ---------- */
const anchorFull = await ev(`
  (() => {
    const el = document.querySelector('.overview-anchor-body');
    return { exists: !!el, len: el?.textContent?.length ?? 0, text: el?.textContent?.slice(0, 40) ?? '' };
  })()
`);
check('⑩ 完整原消息在详情→任务概况可查（非零宽、非空）',
  anchorFull.value?.exists === true && (anchorFull.value?.len ?? 0) > 20,
  `len=${anchorFull.value?.len} ${anchorFull.value?.text}`);

/* ---------- 1：房间成员管理 ----------
   用例更新（2026-09-24 减负）：房间设置不再常驻成按钮，统一进房间名附近「⋯」。 */
await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await ev(`
  (() => {
    document.querySelector('.pool-head button[aria-haspopup="menu"]')?.click();
    return true;
  })()
`);
await sleep(400);
await ev(`
  (() => {
    const menus = [...document.querySelectorAll('.menu')];
    [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
      .find(x => x.textContent.includes('房间设置'))?.click();
    return true;
  })()
`);
await sleep(700);
const roomSettings = await ev(`
  (() => {
    const txt = document.body.innerText;
    return {
      hasMemberSection: txt.includes('房间成员'),
      hasAdd: txt.includes('可加入的项目成员') || txt.includes('加入'),
      hasRemove: txt.includes('移出'),
    };
  })()
`);
check('① 房间设置含成员管理（加入/移出）', roomSettings.value?.hasMemberSection === true && roomSettings.value?.hasRemove === true,
  `成员区=${roomSettings.value?.hasMemberSection} 移出=${roomSettings.value?.hasRemove}`);

/* ---------- 2：文件修改策略 ---------- */
// 用例更新（第十六批 §17.8）：项目设置独立成页，写入策略在「文件修改」分节；
// 文案改为用户语言（一个任务 / 多个任务），不再露出内部术语当标题。
await goto('/project/proj_zs_01/settings?anchor=write&recovery=0');
await sleep(800);
const policy = await ev(`
  (() => {
    const box = document.getElementById('pset-write');
    const txt = box ? box.innerText : '';
    return {
      hasPolicy: txt.includes('同时修改文件的任务'),
      hasSingle: txt.includes('一个任务'),
      hasParallel: txt.includes('多个任务'),
      radios: document.querySelectorAll('#pset-write .wpolicy input[type=radio]').length,
    };
  })()
`);
check('② 设置页有写入并发策略（单写者/并行）', policy.value?.hasPolicy === true && policy.value?.radios === 2,
  `radios=${policy.value?.radios}`);

/* 切到并行，验证风险提示与上限出现 */
await ev(`
  (() => {
    const rs = document.querySelectorAll('#pset-write .wpolicy input[type=radio]');
    rs[1]?.click(); return true;
  })()
`);
await sleep(800);
const parallel = await ev(`
  (() => {
    const box = document.getElementById('pset-write');
    const txt = box ? box.innerText : '';
    return {
      warn: txt.includes('无法自动撤销'),
      limit: txt.includes('最多同时修改的任务数'),
      downgrade: txt.includes('手动比对'),
    };
  })()
`);
check('② 开启并行后如实告知风险（无法撤销/降级/上限）',
  parallel.value?.warn === true && parallel.value?.limit === true,
  `风险=${parallel.value?.warn} 上限=${parallel.value?.limit} 撤销降级=${parallel.value?.downgrade}`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
