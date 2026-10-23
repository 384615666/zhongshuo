import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

it('keeps original latest replies and authoritative counts current in cold/cached/away/completed room cards', async () => {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r102-pool-replies-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  const methods:string[]=[];
  const raw=(method:string,params:unknown)=>{
    methods.push(method);
    return dispatchDaemonCommand({db,appDataDir:dir,localUserId:'u_local',interruptTurn:async()=>{}},
      {protocolVersion:1,commandId:randomUUID(),method,params}) as Promise<{ok:boolean;data:unknown}>;
  };
  const cmd=async<T>(method:string,params:unknown):Promise<T>=>{const r=await raw(method,params);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data as T;};
  let pauseHistory=false,release:(()=>void)|undefined,captured=false;
  try{
    const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
    const room=(await cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId})).items[0]!;
    const member=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'统一交付主持'})).memberId;
    await cmd('member.setRuntime',{memberId:member,kind:'fake',permissionMode:'bypassPermissions'});
    const other=(await cmd<{room:{id:string}}>('room.create',{projectId,name:'切走的房间'})).room.id;
    const entry=join(dir,'entry.ts'),bundle=join(dir,'bundle.mjs');
    writeFileSync(entry,`export * as loader from ${JSON.stringify(resolve('src/ui/hifi/loader.ts').replaceAll('\\','/'))};export * as store from ${JSON.stringify(resolve('src/ui/hifi/data/store.ts').replaceAll('\\','/'))};export * as selectors from ${JSON.stringify(resolve('src/ui/hifi/data/selectors.ts').replaceAll('\\','/'))};`);
    await build({entryPoints:[entry],bundle:true,platform:'browser',format:'esm',outfile:bundle});
    vi.stubGlobal('window',{zs:{command:async(env:{method:string;params:unknown})=>{
      const result=await raw(env.method,env.params);
      if(pauseHistory&&env.method==='thread.history'){pauseHistory=false;captured=true;await new Promise<void>(done=>{release=done;});}
      return result;
    }}});
    type State={threadEntities:Record<string,unknown>;threadMessages:Record<string,unknown[]>;messages:unknown[]};
    const {loader,store,selectors}=await import(pathToFileURL(bundle).href) as {
      loader:{openProjectByPath(path:string):Promise<void>;loadRoomPool(id:string):Promise<void>;loadThread(id:string):Promise<void>};
      store:{getState():State};selectors:{replyCount(state:State,id:string):number;replyPreview(state:State,id:string,limit:number):Array<{body:string;authorId:string;threadMessageSeq:number}>};
    };
    await loader.openProjectByPath(project);
    const sent=await cmd<{taskId:string;threadId:string}>('message.submit',{
      target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'完成统一决策材料',intent:'default',mentions:[{kind:'member',memberId:member}],
    });
    const empty=await cmd<{taskId:string;threadId:string}>('message.submit',{
      target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'验证空主池后的新回复',intent:'default',mentions:[{kind:'member',memberId:member}],
    });
    const append=(n:number,target=sent)=>{
      const seq=(db.prepare('SELECT MAX(conversation_seq) n FROM messages WHERE conversation_id=?').get(room.conversationId) as {n:number}).n+1;
      db.prepare("INSERT INTO messages(id,project_id,conversation_id,conversation_seq,room_id,thread_id,task_id,thread_message_seq,author_type,author_id,body_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,'agent',?,?,'final',?)")
        .run(`${target.threadId}_reply_${n}`,projectId,room.conversationId,seq,room.id,target.threadId,target.taskId,n,member,JSON.stringify({text:`原文回复${n}：已核验，不是生成的摘要。`}),Date.now()+n);
      db.prepare('UPDATE conversation_threads SET last_message_seq=? WHERE id=?').run(n,target.threadId);
    };
    const check=(count:number,threadId=sent.threadId)=>{
      const state=store.getState();expect(selectors.replyCount(state,threadId)).toBe(count);
      const preview=selectors.replyPreview(state,threadId,2);
      expect(preview.map(m=>m.body)).toEqual([count-1,count].map(n=>`原文回复${n}：已核验，不是生成的摘要。`));
      expect(preview.map(m=>m.authorId)).toEqual([member,member]);
    };
    append(1);append(2);methods.length=0;
    await loader.loadRoomPool(room.id);expect(methods).toEqual(['room.pool']);check(2);
    expect(store.getState().threadEntities[sent.threadId]).toBeUndefined();
    append(1,empty);append(2,empty);await loader.loadThread(empty.threadId);check(2,empty.threadId); // older pool has recentReplies:[]
    await loader.loadThread(sent.threadId);
    for(let n=3;n<=7;n++)append(n);
    await loader.loadRoomPool(other); // thread remains cached while the room is away
    await loader.loadRoomPool(room.id);check(7);
    pauseHistory=true;const stale=loader.loadThread(sent.threadId);await vi.waitFor(()=>expect(captured).toBe(true));
    for(let n=8;n<=10;n++)append(n);
    db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(sent.taskId);
    methods.length=0;await loader.loadRoomPool(room.id);expect(methods).toEqual(['room.pool']);check(10);
    release!();await stale;expect(store.getState().threadMessages[sent.threadId]).toHaveLength(7);check(10);
    await loader.loadThread(sent.threadId);check(10);
    append(11);append(12);await loader.loadThread(sent.threadId);check(12); // newer thread beats the older pool total and preview
  }finally{release?.();db.close();vi.unstubAllGlobals();vi.unstubAllEnvs();}
},30_000);
