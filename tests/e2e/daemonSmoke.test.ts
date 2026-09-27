/**
 * DEV-07 集成 smoke（零额度，fake adapter）：daemon 入口全链——
 * project.open → message.submit（路由→落库→outbox→worker→任务完成→事件）→
 * 重启 daemon（历史保留 + 门禁 held 不自动续跑）→ dispatch.resume 后新任务可执行。
 * 验证 IPC 信封校验/幂等重放/未知命令错误。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../../src/daemon/entry.ts';
import type { RunningDaemon } from '../../src/daemon/entry.ts';
import { connectPipe } from '../../src/daemon/pipeClient.ts';
import { isDispatchGateHeld, openDispatchGate } from '../../src/persistence/daemonState.ts';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev07-'));
const projDir = join(fixtureRoot, 'proj');
const appData = join(fixtureRoot, 'appdata');
let daemon: RunningDaemon;
let pipe: Awaited<ReturnType<typeof connectPipe>>;

beforeAll(() => {
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'notes.md'), '# 备忘\n\n宇宙密码：DEV07-4242\n', 'utf8');
});
afterAll(async () => {
  pipe?.close();
  await daemon?.stop();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function envelope(method: string, params: unknown, commandId = `cmd-${randomUUID()}`): unknown {
  return { protocolVersion: 1, commandId, method, params };
}

interface ResultShape { ok: boolean; data?: { project?: { id: string }; created?: boolean }; error?: { code: string; message: string }; replayed?: boolean }

async function waitFor(cond: () => boolean, timeoutMs = 10_000, label = ''): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('DEV-07 daemon smoke（fake runtime，零额度）', () => {
  it('project.open：打开真实目录→项目+默认房间/成员引导；重复打开幂等', async () => {
    daemon = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 100 });
    pipe = await connectPipe(daemon.pipeName);
    const r1 = (await pipe.send(envelope('project.open', { path: projDir }))) as ResultShape;
    expect(r1.ok).toBe(true);
    expect(r1.data?.project?.id).toBeDefined();
    expect(r1.data?.created).toBe(true);
    const r2 = (await pipe.send(envelope('project.open', { path: projDir }))) as ResultShape;
    expect(r2.data?.project?.id).toBe(r1.data?.project?.id);
    expect(r2.data?.created).toBe(false);
    // 同 commandId 重放。
    const cmd = `cmd-${randomUUID()}`;
    const a = (await pipe.send(envelope('project.open', { path: projDir }, cmd))) as ResultShape;
    const b = (await pipe.send(envelope('project.open', { path: projDir }, cmd))) as ResultShape;
    expect(b.replayed).toBe(true);
    expect((b.data as { project: { id: string } }).project.id).toBe((a.data as { project: { id: string } }).project.id);
  }, 30_000);

  it('message.submit：指定成员→任务落库→worker 执行→完成事件回流（IPC 通路）', async () => {
    const projectRow = daemon.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    const roomRow = daemon.db.prepare('SELECT id, coordinator_member_id FROM rooms LIMIT 1').get() as { id: string; coordinator_member_id: string };
    const convRow = daemon.db.prepare('SELECT id FROM conversations LIMIT 1').get() as { id: string };
    const memberRow = daemon.db.prepare('SELECT id FROM project_members LIMIT 1').get() as { id: string };
    // room_members 引导（bootstrap 未含；直接补上，UI 接线由 DEV-07 后续补全表维护命令）。
    daemon.db.prepare('INSERT OR IGNORE INTO room_members (room_id, member_id) VALUES (?, ?)').run(roomRow.id, memberRow.id);

    const r = (await pipe.send(envelope('message.submit', {
      target: { kind: 'room_root', projectId: projectRow.id, conversationId: convRow.id, roomId: roomRow.id },
      body: '@成员 请读取 notes.md 并告诉我宇宙密码',
      intent: 'default',
      mentions: [{ kind: 'member', memberId: memberRow.id }],
    }))) as ResultShape;
    expect(r.ok).toBe(true);

    // worker（drain tick=100ms）→ 任务完成 → 事件可读。
    await waitFor(() => (daemon.db.prepare("SELECT count(*) c FROM tasks WHERE status = 'DONE'").get() as { c: number }).c > 0, 10_000, '任务完成');
    const events = (await pipe.send(envelope('events.list', { projectId: projectRow.id }))) as { ok: boolean; data: { items: Array<{ kind: string }> } };
    expect(events.ok).toBe(true);
    const kinds = events.data.items.map((e) => e.kind);
    expect(kinds).toContain('run.created');
    expect(kinds).toContain('thread.replyAdded');
  }, 30_000);

  it('信封校验与未知命令：多余字段/未知 method 返回结构化错误', async () => {
    const bad = await pipe.send({ protocolVersion: 1, commandId: `cmd-${randomUUID()}`, method: 'project.open', authorId: 'attacker', params: {} });
    expect(bad).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
    const unknown = (await pipe.send(envelope('no.such.command', {}))) as ResultShape;
    expect(unknown).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID', message: expect.stringContaining('未知命令') } });
  }, 15_000);

  it('重启：历史保留；恢复落门禁不自动续跑；dispatch.resume 后恢复调度', async () => {
    // 留一个未执行任务再重启。
    const projectRow = daemon.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    const roomRow = daemon.db.prepare('SELECT id FROM rooms LIMIT 1').get() as { id: string };
    const convRow = daemon.db.prepare('SELECT id FROM conversations LIMIT 1').get() as { id: string };
    const memberRow = daemon.db.prepare('SELECT id FROM project_members LIMIT 1').get() as { id: string };
    const r = (await pipe.send(envelope('message.submit', {
      target: { kind: 'room_root', projectId: projectRow.id, conversationId: convRow.id, roomId: roomRow.id },
      body: '第二个任务：再说一遍密码',
      intent: 'default',
      mentions: [{ kind: 'member', memberId: memberRow.id }],
    }))) as ResultShape;
    expect(r.ok).toBe(true);
    await waitFor(() => (daemon.db.prepare("SELECT count(*) c FROM outbox WHERE status = 'pending'").get() as { c: number }).c >= 1, 5_000, 'pending outbox');

    // 重启 daemon（close → start；历史保留）。
    pipe.close();
    const taskCountBefore = (daemon.db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c;
    await daemon.stop();

    daemon = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 100 });
    pipe = await connectPipe(daemon.pipeName);
    const taskCountAfter = (daemon.db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c;
    expect(taskCountAfter).toBe(taskCountBefore); // 历史保留
    expect(isDispatchGateHeld(daemon.db)).toBe(true); // 恢复门禁：不自动续跑
    await new Promise((resolve) => setTimeout(resolve, 400)); // 门禁期间 worker 不领取
    expect((daemon.db.prepare("SELECT count(*) c FROM outbox WHERE status = 'pending'").get() as { c: number }).c).toBeGreaterThanOrEqual(1);

    // 用户确认继续（IPC 命令）→ 派发恢复。
    const resume = (await pipe.send(envelope('dispatch.resume', {}))) as ResultShape;
    expect(resume.ok).toBe(true);
    await waitFor(() => (daemon.db.prepare("SELECT count(*) c FROM tasks WHERE status = 'DONE'").get() as { c: number }).c >= 2, 10_000, '第二任务完成');
    void openDispatchGate;
  }, 60_000);
});
