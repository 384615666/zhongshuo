/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, console */
const fs=require('node:fs');const path=require('node:path');
module.exports=async function({cdp,projectId,dm,data,out,command,navigate,until,queryOne,must,sleep,button,facts}){
  const start=Date.now(),duration=30*60_000;const samples=[];
  const target=facts.r79.scale;
  await navigate(cdp,`/thread/${target.threadId}?tab=run`,target.threadId);
  await until(()=>cdp.eval("document.querySelector('.details-body')?.textContent.includes('R79_SYNTHETIC_HISTORY_ONLY')"),Boolean,'R80 historical details ready');
  const draft='R80 durable unsent draft — no automatic submit';
  await cdp.eval(`(()=>{const e=document.querySelector('textarea.composer-input');if(!e)throw Error('composer');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(draft)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  const before=queryOne('SELECT count(*) n FROM messages').n;
  fs.writeFileSync(path.join(data,'engineering','r80-control.json'),JSON.stringify({op:'disconnect',ms:105000}));
  await until(()=>cdp.eval("document.querySelector('[data-zs-connection-phase]')?.getAttribute('data-zs-connection-phase')"),v=>v==='failed','R80 real named-pipe failed recovery',115_000);
  const disconnected=await cdp.eval("({phase:document.querySelector('[data-zs-connection-phase]')?.getAttribute('data-zs-connection-phase'),draft:document.querySelector('textarea.composer-input')?.value,text:document.querySelector('.details-body')?.textContent})");
  must(disconnected.draft===draft&&disconnected.text.includes('R79_SYNTHETIC_HISTORY_ONLY'),'disconnect lost draft or confirmed facts');
  await cdp.shot('r80-disconnected.png');
  await until(()=>cdp.eval("document.querySelector('[data-zs-connection-phase]')?.getAttribute('data-zs-connection-phase')"),v=>v==='online','R80 connection auto recovery',25_000);
  must(queryOne('SELECT count(*) n FROM messages').n===before,'recovery dispatched a message');
  await cdp.send('Page.reload');
  await until(()=>cdp.eval("document.querySelector('textarea.composer-input')?.value"),v=>v===draft,'R80 reload durable draft',35_000);
  await until(()=>cdp.eval("document.querySelector('.details-body')?.textContent.includes('历史运行')"),Boolean,'R80 reload historical selection',35_000);
  const historyRestored=await cdp.eval("document.querySelector('[data-zs-history=runs]')?.textContent.includes('已到历史起点') === true");
  must(historyRestored,'R80 reload historical window not restored');
  await navigate(cdp,'/settings?section=help','settings');
  await until(()=>cdp.eval("document.querySelector('[data-zs-local-diagnostics]')!=null"),Boolean,'R80 local diagnostic entry');
  must(await cdp.eval(button('[data-zs-local-diagnostics]','查看诊断 / 刷新')),'diagnostic button');
  await until(()=>cdp.eval("document.querySelector('[data-zs-local-diagnostics] pre')?.textContent"),v=>v?.includes(facts.buildId),'diagnostic real BUILD');
  const report=await cdp.eval("document.querySelector('[data-zs-local-diagnostics] pre').textContent");
  must(!report.includes(draft)&&!report.includes(data)&&!report.includes(projectId)&&!report.includes('local.token')&&!/sk-[a-zA-Z0-9]{8}/.test(report),'diagnostic privacy');
  await cdp.shot('r80-local-diagnostics.png');
  await cdp.send('Page.bringToFront');
  const copyPoint=await cdp.eval("(()=>{const b=[...document.querySelectorAll('[data-zs-local-diagnostics] button')].find(b=>b.textContent.includes('复制诊断'));if(!b)return null;b.scrollIntoView();const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");must(copyPoint,'copy diagnosis control');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...copyPoint});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...copyPoint});
  await until(()=>cdp.eval("document.querySelector('[data-zs-local-diagnostics]')?.textContent.includes('已复制脱敏诊断')"),Boolean,'actual clipboard acknowledgement');
  const copied=await cdp.eval('navigator.clipboard.readText()');must(JSON.parse(copied).build.buildId===facts.buildId&&!copied.includes(draft)&&!copied.includes(data),'clipboard content not redacted');
  await cdp.eval(`(()=>{const intervals=new Set();const si=window.setInterval.bind(window),ci=window.clearInterval.bind(window);window.setInterval=(fn,ms,...a)=>{const id=si(fn,ms,...a);intervals.add(id);return id;};window.clearInterval=id=>{intervals.delete(id);return ci(id);};let listeners=0;const originalAdd=document.addEventListener.bind(document),originalRemove=document.removeEventListener.bind(document);const tracked=new Map();document.addEventListener=(type,fn,...a)=>{let set=tracked.get(type);if(!set)tracked.set(type,set=new Set());if(!set.has(fn)){set.add(fn);listeners++;}return originalAdd(type,fn,...a);};document.removeEventListener=(type,fn,...a)=>{if(tracked.get(type)?.delete(fn))listeners--;return originalRemove(type,fn,...a);};window.__r80Metrics=()=>({intervals:intervals.size,documentListeners:listeners});return true;})()`);
  let cycle=0;
  while(Date.now()-start<duration){
    const phase=cycle%5;
    if(phase===0){await navigate(cdp,`/thread/${target.threadId}?tab=run`,target.threadId);await until(()=>cdp.eval("document.querySelector('.details-body')?.textContent.includes('R79_SYNTHETIC_HISTORY_ONLY')"),Boolean,'soak details');}
    else if(phase===1){await navigate(cdp,`/project/${projectId}/members`,projectId);await command(cdp,'project.memberWorkload',{projectId});}
    else if(phase===2){await navigate(cdp,`/dm/${dm.conversationId}`,dm.conversationId);await until(()=>cdp.eval("document.querySelector('[data-zs-dm-ops=hifi]')!=null"),Boolean,'soak DM');await cdp.eval("document.querySelector('[data-zs-dm-ops=hifi]').click();true");must(await cdp.eval(button('body','任务记录…')),'soak DM records');await sleep(500);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
    else if(phase===3){await navigate(cdp,`/project/${projectId}/files`,projectId);await cdp.eval("window.zsWindow.minimize();true");await sleep(2500);await cdp.eval('window.zsWindow.toggleMaximize()');await cdp.send('Page.bringToFront');}
    else{await navigate(cdp,'/settings?section=help','settings');await cdp.eval(button('[data-zs-local-diagnostics]','查看诊断 / 刷新'));}
    const local=await cdp.eval('window.zs.diagnostics()');const metrics=await cdp.eval('window.__r80Metrics()');const heap=await cdp.send('Runtime.getHeapUsage');const host=JSON.parse(fs.readFileSync(path.join(data,'engineering','r80-host-metrics.json')));
    const sample={at:Date.now(),elapsedMs:Date.now()-start,cycle,phase,requests:host.requests,inFlight:host.inFlight,...metrics,connection:local.connection,heap,messages:queryOne('SELECT count(*) n FROM messages').n,realCalls:queryOne('SELECT count(*) n FROM real_calls').n};samples.push(sample);
    must(sample.connection.monitorTimers===1&&sample.connection.inFlight<=1,'monitor multiplied');must(sample.messages===before&&sample.realCalls===0,'unexpected business dispatch');
    fs.writeFileSync(path.join(out,'r80-soak-progress.json'),JSON.stringify({buildId:facts.buildId,start,elapsedMs:Date.now()-start,samples,scope:'real final launcher; external own Fake host; transport disconnect injection; actual minimize/return and reload; no OS sleep'},null,2));
    if(cycle%2===0)console.log(JSON.stringify({r80SoakMinutes:((Date.now()-start)/60000).toFixed(1),cycle,requests:host.requests,intervals:metrics.intervals,listeners:metrics.documentListeners}));cycle++;
    await sleep(Math.min(20_000,Math.max(1,duration-(Date.now()-start))));
  }
  const byPhase=[0,1,2,3,4].map(p=>samples.filter(s=>s.phase===p));
  must(byPhase.every(v=>v.length>=2&&v.at(-1).intervals<=v[1].intervals+1&&v.at(-1).documentListeners<=v[1].documentListeners+2),'polling/listener count grows across identical routes');
  const result={pass:true,buildId:facts.buildId,elapsedMs:Date.now()-start,cycles:cycle,transportDisconnect:true,confirmedFactsRetained:true,draftRetained:true,historyRestored,diagnosticRedacted:true,reloaded:true,modelCalls:0,scope:'30-minute route/visibility/transport/reload observation; no real OS sleep, no multi-day certification'};
  fs.writeFileSync(path.join(out,'r80-soak-result.json'),JSON.stringify(result,null,2));facts.steps.push('R80 real pipe failure/recovery retains facts and draft; reload restores historical reading; local redacted diagnostics; 30-minute bounded route observation');return result;
};
