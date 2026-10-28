import {afterEach,describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,unlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {captureBaseline,finalizeChangeset,undoChangeset} from '../../src/daemon/changeset.ts';
import {scanDirectoryFiles,scanProjectFiles} from '../../src/daemon/preimage.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {simulateDeliberationTurn} from '../../src/adapter/fake/deliberationSim.ts';

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
function fixture(git=true,seed=true){
 const root=mkdtempSync(join(tmpdir(),'zs-r118-')),project=join(root,'project'),data=join(root,'data');mkdirSync(project);mkdirSync(data);
 cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const db=openDatabase(join(data,'state.sqlite'));cleanup.push(()=>{db.close();});
 const command=(args:string[])=>{const result=spawnSync('git',['-C',project,...args],{encoding:'utf8'});expect(result.status,result.stderr).toBe(0);};
 if(git){command(['init','-q']);command(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','init']);}
 if(seed)db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','测试项目',?,?,'{}',0)").run(project,project);
 const capture=()=>{const result=captureBaseline(db,{projectId:'p',appDataDir:data});if(!result.ok)throw Error(result.error.message);return result.value;};
 const finish=(id:string)=>{const result=finalizeChangeset(db,{changeSetId:id,appDataDir:data});if(!result.ok)throw Error(result.error.message);return result.value.diff;};
 return {root,project,data,db,command,capture,finish};
}

describe('R118 source workspace baseline',()=>{
 it('excludes ignored packages and runtime junctions while retaining tracked ignored files',()=>{
  const f=fixture();writeFileSync(join(f.project,'.gitignore'),'dist/\ntracked.md\n');
  writeFileSync(join(f.project,'source.md'),'项目源码');writeFileSync(join(f.project,'tracked.md'),'显式跟踪文件');f.command(['add','-f','tracked.md']);
  mkdirSync(join(f.project,'dist'));for(let i=0;i<5005;i++)writeFileSync(join(f.project,'dist',`package-${i}.bin`),'不属于源码基线');
  const outside=join(f.root,'runtime');mkdirSync(outside);writeFileSync(join(outside,'keep'),'外部运行时');symlinkSync(outside,join(f.project,'dist','node_modules'),'junction');
  const baseline=f.capture();expect(baseline.truncated).toBe(false);expect(baseline.fileCount).toBe(3);
  expect(baseline.scanProblems).toEqual([]);
  const manifest=JSON.parse((f.db.prepare('SELECT manifest_json FROM change_sets WHERE id=?').get(baseline.changeSetId) as {manifest_json:string}).manifest_json);
  expect(manifest.scopeKind).toBe('git-files');expect(manifest.scanRejected).toBe(0);
  expect(readFileSync(join(outside,'keep'),'utf8')).toBe('外部运行时');
 });
 it('captures more than 5000 plain files without implicit truncation and honours an explicit cap',()=>{
  const f=fixture(false);for(let i=0;i<5005;i++)writeFileSync(join(f.project,`document-${i}.txt`),'x');
  const full=scanProjectFiles(f.project);expect(full.files).toHaveLength(5005);expect(full.truncated).toBe(false);
  const limited=scanDirectoryFiles(f.project,5);expect(limited.files).toHaveLength(5);expect(limited.truncated).toBe(true);
 });
 it('detects new files in newly created directories when Git scope did not change',()=>{
  const f=fixture(),baseline=f.capture();mkdirSync(join(f.project,'new'));writeFileSync(join(f.project,'new','report.md'),'新文档');
  expect(f.finish(baseline.changeSetId).added).toContain('new/report.md');
 });
 it.each(['ignore','untrack'] as const)('keeps a baseline file present after %s',variant=>{
  const f=fixture();writeFileSync(join(f.project,'.gitignore'),'');writeFileSync(join(f.project,'keep.md'),'原有文件');
  if(variant==='untrack')f.command(['add','keep.md']);
  const baseline=f.capture();writeFileSync(join(f.project,'.gitignore'),'keep.md\n');
  if(variant==='untrack')f.command(['rm','--cached','keep.md']);
  expect(f.finish(baseline.changeSetId).removed).toEqual([]);
  expect(f.db.prepare("SELECT state FROM change_set_files WHERE change_set_id=? AND path='keep.md' AND role='after'").get(baseline.changeSetId)).toEqual({state:'present'});
 });
 it('records an actual tracked deletion',()=>{
  const f=fixture();writeFileSync(join(f.project,'remove.md'),'原文件');f.command(['add','remove.md']);const baseline=f.capture();unlinkSync(join(f.project,'remove.md'));
  expect(f.finish(baseline.changeSetId).removed).toContain('remove.md');
 });
 it.each(['ignore-rule','index'] as const)('does not invent absence when an old ignored file becomes visible through %s',variant=>{
  const f=fixture();writeFileSync(join(f.project,'.gitignore'),'old.md\n');writeFileSync(join(f.project,'old.md'),'用户原有文件');const baseline=f.capture();
  if(variant==='ignore-rule')writeFileSync(join(f.project,'.gitignore'),'');else f.command(['add','-f','old.md']);
  const diff=f.finish(baseline.changeSetId);expect(diff.added).not.toContain('old.md');expect(diff.undeterminable.some(file=>file.path==='old.md')).toBe(true);
  expect(f.db.prepare("SELECT state FROM change_set_files WHERE change_set_id=? AND path='old.md' AND role='before'").get(baseline.changeSetId)).toEqual({state:'unknown'});
 });
 it('includes ancestor ignore rules for a project opened below the Git root',()=>{
  const f=fixture();mkdirSync(join(f.project,'nested'));writeFileSync(join(f.project,'.gitignore'),'old.md\n');writeFileSync(join(f.project,'nested','old.md'),'已有文件');
  f.db.prepare("UPDATE projects SET canonical_path=?,root_path=? WHERE id='p'").run(join(f.project,'nested'),join(f.project,'nested'));
  const baseline=f.capture();writeFileSync(join(f.project,'.gitignore'),'');expect(f.finish(baseline.changeSetId).undeterminable.some(file=>file.path==='old.md')).toBe(true);
 });
 it('does not infer absence when Git case matching exposes existing files',()=>{
  const f=fixture();f.command(['config','core.ignoreCase','true']);
  writeFileSync(join(f.project,'.gitignore'),'cache/\n');mkdirSync(join(f.project,'Cache'));writeFileSync(join(f.project,'Cache','old.md'),'原文件');
  const baseline=f.capture();f.command(['config','core.ignoreCase','false']);
  const diff=f.finish(baseline.changeSetId);expect(diff.added).not.toContain('Cache/old.md');expect(diff.undeterminable.some(file=>file.path==='Cache/old.md')).toBe(true);
 });
 it('does not hash a worktree ignore file through an external symbolic link',context=>{
  const f=fixture();const outside=join(f.root,'external-ignore');writeFileSync(outside,'*.md\n');
  try{symlinkSync(outside,join(f.project,'.gitignore'),'file');}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM'){context.skip('Windows未授予文件符号链接权限');return;}throw error;}
  const scan=scanProjectFiles(f.project);expect(scan.failedDirs).toEqual([]);expect(scan.rejectedEntries.some(item=>item.entry==='.gitignore')).toBe(true);
 });
 it('reports Git enumeration failure and selected external links instead of changing scope',()=>{
  const f=fixture();const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'private.md'),'外部');symlinkSync(outside,join(f.project,'linked'),'junction');
  expect(scanProjectFiles(f.project).rejectedEntries.length).toBeGreaterThan(0);
  writeFileSync(join(f.project,'.git','index'),'损坏的索引');const failed=scanProjectFiles(f.project);
  expect(failed.scopeKind).toBe('git-files');expect(failed.files).toEqual([]);expect(failed.failedDirs[0]?.error).toContain('Git文件清单读取失败');
 });
 it('refuses to compare a replacement project directory with the original baseline',()=>{
  const f=fixture();writeFileSync(join(f.project,'before.md'),'原目录内容');const baseline=f.capture();
  renameSync(f.project,join(f.root,'original-project'));mkdirSync(f.project);writeFileSync(join(f.project,'after.md'),'替换目录内容');
  const result=finalizeChangeset(f.db,{changeSetId:baseline.changeSetId,appDataDir:f.data});
  expect(result.ok).toBe(false);if(!result.ok)expect(result.error.message).toContain('目录身份已变化');
 });
 it('accepts an empty Git capture and retains legacy directory-scan semantics',()=>{
  const f=fixture();const empty=f.capture();expect(f.finish(empty.changeSetId).added).toEqual([]);
  const undone=undoChangeset(f.db,{changeSetId:empty.changeSetId,appDataDir:f.data});expect(undone.ok).toBe(true);
  writeFileSync(join(f.project,'.gitignore'),'generated/\n');mkdirSync(join(f.project,'generated'));writeFileSync(join(f.project,'generated','old.md'),'旧文件');
  const legacy=f.capture();f.db.prepare("UPDATE change_sets SET manifest_json=json_set(manifest_json,'$.scopeKind','directory-scan') WHERE id=?").run(legacy.changeSetId);
  const diff=f.finish(legacy.changeSetId);expect(diff.added).toContain('generated/old.md');
 });
 it.each([false,true])('starts both deliberation members with ignored runtime data (real selected path failure=%s)',async failure=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');const f=fixture(true,false);
  writeFileSync(join(f.project,'.gitignore'),'dist/\n');mkdirSync(join(f.project,'dist'));const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'runtime.bin'),'外部运行数据');symlinkSync(outside,join(f.project,failure?'linked':'dist/linked'),'junction');
  writeFileSync(join(f.project,'requirements.md'),'测试需求');
  const adapter=new FakeRuntimeAdapter({structuredFinal:false,turnScriptSequencer:input=>simulateDeliberationTurn(input.text)});cleanup.push(()=>adapter.closeAllSessions());
  const worker=new DispatchWorker({db:f.db,adapter,appDataDir:f.data,leaseOwner:'r118',enableDeliberate:true,detachedTurnConsumption:false});
  const cmd=async<T>(method:string,params:unknown):Promise<T>=>{const result=await dispatchDaemonCommand({db:f.db,appDataDir:f.data,localUserId:'fixture',interruptTurn:id=>worker.interruptTurn(id)}, {protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error:unknown};expect(result.ok,JSON.stringify(result.error)).toBe(true);return result.data;};
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:f.project})).project.id;
  const room=(await cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId})).items[0]!;
  const members:string[]=[];for(const displayName of ['成员甲','成员乙']){const {memberId}=await cmd<{memberId:string}>('member.create',{projectId,displayName});await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});members.push(memberId);}
  const submitted=await cmd<{taskId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请分别分析需求',intent:'default',collaboration:'deliberate',mentions:members.map(memberId=>({kind:'member',memberId}))});
  await worker.runOnce();
  if(failure){await expect(worker.runOnce()).rejects.toThrow('linked');await expect(worker.runOnce()).rejects.toThrow('linked');}
  else {await worker.runOnce();await worker.runOnce();}
  expect(adapter.startTurnLog.length).toBe(failure?0:2);
  const turns=f.db.prepare("SELECT a.status FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND a.stage_key='delib.independent'").all(submitted.taskId) as Array<{status:string}>;
  expect(turns).toHaveLength(2);expect(turns.every(turn=>turn.status===(failure?'FAILED':'SUCCEEDED'))).toBe(true);
  if(failure){
   await worker.runOnce();
   const reason=f.db.prepare("SELECT payload_json FROM domain_events WHERE task_id=? AND kind='run.deliberationBlocked' LIMIT 1").get(submitted.taskId) as {payload_json:string};
   expect(reason.payload_json).toContain('linked');expect(reason.payload_json).not.toContain('§6.1');
  }
 });
});
