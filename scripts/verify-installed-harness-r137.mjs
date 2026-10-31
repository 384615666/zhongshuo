import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeepSeekHarnessAdapter } from '../src/adapter/deepseekHarness/adapter.ts';
import { spawnManagedBridge, managedBridgeAvailable, disposeAllManagedJobs } from '../src/daemon/managed/bridge.ts';

const area=resolve('dist/r137-real/harness'),project=join(area,'project');mkdirSync(project,{recursive:true});
const marker='R137-'+randomUUID();writeFileSync(join(project,'marker.txt'),marker+'\n');
process.env.ZS_MANAGED_RUNTIME='1';
const availability=managedBridgeAvailable();if(!availability.ok)throw Error('Managed execution unavailable: '+availability.reason);
const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const adapter=new DeepSeekHarnessAdapter({cwd:project,model:option('--model'),effort:option('--effort'),spawnFn:(command,args,cwd,env)=>spawnManagedBridge(command,args,{cwd,env})});
const report={metadata:null,realTurns:0,turns:[],markerVerified:false,coldResumeVerified:false};
const open=(resume)=>({projectId:'r137-isolated',memberId:'harness-test',taskId:'r137',threadId:'r137',sessionGeneration:resume?1:0,cwd:project,
  policyId:'policy-full-access',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'r137-test'},...(resume?{resume}:{})});
async function run(session,prompt){
  const turnId=randomUUID();const events=[];let timer;
  try{
    report.realTurns++;
    await adapter.startTurn(session,{turnId,dispatchKey:turnId,inputBundleId:turnId,text:prompt,policyId:'policy-full-access',taskRevision:0});
    const iterator=adapter.events(session)[Symbol.asyncIterator]();
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Harness real test deadline')),90000);});
    let result;
    for(;;){const next=await Promise.race([iterator.next(),deadline]);if(next.done)break;const event=next.value;events.push(event);
      if(event.kind==='turn.completed'||event.kind==='turn.failed'||event.kind==='process.exited'){result=event;break;}}
    const exit=await adapter.waitForTurnExit(session,turnId,5000);await adapter.close(session);
    const evidence={turnId,success:result?.kind==='turn.completed',sessionId:session.providerSessionId,result:result?.kind==='turn.completed'?result.finalText:result,
      toolActions:events.filter(e=>e.kind==='tool.started').map(e=>({tool:e.toolName,action:e.action,target:e.target})),
      usage:events.filter(e=>e.kind==='usage.updated').map(e=>({model:e.model,inputTokens:e.inputTokens,cachedTokens:e.cachedTokens,outputTokens:e.outputTokens,cost:e.cost,costQuality:e.costQuality})),exit};
    report.turns.push(evidence);return evidence;
  }finally{clearTimeout(timer);}
}
try{
  const probe=await adapter.probe();const models=await adapter.listModels();report.metadata={version:probe.version,models:models.map(model=>({id:model.id,efforts:model.efforts}))};
  writeFileSync(join(area,'metadata.json'),JSON.stringify(report.metadata,null,2));
  console.log(JSON.stringify({stage:'metadata',...report.metadata}));
  if(process.argv.includes('--run-real')){
    const first=await adapter.openSession(open());const result=await run(first,'这是独立的本机接入测试。请只用文件读取工具读取当前工作目录 marker.txt，不执行命令、不修改文件、不读取其他目录。回复恰好一行：MARKER: 加文件中的标记。');
    report.markerVerified=result.success&&result.result.includes(marker)&&result.toolActions.some(t=>t.action==='read');
    console.log(JSON.stringify({stage:'first-turn',success:result.success,markerVerified:report.markerVerified,usage:result.usage,exit:result.exit}));
    if(report.markerVerified&&!process.argv.includes('--single')){
      const resumed=await adapter.openSession(open(first));const followup=await run(resumed,'不要再读取文件，也不调用任何工具。只复述上一轮文件中的标记，仍回复一行 MARKER: 加标记。');
      report.coldResumeVerified=followup.success&&followup.result.includes(marker)&&resumed.providerSessionId===first.providerSessionId;
      console.log(JSON.stringify({stage:'cold-resume',success:followup.success,coldResumeVerified:report.coldResumeVerified,usage:followup.usage,exit:followup.exit}));
    }
  }
}catch(error){report.error=String(error);console.log(JSON.stringify({stage:'error',error:String(error)}));process.exitCode=1;}
finally{
  await adapter.disposeAll();disposeAllManagedJobs();writeFileSync(join(area,process.argv.includes('--single')?'selected-model-report.json':'report.json'),JSON.stringify(report,null,2));
  if(process.argv.includes('--run-real')&&(!report.markerVerified||!process.argv.includes('--single')&&!report.coldResumeVerified))process.exitCode=1;
}
