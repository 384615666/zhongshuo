import {dispatchBlockedFixture as fixture,dispatchBlockedReasons as reasons} from '../fixtures/dispatchBlockedR154.ts';
import {describe,expect,it} from 'vitest';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {readTaskDetails} from '../../src/daemon/taskDetails.ts';

describe('R154 durable coordination failure reasons',()=>{
  it.each(reasons)('projects the real reason on child and parent without inventing a child run: %s',message=>{
    const {db,event}=fixture();try{
      event('parent','parent-current','coordination.blocked',{});
      const seq=event('child',null,'coordination.dispatchBlocked',{message});
      event('child',null,'task.statusChanged',{status:'BLOCKED'});
      for(const id of ['child','parent']){
        const status=readTaskExecutionStatus(db,id)!;
        expect(status.phase).toBe('FAILED');
        expect(status.reason).toMatchObject({message,taskId:'child',runId:null,turnId:null,eventSeq:seq});
      }
      expect(db.prepare("SELECT status FROM tasks WHERE id='parent'").get()).toEqual({status:'BLOCKED'});
      expect(db.prepare("SELECT count(*) n FROM workflow_runs WHERE task_id='child'").get()).toEqual({n:0});
      const details=readTaskDetails(db,'parent');
      expect(details.memberFailures).toEqual([expect.objectContaining({taskId:'child',runId:null,notStarted:true,memberName:'复核成员',coordinationRunId:'parent-current',failure:expect.objectContaining({eventKind:'coordination.dispatchBlocked',message,eventSeq:seq})})]);
      expect(details.memberRuns?.some(run=>run.taskId==='child')).toBe(false);
    }finally{db.close();}
  });

  it('does not present a bare BLOCKED status as an explanation',()=>{
    const {db,event}=fixture();try{
      event('child',null,'task.statusChanged',{status:'BLOCKED'});
      expect(readTaskExecutionStatus(db,'child')!.reason.message).toBe('最近执行未成功完成。');
    }finally{db.close();}
  });

  it('prefers the actual blocked child over a generic parent summary',()=>{
    const {db,event}=fixture();try{
      const seq=event('child',null,'coordination.dispatchBlocked',{message:reasons[1]});
      event('parent','parent-current','coordination.blocked',{message:'同伴步骤未完成'});
      expect(readTaskExecutionStatus(db,'parent')!.reason).toMatchObject({message:reasons[1],taskId:'child',runId:null,eventSeq:seq});
    }finally{db.close();}
  });

  it('exposes a matching member dispatch failure in the selected parent run participants',()=>{
    const {db,event}=fixture();try{
      db.exec("INSERT INTO run_participants(run_id,member_id,role,expected,status) VALUES('parent-current','owner','worker',1,'FAILED')");
      event('parent','parent-current','coordination.dispatchBlocked',{message:'本轮成员尚未派发',memberId:'owner'});
      expect(readTaskDetails(db,'parent').runs.find(run=>run.id==='parent-current')?.participants).toEqual([
        expect.objectContaining({memberId:'owner',notStarted:true,failure:expect.objectContaining({eventKind:'coordination.dispatchBlocked',message:'本轮成员尚未派发'})}),
      ]);
    }finally{db.close();}
  });

  it('keeps the latest parent plan isolated from later events on an older child',()=>{
    const {db,event}=fixture();try{
      const seq=event('child',null,'coordination.dispatchBlocked',{message:reasons[0]});
      for(let i=0;i<60;i++)event('old-child',null,'coordination.dispatchBlocked',{message:'旧轮迟到失败'});
      expect(readTaskExecutionStatus(db,'parent')!.reason).toMatchObject({message:reasons[0],taskId:'child',eventSeq:seq,runId:null});
      expect(readTaskDetails(db,'parent','parent-old').memberFailures).toEqual([expect.objectContaining({taskId:'old-child',coordinationRunId:'parent-old',failure:expect.objectContaining({message:'旧轮迟到失败'})})]);
    }finally{db.close();}
  });

  it('uses the latest child run, while explicitly selected history retains its own failure',()=>{
    const {db,event,run}=fixture();try{
      run('child-old');event('child','child-old','coordination.dispatchBlocked',{message:'旧执行失败'});
      run('child-current');const seq=event('child','child-current','coordination.dispatchBlocked',{message:'本次派发具体原因'});
      event('child','child-current','turn.statusChanged',{status:'FAILED'});
      for(let i=0;i<60;i++)event('child','child-old','coordination.dispatchBlocked',{message:'旧执行迟到事件'});
      expect(readTaskExecutionStatus(db,'child')!.reason).toMatchObject({message:'本次派发具体原因',runId:'child-current',eventSeq:seq});
      expect(readTaskExecutionStatus(db,'parent')!.reason).toMatchObject({message:'本次派发具体原因',taskId:'child',runId:'child-current'});
      const details=readTaskDetails(db,'parent','child-old');
      expect(details.selectedRunId).toBe('child-old');
      expect(details.memberRuns?.find(run=>run.id==='child-old')?.failure).toMatchObject({eventKind:'coordination.dispatchBlocked',message:'旧执行迟到事件'});
      expect(details.memberRuns?.find(run=>run.id==='child-current')?.failure).toMatchObject({eventKind:'coordination.dispatchBlocked',message:'本次派发具体原因'});
    }finally{db.close();}
  });

  it('does not apply an old unbound dispatch failure to a newly created run without a reason',()=>{
    const {db,event,run}=fixture();try{
      event('child',null,'coordination.dispatchBlocked',{message:'以前尚未开始的失败'});
      run('new-attempt');
      expect(readTaskExecutionStatus(db,'child')!.reason).toMatchObject({message:'最近执行未成功完成。',runId:'new-attempt'});
    }finally{db.close();}
  });

  it('preserves a newer dispatch failure without attributing it to an earlier run',()=>{
    const {db,event,run}=fixture();try{
      run('prior-run');event('child','prior-run','turn.failed',{message:'上一轮失败'});
      const seq=event('child',null,'coordination.dispatchBlocked',{message:'后续派发被拒绝'});
      expect(readTaskExecutionStatus(db,'child')!.reason).toMatchObject({message:'后续派发被拒绝',runId:null,eventSeq:seq});
    }finally{db.close();}
  });

  it('retains UNKNOWN protection ahead of failure copy and performs no database mutations',()=>{
    const {db,event,run}=fixture();try{
      run('unknown','INTERRUPTED');
      db.exec("INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,protection_state) VALUES('held','unknown','conv','thread','reviewer','coordination.child','UNKNOWN','retained')");
      event('child','unknown','coordination.dispatchBlocked',{message:reasons[1]});
      const before=db.prepare('SELECT total_changes() n').get();
      expect(readTaskExecutionStatus(db,'parent')!.phase).toBe('UNKNOWN');
      expect(readTaskExecutionStatus(db,'child')!.phase).toBe('UNKNOWN');
      readTaskDetails(db,'parent');
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      expect(db.prepare("SELECT status,protection_state FROM agent_turns WHERE id='held'").get()).toEqual({status:'UNKNOWN',protection_state:'retained'});
    }finally{db.close();}
  });

  it.each(['matching','other-turn','unfinished-stop','wrong-run'] as const)('binds shutdown context to the exact unknown turn: %s',variant=>{
    const {db,event,run}=fixture();try{
      run('interrupted','INTERRUPTED');
      db.exec("INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,protection_state) VALUES('held','interrupted','conv','thread','reviewer','coordination.child','UNKNOWN','retained')");
      const seq=event('child',variant==='wrong-run'?'parent-current':'interrupted','turn.statusChanged',{status:'UNKNOWN',reason:'provider-interrupted-without-terminal-proof'},'held');
      db.prepare("INSERT INTO daemon_state(key,value,updated_at) VALUES('daemon:stop:last',?,1010)")
        .run(JSON.stringify({pid:12345,phase:variant==='unfinished-stop'?'incomplete':'closed',at:1010,stopRequestsSentTo:[variant==='other-turn'?'unrelated':'held']}));
      const before=db.prepare('SELECT total_changes() n').get();
      const status=readTaskExecutionStatus(db,'child')!;
      expect(status.phase).toBe('UNKNOWN');
      expect(status.reason).toMatchObject({code:'RECOVERY_REQUIRED',runId:'interrupted',turnId:'held'});
      if(variant==='matching'){
        expect(status.reason.message).toContain('应用关闭时本轮中断；可直接继续任务');
        expect(status.reason.eventSeq).toBe(seq);
      }else expect(status.reason.message).not.toContain('应用关闭');
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      expect(db.prepare("SELECT status,protection_state FROM agent_turns WHERE id='held'").get()).toEqual({status:'UNKNOWN',protection_state:'retained'});
    }finally{db.close();}
  });

  it.each(['history','conflict','wrong-key','missing-pid'] as const)('uses strict completed-stop history for explanation only: %s',variant=>{
    const {db,event,run}=fixture();try{
      run('interrupted','INTERRUPTED');
      db.exec("INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,protection_state) VALUES('held','interrupted','conv','thread','reviewer','coordination.child','UNKNOWN','retained')");
      event('child','interrupted','turn.statusChanged',{status:'UNKNOWN',reason:'provider-interrupted-without-terminal-proof'},'held');
      const insert=db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?)');
      insert.run('daemon:stop:last',JSON.stringify({pid:23456,phase:'closed',at:1200,stopRequestsSentTo:[]}),1200);
      insert.run(variant==='wrong-key'?'daemon:stop:history:1:2':'daemon:stop:history:12345:1010',
        JSON.stringify({...(variant==='missing-pid'?{}:{pid:12345}),phase:'closed',at:1010,stopRequestsSentTo:['held']}),1010);
      if(variant==='conflict')insert.run('daemon:stop:history:34567:1100',JSON.stringify({pid:34567,phase:'closed',at:1100,stopRequestsSentTo:['held']}),1100);
      const before=db.prepare('SELECT total_changes() n').get();
      const status=readTaskExecutionStatus(db,'child')!;
      expect(status.phase).toBe('UNKNOWN');
      expect(status.reason.message.includes('应用关闭时本轮中断')).toBe(variant==='history');
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      expect(db.prepare("SELECT protection_state FROM agent_turns WHERE id='held'").get()).toEqual({protection_state:'retained'});
    }finally{db.close();}
  });
});
