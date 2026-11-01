import {describe,expect,it} from 'vitest';
import {dispatchBlockedFixture} from '../fixtures/dispatchBlockedR154.ts';
import {inspectRecovery} from '../../src/daemon/recoveryInspection.ts';
import {dispatchDaemonCommand,type DaemonCommandDeps} from '../../src/daemon/commands.ts';
import {registerTurnProcess} from '../../src/daemon/processRegistry.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {assessTaskRedispatchReadiness} from '../../src/persistence/stores/recoveryGuard.ts';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir,uptime} from 'node:os';
import {join} from 'node:path';

function fixture(){
  const f=dispatchBlockedFixture();
  f.db.exec(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status)
    VALUES('interrupted','child','conv','thread','DIRECT','INTERRUPTED');
    INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,protection_state,budget_mark)
    VALUES('lost','interrupted','conv','thread','reviewer','coordination.child','UNKNOWN','retained','settled');`);
  f.event('child','interrupted','tool.started',{toolCallId:'tool-lost',target:'python --version --api-key sk-secret-test-123456',toolName:'Bash'},'lost');
  f.event('child','interrupted','turn.statusChanged',{status:'UNKNOWN'},'lost');
  return f;
}

describe('R155 concrete interrupted execution inspection',()=>{
  it('shows missing final result, exact child/member and last tool without any DB mutations',()=>{
    const{db}=fixture();try{
      const before=db.prepare('SELECT total_changes() n').get();
      const result=inspectRecovery(db,'lost',{});
      expect(result).toMatchObject({turnId:'lost',taskId:'child',parentTaskId:'parent',taskTitle:'当前复核',memberName:'复核成员',
        turnStatus:'UNKNOWN',protectionState:'retained',budgetMark:'settled',result:{complete:false,answer:null,files:[]},
        exitCheck:{state:'blocked',action:'retry'}});
      expect(result?.lastActivity?.description).toContain('python --version');
      expect(result?.lastActivity?.description).not.toContain('sk-secret');
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    }finally{db.close();}
  });

  it('uses complete managed evidence only, and never equates a ready release with successful work',()=>{
    const{db}=fixture();try{
      registerTurnProcess(db,{turnId:'lost',runId:'interrupted',memberId:'reviewer',adapterKind:'pi',processModel:'per-turn',
        pid:555005,startedAtMs:1000,identitySource:'managed-job',managedJobId:'own-job',note:'job=own-job'});
      const before=db.prepare('SELECT total_changes() n').get();
      const options={managedEvidence:()=>({pid:555005,releasable:true,reason:'completed'})};
      expect(inspectRecovery(db,'lost',options)).toMatchObject({result:{complete:false},exitCheck:{state:'ready',action:'release'}});
      expect(inspectRecovery(db,'lost',{managedEvidence:()=>({pid:555005,releasable:false,reason:'后代仍在运行'})})).toMatchObject({exitCheck:{state:'blocked',message:'后代仍在运行'}});
      expect(inspectRecovery(db,'lost',{managedEvidence:()=>({pid:666006,releasable:true,reason:'wrong-owner'})})).toMatchObject({exitCheck:{state:'blocked'}});
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    }finally{db.close();}
  });

  it('keeps active turns and contradictory managed registrations blocked',()=>{
    const{db}=fixture();try{
      db.prepare("UPDATE agent_turns SET status='RUNNING',protection_state=NULL WHERE id='lost'").run();
      expect(inspectRecovery(db,'lost',{})).toMatchObject({exitCheck:{state:'blocked',message:'这次执行仍在进行，请先停止任务，再检查。'}});
      db.prepare("UPDATE agent_turns SET status='UNKNOWN',protection_state='retained' WHERE id='lost'").run();
      registerTurnProcess(db,{turnId:'lost',runId:'interrupted',memberId:'reviewer',adapterKind:'pi',processModel:'none',
        pid:null,startedAtMs:null,identitySource:'managed-job',note:'invalid'});
      expect(inspectRecovery(db,'lost',{})).toMatchObject({exitCheck:{state:'blocked'}});
    }finally{db.close();}
  });

  it.each([null,'released'])('closes a legacy UNKNOWN with missing retained mark (%s) only after server exit evidence',async protectionState=>{
    const{db}=fixture();try{
      db.prepare("UPDATE agent_turns SET protection_state=? WHERE id='lost'").run(protectionState);
      registerTurnProcess(db,{turnId:'lost',runId:'interrupted',memberId:'reviewer',adapterKind:'fake',processModel:'none',pid:null,startedAtMs:null,identitySource:'none'});
      expect(assessTaskRedispatchReadiness(db,'parent')).not.toBeNull();
      const result=await dispatchDaemonCommand({db,localUserId:'u',interruptTurn:async()=>{}},
        {protocolVersion:1,commandId:crypto.randomUUID(),method:'recovery.releaseProtection',params:{turnId:'lost',note:'检查旧执行并解除占用'}});
      expect(result).toMatchObject({ok:true,data:{stateChanged:true}});
      expect(assessTaskRedispatchReadiness(db,'parent')).toBeNull();
      expect(inspectRecovery(db,'lost',{})).toMatchObject({turnStatus:'UNKNOWN',exitCheck:{state:'released'}});
    }finally{db.close();}
  });

  it('refuses contradictory no-process evidence on the actual release command',async()=>{
    const{db}=fixture();try{
      registerTurnProcess(db,{turnId:'lost',runId:'interrupted',memberId:'reviewer',adapterKind:'pi',processModel:'none',pid:777002,startedAtMs:1000,identitySource:'pre-launch'});
      const result=await dispatchDaemonCommand({db,localUserId:'u',interruptTurn:async()=>{}},
        {protocolVersion:1,commandId:crypto.randomUUID(),method:'recovery.releaseProtection',params:{turnId:'lost',note:'不能仅凭模型标签解除保护'}});
      expect(result).toMatchObject({ok:false});
      expect(inspectRecovery(db,'lost',{})).toMatchObject({exitCheck:{state:'blocked'}});
      expect(assessTaskRedispatchReadiness(db,'parent')).not.toBeNull();
    }finally{db.close();}
  });

  it('shows a released original UNKNOWN without implying it was completed or resubmitting it',()=>{
    const{db,event}=fixture();try{
      db.prepare("UPDATE agent_turns SET protection_state='released' WHERE id='lost'").run();
      event('child','interrupted','recovery.protectionReleased',{released:true},'lost');
      const before=db.prepare('SELECT total_changes() n').get();
      expect(inspectRecovery(db,'lost',{})).toMatchObject({turnStatus:'UNKNOWN',result:{complete:false,answer:null},exitCheck:{state:'released',action:'none'}});
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    }finally{db.close();}
  });

  it('formal read command refuses remote access and unknown IDs without reconciliation or receipts',async()=>{
    const{db}=fixture();try{
      const deps={db,localUserId:'u',interruptTurn:async()=>{}};
      const cmd=(turnId:string,remote=false)=>dispatchDaemonCommand({...deps,...(remote?{remoteAudit:{deviceId:'device',authEpoch:1}}:{})},
        {protocolVersion:1,commandId:crypto.randomUUID(),method:'recovery.inspect',params:{turnId}}) as Promise<{ok:boolean;error?:{code:string};data?:unknown}>;
      const before=db.prepare('SELECT total_changes() n').get();
      expect(await cmd('lost')).toMatchObject({ok:true,data:{taskId:'child',result:{complete:false}}});
      expect(await cmd('missing')).toMatchObject({ok:false,error:{code:'RESOURCE_NOT_FOUND'}});
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      expect(await cmd('lost',true)).toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});
      expect(db.prepare("SELECT status,protection_state,budget_mark FROM agent_turns WHERE id='lost'").get()).toEqual({status:'UNKNOWN',protection_state:'retained',budget_mark:'settled'});
    }finally{db.close();}
  });

  it('binds parent recovery to the actual child and permits new explicit work only after verified release',async()=>{
    const{db}=fixture();try{
      registerTurnProcess(db,{turnId:'lost',runId:'interrupted',memberId:'reviewer',adapterKind:'fake',processModel:'none',
        pid:null,startedAtMs:null,identitySource:'none'});
      const before=readTaskExecutionStatus(db,'parent')!;
      expect(before.phase).toBe('UNKNOWN');
      expect(before.reason).toMatchObject({taskId:'child',runId:'interrupted',turnId:'lost'});
      expect(before.actions).toContainEqual(expect.objectContaining({kind:'recover',label:'检查中断',target:{kind:'recovery',id:'lost'}}));
      expect(assessTaskRedispatchReadiness(db,'parent')?.fact).toMatchObject({turnId:'lost'});
      const outbox=db.prepare('SELECT * FROM outbox ORDER BY id').all();
      expect(inspectRecovery(db,'lost',{})).toMatchObject({exitCheck:{state:'ready'}});
      const released=await dispatchDaemonCommand({db,localUserId:'u',interruptTurn:async()=>{}},
        {protocolVersion:1,commandId:crypto.randomUUID(),method:'recovery.releaseProtection',params:{turnId:'lost',note:'用户明确解除已结束的执行占用'}});
      expect(released).toMatchObject({ok:true,data:{stateChanged:true}});
      expect(assessTaskRedispatchReadiness(db,'parent')).toBeNull();
      expect(db.prepare('SELECT * FROM outbox ORDER BY id').all()).toEqual(outbox);
      expect(db.prepare("SELECT status,protection_state,budget_mark FROM agent_turns WHERE id='lost'").get()).toEqual({status:'UNKNOWN',protection_state:'released',budget_mark:'settled'});
      expect(inspectRecovery(db,'lost',{})).toMatchObject({exitCheck:{state:'released'},result:{complete:false}});
    }finally{db.close();}
  });

  it.skipIf(process.platform!=='win32')('formally releases a synthetic registration from before the real OS boot, preserving UNKNOWN and parent history',async()=>{
    const{db}=fixture();
    const dir=mkdtempSync(join(tmpdir(),'zs-r155-boot-command-'));
    try{
      const now=Date.now(),old=now-uptime()*1000-60*60_000;
      const instance={pid:process.pid,startedAt:now-1000};
      mkdirSync(join(dir,'locks/daemon.lock.d'),{recursive:true});
      writeFileSync(join(dir,'locks/daemon.lock.d/owner.json'),JSON.stringify(instance));
      const registered=Math.floor(old);
      const job=`job-${(registered-1000).toString(36)}-777002`;
      registerTurnProcess(db,{turnId:'lost',runId:'interrupted',memberId:'reviewer',adapterKind:'pi',processModel:'per-turn',pid:777002,
        startedAtMs:registered-2000,identitySource:'managed-job',managedJobId:job,note:`job=${job}`,now:registered});
      const deps:DaemonCommandDeps={db,localUserId:'u',interruptTurn:async()=>{},appDataDir:dir,recoveryInstance:instance,
        processQuery:(pid:number)=>({state:'exited' as const,pid}),processTree:()=>({state:'checked' as const,survivors:[],verifiedHistoricalPids:[]})};
      const outbox=db.prepare('SELECT * FROM outbox ORDER BY id').all();
      const release=await dispatchDaemonCommand(deps,{protocolVersion:1,commandId:crypto.randomUUID(),method:'recovery.releaseProtection',
        params:{turnId:'lost',note:'用户检查后明确解除旧占用，业务结果仍未知',endPreviousExecution:true}});
      expect(release).toMatchObject({ok:true,data:{stateChanged:true}});
      const event=db.prepare("SELECT payload_json FROM domain_events WHERE turn_id='lost' AND kind='recovery.protectionReleased'").get() as {payload_json:string};
      expect(JSON.parse(event.payload_json)).toMatchObject({released:true,previousOwnerEvidence:{source:'windows-system-reboot'}});
      expect(assessTaskRedispatchReadiness(db,'parent')).toBeNull();
      expect(db.prepare('SELECT * FROM outbox ORDER BY id').all()).toEqual(outbox);
      expect(db.prepare("SELECT status,protection_state,budget_mark FROM agent_turns WHERE id='lost'").get()).toEqual({status:'UNKNOWN',protection_state:'released',budget_mark:'settled'});
    }finally{db.close();rmSync(dir,{recursive:true,force:true});}
  },15_000);
});
