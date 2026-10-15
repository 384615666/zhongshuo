/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,console */
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),out='dist/review-r86-source/source-quality-'+commit.slice(0,7)+'.json';if(fs.existsSync(out))throw Error('original quality observation retained');
const run=(args,input)=>spawnSync(process.execPath,args,{encoding:'utf8',input,maxBuffer:32*1024*1024,windowsHide:true});const r={pass:false,testedRuntimeCommit:commit,mainTypes:false,hifiTypes:false,lint:false,addedErrors:[],existingErrorCount:0};
try{
 for(const [key,args] of [['mainTypes',['node_modules/typescript/bin/tsc','--noEmit']],['hifiTypes',['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.hifi.json']]]){const p=run(args);r[key]=p.status===0;r[key+'OutputHash']=createHash('sha256').update(p.stdout+p.stderr).digest('hex');if(p.status!==0)throw Error(key+' failed: '+p.stdout.slice(0,1500));}
 const paths=spawnSync('git',['diff','--name-only','60f36eb',commit],{encoding:'utf8'}).stdout.trim().split(/\r?\n/).filter(p=>/^(src|scripts|tests)\//.test(p)&&/\.(?:ts|tsx|cjs|mjs)$/.test(p)&&fs.existsSync(p));
 const current=run(['node_modules/eslint/bin/eslint.js','--format','json',...paths]);if(![0,1].includes(current.status))throw Error('lint tool failure');const rows=JSON.parse(current.stdout);r.lintedFiles=paths.length;
 for(const row of rows){const errors=row.messages.filter(m=>m.severity===2);if(!errors.length)continue;const relative=paths.find(p=>row.filePath.replace(/\\/g,'/').endsWith('/'+p));if(!relative)throw Error('lint path mismatch');const old=spawnSync('git',['show','60f36eb:'+relative],{encoding:'utf8',maxBuffer:16*1024*1024}),baseline=old.status===0?run(['node_modules/eslint/bin/eslint.js','--format','json','--stdin','--stdin-filename',relative],old.stdout):null;const remaining=baseline?JSON.parse(baseline.stdout)[0].messages.filter(m=>m.severity===2):[];
 for(const error of errors){const index=remaining.findIndex(m=>m.ruleId===error.ruleId&&m.message===error.message);if(index<0)r.addedErrors.push({file:relative,rule:error.ruleId,message:error.message,line:error.line});else{remaining.splice(index,1);r.existingErrorCount++;}}
 }r.lint=r.addedErrors.length===0;r.pass=r.mainTypes&&r.hifiTypes&&r.lint;if(!r.pass)process.exitCode=1;
}catch(e){r.error=e.stack;process.exitCode=1;}finally{fs.writeFileSync(out,JSON.stringify(r,null,2));console.log(JSON.stringify(r));}
