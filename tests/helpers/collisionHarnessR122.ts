import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {DispatchAdmission,type AdmissionDimensions} from '../../src/daemon/admission.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeAdapterOptions} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import type {NormalizedRuntimeEvent,OpenSessionInput,SessionRef,TurnRequest} from '../../src/contracts/runtime.ts';

export const evidenceRoot=resolve('dist/r122-collisions');
mkdirSync(evidenceRoot,{recursive:true});
export const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export const finish=(text:string,ms=20):FakeTurnScript=>[
  {kind:'stall',ms},
  {kind:'event',event:{kind:'message.completed',messageId:randomUUID(),text}},
  {kind:'event',event:{kind:'turn.completed',finalText:text}},
];

export class ObservedAdapter extends FakeRuntimeAdapter {
  readonly sessionsSeen=new Map<string,OpenSessionInput>();
  readonly turns:Array<{turnId:string;sessionId:string;memberId:string;taskId:string;text:string;at:number}>=[];
  readonly active=new Map<string,OpenSessionInput>();
  peak=0;
  peakMember=0;
  peakWritableRoot=0;
  onStart?: (session:SessionRef,input:TurnRequest,scope:OpenSessionInput)=>void|Promise<void>;
  constructor(options:FakeAdapterOptions={}){super(options);}
  override async openSession(input:OpenSessionInput){
    const session=await super.openSession(input);this.sessionsSeen.set(session.id,input);return session;
  }
  override async startTurn(session:SessionRef,input:TurnRequest){
    const scope=this.sessionsSeen.get(session.id)!;
    this.turns.push({turnId:input.turnId,sessionId:session.id,memberId:scope.memberId,taskId:scope.taskId,text:input.text,at:Date.now()});
    this.active.set(input.turnId,scope);this.peak=Math.max(this.peak,this.active.size);
    this.peakMember=Math.max(this.peakMember,[...this.active.values()].filter(s=>s.memberId===scope.memberId).length);
    if(scope.writeAccess?.modificationAuthorized)this.peakWritableRoot=Math.max(this.peakWritableRoot,[...this.active.values()].filter(s=>s.writeAccess?.modificationAuthorized&&s.cwd===scope.cwd).length);
    try{await this.onStart?.(session,input,scope);await super.startTurn(session,input);}catch(error){this.active.delete(input.turnId);throw error;}
  }
  override events(session:SessionRef):AsyncIterable<NormalizedRuntimeEvent>{
    const original=super.events(session),active=this.active;
    return{async *[Symbol.asyncIterator](){for await(const event of original){if(event.turnId&&(event.kind==='turn.completed'||event.kind==='turn.failed'))active.delete(event.turnId);yield event;}}};
  }
}

/** Experiment only: replace the role mutex with distinct execution slots.
 * The production worker, project/provider limits and physical write leases remain. */
export class SessionAdmissionExperiment extends DispatchAdmission {
  override tryAcquire(turnId:string,dims:AdmissionDimensions){return super.tryAcquire(turnId,{...dims,memberId:`${dims.memberId}:${turnId}`});}
}

export async function collisionFixture(label:string,options:{projects?:number;members?:number;rooms?:number;writable?:boolean;isolatedGit?:boolean;adapter?:ObservedAdapter;admission?:DispatchAdmission;automaticRecovery?:boolean}={}){
  const dir=mkdtempSync(join(evidenceRoot,label+'-'));
  const db=openDatabase(join(dir,'state.sqlite'));
  const adapter=options.adapter??new ObservedAdapter({turnScriptSequencer:({text})=>finish(/TOKEN_[A-Za-z0-9_]+/.exec(text)?.[0]??'finished')});
  const admission=options.admission??new DispatchAdmission();
  const worker=new DispatchWorker({db,adapter,admission,leaseOwner:randomUUID(),appDataDir:dir,detachedTurnConsumption:true,interruptGraceMs:60,automaticRecovery:options.automaticRecovery??false});
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:(id:string)=>worker.interruptTurn(id),releaseAdmission:(id:string)=>{admission.release(id);}};
  const raw=async(method:string,params:unknown,commandId:string=randomUUID())=>await dispatchDaemonCommand(deps,{protocolVersion:1,commandId,method,params}) as {ok:boolean;data?:unknown;error?:{code:string;message:string;operationPending?:boolean}};
  const cmd=async<T>(method:string,params:unknown,commandId?:string):Promise<T>=>{const result=await raw(method,params,commandId);if(!result.ok)throw Error(JSON.stringify(result.error));return result.data as T;};
  await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
  const projects:Array<{id:string;path:string;members:string[];rooms:Array<{id:string;conversationId:string}>}>=[];
  for(let p=0;p<(options.projects??1);p++){
    const path=join(dir,`project-${p}`);mkdirSync(path);
    if(options.isolatedGit)execFileSync('git',['init','--quiet',path],{windowsHide:true});
    const {project}=await cmd<{project:{id:string}}>('project.open',{path});
    const members:string[]=[];
    for(let m=0;m<(options.members??3);m++){
      const {memberId}=await cmd<{memberId:string}>('member.create',{projectId:project.id,displayName:`角色-${m}`});
      await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:options.writable?'bypassPermissions':'plan'});members.push(memberId);
    }
    const rooms=[];
    for(let r=0;r<(options.rooms??3);r++){
      const {room}=await cmd<{room:{id:string;conversationId:string}}>('room.create',{projectId:project.id,name:`房间-${r}`,memberIds:members});rooms.push(room);
    }
    projects.push({id:project.id,path,members,rooms});
  }
  const send=(p:number,r:number,memberIndexes:number[],body:string,commandId?:string)=>cmd<{taskId:string;threadId:string;messageId:string}>('message.submit',{
    target:{kind:'room_root',projectId:projects[p]!.id,roomId:projects[p]!.rooms[r]!.id,conversationId:projects[p]!.rooms[r]!.conversationId},
    body,intent:'default',mentions:memberIndexes.map(i=>({kind:'member',memberId:projects[p]!.members[i]})),
  },commandId);
  const taskStatus=(id:string)=>(db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as {status:string}).status;
  const count=(sql:string,...params:unknown[])=>(db.prepare(sql).get(...params) as {n:number}).n;
  const pumpUntil=async(predicate:()=>boolean,timeoutMs=15000)=>{
    const start=Date.now();
    do{
      await worker.drain();
      if(predicate())return;
      await pause(5);
    }while(Date.now()-start<timeoutMs);
    throw Error('collision timeout '+JSON.stringify({tasks:db.prepare('SELECT status,count(*) n FROM tasks GROUP BY status').all(),outbox:db.prepare('SELECT status,count(*) n FROM outbox GROUP BY status').all(),events:db.prepare("SELECT kind,payload_json FROM domain_events WHERE kind LIKE '%Failed' OR kind LIKE '%Blocked' ORDER BY seq DESC LIMIT 4").all()}));
  };
  const save=(facts:Record<string,unknown>)=>writeFileSync(join(dir,'result.json'),JSON.stringify({label,dir,...facts,realCalls:count('SELECT count(*) n FROM real_calls')},null,2));
  const close=async()=>{await adapter.closeAllSessions();await worker.awaitInFlightTurns(3000);db.close();};
  return{dir,db,adapter,admission,worker,raw,cmd,projects,send,taskStatus,count,pumpUntil,save,close};
}
