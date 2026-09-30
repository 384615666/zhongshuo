/**
 * 独立 Windows 自动本地验证（daemon 级）——随独立交付包分发，只用包自带 Node 运行。
 * 第十六轮一/三重写：固定结果目录（交付目录/验证结果/<编号>/——临时清理不影响证据）；
 * 结构化总结（预期/完成/失败/未执行/异常/环境/产物身份/诊断位置；中途异常与未执行不得通过）；
 * 进程出生即挂 exit 监听（error/exit/signal/timeout 分类，已退出不重挂）；失败只收拢自己启动
 * 的进程、无法确认保留现场；残留检测=统一协议（QUERY-OK 成功标记+失败≠零+实例路径匹配+排除
 * 自身+decoy 控制组先证有效）；验证前逐文件核对 MANIFEST-SHA256（篡改/缺失=拒绝）。
 * 故障注入（开发机自测用）：ZS_IND_VERIFY_FAULT=manifest|daemon。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, platform, arch, release } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const deliverRoot = resolve(import.meta.dirname, '..'); // 交付目录（结果保存在此——不被临时清理删除）
const pkgRoot = join(deliverRoot, '众说-便携-win-x64');
const daemonDir = join(pkgRoot, 'resources', 'app', 'daemon');
const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
const runId = `run-${stamp}-${randomUUID().slice(0, 4)}`;
const resultDir = join(deliverRoot, '验证结果', runId);
mkdirSync(resultDir, { recursive: true });

// ---------- 结构化计划与总结 ----------
const PLAN = [
  'manifest', 'decoy-on', 'decoy-off', 'daemon-start', 'settings', 'fake-task',
  'shutdown', 'reopen', 'reopen-settings', 'concurrent-refused', 'residual-zero',
];
const state = { executed: [], failed: [], pending: [...PLAN], exception: null, diagnostics: [] };
const check = async (id, fn) => {
  if (!state.pending.includes(id)) throw new Error(`未知检查项：${id}`);
  state.pending = state.pending.filter((x) => x !== id);
  state.executed.push(id);
  try {
    const detail = await fn();
    console.log(`PASS ${id}${detail ? `：${detail}` : ''}`);
    return true;
  } catch (error) {
    state.failed.push({ id, message: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL ${id}：${state.failed[state.failed.length - 1].message.slice(0, 200)}`);
    return false;
  }
};

// ---------- 环境与产物身份 ----------
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const buildIdentity = (() => {
  try { return JSON.parse(readFileSync(join(pkgRoot, 'BUILD.json'), 'utf8')); } catch { return { buildId: null, commit: null, note: 'BUILD.json 缺失或不可读' }; }
})();
const envInfo = { platform, arch, osRelease: release(), node: process.version, userAgent: process.env.PROCESSOR_ARCHITECTURE ?? null };

// ---------- 进程管理（出生即挂 exit；只收拢自己启动的） ----------
const kids = new Map(); // pid → { child, exited, code, signal }
function spawnTracked(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  const rec = { child, exited: false, code: null, signal: null };
  child.once('exit', (code, signal) => { rec.exited = true; rec.code = code; rec.signal = signal; });
  child.once('error', (error) => { rec.exited = true; rec.code = null; rec.signal = null; rec.error = error.message; });
  kids.set(child.pid ?? `n${kids.size}`, rec);
  return rec;
}
const waitForExit = (rec, timeoutMs) => new Promise((res) => {
  if (rec.exited) { res({ outcome: 'already-exited', code: rec.code, signal: rec.signal }); return; }
  const timer = setTimeout(() => res({ outcome: 'timeout', code: null, signal: null }), timeoutMs);
  rec.child.once('exit', (code, signal) => { clearTimeout(timer); res({ outcome: 'exited', code, signal }); });
});
async function collectOwnProcesses(reason) {
  // 只杀本脚本启动且未退出的子进程（按 pid——不碰无关进程）；无法确认则保留并记录。
  const alive = [...kids.entries()].filter(([, r]) => !r.exited);
  for (const [pid, r] of alive) { try { r.child.kill(); } catch { /* 尽力而为 */ } void pid; }
  await new Promise((r) => setTimeout(r, 800));
  const stillAlive = [...kids.entries()].filter(([, r]) => !r.exited);
  if (stillAlive.length > 0) state.diagnostics.push(`收拢后仍有 ${stillAlive.length} 个自启进程未确认退出（现场保留）——${reason}`);
}

// ---------- 残留检测（统一协议：QUERY-OK 成功标记；失败/超时/空=无法确认≠零） ----------
const psQueryPath = join(resultDir, 'proc-query.ps1');
writeFileSync(psQueryPath, [
  '$Pattern = $env:ZS_PROC_PATTERN',
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  $p = Get-CimInstance Win32_Process -Filter "CommandLine != NULL" | Where-Object { $_.CommandLine -like $Pattern -and $_.ProcessId -ne $PID }',
  '  $p | ForEach-Object { "{0}`t{1}" -f $_.ProcessId, $_.Name }',
  '  "QUERY-OK"',
  '} catch { "ERR`t" + $_.Exception.Message }',
].join('\n'), 'utf8');
function listByPath(pathPattern) {
  const ask = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psQueryPath], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ZS_PROC_PATTERN: pathPattern } });
  let r = ask();
  if (r.error != null || r.status !== 0) r = ask(); // 冷启动重试一次
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || r.error != null || !out.includes('QUERY-OK') || out.includes('ERR\t')) {
    throw new Error(`进程查询无法确认（${out.slice(0, 80) || r.stderr?.slice(0, 80) || '空输出'}）——按未验证处理，不当作零残留`);
  }
  return out.split('\n').map((l) => l.trim()).filter((l) => /^\d+\t/.test(l)).map((l) => { const [pid, name] = l.split('\t'); return { pid: Number(pid), name: name ?? '?' }; });
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- daemon 启动/IPC ----------
function startDaemon(appData, pipeName, extraEnv = {}) {
  const rec = spawnTracked(join(daemonDir, 'node', 'node.exe'), [join(daemonDir, 'daemon.cjs')], {
    cwd: pkgRoot,
    env: { ...process.env, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1', ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_APP_DATA: appData, ZS_PIPE_NAME: pipeName, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  rec.child.stderr.setEncoding('utf8');
  rec.child.stderr.on('data', (c) => { err += c; });
  return { rec, err: () => err };
}
async function waitListening(d, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (d.rec.exited) throw new Error(`daemon 启动即退出（code=${d.rec.code}${d.rec.signal != null ? ` signal=${d.rec.signal}` : ''}${d.rec.error != null ? ` error=${d.rec.error}` : ''}）：${d.err().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160)}`);
    if (d.err().includes('listening')) return;
    await sleep(200);
  }
  throw new Error('daemon 等待 listening 超时（timeout 分类——不挂等）');
}
function ipc(pipeName, appData) {
  return new Promise((res, rej) => {
    const token = readFileSync(join(appData, 'local.token'), 'utf8').trim();
    const sock = net.connect(`\\\\.\\pipe\\${pipeName}`);
    sock.setEncoding('utf8');
    let buf = '';
    let seq = 0;
    const pending = new Map();
    const timer = setTimeout(() => rej(new Error('IPC 连接超时')), 15_000);
    sock.on('connect', () => {
      clearTimeout(timer);
      sock.write(JSON.stringify({ type: 'auth', token }) + '\n');
      res({
        call(method, params, timeoutMs = 120_000) {
          return new Promise((res2, rej2) => {
            const id = `v-${seq++}-${randomUUID().slice(0, 8)}`;
            const t = setTimeout(() => { pending.delete(id); rej2(new Error(`IPC 超时 ${method}`)); }, timeoutMs);
            pending.set(id, (r) => { clearTimeout(t); if (r.ok !== true) rej2(new Error(`${method}:${r.error?.message ?? '?'}`)); else res2(r.data); });
            sock.write(JSON.stringify({ protocolVersion: 1, commandId: id, method, params }) + '\n');
          });
        },
        end: () => sock.end(),
      });
    });
    sock.on('error', (e) => { clearTimeout(timer); rej(e); });
    sock.on('data', (c) => {
      buf += c;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
        if (line.length === 0) continue;
        try { const r = JSON.parse(line); if (r.commandId != null && pending.has(r.commandId)) { pending.get(r.commandId)(r); pending.delete(r.commandId); } } catch { /* 忽略 */ }
      }
    });
  });
}

// ---------- 主流程 ----------
const tempRoot = mkdtempSync(join(tmpdir(), '众说独立验证-'));
let faultUsed = process.env.ZS_IND_VERIFY_FAULT ?? null;
if (faultUsed != null) state.diagnostics.push(`故障注入（开发机自测）：${faultUsed}`);
try {
  // ① 清单核对（验证前——篡改/缺失拒绝；不核对=后续全部不做）。
  await check('manifest', async () => {
    if (faultUsed === 'manifest') { faultUsed = null; throw new Error('注入故障：清单核对失败模拟'); }
    const m = JSON.parse(readFileSync(join(pkgRoot, 'MANIFEST-SHA256.json'), 'utf8'));
    assert(m.buildId === buildIdentity.buildId, 'BUILD.json 与清单 buildId 不一致');
    const missing = [];
    const tampered = [];
    for (const f of m.files) {
      const p = join(pkgRoot, f.path);
      if (!existsSync(p)) { missing.push(f.path); continue; }
      const h = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (h !== f.sha256) tampered.push(f.path);
    }
    assert(missing.length === 0, `清单缺失文件 ${missing.length} 个（首：${missing[0] ?? ''}）`);
    assert(tampered.length === 0, `清单哈希不符 ${tampered.length} 个（首：${tampered[0] ?? ''}）`);
    let extra = '';
    // 交付清单（验证脚本+启动器——实际执行代码）：存在则一并核对。
    const dl = join(deliverRoot, '交付清单.json');
    if (existsSync(dl)) {
      const dm = JSON.parse(readFileSync(dl, 'utf8'));
      const dmBad = dm.files.filter((f) => sha256File(join(deliverRoot, f.path)) !== f.sha256);
      assert(dmBad.length === 0, `交付清单哈希不符 ${dmBad.length} 个（首：${dmBad[0]?.path ?? ''}）`);
      assert(dm.packageBuildId === buildIdentity.buildId, '交付清单与包 BUILD.json 的 buildId 不一致');
      extra = `+交付清单 ${dm.files.length} 个（验证脚本/启动器）`;
    }
    return `核对 ${m.files.length} 个文件（含 renderer/验证入口/原生二进制）${extra}`;
  });
  // ② decoy 控制组（先证检测有效——正常用例不得以「匹配不到」充数）。
  let decoyRec = null;
  await check('decoy-on', async () => {
    decoyRec = spawnTracked(join(daemonDir, 'node', 'node.exe'), ['-e', `setInterval(()=>{},1000) /* ${pkgRoot} decoy */`], { stdio: 'ignore' });
    await sleep(1200);
    const rows = listByPath(`*${pkgRoot}*`);
    assert(rows.length >= 1, `decoy 未被检出（count=${rows.length}）——检测无效，后续残留结论不可信`);
    return `检出 ${rows.length} 个（含 decoy pid=${rows[0].pid}）`;
  });
  await check('decoy-off', async () => {
    if (decoyRec != null && !decoyRec.exited) { try { decoyRec.child.kill(); } catch { /* 尽力 */ } }
    await sleep(1200);
    const rows = listByPath(`*${pkgRoot}*`);
    assert(rows.length === 0, `decoy 结束后仍检出 ${rows.length} 个`);
    return '归零';
  });
  // ③ daemon 级链。
  const appData = join(tempRoot, '应用数据');
  const d1 = startDaemon(appData, 'zs-ind-1');
  await check('daemon-start', async () => {
    if (process.env.ZS_IND_VERIFY_FAULT === 'daemon') throw new Error('注入故障：daemon 启动失败模拟');
    await waitListening(d1);
    return 'listening（自带 Node+SQLite+koffi 加载成功；受管默认开+真实派发防护开）';
  });
  let c1 = null;
  await check('settings', async () => {
    c1 = await ipc('zs-ind-1', appData);
    const opened = await c1.call('project.open', { path: tempRoot });
    await c1.call('app.settings.set', { key: 'repoStatus.visible', value: 'false' });
    const st = await c1.call('app.settings.get', { keys: ['repoStatus.visible'] });
    assert(st.values['repoStatus.visible'] === 'false', '设置回读不一致');
    void opened;
    return 'app.settings 写读一致';
  });
  await check('fake-task', async () => {
    const opened = await c1.call('project.open', { path: tempRoot });
    const pid = opened.project.id;
    const member = `m_default_${pid}_0`;
    const t = await c1.call('message.submit', { target: { kind: 'room_root', projectId: pid, conversationId: `conv_default_${pid}`, roomId: `room_default_${pid}` }, body: '本地 fake 任务', intent: 'default', mentions: [{ kind: 'member', memberId: member }] });
    let task = null;
    for (let i = 0; i < 120; i += 1) {
      task = await c1.call('task.get', { taskId: t.taskId }, 30_000);
      if (['DONE', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(task.task.status)) break;
      await sleep(1000);
    }
    assert(task.task.status === 'DONE', `任务终态=${task.task.status}`);
    return 'DONE';
  });
  await check('shutdown', async () => {
    await c1.call('daemon.shutdown', {});
    c1.end();
    const r = await waitForExit(d1.rec, 30_000);
    assert(r.outcome !== 'timeout' && r.code === 0, `退出分类=${r.outcome} code=${r.code}`);
    return 'daemon.shutdown→退出 0（优雅关闭确认）';
  });
  const d2 = startDaemon(appData, 'zs-ind-2');
  let c2 = null;
  await check('reopen', async () => {
    await waitListening(d2);
    c2 = await ipc('zs-ind-2', appData);
    return '同 appData 重开（单例锁已释放）';
  });
  await check('reopen-settings', async () => {
    const st = await c2.call('app.settings.get', { keys: ['repoStatus.visible'] });
    assert(st.values['repoStatus.visible'] === 'false', '重开设置丢失');
    return '设置保持';
  });
  await check('concurrent-refused', async () => {
    const d3 = startDaemon(appData, 'zs-ind-3');
    const r = await waitForExit(d3.rec, 15_000);
    assert(r.outcome !== 'timeout' && r.code != null && r.code !== 0, `第二实例分类=${r.outcome} code=${r.code}（须明确失败退出）`);
    return `exit=${r.code}（单例拒绝，不启动第二 daemon）`;
  });
  await check('residual-zero', async () => {
    await c2.call('daemon.shutdown', {});
    c2.end();
    const r = await waitForExit(d2.rec, 30_000);
    assert(r.outcome !== 'timeout', '第二 daemon 关闭超时');
    await sleep(1500);
    const rows = listByPath(`*${tempRoot}*`);
    assert(rows.length === 0, `临时目录残留 ${rows.length} 个`);
    const rowsPkg = listByPath(`*${pkgRoot}*`).filter((x) => !kids.has(x.pid));
    assert(rowsPkg.length === 0, `包路径残留 ${rowsPkg.length} 个（pid=${rowsPkg.map((x) => x.pid).join(',')}）`);
    return '自启进程与临时目录均零残留';
  });
} catch (error) {
  state.exception = error instanceof Error ? `${error.message}\n${error.stack?.split('\n').slice(1, 4).join('\n')}` : String(error);
  console.error(`[verify-local] 中止：${state.exception}`);
  await collectOwnProcesses('中途异常——只收拢本脚本启动的进程');
} finally {
  // 临时目录与回传证据分开：失败保留现场；成功清理临时目录（结果目录永在交付目录下）。
  if (state.failed.length === 0 && state.exception == null && state.executed.length === PLAN.length) {
    for (let i = 0; i < 3; i += 1) { try { rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  } else {
    state.diagnostics.push(`临时现场保留：${tempRoot}`);
  }
}

const overall = state.executed.length === PLAN.length && state.failed.length === 0 && state.exception == null && state.executed.length > 0;
const summary = {
  overall,
  expectedChecks: PLAN.length,
  executedChecks: state.executed.length,
  failed: state.failed,
  notExecuted: state.pending,
  exception: state.exception,
  environment: envInfo,
  buildIdentity,
  diagnostics: state.diagnostics,
  resultDir,
  generatedAt: new Date().toISOString(),
  note: overall ? '全部预期检查执行且通过' : '存在失败/未执行/异常——不得按通过采信；诊断位置见 resultDir',
};
writeFileSync(join(resultDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log('----------------------------------------');
console.log(`整体：${overall ? '通过' : '未通过'}（预期 ${PLAN.length} 项，完成 ${state.executed.length}，失败 ${state.failed.length}，未执行 ${state.pending.length}，异常 ${state.exception != null ? 1 : 0}）`);
console.log(`结果目录：${resultDir}（summary.json 可回传）`);
process.exit(overall ? 0 : 1);
