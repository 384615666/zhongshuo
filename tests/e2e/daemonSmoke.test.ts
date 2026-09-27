/**
 * DEV-07 集成 smoke（修复轮 5 重写：纯 IPC 命令链路，零额度）。
 * - 从空应用数据库开始；业务创建/操作只经正式 IPC 命令；
 *   只读 DB 仅作结果断言（不 INSERT/UPDATE 业务状态）。
 * - 覆盖：凭据握手（错 token 拒绝）；project.open 引导（含 room_members）；
 *   查询命令（room.list/member.list/task.get/thread.history）；DIRECT 提交→worker→事件；
 *   重启历史保留+门禁+confirm 续跑；pipeClient 并发/错误不串/断连清理；stop 幂等。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { startDaemon } from '../../src/daemon/entry.ts';
import type { RunningDaemon } from '../../src/daemon/entry.ts';
import { connectPipe } from '../../src/daemon/pipeClient.ts';
import type { PipeClient } from '../../src/daemon/pipeClient.ts';
import { isDispatchGateHeld } from '../../src/persistence/daemonState.ts';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev07r5-'));
const projDir = join(fixtureRoot, 'proj');
const appData = join(fixtureRoot, 'appdata');
const SMOKE_USER = `smoke-${randomUUID().slice(0, 8)}`;
const SMOKE_PIPE = `\\\\.\\pipe\\zhongshuo-smoke-${randomUUID().slice(0, 8)}`;
let daemon: RunningDaemon;
let pipe: PipeClient;

beforeAll(() => {
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'notes.md'), '# 备忘\n\n宇宙密码：DEV07R5-4242\n', 'utf8');
});
afterAll(async () => {
  pipe?.close();
  await daemon?.stop();
  for (let i = 0; i < 3; i += 1) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

function envelope(method: string, params: unknown, commandId = `cmd-${randomUUID()}`): unknown {
  return { protocolVersion: 1, commandId, method, params };
}

interface ResultShape {
  ok: boolean
  data?: Record<string, unknown> & { items?: Array<Record<string, unknown>> }
  error?: { code: string; message: string }
  replayed?: boolean
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, label = ''): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 上下文全部经查询命令取得（DB 只读断言用）。 */
async function readProjectRef(): Promise<{ projectId: string; roomId: string; conversationId: string; memberId: string }> {
  const project = daemon.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
  const rooms = (await pipe.send(envelope('room.list', { projectId: project.id }))) as ResultShape;
  const roomItem = rooms.data?.items?.[0] as { id: string; conversationId: string | null };
  const members = (await pipe.send(envelope('member.list', { projectId: project.id, roomId: roomItem.id }))) as ResultShape;
  const member = members.data?.items?.find((m) => (m as { principalType: string }).principalType === 'agent') as { id: string };
  return { projectId: project.id, roomId: roomItem.id, conversationId: roomItem.conversationId ?? '', memberId: member.id };
}

describe('DEV-07 r5 smoke：凭据 + 纯 IPC 命令链路（fake，零额度）', () => {
  it('凭据握手：错 token 连接被拒；正确 token 可用', async () => {
    daemon = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 100, localUserId: SMOKE_USER, pipeName: SMOKE_PIPE });
    const bad = await new Promise<{ ok: boolean; error?: { code: string } }>((resolve, reject) => {
      const socket = netConnect(SMOKE_PIPE);
      socket.setEncoding('utf8');
      let settled = false;
      socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'auth', token: 'wrong-token' })}\n`));
      socket.on('data', (d: string) => {
        if (settled) return;
        const line = d.trim().split('\n')[0] ?? '';
        if (line.length > 0) {
          settled = true;
          socket.destroy();
          resolve(JSON.parse(line));
        }
      });
      socket.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('握手响应超时'));
        }
      }, 5_000).unref?.();
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
    pipe = await connectPipe(SMOKE_PIPE, { token: daemon.credential.token });
    const pong = (await pipe.send(envelope('room.list', { projectId: 'none' }))) as ResultShape;
    expect(pong.ok).toBe(true); // 空项目也正常返回（非 AUTH 错误）
  }, 30_000);

  it('project.open：正式命令引导成员/房间/房间成员关系/会话；重复打开幂等', async () => {
    const r1 = (await pipe.send(envelope('project.open', { path: projDir }))) as ResultShape;
    expect(r1.ok).toBe(true);
    expect((r1.data as { created: boolean }).created).toBe(true);
    const projectId = (r1.data as { project: { id: string } }).project.id;
    // 引导完整性（只读断言）：room_members 已由正式命令建立。
    expect((daemon.db.prepare('SELECT count(*) c FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE project_id = ?)').get(projectId) as { c: number }).c).toBeGreaterThanOrEqual(1);
    expect((daemon.db.prepare('SELECT count(*) c FROM conversations WHERE project_id = ?').get(projectId) as { c: number }).c).toBe(1);
    // 重复打开：不重复创建。
    const cmd = `cmd-${randomUUID()}`;
    const r2 = (await pipe.send(envelope('project.open', { path: projDir }, cmd))) as ResultShape;
    expect((r2.data as { project: { id: string }; created: boolean }).project.id).toBe(projectId);
    expect((r2.data as { created: boolean }).created).toBe(false);
    const r3 = (await pipe.send(envelope('project.open', { path: projDir }, cmd))) as ResultShape;
    expect(r3.replayed).toBe(true);
    expect((daemon.db.prepare('SELECT count(*) c FROM rooms').get() as { c: number }).c).toBe(1);
  }, 30_000);

  it('纯 IPC 链路：查询取上下文 → DIRECT 提交 → worker 完成 → 事件/线程历史/task.get 回流', async () => {
    const ref = await readProjectRef();
    expect(ref.conversationId.length).toBeGreaterThan(0);
    const submit = (await pipe.send(envelope('message.submit', {
      target: { kind: 'room_root', projectId: ref.projectId, conversationId: ref.conversationId, roomId: ref.roomId },
      body: '@成员 请读取 notes.md 并告诉我宇宙密码',
      intent: 'default',
      mentions: [{ kind: 'member', memberId: ref.memberId }],
    }))) as ResultShape;
    expect(submit.ok).toBe(true);
    const submitData = submit.data as { taskId: string | null; threadId: string };
    expect(submitData.taskId).toBeDefined();

    await waitFor(() => (daemon.db.prepare("SELECT count(*) c FROM tasks WHERE status = 'DONE'").get() as { c: number }).c >= 1, 10_000, '任务完成');

    const task = (await pipe.send(envelope('task.get', { taskId: submitData.taskId }))) as ResultShape;
    expect((task.data as { task: { status: string } }).task.status).toBe('DONE');
    const history = (await pipe.send(envelope('thread.history', { threadId: submitData.threadId }))) as ResultShape;
    const items = (history.data as { items: Array<{ authorType: string }> }).items;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((m) => m.authorType === 'agent')).toBe(true); // agent 回复已入线程
    const events = (await pipe.send(envelope('events.list', { projectId: ref.projectId }))) as ResultShape;
    const kinds = ((events.data as { items: Array<{ kind: string }> }).items).map((e) => e.kind);
    expect(kinds).toContain('run.created');
  }, 30_000);

  it('pipeClient 并发与失败清理：3 并发各归其位；业务错误不串；断连清理', async () => {
    const ref = await readProjectRef();
    const [a, b, c] = (await Promise.all([
      pipe.send(envelope('room.list', { projectId: ref.projectId })),
      pipe.send(envelope('member.list', { projectId: ref.projectId, roomId: ref.roomId })),
      pipe.send(envelope('task.get', { taskId: 'no-such-task' })),
    ])) as [ResultShape, ResultShape, ResultShape];
    expect(a.ok).toBe(true);
    expect((a.data as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
    expect(b.ok).toBe(true);
    expect((b.data as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
    expect(c).toMatchObject({ ok: false, error: { code: 'RESOURCE_NOT_FOUND' } });
    // 断连：未决请求被拒绝（不留 pending）。
    const pending = pipe.send(envelope('room.list', { projectId: ref.projectId }));
    pipe.close();
    await expect(pending).rejects.toBeInstanceOf(Error);
    // 重连可用。
    pipe = await connectPipe(SMOKE_PIPE, { token: daemon.credential.token });
    const again = (await pipe.send(envelope('room.list', { projectId: ref.projectId }))) as ResultShape;
    expect(again.ok).toBe(true);
  }, 30_000);

  it('重启：历史保留；门禁不自动续跑；resume 无 confirm 拒绝；confirm 后续跑', async () => {
    const ref = await readProjectRef();
    const submit = (await pipe.send(envelope('message.submit', {
      target: { kind: 'room_root', projectId: ref.projectId, conversationId: ref.conversationId, roomId: ref.roomId },
      body: '第二个任务：再说一遍密码',
      intent: 'default',
      mentions: [{ kind: 'member', memberId: ref.memberId }],
    }))) as ResultShape;
    expect(submit.ok).toBe(true);
    await waitFor(() => (daemon.db.prepare("SELECT count(*) c FROM outbox WHERE status = 'pending'").get() as { c: number }).c >= 1, 5_000, 'pending outbox');

    pipe.close();
    const taskCountBefore = (daemon.db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c;
    await daemon.stop();

    daemon = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 100, localUserId: SMOKE_USER, pipeName: SMOKE_PIPE });
    pipe = await connectPipe(SMOKE_PIPE, { token: daemon.credential.token });
    expect((daemon.db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c).toBe(taskCountBefore);
    expect(isDispatchGateHeld(daemon.db)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((daemon.db.prepare("SELECT count(*) c FROM outbox WHERE status = 'pending'").get() as { c: number }).c).toBeGreaterThanOrEqual(1);

    const noConfirm = (await pipe.send(envelope('dispatch.resume', {}))) as ResultShape;
    expect(noConfirm).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
    expect(isDispatchGateHeld(daemon.db)).toBe(true);
    const resume = (await pipe.send(envelope('dispatch.resume', { confirm: true }))) as ResultShape;
    expect(resume.ok).toBe(true);
    await waitFor(() => (daemon.db.prepare("SELECT count(*) c FROM tasks WHERE status = 'DONE'").get() as { c: number }).c >= 2, 10_000, '第二任务完成');
  }, 60_000);

  it('daemon stop：运行中退出幂等且资源释放（可重启、锁可再获取）', async () => {
    await daemon.stop();
    await daemon.stop(); // 重复 stop 幂等
    const again = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 100, localUserId: SMOKE_USER, pipeName: SMOKE_PIPE });
    expect(again.pipeName).toBe(daemon.pipeName);
    daemon = again;
    pipe = await connectPipe(SMOKE_PIPE, { token: daemon.credential.token });
    const projectId = (daemon.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }).id;
    const rooms = (await pipe.send(envelope('room.list', { projectId }))) as ResultShape;
    expect(rooms.ok).toBe(true);
  }, 30_000);
});
