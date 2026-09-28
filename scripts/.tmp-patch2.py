import io, re

# ============ dispatchWorker.ts ============
p = 'src/daemon/dispatchWorker.ts'
s = io.open(p, encoding='utf-8').read()

# 1. clock option
s = s.replace("""  /** DELIBERATE 总调用上限覆盖（缺省按 E12 核心公式推导）。 */
  deliberateMaxTurns?: number;
}""",
"""  /** DELIBERATE 总调用上限覆盖（缺省按 E12 核心公式推导）。 */
  deliberateMaxTurns?: number;
  /** 可注入时钟（默认 Date.now）：领取租约/泵判定在判定时点取当前时间，drain 循环不复用旧 now。 */
  clock?: () => number;
}""")
s = s.replace("""  private readonly enableDeliberate: boolean;
  private readonly absenceToleranceMs: number;
  private readonly deliberateMaxTurns?: number;""",
"""  private readonly enableDeliberate: boolean;
  private readonly absenceToleranceMs: number;
  private readonly deliberateMaxTurns?: number;
  private readonly clock: () => number;""")
s = s.replace("""    this.enableDeliberate = options.enableDeliberate === true;
    this.absenceToleranceMs = options.absenceToleranceMs ?? 20 * 60_000;
    this.deliberateMaxTurns = options.deliberateMaxTurns;
  }""",
"""    this.enableDeliberate = options.enableDeliberate === true;
    this.absenceToleranceMs = options.absenceToleranceMs ?? 20 * 60_000;
    this.deliberateMaxTurns = options.deliberateMaxTurns;
    this.clock = options.clock ?? (() => Date.now());
  }""")

# 2. runOnce fresh clock; drain no stale now
s = s.replace("""  async runOnce(now = Date.now()): Promise<boolean> {
    if (isDispatchGateHeld(this.db)) return false;
    // DELIBERATE 泵：缺席标记/屏障推进/下一步入队（幂等；不依赖完成事件驱动）。
    if (this.enableDeliberate) this.pumpDeliberations(now);
    const claimed = claimNextOutbox(this.db, {
      leaseOwner: this.leaseOwner,
      leaseUntil: now + this.leaseMs,
      now,
    });
    if (claimed == null) return false;
    await this.dispatchClaimed(claimed);
    return true;
  }""",
"""  async runOnce(now?: number): Promise<boolean> {
    if (isDispatchGateHeld(this.db)) return false;
    // 时钟：在判定时点读取（可注入）；drain 循环每轮取新值，不复用进入时的 now。
    const at = now ?? this.clock();
    // DELIBERATE 泵：屏障推进/下一步入队（幂等；不依赖完成事件驱动）。
    if (this.enableDeliberate) this.pumpDeliberations(at);
    const claimed = claimNextOutbox(this.db, {
      leaseOwner: this.leaseOwner,
      leaseUntil: at + this.leaseMs,
      now: at,
    });
    if (claimed == null) return false;
    await this.dispatchClaimed(claimed);
    return true;
  }""")
s = s.replace("""  async drain(now = Date.now()): Promise<number> {
    let processed = 0;
    while (await this.runOnce(now)) processed += 1;
    return processed;
  }""",
"""  async drain(): Promise<number> {
    let processed = 0;
    while (await this.runOnce()) processed += 1;
    return processed;
  }""")

# 3. dispatchDeliberationStep: run-scoped keys validation + full-text bundle + stale run guard
s = s.replace("""    const run = this.db.prepare("SELECT * FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE'").get(step.taskId) as
      | { id: string; status: string; stage: string | null; budget_json: string | null }
      | undefined;
    if (run == null || !['RUNNING', 'WAITING'].includes(run.status)) {
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }""",
"""    // 活跃 run（最新非终态）：阶段查询/派发/预算都绑定它——旧 run 的遗留步骤不执行。
    const run = activeDeliberationRun(this.db, step.taskId);
    if (run == null || ('runId' in step && step.runId != null && step.runId !== run.id)) {
      await completeOutbox(this.db, claimed.id, claimed.attempt_epoch);
      return;
    }""")
s = s.replace("""      ).run(bundleId, turnId, task.conversation_thread_id, JSON.stringify({ stage: assembly.value.stage, memberId: step.memberId, roundNo: step.roundNo, turnPurpose: assembly.value.turnPurpose, instruction: assembly.value.instruction, outputContract: assembly.value.outputContract, textHash }), textHash);""",
"""      // 全文入 bundle（PP-04：真实输入可核对——审计用 sha256(text) 复核）。
      ).run(bundleId, turnId, task.conversation_thread_id, JSON.stringify({ stage: assembly.value.stage, memberId: step.memberId, roundNo: step.roundNo, turnPurpose: assembly.value.turnPurpose, instruction: assembly.value.instruction, outputContract: assembly.value.outputContract, text: assembly.value.text }), textHash);""")

# 4. consumeUntilTerminal UNKNOWN path: delib turns → member absent, run 继续
s = s.replace("""    const current = this.db
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
  }""",
"""    const current = this.db
      .prepare('SELECT status FROM agent_turns WHERE id = ?')
      .get(turnId) as { status: string } | undefined;
    if (current != null && !isTurnTerminalStatus(current.status)) {
      const stageKey = (this.db.prepare('SELECT stage_key FROM agent_turns WHERE id = ?').get(turnId) as { stage_key: string }).stage_key;
      const tx = this.db.transaction(() => {
        this.db.prepare(`UPDATE agent_turns SET status = 'UNKNOWN' WHERE id = ?`).run(turnId);
        if (stageKey.startsWith('delib.')) {
          // 研讨轮结果不确定（§10.2 不伪造）：成员级缺席（E4），运行继续——
          // 不因单成员 UNKNOWN 杀死整个研讨；全员无产出由泵走 BLOCKED。
          const memberRow = this.db.prepare('SELECT member_id FROM agent_turns WHERE id = ?').get(turnId) as { member_id: string };
          this.db.prepare("UPDATE run_participants SET status = 'absent' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, memberRow.member_id);
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'UNKNOWN', reason: 'no-terminal-after-deadline', memberAbsenced: memberRow.member_id });
        } else {
          this.db.prepare(`UPDATE workflow_runs SET status = 'INTERRUPTED' WHERE id = ?`).run(runId);
          this.audit(task, runId, turnId, 'turn.statusChanged', { status: 'UNKNOWN', reason: 'no-terminal-after-deadline' });
        }
      });
      tx();
      if (stageKey.startsWith('delib.')) pumpDeliberation(this.db, task.id, this.deliberationOptions());
    }
  }""")

# 5. applyDeliberationTerminal turn.failed: 区分用户停止 vs 截止中断；审计带 message
s = s.replace("""    if (event.kind === 'turn.failed') {
      const interrupted = event.code === 'INTERRUPTED';
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, interrupted ? 'CANCELLED' : 'FAILED');
        this.settleDelibBudget(runId);
        if (interrupted) {
          this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?`).run(runId);
          this.transitionTask(task.id, 'CANCELLED');
        } else if (baseStep != null) {
          this.db.prepare("UPDATE run_participants SET status = 'failed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, baseStep.memberId);
        }
        this.audit(task, runId, turnId, 'turn.statusChanged', { status: interrupted ? 'CANCELLED' : 'FAILED', code: event.code });
      });
      tx();
      if (!interrupted) pumpDeliberation(this.db, task.id, this.deliberationOptions());
      return;
    }""",
"""    if (event.kind === 'turn.failed') {
      const taskNow = this.db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(task.id) as { stop_generation: number; status: string } | undefined;
      const runNow = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string } | undefined;
      // 用户停止 = stop_generation 已推进或 run 已 STOPPING；否则 INTERRUPTED 是
      // 单轮截止中断（取证轮确认的误判源）——成员级缺席，运行继续。
      const userStop = event.code === 'INTERRUPTED' && (taskNow != null && (taskNow.stop_generation > 0 || taskNow.status === 'CANCELLED') || runNow?.status === 'STOPPING');
      const tx = this.db.transaction(() => {
        this.casTurn(turnId, userStop ? 'CANCELLED' : 'FAILED');
        this.settleDelibBudget(runId);
        if (userStop) {
          this.db.prepare(`UPDATE workflow_runs SET status = 'CANCELLED' WHERE id = ?`).run(runId);
          this.transitionTask(task.id, 'CANCELLED');
        } else if (baseStep != null) {
          this.db.prepare("UPDATE run_participants SET status = ? WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')")
            .run(event.code === 'INTERRUPTED' ? 'absent' : 'failed', runId, baseStep.memberId);
        }
        this.audit(task, runId, turnId, 'turn.statusChanged', { status: userStop ? 'CANCELLED' : 'FAILED', code: event.code, message: event.message, source: userStop ? 'user-stop' : 'member-terminal' });
      });
      tx();
      if (!userStop) pumpDeliberation(this.db, task.id, this.deliberationOptions());
      return;
    }""")

# 6. export helper + import
s = s.replace("""function parseInitialTaskId(dispatchKey: string): string | null {""",
"""/** 活跃研讨 run：最新非终态（同任务多 run 时阶段/派发/预算都绑它）。 */
export function activeDeliberationRun(db: ZhongshuoDatabase, taskId: string): { id: string; status: string; stage: string | null; round_no: number | null; roster_revision: number | null; budget_json: string | null } | undefined {
  return db.prepare(
    "SELECT id, status, stage, round_no, roster_revision, budget_json FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY revision DESC LIMIT 1",
  ).get(taskId) as ReturnType<typeof activeDeliberationRun> extends infer T ? T : never;
}

function parseInitialTaskId(dispatchKey: string): string | null {""")

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('worker patched')
