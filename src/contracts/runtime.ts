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
  readonly notStarted:boolean;
  constructor(code: ErrorCode, message: string, notStarted=false) {
    super(message);
    this.name = 'AdapterCallError';
    this.code = code;
    this.notStarted=notStarted;
  }
}

/** §9.3 SessionRef。与 runtime_sessions 表的完整关联分开：此处只承载适配器视角。 */
export interface SessionRef {
  /** 本产品 ID。 */
  id: AdapterSessionId;
  providerSessionId: string;
  /**
   * 同轮 provider 上报过的全部非空 session_id（第二十二轮三；adapter 维护，按上报顺序去重）。
   * 长度>1 = 同轮身份冲突（协议异常）——终态结算不取任何单值冒充原生续接，如实记录。
   * 可选=旧 adapter/测试基建不维护时视为单值（providerSessionId 即唯一上报）。
   */
  observedSessionIds?: string[];
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
  /** Validation-only repair: adapters must not execute write-capable tools. */
  repairOnly?: boolean;
  /**
   * Actual frozen workflow-stage key for this turn, when the caller knows it.
   * Adapters only echo this fact; they never infer a stage from tool activity.
   */
  stage?: string;
  /** Protocol transport support is separate from real model vision certification. */
  images?: Array<{ artifactId: string; hash: string; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; dataBase64: string }>;
  /** Transient launch identity; never changes the frozen send envelope. */
  imageConfigurationKey?: string;
  /** Optional authoritative output contract; transport must preserve, never synthesize success. */
  outputSchema?: Record<string,unknown>;
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
  /**
   * 受管稳定身份（REC-LIFE-1 第十四轮二）：spawn 经受管桥时为该 job 的稳定 jobId
   * （创建时刻+pid——PID 可复用，不构成唯一身份）；未受管/不可知=null。恢复链
   * （probe/reconcile/releaseProtection）按它查找并核对受管证据，PID 仅辅助属性。
   */
  managedJobId?: string | null;
}

export interface ProbeResult {
  executable: string;
  version: string;
  capabilities: RuntimeCapabilities;
}

export interface OpenSessionInput {
  /** Effective immutable project/member scope; absent remains read-only. */
  writeAccess?: {
    fullAccess?: boolean;
    modificationAuthorized: boolean;
    /** Request-level analysis mode. It requires a non-writable scope and is enforced by the adapter. */
    analysisOnly?: boolean;
    allowedWriteRoots: string[];
    identityKey: string;
    launchConfigurationKey?: string;
  };
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
  /**
   * 拉取该 turn 截止/UNKNOWN 后到达的迟到事件（可选能力——第八轮迟到成果正式接收路径）。
   * 返回事件须为 runtime 真实通道产出（持久化会话记录/重连后的存量流），**不是调用方注入**；
   * eventKey 稳定（消费方按其幂等）。不支持（如 CLI 无会话持久化）返回 { supported: false }
   * ——由能力矩阵/UI 如实标注，不靠直接调用处理函数冒充生产支持。
   */
  lateEvents?(session: { id: AdapterSessionId }, turnId: string): Promise<
    | { supported: true; events: NormalizedRuntimeEvent[] }
    | { supported: false; reason: string }
  >;
}

// ---------- §9.4 规范化事件 ----------

export interface RuntimeEventBase {
  /** 稳定去重键；无原生 ID 时 adapter 生成并持久关联。 */
  eventKey: string;
  sessionId: AdapterSessionId;
  /** 进程退出等事件允许无 turn。 */
  turnId?: string;
  /** Session member identity supplied by the caller (optional for legacy events). */
  memberId?: string;
  /** Frozen workflow stage supplied by the caller (optional for legacy events). */
  stage?: string;
  receivedAt: number;
  providerEventId?: string;
}

/** Factual tool activity classes shared by adapters, persistence and UI. */
export type RuntimeToolAction = 'read' | 'search' | 'command' | 'edit' | 'other';

export type NormalizedRuntimeEvent = RuntimeEventBase &
  (
    | { kind: 'session.ready'; providerSessionId: string }
    | { kind: 'turn.started'; providerTurnId?: string }
    | { kind: 'message.delta'; messageId: string; text: string }
    | { kind: 'message.progress'; messageId: string; text: string }
    | { kind: 'message.completed'; messageId: string; text: string; controlResult?:string }
    | {
        kind: 'tool.started';
        toolCallId: string;
        toolName: string;
        /** New adapters always classify; absent on legacy persisted events. */
        action?: RuntimeToolAction;
        /** Short, redacted primary target/path/command (not model-authored prose). */
        target?: string;
        /** Short, redacted JSON summary of selected input fields. */
        argumentsSummary: string;
        /** Project-relative paths explicitly present in a structured fileChange item. */
        paths?: string[];
      }
    | {
        kind: 'tool.completed';
        toolCallId: string;
        outcome: 'success' | 'failure' | 'unknown';
        /** Echoed from the matching start event when the transport omits details. */
        action?: RuntimeToolAction;
        target?: string;
        /** Short, redacted factual failure detail; never a fabricated success message. */
        resultSummary?: string;
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
    | {
        kind: 'turn.failed';
        code: string;
        message: string;
        retryable: boolean;
        /** Retry authorization requires an actual provider terminal, never a
         * transport/process close or an intermediate internal retry notice. */
        failureEvidence?: {source:'provider-terminal';providerTurnId?:string};
        /**
         * Structured proof that the provider itself emitted a terminal for the exact
         * mapped turn. An interrupt RPC acknowledgement, transport close or a shared
         * process liveness check must never synthesize this fact.
         */
        terminalEvidence?: {
          source: 'provider-turn-completed';
          status: 'interrupted';
          providerTurnId: string;
        };
      }
    | { kind: 'process.exited'; exitCode: number | null; expected: boolean }
  );

export const RUNTIME_EVENT_KINDS = [
  'session.ready', 'turn.started', 'message.delta', 'message.progress', 'message.completed',
  'tool.started', 'tool.completed', 'approval.requested', 'input.requested',
  'usage.updated', 'turn.completed', 'turn.failed', 'process.exited',
] as const;

export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

export function isTerminalRuntimeEvent(event: NormalizedRuntimeEvent): boolean {
  return event.kind === 'turn.completed' || event.kind === 'turn.failed';
}
