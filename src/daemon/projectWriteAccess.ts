import { realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import { claudeLaunchIdentity, resolveClaudeConfiguration } from '../adapter/claude/cliAdapter.ts';
import {codexConfigurationIdentity} from '../adapter/codex/configuration.ts';
import {fileWriteCapability,CLAUDE_PROJECT_WRITE_POLICY_HASH} from '../adapter/writeCapability.ts';

export interface WriteScope {
  authorized: boolean; root: string; revision: number; physicalIdentity?:string;
}
export function physicalRootIdentity(root:string) {const s=statSync(root,{bigint:true});if(!s.isDirectory())throw Error('写入范围不是目录');return `${s.dev}:${s.ino}:${s.birthtimeNs}`;}
export function projectWriteAccess(db: ZhongshuoDatabase, projectId: string): WriteScope {
  const row = db.prepare('SELECT authorized, canonical_root, revision, physical_identity FROM project_write_authorizations WHERE project_id=?').get(projectId) as {authorized:number;canonical_root:string;revision:number;physical_identity:string}|undefined;
  return { authorized: row?.authorized === 1, root: row?.canonical_root ?? '', revision: row?.revision ?? 0,physicalIdentity:row?.physical_identity };
}
/** Task creation snapshot AND current grant AND actual physical root must match. */
export function effectiveTaskWriteAccess(db: ZhongshuoDatabase, taskId: string, memberId: string, defaultKind: string|null) {
  const row = db.prepare('SELECT t.project_id, t.write_scope_json, p.root_path, p.canonical_path, p.status FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(taskId) as {project_id:string;write_scope_json:string;root_path:string;canonical_path:string;status:string}|undefined;
  if (!row || row.status !== 'active') throw Error('项目未处于可执行状态');
  const runtime = resolveMemberRuntime(db,memberId,defaultKind);
  const current = projectWriteAccess(db,row.project_id);
  const snapshot = JSON.parse(row.write_scope_json) as Partial<WriteScope> & {memberRevision?:number;memberPermission?:string;launchIdentity?:string;runtime?:unknown};
  const member=db.prepare('SELECT project_id,settings_revision FROM project_members WHERE id=?').get(memberId) as {project_id:string;settings_revision:number}|undefined;
  if(!member || member.project_id!==row.project_id) throw Error('执行成员不属于该项目');
  const root = current.authorized ? realpathSync.native(row.canonical_path) : row.canonical_path;
  const requested = snapshot.authorized === true || (snapshot.authorized as unknown) === 1;
  if(requested && (!current.authorized || snapshot.revision !== current.revision || snapshot.root !== current.root || root !== current.root)) throw Error('项目写入授权或物理目录已变化；旧任务未派发，请明确重新提交');
  if(requested && (realpathSync.native(row.root_path)!==root || physicalRootIdentity(root)!==current.physicalIdentity)) throw Error('授权目录的物理身份或入口已变化，拒绝写入');
  if(requested && snapshot.runtime && JSON.stringify(snapshot.runtime)!==JSON.stringify(runtime)) throw Error('成员执行配置已变化；旧授权任务未派发，请明确重新提交');
  const writable = requested && ['acceptEdits','dontAsk'].includes(snapshot.memberPermission??'') && ['acceptEdits','dontAsk'].includes(runtime.permissionMode ?? '') && ['claude','codex','fake'].includes(runtime.kind ?? '');
  if(writable && runtime.kind!=='fake') {const capability=fileWriteCapability(runtime,root);if(capability.status!=='supported')throw Error(`文件写入未认证：${capability.reason}`);}
  const configuration = runtime.kind === 'claude' ? writable ? claudeLaunchIdentity({executable:runtime.executable??undefined,model:runtime.model??undefined,permissionMode:runtime.permissionMode as 'plan'},root) : resolveClaudeConfiguration(root) : null;
  if(writable && configuration?.reason) throw Error(`写入渠道配置无法确定：${configuration.reason}`);
  const launchConfigurationKey=configuration && 'identityKey' in configuration ? configuration.identityKey as string : undefined;
  const identityKey = createHash('sha256').update(JSON.stringify({projectId:row.project_id,grant:current,snapshot:{authorized:snapshot.authorized,root:snapshot.root,revision:snapshot.revision,memberRevision:snapshot.memberRevision,memberPermission:snapshot.memberPermission},root,runtime,configurationKey:runtime.kind==='codex'?codexConfigurationIdentity(root):launchConfigurationKey??configuration?.configurationKey??null,writable,writePolicyHash:writable?CLAUDE_PROJECT_WRITE_POLICY_HASH:null})).digest('hex');
  if(snapshot.launchIdentity && snapshot.launchIdentity!==identityKey) throw Error('有效渠道、执行程序、模型或权限已变化；未沿用旧任务授权');
  return { modificationAuthorized:Boolean(writable), allowedWriteRoots:writable?[root]:[], identityKey, root, launchConfigurationKey,
    tier:writable?'auto_edit' as const:'plan' as const, intent:writable?'modify' as const:'analyze' as const,
    policyId:writable?'policy-project-write':'policy-analyze' };
}
/** Called inside the original formal send transaction, never after returning its receipt. */
export function snapshotTaskWriteAccess(db:ZhongshuoDatabase,taskId:string|null) {
  if(!taskId)return;
  const task=db.prepare('SELECT owner_member_id,write_scope_json FROM tasks WHERE id=?').get(taskId) as {owner_member_id:string|null;write_scope_json:string}|undefined;
  if(!task?.owner_member_id)return;
  const snapshot=JSON.parse(task.write_scope_json) as Partial<WriteScope>;
  if(!snapshot.authorized)return;
  const effective=effectiveTaskWriteAccess(db,taskId,task.owner_member_id,process.env.ZS_RUNTIME??null);
  db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(JSON.stringify({...snapshot,runtime:resolveMemberRuntime(db,task.owner_member_id,process.env.ZS_RUNTIME??null),launchIdentity:effective.identityKey}),taskId);
}
