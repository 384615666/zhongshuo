import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const read=p=>JSON.parse(readFileSync(p,'utf8'));const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const receipt=p=>({path:resolve(p),sha256:sha(p)});
const pkg=resolve('dist/desktop/desktop-daily-win-v19');const observation='dist/desktop/review-r80-v19-release-20261013';const unknown='dist/desktop/review-r80-v19-unknown-release-20261013';
const reading=process.argv[2];if(!reading)throw Error('reading result path required');
const paths={launcher:join(observation,'result.json'),soak:join(observation,'r80-soak-result.json'),samples:join(observation,'r80-soak-progress.json'),sidecar:join(observation,'r80-sidecar-result.json'),unknown:join(unknown,'result.json'),reading,cancel:'dist/desktop/r75-completion-1791858781781/result.json',host:'dist/r80-host-lifecycle-release/result.json',tests:'dist/r80-source-release-tests.json',storage:'dist/r80-storage-faults-final.json',original:'dist/r80-original-before-after-release/result.json',clockBefore:'dist/r80-reading-clock-before.json',clockAfter:'dist/r80-reading-clock-after.json',lint:'dist/r80-lint-release.json'};
const r=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,read(p)]));
function manifest(root){const build=read(join(root,'BUILD.json')),m=read(join(root,'MANIFEST-SHA256.json'));const bad=m.files.filter(f=>{const p=resolve(root,f.path);return!p.toLowerCase().startsWith((root+'\\').toLowerCase())||!existsSync(p)||statSync(p).size!==f.bytes||sha(p)!==f.sha256;});return{build,count:m.files.length,pass:bad.length===0&&m.buildId===build.buildId};}
const source=manifest(join(pkg,'ZhongshuoDual')),flow=manifest(join(r.launcher.copy,'ZhongshuoDual')),unknownCopy=manifest(join(r.unknown.copy,'ZhongshuoDual')),normal=manifest(resolve(reading,'..','copy','ZhongshuoDual')),old=manifest(resolve('dist/desktop/desktop-daily-win-v18/ZhongshuoDual'));
const samples=r.samples.samples;const required={
  sourceTests:r.tests.success&&r.tests.numPassedTests===978&&r.tests.numFailedTests===0,
  typechecks:['dist/r80-typecheck-main.log','dist/r80-typecheck-hifi.log'].every(p=>readFileSync(p,'utf8').trim()===''),lintIncrement:r.lint.pass,
  cleanBuild:source.build.dirty===false&&execFileSync('git',['diff',source.build.commit,'--','src','package.json','pnpm-lock.yaml'],{encoding:'utf8'}).trim()==='',
  sourceManifest:source.pass&&source.count===593,finalCopyManifests:flow.pass&&unknownCopy.pass&&normal.pass,
  sameBuild:[flow.build.buildId,unknownCopy.build.buildId,normal.build.buildId,r.host.buildId,r.soak.buildId,r.sidecar.buildId,r.reading.facts.buildId].every(id=>id===source.build.buildId),
  realLauncher:sha(join(pkg,'start-desktop.bat'))===r.launcher.launcherSha256&&r.launcher.pass&&r.launcher.steps.length>=21,
  transportRecovery:r.soak.transportDisconnect&&r.soak.confirmedFactsRetained&&r.soak.draftRetained,
  reloadHistory:r.soak.reloaded&&r.soak.historyRestored,
  actualThirtyMinutes:r.soak.pass&&r.soak.elapsedMs>=1800000&&r.soak.cycles>=60,
  sharedBoundedRecovery:samples.every(s=>s.connection.monitorTimers===1&&s.connection.inFlight<=1),
  noAutomaticBusiness:samples.every(s=>s.messages===samples[0].messages&&s.realCalls===0),
  measuredReads:samples.at(-1).requests>samples[0].requests&&samples.every(s=>s.inFlight>=0),
  rendererBoundedByRoute:[0,1,2,3,4].every(phase=>{const group=samples.filter(s=>s.phase===phase);return group.length>=2&&group.at(-1).intervals<=group[1].intervals+1&&group.at(-1).documentListeners<=group[1].documentListeners+2;}),
  projectPreviewAndGroupReading:r.sidecar.pass&&r.sidecar.actions.length===9&&r.sidecar.actions.filter(a=>a.kind==='detail-group-reading').every(a=>a.before.open===a.after.open&&Math.abs(a.before.top-a.after.top)<2),
  redactedClipboard:r.soak.diagnosticRedacted,
  unknownRealUi:r.unknown.pass&&r.unknown.unknown.pass&&r.unknown.unknown.reopenedOriginal&&r.unknown.unknown.noAutoResend&&r.unknown.unknown.sameIdReplay&&r.unknown.unknown.messages===1&&r.unknown.unknown.tasks===0,
  editedDraftAndOriginal:r.unknown.unknown.newDraftPreserved&&r.unknown.unknown.versionAndHashPreserved,
  storageInjections:r.storage.success&&r.storage.numPassedTests===3,
  originalBytesCounterexample:r.original.pass&&r.original.before.originalLost&&r.original.before.ok===false&&r.original.after.ok===false&&r.original.after.originalPreserved,
  clockCapacityCounterexample:r.clockBefore.success===false&&r.clockAfter.success===true,
  originalConnectionCounterexample:read('dist/r80-connection-before/result.json').recoveredNotification===false,
  originalGroupCounterexample:read('dist/desktop/review-r80-v19-final-observation-2-20261013/r80-reading-section-counter.json').pass===false,
  nativeHostScope:r.host.pass&&r.host.assertions.simulatedSuspendPauses&&r.host.assertions.clockJumpDoesNotRetry&&r.host.assertions.ownNativePause&&r.host.assertions.cleanQuit&&r.host.realOsSleep===false,
  projectCancelRegression:r.cancel.pass&&r.cancel.reports.length===10&&r.cancel.reports.every(t=>t.pass&&t.realCalls===0),
  normalLaunchRegression:r.reading.ok&&r.reading.facts.realCalls===0&&r.reading.facts.consoleErrors.length===0,
  attachmentAndOriginal:r.reading.facts.readRegression.pass&&r.reading.facts.readRegression.samples.length===4&&r.reading.facts.readRegression.samples.every(s=>s.chips===1)&&r.reading.facts.readRegression.saveHashMatched&&r.reading.facts.readRegression.image.width>0&&r.reading.facts.readRegression.image.height>0,
  zeroRealCalls:r.launcher.finalRealCalls===0&&r.unknown.finalRealCalls===0&&r.soak.modelCalls===0,
  noRendererErrors:r.launcher.ui.sessions.every(s=>s.errors.length===0)&&r.unknown.ui.sessions.every(s=>s.errors.length===0),
  oldV18Preserved:old.pass,noShippedProfile:!existsSync(join(pkg,'server-data'))&&!existsSync(join(pkg,'ZhongshuoDual/resources/app/engineering')),
  frozenMigrations:execFileSync('git',['diff','10d9e8c','--','src/persistence/migrations'],{encoding:'utf8'}).trim()==='',
};
const counterPaths=['dist/r80-connection-before/result.json','dist/r80-reading-clock-before.json','dist/desktop/review-r80-v19-recovery-20261013/result.json','dist/desktop/review-r80-v19-recovery-20261013/same-thread-navigation-before.json','dist/desktop/review-r80-v19-recovery-final-20261013/result.json','dist/desktop/review-r80-v19-recovery-final-20261013/native-copy-check.json','dist/desktop/review-r80-v19-final-observation-20261013/result.json','dist/desktop/review-r80-v19-final-observation-2-20261013/result.json','dist/desktop/review-r80-v19-final-observation-2-20261013/r80-reading-section-counter.json','dist/r80-host-lifecycle-final/result.json'];
const screenshotPaths=['r80-disconnected.png','r80-local-diagnostics.png','r79-historical-run.png','r79-history-reopened.png'].map(p=>join(observation,p)).concat(['r80-unknown-before-reopen.png','r80-unknown-after-explicit-replay.png'].map(p=>join(unknown,p)),[resolve(reading,'..','r79-image-reading.png')]);
const report={round:'R80',date:'2026-10-13',baseline:'10d9e8c',branch:'codex/full-implementation',build:source.build,package:pkg,pass:Object.values(required).every(Boolean),required,receipts:Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,receipt(p)])),counterexamples:counterPaths.map(receipt),screenshots:{buildId:source.build.buildId,files:screenshotPaths.map(receipt)},sourceValidation:{tests:r.tests.numPassedTests,files:r.tests.testResults.length,typecheckLogs:['dist/r80-typecheck-main.log','dist/r80-typecheck-hifi.log'].map(receipt),lintScope:r.lint.scope,externalGit:'existing R79 2 external sandbox failures retained, not rerun; not included in deterministic gate'},manifests:{source:source.count,flow:flow.count,unknown:unknownCopy.count,normal:normal.count,v18:old.count},observation:{durationMs:r.soak.elapsedMs,cycles:r.soak.cycles,start:r.samples.start,end:r.samples.start+r.soak.elapsedMs,requestsStart:samples[0].requests,requestsEnd:samples.at(-1).requests,peakInFlight:Math.max(...samples.map(s=>s.inFlight)),heapMin:Math.min(...samples.map(s=>s.heap.usedSize)),heapMax:Math.max(...samples.map(s=>s.heap.usedSize)),heapFirst:samples[0].heap.usedSize,heapLast:samples.at(-1).heap.usedSize,scope:'final own fake host; instrumented renderer intervals/document listeners; sampled JS heaps, not all native resources or multi-day leak certification'},boundaries:{realModelCalls:0,codexVision:'gpt-6-luna unverified; no retry/startTurn',realOsSleep:false,powerNotifications:'explicit simulation only',processPause:'native own headless Electron PID, 3 seconds; not OS sleep',hardwarePowerLoss:false,readingMetadata:'64 entries/512KiB; maximum12 restored tabs including active; no bytes/body',userAcceptance:false,userDataChanges:'none; no deletion/cleanup/moving user files or old packages',deferred:['AUTO/DELIBERATE','parallel managed writes','tool permission certification','Android','installer/signing','auto-update','value evaluation']}};
report.observation.sampleTiming='once after each action, approximately20 seconds between cycles; sampled inFlight is not a continuous peak trace';
report.observation.hostPeakInFlight=read(join(observation,'copy/server-data/engineering/r80-host-metrics.json')).peakInFlight;
report.screenshots.visuallyInspected=true;
writeFileSync('docs/implementation/r80-v19-delivery-20261013.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,checks:Object.keys(required).length,failed:Object.entries(required).filter(([,v])=>!v).map(([k])=>k),buildId:source.build.buildId}));if(!report.pass)process.exitCode=1;
