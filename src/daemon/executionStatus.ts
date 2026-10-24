import type {
  TaskArtifactOutcome,
  TaskBusinessActivity,
  TaskChangeSetOutcome,
  TaskDeliveryOutcome,
  TaskExecutionAction,
  TaskExecutionMember,
  TaskExecutionPhase,
  TaskExecutionReason,
  TaskExecutionResults,
  TaskExecutionStatus,
  TaskUserWait,
} from '../contracts/executionStatus.ts';
import type { ThreadVisibleProgress } from '../contracts/runtimeProgress.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { assessTaskRedispatchReadiness } from '../persistence/stores/recoveryGuard.ts';
import { readPreDispatchFailure } from './preDispatchFailure.ts';
import { readExecutionBlocker } from './taskDetails.ts';
import { readDmProgress, readThreadProgress } from './threadMembers.ts';

interface TaskRow {
  id: string;
  project_id: string;
  conversation_id: string;
  kind: 'room_task' | 'dm_turn';
  room_id: string | null;
  conversation_thread_id: string | null;
  status: string;
  revision: number;
  stop_generation: number;
  owner_member_id: string | null;
  owner_display_name: string | null;
  title: string;
  current_delivery_id: string | null;
  conversation_kind: 'room' | 'dm';
}

interface ScopeTaskRow {
  id: string;
  parent_task_id: string | null;
  owner_member_id: string | null;
  owner_display_name: string | null;
  title: string;
  status: string;
  room_id: string | null;
  conversation_thread_id: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  mode: string;
  status: string;
  stage: string | null;
  rowid: number;
}

interface TurnRow {
  id: string;
  run_id: string;
  task_id: string;
  member_id: string;
  display_name: string;
  status: string;
  stage_key: string;
  turn_purpose: string;
  exec_started_at: number | null;
  protection_state: string | null;
}

interface EventRow {
  seq: number;
  kind: string;
  created_at: number;
  task_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  member_id: string | null;
  message_body_json: string | null;
  payload_json: string;
}

interface OutboxRow {
  id: number;
  dispatch_key: string;
  status: 'pending' | 'leased';
  lease_until: number | null;
}

interface DeliveryRow {
  id: string;
  task_id: string;
  run_id: string | null;
  revision: number;
  manifest_hash: string;
  review_status: TaskDeliveryOutcome['reviewStatus'];
  artifact_refs_json: string;
  change_set_refs_json: string;
}

type JsonObject = Record<string, unknown>;

const ACTIVE_TURN_STATUSES = new Set([
  'PENDING',
  'DISPATCHING',
  'RUNNING',
  'WAITING_APPROVAL',
  'WAITING_INPUT',
  'STOPPING',
]);
const ACTIVE_RUN_STATUSES = new Set(['QUEUED', 'RUNNING', 'WAITING', 'STOPPING']);

const BUSINESS_EVENT_KINDS = [
  'tool.started',
  'tool.completed',
  'message.completed',
  'thread.replyAdded',
  'turn.workClarification',
  'turn.outputNaturalConversation',
  'turn.conversationWorkObserved',
  'changeset.baselineCaptured',
  'run.stepArtifact',
  'run.stepFailed',
  'run.visibleStageDocument',
  'run.visibleStageDocumentFallback',
  'run.shortExchangeCompleted',
  'run.finalReportPublished',
  'coordination.planAccepted',
  'coordination.stepQueued',
  'coordination.integrationQueued',
  'coordination.completed',
] as const;

const FAILURE_EVENT_KINDS = [
  'task.statusChanged',
  'task.contextAssemblyFailed',
  'task.deliberationPrepareFailed',
  'task.memberDisabledBlocked',
  'coordination.blocked',
  'run.deliberationBlocked',
  'run.reconcileRequired',
  'run.failed',
  'run.stepFailed',
  'turn.startupFailed',
  'turn.failed',
  'turn.outputInvalid',
] as const;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function parseObject(raw: string | null): JsonObject {
  if (raw == null) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function boundedText(value: unknown, max = 280): string | null {
  const text = str(value);
  if (text == null) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function refs(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function readPayloadMessage(payload: JsonObject): string | null {
  return boundedText(payload.message)
    ?? boundedText(payload.question)
    ?? boundedText(payload.reason)
    ?? boundedText(payload.note)
    ?? boundedText(payload.resultSummary)
    ?? boundedText(payload.status);
}

function activityFromProgress(progress: ThreadVisibleProgress | undefined) {
  if (progress == null) return null;
  const active = [...(progress.activities ?? [])].reverse().find(item => item.status === 'started');
  const activity = active ?? progress.activities?.at(-1);
  if (activity != null) {
    const action = activity.action === 'read' ? '读取'
      : activity.action === 'search' ? '搜索'
        : activity.action === 'command' ? '执行命令'
          : activity.action === 'edit' ? '编辑'
            : '工具活动';
    return {
      kind: 'tool' as const,
      action:activity.action,
      summary: `${action}${activity.target.length > 0 ? ` · ${activity.target}` : ''}`,
      status: activity.status === 'started' ? 'started' as const : 'completed' as const,
      toolCallId: activity.toolCallId,
    };
  }
  if (progress.text != null && progress.text.trim().length > 0) {
    return {
      kind: 'model' as const,
      summary: progress.text.trim().slice(0, 240),
      status: 'started' as const,
      toolCallId: null,
    };
  }
  return {
    kind: 'model' as const,
    summary: '执行轮次已开始，尚无新的持久活动',
    status: 'started' as const,
    toolCallId: null,
  };
}

function failureReasonFromEvent(event: EventRow | undefined): string | null {
  if (event == null) return null;
  const payload = parseObject(event.payload_json);
  if (event.kind === 'task.statusChanged' && payload.status !== 'BLOCKED') return null;
  return readPayloadMessage(payload);
}

function businessEventLabel(event: EventRow): {
  kind: TaskBusinessActivity['kind'];
  summary: string;
} | null {
  const payload = parseObject(event.payload_json);
  if (event.kind === 'tool.started' || event.kind === 'tool.completed') {
    const target = str(payload.target);
    const toolName = str(payload.toolName) ?? '工具活动';
    return {
      kind: 'tool',
      summary: `${toolName}${target == null ? '' : ` · ${target}`}${event.kind === 'tool.completed' ? '（已结束）' : '（已开始）'}`,
    };
  }
  if (event.kind === 'thread.replyAdded' || event.kind === 'message.completed') {
    const body = parseObject(event.message_body_json);
    return {
      kind: 'reply',
      summary: boundedText(body.text) ?? boundedText(payload.message) ?? '已保存回复',
    };
  }
  if (event.kind === 'run.finalReportPublished') {
    return { kind: 'report', summary: boundedText(payload.summary) ?? '最终报告已发布' };
  }
  if (event.kind === 'run.stepArtifact') {
    return {
      kind: 'artifact',
      summary: boundedText(payload.kind) ?? boundedText(payload.message) ?? '阶段产物已保存',
    };
  }
  if (event.kind === 'run.visibleStageDocument' || event.kind === 'run.visibleStageDocumentFallback') {
    return { kind: 'artifact', summary: readPayloadMessage(payload) ?? '阶段文档已保存' };
  }
  if (event.kind === 'turn.workClarification') {
    return { kind: 'clarification', summary: readPayloadMessage(payload) ?? '等待明确补充' };
  }
  if (event.kind === 'turn.outputNaturalConversation' || event.kind === 'turn.conversationWorkObserved') {
    return { kind: 'reply', summary: readPayloadMessage(payload) ?? '已保存本轮业务结果' };
  }
  if (event.kind === 'changeset.baselineCaptured') {
    return { kind: 'artifact', summary: '写入基线已捕获' };
  }
  if (event.kind === 'coordination.planAccepted') {
    return { kind: 'planning', summary: boundedText(payload.summary) ?? '协作分工已登记' };
  }
  if (event.kind === 'coordination.stepQueued') {
    return { kind: 'handoff', summary: boundedText(payload.stepKey) ?? '同伴步骤已排队' };
  }
  if (event.kind === 'coordination.integrationQueued') {
    return { kind: 'handoff', summary: '成果整合已排队' };
  }
  if (event.kind === 'coordination.completed' || event.kind === 'run.shortExchangeCompleted') {
    return { kind: 'reply', summary: readPayloadMessage(payload) ?? '协作结果已完成' };
  }
  if (event.kind === 'run.stepFailed') {
    return null;
  }
  return null;
}

function readResults(
  db: ZhongshuoDatabase,
  task: TaskRow,
  scopeIds: string[],
): TaskExecutionResults {
  const marks = placeholders(scopeIds.length);
  const deliveriesRaw = db.prepare(
    `SELECT id,task_id,run_id,revision,manifest_hash,review_status,artifact_refs_json,change_set_refs_json
     FROM task_deliveries WHERE task_id IN (${marks})
     ORDER BY task_id,revision DESC,rowid DESC LIMIT 11`,
  ).all(...scopeIds) as DeliveryRow[];
  const deliveries = deliveriesRaw.slice(0, 10).map((row): TaskDeliveryOutcome => ({
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    revision: row.revision,
    manifestHash: row.manifest_hash,
    reviewStatus: row.review_status,
    artifactRefs: refs(row.artifact_refs_json),
    changeSetRefs: refs(row.change_set_refs_json),
    locate: `#delivery=${row.id}`,
  }));
  let currentDelivery = task.current_delivery_id == null
    ? null
    : deliveries.find(row => row.id === task.current_delivery_id) ?? null;
  if (task.current_delivery_id != null && currentDelivery == null) {
    const pinned = db.prepare(
      `SELECT id,task_id,run_id,revision,manifest_hash,review_status,artifact_refs_json,change_set_refs_json
       FROM task_deliveries WHERE id=? AND task_id=?`,
    ).get(task.current_delivery_id, task.id) as DeliveryRow | undefined;
    if (pinned != null) {
      currentDelivery = {
        id: pinned.id,
        taskId: pinned.task_id,
        runId: pinned.run_id,
        revision: pinned.revision,
        manifestHash: pinned.manifest_hash,
        reviewStatus: pinned.review_status,
        artifactRefs: refs(pinned.artifact_refs_json),
        changeSetRefs: refs(pinned.change_set_refs_json),
        locate: `#delivery=${pinned.id}`,
      };
    }
  }
  const pendingRow = db.prepare(
    `SELECT id,task_id,run_id,revision,manifest_hash,review_status,artifact_refs_json,change_set_refs_json
     FROM task_deliveries WHERE task_id=? AND review_status='pending'
     ORDER BY revision DESC,rowid DESC LIMIT 1`,
  ).get(task.id) as DeliveryRow | undefined;
  const pendingReviewDelivery = pendingRow == null ? null : {
    id: pendingRow.id,
    taskId: pendingRow.task_id,
    runId: pendingRow.run_id,
    revision: pendingRow.revision,
    manifestHash: pendingRow.manifest_hash,
    reviewStatus: pendingRow.review_status,
    artifactRefs: refs(pendingRow.artifact_refs_json),
    changeSetRefs: refs(pendingRow.change_set_refs_json),
    locate: `#delivery=${pendingRow.id}`,
  } satisfies TaskDeliveryOutcome;

  const artifactRows = db.prepare(
    `SELECT id,task_id,run_id,kind,revision,hash FROM artifacts
     WHERE task_id IN (${marks}) ORDER BY rowid DESC LIMIT 11`,
  ).all(...scopeIds) as Array<{
    id: string;
    task_id: string;
    run_id: string | null;
    kind: string;
    revision: number;
    hash: string;
  }>;
  const artifacts = artifactRows.slice(0, 10).map((row): TaskArtifactOutcome => ({
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    revision: row.revision,
    hash: row.hash,
    locate: `#artifact=${row.id}`,
  }));

  const changeRows = db.prepare(
    `SELECT id,task_id,application_status,before_ref,after_ref FROM change_sets
     WHERE task_id IN (${marks}) ORDER BY rowid DESC LIMIT 11`,
  ).all(...scopeIds) as Array<{
    id: string;
    task_id: string;
    application_status: TaskChangeSetOutcome['applicationStatus'];
    before_ref: string;
    after_ref: string;
  }>;
  const changeSets = changeRows.slice(0, 10).map((row): TaskChangeSetOutcome => ({
    id: row.id,
    taskId: row.task_id,
    applicationStatus: row.application_status,
    beforeRef: row.before_ref,
    afterRef: row.after_ref,
    locate: `#change-set=${row.id}`,
  }));

  return {
    hasResults: deliveries.length > 0 || artifacts.length > 0 || changeSets.length > 0,
    currentDelivery,
    pendingReviewDelivery,
    deliveries,
    artifacts,
    changeSets,
    truncated: {
      deliveries: deliveriesRaw.length > 10,
      artifacts: artifactRows.length > 10,
      changeSets: changeRows.length > 10,
    },
  };
}

/**
 * Read the one authoritative execution projection for a task.
 *
 * The projection merges the existing recovery guard, pre-dispatch projection,
 * execution blocker and persisted run/turn/event facts. It never writes, releases
 * protection, retries, re-enqueues or treats heartbeats as business progress.
 */
export function readTaskExecutionStatus(
  db: ZhongshuoDatabase,
  taskId: string,
): TaskExecutionStatus | null {
  const task = db.prepare(`
    SELECT t.id,t.project_id,t.conversation_id,t.kind,t.room_id,t.conversation_thread_id,
           t.status,t.revision,t.stop_generation,t.owner_member_id,t.title,t.current_delivery_id,
           pm.display_name AS owner_display_name,c.kind AS conversation_kind
    FROM tasks t
    LEFT JOIN project_members pm ON pm.id=t.owner_member_id AND pm.project_id=t.project_id
    JOIN conversations c ON c.id=t.conversation_id AND c.project_id=t.project_id
    WHERE t.id=?
  `).get(taskId) as TaskRow | undefined;
  if (task == null) return null;

  const scopeTasks = db.prepare(`
    WITH RECURSIVE scoped(id) AS (
      SELECT ?
      UNION ALL
      SELECT child.id FROM tasks child JOIN scoped parent ON child.parent_task_id=parent.id
    )
    SELECT t.id,t.parent_task_id,t.owner_member_id,pm.display_name AS owner_display_name,
           t.title,t.status,t.room_id,t.conversation_thread_id
    FROM scoped s JOIN tasks t ON t.id=s.id
    LEFT JOIN project_members pm ON pm.id=t.owner_member_id AND pm.project_id=t.project_id
    LIMIT 257
  `).all(task.id) as ScopeTaskRow[];
  if (!scopeTasks.some(row => row.id === task.id)) scopeTasks.unshift({
    id: task.id,
    parent_task_id: null,
    owner_member_id: task.owner_member_id,
    owner_display_name: task.owner_display_name,
    title: task.title,
    status: task.status,
    room_id: task.room_id,
    conversation_thread_id: task.conversation_thread_id,
  });
  const scopeIds = scopeTasks.map(row => row.id);
  const marks = placeholders(scopeIds.length);

  const runs = db.prepare(
    `SELECT rowid,id,task_id,mode,status,stage FROM workflow_runs
     WHERE task_id IN (${marks}) ORDER BY rowid DESC LIMIT 120`,
  ).all(...scopeIds) as RunRow[];
  const latestSelectedRun = db.prepare(
    `SELECT rowid,id,task_id,mode,status,stage FROM workflow_runs
     WHERE task_id=? ORDER BY rowid DESC LIMIT 1`,
  ).get(task.id) as RunRow | undefined;
  const runById = new Map(runs.map(run => [run.id, run]));
  if (latestSelectedRun != null) runById.set(latestSelectedRun.id, latestSelectedRun);
  const runIds = [...runById.keys()];
  const runMarks = runIds.length === 0 ? "''" : placeholders(runIds.length);

  const turns = runIds.length === 0 ? [] : db.prepare(
    `SELECT a.id,a.run_id,r.task_id,a.member_id,pm.display_name,a.status,a.stage_key,a.turn_purpose,
            a.exec_started_at,a.protection_state
     FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks tk ON tk.id=r.task_id
     JOIN project_members pm ON pm.id=a.member_id AND pm.project_id=tk.project_id
     WHERE a.run_id IN (${runMarks}) ORDER BY a.rowid DESC LIMIT 240`,
  ).all(...runIds) as TurnRow[];

  const activeTurns = turns.filter(turn => ACTIVE_TURN_STATUSES.has(turn.status));
  const stoppingTurns = activeTurns.filter(turn => turn.status === 'STOPPING');
  const performingTurns = activeTurns.filter(turn => turn.status === 'RUNNING');
  const activeRuns = runs.filter(run => ACTIVE_RUN_STATUSES.has(run.status));
  const stoppingRun = runs.find(run => run.status === 'STOPPING');

  const unknownTurns = db.prepare(
    `SELECT a.id,a.run_id,r.task_id,a.member_id,pm.display_name,a.status,a.stage_key,a.turn_purpose,
            a.exec_started_at,a.protection_state
     FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks tk ON tk.id=r.task_id
     JOIN project_members pm ON pm.id=a.member_id AND pm.project_id=tk.project_id
     WHERE r.task_id IN (${marks})
       AND (a.status='UNKNOWN' OR a.protection_state='retained')
       AND NOT EXISTS (
         SELECT 1 FROM domain_events e WHERE e.turn_id=a.id
           AND e.kind='recovery.protectionReleased'
           AND json_extract(e.payload_json,'$.released')=1
       )
     ORDER BY a.rowid DESC LIMIT 32`,
  ).all(...scopeIds) as TurnRow[];

  const outbox = db.prepare(
    `SELECT id,dispatch_key,status,lease_until FROM outbox
     WHERE status IN ('pending','leased')
       AND (${scopeIds.map(() => `dispatch_key LIKE 'task:' || ? || ':%' OR dispatch_key LIKE 'dmtask:' || ? || ':%'`).join(' OR ')})
     ORDER BY id LIMIT 64`,
  ).all(...scopeIds.flatMap(id => [id, id])) as OutboxRow[];

  const progress: ThreadVisibleProgress[] = task.kind === 'dm_turn'
    ? readDmProgress(db, task.conversation_id)
    : task.conversation_thread_id == null ? [] : readThreadProgress(db, task.conversation_thread_id);
  const progressByTurn = new Map(progress.map(item => [item.turnId, item]));

  const performingMembers = performingTurns.map((turn): TaskExecutionMember => {
    const live = progressByTurn.get(turn.id);
    const activity = activityFromProgress(live);
    return {
      memberId: turn.member_id,
      displayName: turn.display_name,
      state: 'performing',
      status: turn.status,
      taskId: turn.task_id,
      runId: turn.run_id,
      turnId: turn.id,
      stage: live?.stage ?? turn.stage_key,
      since: live?.executionStartedAt ?? turn.exec_started_at,
      lastActivityAt: live?.lastActivityAt ?? null,
      reason: activity?.summary ?? '执行轮次已开始，尚无新的持久活动',
      activity,
    };
  });

  const waitingByMember = new Map<string, TaskExecutionMember>();
  const addWaiting = (member: TaskExecutionMember): void => {
    const existing = waitingByMember.get(member.memberId);
    if (existing == null
      || existing.state === 'starting' && member.state !== 'starting'
      || (existing.lastActivityAt ?? 0) < (member.lastActivityAt ?? 0)) {
      waitingByMember.set(member.memberId, member);
    }
  };

  for (const turn of activeTurns) {
    if (turn.status === 'RUNNING' || turn.status === 'STOPPING') continue;
    const live = progressByTurn.get(turn.id);
    const reason = turn.status === 'WAITING_APPROVAL' ? '等待用户确认操作'
      : turn.status === 'WAITING_INPUT' ? '等待用户补充信息'
        : turn.status === 'DISPATCHING' ? '已领取派发，尚未收到模型开始回执'
          : '执行轮次已建立，尚未领取派发';
    addWaiting({
      memberId: turn.member_id,
      displayName: turn.display_name,
      state: turn.status === 'WAITING_APPROVAL' || turn.status === 'WAITING_INPUT'
        ? 'waiting-user'
        : 'starting',
      status: turn.status,
      taskId: turn.task_id,
      runId: turn.run_id,
      turnId: turn.id,
      stage: live?.stage ?? turn.stage_key,
      since: live?.waitStartedAt ?? turn.exec_started_at,
      lastActivityAt: live?.lastActivityAt ?? null,
      reason,
      activity: {
        kind: 'wait',
        summary: reason,
        status: 'waiting',
        toolCallId: null,
      },
    });
  }

  const waitingParticipants = runIds.length === 0 ? [] : db.prepare(
    `SELECT rp.member_id,pm.display_name,rp.status,r.id AS run_id,r.task_id,r.stage
     FROM run_participants rp JOIN workflow_runs r ON r.id=rp.run_id JOIN tasks tk ON tk.id=r.task_id
     JOIN project_members pm ON pm.id=rp.member_id AND pm.project_id=tk.project_id
     WHERE rp.run_id IN (${runMarks}) AND rp.expected=1 AND rp.status IN ('pending','late')
       AND r.status IN ('QUEUED','RUNNING','WAITING','STOPPING')
     ORDER BY r.rowid DESC,rp.member_id LIMIT 64`,
  ).all(...runIds) as Array<{
    member_id: string;
    display_name: string;
    status: string;
    run_id: string;
    task_id: string;
    stage: string | null;
  }>;
  for (const row of waitingParticipants) {
    addWaiting({
      memberId: row.member_id,
      displayName: row.display_name,
      state: 'waiting-peer',
      status: row.status,
      taskId: row.task_id,
      runId: row.run_id,
      turnId: null,
      stage: row.stage,
      since: null,
      lastActivityAt: null,
      reason: '正式参与者尚未完成',
      activity: null,
    });
  }

  const coordinationWaiters = db.prepare(
    `SELECT h.target_member_id,pm.display_name,h.status,h.updated_at,
            c.run_id,c.task_id,h.child_task_id
     FROM coordination_messages h JOIN coordination_runs c ON c.run_id=h.coordination_run_id
     JOIN project_members pm ON pm.id=h.target_member_id
     WHERE c.task_id IN (${marks})
       AND c.state IN ('planning','running','integrating')
       AND h.status IN ('accepted','queued') AND h.target_turn_id IS NULL
     ORDER BY h.updated_at DESC,h.id LIMIT 64`,
  ).all(...scopeIds) as Array<{
    target_member_id: string;
    display_name: string;
    status: string;
    updated_at: number;
    run_id: string;
    task_id: string;
    child_task_id: string | null;
  }>;
  for (const row of coordinationWaiters) {
    const targetTask = row.child_task_id == null ? row.task_id : row.child_task_id;
    addWaiting({
      memberId: row.target_member_id,
      displayName: row.display_name,
      state: 'waiting-peer',
      status: row.status,
      taskId: targetTask,
      runId: row.run_id,
      turnId: null,
      stage: '分工执行',
      since: row.updated_at,
      lastActivityAt: null,
      reason: '同伴交接已登记，等待执行轮次',
      activity: null,
    });
  }

  const selectedLatestRun = latestSelectedRun == null ? null : runById.get(latestSelectedRun.id) ?? latestSelectedRun;
  const coordinationActive = selectedLatestRun != null && selectedLatestRun.status === 'WAITING'
    && runIds.length > 0
    && db.prepare(
      `SELECT 1 FROM coordination_runs WHERE task_id=? AND state IN ('running','integrating') LIMIT 1`,
    ).get(task.id) != null;
  if (coordinationActive && task.owner_member_id != null) {
    const alreadyActual = performingMembers.some(member => member.memberId === task.owner_member_id);
    if (!alreadyActual) {
      addWaiting({
        memberId: task.owner_member_id,
        displayName: task.owner_display_name ?? task.owner_member_id,
        state: 'waiting-peer',
        status: selectedLatestRun.status,
        taskId: task.id,
        runId: selectedLatestRun.id,
        turnId: null,
        stage: selectedLatestRun.stage,
        since: null,
        lastActivityAt: null,
        reason: performingMembers.length > 0 ? '协调成员等待同伴成果返回' : '等待同伴步骤产出',
        activity: null,
      });
    }
  }

  const blocker = readExecutionBlocker(db, task.id);
  const preDispatchFailure = readPreDispatchFailure(db, task.id);
  if (outbox.length > 0 && runs.length === 0 && preDispatchFailure == null) {
    const requestedMemberId = blocker?.memberId ?? task.owner_member_id;
    if (requestedMemberId != null) {
      addWaiting({
        memberId: requestedMemberId,
        displayName: blocker?.memberName ?? task.owner_display_name ?? requestedMemberId,
        state: outbox[0]!.status === 'leased' ? 'starting' : 'waiting-peer',
        status: outbox[0]!.status.toUpperCase(),
        taskId: task.id,
        runId: null,
        turnId: null,
        stage: blocker?.stage ?? null,
        since: null,
        lastActivityAt: null,
        reason: blocker?.reason === 'queued' ? '请求已进入正式待派发队列' : blocker?.note ?? '等待准入',
        activity: null,
      });
    }
  }

  const performingMemberIds = new Set(performingMembers.map(member => member.memberId));
  const waitingMembers = [...waitingByMember.values()]
    .filter(member => !performingMemberIds.has(member.memberId))
    .sort((a, b) => {
    const rank = (member: TaskExecutionMember) => member.state === 'waiting-user' ? 0
      : member.state === 'waiting-peer' ? 1 : 2;
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, 'zh-CN');
  });

  const results = readResults(db, task, scopeIds);
  let waitingForUser: TaskUserWait | null = null;
  const waitTurn = activeTurns.find(turn => turn.status === 'WAITING_APPROVAL' || turn.status === 'WAITING_INPUT');
  if (waitTurn != null) {
    const event = db.prepare(
      `SELECT seq,kind,created_at,task_id,run_id,turn_id,json_extract(payload_json,'$.memberId') member_id,
              NULL AS message_body_json,payload_json
       FROM domain_events WHERE turn_id=? AND kind IN ('approval.requested','input.requested')
       ORDER BY seq DESC LIMIT 1`,
    ).get(waitTurn.id) as EventRow | undefined;
    const payload = parseObject(event?.payload_json ?? null);
    waitingForUser = {
      kind: waitTurn.status === 'WAITING_APPROVAL' ? 'approval' : 'input',
      message: readPayloadMessage(payload)
        ?? (waitTurn.status === 'WAITING_APPROVAL' ? '执行已暂停，等待你的操作确认。' : '执行已暂停，等待你补充信息。'),
      memberIds: [waitTurn.member_id],
      runId: waitTurn.run_id,
      turnId: waitTurn.id,
      deliveryId: null,
      eventSeq: event?.seq ?? null,
      since: event?.created_at ?? waitTurn.exec_started_at,
    };
  }

  if (waitingForUser == null) {
    const issueEvent = db.prepare(
      `SELECT e.seq,e.kind,e.created_at,e.task_id,e.run_id,e.turn_id,
              json_extract(e.payload_json,'$.memberId') member_id,
              NULL AS message_body_json,e.payload_json
       FROM domain_events e JOIN agent_turns a ON a.id=e.turn_id
       JOIN workflow_runs r ON r.id=a.run_id
       WHERE r.task_id IN (${marks}) AND e.kind='run.issueResolution'
         AND json_extract(e.payload_json,'$.status')='needs_user'
       ORDER BY e.seq DESC LIMIT 1`,
    ).get(...scopeIds) as EventRow | undefined;
    if (issueEvent != null) {
      const payload = parseObject(issueEvent.payload_json);
      waitingForUser = {
        kind: 'clarification',
        message: boundedText(payload.question) ?? boundedText(payload.reason) ?? '需要你补充信息后才能继续。',
        memberIds: issueEvent.member_id == null ? [] : [issueEvent.member_id],
        runId: issueEvent.run_id,
        turnId: issueEvent.turn_id,
        deliveryId: null,
        eventSeq: issueEvent.seq,
        since: issueEvent.created_at,
      };
    }
  }

  if (waitingForUser == null) {
    const clarification = db.prepare(
      `SELECT e.seq,e.kind,e.created_at,e.task_id,e.run_id,e.turn_id,
              a.member_id,NULL AS message_body_json,e.payload_json
       FROM domain_events e LEFT JOIN agent_turns a ON a.id=e.turn_id
       JOIN workflow_runs r ON r.id=COALESCE(e.run_id,a.run_id)
       WHERE r.task_id IN (${marks}) AND e.kind='turn.workClarification'
       ORDER BY e.seq DESC LIMIT 1`,
    ).get(...scopeIds) as EventRow | undefined;
    if (clarification != null) {
      const payload = parseObject(clarification.payload_json);
      waitingForUser = {
        kind: 'clarification',
        message: readPayloadMessage(payload) ?? '工作说明已保存，等待明确补充后再执行。',
        memberIds: clarification.member_id == null ? [] : [clarification.member_id],
        runId: clarification.run_id,
        turnId: clarification.turn_id,
        deliveryId: null,
        eventSeq: clarification.seq,
        since: clarification.created_at,
      };
    }
  }

  if (waitingForUser == null
    && task.status === 'ACTIVE'
    && results.deliveries[0]?.reviewStatus === 'changes_requested') {
    waitingForUser = {
      kind: 'rework',
      message: '修改意见已记录；本次返工尚未开始执行。',
      memberIds: task.owner_member_id == null ? [] : [task.owner_member_id],
      runId: results.deliveries[0].runId,
      turnId: null,
      deliveryId: results.deliveries[0].id,
      eventSeq: null,
      since: null,
    };
  }

  if (waitingForUser == null && results.pendingReviewDelivery != null) {
    waitingForUser = {
      kind: 'review',
      message: `交付 v${results.pendingReviewDelivery.revision} 已保存，等待你核对验收。`,
      memberIds: [],
      runId: results.pendingReviewDelivery.runId,
      turnId: null,
      deliveryId: results.pendingReviewDelivery.id,
      eventSeq: null,
      since: null,
    };
  }

  if (waitingForUser == null && task.status === 'WAITING_USER') {
    waitingForUser = {
      kind: 'clarification',
      message: '任务已暂停并等待你的确认或补充；未找到更具体的事件说明。',
      memberIds: task.owner_member_id == null ? [] : [task.owner_member_id],
      runId: selectedLatestRun?.id ?? null,
      turnId: null,
      deliveryId: null,
      eventSeq: null,
      since: null,
    };
  }

  const visibleProgressRows = db.prepare(
    `SELECT p.turn_id,p.text,p.updated_at,a.member_id,a.run_id,r.task_id
     FROM turn_visible_progress p JOIN agent_turns a ON a.id=p.turn_id
     JOIN workflow_runs r ON r.id=a.run_id
     WHERE r.task_id IN (${marks}) ORDER BY p.updated_at DESC LIMIT 24`,
  ).all(...scopeIds) as Array<{
    turn_id: string;
    text: string;
    updated_at: number;
    member_id: string;
    run_id: string;
    task_id: string;
  }>;
  const activityCandidates: TaskBusinessActivity[] = visibleProgressRows.map(row => ({
    kind: 'assistant-progress',
    summary: boundedText(row.text) ?? '已保存可见回复进展',
    memberId: row.member_id,
    taskId: row.task_id,
    runId: row.run_id,
    turnId: row.turn_id,
    toolCallId: null,
    source: 'visible-progress',
    sourceEventSeq: null,
    at: row.updated_at,
  }));

  const businessEvents = db.prepare(
    `SELECT e.seq,e.kind,e.created_at,e.task_id,e.run_id,e.turn_id,
            COALESCE(json_extract(e.payload_json,'$.memberId'),a.member_id) member_id,
            m.body_json AS message_body_json,e.payload_json
     FROM domain_events e LEFT JOIN agent_turns a ON a.id=e.turn_id
     LEFT JOIN messages m ON m.id=json_extract(e.payload_json,'$.messageId')
     WHERE e.task_id IN (${marks})
       AND e.kind IN (${BUSINESS_EVENT_KINDS.map(() => '?').join(',')})
     ORDER BY e.seq DESC LIMIT 80`,
  ).all(...scopeIds, ...BUSINESS_EVENT_KINDS) as EventRow[];
  for (const event of businessEvents) {
    const label = businessEventLabel(event);
    if (label == null) continue;
    activityCandidates.push({
      kind: label.kind,
      summary: label.summary,
      memberId: event.member_id,
      taskId: event.task_id,
      runId: event.run_id,
      turnId: event.turn_id,
      toolCallId: str(parseObject(event.payload_json).toolCallId),
      source: event.kind.startsWith('tool.') ? 'tool-event'
        : event.kind.includes('reply') ? 'message' : 'business-event',
      sourceEventSeq: event.seq,
      at: event.created_at,
    });
  }
  activityCandidates.sort((a, b) =>
    b.at - a.at || (b.sourceEventSeq ?? -1) - (a.sourceEventSeq ?? -1));
  const lastBusinessActivity = activityCandidates[0] ?? null;

  const failureEvent = db.prepare(
    `SELECT e.seq,e.kind,e.created_at,e.task_id,e.run_id,e.turn_id,
            COALESCE(json_extract(e.payload_json,'$.memberId'),a.member_id) member_id,
            NULL AS message_body_json,e.payload_json
     FROM domain_events e LEFT JOIN agent_turns a ON a.id=e.turn_id
     WHERE e.task_id IN (${marks})
       AND e.kind IN (${FAILURE_EVENT_KINDS.map(() => '?').join(',')})
     ORDER BY e.seq DESC LIMIT 40`,
  ).all(...scopeIds, ...FAILURE_EVENT_KINDS) as EventRow[];
  const durableFailure = failureEvent.find(event => failureReasonFromEvent(event) != null);

  const recovery = assessTaskRedispatchReadiness(db, task.id);
  const runCount = (db.prepare(
    `SELECT count(*) n FROM workflow_runs WHERE task_id IN (${marks})`,
  ).get(...scopeIds) as { n: number }).n;
  const turnCount = (db.prepare(
    `SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
     WHERE r.task_id IN (${marks})`,
  ).get(...scopeIds) as { n: number }).n;
  const sourceHighWatermark = (db.prepare(
    `SELECT COALESCE(MAX(seq),0) n FROM domain_events WHERE task_id IN (${marks})`,
  ).get(...scopeIds) as { n: number }).n;

  const reason = (
    code: TaskExecutionReason['code'],
    message: string,
    source: TaskExecutionReason['source'],
    ref: {
      taskId?: string | null;
      runId?: string | null;
      turnId?: string | null;
      eventSeq?: number | null;
    } = {},
  ): TaskExecutionReason => ({
    code,
    message,
    source,
    taskId: ref.taskId ?? task.id,
    runId: ref.runId ?? null,
    turnId: ref.turnId ?? null,
    eventSeq: ref.eventSeq ?? null,
  });

  let phase: TaskExecutionPhase;
  let projectionReason: TaskExecutionReason;
  const latestStatus = selectedLatestRun?.status ?? null;
  const blockerReason = blocker?.reason ?? null;
  const activeUserWait = waitingForUser != null
    && (waitingForUser.kind === 'approval' || waitingForUser.kind === 'input');
  const startingTurns = activeTurns.filter(turn => turn.status === 'PENDING' || turn.status === 'DISPATCHING');

  if (stoppingTurns.length > 0 || stoppingRun != null) {
    phase = 'STOPPING';
    projectionReason = reason(
      'STOPPING',
      '停止请求已持久化；正在等待执行载体确认结束。',
      'turn',
      { runId: stoppingTurns[0]?.run_id ?? stoppingRun?.id, turnId: stoppingTurns[0]?.id },
    );
  } else if (unknownTurns.length > 0) {
    phase = 'UNKNOWN';
    const retained = unknownTurns.find(turn => turn.protection_state === 'retained');
    projectionReason = reason(
      retained == null ? 'UNKNOWN_TURN' : 'PROTECTION_RETAINED',
      retained?.protection_state === 'retained'
        ? '执行保护仍保留；在程序证据解除前，结果不能视为已结束。'
        : '执行结果不确定，等待正式核对与保护解除。',
      'recovery',
      { taskId: unknownTurns[0]!.task_id, runId: unknownTurns[0]!.run_id, turnId: unknownTurns[0]!.id },
    );
  } else if (activeUserWait) {
    phase = 'WAITING_FOR_USER';
    projectionReason = reason(
      waitingForUser!.kind === 'approval' ? 'WAITING_APPROVAL' : 'WAITING_INPUT',
      waitingForUser!.message,
      'turn',
      {
        runId: waitingForUser!.runId,
        turnId: waitingForUser!.turnId,
        eventSeq: waitingForUser!.eventSeq,
        taskId: waitingMembers.find(member => member.turnId === waitingForUser!.turnId)?.taskId ?? task.id,
      },
    );
  } else if (performingMembers.length > 0) {
    phase = 'RUNNING';
    projectionReason = reason(
      'MEMBER_PERFORMING',
      `${performingMembers.map(member => member.displayName).join('、')} 正在执行。`,
      'turn',
      {
        taskId: performingMembers[0]!.taskId,
        runId: performingMembers[0]!.runId,
        turnId: performingMembers[0]!.turnId,
      },
    );
  } else if (preDispatchFailure != null) {
    phase = 'NOT_STARTED_FAILED';
    projectionReason = reason(
      'PRE_DISPATCH_FAILED',
      preDispatchFailure.event.message,
      'pre-dispatch',
      {
        taskId: preDispatchFailure.taskId,
        eventSeq: preDispatchFailure.event.seq,
      },
    );
  } else if (blockerReason === 'member-occupied' || blockerReason === 'write-root-occupied') {
    phase = 'ADMISSION_WAITING';
    projectionReason = reason(
      blockerReason === 'member-occupied' ? 'MEMBER_OCCUPIED' : 'WRITE_ROOT_OCCUPIED',
      blocker?.note ?? '当前请求尚未进入模型执行，正在等待准入。',
      'blocker',
      { runId: blocker?.runId, turnId: blocker?.turnId, taskId: blocker?.blockingTaskId ?? task.id },
    );
  } else if (blockerReason === 'unknown-turn') {
    phase = 'ADMISSION_WAITING';
    projectionReason = reason(
      'PRIOR_UNKNOWN_BLOCKS_ADMISSION',
      blocker?.note ?? '前序执行结果未知，当前请求不会越过保护自动执行。',
      'blocker',
      {
        taskId: blocker?.blockingTaskId ?? task.id,
        turnId: blocker?.blockingTurnId,
      },
    );
  } else if (startingTurns.some(turn => turn.status === 'DISPATCHING')) {
    phase = 'ADMISSION_WAITING';
    const turn = startingTurns.find(item => item.status === 'DISPATCHING')!;
    projectionReason = reason(
      'TURN_DISPATCHING',
      '派发已被领取，但尚未收到模型开始回执。',
      'turn',
      { taskId: turn.task_id, runId: turn.run_id, turnId: turn.id },
    );
  } else if (startingTurns.some(turn => turn.status === 'PENDING')) {
    phase = 'QUEUED';
    const turn = startingTurns.find(item => item.status === 'PENDING')!;
    projectionReason = reason(
      'TURN_PENDING',
      '执行轮次已建立，尚未派发。',
      'turn',
      { taskId: turn.task_id, runId: turn.run_id, turnId: turn.id },
    );
  } else if (blockerReason === 'queued' || blocker != null || outbox.length > 0 || activeRuns.some(run => run.status === 'QUEUED')) {
    phase = 'QUEUED';
    projectionReason = reason(
      'OUTBOX_QUEUED',
      blocker?.note ?? `正式待派发队列有 ${outbox.length} 项；尚无执行 turn。`,
      blocker == null ? 'outbox' : 'blocker',
      {
        runId: blocker?.runId ?? activeRuns.find(run => run.status === 'QUEUED')?.id,
        turnId: blocker?.turnId,
      },
    );
  } else if (waitingForUser != null && waitingForUser.kind !== 'review') {
    phase = 'WAITING_FOR_USER';
    projectionReason = reason(
      waitingForUser.kind === 'rework' ? 'WAITING_REWORK' : 'WAITING_CLARIFICATION',
      waitingForUser.message,
      'task',
      {
        runId: waitingForUser.runId,
        turnId: waitingForUser.turnId,
        eventSeq: waitingForUser.eventSeq,
      },
    );
  } else if (waitingMembers.length > 0 || latestStatus === 'WAITING' && coordinationActive) {
    phase = 'WAITING_FOR_PEER';
    projectionReason = reason(
      'WAITING_FOR_PEER',
      waitingMembers.length > 0
        ? `${waitingMembers.map(member => member.displayName).join('、')} 尚未完成；等待同伴步骤。`
        : '协调运行等待同伴步骤。',
      'coordination',
      {
        runId: selectedLatestRun?.id,
        turnId: activeTurns[0]?.id,
      },
    );
  } else if (task.status === 'DONE' || task.status === 'REVIEW') {
    phase = 'COMPLETED';
    projectionReason = reason(
      'TASK_COMPLETED',
      task.status === 'REVIEW' ? '执行已完成，交付等待人工验收。' : '任务已达到正式完成状态。',
      'task',
      { runId: selectedLatestRun?.id },
    );
  } else if (task.status === 'CANCELLED') {
    phase = 'CANCELLED';
    projectionReason = reason('TASK_CANCELLED', '任务已正式取消。', 'task', {
      runId: selectedLatestRun?.id,
    });
  } else if (latestStatus === 'SUCCEEDED' && waitingForUser?.kind === 'review') {
    phase = 'COMPLETED';
    projectionReason = reason('TASK_COMPLETED', waitingForUser.message, 'task', {
      runId: selectedLatestRun?.id,
    });
  } else if (latestStatus === 'INTERRUPTED' || latestStatus === 'PARTIAL'
    || latestStatus === 'FAILED' || task.status === 'BLOCKED' || latestStatus === 'RUNNING') {
    const durableMessage = failureReasonFromEvent(durableFailure)
      ?? (latestStatus === 'RUNNING'
        ? '运行标记为执行中，但没有任何可确认的在途 turn；不伪造进度。'
        : latestStatus === 'INTERRUPTED'
          ? '运行被中断，结果尚不能视为完成。'
          : '最近执行未成功完成。');
    phase = latestStatus === 'RUNNING' || latestStatus === 'INTERRUPTED' ? 'UNKNOWN' : 'FAILED';
    projectionReason = reason(
      latestStatus === 'RUNNING' || latestStatus === 'INTERRUPTED' ? 'NO_EXECUTION_EVIDENCE' : 'RUN_FAILED',
      durableMessage,
      durableFailure == null ? 'run' : 'run',
      {
        taskId: durableFailure?.task_id ?? task.id,
        runId: durableFailure?.run_id ?? selectedLatestRun?.id,
        turnId: durableFailure?.turn_id,
        eventSeq: durableFailure?.seq,
      },
    );
  } else if (task.status === 'OPEN' && runs.length === 0) {
    phase = 'IDLE';
    projectionReason = reason('TASK_IDLE', '任务已有正式身份，但当前没有运行或队列事实。', 'task');
  } else {
    phase = 'UNKNOWN';
    projectionReason = reason(
      'NO_EXECUTION_EVIDENCE',
      '现有持久事实不足以确认执行阶段；保留为 UNKNOWN。',
      'task',
      { runId: selectedLatestRun?.id },
    );
  }

  if (phase === 'COMPLETED' && waitingForUser?.kind === 'review') {
    projectionReason = reason('TASK_COMPLETED', waitingForUser.message, 'task', {
      runId: waitingForUser.runId,
    });
  }
  if (phase === 'FAILED' && task.status === 'BLOCKED') {
    projectionReason = {
      ...projectionReason,
      code: 'TASK_BLOCKED',
      source: 'task',
    };
  }
  if (phase === 'UNKNOWN' && recovery?.code === 'RECONCILE_REQUIRED') {
    projectionReason = {
      ...projectionReason,
      code: 'RECOVERY_REQUIRED',
      message: recovery.message,
      source: 'recovery',
      taskId: recovery.fact.turnId == null ? task.id : task.id,
      turnId: recovery.fact.turnId ?? projectionReason.turnId,
      eventSeq: projectionReason.eventSeq,
    };
  }

  const actions: TaskExecutionAction[] = [];
  const addAction = (action: TaskExecutionAction): void => {
    if (!actions.some(item => item.id === action.id)) actions.push(action);
  };
  if (task.conversation_thread_id != null) {
    addAction({
      id: `navigate-thread:${task.conversation_thread_id}`,
      kind: 'navigate',
      label: '打开回复串',
      target: { kind: 'thread', id: task.conversation_thread_id },
    });
  } else if (task.kind === 'dm_turn') {
    addAction({
      id: `navigate-dm:${task.conversation_id}`,
      kind: 'navigate',
      label: '打开私信',
      target: { kind: 'dm', id: task.conversation_id },
    });
  } else if (task.room_id != null) {
    addAction({
      id: `navigate-room:${task.room_id}`,
      kind: 'navigate',
      label: '打开房间',
      target: { kind: 'room', id: task.room_id },
    });
  }
  const recoveryTurnId = unknownTurns[0]?.id ?? (blockerReason === 'unknown-turn' ? blocker?.blockingTurnId : null)
    ?? recovery?.fact.turnId;
  if (recoveryTurnId != null) {
    addAction({
      id: `recover:${recoveryTurnId}`,
      kind: 'recover',
      label: '核对执行结果',
      target: { kind: 'recovery', id: recoveryTurnId },
    });
  }
  if (results.pendingReviewDelivery != null) {
    addAction({
      id: `review:${results.pendingReviewDelivery.id}`,
      kind: 'review',
      label: `验收交付 v${results.pendingReviewDelivery.revision}`,
      target: { kind: 'delivery', id: results.pendingReviewDelivery.id },
    });
  } else if (results.currentDelivery != null) {
    addAction({
      id: `delivery:${results.currentDelivery.id}`,
      kind: 'navigate',
      label: `查看交付 v${results.currentDelivery.revision}`,
      target: { kind: 'delivery', id: results.currentDelivery.id },
    });
  }
  if (preDispatchFailure?.recoveryBinding != null) {
    addAction({
      id: `retry:${preDispatchFailure.recoveryBinding.taskId}:${preDispatchFailure.recoveryBinding.expectedTaskRevision}`,
      kind: 'retry',
      label: '按原请求继续',
      binding: preDispatchFailure.recoveryBinding,
    });
  }

  return {
    schemaVersion: 'task-execution-status-v1',
    taskId: task.id,
    scope: {
      projectId: task.project_id,
      conversationId: task.conversation_id,
      roomId: task.room_id,
      threadId: task.conversation_thread_id,
      taskKind: task.kind,
      surfaces: task.kind === 'dm_turn'
        ? ['dm']
        : task.conversation_thread_id == null ? ['room'] : ['room', 'thread'],
    },
    phase,
    reason: projectionReason,
    actualPerformingMembers: performingMembers,
    waitingMembers,
    waitingForUser,
    lastBusinessActivity,
    existingResults: results,
    actions: actions.slice(0, 5),
    evidence: {
      sourceHighWatermark,
      taskStatus: task.status,
      taskRevision: task.revision,
      stopGeneration: task.stop_generation,
      runCount,
      turnCount,
      activeRunIds: activeRuns.map(run => run.id),
      unknownTurnIds: unknownTurns.map(turn => turn.id),
      latestRun: selectedLatestRun == null ? null : {
        id: selectedLatestRun.id,
        status: selectedLatestRun.status,
        stage: selectedLatestRun.stage,
        mode: selectedLatestRun.mode,
      },
      outbox: outbox[0] == null ? null : {
        pendingCount: outbox.length,
        firstId: outbox[0].id,
        firstStatus: outbox[0].status,
        dispatchKey: outbox[0].dispatch_key,
        leaseUntil: outbox[0].lease_until,
      },
      executionBlocker: blocker,
      preDispatchFailure,
      recovery: recovery == null ? null : {
        code: recovery.code,
        message: recovery.message,
        fact: recovery.fact,
      },
      heartbeatUsedAsActivity: false,
    },
    observedAt: Date.now(),
  };
}
