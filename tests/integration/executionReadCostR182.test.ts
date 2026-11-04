import {describe,it,expect} from 'vitest';
import {openDatabase} from '../../src/persistence/db.ts';
import {appendDomainEvent} from '../../src/persistence/events.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {readProjectRoomActivity} from '../../src/daemon/roomActivity.ts';
import {readThreadProgress} from '../../src/daemon/threadMembers.ts';
import {readTaskClosure} from '../../src/daemon/taskClosure.ts';

function fixture(){
  const db=openDatabase(':memory:');
  db.exec(`INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','隔离项目','C:/synthetic','C:/synthetic','{}',0);
    INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('agent','p','协调成员','agent',1);
    INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','p','房间','agent');
    INSERT INTO conversations(id,project_id,kind,room_id) VALUES('conv','p','room','room');
    INSERT INTO conversation_threads(id,project_id,conversation_id,room_id,anchor_message_id) VALUES('thread','p','conv','room','anchor');
    INSERT INTO tasks(id,project_id,conversation_id,conversation_thread_id,kind,room_id,title,status,owner_member_id) VALUES('root','p','conv','thread','room_task','room','隔离任务','BLOCKED','agent');
    INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES('plan','root','conv','thread','AUTO','FAILED');
    INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,plan_json,error_message,created_at) VALUES('plan','root',0,'blocked','{}','成员步骤失败',0);`);
  return db;
}

describe('R182 responsive task reads with historical queues',()=>{
  it('keeps full status and closure reads responsive while preserving linked and unrelated queue ownership',()=>{
    const db=fixture();try{
      db.transaction(()=>{
        const task=db.prepare("INSERT INTO tasks(id,project_id,conversation_id,conversation_thread_id,kind,room_id,parent_task_id,title,status) VALUES(?,'p','conv','thread','room_task','room','root','历史步骤','BLOCKED')");
        const event=db.prepare("INSERT INTO domain_events(event_id,schema_version,kind,project_id,conversation_id,task_id,payload_json,created_at) VALUES(lower(hex(randomblob(16))),1,'task.resumeEnqueued','p','conv',?, ?,0)");
        const outbox=db.prepare("INSERT INTO outbox(dispatch_key,status) VALUES(?,'done')");
        for(let child=0;child<12;child++){
          const id='child-'+child;task.run(id);
          for(let i=0;i<400;i++)event.run(id,JSON.stringify({dispatchKey:'past-'+child+'-'+i}));
        }
        for(let i=0;i<8000;i++)outbox.run('unrelated-'+i);
        // A durable event can own an arbitrary dispatch identity. A lease on
        // that identity must still block closure, irrespective of key syntax.
        event.run('child-11',JSON.stringify({dispatchKey:'arbitrary-owned-key'}));
        db.prepare("INSERT INTO outbox(dispatch_key,status,lease_owner) VALUES('arbitrary-owned-key','leased','worker')").run();
        db.prepare("INSERT INTO daemon_state(key,value,updated_at) VALUES('automatic-recovery:invalid','invalid json',0)").run();
      })();
      const start=performance.now();
      const full=readTaskExecutionStatus(db,'root')!;
      expect(readTaskClosure(db,'root')).toMatchObject({available:false,blockReason:{code:'WORKER_STILL_RUNNING',taskId:'child-11'}});
      const elapsed=performance.now()-start;
      // Generous interactive budget; the correlated query took many seconds
      // with this distribution even though no model or worker was running.
      expect(elapsed).toBeLessThan(2000);
      expect(full.phase).toBe('FAILED');
      const compact=readTaskExecutionStatus(db,'root',{includeActions:false})!;
      expect({...compact,actions:full.actions,observedAt:full.observedAt}).toEqual(full);
      db.exec("UPDATE outbox SET status='done',lease_owner=NULL WHERE dispatch_key='arbitrary-owned-key'; INSERT INTO outbox(dispatch_key,status,lease_owner) VALUES('foreign-leased','leased','other-worker')");
      expect(readTaskClosure(db,'root')).toMatchObject({available:true});
      expect(db.prepare("SELECT status,lease_owner FROM outbox WHERE dispatch_key='foreign-leased'").get()).toEqual({status:'leased',lease_owner:'other-worker'});
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();}
  });
  it('projects the failed member cause and no live Claude preparation while integration has never dispatched',()=>{
    const db=fixture();try{
      db.exec(`INSERT INTO tasks(id,project_id,conversation_id,conversation_thread_id,kind,room_id,parent_task_id,title,status,owner_member_id) VALUES
        ('failed-child','p','conv','thread','room_task','room','root','成员回应','ACTIVE','agent'),
        ('integration','p','conv','thread','room_task','room','root','整合回应','OPEN','agent');
        INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES('child-run','failed-child','conv','thread','DIRECT','FAILED');
        INSERT INTO coordination_steps(run_id,step_key,child_task_id,role) VALUES('plan','member','failed-child','implementation'),('plan','integration','integration','review');
        INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,dispatch_key) VALUES('failed-turn','child-run','conv','thread','agent','direct.work','FAILED','child-key');`);
      appendDomainEvent(db,{eventId:'child-failure',schemaVersion:1,kind:'turn.statusChanged',projectId:'p',conversationId:'conv',taskId:'failed-child',runId:'child-run',turnId:'failed-turn',payload:{status:'FAILED',code:'OUTPUT_INVALID',message:'Harness 连接组件没有完成握手'},createdAt:10});
      appendDomainEvent(db,{eventId:'coordination-blocked',schemaVersion:1,kind:'coordination.blocked',projectId:'p',conversationId:'conv',taskId:'root',runId:'plan',payload:{stepKey:'member'},createdAt:11});
      for(const includeActions of [true,false])expect(readTaskExecutionStatus(db,'root',{includeActions})).toMatchObject({phase:'FAILED',reason:{taskId:'failed-child',message:expect.stringContaining('没有完成握手')}});
      expect(readThreadProgress(db,'thread')).toEqual([]);
      expect(readProjectRoomActivity(db,'p')).toEqual({room:expect.objectContaining({state:'BLOCKED'})});
      expect(db.prepare("SELECT count(*) n FROM workflow_runs WHERE task_id='integration'").get()).toEqual({n:0});
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();}
  });
});
