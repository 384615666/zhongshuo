/**
 * 本地协议 adapter（第十八轮二测试基建）：真实子进程语义（每 turn 一个 `node -e` 常驻子进程
 * =「本地协议进程」），零真实模型调用。用于经正式 entry→registry→wrapRealCallLedger→adapter
 * 链验证生命周期透传——不触真实 claude/codex 二进制。
 * 可配置：dispose 形态（dispose/disposeAll/closeAllSessions）、收拢挂起（清理超时反例）、
 * startTurn 派发前抛错（启动失败）、无终态（在途停止）、受管桥 spawn。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';
import type {
  AdapterProcessIdentity, NormalizedRuntimeEvent, OpenSessionInput, ProbeResult,
  RuntimeAdapter, RuntimeCapabilities, SessionRef, TurnRequest,
} from '../../src/contracts/runtime.ts';

export interface MinimalProcess {
  pid: number | null | undefined;
  exitCode: number | null;
  kill(signal?: string): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): EventEmitter;
}

export type LocalDisposeStyle = 'dispose' | 'disposeAll' | 'closeAllSessions';

export interface LocalProtocolOptions {
  disposeStyle?: LocalDisposeStyle;
  /** 收拢挂起时长（清理超时反例）；到期后正常完成。 */
  disposeHangMs?: number;
  /** 只在第一次收拢挂起（后续立即——模拟"挂起后自行恢复"，供 force 二次收拢完成）。 */
  hangFirstDisposeOnly?: boolean;
  /** startTurn 在 spawn 前抛出（启动失败/派发前拒绝分类）。 */
  failStartTurnMessage?: string;
  /** 不产生终态事件（在途停止场景——仅 interrupt 后终结）。 */
  neverTerminal?: boolean;
  completeAfterMs?: number;
  /** 受管桥注入（受管路径：子进程入 Job Object）。 */
  spawnFn?: (cmd: string, args: string[], opts: { cwd: string }) => MinimalProcess;
  /** usage.updated 自报模型（响应模型与请求模型分列验证）。 */
  selfReportedModel?: string;
  /** 不 spawn 真实子进程（护栏/配额单测——请求边界语义保留，无 OS 进程遗留）。 */
  noSpawn?: boolean;
}

const LP_CAPS: RuntimeCapabilities = {
  structuredEvents: 'supported', taskContextIsolation: 'supported', resumeSession: 'supported',
  steerActiveTurn: 'unsupported', interrupt: 'supported', interactiveApprovals: 'unsupported',
  structuredFinal: 'supported', restrictWrites: 'supported', restrictShell: 'supported',
  disableDelegation: 'supported', usageTokens: 'supported', usageCost: 'unverified',
};

interface StreamState {
  backlog: NormalizedRuntimeEvent[];
  waiters: Array<() => void>;
}

export class LocalProtocolAdapter implements RuntimeAdapter {
  static builtCount = 0;
  readonly builtSeq = ++LocalProtocolAdapter.builtCount;
  openSessionCalls = 0;
  startTurnCalls = 0;
  interruptCalls = 0;
  disposeCalls = 0;
  disposeAllCalls = 0;
  closeAllSessionsCalls = 0;
  /** 收拢被实际进入的次数（区别于计数器：证明底层清理被调用）。 */
  disposeEntered = 0;
  eventsIteratorsEnded = 0;
  readonly spawnedPids = new Set<number>();
  readonly children = new Map<string, MinimalProcess>();
  private readonly interrupted = new Set<string>();
  private disposed = false;
  private readonly streams = new Map<string, StreamState>();
  private readonly options: LocalProtocolOptions;

  constructor(options: LocalProtocolOptions = {}) {
    this.options = options;
    // 只暴露所选收拢形态（其余遮蔽为 undefined）——注册表按结构探测 dispose → disposeAll →
    // closeAllSessions，三种形态须各自可测（claude=disposeAll、codex=dispose、fake=closeAllSessions）。
    const style = options.disposeStyle ?? 'disposeAll';
    if (style !== 'dispose') (this as { dispose?: unknown }).dispose = undefined;
    if (style !== 'disposeAll') (this as { disposeAll?: unknown }).disposeAll = undefined;
    if (style !== 'closeAllSessions') (this as { closeAllSessions?: unknown }).closeAllSessions = undefined;
  }

  async probe(): Promise<ProbeResult> {
    return { executable: 'local-protocol://node', version: `lp-${this.builtSeq}`, capabilities: LP_CAPS };
  }

  readonly openSessionLog: Array<{ resumedFrom: string | null; returned: string }> = [];

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    this.openSessionCalls += 1;
    const id = `lp-s-${this.builtSeq}-${this.openSessionCalls}`;
    this.streams.set(id, { backlog: [], waiters: [] });
    // 续接（第十九轮五）：传入 resume 且能力支持 → 返回同一 provider 会话身份（原生续接）；
    // 否则新身份（受限重放路径）。
    const providerSessionId = input.resume != null ? input.resume.providerSessionId : `lp-provider-${this.builtSeq}-${this.openSessionCalls}`;
    this.openSessionLog.push({ resumedFrom: input.resume?.providerSessionId ?? null, returned: providerSessionId });
    return {
      id, providerSessionId, runtimeInstallationId: 'lp-install', adapterVersion: 'lp-1',
      threadId: input.threadId, sessionGeneration: input.resume?.sessionGeneration ?? input.sessionGeneration, cwd: input.cwd,
    };
  }

  async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    this.startTurnCalls += 1;
    if (this.options.failStartTurnMessage != null) throw new Error(this.options.failStartTurnMessage);
    const marker = `lp-${input.turnId}`;
    if (!this.options.noSpawn) {
      const spawned = this.options.spawnFn != null
        ? this.options.spawnFn(process.execPath, ['-e', `setInterval(()=>{},30000) /* ${marker} */`], { cwd: process.cwd() })
        : spawn(process.execPath, ['-e', `setInterval(()=>{},30000) /* ${marker} */`], { stdio: 'ignore' });
      const child: MinimalProcess = spawned as MinimalProcess;
      this.children.set(input.turnId, child);
      if (child.pid != null) this.spawnedPids.add(child.pid);
    }
    this.push(session.id, this.event(session.id, input.turnId, { kind: 'turn.started' }));
    if (!this.options.neverTerminal) {
      const ms = this.options.completeAfterMs ?? 250;
      setTimeout(() => {
        if (this.disposed || this.interrupted.has(input.turnId)) return;
        this.push(session.id, this.event(session.id, input.turnId, {
          kind: 'usage.updated', accounting: 'cumulative', inputTokens: 12, outputTokens: 7,
          costQuality: 'reported', model: this.options.selfReportedModel ?? 'lp-server-reported-model',
        }));
        // DIRECT 交付合同：finalText=TaskComplete JSON（与 fake/真实合同一致——结构化终态）。
        const finalText = JSON.stringify({
          schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
          resultKey: input.resultKey ?? `result_${input.turnId}`,
          changeSummary: `lp 完成：${input.text.slice(0, 60)}`,
          files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
        });
        this.push(session.id, this.event(session.id, input.turnId, { kind: 'turn.completed', finalText }));
      }, ms).unref?.();
    }
  }

  async *events(session: SessionRef): AsyncGenerator<NormalizedRuntimeEvent> {
    const st = this.streams.get(String(session.id));
    if (st == null) throw new Error(`lp: 未知会话 ${String(session.id)}`);
    try {
      let index = 0;
      for (;;) {
        while (index < st.backlog.length) {
          yield st.backlog[index]!;
          index += 1;
        }
        if (this.disposed) return; // 收拢后流终止——不再有后台活动
        await new Promise<void>((resolve) => st.waiters.push(resolve));
      }
    } finally {
      this.eventsIteratorsEnded += 1;
    }
  }

  async steer(): Promise<void> { /* lp 不支持 */ }

  async interrupt(session: SessionRef, turnId: string): Promise<void> {
    this.interruptCalls += 1;
    this.interrupted.add(turnId);
    this.killChild(turnId);
    this.push(session.id, this.event(session.id, turnId, { kind: 'turn.failed', code: 'INTERRUPTED', message: 'lp 停止（子进程已终止）', retryable: false }));
  }

  async respondApproval(): Promise<void> { /* lp 不支持 */ }

  async close(): Promise<void> { /* 单会话关闭：children 归 disposeAll */ }

  processIdentity(_session: SessionRef, turnId: string): AdapterProcessIdentity | null {
    const child = this.children.get(turnId);
    return child?.pid != null ? { model: 'per-turn', pid: child.pid } : { model: 'none', pid: null };
  }

  private killChild(turnId: string): void {
    const child = this.children.get(turnId);
    if (child != null && child.exitCode == null) { try { child.kill('SIGKILL'); } catch { /* 尽力 */ } }
  }

  /** 正式收拢：杀全部子进程并等退出确认（每 turn exitConfirmed 如实上报）；唤醒事件流收敛。 */
  private async runDispose(): Promise<Array<{ turnId: string; exitConfirmed: boolean }>> {
    const firstEntry = this.disposeEntered === 0;
    this.disposeEntered += 1;
    if (this.options.disposeHangMs != null && (firstEntry || this.options.hangFirstDisposeOnly !== true)) {
      await new Promise((r) => setTimeout(r, this.options.disposeHangMs));
    }
    // 中断排水宽限：interrupt 已推终态事件——给消费器先 drain 的窗口（真实 runtime 退出前
    // 先发终态；无宽限则流终止竞态把 turn 推成 UNKNOWN）。
    if (this.interrupted.size > 0) await new Promise((r) => setTimeout(r, 250));
    const exits: Array<{ turnId: string; exitConfirmed: boolean }> = [];
    for (const [turnId, child] of this.children) {
      this.killChild(turnId);
      let exited = child.exitCode != null || (child as { signalCode?: string | null }).signalCode != null;
      await new Promise<void>((resolve) => {
        if (exited) { resolve(); return; }
        const t = setTimeout(resolve, 3_000);
        t.unref?.();
        child.once('exit', () => { clearTimeout(t); exited = true; resolve(); });
      });
      // 退出确认=退出事实（退出码或信号任一）——Windows 信号终止 exitCode 可为 null。
      exits.push({ turnId, exitConfirmed: exited });
    }
    this.disposed = true;
    for (const st of this.streams.values()) for (const wake of st.waiters.splice(0)) wake();
    return exits;
  }

  async dispose(): Promise<void> { this.disposeCalls += 1; await this.runDispose(); }
  async disposeAll(): Promise<Array<{ turnId: string; exitConfirmed: boolean }>> { this.disposeAllCalls += 1; return this.runDispose(); }
  async closeAllSessions(): Promise<void> { this.closeAllSessionsCalls += 1; await this.runDispose(); }

  private push(sessionId: string, event: NormalizedRuntimeEvent): void {
    const st = this.streams.get(String(sessionId));
    if (st == null) return;
    st.backlog.push(event);
    for (const wake of st.waiters.splice(0)) wake();
  }

  private event(sessionId: string, turnId: string, spec: object): NormalizedRuntimeEvent {
    return { ...spec, eventKey: `lp-${randomUUID()}`, sessionId: sessionId as never, turnId, receivedAt: Date.now() } as unknown as NormalizedRuntimeEvent;
  }
}
