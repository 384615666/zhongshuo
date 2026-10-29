/**
 * Codex App Server 适配器（DEV-06 修复轮：终态映射/事件归属/生命周期/审批绑定/resume）。
 * 协议依据：codex-cli 0.157.1 `app-server generate-ts`（tests/fixtures/codex-protocol/）。
 *
 * 修复轮要点（外部只读审查后）：
 * - turn/completed 按 turn.status 映射：completed→turn.completed；interrupted→turn.failed
 *   {code:'INTERRUPTED'}；failed→turn.failed{code:error.kind,message}。工具 item 按
 *   status（completed/failed/declined）映射 outcome，不再一律 success。
 * - 事件归属：provider turnId↔内部 turnId 映射；startTurn 先登记 awaiting turn，
 *   turn/started 早于响应也能建立映射；缺失、未知或歧义身份的通知仅记无正文诊断。
 * - 审批绑定：v2 请求带 threadId/turnId → 精确定位会话与轮次；legacy conversationId →
 *   会话；无法定位的请求按协议 deny，不投递、不悬挂。
 * - 生命周期：进程代次（generation）管理；旧子进程 close 回调不清新代次的 child/pending；
 *   每次新连接重置协议状态并完成 initialize + initialized 通知（官方握手要求）。
 * - resume：openSession 消费 input.resume → thread/resume（真实续接验证随 PP-02）。
 * - 能力自报：仅 structuredEvents=supported（真实进程观察到通知链路）；其余 unverified
 *   或 unsupported——协议字段存在、方法实现、真实行为通过是三个不同状态。
 */
import { codexInput } from '../imageInput.ts';
import {codexConfigurationIdentity} from './configuration.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
import {
  runtimeToolResultSummary,
  runtimeToolSummary,
  type RuntimeToolSummary,
} from '../../contracts/runtimeProgress.ts';
import { EventStream } from '../eventStream.ts';

const ADAPTER_VERSION = 'codex-appserver-adapter-0.2.0';
export const SUPPORTED_CODEX_VERSION_PREFIX = '0.157.';
export const CODEX_STRUCTURED_FINAL_INSTRUCTION = `## 原生结构化终态（最高优先级）
当本轮 turn/start 携带 outputSchema 时，最后一条 assistant message 必须只包含一个原始 JSON 对象，并严格匹配该 schema。
- 不得使用 Markdown 或代码围栏。
- 不得在 JSON 前后添加解释、计划、寒暄、状态、分隔符或其他文本。
- 用户可见的回答与工作摘要必须写入 schema 约定的 answer/changeSummary 等字段。
- 中途进度可以单独发送，但 turn 的最后一条 assistant message 必须是完整 JSON 终态。`;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

type DistOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type EventSpec = DistOmit<NormalizedRuntimeEvent, 'eventKey' | 'sessionId' | 'receivedAt'>;

interface TurnStartState {
  internalTurnId: string;
  providerTurnId: string | null;
  accepted: boolean;
  requestId?: number;
  buffered: Array<{ spec: EventSpec; turnId?: string }>;
}

interface ProviderTurnIdentity {
  processGeneration: number;
  sessionId: string;
  internalTurnId: string;
  retired: boolean;
}

interface ServerApproval {
  rpcId: string | number;
  legacy: boolean;
  sessionId: string;
  processGeneration: number;
  internalTurnId: string;
  providerTurnId?: string;
}

interface SessionState {
  processGeneration: number;
  memberId: string;
  writeAccess?: OpenSessionInput['writeAccess'];
  ref: SessionRef;
  stream: EventStream;
  providerThreadId: string;
  providerTurnToInternal: Map<string, string>;
  /** 本会话待认领 turn（按会话隔离：双会话并发 startTurn 不互扰，修复轮 3）。 */
  awaitingTurn: TurnStartState | null;
  /** Several response-pending attempts can coexist after an early ID binding. */
  startingTurns: Map<string, TurnStartState>;
  /** Frozen workflow stage per internal turn; association only, never inferred. */
  turnStages: Map<string, string>;
  /** Start metadata paired with later completion items that omit details. */
  toolSummaries: Map<string, RuntimeToolSummary>;
  seq: number;
}

interface ToolLikeItem extends Record<string, unknown> {
  status?: unknown;
}

interface CodexToolActivity {
  toolName: string;
  summary: RuntimeToolSummary;
  /** Safe project-relative file identities for evidence capture; outside paths are omitted. */
  paths?: string[];
}

export interface CodexAdapterOptions {
  /** Project context for metadata discovery and the actual app-server process. */
  cwd?:string;
  /** Explicit member program reference; default names retain the existing npm shim lookup. */
  executable?: string;
  codexCmdPath?: string;
  requestTimeoutMs?: number;
  /** Metadata preparation must confirm its own child closed before freezing input. */
  requireConfirmedClose?:boolean;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** thread/start 的 model 覆盖（e2e 认证用低成本渠道，如 gpt-6 luna）。 */
  model?: string;
  effort?:string;
  /** 审批策略（默认 never=M0 不开审批桥；认证用例可开 on-request）。 */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /** 测试注入：替换 spawn 的脚本入口（本地协议回放，不消耗额度）。 */
  mockEntry?: { executable: string; args?: string[] };
  /** 生产 spawn 注入点（REC-LIFE-1：daemon 层注入 Job Object 受管桥；缺省=普通 spawn）。 */
  spawnFn?: (cmd: string, args: string[],cwd?:string) => ChildProcessWithoutNullStreams;
}

export interface CodexInvocation { command:string;args:string[];identityPath:string }
/** File-only resolver shared by display and actual spawning. Never substitutes an explicit reference. */
export function resolveCodexInvocation(executable?:string,codexCmdPath?:string):CodexInvocation {
  const explicit=executable!=null&&!/^(codex|codex\.cmd)$/i.test(executable)?executable:null;
  const script=(p:string):CodexInvocation=>({command:process.execPath,args:[p],identityPath:p});
  if(explicit!=null&&!/\.(cmd|bat)$/i.test(explicit))return /\.(js|cjs|mjs)$/i.test(explicit)?script(explicit):{command:explicit,args:[],identityPath:explicit};
  const cmdPath=explicit??codexCmdPath??(process.env.PATH??'').split(delimiter).filter(Boolean).map(dir=>join(dir.trim(),'codex.cmd')).find(p=>existsSync(p));
  if(cmdPath==null)throw new AdapterCallError('RUNTIME_NOT_FOUND','未找到 codex 可执行入口（PATH 无 codex.cmd）');
  try{if(!statSync(cmdPath).isFile())throw Error('not a file');}catch{throw new AdapterCallError('RUNTIME_NOT_FOUND','保存的 Codex 程序引用不存在；不回落其他程序');}
  const candidate=join(cmdPath,'..','node_modules','@openai','codex','bin','codex.js');
  if(existsSync(candidate))return script(candidate);
  let shim:string;try{shim=readFileSync(cmdPath,'utf8');}catch{throw new AdapterCallError('RUNTIME_NOT_FOUND','保存的 Codex 程序引用不可读取；不回落其他程序');}
  const m=shim.match(/"([^"]+[@\\/]openai[\\/][^"]*codex[^"]*\.js)"/)??shim.match(/node\s+"([^"]+codex[^"]*\.js)"/);
  if(m==null)throw new AdapterCallError('RUNTIME_NOT_FOUND','保存的 Codex shim 无法解析脚本入口；不回落其他程序');
  return script(m[1]!.replaceAll(/%dp0%|%~dp0/gi,dirname(cmdPath)+(process.platform==='win32'?'\\':'/')));
}

export class CodexAppServerAdapter implements RuntimeAdapter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private childGeneration = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { processGeneration: number; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; onResult?: (v: unknown) => void }>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly serverRequests = new Map<string, ServerApproval>();
  /** Retain ownership after completion/close without suppressing the old stream.
   * A later attempt may not claim the same identity in this process generation. */
  private readonly providerTurns = new Map<string, ProviderTurnIdentity>();
  private buffer = '';
  private stderrTail = '';
  /** 每个进程连接的握手状态：连接重建即重置（修复轮）。 */
  private handshakeDone = false;
  private readonly options: Required<Pick<CodexAdapterOptions, 'requestTimeoutMs' | 'sandboxMode'>> & { requireConfirmedClose?:boolean; cwd?:string; effort?:string; executable?:string; codexCmdPath?: string; model?: string; approvalPolicy?: CodexAdapterOptions['approvalPolicy']; mockEntry?: CodexAdapterOptions['mockEntry']; spawnFn?: CodexAdapterOptions['spawnFn'] };
  private codexVersion: string | null = null;
  private executable: string | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      executable:options.executable,
      cwd:options.cwd,
      codexCmdPath: options.codexCmdPath,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      requireConfirmedClose:options.requireConfirmedClose,
      sandboxMode: options.sandboxMode ?? 'danger-full-access',
      model: options.model,
      effort:options.effort,
      approvalPolicy: options.approvalPolicy,
      mockEntry: options.mockEntry,
      spawnFn: options.spawnFn,
    };
  }

  // ---------- 进程与协议 ----------

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child != null && this.child.exitCode == null && this.child.signalCode == null) return this.child;
    const entry = this.invocation();
    const generation = ++this.childGeneration;
    // A previous process may have exited before its delayed close callback.
    // Retire only its generation now; it must not retain a startup reservation
    // or settle a response received on the replacement connection.
    for (const session of this.sessions.values()) if (session.processGeneration !== generation) {
      session.awaitingTurn = null;
      session.startingTurns.clear();
      this.invalidateApprovals(session);
    }
    for (const [id, pending] of this.pending) if (pending.processGeneration !== generation) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new AdapterCallError('RUNTIME_NOT_FOUND', '执行请求所属连接已经结束'));
    }
    for (const [key, identity] of this.providerTurns) if (identity.processGeneration !== generation) this.providerTurns.delete(key);
    this.buffer = '';
    this.stderrTail = '';
    this.handshakeDone = false; // 新连接必须重新 initialize + initialized（修复轮）
    // REC-LIFE-1：受管 spawn 经 spawnFn 注入（daemon 层提供 Job Object 桥；adapter 不感知）。
    const spawnServer = this.options.spawnFn ?? ((cmd: string, args: string[]) => spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd:this.options.cwd,
    }) as ChildProcessWithoutNullStreams);
    const args=[...entry.args,'app-server'];
    const child = this.options.cwd ? spawnServer(entry.command,args,this.options.cwd) : spawnServer(entry.command,args);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (generation === this.childGeneration) this.onStdout(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      if (generation !== this.childGeneration) return;
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      process.stderr.write(`[codex-appserver] ${chunk}`);
    });
    child.on('close', (code) => {
      // 共享进程退出仅通知其自身代次，不能终结重连后创建的新会话。
      for (const session of [...this.sessions.values()]) {
        if (session.processGeneration !== generation) continue;
        session.awaitingTurn = null;
        session.startingTurns.clear();
        this.invalidateApprovals(session);
        session.seq += 1;
        session.stream.push({
          kind: 'process.exited',
          eventKey: `${session.ref.id}:${session.seq}`,
          sessionId: session.ref.id,
          exitCode: code,
          expected: true,
          receivedAt: Date.now(),
        } as NormalizedRuntimeEvent);
      }
      for (const [id, entry] of this.pending) {
        if (entry.processGeneration !== generation) continue;
        const { reject, timer } = entry;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AdapterCallError('RUNTIME_NOT_FOUND', `app-server 进程退出（code=${code}）`));
      }
      for (const [key, identity] of this.providerTurns) if (identity.processGeneration === generation) this.providerTurns.delete(key);
      if (generation !== this.childGeneration) return;
      this.child = null;
    });
    this.child = child;
    return child;
  }

  private invocation():CodexInvocation {
    if(this.options.mockEntry!=null)return{command:process.execPath,args:[this.options.mockEntry.executable,...(this.options.mockEntry.args??[])],identityPath:this.options.mockEntry.executable};
    return resolveCodexInvocation(this.options.executable,this.options.codexCmdPath);
  }

  private request<T = unknown>(method: string, params?: unknown, onResult?: (v: unknown) => void, onRequest?: (id: number) => void): Promise<T> {
    this.ensureProcess();
    const processGeneration = this.childGeneration;
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterCallError('RUNTIME_NOT_FOUND', `${method} 请求超时（${this.options.requestTimeoutMs}ms）`));
      }, this.options.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { processGeneration, resolve: resolve as (v: unknown) => void, reject, timer, onResult });
      try {
        onRequest?.(id);
        this.writeLine(`${JSON.stringify(message)}`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : Error('执行连接请求写入失败'));
      }
    });
  }

  private writeLine(line: string): void {
    this.ensureProcess();
    this.child!.stdin.write(`${line}\n`);
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
      if (typeof message['id'] !== 'number') return; // Our client requests use numeric IDs only.
      const id = message['id'];
      const entry = this.pending.get(id);
      if (entry == null || entry.processGeneration !== this.childGeneration) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (message['error'] != null) {
        const err = message['error'] as { message?: string; code?: number };
        entry.reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', `JSON-RPC 错误（${err.code ?? '?'}）：${err.message ?? '未知'}`));
      } else {
        // 同步点：映射注册先于同 chunk 后续通知的处理（await 微任务不参与顺序，修复轮 3）。
        try {
          if (entry.onResult != null) entry.onResult(message['result']);
          entry.resolve(message['result']);
        } catch (error) {
          entry.reject(error instanceof Error ? error : new AdapterCallError('CAPABILITY_UNSUPPORTED', '执行连接返回了无效的启动身份'));
        }
      }
      return;
    }
    if (message['id'] != null && typeof message['method'] === 'string') {
      const id = message['id'];
      if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) return;
      this.handleServerRequest(id, message['method'], message['params'] as Record<string, unknown> | undefined);
      return;
    }
    if (typeof message['method'] === 'string') {
      this.handleNotification(message['method'], message['params'] as Record<string, unknown> | undefined);
    }
  }

  // ---------- 审批：绑定准确会话/轮次，未知归属按协议 deny ----------

  private handleServerRequest(id: string | number, method: string, params: Record<string, unknown> | undefined): void {
    const p = params ?? {};
    // An unresolved RPC ID belongs to its original request. A second request
    // must not replace it or send a response that would resolve the original.
    if ([...this.serverRequests.values()].some(approval => approval.processGeneration === this.childGeneration && approval.rpcId === id)) return;
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    if (!legacy && method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      void this.writeServerResponse(id, { error: { code: -32601, message: 'Unsupported server request' } }).catch(() => undefined);
      return;
    }
    const approvalId = `appr_${id}_${this.childGeneration}_${randomUUID()}`;
    const turn = p['turn'];
    const threads = [p['threadId'], p['conversationId'], ...(isRecordValue(turn) ? [turn['threadId'], turn['conversationId']] : [])].filter(value => value !== undefined);
    const turns = [p['turnId'], ...(isRecordValue(turn) ? [turn['id'], turn['turnId']] : [])].filter(value => value !== undefined);
    const valid = (values: unknown[]) => values.every(value => typeof value === 'string' && value.length > 0 && value === values[0]);
    const threadKey = threads[0];
    const providerTurnId = turns[0];
    const malformedTurn = turn !== undefined && (!isRecordValue(turn) || typeof turn['id'] !== 'string');
    const malformed = !valid(threads) || threads.length === 0 || !valid(turns) || malformedTurn
      || (p['threadId'] !== undefined && turns.length === 0);
    const session = !malformed && typeof threadKey === 'string'
      ? this.sessionByThread(threadKey, typeof providerTurnId === 'string' ? providerTurnId : undefined)
      : undefined;
    const internalTurnId = session != null ? this.internalTurnOf(session, typeof providerTurnId === 'string' ? providerTurnId : undefined) : undefined;
    const identity = session != null && typeof providerTurnId === 'string' ? this.providerIdentity(session, providerTurnId) : undefined;
    if (session == null || internalTurnId == null || identity?.retired === true) {
      // 无法定位归属：按协议拒绝（不悬挂服务端请求，也不投递给错误会话）。
      void this.respondToServer(id, this.approvalResult(legacy, 'deny')).catch(() => undefined);
      return;
    }
    const payloadHash = createHash('sha256').update(JSON.stringify({ method, params })).digest('hex');
    this.serverRequests.set(approvalId, { rpcId: id, legacy, sessionId: session.ref.id, processGeneration: session.processGeneration, internalTurnId, ...(typeof providerTurnId === 'string' ? { providerTurnId } : {}) });
    this.emit(session, {
      kind: 'approval.requested',
      approvalId,
      request: { method, params, payloadHash },
      allowedChoices: ['allow_once', 'deny'],
    }, internalTurnId);
  }

  private approvalResult(legacy: boolean, choice: 'allow_once' | 'deny'): { decision: unknown } {
    return { decision: legacy ? choice === 'allow_once' ? 'approved' : { denied: { rejection: 'User denied this execution request' } } : choice === 'allow_once' ? 'accept' : 'decline' };
  }

  private async respondToServer(id: string | number, result: unknown, generation = this.childGeneration): Promise<void> {
    await this.writeServerResponse(id, { result }, generation);
  }

  private async writeServerResponse(id: string | number, response: { result: unknown } | { error: { code: number; message: string } }, generation = this.childGeneration): Promise<void> {
    // Replies may only use their existing live transport; never ensureProcess.
    const child = this.child;
    if (generation !== this.childGeneration || child == null || child.exitCode != null || child.signalCode != null || child.stdin.destroyed) {
      throw new AdapterCallError('RESOURCE_NOT_FOUND', '执行确认所属连接已经结束');
    }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...response }) + '\n');
  }

  // ---------- 通知映射（§9.4；按 provider turn 精确归属） ----------

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    const p = params ?? {};
    const threadKey = typeof p['threadId'] === 'string' ? p['threadId'] : null;
    const nestedTurnId = (p['turn'] as { id?: unknown } | undefined)?.id;
    const providerTurnId = typeof p['turnId'] === 'string' ? p['turnId'] : typeof nestedTurnId === 'string' ? nestedTurnId : undefined;
    if (!threadKey || !providerTurnId) {
      this.ignoredNotification('missing-identity');
      return;
    }
    if (p['turnId'] != null && nestedTurnId != null && p['turnId'] !== nestedTurnId) {
      this.ignoredNotification('conflicting-turn');
      return;
    }
    const session = this.sessionByThread(threadKey, providerTurnId, method === 'turn/started');
    if (session == null) {
      if (method === 'error' && p['willRetry'] !== true && !this.providerTurns.has(JSON.stringify([this.childGeneration, threadKey, providerTurnId]))) {
        // A precise failure may precede started. Reject the sole unbound start
        // conservatively without claiming that provider ID or publishing text.
        const unbound = [...this.sessions.values()].filter(s => s.processGeneration === this.childGeneration && s.providerThreadId === threadKey)
          .flatMap(s => [...s.startingTurns.values()].filter(attempt => attempt.providerTurnId === null));
        if (unbound.length === 1) this.rejectStartRequest(unbound[0]!, '执行连接在启动响应前报告本轮失败');
      }
      this.ignoredNotification('unknown-or-ambiguous');
      return;
    }
    // 只有带完整身份的 turn/started 可认领唯一待启动轮次；普通消息不能猜测 awaiting。
    if (method === 'turn/started') this.registerTurnMapping(session, providerTurnId);
    const internalTurnId = session.providerTurnToInternal.get(providerTurnId);
    if (internalTurnId == null) {
      this.ignoredNotification('unknown-or-ambiguous');
      return;
    }

    switch (method) {
      case 'turn/started': {
        // 真实协议：TurnStartedNotification = { threadId, turn }——provider ID 只在 turn.id。
        this.emit(session, { kind: 'turn.started', providerTurnId }, internalTurnId);
        break;
      }
      case 'item/agentMessage/delta': {
        this.emit(session, {
          kind: 'message.delta',
          messageId: String(p['itemId'] ?? randomUUID()),
          text: String(p['delta'] ?? ''),
        }, internalTurnId);
        break;
      }
      case 'item/completed': {
        const item = p['item'] as ToolLikeItem | undefined;
        const type = item?.['type'];
        if (type === 'agentMessage') {
          this.emit(session, {
            kind: 'message.completed',
            messageId: String(item?.['id'] ?? randomUUID()),
            text: String(item?.['text'] ?? ''),
          }, internalTurnId);
        } else if (type === 'commandExecution' || type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall') {
          const toolCallId=String(item?.['id'] ?? randomUUID());
          const activity=codexToolActivity(item,session.ref.cwd);
          const activityKey=toolActivityKey(internalTurnId??providerTurnId,toolCallId);
          const stored=session.toolSummaries.get(activityKey);
          const summary=stored??activity?.summary;
          if(activity!=null&&stored==null)session.toolSummaries.set(activityKey,activity.summary);
          const resultSummary=toolFailureSummary(item);
          this.emit(session, {
            kind: 'tool.completed',
            toolCallId,
            outcome: toolOutcome(item?.['status']),
            ...(summary!=null?{action:summary.action,target:summary.target}:{}),
            ...(resultSummary.length>0?{resultSummary}:{}),
            // 拒绝原因留痕（B6 证据绑定，修复轮 4）：declined=权限拒绝；
            // failed 附 exitCode，且 aggregatedOutput 命中沙箱/权限拒绝签名时标记
            // sandbox-denial——纯 failed（可能是语法错误）不构成可辨识权限拒绝。
            ...(item?.['status'] === 'declined'
              ? { resultRef: 'status:declined' }
              : item?.['status'] === 'failed'
                ? { resultRef: `status:failed;exit:${String(item?.['exitCode'] ?? '?')}${sandboxDenialSignature(item) ? ';sandbox-denial' : ''}` }
                : {}),
          }, internalTurnId);
        }
        break;
      }
      case 'item/started': {
        const item = p['item'] as ToolLikeItem | undefined;
        const type = item?.['type'];
        if (type === 'commandExecution' || type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall') {
          const toolCallId=String(item?.['id'] ?? randomUUID());
          const activity=codexToolActivity(item,session.ref.cwd);
          if(activity==null)break;
          session.toolSummaries.set(toolActivityKey(internalTurnId??providerTurnId,toolCallId),activity.summary);
          this.emit(session, {
            kind: 'tool.started',
            toolCallId,
            toolName: activity.toolName,
            action: activity.summary.action,
            target: activity.summary.target,
            argumentsSummary: activity.summary.argumentsSummary,
            ...(activity.paths != null && activity.paths.length > 0 ? { paths: activity.paths } : {}),
          }, internalTurnId);
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = p['tokenUsage'] as { total?: Record<string, number> } | undefined;
        const total = usage?.total;
        this.emit(session, {
          kind: 'usage.updated',
          accounting: 'cumulative',
          inputTokens: total?.['inputTokens'],
          cachedTokens: total?.['cachedInputTokens'],
          outputTokens: total?.['outputTokens'],
          costQuality: 'unknown',
        }, internalTurnId);
        break;
      }
      case 'turn/completed': {
        // 按真实终态映射；provider ID 只在 turn.id（TurnCompletedNotification 无顶层 turnId）。
        const turn = p['turn'] as { id?: string; status?: string; error?: { kind?: string; message?: string }; items?: Array<Record<string, unknown>> } | undefined;
        const status = turn?.status;
        this.retireTurn(session, providerTurnId);
        const exactlyMappedInternalTurnId = internalTurnId;
        if (status === 'failed' || status === 'interrupted') {
          this.emit(session, {
            kind: 'turn.failed',
            code: status === 'interrupted' ? 'INTERRUPTED' : String(turn?.error?.['kind'] ?? 'CODEX_ERROR'),
            message: status === 'interrupted'
              ? 'turn 被 interrupt（codex turn.status=interrupted）'
              : String(turn?.error?.['message'] ?? 'codex turn 失败'),
            retryable: false,
            ...(status==='failed'&&exactlyMappedInternalTurnId!=null&&providerTurnId!=null?{failureEvidence:{source:'provider-terminal' as const,providerTurnId}}:{}),
            ...(status === 'interrupted' && exactlyMappedInternalTurnId != null && providerTurnId != null
              ? { terminalEvidence: { source: 'provider-turn-completed' as const, status: 'interrupted' as const, providerTurnId } }
              : {}),
          }, internalTurnId);
          break;
        }
        if (status !== 'completed' || turn?.error != null) {
          this.emit(session, { kind: 'turn.failed', code: 'CODEX_INVALID_TERMINAL_STATUS', message: '执行连接没有返回明确的成功或失败终态', retryable: false }, internalTurnId);
          break;
        }
        const finalText = (turn?.items ?? [])
          .filter((i) => i['type'] === 'agentMessage')
          .map((i) => String(i['text'] ?? ''))
          .join('\n');
        this.emit(session, { kind: 'turn.completed', finalText }, internalTurnId);
        break;
      }
      case 'error': {
        const err = p['error'] as { message?: string; kind?: string } | undefined;
        const willRetry = p['willRetry'] === true;
        if (!willRetry) {
          this.retireTurn(session, providerTurnId);
          const awaiting = session.startingTurns.get(internalTurnId);
          if (awaiting != null) this.rejectStartRequest(awaiting, '执行连接在启动响应前报告本轮失败');
          this.emit(session, {
            kind: 'turn.failed',
            code: String(err?.['kind'] ?? 'CODEX_ERROR'),
            message: String(err?.['message'] ?? 'codex 通知错误'),
            retryable: false,
          }, internalTurnId);
        }
        break;
      }
      default:
        break;
    }
  }

  /** 固定原因码；不记录通知正文、工具参数、错误文本或原始身份。 */
  private ignoredNotification(reason: 'missing-identity' | 'conflicting-turn' | 'unknown-or-ambiguous'): void {
    process.stderr.write(`[codex-appserver] ignored notification: ${reason}\n`);
  }

  /** turn 映射（修复轮）：awaiting 未绑定则认领；未知 provider turn 不猜归属。 */
  private registerTurnMapping(session: SessionState, providerTurnId: string): void {
    if (session.providerTurnToInternal.has(providerTurnId)) return;
    const awaiting = session.awaitingTurn;
    if (awaiting != null && awaiting.providerTurnId == null && this.providerIdentity(session, providerTurnId) == null) {
      awaiting.providerTurnId = providerTurnId;
      this.bindProviderTurn(session, awaiting.internalTurnId, providerTurnId);
    }
  }

  private rejectStartRequest(attempt: TurnStartState, message: string): void {
    const pending = !attempt.accepted && attempt.requestId != null ? this.pending.get(attempt.requestId) : undefined;
    if (pending == null || attempt.requestId == null) return;
    clearTimeout(pending.timer);
    this.pending.delete(attempt.requestId);
    pending.reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', message));
  }

  private providerIdentity(session: SessionState, providerTurnId: string): ProviderTurnIdentity | undefined {
    return this.providerTurns.get(JSON.stringify([session.processGeneration, session.providerThreadId, providerTurnId]));
  }

  private bindProviderTurn(session: SessionState, internalTurnId: string, providerTurnId: string): void {
    this.providerTurns.set(JSON.stringify([session.processGeneration, session.providerThreadId, providerTurnId]), { processGeneration: session.processGeneration, sessionId: session.ref.id, internalTurnId, retired: false });
    session.providerTurnToInternal.set(providerTurnId, internalTurnId);
  }

  private retireTurn(session: SessionState, providerTurnId: string): void {
    const identity = this.providerIdentity(session, providerTurnId);
    if (identity?.sessionId !== session.ref.id) return;
    identity.retired = true;
    this.invalidateApprovals(session, identity.internalTurnId);
  }

  private invalidateApprovals(session: SessionState, internalTurnId?: string): void {
    for (const [id, approval] of this.serverRequests) {
      if (approval.sessionId !== session.ref.id || (internalTurnId != null && approval.internalTurnId !== internalTurnId)) continue;
      this.serverRequests.delete(id);
      if (session.awaitingTurn != null) session.awaitingTurn.buffered = session.awaitingTurn.buffered.filter(event => event.spec.kind !== 'approval.requested' || event.spec.approvalId !== id);
    }
  }

  private emit(session: SessionState, spec: EventSpec, turnId?: string): void {
    const awaiting = turnId != null ? session.startingTurns.get(turnId) : undefined;
    // Approvals can be required before the provider sends its start response.
    // They already have an exact unique early binding and remain revocable.
    if (spec.kind !== 'approval.requested' && awaiting != null && awaiting.internalTurnId === turnId && !awaiting.accepted) {
      awaiting.buffered.push({ spec, turnId });
      return;
    }
    session.stream.push(this.event(session, spec, turnId));
  }

  private internalTurnOf(session: SessionState, providerTurnId: string | undefined): string | undefined {
    if (providerTurnId != null) {
      return session.providerTurnToInternal.get(providerTurnId); // 未知=迟到：返回 undefined
    }
    const active = new Set([...session.providerTurnToInternal].filter(([id]) => !this.providerIdentity(session, id)?.retired).map(([, id]) => id));
    if (session.awaitingTurn?.providerTurnId === null) active.add(session.awaitingTurn.internalTurnId);
    return active.size === 1 ? [...active][0] : undefined;
  }

  private sessionByThread(threadId: string, providerTurnId?: string, allowAwaiting = false): SessionState | undefined {
    const candidates = [...this.sessions.values()].filter(s => s.processGeneration === this.childGeneration && s.providerThreadId === threadId);
    // resume 创建新的本地 session，但 provider thread 不变。已知旧轮仍送回旧流；
    // 新轮通知可能先于 start 响应，此时只认领唯一待绑定的启动者。
    if (providerTurnId != null) {
      const mapped = candidates.filter(s => s.providerTurnToInternal.has(providerTurnId));
      if (mapped.length > 0) return mapped.length === 1 ? mapped[0] : undefined;
      if (allowAwaiting) {
        // Completed or closed identities must never claim a later start.
        if (this.providerTurns.has(JSON.stringify([this.childGeneration, threadId, providerTurnId]))) return undefined;
        const awaiting = candidates.filter(s => s.awaitingTurn?.providerTurnId === null);
        if (awaiting.length === 1) return awaiting[0];
      }
      return undefined;
    }
    // Legacy approvals have no turn ID; only a single active round is safe.
    const active = candidates.flatMap(session => {
      const internalIds = new Set([...session.providerTurnToInternal].filter(([id]) => !this.providerIdentity(session, id)?.retired).map(([, id]) => id));
      if (session.awaitingTurn?.providerTurnId === null) internalIds.add(session.awaitingTurn.internalTurnId);
      return [...internalIds].map(internalTurnId => ({ session, internalTurnId }));
    });
    return active.length === 1 ? active[0]!.session : undefined;
  }

  private event(session: SessionState, spec: DistOmit<NormalizedRuntimeEvent, 'eventKey' | 'sessionId' | 'receivedAt'>, turnId?: string): NormalizedRuntimeEvent {
    session.seq += 1;
    const stage=turnId!=null?session.turnStages.get(turnId):undefined;
    return {
      ...spec,
      eventKey: `${session.ref.id}:${session.seq}`,
      sessionId: session.ref.id,
      ...(turnId != null ? { turnId } : {}),
      memberId: session.memberId,
      ...(stage!=null&&stage.length>0?{stage}:{}),
      receivedAt: Date.now(),
    } as NormalizedRuntimeEvent;
  }

  // ---------- RuntimeAdapter ----------

  async probe(): Promise<ProbeResult> {
    if (this.codexVersion == null) {
      const entry=this.invocation();
      this.executable=entry.identityPath;
      this.codexVersion = await this.readVersion(entry);
    }
    return { executable: this.executable ?? '(npm shim)', version: this.codexVersion!, capabilities: this.capabilities() };
  }

  /** Metadata only: no thread/start or turn/start, therefore no model inference. */
  async listModels():Promise<Array<{id:string;model:string;displayName?:string;defaultReasoningEffort?:string;supportedReasoningEfforts?:Array<{reasoningEffort:string;description?:string}>;inputModalities?:string[]}>> {
    this.ensureProcess();
    if(!this.handshakeDone){await this.request('initialize',{clientInfo:{name:'zhongshuo',version:ADAPTER_VERSION}});this.writeLine(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));this.handshakeDone=true;}
    const items:Array<{id:string;model:string;displayName?:string;defaultReasoningEffort?:string;supportedReasoningEfforts?:Array<{reasoningEffort:string;description?:string}>;inputModalities?:string[]}>=[];
    let cursor:string|undefined;
    for(let page=0;page<5;page++){const result=await this.request<{data:typeof items;nextCursor?:string|null}>('model/list',{limit:100,...(cursor?{cursor}:{})});items.push(...result.data);if(!result.nextCursor)return items;cursor=result.nextCursor;}
    throw new AdapterCallError('CAPABILITY_UNSUPPORTED','模型列表超出有界读取窗口，不能确认完整选项');
  }

  private readVersion(entry: CodexInvocation): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(entry.command, [...entry.args, '--version'], { windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (out += c));
      child.on('close', () => resolve(out.trim()));
      child.on('error', (e) => reject(new AdapterCallError('RUNTIME_NOT_FOUND', `codex --version 失败：${e.message}`)));
    });
  }

  private capabilities(): RuntimeCapabilities {
    // 口径（修复轮）：协议字段存在、方法实现、真实行为通过是三个状态。
    // 真实进程已观察到的仅：通知流解析与映射（structuredEvents）。
    return {
      structuredEvents: 'supported',
      taskContextIsolation: 'unverified',
      resumeSession: 'unverified', // thread/resume 已接线；有效续接待 PP-02 真实验证
      steerActiveTurn: 'unverified', // turn/steer 已接线；expectedTurnId 行为待 PP-12
      interrupt: 'unverified', // turn/interrupt 已接线；真实停止待认证
      interactiveApprovals: 'unverified',
      structuredFinal: 'unverified', // outputSchema 待 DEV-21 实测
      restrictWrites: 'unverified', // read-only 沙箱待 RT-23
      restrictShell: 'unverified',
      disableDelegation: 'unverified',
      usageTokens: 'unverified', // tokenUsage 通知映射已实现；真实数值口径待观察
      usageCost: 'unsupported',
    };
  }

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    if(this.options.effort){const models=await this.listModels();const model=models.find(m=>m.model===this.options.model||m.id===this.options.model);if(!model?.supportedReasoningEfforts?.some(e=>e.reasoningEffort===this.options.effort))throw new AdapterCallError('CAPABILITY_UNSUPPORTED','当前 model/list 未声明所选思考等级；请重新配置');}
    if(input.writeAccess?.fullAccess && this.options.sandboxMode!=='danger-full-access') throw new AdapterCallError('CAPABILITY_UNSUPPORTED','完整权限与成员配置不匹配');
    if(!input.writeAccess?.fullAccess && input.writeAccess?.modificationAuthorized && (this.options.sandboxMode!=='workspace-write' || input.writeAccess.allowedWriteRoots.length!==1 || input.writeAccess.allowedWriteRoots[0]!==input.cwd)) throw new AdapterCallError('CAPABILITY_UNSUPPORTED','项目写入范围与成员权限不匹配');
    this.ensureProcess();
    if (!this.handshakeDone) {
      await this.request('initialize', {
        clientInfo: { name: 'zhongshuo', title: '众说', version: ADAPTER_VERSION },
      });
      // 官方握手要求：initialize 响应后发送 initialized 通知（修复轮）。
      this.writeLine(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
      this.handshakeDone = true;
    }
    const developerInstructions=[input.developerInstructions,CODEX_STRUCTURED_FINAL_INSTRUCTION]
      .filter((value):value is string=>value!=null&&value.length>0)
      .join('\n\n');
    const threadParams: Record<string, unknown> = {
      cwd: input.cwd,
      sandbox: input.writeAccess?.fullAccess ? 'danger-full-access' : input.writeAccess?.modificationAuthorized ? 'workspace-write' : 'read-only',
      approvalPolicy: this.options.approvalPolicy ?? 'never',
    };
    if (this.options.model != null && this.options.model.length > 0) threadParams['model'] = this.options.model;
    if (developerInstructions.length > 0) threadParams['developerInstructions'] = developerInstructions;
    const method = input.resume != null ? 'thread/resume' : 'thread/start';
    if (input.resume != null) threadParams['threadId'] = input.resume.providerSessionId;
    const result = await this.request<{ thread: { id: string } }>(method, threadParams);
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
      processGeneration: this.childGeneration,
      memberId: input.memberId,
      writeAccess: input.writeAccess,
      ref,
      stream: new EventStream(),
      providerThreadId,
      providerTurnToInternal: new Map(),
      awaitingTurn: null,
      startingTurns: new Map(),
      turnStages: new Map(),
      toolSummaries: new Map(),
      seq: 0,
    };
    this.sessions.set(ref.id, state);
    state.stream.push(this.event(state, { kind: 'session.ready', providerSessionId: providerThreadId }));
    return ref;
  }

  async startTurn(session: SessionRef, input: TurnRequest): Promise<void> {
    if(input.images?.length&&input.imageConfigurationKey&&input.imageConfigurationKey!==codexConfigurationIdentity(session.cwd))throw new AdapterCallError('CAPABILITY_UNSUPPORTED','图片执行配置已变化；未发送，原件保留',true);
    if(input.images?.length){let models:Awaited<ReturnType<CodexAppServerAdapter['listModels']>>;try{models=await this.listModels();}catch(e){throw new AdapterCallError('CAPABILITY_UNSUPPORTED',`图片模型信息读取失败；没有发送模型输入：${e instanceof Error?e.message:'元数据不可读'}`,true);}const model=models.find(m=>m.model===this.options.model||m.id===this.options.model);if(model?.inputModalities&&!model.inputModalities.includes('image'))throw new AdapterCallError('CAPABILITY_UNSUPPORTED','当前模型明确不支持图片；原件保留，可仅记录或换成员',true);}
    const providerInput = codexInput(input);
    const state = this.stateOf(session);
    this.assertLiveSession(state);
    if (state.startingTurns.has(input.turnId) || [...state.providerTurnToInternal.values()].includes(input.turnId)) {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', '本轮执行身份已经使用；本次未重复发送', true);
    }
    if ([...this.sessions.values()].some(s => s.processGeneration === state.processGeneration && s.providerThreadId === state.providerThreadId && [...s.startingTurns.values()].some(turn => turn.providerTurnId === null))) {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', '同一 Codex thread 的上一启动请求尚未绑定 turn；本次未发送', true);
    }
    if(input.stage!=null&&input.stage.trim().length>0)
      state.turnStages.set(input.turnId,input.stage.trim().slice(0,120));
    // 先登记 awaiting（通知可能早于响应到达，修复轮）。
    const attempt: TurnStartState = { internalTurnId: input.turnId, providerTurnId: null, accepted: false, buffered: [] };
    state.awaitingTurn = attempt;
    state.startingTurns.set(input.turnId, attempt);
    try {
      await this.request<{ turn: { id: string } }>(
      'turn/start',
      {
        threadId: state.providerThreadId,
        input: providerInput,
        clientUserMessageId: input.dispatchKey,
        sandboxPolicy:input.repairOnly===true ? {type:'readOnly',networkAccess:false} : state.writeAccess?.fullAccess ? {type:'dangerFullAccess'} : state.writeAccess?.modificationAuthorized ? {type:'workspaceWrite',writableRoots:state.writeAccess.allowedWriteRoots,networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true} : {type:'readOnly',networkAccess:false},
        approvalPolicy:'never',
        ...(this.options.effort?{effort:this.options.effort}:{}),
        ...(input.outputSchema?{outputSchema:input.outputSchema}:{}),
      },
      (r) => {
        // 响应解析同步点：立即固化映射（同 chunk 的通知随后处理时即可命中）。
        const providerTurnId = (r as { turn?: { id?: unknown } })?.turn?.id;
        if (this.sessions.get(session.id) !== state || state.processGeneration !== this.childGeneration) {
          throw new AdapterCallError('RESOURCE_NOT_FOUND', '启动响应所属会话已经结束');
        }
        if (typeof providerTurnId !== 'string' || providerTurnId.length === 0 || (attempt.providerTurnId != null && attempt.providerTurnId !== providerTurnId)) {
          throw new AdapterCallError('CAPABILITY_UNSUPPORTED', '执行连接返回的启动身份与本轮通知不一致；结果待核实');
        }
        const identity = this.providerIdentity(state, providerTurnId);
        if (identity != null && (identity.sessionId !== state.ref.id || identity.internalTurnId !== input.turnId || attempt.providerTurnId !== providerTurnId)) {
          throw new AdapterCallError('CAPABILITY_UNSUPPORTED', '执行连接复用了另一轮的身份；结果待核实');
        }
        if (identity == null) this.bindProviderTurn(state, input.turnId, providerTurnId);
        attempt.providerTurnId = providerTurnId;
        attempt.accepted = true;
        for (const event of attempt.buffered.splice(0)) this.emit(state, event.spec, event.turnId);
        state.startingTurns.delete(input.turnId);
      },
      id => { attempt.requestId = id; },
    );
    } catch (error) {
      attempt.buffered.length = 0;
      if (attempt.providerTurnId != null) this.retireTurn(state, attempt.providerTurnId);
      this.invalidateApprovals(state, input.turnId);
      state.startingTurns.delete(input.turnId);
      if (state.awaitingTurn === attempt) state.awaitingTurn = null;
      throw error;
    }
  }

  events(session: SessionRef): AsyncIterable<NormalizedRuntimeEvent> {
    return this.stateOf(session).stream.iterate();
  }

  async steer(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
    this.assertLiveSession(state);
    const providerTurnId = [...state.providerTurnToInternal.entries()]
      .find(([, internal]) => internal === input.turnId)?.[0];
    if (providerTurnId == null) {
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'steer 需要 expectedTurnId：目标 turn 尚未登记 provider ID');
    }
    await this.request('turn/steer', {
      threadId: state.providerThreadId,
      expectedTurnId: providerTurnId,
      input: codexInput(input),
    });
  }

  async interrupt(session: SessionRef, turnId: string): Promise<void> {
    const state = this.stateOf(session);
    this.assertLiveSession(state);
    const providerTurnId = [...state.providerTurnToInternal.entries()]
      .find(([, internal]) => internal === turnId)?.[0];
    if (providerTurnId == null) return;
    await this.request('turn/interrupt', { threadId: state.providerThreadId, turnId: providerTurnId });
  }

  async respondApproval(session: SessionRef, approvalId: string, choice: 'allow_once' | 'deny'): Promise<void> {
    const state = this.stateOf(session);
    const pendingRequest = this.serverRequests.get(approvalId);
    if (pendingRequest == null) {
      throw new AdapterCallError('RESOURCE_NOT_FOUND', `没有待答复的审批请求：${approvalId}`);
    }
    // 审批归属校验（修复轮）：只能答复自己会话的请求。
    if (pendingRequest.sessionId !== session.id) {
      throw new AdapterCallError('THREAD_SCOPE_MISMATCH', `审批 ${approvalId} 不属于该会话`);
    }
    const providerTurnId = pendingRequest.providerTurnId ?? [...state.providerTurnToInternal].find(([, internal]) => internal === pendingRequest.internalTurnId)?.[0];
    const identity = providerTurnId != null ? this.providerIdentity(state, providerTurnId) : undefined;
    if (pendingRequest.processGeneration !== this.childGeneration || state.processGeneration !== this.childGeneration
      || identity?.retired === true || (providerTurnId != null && (identity?.sessionId !== session.id || identity.internalTurnId !== pendingRequest.internalTurnId))
      || (providerTurnId == null && state.awaitingTurn?.internalTurnId !== pendingRequest.internalTurnId)) {
      this.serverRequests.delete(approvalId);
      throw new AdapterCallError('RESOURCE_NOT_FOUND', '执行确认所属轮次或连接已经结束');
    }
    this.serverRequests.delete(approvalId);
    await this.respondToServer(pendingRequest.rpcId, this.approvalResult(pendingRequest.legacy, choice), pendingRequest.processGeneration);
  }

  async close(session: SessionRef): Promise<void> {
    const state = this.stateOf(session);
    this.invalidateApprovals(state);
    for (const id of state.providerTurnToInternal.keys()) this.retireTurn(state, id);
    for (const attempt of state.startingTurns.values()) {
      if (attempt.requestId == null) continue;
      const pending = this.pending.get(attempt.requestId);
      if (pending == null || pending.processGeneration !== state.processGeneration) continue;
      clearTimeout(pending.timer);
      this.pending.delete(attempt.requestId);
      pending.reject(new AdapterCallError('RESOURCE_NOT_FOUND', '启动所属会话已关闭；结果待核实'));
    }
    state.awaitingTurn = null;
    state.startingTurns.clear();
    this.sessions.delete(session.id);
    if (this.sessions.size === 0 && this.child != null) {
      const child = this.child;
      if(!this.options.requireConfirmedClose)this.child = null;
      const confirmed=await this.killAndWait(child);
      if(!confirmed&&this.options.requireConfirmedClose)throw Error('Codex 配置准备进程尚未确认关闭；未提交，输入保留');
      if(this.child===child)this.child=null;
    }
  }

  /** 常驻 App Server 子进程（多 turn 共享）——PID 不专属单一 turn（DEV-13 取证如实标注）。 */
  processIdentity(session: SessionRef, turnId: string): AdapterProcessIdentity | null {
    void session; void turnId;
    // 受管桥进程对象携带稳定身份 managedJobId（结构化可选属性；未受管进程无此字段）。
    return { model: 'shared', pid: this.child?.pid ?? null, managedJobId: (this.child as { managedJobId?: string } | null)?.managedJobId ?? null };
  }

  async dispose(): Promise<void> {
    this.serverRequests.clear();
    this.sessions.clear();
    if (this.child != null) {
      const child = this.child;
      if(!this.options.requireConfirmedClose)this.child = null;
      const confirmed=await this.killAndWait(child);
      if(!confirmed&&this.options.requireConfirmedClose)throw Error('Codex 配置准备进程尚未确认关闭；未提交，输入保留');
      if(this.child===child)this.child=null;
    }
  }

  /** 终止并等待子进程退出（默认 5s 上限）：避免残留进程锁住 fixture 目录（EPERM）。 */
  private async killAndWait(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<boolean> {
    if(child.exitCode!=null||child.signalCode!=null)return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      child.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.kill();
    });
  }

  private stateOf(session: SessionRef): SessionState {
    const state = this.sessions.get(session.id);
    if (state == null) throw new AdapterCallError('RESOURCE_NOT_FOUND', `会话不存在：${session.id}`);
    return state;
  }

  private assertLiveSession(state: SessionState): void {
    if (state.processGeneration !== this.childGeneration || this.child == null || this.child.exitCode != null || this.child.signalCode != null) {
      throw new AdapterCallError('RESOURCE_NOT_FOUND', '执行会话所属连接已经结束；请重新打开会话', true);
    }
  }
}

function toolOutcome(status: unknown): 'success' | 'failure' | 'unknown' {
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'declined') return 'failure';
  return 'unknown';
}

/** 沙箱/权限拒绝签名：failed 的 aggregatedOutput 命中才算可辨识的权限拒绝原因。 */
function sandboxDenialSignature(item: ToolLikeItem | undefined): boolean {
  const output = String(item?.['aggregatedOutput'] ?? '');
  return /read-only|sandbox|not permitted|denied|permission|access is denied|只读|拒绝/i.test(output);
}

/** Full factual target extraction, with bounded/redacted projection for persistence. */
function codexToolActivity(item: ToolLikeItem | undefined,sessionCwd?:string): CodexToolActivity | null {
  const type=String(item?.['type']??'');
  if(type==='commandExecution'){
    const cwd=typeof item?.['cwd']==='string'?item['cwd']:sessionCwd;
    return {
      toolName:type,
      summary:runtimeToolSummary(type,{command:item?.['command'],cwd},{cwd}),
    };
  }
  if(type==='fileChange'){
    const rawChanges=item?.['changes'];
    const changes=Array.isArray(rawChanges)
      ?rawChanges.filter(isRecordValue).map(change=>({
        path:typeof change['path']==='string'?change['path']:'',
        kind:typeof change['kind']==='string'?change['kind']:'',
      }))
      :isRecordValue(rawChanges)
        ?Object.entries(rawChanges).map(([path,change])=>({
          path,
          kind:isRecordValue(change)
            ?typeof change['kind']==='string'?change['kind']
              :typeof change['type']==='string'?change['type']:''
            :'',
        }))
        :[];
    const presentChanges=changes.filter(change=>change.path.length>0);
    const projectPaths = [...new Set(presentChanges.flatMap(change => {
      const raw = change.path.replaceAll('\\', '/');
      if (sessionCwd == null || sessionCwd.trim().length === 0) return isAbsolute(raw) ? [] : [raw.replace(/^\.\//, '')];
      if (isAbsolute(change.path) && !isAbsolute(sessionCwd)) return [];
      const rel = relative(resolve(sessionCwd), resolve(sessionCwd, change.path)).replaceAll('\\', '/');
      return rel.length === 0 || rel === '..' || rel.startsWith('../') || isAbsolute(rel) ? [] : [rel.replace(/^\.\//, '')];
    }))];
    return {toolName:type,summary:runtimeToolSummary(type,{changes:presentChanges},{cwd:sessionCwd}),...(projectPaths.length>0?{paths:projectPaths}:{})};
  }
  if(type==='mcpToolCall'){
    const server=typeof item?.['server']==='string'?item['server']:'';
    const tool=typeof item?.['tool']==='string'?item['tool']:'mcpToolCall';
    const argumentsValue=toolArguments(item?.['arguments']);
    return {
      toolName:type,
      summary:runtimeToolSummary(`${server} ${tool}`,{...argumentsValue,server,tool},{cwd:sessionCwd}),
    };
  }
  if(type==='dynamicToolCall'){
    const namespace=typeof item?.['namespace']==='string'?item['namespace']:'';
    const tool=typeof item?.['tool']==='string'?item['tool']:'dynamicToolCall';
    const argumentsValue=toolArguments(item?.['arguments']);
    return {
      toolName:type,
      summary:runtimeToolSummary(`${namespace} ${tool}`,{...argumentsValue,namespace,tool},{cwd:sessionCwd}),
    };
  }
  return null;
}

function toolArguments(value:unknown):Record<string,unknown> {
  if(isRecordValue(value)){
    const nested=isRecordValue(value['arguments'])?value['arguments']:{};
    return {...nested,...value};
  }
  if(typeof value==='string')return {input:value};
  return {};
}

function toolFailureSummary(item:ToolLikeItem|undefined):string {
  const status=item?.['status'];
  if(status!=='failed'&&status!=='declined')return '';
  const detail=runtimeToolResultSummary(
    item?.['error']??item?.['aggregatedOutput']??item?.['stderr']??item?.['stdout'],
  );
  if(detail.length>0)return detail;
  if(status==='declined')return '工具调用被拒绝';
  const exitCode=item?.['exitCode'];
  return exitCode==null?'工具执行失败':`工具执行失败（exit ${String(exitCode)}）`;
}

function toolActivityKey(turnId:string|undefined,toolCallId:string):string {
  return `${turnId??''}:${toolCallId}`;
}

function isRecordValue(value:unknown):value is Record<string,unknown> {
  return typeof value==='object'&&value!=null&&!Array.isArray(value);
}
