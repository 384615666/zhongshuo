import io

# fix awkward return type in worker
p = 'src/daemon/dispatchWorker.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace("""export function activeDeliberationRun(db: ZhongshuoDatabase, taskId: string): { id: string; status: string; stage: string | null; round_no: number | null; roster_revision: number | null; budget_json: string | null } | undefined {
  return db.prepare(
    "SELECT id, status, stage, round_no, roster_revision, budget_json FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY revision DESC LIMIT 1",
  ).get(taskId) as ReturnType<typeof activeDeliberationRun> extends infer T ? T : never;
}""",
"""export interface ActiveDelibRun {
  id: string;
  status: string;
  stage: string | null;
  round_no: number | null;
  roster_revision: number | null;
  budget_json: string | null;
}

/** 活跃研讨 run：最新非终态（同任务多 run 时阶段/派发/预算都绑它）。 */
export function activeDeliberationRun(db: ZhongshuoDatabase, taskId: string): ActiveDelibRun | undefined {
  return db.prepare(
    "SELECT id, status, stage, round_no, roster_revision, budget_json FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY revision DESC LIMIT 1",
  ).get(taskId) as ActiveDelibRun | undefined;
}""")
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('worker type fixed')

# ============ deliberationRunner.ts ============
p2 = 'src/daemon/deliberationRunner.ts'
r = io.open(p2, encoding='utf-8').read()

# DelibStep gains runId; keys carry runId
r = r.replace("""export interface DelibStep {
  taskId: string;
  stage: DelibStageCode;
  memberId: string;
  roundNo: number;
  purpose: 'stage_work' | 'checkpoint' | 'format_repair';
  /** RPR 的修复目标（原步骤的 stage code）。 */
  repairTarget?: DelibStageCode;
}""",
"""export interface DelibStep {
  taskId: string;
  /** 归属 run：派发键/预算/成果都按 run 作用域——同任务新运行不复用旧运行键。 */
  runId: string;
  stage: DelibStageCode;
  memberId: string;
  roundNo: number;
  purpose: 'stage_work' | 'checkpoint' | 'format_repair';
  /** RPR 的修复目标（原步骤的 stage code）。 */
  repairTarget?: DelibStageCode;
}""")
r = r.replace("""export function delibDispatchKey(step: DelibStep): string {
  const purposeChar = step.purpose === 'checkpoint' ? 'c' : step.purpose === 'format_repair' ? 'f' : 'w';
  if (step.stage === 'RPR') {
    return `task:${step.taskId}:delib:RPR:${step.memberId}:${step.roundNo}:${step.repairTarget ?? 'IND'}`;
  }
  return `task:${step.taskId}:delib:${STAGE_CODE[step.stage]}:${step.memberId}:${step.roundNo}:${purposeChar}`;
}

export function parseDelibStep(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:(.+):delib:(IND|CR|ISS|CHK|SYN|RAT|RPR):([^:]+):(\\d+):(w|c|f)$/);
  if (m == null) return null;
  const stage = m[2] as DelibStageCode;
  return {
    taskId: m[1]!,
    stage,
    memberId: m[3]!,
    roundNo: Number(m[4]),
    purpose: m[5] === 'c' ? 'checkpoint' : m[5] === 'f' ? 'format_repair' : 'stage_work',
    repairTarget: stage === 'RPR' ? ((m[5] as unknown as DelibStageCode) ?? 'IND') : undefined,
  };
}

/** RPR 键的目标阶段编码在用途位（w/c/f 位置放目标 code）。 */
export function repairDispatchKey(base: DelibStep): string {
  return `task:${base.taskId}:delib:RPR:${base.memberId}:${base.roundNo}:${base.stage}`;
}

export function parseRepairTarget(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:(.+):delib:RPR:([^:]+):(\\d+):(IND|CR|ISS|CHK|SYN|RAT)$/);
  if (m == null) return null;
  return { taskId: m[1]!, stage: m[4] as DelibStep['stage'], memberId: m[2]!, roundNo: Number(m[3]), purpose: 'format_repair' };
}""",
"""export function delibDispatchKey(step: DelibStep): string {
  const purposeChar = step.purpose === 'checkpoint' ? 'c' : step.purpose === 'format_repair' ? 'f' : 'w';
  if (step.stage === 'RPR') {
    return `task:${step.taskId}:delib:${step.runId}:RPR:${step.memberId}:${step.roundNo}:${step.repairTarget ?? 'IND'}`;
  }
  return `task:${step.taskId}:delib:${step.runId}:${STAGE_CODE[step.stage]}:${step.memberId}:${step.roundNo}:${purposeChar}`;
}

export function parseDelibStep(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:([^:]+):delib:(run_[^:]+):(IND|CR|ISS|CHK|SYN|RAT|RPR):([^:]+):(\\d+):(w|c|f)$/);
  if (m == null) return null;
  const stage = m[4] as DelibStageCode;
  return {
    taskId: m[1]!,
    runId: m[2]!,
    stage,
    memberId: m[5]!,
    roundNo: Number(m[6]),
    purpose: m[7] === 'c' ? 'checkpoint' : m[7] === 'f' ? 'format_repair' : 'stage_work',
  };
}

/** RPR 键的目标阶段编码在用途位（w/c/f 位置放目标 code）。 */
export function repairDispatchKey(base: DelibStep): string {
  return `task:${base.taskId}:delib:${base.runId}:RPR:${base.memberId}:${base.roundNo}:${base.stage}`;
}

export function parseRepairTarget(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:([^:]+):delib:(run_[^:]+):RPR:([^:]+):(\\d+):(IND|CR|ISS|CHK|SYN|RAT)$/);
  if (m == null) return null;
  return { taskId: m[1]!, runId: m[2]!, stage: m[6] as DelibStep['stage'], memberId: m[3]!, roundNo: Number(m[4]), purpose: 'format_repair' };
}""")

# prepareDeliberation: reuse only ACTIVE run; else new run w/ roster_revision+1; enqueue carries runId
r = r.replace("""  const existing = db.prepare('SELECT * FROM workflow_runs WHERE task_id = ? AND mode = ?').get(task.id, 'DELIBERATE') as RunRow | undefined;
  const host = route.initialWakeMemberIds[0] ?? route.frozenMemberIds[0];
  if (host == null) return domainErr('VALIDATION_INVALID', 'DELIBERATE 路由缺少冻结名单');
  if (existing != null) {
    enqueueIndependentSteps(db, existing.id, task.id, route.frozenMemberIds);
    return domainOk({ runId: existing.id });
  }
  const runId = `run_${randomUUID()}`;""",
"""  const host = route.initialWakeMemberIds[0] ?? route.frozenMemberIds[0];
  if (host == null) return domainErr('VALIDATION_INVALID', 'DELIBERATE 路由缺少冻结名单');
  // 复用仅限活跃 run；终态后再次提交=承接新证据的新运行（新键/新版本，§6.5）。
  const existing = db.prepare(
    "SELECT * FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY revision DESC LIMIT 1",
  ).get(task.id) as RunRow | undefined;
  if (existing != null) {
    enqueueIndependentSteps(db, existing.id, task.id, route.frozenMemberIds);
    return domainOk({ runId: existing.id });
  }
  const prevRoster = db.prepare("SELECT COALESCE(MAX(roster_revision), 0) AS r FROM workflow_runs WHERE task_id = ?").get(task.id) as { r: number };
  const runId = `run_${randomUUID()}`;""")
r = r.replace("""       VALUES (?, ?, ?, ?, 'DELIBERATE', 0, 'RUNNING', 'INDEPENDENT', 0, 1, ?, ?)`,
    ).run(runId, task.id, task.conversationId, task.threadId, JSON.stringify(budget), Date.now());""",
"""       VALUES (?, ?, ?, ?, 'DELIBERATE', 0, 'RUNNING', 'INDEPENDENT', 0, ?, ?, ?)`,
    ).run(runId, task.id, task.conversationId, task.threadId, prevRoster.r + 1, JSON.stringify(budget), Date.now());""")
r = r.replace("""      payload: { stage: 'INDEPENDENT', rosterRevision: 1, members: route.frozenMemberIds },""",
"""      payload: { stage: 'INDEPENDENT', rosterRevision: prevRoster.r + 1, members: route.frozenMemberIds },""")
r = r.replace("""function enqueueIndependentSteps(db: ZhongshuoDatabase, runId: string, taskId: string, memberIds: readonly string[]): void {
  void runId;
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'IND', memberId, roundNo: 0, purpose: 'stage_work' }) });
    }
  });
  tx();
}""",
"""function enqueueIndependentSteps(db: ZhongshuoDatabase, runId: string, taskId: string, memberIds: readonly string[]): void {
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'IND', memberId, roundNo: 0, purpose: 'stage_work' }) });
    }
  });
  tx();
}""")
r = r.replace("""function enqueueReviewerSteps(db: ZhongshuoDatabase, taskId: string, reviewerIds: readonly string[]): void {
  const tx = db.transaction(() => {
    for (const memberId of reviewerIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'CR', memberId, roundNo: 0, purpose: 'stage_work' }) });
    }
  });
  tx();
}""",
"""function enqueueReviewerSteps(db: ZhongshuoDatabase, runId: string, taskId: string, reviewerIds: readonly string[]): void {
  const tx = db.transaction(() => {
    for (const memberId of reviewerIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'CR', memberId, roundNo: 0, purpose: 'stage_work' }) });
    }
  });
  tx();
}""")
r = r.replace("""function enqueueIssueSteps(db: ZhongshuoDatabase, taskId: string, memberIds: readonly string[], round: number): void {
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'ISS', memberId, roundNo: round, purpose: 'stage_work' }) });
    }
  });
  tx();
}""",
"""function enqueueIssueSteps(db: ZhongshuoDatabase, runId: string, taskId: string, memberIds: readonly string[], round: number): void {
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'ISS', memberId, roundNo: round, purpose: 'stage_work' }) });
    }
  });
  tx();
}""")
r = r.replace("""function enqueueSynthesis(db: ZhongshuoDatabase, taskId: string, hostId: string): void {
  const tx = db.transaction(() => {
    enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'SYN', memberId: hostId, roundNo: 0, purpose: 'stage_work' }) });
  });
  tx();
}""",
"""function enqueueSynthesis(db: ZhongshuoDatabase, runId: string, taskId: string, hostId: string): void {
  const tx = db.transaction(() => {
    enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'SYN', memberId: hostId, roundNo: 0, purpose: 'stage_work' }) });
  });
  tx();
}""")

io.open(p2, 'w', encoding='utf-8', newline='\n').write(r)
print('runner keys patched')
