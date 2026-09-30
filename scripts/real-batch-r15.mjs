/**
 * 真实批次 R15：受管 Claude Code + deepseek-flash（用户持续授权 2026-09-30：
 * 「批准，deepseek 的预算很多，可以随意使用」——仅限该 runtime/模型渠道）。
 *
 * 目标：①正常链（经便携产物正式成员绑定与派发链：受管 managed_job_id/输入/流式输出/
 * 合法交付/预算用量/资源回收）；②停止链（确认真实 turn 运行中→正式 task.stop→CANCELLED/
 * 无成功交付/受管进程收拢/保护状态）。停止条件：任一请求失败/超时/是否发出不确定=计入
 * 尝试并停批（不自动补跑；不因输出不符临时加测）。
 *
 * 机械上限：本脚本硬顶 2 次提交（submissions≥2 即拒绝再发）；台账 real-batches/r15-ledger.json
 * 先记后发（崩溃也可核对已发次数）。模型固定 deepseek-flash，不回退；凭据不读不印。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const repo = resolve(import.meta.dirname, '..');
const MAX_SUBMISSIONS = 2;
const ledgerPath = join(repo, 'docs', 'implementation', 'real-batches', 'r15-ledger.json');
mkdirSync(join(repo, 'docs', 'implementation', 'real-batches'), { recursive: true });
let ledger = { batch: 'R15-managed-claude-deepseek', createdAt: new Date().toISOString(), cap: MAX_SUBMISSIONS, submissions: [], accidentalPreBatch: [] };
if (existsSync(ledgerPath)) ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const saveLedger = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');

for (const script of ['build-ui.mjs', 'pack-daemon.mjs', 'pack-desktop.mjs']) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { cwd: repo, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) { console.error(`前置构建失败（${script}）`); process.exit(1); }
}
const installRoot = mkdtempSync(join(tmpdir(), '真实批次-'));
const appHome = join(installRoot, '众说 桌面版');
cpSync(join(repo, 'dist', 'desktop', '众说-便携-win-x64'), appHome, { recursive: true, dereference: true });
const appData = join(installRoot, '应用 数据');
const fixtureProj = join(installRoot, '真实 fixture');
mkdirSync(fixtureProj, { recursive: true });
writeFileSync(join(fixtureProj, 'notes.md'), '# 真实批次\n\n暗号：R15-REAL-9466\n', 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Database = createRequire(join(repo, 'node_modules', 'better-sqlite3'))('better-sqlite3');

const daemon = spawn(join(appHome, 'resources', 'app', 'daemon', 'node', 'node.exe'), [join(appHome, 'resources', 'app', 'daemon', 'daemon.cjs')], {
  cwd: installRoot,
  env: { ...process.env, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '1', ZS_RUNTIME: 'claude', ZS_CLAUDE_MODEL: 'deepseek-flash', ZS_APP_DATA: appData, ZS_PIPE_NAME: 'zs-real-r15' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let dstderr = '';
daemon.stderr.setEncoding('utf8');
daemon.stdout.setEncoding('utf8');
daemon.stderr.on('data', (c) => { dstderr += c; });
daemon.stdout.on('data', () => {});
for (let i = 0; i < 100 && !dstderr.includes('listening'); i += 1) await sleep(200);
if (!dstderr.includes('listening')) { console.error('daemon 未启动'); daemon.kill(); process.exit(1); }

const token = readFileSync(join(appData, 'local.token'), 'utf8').trim();
const sock = net.connect('\\\\.\\pipe\\zs-real-r15');
await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
sock.setEncoding('utf8');
let buf = '';
let seq = 0;
const pending = new Map();
sock.on('data', (chunk) => {
  buf += chunk;
  let i = buf.indexOf('\n');
  while (i >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    i = buf.indexOf('\n');
    if (line.length === 0) continue;
    try { const resp = JSON.parse(line); if (resp.commandId != null && pending.has(resp.commandId)) { pending.get(resp.commandId)(resp); pending.delete(resp.commandId); } } catch { /* 忽略 */ }
  }
});
sock.write(JSON.stringify({ type: 'auth', token }) + '\n');
const call = (method, params, timeoutMs = 180_000) => new Promise((res, rej) => {
  if (method === 'message.submit') {
    if (ledger.submissions.length >= MAX_SUBMISSIONS) { rej(new Error(`机械上限已到（${MAX_SUBMISSIONS}）——拒绝提交`)); return; }
    ledger.submissions.push({ at: new Date().toISOString(), purpose: params.body.slice(0, 60), requestModel: 'deepseek-flash', status: 'submitted' });
    saveLedger(); // 先记后发
  }
  const commandId = `rb-${seq++}-${randomUUID().slice(0, 8)}`;
  const timer = setTimeout(() => { pending.delete(commandId); rej(new Error(`IPC 超时：${method}`)); }, timeoutMs);
  pending.set(commandId, (resp) => { clearTimeout(timer); if (resp.ok !== true) rej(new Error(`${method}: ${resp.error?.message}`)); else res(resp.data); });
  sock.write(JSON.stringify({ protocolVersion: 1, commandId, method, params }) + '\n');
});

const alive = (pid) => (spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '').includes(String(pid));
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`); };

try {
  const opened = await call('project.open', { path: fixtureProj, displayName: '真实批次' });
  const pid_ = opened.project.id;
  const memberId = `m_default_${pid_}_0`;
  await call('member.setRuntime', { memberId, kind: 'claude', model: 'deepseek-flash' });

  // ① 正常链（受控第 1 次）。
  const t1 = await call('message.submit', { target: { kind: 'room_root', projectId: pid_, conversationId: `conv_default_${pid_}`, roomId: `room_default_${pid_}` }, body: '请读取当前目录 notes.md，并原样报出其中的暗号行。', intent: 'default', mentions: [{ kind: 'member', memberId }] });
  let task1 = null;
  for (let i = 0; i < 240; i += 1) {
    task1 = await call('task.get', { taskId: t1.taskId }, 30_000);
    if (['DONE', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(task1.task.status)) break;
    await sleep(1000);
  }
  const db1 = new Database(join(appData, 'state.sqlite'), { readonly: true });
  const reg1 = db1.prepare('SELECT identity_source, managed_job_id, closed_at, pid FROM runtime_process_registry ORDER BY id DESC LIMIT 1').get();
  const usage1 = db1.prepare('SELECT normalized_json FROM usage_records ORDER BY rowid DESC LIMIT 1').get();
  const reply1 = db1.prepare(`SELECT body_json FROM messages WHERE thread_id = (SELECT id FROM conversation_threads WHERE root_task_id = ?) AND author_type='agent' ORDER BY thread_message_seq DESC LIMIT 1`).get(t1.taskId);
  db1.close();
  const u1 = usage1 != null ? JSON.parse(usage1.normalized_json) : {};
  record('①正常链：真实 claude turn DONE（经便携产物成员绑定/受管桥/流式输出/合法交付）', task1?.task?.status === 'DONE', `status=${task1?.task?.status}`);
  record('①受管登记（managed-job+managed_job_id+终态收口 closed_at）', reg1?.identity_source === 'managed-job' && /^job-/.test(reg1?.managed_job_id ?? '') && reg1?.closed_at != null, `job=${reg1?.managed_job_id} closed=${reg1?.closed_at != null}`);
  record('①受管进程资源回收（registry pid 已退出）', !alive(reg1?.pid), `pid=${reg1?.pid} alive=${alive(reg1?.pid)}`);
  record('①输出含 fixture 暗号（真实读取回流）', String(reply1?.body_json ?? '').includes('R15-REAL-9466'), String(reply1?.body_json ?? '').slice(0, 60));
  record('①预算用量（响应自报模型=deepseek-flash+tokens/cost）', u1.model === 'deepseek-flash' && (u1.inputTokens ?? 0) > 0, `model=${u1.model} in=${u1.inputTokens} out=${u1.outputTokens} cost=${u1.cost}${u1.currency ?? ''}`);
  ledger.submissions[0].outcome = { status: task1?.task?.status, model: u1.model, inputTokens: u1.inputTokens, outputTokens: u1.outputTokens, cost: u1.cost };
  saveLedger();
  if (task1?.task?.status !== 'DONE') throw new Error('①未通过——停止条件触发，停批');

  // ② 停止链（受控第 2 次）：确认真实 turn 运行中 → task.stop。
  const t2 = await call('message.submit', { target: { kind: 'room_root', projectId: pid_, conversationId: `conv_default_${pid_}`, roomId: `room_default_${pid_}` }, body: '请从 1 缓慢枚举到 300，每行一个数字，不要省略。', intent: 'default', mentions: [{ kind: 'member', memberId }] });
  let reg2 = null;
  const db2w = new Database(join(appData, 'state.sqlite'), { readonly: true });
  for (let i = 0; i < 90; i += 1) {
    reg2 = db2w.prepare(`SELECT r.turn_id, r.pid, r.managed_job_id, t.status FROM runtime_process_registry r JOIN agent_turns t ON t.id = r.turn_id WHERE t.dispatch_key LIKE ? ORDER BY r.id DESC LIMIT 1`).get(`task:${t2.taskId}:%`);
    if (reg2 != null && reg2.status === 'RUNNING') break;
    await sleep(1000);
  }
  db2w.close();
  record('②真实 turn 运行中确认（RUNNING+受管 pid 已登记）', reg2?.status === 'RUNNING' && reg2?.pid != null, `turn=${reg2?.status} pid=${reg2?.pid}`);
  const stoppable = await call('task.get', { taskId: t2.taskId }, 30_000);
  await call('task.stop', { taskId: t2.taskId, targetRunId: stoppable.activeRun?.id, expectedStopGeneration: stoppable.task.stopGeneration ?? 0 });
  let task2 = null;
  for (let i = 0; i < 90; i += 1) {
    task2 = await call('task.get', { taskId: t2.taskId }, 30_000);
    if (task2.task.status === 'CANCELLED') break;
    await sleep(1000);
  }
  const db2 = new Database(join(appData, 'state.sqlite'), { readonly: true });
  const deliv2 = db2.prepare('SELECT count(*) c FROM task_deliveries WHERE task_id = ?').get(t2.taskId).c;
  const turn2 = db2.prepare(`SELECT status FROM agent_turns WHERE dispatch_key LIKE ? ORDER BY id DESC LIMIT 1`).get(`task:${t2.taskId}:%`);
  db2.close();
  let procGone = false;
  for (let i = 0; i < 30; i += 1) { if (!alive(reg2?.pid)) { procGone = true; break; } await sleep(1000); }
  record('②task.stop→CANCELLED', task2?.task?.status === 'CANCELLED', `status=${task2?.task?.status}`);
  record('②无成功交付（停止链不产生交付）', deliv2 === 0, `deliveries=${deliv2}`);
  record('②turn 终态（CANCELLED——保护状态非 UNKNOWN）', turn2?.status === 'CANCELLED', `turn=${turn2?.status}`);
  record('②受管进程收拢（registry pid 退出）', procGone, `pid=${reg2?.pid} gone=${procGone}`);
  ledger.submissions[1].outcome = { status: task2?.task?.status, turnStatus: turn2?.status, deliveries: deliv2, stoppedAt: new Date().toISOString() };
  saveLedger();

  // 正式关闭。
  await call('daemon.shutdown', {});
  sock.end();
  const exit = await new Promise((res) => { const t = setTimeout(() => res(null), 30_000); daemon.once('exit', (c) => { clearTimeout(t); res(c); }); });
  const stopLine = dstderr.split('\n').find((l) => l.includes('stop-result '));
  const stopResult = stopLine != null ? JSON.parse(stopLine.slice(stopLine.indexOf('{'))) : null;
  record('daemon 正式关闭（退出 0+stop-result complete）', exit === 0 && stopResult?.complete === true, `exit=${exit} phase=${stopResult?.phase}`);
} catch (error) {
  console.error(`批次中止：${error instanceof Error ? error.stack : String(error)}\n--- daemon stderr 尾 ---\n${dstderr.split('\n').slice(-8).join('\n')}`);
  try { await call('daemon.shutdown', {}); } catch { daemon.kill(); }
  process.exitCode = 1;
}

writeFileSync(join(repo, 'dist', 'desktop', 'real-batch-r15-report.json'), JSON.stringify({ at: new Date().toISOString(), results, ledger }, null, 2), 'utf8');
console.log(`[real-batch-r15] 结果=${results.every((r) => r.ok) ? '全部通过' : '存在失败'}；台账=${ledgerPath}`);
if (results.every((r) => r.ok)) rmSync(installRoot, { recursive: true, force: true });
process.exit(results.every((r) => r.ok) ? 0 : 1);
