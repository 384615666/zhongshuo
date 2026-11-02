import {describe,expect,it,vi} from 'vitest';
import {createTaskContinuation,previousReplyStillHeld} from '../../src/ui/hifi/lib/checkPreviousReply';
import {loadRecoveryTasks} from '../../src/ui/hifi/lib/recovery';

const binding={taskId:'parent',expectedTaskRevision:4,expectedStopGeneration:2};
const accepted={status:'ok' as const,data:{enqueued:true,dispatchKey:'task:parent:continue'}};
describe('R156 direct task continuation',()=>{
  it('sends the original parent binding once without inspecting or reconciling a turn',async()=>{
    const send=vi.fn().mockResolvedValue(accepted);
    const result=await createTaskContinuation(send)(binding);
    expect(result).toEqual(accepted);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([expect.any(String),'task.continue',binding]);
  });
  it('keeps the selected source run bound when supplied',async()=>{
    const send=vi.fn().mockResolvedValue(accepted);
    await createTaskContinuation(send)({...binding,sourceRunId:'source-run'});
    expect(send.mock.calls[0]![2]).toEqual({...binding,sourceRunId:'source-run'});
  });
  it('joins rapid repeated clicks while the continuation is pending',async()=>{
    let finish!:(value:typeof accepted)=>void;
    const send=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const resume=createTaskContinuation(send),first=resume(binding);
    expect(resume(binding)).toBe(first);await Promise.resolve();expect(send).toHaveBeenCalledTimes(1);
    finish(accepted);await first;expect(send).toHaveBeenCalledTimes(1);
  });
  it('permits a later interruption of the same task without returning an old successful receipt',async()=>{
    const send=vi.fn().mockResolvedValue(accepted),resume=createTaskContinuation(send);
    await resume({taskId:'parent'});await resume({taskId:'parent'});
    expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]![0]).not.toBe(send.mock.calls[1]![0]);
  });
  it('retries an uncertain transport using the same command identity',async()=>{
    const send=vi.fn().mockResolvedValueOnce({status:'unknown',error:'连接中断'}).mockResolvedValueOnce(accepted);
    const resume=createTaskContinuation(send);
    expect((await resume(binding)).status).toBe('unknown');await resume(binding);
    expect(send.mock.calls[0]![0]).toBe(send.mock.calls[1]![0]);
    expect(send.mock.calls.map(call=>call[1])).toEqual(['task.continue','task.continue']);
  });
  it('permits a fresh explicit attempt after a definite rejection and uses new identity for a new revision',async()=>{
    const send=vi.fn().mockResolvedValueOnce({status:'failed',error:'任务版本已变化',code:'STALE_REVISION'}).mockResolvedValue(accepted);
    const resume=createTaskContinuation(send);expect((await resume(binding)).status).toBe('failed');await resume({...binding,expectedTaskRevision:5});
    expect(send.mock.calls[0]![0]).not.toBe(send.mock.calls[1]![0]);
    expect(send.mock.calls[1]![2]).toMatchObject({expectedTaskRevision:5});
  });
  it('does not offer released UNKNOWN history as an outstanding task',()=>{
    const status={unknownTurns:[{id:'old',protectionReleased:true}],pendingRelease:[],heldLeases:[]};
    expect(previousReplyStillHeld(status,'old')).toBe(false);
    expect(previousReplyStillHeld({...status,pendingRelease:[{turnId:'old'}]},'old')).toBe(true);
  });
  it('resolves siblings and multiple generations to one actual root, using its revision rather than the child revision',async()=>{
    const facts:Record<string,{id:string;title:string;status:string;parent_task_id:string|null;revision:number;stop_generation:number}>={
      child:{id:'child',title:'child',status:'BLOCKED',parent_task_id:'middle',revision:8,stop_generation:1},
      sibling:{id:'sibling',title:'sibling',status:'BLOCKED',parent_task_id:'parent',revision:9,stop_generation:2},
      middle:{id:'middle',title:'middle',status:'BLOCKED',parent_task_id:'parent',revision:10,stop_generation:3},
      parent:{id:'parent',title:'原父任务',status:'BLOCKED',parent_task_id:null,revision:11,stop_generation:4},
    };
    const read=vi.fn(async(id:string)=>({task:facts[id]!}));
    expect(await loadRecoveryTasks(['child','sibling','parent'],read)).toEqual([{task:facts.parent,executionStatus:undefined,binding:{taskId:'parent',expectedTaskRevision:11,expectedStopGeneration:4}}]);
    expect(read.mock.calls.filter(call=>call[0]==='parent')).toHaveLength(1);
  });
  it('shows missing or cyclic task ownership as a read failure instead of continuing the wrong task',async()=>{
    await expect(loadRecoveryTasks(['child'],async()=>({task:{id:'another',title:'wrong',status:'BLOCKED'}}))).rejects.toThrow('不匹配');
    await expect(loadRecoveryTasks(['child'],async id=>({task:{id,title:id,status:'BLOCKED',parent_task_id:'child'}}))).rejects.toThrow('归属记录异常');
  });
});
