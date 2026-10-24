import type {
  PreDispatchFailureEventKind,
  PreDispatchFailureProjection,
} from '../contracts/taskDetails.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { assessTaskRedispatchReadiness } from '../persistence/stores/recoveryGuard.ts';

const preDispatchFailureKinds = [
  'task.contextAssemblyFailed',
  'task.deliberationPrepareFailed',
  'task.memberDisabledBlocked',
] as const satisfies readonly PreDispatchFailureEventKind[];

const fallbackReason = (kind: PreDispatchFailureEventKind): string => {
  if (kind === 'task.memberDisabledBlocked') return 'member-disabled';
  if (kind === 'task.deliberationPrepareFailed') return 'deliberation-preparation-failed';
  return 'context-assembly-failed';
};

/**
 * Human guidance is derived from the durable event kind/reason. Unknown reasons
 * receive a conservative instruction and never receive guessed configuration facts.
 */
export function preDispatchFailureAction(
  kind: PreDispatchFailureEventKind,
  reason: string,
  recoveryEligible = false,
): PreDispatchFailureProjection['action'] {
  if (recoveryEligible) {
    return {
      kind: 'resubmit-original-message',
      instruction: '仅需分析可选择仅分析继续，原消息与成员不变；可写执行仍需完整基线。',
    };
  }
  if (kind === 'task.memberDisabledBlocked') {
    return {
      kind: 'resubmit-original-message',
      instruction: '重新启用执行成员并确认当前配置后，从原对话按原消息重新提交；系统不会自动恢复旧授权。',
    };
  }
  if (reason === 'write-baseline-incomplete') {
    return {
      kind: 'resubmit-original-message',
      instruction: '处理目录扫描失败、越界路径或超限清单（例如项目外 junction/symlink、生成目录），再按原消息重新提交；不会自动重放。',
    };
  }
  if (reason === 'write-baseline-failed') {
    return {
      kind: 'resubmit-original-message',
      instruction: '恢复项目目录的可读性并确认当前成员配置后，再按原消息重新提交。',
    };
  }
  if (reason === 'write-authorization-changed') {
    return {
      kind: 'resubmit-original-message',
      instruction: '重新确认当前成员、项目和写入权限后，按原消息重新提交；系统不会自动沿用或恢复旧授权。',
    };
  }
  if (reason === 'invalid-thread-deliberation-budget') {
    return {
      kind: 'resubmit-original-message',
      instruction: '修正研讨预算配置后，按原消息重新提交；损坏的旧预算不会被复用。',
    };
  }
  if (kind === 'task.deliberationPrepareFailed') {
    return {
      kind: 'resubmit-original-message',
      instruction: '检查提示中的研讨成员、模型和配置，再按原消息重新提交；系统不会自动恢复旧授权。',
    };
  }
  return {
    kind: 'resubmit-original-message',
    instruction: '按提示检查项目路径、成员绑定和派发条件，处理后从原对话按原消息重新提交。',
  };
}

interface TaskRow {
  id: string;
  project_id: string;
  conversation_id: string;
  conversation_thread_id: string | null;
  room_id: string | null;
  status: string;
  revision: number;
  stop_generation: number;
  owner_member_id: string | null;
  project_status: string;
  owner_enabled: number | null;
  conversation_archived_at: number | null;
  room_archived_at: number | null;
}

interface FailureRow {
  seq: number;
  kind: PreDispatchFailureEventKind;
  created_at: number;
  payload_json: string;
}

interface OutboxRow {
  id: number;
  dispatch_key: string;
  status: 'done' | 'failed';
}

/**
 * Read the one current, confirmed pre-dispatch failure for a task.
 *
 * This projection deliberately requires zero workflow runs, agent turns, and
 * real-call ledger rows. It also refuses queued/leased work and superseded
 * failure events, so an UNKNOWN/in-flight attempt or a later redispatch can
 * never be relabelled as NOT_STARTED from an older event.
 */
export function readPreDispatchFailure(
  db: ZhongshuoDatabase,
  taskId: string,
): PreDispatchFailureProjection | null {
  const task = db.prepare(`
    SELECT t.id, t.project_id, t.conversation_id, t.conversation_thread_id, t.room_id,
           t.status, t.revision, t.stop_generation, t.owner_member_id,
           p.status AS project_status, owner.enabled AS owner_enabled,
           c.archived_at AS conversation_archived_at, rm.archived_at AS room_archived_at
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN conversations c ON c.id = t.conversation_id AND c.project_id = t.project_id
    LEFT JOIN rooms rm ON rm.id = t.room_id AND rm.project_id = t.project_id
    LEFT JOIN project_members owner
      ON owner.id = t.owner_member_id AND owner.project_id = t.project_id
    WHERE t.id = ?
  `).get(taskId) as TaskRow | undefined;
  if (task == null || task.status !== 'BLOCKED') return null;

  const counts = db.prepare(`
    SELECT
      (SELECT count(*) FROM workflow_runs WHERE task_id = ?) AS runs,
      (SELECT count(*) FROM agent_turns a JOIN workflow_runs r ON r.id = a.run_id
        WHERE r.task_id = ?) AS turns,
      (SELECT count(*) FROM real_calls WHERE task_id = ?) AS calls
  `).get(taskId, taskId, taskId) as { runs: number; turns: number; calls: number };
  if (counts.runs !== 0 || counts.turns !== 0 || counts.calls !== 0) return null;

  const pending = db.prepare(`
    SELECT 1 FROM outbox
    WHERE status IN ('pending','leased')
      AND (dispatch_key LIKE 'task:' || ? || ':%'
        OR dispatch_key LIKE 'dmtask:' || ? || ':%')
    LIMIT 1
  `).get(taskId, taskId);
  if (pending != null) return null;

  const failure = db.prepare(`
    SELECT seq, kind, created_at, payload_json
    FROM domain_events
    WHERE task_id = ? AND kind IN (
      'task.contextAssemblyFailed',
      'task.deliberationPrepareFailed',
      'task.memberDisabledBlocked'
    )
    ORDER BY seq DESC LIMIT 1
  `).get(taskId) as FailureRow | undefined;
  if (failure == null || !preDispatchFailureKinds.includes(failure.kind)) return null;

  // Worker order is task.statusChanged(BLOCKED) before the failure audit.
  // A later status transition or redispatch makes this failure historical.
  const laterStatus = db.prepare(`
    SELECT seq FROM domain_events
    WHERE task_id = ? AND kind = 'task.statusChanged' AND seq > ?
    ORDER BY seq DESC LIMIT 1
  `).get(taskId, failure.seq) as { seq: number } | undefined;
  if (laterStatus != null) return null;
  const laterRedispatch = db.prepare(`
    SELECT seq FROM domain_events
    WHERE task_id = ? AND kind = 'task.redispatchEnqueued' AND seq > ?
    ORDER BY seq DESC LIMIT 1
  `).get(taskId, failure.seq) as { seq: number } | undefined;
  if (laterRedispatch != null) return null;

  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(failure.payload_json) as unknown;
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed audit payload remains a confirmed failure, but contributes no guessed facts.
  }
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  const reason = text(payload.reason) ?? fallbackReason(failure.kind);
  const message = text(payload.message) ?? text(payload.note) ?? reason;
  const payloadMemberId = text(payload.memberId);
  const memberId = payloadMemberId ?? task.owner_member_id;
  const member = memberId == null
    ? undefined
    : db.prepare(`
        SELECT display_name, enabled FROM project_members
        WHERE id = ? AND project_id = ?
      `).get(memberId, task.project_id) as { display_name: string; enabled: number } | undefined;

  const outbox = db.prepare(`
    SELECT id, dispatch_key, status FROM outbox
    WHERE status IN ('done','failed')
      AND (dispatch_key LIKE 'task:' || ? || ':%'
        OR dispatch_key LIKE 'dmtask:' || ? || ':%')
    ORDER BY id DESC LIMIT 1
  `).get(taskId, taskId) as OutboxRow | undefined;
  const baselineRecoveryEligible =
    failure.kind === 'task.contextAssemblyFailed'
    && (reason === 'write-baseline-incomplete' || reason === 'write-baseline-failed')
    && task.stop_generation === 0
    && task.owner_member_id != null
    && task.owner_enabled === 1
    && task.project_status === 'active'
    && task.conversation_archived_at == null
    && (task.room_id == null || task.room_archived_at == null)
    && assessTaskRedispatchReadiness(db, task.id) == null;
  const recoveryBinding = baselineRecoveryEligible ? {
    method: 'task.redispatch' as const,
    taskId: task.id,
    expectedTaskRevision: task.revision,
    expectedStopGeneration: 0 as const,
    sourceRunId: null,
  } : undefined;

  return {
    state: 'NOT_STARTED',
    taskId: task.id,
    conversationId: task.conversation_id,
    threadId: task.conversation_thread_id,
    memberId,
    memberName: member?.display_name ?? null,
    memberEnabled: member == null ? null : member.enabled === 1,
    event: {
      seq: failure.seq,
      kind: failure.kind,
      at: failure.created_at,
      reason,
      message,
    },
    runCount: 0,
    turnCount: 0,
    callCount: 0,
    callStarted: false,
    outbox: outbox == null ? null : {
      id: outbox.id,
      dispatchKey: outbox.dispatch_key,
      status: outbox.status,
    },
    action: preDispatchFailureAction(failure.kind, reason, baselineRecoveryEligible),
    ...(recoveryBinding == null ? {} : { recoveryBinding }),
  };
}
