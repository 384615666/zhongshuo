import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { runCommand } from '../../src/persistence/commandGateway.ts';
import { appendDomainEvent } from '../../src/persistence/events.ts';
import { taskClosureParamsSchema } from '../../src/contracts/taskClosure.ts';
import type { TaskClosureBinding } from '../../src/contracts/taskClosure.ts';
import { closeIdleTask, readTaskClosure } from '../../src/daemon/taskClosure.ts';

const databases: ZhongshuoDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    try { expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0}); }
    finally { db.close(); }
  }
});

/** Real migrated SQLite and gateway transactions, entirely in-memory. No worker,
 * model, runtime discovery, or user's application database is opened. */
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  db.exec(`INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at)
    VALUES('p','隔离测试','D:/isolated-r128','D:/isolated-r128','{}',0);
    INSERT INTO project_members(id,project_id,display_name,principal_type) VALUES('m','p','测试成员','agent');
    INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','p','测试房间','m');
    INSERT INTO conversations(id,project_id,kind,room_id) VALUES('conv','p','room','room');
    INSERT INTO conversation_threads(id,project_id,conversation_id,room_id,anchor_message_id)
      VALUES('thread','p','conv','room','anchor');`);
  let seq = 0;
  const task = (id='root',status='BLOCKED',parent: string|null=null) => {
    db.prepare(`INSERT INTO tasks(id,project_id,conversation_id,conversation_thread_id,kind,title,status,parent_task_id,revision,stop_generation)
      VALUES(?,'p','conv','thread','room_task',?,?,?,7,3)`).run(id,`任务${id}`,status,parent);
    return id;
  };
  const run = (taskId='root',status='FAILED',id=`run-${taskId}`) => {
    db.prepare(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES(?,?,'conv','thread','DIRECT',?)`).run(id,taskId,status);
    return id;
  };
  const turn = (runId='run-root',status='FAILED',id=`turn-${runId}`) => {
    db.prepare(`INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,dispatch_key)
      VALUES(?,?,'conv','thread','m',?,?,?)`).run(id,runId,id,status,`turn-key:${id}`);
    return id;
  };
  const outbox = (key='task:root:initial',status='pending',turnId:string|null=null) => {
    db.prepare('INSERT INTO outbox(dispatch_key,status,turn_id) VALUES(?,?,?)').run(key,status,turnId);
    return key;
  };
  const message = (taskId='root') => {
    seq += 1; const id=`msg-${seq}`;
    db.prepare(`INSERT INTO messages(id,project_id,conversation_id,conversation_seq,thread_id,thread_message_seq,task_id,author_type,author_id,body_json,created_at)
      VALUES(?,'p','conv',?,'thread',?,?,'human','user','{"text":"保留消息与附件引用"}',0)`).run(id,seq,seq,taskId);
    return id;
  };
  const reply = (table:'thread_reply_requests'|'conversation_reply_requests',taskId='root',sourceTurn='turn-run-root',status='queued',key?:string) => {
    const id=message(taskId),dispatchKey=key??`task:${taskId}:${table==='thread_reply_requests'?'thread-reply':'conversation'}:${id}`;
    if (table === 'thread_reply_requests') {
      db.prepare(`INSERT INTO thread_reply_requests(message_id,project_id,conversation_id,thread_id,task_id,member_id,source_turn_id,
        stop_generation,input_thread_seq,dispatch_key,route_json,roster_json,write_scope_json,membership_version,source_task_status,status,created_at,updated_at)
        VALUES(?,'p','conv','thread',?,'m',?,3,?,?, '{}','[]','{}','v1','BLOCKED',?,0,0)`).run(id,taskId,sourceTurn,seq,dispatchKey,status);
    } else {
      db.prepare(`INSERT INTO conversation_reply_requests(message_id,project_id,conversation_id,thread_id,task_id,member_id,source_turn_id,
        input_thread_seq,dispatch_key,write_scope_json,status,created_at,updated_at)
        VALUES(?,'p','conv','thread',?,'m',?,?,?,'{}',?,0,0)`).run(id,taskId,sourceTurn,seq,dispatchKey,status);
    }
    outbox(dispatchKey); return {id,key:dispatchKey};
  };
  const recovery = (taskId='root',state='waiting',id=taskId) => {
    const key=`automatic-recovery:${id}`,targetDispatchKey=`ar-key:${id}`;
    db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,0)').run(key,JSON.stringify({taskId,state,targetDispatchKey,sourceTurnId:`turn-run-${taskId}`,runId:`run-${taskId}`}));
    return {key,targetDispatchKey};
  };
  const repair = (taskId='root',id=taskId) => {
    const key=`fr-key:${id}`;
    db.prepare(`INSERT INTO format_repair_workitems(id,task_id,source_turn_id,source_result_key,logical_output_id,invalid_event_id,
      source_output_hash,source_output_text,invalid_issues_json,target_dispatch_key,budget_run_id,created_at,updated_at)
      VALUES(?,?,?,'result',?,'invalid','hash','保留失败输出','[]',?,?,0,0)`).run(id,taskId,`turn-run-${taskId}`,`logical-${id}`,key,`run-${taskId}`);
    outbox(key); return key;
  };
  const binding = (taskId='root') => {
    const view=readTaskClosure(db,taskId); expect(view,JSON.stringify(view)).toMatchObject({available:true,blockReason:null});
    return view.binding!;
  };
  const close = (bound=binding(),commandId='close-command') => runCommand(db,{idempotencyScope:'local',commandId,payloadHash:JSON.stringify(bound),now:100},() => closeIdleTask(db,bound,100));
  const snapshot = () => Object.fromEntries(['tasks','workflow_runs','agent_turns','workspace_leases','outbox','messages','domain_events',
    'thread_reply_requests','conversation_reply_requests','daemon_state','format_repair_workitems','coordination_runs','coordination_messages','command_receipts']
    .map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  task();
  return {db,task,run,turn,outbox,message,reply,recovery,repair,binding,close,snapshot};
}

describe('R128 explicit closure of unfinished, idle tasks', () => {
  it('exports a strict binding schema, including required nullable latest-run identity', () => {
    const bound:TaskClosureBinding={taskId:'root',expectedTaskRevision:7,expectedStopGeneration:3,sourceRunId:null};
    expect(taskClosureParamsSchema.parse(bound)).toEqual(bound);
    for (const invalid of [{...bound,extra:true},{...bound,expectedTaskRevision:-1},{...bound,sourceRunId:undefined},{...bound,expectedStopGeneration:0.5}]) {
      expect(taskClosureParamsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each(['FAILED','PARTIAL','INTERRUPTED','SUCCEEDED'] as const)('closes BLOCKED + %s without rewriting runs, failures, messages or delivery references', status => {
    const f=fixture(); f.run('root',status); f.turn(); f.message();
    f.db.prepare(`INSERT INTO task_deliveries(id,task_id,run_id,revision,manifest_hash,artifact_refs_json,change_set_refs_json,verification_refs_json,review_status)
      VALUES('delivery','root','run-root',1,'manifest','["D:/unchanged/output.txt"]','[]','[]','pending')`).run();
    const history=f.snapshot(),deliveries=f.db.prepare('SELECT * FROM task_deliveries').all();
    const result=f.close();
    expect(result).toMatchObject({ok:true,data:{closed:true,taskId:'root',status:'CANCELLED',stopGeneration:4,taskRevision:8,sourceRunId:'run-root'}});
    expect(f.db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get('root')).toEqual({status:'CANCELLED',revision:8,stop_generation:4});
    for (const table of ['workflow_runs','agent_turns','messages']) expect(f.snapshot()[table]).toEqual(history[table]);
    expect(f.db.prepare('SELECT * FROM task_deliveries').all()).toEqual(deliveries);
    expect(f.db.prepare("SELECT payload_json FROM domain_events WHERE kind='task.closed'").get()).toEqual({payload_json:expect.stringContaining('"status":"CANCELLED"')});
  });

  it.each(['OPEN','BLOCKED','ACTIVE','WAITING_USER','REVIEW'])('closes %s with preparation failure before any run', status => {
    const f=fixture(); f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,'root'); f.outbox();
    appendDomainEvent(f.db,{eventId:'prepare-failure',schemaVersion:1,projectId:'p',taskId:'root',kind:'run.prepareFailed',payload:{reason:'原准备失败'},createdAt:1});
    expect(f.binding().sourceRunId).toBeNull();
    expect(f.close()).toMatchObject({ok:true,data:{sourceRunId:null,cancelledOutboxCount:1}});
    expect(f.db.prepare('SELECT count(*) n FROM workflow_runs').get()).toEqual({n:0});
    expect(f.db.prepare("SELECT payload_json FROM domain_events WHERE event_id='prepare-failure'").get()).toEqual({payload_json:'{"reason":"原准备失败"}'});
  });

  it('closes WAITING_USER + SUCCEEDED and is read-only even with pending queues', () => {
    const f=fixture(); f.db.prepare("UPDATE tasks SET status='WAITING_USER' WHERE id='root'").run(); f.run('root','SUCCEEDED'); f.turn('run-root','SUCCEEDED'); f.outbox();
    const before=f.snapshot();
    f.db.pragma('query_only=ON');
    try { expect(readTaskClosure(f.db,'root')).toMatchObject({available:true,binding:{sourceRunId:'run-root'}}); }
    finally { f.db.pragma('query_only=OFF'); }
    expect(f.snapshot()).toEqual(before); expect(f.close()).toMatchObject({ok:true});
  });

  it('cancels all exact queued reply/recovery/format-repair intents and retains failed reply history', () => {
    const f=fixture(); f.run(); f.turn();
    const queued=f.reply('thread_reply_requests'),conversation=f.reply('conversation_reply_requests');
    const failed=f.reply('thread_reply_requests','root','turn-run-root','failed');
    f.db.prepare("UPDATE outbox SET status='failed' WHERE dispatch_key=?").run(failed.key);
    const recovery=f.recovery(); f.outbox(recovery.targetDispatchKey); f.recovery('root','queued','second'); f.outbox('ar-key:second');
    f.repair(); f.outbox('dmtask:root:redispatch:retry'); f.outbox('task:root:delib:run_old:RPR:m:0:IND');
    const messages=f.db.prepare('SELECT * FROM messages').all();
    expect(f.close()).toMatchObject({ok:true,data:{cancelledOutboxCount:7}});
    for (const [table,id] of [['thread_reply_requests',queued.id],['conversation_reply_requests',conversation.id]]) {
      expect(f.db.prepare(`SELECT status,updated_at FROM ${table} WHERE message_id=?`).get(id)).toEqual({status:'cancelled',updated_at:100});
    }
    expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(failed.id)).toEqual({status:'failed'});
    expect(f.db.prepare('SELECT status,source_output_text FROM format_repair_workitems').get()).toEqual({status:'closed',source_output_text:'保留失败输出'});
    expect(f.db.prepare("SELECT value FROM daemon_state WHERE key GLOB 'automatic-recovery:*'").all()).toEqual([
      {value:expect.stringContaining('"state":"stopped"')},{value:expect.stringContaining('"state":"stopped"')},
    ]);
    expect(f.db.prepare('SELECT * FROM messages').all()).toEqual(messages);
    expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get()).toEqual({n:0});
    expect(f.db.prepare('SELECT status FROM outbox WHERE dispatch_key=?').get(failed.key)).toEqual({status:'failed'});
  });

  it('does not touch another task in the same thread, prefix-neighbor IDs, or wildcard-like IDs', () => {
    const f=fixture(); f.run(); f.turn();
    for (const id of ['root-extra','root_2','root%','root:extra','other']) {
      f.task(id); f.run(id); f.turn(`run-${id}`); f.reply('thread_reply_requests',id,`turn-run-${id}`); f.repair(id);
      const job=f.recovery(id); f.outbox(job.targetDispatchKey);
    }
    f.task('id_%'); f.outbox('task:id_%:initial'); f.task('id_x'); f.outbox('task:id_x:initial','leased');
    f.outbox('task:root:extra:initial','leased');
    const before=f.snapshot();
    expect(f.close()).toMatchObject({ok:true});
    expect(f.close(f.binding('id_%'),'wildcard-close')).toMatchObject({ok:true,data:{cancelledOutboxCount:1}});
    for (const id of ['root-extra','root_2','root%','root:extra','other','id_x']) {
      expect(f.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)).toEqual((before.tasks as Array<{id:string}>).find(t=>t.id===id));
    }
    for (const table of ['outbox','thread_reply_requests','format_repair_workitems','daemon_state']) {
      const rows=f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      if (table==='outbox') expect(rows.filter(row=>(row as {dispatch_key:string}).dispatch_key!=='task:id_%:initial')).toEqual((before[table] as Array<{dispatch_key:string}>).filter(row=>row.dispatch_key!=='task:id_%:initial'));
      else expect(rows).toEqual(before[table]);
    }
  });

  it.each(['revision','generation','new-terminal-run','new-live-run','first-run'] as const)('rejects stale binding after %s and preserves all newer work', change => {
    const f=fixture(); if (change!=='first-run') {f.run('root','FAILED','zz-old'); f.turn('zz-old');}
    const bound=f.binding();
    if (change==='revision') f.db.prepare("UPDATE tasks SET revision=revision+1 WHERE id='root'").run();
    else if (change==='generation') f.db.prepare("UPDATE tasks SET stop_generation=stop_generation+1 WHERE id='root'").run();
    else f.run('root',change==='new-live-run'?'RUNNING':'FAILED','aa-new');
    f.outbox('task:root:redispatch:later'); const before=f.snapshot();
    expect(f.close(bound)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['PENDING','DISPATCHING','RUNNING','WAITING_INPUT','WAITING_APPROVAL','STOPPING'])('blocks real %s turn even on an old terminal run', status => {
    const f=fixture(); f.run(); f.turn('run-root',status); f.run('root','SUCCEEDED','latest-terminal');
    const before=f.snapshot();
    expect(readTaskClosure(f.db,'root')).toMatchObject({available:false,blockReason:{code:'WORKER_STILL_RUNNING'}});
    expect(f.close({taskId:'root',expectedTaskRevision:7,expectedStopGeneration:3,sourceRunId:'latest-terminal'})).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}});
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['QUEUED','RUNNING','WAITING','STOPPING'])('rejects active %s run with no turns', status => {
    const f=fixture(); f.run('root',status);
    expect(readTaskClosure(f.db,'root')).toMatchObject({available:false,blockReason:{code:'WORKER_STILL_RUNNING'}});
  });

  it.each(['canonical','reply','repair','recovery','turn','pending-owner'] as const)('rejects claimed %s outbox ownership without releasing or changing it', kind => {
    const f=fixture(); f.run(); f.turn(); let key:string;
    if (kind==='reply') key=f.reply('thread_reply_requests','root','turn-run-root','queued','nonstandard-reply').key;
    else if (kind==='repair') key=f.repair();
    else if (kind==='recovery') {key=f.recovery().targetDispatchKey; f.outbox(key);}
    else {key=kind==='turn'?'turn-linked-custom':'task:root:initial'; f.outbox(key,'pending',kind==='turn'?'turn-run-root':null);}
    f.db.prepare('UPDATE outbox SET status=?,lease_owner=?,lease_until=1 WHERE dispatch_key=?').run(kind==='pending-owner'?'pending':'leased','worker',key);
    const before=f.snapshot();
    expect(readTaskClosure(f.db,'root')).toMatchObject({available:false,blockReason:{code:'WORKER_STILL_RUNNING'}});
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['unknown','refunded-unknown','retained','active-lease','expired-lease','false-release','contradicted-release','unsettled-release'] as const)('preserves %s protection and rejects closure', fact => {
    const f=fixture(); f.run(); const unknown=!['retained','active-lease','expired-lease'].includes(fact); const id=f.turn('run-root',unknown?'UNKNOWN':'FAILED');
    if (fact==='retained') f.db.prepare("UPDATE agent_turns SET protection_state='retained',budget_mark='refunded' WHERE id=?").run(id);
    if (fact==='refunded-unknown') f.db.prepare("UPDATE agent_turns SET budget_mark='refunded' WHERE id=?").run(id);
    if (fact.endsWith('-lease')) f.db.prepare('INSERT INTO workspace_leases(lock_domain,owner_turn_id,epoch,heartbeat_at,status) VALUES(?,?,1,0,?)').run('disk',id,fact==='expired-lease'?'expired':'active');
    if (['false-release','contradicted-release','unsettled-release'].includes(fact)) {
      if (fact!=='unsettled-release') f.db.prepare("UPDATE agent_turns SET budget_mark='refunded' WHERE id=?").run(id);
      appendDomainEvent(f.db,{eventId:'release',schemaVersion:1,projectId:'p',turnId:id,kind:'recovery.protectionReleased',createdAt:1,
        payload:{released:true,...(fact==='unsettled-release'?{probe:{result:'no-os-process'}}:fact==='contradicted-release'?{protectionRetained:true,probe:{result:'no-os-process'}}:{})}});
    }
    const before=f.snapshot();
    expect(readTaskClosure(f.db,'root')).toMatchObject({available:false,blockReason:{code:'RECONCILE_REQUIRED'}});
    expect(f.close({taskId:'root',expectedTaskRevision:7,expectedStopGeneration:3,sourceRunId:'run-root'})).toMatchObject({ok:false,error:{code:'RECONCILE_REQUIRED'}});
    expect(f.snapshot()).toEqual(before);
  });

  it('allows a formally reconciled UNKNOWN with complete exit evidence and preserves that history', () => {
    const f=fixture(); f.run(); const id=f.turn('run-root','UNKNOWN');
    f.db.prepare("UPDATE agent_turns SET budget_mark='settled',protection_state='released' WHERE id=?").run(id);
    appendDomainEvent(f.db,{eventId:'release',schemaVersion:1,projectId:'p',turnId:id,kind:'recovery.protectionReleased',createdAt:1,payload:{released:true,probe:{result:'no-os-process'}}});
    const turns=f.db.prepare('SELECT * FROM agent_turns').all();
    expect(f.close()).toMatchObject({ok:true}); expect(f.db.prepare('SELECT * FROM agent_turns').all()).toEqual(turns);
  });

  it.each(['thread_reply_requests','conversation_reply_requests'] as const)('allows a formally closed UNKNOWN execution despite its stale %s unknown summary', table => {
    const f=fixture(); f.run(); const turnId=f.turn('run-root','UNKNOWN');
    f.db.prepare("UPDATE agent_turns SET budget_mark='settled',protection_state='released' WHERE id=?").run(turnId);
    appendDomainEvent(f.db,{eventId:'release',schemaVersion:1,projectId:'p',turnId,kind:'recovery.protectionReleased',createdAt:1,payload:{released:true,probe:{result:'no-os-process'}}});
    const request=f.reply(table,'root',turnId,'unknown');
    f.db.prepare(`UPDATE ${table} SET run_id='run-root',turn_id=? WHERE message_id=?`).run(turnId,request.id);
    f.db.prepare("UPDATE outbox SET status='failed' WHERE dispatch_key=?").run(request.key);
    const requestBefore=f.db.prepare(`SELECT * FROM ${table}`).all(),turnBefore=f.db.prepare('SELECT * FROM agent_turns').all();
    expect(f.close()).toMatchObject({ok:true});
    expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(requestBefore);
    expect(f.db.prepare('SELECT * FROM agent_turns').all()).toEqual(turnBefore);
  });

  it.each(['unidentified','empty-run','foreign-run','foreign-turn','mismatched-turn'] as const)('refuses %s unknown reply identity even when the previous source answer is safe', identity => {
    const f=fixture(); f.run(); f.turn(); const request=f.reply('thread_reply_requests','root','turn-run-root','unknown');
    f.task('other'); f.run('other'); f.turn('run-other'); f.run('root','SUCCEEDED','empty-root-run');
    let runId:string|null=null,turnId:string|null=null;
    if (identity==='empty-run') runId='empty-root-run';
    if (identity==='foreign-run') runId='run-other';
    if (identity==='foreign-turn') turnId='turn-run-other';
    if (identity==='mismatched-turn') {runId='empty-root-run';turnId='turn-run-root';}
    f.db.prepare('UPDATE thread_reply_requests SET run_id=?,turn_id=? WHERE message_id=?').run(runId,turnId,request.id);
    const before=f.snapshot();
    expect(readTaskClosure(f.db,'root')).toMatchObject({available:false,blockReason:{code:'RECONCILE_REQUIRED'}});
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['thread_reply_requests','conversation_reply_requests'] as const)('cancels safe %s running orphans, retaining their failure diagnostics', table => {
    const f=fixture(); f.run(); f.turn(); const request=f.reply(table,'root','turn-run-root','running');
    f.db.prepare(`UPDATE ${table} SET error_message='原准备失败诊断' WHERE message_id=?`).run(request.id);
    expect(f.close()).toMatchObject({ok:true,data:{cancelledOutboxCount:1}});
    expect(f.db.prepare(`SELECT status,error_message FROM ${table} WHERE message_id=?`).get(request.id)).toEqual({status:'cancelled',error_message:expect.stringMatching(/^原准备失败诊断\n用户已结束任务/)});
    expect(f.db.prepare('SELECT status FROM workflow_runs').get()).toEqual({status:'FAILED'});
  });

  it.each(['PENDING','DISPATCHING','WAITING_INPUT','WAITING_APPROVAL','UNKNOWN','retained','lease','claimed','active-run'])('checks %s through a terminal intermediate child and the complete descendant chain', fact => {
    const f=fixture(); f.run(); f.turn(); f.task('middle','DONE','root'); f.task('leaf','BLOCKED','middle');
    f.run('leaf',fact==='active-run'?'RUNNING':'FAILED');
    const id=f.turn('run-leaf',['retained','lease','claimed','active-run'].includes(fact)?'FAILED':fact);
    if (fact==='retained') f.db.prepare("UPDATE agent_turns SET protection_state='retained' WHERE id=?").run(id);
    if (fact==='lease') f.db.prepare("INSERT INTO workspace_leases(lock_domain,owner_turn_id,epoch,heartbeat_at,status) VALUES('disk',?,1,0,'active')").run(id);
    if (fact==='claimed') f.outbox('task:leaf:initial','leased');
    const before=f.snapshot();
    expect(readTaskClosure(f.db,'root')).toMatchObject({available:false,blockReason:{taskId:'leaf'}});
    expect(f.snapshot()).toEqual(before);
  });

  it('rechecks descendants created after binding, rejecting unsafe newcomers atomically', () => {
    const f=fixture(); f.run(); f.turn(); const bound=f.binding();
    f.task('late-child','ACTIVE','root'); f.run('late-child','RUNNING');
    const before=f.snapshot();
    expect(f.close(bound)).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}}); expect(f.snapshot()).toEqual(before);
  });

  it('cancels all idle unfinished descendants, retains terminal children and fences their queued work', () => {
    const f=fixture(); f.run(); f.turn(); f.task('child','WAITING_USER','root'); f.run('child','SUCCEEDED'); f.turn('run-child','SUCCEEDED');
    f.task('done','DONE','child'); f.task('cancelled','CANCELLED','root'); f.task('no-run','OPEN','done');
    for (const id of ['child','done','no-run']) f.outbox(`task:${id}:initial`);
    const history=f.db.prepare('SELECT * FROM workflow_runs').all();
    expect(f.close()).toMatchObject({ok:true,data:{cancelledTaskIds:['root','child','no-run'],cancelledOutboxCount:3}});
    expect(f.db.prepare("SELECT status,revision,stop_generation FROM tasks WHERE id='done'").get()).toEqual({status:'DONE',revision:7,stop_generation:3});
    expect(f.db.prepare("SELECT status,revision,stop_generation FROM tasks WHERE id='cancelled'").get()).toEqual({status:'CANCELLED',revision:7,stop_generation:3});
    expect(f.db.prepare('SELECT * FROM workflow_runs').all()).toEqual(history);
  });

  it('rolls queue cancellations, child closures, events and gateway receipts back on a late storage failure', () => {
    const f=fixture(); f.run(); f.turn(); f.reply('thread_reply_requests'); const job=f.recovery(); f.outbox(job.targetDispatchKey); f.repair();
    f.task('child','OPEN','root'); f.outbox('task:child:initial');
    f.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;`);
    const before=f.snapshot(); expect(f.close()).toMatchObject({ok:false,error:{code:'STORAGE_UNAVAILABLE'}}); expect(f.snapshot()).toEqual(before);
    f.db.exec('DROP TRIGGER fail_receipt');
    expect(f.close()).toMatchObject({ok:true});
  });

  it('its own nested transaction rolls back partial work even when the outer caller catches the failure', () => {
    const f=fixture(); f.run(); f.turn(); f.reply('conversation_reply_requests'); f.repair();
    const bound=f.binding();
    f.db.exec(`CREATE TRIGGER fail_closure_event BEFORE INSERT ON domain_events WHEN NEW.kind='task.closed'
      BEGIN SELECT RAISE(ABORT,'injected event failure'); END;`);
    const before=f.snapshot();
    f.db.transaction(() => { expect(()=>closeIdleTask(f.db,bound,100)).toThrow('injected event failure'); })();
    expect(f.snapshot()).toEqual(before);
  });

  it('relies on gateway command receipts for exact replay and never closes a later execution on replay', () => {
    const f=fixture(); f.run(); f.turn(); const bound=f.binding(); const original=f.close(bound);
    f.db.prepare("UPDATE tasks SET status='ACTIVE',revision=revision+1 WHERE id='root'").run(); f.run('root','RUNNING','later-run'); f.turn('later-run','RUNNING'); f.outbox();
    const before=f.snapshot();
    expect(f.close(bound)).toEqual({...original,replayed:true}); expect(f.snapshot()).toEqual(before);
    expect(f.close(bound,'new-command')).toMatchObject({ok:false,error:{code:'STALE_REVISION'}}); expect(f.snapshot()).toEqual(before);
  });

  it('reports missing and already terminal tasks without writes or a usable binding', () => {
    const f=fixture();
    expect(readTaskClosure(f.db,'missing')).toEqual({available:false,blockReason:{code:'RESOURCE_NOT_FOUND',message:'任务不存在',taskId:'missing'}});
    for (const status of ['DONE','CANCELLED']) {
      f.db.prepare("UPDATE tasks SET status=? WHERE id='root'").run(status); const before=f.snapshot();
      expect(readTaskClosure(f.db,'root')).toMatchObject({available:false,blockReason:{code:'VALIDATION_INVALID'}});
      expect(f.close({taskId:'root',expectedTaskRevision:7,expectedStopGeneration:3,sourceRunId:null})).toMatchObject({ok:false,error:{code:'VALIDATION_INVALID'}});
      expect(f.snapshot()).toEqual(before);
    }
  });
});
