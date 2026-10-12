import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { TaskDetailEvent, TaskDetailsResult, TaskHistoryParams, TaskHistoryPage } from '../contracts/taskDetails.ts';
import { assessTaskRedispatchReadiness } from '../persistence/stores/recoveryGuard.ts';

type EventRow = { seq: number; kind: string; created_at: number; run_id: string | null; turn_id: string | null; payload_json: string };
const eventOf = (e: EventRow): TaskDetailEvent => {
    const payload: unknown = JSON.parse(e.payload_json);
    const p = payload != null && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const summary = [p.message, p.reason, p.question, p.status, p.toolName, p.outcome, p.note]
      .find((x): x is string => typeof x === 'string')?.slice(0, 200) ?? '';
    return { seq: e.seq, kind: e.kind, at: e.created_at, runId: e.run_id, turnId: e.turn_id,
      toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : null, summary,
      status: typeof p.status==='string'?p.status:null, code:typeof p.code==='string'?p.code:null };
  };

const historyCursor = (projectId: string, taskId: string, kind: string, runId: string | undefined, before: number) => Buffer.from(JSON.stringify({ projectId, taskId, kind, runId: runId ?? null, before })).toString('base64url');

/** Stable sequence/rowid pages; command layer rechecks audience on every page. */
export function readTaskHistory(db: ZhongshuoDatabase, params: TaskHistoryParams): TaskHistoryPage {
  const { projectId, taskId, kind, runId } = params;
  const task = db.prepare('SELECT conversation_id FROM tasks WHERE id = ? AND project_id = ?').get(taskId, projectId) as { conversation_id: string };
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
    const rows = db.prepare(`SELECT seq,kind,created_at,run_id,turn_id,payload_json FROM domain_events WHERE task_id=? AND project_id=? AND (conversation_id=? OR conversation_id IS NULL) AND seq<? ${runId ? 'AND run_id=?' : ''} ORDER BY seq DESC LIMIT 121`).all(taskId,projectId,task.conversation_id,before,...(runId?[runId]:[])) as EventRow[];
    return { kind, items:rows.slice(0,120).map(eventOf), nextCursor:rows.length>120 ? historyCursor(projectId,taskId,kind,runId,rows[119]!.seq):null };
  }
  const rows = db.prepare(`SELECT id,revision,manifest_hash,run_id,review_status,reviewed_at,review_note,artifact_refs_json,change_set_refs_json,verification_refs_json FROM task_deliveries WHERE task_id=? AND revision<? ORDER BY revision DESC LIMIT 51`).all(taskId,before) as Array<{id:string;revision:number;manifest_hash:string;run_id:string|null;review_status:string;reviewed_at:number|null;review_note:string|null;artifact_refs_json:string;change_set_refs_json:string;verification_refs_json:string}>;
  const refs = (s:string):string[] => { const value:unknown=JSON.parse(s);return Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'):[]; };
  return {kind,items:rows.slice(0,50).map(d=>({id:d.id,revision:d.revision,manifestHash:d.manifest_hash,runId:d.run_id,reviewStatus:d.review_status,reviewedAt:d.reviewed_at,reviewNote:d.review_note,artifactRefs:refs(d.artifact_refs_json),changeSetRefs:refs(d.change_set_refs_json),verificationRefs:refs(d.verification_refs_json),locate:`#delivery=${d.id}`})),nextCursor:rows.length>50?historyCursor(projectId,taskId,kind,runId,rows[49]!.revision):null};
}

/** Query only facts already persisted by the formal task/worker path. Caller checks scope and audience. */
export function readTaskDetails(db: ZhongshuoDatabase, taskId: string, requestedRunId?: string): TaskDetailsResult {
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
  const selectedRunId = requestedRunId ?? latestRunId;
  const selectedIsOutsideWindow = selectedRunId != null && !runRows.items.some((r) => r.id === selectedRunId);
  const selectedRow = selectedIsOutsideWindow ? db.prepare(`SELECT rowid AS cursor_id, id, mode, status, stage, round_no, revision, budget_json
    FROM workflow_runs WHERE id = ? AND task_id = ? AND conversation_id = ?`).get(selectedRunId, taskId, conversationId) as RunRow | undefined : undefined;
  const failedLatest = task.status === 'ACTIVE' && task.stop_generation === 0 && runRows.items[0]?.status === 'FAILED';
  const availability = db.prepare(`SELECT p.status AS project_status, c.archived_at AS conversation_archived,
    r.archived_at AS room_archived FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN conversations c ON c.id = t.conversation_id LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?`)
    .get(taskId) as { project_status: string; conversation_archived: number | null; room_archived: number | null };
  const scopeBlock = availability.project_status !== 'active' ? '项目已归档或不可用；先恢复项目。'
    : availability.conversation_archived != null ? '会话已归档；先恢复会话。'
      : availability.room_archived != null ? '房间已归档；先恢复房间。' : null;
  const pendingRedispatch = failedLatest && db.prepare(`SELECT 1 FROM outbox WHERE dispatch_key = ? AND status != 'done'`)
    .get(`task:${taskId}:redispatch:${latestRunId}`) != null;
  const blockedRetry = failedLatest && !pendingRedispatch && scopeBlock == null ? assessTaskRedispatchReadiness(db, taskId) : null;
  const visibleRunRows = selectedRow == null ? runRows.items : [...runRows.items, selectedRow];
  const runs = visibleRunRows.map((r) => {
    if (r.id !== selectedRunId) return { id: r.id, mode: r.mode, status: r.status, stage: r.stage, roundNo: r.round_no, revision: r.revision,
      budget: null, participants: [], turns: [], turnsTruncated: false, events: [], eventsTruncated: false, detailLoaded: false };
    const participants = (db.prepare(`SELECT rp.member_id, pm.display_name, rp.role, rp.expected, rp.status
      FROM run_participants rp JOIN project_members pm ON pm.id = rp.member_id WHERE rp.run_id = ? AND pm.project_id = ? ORDER BY rp.role, rp.member_id`)
      .all(r.id, projectId) as Array<{ member_id: string; display_name: string; role: string; expected: number; status: string }>).map((p) => ({
      memberId: p.member_id, displayName: p.display_name, role: p.role, expected: p.expected === 1, status: p.status,
    }));
    const turnRows = bounded<{ id: string; member_id: string; display_name: string; status: string; stage_key: string; turn_purpose: string; attempt: number }>(
      `SELECT a.id, a.member_id, pm.display_name, a.status, a.stage_key, a.turn_purpose, a.attempt
       FROM agent_turns a JOIN project_members pm ON pm.id = a.member_id WHERE a.run_id = ? AND a.conversation_id = ? AND pm.project_id = ? ORDER BY a.rowid DESC`, [r.id, conversationId, projectId], 80);
    const turns = turnRows.items.map((t) => {
      const usageRows = bounded<{ normalized_json: string; cost_quality: string }>(
        'SELECT normalized_json, cost_quality FROM usage_records WHERE turn_id = ? ORDER BY rowid DESC', [t.id], 50);
      return { id: t.id, memberId: t.member_id, displayName: t.display_name, status: t.status, stageKey: t.stage_key,
        purpose: t.turn_purpose, attempt: t.attempt, usage: usageRows.items.map((u) => ({ normalized: parse(u.normalized_json), quality: u.cost_quality })), usageTruncated: usageRows.truncated };
    });
    const runEvents = bounded<EventRow>(
      `SELECT seq, kind, created_at, run_id, turn_id, payload_json FROM domain_events
       WHERE run_id = ? AND task_id = ? AND project_id = ? AND (conversation_id = ? OR conversation_id IS NULL)
       ORDER BY seq DESC`, [r.id, taskId, projectId, conversationId], 120);
    return { id: r.id, mode: r.mode, status: r.status, stage: r.stage, roundNo: r.round_no, revision: r.revision,
      budget: parse(r.budget_json), participants, turns, turnsTruncated: turnRows.truncated,
      events: runEvents.items.map(eventOf), eventsTruncated: runEvents.truncated, detailLoaded: true };
  });
  const eventRows = bounded<EventRow>(
    'SELECT seq, kind, created_at, run_id, turn_id, payload_json FROM domain_events WHERE task_id = ? AND project_id = ? AND (conversation_id = ? OR conversation_id IS NULL) ORDER BY seq DESC', [taskId, projectId, conversationId], 120);
  const events = eventRows.items.map(eventOf);
  const deliveryRows = bounded<{ id: string; revision: number; manifest_hash: string; run_id: string | null; review_status: string; reviewed_at: number | null; review_note: string | null; artifact_refs_json: string; change_set_refs_json: string; verification_refs_json: string }>(
    `SELECT id, revision, manifest_hash, run_id, review_status, reviewed_at, review_note,
      artifact_refs_json, change_set_refs_json, verification_refs_json FROM task_deliveries WHERE task_id = ? ORDER BY revision DESC`, [taskId], 50);
  const changeRows = bounded<{ id: string; application_status: string; before_ref: string; after_ref: string }>(
    'SELECT id, application_status, before_ref, after_ref FROM change_sets WHERE task_id = ? AND project_id = ? ORDER BY rowid DESC', [taskId, projectId], 100);
  const artifactRows = bounded<{ id: string; kind: string; revision: number; hash: string }>(
    'SELECT id, kind, revision, hash FROM artifacts WHERE task_id = ? AND project_id = ? AND (conversation_id = ? OR conversation_id IS NULL) ORDER BY rowid DESC', [taskId, projectId, conversationId], 100);
  return {
    task: { id: task.id as string, projectId: task.project_id as string, conversationId: task.conversation_id as string,
      title: task.title as string, objective: task.objective as string | null, status: task.status as string,
      reviewPolicy: task.review_policy as string, revision: task.revision as number,
      stopGeneration: task.stop_generation as number,
      roomTaskNumber: task.room_task_number as number | null, ownerMemberId: task.owner_member_id as string | null,
      ownerDisplayName: task.owner_display_name as string | null,
      parentTaskId: task.parent_task_id as string | null, currentDeliveryId: task.current_delivery_id as string | null },
    failedRetry: { available: failedLatest && !pendingRedispatch && scopeBlock == null && blockedRetry == null,
      pending: Boolean(pendingRedispatch), blockReason: scopeBlock ?? blockedRetry?.message ?? null },
    children: children.items.map((c) => ({ ...c, locate: `#task=${c.id}` })),
    latestRunId, currentRunId, selectedRunId, runs, events,
    deliveries: deliveryRows.items.map((d) => ({ id: d.id, revision: d.revision, manifestHash: d.manifest_hash,
      runId: d.run_id, reviewStatus: d.review_status, reviewedAt: d.reviewed_at, reviewNote: d.review_note,
      artifactRefs: refs(d.artifact_refs_json), changeSetRefs: refs(d.change_set_refs_json),
      verificationRefs: refs(d.verification_refs_json), locate: `#delivery=${d.id}` })),
    changeSets: changeRows.items.map((c) => {
      const files = bounded<{ path: string; state: string; sha256: string | null; size: number | null }>(
        `SELECT path, state, sha256, size FROM change_set_files WHERE change_set_id = ? AND role = 'after' ORDER BY path`, [c.id], 100);
      return { id: c.id, applicationStatus: c.application_status, beforeRef: c.before_ref,
        afterRef: c.after_ref, locate: `#task=${taskId}`, files: files.items, filesTruncated: files.truncated };
    }),
    artifacts: artifactRows.items,
    nextCursors: {
      runs: runRows.truncated ? historyCursor(projectId, taskId, 'runs', undefined, runRows.items.at(-1)!.cursor_id) : null,
      activity: eventRows.truncated ? historyCursor(projectId, taskId, 'activity', undefined, eventRows.items.at(-1)!.seq) : null,
      deliveries: deliveryRows.truncated ? historyCursor(projectId, taskId, 'deliveries', undefined, deliveryRows.items.at(-1)!.revision) : null,
      runActivity: (() => { const r=runs.find(x=>x.id===selectedRunId);return r?.eventsTruncated ? historyCursor(projectId,taskId,'activity',selectedRunId ?? undefined,r.events.at(-1)!.seq):null; })(),
    },
    truncated: { children: children.truncated, runs: runRows.truncated, events: eventRows.truncated,
      deliveries: deliveryRows.truncated, changeSets: changeRows.truncated, artifacts: artifactRows.truncated },
  };
}
