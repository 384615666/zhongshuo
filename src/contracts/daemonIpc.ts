/**
 * ui↔daemon IPC 协议共享层（§8.4：ui 仅依赖 contracts，经命名管道消费 daemon）。
 *
 * 管道名、本地凭据与管道客户端由 ui（Electron main）与 daemon 两侧共同使用，
 * 属于跨进程合同而非 daemon 内部实现——置于 contracts，边界规则下双方均可导入。
 *
 * 协议：首帧 {"type":"auth","token":"..."}；之后每行一个 CommandEnvelope；
 * 服务端回执（成功与错误）均携带 commandId，客户端按 commandId 配对——
 * 超时请求的迟到响应因无等待者而被丢弃并记录，绝不交给下一个请求。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { connect } from 'node:net';

// ---------- 管道名与本地身份 ----------

export function daemonPipeNameFor(user: string): string {
  return `\\\\.\\pipe\\zhongshuo-daemon-${user}`;
}

/** 本地用户 id：主目录路径清洗（与 daemon 侧一致，决定管道名/作者身份）。 */
export function localUserId(home: string = homedir()): string {
  return `local-${home.replaceAll('\\', '_').replaceAll(':', '_')}`;
}

// ---------- 本地连接凭据（修复轮 5） ----------

export interface LocalCredential {
  token: string;
  credentialPath: string;
}

/**
 * daemon 启动生成随机 token，写 appData（0600 权限语义：Windows 受管目录继承 +
 * 显式 ACL 由 DEV-20 完整加固，此处至少不回显、不进日志）。UI 进程（Electron main）
 * 从同机文件读取后经握手帧提交。
 */
export function ensureLocalCredential(appDataDir: string): LocalCredential {
  const credentialPath = join(appDataDir, 'local.token');
  if (existsSync(credentialPath)) {
    try {
      const token = readFileSync(credentialPath, 'utf8').trim();
      if (token.length >= 32) return { token, credentialPath };
    } catch {
      // 读失败按损坏处理：重生成。
    }
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(credentialPath, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(credentialPath, 0o600);
  } catch {
    // Windows chmod 非等价隔离（§2.1 受管文件口径）；DEV-20 完整加固。
  }
  return { token, credentialPath };
}

// ---------- 命名管道客户端（修复轮 6：commandId 关联配对） ----------

export interface PipeClientOptions {
  /** 本地连接凭据（daemon 生成的 token）。 */
  token: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface PipeClient {
  send<T = unknown>(envelope: unknown): Promise<T>;
  close(): void;
  readonly closed: boolean;
}

interface Pending {
  commandId: string;
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
    const pendingByCommandId = new Map<string, Pending>();

    const failAll = (error: Error): void => {
      if (closed) return;
      closed = true;
      for (const p of [...pendingByCommandId.values()]) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pendingByCommandId.clear();
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'auth', token: options.token })}\n`);
    });

    let authenticated = false;
    let connectTimer: NodeJS.Timeout | null = null;
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
      const auth = parsed as { type?: string; error?: { message?: string } };
      if (auth?.type === 'auth.ok') {
        authenticated = true;
        if (connectTimer != null) clearTimeout(connectTimer);
        resolveConnect({
          get closed() {
            return closed;
          },
          send<T = unknown>(envelope: unknown): Promise<T> {
            if (closed) return Promise.reject(new Error('管道连接已关闭'));
            const commandId = (envelope as { commandId?: string })?.commandId;
            if (typeof commandId !== 'string' || commandId.length === 0) {
              return Promise.reject(new Error('信封缺少 commandId，无法关联响应'));
            }
            return new Promise<T>((resolve, reject) => {
              const pending: Pending = { commandId, resolve: resolve as (v: unknown) => void, reject, timer: null as unknown as NodeJS.Timeout };
              pending.timer = setTimeout(() => {
                // 超时：从关联表移除；服务端稍后的迟到响应因无等待者被丢弃（见 data 处理），
                // 不会错配给下一个请求。连接保持（FIFO 语义仍按 commandId 精确配对）。
                pendingByCommandId.delete(commandId);
                reject(new Error(`请求超时（${requestTimeoutMs}ms）：${(envelope as { method?: string }).method ?? commandId}`));
              }, requestTimeoutMs);
              pending.timer.unref?.();
              pendingByCommandId.set(commandId, pending);
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
        if (!authenticated && authenticate(line)) continue;
        let response: { commandId?: string };
        try {
          response = JSON.parse(line) as { commandId?: string };
        } catch {
          // 坏帧：无 commandId 可关联——丢弃并记录，不猜归属。
          process.stderr.write(`[pipeClient] 坏帧丢弃：${line.slice(0, 120)}\n`);
          continue;
        }
        const pending = response.commandId != null ? pendingByCommandId.get(response.commandId) : undefined;
        if (pending == null) {
          // 迟到响应（该请求已超时/已失败）或服务端主动通知：丢弃，不给其他请求。
          process.stderr.write(`[pipeClient] 无等待者响应丢弃（commandId=${response.commandId ?? '?'}）：${line.slice(0, 120)}\n`);
          continue;
        }
        pendingByCommandId.delete(pending.commandId);
        clearTimeout(pending.timer);
        pending.resolve(response);
      }
    });

    socket.on('close', () => failAll(new Error('管道连接断开')));
    socket.on('error', (error: Error) => failAll(error));
    // 连接+握手总时限（auth.ok 到达才清除）。
    connectTimer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new Error(`管道连接/握手超时：${pipeName}`));
    }, options.connectTimeoutMs ?? 10_000);
    connectTimer.unref?.();
  });
}
