import { afterEach,describe,expect,it,vi } from 'vitest';
import Database from 'better-sqlite3';
import { cpSync,copyFileSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { migrate } from '../../src/persistence/db.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/registry.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

afterEach(()=>vi.unstubAllEnvs());
const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
describe('R87 additive schemas 053–054 in owned complete-root copies',()=>{
  it('preserves formal pre-053 facts and opaque profile inputs; older migration gate rejects new root and accepts matching backup',async()=>{
    vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
    const dir=mkdtempSync(join(tmpdir(),'zs-r87-upgrade-')),original=join(dir,'original'),project=join(dir,'project');mkdirSync(original);mkdirSync(project);
    const prefix=MIGRATIONS.filter(m=>m.id<=52),old=new Database(join(original,'state.sqlite'));
    old.pragma('foreign_keys=ON');old.pragma('journal_mode=WAL');migrate(old,{},prefix);
    const deps={db:old,appDataDir:original,localUserId:'u_local',interruptTurn:async()=>{}};
    const cmd=async<T>(method:string,params:unknown)=>{const result=await dispatchDaemonCommand(deps,{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T};expect(result.ok).toBe(true);return result.data;};
    const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
    const memberId=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'升级前成员',description:'保留身份'})).memberId;
    const room=(await cmd<{items:{id:string;conversationId:string}[]}>('room.list',{projectId})).items[0]!;
    await cmd('message.submit',{target:{kind:'room_root',projectId,conversationId:room.conversationId,roomId:room.id},body:'升级前已提交但尚未派发的正式任务',mentions:[{kind:'member',memberId}],intent:'default'});
    const tables=['projects','project_members','messages','tasks','outbox','command_receipts'];
    const facts=()=>Object.fromEntries(tables.map(table=>[table,old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before=facts();old.close();
    // Opaque renderer/profile bytes are synthetic preservation inputs, not a fake business completion.
    mkdirSync(join(original,'profile'));writeFileSync(join(original,'profile','draft-and-unknown.json'),JSON.stringify({draft:'工程草稿',unknownCommandId:'original-engineering-envelope',body:'原输入',intent:'record_only'}));
    const originalDbHash=sha(join(original,'state.sqlite')),originalProfileHash=sha(join(original,'profile','draft-and-unknown.json'));
    const copied=join(dir,'upgraded');cpSync(original,copied,{recursive:true});
    const backups=join(copied,'migration-backups'),upgraded=new Database(join(copied,'state.sqlite'));
    upgraded.pragma('foreign_keys=ON');upgraded.pragma('journal_mode=WAL');migrate(upgraded,{backupDir:backups},MIGRATIONS.filter(m=>m.id<=54));
    expect(upgraded.pragma('user_version',{simple:true})).toBe(54);
    for(const table of tables)expect(upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before[table]);
    for(const table of ['coordination_runs','thread_reply_requests','turn_visible_progress','coordination_messages'])expect(upgraded.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});upgraded.close();
    expect(sha(join(copied,'profile','draft-and-unknown.json'))).toBe(originalProfileHash);
    const newer=new Database(join(copied,'state.sqlite'));try{expect(()=>migrate(newer,{},prefix)).toThrow('SCHEMA_VERSION_UNSUPPORTED');}finally{newer.close();}
    const backup=readdirSync(backups).find(name=>name.endsWith('.sqlite'))!;
    const restored=join(dir,'restored');cpSync(original,restored,{recursive:true});copyFileSync(join(backups,backup),join(restored,'state.sqlite'));
    const matching=new Database(join(restored,'state.sqlite'));try{expect(()=>migrate(matching,{},prefix)).not.toThrow();for(const table of tables)expect(matching.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before[table]);}finally{matching.close();}
    expect(sha(join(original,'state.sqlite'))).toBe(originalDbHash);expect(sha(join(original,'profile','draft-and-unknown.json'))).toBe(originalProfileHash);
  });
});
