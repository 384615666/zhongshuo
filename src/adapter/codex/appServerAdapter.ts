/**
 * Codex App Server 适配器（DEV-06 修复轮：终态映射/事件归属/生命周期/审批绑定/resume）。
 * 协议依据：codex-cli 0.157.1 `app-server generate-ts`（tests/fixtures/codex-protocol/）。
 *
 * 修复轮要点（外部只读审查后）：
 * - turn/completed 按 turn.status 映射：completed→turn.completed；interrupted→turn.failed
 *   {code:'INTERRUPTED'}；failed→turn.failed{code:error.kind,message}。工具 item 按
 *   status（completed/failed/declined）映射 outcome，不再一律 success。
 * - 事件归属：provider turnId↔内部 turnId 映射；startTurn 先登记 awaiting turn，
 *   通知早于响应也能建立映射；未知 provider turn 的事件按迟到处理（不带内部 turnId）。
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
import { join, dirname, delimiter } from 'node:path';
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
import { EventStream } from '../eventStream.ts';

const ADAPTER_VERSION = 'codex-appserver-adapter-0.2.0';
export const SUPPORTED_CODEX_VERSION_PREFIX = '0.157.';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

type DistOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

interface SessionState {
  writeAccess?: OpenSessionInput['writeAccess'];
  ref: SessionRef;
  stream: EventStream;
  providerThreadId: string;
  providerTurnToInternal: Map<string, string>;
  /** 本会话待认领 turn（按会话隔离：双会话并发 startTurn 不互扰，修复轮 3）。 */
  awaitingTurn: { internalTurnId: string; providerTurnId: string | null } | null;
  seq: number;
}

interface ToolLikeItem extends Record<string, unknown> {
  status?: unknown;
}

export interface CodexAdapterOptions {
  /** Project context for metadata discovery and the actual app-server process. */
  cwd?:string;
  /** Explicit member program reference; default names retain the existing npm shim lookup. */
  executable?: string;
  codexCmdPath?: string;
  requestTimeoutMs?: number;
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
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; onResult?: (v: unknown) => void }>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly serverRequests = new Map<string, { rpcId: number; sessionId: string }>();
  private buffer = '';
  private stderrTail = '';
  /** 每个进程连接的握手状态：连接重建即重置（修复轮）。 */
  private handshakeDone = false;
  private readonly options: Required<Pick<CodexAdapterOptions, 'requestTimeoutMs' | 'sandboxMode'>> & { cwd?:string; effort?:string; executable?:string; codexCmdPath?: string; model?: string; approvalPolicy?: CodexAdapterOptions['approvalPolicy']; mockEntry?: CodexAdapterOptions['mockEntry']; spawnFn?: CodexAdapterOptions['spawnFn'] };
  private codexVersion: string | null = null;
  private executable: string | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      executable:options.executable,
      cwd:options.cwd,
      codexCmdPath: options.codexCmdPath,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
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
    if (this.child != null && this.child.exitCode == null) return this.child;
    const entry = this.invocation();
    const generation = ++this.childGeneration;
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
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      process.stderr.write(`[codex-appserver] ${chunk}`);
    });
    child.on('close', (code) => {
      // 旧代次回调：只广播退出，不清理新代次的 child/pending（修复轮）。
      for (const session of [...this.sessions.values()]) {
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
      if (generation !== this.childGeneration) return;
      this.child = null;
      const tail = this.stderrTail.slice(-1600);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new AdapterCallError('RUNTIME_NOT_FOUND', `app-server 进程退出（code=${code}）stderr 尾部：${tail}`));
      }
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  private invocation():CodexInvocation {
    if(this.options.mockEntry!=null)return{command:process.execPath,args:[this.options.mockEntry.executable,...(this.options.mockEntry.args??[])],identityPath:this.options.mockEntry.executable};
    return resolveCodexInvocation(this.options.executable,this.options.codexCmdPath);
  }

  private request<T = unknown>(method: string, params?: unknown, onResult?: (v: unknown) => void): Promise<T> {
    this.ensureProcess();
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterCallError('RUNTIME_NOT_FOUND', `${method} 请求超时（${this.options.requestTimeoutMs}ms）`));
      }, this.options.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, onResult });
      this.writeLine(`${JSON.stringify(message)}`);
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
      const id = Number(message['id']);
      const entry = this.pending.get(id);
      if (entry == null) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (message['error'] != null) {
        const err = message['error'] as { message?: string; code?: number };
        entry.reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', `JSON-RPC 错误（${err.code ?? '?'}）：${err.message ?? '未知'}`));
      } else {
        // 同步点：映射注册先于同 chunk 后续通知的处理（await 微任务不参与顺序，修复轮 3）。
        if (entry.onResult != null) entry.onResult(message['result']);
        entry.resolve(message['result']);
      }
      return;
    }
    if (message['id'] != null && typeof message['method'] === 'string') {
      this.handleServerRequest(Number(message['id']), message['method'], message['params'] as Record<string, unknown> | undefined);
      return;
    }
    if (typeof message['method'] === 'string') {
      this.handleNotification(message['method'], message['params'] as Record<string, unknown> | undefined);
    }
  }

  // ---------- 审批：绑定准确会话/轮次，未知归属按协议 deny ----------

  private handleServerRequest(id: number, method: string, params: Record<string, unknown> | undefined): void {
    const p = params ?? {};
    // 归属解析：v2 带 threadId/turnId；legacy 带 conversationId（ThreadId）。
    const threadKey = typeof p['threadId'] === 'string' ? p['threadId'] : typeof p['conversationId'] === 'string' ? p['conversationId'] : null;
    const session = threadKey != null ? this.sessionByThread(threadKey) : null;
    const payloadHash = createHash('sha256').update(JSON.stringify({ method, params })).digest('hex');
    if (session == null) {
      // 无法定位归属：按协议拒绝（不悬挂服务端请求，也不投递给错误会话）。
      void this.respondToServer(id, { decision: 'deny' });
      return;
    }
    const approvalId = `appr_${id}`;
    this.serverRequests.set(approvalId, { rpcId: id, sessionId: session.ref.id });
    session.stream.push(this.event(session, {
      kind: 'approval.requested',
      approvalId,
      request: { method, params, payloadHash },
      allowedChoices: ['allow_once', 'deny'],
    }, this.internalTurnOf(session, typeof p['turnId'] === 'string' ? p['turnId'] : undefined)));
  }

  private async respondToServer(id: number, result: unknown): Promise<void> {
    this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  // ---------- 通知映射（§9.4；按 provider turn 精确归属） ----------

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    const p = params ?? {};
    const threadKey = typeof p['threadId'] === 'string' ? p['threadId'] : null;
    const session = threadKey != null ? this.sessionByThread(threadKey) : [...this.sessions.values()][0];
    if (session == null) return;
    const providerTurnId = typeof p['turnId'] === 'string' ? p['turnId'] : undefined;

    switch (method) {
      case 'turn/started': {
        // 真实协议：TurnStartedNotification = { threadId, turn }——provider ID 只在 turn.id。
        const providerId = (p['turn'] as { id?: string } | undefined)?.['id'];
        if (providerId != null) this.registerTurnMapping(session, providerId);
        session.stream.push(this.event(session, { kind: 'turn.started', providerTurnId: providerId }, this.internalTurnOf(session, providerId)));
        break;
      }
      case 'item/agentMessage/delta': {
        session.stream.push(this.event(session, {
          kind: 'message.delta',
          messageId: String(p['itemId'] ?? randomUUID()),
          text: String(p['delta'] ?? ''),
        }, this.internalTurnOf(session, providerTurnId)));
        break;
      }
      case 'item/completed': {
        const item = p['item'] as ToolLikeItem | undefined;
        const type = item?.['type'];
        if (type === 'agentMessage') {
          session.stream.push(this.event(session, {
            kind: 'message.completed',
            messageId: String(item?.['id'] ?? randomUUID()),
            text: String(item?.['text'] ?? ''),
          }, this.internalTurnOf(session, providerTurnId)));
        } else if (type === 'commandExecution' || type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall') {
          session.stream.push(this.event(session, {
            kind: 'tool.completed',
            toolCallId: String(item?.['id'] ?? randomUUID()),
            outcome: toolOutcome(item?.['status']),
            // 拒绝原因留痕（B6 证据绑定，修复轮 4）：declined=权限拒绝；
            // failed 附 exitCode，且 aggregatedOutput 命中沙箱/权限拒绝签名时标记
            // sandbox-denial——纯 failed（可能是语法错误）不构成可辨识权限拒绝。
            ...(item?.['status'] === 'declined'
              ? { resultRef: 'status:declined' }
              : item?.['status'] === 'failed'
                ? { resultRef: `status:failed;exit:${String(item?.['exitCode'] ?? '?')}${sandboxDenialSignature(item) ? ';sandbox-denial' : ''}` }
                : {}),
          }, this.internalTurnOf(session, providerTurnId)));
        }
        break;
      }
      case 'item/started': {
        const item = p['item'] as ToolLikeItem | undefined;
        const type = item?.['type'];
        if (type === 'commandExecution' || type === 'fileChange' || type === 'mcpToolCall' || type === 'dynamicToolCall') {
          session.stream.push(this.event(session, {
            kind: 'tool.started',
            toolCallId: String(item?.['id'] ?? randomUUID()),
            toolName: String(type),
            // 目标路径留痕（B6 证据绑定）：fileChange 取 changes[].path；命令取 command。
            argumentsSummary: toolTargets(item).slice(0, 200),
          }, this.internalTurnOf(session, providerTurnId)));
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = p['tokenUsage'] as { total?: Record<string, number> } | undefined;
        const total = usage?.total;
        session.stream.push(this.event(session, {
          kind: 'usage.updated',
          accounting: 'cumulative',
          inputTokens: total?.['inputTokens'],
          cachedTokens: total?.['cachedInputTokens'],
          outputTokens: total?.['outputTokens'],
          costQuality: 'unknown',
        }, this.internalTurnOf(session, providerTurnId)));
        break;
      }
      case 'turn/completed': {
        // 按真实终态映射；provider ID 只在 turn.id（TurnCompletedNotification 无顶层 turnId）。
        const turn = p['turn'] as { id?: string; status?: string; error?: { kind?: string; message?: string }; items?: Array<Record<string, unknown>> } | undefined;
        const status = turn?.status ?? 'completed';
        const internalTurnId = this.internalTurnOf(session, turn?.['id']);
        if (status === 'failed' || status === 'interrupted') {
          session.stream.push(this.event(session, {
            kind: 'turn.failed',
            code: status === 'interrupted' ? 'INTERRUPTED' : String(turn?.error?.['kind'] ?? 'CODEX_ERROR'),
            message: status === 'interrupted'
              ? 'turn 被 interrupt（codex turn.status=interrupted）'
              : String(turn?.error?.['message'] ?? 'codex turn 失败'),
            retryable: false,
          }, internalTurnId));
          break;
        }
        const finalText = (turn?.items ?? [])
          .filter((i) => i['type'] === 'agentMessage')
          .map((i) => String(i['text'] ?? ''))
          .join('\n');
        session.stream.push(this.event(session, { kind: 'turn.completed', finalText }, internalTurnId));
        break;
      }
      case 'error': {
        const err = p['error'] as { message?: string; kind?: string } | undefined;
        const willRetry = p['willRetry'] === true;
        if (!willRetry) {
          session.stream.push(this.event(session, {
            kind: 'turn.failed',
            code: String(err?.['kind'] ?? 'CODEX_ERROR'),
            message: String(err?.['message'] ?? 'codex 通知错误'),
            retryable: false,
          }, this.internalTurnOf(session, providerTurnId)));
        }
        break;
      }
      default:
        break;
    }
  }

  /** turn 映射（修复轮）：awaiting 未绑定则认领；未知 provider turn 不猜归属。 */
  private registerTurnMapping(session: SessionState, providerTurnId: string): void {
    if (session.providerTurnToInternal.has(providerTurnId)) return;
    if (session.awaitingTurn != null && session.awaitingTurn.providerTurnId == null) {
      session.awaitingTurn.providerTurnId = providerTurnId;
      session.providerTurnToInternal.set(providerTurnId, session.awaitingTurn.internalTurnId);
    }
  }

  private internalTurnOf(session: SessionState, providerTurnId: string | undefined): string | undefined {
    if (providerTurnId != null) {
      return session.providerTurnToInternal.get(providerTurnId); // 未知=迟到：返回 undefined
    }
    return session.awaitingTurn?.providerTurnId == null ? session.awaitingTurn?.internalTurnId : undefined;
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
    const threadParams: Record<string, unknown> = {
      cwd: input.cwd,
      sandbox: input.writeAccess?.fullAccess ? 'danger-full-access' : input.writeAccess?.modificationAuthorized ? 'workspace-write' : 'read-only',
      approvalPolicy: this.options.approvalPolicy ?? 'never',
    };
    if (this.options.model != null && this.options.model.length > 0) threadParams['model'] = this.options.model;
    if (input.developerInstructions != null) threadParams['developerInstructions'] = input.developerInstructions;
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
      writeAccess: input.writeAccess,
      ref,
      stream: new EventStream(),
      providerThreadId,
      providerTurnToInternal: new Map(),
      awaitingTurn: null,
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
    // 先登记 awaiting（通知可能早于响应到达，修复轮）。
    state.awaitingTurn = { internalTurnId: input.turnId, providerTurnId: null };
    const result = await this.request<{ turn: { id: string } }>(
      'turn/start',
      {
        threadId: state.providerThreadId,
        input: providerInput,
        clientUserMessageId: input.dispatchKey,
        sandboxPolicy:state.writeAccess?.fullAccess ? {type:'dangerFullAccess'} : state.writeAccess?.modificationAuthorized ? {type:'workspaceWrite',writableRoots:state.writeAccess.allowedWriteRoots,networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true} : {type:'readOnly',networkAccess:false},
        approvalPolicy:'never',
        ...(this.options.effort?{effort:this.options.effort}:{}),
        ...(input.outputSchema?{outputSchema:input.outputSchema}:{}),
      },
      (r) => {
        // 响应解析同步点：立即固化映射（同 chunk 的通知随后处理时即可命中）。
        const providerTurnId = (r as { turn?: { id?: string } })?.turn?.id;
        if (providerTurnId != null) {
          state.providerTurnToInternal.set(providerTurnId, input.turnId);
          if (state.awaitingTurn?.internalTurnId === input.turnId && state.awaitingTurn.providerTurnId == null) {
            state.awaitingTurn.providerTurnId = providerTurnId;
          }
        }
      },
    );
    void result;
  }

  events(session: SessionRef): AsyncIterable<NormalizedRuntimeEvent> {
    return this.stateOf(session).stream.iterate();
  }

  async steer(session: SessionRef, input: TurnRequest): Promise<void> {
    const state = this.stateOf(session);
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
    const providerTurnId = [...state.providerTurnToInternal.entries()]
      .find(([, internal]) => internal === turnId)?.[0];
    if (providerTurnId == null) return;
    await this.request('turn/interrupt', { threadId: state.providerThreadId, turnId: providerTurnId });
  }

  async respondApproval(session: SessionRef, approvalId: string, choice: 'allow_once' | 'deny'): Promise<void> {
    this.stateOf(session);
    const pendingRequest = this.serverRequests.get(approvalId);
    if (pendingRequest == null) {
      throw new AdapterCallError('RESOURCE_NOT_FOUND', `没有待答复的审批请求：${approvalId}`);
    }
    // 审批归属校验（修复轮）：只能答复自己会话的请求。
    if (pendingRequest.sessionId !== session.id) {
      throw new AdapterCallError('THREAD_SCOPE_MISMATCH', `审批 ${approvalId} 不属于该会话`);
    }
    this.serverRequests.delete(approvalId);
    await this.respondToServer(pendingRequest.rpcId, { decision: choice === 'allow_once' ? 'accept' : 'deny' });
  }

  async close(session: SessionRef): Promise<void> {
    this.stateOf(session);
    this.sessions.delete(session.id);
    if (this.sessions.size === 0 && this.child != null) {
      const child = this.child;
      this.child = null;
      await this.killAndWait(child);
    }
  }

  /** 常驻 App Server 子进程（多 turn 共享）——PID 不专属单一 turn（DEV-13 取证如实标注）。 */
  processIdentity(session: SessionRef, turnId: string): AdapterProcessIdentity | null {
    void session; void turnId;
    // 受管桥进程对象携带稳定身份 managedJobId（结构化可选属性；未受管进程无此字段）。
    return { model: 'shared', pid: this.child?.pid ?? null, managedJobId: (this.child as { managedJobId?: string } | null)?.managedJobId ?? null };
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    if (this.child != null) {
      const child = this.child;
      this.child = null;
      await this.killAndWait(child);
    }
  }

  /** 终止并等待子进程退出（默认 5s 上限）：避免残留进程锁住 fixture 目录（EPERM）。 */
  private async killAndWait(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      timer.unref?.();
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  private stateOf(session: SessionRef): SessionState {
    const state = this.sessions.get(session.id);
    if (state == null) throw new AdapterCallError('RESOURCE_NOT_FOUND', `会话不存在：${session.id}`);
    return state;
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

/** 工具目标摘要：fileChange 用 changes[].path；commandExecution 用 command；其余用工具名。 */
function toolTargets(item: ToolLikeItem | undefined): string {
  const type = String(item?.['type'] ?? '');
  if (type === 'fileChange') {
    const changes = (item?.['changes'] as Array<{ path?: string }> | undefined) ?? [];
    return changes.map((c) => String(c['path'] ?? '')).join(', ');
  }
  if (type === 'commandExecution') return String(item?.['command'] ?? '');
  return type;
}
