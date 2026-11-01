import {afterEach,describe,expect,it,vi} from 'vitest';
import {requestRecoveryOpen,OPEN_RECOVERY_EVENT} from '../../src/ui/hifi/lib/recovery.ts';
import {dispatchBlockedFixture} from '../fixtures/dispatchBlockedR154.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {inspectRecovery} from '../../src/daemon/recoveryInspection.ts';

afterEach(()=>vi.unstubAllGlobals());

describe('R155 recovery target transport',()=>{
  it('delivers the actual parent action child binding through App to RecoveryPanel',async()=>{
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
      const status=readTaskExecutionStatus(db,'parent')!,inspection=inspectRecovery(db,'held-turn',{})!;
      expect(status.phase).toBe('UNKNOWN');
      expect(status.taskId).toBe('parent');
      expect(status.reason).toMatchObject({taskId:'child',runId:'child-run',turnId:'held-turn'});
      expect(inspection).toMatchObject({taskId:'child',parentTaskId:'parent',memberName:'Pi',result:{complete:false,answer:null},lastActivity:{description:'python -'}});
      expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
      config={status,inspection};
    } finally {db.close();}
    const result=await helper.default.runVerifier(config);
    expect(result.checks.filter(check=>!check.ok),result.evidence).toEqual([]);
    expect(result.ok).toBe(true);
  },35_000);
  it('preserves the exact child task and turn without changing the current route',()=>{
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
