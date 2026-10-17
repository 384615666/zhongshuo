/**
 * R87 local-only data guide probe. Uses the built daily BAT, native main bridge,
 * detached worker, independent progress host and a normal relaunch. No model is
 * started and no source/profile path is printed in the evidence JSON.
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

const repo=path.resolve(__dirname,'..');
const pkg=path.resolve(process.argv[2]??path.join(repo,'dist','desktop','desktop-daily-win-r87-data-probe'));
const port=Number(process.argv[3]??9477);
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const evidenceRoot=path.join(repo,'dist','review-r87-source',`r87-data-copy-probe-${stamp}`);
const backupParent=path.join(evidenceRoot,'backup');
const importParent=path.join(evidenceRoot,'imported');
const pickFile=path.join(evidenceRoot,'data-picks.txt');
const logs=[];
let bat=null;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const must=(ok,message)=>{if(!ok)throw Error(message);};
async function until(fn,label,timeout=120000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}await sleep(300);}
  throw Error(`${label}超时${last==null?'':`：${last.message??last}`}`);
}
function writePicks(...lines){fs.writeFileSync(pickFile,lines.join('\r\n'),'utf8');}
function sendBatKey(){
  if(bat==null)return;
  try{bat.stdin?.write('\n');}catch{/* hidden own console */}
}
function startBat(){
  const child=spawn('cmd.exe',['/d','/c','start-desktop.bat'],{
    cwd:pkg,
    env:{...process.env,ZS_DEV25_DEBUG_PORT:'0',ZS_DATA_PICK_FILE:pickFile},
    windowsHide:true,
    // The BAT already creates its own application window. Do not attach the
    // Electron child to this probe's stdout pipe: a later probe exit can turn
    // that pipe into EPIPE and show a false main-process error dialog.
    stdio:'ignore',
  });
  bat=child;
  child.unref();
  return child;
}
function addPortFile(set,file){
  try{
    const value=Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]);
    if(Number.isInteger(value)&&value>0)set.add(value);
  }catch{/* not running yet */}
}
function ports(){
  const found=new Set([port]);
  addPortFile(found,path.join(pkg,'server-data','electron-user-data','DevToolsActivePort'));
  if(fs.existsSync(importParent)){
    for(const entry of fs.readdirSync(importParent,{withFileTypes:true})){
      if(entry.isDirectory())addPortFile(found,path.join(importParent,entry.name,'data','electron-user-data','DevToolsActivePort'));
    }
  }
  return [...found];
}
async function page(){
  for(const candidate of ports()){
    try{
      const list=await fetch(`http://127.0.0.1:${candidate}/json/list`,{signal:AbortSignal.timeout(800)}).then(r=>r.json());
      const found=list.find(item=>item.type==='page'&&item.url.includes('index.html'));
      if(found)return found;
    }catch{/* try the next owned app port */}
  }
  return null;
}
async function connect(){
  const target=await until(page,'众说窗口');
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let seq=0;const pending=new Map();
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    const settle=pending.get(message.id);
    if(settle){pending.delete(message.id);if(message.error)settle.reject(Error(message.error.message));else settle.resolve(message.result);}
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails!=null)throw Error(result.exceptionDetails.text??'页面执行失败');
    return result.result?.value;
  };
  await send('Runtime.enable');
  await until(()=>evaluate('document.body?.classList.contains("hifi-on")'),'界面装载',30000);
  return {ws,send,evaluate,close:()=>ws.close()};
}
async function screenshot(c,name){
  const shot=await c.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidenceRoot,`${name}.png`),Buffer.from(shot.data,'base64'));
}
async function identity(c){
  return c.evaluate(`window.zs.command({protocolVersion:1,commandId:'probe-identity-'+Date.now(),method:'app.identity',params:{}})`);
}
async function dataStatus(c){
  return c.evaluate('window.zsData.status()');
}
async function openSettings(c){
  await c.evaluate('location.hash="#/settings?section=data"');
  await until(()=>c.evaluate('Boolean(document.querySelector("[data-zs-data-backup]"))'),'数据设置');
  await sleep(300);
}
async function clickAction(c,name){
  const selector=name==='backup'?'[data-zs-data-backup]':'[data-zs-data-import]';
  await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function waitClosed(){
  await until(async()=>!(await page()),'应用关闭',30000);
}
async function waitReopened(){
  return connect();
}
async function closeApp(c){
  try{await c.evaluate('void window.zsWindow.close(); true');}catch{/* connection closes with the window */}
  c.close();
  await waitClosed();
}
function containers(root){
  if(!fs.existsSync(root))return [];
  return fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.join(root,entry.name));
}
function verifyManifest(container){
  const manifest=JSON.parse(fs.readFileSync(path.join(container,'data-copy-manifest.json'),'utf8'));
  must(manifest.format==='zhongshuo-full-data-v1'&&manifest.status==='complete','备份清单未完整完成');
  must(Array.isArray(manifest.files)&&manifest.files.length>0,'备份清单文件为空');
  let checked=0;
  for(const file of manifest.files){
    must(typeof file.path==='string'&&!path.isAbsolute(file.path)&&!file.path.split(/[\\/]/).includes('..'),'备份清单路径越界');
    const actual=path.join(container,'data',file.path);
    must(fs.existsSync(actual)&&fs.statSync(actual).size===file.bytes,'备份文件大小不符');
    must(sha(actual)===file.sha256,'备份文件hash不符');
    checked+=1;
  }
  return{checked,bytes:manifest.bytes,schemaVersion:manifest.schemaVersion};
}

(async()=>{
  fs.mkdirSync(backupParent,{recursive:true});
  fs.mkdirSync(importParent,{recursive:true});
  writePicks(backupParent);
  startBat();
  let c=await connect();
  const identityBefore=await identity(c);
  must(identityBefore.ok===true,'app.identity 失败');
  must(path.resolve(identityBefore.data.appDataDir)===path.resolve(path.join(pkg,'server-data')),'首次数据位置不是包内默认根');
  await openSettings(c);
  await screenshot(c,'settings-before-backup');
  await clickAction(c,'backup');
  await waitClosed();
  c=await waitReopened();
  const backupStatus=await dataStatus(c);
  must(backupStatus.latest?.action==='backup'&&backupStatus.latest.state==='succeeded','备份未收敛为成功');
  const backupContainers=containers(backupParent);
  must(backupContainers.length===1,'未生成唯一备份目录');
  const backupFacts=verifyManifest(backupContainers[0]);
  await screenshot(c,'after-backup-reopen');

  writePicks(backupContainers[0],importParent);
  await openSettings(c);
  await clickAction(c,'import');
  await waitClosed();
  c=await waitReopened();
  const identityImported=await identity(c);
  must(identityImported.ok===true,'恢复后 app.identity 失败');
  const importedRoot=path.resolve(identityImported.data.appDataDir);
  must(path.relative(importParent,importedRoot)!==''&&!path.relative(importParent,importedRoot).startsWith('..'),'恢复后未使用新副本');
  must(path.basename(importedRoot)==='data','恢复后数据根不是完整副本');
  const importedState=path.join(importedRoot,'state.sqlite');
  must(fs.existsSync(importedState),'恢复副本缺少 state.sqlite');
  const statusAfterImport=await dataStatus(c);
  must(statusAfterImport.latest?.action==='import'&&statusAfterImport.latest.state==='succeeded','恢复未收敛为成功');
  await screenshot(c,'after-import-reopen');
  await closeApp(c);
  sendBatKey();
  await sleep(1000);

  startBat();
  c=await connect();
  const identityReopen=await identity(c);
  must(identityReopen.ok===true,'正常重开 app.identity 失败');
  must(path.resolve(identityReopen.data.appDataDir)===importedRoot,'正常 BAT 重开未记住已恢复的数据位置');
  await screenshot(c,'bat-reopen-imported-root');
  await closeApp(c);
  sendBatKey();
  await sleep(500);

  const evidence={
    format:'zhongshuo-r87-data-copy-probe-v1',
    ok:true,
    package:pkg,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    modelCalls:0,
    backup:{status:backupStatus.latest,manifest:backupFacts,containerCount:backupContainers.length},
    import:{status:statusAfterImport.latest,newRootIsNewCopy:true,stateSqliteHash:sha(importedState)},
    batReopen:{sameDataRoot:true},
    screenshots:['settings-before-backup.png','after-backup-reopen.png','after-import-reopen.png','bat-reopen-imported-root.png'],
    logs,
    at:new Date().toISOString(),
  };
  fs.writeFileSync(path.join(evidenceRoot,'result.json'),JSON.stringify(evidence,null,2),'utf8');
  console.log(JSON.stringify({ok:true,evidence:path.join(evidenceRoot,'result.json'),backupFiles:backupFacts.checked,modelCalls:0},null,2));
})().catch(error=>{
  fs.mkdirSync(evidenceRoot,{recursive:true});
  fs.writeFileSync(path.join(evidenceRoot,'result.json'),JSON.stringify({format:'zhongshuo-r87-data-copy-probe-v1',ok:false,error:error instanceof Error?error.stack??error.message:String(error),logs,at:new Date().toISOString()},null,2),'utf8');
  sendBatKey();
  console.error(error);
  process.exitCode=1;
});
