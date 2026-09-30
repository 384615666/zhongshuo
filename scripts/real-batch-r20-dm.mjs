/**
 * 第二十轮三：最小真实 DM 批次（deepseek-flash 经 Claude CLI 渠道；持续授权内）。
 * 目标：验证 DM 链真实执行 + 同对话原生续接（--resume 请求与 provider 上报身份一致）+
 * 同成员第二会话独立 + daemon 重启后沿持久身份续接。
 * 上限与停止条件：ZS_REAL_BATCH_ID=r20-dm、ZS_REAL_BATCH_CAP=8（硬上限；预期 4 次
 * startTurn：A1/A2/B1/A3——任何超发即护栏拒绝=停批）。身份/协议/预算问题出现即停批修复。
 * 证据标准：provider 身份（runtime_sessions.provider_session_id 非空）+ dm.sessionResumed
 * 事件（resume 请求=上报）+ real_calls 计数；模型回忆暗号仅辅助。
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
process.env.ZS_REAL_BATCH_ID = BATCH;
process.env.ZS_REAL_BATCH_CAP = '8';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`);
  if (!ok) throw new BatchStepFailed(name); // 即停：失败不继续后续调用（catch 收拢+留现场）
};
class BatchStepFailed extends Error { constructor(name) { super(`批次步骤失败即停：${name}`); this.name = 'BatchStepFailed'; } }

function startDaemon(pipeName) {
  const child = spawn(nodeExe, [daemonCjs], {
    cwd: appHome,
    env: {
      ...process.env, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1',
      ZS_RUNTIME: process.env.ZS_R20_REHEARSAL === '1' ? 'fake' : 'claude',
      ...(process.env.ZS_R20_REHEARSAL === '1' ? { ZS_ALLOW_FAKE: '1' } : { ZS_CLAUDE_MODEL: 'deepseek-flash' }),
      ZS_APP_DATA: appData, ZS_PIPE_NAME: pipeName,
      ZS_REAL_BATCH_ID: BATCH, ZS_REAL_BATCH_CAP: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  return { child, err: () => err };
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
async function waitTaskDone(call, taskId, expect = 'DONE', timeoutMs = 240_000) {
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

let stop = false;
try {
  const d1 = startDaemon('zs-r20dm-1');
  await waitListening(d1);
  const c = await ipcCall('zs-r20dm-1');
  await c.call('project.open', { path: fixture });
  const members = await c.call('member.list', { projectId: (await (async () => { const r = await c.call('project.open', { path: fixture }); return r.project.id; })()), roomId: '' }).catch(async () => null);
  void members;
  const projId = (await c.call('project.open', { path: fixture })).project.id;
  const list = await c.call('member.list', { projectId: projId });
  const agent = list.items.find((m) => m.principalType === 'agent');
  if (agent == null) throw new Error('无 agent 成员');
  // A1：会话 A 首轮（首开——provider ID 由 init 回填）。
  const convA = await c.call('conversation.create', { projectId: projId, peerMemberId: agent.id, title: '批次会话A' });
  const a1 = await c.call('message.submit', { target: { kind: 'dm', projectId: projId, conversationId: convA.conversationId }, body: '请读取 notes.md 并在回复中报出其中的暗号原文（格式：暗号=…）。这是一对一会话的第一轮。', intent: 'default', mentions: [] });
  const st1 = await waitTaskDone((m, p) => c.call(m, p), a1.taskId);
  record('A1 首轮执行（DONE/REVIEW）', ['DONE', 'REVIEW'].includes(st1), `status=${st1}`);
  const hist1 = await c.call('conversation.history', { conversationId: convA.conversationId, limit: 10 });
  const reply1 = (hist1.messages ?? []).filter((m) => m.author_type === 'agent').map((m) => JSON.parse(m.body_json).text).join('');
  const rehearsal = process.env.ZS_R20_REHEARSAL === '1';
  record('A1 回复到达（暗号回流=辅助证据；演练=fake 回复）', rehearsal || reply1.includes('R20-DM-7735'), `len=${reply1.length} 含暗号=${reply1.includes('R20-DM-7735')}`);
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
  const st2 = await waitTaskDone((m, p) => c.call(m, p), a2.taskId);
  record('A2 同会话第二轮执行', ['DONE', 'REVIEW'].includes(st2), `status=${st2}`);
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
  const expectCalls = rehearsal ? 0 : 4;
  record(`startTurn 计数=${expectCalls}（真实）且全部 succeeded`, rehearsal ? calls.c === 0 : (calls.c === 4 && calls.s === 4), `calls=${calls.c} succeeded=${calls.s}`);
  const rejects = db.prepare("SELECT count(*) c FROM domain_events WHERE kind='message.submitted' AND payload_json LIKE '%\"disposition\":\"dispatched\"%'").get();
  void rejects;
  const { batchJournalStats } = await import(pathToFileURL(join(repoRoot, 'src', 'daemon', 'realBatchJournal.ts')).href);
  const journal = batchJournalStats(BATCH);
  record(`批次护栏台账（journal reserved=${rehearsal ? 0 : 4} 未触上限；cap=8）`, journal.reserved === (rehearsal ? 0 : 4) && journal.rejected === 0, `reserved=${journal.reserved} rejected=${journal.rejected}`);
  db.close();
} catch (error) {
  stop = true;
  record('批次中止（身份/协议/预算问题即停）', false, String(error instanceof Error ? error.message : error).slice(0, 200));
} finally {
  // 证据先行：台账落盘失败=交付不成立（不宣称成功）；随后才清理本批进程/目录。
  let ledgerSaved = false;
  try {
    writeFileSync(join(repoRoot, 'docs', 'implementation', 'real-batches', 'r20-dm-ledger.json'), JSON.stringify({ batch: BATCH, at: new Date().toISOString(), results, cap: 8, expected: 4 }, null, 2), 'utf8');
    ledgerSaved = true;
  } catch (error) {
    console.error(`台账保存失败（交付不成立）：${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
  }
  // 本批 daemon 收拢（仅本脚本 spawn 的——daemon.pid 追踪；正常路径已 daemon.shutdown）。
  try {
    const pidRaw = readFileSync(join(appData, 'daemon.pid'), 'utf8').trim();
    if (/^\d+$/.test(pidRaw)) {
      spawnSync('taskkill', ['/PID', pidRaw, '/T', '/F'], { stdio: 'ignore' });
      console.error(`收拢残留 daemon pid=${pidRaw}（taskkill 兜底——非优雅，仅现场收束）`);
    }
  } catch { /* pid 文件不存在=已正常退出 */ }
  const ok = ledgerSaved && results.length > 0 && results.every((r) => r.ok);
  if (ok) { try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* */ } }
  else console.error(`现场保留：${runRoot}`);
  console.log(`[real-batch-r20dm] ${ok ? '全部通过' : '存在失败（已停批）'}；台账 docs/implementation/real-batches/r20-dm-ledger.json`);
  process.exit(ok ? 0 : 1);
}
void spawnSync;
