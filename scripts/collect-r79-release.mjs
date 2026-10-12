import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const receipt=p=>({path:resolve(p),sha256:sha(p)});
const pkg=resolve('dist/desktop/desktop-daily-win-v18');
function manifest(root){const b=read(join(root,'BUILD.json')),m=read(join(root,'MANIFEST-SHA256.json'));const errors=[];for(const f of m.files){const p=resolve(root,f.path);if(!p.toLowerCase().startsWith((root+'\\').toLowerCase())||!existsSync(p)||statSync(p).size!==f.bytes||sha(p)!==f.sha256)errors.push(f.path);}return{build:b,count:m.files.length,pass:errors.length===0&&m.buildId===b.buildId,errors};}
const paths={launcher:'dist/desktop/review-r79-v18-launcher-final-dm/result.json',reading:'dist/desktop/r75-launcher-check-1791819714746/result.json',cancel:'dist/desktop/r75-completion-1791819675574/result.json',live:'dist/r79-details-live-release/result.json',dm:'dist/r79-dm-records-controlled-final/result.json',memberBefore:'dist/r79-member-workload-before/result.json',memberAfter:'dist/r79-member-workload-after/result.json',costBefore:'dist/r79-details-cost-before.json',costAfter:'dist/r79-details-cost-final-2.json',tests:'dist/r79-local-full-tests-final-3.json',externalTests:'dist/r79-full-tests-stage.json',lint:'dist/r79-lint-final-delta.json',samples:'dist/desktop/review-r79-v18-launcher-final-dm/r79-live-samples.json'};
const r=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,read(p)]));
const source=manifest(join(pkg,'ZhongshuoDual')),copy=manifest(join(r.launcher.copy,'ZhongshuoDual')),readingCopy=manifest(resolve(paths.reading,'..','copy','ZhongshuoDual')),old=manifest(resolve('dist/desktop/desktop-daily-win-v17/ZhongshuoDual'));
const target=r.launcher.r79;
const typechecks=['dist/r79-tsconfig.json.log','dist/r79-tsconfig.hifi.json.log'].map(p=>({pass:readFileSync(p,'utf8').trim()==='',...receipt(p)}));
const pipes=[join(r.launcher.copy,'server-data/pipe-name.txt'),resolve(paths.reading,'..','copy/server-data/pipe-name.txt')].map(p=>readFileSync(p,'utf8').trim());
const runtimeChangedAfterBuild=execFileSync('git',['diff',source.build.commit,'--','src','package.json','pnpm-lock.yaml'],{encoding:'utf8'}).trim();
const requiredChecks={
  localSourceTests:r.tests.success&&r.tests.numFailedTests===0&&r.tests.numPassedTests===962,
  typechecks:typechecks.every(x=>x.pass),noNewLint:r.lint.pass===true,
  preservedLiveCounterexample:read('dist/desktop/review-r78-v17-audit-20261012/ui-result.json').pass===false&&read('dist/desktop/review-r78-v17-audit-20261012/manual-control/ui-result.json').pass===false,
  preservedMemberCounterexample:r.memberBefore.pass===false,
  liveReadRaces:r.live.pass&&Object.values(r.live.assertions).every(Boolean),
  dmReadRaces:r.dm.pass&&Object.values(r.dm.assertions).every(Boolean),
  dmCompletedHistory:r.launcher.dmRecords?.completed&&r.launcher.dmRecords.historicalRun&&r.launcher.dmRecords.versions.join(',')==='1,2'&&r.launcher.dmRecords.closedToConversation,
  memberAuthorityAndRecovery:r.memberAfter.pass&&Object.values(r.memberAfter.assertions).every(Boolean),
  readCostBounded:r.costAfter.queriesPerRead<20&&r.costAfter.payloadBytes<150000&&r.costAfter.queriesPerRead<r.costBefore.queriesPerRead,
  cleanBuild:source.build.dirty===false&&runtimeChangedAfterBuild==='',
  manifests:source.pass&&copy.pass&&readingCopy.pass,
  sameFinalBuild:source.build.buildId===r.launcher.buildId&&source.build.buildId===copy.build.buildId&&source.build.buildId===readingCopy.build.buildId&&source.build.buildId===r.reading.facts.buildId,
  launcherBytes:sha(join(pkg,'start-desktop.bat'))===r.launcher.launcherSha256,
  fullRoomDmWorkflow:r.launcher.pass===true&&r.launcher.steps.length>=19,
  sustainedRunning:target.threeCycles&&target.automaticToolsAndUsage&&r.samples.samples.every(s=>s.runStatus==='RUNNING')&&new Set(r.samples.samples.map(s=>s.taskRevision)).size===1&&new Set(r.samples.samples.map(s=>s.runId)).size===1,
  explicitFailureReason:target.failureReasonVisible===true,
  deliveryAndExplicitFailureRecovery:target.naturalDelivery&&target.explicitFailureRecovery,
  accessibleHistory:target.historyRead&&target.reopen&&target.runs>20&&target.events>120&&target.deliveries>50,
  readingPreserved:target.afterReading.open&&Math.abs(target.reading.scrollTop-target.afterReading.scrollTop)<=2,
  historyLayout:target.geometry.overflow==='auto'&&target.geometry.visible,
  zeroRendererErrors:r.launcher.ui.sessions.every(s=>s.errors.length===0)&&r.reading.facts.consoleErrors.length===0,
  projectCancelAndCrossOpen:r.cancel.pass&&r.cancel.reports.length===10&&r.cancel.reports.every(x=>x.pass&&x.realCalls===0)&&r.reading.ok===true,
  imageDecodeAndOriginal:r.reading.facts.readRegression.pass&&r.reading.facts.readRegression.image.width>0&&r.reading.facts.readRegression.image.height>0&&r.reading.facts.readRegression.saveHashMatched&&r.reading.facts.readRegression.fileTreeDecoded,
  attachmentStability:r.reading.facts.readRegression.samples.length===4&&r.reading.facts.readRegression.samples.every(x=>x.chips===1),
  zeroModelCalls:r.launcher.finalRealCalls===0&&r.reading.facts.realCalls===0&&r.costAfter.realCalls===0,
  independentRoots:pipes[0]!==pipes[1],oldV17Preserved:old.pass,
  noShippedProfileOrFixture:!existsSync(join(pkg,'server-data'))&&!existsSync(join(pkg,'ZhongshuoDual/resources/app/engineering')),
  migrationsFrozen:execFileSync('git',['diff','cbc6d15','--','src/persistence/migrations'],{encoding:'utf8'}).trim()==='',
};
const report={round:'R79',date:'2026-10-12',baseline:'cbc6d15',branch:'codex/full-implementation',package:pkg,build:source.build,pass:Object.values(requiredChecks).every(Boolean),requiredChecks,receipts:Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,receipt(p)])),sourceValidation:{localTests:r.tests.numPassedTests,localFiles:r.tests.testResults.length,typechecks,lintScope:r.lint.scope,externalGitSandbox:{scope:'existing real GitHub sandbox file; not an R79 deterministic gate',passed:3,failed:2,totalSuitePassed:r.externalTests.numPassedTests,totalSuiteFailed:r.externalTests.numFailedTests,claim:'not passed, retained without automatic repeat; failures ls-remote/network and upstream commit_refs',receipt:receipt(paths.externalTests)}},packageValidation:{source:source.count,launcherCopy:copy.count,readingCopy:readingCopy.count,oldV17:old.count,pipes},performance:{before:r.costBefore,after:r.costAfter,queryReduction:1-r.costAfter.queriesPerRead/r.costBefore.queriesPerRead,payloadReduction:1-r.costAfter.payloadBytes/r.costBefore.payloadBytes,heaps:r.samples.heaps,scope:r.samples.memoryScope},boundaries:{realModelCalls:0,codexVision:'gpt-6-luna remains unverified; no retry/startTurn',claudeVision:'only previously certified effective identity; no expansion of certification',userImageAcceptance:'inherited user confirmation; no repeated user checklist',scaleFixture:'26 runs / 3250 synthetic events / 61 versions separately labelled; ordinary states and files from worker remain separate',boundedDetails:'selected run latest80 turns / latest50 usage records per turn; children50/changeSets100/artifacts100 still explicitly bounded; no new pagination for these collections',memory:'minute-scale continuous workflows and controlled races, not multi-day idle/suspend/leak certification',deferred:['AUTO/DELIBERATE','parallel managed writes','tool permission certification','Android','installer/signing/auto-update','value evaluation'],userAcceptance:false,externalGitSandbox:'2 original external-service failures remain; local Git contracts passed'},scriptChangesAfterBuild:'later commits are QA/read smoke/records only; runtime bytes remain clean 83ec701'};
report.screenshots={buildId:source.build.buildId,visuallyInspected:true,files:['r79-dm-task-records.png','r79-live-running.png','r79-failure-details.png','r79-delivery-history.png','r79-history-reopened.png'].map(name=>receipt(resolve(paths.launcher,'..',name))).concat([receipt(resolve(paths.reading,'..','r79-image-reading.png'))])};
writeFileSync('docs/implementation/r79-v18-delivery-20261012.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,checks:Object.keys(requiredChecks).length,failed:Object.entries(requiredChecks).filter(([,v])=>!v).map(([k])=>k),buildId:source.build.buildId}));if(!report.pass)process.exitCode=1;
