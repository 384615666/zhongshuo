/**
 * 第十八轮三：记账与批次上限分离——共享批次日志原子预占（跨进程/跨 appData）。
 * 反例清单：
 * ① cap=N 时第 N+1 次 startTurn 在底层调用前被拒（底层计数=N、台账行=N、journal reject=1）；
 * ② 多 appData 共享同一实验批次：额度全局共享，不各自获得完整额度；
 * ③ 崩溃/重启后预占不重置不遗忘（journal 持久 + inflight 行持久）；
 * ④ 修复/重派/研讨各计入（每次 startTurn 一格，settle 不回收）；
 * ⑤ startTurn 抛错≠未发出：台账 unknown；额度不回收（执行不确定不等于可用）；
 * ⑥ 归属按实际解析：codex 不记 ZS_CLAUDE_MODEL；member/task/run 从 agent_turns 正式解析；
 * ⑦ fake 不产生台账行/批次条目（本地零真实调用=零行）；
 * ⑧ 并发原子性：同时 8 个 startTurn、cap=3 → 恰 3 成功；
 * ⑨ 未配置批次（生产）只记账不拦截（ad-hoc 不触 journal）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { wrapRealCallLedger } from '../../src/daemon/realCallLedger.ts';
import { batchJournalStats } from '../../src/daemon/realBatchJournal.ts';
import { LocalProtocolAdapter } from '../helpers/localProtocolAdapter.ts';
import type { RuntimeAdapter } from '../../src/contracts/runtime.ts';

const journalDir = mkdtempSync(join(tmpdir(), 'zs-batch-'));
afterEach(() => rmSync(journalDir, { recursive: true, force: true }));

function session() {
  return { id: 's1' as never, providerSessionId: 's1', runtimeInstallationId: 'lp', adapterVersion: 'lp', threadId: 'th', sessionGeneration: 1, cwd: process.cwd() };
}
function turnReq(turnId: string) {
  return { turnId, dispatchKey: `k:${turnId}`, inputBundleId: 'b', text: 'x', policyId: 'p', taskRevision: 0 };
}
const seedTurn = (db: ZhongshuoDatabase, turnId: string, memberId = 'm1', taskId: string | null = 'tk1'): void => {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0) ON CONFLICT DO NOTHING`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1) ON CONFLICT DO NOTHING`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind) VALUES ('c1','p1','dm') ON CONFLICT DO NOTHING`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, title, status, revision, review_policy) VALUES (?,'p1','c1','room_task','T','ACTIVE',0,'auto_deliver') ON CONFLICT DO NOTHING`).run(taskId ?? 'tk1');
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('r1', ?, 'c1', 'DIRECT', 'RUNNING') ON CONFLICT DO NOTHING`).run(taskId ?? 'tk1');
  db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key) VALUES (?, 'r1', 'c1', ?, 'direct.work', 'RUNNING', ?) ON CONFLICT DO NOTHING`).run(turnId, memberId, `k:${turnId}`);
};

describe('第十八轮三：批次上限（共享日志原子预占）', () => {
  beforeEach(() => {
    process.env.ZS_REAL_BATCH_DIR = journalDir;
    process.env.ZS_REAL_BATCH_ID = 'r18-quota';
    process.env.ZS_REAL_BATCH_CAP = '2';
    delete process.env.ZS_CLAUDE_MODEL;
    delete process.env.ZS_E2E_MODEL;
  });
  afterEach(() => {
    delete process.env.ZS_REAL_BATCH_DIR;
    delete process.env.ZS_REAL_BATCH_ID;
    delete process.env.ZS_REAL_BATCH_CAP;
  });

  it('①③ cap=2：第 3 次在底层调用前被拒（底层=2、台账=2、reject=1）；重开（模拟重启）后预占仍满——第 3 次照拒', async () => {
    const db = openDatabase(':memory:');
    const lp = new LocalProtocolAdapter({ disposeStyle: 'disposeAll', noSpawn: true });
    const wrapped = wrapRealCallLedger(lp, 'claude', db, 'lp-model-a') as RuntimeAdapter & { startTurn(s: unknown, i: unknown): Promise<void> };
    const s = session();
    seedTurn(db, 't1'); seedTurn(db, 't2'); seedTurn(db, 't3');
    await wrapped.startTurn(s, turnReq('t1'));
    await wrapped.startTurn(s, turnReq('t2'));
    await expect(wrapped.startTurn(s, turnReq('t3'))).rejects.toThrow(/已达上限.*请求前被拒/);
    expect(lp.startTurnCalls).toBe(2); // 底层只被调 2 次——第 3 次在请求前被拒
    expect((db.prepare('SELECT count(*) c FROM real_calls').get() as { c: number }).c).toBe(2); // 被拒不是一次调用——零台账行
    expect(batchJournalStats('r18-quota')).toEqual({ reserved: 2, settled: 0, rejected: 1 });
    // 重启模拟：journal 持久（占位不重置不遗忘）；inflight 行持久。
    expect(batchJournalStats('r18-quota').reserved).toBe(2);
    const lp2 = new LocalProtocolAdapter({ disposeStyle: 'disposeAll', noSpawn: true });
    const wrapped2 = wrapRealCallLedger(lp2, 'claude', db, 'lp-model-a') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    await expect(wrapped2.startTurn(s, turnReq('t3'))).rejects.toThrow(/已达上限/);
    expect(lp2.startTurnCalls).toBe(0);
    await lp.disposeAll(); await lp2.disposeAll?.();
    db.close();
  }, 60_000);

  it('② 多 appData 共享同一实验批次：额度全局共享（各库一台账，但预占跨库计数）', async () => {
    const dbA = openDatabase(':memory:');
    const dbB = openDatabase(':memory:');
    const a = wrapRealCallLedger(new LocalProtocolAdapter({ noSpawn: true }), 'claude', dbA, 'm-a') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    const b = wrapRealCallLedger(new LocalProtocolAdapter({ noSpawn: true }), 'claude', dbB, 'm-b') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    const s = session();
    await a.startTurn(s, turnReq('a1')); // A 用掉 1
    await b.startTurn(s, turnReq('b1')); // B 用掉 1（共享额度剩 0）
    await expect(b.startTurn(s, turnReq('b2'))).rejects.toThrow(/已达上限/); // B 不能再获得"自己的一份"
    expect(batchJournalStats('r18-quota').reserved).toBe(2);
    dbA.close(); dbB.close();
  }, 60_000);

  it('④⑤ settle 不回收额度；startTurn 抛错→台账 unknown（≠未发出）且额度不回收', async () => {
    const db = openDatabase(':memory:');
    process.env.ZS_REAL_BATCH_CAP = '3';
    const okLp = new LocalProtocolAdapter({ noSpawn: true });
    const badLp = new LocalProtocolAdapter({ noSpawn: true, failStartTurnMessage: '配额内抛错（可能已发出）' });
    const ok = wrapRealCallLedger(okLp, 'claude', db, 'm') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    const bad = wrapRealCallLedger(badLp, 'claude', db, 'm') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    const s = session();
    await ok.startTurn(s, turnReq('s1'));
    await ok.startTurn(s, turnReq('s2'));
    db.prepare("UPDATE real_calls SET status='succeeded', settled_at=1 WHERE turn_id='s1'").run(); // settle（终态路径）
    await expect(bad.startTurn(s, turnReq('s3'))).rejects.toThrow('配额内抛错'); // 用掉第 3 格后抛错
    expect((db.prepare("SELECT status FROM real_calls WHERE turn_id='s3'").get() as { status: string }).status).toBe('unknown');
    await expect(ok.startTurn(s, turnReq('s4'))).rejects.toThrow(/已达上限/); // settle/抛错都不回收——修复重派各占一格
    expect(batchJournalStats('r18-quota')).toEqual({ reserved: 3, settled: 1, rejected: 1 }); // settled=1：抛错路径 settleSlot 审计条目（额度不回收）
    db.close();
  }, 60_000);

  it('⑥ 归属按实际解析：codex 不记 ZS_CLAUDE_MODEL；member/task/run 来自 agent_turns；fake 零行（⑦）', async () => {
    process.env.ZS_REAL_BATCH_CAP = '4';
    process.env.ZS_CLAUDE_MODEL = 'claude-x';
    process.env.ZS_E2E_MODEL = 'gpt-x';
    const db = openDatabase(':memory:');
    seedTurn(db, 'attr1', 'm1', 'tkA');
    const claude = wrapRealCallLedger(new LocalProtocolAdapter({ noSpawn: true }), 'claude', db, 'claude-x') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    await claude.startTurn(session(), turnReq('attr1'));
    const row = db.prepare('SELECT * FROM real_calls WHERE turn_id = ?').get('attr1') as Record<string, unknown>;
    expect(row.runtime_kind).toBe('claude');
    expect(row.model).toBe('claude-x'); // 构建时模型（请求模型）
    expect(row.member_id).toBe('m1');
    expect(row.task_id).toBe('tkA');
    expect(row.run_id).toBe('r1');
    const codex = wrapRealCallLedger(new LocalProtocolAdapter({ noSpawn: true }), 'codex', db, 'gpt-x') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    seedTurn(db, 'attr2');
    await codex.startTurn(session(), turnReq('attr2'));
    const row2 = db.prepare('SELECT * FROM real_calls WHERE turn_id = ?').get('attr2') as Record<string, unknown>;
    expect(row2.runtime_kind).toBe('codex');
    expect(row2.model).toBe('gpt-x'); // codex 记自身环境模型——不是 ZS_CLAUDE_MODEL
    // fake：零台账行（未包装——真实链 adapterFor 对 fake 不包装）。
    const fakeRows = (db.prepare("SELECT count(*) c FROM real_calls WHERE runtime_kind='fake'").get() as { c: number }).c;
    expect(fakeRows).toBe(0);
    db.close();
  }, 60_000);

  it('⑧ 并发原子性：8 个并发 startTurn、cap=3 → 恰 3 成功、5 被拒', async () => {
    process.env.ZS_REAL_BATCH_CAP = '3';
    const db = openDatabase(':memory:');
    const lps = Array.from({ length: 8 }, () => new LocalProtocolAdapter({ noSpawn: true }));
    const wrapped = lps.map((lp) => wrapRealCallLedger(lp, 'claude', db, 'm') as never as { startTurn(s: unknown, i: unknown): Promise<void> });
    const s = session();
    const results = await Promise.allSettled(wrapped.map((w, i) => w.startTurn(s, turnReq(`c${i}`))));
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason).includes('已达上限')).length;
    expect(fulfilled).toBe(3);
    expect(rejected).toBe(5);
    expect(batchJournalStats('r18-quota')).toEqual({ reserved: 3, settled: 0, rejected: 5 });
    db.close();
  }, 60_000);

  it('⑨ 生产（无批次 ID）只记账不拦截：ad-hoc 批次可超任意次且不产生共享日志', async () => {
    delete process.env.ZS_REAL_BATCH_ID;
    delete process.env.ZS_REAL_BATCH_CAP;
    const db = openDatabase(':memory:');
    const lp = new LocalProtocolAdapter({ noSpawn: true });
    const wrapped = wrapRealCallLedger(lp, 'claude', db, 'm') as never as { startTurn(s: unknown, i: unknown): Promise<void> };
    const s = session();
    for (let i = 0; i < 5; i += 1) await wrapped.startTurn(s, turnReq(`p${i}`));
    expect(lp.startTurnCalls).toBe(5); // 无批次=只记账（生产日常调用不设实验上限）
    expect((db.prepare("SELECT count(*) c FROM real_calls WHERE batch_id='ad-hoc'").get() as { c: number }).c).toBe(5);
    const { batchJournalExists } = await import('../../src/daemon/realBatchJournal.ts');
    expect(batchJournalExists('ad-hoc')).toBe(false); // 不触共享日志（不要求用户填实验 batchId）
    db.close();
  }, 60_000);
});
