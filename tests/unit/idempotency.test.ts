import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeCommandPayloadHash,
  deriveIdempotencyScope,
  evaluateIdempotency,
} from '../../src/domain/idempotency.ts';
import { commandEnvelopeSchema } from '../../src/contracts/commands.ts';
import { commandIdSchema } from '../../src/contracts/commands.ts';
import { z } from 'zod';

describe('幂等键与回执判定（开工契约 §3.2/§31.4）', () => {
  it('commandId 幂等键类型存在且约束长度（MCP create/send/steer 必带）', () => {
    expect(commandIdSchema.safeParse('cmd_12345678').success).toBe(true);
    expect(commandIdSchema.safeParse('short').success).toBe(false);
  });

  it('同键同 payloadHash → replay（返回原结果，不重复执行）', () => {
    const r = evaluateIdempotency(
      { commandId: 'cmd-1', payloadHash: 'h1' },
      { commandId: 'cmd-1', payloadHash: 'h1' },
    );
    expect(r).toEqual({ ok: true, value: { action: 'replay', payloadHash: 'h1' } });
  });

  it('同键不同 payloadHash → IDEMPOTENCY_CONFLICT', () => {
    const r = evaluateIdempotency(
      { commandId: 'cmd-1', payloadHash: 'h1' },
      { commandId: 'cmd-1', payloadHash: 'h2' },
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('不同键 → new（视为新的提交）', () => {
    const r = evaluateIdempotency(
      { commandId: 'cmd-1', payloadHash: 'h1' },
      { commandId: 'cmd-2', payloadHash: 'h1' },
    );
    expect(r).toEqual({ ok: true, value: { action: 'new' } });
  });

  it('无回执 → new', () => {
    const r = evaluateIdempotency(undefined, { commandId: 'cmd-1', payloadHash: 'h1' });
    expect(r).toEqual({ ok: true, value: { action: 'new' } });
  });

  it('幂等 scope 按连接隔离：不同连接的同名键互不干扰', () => {
    const scopeA = deriveIdempotencyScope({
      actualPrincipal: { kind: 'external_connection', id: 'conn_A' },
      entry: 'mcp',
      credentialId: 'c',
      connectionId: 'conn_A',
      projectIds: ['p1'],
      conversationScope: { kind: 'all_in_project' },
      operations: ['read'],
      dispatchMemberScope: { kind: 'all_enabled' },
      grantRevision: 0,
    });
    const scopeB = deriveIdempotencyScope({
      actualPrincipal: { kind: 'external_connection', id: 'conn_B' },
      entry: 'mcp',
      credentialId: 'c',
      connectionId: 'conn_B',
      projectIds: ['p1'],
      conversationScope: { kind: 'all_in_project' },
      operations: ['read'],
      dispatchMemberScope: { kind: 'all_enabled' },
      grantRevision: 0,
    });
    expect(scopeA).toBe('conn:conn_A');
    expect(scopeB).toBe('conn:conn_B');
    expect(scopeA).not.toBe(scopeB);
  });

  it('本地用户与 zs 任务凭据的 scope 不同主体', () => {
    expect(
      deriveIdempotencyScope({
        actualPrincipal: { kind: 'local_user', id: 'u1' },
        entry: 'ui',
        credentialId: 'c',
        projectIds: [],
        conversationScope: { kind: 'all_in_project' },
        operations: [],
        dispatchMemberScope: { kind: 'all_enabled' },
        grantRevision: 0,
      }),
    ).toBe('user:u1');
  });
});

describe('payloadHash 规范化', () => {
  it('对象键顺序不同 → 相同摘要（重试不误报冲突）', () => {
    const a = computeCommandPayloadHash({
      method: 'message.submit',
      params: { body: 'x', mentions: [{ kind: 'member', memberId: 'm_a' }], intent: 'default' },
    });
    const b = computeCommandPayloadHash({
      params: { intent: 'default', mentions: [{ kind: 'member', memberId: 'm_a' }], body: 'x' },
      method: 'message.submit',
    });
    expect(a).toBe(b);
  });

  it('expectedRevision 参与摘要（含 expectedRevision）；凭据不参与', () => {
    const base = { method: 't', params: { a: 1 } };
    const withRev = computeCommandPayloadHash({ ...base, expectedRevision: 3 });
    const withoutRev = computeCommandPayloadHash(base);
    expect(withRev).not.toBe(withoutRev);
  });

  it('canonicalJson：嵌套结构与数组保序', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: true, c: null }] })).toBe(
      '{"a":[2,{"c":null,"d":true}],"b":1}',
    );
  });
});

describe('CommandEnvelope：契约层不接受自报 authorId（§31.1 第 2 条）', () => {
  const params = z.object({ body: z.string() });

  it('合法信封通过', () => {
    const r = commandEnvelopeSchema(params).safeParse({
      protocolVersion: 1,
      commandId: 'cmd-12345678',
      method: 'message.submit',
      projectId: 'p1',
      params: { body: 'hi' },
    });
    expect(r.success).toBe(true);
  });

  it('携带自报 authorId 的信封解析失败（strict schema）', () => {
    const r = commandEnvelopeSchema(params).safeParse({
      protocolVersion: 1,
      commandId: 'cmd-12345678',
      method: 'message.submit',
      projectId: 'p1',
      authorId: 'user_attacker',
      params: { body: 'hi' },
    });
    expect(r.success).toBe(false);
  });

  it('协议版本不匹配被拒绝', () => {
    const r = commandEnvelopeSchema(params).safeParse({
      protocolVersion: 2,
      commandId: 'cmd-12345678',
      method: 'm',
      params: { body: 'x' },
    });
    expect(r.success).toBe(false);
  });
});
