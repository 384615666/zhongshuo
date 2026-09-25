/**
 * 验证：成员进度消息不再渲染那张"全是占位值"的卡片。
 *
 * 背景（用户反馈："这个成员进度的卡片好奇怪，阶段里的当前阶段又是啥"）：
 * 原实现里每条 kind='progress' 的消息都会渲染一张「成员进度」卡片，卡片里有
 * 「阶段 / 成员」两列网格。但 payload.progress 在整个代码库里从未被写入过，
 * 所以那两格永远渲染兜底值：「阶段 = 当前阶段」「成员 = 作者名」。
 * 而作者名在消息头已经写过一遍 —— 三行里两行没有信息量。
 *
 * 本脚本用真实 DOM 断言：
 *  1. 兜底字符串「当前阶段」不再出现在界面任何地方
 *  2. 不再有 .progress-card / .progress-grid 结构
 *  3. 进度正文本身仍然照常渲染（没有把内容一起删掉）
 *  4. 正文里的"（迟到纳入）"已改为结构化标签
 *  5. 消息头不重复渲染作者/阶段噪声
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

// ---- 场景 A：任务 #12（含迟到纳入的那条进度）----
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t12'; true`);
await sleep(2500);

const a = await ev(`
  (() => {
    const thread = document.querySelector('.col-thread');
    const prose = [...thread.querySelectorAll('.msg-text')].map(e => e.innerText.trim());
    return {
      全文: thread.innerText,
      有progressCard: !!thread.querySelector('.progress-card'),
      有progressGrid: !!thread.querySelector('.progress-grid'),
      进度正文条数: prose.filter(t => t.length > 0).length,
      含迟到纳入的正文: prose.filter(t => t.includes('迟到纳入')),
      迟到标签数: [...thread.querySelectorAll('.tag')].filter(e => e.innerText.trim() === '迟到纳入').length,
      阶段噪声标签: [...thread.querySelectorAll('.tag')].filter(e =>
        ['阶段', '当前阶段'].includes(e.innerText.trim())).length,
    };
  })()
`);

check('兜底字符串「当前阶段」不再出现在界面', !String(a?.全文).includes('当前阶段'));
check('不再渲染 .progress-card 卡片', a?.有progressCard === false);
check('不再渲染 .progress-grid 两列网格', a?.有progressGrid === false);
check('进度正文仍然照常渲染（内容没被一起删掉）',
  (a?.进度正文条数 ?? 0) > 0,
  `${a?.进度正文条数} 条正文`);
check('「（迟到纳入）」不再混在成员正文里',
  (a?.含迟到纳入的正文?.length ?? 0) === 0,
  a?.含迟到纳入的正文?.length ? `仍有 ${a.含迟到纳入的正文.length} 条` : '已是结构化标签');
check('「迟到纳入」改为结构化标签渲染', (a?.迟到标签数 ?? 0) >= 1, `${a?.迟到标签数} 个`);
check('界面不再出现「阶段 / 当前阶段」这类无信息量标签', (a?.阶段噪声标签 ?? 0) === 0);

// ---- 场景 B：不再有"标签: 值"的占位格子 ----
// 原来卡片里是 <div class="small faint">成员</div><div class="strong">Codex</div> 这种
// 标签+值结构。作者名出现在正文里（"互评 @Codex：…"）或作为子任务负责人标签都是正常的，
// 所以这里只断言"占位标签格"这一种结构已经消失。
const b = await ev(`
  (() => {
    const thread = document.querySelector('.col-thread');
    const labels = [...thread.querySelectorAll('.small.faint')]
      .map(e => e.innerText.trim())
      .filter(t => ['阶段', '成员', '当前阶段'].includes(t));
    // 标签格的特征：标签元素后面紧跟一个 .strong 兄弟节点
    const gridCells = [...thread.querySelectorAll('.small.faint')]
      .filter(e => ['阶段', '成员'].includes(e.innerText.trim()) && e.nextElementSibling?.classList.contains('strong'))
      .map(e => e.innerText.trim() + ' / ' + e.nextElementSibling.innerText.trim());
    return { 占位标签: labels, 标签值格: gridCells };
  })()
`);
check('不再有「阶段 / 成员」占位标签格',
  (b?.标签值格?.length ?? 0) === 0,
  b?.标签值格?.length ? JSON.stringify(b.标签值格) : '标签+值的占位结构已移除');

// ---- 场景 C：另一条线程（任务 #14 也有进度消息）----
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14'; true`);
await sleep(1800);
const c = await ev(`
  (() => {
    const thread = document.querySelector('.col-thread');
    return {
      全文: thread.innerText,
      有progressCard: !!thread.querySelector('.progress-card'),
      正文条数: thread.querySelectorAll('.msg-text').length,
    };
  })()
`);
check('任务 #14 同样不再有占位卡片', c?.有progressCard === false);
check('任务 #14 兜底字符串也不出现', !String(c?.全文).includes('当前阶段'));
check('任务 #14 正文正常渲染', (c?.正文条数 ?? 0) > 0, `${c?.正文条数} 条`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
