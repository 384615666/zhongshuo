/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const renderer=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RunExtraFacts,ActualMembers,useTaskDetails} from '../../../src/ui/hifi/components/TaskDetailsFacts.tsx';
const config=__CONFIG__,calls=[];let scenario='reason0';
window.zs={command:async env=>{calls.push(env);if(env.method!=='task.details')throw Error('Unexpected command '+env.method);return {ok:true,data:env.params.runId==='parent-old'?config.history:config.cases[scenario]};}};
function Details({view}){
 const formal=useTaskDetails('p','parent',1,'parent-current','FAILED');
 return <div className="main page" style={{overflow:'auto'}}>
  <h2>{view==='members'?'参与成员':'运行详情'}</h2>
  {formal.error?<div role="alert">{formal.error}</div>:null}
  {formal.data?(view==='members'?<ActualMembers detail={formal.data}/>:<RunExtraFacts detail={formal.data} onSelectRun={formal.selectRun}/>):'正在读取…'}
 </div>;
}
const reactRoot=createRoot(document.getElementById('root'));
let version=0;
window.r154={
 show:(key,view='run')=>{scenario=key;reactRoot.render(<Details key={++version} view={view}/>);},
 snapshot:()=>({text:document.body.innerText,calls:calls.map(c=>({method:c.method,params:c.params})),
  failures:[...document.querySelectorAll('[data-zs-member-dispatch-failure]')].map(el=>{const r=el.getBoundingClientRect();return {taskId:el.dataset.zsMemberDispatchFailure,text:el.innerText,source:el.textContent,visible:r.width>0&&r.height>0&&getComputedStyle(el).display!=='none',link:el.querySelector('a')?.getAttribute('href'),buttons:el.querySelectorAll('button').length};}),
  count:document.querySelectorAll('[data-zs-member-dispatch-failure]').length,
  headings:[...document.querySelectorAll('.section-title')].map(el=>el.textContent)}),
 selectHistory:()=>[...document.querySelectorAll('.card.tight')].find(el=>el.querySelector('.section-title')?.textContent.startsWith('历史运行'))?.querySelector('button')?.click(),
 selectCurrent:()=>[...document.querySelectorAll('.card.tight')].find(el=>el.querySelector('.section-title')?.textContent.startsWith('最近运行'))?.querySelector('button')?.click(),
};window.r154.show('reason0');
`;

async function runVerifier(config){
 const out=path.join(root,'dist/r154-member-failure-ui',`${Date.now()}-${process.pid}`);fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'entry.tsx'),renderer.replace('__CONFIG__',JSON.stringify(config)));
 await require('esbuild').build({entryPoints:[path.join(out,'entry.tsx')],outfile:path.join(out,'ui.mjs'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 fs.writeFileSync(path.join(out,'app.css'),['tokens.css','base.css','components.css','preview.css','titlebar.css','h1-overrides.css'].map(f=>fs.readFileSync(path.join(root,'src/ui/hifi/styles',f),'utf8')).join('\n'));
 fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div class="app" id="root"></div><script type="module" src="ui.mjs"></script>');
 fs.writeFileSync(path.join(out,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],screenshots=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const js=code=>win.webContents.executeJavaScript(code),snap=()=>js('r154.snapshot()');
 const until=async(code,label)=>{for(let i=0;i<150;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+label+' '+JSON.stringify(await snap()));};
 const capture=async name=>{await pause(40);fs.writeFileSync(path.join(__dirname,name+'.png'),(await win.webContents.capturePage()).toPNG());screenshots.push(name+'.png');};
 try{
  await win.loadFile(path.join(__dirname,'index.html'));await until('window.r154&&r154.snapshot().count===1','initial read');
  for(const key of ['reason0','reason1','reason2']){
   await js('r154.show('+JSON.stringify(key)+')');await until('r154.snapshot().count===1','failure card');await pause(40);const s=await snap(),f=s.failures[0];
   check(key+'/visible-member-name-task-and-failure',f.visible&&f.text.includes('复核成员')&&f.text.includes('当前复核')&&f.text.includes('尚未启动')&&f.text.includes('原因：'),f);
   check(key+'/real-message',f.text.includes(__MESSAGES__[Number(key.slice(-1))]),f.text);
   check(key+'/formal-task-link',f.link==='#task=child',f);
   check(key+'/no-fake-run-or-retry',f.buttons===0&&!f.text.includes('当前运行')&&!f.text.includes('最近运行')&&!f.text.includes('历史运行'),f);
   check(key+'/event-kind-kept-in-diagnostics',f.source.includes('coordination.dispatchBlocked')&&!f.text.includes('coordination.dispatchBlocked'),f);
   if(key==='reason0')await capture('run-member-not-started');
  }
  await js('r154.show("reason0","members")');await until('r154.snapshot().count===1','members view');
  check('members-view-also-renders-unstarted-failure',(await snap()).failures[0].visible);await capture('members-not-started');
  await js('r154.show("reason0")');await until('r154.snapshot().count===1','run view');await js('r154.selectHistory()');
  await until('r154.snapshot().text.includes("旧轮具体原因")','selected history');let s=await snap();
  check('history-selection-has-own-member-and-reason',s.failures[0].taskId==='old-child'&&!s.text.includes(__MESSAGES__[0])&&s.calls.some(c=>c.params.runId==='parent-old'),s);
  await js('r154.selectCurrent()');await until('r154.snapshot().text.includes('+JSON.stringify(__MESSAGES__[0])+')','current again');
  check('return-to-current-clears-historical-failure',!(await snap()).text.includes('旧轮具体原因'));
  await js('r154.show("missing-message")');await until('r154.snapshot().count===1','missing reason');s=await snap();
  check('missing-reason-is-not-invented',s.failures[0].text.includes('未提供具体原因，请查看任务详情。'),s.failures[0]);
  await js('r154.show("mixed-history")');await until('r154.snapshot().count===1','mixed history');s=await snap();
  check('out-of-scope-failure-not-rendered',s.failures[0].taskId==='child'&&!s.text.includes('旧轮具体原因'),s.failures);
  await js('r154.show("old-contract")');await until('r154.snapshot().headings.includes("成员执行与诊断")','old contract');s=await snap();
  check('optional-contract-remains-compatible',s.count===0&&s.text.includes('已生成文件'),s.text);
  check('display-never-dispatches-or-mutates',s.calls.every(c=>c.method==='task.details'),s.calls);
  const report={ok:checks.every(c=>c.ok),realBusinessCalls:0,checks,screenshots,calls:s.calls};fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
 }catch(e){fs.writeFileSync(path.join(__dirname,'error.txt'),e.stack);fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(2);}
});setTimeout(()=>app.exit(3),25000);
`.replaceAll('__MESSAGES__',JSON.stringify(config.messages)));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
 const proc=spawnSync(require('electron'),[path.join(out,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:30000});
 if(!fs.existsSync(path.join(out,'result.json')))throw Error(`R154 UI exited ${proc.status}: ${fs.existsSync(path.join(out,'error.txt'))?fs.readFileSync(path.join(out,'error.txt'),'utf8'):proc.stderr}; evidence ${out}`);
 return {...JSON.parse(fs.readFileSync(path.join(out,'result.json'),'utf8')),evidence:out};
}
module.exports={runVerifier};
