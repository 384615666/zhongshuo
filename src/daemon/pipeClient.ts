/**
 * 命名管道客户端（UI/renderer 用；修复轮 5 重写请求-响应关联）。
 *
 * 协议：首帧握手 {"type":"auth","token":"..."}（服务端校验后才接受命令）；
 * 之后每行一个 CommandEnvelope，按序返回一行 CommandResult。
 *
 * 修复要点（外部复核）：
 * - 每个 send 关联自己的 resolver，按到达顺序配对（不重复 shift 丢失等待者）；
 * - 超时（默认 15s）只失败本请求，不污染连接；
 * - 断连/错误/坏 JSON：所有未决请求明确 reject，不留下永远 pending 的 Promise；
 * - 响应解析失败不中断后续响应（失败本请求并跳过该行）。
 */
import { connect } from 'node:net';

export interface PipeClientOptions {
  /** 本地连接凭据（daemon 生成的 token）。 */
  token: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface PipeClient {
  send<T = unknown>(envelope: unknown): Promise<T>;
  close(): void;
  /** 连接是否已断开（断开后 send 会拒绝）。 */
  readonly closed: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function connectPipe(pipeName: string, options: PipeClientOptions): Promise<PipeClient> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = connect(pipeName);
    socket.setEncoding('utf8');
    let buffer = '';
    let closed = false;
    let connectTimer: NodeJS.Timeout | null = null;
    const pendingQueue: Pending[] = [];

    const failAll = (error: Error): void => {
      if (closed) return;
      closed = true;
      for (const p of pendingQueue.splice(0)) {
        clearTimeout(p.timer);
        p.reject(error);
      }
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'auth', token: options.token })}\n`);
    });

    // 握手确认（auth.ok）先于任何命令响应：验证通过才暴露 client；
    // 握手被拒（AUTH_REQUIRED）或连接断开则 connect 失败。
    let authenticated = false;
    const authenticate = (line: string): boolean => {
      if (authenticated) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        socket.destroy();
        rejectConnect(new Error(`握手响应不是合法 JSON：${line.slice(0, 80)}`));
        return true;
      }
      const auth = parsed as { type?: string; ok?: boolean; error?: { message?: string } };
      if (auth?.type === 'auth.ok') {
        authenticated = true;
        if (connectTimer != null) clearTimeout(connectTimer);
        resolveConnect({
          get closed() {
            return closed;
          },
          send<T = unknown>(envelope: unknown): Promise<T> {
            if (closed) return Promise.reject(new Error('管道连接已关闭'));
            return new Promise<T>((resolve, reject) => {
              const pending: Pending = { resolve: resolve as (v: unknown) => void, reject, timer: null as unknown as NodeJS.Timeout };
              pending.timer = setTimeout(() => {
                const index = pendingQueue.indexOf(pending);
                if (index >= 0) pendingQueue.splice(index, 1);
                reject(new Error(`请求超时（${requestTimeoutMs}ms）：${(envelope as { method?: string }).method ?? '?'}`));
              }, requestTimeoutMs);
              pending.timer.unref?.();
              pendingQueue.push(pending);
              socket.write(`${JSON.stringify(envelope)}\n`);
            });
          },
          close() {
            failAll(new Error('客户端主动关闭'));
            socket.destroy();
          },
        });
        return true;
      }
      socket.destroy();
      rejectConnect(new Error(`管道握手被拒：${auth?.error?.message ?? line.slice(0, 80)}`));
      return true;
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (line.length === 0) continue;
        // 握手阶段：auth.ok/AUTH_REQUIRED 由 authenticate 处理，不进入命令响应队列。
        if (!authenticated && authenticate(line)) continue;
        const pending = pendingQueue.shift();
        if (pending == null) {
          process.stderr.write(`[pipeClient] 无等待者的响应（丢弃）：${line.slice(0, 120)}\n`);
          continue;
        }
        clearTimeout(pending.timer);
        try {
          pending.resolve(JSON.parse(line));
        } catch {
          // 坏 JSON：失败本请求，不影响后续。
          pending.reject(new Error(`响应不是合法 JSON：${line.slice(0, 120)}`));
        }
      }
    });

    socket.on('close', () => failAll(new Error('管道连接断开')));
    socket.on('error', (error: Error) => failAll(error));
    // 连接+握手总时限（auth.ok 到达才 clearTimeout；仅 connect 不足以清除）。
    connectTimer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new Error(`管道连接/握手超时：${pipeName}`));
    }, options.connectTimeoutMs ?? 10_000);
    connectTimer.unref?.();
  });
}
