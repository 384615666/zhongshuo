import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

describe('R78 room creation identity and archived read-only boundary', () => {
  it('rejects foreign members and blank names without creating any room; archive blocks creation and receipt replay, restore permits creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zs-r78-room-')); const db = openDatabase(':memory:');
    const raw = (method: string, params: unknown, commandId = randomUUID()) => dispatchDaemonCommand({db, localUserId:'u_local', appDataDir:join(root,'data'), interruptTurn:async()=>{}}, {protocolVersion:1,commandId,method,params}) as Promise<{ok:boolean;data?:unknown;error?:unknown;replayed?:boolean}>;
    try {
      const p2 = join(root, 'other'); mkdirSync(p2);
      const a = await raw('project.open', {path:root}); const b = await raw('project.open', {path:p2});
      const pid = (a.data as {project:{id:string}}).project.id; const other = (b.data as {project:{id:string}}).project.id;
      const foreign = (await raw('member.list',{projectId:other})).data as {items:Array<{id:string}>};
      const count = () => (db.prepare('SELECT count(*) c FROM rooms WHERE project_id=?').get(pid) as {c:number}).c;
      const before = count();
      const rejected = await raw('room.create',{projectId:pid,name:'错误成员',memberIds:[foreign.items[0]!.id]});
      expect(rejected.ok).toBe(false); expect(count()).toBe(before);
      expect((await raw('room.create',{projectId:pid,name:'   '})).ok).toBe(false); expect(count()).toBe(before);
      const commandId = randomUUID(); const created = await raw('room.create',{projectId:pid,name:'正式房间'},commandId);
      expect(created.ok).toBe(true); expect(count()).toBe(before+1);
      const rev = () => (db.prepare('SELECT revision FROM projects WHERE id=?').get(pid) as {revision:number}).revision;
      expect((await raw('project.lifecycle',{projectId:pid,action:'archive',expectedRevision:rev()})).ok).toBe(true);
      expect((await raw('room.create',{projectId:pid,name:'归档不可写'})).ok).toBe(false);
      expect((await raw('room.create',{projectId:pid,name:'正式房间'},commandId)).ok).toBe(false); expect(count()).toBe(before+1);
      expect((await raw('room.list',{projectId:pid})).ok).toBe(true);
      expect((await raw('project.lifecycle',{projectId:pid,action:'unarchive',expectedRevision:rev()})).ok).toBe(true);
      expect((await raw('room.create',{projectId:pid,name:'正式房间'},commandId)).replayed).toBe(true); expect(count()).toBe(before+1);
      expect((await raw('room.create',{projectId:pid,name:'恢复后建房'})).ok).toBe(true);
      expect((db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c).toBe(0);
    } finally {db.close(); rmSync(root,{recursive:true,force:true});}
  });
});
