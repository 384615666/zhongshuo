/**
 * 通知人工验收——合成数据种子（第二十六轮二）：经**正式 daemon 管道**造数（不直写库）。
 * 由「启动通知验收.cmd」以包内 node 运行：起 daemon（fake+guard+独立 appData+固定管道）→
 * project.open（合成项目）→ app.settings.set（ui.autoOpenProjectPath——UI 首启自动恢复）→
 * 房间任务（DIRECT 单成员→REVIEW 线程）→ 房间线程提醒 + DM 提醒（once=+90s/+95s，不自动执行）
 * → daemon.shutdown（优雅）→ 退出。幂等：合成项目目录存在即复用；提醒按固定标题去重。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const root = import.meta.dirname; // 产物目录（通知人工验收/验证结果/ 的上级=包根由调用方布局）——实际按相对定位：
const pkgRoot = join(import.meta.dirname, '..'); // 应用/
const appHome = join(pkgRoot, '应用');
const dataDir = join(pkgRoot, '应用数据');
const projDir = join(pkgRoot, '合成项目');
const nodeExe = join(appHome, 'resources', 'app', 'daemon', 'node', 'node.exe');
const daemonCjs = join(appHome, 'resources', 'app', 'daemon', 'daemon.cjs');
const pipeName = 'zs-notify-acceptance';
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
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => { err += c; });
try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`daemon 启动即退出：${err.slice(-300)}`);
    if (err.includes('listening')) break;
    await sleep(150);
  }
  const token = readFileSync(join(dataDir, 'local.token'), 'utf8').trim();
  const call = (method, params) => new Promise((res, rej) => {
    const sock = net.connect(`\\\\.\\pipe\\${pipeName}`);
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
  // 两条待确认提醒（once=+90s/+95s；autoDispatch 缺省=false——到点待确认=通知场景）。
  const fireBase = Date.now();
  const r1 = await call('reminder.schedule', { projectId: proj.id, conversationId: `conv_default_${proj.id}`, threadId, ownerMemberId: agent.id, title: '房间线程提醒：点击应定位任务线程', schedule: { kind: 'once', at: fireBase + 90_000 } });
  const conv = await call('conversation.create', { projectId: proj.id, peerMemberId: agent.id, title: '通知验收私信' });
  await call('reminder.schedule', { projectId: proj.id, conversationId: conv.conversationId, ownerMemberId: agent.id, title: '私信提醒：点击应定位私信会话', schedule: { kind: 'once', at: fireBase + 95_000 } });
  console.log(`[seed] 完成：房间线程提醒 ${r1.reminderId}（+90s）+ 私信提醒（+95s）——应用启动计时从现在起。`);
  await call('daemon.shutdown', {});
  await new Promise((res) => { const t = setTimeout(res, 30_000); child.once('exit', () => { clearTimeout(t); res(); }); });
  console.log('[seed] daemon 已优雅停止——可启动应用。');
  writeFileSync(join(pkgRoot, '验证结果', 'seed-ok.txt'), `seed at ${new Date().toISOString()}\nroomThread=${threadId}\nfireBase=${fireBase}\n`, 'utf8');
  process.exit(0);
} catch (e) {
  console.error(`[seed] 失败：${e instanceof Error ? e.message : String(e)}`);
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
  process.exit(1);
}
