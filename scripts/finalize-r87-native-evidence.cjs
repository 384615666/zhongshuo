/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const Database=require('better-sqlite3');

const pkg=path.resolve(process.argv[2]);
const project=path.resolve(process.argv[3]);
const out=path.resolve(process.argv[4]);
const dataEvidence=path.resolve(process.argv[5]);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const build=JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8'));
const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
const calls=db.prepare('SELECT runtime_kind,model,status,response_model,task_id FROM real_calls ORDER BY rowid').all();
const task=db.prepare('SELECT id,conversation_thread_id,status,current_delivery_id FROM tasks ORDER BY rowid LIMIT 1').get();
const delivery=db.prepare('SELECT id,task_id,revision,manifest_hash,review_status,reviewed_at FROM task_deliveries WHERE id=?').get(task.current_delivery_id);
const history=db.prepare('SELECT revision,review_status,manifest_hash FROM task_deliveries WHERE task_id=? ORDER BY revision').all(task.id);
db.close();
const file=(name)=>{const p=path.join(project,name);return fs.existsSync(p)?{name,bytes:fs.statSync(p).size,sha256:sha(p)}:null;};
const saved=path.join(out,'saved','报告复核-v2.md');
const data=JSON.parse(fs.readFileSync(dataEvidence,'utf8'));
const screenshots=['two-model-collaboration.png','v2-file.png','v2-preview-saved.png','reopened-completed.png'].map(name=>{const p=path.join(out,name);return fs.existsSync(p)?{name,bytes:fs.statSync(p).size,sha256:sha(p)}:null;}).filter(Boolean);
const distinct=new Set(calls.map(x=>`${x.runtime_kind}/${x.model}`));
const pass=build.dirty===false&&build.commit==='9771a8a39caec15c85429580b78827ef9f8baca0'
  &&calls.length===9&&calls.every(x=>x.status==='succeeded')
  &&distinct.has('claude/deepseek-flash')&&distinct.has('codex/gpt-6-luna')
  &&task.status==='DONE'&&delivery?.review_status==='accepted'&&delivery?.revision===3
  &&fs.existsSync(saved)&&sha(saved)===sha(path.join(project,'报告复核-v2.md'))
  &&data.ok===true&&data.modelCalls===0;
const result={format:'zhongshuo-r87-native-final-evidence-v1',ok:pass,build,project,dataGuide:{source:dataEvidence,ok:data.ok,backupFiles:data.backup?.manifest?.checked,modelCalls:data.modelCalls},
  collaboration:{task,delivery,history,calls,distinctModels:[...distinct],callCount:calls.length,afterReopenCallCount:calls.length},
  files:{inputs:['R87交付报告.docx','R87交付报告.pdf'].map(file),v1:file('报告复核-v1.md'),v2:file('报告复核-v2.md'),saved:saved?{name:path.basename(saved),bytes:fs.statSync(saved).size,sha256:sha(saved)}:null},
  screenshots,
  boundaries:[
    'Real Windows UI and real Claude/Codex calls on the final clean BUILD; synthetic report only.',
    'Current accepted delivery is revision 3; the final file is named 报告复核-v2.md. Intermediate revision 2 is retained as superseded.',
    'Normal close/reopen retained the completed task, accepted delivery and file bytes without new model calls.',
    'Android, installer, signing, auto-update, parallel writer expansion and user production data were not touched.'
  ],
  at:new Date().toISOString(),
};
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify({ok:pass,evidence:path.join(out,'result.json'),calls:calls.length,deliveryRevision:delivery?.revision},null,2));
if(!pass)process.exitCode=1;
