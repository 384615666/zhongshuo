/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,console,__dirname */
// Read-only hashes, never configuration contents or secret values.
const fs=require('node:fs'),path=require('node:path'),{homedir}=require('node:os'),{createHash}=require('node:crypto');
const {ownedEvidenceRoot}=require('./lib/r86-native-evidence.cjs'),{engineeringLaunchEnvironment}=require('./lib/r86-launch-env.cjs');
const own=path.resolve(process.argv[2]??''),label=process.argv[3];if(!ownedEvidenceRoot(own,path.resolve(__dirname,'../dist'))||!/^[-a-z0-9]+$/.test(label??''))throw Error('owned root / explicit unique stage required');
const file=path.join(own,`configuration-${label}.json`);if(fs.existsSync(file))throw Error('original observation retained');
const p=JSON.parse(fs.readFileSync(path.join(own,'progress.json'))),env=engineeringLaunchEnvironment(process.env,p.port),hash=x=>createHash('sha256').update(x).digest('hex');
const sourceFiles=[{kind:'native-user-config',file:path.join(env.CODEX_HOME??path.join(homedir(),'.codex'),'config.toml')}];let cwd=path.resolve(p.project);
for(let n=0;n<64;n++){sourceFiles.push({kind:`project-ancestor-${n}`,file:path.join(cwd,'.codex/config.toml')});const parent=path.dirname(cwd);if(parent===cwd)break;if(n===63)throw Error('configuration ancestor bound');cwd=parent;}
const facts=sourceFiles.map(({kind,file})=>{try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>1048576)throw Error('configuration read bound');return{kind,bytes:stat.size,modifiedAt:stat.mtime.toISOString(),sha256:hash(fs.readFileSync(file))};}catch(e){if(e.code==='ENOENT')return{kind,absent:true};throw e;}});
const relevant=Object.entries(env).filter(([key])=>/^(CODEX_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/.test(key)).sort(([a],[b])=>a.localeCompare(b));
const r={build:p.build,label,at:new Date().toISOString(),projectId:p.ids.projectId,files:facts,launchRecipe:'r86-standalone-desktop-v1',removedHostKeys:['CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_APP_TOOLS_PIPE_PATH','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY'],preservedNativeEnvironmentNames:relevant.map(([name])=>name),nativeEnvironmentHash:hash(JSON.stringify(relevant)),noSecretValuesRecorded:true,modelInferenceCalls:0};
fs.writeFileSync(file,JSON.stringify(r,null,2));console.log(JSON.stringify({label,files:facts.filter(f=>!f.absent).length,nativeEnvironmentHash:r.nativeEnvironmentHash}));
