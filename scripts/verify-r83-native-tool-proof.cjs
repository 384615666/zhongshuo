/* global require,process,console */
/* eslint-disable @typescript-eslint/no-require-imports -- read only transcripts for exact engineering session IDs */
const fs=require('node:fs'),path=require('node:path'),{homedir}=require('node:os'),{createHash}=require('node:crypto');
const out=path.resolve(process.argv[2]),main=JSON.parse(fs.readFileSync(path.join(out,'progress.json'),'utf8'));
const db=new(require('better-sqlite3'))(path.join(main.dataRoot,'state.sqlite'),{readonly:true});
const facts={pass:false,build:main.build,sessions:[]};
try{
  const sessions=db.prepare('SELECT id,provider_session_id,capabilities_json FROM runtime_sessions WHERE task_id=? ORDER BY rowid').all(main.ids.workTaskId);
  const base=path.join(process.env.CLAUDE_CONFIG_DIR??path.join(homedir(),'.claude'),'projects');
  for(const s of sessions){
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(s.provider_session_id??''))continue;
    let file;for(const dir of fs.readdirSync(base,{withFileTypes:true})){if(!dir.isDirectory())continue;const candidate=path.join(base,dir.name,s.provider_session_id+'.jsonl');if(fs.existsSync(candidate)){if(file)throw Error('ambiguous own session');file=candidate;}}
    if(!file)throw Error('own native transcript unavailable');
    const raw=fs.readFileSync(file,'utf8'),rows=raw.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    const calls=[];for(const row of rows){for(const item of row.message?.content??[]){if(item.type==='tool_use'&&['Bash','Write','Edit','Read'].includes(item.name))calls.push({id:item.id,name:item.name,input:item.input});}}
    const results=rows.flatMap(row=>Array.isArray(row.message?.content)?row.message.content.filter(item=>item.type==='tool_result'&&calls.some(c=>c.id===item.tool_use_id)).map(item=>({toolCallId:item.tool_use_id,error:item.is_error===true,content:item.content})):[]);
    facts.sessions.push({sessionId:s.id,providerSessionId:s.provider_session_id,transcriptHash:createHash('sha256').update(raw).digest('hex'),runtime:JSON.parse(s.capabilities_json),calls,results});
  }
  if(facts.sessions.length<2)throw Error('v1/v2 exact native sessions missing');
  const bash=facts.sessions.flatMap(s=>s.calls.filter(c=>c.name==='Bash'));
  if(!bash.some(c=>/node\s+(?:--test\s+)?math\.test\.mjs/.test(c.input.command??'')))throw Error('actual model test command missing');
  if(!facts.sessions.flatMap(s=>s.results).some(r=>!r.error&&/pass|通过/i.test(typeof r.content==='string'?r.content:JSON.stringify(r.content))))throw Error('actual native stdout success missing');
  facts.pass=true;
}catch(e){facts.error=e.stack;process.exitCode=1;}finally{db.close();fs.writeFileSync(path.join(out,'native-tool-proof.json'),JSON.stringify(facts,null,2));console.log(JSON.stringify({pass:facts.pass,sessions:facts.sessions.length,error:facts.error}));}
