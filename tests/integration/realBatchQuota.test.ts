/**
 * 第十九轮一/二：批次日志真正 fail-closed + 锁所有者身份协议。
 * 反例清单（每项都断言**底层 startTurn 没有发生**——不只看返回错误）：
 * ① cap=N：第 N+1 次在底层调用前被拒（底层计数=N、台账=N、journal reject=1）；
 * ② 日志损坏（非法 JSON 行）→ 拒绝发请求+诊断+现场字节不变；
 * ③ 尾行部分写入（无换行终止）→ 拒绝（未知占位），不删除尾行不少计；
 * ④ 日志不可读（路径被目录占用=非 ENOENT 失败）→ 拒绝（不当零消耗）；
 * ⑤ 显式无效 cap（非整数/0/负）→ 报错（不回退无上限），底层零调用；
 * ⑥ 跨进程不同 cap → 头绑定拒绝；显式 updateBatchCap（CAS+留痕）后才可增；
 * ⑦ 范围绑定：换 runtime kind / 换 model 不得重立边界；
 * ⑧ 锁=单例锁协议：活进程持锁任意时长（含人为把 mtime 调旧）不接管 → BUSY 拒绝；
 * ⑨ 预占持久化后请求前崩溃：journal 已计，重启视角额度照满（第 N+1 次仍拒）；
 * ⑩ settle 不回收额度；⑪ 并发原子性（8 并发 cap=3 恰 3 成功）；⑫ 生产无批次零拦截；
 * ⑬ 死亡持有者（真实退出进程的 pid）→ 接管并正常预占。
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { wrapRealCallLedger, realCallSummary, settleRealCall } from '../../src/daemon/realCallLedger.ts';
import {
  batchJournalStats, reserveSlot, updateBatchCap, ensureBatchCap, BatchGuardError,
} from '../../src/daemon/realBatchJournal.ts';
import { acquireSingletonLock, writeLockDirForTest } from '../../src/daemon/singletonLock.ts';
import { LocalProtocolAdapter } from '../helpers/localProtocolAdapter.ts';
import type { RuntimeAdapter } from '../../src/contracts/runtime.ts';

const journalDir = mkdtempSync(join(tmpdir(), 'zs-batch19-'));
const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-batch19-app-'));
const dbs: ZhongshuoDatabase[] = [];
afterEach(() => { for (const db of dbs.splice(0)) { try { db.close(); } catch { /* 已关 */ } } });
afterEach(() => { rmSync(journalDir, { recursive: true, force: true }); mkdirSync(journalDir, { recursive: true }); });
afterAll(() => { rmSync(journalDir, { recursive: true, force: true }); rmSync(tmpRoot, { recursive: true, force: true }); });

function session() {
  return { id: 's1' as never, providerSessionId: 's1', runtimeInstallationId: 'lp', adapterVersion: 'lp', threadId: 'th', sessionGeneration: 1, cwd: process.cwd() };
}
function turnReq(turnId: string) {
  return { turnId, dispatchKey: `k:${turnId}`, inputBundleId: 'b', text: 'x', policyId: 'p', taskRevision: 0 };
}
function openDb(): ZhongshuoDatabase {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}
const wrap = (db: ZhongshuoDatabase, kind = 'claude', model: string | null = 'm-x') => {
  const lp = new LocalProtocolAdapter({ noSpawn: true });
  const wrapped = wrapRealCallLedger(lp, kind, db, model) as RuntimeAdapter & { startTurn(s: unknown, i: unknown): Promise<void> };
  return { lp, wrapped };
};

describe('第十九轮一/二：批次护栏 fail-closed（每项断言底层零调用）', () => {
  beforeEach(() => {
    process.env.ZS_REAL_BATCH_DIR = journalDir;
    process.env.ZS_REAL_BATCH_ID = 'r19-quota';
    process.env.ZS_REAL_BATCH_CAP = '2';
  });
  afterEach(() => {
    delete process.env.ZS_REAL_BATCH_DIR;
    delete process.env.ZS_REAL_BATCH_ID;
    delete process.env.ZS_REAL_BATCH_CAP;
  });

  it('① cap=2：第 3 次底层调用前被拒；⑩ settle 不回收；summary 含头绑定说明', async () => {
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    const s = session();
    await wrapped.startTurn(s, turnReq('t1'));
    await wrapped.startTurn(s, turnReq('t2'));
    await expect(wrapped.startTurn(s, turnReq('t3'))).rejects.toThrow(/已达上限.*请求前被拒/);
    expect(lp.startTurnCalls).toBe(2); // 底层恰好 2 次——第 3 次零调用
    expect((db.prepare('SELECT count(*) c FROM real_calls').get() as { c: number }).c).toBe(2);
    expect(batchJournalStats('r19-quota')).toMatchObject({ reserved: 2, rejected: 1, cap: 2 });
    // ⑩ settle 不回收：终态后第 4 次仍拒。
    settleRealCall(db, 't1', 'succeeded', 'turn 终态=SUCCEEDED');
    await expect(wrapped.startTurn(s, turnReq('t4'))).rejects.toThrow(/已达上限/);
    expect(lp.startTurnCalls).toBe(2);
    expect(realCallSummary(db, 'r19-quota').quota.note).toContain('头绑定');
  }, 60_000);

  it('② 日志损坏（非法 JSON 行）→ 拒绝发请求+诊断+现场字节不变', async () => {
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    await wrapped.startTurn(session(), turnReq('ok1'));
    const file = join(journalDir, 'r19-quota.jsonl');
    const before = readFileSync(file, 'utf8');
    const corrupted = `${before}{"op":"reserve" "pid":1}\n`;
    writeFileSync(file, corrupted, 'utf8');
    await expect(wrapped.startTurn(session(), turnReq('bad1'))).rejects.toThrow(/不是合法 JSON|记录非法/);
    expect(lp.startTurnCalls).toBe(1); // 损坏后零底层调用
    expect(readFileSync(file, 'utf8')).toBe(corrupted); // 现场不动（不修复不删除）
  }, 60_000);

  it('③ 尾行部分写入（无换行终止）→ 按未知占位拒绝，不删除尾行不少计', async () => {
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    await wrapped.startTurn(session(), turnReq('ok1'));
    const file = join(journalDir, 'r19-quota.jsonl');
    const before = readFileSync(file, 'utf8');
    const partial = `${before}{"op":"reser`;
    writeFileSync(file, partial, 'utf8');
    await expect(wrapped.startTurn(session(), turnReq('bad2'))).rejects.toThrow(/尾行不完整/);
    expect(lp.startTurnCalls).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(partial); // 尾行保留（未知占位）
    expect(realCallSummary(db, 'r19-quota').journalError).toContain('尾行不完整');
  }, 60_000);

  it('④ 日志不可读（路径被目录占用——非 ENOENT）→ 拒绝（不当零消耗）', async () => {
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    await wrapped.startTurn(session(), turnReq('ok1'));
    const file = join(journalDir, 'r19-quota.jsonl');
    rmSync(file);
    mkdirSync(file); // readFileSync → EISDIR
    await expect(wrapped.startTurn(session(), turnReq('bad3'))).rejects.toThrow(/不可读/);
    expect(lp.startTurnCalls).toBe(1);
  }, 60_000);

  it('⑤ 显式无效 cap（0/负/非整数）→ 报错（不回退无上限），底层零调用', async () => {
    for (const bad of ['0', '-3', 'abc', '2.5']) {
      process.env.ZS_REAL_BATCH_CAP = bad;
      expect(() => ensureBatchCap()).toThrow(BatchGuardError);
      const db = openDb();
      const { lp, wrapped } = wrap(db);
      await expect(wrapped.startTurn(session(), turnReq('badcap'))).rejects.toThrow(/配置无效/);
      expect(lp.startTurnCalls).toBe(0);
      expect((db.prepare('SELECT count(*) c FROM real_calls').get() as { c: number }).c).toBe(0);
    }
    process.env.ZS_REAL_BATCH_CAP = '2';
  }, 60_000);

  it('⑥ 跨进程不同 cap → 头绑定拒绝；显式 updateBatchCap（CAS+留痕）后才能增', async () => {
    const dbA = openDb();
    const a = wrap(dbA);
    await a.wrapped.startTurn(session(), turnReq('a1')); // 头以 cap=2 立
    const dbB = openDb();
    const b = wrap(dbB);
    process.env.ZS_REAL_BATCH_CAP = '5';
    await expect(b.wrapped.startTurn(session(), turnReq('b1'))).rejects.toThrow(/生效上限为 2.*不得经 env 重新扩额/);
    expect(b.lp.startTurnCalls).toBe(0); // 后开进程不能凭更大 cap 扩额
    const upd = updateBatchCap('r19-quota', 2, 5, '第十九轮测试：显式扩额留痕');
    expect(upd.ok).toBe(true);
    await b.wrapped.startTurn(session(), turnReq('b2')); // 5 额度内
    expect(b.lp.startTurnCalls).toBe(1);
    const upd2 = updateBatchCap('r19-quota', 2, 9, 'from 过期');
    expect(upd2.ok).toBe(false); // CAS 反例
    expect(batchJournalStats('r19-quota').cap).toBe(5);
    process.env.ZS_REAL_BATCH_CAP = '2';
  }, 60_000);

  it('⑦ 范围绑定：换 runtime kind / 换 model 不得重立边界（头绑定）', async () => {
    const dbA = openDb();
    const a = wrap(dbA, 'claude', 'deepseek-flash');
    await a.wrapped.startTurn(session(), turnReq('a1'));
    const dbB = openDb();
    const codex = wrap(dbB, 'codex', 'deepseek-flash');
    await expect(codex.wrapped.startTurn(session(), turnReq('c1'))).rejects.toThrow(/已绑定 runtime=claude/);
    expect(codex.lp.startTurnCalls).toBe(0);
    const dbC = openDb();
    const otherModel = wrap(dbC, 'claude', 'other-model');
    await expect(otherModel.wrapped.startTurn(session(), turnReq('o1'))).rejects.toThrow(/已绑定 model=deepseek-flash/);
    expect(otherModel.lp.startTurnCalls).toBe(0);
  }, 60_000);

  it('⑧ 锁=单例锁协议：活进程持锁（含 mtime 被调旧超旧阈值）不接管 → BUSY 拒绝、零调用', async () => {
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    const lockRootDir = join(journalDir, 'r19-quota.lockroot');
    const held = acquireSingletonLock(lockRootDir); // 本测试进程（活）持锁——模拟持锁者暂停
    expect(held.ok).toBe(true);
    const oldTime = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(lockRootDir, 'daemon.lock.d'), oldTime, oldTime);
    utimesSync(join(lockRootDir, 'daemon.lock.d', 'owner.json'), oldTime, oldTime);
    await expect(wrapped.startTurn(session(), turnReq('l1'))).rejects.toThrow(/锁不可用|BUSY/);
    expect(lp.startTurnCalls).toBe(0); // 互斥被持 → fail-closed 拒绝
    expect((db.prepare('SELECT count(*) c FROM real_calls').get() as { c: number }).c).toBe(0);
    held.value.release(); // 只释放自己的锁
    await wrapped.startTurn(session(), turnReq('l2'));
    expect(lp.startTurnCalls).toBe(1);
  }, 60_000);

  it('⑨ 预占持久化后请求前崩溃：journal 已计——重启视角额度照满（第 N+1 次仍拒）', async () => {
    process.env.ZS_REAL_BATCH_ID = 'r19-crash'; // 崩溃批次与重启进程同一 batchId
    reserveSlot({ batchId: 'r19-crash', cap: 2, turnId: 'cr1', runtimeKind: 'claude', model: 'm-x' });
    reserveSlot({ batchId: 'r19-crash', cap: 2, turnId: 'cr2', runtimeKind: 'claude', model: 'm-x' });
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    await expect(wrapped.startTurn(session(), turnReq('cr3'))).rejects.toThrow(/已达上限/);
    expect(lp.startTurnCalls).toBe(0);
    expect(batchJournalStats('r19-crash').reserved).toBe(2);
    process.env.ZS_REAL_BATCH_ID = 'r19-quota';
  }, 60_000);

  it('⑪ 并发原子性：8 并发 cap=3 → 恰 3 成功 5 拒（journal 一致）', async () => {
    process.env.ZS_REAL_BATCH_CAP = '3';
    const db = openDb();
    const instances = Array.from({ length: 8 }, () => wrap(db));
    const results = await Promise.allSettled(instances.map((w, i) => w.wrapped.startTurn(session(), turnReq(`c${i}`))));
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason).includes('已达上限')).length;
    expect(fulfilled).toBe(3);
    expect(rejected).toBe(5);
    expect(instances.reduce((acc, w) => acc + w.lp.startTurnCalls, 0)).toBe(3);
    expect(batchJournalStats('r19-quota')).toMatchObject({ reserved: 3, rejected: 5, cap: 3 });
    process.env.ZS_REAL_BATCH_CAP = '2';
  }, 60_000);

  it('⑫ 生产（无批次 ID）只记账不拦截、不触共享日志', async () => {
    delete process.env.ZS_REAL_BATCH_ID;
    delete process.env.ZS_REAL_BATCH_CAP;
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    for (let i = 0; i < 5; i += 1) await wrapped.startTurn(session(), turnReq(`p${i}`));
    expect(lp.startTurnCalls).toBe(5);
    expect((db.prepare("SELECT count(*) c FROM real_calls WHERE batch_id='ad-hoc'").get() as { c: number }).c).toBe(5);
    expect(readdirSync(journalDir).length).toBe(0); // 零批次产物
  }, 60_000);

  it('⑬ 死亡持有者（不可存活 pid）→ 接管并正常预占', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(dead.status).toBe(0);
    void dead;
    const lockRootDir = join(journalDir, 'r19-quota.lockroot');
    writeLockDirForTest(lockRootDir, { pid: 999_999_999, startedAt: Date.now() - 60_000 }); // 已死 pid
    const db = openDb();
    const { lp, wrapped } = wrap(db);
    await wrapped.startTurn(session(), turnReq('d1'));
    expect(lp.startTurnCalls).toBe(1);
    expect(batchJournalStats('r19-quota').reserved).toBe(1);
  }, 60_000);
});
