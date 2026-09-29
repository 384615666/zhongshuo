/**
 * 可脚本化 fake runtime adapter（DEV-03）。进程内实现，零模型调用。
 * 事件流带积压回放（订阅前产生的事件仍可消费），eventKey 稳定；
 * 六类 fixture 编排见 script.ts（成功/失败/审批/超时/停止不响应/迟到）。
 */
import { randomUUID } from 'node:crypto';
import { AdapterCallError } from '../../contracts/runtime.ts';
import type {
  AdapterProcessIdentity,
  NormalizedRuntimeEvent,
  OpenSessionInput,
  ProbeResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  SessionRef,
  TurnRequest,
} from '../../contracts/runtime.ts';
import type { FakeEventSpec, FakeScriptItem, FakeTurnScript } from './script.ts';
import { successTurn } from './script.ts';

const FAKE_VERSION = 'fake-runtime-1.0.0';

export interface FakeAdapterOptions {
  /** 覆盖能力表（默认除 usageCost=unsupported 外全 supported；unverified 语义按 §9.3 由调用方处理）。 */
  capabilities?: Partial<RuntimeCapabilities>;
  /** 脚本表：第 N 次 startTurn（1 起）用第 N 条；越界用最后一条；缺省 successTurn。 */
  turnScripts?: readonly FakeTurnScript[];
  /** openSession 人为延迟（竞态/停止窗口测试）。 */
  openSessionDelayMs?: number;
  /** interrupt() 永不返回（真实世界的协议挂起反例）。 */
  hangInterrupt?: boolean;
  /** 结构化终态（默认 true）：turn.completed finalText=TaskComplete JSON；false 保留原文本（非法输出反例）。 */
  structuredFinal?: boolean;
  /** 全局脚本序列（跨会话按调用顺序取，M1 研讨编排测试用：每步骤一个新会话）；可按输入文本生成。 */
  turnScriptSequencer?: (input: { text: string }) => FakeTurnScript;
}

type ApprovalChoice = 'allow_once' | 'deny' | 'interrupted';

interface PendingApproval {
  approvalId: string;
  resolve: (choice: ApprovalChoice) => void;
}

interface LateDelivery {
  /** 迟到事件归属的原 turn。 */
  originTurnId: string;
  spec: FakeEventSpec;
}

interface ActiveTurnState {
  turnId: string;
  items: readonly FakeScriptItem[];
  cursor: number;
  unresponsive: boolean;
  interruptRequested: boolean;
  /** 当前等待点（stall/审批）的唤醒句柄。 */
  wake: () => void;
  approvalWaiter: PendingApproval | null;
  done: boolean;
  resultKey: string | null;
  /** 结构化终态：turn.completed 的 finalText 为合法 TaskComplete JSON（与真实合同一致）。 */
  structuredFinal: boolean;
}

interface SessionState {
  ref: SessionRef;
  stream: EventStream;
  active: ActiveTurnState | null;
  /** 迟到事件挂账：在「会话第 N 个 turn 开始」时投递（携带原 turnId）。 */
  lateByTurnIndex: Map<number, LateDelivery[]>;
  turnCounter: number;
  steers: Array<{ turnId: string; text: string }>;
  developerInstructions?: string;
  promptVersion?: string;
}

/** 事件流：backlog + 尾部推送；多次迭代均从积压头部回放（重连语义，消费方按 eventKey 去重）。 */
class EventStream {
  private backlog: NormalizedRuntimeEvent[] = [];
  private waiters: Array<() => void> = [];

  push(event: NormalizedRuntimeEvent): void {
    this.backlog.push(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *iterate(): AsyncGenerator<NormalizedRuntimeEvent> {
    let index = 0;
    for (;;) {
      while (index < this.backlog.length) {
        yield this.backlog[index]!;
        index += 1;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

export class FakeRuntimeAdapter implements RuntimeAdapter {
  private readonly options: FakeAdapterOptions;
  private readonly sessions = new Map<string, SessionState>();
  private sessionSeq = 0;
  private emitSeq = 0;
  /** 测试观测：startTurn 收到的输入（DEV-21 验证实际注入文本与 bundle 一致）。 */
  readonly startTurnLog: Array<{ turnId: string; inputBundleId: string; text: string; developerInstructions?: string; promptVersion?: string }> = [];

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
  }

  async probe(): Promise<ProbeResult> {
    return {
      executable: 'fake://runtime',
      version: FAKE_VERSION,
      capabilities: this.capabilities(),
    };
  }

  private capabilities(): RuntimeCapabilities {
    return {
      structuredEvents: 'supported',
      taskContextIsolation: 'supported',
      resumeSession: 'supported',
      steerActiveTurn: 'supported',
      interrupt: 'supported',
      interactiveApprovals: 'supported',
      structuredFinal: 'supported',
      restrictWrites: 'supported',
      restrictShell: 'supported',
      disableDelegation: 'supported',
      usageTokens: 'supported',
      usageCost: 'unsupported',
      ...this.options.capabilities,
    };
  }

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    if (this.options.openSessionDelayMs != null && this.options.openSessionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.openSessionDelayMs));
    }
    this.sessionSeq += 1;
    const ref: SessionRef = {
      id: `fake-session-${this.sessionSeq}-${randomUUID().slice(0, 8)}`,
      providerSessionId: input.resume?.providerSessionId ?? `fake-provider-${this.sessionSeq}`,
      runtimeInstallationId: input.resume?.runtimeInstallationId ?? 'fake-installation',
      adapterVersion: FAKE_VERSION,
      threadId: input.threadId,
      sessionGeneration: input.sessionGeneration,
      cwd: input.cwd,
    };
    const state: SessionState = {
      ref,
      stream: new EventStream(),
      active: null,
      lateByTurnIndex: new Map(),
      turnCounter: 0,
      steers: [],
      developerInstructions: input.developerInstructions,
      promptVersion: input.promptVersion,
    };
    this.sessions.set(ref.id, state);
    this.emit(state, { kind: 'session.ready', providerSessionId: ref.providerSessionId });
    return ref;
  }

  async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
    if (state.active != null && !state.active.done) {
      throw new AdapterCallError('WORKSPACE_BUSY', `会话已有进行中的 turn：${state.active.turnId}`);
    }
    const scripts = this.options.turnScripts;
    const script = this.options.turnScriptSequencer != null
      ? this.options.turnScriptSequencer({ text: input.text })
      : scripts && scripts.length > 0
        ? (scripts[Math.min(state.turnCounter, scripts.length - 1)]!)
        : successTurn();
    state.turnCounter += 1;

    this.startTurnLog.push({
      turnId: input.turnId,
      inputBundleId: input.inputBundleId,
      text: input.text,
      developerInstructions: this.sessions.get(session.id)?.developerInstructions,
      promptVersion: this.sessions.get(session.id)?.promptVersion,
    });
    const turn: ActiveTurnState = {
      turnId: input.turnId,
      items: script,
      cursor: 0,
      unresponsive: false,
      interruptRequested: false,
      wake: () => {},
      approvalWaiter: null,
      done: false,
      resultKey: input.resultKey ?? null,
      structuredFinal: this.options.structuredFinal !== false,
    };
    state.active = turn;

    this.emit(state, { kind: 'turn.started', providerTurnId: `${input.turnId}:provider` }, input.turnId);

    // 到期迟到事件投递（携带原 turnId——目标运行已换新，旧结果迟到到达）。
    const due = state.lateByTurnIndex.get(state.turnCounter);
    if (due != null) {
      state.lateByTurnIndex.delete(state.turnCounter);
      for (const late of due) this.emit(state, late.spec, late.originTurnId);
    }

    void this.runScript(state, turn);
  }

  private async runScript(state: SessionState, turn: ActiveTurnState): Promise<void> {
    const interrupted = () => turn.interruptRequested && !turn.unresponsive;
    while (turn.cursor < turn.items.length && !turn.done) {
      if (interrupted()) break;
      const item = turn.items[turn.cursor];
      turn.cursor += 1;
      if (item == null) break;

      if (item.kind === 'event') {
        const rendered = item.event.kind === 'turn.completed' && turn.structuredFinal
          ? { ...item.event, finalText: renderStructuredFinal(item.event, turn.resultKey) }
          : item.event;
        this.emit(state, rendered as never, turn.turnId);
      } else if (item.kind === 'unresponsiveToInterrupt') {
        turn.unresponsive = true;
      } else if (item.kind === 'stall') {
        await this.wait(item.ms, turn);
      } else if (item.kind === 'late') {
        const queue = state.lateByTurnIndex.get(item.deliverOnTurnStartIndex) ?? [];
        queue.push({ originTurnId: turn.turnId, spec: item.event });
        state.lateByTurnIndex.set(item.deliverOnTurnStartIndex, queue);
      } else if (item.kind === 'waitApproval') {
        this.emit(
          state,
          {
            kind: 'approval.requested',
            approvalId: item.approvalId,
            request: item.request ?? { summary: '模拟权限请求' },
            allowedChoices: ['allow_once', 'deny'],
          },
          turn.turnId,
        );
        const choice = await new Promise<ApprovalChoice>((resolve) => {
          turn.approvalWaiter = { approvalId: item.approvalId, resolve };
          // 中断唤醒审批等待（sleepOrCancel 同款句柄）。
          const sleeper = { timer: setTimeout(() => resolve('deny'), 2 ** 31 - 1) };
          const prevWake = turn.wake;
          turn.wake = () => {
            clearTimeout(sleeper.timer);
            prevWake();
            resolve('interrupted');
          };
        });
        turn.approvalWaiter = null;
        if (turn.done || interrupted()) break;
        if (choice === 'interrupted') break;
        if (choice === 'allow_once') {
          turn.items = item.onAllow;
          turn.cursor = 0;
        } else {
          this.emit(
            state,
            {
              kind: 'turn.failed',
              code: item.onDeny.code,
              message: item.onDeny.message,
              retryable: item.onDeny.retryable ?? false,
            },
            turn.turnId,
          );
          this.finishTurn(state, turn, { exitCode: 1, expected: true });
          return;
        }
      }
    }

    if (turn.done) return;
    if (interrupted()) {
      this.emit(
        state,
        { kind: 'turn.failed', code: 'INTERRUPTED', message: '被中断', retryable: false },
        turn.turnId,
      );
      this.finishTurn(state, turn, { exitCode: 0, expected: true });
      return;
    }
    // 脚本走完：发 process.exited(0)；若脚本本身未含 turn.completed，则结果不确定
    // （§9.4 process.exited(0) ≠ 成果完整），不伪造终结事件。
    this.finishTurn(state, turn, { exitCode: 0, expected: true });
  }

  private finishTurn(
    state: SessionState,
    turn: ActiveTurnState,
    exit: { exitCode: number; expected: boolean },
  ): void {
    turn.done = true;
    turn.wake();
    if (state.active === turn) state.active = null;
    this.emit(state, { kind: 'process.exited', exitCode: exit.exitCode, expected: exit.expected });
  }

  /** 等待 ms；被中断（turn.wake）提前返回。 */
  private wait(ms: number, turn: ActiveTurnState): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        turn.wake = () => {};
        resolve();
      }, ms);
      const prevWake = turn.wake;
      turn.wake = () => {
        clearTimeout(timer);
        prevWake();
        resolve();
      };
    });
  }

  events(session: SessionRef): AsyncIterable<NormalizedRuntimeEvent> {
    return this.stateOf(session).stream.iterate();
  }

  async steer(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
    if (this.capabilities().steerActiveTurn !== 'supported') {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', '该 runtime 声明不支持 steerActiveTurn');
    }
    state.steers.push({ turnId: input.turnId, text: input.text });
  }

  async interrupt(session: SessionRef, turnId: string): Promise<void> {
    if (this.options.hangInterrupt === true) {
      // 永不 resolve：验证消费方不被 interrupt 阻塞。
      await new Promise<void>(() => {});
    }
    const state = this.stateOf(session);
    if (this.capabilities().interrupt !== 'supported') {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', '该 runtime 声明不支持 interrupt');
    }
    const turn = state.active;
    if (turn == null || turn.turnId !== turnId || turn.done) {
      return; // 目标已非活跃：迟到的中断请求不影响任何运行（开工契约 §3.2 停止绑定目标运行）。
    }
    turn.interruptRequested = true;
    if (turn.unresponsive) {
      return; // 停止不响应：仅标记，不终止——消费方维持 STOPPING（WORKER_STILL_RUNNING）。
    }
    turn.wake(); // 唤醒 stall/审批等待；runScript 随后按 INTERRUPTED 终结。
  }

  async respondApproval(
    session: SessionRef,
    approvalId: string,
    choice: 'allow_once' | 'deny',
  ): Promise<void> {
    const state = this.stateOf(session);
    const turn = state.active;
    const waiter = turn?.approvalWaiter;
    if (turn == null || waiter == null || waiter.approvalId !== approvalId) {
      throw new AdapterCallError('RESOURCE_NOT_FOUND', '没有等待答复的确认请求');
    }
    waiter.resolve(choice);
  }

  async close(session: SessionRef): Promise<void> {
    const state = this.stateOf(session);
    if (state.active != null && !state.active.done) {
      state.active.done = true;
      state.active.wake();
      state.active = null;
    }
    this.sessions.delete(session.id);
  }

  /** 无子进程（内联模拟执行）——无 OS 遗留进程可能（DEV-13 取证如实标注）。 */
  processIdentity(session: SessionRef, turnId: string): AdapterProcessIdentity | null {
    void session; void turnId; return { model: 'none', pid: null };
  }

  /** 测试清理：关闭全部会话（清空挂起的 stall 计时器，避免进程悬挂）。 */
  async closeAllSessions(): Promise<void> {
    for (const state of [...this.sessions.values()]) {
      if (state.active != null && !state.active.done) {
        state.active.done = true;
        state.active.wake();
        state.active = null;
      }
    }
    this.sessions.clear();
  }

  private stateOf(session: SessionRef): SessionState {
    const state = this.sessions.get(session.id);
    if (state == null) {
      throw new AdapterCallError('RESOURCE_NOT_FOUND', `会话不存在或已关闭：${session.id}`);
    }
    return state;
  }

  private emit(state: SessionState, spec: FakeEventSpec, turnId?: string): void {
    this.emitSeq += 1;
    const event = {
      ...spec,
      eventKey: `${state.ref.id}:${this.emitSeq}`,
      sessionId: state.ref.id,
      ...(turnId != null ? { turnId } : {}),
      receivedAt: Date.now(),
    } as NormalizedRuntimeEvent;
    state.stream.push(event);
  }

  // ---------- 测试观测面（不属于 RuntimeAdapter 契约） ----------

  observe(sessionId: string): {
    activeTurnId: string | null;
    interruptRequested: boolean;
    unresponsive: boolean;
    pendingApprovalId: string | null;
    steers: ReadonlyArray<{ turnId: string; text: string }>;
  } | null {
    const s = this.sessions.get(sessionId);
    if (s == null) return null;
    return {
      activeTurnId: s.active?.turnId ?? null,
      interruptRequested: s.active?.interruptRequested ?? false,
      unresponsive: s.active?.unresponsive ?? false,
      pendingApprovalId: s.active?.approvalWaiter?.approvalId ?? null,
      steers: [...s.steers],
    };
  }
}

/** 结构化终态渲染：TaskComplete JSON（schema 见 contracts/prompts；fake 与真实合同一致）。 */
function renderStructuredFinal(
  event: { kind: 'turn.completed'; finalText?: string },
  resultKey: string | null,
): string {
  return JSON.stringify({
    schemaVersion: 'task-complete-v1',
    resultKey: resultKey ?? 'result_fake_unbound',
    changeSummary: event.finalText ?? '',
    files: [],
    executedVerifications: [],
    unexecutedVerifications: [],
    remainingIssues: [],
  });
}
