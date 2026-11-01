import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {appendDomainEvent} from '../../src/persistence/events.ts';

export const dispatchBlockedReasons=[
  '多个实施步骤改动同一路径但没有显式依赖交接；不能覆盖先前成果',
  '交接版本的文件字节已变化；未继续派发',
  '父协作已停止或本轮分工已失效；未派发',
];
export function dispatchBlockedFixture(){
  const db=openDatabase(':memory:');
  db.exec(`
    INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at)
      VALUES('p','R154 合成项目','D:/r154-synthetic','D:/r154-synthetic','{}',0);
    INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES
      ('owner','p','协调者','agent',1),('writer','p','实施成员','agent',1),('reviewer','p','复核成员','agent',1);
    INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','p','合成房间','owner');
    INSERT INTO room_members(room_id,member_id) VALUES('room','owner'),('room','writer'),('room','reviewer');
    INSERT INTO conversations(id,project_id,kind,room_id) VALUES('conv','p','room','room');
    INSERT INTO messages(id,project_id,conversation_id,conversation_seq,room_id,author_type,author_id,body_json,created_at)
      VALUES('msg','p','conv',1,'room','human','u','{}',0);
    INSERT INTO conversation_threads(id,project_id,conversation_id,room_id,anchor_message_id)
      VALUES('thread','p','conv','room','msg');
    INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,owner_member_id,parent_task_id,title,status,review_policy)
      VALUES('parent','p','conv','room_task','room','thread','msg','owner',NULL,'父任务','BLOCKED','auto_deliver'),
      ('old-child','p','conv','room_task','room','thread','msg','reviewer','parent','旧轮复核','BLOCKED','auto_deliver'),
      ('child','p','conv','room_task','room','thread','msg','reviewer','parent','当前复核','BLOCKED','auto_deliver'),
      ('generated','p','conv','room_task','room','thread','msg','writer','parent','已生成文件','DONE','auto_deliver');
    INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES
      ('parent-old','parent','conv','thread','AUTO','FAILED'),
      ('parent-current','parent','conv','thread','AUTO','FAILED'),
      ('generated-run','generated','conv','thread','DIRECT','SUCCEEDED');
    INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,created_at) VALUES
      ('parent-old','parent',0,'blocked',1),('parent-current','parent',0,'blocked',2);
    INSERT INTO coordination_steps(run_id,step_key,child_task_id,role) VALUES
      ('parent-old','old','old-child','review'),('parent-current','review','child','review'),('parent-current','write','generated','implementation');
  `);
  const event=(taskId:string,runId:string|null,kind:string,payload:unknown,turnId?:string)=>{
    appendDomainEvent(db,{schemaVersion:1,eventId:randomUUID(),projectId:'p',conversationId:'conv',threadId:'thread',taskId,runId:runId??undefined,turnId,kind,createdAt:1000,payload});
    return (db.prepare('SELECT MAX(seq) seq FROM domain_events').get() as {seq:number}).seq;
  };
  const run=(id:string,status='FAILED')=>db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES(?,'child','conv','thread','DIRECT',?)").run(id,status);
  return {db,event,run};
}

