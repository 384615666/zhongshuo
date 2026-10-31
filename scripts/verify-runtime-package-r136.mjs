import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repo=resolve(import.meta.dirname,'..');
const daily=resolve(process.argv[2]??'');
if(!process.argv[2]||!existsSync(join(daily,'ZhongshuoDual','BUILD.json')))throw Error('Pass a built daily package directory');
const app=join(daily,'ZhongshuoDual');
const run=join(repo,'dist','r136-package',randomUUID());mkdirSync(run,{recursive:true});
const manifest=JSON.parse(readFileSync(join(app,'MANIFEST-SHA256.json'),'utf8'));
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const file of manifest.files)if(digest(join(app,file.path))!==file.sha256)throw Error(`Package hash mismatch: ${file.path}`);
const tools=join(app,'runtime-tools','deepseek-harness');
const connector=JSON.parse(readFileSync(join(tools,'manifest.json'),'utf8'));
if(connector.profile!=='zhongshuo'||connector.dshVersion!=='0.2.1-rc.5'||digest(join(tools,connector.tarball))!==connector.sha256)throw Error('Connector archive mismatch');
if(!existsSync(join(tools,'setup.cmd')))throw Error('Connector setup entry missing');
const help=readFileSync(join(daily,'众说操作手册.html'),'utf8');
if(!help.includes('DeepSeek Harness')||!help.includes('Pi'))throw Error('Packaged manual missing channels');
const data=join(run,'data'),project=join(run,'project'),config=join(run,'config');
for(const dir of [data,project,config])mkdirSync(dir);
const wrapper=String.raw`
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
const output=__OUTPUT__;let completed=false;
const save=result=>fs.writeFileSync(output,JSON.stringify(result,null,2));
app.on('browser-window-created',(_event,win)=>{
 win.show=()=>{};
 win.webContents.once('did-finish-load',async()=>{
  try{
   const result=await win.webContents.executeJavaScript(__SCENARIO__);
   save({ok:true,...result});completed=true;win.close();
  }catch(error){save({ok:false,error:String(error)});completed=true;win.close();}
 });
});
setTimeout(()=>{if(!completed)save({ok:false,error:'Packaged UI deadline'});app.exit(2);},60000).unref();
require(__MAIN__);
`;
const scenario=String.raw`(async()=>{
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const checks=[];
 const check=(name,ok)=>{checks.push({name,ok});if(!ok)throw Error(name);};
 const command=async(method,params)=>{const r=await window.zs.command({protocolVersion:1,commandId:crypto.randomUUID(),method,params});if(!r.ok)throw Error(method+': '+JSON.stringify(r.error));return r.data;};
 const runtime=await command('runtime.status',{});
 check('packaged daemon declares Harness',Boolean(runtime.capabilities['deepseek-harness']));
 check('packaged daemon declares Pi',Boolean(runtime.capabilities.pi));
 const opened=await command('project.open',{path:__PROJECT__});const projectId=opened.project.id;
 for(const kind of ['deepseek-harness','pi']){
  const result=await command('member.runtimeCatalog',{projectId,kind,executable:__MISSING__});
  check(kind+' schema accepted in packaged daemon',result.kind===kind&&result.program.status==='missing'&&result.models.length===0);
 }
 location.hash='/project/'+projectId+'/members';
 let add;for(let i=0;i<120;i++){add=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='添加 AI');if(add)break;await wait(50);}
 check('packaged member page renders',Boolean(add));add.click();await wait(150);
 const select=document.querySelector('[role="dialog"] [role="combobox"][aria-label="运行渠道"]');check('channel picker renders',Boolean(select));select.click();await wait(100);
 const labels=Array.from(document.querySelectorAll('[role="option"]')).map(el=>el.textContent.trim());
 for(const label of ['Claude CLI','Codex CLI','DeepSeek Harness','Pi'])check('picker contains '+label,labels.includes(label));
 return {checks,channels:labels,realModelCalls:0};
})()`;
const code=scenario.replace('__PROJECT__',JSON.stringify(project)).replace('__MISSING__',JSON.stringify(join(run,'missing-runtime.cjs')));
const main=wrapper.replace('__OUTPUT__',JSON.stringify(join(run,'ui-result.json'))).replace('__SCENARIO__',JSON.stringify(code))
  .replace('__MAIN__',JSON.stringify(join(app,'resources','app','dist','ui','main.cjs')));
writeFileSync(join(run,'main.cjs'),main);
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env,{ZS_APP_DATA:data,ZS_RUNTIME:'fake',ZS_ALLOW_FAKE:'1',ZS_REAL_DISPATCH_GUARD:'1',ZS_PACKAGED_UI:'1',
  ZS_PIPE_NAME:'zs-r136-package-'+randomUUID(),ZS_DAEMON_ENTRY:join(app,'resources','app','daemon','daemon.cjs'),
  ZS_NODE_BIN:join(app,'resources','app','daemon','node','node.exe'),CLAUDE_CONFIG_DIR:config,CODEX_HOME:config,DSH_HOME:join(config,'dsh'),PI_CODING_AGENT_DIR:join(config,'pi')});
const processResult=spawnSync(join(app,'electron.exe'),[join(run,'main.cjs')],{cwd:dirname(daily),env,encoding:'utf8',windowsHide:true,timeout:75000});
writeFileSync(join(run,'process.log'),`${processResult.stdout??''}\n${processResult.stderr??''}`);
const result=existsSync(join(run,'ui-result.json'))?JSON.parse(readFileSync(join(run,'ui-result.json'),'utf8')):{ok:false,error:'No packaged UI result'};
const report={...result,run,exitCode:processResult.status,hashes:manifest.files.length,build:JSON.parse(readFileSync(join(app,'BUILD.json'),'utf8')),
  connector:{profile:connector.profile,dshVersion:connector.dshVersion,sha256:connector.sha256},daemonStopped:!existsSync(join(data,'daemon.pid'))};
writeFileSync(join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(!report.ok||report.exitCode!==0||!report.daemonStopped)process.exitCode=1;
