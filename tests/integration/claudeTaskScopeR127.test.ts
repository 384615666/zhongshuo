import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {claudeLaunchIdentity} from '../../src/adapter/claude/cliAdapter.ts';
import {effectiveTaskWriteAccess,snapshotConversationWriteAccess} from '../../src/daemon/projectWriteAccess.ts';

const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'zs-r127-scope-'));roots.push(root);
  const config=join(root,'config');mkdirSync(config);
  vi.stubEnv('CLAUDE_CONFIG_DIR',config);vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);
  const settings=join(config,'settings.json'),executable=join(root,'fixture.cjs');
  writeFileSync(executable,'// Hash only; never execute this fixture.');
  const save=(extra:Record<string,unknown>={})=>writeFileSync(settings,JSON.stringify({theme:'dark',env:{ANTHROPIC_BASE_URL:'https://channel.example.test',ANTHROPIC_AUTH_TOKEN:'private-fixture-token'},...extra}));save();
  const db=openDatabase(':memory:');
  const cmd=async(method:string,params:unknown)=>{
    const r=await dispatchDaemonCommand({db,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:Record<string,unknown>;error?:{message:string}};
    if(!r.ok)throw Error(r.error?.message);return r.data;
  };
  const projectId=((await cmd('project.open',{path:root})).project as {id:string}).id;
  const memberId=(await cmd('member.create',{projectId,displayName:'Claude'})).memberId as string;
  await cmd('member.setRuntime',{memberId,kind:'claude',model:'deepseek-flash',permissionMode:'bypassPermissions',executable});
  const room=((await cmd('room.list',{projectId})).items as Array<{id:string;conversationId:string}>)[0]!;
  const sent=await cmd('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'检查合成需求',intent:'default',mentions:[{kind:'member',memberId}]});
  const taskId=sent.taskId as string;
  const scope=()=>JSON.parse((db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(taskId) as {write_scope_json:string}).write_scope_json) as {launchIdentity:string;launchFingerprintVersion:number;launchEvidence:Record<string,string>;runtime:unknown};
  return{root,db,taskId,memberId,projectId,settings,executable,save,scope};
}

describe('R127 formal Claude launch scope',()=>{
  it('freezes new requests as v3, ignores theme changes, and retains immutable safe evidence',async()=>{
    const f=await fixture();try{
      const before=f.scope();expect(before.launchFingerprintVersion).toBe(3);
      expect(Object.keys(before.launchEvidence).length).toBeGreaterThan(5);
      expect(JSON.stringify(before.launchEvidence)).not.toMatch(/private-fixture-token|channel\.example/);
      f.save({theme:'light'});
      expect(effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null).fullAccess).toBe(true);
      expect(f.scope()).toEqual(before);
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('reports the changed configuration source without exposing values or silently authorizing it',async()=>{
    const f=await fixture();try{
      const before=f.scope();f.save({env:{ANTHROPIC_BASE_URL:'https://changed.example.test',ANTHROPIC_AUTH_TOKEN:'new-private-token'}});
      let failure='';try{effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null);}catch(error){failure=String(error);}
      expect(failure).toContain('settings.json');expect(failure).not.toMatch(/new-private-token|changed\.example/);
      expect(f.scope()).toEqual(before);
      // A new explicit continuation gets a new scope, preserving the old task.
      const fresh=snapshotConversationWriteAccess(f.db,f.taskId,null);
      expect(effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null,fresh).fullAccess).toBe(true);
      expect(f.scope()).toEqual(before);
    }finally{f.db.close();}
  });
  it('compares historical v2 scopes using the frozen v2 algorithm without upgrading their authorization',async()=>{
    const f=await fixture();try{
      const current=f.scope(),launch=claudeLaunchIdentity({executable:f.executable,model:'deepseek-flash',permissionMode:'bypassPermissions'},f.root);
      const legacy={...current,launchFingerprintVersion:2,launchIdentity:createHash('sha256').update(JSON.stringify({projectId:f.projectId,root:f.root,runtime:current.runtime,mode:'full',configuration:launch.previousIdentityKey})).digest('hex')};
      f.db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(JSON.stringify(legacy),f.taskId);
      expect(effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null).fullAccess).toBe(true);
      f.save({theme:'light'});
      expect(()=>effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null)).toThrow('有效执行配置已变化');
      expect(f.scope()).toEqual(legacy);
      const fresh=snapshotConversationWriteAccess(f.db,f.taskId,null);
      expect(JSON.parse(fresh).launchFingerprintVersion).toBe(3);
      expect(effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null,fresh).fullAccess).toBe(true);
    }finally{f.db.close();}
  });
});
