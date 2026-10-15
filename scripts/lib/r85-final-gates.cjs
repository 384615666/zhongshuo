/* global module */
/** Fail closed on absent, partial, cross-BUILD or unreviewed release evidence. */
function evaluateR85Final(input){
 const {build,distribution,source,full,daily,real,upgrade,native,visual,visualReview,ledger}=input;
 const same=b=>b?.buildId===build?.buildId&&b?.commit===build?.commit;
 const steps=new Set((daily?.steps??[]).map(s=>s.name));
 const required=['archive-page-1','archive-page-2','archive-read-failure','archive-aba','board-default','board-filter-back','board-invalid-filter-back','archive-project-still-readonly','activity-cross-project','first-commit','partial-0','partial-1','diff-read-failure','diff-auto-refresh','branch-failed-input','branch-created','conflict-stale','conflict-resolved','history-expanded','undo'];
 const checks={
  'clean source and pristine verified distribution':build?.dirty===false&&distribution?.pass===true&&distribution?.files===593&&distribution?.pristine===true&&distribution?.runtimeUnchanged===true&&distribution?.migrationsUnchanged===true,
  'deterministic source, both type projects and incremental lint':source?.pass===true&&source?.tests>0&&source?.files>0&&source?.mainTypes===true&&source?.hifiTypes===true&&source?.lint===true,
  'same BUILD full launcher workflows and reopen':full?.pass===true&&full?.buildId===build?.buildId&&full?.finalRealCalls===0&&full?.deliveries?.room?.length===2&&full?.deliveries?.dm?.length===2&&full?.r79?.threeCycles===true&&full?.r79?.historyRead===true&&full?.r79?.reopen===true,
  'complete daily scope, every required outcome and real Git identities':daily?.pass===true&&daily?.scope==='complete'&&daily?.buildId===build?.buildId&&required.every(s=>steps.has(s))&&daily?.realCalls===0&&!!daily?.firstCommit?.head&&!!daily?.undo?.approved&&daily?.undo?.head!==daily?.undo?.approved,
  'same final BUILD real v1, explicit rework v2, accept and reopen':real?.pass===true&&same(real?.build)&&real?.calls?.length===2&&real.calls.every(c=>c.status==='succeeded')&&real?.v1?.revision===1&&real?.v2?.revision===2&&real?.v1?.manifestHash!==real?.v2?.manifestHash&&real?.native?.length>=2&&real.native.every(s=>s.successfulTestResults?.length>0),
  'old whole-root backup, original envelope and matching full rollback':upgrade?.pass===true&&same(upgrade?.build)&&upgrade?.draftsAndUploadsComparedToOld===true&&upgrade?.memberConfigCredentialAndRootMatch===true&&upgrade?.after?.calls===0,
  'native mouse and keyboard, correct project and durable normal close':native?.pass===true&&same(native?.build)&&native?.calls===2&&native?.close?.pass===true&&native?.close?.stop?.phase==='closed',
  'six paired visible layouts and inspected original screenshots':visual?.pass===true&&same(visual?.build)&&visual?.pairs?.length===6&&visual?.pairs.every(p=>p.actual.width===p.reference.width&&p.actual.height===p.reference.height&&p.actual.dpr===p.reference.dpr&&(p.page!=='archive'||p.actual.archiveSelectWidth<=182))&&visualReview?.accepted===true&&visualReview?.pairs===6&&visualReview?.images===12&&visualReview?.hashesVerified===true,
  'all four actual calls counted once, including earlier candidate':ledger?.pass===true&&ledger?.total===4&&ledger?.calls?.length===4&&new Set(ledger.calls.map(c=>c.rootId+':'+c.turn_id)).size===4&&ledger.calls.every(c=>c.status==='succeeded')&&ledger.calls.filter(c=>same(c.build)&&real?.calls?.some(r=>r.turn_id===c.turn_id)).length===2,
 };
 return{pass:Object.values(checks).every(v=>v===true),checks,failed:Object.entries(checks).filter(([,v])=>v!==true).map(([name])=>name),userAcceptance:'pending'};
}
module.exports={evaluateR85Final};
