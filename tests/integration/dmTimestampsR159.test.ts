import {describe,expect,it} from 'vitest';
import {openDatabase} from '../../src/persistence/db.ts';
import {listDmConversations} from '../../src/persistence/stores/dm.ts';

describe('R159 persisted private-message timestamps',()=>{
  it('returns actual reply times and orders by replies while retaining a newer user-message time',()=>{
    const db=openDatabase(':memory:');
    try{
      db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','p','C:/synthetic','C:/synthetic','{}',0)").run();
      db.prepare("INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('m','p','same name','agent',1)").run();
      for(const id of ['a','b','empty']){
        db.prepare("INSERT INTO conversations(id,project_id,kind) VALUES(?,'p','dm')").run(id);
        db.prepare("INSERT INTO dm_participants(project_id,conversation_id,principal_type,principal_id) VALUES('p',?,'agent','m')").run(id);
      }
      const add=(id:string,conversation:string,seq:number,author:string,time:number)=>db.prepare(`INSERT INTO messages(id,project_id,conversation_id,conversation_seq,author_type,author_id,body_json,status,created_at)
        VALUES(?,'p',?,?,?,?,?,'final',?)`).run(id,conversation,seq,author,author==='agent'?'m':'local',JSON.stringify({text:id}),time);
      add('reply-a','a',1,'agent',100);add('user-newer','a',2,'human',1000);add('reply-b','b',1,'agent',200);
      const rows=listDmConversations(db,'local','p');
      expect(rows.map(row=>row.conversationId)).toEqual(['b','a','empty']);
      expect(rows.find(row=>row.conversationId==='a')).toMatchObject({lastReplyAt:100,lastMessageAt:1000,lastMessagePreview:'user-newer'});
      expect(rows.find(row=>row.conversationId==='empty')).toMatchObject({lastReplyAt:null,lastMessageAt:null});
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();}
  });
});
