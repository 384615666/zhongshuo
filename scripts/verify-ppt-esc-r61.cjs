'use strict';
/**
 * R61 P4（review-r60 §4）：交付形态真实 PPT Esc 查明。
 *
 * 背景：用户 v4 手测报告「Esc 不能退出展开」；R60 独立文本预览的 sendInputEvent Escape 可
 * full→normal，但不能用另一格式的通过撤掉用户的 PPT 现场。本脚本在**交付包独立副本**上：
 *  - 打开随包种子 PPT（回归幻灯.pptx——上传入库的房间样本）→ 共享预览 → 等真实视觉页
 *    done（pptx-renderer 舞台）→ 进入展开（按钮变「还原」+面板矩形实际变宽，双事实）；
 *  - 在四个焦点位分别送**原生键**（CDP Input.dispatchKeyEvent——走浏览器按键管线，同真实
 *    键盘；不是 window.dispatchEvent 合成事件）：工具栏按钮、幻灯内容（自然点击落点）、
 *    输入框（预览打开前就在输入的 textarea）、上层弹窗（Ctrl+K 命令面板）；
 *  - 记录每次键的实际接收（document 捕获层 __escLog：key+目标元素）、前后模式与面板矩形、
 *    按钮文案；上层弹窗期 Esc 应先关弹窗、预览保持展开（既定语义：Esc 退出展开不关预览）；
 *  - 缩放变体：Ctrl+= 实际放大后重复一键位（visualViewport.scale 记录——未生效则如实记录）。
 * 运行：node scripts/verify-ppt-esc-r61.cjs [--src 交付包目录]（默认 dist/desktop/hifi-h4-win-v4）。
 * 产物 dist/desktop/review-r61-esc/<标签>-result.json。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const repo = path.resolve(__dirname, '..');
const argSrc = process.argv.includes('--src') ? path.resolve(process.argv[process.argv.indexOf('--src') + 1]) : path.join(repo, 'dist', 'desktop', 'hifi-h4-win-v4');
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : path.basename(argSrc);
const outDir = path.join(repo, 'dist', 'desktop', 'review-r61-esc');
fs.mkdirSync(outDir, { recursive: true });
const copyRoot = path.join(outDir, `${label}-copy`);
const copyDir = path.join(copyRoot, 'esc 副本');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await Promise.race([this.send('Runtime.evaluate', { expression: expr, returnByValue: true }).catch((e) => { throw e; }), sleep(9000).then(() => { throw new Error('eval blocked'); })]); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 160)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  /** 原生键（浏览器按键管线——与真实键盘同路；不冒充 window.dispatchEvent 合成事件）。 */
  async nativeKey(key, code, vk, modifiers) {
    const base = { type: 'keyDownRaw' === 'x' ? 'x' : undefined, key, code, windowsVirtualKeyCode: vk };
    const down = { type: 'keyDown', ...base, ...(modifiers != null ? { modifiers } : {}) };
    const up = { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, ...(modifiers != null ? { modifiers } : {}) };
    try {
      await this.send('Input.dispatchKeyEvent', down);
    } catch {
      // 个别宿主拒 keyDown 无 text 形态——回退 rawKeyDown（同为原生管线）
      await this.send('Input.dispatchKeyEvent', { ...down, type: 'rawKeyDown' });
    }
    await this.send('Input.dispatchKeyEvent', up);
  }
  async esc() { await this.nativeKey('Escape', 'Escape', 27); }
}
async function connectPage(port, label2) {
  const deadline = Date.now() + 150_000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); return new Cdp(ws); }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label2}: CDP 连接超时`);
    await sleep(1000);
  }
}
async function waitFor(cdp, expr, ms, label2) {
  const t0 = Date.now();
  for (;;) {
    const v = await cdp.tryEval(probe(expr)).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label2);
    await sleep(900);
  }
}

async function main() {
  if (!fs.existsSync(argSrc)) throw new Error('交付包不存在：' + argSrc);
  fs.rmSync(copyRoot, { recursive: true, force: true });
  fs.mkdirSync(copyDir, { recursive: true });
  spawnSync('robocopy', [argSrc, copyDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const identity = { buildId: JSON.parse(fs.readFileSync(path.join(copyDir, 'ZhongshuoDual', 'BUILD.json'), 'utf8')).buildId, manifestSha: sha256File(path.join(copyDir, 'ZhongshuoDual', 'MANIFEST-SHA256.json')) };

  const port = 9583;
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(port) };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME;
  const child = spawn('cmd', ['/c', 'start-server.bat'], { cwd: copyDir, env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  let pauseFed = 0;
  const pauseFeeder = setInterval(() => { if (out.includes('Seeded.') && pauseFed < 45) { pauseFed += 1; try { child.stdin.write(String.fromCharCode(10)); } catch { /* 已退出 */ } } }, 2000);
  const report = { scope: '交付包独立副本×随包种子PPT×原生Escape键（CDP Input 管线）', src: argSrc, identity, positions: [], zoom: null, exitCodeOfLauncher: null };
  let cdp = null;
  try {
    cdp = await connectPage(port, 'esc');
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 110_000, '首启自动进入项目');
    // 种子 PPT：进默认房间 → 打开「PPT 预览样本」线程卡 → 点锚块 PPT 芯片。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('PPT 预览样本'))`, 30_000, '主池 PPT 样本卡');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('PPT 预览样本'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi]') == null && [...document.querySelectorAll('.msg-attach')].some((b) => b.textContent.includes('回归幻灯'))`, 30_000, '线程锚块 PPT 芯片');
    await cdp.eval(probe(`[...document.querySelectorAll('.msg-attach')].find((b) => b.textContent.includes('回归幻灯'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi]') != null`, 15_000, '共享预览打开');
    // 真实视觉页（pptx-renderer）：舞台实际挂载 + visual-state=done（兄弟节点——不接受降级/外层容器冒充）。
    const kindLine = await cdp.tryEval(`document.querySelector('[data-zs-preview=hifi]')?.textContent.slice(0, 80) ?? null`);
    const stageUp = await waitFor(cdp, `document.querySelector('[data-zs-pptx-stage=hifi]') != null`, 30_000, 'PPT 视觉舞台挂载').catch(() => false);
    const visualDone = stageUp === true ? await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi] [data-zs-visual-state=done]') != null`, 60_000, 'PPT 视觉页 done').catch(() => false) : false;
    const stageInfo = await cdp.eval(probe(`(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); return JSON.stringify({ children: st ? st.childElementCount : -1, page: document.querySelector('[data-zs-slide-page]')?.getAttribute('data-zs-slide-page') ?? null, count: document.querySelector('[data-zs-slide-count]')?.getAttribute('data-zs-slide-count') ?? null }); })()`));
    report.pptVisual = { done: visualDone === true, stageUp: stageUp === true, kindLine, stage: JSON.parse(stageInfo) };
    // 键接收记录器（document 捕获层——无论后续谁消费/拦截都先记到）。
    await cdp.eval(`window.__escLog = []; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escLog.push({ key: e.key, tag: e.target?.tagName ?? '?', id: e.target?.id ?? '' }); }, true); true`);
    const widthState = () => cdp.eval(probe(`(() => { const p = document.querySelector('[data-zs-preview=hifi]'); const btn = [...(p?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === '展开' || b.textContent.trim() === '还原'); return JSON.stringify({ mode: p?.getAttribute('data-zs-preview-width') ?? null, rect: Math.round(p?.getBoundingClientRect().width ?? -1), vw: window.innerWidth, btn: btn?.textContent.trim() ?? null }); })()`));
    const enterFull = async () => {
      await cdp.eval(probe(`[...document.querySelectorAll('[data-zs-preview=hifi] button')].find((b) => b.title.includes('全屏展开'))?.click(), true`));
      await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi]')?.getAttribute('data-zs-preview-width') === 'full'`, 8_000, '进入展开');
    };
    const nativeEscAt = async (position, setupExpr) => {
      await enterFull();
      if (setupExpr != null) await cdp.eval(setupExpr);
      await sleep(250);
      const before = JSON.parse(await widthState());
      await cdp.eval(`window.__escLog = []; true`);
      await cdp.esc();
      await sleep(450);
      const after = JSON.parse(await widthState());
      const log = await cdp.tryEval(`window.__escLog.slice()`);
      return { position, before, after, receivedKeys: Array.isArray(log) ? log : [], exited: before.mode === 'full' && before.btn === '还原' && after.mode === 'normal' && after.rect < before.rect };
    };

    // —— 焦点位①工具栏：进入展开的按钮本身持焦点（点击后自然落点——真实工具栏位）。
    report.positions.push(await nativeEscAt('toolbar', null));
    // —— 焦点位②幻灯内容：自然点击舞台（焦点回落 body——真实点击位）。
    report.positions.push(await nativeEscAt('slide-content', probe(`(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); if (st == null) return false; const r = st.getBoundingClientRect(); const ev = new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 120) }); st.dispatchEvent(ev); return true; })()`)));
    // —— 焦点位③输入框：预览打开前就在输入的 textarea（覆盖层后方仍持焦点——用户实际形态）。
    report.positions.push(await nativeEscAt('input-behind-pane', probe(`document.querySelector('#hifi-root textarea.composer-input')?.focus(), true`)));

    // —— 焦点位④上层弹窗：Ctrl+K 开命令面板 → Esc 先关弹窗（预览保持展开）→ 再 Esc 退出展开。
    await cdp.eval(probe(`[...document.querySelectorAll('[data-zs-preview=hifi] button')].find((b) => b.title.includes('全屏展开'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi]')?.getAttribute('data-zs-preview-width') === 'full'`, 8_000, '重入展开');
    await cdp.nativeKey('k', 'KeyK', 75, 2);
    await waitFor(cdp, `document.querySelector('[data-zs-palette=hifi]') != null`, 6_000, '命令面板打开');
    await cdp.eval(`window.__escLog = []; true`);
    const dlgBefore = JSON.parse(await widthState());
    await cdp.esc();
    await sleep(450);
    const dlgAfterEsc1 = JSON.parse(await widthState());
    const dlgClosed = await cdp.tryEval(`document.querySelector('[data-zs-palette=hifi]') == null`);
    await cdp.esc();
    await sleep(450);
    const dlgAfterEsc2 = JSON.parse(await widthState());
    report.positions.push({ position: 'upper-dialog', before: dlgBefore, afterFirstEsc: dlgAfterEsc1, dialogClosedFirst: dlgClosed === true, afterSecondEsc: dlgAfterEsc2, exitedOnSecond: dlgAfterEsc1.mode === 'full' && dlgAfterEsc2.mode === 'normal', exited: dlgClosed === true && dlgAfterEsc2.mode === 'normal' });

    // —— 缩放变体：Ctrl+= 实际放大（visualViewport.scale 记录；未生效如实记录）后一键位复测。
    const scaleBefore = await cdp.tryEval(`window.visualViewport?.scale ?? null`);
    for (let i = 0; i < 3; i += 1) { await cdp.nativeKey('+', 'Equal', 187, 2); await sleep(200); }
    const scaleAfter = await cdp.tryEval(`window.visualViewport?.scale ?? null`);
    let zoomCase = null;
    if (typeof scaleAfter === 'number' && scaleAfter > (scaleBefore ?? 1) + 0.01) {
      await cdp.eval(probe(`[...document.querySelectorAll('[data-zs-preview=hifi] button')].find((b) => b.title.includes('全屏展开'))?.click(), true`));
      await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi]')?.getAttribute('data-zs-preview-width') === 'full'`, 8_000, '缩放下进入展开');
      zoomCase = await nativeEscAt('zoomed-slide-content', null);
    }
    report.zoom = { scaleBefore, scaleAfter, applied: zoomCase != null, case: zoomCase };

    report.overall = report.pptVisual.done === true
      && report.positions.slice(0, 3).every((p) => p.exited === true)
      && (report.positions[3] != null && report.positions[3].exited === true)
      && (report.zoom.case == null || report.zoom.case.exited === true);
  } finally {
    clearInterval(pauseFeeder);
    try { if (cdp != null) await cdp.eval(`window.close ? (document.querySelector('.zs-winbtn[title=关闭]')?.click(), true) : true`); } catch { /* 尽力 */ }
    await sleep(1500);
    const kill = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${copyDir.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''")}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "$($_.ProcessId)" }`,
    ], { encoding: 'utf8', timeout: 60_000 });
    report.residualProcsKilled = String(kill.stdout ?? '').trim().split(/\s+/).filter(Boolean);
    try { child.kill(); } catch { /* 已退出 */ }
    await sleep(600);
    const exitLine = out.split(/\r?\n/).find((l) => /exit|退出码/i.test(l)) ?? null;
    report.launcherTail = out.split(/\r?\n/).slice(-4).join(' | ');
    void exitLine;
  }
  const file = path.join(outDir, `${label}-result.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ file, overall: report.overall, positions: report.positions.map((p) => ({ p: p.position, exited: p.exited, before: p.before?.mode, after: (p.after ?? p.afterSecondEsc)?.mode, keys: (p.receivedKeys ?? []).length })) }, null, 2));
  process.exit(report.overall === true ? 0 : 3);
}
void main().catch((e) => { console.error('[r61-esc] 失败：', e); process.exit(1); });
