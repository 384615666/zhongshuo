/**
 * outbox 派发 worker（§11.2/§11.3）：CAS 领取 → 建 run/turn/session → 经适配器执行 →
 * 规范化事件落库（消息入正确线程）→ 预算结算 → completeOutbox。
 *
 * 防线（修复轮 2026-09-27 收口）：
 * - 派发门禁：恢复后 dispatch_gate=held，worker 不领取，等用户确认继续（§16.4-6/决策 44/E7）。
 * - 崩溃重领对账：dispatch_key 已有 turn（DISPATCHING 不确定窗口）→ 不再执行，标 failed 留审计（RT-03 语义）。
 * - 模式门禁：M0 仅 DIRECT；AUTO/DELIBERATE 任务进 BLOCKED，不冒充执行（总任务书 §6.1）。
 * - 会话打开竞态：openSession 返回后复查停止代次/终态，停止已生效则不 startTurn。
 * - 独立截止计时：沉默 runtime 也会按时中断；中断后宽限内仍无终结 → UNKNOWN（结果不确定，不伪造）。
 * - 验收策略收尾：user_review → REVIEW + pending 交付；auto_deliver → DONE + not_required（§10.5）。
 * - 迟到完成不复活停止：turn 已 STOPPING 时完成事件走取消收尾并留 lateCompletion 审计（RT-06 形态）。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { claimNextOutbox, completeOutbox, failOutbox } from '../persistence/outbox.ts';
import type { OutboxRow } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { isDispatchGateHeld } from '../persistence/daemonState.ts';
import type { RuntimeAdapter, NormalizedRuntimeEvent } from '../contracts/runtime.ts';
import type { TopLevelRouteOutcome } from '../contracts/routing.ts';
import type { BudgetState } from '../contracts/budget.ts';
import { settleTurns } from '../domain/budget.ts';
import { filterContextScope } from '../domain/isolation/contextFilter.ts';
import type { ContextBundleDraft } from '../contracts/contextBundle.ts';

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
  title: string;
  objective: string | null;
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
  /** 单 turn 截止（独立于事件流计时）：超时先中断。 */
  turnDeadlineMs?: number;
  /** 中断后的等待上限：仍无终结 → UNKNOWN。 */
  interruptGraceMs?: number;
  /** DIRECT 预算上限（决策 12：6）。 */
  maxTurns?: number;
}

export class DispatchWorker {
  private readonly db: ZhongshuoDatabase;
  private readonly adapter: RuntimeAdapter;
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly turnDeadlineMs: number;
  private readonly interruptGraceMs: number;
  private readonly maxTurns: number;
  private readonly live = new Map<string, { turnId: string; sessionId: string }>();

  constructor(options: DispatchWorkerOptions) {
    this.db = options.db;
    this.adapter = options.adapter;
    this.leaseOwner = options.leaseOwner;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.turnDeadlineMs = options.turnDeadlineMs ?? 60_000;
    this.interruptGraceMs = options.interruptGraceMs ?? 5_000;
    this.maxTurns = options.maxTurns ?? 6;
  }

  /** 处理一条 outbox 项；返回是否处理了（门禁 held/无项返回 false）。 */
  async runOnce(now = Date.now()): Promise<boolean> {
    if (isDispatchGateHeld(this.db)) return false;
    const claimed = claimNextOutbox(this.db, {
      leaseOwner: this.leaseOwner,
      leaseUntil: now + this.leaseMs,
      now,
    });
    if (claimed == null) return false;
    await this.dispatchClaimed(claimed);
    return true;
  }

  /** 排空当前可领取的 outbox（门禁 held 时为 0）。 */
  async drain(now = Date.now()): Promise<number> {
    let processed = 0;
    while (await this.runOnce(now)) processed += 1;
    return processed;
  }

  /** 停止流程回调：向在途 turn 发送协议中断（§16.3）。 */
  async interruptTurn(turnId: string): Promise<void> {
    const liveEntry = this.live.get(turnId);
    if (liveEntry == null) return;
    await this.adapter.interrupt({ id: liveEntry.sessionId } as never, turnId);
  }

  private async dispatchClaimed(claimed: OutboxRow): Promise<void> {
    const taskId = parseInitialTaskId(claimed.dispatch_key);
    if (taskId == null) {
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    // 崩溃重领对账：dispatch_key 已有 turn（上次领取进入过 DISPATCHING，副作用不确定）→
    // 不再执行；标 failed 留审计，等人工/恢复流程核对（RT-03 RECONCILE 语义）。
    const existingTurn = this.db
      .prepare('SELECT id, status FROM agent_turns WHERE dispatch_key = ?')
      .get(claimed.dispatch_key) as { id: string; status: string } | undefined;
    if (existingTurn != null) {
      failOutbox(this.db, claimed.id, claimed.attempt_epoch);
      const taskRow = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
      if (taskRow != null) {
        this.audit(taskRow, null, existingTurn.id, 'run.reconcileRequired', {
          dispatchKey: claimed.dispatch_key,
          existingTurnId: existingTurn.id,
          reason: 'crash-reclaimed-dispatch',
        });
      }
      return;
    }

    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (task == null || task.stop_generation > 0 || task.status === 'CANCELLED' || task.status === 'DONE') {
      // 全停代次/终态阻止旧派发（§11.4）。
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    const route = task.route_json != null ? (JSON.parse(task.route_json) as TopLevelRouteOutcome) : null;
    // 模式门禁：M0 仅 DIRECT；AUTO/DELIBERATE 未实现前明确不可用，不冒充单成员执行。
    if (route == null || route.kind !== 'dispatch' || route.mode !== 'DIRECT') {
      await this.transitionTask(task.id, 'BLOCKED');
      this.audit(task, null, null, 'task.statusChanged', {
        status: 'BLOCKED',
        reason: 'mode_unavailable_in_m0',
        mode: route?.kind === 'dispatch' ? route.mode : null,
      });
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

    const runId = `run_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    const budget: BudgetState = {
      grantId: runId,
      maxTurns: this.maxTurns,
      usedTurns: 0,
      inFlightReservedTurns: 1,
    };

    const createRun = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json)
         VALUES (?, ?, ?, ?, 'DIRECT', 0, 'RUNNING', ?)`,
      ).run(runId, task.id, task.conversation_id, task.conversation_thread_id, JSON.stringify(budget));
      this.db.prepare(
        `INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES (?, ?, 'owner', 1, 'active')`,
      ).run(runId, member.id);
      this.db.prepare(
        `INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch)
         VALUES (?, ?, ?, ?, ?, 'direct.work', 'RUNNING', ?, 1, 1)`,
      ).run(turnId, runId, task.conversation_id, task.conversation_thread_id, member.id, claimed.dispatch_key);
      this.db.prepare('UPDATE outbox SET turn_id = ? WHERE id = ?').run(turnId, claimed.id);
      this.transitionTask(task.id, 'ACTIVE');
      this.audit(task, runId, turnId, 'run.created', { mode: 'DIRECT' });
    });
    createRun();

    // 会话：任务/成员/generation 维度（§13.4）。
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
    ).run(
      session.id, task.project_id, task.conversation_id, task.conversation_thread_id,
      member.id, task.id, generation.c, project.canonical_path,
    );

    // 会话打开竞态复查（修复轮）：停止/终态在 openSession await 期间生效 → 不启动 turn。
    if (this.stoppingOrTerminal(task.id, turnId)) {
      await this.adapter.close(session);
      const cancel = this.db.transaction(() => {
        this.casTurn(turnId, 'CANCELLED');
        this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ? AND status NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')`).run(runId);
        this.transitionTask(task.id, 'CANCELLED');
        this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: 'stop-during-session-open' });
      });
      cancel();
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }

    this.live.set(turnId, { turnId, sessionId: session.id });

    try {
      // 输入组装：按 §13.4 过滤后落 ContextBundle（隔离接入派发路径；模板文本 DEV-21-M0 完善）。
      const bundle = this.buildContextBundle(task, turnId);
      await this.adapter.startTurn(session, {
        turnId,
        dispatchKey: claimed.dispatch_key,
        inputBundleId: bundle.id,
        text: JSON.stringify({
          schema: 'zs-context-v0',
          bundleId: bundle.id,
          directive: { title: task.title, objective: task.objective },
          included: bundle.includedRefs,
        }),
        policyId: 'policy-analyze',
        taskRevision: 0,
      });
      await this.consumeUntilTerminal(task, runId, turnId, session.id);
    } finally {
      this.live.delete(turnId);
    }
    await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
  }

  /** 服务端解析的真实归属组装输入（§13.4）：指令 + 本线程历史；拒绝项如实记录。 */
  private buildContextBundle(task: TaskRow, turnId: string): { id: string; hash: string; includedRefs: unknown[] } {
    const threadMessages = this.db
      .prepare('SELECT id FROM messages WHERE thread_id = ? ORDER BY thread_message_seq')
      .all(task.conversation_thread_id) as Array<{ id: string }>;
    const directiveRef = { kind: 'directive' as const, refId: `task:${task.id}:goal` };
    const requested = [
      directiveRef,
      ...threadMessages.map((m) => ({ kind: 'message' as const, refId: m.id })),
    ];
    const filtered = filterContextScope({
      task: { id: task.id, threadId: task.conversation_thread_id },
      threadMessageIds: threadMessages.map((m) => m.id),
      allowedDirectives: [`task:${task.id}:goal`],
      allowedSummaries: [`thread:${task.conversation_thread_id}:summary`],
      allowedBaselineIds: [],
      grantedRefs: [],
      requestedRefs: requested,
    });
    const included = filtered.ok ? filtered.value.included : [];
    const rejected = filtered.ok ? filtered.value.rejected : [{ refId: 'all', reason: 'CONTEXT_NOT_GRANTED' as const }];
    const draft: ContextBundleDraft = {
      turnId,
      threadId: task.conversation_thread_id,
      taskRevision: 0,
      baselineId: null,
      includedRefs: included,
      scopeGrants: [],
    };
    const hash = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    const bundleId = `cb_${hash.slice(0, 24)}`;
    this.db.prepare(
      `INSERT INTO context_bundles (id, turn_id, thread_id, task_revision, baseline_id, included_refs_json, scope_grants_json, hash)
       VALUES (?, ?, ?, 0, NULL, ?, '[]', ?)`,
    ).run(bundleId, turnId, task.conversation_thread_id, JSON.stringify({ included, rejected }), hash);
    return { id: bundleId, hash, includedRefs: included };
  }

  private stoppingOrTerminal(taskId: string, turnId: string): boolean {
    const task = this.db
      .prepare('SELECT stop_generation, status FROM tasks WHERE id = ?')
      .get(taskId) as { stop_generation: number; status: string } | undefined;
    if (task == null) return true;
    if (task.stop_generation > 0 || task.status === 'CANCELLED' || task.status === 'DONE') return true;
    const turn = this.db
      .prepare('SELECT status FROM agent_turns WHERE id = ?')
      .get(turnId) as { status: string } | undefined;
    if (turn == null || ['STOPPING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(turn.status)) {
      return true;
    }
    return false;
  }

  /**
   * 消费事件直到终结；截止计时独立于事件流（沉默 runtime 也会按时中断）。
   * 中断后宽限内仍无终结 → UNKNOWN（§10.2 结果不确定，不伪造成功/失败）。
   * 实现注意：async iterator 不允许并发 next——race 输掉的读取必须保留复用，
   * 否则被丢弃的 next() 会吞掉一条事件（修复轮实测缺陷）。
   */
  private async consumeUntilTerminal(task: TaskRow, runId: string, turnId: string, sessionId: string): Promise<void> {
    const deadline = Date.now() + this.turnDeadlineMs;
    const interruptDeadline = deadline + this.interruptGraceMs;
    const iterator = this.adapter.events({ id: sessionId } as never)[Symbol.asyncIterator]();
    let interruptSent = false;
    let pending: Promise<IteratorResult<NormalizedRuntimeEvent, undefined>> | null = null;

    for (;;) {
      const now = Date.now();
      const wakeAt = interruptSent ? interruptDeadline : deadline;
      const waitMs = Math.max(1, wakeAt - now);
      const nextPromise: Promise<IteratorResult<NormalizedRuntimeEvent, undefined>> =
        pending ?? iterator.next();
      pending = null;
      const winner = await Promise.race([
        nextPromise,
        new Promise<'timer'>((resolve) => setTimeout(() => resolve('timer'), waitMs)),
      ]);
      if (winner === 'timer') {
        pending = nextPromise; // 保留进行中的读取，不吞事件
        const at = Date.now();
        if (!interruptSent && at >= deadline) {
          interruptSent = true;
          await this.adapter.interrupt({ id: sessionId } as never, turnId);
          continue;
        }
        if (interruptSent && at >= interruptDeadline) break; // 中断后仍无终结：不确定
        continue;
      }
      if (winner.done) break;
      const event = winner.value;
      if (event.sessionId !== sessionId) continue;

      if (event.turnId != null && event.turnId !== turnId) {
        this.audit(task, runId, turnId, 'turn.lateEventArrived', { eventKey: event.eventKey, kind: event.kind });
        continue;
      }
      const turnRow = this.db
        .prepare('SELECT status FROM agent_turns WHERE id = ?')
        .get(turnId) as { status: string } | undefined;
      if (turnRow == null) break;
      if (isTurnTerminalStatus(turnRow.status)) break;

      this.applyEvent(task, runId, turnId, event);
      if (event.kind === 'turn.completed' || event.kind === 'turn.failed') return;
    }

    const current = this.db
      .prepare('SELECT status FROM agent_turns WHERE id = ?')
      .get(turnId) as { status: string } | undefined;
    if (current != null && !isTurnTerminalStatus(current.status)) {
      const tx = this.db.transaction(() => {
        this.db.prepare(`UPDATE agent_turns SET status = 'UNKNOWN' WHERE id = ?`).run(turnId);
        this.db.prepare(`UPDATE workflow_runs SET status = 'INTERRUPTED' WHERE id = ?`).run(runId);
        this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'UNKNOWN', reason: 'no-terminal-after-deadline' });
      });
      tx();
    }
  }

  private applyEvent(task: TaskRow, runId: string, turnId: string, event: NormalizedRuntimeEvent): void {
    switch (event.kind) {
      case 'turn.started': {
        const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
        if (turn.status === 'STOPPING') {
          // 停止先于开始回执生效：不回到 RUNNING，再发中断并留审计。
          this.audit(task, runId, turnId, 'turn.stoppingRace', { note: 'turn.started after stop; re-interrupting' });
          void this.adapter.interrupt({ id: event.sessionId } as never, turnId);
          break;
        }
        this.casTurn(turnId, 'RUNNING');
        break;
      }
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
        const turn = this.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turnId) as { status: string };
        const lateAfterStop = turn.status === 'STOPPING';
        const tx = this.db.transaction(() => {
          if (lateAfterStop) {
            // 停止已生效：迟到完成不复活任务（RT-06 形态），按取消收尾并留审计。
            this.casTurn(turnId, 'CANCELLED');
            this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?`).run(runId);
            this.settleBudget(runId);
            this.transitionTask(task.id, 'CANCELLED');
            this.audit(task, runId, turnId, 'turn.lateCompletion', { finalText: event.finalText ?? null });
            this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'CANCELLED', reason: 'late-completion-after-stop' });
            return;
          }
          this.casTurn(turnId, 'SUCCEEDED');
          this.db.prepare(`UPDATE workflow_runs SET status = 'SUCCEEDED' WHERE id = ?`).run(runId);
          this.settleBudget(runId);
          // 交付与验收（§10.5）：按任务快照策略收尾；user_review 进 REVIEW + pending 交付（唯一待办）。
          const finalText = event.finalText ?? '';
          const manifestHash = createHash('sha256').update(finalText).digest('hex');
          const deliveryId = `dlv_${turnId}`;
          const reviewStatus = task.review_policy === 'user_review' ? 'pending' : 'not_required';
          this.db.prepare(
            `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json,
               change_set_refs_json, verification_refs_json, review_status)
             VALUES (?, ?, ?, 1, ?, ?, '[]', '[]', ?)`,
          ).run(deliveryId, task.id, runId, manifestHash, JSON.stringify([`turn:${turnId}:final`]), reviewStatus);
          this.db.prepare('UPDATE tasks SET current_delivery_id = ? WHERE id = ?').run(deliveryId, task.id);
          this.transitionTask(task.id, task.review_policy === 'user_review' ? 'REVIEW' : 'DONE');
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'SUCCEEDED', reviewStatus });
        });
        tx();
        break;
      }
      case 'turn.failed': {
        const tx = this.db.transaction(() => {
          const interrupted = event.code === 'INTERRUPTED';
          this.casTurn(turnId, interrupted ? 'CANCELLED' : 'FAILED');
          this.db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(interrupted ? 'CANCELLED' : 'FAILED', runId);
          this.settleBudget(runId);
          this.transitionTask(task.id, interrupted ? 'CANCELLED' : 'ACTIVE');
          this.audit(task, runId, turnId, 'turn.statusChanged', {
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
      if (existing != null) return;
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
        rowId, task.project_id, task.conversation_id, convSeq.last_message_seq,
        task.room_id, task.conversation_thread_id, task.id, threadSeq.last_message_seq,
        author?.member_id ?? 'unknown_member', JSON.stringify({ text }), Date.now(),
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
        payload: { messageId: rowId }, // 与数据库行 ID 一致（UI 按事件可定位到消息）
      });
    });
    tx();
  }

  private casTurn(turnId: string, status: string): void {
    // 终态不可覆盖（§10.2）；允许 STOPPING→终态迁移。
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
      const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      this.audit(task, null, null, 'task.statusChanged', { status });
    }
  }

  private audit(
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
