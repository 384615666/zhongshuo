/**
 * 价值批次持久证据包（2026-09-28 第六轮）：从 TEMP 六侧原始库抽取可复查证据入库
 * （docs/implementation/evidence/value-batch/evidence-pack/），不再只留 TEMP 路径。
 *
 * 收录（脱敏规则：不含凭据/token——manifest 本就不含；输入=任务正文+常驻提示词版本，
 * 模型输出全文保留含被拒字段）：
 * - <side>/manifest.json（提交身份/版本/绑定/预算/fixture hash）
 * - <side>/turns.json（逐 turn：身份/阶段/终态/用量/响应模型/bundle hash/校验问题/预算事件）
 * - <side>/outputs.json（该侧全部 agent 消息全文——含被拒输出；delib 另存最终报告 artifact JSON）
 * - <side>/inputs.json（ContextBundle 的 envelope 摘要与正文 hash——输入可核对）
 * - <side>/budget-events.json（run.budgetSkipped/task.redispatchEnqueued/turn.outputInvalid 等）
 * - direct-repair-path.json（DIRECT 二次调用路径取证：派发键/新 resultKey/输入是否含原输出与
 *   校验错误/预算归属——按原始记录，不臆断「合同内一次修复」）
 * - evidence-classification.json（四类证据分级声明：observed/reported/claimed/unknown）
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const BATCH = join(process.env.TEMP ?? '.', 'zhongshuo-value');
const OUT = join(process.cwd(), 'docs', 'implementation', 'evidence', 'value-batch', 'evidence-pack');
const SIDES = [['A', 'direct'], ['A', 'delib'], ['B', 'direct'], ['B', 'delib'], ['C', 'direct'], ['C', 'delib']];

const repairPath = { generatedAt: new Date().toISOString(), question: 'DIRECT 第二次调用走了什么路径（正式格式修复/普通跟进/特殊重提）？', sides: [] };

for (const [group, side] of SIDES) {
  const root = join(BATCH, group, side);
  const dir = join(OUT, `${group}-${side}`);
  mkdirSync(dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  copyFileSync(join(root, 'manifest.json'), join(dir, 'manifest.json'));
  const db = new (nodeRequire('better-sqlite3'))(join(root, 'appData', 'state.sqlite'), { readonly: true });
  const taskId = manifest.taskId;

  const turns = db.prepare(
    `SELECT t.id, t.run_id, t.status, t.stage_key, t.dispatch_key, t.attempt, t.epoch
     FROM agent_turns t WHERE t.dispatch_key LIKE 'task:' || ? || ':%' ORDER BY t.rowid`,
  ).all(taskId).map((t) => {
    const u = db.prepare('SELECT normalized_json FROM usage_records WHERE turn_id = ?').get(t.id);
    const b = db.prepare('SELECT id, hash, included_refs_json FROM context_bundles WHERE turn_id = ?').get(t.id);
    const inv = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'turn.outputInvalid' AND turn_id = ? ORDER BY seq DESC LIMIT 1`).get(t.id);
    return {
      turnId: t.id, runId: t.run_id, stage: t.stage_key, dispatchKey: t.dispatch_key, status: t.status,
      usage: u ? JSON.parse(u.normalized_json) : null,
      bundle: b ? { id: b.id, hash: b.hash, envelopeChars: (JSON.parse(b.included_refs_json)?.envelope ? JSON.stringify(JSON.parse(b.included_refs_json).envelope).length : null) } : null,
      outputInvalidIssues: inv ? JSON.parse(inv.payload_json).issues : null,
    };
  });
  writeFileSync(join(dir, 'turns.json'), JSON.stringify(turns, null, 2), 'utf8');

  const outputs = db.prepare(
    `SELECT m.id, m.author_id, m.body_json, m.created_at FROM messages m WHERE m.task_id = ? AND m.author_type = 'agent' ORDER BY m.rowid`,
  ).all(taskId).map((m) => ({ messageId: m.id, memberId: m.author_id, createdAt: m.created_at, body: JSON.parse(m.body_json) }));
  const pack = { taskId, agentMessages: outputs };
  if (side === 'delib') {
    const rep = db.prepare(`SELECT id, blob_path, hash FROM artifacts WHERE task_id = ? AND kind = 'final_report' ORDER BY revision DESC LIMIT 1`).get(taskId);
    if (rep != null) {
      pack.finalReport = { artifactId: rep.id, hash: rep.hash, payload: JSON.parse(readFileSync(rep.blob_path, 'utf8')) };
    }
  }
  writeFileSync(join(dir, 'outputs.json'), JSON.stringify(pack, null, 2), 'utf8');

  const inputs = db.prepare(
    `SELECT cb.id, cb.hash, cb.included_refs_json, t.id AS turn_id, t.stage_key
     FROM context_bundles cb JOIN agent_turns t ON t.id = cb.turn_id
     WHERE t.dispatch_key LIKE 'task:' || ? || ':%' ORDER BY t.rowid`,
  ).all(taskId).map((r) => {
    const env = JSON.parse(r.included_refs_json);
    return { turnId: r.turn_id, stage: r.stage_key, bundleId: r.id, hash: r.hash, envelopePresent: env?.envelope != null, envelope: env?.envelope ?? null };
  });
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(inputs, null, 2), 'utf8');

  const events = db.prepare(
    `SELECT kind, payload_json, created_at FROM domain_events WHERE kind IN
      ('run.budgetSkipped','task.redispatchEnqueued','turn.outputInvalid','turn.startupFailed','changeset.baselineCaptured')
    ORDER BY seq`,
  ).all().map((e) => ({ kind: e.kind, payload: JSON.parse(e.payload_json), createdAt: e.created_at }));
  writeFileSync(join(dir, 'budget-events.json'), JSON.stringify(events, null, 2), 'utf8');

  // DIRECT 二次调用路径取证：redispatch turn 的输入是否包含原输出/校验错误（修复绑定证据）。
  if (side === 'direct' && turns.length > 1) {
    const initial = turns[0];
    const second = turns[1];
    const secondEnv = inputs.find((i) => i.turnId === second.turnId)?.envelope;
    const envText = secondEnv ? JSON.stringify(secondEnv) : '';
    repairPath.sides.push({
      group,
      initialTurn: { id: initial.turnId, dispatchKey: initial.dispatchKey, status: initial.status, resultKeyInOutput: null },
      secondTurn: {
        id: second.turnId,
        dispatchKey: second.dispatchKey,
        isRedispatchKey: second.dispatchKey.endsWith(':redispatch'),
        newRun: second.runId !== initial.runId,
        newBundleHash: second.bundle?.hash !== initial.bundle?.hash,
        status: second.status,
      },
      bindingEvidence: {
        priorOutputIncluded: envText.includes(initial.turnId) || (initial.outputInvalidIssues != null && envText.includes('outputInvalid')),
        validationIssuesIncluded: envText.includes('Unrecognized key') || envText.includes('不是 JSON') || envText.includes('issues'),
        priorResultKeyReferenced: envText.includes('result_' + initial.turnId),
      },
      budget: db.prepare('SELECT id, budget_json FROM workflow_runs WHERE task_id = ? ORDER BY rowid').all(taskId)
        .map((r) => ({ runId: r.id, budget: JSON.parse(r.budget_json ?? 'null') })),
    });
  }
  db.close();
}

writeFileSync(join(OUT, 'direct-repair-path.json'), JSON.stringify(repairPath, null, 2), 'utf8');
writeFileSync(join(OUT, 'evidence-classification.json'), JSON.stringify({
  observed: ['agent_turns/workflow_runs/tasks 表行', 'domain_events（含 turn.outputInvalid 的 issues、run.budgetSkipped、task.redispatchEnqueued）', 'usage_records 报文（tokens/cost=CLI 估算）', 'context_bundles hash', 'tool.started/tool.completed 审计', 'manifest（提交身份/版本/绑定/fixture hash）'],
  reported: ['usage.model（result.model→assistant.message.model 双源）=响应模型自报'],
  claimed: ['模型输出/自述正文（含「仅有 Read 能力」等工具面自述——不采信为事实，仅作 claimed 记录）'],
  unknown: ['渠道实际计费（以账单为准）', 'Claude CLI 运行时实际启用的工具清单', 'CLI 发给模型的工具定义/系统提示', 'CLI 估算费用与渠道计费的差额构成'],
}, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, out: OUT, repairPathSides: repairPath.sides.length }, null, 2));
