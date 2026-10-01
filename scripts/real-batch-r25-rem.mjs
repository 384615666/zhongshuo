/**
 * 第二十五轮五：最小真实提醒批次 r25-rem（deepseek-flash 经 Claude CLI 渠道；持续授权内）。
 * 目标（用户明确的新真实认证目标）：
 * - system 来源提醒经正式链**自动触发**执行一次（autoDispatch=true）；
 * - 到点**待确认**→用户确认（reminder.confirm）执行一次（autoDispatch=false）。
 * 上限与停止条件：ZS_REAL_BATCH_ID=r25-rem、ZS_REAL_BATCH_CAP=4（机械硬上限；预期恰 2 次
 * startTurn——任何超发即护栏拒绝=停批）。身份/协议/预算问题即停批修复。
 * 核对：owner=对端成员、目标会话归属、模板输入（DEV-21-M3 字段）、实际模型与响应自报、
 * 调用台账（reminder_calls 恰 2 行且终态）、结果回复落目标会话。
 * 证据：real_calls 行级明细+identities+停机事实——清理前写入
 * docs/implementation/real-batches/r25-rem-ledger-{mode}.json（不重复 r20-dm、不清旧账）。
 * 演练：ZS_R25_REHEARSAL=1（fake，零真实调用——验证脚本自身）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const repoRoot = import.meta.dirname.replace(/\\scripts$/, '');
const appHome = join(repoRoot, 'dist', 'desktop', '众说-便携-win-x64');
const daemonDir = join(appHome, 'resources', 'app', 'daemon');
const nodeExe = join(daemonDir, 'node', 'node.exe');
const daemonCjs = join(daemonDir, 'daemon.cjs');
const runRoot = join(tmpdir(), `zs-r25rem-${randomUUID().slice(0, 6)}`);
const appData = join(runRoot, 'appdata');
const fixture = join(runRoot, 'proj');
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, 'notes.md'), '# 提醒批次项目\n\n暗号：R25-REM-4128\n', 'utf8');

const BATCH = 'r25-rem';
process.env.ZS_REAL_BATCH_CAP = '4';
const REHEARSAL = process.env.ZS_R25_REHEARSAL === '1';
const MODE = REHEARSAL ? 'rehearsal' : 'real';
let buildId = null;
try { buildId = JSON.parse(readFileSync(join(appHome, 'BUILD.json'), 'utf8')).buildId ?? null; } catch { /* 如实 null */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`);
  if (!ok) throw new BatchStepFailed(name);
};
class BatchStepFailed extends Error { constructor(name) { super(`批次步骤失败即停：${name}`); this.name = 'BatchStepFailed'; } }

const daemons = [];
function startDaemon(pipeName) {
  const child = spawn(nodeExe, [daemonCjs], {
    cwd: appHome,
    env: {
      ...process.env, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1',
      ZS_RUNTIME: REHEARSAL ? 'fake' : 'claude',
      ...(REHEARSAL ? { ZS_ALLOW_FAKE: '1' } : { ZS_CLAUDE_MODEL: 'deepseek-flash' }),
      ZS_APP_DATA: appData, ZS_PIPE_NAME: pipeName,
      ZS_REAL_BATCH_ID: BATCH, ZS_REAL_BATCH_CAP: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  const entry = { seq: daemons.length + 1, pipeName, child, err: () => err, exit: null };
  child.once('exit', (code, signal) => { entry.exit = { code: code ?? null, signal: signal ?? null, at: Date.now() }; });
  daemons.push(entry);
  return entry;
}
async function stopDaemonFormally(entry, gracefulMs = 30_000) {
  const facts = { seq: entry.seq, requested: false, exit: entry.exit, killed: false, unconfirmed: false };
  if (entry.exit != null) return facts;
  try {
    const token = readFileSync(join(appData, 'local.token'), 'utf8').trim();
    await new Promise((res, rej) => {
      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; clearTimeout(t); fn(arg); } };
      const sock = net.connect(`\\\\.\\pipe\\${entry.pipeName}`);
      sock.setEncoding('utf8');
      const t = setTimeout(() => { sock.destroy(); settle(rej, new Error('shutdown 送达超时')); }, 8_000);
      sock.on('connect', () => { sock.write(`${JSON.stringify({ type: 'auth', token })}\n`); });
      sock.on('data', (c) => {
        if (String(c).includes('auth.ok')) {
          sock.write(`${JSON.stringify({ protocolVersion: 1, commandId: `r25-stop-${entry.seq}`, method: 'daemon.shutdown', params: {} })}\n`);
          facts.requested = true;
          setTimeout(() => { sock.destroy(); settle(res); }, 500);
        }
      });
      sock.on('error', (e) => settle(rej, e));
      sock.on('close', () => settle(res));
    });
  } catch { /* 兜底路径处理 */ }
  const exited = await new Promise((res) => {
    if (entry.exit != null) return res(true);
    const t = setTimeout(() => res(false), gracefulMs);
    entry.child.once('exit', () => { clearTimeout(t); res(true); });
  });
  if (exited && entry.exit != null) return facts;
  facts.killed = true;
  try { spawnSync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力 */ }
  const exited2 = await new Promise((res) => {
    if (entry.exit != null) return res(true);
    const t = setTimeout(() => res(false), 10_000);
    entry.child.once('exit', () => { clearTimeout(t); res(true); });
  });
  if (!exited2 || entry.exit == null) facts.unconfirmed = true;
  return facts;
}
async function waitListening(d, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (d.child.exitCode != null) throw new Error(`daemon 启动即退出（code=${d.child.exitCode}）：${d.err().split('\n').filter(Boolean).slice(-2).join(' | ')}`);
    if (d.err().includes('listening')) return;
    await sleep(200);
  }
  throw new Error('daemon 等待 listening 超时');
}
function ipcCall(pipeName) {
  return new Promise((res, rej) => {
    const token = readFileSync(join(appData, 'local.token'), 'utf8').trim();
    const sock = net.connect(`\\\\.\\pipe\\${pipeName}`);
    sock.setEncoding('utf8');
    let buf = ''; let seq = 0; const pending = new Map(); const connTag = randomUUID().slice(0, 6);
    const timer = setTimeout(() => rej(new Error('IPC 连接超时')), 15_000);
    sock.on('connect', () => { clearTimeout(timer); sock.write(JSON.stringify({ type: 'auth', token }) + '\n'); res({
      call(method, params, timeoutMs = 240_000) {
        return new Promise((res2, rej2) => {
          const id = `r25-${connTag}-${seq++}`;
          const t = setTimeout(() => { pending.delete(id); rej2(new Error(`IPC 超时 ${method}`)); }, timeoutMs);
          pending.set(id, (r) => { clearTimeout(t); if (r.ok !== true) rej2(new Error(`${method}:${r.error?.message ?? '?'}`)); else res2(r.data); });
          sock.write(JSON.stringify({ protocolVersion: 1, commandId: id, method, params }) + '\n');
        });
      },
      end: () => sock.end(),
    }); });
    sock.on('error', (e) => { clearTimeout(timer); rej(e); });
    sock.on('data', (c) => { buf += c; let i = buf.indexOf('\n'); while (i >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); i = buf.indexOf('\n'); if (line.length === 0) continue; try { const r = JSON.parse(line); if (r.commandId != null && pending.has(r.commandId)) { pending.get(r.commandId)(r); pending.delete(r.commandId); } } catch { /* */ } } });
  });
}
async function waitTaskDone(call, taskId, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '?';
  while (Date.now() < deadline) {
    const t = await call('task.get', { taskId });
    last = t.task.status;
    if (['DONE', 'BLOCKED', 'FAILED', 'CANCELLED', 'REVIEW'].includes(last)) return last;
    await sleep(2000);
  }
  throw new Error(`任务 ${taskId} 未终态（last=${last}）`);
}
async function dmAgentReplies(call, conversationId, limit = 20) {
  const hist = await call('conversation.history', { conversationId, limit });
  const messages = hist.messages ?? [];
  const agentMsgs = messages.filter((m) => m.author_type === 'agent');
  const text = agentMsgs.map((m) => { try { return JSON.parse(m.body_json).text ?? ''; } catch { return ''; } }).join('');
  return { text, agentMessages: agentMsgs.length };
}
async function dbOpen() {
  const { pathToFileURL } = await import('node:url');
  const { openDatabase } = await import(pathToFileURL(join(repoRoot, 'src', 'persistence', 'db.ts')).href);
  return openDatabase(join(appData, 'state.sqlite'));
}

try {
  const d1 = startDaemon('zs-r25rem-1');
  await waitListening(d1);
  const c = await ipcCall('zs-r25rem-1');
  const projId = (await c.call('project.open', { path: fixture })).project.id;
  const list = await c.call('member.list', { projectId: projId });
  const agent = list.items.find((m) => m.principalType === 'agent');
  if (agent == null) throw new Error('无 agent 成员');
  const conv = await c.call('conversation.create', { projectId: projId, peerMemberId: agent.id, title: '提醒批次会话' });

  // ---- ① 自动触发（autoDispatch=true，once +25s；调度 tick 15s 粒度）----
  const fireAt1 = Date.now() + 25_000;
  const rem1 = await c.call('reminder.schedule', { projectId: projId, conversationId: conv.conversationId, ownerMemberId: agent.id, title: '自动提醒：报暗号', sourceRef: 'r25-rem:auto', schedule: { kind: 'once', at: fireAt1 }, budgetLimit: { sum: 1 }, autoDispatch: true });
  record('① 提醒已建（获准自动派发）', rem1.reminderId != null && rem1.nextAt === fireAt1, `nextAt=${rem1.nextAt === fireAt1 ? fireAt1 : rem1.nextAt}`);
  let occ1 = null;
  for (let i = 0; i < 60 && occ1 == null; i += 1) {
    await sleep(2000);
    const db = await dbOpen();
    occ1 = db.prepare('SELECT scheduled_at, outcome, task_id FROM reminder_occurrences WHERE reminder_id = ?').get(rem1.reminderId) ?? null;
    db.close();
  }
  record('① 到点自动触发（occurrence dispatched + 任务已建）', occ1 != null && occ1.outcome === 'dispatched' && occ1.task_id != null, `outcome=${occ1?.outcome}`);
  const st1 = await waitTaskDone((m, p) => c.call(m, p), occ1.task_id);
  record('① 自动触发执行到达终态', ['DONE', 'REVIEW'].includes(st1), `status=${st1}`);
  {
    const db = await dbOpen();
    // owner/目标/模板输入/来源核对。
    const task = db.prepare('SELECT owner_member_id, conversation_id, kind FROM tasks WHERE id = ?').get(occ1.task_id);
    const root = db.prepare('SELECT author_type, author_id, body_json FROM messages WHERE task_id = ?').get(occ1.task_id);
    const rootBody = root != null ? String((JSON.parse(root.body_json) ?? {}).text ?? '') : '';
    const templateOk = rootBody.includes('【提醒触发】自动提醒：报暗号') && rootBody.includes(`occurrence：${rem1.reminderId}@`) && rootBody.includes('来源：r25-rem:auto') && rootBody.includes('不要自行安排后续循环');
    record('① 正式链核对：owner=对端+任务落目标会话+system 来源+模板输入（DEV-21-M3 字段）',
      task.owner_member_id === agent.id && task.conversation_id === conv.conversationId && task.kind === 'dm_turn' && root.author_type === 'system' && root.author_id === `reminder:${rem1.reminderId}` && templateOk,
      `owner=${task.owner_member_id === agent.id} conv=${task.conversation_id === conv.conversationId} tpl=${templateOk}`);
    const call1 = db.prepare('SELECT status FROM reminder_calls WHERE reminder_id = ?').get(rem1.reminderId);
    record('① 调用台账（一行且随终态结算）', call1 != null && ['settled', 'failed', 'inflight'].includes(call1.status), `status=${call1?.status}`);
    db.close();
  }
  const r1 = await dmAgentReplies(c.call, conv.conversationId);
  record('① 结果归属：回复落目标会话（agent 作者+非空）', r1.agentMessages >= 1 && r1.text.length > 0, `agentMsgs=${r1.agentMessages} len=${r1.text.length}`);
  if (!REHEARSAL) record('① 真实模式辅助：暗号回流', r1.text.includes('R25-REM-4128'), `含暗号=${r1.text.includes('R25-REM-4128')}`);

  // ---- ② 待确认→用户确认（autoDispatch=false，once +25s）----
  const fireAt2 = Date.now() + 25_000;
  const rem2 = await c.call('reminder.schedule', { projectId: projId, conversationId: conv.conversationId, ownerMemberId: agent.id, title: '确认提醒：再说一次暗号', schedule: { kind: 'once', at: fireAt2 }, budgetLimit: { sum: 1 } });
  let occ2 = null;
  for (let i = 0; i < 60 && occ2 == null; i += 1) {
    await sleep(2000);
    const db = await dbOpen();
    occ2 = db.prepare("SELECT scheduled_at, outcome FROM reminder_occurrences WHERE reminder_id = ?").get(rem2.reminderId) ?? null;
    db.close();
  }
  record('② 到点进入待确认（awaiting_confirmation，未执行）', occ2 != null && occ2.outcome === 'awaiting_confirmation', `outcome=${occ2?.outcome}`);
  const pending = await c.call('mine.pending', {});
  const entryVisible = (pending.projects ?? []).some((p) => (p.reminderAwaits ?? []).some((w) => w.reminder_id === rem2.reminderId));
  record('② 待我处理列出待确认入口', entryVisible, '');
  const confirmed = await c.call('reminder.confirm', { reminderId: rem2.reminderId, scheduledAt: occ2.scheduled_at });
  record('② 用户确认→正式派发（taskId 返回）', confirmed.taskId != null, `taskId=${String(confirmed.taskId).slice(0, 14)}`);
  const st2 = await waitTaskDone((m, p) => c.call(m, p), confirmed.taskId);
  record('② 确认后执行到达终态', ['DONE', 'REVIEW'].includes(st2), `status=${st2}`);
  const r2 = await dmAgentReplies(c.call, conv.conversationId);
  record('② 结果归属：回复仍落目标会话', r2.agentMessages >= 2, `agentMsgs=${r2.agentMessages}`);
  if (!REHEARSAL) record('② 真实模式辅助：暗号再次回流', r2.text.includes('R25-REM-4128'), '');

  // ---- 台账与停机 ----
  await c.call('daemon.shutdown', {});
  c.end();
  const ex1 = await new Promise((r) => { const t = setTimeout(() => r(null), 30_000); d1.child.once('exit', (code) => { clearTimeout(t); r(code); }); });
  record('daemon 优雅退出（exit 0）', ex1 === 0, `exit=${ex1}`);

  const db = await dbOpen();
  const calls = db.prepare('SELECT count(*) c, sum(case when status=\'succeeded\' then 1 else 0 end) s FROM real_calls WHERE batch_id = ?').get(BATCH);
  const expectedCalls = REHEARSAL ? 0 : 2;
  record('护栏核对：实际调用恰 2（机械 cap=4 未触）', calls.c === expectedCalls && (REHEARSAL || calls.s === 2), `calls=${calls.c} succeeded=${calls.s}`);
  const callsDetail = db.prepare('SELECT turn_id, status, model AS request_model, response_model, usage_json, run_id FROM real_calls WHERE batch_id = ?').all(BATCH);
  if (!REHEARSAL) {
    record('模型核对：请求与响应自报一致（deepseek-flash）', callsDetail.length === 2 && callsDetail.every((x) => (x.request_model ?? '') === 'deepseek-flash' && (x.response_model ?? '') === 'deepseek-flash'),
      JSON.stringify(callsDetail.map((x) => `${x.request_model}/${x.response_model}`)));
  }
  const remCalls = db.prepare('SELECT reminder_id, status, turn_id FROM reminder_calls').all();
  record('提醒调用台账：两提醒各恰一行（终态）', remCalls.length === 2 && remCalls.every((x) => x.turn_id != null && ['settled', 'failed'].includes(x.status)), JSON.stringify(remCalls.map((x) => x.status)));
  db.close();
} catch (error) {
  console.error(`[r25-rem] 失败即停：${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  let dbCalls = null; let callsDetail = null; let identities = null; let remCalls = null;
  try {
    const dbF = await dbOpen();
    dbCalls = dbF.prepare('SELECT count(*) c FROM real_calls WHERE batch_id = ?').get(BATCH);
    callsDetail = dbF.prepare('SELECT turn_id, status, model AS request_model, response_model, usage_json, run_id FROM real_calls WHERE batch_id = ?').all(BATCH);
    identities = dbF.prepare("SELECT conversation_id, provider_session_id, session_generation FROM runtime_sessions WHERE scope_kind='dm' ORDER BY rowid").all();
    remCalls = dbF.prepare('SELECT reminder_id, task_id, turn_id, dispatch_tag, status, created_at, updated_at FROM reminder_calls').all();
    dbF.close();
  } catch { /* 库不可读——明细如实缺省 */ }
  const stopFacts = [];
  for (const entry of daemons) {
    if (entry.exit != null) { stopFacts.push({ seq: entry.seq, exit: entry.exit }); continue; }
    try { stopFacts.push(await stopDaemonFormally(entry)); } catch (error) {
      stopFacts.push({ seq: entry.seq, error: String(error instanceof Error ? error.message : error).slice(0, 120) });
    }
  }
  const cleanupUnclean = stopFacts.some((f) => f.killed === true || f.unconfirmed === true);
  const ledgerPath = join(repoRoot, 'docs', 'implementation', 'real-batches', `r25-rem-ledger-${MODE}.json`);
  try {
    writeFileSync(ledgerPath, JSON.stringify({
      batch: BATCH, mode: MODE, at: new Date().toISOString(), buildId,
      results, cap: 4, expectedCalls: REHEARSAL ? 0 : 2,
      actualCalls: dbCalls != null ? dbCalls.c : null, callsDetail, identities, reminderCalls: remCalls,
      daemonStopFacts: stopFacts, cleanupUnclean,
      stderrTails: daemons.map((d) => ({ seq: d.seq, tail: d.err().split('\n').filter(Boolean).slice(-6) })),
    }, null, 2));
    console.log(`[r25-rem] 台账已归档：${ledgerPath}`);
  } catch (e) { console.error(`台账写入失败：${e instanceof Error ? e.message : String(e)}`); }
  if (!cleanupUnclean) { try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* Windows 句柄延迟——保留现场亦可 */ } }
  else console.log('[r25-rem] 收拢不干净——保留现场目录待核对');
}
