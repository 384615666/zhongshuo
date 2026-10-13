import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repo=resolve(import.meta.dirname,'..');
const freeze='ab418320a827803fb56d9de54a28100822e451ed';
const daily=join(repo,'dist/desktop/desktop-daily-win-v20');
const paths={
 members:'dist/desktop/review-r81-v20-release-20261013/result.json',
 faults:'dist/desktop/review-r81-v20-faults-release-20261013/result.json',
 visual:'dist/desktop/review-r81-v20-visual-release-3-20261013/result.json',
 prototype:'dist/desktop/review-r81-prototype-3-20261013/result.json',
 workflow:'dist/desktop/review-r81-v20-workflow-release-20261013/result.json',
 upgrade:'dist/r81-upgrade-release/result.json',
 reference:'dist/r81-codex-reference-release/result.json',
 reading:'dist/desktop/r75-launcher-check-1791872714674/result.json',
 cancellation:'dist/desktop/r75-completion-1791872929059/result.json',
 lint:'dist/r81-lint-final-qa.json',
};
const read=p=>JSON.parse(readFileSync(join(repo,p),'utf8'));
const data=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,read(p)]));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const build=read('dist/desktop/desktop-daily-win-v20/ZhongshuoDual/BUILD.json');
const checks=[];const check=(name,pass)=>checks.push({name,pass:pass===true});
function manifest(root){const base=join(root,'ZhongshuoDual');const m=JSON.parse(readFileSync(join(base,'MANIFEST-SHA256.json'),'utf8'));const bad=m.files.filter(f=>!existsSync(join(base,f.path))||statSync(join(base,f.path)).size!==f.bytes||sha(join(base,f.path))!==f.sha256);return{root,count:m.files.length,bad:bad.map(f=>f.path),buildId:m.buildId};}
const manifests=[daily,data.members.copy,join(repo,'dist/desktop/review-r81-v20-faults-release-20261013/copy'),data.workflow.copy,join(repo,'dist/desktop/r75-launcher-check-1791872714674/copy')].map(manifest);
check('clean actual runtime BUILD matches frozen source',build.dirty===false&&build.commit===freeze);
check('all five final/source copies match593 manifest files and BUILD',manifests.every(m=>m.count===593&&m.bad.length===0&&m.buildId===build.buildId));
check('final daily has no data/profile/seeds/default engineering host',!existsSync(join(daily,'server-data'))&&!existsSync(join(daily,'seed'))&&!existsSync(join(daily,'samples'))&&!existsSync(join(daily,'ZhongshuoDual/resources/app/engineering')));
const oldPackage=manifest(join(repo,'dist/desktop/desktop-daily-win-v19'));
check('previous v19 package593 bytes unchanged',oldPackage.count===593&&oldPackage.bad.length===0&&oldPackage.buildId==='bld_02c536c5b5eb3ab3');
check('unmodified true BAT identity across final copies',sha(join(daily,'start-desktop.bat'))===data.members.launcherSha&&sha(join(daily,'start-desktop.bat'))===data.workflow.launcherSha256);
check('members7 formal interactions and reopen',data.members.pass&&data.members.steps.length===7&&data.members.realCalls===0&&data.members.rendererErrors.length===0);
check('six-member/three-template settled UI visual supplement',data.visual.pass&&data.visual.memberCount===6&&data.visual.templateCount===3&&data.visual.realCalls===0&&data.visual.errors.length===0);
check('UI template disable and explicit restore',data.visual.templateDisableAndRestore===true);
check('actual reopen and reuse creates new identity, source unchanged',data.visual.reuseAfterReopen?.sourceUnchanged===true&&typeof data.visual.reuseAfterReopen.memberId==='string');
check('fault5 critical paths incl known-success/read-only retry and manual original envelope',data.faults.pass&&data.faults.steps.length===5&&data.faults.rendererErrors.length===0&&data.faults.realCalls===0&&typeof data.faults.originalCommandId==='string'&&/^[a-f0-9]{64}$/.test(data.faults.paramsHash));
check('final BUILD bound across members/faults/visual/upgrade',Object.values({m:data.members.build,f:data.faults.build,v:data.visual.build,u:data.upgrade.newBuild}).every(b=>b.buildId===build.buildId&&b.commit===freeze&&b.dirty===false));
check('real factory passes exact explicit program and gpt-6-luna, read-only retained',data.reference.pass&&data.reference.factoryExecutable===data.reference.boundExecutable&&data.reference.ignoredReference===false&&data.reference.modelId==='gpt-6-luna'&&data.reference.sandbox==='read-only'&&data.reference.realCalls===0&&data.reference.stop.complete);
check('complete previous engineering root upgrades with66 legacy business tables preserved',data.upgrade.pass&&data.upgrade.legacyTableCount===66&&data.upgrade.copiedFiles===86&&data.upgrade.upgraded.version===49&&data.upgrade.upgraded.calls===0&&data.upgrade.nonDatabaseFilesIntact);
check('real v19 refuses49, matching48 backup opens',data.upgrade.oldRefusal.error.includes('SCHEMA_VERSION_UNSUPPORTED')&&data.upgrade.backupReopen.ok&&data.upgrade.backupReopen.version===48&&data.upgrade.backupReopen.calls===0);
check('R78/R79 actual BAT formal worker workflow20 steps, zero calls',data.workflow.pass&&data.workflow.steps.length===20&&data.workflow.buildId===build.buildId&&data.workflow.finalRealCalls===0);
check('ordinary final BAT reading and project switch/reopen',data.reading.ok&&data.reading.facts.buildId===build.buildId&&data.reading.facts.realCalls===0&&data.reading.facts.consoleErrors.length===0);
check('actual generated PNG decode,3 poll periods and original hash',data.reading.facts.readRegression.pass&&data.reading.facts.readRegression.image.width>0&&data.reading.facts.readRegression.image.height>0&&data.reading.facts.readRegression.samples.length===4&&data.reading.facts.readRegression.samples.every(s=>s.chips===1)&&data.reading.facts.readRegression.saveHashMatched&&data.reading.facts.readRegression.fileTreeDecoded);
check('project cancellation/cross-open10 independent regressions',data.cancellation.pass&&data.cancellation.reports.length===10&&data.cancellation.reports.every(r=>r.pass&&r.realCalls===0));
check('prototype reference real renderer,6-member density and3 viewports',data.prototype.pass&&data.prototype.count===6&&data.prototype.viewports.length===3&&data.prototype.errors.length===0);
check('main typecheck clean',!readFileSync(join(repo,'dist/r81-typecheck-main-final.log'),'utf8').includes('error TS'));
check('hifi typecheck clean',!readFileSync(join(repo,'dist/r81-typecheck-ui-final.log'),'utf8').includes('error TS'));
check('992 deterministic source checks/139 files (external GitHub excluded)',/Tests\s+992 passed \(992\)/.test(readFileSync(join(repo,'dist/r81-suite-final-source.log'),'utf8'))&&/Test Files\s+139 passed/.test(readFileSync(join(repo,'dist/r81-suite-final-source.log'),'utf8')));
check('14 current member/template/program tests',/Tests\s+14 passed/.test(readFileSync(join(repo,'dist/r81-contract-freeze.log'),'utf8')));
check('changed-file lint has no new errors',data.lint.pass&&data.lint.files.every(f=>f.added.length===0));
const frozen=execFileSync('git',['diff','56a8b87','--name-only','--','src/persistence/migrations'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean);
check('001-048 frozen, only registry and049 added',frozen.every(p=>/registry\.ts$|049-member-templates\.ts$/.test(p))&&frozen.some(p=>p.endsWith('049-member-templates.ts')));
check('runtime source unchanged after clean BUILD',execFileSync('git',['diff',freeze,'--','src','package.json','pnpm-lock.yaml'],{cwd:repo,encoding:'utf8'}).trim()==='');
const before={readonly:'dist/desktop/review-r81-v19-before-4-20261013/result.json',target:'dist/desktop/review-r81-v20-stage1-20261013/result.json',bootstrap:'dist/desktop/review-r81-v20-faults-stage1-20261013/result.json',postread:'dist/desktop/review-r81-v20-postread-before-20261013/result.json',navigation:'dist/desktop/review-r81-v20-navigation-before-20261013/result.json',reference:'dist/r81-codex-reference-before-2/result.json'};
check('all original product counterexamples retained, not overwritten by final pass',read(before.readonly).pass===true&&read(before.target).pass===false&&read(before.bootstrap).pass===false&&read(before.postread).pass===false&&read(before.navigation).pass===false&&read(before.reference).pass===false&&read(before.reference).ignoredReference===true);
const pictures=[];
for(const v of data.visual.views){for(const screen of ['members','edit','templates','template-edit','create','save-template']){const rel=`dist/desktop/review-r81-v20-visual-release-3-20261013/${screen}-${v.name}.png`;const buf=readFileSync(join(repo,rel));const width=buf.readUInt32BE(16),height=buf.readUInt32BE(20);pictures.push({path:rel,sha256:sha(join(repo,rel)),width,height,expected:[v.width*v.dpr,v.height*v.dpr]});}}
check('18 settled final member/form/template screenshots use declared viewport/dpr',pictures.length===18&&pictures.every(p=>p.width===p.expected[0]&&p.height===p.expected[1]));
const visualReview=read('docs/implementation/r81-visual-review-20261013.json');
check('manual visual review of settled paired frames and operation/error layouts',visualReview.pass===true&&visualReview.buildId===build.buildId&&visualReview.viewportChecks.length===3&&visualReview.viewportChecks.every(v=>v.pass));
const result={pass:checks.every(c=>c.pass),baseline:'56a8b87462a6309825a96ffb0592cc769cb41bbf',runtimeSource:freeze,build,requiredChecks:checks,manifests,previousPackage:oldPackage,evidence:Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,{path:p,sha256:sha(join(repo,p))}])),before,views:{theme:'light',browserZoom:1,viewports:data.visual.views,productMemberCount:6,productTemplateCount:3,prototypeMemberCount:6,prototypeTemplateCount:3,visuallyInspected:visualReview.pass,review:visualReview,excludedPrematureModalFrames:'core release edit/create snapshots and prototype second-pass transient animation are not visual gate evidence'},pictures,modelCalls:0,externalGitHub:'excluded; previously retained external failures not recertified',boundaries:['no real model/vision/tool-permission certification','no user original root migration or rollback of post-upgrade new data','no new OS sleep/multiday certification','no template-to-existing-member synchronization','no forged template usage counts or deferred switches']};
writeFileSync(join(repo,'docs/implementation/r81-v20-delivery-20261013.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({pass:result.pass,checks:checks.length,failed:checks.filter(c=>!c.pass),buildId:build.buildId}));if(!result.pass)process.exitCode=1;
