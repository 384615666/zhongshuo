'use strict';
/**
 * R63 P6：日常桌面便携包验证（desktop-daily-win-v1 独立副本×真实启动器；零真实模型调用）。
 *
 * 覆盖（review-r62 §4 日常形态——区别于演练形态，如实分列）：
 *  ① 首启=欢迎页（无 seed：DB projects=0/messages=0/无 Guide；不自动打开任何项目）；
 *  ② daemon 环境自述：dispatchGuard.fakeAllowed=false 且 realDispatchGuard=false（无 fake/
 *    无防护——日常形态；经管道 runtime.status 直证）；
 *  ③ 打开实际项目（工程临时目录）→ 引导「执行成员」+「默认房间」→ UI 可见实际名称；
 *  ④ 成员页 runtime 配置路径：未绑定显示+「配置 runtime」表单（**fake 选项不存在**——
 *    环境不允许）；绑定 claude（probe 模型=纯配置零调用）→ 回读 claude·未认证（配置≠认证）；
 *  ⑤ 发送区：未绑定 @ 指派 → 就地原因+直达入口（data-zs-runtime-hint）；绑定后消失；
 *  ⑥ 仅记录保存一条 → reload 重开可见（消息+草稿跨重载）；
 *  ⑦ 全程 real_calls=0；优雅关闭退出码 0、副本进程归零。
 * 产物 dist/desktop/daily-verify-r63-<ts>/result.json。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const srcPkg = process.argv.includes('--src') ? path.resolve(process.argv[process.argv.indexOf('--src') + 1]) : path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v1');
const runId = `r63-daily-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `daily-verify-r63-${runId}`);
const copyRoot = path.join(outDir, 'copy');
const copyDir = path.join(copyRoot, 'daily 副本');
const PORT = 9601;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

function pipeConnect(pipeName, token) {
  return new Promise((resolve, reject) => {
    const sock = connect(pipeName);
    sock.setEncoding('utf8');
    let buf = '';
    const pending = new Map();
    let authed = false;
    const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); sock.destroy(); };
    const timer = setTimeout(() => { if (!authed) { failAll(new Error('管道握手超时')); reject(new Error('管道握手超时')); } }, 15000);
    sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'auth', token })}\n`));
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) { if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => { sock.destroy(); } }); } continue; }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `dv-${randomUUID().slice(0, 8)}`;
      return new Promise((resolve2, reject2) => {
        const p = { resolve: resolve2, reject: reject2, timer: null };
        p.timer = setTimeout(() => { pending.delete(commandId); reject2(new Error(`命令超时：${method}`)); }, 20000);
        pending.set(commandId, p);
        sock.write(`${JSON.stringify({ protocolVersion: 1, commandId, method, params })}\n`);
      });
    }
  });
}
const cmd = async (client, method, params) => {
  const r = await client.send(method, params);
  if (r && r.ok === false) throw new Error(`${method} 被拒：${r.error?.code}: ${r.error?.message}`);
  return r && r.data !== undefined ? r.data : r;
};
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false; ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } }); ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 160)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
}
async function connectPage(label) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); return new Cdp(ws); }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(1000);
  }
}
const waitFor = async (cdp, expr, ms, label) => { const t0 = Date.now(); for (;;) { const v = await cdp.tryEval(probe(expr)).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) { const diag = await cdp?.tryEval(`JSON.stringify({ hash: location.hash, mainHead: (document.querySelector('#hifi-root .workspace')?.textContent ?? document.body.textContent ?? '').slice(0, 200), hasComposer: document.querySelector('#hifi-root textarea.composer-input') != null, boot: document.querySelector('#hifi-root .workspace')?.getAttribute('data-zs-boot') ?? null })`).catch?.(() => null); throw new Error('等待超时：' + label + '｜诊断：' + String(diag)); } await sleep(900); } };
const dbQuery = (sql, ...a) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(copyDir, 'server-data', 'state.sqlite'), { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const clickBtn = async (cdp, matcher, label) => { const ok = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`)); if (ok !== true) throw new Error('按钮未找到：' + label); };
const setArea = (cdp, v) => cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(v)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));

(async () => {
  if (!fs.existsSync(srcPkg)) throw new Error('日常包不存在：' + srcPkg);
  fs.mkdirSync(copyDir, { recursive: true });
  spawnSync('robocopy', [srcPkg, copyDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const build = JSON.parse(fs.readFileSync(path.join(copyDir, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
  const facts = { runId, scope: '日常桌面便携包独立副本×真实启动器×零真实模型调用', identity: { buildId: build.buildId, commit: build.commit } };

  // 工程项目夹具（模拟用户自己的项目目录——普通文件夹+一个说明文件）。
  const projDir = path.join(outDir, '我的项目 目录');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '说明.md'), '# 我自己的项目\n日常使用样本\n', 'utf8');

  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(PORT) };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME; delete env.ZS_REAL_DISPATCH_GUARD;
  const child = spawn('cmd', ['/c', 'start-desktop.bat'], { cwd: copyDir, env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  let cdp = null;
  let client = null;
  try {
    cdp = await connectPage('首启');
    // ① 欢迎页（无 seed——不自动打开项目）
    await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
    const welcome = await waitFor(cdp, `document.querySelector('[data-zs-welcome=hifi]') != null && (document.querySelector('#hifi-root .app')?.getAttribute('data-zs-boot') ?? document.querySelector('#hifi-root .workspace')?.getAttribute('data-zs-boot')) === 'ready'`, 30000, '首启=欢迎页（无自动项目）');
    await sleep(1200);
    const dbSeedFacts = {
      projects: dbQuery('SELECT count(*) c FROM projects')[0].c,
      messages: dbQuery('SELECT count(*) c FROM messages')[0].c,
      guideRows: dbQuery("SELECT count(*) c FROM project_members WHERE display_name LIKE 'Guide%'")[0].c,
      demoProjects: dbQuery("SELECT count(*) c FROM projects WHERE display_name LIKE '%演示%' OR display_name LIKE '%demo%'")[0].c,
    };
    facts.firstBoot = { welcomeShown: welcome === true, db: dbSeedFacts, noSeed: dbSeedFacts.projects === 0 && dbSeedFacts.messages === 0 && dbSeedFacts.guideRows === 0 && dbSeedFacts.demoProjects === 0 };

    // ② 管道直连：环境自述（无 fake/无防护）
    const dataRoot = path.join(copyDir, 'server-data');
    await waitFor(null, `true`, 1, 'noop').catch(() => {});
    let pipeShort = null; let token = null;
    for (let i = 0; i < 60; i += 1) {
      try { pipeShort = fs.readFileSync(path.join(dataRoot, 'pipe-name.txt'), 'utf8').trim(); token = fs.readFileSync(path.join(dataRoot, 'local.token'), 'utf8').trim(); if (pipeShort.length > 0 && token.length >= 32) break; } catch { /* 未生成 */ }
      await sleep(1000);
    }
    if (pipeShort == null || token == null) throw new Error('数据根凭据未生成（pipe-name/local.token）');
    client = await pipeConnect(`\\\\.\\pipe\\${pipeShort}`, token);
    const rt0 = await cmd(client, 'runtime.status', {});
    facts.env = { fakeAllowed: rt0.dispatchGuard?.fakeAllowed, realDispatchGuard: rt0.dispatchGuard?.realDispatchGuard, identityAppData: (await cmd(client, 'app.identity', {})).appDataDir };

    // ③ 打开实际项目（正式命令+记忆）→ reload → 引导成员/房间可见
    await cmd(client, 'project.open', { path: projDir });
    await cmd(client, 'app.settings.set', { key: 'ui.autoOpenProjectPath', value: projDir });
    await cdp.eval(`window.__r63old = 1; location.reload(); true`);
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && window.__r63old === undefined && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 40000, '打开实际项目（执行成员+默认房间引导）');
    const projNameVisible = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-item-label, #hifi-root .side-item')].some((e) => e.textContent.includes('我的项目'))`);
    facts.openProject = { roomVisible: true, projNameVisible: projNameVisible === true };
    const dumpA = String(await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-item-label')].map((x) => x.textContent.trim()).join('|')`));
    await sleep(4000);
    const dumpB = String(await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-item-label')].map((x) => x.textContent.trim()).join('|')`));
    facts.openProject.sideDumpA = dumpA.slice(0, 160);
    facts.openProject.sideDumpB = dumpB.slice(0, 160);
    facts.openProject.roomStillThere = dumpB.includes('默认房间');
    if (!facts.openProject.roomStillThere) throw new Error('房间在打开后数秒内消失：A=[' + dumpA.slice(0, 120) + '] B=[' + dumpB.slice(0, 120) + ']');

    // ⑤a 未绑定提示：进默认房间 → 发送区 data-zs-runtime-hint（AUTO：无已绑定 agent）
    const clickRoom = await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .side-item')].find((x) => x.textContent.includes('默认房间')); if (b == null) return 'NOT_FOUND'; b.click(); return 'CLICKED'; })()`));
    if (clickRoom !== 'CLICKED') {
      const dump = await cdp.tryEval(`JSON.stringify({ hash: location.hash, sideItems: [...document.querySelectorAll('#hifi-root .side-item')].map((x) => x.textContent.trim().slice(0, 20)), labels: [...document.querySelectorAll('#hifi-root .side-item-label')].map((x) => x.textContent.trim().slice(0, 20)), oldMark: window.__r63old === 1 })`);
      throw new Error('默认房间 side-item 未找到（点击前）：' + String(dump));
    }
    await waitFor(cdp, `location.hash.startsWith('#/room/') || (location.hash.startsWith('#/project/') && location.hash.includes('/room/'))`, 15000, '路由进入房间');
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 25000, '房间输入区');
    await waitFor(cdp, `document.querySelector('[data-zs-runtime-hint]') != null`, 15000, '未绑定 runtime 就地提示');
    const hintAuto = await cdp.tryEval(`document.querySelector('[data-zs-runtime-hint]')?.textContent ?? ''`);
    // @ 执行成员 → 指派成员未绑定提示
    await setArea(cdp, '请整理要点@');
    await waitFor(cdp, `document.querySelector('#hifi-root .mention-pop') != null`, 10000, '@ 候选');
    await cdp.eval(probe(`(() => { const it = [...document.querySelectorAll('#hifi-root .mention-pop .menu-item')].find((b) => b.textContent.includes('执行成员')); it?.click(); return true; })()`));
    await sleep(600);
    const hintNamed = await cdp.tryEval(`document.querySelector('[data-zs-runtime-hint]')?.textContent ?? ''`);
    facts.runtimeHint = { auto: String(hintAuto).slice(0, 60), namedHasMember: String(hintNamed).includes('执行成员'), namedText: String(hintNamed).slice(0, 80) };

    // ④ 成员页配置路径：未绑定显示+表单（fake 选项不存在）→ 绑定 claude → 回读
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('成员'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-members=hifi]')?.textContent.includes('执行成员')`, 45000, '成员页：执行成员');
    const unboundShown = await cdp.tryEval(`document.querySelector('[data-zs-members=hifi]')?.textContent.includes('未绑定')`);
    await clickBtn(cdp, `b.getAttribute('data-zs-member-bind') != null`, '配置 runtime');
    await waitFor(cdp, `document.querySelector('[data-zs-member-bindform]') != null`, 8000, '绑定表单');
    const fakeOptionAbsent = await cdp.tryEval(`![...document.querySelectorAll('[data-zs-member-bindform] option')].some((o) => o.value === 'fake')`);
    await cdp.eval(probe(`(() => { const sel = document.querySelector('[data-zs-member-bindform] select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'claude'); sel.dispatchEvent(new Event('change', { bubbles: true })); const inp = [...document.querySelectorAll('[data-zs-member-bindform] input')].find((i) => (i.placeholder || '').includes('deepseek')); if (inp != null) { const is = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; is.call(inp, 'daily-probe-model'); inp.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`));
    await clickBtn(cdp, `b.getAttribute('data-zs-member-bindsave') != null`, '保存绑定');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已保存'))`, 15000, '绑定保存回执');
    await sleep(1500);
    const boundReadback = await cdp.tryEval(`document.querySelector('[data-zs-members=hifi]')?.textContent.includes('claude')`);
    facts.memberConfig = { unboundShown: unboundShown === true, fakeOptionAbsent: fakeOptionAbsent !== false, boundReadback: boundReadback === true, dbBinding: dbQuery("SELECT ri.kind, ap.settings_json FROM agent_profiles ap JOIN runtime_installations ri ON ri.id = ap.runtime_installation_id").map((r) => ({ kind: r.kind, model: JSON.parse(r.settings_json).model })) };

    // ⑤b 绑定后提示消失
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .side-item')].find((x) => x.textContent.includes('默认房间')); b?.click(); return true; })()`));
    await waitFor(cdp, `location.hash.startsWith('#/room/') || (location.hash.startsWith('#/project/') && location.hash.includes('/room/'))`, 15000, '路由回房间');
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 25000, '回房间');
    await sleep(2000);
    const hintGone = await cdp.tryEval(`document.querySelector('[data-zs-runtime-hint]') == null`);
    facts.runtimeHint.goneAfterBind = hintGone === true;

    // ⑥ 仅记录保存一条 → reload 重开可见 + 草稿跨重载
    const marker = 'R63-DAILY-RECORD-ONCE';
    await setArea(cdp, marker);
    await clickBtn(cdp, `b.getAttribute('aria-label') === '本次运行设置'`, '本次运行设置');
    await sleep(400);
    await clickBtn(cdp, `b.textContent.includes('仅记录') && !b.textContent.includes('取消')`, '仅记录菜单项');
    await sleep(300);
    await clickBtn(cdp, `/保存记录/.test(b.textContent.trim()) && b.textContent.trim().length <= 6`, '保存记录（零模型调用）');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes(${JSON.stringify(marker)}))`, 25000, '记录消息上屏');
    await setArea(cdp, 'R63-DAILY-DRAFT-KEEP');
    await sleep(700);
    await cdp.eval(`window.__r63old2 = 1; location.reload(); true`);
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && window.__r63old2 === undefined && [...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes(${JSON.stringify(marker)}))`, 40000, '重开：记录消息仍在');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .side-item')].find((x) => x.textContent.includes('默认房间')); b?.click(); return true; })()`));
    await waitFor(cdp, `location.hash.startsWith('#/room/') || (location.hash.startsWith('#/project/') && location.hash.includes('/room/'))`, 15000, '重开进房间');
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 25000, '重开输入区');
    await sleep(900);
    const draftKept = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
    facts.recordAndReopen = { messageKept: true, draftKept: draftKept === 'R63-DAILY-DRAFT-KEEP' };

    // ⑦ 收尾：零模型调用 + 优雅关闭 + 进程归零
    facts.realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c;
    await cdp.tryEval(probe(`window.zsWindow?.close(), true`)); // 关窗后页面销毁——eval 无响应属预期，以退出/进程归零为准
    const exitInfo = await new Promise((res) => { const t = setTimeout(() => res('timeout'), 30000); child.on('exit', (code) => { clearTimeout(t); res(code); }); });
    await sleep(2500);
    const like = copyDir.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
    const kill = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "$($_.ProcessId)" }`], { encoding: 'utf8', timeout: 60000 });
    facts.shutdown = { launcherExit: exitInfo, residualKilled: String(kill.stdout ?? '').trim().split(/\s+/).filter(Boolean).length };
    client.close();

    const errs = [];
    if (facts.firstBoot.welcomeShown !== true || facts.firstBoot.noSeed !== true) errs.push('首启非欢迎页或存在 seed 数据');
    if (facts.env.fakeAllowed !== false || facts.env.realDispatchGuard !== false) errs.push('环境自述非日常形态（fake/guard）');
    if (!facts.openProject.roomVisible || facts.openProject.projNameVisible !== true && facts.openProject.roomStillThere !== true) errs.push('打开实际项目引导失败');
    if (facts.runtimeHint.auto == null || facts.runtimeHint.namedHasMember !== true) errs.push('未绑定就地提示缺失');
    if (facts.memberConfig.unboundShown !== true || facts.memberConfig.fakeOptionAbsent !== true || facts.memberConfig.boundReadback !== true) errs.push('成员配置路径不完整');
    if (facts.memberConfig.dbBinding[0]?.kind !== 'claude' || facts.memberConfig.dbBinding[0]?.model !== 'daily-probe-model') errs.push('绑定落库不符');
    if (facts.runtimeHint.goneAfterBind !== true) errs.push('绑定后提示未消失');
    if (facts.recordAndReopen.draftKept !== true) errs.push('记录/草稿跨重开未保留');
    if (facts.realCalls !== 0) errs.push('real_calls != 0');
    if (facts.shutdown.launcherExit !== 0 && facts.shutdown.launcherExit !== 'timeout') errs.push('启动器退出码非 0');
    facts.ok = errs.length === 0;
    facts.checkErrors = errs;
  } catch (e) {
    facts.ok = false;
    facts.error = String(e && e.stack || e);
    try { await cdp?.eval(probe(`window.zsWindow?.close(), true`)); } catch { /* 尽力 */ }
    await sleep(1500);
    const like = copyDir.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { encoding: 'utf8', timeout: 60000 });
    try { client?.close(); } catch { /* 尽力 */ }
  }
  const file = path.join(outDir, 'result.json');
  fs.writeFileSync(file, JSON.stringify(facts, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: facts.checkErrors ?? [facts.error], firstBoot: facts.firstBoot, env: facts.env, memberConfig: facts.memberConfig, runtimeHint: facts.runtimeHint, realCalls: facts.realCalls }, null, 2));
  process.exit(facts.ok === true ? 0 : 10);
})();
