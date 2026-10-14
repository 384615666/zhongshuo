/* global require,process,WebSocket,fetch,console */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS owned-launcher verification, shares existing CDP helper */
/* Owned clean distribution only. No user data/profile copied, no inference in prepare. */
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');const {randomUUID}=require('node:crypto');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');
const src=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]),copy=path.join(out,'copy'),port=9873;
(async()=>{
  if(fs.existsSync(out))throw Error('fresh independent root required');fs.mkdirSync(copy,{recursive:true});
  for(const entry of fs.readdirSync(src,{withFileTypes:true}))if(entry.name==='ZhongshuoDual'||entry.isFile())fs.cpSync(path.join(src,entry.name),path.join(copy,entry.name),{recursive:true});
  const project=path.join(out,'自然工程'),outside=path.join(out,'项目外合成目录');fs.mkdirSync(project);fs.mkdirSync(outside);fs.writeFileSync(path.join(project,'original.txt'),'R83 synthetic original');
  const log=fs.openSync(path.join(out,'launcher.log'),'a');const env={...process.env,ZS_DEV25_DEBUG_PORT:String(port)};for(const key of Object.keys(env))if(key==='ELECTRON_RUN_AS_NODE'||key.startsWith('ZS_')&&key!=='ZS_DEV25_DEBUG_PORT')delete env[key];
  const child=spawn('cmd',['/c','start-desktop.bat'],{cwd:copy,env,windowsHide:true,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);
  const c=await until(async()=>{try{const list=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());const page=list.find(p=>p.type==='page'&&p.url.includes('index.html'));if(!page)return null;const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});return new Cdp(ws);}catch{return null;}},Boolean,'owned BAT',90000);
  await c.send('Runtime.enable');await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'boot');
  const cmd=async(method,params)=>{const r=await c.eval(`window.zs.command(${JSON.stringify({protocolVersion:1,commandId:randomUUID(),method,params})})`);if(!r.ok)throw Error(JSON.stringify(r.error));return r.data;};
  const identity=await cmd('app.identity',{});if(path.resolve(identity.appDataDir)!==path.join(copy,'server-data'))throw Error('wrong independent root');
  const p=(await cmd('project.open',{path:project,displayName:'自然工程'})).project.id;
  const b=(await cmd('project.open',{path:outside,displayName:'合成隔离项目'})).project.id;
  const member=(await cmd('member.create',{projectId:p,displayName:'工程助手',description:'合成输入真实执行验收'})).memberId;
  await cmd('member.setRuntime',{memberId:member,kind:'claude',model:'glm-5.3-flash',effort:'high'});
  const room=(await cmd('room.list',{projectId:p})).items[0];const dm=await cmd('conversation.create',{projectId:p,peerMemberId:member,title:'自然工程对话'});
  const metadata=await cmd('member.runtimeOptions',{projectId:p,kind:'codex',model:'gpt-6-luna'}).catch(e=>({error:e.message}));
  const facts={pass:false,stage:'prepared',source:src,copy,port,project,outside,dataRoot:identity.appDataDir,ids:{projectId:p,otherProjectId:b,memberId:member,roomId:room.id,conversationId:room.conversationId,dmId:dm.conversationId},codexMetadata:metadata,build:JSON.parse(fs.readFileSync(path.join(copy,'ZhongshuoDual','BUILD.json'),'utf8')),calls:[],nativeSteps:[]};
  fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(facts,null,2));
  await c.send('Page.reload');await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'reload');await c.eval(`location.hash=${JSON.stringify(`/project/${p}/room/${room.id}`)};true`);c.ws.close();console.log(JSON.stringify({prepared:true,out,ids:facts.ids,codexEfforts:metadata.efforts}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
