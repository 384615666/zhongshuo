/**
 * 统一错误码（主设计 §16.5）与开工契约增补（CONVERSATION_SCOPE_MISMATCH、
 * TARGET_KIND_MISMATCH、RESOURCE_NOT_FOUND、CURSOR_INVALID 等）。
 * 错误码是契约层稳定标识；用户可读文案由 UI 按码组织，不在契约里堆句子。
 */

export type ErrorCode =
  // §16.5 既有
  | 'RUNTIME_NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'PROVIDER_LIMITED'
  | 'PROJECT_MISSING'
  | 'WORKSPACE_BUSY'
  | 'BASELINE_CHANGED'
  | 'OUTPUT_INVALID'
  | 'STALE_REVISION'
  | 'STALE_EXECUTION'
  | 'STORAGE_UNAVAILABLE'
  | 'WORKER_STILL_RUNNING'
  | 'RECONCILE_REQUIRED'
  | 'BUDGET_EXHAUSTED'
  | 'ARTIFACT_MISSING'
  | 'THREAD_SCOPE_MISMATCH'
  | 'CONTEXT_NOT_GRANTED'
  | 'ROOM_ARCHIVED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'SNAPSHOT_REQUIRED'
  // 开工契约 §2/§3/§6 增补
  | 'CONVERSATION_SCOPE_MISMATCH'
  | 'CONVERSATION_ARCHIVED'
  | 'TARGET_KIND_MISMATCH'
  | 'RESOURCE_NOT_FOUND'
  | 'CURSOR_INVALID'
  | 'RESULT_EXPIRED'
  | 'RESULT_CONFLICT'
  // 本包纯校验补充
  | 'INVALID_MENTION'
  | 'MEMBER_UNAVAILABLE'
  | 'OPERATION_NOT_GRANTED'
  | 'MEMBER_NOT_DISPATCHABLE'
  | 'CONTEXT_NOT_GRANTED_TO_CALLER'
  | 'VALIDATION_INVALID'
  // DELIBERATE（§6.5，DEV-08/09）
  | 'STAGE_MISMATCH'
  | 'PARTICIPANT_NOT_EXPECTED'
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_DUPLICATED'
  | 'CLAIM_COVERAGE_INCOMPLETE'
  | 'RATIFY_ALREADY_SUBMITTED'
  // DELIBERATE 成果发布协议（M1 修复轮：不可变版本/完整性）
  | 'ARTIFACT_CONFLICT'
  | 'ARTIFACT_BODY_MISSING'
  | 'ARTIFACT_BODY_MISMATCH'
  // 实验批次护栏（第十九轮一/二：fail-closed 共享日志）
  | 'BATCH_JOURNAL_CORRUPT'
  | 'BATCH_CAP_INVALID'
  | 'BATCH_BOUND_MISMATCH'
  | 'BATCH_LOCK_BUSY';

export interface CommandError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

/**
 * 纯函数统一返回形态：不抛异常、不做 IO；
 * 上游（daemon）负责把它映射为 CommandResult.error。
 */
export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CommandError };

export function domainOk<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function domainErr(
  code: ErrorCode,
  message: string,
  options: { retryable?: boolean; details?: unknown } = {},
): DomainResult<never> {
  return {
    ok: false,
    error: { code, message, retryable: options.retryable ?? false, details: options.details },
  };
}
