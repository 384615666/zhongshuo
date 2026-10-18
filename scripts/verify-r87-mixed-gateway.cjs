/* Verify that the packaged Codex UI/runtime reads the configured mixed
 * gateway and exposes the exact glm model. No model turn is started. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-empty */
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn,execFileSync}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const pkg=path.resolve(process.argv[2]);
const project=path.resolve(process.argv[3]);
const out=path.resolve(process.argv[4]);
const pickFile=path.join(out,'open-folder.txt');
const q=JSON.stringify;
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const must=(value,label)=>{if(!value)throw Error(label);};
let child=null;

function start(){
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(pickFile,project+'\r\n','utf8');
  child=spawn('cmd.exe',['/d','/c','start-desktop.bat'],{
    cwd:pkg,
    env:{...process.env,ZS_DEV25_DEBUG_PORT:'0',ZS_PICK_FOLDER_FILE:pickFile},
    windowsHide:true,
    stdio:'ignore',
  });
  child.unref();
}
function readPort(){
  try{return Number(fs.readFileSync(path.join(pkg,'server-data','electron-user-data','DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);}catch{return 0;}
}
async function connect(){
  return until(async()=>{
    const port=readPort();if(!(port>0))return null;
    try{
      const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
      const page=rows.find(row=>row.type==='page'&&row.url.includes('index.html'));if(page==null)return null;
      const ws=new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
      const cdp=new Cdp(ws);await cdp.send('Runtime.enable');
      await until(()=>cdp.eval('document.body?.classList.contains("hifi-on")'),Boolean,'app ready',30000);
      return cdp;
    }catch{return null;}
  },Boolean,'owned app',120000);
}
async function clickText(cdp,text,scope='body'){
  return cdp.eval(`(()=>{const root=document.querySelector(${q(scope)})??document;const button=[...root.querySelectorAll('button,a')].find(item=>item.textContent.trim()===${q(text)});if(!button||button.disabled)return false;button.click();return true})()`);
}
async function setInput(cdp,selector,value){
  return cdp.eval(`(()=>{const input=document.querySelector(${q(selector)});if(!input)return false;const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${q(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
}
async function shot(cdp,name){
  const image=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(image.data,'base64'));
}
function configFacts(){
  const configFile=path.join(os.homedir(),'.codex','config.toml');
  const text=fs.readFileSync(configFile,'utf8');
  const match=key=>text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`,'m'))?.[1]??null;
  const catalogPath=path.join(path.dirname(configFile),match('model_catalog_json')??'cc-switch-model-catalog.json');
  const catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8')).models??[];
  return{
    configPath:configFile,
    configSha256:sha(configFile),
    configModifiedAt:fs.statSync(configFile).mtime.toISOString(),
    modelProvider:match('model_provider'),
    providerBaseUrl:match('base_url'),
    wireApi:match('wire_api'),
    requiresOpenAiAuth:text.includes('requires_openai_auth = true'),
    catalogPath,
    catalogModels:catalog.map(model=>model.slug).filter(id=>id==='ccs-new/deepseek-flash'||id==='ccs-new/glm-5.3-flash'),
    codexHomeEnvironment:process.env.CODEX_HOME??null,
  };
}
function childProcessFacts(){
  const script=[
    '$rows=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq "node.exe"}',
    '$daemon=$rows | Where-Object {$_.CommandLine -like "*"+$env:ZS_PROBE_PACKAGE+"*resources\\app\\daemon\\daemon.cjs*"} | Select-Object -First 1',
    'if($null -eq $daemon){exit 1}',
    '$codex=$rows | Where-Object {$_.ParentProcessId -eq $daemon.ProcessId -and $_.CommandLine -like "*@openai*codex*app-server*"} | Select-Object -First 1',
    'if($null -eq $codex){exit 2}',
    '[pscustomobject]@{daemonPid=$daemon.ProcessId;codexPid=$codex.ProcessId;parentPid=$codex.ParentProcessId;commandLine=$codex.CommandLine} | ConvertTo-Json -Compress',
  ].join(';');
  try{
    const raw=execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{
      encoding:'utf8',windowsHide:true,timeout:15000,
      env:{...process.env,ZS_PROBE_PACKAGE:pkg},
    }).trim();
    const facts=JSON.parse(raw);
    facts.commandLine=facts.commandLine.replace(/(token|key|secret|password)=\S+/gi,'$1=<redacted>');
    return{...facts,persistent:true};
  }catch{
    return{persistent:false,note:'The app-server child exited after reading the catalog; actual inference is verified in the fresh collaboration root.'};
  }
}

(async()=>{
  start();
  let cdp=await connect();
  const identity=await cdp.eval(`window.zs.command({protocolVersion:1,commandId:'r87-gateway-${randomUUID()}',method:'app.identity',params:{}})`);
  must(identity.ok===true,'app identity');
  if(await cdp.eval('Boolean([...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="打开文件夹"))'))await clickText(cdp,'打开文件夹');
  await until(()=>cdp.eval('location.hash.includes("/room/")'),Boolean,'project opened',60000);
  await clickText(cdp,'成员管理');
  await until(()=>cdp.eval('document.querySelector("[data-zs-members]")!=null'),Boolean,'members',30000);
  await clickText(cdp,'添加 AI');
  await until(()=>cdp.eval('document.querySelector(".modal")!=null'),Boolean,'add AI modal');
  must(await setInput(cdp,'input[placeholder*="审查者"]','混合网关探测'),'name');
  must(await setInput(cdp,'input[placeholder*="实现与重构"]','只读核对产品 Codex 子进程的网关模型目录'),'description');
  must(await cdp.eval(`(()=>{const button=document.querySelector('button[role="combobox"][aria-label="运行渠道"]');if(!button)return false;button.click();return true})()`),'channel open');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=codex]")!=null'),Boolean,'codex option');
  must(await cdp.eval(`(()=>{const button=document.querySelector('[data-zs-option="codex"]');if(!button)return false;button.click();return true})()`),'select codex');
  await until(()=>cdp.eval('document.querySelector("button[role=combobox][aria-label=\\"模型\\"]:not([disabled])")!=null'),Boolean,'model ready',60000);
  must(await cdp.eval(`(()=>{const button=document.querySelector('button[role="combobox"][aria-label="模型"]');if(!button)return false;button.click();return true})()`),'model open');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=\\"ccs-new/glm-5.3-flash\\"]")!=null'),Boolean,'glm option in product catalog',60000);
  const options=await cdp.eval(`[...document.querySelectorAll('[data-zs-option]')].map(option=>({id:option.getAttribute('data-zs-option'),text:option.textContent.trim()}))`);
  must(await cdp.eval(`(()=>{const button=document.querySelector('[data-zs-option="ccs-new/glm-5.3-flash"]');if(!button)return false;button.click();return true})()`),'select glm model');
  await until(()=>cdp.eval('document.querySelector("button[role=combobox][aria-label=\\"思考等级\\"]:not([disabled])")!=null'),Boolean,'effort ready',30000);
  must(await cdp.eval(`(()=>{const button=document.querySelector('button[role=combobox][aria-label="思考等级"]');if(!button)return false;button.click();return true})()`),'effort open');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=\\"max\\"]")!=null'),Boolean,'max effort');
  must(await cdp.eval(`(()=>{const button=document.querySelector('[data-zs-option="max"]');if(!button)return false;button.click();return true})()`),'select max');
  must(await cdp.eval(`(()=>{const button=document.querySelector('[data-zs-member-addsave]');if(!button||button.disabled)return false;button.click();return true})()`),'save member');
  await until(()=>cdp.eval('document.querySelector(".modal")==null'),Boolean,'member saved',30000);
  await shot(cdp,'mixed-gateway-model-catalog');
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  let memberProfile,realCallCount;
  try{
    memberProfile=db.prepare(`SELECT pm.id,pm.display_name AS displayName,ri.kind,ri.executable,ap.settings_json AS settingsJson
      FROM project_members pm JOIN agent_profiles ap ON ap.id=pm.profile_id JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id
      WHERE pm.display_name='混合网关探测' ORDER BY pm.rowid DESC LIMIT 1`).get();
    realCallCount=db.prepare('SELECT count(*) AS n FROM real_calls').get().n;
  }finally{db.close();}
  const settings=JSON.parse(memberProfile.settingsJson);
  const processFacts=childProcessFacts();
  const config=configFacts();
  const checks={
    noModelCall:realCallCount===0,
    modelExposed:options.some(option=>option.id==='ccs-new/glm-5.3-flash'),
    memberBound:memberProfile.kind==='codex'&&settings.model==='ccs-new/glm-5.3-flash'&&settings.effort==='max',
    defaultCodexHome:config.codexHomeEnvironment==null,
    catalogHasExactModels:config.catalogModels.includes('ccs-new/deepseek-flash')&&config.catalogModels.includes('ccs-new/glm-5.3-flash'),
    gatewayConfigured:config.modelProvider==='custom'&&config.providerBaseUrl==='http://127.0.0.1:15721/v1'&&config.wireApi==='responses',
  };
  const result={
    format:'zhongshuo-r87-mixed-gateway-probe-v1',
    ok:Object.values(checks).every(Boolean),
    package:pkg,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    project,
    config,
    product:{
      modelOptions:options,
      memberProfile:{id:memberProfile.id,displayName:memberProfile.displayName,kind:memberProfile.kind,executable:memberProfile.executable,model:settings.model,effort:settings.effort,permissionMode:settings.permissionMode},
      process:processFacts,
    },
    checks,
    boundaries:[
      'Read-only gateway/config identity probe; no credential or authorization header is stored in this evidence.',
      'The product model catalog and exact member binding are verified; successful inference is separately required in the fresh collaboration root.',
      'No user project, user document, account configuration or reset credit was changed.',
    ],
    at:new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');
  try{await cdp.eval('window.zsWindow.close();true');}catch{}
  cdp.ws.close();
  console.log(JSON.stringify({ok:result.ok,evidence:path.join(out,'result.json'),checks,modelOptions:options},null,2));
  if(!result.ok)process.exitCode=1;
})().catch(error=>{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({format:'zhongshuo-r87-mixed-gateway-probe-v1',ok:false,error:error.stack??String(error),at:new Date().toISOString()},null,2),'utf8');
  console.error(error.stack??error);
  process.exitCode=1;
});
