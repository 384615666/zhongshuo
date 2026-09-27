/**
 * 命名管道 IPC 传输（§8.3；修复轮 5：本地连接凭据握手）。
 *
 * 协议：连接后首帧必须是 {"type":"auth","token":"..."}；token 与 daemon 生成的
 * 本地凭据一致才接受后续命令，否则拒绝该连接（不执行任何命令）。
 * 任何能连上管道的主体 ≠ 可信调用者——CallerContext 只在凭据验证后构造。
 * 通过验证后：每行一个请求 envelope，回一行 result（同 socket FIFO 串行）。
 */
import { createServer, type Server, type Socket } from 'node:net';

export function daemonPipeNameFor(user: string): string {
  return `\\.\pipe\zhongshuo-daemon-${user}`;
}

export interface NamedPipeIpcHandle {
  pipeName: string;
  close(): Promise<void>;
  /** 当前已通过握手的连接数（诊断/测试用）。 */
  readonly authenticatedConnections: number;
}

export function startNamedPipeIpc(
  pipeName: string,
  handleLine: (envelope: unknown) => Promise<unknown>,
  options: { authToken: string },
): Promise<NamedPipeIpcHandle> {
  return new Promise((resolveStart, rejectStart) => {
    const sockets = new Set<Socket>();
    let authCount = 0;
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      let authenticated = false;
      // 同 socket 按行 FIFO 串行处理（异步 handler 的响应顺序与请求一致——
      // 否则同步失败路径会先于异步成功路径写出，响应错位到下一个请求）。
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (process: () => Promise<void>): void => {
        queue = queue.then(process, process);
      };
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (line.length === 0) continue;
          if (!authenticated) {
            // 首帧必须为合法握手；失败即断开，不接受任何命令。
            try {
              const auth = JSON.parse(line) as { type?: string; token?: string };
              if (auth?.type === 'auth' && auth.token === options.authToken) {
                authenticated = true;
                authCount += 1;
                socket.write(`${JSON.stringify({ type: 'auth.ok' })}\n`);
              } else {
                socket.write(`${JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED', message: '握手凭据无效', retryable: false } })}\n`);
                socket.end();
                return;
              }
            } catch {
              socket.end();
              return;
            }
            continue;
          }
          const requestLine = line;
          enqueue(async () => {
            let response: unknown;
            try {
              response = await handleLine(JSON.parse(requestLine));
            } catch (error) {
              response = {
                ok: false,
                error: { code: 'VALIDATION_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false },
              };
            }
            socket.write(`${JSON.stringify(response)}\n`);
          });
        }
      });
      socket.on('close', () => {
        sockets.delete(socket);
        if (authenticated) authCount -= 1;
      });
      socket.on('error', () => sockets.delete(socket));
    });
    server.once('error', rejectStart);
    server.listen(pipeName, () => {
      resolveStart({
        pipeName,
        get authenticatedConnections() {
          return authCount;
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
}
