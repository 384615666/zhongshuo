/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,console,__dirname */
const fs=require('node:fs'),path=require('node:path'),D=require('better-sqlite3'),{ownedEvidenceRoot}=require('./lib/r86-native-evidence.cjs');
const out=path.resolve(process.argv[2]??'');if(!ownedEvidenceRoot(out,path.resolve(__dirname,'../dist')))throw Error('owned R86 root required');
const p=JSON.parse(fs.readFileSync(path.join(out,'progress.json'))),d=new D(path.join(p.dataRoot,'state.sqlite'),{readonly:true});
try{console.log(JSON.stringify({calls:d.prepare('SELECT id,model,status,created_at FROM real_calls ORDER BY id DESC LIMIT 6').all(),tasks:d.prepare('SELECT id,title,status,parent_task_id,current_delivery_id FROM tasks WHERE parent_task_id IS NULL').all(),runs:d.prepare('SELECT id,task_id,mode,status,stage FROM workflow_runs ORDER BY rowid DESC LIMIT 8').all(),turns:d.prepare('SELECT id,run_id,stage_key,status FROM agent_turns ORDER BY rowid DESC LIMIT 8').all()},null,2));}finally{d.close();}
