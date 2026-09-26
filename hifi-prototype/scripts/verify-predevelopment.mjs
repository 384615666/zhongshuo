/** 可复跑的开工原型验收。自建隔离 headless 浏览器，不连接用户桌面窗口。
 * 用法：先启动 Vite，再 node scripts/verify-predevelopment.mjs http://127.0.0.1:5317
 * 可追加脚本名子集：verify-nav verify-workspace-preview verify-quote
 * 原型测试只能证明 UI/mock 行为，不能认证 runtime/持久化。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const cwd=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=process.argv[2]??'http://127.0.0.1:5317';
const names=process.argv.slice(3);
const suites=names.length?names:['smoke','verify-dm-composer','verify-default-ai-input','verify-nav-marks','verify-nav','verify-workspace-preview','verify-quote','verify-settings-ia','verify-settings-fixes'];
if(suites.some(n=>!/^[a-z0-9-]+$/.test(n)||!existsSync(join(cwd,'scripts',n+'.mjs')))) throw Error('Invalid suite');
const port=Number(process.env.ZS_BASELINE_CDP_PORT??9417);
try { await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)}); throw Error('CDP port occupied; choose a free ZS_BASELINE_CDP_PORT'); }
catch(e){if(e.message.startsWith('CDP port'))throw e;}
if(!(await fetch(base)).ok)throw Error('Preview not available');
const browser=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!browser)throw Error('No test browser');
const profile=mkdtempSync(join(tmpdir(),'zs-predevelopment-'));
const out=join(cwd,'verification','predevelopment-'+new Date().toISOString().replaceAll(':','-'));
mkdirSync(out,{recursive:true});
const host=spawn(browser,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,base],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const summary={base,browser,node:process.version,startedAt:new Date().toISOString(),scope:'prototype UI/mock only',results:[],output:out};
try {
  let ready=false;
  for(let i=0;i<40;i++){try{const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if(tabs.some(t=>t.type==='page')){ready=true;break}}catch{} await sleep(250)}
  if(!ready)throw Error('Test browser did not start');
  await sleep(1500);
  for(const name of suites){
    const started=Date.now();
    const result=await new Promise((res,rej)=>{
      const child=spawn(process.execPath,[join(cwd,'scripts',name+'.mjs'),base],{cwd,env:{...process.env,TEMP:profile,TMP:profile,ZS_CDP_PORT:String(port),ZS_WPV_CDP_PORT:String(port),ZS_SMOKE_CDP_PORT:String(port+1),ZS_DMC_CDP_PORT:String(port+2),ZS_DAI_CDP_PORT:String(port+3),ZS_NAV_MARKS_CDP_PORT:String(port+4)},windowsHide:true});
      let output=''; const timer=setTimeout(()=>{spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});},180000);
      child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
      child.on('error',rej);child.on('close',code=>{clearTimeout(timer);res({code,output})});
    });
    writeFileSync(join(out,name+'.log'),result.output);
    const tail=result.output.trim().split(/\r?\n/).slice(-5).join('\n');
    summary.results.push({name,exitCode:result.code,durationMs:Date.now()-started,tail});
    console.log(`${name}: exit=${result.code}\n${tail}`);
    if(result.code!==0)process.exitCode=1;
  }
} finally {
  summary.finishedAt=new Date().toISOString();
  writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));
  // 只终止本脚本创建的浏览器进程树，不按进程名关闭任何用户窗口。
  if(host.pid)spawnSync('taskkill',['/PID',String(host.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  console.log(`Evidence: ${out}`);
}
