import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),'zs-r78-batch-'));roots.push(root);
  const config=join(root,'config');mkdirSync(config);const settings=join(config,'settings.json');
  writeFileSync(settings,JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:1/first'}}));vi.stubEnv('CLAUDE_CONFIG_DIR',config);vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);
  const executable=join(root,'not-executed.cjs');writeFileSync(executable,'// Hash-only engineering fixture; must never execute.');
  const db=openDatabase(':memory:');
  const raw=(method:string,params:unknown)=>dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:join(root,'data'),interruptTurn:async()=>{}},{protocolVersion:1,commandId:'r78-batch-'+randomUUID(),method,params}) as Promise<{ok:boolean;data?:Record<string,unknown>;error?:{code:string;message:string}}>;
  const cmd=async(method:string,params:unknown)=>{const r=await raw(method,params);if(!r.ok)throw new Error(r.error?.message);return r.data!;};
  const open=await cmd('project.open',{path:root});const projectId=(open.project as {id:string}).id;const ids:string[]=[];
  for(let n=0;n<8;n++){const m=await cmd('member.create',{projectId,displayName:'工程成员'+n});ids.push(m.memberId as string);await cmd('member.setRuntime',{memberId:m.memberId,kind:'claude',executable,model:'deepseek-flash',permissionMode:'plan'});}
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
  return {root,db,projectId,ids,settings,raw,cmd};
}
type Batch = { projectId:string; items:Array<{memberId:string;info:{binding:{memberId:string};imageInput:{identityKey:string|null;status:string}};error?:{code:string}}> };
describe('R78/R194 member runtime bulk read: every runtime can view images; no launch-identity probing',()=>{
  it('one request reports all configured members as supported with a null identity; config changes do not alter the answer',async()=>{
    const f=await fixture();try{
      const a=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:f.ids}) as unknown as Batch;
      expect(a.projectId).toBe(f.projectId);expect(a.items.map(r=>r.memberId)).toEqual(f.ids);
      // R194：图片能力不再依赖 CLI 启动身份/证书——所有成员恒 supported，identityKey 恒 null。
      expect(a.items.every(r=>r.info.binding.memberId===r.memberId&&r.info.imageInput.status==='supported'&&r.info.imageInput.identityKey===null)).toBe(true);
      writeFileSync(f.settings,JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:1/changed'}}));
      const b=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:f.ids}) as unknown as Batch;
      expect(b.items.every(r=>r.info.imageInput.status==='supported'&&r.info.imageInput.identityKey===null)).toBe(true);
      const single=await f.cmd('member.runtime',{memberId:f.ids[0]});expect((single.imageInput as {status:string;identityKey:string|null}).status).toBe('supported');expect((single.imageInput as {identityKey:string|null}).identityKey).toBeNull();
      expect((f.db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c).toBe(0);
    }finally{f.db.close();}
  });
  it('different model/permission bindings all stay supported; selection cannot cross a project',async()=>{
    const f=await fixture();try{
      vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);await f.cmd('member.setRuntime',{memberId:f.ids[1],kind:'claude',executable:join(f.root,'not-executed.cjs'),model:'other-model',permissionMode:'plan'});vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
      const batch=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:f.ids}) as unknown as Batch;
      expect(batch.items[0]!.info.imageInput).toMatchObject({status:'supported',identityKey:null});
      expect(batch.items[1]!.info.imageInput).toMatchObject({status:'supported',identityKey:null});
      const other=join(f.root,'other');mkdirSync(other);const opened=await f.cmd('project.open',{path:other});
      const rejected=await f.raw('member.runtimes',{projectId:(opened.project as {id:string}).id,memberIds:f.ids});
      expect(rejected.ok).toBe(false);expect(rejected.error?.code).toBe('VALIDATION_INVALID');
      const empty=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:[]}) as unknown as Batch;expect(empty.items).toEqual([]);
    }finally{f.db.close();}
  });
});
