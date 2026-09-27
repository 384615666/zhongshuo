/**
 * fake adapter 的可脚本化编排（DEV-03：覆盖成功、失败、审批、超时、停止不响应与迟到）。
 * 脚本是纯数据；执行器在 runtimeAdapter.ts。供 DEV-05/17 的调度与隔离测试复用。
 */
import type { NormalizedRuntimeEvent } from '../../contracts/runtime.ts';

/** 去掉适配器补齐字段的规范化事件规格（distributive omit 保持判别联合）。 */
export type FakeEventSpec = DistOmit<NormalizedRuntimeEvent, 'eventKey' | 'sessionId' | 'turnId' | 'receivedAt'>;
type DistOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export type FakeScriptItem =
  | { kind: 'event'; event: FakeEventSpec }
  /** 发出 approval.requested 并阻塞，等 respondApproval 决定走向（§9.6 最小确认通道）。 */
  | {
      kind: 'waitApproval';
      approvalId: string;
      payloadHash: string;
      request?: unknown;
      onAllow: readonly FakeScriptItem[];
      onDeny: { code: string; message: string; retryable?: boolean };
    }
  /** 静默等待：超时/停止场景的无输出窗口。 */
  | { kind: 'stall'; ms: number }
  /** 本 turn 忽略 interrupt：停止不响应 fixture（RT：STOPPING 不等于已停止）。 */
  | { kind: 'unresponsiveToInterrupt' }
  /** 延迟送达：在会话第 N 个 turn（绝对序号，1 起）开始时投递（携带本 turn 的 turnId——迟到事件）。 */
  | { kind: 'late'; deliverOnTurnStartIndex: number; event: FakeEventSpec };

export type FakeTurnScript = readonly FakeScriptItem[];

// ---------- 常用编排（六类 fixture） ----------

/** 成功：增量→完成→用量→终结。 */
export function successTurn(finalText = '分析完成', messageId = 'msg_fake_1'): FakeTurnScript {
  return [
    { kind: 'event', event: { kind: 'message.delta', messageId, text: finalText.slice(0, 2) } },
    { kind: 'event', event: { kind: 'message.completed', messageId, text: finalText } },
    {
      kind: 'event',
      event: {
        kind: 'usage.updated',
        accounting: 'cumulative',
        inputTokens: 100,
        cachedTokens: 20,
        outputTokens: 50,
        costQuality: 'unknown',
      },
    },
    { kind: 'event', event: { kind: 'turn.completed', finalText } },
  ];
}

/** 失败：立即终结（可配置重试语义）。 */
export function failingTurn(code = 'PROVIDER_ERROR', message = '模拟失败', retryable = true): FakeTurnScript {
  return [{ kind: 'event', event: { kind: 'turn.failed', code, message, retryable } }];
}

/** 审批：工具调用触发确认；allow_once 继续，deny 失败。 */
export function approvalTurn(options: {
  approvalId: string;
  payloadHash: string;
  finalText?: string;
}): FakeTurnScript {
  return [
    {
      kind: 'event',
      event: { kind: 'tool.started', toolCallId: 'tool_1', toolName: 'write_file', argumentsSummary: 'a.ts' },
    },
    {
      kind: 'waitApproval',
      approvalId: options.approvalId,
      payloadHash: options.payloadHash,
      onAllow: [
        { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'tool_1', outcome: 'success' } },
        { kind: 'event', event: { kind: 'turn.completed', finalText: options.finalText ?? '已执行' } },
      ],
      onDeny: { code: 'PERMISSION_DENIED', message: '用户拒绝', retryable: false },
    },
  ];
}

/** 超时：长静默（调度侧 turnDeadline / interrupt 决定结局）。 */
export function stuckTurn(ms = 10_000): FakeTurnScript {
  return [{ kind: 'stall', ms }];
}

/** 停止不响应：忽略 interrupt 直到脚本自然走完（或永不完）。 */
export function unresponsiveTurn(): FakeTurnScript {
  return [{ kind: 'unresponsiveToInterrupt' }, { kind: 'stall', ms: 60_000 }];
}

/** 迟到：本 turn 正常终结，但一条本 turn 事件在下一个 turn（会话第 2 个）开始后才送达。 */
export function lateFollowUp(): FakeTurnScript {
  return [
    { kind: 'event', event: { kind: 'turn.completed', finalText: '第一轮完成' } },
    {
      kind: 'late',
      deliverOnTurnStartIndex: 2,
      event: { kind: 'message.completed', messageId: 'msg_late', text: '迟到结果' },
    },
  ];
}
