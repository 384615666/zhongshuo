import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
describe('R84/R194 diagnostic facts: images are passed with the message, no vision certificate claimed or required',()=>{
  it('every runtime reports image input supported with certification not-required and no launch identity',async()=>{
    const dir=mkdtempSync(resolve('dist','r84-diagnostic-')),project=join(dir,'own');mkdirSync(project);const db=openDatabase(join(dir,'state.sqlite'));
    const cmd=async(method:string,params:unknown)=>{const r=await dispatchDaemonCommand({db,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:Record<string,unknown>};expect(r.ok).toBe(true);return r.data;};
    try{
      const p=((await cmd('project.open',{path:project})).project as {id:string}).id;await cmd('member.create',{projectId:p,displayName:'独立诊断成员'});
      const report=await cmd('app.diagnostics',{projectId:p}),runtime=report.runtime as Array<{status:string;protocol:string;certification:string;source:string;channel:unknown;reason:string;identityKey:unknown}>;
      expect(runtime.length).toBeGreaterThanOrEqual(1);
      // R194：不再有人话「未认证/证据匹配」——图片随消息直接发送，无需逐运行时证书。
      for(const item of runtime){
        expect(item).toMatchObject({status:'supported',protocol:'适配器图片字节直传',certification:'not-required',source:'随消息直接发送',channel:null,identityKey:null});
        expect(item.reason).toContain('图片随消息直接发送');
        expect(item.reason).not.toContain('未认证');
      }
      expect((db.prepare('SELECT count(*) n FROM real_calls').get() as {n:number}).n).toBe(0);
    }finally{db.close();}
  });
});
