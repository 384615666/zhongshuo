import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { enqueueOutbox, claimNextOutbox, listOutbox } from '../../src/persistence/outbox.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { failingTurn, stuckTurn } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { applyRecovery, requestStop, StopCommandError } from '../../src/daemon/stopFlow.ts';
import { openDispatchGate } from '../../src/persistence/daemonState.ts';
import { acquireSingletonLock } from '../../src/daemon/singletonLock.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-dev05-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seed(db: ZhongshuoDatabase): void {
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', 'demo', 'D:/x', 'D:/x', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES
       ('m_human', 'p1', '我', 'human', 1), ('m_agent', 'p1', 'Codex', 'agent', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_1', 'p1', '大厅', 'm_agent')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room_1', 'p1', 'room', 'room_1')`,
  ).run();
}

function makeTask(db: ZhongshuoDatabase, n: number) {
  const input = {
    ids: {
      messageId: `msg_root_${n}`,
      threadId: `thread_${n}`,
      taskId: `task_${n}`,
      taskEventId: `evt_task_${n}`,
      threadEventId: `evt_thread_${n}`,
    },
    projectId: 'p1',
    conversationId: 'conv_room_1',
    roomId: 'room_1',
    intent: 'default' as const,
    title: `任务 ${n}`,
    body: '@Codex 分析一下',
    mentions: [{ kind: 'member', memberId: 'm_agent' }] as const,
    author: { authorType: 'human' as const, authorId: 'm_human' },
    reviewPolicy: 'auto_deliver' as const,
    sourceConnectionId: null,
    route: {
      kind: 'dispatch',
      mode: 'DIRECT',
      targetMemberId: 'm_agent',
      frozenMemberIds: ['m_agent'],
      initialWakeMemberIds: ['m_agent'],
    } as const,
    now: 1000 + n,
  };
  const r = createRoomRootTask(db, input);
  if (!r.ok) throw new Error(`createRoomRootTask 失败: ${r.error.message}`);
  return r.value;
}

function openMem(): ZhongshuoDatabase {
  const db = openDatabase(':memory:');
  seed(db);
  return db;
}

describe('派发 worker：成功全链路（G1 核心）', () => {
  it('outbox→run/turn→fake 执行→消息入正确线程→任务 DONE→预算结算→outbox done', async () => {
    const db = openMem();
    makeTask(db, 1);
    const worker = new DispatchWorker({ db, adapter: new FakeRuntimeAdapter(), leaseOwner: 'w1' });

    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false); // 队列已空

    const task = db.prepare('SELECT status, owner_member_id, stop_generation FROM tasks WHERE id = ?').get('task_1');
    expect(task).toMatchObject({ status: 'DONE', owner_member_id: 'm_agent', stop_generation: 0 });
    const run = db.prepare('SELECT id, status, mode, thread_id FROM workflow_runs WHERE task_id = ?').get('task_1');
    expect(run).toMatchObject({ status: 'SUCCEEDED', mode: 'DIRECT', thread_id: 'thread_1' });
    const turn = db.prepare('SELECT status, member_id FROM agent_turns WHERE run_id = ?').get((run as { id: string }).id);
    expect(turn).toMatchObject({ status: 'SUCCEEDED', member_id: 'm_agent' });
    // 最终回复落在正确线程（thread_message_seq=1；conversation_seq=2 紧跟 anchor）
    const reply = db.prepare('SELECT * FROM messages WHERE thread_id = ?').get('thread_1');
    expect(reply).toMatchObject({
      thread_message_seq: 1,
      conversation_seq: 2,
      author_type: 'agent',
      status: 'final',
    });
    expect(db.prepare('SELECT count(*) c FROM usage_records').get()).toMatchObject({ c: 1 });
    expect(listOutbox(db, 'done')).toHaveLength(1);
    const budget = JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE task_id = ?').get('task_1') as { budget_json: string }).budget_json);
    expect(budget).toMatchObject({ maxTurns: 6, usedTurns: 1, inFlightReservedTurns: 0 });
    db.close();
  });

  it('失败 fixture：run FAILED、任务回到 ACTIVE（可重试）、outbox done', async () => {
    const db = openMem();
    makeTask(db, 2);
    const worker = new DispatchWorker({
      db,
      adapter: new FakeRuntimeAdapter({ turnScripts: [failingTurn()] }),
      leaseOwner: 'w1',
    });
    await worker.runOnce();
    expect(db.prepare('SELECT status FROM workflow_runs WHERE task_id = ?').get('task_2')).toMatchObject({ status: 'FAILED' });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_2')).toMatchObject({ status: 'ACTIVE' });
    expect(listOutbox(db, 'done')).toHaveLength(1);
    db.close();
  });

  it('RT-05：同一 dispatchKey 不产生第二个 run（outbox 单次派发语义）', async () => {
    const db = openMem();
    makeTask(db, 3);
    const worker = new DispatchWorker({ db, adapter: new FakeRuntimeAdapter(), leaseOwner: 'w1' });
    await worker.runOnce();
    // 重复入队同 key → 返回既有 done 行，不再派发。
    enqueueOutbox(db, { dispatchKey: 'task:task_3:initial' });
    await worker.drain();
    expect(db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get('task_3')).toMatchObject({ c: 1 });
    expect(db.prepare('SELECT count(*) c FROM messages WHERE thread_id = ?').get('thread_3')).toMatchObject({ c: 1 });
    db.close();
  });

  it('RT-02：提交后崩溃（派发前）→ 重启落门禁不自动补跑，用户确认后续派', async () => {
    const path = join(tmpRoot, 'restart-dev05.db');
    const db = openDatabase(path);
    seed(db);
    makeTask(db, 4);
    db.close(); // 崩溃：任务已提交、未领取（无 run/turn）

    const reopened = openDatabase(path);
    // 启动恢复：已提交未领取的遗留 outbox 也落门禁（修复轮 2 收口）。
    applyRecovery(reopened, 10_000);
    const worker = new DispatchWorker({ db: reopened, adapter: new FakeRuntimeAdapter(), leaseOwner: 'w2' });
    expect(await worker.drain()).toBe(0); // 不自动补跑（决策 44/E7）
    expect(reopened.prepare('SELECT count(*) c FROM workflow_runs').get()).toMatchObject({ c: 0 });

    openDispatchGate(reopened); // 用户确认继续
    expect(await worker.drain()).toBe(1);
    expect(reopened.prepare('SELECT status FROM tasks WHERE id = ?').get('task_4')).toMatchObject({ status: 'DONE' });
    expect(reopened.prepare('SELECT count(*) c FROM messages WHERE thread_id = ?').get('thread_4')).toMatchObject({ c: 1 });
    reopened.close();
  });
});

describe('停止流程（§7.3/§16.3、开工契约 §3.2）', () => {
  it('运行中停止：STOPPING→协议中断→确认退出 CANCELLED；旧停止不伤后续', async () => {
    const db = openMem();
    makeTask(db, 5);
    const worker = new DispatchWorker({
      db,
      adapter: new FakeRuntimeAdapter({ turnScripts: [stuckTurn(10_000)] }),
      leaseOwner: 'w1',
    });
    const running = worker.runOnce(); // 消费中（stall 10s）
    await new Promise((r) => setTimeout(r, 30)); // 等 run/turn 建立

    const run = db.prepare('SELECT id, status FROM workflow_runs WHERE task_id = ?').get('task_5') as { id: string; status: string };
    expect(run.status).toBe('RUNNING');

    const result = await requestStop(db, {
      taskId: 'task_5',
      targetRunId: run.id,
      expectedStopGeneration: 0,
      commandId: 'cmd-stop-0001',
      idempotencyScope: 'user:u1',
      payloadHash: 'h_stop',
      now: 2000,
      interruptTurn: (turnId) => worker.interruptTurn(turnId),
    });
    expect(result).toMatchObject({ outcome: 'stopping', stopGeneration: 1 });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.id)).toMatchObject({ status: 'STOPPING' });

    await running; // 中断后 fake 以 INTERRUPTED 终结，worker 完成收尾
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.id)).toMatchObject({ status: 'CANCELLED' });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_5')).toMatchObject({ status: 'CANCELLED' });
    const turn = db.prepare('SELECT status FROM agent_turns WHERE run_id = ?').get(run.id);
    expect(turn).toMatchObject({ status: 'CANCELLED' });
    // 停止代次持久化（§11.4）：阻止该任务旧代次再派发。
    expect(db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get('task_5')).toMatchObject({ stop_generation: 1 });

    // 旧停止重放（同 commandId 同 hash）→ 幂等返回原结果，不叠加副作用。
    const replay = await requestStop(db, {
      taskId: 'task_5',
      targetRunId: run.id,
      expectedStopGeneration: 0,
      commandId: 'cmd-stop-0001',
      idempotencyScope: 'user:u1',
      payloadHash: 'h_stop',
      now: 2100,
      interruptTurn: () => Promise.resolve(),
    });
    expect(replay.outcome).toBe('stopping');
    expect(db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get('task_5')).toMatchObject({ stop_generation: 1 });
    db.close();
  });

  it('旧 run 的停止请求 → already_stopped，新状态不被修改', async () => {
    const db = openMem();
    makeTask(db, 6);
    const worker = new DispatchWorker({ db, adapter: new FakeRuntimeAdapter(), leaseOwner: 'w1' });
    await worker.runOnce();
    const run = db.prepare('SELECT id FROM workflow_runs WHERE task_id = ?').get('task_6') as { id: string };
    const r = await requestStop(db, {
      taskId: 'task_6',
      targetRunId: run.id,
      expectedStopGeneration: 0,
      commandId: 'cmd-stop-0002',
      idempotencyScope: 'user:u1',
      payloadHash: 'h2',
      now: 3000,
      interruptTurn: () => Promise.resolve(),
    });
    expect(r.outcome).toBe('already_stopped');
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_6')).toMatchObject({ status: 'DONE' });
    db.close();
  });

  it('不存在的任务 → RESOURCE_NOT_FOUND（经 StopCommandError）', async () => {
    const db = openMem();
    await expect(
      requestStop(db, {
        taskId: 'task_none',
        targetRunId: 'run_x',
        expectedStopGeneration: 0,
        commandId: 'cmd-stop-0003',
        idempotencyScope: 'user:u1',
        payloadHash: 'h',
        now: 1,
        interruptTurn: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(StopCommandError);
    db.close();
  });
});

describe('恢复（§16.4：不自动补跑）', () => {
  it('非终态 run/turn 标记 INTERRUPTED/UNKNOWN；过期租约 outbox 重排 pending；租约保留人工处理', () => {
    const db = openMem();
    makeTask(db, 7);
    // 模拟崩溃前状态：outbox 被领取且租约已过、run 非终态。
    const claimed = claimNextOutbox(db, { leaseOwner: 'w_dead', leaseUntil: 500, now: 100 });
    expect(claimed).not.toBeNull();
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run_orphan', 'task_7', 'conv_room_1', 'DIRECT', 'RUNNING')`).run();
    db.prepare(
      `INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status) VALUES ('turn_orphan', 'run_orphan', 'conv_room_1', 'm_agent', 'x', 'RUNNING')`,
    ).run();

    const snapshot = applyRecovery(db, /* now */ 10_000);
    expect(snapshot.interruptedRuns).toBe(1);
    expect(snapshot.unknownTurns).toBe(1);
    expect(snapshot.requeuedOutbox).toBe(1);
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run_orphan')).toMatchObject({ status: 'INTERRUPTED' });
    expect(db.prepare('SELECT status FROM agent_turns WHERE id = ?').get('turn_orphan')).toMatchObject({ status: 'UNKNOWN' });
    // 重排但未派发：pending 存在、无新 run 创建。
    expect(listOutbox(db, 'pending')).toHaveLength(1);
    expect(db.prepare('SELECT count(*) c FROM workflow_runs').get()).toMatchObject({ c: 1 });
    db.close();
  });
});

describe('daemon 单实例锁（§8.3）', () => {
  it('互斥 + 释放 + 死进程接管', () => {
    const dir = join(tmpRoot, 'lockdir');
    const first = acquireSingletonLock(dir);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstHandle = first.value;

    const second = acquireSingletonLock(dir);
    expect(second).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });

    firstHandle.release();
    const third = acquireSingletonLock(dir);
    expect(third.ok).toBe(true);

    // 陈旧锁（pid 已死）允许接管。
    if (third.ok) third.value.release();
    const lockPath = join(dir, 'daemon.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: 0 }), 'utf8');
    const fourth = acquireSingletonLock(dir);
    expect(fourth.ok).toBe(true);
    if (fourth.ok) {
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
      fourth.value.release();
    }
  });
});
