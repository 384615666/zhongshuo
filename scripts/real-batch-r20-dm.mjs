/**
 * 第二十轮三：最小真实 DM 批次（deepseek-flash 经 Claude CLI 渠道；持续授权内）。
 * 目标：验证 DM 链真实执行 + 同对话原生续接（--resume 请求与 provider 上报身份一致）+
 * 同成员第二会话独立 + daemon 重启后沿持久身份续接。
 * 上限与停止条件：ZS_REAL_BATCH_ID=r20-dm、ZS_REAL_BATCH_CAP=8（硬上限；预期 4 次
 * startTurn：A1/A2/B1/A3——任何超发即护栏拒绝=停批）。身份/协议/预算问题出现即停批修复。
 * 证据标准：provider 身份（runtime_sessions.provider_session_id 非空）+ dm.sessionResumed
 * 事件（resume 请求=上报）+ real_calls 计数；模型回忆暗号仅辅助。
 *
 * 第二十二轮四收口：
 * - spawn child 全程保存+退出事实——finally 先正式停止（daemon.shutdown→有界等待 exit→
 *   核实），pid 文件缺失不再当作已退出；强杀/未确认进最终报告（清理失败不称全部通过）；
 * - 演练与真实同款断言（回复非空+agent 作者+会话归属——不再 rehearsal|| 直接放行）；
 *   暗号回流仅真实模式辅助断言；
 * - B 独立性=身份不同 + 输入水位归属（input_through_seq 属 B 会话消息序）+ 回复落库归属；
 * - 报告分列：r20-dm-ledger-{mode}.json（mode/buildId/实际调用数/证据路径）；
 * - ZS_R20_CRASH_AT=a2mid 崩溃注入（演练专用）：A2 在途强杀 daemon→脚本即停+正式收拢链验证。
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
const runRoot = join(tmpdir(), `zs-r20dm-${randomUUID().slice(0, 6)}`);
const appData = join(runRoot, 'appdata');
const fixture = join(runRoot, 'proj');
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, 'notes.md'), '# 批次项目\n\n暗号：R20-DM-7735\n', 'utf8');

const BATCH = 'r20-dm';
process.env.ZS_REAL_BATCH_CAP = '8';
const REHEARSAL = process.env.ZS_R20_REHEARSAL === '1';
const MODE = REHEARSAL ? 'rehearsal' : 'real';
const CRASH_AT = process.env.ZS_R20_CRASH_AT ?? '';
if (CRASH_AT !== '' && !REHEARSAL) { console.error('ZS_R20_CRASH_AT 仅限演练模式（ZS_R20_REHEARSAL=1）'); process.exit(2); }
let buildId = null;
try { buildId = JSON.parse(readFileSync(join(appHome, 'BUILD.json'), 'utf8')).buildId ?? null; } catch { /* 如实 null */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`);
  if (!ok) throw new BatchStepFailed(name); // 即停：失败不继续后续调用（catch 收拢+留现场）
};
class BatchStepFailed extends Error { constructor(name) { super(`批次步骤失败即停：${name}`); this.name = 'BatchStepFailed'; } }

// 本批 spawn 的 daemon 全程登记（child 引用+退出事实）——finally 收拢以此为准，不依赖
// daemon.pid 文件（正常退出会删除；缺失≠进程已退出）。
const daemons = [];
let daemonSeq = 0;
function startDaemon(pipeName) {
  daemonSeq += 1;
  const child = spawn(nodeExe, [daemonCjs], {
    cwd: appHome,
    env: {
      ...process.env, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1',
      ZS_RUNTIME: REHEARSAL ? 'fake' : 'claude',
      ...(REHEARSAL ? { ZS_ALLOW_FAKE: '1' } : { ZS_CLAUDE_MODEL: 'deepseek-flash' }),
      ZS_APP_DATA: appData, ZS_PIPE_NAME: pipeName,
      ZS_REAL_BATCH_ID: BATCH, ZS_REAL_BATCH_CAP: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  const entry = { seq: daemonSeq, pipeName, child, err: () => err, exit: null };
  child.once('exit', (code, signal) => { entry.exit = { code: code ?? null, signal: signal ?? null, at: Date.now() }; });
  daemons.push(entry);
  return entry;
}
/** 正式停止一个 daemon：daemon.shutdown → 有界等待 exit；超时 taskkill /T /F 兜底 →
 * 再等 10s；仍无事件=unconfirmed（如实，不冒充退出）。返回结构化事实入报告。 */
async function stopDaemonFormally(entry, gracefulMs = 30_000) {
  const facts = { seq: entry.seq, requested: false, exit: entry.exit, killed: false, unconfirmed: false };
  if (entry.exit != null) return facts; // 已退出（正常路径）
  try {
    const token = readFileSync(join(appData, 'local.token'), 'utf8').trim();
    await new Promise((res, rej) => {
      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; clearTimeout(t); fn(arg); } };
      const sock = net.connect(`\\\\.\\pipe\\${entry.pipeName}`);
      sock.setEncoding('utf8');
      // 超时覆盖送达全程（连接+认证+发出）——connect 即清会把挂死留给外层 await。
      const t = setTimeout(() => { sock.destroy(); settle(rej, new Error('shutdown 送达超时（连接/认证/发出）')); }, 8_000);
      sock.on('connect', () => { sock.write(`${JSON.stringify({ type: 'auth', token })}\n`); });
      sock.on('data', (c) => {
        if (String(c).includes('auth.ok')) {
          sock.write(`${JSON.stringify({ protocolVersion: 1, commandId: `r20-stop-${entry.seq}`, method: 'daemon.shutdown', params: {} })}\n`);
          facts.requested = true;
          setTimeout(() => { sock.destroy(); settle(res); }, 500);
        }
      });
      sock.on('error', (e) => settle(rej, e));
      sock.on('close', () => settle(res)); // 送达后 daemon 关闭连接/认证失败被断开——流程继续（requested 反映是否发出）
    });
  } catch { /* 正式停止送达失败（进程可能已死/管道断）——兜底路径处理 */ }
  const exited = await new Promise((res) => {
    if (entry.exit != null) return res(true);
    const t = setTimeout(() => res(false), gracefulMs);
    entry.child.once('exit', () => { clearTimeout(t); res(true); });
  });
  if (exited && entry.exit != null) return facts;
  // 兜底强杀（非优雅——如实标记，仅现场收束）。
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
    let buf = ''; let seq = 0; const pending = new Map(); const connTag = randomUUID().slice(0, 6); // 每连接唯一前缀——重启后不与持久回执冲突
    const timer = setTimeout(() => rej(new Error('IPC 连接超时')), 15_000);
    sock.on('connect', () => { clearTimeout(timer); sock.write(JSON.stringify({ type: 'auth', token }) + '\n'); res({
      call(method, params, timeoutMs = 240_000) {
        return new Promise((res2, rej2) => {
          const id = `r20-${connTag}-${seq++}`;
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
async function waitTaskDone(call, taskId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '?';
  while (Date.now() < deadline) {
    const t = await call('task.get', { taskId });
    last = t.task.status;
    if (['DONE', 'BLOCKED', 'FAILED', 'CANCELLED', 'REVIEW'].includes(last)) return last;
    await sleep(1500);
  }
  throw new Error(`任务 ${taskId} 未终态（last=${last}）`);
}
/** 会话回复（agent 作者）+归属核对：返回 { text, agentMessages, allInConversation }。 */
async function dmAgentReplies(callObj, conversationId, limit = 20) {
  const hist = await callObj.call('conversation.history', { conversationId, limit });
  const messages = hist.messages ?? [];
  const agentMsgs = messages.filter((m) => m.author_type === 'agent');
  const text = agentMsgs.map((m) => { try { return JSON.parse(m.body_json).text ?? ''; } catch { return ''; } }).join('');
  const allInConversation = messages.every((m) => m.conversation_id === undefined || m.conversation_id === conversationId); // 字段缺省=由查询语义保证归属
  return { text, agentMessages: agentMsgs.length, allInConversation };
}

let stop = false;
try {
  const d1 = startDaemon('zs-r20dm-1');
  await waitListening(d1);
  const c = await ipcCall('zs-r20dm-1');
  const projId = (await c.call('project.open', { path: fixture })).project.id;
  const list = await c.call('member.list', { projectId: projId });
  const agent = list.items.find((m) => m.principalType === 'agent');
  if (agent == null) throw new Error('无 agent 成员');
  // A1：会话 A 首轮（首开——provider ID 由 init 回填）。
  const convA = await c.call('conversation.create', { projectId: projId, peerMemberId: agent.id, title: '批次会话A' });
  const a1 = await c.call('message.submit', { target: { kind: 'dm', projectId: projId, conversationId: convA.conversationId }, body: '请读取 notes.md 并在回复中报出其中的暗号原文（格式：暗号=…）。这是一对一会话的第一轮。', intent: 'default', mentions: [] });
  const st1 = await waitTaskDone((m, p) => c.call(m, p), a1.taskId);
  record('A1 首轮执行（DONE/REVIEW）', ['DONE', 'REVIEW'].includes(st1), `status=${st1}`);
  // 回复到达+归属（演练/真实同款——不再 rehearsal|| 放行）。
  const r1 = await dmAgentReplies(c, convA.conversationId);
  record('A1 回复到达且归属正确（agent 作者+全部落会话 A+非空）', r1.agentMessages >= 1 && r1.allInConversation && r1.text.length > 0, `agentMsgs=${r1.agentMessages} len=${r1.text.length}`);
  if (!REHEARSAL) {
    record('A1 暗号回流（真实模式辅助证据）', r1.text.includes('R20-DM-7735'), `含暗号=${r1.text.includes('R20-DM-7735')}`);
  }
  // 逐步核对①（A1 后）：首开会话行已建立、provider 身份非空（后续步骤的前置）。
  {
    const { pathToFileURL } = await import('node:url');
    const { openDatabase } = await import(pathToFileURL(join(repoRoot, 'src', 'persistence', 'db.ts')).href);
    const db = openDatabase(join(appData, 'state.sqlite'));
    const row = db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").get(convA.conversationId);
    record('A1 后核对：会话身份已持久（非空）', row != null && String(row.provider_session_id ?? '').length > 0, `id=${String(row?.provider_session_id ?? '').slice(0, 18)}`);
    db.close();
  }
  // A2：同会话第二轮——应原生续接。
  const a2 = await c.call('message.submit', { target: { kind: 'dm', projectId: projId, conversationId: convA.conversationId }, body: '第二轮：只回复第一轮你看到的暗号原文（不要重新读文件）。', intent: 'default', mentions: [] });
  if (CRASH_AT === 'a2mid') {
    // 崩溃注入（演练专用）：A2 在途强杀 daemon——IPC 断开/任务悬挂→脚本应即停+正式收拢。
    await sleep(1_500);
    spawnSync('taskkill', ['/PID', String(d1.child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(500);
    let sawFailure = false;
    try { await waitTaskDone((m, p) => c.call(m, p), a2.taskId, 15_000); } catch { sawFailure = true; }
    record('崩溃注入（a2 在途强杀）：后续命令失败/超时被察觉（脚本即停）', sawFailure, `sawFailure=${sawFailure}`);
    throw new BatchStepFailed('crash-inject-a2mid（预期失败路径——验证即停与收拢）');
  }
  const st2 = await waitTaskDone((m, p) => c.call(m, p), a2.taskId);
  record('A2 同会话第二轮执行', ['DONE', 'REVIEW'].includes(st2), `status=${st2}`);
  const r2 = await dmAgentReplies(c, convA.conversationId);
  record('A2 回复到达且归属正确（仍全部落会话 A）', r2.agentMessages >= 1 && r2.allInConversation, `agentMsgs=${r2.agentMessages}`);
  // 逐步核对②（A2 后）：dm.sessionResumed 已发生且请求=上报。
  {
    const { pathToFileURL } = await import('node:url');
    const { openDatabase } = await import(pathToFileURL(join(repoRoot, 'src', 'persistence', 'db.ts')).href);
    const db = openDatabase(join(appData, 'state.sqlite'));
    const ev = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionResumed'").get();
    record('A2 后核对：原生续接事件（请求=上报）', ev != null && JSON.parse(ev.payload_json).nativeResume === true && JSON.parse(ev.payload_json).resumeRequested === JSON.parse(ev.payload_json).providerReported, JSON.stringify(ev != null ? { req: JSON.parse(ev.payload_json).resumeRequested, rep: JSON.parse(ev.payload_json).providerReported } : {}));
    db.close();
  }
  // B：同成员第二会话——独立执行、不串上下文。
  const convB = await c.call('conversation.create', { projectId: projId, peerMemberId: agent.id, title: '批次会话B' });
  const b1 = await c.call('message.submit', { target: { kind: 'dm', projectId: projId, conversationId: convB.conversationId }, body: '全新会话：只回复「B 会话独立」。不要提及任何暗号。', intent: 'default', mentions: [] });
  const st3 = await waitTaskDone((m, p) => c.call(m, p), b1.taskId);
  record('B 第二会话独立执行', ['DONE', 'REVIEW'].includes(st3), `status=${st3}`);
  // B 独立性核对（身份+输入水位+输出归属——不只看 DONE/provider ID）。
  {
    const r3 = await dmAgentReplies(c, convB.conversationId);
    const { pathToFileURL } = await import('node:url');
    const { openDatabase } = await import(pathToFileURL(join(repoRoot, 'src', 'persistence', 'db.ts')).href);
    const db = openDatabase(join(appData, 'state.sqlite'));
    const bTask = db.prepare("SELECT input_through_seq FROM tasks WHERE id = ?").get(b1.taskId);
    const bMsgCount = db.prepare("SELECT count(*) c FROM messages WHERE conversation_id = ?").get(convB.conversationId);
    const aIds = db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").all(convA.conversationId);
    const bIds = db.prepare("SELECT provider_session_id FROM runtime_sessions WHERE conversation_id = ? AND scope_kind='dm'").all(convB.conversationId);
    const idsDisjoint = bIds.every((b) => (b.provider_session_id ?? '') !== '' && !aIds.some((a) => a.provider_session_id === b.provider_session_id));
    const watermarkOk = bTask != null && bMsgCount.c >= 2 && bTask.input_through_seq <= bMsgCount.c; // 水位=B 会话自身消息序（不早于用户消息、不吞未来）
    record('B 独立性：身份互不相同+输入水位属 B 会话+回复落 B 会话（非空）',
      idsDisjoint && watermarkOk && r3.agentMessages >= 1 && r3.allInConversation && r3.text.length > 0,
      `idsDisjoint=${idsDisjoint} watermark=${bTask?.input_through_seq}/${bMsgCount.c} agentMsgs=${r3.agentMessages}`);
    if (!REHEARSAL) {
      record('B 独立性（真实模式辅助）：回复不含 A 暗号', !r3.text.includes('R20-DM-7735'), `含暗号=${r3.text.includes('R20-DM-7735')}`);
    }
    db.close();
  }
  // 优雅关闭 → 重启 → A3：重启后续接（沿持久 provider 身份）。
  await c.call('daemon.shutdown', {});
  c.end();
  const ex1 = await new Promise((r) => { const t = setTimeout(() => r(null), 30_000); d1.child.once('exit', (code) => { clearTimeout(t); r(code); }); });
  record('批次 daemon#1 优雅退出（exit 0）', ex1 === 0, `exit=${ex1}`);
  const d2 = startDaemon('zs-r20dm-2');
  await waitListening(d2);
  const c2 = await ipcCall('zs-r20dm-2');
  const a3 = await c2.call('message.submit', { target: { kind: 'dm', projectId: projId, conversationId: convA.conversationId }, body: '重启后第三轮：只回复你最早看到的暗号原文（不要读文件）。', intent: 'default', mentions: [] });
  const st4 = await waitTaskDone((m, p) => c2.call(m, p), a3.taskId);
  record('A3 重启后执行', ['DONE', 'REVIEW'].includes(st4), `status=${st4}`);
  await c2.call('daemon.shutdown', {});
  c2.end();
  const ex2 = await new Promise((r) => { const t = setTimeout(() => r(null), 30_000); d2.child.once('exit', (code) => { clearTimeout(t); r(code); }); });
  record('批次 daemon#2 优雅退出', ex2 === 0, `exit=${ex2}`);
  await sleep(800);
  // ---- 证据核对（身份/续接/台账/护栏）----
  const { pathToFileURL } = await import('node:url');
  const { openDatabase } = await import(pathToFileURL(join(repoRoot, 'src', 'persistence', 'db.ts')).href);
  const db = openDatabase(join(appData, 'state.sqlite'));
  const rows = db.prepare("SELECT conversation_id, provider_session_id FROM runtime_sessions WHERE scope_kind='dm' ORDER BY rowid").all();
  const aRows = rows.filter((r) => r.conversation_id === convA.conversationId);
  const bRows = rows.filter((r) => r.conversation_id === convB.conversationId);
  record('身份持久：A/B 会话 provider ID 均非空且互不相同', aRows.length >= 1 && bRows.length >= 1
    && aRows.every((r) => (r.provider_session_id ?? '').length > 0) && bRows.every((r) => (r.provider_session_id ?? '').length > 0)
    && aRows[aRows.length - 1].provider_session_id !== bRows[bRows.length - 1].provider_session_id,
    `A 行数=${aRows.length} B 行数=${bRows.length}`);
  const resumedEvents = db.prepare("SELECT payload_json FROM domain_events WHERE kind='dm.sessionResumed' ORDER BY rowid").all();
  const resumedA = resumedEvents.map((e) => JSON.parse(e.payload_json)).filter((p) => p.conversationId === convA.conversationId);
  record('原生续接证据：A 会话 dm.sessionResumed≥2（A2+重启后 A3），请求=上报', resumedA.length >= 2
    && resumedA.every((p) => p.nativeResume === true && p.resumeRequested === p.providerReported && (p.providerReported ?? '') === aRows[0].provider_session_id),
    `resumed=${resumedA.length}`);
  const calls = db.prepare('SELECT count(*) c, sum(case when status=\'succeeded\' then 1 else 0 end) s FROM real_calls WHERE batch_id = ?').get(BATCH);
  const expectCalls = REHEARSAL ? 0 : 4;
  record(`startTurn 计数=${expectCalls} 且全部 succeeded`, calls.c === expectCalls && (expectCalls === 0 ? calls.s == null : calls.s === expectCalls), `calls=${calls.c} succeeded=${calls.s}`);
  const { batchJournalStats } = await import(pathToFileURL(join(repoRoot, 'src', 'daemon', 'realBatchJournal.ts')).href);
  const journal = batchJournalStats(BATCH);
  record(`批次护栏台账（journal reserved=${expectCalls} 未触上限；cap=8）`, journal.reserved === expectCalls && journal.rejected === 0, `reserved=${journal.reserved} rejected=${journal.rejected}`);
  db.close();
} catch (error) {
  stop = true;
  record('批次中止（身份/协议/预算/崩溃问题即停）', false, String(error instanceof Error ? error.message : error).slice(0, 200));
} finally {
  // 正式收拢（第二十二轮四）：spawn 引用逐个正式停止（shutdown→有界等待→核实），强杀/未确认
  // 进报告（pid 文件缺失≠已退出）；证据先行（分列报告），随后才清理本批目录。
  // 完整事实抓取（第二十三轮四：清理前保存——成功/失败路径都要；只读独立连接）。
  let dbCalls = null; let callsDetail = null; let identities = null;
  try {
    const { pathToFileURL } = await import('node:url');
    const { openDatabase } = await import(pathToFileURL(join(repoRoot, 'src', 'persistence', 'db.ts')).href);
    const dbF = openDatabase(join(appData, 'state.sqlite'));
    dbCalls = dbF.prepare('SELECT count(*) c FROM real_calls WHERE batch_id = ?').get(BATCH);
    callsDetail = dbF.prepare('SELECT turn_id, status, model AS request_model, response_model, usage_json, run_id FROM real_calls WHERE batch_id = ?').all(BATCH);
    identities = dbF.prepare("SELECT conversation_id, provider_session_id, session_generation FROM runtime_sessions WHERE scope_kind='dm' ORDER BY rowid").all();
    dbF.close();
  } catch { /* 库不可读（启动即败等）——明细如实缺省，主结果以 results 为准 */ }
  const stopFacts = [];
  for (const entry of daemons) {
    if (entry.exit != null) { stopFacts.push({ seq: entry.seq, exit: entry.exit }); continue; }
    try { stopFacts.push(await stopDaemonFormally(entry)); } catch (error) {
      stopFacts.push({ seq: entry.seq, error: String(error instanceof Error ? error.message : error).slice(0, 120) });
    }
  }
  const cleanupUnclean = stopFacts.some((f) => f.killed === true || f.unconfirmed === true);
  let ledgerSaved = false;
  const ledgerPath = join(repoRoot, 'docs', 'implementation', 'real-batches', `r20-dm-ledger-${MODE}${CRASH_AT !== '' ? `-${CRASH_AT}` : ''}.json`);
  try {
    writeFileSync(ledgerPath, JSON.stringify({
      batch: BATCH, mode: MODE, at: new Date().toISOString(), buildId, crashAt: CRASH_AT || null,
      results, cap: 8, expectedCalls: REHEARSAL ? 0 : 4,
      actualCalls: dbCalls != null ? dbCalls.c : null, callsDetail, identities, // 清理前行级事实（第二十三轮四）
      daemonStopFacts: stopFacts, cleanupUnclean,
      evidence: { runRoot: cleanupUnclean || results.some((r) => !r.ok) ? runRoot : '(成功已清理)', ledger: ledgerPath },
    }, null, 2), 'utf8');
    ledgerSaved = true;
  } catch (error) {
    console.error(`台账保存失败（交付不成立）：${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
  }
  if (cleanupUnclean) console.error(`[r20dm] 收拢含强杀/未确认（非优雅——如实入报告）：${JSON.stringify(stopFacts)}`);
  const ok = ledgerSaved && !cleanupUnclean && results.length > 0 && results.every((r) => r.ok);
  if (ok) { try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* */ } }
  else console.error(`现场保留：${runRoot}`);
  console.log(`[real-batch-r20dm/${MODE}] ${ok ? '全部通过' : '存在失败（已停批）'}；台账 ${ledgerPath}`);
  process.exit(ok ? 0 : 1);
}
void spawnSync;
