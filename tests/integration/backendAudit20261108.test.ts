import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { TurnRequest } from '../../src/contracts/runtime.ts';

const cleanup: Array<() => Promise<void>> = [];
const facts: Array<Record<string, unknown>> = [];
afterAll(() => {
  mkdirSync('dist/backend-audit-20261108', {recursive:true});
  writeFileSync('dist/backend-audit-20261108/facts-after-fix.json',JSON.stringify(facts,null,2));
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
interface CommandData {
  project:{id:string};room:{id:string;conversationId:string};memberId:string;taskId:string;threadId:string;
  messageId:string;threadMessageSeq:number;attachmentId:string;conversationId:string;conversation?:{id:string};members:{version:string};
}
interface TaskSnapshot {status:string;revision:number;stop_generation:number}
function png(pixel=255) {
  const chunk = (tag: string, data: Buffer) => {
    const type = Buffer.from(tag), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0);
    return Buffer.concat([len, type, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',zlib.deflateSync(Buffer.from([0,pixel]))),chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(memberCount=2) {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake'); vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY', '0');
  const dir = mkdtempSync(join(tmpdir(), 'zs-backend-audit-')), projectPath = join(dir, 'project'); mkdirSync(projectPath);
  const db = openDatabase(join(dir, 'state.sqlite'));
  let stall = false;
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: input => stall
    ? [{kind:'stall',ms:60_000}]
    : [{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify(input.text.includes('analysis-draft-v1')
      ? {schemaVersion:'analysis-draft-v1',summary:'audit answer',document:null,completion:{disposition:'conversation',reason:'answer'},claims:[],recommendations:[],openQuestions:[]}
      : {schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer:'audit answer',changeSummary:'audit answer',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}] });
  const inputs: TurnRequest[] = [], start = adapter.startTurn.bind(adapter);
  adapter.startTurn = async (session, input) => { inputs.push(input); await start(session,input); };
  const worker = new DispatchWorker({db,adapter,leaseOwner:'audit',appDataDir:dir,enableDeliberate:true});
  cleanup.push(async () => { await adapter.closeAllSessions(); expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0}); db.close(); rmSync(dir,{recursive:true,force:true}); });
  const raw = (method: string, params: unknown) => dispatchDaemonCommand({db,appDataDir:dir,localUserId:'u_local',interruptTurn:id=>worker.interruptTurn(id)},
    {protocolVersion:1,commandId:randomUUID(),method,params}) as Promise<{ok:boolean;data?:CommandData;error?:unknown}>;
  const cmd = async (method: string, params: unknown) => {const r=await raw(method,params); if(!r.ok||!r.data)throw Error(JSON.stringify(r));return r.data;};
  await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
  const {project}=await cmd('project.open',{path:projectPath,agentNames:[]});
  const members:string[]=[];
  for(const displayName of ['甲','乙','丙'].slice(0,memberCount)) {const {memberId}=await cmd('member.create',{projectId:project.id,displayName});await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'plan'});members.push(memberId);}
  const {room}=await cmd('room.create',{projectId:project.id,name:'audit',memberIds:members});
  const root = (body='first request',extra:Record<string,unknown>={})=>cmd('message.submit',{target:{kind:'room_root',projectId:project.id,conversationId:room.conversationId,roomId:room.id},body,intent:'default',mentions:[{kind:'member',memberId:members[0]}],...extra});
  const follow=(threadId:string,body:string,extra:Record<string,unknown>={})=>cmd('message.submit',{target:{kind:'thread',projectId:project.id,conversationId:room.conversationId,threadId},body,intent:'default',mentions:[],...extra});
  const state=(taskId:string)=>db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(taskId) as TaskSnapshot;
  const stop=async(taskId:string)=>{
    stall=true;const work=worker.drain();
    await vi.waitFor(()=>expect((db.prepare("SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND a.status='RUNNING'").get(taskId) as {n:number}).n).toBeGreaterThan(0));
    const run=db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {id:string};
    await cmd('task.stop',{taskId,targetRunId:run.id,expectedStopGeneration:state(taskId).stop_generation});await work;
    expect(state(taskId).status).toBe('CANCELLED');stall=false;
  };
  return {dir,db,adapter,worker,inputs,cmd,raw,root,follow,project,room,members,state,stop,setStall:(value:boolean)=>{stall=value;}};
}

describe('Backend audit adversarial checks (zero real models)',()=>{
  it('root dispatch must not consume a later queued request attachment',async()=>{
    const f=await fixture();
    const own=await f.cmd('attachment.uploadImage',{conversationId:f.room.conversationId,filename:'root.png',contentBase64:png().toString('base64')});
    const first=await f.root('first request',{attachmentRefs:[own.attachmentId]});
    const up=await f.cmd('attachment.uploadText',{conversationId:f.room.conversationId,filename:'future.txt',content:'FUTURE_REQUEST_PRIVATE_CONTENT'});
    const futureImage=await f.cmd('attachment.uploadImage',{conversationId:f.room.conversationId,filename:'future.png',contentBase64:png(64).toString('base64')});
    await f.follow(first.threadId,'second request for the other member',{mentions:[{kind:'member',memberId:f.members[1]}],attachmentRefs:[up.attachmentId,futureImage.attachmentId]});
    await f.worker.runOnce();
    expect(f.inputs.length).toBeGreaterThan(0);
    const futureAttachmentIncluded=f.inputs[0]!.text.includes('FUTURE_REQUEST_PRIVATE_CONTENT');
    facts.push({case:'root-future-attachment',futureAttachmentIncluded,stage:f.inputs[0]!.stage});
    expect(futureAttachmentIncluded,'a later queued attachment reached the initial request').toBe(false);
    expect(f.inputs[0]!.text).not.toContain('second request for the other member');
    expect(f.inputs[0]!.images?.map(image=>image.artifactId)).toEqual([own.attachmentId]);
    await f.worker.runOnce();
    expect(f.inputs[1]!.text).toContain('FUTURE_REQUEST_PRIVATE_CONTENT');
    expect(f.inputs[1]!.images?.some(image=>image.artifactId===futureImage.attachmentId)).toBe(true);
  });

  it('the confirmed send-all-images policy includes historical omit images in subsequent DM inputs',async()=>{
    const f=await fixture(), dm=await f.cmd('conversation.create',{projectId:f.project.id,peerMemberId:f.members[0]});
    const conversationId=dm.conversationId??dm.conversation?.id;
    const up=await f.cmd('attachment.uploadImage',{conversationId,filename:'previously-withheld.png',contentBase64:png().toString('base64')});
    const sent=await f.cmd('message.submit',{target:{kind:'dm',projectId:f.project.id,conversationId},body:'text only',intent:'default',mentions:[],attachmentRefs:[up.attachmentId]});
    // Valid persisted state from versions before R194, without altering any user data.
    f.db.prepare("UPDATE messages SET body_json=json_set(body_json,'$.imageInput','omit') WHERE id=?").run(sent.messageId);
    await f.worker.runOnce();
    await f.cmd('message.submit',{target:{kind:'dm',projectId:f.project.id,conversationId},body:'unrelated next question',intent:'default',mentions:[]});
    await f.worker.runOnce();
    expect(f.inputs).toHaveLength(2);
    facts.push({case:'historical-omit',persistedChoice:'omit',imagesSentWithNextMessage:(f.inputs[1]!.images??[]).length,
      oldArtifactSent:f.inputs[1]!.images?.some(image=>image.artifactId===up.attachmentId)===true});
    expect(f.inputs[1]!.images??[]).toHaveLength(1);
    expect(f.inputs[1]!.images![0]!.artifactId).toBe(up.attachmentId);
  });

  it('a queued DELIBERATE request must not consume attachments from a later request',async()=>{
    const f=await fixture(), first=await f.root(); await f.worker.runOnce();
    const detail=await f.cmd('thread.get',{threadId:first.threadId});
    await f.cmd('thread.members.change',{projectId:f.project.id,threadId:first.threadId,memberId:f.members[1],action:'add',expectedVersion:detail.members.version});
    const before=f.inputs.length;
    const own=await f.cmd('attachment.uploadText',{conversationId:f.room.conversationId,filename:'discussion.txt',content:'OWN_DELIBERATION_MATERIAL'});
    const ownImage=await f.cmd('attachment.uploadImage',{conversationId:f.room.conversationId,filename:'discussion.png',contentBase64:png().toString('base64')});
    await f.follow(first.threadId,'independent discussion',{collaboration:'deliberate',attachmentRefs:[own.attachmentId,ownImage.attachmentId]});
    const up=await f.cmd('attachment.uploadText',{conversationId:f.room.conversationId,filename:'after-deliberation.txt',content:'AFTER_DELIBERATION_REQUEST_SECRET'});
    const futureImage=await f.cmd('attachment.uploadImage',{conversationId:f.room.conversationId,filename:'future-discussion.png',contentBase64:png(64).toString('base64')});
    await f.follow(first.threadId,'later separate work',{mentions:[{kind:'member',memberId:f.members[1]}],attachmentRefs:[up.attachmentId,futureImage.attachmentId]});
    for(let i=0;i<4&&f.inputs.length===before;i++)await f.worker.runOnce();
    const independent=f.inputs.slice(before).filter(input=>input.text.includes('analysis-draft-v1'));
    expect(independent.length).toBeGreaterThan(0);
    const futureAttachmentIncluded=independent[0]!.text.includes('AFTER_DELIBERATION_REQUEST_SECRET');
    facts.push({case:'deliberate-future-attachment',futureAttachmentIncluded,stage:independent[0]!.stage});
    expect(futureAttachmentIncluded,'a later queued attachment reached an earlier INDEPENDENT stage').toBe(false);
    expect(independent[0]!.text).toContain('OWN_DELIBERATION_MATERIAL');
    expect(independent[0]!.images?.map(image=>image.artifactId)).toEqual([ownImage.attachmentId]);
  });

  it('a stopped DM can be explicitly continued through its formal action',async()=>{
    const f=await fixture(), dm=await f.cmd('conversation.create',{projectId:f.project.id,peerMemberId:f.members[0]});
    const conversationId=dm.conversationId??dm.conversation?.id;
    const sent=await f.cmd('message.submit',{target:{kind:'dm',projectId:f.project.id,conversationId},body:'dm work',intent:'default',mentions:[]});
    f.setStall(true);const draining=f.worker.drain();
    await vi.waitFor(()=>expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='RUNNING'").get()).toEqual({n:1}));
    const state=()=>f.db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(sent.taskId) as TaskSnapshot;
    const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(sent.taskId) as {id:string};
    await f.cmd('task.stop',{taskId:sent.taskId,targetRunId:run.id,expectedStopGeneration:state().stop_generation});await draining;
    expect(state().status).toBe('CANCELLED');
    const stopped=state();f.setStall(false);
    const resumed=await f.raw('task.continue',{taskId:sent.taskId,expectedTaskRevision:stopped.revision,expectedStopGeneration:stopped.stop_generation});
    expect(resumed).toMatchObject({ok:true});
    await f.worker.drain();facts.push({case:'stopped-dm-control',status:state().status});expect(state().status).toBe('DONE');
  });

  it.each(['action','message'] as const)('Continue via %s after stopping an explicit reply to B preserves B and ignores unstarted queued work',async via=>{
    const f=await fixture(), first=await f.root();await f.worker.runOnce();
    const detail=await f.cmd('thread.get',{threadId:first.threadId});
    await f.cmd('thread.members.change',{projectId:f.project.id,threadId:first.threadId,memberId:f.members[1],action:'add',expectedVersion:detail.members.version});
    await f.follow(first.threadId,'B please perform this follow-up',{mentions:[{kind:'member',memberId:f.members[1]}]});
    f.setStall(true);const draining=f.worker.drain();
    await vi.waitFor(()=>expect(f.db.prepare("SELECT member_id FROM agent_turns WHERE status='RUNNING'").get()).toEqual({member_id:f.members[1]}));
    const state=()=>f.db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(first.taskId) as TaskSnapshot;
    const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(first.taskId) as {id:string};
    await f.follow(first.threadId,'later unstarted request for A',{mentions:[{kind:'member',memberId:f.members[0]}]});
    await f.cmd('task.stop',{taskId:first.taskId,targetRunId:run.id,expectedStopGeneration:state().stop_generation});await draining;
    const stopped=state();expect(stopped.status).toBe('CANCELLED');f.setStall(false);
    if(via==='action')await f.cmd('task.continue',{taskId:first.taskId,expectedTaskRevision:stopped.revision,expectedStopGeneration:stopped.stop_generation});
    else await f.follow(first.threadId,'继续');
    const next=f.db.prepare("SELECT member_id,route_json FROM thread_reply_requests WHERE status='queued' ORDER BY rowid DESC LIMIT 1").get() as {member_id:string;route_json:string};
    facts.push({case:'stopped-member-continuation',stoppedMember:'B',nextMember:next.member_id===f.members[0]?'A':next.member_id===f.members[1]?'B':'other',
      originalMode:'DIRECT',nextMode:(JSON.parse(next.route_json) as {mode:string}).mode});
    expect(next.member_id).toBe(f.members[1]);
    expect(JSON.parse(next.route_json)).toMatchObject({mode:'DIRECT',targetMemberId:f.members[1]});
  });

  it.each(['action','message'] as const)('Continue via %s does not expand a stopped two-member DELIBERATE selection to all three members',async via=>{
    const f=await fixture(3),first=await f.root();await f.worker.runOnce();
    for(const memberId of f.members.slice(1)){
      const detail=await f.cmd('thread.get',{threadId:first.threadId});
      await f.cmd('thread.members.change',{projectId:f.project.id,threadId:first.threadId,memberId,action:'add',expectedVersion:detail.members.version});
    }
    await f.follow(first.threadId,'only B and C should discuss',{collaboration:'deliberate',mentions:f.members.slice(1).map(memberId=>({kind:'member',memberId}))});
    f.setStall(true);const draining=f.worker.drain();
    await vi.waitFor(()=>expect((f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='RUNNING'").get() as {n:number}).n).toBeGreaterThan(0));
    const state=()=>f.db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(first.taskId) as TaskSnapshot;
    const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(first.taskId) as {id:string};
    await f.cmd('task.stop',{taskId:first.taskId,targetRunId:run.id,expectedStopGeneration:state().stop_generation});await draining;
    const stopped=state();expect(stopped.status).toBe('CANCELLED');f.setStall(false);
    if(via==='action')await f.cmd('task.continue',{taskId:first.taskId,expectedTaskRevision:stopped.revision,expectedStopGeneration:stopped.stop_generation});
    else await f.follow(first.threadId,'继续');
    const next=f.db.prepare("SELECT route_json FROM thread_reply_requests WHERE status='queued' ORDER BY rowid DESC LIMIT 1").get() as {route_json:string};
    const members=(JSON.parse(next.route_json) as {frozenMemberIds:string[]}).frozenMemberIds;
    facts.push({case:'stopped-deliberate-selection',originalMembers:['B','C'],nextMembers:members.map(id=>['A','B','C'][f.members.indexOf(id)])});
    expect([...members].sort()).toEqual(f.members.slice(1).sort());
  });

  it.each(['disabled','removed'] as const)('unavailable stopped member (%s) rejects both Continue paths atomically and allows an explicit new selection',async unavailable=>{
    const f=await fixture(),first=await f.root();await f.worker.runOnce();
    await f.follow(first.threadId,'only B',{mentions:[{kind:'member',memberId:f.members[1]}]});await f.stop(first.taskId);
    if(unavailable==='disabled')f.db.prepare('UPDATE project_members SET enabled=0 WHERE id=?').run(f.members[1]);
    else {
      const detail=await f.cmd('thread.get',{threadId:first.threadId});
      await f.cmd('thread.members.change',{projectId:f.project.id,threadId:first.threadId,memberId:f.members[1],action:'remove',expectedVersion:detail.members.version});
    }
    const stopped=f.state(first.taskId),count=f.db.prepare('SELECT count(*) n FROM messages').get();
    expect(await f.raw('task.continue',{taskId:first.taskId,expectedTaskRevision:stopped.revision,expectedStopGeneration:stopped.stop_generation}))
      .toMatchObject({ok:false,error:{code:'MEMBER_UNAVAILABLE'}});
    expect(await f.raw('message.submit',{target:{kind:'thread',projectId:f.project.id,conversationId:f.room.conversationId,threadId:first.threadId},body:'继续',intent:'default',mentions:[]}))
      .toMatchObject({ok:false,error:{code:'MEMBER_UNAVAILABLE'}});
    expect(f.state(first.taskId)).toEqual(stopped);expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual(count);
    await f.follow(first.threadId,'now A instead',{mentions:[{kind:'member',memberId:f.members[0]}]});
    expect(f.db.prepare("SELECT member_id FROM thread_reply_requests WHERE status='queued' ORDER BY rowid DESC LIMIT 1").get()).toEqual({member_id:f.members[0]});
  });
});
