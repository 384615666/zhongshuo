import { claudeLaunchIdentity, CLAUDE_ADAPTER_VERSION } from '../adapter/claude/cliAdapter.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import certification from '../adapter/image-certification-r76.json' with { type: 'json' };
import { codexChannelDescription } from '../adapter/codex/configuration.ts';

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
export function memberImageCapability(db: ZhongshuoDatabase, memberId: string) {
  const runtime = resolveMemberRuntime(db, memberId, process.env.ZS_RUNTIME ?? null);
  const project = db.prepare('SELECT p.canonical_path FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.id=?').get(memberId) as {canonical_path:string} | undefined;
  const base = { memberId, kind: runtime.kind, model: runtime.model, permissionMode: runtime.permissionMode ?? 'plan',
    status: 'unverified' as 'supported' | 'unverified' | 'unsupported', evidence: null as string | null,
    channel: runtime.kind === 'codex' ? codexChannelDescription(project?.canonical_path ?? process.cwd()) : '无法确定', endpointSource: null as string | null,
    configuration: runtime.kind == null ? '未配置' : runtime.model == null ? '模型ID未指定' : '已配置', protocol: ['claude','codex'].includes(runtime.kind ?? '') ? '适配器图片字节协议回放通过' : '未验证',
    reason: '本组合尚无真实识图认证', identityKey: null as string | null,
  };
  if (runtime.kind === 'fake') return { ...base, status: 'unsupported' as const, reason: '模拟运行时不作真实识图认证' };
  if (runtime.kind !== 'claude') return { ...base, reason: runtime.kind === 'codex' ? 'R76 gpt-6-luna 上游响应等待超时；没有真实识图结果，不代表模型名称无效或不支持图片' : '运行时未配置或未支持图片协议' };
  if (project == null) return { ...base, reason: '成员项目上下文缺失，无法核实执行配置' };
  try {
    const identity = claudeLaunchIdentity({ executable: runtime.executable ?? undefined, model: runtime.model ?? undefined,
      permissionMode: (runtime.permissionMode ?? 'plan') as 'plan' }, project.canonical_path);
    const actual = { ...base, channel: identity.channel, endpointSource: identity.endpointSource, identityKey: identity.identityKey };
    const mismatches = claudeCertificationMismatches(identity, runtime.model, runtime.permissionMode);
    return mismatches.length ? { ...actual, reason: mismatches.join('；') } : { ...actual, status: 'supported' as const, evidence: certification.evidence, reason: '真实识图已认证（工程 PNG；当前 CLI、渠道、模型ID与 plan 权限匹配）' };
  } catch { return { ...base, reason: 'CLI 或执行配置不可读，无法核实认证身份' }; }
}
