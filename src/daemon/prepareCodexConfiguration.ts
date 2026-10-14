import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { realpathSync } from 'node:fs';
import { CodexAppServerAdapter } from '../adapter/codex/appServerAdapter.ts';
import { codexConfigurationIdentity } from '../adapter/codex/configuration.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import { physicalRootIdentity } from './projectWriteAccess.ts';

/** CLI thread initialization may persist the current Git root's trust entry.
 * Resolve it before a NEW explicit intent is durably frozen. Never start a
 * model turn, amend a queued scope, reuse a business session, or cache readiness. */
export function createCodexConfigurationPreparation(db: ZhongshuoDatabase) {
  const active=new Map<string,Promise<void>>();
  return async(memberId:string,projectId:string):Promise<void>=>{
    const project=db.prepare('SELECT canonical_path,status FROM projects WHERE id=?').get(projectId) as {canonical_path:string;status:string}|undefined;
    const member=db.prepare('SELECT project_id,enabled FROM project_members WHERE id=?').get(memberId) as {project_id:string;enabled:number}|undefined;
    if(!project||project.status!=='active'||!member||!member.enabled||member.project_id!==projectId)throw Error('项目或执行成员已不可用；输入保留');
    const runtime=resolveMemberRuntime(db,memberId,process.env.ZS_RUNTIME??null);
    if(runtime.kind!=='codex')return;
    const root=realpathSync.native(project.canonical_path),physical=physicalRootIdentity(root);
    const key=JSON.stringify({memberId,projectId,root,physical,runtime,configuration:codexConfigurationIdentity(root)});
    const existing=active.get(key);if(existing)return existing;
    if(active.size>=16)throw Error('执行配置准备繁忙；请稍后明确重试，输入保留');
    const preparing=(async()=>{
      const adapter=new CodexAppServerAdapter({cwd:root,executable:runtime.executable??undefined,model:runtime.model??undefined,requestTimeoutMs:10_000,sandboxMode:'read-only',approvalPolicy:'never'});
      try{
        const session=await adapter.openSession({projectId,memberId,taskId:'configuration-preparation',threadId:'configuration-preparation',sessionGeneration:0,cwd:root,policyId:'configuration-preparation'});
        await adapter.close(session);
        const current=db.prepare('SELECT canonical_path,status FROM projects WHERE id=?').get(projectId) as {canonical_path:string;status:string}|undefined;
        if(!current||current.status!=='active'||realpathSync.native(current.canonical_path)!==root||physicalRootIdentity(root)!==physical||JSON.stringify(resolveMemberRuntime(db,memberId,process.env.ZS_RUNTIME??null))!==JSON.stringify(runtime))throw Error('配置准备期间项目或成员配置变化；未提交，输入保留');
      }finally{await adapter.dispose();}
    })();
    active.set(key,preparing);
    try{await preparing;}finally{if(active.get(key)===preparing)active.delete(key);}
  };
}
