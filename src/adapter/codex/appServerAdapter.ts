/**
 * Codex App Server 适配器（DEV-06；协议依据：codex-cli 0.157.1 `app-server generate-ts`
 * 生成的类型，见 tests/fixtures/codex-protocol/；传输=stdio 换行分隔 JSON-RPC，§9.2/实测 B1）。
 *
 * 生命周期：spawn（解析 npm shim → node 原生入口，§9.5 EINVAL 坑）→ initialize(clientInfo)
 * → thread/start（cwd/developerInstructions/sandbox/approvalPolicy，按权限档位映射）
 * → turn/start（input=[{type:'text',...}]）→ 通知流映射 §9.4 规范化事件。
 * 审批：ServerRequest（applyPatchApproval、execCommandApproval、item 系列请求）
 * 映射为 approval.requested；respondApproval 回响应 ServerRequest id。
 * 权限映射（M0）：plan → sandbox='read-only'+approvalPolicy='never'；其他档位未认证，
 * 按映射存在但不标 supported（B6/RT-23 认证前 UI 禁用）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
import { EventStream } from '../eventStream.ts';

const ADAPTER_VERSION = 'codex-appserver-adapter-0.1.0';
const SUPPORTED_CODEX_VERSION_PREFIX = '0.157.';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

type DistOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

interface SessionState {
  ref: SessionRef;
  stream: EventStream;
  providerThreadId: string;
  /** 内部 turnId → provider turnId（turn/started 时登记；steer/interrupt 必需）。 */
  providerTurnIds: Map<string, string>;
  /** 每会话消息序号（eventKey 稳定）。 */
  seq: number;
}

export interface CodexAdapterOptions {
  /** npm shim 路径（默认从 PATH 解析 codex.cmd → node codex.js）。 */
  codexCmdPath?: string;
  /** 请求超时（initialize/thread/turn 请求；默认 60s，§10.4 startupTimeout）。 */
  requestTimeoutMs?: number;
  /** 权限档位（M0 固定 plan：read-only 沙箱）。 */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export class CodexAppServerAdapter implements RuntimeAdapter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly serverRequests = new Map<string, number>(); // approvalId → JSON-RPC id
  private buffer = '';
  private stderrTail = '';
  private protocolVersion: string | null = null;
  private readonly options: Required<Pick<CodexAdapterOptions, 'requestTimeoutMs' | 'sandboxMode'>> & { codexCmdPath?: string };
  private codexVersion: string | null = null;
  private executable: string | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      codexCmdPath: options.codexCmdPath,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      sandboxMode: options.sandboxMode ?? 'read-only',
    };
  }

  // ---------- 进程与协议 ----------

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child != null && this.child.exitCode == null) return this.child;
    const entry = this.resolveEntry();
    const child = spawn(process.execPath, [entry.executable, ...entry.args, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      // 诊断通道：保留原始 stderr 供排障（§9.4 保留厂商原始事件作受控诊断附件）。
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      process.stderr.write(`[codex-appserver] ${chunk}`);
    });
    child.on('close', (code) => {
      const event: NormalizedRuntimeEvent = {
        kind: 'process.exited',
        eventKey: `proc:exit:${randomUUID()}`,
        sessionId: 'codex-appserver',
        exitCode: code,
        expected: true,
        receivedAt: Date.now(),
      };
      for (const session of this.sessions.values()) session.stream.push(event);
      const tail = this.stderrTail.slice(-1600);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new AdapterCallError('RUNTIME_NOT_FOUND', `app-server 进程退出（code=${code}）stderr 尾部：${tail}`));
      }
      this.pending.clear();
      this.child = null;
    });
    this.child = child;
    return child;
  }

  /** 解析 npm shim（.cmd 不能直接 spawn，§9.5）到 node 入口。 */
  private resolveEntry(): { executable: string; args: string[] } {
    const cmdPath = this.options.codexCmdPath ?? this.findOnPath('codex.cmd');
    if (cmdPath == null) {
      throw new AdapterCallError('RUNTIME_NOT_FOUND', '未找到 codex 可执行入口（PATH 无 codex.cmd）');
    }
    // npm shim 布局是确定的：<shimDir>/node_modules/@openai/codex/bin/codex.js（%dp0% 相对路径）。
    const candidate = join(cmdPath, '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) {
      return { executable: candidate, args: [] };
    }
    // 兜底：从 shim 文本解析（非标准布局）。
    const shim = readFileSync(cmdPath, 'utf8');
    const m = shim.match(/"([^"]+[@\\/]openai[\\/][^"]*codex[^"]*\.js)"/) ?? shim.match(/node\s+"([^"]+codex[^"]*\.js)"/);
    if (m == null) {
      throw new AdapterCallError('RUNTIME_NOT_FOUND', `无法从 shim 解析 codex.js 入口：${cmdPath}`);
    }
    return { executable: m[1]!, args: [] };
  }

  private findOnPath(name: string): string | null {
    for (const dir of (process.env.PATH ?? '').split(';')) {
      if (dir.length === 0) continue;
      const candidate = join(dir.trim(), name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.ensureProcess();
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterCallError('RUNTIME_NOT_FOUND', `${method} 请求超时（${this.options.requestTimeoutMs}ms）`));
      }, this.options.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.writeLine(`${JSON.stringify(message)}`);
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');
      if (line.length === 0) continue;
      try {
        this.handleMessage(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        process.stderr.write(`[codex-appserver] 非 JSON 行：${line.slice(0, 120)}（${error instanceof Error ? error.message : 'parse'}）\n`);
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message['id'] != null && (message['result'] != null || message['error'] != null)) {
      const id = Number(message['id']);
      const entry = this.pending.get(id);
      if (entry == null) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (message['error'] != null) {
        const err = message['error'] as { message?: string; code?: number };
        entry.reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', `JSON-RPC 错误（${err.code ?? '?'}）：${err.message ?? '未知'}`));
      } else {
        entry.resolve(message['result']);
      }
      return;
    }
    // Server→Client 请求（审批）带 id + method
    if (message['id'] != null && typeof message['method'] === 'string') {
      this.handleServerRequest(Number(message['id']), message['method'], message['params']);
      return;
    }
    if (typeof message['method'] === 'string') {
      this.handleNotification(message['method'], message['params'] as Record<string, unknown> | undefined);
    }
  }

  private handleServerRequest(id: number, method: string, params: unknown): void {
    // 审批请求 → approval.requested（挂到相关会话；M0 fixture 会话唯一时可直接定位）
    const approvalId = `appr_${id}`;
    this.serverRequests.set(approvalId, id);
    const payloadHash = createHash('sha256').update(JSON.stringify({ method, params })).digest('hex');
    const target = [...this.sessions.values()][0];
    if (target == null) {
      // 无会话消费：按协议拒绝（不悬挂服务端请求）。
      void this.respondToServer(id, { decision: 'deny' });
      return;
    }
    target.stream.push(this.event(target, {
      kind: 'approval.requested',
      approvalId,
      request: { method, params, payloadHash },
      allowedChoices: ['allow_once', 'deny'],
    }, this.currentTurnIdOf(target)));
  }

  private async respondToServer(id: number, result: unknown): Promise<void> {
    this.ensureProcess();
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  /** 写一行到 app-server stdin（显式管道：stdin 由本适配器独占管理，§9.5）。 */
  private writeLine(line: string): void {
    this.ensureProcess();
    this.child!.stdin.write(`${line}\n`);
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    const p = params ?? {};
    const threadId = typeof p['threadId'] === 'string' ? p['threadId'] : null;
    const session = threadId != null ? this.sessionByThread(threadId) : [...this.sessions.values()][0];
    switch (method) {
      case 'turn/started': {
        if (session == null) return;
        const turn = p['turn'] as { id: string } | undefined;
        const internalId = this.currentTurnIdOf(session);
        if (internalId != null && turn != null) session.providerTurnIds.set(internalId, turn.id);
        session.stream.push(this.event(session, { kind: 'turn.started', providerTurnId: turn?.id }, internalId));
        break;
      }
      case 'item/agentMessage/delta': {
        if (session == null) return;
        session.stream.push(this.event(session, {
          kind: 'message.delta',
          messageId: String(p['itemId'] ?? randomUUID()),
          text: String(p['delta'] ?? ''),
        }));
        break;
      }
      case 'item/completed': {
        if (session == null) return;
        const item = p['item'] as Record<string, unknown> | undefined;
        const type = item?.['type'];
        if (type === 'agentMessage') {
          session.stream.push(this.event(session, {
            kind: 'message.completed',
            messageId: String(item?.['id'] ?? randomUUID()),
            text: String(item?.['text'] ?? ''),
          }));
        } else if (type === 'commandExecution' || type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall') {
          session.stream.push(this.event(session, {
            kind: 'tool.completed',
            toolCallId: String(item?.['id'] ?? randomUUID()),
            outcome: 'success',
          }));
        }
        break;
      }
      case 'item/started': {
        if (session == null) return;
        const item = p['item'] as Record<string, unknown> | undefined;
        const type = item?.['type'];
        if (type === 'commandExecution' || type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall') {
          session.stream.push(this.event(session, {
            kind: 'tool.started',
            toolCallId: String(item?.['id'] ?? randomUUID()),
            toolName: String(type),
            argumentsSummary: String((item as { command?: unknown })?.['command'] ?? '').slice(0, 120),
          }));
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (session == null) return;
        const usage = p['tokenUsage'] as { total?: Record<string, number> } | undefined;
        const total = usage?.total;
        session.stream.push(this.event(session, {
          kind: 'usage.updated',
          accounting: 'cumulative',
          inputTokens: total?.['inputTokens'],
          cachedTokens: total?.['cachedInputTokens'],
          outputTokens: total?.['outputTokens'],
          costQuality: 'unknown',
        }));
        break;
      }
      case 'turn/completed': {
        if (session == null) return;
        const turn = p['turn'] as { items?: Array<Record<string, unknown>>; status?: string } | undefined;
        const finalText = (turn?.items ?? [])
          .filter((i) => i['type'] === 'agentMessage')
          .map((i) => String(i['text'] ?? ''))
          .join('\n');
        session.stream.push(this.event(session, { kind: 'turn.completed', finalText }, this.currentTurnIdOf(session)));
        break;
      }
      case 'error': {
        if (session == null) return;
        const err = p['error'] as { message?: string; kind?: string } | undefined;
        const willRetry = p['willRetry'] === true;
        if (!willRetry) {
          session.stream.push(this.event(session, {
            kind: 'turn.failed',
            code: String(err?.['kind'] ?? 'CODEX_ERROR'),
            message: String(err?.['message'] ?? 'codex 通知错误'),
            retryable: false,
          }, this.currentTurnIdOf(session)));
        }
        break;
      }
      default:
        break; // 未知通知：忽略并保留原始行（§9.4 未知可选事件可忽略）
    }
  }

  private currentTurnIdOf(session: SessionState): string | undefined {
    // M0 单活跃 turn：取 providerTurnIds 最后登记的内部 turn（worker 串行派发）。
    return [...session.providerTurnIds.keys()].pop();
  }

  private sessionByThread(threadId: string): SessionState | undefined {
    return [...this.sessions.values()].find((s) => s.providerThreadId === threadId);
  }

  private event(session: SessionState, spec: DistOmit<NormalizedRuntimeEvent, 'eventKey' | 'sessionId' | 'receivedAt'>, turnId?: string): NormalizedRuntimeEvent {
    session.seq += 1;
    return {
      ...spec,
      eventKey: `${session.ref.id}:${session.seq}`,
      sessionId: session.ref.id,
      ...(turnId != null ? { turnId } : {}),
      receivedAt: Date.now(),
    } as NormalizedRuntimeEvent;
  }

  // ---------- RuntimeAdapter ----------

  async probe(): Promise<ProbeResult> {
    if (this.codexVersion == null) {
      const entry = this.resolveEntry();
      this.executable = entry.executable;
      // 版本经 app-server initialize 前先跑 --version（一次性、无模型调用）。
      this.codexVersion = await this.readVersion(entry);
    }
    const version = this.codexVersion!;
    return {
      executable: this.executable ?? '(npm shim)',
      version,
      capabilities: this.capabilities(),
    };
  }

  private readVersion(entry: { executable: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry.executable, '--version'], { windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (out += c));
      child.on('close', () => resolve(out.trim()));
      child.on('error', (e) => reject(new AdapterCallError('RUNTIME_NOT_FOUND', `codex --version 失败：${e.message}`)));
    });
  }

  private capabilities(): RuntimeCapabilities {
    const ok: RuntimeCapabilities[keyof RuntimeCapabilities] = 'supported';
    return {
      structuredEvents: ok,
      taskContextIsolation: 'unverified', // 会话隔离已由历史实测佐证，正式认证待 G2 组合用例
      resumeSession: 'supported', // thread/resume 存在于协议；有效续接验证随 PP-02
      steerActiveTurn: 'supported', // turn/steer + expectedTurnId；PP-12 验证
      interrupt: 'supported',
      interactiveApprovals: 'unverified', // 通道存在；B6/RT-23 认证前不标 supported
      structuredFinal: 'unverified', // outputSchema 存在；正式输出验证随 DEV-21 实测
      restrictWrites: 'unverified', // read-only 沙箱；RT-23 认证前 unverified
      restrictShell: 'unverified',
      disableDelegation: 'unverified',
      usageTokens: 'supported',
      usageCost: 'unsupported',
    };
  }

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    this.ensureProcess();
    if (this.protocolVersion == null) {
      const init = await this.request('initialize', {
        clientInfo: { name: 'zhongshuo', title: '众说', version: ADAPTER_VERSION },
      });
      this.protocolVersion = String((init as Record<string, unknown>)?.['codexHome'] != null ? 'app-server-v2' : 'app-server');
    }
    const threadParams: Record<string, unknown> = {
      cwd: input.cwd,
      sandbox: this.options.sandboxMode,
      approvalPolicy: 'never', // M0：不启用审批桥（B6 认证后再开对应档位）
    };
    if (input.developerInstructions != null) threadParams['developerInstructions'] = input.developerInstructions;
    const result = await this.request<{ thread: { id: string } }>('thread/start', threadParams);
    const providerThreadId = result.thread.id;
    const ref: SessionRef = {
      id: `codex-session-${randomUUID()}`,
      providerSessionId: providerThreadId,
      runtimeInstallationId: `codex:${this.codexVersion ?? 'unknown'}`,
      adapterVersion: ADAPTER_VERSION,
      threadId: input.threadId,
      sessionGeneration: input.sessionGeneration,
      cwd: input.cwd,
    };
    const state: SessionState = {
      ref,
      stream: new EventStream(),
      providerThreadId,
      providerTurnIds: new Map(),
      seq: 0,
    };
    this.sessions.set(ref.id, state);
    state.stream.push(this.event(state, { kind: 'session.ready', providerSessionId: providerThreadId }));
    return ref;
  }

  async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
    const result = await this.request<{ turn: { id: string } }>('turn/start', {
      threadId: state.providerThreadId,
      input: [{ type: 'text', text: input.text, text_elements: [] }],
      clientUserMessageId: input.dispatchKey,
    });
    state.providerTurnIds.set(input.turnId, result.turn.id);
  }

  events(session: SessionRef): AsyncIterable<NormalizedRuntimeEvent> {
    return this.stateOf(session).stream.iterate();
  }

  async steer(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
    const providerTurnId = state.providerTurnIds.get(input.turnId);
    if (providerTurnId == null) {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'steer 需要 expectedTurnId：目标 turn 尚未登记 provider ID');
    }
    await this.request('turn/steer', {
      threadId: state.providerThreadId,
      expectedTurnId: providerTurnId,
      input: [{ type: 'text', text: input.text, text_elements: [] }],
    });
  }

  async interrupt(session: SessionRef, turnId: string): Promise<void> {
    const state = this.stateOf(session);
    const providerTurnId = state.providerTurnIds.get(turnId);
    if (providerTurnId == null) return; // 目标未开始：无需协议中断
    await this.request('turn/interrupt', {
      threadId: state.providerThreadId,
      turnId: providerTurnId,
    });
  }

  async respondApproval(session: SessionRef, approvalId: string, choice: 'allow_once' | 'deny'): Promise<void> {
    this.stateOf(session); // 会话存在性校验
    const rpcId = this.serverRequests.get(approvalId);
    if (rpcId == null) throw new AdapterCallError('RESOURCE_NOT_FOUND', `没有待答复的审批请求：${approvalId}`);
    this.serverRequests.delete(approvalId);
    await this.respondToServer(rpcId, { decision: choice === 'allow_once' ? 'accept' : 'deny' });
  }

  async close(session: SessionRef): Promise<void> {
    this.stateOf(session);
    this.sessions.delete(session.id);
    if (this.sessions.size === 0 && this.child != null) {
      this.child.kill();
      this.child = null;
    }
  }

  /** 诊断：完整关闭（测试收尾，避免残留 app-server 进程）。 */
  async dispose(): Promise<void> {
    this.sessions.clear();
    if (this.child != null) {
      this.child.kill();
      this.child = null;
    }
  }

  private stateOf(session: SessionRef): SessionState {
    const state = this.sessions.get(session.id);
    if (state == null) throw new AdapterCallError('RESOURCE_NOT_FOUND', `会话不存在：${session.id}`);
    return state;
  }
}

export { SUPPORTED_CODEX_VERSION_PREFIX };
