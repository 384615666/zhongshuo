'use strict';
/**
 * R62 P6（review-r61 §6）：新界面 Git 只读入口（历史/提交差异/merge 父选择）fixture 探针。
 *
 * 独立本地 fixture 仓库（探针自建，不触用户仓库）：
 *  - 根提交 → 普通提交 → 分支 side 提交 → --no-ff 合并（双父）→ 二进制+超限截断+>50 文件
 *    （超限占位/省略）提交；
 *  - 历史列表：根/普通/双父（merge N 父标+HEAD 标）全列；
 *  - merge 提交对比：先出「选择比较父」（parentsMeta 芯片×2+mergeNote），选父后差异与
 *    所选父 OID 绑定（comparedParent 短码回显）；**快切父**（连点两父）最终显示=最后点击
 *    （迟到响应不污染）；普通提交单父直出差异；
 *  - binary=无文本差异标；截断/超限=占位标无正文；
 *  - 项目切换：历史/差异状态清空不串项目（非 Git 目录=如实失败分列，不伪空态）。
 * 形态：源码 UI（dist/ui/renderer）× 当前正式 daemon（esbuild+Fake，零派发）。
 * 产物 dist/desktop/review-r62/git-history-result.json。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist/desktop/review-r62');
const PORT = 48295;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
function serveAt(port, dir) {
  return http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(String(req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html');
    fs.readFile(p, (e, buf) => {
      if (e != null) { res.statusCode = 404; res.end('nf'); return; }
      res.setHeader('content-type', MIME[path.extname(p)] ?? 'application/octet-stream');
      res.end(buf);
    });
  });
}
const server = serveAt(PORT, path.join(root, 'dist/ui/renderer'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function buildDaemon() {
  const entry = path.join(OUT, 'daemon-entry-r62.ts');
  const q = JSON.stringify;
  fs.writeFileSync(entry, `import { openDatabase } from ${q(path.join(root, 'src/persistence/db.ts'))};
import { dispatchDaemonCommand } from ${q(path.join(root, 'src/daemon/commands.ts'))};
export function makeDaemon(appDataDir: string) {
  const db = openDatabase(':memory:');
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir };
  const command = (env: { commandId: string; method: string; params: unknown }) => dispatchDaemonCommand(deps as never, { protocolVersion: 1, commandId: env.commandId, method: env.method, params: env.params } as never);
  return { db, command, async close() { db.close(); } };
}
`, 'utf8');
  const bundle = path.join(OUT, 'real-daemon-r62.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  return require(bundle).makeDaemon(OUT);
}

async function waitForJs(win, iife, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.race([win.webContents.executeJavaScript(iife, true).catch(() => null), sleep(5000).then(() => null)]);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(200);
  }
}
async function evalJs(win, expr) { return await win.webContents.executeJavaScript(probe(expr), true); }
async function clickBtn(win, matcher, label) {
  const ok = await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`), true);
  if (ok !== true) throw new Error('按钮未找到：' + label);
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  const daemon = await buildDaemon();
  const db = daemon.db;
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '127.0.0.1', () => { server.off('error', rej); res(); }); });

  // ── fixture 仓库：root → normal → side → merge(双父) → binary/截断/超限 ──
  const runStamp = String(Date.now()).slice(-6);
  const repo = path.join(OUT, `proj-git-${runStamp}`); // 每次全新唯一目录（残留根=commit 空树失败；删除常被句柄占用）
  fs.mkdirSync(repo, { recursive: true });
  const git = (args, cfg = []) => {
    const r = spawnSync('git', ['-C', repo, ...cfg.flatMap((c) => ['-c', c]), ...args], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${String(r.stderr ?? '').slice(0, 160)}`);
    return r;
  };
  const author = ['user.email=probe@zs.local', 'user.name=zs-probe'];
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# r62 fixture\n', 'utf8');
  git(['add', 'README.md']); git(['commit', '-q', '-m', 'root: 初始提交'], author);
  fs.writeFileSync(path.join(repo, 'file1.txt'), 'r62 普通提交内容 A 行\nr62 普通提交内容 B 行\n', 'utf8');
  git(['add', 'file1.txt']); git(['commit', '-q', '-m', 'normal: 普通提交'], author);
  git(['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(repo, 'side.txt'), 'side 分支内容\n', 'utf8');
  git(['add', 'side.txt']); git(['commit', '-q', '-m', 'side: 分支提交'], author);
  const sideOid = git(['rev-parse', 'HEAD']).stdout.trim();
  git(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(repo, 'main2.txt'), 'main 侧并行内容\n', 'utf8');
  git(['add', 'main2.txt']); git(['commit', '-q', '-m', 'main: 并行提交'], author);
  const mainOid = git(['rev-parse', 'HEAD']).stdout.trim();
  git(['merge', '-q', '--no-ff', '-m', 'merge: 双父合并提交', 'side'], author);
  const mergeOid = git(['rev-parse', 'HEAD']).stdout.trim();
  // 二进制 + 超限截断（>RT24_PER_FILE_CAP 文本）+ 超限省略（>50 文件占位）
  fs.writeFileSync(path.join(repo, 'bin.png'), Buffer.from('89504e470d0a1a0a0000000d49484452' + '00'.repeat(64), 'hex'));
  fs.writeFileSync(path.join(repo, 'big.txt'), ('r62 超限截断行\n').repeat(20000));
  const manyDir = path.join(repo, 'many');
  fs.mkdirSync(manyDir, { recursive: true });
  for (let i = 1; i <= 55; i += 1) fs.writeFileSync(path.join(manyDir, `f${String(i).padStart(2, '0')}.txt`), `第 ${i} 个文件\n`, 'utf8');
  git(['add', '.']); git(['commit', '-q', '-m', 'caps: 二进制+截断+超限省略'], author);
  const capsOid = git(['rev-parse', 'HEAD']).stdout.trim();

  // 非 Git 目录项目（切换污染对照）
  const plainDir = path.join(require('node:os').tmpdir(), `zs-r62-plain-${runStamp}`); // 必须在任意 git 仓库之外（OUT 在 zhongshuo 仓库内会被当作工作树子目录）
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, 'note.md'), '非 git 目录\n', 'utf8');

  await daemon.command({ commandId: 'cmd-r62-open1', method: 'project.open', params: { path: repo } });
  await daemon.command({ commandId: 'cmd-r62-set', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: repo } });

  const results = { scope: 'R62 P6：Git 只读历史/提交差异/merge 父选择（独立 fixture×源码 UI×当前 daemon）', fixture: { mergeOid: mergeOid.slice(0, 8), mainOid: mainOid.slice(0, 8), sideOid: sideOid.slice(0, 8), capsOid: capsOid.slice(0, 8) } };
  const sentLog = [];
  ipcMain.handle('zs-command', async (_e, env) => { sentLog.push({ method: env.method, params: env.params }); return daemon.command(env); });
  const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zs', { command: async (env) => ipcRenderer.invoke('zs-command', env), pickFolder: async () => null, openPath: async () => {}, onDisconnect: () => {}, onReconnected: () => {}, onDemoStatus: () => {} });
contextBridge.exposeInMainWorld('zsWindow', { minimize: async () => ({ ok: true }), toggleMaximize: async () => ({ ok: true }), close: async () => ({ ok: true }), getState: async () => ({ ok: true }), onStateChange: () => {} });`;
  const preloadPath = path.join(OUT, 'preload-r62.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });

  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, probe(`document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('文件与 Git'))`), 20000, 'hifi 壳+项目');
    await clickBtn(win, `b.textContent.includes('文件与 Git') && b.classList.contains('side-item')`, '进文件与 Git');
    await clickBtn(win, `b.textContent.trim() === 'Git 诊断'`, '切 Git 标签');

    // ① 历史列表：root/normal/merge/caps 全列；merge 双父标+HEAD 标
    await waitForJs(win, probe(`document.querySelector('[data-zs-git-history=hifi]') != null`), 12000, '历史区块');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-git-commit]')].length >= 5`), 15000, '历史条目≥5');
    const histText = await evalJs(win, `document.querySelector('[data-zs-git-history=hifi]').textContent`);
    results.history = {
      root: histText.includes('root: 初始提交'),
      normal: histText.includes('normal: 普通提交'),
      headOnCaps: await evalJs(win, `document.querySelector('[data-zs-git-commit="${capsOid.slice(0, 8)}"]')?.textContent.includes('HEAD')`),
      count: await evalJs(win, `[...document.querySelectorAll('[data-zs-git-commit]')].length`),
    };
    results.history.mergeTagged = await evalJs(win, `document.querySelector('[data-zs-git-commit="${mergeOid.slice(0, 8)}"]')?.textContent.includes('merge') ?? false`);

    // ② merge 对比：先选父（mergeNote）→选父A→绑定回显
    await clickBtn(win, `b.getAttribute('data-zs-git-diffbtn') === '${mergeOid.slice(0, 8)}'`, '对比 merge 提交');
    await waitForJs(win, probe(`document.querySelector('[data-zs-git-parents]') != null`), 12000, '父选择出现');
    await waitForJs(win, probe(`document.querySelector('[data-zs-git-mergenote]') != null`), 8000, 'mergeNote（先选父）');
    const parentChips = await evalJs(win, `[...document.querySelectorAll('[data-zs-git-parent]')].map((b) => b.getAttribute('data-zs-git-parent'))`);
    const pickMain = parentChips.find((c) => c === mainOid.slice(0, 8));
    const pickSide = parentChips.find((c) => c === sideOid.slice(0, 8));
    await clickBtn(win, `b.getAttribute('data-zs-git-parent') === '${pickMain}'`, '选父 main');
    await waitForJs(win, probe(`document.querySelector('[data-zs-git-commitdiff]')?.textContent.includes('相对父 ${mainOid.slice(0, 8)}')`), 12000, '差异绑定父 main（comparedParent 回显）');
    const diffVsMain = await evalJs(win, `document.querySelector('[data-zs-git-commitdiff]').textContent`);
    const boundMain = diffVsMain.includes(mainOid.slice(0, 8)) && diffVsMain.includes('side.txt') && diffVsMain.includes('side 分支内容');

    // ③ 快切父：main→side 连点，最终=side（迟到不污染）
    await clickBtn(win, `b.getAttribute('data-zs-git-parent') === '${pickSide}'`, '快切父 side');
    await sleep(150);
    await clickBtn(win, `b.getAttribute('data-zs-git-parent') === '${pickMain}'`, '快切父 main（最后点击）');
    await waitForJs(win, probe(`document.querySelector('[data-zs-git-commitdiff]')?.textContent.includes('相对父 ${mainOid.slice(0, 8)}')`), 12000, '最终绑定=最后点击（main）');
    const finalParent = await evalJs(win, `document.querySelector('[data-zs-git-commitdiff]').textContent.includes('相对父 ${mainOid.slice(0, 8)}') && !document.querySelector('[data-zs-git-commitdiff]').textContent.includes('相对父 ${sideOid.slice(0, 8)}')`);
    results.mergeDiff = { parentChips, boundMain, finalBindIsLastClick: finalParent === true, diffVsMainText: String(diffVsMain).slice(0, 300) };

    // ④ 普通提交：单父直出差异
    await clickBtn(win, `b.getAttribute('data-zs-git-diffbtn') === '${capsOid.slice(0, 8)}'`, '对比 caps 提交');
    await waitForJs(win, probe(`document.querySelector('[data-zs-git-commitdiff]') != null && !document.querySelector('[data-zs-git-commitdiff]')?.textContent.includes('选择比较父')`), 12000, '单父直出');
    const capsText = await evalJs(win, `document.querySelector('[data-zs-git-commitdiff]').textContent`);
    const capsHtml = await evalJs(win, `document.querySelector('[data-zs-git-commitdiff]').innerHTML`);
    results.caps = {
      binaryNoText: capsText.includes('bin.png') && capsText.includes('二进制'),
      binaryBodyEmpty: !/bin\.png[\s\S]{0,400}?(r62 超限截断行)/.test(capsHtml),
      truncatedTag: capsText.includes('big.txt') && capsText.includes('截断'),
      omittedPlaceholder: await evalJs(win, `[...document.querySelectorAll('[data-zs-git-commitdiff] > div')].filter((d) => d.textContent.includes('f5') && d.textContent.includes('截断')).length`) > 0,
    };

    // ⑤ 项目切换污染对照：切非 Git 项目 → 历史清空+如实失败；再切回 → 无残留 commitDiff
    await daemon.command({ commandId: 'cmd-r62-open2', method: 'project.open', params: { path: plainDir } });
    await daemon.command({ commandId: 'cmd-r62-set2', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: plainDir } });
    await win.webContents.executeJavaScript(`window.__r62old = 1; location.reload(); true`, true);
    await waitForJs(win, probe(`document.body.classList.contains('hifi-on') && window.__r62old === undefined && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('文件与 Git'))`), 25000, '非Git项目恢复（新文档）');
    await clickBtn(win, `b.textContent.includes('文件与 Git') && b.classList.contains('side-item')`, '进文件与Git（非Git）');
    await clickBtn(win, `b.textContent.trim() === 'Git 诊断'`, '切 Git 标签（非Git）');
    await sleep(2500);
    results.nonGit = {
      pageHead: await evalJs(win, `document.querySelector('[data-zs-files=hifi]')?.textContent.slice(0, 120) ?? ''`),
      honestFail: await evalJs(win, `document.querySelector('[data-zs-files=hifi]')?.textContent.includes('仓库状态不可用') ?? false`),
      noStaleCommitDiff: await evalJs(win, `document.querySelector('[data-zs-git-commitdiff]') == null`),
      noStaleHistory: await evalJs(win, `[...document.querySelectorAll('[data-zs-git-commit]')].length === 0`),
    };

    results.pass = results.history.root === true && results.history.normal === true && results.history.mergeTagged === true && results.history.headOnCaps === true
      && results.mergeDiff.boundMain === true && results.mergeDiff.finalBindIsLastClick === true
      && results.caps.binaryNoText === true && results.caps.binaryBodyEmpty === true && results.caps.truncatedTag === true && results.caps.omittedPlaceholder === true
      && results.nonGit.honestFail === true && results.nonGit.noStaleCommitDiff === true && results.nonGit.noStaleHistory === true;
  } finally {
    try { win.destroy(); } catch { /* 已销毁 */ }
    try { server.closeAllConnections?.(); } catch { /* 旧 Node */ }
    server.close();
    await daemon.close().catch(() => {});
  }
  const file = path.join(OUT, 'git-history-result.json');
  fs.writeFileSync(file, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify({ file, pass: results.pass, history: results.history, mergeDiff: results.mergeDiff, caps: results.caps, nonGit: results.nonGit }, null, 2));
  app.exit(results.pass === true ? 0 : 3);
}
void main().catch((e) => { console.error('[r62-git] 失败：', e); try { app.exit(1); } catch { process.exit(1); } });
