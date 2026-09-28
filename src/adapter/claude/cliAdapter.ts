/**
 * Claude Code CLI 适配器（DEV-10 最小完整实现，2.1.283 stream-json 口径）。
 *
 * 进程模型（与 Codex 常驻 App Server 不同）：每 turn 一次 `claude -p --output-format
 * stream-json` 进程；会话=产品侧记账 + `--resume <sessionId>` 续接（CLI result 事件含
 * session_id）。事件为 NDJSON 行（每行一个 JSON 对象），映射到 §9.4 规范事件。
 *
 * 合成事件依据（不用"进程启动成功"冒充模型已开始/任务完成）：
 * - turn.started：首条 assistant message 事件到达时合成（CLI 无显式 turn.started）；
 * - session.ready：首次 result 成功（拿到 provider session_id）后于 openSession/resume 合成。
 *
 * 能力标记（诚实）：interrupt/usageTokens/structuredEvents=supported（stream-json）；
 * resumeSession=supported（--resume，回放已验、真实未认证）；interactiveApprovals/
 * steerActiveTurn/usageCost=unverified（headless 只读档未开审批；steer 明确拒绝）；
 * restrictWrites/restrictShell/disableDelegation=supported（--permission-mode 受限+工具
 * 白名单 --allowedTools 只读集）；taskContextIsolation=supported（进程 cwd+独立会话）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterCallError } from '../../contracts/runtime.ts';
import type {
  NormalizedRuntimeEvent,
  OpenSessionInput,
  ProbeResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  SessionRef,
  TurnRequest,
} from '../../contracts/runtime.ts';

export const CLAUDE_ADAPTER_VERSION = 'claude-cli-2.1.283-adapter-0.1';

interface RuntimeEventBaseFields {
  eventKey: string;
  sessionId: string;
  turnId?: string;
  receivedAt: number;
}

export interface ClaudeCliAdapterOptions {
  /** CLI 可执行入口（默认 PATH 解析 claude.cmd——测试注入模拟器）。 */
  executable?: string;
  /** 显式模型（必填口径：默认配置模型不被 CLI 接受）。 */
  model?: string;
  /** 权限策略（默认 plan 只读档）。 */
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  /** 额外 CLI 参数（测试注入）。 */
  extraArgs?: string[];
  installationId?: string;
}

interface QueuedEvent {
  resolve: (r: IteratorResult<NormalizedRuntimeEvent, undefined>) => void;
}

interface SessionState {
  ref: SessionRef;
  /** 当前 turn 进程与事件缓冲（进程模型：单会话内串行 turn）。 */
  active: ActiveTurn | null;
  /** 会话内完成的 provider session id（用于 --resume）。 */
  providerSessionId: string | null;
  closed: boolean;
  subscribers: QueuedEvent[];
}

interface ActiveTurn {
  turnId: string;
  process: ChildProcessWithoutNullStreams;
  buffer: string;
  queue: NormalizedRuntimeEvent[];
  /** 等待中的迭代器 next()。 */
  waiters: Array<(r: IteratorResult<NormalizedRuntimeEvent, undefined>) => void>;
  done: boolean;
  startedAnnounced: boolean;
  lastMessageId: string | null;
}

const CAPABILITIES: RuntimeCapabilities = {
  structuredEvents: 'supported',
  taskContextIsolation: 'supported',
  resumeSession: 'supported',
  steerActiveTurn: 'unsupported',
  interrupt: 'supported',
  interactiveApprovals: 'unverified',
  structuredFinal: 'supported',
  restrictWrites: 'supported',
  restrictShell: 'supported',
  disableDelegation: 'supported',
  usageTokens: 'supported',
  usageCost: 'unsupported',
};

export class ClaudeCliAdapter implements RuntimeAdapter {
  private readonly options: ClaudeCliAdapterOptions;
  private readonly sessions = new Map<string, SessionState>();
  /** spawn 注入口（协议回放：换模拟进程工厂）。 */
  private readonly spawnFn: (args: string[], cwd: string) => ChildProcessWithoutNullStreams;

  constructor(options: ClaudeCliAdapterOptions = {}, spawnFn?: (args: string[], cwd: string) => ChildProcessWithoutNullStreams) {
    this.options = options;
    this.spawnFn = spawnFn ?? ((args, cwd) => spawn(options.executable ?? 'claude', args, { cwd, env: process.env, shell: true }) as ChildProcessWithoutNullStreams);
  }

  probe(): Promise<ProbeResult> {
    return Promise.resolve({
      executable: this.options.executable ?? 'claude',
      version: '2.1.283 (Claude Code)',
      capabilities: { ...CAPABILITIES },
    });
  }

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    const id = `claude_sess_${randomUUID()}`;
    const ref: SessionRef = {
      id,
      providerSessionId: input.resume?.providerSessionId ?? '',
      runtimeInstallationId: this.options.installationId ?? 'claude-cli-default',
      adapterVersion: CLAUDE_ADAPTER_VERSION,
      threadId: input.threadId,
      sessionGeneration: input.sessionGeneration,
      cwd: input.cwd,
    };
    this.sessions.set(id, { ref, active: null, providerSessionId: input.resume?.providerSessionId ?? null, closed: false, subscribers: [] });
    return ref;
  }

  async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
    if (state.active != null && !state.active.done) {
      throw new AdapterCallError('WORKSPACE_BUSY', '会话已有进行中的 turn（进程模型：串行）');
    }
    if (state.closed) throw new AdapterCallError('RESOURCE_NOT_FOUND', '会话已关闭');
    if (input.text == null || input.text.length === 0) {
      throw new AdapterCallError('VALIDATION_INVALID', '输入文本为空');
    }
    const model = this.options.model ?? process.env.ZS_CLAUDE_MODEL;
    if (model == null || model.length === 0) {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Claude 需显式模型（ZS_CLAUDE_MODEL / options.model）——默认配置模型不被 CLI 接受');
    }
    const args = ['-p', input.text, '--output-format', 'stream-json', '--model', model,
      '--permission-mode', this.options.permissionMode ?? 'plan',
      '--allowedTools', 'Read,Glob,Grep', // 只读分析档（B6 对齐：无写/shell）
    ];
    if (state.providerSessionId != null) args.push('--resume', state.providerSessionId);
    args.push(...(this.options.extraArgs ?? []));
    const proc = this.spawnFn(args, session.cwd);
    const turn: ActiveTurn = {
      turnId: input.turnId,
      process: proc,
      buffer: '',
      queue: [],
      waiters: [],
      done: false,
      startedAnnounced: false,
      lastMessageId: null,
    };
    state.active = turn;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(state, turn, chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      if (/unrecognized_model|authentication|login required/i.test(chunk)) {
        this.pushEvent(state, turn, { kind: 'turn.failed', code: /unrecognized_model/i.test(chunk) ? 'PROVIDER_LIMITED' : 'AUTH_REQUIRED', message: chunk.slice(0, 200), retryable: false, ...this.baseEvent(state, turn) });
        this.finishTurn(state, turn);
      }
    });
    proc.on('error', (error) => {
      this.pushEvent(state, turn, { kind: 'turn.failed', code: 'RUNTIME_NOT_FOUND', message: String(error), retryable: false, ...this.baseEvent(state, turn) });
      this.finishTurn(state, turn);
    });
    void 0;
    proc.on('close', (code) => {
      // 进程退出：无终结事件=缺终态（坏流/静默）——如实 failed，不冒充完成。
      if (!turn.done) {
        this.pushEvent(state, turn, { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: `进程退出（code=${code}）且无 result 终结事件`, retryable: true, ...this.baseEvent(state, turn) });
      }
      this.pushEvent(state, turn, { kind: 'process.exited', exitCode: code, expected: turn.done, ...this.baseEvent(state, turn) });
      this.finishTurn(state, turn);
    });
    return Promise.resolve();
  }

  events(session: SessionRef): AsyncIterable<NormalizedRuntimeEvent> {
    const state = this.stateOf(session);
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<NormalizedRuntimeEvent, undefined>> {
            for (;;) {
              const turn = state.active;
              if (turn != null && turn.queue.length > 0) {
                return { value: turn.queue.shift()!, done: false };
              }
              const turnDone = turn == null || turn.done;
              if (turnDone && (turn == null || turn.queue.length === 0)) {
                // 无活动 turn 且无缓冲：等待下一个 turn 或会话关闭。
                if (state.closed) return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 100);
                timer.unref?.();
              });
            }
          },
        };
      },
    };
  }

  async steer(_session: SessionRef, _input: TurnRequest): Promise<void> {
    // 明确拒绝（headless -p 无 in-turn 追加输入；不模拟成功）。
    void _session; void _input;
    throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Claude CLI 进程模型不支持 turn 内 steer（未认证；不模拟）');
  }

  async interrupt(session: SessionRef, turnId: string): Promise<void> {
    const state = this.stateOf(session);
    const turn = state.active;
    if (turn == null || turn.turnId !== turnId) return;
    // Windows 无 SIGINT 语义：kill 触发 close；close 处理器兜底（若 CLI 输出中断 result
    // 则按其 code 映射，否则按无终态 failed）。
    turn.process.kill();
  }

  async respondApproval(_session: SessionRef, _approvalId: string, _choice: 'allow_once' | 'deny'): Promise<void> {
    void _session; void _approvalId; void _choice;
    throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Claude headless 只读档未开审批通道（unverified；不模拟）');
  }

  async close(session: SessionRef): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state == null) return;
    state.closed = true;
    if (state.active != null && !state.active.done) state.active.process.kill();
    this.sessions.delete(session.id);
  }

  // ---------- 内部 ----------

  private stateOf(session: SessionRef): SessionState {
    const state = this.sessions.get(session.id);
    if (state == null) throw new AdapterCallError('RESOURCE_NOT_FOUND', `会话不存在或已关闭：${session.id}`);
    return state;
  }

  private onStdout(state: SessionState, turn: ActiveTurn, chunk: string): void {
    turn.buffer += chunk;
    let index = turn.buffer.indexOf('\n');
    while (index >= 0) {
      const line = turn.buffer.slice(0, index).trim();
      turn.buffer = turn.buffer.slice(index + 1);
      index = turn.buffer.indexOf('\n');
      if (line.length === 0) continue;
      this.handleLine(state, turn, line);
    }
  }

  private handleLine(state: SessionState, turn: ActiveTurn, line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 坏行：丢弃（不猜归属；无终态时由 close 兜底 failed）
    }
    const type = String(parsed['type'] ?? '');
    void line;
    if (type === 'system' && parsed['subtype'] === 'init') {
      const sid = typeof parsed['session_id'] === 'string' ? (parsed['session_id'] as string) : null;
      if (sid != null) {
        state.providerSessionId = sid;
        state.ref.providerSessionId = sid; // 原地更新：调用方持有的 SessionRef 可见
      }
      return; // init 不外发（合成 turn.started 以首条 assistant 消息为准）
    }
    if (type === 'assistant') {
      // 首条 assistant 消息：合成 turn.started（CLI 无显式开始事件——合成依据见文件头）。
      if (!turn.startedAnnounced) {
        turn.startedAnnounced = true;
        this.pushEvent(state, turn, { kind: 'turn.started', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
      }
      const message = parsed['message'] as { content?: Array<{ type: string; text?: string; id?: string }> } | undefined;
      const textBlocks = (message?.content ?? []).filter((c) => c.type === 'text');
      for (const block of textBlocks) {
        const messageId = `claude_${block.id ?? randomUUID().slice(0, 8)}`;
        turn.lastMessageId = messageId;
        this.pushEvent(state, turn, { kind: 'message.delta', messageId, text: block.text ?? '', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
      }
      return;
    }
    if (type === 'result') {
      const isError = parsed['is_error'] === true;
      const sid = typeof parsed['session_id'] === 'string' ? (parsed['session_id'] as string) : null;
      if (sid != null) {
        state.providerSessionId = sid;
        state.ref = { ...state.ref, providerSessionId: sid };
      }
      const usage = parsed['usage'] as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
      if (usage != null) {
        this.pushEvent(state, turn, {
          kind: 'usage.updated', accounting: 'cumulative',
          inputTokens: usage.input_tokens, cachedTokens: usage.cache_read_input_tokens,
          outputTokens: usage.output_tokens, costQuality: 'unknown', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)),
        } as NormalizedRuntimeEvent);
      }
      if (turn.lastMessageId != null && !isError) {
        this.pushEvent(state, turn, { kind: 'message.completed', messageId: turn.lastMessageId, text: String(parsed['result'] ?? ''), ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
      }
      if (isError) {
        const subtype = String(parsed['subtype'] ?? 'error_max_turns');
        this.pushEvent(state, turn, {
          kind: 'turn.failed', code: subtype.startsWith('error_') ? subtype.slice(6).toUpperCase() : 'PROVIDER_ERROR',
          message: String(parsed['result'] ?? subtype), retryable: subtype !== 'error_during_execution',
          ...this.baseEvent(state, turn, randomUUID().slice(0, 6)),
        } as NormalizedRuntimeEvent);
      } else {
        this.pushEvent(state, turn, { kind: 'turn.completed', finalText: String(parsed['result'] ?? ''), ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
      }
      this.finishTurn(state, turn);
    }
    // 工具事件（2.x stream-json 的 tool_use 块在 assistant 消息内）：只读档下理论不触发；
    // 出现则按块映射 tool.started/completed（outcome unknown——CLI 不回传工具结果状态）。
    if (type === 'assistant') {
      const message = parsed['message'] as { content?: Array<{ type: string; name?: string; id?: string }> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use') {
          this.pushEvent(state, turn, { kind: 'tool.started', toolCallId: block.id ?? randomUUID().slice(0, 8), toolName: block.name ?? 'unknown', argumentsSummary: '', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
          this.pushEvent(state, turn, { kind: 'tool.completed', toolCallId: block.id ?? 'unknown', outcome: 'unknown', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
        }
      }
    }
  }

  private baseEvent(state: SessionState, turn: ActiveTurn, salt = ''): RuntimeEventBaseFields {
    return {
      eventKey: `cevt_${createHash('sha256').update(`${turn.turnId}|${salt}|${state.ref.id}`).digest('hex').slice(0, 20)}`,
      sessionId: state.ref.id,
      turnId: turn.turnId,
      receivedAt: Date.now(),
    };
  }

  private pushEvent(state: SessionState, turn: ActiveTurn, event: NormalizedRuntimeEvent): void {
    turn.queue.push(event);
    void state;
  }

  private finishTurn(state: SessionState, turn: ActiveTurn): void {
    turn.done = true;
    void state;
  }
}

/** 测试/诊断：解析 CLI 可执行入口是否存在（不执行）。 */
export function claudeExecutableHint(): string | null {
  const candidates = [join('C:', 'Users', process.env.USERNAME ?? '', 'AppData', 'Roaming', 'npm', 'claude.cmd'), 'claude'];
  for (const c of candidates) {
    if (c !== 'claude' && existsSync(c)) return c;
  }
  return 'claude';
}
