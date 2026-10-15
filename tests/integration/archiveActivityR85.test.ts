import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';

interface Row {projectId:string;projectRevision:number;projectArchived:boolean;roomId:string|null;roomRevision:number|null;roomArchivedAt:number|null}
interface Page {items:Row[];nextCursor:string|null;readAt:number}
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'zs-r85-archive-')),db=openDatabase(':memory:');
 const raw=async<T,>(method:string,params:unknown,user='u_archive')=>await dispatchDaemonCommand({db,localUserId:user,appDataDir:join(root,'data'),interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error?:{code:string}};
 const cmd=async<T,>(method:string,params:unknown)=>{const r=await raw<T>(method,params);expect(r.ok,JSON.stringify(r.error)).toBe(true);return r.data;};
 const project=async(name:string)=>{const dir=join(root,name);mkdirSync(dir);return(await cmd<{project:{id:string}}>('project.open',{path:dir,displayName:name})).project.id};
 const a=await project('A'),b=await project('B');
 const room=async(p:string,name:string)=>{const r=(await cmd<{room:{id:string}}>('room.create',{projectId:p,name})).room;const row=(await cmd<{items:Array<{id:string;revision:number}>}>('room.list',{projectId:p})).items.find(x=>x.id===r.id)!;await cmd('room.archive',{roomId:r.id,expectedRevision:row.revision,action:'archive'});return r.id};
 return{db,root,a,b,raw,cmd,room,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
describe('R85 archive registry pages and authoritative cross-project activity identities, zero model calls',()=>{
 it('reads archives from both projects without changing focus, uses stable scoped cursors, and preserves CAS identity',async()=>{
  const f=await fixture();try{
   const ar=await f.room(f.a,'同名'),br=await f.room(f.b,'同名');
   const first=await f.cmd<Page>('archive.list',{limit:1});expect(first.items).toHaveLength(1);expect(first.nextCursor).not.toBe(null);
   const second=await f.cmd<Page>('archive.list',{limit:1,cursor:first.nextCursor});expect(second.nextCursor).toBe(null);
   expect(new Set([...first.items,...second.items].map(r=>r.roomId))).toEqual(new Set([ar,br]));
   expect((await f.raw('archive.list',{projectId:f.a,cursor:first.nextCursor})).error?.code).toBe('VALIDATION_INVALID');
   expect((await f.raw('archive.list',{cursor:first.nextCursor},'other_user')).error?.code).toBe('VALIDATION_INVALID');
   expect((await f.raw('archive.list',{cursor:'not a cursor'})).ok).toBe(false);
   const a=(await f.cmd<Page>('archive.list',{projectId:f.a})).items[0]!;expect(a.roomRevision).toBe(1);
   await f.cmd('room.archive',{roomId:a.roomId,expectedRevision:a.roomRevision,action:'unarchive'});
   expect((await f.cmd<Page>('archive.list',{projectId:f.a})).items).toEqual([]);
   expect((await f.raw('room.archive',{roomId:a.roomId,expectedRevision:a.roomRevision,action:'archive'})).ok).toBe(false);
   expect((await f.cmd<Page>('archive.list',{})).items.map(r=>r.roomId)).toEqual([br]);
   expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
  }finally{f.close();}
 });
 it('includes rooms made read-only by an archived project, omits removed projects, and reads all pages without duplicate rows',async()=>{
  const f=await fixture();try{
   await f.room(f.a,'单独归档');await f.room(f.b,'即将移除');
   await f.cmd('project.lifecycle',{projectId:f.a,expectedRevision:0,action:'archive'});await f.cmd('project.lifecycle',{projectId:f.b,expectedRevision:0,action:'remove'});
   const seen:Row[]=[];let cursor:string|null=null;let reads=0;
   do{const p:Page=await f.cmd<Page>('archive.list',{limit:1,...(cursor?{cursor}:{})});seen.push(...p.items);cursor=p.nextCursor;reads++;expect(reads).toBeLessThan(8);}while(cursor);
   expect(seen.every(r=>r.projectId===f.a&&r.projectArchived)).toBe(true);expect(seen.filter(r=>r.roomId===null)).toHaveLength(1);
   expect(seen.some(r=>r.roomId!==null&&r.roomArchivedAt===null)).toBe(true);
   expect(new Set(seen.map(r=>JSON.stringify([r.projectId,r.roomId]))).size).toBe(seen.length);
   expect((await f.raw('archive.list',{limit:101})).ok).toBe(false);
  }finally{f.close();}
 });
 it('room record-only events carry their true room even when another project is focused; private DM visibility stays enforced',async()=>{
  const f=await fixture();try{
   const room=(await f.cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId:f.a})).items[0]!;
   await f.cmd('message.submit',{target:{kind:'room_root',projectId:f.a,roomId:room.id,conversationId:room.conversationId},body:'普通跨项目记录',intent:'record_only',mentions:[]});
   const items=(await f.cmd<{items:Array<{projectId:string;roomId:string|null;conversationId:string;taskId:string|null}>}>('activity.list',{scope:'all'})).items;
   const record=items.find(e=>e.conversationId===room.conversationId&&e.taskId===null);expect(record?.projectId).toBe(f.a);expect(record?.roomId).toBe(room.id);
   const members=await f.cmd<{items:Array<{id:string}>}>('member.list',{projectId:f.a});
   const dm=await f.cmd<{conversationId:string}>('conversation.create',{projectId:f.a,peerMemberId:members.items[0]!.id});
   await f.cmd('message.submit',{target:{kind:'dm',projectId:f.a,conversationId:dm.conversationId},body:'私人记录',intent:'record_only',mentions:[]});
   const foreign=await f.raw<{items:Array<{conversationId:string}>}>('activity.list',{scope:'all'},'foreign_user');expect(foreign.ok).toBe(true);expect(foreign.data.items.some(e=>e.conversationId===dm.conversationId)).toBe(false);
   expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
  }finally{f.close();}
 });
});
