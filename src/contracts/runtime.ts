/**
 * 自有运行时适配器契约（主设计 §9.3/§9.4）。
 * 这是众说的接口设计，不是任一厂商 API 的原样定义；厂商类型不渗入 domain。
 * probe 返回 unverified 时不能按支持处理；不支持的方法返回 CAPABILITY_UNSUPPORTED。
 */
import { z } from 'zod';
import type { Support } from './common.ts';
import type { ErrorCode } from './errors.ts';

export type RuntimeAdapterId = string;
export type AdapterSessionId = string;

/** §9.3 能力表（三态；restrictWrites/interactiveApprovals 须按版本/平台/模式分别认证）。 */
export interface RuntimeCapabilities {
  structuredEvents: Support;
  /** 会话、隐式记忆与历史加载可约束至当前任务。 */
  taskContextIsolation: Support;
  resumeSession: Support;
  steerActiveTurn: Support;
  interrupt: Support;
  interactiveApprovals: Support;
  structuredFinal: Support;
  restrictWrites: Support;
  restrictShell: Support;
  disableDelegation: Support;
  usageTokens: Support;
  usageCost: Support;
}

export const runtimeCapabilitiesSchema = z.strictObject({
  structuredEvents: z.enum(['supported', 'unsupported', 'unverified']),
  taskContextIsolation: z.enum(['supported', 'unsupported', 'unverified']),
  resumeSession: z.enum(['supported', 'unsupported', 'unverified']),
  steerActiveTurn: z.enum(['supported', 'unsupported', 'unverified']),
  interrupt: z.enum(['supported', 'unsupported', 'unverified']),
  interactiveApprovals: z.enum(['supported', 'unsupported', 'unverified']),
  structuredFinal: z.enum(['supported', 'unsupported', 'unverified']),
  restrictWrites: z.enum(['supported', 'unsupported', 'unverified']),
  restrictShell: z.enum(['supported', 'unsupported', 'unverified']),
  disableDelegation: z.enum(['supported', 'unsupported', 'unverified']),
  usageTokens: z.enum(['supported', 'unsupported', 'unverified']),
  usageCost: z.enum(['supported', 'unsupported', 'unverified']),
});

/** adapter 调用失败的结构化错误（CAPABILITY_UNSUPPORTED 等）。 */
export class AdapterCallError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AdapterCallError';
    this.code = code;
  }
}

/** §9.3 SessionRef。与 runtime_sessions 表的完整关联分开：此处只承载适配器视角。 */
export interface SessionRef {
  /** 本产品 ID。 */
  id: AdapterSessionId;
  providerSessionId: string;
  runtimeInstallationId: string;
  adapterVersion: string;
  threadId: string;
  sessionGeneration: number;
  cwd: string;
}

/** §9.3 TurnRequest。resultKey：输出合同的提交键（DEV-21；fake 据此生成合法结构化终态）。 */
export interface TurnRequest {
  turnId: string;
  dispatchKey: string;
  inputBundleId: string;
  text: string;
  policyId: string;
  taskRevision: number;
  resultKey?: string;
}

/**
 * 底层子进程身份（DEV-13 恢复对账：OS 退出证据的事实来源；adapter 如实上报，不猜测）。
 * - per-turn：每 turn 独立子进程（如 CLI 一次性调用）——PID 专属该 turn，退出证据最强；
 * - shared：常驻进程（如 App Server 长连接）——PID 由多 turn 共享，不专属单一 turn，
 *   其退出只证明「共享执行载体消失」，不能冒充该 turn 专属进程退出；
 * - none：无子进程可观测（内联/模拟执行）——无 OS 遗留进程可能。
 */
export interface AdapterProcessIdentity {
  model: 'per-turn' | 'shared' | 'none';
  pid: number | null;
}

export interface ProbeResult {
  executable: string;
  version: string;
  capabilities: RuntimeCapabilities;
}

export interface OpenSessionInput {
  projectId: string;
  memberId: string;
  taskId: string;
  threadId: string;
  sessionGeneration: number;
  cwd: string;
  policyId: string;
  resume?: SessionRef;
  /** 层 A 常驻提示词渲染快照（规格 §2.1/§5.1：会话绑定，resume 不换版）。 */
  developerInstructions?: string;
  promptVersion?: string;
}

/** §9.3 RuntimeAdapter 接口（fake/codex/claude 共同实现）。 */
export interface RuntimeAdapter {
  probe(): Promise<ProbeResult>;
  openSession(input: OpenSessionInput): Promise<SessionRef>;
  startTurn(session: SessionRef, input: TurnRequest): Promise<void>;
  events(session: SessionRef): AsyncIterable<NormalizedRuntimeEvent>;
  steer(session: SessionRef, input: TurnRequest): Promise<void>;
  interrupt(session: SessionRef, turnId: string): Promise<void>;
  respondApproval(
    session: SessionRef,
    approvalId: string,
    choice: 'allow_once' | 'deny',
  ): Promise<void>;
  close(session: SessionRef): Promise<void>;
  /**
   * 该 turn 的底层子进程身份（可选能力——恢复对账取证）。turn 已结束后仍返回其进程身份
   * （历史登记用途）；无子进程模型返回 { model: 'none', pid: null }；不实现则视为不可观测。
   */
  processIdentity?(session: SessionRef, turnId: string): AdapterProcessIdentity | null;
}

// ---------- §9.4 规范化事件 ----------

export interface RuntimeEventBase {
  /** 稳定去重键；无原生 ID 时 adapter 生成并持久关联。 */
  eventKey: string;
  sessionId: AdapterSessionId;
  /** 进程退出等事件允许无 turn。 */
  turnId?: string;
  receivedAt: number;
  providerEventId?: string;
}

export type NormalizedRuntimeEvent = RuntimeEventBase &
  (
    | { kind: 'session.ready'; providerSessionId: string }
    | { kind: 'turn.started'; providerTurnId?: string }
    | { kind: 'message.delta'; messageId: string; text: string }
    | { kind: 'message.completed'; messageId: string; text: string }
    | {
        kind: 'tool.started';
        toolCallId: string;
        toolName: string;
        argumentsSummary: string;
      }
    | {
        kind: 'tool.completed';
        toolCallId: string;
        outcome: 'success' | 'failure' | 'unknown';
        resultRef?: string;
      }
    | {
        kind: 'approval.requested';
        approvalId: string;
        request: unknown;
        allowedChoices: Array<'allow_once' | 'deny'>;
      }
    | { kind: 'input.requested'; requestId: string; question: string }
    | {
        kind: 'usage.updated';
        accounting: 'delta' | 'cumulative';
        inputTokens?: number;
        cachedTokens?: number;
        outputTokens?: number;
        cost?: number;
        currency?: string;
        costQuality: 'reported' | 'estimated' | 'unknown';
        /** 服务端回报的模型标识（原样记录；不提供则留空，不得以成功推断实际后端模型）。 */
        model?: string;
      }
    | { kind: 'turn.completed'; finalText?: string; structuredResult?: unknown }
    | { kind: 'turn.failed'; code: string; message: string; retryable: boolean }
    | { kind: 'process.exited'; exitCode: number | null; expected: boolean }
  );

export const RUNTIME_EVENT_KINDS = [
  'session.ready', 'turn.started', 'message.delta', 'message.completed',
  'tool.started', 'tool.completed', 'approval.requested', 'input.requested',
  'usage.updated', 'turn.completed', 'turn.failed', 'process.exited',
] as const;

export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

export function isTerminalRuntimeEvent(event: NormalizedRuntimeEvent): boolean {
  return event.kind === 'turn.completed' || event.kind === 'turn.failed';
}
