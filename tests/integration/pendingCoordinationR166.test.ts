import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {coordinationDispatchContext,pumpCoordinations} from '../../src/daemon/coordination.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'zs-r166-'));dirs.push(dir);
  const db=openDatabase(':memory:');
  db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','项目',?,?,'{}',0)").run(dir,dir);
  for(const id of ['owner','a','b','c','d'])db.prepare("INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES(?,'p',?,'agent',1)").run(id,id);
  db.exec(`INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','p','房间','owner');
    INSERT INTO conversations(id,project_id,kind,room_id) VALUES('conv','p','room','room');
    INSERT INTO conversation_threads(id,project_id,conversation_id,room_id,anchor_message_id,root_task_id) VALUES('thread','p','conv','room','anchor','parent');
    INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,title,status,owner_member_id)
      VALUES('parent','p','conv','room_task','room','thread','当前请求','ACTIVE','owner');
    INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES('plan','parent','conv','thread','AUTO','WAITING');`);
  const plan={summary:'四人真实答复后统一回应',steps:['a','b','c','d'].map(memberId=>({key:memberId,memberId,title:memberId,objective:'说说看法',role:'analysis',dependsOn:[]}))};
  db.prepare("INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,plan_json,created_at) VALUES('plan','parent',0,'running',?,0)").run(JSON.stringify(plan));
  for(const [index,id] of ['a','b','c','d'].entries()){
    db.prepare(`INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,parent_task_id,owner_member_id,title,status,response_kind)
      VALUES(?,'p','conv','room_task','room','thread','parent',?,?,'DONE','conversation')`).run('child-'+id,id,'同伴 '+id);
    db.prepare("INSERT INTO coordination_steps(run_id,step_key,child_task_id,role,handoff_json) VALUES('plan',?,?,'analysis','{\"upstream\":[]}')").run(id,'child-'+id);
    db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES(?,?,'conv','thread','DIRECT','SUCCEEDED')").run('run-'+id,'child-'+id);
    db.prepare("INSERT INTO agent_turns(id,run_id,conversation_id,member_id,stage_key,status,dispatch_key) VALUES(?,?,'conv',?,'direct.work','SUCCEEDED',?)").run('turn-'+id,'run-'+id,id,'dispatch-'+id);
    db.prepare(`INSERT INTO messages(id,project_id,conversation_id,conversation_seq,thread_id,thread_message_seq,task_id,author_type,author_id,body_json,status,created_at)
      VALUES(?,'p','conv',?,'thread',?,?,'agent',?,?,'final',?)`).run('reply-'+id,index+1,index+1,'child-'+id,id,JSON.stringify({text:'真实答复 '+id}),index+1);
    db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,0)').run('final-message:turn-'+id,'reply-'+id);
  }
  const pending=async()=>{
    const r=await dispatchDaemonCommand({db,localUserId:'viewer',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method:'mine.pending',params:{}}) as {ok:boolean;data:{projects:Array<{blockedTasks:Array<{task_id:string;reason:string}>;reviewTasks:Array<{task_id:string}>}>}};
    expect(r.ok).toBe(true);return r.data.projects;
  };
  return {db,pending};
}
describe('R166 current attention and conversation handoff completion',()=>{
  it('queues one coordinator integration after all four actual conversation replies, without requiring file deliveries',()=>{
    const {db}=fixture();try{
      db.exec("UPDATE tasks SET status='ACTIVE' WHERE id='child-d';UPDATE workflow_runs SET status='RUNNING' WHERE id='run-d';UPDATE agent_turns SET status='RUNNING' WHERE id='turn-d'");
      pumpCoordinations(db);expect(db.prepare('SELECT count(*) n FROM outbox').get()).toEqual({n:0});
      db.exec("UPDATE tasks SET status='DONE' WHERE id='child-d';UPDATE workflow_runs SET status='SUCCEEDED' WHERE id='run-d';UPDATE agent_turns SET status='SUCCEEDED' WHERE id='turn-d'");
      pumpCoordinations(db);pumpCoordinations(db);
      expect(db.prepare("SELECT state FROM coordination_runs WHERE run_id='plan'").get()).toEqual({state:'integrating'});
      expect(db.prepare('SELECT count(*) n FROM outbox').get()).toEqual({n:1});
      const context=coordinationDispatchContext(db,'parent','task:parent:redispatch:coord_plan');
      for(const id of ['a','b','c','d']){expect(context?.note).toContain('真实答复 '+id);expect(context?.note).toContain('reply-'+id);}
      expect(readTaskExecutionStatus(db,'parent')?.phase).toBe('QUEUED');
      expect(db.prepare('SELECT count(*) n FROM task_deliveries').get()).toEqual({n:0});
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();}
  });
  it.each(['missing-reply','old-reply','new-parent-request','missing-work-delivery','unknown'])('does not promote incomplete or unsafe peer results (%s)',kind=>{
    const {db}=fixture();try{
      if(kind==='missing-reply')db.exec("DELETE FROM messages WHERE id='reply-d'");
      if(kind==='new-parent-request')db.exec("INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES('later-parent','parent','conv','DIRECT','RUNNING')");
      if(kind==='old-reply'){
        db.exec("INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES('later-d','child-d','conv','DIRECT','SUCCEEDED');INSERT INTO agent_turns(id,run_id,conversation_id,member_id,stage_key,status,dispatch_key) VALUES('later-turn','later-d','conv','d','direct.work','SUCCEEDED','later-dispatch')");
        db.prepare("UPDATE coordination_steps SET handoff_json=? WHERE child_task_id='child-d'").run(JSON.stringify({output:{kind:'conversation',run_id:'run-d',final:{text:'过时答复'}}}));
      }
      if(kind==='missing-work-delivery')db.exec("UPDATE tasks SET response_kind='work' WHERE id='child-d'");
      if(kind==='unknown')db.exec("UPDATE agent_turns SET status='UNKNOWN',protection_state='retained' WHERE id='turn-d'");
      pumpCoordinations(db);expect(db.prepare('SELECT count(*) n FROM outbox').get()).toEqual({n:0});
      expect(db.prepare("SELECT state FROM coordination_runs WHERE run_id='plan'").get()).not.toEqual({state:'integrating'});
    }finally{db.close();}
  });
  it.each(['DONE','CANCELLED'])('omits historical failures below a finished parent (%s), retains unresolved protection, and never rewrites history on read',async status=>{
    const {db,pending}=fixture();try{
      db.exec("UPDATE tasks SET status='DONE' WHERE id='parent';UPDATE coordination_runs SET state='completed' WHERE run_id='plan';UPDATE workflow_runs SET status='SUCCEEDED' WHERE id='plan';UPDATE tasks SET status='BLOCKED' WHERE parent_task_id='parent';UPDATE workflow_runs SET status='FAILED' WHERE task_id LIKE 'child-%'");
      db.prepare("UPDATE tasks SET status=? WHERE id='parent'").run(status);
      db.exec("UPDATE agent_turns SET status='UNKNOWN',protection_state='retained' WHERE id='turn-d'");
      const before=db.prepare('SELECT id,status FROM tasks ORDER BY id').all();
      expect((await pending()).flatMap(p=>p.blockedTasks.map(t=>t.task_id))).toEqual(['child-d']);
      expect(db.prepare('SELECT id,status FROM tasks ORDER BY id').all()).toEqual(before);
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();}
  });
  it('excludes replaced plans and lists a current blocked parent once',async()=>{
    const {db,pending}=fixture();try{
      db.exec("UPDATE tasks SET status='BLOCKED' WHERE id='parent' OR id='child-a';UPDATE coordination_runs SET state='blocked' WHERE run_id='plan';UPDATE workflow_runs SET status='FAILED' WHERE id='plan';UPDATE agent_turns SET status='FAILED' WHERE id='turn-a'");
      expect((await pending()).flatMap(p=>p.blockedTasks.map(t=>t.task_id))).toEqual(['parent']);
      db.exec("UPDATE tasks SET status='ACTIVE' WHERE id='parent';INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES('new-request','parent','conv','DIRECT','RUNNING')");
      expect((await pending()).flatMap(p=>p.blockedTasks.map(t=>t.task_id))).toEqual([]);
    }finally{db.close();}
  });
});
