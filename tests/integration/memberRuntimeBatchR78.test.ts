import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { claudeLaunchIdentity } from '../../src/adapter/claude/cliAdapter.ts';
import type * as ClaudeCliModule from '../../src/adapter/claude/cliAdapter.ts';

vi.mock('../../src/adapter/claude/cliAdapter.ts', async importOriginal => {
  const real = await importOriginal<typeof ClaudeCliModule>();
  return { ...real, claudeLaunchIdentity: vi.fn(real.claudeLaunchIdentity) };
});
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
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
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');vi.mocked(claudeLaunchIdentity).mockClear();
  return {root,db,projectId,ids,settings,raw,cmd};
}
type Batch = { projectId:string; items:Array<{memberId:string;info:{binding:{memberId:string};imageInput:{identityKey:string;status:string}};error?:{code:string}}> };
describe('R78 member runtime bulk read preserves identity and dispatch checks',()=>{
  it('one request shares the exact display identity; next batch and single read see changed config immediately',async()=>{
    const f=await fixture();try{
      const a=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:f.ids}) as unknown as Batch;
      expect(a.projectId).toBe(f.projectId);expect(a.items.map(r=>r.memberId)).toEqual(f.ids);expect(new Set(a.items.map(r=>r.info.imageInput.identityKey)).size).toBe(1);
      // R83 automatic protocol input no longer depends on the old certificate list.
      expect(a.items.every(r=>r.info.binding.memberId===r.memberId&&r.info.imageInput.status==='supported')).toBe(true);
      expect(claudeLaunchIdentity).toHaveBeenCalledTimes(1);
      writeFileSync(f.settings,JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:1/changed'}}));
      const b=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:f.ids}) as unknown as Batch;
      expect(b.items[0]!.info.imageInput.identityKey).not.toBe(a.items[0]!.info.imageInput.identityKey);expect(claudeLaunchIdentity).toHaveBeenCalledTimes(2);
      const single=await f.cmd('member.runtime',{memberId:f.ids[0]});expect((single.imageInput as {identityKey:string}).identityKey).toBe(b.items[0]!.info.imageInput.identityKey);
      expect(claudeLaunchIdentity).toHaveBeenCalledTimes(3);expect((f.db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c).toBe(0);
    }finally{f.db.close();}
  });
  it('different model/permission bindings remain separate; selection cannot cross a project',async()=>{
    const f=await fixture();try{
      vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);await f.cmd('member.setRuntime',{memberId:f.ids[1],kind:'claude',executable:join(f.root,'not-executed.cjs'),model:'other-model',permissionMode:'plan'});vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
      const batch=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:f.ids}) as unknown as Batch;
      expect(batch.items[0]!.info.imageInput.identityKey).not.toBe(batch.items[1]!.info.imageInput.identityKey);
      expect(claudeLaunchIdentity).toHaveBeenCalledTimes(2);
      const other=join(f.root,'other');mkdirSync(other);const opened=await f.cmd('project.open',{path:other});
      const rejected=await f.raw('member.runtimes',{projectId:(opened.project as {id:string}).id,memberIds:f.ids});
      expect(rejected.ok).toBe(false);expect(rejected.error?.code).toBe('VALIDATION_INVALID');
      const empty=await f.cmd('member.runtimes',{projectId:f.projectId,memberIds:[]}) as unknown as Batch;expect(empty.items).toEqual([]);
    }finally{f.db.close();}
  });
});
