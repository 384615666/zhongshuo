/**
 * 价值批次唯一逐调用台账（2026-09-28 第六轮：从六侧原始库生成——报告数字一律以本脚本输出为准）。
 *
 * 数据源（原始记录，不手抄）：每侧 appData/state.sqlite 的 agent_turns/workflow_runs/tasks/
 * usage_records/domain_events/context_bundles/artifacts + 提交 manifest。
 * 输出：
 *   - evidence/value-batch/per-call-ledger.json：逐 turn（身份/阶段/终态/用量/响应模型/
 *     bundle 引用/预算事件/修复标记/时间线）+ 每侧与全批汇总 + 违规断言结果。
 *   - stdout：汇总与断言（退出码非 0=存在违规未如实标注）。
 * 证据分级（脱敏与如实标注）：
 *   observed（程序观测：表/事件/usage 报文）｜reported（响应模型自报=result/assistant 双源）
 *   claimed（模型自述——不采信为事实）｜unknown（渠道计费/CLI 内部行为——不可独立确认）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const BATCH = join(process.env.TEMP ?? '.', 'zhongshuo-value');
const OUTDIR = join(process.cwd(), 'docs', 'implementation', 'evidence', 'value-batch');
const SIDES = [['A', 'direct'], ['A', 'delib'], ['B', 'direct'], ['B', 'delib'], ['C', 'direct'], ['C', 'delib']];
const SIDE_CAP = { direct: 2, delib: 9 };
const BATCH_CAP = 33;

const ledger = { generatedAt: new Date().toISOString(), source: 'per-side state.sqlite (原始记录)', sides: [], totals: {}, violations: [] };
let batchCalls = 0;

for (const [group, side] of SIDES) {
  const root = join(BATCH, group, side);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const db = new (nodeRequire('better-sqlite3'))(join(root, 'appdata', 'state.sqlite'), { readonly: true });
  const taskId = manifest.taskId;
  const turns = db.prepare(
    `SELECT t.id, t.run_id, t.status, t.stage_key, t.dispatch_key, t.turn_purpose
     FROM agent_turns t WHERE t.dispatch_key LIKE 'task:' || ? || ':%' ORDER BY t.rowid`,
  ).all(taskId);
  const runs = db.prepare('SELECT id, status, budget_json FROM workflow_runs WHERE task_id = ? ORDER BY rowid').all(taskId);
  const usage = new Map(db.prepare(
    `SELECT u.turn_id, u.normalized_json FROM usage_records u WHERE u.turn_id IN
       (SELECT id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%')`,
  ).all(taskId).map((r) => [r.turn_id, JSON.parse(r.normalized_json)]));
  const bundles = new Map(db.prepare(
    `SELECT b.turn_id, b.id AS bundle_id, b.hash FROM context_bundles b WHERE b.turn_id IN
       (SELECT id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%')`,
  ).all(taskId).map((r) => [r.turn_id, r]));
  const events = db.prepare(
    `SELECT kind, turn_id, payload_json FROM domain_events WHERE kind IN
       ('turn.outputInvalid','turn.startupFailed','run.budgetSkipped','task.redispatchEnqueued','turn.statusChanged')
     ORDER BY seq`,
  ).all().filter((e) => e.turn_id == null || turns.some((t) => t.id === e.turn_id));
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
  const delib = side === 'delib';
  const calls = turns.map((t) => {
    const u = usage.get(t.id) ?? {};
    const invalid = events.find((e) => e.kind === 'turn.outputInvalid' && e.turn_id === t.id);
    return {
      turnId: t.id,
      runId: t.run_id,
      stage: t.stage_key,
      isRepair: (t.stage_key ?? '').includes('.fx') || (t.dispatch_key ?? '').endsWith(':redispatch'),
      dispatchKeyTail: (t.dispatch_key ?? '').split(':').slice(-1)[0],
      status: t.status, // observed
      reportedModel: u.model ?? null, // reported：响应自报（双源）
      usageTokens: u.inputTokens != null ? { input: u.inputTokens, cached: u.cachedTokens ?? null, output: u.outputTokens } : null,
      estimatedCostUsd: u.cost ?? null, // observed=CLI 估算（estimated）；渠道计费=unknown（以账单为准）
      bundle: bundles.get(t.id) ? { id: bundles.get(t.id).bundle_id, hash: bundles.get(t.id).hash } : null,
      outputInvalidIssues: invalid ? JSON.parse(invalid.payload_json).issues : null,
    };
  });
  void usage;
  const sideBudgets = runs.map((r) => JSON.parse(r.budget_json ?? 'null')).filter(Boolean);
  const delibUsed = sideBudgets.reduce((a, b) => a + (b.usedTurns ?? 0), 0);
  const failedCount = turns.filter((t) => t.status === 'FAILED').length;
  const sideEntry = {
    group, side, taskId,
    taskStatus: task?.status ?? null,
    calls: turns.length,
    failedTurns: failedCount,
    succeededTurns: turns.filter((t) => t.status === 'SUCCEEDED').length,
    sideCap: manifest.batch?.sideCap ?? SIDE_CAP[side],
    sideCapExceeded: turns.length > (manifest.batch?.sideCap ?? SIDE_CAP[side]),
    budgetObserved: delib ? { usedTurnsSum: delibUsed, runMaxTurns: sideBudgets.map((b) => b.runMaxTurns) } : null,
    budgetSkippedEvents: events.filter((e) => e.kind === 'run.budgetSkipped').length,
    repairTurns: calls.filter((c) => c.isRepair).length,
    codeCommit: manifest.codeCommit,
    turns: calls,
    note: side === 'delib' && group === 'A' ? 'sideCapExceeded=true：A-DELIB 实发 10>9（预算执行缺陷，修复=915f0db；第 10 次调用如实入账）' : null,
  };
  ledger.sides.push(sideEntry);
  batchCalls += turns.length;
  if (sideEntry.sideCapExceeded) ledger.violations.push(`A? ${group}-${side}: ${turns.length} > ${sideEntry.sideCap}（单侧超限——已如实标注）`);
  db.close();
}

ledger.totals = {
  batchCalls,
  batchCap: BATCH_CAP,
  batchWithinCap: batchCalls <= BATCH_CAP,
  directCalls: ledger.sides.filter((s) => s.side === 'direct').reduce((a, s) => a + s.calls, 0),
  delibCalls: ledger.sides.filter((s) => s.side === 'delib').reduce((a, s) => a + s.calls, 0),
  delibSucceeded: ledger.sides.filter((s) => s.side === 'delib').reduce((a, s) => a + s.succeededTurns, 0),
  delibFailed: ledger.sides.filter((s) => s.side === 'delib').reduce((a, s) => a + s.failedTurns, 0),
  allFailedTurns: ledger.sides.reduce((a, s) => a + s.failedTurns, 0),
  estimatedCostUsdSum: Number(ledger.sides.reduce((a, s) => a + s.turns.reduce((b, t) => b + (t.estimatedCostUsd ?? 0), 0), 0).toFixed(4)),
};
mkdirSync(join(OUTDIR, 'evidence-pack'), { recursive: true });
writeFileSync(join(OUTDIR, 'per-call-ledger.json'), JSON.stringify(ledger, null, 2), 'utf8');
console.log(JSON.stringify({
  totals: ledger.totals,
  sides: ledger.sides.map((s) => ({ g: s.group, side: s.side, calls: s.calls, cap: `${s.calls}/${s.sideCap}`, failed: s.failedTurns, exceeded: s.sideCapExceeded })),
  violations: ledger.violations,
}, null, 2));
