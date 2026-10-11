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
 * 能力标记（2026-09-28 证据口径，逐项按证据、见 CAPABILITIES 注释）：supported 仅
 * structuredEvents/structuredFinal/usageTokens/usageCost（真实 turn1 全链证据；cost 为 CLI
 * 估算→estimated）；interrupt/resumeSession/restrictWrites/restrictShell/disableDelegation/
 * taskContextIsolation=unverified（实现存在、真实认证未完成，不按支持处理）；steerActiveTurn
 * =unsupported（headless -p 无 turn 内追加输入，明确拒绝不模拟）。
 */
import { claudeInput } from '../imageInput.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AdapterCallError } from '../../contracts/runtime.ts';
import type { AdapterProcessIdentity } from '../../contracts/runtime.ts';
import type {
  NormalizedRuntimeEvent,
  OpenSessionInput,
  ProbeResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  SessionRef,
  TurnRequest,
} from '../../contracts/runtime.ts';

export const CLAUDE_ADAPTER_VERSION = 'claude-cli-2.1.283-adapter-0.3';

/** 渠道裸模型名（deepseek-flash / deepseek/deepseek-v4.1-flash / glm-5.3…）；拒绝 [1m] 类后缀语法。 */
const CLAUDE_MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** provider session id（CLI result session_id）：UUID/字母数字下划线连字符。 */
const PROVIDER_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 能力表（2026-09-28 证据口径，用户令逐项按证据修正；单一真源——probe/命令登记共用）：
 * - supported 仅限有真实或回放+生产链路双证据项：
 *   structuredEvents（真实 turn1 stream-json 全链）、structuredFinal（真实 turn1
 *   TaskComplete 校验+交付）、usageTokens（真实 turn1 usage 落库）、usageCost（CLI
 *   total_cost_usd 估算字段真实存在；costQuality=estimated——不是渠道账单）、
 *   interrupt（真实受控中断 2026-09-28 认证通过：进程证据后停止 2ms 确认、目标/收尾/
 *   不复活/无孤儿全过——范围=CLI 2.1.283+当前渠道+Windows kill 语义；本地 fixture
 *   另有 6 用例）；
 * - unverified（实现存在、真实认证未完成，不得按支持处理）：
 *   resumeSession（--resume 仅回放验证）、restrictWrites/restrictShell/disableDelegation
 *   （--disallowedTools+--permission-prompts none+--bare 等正式机制已实现；参数存在≠已认证，
 *   且 --allowedTools 只是预授权免审批清单、不是禁用其余工具的总白名单——2026-09-28 取证：
 *   init.tools 仍含 Bash 等执行类工具）、taskContextIsolation（进程 cwd+独立会话，回放验证
 *   两任务隔离；真实侧仅单任务）、interactiveApprovals（headless 只读档未开审批通道）；
 * - unsupported（设计性拒绝，不模拟）：steerActiveTurn（headless -p 无 turn 内追加输入）。
 */
const CAPABILITIES: RuntimeCapabilities = {
  structuredEvents: 'supported',
  taskContextIsolation: 'unverified',
  resumeSession: 'unverified',
  steerActiveTurn: 'unsupported',
  interrupt: 'supported',
  interactiveApprovals: 'unverified',
  structuredFinal: 'supported',
  restrictWrites: 'unverified',
  restrictShell: 'unverified',
  disableDelegation: 'unverified',
  usageTokens: 'supported',
  usageCost: 'supported', // CLI 估算（estimated），非渠道实际账单
};

/** probe/成员登记共用的能力表快照（单一真源）。 */
export function claudeCapabilities(): RuntimeCapabilities {
  return { ...CAPABILITIES };
}

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
  /** 权限模式（CLI 2.1.283 实际枚举；默认 plan 只读档）。 */
  permissionMode?: 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';
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
  // 显式路径=成员/安装绑定（第二十三轮四）：**一律按绑定执行，不静默回落全局默认**
  //（路径无效=spawn ENOENT→RUNTIME_NOT_FOUND 明确失败——换路径必须显式换绑定，不能替用户猜）。
  if (explicit != null && explicit.length > 0 && !/^(claude|claude\.cmd)$/i.test(explicit)) {
    if (/\.(cmd|bat)$/i.test(explicit)) return parseWindowsShim(explicit);
    if (process.platform === 'win32') {
      if (/\.exe$/i.test(explicit)) return { command: explicit, prefixArgs: [] };
      if (/\.(js|cjs|mjs)$/i.test(explicit)) return { command: process.execPath, prefixArgs: [explicit] };
      return { command: explicit, prefixArgs: [] }; // 无扩展等：字面 spawn——失败即 RUNTIME_NOT_FOUND
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
  /** 请求续接的 ID（--resume 参数）——与 provider 实际上报 ID 分离（第二十一轮三）。 */
  resumeRequested: string | null;
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
  /** 停止请求已发（与"已确认退出"分离：kill≠退出）。 */
  stopRequested: boolean;
  /** 终态来源：result=CLI 正常/错误终态；interrupted=停止请求后 close 兜底。 */
  terminalKind: 'result' | 'error' | 'interrupted' | null;
  /** 进程退出已确认（close 事件到达）。 */
  exitConfirmed: boolean;
  exitCode: number | null;
  /** 等待退出确认的解决器（close 到达或超时由调用方处理）。 */
  exitWaiters: Array<(r: TurnExitState) => void>;
}

/** turn 进程退出状态（停止请求与退出确认分离的取证口径）。 */
export interface TurnExitState {
  turnId: string;
  stopRequested: boolean;
  exitConfirmed: boolean;
  exitCode: number | null;
  /** 终态事件来源（result=CLI 正常终态；interrupted=停止请求后无 result 的 close 兜底）。 */
  terminal: 'result' | 'interrupted' | 'error' | 'none';
}

export class ClaudeCliAdapter implements RuntimeAdapter {
  private readonly options: ClaudeCliAdapterOptions;
  private readonly sessions = new Map<string, SessionState>();
  /** spawn 注入口（协议回放：换模拟进程工厂）。生产路径 shell:false + 解析后的入口。 */
  private readonly spawnFn: (args: string[], cwd: string) => ChildProcessWithoutNullStreams;

  // REC-LIFE-1：受管运行时（Job Object）经 spawnFn 注入（daemon 层构造时提供）——
  // adapter 边界不感知受管实现（§8.4：adapter 不 import daemon）。
  constructor(options: ClaudeCliAdapterOptions = {}, spawnFn?: (args: string[], cwd: string) => ChildProcessWithoutNullStreams) {
    this.options = options;
    this.spawnFn = spawnFn ?? this.productionSpawn(options);
  }

  /** 生产 spawn：参数数组 + shell:false；prompt 不在 args（stdin 传递）。
   * REC-LIFE-1（第十二轮）：ZS_MANAGED_RUNTIME=1 时走受管桥（Job Object 挂起纳管）——
   * 桥不可用直接抛错拒绝派发，**不降级为未受管运行**；未设变量维持既有 spawn 路径。 */
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
    // 续接事实分离（第二十一轮三）：resume 请求 ID 只进 state.resumeRequested（CLI 的
    // --resume 参数），**不**填 providerSessionId——openSession 返回值不是 provider 已接受
    // 续接的证据（真实 ID 由 init/result 事件上报后原地回填）。
    const ref: SessionRef = {
      id,
      providerSessionId: '',
      runtimeInstallationId: this.options.installationId ?? 'claude-cli-default',
      adapterVersion: CLAUDE_ADAPTER_VERSION,
      threadId: input.threadId,
      sessionGeneration: input.sessionGeneration,
      cwd: input.cwd,
    };
    this.sessions.set(id, { ref, active: null, providerSessionId: null, resumeRequested: input.resume?.providerSessionId ?? null, closed: false, subscribers: [] });
    return ref;
  }

  async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
    if (state.active != null && !state.active.done) {
      throw new AdapterCallError('WORKSPACE_BUSY', '会话已有进行中的 turn（进程模型：串行）');
    }
    if (state.closed) throw new AdapterCallError('RESOURCE_NOT_FOUND', '会话已关闭');
    const payload = claudeInput(input);
    const model = this.options.model ?? process.env.ZS_CLAUDE_MODEL;
    if (model == null || model.length === 0) {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Claude 需显式模型（ZS_CLAUDE_MODEL / options.model）——默认配置模型不被 CLI 接受');
    }
    if (!CLAUDE_MODEL_NAME_RE.test(model)) {
      throw new AdapterCallError('VALIDATION_INVALID', `模型名含本适配器不接受的字符（只接受渠道裸模型名，如 deepseek-flash；不接受 [1m] 类后缀）：${model.slice(0, 40)}`);
    }
    // 只读分析档（B6 对齐）——按 CLI 2.1.283 正式机制组合，而非单一参数（取证 2026-09-28：
    // --allowedTools 只是"预授权免审批"清单，init.tools 仍含 Bash 等执行类工具，不是总白名单）：
    // - --permission-mode plan + --permission-prompts none：headless 下任何需审批的动作自动拒绝；
    // - --allowedTools Read,Glob,Grep：只读三件套预授权（免审批即用）；
    // - --disallowedTools：明确禁用执行/写入/网络/委派/技能类工具（含 mcp__ 通配）；
    // - --strict-mcp-config（不传 --mcp-config）：不加载任何附加 MCP 服务器；
    // - --bare：跳过 hooks/插件/LSP/auto-memory 等用户 settings 附加能力（凭据 env 不受影响）；
    // - --disable-slash-commands：禁用技能。
    // 注：--restricted 能移除执行类内置工具，但会忽略 user settings（渠道 env/凭据在其中）——不可用。
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model,
      '--permission-mode', this.options.permissionMode ?? 'plan',
      '--permission-prompts', 'none',
      '--allowedTools', 'Read,Glob,Grep',
      '--disallowedTools', 'Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,Skill,TodoWrite,mcp__*',
      '--strict-mcp-config', '--bare', '--disable-slash-commands',
    ];
    if (payload.stream) args.push('--input-format', 'stream-json');
    const resumeId = state.providerSessionId ?? state.resumeRequested;
    if (resumeId != null) {
      if (!PROVIDER_SESSION_ID_RE.test(resumeId)) {
        throw new AdapterCallError('VALIDATION_INVALID', `provider session id 非法：${resumeId.slice(0, 20)}`);
      }
      args.push('--resume', resumeId);
    }
    args.push(...(this.options.extraArgs ?? []));
    const proc = this.spawnFn(args, session.cwd);
    // prompt 全文经 stdin 原样传入（CLI -p 无位置参数时读 stdin）：不经 shell、不进 argv。
    if (proc.stdin != null) {
      try {
        proc.stdin.on?.('error', () => { /* EPIPE：进程早死由 close 处理器兜底 failed */ });
        proc.stdin.write(payload.stdin, 'utf8');
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
      stopRequested: false,
      terminalKind: null,
      exitConfirmed: false,
      exitCode: null,
      exitWaiters: [],
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
        turn.terminalKind = 'error';
        this.pushEvent(state, turn, { kind: 'turn.failed', code: 'AUTH_REQUIRED', message: chunk.slice(0, 200), retryable: false, ...this.baseEvent(state, turn) });
        this.finishTurn(state, turn);
      }
    });
    proc.on('error', (error) => {
      turn.terminalKind = turn.terminalKind ?? 'error';
      this.pushEvent(state, turn, { kind: 'turn.failed', code: 'RUNTIME_NOT_FOUND', message: `${String(error)}${turn.stderrTail ? `；stderr尾：${turn.stderrTail.slice(-300)}` : ''}`, retryable: false, ...this.baseEvent(state, turn) });
      this.finishTurn(state, turn);
      this.resolveExitWaiters(turn); // spawn 失败：close 可能不达——释放等待器（exitConfirmed=false 如实）
    });
    proc.on('close', (code) => {
      // 退出确认（与停止请求分离）：close 到达才算退出；等待器统一在此解决。
      turn.exitConfirmed = true;
      turn.exitCode = code;
      // 进程退出：无终结事件=缺终态（坏流/静默）——如实 failed，不冒充完成；带 stderr 尾部取证。
      // 停止请求后的无 result 退出=INTERRUPTED（worker 映射 CANCELLED），区别于故障。
      if (!turn.done) {
        const interrupted = turn.stopRequested;
        turn.terminalKind = interrupted ? 'interrupted' : 'error';
        this.pushEvent(state, turn, {
          kind: 'turn.failed',
          code: interrupted ? 'INTERRUPTED' : 'PROVIDER_ERROR',
          message: interrupted
            ? `停止请求后进程退出（code=${code}）且无 result 终结事件；stderr尾：${turn.stderrTail.slice(-300)}`
            : `进程退出（code=${code}）且无 result 终结事件${turn.stderrTail ? `；stderr尾：${turn.stderrTail.slice(-300)}` : ''}`,
          retryable: !interrupted,
          ...this.baseEvent(state, turn),
        });
      }
      this.pushEvent(state, turn, { kind: 'process.exited', exitCode: code, expected: turn.done, ...this.baseEvent(state, turn) });
      this.finishTurn(state, turn);
      this.resolveExitWaiters(turn);
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
    // 停止请求已发（kill）；退出确认由 close 事件回执（waitForTurnExit/close 可等）。
    // Windows 无 SIGINT 语义：kill 触发 close；close 处理器发 INTERRUPTED 终态（无 result 时）。
    turn.stopRequested = true;
    try {
      turn.process.kill();
    } catch {
      // kill 抛错（已死/权限）：close 处理器兜底；等待器由其解决。
    }
  }

  /**
   * 等待 turn 进程退出确认（宽限上限；超时=无法确认退出，如实返回 exitConfirmed=false——
   * 不假装已停止）。无活动 turn 时立即返回该 turn 的最终状态（或 null）。
   */
  waitForTurnExit(session: SessionRef, turnId: string, timeoutMs = 5_000): Promise<TurnExitState | null> {
    const state = this.sessions.get(session.id);
    const turn = state?.active ?? null;
    if (state == null || turn == null || turn.turnId !== turnId) return Promise.resolve(null);
    if (turn.exitConfirmed) return Promise.resolve(this.exitStateOf(turn));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = turn.exitWaiters.indexOf(resolve);
        if (i >= 0) turn.exitWaiters.splice(i, 1);
        resolve(this.exitStateOf(turn)); // 宽限耗尽：无法确认退出（不确认=不假装）
      }, timeoutMs);
      timer.unref?.();
      const wrapped = () => { clearTimeout(timer); resolve(this.exitStateOf(turn)); };
      turn.exitWaiters.push(wrapped);
    });
  }

  async close(session: SessionRef): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state == null) return;
    state.closed = true;
    if (state.active != null && !state.active.done) {
      state.active.stopRequested = true;
      try { state.active.process.kill(); } catch { /* close 兜底 */ }
      // 有界等待退出确认（不等=可能孤儿进程；超时=不确定，如实留在汇总里）。
      await this.waitForTurnExit(session, state.active.turnId, 3_000);
    }
    this.sessions.delete(session.id);
  }

  /** 每 turn 独立子进程（startTurn spawn）——活动 turn 的 PID 专属该 turn（DEV-13 取证）。 */
  processIdentity(session: SessionRef, turnId: string): AdapterProcessIdentity | null {
    const state = this.sessions.get(session.id);
    if (state == null) return null;
    if (state.active?.turnId !== turnId) return null;
    // 受管桥进程对象携带稳定身份 managedJobId（结构化可选属性——契约允许，未受管进程无此字段）。
    return { model: 'per-turn', pid: state.active.process.pid ?? null, managedJobId: (state.active.process as { managedJobId?: string }).managedJobId ?? null };
  }

  async respondApproval(_session: SessionRef, _approvalId: string, _choice: 'allow_once' | 'deny'): Promise<void> {
    void _session; void _approvalId; void _choice;
    throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Claude headless 只读档未开审批通道（unverified；不模拟）');
  }

  /**
   * daemon 收拢：关闭全部会话（杀活动 turn 进程并等待退出确认）。
   * 返回逐会话退出汇总（未确认/失败不吞——上层据此上报，不假装全部成功）。
   */
  async disposeAll(): Promise<TurnExitState[]> {
    const entries = [...this.sessions.values()];
    const results: TurnExitState[] = [];
    for (const state of entries) {
      const activeTurn = state.active != null && !state.active.done ? state.active : null;
      const turnId = activeTurn?.turnId ?? null;
      await this.close(state.ref);
      if (turnId != null && activeTurn != null) results.push(this.exitStateOf(activeTurn));
    }
    return results;
  }

  // ---------- 内部 ----------

  private stateOf(session: SessionRef): SessionState {
    const state = this.sessions.get(session.id);
    if (state == null) throw new AdapterCallError('RESOURCE_NOT_FOUND', `会话不存在或已关闭：${session.id}`);
    return state;
  }

  /** provider 身份上报的统一入口（第二十二轮三）：原地回填 + 观察序列（去重按上报顺序）。
   * 同轮多个不同非空上报=协议异常——终态结算据此不冒充原生续接（worker 侧判定）。 */
  private recordReportedId(state: SessionState, sid: string): void {
    state.providerSessionId = sid;
    state.ref.providerSessionId = sid;
    const trimmed = sid.trim();
    if (trimmed.length === 0) return; // 空串上报不入观察序列（空=未上报语义）
    const list = state.ref.observedSessionIds ?? (state.ref.observedSessionIds = []);
    if (!list.includes(trimmed)) list.push(trimmed);
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
        this.recordReportedId(state, sid); // 原地更新+观察序列（init 上报）
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
      // 停止请求后的迟到 result 不作为终态：不产生成功交付/复活（用户令 2026-09-28）；
      // 留取证，close 兜底发 INTERRUPTED。
      if (turn.stopRequested) {
        turn.stderrTail = (turn.stderrTail + `\n[late-result-after-stop ignored] ${line.slice(0, 200)}`).slice(-2_000);
        return;
      }
      const isError = parsed['is_error'] === true;
      const sid = typeof parsed['session_id'] === 'string' ? (parsed['session_id'] as string) : null;
      if (sid != null) {
        this.recordReportedId(state, sid); // 原地回填+观察序列（result 上报——第二十一轮三原地语义保持）
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
        turn.terminalKind = 'error';
        this.pushEvent(state, turn, {
          kind: 'turn.failed', code: subtype.startsWith('error_') ? subtype.slice(6).toUpperCase() : 'PROVIDER_ERROR',
          message: String(parsed['result'] ?? subtype), retryable: subtype !== 'error_during_execution',
          ...this.baseEvent(state, turn, randomUUID().slice(0, 6)),
        } as NormalizedRuntimeEvent);
      } else {
        turn.terminalKind = 'result';
        this.pushEvent(state, turn, { kind: 'turn.completed', finalText: String(parsed['result'] ?? ''), ...this.baseEvent(state, turn, randomUUID().slice(0, 6)) } as NormalizedRuntimeEvent);
      }
      this.finishTurn(state, turn);
    }
  }

  private exitStateOf(turn: ActiveTurn): TurnExitState {
    return {
      turnId: turn.turnId,
      stopRequested: turn.stopRequested,
      exitConfirmed: turn.exitConfirmed,
      exitCode: turn.exitCode,
      terminal: turn.done ? (turn.stopRequested ? 'interrupted' : 'result') : 'none',
    };
  }

  private resolveExitWaiters(turn: ActiveTurn): void {
    const waiters = [...turn.exitWaiters];
    turn.exitWaiters.length = 0;
    for (const w of waiters) w(this.exitStateOf(turn));
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
