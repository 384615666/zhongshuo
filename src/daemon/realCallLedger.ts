/**
 * 真实调用护栏（第十七轮四：共用基础设施——R15 message.submit 计数收口）。
 *
 * 计数边界=**实际请求边界**：RuntimeAdapter.startTurn（修复/重派/研讨分阶段/并发进程全部
 * 经此入口）。对真实 runtime（claude/codex）的 startTurn：
 * - 请求前**先持久占位**（real_calls 行 status='inflight'）——失败/是否发出不确定也保留记录；
 * - 结束后补记 outcome（succeeded/failed/interrupted/unknown）；
 * - batchId（env ZS_REAL_BATCH_ID，缺省='ad-hoc'）、runtimeKind、模型、turn/task 归属、
 *   用量（事件通道回填 cost/tokens）分列；查询命令 realCalls.summary 供批次核对。
 * 本地验收防护（ZS_REAL_DISPATCH_GUARD）优先：真实 runtime 在 startTurn 之前已被拒——
 * 护栏行不会出现（零真实调用环境保持零行）。
 */
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { NormalizedRuntimeEvent, RuntimeAdapter, SessionRef, TurnRequest, ProbeResult, OpenSessionInput, AdapterProcessIdentity } from '../contracts/runtime.ts';

export interface RealCallRow {
  id: number;
  batch_id: string;
  runtime_kind: string;
  model: string | null;
  member_id: string | null;
  task_id: string | null;
  turn_id: string | null;
  status: 'inflight' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
  detail: string | null;
  created_at: number;
  settled_at: number | null;
}

const REAL_KINDS = new Set(['claude', 'codex']);

export function wrapRealCallLedger(adapter: RuntimeAdapter, kind: string, db: ZhongshuoDatabase): RuntimeAdapter {
  if (!REAL_KINDS.has(kind)) return adapter; // fake 不计（本地/回放零真实调用——不产生噪音行）
  const batchId = process.env.ZS_REAL_BATCH_ID ?? 'ad-hoc';
  const started = new Map<string, number>(); // turnId → real_calls.id（请求前占位）
  return {
    probe: (): Promise<ProbeResult> => adapter.probe(),
    openSession: (input: OpenSessionInput): Promise<SessionRef> => adapter.openSession(input),
    async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
      const info = db.prepare('INSERT INTO real_calls (batch_id, runtime_kind, model, member_id, task_id, turn_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, \'inflight\', ?, ?)')
        .run(batchId, kind, process.env.ZS_CLAUDE_MODEL ?? null, (input as { memberId?: string }).memberId ?? null, (input as { taskId?: string }).taskId ?? null, input.turnId, '请求前占位（是否发出不确定亦保留）', Date.now());
      started.set(input.turnId, Number(info.lastInsertRowid));
      try {
        await adapter.startTurn(session, input);
      } catch (error) {
        db.prepare("UPDATE real_calls SET status = 'failed', detail = ?, settled_at = ? WHERE id = ?").run(String(error).slice(0, 200), Date.now(), Number(info.lastInsertRowid));
        started.delete(input.turnId);
        throw error;
      }
      db.prepare("UPDATE real_calls SET detail = 'startTurn 已发出（终态与用量见事件通道/usage_records）' WHERE id = ?").run(Number(info.lastInsertRowid));
    },
    events: (session: SessionRef): AsyncIterable<NormalizedRuntimeEvent> => adapter.events(session),
    steer: (session: SessionRef, input: TurnRequest): Promise<void> => adapter.steer(session, input),
    interrupt: (session: SessionRef, turnId: string): Promise<void> => adapter.interrupt(session, turnId),
    respondApproval: (session: SessionRef, approvalId: string, choice: 'allow_once' | 'deny'): Promise<void> => adapter.respondApproval(session, approvalId, choice),
    close: (session: SessionRef): Promise<void> => adapter.close(session),
    ...(adapter.processIdentity != null ? { processIdentity: (s: SessionRef, t: string): AdapterProcessIdentity | null => adapter.processIdentity!(s, t) } : {}),
    ...(adapter.lateEvents != null ? { lateEvents: (s: SessionRef, t: string) => adapter.lateEvents!(s, t) } : {}),
  };
}

export function settleRealCall(db: ZhongshuoDatabase, turnId: string, status: RealCallRow['status'], detail: string): void {
  db.prepare('UPDATE real_calls SET status = ?, detail = ?, settled_at = ? WHERE turn_id = ? AND status = \'inflight\'').run(status, detail.slice(0, 200), Date.now(), turnId);
}

export function realCallSummary(db: ZhongshuoDatabase, batchId?: string): { batchId: string; total: number; inflight: number; byStatus: Record<string, number>; rows: RealCallRow[] } {
  const rows = (batchId != null
    ? db.prepare('SELECT * FROM real_calls WHERE batch_id = ? ORDER BY id').all(batchId)
    : db.prepare('SELECT * FROM real_calls ORDER BY id').all()) as RealCallRow[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { batchId: batchId ?? '(all)', total: rows.length, inflight: byStatus.inflight ?? 0, byStatus, rows };
}
