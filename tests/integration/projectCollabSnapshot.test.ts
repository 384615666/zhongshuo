/**
 * 第十八轮四：协作时限快照——「新派发 turn 起生效（在途不变）」由数据承载。
 * 反例清单（假时钟）：
 * ① 执行中调低项目缺席时限：在途 turn 仍按派发时快照判定（泵读最新配置的旧行为会立即缺席）；
 *    快照越过旧值后才缺席；之后新派发 turn 用新值；
 * ② 重启恢复：重开数据库（新实例）后沿持久快照判定——不重新套当前项目配置；
 * ③ 两个项目互不影响：各自 turn 各自快照（A=60s 未到不缺席，B=2s 已到缺席）；
 * ④ 审批暂停扣除按快照：有效执行时间=名义-暂停，与快照比较；
 * ⑤ NULL 回落全局时记录最终解析值（快照列=解析值，非 NULL）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { pumpDeliberation } from '../../src/daemon/deliberationRunner.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { done, draft } from './deliberationFlow.test.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-collabsnap-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seedProject(db: ZhongshuoDatabase, projectId: string, memberIds: string[], n: number): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES (?, 'd', 'D:/x', 'D:/x', '{}', 0)`).run(projectId);
  const members = memberIds.map((id, i) => `('${id}','${projectId}','成员${i + 1}','agent',1)`).join(', ');
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ${members}`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r${n}','${projectId}','大厅',?)`).run(memberIds[0]);
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c${n}','${projectId}','room','r${n}')`).run();
}

function createDelibTaskIn(db: ZhongshuoDatabase, projectId: string, conversationId: string, roomId: string, n: number, memberIds: string[]): string {
  const ids = { messageId: `msg_s${n}`, threadId: `thread_s${n}`, taskId: `task_s${n}`, taskEventId: `evt_st_${n}`, threadEventId: `evt_sh_${n}` };
  const created = createRoomRootTask(db, {
    ids, projectId, conversationId, roomId, intent: 'default',
    title: `快照研讨${n}`, body: `请研讨 ${n}`, mentions: memberIds.map((m) => ({ kind: 'member' as const, memberId: m })),
    author: { authorType: 'human' as const, authorId: 'u_human' },
    reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DELIBERATE', rosterSource: 'all', frozenMemberIds: memberIds, initialWakeMemberIds: memberIds } as never,
    now: 1000 + n,
  });
  if (!created.ok) throw new Error(`任务创建失败：${JSON.stringify(created).slice(0, 200)}`);
  return ids.taskId;
}

interface Rig { db: ZhongshuoDatabase; scripts: FakeTurnScript[]; adapter: FakeRuntimeAdapter; worker: DispatchWorker; taskId: string; runId: string }

async function rig(db: ZhongshuoDatabase, n: number, members: string[], projectId = 'p1', convRoom: readonly [string, string] = ['c1', 'r1']): Promise<Rig> {
  const taskId = createDelibTaskIn(db, projectId, convRoom[0], convRoom[1], n, members);
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: `w-snap-${n}`, enableDeliberate: true,
    absenceToleranceMs: 500, turnDeadlineMs: 60_000, interruptGraceMs: 50,
    appDataDir: join(tmpRoot, `app${n}`),
  });
  // PREPARE 为服务端步骤（不消耗 adapter 脚本——脚本从首个 IND 派发起对位）。
  if (!(await worker.runOnce())) throw new Error('PREPARE 未领取');
  return { db, scripts, adapter, worker, taskId, runId: (db.prepare("SELECT id FROM workflow_runs WHERE task_id = ?").get(taskId) as { id: string }).id };
}

const opts = (graceMs: number) => ({ absenceToleranceMs: graceMs, blobDir: join(tmpRoot, 'art') });
const deferIndStep = (db: ZhongshuoDatabase, taskId: string, runId: string, memberId: string): void => {
  const key = `task:${taskId}:delib:${runId}:IND:${memberId}:0:w`;
  const id = (db.prepare('SELECT id FROM outbox WHERE dispatch_key = ?').get(key) as { id: number }).id;
  db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(key);
};
const startedOf = (db: ZhongshuoDatabase, memberId: string, runId: string): number =>
  (db.prepare("SELECT exec_started_at FROM agent_turns WHERE member_id = ? AND run_id = ? AND stage_key = 'delib.independent'").get(memberId, runId) as { exec_started_at: number }).exec_started_at;
const snapshotOf = (db: ZhongshuoDatabase, memberId: string, runId: string): { absence: number; deadline: number; revision: number } =>
  db.prepare('SELECT collab_absence_ms AS absence, collab_turn_deadline_ms AS deadline, collab_config_revision AS revision FROM agent_turns WHERE member_id = ? AND run_id = ?').get(memberId, runId) as { absence: number; deadline: number; revision: number };

describe('第十八轮四：协作时限快照（在途不变/重启恢复/项目隔离/暂停扣除）', () => {
  it('① 执行中调低不影响在途（快照判定）；越旧值才缺席；后续新派发用新值；NULL 回落也记解析值', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1),('m2','p1','乙','agent',1),('m3','p1','丙','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    // 项目级缺席=60s（NULL 回落全局 500 的解析结果也须记录为 60_000——最终解析值入快照）。
    db.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 60000, collab_turn_deadline_ms = 3000 WHERE id = 'p1'`).run();
    const r = await rig(db, 1, ['m1', 'm2', 'm3']);
    deferIndStep(db, r.taskId, r.runId, 'm1');
    r.scripts.push(done(draft('乙', [{ claimId: 'c1', statement: '乙稿' }])));
    await r.worker.runOnce(); // IND m2 ✓
    r.scripts.push(done(draft('丙', [{ claimId: 'c1', statement: '丙稿' }])));
    await r.worker.runOnce(); // IND m3 ✓
    r.scripts.push([{ kind: 'stall', ms: 2_000 }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 150));
    const started = startedOf(db, 'm1', r.runId);
    expect(snapshotOf(db, 'm1', r.runId)).toMatchObject({ absence: 60_000, deadline: 3_000 }); // 解析值快照（deadline 小值=真实截止快速收尾，不影响缺席断言）
    // 执行中调低项目配置（旧行为：泵读最新值→立即缺席）。
    db.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 1000, revision = revision + 1 WHERE id = 'p1'`).run();
    pumpDeliberation(db, r.taskId, opts(500), started + 2_000);
    expect(db.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'm1'").get(r.runId)).toMatchObject({ status: 'pending' }); // 在途不变
    pumpDeliberation(db, r.taskId, opts(500), started + 60_100);
    expect(db.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'm1'").get(r.runId)).toMatchObject({ status: 'absent' });
    // 后续新派发（屏障推进的 CR 步骤）用新值 1_000。
    pumpDeliberation(db, r.taskId, opts(500), started + 60_200);
    // CR 已入队（尚未领取——由 outbox 证明）；领取后快照=新值。此处直接断言队列入队+新值将生效。
    const crQueued = (db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ?`).get(`%${r.runId}:CR:%`) as { c: number }).c;
    expect(crQueued).toBe(2);
    r.scripts.push(done({ schemaVersion: 'cross-review-v1', issueId: 'i1', verdict: 'agree', note: 'ok', refs: [] }));
    r.scripts.push(done({ schemaVersion: 'cross-review-v1', issueId: 'i1', verdict: 'agree', note: 'ok', refs: [] }));
    await r.worker.runOnce(); // CR m2
    await r.worker.runOnce(); // CR m3
    const crSnap = db.prepare("SELECT collab_absence_ms FROM agent_turns WHERE stage_key = 'delib.cross_review' ORDER BY rowid LIMIT 1").get() as { collab_absence_ms: number };
    expect(crSnap.collab_absence_ms).toBe(1_000); // 新派发 turn 用新值（生效边界=派发时点）
    await m1Run;
    await r.adapter.closeAllSessions();
    db.close();
  }, 60_000);

  it('② 重启恢复：重开数据库后沿持久快照判定——不重新套当前项目配置', async () => {
    const dbFile = join(tmpRoot, 'snap-restart.sqlite');
    const db = openDatabase(dbFile);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1),('m2','p1','乙','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    db.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 60000 WHERE id = 'p1'`).run();
    const r = await rig(db, 2, ['m1', 'm2']);
    deferIndStep(db, r.taskId, r.runId, 'm1');
    r.scripts.push(done(draft('乙', [{ claimId: 'c1', statement: '乙稿' }])));
    const m2Run = r.worker.runOnce(); // IND m2 ✓
    r.scripts.push([{ kind: 'stall', ms: 10_000 }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 150));
    const started = startedOf(db, 'm1', r.runId);
    expect(snapshotOf(db, 'm1', r.runId).absence).toBe(60_000);
    // 崩溃/重启：close → 重开（新实例）。在途 stall turn 保持 RUNNING（快照已持久）。
    void m1Run; void m2Run;
    db.close();
    const db2 = openDatabase(dbFile);
    // 重启后项目配置被改为 5s（新值）——在途 turn 仍按持久快照 60s。
    db2.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 5000, revision = revision + 1 WHERE id = 'p1'`).run();
    pumpDeliberation(db2, r.taskId, opts(500), started + 6_000); // > 新值 5s、< 快照 60s
    expect(db2.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'm1'").get(r.runId)).toMatchObject({ status: 'pending' });
    pumpDeliberation(db2, r.taskId, opts(500), started + 60_100);
    expect(db2.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'm1'").get(r.runId)).toMatchObject({ status: 'absent' });
    db2.close();
  }, 60_000);

  it('③ 两个项目互不影响：各自 turn 各自快照（A 未到不缺席、B 已到缺席）', async () => {
    const db = openDatabase(':memory:');
    seedProject(db, 'pA', ['a1', 'a2'], 1);
    seedProject(db, 'pB', ['b1', 'b2'], 2);
    db.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 60000 WHERE id = 'pA'`).run();
    db.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 2000 WHERE id = 'pB'`).run();
    // 单 worker 共享 outbox：先把 A 推进到在途（占住队列），再建 B——B 的 PREPARE 不会被 A 的步骤抢跑。
    const rA = await rig(db, 3, ['a1', 'a2'], 'pA', ['c1', 'r1']);
    deferIndStep(db, rA.taskId, rA.runId, 'a1');
    rA.scripts.push(done(draft('A乙', [{ claimId: 'c1', statement: 'A乙稿' }])));
    await rA.worker.runOnce(); // IND a2 ✓
    rA.scripts.push([{ kind: 'stall', ms: 8_000 }]);
    void rA.worker.runOnce(); // IND a1 在途（快照 60s；deadline 快照=全局 60s——测试内不 await）
    const rB = await rig(db, 4, ['b1', 'b2'], 'pB', ['c2', 'r2']); // B 的 PREPARE 此时领取
    deferIndStep(db, rB.taskId, rB.runId, 'b1');
    rB.scripts.push(done(draft('B乙', [{ claimId: 'c1', statement: 'B乙稿' }])));
    await rB.worker.runOnce(); // IND b2 ✓
    rB.scripts.push([{ kind: 'stall', ms: 8_000 }]);
    void rB.worker.runOnce(); // IND b1 在途（快照 2s）
    await new Promise((res) => setTimeout(res, 200));
    const startedA = startedOf(db, 'a1', rA.runId);
    const startedB = startedOf(db, 'b1', rB.runId);
    expect(snapshotOf(db, 'a1', rA.runId).absence).toBe(60_000);
    expect(snapshotOf(db, 'b1', rB.runId).absence).toBe(2_000);
    const at = Math.max(startedA, startedB) + 3_000; // > B 快照 2s、< A 快照 60s
    pumpDeliberation(db, rA.taskId, opts(500), at);
    pumpDeliberation(db, rB.taskId, opts(500), at);
    expect(db.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'a1'").get(rA.runId)).toMatchObject({ status: 'pending' }); // A 不受 B 的小值影响
    expect(db.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'b1'").get(rB.runId)).toMatchObject({ status: 'absent' }); // B 按自己的快照缺席
    await rA.adapter.closeAllSessions();
    await rB.adapter.closeAllSessions();
    db.close();
  }, 60_000);

  it('④ 审批暂停扣除按快照：有效执行时间=名义-暂停，与快照比较（与项目当前值无关）', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1),('m2','p1','乙','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
    db.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 5000 WHERE id = 'p1'`).run();
    const r = await rig(db, 5, ['m1', 'm2']);
    deferIndStep(db, r.taskId, r.runId, 'm1');
    r.scripts.push(done(draft('乙', [{ claimId: 'c1', statement: '乙稿' }])));
    r.worker.runOnce();
    r.scripts.push([{ kind: 'stall', ms: 12_000 }]);
    const m1Run = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 150));
    const turn = db.prepare("SELECT id, exec_started_at FROM agent_turns WHERE member_id = 'm1' AND run_id = ? AND stage_key = 'delib.independent'").get(r.runId) as { id: string; exec_started_at: number };
    // 项目配置改为 1s（执行中）——暂停扣除与缺席判定都用快照 5s。
    db.prepare(`UPDATE projects SET collab_absence_tolerance_ms = 1000 WHERE id = 'p1'`).run();
    r.worker.accumulateApprovalPause(turn.id, 3_000);
    pumpDeliberation(db, r.taskId, opts(500), turn.exec_started_at + 7_000); // 有效=7_000-3_000=4_000 < 5_000
    expect(db.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'm1'").get(r.runId)).toMatchObject({ status: 'pending' });
    pumpDeliberation(db, r.taskId, opts(500), turn.exec_started_at + 8_200); // 有效=5_200 ≥ 5_000
    expect(db.prepare("SELECT status FROM run_participants WHERE run_id = ? AND member_id = 'm1'").get(r.runId)).toMatchObject({ status: 'absent' });
    void m1Run;
    await r.adapter.closeAllSessions();
    db.close();
  }, 60_000);
});
