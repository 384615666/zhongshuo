import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { claimNextOutbox, listOutbox } from '../../src/persistence/outbox.ts';
import { isDispatchGateHeld, openDispatchGate } from '../../src/persistence/daemonState.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { stuckTurn, unresponsiveTurn } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { applyRecovery, requestStop } from '../../src/daemon/stopFlow.ts';
import { acquireSingletonLock, readSingletonLock, writeLockDirForTest, preclaimLockForTest } from '../../src/daemon/singletonLock.ts';
import { startNamedPipeIpc } from '../../src/daemon/namedPipeIpc.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-fix-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function openMem(): ZhongshuoDatabase {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', 'demo', 'D:/x', 'D:/x', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES
       ('m_human', 'p1', '我', 'human', 1), ('m_a', 'p1', '甲', 'agent', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_1', 'p1', '大厅', 'm_a')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room_1', 'p1', 'room', 'room_1')`,
  ).run();
  return db;
}

type RouteSpec = 'DIRECT' | 'AUTO' | 'DELIBERATE';

function makeTask(db: ZhongshuoDatabase, n: number, options: { route?: RouteSpec; reviewPolicy?: 'auto_deliver' | 'user_review'; memberId?: string } = {}) {
  const memberId = options.memberId ?? 'm_a';
  const route =
    options.route === 'AUTO'
      ? { kind: 'dispatch', mode: 'AUTO', coordinatorMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] }
      : options.route === 'DELIBERATE'
        ? { kind: 'dispatch', mode: 'DELIBERATE', rosterSource: 'all', frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] }
        : { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] };
  const r = createRoomRootTask(db, {
    ids: {
      messageId: `msg_root_${n}`, threadId: `thread_${n}`, taskId: `task_${n}`,
      taskEventId: `evt_task_${n}`, threadEventId: `evt_thread_${n}`,
    },
    projectId: 'p1',
    conversationId: 'conv_room_1',
    roomId: 'room_1',
    intent: 'default',
    title: `任务${n}`,
    body: '请处理',
    mentions: [{ kind: 'member', memberId }],
    author: { authorType: 'human', authorId: 'm_human' },
    reviewPolicy: options.reviewPolicy ?? 'auto_deliver',
    sourceConnectionId: null,
    route: route as never,
    now: 1000 + n,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('FIX-8a：模式门禁——M0 仅 DIRECT，未实现模式明确不可用', () => {
  for (const mode of ['AUTO', 'DELIBERATE'] as const) {
    it(`${mode} 任务不执行、不建 run，任务进 BLOCKED 并留审计`, async () => {
      const db = openMem();
      makeTask(db, 1, { route: mode });
      const adapter = new FakeRuntimeAdapter();
      const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1' });
      await worker.runOnce();
      expect(db.prepare('SELECT count(*) c FROM workflow_runs').get()).toMatchObject({ c: 0 });
      expect(db.prepare('SELECT count(*) c FROM agent_turns').get()).toMatchObject({ c: 0 });
      expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_1')).toMatchObject({ status: 'BLOCKED' });
      const audits = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'task.statusChanged'").all() as Array<{ payload_json: string }>;
      const modeAudit = audits.map((a) => JSON.parse(a.payload_json)).find((p) => (p as { reason?: string }).reason === 'mode_unavailable_in_m0');
      expect(modeAudit).toMatchObject({ status: 'BLOCKED', mode });
      expect(listOutbox(db, 'done')).toHaveLength(1);
      await adapter.closeAllSessions();
      db.close();
    });
  }
});

describe('FIX-8b：验收策略收尾（§10.5）', () => {
  it('user_review：成功 → task REVIEW + pending 交付（唯一待办）+ current_delivery_id', async () => {
    const db = openMem();
    makeTask(db, 1, { reviewPolicy: 'user_review' });
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w1' }).runOnce();
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_1')).toMatchObject({ status: 'REVIEW' });
    const delivery = db.prepare('SELECT * FROM task_deliveries WHERE task_id = ?').get('task_1') as Record<string, unknown>;
    expect(delivery).toMatchObject({ review_status: 'pending', reviewed_by: null, reviewed_at: null, revision: 1 });
    expect(db.prepare('SELECT current_delivery_id FROM tasks WHERE id = ?').get('task_1')).toMatchObject({
      current_delivery_id: delivery['id'],
    });
    await adapter.closeAllSessions();
    db.close();
  });

  it('auto_deliver：成功 → task DONE + not_required 交付（不伪造人工通过）', async () => {
    const db = openMem();
    makeTask(db, 2, { reviewPolicy: 'auto_deliver' });
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w1' }).runOnce();
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_2')).toMatchObject({ status: 'DONE' });
    const delivery = db.prepare('SELECT review_status, reviewed_by FROM task_deliveries WHERE task_id = ?').get('task_2');
    expect(delivery).toMatchObject({ review_status: 'not_required', reviewed_by: null });
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('FIX-2：沉默 runtime 的独立截止计时', () => {
  it('开始后持续无输出：截止到点自动中断（响应中断 → CANCELLED）', async () => {
    const db = openMem();
    makeTask(db, 1);
    const adapter = new FakeRuntimeAdapter({ turnScripts: [stuckTurn(60_000)] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1', turnDeadlineMs: 100, interruptGraceMs: 2_000 });
    await worker.runOnce(); // 事件流沉默，靠独立计时器触发中断
    expect(db.prepare('SELECT status FROM workflow_runs WHERE task_id = ?').get('task_1')).toMatchObject({ status: 'CANCELLED' });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_1')).toMatchObject({ status: 'CANCELLED' });
    await adapter.closeAllSessions();
    db.close();
  });

  it('中断后仍无终结（停止不响应）：宽限到点 → UNKNOWN/INTERRUPTED，不伪造结果', async () => {
    const db = openMem();
    makeTask(db, 2);
    const adapter = new FakeRuntimeAdapter({ turnScripts: [unresponsiveTurn()] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1', turnDeadlineMs: 60, interruptGraceMs: 150 });
    await worker.runOnce();
    expect(db.prepare("SELECT status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)").get('task_2')).toMatchObject({ status: 'UNKNOWN' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE task_id = ?').get('task_2')).toMatchObject({ status: 'INTERRUPTED' });
    // 任务不 DONE/不 CANCELLED：结果不确定，等恢复/人工核对。
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_2')).toMatchObject({ status: 'ACTIVE' });
    const audit = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'turn.statusChanged'").get() as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ status: 'UNKNOWN', reason: 'no-terminal-after-deadline' });
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('FIX-3：会话打开期间的停止竞态', () => {
  it('openSession 等待中点停止：复查生效 → 不 startTurn，按取消收尾', async () => {
    const db = openMem();
    makeTask(db, 1);
    const adapter = new FakeRuntimeAdapter({ openSessionDelayMs: 400 });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1' });
    const running = worker.runOnce();

    // 等 run/turn 建立（会话还在打开中）。
    const startedAt = Date.now();
    for (;;) {
      const row = db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number };
      if (row.c > 0) break;
      if (Date.now() - startedAt > 3_000) throw new Error('等待 run 创建超时');
      await new Promise((r) => setTimeout(r, 5));
    }
    const run = db.prepare('SELECT id FROM workflow_runs WHERE task_id = ?').get('task_1') as { id: string };
    const stop = await requestStop(db, {
      taskId: 'task_1', targetRunId: run.id, expectedStopGeneration: 0,
      commandId: 'cmd-race-0001', idempotencyScope: 'user:u1', payloadHash: 'h', now: 2_000,
      interruptTurn: (turnId) => worker.interruptTurn(turnId), // live 未登记 → no-op
    });
    expect(stop).toMatchObject({ outcome: 'stopping' });

    await running; // 会话打开后复查 → 取消路径
    expect(db.prepare('SELECT status FROM agent_turns WHERE run_id = ?').get(run.id)).toMatchObject({ status: 'CANCELLED' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.id)).toMatchObject({ status: 'CANCELLED' });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task_1')).toMatchObject({ status: 'CANCELLED' });
    // 没有 turn 开始执行：无回复消息（仅 anchor）、无 runtime_started 痕迹
    expect(db.prepare('SELECT count(*) c FROM messages').get()).toMatchObject({ c: 1 });
    const cancelAudit = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'turn.statusChanged'").get() as { payload_json: string };
    expect(JSON.parse(cancelAudit.payload_json)).toMatchObject({ status: 'CANCELLED', reason: 'stop-during-session-open' });
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('FIX-4：恢复门禁与崩溃重领对账', () => {
  it('恢复落下门禁：worker 不领取；用户确认继续后恢复派发', async () => {
    const db = openMem();
    makeTask(db, 1);
    // 模拟崩溃现场：领取后租约过期 + 非终态 run。
    claimNextOutbox(db, { leaseOwner: 'w_dead', leaseUntil: 500, now: 100 });
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run_orphan', 'task_1', 'conv_room_1', 'DIRECT', 'RUNNING')`).run();
    applyRecovery(db, 10_000);
    expect(isDispatchGateHeld(db)).toBe(true);

    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w2' });
    expect(await worker.drain()).toBe(0); // 门禁：不自动补跑（决策 44/E7）
    expect(db.prepare('SELECT count(*) c FROM workflow_runs').get()).toMatchObject({ c: 1 }); // 无新 run

    openDispatchGate(db); // 用户确认继续
    expect(await worker.drain()).toBe(1); // 重排队列按正常流程派发
    await adapter.closeAllSessions();
    db.close();
  });

  it('dispatch_key 已有 turn 的重领：不再执行，标 failed 留对账审计（RT-03 语义）', async () => {
    const db = openMem();
    makeTask(db, 2);
    // 崩溃前已建 turn（副作用不确定），outbox 经恢复重排 pending。
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run_x', 'task_2', 'conv_room_1', 'DIRECT', 'INTERRUPTED')`).run();
    db.prepare(
      `INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key)
       VALUES ('turn_x', 'run_x', 'conv_room_1', 'm_a', 'direct.work', 'UNKNOWN', 'task:task_2:initial')`,
    ).run();
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w2' }).runOnce();
    expect(db.prepare("SELECT count(*) c FROM agent_turns WHERE dispatch_key = 'task:task_2:initial'").get()).toMatchObject({ c: 1 }); // 无第二个 turn
    expect(listOutbox(db, 'failed')).toHaveLength(1);
    const audit = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'run.reconcileRequired'").get() as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ reason: 'crash-reclaimed-dispatch', existingTurnId: 'turn_x' });
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('FIX-7：replyAdded 事件引用与数据库消息一致', () => {
  it('事件 payload.messageId 能在 messages 命中同一条记录', async () => {
    const db = openMem();
    makeTask(db, 1);
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w1' }).runOnce();
    const event = db.prepare("SELECT payload_json FROM domain_events WHERE kind = 'thread.replyAdded'").get() as { payload_json: string };
    const payload = JSON.parse(event.payload_json) as { messageId: string };
    const message = db.prepare('SELECT id, thread_id FROM messages WHERE id = ?').get(payload.messageId);
    expect(message).toBeDefined();
    expect(message).toMatchObject({ thread_id: 'thread_1' });
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('FIX-5：单实例锁双进程竞态（真实子进程）', () => {
  it('两个进程并发启动：恰好一个获得锁', async () => {
    const dir = join(tmpRoot, 'race-' + Date.now());
    const run = (): Promise<{ ok: boolean }> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ['--experimental-strip-types', 'tests/fixtures/lockRaceWorker.ts', dir],
          { cwd: process.cwd(), timeout: 15_000 },
          (error, stdout) => {
            if (error != null && !stdout) {
              reject(error);
              return;
            }
            const line = stdout.trim().split('\n').pop() ?? '';
            try {
              resolve(JSON.parse(line) as { ok: boolean });
            } catch {
              reject(new Error(`无法解析子进程输出: ${line}`));
            }
          },
        );
      });
    const [a, b] = await Promise.all([run(), run()]);
    const winners = [a, b].filter((r) => r.ok).length;
    expect(winners).toBe(1); // O_EXCL 原子性：并发下只有一个赢家
  }, 30_000);
});

describe('FIX-9：命名管道 IPC（测试客户端验证）', () => {
  it('JSON 行协议往返：合法信封回结果、坏行回错误', async () => {
    const pipeName = `\\\\.\\pipe\\zhongshuo-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = await startNamedPipeIpc(pipeName, async (envelope) => {
      const e = envelope as { method?: string };
      if (e.method === 'ping') return { ok: true, data: 'pong' };
      return { ok: false, error: { code: 'VALIDATION_INVALID', message: 'unknown', retryable: false } };
    });

    const responses = await new Promise<string[]>((resolve, reject) => {
      const socket = connect(pipeName);
      socket.setEncoding('utf8');
      let buffer = '';
      const lines: string[] = [];
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ protocolVersion: 1, commandId: 'cmd-12345678', method: 'ping', params: {} })}\n`);
        socket.write('this is not json\n');
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let i = buffer.indexOf('\n');
        while (i >= 0) {
          lines.push(buffer.slice(0, i).trim());
          buffer = buffer.slice(i + 1);
          i = buffer.indexOf('\n');
        }
        if (lines.length >= 2) {
          socket.end();
          resolve(lines);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('IPC 响应超时')), 5_000);
    });

    expect(JSON.parse(responses[0]!)).toEqual({ ok: true, data: 'pong' });
    expect(JSON.parse(responses[1]!)).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
    await handle.close();
  });
});

describe('FIX-1 附加：锁与租约修复后的基础回归', () => {
  it('单实例锁：同进程顺序互斥/释放/陈旧接管仍通过', () => {
    const dir = join(tmpRoot, 'basic-lock');
    const first = acquireSingletonLock(dir);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstHandle = first.value;
    expect(acquireSingletonLock(dir)).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    firstHandle.release();
    expect(acquireSingletonLock(dir).ok).toBe(true);
  });
});

describe('收口1：单实例锁受控时间窗口（目录协议）', () => {
  it('活持有者 → BUSY；释放后可获取', () => {
    const dir = join(tmpRoot, 'lockdir-alive');
    writeLockDirForTest(dir, { pid: process.pid, startedAt: Date.now() });
    expect(acquireSingletonLock(dir)).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
  });

  it('死持有者 → 原子接管成功', () => {
    const dir = join(tmpRoot, 'lockdir-dead');
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    const r = acquireSingletonLock(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(readSingletonLock(dir)?.pid).toBe(process.pid);
      r.value.release();
    }
  });

  it('claim 存在且接管者活着 → 保守 BUSY（真实竞争窗口，同步点注入）', () => {
    const dir = join(tmpRoot, 'lockdir-claim');
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    // 受控同步点：claim 成功后、rename 前挂起——模拟接管者 A 卡在窗口内。
    const acquired = acquireSingletonLock(dir, {
      onBeforeClaimArchive: () => {
        // 窗口内第二获取：应看到 claim（身份=本进程，活）并 BUSY。
        const second = acquireSingletonLock(dir);
        expect(second).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
      },
    });
    expect(acquired.ok).toBe(true);
    if (acquired.ok) acquired.value.release();
  });

  it('claim 持有者已死（接管者崩溃）→ 清理 claim 后可再接管', () => {
    const dir = join(tmpRoot, 'lockdir-deadclaim');
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    preclaimLockForTest(dir, 999999998); // 崩溃的接管者
    const r = acquireSingletonLock(dir);
    expect(r.ok).toBe(true);
    if (r.ok) r.value.release();
  });

  it('双进程并发接管死锁：恰好一个成功（真实子进程）', async () => {
    const dir = join(tmpRoot, 'lockdir-race-' + Date.now());
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    const run = (): Promise<{ ok: boolean }> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ['--experimental-strip-types', 'tests/fixtures/lockRaceWorker.ts', dir],
          { cwd: process.cwd(), timeout: 15_000 },
          (error, stdout) => {
            if (error != null && !stdout) {
              reject(error);
              return;
            }
            const line = stdout.trim().split(String.fromCharCode(10)).pop() ?? '';
            try {
              resolve(JSON.parse(line) as { ok: boolean });
            } catch {
              reject(new Error(`无法解析子进程输出: ${line}`));
            }
          },
        );
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a, b].filter((r) => r.ok).length).toBe(1);
  }, 30_000);
});

describe('修复轮4：锁未知身份保守化 + 代次安全接管', () => {
  it('身份写入前暂停（无宽限参数、任意时长）：竞争者仍不能获得第二把锁', () => {
    const dir = join(tmpRoot, 'lockdir-r4-identity');
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    const acquired = acquireSingletonLock(dir, {
      onBeforeClaimIdentity: () => {
        // 模拟暂停任意时长（超任何旧宽限）后，竞争者仍 BUSY——身份缺失≠死亡。
        const second = acquireSingletonLock(dir);
        expect(second).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
        expect((second as { error?: { message?: string } }).error?.message).toContain('身份');
      },
    });
    expect(acquired.ok).toBe(true);
    if (acquired.ok) acquired.value.release();
  });

  it('身份读取失败/半写入不能开放接管：claim 与 owner 均保守 BUSY（不论多久）', () => {
    const dir = join(tmpRoot, 'lockdir-r4-unreadable');
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    // claim 半写入（半截 JSON）。
    mkdirSync(join(dir, 'daemon.lock.d', 'claim'), { recursive: true });
    writeFileSync(join(dir, 'daemon.lock.d', 'claim', 'claimer.json'), '{"pid": 9', 'utf8');
    utimesSync(join(dir, 'daemon.lock.d', 'claim'), new Date(Date.now() - 300_000), new Date(Date.now() - 300_000));
    const r = acquireSingletonLock(dir);
    expect(r).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    // owner 半写入同规则。
    const dir2 = join(tmpRoot, 'lockdir-r4-owner-unreadable');
    mkdirSync(join(dir2, 'daemon.lock.d'), { recursive: true });
    writeFileSync(join(dir2, 'daemon.lock.d', 'owner.json'), '{"pid": 1', 'utf8');
    utimesSync(join(dir2, 'daemon.lock.d'), new Date(Date.now() - 300_000), new Date(Date.now() - 300_000));
    const r2 = acquireSingletonLock(dir2);
    expect(r2).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    // 归档未被自动删除（不自动破坏锁）。
    expect(existsSync(join(dir, 'daemon.lock.d', 'claim'))).toBe(true);
  });

  it('清理者确认死 claim 后被替换：代次校验放弃启动，不删新接管者的 claim', () => {
    const dir = join(tmpRoot, 'lockdir-r4-cleanrace');
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    preclaimLockForTest(dir, 999999998); // 崩溃接管者（死身份）
    // 清理者 A 读到死身份 999999998 后、归档 rename 前暂停；
    // 窗口内 claim 被新接管者 B（活 pid=测试父进程）替换。
    const r = acquireSingletonLock(dir, {
      onBeforeDeadClaimArchive: () => {
        writeFileSync(join(dir, 'daemon.lock.d', 'claim', 'claimer.json'), JSON.stringify({ pid: process.ppid, at: Date.now() }), 'utf8');
      },
    });
    // A 的代次校验发现归档内容（B）≠ 所确认（999999998）：还原归档、放弃启动。
    expect(r).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    expect((r as { error?: { message?: string } }).error?.message).toContain('替换');
    // B 的 claim 原样保留（未被删除/归档丢弃）。
    const claimer = JSON.parse(readFileSync(join(dir, 'daemon.lock.d', 'claim', 'claimer.json'), 'utf8')) as { pid: number };
    expect(claimer.pid).toBe(process.ppid);
  });

  it('已确认死亡的 claim（身份可读且死）：归档清理后可再接管', () => {
    const dir = join(tmpRoot, 'lockdir-r4-deadclaim');
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    preclaimLockForTest(dir, 999999998); // 崩溃接管者（身份完整可读）
    const r = acquireSingletonLock(dir);
    expect(r.ok).toBe(true);
    if (r.ok) r.value.release();
  });

  it('双进程并发接管死锁：恰好一个成功（真实子进程）', async () => {
    const dir = join(tmpRoot, 'lockdir-r4-race-' + Date.now());
    writeLockDirForTest(dir, { pid: 999999999, startedAt: 0 });
    const run = (): Promise<{ ok: boolean }> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ['--experimental-strip-types', 'tests/fixtures/lockRaceWorker.ts', dir],
          { cwd: process.cwd(), timeout: 15_000 },
          (error, stdout) => {
            if (error != null && !stdout) {
              reject(error);
              return;
            }
            const line = stdout.trim().split(String.fromCharCode(10)).pop() ?? '';
            try {
              resolve(JSON.parse(line) as { ok: boolean });
            } catch {
              reject(new Error(`无法解析子进程输出: ${line}`));
            }
          },
        );
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a, b].filter((r2) => r2.ok).length).toBe(1);
  }, 30_000);
});

describe('收口3：adapter.interrupt 永不返回时宽限仍生效', () => {
  it('挂起的 interrupt 不阻塞宽限计时：到点按 UNKNOWN 收尾，不挂死', async () => {
    const db = openMem();
    makeTask(db, 9);
    const adapter = new FakeRuntimeAdapter({ turnScripts: [stuckTurn(60_000)], hangInterrupt: true });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w1', turnDeadlineMs: 80, interruptGraceMs: 150 });
    const startedAt = Date.now();
    await worker.runOnce();
    const elapsed = Date.now() - startedAt;
    expect(db.prepare("SELECT status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)").get('task_9')).toMatchObject({ status: 'UNKNOWN' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE task_id = ?').get('task_9')).toMatchObject({ status: 'INTERRUPTED' });
    // 宽限生效：总时长 ≈ deadline+grace（+少量调度余量），远小于挂起的 interrupt。
    expect(elapsed).toBeLessThan(1_500);
    await adapter.closeAllSessions();
    db.close();
  });
});
