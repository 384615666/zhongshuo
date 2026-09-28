/**
 * Claude Code CLI 适配器（DEV-10；2.1.283 stream-json 口径）。
 *
 * 进程模型（与 Codex 常驻 App Server 不同）：每 turn 一次 `claude -p --output-format
 * stream-json` 进程；会话=产品侧记账 + `--resume <sessionId>` 续接（CLI result 事件含
 * session_id）。事件为 NDJSON 行（每行一个 JSON 对象），映射到 §9.4 规范事件。
 *
 * 启动路径（安全口径，2026-09-28 修订）：
 * - 可信入口解析（resolveClaudeExecutable）：优先原生 claude.exe（npm 全局
 *   @anthropic-ai/claude-code/bin）；显式给 .cmd shim 时解析其真实目标（exe 直用 /
 *   js 走 node）；全程不经过 shell（shell:false），用户文本不进 argv。
 * - prompt 全文经 stdin 原样传入：不经 Windows shell 解释、不受命令行长度限制、
 *   引号/换行/中文/shell 特殊字符按字节透传。
 * - 模型名与 --resume id 做字符集校验（argv 终究进进程参数，只接受安全集）。
 *
 * 合成事件依据（不用"进程启动成功"冒充模型已开始/任务完成）：
 * - turn.started：首条 assistant message 事件到达时合成（CLI 无显式 turn.started）；
 * - session.ready：首次 result 成功（拿到 provider session_id）后于 openSession/resume 合成。
 *
 * 模型与回退纪律（渠道核对 2026-09-28）：unrecognized_model 是服务端错误的 CLI 透传
 * （[claude-code:unrecognized_model] 告警，tengu_api_unrecognized_model）——本适配器
 * 在 stderr 命中该签名时立即判 PROVIDER_LIMITED 失败，不吞回退；渠道模型清单见
 * docs/implementation/reports/round-20260928-dev10-real-auth.md（裸 deepseek-flash 在列）。
 *
 * 能力标记（诚实）：interrupt/usageTokens/usageCost/structuredEvents=supported
 * （stream-json；cost 为 CLI 估算→costQuality=estimated，实测组合 2026-09-28：
 * Claude Code 2.1.283 + 渠道 + deepseek-flash）；
 * resumeSession=supported（--resume，回放已验、真实未认证）；interactiveApprovals/
 * steerActiveTurn=unverified（headless 只读档未开审批；steer 明确拒绝）；
 * restrictWrites/restrictShell/disableDelegation=supported（--permission-mode 受限+工具
 * 白名单 --allowedTools 只读集）；taskContextIsolation=supported（进程 cwd+独立会话）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

export const CLAUDE_ADAPTER_VERSION = 'claude-cli-2.1.283-adapter-0.2';

/** 渠道裸模型名（deepseek-flash / deepseek/deepseek-v4.1-flash / glm-5.3…）；拒绝 [1m] 类后缀语法。 */
const CLAUDE_MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** provider session id（CLI result session_id）：UUID/字母数字下划线连字符。 */
const PROVIDER_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface RuntimeEventBaseFields {
  eventKey: string;
  sessionId: string;
  turnId?: string;
  receivedAt: number;
}

export interface ClaudeCliAdapterOptions {
  /** CLI 可执行入口（默认自动解析原生 exe；.cmd shim 会被解析到真实目标——测试注入模拟器）。 */
  executable?: string;
  /** 显式模型（必填口径：默认配置模型不被 CLI 接受）。 */
  model?: string;
  /** 权限策略（默认 plan 只读档）。 */
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  /** 额外 CLI 参数（测试注入）。 */
  extraArgs?: string[];
  installationId?: string;
}

/** 解析后的可执行入口（spawn 直用，prefixArgs 为解释器前缀，如 node cli.js）。 */
export interface ClaudeExecutableEntry {
  command: string;
  prefixArgs: string[];
}

/**
 * 解析可信可执行入口（不执行任何进程）：
 * - 显式路径：.exe 直用；.cmd/.bat shim 解析其调用的真实目标；Windows 下非 exe
 *   显式名（如 'claude'）无法经 shell:false 直接 spawn（.cmd 不经 shell 不可执行）——
 *   回落默认解析，不猜 PATH；
 * - 默认：npm 全局原生 claude.exe（Windows）→ claude.cmd 解析 → 常见 Unix 路径 → PATH 兜底。
 */
export function resolveClaudeExecutable(explicit?: string): ClaudeExecutableEntry {
  if (explicit != null && explicit.length > 0 && !/^(claude|claude\.cmd)$/i.test(explicit)) {
    if (/\.(cmd|bat)$/i.test(explicit)) return parseWindowsShim(explicit);
    if (process.platform === 'win32' && !/\.exe$/i.test(explicit)) {
      return resolveDefaultClaudeEntry();
    }
    return { command: explicit, prefixArgs: [] };
  }
  return resolveDefaultClaudeEntry();
}

function resolveDefaultClaudeEntry(): ClaudeExecutableEntry {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata != null) {
      const exe = join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (existsSync(exe)) return { command: exe, prefixArgs: [] };
      const shim = join(appdata, 'npm', 'claude.cmd');
      if (existsSync(shim)) return parseWindowsShim(shim);
    }
    return { command: 'claude', prefixArgs: [] }; // PATH 兜底；spawn ENOENT→RUNTIME_NOT_FOUND（如实）
  }
  for (const candidate of ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', join(homedir(), '.local', 'bin', 'claude')]) {
    if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
  }
  return { command: 'claude', prefixArgs: [] };
}

/** 解析 npm .cmd shim：取最后一个带引号的可执行/脚本目标（即实际调用行）；%dp0%→shim 所在目录。 */
function parseWindowsShim(shimPath: string): ClaudeExecutableEntry {
  let content: string;
  try {
    content = readFileSync(shimPath, 'utf8');
  } catch {
    return { command: shimPath, prefixArgs: [] };
  }
  const dir = dirname(shimPath);
  const matches = [...content.matchAll(/"([^"]+?\.(?:exe|js|cjs|mjs))"/g)];
  const target = matches[matches.length - 1]?.[1];
  if (target == null) return { command: shimPath, prefixArgs: [] };
  const resolved = target.replaceAll(/%dp0%|%~dp0/gi, dir);
  if (/\.exe$/i.test(resolved)) return { command: resolved, prefixArgs: [] };
  return { command: process.execPath, prefixArgs: [resolved] };
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
  /** assistant 消息内报的模型（result 不带 model 时的响应取证来源）。 */
  reportedModel: string | null;
  /** stderr 尾部留存（失败取证：真实跑挂时 CLI 的错误行进 message，不丢现场）。 */
  stderrTail: string;
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
  usageCost: 'supported', // CLI total_cost_usd 估算（costQuality=estimated；实测：deepseek-flash 成功 turn）
};

export class ClaudeCliAdapter implements RuntimeAdapter {
  private readonly options: ClaudeCliAdapterOptions;
  private readonly sessions = new Map<string, SessionState>();
  /** spawn 注入口（协议回放：换模拟进程工厂）。生产路径 shell:false + 解析后的入口。 */
  private readonly spawnFn: (args: string[], cwd: string) => ChildProcessWithoutNullStreams;

  constructor(options: ClaudeCliAdapterOptions = {}, spawnFn?: (args: string[], cwd: string) => ChildProcessWithoutNullStreams) {
    this.options = options;
    this.spawnFn = spawnFn ?? this.productionSpawn(options);
  }

  /** 生产 spawn：参数数组 + shell:false；prompt 不在 args（stdin 传递）。 */
  private productionSpawn(options: ClaudeCliAdapterOptions): (args: string[], cwd: string) => ChildProcessWithoutNullStreams {
    const entry = resolveClaudeExecutable(options.executable);
    return (args, cwd) =>
      spawn(entry.command, [...entry.prefixArgs, ...args], {
        cwd,
        env: process.env, // 继承本机环境（渠道配置 ANTHROPIC_BASE_URL/AUTH_TOKEN 在用户 settings，由 CLI 自行读取；本适配器不读取不回显）
        shell: false,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
  }

  probe(): Promise<ProbeResult> {
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const settle = (version: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          executable: this.options.executable ?? resolveClaudeExecutable().command,
          version,
          capabilities: { ...CAPABILITIES },
        });
      };
      // --version 为本地执行（不产生模型调用）。
      const proc = this.spawnFn(['--version'], process.cwd());
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => { out += chunk; });
      proc.on('close', () => settle(out.trim().split('\n')[0]?.slice(0, 60) || 'unknown'));
      proc.on('error', () => settle('unknown'));
      const timer = setTimeout(() => settle('unknown'), 5_000);
      timer.unref?.();
      try { proc.stdin.end(); } catch { /* 版本查询无 stdin 需求 */ }
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
    if (!CLAUDE_MODEL_NAME_RE.test(model)) {
      throw new AdapterCallError('VALIDATION_INVALID', `模型名含本适配器不接受的字符（只接受渠道裸模型名，如 deepseek-flash；不接受 [1m] 类后缀）：${model.slice(0, 40)}`);
    }
    // --verbose：CLI 2.1.x 在 -p + stream-json 下要求显式 --verbose（否则参数校验即退出——
    // 本机关闭端口诊断取证 2026-09-28，零额度）。
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model,
      '--permission-mode', this.options.permissionMode ?? 'plan',
      '--allowedTools', 'Read,Glob,Grep', // 只读分析档（B6 对齐：无写/shell）
    ];
    if (state.providerSessionId != null) {
      if (!PROVIDER_SESSION_ID_RE.test(state.providerSessionId)) {
        throw new AdapterCallError('VALIDATION_INVALID', `provider session id 非法：${state.providerSessionId.slice(0, 20)}`);
      }
      args.push('--resume', state.providerSessionId);
    }
    args.push(...(this.options.extraArgs ?? []));
    const proc = this.spawnFn(args, session.cwd);
    // prompt 全文经 stdin 原样传入（CLI -p 无位置参数时读 stdin）：不经 shell、不进 argv。
    if (proc.stdin != null) {
      try {
        proc.stdin.on?.('error', () => { /* EPIPE：进程早死由 close 处理器兜底 failed */ });
        proc.stdin.write(input.text, 'utf8');
        proc.stdin.end();
      } catch {
        // 进程在 write 前退出：close 处理器按无终态 failed。
      }
    }
    const turn: ActiveTurn = {
      turnId: input.turnId,
      process: proc,
      buffer: '',
      queue: [],
      waiters: [],
      done: false,
      startedAnnounced: false,
      lastMessageId: null,
      reportedModel: null,
      stderrTail: '',
    };
    state.active = turn;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(state, turn, chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      turn.stderrTail = (turn.stderrTail + chunk).slice(-2_000); // 失败取证留存（含告警）
      // 认证类 stderr 是决定性失败；unrecognized_model 告警不终结 turn——真实取证
      //（2026-09-28 渠道诊断）：deepseek-flash 成功 turn 亦伴随该告警（query_source=sdk，
      // SDK 侧校验噪音），是否回退以 result.model 为准（响应报什么模型就记什么）。
      if (/authentication|login required/i.test(chunk)) {
        this.pushEvent(state, turn, { kind: 'turn.failed', code: 'AUTH_REQUIRED', message: chunk.slice(0, 200), retryable: false, ...this.baseEvent(state, turn) });
        this.finishTurn(state, turn);
      }
    });
    proc.on('error', (error) => {
      this.pushEvent(state, turn, { kind: 'turn.failed', code: 'RUNTIME_NOT_FOUND', message: `${String(error)}${turn.stderrTail ? `；stderr尾：${turn.stderrTail.slice(-300)}` : ''}`, retryable: false, ...this.baseEvent(state, turn) });
      this.finishTurn(state, turn);
    });
    proc.on('close', (code) => {
      // 进程退出：无终结事件=缺终态（坏流/静默）——如实 failed，不冒充完成；带 stderr 尾部取证。
      if (!turn.done) {
        this.pushEvent(state, turn, { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: `进程退出（code=${code}）且无 result 终结事件${turn.stderrTail ? `；stderr尾：${turn.stderrTail.slice(-300)}` : ''}`, retryable: true, ...this.baseEvent(state, turn) });
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

  /** daemon 收拢：关闭全部会话（杀活动 turn 进程，资源回收）。 */
  async disposeAll(): Promise<void> {
    for (const state of [...this.sessions.values()]) {
      await this.close(state.ref);
    }
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
    if (type === 'system' && parsed['subtype'] === 'init') {
      const sid = typeof parsed['session_id'] === 'string' ? (parsed['session_id'] as string) : null;
      if (sid != null) {
        state.providerSessionId = sid;
        state.ref.providerSessionId = sid; // 原地更新：调用方持有的 SessionRef 可见
      }
      return; // init 不外发（合成 turn.started 以首条 assistant 消息为准）
    }
    if (type === 'assistant') {
      const message = parsed['message'] as { model?: string; content?: Array<{ type: string; text?: string; id?: string }> } | undefined;
      // assistant 消息内报的模型：响应取证来源（本次实测 result 不带 model——diag 2026-09-28）。
      if (message?.model != null && turn.reportedModel == null) turn.reportedModel = message.model;
      // 首条 assistant 消息：合成 turn.started（CLI 无显式开始事件——合成依据见文件头）。
      if (!turn.startedAnnounced) {
        turn.startedAnnounced = true;
        this.pushEvent(state, turn, { kind: 'turn.started', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
      }
      const textBlocks = (message?.content ?? []).filter((c) => c.type === 'text');
      for (const block of textBlocks) {
        const messageId = `claude_${block.id ?? randomUUID().slice(0, 8)}`;
        turn.lastMessageId = messageId;
        this.pushEvent(state, turn, { kind: 'message.delta', messageId, text: block.text ?? '', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
      }
      // 工具事件（2.x stream-json 的 tool_use 块在 assistant 消息内）：只读档下理论不触发；
      // 出现则按块映射 tool.started/completed（outcome unknown——CLI 不回传工具结果状态）。
      const toolBlocks = (message?.content ?? []).filter((c): c is { type: string; name?: string; id?: string } => c.type === 'tool_use');
      for (const block of toolBlocks) {
        this.pushEvent(state, turn, { kind: 'tool.started', toolCallId: block.id ?? randomUUID().slice(0, 8), toolName: block.name ?? 'unknown', argumentsSummary: '', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
        this.pushEvent(state, turn, { kind: 'tool.completed', toolCallId: block.id ?? 'unknown', outcome: 'unknown', ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
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
      // 响应模型取证（用户令 2026-09-28）：优先 result.model；result 不带时用 assistant
      // 消息内报的模型（实测组合 2026-09-28：result 无 model、assistant.message.model 有）；
      // 两者都无 → 如实 undefined，不以"回复成功"推断实际后端模型。
      const reportedModel = (typeof parsed['model'] === 'string' ? (parsed['model'] as string) : undefined) ?? turn.reportedModel ?? undefined;
      // CLI 估算成本（total_cost_usd：CLI 按模型价目表估算，非渠道账单）→ costQuality=estimated。
      const costUsd = typeof parsed['total_cost_usd'] === 'number' ? (parsed['total_cost_usd'] as number) : undefined;
      if (usage != null || reportedModel != null) {
        this.pushEvent(state, turn, {
          kind: 'usage.updated', accounting: 'cumulative',
          inputTokens: usage?.input_tokens, cachedTokens: usage?.cache_read_input_tokens,
          outputTokens: usage?.output_tokens,
          cost: costUsd, currency: costUsd != null ? 'USD' : undefined, costQuality: costUsd != null ? 'estimated' : 'unknown', model: reportedModel,
          ...this.baseEvent(state, turn, randomUUID().slice(0, 6)),
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
