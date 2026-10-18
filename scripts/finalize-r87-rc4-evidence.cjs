/* R87 rc4 final candidate aggregator. Fails closed on BUILD, model, scope,
 * natural-input, coordination-completion, file, or historical-failure mismatch. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const Database=require('better-sqlite3');

const repo=path.resolve(__dirname,'..');
const options=Object.fromEntries(process.argv.slice(2).filter(item=>item.startsWith('--')).map(item=>{
  const at=item.indexOf('=');return[item.slice(2,at),path.resolve(item.slice(at+1))];
}));
const pkg=options.package??path.join(repo,'dist','desktop','desktop-daily-win-v26-r87-rc4-20261018');
const naturalFile=options.natural??path.join(repo,'dist','review-r87-final','rc4-natural-noprotocol-2','result.json');
const destination=options.out??path.join(repo,'docs','implementation','r87-rc4-final-evidence-20261018.json');
const expectedCommit='16700ed86a65de28e6ca506c79f4dbf4804f1175';
const expectedBaseCommit='d9bc8c8e14f9d68fe34769e1402ee3dfe06d04db';
const protocolTerms=/(TaskComplete|schema|JSON|Markdown|代码围栏|answer字段)/i;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashText=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const must=(value,label)=>{if(!value)throw Error(label);};
const groups=(rows,key)=>Object.fromEntries([...new Set(rows.map(row=>row[key]))].sort().map(value=>[value,rows.filter(row=>row[key]===value).length]));

const build=read(path.join(pkg,'ZhongshuoDual','BUILD.json'));
const manifestFile=path.join(pkg,'ZhongshuoDual','MANIFEST-SHA256.json');
const manifest=read(manifestFile);
const manifestErrors=[];
for(const item of manifest.files??[]){
  const file=path.resolve(pkg,'ZhongshuoDual',item.path);
  if(!file.startsWith(path.resolve(pkg,'ZhongshuoDual')+path.sep)||!fs.existsSync(file)
    ||fs.statSync(file).size!==item.bytes||sha(file)!==item.sha256)manifestErrors.push(item.path);
}
const release={
  sourceCommit:build.commit,
  buildId:build.buildId,
  package:pkg,
  manifestFiles:manifest.files?.length??0,
  manifestSha256:sha(manifestFile),
  dirty:build.dirty,
  pristine:!fs.existsSync(path.join(pkg,'server-data')),
};

const natural=read(naturalFile);
must(natural.ok===true,'natural result ok');
must(natural.build?.buildId===build.buildId&&natural.build?.commit===build.commit&&natural.build?.dirty===false,'natural/build identity');
const runtimePackage=path.resolve(natural.package);
const project=path.resolve(natural.project);
const databaseFile=path.join(runtimePackage,'server-data','state.sqlite');
const db=new Database(databaseFile,{readonly:true,fileMustExist:true});
let calls,turns,tasks,deliveries,coordinationRuns,steps,coordinationMessages,humanMessages,agentMessages,memberRows,ignoredEvents,outbox;
try{
  calls=db.prepare('SELECT id,runtime_kind,model,member_id,status,response_model,task_id,turn_id,run_id,detail,created_at,settled_at FROM real_calls ORDER BY rowid').all();
  turns=db.prepare('SELECT id,run_id,status,member_id,collab_turn_deadline_ms,protection_state FROM agent_turns ORDER BY rowid').all();
  tasks=db.prepare('SELECT id,parent_task_id,owner_member_id,status,revision,current_delivery_id,title FROM tasks ORDER BY rowid').all();
  deliveries=db.prepare('SELECT id,task_id,run_id,revision,manifest_hash,artifact_refs_json,change_set_refs_json,review_status,reviewed_at FROM task_deliveries ORDER BY rowid').all();
  coordinationRuns=db.prepare('SELECT run_id,task_id,state,plan_json,integration_run_id,error_message FROM coordination_runs ORDER BY rowid').all();
  steps=db.prepare('SELECT run_id,step_key,child_task_id,role,handoff_json FROM coordination_steps ORDER BY rowid').all();
  coordinationMessages=db.prepare('SELECT id,coordination_run_id,source_turn_id,target_turn_id,target_delivery_id,status FROM coordination_messages ORDER BY rowid').all();
  humanMessages=db.prepare("SELECT id,body_json,created_at FROM messages WHERE author_type='human' ORDER BY conversation_seq").all();
  agentMessages=db.prepare("SELECT id,task_id,author_id,status,body_json,created_at FROM messages WHERE author_type='agent' ORDER BY conversation_seq").all();
  memberRows=db.prepare(`SELECT pm.id,pm.display_name AS displayName,pm.description,ri.kind,ap.settings_json AS settingsJson
    FROM project_members pm JOIN agent_profiles ap ON ap.id=pm.profile_id JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id
    WHERE pm.project_id=? ORDER BY pm.rowid`).all(natural.ids.projectId);
  ignoredEvents=db.prepare("SELECT event_id,kind,task_id,turn_id,run_id,payload_json FROM domain_events WHERE kind='member.messageIgnoredRedundantPlan' ORDER BY seq").all();
  outbox=db.prepare('SELECT id,status,turn_id,dispatch_key FROM outbox ORDER BY rowid').all();
}finally{db.close();}

const rootTask=tasks.find(task=>task.id===natural.ids.taskId)??null;
const rootDelivery=rootTask?.current_delivery_id==null?null:deliveries.find(delivery=>delivery.id===rootTask.current_delivery_id)??null;
const coordinationRun=coordinationRuns.find(run=>run.task_id===rootTask?.id)??null;
const integrationCall=calls.find(call=>call.run_id===coordinationRun?.integration_run_id)??null;
const deepseek=memberRows.find(member=>member.id===natural.ids.deepseekId)??null;
const codex=memberRows.find(member=>member.id===natural.ids.codexId)??null;
if(deepseek)deepseek.settings=JSON.parse(deepseek.settingsJson);
if(codex)codex.settings=JSON.parse(codex.settingsJson);
const codexCall=calls.find(call=>call.id===natural.codex?.call?.id)??null;
const codexTask=tasks.find(task=>task.id===codexCall?.task_id)??null;
const codexDelivery=codexTask?.current_delivery_id==null?null:deliveries.find(delivery=>delivery.id===codexTask.current_delivery_id)??null;
const codexStep=steps.find(step=>step.child_task_id===codexTask?.id)??null;
const summaryStep=steps.find(step=>step.run_id===coordinationRun?.run_id&&step.role==='implementation')??null;
const summaryCall=calls.find(call=>call.task_id===summaryStep?.child_task_id&&call.runtime_kind==='claude'&&call.status==='succeeded')??null;
const childTasks=tasks.filter(task=>task.parent_task_id===rootTask?.id);
const plannedChildIds=new Set(steps.map(step=>step.child_task_id));
const unexpectedChildTasks=childTasks.filter(task=>!plannedChildIds.has(task.id));
const codexUpstream=codexStep==null?null:(()=>{
  for(const step of steps.filter(candidate=>candidate.run_id===coordinationRun?.run_id)){
    const parsed=(()=>{try{return JSON.parse(step.handoff_json??'{}');}catch{return{};}})();
    const match=(parsed.upstream??[]).find(upstream=>upstream.id===codexDelivery?.id
      &&upstream.run_id===codexDelivery?.run_id&&upstream.manifest_hash===codexDelivery?.manifest_hash
      &&upstream.owner_member_id===codex?.id);
    if(match)return{step,upstream:match};
  }
  return null;
})();
const codexFinal=codexCall==null?null:agentMessages.filter(message=>message.task_id===codexCall.task_id
  &&message.author_id===codex?.id&&message.status==='final').at(-1)??null;
const reportFile=path.join(project,'报告复核-v1.md');
must(fs.existsSync(reportFile),'report file exists');
const report=fs.readFileSync(reportFile,'utf8');
const reportFacts={
  name:'报告复核-v1.md',
  bytes:fs.statSync(reportFile).size,
  sha256:sha(reportFile),
  hasCodex:/Codex/i.test(report),
  hasRequiredFacts:['36,500','预算明细.xlsx','2026-10-18','李晨','张岚'].every(value=>report.includes(value)),
  hasUsefulFinding:/元数据|作者|版本/.test(report),
};
const humanProtocolFree=humanMessages.every(message=>!protocolTerms.test(message.body_json));
const memberProtocolFree=memberRows.every(member=>!protocolTerms.test(member.description??'')
  &&!protocolTerms.test(member.settingsJson??''));
const allCallsSucceeded=calls.length===6&&calls.every(call=>call.status==='succeeded');
const allTurnsSucceeded=turns.length===6&&turns.every(turn=>turn.status==='SUCCEEDED');
const exactBindings=deepseek?.kind==='claude'&&deepseek.settings.model==='deepseek-flash'
  &&codex?.kind==='codex'&&codex.settings.model==='ccs-new/glm-5.3-flash'&&codex.settings.effort==='high'
  &&deepseek.id!==codex.id;
const exactCalls=codexCall?.runtime_kind==='codex'&&codexCall.model==='ccs-new/glm-5.3-flash'
  &&codexCall.member_id===codex.id&&codexCall.status==='succeeded'
  &&calls.some(call=>call.runtime_kind==='claude'&&call.model==='deepseek-flash'&&call.member_id===deepseek.id&&call.status==='succeeded');
const noInflight=[...calls,...turns].every(row=>!['inflight','RUNNING','PENDING','DISPATCHING','WAITING_APPROVAL','WAITING_INPUT','STOPPING','UNKNOWN','FAILED','CANCELLED'].includes(row.status))
  &&outbox.every(row=>row.status==='done');
const plannedChildrenOnly=childTasks.length===3&&childTasks.length===steps.length
  &&childTasks.every(task=>task.status==='DONE')&&unexpectedChildTasks.length===0;
const rootReady=rootTask?.status==='REVIEW'&&rootDelivery?.review_status==='pending'
  &&rootDelivery.task_id===rootTask.id&&rootDelivery.run_id===coordinationRun?.integration_run_id;
const integrationSucceeded=coordinationRun?.state==='completed'&&integrationCall?.runtime_kind==='claude'
  &&integrationCall.member_id===deepseek.id&&integrationCall.model==='deepseek-flash'&&integrationCall.status==='succeeded';
const coordinationBound=codexStep?.run_id===summaryStep?.run_id&&summaryCall!=null
  &&codexUpstream?.upstream.manifest_hash===codexDelivery?.manifest_hash
  &&coordinationMessages.length===0&&ignoredEvents.length>=1;
const naturalPromptHash=humanMessages.find(message=>message.id===natural.prompt?.id)?.body_json??null;

function snapshotRoot(label,out,pkgPath,expected){
  const database=path.join(pkgPath,'server-data','state.sqlite');
  const rootBuild=read(path.join(pkgPath,'ZhongshuoDual','BUILD.json'));
  const sqlite=new Database(database,{readonly:true,fileMustExist:true});
  let callRows,turnRows,taskRows,messageRows,invalidEvents;
  try{
    callRows=sqlite.prepare('SELECT id,runtime_kind,model,status,task_id,turn_id,run_id,detail FROM real_calls ORDER BY rowid').all();
    turnRows=sqlite.prepare('SELECT id,status,member_id FROM agent_turns ORDER BY rowid').all();
    taskRows=sqlite.prepare('SELECT id,status,parent_task_id FROM tasks ORDER BY rowid').all();
    messageRows=sqlite.prepare("SELECT id,body_json FROM messages WHERE author_type='human' ORDER BY rowid").all();
    invalidEvents=sqlite.prepare("SELECT kind,turn_id,payload_json FROM domain_events WHERE kind IN (?,?) ORDER BY seq").all('turn.outputInvalid','turn.statusChanged');
  }finally{sqlite.close();}
  const artifacts=fs.readdirSync(out,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>{
    const file=path.join(out,entry.name);
    return{name:entry.name,bytes:fs.statSync(file).size,sha256:sha(file)};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const callStatuses=groups(callRows,'status');
  const turnStatuses=groups(turnRows,'status');
  const taskStatuses=groups(taskRows,'status');
  const validBuild=rootBuild.buildId===expected.buildId&&rootBuild.commit===expected.commit&&rootBuild.dirty===false;
  const outputInvalid=invalidEvents.some(event=>event.kind==='turn.outputInvalid');
  return{label,out,package:pkgPath,build:{buildId:rootBuild.buildId,commit:rootBuild.commit,dirty:rootBuild.dirty},
    stateSqlite:{file:database,bytes:fs.statSync(database).size,sha256:sha(database)},
    calls:callRows,turns:turnRows,tasks:taskRows,humanMessageCount:messageRows.length,
    protocolHumanMessageCount:messageRows.filter(row=>protocolTerms.test(row.body_json)).length,
    callStatuses,turnStatuses,taskStatuses,outputInvalid,artifacts,validBuild,
  };
}

const historical={
  mixedDeadline5m:snapshotRoot('mixed-deadline-5m',
    path.join(repo,'dist','review-r87-final','rc2-mixed-natural-1'),
    path.join(repo,'dist','review-r87-final','rc2-mixed-package-natural-20261018'),{buildId:'bld_2b4d48d74833429d',commit:expectedBaseCommit}),
  mixedDeadline10m:snapshotRoot('mixed-deadline-10m',
    path.join(repo,'dist','review-r87-final','rc2-mixed-natural-2'),
    path.join(repo,'dist','review-r87-final','rc2-mixed-package-natural2-20261018'),{buildId:'bld_2b4d48d74833429d',commit:expectedBaseCommit}),
  mixedOutputInvalid:snapshotRoot('mixed-output-invalid',
    path.join(repo,'dist','review-r87-final','rc2-mixed-natural-3'),
    path.join(repo,'dist','review-r87-final','rc2-mixed-package-natural3-20261018'),{buildId:'bld_2b4d48d74833429d',commit:expectedBaseCommit}),
  gptQuota:snapshotRoot('gpt-6-luna-quota',
    path.join(repo,'dist','review-r87-final','rc2-final-natural-1'),
    path.join(repo,'dist','review-r87-final','rc2-final-package-natural-20261018'),{buildId:'bld_2b4d48d74833429d',commit:expectedBaseCommit}),
  engineeringPrompted:snapshotRoot('mixed-4-engineering-prompted',
    path.join(repo,'dist','review-r87-final','rc2-mixed-natural-4'),
    path.join(repo,'dist','review-r87-final','rc2-mixed-package-natural4-20261018'),{buildId:'bld_2b4d48d74833429d',commit:expectedBaseCommit}),
  rc2NoProtocolAssertionFailure:snapshotRoot('rc2-no-protocol-assertion-failure',
    path.join(repo,'dist','review-r87-final','rc2-natural-noprotocol-1'),
    path.join(repo,'dist','review-r87-final','rc2-natural-noprotocol-package-20261018'),{buildId:'bld_2b4d48d74833429d',commit:expectedBaseCommit}),
  rc2NoProtocolOutputInvalid:snapshotRoot('rc2-no-protocol-output-invalid',
    path.join(repo,'dist','review-r87-final','rc2-natural-noprotocol-2'),
    path.join(repo,'dist','review-r87-final','rc2-natural-noprotocol-package2-20261018'),{buildId:'bld_2b4d48d74833429d',commit:expectedBaseCommit}),
  rc3PrematureClose:snapshotRoot('rc3-no-protocol-premature-close',
    path.join(repo,'dist','review-r87-final','rc3-natural-noprotocol-1'),
    path.join(repo,'dist','review-r87-final','rc3-natural-noprotocol-package-1-20261018'),{buildId:'bld_670f53109a74d809',commit:'ecaef7d5ac7683619986608af7fc294a8b209326'}),
  rc4PrematureClose:snapshotRoot('rc4-no-protocol-premature-close',
    path.join(repo,'dist','review-r87-final','rc4-natural-noprotocol-1'),
    path.join(repo,'dist','review-r87-final','rc4-natural-noprotocol-package-1-20261018'),{buildId:build.buildId,commit:expectedCommit}),
};
const oldSaveFile=path.join(repo,'dist','review-r87-final','rc2-mixed-natural-4','save-reopen.json');
const oldSave=read(oldSaveFile);
const fullSuiteFile=path.join(repo,'dist','review-r87-final','rc4-full-single-20261018.json');
const fullSuite=read(fullSuiteFile);
const superseded977Package=path.join(repo,'dist','desktop','desktop-daily-win-v26-r87-20261017');
const superseded977Build=read(path.join(superseded977Package,'ZhongshuoDual','BUILD.json'));
const superseded977ResultFile=path.join(repo,'dist','review-r87-final','final-natural-1','result.json');
const superseded977Result=read(superseded977ResultFile);

const historicalChecks={
  allBuildsMatch:Object.values(historical).every(root=>root.validBuild),
  deadline5mPreserved:historical.mixedDeadline5m.calls.some(call=>call.runtime_kind==='codex'
    &&call.model==='ccs-new/glm-5.3-flash'&&call.status==='unknown'&&/turn-deadline-interrupt/.test(call.detail??'')),
  deadline10mPreserved:historical.mixedDeadline10m.calls.some(call=>call.runtime_kind==='codex'
    &&call.model==='ccs-new/glm-5.3-flash'&&call.status==='unknown'&&/turn-deadline-interrupt/.test(call.detail??'')),
  outputInvalidPreserved:historical.mixedOutputInvalid.outputInvalid
    &&historical.mixedOutputInvalid.calls.some(call=>call.runtime_kind==='codex'&&call.status==='failed'),
  quotaPreserved:historical.gptQuota.calls.some(call=>call.runtime_kind==='codex'
    &&call.model==='gpt-6-luna'&&call.status==='failed'),
  rc2NoProtocolOutputInvalidPreserved:historical.rc2NoProtocolOutputInvalid.outputInvalid
    &&historical.rc2NoProtocolOutputInvalid.protocolHumanMessageCount===0,
  prematureCloseRootsPreserved:(historical.rc3PrematureClose.taskStatuses.OPEN??0)>=1
    &&historical.rc4PrematureClose.calls.some(call=>call.runtime_kind==='claude'&&call.status==='unknown'),
  engineeringPromptedPreserved:historical.engineeringPrompted.calls.filter(call=>call.status==='succeeded').length===8
    &&historical.engineeringPrompted.protocolHumanMessageCount>0,
  oldSaveTimeoutPreserved:oldSave.ok===false&&/CDP timeout Runtime\.evaluate/.test(oldSave.error??''),
  superseded977Preserved:superseded977Build.buildId==='bld_939523319bbbd61d'
    &&superseded977Build.commit==='9771a8a39caec15c85429580b78827ef9f8baca0'
    &&superseded977Result.ok===true,
};

const checks={
  sourceBuildExact:build.commit===expectedCommit&&build.dirty===false,
  programManifest595:release.manifestFiles===595&&manifestErrors.length===0,
  packagePristine:release.pristine,
  naturalSameBuild:natural.build.buildId===build.buildId&&natural.build.commit===build.commit,
  sixRealCallsAllSucceeded:allCallsSucceeded&&allTurnsSucceeded,
  exactMemberModelBindings:exactBindings&&exactCalls,
  noProtocolWordsInHumanOrMemberInput:humanProtocolFree&&memberProtocolFree
    &&natural.prompt?.text!=null&&!protocolTerms.test(natural.prompt.text)&&naturalPromptHash!=null,
  coordinationCompleted:coordinationRun?.state==='completed',
  coordinationBound,
  plannedChildrenOnly,
  codexUsefulResult:codexFinal!=null&&natural.codex?.finding?.key!=null
    &&reportFacts.hasUsefulFinding&&codexUpstream!=null,
  rootDeliveryReady:rootReady,
  integrationSucceeded,
  noUnknownInflightOrFailed:noInflight,
  reportBytesAndHash:reportFacts.bytes>0&&reportFacts.sha256.length===64
    &&reportFacts.hasCodex&&reportFacts.hasRequiredFacts,
  fullSuitePass:fullSuite.success===true&&fullSuite.numTotalTests===1259
    &&fullSuite.numPassedTests===1259&&fullSuite.numFailedTests===0,
  historicalFailuresPreserved:Object.values(historicalChecks).every(Boolean),
};
const pass=Object.values(checks).every(Boolean);
const result={
  format:'zhongshuo-r87-rc4-final-evidence-v1',
  ok:pass,
  releaseQualified:false,
  reviewStatus:'candidate-ready-for-independent-review',
  release,
  checks,
  natural:{
    resultFile:naturalFile,
    resultSha256:sha(naturalFile),
    runtimePackage,
    project,
    task:rootTask,
    delivery:rootDelivery,
    coordinationRun,
    coordinationMessages,
    ignoredRedundantHandoffs:ignoredEvents,
    steps,
    childTasks,
    calls,
    turns,
    members:memberRows.map(member=>({id:member.id,displayName:member.displayName,description:member.description,
      kind:member.kind,model:member.settings.model,effort:member.settings.effort??null,permissionMode:member.settings.permissionMode??null})),
    codex:{
      call:codexCall,task:codexTask,delivery:codexDelivery,step:codexStep,upstream:codexUpstream?.upstream??null,
      finalMessageId:codexFinal?.id??null,finalMessageRawSha256:codexFinal==null?null:hashText(codexFinal.body_json),
      finding:natural.codex?.finding??null,
    },
    summary:{step:summaryStep,call:summaryCall},
    integration:{call:integrationCall},
    prompt:{id:natural.prompt?.id??null,rawBodySha256:naturalPromptHash==null?null:hashText(naturalPromptHash),text:natural.prompt?.text??null},
  },
  report:reportFacts,
  verification:{
    fullSuite:{file:fullSuiteFile,sha256:sha(fullSuiteFile),testSuites:fullSuite.numTotalTestSuites,tests:fullSuite.numTotalTests,
      passed:fullSuite.numPassedTests,failed:fullSuite.numFailedTests,success:fullSuite.success},
    firstFullSuiteAttempt:{
      result:'fail',
      files:'169/170',
      tests:'1258/1259',
      failure:'docxWordValidation expected Microsoft Office but detected WPS Office 12.1.0.29158',
      disposition:'Preserved as an environment-dependent first run; immediate isolated rerun of the same file passed 5/5, then a complete clean single-thread rerun passed 1259/1259.',
    },
    typechecks:['pnpm typecheck passed','pnpm typecheck:hifi passed'],
    targetedProtocolReplay:'codexAdapterReplay 17/17 passed',
    targetedCoordination:'coordinationR86 + threadMembersR87 + codexAdapterReplay 65/65 passed',
  },
  historical:{
    ...historical,
    oldSaveProbe:{file:oldSaveFile,sha256:sha(oldSaveFile),ok:oldSave.ok,error:oldSave.error??null},
    superseded977:{package:superseded977Package,build:superseded977Build,resultFile:superseded977ResultFile,resultSha256:sha(superseded977ResultFile),resultOk:superseded977Result.ok},
  },
  historicalChecks,
  boundaries:[
    'Real Windows rc4 package on the synthetic report fixture; Claude deepseek-flash and Codex ccs-new/glm-5.3-flash (high) are exact member bindings.',
    'All 6 model calls and turns succeeded. The coordination run completed with exactly three planned child tasks; no extra OPEN child task, no coordination_messages row, and two duplicate handoffs were suppressed as audited redundant plan deliveries.',
    'The user-authored natural request and both member descriptions contain no TaskComplete/schema/JSON/Markdown/answer-protocol wording. Structured-final enforcement is supplied only by the Codex adapter developer instruction plus native outputSchema.',
    'The root task is REVIEW with one pending delivery from the completed integration run. This evidence does not claim human acceptance.',
    'Chromium/system automation is not human novice certification. The existing non-model UI/data/save gates were not rerun for the scoped rc4 adapter/coordination changes per reviewer scope.',
    'The first full-suite run had one WPS-vs-Microsoft-Office environment failure in docxWordValidation. The isolated file rerun passed 5/5 and a subsequent complete single-thread run passed 1259/1259; both facts remain recorded.',
    'Historical failures, early-close harness roots, engineering-prompted mixed-4 success, gpt-6-luna quota failure, outputInvalid roots, and the old CDP timeout save probe remain preserved and are not counted in rc4 success.',
    'No reset credit, user account configuration, user document, credential, or user data root was changed.',
  ],
  at:new Date().toISOString(),
};
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify({ok:pass,evidence:destination,buildId:build.buildId,calls:calls.length,checks,historicalChecks},null,2));
if(!pass)process.exitCode=1;
