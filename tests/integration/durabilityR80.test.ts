import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, migrate } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
const root=mkdtempSync(join(tmpdir(),'zs-r80-durability-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
describe('R80 own temporary root persistence/diagnostic evidence',()=>{
  it('SQLite query_only refuses upload registration and message write; original survives and explicit retry is idempotent',async()=>{
    const app=join(root,'app');mkdirSync(app);const db=openDatabase(join(root,'state.sqlite'));let n=0;
    const raw=(method:string,params:unknown,id=`r80-test-${++n}`)=>dispatchDaemonCommand({db,localUserId:'u',appDataDir:app,interruptTurn:async()=>{}},{protocolVersion:1,commandId:id,method,params}) as Promise<{ok:boolean;data:{attachmentId:string;messageId:string;service:string;protection:{unknownTurns:number}};error?:{code:string}}>;
    try{db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','工程',?,?,'{}',0)").run(root,root);db.exec("INSERT INTO project_members(id,project_id,display_name,principal_type) VALUES('m','p','成员','agent');INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('r','p','工程房','m');INSERT INTO conversations(id,project_id,kind,room_id) VALUES('c','p','room','r');");
      const params={conversationId:'c',filename:'原件.txt',content:'唯一原件'};const first=await raw('attachment.uploadText',params);expect(first.ok,JSON.stringify(first)).toBe(true);const blob=(db.prepare('SELECT blob_path FROM artifacts WHERE id=?').get(first.data.attachmentId) as {blob_path:string}).blob_path;const bytes=readFileSync(blob);
      db.pragma('query_only=ON');const refused=await raw('attachment.uploadText',params,'upload-readonly');expect(refused.ok).toBe(false);expect(readFileSync(blob)).toEqual(bytes);expect((db.prepare('SELECT count(*) n FROM artifacts').get() as {n:number}).n).toBe(1);
      const send={target:{kind:'room_root',projectId:'p',roomId:'r',conversationId:'c'},body:'独立仅记录',intent:'record_only',mentions:[],attachmentRefs:[first.data.attachmentId]};expect((await raw('message.submit',send,'lost-original-id')).ok).toBe(false);expect((db.prepare('SELECT count(*) n FROM messages').get() as {n:number}).n).toBe(0);
      db.pragma('query_only=OFF');const success=await raw('message.submit',send,'lost-original-id');expect(success.ok).toBe(true);
      // Reply-loss fixture: discard success, then explicitly replay same envelope; never a new ID.
      const replay=await raw('message.submit',send,'lost-original-id');expect(replay.ok).toBe(true);expect(replay.data.messageId).toBe(success.data.messageId);expect((db.prepare('SELECT count(*) n FROM messages').get() as {n:number}).n).toBe(1);expect(readFileSync(blob)).toEqual(bytes);
      const diag=await raw('app.diagnostics',{projectId:'p'});expect(diag.ok).toBe(true);expect(JSON.stringify(diag.data)).not.toContain(root);expect(JSON.stringify(diag.data)).not.toContain('独立仅记录');expect(diag.data.service).toBe('ready');expect(diag.data.protection.unknownTurns).toBe(0);
      expect(((await dispatchDaemonCommand({db,localUserId:'u',remoteAudit:{deviceId:'remote',authEpoch:1},interruptTurn:async()=>{}},{protocolVersion:1,commandId:'remote-diag',method:'app.diagnostics',params:{}})) as {ok:boolean}).ok).toBe(false);
    }finally{db.close();}
  });
  it('migration backup failure safely refuses before pending migration; old bytes/version survive',()=>{
    const file=join(root,'old.sqlite');const db=new Database(file);db.exec('CREATE TABLE user_data(value TEXT);INSERT INTO user_data VALUES(\'unique old\');PRAGMA user_version=1;');const backup=join(root,'backup-blocker');writeFileSync(backup,'not directory');
    try{expect(()=>migrate(db,{backupDir:backup},[{id:1,name:'old',up:()=>{}},{id:2,name:'next',up:d=>d.exec('DELETE FROM user_data')}])).toThrow();expect(db.pragma('user_version',{simple:true})).toBe(1);expect(db.prepare('SELECT value FROM user_data').get()).toEqual({value:'unique old'});expect(readFileSync(backup,'utf8')).toBe('not directory');}finally{db.close();}
  });
});
