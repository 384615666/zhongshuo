import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';

/** 图片输入：所有运行时都随消息直接接收图片字节，不再按运行时/模型/渠道组合区分能力
 * （claude=stdin 图片块、codex=data URL、pi=prompt 帧 images、DeepSeek Harness=full 模式 execute 帧 images）。
 * 保留成员/运行时/渠道等返回字段供成员详情与本地诊断读取，避免调用方结构变化。 */
export function memberImageCapability(db: ZhongshuoDatabase, memberId: string) {
  const runtime = resolveMemberRuntime(db, memberId, process.env.ZS_RUNTIME ?? null);
  return { memberId, kind: runtime.kind, model: runtime.model, permissionMode: runtime.permissionMode ?? 'bypassPermissions',
    status: 'supported' as const, evidence: null as string | null, channel: '随消息直接发送', endpointSource: null as string | null,
    configuration: runtime.kind == null ? '未配置' : runtime.model == null ? '模型ID未指定' : '已配置',
    protocol: '适配器图片字节直传', reason: '图片随消息直接发送给模型；不再区分运行时、模型或渠道',
    identityKey: null as string | null };
}
