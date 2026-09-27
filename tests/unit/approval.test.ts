import { describe, expect, it } from 'vitest';
import { evaluateApprovalResponse } from '../../src/domain/approval.ts';
import type { ApprovalRequest } from '../../src/contracts/permission.ts';

const REQ: ApprovalRequest = {
  id: 'appr_1',
  turnId: 'turn_1',
  providerRequestId: 'provider_req_1',
  payloadHash: 'hash_abc',
  status: 'pending',
  expiresAt: 1_000,
  allowedChoices: ['allow_once', 'deny'],
};

describe('原生确认请求/答复（§9.6：过期、重复及旧代次答复不得授权新操作）', () => {
  it('有效期内同 payload 答复 → accepted', () => {
    const r = evaluateApprovalResponse(REQ, {
      approvalId: 'appr_1',
      choice: 'allow_once',
      payloadHash: 'hash_abc',
      respondedAt: 900,
    });
    expect(r).toEqual({ ok: true, value: 'accepted' });
  });

  it('超时答复 → expired（approvalTimeout 到期拒绝该请求，不自动允许）', () => {
    const r = evaluateApprovalResponse(REQ, {
      approvalId: 'appr_1',
      choice: 'allow_once',
      payloadHash: 'hash_abc',
      respondedAt: 1_001,
    });
    expect(r).toEqual({ ok: true, value: 'expired' });
  });

  it('payloadHash 不匹配 → 拒绝（旧代次答复不能授权新操作）', () => {
    const r = evaluateApprovalResponse(REQ, {
      approvalId: 'appr_1',
      choice: 'deny',
      payloadHash: 'hash_new_payload',
      respondedAt: 900,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
  });

  it('重复答复已终结请求 → expired（幂等拒绝）', () => {
    const r = evaluateApprovalResponse(
      { ...REQ, status: 'allowed' },
      { approvalId: 'appr_1', choice: 'allow_once', payloadHash: 'hash_abc', respondedAt: 900 },
    );
    expect(r).toEqual({ ok: true, value: 'expired' });
  });

  it('答复指向不存在的请求 → RESOURCE_NOT_FOUND', () => {
    const r = evaluateApprovalResponse(REQ, {
      approvalId: 'appr_other',
      choice: 'deny',
      payloadHash: 'hash_abc',
      respondedAt: 900,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'RESOURCE_NOT_FOUND' } });
  });
});
