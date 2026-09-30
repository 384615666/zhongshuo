/**
 * 第十七轮二：成员停用覆盖完整派发路径（与「停用后不参与之后派发」声明一致）。
 *
 * 反例四时点（用户指定）：提交后领取前（DIRECT）/研讨两阶段之间（冻结名单步骤）/修复入队后/
 * 在途成员停用后正常完成。断言真实 adapter 启动计数（CountingAdapter.startTurn）、阶段推进、
 * 预算与参与者状态——不只查 enabled 字段。另：文件库重开持久化（旧 memberEnabled 内存库用例
 * 不能声称已验重启）。重新启用不重放已收口旧步骤。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { TurnRequest } from '../../src/contracts/runtime.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { randomUUID } from 'node:crypto';
import { seed, createDelibTask, done, draft, runIdOf, step } from './deliberationFlow.test.ts';
import { successTurn } from '../../src/adapter/fake/script.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-mendisable-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
process.env.ZS_ALLOW_FAKE = '1';

/** 计数 adapter：真实启动边界= startTurn 调用（含成员身份——经 TurnRequest.turnId 对账）。 */
class CountingAdapter extends FakeRuntimeAdapter {
  starts = 0;
  startedInputs: TurnRequest[] = [];
  override async startTurn(session: Parameters<FakeRuntimeAdapter['startTurn']>[0], input: Parameters<FakeRuntimeAdapter['startTurn']>[1]): Promise<void> {
    this.starts += 1;
    this.startedInputs.push(input);
    return super.startTurn(session, input);
  }
}

function setEnabled(db: ZhongshuoDatabase, memberId: string, enabled: boolean): Promise<unknown> {
  return dispatchDaemonCommand(
    { db, localUserId: 'u_me', interruptTurn: async () => {} },
    { protocolVersion: 1, commandId: `md-${randomUUID()}`, method: 'member.setEnabled', params: { memberId, enabled } },
  );
}

interface Rig { db: ZhongshuoDatabase; scripts: FakeTurnScript[]; adapter: CountingAdapter; worker: DispatchWorker; taskId: string; runId: string }
async function rig(db: ZhongshuoDatabase, n: number, members: string[]): Promise<Rig> {
  const taskId = createDelibTask(db, n, members);
  const scripts: FakeTurnScript[] = [];
  const adapter = new CountingAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: `w${n}`, enableDeliberate: true, absenceToleranceMs: 60_000,
    turnDeadlineMs: 20_000, interruptGraceMs: 50, appDataDir: join(tmpRoot, `app${n}`),
  });
  await step(worker, scripts); // PREPARE
  return { db, scripts, adapter, worker, taskId, runId: runIdOf(db) };
}
const participant = (db: ZhongshuoDatabase, runId: string, memberId: string) =>
  db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?').get(runId, memberId) as { status: string } | undefined;

describe('成员停用完整派发路径（第十七轮二）', () => {
  it('①提交后领取前（DIRECT）：阻塞留证+零 startTurn+审计；启用后经命令面续跑', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['mA', 'mX']);
    db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA'),('r1','mX')`).run();
    db.prepare(`UPDATE projects SET task_review_enabled = 0`).run(); // 自动交付（DONE 断言不受验收挡）
    const deps = { db, localUserId: 'u_me', interruptTurn: async () => {} };
    const submit = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `md-${randomUUID()}`, method: 'message.submit', params: { target: { kind: 'room_root', projectId: 'p1', conversationId: 'c1', roomId: 'r1' }, body: '排队任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mX' }] } }) as { ok: boolean; data?: { taskId: string } };
    expect(submit.ok).toBe(true);
    await setEnabled(db, 'mX', false);
    const scripts: FakeTurnScript[] = [];
    const adapter = new CountingAdapter({ turnScriptSequencer: () => scripts.shift() ?? successTurn() });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'wD1', appDataDir: join(tmpRoot, 'appD1') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(submit.data!.taskId) as { status: string }).status).toBe('BLOCKED');
    expect(adapter.starts).toBe(0); // 真实启动边界计数=0
    const audited = db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'task.memberDisabledBlocked'`).get() as { c: number };
    expect(audited.c).toBeGreaterThanOrEqual(1);
    // 重新启用 → 经正式命令续跑（不自动重放）。
    await setEnabled(db, 'mX', true);
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `md-${randomUUID()}`, method: 'task.redispatch', params: { taskId: submit.data!.taskId, reason: '成员已重新启用' } });
    scripts.push(successTurn());
    for (let i = 0; i < 6 && (await worker.runOnce()); i += 1);
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(submit.data!.taskId) as { status: string }).status).toBe('DONE');
    expect(adapter.starts).toBe(1);
    db.close();
  }, 30_000);

  it('②研讨两阶段之间：IND 完成后停用 m2 → 其 CROSS_REVIEW 步骤按 unavailable 收口（零 startTurn），屏障推进不卡死；重启用不重放', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const r = await rig(db, 1, ['m1', 'm2']);
    const startsAfterInd = r.adapter.starts;
    // IND：两成员各一稿（m1/m2 各 1 start）。
    r.scripts.push(done(draft('甲', [{ claimId: 'c1', statement: '甲稿' }])));
    await step(r.worker, r.scripts);
    r.scripts.push(done(draft('乙', [{ claimId: 'c1', statement: '乙稿' }])));
    await step(r.worker, r.scripts);
    expect(r.adapter.starts).toBe(startsAfterInd + 2);
    const stageAfterInd = (db.prepare("SELECT stage FROM workflow_runs WHERE id = ?").get(r.runId) as { stage: string }).stage;
    expect(stageAfterInd).not.toBe('INDEPENDENT'); // 屏障已推进（进入互评或后续）
    // 两阶段之间停用 m2 → 其后续冻结名单步骤不再派发。
    await setEnabled(db, 'm2', false);
    // 推进剩余可派发步骤（m2 的步骤领取即收口；m1 照常）。脚本兜底=合法各阶段输出。
    let guard = 0;
    while (guard < 30) {
      guard += 1;
      const more = await r.worker.runOnce();
      if (!more) break;
    }
    // m2 在停用后零新 startTurn：对账其全部 turn 均创建于停用前（IND 阶段）。
    const m2Turns = db.prepare(`SELECT t.id, t.stage_key FROM agent_turns t WHERE t.member_id = 'm2'`).all() as Array<{ id: string; stage_key: string }>;
    expect(m2Turns.every((t) => t.stage_key.startsWith('delib.independent'))).toBe(true);
    // run 不卡死：非 INDEPENDENT 阶段已推进或到达终态（不再停在等 m2 的互评）。
    const runNow = db.prepare("SELECT stage, status FROM workflow_runs WHERE id = ?").get(r.runId) as { stage: string; status: string };
    expect(runNow.stage).not.toBe('INDEPENDENT');
    expect(['RUNNING', 'WAITING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']).toContain(runNow.status);
    // 参与者状态=unavailable（屏障语义）+ 审计留痕。
    const p2 = participant(db, r.runId, 'm2');
    expect(p2?.status).toBe('unavailable'); // 停用席位=屏障终结语义（不永远等待）
    const skipAudited = db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'run.memberDisabledSkip' AND json_extract(payload_json, '$.memberId') = 'm2'`).get() as { c: number };
    expect(skipAudited.c).toBeGreaterThanOrEqual(1);
    // 重新启用不重放：pump+runOnce 不为 m2 产生停用后新 turn。
    await setEnabled(db, 'm2', true);
    let guard2 = 0;
    while (guard2 < 20) { guard2 += 1; if (!(await r.worker.runOnce())) break; }
    const m2After = db.prepare(`SELECT count(*) c FROM agent_turns WHERE member_id = 'm2'`).get() as { c: number };
    expect(m2After.c).toBe(m2Turns.length); // 无重放新 turn
    db.close();
  }, 90_000);

  it('③修复入队后停用：修复步骤领取即收口（不消费修复工作项、零 startTurn）', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const r = await rig(db, 2, ['m1', 'm2']);
    // 手工构造 m2 的修复入队（生产路径=turn.outputInvalid 后 enqueue；此处直接建键——同一 parse/领取面）。
    // 注：m1 为 seed 默认协调者不可停用——用 m2。
    db.prepare('DELETE FROM outbox').run(); // 排空在队步骤——本用例只考察修复键领取面
    const repairKey = `task:${r.taskId}:delib:${r.runId}:RPR:m2:0:IND`;
    db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(repairKey);
    await setEnabled(db, 'm2', false);
    const startsBefore = r.adapter.starts;
    let claimed = false;
    for (let i = 0; i < 8; i += 1) {
      const ran = await r.worker.runOnce();
      if (!ran) break;
      claimed = true;
      break; // 只消费一项（该修复项或其前无关项）
    }
    void claimed;
    expect(r.adapter.starts).toBe(startsBefore); // 修复步骤零 startTurn
    const repairTurn = db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(repairKey);
    expect(repairTurn).toBeUndefined(); // 未创建 turn
    db.close();
  }, 60_000);

  it('④在途成员停用后正常完成：turn 照常 SUCCEEDED，不被隐式停止', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const r = await rig(db, 3, ['m1', 'm2']);
    // m1 IND stall 在途 → 停用 → 脚本继续完成。
    r.scripts.push([{ kind: 'stall', ms: 600 }, ...([] as FakeTurnScript).concat(done(draft('甲', [{ claimId: 'c1', statement: '甲稿' }])) as never)]);
    const inflight = r.worker.runOnce();
    await new Promise((res) => setTimeout(res, 150)); // 等 turn 落库在途
    const m1Turn = db.prepare(`SELECT id, status FROM agent_turns WHERE member_id = 'm1' AND stage_key LIKE 'delib.independent%' ORDER BY rowid DESC LIMIT 1`).get() as { id: string; status: string } | undefined;
    expect(m1Turn?.status).toBe('RUNNING');
    await setEnabled(db, 'm1', false);
    await inflight; // 停用不影响在途执行
    const m1After = db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(m1Turn!.id) as { status: string };
    expect(m1After.status).toBe('SUCCEEDED');
    db.close();
  }, 60_000);

  it('⑤文件库重开持久化（补 memberEnabled 内存库用例缺口）', async () => {
    const path = join(tmpRoot, 'reopen', 'state.sqlite');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpRoot, 'reopen'), { recursive: true });
    const db = openDatabase(path);
    seed(db, ['mA', 'mX']);
    db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA'),('r1','mX')`).run();
    await setEnabled(db, 'mX', false);
    db.close();
    const db2 = openDatabase(path);
    expect((db2.prepare('SELECT enabled FROM project_members WHERE id = ?').get('mX') as { enabled: number }).enabled).toBe(0);
    await setEnabled(db2, 'mX', true);
    db2.close();
    const db3 = openDatabase(path);
    expect((db3.prepare('SELECT enabled FROM project_members WHERE id = ?').get('mX') as { enabled: number }).enabled).toBe(1);
    db3.close();
  }, 30_000);
});
