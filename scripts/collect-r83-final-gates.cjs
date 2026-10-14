/* global require,process,console */
/* eslint-disable @typescript-eslint/no-require-imports -- offline, read-only acceptance evidence collector */
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const [rootArg,workflowArg,unknownArg,projectArg]=process.argv.slice(2);
if(!projectArg)throw Error('usage: node collect-r83-final-gates.cjs acceptance workflow unknown project-regression');
const root=path.resolve(rootArg),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const main=read(path.join(root,'progress.json')),build=main.build,gates=[],evidence=[];
function gate(name,pass){gates.push({name,pass:pass===true});}
function receipt(file,expectedBuild=true){const data=read(file);evidence.push({path:path.relative(process.cwd(),file),sha256:hash(file)});if(expectedBuild)gate('BUILD '+path.basename(file),(data.build?.buildId??data.buildId)===build.buildId);return data;}
function manifest(dir){const base=path.join(dir,'ZhongshuoDual'),m=read(path.join(base,'MANIFEST-SHA256.json'));let bytes=0;for(const item of m.files){const target=path.resolve(base,item.path);if(!target.startsWith(base+path.sep))throw Error('manifest escapes program');if(fs.statSync(target).size!==item.bytes||hash(target)!==item.sha256)throw Error('manifest mismatch '+item.path);bytes+=item.bytes;}gate('manifest BUILD '+dir,m.buildId===build.buildId);return{files:m.files.length,bytes,sha256:hash(path.join(base,'MANIFEST-SHA256.json'))};}
const close=receipt(path.join(root,'closeout.json')),native=receipt(path.join(root,'native-ui.json')),ui=receipt(path.join(root,'readonly-ui.json')),tools=receipt(path.join(root,'native-tool-proof.json'),false),visual=receipt(path.join(root,'visual-review.json'));
gate('clean source BUILD',build.dirty===false);
gate('natural questions and image bytes',main.imageFunctionalPass&&main.workflowFunctionalPass);
gate('eight original successful real calls',close.pass&&close.calls.length===8&&close.calls.every(c=>c.status==='succeeded'&&c.runtime_kind==='claude'&&c.model==='glm-5.3-flash'));
gate('native menus and window controls',native.pass&&native.actions.length===8&&native.actions.every(a=>a.pass));
gate('cold attachment / room shortcut / truthful permissions',ui.pass&&ui.attachmentSamples.length>=4);
gate('real native tool results',tools.pass);
gate('paired visual inspection',visual.pass);
for(const [name,file,same] of [['formal fake workflow',workflowArg,true],['unknown original envelope',unknownArg,true],['project cancellation/cross-open',projectArg,false]]){const r=receipt(path.resolve(file),same);gate(name,r.pass);}
const manifests={distribution:manifest(main.source),actualCopy:manifest(main.copy)};
gate('same actual launcher',hash(path.join(main.source,'start-desktop.bat'))===hash(path.join(main.copy,'start-desktop.bat')));
gate('no engineering data in distribution',!fs.existsSync(path.join(main.source,'server-data')));
const source=receipt(path.resolve('dist/r83-source-check-receipt.json'),false),lint=receipt(path.resolve('dist/r83-delivery-lint.json'),false);
gate('both source typechecks',source.typecheck.exitCode===0&&source.typecheckHifi.exitCode===0);
gate('incremental lint no new errors',lint.pass);
const testLog=path.resolve('dist/r83-rc6-all-tests.log');evidence.push({path:path.relative(process.cwd(),testLog),sha256:hash(testLog)});
gate('deterministic source suite',/Test Files\s+146 passed \(146\)/.test(fs.readFileSync(testLog,'utf8'))&&/Tests\s+1027 passed \(1027\)/.test(fs.readFileSync(testLog,'utf8')));
const corePass=gates.every(g=>g.pass);
// A missing OS movement observation must not be promoted to a passed release gate.
gate('native titlebar movement verified',native.dragVerification?.status==='passed');
const result={pass:gates.every(g=>g.pass),corePass,build,gates,manifests,evidence,unverified:[...(native.dragVerification?.status!=='passed'?['native titlebar movement']:[]),'Codex real inference','third-party effective reasoning intensity','all native tools / all models'],userAcceptance:'pending'};
fs.writeFileSync(path.join(root,'final-gates.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,corePass,failed:gates.filter(g=>!g.pass)}));if(!result.pass)process.exitCode=1;
