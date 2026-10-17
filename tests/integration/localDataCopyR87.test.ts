import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {prepareDataCopyJob,runDataCopyJob,dataLocationHash,dataControlPaths,readDataLocation,committedDataJobReceipt,claimActiveDataOperation,readActiveDataOperation,readDataJobStatus,reconcileInterruptedDataOperation,type DataCopyJob} from '../../src/contracts/dataCopyJob.ts';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {copyClosedDataRoot,findLocalDataRoot,verifyDataBackupContainer} from '../../src/contracts/localDataCopy.ts';
afterEach(()=>vi.unstubAllEnvs());
const sha=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
async function fixture(){
  vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_ALLOW_FAKE','1');
  const dir=mkdtempSync(join(tmpdir(),'zs-r87-data-copy-')),source=join(dir,'old-package','server-data'),destinationParent=join(dir,'copies'),project=join(dir,'project');
  for(const path of [source,destinationParent,project])mkdirSync(path,{recursive:true});
  const db=openDatabase(join(source,'state.sqlite'));
  const command=async(method:string,params:unknown)=>{const result=await dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:source,interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:Record<string,unknown>};expect(result.ok).toBe(true);return result.data;};
  const projectId=((await command('project.open',{path:project})).project as {id:string}).id;
  const room=(await command('room.list',{projectId})).items as Array<{id:string;conversationId:string}>;
  await command('message.submit',{target:{kind:'room_root',projectId,roomId:room[0]!.id,conversationId:room[0]!.conversationId},body:'备份前的正式记录',intent:'record_only',mentions:[]});
  db.close();
  mkdirSync(join(source,'electron-user-data','empty-directory'),{recursive:true});
  writeFileSync(join(source,'electron-user-data','opaque-draft-and-original-envelope'),'isolated draft and unchanged UNKNOWN commandId/params bytes');
  // Host-close proof is a synthetic fixture. It does not manufacture business terminal states.
  writeFileSync(join(source,'desktop-shutdown.json'),JSON.stringify({exited:true,forceKilled:false,daemonStopResult:{complete:true}}));
  const verifyDatabase=(path:string)=>{const copy=new Database(path,{readonly:true,fileMustExist:true});try{expect(copy.pragma('integrity_check',{simple:true})).toBe('ok');return{schemaVersion:copy.pragma('user_version',{simple:true}) as number};}finally{copy.close();}};
  return{dir,source,destinationParent,verifyDatabase,input:{source,destinationParent,kind:'backup' as const,maxSchemaVersion:54,verifyDatabase}};
}
describe('R87 complete local closed-root copy; all inputs synthetic, zero model calls',()=>{
  it('preserves formal facts and complete profile/empty directories, verifying original and copied bytes without changing source',async()=>{
    const f=await fixture();const before=sha(join(f.source,'state.sqlite')),profile=sha(join(f.source,'electron-user-data','opaque-draft-and-original-envelope'));
    const phases:string[]=[];const result=await copyClosedDataRoot({...f.input,onProgress:p=>phases.push(p.phase)});
    expect(sha(join(f.source,'state.sqlite'))).toBe(before);expect(sha(join(result.dataRoot,'state.sqlite'))).toBe(before);
    expect(sha(join(result.dataRoot,'electron-user-data','opaque-draft-and-original-envelope'))).toBe(profile);expect(existsSync(join(result.dataRoot,'electron-user-data','empty-directory'))).toBe(true);
    const db=new Database(join(result.dataRoot,'state.sqlite'),{readonly:true});try{expect(db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});}finally{db.close();}
    expect(JSON.parse(readFileSync(join(result.container,'data-copy-manifest.json'),'utf8')).status).toBe('complete');expect(phases).toContain('verifying');expect(phases.at(-1)).toBe('complete');
    expect(findLocalDataRoot(join(f.source,'..'))).toBe(f.source);expect(findLocalDataRoot(result.container)).toBe(result.dataRoot);
  });
  it.each(['ENOSPC','EACCES'])('retains the unique source and an explicitly incomplete destination after %s',async code=>{
    const f=await fixture(),before=sha(join(f.source,'state.sqlite'));
    await expect(copyClosedDataRoot({...f.input,beforeCopyFile:()=>{throw Object.assign(Error('isolated injected failure'),{code});}})).rejects.toMatchObject({code});
    expect(sha(join(f.source,'state.sqlite'))).toBe(before);const folder=readdirSync(f.destinationParent)[0]!;
    expect(JSON.parse(readFileSync(join(f.destinationParent,folder,'data-copy-manifest.json'),'utf8')).status).toBe('incomplete');
  });
  it('refuses active or unconfirmed source roots instead of stopping an app or changing protection',async()=>{
    const f=await fixture();writeFileSync(join(f.source,'desktop-host.pid'),String(process.pid));
    await expect(copyClosedDataRoot(f.input)).rejects.toThrow('DATA_SOURCE_IN_USE');expect(readdirSync(f.destinationParent)).toEqual([]);
    writeFileSync(join(f.source,'desktop-host.pid'),'bad-pid');await expect(copyClosedDataRoot(f.input)).rejects.toThrow('DATA_SOURCE_IN_USE');
  });
  it('does not copy into its own source, or follow a junction to an external directory',async()=>{
    const f=await fixture();await expect(copyClosedDataRoot({...f.input,destinationParent:f.source})).rejects.toThrow('DATA_PATH_OVERLAP');
    const outside=join(f.dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'never-read.txt'),'outside');
    symlinkSync(outside,join(f.source,'escape'),process.platform==='win32'?'junction':'dir');
    await expect(copyClosedDataRoot(f.input)).rejects.toThrow('DATA_LINK_REFUSED');expect(readdirSync(f.destinationParent)).toEqual([]);
  });
  it('restore verifies completed backup hashes, rejecting tampering and an incomplete backup rather than rebranding it',async()=>{
    const f=await fixture();const result=await copyClosedDataRoot(f.input);
    expect(await verifyDataBackupContainer(result.container)).toBe(result.dataRoot);
    writeFileSync(join(result.dataRoot,'electron-user-data','opaque-draft-and-original-envelope'),'tampered');
    await expect(verifyDataBackupContainer(result.container)).rejects.toThrow('DATA_BACKUP_CHANGED');
    const manifest=join(result.container,'data-copy-manifest.json');writeFileSync(manifest,JSON.stringify({format:'zhongshuo-full-data-v1',status:'incomplete',files:[]}));
    await expect(copyClosedDataRoot({...f.input,source:result.container,kind:'import'})).rejects.toThrow('DATA_BACKUP_INCOMPLETE');
  });
  it('detects source mutation after an earlier file was already copied and retains the incomplete destination',async()=>{
    const f=await fixture();let changed=false;
    await expect(copyClosedDataRoot({...f.input,onProgress:p=>{
      if(p.phase==='copying'&&p.files===1&&!changed){changed=true;writeFileSync(join(f.source,'desktop-shutdown.json'),JSON.stringify({exited:true,forceKilled:false,daemonStopResult:{complete:true},changed:true}));}
    }})).rejects.toThrow('DATA_SOURCE_CHANGED');
    expect(changed).toBe(true);const folder=readdirSync(f.destinationParent)[0]!;expect(JSON.parse(readFileSync(join(f.destinationParent,folder,'data-copy-manifest.json'),'utf8')).status).toBe('incomplete');
  });
  it('does not dereference the data directory junction of a backup container before checking its boundary',async()=>{
    const f=await fixture(),container=join(f.dir,'linked-backup');mkdirSync(container);
    writeFileSync(join(container,'data-copy-manifest.json'),JSON.stringify({format:'zhongshuo-full-data-v1',status:'complete',files:[],directories:[]}));
    symlinkSync(f.source,join(container,'data'),process.platform==='win32'?'junction':'dir');
    await expect(verifyDataBackupContainer(container)).rejects.toThrow('DATA_LINK_REFUSED');
    await expect(copyClosedDataRoot({...f.input,source:container,kind:'import'})).rejects.toThrow('DATA_LINK_REFUSED');
    expect(readdirSync(f.destinationParent)).toEqual([]);
  });
  it('a newer schema or interrupted validation never publishes a completed backup or switches data',async()=>{
    const f=await fixture(),before=sha(join(f.source,'state.sqlite'));
    await expect(copyClosedDataRoot({...f.input,verifyDatabase:()=>({schemaVersion:55})})).rejects.toThrow('SCHEMA_VERSION_UNSUPPORTED');
    await expect(copyClosedDataRoot({...f.input,verifyDatabase:()=>{throw Error('isolated validation interruption');}})).rejects.toThrow('interruption');
    expect(sha(join(f.source,'state.sqlite'))).toBe(before);
    for(const folder of readdirSync(f.destinationParent))expect(JSON.parse(readFileSync(join(f.destinationParent,folder,'data-copy-manifest.json'),'utf8')).status).toBe('incomplete');
  });
});

async function closedOwnerPid(){const child=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});await once(child,'exit');return child.pid!;}
async function jobFor(f:Awaited<ReturnType<typeof fixture>>,patch:Partial<DataCopyJob>={}){
  const job:DataCopyJob={format:'zhongshuo-data-job-v1',id:randomUUID(),action:'backup',baseRoot:f.source,currentRoot:f.source,selectedSource:f.source,destinationParent:f.destinationParent,ownerPid:await closedOwnerPid(),expectedLocationHash:dataLocationHash(f.source),...patch};
  return{job,paths:await prepareDataCopyJob(job)};
}
describe('R87 data operation identity and atomic location commit, isolated host processes',()=>{
  it('a completed backup receipt replays without creating another directory or copying again',async()=>{
    const f=await fixture(),{job,paths}=await jobFor(f);
    const first=await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:f.verifyDatabase});expect(first.state).toBe('succeeded');
    const count=readdirSync(f.destinationParent).length;
    expect(await prepareDataCopyJob(job)).toEqual(paths);
    expect(await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:()=>{throw Error('must not recopy');}})).toEqual(first);
    expect(readdirSync(f.destinationParent)).toHaveLength(count);expect(readDataLocation(f.source)).toBe(f.source);
  });
  it('using another complete root preserves the current root first, commits only the verified copy, and survives a fresh location read',async()=>{
    const f=await fixture(),other=await fixture(),before=sha(join(f.source,'state.sqlite')),otherBefore=sha(join(other.source,'state.sqlite'));
    const {paths}=await jobFor(f,{action:'import',selectedSource:other.source});
    const result=await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:f.verifyDatabase});expect(result.state).toBe('succeeded');expect(result.previous).toBeDefined();
    expect(sha(join(result.previous!.dataRoot,'state.sqlite'))).toBe(before);expect(sha(join(result.result!.dataRoot,'state.sqlite'))).toBe(otherBefore);
    expect(readDataLocation(f.source)).toBe(result.result!.dataRoot);expect(sha(join(f.source,'state.sqlite'))).toBe(before);expect(sha(join(other.source,'state.sqlite'))).toBe(otherBefore);
    expect(JSON.parse(readFileSync(paths.location,'utf8')).operationId).toBe(result.id);
  });
  it('waiting for an owner that has not exited fails safely without terminating it or starting a copy',async()=>{
    const f=await fixture(),{paths}=await jobFor(f,{ownerPid:process.pid});
    const result=await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:f.verifyDatabase,waitForOwnerMs:0});expect(result).toMatchObject({state:'failed',error:expect.stringContaining('DATA_CLOSE_TIMEOUT')});
    expect(readdirSync(f.destinationParent)).toEqual([]);expect(()=>process.kill(process.pid,0)).not.toThrow();
  });
  it('a late location change cannot be overwritten by an earlier import operation',async()=>{
    const f=await fixture(),other=await fixture(),{paths}=await jobFor(f,{action:'import',selectedSource:other.source});let changed=false;
    const result=await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:f.verifyDatabase,onStatus:status=>{
      if(status.state==='copying'&&status.stage==='selected'&&status.progress?.phase==='verifying'&&!changed){changed=true;writeFileSync(paths.location,JSON.stringify({format:'zhongshuo-data-location-v1',baseKey:dataControlPaths(f.source).key,operationId:randomUUID(),dataRoot:f.source,manifestHash:'f'.repeat(64)}));}
    }});
    expect(changed).toBe(true);expect(result).toMatchObject({state:'failed',error:expect.stringContaining('DATA_LOCATION_CHANGED')});expect(readDataLocation(f.source)).toBe(f.source);expect(result.previous).toBeDefined();
  });
});

it('R87 a lost success notification after location commit is identified from the exact operation and immutable manifest, never recopied',async()=>{
  const f=await fixture(),other=await fixture(),{job,paths}=await jobFor(f,{action:'import',selectedSource:other.source});
  const result=await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:f.verifyDatabase,onStatus:status=>{if(status.state==='succeeded')throw Error('isolated closed progress window');}});
  expect(result.state).toBe('succeeded');const destination=readDataLocation(f.source),count=readdirSync(f.destinationParent).length;
  // Isolated receipt-loss injection: the real pointer and verified data commit remain unchanged.
  writeFileSync(paths.status,JSON.stringify({format:'zhongshuo-data-status-v1',id:job.id,state:'copying',at:Date.now()}));
  const recovered=committedDataJobReceipt(job);expect(recovered).toMatchObject({state:'succeeded',recoveredReceipt:true,result:{dataRoot:destination}});
  expect(await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:()=>{throw Error('must not recopy');}})).toMatchObject({state:'succeeded',recoveredReceipt:true});
  expect(readdirSync(f.destinationParent)).toHaveLength(count);expect(readDataLocation(f.source)).toBe(destination);
  expect(readDataJobStatus(job)).toMatchObject({state:'succeeded',recoveredReceipt:true});
});

describe('R87 data operation crash ownership and startup reconciliation',()=>{
  it('refuses another live operation before writing a job lease or destination',async()=>{
    const f=await fixture(),first=await jobFor(f),second=await jobFor(f);
    claimActiveDataOperation(first.job,process.pid);
    await expect(runDataCopyJob(second.paths.job,{maxSchemaVersion:54,verifyDatabase:f.verifyDatabase})).rejects.toThrow('DATA_OPERATION_IN_PROGRESS');
    expect(existsSync(second.paths.lease)).toBe(false);expect(readdirSync(f.destinationParent)).toEqual([]);
  });
  it('a dead worker before pointer commit becomes a durable unknown receipt and is never recopied automatically',async()=>{
    const f=await fixture(),{job,paths}=await jobFor(f);
    writeFileSync(paths.lease,JSON.stringify({id:job.id,pid:await closedOwnerPid(),at:Date.now()}));
    writeFileSync(paths.status,JSON.stringify({format:'zhongshuo-data-status-v1',id:job.id,state:'copying',at:Date.now()}));
    const status=await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:()=>{throw Error('must not recopy');}});
    expect(status).toMatchObject({state:'unknown',error:expect.stringContaining('DATA_OPERATION_INTERRUPTED')});
    expect(readDataJobStatus(job)).toMatchObject({state:'unknown'});
    expect(readdirSync(f.destinationParent)).toEqual([]);expect(readDataLocation(f.source)).toBe(f.source);
  });
  it('startup reconciliation settles a committed pointer left with a stale progress host, without opening or copying the profile',async()=>{
    const f=await fixture(),other=await fixture(),{job,paths}=await jobFor(f,{action:'import',selectedSource:other.source});
    const first=await runDataCopyJob(paths.job,{maxSchemaVersion:54,verifyDatabase:f.verifyDatabase});
    writeFileSync(paths.status,JSON.stringify({format:'zhongshuo-data-status-v1',id:job.id,state:'copying',at:Date.now()}));
    claimActiveDataOperation(job,await closedOwnerPid());
    const recovered=reconcileInterruptedDataOperation(f.source);
    expect(recovered).toMatchObject({state:'succeeded',recoveredReceipt:true,result:{dataRoot:first.result!.dataRoot}});
    expect(readActiveDataOperation(f.source)).toBeNull();expect(readDataJobStatus(job)).toMatchObject({state:'succeeded',recoveredReceipt:true});
    expect(JSON.parse(readFileSync(paths.location,'utf8')).operationId).toBe(job.id);
  });
  it('startup reconciliation marks an uncommitted dead operation unknown, clears the host mutex, and preserves the current root',async()=>{
    const f=await fixture(),{job}=await jobFor(f);
    claimActiveDataOperation(job,await closedOwnerPid());
    const interrupted=reconcileInterruptedDataOperation(f.source);
    expect(interrupted).toMatchObject({state:'unknown',error:expect.stringContaining('原数据位置没有切换')});
    expect(readActiveDataOperation(f.source)).toBeNull();expect(readDataLocation(f.source)).toBe(f.source);expect(readdirSync(f.destinationParent)).toEqual([]);
  });
});
