import { realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import { claudeLaunchIdentity, resolveClaudeConfiguration } from '../adapter/claude/cliAdapter.ts';
import {codexConfigurationIdentity,codexConfigurationIdentityV2,legacyCodexConfigurationIdentity} from '../adapter/codex/configuration.ts';
import {CLAUDE_PROJECT_WRITE_POLICY_HASH} from '../adapter/writeCapability.ts';

export interface WriteScope {
  authorized: boolean; root: string; revision: number; physicalIdentity?:string;
}
export function physicalRootIdentity(root:string) {const s=statSync(root,{bigint:true});if(!s.isDirectory())throw Error('写入范围不是目录');return `${s.dev}:${s.ino}:${s.birthtimeNs}`;}
export function projectWriteAccess(db: ZhongshuoDatabase, projectId: string): WriteScope {
  const row = db.prepare('SELECT authorized, canonical_root, revision, physical_identity FROM project_write_authorizations WHERE project_id=?').get(projectId) as {authorized:number;canonical_root:string;revision:number;physical_identity:string}|undefined;
  return { authorized: row?.authorized === 1, root: row?.canonical_root ?? '', revision: row?.revision ?? 0,physicalIdentity:row?.physical_identity };
}
/** A continuation cannot silently promote the most recent explicit read-only
 * request back to the member's writable default. Historical task scopes stay
 * immutable; a new room root is a separate authorization decision. */
export function taskAnalysisOnly(db:ZhongshuoDatabase,taskId:string):boolean {
  const latest=db.prepare(`SELECT json_extract(payload_json,'$.execution.writeScope') scope
    FROM domain_events WHERE task_id=? AND kind='task.redispatchEnqueued'
    AND json_type(payload_json,'$.execution.writeScope')='text' ORDER BY seq DESC LIMIT 1`).get(taskId) as {scope:string}|undefined;
  if(latest)return (JSON.parse(latest.scope) as {analysisOnly?:boolean}).analysisOnly===true;
  const task=db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(taskId) as {write_scope_json:string}|undefined;
  return task!=null&&(JSON.parse(task.write_scope_json) as {analysisOnly?:boolean}).analysisOnly===true;
}
/** Task creation snapshot AND current grant AND actual physical root must match. */
export function effectiveTaskWriteAccess(db: ZhongshuoDatabase, taskId: string, memberId: string, defaultKind: string|null, requestSnapshot?:string) {
  const row = db.prepare('SELECT t.project_id, t.write_scope_json, p.root_path, p.canonical_path, p.status FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(taskId) as {project_id:string;write_scope_json:string;root_path:string;canonical_path:string;status:string}|undefined;
  if (!row || row.status !== 'active') throw Error('项目未处于可执行状态');
  const runtime = resolveMemberRuntime(db,memberId,defaultKind);
  const current = projectWriteAccess(db,row.project_id);
  const snapshot = JSON.parse(requestSnapshot??row.write_scope_json) as Partial<WriteScope> & {memberRevision?:number;memberPermission?:string;launchIdentity?:string;launchFingerprintVersion?:number;runtime?:unknown};
  const legacyClaudeSnapshot=runtime.kind==='claude'&&snapshot.launchIdentity!=null&&snapshot.launchFingerprintVersion==null;
  const legacyCodexSnapshot=runtime.kind==='codex'&&snapshot.launchIdentity!=null&&(snapshot.launchFingerprintVersion==null||snapshot.launchFingerprintVersion===1);
  const previousCodexSnapshot=runtime.kind==='codex'&&snapshot.launchIdentity!=null&&snapshot.launchFingerprintVersion===2;
  if(snapshot.launchFingerprintVersion!=null&&snapshot.launchFingerprintVersion!==2&&!(runtime.kind==='codex'&&[1,3].includes(snapshot.launchFingerprintVersion)))throw Error('执行配置指纹版本不受支持；旧输入保留，请明确重新提交');
  const member=db.prepare('SELECT project_id,settings_revision FROM project_members WHERE id=?').get(memberId) as {project_id:string;settings_revision:number}|undefined;
  if(!member || member.project_id!==row.project_id) throw Error('执行成员不属于该项目');
  if('analysisOnly' in snapshot&&snapshot.analysisOnly===true){
    const analysis=snapshot as typeof snapshot&{executionMode?:string;physicalIdentity?:string};
    const root=realpathSync.native(row.canonical_path);
    if(analysis.executionMode!=='readonly'||analysis.authorized!==false)throw Error('仅分析请求的权限快照不一致；未派发');
    if(JSON.stringify(analysis.runtime)!==JSON.stringify(runtime))throw Error('成员执行配置已变化；仅分析请求保留，请明确重新提交');
    if(analysis.root!==root||analysis.physicalIdentity!==physicalRootIdentity(root))throw Error('项目物理身份已变化；仅分析请求保留，请明确重新提交');
    const configuration=runtime.kind==='claude'?claudeLaunchIdentity({executable:runtime.executable??undefined,model:runtime.model??undefined,permissionMode:'plan',effort:runtime.effort??undefined},root):null;
    const identityKey=createHash('sha256').update(JSON.stringify({projectId:row.project_id,root,runtime,mode:'analysis-readonly-v1',configuration:configuration?.identityKey??(runtime.kind==='codex'?codexConfigurationIdentity(root):null)})).digest('hex');
    const comparisonIdentity=previousCodexSnapshot?createHash('sha256').update(JSON.stringify({projectId:row.project_id,root,runtime,mode:'analysis-readonly-v1',configuration:codexConfigurationIdentityV2(root)})).digest('hex'):identityKey;
    if(analysis.launchIdentity&&analysis.launchIdentity!==comparisonIdentity)throw Error('有效执行配置已变化；未沿用旧只读分析请求');
    return {fullAccess:false,modificationAuthorized:false,analysisOnly:true,allowedWriteRoots:[],identityKey,root,launchConfigurationKey:configuration?.identityKey,tier:'plan' as const,intent:'analyze' as const,policyId:'policy-analysis-readonly'};
  }
  if('executionMode' in snapshot && snapshot.executionMode==='readonly' && JSON.stringify(snapshot.runtime)!==JSON.stringify(runtime))throw Error('成员执行配置已变化；旧只读任务保留，请明确重新提交');
  // Only newly submitted envelopes opt into R83 full access. Historical queued tasks
  // retain their original scope, even when the member's default has changed.
  if ('executionMode' in snapshot && snapshot.executionMode === 'full') {
    const fullSnapshot = snapshot as typeof snapshot & { physicalIdentity?: string };
    const root = realpathSync.native(row.canonical_path);
    if (JSON.stringify(snapshot.runtime) !== JSON.stringify(runtime) || ![null,'bypassPermissions'].includes(runtime.permissionMode)) throw Error('成员执行配置已变化；请明确重新提交');
    if (snapshot.root !== root || fullSnapshot.physicalIdentity !== physicalRootIdentity(root)) throw Error('项目物理身份已变化；请明确重新提交');
    const configuration = runtime.kind === 'claude' ? claudeLaunchIdentity({executable:runtime.executable??undefined,model:runtime.model??undefined,permissionMode:'bypassPermissions',effort:runtime.effort??undefined},root) : null;
    const identityKey = createHash('sha256').update(JSON.stringify({projectId:row.project_id,root,runtime,mode:'full',configuration:configuration?.identityKey ?? (runtime.kind==='codex'?codexConfigurationIdentity(root):null)})).digest('hex');
    const comparisonIdentity=previousCodexSnapshot?createHash('sha256').update(JSON.stringify({projectId:row.project_id,root,runtime,mode:'full',configuration:codexConfigurationIdentityV2(root)})).digest('hex'):legacyClaudeSnapshot||legacyCodexSnapshot?createHash('sha256').update(JSON.stringify({projectId:row.project_id,root,runtime,mode:'full',configuration:legacyCodexSnapshot?legacyCodexConfigurationIdentity(root):configuration?.legacyIdentityKey??null})).digest('hex'):identityKey;
    if(snapshot.launchIdentity && snapshot.launchIdentity!==comparisonIdentity) throw Error('有效执行配置已变化；未沿用旧会话');
    return {fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey,root,launchConfigurationKey:configuration?.identityKey,tier:'auto_edit' as const,intent:'modify' as const,policyId:'policy-full-access'};
  }
  const root = current.authorized ? realpathSync.native(row.canonical_path) : row.canonical_path;
  const requested = snapshot.authorized === true || (snapshot.authorized as unknown) === 1;
  if(requested && (!current.authorized || snapshot.revision !== current.revision || snapshot.root !== current.root || root !== current.root)) throw Error('项目写入授权或物理目录已变化；旧任务未派发，请明确重新提交');
  if(requested && (realpathSync.native(row.root_path)!==root || physicalRootIdentity(root)!==current.physicalIdentity)) throw Error('授权目录的物理身份或入口已变化，拒绝写入');
  if(requested && snapshot.runtime && JSON.stringify(snapshot.runtime)!==JSON.stringify(runtime)) throw Error('成员执行配置已变化；旧授权任务未派发，请明确重新提交');
  const writable = requested && ['acceptEdits','dontAsk'].includes(snapshot.memberPermission??'') && ['acceptEdits','dontAsk'].includes(runtime.permissionMode ?? '') && ['claude','codex','fake'].includes(runtime.kind ?? '');
  const configuration = runtime.kind === 'claude' ? writable ? claudeLaunchIdentity({executable:runtime.executable??undefined,model:runtime.model??undefined,permissionMode:runtime.permissionMode as 'plan',effort:runtime.effort??undefined},root) : resolveClaudeConfiguration(root) : null;
  if(writable && configuration?.reason) throw Error(`写入渠道配置无法确定：${configuration.reason}`);
  const launchConfigurationKey=configuration && 'identityKey' in configuration ? configuration.identityKey as string : undefined;
  const identityKey = createHash('sha256').update(JSON.stringify({projectId:row.project_id,grant:current,snapshot:{authorized:snapshot.authorized,root:snapshot.root,revision:snapshot.revision,memberRevision:snapshot.memberRevision,memberPermission:snapshot.memberPermission},root,runtime,configurationKey:runtime.kind==='codex'?codexConfigurationIdentity(root):launchConfigurationKey??configuration?.configurationKey??null,writable,writePolicyHash:writable?CLAUDE_PROJECT_WRITE_POLICY_HASH:null})).digest('hex');
  const legacyConfiguration=configuration&&'legacyIdentityKey' in configuration?configuration.legacyIdentityKey:configuration?.legacyConfigurationKey;
  const comparisonIdentity=previousCodexSnapshot||legacyClaudeSnapshot||legacyCodexSnapshot?createHash('sha256').update(JSON.stringify({projectId:row.project_id,grant:current,snapshot:{authorized:snapshot.authorized,root:snapshot.root,revision:snapshot.revision,memberRevision:snapshot.memberRevision,memberPermission:snapshot.memberPermission},root,runtime,configurationKey:previousCodexSnapshot?codexConfigurationIdentityV2(root):legacyCodexSnapshot?legacyCodexConfigurationIdentity(root):legacyConfiguration??null,writable,writePolicyHash:writable?CLAUDE_PROJECT_WRITE_POLICY_HASH:null})).digest('hex'):identityKey;
  if(snapshot.launchIdentity && snapshot.launchIdentity!==comparisonIdentity) throw Error('有效渠道、执行程序、模型或权限已变化；未沿用旧任务授权');
  return { fullAccess:false, modificationAuthorized:Boolean(writable), allowedWriteRoots:writable?[root]:[], identityKey, root, launchConfigurationKey,
    tier:writable?'auto_edit' as const:'plan' as const, intent:writable?'modify' as const:'analyze' as const,
    policyId:writable?'policy-project-write':'policy-analyze' };
}
/** A newly authorized ordinary question gets its own current configuration
 * snapshot. The original task and every already queued request remain immutable. */
export function snapshotConversationWriteAccess(db:ZhongshuoDatabase,taskId:string,defaultKind:string|null,memberId?:string,options?:{analysisOnly?:boolean}) {
  const row=db.prepare('SELECT owner_member_id,project_id FROM tasks WHERE id=?').get(taskId) as {owner_member_id:string;project_id:string};
  if(memberId)row.owner_member_id=memberId;
  const runtime=resolveMemberRuntime(db,row.owner_member_id,defaultKind),grant=projectWriteAccess(db,row.project_id);
  const p=db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(row.project_id) as {canonical_path:string};
  let snapshot:Record<string,unknown>;
  if(options?.analysisOnly===true||taskAnalysisOnly(db,taskId)){
    const root=realpathSync.native(p.canonical_path);snapshot={executionMode:'readonly',analysisOnly:true,authorized:false,root,physicalIdentity:physicalRootIdentity(root),runtime};
  }else if(runtime.permissionMode==='bypassPermissions'||runtime.permissionMode==null&&['claude','codex'].includes(runtime.kind??'')){
    const root=realpathSync.native(p.canonical_path);snapshot={executionMode:'full',root,physicalIdentity:physicalRootIdentity(root),runtime};
  }else{
    const member=db.prepare('SELECT settings_revision FROM project_members WHERE id=?').get(row.owner_member_id) as {settings_revision:number};
    snapshot={authorized:grant.authorized,root:grant.root,revision:grant.revision,memberRevision:member.settings_revision,memberPermission:runtime.permissionMode,runtime,...(!grant.authorized?{executionMode:'readonly'}:{})};
  }
  const effective=effectiveTaskWriteAccess(db,taskId,row.owner_member_id,defaultKind,JSON.stringify(snapshot));
  return JSON.stringify({...snapshot,launchIdentity:effective.identityKey,...(['claude','codex'].includes(runtime.kind??'')?{launchFingerprintVersion:runtime.kind==='codex'?3:2}:{})});
}
/** Called inside the original formal send transaction, never after returning its receipt. */
export function snapshotTaskWriteAccess(db:ZhongshuoDatabase,taskId:string|null,options?:{analysisOnly?:boolean}) {
  if(!taskId)return;
  const task=db.prepare('SELECT owner_member_id,write_scope_json FROM tasks WHERE id=?').get(taskId) as {owner_member_id:string|null;write_scope_json:string}|undefined;
  if(!task?.owner_member_id)return;
  if(options?.analysisOnly){
    db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(snapshotConversationWriteAccess(db,taskId,process.env.ZS_RUNTIME??null,undefined,options),taskId);
    return;
  }
  let snapshot=JSON.parse(task.write_scope_json) as Partial<WriteScope> & {executionMode?:string;runtime?:unknown};
  const runtime=resolveMemberRuntime(db,task.owner_member_id,process.env.ZS_RUNTIME??null);
  if(runtime.permissionMode==='bypassPermissions' || runtime.permissionMode==null&&['claude','codex'].includes(runtime.kind??'')) {
    const p=db.prepare('SELECT p.canonical_path FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(taskId) as {canonical_path:string};
    const root=realpathSync.native(p.canonical_path);
    snapshot={executionMode:'full',root,physicalIdentity:physicalRootIdentity(root),runtime};
    db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(JSON.stringify(snapshot),taskId);
    const effective=effectiveTaskWriteAccess(db,taskId,task.owner_member_id,process.env.ZS_RUNTIME??null);
    db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(JSON.stringify({...snapshot,launchIdentity:effective.identityKey,...(['claude','codex'].includes(runtime.kind??'')?{launchFingerprintVersion:runtime.kind==='codex'?3:2}:{})}),taskId);
    return;
  }
  if(!snapshot.authorized){
    if(['claude','codex'].includes(runtime.kind??''))db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(JSON.stringify({...snapshot,executionMode:'readonly',runtime}),taskId);
    return;
  }
  const effective=effectiveTaskWriteAccess(db,taskId,task.owner_member_id,process.env.ZS_RUNTIME??null);
  db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(JSON.stringify({...snapshot,runtime:resolveMemberRuntime(db,task.owner_member_id,process.env.ZS_RUNTIME??null),launchIdentity:effective.identityKey,...(['claude','codex'].includes(runtime.kind??'')?{launchFingerprintVersion:runtime.kind==='codex'?3:2}:{})}),taskId);
}
