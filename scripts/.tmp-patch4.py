import io, re

p = 'src/daemon/deliberationRunner.ts'
s = io.open(p, encoding='utf-8').read()

# ---- pump: active-run + remove stage-wide absence + deterministic RATIFY close + call sites with runId ----
s = s.replace("""  const run = db.prepare('SELECT * FROM workflow_runs WHERE task_id = ? AND mode = ?').get(taskId, 'DELIBERATE') as (RunRow & { stage_started_at: number | null }) | undefined;
  if (run == null) return { advanced: false };
  if (run.status === 'INTERRUPTED') {""",
"""  // 活跃 run：同任务多 run 时只推进最新非终态（旧 run 遗留不复活）。
  const run = db.prepare(
    "SELECT * FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY revision DESC LIMIT 1",
  ).get(taskId) as (RunRow & { stage_started_at: number | null }) | undefined;
  if (run == null) return { advanced: false };
  if (run.status === 'INTERRUPTED') {""")

# remove stage-wide absence marking (queue-wait ≠ absence); participants read stays
s = s.replace("""  const roster = rosterOf(db, run.id);
  let participants = participantsOf(db, run.id);
  const drafts = frozenDrafts(db, run.id);
  const stage = run.stage ?? 'INDEPENDENT';

  // E4：阶段开始超过容忍窗口仍未产出的 pending 席位 → absent（不打断在途成员）。
  const stageAge = run.stage_started_at != null ? now - run.stage_started_at : 0;
  if (options.absenceToleranceMs > 0 && stageAge >= options.absenceToleranceMs) {
    markOverdueAbsent(db, run.id, stage, now);
    participants = participantsOf(db, run.id); // 缺席标记后重读（否则屏障看到陈旧 pending）
  }""",
"""  const roster = rosterOf(db, run.id);
  // E4 语义（修复轮）：排队等待≠缺席——缺席只来自成员自己的执行事实（单轮截止中断/
  // UNKNOWN，由 worker 终态处理写入）。此处不再按阶段起算时间批量标记 pending。
  const participants = participantsOf(db, run.id);
  const drafts = frozenDrafts(db, run.id);
  const stage = run.stage ?? 'INDEPENDENT';""")

# stale-step guard in pump's fallback LIKE key: run-scoped
s = s.replace('db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ? AND status IN (\'pending\',\'leased\')").get(`task:${taskId}:delib:%`)',
              'db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ? AND status IN (\'pending\',\'leased\')").get(`task:${taskId}:delib:${run.id}:%`)')

# call sites: pass run.id
s = s.replace("enqueueSynthesis(db, taskId, hostOf(roster));", "enqueueSynthesis(db, run.id, taskId, hostOf(roster));")
s = s.replace("enqueueSynthesis(db, taskId, host);", "enqueueSynthesis(db, run.id, taskId, host);")
s = s.replace("enqueueReviewerSteps(db, taskId, drafts.map((d) => d.memberId));", "enqueueReviewerSteps(db, run.id, taskId, drafts.map((d) => d.memberId));")
s = s.replace("enqueueIssueSteps(db, taskId, reviewers, 1);", "enqueueIssueSteps(db, run.id, taskId, reviewers, 1);")
s = s.replace("enqueueIssueSteps(db, taskId, reviewers, round + 1);", "enqueueIssueSteps(db, run.id, taskId, reviewers, round + 1);")
s = s.replace("enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'CHK', memberId: host, roundNo: round, purpose: 'checkpoint' }) });",
              "enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId: run.id, stage: 'CHK', memberId: host, roundNo: round, purpose: 'checkpoint' }) });")

# SYN step completion enqueue with runId
s = s.replace("enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId: input.taskId, stage: 'RAT', memberId, roundNo: 0, purpose: 'stage_work' }) });",
              "enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId: input.taskId, runId: input.runId, stage: 'RAT', memberId, roundNo: 0, purpose: 'stage_work' }) });")

# ---- RATIFY: deterministic close (no wall-clock) ----
old_ratify = s[s.index("    case 'RATIFY': {"):]
old_ratify = old_ratify[:old_ratify.index("    default:")]
new_ratify = """    case 'RATIFY': {
      const synthesis = currentSynthesisVersion(db, run.id);
      if (synthesis == null) return { advanced: false };
      const claims = getSynthesisClaims(db, run.id, synthesis.artifactId, synthesis.revision).map((c) => c.claim_id);
      const records = getRatificationRecords(db, run.id, synthesis.artifactId, synthesis.revision);
      const expectedMembers = roster.members.map((m) => m.memberId);
      // 屏障收口（确定性，非 wall-clock）：待定格的成员若仍有可派发/在途的 RAT 步骤则等待；
      // 否则（席位失败/缺席/预算跳过）按 missing 关闭——程序记录，不伪造意见。
      const waiting = expectedMembers.filter((memberId) => {
        const cells = records.filter((r) => r.member_id === memberId);
        if (cells.length === 0) return true; // 矩阵不完整：等（不应发生）
        if (cells.some((r) => r.response_status === 'submitted')) return false;
        const participant = statusOf(participants, memberId);
        if (participant === 'failed' || participant === 'absent') return false;
        const itemPending = (db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ? AND status IN ('pending','leased')").get(`task:${taskId}:delib:${run.id}:RAT:${memberId}:%`) as { c: number }).c > 0;
        const turnActive = (db.prepare("SELECT count(*) c FROM agent_turns t JOIN outbox o ON o.turn_id = t.id WHERE t.run_id = ? AND t.member_id = ? AND t.stage_key = 'delib.ratify' AND t.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT')").get(run.id, memberId) as { c: number }).c > 0;
        return itemPending || turnActive;
      });
      if (waiting.length > 0) return { advanced: false };
      closeRatificationBarrier(db, { runId: run.id, synthesisArtifactId: synthesis.artifactId, synthesisRevision: synthesis.revision, missingReason: '席位终结（失败/缺席/预算跳过），未回复' });
      publishFinalReport(db, { runId: run.id, taskId, conversationId: task.conversation_id, threadId, claims, expectedMembers, synthesis, now, blobDir: options.blobDir, reviewPolicy: reviewPolicyOf(db, taskId) });
      return { advanced: true };
    }
"""
s = s.replace(old_ratify, new_ratify)

# ---- onStepOutput: guards + late handling ----
s = s.replace("""export function onStepOutput(db: ZhongshuoDatabase, input: {
  taskId: string;
  runId: string;
  step: DelibStep;
  turnId: string;
  finalText: string;
  options: DeliberationOptions;
  now?: number;
}): DomainResult<StepOutputResult> {
  const now = input.now ?? Date.now();
  const schema = STEP_SCHEMAS[input.step.stage];""",
"""export function onStepOutput(db: ZhongshuoDatabase, input: {
  taskId: string;
  runId: string;
  step: DelibStep;
  turnId: string;
  finalText: string;
  options: DeliberationOptions;
  now?: number;
}): DomainResult<StepOutputResult> {
  const now = input.now ?? Date.now();
  // 迟到/过期守卫（修复轮）：运行已终结/已停止/step 归属旧 run → 只留迟到材料记录，
  // 不计入屏障、不复活运行（更新报告须走新运行/新版本，§6.5/E4）。
  const runRow = db.prepare('SELECT status, stage FROM workflow_runs WHERE id = ?').get(input.runId) as { status: string; stage: string | null } | undefined;
  const taskRow0 = db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(input.taskId) as { stop_generation: number; status: string } | undefined;
  const runTerminal = runRow == null || !['RUNNING', 'WAITING'].includes(runRow.status);
  const stopped = taskRow0 != null && (taskRow0.stop_generation > 0 || taskRow0.status === 'CANCELLED');
  if (runTerminal || stopped || input.step.runId !== input.runId) {
    return recordLateArrival(db, input, now, runTerminal ? `run-${runRow?.status ?? 'gone'}` : stopped ? 'task-stopped' : 'stale-run');
  }
  const schema = STEP_SCHEMAS[input.step.stage];""")

# late-record helper + late participant transition inside normal path
s = s.replace("""  const tx = db.transaction(() => {
    db.prepare("UPDATE run_participants SET status = 'completed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(input.runId, input.step.memberId);""",
"""  const tx = db.transaction(() => {
    const wasAbsent = statusOf(participantsOf(db, input.runId), input.step.memberId) === 'absent';
    db.prepare("UPDATE run_participants SET status = ? WHERE run_id = ? AND member_id = ? AND status IN ('pending','late','absent')")
      .run(wasAbsent ? 'late' : 'completed', input.runId, input.step.memberId);
    if (wasAbsent) {
      appendDomainEvent(db, {
        schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: projectIdOf(db, input.taskId), conversationId: '',
        threadId: null, taskId: input.taskId, runId: input.runId, kind: 'run.lateArrivalRecorded', createdAt: now,
        payload: { memberId: input.step.memberId, stage: input.step.stage, roundNo: input.step.roundNo, note: '缺席后成果到达，纳入后续未冻结输入' },
      });
    }""")

# append recordLateArrival at end (before final closing brace of file is risky—place after onStepOutput by anchoring on the trailing comment marker)
s = s.replace("""// ---------- 步骤输入组装（服务端隔离） ----------""",
"""/**
 * 迟到材料记录（不计数）：发布 artifact（run 作用域）+ 审计事件。
 * 已停止/旧 run/发布后到达——只展示迟到材料；报告更新走新运行/新版本。
 */
function recordLateArrival(db: ZhongshuoDatabase, input: { taskId: string; runId: string; step: DelibStep; turnId: string; finalText: string; options: DeliberationOptions }, now: number, reason: string): DomainResult<StepOutputResult> {
  const schema = STEP_SCHEMAS[input.step.stage];
  if (schema == null) return domainErr('VALIDATION_INVALID', `未知研讨步骤 ${input.step.stage}`);
  const parsed = schema.safeParse(JSON.parse(input.finalText));
  if (!parsed.success) return domainOk({ counted: false, needsRepair: `迟到输出未通过校验（${reason}）` });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId) as
    | { id: string; project_id: string; conversation_id: string; conversation_thread_id: string | null }
    | undefined;
  if (task == null) return domainErr('RESOURCE_NOT_FOUND', '任务不存在');
  const artifactId = `art_${input.turnId}`;
  const kind = stepArtifactKind(input.step.stage);
  const revision = input.step.stage === 'ISS' || input.step.stage === 'CHK' ? input.step.roundNo : 1;
  const published = publishDeliberationArtifact(db, {
    artifactId, projectId: task.project_id, conversationId: task.conversation_id, threadId: task.conversation_thread_id ?? '',
    taskId: input.taskId, runId: input.runId, authorId: input.step.memberId, kind, revision,
    payload: parsed.data, blobDir: input.options.blobDir, now,
  });
  if (!published.ok) return domainErr(published.error.code, published.error.message);
  appendDomainEvent(db, {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: task.project_id, conversationId: task.conversation_id,
    threadId: task.conversation_thread_id, taskId: input.taskId, runId: input.runId, kind: 'run.lateArrivalRecorded', createdAt: now,
    payload: { memberId: input.step.memberId, stage: input.step.stage, roundNo: input.step.roundNo, reason, artifactId, counted: false },
  });
  return domainOk({ counted: false, lateRecorded: true });
}

function stepArtifactKind(stage: DelibStageCode): Parameters<typeof publishDeliberationArtifact>[0]['kind'] {
  return stage === 'IND' ? 'analysis_draft'
    : stage === 'CR' ? 'cross_review'
      : stage === 'ISS' ? 'issue_position'
        : stage === 'CHK' ? 'checkpoint_verdict'
          : stage === 'SYN' ? 'synthesis'
            : 'ratify_response';
}

// ---------- 步骤输入组装（服务端隔离） ----------""")

# drop markOverdueAbsent/memberHasStageOutput/absenceDue (dead wrong logic) — remove functions
start = s.find('function markOverdueAbsent(')
if start >= 0:
    end = s.find('function advanceStage(')
    s = s[:start] + s[end:]
start2 = s.find('/** 超过容忍窗口')
if start2 >= 0:
    end2 = s.find('}', s.find('absenceDue', start2)) + 1
    # remove trailing absenceDue block conservatively: find its closing
    seg_start = s.rfind('\n', 0, start2)
    # locate the full function: from comment to the closing brace line
    m_end = s.find('\n}\n', start2)
    s = s[:seg_start] + s[m_end + 3:]

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('runner patched')
