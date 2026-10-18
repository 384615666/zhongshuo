/* Read-only board navigation and recovery-summary probe on an owned package. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-empty */
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const pkg=path.resolve(process.argv[2]);
const project=path.resolve(process.argv[3]);
const out=path.resolve(process.argv[4]);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const must=(value,label)=>{if(!value)throw Error(label);};
let child=null;
let cdp=null;

function realCalls(){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare('SELECT count(*) n FROM real_calls').get().n;}finally{db.close();}
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
  await cdp.send('Page.bringToFront');await sleep(250);
  const image=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(image.data,'base64'));
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  let projectId;
  try{projectId=db.prepare('SELECT id FROM projects ORDER BY rowid LIMIT 1').get().id;}finally{db.close();}
  const callsBefore=realCalls();
  startBat();
  cdp=await connect();
  await cdp.eval(`location.hash='#/board?scope=project&projectId=${projectId}';true`);
  await until(()=>cdp.eval('document.body.innerText.includes("在任务详情中处理")'),Boolean,'board route',30000);
  await until(()=>cdp.eval('document.body.innerText.includes("你好")'),Boolean,'board tasks',30000);
  const boardText=await cdp.eval('document.body.innerText');
  await shot(cdp,'board-project-tasks');

  const recoveryPoint=await cdp.eval(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='恢复检查');if(!button)return null;const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  must(recoveryPoint,'recovery entry');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:recoveryPoint.x,y:recoveryPoint.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:recoveryPoint.x,y:recoveryPoint.y,button:'left',clickCount:1});
  await until(()=>cdp.eval('document.querySelector("[role=dialog][aria-label=\\"恢复检查\\"]")!=null'),Boolean,'recovery dialog',30000);
  await until(()=>cdp.eval('document.querySelector("[role=dialog][aria-label=\\"恢复检查\\"]")?.innerText.includes("只检查，不自动重发消息或解除文件保护")'),Boolean,'recovery facts',30000);
  const recovery=await cdp.eval(`(()=>{const dialog=document.querySelector('[role=dialog][aria-label="恢复检查"]');const summary=dialog?.querySelector('[data-zs-recovery-summary="1"]')?.innerText??'';return{dialog:dialog?.innerText??'',summary}})()`);
  await shot(cdp,'recovery-user-summary');
  const detailPoint=await cdp.eval(`(()=>{const dialog=document.querySelector('[role=dialog][aria-label="恢复检查"]');const button=[...dialog.querySelectorAll('button')].find(item=>item.textContent.trim()==='查看详情');if(!button)return null;const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  must(detailPoint,'recovery details button');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:detailPoint.x,y:detailPoint.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:detailPoint.x,y:detailPoint.y,button:'left',clickCount:1});
  await until(()=>cdp.eval('document.querySelector("[role=dialog][aria-label=\\"恢复检查\\"]")?.innerText.includes("详细状态与人工处理（高级）")'),Boolean,'advanced recovery details',30000);
  const detailOpened=await cdp.eval('document.querySelector("[role=dialog][aria-label=\\"恢复检查\\"]")?.innerText.includes("详细状态与人工处理（高级）")===true');
  await shot(cdp,'recovery-advanced-details');

  await cdp.eval(`(()=>{const dialog=document.querySelector('[role=dialog][aria-label="恢复检查"]');const button=[...dialog.querySelectorAll('button')].find(item=>item.textContent.trim()==='关闭');if(button)button.click();return true})()`);
  await until(()=>cdp.eval('document.querySelector("[role=dialog][aria-label=\\"恢复检查\\"]")==null'),Boolean,'recovery closed',10000);
  await cdp.eval(`location.hash='#/project/${projectId}/members';true`);
  await until(()=>cdp.eval('document.querySelector("[data-zs-members]")!=null'),Boolean,'members route',30000);
  await until(()=>cdp.eval(`(()=>{const text=document.body.innerText;return text.includes('可复用的成员模板')&&(document.querySelector('[data-zs-template-list]')!=null||text.includes('暂无配置模板'))})()`),Boolean,'template section',30000);
  await until(()=>cdp.eval(`[...document.querySelectorAll('button[data-zs-member-template]')].some(button=>!button.disabled)`),Boolean,'configured member template entry',30000);
  const templateFormOpened=await cdp.eval(`(()=>{const button=[...document.querySelectorAll('button[data-zs-member-template]')].find(item=>!item.disabled);if(!button)return false;button.click();return true})()`);
  must(templateFormOpened,'template form entry');
  await until(()=>cdp.eval('document.querySelector("[data-zs-template-name]")!=null&&document.body.innerText.includes("保存配置模板")'),Boolean,'template form',30000);
  const templateForm=await cdp.eval(`(()=>{const name=document.querySelector('[data-zs-template-name]');const save=document.querySelector('[data-zs-template-save]');return{nameEnabled:name!=null&&!name.disabled,saveWaitsForName:save!=null&&save.disabled,text:document.querySelector('.modal')?.innerText??''}})()`);
  await shot(cdp,'members-save-template-form');
  await cdp.eval(`(()=>{const button=[...document.querySelectorAll('.modal button')].find(item=>item.textContent.trim()==='取消');if(button)button.click();return true})()`);
  const checks={
    boardRouteVisible:boardText.includes('范围')&&boardText.includes('你好')&&boardText.includes('进行中')&&boardText.includes('已完成'),
    recoveryVisible:recovery.dialog.includes('只检查，不自动重发消息或解除文件保护'),
    normalSummaryReadable:recovery.summary.length===0||!/pendingDispatchKeys|turn_[a-f0-9-]{8,}|task_[a-f0-9-]{8,}/i.test(recovery.summary),
    advancedDetailsClosedByDefault:!recovery.dialog.includes('详细状态与人工处理（高级）'),
    advancedDetailsOpenable:detailOpened,
    templateSectionVisible:true,
    templateFormReachable:templateForm.nameEnabled&&templateForm.text.includes('不复制凭据')&&templateForm.text.includes('保存模板'),
    noNewModelCalls:realCalls()===callsBefore,
  };
  const result={
    format:'zhongshuo-r87-board-recovery-v1',
    ok:Object.values(checks).every(Boolean),
    package:pkg,project,projectId,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    checks,boardText,recovery,templateForm,realCallsBefore:callsBefore,realCallsAfter:realCalls(),
    at:new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');
  try{await cdp.eval('window.zsWindow.close();true');}catch{}
  cdp.ws.close();
  console.log(JSON.stringify({ok:result.ok,evidence:path.join(out,'result.json'),checks},null,2));
  if(!result.ok)process.exitCode=1;
})().catch(error=>{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({format:'zhongshuo-r87-board-recovery-v1',ok:false,error:error.stack??String(error),at:new Date().toISOString()},null,2),'utf8');
  try{cdp?.ws.close();}catch{}
  console.error(error.stack??error);
  process.exitCode=1;
});
