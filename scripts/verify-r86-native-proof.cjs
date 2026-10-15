/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,console,__dirname */
/** Read only exact provider sessions belonging to an owned R86 task family.
 * Persists hashes and bounded synthetic command evidence, never raw transcripts. */
const fs=require('node:fs'),path=require('node:path'),{homedir}=require('node:os'),{createHash}=require('node:crypto'),Database=require('better-sqlite3');
const {ownedEvidenceRoot,nativeDelegation,nodeTestCommand,tapPassed,fileRead}=require('./lib/r86-native-evidence.cjs');
const out=path.resolve(process.argv[2]??''),label=process.argv.find(x=>x.startsWith('--label='))?.slice(8)??'v1';
if(!/^[-a-z0-9]+$/.test(label)||!ownedEvidenceRoot(out,path.resolve(__dirname,'../dist')))throw Error('owned root and safe original proof label required');
const main=JSON.parse(fs.readFileSync(path.join(out,'progress.json'),'utf8')),observation=JSON.parse(fs.readFileSync(path.join(out,'real-code-v1.json'),'utf8'));
const taskId=process.argv.find(x=>x.startsWith('--task='))?.slice(7)??observation.root.id,file=path.join(out,`native-proof-${label}.json`);
const deliveryRevision=Number(process.argv.find(x=>x.startsWith('--delivery='))?.slice(11)??1),documentTask=process.argv.includes('--document');
if(fs.existsSync(file))throw Error('original native proof retained; choose a new explicit observation label');
const db=new Database(path.join(main.dataRoot,'state.sqlite'),{readonly:true}),hash=s=>createHash('sha256').update(s).digest('hex');
const result={pass:false,scope:'actual own CLI context/tools/results; configured model is separate from upstream response_model',build:main.build,taskId,sessions:[]};
const testFiles=fs.readdirSync(main.project).filter(name=>/(?:test|spec).*\.(?:mjs|cjs|js)$/i.test(name));
const tests=command=>nodeTestCommand(command,testFiles);
const safeCommand=command=>String(command??'').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').replace(/(?:Bearer\s+)[^\s"']+/gi,'Bearer [redacted]').slice(0,1500);
let scanned=0;
function exactFiles(base,ids){const found=[];const scan=(dir,depth)=>{if(depth>8)throw Error('native filename search depth exceeded');for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(++scanned>24000)throw Error('bounded native filename search exceeded');const p=path.join(dir,entry.name);if(entry.isDirectory())scan(p,depth+1);else if(entry.isFile()&&ids.some(id=>entry.name.endsWith(id+'.jsonl')))found.push(p);}};scan(base,0);return found;}
function readRows(file){if(fs.statSync(file).size>32*1024*1024)throw Error('own transcript exceeds bounded read');const raw=fs.readFileSync(file,'utf8');return {raw,rows:raw.trim().split(/\r?\n/).map(line=>JSON.parse(line))};}
try{
  const delivery=db.prepare('SELECT id,run_id,manifest_hash FROM task_deliveries WHERE task_id=? AND revision=?').get(taskId,deliveryRevision);if(!delivery)throw Error('exact parent delivery missing');
  const plan=db.prepare('SELECT c.run_id FROM coordination_runs c JOIN coordination_integration_attempts i ON i.coordination_run_id=c.run_id WHERE i.execution_run_id=? AND c.task_id=?').get(delivery.run_id,taskId);if(!plan)throw Error('delivery has no original collaboration identity');
  result.delivery={id:delivery.id,revision:deliveryRevision,manifestHash:delivery.manifest_hash,coordinationRunId:plan.run_id};
  const sessions=db.prepare(`SELECT s.id,s.provider_session_id,s.cwd,s.member_id,s.task_id,s.capabilities_json,r.kind,c.model,
      (SELECT role FROM coordination_steps WHERE child_task_id=s.task_id AND run_id=?) role,
      (SELECT json_extract(b.included_refs_json,'$.permission.policyId') FROM context_bundles b JOIN agent_turns a ON a.id=b.turn_id WHERE a.session_id=s.id ORDER BY a.rowid DESC LIMIT 1) input_policy
    FROM runtime_sessions s
    JOIN project_members m ON m.id=s.member_id JOIN agent_profiles p ON p.id=m.profile_id JOIN runtime_installations r ON r.id=p.runtime_installation_id
    JOIN (SELECT id,json_extract(settings_json,'$.model') model FROM agent_profiles) c ON c.id=p.id
    WHERE s.id IN(SELECT a.session_id FROM agent_turns a JOIN workflow_runs w ON w.id=a.run_id
      WHERE w.id=? OR w.id IN(SELECT execution_run_id FROM coordination_integration_attempts WHERE coordination_run_id=?)
      OR w.task_id IN(SELECT child_task_id FROM coordination_steps WHERE run_id=?)) ORDER BY s.rowid`).all(plan.run_id,plan.run_id,plan.run_id,plan.run_id);
  if(!sessions.length)throw Error('actual task sessions missing');
  for(const session of sessions){
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(session.provider_session_id??''))throw Error('actual provider identity missing');
    const snapshot=JSON.parse(session.capabilities_json??'{}');if(!snapshot.runtime?.model||!snapshot.runtime?.kind)throw Error('actual dispatch runtime snapshot missing');
    session.currentConfiguredModel=session.model;session.kind=snapshot.runtime.kind;session.model=snapshot.runtime.model;
    session.actualRuntimeSnapshot={runtime:{kind:snapshot.runtime.kind,model:snapshot.runtime.model,permissionMode:snapshot.runtime.permissionMode,effort:snapshot.runtime.effort,installationId:snapshot.runtime.installationId},writeIdentity:snapshot.writeIdentity,effectivePolicy:snapshot.effectivePolicy??session.input_policy??null,effortVerification:snapshot.effortVerification,executablePathHash:hash(String(snapshot.runtime.executable??''))};
  }
  const grouped=new Map();for(const session of sessions){if(!grouped.has(session.kind))grouped.set(session.kind,[]);grouped.get(session.kind).push(session);}
  for(const [kind,group] of grouped){
    const base=kind==='claude'?path.join(process.env.CLAUDE_CONFIG_DIR??path.join(homedir(),'.claude'),'projects'):path.join(process.env.CODEX_HOME??path.join(homedir(),'.codex'),'sessions');
    const files=exactFiles(base,group.map(s=>s.provider_session_id));
    for(const session of group){
      if(path.resolve(session.cwd)!==path.resolve(main.project))throw Error('native session cwd not the owned project');
      const matches=files.filter(file=>path.basename(file).endsWith(session.provider_session_id+'.jsonl'));if(matches.length!==1)throw Error('exact own transcript missing or ambiguous');
      const {raw,rows}=readRows(matches[0]);
      const proof={sessionId:session.id,providerSessionId:session.provider_session_id,memberId:session.member_id,taskId:session.task_id,role:session.role??'coordinator',kind,configuredModel:session.model,currentConfiguredModel:session.currentConfiguredModel,actualRuntimeSnapshot:session.actualRuntimeSnapshot,transcriptSha256:hash(raw),testCommands:[],readCommands:[],writeActions:[],tools:[],nativeDelegationObserved:false};
      const handoff=JSON.parse(db.prepare('SELECT handoff_json FROM coordination_steps WHERE child_task_id=? AND run_id=?').get(session.task_id,plan.run_id)?.handoff_json??'{}');
      const frozenFiles=(handoff.upstream??[]).flatMap(delivery=>(delivery.files??[]).filter(f=>f.state==='present').map(f=>({...f,deliveryId:delivery.id,revision:delivery.revision,manifestHash:delivery.manifest_hash})));
      const readableFiles=frozenFiles.flatMap(f=>{const target=path.resolve(main.project,f.path);if(!target.startsWith(path.resolve(main.project)+path.sep)||!fs.existsSync(target)||fs.statSync(target).size>1024*1024)return [];const bytes=fs.readFileSync(target);return hash(bytes)===f.sha256?[{...f,content:bytes.toString('utf8')}]:[];});
      proof.expectedInputFiles=frozenFiles.map(({path,sha256,deliveryId,revision,manifestHash})=>({path,sha256,deliveryId,revision,manifestHash}));
      if(kind==='claude'){
        proof.responseModels=[...new Set(rows.filter(r=>r.type==='assistant').map(r=>r.message?.model).filter(Boolean))];
        proof.modelEvidence=proof.responseModels.length?'actual dispatch plus provider-reported response model':'actual dispatch requested model; upstream response_model unreported';
        const content=rows.flatMap(r=>Array.isArray(r.message?.content)?r.message.content:[]),tools=content.filter(x=>x.type==='tool_use');proof.tools=tools.map(t=>t.name);
        const outputs=content.filter(x=>x.type==='tool_result');
        for(const tool of tools){const command=tool.input?.command??tool.input?.cmd??'';const output=outputs.find(x=>x.tool_use_id===tool.id),body=typeof output?.content==='string'?output.content:JSON.stringify(output?.content??'');
          if(tests(command))proof.testCommands.push({id:tool.id,command:safeCommand(command),success:output!=null&&output.is_error!==true&&tapPassed(body),exitEvidence:'CLI tool success plus TAP tests/pass/fail; no independent exit field',outputSha256:hash(body)});
          if(tool.name==='Read')proof.readCommands.push({id:tool.id,path:safeCommand(tool.input?.file_path??tool.input?.path),matchedInputFiles:fileRead(tool.input?.file_path??tool.input?.path,body.replace(/^\s*\d+[→\t|] ?/gm,''),readableFiles),success:output!=null&&output.is_error!==true,outputSha256:hash(body)});
          if(['Write','Edit','MultiEdit'].includes(tool.name))proof.writeActions.push({id:tool.id,name:tool.name,success:output!=null&&output.is_error!==true,outputSha256:hash(body)});
        }
      }else if(kind==='codex'){
        const meta=rows.find(r=>r.type==='session_meta')?.payload;if(meta?.id!==session.provider_session_id||path.resolve(meta.cwd)!==path.resolve(main.project))throw Error('Codex provider identity/cwd mismatch');
        proof.provider=meta.model_provider;
        proof.contexts=rows.filter(r=>r.type==='turn_context').map(r=>({model:r.payload.model,effort:r.payload.effort,cwd:r.payload.cwd,sandboxPolicy:r.payload.sandbox_policy}));
        if(!proof.contexts.some(x=>x.model===session.model))throw Error('actual Codex turn model context mismatch');
        const toolRows=rows.filter(r=>r.type==='response_item'&&['function_call','custom_tool_call'].includes(r.payload.type));proof.tools=toolRows.map(r=>r.payload.name);
        const completed=rows.filter(r=>r.type==='event_msg'&&r.payload?.type==='item_completed'&&r.payload.item?.type==='CommandExecution');
        for(const row of completed){const item=row.payload.item,command=Array.isArray(item.command)?item.command.join(' '):String(item.command??''),output=String(item.aggregated_output??item.stdout??'');
          const evidence={id:item.id??null,command:safeCommand(command),status:item.status,exitCode:item.exit_code,success:item.status==='completed'&&item.exit_code===0,outputSha256:hash(output),testSummary:tapPassed(output),matchedInputFiles:fileRead(command,output,readableFiles)};
          if(tests(command))proof.testCommands.push({...evidence,success:evidence.success&&evidence.testSummary});
          if(/Get-Content|\bcat\b|\brg\b|\btype\b/i.test(command))proof.readCommands.push(evidence);
        }
      }else throw Error('unexpected real provider kind');
      proof.nativeDelegationObserved=proof.tools.some(nativeDelegation);
      result.sessions.push(proof);
    }
  }
  const models=new Set(result.sessions.map(s=>`${s.kind}/${s.configuredModel}`));
  if(!models.has('claude/glm-5.3-flash')||!models.has('codex/gpt-6.1-sol'))throw Error('same task family distinct native model contexts missing');
  if(result.sessions.some(s=>s.nativeDelegationObserved))throw Error('untracked native delegation observed; not counted as bounded formal collaboration');
  const implementers=result.sessions.filter(s=>s.role==='implementation'),reviewers=result.sessions.filter(s=>s.role==='review');
  if(!documentTask&&!implementers.some(s=>s.testCommands.some(c=>c.success)))throw Error('this delivery implementer native successful Node test evidence missing');
  if(documentTask&&!implementers.some(s=>s.writeActions.some(c=>c.success)||s.tools.some(t=>/apply_patch|fileChange/i.test(t??''))))throw Error('this document delivery actual write evidence missing');
  if(!reviewers.some(s=>s.readCommands.some(c=>c.success&&c.matchedInputFiles?.length)&&implementers.some(impl=>`${impl.kind}/${impl.configuredModel}`!==`${s.kind}/${s.configuredModel}`)))throw Error('actual independent different-model reviewer file read evidence missing');
  result.pass=true;
}catch(error){result.error=error.stack;process.exitCode=1;}
finally{db.close();fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,sessions:result.sessions.length,error:result.error}));}
