/**
 * 验证：新增成员（AGENT-01）。
 *
 * 背景：原型此前**没有添加成员的界面** —— 成员页那个「添加成员」按钮只弹一句
 * toast（"原型不新增成员…"），用户提"现在原型没有添加成员的界面，需要补充一下"。
 *
 * 设计依据与边界：
 *  - 设计报告 **AGENT-01** 要求"创建与持久身份"（名称、handle、描述、runtime、
 *    provider/model），§17.2 成员管理也写"无成员提示添加"——说明这是**必须有**的功能。
 *  - 但 **§15.2 的 UI 命令清单里没有 `member.create`**（只有 `room.members.add/remove`
 *    与 `member.configure`）。按本项目既有纪律，文档未列出的命令面一律用
 *    `LOCAL_ONLY:` 前缀标出，**不假装已有正式契约**。本套件断言这个前缀存在。
 *  - §3.2：Profile（模板）/ ProjectMember（项目身份）/ RuntimeInstallation（执行程序）
 *    三层 ID 不混用；runtime 属于模板，model/effort 属于成员；同名用 ordinal 消歧。
 *  - §10.4：任务中新增房间成员**不自动加入正在运行的研讨**。
 *
 * 只做 UI/交互断言，不接真实 CLI 安装、登录或额度消耗。
 */
const PORT = process.env.ZS_CDP_PORT ?? process.env.ZS_SMOKE_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
if (pages.length === 0) {
  console.error('找不到调试目标，请先启动 `pnpm run desktop:debug`');
  process.exit(1);
}
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++msgId;
  const timer = setTimeout(() => { pending.delete(i); res({}); }, 15000);
  pending.set(i, (m) => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const go = async (hash) => { await ev(`location.hash=${JSON.stringify(hash)}; true`); await sleep(1700); };

/** 重置到种子状态：导航偏好存在 localStorage 里，必须一并清掉 */
const reset = async () => {
  await ev(`localStorage.clear(); true`);
  await go('/welcome?recovery=0');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(3000);
  await ev(`window.zhongshuo?.window.show()`);
  await sleep(500);
  // 关掉可能弹出的恢复提示
  await ev(`
    (() => {
      const m = document.querySelector('.modal');
      if (!m) return false;
      const b = [...m.querySelectorAll('.btn')].find(x => /暂不处理|关闭|取消/.test(x.textContent));
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(500);
};

/** 打开添加成员对话框 */
const openAddDialog = async () => {
  await ev(`
    (() => {
      const b = [...document.querySelectorAll('.btn')].find(x => x.innerText.includes('添加成员'));
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(900);
};

/** 填名称 */
const fillName = async (name) => {
  await ev(`
    (() => {
      const el = document.querySelector('.modal input.input');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(name)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(600);
};

/** 提交对话框 */
const submitDialog = async () => {
  await ev(`
    (() => {
      const foot = document.querySelector('.overlay-foot');
      const b = [...foot.querySelectorAll('.btn')].find(x => x.innerText.includes('添加成员'));
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(1500);
};

/* ============================================================
   1. 入口：成员页有「添加成员」，且不再只弹提示
   ============================================================ */
await reset();
await go('/project/proj_zs_01/members');

const entry = await ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      有按钮: [...document.querySelectorAll('.btn')].some(b => b.innerText.includes('添加成员')),
      旧占位文案: t.includes('原型不新增成员'),
      成员数: document.querySelectorAll('.grid-2 .card').length,
    };
  })()
`);
check('成员页有「添加成员」入口，且已移除"原型不新增成员"的占位提示',
  entry?.有按钮 === true && entry?.旧占位文案 === false,
  `成员数=${entry?.成员数}`);

/* ============================================================
   2. 打开对话框：字段齐全 + 分层显示 + 如实告知
   ============================================================ */
await openAddDialog();
const dialog = await ev(`
  (() => {
    const m = document.querySelector('.modal');
    if (!m) return { 有对话框: false };
    const t = m.innerText;
    const labels = [...m.querySelectorAll('.field-label')].map(e => e.innerText.trim());
    const selects = [...m.querySelectorAll('select')];
    return {
      有对话框: true,
      标题: m.querySelector('.overlay-title')?.innerText.trim(),
      字段: labels,
      有名称: labels.some(x => x.includes('成员名称')),
      有说明: labels.some(x => x.includes('说明')),
      有Runtime: labels.some(x => x.includes('Runtime')),
      有模型: labels.some(x => x.includes('模型')),
      有思考强度: labels.some(x => x.includes('思考强度')),
      runtime选项数: selects[0] ? selects[0].options.length : 0,
      提到模板与成员分层: t.includes('Runtime 属于') && t.includes('模型属于'),
      提到不成为协调者: t.includes('不会') && t.includes('协调者'),
      提到不加入运行中研讨: t.includes('正在运行的研讨'),
      提到原型边界: t.includes('原型边界'),
      提到不真的安装或消耗: t.includes('不会真的安装') || t.includes('不消耗额度'),
    };
  })()
`);
check('对话框包含 AGENT-01 要求的字段（名称/说明/runtime/模型）',
  dialog?.有对话框 === true && dialog?.有名称 && dialog?.有说明
    && dialog?.有Runtime && dialog?.有模型 && dialog?.有思考强度,
  JSON.stringify(dialog?.字段));
check('选择 runtime 时列出本机安装（未就绪状态也如实标注）',
  (dialog?.runtime选项数 ?? 0) >= 2, `选项=${dialog?.runtime选项数}`);
check('说明 runtime 属于模板、模型属于成员（§3.2 分层不混用）',
  dialog?.提到模板与成员分层 === true);
check('如实告知不会自动成为协调者、不加入正在运行的研讨（§10.4）',
  dialog?.提到不成为协调者 === true && dialog?.提到不加入运行中研讨 === true);
check('标注原型边界（不真的安装 CLI、不消耗额度）',
  dialog?.提到原型边界 === true && dialog?.提到不真的安装或消耗 === true);

/* ============================================================
   3. 校验：空名称不提交
   ============================================================ */
await submitDialog();
const blocked = await ev(`
  (() => ({
    仍开着: !!document.querySelector('.modal'),
    错误: document.querySelector('.modal .panel.danger')?.innerText.trim() ?? null,
    成员页卡片数: document.querySelectorAll('.grid-2 .card').length,
  }))()
`);
check('空名称被拦下且有行内错误，不创建成员',
  blocked?.仍开着 === true && String(blocked?.错误).includes('名称') && blocked?.成员页卡片数 === 3,
  JSON.stringify(blocked));

/* ============================================================
   4. 同名成员预告序号（§3.2）
   ============================================================ */
// 种子里已有 Codex 与 Codex#2，新增同名应为 Codex#3
await fillName('Codex');
const ordinalHint = await ev(`
  (() => {
    const t = document.querySelector('.modal')?.innerText ?? '';
    const m = t.match(/这个会显示为\\s*(\\S+?)\\s*以便区分/);
    // 2026-09-24 收尾②：提示语里的规范章节号已移除，序号预告本身不变
    return { 预告: m ? m[1] : null, 无章节号: !/§/.test(t) };
  })()
`);
check('同名前预告将显示的序号（同名用序号消歧）',
  ordinalHint?.预告 === 'Codex#3' && ordinalHint?.无章节号 === true,
  `预告=${ordinalHint?.预告} 无章节号=${ordinalHint?.无章节号}`);

/* ============================================================
   5. 提交后成员真实增加，且进入成员列表
   ============================================================ */
await submitDialog();
const created = await ev(`
  (() => {
    const cards = [...document.querySelectorAll('.grid-2 .card')];
    const texts = cards.map(c => c.innerText);
    return {
      对话框关闭: !document.querySelector('.modal'),
      成员数: cards.length,
      有Codex3: texts.some(t => t.includes('Codex#3')),
      原有成员保留: texts.some(t => t.includes('Codex#2')),
      新成员空闲态: texts.some(t => t.includes('Codex#3') && t.includes('还没有参与过任何任务')),
    };
  })()
`);
check('提交后成员真实增加（不是只弹提示）',
  created?.对话框关闭 === true && created?.成员数 === 4 && created?.有Codex3 === true,
  `成员数=${created?.成员数}`);
check('新成员初始为空闲，不假装正在工作', created?.新成员空闲态 === true);

/* ============================================================
   6. 新成员加入未归档房间，但不进归档房间（§10.4 / CH-07）
   ============================================================ */
await go('/project/proj_zs_01/room/room_dev_hall');
await ev(`
  (() => {
    // 用例更新（2026-09-24 减负）：房间设置统一进房间名附近的「⋯」菜单
    const m = document.querySelector('.pool-head button[aria-haspopup="menu"]');
    if (!m) return false;
    m.click();
    return true;
  })()
`);
await sleep(400);
await ev(`
  (() => {
    const menus = [...document.querySelectorAll('.menu')];
    const b = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
      .find(x => x.textContent.includes('房间设置'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(1200);
const roomMembers = await ev(`
  (() => {
    const d = document.querySelector('.modal') || document.querySelector('.drawer');
    const t = d ? d.innerText : '';
    return {
      弹层打开: !!d,
      含新成员: t.includes('Codex#3'),
      协调者仍是原成员: (d?.innerText ?? '').includes('Codex') && (d?.innerText ?? '').includes('协调者'),
    };
  })()
`);
check('新成员自动加入未归档房间', roomMembers?.含新成员 === true);

// 归档房间不应因新增成员而复活
await go('/project/proj_zs_01/room/room_docs');
const archived = await ev(`
  (() => {
    const t = document.querySelector('.col-main')?.innerText ?? '';
    const m = t.match(/(\\d+) 名成员/);
    return { 成员数: m ? Number(m[1]) : null, 含新成员: t.includes('Codex#3'), 标已归档: t.includes('已归档') };
  })()
`);
check('归档房间不因新增成员而复活（保持只读历史）',
  archived?.成员数 === 1 && archived?.含新成员 === false && archived?.标已归档 === true,
  JSON.stringify(archived));

/* ============================================================
   7. 写入留痕：LOCAL_ONLY 标注 + 房间级命令
   ============================================================ */
await go('/activity');
const log = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('table.tbl tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim());
    return {
      有LocalOnly: rows.some(t => t.includes('LOCAL_ONLY:member.create')),
      有房间命令: rows.some(t => t.includes('room.members.add')),
      member行: rows.find(t => t.includes('member.create')) ?? null,
    };
  })()
`);
check('新增成员留痕用 LOCAL_ONLY 标出（§15.2 尚无 member.create，不冒充正式契约）',
  log?.有LocalOnly === true, String(log?.member行).slice(0, 130));
check('同时按 §15.2 既有命令记录房间成员变更',
  log?.有房间命令 === true);
check('留痕写明未成为协调者、不加入正在运行的研讨',
  String(log?.member行).includes('未成为协调者') && String(log?.member行).includes('不加入正在运行的研讨'),
  String(log?.member行).slice(0, 160));

/* ============================================================
   8. 无成员的项目也能添加（§17.2「无成员提示添加」）
   ============================================================ */
await reset();
await go('/project/proj_docs_03/members');
const emptyProject = await ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      成员数: document.querySelectorAll('.grid-2 .card').length,
      有空态: t.includes('还没有成员'),
      有按钮: [...document.querySelectorAll('.btn')].some(b => b.innerText.includes('添加成员')),
    };
  })()
`);
check('空成员项目显示空态且提供添加入口',
  emptyProject?.成员数 === 0 && emptyProject?.有空态 === true && emptyProject?.有按钮 === true,
  JSON.stringify(emptyProject));

await openAddDialog();
const noRoomNote = await ev(`
  (() => {
    const t = document.querySelector('.modal')?.innerText ?? '';
    const m = t.match(/加入本项目[\\s\\S]{0,60}/);
    return m ? m[0].replace(/\\s+/g, ' ').trim() : null;
  })()
`);
check('没有房间的项目如实说明将加入 0 个房间（不编造）',
  String(noRoomNote).includes('0 个未归档房间'), String(noRoomNote));

await fillName('审计者');
await submitDialog();
const emptyCreated = await ev(`
  (() => {
    const cards = [...document.querySelectorAll('.grid-2 .card')];
    return {
      成员数: cards.length,
      含新成员: cards.some(c => c.innerText.includes('审计者')),
    };
  })()
`);
check('无房间的项目仍可创建成员',
  emptyCreated?.成员数 === 1 && emptyCreated?.含新成员 === true, JSON.stringify(emptyCreated));

/* ============================================================
   9. runtime 未就绪：允许创建但如实告知不能派工（§9.5）
   ============================================================
   数据缺口说明（已实测确认）：种子里**两个 runtime 都是 ready**，
   而决策 37 定"首版仅 Codex App Server 与 Claude Code headless"，
   不能为演示而永久加第三个 runtime（会与设计报告冲突）。
   所以这条分支在默认种子上跑不到 —— 本轮用"临时把种子改成 not_installed →
   构建 → 验证 → 立即还原"的方式人工验证过，结论：
     · 下拉如实显示「Claude Code（headless） · 未安装」
     · 出现警示面板，写明"本机没有检测到它的可执行文件"
     · 明说"仍然可以先建好成员（配置会保存）"，并指向「应用设置 → 执行工具」
     · 提交**不阻断**，成员卡片状态为"本机未安装这个 runtime，成员建好后还不能派工"
   这里保留能自动跑的断言：**已就绪时不误报警示**（防止把可用 runtime 误判成不可用）。 */
await reset();
await go('/project/proj_zs_01/members');
await openAddDialog();
const rtGate = await ev(`
  (() => {
    const m = document.querySelector('.modal');
    const sel = m?.querySelector('select');
    if (!sel) return { 有选择器: false };
    const opts = [...sel.options].map(o => o.text.trim());
    return {
      有选择器: true,
      全部选项: opts,
      当前是否显示警示: !!m.querySelector('.panel.warning'),
      每项都带状态: opts.every(o => /已就绪|未安装|未登录|未验证|版本不兼容/.test(o)),
    };
  })()
`);
check('runtime 下拉每项都带自己的状态（未安装/未登录/未验证分开，不合并成"不可用"）',
  rtGate?.有选择器 === true && rtGate?.每项都带状态 === true,
  JSON.stringify(rtGate?.全部选项));
check('runtime 已就绪时不误报"不能派工"警示',
  rtGate?.当前是否显示警示 === false);

/* ============================================================
   10. 取消不产生副作用
   ============================================================ */
await ev(`
  (() => {
    const foot = document.querySelector('.overlay-foot');
    const b = [...foot.querySelectorAll('.btn')].find(x => x.innerText.includes('取消'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(900);
const cancelled = await ev(`
  (() => ({
    对话框关闭: !document.querySelector('.modal'),
    成员数: document.querySelectorAll('.grid-2 .card').length,
  }))()
`);
check('取消关闭对话框且不新增成员',
  cancelled?.对话框关闭 === true && cancelled?.成员数 === 3, JSON.stringify(cancelled));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
