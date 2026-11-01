import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {buildDshRuntime} from '../../../scripts/build-dsh-runtime.mjs';
import {setupDeepseekHarness} from '../../../scripts/setup-deepseek-harness.mjs';

test('installer plans without touching home and persists verified archive outside removable source before official add',async()=>{
  const area=await mkdtemp(join(tmpdir(),'zs-r152-component-'));
  const old=process.env.DSH_HOME;process.env.DSH_HOME=join(area,'home');
  try{
    const artifacts=join(area,'removable-source');const manifest=await buildDshRuntime(artifacts);
    const profile=join(process.env.DSH_HOME,'profiles/zhongshuo');await mkdir(profile,{recursive:true});
    const sentinels=new Map();
    for(const file of ['cordis.yml','cordis.patch.yml','package.json','.credentials.yaml']){
      const data='user-owned-'+file;sentinels.set(file,data);await writeFile(join(profile,file),data);
    }
    const plan=await setupDeepseekHarness(['--plan','--artifact-dir',artifacts]);
    assert.equal(plan.modifiesProfile,false);await assert.rejects(readFile(plan.durableTarball));
    const fake=join(area,'official-fixture.cjs');
    await writeFile(fake,`const fs=require('node:fs'),p=require('node:path');const args=process.argv.slice(2);if(args[0]==='--version')console.log('0.2.1-rc.5');else if(args[0]==='plugin'){const archive=args.at(-1);if(!fs.existsSync(archive))process.exit(8);fs.writeFileSync(p.join(process.env.DSH_HOME,'added.json'),JSON.stringify(args));}else console.log(JSON.stringify({v:1,runtime:'zhongshuo-dsh',protocol:1,type:'probe',pluginVersion:'0.1.3'}));`);
    const installed=await setupDeepseekHarness(['--install','--artifact-dir',artifacts,'--dsh-js',fake]);assert.equal(installed.pluginVersion,'0.1.3');
    const args=JSON.parse(await readFile(join(process.env.DSH_HOME,'added.json'),'utf8'));
    assert.deepEqual(args.slice(0,5),['plugin','--profile','zhongshuo','add','--save-exact']);assert.equal(args.at(-1),plan.durableTarball);
    await rm(artifacts,{recursive:true});
    const bytes=await readFile(plan.durableTarball);assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
    for(const[file,data]of sentinels)assert.equal(await readFile(join(profile,file),'utf8'),data);
  }finally{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;await rm(area,{recursive:true,force:true});}
});

test('tampered archive is rejected before any profile install or persistent archive write',async()=>{
  const area=await mkdtemp(join(tmpdir(),'zs-r152-tampered-'));const artifacts=join(area,'source');
  try{const manifest=await buildDshRuntime(artifacts);await writeFile(join(artifacts,manifest.tarball),'tampered');
    await assert.rejects(setupDeepseekHarness(['--plan','--artifact-dir',artifacts]),/checksum mismatch/);
  }finally{await rm(area,{recursive:true,force:true});}
});
