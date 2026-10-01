/**
 * 通知人工验收——合成数据种子（第二十六轮二建立，第二十七轮一修环境闭环）：经**正式 daemon 管道**
 * 造数（不直写库）。由「启动通知验收.cmd」以包内 node 运行：环境（fake/guard/独立 appData/完整前缀
 * 管道）由启动器统一设置——本脚本**优先读回同一环境**（process.env），保证 seed 与随后的 Electron
 * 用的是同一份配置（相对布局仅作回退，不再各自推导）。
 * 流程：起 daemon → project.open（合成项目）→ app.settings.set（ui.autoOpenProjectPath——UI 首启
 * 自动恢复）→ 房间任务（DIRECT 单成员→REVIEW 线程）→ 房间线程提醒 + DM 提醒（once=+90s/+95s，
 * autoDispatch 缺省 false——到点待确认=通知场景）→ daemon.shutdown → **核对实际退出码**（超时/
 * 非零退出=如实失败，不打印"已优雅停止"）→ 按 runId 留档（不覆盖 结果.txt 用户回填）。
 * 幂等：合成项目目录存在即复用；提醒按固定标题去重（reminder.schedule 事务内）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

// 环境优先（与 Electron 同源）；相对布局回退（直接 node 手跑时不强制先设环境；目录名 ASCII——
// 启动器内容纯 ASCII，中文路径不得出现在批处理行文本里）。
const pkgRoot = join(import.meta.dirname, '..');
const appHome = process.env.ZS_NOTIFY_APP_HOME ?? join(pkgRoot, 'app');
const dataDir = process.env.ZS_APP_DATA ?? join(pkgRoot, 'app-data');
const projDir = process.env.ZS_NOTIFY_PROJ_DIR ?? join(pkgRoot, 'demo-project');
const pipeName = process.env.ZS_PIPE_NAME ?? '\\\\.\\pipe\\zs-notify-acceptance';
const nodeExe = join(appHome, 'resources', 'app', 'daemon', 'node', 'node.exe');
const daemonCjs = join(appHome, 'resources', 'app', 'daemon', 'daemon.cjs');
const runId = `seed-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${process.pid}`;
mkdirSync(projDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
if (!existsSync(join(projDir, 'notes.md'))) writeFileSync(join(projDir, 'notes.md'), '# 通知验收项目（合成——fake 运行时）\n', 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(nodeExe, [daemonCjs], {
  cwd: appHome,
  env: {
    ...process.env, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1',
    ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1',
    ZS_APP_DATA: dataDir, ZS_PIPE_NAME: pipeName,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let err = '';
let stopResultTail = ''; // daemon 结构化停机尾行（stop-result {...}）——与 UI 侧同源捕获
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => {
  err += c;
  for (const l of c.split('\n')) if (l.includes('stop-result ')) stopResultTail = l.slice(l.indexOf('stop-result ') + 'stop-result '.length).trim();
});
try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`daemon 启动即退出（code=${child.exitCode}）：${err.slice(-300)}`);
    if (err.includes('listening')) break;
    await sleep(150);
  }
  if (!err.includes('listening')) throw new Error(`daemon ${deadline - Date.now() <= 0 ? '就绪超时' : '未就绪'}：${err.slice(-300)}`);
  const token = readFileSync(join(dataDir, 'local.token'), 'utf8').trim();
  const call = (method, params) => new Promise((res, rej) => {
    const sock = net.connect(pipeName);
    sock.setEncoding('utf8');
    const id = `seed-${randomUUID().slice(0, 8)}`;
    const t = setTimeout(() => { sock.destroy(); rej(new Error(`IPC 超时 ${method}`)); }, 120_000);
    let authed = false; let buf = '';
    sock.on('connect', () => { sock.write(JSON.stringify({ type: 'auth', token }) + '\n'); });
    sock.on('error', (e) => { clearTimeout(t); rej(e); });
    sock.on('data', (c) => {
      buf += c;
      if (!authed) {
        const i = buf.indexOf('\n');
        if (i < 0) return; // auth 响应未完整
        if (!buf.slice(0, i).includes('auth.ok')) { clearTimeout(t); sock.destroy(); rej(new Error(`认证失败：${buf.slice(0, 80)}`)); return; }
        buf = buf.slice(i + 1); authed = true;
        sock.write(JSON.stringify({ protocolVersion: 1, commandId: id, method, params }) + '\n');
      }
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); i = buf.indexOf('\n');
        if (line.length === 0) continue;
        try {
          const r = JSON.parse(line);
          if (r.commandId === id) { clearTimeout(t); sock.destroy(); if (r.ok === true) res(r.data); else rej(new Error(`${method}: ${r.error?.message ?? '?'}`)); return; }
        } catch { /* */ }
      }
    });
  });
  const proj = (await call('project.open', { path: projDir, displayName: '通知验收项目' })).project;
  await call('app.settings.set', { key: 'ui.autoOpenProjectPath', value: projDir });
  const members = (await call('member.list', { projectId: proj.id })).items;
  const agent = members.find((m) => m.principalType === 'agent');
  // 房间任务（单 mention=DIRECT）→ 等线程就绪（room.pool 出现该任务线程）。
  const task = await call('message.submit', { target: { kind: 'room_root', projectId: proj.id, conversationId: `conv_default_${proj.id}`, roomId: `room_default_${proj.id}` }, body: '通知验收：房间任务', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }] });
  const deadline2 = Date.now() + 120_000;
  let threadId = null;
  while (Date.now() < deadline2 && threadId == null) {
    const pool = await call('room.pool', { roomId: `room_default_${proj.id}` });
    const hit = (pool.items ?? []).find((it) => it.taskId === task.taskId);
    if (hit != null) threadId = hit.threadId;
    else await sleep(1000);
  }
  if (threadId == null) throw new Error('房间任务线程未就绪');
  // 等任务 run 到终态再停机（第二十七轮一：此前 submit 后即 shutdown——outbox 派发意图未消费，
  // 应用侧留「待派发 1 项（重启遗留）」+「恢复待继续」横幅=验收噪音）。超时 60s 则如实告警继续
  // （提醒定时为验收主目标，不因 run 未收敛整体失败）。
  const TERMINAL = ['DONE', 'BLOCKED', 'FAILED', 'CANCELLED'];
  const deadline3 = Date.now() + 60_000;
  let taskSettled = false;
  while (Date.now() < deadline3) {
    const pool = await call('room.pool', { roomId: `room_default_${proj.id}` });
    const hit = (pool.items ?? []).find((it) => it.taskId === task.taskId);
    if (hit != null && TERMINAL.includes(hit.taskStatus)) { taskSettled = true; break; }
    await sleep(1000);
  }
  if (!taskSettled) console.warn('[seed] 警告：房间任务 60s 未到终态（恢复横幅可能出现）——继续安排提醒。');
  // 两条待确认提醒（once=+90s/+95s；autoDispatch 缺省=false——到点待确认=通知场景）。
  const fireBase = Date.now();
  const r1 = await call('reminder.schedule', { projectId: proj.id, conversationId: `conv_default_${proj.id}`, threadId, ownerMemberId: agent.id, title: '房间线程提醒：点击应定位任务线程', schedule: { kind: 'once', at: fireBase + 90_000 } });
  const conv = await call('conversation.create', { projectId: proj.id, peerMemberId: agent.id, title: '通知验收私信' });
  await call('reminder.schedule', { projectId: proj.id, conversationId: conv.conversationId, ownerMemberId: agent.id, title: '私信提醒：点击应定位私信会话', schedule: { kind: 'once', at: fireBase + 95_000 } });
  console.log(`[seed] 完成：房间线程提醒 ${r1.reminderId}（+90s）+ 私信提醒（+95s）——应用启动计时从现在起。`);
  await call('daemon.shutdown', {});
  // 停机事实如实核对（第二十七轮一）：等到进程退出并核对退出码；超时/非零=失败，不打印"已优雅停止"。
  const exited = await new Promise((res) => { const t = setTimeout(() => res(null), 30_000); child.once('exit', (code) => { clearTimeout(t); res(code); }); });
  const facts = {
    runId, at: new Date().toISOString(), buildId: (() => { try { return JSON.parse(readFileSync(join(pkgRoot, 'BUILD.json'), 'utf8')).buildId; } catch { return null; } })(),
    pipe: pipeName, appData: dataDir, projectDir: projDir,
    roomThread: threadId, fireBase, taskSettled,
    daemonExitCode: exited, daemonStopResult: (() => { try { return JSON.parse(stopResultTail); } catch { return null; } })(),
  };
  writeFileSync(join(pkgRoot, 'results', `seed-${runId}.txt`), `${JSON.stringify(facts, null, 2)}\ndaemon-stderr-tail=${err.slice(-500)}\n`, 'utf8');
  writeFileSync(join(pkgRoot, 'results', 'seed-latest.txt'), `${runId}\n`, 'utf8');
  if (exited === 0) {
    console.log(`[seed] daemon 已优雅停止（exit=0，stop-result=${stopResultTail || '无尾行'}）——可启动应用。`);
    process.exit(0);
  }
  if (exited == null) {
    console.error(`[seed] daemon.shutdown 后 30s 未退出（停机超时）——强制结束；stop-result=${stopResultTail || '无'}；stderr尾=${err.slice(-200)}`);
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
    process.exit(1);
  }
  console.error(`[seed] daemon 退出码 ${exited}（非优雅）——stop-result=${stopResultTail || '无'}；stderr尾=${err.slice(-200)}`);
  process.exit(1);
} catch (e) {
  console.error(`[seed] 失败：${e instanceof Error ? e.message : String(e)}`);
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
  process.exit(1);
}
