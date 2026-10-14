import { claudeLaunchIdentity, CLAUDE_ADAPTER_VERSION } from '../adapter/claude/cliAdapter.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import {memberExecutableStatus} from './memberManagement.ts';
import certification from '../adapter/image-certification-r76.json' with { type: 'json' };
import { codexChannelDescription, codexConfigurationIdentity } from '../adapter/codex/configuration.ts';

export function claudeImageIdentity(executable?: string | null, cwd = process.cwd()) {
  const identity = claudeLaunchIdentity({ executable: executable ?? undefined, model: certification.model, permissionMode: 'plan' }, cwd);
  return { executableHash: identity.executableHash, endpointHash: identity.endpointHash, identityKey: identity.identityKey,
    channel: identity.channel, endpointSource: identity.endpointSource, reason: identity.reason, sources: identity.sources };
}

export function claudeCertificationMismatches(identity: {executableHash:string;endpointHash:string;reason:string|null}, model: string | null, permissionMode: string | null) {
  if (identity.reason != null) return [identity.reason];
  const mismatches: string[] = [];
  if (model !== certification.model) mismatches.push(`模型ID不匹配（已认证 ${certification.model}）`);
  if ((permissionMode ?? 'plan') !== 'plan') mismatches.push('权限模式不匹配（已认证 plan）');
  if (identity.executableHash !== certification.executableHash) mismatches.push('CLI 字节版本与认证不匹配');
  if (identity.endpointHash !== certification.endpointHash) mismatches.push('有效渠道与认证不匹配');
  if (CLAUDE_ADAPTER_VERSION !== certification.adapterVersion) mismatches.push('适配器版本与认证不匹配');
  return mismatches;
}

/** Immutable certificate: match the actual project launch context, never just a model label. */
export type ImageCapabilityReadContext = Map<string, ReturnType<typeof claudeLaunchIdentity>>;
export function memberImageCapability(db: ZhongshuoDatabase, memberId: string, readContext?: ImageCapabilityReadContext) {
  const runtime = resolveMemberRuntime(db, memberId, process.env.ZS_RUNTIME ?? null);
  const project = db.prepare('SELECT p.canonical_path FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.id=?').get(memberId) as {canonical_path:string} | undefined;
  const base = { memberId, kind: runtime.kind, model: runtime.model, permissionMode: runtime.permissionMode ?? 'bypassPermissions',
    status: 'unverified' as 'supported' | 'unverified' | 'unsupported', evidence: null as string | null,
    channel: runtime.kind === 'codex' ? codexChannelDescription(project?.canonical_path ?? process.cwd()) : '无法确定', endpointSource: null as string | null,
    configuration: runtime.kind == null ? '未配置' : runtime.model == null ? '模型ID未指定' : '已配置', protocol: ['claude','codex'].includes(runtime.kind ?? '') ? '适配器图片字节协议回放通过' : '未验证',
    reason: '本组合尚无真实识图认证', identityKey: null as string | null,
  };
  if (runtime.kind === 'fake') return { ...base, status: 'unsupported' as const, reason: '模拟运行时不作真实识图认证' };
  if(memberExecutableStatus(runtime.kind,runtime.executable??runtime.kind).status==='missing')return {...base,reason:'执行程序不可用，无法发送；图片原件与本地预览仍保留'};
  if(runtime.kind==='codex') return {...base,status:'supported' as const,identityKey:codexConfigurationIdentity(project?.canonical_path??process.cwd()),reason:'自动传递图片字节；真实识图结果由本次请求判定，旧超时记录保留，不视为不支持'};
  if (runtime.kind !== 'claude') return { ...base, reason: '运行时未配置或未支持图片协议' };
  if (project == null) return { ...base, reason: '成员项目上下文缺失，无法核实执行配置' };
  try {
    const options = { executable: runtime.executable ?? undefined, model: runtime.model ?? undefined,
      permissionMode: (runtime.permissionMode ?? 'bypassPermissions') as 'plan',effort:runtime.effort??undefined };
    const contextKey = JSON.stringify({ ...options, cwd: project.canonical_path });
    // Only the bulk display command supplies this request-local context. Submit/worker/adapter
    // never receive it and still re-read files, environment and managed policies independently.
    let identity = readContext?.get(contextKey);
    if (identity == null) {
      identity = claudeLaunchIdentity(options, project.canonical_path);
      readContext?.set(contextKey, identity);
    }
    const actual = { ...base, channel: identity.channel, endpointSource: identity.endpointSource, identityKey: identity.identityKey };
    const mismatches = claudeCertificationMismatches(identity, runtime.model, runtime.permissionMode);
    if(identity.reason) return {...actual,reason:identity.reason};
    return { ...actual, status: 'supported' as const, evidence: mismatches.length?null:certification.evidence, reason: mismatches.length?'自动传递图片字节；本组合无历史识图证书，渠道失败会如实提示':'自动传递图片；历史工程 PNG 识图证书匹配' };
  } catch { return { ...base, reason: 'CLI 或执行配置不可读，无法核实认证身份' }; }
}
