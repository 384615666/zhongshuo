import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {collisionFixture,finish,ObservedAdapter} from '../helpers/collisionHarnessR122.ts';

afterEach(()=>vi.unstubAllEnvs());
it('overlapping parent/child project roots wait before scanning and drain yields until the writer releases its lease',async()=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
  const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish('完成',text.includes('TOKEN_PARENT')?450:20)});
  const f=await collisionFixture('r123-overlap-preparation',{writable:true,adapter});
  try{
    const nested=join(f.projects[0]!.path,'nested');mkdirSync(nested);
    const {project}=await f.cmd<{project:{id:string}}>('project.open',{path:nested});
    const {memberId}=await f.cmd<{memberId:string}>('member.create',{projectId:project.id,displayName:'子目录成员'});
    await f.cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
    const {room}=await f.cmd<{room:{id:string;conversationId:string}}>('room.create',{projectId:project.id,name:'子目录房间',memberIds:[memberId]});
    const parent=await f.send(0,0,[0],'TOKEN_PARENT 先占写入目录');
    const child=await f.cmd<{taskId:string}>('message.submit',{target:{kind:'room_root',projectId:project.id,roomId:room.id,conversationId:room.conversationId},body:'TOKEN_CHILD 等待父目录写入完成',intent:'default',mentions:[{kind:'member',memberId}]});
    await f.worker.runOnce();
    const start=Date.now();await f.worker.drain();expect(Date.now()-start).toBeLessThan(1000);
    expect(f.adapter.turns.some(t=>t.taskId===child.taskId)).toBe(false);
    expect(f.count("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='changeset.baselineCaptured'",child.taskId)).toBe(0);
    await f.pumpUntil(()=>[parent,child].every(t=>f.taskStatus(t.taskId)==='DONE'));
    expect(adapter.turns).toHaveLength(2);
    expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='changeset.baselineCaptured'")).toBe(2);
    expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
  }finally{await f.close();}
},10000);
