/* global require,console */
/* eslint-disable @typescript-eslint/no-require-imports -- deterministic offline release-evidence contracts */
const assert=require('node:assert/strict'),{validManualDrag,validPristineDelivery}=require('./collect-r84-final-gates-with-human.cjs');
const build={buildId:'bld_fixture',commit:'fixture-commit'},hash='fixture-manifest';
const proof={schemaVersion:1,authority:'human',method:'manual',scope:'native-titlebar-mouse-drag-only',outcome:'passed',buildId:build.buildId,runtimeCommit:build.commit,candidate:'desktop-daily-win-v23-rc6',manifestSha256:hash,sourceThread:'01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79',sourceRole:'user',sourceUserMessageId:'fixture-user-message',sourceTurnId:'fixture-turn',response:'能正常移动',confirmedDate:'2026-10-15',timezone:'Asia/Shanghai'};
assert.equal(validManualDrag(proof,build,hash),true);
let cases=1;
for(const [field,value]of Object.entries({schemaVersion:2,authority:'agent',method:'automated',scope:'all-daily-workflows',outcome:'unverified',buildId:'other-build',runtimeCommit:'other-commit',candidate:'old-candidate',manifestSha256:'other-bytes',sourceThread:'other-thread',sourceRole:'assistant',sourceUserMessageId:'',sourceTurnId:'',response:'暂时未测试',confirmedDate:'2026-10-14',timezone:'UTC'})){assert.equal(validManualDrag({...proof,[field]:value},build,hash),false,field);cases++;}
assert.equal(validManualDrag(null,build,hash),false);cases++;
const pristine={corePass:true,build,manifests:{candidate:{sha256:hash}},gates:[{name:'distribution has no data root or fake fixture',pass:true}]};
assert.equal(validPristineDelivery(pristine,build,hash),true);cases++;
for(const changed of [null,{...pristine,corePass:false},{...pristine,build:{...build,buildId:'different'}},{...pristine,build:{...build,commit:'different'}},{...pristine,manifests:{candidate:{sha256:'different'}}},{...pristine,gates:[]},{...pristine,gates:[{name:'distribution has no data root or fake fixture',pass:false}]}]){assert.equal(validPristineDelivery(changed,build,hash),false);cases++;}
console.log(JSON.stringify({pass:true,cases,scope:'manual evidence provenance/build/scope rejects; no model calls or product writes'}));
