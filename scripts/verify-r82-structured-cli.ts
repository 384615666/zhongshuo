import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClaudeCliAdapter} from '../src/adapter/claude/cliAdapter.ts';
const root=resolve(process.argv[2]);if(existsSync(root))throw Error('fresh root required');mkdirSync(root,{recursive:true});
const a=new ClaudeCliAdapter({model:'glm-5.3-flash',permissionMode:'plan'}),id=randomUUID();
const s=await a.openSession({projectId:'engineering',memberId:'engineering',taskId:id,threadId:id,cwd:root,sessionGeneration:0,policyId:'policy-analyze'});
const events=[];const timer=setTimeout(()=>{void a.interrupt(s,id);},300000);
try{await a.startTurn(s,{turnId:id,dispatchKey:id,inputBundleId:id,text:'独立工程结构化输出测试：只读、不要创建或修改任何文件。回答2+2的结果。',policyId:'policy-analyze',taskRevision:0,outputSchema:{type:'object',additionalProperties:false,required:['answer'],properties:{answer:{type:'integer',const:4}}}});for await(const e of a.events(s)){events.push(e);if(e.kind==='turn.completed'||e.kind==='turn.failed')break;}}
finally{clearTimeout(timer);await a.waitForTurnExit(s,id,5000);await a.close(s);await a.disposeAll();}
writeFileSync(root+'/events.json',JSON.stringify(events,null,2));const final=events.find(e=>e.kind==='turn.completed');const result={pass:final?.kind==='turn.completed'&&final.structuredResult!=null&&JSON.parse(final.finalText??'{}').answer===4,realCallsRequested:1,model:'glm-5.3-flash',purpose:'native JSON schema support, zero file writes',final};writeFileSync(root+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
