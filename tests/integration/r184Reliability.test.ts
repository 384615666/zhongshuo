import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,utimesSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {zipSync} from 'fflate';
import {openDatabase} from '../../src/persistence/db.ts';
import {artifactPath,bindArtifactDataRoot} from '../../src/persistence/artifactPath.ts';
import {openProject} from '../../src/daemon/projectStore.ts';
import {parseImageMeta} from '../../src/daemon/attachments.ts';
import {safeUnzipWith} from '../../src/daemon/zipGuard.ts';
import {safeFilename} from '../../src/contracts/safeFilename.ts';
import {hasVisibleText} from '../../src/contracts/visibleText.ts';
import {validatedImages} from '../../src/adapter/imageInput.ts';
import {createHash} from 'node:crypto';
import type {TurnRequest} from '../../src/contracts/runtime.ts';
import {ByteLru} from '../../src/ui/hifi/lib/byteLru.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {maintainStorage} from '../../src/daemon/storageMaintenance.ts';
import {captureGit} from '../../src/daemon/gitStatus.ts';
import {copyClosedDataRoot} from '../../src/contracts/localDataCopy.ts';
import {verifyArtifactIntegrity} from '../../src/persistence/stores/deliberation.ts';
import {userFacingSystemText} from '../../src/contracts/userFacingText.ts';

const root=mkdtempSync(join(tmpdir(),'zs-r184-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
afterEach(()=>vi.unstubAllEnvs());

describe('R184 verified review regressions',()=>{
  it.each(['CON','NUL.txt','com1.log','a:b.txt','a\nb.txt','a\r\0b.txt','../escape','x\\y','a?.txt','a*.txt','a|b.txt','x. ',' '.repeat(10),'文'.repeat(200)+'.txt'])('portable filename: %s',name=>{
    const out=safeFilename(name);
  // eslint-disable-next-line no-control-regex -- intentionally matching invisible/control code points
    expect(out).not.toMatch(/[\x00-\x1f<>:"/\\|?*]/);
    expect(out).not.toMatch(/[. ]$/);
    expect(out).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(180);
  });
  it('preserves ordinary filenames and distinguishable long names',()=>{
    expect(safeFilename('报告 2026.xlsx')).toBe('报告 2026.xlsx');
    expect(safeFilename('文'.repeat(200)+'a.txt')).not.toBe(safeFilename('文'.repeat(200)+'b.txt'));
  });
  it('rejects invisible-only text while retaining family emoji and Chinese',()=>{
    expect(hasVisibleText(' \u200b\u200d\u200f\u202e\u2060\ufeff')).toBe(false);
    expect(hasVisibleText('👨‍👩‍👧‍👦')).toBe(true);expect(hasVisibleText('中文')).toBe(true);
  });
  it('does not initialize existing empty/corrupt or missing-main WAL databases',()=>{
    for(const [name,bytes] of [['empty',Buffer.alloc(0)],['corrupt',Buffer.from('not a database')]] as const){
      const path=join(root,name+'.sqlite');writeFileSync(path,bytes);
      expect(()=>openDatabase(path)).toThrow(/数据文件/);expect(readFileSync(path)).toEqual(bytes);
    }
    const path=join(root,'missing.sqlite');writeFileSync(path+'-wal','saved log');
    expect(()=>openDatabase(path)).toThrow(/主数据库缺失/);
    const db=openDatabase(join(root,'new.sqlite'));expect(db.pragma('user_version',{simple:true})).toBeGreaterThan(0);db.close();
  });
  it('resolves copied relative and legacy artifact paths against the destination root',()=>{
    const from=join(root,'from'),to=join(root,'to');mkdirSync(join(from,'artifacts'),{recursive:true});
    const db=openDatabase(join(from,'state.sqlite'));
    const path=join(from,'artifacts','report.json');writeFileSync(path,'old report');
    db.close();cpSync(from,to,{recursive:true});
    const copy=openDatabase(join(to,'state.sqlite'));bindArtifactDataRoot(copy,to);writeFileSync(path,'source changed');
    expect(readFileSync(artifactPath(copy,path),'utf8')).toBe('old report');
    expect(readFileSync(artifactPath(copy,'artifacts/report.json'),'utf8')).toBe('old report');
    expect(()=>artifactPath(copy,'../outside')).toThrow();copy.close();
  });
  it('copies a closed data root through the production data-copy API and verifies its artifact bodies',async()=>{
    const from=join(root,'copy-api-source'),parent=join(root,'copy-api-target');mkdirSync(parent);
    const db=openDatabase(join(from,'state.sqlite'));const project=openProject(db,{rootPath:from,now:1});if(!project.ok)throw Error('fixture project');
    const path=join(from,'artifacts','report.json');mkdirSync(dirname(path),{recursive:true});const body='{"answer":"copied report"}';writeFileSync(path,body);
    db.prepare("INSERT INTO artifacts(id,project_id,author_id,kind,revision,hash,blob_path) VALUES('art-copy',?,'system','final_report',1,?,?)")
      .run(project.value.project.id,createHash('sha256').update(body).digest('hex'),path);db.close();
    writeFileSync(join(from,'desktop-shutdown.json'),JSON.stringify({exited:true,forceKilled:false,daemonStopResult:{complete:true}}));
    const result=await copyClosedDataRoot({source:from,destinationParent:parent,kind:'import',maxSchemaVersion:61,verifyDatabase:file=>{
      const copy=openDatabase(file);
      try{return {schemaVersion:copy.pragma('user_version',{simple:true}) as number};}finally{copy.close();}
    }});
    writeFileSync(path,'source changed');const copy=openDatabase(join(result.dataRoot,'state.sqlite'));bindArtifactDataRoot(copy,result.dataRoot);
    try{expect(verifyArtifactIntegrity(copy,{}).rows).toEqual([{artifactId:'art-copy',ok:true}]);}finally{copy.close();}
  });
  it.each([
    ['Too big: expected string to have <=20000 characters','20000'],
    ["Error invoking remote method 'zs:command': reply was never sent",'尚未确认'],
    ['SQLITE_READONLY: readonly database','无法写入'],['SQLITE_CORRUPT','损坏'],['SQLITE_BUSY','占用'],['SQLITE_FULL','空间不足'],
    ['ENOENT: open file','不可用'],['EINVAL: invalid path','无效'],['EPERM: denied','权限'],
  ])('presents a readable Chinese explanation for %s',(raw,expected)=>{expect(userFacingSystemText(raw)).toContain(expected);});
  it('deduplicates project 60 and restores it after removal',()=>{
    const db=openDatabase(':memory:');let id='';let path='';
    try{
      for(let n=0;n<61;n++){path=join(root,`project-${n}`);mkdirSync(path);const r=openProject(db,{rootPath:path,now:n});expect(r.ok).toBe(true);if(r.ok)id=r.value.project.id;}
      const r=openProject(db,{rootPath:path,now:100});expect(r.ok&&r.value.project.id).toBe(id);
      db.prepare("UPDATE projects SET status='removed' WHERE id=?").run(id);
      const restored=openProject(db,{rootPath:path,now:101});expect(restored.ok&&restored.value.project.id).toBe(id);
      expect((db.prepare('SELECT count(*) n FROM projects').get() as {n:number}).n).toBe(61);
    }finally{db.close();}
  });
  it('reads JPEG SOF beyond large APP2 metadata and rejects truncated segments',()=>{
    const app=Buffer.alloc(65537);app[0]=255;app[1]=226;app.writeUInt16BE(65535,2);
    const sof=Buffer.from([255,192,0,11,8,0,10,0,20,1,1,17,0]);
    expect(parseImageMeta(Buffer.concat([Buffer.from([255,216]),...Array(6).fill(app),sof]))).toMatchObject({width:20,height:10});
    expect(parseImageMeta(Buffer.concat([Buffer.from([255,216]),app.subarray(0,16)]))).toBeNull();
  });
  it('unpacks 5000 small ZIP entries without recursive stack overflow',()=>{
    const entries=Object.fromEntries(Array.from({length:5000},(_,i)=>[`ppt/${i}.xml`,Buffer.from('<x/>')]));
    const out=safeUnzipWith(Buffer.from(zipSync(entries)));expect(Object.keys(out)).toHaveLength(5000);
    expect(out['ppt/4999.xml']!.toString()).toBe('<x/>');
  });
  it.each([10,50])('accepts %i MiB verified image bytes',mb=>{
    const raw=Buffer.alloc(mb*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(raw);
    const input={text:'image',images:[{mime:'image/png',dataBase64:raw.toString('base64'),hash:createHash('sha256').update(raw).digest('hex')}]} as TurnRequest;
    expect(validatedImages(input)).toHaveLength(1);
    input.images![0]!.hash='wrong';expect(()=>validatedImages(input)).toThrowError(expect.objectContaining({notStarted:true}));
  });
  it('evicts least recently used preview bytes and does not retain an oversized file',()=>{
    const cache=new ByteLru<string>(s=>s.length,10,4);cache.set('a','1234');cache.set('b','1234');cache.get('a');cache.set('c','1234');
    expect([...cache.keys()]).toEqual(['a','c']);cache.set('large','x'.repeat(100));expect(cache.has('large')).toBe(false);cache.clear();expect(cache.size).toBe(0);
  });
  it('production command surface cannot enable remote access or create pairing codes',async()=>{
    vi.stubEnv('ZS_REMOTE_ADVANCED','');const db=openDatabase(':memory:');
    try{for(const method of ['remote.config.set','remote.pairing.create']){
      const reply=await dispatchDaemonCommand({db,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:method,method,params:{}});
      expect(reply).toMatchObject({ok:false,error:{code:'CAPABILITY_UNSUPPORTED'}});
    }}finally{db.close();}
  });
  it('upgrading a root that enabled remote starts without a listener',async()=>{
    vi.stubEnv('ZS_REMOTE_ADVANCED','');vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY','0');
    const dir=join(root,'remote-upgrade');const db=openDatabase(join(dir,'state.sqlite'));
    db.prepare('UPDATE remote_config SET enabled=1,allow_lan=1,port=0 WHERE id=1').run();db.close();
    const {startDaemon}=await import('../../src/daemon/entry.ts');
    const daemon=await startDaemon({appDataDir:dir,runtime:'fake',tickMs:60000,pipeName:`\\\\.\\pipe\\zs-r184-${Date.now()}`});
    try{
      expect(daemon.db.prepare('SELECT enabled,allow_lan FROM remote_config').get()).toEqual({enabled:0,allow_lan:0});
      expect(await dispatchDaemonCommand({db:daemon.db,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:'remote-read',method:'remote.config.get',params:{}}))
        .toMatchObject({ok:true,data:{enabled:false,running:false}});
      expect(daemon.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{expect(await daemon.stop()).toMatchObject({complete:true});}
  });
  it('cleans old orphan preimages and receipt bodies while preserving idempotency identities',async()=>{
    const dir=join(root,'cleanup'),db=openDatabase(join(dir,'state.sqlite')),hash='a'.repeat(64);
    const preimages=join(dir,'preimages','project');mkdirSync(preimages,{recursive:true});writeFileSync(join(preimages,hash),'orphan');
    const old=new Date(Date.now()-100*86400_000);utimesSync(join(preimages,hash),old,old);
    db.prepare("INSERT INTO command_receipts(idempotency_scope,command_id,payload_hash,result_json,created_at) VALUES('local','old','hash','{}',?)").run(old.getTime());
    try{
      const result=await maintainStorage(db,dir);expect(result).toMatchObject({removedFiles:1,expiredReceipts:1});
      expect(existsSync(join(preimages,hash))).toBe(false);
      expect(db.prepare("SELECT command_id,result_json FROM command_receipts WHERE command_id='old'").get()).toEqual({command_id:'old',result_json:null});
    }finally{db.close();}
  });
  it('terminates a hung Git process tree within its deadline and subsequent commands still work',async()=>{
    const start=Date.now();
    const result=await captureGit(['-c','alias.zs-hang=!node -e "setTimeout(()=>{},60000)"','zs-hang'],{cwd:root,timeoutMs:300});
    expect(result.spawnError).toContain('超时');expect(Date.now()-start).toBeLessThan(5000);
    expect((await captureGit(['--version'],{cwd:root})).exitCode).toBe(0);
  },10000);
  it('keeps Chinese filenames readable in status and staged diff headers',async()=>{
    const dir=join(root,'git-chinese');mkdirSync(dir);
    expect((await captureGit(['init'],{cwd:dir})).exitCode).toBe(0);
    writeFileSync(join(dir,'中文文件.txt'),'正文');
    expect((await captureGit(['status','--porcelain=v1'],{cwd:dir})).stdout.toString('utf8')).toContain('中文文件.txt');
    expect((await captureGit(['add','--','中文文件.txt'],{cwd:dir})).exitCode).toBe(0);
    const diff=await captureGit(['diff','--cached'],{cwd:dir});expect(diff.stdout.toString('utf8')).toContain('中文文件.txt');
  });
});
