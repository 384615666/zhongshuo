import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {execFileSync} from 'node:child_process';
import {isAbsolute,relative,sep} from 'node:path';
import { CodexAppServerAdapter } from '../adapter/codex/appServerAdapter.ts';
import { codexConfigurationIdentity,captureCodexConfigurationPreparation,codexConfigurationPreparationUnchanged } from '../adapter/codex/configuration.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import { physicalRootIdentity,projectWriteAccess } from './projectWriteAccess.ts';

/** In-process proof from the verified preparation window, never a new read
 * chosen by the caller after awaiting preparation. */
export interface PreparedRuntimeConfiguration {
  readonly memberId:string;
  readonly projectId:string;
  assertCurrent():void;
}

function verifiedTrustRoots(root:string):string[]{
  try{
    const gitRoot=realpathSync.native(execFileSync('git',['-C',root,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:2_000,maxBuffer:16_384,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim());
    const child=relative(gitRoot,root);
    if(child===''||!isAbsolute(child)&&child!=='..'&&!child.startsWith(`..${sep}`))return [...new Set([root,gitRoot])];
  }catch{/* Without verified Git ownership, only this exact cwd can initialize trust. */}
  return [root];
}

async function boundedPreparation<T>(promise:Promise<T>,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('执行配置准备或关闭超时；未提交，输入保留')),ms);timer.unref?.();})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** CLI thread initialization may persist the current Git root's trust entry.
 * Resolve it before a NEW explicit intent is durably frozen. Never start a
 * model turn, amend a queued scope, reuse a business session, or cache readiness. */
export function createCodexConfigurationPreparation(db: ZhongshuoDatabase) {
  const active=new Map<string,Promise<PreparedRuntimeConfiguration>>();
  return async(memberId:string,projectId:string):Promise<PreparedRuntimeConfiguration|null>=>{
    const project=db.prepare('SELECT canonical_path,status FROM projects WHERE id=?').get(projectId) as {canonical_path:string;status:string}|undefined;
    const member=db.prepare('SELECT project_id,enabled FROM project_members WHERE id=?').get(memberId) as {project_id:string;enabled:number}|undefined;
    if(!project||project.status!=='active'||!member||!member.enabled||member.project_id!==projectId)throw Error('项目或执行成员已不可用；输入保留');
    const runtime=resolveMemberRuntime(db,memberId,process.env.ZS_RUNTIME??null);
    if(runtime.kind!=='codex')return null;
    const root=realpathSync.native(project.canonical_path),physical=physicalRootIdentity(root),grant=projectWriteAccess(db,projectId);
    const before=captureCodexConfigurationPreparation(root);
    const key=JSON.stringify({memberId,projectId,root,physical,runtime,grant,configuration:codexConfigurationIdentity(root)});
    const existing=active.get(key);if(existing)return existing;
    if(active.size>=16)throw Error('执行配置准备繁忙；请稍后明确重试，输入保留');
    const preparing=(async()=>{
      const trustRoots=verifiedTrustRoots(root);
      const full=runtime.permissionMode==null||runtime.permissionMode==='bypassPermissions';
      const scoped=!full&&grant.authorized&&grant.root===root&&grant.physicalIdentity===physical&&['acceptEdits','dontAsk'].includes(runtime.permissionMode??'');
      const writeAccess={identityKey:createHash('sha256').update(key).digest('hex'),fullAccess:full,modificationAuthorized:full||scoped,allowedWriteRoots:scoped?[root]:[]};
      const adapter=new CodexAppServerAdapter({cwd:root,executable:runtime.executable??undefined,model:runtime.model??undefined,requestTimeoutMs:10_000,requireConfirmedClose:true,sandboxMode:full?'danger-full-access':scoped?'workspace-write':'read-only',approvalPolicy:'never'});
      try{
        const session=await boundedPreparation(adapter.openSession({projectId,memberId,taskId:'configuration-preparation',threadId:'configuration-preparation',sessionGeneration:0,cwd:root,policyId:'configuration-preparation',writeAccess}),15_000);
        await boundedPreparation(adapter.close(session),6_000);
      }finally{await boundedPreparation(adapter.dispose(),6_000);}
      const assertScope=()=>{
        const current=db.prepare('SELECT canonical_path,status FROM projects WHERE id=?').get(projectId) as {canonical_path:string;status:string}|undefined;
        const currentMember=db.prepare('SELECT project_id,enabled FROM project_members WHERE id=?').get(memberId) as {project_id:string;enabled:number}|undefined;
        if(!current||current.status!=='active'||!currentMember?.enabled||currentMember.project_id!==projectId||realpathSync.native(current.canonical_path)!==root||physicalRootIdentity(root)!==physical||JSON.stringify(resolveMemberRuntime(db,memberId,process.env.ZS_RUNTIME??null))!==JSON.stringify(runtime)||JSON.stringify(projectWriteAccess(db,projectId))!==JSON.stringify(grant))throw Error('配置准备期间项目或成员配置变化；未提交，输入保留');
      };
      assertScope();
      const after=captureCodexConfigurationPreparation(root);
      if(!codexConfigurationPreparationUnchanged(before,after,trustRoots))throw Error('配置准备期间有效 Codex 配置或环境变化；未提交，输入保留');
      return Object.freeze({memberId,projectId,assertCurrent:()=>{
        assertScope();
        // No trust exception after initialization closes: every byte/environment
        // input must still equal the proof accepted inside that exact window.
        if(captureCodexConfigurationPreparation(root).identityV1!==after.identityV1)throw Error('配置准备后有效 Codex 配置或环境变化；未提交，输入保留');
      }});
    })();
    active.set(key,preparing);
    try{return await preparing;}finally{if(active.get(key)===preparing)active.delete(key);}
  };
}
