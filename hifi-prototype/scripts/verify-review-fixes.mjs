/**
 * 验证第三方评审提出的缺陷是否真的修好了。
 * 每条都对应评审里的一个具体指控，用 CDP 在真实 Electron 窗口里实测。
 *
 * 用法：pnpm run desktop:debug 之后 node scripts/verify-review-fixes.mjs
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
            const i = ++id;
            const t = setTimeout(() => {
              pend.delete(i);
              res({});
            }, 12000);
            pend.set(i, (m) => {
              clearTimeout(t);
              res(m);
            });
            ws.send(JSON.stringify({ id: i, method, params }));
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

/**
 * 站内导航：只改 hash，不 reload。
 * 原型是内存态，reload 会回到种子；而 §17.4 的草稿要求讲的是"切到另一个线程
 * 时不转移、不丢失"，属于站内导航语义 —— 因此必须用这种方式验证。
 */
const navigateInApp = async (hash) => {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(900);
};
const clickText = (sel, text) => ev(`
  (() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)}));
    if (!el) return 'NOT_FOUND';
    el.click(); return 'ok';
  })()
`);

/* ============ 指控 9：同 tick 双击会创建两个任务 ============ */
await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
const beforeDbl = await ev(`document.querySelectorAll('.root-card').length`);
await ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(ta, '回归：同 tick 双击应只建 1 个任务');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()
`);
await sleep(400);
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.composer-toolbar .btn.primary')].find(x=>x.textContent.includes('发送'));
    b.click(); b.click();
    return true;
  })()
`);
await sleep(1200);
const afterDbl = await ev(`document.querySelectorAll('.root-card').length`);
check(
  '⑨ 同 tick 双击只创建一个任务（§17.4 不变量）',
  afterDbl.value - beforeDbl.value === 1,
  `新增 ${afterDbl.value - beforeDbl.value} 个`,
);

/* ============ 指控 1：线程草稿未保存（切走即丢） ============ */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
await ev(`
  (() => {
    const ta = document.querySelector('.col-thread .composer-input');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(ta, '草稿A：这段文字应该在切走后仍然存在');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()
`);
await sleep(500);
/* 用例更新（2026-09-24 减负 §6.2）：普通保存成功不再常驻占位
   （原来那枚"草稿已保留"的勾几乎永远为真、没有信息量）；
   失败才显示。这里断言"成功时不占位"，草稿真的还在由下一条用例保证。 */
const draftHint = await ev(`!!document.querySelector('.col-thread .composer-draft')`);
check('① 草稿保存成功不再常驻占位（失败才提示）', draftHint.value === false,
  `composer-draft=${draftHint.value}`);

// 切到另一个线程（站内切换，不 reload —— reload 会重置内存态）
await navigateInApp('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&recovery=0');
// 再切回来
await navigateInApp('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
const draftBack = await ev(`document.querySelector('.col-thread .composer-input')?.value ?? ''`);
check(
  '① 切走再切回，线程草稿仍在（§17.4 分别保存）',
  String(draftBack.value).includes('草稿A'),
  `实际值 = ${JSON.stringify(String(draftBack.value).slice(0, 30))}`,
);

// 主池草稿与线程草稿互不转移（同样用站内切换）
await navigateInApp('/project/proj_zs_01/room/room_dev_hall?recovery=0');
const poolDraft = await ev(`document.querySelector('.col-main .composer-input')?.value ?? ''`);
check(
  '① 主池草稿未被线程草稿污染（TH-04 不串草稿）',
  !String(poolDraft.value).includes('草稿A'),
  `主池 = ${JSON.stringify(String(poolDraft.value).slice(0, 24))}`,
);

// 反向：在主池写草稿，切到线程再回来，主池草稿应还在
await ev(`
  (() => {
    const ta = document.querySelector('.col-main .composer-input');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(ta, '草稿B：主池的');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()
`);
await sleep(400);
await navigateInApp('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
const threadDraftStill = await ev(`document.querySelector('.col-thread .composer-input')?.value ?? ''`);
check(
  '① 切到线程后线程草稿仍是自己的（不是主池的）',
  String(threadDraftStill.value).includes('草稿A') && !String(threadDraftStill.value).includes('草稿B'),
  JSON.stringify(String(threadDraftStill.value).slice(0, 26)),
);
await navigateInApp('/project/proj_zs_01/room/room_dev_hall?recovery=0');
const poolDraftBack = await ev(`document.querySelector('.col-main .composer-input')?.value ?? ''`);
check(
  '① 回到主池后主池草稿仍在',
  String(poolDraftBack.value).includes('草稿B'),
  JSON.stringify(String(poolDraftBack.value).slice(0, 26)),
);

/* ---------- 指控 2：跟进名单的位置 ----------
   评审当时指出「被挪进 tab，与 §25.4/E2『线程顶部』拍板不符」，我据此回归了顶部；
   但随后用户明确要求「把这一行整个去掉，都在成员 tab 里管理」。
   因此现在断言的是：顶部不再有该行，且成员 tab 保留完整能力。
   （§25.4/E2 的"线程级跟进名单"能力仍在，只是收敛到一个入口。） */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
const followers = await ev(`
  (() => ({
    rowInHead: !!document.querySelector('.thread-head .followers'),
    headGone: !document.querySelector('.thread-head'),
    memberTab: [...document.querySelectorAll('.thread-tab')].some((t) => t.textContent.includes('成员')),
  }))()
`);
check(
  '② 线程顶部不再有跟进名单行（用户要求：都在成员管理入口里）',
  followers.value?.rowInHead === false,
  `顶部有该行=${followers.value?.rowInHead} 顶部已删除=${followers.value?.headGone}`,
);
/* 用例更新（2026-09-24 减负 §2.2）：跟进管理不再是一个常驻「成员」页签，
   而是「详情 → 参与成员」分组；能力与入口归属不变。 */
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.col-thread .thread-tab')].find(x => x.textContent.includes('详情'));
    t?.click(); return true;
  })()
`);
await sleep(400);
const memberGroup = await ev(`
  [...document.querySelectorAll('.details-chip')].some((c) => c.textContent.includes('参与成员'))
`);
check('② 参与成员分组仍在（跟进管理能力未丢）', memberGroup.value === true);

/* ============ 指控 3：发送前不显示推导预算 ============ */
await ev(`
  (() => {
    const ta = document.querySelector('.col-main .composer-input');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    s.call(ta, '预算推导测试');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()
`);
await sleep(300);
// 选 @全体 → DELIBERATE，应出现 7N+2 推导
await ev(`
  (() => {
    const at = [...document.querySelectorAll('.composer-toolbar .icon-btn')].find(b => b.title?.includes('提及'));
    at?.click(); return true;
  })()
`);
await sleep(400);
await clickText('.mention-pop .menu-item', '全体');
await sleep(500);
const budget = await ev(`
  (() => {
    const b = document.querySelector('.composer-budget');
    return { shown: !!b, text: b?.textContent?.trim() ?? null, title: b?.title ?? null };
  })()
`);
check(
  // 评审意见 5：主界面不裸露 7N+2 这类公式，只给数字；公式仍保留在「本次运行设置」里。
  // 工具条里的 chip（文案「最多 N 次」）在 DELIBERATE 下继续常驻（E12）。
  '③ 发送前显示推导后的调用上限（E12）',
  budget.value?.shown === true && /最多\s*\d+\s*次/.test(String(budget.value?.text)),
  budget.value?.text ?? '(无预算预览)',
);
// 用例更新（2026-09-24 减负 §6.1）：推导明细从 chip 的 tooltip 移入「本次运行设置」，
// 业务要求（公式可查、不裸露在主界面）不变。
await ev(`
  (() => {
    const btn = document.querySelector('.col-main .composer-toolbar button[aria-label="本次运行设置"]');
    if (btn) btn.click();
    return !!btn;
  })()
`);
await sleep(400);
const budgetDetail = await ev(`
  (() => {
    const menus = [...document.querySelectorAll('.menu')];
    return menus.at(-1)?.innerText ?? '';
  })()
`);
check(
  '③ 预算推导明细（SYNTHESIS/RATIFY 尾部配额）在「本次运行设置」可查',
  String(budgetDetail.value).includes('SYNTHESIS') && String(budgetDetail.value).includes('RATIFY'),
  String(budgetDetail.value).replace(/\n/g, ' | ').slice(0, 90),
);
await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(250);
/* 收尾：清掉本步输入的草稿（"预算推导测试" + @全体）。
   2026-09-25 起，草稿**持久化到 localStorage**（用户要求"刷新后仅记录意图还在"），
   于是本脚本留下的草稿会活过 reload，把后面"空输入区 = AUTO 不常驻预算 chip"的
   用例（verify-composer-clean）打成红的 —— 实测就是这么发现的。
   各用例的前置条件由各自掌握：这里清掉自己造的那一份。 */
await ev(`
  (() => {
    try {
      const key = 'zhongshuo.drafts.v2';
      const all = JSON.parse(localStorage.getItem(key) ?? '{}');
      delete all['room:room_dev_hall'];
      localStorage.setItem(key, JSON.stringify(all));
    } catch { /* 存储不可用时不必清理 */ }
    return true;
  })()
`);
await sleep(200);

/* ============ 指控 4：E9 六项 M3 入口缺 3 个 ============ */
// 文件选区评论 + 附件七类（房间 → 文件 tab）
await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await clickText('.thread-tabs .thread-tab', '文件');
await sleep(600);
const filesTab = await ev(`
  (() => {
    const t = document.body.innerText;
    return {
      sevenTypes: ['PDF','Word','Excel','PowerPoint','CSV'].every(k => t.includes(k)),
      parseCaveat: t.includes('无法解析') || t.includes('可保存/预览'),
      commentEntry: t.includes('选区评论'),
      m3Badge: t.includes('M3 批次') || t.includes('M3'),
    };
  })()
`);
check('④ 附件七类格式入口 + M3 标注', filesTab.value?.sevenTypes === true && filesTab.value?.m3Badge === true,
  `七类=${filesTab.value?.sevenTypes} M3=${filesTab.value?.m3Badge}`);
check('④ 附件解析兜底文案（"可保存/预览，当前成员无法解析"）', filesTab.value?.parseCaveat === true);
check('④ 文件选区评论入口（决策 33）', filesTab.value?.commentEntry === true);

// 点开评论弹窗，验证五类锚点
await clickText('.card button', '文件选区评论');
await sleep(600);
const commentModal = await ev(`
  (() => {
    const t = document.body.innerText;
    return {
      open: t.includes('支持的五类锚点'),
      anchors: ['Markdown 段落','单/多行','CSV','HTML','视频时间点'].every(k => t.includes(k)),
      pdfCaveat: t.includes('不支持 PDF/图片'),
      versionAnchor: t.includes('artifactId'),
    };
  })()
`);
check('④ 选区评论含五类锚点与"PDF/图片不支持"如实说明',
  commentModal.value?.open === true && commentModal.value?.anchors === true && commentModal.value?.pdfCaveat === true,
  `锚点=${commentModal.value?.anchors} PDF免责=${commentModal.value?.pdfCaveat}`);
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.overlay-foot .btn')].find(x => x.textContent.includes('关闭'));
    b?.click(); return true;
  })()
`);
await sleep(400);

// 浏览器访问 / 局域网配对：**M3 批次编号已移除**（第二十八批 §2.5）。
//
// 这是一次有意识的决定翻转（E9 之后特意补的标签，现在按"内部批次编号不进正文"的
// 既有约定（设置分离方案 §3 第 3 条）撤掉），所以检查本身也改写成**新口径**：
// 正文不得出现内部编号，但配对的权限说明必须仍在（那才是用户要判断的东西）。
// 不是加白名单绕过 —— 断言从"有 M3 标签"改成"无内部编号 + 有权限说明"。
await goto('/settings?section=lan&recovery=0');
await sleep(700);
const lanCard = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const card = [...(body?.querySelectorAll('.card') ?? [])]
      .find(c => c.textContent.includes('生成配对码'));
    const t = body?.innerText ?? '';
    return {
      card: card?.textContent ?? null,
      无内部编号: !/M3|批次/.test(t),
      有权限说明: t.includes('配对的设备拥有和本机一样的权限'),
      在连接与设备分区: true,
    };
  })()
`);
check('④ 局域网访问入口不再标内部批次编号，且配对权限说明仍在（E9 标签撤销，第二十八批 §2.5）',
  String(lanCard.value?.card ?? '').length > 0 && lanCard.value?.无内部编号 === true && lanCard.value?.有权限说明 === true,
  String(JSON.stringify(lanCard.value)).slice(0, 160));

/* ============ 指控 6：取消归档无入口 ============ */
/* 用例更新（2026-09-24 减负 §3）：房间设置/归档统一进房间名附近「⋯」；
   归档房的「取消归档」是该状态的唯一出口，必须在菜单里保留**可见名称**。 */
await goto('/project/proj_zs_01/room/room_docs?recovery=0');
await ev(`
  (() => {
    document.querySelector('.pool-head button[aria-haspopup="menu"]')?.click();
    return true;
  })()
`);
await sleep(400);
const unarchive = await ev(`
  (() => {
    const menus = [...document.querySelectorAll('.menu')];
    const item = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
      .find(x => x.textContent.includes('取消归档'));
    return { present: !!item, title: item?.textContent?.trim() ?? null };
  })()
`);
check('⑥ 已归档房间在房间 ⋯ 里有可见的「取消归档」入口（§25.6）', unarchive.value?.present === true, unarchive.value?.title ?? '');

/* ============ 指控 7：E4 缺席容忍"可设置"没有设置项 ============ */
// 用例更新（第十六批 §17.8）：项目设置独立成页，协作限制在 `/project/:id/settings`；
// 文案改为用户语言（"成员无响应后继续"），内部字段名不再当标题。
await goto('/project/proj_zs_01/settings?anchor=collab&recovery=0');
await sleep(800);
const loopSettings = await ev(`
  (() => {
    const box = document.getElementById('pset-collab');
    const t = box ? box.innerText : '';
    return {
      absence: t.includes('成员无响应后继续'),
      deadline: t.includes('单次分析最长运行') && t.includes('单次修改最长运行'),
      inputs: document.querySelectorAll('#pset-collab input[type=number]').length,
    };
  })()
`);
check('⑦ 缺席容忍可设置（E4）', loopSettings.value?.absence === true && (loopSettings.value?.inputs ?? 0) >= 1,
  `number 输入框 ${loopSettings.value?.inputs} 个`);
check('⑦ turnDeadline 可设置且与 absentGrace 分开', loopSettings.value?.deadline === true);

/* ============ 指控 5：WORKSPACE_BUSY 文案未随 v1.9 更新 ============ */
// 用例更新（第十六批 §17.8）：错误码速查并入「诊断与帮助」的可展开内容。
// 旧 `section=errors` 会规范化到 diagnostics&anchor=errors 并自动展开。
await goto('/settings?section=errors&recovery=0');
await sleep(800);
const busyCopy = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('table.tbl tr')];
    const r = rows.find(x => x.textContent.includes('WORKSPACE_BUSY'));
    return r?.textContent ?? null;
  })()
`);
check(
  '⑤ WORKSPACE_BUSY 文案含并行模式的写入者名单/策略/上限',
  String(busyCopy.value).includes('并行') && String(busyCopy.value).includes('上限'),
  String(busyCopy.value).replace(/\s+/g, ' ').slice(0, 70),
);

/* ============ 指控 11：死链（复制应用内链接落到欢迎页） ============ */
await goto('/thread/thread_t12?message=' + (await ev(`(document.querySelector('.msg')?.id ?? '').replace('msg-','')`)).value);
await sleep(900);
const deepLink = await ev(`
  (() => ({
    hash: location.hash,
    hasPool: !!document.querySelector('.pool'),
    hasThread: !!document.querySelector('.col-thread'),
    hasMsgs: document.querySelectorAll('.msg').length > 0,
  }))()
`);
check(
  '⑪ #/thread/:id?message= 直达链接能定位到线程（修死链）',
  deepLink.value?.hasThread === true && deepLink.value?.hasMsgs === true,
  `hash=${deepLink.value?.hash}`,
);

/* ============ 指控 10：授权处理后待办不消失 ============ */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&recovery=0');
const approvalBefore = await ev(`
  (() => {
    const b = [...document.querySelectorAll('.approval-card .btn')].find(x => x.textContent.includes('仅本次允许'));
    return { found: !!b };
  })()
`);
check('⑩ 线程内存在待处理的授权卡', approvalBefore.value?.found === true);

if (approvalBefore.value?.found) {
  await clickText('.approval-card .btn', '仅本次允许');
  await sleep(900);
}
// 站内切到「待我处理」（不 reload，否则内存态重置、无法验证）
await navigateInApp('/activity?recovery=0');
const attention = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.card')].map(c => c.textContent ?? '');
    const stillAction = rows.some(r => r.includes('请求执行 git commit') && r.includes('需要动作'));
    return { stillAction };
  })()
`);
check(
  '⑩ 授权处理后在「待我处理」中不再是待动作',
  attention.value?.stillAction === false,
  `仍显示需要动作=${attention.value?.stillAction}`,
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
