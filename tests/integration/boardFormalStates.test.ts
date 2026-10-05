/**
 * DEV-19 看板状态映射（第二十七轮五修正）——**正式链造数**验证六形态：
 * 完成任务（DONE→已完成列）、待验收（REVIEW+交付绑定）、运行中、运行中停止（STOPPING→停止列）、
 * 退出未确认（applyRecovery：run INTERRUPTED+turn UNKNOWN——来自 turn/恢复事实，非 run 状态机
 * 不存在的 UNKNOWN）、恢复后新运行（提醒跟进派发——历史 stop_generation>0 不再恒落停止列）。
 * 阻塞=模式门禁（@全体研讨→DELIBERATE→BLOCKED——正式 worker 路径）。
 * 全程断言：查询/切换看板零新增 run/turn/real_calls；files.view 四类分列+audience（他人 DM
 * 附件不进集合；私信资源标注 dm；项目文件/草稿/交付逐项保留来源与定位）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { ReminderScheduler } from '../../src/daemon/reminderScheduler.ts';
import { applyRecovery } from '../../src/daemon/stopFlow.ts';
import { openDispatchGate } from '../../src/persistence/daemonState.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-boardfm-'));
mkdirSync(join(tmpRoot, 'app'), { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

interface Card { taskId: string; title: string; column: string; taskStatus: string; runStatus: string | null; runId: string | null; stopGeneration: number; exitUnconfirmed: boolean; pendingDelivery: { revision: number } | null; locate: string }

function makeEnv(opts: { review?: boolean } = {}) {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  if (opts.review === true) db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run('p1');
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
  const cmd = async <T,>(method: string, params: unknown): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `bfm-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => scripts.shift() ?? validDone() });
  const worker = () => new DispatchWorker({ db, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: join(tmpRoot, 'app') });
  const submit = (body: string, mentions: unknown[] = [{ kind: 'member', memberId: 'mA' }]) =>
    cmd<{ taskId: string; threadId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body, intent: 'default', mentions });
  const board = async () => {
    const data = await cmd<{ groups: Array<{ rooms: Array<{ cards: Card[] }> }> }>('board.view', { scope: 'project', projectId: 'p1' });
    return data.groups[0]!.rooms[0]!.cards;
  };
  const counts = () => ({
    runs: (db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c,
    turns: (db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c,
  });
  return { db, cmd, scripts, worker, submit, board, counts, close: () => { void adapter.closeAllSessions().catch(() => {}); db.close(); } };
}

describe('看板状态映射（正式链六形态）', () => {
  it('完成任务=已完成列；待验收=待验收列+交付绑定；查询看板零新增 run/turn', async () => {
    const env = makeEnv(); // auto_deliver
    const t1 = await env.submit('直接完成的任务');
    await env.worker().runOnce();
    const t2env = makeEnv({ review: true });
    const t2 = await t2env.submit('待验收任务');
    await t2env.worker().runOnce();
    const cards1 = await env.board();
    expect(cards1.find((c) => c.taskId === t1.taskId)).toMatchObject({ column: 'done', taskStatus: 'DONE', exitUnconfirmed: false }); // 旧实现落 waiting 的缺陷
    const before = env.counts();
    await env.board(); // 再查（切换/刷新）
    expect(env.counts()).toEqual(before); // 看板零运行零调用
    const cards2 = await t2env.board();
    const review = cards2.find((c) => c.taskId === t2.taskId)!;
    expect(review.column).toBe('review');
    expect(review.taskStatus).toBe('REVIEW');
    expect(review.pendingDelivery?.revision).toBeGreaterThanOrEqual(1); // 交付绑定（最高 pending）
    env.close();
    t2env.close();
  });

  it('运行中停止：STOPPING→停止列；崩溃恢复=退出未确认（run INTERRUPTED+turn UNKNOWN）', async () => {
    const env = makeEnv({ review: true }); // 非终态：停止/恢复后仍可新派发
    const t = await env.submit('要停止的长任务');
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    void env.worker().runOnce(); // 派发进入在途
    await new Promise((r) => setTimeout(r, 150));
    let cards = await env.board();
    expect(cards.find((c) => c.taskId === t.taskId)).toMatchObject({ column: 'running' }); // 运行中
    // 运行中停止（正式 task.stop：固定 run/代次）。
    const runId = (env.db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(t.taskId) as { id: string }).id;
    await env.cmd('task.stop', { taskId: t.taskId, targetRunId: runId, expectedStopGeneration: 0 });
    cards = await env.board();
    expect(cards.find((c) => c.taskId === t.taskId)).toMatchObject({ column: 'stopped', runStatus: 'STOPPING' }); // 停止中如实
    // 崩溃恢复（正式 applyRecovery）：在途→UNKNOWN、run→INTERRUPTED——退出未确认来自 turn/恢复事实。
    applyRecovery(env.db, Date.now());
    cards = await env.board();
    const c = cards.find((x) => x.taskId === t.taskId)!;
    expect(c.runStatus).toBe('INTERRUPTED');
    expect(c.exitUnconfirmed).toBe(true); // turn UNKNOWN 事实（非 run 状态机不存在的 UNKNOWN）
    expect(c.column).toBe('stopped');
    env.close();
  });

  it('恢复后新运行（提醒跟进派发）：历史 stop_generation>0 照常列执行中', async () => {
    const env = makeEnv({ review: true });
    const t = await env.submit('停止后再被提醒唤醒的任务');
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    void env.worker().runOnce();
    await new Promise((r) => setTimeout(r, 150));
    const runId = (env.db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(t.taskId) as { id: string }).id;
    await env.cmd('task.stop', { taskId: t.taskId, targetRunId: runId, expectedStopGeneration: 0 });
    applyRecovery(env.db, Date.now()); // 停止不响应→UNKNOWN/INTERRUPTED；任务仍 ACTIVE；stop_generation=1
    openDispatchGate(env.db, Date.now()); // 用户确认继续（恢复门禁）
    // r57（准入继承）：UNKNOWN turn 持久占用成员准入——确认继续≠退出证明。跟进派发前先正式
    // 收口旧 turn（对账 executed→no-os-process 服务端取证→释放），新运行才可启动。
    const stoppedTurn = (env.db.prepare('SELECT id FROM agent_turns WHERE run_id = ?').get(runId) as { id: string }).id;
    await env.cmd('recovery.reconcile', { turnId: stoppedTurn, verdict: 'executed', note: '测试：停止中断的跟进前置对账（no-os-process）' });
    // 合法新派发：绑定线程的提醒到点自动跟进（第二十五轮三：历史停止代次不永久禁止）。
    const clock = { now: Date.now() };
    await env.cmd('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId: t.threadId, ownerMemberId: 'mA', title: '跟进唤醒', schedule: { kind: 'once', at: clock.now + 60_000 }, autoDispatch: true });
    const scheduler = new ReminderScheduler({ db: env.db, now: () => clock.now });
    clock.now += 61_000;
    const out = scheduler.tick();
    expect(out.fired[0]!.outcome).toBe('dispatched');
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    // 第一次 runOnce 消耗在对账重领（applyRecovery 重排的原 initial 意图——RT-03：已有 turn
    // 的重领标 failed 留审计）；第二次领取提醒跟进意图→新 run 在途。
    await env.worker().runOnce();
    env.scripts.push([{ kind: 'stall', ms: 60_000 }]);
    void env.worker().runOnce();
    await new Promise((r) => setTimeout(r, 150));
    const cards = await env.board();
    const c = cards.find((x) => x.taskId === t.taskId)!;
    expect(c.stopGeneration).toBeGreaterThanOrEqual(1); // 历史停止代次仍在
    expect(c.runStatus).toBe('RUNNING'); // 最新 run=跟进执行
    expect(c.column).toBe('running'); // 旧实现 stop_generation>0 恒落 stopped 的缺陷
    expect(c.exitUnconfirmed).toBe(false); // 新运行在途≠退出未确认
    env.close();
  });

  it('阻塞=模式门禁（@全体研讨→DELIBERATE→BLOCKED，正式 worker 路径）', async () => {
    const env = makeEnv();
    const t = await env.submit('研讨任务', [{ kind: 'all' }]);
    await env.worker().runOnce();
    const cards = await env.board();
    expect(cards.find((c) => c.taskId === t.taskId)).toMatchObject({ column: 'blocked', taskStatus: 'BLOCKED' });
    env.close();
  });
});

describe('files.view（Files 集合四类分列）', () => {
  it('托管附件/交付/草稿逐项保留来源+hash+定位；他人 DM 不进集合；私信标注；项目文件为目录本身', async () => {
    const env = makeEnv({ review: true });
    // 房间任务+交付+附件（正式链）。
    const t = await env.submit('带交付的任务');
    const up = await env.cmd<{ attachmentId: string; hash: string }>('attachment.uploadText', { conversationId: 'conv_room', filename: '交付 依据.md', content: '依据内容 FILES-6677' });
    await env.cmd('message.submit', { target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room', threadId: t.threadId }, body: '附件在根消息之外再挂一份', intent: 'record_only', mentions: [], attachmentRefs: [up.attachmentId] });
    await env.worker().runOnce(); // REVIEW+交付
    // 我的 DM 附件（进集合但标注 dm——仅本人可见）；他人 DM 附件（不进集合）。
    const myDm = await env.cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    await env.cmd('attachment.uploadText', { conversationId: myDm.conversationId, filename: '私信 附件.txt', content: '私信内容' });
    env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_dm_other','p1','dm',NULL)`).run();
    env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm_other','human','u_other'),('p1','conv_dm_other','agent','mA')`).run();
    const otherUp = await (async () => {
      const deps = { db: env.db, localUserId: 'u_other', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `bfm-o-${randomUUID().slice(0, 8)}`, method: 'attachment.uploadText', params: { conversationId: 'conv_dm_other', filename: '他人 私密.txt', content: '他人内容' } }) as { ok: boolean; data?: { attachmentId: string }; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message);
      return r.data!;
    })();
    void otherUp;
    const files = await env.cmd<{ groups: Array<{ projectFiles: Array<{ name: string }>; projectFilesNote: string | null; attachments: Array<{ attachmentId: string; filename: string; hash: string; audience: string; locate: string | null }>; drafts: unknown[]; deliveries: Array<{ deliveryId: string; revision: number; taskId: string; audience: string; locate: string }> }> }>('files.view', { scope: 'project', projectId: 'p1' });
    const g = files.groups[0]!;
    const attNames = g.attachments.map((a) => a.filename);
    expect(attNames).toContain('交付 依据.md');
    expect(attNames).toContain('私信 附件.txt'); // 本人参与的 DM 资源进集合
    expect(g.attachments.find((a) => a.filename === '私信 附件.txt')!.audience).toBe('dm'); // 标注私信（不因聚合扩大可见性语义）
    expect(attNames).not.toContain('他人 私密.txt'); // 他人 DM 零泄露
    expect(g.attachments.every((a) => a.hash.length === 64)).toBe(true); // hash 保留
    expect(g.deliveries.length).toBeGreaterThanOrEqual(1); // 交付成果（正式链产生）
    expect(g.deliveries[0]!.locate).toMatch(/^#delivery=/);
    expect(Array.isArray(g.drafts)).toBe(true); // Agent 草稿（本场景无变更集=空——分列仍在）
    expect(g.projectFiles.length).toBeGreaterThan(0); // 项目文件=项目目录本身（tmp 根有 app/ 等）
    // 纯读：查询前后 run/turn 不变。
    const before = env.counts();
    await env.cmd('files.view', { scope: 'project', projectId: 'p1' });
    expect(env.counts()).toEqual(before);
    env.close();
  });
});
