import {describe,it,expect} from 'vitest';
import {openDatabase} from '../../src/persistence/db.ts';
import {listDmConversations} from '../../src/persistence/stores/dm.ts';
import {readProjectRoomActivity} from '../../src/daemon/roomActivity.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {randomUUID} from 'node:crypto';

function fixture(){
  const db=openDatabase(':memory:');
  db.exec(`INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','项目','C:/synthetic','C:/synthetic','{}',0);
    INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('agent','p','AI','agent',1);
    INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','p','房间','agent');
    INSERT INTO conversations(id,project_id,kind,room_id) VALUES('room-conv','p','room','room'),('dm','p','dm',NULL);
    INSERT INTO dm_participants(project_id,conversation_id,principal_type,principal_id) VALUES('p','dm','agent','agent'),('p','dm','human','viewer');`);
  return db;
}
describe('R163 received-message counts and authoritative room activity',()=>{
  it('counts one AI reply as one unread, excludes self/system/unfinished output, and preserves later incoming replies',async()=>{
    const db=fixture();try{
      const add=(id:string,seq:number,author:string,who:string,status='final')=>db.prepare("INSERT INTO messages(id,project_id,conversation_id,conversation_seq,author_type,author_id,body_json,status,created_at) VALUES(?,'p','dm',?,?,?,'{}',?,0)").run(id,seq,author,who,status);
      add('own',1,'human','viewer');add('reply',2,'agent','agent');add('system',3,'system','system');add('own2',4,'human','viewer');add('stream',5,'agent','agent','streaming');
      db.prepare("UPDATE conversations SET last_message_seq=5 WHERE id='dm'").run();
      expect(listDmConversations(db,'viewer','p')[0]?.unread).toBe(1);
      const r=await dispatchDaemonCommand({db,localUserId:'viewer',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method:'conversation.markRead',params:{conversationId:'dm',throughMessageSeq:5}}) as {ok:boolean};
      expect(r.ok).toBe(true);expect(listDmConversations(db,'viewer','p')[0]?.unread).toBe(0);
      add('later',6,'agent','agent');db.prepare("UPDATE conversations SET last_message_seq=6 WHERE id='dm'").run();
      expect(listDmConversations(db,'viewer','p')[0]?.unread).toBe(1);
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();}
  });
  it('follows queued/running/user-wait/completed execution and never treats ACTIVE alone as proof of a running model',async()=>{
    const db=fixture();try{
      db.exec(`INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,title,status) VALUES('task','p','room-conv','room_task','room','任务','ACTIVE');
        INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES('run','task','room-conv','DIRECT','QUEUED');`);
      expect(readProjectRoomActivity(db,'p').room?.state).toBe('QUEUED');
      db.exec(`UPDATE workflow_runs SET status='RUNNING' WHERE id='run';
        INSERT INTO agent_turns(id,run_id,conversation_id,member_id,stage_key,status,dispatch_key) VALUES('turn','run','room-conv','agent','direct.work','RUNNING','dispatch:test');`);
      expect(readProjectRoomActivity(db,'p').room?.state).toBe('ACTIVE');
      db.exec("UPDATE agent_turns SET status='WAITING_INPUT' WHERE id='turn'");
      expect(readProjectRoomActivity(db,'p').room?.state).toBe('WAITING_USER');
      db.exec("UPDATE agent_turns SET status='SUCCEEDED' WHERE id='turn';UPDATE workflow_runs SET status='SUCCEEDED' WHERE id='run'");
      expect(readProjectRoomActivity(db,'p').room?.state).not.toBe('ACTIVE');
      db.exec("UPDATE tasks SET status='DONE' WHERE id='task'");
      expect(readProjectRoomActivity(db,'p').room?.state).toBeUndefined();
      const result=await dispatchDaemonCommand({db,localUserId:'viewer',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method:'room.list',params:{projectId:'p'}}) as {ok:boolean;data:{items:Array<{activity:{total:number}}>}};
      expect(result.ok).toBe(true);expect(result.data.items[0]?.activity.total).toBe(0);
      expect(db.prepare("SELECT status FROM tasks WHERE id='task'").get()).toEqual({status:'DONE'});
    }finally{db.close();}
  });
});
