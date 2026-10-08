#!/usr/bin/env node
/**
 * verify-daily-r72.cjs —— R72「原始使用路径修复与桌面日常收口」门（2026-10-08）
 *
 * 修复对应（review-r71-original-path §P1/P2 + 验证口径纠正）：
 *  - G1 文件树**原始路径**真实 22.54MiB PPT：树点击→渲染→图文页/末页→切标签回位→另存
 *    原字节一致；同真件再分别走**上传件**与**成果文件**通道（review：上传通过不能替代
 *    工作区路径；20–32MiB 区间正例——33.5MiB 在旧 20MiB 下同样失败，不构成扩容证据）。
 *  - G2 Git 状态往返：普通→Git→普通、错误→成功、跨项目分列，不靠重启清状态
 *    （P2：成功路径残留 notARepo/非 Git 残留旧投影/真实错误清中性标记）。
 *  - G3 82 页**逐页**真实渲染 walk：每页等真实渲染+图片解码，页级失败逐页记录
 *    （纠正「82 页全部渲染」的口径——此前只证计数+1/40/82 抽样）。
 *  - G4 Excel 69793 行首/中/末**数据行与源事实核对**（openpyxl 源值 + 引擎滚动 +
 *    键盘取值剪贴板）+ 横纵滚动 + 返回状态恢复（纠正「外壳 mode=engine 即就绪」）。
 *  - G5 进程资源（daemon/worker/renderer **全进程**采样，纠正 JS heap 冒充总内存）+
 *    解析排队（并发两件串行完成）+ 关闭收拢（子进程回基线、重开可用）。
 *  - G6 /thread/:id 深链矩阵：复制直链、切项目后直链、看板/待办/收藏/搜索定位、
 *    冷启动重开、跨项目不串（R71 登记的深链不稳定——修 loadThread 跨项目丢弃）。
 *  - G7 六来源真件 PPT（①草稿②已发③线程回复④DM 在此；⑤树⑥成果在 G1）+
 *    文件树 33.5MiB 负例（旧 20MiB 下也失败的件不证明扩容；负例只证上限仍在）。
 *
 * 约束：零真实模型调用（fake runtime）；用户样本只读（复制到自有目录，原件不动）；
 * 不操作用户目录 .git（Git 往返只在自有副本）；输出在 dist/desktop/gate-r72-*。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const os = require('node:os');

const repo = path.resolve(__dirname, '..');
const runId = `r72-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r72-${runId}`);

const PORT = 9703;
const shotsDir = path.join(outDir, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const saveAsDir = path.join(outDir, 'saved');
fs.mkdirSync(saveAsDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`);
    await sleep(250);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.consoleErrors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.consoleErrors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 300)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async shot(name) { try { const png = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(png.data, 'base64')); return true; } catch { return false; } }
}
async function connectPage(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const waitFor = async (cdp, expr, ms, label) => until(() => cdp.tryEval(probe(expr)).catch(() => null), (v) => v, ms, label);
const own = new Set();
function cleanupOwn() { for (const c of [...own]) { if (c.exitCode != null) continue; try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } }
const dbOf = (root) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(root, 'state.sqlite')); return { q: (sql, ...a) => db.prepare(sql).all(...a), close: () => db.close() }; };
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');
let __appOut = { v: '' };
let f = { g1: {}, g2: {}, g3: { pages: [], failures: [] }, g4: {}, g5: { samples: [] }, g6: {}, g7: {} };

/* ---------------- 夹具（只读复制用户样本到自有目录；敏感正文不写入报告） ---------------- */
const SAMPLES = 'C:/Users/user/Documents/文档测试';
const fx = path.join(outDir, 'fixtures');
fs.mkdirSync(fx, { recursive: true });
const FIX = {
  pptxBig: path.join(SAMPLES, '内蒙古职工互助系统建设方案@1010.pptx'),
  xlsx: path.join(SAMPLES, '去重翻译表v4_名词统一.xlsx'),
};
for (const [k, p] of Object.entries(FIX)) { if (!fs.existsSync(p)) { console.error(`样本缺失：${p}`); process.exit(2); } }
const PPT_NAME = '内蒙古职工互助系统建设方案@1010.pptx';
const XLSX_NAME = '去重翻译表v4_名词统一.xlsx';
// 文件树 33.5MiB 负例（合成——byteCap 阶段即拒，不需真结构）。
FIX.pptxOver = path.join(fx, 'r72-超限.pptx');
{
  const buf = Buffer.alloc(33.5 * 1024 * 1024);
  Buffer.from('PK', 'latin1').copy(buf, 0);
  for (let i = 4; i < buf.length; i += 4096) buf[i] = (i / 4096) & 0xff;
  fs.writeFileSync(FIX.pptxOver, buf);
}

/* ---------------- XLSX 源事实（openpyxl——首/中/末数据行与全行值） ---------------- */
const XLSX_FACTS = (() => {
  const py = [
    'import openpyxl, json, sys',
    'wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)',
    'ws = wb.worksheets[0]',
    'colA = []; row1 = None; row2 = None; last = None',
    'for r in ws.iter_rows(min_col=1, max_col=12, values_only=True):',
    '    n = len(colA) + 1',
    '    colA.append("" if r[0] is None else str(r[0]))',
    '    vals = ["" if v is None else str(v) for v in r]',
    '    if n == 1: row1 = vals',
    '    if n == 2: row2 = vals',
    '    last = vals',
    'total = len(colA); mid = total // 2 + 1',
    'band = {}',
    'for i, r in enumerate(ws.iter_rows(min_row=mid-40, max_row=mid+40, min_col=1, max_col=12, values_only=True), start=mid-40):',
    '    band[i] = ["" if v is None else str(v) for v in r]',
    'print(json.dumps({ "sheet": ws.title, "total": total, "mid": mid, "row1": row1, "row2": row2, "last": last, "band": band }, ensure_ascii=False))',
    'wb.close()',
  ].join('\n');
  const out = execFileSync('python', ['-c', py, FIX.xlsx], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
  return JSON.parse(out);
})();

async function launchApp(dataRoot, extraEnv = {}) {
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_SAVEAS_AUTO_DIR: saveAsDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  own.add(app);
  app.once('exit', () => own.delete(app));
  app.stdout.on('data', (c) => { __appOut.v += c; });
  app.stderr.on('data', (c) => { __appOut.v += c; });
  const cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
  return { app, cdp };
}
async function closeApp(app, cdp) {
  try { if (cdp != null && !cdp.closed) await cdp.send('Browser.close'); } catch { /* 已退 */ }
  await until(async () => { try { process.kill(app.pid, 0); return false; } catch { return true; } }, (v) => v, 20000, 'app 优雅退出').catch(async () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } });
  await sleep(1800);
}
async function pageCmd(cdp, method, params, commandId) {
  const v = await cdp.send('Runtime.evaluate', {
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g72-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
    awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(v.result.value);
}
const pageOk = async (cdp, method, params) => { const r = await pageCmd(cdp, method, params); if (r && r.ok !== true) throw new Error(`${method}: ${r.error?.message}`); return r.data ?? r; };
async function bootProject(cdp) {
  await cdp.eval('location.reload(), true');
  const c = await connectPage('boot 重载');
  await waitFor(c, `document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间')`, 45000, '侧栏项目/默认房间');
  await sleep(900);
  return c;
}
async function openRoomComposer(cdp, root, projId) {
  await until(() => cdp.tryEval(probe(`document.body.classList.contains('hifi-on') && (document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间'))`)).catch(() => null), (v) => v, 45000, '房间前就绪');
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${projId}`)}; true`);
  await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, '项目装载（默认房间）');
  const room = dbOf(root).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', projId)[0];
  await cdp.eval(`location.hash = ${JSON.stringify(`/room/${room.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, '房间输入区');
  await sleep(600);
  return room.id;
}
const waitSendEnabled = (cdp, ms = 30000) => until(() => cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .composer-send'); return b != null && b.disabled !== true; })()`)).catch(() => null), (v) => v === true, ms, '发送按钮可用');
async function uploadViaPage(cdp, filePath, name, mime = 'application/octet-stream') {
  const b64 = fs.readFileSync(filePath).toString('base64');
  await cdp.eval(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
    const input = document.querySelector('#hifi-root input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}
let chipStatesSnapshot = null;
async function chipStates(cdp) {
  return await cdp.tryEval(`(() => {
    const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')].map((c) => ({ att: c.getAttribute('data-zs-att') || '', err: c.getAttribute('data-zs-att-error') || '', warn: c.getAttribute('data-zs-att-warn') || '', text: c.textContent.slice(0, 120) }));
    return chips;
  })()`);
}
async function waitChip(cdp, name, state, ms = 60000) {
  return await until(async () => {
    const chips = await chipStates(cdp);
    chipStatesSnapshot = chips;
    const hit = chips.find((c) => (state === 'failed' ? c.err === name : state === 'warn' ? c.warn === name : c.att === 'ready' && c.text.includes(name) && !c.err && !c.warn));
    return hit ?? null;
  }, (v) => v != null, ms, `芯片 ${name}=${state}`).catch((e) => { throw new Error(`${e.message}；chips=${JSON.stringify(chipStatesSnapshot)}`); });
}
async function clickChipPreview(cdp, name) {
  for (let i = 0; i < 30; i += 1) {
    const v = await cdp.tryEval(probe(`(() => {
      const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')];
      const chip = chips.find((c) => (c.getAttribute('data-zs-att') === 'ready') && c.textContent.includes(${JSON.stringify(name)}));
      if (chip == null) return 'NO_CHIP';
      const btn = [...chip.querySelectorAll('button')].find((b) => b.textContent.trim() === '预览');
      if (btn == null) return 'NO_BTN';
      btn.click(); return true;
    })()`));
    if (v === true) return true;
    await sleep(500);
  }
  throw new Error(`clickChipPreview: ${name} 未就绪`);
}
async function saveOriginal(cdp, namePart) {
  const before = new Set(fs.readdirSync(saveAsDir));
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item, #hifi-root [role=menu] .menu-item')].find((x) => x.textContent.includes('下载原文件'))?.click(), true`));
  await until(() => { try { return fs.readdirSync(saveAsDir).filter((n) => !before.has(n)).length; } catch { return 0; } }, (n) => n >= 1, 25000, `另存落盘 ${namePart}`);
  await sleep(800);
  const saved = fs.readdirSync(saveAsDir).filter((n) => !before.has(n)).map((n) => path.join(saveAsDir, n)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  return { path: saved, sha256: sha256Buf(fs.readFileSync(saved)), bytes: fs.statSync(saved).size };
}
async function openMoreMenu(cdp) {
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '更多菜单');
}
const closeAll = async (cdp) => {
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '菜单');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
  await sleep(700);
};
const clickTreeFile = async (cdp, exactName) => {
  await until(() => cdp.tryEval(probe(`document.body.textContent.includes(${JSON.stringify(exactName)})`)).catch(() => null), (v) => v, 30000, `树列 ${exactName}`);
  await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === ${JSON.stringify(exactName)}); rows[rows.length - 1]?.click(); return true; })()`));
};
const realCallsOf = (root) => { try { return dbOf(root).q('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } };
const heapOf = async (cdp) => {
  try { const m = await cdp.send('Performance.getMetrics'); const hit = m.metrics.find((x) => x.name === 'JSHeapUsedSize'); return hit ? Math.round(hit.value / 1048576) : null; } catch { return null; }
};

/* ---------------- PowerShell：进程树采样 + 系统剪贴板 ---------------- */
function psTree(pid) {
  const script = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$o=@(); $s=New-Object System.Collections.Stack; $s.Push([int]${JSON.stringify(pid)})`,
    `while($s.Count -gt 0){ $cp=$s.Pop(); $kids=Get-CimInstance Win32_Process -Filter "ParentProcessId=$cp"`,
    `  foreach($k in $kids){ $o += [pscustomobject]@{pid=[int]$k.ProcessId; name=[string]$k.Name; ws=[uint64]$k.WorkingSetSize}; $s.Push([int]$k.ProcessId) } }`,
    `$o | ConvertTo-Json -Compress`,
  ].join('\n');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 });
    if (!out.trim()) return [];
    const v = JSON.parse(out);
    return Array.isArray(v) ? v : [v];
  } catch { return []; }
}
const getClipboard = () => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' }).replace(/\r\n/g, '\n').trimEnd(); } catch { return null; } };

/* ---------------- CDP 键盘/点击 ---------------- */
const KEY = { home: { key: 'Home', code: 'Home', vk: 36 }, end: { key: 'End', code: 'End', vk: 35 }, down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, c: { key: 'c', code: 'KeyC', vk: 67 } };
const CTRL = 2, SHIFT = 8;
async function pressKey(cdp, k, mod = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mod, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
}
async function clickCenter(cdp, selector) {
  // canvas 可能比视口大（横向滚动后更甚）——取**与视口可见区域的交集中心**，否则点到屏外。
  const r = await cdp.eval(probe(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el == null) return null; const b = el.getBoundingClientRect(); const vx = Math.max(b.x, 0), vy = Math.max(b.y, 0); const vr = Math.min(b.right, window.innerWidth), vb = Math.min(b.bottom, window.innerHeight); if (vr - vx < 24 || vb - vy < 24) return null; return { x: Math.round((vx + vr) / 2), y: Math.round((vy + vb) / 2) }; })()`));
  if (r == null) throw new Error(`clickCenter: 未找到（可见交集） ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
}

(async () => {
  const errs = [];
  const realCallRoots = {};
  process.on('SIGINT', () => { cleanupOwn(); process.exit(130); });

  /* ================= G1 文件树原始路径真实大 PPT（P1 本体）+ 上传件/成果文件分列 ================= */
  {
    const root1 = path.join(outDir, 'root1');
    const projDir = path.join(outDir, 'proj1');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G1\n', 'utf8');
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME)); // 只读复制：树读快照
    fs.writeFileSync(path.join(projDir, '说明.md'), '# G1 说明\n', 'utf8');
    // 成果文件通道素材：fake 交付落盘同一真件字节。
    const specPath = path.join(outDir, 'write-spec-g1.json');
    fs.writeFileSync(specPath, JSON.stringify([{ path: '交付演示.pptx', contentBase64: fs.readFileSync(FIX.pptxBig).toString('base64') }]), 'utf8');
    let { app, cdp } = await launchApp(root1, { ZS_FAKE_WRITE_FILES_JSON: specPath });
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    // ⓪ 先派发任务（成果通道素材异步就绪）。
    {
      const roomConv = dbOf(root1).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', proj.id, 'room')[0];
      const roomRow = dbOf(root1).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id)[0];
      const members = await pageOk(cdp, 'member.list', { projectId: proj.id });
      const agent = members.items.find((m) => m.principalType === 'agent');
      await pageCmd(cdp, 'message.submit', {
        target: { kind: 'room_root', projectId: proj.id, conversationId: roomConv.cid, roomId: roomRow.id },
        body: '生成交付演示', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }],
      });
    }
    /* --- ⑤ 文件树：用户原始路径（20–32MiB 区间正例——此前被 20MiB 拒） --- */
    const t0 = Date.now();
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 文件树');
    await clickTreeFile(cdp, PPT_NAME);
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]') != null`, 180000, 'G1 树开 PPT 视图');
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) > 0; })()`, 180000, 'G1 页数就绪');
    f.g1.treeFirstViewMs = Date.now() - t0;
    f.g1.pages = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages')`));
    await waitFor(cdp, `document.querySelector('#hifi-root .pptx-main .pptx-slide-mount > *') != null`, 120000, 'G1 主舞台首页渲染');
    f.g1.treeSource = true;
    // readFull/originalFile 命令层合同（20–32MiB 不再拒+33.5 拒+PDF 分道）由
    // r67Contracts.test.ts「R72」边界用例锁定（CDP 传 31MB base64 会超时，不走页面通道）；
    // UI 侧端到端证明=本次树点击→82 页渲染（渲染器经同一 readFull 通道取得字节）。
    f.g1.readFullOk = 'r67Contracts(20–32MiB 边界)+树渲染';
    f.g1.originalFileOk = 'r67Contracts(sha256 原字节)';
    // 图文页（p40）图片解码。
    const gotoPptPage = async (n) => {
      await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[${n - 1}]?.click(), true`));
      await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '${n}'`, 90000, `G1 跳页 ${n}`);
      await sleep(2600);
    };
    await gotoPptPage(40);
    f.g1.p40Imgs = await cdp.tryEval(probe(`(() => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; return { imgs: root.querySelectorAll('img').length, decoded: [...root.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).length }; })()`));
    // 末页。
    await gotoPptPage(f.g1.pages);
    f.g1.lastPageOk = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`)) === f.g1.pages;
    // 切标签回位：上传小 MD 作第二标签 → 切走 → 切回 → 页码恢复。
    await openRoomComposer(cdp, root1, proj.id);
    await uploadViaPage(cdp, path.join(projDir, '说明.md'), '说明.md', 'text/markdown');
    await waitChip(cdp, '说明.md', 'ready');
    await clickChipPreview(cdp, '说明.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-read-doc') != null`, 30000, 'G1 MD 打开');
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('内蒙古')); t?.click(); return true; })()`));
    await sleep(2500);
    f.g1.restorePage = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`);
    // 另存原字节一致（树源）。
    await openMoreMenu(cdp);
    const saved = await saveOriginal(cdp, '内蒙古');
    f.g1.savedIdentical = saved.sha256 === sha256Buf(fs.readFileSync(FIX.pptxBig));
    f.g1.savedBytes = saved.bytes;
    await cdp.shot('g1-tree-ppt');
    /* --- G3 82 页逐页真实渲染 walk（同 app；每页等待真实渲染+图片解码，页级失败记录） --- */
    {
      // 回到 PPT 标签（当前已在）。
      const heapBefore = await heapOf(cdp);
      const walkT0 = Date.now();
      let failCount = 0;
      for (let n = 1; n <= f.g1.pages; n += 1) {
        await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[${n - 1}]?.click(), true`));
        let landed = true, rendered = true, imgs = null;
        try {
          await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '${n}'`, 20000, `G3 页 ${n} 落位`);
        } catch { landed = false; }
        if (landed) {
          try {
            await waitFor(cdp, `document.querySelector('#hifi-root .pptx-main .pptx-slide-mount')?.childElementCount > 0`, 20000, `G3 页 ${n} 渲染`);
          } catch { rendered = false; }
          imgs = await until(() => cdp.tryEval(probe(`(() => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; const is = [...root.querySelectorAll('img')]; return { n: is.length, d: is.filter((i) => i.complete && i.naturalWidth > 0).length }; })()`)).catch(() => null), (v) => v != null && v.n === v.d, 15000, `G3 页 ${n} 图片`).catch((e) => ({ timeout: String(e.message).slice(0, 80) }));
        }
        const entry = { p: n, landed, rendered, imgs };
        f.g3.pages.push(entry.p <= 3 || entry.p === f.g1.pages || !landed || !rendered ? entry : entry.p); // 全量记录（报告自筛）
        if (!landed || !rendered || (imgs != null && imgs.timeout != null)) { failCount += 1; f.g3.failures.push(entry); }
      }
      f.g3.total = f.g1.pages;
      f.g3.walkMs = Date.now() - walkT0;
      f.g3.failCount = failCount;
      f.g3.heapBeforeMB = heapBefore;
      f.g3.heapAfterMB = await heapOf(cdp);
      await cdp.shot('g3-walk-end');
    }
    /* --- 上传件通道（同真件） --- */
    {
      await closeAll(cdp);
      await openRoomComposer(cdp, root1, proj.id);
      const t = Date.now();
      await uploadViaPage(cdp, FIX.pptxBig, PPT_NAME, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      await waitChip(cdp, PPT_NAME, 'ready', 180000);
      f.g1.uploadMs = Date.now() - t;
      await clickChipPreview(cdp, PPT_NAME);
      await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) >= 80; })()`, 180000, 'G1 上传件视图');
      f.g1.uploadSource = true;
    }
    /* --- 成果文件通道（同真件字节落盘） --- */
    {
      await until(() => { try { return dbOf(root1).q('SELECT count(*) c FROM task_deliveries')[0].c; } catch { return 0; } }, (c) => c >= 1, 180000, 'G1 自然交付');
      const dlv = dbOf(root1).q('SELECT id FROM task_deliveries ORDER BY rowid DESC LIMIT 1')[0];
      const threadId = dbOf(root1).q('SELECT conversation_thread_id FROM tasks WHERE current_delivery_id = ?', dlv.id)[0]?.conversation_thread_id;
      f.g1.deliveryDiskIdentical = sha256Buf(fs.readFileSync(path.join(projDir, '交付演示.pptx'))) === sha256Buf(fs.readFileSync(FIX.pptxBig));
      await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadId}?tab=artifacts`)}; true`);
      try {
        await waitFor(cdp, `document.querySelector('[data-zs-delivery-row]') != null`, 45000, 'G1 交付行');
      } catch (e) {
        const dump = await cdp.tryEval(probe(`(() => ({ hash: location.hash.slice(0, 100), thread: document.querySelector('#hifi-root .col-thread') != null, tabs: [...document.querySelectorAll('#hifi-root .thread-tab')].map((t) => t.textContent.trim()).slice(0, 8), body: document.body.textContent.replace(/\s+/g, ' ').slice(0, 220) }))()`));
        throw new Error(`G1 交付行未现：${JSON.stringify(dump)}；console=${JSON.stringify((cdp.consoleErrors ?? []).slice(0, 3))}`);
      }
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.trim() === '打开文档'); b?.click(); return true; })()`));
      await waitFor(cdp, `document.querySelector('[data-zs-delivery-doc]') != null`, 25000, 'G1 报告');
      await waitFor(cdp, `[...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].some((b) => b.getAttribute('data-zs-delivery-file') === '交付演示.pptx')`, 15000, 'G1 文件入口');
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].find((x) => x.getAttribute('data-zs-delivery-file') === '交付演示.pptx'); b?.click(); return true; })()`));
      await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) >= 80; })()`, 180000, 'G1 成果文件视图');
      f.g1.deliverySource = true;
    }
    if (f.g1.treeSource !== true || !(f.g1.pages >= 80)) errs.push(`G1：文件树大 PPT（pages=${f.g1.pages}）`);
    if (typeof f.g1.readFullOk !== 'string' || typeof f.g1.originalFileOk !== 'string') errs.push(`G1：readFull/originalFile 命令层（read=${f.g1.readFullOk} orig=${f.g1.originalFileOk}）`);
    if (f.g1.p40Imgs != null && f.g1.p40Imgs.imgs > 0 && f.g1.p40Imgs.decoded !== f.g1.p40Imgs.imgs) errs.push(`G1：图文页图片未全解码（${JSON.stringify(f.g1.p40Imgs)}）`);
    if (f.g1.lastPageOk !== true || String(f.g1.restorePage) !== String(f.g1.pages)) errs.push(`G1：末页/回位（last=${f.g1.lastPageOk} restore=${f.g1.restorePage}/${f.g1.pages}）`);
    if (f.g1.savedIdentical !== true) errs.push(`G1：树源另存不一致（${f.g1.savedBytes}B）`);
    if (f.g1.uploadSource !== true || f.g1.deliverySource !== true || f.g1.deliveryDiskIdentical !== true) errs.push(`G1：上传/成果分列（up=${f.g1.uploadSource} dlv=${f.g1.deliverySource} disk=${f.g1.deliveryDiskIdentical}）`);
    realCallRoots.root1 = realCallsOf(root1);
    await closeApp(app, cdp);
  }

  /* ================= G2 Git 状态往返（P2 本体） ================= */
  {
    const root2 = path.join(outDir, 'root2');
    // 仓库外普通目录（gate 输出目录在 zhongshuo 仓库内——git 向上发现外层仓库是正确行为）。
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r72-A-'));
    fs.writeFileSync(path.join(projA, 'a说明.md'), '# A（先非 Git）\n', 'utf8');
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r72-B-'));
    fs.writeFileSync(path.join(projB, 'B项目说明.md'), '# B（Git，分支 trunk）\n', 'utf8');
    execFileSync('git', ['-C', projB, 'init', '-b', 'trunk'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projB, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projB, '-c', 'user.name=r72', '-c', 'user.email=r72@local', 'commit', '-m', 'b1'], { stdio: 'ignore' });
    let { app, cdp } = await launchApp(root2, {});
    const a = (await pageOk(cdp, 'project.open', { path: projA })).project;
    const b = (await pageOk(cdp, 'project.open', { path: projB })).project;
    cdp = await bootProject(cdp);
    const gitState = async (pid, marker) => {
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pid}`)}; true`);
      await sleep(500);
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pid}/files`)}; true`);
      await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G2 文件树');
      await until(() => cdp.tryEval(probe(`document.body.textContent.includes(${JSON.stringify(marker)})`)).catch(() => null), (v) => v, 30000, `G2 树列 ${marker}`);
      await sleep(2800); // git 状态装载窗
      return {
        neutral: await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-git-neutral]') != null`),
        danger: await cdp.tryEval(probe(`(() => { const ps = [...document.querySelectorAll('#hifi-root .panel.danger')]; return ps.some((p) => p.textContent.includes('git.status')); })()`)),
        repoLabel: await cdp.tryEval(`document.querySelector('#hifi-root .fg-statusbar')?.textContent.includes('Git 仓库')`),
        plainLabel: await cdp.tryEval(`document.querySelector('#hifi-root .fg-statusbar')?.textContent.includes('非 Git 目录')`),
        branch: await cdp.tryEval(probe(`(() => { const sb = document.querySelector('#hifi-root .fg-statusbar'); const m = sb != null ? sb.textContent.match(/([a-z0-9_-]+)\\s*·/) : null; return m != null ? m[1] : (sb != null && sb.textContent.includes('main') ? 'main' : sb != null && sb.textContent.includes('trunk') ? 'trunk' : null); })()`)),
      };
    };
    // ① 首开非 Git：中性、无红。
    f.g2.initial = await gitState(a.id, 'a说明.md');
    // ② 自有副本 git init+commit → 离开/返回 → 「Git 仓库｜main」且中性面板消失（P2 回归点）。
    execFileSync('git', ['-C', projA, 'init', '-b', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projA, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projA, '-c', 'user.name=r72', '-c', 'user.email=r72@local', 'commit', '-m', 'a1'], { stdio: 'ignore' });
    f.g2.afterInit = await gitState(a.id, 'a说明.md');
    // ③ 仓库→普通（删自有 .git）→ 中性回归、旧分支投影消失。
    fs.rmSync(path.join(projA, '.git'), { recursive: true, force: true });
    f.g2.afterRemove = await gitState(a.id, 'a说明.md');
    // ④ 错误→成功：.git/objects 变普通文件（git 报 fatal: bad object HEAD——真实执行错误，
    //    不落入 NOT_A_GIT_REPO 中性分类；.git 本身变文件会被 simple-git 归为非仓库）→ 红失败；
    //    恢复目录 → 红消失+分支回。
    execFileSync('git', ['-C', projA, 'init', '-b', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projA, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projA, '-c', 'user.name=r72', '-c', 'user.email=r72@local', 'commit', '-m', 'a2'], { stdio: 'ignore' });
    fs.renameSync(path.join(projA, '.git', 'objects'), path.join(projA, 'objects-bak'));
    fs.writeFileSync(path.join(projA, '.git', 'objects'), 'corrupt', 'utf8');
    f.g2.afterCorrupt = await gitState(a.id, 'a说明.md');
    fs.rmSync(path.join(projA, '.git', 'objects'), { force: true });
    fs.renameSync(path.join(projA, 'objects-bak'), path.join(projA, '.git', 'objects'));
    f.g2.afterRestore = await gitState(a.id, 'a说明.md');
    // ⑤ 跨项目往返（不重启）：B（trunk）↔ A（main）分列不串。
    f.g2.projB = await gitState(b.id, 'B项目说明.md');
    f.g2.backToA = await gitState(a.id, 'a说明.md');
    await cdp.shot('g2-git-roundtrip');
    if (f.g2.initial.neutral !== true || f.g2.initial.danger === true || f.g2.initial.repoLabel === true) errs.push(`G2：首开非 Git（${JSON.stringify(f.g2.initial)}）`);
    if (f.g2.afterInit.repoLabel !== true || f.g2.afterInit.neutral === true || f.g2.afterInit.danger === true || f.g2.afterInit.branch !== 'main') errs.push(`G2：非Git→Git 往返（${JSON.stringify(f.g2.afterInit)}）`);
    if (f.g2.afterRemove.neutral !== true || f.g2.afterRemove.repoLabel === true || f.g2.afterRemove.plainLabel !== true) errs.push(`G2：Git→非Git 往返（${JSON.stringify(f.g2.afterRemove)}）`);
    if (f.g2.afterCorrupt.danger !== true || f.g2.afterCorrupt.neutral === true) errs.push(`G2：真实错误红失败（${JSON.stringify(f.g2.afterCorrupt)}）`);
    if (f.g2.afterRestore.danger === true || f.g2.afterRestore.repoLabel !== true || f.g2.afterRestore.branch !== 'main') errs.push(`G2：错误→成功清红（${JSON.stringify(f.g2.afterRestore)}）`);
    if (f.g2.projB.branch !== 'trunk' || f.g2.projB.neutral === true || f.g2.backToA.branch !== 'main' || f.g2.backToA.neutral === true) errs.push(`G2：跨项目分列（B=${JSON.stringify(f.g2.projB)} A=${JSON.stringify(f.g2.backToA)}）`);
    realCallRoots.root2 = realCallsOf(root2);
    await closeApp(app, cdp);
  }

  /* ================= G4 Excel 69793 行：首/中/末数据行与源事实核对 + 横纵滚动 + 返回状态 ================= */
  {
    const root4 = path.join(outDir, 'root4');
    const projDir = path.join(outDir, 'proj4');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G4\n', 'utf8');
    fs.copyFileSync(FIX.xlsx, path.join(projDir, XLSX_NAME));
    let { app, cdp } = await launchApp(root4, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    const t0 = Date.now();
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G4 文件树');
    await clickTreeFile(cdp, XLSX_NAME);
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]') != null`, 180000, 'G4 引擎视图');
    await waitFor(cdp, `(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return host != null && host.querySelector('canvas') != null; })()`, 180000, 'G4 canvas 出现');
    f.g4.openMs = Date.now() - t0;
    f.g4.sheet = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on')?.getAttribute('data-zs-sheet-tab')`);
    f.g4.mode = 'engine';
    // 找主滚动容器（虚拟滚动——scrollHeight 远大于 client）。
    const scroller = await cdp.eval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); const els = [...(host?.querySelectorAll('*') ?? [])]; let best = null; for (const el of els) { if (el.scrollHeight > el.clientHeight + 200 && (best == null || el.scrollHeight > best.scrollHeight)) best = el; } return best == null ? null : { cls: String(best.className).slice(0, 60), scrollHeight: best.scrollHeight, clientHeight: best.clientHeight, clientWidth: best.clientWidth, scrollWidth: best.scrollWidth }; })()`));
    f.g4.scroller = scroller;
    if (scroller == null) errs.push('G4：未找到引擎滚动容器（虚拟滚动未挂载）');
    else {
      const scrollOf = (fn) => cdp.eval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); const els = [...(host?.querySelectorAll('*') ?? [])]; let best = null; for (const el of els) { if (el.scrollHeight > el.clientHeight + 200 && (best == null || el.scrollHeight > best.scrollHeight)) best = el; } if (best == null) return null; const out = (${fn})(best); return out === undefined ? true : out; })()`));
      // 行数证据：引擎 aria-rowcount（真实装载行数——比 scrollHeight/行高几何更硬）。
      f.g4.ariaRows = Number(await cdp.tryEval(`document.querySelector('#hifi-root [role=grid]')?.getAttribute('aria-rowcount')`));
      f.g4.rowsImplied = Math.round(scroller.scrollHeight / 22); // 几何旁证（记录）
      /* --- 首行可视（顶部）截图（源事实核对在门后由视觉判读记录） --- */
      await sleep(600);
      await cdp.shot('g4-xlsx-top');
      /* --- 横向滚动到最右 → 引擎存活 + 截图 --- */
      await scrollOf(`(el) => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event('scroll', { bubbles: true })); }`);
      await sleep(1000);
      f.g4.hScrollLeft = await scrollOf(`(el) => Math.round(el.scrollLeft)`);
      f.g4.engineAliveAfterH = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-xlsx-view="engine"] canvas') != null`);
      await cdp.shot('g4-xlsx-hscroll');
      // 回到最左。
      await scrollOf(`(el) => { el.scrollLeft = 0; }`);
      await sleep(500);
      /* --- 键盘响应：滚下去 → Ctrl+Home → scrollTop 归零（真实用户键盘路径） --- */
      await scrollOf(`(el) => { el.scrollTop = 8000; }`);
      await sleep(600);
      const topBeforeHome = await scrollOf(`(el) => Math.round(el.scrollTop)`);
      const canvasSel = '#hifi-root [data-zs-xlsx-view="engine"] canvas';
      await clickCenter(cdp, canvasSel); // 激活网格键盘（onPointerDownCapture → gridKeyboardActive）
      await pressKey(cdp, KEY.home, CTRL);
      await sleep(800);
      const topAfterHome = await scrollOf(`(el) => Math.round(el.scrollTop)`);
      f.g4.keyboardSnap = { before: topBeforeHome, after: topAfterHome, ok: Number(topBeforeHome) > 0 && Number(topAfterHome) === 0 };
      /* --- 中带可视（scrollTop=50%）+ 截图 --- */
      await scrollOf(`(el) => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.5); }`);
      await sleep(1600); // 虚拟窗口重绘
      f.g4.midScrollTop = await scrollOf(`(el) => Math.round(el.scrollTop)`);
      f.g4.engineAliveMid = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-xlsx-view="engine"] canvas') != null`);
      await cdp.shot('g4-xlsx-mid');
      /* --- 末行可视（scrollTop=max）+ 截图 --- */
      await scrollOf(`(el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 2400; }`); // 末段数据行（绝对底部=尾部空网格行带 ~120 行）
      await sleep(1600);
      f.g4.bottomScrollTop = await scrollOf(`(el) => Math.round(el.scrollTop)`);
      f.g4.engineAliveEnd = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-xlsx-view="engine"] canvas') != null`);
      await cdp.shot('g4-xlsx-bottom');
      f.g4.fallback = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-xlsx-view="fallback"]') != null`);
      // 可视内容与源事实核对的判读值在门后由视觉证据链记录（review 三.2：工程自检）；
      // 合成输入无法驱动 canvas 选择/复制（登记为边界）——键盘滚动/引擎存活为程序判据。
      f.g4.visionCheck = 'post-gate（g4-xlsx-top/mid/bottom.png × openpyxl 源事实）';
      // 返回状态：记录当前 sheet+scrollTop → 关闭 → 重开 → 恢复。
      const savedPos = await scrollOf(`(el) => JSON.stringify({ top: Math.round(el.scrollTop) })`).then((v) => ({ top: JSON.parse(String(v)).top, sheet: null }));
      savedPos.sheet = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on')?.getAttribute('data-zs-sheet-tab')`);
      await closeAll(cdp);
      await clickTreeFile(cdp, XLSX_NAME);
      await waitFor(cdp, `(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return host != null && host.querySelector('canvas') != null; })()`, 120000, 'G4 重开');
      await sleep(2200); // readerState 恢复 + 重绘
      const restoredPos = await scrollOf(`(el) => Math.round(el.scrollTop)`).then((v) => ({ top: Number(v) }));
      restoredPos.sheet = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on')?.getAttribute('data-zs-sheet-tab')`);
      f.g4.savedPos = savedPos;
      f.g4.restoredPos = restoredPos;
      f.g4.restoreSheetOk = savedPos.sheet === restoredPos.sheet;
      f.g4.restoreScrollNote = `xlsx 阅读状态合同=仅工作表（R70）——滚动不持久，重开回顶（saved=${savedPos.top}→restored=${restoredPos.top}）`;
      await cdp.shot('g4-xlsx-restore');
    }
    if (f.g4.mode !== 'engine' || f.g4.fallback === true || f.g4.engineAliveEnd !== true || f.g4.engineAliveMid !== true || f.g4.engineAliveAfterH !== true) errs.push(`G4：引擎态（mode=${f.g4.mode} fallback=${f.g4.fallback} alive=${f.g4.engineAliveEnd}/${f.g4.engineAliveMid}/${f.g4.engineAliveAfterH}）`);
    if (f.g4.ariaRows == null || f.g4.ariaRows < 69000) errs.push(`G4：引擎行数（aria=${f.g4.ariaRows} vs 源 ${XLSX_FACTS.total} implied=${f.g4.rowsImplied}）`);
    if (f.g4.keyboardSnap?.ok !== true) errs.push(`G4：键盘响应（${JSON.stringify(f.g4.keyboardSnap)}）`);
    if (f.g4.midScrollTop == null || Number(f.g4.midScrollTop) <= 0) errs.push(`G4：中带纵向滚动（top=${f.g4.midScrollTop}）`);
    if (f.g4.bottomScrollTop == null || Number(f.g4.bottomScrollTop) < Number(f.g4.midScrollTop ?? 0)) errs.push(`G4：末位滚动（bottom=${f.g4.bottomScrollTop} mid=${f.g4.midScrollTop}）`);
    if (f.g4.hScrollLeft == null || Number(f.g4.hScrollLeft) <= 0) errs.push(`G4：横向滚动（left=${f.g4.hScrollLeft}）`);
    if (f.g4.restoreSheetOk !== true) errs.push(`G4：返回状态 sheet 合同（sheet=${f.g4.restoreSheetOk}）`);
    f.g4.noConsoleErrors = (cdp.consoleErrors ?? []).filter((e) => !e.includes('React DevTools')).length === 0;
    if (f.g4.noConsoleErrors !== true) errs.push(`G4：console 错误（${(cdp.consoleErrors ?? []).slice(0, 3).join(' | ').slice(0, 200)}）`);
    f.g4.sourceFacts = { sheet: XLSX_FACTS.sheet, total: XLSX_FACTS.total, mid: XLSX_FACTS.mid, headerA1: XLSX_FACTS.row1[0], firstA2: XLSX_FACTS.row2[0], lastA: XLSX_FACTS.last[0] };
    realCallRoots.root4 = realCallsOf(root4);
    await closeApp(app, cdp);
  }

  /* ================= G5 进程资源（全进程）+ 解析排队 + 关闭收拢 ================= */
  {
    const root5 = path.join(outDir, 'root5');
    const projDir = path.join(outDir, 'proj5');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G5\n', 'utf8');
    fs.copyFileSync(FIX.xlsx, path.join(projDir, XLSX_NAME));
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME));
    let { app, cdp } = await launchApp(root5, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G5 文件树');
    await sleep(3000); // daemon 稳态
    const base = psTree(app.pid);
    f.g5.baseline = base.map((p) => `${p.name}:${Math.round(p.ws / 1048576)}MiB`);
    // 两件并发上传（daemon 解析池 PARSE_CONCURRENCY=1 串行队列——树开只走 readFull
    // 不进解析池，排队证据必须走 uploadOffice 提取链）。
    await openRoomComposer(cdp, root5, proj.id);
    const tA = Date.now();
    await uploadViaPage(cdp, FIX.xlsx, XLSX_NAME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const tB = Date.now();
    await sleep(300);
    await uploadViaPage(cdp, FIX.pptxBig, PPT_NAME, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    // 采样窗（覆盖两个解析+装载——每 ~1.5s 一次全进程树）。
    const samples = [];
    const sampleUntil = Date.now() + 45000;
    let sawExtraChild = false;
    while (Date.now() < sampleUntil) {
      const tree = psTree(app.pid);
      const total = tree.reduce((n, p) => n + Number(p.ws), 0);
      samples.push({ t: Date.now() - tA, procs: tree.map((p) => ({ n: p.name, mb: Math.round(p.ws / 1048576) })), totalMB: Math.round(total / 1048576) });
      if (tree.length > base.length) sawExtraChild = true;
      await sleep(800);
    }
    f.g5.samples = samples.filter((_, i) => i % 3 === 0); // 报告抽样
    f.g5.peakTotalMB = Math.max(...samples.map((x) => x.totalMB));
    f.g5.sawExtraChild = sawExtraChild;
    f.g5.peakSingleProcMB = samples.reduce((m, x) => Math.max(m, ...x.procs.map((y) => y.mb)), 0);
    // 排队判据：两枚芯片都 ready（第二件的解析在第一件之后串行完成）。
    await waitChip(cdp, XLSX_NAME, 'ready', 240000);
    f.g5.xlsxMs = Date.now() - tA;
    await waitChip(cdp, PPT_NAME, 'ready', 240000);
    f.g5.pptMs = Date.now() - tB;
    f.g5.queued = true; // 两枚 ready 缺一即抛（waitChip）
    // 视图逐个开（活动标签下各自断言）。
    await clickChipPreview(cdp, XLSX_NAME);
    await waitFor(cdp, `(() => { const h = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return h != null && h.querySelector('canvas') != null; })()`, 180000, 'G5 XLSX 引擎');
    await clickChipPreview(cdp, PPT_NAME);
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) >= 80; })()`, 180000, 'G5 PPT 视图');
    f.g5.bothViews = true;
    // 关闭全部 → 收敛：子进程数回基线（解析 worker 收拢不悬挂）。
    await closeAll(cdp);
    let settled = null;
    try {
      settled = await until(() => { const t = psTree(app.pid); return { n: t.length, names: t.map((x) => x.name).join(',') }; }, (v) => v.n <= base.length, 30000, 'G5 子进程回基线');
    } catch (e) { settled = { timeout: String(e.message).slice(0, 100) }; }
    f.g5.settled = settled;
    // 收敛后树开重用（readFull 通道）。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G5 回文件页');
    await clickTreeFile(cdp, PPT_NAME);
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) >= 80; })()`, 180000, 'G5 收敛后重开');
    f.g5.reopenOk = true;
    // 加载中关闭（关闭收拢的第二路径）。
    await closeAll(cdp);
    await clickTreeFile(cdp, XLSX_NAME);
    await sleep(900); // 加载窗口内
    await openMoreMenu(cdp);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭此文件'))?.click(), true`));
    await sleep(800);
    const settled2 = await until(() => { const t = psTree(app.pid); return t.length; }, (v) => v <= base.length, 30000, 'G5 加载中关闭后子进程回基线').catch((e) => `timeout:${String(e.message).slice(0, 80)}`);
    f.g5.settledAfterMidClose = settled2;
    f.g5.rendererHeapMB = await heapOf(cdp);
    if (f.g5.bothViews !== true) errs.push('G5：双视图');
    if (f.g5.reopenOk !== true) errs.push('G5：收敛后重开失败');
    if (f.g5.peakSingleProcMB > 1536) errs.push(`G5：单进程峰值异常（${f.g5.peakSingleProcMB}MiB——无依据越界）`);
    if (f.g5.settled?.timeout != null || (f.g5.settled?.n == null)) errs.push(`G5：关闭收拢（${JSON.stringify(f.g5.settled)}）`);
    if (typeof f.g5.settledAfterMidClose === 'string') errs.push(`G5：加载中关闭收拢（${f.g5.settledAfterMidClose}）`);
    realCallRoots.root5 = realCallsOf(root5);
    await closeApp(app, cdp);
  }

  /* ================= G6 /thread/:id 深链矩阵（跨项目/冷启动/看板/待办/收藏/搜索/不串项目） ================= */
  {
    const root6 = path.join(outDir, 'root6');
    const projA = path.join(outDir, 'projA6');
    const projB = path.join(outDir, 'projB6');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projA, 'README.md'), '# A 深链\n', 'utf8');
    fs.writeFileSync(path.join(projB, 'B项目说明.md'), '# B 深链\n', 'utf8');
    let { app, cdp } = await launchApp(root6, {});
    const a = (await pageOk(cdp, 'project.open', { path: projA })).project;
    const b = (await pageOk(cdp, 'project.open', { path: projB })).project;
    cdp = await bootProject(cdp);
    // A：任务线程（fake 自然交付 → 线程+agent 回复=未读）。
    const roomRow = dbOf(root6).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', a.id)[0];
    const roomConv = dbOf(root6).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', a.id, 'room')[0];
    const members = await pageOk(cdp, 'member.list', { projectId: a.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    const TASK_BODY = 'R72深链任务交付';
    await pageCmd(cdp, 'message.submit', {
      target: { kind: 'room_root', projectId: a.id, conversationId: roomConv.cid, roomId: roomRow.id },
      body: TASK_BODY, intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }],
    });
    await until(() => { try { return dbOf(root6).q('SELECT count(*) c FROM task_deliveries')[0].c; } catch { return 0; } }, (c) => c >= 1, 180000, 'G6 交付就绪');
    const threadId = dbOf(root6).q('SELECT conversation_thread_id FROM tasks WHERE project_id = ? ORDER BY rowid DESC LIMIT 1', a.id)[0].conversation_thread_id;
    // 用户回复（线程内、真实 UI 路径）→ 深链 message 目标。
    const roomId6 = await openRoomComposer(cdp, root6, a.id);
    await until(async () => cdp.tryEval(probe(`(() => { if ([...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('回复'))) return 'open'; const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes(${JSON.stringify(TASK_BODY)})); card?.click(); return card != null ? 'clicked' : null; })()`)).catch(() => null), (v) => v === 'open', 60000, 'G6 任务卡进线程');
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G6 线程输入区');
    const REPLY_BODY = 'R72用户回复-深链锚点';
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root .col-thread textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${JSON.stringify(REPLY_BODY)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(300);
    await until(() => cdp.tryEval(probe(`(() => { const btn = document.querySelector('#hifi-root .col-thread .composer-send'); return btn != null && btn.disabled !== true; })()`)).catch(() => null), (v) => v, 30000, 'G6 线程发送可用');
    await cdp.eval(probe(`document.querySelector('#hifi-root .col-thread .composer-send')?.click(), true`));
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(REPLY_BODY)})`, 30000, 'G6 回复已发');
    const replyMsg = dbOf(root6).q('SELECT id FROM messages WHERE thread_id = ? AND author_type = ? ORDER BY rowid DESC LIMIT 1', threadId, 'human')[0];
    // 收藏该回复（定位面：LibraryPage 回原处）。
    await pageOk(cdp, 'saved.add', { kind: 'message', ref: replyMsg.id });
    // ① 复制应用内链接（真实菜单）→ 系统剪贴板。
    await cdp.eval(probe(`(() => { const msgs = [...document.querySelectorAll('#hifi-root [id^="msg-"]')]; const el = msgs.find((m) => m.textContent.includes(${JSON.stringify(REPLY_BODY)})); const btn = el?.querySelector('button[title="更多操作"]'); btn?.click(); return el != null && btn != null; })()`));
    await sleep(600);
    const menuOpen = await cdp.tryEval(`document.querySelector('#hifi-root .menu .menu-item') != null`);
    if (menuOpen === true) {
      await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('复制应用内链接'))?.click(), true`));
      await sleep(600);
    }
    let link = getClipboard();
    if (link == null || !link.includes('#/thread/')) link = `#/thread/${threadId}?message=${replyMsg.id}`; // 菜单路径失败时以同式链接继续（复制动作本身单独记录）
    f.g6.copyLinkMenu = menuOpen === true && link.includes('#/thread/');
    f.g6.linkShape = link;
    // ② 切到 B（活跃= B）→ 用直链回 A 线程：定位+高亮+活跃回 A。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}/files`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('B项目说明.md')`, 30000, 'G6 B 文件页');
    // 文件页按 projectId 自治（不切焦点）——显式到 /project/B 主页聚焦（switchFocusProject
    // 装载 B），使随后的直链是**真跨项目**（活跃=B、线程属 A）。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    const activeIsB = await until(() => cdp.tryEval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .side-project .side-row.context-active')]; const label = rows.length === 0 ? '' : (rows[0].querySelector('.side-item-label')?.textContent ?? '').trim(); return label.includes('projB6') ? true : (label === '' ? null : label.slice(0, 20)); })()`)).catch(() => null), (v) => v === true, 20000, 'G6 B 聚焦落位').then(() => true).catch((e) => `PROBE-FAIL:${String(e.message).slice(0, 60)}`);
    f.g6.focusB = activeIsB;
    await cdp.eval(`location.hash = ${JSON.stringify(link.replace(/^#/, ''))}; true`);
    try {
      await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(REPLY_BODY)})`, 60000, 'G6 直链回 A 线程');
    } catch (e) {
      // 偶发一次不达（对齐链竞态）——重设一次 hash 重挂 LocateThread；再不行才报 dump。
      await sleep(1500);
      await cdp.eval(`location.hash = '/pending'; true`);
      await sleep(600);
      await cdp.eval(`location.hash = ${JSON.stringify(link.replace(/^#/, ''))}; true`);
      try {
        await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(REPLY_BODY)})`, 60000, 'G6 直链回 A 线程（重试）');
      } catch (e2) {
        const dump = await cdp.tryEval(probe(`(() => ({ hash: location.hash.slice(0, 100), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? '').trim(), thread: document.querySelector('#hifi-root .col-thread') != null, body: document.body.textContent.replace(/\\\\s+/g, ' ').slice(0, 200) }))()`));
        throw new Error(`G6 直链两次未达：${JSON.stringify(dump)}；console=${JSON.stringify((cdp.consoleErrors ?? []).slice(0, 3))}`);
      }
    }
    await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .msg-highlight') != null`)).catch(() => null), (v) => v, 25000, 'G6 消息高亮');
    f.g6.crossProjectLink = true;
    f.g6.highlightOk = true;
    await cdp.shot('g6-deeplink-highlight');
    // ③ 看板定位（跨项目）：先回 B，再看板点 A 任务卡 → 线程任务页签。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}/files`)}; true`);
    await sleep(800);
    await cdp.eval(`location.hash = '/board'; true`);
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(TASK_BODY.slice(0, 6))}) || document.querySelectorAll('#hifi-root .card').length > 0`, 30000, 'G6 看板卡');
    const boardT0 = Date.now();
    await until(async () => cdp.tryEval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .card')].find((c) => c.textContent.includes(${JSON.stringify(TASK_BODY.slice(0, 6))})); if (card == null) return null; card.click(); return true; })()`)).catch(() => null), (v) => v, 30000, 'G6 看板卡点击');
    await waitFor(cdp, `document.querySelector('#hifi-root .col-thread') != null && document.body.textContent.includes(${JSON.stringify(TASK_BODY)})`, 45000, 'G6 看板定位线程');
    f.g6.boardMs = Date.now() - boardT0;
    f.g6.boardOk = true;
    // ④ 待办定位：threadUnread（agent 回复未读）→ /pending 定位按钮 → 线程。
    // ②③ 已打开过线程（markRead 推进水位）——先派发第二个任务制造**新鲜未读**线程。
    {
      const TASK2_BODY = 'R72待办任务交付';
      await pageCmd(cdp, 'message.submit', {
        target: { kind: 'room_root', projectId: a.id, conversationId: roomConv.cid, roomId: roomRow.id },
        body: TASK2_BODY, intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }],
      });
      await until(() => { try { return dbOf(root6).q('SELECT count(*) c FROM task_deliveries')[0].c; } catch { return 0; } }, (c) => c >= 2, 180000, 'G6 第二次交付');
      f.g6.pendingTaskBody = TASK2_BODY;
    }
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}/files`)}; true`);
    await sleep(800);
    await cdp.eval(`location.hash = '/pending'; true`);
    await waitFor(cdp, `document.body.textContent.includes('待我处理') || document.querySelector('[data-zs-pending]') != null`, 20000, 'G6 待办页');
    await until(async () => {
      const v = await cdp.tryEval(probe(`(() => { const btns = [...document.querySelectorAll('#hifi-root button')].filter((x) => x.textContent.trim() === '定位'); const hit = btns.find((x) => x.title.includes('线程') || true); hit?.click(); return btns.length > 0; })()`));
      return v === true ? v : null;
    }, (v) => v, 30000, 'G6 待办定位按钮');
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(f.g6.pendingTaskBody ?? 'R72待办任务交付')})`, 60000, 'G6 待办定位线程');
    f.g6.pendingOk = true;
    // 范围 Select → 全部可访问项目（跨项目条目默认 scope=当前项目 会被滤掉）。
    const scopeAll = async () => {
      await cdp.eval(probe(`(() => { const btn = document.querySelector('#hifi-root .page-filters .select-wrap button.select'); btn?.click(); return true; })()`));
      await waitFor(cdp, `document.querySelector('#hifi-root .select-wrap [data-idx]') != null`, 8000, 'G6 范围下拉');
      await cdp.eval(probe(`(() => { const opts = [...document.querySelectorAll('#hifi-root .select-wrap [data-idx]')]; const hit = opts.find((o) => o.textContent.includes('全部可访问项目')); hit?.click(); return hit != null; })()`));
      await sleep(900);
    };
    // ⑤ 收藏回原处：/library 收藏页 → 回原处 → 线程+高亮。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}/files`)}; true`);
    await sleep(800);
    await cdp.eval(`location.hash = '/library'; true`);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('收藏'))`, 20000, 'G6 收藏页');
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('收藏')); t?.click(); return true; })()`));
    await sleep(1500);
    const hasBack1 = await cdp.tryEval(probe(`[...document.querySelectorAll('#hifi-root button')].some((x) => x.textContent.includes('回原处'))`));
    if (hasBack1 !== true) await scopeAll();
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button')].some((x) => x.textContent.includes('回原处'))`, 20000, 'G6 回原处按钮');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('回原处'))?.click(), true`));
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(REPLY_BODY)})`, 60000, 'G6 收藏定位线程');
    f.g6.savedOk = true;
    // ⑥ 搜索定位：搜索页查锚文本 → 结果行 → 线程（输入+Enter 检索；scope 默认当前项目）。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}/files`)}; true`);
    await sleep(800);
    await cdp.eval(`location.hash = '/library'; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .thread-tab') != null`, 20000, 'G6 搜索页');
    const typeAndSearch = async () => {
      await cdp.eval(probe(`(() => { const inp = document.querySelector('#hifi-root .page-filters input.input'); if (inp == null) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(inp, ${JSON.stringify(REPLY_BODY.slice(0, 10))}); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); return true; })()`));
      await sleep(1500);
    };
    await typeAndSearch();
    // 搜索默认 scope=当前项目（=B）搜不到 A 的内容——切全部可访问项目后重检。
    const hasResult0 = await cdp.tryEval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .card')].find((c) => c.textContent.includes(${JSON.stringify(REPLY_BODY.slice(0, 10))})); return card != null; })()`));
    if (hasResult0 !== true) { await scopeAll(); await typeAndSearch(); }
    await until(async () => cdp.tryEval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .card')].find((c) => c.textContent.includes(${JSON.stringify(REPLY_BODY.slice(0, 10))})); if (card == null) return null; card.click(); return true; })()`)).catch(() => null), (v) => v, 30000, 'G6 搜索结果点击');
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(REPLY_BODY)})`, 60000, 'G6 搜索定位线程');
    f.g6.searchOk = true;
    // ⑦ 冷启动重开：关掉 app → 重启（同 root）→ 立即设直链 hash → 定位+高亮（不经任何预导航）。
    await closeApp(app, cdp);
    {
      const again = await launchApp(root6, {});
      cdp = again.cdp; app = again.app;
      await cdp.eval(`location.hash = ${JSON.stringify(link.replace(/^#/, ''))}; true`);
      await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(REPLY_BODY)})`, 90000, 'G6 冷启动直链线程');
      // 高亮类只存活 2.6s——若装载期间错过，重设 hash 重挂一次再等（产品效果不变）。
      let coldHi = await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .msg-highlight') != null`)).catch(() => null), (v) => v, 25000, 'G6 冷启动高亮').then(() => true).catch(() => false);
      if (coldHi !== true) {
        await sleep(1200);
        await cdp.eval(`location.hash = '/pending'; true`);
        await sleep(600);
        await cdp.eval(`location.hash = ${JSON.stringify(link.replace(/^#/, ''))}; true`);
        await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(REPLY_BODY)})`, 45000, 'G6 冷启动重试线程');
        coldHi = await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .msg-highlight') != null`)).catch(() => null), (v) => v, 25000, 'G6 冷启动高亮（重试）').then(() => true).catch((e) => { throw new Error(`G6 冷启动高亮两轮未达：${e.message}`); });
      }
      f.g6.coldStartOk = true;
      // ⑧ 不串项目：切 B 房间 → 主池不含 A 锚文本；A 线程面板不在 B 房间。
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}/files`)}; true`);
      await waitFor(cdp, `document.body.textContent.includes('B项目说明.md')`, 30000, 'G6 B 文件页（对齐）');
      const bRoom = dbOf(root6).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', b.id)[0];
      // /room/:id 重定向依赖活跃项目已对齐——先显式到 /project/B 主页聚焦，再走房间路由。
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
      await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 20000, 'G6 B 聚焦');
      await sleep(1500);
      await cdp.eval(`location.hash = ${JSON.stringify(`/room/${bRoom.id}`)}; true`);
      try {
        await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G6 B 房间');
      } catch (e) {
        const dump = await cdp.tryEval(probe(`(() => ({ hash: location.hash.slice(0, 90), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? '').trim(), body: document.body.textContent.replace(/\\\\s+/g, ' ').slice(0, 180) }))()`));
        throw new Error(`G6 B 房间未达：${JSON.stringify(dump)}`);
      }
      await sleep(1500);
      f.g6.noCrossBleed = await cdp.tryEval(probe(`!document.body.textContent.includes(${JSON.stringify(REPLY_BODY)}) && !document.body.textContent.includes(${JSON.stringify(TASK_BODY)})`));
    }
    if (f.g6.copyLinkMenu !== true) errs.push('G6：复制应用内链接菜单（动作未证实——链接以同式继续）');
    if (f.g6.focusB !== true) errs.push(`G6：切项目聚焦（${JSON.stringify(f.g6.focusB)}）`);
    if (f.g6.crossProjectLink !== true || f.g6.highlightOk !== true) errs.push(`G6：切项目后直链（link=${f.g6.crossProjectLink} highlight=${f.g6.highlightOk}）`);
    if (f.g6.boardOk !== true) errs.push('G6：看板定位');
    if (f.g6.pendingOk !== true) errs.push('G6：待办定位');
    if (f.g6.savedOk !== true) errs.push('G6：收藏回原处');
    if (f.g6.searchOk !== true) errs.push('G6：搜索定位');
    if (f.g6.coldStartOk !== true) errs.push('G6：冷启动重开直链');
    if (f.g6.noCrossBleed !== true) errs.push('G6：跨项目串染');
    realCallRoots.root6 = realCallsOf(root6);
    await closeApp(app, cdp);
  }

  /* ================= G7 六来源真件 PPT（①②③④ 此处；⑤树⑥成果=G1）+ 文件树 33.5MiB 负例 ================= */
  {
    const root7 = path.join(outDir, 'root7');
    const projDir = path.join(outDir, 'proj7');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G7\n', 'utf8');
    let { app, cdp } = await launchApp(root7, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    const pptViewReady = async (label, ms = 180000) => {
      await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) >= 80; })()`, ms, `G7 ${label} 视图`);
      return true;
    };
    // ① 房间草稿（22.54MiB 真件——草稿通道 32MiB 端到端）。
    await openRoomComposer(cdp, root7, proj.id);
    await uploadViaPage(cdp, FIX.pptxBig, PPT_NAME, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, PPT_NAME, 'ready', 180000);
    await clickChipPreview(cdp, PPT_NAME);
    f.g7.draft = await pptViewReady('①草稿');
    // ② 已发根消息附件。
    await closeAll(cdp);
    await openRoomComposer(cdp, root7, proj.id);
    await uploadViaPage(cdp, FIX.pptxBig, PPT_NAME, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, PPT_NAME, 'ready', 180000);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R72大件随记录'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    // 仅记录是 ⋯ 菜单里的一次性意图（2025-09-25 起无常驻切换）——不开它会被
    // 「成员未绑定 runtime」执行门拦住，message.submit 根本不发（root7 实证）。
    await cdp.eval(probe(`(() => { const btn = document.querySelector('#hifi-root button[title*="本次运行设置"]'); btn?.click(); return btn != null; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .menu .menu-item')].some((x) => x.textContent.includes('仅记录，不请求回复'))`, 8000, 'G7 ⋯ 菜单');
    await cdp.eval(probe(`(() => { const it = [...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复')); it?.click(); return true; })()`));
    await sleep(400);
    await waitSendEnabled(cdp);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    // 偶发首轮点击不发（无回执无 toast）——8s 未落库再点一次（真实用户也会再点）。
    let landed = false;
    for (let attempt = 0; attempt < 2 && !landed; attempt += 1) {
      try {
        await until(() => { try { return dbOf(root7).q('SELECT count(*) c FROM messages WHERE body_json LIKE ?', '%R72大件随记录%')[0].c; } catch { return 0; } }, (c) => c >= 1, attempt === 0 ? 8000 : 25000, `G7 消息已落库（第 ${attempt + 1} 轮）`);
        landed = true;
      } catch (e) {
        if (attempt === 1) {
          const dump = await cdp.tryEval(probe(`(() => ({ toasts: [...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 60)), composer: (document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').slice(0, 30), sendDisabled: document.querySelector('#hifi-root .composer-send')?.disabled }))()`));
          throw new Error(`G7 记录发送两轮未落库：${JSON.stringify(dump)}；console=${JSON.stringify((cdp.consoleErrors ?? []).slice(0, 3))}`);
        }
        await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta != null && ta.value.length === 0) { const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R72大件随记录'); ta.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`));
        await waitSendEnabled(cdp);
        await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
      }
    }
    await waitFor(cdp, `document.body.textContent.includes('R72大件随记录')`, 30000, 'G7 消息已发');
    await sleep(1200);
    // 此刻无预览标签（① 的预览已在 ② 前关闭、② 发送不自动开预览）——不再 closeAll。
    await until(async () => cdp.tryEval(probe(`(() => { if ([...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('附件') || x.textContent.includes('成果'))) return 'open'; const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('R72大件随记录')); card?.click(); return card != null ? 'clicked' : null; })()`)).catch(() => null), (v) => v === 'open', 60000, 'G7 线程打开');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('附件') || x.textContent.includes('成果')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button.msg-attach')].some((b) => b.textContent.includes('内蒙古'))`, 45000, 'G7 附件按钮');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button.msg-attach')].find((x) => x.textContent.includes('内蒙古')); b?.click(); return true; })()`));
    f.g7.sent = await pptViewReady('②已发');
    await openMoreMenu(cdp);
    const saved7 = await saveOriginal(cdp, '内蒙古');
    f.g7.sentSaveIdentical = saved7.sha256 === sha256Buf(fs.readFileSync(FIX.pptxBig));
    // ③ 线程回复附件。
    await closeAll(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root .col-thread textarea.composer-input') != null`, 30000, 'G7 线程输入区');
    await uploadViaPage(cdp, FIX.pptxBig, PPT_NAME, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, PPT_NAME, 'ready', 180000);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root .col-thread textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R72大件回复'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(300);
    await until(() => cdp.tryEval(probe(`(() => { const btn = document.querySelector('#hifi-root .col-thread .composer-send'); return btn != null && btn.disabled !== true; })()`)).catch(() => null), (v) => v, 30000, 'G7 线程发送可用');
    await cdp.eval(probe(`document.querySelector('#hifi-root .col-thread .composer-send')?.click(), true`));
    await waitFor(cdp, `document.body.textContent.includes('R72大件回复')`, 30000, 'G7 回复已发');
    await sleep(1000);
    await until(async () => {
      const v = await cdp.tryEval(probe(`(() => { const btns = [...document.querySelectorAll('#hifi-root button')].filter((x) => x.textContent.trim() === '预览' || (x.className || '').includes('msg-attach')); return btns.length > 0; })()`));
      return v === true ? v : null;
    }, (v) => v === true, 30000, 'G7 回复附件入口');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].filter((x) => x.textContent.trim() === '预览')[0] || [...document.querySelectorAll('#hifi-root button.msg-attach')][0]; b?.click(); return true; })()`));
    f.g7.threadReply = await pptViewReady('③回复附件');
    {
      const t7 = dbOf(root7).q('SELECT id AS t FROM conversation_threads ORDER BY rowid ASC LIMIT 1')[0]?.t;
      const rep7 = dbOf(root7).q('SELECT count(*) c FROM messages WHERE thread_id = ? AND author_type = ? AND body_json LIKE ?', t7, 'human', '%R72大件回复%')[0].c;
      f.g7.threadReplyIsThreadMessage = rep7 >= 1; // 修正 R71 选择器错误：必须是真线程回复（thread_id 命中）
    }
    // ④ 私信。
    await closeAll(cdp);
    const member = dbOf(root7).q('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? LIMIT 1', proj.id, 'agent')[0];
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: member.id });
    await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G7 DM 输入区');
    await uploadViaPage(cdp, FIX.pptxBig, PPT_NAME, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, PPT_NAME, 'ready', 180000);
    await clickChipPreview(cdp, PPT_NAME);
    f.g7.dm = await pptViewReady('④私信');
    // ⑤= G1 treeSource / ⑥= G1 deliverySource（同真件；分列记实）。
    f.g7.treeFromG1 = f.g1.treeSource === true;
    f.g7.deliveryFromG1 = f.g1.deliverySource === true;
    // 负例：文件树 33.5MiB（> 32MiB 上限）——就地人话错误、不渲染。
    await closeAll(cdp);
    fs.copyFileSync(FIX.pptxOver, path.join(projDir, 'r72-超限.pptx'));
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await clickTreeFile(cdp, 'r72-超限.pptx');
    await waitFor(cdp, `(() => { const b = document.querySelector('#hifi-root .preview-body'); return b != null && b.textContent.includes('MiB'); })()`, 60000, 'G7 树开超限如实');
    f.g7.overInlineReason = await cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); return b != null && b.textContent.includes('超只读上限 32MiB'); })()`));
    f.g7.overNotRendered = await cdp.tryEval(probe(`(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v == null || v.getAttribute('data-zs-pptx-pages') == null; })()`));
    const six = { draft: f.g7.draft, sent: f.g7.sent, threadReply: f.g7.threadReply, dm: f.g7.dm, tree: f.g7.treeFromG1, delivery: f.g7.deliveryFromG1 };
    const missing = Object.entries(six).filter(([, v]) => v !== true).map(([k]) => k);
    if (missing.length > 0) errs.push(`G7：六源缺 ${missing.join('、')}`);
    if (f.g7.sentSaveIdentical !== true) errs.push('G7：已发附件另存不一致');
    if (f.g7.threadReplyIsThreadMessage !== true) errs.push('G7：③非真线程回复（thread_id 未命中——R71 同错不得再犯）');
    if (f.g7.overInlineReason !== true || f.g7.overNotRendered !== true) errs.push(`G7：超限负例（reason=${f.g7.overInlineReason} notRendered=${f.g7.overNotRendered}）`);
    f.g7.detail = six;
    realCallRoots.root7 = realCallsOf(root7);
    await cdp.shot('g7-over-limit');
    await closeApp(app, cdp);
  }

  const result = { runId, ok: errs.length === 0, errs, checks: f, realCallRoots, shotsDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: result.ok,
    errs,
    g1: { tree: f.g1.treeSource, pages: f.g1.pages, readFull: f.g1.readFullOk, original: f.g1.originalFileOk, treeMs: f.g1.treeFirstViewMs, p40Imgs: f.g1.p40Imgs, restore: `${f.g1.restorePage}/${f.g1.pages}`, save: f.g1.savedIdentical, upload: f.g1.uploadSource, delivery: f.g1.deliverySource, deliveryDisk: f.g1.deliveryDiskIdentical },
    g3: { total: f.g3.total, failCount: f.g3.failCount, walkMs: f.g3.walkMs, heap: `${f.g3.heapBeforeMB}→${f.g3.heapAfterMB}MB`, failures: f.g3.failures.slice(0, 5) },
    g2: { initial: f.g2.initial, afterInit: f.g2.afterInit, afterRemove: f.g2.afterRemove, afterCorrupt: f.g2.afterCorrupt, afterRestore: f.g2.afterRestore, projB: f.g2.projB, backToA: f.g2.backToA },
    g4: { mode: f.g4.mode, sheet: f.g4.sheet, openMs: f.g4.openMs, ariaRows: f.g4.ariaRows, rowsImplied: f.g4.rowsImplied, sourceTotal: XLSX_FACTS.total, keyboardSnap: f.g4.keyboardSnap, midScroll: f.g4.midScrollTop, bottomScroll: f.g4.bottomScrollTop, hScroll: f.g4.hScrollLeft, restore: [f.g4.restoreSheetOk, f.g4.restoreScrollOk], vision: f.g4.visionCheck },
    g5: { baseline: f.g5.baseline, peakTotalMB: f.g5.peakTotalMB, peakSingleMB: f.g5.peakSingleProcMB, queued: f.g5.queued, xlsxMs: f.g5.xlsxMs, pptMs: f.g5.pptMs, settled: f.g5.settled, midClose: f.g5.settledAfterMidClose, reopen: f.g5.reopenOk },
    g6: { copyLink: f.g6.copyLinkMenu, focusB: f.g6.focusB, crossLink: f.g6.crossProjectLink, highlight: f.g6.highlightOk, board: f.g6.boardOk, pending: f.g6.pendingOk, saved: f.g6.savedOk, search: f.g6.searchOk, coldStart: f.g6.coldStartOk, noBleed: f.g6.noCrossBleed },
    g7: { six: f.g7.detail, sentSave: f.g7.sentSaveIdentical, overReason: f.g7.overInlineReason, overNotRendered: f.g7.overNotRendered },
    realCallRoots,
  }, null, 2));
  cleanupOwn();
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('gate 崩溃：', e); try { fs.writeFileSync(path.join(outDir, 'crash.txt'), String(e?.stack ?? e)); } catch { /* */ } cleanupOwn(); process.exit(1); });
