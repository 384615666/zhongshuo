/** Runs only after an explicit local data operation. No daemon or model dispatch. */
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import {CURRENT_DATA_SCHEMA_VERSION,dataJobPaths,loadDataCopyJob,runDataCopyJob,processAlive,type DataJobStatus} from '../contracts/dataCopyJob.ts';
import {atomicWriteFile} from '../contracts/atomicFile.ts';

const appRoot=resolve(__dirname,'..','..'),packaged=existsSync(join(appRoot,'daemon','daemon.cjs'));
const electron=packaged?resolve(appRoot,'..','..','electron.exe'):join(appRoot,'node_modules','electron','dist','electron.exe');
const appArgs=packaged?[]:[appRoot];
const debugPort=process.env.ZS_DEV25_DEBUG_PORT;
const relaunchArgs=[...appArgs,...(debugPort?['--remote-debugging-port=0']:[])];
async function main(){
const file=process.argv[2];if(!file)throw Error('DATA_JOB_MISSING');
const job=loadDataCopyJob(file),paths=dataJobPaths(job);
const require=createRequire(join(appRoot,'package.json'));
const Database=require(packaged?join(appRoot,'daemon','node_modules','better-sqlite3'):'better-sqlite3') as typeof DatabaseConstructor;
let progress:ChildProcess|undefined;
const startProgress=()=>{if(progress||!existsSync(electron))return;const child=spawn(electron,[...appArgs,'--zs-data-progress-job',file],{windowsHide:false,stdio:'ignore',env:{...process.env,ZS_APP_DATA:job.baseRoot}});progress=child;child.on('error',()=>{if(progress===child)progress=undefined;});};
let result:DataJobStatus;
try{
  result=await runDataCopyJob(file,{maxSchemaVersion:CURRENT_DATA_SCHEMA_VERSION,verifyDatabase:path=>{
    const db=new Database(path,{readonly:true,fileMustExist:true});
    try{if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw Error('DATA_DATABASE_INVALID：数据校验未通过，未启用副本。');return{schemaVersion:db.pragma('user_version',{simple:true}) as number};}finally{db.close();}
  },onStatus:status=>{if(status.state==='waiting-close'||status.state==='copying')startProgress();},waitForOwnerMs:120000});
}catch(error){
  // A duplicate worker never changes or retries the original operation.
  const message=error instanceof Error?error.message:'数据操作没有完成';
  if(message.startsWith('DATA_JOB_ALREADY_STARTED')||message.startsWith('DATA_OPERATION_IN_PROGRESS'))return;
  result={format:'zhongshuo-data-status-v1',id:job.id,state:'failed',error:message,at:Date.now()};
  atomicWriteFile(paths.status,JSON.stringify(result));
}
// The progress host observes the terminal receipt and closes itself. Bound the
// wait; it uses its own profile and never holds the source or destination root.
const progressChild=progress as ChildProcess|undefined;
if(progressChild){
  const child=progressChild;
  await Promise.race([new Promise<void>(done=>{child.once('exit',()=>done());if(child.exitCode!==null)done();}),new Promise<void>(done=>setTimeout(done,12000))]);
  if(child.exitCode===null)try{child.kill();}catch{/* progress host may already be gone */}
}
if(result.state==='succeeded'||result.state==='failed'||result.state==='unknown'){
  if(!processAlive(job.ownerPid)){
    const child=spawn(electron,relaunchArgs,{detached:true,windowsHide:false,stdio:'ignore',env:{...process.env,ZS_APP_DATA:job.baseRoot}});child.on('error',()=>{});child.unref();
  }
}

}
void main().catch(error=>{const message=error instanceof Error?error.message:'未知原因';process.stderr.write(`数据副本操作未完成：${message}\n`);process.exitCode=1;});
