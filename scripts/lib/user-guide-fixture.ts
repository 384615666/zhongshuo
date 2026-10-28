/** Isolated, synthetic examples used to photograph the real product for its manual. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {localUserId} from '../../src/contracts/daemonIpc.ts';

const [dir,project]=process.argv.slice(2);
if(!dir||!project)throw Error('Expected isolated data and project directories');
mkdirSync(dir,{recursive:true});mkdirSync(project,{recursive:true});
process.env.ZS_RUNTIME='fake';process.env.ZS_ALLOW_FAKE='1';process.env.ZS_REAL_DISPATCH_GUARD='1';
const activity='# 读书会活动安排\n\n## 活动信息\n- 主题：分享一本最近喜欢的书\n- 时间：周六下午 2 点\n- 参与人数：10 人\n\n## 三步准备清单\n1. 周三前：确定书单，发出报名通知。\n2. 周五前：收齐分享题目，确认座位和投影。\n3. 周六下午：提前半小时布置，会后整理分享记录。\n';
writeFileSync(join(project,'活动资料.md'),'# 读书会原始资料\n周六下午2点，预计10人。每人分享一本书，时间5分钟。请整理活动安排。\n');
writeFileSync(join(project,'活动安排.md'),activity);
for(const args of [['init','--initial-branch=main'],['add','.'],['-c','user.name=教程示例','-c','user.email=guide@example.invalid','commit','-m','添加活动资料']]){
  const git=spawnSync('git',args,{cwd:project,encoding:'utf8',windowsHide:true});
  if(git.status!==0)throw Error(git.stderr);
}
const db=openDatabase(join(dir,'state.sqlite'));
const guideUser=localUserId();
let script:FakeTurnScript=[];
const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>script});
const worker=new DispatchWorker({db,adapter,leaseOwner:'user-guide-fixture',appDataDir:dir});
const command=async<T>(method:string,params:unknown):Promise<T>=>{
  const result=await dispatchDaemonCommand({db,appDataDir:dir,localUserId:guideUser,interruptTurn:id=>worker.interruptTurn(id)},
    {protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error?:unknown};
  if(!result.ok)throw Error(`${method}: ${JSON.stringify(result.error)}`);return result.data;
};
const output=(answer:string,document?:{filename:string;markdown:string},userQuestion?:string):FakeTurnScript=>[
  {kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'example',answer,changeSummary:answer,
    responseKind:document?'work':'conversation',userQuestion:userQuestion??null,document:document?{...document,purpose:'读书会活动准备与当天流程'}:null,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}},
];
async function main(){
  const {project:{id:projectId}}=await command<{project:{id:string}}>('project.open',{path:project});
  db.prepare("UPDATE project_members SET enabled=0 WHERE project_id=? AND principal_type='agent'").run(projectId);
  const {memberId:claude}=await command<{memberId:string}>('member.create',{projectId,displayName:'Claude'});
  const {memberId:codex}=await command<{memberId:string}>('member.create',{projectId,displayName:'Codex'});
  for(const memberId of [claude,codex])await command('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  const room=(await command<{items:{id:string;conversationId:string;revision:number}[]}>('room.list',{projectId})).items[0]!;
  const revision=(db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
  await command('room.update',{roomId:room.id,expectedRevision:revision,name:'活动筹备',coordinatorMemberId:claude});
  const room2=await command<{room:{id:string}}>('room.create',{projectId,name:'资料整理',memberIds:[claude,codex]});
  const uploaded=await command<{attachmentId:string}>('attachment.uploadText',{conversationId:room.conversationId,filename:'活动资料.md',content:'# 活动资料\n周六下午2点，10人，每人分享一本书。请整理活动安排。'});
  const send=async(body:string,answer:string,document?:{filename:string;markdown:string},attachments:string[]=[])=>{
    script=output(answer,document);
    const sent=await command<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body,intent:'default',mentions:[{kind:'member',memberId:claude}],attachmentRefs:attachments});
    await worker.drain();return sent;
  };
  const chat=await send('请把这次读书会的准备工作整理成三步清单。','可以分成三步：\n\n1. **确定内容**：周三前收集分享书目，发出报名通知。\n2. **准备场地**：周五前确认人数、座位和投影。\n3. **组织活动**：周六提前半小时布置，会后整理分享记录。');
  const work=await send('请根据附件整理一份活动安排，生成文档。','活动安排已经整理好了。包含活动信息、准备清单和当天流程，可以打开下面的文档查看。',{filename:'读书会活动安排.md',markdown:activity},[uploaded.attachmentId]);
  const {conversationId:dm}=await command<{conversationId:string}>('conversation.create',{projectId,peerMemberId:codex,title:'邀请文案'});
  script=output('可以这样写：\n\n周六下午2点，来参加我们的读书会吧！带上一本喜欢的书，用5分钟分享打动你的故事。欢迎一起交流。');
  await command('message.submit',{target:{kind:'dm',projectId,conversationId:dm},body:'帮我写一段简短的读书会邀请文案。',intent:'default',mentions:[]});
  await worker.drain();
  const delivery=(db.prepare('SELECT current_delivery_id FROM tasks WHERE id=?').get(work.taskId) as {current_delivery_id:string|null}).current_delivery_id;
  if(delivery){db.prepare("UPDATE tasks SET status='REVIEW',review_policy='user_review' WHERE id=?").run(work.taskId);db.prepare("UPDATE task_deliveries SET review_status='pending' WHERE id=?").run(delivery);}
  script=output('座位安排和阅读流程已整理好。茶点费用需要你决定后再安排。',undefined,'是否准备茶点？建议只提供饮用水，节省预算。');
  const question=await command<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请安排读书会场地和茶点，费用由我确认。',intent:'default',mentions:[{kind:'member',memberId:claude}]});
  await worker.drain();
  const meta={projectId,roomId:room.id,conversationId:room.conversationId,otherRoomId:room2.room.id,claude,codex,chat,work,question,dm,attachmentId:uploaded.attachmentId,delivery};
  writeFileSync(join(dir,'guide-fixture.json'),JSON.stringify(meta,null,2));
  console.log(JSON.stringify(meta));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.close());
