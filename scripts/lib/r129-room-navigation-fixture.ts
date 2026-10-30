/** R129 synthetic projects only. Never opens a pre-existing application database. */
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {localUserId} from '../../src/contracts/daemonIpc.ts';

const [mode,dirArg,projectArg]=process.argv.slice(2);
if(!dirArg)throw Error('Expected seed/snapshot and an isolated data directory');
const dir=resolve(dirArg);
if(resolve(process.env.ZS_APP_DATA??'')!==dir||process.env.ZS_ALLOW_FAKE!=='1'||process.env.ZS_REAL_DISPATCH_GUARD!=='1'||process.env.ZS_RUNTIME!=='fake')throw Error('Explicit isolated Fake environment required');
type Room={id:string;name:string;conversationId:string;revision:number};
type Project={id:string;name:string;rootPath:string;memberId:string;rooms:Room[]};

function snapshot(){
  const meta=JSON.parse(readFileSync(join(dir,'fixture.json'),'utf8')) as {projects:Project[]};
  const db=new Database(join(dir,'state.sqlite'),{readonly:true,fileMustExist:true});
  const count=(table:string)=>(db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n;
  try{return {
    projects:meta.projects.map(p=>({id:p.id,name:p.name,rooms:db.prepare('SELECT id,project_id,name,revision,archived_at FROM rooms WHERE project_id=? ORDER BY id').all(p.id)})),
    navigation:db.prepare('SELECT * FROM navigation_preferences').all(),
    realCalls:count('real_calls'),tasks:count('tasks'),runs:count('workflow_runs'),turns:count('agent_turns'),messages:count('messages'),
  };}finally{db.close();}
}

async function seed(){
  if(!projectArg||existsSync(join(dir,'state.sqlite')))throw Error('A new data root and synthetic project root are required');
  const projectsRoot=resolve(projectArg);
  if(resolve(projectsRoot,'..')!==resolve(dir,'..'))throw Error('Synthetic projects must be siblings of isolated data');
  mkdirSync(dir,{recursive:true});mkdirSync(projectsRoot,{recursive:true});
  const db=openDatabase(join(dir,'state.sqlite'));
  const cmd=async<T>(method:string,params:unknown):Promise<T>=>{
    const result=await dispatchDaemonCommand({db,appDataDir:dir,localUserId:localUserId()},
      {protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error?:unknown};
    if(!result.ok)throw Error(`${method}: ${JSON.stringify(result.error)}`);return result.data;
  };
  try{
    await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
    const projects:Project[]=[];
    for(const [index,name] of ['R129 项目A','R129 项目B','claude-zh-cn'].entries()){
      const rootPath=join(projectsRoot,['A','B','claude-zh-cn'][index]!);
      mkdirSync(rootPath,{recursive:true});
      writeFileSync(join(rootPath,'README.md'),'# R129 synthetic navigation fixture\nNo model execution or user data.\n');
      const {project}=await cmd<{project:{id:string;revision:number}}>('project.open',{path:rootPath});
      await cmd('project.update',{projectId:project.id,expectedRevision:project.revision,displayName:name});
      db.prepare("UPDATE project_members SET enabled=0 WHERE project_id=? AND principal_type='agent'").run(project.id);
      const {memberId}=await cmd<{memberId:string}>('member.create',{projectId:project.id,displayName:`R129 ${index+1} 本地模拟成员`});
      await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
      const initial=(await cmd<{items:Room[]}>('room.list',{projectId:project.id})).items;
      if(initial.length!==1)throw Error('Expected precisely one project.open default room');
      const first=initial[0]!;
      const prefix=['A','B','C'][index]!;
      await cmd('room.update',{roomId:first.id,expectedRevision:first.revision,name:`R129 ${prefix} 房间1`,coordinatorMemberId:memberId});
      await cmd('room.members.set',{roomId:first.id,memberId,action:'add'});
      await cmd('room.create',{projectId:project.id,name:`R129 ${prefix} 房间2`,memberIds:[memberId]});
      const rooms=(await cmd<{items:Room[]}>('room.list',{projectId:project.id})).items.sort((a,b)=>a.name.localeCompare(b.name));
      if(rooms.length!==2)throw Error('Expected exactly two synthetic rooms');
      projects.push({id:project.id,name,rootPath,memberId,rooms});
    }
    const ids=projects.map(p=>p.id);
    await cmd('navigation.set',{clientId:'desktop-hifi',activeProjectId:ids[0],visibleProjectIds:ids,expandedProjectIds:ids,pinnedProjectIds:[],fileGitTabs:{}});
    writeFileSync(join(dir,'fixture.json'),JSON.stringify({synthetic:true,projects},null,2));
  }finally{db.close();}
  writeFileSync(join(dir,'baseline.json'),JSON.stringify(snapshot(),null,2));
  console.log(JSON.stringify({ok:true,data:dir}));
}
if(mode==='snapshot')console.log(JSON.stringify(snapshot()));
else if(mode==='seed')void seed().catch(error=>{console.error(error);process.exitCode=1;});
else throw Error('Expected seed or snapshot');
