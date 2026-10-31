import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AdapterCallError } from '../../contracts/runtime.ts';
import type { AdapterProcessIdentity, NormalizedRuntimeEvent, OpenSessionInput, ProbeResult, RuntimeAdapter, RuntimeCapabilities, SessionRef, TurnRequest } from '../../contracts/runtime.ts';
import { runtimeToolResultSummary, runtimeToolSummary, safeRuntimeToolText } from '../../contracts/runtimeProgress.ts';
import { resolveAgentExecutable, type ExternalRuntimeKind } from './executable.ts';

export type CliSpawn = (command: string, args: string[], cwd?: string) => ChildProcessWithoutNullStreams;
export interface CliAdapterOptions {
  executable?: string; model?: string; effort?: string; permissionMode?: string;
  installationId?: string; cwd?: string; spawnFn?: CliSpawn; requestTimeoutMs?: number;
}
export interface CliSession {
  ref: SessionRef; input: OpenSessionInput; requestedSessionId: string | null;
  current: CliTurn | null; closed: boolean; queue: NormalizedRuntimeEvent[]; wake: Set<() => void>;
}
export interface CliTurn {
  input: TurnRequest; child: ChildProcessWithoutNullStreams; requestId: string;
  buffer: string; stderr: string; text: string; seq: number; started: boolean;
  terminal: boolean; stopRequested: boolean; exitConfirmed: boolean; exitCode: number | null;
  ready: boolean; timers: Set<ReturnType<typeof setTimeout>>; exitWaiters: Set<() => void>;
  tools: Map<string, ReturnType<typeof runtimeToolSummary>>; values: Map<string, unknown>;
}
type EventPayload = NormalizedRuntimeEvent extends infer E ? E extends NormalizedRuntimeEvent ? Omit<E, 'eventKey' | 'sessionId' | 'turnId' | 'memberId' | 'stage' | 'receivedAt'> : never : never;
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(value);

/** Shared per-turn process lifecycle. Provider frames alone establish outcomes;
 * a process exit, RPC acknowledgement or successful spawn never means success. */
export abstract class CliTurnAdapter implements RuntimeAdapter {
  protected readonly sessions = new Map<string, CliSession>();
  private readonly turns = new Map<string, CliTurn>();
  protected readonly kind: ExternalRuntimeKind;
  protected readonly version: string;
  protected readonly options: CliAdapterOptions;
  protected constructor(kind: ExternalRuntimeKind, version: string, options: CliAdapterOptions = {}) {
    this.kind = kind; this.version = version; this.options = options;
  }
  abstract probe(): Promise<ProbeResult>;
  protected abstract arguments(session: CliSession, input: TurnRequest): string[];
  protected abstract validate(session: CliSession, input: TurnRequest): void;
  protected abstract onFrame(session: CliSession, turn: CliTurn, frame: Record<string, unknown>): void;
  protected abstract begin(session: CliSession, turn: CliTurn): void;
  protected abstract cancel(session: CliSession, turn: CliTurn): void;
  abstract capabilities(): RuntimeCapabilities;

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    if (input.resume && (input.resume.cwd !== input.cwd || input.resume.threadId !== input.threadId || !validSessionId(input.resume.providerSessionId)))
      throw new AdapterCallError('THREAD_SCOPE_MISMATCH', '续接会话与当前目录、对话串或会话编号不匹配', true);
    const ref: SessionRef = { id: `${this.kind}:${randomUUID()}`, providerSessionId: '', observedSessionIds: [],
      runtimeInstallationId: this.options.installationId ?? `${this.kind}-default`, adapterVersion: this.version,
      threadId: input.threadId, sessionGeneration: input.sessionGeneration, cwd: input.cwd };
    this.sessions.set(ref.id, { ref, input, requestedSessionId: input.resume?.providerSessionId ?? null, current: null, closed: false, queue: [], wake: new Set() });
    return ref;
  }
  async startTurn(ref: SessionRef, input: TurnRequest): Promise<void> {
    const session = this.session(ref);
    if (session.closed) throw new AdapterCallError('RESOURCE_NOT_FOUND', '执行会话已关闭', true);
    if (session.current && !session.current.exitConfirmed) throw new AdapterCallError('WORKSPACE_BUSY', '上一轮执行进程尚未退出', true);
    session.requestedSessionId = session.ref.providerSessionId || session.requestedSessionId;
    this.validate(session, input);
    const entry = resolveAgentExecutable(this.kind, this.options.executable);
    const args = [...entry.prefixArgs, ...this.arguments(session, input)];
    const child = this.options.spawnFn
      ? this.options.spawnFn(entry.command, args, ref.cwd)
      : spawn(entry.command, args, { cwd: ref.cwd, shell: false, windowsHide: true, stdio: 'pipe' });
    const turn: CliTurn = { input, child, requestId: randomUUID(), buffer: '', stderr: '', text: '', seq: 0, started: false,
      terminal: false, stopRequested: false, exitConfirmed: false, exitCode: null, ready: false,
      timers: new Set(), exitWaiters: new Set(), tools: new Map(), values: new Map() };
    session.current = turn; this.turns.set(`${ref.id}|${input.turnId}`, turn);
    child.stdin.on('error', () => { /* transport close is reconciled below */ });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(session, turn, chunk));
    child.stderr.on('data', (chunk: string) => { turn.stderr = (turn.stderr + chunk).slice(-4000); });
    child.on('error', (error) => {
      if (!turn.terminal) this.fail(session, turn, 'RUNTIME_NOT_FOUND', `执行程序启动或传输失败：${safeRuntimeToolText(error.message)}`);
    });
    child.on('close', (code) => {
      if (turn.buffer.trim()) this.receive(session, turn, '\n');
      turn.exitConfirmed = true; turn.exitCode = code;
      const expected = turn.terminal;
      for (const timer of turn.timers) clearTimeout(timer); turn.timers.clear();
      this.emit(session, turn, { kind: 'process.exited', exitCode: code, expected });
      // Without an attributable provider terminal the business outcome remains
      // unknown, including after kill. The worker owns UNKNOWN reconciliation.
      turn.terminal = true;
      for (const wake of turn.exitWaiters) wake(); turn.exitWaiters.clear(); this.wake(session);
    });
    try { this.begin(session, turn); }
    catch (error) { this.protocolFailure(session, turn, error instanceof Error ? error.message : '执行协议初始化失败'); }
  }
  private receive(session: CliSession, turn: CliTurn, chunk: string): void {
    turn.buffer += chunk;
    if (turn.buffer.length > 16 * 1024 * 1024 && !turn.buffer.includes('\n')) {
      turn.buffer = ''; this.protocolFailure(session, turn, '执行端单条消息超出协议读取上限'); return;
    }
    for (;;) {
      const index = turn.buffer.indexOf('\n'); if (index < 0) break;
      const line = turn.buffer.slice(0, index).trim(); turn.buffer = turn.buffer.slice(index + 1);
      if (!line || turn.terminal) continue;
      try {
        if (line.length > 16 * 1024 * 1024) throw Error('执行端单条消息超出协议读取上限');
        const frame: unknown = JSON.parse(line);
        if (!isRecord(frame)) throw Error('执行端消息不是对象');
        this.onFrame(session, turn, frame);
      } catch (error) { this.protocolFailure(session, turn, error instanceof Error ? error.message : '执行端返回了无效消息'); }
    }
  }
  protected protocolFailure(session: CliSession, turn: CliTurn, message: string): void {
    this.fail(session, turn, 'OUTPUT_INVALID', `执行协议不兼容：${safeRuntimeToolText(message, 320)}`);
    this.stopProcess(turn);
  }
  protected send(turn: CliTurn, frame: unknown): void {
    if (!turn.exitConfirmed && !turn.child.stdin.destroyed && !turn.child.stdin.writableEnded)
      turn.child.stdin.write(`${JSON.stringify(frame)}\n`, 'utf8');
  }
  protected timer(turn: CliTurn, action: () => void, ms: number): void {
    const timer = setTimeout(() => { turn.timers.delete(timer); action(); }, ms);
    timer.unref?.(); turn.timers.add(timer);
  }
  protected started(session: CliSession, turn: CliTurn): void {
    if (turn.started) return; turn.started = true; this.emit(session, turn, { kind: 'turn.started' });
  }
  protected sessionReady(session: CliSession, turn: CliTurn, id: unknown): void {
    if (!validSessionId(id)) throw Error('执行端没有提供有效会话编号');
    const previous = session.ref.providerSessionId;
    const observed = session.ref.observedSessionIds ?? (session.ref.observedSessionIds = []);
    if (!observed.includes(id)) observed.push(id);
    session.ref.providerSessionId = id;
    if (session.requestedSessionId && id !== session.requestedSessionId) throw Error('执行端续接了另一个会话');
    if (previous && previous !== id) throw Error('同轮执行端会话编号发生变化');
    if (previous === id) return;
    this.emit(session, turn, { kind: 'session.ready', providerSessionId: id });
  }
  protected text(session: CliSession, turn: CliTurn, text: unknown, thinking = false): void {
    if (typeof text !== 'string') throw Error('文本事件缺少有效内容');
    if (!text) return; this.started(session, turn);
    if (thinking) return; // Thinking is never presented as a final user answer.
    turn.text += text; this.emit(session, turn, { kind: 'message.delta', messageId: `${turn.input.turnId}:answer`, text });
  }
  protected toolStart(session: CliSession, turn: CliTurn, id: unknown, name: unknown, input: unknown): void {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) throw Error('工具事件缺少编号或名称');
    if (turn.tools.has(id)) return;
    this.started(session, turn);
    const summary = runtimeToolSummary(name, input, { cwd: session.ref.cwd }); turn.tools.set(id, summary);
    this.emit(session, turn, { kind: 'tool.started', toolCallId: id, toolName: name, ...summary });
  }
  protected toolEnd(session: CliSession, turn: CliTurn, id: unknown, isError: unknown, output: unknown): void {
    if (typeof id !== 'string' || !id || typeof isError !== 'boolean') throw Error('工具结果缺少有效编号或状态');
    const summary = turn.tools.get(id);
    this.emit(session, turn, { kind: 'tool.completed', toolCallId: id, outcome: isError ? 'failure' : 'success',
      ...(summary ? { action: summary.action, target: summary.target } : {}), ...(isError ? { resultSummary: runtimeToolResultSummary(output) } : {}) });
  }
  protected usage(session: CliSession, turn: CliTurn, data: Record<string, unknown>): void {
    const values: Record<string, number> = {};
    for (const key of ['inputTokens', 'cachedTokens', 'outputTokens', 'cost']) {
      const value = data[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) values[key] = value;
    }
    const model = typeof data.model === 'string' ? safeRuntimeToolText(data.model, 200) : undefined;
    if (!Object.keys(values).length && !model) return;
    this.emit(session, turn, { kind: 'usage.updated', accounting: 'delta', ...values, ...(model ? { model } : {}),
      costQuality: values.cost == null ? 'unknown' : data.costQuality === 'estimated' ? 'estimated' : 'reported' });
  }
  protected complete(session: CliSession, turn: CliTurn, text: unknown): void {
    if (turn.terminal) return;
    if (typeof text !== 'string' || !text.trim()) { this.fail(session, turn, 'OUTPUT_INVALID', '执行端报告完成，但没有提供可用结果'); return; }
    if (!session.ref.providerSessionId) { this.protocolFailure(session, turn, '完成事件缺少实际会话编号'); return; }
    this.started(session, turn);
    this.emit(session, turn, { kind: 'message.completed', messageId: `${turn.input.turnId}:answer`, text });
    this.emit(session, turn, { kind: 'turn.completed', finalText: text }); turn.terminal = true; this.endProcess(turn);
  }
  protected fail(session: CliSession, turn: CliTurn, code: string, message: string, providerTerminal = false): void {
    if (turn.terminal) return;
    this.emit(session, turn, { kind: 'turn.failed', code, message: safeRuntimeToolText(message, 800), retryable: false,
      ...(providerTerminal ? { failureEvidence: { source: 'provider-terminal' as const } } : {}) });
    turn.terminal = true; this.endProcess(turn);
  }
  protected stdinCloseDelayMs(_turn: CliTurn): number { void _turn; return 0; }
  private endProcess(turn: CliTurn): void {
    const closeInput = () => {
      if (!turn.exitConfirmed && !turn.child.stdin.destroyed && !turn.child.stdin.writableEnded) turn.child.stdin.end();
    };
    const delay = this.stdinCloseDelayMs(turn);
    if (!turn.exitConfirmed && delay > 0) this.timer(turn, closeInput, delay);
    else closeInput();
    if (!turn.exitConfirmed) this.timer(turn, () => this.stopProcess(turn), 2500);
  }
  protected stopProcess(turn: CliTurn): void { if (!turn.exitConfirmed) try { turn.child.kill(); } catch { /* exit remains unconfirmed */ } }
  protected emit(session: CliSession, turn: CliTurn, event: EventPayload): void {
    session.queue.push({ ...event, eventKey: `${session.ref.id}:${turn.input.turnId}:${++turn.seq}`, sessionId: session.ref.id,
      turnId: turn.input.turnId, memberId: session.input.memberId, ...(turn.input.stage ? { stage: turn.input.stage } : {}), receivedAt: Date.now() } as NormalizedRuntimeEvent);
    this.wake(session);
  }
  private wake(session: CliSession): void { for (const wake of session.wake) wake(); session.wake.clear(); }
  protected session(ref: SessionRef): CliSession {
    const session = this.sessions.get(ref.id); if (!session) throw new AdapterCallError('RESOURCE_NOT_FOUND', '执行会话不存在'); return session;
  }
  async *events(ref: SessionRef): AsyncGenerator<NormalizedRuntimeEvent> {
    const session = this.session(ref);
    for (;;) {
      while (session.queue.length) yield session.queue.shift()!;
      if (session.closed) return;
      await new Promise<void>(resolve => session.wake.add(resolve));
    }
  }
  steer(_session: SessionRef, _input: TurnRequest): Promise<void> {
    void _session; void _input;
    return Promise.reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', '此执行端暂不支持运行中追加指令'));
  }
  respondApproval(_session: SessionRef, _id: string, _choice: 'allow_once' | 'deny'): Promise<void> {
    void _session; void _id; void _choice;
    return Promise.reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', '此执行端暂不提供众说内的逐项审批'));
  }
  interrupt(ref: SessionRef, turnId: string): Promise<void> {
    const session = this.session(ref); const turn = session.current;
    if (!turn || turn.input.turnId !== turnId || turn.exitConfirmed) return Promise.resolve();
    turn.stopRequested = true;
    if (!turn.terminal) try { this.cancel(session, turn); } catch { /* fallback still confirms only actual exit */ }
    this.timer(turn, () => this.stopProcess(turn), 1500); return Promise.resolve();
  }
  processIdentity(ref: SessionRef, turnId: string): AdapterProcessIdentity | null {
    const turn = this.turns.get(`${ref.id}|${turnId}`);
    const managedJobId = (turn?.child as (ChildProcessWithoutNullStreams & { managedJobId?: string }) | undefined)?.managedJobId;
    return turn ? { model: 'per-turn', pid: turn.child.pid ?? null, ...(managedJobId ? { managedJobId } : {}) } : null;
  }
  async waitForTurnExit(ref: SessionRef, turnId: string, timeoutMs = 3000) {
    const turn = this.turns.get(`${ref.id}|${turnId}`);
    if (!turn) return null;
    if (!turn.exitConfirmed) await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); turn.exitWaiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, timeoutMs); turn.exitWaiters.add(wake);
    });
    return { turnId, exitConfirmed: turn.exitConfirmed, exitCode: turn.exitCode, stopRequested: turn.stopRequested };
  }
  async close(ref: SessionRef): Promise<void> {
    const session = this.session(ref); const turn = session.current;
    if (turn && !turn.exitConfirmed) {
      if (!turn.terminal) await this.interrupt(ref, turn.input.turnId);
      let proof = await this.waitForTurnExit(ref, turn.input.turnId, 3000);
      if (!proof?.exitConfirmed) { this.stopProcess(turn); proof = await this.waitForTurnExit(ref, turn.input.turnId, 1500); }
      if (!proof?.exitConfirmed) throw new AdapterCallError('RECONCILE_REQUIRED', '执行进程退出尚未确认');
    }
    session.closed = true; this.wake(session);
  }
  async disposeAll(): Promise<Array<{ turnId: string; exitConfirmed: boolean }>> {
    const result: Array<{ turnId: string; exitConfirmed: boolean }> = [];
    for (const session of this.sessions.values()) {
      try { await this.close(session.ref); } catch { /* reported per turn below */ }
      if (session.current) result.push({ turnId: session.current.input.turnId, exitConfirmed: session.current.exitConfirmed });
    }
    return result;
  }
}
