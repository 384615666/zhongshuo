/** R170 截图专用夹具：在 homepage-fixture 基础上让一次 AI 回合**真的写一个项目文件**，
 *  这样对话串里会出现带真实项目相对路径的「文件改动」卡片（打开方式 / 查看变更 / 绝对路径
 *  三个反馈点都需要这种真实数据，不能靠内存伪造）。 */
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
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
for(const args of [['init','--initial-branch=main'],['add','.'],['-c','user.name=官网示例','-c','user.email=homepage@example.invalid','commit','-m','添加活动资料']]){
  const git=spawnSync('git',args,{cwd:project,encoding:'utf8',windowsHide:true});
  if(git.status!==0)throw Error(git.stderr);
}
const db=openDatabase(join(dir,'state.sqlite'));
const homepageUser=localUserId();
let script:FakeTurnScript=[];
const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>script});
const worker=new DispatchWorker({db,adapter,leaseOwner:'r170-fixture',appDataDir:dir});
const command=async<T>(method:string,params:unknown):Promise<T>=>{
  const result=await dispatchDaemonCommand({db,appDataDir:dir,localUserId:homepageUser,interruptTurn:id=>worker.interruptTurn(id)},
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
  const placeholderId=`m_default_${projectId}_0`;
  db.prepare('UPDATE rooms SET coordinator_member_id=?, revision=revision+1 WHERE project_id=? AND coordinator_member_id=?').run(claude,projectId,placeholderId);
  db.prepare('DELETE FROM room_members WHERE member_id=?').run(placeholderId);
  db.prepare('DELETE FROM project_members WHERE id=? AND project_id=?').run(placeholderId,projectId);
  const uploaded=await command<{attachmentId:string}>('attachment.uploadText',{conversationId:room.conversationId,filename:'活动资料.md',content:'# 活动资料\n周六下午2点，10人，每人分享一本书。请整理活动安排。'});
  const send=async(body:string,answer:string,document?:{filename:string;markdown:string},attachments:string[]=[],write?:{path:string;content:string})=>{
    script=write==null?output(answer,document):[{kind:'writeFile',path:write.path,content:write.content},...output(answer,document)] as FakeTurnScript;
    const sent=await command<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body,intent:'default',mentions:[{kind:'member',memberId:claude}],attachmentRefs:attachments});
    await worker.drain();return sent;
  };
  const chat=await send('请把这次读书会的准备工作整理成三步清单。','可以分成三步：\n\n1. **确定内容**：周三前收集分享书目，发出报名通知。\n2. **准备场地**：周五前确认人数、座位和投影。\n3. **组织活动**：周六提前半小时布置，会后整理分享记录。');
  const work=await send('请根据附件整理一份活动安排，生成文档。','活动安排已经整理好了。包含活动信息、准备清单和当天流程，可以打开下面的文档查看。',{filename:'读书会活动安排.md',markdown:activity},[uploaded.attachmentId],
    {path:'活动安排.md',content:'# 读书会活动安排\n\n## 活动信息\n- 主题：分享一本最近喜欢的书\n- 时间：周六下午 2 点（14:00）\n- 参与人数：10 人\n\n## 三步准备清单\n1. 周三前：确定书单，发出报名通知。\n2. 周五前：收齐分享题目，确认座位和投影。\n3. 周六下午：提前半小时布置，会后整理分享记录。\n\n## 当天流程\n14:00 开场与自我介绍；14:15 每人 5 分钟分享；15:30 自由讨论；16:00 合影与收尾。\n'});
  const {conversationId:dm}=await command<{conversationId:string}>('conversation.create',{projectId,peerMemberId:codex,title:'邀请文案'});
  script=output('可以这样写：\n\n周六下午2点，来参加我们的读书会吧！带上一本喜欢的书，用5分钟分享打动你的故事。欢迎一起交流。');
  await command('message.submit',{target:{kind:'dm',projectId,conversationId:dm},body:'帮我写一段简短的读书会邀请文案。',intent:'default',mentions:[]});
  await worker.drain();
  if(process.argv.includes('--r177')){
    // Legacy beta.25 envelope, only inside this script's freshly created DB.
    db.prepare("UPDATE conversations SET title='' WHERE id=?").run(dm);
    const rows=db.prepare("SELECT id,body_json FROM messages WHERE conversation_id=? AND author_type='agent'").all(dm) as Array<{id:string;body_json:string}>;
    for(const row of rows){
      const body=JSON.parse(row.body_json) as {text:string;runtimeControlResult:string};
      body.text=`\`\`\`json\n${body.runtimeControlResult}\n\`\`\`\n\n${body.text}\n\n\`\`\`json\n{"note":"普通业务 JSON，需保留"}\n\`\`\``;
      db.prepare('UPDATE messages SET body_json=? WHERE id=?').run(JSON.stringify(body),row.id);
    }
  }
  const delivery=(db.prepare('SELECT current_delivery_id FROM tasks WHERE id=?').get(work.taskId) as {current_delivery_id:string|null}).current_delivery_id;
  if(delivery){db.prepare("UPDATE tasks SET status='REVIEW',review_policy='user_review' WHERE id=?").run(work.taskId);db.prepare("UPDATE task_deliveries SET review_status='pending' WHERE id=?").run(delivery);}
  script=output('座位安排和阅读流程已整理好。茶点费用需要你决定后再安排。',undefined,'是否准备茶点？建议只提供饮用水，节省预算。');
  const question=await command<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请安排读书会场地和茶点，费用由我确认。',intent:'default',mentions:[{kind:'member',memberId:claude}]});
  await worker.drain();
  const room2Row=(await command<{items:{id:string;conversationId:string}[]}>('room.list',{projectId})).items.find(item=>item.id===room2.room.id)!;
  script=output('分享书目已经收齐，可以按主题分组整理。',undefined,'是否把分享书目按主题分组？');
  await command('message.submit',{target:{kind:'room_root',projectId,roomId:room2.room.id,conversationId:room2Row.conversationId},body:'把分享书目整理成清单，按主题分组。',intent:'default',mentions:[{kind:'member',memberId:codex}]});
  await worker.drain();
  script=output('活动照片已经按环节归档，共 24 张。');
  await command('message.submit',{target:{kind:'room_root',projectId,roomId:room2.room.id,conversationId:room2Row.conversationId},body:'整理活动照片，按环节归档。',intent:'default',mentions:[{kind:'member',memberId:claude}]});
  await worker.drain();
  // R192 截图夹具（仅 --r192：其余旧脚本的夹具数据保持原样）：真实图片附件 +
  // 可检索的收藏。图片用仓库根 logo.png（真实 PNG，走 attachment.uploadImage 的
  // magic bytes/尺寸校验），在会话池、回复串与私信三处各出现一次。
  if (process.argv.includes('--r192')) {
    const imageBase64 = readFileSync(join(process.cwd(), 'logo.png')).toString('base64');
    const roomImage = await command<{ attachmentId: string }>('attachment.uploadImage', {
      conversationId: room.conversationId, filename: 'image.png', contentBase64: imageBase64,
    });
    await command('message.submit', {
      target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
      body: '这张图请一起看一下。', intent: 'record_only', mentions: [], attachmentRefs: [roomImage.attachmentId],
    });
    await command('message.submit', {
      target: { kind: 'thread', projectId, conversationId: room.conversationId, threadId: chat.threadId },
      body: '回复里补一张图。', intent: 'record_only', mentions: [], attachmentRefs: [roomImage.attachmentId],
    });
    const dmImage = await command<{ attachmentId: string }>('attachment.uploadImage', {
      conversationId: dm, filename: '照片.png', contentBase64: imageBase64,
    });
    await command('message.submit', {
      target: { kind: 'dm', projectId, conversationId: dm },
      body: '私信里也发一张。', intent: 'record_only', mentions: [], attachmentRefs: [dmImage.attachmentId],
    });
    for (const title of ['读书会预算', '活动照片', '场地清单']) {
      await command('saved.add', { kind: 'link', ref: `https://example.com/${encodeURIComponent(title)}`, title, projectId });
    }
  }
  // R171：成员管理要验证「多项目独立卡片 / 切项目不联动侧栏 / 房间数不闪 0」——
  // 额外打开 3 个演示项目（各有房间与成员），全部为本机隔离夹具，不接触用户数据。
  const workspaceRoot = dirname(project);
  const extraProjects: string[] = [];
  const extras = [
    { name: '社区运营', rooms: ['周会', '内容排期'], members: ['Claude'] },
    { name: '产品手册', rooms: ['资料整理'], members: ['Codex'] },
    { name: '数据分析', rooms: ['看板'], members: ['Claude', 'Codex'] },
  ];
  for (const extra of extras) {
    const extraPath = join(workspaceRoot, extra.name);
    mkdirSync(extraPath, { recursive: true });
    writeFileSync(join(extraPath, '说明.md'), `# ${extra.name}\n\n演示用项目。\n`);
    const opened = await command<{ project: { id: string } }>('project.open', { path: extraPath });
    const extraProjectId = opened.project.id;
    const created: string[] = [];
    for (const displayName of extra.members) {
      const member = await command<{ memberId: string }>('member.create', { projectId: extraProjectId, displayName });
      created.push(member.memberId);
    }
    for (const memberId of created) await command('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
    const placeholderId = `m_default_${extraProjectId}_0`;
    db.prepare('UPDATE rooms SET coordinator_member_id=?, revision=revision+1 WHERE project_id=? AND coordinator_member_id=?').run(created[0], extraProjectId, placeholderId);
    db.prepare('DELETE FROM room_members WHERE member_id=?').run(placeholderId);
    db.prepare('DELETE FROM project_members WHERE id=? AND project_id=?').run(placeholderId, extraProjectId);
    const extraRooms = (await command<{ items: Array<{ id: string; revision: number }> }>('room.list', { projectId: extraProjectId })).items;
    for (let i = 0; i < extra.rooms.length; i++) {
      if (i === 0 && extraRooms[0] != null) {
        const revision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(extraRooms[0].id) as { revision: number }).revision;
        await command('room.update', { roomId: extraRooms[0].id, expectedRevision: revision, name: extra.rooms[0]!, coordinatorMemberId: created[0]! });
      } else {
        await command('room.create', { projectId: extraProjectId, name: extra.rooms[i]!, memberIds: created });
      }
    }
    extraProjects.push(extraProjectId);
  }
  const meta={projectId,roomId:room.id,conversationId:room.conversationId,otherRoomId:room2.room.id,claude,codex,chat,work,question,dm,attachmentId:uploaded.attachmentId,delivery,writtenFile:'活动安排.md',extraProjectIds:extraProjects};
  writeFileSync(join(dir,'guide-fixture.json'),JSON.stringify(meta,null,2));
  console.log(JSON.stringify(meta));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.close());
