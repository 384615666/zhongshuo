import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import * as image from '../../src/daemon/imageCapability.ts';
afterEach(()=>vi.restoreAllMocks());
describe('R84 diagnostic facts separate automatic transport from vision evidence',()=>{
  it('supported automatic bytes without evidence never becomes a matched vision certificate',async()=>{
    const dir=mkdtempSync(resolve('dist','r84-diagnostic-')),project=join(dir,'own');mkdirSync(project);const db=openDatabase(join(dir,'state.sqlite'));
    const cmd=async(method:string,params:unknown)=>{const r=await dispatchDaemonCommand({db,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:Record<string,unknown>};expect(r.ok).toBe(true);return r.data;};
    try{
      const p=((await cmd('project.open',{path:project})).project as {id:string}).id;await cmd('member.create',{projectId:p,displayName:'独立诊断成员'});
      vi.spyOn(image,'memberImageCapability').mockImplementation((_db,id)=>({memberId:id,kind:'codex',model:'gpt-6.1-sol',permissionMode:'bypassPermissions',status:'supported',evidence:null,channel:'https://example.invalid',endpointSource:null,configuration:'已配置',protocol:'适配器图片字节协议回放通过',reason:'自动传递图片字节；真实识图结果由本次请求判定',identityKey:'own-fixture-identity'}));
      const report=await cmd('app.diagnostics',{projectId:p}),runtime=report.runtime as Array<{reason:string;protocol?:string;certification?:string}>;
      expect(runtime[0]!.reason).not.toContain('认证匹配');expect(runtime[0]!.reason).not.toContain('证据匹配');
      expect(runtime[0]).toMatchObject({protocol:'适配器图片字节协议回放通过',certification:'unverified'});
      expect((db.prepare('SELECT count(*) n FROM real_calls').get() as {n:number}).n).toBe(0);
    }finally{db.close();}
  });
});
