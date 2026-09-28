/**
 * 真实研讨提交-观察分离 harness（M1 收口轮）：
 * - submit：一次提交（renderer 真实操作），保存 taskId/runId/配置到 manifest，退出后 electron+daemon 继续运行
 * - observe：只读观察（run.progress/report.get/任务态），不重新提交、不派发；退出≠后台失败
 * - stop：整体截止/用户停止——按停止规则收尾并留最终快照（强杀后 DB 可开检查点读取）
 * 目录：%TEMP%/zhongshuo-m1-real（跨尝试持久，until 手动清理）。
 * 用法：node scripts/real-delib.mjs submit|observe|stop|status [--task 任务文本]
 */
/* global fetch, WebSocket */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(tmpdir(), 'zhongshuo-m1-real');
const APPDATA = join(ROOT, 'appdata');
const PROJ = join(ROOT, 'proj');
const MANIFEST = join(ROOT, 'manifest.json');
const CDP_PORT = 9781;

const DEFAULT_TASK = '请两位分别独立分析 notes.md 的内容要点与可疑之处（每人不超过6条结论），随后互评并形成整合结论';

function ensureDirs() {
  mkdirSync(APPDATA, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
}

function writeFixture() {
  writeFileSync(join(PROJ, 'notes.md'), '# 服务器迁移备忘\n\n- 旧机器：10.0.0.11（已下线）\n- 新机器：10.0.0.22，SSH 端口 2222\n- 数据库备份：/backup/db-20260920.sql.gz（未校验）\n- 证书续期脚本：每月 1 号，上次执行 9 月 1 日成功\n- 已知问题：夜间 2 点有约 5 分钟的日志空窗，原因不明\n', 'utf8');
}

async function cdpCall(method, params) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (page == null) throw new Error('CDP 页面目标不可达');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const id = 1;
  const p = new Promise((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === id) {
        if (m.error != null) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  });
  ws.send(JSON.stringify({ id, method, params }));
  void 0;
  const r = await p;
  ws.close();
  return r;
}

async function evalPage(expr) {
  const r = await cdpCall('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}

const cmd = (m, p) => `window.zs.command({protocolVersion:1,commandId:'harness-${Math.random().toString(36).slice(2)}',method:'${m}',params:${JSON.stringify(p)}})`;

async function waitForEval(exprTrue, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evalPage(exprTrue)) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function snapshot() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const snap = { manifest: { taskId: m.taskId, submittedAt: m.submittedAt, config: m.config }, elapsedMs: Date.now() - m.submittedAt };
  try {
    const progress = await evalPage(`(async()=>{ try { return JSON.stringify((await ${cmd('run.progress', { taskId: m.taskId })})).data ?? (await ${cmd('run.progress', { taskId: m.taskId })}); } catch(e){ return 'ERR '+e.message; } })()`);
    snap.progress = typeof progress === 'string' ? JSON.parse(progress) : progress;
    const report = await evalPage(`(async()=>{ const r = await ${cmd('report.get', { taskId: m.taskId })}; return JSON.stringify(r.data ?? r); })()`);
    snap.report = JSON.parse(report);
  } catch (e) {
    snap.observeError = String(e.message ?? e);
  }
  snap.appAlive = alive(m.electronPid);
  snap.overallDeadlineExceeded = m.config.runMaxMs != null && snap.elapsedMs > m.config.runMaxMs;
  return snap;
}

async function doSubmit(taskText) {
  ensureDirs();
  writeFixture();
  if (existsSync(MANIFEST)) {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    if (alive(m.electronPid)) {
      console.error(`已有实例在运行（pid=${m.electronPid}，taskId=${m.taskId ?? '未知'}）——先 observe 只读核对，勿重复提交。`);
      process.exit(5);
    }
    console.error('旧 manifest 存在但进程已死：记录于 manifest.bak 后重新提交。');
    try { renameSync(MANIFEST, `${MANIFEST}.bak-${Date.now()}`); } catch { /* ignore */ }
  }
  const config = {
    model: process.env.ZS_E2E_MODEL ?? 'gpt-6-luna',
    turnDeadlineMs: Number(process.env.ZS_TURN_DEADLINE_MS ?? 420_000),
    maxTurns: Number(process.env.ZS_DELIB_MAX_TURNS ?? 9),
    runMaxMs: Number(process.env.ZS_RUN_MAX_MS ?? 45 * 60_000),
    absenceMs: 20 * 60_000,
  };
  console.log('本组调用预算（预先声明）：', JSON.stringify({
    N: 2, 上限: config.maxTurns, 正常路径: 'IND2+CR2+SYN1+RAT2=7', 格式修复余量: config.maxTurns - 7, 尾部预留: 'S=1(整合)+Q=2(确认)',
    单轮截止: config.turnDeadlineMs, 整体窗: config.runMaxMs, 说明: '达上限即停增调用，按 §6.5 交付带异议报告或阻塞；不自动追加预算',
  }));
  const electronBin = join('node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electronBin, [`--remote-debugging-port=${CDP_PORT}`, 'dist/ui/main.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZS_APP_DATA: APPDATA, ZS_RUNTIME: 'codex', ZS_PICK_FOLDER: PROJ, ZS_PIPE_NAME: `\\\\.\\pipe\\zhongshuo-m1-real`,
      ZS_BOOTSTRAP_AGENTS: '分析师甲,分析师乙', ZS_DELIB_MAX_TURNS: String(config.maxTurns),
      ZS_TURN_DEADLINE_MS: String(config.turnDeadlineMs), ZS_ABSENCE_MS: String(config.absenceMs),
      ZS_ENABLE_DELIBERATE: '1', ZS_E2E_MODEL: config.model,
    },
    detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  // 就绪门：onclick 绑定完成。
  for (let i = 0; i < 100; i += 1) {
    try {
      if (await evalPage(`typeof document.getElementById('open-folder').onclick === 'function'`)) break;
    } catch { /* app 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  // renderer 真实操作链：打开目录 → @全体 → 输入 → 发送。
  await evalPage(`document.getElementById('open-folder').click(), true`);
  await waitForEval(`document.getElementById('project-name').textContent.includes('proj')`, 30_000, '项目加载');
  await evalPage(`document.getElementById('deliberate-toggle').click(), true`);
  await evalPage(`(function(){const e=document.getElementById('composer-input'); e.value=${JSON.stringify(taskText)}; e.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
  await evalPage(`document.getElementById('send').click(), true`);
  // 任务卡出现 → 记录 taskId（一次提交的证据锚点）。
  await waitForEval(`!!document.querySelector('#pool .pool-card')`, 60_000, '任务卡出现');
  const projId = (await evalPage(`(async()=>{ const r = await ${cmd('project.open', { path: '@@P@@' })}; return r.ok ? r.data.project.id : 'ERR ' + r.error.message; })()`.replaceAll('"@@P@@"', JSON.stringify(PROJ.split(String.fromCharCode(92)).join('/')))));
  if (typeof projId !== 'string' || !projId.startsWith('prj_')) throw new Error(`project.open 失败：${projId}`);
  const roomId = await evalPage(`(async()=>{ const r = await ${cmd('room.list', { projectId: 'PROJID' })}; return r.data.items[0].id; })()`.replace("'PROJID'", JSON.stringify(projId)));
  const taskId = await evalPage(`(async()=>{ const r = await ${cmd('room.pool', { roomId: 'ROOMID' })}; return r.data.items[0].taskId; })()`.replace("'ROOMID'", JSON.stringify(roomId)));
  const manifest = { electronPid: child.pid, cdpPort: CDP_PORT, taskId, appData: APPDATA, fixture: join(PROJ, 'notes.md'), submittedAt: Date.now(), config };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, taskId, pid: child.pid, manifest: MANIFEST }, null, 2));
}

async function doObserve() {
  if (!existsSync(MANIFEST)) { console.error('无 manifest：先 submit'); process.exit(6); }
  const snap = await snapshot();
  const st = snap.progress?.runStatus ?? snap.progress?.data?.runStatus;
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(st);
  console.log(JSON.stringify(snap, null, 2));
  if (!snap.appAlive) process.exit(4);
  if (terminal) process.exit(0);
  process.exit(1);
}

async function doStop() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  // 优先走真实停止路径（renderer task.stop）；进程不可达则按进程收尾（kill 树）。
  try {
    await evalPage(`(async()=>{ const p = await ${cmd('run.progress', { taskId: m.taskId })}; const runId = null; document.getElementById('stop-btn') && document.getElementById('stop-btn').click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 2000));
  } catch { /* UI 不在运行视图则直接进程收尾 */ }
  if (alive(m.electronPid)) {
    try { execSync(`taskkill /PID ${m.electronPid} /T /F`); } catch { /* 尽力 */ }
  }
  const snap = await (async () => { try { return await snapshot(); } catch { return { note: 'app 已关闭，观察不可用' }; } })();
  console.log(JSON.stringify({ stopped: true, final: snap }, null, 2));
}

const [action, , taskText] = process.argv.slice(2);
if (action === 'submit') await doSubmit(taskText ?? DEFAULT_TASK);
else if (action === 'observe') await doObserve();
else if (action === 'stop') await doStop();
else if (action === 'status') { if (existsSync(MANIFEST)) console.log(readFileSync(MANIFEST, 'utf8')); else console.log('no manifest'); }
else { console.error('用法：node scripts/real-delib.mjs submit|observe|stop|status [--task 文本]'); process.exit(64); }
