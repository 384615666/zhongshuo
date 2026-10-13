import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
vi.mock('node:fs',async()=>{const real=await vi.importActual<typeof fs>('node:fs');return{...real,writeFileSync:vi.fn(real.writeFileSync)};});
const realFs=await vi.importActual<typeof fs>('node:fs');
afterEach(()=>vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync));
function png(){const chunk=(type:string,data:Buffer)=>{const t=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(zlib.crc32(Buffer.concat([t,data]))>>>0);return Buffer.concat([len,t,data,crc]);};const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255]))),chunk('IEND',Buffer.alloc(0))]);}
describe('R80 formal upload/export commands with scoped injected storage errors',()=>{
  for(const code of ['ENOSPC','EACCES','INTERRUPTED'])it(`${code} upload cannot destroy a previously linked PNG original or report success`,async()=>{
    const root=fs.mkdtempSync(join(tmpdir(),'zs-r80-storage-'));const db=openDatabase(join(root,'state.sqlite'));let seq=0;
    const send=(method:string,params:unknown,id=`r80-storage-${++seq}`)=>dispatchDaemonCommand({db,localUserId:'u',appDataDir:root,interruptTurn:async()=>{}},{protocolVersion:1,commandId:id,method,params}) as Promise<{ok:boolean;data?:{attachmentId:string;messageId:string;dir:string};error?:{code:string;message:string}}>;
    try{db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','工程',?,?,'{}',0)").run(root,root);db.exec("INSERT INTO project_members(id,project_id,display_name,principal_type) VALUES('m','p','模拟成员','agent');INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('r','p','工程房','m');INSERT INTO conversations(id,project_id,kind,room_id) VALUES('c','p','room','r');");
      const upload={conversationId:'c',filename:'中文工程图.png',contentBase64:png().toString('base64')};const first=await send('attachment.uploadImage',upload);expect(first.ok,JSON.stringify(first)).toBe(true);const original=(db.prepare('SELECT blob_path FROM artifacts WHERE id=?').get(first.data!.attachmentId) as {blob_path:string}).blob_path;const bytes=fs.readFileSync(original);
      expect((await send('message.submit',{target:{kind:'room_root',projectId:'p',roomId:'r',conversationId:'c'},body:'',mentions:[],intent:'record_only',attachmentRefs:[first.data!.attachmentId]})).ok).toBe(true);
      vi.mocked(fs.writeFileSync).mockImplementation((file,...args:unknown[])=>{if(typeof file==='number'){realFs.writeFileSync(file,'partial only');throw Object.assign(Error(code),{code});}return Reflect.apply(realFs.writeFileSync,fs,[file,...args]);});
      const failed=await send('attachment.uploadImage',upload,'r80-original-upload-retry');expect(failed.ok).toBe(false);expect(fs.readFileSync(original)).toEqual(bytes);expect((db.prepare('SELECT count(*) n FROM artifacts').get() as {n:number}).n).toBe(1);expect((db.prepare('SELECT count(*) n FROM message_attachments').get() as {n:number}).n).toBe(1);
      vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);expect((await send('attachment.uploadImage',upload,'r80-original-upload-retry')).ok).toBe(true);expect((await send('attachment.previewImage',{attachmentId:first.data!.attachmentId,conversationId:'c'})).ok).toBe(true);
      const exported=await send('export.create',{target:{kind:'conversation',projectId:'p',conversationId:'c'},format:'md'});expect(exported.ok,JSON.stringify(exported)).toBe(true);const successfulExport=exported.data!.dir;const oldManifest=fs.readFileSync(join(successfulExport,'manifest.json'));
      vi.mocked(fs.writeFileSync).mockImplementation((file,...args:unknown[])=>{if(typeof file==='string'&&file.endsWith('manifest.json')){realFs.writeFileSync(file,'partial manifest');throw Object.assign(Error(code),{code});}return Reflect.apply(realFs.writeFileSync,fs,[file,...args]);});
      expect((await send('export.create',{target:{kind:'conversation',projectId:'p',conversationId:'c'},format:'md'},'r80-export-explicit-retry')).ok).toBe(false);expect(fs.readFileSync(original)).toEqual(bytes);expect(fs.readFileSync(join(successfulExport,'manifest.json'))).toEqual(oldManifest);
      vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);expect((await send('export.create',{target:{kind:'conversation',projectId:'p',conversationId:'c'},format:'md'},'r80-export-explicit-retry')).ok).toBe(true);expect((db.prepare('SELECT count(*) n FROM real_calls').get() as {n:number}).n).toBe(0);
    }finally{vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);db.close();fs.rmSync(root,{recursive:true,force:true});}
  });
});
