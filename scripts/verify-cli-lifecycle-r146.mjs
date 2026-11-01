import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {connectPipe} from '../src/contracts/daemonIpc.ts';

const image=resolve(process.argv[2]??'');
if(!process.argv[2]||!existsSync(join(image,'Zhongshuo.exe')))throw Error('Pass the staged Windows installer image');
const repo=resolve(import.meta.dirname,'..'),run=join(repo,'dist/r146-package',randomUUID());mkdirSync(run,{recursive:true});
const manifest=JSON.parse(readFileSync(join(image,'MANIFEST-SHA256.json'),'utf8'));
for(const file of manifest.files)assert.equal(createHash('sha256').update(readFileSync(join(image,file.path))).digest('hex'),file.sha256,file.path);
const data=join(run,'data'),bin=join(run,'bin'),lateBin=join(run,'later installed bin 中文'),config=join(run,'config'),appdata=join(run,'appdata');
for(const dir of [data,bin,lateBin,config,appdata])mkdirSync(dir,{recursive:true});
const pathFile=join(run,'current-installer-path.txt');writeFileSync(pathFile,'');
const preload=join(run,'path-fixture.cjs');
// Only the Windows PATH reader is substituted. The tested daemon, filesystem
// resolvers, database, command receipts and dispatch rejection are the payload.
writeFileSync(preload,String.raw`const cp=require('node:child_process'),fs=require('node:fs');const original=cp.spawnSync;cp.spawnSync=function(command,args,options){if(String(command).toLowerCase().replaceAll('\\','/').endsWith('/windowspowershell/v1.0/powershell.exe'))return{pid:0,stdout:fs.readFileSync(__PATH_FILE__,'utf8'),stderr:'',status:0,signal:null};return original.call(this,command,args,options);};`.replace('__PATH_FILE__',JSON.stringify(pathFile)));
const env={};
for(const key of ['SystemRoot','WINDIR','TEMP','TMP','COMSPEC'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PATH:[bin,join(process.env.SystemRoot??'C:/Windows','System32')].join(';'),APPDATA:appdata,LOCALAPPDATA:join(run,'local'),USERPROFILE:join(run,'home'),
  CLAUDE_CONFIG_DIR:join(config,'claude'),CODEX_HOME:join(config,'codex'),DSH_HOME:join(config,'dsh'),PI_CODING_AGENT_DIR:join(config,'pi'),
  ZS_APP_DATA:data,ZS_RUNTIME:'claude',ZS_PACKED_ENTRY:'1',ZS_MANAGED_RUNTIME:'1',ZS_PIPE_NAME:'\\\\.\\pipe\\zs-r146-'+randomUUID()});
const child=spawn(join(image,'resources/app/daemon/node/node.exe'),['--require',preload,join(image,'resources/app/daemon/daemon.cjs')],{cwd:run,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});
const closed=new Promise(done=>child.once('close',done));
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const checks=[];const check=(name,ok)=>{checks.push({name,ok:!!ok});assert.ok(ok,name);};
let client,result;
const raw=(method,params,commandId=randomUUID())=>client.send({protocolVersion:1,commandId,method,params});
const command=async(method,params,commandId)=>{const response=await raw(method,params,commandId);assert.ok(response.ok,method+': '+JSON.stringify(response.error));return response.data;};
const install=kind=>{
  if(kind==='claude'){
    const dir=join(appdata,'npm/node_modules/@anthropic-ai/claude-code/bin');mkdirSync(dir,{recursive:true});
    const settings=join(config,'claude');mkdirSync(settings,{recursive:true});writeFileSync(join(settings,'settings.json'),JSON.stringify({env:{ANTHROPIC_MODEL:'fixture-model'}}));
    const entry=join(dir,'claude.exe');writeFileSync(entry,'non-executable CLI discovery fixture');return entry;
  }
  const name=kind==='deepseek-harness'?'dsh':kind;
  const entry=join(lateBin,name+(kind==='codex'?'.js':'.cjs'));writeFileSync(entry,'throw Error("Fixture CLI must never execute");');
  writeFileSync(join(lateBin,name+'.cmd'),`@node "${entry}" %*`);
  if(kind==='codex'){
    const dir=join(config,'codex');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'config.toml'),'model = "fixture-model"\n');
  }
  if(kind==='deepseek-harness'){
    const dir=join(config,'dsh/profiles/zhongshuo/node_modules/@zhongshuo/dsh-runtime');mkdirSync(dir,{recursive:true});
    for(const file of ['package.json','index.mjs','backend.mjs','protocol.mjs'])writeFileSync(join(dir,file),file==='package.json'?'{}':'// discovery fixture');
  }
  return entry;
};
try{
  for(let n=0;n<200;n++){
    if(child.exitCode!=null)throw Error('Packaged daemon exited '+child.exitCode);
    if(existsSync(join(data,'local.token')))try{client=await connectPipe(env.ZS_PIPE_NAME,{token:readFileSync(join(data,'local.token'),'utf8').trim(),requestTimeoutMs:10000});break;}catch{/* starting */}
    await wait(100);
  }
  assert.ok(client,'Packaged daemon ready');
  check('payload manifest verified',manifest.files.length>0);
  const first=await command('project.ensureDefault',{}),projectId=first.project.id;
  check('first launch without CLI has no enabled AI',first.availableAgentCount===0);
  await command('room.create',{projectId,name:'缺 CLI 时建房'});
  const initialRoom=(await command('room.list',{projectId})).items.find(room=>room.name==='默认房间');assert.ok(initialRoom);
  const message={target:{kind:'room_root',projectId,roomId:initialRoom.id,conversationId:initialRoom.conversationId},intent:'record_only',body:'保留这条测试历史',mentions:[]};
  const recordedId=randomUUID();await command('message.submit',message,recordedId);
  writeFileSync(pathFile,lateBin);
  for(const kind of ['pi','codex','claude','deepseek-harness']){
    let entry=install(kind);
    const fresh=await command('room.create',{projectId,name:kind+' 安装后建房'});
    check(kind+' added after installation',fresh.discovery.created.includes(kind));
    const scan=await command('member.discoverDefaults',{projectId});
    const member=scan.existing.find(item=>item.kind===kind);assert.ok(member);
    const saved=(await command('member.runtime',{memberId:member.memberId})).binding;
    const members=(await command('member.list',{projectId,roomId:initialRoom.id})).items;
    if(kind==='pi')check('original empty room gets a real member when its placeholder is replaced',members.some(item=>item.id===member.memberId));
    unlinkSync(entry);
    await command('member.discoverDefaults',{projectId});
    const missing=await command('member.runtime',{memberId:member.memberId});
    check(kind+' uninstall is reported without deleting binding',missing.executableStatus.status==='missing'&&JSON.stringify(missing.binding)===JSON.stringify(saved));
    const roster=(await command('member.list',{projectId})).items;
    check(kind+' unavailable without changing enable preference',roster.some(item=>item.id===member.memberId&&item.enabled&&item.runtimeAvailable===false));
    const rejected=await raw('message.submit',{...message,target:{kind:'room_root',projectId,roomId:fresh.room.id,conversationId:fresh.room.conversationId},intent:'default',body:'卸载后不能调用',mentions:[{kind:'member',memberId:member.memberId}]});
    writeFileSync(join(run,kind+'-rejected.json'),JSON.stringify(rejected,null,2));
    check(kind+' request rejected before enqueue',!rejected.ok&&rejected.error.message.includes('执行程序未找到'));
    entry=install(kind);
    const restored=await command('member.discoverDefaults',{projectId});
    check(kind+' reinstall reuses the same member',restored.created.length===0&&restored.existing.some(item=>item.memberId===member.memberId));
    check(kind+' repeated scan stays duplicate-free',(await command('member.discoverDefaults',{projectId})).created.length===0);
    check(kind+' binding unchanged after reinstall',JSON.stringify((await command('member.runtime',{memberId:member.memberId})).binding)===JSON.stringify(saved));
  }
  check('original recorded command still replays',(await raw('message.submit',message,recordedId)).replayed===true);
  const pool=await command('room.pool',{roomId:initialRoom.id});
  check('rejected sends preserve the one recorded message',pool.items.length===1&&pool.items[0].body.text===message.body);
  const status=await command('recovery.status',{});check('missing CLI created no interrupted execution',status.interruptedRuns.length===0);
  result={ok:true,checks,run,buildId:manifest.buildId,realModelCalls:0,pathReader:'synthetic machine/user PATH; no host registry writes',cliFixtures:true};
}catch(error){result={ok:false,checks,run,error:String(error)};}
finally{
  if(client)try{await command('daemon.shutdown',{});}catch{/* preserve failure */}
  await Promise.race([closed,wait(10000)]);
  if(child.exitCode==null)child.kill();
  client?.close();writeFileSync(join(run,'daemon.log'),log);
}
result.exitCode=child.exitCode;if(child.exitCode!==0)result.ok=false;
writeFileSync(join(run,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
