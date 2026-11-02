import {afterEach,describe,expect,it,vi} from 'vitest';
import {requestRecoveryOpen,OPEN_RECOVERY_EVENT} from '../../src/ui/hifi/lib/recovery.ts';
import {dispatchBlockedFixture} from '../fixtures/dispatchBlockedR154.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';

afterEach(()=>vi.unstubAllGlobals());

describe('R156 direct continuation and recovery navigation',()=>{
  it('continues the actual backend parent with one click and no inspection workflow',async()=>{
    const helper=await import(new URL('./helpers/recoveryInspectR155.cjs',import.meta.url).href) as {default:{runVerifier(config:unknown):Promise<{ok:boolean;checks:Array<{name:string;ok:boolean}>;evidence:string}>}};
    const {db,event,run}=dispatchBlockedFixture();
    let config;
    try {
      db.exec("UPDATE project_members SET display_name='Pi' WHERE id='reviewer'; UPDATE tasks SET title='Pi 生成六件套测试文件' WHERE id='child'");
      run('child-run','INTERRUPTED');
      db.exec("INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,protection_state,budget_mark) VALUES('held-turn','child-run','conv','thread','reviewer','coordination.child','UNKNOWN','retained','settled')");
      event('child','child-run','tool.started',{toolCallId:'tool-python',toolName:'Bash',target:'python -'},'held-turn');
      event('child','child-run','turn.statusChanged',{status:'UNKNOWN',reason:'provider-interrupted-without-terminal-proof'},'held-turn');
      const before=db.prepare('SELECT total_changes() n').get();
      const status=readTaskExecutionStatus(db,'parent')!;
      expect(status.phase).toBe('UNKNOWN');
      expect(status.taskId).toBe('parent');
      expect(status.reason).toMatchObject({taskId:'child',runId:'child-run',turnId:'held-turn'});
      expect(status.actions).toContainEqual(expect.objectContaining({kind:'continue',label:'继续任务',binding:{taskId:'parent',expectedTaskRevision:status.evidence.taskRevision,expectedStopGeneration:status.evidence.stopGeneration}}));
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      event('child','child-run','recovery.protectionReleased',{released:true},'held-turn');
      db.exec("UPDATE agent_turns SET protection_state='released' WHERE id='held-turn'; INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES('live-run','parent','conv','thread','DIRECT','RUNNING'); INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status) VALUES('live-turn','live-run','conv','thread','owner','DIRECT','RUNNING')");
      const ongoing=readTaskExecutionStatus(db,'parent')!;
      expect(ongoing.phase).toBe('RUNNING');
      expect(ongoing.actions.some(action=>action.kind==='continue')).toBe(false);
      config={status,ongoing};
    } finally {db.close();}
    const result=await helper.default.runVerifier(config);
    expect(result.checks.filter(check=>!check.ok),result.evidence).toEqual([]);
    expect(result.ok).toBe(true);
  },35_000);
  it('preserves an optional parent target for the recovery list without changing the route',()=>{
    const dispatchEvent=vi.fn();
    vi.stubGlobal('window',{dispatchEvent});
    vi.stubGlobal('CustomEvent',class {constructor(public type:string,public init:{detail:unknown}){ } get detail(){return this.init.detail;}});
    requestRecoveryOpen({turnId:'pi-old-turn',taskId:'pi-child',runId:'pi-run',projectId:'project',requestTaskId:'parent'});
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event=dispatchEvent.mock.calls[0]![0] as {type:string;detail:unknown};
    expect(event.type).toBe(OPEN_RECOVERY_EVENT);
    expect(event.detail).toEqual({origin:'runtime',target:{turnId:'pi-old-turn',taskId:'pi-child',runId:'pi-run',projectId:'project',requestTaskId:'parent'}});
  });

  it('continues to support the general recovery entry with no guessed target',()=>{
    const dispatchEvent=vi.fn();vi.stubGlobal('window',{dispatchEvent});
    vi.stubGlobal('CustomEvent',class {constructor(public type:string,public init:{detail:unknown}){}get detail(){return this.init.detail;}});
    requestRecoveryOpen();
    expect(dispatchEvent.mock.calls[0]![0].detail).toEqual({origin:'runtime',target:undefined});
  });
});
