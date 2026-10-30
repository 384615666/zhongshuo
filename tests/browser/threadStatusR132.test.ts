import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {getState,setState} from '../../src/ui/hifi/data/store.ts';
import {threadExecutionStatusOf} from '../../src/ui/hifi/data/selectors.ts';
import {loadThread} from '../../src/ui/hifi/loader.ts';
import type {TaskExecutionStatus} from '../../src/contracts/executionStatus.ts';

const initial=getState();
function status(revision=2,phase:TaskExecutionStatus['phase']='WAITING_FOR_USER'):TaskExecutionStatus{
  return{schemaVersion:'task-execution-status-v1',taskId:'task',scope:{projectId:'p',conversationId:'c',roomId:'r',threadId:'t',taskKind:'room_task',surfaces:['room','thread']},
    phase,reason:{code:phase==='WAITING_FOR_USER'?'WAITING_INPUT':'TASK_COMPLETED',message:'请确认选项',source:'task',taskId:'task',runId:null,turnId:null,eventSeq:revision},
    actualPerformingMembers:[],waitingMembers:[],waitingForUser:phase==='WAITING_FOR_USER'?{kind:'input',message:'请确认选项',memberIds:[],runId:null,turnId:null,deliveryId:null,eventSeq:revision,since:1}:null,
    lastBusinessActivity:null,existingResults:{hasResults:false,currentDelivery:null,pendingReviewDelivery:null,deliveries:[],artifacts:[],changeSets:[],truncated:{deliveries:false,artifacts:false,changeSets:false}},actions:[],
    evidence:{sourceHighWatermark:revision,taskStatus:phase==='WAITING_FOR_USER'?'WAITING_USER':'DONE',taskRevision:revision,stopGeneration:0,runCount:0,turnCount:0,activeRunIds:[],unknownTurnIds:[],latestRun:null,outbox:null,executionBlocker:null,preDispatchFailure:null,recovery:null,heartbeatUsedAsActivity:false},observedAt:revision};
}
const thread={id:'t',projectId:'p',conversationId:'c',roomId:'r',rootTaskId:'task',anchorMessageId:'root',status:'open' as const,lastMessageSeq:0,revision:1};
function taskData(executionStatus=status()){
  return{task:{id:'task',title:'独立状态读取',status:executionStatus.evidence.taskStatus,room_id:'r',conversation_thread_id:'t',room_task_number:1,revision:executionStatus.evidence.taskRevision,stopGeneration:0},activeRun:null,pendingDelivery:null,executionStatus};
}
function gate(){let release!:(value:unknown)=>void;const promise=new Promise<unknown>(r=>{release=r;});return{promise,release};}
function host(read:(method:string)=>Promise<unknown>){
  vi.stubGlobal('window',{zs:{command:async(e:{method:string})=>({ok:true,data:await read(e.method)})},location:{hash:'#/project/p/room/r?thread=t'}});
}
beforeEach(()=>{
  setState(s=>({...s,activeProjectId:'p',loadGen:s.loadGen+1,threads:[thread],threadEntities:{},threadTasks:{},threadMessages:{},threadAnchors:{},threadReadSeq:{},roomPool:{r:[{
    threadId:'t',projectId:'p',roomId:'r',anchorMessageId:'root',taskId:'task',taskStatus:'WAITING_USER',roomTaskNumber:1,taskTitle:'确认',body:'原请求',createdAt:1,replyCount:0,lastReplyAt:null,unread:0,muted:false,followed:false,executionStatus:status(),
  }]},messages:[],tasks:[]}));
});
afterEach(()=>{setState(()=>initial);vi.unstubAllGlobals();});

describe('R132 thread status latency',()=>{
  it('uses the already confirmed pool status before any thread detail is available',()=>{
    expect(getState().threadTasks.t).toBeUndefined();
    expect(threadExecutionStatusOf(getState(),'t')?.waitingForUser?.message).toBe('请确认选项');
  });
  it('prefers newer pool facts to old task detail and removes a superseded waiting state',()=>{
    setState(s=>({...s,threadTasks:{t:{...taskData(status(1)).task,id:'task',title:'old',status:'WAITING_USER',roomId:'r',threadId:'t',roomTaskNumber:1,revision:1,stopGeneration:0,activeRun:null,pendingDelivery:null,reworkPending:null,executionStatus:status(1)}}}));
    const done=status(3,'COMPLETED');
    setState(s=>({...s,roomPool:{r:[{...s.roomPool.r![0]!,executionStatus:done}]}}));
    expect(threadExecutionStatusOf(getState(),'t')).toBe(done);
  });
  it('does not borrow another project, task, or a stale task for a confirmed record-only thread',()=>{
    setState(s=>({...s,activeProjectId:'other'}));expect(threadExecutionStatusOf(getState(),'t')).toBeNull();
    setState(s=>({...s,activeProjectId:'p',threadEntities:{t:{...thread,rootTaskId:'another-task'}}}));expect(threadExecutionStatusOf(getState(),'t')).toBeNull();
    setState(s=>({...s,threadEntities:{t:{...thread,rootTaskId:undefined}}}));expect(threadExecutionStatusOf(getState(),'t')).toBeNull();
  });
  it.each(['slow','failed'])('hydrates task status independently of a %s history response',async mode=>{
    const history=gate();const calls:string[]=[];
    host(async method=>{calls.push(method);if(method==='thread.get')return{thread,anchor:null,lastReadSeq:0};if(method==='task.get')return taskData();
      if(method==='thread.history'){await history.promise;if(mode==='failed')throw Error('history unavailable');return{items:[],rootAttachments:[]};}throw Error(method);});
    const loading=loadThread('t');
    await vi.waitFor(()=>expect(getState().threadTasks.t?.status).toBe('WAITING_USER'));
    expect(calls.indexOf('task.get')).toBeLessThan(calls.indexOf('thread.history'));
    expect(threadExecutionStatusOf(getState(),'t')?.phase).toBe('WAITING_FOR_USER');
    expect(getState().tasks.find(t=>t.id==='task')?.status).toBe('WAITING_USER');
    history.release(null);await loading;
    expect(getState().threadTasks.t?.status).toBe('WAITING_USER');
    if(mode==='failed')expect(getState().readErrors['thread:t']).toBe('history unavailable');
  });
  it('history is still readable when the independent task query fails',async()=>{
    host(async method=>{if(method==='thread.get')return{thread,anchor:null,lastReadSeq:0};if(method==='task.get')throw Error('task unavailable');
      return{items:[{id:'reply',authorType:'agent',authorId:'m',seq:1,body:{text:'现有答复'},createdAt:1}],rootAttachments:[]};});
    await loadThread('t');
    expect(getState().threadMessages.t?.[0]?.body).toBe('现有答复');
    expect(threadExecutionStatusOf(getState(),'t')?.phase).toBe('WAITING_FOR_USER');
    expect(getState().readErrors['thread:t']).toBe('task unavailable');
  });
  it('rejects a task response from a thread load superseded by a newer load',async()=>{
    const old=gate();let reads=0;
    host(async method=>{if(method==='thread.get')return{thread,anchor:null,lastReadSeq:0};if(method==='thread.history')return{items:[],rootAttachments:[]};
      if(++reads===1)return await old.promise;return taskData(status(4,'COMPLETED'));});
    const first=loadThread('t');await vi.waitFor(()=>expect(reads).toBe(1));
    await loadThread('t');old.release(taskData(status(3)));await first;
    expect(getState().threadTasks.t?.status).toBe('DONE');
  });
});
