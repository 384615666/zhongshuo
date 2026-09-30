/**
 * 实验批次共享日志（第十八轮三：把调用记账与批次上限分开实现）。
 *
 * real_calls 是**台账**（每 appData 一份，记录实际请求与归属）——不含额度拦截。批次硬上限
 * 需要**跨进程/跨 appData**的预占计数：同一实验批次的额度全局共享，不能每个进程各自获得
 * 完整额度。本模块是用户级（homedir）追加式 JSONL 日志 + 锁目录互斥：
 *
 * - reserveSlot：**检查+占位在同一锁内原子完成**——已预占数 ≥ cap 时拒绝并记 reject 条目
 *   （不产生 real_calls 行——被拒=零请求）；否则追加 reserve（此后崩溃也不重置/遗忘）；
 * - settleSlot/rejectSlot：审计条目（不回收额度——修复/重派/研讨步骤各占一格，用完即计）；
 * - 锁=<批次>.lock 目录（mkdir 原子；持锁崩溃>30s 视为陈旧可破）；条目 append+fsync；
 * - 日志不可用（目录建不了/锁拿不到）且批次配置了上限 → **fail-closed**：宁可拒绝调用，
 *   不在无法核对额度时放行真实请求。
 *
 * 生产路径（未设 ZS_REAL_BATCH_ID）完全不触本模块——普通用户使用产品无须实验 batchId。
 * 测试隔离：ZS_REAL_BATCH_DIR 覆盖目录（默认 ~/.zhongshuo-real-batches）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface BatchJournalEntry {
  op: 'reserve' | 'settle' | 'reject';
  pid: number;
  at: number;
  turnId?: string;
  note?: string;
}

export interface BatchJournalStats {
  reserved: number;
  settled: number;
  rejected: number;
}

export function batchJournalDir(): string {
  return process.env.ZS_REAL_BATCH_DIR ?? join(homedir(), '.zhongshuo-real-batches');
}

export function configuredBatchCap(): number | null {
  const raw = process.env.ZS_REAL_BATCH_CAP;
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function batchFile(batchId: string): string {
  const safe = /^[\w.-]+$/.test(batchId) ? batchId : createHash('sha256').update(batchId).digest('hex').slice(0, 16);
  return join(batchJournalDir(), `${safe}.jsonl`);
}

function readEntries(file: string): BatchJournalEntry[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as BatchJournalEntry);
  } catch {
    return []; // 不存在=空日志（首条由 reserve 创建）
  }
}

function appendEntry(file: string, entry: BatchJournalEntry): void {
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8'); // append+行缓冲；写后由调用方 fsync 不必（锁内单写者，崩溃最坏丢最后一条=保守少计一格，方向安全）
}

/** 锁目录互斥（mkdir 原子）；持锁进程崩溃遗留的锁按 mtime 陈旧判定可破。 */
async function withLock<T>(batchId: string, fn: () => Promise<T>): Promise<T> {
  const dir = batchJournalDir();
  for (let attempt = 0; ; attempt += 1) {
    try { mkdirSync(dir, { recursive: true }); break; } catch (error) {
      if (attempt >= 8) throw new Error(`批次日志目录不可用（${dir}）：${error instanceof Error ? error.message : String(error)}`);
      await sleep(50);
    }
  }
  const lockDir = join(dir, `${/^[\w.-]+$/.test(batchId) ? batchId : 'x'}.lock`);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      // 已被占：陈旧判定（持锁者崩溃遗留 >30s）→ 破锁重试；否则等待。
      try {
        const st = statSync(lockDir);
        if (Date.now() - st.mtimeMs > 30_000) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* 锁刚被释放——直接重试 mkdir */ }
      if (Date.now() > deadline) throw new Error(`批次日志锁获取超时（${lockDir}）——fail-closed，不在无法核对额度时放行`);
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 尽力释放；陈旧判定兜底 */ }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ReserveResult {
  ok: boolean;
  reserved: number; // 本次判定时的已预占数（含本次则 +1）
  cap: number | null;
}

/**
 * 原子检查+占位。cap=null（未配置上限）→ 只记审计条目不拦截（记账与上限分离：批次未配上限
 * 时仍可只记账）。返回 ok=false 时调用方必须在底层 adapter 调用前拒绝。
 */
export async function reserveSlot(batchId: string, cap: number | null, turnId: string): Promise<ReserveResult> {
  const file = batchFile(batchId);
  return withLock(batchId, async () => {
    const entries = readEntries(file);
    const reserved = entries.filter((e) => e.op === 'reserve').length;
    if (cap != null && reserved >= cap) {
      appendEntry(file, { op: 'reject', pid: process.pid, at: Date.now(), turnId, note: `已达上限 ${cap}（预占 ${reserved}）` });
      return { ok: false, reserved, cap };
    }
    appendEntry(file, { op: 'reserve', pid: process.pid, at: Date.now(), turnId });
    return { ok: true, reserved: reserved + 1, cap };
  });
}

/** 审计条目（不回收额度）。 */
export async function settleSlot(batchId: string, turnId: string, note: string): Promise<void> {
  const file = batchFile(batchId);
  await withLock(batchId, async () => {
    appendEntry(file, { op: 'settle', pid: process.pid, at: Date.now(), turnId, note: note.slice(0, 120) });
  });
}

export function batchJournalStats(batchId: string): BatchJournalStats {
  const entries = readEntries(batchFile(batchId));
  return {
    reserved: entries.filter((e) => e.op === 'reserve').length,
    settled: entries.filter((e) => e.op === 'settle').length,
    rejected: entries.filter((e) => e.op === 'reject').length,
  };
}

export function batchJournalExists(batchId: string): boolean {
  return existsSync(batchFile(batchId));
}
