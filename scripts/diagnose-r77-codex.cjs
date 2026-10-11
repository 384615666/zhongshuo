/** Read-only RPCs only. No thread/start, turn/start, exec or inference. Sanitized output. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, setTimeout, clearTimeout, URL */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const out = path.resolve('dist/desktop/r77-codex-diagnostic'); fs.mkdirSync(out, { recursive: true });
const entry = path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js');
const child = spawn(process.execPath, [entry, 'app-server'], { windowsHide: true });
const pending = new Map(); let seq = 0, buffer = '';
child.stdout.on('data', raw => { buffer += raw; let i; while ((i=buffer.indexOf('\n')) >= 0) {
  const line = buffer.slice(0,i); buffer=buffer.slice(i+1);
  try { const msg=JSON.parse(line); if (pending.has(msg.id)) { const p=pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); if(msg.error)p.reject(new Error(msg.error.message));else p.resolve(msg.result); } } catch { /* ignore notifications */ }
} });
// Consume without exporting logs that could contain user paths or provider credentials.
child.stderr.resume();
const rpc = (method, params) => new Promise((resolve,reject) => {
  const id=++seq; const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method}: timeout`));},20000);
  pending.set(id,{resolve,reject,timer}); child.stdin.write(JSON.stringify({id,method,params})+'\n');
});
const endpoint = raw => { try {const u=new URL(raw);return u.origin+u.pathname;}catch{return null;} };
(async()=>{
 const result={at:new Date().toISOString(),realCalls:0,methods:[],modelId:'gpt-6-luna'};
 try {
  const version=spawnSync(process.execPath,[entry,'--version'],{encoding:'utf8',windowsHide:true});result.cliVersion=version.stdout.trim();
  await rpc('initialize',{clientInfo:{name:'zhongshuo-r77-readonly',version:'1'}}); result.methods.push('initialize');
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  for(const cwd of [process.cwd(),path.resolve('dist/desktop/r76-vision-cert')]){
   const read=await rpc('config/read',{cwd,includeLayers:true});result.methods.push('config/read');
   const c=read.config;const id=c.model_provider??'openai';const provider=c.model_providers?.[id];
   (result.configs??=[]).push({scope:cwd.endsWith('r76-vision-cert')?'R76 certification cwd':'repository cwd',provider:id,model:c.model,baseUrl:endpoint(provider?.base_url),endpointResolution:provider?.base_url?'explicit':'default endpoint depends on authentication; not inferred',wireApi:provider?.wire_api??null,supportsWebsockets:provider?.supports_websockets??null,streamMaxRetries:provider?.stream_max_retries??null,streamIdleTimeoutMs:provider?.stream_idle_timeout_ms??null,origins:read.layers?.map(l=>l.name?.type??'unknown')??[]});
  }
  const list=await rpc('model/list',{includeHidden:true,limit:100});result.methods.push('model/list');
  result.models=list.data?.map(m=>({id:m.id,model:m.model,displayName:m.displayName}));result.modelFound=result.models?.some(m=>m.model==='gpt-6-luna'||m.id==='gpt-6-luna');
  result.nextCursor=list.nextCursor??null;
  const cache=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME??path.join(require('node:os').homedir(),'.codex'),'models_cache.json'),'utf8'));
  result.cachedModel=cache.models?.filter(m=>m.slug==='gpt-6-luna').map(m=>({slug:m.slug,displayName:m.display_name}));
  result.pass=result.modelFound===true&&result.nextCursor===null;
 }catch(e){result.error=e.message;result.pass=false;}
 finally{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  if(child.pid) spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  console.log(JSON.stringify(result,null,2));}
})();
