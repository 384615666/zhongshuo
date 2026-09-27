/**
 * 权限档位与最小确认通道契约（§4.1/§9.6 ADR-14；DEV-01 只定契约与纯判定，不调用真实模型）。
 *
 * 期望档位、实际策略和认证状态分开：期望是意图声明，不是安全承诺；
 * unverified 不得按 supported 处理；失败不自动回退 full_access。
 * 「计划模式」与「先给方案再执行」分开：前者本次止于方案。
 */
import { z } from 'zod';
import type { Support, TimestampMs } from './common.ts';

/** 输入条四档下拉：计划模式、变更前确认、自动编辑、完全访问。 */
export type PermissionTier = 'plan' | 'confirm' | 'auto_edit' | 'full_access';

/** 用户提交的权限意图（§15.2：intent 至少包含 analyze/modify 与档位意图）。 */
export type PermissionIntent = 'analyze' | 'modify';

/**
 * 档位认证证据：按 runtime/adapter 版本、平台和模式分别关联（§9.6）。
 * 变更前确认档在 RT-23/B6 验证通过前置灰禁用——输入条不得显示为可选却在发送后失败。
 */
export interface TierVerification {
  runtimeKind: string;
  runtimeVersion: string;
  adapterVersion: string;
  platform: string;
  tier: PermissionTier;
  support: Support;
  evidenceRefs: readonly string[];
  verifiedAt?: TimestampMs | null;
}

export const tierVerificationSchema = z.strictObject({
  runtimeKind: z.string().min(1),
  runtimeVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  platform: z.string().min(1),
  tier: z.enum(['plan', 'confirm', 'auto_edit', 'full_access']),
  support: z.enum(['supported', 'unsupported', 'unverified']),
  evidenceRefs: z.array(z.string()),
  verifiedAt: z.number().int().nonnegative().nullable().optional(),
});

/** 生效档位判定结果：未通过认证的档位对输入条禁用。 */
export interface EffectivePermission {
  tier: PermissionTier;
  support: Support;
  /** runtime 实际策略引用（策略 id/参数摘要）；未认证时为空。 */
  policyRef?: string | null;
}

export const effectivePermissionSchema = z.strictObject({
  tier: z.enum(['plan', 'confirm', 'auto_edit', 'full_access']),
  support: z.enum(['supported', 'unsupported', 'unverified']),
  policyRef: z.string().min(1).nullable().optional(),
});

// ---------- 原生确认请求 / 答复（§9.6） ----------

export type ApprovalStatus =
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'expired'
  | 'superseded';

/**
 * 原生确认请求：绑定 turn、provider_request_id、payload_hash 和有效期；
 * 过期、重复及旧代次答复不得授权新操作。无人回答时拒绝或明确等待，
 * 受 approvalTimeout 约束，不静默放行。
 */
export interface ApprovalRequest {
  id: string;
  turnId: string;
  providerRequestId: string;
  payloadHash: string;
  status: ApprovalStatus;
  scopeJson?: unknown;
  expiresAt: TimestampMs;
  allowedChoices: readonly ('allow_once' | 'deny')[];
}

export const approvalRequestSchema = z.strictObject({
  id: z.string().min(1),
  turnId: z.string().min(1),
  providerRequestId: z.string().min(1),
  payloadHash: z.string().min(1),
  status: z.enum(['pending', 'allowed', 'denied', 'expired', 'superseded']),
  scopeJson: z.unknown().optional(),
  expiresAt: z.number().int().nonnegative(),
  allowedChoices: z.array(z.enum(['allow_once', 'deny'])).min(1),
});

/** 用户答复：approval.respond(approvalId, choice, payloadHash)。 */
export interface ApprovalResponse {
  approvalId: string;
  choice: 'allow_once' | 'deny';
  payloadHash: string;
  respondedAt: TimestampMs;
}

export const approvalResponseSchema = z.strictObject({
  approvalId: z.string().min(1),
  choice: z.enum(['allow_once', 'deny']),
  payloadHash: z.string().min(1),
  respondedAt: z.number().int().nonnegative(),
});

/** 答复判定：accepted / expired（§15.2 approval.respond 结果只有这两种合法终态）。 */
export type ApprovalDecision = 'accepted' | 'expired';
