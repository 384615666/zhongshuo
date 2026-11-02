import {describe,it,expect} from 'vitest';
import {openDatabase,type ZhongshuoDatabase} from '../../src/persistence/db.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {readProjectRoomActivity} from '../../src/daemon/roomActivity.ts';

function fixture(){
  const db=openDatabase(':memory:');
  db.exec(`INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','项目','C:/synthetic','C:/synthetic','{}',0);
    INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('agent','p','AI','agent',1);
    INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','p','房间','agent');
    INSERT INTO conversations(id,project_id,kind,room_id) VALUES('conv','p','room','room');
    INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,title,status,owner_member_id) VALUES('root','p','conv','room_task','room','任务','BLOCKED','agent');`);
  return db;
}
function measure(db:ZhongshuoDatabase){
  const original=db.prepare;let calls=0;
  db.prepare=function(sql:string){const stmt=original.call(db,sql);for(const name of ['get','all'] as const){const read=stmt[name].bind(stmt);stmt[name]=((...args:unknown[])=>{calls++;return read(...args);}) as typeof stmt[typeof name];}return stmt;} as typeof db.prepare;
  try{return{summary:readProjectRoomActivity(db,'p'),queries:calls};}finally{db.prepare=original;}
}
describe('R168 room summaries avoid task action eligibility scans',()=>{
  it.each(['failed','running','queued','waiting-user','waiting-peer','review','completed','retained','stopping'])('keeps all execution facts identical without computing action buttons (%s)',state=>{
    const db=fixture();try{
      if(state==='waiting-user')db.exec("UPDATE tasks SET status='WAITING_USER' WHERE id='root'");
      if(state==='completed')db.exec("UPDATE tasks SET status='DONE' WHERE id='root'");
      if(state==='waiting-peer')db.exec("INSERT INTO conversation_threads(id,project_id,conversation_id,room_id,anchor_message_id) VALUES('thread','p','conv','room','anchor');UPDATE tasks SET conversation_thread_id='thread' WHERE id='root';INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES('plan','root','conv','thread','AUTO','WAITING');INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,plan_json,created_at) VALUES('plan','root',0,'running','{}',0)");
      if(state==='review')db.exec("UPDATE tasks SET status='REVIEW' WHERE id='root';INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES('run','root','conv','DIRECT','SUCCEEDED');INSERT INTO task_deliveries(id,task_id,run_id,revision,manifest_hash,artifact_refs_json,change_set_refs_json,verification_refs_json,review_status) VALUES('delivery','root','run',1,'hash','[]','[]','[]','pending');UPDATE tasks SET current_delivery_id='delivery' WHERE id='root'");
      if(['running','queued','retained','stopping'].includes(state)){
        db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES('run','root','conv','DIRECT',?)").run(state==='queued'?'QUEUED':state==='stopping'?'STOPPING':state==='retained'?'FAILED':'RUNNING');
        if(state!=='queued')db.prepare("INSERT INTO agent_turns(id,run_id,conversation_id,member_id,stage_key,status,protection_state,dispatch_key) VALUES('turn','run','conv','agent','direct.work',?,?,'dispatch')").run(state==='retained'?'UNKNOWN':state==='stopping'?'STOPPING':'RUNNING',state==='retained'?'retained':null);
      }
      const full=readTaskExecutionStatus(db,'root')!,compact=readTaskExecutionStatus(db,'root',{includeActions:false})!;
      expect({...compact,actions:full.actions,observedAt:full.observedAt}).toEqual(full);expect(compact.actions).toEqual([]);
      if(state==='retained'){expect(compact.phase).toBe('UNKNOWN');expect(compact.evidence.unknownTurnIds).toEqual(['turn']);}
      if(state==='failed')expect(full.actions.some(action=>action.kind==='close')).toBe(true);
    }finally{db.close();}
  });
  it('keeps the room-list query count bounded when a root has 100 historical child tasks',()=>{
    const db=fixture();try{
      const before=measure(db);
      db.transaction(()=>{for(let i=0;i<100;i++)db.prepare("INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,parent_task_id,title,status,owner_member_id) VALUES(?,'p','conv','room_task','room','root','旧步骤','BLOCKED','agent')").run('child-'+i);})();
      const after=measure(db);
      expect(after.summary).toEqual(before.summary);
      expect(after.queries).toBeLessThanOrEqual(before.queries+5);
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();}
  });
});
