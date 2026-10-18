/* R87 old-package import through the real settings UI.
 * Owned synthetic roots only. The source package is copied before use. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-empty */
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const sourcePackage=path.resolve(process.argv[2]);
const bSource=path.resolve(process.argv[3]);
const out=path.resolve(process.argv[4]);
const pkg=path.join(out,'package');
const fixture=path.join(out,'fixture');
const oldPackage=path.join(fixture,'old-portable');
const currentB=path.join(fixture,'current-b');
const staleA=path.join(oldPackage,'server-data');
const importParent=path.join(out,'imported');
const pickFile=path.join(out,'data-picks.txt');
const evidenceFile=path.join(out,'result.json');
const sha=value=>createHash('sha256').update(value).digest('hex');
const must=(value,label)=>{if(!value)throw Error(label);};
let child=null;

function copyTree(from,to){fs.cpSync(from,to,{recursive:true,errorOnExist:true,force:false});}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value),'utf8');}
function dbFacts(root){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'r87-oldpkg-db-'));
  try{
    for(const name of ['state.sqlite','state.sqlite-wal','state.sqlite-shm']){
      const from=path.join(root,name);if(fs.existsSync(from))fs.copyFileSync(from,path.join(scratch,name));
    }
    const db=new Database(path.join(scratch,'state.sqlite'),{readonly:true,fileMustExist:true});
    try{
      const project=db.prepare('SELECT id,display_name AS displayName FROM projects ORDER BY rowid LIMIT 1').get()??null;
      const message=db.prepare("SELECT id,body_json FROM messages WHERE author_type='human' ORDER BY rowid LIMIT 1").get()??null;
      return{
        project,
        messageCount:db.prepare('SELECT count(*) n FROM messages').get().n,
        message:message==null?null:{id:message.id,bodySha256:sha(Buffer.from(message.body_json??''))},
        realCalls:db.prepare('SELECT count(*) n FROM real_calls').get().n,
      };
    }finally{db.close();}
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
function updateProjectName(root,name){
  const db=new Database(path.join(root,'state.sqlite'),{fileMustExist:true});
  try{
    db.prepare('UPDATE projects SET display_name=? WHERE id=(SELECT id FROM projects ORDER BY rowid LIMIT 1)').run(name);
    db.pragma('wal_checkpoint(TRUNCATE)');
  }finally{db.close();}
}
function pointerFor(base,dataRoot){
  const resolved=path.resolve(base);
  const key=sha(Buffer.from(process.platform==='win32'?resolved.toLowerCase():resolved)).slice(0,16);
  const control=path.join(path.dirname(resolved),`.zhongshuo-data-${key}`);
  fs.mkdirSync(control);
  writeJson(path.join(control,'location.json'),{
    format:'zhongshuo-data-location-v1',
    baseKey:key,
    operationId:randomUUID(),
    dataRoot,
    manifestHash:'0'.repeat(64),
  });
  return control;
}
function prepare(){
  fs.mkdirSync(fixture,{recursive:true});
  copyTree(sourcePackage,pkg);
  copyTree(bSource,currentB);
  copyTree(bSource,staleA);
  fs.writeFileSync(path.join(currentB,'electron-user-data','r87-current-b-marker.txt'),'CURRENT-B','utf8');
  fs.writeFileSync(path.join(staleA,'electron-user-data','r87-stale-a-marker.txt'),'STALE-A','utf8');
  writeJson(path.join(staleA,'root-identity.json'),{dataRootId:'r87-stale-a'});
  updateProjectName(currentB,'R87 CURRENT B');
  updateProjectName(staleA,'R87 STALE A');
  const pointer=pointerFor(staleA,currentB);
  fs.mkdirSync(importParent);
  fs.writeFileSync(pickFile,[oldPackage,importParent].join('\r\n'),'utf8');
  return{pointer,before:dbFacts(currentB),stale:dbFacts(staleA),currentIdentity:JSON.parse(fs.readFileSync(path.join(currentB,'root-identity.json'),'utf8'))};
}
function startBat(){
  child=spawn('cmd.exe',['/d','/c','start-desktop.bat'],{
    cwd:pkg,
    env:{...process.env,ZS_DEV25_DEBUG_PORT:'0',ZS_DATA_PICK_FILE:pickFile},
    windowsHide:true,
    stdio:'ignore',
  });
  child.unref();
}
function addPort(ports,file){
  try{const value=Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]);if(Number.isInteger(value)&&value>0)ports.add(value);}catch{}
}
function ports(){
  const found=new Set();
  addPort(found,path.join(pkg,'server-data','electron-user-data','DevToolsActivePort'));
  try{
    for(const entry of fs.readdirSync(importParent,{withFileTypes:true})){
      if(entry.isDirectory())addPort(found,path.join(importParent,entry.name,'data','electron-user-data','DevToolsActivePort'));
    }
  }catch{}
  return[...found];
}
async function findPage(){
  for(const port of ports()){
    try{
      const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json());
      const page=rows.find(row=>row.type==='page'&&row.url.includes('index.html'));
      if(page!=null)return{port,page};
    }catch{}
  }
  return null;
}
async function connect(){
  return until(async()=>{
    const found=await findPage();if(found==null)return null;
    const ws=new WebSocket(found.page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    const cdp=new Cdp(ws);await cdp.send('Runtime.enable');
    await until(()=>cdp.eval('document.body?.classList.contains("hifi-on")'),Boolean,'app ready',30000);
    return{cdp,port:found.port};
  },Boolean,'owned app',120000);
}
async function waitClosed(){
  await until(async()=>await findPage()==null,Boolean,'app closed for data operation',60000);
}
async function close(cdp){
  try{await cdp.eval('window.zsWindow.close();true');}catch{}
  cdp.ws.close();
}
async function screenshot(cdp,name){
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(shot.data,'base64'));
}

(async()=>{
  if(fs.existsSync(out))throw Error(`owned evidence directory already exists: ${out}`);
  fs.mkdirSync(out);
  const fixtureFacts=prepare();
  startBat();
  let app=await connect();
  const identityBefore=await app.cdp.eval(`window.zs.command({protocolVersion:1,commandId:'r87-oldpkg-${randomUUID()}',method:'app.identity',params:{}})`)
    .then(result=>{must(result.ok,'app.identity failed');return result.data;});
  must(path.resolve(identityBefore.appDataDir)===path.resolve(path.join(pkg,'server-data')),'initial package root');
  await app.cdp.eval(`location.hash='#/settings?section=data';true`);
  await until(()=>app.cdp.eval('document.querySelector("[data-zs-data-import]")!=null'),Boolean,'data settings',30000);
  await screenshot(app.cdp,'settings-before-old-package-import');
  must(await app.cdp.eval(`(()=>{const button=document.querySelector('[data-zs-data-import]');if(!button||button.disabled)return false;button.click();return true})()`),'import button');
  await waitClosed();
  app=await connect();
  const identityAfter=await app.cdp.eval(`window.zs.command({protocolVersion:1,commandId:'r87-oldpkg-${randomUUID()}',method:'app.identity',params:{}})`)
    .then(result=>{must(result.ok,'identity after import');return result.data;});
  const importedRoot=path.resolve(identityAfter.appDataDir);
  const relative=path.relative(importParent,importedRoot);
  must(relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative),'imported root is a new copy');
  must(path.resolve(importedRoot)!==path.resolve(currentB),'imported root is not source');
  const after=dbFacts(importedRoot);
  const importedIdentity=JSON.parse(fs.readFileSync(path.join(importedRoot,'root-identity.json'),'utf8'));
  const currentMarker=path.join(importedRoot,'electron-user-data','r87-current-b-marker.txt');
  const staleMarker=path.join(importedRoot,'electron-user-data','r87-stale-a-marker.txt');
  const status=await app.cdp.eval('window.zsData.status()');
  await screenshot(app.cdp,'after-old-package-import');
  const baselineCalls=after.realCalls;
  await close(app.cdp);
  await waitClosed();
  startBat();
  app=await connect();
  const identityReopen=await app.cdp.eval(`window.zs.command({protocolVersion:1,commandId:'r87-oldpkg-${randomUUID()}',method:'app.identity',params:{}})`)
    .then(result=>{must(result.ok,'identity after BAT reopen');return result.data;});
  const afterReopen=dbFacts(identityReopen.appDataDir);
  await screenshot(app.cdp,'bat-reopen-imported-old-package-current-root');
  await close(app.cdp);
  const checks={
    oldPackagePointerResolved:true,
    importedNewCopy:true,
    currentRootIdentity:JSON.stringify(importedIdentity)===JSON.stringify(fixtureFacts.currentIdentity),
    currentProfileMarker:fs.existsSync(currentMarker)&&fs.readFileSync(currentMarker,'utf8')==='CURRENT-B',
    staleProfileAbsent:!fs.existsSync(staleMarker),
    currentProject:after.project?.displayName==='R87 CURRENT B'&&fixtureFacts.stale.project?.displayName==='R87 STALE A',
    currentMessage:after.message?.id===fixtureFacts.before.message?.id&&after.message?.bodySha256===fixtureFacts.before.message?.bodySha256,
    importSucceeded:status?.latest?.action==='import'&&status?.latest?.state==='succeeded',
    normalBatReopenSameRoot:path.resolve(identityReopen.appDataDir)===importedRoot,
    noNewModelCalls:afterReopen.realCalls===baselineCalls,
  };
  const result={
    format:'zhongshuo-r87-old-package-ui-import-v1',
    ok:Object.values(checks).every(Boolean),
    package:pkg,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    oldPackage,selectedSavedRoot:currentB,stalePhysicalRoot:staleA,staleControlPointer:fixtureFacts.pointer,
    importedRoot,
    facts:{before:fixtureFacts.before,staleFixture:fixtureFacts.stale,after,baselineCalls,afterReopen,status},
    checks,
    boundaries:[
      'Owned synthetic old-package fixture only; no user root, account, credential or document was read.',
      'The old package has already switched to current B through location.json; its physical server-data contains stale A.',
      'Actual UI import used the packaged app, normal close worker and BAT reopen. This evidence covers one valid pointer; permanent tests cover missing/invalid pointers and immutable backup containers.',
    ],
    at:new Date().toISOString(),
  };
  writeJson(evidenceFile,result);
  console.log(JSON.stringify({ok:result.ok,evidence:evidenceFile,checks},null,2));
  if(!result.ok)process.exitCode=1;
})().catch(error=>{
  try{fs.mkdirSync(out,{recursive:true});writeJson(evidenceFile,{format:'zhongshuo-r87-old-package-ui-import-v1',ok:false,error:error.stack??String(error),at:new Date().toISOString()});}catch{}
  console.error(error.stack??error);
  process.exitCode=1;
});
