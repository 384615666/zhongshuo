/**
 * 幂等键纯逻辑（开工契约 §3.2 / §31.4）。
 * 回执主键 (idempotency_scope, command_id)；scope 从认证主体/连接推导；
 * payloadHash 对规范化 method/target/params（含 expectedRevision）计算，不含凭据。
 * 事务内去重的执行语义（检查 commandId→返回原结果）由 DEV-02 承担。
 */
import { createHash } from 'node:crypto';
import type { CallerContext } from '../contracts/caller.ts';
import type { CommandId, PayloadHash } from '../contracts/commands.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

/** 规范化 JSON：对象键排序、数组保序——同一 payload 不同字段顺序得到相同摘要。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface PayloadHashInput {
  method: string;
  target?: unknown;
  params: unknown;
  expectedRevision?: number | null;
}

/** SHA-256 摘要：实现记录见 ADR-I04（domain 使用 node:crypto 做纯摘要，无 IO）。 */
export function computeCommandPayloadHash(input: PayloadHashInput): PayloadHash {
  return createHash('sha256')
    .update(
      canonicalJson({
        method: input.method,
        target: input.target ?? null,
        params: input.params,
        expectedRevision: input.expectedRevision ?? null,
      }),
    )
    .digest('hex');
}

/**
 * 幂等 scope 推导：从认证主体出发；MCP 幂等记录按连接隔离
 * （不同连接的同名键互不干扰，§31.4）。
 */
export function deriveIdempotencyScope(caller: CallerContext): string {
  const p = caller.actualPrincipal;
  switch (p.kind) {
    case 'local_user':
      return `user:${p.id}`;
    case 'external_connection':
      return `conn:${caller.connectionId ?? p.id}`;
    case 'paired_device':
      return `device:${p.id}`;
    case 'agent_task_credential':
      return `taskcred:${p.id}`;
  }
}

export type IdempotencyDecision =
  | { action: 'new' }
  | { action: 'replay'; payloadHash: PayloadHash }
  | { action: 'conflict'; existingPayloadHash: PayloadHash };

/**
 * - 无回执 → new（首次提交，执行并保存回执）
 * - 同 scope+commandId 同 payloadHash → replay（返回持久结果，不重复执行；授权每次重检）
 * - 同键不同 hash → IDEMPOTENCY_CONFLICT（修正客户端重试逻辑后用新 commandId）
 */
export function evaluateIdempotency(
  existing: { commandId: CommandId; payloadHash: PayloadHash } | undefined,
  incoming: { commandId: CommandId; payloadHash: PayloadHash },
): DomainResult<IdempotencyDecision> {
  if (existing == null || existing.commandId !== incoming.commandId) {
    return domainOk({ action: 'new' });
  }
  if (existing.payloadHash === incoming.payloadHash) {
    return domainOk({ action: 'replay', payloadHash: existing.payloadHash });
  }
  return domainErr(
    'IDEMPOTENCY_CONFLICT',
    '同一 commandId 以不同内容重复提交；用新 commandId 重新提交',
    { details: { existingPayloadHash: existing.payloadHash, incomingPayloadHash: incoming.payloadHash } },
  );
}
