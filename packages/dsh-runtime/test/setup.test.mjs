import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {buildDshRuntime} from '../../../scripts/build-dsh-runtime.mjs';
import {setupDeepseekHarness} from '../../../scripts/setup-deepseek-harness.mjs';

for(const officialVersion of ['0.2.1-rc.5','0.2.2-rc.1'])test(`installer preserves user configuration and installs verified archive on DSH ${officialVersion}`,async()=>{
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
    await writeFile(fake,`const fs=require('node:fs'),p=require('node:path');const args=process.argv.slice(2);if(args[0]==='--version')console.log('${officialVersion}');else if(args[0]==='plugin'){const archive=args.at(-1);if(!fs.existsSync(archive))process.exit(8);fs.writeFileSync(p.join(process.env.DSH_HOME,'added.json'),JSON.stringify(args));}else console.log(JSON.stringify({v:1,runtime:'zhongshuo-dsh',protocol:1,type:'probe',pluginVersion:'0.1.4'}));`);
    const installed=await setupDeepseekHarness(['--install','--artifact-dir',artifacts,'--dsh-js',fake]);assert.equal(installed.pluginVersion,'0.1.4');
    assert.equal(installed.dshVersion,officialVersion);
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

test('installer skips absent Harness and installs or verifies the exact current component',async()=>{
  const area=await mkdtemp(join(tmpdir(),'zs-r187-auto-'));
  const saved=Object.fromEntries(['DSH_HOME','PATH','LOCALAPPDATA','APPDATA'].map(key=>[key,process.env[key]]));
  try{
    process.env.DSH_HOME=join(area,'home');process.env.PATH=area;process.env.LOCALAPPDATA=join(area,'local');process.env.APPDATA=join(area,'roaming');
    const artifacts=join(area,'artifacts'),manifest=await buildDshRuntime(artifacts);
    assert.deepEqual(await setupDeepseekHarness(['--installer','--artifact-dir',artifacts]),{status:'skipped',reason:'harness-not-installed',modifiesProfile:false});
    const profile=join(process.env.DSH_HOME,'profiles/zhongshuo'),plugin=join(profile,'node_modules/@zhongshuo/dsh-runtime');
    await mkdir(plugin,{recursive:true});
    const marker=join(profile,'cordis.patch.yml');await writeFile(marker,'preserve user provider config');
    const fake=join(area,'dsh.mjs');
    await writeFile(fake,`import{writeFileSync,appendFileSync}from'node:fs';const args=process.argv.slice(2);if(args[0]==='--version')console.log('0.2.2-rc.1');else if(args[0]==='plugin')appendFileSync(${JSON.stringify(join(area,'calls'))},'install\\n');else console.log(JSON.stringify({v:1,runtime:'zhongshuo-dsh',type:'probe',protocol:1,pluginVersion:'${manifest.pluginVersion}'}));`);
    const first=await setupDeepseekHarness(['--installer','--artifact-dir',artifacts,'--dsh-js',fake]);assert.equal(first.status,'installed');
    assert.equal(await readFile(join(area,'calls'),'utf8'),'install\n');
    // Populate the exact installed payload; subsequent upgrades only probe it.
    const {cp}=await import('node:fs/promises');
    for(const file of Object.keys(manifest.files))await cp(join('packages/dsh-runtime',file),join(plugin,file));
    const current=await setupDeepseekHarness(['--installer','--artifact-dir',artifacts,'--dsh-js',fake]);assert.equal(current.status,'current');
    assert.equal(await readFile(join(area,'calls'),'utf8'),'install\n');
    assert.equal(await readFile(marker,'utf8'),'preserve user provider config');
    // A stale component must be upgraded, even if its package version matches.
    await writeFile(join(plugin,'backend.mjs'),'stale');
    assert.equal((await setupDeepseekHarness(['--installer','--artifact-dir',artifacts,'--dsh-js',fake])).status,'installed');
    assert.equal(await readFile(join(area,'calls'),'utf8'),'install\ninstall\n');
    // Failure propagates; the caller cannot display it as successful setup.
    await writeFile(fake,"console.log('9.9.9');");
    await assert.rejects(setupDeepseekHarness(['--installer','--artifact-dir',artifacts,'--dsh-js',fake]),/supports DSH/);
  }finally{for(const[key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(area,{recursive:true,force:true});}
});
