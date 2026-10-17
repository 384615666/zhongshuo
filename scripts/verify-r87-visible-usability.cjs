/* R87 same-BUILD visible interaction counterexamples. This uses Chromium
 * trusted input events at element coordinates and native dialog Esc, never
 * DOM .click()/value setters for the interaction under test. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const pkg=path.resolve(process.argv[2]);
const project=path.resolve(process.argv[3]);
const port=Number(process.argv[4]);
const out=path.resolve(process.argv[5]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const q=JSON.stringify;
const must=(v,m)=>{if(!v)throw Error(m);};
let cdp;

async function connect(){
  return until(async()=>{try{
    const list=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json());
    const page=list.find(x=>x.type==='page'&&x.url.includes('index.html'));if(!page)return null;
    const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    const c=new Cdp(ws);await c.send('Runtime.enable');await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'hifi',30000);return c;
  }catch{return null;}},Boolean,'owned UI',30000);
}
async function evalv(expression){return cdp.eval(expression);}
async function point(selector){
  return evalv(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()`);
}
async function pointText(text,scope='body',starts=false){
  const match=starts?`x.textContent.trim().startsWith(${q(text)})`:`x.textContent.trim()===${q(text)}`;
  return evalv(`(()=>{const root=document.querySelector(${q(scope)})??document;const e=[...root.querySelectorAll('button,a,summary')].find(x=>${match});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,tag:e.tagName}})()`);
}
async function mouseAt(p){
  must(p&&p.width>0&&p.height>0,'visible target');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});
}
async function click(selector){await mouseAt(await point(selector));}
async function clickText(text,scope='body',starts=false){await mouseAt(await pointText(text,scope,starts));}
async function key(key,code,modifiers=0,isComposing=false){
  const vk={Enter:13,Escape:27,Tab:9,Backspace:8,a:65}[key]??0;
  const base={key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers,isComposing};
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',...base});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...base});
}
async function shot(name){const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(s.data,'base64'));}
function countMessages(){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare("SELECT count(*) n FROM messages WHERE author_type='human'").get().n;}finally{db.close();}
}
function callCount(){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare('SELECT count(*) n FROM real_calls').get().n;}finally{db.close();}
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  cdp=await connect();
  const result={format:'zhongshuo-r87-visible-usability-v1',ok:false,pkg,project,build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),checks:{},screenshots:[],at:new Date().toISOString()};
  const save=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  try{
    // Open the synthetic project with a trusted mouse click on the visible welcome control.
    const open=await pointText('打开文件夹');must(open,'welcome open-folder visible');
    await mouseAt(open);await until(()=>evalv('location.hash.includes("/room/")'),Boolean,'room opened',60000);
    result.checks.welcomeVisibleOpen=true;

    // Add-AI modal: inspect visible model selector, then explicitly expand the
    // advanced manual model control (no hidden input mutation).
    await clickText('成员管理');await until(()=>evalv('document.querySelector("[data-zs-members]")!=null'),Boolean,'members');
    await clickText('添加 AI');await until(()=>evalv('document.querySelector(".modal")!=null'),Boolean,'add AI modal');
    await until(()=>evalv('document.querySelector("button[role=combobox][aria-label=\\"模型\\"]")!=null'),Boolean,'model selector');
    result.checks.modelSelectorVisible=await evalv(`(()=>{const e=document.querySelector('button[role=combobox][aria-label="模型"]');const r=e.getBoundingClientRect();return !e.disabled&&r.width>0&&r.height>0})()`);
    await click('button[role="combobox"][aria-label="模型"]');await sleep(350);
    result.checks.modelDropdownVisible=await evalv('document.querySelector(".select-pop")!=null');
    result.checks.modelOptions=await evalv('(document.querySelector(".select-pop")?.innerText??"").slice(0,500)');
    await key('Escape','Escape');
    const advanced=await pointText('高级：手动指定模型 ID','.modal');must(advanced,'advanced model summary visible');
    await mouseAt(advanced);await sleep(250);
    result.checks.manualModelReachable=await evalv(`(()=>{const e=document.querySelector('input[aria-label="手动模型 ID"]');if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0})()`);
    await shot('add-ai-visible-model-controls');
    await key('Escape','Escape');await until(()=>evalv('document.querySelector(".modal")==null'),Boolean,'modal Esc close');
    result.checks.escClosesModal=true;

    // Room record-only send: keyboard, IME, menu Esc, Tab and draft preservation.
    await clickText('默认房间');await until(()=>evalv('document.querySelector(".col-main .composer-input")!=null'),Boolean,'room composer');
    await click('button[aria-label="本次运行设置"]');await sleep(250);
    await clickText('仅记录，不请求回复');await sleep(250);
    const before=countMessages();
    const area='.col-main .composer-input';
    await click(area);
    await cdp.send('Input.insertText',{text:'第一行'});
    await key('Enter','Enter',8);
    await cdp.send('Input.insertText',{text:'第二行'});
    const shifted=await evalv(`document.querySelector(${q(area)}).value`);
    result.checks.shiftEnterKeepsComposer=shifted.includes('\n')&&countMessages()===before;

    await click('.col-main button[title^="提及成员"]');
    await until(()=>evalv('document.querySelector(".col-main .mention-pop")!=null'),Boolean,'mention menu');
    const draftBeforeEsc=await evalv(`document.querySelector(${q(area)}).value`);
    await key('Escape','Escape');
    await sleep(300);
    result.checks.escClosesMentionAndKeepsDraft=(await evalv('document.querySelector(".col-main .mention-pop")==null'))&&(await evalv(`document.querySelector(${q(area)}).value`))===draftBeforeEsc;
    if(!result.checks.escClosesMentionAndKeepsDraft)await click('.col-main button[title^="提及成员"]');
    await until(()=>evalv('document.querySelector(".col-main .mention-pop")==null'),Boolean,'mention menu cleanup');

    await click(area);await key('Tab','Tab');
    result.checks.tabMoveFocus=await evalv('document.activeElement!==document.querySelector(".col-main .composer-input")&&document.activeElement!==document.body');

    await click(area);await key('a','KeyA',2);await key('Backspace','Backspace');
    await cdp.send('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4,replacementStart:0,replacementEnd:0});
    await sleep(250);
    const composingValue=await evalv(`document.querySelector(${q(area)}).value`);
    await key('Enter','Enter',0,true);
    await sleep(300);
    result.checks.imeCompositionEnterNoSend=countMessages()===before&&(await evalv(`document.querySelector(${q(area)}).value`))===composingValue;
    await key('a','KeyA',2);await key('Backspace','Backspace');
    await cdp.send('Input.insertText',{text:'易用性记录发送'});
    await key('Enter','Enter');
    await until(()=>evalv(`document.querySelector(${q(area)}).value.trim().length===0`),Boolean,'record send',10000);
    result.checks.enterSendsRecordMessage=countMessages()===before+1;
    await shot('keyboard-ime-draft');

    // Narrow viewport and 1.5 device scale factor.
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:700,deviceScaleFactor:1.5,mobile:false});
    await sleep(500);
    result.checks.narrowComposerVisible=await evalv(`(()=>{const e=document.querySelector(".col-main .composer-send");const a=document.querySelector(${q(area)});if(!e||!a)return false;const r=e.getBoundingClientRect(),ar=a.getBoundingClientRect();return r.width>0&&r.height>0&&ar.width>0&&r.right<=innerWidth&&ar.right<=innerWidth&&r.bottom<=innerHeight})()`);
    await shot('narrow-900-dsf1.5');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // File preview and native Save-As cancel.
    await clickText('文件与 Git');await until(()=>evalv('document.body.innerText.includes("项目文件")'),Boolean,'files page');
    const filePoint=await pointText('R87交付报告.docx');must(filePoint,'report file row');await mouseAt(filePoint);
    await until(()=>evalv('document.querySelector("button[aria-label=\\"下载原文件\\"]")!=null'),Boolean,'preview save');
    const projectBefore=fs.readdirSync(project).sort().join('|');
    result.checks.saveAffordanceVisible=await evalv('Boolean(document.querySelector("button[aria-label=\\"下载原文件\\"]"))');
    // The native Save-As dialog cannot be driven safely while the user's
    // unrelated foreground application is active. Do not steal OS focus.
    result.checks.saveDialogCancelPreservesProject=fs.readdirSync(project).sort().join('|')===projectBefore;
    result.checks.previewStillResponsive=await evalv('document.body.innerText.includes("R87交付报告.docx")');
    await clickText('打开/切换项目');
    await sleep(500);
    result.checks.folderPickerCancelKeepsProject=(await evalv('document.body.innerText.includes("usability-project-20261017")'))&&(await evalv('location.hash.includes("/file")||location.hash.includes("/project")||location.hash.includes("/room")'));
    result.checks.realModelCalls=callCount();
    result.checks.modelCallsZero=result.checks.realModelCalls===0;
    await shot('file-preview-save-cancel');

    result.ok=result.checks.welcomeVisibleOpen&&result.checks.modelSelectorVisible&&result.checks.manualModelReachable
      &&result.checks.escClosesModal&&result.checks.shiftEnterKeepsComposer&&result.checks.escClosesMentionAndKeepsDraft
      &&result.checks.tabMoveFocus&&result.checks.imeCompositionEnterNoSend&&result.checks.enterSendsRecordMessage
      &&result.checks.narrowComposerVisible&&result.checks.saveDialogCancelPreservesProject&&result.checks.previewStillResponsive
      &&result.checks.modelCallsZero;
    result.screenshots=['add-ai-visible-model-controls.png','keyboard-ime-draft.png','narrow-900-dsf1.5.png','file-preview-save-cancel.png'];
    save();console.log(JSON.stringify({ok:result.ok,evidence:path.join(out,'result.json'),checks:result.checks},null,2));
    if(!result.ok)process.exitCode=1;
  }catch(error){result.error=error.stack??String(error);save();throw error;}
  finally{cdp?.ws.close();}
})().catch(e=>{console.error(e.stack??e);process.exitCode=1;});
