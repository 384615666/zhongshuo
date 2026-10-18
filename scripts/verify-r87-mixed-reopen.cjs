/* Verify saved mixed-model v2 bytes and accepted identity after the normal BAT
 * reopen. The earlier save/close probe remains preserved separately. */
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
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const must=(value,label)=>{if(!value)throw Error(label);};
let child=null;

function dbRow(sql,...args){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare(sql).get(...args)??null;}finally{db.close();}
}
function readPort(){
  try{return Number(fs.readFileSync(path.join(pkg,'server-data','electron-user-data','DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);}catch{return 0;}
}
async function page(){
  const port=readPort();if(!(port>0))return null;
  try{
    const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
    return rows.find(row=>row.type==='page'&&row.url.includes('index.html'))??null;
  }catch{return null;}
}
async function connect(){
  return until(async()=>{
    const target=await page();if(target==null)return null;
    const ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    const cdp=new Cdp(ws);await cdp.send('Runtime.enable');
    await until(()=>cdp.eval('document.body?.classList.contains("hifi-on")'),Boolean,'app ready',60000);
    return cdp;
  },Boolean,'reopened app',120000);
}
function startBat(){
  child=spawn('cmd.exe',['/d','/c','start-desktop.bat'],{cwd:pkg,env:{...process.env,ZS_DEV25_DEBUG_PORT:'0'},windowsHide:true,stdio:'ignore'});
  child.unref();
}
async function shot(cdp,name){
  await cdp.send('Page.bringToFront');await sleep(300);
  const image=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(image.data,'base64'));
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const source=path.join(project,'报告复核-v2.md');
  const saved=path.join(out,'saved','报告复核-v2.md');
  must(fs.existsSync(source)&&fs.existsSync(saved),'source and saved file');
  must(sha(source)===sha(saved),'saved bytes match source');
  const task=dbRow("SELECT id,conversation_thread_id,status,current_delivery_id FROM tasks WHERE parent_task_id IS NULL AND status='DONE' ORDER BY rowid LIMIT 1");
  const delivery=dbRow('SELECT id,task_id,revision,manifest_hash,review_status FROM task_deliveries WHERE id=?',task.current_delivery_id);
  const callsBefore=dbRow('SELECT count(*) AS n FROM real_calls').n;
  startBat();
  const cdp=await connect();
  const identity=await cdp.eval(`window.zs.command({protocolVersion:1,commandId:'r87-reopen',method:'app.identity',params:{}})`)
    .then(result=>{must(result.ok,'identity');return result.data;});
  const room=dbRow('SELECT id FROM rooms WHERE project_id=(SELECT id FROM projects ORDER BY rowid LIMIT 1) ORDER BY rowid LIMIT 1');
  await cdp.eval(`location.hash='#/project/${dbRow('SELECT id FROM projects ORDER BY rowid LIMIT 1').id}/room/${room.id}?thread=${task.conversation_thread_id}';true`);
  await until(()=>cdp.eval('document.querySelector(".col-thread")!=null'),Boolean,'thread reopened',60000);
  await shot(cdp,'reopened-completed');
  const taskAfter=dbRow('SELECT id,conversation_thread_id,status,current_delivery_id FROM tasks WHERE id=?',task.id);
  const deliveryAfter=dbRow('SELECT id,task_id,revision,manifest_hash,review_status FROM task_deliveries WHERE id=?',delivery.id);
  const callsAfter=dbRow('SELECT count(*) AS n FROM real_calls').n;
  const result={
    format:'zhongshuo-r87-mixed-reopen-v1',
    ok:true,
    package:pkg,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    project,out,
    identity,
    task:taskAfter,delivery:deliveryAfter,
    calls:{before:callsBefore,after:callsAfter},
    file:{name:'报告复核-v2.md',bytes:fs.statSync(saved).size,sha256:sha(saved)},
    checks:{
      sameDataRoot:path.resolve(identity.appDataDir)===path.resolve(path.join(pkg,'server-data')),
      sameAcceptedDelivery:deliveryAfter?.review_status==='accepted'&&taskAfter?.current_delivery_id===delivery.id,
      savedBytes:sha(source)===sha(saved),
      noNewCalls:callsBefore===callsAfter,
      threadVisible:await cdp.eval('document.querySelector(".col-thread")?.innerText.includes("报告复核")===true'),
    },
    at:new Date().toISOString(),
  };
  result.ok=Object.values(result.checks).every(Boolean);
  fs.writeFileSync(path.join(out,'save-reopen-confirmed.json'),JSON.stringify(result,null,2),'utf8');
  try{await cdp.eval('window.zsWindow.close();true');}catch{}
  cdp.ws.close();
  console.log(JSON.stringify({ok:result.ok,evidence:path.join(out,'save-reopen-confirmed.json'),checks:result.checks},null,2));
  if(!result.ok)process.exitCode=1;
})().catch(error=>{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'save-reopen-confirmed.json'),JSON.stringify({format:'zhongshuo-r87-mixed-reopen-v1',ok:false,error:error.stack??String(error),at:new Date().toISOString()},null,2),'utf8');
  console.error(error.stack??error);
  process.exitCode=1;
});
