/**
 * 命名管道 IPC 传输（§8.3：Windows 用户级命名管道；Electron main / zs CLI / 未来 LAN 网关共用）。
 * 协议：换行分隔 JSON——每行一个 CommandEnvelope，回一行 CommandResult。
 * 命令面逻辑（envelope 校验/CallerContext/幂等）在调用方 handler；本层只做传输与帧。
 */
import { createServer, type Server, type Socket } from 'node:net';

export function daemonPipeName(userKey: string): string {
  return `\\\\.\\pipe\\zhongshuo-daemon-${userKey}`;
}

export interface NamedPipeIpcHandle {
  pipeName: string;
  close(): Promise<void>;
}

export function startNamedPipeIpc(
  pipeName: string,
  handleLine: (envelope: unknown) => Promise<unknown>,
): Promise<NamedPipeIpcHandle> {
  return new Promise((resolveStart, rejectStart) => {
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      // 同一 socket 按行 FIFO 串行处理（行协议要求响应顺序与请求一致）。
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
          const requestLine = line;
          enqueue(async () => {
            let response: unknown;
            try {
              const envelope: unknown = JSON.parse(requestLine);
              response = await handleLine(envelope);
            } catch (error) {
              response = {
                ok: false,
                error: {
                  code: 'VALIDATION_INVALID',
                  message: error instanceof Error ? error.message : String(error),
                  retryable: false,
                },
              };
            }
            socket.write(`${JSON.stringify(response)}\n`);
          });
        }
      });
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    server.once('error', rejectStart);
    server.listen(pipeName, () => {
      resolveStart({
        pipeName,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
}
