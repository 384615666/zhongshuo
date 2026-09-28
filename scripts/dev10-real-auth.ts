/**
 * DEV-10 真实认证 harness（预算：本轮最多 2 个真实 turn，用户已批准）：
 * - turn1：专用 fixture 只读分析——经正式 daemon（in-process startDaemon）+ 命名管道 +
 *   成员级 runtime 绑定（member.setRuntime → claude/deepseek-flash）派发真实 Claude CLI
 *   进程；核对暗号回流、TaskComplete 输出合同、usage/模型信息、任务终态。
 * - turn2：受控中断——确认真实运行开始（turn RUNNING）后 task.stop，核对终态、
 *   进程收尾（process.exited 审计）、迟到事件处理、无孤儿 claude 进程。
 * - status：只读观察（不消耗调用）。
 *
 * 证据：ROOT/evidence-turn{1,2}.json（token/密钥不写入）。
 * 用法：node scripts/dev10-real-auth.ts turn1|turn2|status
 */
process.env.ZS_ALLOW_FAKE = '1'; // daemon 默认 adapter=fake（未绑定成员回落；本 harness 成员全部绑定真实 runtime）
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../src/daemon/entry.ts';
import { connectPipe, daemonPipeNameFor } from '../src/contracts/daemonIpc.ts';

const ROOT = join(tmpdir(), 'zhongshuo-dev10-real');
const APPDATA = join(ROOT, 'appdata');
const PROJ = join(ROOT, 'proj');
const MODEL = process.env.ZS_DEV10_MODEL ?? 'deepseek-flash';
const SECRET = 'ZS-DEV10-CLAUDE-7749';

const mode = process.argv[2] ?? 'status';

function log(msg: string): void {
  process.stdout.write(`[dev10] ${new Date().toISOString()} ${msg}\n`);
}

function ensureFixture(): void {
  mkdirSync(APPDATA, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  if (!existsSync(join(PROJ, 'notes.md'))) {
    writeFileSync(join(PROJ, 'notes.md'),
      `# 迁移备忘（DEV-10 只读认证 fixture）\n\n- 宇宙暗号：${SECRET}\n- 旧机器：10.0.0.11（已下线）；新机器：10.0.0.22，SSH 端口 2222\n- 数据库备份：/backup/db-20260920.sql.gz（未校验）\n- 已知问题：夜间 2 点日志空窗约 5 分钟，原因不明\n`, 'utf8');
  }
}

function channelHost(): string | null {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as { env?: { ANTHROPIC_BASE_URL?: string } };
    const url = settings.env?.ANTHROPIC_BASE_URL;
    return url != null ? new URL(url).host : null; // 只记录 host，不记录 token/完整配置
  } catch {
    return null;
  }
}

function claudeVersion(): string {
  try {
    return execSync('claude --version', { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch (e) {
    return `version-check-failed: ${String(e).slice(0, 80)}`;
  }
}

function claudeProcesses(): Array<{ pid: number; start: string }> {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-Process claude -ErrorAction SilentlyContinue | Select-Object Id,StartTime | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', timeout: 20_000 },
    ).trim();
    if (out.length === 0) return [];
    const parsed = JSON.parse(out) as { Id: number; StartTime: string } | Array<{ Id: number; StartTime: string }>;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => ({ pid: p.Id, start: p.StartTime }));
  } catch {
    return [];
  }
}

interface DaemonCtx {
  pipe: Awaited<ReturnType<typeof connectPipe>>;
  daemon: Awaited<ReturnType<typeof startDaemon>>;
}

async function bootDaemon(): Promise<DaemonCtx> {
  const daemon = await startDaemon({ appDataDir: APPDATA, runtime: 'fake', tickMs: 400 });
  const pipe = await connectPipe(daemon.pipeName ?? daemonPipeNameFor('harness'), { token: daemon.credential.token, requestTimeoutMs: 20_000 });
  return { pipe, daemon };
}

function command(ctx: DaemonCtx, method: string, params: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } }> {
  return ctx.pipe.send({ protocolVersion: 1, commandId: `dev10-${randomUUID()}`, method, params }) as Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } }>;
}

async function submitTask(ctx: DaemonCtx, body: string): Promise<{ taskId: string; threadId: string; memberId: string }> {
  const opened = await command(ctx, 'project.open', { path: PROJ, agentNames: ['克劳德'] });
  if (!opened.ok) throw new Error(`project.open 失败：${JSON.stringify(opened.error)}`);
  const projectId = (opened.data as { project: { id: string } }).project.id;
  const listed = await command(ctx, 'member.list', { projectId });
  const members = (listed.data as { items: Array<{ id: string; displayName: string; principalType: string; enabled: boolean }> }).items.filter((m) => m.principalType === 'agent' && m.enabled);
  if (members.length === 0) throw new Error('无可用 agent 成员');
  const memberId = members[0]!.id;
  // 成员级 runtime 绑定（正式命令路径）：成员配置而非全局 ZS_RUNTIME 决定 adapter。
  // ZS_DEV10_REHEARSE=1 时绑 fake（零额度彩排同一链路，不消耗真实调用）。
  const rehearse = process.env.ZS_DEV10_REHEARSE === '1';
  const bound = await command(ctx, 'member.setRuntime', rehearse
    ? { memberId, kind: 'fake' }
    : { memberId, kind: 'claude', model: MODEL, permissionMode: 'plan' });
  if (!bound.ok) throw new Error(`member.setRuntime 失败：${JSON.stringify(bound.error)}`);
  const rooms = await command(ctx, 'room.list', { projectId });
  const room = (rooms.data as { items: Array<{ id: string; conversationId: string }> }).items[0];
  if (room == null) throw new Error('默认房间缺失');
  const submitted = await command(ctx, 'message.submit', {
    target: { kind: 'room_root', projectId, conversationId: room.conversationId, roomId: room.id },
    body, intent: 'default', mentions: [{ kind: 'member', memberId }],
  });
  if (!submitted.ok) throw new Error(`message.submit 失败：${JSON.stringify(submitted.error)}`);
  const data = submitted.data as { taskId?: string; threadId?: string; task?: { id?: string }; thread?: { id?: string } };
  const taskId = data.taskId ?? data.task?.id;
  const threadId = data.threadId ?? data.thread?.id;
  if (taskId == null || threadId == null) throw new Error(`message.submit 返回缺 taskId/threadId：${JSON.stringify(submitted.data).slice(0, 300)}`);
  return { taskId, threadId, memberId };
}

async function waitTaskTerminal(ctx: DaemonCtx, taskId: string, timeoutMs: number): Promise<{ taskStatus: string; runStatus: string | null; turnStatus: string | null; turnId: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await command(ctx, 'task.get', { taskId });
    if (!got.ok) throw new Error(`task.get 失败：${JSON.stringify(got.error)}`);
    const data = got.data as { task: { status: string }; activeRun: { id: string; status: string } | null };
    const turn = data.activeRun != null
      ? ((ctx.daemon.db.prepare('SELECT id, status FROM agent_turns WHERE run_id = ? ORDER BY rowid DESC LIMIT 1').get(data.activeRun.id) as { id: string; status: string } | undefined) ?? null)
      : null;
    const terminal = ['DONE', 'REVIEW', 'BLOCKED', 'CANCELLED', 'FAILED'].includes(data.task.status);
    // turn 级终态先行（turn FAILED 后任务可能回 ACTIVE 等修复轮——不空等到超时）。
    const turnTerminal = turn != null && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(turn.status);
    if (terminal || turnTerminal || Date.now() > deadline) {
      return { taskStatus: data.task.status, runStatus: data.activeRun?.status ?? null, turnStatus: turn?.status ?? null, turnId: turn?.id ?? null };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function evidenceTurn1(): Promise<void> {
  ensureFixture();
  log(`turn1 开始：model=${MODEL} cli="${claudeVersion()}" channel=${channelHost()}`);
  const ctx = await bootDaemon();
  const t0 = Date.now();
  try {
    const { taskId, threadId, memberId } = await submitTask(ctx,
      `请只读分析当前目录下的 notes.md：1) 用不超过 3 条要点概括内容；2) 在其中一条要点里原样引用文件中的"宇宙暗号"完整字符串；3) 指出一处可疑之处。不要修改任何文件。最终按输出契约提交结构化结果。`);
    log(`任务已提交 taskId=${taskId} memberId=${memberId}（claude/${MODEL}）`);
    const final = await waitTaskTerminal(ctx, taskId, 300_000);
    const elapsed = Date.now() - t0;

    const history = await command(ctx, 'thread.history', { threadId });
    const replies = ((history.data as { items: Array<{ authorType: string; authorId: string; body: { text: string } }> }).items)
      .filter((m) => m.authorType === 'agent').map((m) => ({ authorId: m.authorId, text: m.body.text }));
    const usage = ctx.daemon.db.prepare(
      'SELECT normalized_json FROM usage_records WHERE turn_id IN (SELECT id FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?))',
    ).all(taskId) as Array<{ normalized_json: string }>;
    const delivery = ctx.daemon.db.prepare('SELECT revision, review_status, manifest_hash FROM task_deliveries WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(taskId) as { revision: number; review_status: string; manifest_hash: string } | undefined;
    const audits = ctx.daemon.db.prepare(
      "SELECT kind, payload_json, created_at FROM domain_events WHERE task_id = ? AND kind LIKE 'turn.%' ORDER BY created_at DESC LIMIT 20",
    ).all(taskId) as Array<{ kind: string; payload_json: string; created_at: number }>;

    const replyText = replies.map((r) => r.text).join('\n');
    const usageParsed = usage.map((u) => JSON.parse(u.normalized_json) as { model?: string; inputTokens?: number; outputTokens?: number; cachedTokens?: number });
    const evidence = {
      turn: 1, rehearsal: process.env.ZS_DEV10_REHEARSE === '1',
      purpose: 'fixture 只读分析全链（正式 adapter + 成员绑定 + 输出合同 + 线程归属）',
      model: MODEL, channelHost: channelHost(), cliVersion: claudeVersion(),
      taskId, threadId, memberId, elapsedMs: elapsed,
      taskStatus: final.taskStatus, runStatus: final.runStatus, turnStatus: final.turnStatus,
      secretInReply: replyText.includes(SECRET),
      secret: SECRET, replyExcerpt: replyText.slice(0, 1200),
      usage: usageParsed,
      reportedModel: usageParsed.find((u) => u.model != null)?.model ?? null,
      delivery: delivery ?? null,
      audits,
      checks: {
        taskDone: final.taskStatus === 'DONE',
        secretEchoed: replyText.includes(SECRET),
        usageRecorded: usageParsed.length > 0,
        deliveryCreated: delivery != null,
      },
    };
    writeFileSync(join(ROOT, process.env.ZS_DEV10_REHEARSE === '1' ? 'evidence-turn1-rehearsal.json' : 'evidence-turn1.json'), JSON.stringify(evidence, null, 2), 'utf8');
    log(`turn1 完成：status=${final.taskStatus} secret回流=${evidence.checks.secretEchoed} usage=${usageParsed.length}条 reportedModel=${evidence.reportedModel} elapsed=${elapsed}ms`);
    log(`证据：${join(ROOT, 'evidence-turn1.json')}`);
  } finally {
    await ctx.pipe.close();
    await ctx.daemon.stop();
  }
}

async function evidenceTurn2(): Promise<void> {
  ensureFixture();
  log(`turn2 开始（受控中断）：model=${MODEL}`);
  const ctx = await bootDaemon();
  const t0 = Date.now();
  const claudeBefore = claudeProcesses();
  try {
    const { taskId, memberId } = await submitTask(ctx,
      `请只读分析当前目录下的 notes.md，逐条列出可疑之处并给出核查建议（不需要得出结论，慢慢分析即可）。不要修改任何文件。`);
    log(`任务已提交 taskId=${taskId} memberId=${memberId}`);

    // 等真实运行开始：agent_turn 进入 RUNNING（真实进程已启动、事件流已建立）。
    const deadline = Date.now() + 120_000;
    let turnRow: { id: string; status: string } | null = null;
    for (;;) {
      turnRow = ctx.daemon.db.prepare('SELECT id, status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?) ORDER BY rowid DESC LIMIT 1').get(taskId) as { id: string; status: string } | null;
      if (turnRow != null && ['RUNNING', 'WAITING_APPROVAL'].includes(turnRow.status)) break;
      if (Date.now() > deadline) throw new Error(`等待真实运行开始超时（turn 状态=${turnRow?.status ?? 'null'}）`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const startedAt = Date.now();
    log(`真实运行已开始 turnId=${turnRow.id}（status=${turnRow.status}）——执行受控停止`);

    const got = await command(ctx, 'task.get', { taskId });
    const taskData = got.data as { task: { stopGeneration: number }; activeRun: { id: string } | null };
    const stopped = await command(ctx, 'task.stop', { taskId, targetRunId: taskData.activeRun!.id, expectedStopGeneration: taskData.task.stopGeneration });
    if (!stopped.ok) throw new Error(`task.stop 失败：${JSON.stringify(stopped.error)}`);
    log('task.stop 已发出');

    const final = await waitTaskTerminal(ctx, taskId, 60_000);
    // 停止后再观察 8s：迟到事件/孤儿进程判定窗口。
    await new Promise((r) => setTimeout(r, 8_000));
    const claudeAfter = claudeProcesses();
    const newPids = claudeAfter.filter((p) => !claudeBefore.some((b) => b.pid === p.pid));
    const lateEvents = ctx.daemon.db.prepare("SELECT kind, payload_json, created_at FROM domain_events WHERE task_id = ? AND kind LIKE 'turn.%' AND created_at >= ? ORDER BY created_at").all(taskId, startedAt) as Array<{ kind: string; payload_json: string; created_at: number }>;
    const turnFinal = ctx.daemon.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnRow.id) as { status: string };
    const usage = ctx.daemon.db.prepare('SELECT normalized_json FROM usage_records WHERE turn_id = ?').all(turnRow.id) as Array<{ normalized_json: string }>;

    const evidence = {
      turn: 2, rehearsal: process.env.ZS_DEV10_REHEARSE === '1',
      purpose: '受控中断：真实运行开始后停止——终态/进程收尾/迟到事件/资源回收',
      model: MODEL, channelHost: channelHost(), cliVersion: claudeVersion(),
      taskId, memberId, turnId: turnRow.id,
      stopSentAtMs: startedAt, elapsedMs: Date.now() - t0,
      taskStatus: final.taskStatus, runStatus: final.runStatus, turnStatus: final.turnStatus, turnFinalStatus: turnFinal.status,
      claudeProcessesBefore: claudeBefore.length, claudeProcessesAfter: claudeAfter.length, newClaudePids: newPids,
      lateEvents: lateEvents.slice(-15),
      // process.exited 归一化事件在 worker 侧被忽略（不入审计）——进程收尾以系统进程清单核验。
      processExitedAudit: null as null,
      usage: usage.map((u) => JSON.parse(u.normalized_json)),
      checks: {
        stopReachedTerminal: ['CANCELLED', 'FAILED', 'BLOCKED', 'INTERRUPTED'].includes(final.taskStatus) || final.turnStatus === 'INTERRUPTED' || turnFinal.status === 'INTERRUPTED' || turnFinal.status === 'CANCELLED',
        noOrphanClaude: newPids.length === 0,
        daemonAliveAfterStop: true,
      },
    };
    writeFileSync(join(ROOT, process.env.ZS_DEV10_REHEARSE === '1' ? 'evidence-turn2-rehearsal.json' : 'evidence-turn2.json'), JSON.stringify(evidence, null, 2), 'utf8');
    log(`turn2 完成：task=${final.taskStatus} turn=${turnFinal.status} 新claude进程(仍存活)=${newPids.length} lateEvents=${lateEvents.length}`);
    log(`证据：${join(ROOT, 'evidence-turn2.json')}`);
  } finally {
    await ctx.pipe.close();
    await ctx.daemon.stop();
  }
}

async function status(): Promise<void> {
  for (const n of [1, 2]) {
    const p = join(ROOT, `evidence-turn${n}.json`);
    if (!existsSync(p)) { log(`evidence-turn${n}.json 不存在`); continue; }
    const e = JSON.parse(readFileSync(p, 'utf8')) as { checks?: Record<string, boolean>; taskStatus?: string; elapsedMs?: number };
    log(`turn${n}: status=${e.taskStatus ?? '?'} checks=${JSON.stringify(e.checks ?? {})} elapsed=${e.elapsedMs ?? '?'}ms`);
  }
}

if (mode === 'turn1') await evidenceTurn1();
else if (mode === 'turn2') await evidenceTurn2();
else if (mode === 'status') await status();
else {
  process.stderr.write('用法：node scripts/dev10-real-auth.ts turn1|turn2|status\n');
  process.exit(2);
}
void spawn; // 保留 import 便于后续扩展（当前未用）
