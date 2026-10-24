import {z} from 'zod';
import {createHash} from 'node:crypto';
import {closeSync,existsSync,lstatSync,openSync,readFileSync,unlinkSync,writeSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {copyClosedDataRoot,type DataCopyProgress,type DataCopyResult} from './localDataCopy.ts';
import {atomicWriteFile} from './atomicFile.ts';
import {dataControlPaths,dataLocationHash,readDataLocationPointer} from './dataLocation.ts';
export {dataControlPaths,dataLocationHash,readDataLocation,readDataLocationPointer,dataLocationSchema} from './dataLocation.ts';
/** Highest database schema this build may copy or open. Kept in the browser-safe
 * contract layer so the data-copy worker does not import persistence directly. */
export const CURRENT_DATA_SCHEMA_VERSION = 59;
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const path=z.string().min(1).max(4096);
export const dataCopyJobSchema=z.strictObject({format:z.literal('zhongshuo-data-job-v1'),id:z.uuid(),action:z.enum(['backup','import']),
  baseRoot:path,currentRoot:path,selectedSource:path,destinationParent:path,ownerPid:z.number().int().positive(),expectedLocationHash:z.string().regex(/^[a-f0-9]{64}$/).nullable()});
export type DataCopyJob=z.infer<typeof dataCopyJobSchema>;
export interface DataJobStatus{format:'zhongshuo-data-status-v1';id:string;state:'waiting-close'|'copying'|'succeeded'|'failed'|'unknown';stage?:'previous'|'selected';progress?:DataCopyProgress;
  result?:DataCopyResult;previous?:DataCopyResult;error?:string;recoveredReceipt?:boolean;at:number;}
export function dataJobPaths(job:DataCopyJob){const control=dataControlPaths(job.baseRoot);return{...control,job:join(control.root,`job-${job.id}.json`),status:join(control.root,`job-${job.id}.status.json`),lease:join(control.root,`job-${job.id}.started`)};}
const activeSchema=z.strictObject({format:z.literal('zhongshuo-data-active-v1'),id:z.uuid(),jobFile:path,workerPid:z.number().int().positive(),at:z.number().int().positive()});
export type DataActiveOperation=z.infer<typeof activeSchema>;

export function processAlive(pid:number){
  try{process.kill(pid,0);return true;}catch(error){return(error as NodeJS.ErrnoException).code!=='ESRCH';}
}

export function readActiveDataOperation(baseRoot:string):DataActiveOperation|null{
  const file=dataControlPaths(baseRoot).active;if(!existsSync(file))return null;
  const stat=lstatSync(file);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>32768)throw Error('DATA_ACTIVE_INVALID：数据操作状态不可读，请检查数据目录。');
  try{return activeSchema.parse(JSON.parse(readFileSync(file,'utf8')));}
  catch{throw Error('DATA_ACTIVE_INVALID：数据操作状态损坏，未自动继续或重复复制。');}
}

/** Claim the one host-wide data operation. A live different operation always
 * wins. Same-job ownership can pass from the closing UI process to its worker;
 * a dead owner is recoverable so a crash does not strand startup forever. */
export function claimActiveDataOperation(job:DataCopyJob,workerPid:number):DataActiveOperation{
  const paths=dataJobPaths(job),record:DataActiveOperation={format:'zhongshuo-data-active-v1',id:job.id,jobFile:paths.job,workerPid,at:Date.now()};
  for(let attempt=0;attempt<2;attempt++){
    try{
      const fd=openSync(paths.active,'wx',0o600);
      try{requireWrite(fd,JSON.stringify(record));}finally{closeSync(fd);}
      return record;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    }
    const previous=readActiveDataOperation(job.baseRoot);
    if(previous==null)continue;
    if(previous.id!==job.id)throw Error('DATA_OPERATION_IN_PROGRESS：另一项数据操作正在进行，请等待它结束。',{cause:previous});
    if(previous.workerPid===workerPid)return previous;
    // The host claims the job before it closes; the detached worker takes the
    // same job over once the host has committed to exiting. This handoff is
    // still serialized by the per-job lease below.
    if(previous.workerPid===job.ownerPid&&processAlive(previous.workerPid)){
      atomicWriteFile(paths.active,JSON.stringify(record));return record;
    }
    if(processAlive(previous.workerPid))throw Error('DATA_JOB_ALREADY_STARTED：本次数据操作仍在运行，不会重复复制。',{cause:previous});
    try{unlinkSync(paths.active);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  throw Error('DATA_OPERATION_BUSY：无法取得数据操作所有权，未开始复制。');
}

function requireWrite(fd:number,text:string){
  const bytes=Buffer.from(text,'utf8');
  let offset=0;
  while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)throw Error('DATA_CONTROL_WRITE_FAILED');offset+=n;}
}

export function releaseActiveDataOperation(job:DataCopyJob){
  const paths=dataJobPaths(job);
  try{const active=readActiveDataOperation(job.baseRoot);if(active?.id===job.id)unlinkSync(paths.active);}
  catch{/* Invalid/stale control facts are retained for diagnosis; copying is already stopped. */}
}

function writeStatus(job:DataCopyJob,status:DataJobStatus){
  const paths=dataJobPaths(job);atomicWriteFile(paths.status,JSON.stringify(status));return status;
}

export function readDataJobStatus(job:DataCopyJob):DataJobStatus|null{
  const paths=dataJobPaths(job);if(!existsSync(paths.status))return null;
  const stat=lstatSync(paths.status);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>65536)throw Error('DATA_JOB_INVALID：状态记录不可读，未再次复制。');
  const status=JSON.parse(readFileSync(paths.status,'utf8')) as DataJobStatus;
  if(status.id!==job.id||status.format!=='zhongshuo-data-status-v1')throw Error('DATA_JOB_INVALID：状态身份不匹配，未再次复制。');
  return status;
}

function terminalStatus(job:DataCopyJob):DataJobStatus|null{
  const status=readDataJobStatus(job);
  if(status==null)return null;
  return status.state==='succeeded'||status.state==='failed'||status.state==='unknown'?status:null;
}

export async function prepareDataCopyJob(job:DataCopyJob){
  const checked=dataCopyJobSchema.parse(job),paths=dataJobPaths(checked);
  if(existsSync(paths.job)){const previous=loadDataCopyJob(paths.job);if(JSON.stringify(previous)!==JSON.stringify(checked))throw Error('DATA_JOB_CONFLICT：同号数据操作参数不同，原记录保留。');return paths;}
  if(dataLocationHash(checked.baseRoot)!==checked.expectedLocationHash)throw Error('DATA_LOCATION_CHANGED：数据位置已变化，尚未开始复制。');
  await mkdir(paths.root,{recursive:true,mode:0o700});await writeFile(paths.job,JSON.stringify(checked),{flag:'wx',mode:0o600});
  atomicWriteFile(paths.status,JSON.stringify({format:'zhongshuo-data-status-v1',id:job.id,state:'waiting-close',at:Date.now()} satisfies DataJobStatus));
  return paths;
}
export function loadDataCopyJob(jobFile:string){
  const stat=lstatSync(jobFile);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>32768)throw Error('DATA_JOB_INVALID：数据操作记录不可读。');
  const job=dataCopyJobSchema.parse(JSON.parse(readFileSync(jobFile,'utf8')));
  if(resolve(jobFile)!==dataJobPaths(job).job)throw Error('DATA_JOB_INVALID：数据操作记录位置不匹配。');return job;
}
/** Read-only receipt recovery. The atomic pointer proves this operation
 * committed; the immutable manifest binds the completed copy without reading
 * or changing a profile that may already have been reopened. */
export function committedDataJobReceipt(job:DataCopyJob):DataJobStatus|null{
  if(job.action!=='import')return null;
  try{
    const pointer=readDataLocationPointer(job.baseRoot);
    if(pointer==null||pointer.baseKey!==pointer.control.key||pointer.operationId!==job.id)return null;
    const manifestFile=join(dirname(pointer.dataRoot),'data-copy-manifest.json'),stat=lstatSync(manifestFile);
    if(stat.isSymbolicLink()||stat.size>32*1024*1024)return null;
    const raw=readFileSync(manifestFile);if(sha(raw)!==pointer.manifestHash)return null;
    const manifest=JSON.parse(raw.toString('utf8')) as {format:string;status:string;files:unknown[];bytes:number;schemaVersion:number};
    if(manifest.format!=='zhongshuo-full-data-v1'||manifest.status!=='complete'||!Array.isArray(manifest.files)||!Number.isSafeInteger(manifest.bytes)||!Number.isInteger(manifest.schemaVersion))return null;
    return{format:'zhongshuo-data-status-v1',id:job.id,state:'succeeded',recoveredReceipt:true,at:Date.now(),result:{container:dirname(pointer.dataRoot),dataRoot:pointer.dataRoot,files:manifest.files.length,bytes:manifest.bytes,schemaVersion:manifest.schemaVersion,manifestHash:pointer.manifestHash}};
  }catch{return null;}
}

/** Startup reconciliation never starts/retries a copy. It only settles facts:
 * a committed pointer becomes success; an interrupted pre-commit worker becomes
 * unknown with the original root still selected. */
export function reconcileInterruptedDataOperation(baseRoot:string):DataJobStatus|null{
  const active=readActiveDataOperation(baseRoot);
  if(active==null)return null;
  const job=loadDataCopyJob(active.jobFile);
  const equal=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(!equal(resolve(job.baseRoot),resolve(baseRoot)))throw Error('DATA_ACTIVE_INVALID：数据操作不属于当前数据根，未自动处理。');
  const status=terminalStatus(job);
  if(processAlive(active.workerPid)){
    if(status!=null){writeStatus(job,status);releaseActiveDataOperation(job);}
    return status;
  }
  const committed=committedDataJobReceipt(job);
  if(committed!=null){writeStatus(job,committed);releaseActiveDataOperation(job);return committed;}
  if(status!=null){releaseActiveDataOperation(job);return status;}
  const interrupted:DataJobStatus={format:'zhongshuo-data-status-v1',id:job.id,state:'unknown',error:'DATA_OPERATION_INTERRUPTED：上次数据操作在完成前中断，原数据位置没有切换；未完成的副本已保留，未自动重复复制。请检查后重新发起操作。',at:Date.now()};
  writeStatus(job,interrupted);releaseActiveDataOperation(job);return interrupted;
}

function readLeasePid(job:DataCopyJob):number|null{
  const file=dataJobPaths(job).lease,a=lstatSync(file);
  if(a.isSymbolicLink()||!a.isFile()||a.size>1024)throw Error('DATA_JOB_INVALID：启动记录不可读，未再次复制。');
  const raw=readFileSync(file,'utf8').trim();
  try{
    const parsed=JSON.parse(raw) as {pid?:unknown;id?:unknown};
    if(parsed.id!=null&&parsed.id!==job.id)throw Error('DATA_JOB_INVALID：启动记录身份不匹配，未再次复制。');
    if(Number.isSafeInteger(parsed.pid)&&Number(parsed.pid)>0)return Number(parsed.pid);
  }catch(error){
    if(error instanceof Error&&error.message.startsWith('DATA_JOB_INVALID'))throw error;
  }
  const legacy=Number(raw);return Number.isSafeInteger(legacy)&&legacy>0?legacy:null;
}

/** The launcher/host must not reopen a root while its copy worker owns a job.
 * This runner never kills the old process, starts a model, or retries a business action. */
export async function runDataCopyJob(jobFile:string,input:{maxSchemaVersion:number;verifyDatabase:(copy:string)=>Promise<{schemaVersion:number}>|{schemaVersion:number};onStatus?:(status:DataJobStatus)=>void;waitForOwnerMs?:number}){
  const job=loadDataCopyJob(jobFile),paths=dataJobPaths(job);let previous:DataCopyResult|undefined,completed:DataCopyResult|undefined;
  const publish=(status:Omit<DataJobStatus,'format'|'id'|'at'>)=>{const value={format:'zhongshuo-data-status-v1' as const,id:job.id,at:Date.now(),...status};writeStatus(job,value);try{input.onStatus?.(value);}catch{/* An observer/closed progress window cannot undo a persisted receipt. */}return value;};
  const committed=committedDataJobReceipt(job);if(committed){const value=publish(committed);releaseActiveDataOperation(job);return value;}
  const last=terminalStatus(job);if(last){releaseActiveDataOperation(job);return last;}
  claimActiveDataOperation(job,process.pid);
  try{await writeFile(paths.lease,JSON.stringify({id:job.id,pid:process.pid,at:Date.now()}),{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='EEXIST'){
      const owner=readLeasePid(job);
      if(owner!=null&&processAlive(owner))throw Error('DATA_JOB_ALREADY_STARTED：本次操作已开始，查看现有进度；不会重复复制。',{cause:error});
      const recovered=committedDataJobReceipt(job);
      if(recovered){const value=publish(recovered);releaseActiveDataOperation(job);return value;}
      const interrupted=publish({state:'unknown',error:'DATA_OPERATION_INTERRUPTED：上次复制在完成前中断，原数据位置没有切换；未完成的副本已保留，未自动重复复制。'});
      releaseActiveDataOperation(job);return interrupted;
    }
    releaseActiveDataOperation(job);throw error;
  }
  try{
    publish({state:'waiting-close'});const deadline=performance.now()+(input.waitForOwnerMs??60000);
    while(processAlive(job.ownerPid)){if(performance.now()>=deadline)throw Error('DATA_CLOSE_TIMEOUT：原窗口尚未完全退出，未复制或强制关闭它。');await new Promise<void>(resolve=>setTimeout(resolve,100));}
    if(dataLocationHash(job.baseRoot)!==job.expectedLocationHash)throw Error('DATA_LOCATION_CHANGED：等待期间数据位置已变化，未切换。');
    const copy=async(source:string,kind:'backup'|'previous'|'import',stage:'previous'|'selected')=>{
      let lastPhase='',lastAt=0;
      return copyClosedDataRoot({source,destinationParent:job.destinationParent,kind,maxSchemaVersion:input.maxSchemaVersion,verifyDatabase:input.verifyDatabase,onProgress:progress=>{
        const now=performance.now();if(progress.phase===lastPhase&&now-lastAt<200)return;lastPhase=progress.phase;lastAt=now;publish({state:'copying',stage,progress,...(previous?{previous}:{})});
      }});
    };
    if(job.action==='import')previous=await copy(job.currentRoot,'previous','previous');
    const result=await copy(job.action==='backup'?job.currentRoot:job.selectedSource,job.action==='backup'?'backup':'import','selected');
    if(job.action==='backup')completed=result;
    if(job.action==='import'){
      if(dataLocationHash(job.baseRoot)!==job.expectedLocationHash)throw Error('DATA_LOCATION_CHANGED：复制已保全，但位置在操作期间变化；未覆盖新选择。');
      // Atomic pointer replacement is the sole commit point. No original root is
      // migrated, renamed, removed or overwritten. Startup may upgrade this copy.
      atomicWriteFile(paths.location,JSON.stringify({format:'zhongshuo-data-location-v1',baseKey:paths.key,operationId:job.id,dataRoot:result.dataRoot,manifestHash:result.manifestHash}));
      completed=result;
    }
    const value=publish({state:'succeeded',result,...(previous?{previous}:{})});releaseActiveDataOperation(job);return value;
  }catch(error){
    const committed=committedDataJobReceipt(job);
    if(committed){const value=publish({...committed,...(previous?{previous}:{})});releaseActiveDataOperation(job);return value;}
    if(completed){const value=publish({state:'succeeded',recoveredReceipt:true,result:completed,...(previous?{previous}:{})});releaseActiveDataOperation(job);return value;}
    const value=publish({state:'failed',error:error instanceof Error?error.message:'数据操作失败；原件保留',...(previous?{previous}:{})});releaseActiveDataOperation(job);return value;}
}
