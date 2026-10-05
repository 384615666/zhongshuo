/**
 * R60 P4：适用本地兼容与性能预验收（review-r60 §3）——实测记录，不用 fake 汇总代替观测。
 *
 *  1) 兼容：非 Git 目录 project.open（支持）；路径=已存在文件/不存在路径→明确错误不崩；
 *     真·只读目录（icacls 拒写）→ 如实记录行为（打开或明确拒绝，不静默损坏）。
 *     中文+空格路径已由升级演练实测（upgrade-drill proj-代表 项目）——此处引用不重跑。
 *  2) 启动：dist/pack/daemon.cjs 冷启动（新数据根含迁移）与复用启动（同根重开）到管道
 *     就绪的原始毫秒；daemon 进程内存（WorkingSet）。
 *  3) 打包 Node/native 无开发 PATH：v4 包内随包 node.exe+daemon.cjs，PATH 剥离至系统
 *     最小集仍可启动到管道就绪（不依赖开发机 node_modules 路径）。
 *  4) 长历史：300 条正式 record_only 消息后 conversation.history(limit100) 三次原始耗时。
 *  5) 小窗缩放/长历史定位/预览资源收拢：沿用 r59 探针 T2/TLL/TZ 既有认证（本轮未变，
 *     不重跑——记录引用）。
 * 边界：独立数据根/管道名；零模型调用（record_only/只读命令）；产物 result.json 记录
 * 环境与失败条件。
 */
'use strict';
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r60-compat-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `local-compat-r60-${runId}`);
const dataRoot = path.join(outDir, 'data');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const daemonCjs = path.join(repo, 'dist', 'pack', 'daemon.cjs');
const token = randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbFile = path.join(dataRoot, 'state.sqlite');

async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(100);
  }
}
function pipeConnectTo(name) {
  return new Promise((resolve, reject) => {
    const sock = connect(name);
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
        if (!authed) {
          if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => { sock.destroy(); }, }); }
          continue;
        }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `cp-${randomUUID().slice(0, 8)}`;
      return new Promise((resolve2, reject2) => {
        const p = { resolve: resolve2, reject: reject2, timer: null };
        p.timer = setTimeout(() => { pending.delete(commandId); reject2(new Error(`命令超时：${method}`)); }, 20000);
        pending.set(commandId, p);
        sock.write(`${JSON.stringify({ protocolVersion: 1, commandId, method, params })}\n`);
      });
    }
  });
}
const rawCmd = async (client, method, params) => client.send(method, params);
const cmd = async (client, method, params) => {
  const r = await rawCmd(client, method, params);
  if (r && r.ok === false) throw new Error(`${method} 被拒：${r.error?.code}: ${r.error?.message}`);
  return r && r.data !== undefined ? r.data : r;
};

function spawnDaemon(env2 = {}) {
  return spawn(process.execPath, [daemonCjs], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '0', ...env2 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitPipe(child) {
  const t0 = Date.now();
  await until(async () => {
    if (child.exitCode != null) throw new Error(`daemon 提前退出 code=${child.exitCode}`);
    try { const c = await pipeConnectTo(pipeName); c.close(); return true; } catch { return false; }
  }, (v) => v === true, 40000, 'daemon 管道就绪');
  return Date.now() - t0;
}
const workingSetKb = (pid) => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${pid} | Select-Object -ExpandProperty WorkingSet64`], { encoding: 'utf8', timeout: 15000 });
  return Number(String(r.stdout ?? '').trim()) / 1024;
};

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  const facts = {
    runId,
    env: { node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? '?', cores: os.cpus().length, memGb: Math.round(os.totalmem() / 1024 / 1024 / 1024) },
    scope: '本地兼容与性能预验收（独立数据根；零模型调用；实测原始数据）',
    inheritedEvidence: {
      chineseSpacePath: 'upgrade-drill-r60（project.open 中文+空格目录成功）',
      smallWindowZoom: 'r59 探针 T2（900×620 无遮挡）',
      longHistoryLocate: 'r59 探针 TLL（补读合并装载）',
      previewResource: 'r59 探针 TZ（连续开关×3 无叠加）',
      firstReuseStart: 'r59 包三连（首启/复用/重启 allPass）',
    },
  };

  // ── 启动性能：冷（新数据根+迁移）与复用（同根重开） ──
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'pack-daemon.mjs')], { cwd: repo, stdio: 'ignore' });
  let child = spawnDaemon();
  const coldMs = await waitPipe(child);
  const daemonPid1 = child.pid;
  let client = await pipeConnectTo(pipeName);
  const dbSizeCold = fs.statSync(dbFile).size;
  await cmd(client, 'daemon.shutdown', {});
  client.close();
  await until(async () => child.exitCode, (c) => c != null, 20000, '冷启动实例退出');
  child = spawnDaemon();
  const warmMs = await waitPipe(child);
  const rssKb = workingSetKb(child.pid);
  facts.startup = { coldMs, warmMs, daemonRssKb: Math.round(rssKb), dbSizeColdBytes: dbSizeCold };
  client = await pipeConnectTo(pipeName); // 热实例新连接（冷实例连接已关——不得复用旧句柄）

  // ── 兼容：非 Git 目录 / 路径=文件 / 不存在 / 只读目录 ──
  const nonGitDir = path.join(outDir, '非Git 目录（无版本库）');
  fs.mkdirSync(nonGitDir, { recursive: true });
  fs.writeFileSync(path.join(nonGitDir, '说明.txt'), '非 git 项目样本', 'utf8');
  const asFile = path.join(outDir, '占位文件');
  fs.writeFileSync(asFile, 'x', 'utf8');
  const roDir = path.join(outDir, '只读目录');
  fs.mkdirSync(roDir, { recursive: true });
  fs.writeFileSync(path.join(roDir, '样本.txt'), 'ro', 'utf8');
  const deny = spawnSync('icacls', [roDir, '/deny', `${os.userInfo().username}:(WD,AD)`], { encoding: 'utf8' });
  const rNonGit = await rawCmd(client, 'project.open', { path: nonGitDir });
  const rFile = await rawCmd(client, 'project.open', { path: asFile });
  const rMissing = await rawCmd(client, 'project.open', { path: path.join(outDir, '不 存 在') });
  const rRo = await rawCmd(client, 'project.open', { path: roDir });
  facts.compat = {
    nonGit: { ok: rNonGit?.ok === true, note: '非 Git 目录可打开（Git 视图按无版本库如实呈现）' },
    pathIsFile: { ok: rFile?.ok !== true, code: rFile?.error?.code ?? null, cleanError: rFile?.ok !== true && rFile?.error?.code === 'PROJECT_MISSING' },
    pathMissing: { ok: rMissing?.ok !== true, code: rMissing?.error?.code ?? null, cleanError: rMissing?.ok !== true && rMissing?.error != null },
    readonlyDir: { ok: rRo?.ok === true, code: rRo?.error?.code ?? null, icaclsDenyApplied: deny.status === 0, note: '拒写 ACL 下行为如实记录（打开成功=读侧身份扫描不写该目录；失败=明确错误）' },
  };
  // 恢复 ACL（不留系统状态）。
  if (deny.status === 0) spawnSync('icacls', [roDir, '/remove:d', os.userInfo().username], { encoding: 'utf8' });

  // ── 长历史：DM 会话 300 条正式 record_only → conversation.history×3 原始毫秒 ──
  //（conversation.history 为 DM 专用；房间历史走 room.pool/thread.history——此处测长列表读取）。
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const ro = new Database(dbFile, { readonly: true });
  const projId = ro.prepare('SELECT id FROM projects ORDER BY rowid DESC LIMIT 1').get().id;
  const member = ro.prepare('SELECT id FROM project_members WHERE project_id = ? LIMIT 1').get(projId);
  ro.close();
  const dm = await cmd(client, 'conversation.create', { projectId: projId, peerMemberId: member.id, title: '长 历史 会话' });
  const dmConvId = dm.conversationId;
  const t300 = Date.now();
  for (let i = 0; i < 300; i += 1) {
    const r = await rawCmd(client, 'message.submit', { target: { kind: 'dm', projectId: projId, conversationId: dmConvId }, body: `长历史样本 #${i}（仅记录）`, intent: 'record_only', mentions: [] });
    if (r?.ok !== true) throw new Error(`record_only #${i} 失败：${JSON.stringify(r).slice(0, 120)}`);
  }
  const seed300Ms = Date.now() - t300;
  const histMs = [];
  for (let k = 0; k < 3; k += 1) {
    const t0 = Date.now();
    const h = await cmd(client, 'conversation.history', { conversationId: dmConvId, limit: 100 });
    histMs.push(Date.now() - t0);
    if (k === 0) facts.longHistory = { returned: (h.messages ?? []).length };
  }
  facts.longHistory = { ...facts.longHistory, seed300Ms, historyLimit100Ms: histMs };

  await cmd(client, 'daemon.shutdown', {});
  client.close();
  await until(async () => child.exitCode, (c) => c != null, 20000, '实例退出');

  // ── 打包 Node/native 无开发 PATH：v4 包内 node.exe + daemon.cjs，PATH 最小化 ──
  const pkgNode = path.join(repo, 'dist', 'desktop', 'hifi-h4-win-v4', 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe');
  const pkgDaemon = path.join(repo, 'dist', 'desktop', 'hifi-h4-win-v4', 'ZhongshuoDual', 'resources', 'app', 'daemon', 'daemon.cjs');
  const pkgData = path.join(outDir, 'pkg-node-data');
  const pkgPipe = `\\\\.\\pipe\\zs-${runId}-pkg`;
  const pkgToken = randomBytes(32).toString('hex');
  fs.mkdirSync(pkgData, { recursive: true });
  fs.writeFileSync(path.join(pkgData, 'local.token'), pkgToken, 'utf8');
  let pkgOk = null; let pkgMs = null;
  if (fs.existsSync(pkgNode) && fs.existsSync(pkgDaemon)) {
    const child2 = spawn(pkgNode, [pkgDaemon], {
      cwd: path.dirname(pkgDaemon),
      // PATH 剥离到系统最小集——不依赖开发机 PATH/node_modules（koffi/better-sqlite3 由
      // 包内 node_modules 相对解析）。
      env: {
        ZS_APP_DATA: pkgData, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_PIPE_NAME: pkgPipe, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1',
        PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: process.env.TEMP, TMP: process.env.TMP, USERNAME: process.env.USERNAME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child2.stderr.on('data', (c) => { err += c; });
    try {
      const t0 = Date.now();
      await until(async () => {
        if (child2.exitCode != null) throw new Error(`包内 node daemon 退出 code=${child2.exitCode}：${err.slice(0, 200)}`);
        try { const c = await pipeConnectTo2(pkgPipe, pkgToken); c.close(); return true; } catch { return false; }
      }, (v) => v === true, 40000, '包内 node daemon 就绪（PATH 剥离）');
      pkgMs = Date.now() - t0;
      pkgOk = true;
    } catch (e) {
      pkgOk = false; facts.pkgNodeError = String(e.message).slice(0, 300);
    }
    try { execFileSync('taskkill', ['/PID', String(child2.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  } else {
    pkgOk = null; facts.pkgNodeError = 'v4 包内 node/daemon 文件缺失';
  }
  facts.packagedNode = { ok: pkgOk, readyMs: pkgMs, pathStripped: true };

  facts.ok = facts.compat.nonGit.ok === true && facts.compat.pathIsFile.cleanError === true && facts.compat.pathMissing.cleanError === true
    && facts.startup.coldMs > 0 && facts.startup.warmMs > 0 && facts.longHistory.historyLimit100Ms.length === 3
    && facts.packagedNode.ok === true;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, startup: facts.startup, compat: { nonGit: facts.compat.nonGit.ok, file: facts.compat.pathIsFile.code, missing: facts.compat.pathMissing.code, ro: facts.compat.readonlyDir.ok }, longHistory: facts.longHistory, packagedNode: facts.packagedNode }));
  process.exit(facts.ok ? 0 : 11);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  process.exit(1);
});

function pipeConnectTo2(name, tok) {
  return new Promise((resolve, reject) => {
    const sock = connect(name);
    sock.setEncoding('utf8');
    let buf = '';
    let authed = false;
    const timer = setTimeout(() => { if (!authed) { sock.destroy(); reject(new Error('管道握手超时')); } }, 8000);
    sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'auth', token: tok })}\n`));
    sock.on('data', (d) => {
      buf += d;
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        const msg = JSON.parse(buf.slice(0, idx));
        if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ close: () => { sock.destroy(); } }); }
        else if (msg.type === 'auth.error') { clearTimeout(timer); sock.destroy(); reject(new Error('认证被拒')); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
