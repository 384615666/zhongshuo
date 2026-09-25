/**
 * 桌面原生能力验证（不截屏，避免误抓用户的其它窗口内容）。
 *
 * 验证顺序经过安排：把"原生目录选择器"放在最后，因为它是**系统模态对话框**，
 * 只能由操作系统层面关闭（CDP 的按键事件发给渲染进程，到不了系统对话框）。
 * 因此最后一步只证明"对话框确实被调起"，随后由外部（scripts/verify-desktop.ps1）
 * 发送 ESC 关闭，避免测试挂死。
 *
 * 用法：先 pnpm run desktop:debug，再 node scripts/verify-desktop.mjs
 */

const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const page = (await r.json()).find((t) => t.type === 'page');
if (!page) throw new Error('找不到 Electron 窗口，请先运行 pnpm run desktop:debug');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      res({});
    }, 20_000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function ev(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.exception?.description ?? 'exception' };
  }
  return { value: res.result?.result?.value };
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/* 1. preload 桥 */
const bridge = await ev(`typeof window.zhongshuo === 'object' && window.zhongshuo.isDesktop === true`);
check('preload 桥已注入（window.zhongshuo.isDesktop）', bridge.value === true, String(bridge.value));

/* 2. 宿主是 Electron */
const ua = await ev(`navigator.userAgent`);
check('宿主是 Electron 而非浏览器', /Electron\//.test(ua.value ?? ''), (ua.value ?? '').match(/Electron\/[\d.]+/)?.[0] ?? '');

/* 3. contextIsolation 生效 */
const noNode = await ev(
  `typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined'`,
);
check('渲染层拿不到 Node（contextIsolation 开、nodeIntegration 关）', noNode.value === true, String(noNode.value));

/* 4. 窗口状态 API */
const st = await ev(`window.zhongshuo.window.getState()`);
check(
  '窗口状态 API 返回完整状态',
  Boolean(st.value && 'maximized' in st.value && 'fullScreen' in st.value && 'focused' in st.value),
  JSON.stringify(st.value),
);

/* 5. 关闭 = 缩到托盘：窗口仍在，应用未退出 */
const pagesBefore = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page').length;
await ev(`window.zhongshuo.window.close()`);
await sleep(1200);
const pagesAfter = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page').length;
check(
  '关闭窗口后应用仍在运行（缩到托盘，未退出）',
  pagesAfter === pagesBefore && pagesAfter > 0,
  `窗口数 ${pagesBefore} → ${pagesAfter}`,
);

/* 5b. 从托盘恢复显示（通知点击回到窗口） */
const shown = await ev(`window.zhongshuo.window.show()`);
check('可从托盘恢复显示窗口', Boolean(shown.value && 'maximized' in shown.value), JSON.stringify(shown.value));

/* 6. 把运行态摘要同步给主进程（托盘提示与退出确认的数据源） */
const reported = await ev(
  `window.zhongshuo.reportRuntime({ runningTasks: 2, runningTurns: 3, detail: 'verify' }).then(v => v)`,
);
check('运行态摘要可同步给主进程（供托盘与退出确认）', reported.value === true, String(reported.value));

/* 7. 原生目录选择器：系统模态对话框被真正调起
      判据：发起调用后 1.8 秒仍未 resolve —— 说明正停在系统对话框上等用户操作。
      （这一步之后对话框仍开着，由外部发送 ESC 关闭。） */
await send('Runtime.evaluate', {
  expression: `window.__zsPick = 'pending'; window.zhongshuo.pickDirectory().then(v => { window.__zsPick = (v === null ? 'cancelled' : 'picked:' + v); });`,
  returnByValue: true,
});
await sleep(1800);
const midState = await ev(`window.__zsPick`);
check(
  '原生目录选择器调起了系统模态对话框（调用未立即返回）',
  midState.value === 'pending',
  `调用后 1.8s 状态 = ${midState.value}`,
);

console.log('\n注意：系统目录对话框当前仍处于打开状态，将由 verify-desktop.ps1 发送 ESC 关闭。');

const passed = results.filter((x) => x.pass).length;
console.log(`${passed}/${results.length} 通过（不含模态对话框关闭）`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
