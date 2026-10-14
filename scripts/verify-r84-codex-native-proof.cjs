/* global require,process,console */
/* eslint-disable @typescript-eslint/no-require-imports -- read only exact engineering provider transcripts */
const fs=require('node:fs'),path=require('node:path'),{homedir}=require('node:os'),{createHash}=require('node:crypto'),Database=require('better-sqlite3');
const out=path.resolve(process.argv[2]),main=JSON.parse(fs.readFileSync(path.join(out,'progress.json'),'utf8')),db=new Database(path.join(main.dataRoot,'state.sqlite'),{readonly:true});
const result={pass:false,build:main.build,sessions:[],responseModel:'not reported; configured/context model is not an upstream response field'};
const hash=s=>createHash('sha256').update(s).digest('hex');
try{
  const sessions=db.prepare('select id,provider_session_id,cwd from runtime_sessions where task_id=? order by rowid').all(main.ids.workTaskId);
  const base=path.join(process.env.CODEX_HOME??path.join(homedir(),'.codex'),'sessions');
  const files=[];let inspected=0;
  function scan(dir,depth){if(depth>8)throw Error('bounded session search depth exceeded');for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(++inspected>20000)throw Error('bounded session filename search exceeded');const p=path.join(dir,e.name);if(e.isDirectory())scan(p,depth+1);else if(e.isFile()&&sessions.some(s=>e.name.endsWith(s.provider_session_id+'.jsonl')))files.push(p);}}
  scan(base,0);
  for(const session of sessions){
    if(!/^[a-f0-9-]{36}$/i.test(session.provider_session_id??''))throw Error('unexpected own provider ID');
    const matches=files.filter(f=>path.basename(f).endsWith(session.provider_session_id+'.jsonl'));if(matches.length!==1)throw Error('exact own transcript missing/ambiguous');
    const raw=fs.readFileSync(matches[0],'utf8'),rows=raw.trim().split(/\r?\n/).map(l=>JSON.parse(l));
    const meta=rows.find(r=>r.type==='session_meta')?.payload;if(meta?.id!==session.provider_session_id||path.resolve(meta.cwd)!==path.resolve(main.project))throw Error('provider identity/cwd differs from owned project');
    const contexts=rows.filter(r=>r.type==='turn_context').map(r=>({model:r.payload.model,effort:r.payload.effort,cwd:r.payload.cwd,approvalPolicy:r.payload.approval_policy,sandboxPolicy:r.payload.sandbox_policy}));
    const calls=rows.filter(r=>r.type==='response_item'&&['function_call','custom_tool_call'].includes(r.payload.type)).map(r=>{const rawArgs=r.payload.arguments??r.payload.input??'';let args;try{args=JSON.parse(rawArgs);}catch{args={};}return{id:r.payload.call_id,name:r.payload.name,command:args.cmd??args.command??null,cwd:args.workdir??null,argumentsHash:hash(rawArgs)};});
    const outputs=rows.filter(r=>r.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(r.payload.type)).map(r=>{const body=typeof r.payload.output==='string'?r.payload.output:JSON.stringify(r.payload.output);return{callId:r.payload.call_id,hash:hash(body),exit0:/Process exited with code 0|Exit code: 0|exit_code["\s]*:\s*0/.test(body),testSuccess:/tests?\s+(?:passed|\d+)|pass\s+\d+|通过/i.test(body)};});
    const completed=rows.filter(r=>r.type==='event_msg'&&r.payload?.type==='item_completed'&&['CommandExecution','FileChange'].includes(r.payload.item?.type)).map(r=>{const item=r.payload.item,output=String(item.aggregated_output??item.stdout??'');return{type:item.type,command:Array.isArray(item.command)?item.command.join(' '):item.command??null,cwd:item.cwd??null,status:item.status,exitCode:item.exit_code,outputSha256:hash(output),testSuccess:/pass\s+\d+|tests?\s+\d+|通过/i.test(output)};});
    result.sessions.push({sessionId:session.id,providerSessionId:session.provider_session_id,transcriptSha256:hash(raw),provider:meta.model_provider,contexts,calls,outputs,completed});
  }
  if(result.sessions.length<2)throw Error('actual v1/v2 sessions missing');
  if(!result.sessions.every(s=>s.contexts.some(c=>c.model===main.runtimeTarget.model&&c.effort===main.runtimeTarget.effort&&path.resolve(c.cwd)===path.resolve(main.project))))throw Error('provider recorded request context mismatch');
  if(!result.sessions.every(s=>s.completed.some(c=>c.type==='CommandExecution'&&/node\s+(?:--test|math\.test\.mjs)/.test(c.command??'')&&c.status==='completed'&&c.exitCode===0&&c.testSuccess)))throw Error('v1/v2 actual native test command/stdout/exit proof missing');result.pass=true;
}catch(e){result.error=e.stack;process.exitCode=1;}finally{db.close();fs.writeFileSync(path.join(out,'codex-native-proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,sessions:result.sessions.length,error:result.error}));}
