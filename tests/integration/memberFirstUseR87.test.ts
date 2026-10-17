import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {runtimeChannelPatch} from '../../src/contracts/runtimeSelection.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';

afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME',undefined);
  const dir=mkdtempSync(join(tmpdir(),'zs-r87-first-use-')),path=join(dir,'project');mkdirSync(path);
  const db=openDatabase(join(dir,'db.sqlite')),deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:async()=>{}};
  const raw=async(method:string,params:unknown,commandId:string=randomUUID())=>await dispatchDaemonCommand(deps,{protocolVersion:1,commandId,method,params}) as {ok:boolean;data:Record<string,unknown>;replayed?:boolean;error?:{code:string}};
  const cmd=async(method:string,params:unknown,id?:string)=>{const r=await raw(method,params,id);expect(r.ok,JSON.stringify(r.error)).toBe(true);return r.data;};
  const projectId=((await cmd('project.open',{path})).project as {id:string}).id;
  const runtime={kind:'fake',model:null,executable:'fake',permissionMode:'plan',effort:null};
  const create=(displayName:string)=>({projectId,displayName,runtime,useAsDefault:true});
  return{db,cmd,raw,projectId,runtime,create};
}
describe('R87 first-use member and runtime in one formal transaction, zero inference',()=>{
  it('saves independent configuration and an available initial coordinator atomically, while receipt loss reuses the same ID',async()=>{
    const f=await fixture();try{
      const count=f.db.prepare('SELECT count(*) n FROM project_members').get() as {n:number};
      const commandId:string=randomUUID(),params=f.create('分析员');const first=await f.cmd('member.create',params,commandId);
      const replay=await f.raw('member.create',params,commandId);expect(replay.replayed).toBe(true);expect(replay.data.memberId).toBe(first.memberId);
      expect(f.db.prepare('SELECT count(*) n FROM project_members').get()).toEqual({n:count.n+1});
      expect(f.db.prepare('SELECT coordinator_member_id FROM rooms').get()).toEqual({coordinator_member_id:first.memberId});
      const runtime=await f.cmd('member.runtime',{memberId:first.memberId});expect(runtime.binding).toMatchObject({kind:'fake',permissionMode:'plan'});
      expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
      const second=await f.cmd('member.create',f.create('复核员'));expect(second.defaultRooms).toBe(0);
      expect(f.db.prepare('SELECT coordinator_member_id FROM rooms').get()).toEqual({coordinator_member_id:first.memberId});
    }finally{f.db.close();}
  });
  it('invalid runtime configuration creates neither a member nor a profile',async()=>{
    const f=await fixture();try{
      const before=f.db.prepare('SELECT count(*) n FROM project_members').get();
      const invalid=await f.raw('member.create',{...f.create('不应创建'),runtime:{...f.runtime,kind:'claude',model:'sk-not-a-model'}});
      expect(invalid).toMatchObject({ok:false,error:{code:'VALIDATION_INVALID'}});
      expect(f.db.prepare('SELECT count(*) n FROM project_members').get()).toEqual(before);
      expect(f.db.prepare("SELECT count(*) n FROM agent_profiles WHERE id LIKE 'ap_m_%'").get()).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('missing programs can be configured without becoming default or starting a process',async()=>{
    const f=await fixture();try{
      const room=f.db.prepare('SELECT coordinator_member_id FROM rooms').get();
      const member=await f.cmd('member.create',{...f.create('以后配置'),runtime:{kind:'claude',model:'fixture-model',executable:'Z:/isolated/nonexistent-claude.exe',permissionMode:'plan'}});
      expect(member.defaultRooms).toBe(0);expect(f.db.prepare('SELECT coordinator_member_id FROM rooms').get()).toEqual(room);
      const runtime=await f.cmd('member.runtime',{memberId:member.memberId});expect(runtime.executableStatus).toMatchObject({status:'missing'});
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('template channel changes clear the old provider model/program/effort and preserve the explicit read-only grant through save and reread',async()=>{
    const f=await fixture();try{
      const member=await f.cmd('member.create',f.create('模板来源'));
      const saved=await f.cmd('memberTemplate.saveFromMember',{projectId:f.projectId,memberId:member.memberId,expectedRevision:1,name:'切渠道模板',description:''});
      const initial={kind:'claude' as const,model:'old-provider-model',executable:'Z:/isolated/old-claude.exe',effort:'high',permissionMode:'plan'};
      await f.cmd('memberTemplate.update',{templateId:saved.id,expectedRevision:0,name:'切渠道模板',description:'',enabled:true,config:initial});
      const codex={...initial,...runtimeChannelPatch('codex')};
      const updated=await f.cmd('memberTemplate.update',{templateId:saved.id,expectedRevision:1,name:'切渠道模板',description:'',enabled:true,config:codex});
      expect(updated.config).toEqual({kind:'codex',model:null,executable:'codex',effort:null,permissionMode:'plan'});
      const claude={...codex,...runtimeChannelPatch('claude'),model:'new-provider-model'};
      await f.cmd('memberTemplate.update',{templateId:saved.id,expectedRevision:2,name:'切渠道模板',description:'',enabled:true,config:claude});
      const reread=await f.cmd('memberTemplate.list',{});
      expect((reread.items as Array<{id:string;config:unknown}>).find(t=>t.id===saved.id)?.config).toEqual({kind:'claude',model:'new-provider-model',executable:'claude',effort:null,permissionMode:'plan'});
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('a new room coordinator is actually a member of its selected roster',async()=>{
    const f=await fixture();try{
      await f.cmd('member.create',f.create('甲'));const b=await f.cmd('member.create',f.create('乙'));
      const result=await f.cmd('room.create',{projectId:f.projectId,name:'只选乙',memberIds:[b.memberId]});
      const room=result.room as {id:string};expect(f.db.prepare('SELECT coordinator_member_id FROM rooms WHERE id=?').get(room.id)).toEqual({coordinator_member_id:b.memberId});
      expect(f.db.prepare('SELECT member_id FROM room_members WHERE room_id=?').all(room.id)).toEqual([{member_id:b.memberId}]);
    }finally{f.db.close();}
  });
});
