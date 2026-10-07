'use strict';
/**
 * R68 交互门（review-r67 §7 必过矩阵）：零真实模型调用；全部自有夹具/数据根/profile。
 *  G1 同号重试真门：真实点击「重发原内容」（按按钮**正文**定位——R67 反例：按 title 找不到
 *     仍算通过）；ZS_COMMAND_LOG_FILE 记录实际送达管道信封——证明第二次命令确实发出、
 *     commandId/params 与原信封逐字一致；回执成功后本条 pending/账本清理、横幅消失、业务
 *     恰一次；等待期新正文保留。负对照：未点击时「已发出」判定必须为假（门有牙）。
 *  G2 真实旧版继承端到端（冻结候选生成旧态→当前候选首启）：
 *     a) 冻结 v4 包（真启动链）在自己根上产生真 v1 快照（未知信封+草稿；无 marker——
 *        v3/v4 从未生成过 root-identity）→ 复制整个数据根（含 profile）到副本 →
 *        当前构建在**副本**首启：候选可见于「设置→数据与存储→旧数据目录继承」→ 用户确认
 *        导入 → 横幅+原 commandId 完整恢复 → 同号重试恰一次。
 *     b) 当前构建在**原根**（同目录升级）：v1 键自动继承（目录即同一物理根，构造性可信）。
 *     c) 冻结 v3 包（同款真链）产生 v1 草稿/未知信封 → 当前构建同目录首启自动继承。
 *     d) 新格式未来移动（R67 通道回归）：当前构建产生 v2 快照 → 整根复制 → 新目录自动继承。
 *     e) 负例：未来版本（v999）旧键不被消费（无恢复/无横幅/原件保持）；坏身份标记不覆写
 *        （原件逐字保持+界面健康说明）。
 *  G3 成员边界：AddMemberModal 打开后标题栏切项目 → 表单作废（不写 B）；同名成员可辨认
 *     （卡片/名单/@/配置带 #短标识）；归档项目入口禁用+服务端拒绝。
 *  G4 第三来源交付文档：FakeWorker 自然交付 → 成果页「打开文档」→ 阅读（TaskComplete 字段
 *     结构）/源码（JSON）/另存（字节=文档）/引用（版本+manifest 绑定入草稿）。
 *  G5 空文件另存 + 磁盘变更重载链：0B 工作区文件可读可另存（0 字节落盘）；磁盘更新 →
 *     保存被拦（不静默另存新字节）→ 重新加载 → 新快照可存。
 *  G6 自绘 Select：原生 select 全部替换（.select-wrap）；点击展开（.select-pop+role=listbox）
 *     可截图；键盘 ↑↓+Enter 选择生效。
 */
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const runId = `r68-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r68-${runId}`);
const PORT = 9668;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(250);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.consoleErrors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.consoleErrors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 200)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
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
const dbOf = (root) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(root, 'state.sqlite')); return { q: (sql, ...a) => db.prepare(sql).all(...a), run: (sql, ...a) => db.prepare(sql).run(...a), close: () => db.close() }; };
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');
let __appOut = { v: '' };

const saveAsDir = path.join(outDir, 'saved');
const cmdLogPath = path.join(outDir, 'cmdlog.ndjson');
function readCmdLog() {
  try { return fs.readFileSync(cmdLogPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return []; }
}
const submitsOf = () => readCmdLog().filter((e) => e.method === 'message.submit');

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
/** 冻结旧候选（v3/v4 便携包）真启动链：直接 spawn electron.exe（绕过 start-desktop.bat 的
 * ZS_* 清洗），数据根/管道名/丢回执钩由本探针注入——其余（ZS_PACKED_ENTRY/受管运行时）由
 * 打包 main 自设（实测强制 ZS_MANAGED_RUNTIME=0 会使守护进程启动异常——不干预）。 */
async function launchPackaged(pkgDir, dataRoot, extraEnv = {}) {
  const pipeTag = `zs-r68-${randomBytes(6).toString('hex')}`;
  fs.mkdirSync(dataRoot, { recursive: true });
  if (!fs.existsSync(path.join(dataRoot, 'pipe-name.txt'))) fs.writeFileSync(path.join(dataRoot, 'pipe-name.txt'), pipeTag, 'utf8');
  const app = spawn(path.join(pkgDir, 'ZhongshuoDual', 'electron.exe'), [`--remote-debugging-port=${PORT}`], {
    cwd: pkgDir,
    env: {
      ...process.env,
      ZS_APP_DATA: dataRoot, ZS_PIPE_NAME: `\\\\.\\pipe\\${pipeTag}`,
      ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  own.add(app);
  app.once('exit', () => own.delete(app));
  app.stdout.on('data', (c) => { __appOut.v += c; });
  app.stderr.on('data', (c) => { __appOut.v += c; });
  const cdp = await connectPage('冻结候选启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, '冻结候选 hifi 挂载');
  // 守护进程就绪门：首条命令可答再继续（v3 实测迁移/慢启动期首命令早发会 ENOENT 且不复连）。
  await until(() => cdp.tryEval(`window.zs.command({ protocolVersion: 1, commandId: 'rdy-${pipeTag.slice(-6)}', method: 'app.identity', params: {} }).then((r) => r.ok === true, () => false)`).catch(() => false), (v) => v === true, 90000, '冻结候选守护进程就绪');
  return { app, cdp };
}
async function closeApp(app) {
  await until(async () => { try { process.kill(app.pid, 0); return false; } catch { return true; } }, (v) => v, 30000, 'app 退出').catch(async () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } });
  await sleep(1800);
}
function mkProj(name, files = {}) {
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  for (const [fn, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, fn), content, 'utf8');
  return dir;
}
async function pageCmd(cdp, method, params, commandId) {
  const v = await cdp.send('Runtime.evaluate', {
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g68-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
    awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(v.result.value);
}
const pageOk = async (cdp, method, params) => { const r = await pageCmd(cdp, method, params); if (r && r.ok !== true) throw new Error(`${method}: ${r.error?.message}`); return r.data ?? r; };
/** project.open 后重载走真实 boot 链（注册表/侧栏装载），返回新 cdp（旧 ws 随 reload 关闭）。
 * 就绪信号兼容 v3..v6：当前/ v4 侧栏列注册表项目；v3（r63 时代）不列——用「默认房间」
 * 文本作通用信号（项目打开后必有）。 */
async function bootProject(cdp) {
  await cdp.eval('location.reload(), true');
  const c = await connectPage('boot 重载');
  await waitFor(c, `document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间')`, 45000, '侧栏项目/默认房间');
  await sleep(800);
  return c;
}
async function openDmComposer(cdp, projId, dmId) {
  // 先等 boot 就绪（重载/首启后：侧栏或 boot=ready）——过早置 hash 会落在欢迎态且 DM 无输入区。
  await until(() => cdp.tryEval(probe(`document.body.classList.contains('hifi-on') && (document.querySelector('#hifi-root .side-project .side-item-label') != null || document.querySelector('#hifi-root .workspace')?.getAttribute('data-zs-boot') === 'ready' || document.querySelector('#hifi-root .app')?.getAttribute('data-zs-boot') === 'ready')`)).catch(() => null), (v) => v, 45000, 'DM 前就绪').catch(async (e) => {
    const h = await cdp.tryEval('location.hash');
    const txt = await cdp.tryEval(`document.querySelector('#hifi-root')?.textContent.slice(0, 200)`);
    throw new Error(`${e.message}；hash=${h}；body=${txt}`);
  });
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${projId}`)}; true`);
  await sleep(1500);
  await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dmId}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, '输入区').catch(async (e) => {
    const h = await cdp.tryEval('location.hash');
    const txt = await cdp.tryEval(`document.querySelector('#hifi-root')?.textContent.slice(0, 240)`);
    throw new Error(`${e.message}；hash=${h}；body=${txt}`);
  });
  await sleep(600);
}
async function uploadViaPage(cdp, filePath, name) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  const okv = await cdp.tryEval(probe(`(() => {
    const input = document.querySelector('#hifi-root input[data-zs-file-input]');
    if (input == null) return 'NO_INPUT';
    const bin = atob('${b64}');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(name)}, { type: 'text/markdown' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`));
  if (okv !== true) throw new Error('uploadViaPage 失败：' + String(okv));
}
const retryBtnFinder = `(() => { const b = [...document.querySelectorAll('#hifi-root .composer-mentions button')].find((x) => x.textContent.trim() === '重发原内容'); return b == null ? false : b; })()`;
async function clickRetry(cdp) {
  return await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .composer-mentions button')].find((x) => x.textContent.trim() === '重发原内容'); if (b == null) return false; b.click(); return true; })()`));
}
const bannerPresent = (cdp) => cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`);
async function pendingIdsInPage(cdp) {
  return await cdp.tryEval(`(() => { const k = [...Object.keys(localStorage)].find((x) => x.includes('zs.hifi.persist.') && !x.includes('quarantine')); if (k == null) return []; const d = JSON.parse(localStorage.getItem(k)); const ids = []; for (const e of Object.values(d.pendingSends ?? {})) { ids.push(e.commandId); for (const q of e.queued ?? []) ids.push(q.commandId); } for (const list of Object.values(d.outboundLedger ?? {})) for (const e of list) ids.push(e.commandId); return ids; })()`);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(saveAsDir, { recursive: true });
  const errs = [];
  const f = { g1: {}, g2: {}, g3: {}, g4: {}, g5: {}, g6: {} };

  /* 夹具项目与文件 */
  const mdFile = path.join(outDir, 'gate 上传.md');
  fs.writeFileSync(mdFile, `# R68 GATE 上传\n\n正文段落。\n\nR68-GATE-UPLOADED-TAIL\n`, 'utf8');
  const projG = mkProj('项目-门', { '空文件.md': '', 'gate 长文.md': `# 长文\n${'正文。'.repeat(200)}\nR68-WT-TAIL-旧\n` });

  /* ================= G1 同号重试真门（当前构建；LOSE_TIMES=3：send#1/重试#1/send#2 三次丢回执） ================= */
  {
    const root1 = path.join(outDir, 'root1');
    let { app, cdp } = await launchApp(root1, { ZS_H1_LOSE_SUBMIT_TIMES: '3', ZS_COMMAND_LOG_FILE: cmdLogPath });
    await pageOk(cdp, 'project.open', { path: projG });
    cdp = await bootProject(cdp);
    const proj = dbOf(root1).q('SELECT id FROM projects')[0];
    const members = await pageOk(cdp, 'member.list', { projectId: proj.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: agent.id });
    await openDmComposer(cdp, proj.id, dm.conversationId);
    await uploadViaPage(cdp, mdFile, 'gate 上传.md');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip')].some((c) => c.textContent.includes('gate 上传') && c.textContent.includes('v1'))`, 25000, 'G1 附件就绪');
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .composer-mentions') != null && [...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`, 40000, 'G1 未知横幅');
    const submits1 = submitsOf();
    f.g1.firstCommandId = submits1.find((s) => s.method === 'message.submit')?.commandId ?? null;
    if (typeof f.g1.firstCommandId !== 'string') errs.push('G1：原始信封 commandId 未记录');
    f.g1.firstParams = submits1.find((s) => s.commandId === f.g1.firstCommandId)?.params ?? null;
    const srv1 = dbOf(root1).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
    // 等待期新正文（保留断言在重试前——重试不动草稿正文）。
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G1-等待期新正文-保留'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    f.g1.waitingKept = await cdp.tryEval(`(document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('G1-等待期新正文-保留')`);
    // 负对照（门有牙）：此刻第二次命令尚未发出——「已重发」判定必须为假。
    f.g1.negativeNoClick = submitsOf().filter((s) => s.commandId === f.g1.firstCommandId).length === 1;
    if (f.g1.negativeNoClick !== true) errs.push('G1 负对照失效：未点击即出现第二次发送');
    // 真实点击（按按钮正文定位——R67 反例修复点）。
    f.g1.btnFound = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .composer-mentions button')].find((x) => x.textContent.trim() === '重发原内容'); return b != null; })()`));
    if (f.g1.btnFound !== true) errs.push('G1：「重发原内容」按钮未找到（按正文）');
    f.g1.clicked = await clickRetry(cdp);
    if (f.g1.clicked !== true) errs.push('G1：重试点击未发生');
    // 重试#1 也丢（LOSE#2）→ 横幅仍在、无重复、命令逐字重发。
    await sleep(2600);
    f.g1.retry1Unknown = await bannerPresent(cdp);
    const submits2 = submitsOf().filter((s) => s.commandId === f.g1.firstCommandId);
    f.g1.retry1Sent = submits2.length === 2;
    f.g1.retry1ParamsEqual = submits2.length === 2 && JSON.stringify(submits2[0].params) === JSON.stringify(submits2[1].params);
    if (f.g1.retry1Sent !== true || f.g1.retry1ParamsEqual !== true) errs.push(`G1：重试命令未逐字重发（sent=${f.g1.retry1Sent} paramsEq=${f.g1.retry1ParamsEqual}）`);
    const srv2 = dbOf(root1).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
    f.g1.exactlyOnceAfterRetry1 = srv2 - srv1 === 0;
    if (f.g1.exactlyOnceAfterRetry1 !== true) errs.push(`G1：重试#1 产生重复（+${srv2 - srv1}）`);
    // 第二封未知（不同命令）：移除附件，改仅记录，发新正文（LOSE#3 → 也未知）。
    await cdp.eval(probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root .chip')].filter((c) => c.textContent.includes('gate 上传')); chips.forEach((c) => c.querySelector('button')?.click()); return true; })()`));
    await sleep(300);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G1-第二封未知正文'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const m = [...document.querySelectorAll('#hifi-root button')].find((x) => x.getAttribute('aria-label') === '本次运行设置'); m?.click(); return true; })()`));
    await until(() => cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复')); if (b == null) return false; b.click(); return true; })()`)), (v) => v === true, 8000, 'G1 第二封仅记录意图');
    await sleep(300);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await sleep(2800);
    // 两封未知并存（不同 commandId 全保留）→ 重载后仍并存。
    await cdp.eval(`location.reload(), true`);
    cdp = await connectPage('G1 重载');
    await openDmComposer(cdp, proj.id, dm.conversationId);
    const idsAfterReload = await pendingIdsInPage(cdp);
    f.g1.twoUnknownPreserved = Array.isArray(idsAfterReload) && idsAfterReload.filter((x) => typeof x === 'string' && x.startsWith('cmd_')).length >= 2;
    if (f.g1.twoUnknownPreserved !== true) errs.push(`G1：同目标多未知信封未并存保留（${JSON.stringify(idsAfterReload)}）`);
    // 重试当前头封（=#1）→ 成功：#1 清、#2 仍在（横幅仍在）。
    f.g1.clicked2 = await clickRetry(cdp);
    await sleep(2600);
    f.g1.bannerStillOne = await bannerPresent(cdp);
    const srv3 = dbOf(root1).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
    f.g1.exactlyOnceFinal = srv3 === 2; // 两封各恰一次（#1 服务侧 1 条 + #2 服务侧 1 条）
    if (f.g1.exactlyOnceFinal !== true) errs.push(`G1：最终消息数≠2（${srv3}）`);
    const idsFinal = await pendingIdsInPage(cdp);
    f.g1.firstCleared = !(Array.isArray(idsFinal) && idsFinal.includes(f.g1.firstCommandId));
    if (f.g1.firstCleared !== true) errs.push('G1：成功重试后本条账本未清理');
    // 重试头封（当前=#2）成功后横幅应清空。
    f.g1.clicked3 = await clickRetry(cdp);
    await sleep(2600);
    f.g1.allCleared = (await bannerPresent(cdp)) !== true;
    if (f.g1.allCleared !== true) errs.push('G1：第二封重试成功后横幅未消失');
    const idsFinal2 = await pendingIdsInPage(cdp);
    f.g1.ledgerEmpty = !(Array.isArray(idsFinal2) && idsFinal2.some((x) => typeof x === 'string' && x.startsWith('cmd_')));
    if (f.g1.ledgerEmpty !== true) errs.push('G1：账本未清空');
    await closeApp(app);
  }

  /* ================= G2 真实旧版继承端到端 ================= */
  const v4src = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v4');
  const v3src = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v3');
  const v4pkg = path.join(outDir, 'v4pkg');
  const v3pkg = path.join(outDir, 'v3pkg');
  spawnSync('robocopy', [v4src, v4pkg, '/E', '/XD', 'server-data', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  spawnSync('robocopy', [v3src, v3pkg, '/E', '/XD', 'server-data', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const root4 = path.join(v4pkg, 'server-data');
  const root4copy = path.join(outDir, 'root4copy');
  const root3 = path.join(v3pkg, 'server-data');
  const projOld = mkProj('项目-旧版');

  /* ---- a) 冻结 v4 生成真 v1 状态（未知信封+草稿；无 marker） ---- */
  {
    let { app, cdp } = await launchPackaged(v4pkg, root4, { ZS_H1_LOSE_SUBMIT_ONCE: '1' });
    await pageOk(cdp, 'project.open', { path: projOld });
    cdp = await bootProject(cdp);
    const proj = dbOf(root4).q('SELECT id FROM projects')[0];
    const members = await pageOk(cdp, 'member.list', { projectId: proj.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: agent.id });
    await openDmComposer(cdp, proj.id, dm.conversationId);
    // 发送正文（空正文+无附件会被正式校验拒绝——先输入再发）。
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R68-旧版v4发送正文'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    // 仅记录意图 → 受控丢回执（提交成功、回执被扣 → v1 键里完整未知信封）。
    await cdp.eval(probe(`(() => { const m = [...document.querySelectorAll('#hifi-root button')].find((x) => x.getAttribute('aria-label') === '本次运行设置'); m?.click(); return true; })()`));
    await until(() => cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复')); if (b == null) return false; b.click(); return true; })()`)), (v) => v === true, 8000, 'v4 仅记录意图');
    await sleep(300);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`, 40000, 'v4 未知横幅');
    // 未知信封在横幅后另立**未发送草稿**（与信封并存——发送已消费掉正文，此处是独立新草稿）。
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R68-旧版v4草稿正文'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(700);
    f.g2.v1State = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.') && !x.includes('v2.') && !x.includes('quarantine')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ps = Object.values(d.pendingSends ?? {}); return { key: k, v: d.v, embedded: d.dataRootId ?? null, cmds: ps.map((p) => p.commandId) }; })()`);
    if (f.g2.v1State == null || f.g2.v1State.v !== 1 || f.g2.v1State.embedded !== null) errs.push(`G2：v4 未产生真 v1 状态（${JSON.stringify(f.g2.v1State)}）`);
    const srv4 = dbOf(root4).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversationId)[0].c;
    f.g2.v4Committed = srv4;
    await closeApp(app);
    // 复制整个数据根（含 profile）→ 副本（在当前构建接触原根**之前**——保持原根无 marker 的真 v3/v4 状态）。
    fs.cpSync(root4, root4copy, { recursive: true, force: true, errorOnExist: false });
  }

  /* ---- a2) 副本首启：候选可见 → 用户确认导入 → 横幅+原 commandId → 同号重试恰一次 ---- */
  {
    let { app, cdp } = await launchApp(root4copy, {});
    cdp = await bootProject(cdp);
    // 设置 → 数据与存储 → 旧数据目录继承。
    await cdp.eval(`location.hash = '#/settings'; true`);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button, #hifi-root .settings-nav-item, #hifi-root [class*=nav] *')].some((x) => x.textContent.trim() === '数据与存储')`, 25000, '设置分区导航');
    await cdp.eval(probe(`(() => { const el = [...document.querySelectorAll('#hifi-root button, #hifi-root [class*=nav] *')].find((x) => x.textContent.trim() === '数据与存储'); el?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('[data-zs-legacy-candidates]') != null`, 25000, '导入候选面板');
    f.g2.candidateShown = await cdp.tryEval(`document.querySelector('[data-zs-legacy-candidate]')?.getAttribute('data-zs-legacy-candidate')`);
    f.g2.candidateHasDb = await cdp.tryEval(`document.querySelector('[data-zs-legacy-candidate] [class*=tag], [data-zs-legacy-candidate] .tag')?.textContent ?? ''`);
    if (typeof f.g2.candidateShown !== 'string' || !f.g2.candidateShown.includes('server-data')) errs.push(`G2：导入候选未指向旧数据根（${f.g2.candidateShown}）`);
    await cdp.eval(probe(`document.querySelector('[data-zs-legacy-import]')?.click(), true`));
    await sleep(1200);
    const proj = dbOf(root4copy).q('SELECT id FROM projects')[0];
    const dm = dbOf(root4copy).q('SELECT id AS conversation_id FROM conversations WHERE kind = ? ORDER BY rowid LIMIT 1', 'dm')[0];
    await openDmComposer(cdp, proj.id, dm.conversation_id);
    f.g2.bannerAfterImport = await bannerPresent(cdp);
    if (f.g2.bannerAfterImport !== true) errs.push('G2：导入后未知横幅未恢复');
    const ids = await pendingIdsInPage(cdp);
    f.g2.importedCmd = Array.isArray(ids) && ids.includes(f.g2.v1State?.cmds?.[0]);
    if (f.g2.importedCmd !== true) errs.push(`G2：导入信封 commandId 不一致（${JSON.stringify(ids)} vs ${JSON.stringify(f.g2.v1State?.cmds)}）`);
    // 草稿恢复。
    f.g2.draftRestored = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value.includes('R68-旧版v4草稿正文')`);
    if (f.g2.draftRestored !== true) errs.push('G2：导入后旧草稿未恢复');
    // 同号重试恰一次。
    const before = dbOf(root4copy).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversation_id)[0].c;
    f.g2.retryClicked = await clickRetry(cdp);
    await sleep(2600);
    const after = dbOf(root4copy).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversation_id)[0].c;
    f.g2.retryDelta = after - before;
    if (f.g2.retryClicked !== true || f.g2.retryDelta !== 0) errs.push(`G2：导入后同号重试未恰一次（clicked=${f.g2.retryClicked} delta=${f.g2.retryDelta}）`);
    f.g2.bannerClearedAfterRetry = (await bannerPresent(cdp)) !== true;
    if (f.g2.bannerClearedAfterRetry !== true) errs.push('G2：导入信封重试成功后横幅未清');
    await closeApp(app);
  }

  /* ---- b) 原根同目录升级：v1 键自动继承 ---- */
  {
    let { app, cdp } = await launchApp(root4, {});
    cdp = await bootProject(cdp);
    const proj = dbOf(root4).q('SELECT id FROM projects')[0];
    const dm = dbOf(root4).q('SELECT id AS conversation_id FROM conversations WHERE kind = ? ORDER BY rowid LIMIT 1', 'dm')[0];
    await openDmComposer(cdp, proj.id, dm.conversation_id);
    f.g2.sameDirBanner = await bannerPresent(cdp);
    const ids = await pendingIdsInPage(cdp);
    f.g2.sameDirCmd = Array.isArray(ids) && ids.includes(f.g2.v1State?.cmds?.[0]);
    if (f.g2.sameDirBanner !== true || f.g2.sameDirCmd !== true) errs.push(`G2：同目录 v1 键未自动继承（banner=${f.g2.sameDirBanner} cmd=${f.g2.sameDirCmd}）`);
    f.g2.sameDirDraft = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value.includes('R68-旧版v4草稿正文')`);
    if (f.g2.sameDirDraft !== true) errs.push('G2：同目录继承后草稿未恢复');
    const before = dbOf(root4).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversation_id)[0].c;
    await clickRetry(cdp);
    await sleep(2600);
    const after = dbOf(root4).q('SELECT count(*) c FROM messages WHERE conversation_id = ?', dm.conversation_id)[0].c;
    f.g2.sameDirRetryDelta = after - before;
    if (f.g2.sameDirRetryDelta !== 0) errs.push(`G2：同目录重试产生重复（+${f.g2.sameDirRetryDelta}）`);
    await closeApp(app);
  }

  /* ---- c) 冻结 v3 → 当前候选同目录首启 ---- */
  {
    let { app, cdp } = await launchPackaged(v3pkg, root3, { ZS_H1_LOSE_SUBMIT_ONCE: '1' });
    await pageOk(cdp, 'project.open', { path: projOld });
    await pageOk(cdp, 'app.settings.set', { key: 'ui.autoOpenProjectPath', value: projOld }); // v3 侧栏不列注册表项目——记忆路径让 boot 真实打开
    cdp = await bootProject(cdp);
    const proj = dbOf(root3).q('SELECT id FROM projects')[0];
    // v3（r63 时代）私信页无挂载刷新（本候选 R68 才修）——改走**房间输入区**（默认房间随项目
    // 打开即装载；v1 快照/未知信封机制与私信同构）。
    const roomId3 = dbOf(root3).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id)[0].id;
    const openRoom3 = async (c) => {
      await until(() => c.tryEval(probe(`document.body.classList.contains('hifi-on') && (document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间'))`)).catch(() => null), (v) => v, 45000, 'v3 房间前就绪').catch(async (e) => {
        const h = await c.tryEval('location.hash');
        const txt = await c.tryEval(`document.querySelector('#hifi-root')?.textContent.slice(0, 200)`);
        throw new Error(`${e.message}；hash=${h}；body=${txt}`);
      });
      await c.eval(`location.hash = ${JSON.stringify(`/room/${roomId3}`)}; true`);
      await waitFor(c, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'v3 房间输入区').catch(async (e) => {
        const h = await c.tryEval('location.hash');
        const txt = await c.tryEval(`document.querySelector('#hifi-root')?.textContent.slice(0, 240)`);
        throw new Error(`${e.message}；hash=${h}；body=${txt}`);
      });
      await sleep(700);
    };
    await openRoom3(cdp);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R68-旧版v3发送正文'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const m = [...document.querySelectorAll('#hifi-root button')].find((x) => x.getAttribute('aria-label') === '本次运行设置'); m?.click(); return true; })()`));
    const recOk = await until(() => cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复')); if (b == null) return false; b.click(); return true; })()`)), (v) => v === true, 8000, 'v3 仅记录意图').catch(() => false);
    f.g2.v3RecordPath = recOk;
    if (recOk === true) {
      await sleep(300);
      await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
      await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`, 40000, 'v3 未知横幅').catch(() => { /* v3 路径差异则只验草稿 */ });
    }
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R68-旧版v3草稿正文'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(700);
    f.g2.v3State = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.') && !x.includes('v2.') && !x.includes('quarantine')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); return { v: d.v, drafts: Object.keys(d.drafts ?? {}).length, cmds: Object.values(d.pendingSends ?? {}).map((p) => p.commandId) }; })()`);
    await closeApp(app);
    // 当前候选同目录首启（房间输入区——与 v3 生成端同目标）。
    ({ app: app, cdp: cdp } = await launchApp(root3, {}));
    cdp = await bootProject(cdp);
    const proj3 = dbOf(root3).q('SELECT id FROM projects')[0];
    const room3cur = dbOf(root3).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj3.id)[0];
    await cdp.eval(`location.hash = ${JSON.stringify(`/room/${room3cur.id}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'v3 继承后房间输入区');
    f.g2.v3DraftRestored = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value.includes('R68-旧版v3草稿正文')`);
    if (f.g2.v3DraftRestored !== true) errs.push('G2：v3 草稿未在同目录首启恢复');
    f.g2.v3Banner = await bannerPresent(cdp);
    f.g2.v3Cmd = await pendingIdsInPage(cdp);
    if (f.g2.v3RecordPath === true && f.g2.v3Banner !== true) errs.push('G2：v3 未知信封未在同目录首启恢复');
    if (f.g2.v3RecordPath === true && !(Array.isArray(f.g2.v3Cmd) && f.g2.v3Cmd.includes(f.g2.v3State?.cmds?.[0]))) errs.push('G2：v3 信封 commandId 不一致');
    await closeApp(app);
  }

  /* ---- d) 新格式未来移动（R67 通道回归） ---- */
  {
    const rootN = path.join(outDir, 'rootN');
    const rootN2 = path.join(outDir, 'rootN2');
    let { app, cdp } = await launchApp(rootN, { ZS_H1_LOSE_SUBMIT_ONCE: '1' });
    await pageOk(cdp, 'project.open', { path: projG });
    cdp = await bootProject(cdp);
    const proj = dbOf(rootN).q('SELECT id FROM projects')[0];
    const members = await pageOk(cdp, 'member.list', { projectId: proj.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: agent.id });
    await openDmComposer(cdp, proj.id, dm.conversationId);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R68-新格式发送正文'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const m = [...document.querySelectorAll('#hifi-root button')].find((x) => x.getAttribute('aria-label') === '本次运行设置'); m?.click(); return true; })()`));
    await until(() => cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复')); if (b == null) return false; b.click(); return true; })()`)), (v) => v === true, 8000, 'd) 仅记录意图');
    await sleep(300);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions')].some((x) => x.textContent.includes('结果未知'))`, 40000, 'd) 未知横幅');
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R68-新格式移动草稿'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(700);
    const v2State = await cdp.tryEval(`(() => { const k = [...Object.keys(localStorage)].find((x) => x.includes('zs.hifi.persist.v2.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); return { key: k, cmds: Object.values(d.pendingSends ?? {}).map((p) => p.commandId) }; })()`);
    await closeApp(app);
    fs.cpSync(rootN, rootN2, { recursive: true, force: true, errorOnExist: false });
    ({ app, cdp } = await launchApp(rootN2, {}));
    cdp = await bootProject(cdp);
    const projN = dbOf(rootN2).q('SELECT id FROM projects')[0];
    const dmN = dbOf(rootN2).q('SELECT id AS conversation_id FROM conversations WHERE kind = ? ORDER BY rowid LIMIT 1', 'dm')[0];
    await openDmComposer(cdp, projN.id, dmN.conversation_id);
    f.g2.newFormatBanner = await bannerPresent(cdp);
    const idsN = await pendingIdsInPage(cdp);
    f.g2.newFormatCmd = Array.isArray(idsN) && idsN.includes(v2State?.cmds?.[0]);
    if (f.g2.newFormatBanner !== true || f.g2.newFormatCmd !== true) errs.push(`G2：新格式整根移动未自动继承（banner=${f.g2.newFormatBanner}）`);
    f.g2.newFormatDraft = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value.includes('R68-新格式移动草稿')`);

    /* ---- e) 负例：未来版本旧键不被消费；坏标记不覆写 ---- */
    // e1：在页面里注入 v999 候选（内嵌当前 dri——必须仍被拒收），删除 v2 键与继承标记后重载。
    const dri = (await pageOk(cdp, 'app.identity', {})).dataRootId;
    const oldDirKey = `zs.hifi.persist.${path.join(outDir, '不存在的旧目录')}|u_local`;
    const futureSnap = JSON.stringify({ v: 999, savedAt: Date.now(), dataRootId: dri, drafts: { 'dm:future': { body: 'R68-FUTURE-DRAFT', mentions: [], attachments: [], access: 'project', sendAs: 'ai', rev: 99, updatedAt: Date.now() } }, pendingSends: {}, uploadItems: {}, outboundLedger: {} });
    await cdp.eval(probe(`(() => { localStorage.setItem(${JSON.stringify(oldDirKey)}, ${JSON.stringify(futureSnap)}); return true; })()`));
    await cdp.eval(probe(`(() => { for (const k of Object.keys(localStorage)) { if (k.includes('zs.hifi.persist.v2.')) localStorage.removeItem(k); if (k.includes('zs.hifi.inherit.')) localStorage.removeItem(k); } return true; })()`));
    await cdp.eval(`location.reload(), true`);
    cdp = await connectPage('e1 重载');
    await openDmComposer(cdp, projN.id, dmN.conversation_id);
    await sleep(1500);
    f.g2.futureRefusedDraft = await cdp.tryEval(`(document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('R68-FUTURE-DRAFT')`);
    f.g2.futureRefusedBanner = await bannerPresent(cdp);
    f.g2.futureNote = await cdp.tryEval(`(document.querySelector('[data-zs-draft-recovery-note]')?.textContent ?? '') + '|' + (document.querySelector('[data-zs-legacy-candidates]')?.textContent ?? '')`);
    f.g2.futureOriginalKept = await cdp.tryEval(`(() => { const v = localStorage.getItem(${JSON.stringify(oldDirKey)}); return v != null && JSON.parse(v).v === 999; })()`);
    if (f.g2.futureRefusedDraft === true || f.g2.futureOriginalKept !== true) errs.push(`G2：未来版本快照被消费或原件未保全（draft=${f.g2.futureRefusedDraft} kept=${f.g2.futureOriginalKept}）`);
    await closeApp(app);
    // e2：坏标记（当前 app 关闭后写入）→ 首启健康说明+原件逐字保持+不换 ID。
    const rootBad = path.join(outDir, 'rootBad');
    {
      let { app: appB, cdp: cdpB } = await launchApp(rootBad, {});
      const driB = (await pageOk(cdpB, 'app.identity', {})).dataRootId;
      f.g2.badCreatedDri = driB;
      await closeApp(appB);
      const markerPath = path.join(rootBad, 'root-identity.json');
      const bad = '{"id":"short","createdAt":1}';
      fs.writeFileSync(markerPath, bad, 'utf8');
      ({ app: appB, cdp: cdpB } = await launchApp(rootBad, {}));
      const idB2 = await pageOk(cdpB, 'app.identity', {});
      f.g2.badHealth = idB2.rootIdentityHealth;
      f.g2.badNoNewId = idB2.dataRootId == null;
      f.g2.badMarkerKept = fs.readFileSync(markerPath, 'utf8') === bad;
      await cdpB.eval(`location.hash = '#/settings'; true`);
      await waitFor(cdpB, `[...document.querySelectorAll('#hifi-root button, #hifi-root [class*=nav] *')].some((x) => x.textContent.trim() === '数据与存储')`, 25000, 'e2 设置');
      await cdpB.eval(probe(`(() => { const el = [...document.querySelectorAll('#hifi-root button, #hifi-root [class*=nav] *')].find((x) => x.textContent.trim() === '数据与存储'); el?.click(); return true; })()`));
      await sleep(800);
      f.g2.badNoteVisible = await cdpB.tryEval(`(document.querySelector('[data-zs-draft-recovery-note]')?.textContent ?? '').includes('root-identity.json')`);
      if (f.g2.badHealth !== 'invalid-marker' || f.g2.badNoNewId !== true || f.g2.badMarkerKept !== true) errs.push(`G2：坏标记被覆写或未如实（health=${f.g2.badHealth} noNew=${f.g2.badNoNewId} kept=${f.g2.badMarkerKept}）`);
      await closeApp(appB);
    }
  }

  /* ================= G3 成员边界 ================= */
  {
    const root3g = path.join(outDir, 'root3g');
    const projA = mkProj('项目-甲');
    const projB2 = mkProj('项目-乙');
    let { app, cdp } = await launchApp(root3g, {});
    await pageOk(cdp, 'project.open', { path: projA });
    await pageOk(cdp, 'project.open', { path: projB2 });
    cdp = await bootProject(cdp);
    const projs = dbOf(root3g).q('SELECT id, display_name FROM projects ORDER BY rowid');
    const pA = projs.find((p) => p.display_name.includes('甲'));
    const pB = projs.find((p) => p.display_name.includes('乙'));
    // 打开成员页（甲）：先经项目路由聚焦甲（activeProjectId=乙 是双开后的焦点——成员页读全局
    // activeProjectId，路由参数不切焦点），再进成员页。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pA.id}`)}; true`);
    await sleep(2200);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pA.id}/members`)}; true`);
    await waitFor(cdp, `document.querySelector('[data-zs-members=hifi]') != null`, 30000, 'G3 成员页');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button')].some((x) => x.textContent.includes('添加成员'))`, 30000, 'G3 添加成员按钮');
    await sleep(400);
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('添加成员')); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('[data-zs-member-addsave]') != null`, 15000, 'G3 添加弹窗');
    await cdp.eval(probe(`(() => { const i = document.querySelector('.modal input.input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, '审查者'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    // 标题栏项目菜单 → 切乙（真实可达路径——标题栏不被内容遮罩覆盖）。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#zs-titlebar button, #hifi-root button')].find((x) => x.textContent.includes('项目管理')); b?.click(); return true; })()`));
    await until(() => cdp.tryEval(probe(`(() => { const it = [...document.querySelectorAll('.menu .menu-item, #zs-titlebar .menu-item')].find((x) => x.textContent.includes('项目-乙')); if (it == null) return false; it.click(); return true; })()`)), (v) => v === true, 10000, 'G3 标题栏切项目').catch(async () => {
      // 备选路径：项目下拉（成员页筛选行 Select）。
      await cdp.eval(probe(`(() => { const btn = document.querySelector('.page-filters .select-wrap .select'); btn?.click(); return true; })()`));
      await until(() => cdp.tryEval(probe(`(() => { const o = [...document.querySelectorAll('.select-pop .select-option')].find((x) => x.textContent.includes('项目-乙')); if (o == null) return false; o.click(); return true; })()`)), (v) => v === true, 10000, 'G3 Select 切项目');
    });
    await sleep(1500);
    f.g3.staleShown = await cdp.tryEval(`document.querySelector('[data-zs-member-addstale]') != null`);
    f.g3.staleSubmitDisabled = await cdp.tryEval(`document.querySelector('[data-zs-member-addsave]')?.disabled`);
    const countA0 = dbOf(root3g).q('SELECT count(*) c FROM project_members WHERE project_id = ?', pA.id)[0].c;
    const countB0 = dbOf(root3g).q('SELECT count(*) c FROM project_members WHERE project_id = ?', pB.id)[0].c;
    // 关闭旧框（Esc/取消），在乙下添加两个同名「审查者」。
    await cdp.eval(probe(`(() => { const m = document.querySelector('.modal'); const x = m?.querySelector('button'); x?.click(); return true; })()`));
    await sleep(500);
    // 聚焦乙再进成员页（此时全局焦点经切换已=乙；再经项目路由确定性聚焦）。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pB.id}`)}; true`);
    await sleep(2200);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pB.id}/members`)}; true`);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button')].some((x) => x.textContent.includes('添加成员'))`, 30000, 'G3 乙添加按钮');
    for (let i = 0; i < 2; i += 1) {
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('添加成员')); b?.click(); return true; })()`));
      await waitFor(cdp, `document.querySelector('[data-zs-member-addsave]') != null`, 10000, `G3 添加框 ${i + 1}`);
      await cdp.eval(probe(`(() => { const inp = document.querySelector('.modal input.input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(inp, '审查者'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
      await cdp.eval(probe(`document.querySelector('[data-zs-member-addsave]')?.click(), true`));
      await until(() => { const c = dbOf(root3g).q('SELECT count(*) c FROM project_members WHERE project_id = ?', pB.id)[0].c; return c; }, (c) => c === countB0 + i + 1, 15000, `G3 成员 ${i + 1}`);
      await sleep(600);
    }
    f.g3.sameNameAdded = true;
    f.g3.staleNoWrite = dbOf(root3g).q('SELECT count(*) c FROM project_members WHERE project_id = ?', pA.id)[0].c === countA0;
    if (f.g3.staleShown !== true || f.g3.staleSubmitDisabled !== true || f.g3.staleNoWrite !== true) errs.push(`G3：弹窗目标捕获失效（stale=${f.g3.staleShown} disabled=${f.g3.staleSubmitDisabled} noWrite=${f.g3.staleNoWrite}）`);
    // 同名可辨认：卡片/名单 #短标识；@ 菜单带 data-zs-mention-option。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pB.id}/members`)}; true`);
    await waitFor(cdp, `document.querySelectorAll('[data-zs-member-short]').length >= 2`, 30000, 'G3 卡片短标识');
    f.g3.cardShortIds = await cdp.tryEval(`[...document.querySelectorAll('[data-zs-member-short]')].map((x) => x.textContent).join('|')`);
    f.g3.distinctShort = new Set(String(f.g3.cardShortIds).split('|')).size >= 2;
    if (f.g3.distinctShort !== true) errs.push('G3：同名成员短标识不可分辨');
    // @ 菜单。
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pB.id}`)}; true`);
    await sleep(1200);
    const room = dbOf(root3g).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', pB.id)[0];
    await cdp.eval(`location.hash = ${JSON.stringify(`/room/${room.id}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 25000, 'G3 房间输入区');
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, '找到@'); ta.dispatchEvent(new Event('input', { bubbles: true })); const ev = new CompositionEvent('compositionend', { bubbles: true }); ta.dispatchEvent(ev); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root .mention-pop') != null`, 10000, 'G3 @ 候选');
    f.g3.mentionOptions = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .mention-pop [data-zs-mention-option]')].map((x) => x.textContent).join(' | ')`);
    f.g3.mentionShort = String(f.g3.mentionOptions).split('|').filter((x) => x.includes('#')).length >= 2;
    if (f.g3.mentionShort !== true) errs.push('G3：@ 菜单同名成员不可分辨');
    // 归档守卫（UI+服务端同判）。
    const revB = dbOf(root3g).q('SELECT revision FROM projects WHERE id = ?', pB.id)[0].revision;
    await pageCmd(cdp, 'project.lifecycle', { projectId: pB.id, expectedRevision: revB, action: 'archive' });
    await sleep(800);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${pB.id}/members`)}; true`);
    await sleep(1800);
    f.g3.archivedNote = await cdp.tryEval(`document.querySelector('[data-zs-members=hifi]')?.textContent.includes('已归档')`);
    const guard = await pageCmd(cdp, 'member.create', { projectId: pB.id, displayName: '归档后' });
    f.g3.archivedServerReject = guard.ok !== true && String(guard.error?.message ?? '').includes('已归档');
    if (f.g3.archivedNote !== true || f.g3.archivedServerReject !== true) errs.push(`G3：归档守卫缺失（ui=${f.g3.archivedNote} srv=${f.g3.archivedServerReject}）`);
    const revB2 = dbOf(root3g).q('SELECT revision FROM projects WHERE id = ?', pB.id)[0].revision;
    await pageCmd(cdp, 'project.lifecycle', { projectId: pB.id, expectedRevision: revB2, action: 'unarchive' });
    await closeApp(app);
  }

  /* ================= G4 第三来源交付文档（房间任务线程——ThreadPage 成果页） ================= */
  {
    const root4g = path.join(outDir, 'root4g');
    let { app, cdp } = await launchApp(root4g, {});
    await pageOk(cdp, 'project.open', { path: projG });
    cdp = await bootProject(cdp);
    const proj = dbOf(root4g).q('SELECT id FROM projects')[0];
    const members = await pageOk(cdp, 'member.list', { projectId: proj.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    const roomRow = dbOf(root4g).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id)[0];
    const roomConv = dbOf(root4g).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', proj.id, 'room')[0];
    // 房间根消息 @agent + 附件 → 真实派发（线程任务）→ FakeWorker 自然交付。
    await pageCmd(cdp, 'message.submit', {
      target: { kind: 'room_root', projectId: proj.id, conversationId: roomConv.cid, roomId: roomRow.id },
      body: '请基于附件交付结论', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }],
    });
    await until(() => { try { return dbOf(root4g).q('SELECT count(*) c FROM task_deliveries')[0].c; } catch { return 0; } }, (c) => c >= 1, 90000, 'G4 自然交付');
    const dlv = dbOf(root4g).q('SELECT id, revision, manifest_hash FROM task_deliveries ORDER BY rowid DESC LIMIT 1')[0];
    const threadId = dbOf(root4g).q('SELECT conversation_thread_id FROM tasks WHERE current_delivery_id = ?', dlv.id)[0]?.conversation_thread_id;
    f.g4.deliveryId = dlv.id;
    f.g4.threadId = threadId ?? null;
    if (threadId == null) errs.push('G4：交付任务无线程（无法进入成果页）');
    else {
      // 先聚焦项目（重载后停在欢迎页时 activeProjectId=''——LocateThread 的归属门会丢弃线程装载）。
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
      await sleep(1800);
      await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadId}?tab=artifacts`)}; true`);
      await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('成果'))`, 45000, 'G4 线程面板').catch(async (e) => {
        const h = await cdp.tryEval('location.hash');
        const txt = await cdp.tryEval(`document.querySelector('#hifi-root')?.textContent.slice(0, 240)`);
        throw new Error(`${e.message}；hash=${h}；body=${txt}`);
      });
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('成果')); b?.click(); return true; })()`));
      await waitFor(cdp, `document.querySelector('[data-zs-delivery-row]') != null`, 25000, 'G4 交付行');
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.trim() === '打开文档'); b?.click(); return true; })()`));
      await waitFor(cdp, `document.querySelector('[data-zs-delivery-doc]') != null`, 25000, 'G4 文档阅读视图');
      f.g4.docShown = true;
      f.g4.docText = await cdp.tryEval(`document.querySelector('[data-zs-delivery-doc]')?.textContent.slice(0, 200)`);
      f.g4.hashNote = await cdp.tryEval(`document.querySelector('[data-zs-delivery-doc]')?.textContent.includes('manifest')`);
      // 源码视图（JSON）。
      await cdp.eval(probe(`document.querySelector('.preview-read')?.click(), true`));
      await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.includes('源码视图'))?.click(), true`));
      await waitFor(cdp, `document.querySelector('.preview-source')?.textContent.includes('task-complete')`, 20000, 'G4 源码 JSON');
      f.g4.sourceJson = true;
      // 另存（字节=文档正文 UTF-8）。
      await cdp.eval(probe(`document.querySelector('.preview-tools .preview-icon-btn[aria-label="更多文件操作"]')?.click(), true`));
      await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.includes('下载原文件'))?.click(), true`));
      await until(() => { try { return fs.readdirSync(saveAsDir).filter((n) => n.includes('v1.md')).length; } catch { return 0; } }, (n) => n >= 1, 15000, 'G4 落盘');
      const g4saved = fs.readdirSync(saveAsDir).filter((n) => n.includes('v1.md')).map((n) => path.join(saveAsDir, n))[0];
      const doc = await pageOk(cdp, 'delivery.document', { deliveryId: dlv.id });
      f.g4.savedMatchesDoc = sha256Buf(fs.readFileSync(g4saved)) === createHash('sha256').update(Buffer.from(doc.text, 'utf8')).digest('hex');
      if (f.g4.savedMatchesDoc !== true) errs.push('G4：另存字节与交付文档不一致');
      // 引用（版本+manifest 绑定）——切回回复标签让输入区可见后点「引用到」。
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.trim() === '回复'); b?.click(); return true; })()`));
      await sleep(600);
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('引用到')); b?.click(); return true; })()`)).catch(() => null);
      await sleep(900);
      f.g4.quoteInserted = await cdp.tryEval(`(document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('引用交付') && (document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('manifest')`);
      if (f.g4.quoteInserted !== true) errs.push('G4：交付引用未带版本+manifest 绑定插入草稿');
    }
    await closeApp(app);
  }

  /* ================= G5 空文件另存 + 磁盘变更链 ================= */
  {
    const root5 = path.join(outDir, 'root5');
    let { app, cdp } = await launchApp(root5, {});
    await pageOk(cdp, 'project.open', { path: projG });
    cdp = await bootProject(cdp);
    const proj = dbOf(root5).q('SELECT id FROM projects')[0];
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
    await sleep(1800);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('空文件')`, 30000, 'G5 文件页');
    const openWorktree = async (name) => {
      for (let i = 0; i < 40; i += 1) {
        const hit = await cdp.tryEval(probe(`(() => { const els = [...document.querySelectorAll('#hifi-root *')].filter((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(name)}); if (els.length === 0) return false; els[els.length - 1].click(); return true; })()`));
        if (hit === true) return true;
        await sleep(700);
      }
      return false;
    };
    f.g5.emptyOpened = await openWorktree('空文件.md');
    if (f.g5.emptyOpened !== true) errs.push('G5：空文件未打开');
    else {
      await sleep(1200);
      await cdp.eval(probe(`document.querySelector('.preview-tools .preview-icon-btn[aria-label="更多文件操作"]')?.click(), true`));
      const clicked = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.includes('下载原文件')); if (b == null) return false; b.click(); return true; })()`));
      f.g5.emptySavedClicked = clicked === true;
      if (clicked !== true) errs.push('G5：空文件另存菜单未找到');
      else {
        await until(() => { try { return fs.readdirSync(saveAsDir).filter((n) => n.includes('空文件')).length; } catch { return 0; } }, (n) => n >= 1, 15000, 'G5 空文件落盘');
        const saved = fs.readdirSync(saveAsDir).filter((n) => n.includes('空文件')).map((n) => path.join(saveAsDir, n))[0];
        f.g5.emptyBytes = fs.statSync(saved).size;
        if (f.g5.emptyBytes !== 0) errs.push(`G5：空文件另存非 0 字节（${f.g5.emptyBytes}B）`);
      }
    }
    // 磁盘变更链：旧标签保存被拦 → 重新加载 → 新字节可存。
    f.g5.changedOpened = await openWorktree('gate 长文.md');
    if (f.g5.changedOpened === true) {
      await sleep(1000);
      fs.writeFileSync(path.join(projG, 'gate 长文.md'), `# 长文\n${'新正文。'.repeat(200)}\nR68-WT-TAIL-新\n`, 'utf8');
      await waitFor(cdp, `document.body.textContent.includes('磁盘已更新')`, 40000, 'G5 磁盘更新提示');
      await cdp.eval(probe(`document.querySelector('.preview-tools .preview-icon-btn[aria-label="更多文件操作"]')?.click(), true`));
      await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.includes('下载原文件'))?.click(), true`));
      await sleep(1200);
      const savedNew = fs.readdirSync(saveAsDir).filter((n) => n.includes('长文')).length;
      f.g5.oldTabBlocked = savedNew === 0; // 未点重载前不落盘
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('重新加载')); b?.click(); return true; })()`));
      await sleep(1600);
      await cdp.eval(probe(`document.querySelector('.preview-tools .preview-icon-btn[aria-label="更多文件操作"]')?.click(), true`));
      await cdp.eval(probe(`[...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.includes('下载原文件'))?.click(), true`));
      await until(() => { try { return fs.readdirSync(saveAsDir).filter((n) => n.includes('长文')).length; } catch { return 0; } }, (n) => n >= 1, 15000, 'G5 重载后落盘');
      const saved = fs.readdirSync(saveAsDir).filter((n) => n.includes('长文')).map((n) => path.join(saveAsDir, n))[0];
      f.g5.reloadedSavesNew = fs.readFileSync(saved, 'utf8').includes('R68-WT-TAIL-新');
      if (f.g5.oldTabBlocked !== true || f.g5.reloadedSavesNew !== true) errs.push(`G5：磁盘变更重载链断裂（blocked=${f.g5.oldTabBlocked} new=${f.g5.reloadedSavesNew}）`);
    } else errs.push('G5：长文未打开');
    await closeApp(app);
  }

  /* ================= G6 自绘 Select ================= */
  {
    const root6 = path.join(outDir, 'root6');
    let { app, cdp } = await launchApp(root6, {});
    await pageOk(cdp, 'project.open', { path: projG });
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = '#/library'; true`);
    await waitFor(cdp, `document.querySelector('.select-wrap[data-zs-select]') != null`, 25000, 'G6 自绘 Select');
    f.g6.nativeSelects = await cdp.tryEval(`document.querySelectorAll('#hifi-root select[data-zs-select]').length`);
    f.g6.wrapCount = await cdp.tryEval(`document.querySelectorAll('.select-wrap[data-zs-select]').length`);
    if (f.g6.nativeSelects !== 0 || f.g6.wrapCount === 0) errs.push(`G6：原生 select 未替换（native=${f.g6.nativeSelects} wrap=${f.g6.wrapCount}）`);
    // 点击展开（可截图的展开态）。
    await cdp.eval(probe(`document.querySelector('.select-wrap .select')?.click(), true`));
    await waitFor(cdp, `document.querySelector('.select-pop[role=listbox]') != null`, 8000, 'G6 展开列表');
    f.g6.openShot = await cdp.tryEval(`(() => { const p = document.querySelector('.select-pop'); return p != null && [...p.querySelectorAll('.select-option')].length > 0; })()`);
    const valueBefore = await cdp.tryEval(`document.querySelector('.select-wrap .select .select-value')?.textContent`);
    // 键盘：Escape 关闭 → 聚焦 ArrowDown 展开 → ArrowDown 移动 → Enter 选中（值变化）。
    await cdp.eval(probe(`(() => { const b = document.querySelector('.select-wrap .select'); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`));
    await sleep(300);
    f.g6.escClosed = await cdp.tryEval(`document.querySelector('.select-pop') == null`);
    await cdp.eval(probe(`(() => { const b = document.querySelector('.select-wrap .select'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true; })()`));
    await sleep(300);
    f.g6.kbdOpened = await cdp.tryEval(`document.querySelector('.select-pop') != null`);
    await cdp.eval(probe(`(() => { const b = document.querySelector('.select-wrap .select'); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`));
    await sleep(500);
    f.g6.kbdSelected = await cdp.tryEval(`(() => { const w = document.querySelector('.select-wrap .select .select-value'); return w != null ? w.textContent : null; })()`);
    f.g6.kbdChanged = f.g6.kbdSelected != null && f.g6.kbdSelected !== valueBefore;
    if (f.g6.escClosed !== true || f.g6.kbdOpened !== true) errs.push(`G6：键盘语义缺失（esc=${f.g6.escClosed} kbdOpen=${f.g6.kbdOpened}）`);
    // 展开态截图。
    await cdp.eval(probe(`document.querySelector('.select-wrap .select')?.click(), true`));
    await sleep(300);
    try { const png = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true }); fs.writeFileSync(path.join(outDir, 'shots', 'g6-select-open.png'), Buffer.from(png.data, 'base64')); } catch { /* 尽力 */ }
    await closeApp(app);
  }

  const realCalls = (() => { try { return dbOf(path.join(outDir, 'root1')).q('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } })();
  if (realCalls !== 0) errs.push('real_calls != 0');
  const result = { runId, ok: errs.length === 0, errs, checks: f, realCalls };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, errs: result.errs, g1: { btn: f.g1.btnFound, retry1: f.g1.retry1Sent && f.g1.retry1ParamsEqual, exactlyOnce: f.g1.exactlyOnceFinal, firstCleared: f.g1.firstCleared, allCleared: f.g1.allCleared, twoUnknown: f.g1.twoUnknownPreserved, negative: f.g1.negativeNoClick }, g2: { v1: f.g2.v1State?.v, import: f.g2.bannerAfterImport && f.g2.importedCmd && f.g2.retryDelta === 0, sameDir: f.g2.sameDirBanner && f.g2.sameDirCmd, v3: f.g2.v3DraftRestored, newFormat: f.g2.newFormatBanner, futureRefused: f.g2.futureRefusedDraft !== true && f.g2.futureOriginalKept, badMarker: f.g2.badHealth === 'invalid-marker' && f.g2.badMarkerKept }, g3: { stale: f.g3.staleShown && f.g3.staleNoWrite, sameName: f.g3.distinctShort, mention: f.g3.mentionShort, archived: f.g3.archivedServerReject }, g4: { doc: f.g4.docShown, source: f.g4.sourceJson, save: f.g4.savedMatchesDoc, quote: f.g4.quoteInserted }, g5: { empty: f.g5.emptyBytes === 0, blocked: f.g5.oldTabBlocked, reloaded: f.g5.reloadedSavesNew }, g6: { native: f.g6.nativeSelects, kbd: f.g6.kbdOpened, selected: f.g6.kbdSelected }, realCalls }));
  cleanupOwn();
  process.exit(result.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* */ }
  console.error(String(err && err.stack || err));
  console.error('[appOut]', __appOut.v.slice(-2500));
  cleanupOwn();
  process.exit(1);
});
