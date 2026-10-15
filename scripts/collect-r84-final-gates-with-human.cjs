/* global require,module,process,console,__dirname,__filename */
/* eslint-disable @typescript-eslint/no-require-imports -- offline release evidence, no business dispatch */
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const sourceThread='01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79';
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function validManualDrag(proof,build,manifestHash){
 return proof?.schemaVersion===1&&proof.authority==='human'&&proof.method==='manual'&&proof.scope==='native-titlebar-mouse-drag-only'&&proof.outcome==='passed'&&proof.buildId===build.buildId&&proof.runtimeCommit===build.commit&&proof.candidate==='desktop-daily-win-v23-rc6'&&proof.manifestSha256===manifestHash&&proof.sourceThread===sourceThread&&proof.sourceRole==='user'&&typeof proof.sourceUserMessageId==='string'&&proof.sourceUserMessageId.length>0&&typeof proof.sourceTurnId==='string'&&proof.sourceTurnId.length>0&&proof.response==='能正常移动'&&proof.confirmedDate==='2026-10-15'&&proof.timezone==='Asia/Shanghai';
}
function validPristineDelivery(receipt,build,manifestHash){
 return receipt?.corePass===true&&receipt.build?.buildId===build.buildId&&receipt.build?.commit===build.commit&&receipt.manifests?.candidate?.sha256===manifestHash&&Array.isArray(receipt.gates)&&receipt.gates.some(g=>g.name==='distribution has no data root or fake fixture'&&g.pass===true);
}
function main(){
 const args=process.argv.slice(2),[candidate,,,,,,,,manualFile,output]=args;
 if(args.length!==10)throw Error('usage: original 8 collector arguments, then manualEvidence and newOutput; original output is retained separately');
 const original=spawnSync(process.execPath,[path.join(__dirname,'collect-r84-final-gates.cjs'),...args.slice(0,8)],{encoding:'utf8',windowsHide:true});
 const originalResult=JSON.parse(fs.readFileSync(args[7],'utf8'));
 const proof=JSON.parse(fs.readFileSync(manualFile,'utf8'));
 const automatedLeaf='native titlebar mouse movement verified',originalDrag=originalResult.gates.find(g=>g.name===automatedLeaf);
 const tests=spawnSync(process.execPath,[path.join(__dirname,'verify-r84-manual-drag-evidence.cjs')],{encoding:'utf8',windowsHide:true});
 const manifestHash=sha(path.join(path.resolve(candidate),'ZhongshuoDual/MANIFEST-SHA256.json'));
 const manualPassed=validManualDrag(proof,originalResult.build,manifestHash);
 const pristineFile=path.resolve('docs/implementation/evidence-r84-v23-20261015/final-gates.json'),pristine=JSON.parse(fs.readFileSync(pristineFile,'utf8'));
 const distributionLeaf='distribution has no data root or fake fixture';
 const archived=JSON.parse(fs.readFileSync(path.join(path.dirname(pristineFile),'MANIFEST-SHA256.json'),'utf8'));
 const pristineSameBuild=validPristineDelivery(pristine,originalResult.build,manifestHash)&&archived.files.find(f=>f.path==='final-gates.json')?.sha256===sha(pristineFile);
 const noSeed=!fs.existsSync(path.join(candidate,'seed'))&&!fs.existsSync(path.join(candidate,'server-data/engineering-r78.json'));
 const coreGates=originalResult.gates.filter(g=>g.name!==automatedLeaf&&g.name!==distributionLeaf);
 const gates=coreGates.concat([
  {name:'pristine delivery before user first-use verified; current user data preserved',pass:pristineSameBuild&&noSeed&&manualPassed},
  {name:'original automated gate result retained and understood',pass:originalDrag?.pass===false&&original.status===1&&originalResult.gates.filter(g=>!g.pass).every(g=>g.name===automatedLeaf||g.name===distributionLeaf)},
  {name:'manual evidence identity and negative contracts',pass:tests.status===0},
  {name:'native titlebar mouse movement confirmed by human on this BUILD',pass:manualPassed}
 ]);
 const result={...originalResult,pass:gates.every(g=>g.pass),corePass:coreGates.every(g=>g.pass)&&pristineSameBuild&&noSeed,gates,evidence:originalResult.evidence.concat([{path:path.relative(process.cwd(),manualFile),sha256:sha(manualFile)},{path:path.relative(process.cwd(),args[7]),sha256:sha(args[7])},{path:path.relative(process.cwd(),pristineFile),sha256:sha(pristineFile)}]),distributionLifecycle:{pristineDelivery:pristineSameBuild,currentDataRootExists:fs.existsSync(path.join(candidate,'server-data')),userDataUntouched:true,noSeed,scope:'Current data-root existence after the human launched this candidate is not a bundled-data failure. Original pre-use proof and current program hashes are both required.'},priorAutomatedResult:{path:path.relative(process.cwd(),args[7]),sha256:sha(args[7]),pass:originalResult.pass,exitCode:original.status,nativeTitlebarDrag:originalDrag},manualConfirmations:{nativeTitlebarDrag:{accepted:manualPassed,authority:proof.authority,method:proof.method,sourceThread:proof.sourceThread,sourceUserMessageId:proof.sourceUserMessageId,scope:proof.scope,response:proof.response,buildId:proof.buildId}},evidenceContractTests:{exitCode:tests.status,output:tests.stdout,collectorSha256:sha(__filename),testSha256:sha(path.join(__dirname,'verify-r84-manual-drag-evidence.cjs'))},unverified:originalResult.unverified.filter(s=>s!=='native titlebar mouse movement').concat(['automated native titlebar mouse displacement remains unverified; functional movement is human-confirmed']),userAcceptance:'pending',userAcceptanceScope:'Only titlebar dragging was manually confirmed; no overall daily-workflow or all-model/tool user acceptance inferred'};
 fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,corePass:result.corePass,manualDrag:manualPassed,userAcceptance:result.userAcceptance,failed:gates.filter(g=>!g.pass)}));if(!result.pass)process.exitCode=1;
}
module.exports={validManualDrag,validPristineDelivery};if(require.main===module)main();
