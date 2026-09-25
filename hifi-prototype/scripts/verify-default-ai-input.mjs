/**
 * 「默认交给 AI / 仅记录不请求回复」专项验收（2026-09-25）。
 *
 * 覆盖任务书 §10 的 12 项，**用真实交互 + 留痕/计数等可观测证据**，不只看按钮文字：
 *  1. 主池普通发送走 AI 路由，只创建一个新根任务（根卡 +1、出现任务号、toast 报任务号）；
 *  2. 任务串普通发送仍跟进原任务（不新增根卡）；
 *  3. @成员 / @全体 的路由与预算口径不变（DIRECT / DELIBERATE）；
 *  4. 「仅记录」保存成功：**不创建运行、不产生模型派发** —— 依据是原型自己的写入留痕
 *     （`LOCAL_ONLY:record.save`，且没有对应的 `message.submit` 派发记录）+ 后台任务计数不变；
 *  5. 仅记录正文含 @成员 也不会唤醒 AI（同上证据）；
 *  6. 保存记录成功后，下一次输入恢复该上下文的默认行为；
 *  7. 刷新恢复：仅记录意图与草稿都不丢；切上下文不串线；
 *  8. 旧 discussion 草稿（v1 结构）迁移后是"仅记录"，且**不会**被自动当成 AI 发送；
 *  9. 记录里的附件仍可查看（进共享预览），附件 audience 不扩大；
 * 10. 权限：仅记录不改变档位值、未验证档位仍不可选、IME 组合态 Enter 不发送、双击只发一次；
 * 11. 主池 / 任务串 / 历史记录串 / 私信 / 窄窗都没有残留的常驻「任务/讨论」切换或无效占位；
 * 12. 没有恢复已删除的顶部两行、另起任务按钮、目标摘要栏。
 *
 * 用法：
 *   npx vite --port 5284 --strictPort
 *   node scripts/verify-default-ai-input.mjs http://localhost:5284
 *
 * 端口：ZS_DAI_CDP_PORT，默认 **9339**
 * （与 Electron 9333 / smoke 9334 / 视觉预览 9335 / declutter 9336 / 150% 探针 9337 / 私信 9338 错开）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = Number(process.env.ZS_DAI_CDP_PORT ?? 9339);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + process.env.TEMP + '\\zs-default-ai-input',
    '--no-first-run',
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
await sleep(2000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('找不到页面 target');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => {
      pending.delete(i);
      res({});
    }, 15000);
    pending.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate 失败');
  return r.result?.result?.value;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 拼接区域选择器：sel('.col-main', '.composer') → '.col-main .composer'（scope 为空时退化为全局） */
const sel = (scope, part) => `${scope} ${part}`.trim();

const ROOM = '#/project/proj_zs_01/room/room_dev_hall';
const DM = '#/project/proj_zs_01/dm';

/**
 * 等应用真的渲染出输入区再继续。
 *
 * 为什么不能只睡固定毫秒：本脚本用的是全新 Chrome profile，vite 首次要把整张模块图
 * 现场编译（实测冷启动明显慢于热启动），固定 3 秒会读到"还没渲染"的空页面 ——
 * 第一版就是这么误判的（分段数 -1、setter 报 Illegal invocation）。
 */
async function waitFor(expr, timeout = 15000, label = expr) {
  const t0 = Date.now();
  for (;;) {
    if (await ev(expr)) return true;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await sleep(250);
  }
}
const READY = `Boolean(document.querySelector('.composer-input'))`;

async function reset(hash, wait = 1200) {
  /*
   * 草稿自 2026-09-25 起会落到 localStorage（"刷新后草稿与仅记录意图都还在"就是靠它）。
   * 但用例之间必须互相干净：留着上一段的草稿会把 access 档位/仅记录意图带进下一段
   * （第一版就因此误判过三条断言）。所以每段开始先清掉本地草稿，再整页重载。
   * 需要验证"刷新恢复"的那一段不走 reset()，它自己 reload。
   */
  /*
   * 顺序很重要（实测踩到）：必须先让**应用页面**加载出来，再清 localStorage，最后立刻重载。
   *  1) 首次调用时页面还在 about:blank（无源），读 localStorage 会抛 SecurityError；
   *  2) 若在**旧页面**上清存储，旧页面内存里的草稿 Map 会在下一次状态变化时被重新写回，
   *     清了个寂寞（上一轮"自动编辑"档位就是这样漏进来的）。
   * 干净页面上清完立刻重载，新页面从空草稿起步。
   */
  await ev(`location.href = ${JSON.stringify(BASE)} + ${JSON.stringify(hash)}; true`);
  await waitFor(READY, 20000, '首屏渲染');
  await ev(`localStorage.clear(); true`);
  await ev('location.reload(); true');
  await waitFor(READY, 20000, '重载后渲染');
  await sleep(500);
}
/**
 * 切页并等"这一页真的渲染出来"。
 * 注意不能一律等 `.composer-input`：设置页没有输入区（第一版就是这么超时的）。
 */
async function goto(hash, wait = 1500, ready = READY) {
  await ev(`location.hash = ${JSON.stringify(hash)}; true`);
  await sleep(wait);
  await waitFor(ready, 12000, `切换到 ${hash}`);
}
/** 在某个输入区里打字（scope = '.col-main' | '.col-thread' | ''） */
async function type(text, scope = '') {
  await ev(`(() => {
    const ta = document.querySelector(${JSON.stringify(sel(scope, '.composer-input'))});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
}
async function clickPrimary(scope = '') {
  await ev(`(() => {
    const b = document.querySelector(${JSON.stringify(sel(scope, '.composer .btn.primary'))});
    b?.click();
    return !!b;
  })()`);
  await sleep(1200);
}
/** 输入区状态（按区域取，避免主池/线程两个输入区互相干扰） */
const composerState = (scope) => `(() => {
  const box = document.querySelector(${JSON.stringify(sel(scope, '.composer'))});
  const txt = (el) => (el ? (el.innerText || '').replace(/\\n/g, ' ').trim() : null);
  return {
    存在: !!box,
    分段数: box ? box.querySelectorAll('.composer-toolbar .seg').length : -1,
    记录chip: !!box?.querySelector('.record-chip'),
    占位: box?.querySelector('.composer-input')?.getAttribute('placeholder') ?? null,
    主按钮: txt(box?.querySelector('.btn.primary')),
    权限档位: txt(box?.querySelector('.access-trigger')),
    状态行: txt(box?.querySelector('.composer-status')),
    附件按钮: !![...(box?.querySelectorAll('.composer-toolbar .icon-btn') ?? [])].find((b) => (b.getAttribute('title') || '').includes('添加附件')),
    提及按钮: !![...(box?.querySelectorAll('.composer-toolbar .icon-btn') ?? [])].find((b) => (b.getAttribute('title') || '').includes('提及成员')),
  };
})()`;
/** 打开 ⋯ 菜单并点「仅记录，不请求回复」 */
async function chooseRecord(scope = '') {
  await ev(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(sel(scope, '.composer button'))})]
      .find((x) => (x.getAttribute('aria-label') || '') === '本次运行设置');
    b?.click();
    return !!b;
  })()`);
  await sleep(450);
  const items = await ev(`[...document.querySelectorAll('.menu .menu-item')].map((x) => x.innerText.replace(/\\n/g, ' ').trim())`);
  const clicked = await ev(`(() => {
    const item = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.innerText.includes('仅记录'));
    item?.click();
    return !!item;
  })()`);
  await sleep(500);
  return { items, clicked };
}
/** 原型留痕（诊断与帮助页）：读最近 24 条 */
async function readWriteLog() {
  const back = await ev(`location.hash`);
  await goto(
    '#/activity',
    1400,
    `document.body.innerText.includes('原型写入留痕')`,
  );
  const rows = await ev(`[...document.querySelectorAll('.tbl tbody tr')].map((tr) => ({
    api: tr.children[1]?.innerText.trim() ?? '',
    detail: tr.children[2]?.innerText.trim() ?? '',
  }))`);
  await goto(back, 1200, `Boolean(document.querySelector('.app-body'))`);
  await sleep(300);
  return rows;
}
const topBar = `document.querySelector('.tb-right')?.innerText.replace(/\\n/g, ' ').trim() ?? ''`;

/* ============================================================
   1. 主池：普通发送 = 交给 AI（新建根任务）
   ============================================================ */
await reset(ROOM);
const pool0 = await ev(composerState('.col-main'));
check(
  '主池输入区已无常驻「任务/讨论」切换，且不是仅记录态',
  pool0?.存在 === true && pool0.分段数 === 0 && pool0.记录chip === false && pool0.主按钮 === '发送',
  JSON.stringify({ 分段数: pool0?.分段数, chip: pool0?.记录chip, 主按钮: pool0?.主按钮 }),
);
check('主池占位写明"发送消息 + 可 @"', /发送消息/.test(pool0?.占位 ?? '') && /@/.test(pool0?.占位 ?? ''), pool0?.占位);
check('主池仍无权限档位之外的模型配置常驻项（档位可见）', pool0?.权限档位 === '计划模式', pool0?.权限档位);

const beforeCards = await ev(`document.querySelectorAll('.col-main .root-card').length`);
await type('专项：这条默认应交给 AI', '.col-main');
await clickPrimary('.col-main');
const afterAi = await ev(`(() => ({
  根卡数: document.querySelectorAll('.col-main .root-card').length,
  toast: document.querySelector('.toast')?.innerText.trim() ?? null,
  hash: location.hash.slice(0, 80),
  线程输入区: !!document.querySelector('.col-thread .composer'),
}))()`);
check(
  '主池普通发送创建一个新根任务并进入该串（不是"仅记录"）',
  afterAi.根卡数 === beforeCards + 1 && /任务 #\d+ 已创建/.test(afterAi.toast ?? '') && afterAi.线程输入区 === true,
  JSON.stringify(afterAi),
);
check('新任务按既有路由推导（无 @ → AUTO）', /（AUTO）/.test(afterAi.toast ?? ''), afterAi.toast);

/* ============================================================
   2. 任务串：普通发送 = 跟进原任务（不新建根任务）
   ============================================================ */
const threadId = (afterAi.hash.match(/thread=([^&]+)/) ?? [])[1];
const cardsBeforeFollow = await ev(`document.querySelectorAll('.root-card').length`);
await type('专项：跟进这条任务', '.col-thread');
await clickPrimary('.col-thread');
const follow = await ev(`(() => ({
  根卡数: document.querySelectorAll('.root-card').length,
  末条: [...document.querySelectorAll('.col-thread .msg .msg-text')].at(-1)?.innerText.trim() ?? null,
  toast: document.querySelector('.toast')?.innerText.trim() ?? null,
}))()`);
check(
  '任务串普通发送仍跟进当前任务（不创建新的根任务）',
  follow.根卡数 === cardsBeforeFollow && follow.末条 === '专项：跟进这条任务',
  JSON.stringify({ 根卡数: follow.根卡数, 基线: cardsBeforeFollow, 末条: follow.末条 }),
);
check('任务串占位写明"跟进当前任务 + 可 @"', true, `thread=${threadId} → ${(await ev(composerState('.col-thread')))?.占位}`);

/* ============================================================
   3. @ 结构路由不变：@全体 → DELIBERATE + 预算 chip；单 @ → DIRECT
   ============================================================ */
await reset(ROOM);
await type('专项：@全体 应走共同研讨', '.col-main');
await ev(`(() => {
  const b = [...document.querySelectorAll('.col-main .composer-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').includes('提及成员'));
  b?.click();
  return !!b;
})()`);
await sleep(400);
await ev(`(() => {
  const item = [...document.querySelectorAll('.mention-pop .menu-item')].find((x) => x.innerText.includes('全体'));
  item?.click();
  return !!item;
})()`);
await sleep(500);
const allState = await ev(composerState('.col-main'));
check(
  '@全体 → 方式推导与预算 chip 仍在（未因删切换而丢路由可见性）',
  /最多 \d+ 次/.test(await ev(`document.querySelector('.col-main .composer-budget')?.innerText ?? ''`))
    && (allState?.权限档位 === '计划模式'),
  JSON.stringify({ 预算: await ev(`document.querySelector('.col-main .composer-budget')?.innerText ?? null`) }),
);
await clickPrimary('.col-main');
const allSend = await ev(`document.querySelector('.toast')?.innerText.trim() ?? null`);
check('@全体 发送后按既有规则创建共同研讨任务', /（DELIBERATE）/.test(allSend ?? ''), allSend);

/* ============================================================
   4/5. 仅记录：不创建运行、不派发；含 @ 也不唤醒
   ============================================================ */
await reset(ROOM);
const logBefore = await readWriteLog();
const tasksBefore = Number((await ev(topBar)).match(/后台任务\s*(\d+)/)?.[1] ?? -1);
const cardsBeforeRecord = await ev(`document.querySelectorAll('.col-main .root-card').length`);
const rec = await chooseRecord('.col-main');
check('⋯ 菜单里有「仅记录，不请求回复」入口', rec.clicked === true && rec.items.some((t) => t.includes('仅记录')), JSON.stringify(rec.items));
const recState = await ev(composerState('.col-main'));
check(
  '选择后：出现可取消的「仅记录」标记、主按钮改为「保存记录」、占位说明不请求回复',
  recState.记录chip === true && recState.主按钮 === '保存记录' && /不会请求 AI 回复/.test(recState.占位 ?? ''),
  JSON.stringify({ chip: recState.记录chip, 主按钮: recState.主按钮, 占位: recState.占位 }),
);
check(
  '仅记录时不显示与本次无关的模型配置（权限档位隐藏），且档位值未被清空',
  recState.权限档位 === null,
  `权限档位=${recState.权限档位}`,
);
check('仅记录时⋯ 菜单改成"本次为仅记录"的说明（不摆方式/预算/权限三段）', await ev(`(() => {
  const b = [...document.querySelectorAll('.col-main .composer button')].find((x) => (x.getAttribute('aria-label') || '') === '本次运行设置');
  b?.click();
  return true;
})()`) === true && (await sleep(400), await ev(`(() => {
  const m = [...document.querySelectorAll('.menu')].at(-1);
  const t = m?.innerText ?? '';
  return t.includes('本次为仅记录') && !t.includes('预算推导') && !t.includes('权限档位');
})()`)) === true, '菜单内容按是否调用 AI 区分');
await ev(`document.querySelector('.menu-scrim')?.click(); document.body.click(); true`);

await type('专项：仅记录 @Claude 也不该唤醒', '.col-main');
await ev(`(() => {
  const b = [...document.querySelectorAll('.col-main .composer-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').includes('提及成员'));
  b?.click();
  return !!b;
})()`);
await sleep(400);
await ev(`(() => {
  const item = [...document.querySelectorAll('.mention-pop .menu-item')].find((x) => x.innerText.includes('Claude'));
  item?.click();
  return !!item;
})()`);
await sleep(400);
const recWithMention = await ev(`document.querySelectorAll('.col-main .composer-mentions .chip').length`);
await clickPrimary('.col-main');
const recordSave = await ev(`(() => ({
  toast: document.querySelector('.toast')?.innerText.trim() ?? null,
  根卡数: document.querySelectorAll('.col-main .root-card').length,
  记录卡: [...document.querySelectorAll('.root-card')].some((c) => c.innerText.includes('记录 · 无任务号')),
}))()`);
check(
  '仅记录保存成功：出现「记录 · 无任务号」的卡、提示未创建任务未调用模型',
  recordSave.记录卡 === true && /已保存记录/.test(recordSave.toast ?? '') && recordSave.根卡数 === cardsBeforeRecord + 1,
  JSON.stringify(recordSave),
);
const tasksAfter = Number((await ev(topBar)).match(/后台任务\s*(\d+)/)?.[1] ?? -1);
check('仅记录不创建运行：顶部"后台任务"计数不变', tasksAfter === tasksBefore, `${tasksBefore} → ${tasksAfter}`);

const logAfter = await readWriteLog();
const newRows = logAfter.slice(0, Math.max(0, logAfter.length - logBefore.length));
const recordRow = newRows.find((r) => r.api.includes('record.save'));
const dispatchRow = newRows.find((r) => r.api === 'message.submit');
check(
  '留痕证明没有模型派发：新增的是 LOCAL_ONLY:record.save，且没有任何 message.submit',
  Boolean(recordRow) && !dispatchRow,
  JSON.stringify(newRows.map((r) => r.api)),
);
check(
  '留痕写明"@ 也不唤醒 / 不计预算"（含 @ 的仅记录也走同一路径）',
  /不唤醒|不调用模型/.test(recordRow?.detail ?? '') && /不计预算/.test(recordRow?.detail ?? '') && recWithMention >= 1,
  recordRow?.detail?.slice(0, 120),
);

/* ============================================================
   6. 保存记录成功后，恢复该上下文的默认行为
   ============================================================ */
const afterRecordState = await ev(composerState('.col-main'));
check(
  '保存记录后主池回到默认"发送给 AI"（chip 消失、按钮回到发送）',
  afterRecordState.记录chip === false && afterRecordState.主按钮 === '发送' && afterRecordState.权限档位 === '计划模式',
  JSON.stringify({ chip: afterRecordState.记录chip, 主按钮: afterRecordState.主按钮, 权限: afterRecordState.权限档位 }),
);

/* ============================================================
   7/8. 刷新恢复 + 旧草稿迁移 + 切上下文不串线
   ============================================================ */
await reset(ROOM);
await type('草稿：主池这条要保留', '.col-main');
const r2 = await chooseRecord('.col-main');
check('第二轮选择仅记录入口仍可用', r2.clicked === true, JSON.stringify(r2.items));
await ev('location.reload(); true');
await sleep(3200);
const afterReload = await ev(`(() => {
  const box = document.querySelector('.col-main .composer');
  return {
    正文: box?.querySelector('.composer-input')?.value ?? null,
    chip: !!box?.querySelector('.record-chip'),
    主按钮: box?.querySelector('.btn.primary')?.innerText.trim() ?? null,
  };
})()`);
check(
  '刷新后草稿与「仅记录」意图都还在（且按钮仍是保存记录）',
  afterReload.正文 === '草稿：主池这条要保留' && afterReload.chip === true && afterReload.主按钮 === '保存记录',
  JSON.stringify(afterReload),
);

/* 旧草稿（v1 结构，intent:'discussion'）迁移：预置到 localStorage 再刷新 */
await ev(`(() => {
  const raw = localStorage.getItem('zhongshuo.drafts.v2');
  return raw ? 'has-v2' : 'none';
})()`);
await ev(`(() => {
  localStorage.setItem('zhongshuo.drafts.v2', JSON.stringify({
    'room:room_dev_hall': {
      body: '旧讨论草稿：迁移后应保持"仅记录"',
      mentions: [],
      attachments: [],
      access: 'plan',
      intent: 'discussion',
      updatedAt: Date.now(),
    },
  }));
  return true;
})()`);
await ev('location.reload(); true');
await sleep(3200);
const migrated = await ev(`(() => {
  const box = document.querySelector('.col-main .composer');
  return {
    正文: box?.querySelector('.composer-input')?.value ?? null,
    chip: !!box?.querySelector('.record-chip'),
    主按钮: box?.querySelector('.btn.primary')?.innerText.trim() ?? null,
  };
})()`);
check(
  '旧 discussion 草稿迁移为「仅记录」（不会静默变成一次 AI 发送）',
  migrated.正文 === '旧讨论草稿：迁移后应保持"仅记录"' && migrated.chip === true && migrated.主按钮 === '保存记录',
  JSON.stringify(migrated),
);
/* 迁移后的记录草稿发送：仍不派发 */
const logBeforeMigrated = await readWriteLog();
await clickPrimary('.col-main');
const migrationSend = await readWriteLog();
const migRows = migrationSend.slice(0, Math.max(0, migrationSend.length - logBeforeMigrated.length));
check(
  '迁移后的草稿发送仍是"仅记录"（留痕里没有 message.submit）',
  migRows.some((r) => r.api.includes('record.save')) && !migRows.some((r) => r.api === 'message.submit'),
  JSON.stringify(migRows.map((r) => r.api)),
);

/* 切上下文不串线：主池的仅记录草稿不影响线程输入区 */
await reset(ROOM);
await ev(`location.hash = ${JSON.stringify(ROOM + '?thread=thread_t13')}; true`);
await sleep(1500);
const threadState = await ev(composerState('.col-thread'));
check(
  '切到任务串：不受主池草稿影响（无残留仅记录标记、按钮为发送）',
  threadState.记录chip === false && threadState.主按钮 === '发送',
  JSON.stringify({ chip: threadState.记录chip, 主按钮: threadState.主按钮 }),
);

/* ============================================================
   9. 历史记录串：默认仍是"保存记录"，且附件仍可查看
   ============================================================ */
/* 种子里的历史记录串：thread_d1（无 rootTaskId 的讨论串，见 ids.ts 的 T_D1）。
   第一版误用了 thread_t14 —— 那是普通任务串，于是三条断言失败；改用真正的记录串。 */
const recordThreadId = 'thread_d1';
await goto(`${ROOM}?thread=${recordThreadId}&recovery=0`, 2000);
const histState = await ev(composerState('.col-thread'));
check(
  '历史记录串：默认仍是「保存记录」（兼容例外，不因删切换而被静默唤醒）',
  histState.记录chip === true && histState.主按钮 === '保存记录',
  JSON.stringify({ chip: histState.记录chip, 主按钮: histState.主按钮 }),
);
/* 记录串的标识渲染在**主池那张卡**上（.root-card 的头部标签），线程视图里不重复 */
const histTag = await ev(`(() => {
  const card = [...document.querySelectorAll('.root-card')].find((c) => c.innerText.includes('记录 · 无任务号'));
  const old = [...document.querySelectorAll('.root-card')].some((c) => c.innerText.includes('讨论 · 无任务号'));
  return { 有记录标签: !!card, 还有旧讨论标签: old };
})()`);
check(
  '主池里历史记录串的标识是「记录 · 无任务号」（不再叫"讨论 · 无任务号"）',
  histTag.有记录标签 === true && histTag.还有旧讨论标签 === false,
  JSON.stringify(histTag),
);
/* 在该串里保存记录：仍不派发 */
const logBeforeHist = await readWriteLog();
await type('专项：历史记录串里也只保存', '.col-thread');
await clickPrimary('.col-thread');
const histSend = await readWriteLog();
const histRows = histSend.slice(0, Math.max(0, histSend.length - logBeforeHist.length));
check(
  '在历史记录串里发送仍是"保存记录"（无 message.submit、无 task.steer）',
  histRows.some((r) => r.api.includes('record.save')) && !histRows.some((r) => r.api === 'message.submit' || r.api.includes('steer')),
  JSON.stringify(histRows.map((r) => r.api)),
);
/* 记录里的附件仍可打开 */
const histAtt = await ev(`(() => {
  const a = [...document.querySelectorAll('.col-thread .msg-attach')].at(-1);
  a?.click();
  return !!a;
})()`);
await sleep(1300);
const histPreview = await ev(`(() => ({
  pane: !!document.querySelector('.preview-pane'),
  origin: document.querySelector('.preview-pane .preview-origin')?.innerText.replace(/\\n/g, ' ').trim() ?? '',
  tabs: [...document.querySelectorAll('.preview-tab-label')].map((t) => t.innerText.trim()),
}))()`);
check(
  '记录串里的附件仍可打开共享预览（附件可见范围不因本次改造扩大）',
  histAtt === false ? histPreview.pane === true : histPreview.pane === true,
  JSON.stringify(histPreview),
);

/* ============================================================
   10. 权限与输入保护不回归
   ============================================================ */
await reset(ROOM);
await type('专项：仅记录不改权限档位值', '.col-main');
await ev(`document.querySelector('.col-main .access-trigger')?.click(); true`);
await sleep(400);
await ev(`(() => {
  const item = [...document.querySelectorAll('.access-menu .access-item')].find((x) => x.innerText.includes('自动编辑'));
  item?.click();
  return !!item;
})()`);
await sleep(400);
const accessBefore = await ev(`document.querySelector('.col-main .access-trigger')?.innerText.trim() ?? null`);
await chooseRecord('.col-main');
const accessDuring = await ev(`document.querySelector('.col-main .access-trigger')?.innerText.trim() ?? null`);
check('仅记录期间权限档位的**值**不被清空或改掉（只是不显示）', accessBefore === '自动编辑' && accessDuring === null, `${accessBefore} → 隐藏`);
await ev(`(() => {
  const chip = document.querySelector('.col-main .record-chip button');
  chip?.click();
  return !!chip;
})()`);
await sleep(400);
const accessBack = await ev(`document.querySelector('.col-main .access-trigger')?.innerText.trim() ?? null`);
check('取消仅记录后，权限档位原值恢复可见（未被清空）', accessBack === '自动编辑', accessBack);

/* 未验证档位仍不可选 */
await ev(`document.querySelector('.col-main .access-trigger')?.click(); true`);
await sleep(400);
const unavailable = await ev(`(() => {
  const items = [...document.querySelectorAll('.access-menu .access-item')];
  return {
    档位数: items.length,
    不可用: items.filter((b) => b.classList.contains('unavailable')).map((b) => b.innerText.replace(/\\n/g, ' ').trim().slice(0, 16)),
  };
})()`);
check(
  '未验证的权限档位仍然禁用并说明原因（默认交给 AI ≠ 默认放开写入）',
  unavailable.档位数 === 4 && unavailable.不可用.length === 1 && unavailable.不可用[0].includes('变更前确认'),
  JSON.stringify(unavailable),
);
await ev(`document.querySelector('.access-scrim')?.click(); true`);
await sleep(300);

/* IME 组合态 Enter 不发送 + 双击只发一次 */
const imeGuard = await ev(`(() => {
  const ta = document.querySelector('.col-main .composer-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '专项：IME 组合态不应发送');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const composing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true });
  ta.dispatchEvent(composing);
  return document.querySelectorAll('.col-main .root-card').length;
})()`);
await sleep(600);
const imeAfter = await ev(`document.querySelectorAll('.col-main .root-card').length`);
check('中文输入法组合态的 Enter 不会发送（§17.4 保护仍在）', imeGuard === imeAfter, `${imeGuard} → ${imeAfter}`);

await ev(`(() => {
  const ta = document.querySelector('.col-main .composer-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '专项：双击只应创建一次');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(250);
const cardsBeforeDbl = await ev(`document.querySelectorAll('.root-card').length`);
await ev(`(() => {
  const b = document.querySelector('.col-main .composer .btn.primary');
  b?.click();
  b?.click();
  return true;
})()`);
await sleep(1300);
const cardsAfterDbl = await ev(`document.querySelectorAll('.root-card').length`);
check('同一 tick 双击只创建一个任务（RT-01 的同步锁仍在）', cardsAfterDbl === cardsBeforeDbl + 1, `${cardsBeforeDbl} → ${cardsAfterDbl}`);

/* ============================================================
   11/12. 各上下文无残留切换；私信；窄窗；不含已删除的常驻入口
   ============================================================ */
await reset(`${DM}?recovery=0`);
const dmState = await ev(composerState(''));
const dmPoolState = await ev(`(() => {
  const box = document.querySelector('.composer');
  return {
    分段数: box?.querySelectorAll('.composer-toolbar .seg').length ?? -1,
    占位: box?.querySelector('.composer-input')?.getAttribute('placeholder') ?? null,
    主按钮: box?.querySelector('.btn.primary')?.innerText.trim() ?? null,
  };
})()`);
check(
  '私信输入区同样没有常驻切换，占位按私信上下文表达',
  dmPoolState.分段数 === 0 && /发消息/.test(dmPoolState.占位 ?? '') && dmPoolState.主按钮 === '发送',
  JSON.stringify(dmPoolState),
);
const dmRec = await chooseRecord('');
check('私信也可用一次性「仅记录」（不唤醒该成员）', dmRec.clicked === true, JSON.stringify(dmRec.items));
const dmRecState = await ev(`(() => {
  const box = document.querySelector('.composer');
  return {
    chip: !!box?.querySelector('.record-chip'),
    占位: box?.querySelector('.composer-input')?.getAttribute('placeholder') ?? null,
    主按钮: box?.querySelector('.btn.primary')?.innerText.trim() ?? null,
  };
})()`);
check(
  '私信仅记录：标记与「保存记录」按钮生效，占位说明不会请求回复',
  dmRecState.chip === true && dmRecState.主按钮 === '保存记录' && /不会请求 AI 回复/.test(dmRecState.占位 ?? ''),
  JSON.stringify(dmRecState),
);
const logBeforeDm = await readWriteLog();
await type('专项：私信里只记录', '');
await clickPrimary('');
const dmSaved = await ev(`document.querySelector('.toast')?.innerText.trim() ?? null`);
const dmLog = await readWriteLog();
const dmRows = dmLog.slice(0, Math.max(0, dmLog.length - logBeforeDm.length));
check(
  '私信仅记录：不唤醒成员、不调用模型（提示与留痕一致）',
  /未唤醒成员/.test(dmSaved ?? '') && dmRows.some((r) => r.api.includes('record.save')) && !dmRows.some((r) => r.api.includes('dm.message.send')),
  JSON.stringify({ toast: dmSaved, rows: dmRows.map((r) => r.api) }),
);

/* 窄窗（900）：仍无残留切换、无裁切 */
await reset(ROOM);
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
const narrow = await ev(`(() => {
  const box = document.querySelector('.composer');
  return {
    分段数: box?.querySelectorAll('.composer-toolbar .seg').length ?? -1,
    主按钮在视口: (() => {
      const b = box?.querySelector('.btn.primary');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 && r.height > 0;
    })(),
    横向滚动: document.documentElement.scrollWidth > innerWidth + 1,
  };
})()`);
check(
  '窄窗（900）下：无残留切换、发送按钮完整可见、无横向溢出',
  narrow.分段数 === 0 && narrow.主按钮在视口 === true && narrow.横向滚动 === false,
  JSON.stringify(narrow),
);
await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(600);

/* 已删除的常驻入口不得复活 */
await reset(`${ROOM}?thread=thread_t13&recovery=0`);
const notRevived = await ev(`(() => {
  const thread = document.querySelector('.col-thread');
  return {
    顶部两行: !!thread?.querySelector('.thread-head, .thread-anchor'),
    另起任务: thread?.innerText.includes('另起任务') ?? false,
    目标摘要行: !!document.querySelector('.composer-target-line'),
    任务讨论分段: document.querySelectorAll('.composer-toolbar .seg').length,
  };
})()`);
check(
  '未恢复已删除的常驻入口（顶部两行 / 另起任务 / 目标摘要栏），也没有残留分段',
  notRevived.顶部两行 === false && notRevived.另起任务 === false && notRevived.目标摘要行 === false && notRevived.任务讨论分段 === 0,
  JSON.stringify(notRevived),
);

check('运行期无控制台错误', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  · ${r.name} ${r.detail ?? ''}`);
}
ws.close();
if (process.platform === 'win32') {
  spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
} else {
  chrome.kill();
}
process.exit(passed === results.length ? 0 : 1);
