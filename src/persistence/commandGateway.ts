/**
 * 事务命令网关（开工契约 §3.2：回执、领域改动、事件、预算预占和 command_receipts
 * 在一个数据库事务提交）。
 * - 同 scope+commandId+payloadHash → 重放持久结果，不重复执行
 * - 同键不同 hash → IDEMPOTENCY_CONFLICT
 * - 回执正文被清理策略删除 → RESULT_EXPIRED（不重新执行）
 * - handler 抛错 → 整事务回滚（无部分写入），数据库层错误映射 STORAGE_UNAVAILABLE
 * 授权重检（含重放）由 daemon 命令入口在调用本网关前执行。
 */
import type { ZhongshuoDatabase } from './db.ts';
import { evaluateIdempotency } from '../domain/idempotency.ts';
import { domainErr } from '../contracts/errors.ts';
import type { CommandError, DomainResult } from '../contracts/errors.ts';

export interface CommandGatewayInput {
  idempotencyScope: string;
  commandId: string;
  payloadHash: string;
  now: number;
}

export type CommandOutcome<T> =
  | { ok: true; data: T; replayed: boolean }
  | { ok: false; error: CommandError };

export function runCommand<T>(
  db: ZhongshuoDatabase,
  input: CommandGatewayInput,
  handler: () => T,
): CommandOutcome<T> {
  let outcome: CommandOutcome<T>;
  const tx = db.transaction((inp: CommandGatewayInput): CommandOutcome<T> => {
    const existing = db
      .prepare(
        'SELECT payload_hash, result_json, result_expires_at FROM command_receipts WHERE idempotency_scope = ? AND command_id = ?',
      )
      .get(inp.idempotencyScope, inp.commandId) as
      | { payload_hash: string; result_json: string | null; result_expires_at: number | null }
      | undefined;

    const decision = evaluateIdempotency(
      existing == null ? undefined : { commandId: inp.commandId, payloadHash: existing.payload_hash },
      { commandId: inp.commandId, payloadHash: inp.payloadHash },
    );
    if (!decision.ok) return { ok: false, error: decision.error };

    if (decision.value.action === 'replay') {
      if (existing == null || existing.result_json == null) {
        return {
          ok: false,
          error: {
            code: 'RESULT_EXPIRED',
            message: '回执正文已按数据清理策略删除；用新 commandId 重新提交',
            retryable: false,
          },
        };
      }
      return { ok: true, data: JSON.parse(existing.result_json) as T, replayed: true };
    }

    const data = handler();
    db.prepare(
      'INSERT INTO command_receipts (idempotency_scope, command_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(inp.idempotencyScope, inp.commandId, inp.payloadHash, JSON.stringify(data), inp.now);
    return { ok: true, data, replayed: false };
  });

  try {
    outcome = tx.immediate(input);
  } catch (error) {
    // 事务已回滚：无部分写入。向上暴露存储层错误，不伪装成功（§12.4）。
    outcome = {
      ok: false,
      error: {
        code: 'STORAGE_UNAVAILABLE',
        message: `数据库事务失败：${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
        details: { cause: error instanceof Error ? error.name : 'unknown' },
      },
    };
  }
  return outcome;
}

/** 幂等键冲突的直接探测入口（测试与诊断用）。 */
export function getReceipt(
  db: ZhongshuoDatabase,
  scope: string,
  commandId: string,
): { payload_hash: string; result_json: string | null } | undefined {
  return db
    .prepare(
      'SELECT payload_hash, result_json FROM command_receipts WHERE idempotency_scope = ? AND command_id = ?',
    )
    .get(scope, commandId) as { payload_hash: string; result_json: string | null } | undefined;
}

export function domainErrFromOutcome<T>(outcome: CommandOutcome<T>): DomainResult<never> {
  if (outcome.ok) return domainErr('VALIDATION_INVALID', 'unreachable');
  return { ok: false, error: outcome.error };
}
