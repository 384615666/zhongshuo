import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {deliveryFilesForHandoff} from '../../src/daemon/handoffManifest.ts';

// Projection contract fixture, not an end-to-end runtime or original user DB.
function fixture(overwritten:boolean){
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT,canonical_path TEXT);CREATE TABLE tasks(id TEXT,project_id TEXT);
    CREATE TABLE change_sets(id TEXT,task_id TEXT,manifest_json TEXT);
    CREATE TABLE domain_events(task_id TEXT,run_id TEXT,kind TEXT,payload_json TEXT);
    CREATE TABLE messages(id TEXT,task_id TEXT,author_id TEXT,author_type TEXT,body_json TEXT);
    CREATE TABLE agent_turns(id TEXT,run_id TEXT,member_id TEXT,status TEXT);
    CREATE TABLE workflow_runs(id TEXT,task_id TEXT);
    CREATE TABLE format_repair_workitems(source_turn_id TEXT,consumed_turn_id TEXT);
    CREATE TABLE artifacts(id TEXT,hash TEXT,task_id TEXT,project_id TEXT,conversation_id TEXT);
    CREATE TABLE message_file_changes(path TEXT,artifact_id TEXT,after_sha256 TEXT,turn_id TEXT,task_id TEXT,run_id TEXT,project_id TEXT,conversation_id TEXT,change_set_id TEXT);
    CREATE TABLE change_set_files(id INTEGER,change_set_id TEXT,path TEXT,role TEXT,state TEXT,sha256 TEXT);`);
  const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
  const source=hash('own frozen source bytes'),peer=hash('peer overwrote source');
  db.prepare('INSERT INTO projects VALUES(?,?)').run('p','C:/r154-synthetic-not-opened');
  db.prepare('INSERT INTO tasks VALUES(?,?)').run('task','p');
  db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('run','task');
  db.prepare('INSERT INTO agent_turns VALUES(?,?,?,?)').run('turn','run','member','SUCCEEDED');
  db.prepare('INSERT INTO change_sets VALUES(?,?,?)').run('change','task',JSON.stringify({concurrentWriteObservation:true}));
  db.prepare('INSERT INTO domain_events VALUES(?,?,?,?)').run('task','run','changeset.baselineCaptured',JSON.stringify({changeSetId:'change'}));
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('msg_turn_final','task','member','agent',JSON.stringify({runtimeControlResult:JSON.stringify({schemaVersion:'task-complete-v1',files:['own.md']})}));
  db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)').run('source-artifact',source,'task','p','conv');
  db.prepare('INSERT INTO message_file_changes VALUES(?,?,?,?,?,?,?,?,?)').run('own.md','source-artifact',source,'turn','task','run','p','conv',null);
  db.prepare('INSERT INTO change_set_files VALUES(?,?,?,?,?,?)').run(1,'change','own.md','before','absent',null);
  db.prepare('INSERT INTO change_set_files VALUES(?,?,?,?,?,?)').run(2,'change','own.md','after','present',overwritten?peer:source);
  db.prepare('INSERT INTO change_set_files VALUES(?,?,?,?,?,?)').run(3,'change','peer.md','after','present',peer);
  return{db,source};
}

describe('R154 frozen source versus shared directory observations',()=>{
  it.each([false,true])('never substitutes a peer observation for source bytes: overwritten=%s',overwritten=>{
    const{db,source}=fixture(overwritten);
    try{
      const before=db.prepare('SELECT total_changes() n').get();
      if(overwritten)expect(()=>deliveryFilesForHandoff(db,'task','run',['change'])).toThrow('成果快照与共享目录观察版本不符');
      else expect(deliveryFilesForHandoff(db,'task','run',['change'])).toEqual([{path:'own.md',state:'present',sha256:source}]);
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    }finally{db.close();}
  });
});
