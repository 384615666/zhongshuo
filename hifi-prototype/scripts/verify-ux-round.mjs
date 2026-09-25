/** 本轮页面逻辑修复的专项验证：私信路由 / tab-URL 同步 / 恢复弹窗范围 / 会话设置 */
const BASE = process.argv[2] ?? 'http://localhost:5284';
const CDP = process.env.ZS_SMOKE_CDP_PORT ?? '9334';
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const browser = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!browser) throw new Error('找不到本机 Chrome/Edge');

const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run',
  '--user-data-dir=' + (process.env.TEMP + '/zs-verify-ux'), 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1800);

let ws, id = 0;
const pending = new Map();
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate 失败');
  return r.result?.result?.value;
}
async function goto(hash) { await ev(`location.hash = '${hash}'; 'ok'`); await sleep(700); }

const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

try {
  await ev(`location.href = '${BASE}/#/welcome?recovery=0'; 'ok'`);
  await sleep(1500);
  /* 用例稳健性（2026-09-24）：Chrome 复用 profile 时可能恢复上次会话的 URL
     （上一轮跑完停在 #/welcome，没有 recovery=0），那样应用挂载时就会自动弹恢复检查。
     先显式关掉任何已打开的弹窗，后面的两条断言（项目主页不自动弹 / 欢迎页仍会自动弹）
     才是确定性的：弹窗每个会话只自动弹一次，关掉后不会再自己回来。 */
  await ev(`
    (() => {
      if (!document.querySelector('.scrim')) return false;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.querySelector('.overlay-head .icon-btn[aria-label="关闭"]')?.click();
      return true;
    })()
  `);
  await sleep(400);

  // 1. 私信列表页
  await goto('/dm');
  const dmRows = await ev(`document.querySelectorAll('.dm-row').length`);
  check('私信列表页渲染多个会话', dmRows >= 2, `rows=${dmRows}`);

  // 2. 点击切换会话
  await ev(`document.querySelectorAll('.dm-row')[1].click(); 'ok'`);
  await sleep(400);
  const selTitle = await ev(`document.querySelectorAll('.dm-row')[1].querySelector('.dm-row-title')?.innerText`);
  const headTitle = await ev(`document.querySelector('.thread-head .strong')?.innerText`);
  check('点击列表切换会话', Boolean(selTitle) && headTitle === selTitle, `${selTitle}`);

  // 3. 会话设置弹窗（改名 + 置顶）
  await ev(`document.querySelector('.thread-head .icon-btn[title*="会话设置"]').click(); 'ok'`);
  await sleep(400);
  const body1 = await ev(`document.body.innerText`);
  check('会话设置弹窗打开且含改名/置顶', body1.includes('会话标题') && body1.includes('置顶会话'));
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='取消'); b?.click(); return 'ok'; })()`);
  await sleep(300);

  // 4. 成员详情页私信按钮说明（按钮在 /member/:id，不在 /members 列表页）
  await goto('/member/member_codex');
  const dmBtn = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title')?.includes('打开与该成员的私聊'));
    return !!b;
  })()`);
  check('成员页私信按钮带说明', dmBtn);

  // 4b. /dm/:memberId 直达：选中与该成员的 1 对 1 会话
  await goto('/dm/member_codex');
  await sleep(500);
  const dmDirect = await ev(`(() => ({
    onList: !!document.querySelector('.dm-list'),
    head: document.querySelector('.thread-head .strong')?.innerText ?? '',
  }))()`);
  check('/dm/:memberId 直达并选中会话', dmDirect.onList && dmDirect.head.includes('Codex'), dmDirect.head);

  // 5. tab / URL 同步（用例更新：2026-09-24 减负后运行详情在「详情」分组内）
  await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
  await ev(`(() => { const b=[...document.querySelectorAll('.col-thread .thread-tab')].find(x=>x.innerText.includes('详情')); b?.click(); return 'ok'; })()`);
  await sleep(300);
  await ev(`(() => { const b=[...document.querySelectorAll('.details-chip')].find(x=>x.innerText.includes('运行详情')); b?.click(); return 'ok'; })()`);
  await sleep(400);
  const hashRun = await ev(`location.hash`);
  check('切到运行详情后 URL 带 tab=run', hashRun.includes('tab=run'), hashRun);
  await ev(`(() => { const b=[...document.querySelectorAll('.col-thread .thread-tab')].find(x=>x.innerText.trim().startsWith('回复')); b?.click(); return 'ok'; })()`);
  await sleep(400);
  const hashReplies = await ev(`location.hash`);
  check('切回回复后 URL 不残留 tab 参数', !hashReplies.includes('tab='), hashReplies);
  const repliesBack = await ev(`document.querySelectorAll('.msg-list [id^="msg-"]').length > 0`);
  check('回复列表恢复', repliesBack);

  // 6. 房间看板卡片直达 ?thread&tab=task
  await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
  await ev(`(() => { const b=[...document.querySelectorAll('.thread-tab')].find(x=>x.innerText.includes('任务看板')); b?.click(); return 'ok'; })()`);
  await sleep(400);
  await ev(`document.querySelector('.grid-2 .card')?.click(); 'ok'`);
  await sleep(700);
  const hashTask = await ev(`location.hash`);
  check('房间看板卡片直达 ?thread&tab=task', hashTask.includes('tab=task') && hashTask.includes('thread='), hashTask);
  check('回复串面板就地打开（未整页替换）', await ev(`!!document.querySelector('.col-thread')`));

  // 7. 恢复弹窗范围
  await goto('/project/proj_zs_01');
  await sleep(900);
  check('项目主页不自动弹恢复检查', !(await ev(`document.body.innerText.includes('启动恢复检查')`)));
  /* 用例更新（2026-09-24）：自动恢复弹窗是"每个会话在欢迎页只自动弹一次"
     （recoveryShown 一次性闩锁，第十三项之后的行为）。脚本开头已经整页加载过一次
     带 recovery=0 的欢迎页，因此同一会话里再切回 #/welcome 不会重开 ——
     断言必须用**一次完整加载**来验证"欢迎页仍保留自动恢复检查"，
     否则测的是会话闩锁而不是这个能力。 */
  await ev(`location.hash = '#/welcome'; location.reload(); 'ok'`);
  await sleep(2600);
  check('欢迎页保留自动恢复检查', await ev(`document.body.innerText.includes('启动恢复检查')`));

  // 8. 侧栏成员入口与 Git 徽章
  //
  // 用例更新（第十五批 §17.1/§17.7）：这几条原来断言的是第十三批设计——
  // "侧栏有【项目成员】状态区 + 组内【管理】链接，功能组不再出现【成员管理】"。
  // 用户已确认改为四固定入口，「成员管理」是**唯一主入口**，侧栏不再放成员列表，
  // 因此旧断言（要求"没有成员管理项"）与新设计正好相反，按交接文档 §8
  // 「不要让测试继续断言旧侧栏入口必须存在」重写。
  await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
  const sideText = await ev(`document.querySelector('.sidebar')?.innerText ?? ''`);
  check('侧栏不再放成员列表（改由成员管理页承担）', !sideText.includes('项目成员'));
  check('「成员管理」是唯一主入口',
    await ev(`(() => [...document.querySelectorAll('.sidebar .side-item-label')]
      .filter(x => x.innerText.trim() === '成员管理').length)()`) === 1);
  await ev(`
    (() => {
      const b = [...document.querySelectorAll('.sidebar .side-item')]
        .find(x => x.querySelector('.side-item-label')?.innerText.trim() === '成员管理');
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(600);
  // 第十五批：成员管理页带 projectId（§17.7），不再是裸 /members
  check('「成员管理」入口进入带项目 ID 的成员页',
    /^#\/project\/proj_zs_01\/members$/.test(await ev(`location.hash`)),
    await ev(`location.hash`));

  // 9. 侧栏「文件与 Git」入口的徽章用改动图标而不是消息气泡
  // （第十五批：Git 已并入合页，徽章挂在「文件与 Git」上；原断言找的是已移除的独立 Git 项）
  await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
  check('「文件与 Git」徽章不用消息气泡图标', await ev(`(() => {
    const item = [...document.querySelectorAll('.side-item')]
      .find(x => x.innerText.includes('文件与 Git'));
    return item ? !item.innerHTML.includes('message-square') : false;
  })()`));
} finally {
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { proc.kill(); } catch {}
  process.exit(failed.length ? 1 : 0);
}
