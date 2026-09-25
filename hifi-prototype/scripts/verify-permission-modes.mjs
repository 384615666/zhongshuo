/**
 * 验证「变更前确认」在 RT-23/B6 未通过前禁用，说明为待验证而非永久后置。
 * 要点：不是选完再免责，而是**根本选不中**。
 *
 * 操作要点（踩过的坑）：
 *  - 合成 `element.click()` 在该按钮上不触发 React 处理器，必须发真实指针事件
 *  - `location.reload()` 会让 CDP 会话失效，所以本脚本**不 reload**，
 *    直接复用当前已打开的页面（先确保停在房间路由上）
 */

const PORT = process.env.ZS_CDP_PORT || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(
  (t) => t.type === 'page' && t.webSocketDebuggerUrl,
);
if (!pages.length) throw new Error(`连不上 ${PORT}，请先运行 pnpm run desktop:debug`);

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
    }, 9000);
    p.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return `EXC: ${String(r.result.exceptionDetails.exception?.description ?? '').slice(0, 120)}`;
  }
  return r.result?.result?.value;
};

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

await ev(`window.zhongshuo?.window.show()`);
await sleep(400);

// 确保停在房间路由（用 hash 变化 + 等待，不 reload）
const onRoom = await ev(`location.hash.includes('/room/')`);
if (!onRoom) {
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0'; true`);
  await sleep(2200);
}

// 若上个脚本留下了打开的下拉，先按 Esc 关掉
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(400);

/** 真实指针点击 */
async function realClick(selector) {
  const rect = await ev(`
    (() => {
      const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    })()
  `);
  if (!rect) return false;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return true;
}

check('页面停在房间路由且输入条可用',
  (await ev(`!!document.querySelector('.composer')`)) === true,
  String(await ev(`location.hash`)).slice(0, 60));

// 打开权限下拉。点两次：若上一轮留下了打开状态，第一次是关闭、第二次才是打开，
// 因此用"循环点到确实打开为止"的方式，比假设初始状态更稳。
async function ensureMenuOpen() {
  for (let i = 0; i < 4; i++) {
    if (await ev(`!!document.querySelector('.access-menu')`)) return true;
    await realClick('.access-trigger');
    await sleep(600);
  }
  return (await ev(`!!document.querySelector('.access-menu')`)) === true;
}

const opened = await ensureMenuOpen();
check('权限下拉可打开（真实指针事件）', opened === true,
  `trigger 类名=${await ev(`document.querySelector('.access-trigger')?.className`)}`);

const menu = await ev(`
  (() => {
    const items = [...document.querySelectorAll('.access-item')];
    return items.map(i => ({
      label: i.querySelector('.access-item-label')?.textContent?.trim(),
      desc: i.querySelector('.access-item-desc')?.textContent?.trim(),
      disabled: i.disabled === true,
      unavailable: i.classList.contains('unavailable'),
    }));
  })()
`);
console.log('菜单项:', JSON.stringify(menu, null, 1));

const items = Array.isArray(menu) ? menu : [];
const confirmItem = items.find((i) => String(i.label).includes('变更前确认'));
check('① 「变更前确认」被禁用（disabled）', confirmItem?.disabled === true, `disabled=${confirmItem?.disabled}`);
check('① 说明当前待验证，通过后按成员开放',
  String(confirmItem?.desc).includes('尚未验证') && String(confirmItem?.desc).includes('验证通过后') &&
    !String(confirmItem?.desc).includes('DEV-20'),
  String(confirmItem?.desc).slice(0, 70));
check('① 其余三档可在原型中选择（不代表能力认证）',
  items.filter((i) => !i.disabled).length === 3,
  `可用 ${items.filter((i) => !i.disabled).length} 档`);

// 强行点击禁用项，不应改变当前选择
const before = await ev(`document.querySelector('.access-trigger')?.textContent?.trim()`);
await realClick('.access-item.unavailable');
await sleep(700);
const after = await ev(`document.querySelector('.access-trigger')?.textContent?.trim()`);
/**
 * 用例迁移（2026-09-25）：草稿自本轮起落 localStorage，输入区会**恢复上一次的档位**，
 * 因此这里不能再隐含假设"起始一定是默认的计划模式"（实测：上一段把档位选成自动编辑，
 * 草稿带进来后就误判失败）。断言改回它的字面含义 —— **档位没有因为点击禁用项而改变，
 * 且绝不会变成禁用项那一个**；默认档位本身由输入区自己的用例覆盖。
 */
check('① 点击禁用项不会选中它（当前档位不变）',
  after === before && !String(after).includes('变更前确认'),
  `${before} → ${after}`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
