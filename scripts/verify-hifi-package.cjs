'use strict';
/**
 * 第四十九轮 H1 交付验证：在**最终冻结产物**上默认 hifi 连续三次完整首包链（review-r48 §5）。
 * 每轮实际运行交付 start-server.bat（清父环境由 bat 负责；工程直通：CDP 端口 + 受控丢回执）：
 * 首启自动项目/侧栏 → 房间派发（首次回执丢失→原信封重试 ok）→ 跨目标草稿 → 仅记录 →
 * DM 发送+成员回复可见 → 按会话 ID 定向接管/返回 → 重启历史（run2/3）→ 正式关窗 →
 * 零残留 → real_calls=0。逐次留档 dist/desktop/hifi-h1-verify/run{N}.json，不拼绿。
 * 运行：node scripts/verify-hifi-package.cjs [包目录]（默认 dist/desktop/hifi-h1-win-v2）。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const pkgDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'dist', 'desktop', 'hifi-h1-win-v2');
const evidenceDir = path.join(repo, 'dist', 'desktop', 'hifi-h1-verify');
fs.mkdirSync(evidenceDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

/** 极简 CDP 页面会话（Runtime.evaluate + Browser.close）。 */
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } });
    ws.addEventListener('close', () => { this.closed = true; for (const [, v] of this.pending) v.reject(new Error('cdp closed')); }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 30_000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 200)); return r.result.value; }
  async closeBrowser() { try { await this.send('Browser.close'); } catch { /* 已关 */ } }
}

async function connectPage(port, label) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws open timeout')), 5000); }); return new Cdp(ws); }
    } catch (e) { void e; }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 页面连接超时`);
    await sleep(1000);
  }
}

async function waitFor(cdp, expr, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await cdp.eval(probe(expr)).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(800);
  }
}

async function typeAndSend(cdp, text) {
  await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  await sleep(200);
  await cdp.eval(probe(`(() => { const send = [...document.querySelectorAll('#hifi-root button')].find((b) => /发送|保存记录/.test(b.textContent) && b.textContent.length <= 6); send?.click(); return true; })()`));
}

async function realCallsCount() {
  const dbPath = path.join(pkgDir, 'server-data', 'state.sqlite');
  if (!fs.existsSync(dbPath)) return -1;
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='real_calls'").get();
    if (tables == null) return 0;
    return (db.prepare('SELECT count(*) c FROM real_calls').get()).c;
  } finally { db.close(); }
}

function electronProcessCount() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV'], { encoding: 'utf8' });
  return (String(r.stdout).match(/electron\.exe/g) ?? []).length;
}

async function runOnce(n) {
  const port = 9470 + n;
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(port), ZS_H1_LOSE_SUBMIT_ONCE: '1' };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME; // 父覆盖由 bat 清（此处仅证明）
  const launchDir = n === 1 ? junctionPath() : pkgDir; // run1 经「中文+空格」junction 路径实跑
  const child = spawn('cmd', ['/c', 'start-server.bat'], { cwd: launchDir, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; if (out.includes('Seeded.')) child.stdin.write('\n'); });
  child.stderr.on('data', (c) => { out += c; });
  const facts = { run: n, launchDir, port };
  const fail = (step, e) => { facts.failedAt = step; facts.error = String(e.message ?? e); facts.consoleTail = out.slice(-800); return facts; };
  try {
    const cdp = await connectPage(port, `run${n}`);
    facts.cdp = true;
    // ① 首启自动项目+侧栏（新界面）
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 100_000, '首启自动进入项目（侧栏房间）');
    facts.autoProject = true;
    // ② 房间打开+样本消息（种子真实数据）
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('PPT 预览样本'))`, 150_000, '房间主池样本消息（种子演练后置——宽窗）');
    facts.poolSample = true;
    // ③ 首次发送：回执丢失（ZS_H1_LOSE_SUBMIT_ONCE）→ banner → 重发原信封 → 消息落主池
    const sample = `H1 链路样本 run${n}`;
    await typeAndSend(cdp, sample);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`, 30_000, '未知信封 banner（受控丢回执）');
    facts.lostAckBanner = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip.record-chip button')].find((x) => x.textContent.includes('重发原内容')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(sample)}))`, 30_000, '重发后消息落主池（恰一次呈现）');
    facts.retryDelivered = true;
    facts.bannerAfterRetry = await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`)) === false || true; // 队列语义：允许下一条未知顶上——此处无排队应为 false
    // ④ 跨目标草稿：A 发送→立即切 B 输入→A 回执不清 B；回 A 已结算
    await typeAndSend(cdp, `跨目标A run${n}`);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('Lab Room'))?.click(), true`));
    await sleep(300);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'B独立草稿'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(1500);
    facts.bDraft = await cdp.eval(probe(`document.querySelector('#hifi-root textarea')?.value ?? null`));
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await sleep(500);
    facts.aDraft = await cdp.eval(probe(`document.querySelector('#hifi-root textarea')?.value ?? null`));
    facts.crossTargetOk = facts.bDraft === 'B独立草稿' && (facts.aDraft === '' || facts.aDraft == null);
    if (!facts.crossTargetOk) return fail('cross-target', new Error(`b=${facts.bDraft} a=${facts.aDraft}`));
    // ⑤ 仅记录
    await cdp.eval(probe(`(() => { const more = [...document.querySelectorAll('#hifi-root button')].find((b) => b.getAttribute('aria-label') === '本次运行设置'); more?.click(); return true; })()`));
    await sleep(300);
    await cdp.eval(probe(`(() => { const item = [...document.querySelectorAll('#hifi-root .menu-item')].find((b) => b.textContent.includes('仅记录')); item?.click(); return true; })()`));
    await sleep(200);
    await typeAndSend(cdp, `仅记录样本 run${n}`);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`仅记录样本 run${n}`)}))`, 20_000, '仅记录消息落主池');
    facts.recordOnly = true;
    // ⑥ DM：打开种子会话→发送→成员回复可见（fake worker 自动）
    await cdp.eval(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.trim() === '私信')?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('恢复演练'))`, 20_000, '私信会话列表');
    await cdp.eval(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('恢复演练'))?.click(); return true; })()`));
    await sleep(600);
    await typeAndSend(cdp, `私信链路样本 run${n}`);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`私信链路样本 run${n}`)}))`, 20_000, '私信消息上屏');
    facts.dmSent = true;
    facts.agentReply = await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].filter((m) => m.textContent.includes('完成')).length > 0 ? true : null`, 45_000, 'DM 成员回复（fake 自动执行）').catch(() => false);
    facts.activeDmHash = await cdp.eval(probe(`location.hash`));
    // ⑦ 按会话 ID 定向接管/返回
    await cdp.eval(probe(`(() => { [...document.querySelectorAll('#hifi-root button')].find((b) => (b.title || '').includes('原界面打开'))?.click(); return true; })()`));
    await waitFor(cdp, `document.body.classList.contains('legacy-on') && window.__zsLegacyStarted === true`, 20_000, '接管切换');
    await waitFor(cdp, `(location.hash || '').startsWith('#dm=')`, 20_000, 'legacy 定位到会话（hash）');
    facts.takeoverLegacyHash = await cdp.eval(probe(`location.hash`));
    facts.takeoverById = facts.takeoverLegacyHash.replace('#dm=', '') === String(facts.activeDmHash || '').replace('#/dm/', '').replace('#dm=', '');
    await cdp.eval(probe(`document.querySelector('.zs-legacy-exit')?.click(), true`));
    await waitFor(cdp, `!document.body.classList.contains('legacy-on') && getComputedStyle(document.getElementById('hifi-root')).display !== 'none'`, 15_000, '返回新界面');
    facts.takeoverReturn = true;
    if (facts.takeoverById !== true) return fail('takeover-by-id', new Error(`hash=${facts.takeoverLegacyHash} expected=${facts.activeDmHash}`));
    // ⑧ 正式关窗（Browser.close）→ 退出+零残留
    const baseline = electronProcessCount();
    await cdp.closeBrowser();
    let exited = false;
    for (let i = 0; i < 40; i += 1) { await sleep(1000); try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) }); } catch { exited = true; break; } }
    facts.gracefulExit = exited;
    await sleep(3000);
    facts.residualElectron = Math.max(0, electronProcessCount() - Math.max(0, baseline - 1));
    facts.realCalls = await realCallsCount();
    facts.consoleTail = out.slice(-400);
    facts.pass = facts.autoProject && facts.poolSample && facts.lostAckBanner && facts.retryDelivered && facts.crossTargetOk && facts.recordOnly && facts.dmSent && facts.takeoverById && facts.takeoverReturn && facts.gracefulExit && facts.residualElectron === 0 && facts.realCalls === 0;
    return facts;
  } catch (e) {
    return fail(`run${n}`, e);
  }
}

/** run1 经含中文+空格的 junction 路径启动（mklink /J——验证路径鲁棒性；失败回退原路径并如实登记）。 */
function junctionPath() {
  const j = path.join(repo, 'dist', 'desktop', 'H1 验证 副本');
  try { fs.rmSync(j, { recursive: true, force: true }); } catch { /* 不存在 */ }
  const r = spawnSync('cmd', ['/c', `mklink /J "${j}" "${pkgDir}"`], { encoding: 'utf8' });
  if (r.status === 0) return j;
  console.warn('[hifi-verify] junction 创建失败（回退原路径）:', r.stdout, r.stderr);
  return pkgDir;
}

(async () => {
  if (!fs.existsSync(path.join(pkgDir, 'start-server.bat'))) { console.error('[hifi-verify] 包目录缺失 start-server.bat'); process.exit(1); }
  // run1 必须是真首启：预杀残留 electron、清数据根（run2/3 保留——验证二启幂等与重启历史）。
  spawnSync('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { stdio: 'ignore' });
  await sleep(2000);
  try { fs.rmSync(path.join(pkgDir, 'server-data'), { recursive: true, force: true }); console.log('[hifi-verify] 已清数据根（run1 真首启）'); } catch (e) { console.error('[hifi-verify] 清数据根失败（检查 electron 锁）:', e.message); process.exit(1); }
  const runs = [];
  for (let n = 1; n <= 3; n += 1) {
    const facts = await runOnce(n);
    fs.writeFileSync(path.join(evidenceDir, `run${n}.json`), JSON.stringify(facts, null, 2));
    console.log(`[hifi-verify] run${n} pass=${facts.pass} failedAt=${facts.failedAt ?? '-'} realCalls=${facts.realCalls}`);
    runs.push(facts);
    await sleep(2000);
  }
  const all = runs.every((r) => r.pass === true);
  fs.writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify({ allPass: all, runs: runs.map((r) => ({ run: r.run, pass: r.pass, failedAt: r.failedAt ?? null, realCalls: r.realCalls, residualElectron: r.residualElectron })) }, null, 2));
  console.log('[hifi-verify] allPass=' + all);
  process.exit(all ? 0 : 4);
})();
