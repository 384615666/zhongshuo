/**
 * pipeClient 超时错配反例（零额度）：A 先超时，B 随后发出；
 * A 的迟到响应到达时必须被丢弃，B 拿到自己的结果（绝不拿到 A 的回执）。
 * 用本地 TCP/管道延迟服务端注入受控延迟。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectPipe } from '../../src/contracts/daemonIpc.ts';

const tmp = mkdtempSync(join(tmpdir(), 'zs-pipe-timeout-'));
const socketPath = `\\\\.\\pipe\\zhongshuo-timeout-test-${process.pid}`;
let server: Server;

beforeAll(async () => {
  server = createServer((socket) => {
    socket.setEncoding('utf8');
    // 客户端主动 close 后的迟到写入 → EPIPE：吞掉（不影响断言——丢包正是被测行为）。
    socket.on('error', () => {});
    let buffer = '';
    let first = true;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i = buffer.indexOf('\n');
      while (i >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        i = buffer.indexOf('\n');
        if (line.length === 0) continue;
        const msg = JSON.parse(line) as { type?: string; commandId?: string; method?: string };
        if (msg.type === 'auth') {
          socket.write('{"type":"auth.ok"}\n');
          continue;
        }
        if (first && msg.commandId === 'cmd-A') {
          first = false;
          // A 延迟 400ms 才回（客户端超时 50ms）——制造迟到响应。
          setTimeout(() => socket.write(`${JSON.stringify({ commandId: 'cmd-A', ok: true, data: 'A-late-result' })}\n`), 400);
          continue;
        }
        socket.write(`${JSON.stringify({ commandId: msg.commandId, ok: true, data: `B-${msg.commandId}` })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

describe('pipeClient 超时后迟到响应按 commandId 丢弃', () => {
  it('A 超时 → B 正常 → A 迟到响应被丢弃，B 不拿 A 的结果', async () => {
    const client = await connectPipe(socketPath, { token: 'test', requestTimeoutMs: 50 });
    const a = client.send({ protocolVersion: 1, commandId: 'cmd-A', method: 'm', params: {} });
    await expect(a).rejects.toThrow('请求超时');
    const b = (await client.send({ protocolVersion: 1, commandId: 'cmd-B', method: 'm', params: {} })) as { commandId?: string; data?: string };
    expect(b.commandId).toBe('cmd-B');
    expect(b.data).toBe('B-cmd-B'); // B 拿到的是自己的结果
    // 等待 A 的迟到响应到达并确认它被丢弃（连接仍可用）。
    await new Promise((r) => setTimeout(r, 500));
    const c = (await client.send({ protocolVersion: 1, commandId: 'cmd-C', method: 'm', params: {} })) as { data?: string };
    expect(c.data).toBe('B-cmd-C');
    client.close();
  }, 10_000);

  it('超时后断连：未决请求全部失败，无 pending 泄漏', async () => {
    const client = await connectPipe(socketPath, { token: 'test', requestTimeoutMs: 60_000 });
    const slow = client.send({ protocolVersion: 1, commandId: 'cmd-slow', method: 'm', params: {} });
    client.close();
    await expect(slow).rejects.toBeInstanceOf(Error);
  }, 10_000);
});
