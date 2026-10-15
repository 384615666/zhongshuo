import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
interface Client {
  configureReadingPositions: (namespace: string) => void;
  gitWrite: <T = unknown>(projectId: string, method: string, params: Record<string, unknown>, replay?: boolean) => Promise<{ status:'ok'; data:T } | { status:'failed'|'unknown'; error:string }>;
  pendingGitWrites: () => Array<{ commandId:string; params:Record<string,unknown> }>;
}
let gitWrite: Client['gitWrite'], pendingGitWrites: Client['pendingGitWrites'];

const owned: Array<{ dir: string; close: () => void }> = [];
afterEach(() => { vi.unstubAllGlobals(); for (const f of owned.splice(0)) { f.close(); if (!resolve(f.dir).startsWith(resolve(tmpdir(),'zs-r85-receipt-'))) throw Error('unsafe fixture path'); rmSync(f.dir,{recursive:true,force:true}); } });
async function fixture(unborn = false) {
  const dir=mkdtempSync(join(tmpdir(),'zs-r85-receipt-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:15000}).trim();
  git('init','-q','-b','main');git('config','user.name','R85');git('config','user.email','r85@example.invalid');git('config','core.autocrlf','false');writeFileSync(join(root,'base.txt'),'base\n');if(!unborn){git('add','.');git('commit','-qm','base');}
  const db=openDatabase(join(dir,'state.sqlite'));owned.push({dir,close:()=>db.close()});const deps={db,localUserId:'u_r85_receipt',appDataDir:dir,interruptTurn:async()=>{}};
  // Compile the actual browser gateway for this Node integration host; no surrogate
  // implementation and no mocked daemon response. Avoid importing DOM code into Node's TS project.
  const bundle=join(dir,'actual-frontend.cjs');
  buildSync({stdin:{contents:"export {gitWrite,pendingGitWrites} from './src/ui/hifi/data/gitWrites.ts';export {configureReadingPositions} from './src/ui/hifi/data/readingPositions.ts';",resolveDir:fileURLToPath(new URL('../../',import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:bundle});
  const client=createRequire(import.meta.url)(bundle) as Client;gitWrite=client.gitWrite;pendingGitWrites=client.pendingGitWrites;
  const envelopes:Array<{commandId:string;method:string;params:Record<string,unknown>}>=[];
  const dispatch=async(env:{commandId:string;method:string;params:Record<string,unknown>})=>{envelopes.push(structuredClone(env));return await dispatchDaemonCommand(deps,{protocolVersion:1,...env});};
  const cmd=async<T,>(method:string,params:Record<string,unknown>)=>{const r=await dispatch({commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error:unknown};expect(r.ok,JSON.stringify(r.error)).toBe(true);return r.data;};
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:root})).project.id;
  const memory=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>memory.set(k,v)});vi.stubGlobal('window',{zs:{command:dispatch},dispatchEvent:()=>true});client.configureReadingPositions('receipt-'+randomUUID());
  const failDone=()=>db.exec("CREATE TRIGGER r85_fail_done BEFORE UPDATE OF status ON git_operations WHEN NEW.status='done' BEGIN SELECT RAISE(FAIL,'isolated receipt failure'); END");
  return{root,db,git,cmd,projectId,envelopes,failDone};
}

describe('R85 actual Git effects + formal daemon + actual frontend durable gateway; SQLite fault injection only',()=>{
  it('an initialized empty repository can unstage without deleting its sole copy, then make its first approved commit',async()=>{
    const f=await fixture(true),params={projectId:f.projectId,paths:['base.txt']};
    await f.cmd('git.stage',params);expect(f.git('ls-files')).toBe('base.txt');
    await f.cmd('git.unstage',params);expect(f.git('ls-files')).toBe('');expect(readFileSync(join(f.root,'base.txt'),'utf8')).toBe('base\n');
    await f.cmd('git.stage',params);const p=await f.cmd<{head:string|null;indexTree:string;branch:string}>('git.commitPreview',{projectId:f.projectId});expect(p.head).toBe(null);
    expect((await gitWrite(f.projectId,'git.commit',{projectId:f.projectId,message:'first real commit',expectedHead:p.head,expectedIndexTree:p.indexTree,expectedBranch:p.branch})).status).toBe('ok');
    expect(f.git('rev-list','--count','HEAD')).toBe('1');expect(f.git('show','HEAD:base.txt')).toBe('base');
  });
  it('commit completed before SQLite failure retains original envelope, then recovers one commit by the same number',async()=>{
    const f=await fixture();writeFileSync(join(f.root,'new.txt'),'new\n');await f.cmd('git.stage',{projectId:f.projectId,paths:['new.txt']});
    const p=await f.cmd<{head:string;indexTree:string;branch:string}>('git.commitPreview',{projectId:f.projectId});
    const params={projectId:f.projectId,message:'real commit before receipt failure',expectedHead:p.head,expectedIndexTree:p.indexTree,expectedBranch:p.branch};f.failDone();
    const first=await gitWrite<{commit:string}>(f.projectId,'git.commit',params);
    expect(first.status).toBe('unknown');const saved=pendingGitWrites()[0]!;expect(saved.params).toEqual(params);
    const committed=f.git('rev-parse','HEAD');expect(committed).not.toBe(p.head);expect(f.git('log','-1','--format=%B')).toContain(saved.commandId);
    expect(f.db.prepare('SELECT status FROM git_operations WHERE id=?').get(saved.commandId)).toEqual({status:'pending'});
    expect((await gitWrite(f.projectId,'git.commit',{...params,message:'must not create another'})).status).toBe('unknown');
    // Separate SQL read fault before the Git-specific error boundary. It cannot
    // invalidate the already observed effect or discard the original client envelope.
    const prepare=f.db.prepare.bind(f.db);
    const lookup=vi.spyOn(f.db,'prepare').mockImplementation((sql:string)=>{if(sql==='SELECT canonical_path FROM projects WHERE id = ?')throw Error('temporary project lookup EIO');return prepare(sql);});
    expect((await gitWrite(f.projectId,'git.commit',params,true)).status).toBe('unknown');expect(pendingGitWrites()).toHaveLength(1);expect(f.git('rev-parse','HEAD')).toBe(committed);lookup.mockRestore();
    f.db.exec('DROP TRIGGER r85_fail_done');const recovered=await gitWrite<{commit:string}>(f.projectId,'git.commit',params,true);
    expect(recovered.status).toBe('ok');if(recovered.status==='ok')expect(recovered.data.commit).toBe(committed);
    expect(f.git('rev-parse','HEAD')).toBe(committed);expect(f.git('rev-list','--count','HEAD')).toBe('2');expect(pendingGitWrites()).toEqual([]);
    const sent=f.envelopes.filter(e=>e.method==='git.commit');expect(sent).toHaveLength(3);expect(sent[1]).toEqual(sent[0]);expect(sent[2]).toEqual(sent[0]);
    expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
  });
  it('branch creation with lost durable receipt recovers the existing exact ref without recreating or switching',async()=>{
    const f=await fixture(),head=f.git('rev-parse','HEAD'),params={projectId:f.projectId,name:'topic/r85',expectedHead:head};f.failDone();
    expect((await gitWrite(f.projectId,'git.branch.create',params)).status).toBe('unknown');expect(f.git('rev-parse','refs/heads/topic/r85')).toBe(head);expect(f.git('symbolic-ref','--short','HEAD')).toBe('main');
    const saved=pendingGitWrites()[0]!;f.db.exec('DROP TRIGGER r85_fail_done');
    const r=await gitWrite<{verifiedExisting:boolean}>(f.projectId,'git.branch.create',params,true);expect(r.status).toBe('ok');if(r.status==='ok')expect(r.data.verifiedExisting).toBe(true);
    expect(f.git('branch','--list','topic/r85').split('\n')).toHaveLength(1);expect(pendingGitWrites()).toEqual([]);expect(f.envelopes.filter(e=>e.method==='git.branch.create').map(e=>e.commandId)).toEqual([saved.commandId,saved.commandId]);
  });
  it('fresh stale approval and duplicate branch are known refusals, so corrected inputs can be submitted',async()=>{
    const f=await fixture(),head=f.git('rev-parse','HEAD');
    expect((await gitWrite(f.projectId,'git.branch.create',{projectId:f.projectId,name:'main',expectedHead:head})).status).toBe('failed');expect(pendingGitWrites()).toEqual([]);
    expect((await gitWrite(f.projectId,'git.branch.create',{projectId:f.projectId,name:'topic/new',expectedHead:'0'.repeat(40)})).status).toBe('failed');expect(pendingGitWrites()).toEqual([]);expect(f.git('rev-parse','HEAD')).toBe(head);
    expect((await gitWrite(f.projectId,'git.branch.create',{projectId:f.projectId,name:'topic/new',expectedHead:head})).status).toBe('ok');expect(f.git('rev-parse','refs/heads/topic/new')).toBe(head);
  });
});
