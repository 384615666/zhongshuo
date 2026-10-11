/**
 * DEV-24 图片附件首包（第二十八轮四）：四能力如实分列——
 * ①保存原件（magic bytes 内容类型校验——扩展名不作依据；尺寸/面积按格式头限幅；损坏/截断/
 * 超限明确拒绝；内容寻址 {appData}/blobstore/{hash}.bin）②预览（audience+实根+sha256 原件
 * 核对；mime/尺寸/dataUrl——渲染由 <img>）③OCR=未实现（明确 unsupported）④模型图片输入=
 * 未认证（注入链路只注文本——startTurn 输入不含图片数据，不发路径冒充已读）。
 * 消息可带图引用（四通道沿用）；图片评论随分批归属（comment.add 对 image 明确拒绝）。
 */
import type { TurnRequest } from '../../src/contracts/runtime.ts';
import { describe, expect, it, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-imgatt-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(appData, { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

/** 合成最小合法 PNG（1×1 灰度，带正确 CRC——服务端 magic+IHDR 解析即可；<img> 渲染由页面层）。 */
function makePng(width = 1, height = 1): Buffer {
  const chunk = (type: Buffer, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([type, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(crcBuf) >>> 0);
    return Buffer.concat([len, crcBuf, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit 灰度
  const idat = zlib.deflateSync(Buffer.from([0, 0xff])); // 单行滤波字节+1 像素
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(Buffer.from('IHDR'), ihdr),
    chunk(Buffer.from('IDAT'), idat),
    chunk(Buffer.from('IEND'), Buffer.alloc(0)),
  ]);
}

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ia-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `ia-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const makeWorker = () => {
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    return { worker: new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: appData }), adapter };
  };
  return { db, cmd, cmdRaw, makeWorker, close: () => db.close() };
}


// A protocol-only supported fixture enables the full daemon → worker path without a model call.
const status=vi.hoisted(()=>({supported:true,identityKey:'original'}));
vi.mock('../../src/daemon/imageCapability.ts',()=>({memberImageCapability:()=>({status:status.supported?'supported':'unverified',identityKey:status.identityKey})}));

describe('R76 image sends and frozen omission',()=>{
 it('image-only positive, original envelope replay once, worker passes actual bytes; omission persists',async()=>{
  const env=makeEnv();try{
   const png=makePng();const up=await env.cmd<{attachmentId:string}>('attachment.uploadImage',{conversationId:'conv_room',filename:'中文.png',contentBase64:png.toString('base64')});
   const params={target:{kind:'room_root',projectId:'p1',conversationId:'conv_room',roomId:'r0'},body:'',intent:'default',mentions:[{kind:'member',memberId:'mA'}],attachmentRefs:[up.attachmentId]};
   const deps={interruptTurn:async()=>{},db:env.db,localUserId:'u_local',appDataDir:appData};
   const envelope={protocolVersion:1,commandId:'r76-frozen',method:'message.submit',params};
   const first=await dispatchDaemonCommand(deps,envelope) as {ok:boolean};const replay=await dispatchDaemonCommand(deps,envelope) as {ok:boolean};
   expect(first.ok).toBe(true);expect(replay.ok).toBe(true);expect((env.db.prepare('SELECT count(*) c FROM tasks').get() as {c:number}).c).toBe(1);
   const {worker,adapter}=env.makeWorker();let input:TurnRequest|undefined;
   const original=adapter.startTurn.bind(adapter);adapter.startTurn=async(s,i)=>{input=i;await original(s,i);};
   await worker.runOnce();expect(input?.images).toHaveLength(1);expect(Buffer.from(input!.images![0]!.dataBase64,'base64')).toEqual(png);
   expect(input?.text).not.toContain('图片附件未发送');await adapter.closeAllSessions();
   const omitted=await env.cmdRaw('message.submit',{...params,body:'只发文字',imageAck:'omit-images'});expect(omitted.ok).toBe(true);
   const row=env.db.prepare("SELECT body_json FROM messages WHERE body_json LIKE '%只发文字%'").get() as {body_json:string};expect(JSON.parse(row.body_json).imageInput).toBe('omit');
   const run2=env.makeWorker();let second:TurnRequest|undefined;const orig=run2.adapter.startTurn.bind(run2.adapter);run2.adapter.startTurn=async(s,i)=>{second=i;await orig(s,i);};await run2.worker.runOnce();expect(second?.images).toEqual([]);expect(second?.text).toContain('图片附件未发送');await run2.adapter.closeAllSessions();
   const empty=await env.cmdRaw('message.submit',{...params,imageAck:'omit-images'});expect(empty.ok).toBe(false);
   status.supported=false;const no=await env.cmdRaw('message.submit',params);expect(no.ok).toBe(false);
   const local=await env.cmdRaw('message.submit',{...params,intent:'record_only'});expect(local.ok).toBe(true);
   expect((env.db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c).toBe(0);
  }finally{status.supported=true;env.close();}
 });
 it('runtime certification changing while opening a session blocks before startTurn and keeps originals',async()=>{
  const env=makeEnv();try{
   const up=await env.cmd<{attachmentId:string}>('attachment.uploadImage',{conversationId:'conv_room',filename:'变更.png',contentBase64:makePng().toString('base64')});
   await env.cmd('message.submit',{target:{kind:'room_root',projectId:'p1',conversationId:'conv_room',roomId:'r0'},body:'',intent:'default',mentions:[{kind:'member',memberId:'mA'}],attachmentRefs:[up.attachmentId]});
   const {worker,adapter}=env.makeWorker();const open=adapter.openSession.bind(adapter);
   adapter.openSession=async input=>{const session=await open(input);status.supported=false;return session;};
   await expect(worker.runOnce()).rejects.toThrow('图片输入认证');expect(adapter.startTurnLog).toHaveLength(0);
   expect((env.db.prepare("SELECT count(*) c FROM agent_turns WHERE status='UNKNOWN'").get() as {c:number}).c).toBe(0);
   expect((env.db.prepare('SELECT count(*) c FROM message_attachments').get() as {c:number}).c).toBe(1);
   await adapter.closeAllSessions();
  }finally{status.supported=true;env.close();}
 });
 it('declared worktree SVG reads original bytes and hash, while raster upload still rejects SVG',async()=>{
  const env=makeEnv();try{const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="green"/></svg>');
   writeFileSync(join(tmpRoot,'中文.svg'),svg);
   const r=await env.cmd<{bytesBase64:string;binaryKind:string;sha256:string}>('project.file.readFull',{projectId:'p1',path:'中文.svg',includeBytes:true});
   expect(Buffer.from(r.bytesBase64,'base64')).toEqual(svg);expect(r.binaryKind).toBe('image_file');
   const hash=(await import('node:crypto')).createHash('sha256').update(svg).digest('hex');expect(r.sha256).toBe(hash);
   const up=await env.cmdRaw('attachment.uploadImage',{conversationId:'conv_room',filename:'中文.svg',contentBase64:svg.toString('base64')});expect(up.ok).toBe(false);
  }finally{env.close();}
 });
 it('R77 same certified channel but configuration snapshot changes during openSession: no startTurn, no UNKNOWN',async()=>{
  const env=makeEnv();try{
   const up=await env.cmd<{attachmentId:string}>('attachment.uploadImage',{conversationId:'conv_room',filename:'配置.png',contentBase64:makePng().toString('base64')});
   await env.cmd('message.submit',{target:{kind:'room_root',projectId:'p1',conversationId:'conv_room',roomId:'r0'},body:'',intent:'default',mentions:[{kind:'member',memberId:'mA'}],attachmentRefs:[up.attachmentId]});
   const {worker,adapter}=env.makeWorker();const open=adapter.openSession.bind(adapter);
   adapter.openSession=async input=>{const session=await open(input);status.identityKey='changed-configuration';return session;};
   await expect(worker.runOnce()).rejects.toThrow('图片输入认证');expect(status.supported).toBe(true);expect(adapter.startTurnLog).toHaveLength(0);
   expect((env.db.prepare("SELECT count(*) c FROM agent_turns WHERE status='UNKNOWN'").get() as {c:number}).c).toBe(0);
   expect((env.db.prepare('SELECT count(*) c FROM message_attachments').get() as {c:number}).c).toBe(1);
   await adapter.closeAllSessions();
  }finally{status.identityKey='original';env.close();}
 });
 it('WebP truncated lossless header rejects without a range exception',async()=>{
  const env=makeEnv();try{const raw=Buffer.alloc(21);raw.write('RIFF');raw.write('WEBP',8);raw.write('VP8L',12);raw[20]=0x2f;
  const r=await env.cmdRaw('attachment.uploadImage',{conversationId:'conv_room',filename:'坏.webp',contentBase64:raw.toString('base64')});expect(r.ok).toBe(false);expect('error' in r && r.error?.code).toBe('VALIDATION_INVALID');}finally{env.close();}
 });
});
