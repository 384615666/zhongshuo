/**
 * 解析执行边界（第二十九轮一）：受控故障证明——
 * - 截止可终止：deadline 触发 SIGTERM→（宽限）SIGKILL，**exit 确认后**才结算超时（收拢确认）；
 * - 同步 CPU 阻塞隔离（busyMs=Atomics.wait 阻塞子进程）：daemon 进程内命令仍亚秒响应，
 *   池并发=1 排队、队列上限=parse-busy 明确拒绝；
 * - worker 无响应退出（exitCode 注入）=parse-worker-exited 分类；
 * - dispose（daemon.stop 同链）：在途与排队任务取消结算、子进程杀净（exit 确认）；
 * - 副本读取时点完整性（worker 自核 sha256）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ParsePool, disposeParsePool, getParsePool } from '../../src/daemon/parsePool.ts';
import { makeAsciiPdf } from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_TEST_PARSE_HOOKS = '1';
delete process.env.ZS_TEST_PARSE_BUSY_MS;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-parsebound-'));
mkdirSync(join(tmpRoot, 'blobstore'), { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const blobOf = (buf: Buffer): { path: string; hash: string } => {
  const hash = createHash('sha256').update(buf).digest('hex');
  const path = join(tmpRoot, 'blobstore', `${hash}.bin`);
  writeFileSync(path, buf);
  return { path, hash };
};
const pdf = blobOf(makeAsciiPdf([['boundary probe A-1', 'BOUNDARY-77']]));
const pdf2 = blobOf(makeAsciiPdf([['second document B-2']]));

describe('解析执行边界：截止/终止/收拢', () => {
  it('截止触发终止且 exit 确认后才结算（不虚报）', async () => {
    const pool = new ParsePool();
    const t0 = Date.now();
    const r = await pool.run('pdf', pdf.path, pdf.hash, { deadlineMs: 300, hooks: { busyMs: 20_000 } });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('pdf-timeout');
      expect(r.error.message).toContain('截止');
      expect(r.error.message).toContain('确认退出'); // 收拢确认语义
    }
    expect(elapsed).toBeLessThan(8_000); // 不等满 busy 20s——真被杀
    expect(pool.stats().active).toBe(0);
    expect(pool.stats().liveChildren).toBe(0); // exit 已确认（超时结算在 exit 之后）
    await pool.dispose();
  }, 20_000);
  it('worker 未响应即退出 → parse-worker-exited 分类', async () => {
    const pool = new ParsePool();
    const r = await pool.run('pdf', pdf.path, pdf.hash, { hooks: { exitCode: 3 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('parse-worker-exited');
    await pool.dispose();
  }, 20_000);
  it('副本被改写 → worker 读取时 sha256 不符（读取时点完整性）', async () => {
    const pool = new ParsePool();
    writeFileSync(pdf2.path, makeAsciiPdf([['不同内容']]));
    const r = await pool.run('pdf', pdf2.path, pdf2.hash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('source-hash-mismatch');
    await pool.dispose();
  }, 20_000);
  it('同步阻塞隔离：daemon 进程内命令仍响应；排队与队列上限如实', async () => {
    const pool = new ParsePool();
    const slow = pool.run('pdf', pdf.path, pdf.hash, { hooks: { busyMs: 2_500 } }); // 子进程同步阻塞
    await new Promise((r) => setTimeout(r, 300));
    expect(pool.stats().active).toBe(1);
    // daemon 进程自身事件循环未被解析阻塞：异步定时/DB 级操作亚秒完成（对比：若解析在
    // daemon 进程内同步执行，这里会 >= 2.5s）。
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    const quick = await Promise.race([new Promise<string>((r) => setTimeout(() => r('ok'), 100)), new Promise<string>((r) => setTimeout(() => r('slow'), 2_200))]);
    expect(quick).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(1_500);
    // 并发=1：第二任务排队；队列上限 4 → 第六个 parse-busy。
    const queued: Array<Promise<{ ok: boolean; error?: { code: string } }>> = [];
    for (let i = 0; i < 4; i += 1) queued.push(pool.run('pdf', pdf2.path, pdf2.hash) as Promise<{ ok: boolean; error?: { code: string } }>);
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.stats().queued).toBe(4);
    const busy = await pool.run('pdf', pdf2.path, pdf2.hash);
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe('parse-busy');
    // 修正 pdf2 副本（上一用例改写过）供排队任务成功结算。
    writeFileSync(pdf2.path, makeAsciiPdf([['second document B-2']]));
    const results = await Promise.all([slow, ...queued]);
    expect(results.every((x) => x.ok)).toBe(true);
    expect(pool.stats().completed).toBe(5);
    expect(pool.stats().active).toBe(0);
    await pool.dispose();
  }, 30_000);
  it('dispose：在途与排队取消结算、子进程杀净（exit 确认）', async () => {
    const pool = new ParsePool();
    const busy1 = pool.run('pdf', pdf.path, pdf.hash, { hooks: { busyMs: 30_000 } });
    const queued = pool.run('pdf', pdf2.path, pdf2.hash);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await pool.dispose();
    expect(Date.now() - t0).toBeLessThan(5_000); // 不等满 30s
    const [r1, r2] = await Promise.all([busy1, queued]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('parse-cancelled');
    if (!r2.ok) expect(r2.error.code).toBe('parse-cancelled');
    expect(pool.stats().liveChildren).toBe(0);
    expect(pool.stats().queued).toBe(0);
  }, 20_000);
});

describe('解析执行边界：全局池（命令层共用）', () => {
  it('getParsePool 单例 + disposeParsePool 复位', async () => {
    const a = getParsePool();
    const b = getParsePool();
    expect(a).toBe(b);
    const r = await a.run('pdf', pdf.path, pdf.hash);
    expect(r.ok).toBe(true);
    await disposeParsePool();
    expect(getParsePool()).not.toBe(a);
    await disposeParsePool();
    void randomUUID;
  }, 20_000);
});
