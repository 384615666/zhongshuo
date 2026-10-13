/* global require,process,console,__dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- offline release evidence audit */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),name=process.argv[2]??'desktop-daily-win-v21-rc6';
const pkg=path.join(root,'dist/desktop',name),suffix=name.replace('desktop-daily-win-',''),prefix=`dist/desktop/review-r82-${suffix}`;
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
const json=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const build=json(`dist/desktop/${name}/ZhongshuoDual/BUILD.json`),rows=[],evidence=[];
const gate=(name,pass,facts)=>{rows.push({name,pass:pass===true,facts});};
const add=p=>{evidence.push({path:p,sha256:sha(p),bytes:fs.statSync(path.join(root,p)).size});return json(p);};
const manifest=add(`dist/desktop/${name}/ZhongshuoDual/MANIFEST-SHA256.json`);
const matches=manifest.files.filter(f=>{const p=path.join(pkg,'ZhongshuoDual',f.path);return fs.existsSync(p)&&fs.statSync(p).size===f.bytes&&sha(path.relative(root,p))===f.sha256;}).length;
gate('clean frozen source and all package bytes',build.dirty===false&&matches===manifest.files.length&&manifest.buildId===build.buildId&&cp.spawnSync('git',['diff','--quiet',build.commit,'--','src'],{cwd:root}).status===0,{build,matched:matches,total:manifest.files.length});
gate('daily package has no test root or seed',!fs.existsSync(path.join(pkg,'server-data'))&&!fs.existsSync(path.join(pkg,'desktop-profile')),{entry:'start-desktop.bat',sha256:sha(`dist/desktop/${name}/start-desktop.bat`)});
const real=add(`${prefix}-real-release-20261013/result.json`);
gate('same final BUILD real launcher complete business and reading route',real.pass&&real.build.buildId===build.buildId&&real.build.commit===build.commit&&!real.closeError&&real.calls.length===7&&real.calls.every(c=>c.runtime_kind==='claude'&&c.model==='glm-5.3-flash'&&c.response_model==='glm-5.3-flash'&&c.status==='succeeded')&&real.steps.some(s=>s.includes('actual immutable v1/v2 text snapshots'))&&real.steps.some(s=>s.includes('ordinary close/reopen')),{steps:real.steps,calls:real.calls,initialProbePass:real.pass,initialProbeFailure:real.error,closed:!real.closeError});
for(const screenshot of new Set(real.screenshots)){const p=`${prefix}-real-release-20261013/${screenshot}`;evidence.push({path:p,sha256:sha(p)});}
const D=require('better-sqlite3'),db=new D(path.join(real.dataRoot,'state.sqlite'),{readonly:true});
try {
  const all=(sql,...p)=>db.prepare(sql).all(...p),one=(sql,...p)=>db.prepare(sql).get(...p);
  const prj=one('SELECT canonical_path FROM projects WHERE id=?',real.ids.projectId).canonical_path;
  const original=fs.readFileSync(path.join(prj,'original.txt'),'utf8');
  const files=['说明.md','math.js','私信成果.md'].map(file=>({file,sha256:sha(path.relative(root,path.join(prj,file))),bytes:fs.statSync(path.join(prj,file)).size}));
  gate('actual final file bytes and protected originals',files[0].sha256===real.v2.markdownHash&&files[1].sha256===real.v2.codeHash&&files[2].sha256===real.dm.hash&&original==='R82 ENGINEERING ORIGINAL'&&!fs.existsSync(path.join(prj,'forbidden.md'))&&!fs.existsSync(path.join(prj,'cross-forbidden.md'))&&!fs.existsSync(path.join(prj,'revoked-forbidden.md')),{projectId:real.ids.projectId,files});
  const tasks=all('SELECT id,project_id,status,write_scope_json FROM tasks WHERE id IN (?,?)',real.ids.taskId,real.ids.dmTaskId);
  const versions=all('SELECT id,task_id,run_id,revision,manifest_hash,change_set_refs_json,review_status FROM task_deliveries WHERE task_id IN (?,?) ORDER BY task_id,revision',real.ids.taskId,real.ids.dmTaskId);
  const diffs=all('SELECT id,task_id,before_ref,after_ref,application_status FROM change_sets WHERE task_id IN (?,?)',real.ids.taskId,real.ids.dmTaskId);
  gate('room and DM natural v1/v2 with version-bound acceptance and actual diffs',tasks.length===2&&tasks.every(t=>t.status==='DONE'&&t.project_id===real.ids.projectId)&&versions.length===4&&versions.filter(v=>v.revision===2).every(v=>v.review_status==='accepted')&&versions.every(v=>JSON.parse(v.change_set_refs_json).length===1&&diffs.some(c=>JSON.parse(v.change_set_refs_json).includes(c.id)&&c.before_ref&&c.after_ref&&c.application_status==='applied')),{tasks:tasks.map(({write_scope_json,...t})=>({...t,writeScope:JSON.parse(write_scope_json)})),versions,diffs});
  const grants=all('SELECT project_id,authorized,revision FROM project_write_authorizations');
  const held=all("SELECT owner_turn_id,status FROM workspace_leases WHERE status!='released'");
  const tools=all("SELECT turn_id,kind,payload_json FROM domain_events WHERE kind IN ('tool.started','tool.completed')");
  const writeTurnIds=new Set(versions.map(v=>real.calls.find(c=>c.task_id===v.task_id&&v.id===`dlv_${c.turn_id}`)?.turn_id).filter(Boolean));
  const writeEvents=tools.filter(e=>writeTurnIds.has(e.turn_id)&&e.kind==='tool.started'&&['Edit','Write'].includes(JSON.parse(e.payload_json).toolName));
  gate('native tools actually ran and all write processes released only on confirmed exit',held.length===0&&writeEvents.length>=4&&grants.every(g=>g.authorized===0)&&all("SELECT id FROM agent_turns WHERE status IN ('RUNNING','UNKNOWN')").length===0,{grants,held,writeEvents:writeEvents.map(e=>({turnId:e.turn_id,...JSON.parse(e.payload_json)})),dmSessions:real.dm.sessions});
} finally {db.close();}
for(const kind of ['normal-workflow','unknown','visual']) {const r=add(`${prefix}-${kind}-20261013/result.json`);gate(`same final BUILD ${kind}`,r.pass===true&&(r.buildId??r.build?.buildId)===build.buildId&&(r.realCalls??r.calls?.length??0)===0,{steps:r.steps,viewports:r.viewports,realCalls:r.realCalls??r.calls?.length});}
const upgrade=add(`dist/r82-upgrade-${suffix.split('-').at(-1)}/result.json`);gate('full owned old-root upgrade and actual old-version rejection/backup reopen',upgrade.pass===true&&upgrade.newBuild.buildId===build.buildId&&upgrade.legacyTableCount===67&&upgrade.nonDatabaseFilesIntact===true,{oldBuild:upgrade.oldBuild,newBuild:upgrade.newBuild,copiedFiles:upgrade.copiedFiles,legacyTableCount:upgrade.legacyTableCount});
const cancelLog=fs.readFileSync(path.join(root,`dist/r82-${suffix.split('-').at(-1)}-cancel-cross.log`),'utf8'),cancelLine=cancelLog.trim().split(/\r?\n/).at(-1),cancel=JSON.parse(cancelLine);const cr=add(path.relative(root,path.join(cancel.out,'result.json')).replaceAll('\\','/'));gate('latest project intent and settings target regressions',cr.pass&&cr.reports.length===11&&cr.reports.every(r=>r.pass&&r.realCalls===0),{scenarios:cr.reports.map(r=>({name:r.name,pass:r.pass,realCalls:r.realCalls}))});
const readLog=JSON.parse(fs.readFileSync(path.join(root,`dist/r82-${suffix.split('-').at(-1)}-launcher-regression.log`),'utf8'));gate('same final BUILD stable attachments/actual image decode/original hash/ordinary reopen',readLog.ok===true&&readLog.facts.buildId===build.buildId,{facts:readLog.facts});
evidence.push({path:`dist/r82-${suffix.split('-').at(-1)}-launcher-regression.log`,sha256:sha(`dist/r82-${suffix.split('-').at(-1)}-launcher-regression.log`)});
const strict=add('dist/r82-real-glm-create-boundary-20261013/result.json');gate('original real adjacent and junction native write refusal evidence',strict.pass&&strict.denied===2&&strict.outsideExists===false&&strict.junctionOutputExists===false&&strict.originalPreserved===true,{model:strict.model,version:strict.version,denied:strict.denied});
const suite=fs.readFileSync(path.join(root,'dist/r82-suite-stage13.log'),'utf8');gate('source tests and both type checks',/Tests\s+1017 passed/.test(suite)&&/Test Files\s+145 passed/.test(suite)&&!(/error TS/.test(fs.readFileSync(path.join(root,'dist/r82-diff-main-type.log'),'utf8')+fs.readFileSync(path.join(root,'dist/r82-diff-ui-type.log'),'utf8'))),{tests:1017,files:145,excluded:'existing external githubSandbox; not recertified'});
const lint=add('dist/r82-lint-stage10.json');gate('changed-file lint has no additional errors',lint.pass,{files:lint.files.length});
const frozen=cp.execFileSync('git',['diff','411932e','--name-only','--','src/persistence/migrations'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);gate('001-049 migrations stay frozen',frozen.every(p=>p.endsWith('050-project-write-authorization.ts')||p.endsWith('registry.ts')),{changed:frozen});
const unique=new Map(),origins=[];
for(const n of ['review-r82-stage1-real-flow-20261013','review-r82-stage1-real-flow-2-20261013','review-r82-stage1-real-continue-20261013','review-r82-v21-real-release-20261013','review-r82-v21-rc2-real-release-20261013','review-r82-v21-rc3-real-release-20261013','review-r82-v21-rc4-real-release-20261013',`review-r82-${suffix}-real-release-20261013`]) {
 const p=`dist/desktop/${n}/copy/server-data/state.sqlite`,d=new D(path.join(root,p),{readonly:true});try {const calls=d.prepare('SELECT turn_id,runtime_kind,model,response_model,status FROM real_calls').all();origins.push({path:p,calls:calls.length});for(const c of calls)unique.set(c.turn_id,c);}finally{d.close();}
}
const probes=['r82-real-permission-first-20261013','r82-real-permission-glm-first-20261013','r82-real-permission-glm-boundary-20261013','r82-real-glm-create-boundary-20261013','r82-glm-structured-20261013'].map(n=>{const p=`dist/${n}/result.json`,r=add(p);return{path:p,model:r.model??'deepseek-flash',attempts:r.realCallsRequested??1,pass:r.pass,purpose:r.purpose??n};});
const calls={definition:'unique real turn attempts, not HTTP round trips/tokens/billing; cloned database turn IDs deduplicated',formal:[...unique.values()],probes,origins,total:unique.size+probes.reduce((n,p)=>n+p.attempts,0)};
const result={pass:rows.every(r=>r.pass),candidate:name,build,gates:rows,realCalls:calls,evidence,scope:'actual Claude/glm-5.3-flash native restricted project file tools; no real Codex/write or new vision certification; no user acceptance'};
fs.writeFileSync(path.join(root,'docs/implementation/r82-v21-delivery-20261013.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,buildId:build.buildId,calls:calls.total,failed:rows.filter(r=>!r.pass).map(r=>r.name)}));if(!result.pass)process.exitCode=1;
