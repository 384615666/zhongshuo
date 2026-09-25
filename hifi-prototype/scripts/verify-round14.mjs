/**
 * 验证第十四项反馈的 4 条改动。
 *  1. 点开任务详情不再有弹窗（详情全部在回复串 tab 内就地渲染）
 *  2. 私信原型：可选任意项目成员、可建多个私聊（同一成员多条）、可归档/取消归档
 *  3. 跟进名单不再有「管理」按钮（统一到成员 tab）
 *  4. 研讨详情也在 tab 里，不再单独界面
 */

const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
      if (pages.length) {
        const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });
        let id = 0;
        const pend = new Map();
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pend.has(m.id)) {
            pend.get(m.id)(m);
            pend.delete(m.id);
          }
        };
        const send = (method, params = {}) =>
          new Promise((res) => {
            const i2 = ++id;
            const t = setTimeout(() => {
              pend.delete(i2);
              res({});
            }, 12000);
            pend.set(i2, (m) => {
              clearTimeout(t);
              res(m);
            });
            ws.send(JSON.stringify({ id: i2, method, params }));
          });
        return { ws, send };
      }
    } catch {
      /* 未就绪 */
    }
    await sleep(300);
  }
  throw new Error(`连不上 ${PORT}`);
}

const { ws, send } = await connect();
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

await ev(`window.zhongshuo?.window.show()`);
await sleep(600);

const goto = async (hash) => {
  await ev(`location.hash=${JSON.stringify(hash)}; location.reload(); true`);
  await sleep(2800);
};
const clickText = (sel, text) => ev(`
  (() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)}));
    if (!el) return 'NOT_FOUND';
    el.click(); return 'ok';
  })()
`);

/* ============ 1. 任务详情不再弹窗（减负后：详情 → 任务概况分组） ============ */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
const beforeClick = await ev(`
  (() => ({ overlay: !!document.querySelector('.detail-overlay'), pool: !!document.querySelector('.pool') }))()
`);
await clickText('.col-thread .thread-tab', '详情');
await sleep(500);
await clickText('.details-chip', '任务概况');
await sleep(900);
const afterClick = await ev(`
  (() => ({
    overlay: !!document.querySelector('.detail-overlay'),
    embedded: !!document.querySelector('.thread-embed'),
    hasTaskAttrs: document.body.innerText.includes('任务属性'),
    hash: location.hash,
  }))()
`);
check('① 点「详情 → 任务概况」不再出现弹窗（无 .detail-overlay）', afterClick.value?.overlay === false,
  `弹窗=${afterClick.value?.overlay} 就地渲染=${afterClick.value?.embedded}`);
check('① 任务概况在详情分组内就地渲染且 URL 带 tab=task',
  afterClick.value?.hasTaskAttrs === true && String(afterClick.value?.hash).includes('tab=task'),
  `hash=${afterClick.value?.hash}`);

/* 旧深链 /task/xxx 也应重定向到 tab，而不是弹窗 */
await goto('/task/task_12');
const legacy = await ev(`
  (() => ({ hash: location.hash, overlay: !!document.querySelector('.detail-overlay'), embedded: !!document.querySelector('.thread-embed') }))()
`);
check('① 旧深链 /task/:id 重定向到 tab（不弹窗）',
  legacy.value?.overlay === false && String(legacy.value?.hash).includes('tab=task'),
  `→ ${legacy.value?.hash}`);

/* ============ 3. 跟进名单整行已从线程顶部移除（减负后入口在详情分组） ============ */
const followers = await ev(`
  (() => {
    const head = document.querySelector('.thread-head');
    const f = document.querySelector('.thread-head .followers');
    return {
      // 线程顶部不应再有跟进名单这一行（顶部两行整体已删除）
      stillInHead: !!f,
      headGone: !head,
      headText: head ? head.innerText.replace(/\\n+/g, ' | ').slice(0, 120) : null,
    };
  })()
`);
check('③ 线程顶部已无跟进名单整行', followers.value?.stillInHead === false && followers.value?.headGone === true,
  `线程顶部=${(followers.value?.headText ?? '')?.slice(0, 70) ?? '(已删除)'}`);

/* 打开详情 → 参与成员，验证管理能力未丢 */
await clickText('.col-thread .thread-tab', '详情');
await sleep(500);
const hasMemberGroup = await ev(`
  [...document.querySelectorAll('.details-chip')].some((c) => c.textContent.includes('参与成员'))
`);
check('③ 参与成员分组仍在（管理能力未丢）', hasMemberGroup.value === true);

/* 参与成员里仍可管理：移出必然可用；"加入跟进"只对尚未跟进的成员显示，
   所以这里先移出一个成员，验证它出现在"可加入"区（闭环验证增删） */
await clickText('.details-chip', '参与成员');
await sleep(700);
const memberTab = await ev(`
  (() => {
    const t = document.body.innerText;
    return { canRemove: t.includes('移出跟进'), whoFollows: t.includes('正在跟进') };
  })()
`);
check('③ 参与成员分组内可移出跟进成员', memberTab.value?.canRemove === true, JSON.stringify(memberTab.value));

// 移出一个 → 它应出现在"房间其他成员"里，并可再次加入
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('移出跟进'));
    if (b) b.click();
    return true;
  })()
`);
await sleep(800);
const afterRemove = await ev(`
  (() => {
    const t = document.body.innerText;
    return { hasAdd: t.includes('加入跟进'), hasSection: t.includes('房间其他成员') };
  })()
`);
check('③ 移出后该成员出现在「房间其他成员」且可加入（增删闭环）',
  afterRemove.value?.hasAdd === true && afterRemove.value?.hasSection === true,
  JSON.stringify(afterRemove.value));

/* ============ 4. 研讨详情 / 运行详情在详情分组内 ============ */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
await clickText('.col-thread .thread-tab', '详情');
await sleep(500);
await clickText('.details-chip', '研讨详情');
await sleep(900);
const delib = await ev(`
  (() => ({
    overlay: !!document.querySelector('.detail-overlay'),
    embedded: !!document.querySelector('.thread-embed'),
    hasMatrix: document.body.innerText.includes('确认矩阵'),
    hash: location.hash,
  }))()
`);
check('④ 研讨详情在详情分组内渲染，不再单独界面/弹窗',
  delib.value?.overlay === false && delib.value?.embedded === true && delib.value?.hasMatrix === true,
  `弹窗=${delib.value?.overlay} 确认矩阵=${delib.value?.hasMatrix}`);

/* 运行详情也应进详情分组 */
await clickText('.details-chip', '运行详情');
await sleep(900);
const runTab = await ev(`document.body.innerText.includes('用量与费用') || document.body.innerText.includes('成员调用')`);
check('④ 运行详情也可在详情分组内查看', runTab.value === true);

/* ============ 2. 私信原型 ============ */
await goto('/dm?recovery=0');
const dmList = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.dm-row')];
    const txt = document.body.innerText;
    return {
      rowCount: rows.length,
      hasCreate: !!document.querySelector('.btn.primary'),
      hasArchived: txt.includes('已归档'),
      hasM3: txt.includes('M3'),
    };
  })()
`);
check('② 私信页列出多个会话（含同一成员的多条）', (dmList.value?.rowCount ?? 0) >= 3,
  `${dmList.value?.rowCount} 条会话`);
check('② 私信页有归档区与 M3 标注', dmList.value?.hasArchived === true && dmList.value?.hasM3 === true,
  `归档=${dmList.value?.hasArchived} M3=${dmList.value?.hasM3}`);

/* 新建私聊：可选成员。
   用例迁移（2026-09-25 用户决定）：私聊收敛为 **1 对 1**，弹窗从"多选组小群"
   改为单选 —— 断言的**能力**仍是"能从成员里选人建私聊"，只是选择语义变了：
   单选、且连点两位只保留一位（不允许再组小群）。标准没有放宽。 */
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.btn.primary')].find(x => x.textContent.trim() === '' || x.querySelector('svg'));
    const all = [...document.querySelectorAll('.pool-head .btn.primary, .col-main .btn.primary')];
    if (all[0]) { all[0].click(); return 'ok'; }
    return 'NOT_FOUND';
  })()
`);
await sleep(700);
const createModal = await ev(`
  (() => {
    const t = document.body.innerText;
    const inputs = [...document.querySelectorAll('.modal .wpolicy input')];
    inputs[0]?.click();
    inputs[1]?.click();
    return {
      open: t.includes('新建私聊'),
      radios: inputs.filter((i) => i.type === 'radio').length,
      checkboxes: inputs.filter((i) => i.type === 'checkbox').length,
      checkedAfterTwoClicks: inputs.filter((i) => i.checked).length,
      noGroupCopy: !t.includes('小群') && !t.includes('多选'),
    };
  })()
`);
check('② 新建私聊：可从成员里选人，且为 1 对 1 单选（不再支持多选组小群）',
  createModal.value?.open === true && createModal.value?.radios >= 2
    && createModal.value?.checkboxes === 0 && createModal.value?.checkedAfterTwoClicks === 1
    && createModal.value?.noGroupCopy === true,
  `对话框=${createModal.value?.open} 单选=${createModal.value?.radios} 复选框=${createModal.value?.checkboxes} 连点两位后选中=${createModal.value?.checkedAfterTwoClicks}`);

/* 同一成员可建多条：先数已有的 Claude 会话数 */
const claudeCountBefore = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.dm-row')].filter(r => r.textContent.includes('Claude'));
    return rows.length;
  })()
`);
// 选一个成员并创建（2026-09-25 起是单选 radio）
await ev(`
  (() => {
    const radios = [...document.querySelectorAll('.modal .wpolicy input[type=radio]')];
    if (radios[0]) radios[0].click();
    return true;
  })()
`);
await sleep(300);
await clickText('.modal .overlay-foot .btn', '创建');
await sleep(900);
const created = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.dm-row')];
    return { total: rows.length, modalGone: !document.body.innerText.includes('新建私聊：') };
  })()
`);
check('② 创建后会话列表增加一条', created.value?.total > (dmList.value?.rowCount ?? 0),
  `${dmList.value?.rowCount} → ${created.value?.total}`);

/* 归档：点会话行的归档按钮 → 确认 */
const archiveOpened = await ev(`
  (() => {
    const b = [...document.querySelectorAll('.dm-row .icon-btn')].find(x => (x.title || '').includes('归档'));
    if (!b) return 'NOT_FOUND';
    b.click(); return 'ok';
  })()
`);
await sleep(700);
const archiveModal = await ev(`document.body.innerText.includes('归档后会发生什么') || document.body.innerText.includes('归档这个私聊')`);
check('② 归档有确认对话框并说明只读语义', archiveModal.value === true);
await clickText('.modal .overlay-foot .btn', '归档');
await sleep(900);
/* 归档后：会话进入「已归档 N」折叠区；展开它，再选中，才出现「取消归档」。
   这里按真实交互顺序验证，而不是假设入口一直可见。 */
await ev(`document.querySelector('.dm-archived-toggle')?.click(); true`);
await sleep(700);
const archiveSection = await ev(`
  (() => ({
    archivedRows: document.querySelectorAll('.dm-row.archived').length,
    toggleText: document.querySelector('.dm-archived-toggle')?.textContent?.trim() ?? null,
  }))()
`);
check('② 归档后会话进入「已归档」折叠区',
  (archiveSection.value?.archivedRows ?? 0) >= 1,
  `${archiveSection.value?.toggleText}`);

const archivedReadonly = await ev(`
  (() => {
    const row = document.querySelector('.dm-row.archived');
    if (!row) return 'NO_ARCHIVED_ROW';
    row.click();
    return 'clicked';
  })()
`);
await sleep(900);
const ro = await ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    return {
      disabled: ta?.disabled === true,
      placeholder: ta?.placeholder ?? '',
      hasUnarchive: [...document.querySelectorAll('.btn')].some((b) => b.textContent.includes('取消归档')),
    };
  })()
`);
check('② 已归档会话为只读（输入框禁用）', ro.value?.disabled === true, ro.value?.placeholder);
check('② 选中已归档会话后提供「取消归档」', ro.value?.hasUnarchive === true,
  String(archivedReadonly.value));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
