import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import type {ZhongshuoDatabase} from '../../src/persistence/db.ts';
import type {NavigationPin} from '../../src/contracts/navigationPins.ts';

function fixture(db:ZhongshuoDatabase){
  for(const p of ['a','b']){
    db.prepare('INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES(?,?,?,?,?,0)').run(p,p,'C:/synthetic/'+p,'C:/synthetic/'+p,'{}');
    db.prepare("INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES(?,?,?,'agent',1)").run('m-'+p,p,'同名成员');
    db.prepare('INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES(?,?,?,?)').run('r-'+p,p,'同名房间','m-'+p);
    db.prepare("INSERT INTO conversations(id,project_id,kind) VALUES(?,?,'dm')").run('dm-'+p,p);
    for(const [type,id] of [['human','owner'],['agent','m-'+p]])db.prepare('INSERT INTO dm_participants(project_id,conversation_id,principal_type,principal_id) VALUES(?,?,?,?)').run(p,'dm-'+p,type,id);
  }
}
function client(db:ZhongshuoDatabase,viewer='owner',remote=false){
  return async(method:string,params:unknown,id=randomUUID())=>dispatchDaemonCommand({db,localUserId:viewer,interruptTurn:async()=>{},...(remote?{remoteAudit:{deviceId:'remote',authEpoch:1}}:{})},{protocolVersion:1,commandId:id,method,params}) as Promise<{ok:boolean;data:{pins:NavigationPin[];pin:NavigationPin|null;prefs:unknown};error:{code:string}}>;
}
const target=(kind:'room'|'dm',projectId='a')=>({clientId:'desktop-hifi',kind,projectId,itemId:(kind==='room'?'r-':'dm-')+projectId,pinned:true});

describe('R160 personal room and private-message pins',()=>{
  it('persists independently of ordinary navigation, composes targets, replays once, and cancels without touching conversation data',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'zs-r160-')),file=join(dir,'state.sqlite');let db=openDatabase(file);
    try{
      fixture(db);const call=client(db),id=randomUUID();
      expect((await call('navigation.pin',target('room'),id)).ok).toBe(true);
      expect((await call('navigation.pin',target('room'),id)).ok).toBe(true);
      expect((await call('navigation.pin',target('dm','b'))).ok).toBe(true);
      await call('navigation.set',{clientId:'desktop-hifi',activeProjectId:'a',visibleProjectIds:['a'],expandedProjectIds:[]});
      const read=(await call('navigation.get',{clientId:'desktop-hifi'})).data;
      expect(read.pins.map(pin=>[pin.kind,pin.projectId,pin.itemId,pin.label])).toEqual([['dm','b','dm-b','同名成员'],['room','a','r-a','同名房间']]);
      db.close();db=openDatabase(file);const reopened=client(db);
      expect((await reopened('navigation.get',{clientId:'desktop-hifi'})).data.pins).toEqual(read.pins);
      await reopened('navigation.pin',{...target('room'),pinned:false});
      expect((await reopened('navigation.get',{clientId:'desktop-hifi'})).data.pins.map(pin=>pin.itemId)).toEqual(['dm-b']);
      expect(db.prepare('SELECT count(*) n FROM rooms').get()).toEqual({n:2});
      expect(db.prepare('SELECT count(*) n FROM conversations').get()).toEqual({n:2});
      expect(db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});
      expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{db.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('scopes preferences to viewer/client, rejects wrong ownership and project, and filters archived/removed targets',async()=>{
    const db=openDatabase(':memory:');try{
      fixture(db);const call=client(db);
      expect((await client(db,'stranger')('navigation.pin',target('dm'))).ok).toBe(false);
      expect((await call('navigation.pin',{...target('room'),projectId:'b'})).ok).toBe(false);
      expect((await client(db,'owner',true)('navigation.pin',target('room'))).error.code).toBe('FORBIDDEN');
      await call('navigation.pin',target('room'));const dmCommand=randomUUID();await call('navigation.pin',target('dm','b'),dmCommand);
      expect((await client(db,'stranger')('navigation.get',{clientId:'desktop-hifi'})).data.pins).toEqual([]);
      expect((await call('navigation.get',{clientId:'other'})).data.pins).toEqual([]);
      db.prepare("UPDATE rooms SET name='新房间名' WHERE id='r-a'").run();
      db.prepare("UPDATE conversations SET title='新私信名' WHERE id='dm-b'").run();
      expect((await call('navigation.get',{clientId:'desktop-hifi'})).data.pins.map(pin=>pin.label)).toEqual(['新私信名','新房间名']);
      db.prepare("UPDATE conversations SET archived_at=1 WHERE id='dm-b'").run();
      db.prepare("UPDATE projects SET status='removed' WHERE id='a'").run();
      expect((await call('navigation.get',{clientId:'desktop-hifi'})).data.pins).toEqual([]);
      expect((await call('navigation.pin',target('dm','b'))).ok).toBe(false);
      expect((await call('navigation.pin',target('dm','b'),dmCommand)).ok).toBe(false);
      expect((await call('navigation.pin',{...target('room'),pinned:false})).ok).toBe(true);
    }finally{db.close();}
  });
});
