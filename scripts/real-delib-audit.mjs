/**
 * 真实研讨事后审计 v2（只读 DB+磁盘；显式定位 + 存在性断言 + 内容核对）。
 * 用法：node scripts/real-delib-audit.mjs <appDataDir> <taskId> <runId> [gitRev]
 * - 目标必须显式指定（不按 revision 最大/第一条自动选择）；
 * - 每类核对先断言实体存在且数量正确，再做内容比对（防空循环假通过）；
 * - 核对：IND 输入源白名单（bundle 全文不含其他草稿 artifactId/正文段）、CR 输入
 *   精确绑定冻结清单（id@rev#hash）、RAT 绑定精确 synthesis 三元组（非 clm 名/文本）、
 *   报告逐结论==该版本确认矩阵重算、预算==派发/结算事件账、artifact/bundle 记录==文件。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const [appData, taskIdArg, runIdArg, gitRevArg] = process.argv.slice(2);
if (!existsSync(appData) || !taskIdArg || !runIdArg) {
  console.error('用法：node scripts/real-delib-audit.mjs <appDataDir> <taskId> <runId> [gitRev]');
  process.exit(64);
}
const Database = (await import('better-sqlite3')).default;
const db = new Database(appData); // 直接传 DB 文件路径（或目录/state.sqlite）
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const checks = [];
const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

console.log('== 审计目标（显式指定） ==');
const dbFile = existsSync(`${appData}/state.sqlite`) ? `${appData}/state.sqlite` : appData;
console.log(JSON.stringify({ dbFile, taskId: taskIdArg, runId: runIdArg, gitRev: gitRevArg ?? '(未指定)', auditScript: 'scripts/real-delib-audit.mjs@v2' }));

// ---- 存在性断言（先于一切内容核对） ----
const run = db.prepare('SELECT id, task_id, stage, status, round_no, budget_json, roster_revision FROM workflow_runs WHERE id = ?').get(runIdArg);
add('run 存在且归属指定任务', run != null && run.task_id === taskIdArg, run == null ? 'run 不存在' : run.task_id !== taskIdArg ? `task_id=${run.task_id}` : '');
const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskIdArg);
add('task 存在', task != null);
if (run == null || task == null) { console.log(JSON.stringify(checks)); process.exit(1); }
const turns = db.prepare('SELECT stage_key, status, member_id, dispatch_key FROM agent_turns WHERE run_id = ? ORDER BY rowid').all(runIdArg);
add('turn 数>0（派发事实存在）', turns.length > 0, `turns=${turns.length}`);
const drafts = db.prepare("SELECT id, author_id, revision, hash, blob_path FROM artifacts WHERE run_id = ? AND kind = 'analysis_draft'").all(runIdArg);
add('初稿数==2（两成员独立产出）', drafts.length === 2, `got=${drafts.length}`);
const reviews = db.prepare("SELECT id, author_id, blob_path FROM artifacts WHERE run_id = ? AND kind = 'cross_review'").all(runIdArg);
add('互评数==2', reviews.length === 2, `got=${reviews.length}`);
const synthesis = db.prepare("SELECT id, revision, hash, blob_path FROM artifacts WHERE run_id = ? AND kind = 'synthesis'").all(runIdArg);
add('整合稿数==1', synthesis.length === 1, `got=${synthesis.length}`);
const reports = db.prepare("SELECT id, blob_path FROM artifacts WHERE run_id = ? AND kind = 'final_report'").all(runIdArg);
add('最终报告数==1', reports.length === 1, `got=${reports.length}`);
const bundles = db.prepare('SELECT cb.id, cb.turn_id, cb.hash, cb.included_refs_json, t.stage_key, t.member_id FROM context_bundles cb JOIN agent_turns t ON t.id = cb.turn_id WHERE t.run_id = ?').all(runIdArg);
add('ContextBundle 数==turn 数', bundles.length === turns.length, `bundles=${bundles.length} turns=${turns.length}`);

const draftPayloads = drafts.map((d) => ({ ...d, payload: JSON.parse(readFileSync(d.blob_path, 'utf8')) }));
const draftIds = new Set(drafts.map((d) => d.id));

// ---- 1) IND 输入源白名单：全文不含其他草稿的 artifactId 与 claim 正文段 ----
for (const b of bundles.filter((x) => x.stage_key === 'delib.independent')) {
  const meta = JSON.parse(b.included_refs_json);
  const text = meta.text ?? '';
  const others = draftPayloads.filter((d) => d.author_id !== b.member_id);
  for (const o of others) {
    add(`IND(${b.member_id}) 全文不含他人 artifactId(${o.id.slice(0, 10)}…)`, !text.includes(o.id));
    const claimText = (o.payload.claims ?? []).map((c) => c.statement).find((t2) => t2 && t2.length >= 8);
    if (claimText) add(`IND(${b.member_id}) 不含他人 claim 正文段`, !text.includes(claimText), claimText.slice(0, 30));
    const summ = o.payload.summary ?? '';
    if (summ.length >= 6) add(`IND(${b.member_id}) 不含他人 summary`, !text.includes(summ));
  }
  add(`IND(${b.member_id}) bundle hash==sha256(全文)`, b.hash === sha(text));
}

// ---- 2) CR 输入精确绑定冻结清单 ----
const kv = (k) => db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(k)?.value;
const crManifestRaw = kv(`delib:${runIdArg}:inputs:CROSS_REVIEW:0`);
add('CR 冻结清单存在（daemon_state manifest）', crManifestRaw != null);
if (crManifestRaw != null) {
  const manifest = JSON.parse(crManifestRaw);
  add('CR 清单条目==2 且==实际初稿集合', manifest.entries.length === 2 && manifest.entries.every((e) => draftIds.has(e.artifactId)), JSON.stringify(manifest.entries.map((e) => e.artifactId.slice(0, 10))));
  for (const e of manifest.entries) {
    const row = drafts.find((d) => d.id === e.artifactId);
    add(`CR 清单条目一致 ${e.artifactId.slice(0, 10)}@${e.revision}`, row != null && row.revision === e.revision && row.hash === e.hash);
  }
  for (const b of bundles.filter((x) => x.stage_key === 'delib.cross_review')) {
    const meta = JSON.parse(b.included_refs_json);
    const text = meta.text ?? '';
    const self = draftPayloads.find((d) => d.author_id === b.member_id);
    if (self) add(`CR(${b.member_id}) 不含自评对象（自己草稿）`, !text.includes(self.id));
    for (const d of draftPayloads.filter((x) => x.author_id !== b.member_id)) {
      add(`CR(${b.member_id}) 引用清单内 ${d.id.slice(0, 10)}…`, text.includes(d.id));
    }
    add(`CR(${b.member_id}) bundle hash`, b.hash === sha(text));
  }
}
for (const rv of reviews) {
  const payload = JSON.parse(readFileSync(rv.blob_path, 'utf8'));
  add(`CR(${rv.author_id}) reviews 非空`, (payload.reviews ?? []).length > 0);
  for (const r of payload.reviews ?? []) {
    const hit = draftPayloads.some((d) => d.id === r.targetArtifactId && d.revision === r.targetRevision && d.payload.claims.some((c) => c.claimId === r.targetClaimId));
    add(`CR 三元组 ${rv.author_id}→${r.targetClaimId}@${r.targetRevision}`, hit);
  }
}

// ---- 3) RAT 绑定精确 synthesis 三元组（不凭 clm 名/文本片段） ----
const syn = synthesis[0];
const ratManifestRaw = kv(`delib:${runIdArg}:inputs:RATIFY:0`);
add('RAT 冻结清单存在', ratManifestRaw != null);
if (ratManifestRaw != null) {
  const m = JSON.parse(ratManifestRaw);
  const e = m.entries[0];
  add('RAT 清单==唯一整合稿三元组', e != null && e.artifactId === syn.id && e.revision === syn.revision && e.hash === syn.hash, JSON.stringify({ want: `${syn.id.slice(0, 10)}@${syn.revision}`, got: e && `${e.artifactId.slice(0, 10)}@${e.revision}` }));
  for (const b of bundles.filter((x) => x.stage_key === 'delib.ratify')) {
    const meta = JSON.parse(b.included_refs_json);
    const text = meta.text ?? '';
    add(`RAT(${b.member_id}) 全文含整合稿 artifactId`, text.includes(syn.id));
    add(`RAT(${b.member_id}) 全文含整合稿 hash 前缀`, text.includes(syn.hash.slice(0, 12)));
    add(`RAT(${b.member_id}) bundle hash`, b.hash === sha(text));
  }
}

// ---- 4) 报告逐结论==该版本矩阵重算 ----
const claims = db.prepare('SELECT claim_id FROM synthesis_claims WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ?').all(runIdArg, syn.id, syn.revision).map((c) => c.claim_id);
add('synthesis_claims 非空', claims.length > 0, `claims=${claims.length}`);
const records = db.prepare('SELECT claim_id, member_id, response_status, stance FROM ratification_records WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ?').all(runIdArg, syn.id, syn.revision);
add('确认矩阵非空且==claims×members', records.length === claims.length * 2, `records=${records.length} claims=${claims.length}`);
const expected = db.prepare('SELECT member_id FROM run_participants WHERE run_id = ? AND expected = 1').all(runIdArg).map((r) => r.member_id);
const aggregate = claims.map((claimId) => {
  let objects = 0, missing = 0, unconfirmed = 0, conditionals = 0;
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
const rp = JSON.parse(readFileSync(reports[0].blob_path, 'utf8'));
add('报告引用的整合稿==审计目标版本', rp.synthesisRef != null && rp.synthesisRef.artifactId === syn.id && rp.synthesisRef.revision === syn.revision);
for (const a of aggregate) {
  const got = (rp.claimResults ?? []).find((c) => c.claimId === a.claimId);
  add(`报告结论 ${a.claimId}==矩阵重算(${a.consensus})`, got != null && got.consensus === a.consensus);
}

// ---- 5) 预算==派发/结算事件账 ----
const budget = JSON.parse(run.budget_json);
const terminalTurns = turns.filter((t) => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(t.status)).length;
add('预算 usedTurns==终态 turn 数', budget.usedTurns === terminalTurns, `used=${budget.usedTurns} terminal=${terminalTurns}`);
const stepArtifacts = db.prepare("SELECT count(*) c FROM domain_events WHERE run_id = ? AND kind = 'run.stepArtifact'").get(runIdArg).c;
add('stepArtifact 事件==计入屏障数', stepArtifacts === terminalTurns, `events=${stepArtifacts}`);
const usageTurns = db.prepare('SELECT count(DISTINCT turn_id) c FROM usage_records WHERE turn_id IN (SELECT id FROM agent_turns WHERE run_id = ?)').get(runIdArg).c;
add('usage 记录 turn 数==终态 turn 数（渠道侧调用）', usageTurns === terminalTurns, `usage=${usageTurns}`);
const lateEvents = db.prepare("SELECT count(*) c FROM domain_events WHERE run_id = ? AND kind = 'run.lateArrivalRecorded'").get(runIdArg).c;
add('迟到事件==0（本组无迟到场景）', lateEvents === 0, `late=${lateEvents}`);

// ---- 6) artifact/bundle 记录==文件 ----
for (const a of db.prepare('SELECT id, hash, blob_path FROM artifacts WHERE run_id = ?').all(runIdArg)) {
  add(`artifact 文件存在 ${a.id.slice(0, 12)}…`, existsSync(a.blob_path));
  if (existsSync(a.blob_path)) add(`artifact hash==磁盘 ${a.id.slice(0, 12)}…`, sha(readFileSync(a.blob_path, 'utf8')) === a.hash);
}

const failed = checks.filter((c) => !c.ok);
console.log('== 审计结论 ==');
console.log(JSON.stringify({ target: { runId: runIdArg, taskId: taskIdArg, gitRev: gitRevArg ?? 'unspecified' }, total: checks.length, passed: checks.length - failed.length, failed: failed.length }));
for (const f of failed) console.log('FAIL:', f.name, f.detail?.slice(0, 160));
db.close();
process.exit(failed.length > 0 ? 1 : 0);
