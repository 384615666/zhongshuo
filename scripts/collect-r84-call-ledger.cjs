/* global require,process,console */
/* eslint-disable @typescript-eslint/no-require-imports -- read-only owned engineering roots, no provider requests */
const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
const [baseArg,outputArg]=process.argv.slice(2);if(!outputArg)throw Error('usage: node collect-r84-call-ledger.cjs ownedDistDirectory output');
const base=path.resolve(baseArg),roots=[],byTurn=new Map(),conflicts=[];
// Deliberately exclude every R83 root, especially its interrupted UNKNOWN request.
for(const entry of fs.readdirSync(base,{withFileTypes:true})){
 if(!entry.isDirectory()||!entry.name.startsWith('review-r84-'))continue;
 const file=path.join(base,entry.name,'copy/server-data/state.sqlite');if(!fs.existsSync(file))continue;
 const db=new Database(file,{readonly:true});let rows;
 try{rows=db.prepare('SELECT runtime_kind,model,response_model,status,turn_id,task_id FROM real_calls ORDER BY id').all();}finally{db.close();}
 roots.push({name:entry.name,rows:rows.length,statuses:rows.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{})});
 for(const row of rows){if(!row.turn_id)throw Error('missing original turn identity in '+entry.name);const prior=byTurn.get(row.turn_id);if(prior){if(prior.runtime_kind!==row.runtime_kind||prior.model!==row.model||prior.status!==row.status||prior.response_model!==row.response_model)conflicts.push({turnId:row.turn_id,roots:[...prior.roots,entry.name],statuses:[prior.status,row.status]});prior.roots.push(entry.name);}else byTurn.set(row.turn_id,{...row,roots:[entry.name]});}
}
const calls=[...byTurn.values()].sort((a,b)=>a.turn_id.localeCompare(b.turn_id)),combos=[];
for(const c of calls){let combo=combos.find(x=>x.runtime===c.runtime_kind&&x.requestedModel===c.model);if(!combo){combo={runtime:c.runtime_kind,requestedModel:c.model,calls:0,statuses:{},responseModels:{}};combos.push(combo);}combo.calls++;combo.statuses[c.status]=(combo.statuses[c.status]??0)+1;const response=c.response_model??'not-reported';combo.responseModels[response]=(combo.responseModels[response]??0)+1;}
const result={pass:conflicts.length===0,at:new Date().toISOString(),scope:'R84 owned root primary copy databases only; copied calls deduplicated by original turn_id; no R83 root opened; no new inference or reconciliation',uniqueCalls:calls.length,rawRows:roots.reduce((n,r)=>n+r.rows,0),combos,conflicts,roots,calls};fs.writeFileSync(path.resolve(outputArg),JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,uniqueCalls:result.uniqueCalls,rawRows:result.rawRows,combos}));if(!result.pass)process.exitCode=1;
