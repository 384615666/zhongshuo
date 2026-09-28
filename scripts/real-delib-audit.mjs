/**
 * 真实研讨事后审计（只读 DB + 磁盘；M1 收口轮第五节核对单）：
 * 1) 独立阶段隔离：每成员 IND ContextBundle 全文不含其他成员草稿的 claim 语句；
 * 2) 互评三元组：每条 review 的 (artifactId, revision, claimId) 解析到本 run 草稿；
 * 3) SYN/RAT 冻结版本：RAT 输入引用的 clm_* 与 synthesis_claims 一致；
 * 4) 共识来源：final_report 的逐结论共识 == ratification_records 重算聚合；
 * 5) ContextBundle hash == sha256(全文)；artifacts 磁盘 hash == DB hash；
 * 6) 预算账：usedTurns == 终态 turn 数；按阶段列派发/终结计数。
 * 用法：node scripts/real-delib-audit.mjs [appDataDir]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const appData = process.argv[2] ?? join(tmpdir(), 'zhongshuo-m1-real', 'appdata');
const dbPath = join(appData, 'state.sqlite');
if (!existsSync(dbPath)) { console.error('DB 不存在'); process.exit(2); }
const db = new Database(dbPath);
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const checks = [];
const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

// run/任务概览
const run = db.prepare("SELECT id, stage, status, round_no, budget_json, roster_revision FROM workflow_runs WHERE mode = 'DELIBERATE' ORDER BY revision DESC LIMIT 1").get();
const task = run ? db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(run.id ? db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get(run.id).task_id : '') : null;
const turns = db.prepare('SELECT t.stage_key, t.status, t.member_id FROM agent_turns t WHERE t.run_id = ? ORDER BY t.rowid').all(run?.id ?? '');
const budget = run?.budget_json ? JSON.parse(run.budget_json) : null;
console.log('== 概览 ==');
console.log(JSON.stringify({ run: run && { id: run.id, stage: run.stage, status: run.status, round: run.round_no, rosterRev: run.roster_revision }, task, turns: turns.length, budget }, null, 1));

// 草稿（隔离基线材料）
const drafts = db.prepare("SELECT id, author_id, revision, hash, blob_path FROM artifacts WHERE run_id = ? AND kind = 'analysis_draft'").all(run.id);
const draftPayloads = drafts.map((d) => ({ ...d, payload: JSON.parse(readFileSync(d.blob_path, 'utf8')) }));

// 1) IND 隔离
for (const d of draftPayloads) {
  const bundles = db.prepare("SELECT cb.included_refs_json, cb.hash FROM context_bundles cb JOIN agent_turns t ON t.id = cb.turn_id WHERE t.run_id = ? AND t.member_id = ? AND t.stage_key = 'delib.independent'").all(run.id, d.author_id);
  for (const cb of bundles) {
    const meta = JSON.parse(cb.included_refs_json);
    const text = meta.text ?? '';
    for (const other of draftPayloads.filter((x) => x.author_id !== d.author_id)) {
      const otherClaim = other.payload.claims?.[0]?.statement ?? '';
      const leaked = otherClaim.length > 10 && text.includes(otherClaim);
      add(`IND 隔离 ${d.author_id} 不含 ${other.author_id} 草稿`, !leaked, leaked ? `泄漏语句：${otherClaim.slice(0, 40)}` : '');
    }
    // 5) hash
    add(`IND bundle hash (${d.author_id})`, cb.hash === sha(text));
  }
}

// 2) 互评三元组
const reviews = db.prepare("SELECT id, author_id, blob_path FROM artifacts WHERE run_id = ? AND kind = 'cross_review'").all(run.id);
for (const rv of reviews) {
  const payload = JSON.parse(readFileSync(rv.blob_path, 'utf8'));
  for (const r of payload.reviews ?? []) {
    const hit = draftPayloads.some((d) => d.id === r.targetArtifactId && d.revision === r.targetRevision && d.payload.claims.some((c) => c.claimId === r.targetClaimId));
    add(`CR 三元组 ${rv.author_id}→${r.targetClaimId}@${r.targetRevision}`, hit);
  }
  // CR 输入含冻结初稿清单（服务端注入）
  const crBundles = db.prepare("SELECT cb.included_refs_json FROM context_bundles cb JOIN agent_turns t ON t.id = cb.turn_id WHERE t.run_id = ? AND t.member_id = ? AND t.stage_key = 'delib.cross_review'").all(run.id, rv.author_id);
  for (const cb of crBundles) {
    const meta = JSON.parse(cb.included_refs_json);
    const others = draftPayloads.filter((d) => d.author_id !== rv.author_id);
    const listsOthers = others.every((d) => (meta.text ?? '').includes(d.id));
    add(`CR 输入含他方冻结稿 (${rv.author_id})`, others.length === 0 || listsOthers);
  }
}

// 3) SYN/RAT 冻结版本
const synClaims = db.prepare('SELECT claim_id, statement FROM synthesis_claims WHERE run_id = ?').all(run.id);
const ratBundles = db.prepare("SELECT cb.included_refs_json FROM context_bundles cb JOIN agent_turns t ON t.id = cb.turn_id WHERE t.run_id = ? AND t.stage_key = 'delib.ratify'").all(run.id);
for (const cb of ratBundles) {
  const meta = JSON.parse(cb.included_refs_json);
  const allReferenced = synClaims.every((c) => (meta.text ?? '').includes(c.claim_id) || (meta.text ?? '').includes(c.statement.slice(0, 8)));
  add('RAT 输入绑定冻结稿结论', synClaims.length === 0 || allReferenced);
}

// 4) 共识来源（重算聚合 vs 报告）
const syn = db.prepare("SELECT id, revision FROM artifacts WHERE run_id = ? AND kind = 'synthesis' ORDER BY revision DESC LIMIT 1").get(run.id);
if (syn != null) {
  const claims = db.prepare('SELECT claim_id FROM synthesis_claims WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ?').all(run.id, syn.id, syn.revision).map((c) => c.claim_id);
  const records = db.prepare('SELECT claim_id, member_id, response_status, stance FROM ratification_records WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ?').all(run.id, syn.id, syn.revision);
  const expected = db.prepare('SELECT member_id FROM run_participants WHERE run_id = ? AND expected = 1').all(run.id).map((r) => r.member_id);
  const aggregate = claims.map((claimId) => {
    let objects = 0; let missing = 0; let unconfirmed = 0; let conditionals = 0;
    for (const memberId of expected) {
      const rec = records.find((r) => r.claim_id === claimId && r.member_id === memberId);
      if (rec == null || rec.response_status !== 'submitted') { missing += 1; continue; }
      if (rec.stance === 'object') objects += 1;
      else if (rec.stance === 'conditional') conditionals += 1;
      else if (rec.stance === 'unconfirmed') unconfirmed += 1;
    }
    const consensus = objects > 0 ? 'disputed' : (missing > 0 || unconfirmed > 0) ? 'unconfirmed' : conditionals > 0 ? 'qualified' : 'unanimous';
    return { claimId, consensus };
  });
  const report = db.prepare("SELECT blob_path FROM artifacts WHERE run_id = ? AND kind = 'final_report' LIMIT 1").get(run.id);
  if (report != null) {
    const rp = JSON.parse(readFileSync(report.blob_path, 'utf8'));
    const match = (rp.claimResults ?? []).every((c) => aggregate.some((a) => a.claimId === c.claimId && a.consensus === c.consensus));
    add('报告共识==矩阵重算', match, J2(aggregate));
    add('报告整体共识在优先级内', ['disputed', 'unconfirmed', 'qualified', 'unanimous'].includes(rp.overallConsensus));
  } else {
    add('最终报告存在', false, 'run 未到 PUBLISH？');
  }
} else {
  console.log('（无 synthesis——run 未达整合阶段，跳过 3/4）');
}

// 5) artifacts 磁盘 hash
for (const a of db.prepare('SELECT id, hash, blob_path FROM artifacts WHERE run_id = ?').all(run.id)) {
  if (existsSync(a.blob_path)) {
    add(`artifact hash ${a.id.slice(0, 14)}`, sha(readFileSync(a.blob_path, 'utf8')) === a.hash);
  } else {
    add(`artifact 正文存在 ${a.id.slice(0, 14)}`, false);
  }
}

// 6) 预算账
if (budget != null) {
  const terminal = turns.filter((t) => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(t.status)).length;
  add('预算 usedTurns == 终态 turn 数', budget.usedTurns === terminal, `used=${budget.usedTurns} terminal=${terminal} turns=${turns.length}`);
  const byStage = {};
  for (const t of turns) byStage[t.stage_key] = (byStage[t.stage_key] ?? 0) + 1;
  console.log('== 按阶段派发计数 ==', JSON.stringify(byStage));
}

function J2(v) { return JSON.stringify(v); }
const failed = checks.filter((c) => !c.ok);
console.log('== 审计结论 ==');
console.log(JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed: failed.length }, null, 1));
for (const f of failed) console.log('FAIL:', f.name, f.detail?.slice(0, 160));
db.close();
process.exit(failed.length > 0 ? 1 : 0);
