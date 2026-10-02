'use strict';
/**
 * DEV-25 普通浏览器交付门槛预检（第三十六轮三）。
 * 用**系统安装的普通 Edge/Chrome**（无 --ignore-certificate-errors、无 SPKI 豁免——CDP 附着
 * 只读取结果，不改变证书验证行为）：
 * - Phase A 未授信：合法证书尚未授信 → 拦截页/ERR_CERT_AUTHORITY_INVALID（与「证书自身无效」
 *   区分——结构合法性另行核验：openssl verify CA/服务证书链 + Subject/SAN/EKU 检查）；
 * - Phase B 工程侧临时授信（**模拟用户核对后安装信任根**——certutil -user 装入 CurrentUser
 *   Root，thumbprint 记录，测完 Phase C 卸载并复核——产品本身不自动装信任根）：
 *   HTTPS 页面正常加载 → 配对 → WSS 事件流（桌面发消息→浏览器 feed 收 message.submitted）；
 * - Phase C 卸载信任根 → 页面回到拦截态（证明 Phase B 的通过确实来自该信任根）。
 * LAN 分层：服务端 lanSelfCheck（本机经实际 LAN IP 的 HTTPS）+ 提示跨机问题需客户端错误码。
 * 证据：dist/desktop/dev25-browser-precheck/<ts>/evidence.json。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const stagingArg = process.argv.find((a) => a.startsWith('--staging='));
const staging = stagingArg != null ? resolve(repo, stagingArg.slice('--staging='.length)) : join(repo, 'dist', 'desktop', '众说-便携-win-x64');
if (!existsSync(staging)) throw new Error('staging 不存在：' + staging + '——先完成冻结（或传 --staging=）');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = join(repo, 'dist', 'desktop', 'dev25-browser-precheck', new Date().toISOString().replace(/[:T]/g, '').slice(0, 14));
mkdirSync(outDir, { recursive: true });
const evidence = { at: new Date().toISOString(), staging, phases: [] };
const record = (name, ok, detail) => { evidence.phases.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}：${detail}`); };

function findBrowser() {
  for (const p of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error('未找到系统 Edge/Chrome');
}

async function cdpEval(port, expr, timeoutMs = 20000, urlHint = null) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const normal = pages.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools'));
  // 新 profile 会开扩展欢迎页等无关标签——优先取 URL 命中提示的页面。
  const page = (urlHint != null ? normal.find((t) => String(t.url).includes(urlHint)) : undefined) ?? normal[0];
  if (page == null) throw new Error('无页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const out = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('cdp eval timeout')), timeoutMs);
    ws.once('message', (d) => { clearTimeout(t); const m = JSON.parse(String(d)); if (m.result?.exceptionDetails) rej(new Error(String(m.result.exceptionDetails.text))); else res(m.result?.result?.value); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return out;
}

async function waitForCdp(port, expr, timeout, label, urlHint = null) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await cdpEval(port, expr, 8000, urlHint);
      if (v === true) return v;
      if (v != null && v !== false && String(v).length > 0 && expr.includes('READ:')) return v;
    } catch (e) { /* 页面切换中 */ }
    if (Date.now() - t0 > timeout) throw new Error(`${label} 超时`);
    await sleep(1200);
  }
}

/** Network.loadingFailed 的证书错误码（比标题更精确）。 */
async function certErrorCode(port, url) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const normal = pages.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools'));
  const page = normal.find((t) => String(t.url).includes('127.0.0.1')) ?? normal[0];
  if (page == null) throw new Error('无页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let code = null;
  let title = '';
  const done = new Promise((resolve) => {
    const t = setTimeout(() => resolve(), 20000);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.method === 'Network.loadingFailed' && String(m.params?.errorText ?? '').includes('ERR_CERT')) {
        code = m.params.errorText; clearTimeout(t); resolve();
      }
    });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.method === 'Runtime.evaluate' && m.result?.result?.value != null) { title = String(m.result.result.value); }
    });
    ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.enable' }));
    ws.send(JSON.stringify({ id: 3, method: 'Page.navigate', params: { url } }));
    setTimeout(() => { void ws.send(JSON.stringify({ id: 4, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } })); }, 3000).unref?.();
  });
  await done;
  try { title = await cdpEval(port, 'document.title', 5000).catch(() => ''); } catch { title = ''; }
  ws.close();
  return { code, title };
}

const browserPath = findBrowser();
evidence.browser = browserPath;
console.log('[precheck] browser=' + browserPath);

const work = mkdtempSync(join(tmpdir(), 'browser-precheck-'));
const appData = join(work, 'app-data');
const edgeProfile = join(work, 'edge-profile');
let appChild = null;
let edgeChild = null;

async function main() {
  // ---------- 启动便携应用（fake+硬防护）----------
  const env = { ...process.env, ZS_APP_DATA: appData, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: '\\\\.\\pipe\\zs-browser-precheck', ZS_BOOTSTRAP_AGENTS: 'Guide A,Guide B', ZS_REMOTE_SELFCHECK: '1' };
  appChild = spawn(join(staging, 'electron.exe'), ['--remote-debugging-port=9391'], { cwd: staging, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let appErr = '';
  appChild.stderr.setEncoding('utf8');
  appChild.stderr.on('data', (d) => { appErr += d; });
  // 等页面就绪。
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { ready = await cdpEval(9391, 'window.__zsReady === true', 5000); } catch { /* boot */ }
    if (!ready) await sleep(1500);
  }
  if (!ready) throw new Error('应用页面未就绪');
  // 打开项目（共享 OpenFolderModal 直接 autoPick 临时目录——正式链）。
  const demo = join(work, 'demo');
  mkdirSync(demo, { recursive: true });
  writeFileSync(join(demo, 'welcome.md'), '# precheck\n', 'utf8');
  await cdpEval(9391, `window.zs.command({protocolVersion:1,commandId:'pc-open-1',method:'project.open',params:{path:${JSON.stringify(demo)},displayName:'预检项目'}}).then(()=>true)`);
  // 启用远程（LAN）。
  const cfgOn = await cdpEval(9391, `window.zs.command({protocolVersion:1,commandId:'pc-cfg-1',method:'remote.config.set',params:{enabled:true,listenHost:'0.0.0.0',port:0,allowLan:true}}).then(r=>JSON.stringify(r))`);
  const cfg = JSON.parse(String(cfgOn));
  const cfgNow = JSON.parse(String(await cdpEval(9391, `window.zs.command({protocolVersion:1,commandId:'pc-cfg-2',method:'remote.config.get',params:{}}).then(r=>JSON.stringify(r.data ?? r))`)));
  const address = cfgNow.address ?? '';
  const portMatch = /:(\d+)$/.exec(address);
  const port = portMatch != null ? Number(portMatch[1]) : 0;
  const caCer = join(appData, 'remote', 'ca.cer');
  const serverDer = join(appData, 'remote', 'identity.cer');
  if (port === 0 || !existsSync(caCer) || !existsSync(serverDer)) throw new Error('远程启用失败：' + JSON.stringify(cfgNow).slice(0, 200));
  record('启用 LAN（实际监听+两枚指纹+lanSelfCheck）', cfgNow.running === true && (cfgNow.lanSelfCheck?.ok === true || cfgNow.allowLan !== true), `address=${address} serverFp=${String(cfgNow.fingerprint ?? '').slice(0, 12)}… caFp=${String(cfgNow.caFingerprint ?? '').slice(0, 12)}… lanSelfCheck=${JSON.stringify(cfgNow.lanSelfCheck ?? null)}`);

  // ---------- 结构合法性（区别「证书自身无效」与「尚未授信」）----------
  const verify = spawnSync('openssl', ['verify', '-CAfile', caCer, serverDer], { encoding: 'utf8', timeout: 30000 });
  const subj = spawnSync('openssl', ['x509', '-in', caCer, '-inform', 'DER', '-noout', '-subject', '-issuer'], { encoding: 'utf8', timeout: 30000 });
  const ssubj = spawnSync('openssl', ['x509', '-in', serverDer, '-inform', 'DER', '-noout', '-subject', '-issuer', '-ext', 'subjectAltName'], { encoding: 'utf8', timeout: 30000 });
  const structOk = verify.status === 0 && String(subj.stdout).includes('CN=') && String(ssubj.stdout).includes('subject=CN=') && String(ssubj.stdout).includes('IP Address');
  record('证书结构合法（Subject/Issuer 非空+SAN 含 IP+CA 链验签）', structOk, `openssl=${String(verify.stdout).trim()} subj=${String(subj.stdout).replace(/\r?\n/g, '/').slice(0, 120)}`);

  // ---------- Phase A：未授信（普通浏览器，无任何证书开关）----------
  edgeChild = spawn(browserPath, [
    `--remote-debugging-port=9392`,
    `--user-data-dir=${edgeProfile}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--disable-gpu',
    `https://127.0.0.1:${port}/`,
  ], { stdio: 'ignore' });
  await sleep(6000);
  const a = await certErrorCode(9392, `https://127.0.0.1:${port}/`);
  record('Phase A 未授信：拦截页+ERR_CERT_AUTHORITY_INVALID（合法证书尚未授信——非结构无效）',
    (a.code != null && String(a.code).includes('ERR_CERT_AUTHORITY_INVALID')) || String(a.title).includes('不是专用连接') || String(a.title).includes('not private'),
    `code=${a.code ?? 'null'} title=${String(a.title).slice(0, 60)}`);

  // ---------- Phase B：工程侧临时授信（模拟用户核对后安装信任根——测完卸载）----------
  // thumbprint=CA DER 的 SHA-1（即存储指纹——不解析 store 文本输出，中英环境无关）。
  const thumbprint = createHash('sha1').update(readFileSync(caCer)).digest('hex');
  // certutil 偶发 spawn 失败（status=null）——重试；装后用 certutil -user -verify 核验确实入库。
  let addStatus = null;
  for (let i = 0; i < 3 && addStatus !== 0; i += 1) {
    const add = spawnSync('certutil', ['-user', '-addstore', 'Root', caCer], { encoding: 'utf8', timeout: 30000 });
    addStatus = add.status;
  }
  const verifyAdd = spawnSync('certutil', ['-user', '-store', 'Root', thumbprint], { encoding: 'utf8', timeout: 30000 });
  const inStore = verifyAdd.status === 0 && String(verifyAdd.stdout ?? '').includes('Zhongshuo Remote Access CA');
  record('Phase B 临时授信（CurrentUser Root——工程侧模拟用户，记录 thumbprint）', addStatus === 0 && inStore, `addStatus=${addStatus} thumbprint=${thumbprint} inStore=${inStore}`);
  if (thumbprint == null) throw new Error('未能定位临时 CA thumbprint——中止（不留信任残留）');
  evidence.temporaryCaThumbprint = thumbprint;

  // 页面加载+配对+WSS。
  await certErrorCode(9392, `https://127.0.0.1:${port}/`).catch(() => null); // 导航（这次应成功加载）
  await sleep(3000);
  const title = await cdpEval(9392, 'document.title', 8000, `127.0.0.1:${port}`).catch(() => '');
  record('Phase B 授信后：HTTPS 页面正常加载（普通浏览器）', String(title).includes('众说'), `title=${String(title).slice(0, 40)}`);
  // 配对码（桌面可信入口）。
  const pairRaw = await cdpEval(9391, `window.zs.command({protocolVersion:1,commandId:'pc-pair-1',method:'remote.pairing.create',params:{}}).then(r=>JSON.stringify({id:r.data.pairingId,code:r.data.code}))`, 20000, '127.0.0.1');
  const pair = JSON.parse(String(pairRaw));
  await cdpEval(9392, `(() => { const set=(id,v)=>{document.getElementById(id).value=v;}; set('pairing-id',${JSON.stringify(pair.id)}); set('pairing-code',${JSON.stringify(pair.code)}); set('device-name','普通浏览器预检'); return true; })()`, 20000, '127.0.0.1');
  // 绑定后真实点击（等 onclick 已绑定）。
  const clickState = await cdpEval(9392, `(() => new Promise((resolve) => { const b=document.getElementById('pair-btn'); if (b==null) { resolve('no-btn'); return; } const t=setInterval(()=>{ if (b.onclick!=null) { clearInterval(t); b.click(); resolve('clicked'); } },300); setTimeout(()=>{clearInterval(t);resolve('no-bind');},8000); }))()`, 20000, '127.0.0.1');
  let pairState = '';
  try {
    await waitForCdp(9392, `!document.getElementById('main').classList.contains('hidden')`, 30000, '配对进入主界面', '127.0.0.1');
  } catch (e) {
    pairState = String(await cdpEval(9392, `JSON.stringify({ status: document.getElementById('setup-status')?.textContent ?? '', mainHidden: document.getElementById('main')?.className ?? '', hasForm: document.getElementById('pair-btn') != null })`, 8000, '127.0.0.1').catch(() => 'dump-fail'));
    throw new Error(`配对未进入主界面（click=${String(clickState)} state=${pairState}）：${e.message}`);
  }
  record('Phase B 配对（普通浏览器表单→IndexedDB 凭据→主界面）', true, `pairingId=${pair.id.slice(0, 10)}…`);
  // WSS：浏览器页面自身发「仅记录」（同一命令面——提交响应之外，事件须经 WSS 到达 feed）。
  const feedBefore = Number(await cdpEval(9392, `document.getElementById('feed').childElementCount`, 8000, '127.0.0.1'));
  const sent = await cdpEval(9392, `(() => { const sel=document.getElementById('conversation-sel'); sel.value=sel.options[0]?.value ?? ''; sel.dispatchEvent(new Event('change')); return new Promise((resolve) => { setTimeout(() => { document.getElementById('send-text').value='普通浏览器预检消息 PRECHECK-WS-1'; document.getElementById('record-btn').onclick ? document.getElementById('record-btn').onclick() : document.getElementById('record-btn').click(); resolve('sent'); }, 1200); }); })()`, 20000, '127.0.0.1');
  try {
    // 事件流断言=发送后**新事件行**经 WSS 到达（房间根仅记录产生 thread.created/message.submitted
  // 均可证事件流——不只认特定 kind）。
  await waitForCdp(9392, `(() => { const rows = [...document.getElementById('feed').children]; if (rows.length <= ${feedBefore}) return false; const head = String(rows[0].textContent ?? ''); return (head.includes('thread.created') || head.includes('message.submitted') || head.includes('message.recorded')); })()`, 30000, 'WSS 事件到达', '127.0.0.1');
  } catch (e) {
    const wsState = String(await cdpEval(9392, `JSON.stringify({ sent: window.__lastReadError ?? '', feed: (document.getElementById('feed')?.textContent ?? '').slice(0, 260), selCount: document.getElementById('conversation-sel')?.options?.length ?? 0 })`, 8000, '127.0.0.1').catch(() => 'dump-fail'));
    throw new Error(`WSS 事件未到（state=${wsState}）：${e.message}`);
  }
  const feedHead = await cdpEval(9392, `(document.getElementById('feed').firstChild?.textContent ?? '')`, 8000, '127.0.0.1').catch(() => '');
  record('Phase B WSS 事件流（提交后新事件行经 WSS 到达）', /thread\.created|message\.(submitted|recorded)/.test(String(feedHead)), `sent=${sent} head=${String(feedHead).slice(0, 60)}`);

  // ---------- Phase C：卸载信任根 → 回到拦截态 ----------
  const del = spawnSync('certutil', ['-user', '-delstore', 'Root', thumbprint], { encoding: 'utf8', timeout: 30000 });
  const after = spawnSync('certutil', ['-user', '-verify', caCer], { encoding: 'utf8', timeout: 30000 });
  const c = await certErrorCode(9392, `https://127.0.0.1:${port}/`).catch(() => ({ code: null, title: '' }));
  record('Phase C 卸载信任根（不留残留）+页面回到拦截态', del.status === 0 && ((c.code != null && String(c.code).includes('ERR_CERT')) || String(c.title).includes('不是专用连接')), `delStatus=${del.status} code=${c.code ?? 'null'} title=${String(c.title).slice(0, 40)}`);
}

try {
  await main();
} catch (e) {
  evidence.error = e.message;
  console.error('[precheck] ERROR: ' + e.message);
} finally {
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  // 清理：卸载临时信任根（若残留）+停应用（优雅关窗）+杀 Edge。
  if (evidence.temporaryCaThumbprint != null) {
    spawnSync('certutil', ['-user', '-delstore', 'Root', evidence.temporaryCaThumbprint], { timeout: 30000 });
  }
  if (edgeChild != null) { try { spawnSync('taskkill', ['/PID', String(edgeChild.pid), '/T', '/F'], { timeout: 15000 }); } catch { /* 尽力 */ } }
  if (appChild != null) { try { await cdpEval(9391, 'window.close()', 5000).catch(() => null); } catch { /* 尽力 */ } }
  await sleep(3000);
  if (appChild != null) { try { spawnSync('taskkill', ['/PID', String(appChild.pid), '/T', '/F'], { timeout: 15000 }); } catch { /* 尽力 */ } }
  for (let i = 0; i < 5; i += 1) { try { rmSync(work, { recursive: true, force: true }); break; } catch { /* 句柄 */ } }
  const pass = evidence.error == null && evidence.phases.length > 0 && evidence.phases.every((p) => p.ok);
  console.log(`[precheck] ${pass ? 'PASS' : 'FAIL'} -> ${join(outDir, 'evidence.json')}`);
  process.exit(pass ? 0 : 1);
}
