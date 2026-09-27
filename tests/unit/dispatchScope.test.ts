import { describe, expect, it } from 'vitest';
import { assertUserOnlyOperation, validateDispatchScope } from '../../src/domain/scope/dispatchScope.ts';
import type { PlannedDispatch } from '../../src/domain/scope/dispatchScope.ts';
import { deriveTaskSourceConnection } from '../../src/domain/scope/sourceConnection.ts';
import { localUiCaller } from '../../src/contracts/caller.ts';
import type { CallerContext } from '../../src/contracts/caller.ts';
import type { BudgetState } from '../../src/contracts/budget.ts';

const PLAN: PlannedDispatch = {
  projectId: 'p1',
  conversationId: 'conv_room_1',
  targetMemberIds: ['m_a'],
  operation: 'task.create',
};

const fullBudget: BudgetState = { grantId: 'g1', maxTurns: 6, usedTurns: 0, inFlightReservedTurns: 0 };
const emptyBudget: BudgetState = { grantId: 'g1', maxTurns: 6, usedTurns: 6, inFlightReservedTurns: 0 };

function externalCaller(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    actualPrincipal: { kind: 'external_connection', id: 'conn_1' },
    representedUserId: 'user_local',
    entry: 'mcp',
    credentialId: 'cred_conn_1',
    connectionId: 'conn_1',
    projectIds: ['p1'],
    conversationScope: { kind: 'all_in_project' },
    operations: ['read', 'conversation.read', 'message.submit', 'task.create', 'task.steer', 'task.stop'],
    dispatchMemberScope: { kind: 'listed', memberIds: ['m_a', 'm_b'] },
    budgetGrantId: 'bg_chain_1',
    grantRevision: 3,
    ...overrides,
  };
}

describe('validateDispatchScope 三维分别判断（§31.1 第 3 条）', () => {
  it('本地 UI：全维度通过', () => {
    const r = validateDispatchScope(localUiCaller('user_1', ['p1']), PLAN);
    expect(r.ok).toBe(true);
  });

  it('读不蕴含唤醒：只有 read 操作的调用者派发被拒（OPERATION_NOT_GRANTED）', () => {
    const caller = externalCaller({ operations: ['read', 'conversation.read'] });
    const r = validateDispatchScope(caller, PLAN);
    expect(r).toMatchObject({ ok: false, error: { code: 'OPERATION_NOT_GRANTED' } });
  });

  it('可读上下文不足 → CONTEXT_NOT_GRANTED_TO_CALLER（含会话级 listed 范围）', () => {
    const caller = externalCaller({
      conversationScope: { kind: 'listed', conversationIds: ['conv_dm_9'] },
    });
    const r = validateDispatchScope(caller, PLAN);
    expect(r).toMatchObject({ ok: false, error: { code: 'CONTEXT_NOT_GRANTED_TO_CALLER' } });
  });

  it('项目不在范围 → 拒绝', () => {
    const caller = externalCaller({ projectIds: ['p2'] });
    const r = validateDispatchScope(caller, PLAN);
    expect(r).toMatchObject({ ok: false, error: { code: 'CONTEXT_NOT_GRANTED_TO_CALLER' } });
  });

  it('目标成员超出可调度范围 → MEMBER_NOT_DISPATCHABLE（连接链硬上限）', () => {
    const r = validateDispatchScope(externalCaller(), { ...PLAN, targetMemberIds: ['m_a', 'm_c'] });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'MEMBER_NOT_DISPATCHABLE', details: { blockedMemberIds: ['m_c'] } },
    });
  });

  it('预算不足 → BUDGET_EXHAUSTED（任务预算维度）', () => {
    const r = validateDispatchScope(localUiCaller('u', ['p1']), { ...PLAN, taskBudget: emptyBudget });
    expect(r).toMatchObject({ ok: false, error: { code: 'BUDGET_EXHAUSTED' } });
  });

  it('连接工作链预算不足 → BUDGET_EXHAUSTED（第四维）', () => {
    const r = validateDispatchScope(externalCaller(), {
      ...PLAN,
      connectionChainBudget: emptyBudget,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'BUDGET_EXHAUSTED' } });
  });

  it('两预算均充足 → 通过', () => {
    const r = validateDispatchScope(externalCaller(), {
      ...PLAN,
      taskBudget: fullBudget,
      connectionChainBudget: fullBudget,
    });
    expect(r.ok).toBe(true);
  });

  it('all_enabled 成员范围：房间任意启用成员可派发', () => {
    const caller = externalCaller({ dispatchMemberScope: { kind: 'all_enabled' } });
    const r = validateDispatchScope(caller, { ...PLAN, targetMemberIds: ['m_c'] });
    expect(r.ok).toBe(true);
  });
});

describe('「仅用户可做」按实际调用主体判断（§31.2 归属≠权限）', () => {
  it('外部连接不能 task.review，即使 representedUserId 指向用户、代发消息 author_type=human', () => {
    const caller = externalCaller({ operations: [...externalCaller().operations, 'task.review'] as CallerContext['operations'] });
    const r = assertUserOnlyOperation(caller, 'task.review');
    expect(r).toMatchObject({ ok: false, error: { code: 'OPERATION_NOT_GRANTED' } });
  });

  it('外部连接不能 approval.respond（审批永远只属于用户）', () => {
    const r = assertUserOnlyOperation(externalCaller(), 'approval.respond');
    expect(r).toMatchObject({ ok: false, error: { code: 'OPERATION_NOT_GRANTED' } });
  });

  it('zs 任务凭据不能 member.configure', () => {
    const caller: CallerContext = {
      ...externalCaller(),
      actualPrincipal: { kind: 'agent_task_credential', id: 'cred_task_1' },
      entry: 'zs',
      connectionId: null,
    };
    const r = assertUserOnlyOperation(caller, 'member.configure');
    expect(r).toMatchObject({ ok: false, error: { code: 'OPERATION_NOT_GRANTED' } });
  });

  it('本地用户可以 task.review', () => {
    const r = assertUserOnlyOperation(localUiCaller('user_1', ['p1']), 'task.review');
    expect(r.ok).toBe(true);
  });

  it('非用户专属操作不受 USER_ONLY 限制（普通派发操作）', () => {
    const r = assertUserOnlyOperation(externalCaller(), 'task.create');
    expect(r.ok).toBe(true);
  });
});

describe('任务链来源推导（§31.8/开工契约 §3.1）', () => {
  it('本机用户新建根任务 → sourceConnectionId=null', () => {
    const r = deriveTaskSourceConnection({
      parentSourceConnectionId: null,
      callerConnectionId: null,
      isRootTask: true,
    });
    expect(r).toEqual({ ok: true, value: { sourceConnectionId: null, basis: 'local_root' } });
  });

  it('外部连接新建根任务 → 记录该连接', () => {
    const r = deriveTaskSourceConnection({
      parentSourceConnectionId: null,
      callerConnectionId: 'conn_1',
      isRootTask: true,
    });
    expect(r).toEqual({ ok: true, value: { sourceConnectionId: 'conn_1', basis: 'caller_connection' } });
  });

  it('外部任务派生的子任务：本地 zs 入口也不清空来源（继承父链）', () => {
    const r = deriveTaskSourceConnection({
      parentSourceConnectionId: 'conn_1',
      callerConnectionId: null,
      isRootTask: false,
    });
    expect(r).toEqual({ ok: true, value: { sourceConnectionId: 'conn_1', basis: 'inherit_parent' } });
  });
});
