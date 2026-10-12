import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { TaskDetailEvent, TaskDetailsResult } from '../contracts/taskDetails.ts';

/** Query only facts already persisted by the formal task/worker path. Caller checks scope and audience. */
export function readTaskDetails(db: ZhongshuoDatabase, taskId: string, requestedRunId?: string): TaskDetailsResult {
  const task = db.prepare(`SELECT t.id, t.project_id, t.conversation_id, t.title, t.objective, t.status, t.review_policy, t.revision,
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
  type EventRow = { seq: number; kind: string; created_at: number; run_id: string | null; turn_id: string | null; payload_json: string };
  const eventOf = (e: EventRow): TaskDetailEvent => {
    const payload = parse(e.payload_json);
    const p = payload != null && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const summary = [p.message, p.reason, p.status, p.toolName, p.outcome, p.note]
      .find((x): x is string => typeof x === 'string')?.slice(0, 200) ?? '';
    return { seq: e.seq, kind: e.kind, at: e.created_at, runId: e.run_id, turnId: e.turn_id,
      toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : null, summary };
  };
  const children = bounded<{ id: string; title: string; status: string }>(
    'SELECT id, title, status FROM tasks WHERE parent_task_id = ? AND project_id = ? AND conversation_id = ? ORDER BY rowid DESC', [taskId, projectId, conversationId], 50);
  type RunRow = { id: string; mode: string; status: string; stage: string | null; round_no: number | null; revision: number; budget_json: string | null };
  const runRows = bounded<RunRow>(
    'SELECT id, mode, status, stage, round_no, revision, budget_json FROM workflow_runs WHERE task_id = ? AND conversation_id = ? ORDER BY rowid DESC', [taskId, conversationId], 20);
  const latestRunId = runRows.items[0]?.id ?? null;
  const currentRunId = runRows.items[0] != null && ['QUEUED', 'RUNNING', 'WAITING', 'STOPPING'].includes(runRows.items[0].status)
    ? runRows.items[0].id : null;
  const selectedRunId = requestedRunId ?? latestRunId;
  const selectedIsOutsideWindow = selectedRunId != null && !runRows.items.some((r) => r.id === selectedRunId);
  const selectedRow = selectedIsOutsideWindow ? db.prepare(`SELECT id, mode, status, stage, round_no, revision, budget_json
    FROM workflow_runs WHERE id = ? AND task_id = ? AND conversation_id = ?`).get(selectedRunId, taskId, conversationId) as RunRow | undefined : undefined;
  const visibleRunRows = selectedRow == null ? runRows.items : [...runRows.items, selectedRow];
  const runs = visibleRunRows.map((r) => {
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
      events: runEvents.items.map(eventOf), eventsTruncated: runEvents.truncated };
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
      roomTaskNumber: task.room_task_number as number | null, ownerMemberId: task.owner_member_id as string | null,
      ownerDisplayName: task.owner_display_name as string | null,
      parentTaskId: task.parent_task_id as string | null, currentDeliveryId: task.current_delivery_id as string | null },
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
    truncated: { children: children.truncated, runs: runRows.truncated, events: eventRows.truncated,
      deliveries: deliveryRows.truncated, changeSets: changeRows.truncated, artifacts: artifactRows.truncated },
  };
}
