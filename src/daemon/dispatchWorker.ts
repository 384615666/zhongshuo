/**
 * outbox 派发 worker（§11.2/§11.3）：CAS 领取 → 建 run/turn/session → 经适配器执行 →
 * 规范化事件落库（消息入正确线程）→ 预算结算 → completeOutbox。
 * M0 消费 DIRECT（单一初始 turn）；DELIBERATE/AUTO 的多轮派发由 DEV-08/11 在本 worker 上扩展。
 * 防线：任务终态/停止代次阻止旧派发（§11.4）；重复事件靠消息序号唯一与状态 CAS 收敛（RT-05）；
 * 迟到的旧 turn 事件在终态后被忽略（不复活任务）。
 */
import { randomUUID } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { claimNextOutbox, completeOutbox } from '../persistence/outbox.ts';
import type { OutboxRow } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import type { RuntimeAdapter, NormalizedRuntimeEvent } from '../contracts/runtime.ts';
import type { TopLevelRouteOutcome } from '../contracts/routing.ts';
import type { BudgetState } from '../contracts/budget.ts';
import { settleTurns } from '../domain/budget.ts';
import { isRunTerminal } from '../contracts/run.ts';

interface TaskRow {
  id: string;
  project_id: string;
  conversation_id: string;
  room_id: string;
  conversation_thread_id: string;
  owner_member_id: string | null;
  status: string;
  review_policy: string;
  stop_generation: number;
  route_json: string | null;
}

interface ProjectRow {
  id: string;
  canonical_path: string;
}

interface MemberRow {
  id: string;
  project_id: string;
  enabled: number;
}

export interface DispatchWorkerOptions {
  db: ZhongshuoDatabase;
  adapter: RuntimeAdapter;
  leaseOwner: string;
  leaseMs?: number;
  /** 单 turn 截止（保护值）：超时先中断，仍无终结则 turn UNKNOWN（RECONCILE 语义）。 */
  turnDeadlineMs?: number;
  /** DIRECT 预算上限（决策 12：6）；从 route_json/budget_json 读取的逻辑由后续包接。 */
  maxTurns?: number;
}

interface LiveDispatch {
  turnId: string;
  sessionId: string;
}

export class DispatchWorker {
  private readonly db: ZhongshuoDatabase;
  private readonly adapter: RuntimeAdapter;
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly turnDeadlineMs: number;
  private readonly maxTurns: number;
  private readonly live = new Map<string, LiveDispatch>(); // turnId → 在途派发（供停止流程 interrupt）

  constructor(options: DispatchWorkerOptions) {
    this.db = options.db;
    this.adapter = options.adapter;
    this.leaseOwner = options.leaseOwner;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.turnDeadlineMs = options.turnDeadlineMs ?? 60_000;
    this.maxTurns = options.maxTurns ?? 6;
  }

  /** 处理一条 outbox 项；返回是否处理了（无项返回 false）。 */
  async runOnce(now = Date.now()): Promise<boolean> {
    const claimed = claimNextOutbox(this.db, {
      leaseOwner: this.leaseOwner,
      leaseUntil: now + this.leaseMs,
      now,
    });
    if (claimed == null) return false;
    await this.dispatchClaimed(claimed);
    return true;
  }

  /** 排空当前可领取的 outbox。 */
  async drain(now = Date.now()): Promise<number> {
    let processed = 0;
    while (await this.runOnce(now)) processed += 1;
    return processed;
  }

  /** 停止流程回调：向在途 turn 发送协议中断（§16.3）。 */
  async interruptTurn(turnId: string): Promise<void> {
    const live = this.live.get(turnId);
    if (live == null) return;
    await this.adapter.interrupt(
      { id: live.sessionId } as never, // SessionRef 由适配器按 id 索引；此处最小句柄
      turnId,
    );
  }

  private async dispatchClaimed(claimed: OutboxRow): Promise<void> {
    const taskId = parseInitialTaskId(claimed.dispatch_key);
    if (taskId == null) {
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (task == null || task.stop_generation > 0 || task.status === 'CANCELLED' || task.status === 'DONE') {
      // 全停代次/终态阻止旧派发（§11.4）；不误 complete 他人租约——attempt_epoch 已绑定。
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }
    const project = this.db
      .prepare('SELECT id, canonical_path FROM projects WHERE id = ?')
      .get(task.project_id) as ProjectRow | undefined;
    const member = this.db
      .prepare('SELECT id, project_id, enabled FROM project_members WHERE id = ?')
      .get(task.owner_member_id ?? '') as MemberRow | undefined;
    if (project == null || member == null || member.enabled !== 1) {
      await this.transitionTask(task.id, 'BLOCKED');
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    const route = task.route_json != null ? (JSON.parse(task.route_json) as TopLevelRouteOutcome) : null;
    const runId = `run_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    const budget: BudgetState = {
      grantId: runId,
      maxTurns: this.maxTurns,
      usedTurns: 0,
      inFlightReservedTurns: 1, // 派发前预占（§10.4）
    };

    const createRun = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json)
         VALUES (?, ?, ?, ?, ?, 0, 'RUNNING', ?)`,
      ).run(runId, task.id, task.conversation_id, task.conversation_thread_id, route?.kind === 'dispatch' ? route.mode : 'DIRECT', JSON.stringify(budget));
      this.db.prepare(
        `INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES (?, ?, 'owner', 1, 'active')`,
      ).run(runId, member.id);
      this.db.prepare(
        `INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch)
         VALUES (?, ?, ?, ?, ?, 'direct.work', 'RUNNING', ?, 1, 1)`,
      ).run(turnId, runId, task.conversation_id, task.conversation_thread_id, member.id, claimed.dispatch_key);
      this.db.prepare('UPDATE outbox SET turn_id = ? WHERE id = ?').run(turnId, claimed.id);
      this.transitionTask(task.id, 'ACTIVE');
      appendDomainEvent(this.db, {
        schemaVersion: 1,
        eventId: `evt_${randomUUID()}`,
        projectId: task.project_id,
        conversationId: task.conversation_id,
        threadId: task.conversation_thread_id,
        taskId: task.id,
        runId,
        turnId,
        kind: 'run.created',
        createdAt: Date.now(),
        payload: { mode: route?.kind === 'dispatch' ? route.mode : 'DIRECT' },
      });
    });
    createRun();

    // 会话：任务/成员/generation 维度（§13.4）；M0 每次派发新建 generation。
    const generation = this.db
      .prepare('SELECT count(*) c FROM runtime_sessions WHERE member_id = ? AND conversation_id = ?')
      .get(member.id, task.conversation_id) as { c: number };
    const session = await this.adapter.openSession({
      projectId: task.project_id,
      memberId: member.id,
      taskId: task.id,
      threadId: task.conversation_thread_id,
      sessionGeneration: generation.c,
      cwd: project.canonical_path,
      policyId: 'policy-analyze',
    });
    this.db.prepare(
      `INSERT INTO runtime_sessions (id, project_id, conversation_id, scope_kind, thread_id, member_id, task_id, session_generation, cwd)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
    ).run(session.id, task.project_id, task.conversation_id, task.conversation_thread_id, member.id, task.id, generation.c, project.canonical_path);
    this.live.set(turnId, { turnId, sessionId: session.id });

    try {
      await this.adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: `bundle_${turnId}`,
        text: '(task input bundle 由 DEV-21-M0 合同承载)',
        policyId: 'policy-analyze',
        taskRevision: 0,
      });
      await this.consumeUntilTerminal(task, runId, turnId, session.id);
    } finally {
      this.live.delete(turnId);
    }
    await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
  }

  private async consumeUntilTerminal(task: TaskRow, runId: string, turnId: string, sessionId: string): Promise<void> {
    const deadline = Date.now() + this.turnDeadlineMs;
    let interruptedOnce = false;
    for await (const event of this.adapter.events({ id: sessionId } as never)) {
      if (event.sessionId !== sessionId) continue;
      // 迟到/无关事件：终态后忽略（不复活任务，§10.2/RT-06）。
      const turnRow = this.db
        .prepare('SELECT status, epoch FROM agent_turns WHERE id = ?')
        .get(turnId) as { status: string; epoch: number } | undefined;
      if (turnRow == null) break;
      if (event.turnId != null && event.turnId !== turnId) {
        this.appendEventRecord(task, runId, turnId, 'turn.lateEventArrived', { eventKey: event.eventKey, kind: event.kind });
        continue;
      }
      if (isTurnTerminalStatus(turnRow.status)) break;

      this.applyEvent(task, runId, turnId, event);

      if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {
        return;
      }
      if (Date.now() > deadline && !interruptedOnce) {
        interruptedOnce = true;
        await this.adapter.interrupt({ id: sessionId } as never, turnId);
      }
    }
    // 事件流结束仍无终结 → UNKNOWN（结果不确定，恢复流程处理，§10.2/RT-03）。
    const current = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string } | undefined;
    if (current != null && !isTurnTerminalStatus(current.status)) {
      this.db.prepare(`UPDATE agent_turns SET status = 'UNKNOWN' WHERE id = ?`).run(turnId);
      this.db.prepare(`UPDATE workflow_runs SET status = 'INTERRUPTED' WHERE id = ?`).run(runId);
    }
  }

  private applyEvent(task: TaskRow, runId: string, turnId: string, event: NormalizedRuntimeEvent): void {
    switch (event.kind) {
      case 'turn.started':
        this.casTurn(turnId, 'RUNNING');
        break;
      case 'message.completed':
        this.insertThreadReply(task, turnId, event.messageId, event.text);
        break;
      case 'usage.updated':
        this.db
          .prepare(
            `INSERT INTO usage_records (turn_id, provider_event_id, reported_json, normalized_json, cost_quality)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (turn_id, provider_event_id) DO NOTHING`,
          )
          .run(turnId, event.eventKey, JSON.stringify(event), JSON.stringify(event), event.costQuality);
        break;
      case 'turn.completed': {
        // 终态原子应用（§11.3）：turn/run 终态 + 预算结算 + 任务完成 + 事件同事务。
        const tx = this.db.transaction(() => {
          this.casTurn(turnId, 'SUCCEEDED');
          this.db.prepare(`UPDATE workflow_runs SET status = 'SUCCEEDED' WHERE id = ?`).run(runId);
          this.settleBudget(runId);
          this.transitionTask(task.id, 'DONE');
          this.appendEventRecord(task, runId, turnId, 'turn.statusChanged', { status: 'SUCCEEDED' });
        });
        tx();
        break;
      }
      case 'turn.failed': {
        const tx = this.db.transaction(() => {
          const interrupted = event.code === 'INTERRUPTED';
          // §10.2：STOPPING + 确认退出 → CANCELLED；其余按 FAILED。
          this.casTurn(turnId, interrupted ? 'CANCELLED' : 'FAILED');
          this.db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(interrupted ? 'CANCELLED' : 'FAILED', runId);
          this.settleBudget(runId);
          this.transitionTask(task.id, interrupted ? 'CANCELLED' : 'ACTIVE');
          this.appendEventRecord(task, runId, turnId, 'turn.statusChanged', {
            status: interrupted ? 'CANCELLED' : 'FAILED',
            code: event.code,
            retryable: event.retryable,
          });
        });
        tx();
        break;
      }
      default:
        break; // delta/tool 事件 M0 不落库（流式与工具明细归 DEV-07/14 展示层）
    }
  }

  private insertThreadReply(task: TaskRow, turnId: string, messageId: string, text: string): void {
    // 消息身份以 turn 为命名空间：同 turn 内重放去重（RT-05），跨 turn/会话的同名 provider id 不冲突。
    const rowId = `msg_${turnId}_${messageId}`;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM messages WHERE id = ?')
        .get(rowId) as { id: string } | undefined;
      if (existing != null) return; // 重放去重（RT-05）
      const convSeq = this.db
        .prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_id) as { last_message_seq: number };
      const threadSeq = this.db
        .prepare('UPDATE conversation_threads SET last_message_seq = last_message_seq + 1, revision = revision + 1 WHERE id = ? RETURNING last_message_seq')
        .get(task.conversation_thread_id) as { last_message_seq: number };
      const author = this.db
        .prepare('SELECT member_id FROM agent_turns WHERE id = ?')
        .get(turnId) as { member_id: string } | undefined;
      this.db.prepare(
        `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
           thread_message_seq, author_type, author_id, body_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, 'final', ?)`,
      ).run(
        rowId,
        task.project_id,
        task.conversation_id,
        convSeq.last_message_seq,
        task.room_id,
        task.conversation_thread_id,
        task.id,
        threadSeq.last_message_seq,
        author?.member_id ?? 'unknown_member',
        JSON.stringify({ text }),
        Date.now(),
      );
      appendDomainEvent(this.db, {
        schemaVersion: 1,
        eventId: `evt_${randomUUID()}`,
        projectId: task.project_id,
        conversationId: task.conversation_id,
        threadId: task.conversation_thread_id,
        taskId: task.id,
        turnId,
        kind: 'thread.replyAdded',
        createdAt: Date.now(),
        payload: { messageId: `msg_${messageId}` },
      });
    });
    tx();
  }

  private casTurn(turnId: string, status: string): void {
    // 允许从任何非终态（含 STOPPING）迁移；终态不可覆盖（§10.2）。
    this.db
      .prepare(`UPDATE agent_turns SET status = ? WHERE id = ? AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','UNKNOWN')`)
      .run(status, turnId);
  }

  private settleBudget(runId: string): void {
    const row = this.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string } | undefined;
    if (row?.budget_json == null) return;
    const state = JSON.parse(row.budget_json) as BudgetState;
    const settled = settleTurns(state, 1);
    this.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(settled), runId);
  }

  private transitionTask(taskId: string, status: string): void {
    const info = this.db
      .prepare('UPDATE tasks SET status = ?, revision = revision + 1 WHERE id = ? AND status != ?')
      .run(status, taskId, status);
    if (info.changes > 0) {
      const task = this.db.prepare('SELECT project_id, conversation_id, conversation_thread_id FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      this.appendEventRecord(task, null, null, 'task.statusChanged', { status });
    }
  }

  private appendEventRecord(
    task: TaskRow,
    runId: string | null,
    turnId: string | null,
    kind: string,
    payload: unknown,
  ): void {
    appendDomainEvent(this.db, {
      schemaVersion: 1,
      eventId: `evt_${randomUUID()}`,
      projectId: task.project_id,
      conversationId: task.conversation_id,
      threadId: task.conversation_thread_id,
      taskId: task.id,
      runId: runId ?? undefined,
      turnId: turnId ?? undefined,
      kind,
      createdAt: Date.now(),
      payload,
    });
  }
}

function parseInitialTaskId(dispatchKey: string): string | null {
  const m = dispatchKey.match(/^task:(.+):initial$/);
  return m?.[1] ?? null;
}

function isTurnTerminalStatus(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(status);
}

export { isRunTerminal };
