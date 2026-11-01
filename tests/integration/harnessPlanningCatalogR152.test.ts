import {afterEach,describe,expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeepSeekHarnessAdapter} from '../../src/adapter/deepseekHarness/adapter.ts';
import type {NormalizedRuntimeEvent,OpenSessionInput,SessionRef,TurnRequest} from '../../src/contracts/runtime.ts';

const roots:string[]=[],adapters:DeepSeekHarnessAdapter[]=[];
const dir=()=>{const root=mkdtempSync(join(tmpdir(),'zs-r152-dsh-'));roots.push(root);return root;};
const fixture=fileURLToPath(new URL('../fixtures/harnessPlanningR152.mjs',import.meta.url));
const input=(cwd:string):OpenSessionInput=>({projectId:'p',memberId:'self',taskId:'t',threadId:'th',sessionGeneration:0,cwd,policyId:'full'});
const turn:TurnRequest={turnId:'turn',dispatchKey:'d',inputBundleId:'b',text:'Plan first',policyId:'full',taskRevision:0,stage:'coordination.planning',outputSchema:{type:'object'}};
function adapter(scenario='success'){
  const a=new DeepSeekHarnessAdapter({executable:process.execPath,spawnFn:(_command,args,cwd)=>spawn(process.execPath,[fixture,scenario,...args],{cwd,stdio:'pipe',windowsHide:true})});adapters.push(a);return a;
}
async function terminal(a:DeepSeekHarnessAdapter,s:SessionRef){
  const all:NormalizedRuntimeEvent[]=[];
  for await(const event of a.events(s)){all.push(event);if(event.kind==='turn.failed'||event.kind==='turn.completed')return all;}
  throw Error('Missing terminal');
}
afterEach(async()=>{for(const a of adapters.splice(0))await a.disposeAll();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

describe('R152 Harness planning and actionable metadata',()=>{
  it('uses genuine planning mode on a fresh tool-free session without repairOnly',async()=>{
    const a=adapter(),s=await a.openSession(input(dir()));await a.startTurn(s,turn);
    const events=await terminal(a,s),done=events.at(-1);
    expect(done?.kind).toBe('turn.completed');
    if(done?.kind==='turn.completed')expect(JSON.parse(done.finalText!)).toMatchObject({mode:'planning',schema:turn.outputSchema});
    expect(events.some(e=>e.kind==='tool.started')).toBe(false);
  });
  it('refuses an old component before model work and does not accept forged tool events',async()=>{
    for(const scenario of ['old','tool']){
      const a=adapter(scenario),s=await a.openSession(input(dir()));await a.startTurn(s,turn);const events=await terminal(a,s);
      expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:scenario==='old'?'CAPABILITY_UNSUPPORTED':'OUTPUT_INVALID'});
      expect(events.some(e=>e.kind==='turn.completed'||e.kind==='tool.started')).toBe(false);
    }
  });
  it('requires fresh text/schema planning and keeps ordinary readonly work unsupported',async()=>{
    const a=adapter(),root=dir(),s=await a.openSession(input(root));
    await expect(a.startTurn(s,{...turn,outputSchema:undefined})).rejects.toMatchObject({notStarted:true});
    await expect(a.startTurn(s,{...turn,repairOnly:true})).rejects.toMatchObject({notStarted:true});
    await expect(a.startTurn(s,{...turn,stage:undefined})).rejects.toMatchObject({code:'CAPABILITY_UNSUPPORTED',notStarted:true});
    const resumed=await a.openSession({...input(root),resume:{...s,providerSessionId:'old'}});
    await expect(a.startTurn(resumed,turn)).rejects.toMatchObject({notStarted:true});
  });
  it('does not mistake a missing project directory for a missing component',async()=>{
    const a=new DeepSeekHarnessAdapter({executable:process.execPath,cwd:join(dir(),'removed-project')});
    await expect(a.listModels()).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND',message:expect.stringContaining('项目目录')});
  });
  it('reads nested provider catalogs without any gateway-specific mapping and maps off to none',async()=>{
    const root=dir(),entry=join(root,'catalog.cjs');
    writeFileSync(entry,`console.log(JSON.stringify({v:1,runtime:'zhongshuo-dsh',type:'models',models:[{id:'vendor/team/model/v1',label:'Model',efforts:['off','high']}]}));`);
    const a=new DeepSeekHarnessAdapter({executable:entry,cwd:root});
    expect(await a.listModels()).toEqual([{id:'vendor/team/model/v1',label:'Model',efforts:['none','high']}]);
  });
  it('reports timeout and generic startup failure without copying provider secrets into errors',async()=>{
    const root=dir(),entry=join(root,'unavailable.cjs');
    writeFileSync(entry,`process.stderr.write('Authorization: Bearer fixture-secret-key\n');process.exit(2);`);
    const a=new DeepSeekHarnessAdapter({executable:entry,cwd:root});
    await expect(a.listModels()).rejects.toMatchObject({message:expect.stringContaining('配置或众说连接组件启动失败')});
    try{await a.listModels();}catch(error){expect(String(error)).not.toContain('fixture-secret-key');}
    writeFileSync(entry,'setInterval(()=>{},1000);');
    const slow=new DeepSeekHarnessAdapter({executable:entry,cwd:root,requestTimeoutMs:100});
    await expect(slow.listModels()).rejects.toMatchObject({message:expect.stringContaining('读取超时')});
  });
});
