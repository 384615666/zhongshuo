/**
 * 真实调用护栏（第十七轮四建立；第十八轮二/三重写）。
 *
 * 计数边界=**实际请求边界**：RuntimeAdapter.startTurn（修复/重派/研讨分阶段/并发进程全部
 * 经此入口）。对真实 runtime（claude/codex）的 startTurn：
 * - **生命周期完整透传**：包装层用 Proxy 转发底层全部能力（dispose/disposeAll/closeAllSessions
 *   等可选方法接收者绑定=底层 adapter）——注册表停机路径按结构探测这些方法，漏转发=真实
 *   adapter 被误判 no-dispose-needed、停机收拢退化为受管 job 兜底（第十八轮二修复的回归）；
 * - 请求前**先持久占位**（real_calls 行 status='inflight'）+ 批次共享日志原子预占
 *   （第十八轮三：记账与上限分离——cap 仅在实验批次配置时拦截，第 N+1 次在底层调用前拒绝；
 *   生产无 batchId 只记账不设限）；
 * - startTurn 抛错≠请求未发出：结算为 'unknown'（执行不确定性），调用结果另行记录；
 * - 归属来自实际解析：runtime kind、构建时模型（binding/env——codex 不记 ZS_CLAUDE_MODEL）、
 *   member/task/run 从 agent_turns 按 turnId 正式解析（TurnRequest 无这些字段）；
 * - 响应自报模型（usage.updated.model）与请求模型分列；用量引用真实事件原文，不猜测。
 * 本地验收防护（ZS_REAL_DISPATCH_GUARD）优先：真实 runtime 在 adapterFor 即被拒——护栏行
 * 与批次预占均不出现（零真实调用环境保持零行零条目）。
 */
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { NormalizedRuntimeEvent, RuntimeAdapter, SessionRef, TurnRequest } from '../contracts/runtime.ts';
import { configuredBatchCap, reserveSlot, settleSlot, batchJournalStats, batchJournalExists } from './realBatchJournal.ts';

export interface RealCallRow {
  id: number;
  batch_id: string;
  runtime_kind: string;
  model: string | null;
  member_id: string | null;
  task_id: string | null;
  turn_id: string | null;
  run_id: string | null;
  status: 'inflight' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
  detail: string | null;
  created_at: number;
  settled_at: number | null;
  response_model: string | null;
  usage_json: string | null;
}

const REAL_KINDS = new Set(['claude', 'codex']);

export interface RealCallQuotaError extends Error {
  code: 'REAL_BATCH_CAP';
}

/** 归属解析：从 agent_turns 按 turnId 取正式 member/run，task 经 workflow_runs 关联（TurnRequest 不携带）。 */
function attributionFor(db: ZhongshuoDatabase, turnId: string): { memberId: string | null; taskId: string | null; runId: string | null } {
  try {
    const row = db.prepare(
      'SELECT t.member_id AS memberId, r.task_id AS taskId, t.run_id AS runId FROM agent_turns t LEFT JOIN workflow_runs r ON r.id = t.run_id WHERE t.id = ?',
    ).get(turnId) as { memberId: string; taskId: string | null; runId: string } | undefined;
    if (row != null) return { memberId: row.memberId, taskId: row.taskId, runId: row.runId };
  } catch { /* 表不存在等极端：保持 null，不阻塞请求边界 */ }
  return { memberId: null, taskId: null, runId: null };
}

/**
 * @param model 请求模型（构建时已知：binding.model ?? 环境默认——按 kind 区分，不把
 *              ZS_CLAUDE_MODEL 记到 codex 上）。可空=构建时不可知。
 */
export function wrapRealCallLedger(adapter: RuntimeAdapter, kind: string, db: ZhongshuoDatabase, model?: string | null): RuntimeAdapter {
  if (!REAL_KINDS.has(kind)) return adapter; // fake 不计（本地/回放零真实调用——不产生噪音行）
  const batchId = process.env.ZS_REAL_BATCH_ID ?? 'ad-hoc';
  const cap = configuredBatchCap();
  const started = new Map<string, number>(); // turnId → real_calls.id（请求前占位）
  const interceptStartTurn = async (session: SessionRef, input: TurnRequest): Promise<void> => {
    // ① 批次上限（实验批次配置时）：检查+预占原子完成；超限在底层调用前拒绝（零真实请求，
    //    不产生台账行——被拒不是一次调用）。
    if (process.env.ZS_REAL_BATCH_ID != null) {
      const r = await reserveSlot(batchId, cap, input.turnId);
      if (!r.ok) {
        const error = new Error(`[真实调用护栏] 批次 ${batchId} 已达上限 ${r.cap}（已预占 ${r.reserved}）：第 ${r.reserved + 1} 次调用在请求前被拒——本次零真实请求；如需扩容请调整 ZS_REAL_BATCH_CAP 后重新立批`) as RealCallQuotaError;
        error.code = 'REAL_BATCH_CAP';
        throw error;
      }
    }
    // ② 请求前持久占位（是否发出不确定亦保留）。
    const attr = attributionFor(db, input.turnId);
    const info = db.prepare('INSERT INTO real_calls (batch_id, runtime_kind, model, member_id, task_id, turn_id, run_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'inflight\', ?, ?)')
      .run(batchId, kind, model ?? null, attr.memberId, attr.taskId, input.turnId, attr.runId, '请求前占位（是否发出不确定亦保留）', Date.now());
    started.set(input.turnId, Number(info.lastInsertRowid));
    try {
      await adapter.startTurn(session, input);
    } catch (error) {
      // 抛错≠请求未发出（可能在途失败）：结算 unknown=执行不确定；调用结果由事件/终态另行记录。
      db.prepare("UPDATE real_calls SET status = 'unknown', detail = ?, settled_at = ? WHERE id = ?").run(`startTurn 抛错（不确定是否已发出）：${String(error).slice(0, 140)}`, Date.now(), Number(info.lastInsertRowid));
      started.delete(input.turnId);
      if (process.env.ZS_REAL_BATCH_ID != null) await settleSlot(batchId, input.turnId, `startTurn-thrown:${String(error).slice(0, 60)}`).catch(() => {});
      throw error;
    }
    db.prepare("UPDATE real_calls SET detail = 'startTurn 已发出（终态与用量见事件通道/usage_records）' WHERE id = ?").run(Number(info.lastInsertRowid));
  };
  // Proxy 生命周期透传：除 startTurn 外全部转发底层（方法绑定接收者=底层 adapter；constructor
  // 原样返回保持 constructor.name 标签）。可选能力（dispose/disposeAll/closeAllSessions/
  // processIdentity/lateEvents 及未来新增）自动透传，不再逐个列举。
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'startTurn') return interceptStartTurn;
      if (prop === 'constructor') return Reflect.get(target, prop);
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as RuntimeAdapter;
}

export function settleRealCall(db: ZhongshuoDatabase, turnId: string, status: RealCallRow['status'], detail: string): void {
  db.prepare('UPDATE real_calls SET status = ?, detail = ?, settled_at = ? WHERE turn_id = ? AND status = \'inflight\'').run(status, detail.slice(0, 200), Date.now(), turnId);
  if (process.env.ZS_REAL_BATCH_ID != null) void settleSlot(process.env.ZS_REAL_BATCH_ID, turnId, `terminal:${status}`).catch(() => {});
}

/** 响应自报模型与用量（usage.updated 事件原样引用——不猜测、不以请求模型冒充）。 */
export function recordRealCallUsage(db: ZhongshuoDatabase, turnId: string, event: NormalizedRuntimeEvent & { kind: 'usage.updated' }): void {
  try {
    db.prepare('UPDATE real_calls SET response_model = COALESCE(?, response_model), usage_json = ? WHERE turn_id = ?').run(event.model ?? null, JSON.stringify(event).slice(0, 2000), turnId);
  } catch { /* 台账尽力而为 */ }
}

export function realCallSummary(db: ZhongshuoDatabase, batchId?: string): {
  batchId: string;
  total: number;
  inflight: number;
  byStatus: Record<string, number>;
  quota: { cap: number | null; journal: { reserved: number; settled: number; rejected: number } | null; note: string };
  rows: RealCallRow[];
} {
  const rows = (batchId != null
    ? db.prepare('SELECT * FROM real_calls WHERE batch_id = ? ORDER BY id').all(batchId)
    : db.prepare('SELECT * FROM real_calls ORDER BY id').all()) as RealCallRow[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const cap = configuredBatchCap();
  const journal = batchId != null && batchJournalExists(batchId) ? batchJournalStats(batchId) : null;
  return {
    batchId: batchId ?? '(all)',
    total: rows.length,
    inflight: byStatus.inflight ?? 0,
    byStatus,
    quota: {
      cap,
      journal,
      note: cap == null ? '未配置批次上限（ZS_REAL_BATCH_CAP）——只记账不拦截' : `实验批次上限 ${cap}（共享日志预占；第 ${cap + 1} 次起请求前拒绝）`,
    },
    rows,
  };
}
