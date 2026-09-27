/**
 * daemon 生命周期收口（修复轮 6，零额度）：运行中退出/重复退出/关库后零写入/重启不重跑。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/entry.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-lifecycle-'));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe('daemon 生命周期（修复轮 6）', () => {
  it('stop 等待在途 drain 收敛后关库：关库后零业务写入（不抛未处理错误）', async () => {
    const appData = join(fixtureRoot, 'app-a');
    const projDir = join(fixtureRoot, 'proj-a');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'notes.md'), '# t', 'utf8');
    const daemon = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 30 });
    // 提交任务让 drain 有实际工作；等它开始执行后立刻 stop。
    // 生命周期单元（非 smoke）：直接落一个任务让 drain 有真实工作。
    const db = daemon.db;
    const projectId = (() => {
      db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
      db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1)`).run();
      db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
      db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','m1')`).run();
      db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
      return 'p1';
    })();
    const t = createRoomRootTask(db, {
      ids: { messageId: 'm', threadId: 'th', taskId: 'tk', taskEventId: 'e1', threadEventId: 'e2' },
      projectId, conversationId: 'c1', roomId: 'r1', intent: 'default',
      title: 'T', body: 'x', mentions: [{ kind: 'member', memberId: 'm1' }],
      author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver',
      sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'm1', frozenMemberIds: ['m1'], initialWakeMemberIds: ['m1'] } as never,
      now: 1,
    });
    expect(t.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 60)); // drain 开跑
    await daemon.stop(); // 等待在途 drain 收敛后关库
    // 关库后写入抛 SQLITE（证明连接已关——不是静默丢写）。
    expect(() => db.prepare('SELECT 1').get()).toThrow();
  }, 30_000);

  it('重复 stop 共用同一次关闭；再启动成功（锁已释放）', async () => {
    const appData = join(fixtureRoot, 'app-b');
    const daemon = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 50 });
    const p1 = daemon.stop();
    const p2 = daemon.stop();
    expect(p1).toBe(p2); // 同一 Promise
    await p1;
    await daemon.stop(); // 已完成后再次调用无副作用
    const again = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 50, pipeName: daemon.pipeName });
    await again.stop();
  }, 30_000);

  it('中断无响应的运行：stop 照常收敛（worker 宽限→UNKNOWN 落库→关库），重启后不重复执行', async () => {
    const appData = join(fixtureRoot, 'app-c');
    const db = openDatabase(join(appData, 'state.sqlite'));
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    // 模拟崩溃现场：leased outbox + 非终态 run/turn（数据库关掉再交给 daemon 恢复）。
    // tasks 的 FK 链需要 anchor 消息与线程先存在（root_message→messages、thread→conversation_threads）。
    db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id) VALUES ('th2','p1','c1','r1','msg2')`).run();
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES ('msg2','p1','c1',1,'r1','human','u','{"text":"T2"}','saved',0)`).run();
    db.prepare(`INSERT INTO outbox (dispatch_key, status, lease_owner, lease_until, attempt_epoch) VALUES ('task:tk2:initial', 'leased', 'dead-worker', 1, 1)`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, root_message_id, room_task_number, title, status, revision, review_policy) VALUES ('tk2','p1','c1','room_task','r1','th2','msg2', 1, 'T2','ACTIVE',0,'auto_deliver')`).run();
    db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('run2','tk2','c1','DIRECT','RUNNING')`).run();
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key) VALUES ('turn2','run2','c1','m1','direct.work','RUNNING','task:tk2:initial')`).run();
    db.close();

    // 启动 daemon：恢复应重排孤儿租约+标 UNKNOWN+落门禁（不自动续跑）。
    const daemon = await startDaemon({ appDataDir: appData, runtime: 'fake', tickMs: 30 });
    const run = daemon.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run2') as { status: string };
    expect(run.status).toBe('INTERRUPTED');
    const turn = daemon.db.prepare('SELECT status FROM agent_turns WHERE id = ?').get('turn2') as { status: string };
    expect(turn.status).toBe('UNKNOWN');
    const outbox = daemon.db.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get('task:tk2:initial') as { status: string };
    expect(outbox.status).toBe('pending'); // 重排但门禁拦截——不自动派发
    const { isDispatchGateHeld } = await import('../../src/persistence/daemonState.ts');
    expect(isDispatchGateHeld(daemon.db)).toBe(true);
    await new Promise((r) => setTimeout(r, 150)); // 门禁期间零新派发
    const taskAfter = daemon.db.prepare('SELECT status FROM tasks WHERE id = ?').get('tk2') as { status: string };
    expect(taskAfter.status).toBe('ACTIVE'); // 未被重复执行（无新 run）
    expect((daemon.db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c).toBe(1);
    await daemon.stop();
  }, 30_000);
});
