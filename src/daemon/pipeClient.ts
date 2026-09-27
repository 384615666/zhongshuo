/**
 * 命名管道客户端（UI/renderer 用）：JSON 行协议；发送 envelope，返回 CommandResult。
 */
import { connect } from 'node:net';

export interface PipeClient {
  send<T = unknown>(envelope: unknown): Promise<T>;
  close(): void;
}

export function connectPipe(pipeName: string, timeoutMs = 10_000): Promise<PipeClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName);
    socket.setEncoding('utf8');
    let buffer = '';
    let waiter: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;
    const queue: Array<(v: unknown) => void> = [];
    socket.on('connect', () => {
      resolve({
        send<T = unknown>(envelope: unknown): Promise<T> {
          return new Promise<T>((res, rej) => {
            if (queue.length === 0 && waiter == null) {
              waiter = { resolve: res as (v: unknown) => void, reject: rej };
            } else {
              queue.push(res as (v: unknown) => void);
            }
            socket.write(`${JSON.stringify(envelope)}\n`);
          });
        },
        close() {
          socket.destroy();
        },
      });
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i = buffer.indexOf('\n');
      while (i >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        i = buffer.indexOf('\n');
        if (line.length === 0) continue;
        const value = JSON.parse(line);
        const w = waiter;
        waiter = queue.shift() != null ? { resolve: queue.shift() as (v: unknown) => void, reject: () => {} } : null;
        w?.resolve(value);
      }
    });
    socket.on('error', reject);
    setTimeout(() => reject(new Error(`管道连接超时：${pipeName}`)), timeoutMs).unref?.();
  });
}
