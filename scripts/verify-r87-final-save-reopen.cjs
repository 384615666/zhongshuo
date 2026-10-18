/* Save the accepted R87 report through the packaged preview, then reopen with
 * the normal BAT and verify that accepted identity, bytes and call count hold. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-empty */
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const pkg=path.resolve(process.argv[2]);
const project=path.resolve(process.argv[3]);
const out=path.resolve(process.argv[4]);
const initialPort=Number(process.argv[5]);
const savedDir=path.join(out,'saved');
const reportName='报告复核-v2.md';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const must=(value,label)=>{if(!value)throw Error(label);};
let child=null;

function dbRows(sql,...args){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare(sql).all(...args);}finally{db.close();}
}
function dbRow(sql,...args){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare(sql).get(...args)??null;}finally{db.close();}
}
function portFile(){try{return Number(fs.readFileSync(path.join(pkg,'server-data','electron-user-data','DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);}catch{return 0;}}
async function findPage(){
  for(const port of [...new Set([initialPort,portFile()].filter(value=>Number.isInteger(value)&&value>0))]){
    try{
      const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
      const page=rows.find(row=>row.type==='page'&&row.url.includes('index.html'));
      if(page!=null)return page;
    }catch{}
  }
  return null;
}
async function connect(){
  return until(async()=>{
    const page=await findPage();if(page==null)return null;
    const ws=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    const cdp=new Cdp(ws);await cdp.send('Runtime.enable');
    await until(()=>cdp.eval('document.body?.classList.contains("hifi-on")'),Boolean,'app ready',30000);
    return cdp;
  },Boolean,'owned app',120000);
}
function startBat(){
  child=spawn('cmd.exe',['/d','/c','start-desktop.bat'],{
    cwd:pkg,
    env:{...process.env,ZS_DEV25_DEBUG_PORT:'0'},
    windowsHide:true,
    stdio:'ignore',
  });
  child.unref();
}
async function shot(cdp,name){
  await cdp.send('Page.bringToFront');
  await sleep(250);
  const image=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(image.data,'base64'));
}
async function close(cdp){
  try{await cdp.eval('window.zsWindow.close();true');}catch{}
  cdp.ws.close();
  await until(async()=>await findPage()==null,Boolean,'app closed',60000);
}

(async()=>{
  fs.mkdirSync(savedDir,{recursive:true});
  const task=dbRow("SELECT id,conversation_thread_id,status,current_delivery_id FROM tasks WHERE current_delivery_id IS NOT NULL AND status='DONE' ORDER BY rowid LIMIT 1");
  must(task?.conversation_thread_id,'completed task');
  const delivery=dbRow('SELECT id,task_id,revision,manifest_hash,review_status FROM task_deliveries WHERE id=?',task.current_delivery_id);
  must(delivery?.review_status==='accepted','accepted delivery');
  const projectRow=dbRow('SELECT id FROM projects ORDER BY rowid LIMIT 1');
  const room=dbRow('SELECT id FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1',projectRow.id);
  const callsBefore=dbRows('SELECT runtime_kind,model,status,task_id FROM real_calls ORDER BY rowid');
  const sourceFile=path.join(project,reportName);
  must(fs.existsSync(sourceFile),'report file');
  const sourceHash=sha(sourceFile);

  let cdp=await connect();
  await cdp.eval(`location.hash='#/project/${projectRow.id}/files';true`);
  await until(()=>cdp.eval(`document.querySelector('button.file-row[title=${JSON.stringify(reportName)}]')!=null`),Boolean,'report row',30000);
  must(await cdp.eval(`(()=>{const button=document.querySelector('button.file-row[title=${JSON.stringify(reportName)}]');if(!button)return false;button.click();return true})()`),'open report preview');
  await until(()=>cdp.eval('document.querySelector(".preview-pane .md-view")!=null'),Boolean,'report preview ready',60000);
  await until(()=>cdp.eval('document.querySelector("button[aria-label=\\"下载原文件\\"]")?.disabled===false'),Boolean,'save ready',60000);
  const savedFile=path.join(savedDir,reportName);
  if(!fs.existsSync(savedFile)||sha(savedFile)!==sourceHash){
    must(await cdp.eval(`(()=>{const button=document.querySelector('button[aria-label="下载原文件"]');if(!button||button.disabled)return false;button.click();return true})()`),'save report');
  }
  await until(()=>fs.existsSync(savedFile),Boolean,'saved report',30000);
  must(sha(savedFile)===sourceHash,'saved bytes match');
  await shot(cdp,'v2-preview-saved');
  await close(cdp);

  startBat();
  cdp=await connect();
  await cdp.eval(`location.hash='#/project/${projectRow.id}/room/${room.id}?thread=${task.conversation_thread_id}';true`);
  await until(()=>cdp.eval('document.querySelector(".col-thread")!=null'),Boolean,'reopened thread',60000);
  await sleep(500);
  await shot(cdp,'reopened-completed');
  const callsAfter=dbRows('SELECT runtime_kind,model,status,task_id FROM real_calls ORDER BY rowid');
  const taskAfter=dbRow('SELECT id,conversation_thread_id,status,current_delivery_id FROM tasks WHERE id=?',task.id);
  const deliveryAfter=dbRow('SELECT id,task_id,revision,manifest_hash,review_status FROM task_deliveries WHERE id=?',delivery.id);
  const checks={
    savedBytes:sha(savedFile)===sourceHash,
    acceptedDeliveryBefore:delivery.review_status==='accepted',
    acceptedDeliveryAfter:deliveryAfter?.review_status==='accepted',
    sameTask:taskAfter?.id===task.id&&taskAfter?.status==='DONE',
    exactCurrentDelivery:taskAfter?.current_delivery_id===delivery.id,
    noNewModelCalls:JSON.stringify(callsAfter)===JSON.stringify(callsBefore),
  };
  const result={
    format:'zhongshuo-r87-final-save-reopen-v1',
    ok:Object.values(checks).every(Boolean),
    package:pkg,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    project,out,task:taskAfter,delivery:deliveryAfter,
    calls:{count:callsAfter.length,before:callsBefore,after:callsAfter},
    files:{source:{name:reportName,bytes:fs.statSync(sourceFile).size,sha256:sourceHash},saved:{name:reportName,bytes:fs.statSync(savedFile).size,sha256:sha(savedFile)}},
    checks,
    at:new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out,'save-reopen.json'),JSON.stringify(result,null,2),'utf8');
  await close(cdp);
  console.log(JSON.stringify({ok:result.ok,evidence:path.join(out,'save-reopen.json'),checks,calls:callsAfter.length},null,2));
  if(!result.ok)process.exitCode=1;
})().catch(error=>{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'save-reopen.json'),JSON.stringify({format:'zhongshuo-r87-final-save-reopen-v1',ok:false,error:error.stack??String(error),at:new Date().toISOString()},null,2),'utf8');
  console.error(error.stack??error);
  process.exitCode=1;
});
