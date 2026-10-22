import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { TaskDetailEvent, TaskDetailFailure, TaskDetailMemberRun, TaskDetailRun, TaskDetailsResult, TaskHistoryParams, TaskHistoryPage } from '../contracts/taskDetails.ts';
import type { TaskExecutionBlocker } from '../contracts/executionBlockers.ts';
import { assessTaskRedispatchReadiness } from '../persistence/stores/recoveryGuard.ts';
import { readCoordination } from './coordination.ts';
import { lockDomainsOverlap } from './directoryIdentity.ts';

type EventRow = { seq: number; kind: string; created_at: number; run_id: string | null; turn_id: string | null; payload_json: string };
const eventOf = (e: EventRow): TaskDetailEvent => {
    const payload: unknown = JSON.parse(e.payload_json);
    const p = payload != null && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const summary = [p.message, p.reason, p.question, p.status, p.resultSummary, p.toolName, p.outcome, p.note]
      .find((x): x is string => typeof x === 'string')?.slice(0, 200) ?? '';
    return { seq: e.seq, kind: e.kind, at: e.created_at, runId: e.run_id, turnId: e.turn_id,
      toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : null, summary,
      status: typeof p.status==='string'?p.status:null, code:typeof p.code==='string'?p.code:null,
      action:typeof p.action==='string'?p.action:null,
      target:typeof p.target==='string'?p.target:null,
      resultSummary:typeof p.resultSummary==='string'?p.resultSummary:null,
      memberId:typeof p.memberId==='string'?p.memberId:null,
      stage:typeof p.stage==='string'?p.stage:null,
      outcome:typeof p.outcome==='string'?p.outcome:null };
  };

const historyCursor = (projectId: string, taskId: string, kind: string, runId: string | undefined, before: number) => Buffer.from(JSON.stringify({ projectId, taskId, kind, runId: runId ?? null, before })).toString('base64url');

interface PendingOutboxRow {
  id: number;
  dispatch_key: string;
  status: 'pending' | 'leased';
  lease_until: number | null;
  turn_id: string | null;
}

interface OccupyingTurnRow {
  turnId: string;
  turnStatus: string;
  protectionState: string | null;
  memberId: string;
  memberName: string;
  runId: string;
  taskId: string;
  taskTitle: string;
  taskNumber: number | null;
  rootTaskId: string;
  rootTaskTitle: string;
  rootTaskNumber: number | null;
  writeRootKey: string | null;
}

function parseDispatchFacts(dispatchKey: string): { stage: string | null; runId: string | null; memberId: string | null } {
  const delib = /^task:[^:]+:delib:(run_[^:]+):(IND|CR|ISS|CHK|SYN|RAT|RPR):([^:]+):(\d+):(?:w|c|f|IND|CR|ISS|CHK|SYN|RAT)$/.exec(dispatchKey);
  if (delib != null) return { stage: `delib.${delib[2]!.toLowerCase()}`, runId: delib[1]!, memberId: delib[3]! };
  return { stage: null, runId: null, memberId: null };
}

/**
 * Project the durable reason why a task has queued work but is not executing.
 *
 * This query is intentionally read-only. It reports UNKNOWN / retained protection and
 * write-root occupancy as unresolved facts; it never releases, retries or rewrites them.
 */
export function readExecutionBlocker(db: ZhongshuoDatabase, taskId: string): TaskExecutionBlocker | null {
  const task = db.prepare(`SELECT t.project_id, t.owner_member_id, t.write_scope_json, p.canonical_path
    FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(taskId) as
    | { project_id: string; owner_member_id: string | null; write_scope_json: string; canonical_path: string }
    | undefined;
  if (task == null) return null;
  const pendingWantsWrite = (() => {
    try {
      const scope = JSON.parse(task.write_scope_json) as { executionMode?: unknown; authorized?: unknown };
      return scope.executionMode === 'full' || scope.authorized === true;
    } catch {
      return false;
    }
  })();
  const active = db.prepare(`SELECT 1 FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id
    WHERE r.task_id=? AND t.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')
    LIMIT 1`).get(taskId);
  if (active != null) return null;

  const outboxRows = db.prepare(`SELECT id, dispatch_key, status, lease_until, turn_id
    FROM outbox
    WHERE status IN ('pending','leased')
      AND (dispatch_key LIKE 'task:' || ? || ':%' OR dispatch_key LIKE 'dmtask:' || ? || ':%')
    ORDER BY id`).all(taskId, taskId) as PendingOutboxRow[];
  if (outboxRows.length === 0) return null;
  const first = outboxRows[0]!;
  const parsed = parseDispatchFacts(first.dispatch_key);
  const requestedMemberId = parsed.memberId ?? task.owner_member_id;
  const requestedMember = requestedMemberId == null
    ? undefined
    : db.prepare('SELECT display_name FROM project_members WHERE id=? AND project_id=?').get(requestedMemberId, task.project_id) as { display_name: string } | undefined;

  const occupyingSql = `SELECT t.id AS turnId,t.status AS turnStatus,t.protection_state AS protectionState,
      t.member_id AS memberId,pm.display_name AS memberName,t.run_id AS runId,
      tk.id AS taskId,tk.title AS taskTitle,tk.room_task_number AS taskNumber,
      COALESCE(root.id,tk.id) AS rootTaskId,COALESCE(root.title,tk.title) AS rootTaskTitle,
      COALESCE(root.room_task_number,tk.room_task_number) AS rootTaskNumber,
      (SELECT w.lock_domain FROM workspace_leases w WHERE w.owner_turn_id=t.id AND w.status!='released'
       ORDER BY CASE w.status WHEN 'active' THEN 0 ELSE 1 END,w.epoch DESC LIMIT 1) AS writeRootKey
    FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id JOIN tasks tk ON tk.id=r.task_id
    LEFT JOIN tasks root ON root.id=tk.parent_task_id
    JOIN project_members pm ON pm.id=t.member_id AND pm.project_id=tk.project_id
    WHERE tk.id!=?`;
  const unknownCandidates = db.prepare(`${occupyingSql}
      AND (t.status='UNKNOWN' OR t.protection_state='retained')
    ORDER BY CASE WHEN t.member_id=? THEN 0 ELSE 1 END,CASE WHEN t.status='UNKNOWN' THEN 0 ELSE 1 END,t.rowid DESC`)
    .all(taskId, requestedMemberId ?? '') as OccupyingTurnRow[];
  const unknown = unknownCandidates.find((row) => {
    if (row.protectionState === 'released') return false;
    if (requestedMemberId != null && row.memberId === requestedMemberId) return true;
    return pendingWantsWrite && row.writeRootKey != null && lockDomainsOverlap(row.writeRootKey, task.canonical_path);
  });
  if (unknown != null) {
    return {
      reason: 'unknown-turn',
      note: `待执行队列 ${outboxRows.length} 项；任务 #${unknown.rootTaskNumber ?? '?'}（${unknown.memberName}）的上一轮结果未知，当前任务不会越过这项占用自动执行。请到恢复中心核对。`,
      pendingOutboxCount: outboxRows.length,
      outboxId: first.id,
      outboxStatus: first.status,
      dispatchKey: first.dispatch_key,
      leaseUntil: first.lease_until,
      stage: parsed.stage,
      runId: parsed.runId,
      turnId: first.turn_id,
      memberId: requestedMemberId,
      memberName: requestedMember?.display_name ?? null,
      blockingTaskId: unknown.taskId,
      blockingTaskTitle: unknown.taskTitle,
      blockingTaskNumber: unknown.taskNumber,
      blockingRootTaskId: unknown.rootTaskId,
      blockingRootTaskTitle: unknown.rootTaskTitle,
      blockingRootTaskNumber: unknown.rootTaskNumber,
      blockingMemberId: unknown.memberId,
      blockingMemberName: unknown.memberName,
      blockingTurnId: unknown.turnId,
      blockingTurnStatus: unknown.turnStatus,
      protectionState: unknown.protectionState,
      writeRootKey: unknown.writeRootKey,
    };
  }

  const memberBusy = requestedMemberId == null ? undefined : db.prepare(`${occupyingSql}
      AND t.member_id=? AND t.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')
    ORDER BY t.rowid DESC LIMIT 1`).get(taskId, requestedMemberId) as OccupyingTurnRow | undefined;
  if (memberBusy != null) {
    return {
      reason: 'member-occupied',
      note: `待执行队列 ${outboxRows.length} 项；${memberBusy.memberName} 正在执行任务 #${memberBusy.rootTaskNumber ?? '?'}，本任务尚未进入模型执行。`,
      pendingOutboxCount: outboxRows.length,
      outboxId: first.id,
      outboxStatus: first.status,
      dispatchKey: first.dispatch_key,
      leaseUntil: first.lease_until,
      stage: parsed.stage,
      runId: parsed.runId,
      turnId: first.turn_id,
      memberId: requestedMemberId,
      memberName: requestedMember?.display_name ?? null,
      blockingTaskId: memberBusy.taskId,
      blockingTaskTitle: memberBusy.taskTitle,
      blockingTaskNumber: memberBusy.taskNumber,
      blockingRootTaskId: memberBusy.rootTaskId,
      blockingRootTaskTitle: memberBusy.rootTaskTitle,
      blockingRootTaskNumber: memberBusy.rootTaskNumber,
      blockingMemberId: memberBusy.memberId,
      blockingMemberName: memberBusy.memberName,
      blockingTurnId: memberBusy.turnId,
      blockingTurnStatus: memberBusy.turnStatus,
      protectionState: memberBusy.protectionState,
      writeRootKey: memberBusy.writeRootKey,
    };
  }

  const writeRootCandidates = pendingWantsWrite ? db.prepare(`${occupyingSql}
      AND EXISTS(SELECT 1 FROM workspace_leases w WHERE w.owner_turn_id=t.id AND w.status!='released')
    ORDER BY t.rowid DESC`).all(taskId) as OccupyingTurnRow[] : [];
  const writeRoot = writeRootCandidates.find((row) =>
    row.writeRootKey != null
      && lockDomainsOverlap(row.writeRootKey, task.canonical_path)
      && !(row.turnStatus === 'UNKNOWN' && row.protectionState === 'released'));
  if (writeRoot != null) {
    return {
      reason: 'write-root-occupied',
      note: `待执行队列 ${outboxRows.length} 项；同一写入目录仍由任务 #${writeRoot.rootTaskNumber ?? '?'} 占用，本任务尚未进入模型执行。`,
      pendingOutboxCount: outboxRows.length,
      outboxId: first.id,
      outboxStatus: first.status,
      dispatchKey: first.dispatch_key,
      leaseUntil: first.lease_until,
      stage: parsed.stage,
      runId: parsed.runId,
      turnId: first.turn_id,
      memberId: requestedMemberId,
      memberName: requestedMember?.display_name ?? null,
      blockingTaskId: writeRoot.taskId,
      blockingTaskTitle: writeRoot.taskTitle,
      blockingTaskNumber: writeRoot.taskNumber,
      blockingRootTaskId: writeRoot.rootTaskId,
      blockingRootTaskTitle: writeRoot.rootTaskTitle,
      blockingRootTaskNumber: writeRoot.rootTaskNumber,
      blockingMemberId: writeRoot.memberId,
      blockingMemberName: writeRoot.memberName,
      blockingTurnId: writeRoot.turnId,
      blockingTurnStatus: writeRoot.turnStatus,
      protectionState: writeRoot.protectionState,
      writeRootKey: writeRoot.writeRootKey,
    };
  }

  return {
    reason: 'queued',
    note: `任务已进入待派发队列（${outboxRows.length} 项）；尚无执行 turn，不能据此显示为模型正在处理。`,
    pendingOutboxCount: outboxRows.length,
    outboxId: first.id,
    outboxStatus: first.status,
    dispatchKey: first.dispatch_key,
    leaseUntil: first.lease_until,
    stage: parsed.stage,
    runId: parsed.runId,
    turnId: first.turn_id,
    memberId: requestedMemberId,
    memberName: requestedMember?.display_name ?? null,
    blockingTaskId: null,
    blockingTaskTitle: null,
    blockingTaskNumber: null,
    blockingRootTaskId: null,
    blockingRootTaskTitle: null,
    blockingRootTaskNumber: null,
    blockingMemberId: null,
    blockingMemberName: null,
    blockingTurnId: null,
    blockingTurnStatus: null,
    protectionState: null,
    writeRootKey: null,
  };
}

type MemberRunSelection = { run_id: string; task_id: string; coordination_run_id: string; step_key: string; role: string };

function memberRunSelection(db: ZhongshuoDatabase, taskId: string, runId: string, conversationId?: string): MemberRunSelection | undefined {
  return db.prepare(`SELECT r.id run_id,r.task_id,c.run_id coordination_run_id,s.step_key,s.role
    FROM workflow_runs r JOIN coordination_steps s ON s.child_task_id=r.task_id
    JOIN coordination_runs c ON c.run_id=s.run_id
    WHERE r.id=? AND c.task_id=? ${conversationId == null ? '' : 'AND r.conversation_id=?'}
    LIMIT 1`).get(runId, taskId, ...(conversationId == null ? [] : [conversationId])) as MemberRunSelection | undefined;
}

/** Command-layer preflight helper: a details run id is either the task's own run or one member child run. */
export function taskRunBelongsToDetails(db: ZhongshuoDatabase, taskId: string, runId: string, conversationId?: string): boolean {
  const own = db.prepare(`SELECT 1 FROM workflow_runs WHERE id=? AND task_id=? ${conversationId == null ? '' : 'AND conversation_id=?'}`)
    .get(runId, taskId, ...(conversationId == null ? [] : [conversationId]));
  return own != null || memberRunSelection(db, taskId, runId, conversationId) != null;
}

/** Stable sequence/rowid pages; command layer rechecks audience on every page. */
export function readTaskHistory(db: ZhongshuoDatabase, params: TaskHistoryParams): TaskHistoryPage {
  const { projectId, taskId, kind, runId } = params;
  const task = db.prepare('SELECT conversation_id FROM tasks WHERE id = ? AND project_id = ?').get(taskId, projectId) as { conversation_id: string };
  const historyTaskId = runId == null ? taskId : memberRunSelection(db, taskId, runId, task.conversation_id)?.task_id ?? taskId;
  let before = Number.MAX_SAFE_INTEGER;
  if (params.cursor) {
    const c = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (c.projectId !== projectId || c.taskId !== taskId || c.kind !== kind || c.runId !== (runId ?? null) || !Number.isSafeInteger(c.before) || Number(c.before) <= 0) throw new Error('历史游标不属于本次目标或无效');
    before = Number(c.before);
  }
  if (kind === 'runs') {
    const rows = db.prepare('SELECT rowid AS cursor_id, id, mode, status, stage, round_no, revision FROM workflow_runs WHERE task_id=? AND conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21').all(taskId, task.conversation_id, before) as Array<{cursor_id:number;id:string;mode:string;status:string;stage:string|null;round_no:number|null;revision:number}>;
    return { kind, items: rows.slice(0,20).map(r=>({id:r.id,mode:r.mode,status:r.status,stage:r.stage,roundNo:r.round_no,revision:r.revision,budget:null,participants:[],turns:[],turnsTruncated:false,events:[],eventsTruncated:false,detailLoaded:false})), nextCursor: rows.length>20 ? historyCursor(projectId,taskId,kind,runId,rows[19]!.cursor_id) : null };
  }
  if (kind === 'activity') {
    const rows = db.prepare(`SELECT seq,kind,created_at,run_id,turn_id,payload_json FROM domain_events WHERE task_id=? AND project_id=? AND (conversation_id=? OR conversation_id IS NULL) AND seq<? ${runId ? 'AND run_id=?' : ''} ORDER BY seq DESC LIMIT 121`).all(historyTaskId,projectId,task.conversation_id,before,...(runId?[runId]:[])) as EventRow[];
    return { kind, items:rows.slice(0,120).map(eventOf), nextCursor:rows.length>120 ? historyCursor(projectId,taskId,kind,runId,rows[119]!.seq):null };
  }
  const rows = db.prepare(`SELECT id,revision,manifest_hash,run_id,review_status,reviewed_at,review_note,artifact_refs_json,change_set_refs_json,verification_refs_json FROM task_deliveries WHERE task_id=? AND revision<? ORDER BY revision DESC LIMIT 51`).all(taskId,before) as Array<{id:string;revision:number;manifest_hash:string;run_id:string|null;review_status:string;reviewed_at:number|null;review_note:string|null;artifact_refs_json:string;change_set_refs_json:string;verification_refs_json:string}>;
  const refs = (s:string):string[] => { const value:unknown=JSON.parse(s);return Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'):[]; };
  return {kind,items:rows.slice(0,50).map(d=>({id:d.id,revision:d.revision,manifestHash:d.manifest_hash,runId:d.run_id,reviewStatus:d.review_status,reviewedAt:d.reviewed_at,reviewNote:d.review_note,artifactRefs:refs(d.artifact_refs_json),changeSetRefs:refs(d.change_set_refs_json),verificationRefs:refs(d.verification_refs_json),locate:`#delivery=${d.id}`})),nextCursor:rows.length>50?historyCursor(projectId,taskId,kind,runId,rows[49]!.revision):null};
}

/** Query only facts already persisted by the formal task/worker path. Caller checks scope and audience. */
export function readTaskDetails(db: ZhongshuoDatabase, taskId: string, requestedRunId?: string,requestedDeliveryId?:string): TaskDetailsResult {
  const task = db.prepare(`SELECT t.id, t.project_id, t.conversation_id, t.title, t.objective, t.status, t.review_policy, t.revision, t.stop_generation,
    t.room_task_number, t.owner_member_id, pm.display_name AS owner_display_name, t.parent_task_id, t.current_delivery_id
    FROM tasks t LEFT JOIN project_members pm ON pm.id = t.owner_member_id AND pm.project_id = t.project_id WHERE t.id = ?`).get(taskId) as Record<string, unknown>;
  const projectId = task.project_id as string;
  const conversationId = task.conversation_id as string;
  const bounded = <T>(sql: string, params: unknown[], limit: number): { items: T[]; truncated: boolean } => {
    const rows = db.prepare(`${sql} LIMIT ?`).all(...params, limit + 1) as T[];
    return { items: rows.slice(0, limit), truncated: rows.length > limit };
  };
  const parse = (s: string | null): unknown | null => s == null ? null : JSON.parse(s) as unknown;
  const refs = (s: string): string[] => {
    const value = JSON.parse(s) as unknown;
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  };
  const children = bounded<{ id: string; title: string; status: string }>(
    'SELECT id, title, status FROM tasks WHERE parent_task_id = ? AND project_id = ? AND conversation_id = ? ORDER BY rowid DESC', [taskId, projectId, conversationId], 50);
  type RunRow = { cursor_id: number; id: string; mode: string; status: string; stage: string | null; round_no: number | null; revision: number; budget_json: string | null };
  const runRows = bounded<RunRow>(
    'SELECT rowid AS cursor_id, id, mode, status, stage, round_no, revision, budget_json FROM workflow_runs WHERE task_id = ? AND conversation_id = ? ORDER BY rowid DESC', [taskId, conversationId], 20);
  const latestRunId = runRows.items[0]?.id ?? null;
  const currentRunId = runRows.items[0] != null && ['QUEUED', 'RUNNING', 'WAITING', 'STOPPING'].includes(runRows.items[0].status)
    ? runRows.items[0].id : null;
  const requestedMemberRun = requestedRunId == null ? undefined : memberRunSelection(db, taskId, requestedRunId, conversationId);
  const deliveryRun=requestedDeliveryId?(db.prepare('SELECT run_id FROM task_deliveries WHERE id=? AND task_id=?').get(requestedDeliveryId,taskId) as {run_id:string|null}|undefined)?.run_id:null;
  const selectedParentRunId = requestedMemberRun?.coordination_run_id ?? requestedRunId ?? deliveryRun ?? latestRunId;
  const selectedRunId = requestedMemberRun?.run_id ?? selectedParentRunId;
  const selectedIsOutsideWindow = selectedParentRunId != null && !runRows.items.some((r) => r.id === selectedParentRunId);
  const selectedRow = selectedIsOutsideWindow ? db.prepare(`SELECT rowid AS cursor_id, id, mode, status, stage, round_no, revision, budget_json
    FROM workflow_runs WHERE id = ? AND task_id = ? AND conversation_id = ?`).get(selectedParentRunId, taskId, conversationId) as RunRow | undefined : undefined;
  const coordinationBlocked=task.status==='BLOCKED'&&db.prepare("SELECT 1 FROM coordination_runs WHERE task_id=? AND state='blocked'").get(taskId)!=null;
  const failedLatest = (task.status === 'ACTIVE'||coordinationBlocked) && task.stop_generation === 0 && runRows.items[0]?.status === 'FAILED';
  const integrationRepair=failedLatest&&db.prepare(`SELECT 1 FROM coordination_integration_attempts i JOIN agent_turns a ON a.run_id=i.execution_run_id
    WHERE i.execution_run_id=? AND a.status='FAILED' AND EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='turn.outputInvalid')
    AND NOT EXISTS(SELECT 1 FROM format_repair_workitems f WHERE f.source_turn_id=a.id OR f.consumed_turn_id=a.id)`).get(latestRunId)!=null;
  const directOutputRepair=failedLatest&&db.prepare(`SELECT 1 FROM agent_turns a
    WHERE a.run_id=? AND a.status='FAILED'
      AND EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='turn.outputInvalid')
      AND NOT EXISTS(SELECT 1 FROM format_repair_workitems f WHERE f.source_turn_id=a.id OR f.consumed_turn_id=a.id)`).get(latestRunId)!=null;
  const availability = db.prepare(`SELECT p.status AS project_status, c.archived_at AS conversation_archived,
    r.archived_at AS room_archived FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN conversations c ON c.id = t.conversation_id LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?`)
    .get(taskId) as { project_status: string; conversation_archived: number | null; room_archived: number | null };
  const scopeBlock = availability.project_status !== 'active' ? '项目已归档或不可用；先恢复项目。'
    : availability.conversation_archived != null ? '会话已归档；先恢复会话。'
      : availability.room_archived != null ? '房间已归档；先恢复房间。' : null;
  const pendingRedispatch = failedLatest && (db.prepare(`SELECT 1 FROM outbox WHERE dispatch_key = ? AND status IN ('pending','leased')`)
    .get(`task:${taskId}:redispatch:${latestRunId}`) != null || db.prepare(`SELECT 1 FROM format_repair_workitems f JOIN outbox o ON o.dispatch_key=f.target_dispatch_key WHERE f.task_id=? AND f.status='pending' AND o.status IN ('pending','leased')`).get(taskId)!=null);
  const blockedRetry = failedLatest && !pendingRedispatch && scopeBlock == null ? assessTaskRedispatchReadiness(db, taskId) : null;
  const clarificationLatest=task.status==='WAITING_USER'&&task.stop_generation===0&&runRows.items[0]?.status==='SUCCEEDED'&&db.prepare("SELECT 1 FROM domain_events WHERE task_id=? AND run_id=? AND kind='turn.workClarification'").get(taskId,latestRunId)!=null;
  const clarificationPending=clarificationLatest&&db.prepare("SELECT 1 FROM outbox WHERE dispatch_key=? AND status!='done'").get(`task:${taskId}:redispatch:${latestRunId}`)!=null;
  const clarificationBlock=clarificationLatest&&!clarificationPending&&scopeBlock==null?assessTaskRedispatchReadiness(db,taskId):null;
  const coordination=readCoordination(db,taskId,selectedParentRunId);
  const visibleRunRows = selectedRow == null ? runRows.items : [...runRows.items, selectedRow];
  const loadRun = (r: RunRow, runTaskId: string): TaskDetailRun => {
    const participants = (db.prepare(`SELECT rp.member_id, pm.display_name, rp.role, rp.expected, rp.status
      FROM run_participants rp JOIN project_members pm ON pm.id = rp.member_id WHERE rp.run_id = ? AND pm.project_id = ? ORDER BY rp.role, rp.member_id`)
      .all(r.id, projectId) as Array<{ member_id: string; display_name: string; role: string; expected: number; status: string }>).map((p) => ({
      memberId: p.member_id, displayName: p.display_name, role: p.role, expected: p.expected === 1, status: p.status,
    }));
    const turnRows = bounded<{ id: string; member_id: string; display_name: string; status: string; stage_key: string; turn_purpose: string; attempt: number;capabilities_json:string|null;input_policy:string|null }>(
      `SELECT a.id, a.member_id, pm.display_name, a.status, a.stage_key, a.turn_purpose, a.attempt,s.capabilities_json,
        (SELECT json_extract(b.included_refs_json,'$.permission.policyId') FROM context_bundles b WHERE b.turn_id=a.id ORDER BY b.rowid DESC LIMIT 1) input_policy
       FROM agent_turns a JOIN project_members pm ON pm.id = a.member_id LEFT JOIN runtime_sessions s ON s.id=a.session_id AND s.member_id=a.member_id
        AND s.project_id=? AND s.conversation_id=a.conversation_id AND (s.task_id=? OR s.scope_kind='dm' AND s.task_id IS NULL)
       WHERE a.run_id = ? AND a.conversation_id = ? AND pm.project_id = ? ORDER BY a.rowid DESC`, [projectId,runTaskId,r.id, conversationId, projectId], 80);
    const turns = turnRows.items.map((t) => {
      const usageRows = bounded<{ normalized_json: string; cost_quality: string }>(
        'SELECT normalized_json, cost_quality FROM usage_records WHERE turn_id = ? ORDER BY rowid DESC', [t.id], 50);
      const snapshot=parse(t.capabilities_json) as {runtime?:{kind?:string;model?:string;effort?:string};effectivePolicy?:string}|null;
      return { id: t.id, memberId: t.member_id, displayName: t.display_name, status: t.status, stageKey: t.stage_key,
        ...(snapshot?.runtime?{runtime:{kind:snapshot.runtime.kind??null,model:snapshot.runtime.model??null,effort:snapshot.runtime.effort??null,policy:snapshot.effectivePolicy??t.input_policy}}:{}),
        purpose: t.turn_purpose, attempt: t.attempt, usage: usageRows.items.map((u) => ({ normalized: parse(u.normalized_json), quality: u.cost_quality })), usageTruncated: usageRows.truncated };
    });
    const runEvents = bounded<EventRow>(
      `SELECT seq, kind, created_at, run_id, turn_id, payload_json FROM domain_events
       WHERE run_id = ? AND task_id = ? AND project_id = ? AND (conversation_id = ? OR conversation_id IS NULL)
       ORDER BY seq DESC`, [r.id, runTaskId, projectId, conversationId], 120);
    return { id: r.id, mode: r.mode, status: r.status, stage: r.stage, roundNo: r.round_no, revision: r.revision,
      budget: parse(r.budget_json), participants, turns, turnsTruncated: turnRows.truncated,
      events: runEvents.items.map(eventOf), eventsTruncated: runEvents.truncated, detailLoaded: true };
  };
  const detailedParentRunId = requestedMemberRun == null ? selectedParentRunId : null;
  const runs = visibleRunRows.map((r) => {
    if (r.id !== detailedParentRunId) return { id: r.id, mode: r.mode, status: r.status, stage: r.stage, roundNo: r.round_no, revision: r.revision,
      budget: null, participants: [], turns: [], turnsTruncated: false, events: [], eventsTruncated: false, detailLoaded: false };
    return loadRun(r, taskId);
  });
  type MemberRunRow = RunRow & { task_id: string; task_title: string; task_status: string; step_key: string;
    coordination_role: string; coordination_run_id: string; member_id: string | null; member_name: string | null };
  const memberRunColumns = `r.rowid AS cursor_id,r.id,r.mode,r.status,r.stage,r.round_no,r.revision,r.budget_json,
    t.id task_id,t.title task_title,t.status task_status,s.step_key,s.role coordination_role,c.run_id coordination_run_id,
    t.owner_member_id member_id,pm.display_name member_name`;
  const memberRunRows = coordination == null ? { items: [] as MemberRunRow[], truncated: false } : bounded<MemberRunRow>(
    `SELECT ${memberRunColumns} FROM coordination_steps s JOIN coordination_runs c ON c.run_id=s.run_id
      JOIN tasks t ON t.id=s.child_task_id LEFT JOIN project_members pm ON pm.id=t.owner_member_id AND pm.project_id=t.project_id
      JOIN workflow_runs r ON r.task_id=t.id AND r.conversation_id=?
      WHERE s.run_id=? AND t.project_id=? AND t.conversation_id=?
      ORDER BY s.rowid,r.rowid DESC`,
    [conversationId, coordination.runId, projectId, conversationId], 32);
  if (requestedMemberRun != null && !memberRunRows.items.some((r) => r.id === requestedMemberRun.run_id)) {
    const pinned = db.prepare(`SELECT ${memberRunColumns} FROM coordination_steps s JOIN coordination_runs c ON c.run_id=s.run_id
      JOIN tasks t ON t.id=s.child_task_id LEFT JOIN project_members pm ON pm.id=t.owner_member_id AND pm.project_id=t.project_id
      JOIN workflow_runs r ON r.task_id=t.id AND r.conversation_id=?
      WHERE r.id=? AND s.run_id=? AND c.task_id=? AND t.project_id=? AND t.conversation_id=?`)
      .get(conversationId, requestedMemberRun.run_id, requestedMemberRun.coordination_run_id, taskId, projectId, conversationId) as MemberRunRow | undefined;
    if (pinned != null) memberRunRows.items.push(pinned);
  }
  const failureOf = (runId: string, runTaskId: string): TaskDetailFailure | null => {
    const row = db.prepare(`SELECT seq,kind,created_at,run_id,turn_id,payload_json FROM domain_events
      WHERE run_id=? AND task_id=? AND project_id=? AND (conversation_id=? OR conversation_id IS NULL)
        AND (kind IN ('turn.failed','run.failed','turn.outputInvalid') OR kind='turn.statusChanged' AND json_extract(payload_json,'$.status')='FAILED')
      ORDER BY CASE kind WHEN 'turn.failed' THEN 0 WHEN 'run.failed' THEN 1 WHEN 'turn.outputInvalid' THEN 2 ELSE 3 END,seq DESC
      LIMIT 1`).get(runId, runTaskId, projectId, conversationId) as EventRow | undefined;
    const event = row == null ? null : eventOf(row);
    return event == null ? null : { eventKind: event.kind, at: event.at, message: event.summary || null, code: event.code ?? null };
  };
  const memberRuns: TaskDetailMemberRun[] = memberRunRows.items.map((r) => {
    const run = loadRun(r, r.task_id);
    const lastActivityAt = run.events.reduce<number | null>((latest, event) => latest == null || event.at > latest ? event.at : latest, null);
    return { ...run, scope: 'member', coordinationRunId: r.coordination_run_id, coordinationStepKey: r.step_key,
      coordinationRole: r.coordination_role, taskId: r.task_id, taskTitle: r.task_title, taskStatus: r.task_status,
      memberId: r.member_id, memberName: r.member_name, failure: failureOf(r.id, r.task_id), lastActivityAt,
      locate: `#task=${r.task_id}` };
  });
  const eventRows = bounded<EventRow>(
    'SELECT seq, kind, created_at, run_id, turn_id, payload_json FROM domain_events WHERE task_id = ? AND project_id = ? AND (conversation_id = ? OR conversation_id IS NULL) ORDER BY seq DESC', [taskId, projectId, conversationId], 120);
  const events = eventRows.items.map(eventOf);
  const deliveryRows = bounded<{ id: string; revision: number; manifest_hash: string; run_id: string | null; review_status: string; reviewed_at: number | null; review_note: string | null; artifact_refs_json: string; change_set_refs_json: string; verification_refs_json: string }>(
    `SELECT id, revision, manifest_hash, run_id, review_status, reviewed_at, review_note,
      artifact_refs_json, change_set_refs_json, verification_refs_json FROM task_deliveries WHERE task_id = ? ORDER BY revision DESC`, [taskId], 50);
  if(requestedDeliveryId&&!deliveryRows.items.some(d=>d.id===requestedDeliveryId)){
    const pinned=db.prepare('SELECT * FROM task_deliveries WHERE id=? AND task_id=?').get(requestedDeliveryId,taskId) as typeof deliveryRows.items[number]|undefined;
    if(pinned)deliveryRows.items.push(pinned);
  }
  const changeRows = bounded<{ id: string; task_id:string;application_status: string; before_ref: string; after_ref: string }>(
    `SELECT id,task_id,application_status,before_ref,after_ref FROM change_sets WHERE project_id=? AND (task_id=? OR task_id IN
      (SELECT id FROM tasks WHERE parent_task_id=? AND project_id=? AND conversation_id=?)) ORDER BY rowid DESC`, [projectId,taskId,taskId,projectId,conversationId], 100);
  const artifactRows = bounded<{ id: string; kind: string; revision: number; hash: string }>(
    'SELECT id, kind, revision, hash FROM artifacts WHERE task_id = ? AND project_id = ? AND (conversation_id = ? OR conversation_id IS NULL) ORDER BY rowid DESC', [taskId, projectId, conversationId], 100);
  const selectedMemberRun = memberRuns.find((r) => r.id === selectedRunId);
  return {
    executionBlocker: readExecutionBlocker(db, taskId),
    task: { id: task.id as string, projectId: task.project_id as string, conversationId: task.conversation_id as string,
      title: task.title as string, objective: task.objective as string | null, status: task.status as string,
      reviewPolicy: task.review_policy as string, revision: task.revision as number,
      stopGeneration: task.stop_generation as number,
      roomTaskNumber: task.room_task_number as number | null, ownerMemberId: task.owner_member_id as string | null,
      ownerDisplayName: task.owner_display_name as string | null,
      parentTaskId: task.parent_task_id as string | null, currentDeliveryId: task.current_delivery_id as string | null },
    clarificationRetry:{available:clarificationLatest&&!clarificationPending&&scopeBlock==null&&clarificationBlock==null,pending:clarificationPending,blockReason:scopeBlock??clarificationBlock?.message??null},
    failedRetry: { available: failedLatest && !pendingRedispatch && scopeBlock == null && blockedRetry == null,...(integrationRepair||directOutputRepair?{formatRepair:true}:{}),
      pending: Boolean(pendingRedispatch), blockReason: scopeBlock ?? blockedRetry?.message ?? null },
    coordination,
    children: children.items.map((c) => ({ ...c, locate: `#task=${c.id}` })),
    latestRunId, currentRunId, selectedRunId, runs,
    ...(coordination == null ? {} : { memberRuns, memberRunsTruncated: memberRunRows.truncated }),
    events,
    deliveries: deliveryRows.items.map((d) => ({ id: d.id, revision: d.revision, manifestHash: d.manifest_hash,
      runId: d.run_id, reviewStatus: d.review_status, reviewedAt: d.reviewed_at, reviewNote: d.review_note,
      artifactRefs: refs(d.artifact_refs_json), changeSetRefs: refs(d.change_set_refs_json),
      verificationRefs: refs(d.verification_refs_json), locate: `#delivery=${d.id}` })),
    changeSets: changeRows.items.map((c) => {
      const files = bounded<{ path: string; state: string; sha256: string | null; size: number | null }>(
        `SELECT path, state, sha256, size FROM change_set_files WHERE change_set_id = ? AND role = 'after' ORDER BY path`, [c.id], 100);
      return { id: c.id, applicationStatus: c.application_status, beforeRef: c.before_ref,
        afterRef: c.after_ref, locate: `#task=${c.task_id}`, files: files.items, filesTruncated: files.truncated };
    }),
    artifacts: artifactRows.items,
    nextCursors: {
      runs: runRows.truncated ? historyCursor(projectId, taskId, 'runs', undefined, runRows.items.at(-1)!.cursor_id) : null,
      activity: eventRows.truncated ? historyCursor(projectId, taskId, 'activity', undefined, eventRows.items.at(-1)!.seq) : null,
      deliveries: deliveryRows.truncated ? historyCursor(projectId, taskId, 'deliveries', undefined, deliveryRows.items.at(-1)!.revision) : null,
      runActivity: (() => { const r=runs.find(x=>x.id===selectedParentRunId);return r?.eventsTruncated ? historyCursor(projectId,taskId,'activity',selectedParentRunId ?? undefined,r.events.at(-1)!.seq):null; })(),
      ...(selectedMemberRun == null ? {} : { memberRunActivity: selectedMemberRun.eventsTruncated
        ? historyCursor(projectId,taskId,'activity',selectedMemberRun.id,selectedMemberRun.events.at(-1)!.seq) : null }),
    },
    truncated: { children: children.truncated, runs: runRows.truncated, events: eventRows.truncated,
      deliveries: deliveryRows.truncated, changeSets: changeRows.truncated, artifacts: artifactRows.truncated },
  };
}
