/**
 * 原生确认请求/答复纯判定（§9.6：过期、重复及旧代次答复不得授权新操作）。
 */
import type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalDecision,
} from '../contracts/permission.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

/**
 * 答复有效性：
 * - payloadHash 不匹配 → STALE_REVISION（旧代次/换内容答复不能授权新操作）
 * - 超过 expiresAt → expired（approvalTimeout 到期拒绝该请求，不自动允许）
 * - 请求已终结（allowed/denied/expired/superseded）→ expired（幂等拒绝重复答复）
 */
export function evaluateApprovalResponse(
  request: ApprovalRequest,
  response: ApprovalResponse,
): DomainResult<ApprovalDecision> {
  if (response.approvalId !== request.id) {
    return domainErr('RESOURCE_NOT_FOUND', '答复指向不存在的确认请求');
  }
  if (response.payloadHash !== request.payloadHash) {
    return domainErr('STALE_REVISION', '答复的 payloadHash 与请求不匹配，不得授权新操作');
  }
  if (response.respondedAt > request.expiresAt) {
    return domainOk('expired');
  }
  if (request.status !== 'pending') {
    return domainOk('expired');
  }
  return domainOk('accepted');
}
