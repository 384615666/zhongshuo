/* global require,process,console */
/* eslint-disable @typescript-eslint/no-require-imports -- offline release evidence, no business writes */
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const [candidateArg,codexArg,glmArg,soakArg,upgradeArg,projectArg,visualArg,outputArg]=process.argv.slice(2);
if(!outputArg)throw Error('usage: node collect-r84-final-gates.cjs candidate codexRoot glmRoot soakRoot upgradedUnknownRoot projectResult visualResult output');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),gates=[],evidence=[];
const candidate=path.resolve(candidateArg),build=read(path.join(candidate,'ZhongshuoDual/BUILD.json'));
function gate(name,ok){gates.push({name,pass:ok===true});}
function receipt(file,sameBuild=true){const p=path.resolve(file),data=read(p);evidence.push({path:path.relative(process.cwd(),p),sha256:sha(p)});if(sameBuild)gate('same BUILD '+path.relative(process.cwd(),p),(data.build?.buildId??data.buildId)===build.buildId);return data;}
function manifest(root){const base=path.join(root,'ZhongshuoDual'),m=read(path.join(base,'MANIFEST-SHA256.json'));let bytes=0;for(const item of m.files){const target=path.resolve(base,item.path);if(!target.startsWith(base+path.sep)||fs.statSync(target).size!==item.bytes||sha(target)!==item.sha256)throw Error('manifest mismatch or escape: '+item.path);bytes+=item.bytes;}gate('manifest BUILD '+root,m.buildId===build.buildId);return{files:m.files.length,bytes,sha256:sha(path.join(base,'MANIFEST-SHA256.json'))};}
const manifests={candidate:manifest(candidate)};
gate('clean runtime BUILD',build.dirty===false&&build.dirtyDiffHash===null);
const runtimeDiff=execFileSync('git',['diff',build.commit,'--','src','package.json','pnpm-lock.yaml'],{encoding:'utf8'});
gate('current runtime bytes still match frozen source',runtimeDiff==='');
const frozenMigrations=execFileSync('git',['diff','969302b','--','src/persistence/migrations'],{encoding:'utf8'});
gate('001-050 migration sources frozen',!/^diff --git .*\/0(?:0[1-9]|[1-4][0-9]|50)[^/]*\.ts/m.test(frozenMigrations));
for(const [kind,rootArg,model,toolFile]of[['codex',codexArg,'gpt-6.1-sol','codex-native-proof.json'],['claude',glmArg,'glm-5.3-flash','native-tool-proof.json']]){
 const root=path.resolve(rootArg),main=receipt(path.join(root,'progress.json')),close=receipt(path.join(root,'closeout.json')),follow=receipt(path.join(root,'ordinary-followup-after.json')),tools=receipt(path.join(root,toolFile));
 const readonly=receipt(path.join(root,'readonly-result-facts.json'));
 const finalClose=receipt(path.join(root,'final-close.json'));
 gate(kind+' ordinary/image/actual file v1-v2 acceptance',main.imageFunctionalPass&&main.workflowFunctionalPass&&close.pass);
 gate(kind+' ten original successful real calls',close.calls?.length===10&&close.calls.every(c=>c.status==='succeeded'&&c.runtime_kind===kind&&c.model===model));
 gate(kind+' three same-thread original-member rounds',follow.pass&&follow.steps?.length===2&&follow.steps.every(s=>s.memberId===main.ids.memberId)&&follow.taskId===main.natural['plain-你好'].id&&follow.threadId===main.natural['plain-你好'].conversation_thread_id&&follow.recordOnly===true);
 gate(kind+' actual native execution and test evidence',tools.pass&&tools.sessions?.length>=2);
 gate(kind+' close/reopen and explicit readonly route',close.pass&&close.steps.some(s=>s.includes('normal close/real BAT reopen'))&&close.steps.some(s=>s.includes('readonly')));
 gate(kind+' readonly answer/plan is not claimed as a created file',readonly.pass&&readonly.actualFileExists===false&&readonly.modelDeclaredFiles.length===0);
 gate(kind+' final normal close completes durable shutdown',finalClose.pass&&finalClose.pidMarkerRemoved&&finalClose.stop?.pid===finalClose.originalDaemonPid&&finalClose.stop.at>=finalClose.closeAt&&finalClose.stop.phase==='closed'&&finalClose.callsBefore===10&&finalClose.callsAfter===10);
 gate(kind+' same original launcher',sha(path.join(candidate,'start-desktop.bat'))===sha(path.join(main.copy,'start-desktop.bat')));
 manifests[kind]=manifest(main.copy);
}
const soakRoot=path.resolve(soakArg),workflow=receipt(path.join(soakRoot,'result.json')),observation=receipt(path.join(soakRoot,'r84-observation-result.json')),recovery=receipt(path.join(soakRoot,'r80-soak-result.json'));
gate('formal Fake complete workflow/reopen',workflow.pass&&workflow.ui?.sessions?.every(s=>s.errors.length===0));
gate('same BUILD actual continuous two hours, not probe',observation.pass&&observation.observationCertified===true&&observation.probeCycles===null&&observation.elapsedMs>=7200000&&observation.endedAt-observation.start>=7200000&&observation.modelCalls===0);
gate('real pipe disconnect/recovery, reload and redacted clipboard',recovery.pass&&recovery.transportDisconnect&&recovery.confirmedFactsRetained&&recovery.draftRetained&&recovery.historyRestored&&recovery.diagnosticRedacted&&recovery.reloaded);
const progress=receipt(path.join(soakRoot,'r80-soak-progress.json'));
const measured=receipt(path.join(soakRoot,'observation-summary.json'));
gate('actual per-route observation metrics and stable host identities',measured.pass&&measured.elapsedMs>=7200000&&measured.byPhase.every(p=>p.samePhaseBounded));
const reading=receipt(path.join(soakRoot,'reading-after-observation-confirmed.json'));
const readingBaseline=receipt(path.join(soakRoot,'reading-before-confirmed-close.json'),false);
receipt(path.join(soakRoot,'reading-after-observation.json'),false); // Preserve the rejected stale pre-pagination baseline probe.
gate('cold reading baseline was confirmed after observation before normal close',readingBaseline.afterObservation&&readingBaseline.at>=observation.endedAt&&readingBaseline.normalClose&&readingBaseline.savedTop===readingBaseline.scrollTop&&readingBaseline.taskId===workflow.r79.scale.id&&readingBaseline.runId===workflow.r79.selectedHistoricalRun&&Math.abs(reading.history.scrollTop-readingBaseline.scrollTop)<=2);
gate('post-observation cold reopen retains exact history identity and target drafts',reading.pass&&reading.history.selectedRunId===reading.expectedRunId&&reading.history.historyOrigin&&reading.history.open&&reading.ordinaryDraft.retained&&reading.modelCalls===0);
gate('all eight observation routes repeatedly exercised',Array.from({length:8},(_,phase)=>progress.samples.filter(s=>s.phase===phase).length).every(n=>n>=2));
gate('bounded connection monitor and no observation dispatch',progress.samples.every(s=>s.connection.monitorTimers===1&&s.connection.inFlight<=1&&s.realCalls===0&&s.messages===progress.samples[0].messages));
manifests.engineeringCopy=manifest(workflow.copy);
gate('engineering copy uses the original launcher',sha(path.join(candidate,'start-desktop.bat'))===sha(path.join(workflow.copy,'start-desktop.bat')));
const upgraded=path.resolve(upgradeArg),upgrade=receipt(path.join(upgraded,'result.json')),upgradeRead=receipt(path.join(upgraded,'read-reopen.json')),nativeMenu=receipt(path.join(upgraded,'native-menu.json'));
manifests.upgradedCopy=manifest(upgrade.copy);
gate('upgraded copy uses the original launcher',sha(path.join(candidate,'start-desktop.bat'))===sha(path.join(upgrade.copy,'start-desktop.bat')));
const rollback=receipt(path.join(upgraded,'old-version-and-matching-rollback.json'));
const controls=receipt(path.join(upgraded,'native-window-controls.json'));
gate('native maximize/restore, preview expand/Escape and close',controls.pass&&controls.nativeClose&&controls.pidMarkerRemoved&&controls.realCalls===0);
gate('old program refuses final schema; matching complete backup opens',rollback.pass&&rollback.oldRefusal.schemaUnsupported&&rollback.rollback.schema===50&&rollback.rollback.calls===0&&rollback.rollback.tokenBytesMatch&&rollback.rollback.commandId===upgrade.retainedBeforeReplay.commandId&&rollback.rollback.paramsHash===upgrade.retainedBeforeReplay.paramsHash);
gate('complete old UNKNOWN root copy upgrade, explicit original replay only',upgrade.pass&&upgrade.backupFiles>0&&upgrade.schemaVersion===51&&upgrade.retainedBeforeReplay.noAutomaticReplay&&upgrade.manualSameIdentityReplay&&upgrade.draftPreserved&&upgrade.originalSourceUnchanged&&upgrade.modelCalls===0&&upgrade.shutdown);
gate('upgraded original bytes and actual browser decode',upgradeRead.pass&&upgradeRead.realCalls===0&&upgradeRead.legacyAbsoluteBlobPathRebased&&upgradeRead.decoded.width>0&&upgradeRead.decoded.height>0);
gate('real native menu close/search/navigation',nativeMenu.pass&&nativeMenu.steps.length>=7);
const ui=receipt(path.join(path.resolve(glmArg),'readonly-ui.json')),mention=receipt(path.join(path.resolve(glmArg),'mention-rejection-ui.json'));
const saveas=receipt(path.join(path.resolve(glmArg),'saveas-flow.json'));
gate('native cancel, original save bytes, honest failure and explicit restored retry',saveas.pass&&saveas.normalClose&&saveas.modelCalls===0&&saveas.callsBefore===10&&saveas.callsAfter===10&&saveas.phases.length===4&&saveas.phases.every(p=>p.pass)&&saveas.phases.some(p=>p.name==='invalid-directory'&&p.originalUnchanged&&p.priorSavedUnchanged));
gate('cold attachments across three five-second refreshes',ui.pass&&ui.attachmentSamples.length>=4&&ui.attachmentSamples.at(-1).at-ui.attachmentSamples[0].at>=15000&&ui.attachmentSamples.every(s=>s.ids.length===1&&s.ids[0]===ui.attachmentSamples[0].ids[0]));
gate('different-member mention rejects and retains draft',mention.pass&&mention.inputAndMentionRetained&&mention.noDispatch&&JSON.stringify(mention.before)===JSON.stringify(mention.after));
const project=receipt(projectArg,false),visual=receipt(visualArg);
gate('project latest intent/cancellation regressions',project.pass);
gate('paired visual inspection',visual.pass&&visual.reviewed===true);
const source=receipt('dist/r84-final6-source-checks-after-reopen-test.json'),lint=receipt('dist/r84-final6-lint-release.json',false),testLog=path.resolve('dist/r84-source-suite-11.log');evidence.push({path:path.relative(process.cwd(),testLog),sha256:sha(testLog)});
gate('typecheck receipt binds frozen runtime commit',source.runtimeCommit===build.commit);
gate('lint coverage still matches current checked file bytes',lint.covered.every(f=>sha(f.file)===f.sha256));
gate('both source typechecks',source.typecheck.exitCode===0&&source.typecheckHifi.exitCode===0);gate('incremental lint no added errors',lint.pass);
gate('deterministic source suite',/Test Files\s+150 passed \(150\)/.test(fs.readFileSync(testLog,'utf8'))&&/Tests\s+1058 passed \(1058\)/.test(fs.readFileSync(testLog,'utf8')));
gate('distribution has no data root or fake fixture',!fs.existsSync(path.join(candidate,'server-data'))&&!fs.existsSync(path.join(candidate,'seed')));
gate('current practical guide bytes in final distribution',sha('docs/desktop-quickstart.md')===sha(path.join(candidate,'README-DAILY.md'))&&sha('docs/desktop-quickstart.md')===sha(path.join(candidate,'开始使用.md')));
const ledger=receipt('dist/r84-call-ledger-completed.json',false);
gate('original real-call identities are deduplicated without conflicts',ledger.pass&&ledger.conflicts.length===0&&ledger.uniqueCalls===ledger.calls.length&&new Set(ledger.calls.map(c=>c.turn_id)).size===ledger.calls.length);
const corePass=gates.every(g=>g.pass);
// Mouse movement remains a separate mandatory gate; no keyboard or setBounds substitution.
gate('native titlebar mouse movement verified',nativeMenu.mouseDrag==='passed');
const result={pass:gates.every(g=>g.pass),corePass,build,candidate,gates,manifests,evidence,unverified:['native titlebar mouse movement','provider-reported effective reasoning intensity','physical HiDPI/real OS sleep/multi-day behavior','all native tools and all model combinations'],userAcceptance:'pending'};
fs.writeFileSync(path.resolve(outputArg),JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,corePass,failed:gates.filter(g=>!g.pass)}));if(!result.pass)process.exitCode=1;
