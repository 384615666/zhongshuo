/**
 * 实验批次共享日志（第十八轮三建立；第十九轮一/二重写为真正 fail-closed）。
 *
 * real_calls 是**台账**（每 appData 一份）；批次硬上限需要**跨进程/跨 appData**的预占计数，
 * 本模块是用户级（homedir）追加式 JSONL 日志：
 *
 * 结构：首行必为 batch-config 头（绑定 cap 与 runtime/模型范围）；其后为
 * reserve/settle/reject/cap-update 记录。额度与范围**持久绑定在头**——后开的进程不能凭
 * 更大的 cap 重新扩额（BOUND_MISMATCH）；合法增额必须走 updateBatchCap（显式、留痕）。
 *
 * fail-closed 语义（第十九轮一）：
 * - 只有 ENOENT 才初始化新日志；权限错误/占用/目录冲突/损坏 JSON/非法记录/缺失换行的
 *   部分尾行 → **拒绝发请求**并保留诊断（不删除、不修复、不少计额度）；
 * - 崩溃丢行=少计额度=**超额风险方向（不安全）**——写入用 open+write+fsync+close 实做
 *   持久化（注释与实现一致）；
 * - 显式配置无效 cap（ZS_REAL_BATCH_CAP 非正整数）→ 报错，不回退为无上限。
 *
 * 互斥（第十九轮二）：复用 daemon 单例锁协议（singletonLock）——owner.json 身份（pid），
 * 活进程持锁**任意时长**不接管（无年龄推断）；身份缺失/半写入保守 BUSY；确认死亡走
 * claim→归档→代次校验的原子接管；release 只释放自己的锁。
 *
 * 生产路径（未设 ZS_REAL_BATCH_ID）完全不触本模块。测试隔离：ZS_REAL_BATCH_DIR。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireSingletonLock } from './singletonLock.ts';
import type { DomainResult } from '../contracts/errors.ts';
import { domainErr } from '../contracts/errors.ts';

export interface BatchHeader {
  op: 'batch-config';
  batchId: string;
  cap: number | null;
  runtimeKind: string | null;
  model: string | null;
  at: number;
  pid: number;
}

export interface BatchJournalEntry {
  op: 'reserve' | 'settle' | 'reject' | 'cap-update';
  pid: number;
  at: number;
  turnId?: string;
  note?: string;
  from?: number | null;
  to?: number | null;
}

export type JournalRecord = BatchHeader | BatchJournalEntry;

export interface BatchJournalStats {
  reserved: number;
  settled: number;
  rejected: number;
  cap: number | null;
}

export class BatchGuardError extends Error {
  code: 'BATCH_JOURNAL_CORRUPT' | 'BATCH_CAP_INVALID' | 'BATCH_BOUND_MISMATCH' | 'BATCH_LOCK_BUSY';
  constructor(code: BatchGuardError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function batchJournalDir(): string {
  return process.env.ZS_REAL_BATCH_DIR ?? join(homedir(), '.zhongshuo-real-batches');
}

/** 显式配置了无效 cap → 报错（不回退为无上限）；未配置 → null（无上限，仅审计）。 */
export function ensureBatchCap(): number | null {
  const raw = process.env.ZS_REAL_BATCH_CAP;
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BatchGuardError('BATCH_CAP_INVALID', `ZS_REAL_BATCH_CAP 配置无效（"${raw}"）——必须为正整数；拒绝在无法核对额度时发请求`);
  }
  return n;
}

/** 兼容旧名（返回 null=未配置）；无效值同样抛错——调用方不得把异常当无上限。 */
export function configuredBatchCap(): number | null {
  return ensureBatchCap();
}

function safeBatchId(batchId: string): string {
  return /^[\w.-]+$/.test(batchId) ? batchId : createHash('sha256').update(batchId).digest('hex').slice(0, 16);
}

function journalFile(batchId: string): string {
  return join(batchJournalDir(), `${safeBatchId(batchId)}.jsonl`);
}

/** 锁根目录（复用单例锁协议：其内部建 <root>/daemon.lock.d）。 */
function lockRoot(batchId: string): string {
  return join(batchJournalDir(), `${safeBatchId(batchId)}.lockroot`);
}

const OPS = new Set(['batch-config', 'reserve', 'settle', 'reject', 'cap-update']);

function validateRecord(raw: string, lineNo: number): JournalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次日志第 ${lineNo} 行不是合法 JSON（内容片段：${raw.slice(0, 60)}）——按损坏拒绝发请求，不删除不少计`);
  }
  const rec = parsed as Record<string, unknown>;
  if (rec == null || typeof rec !== 'object' || typeof rec.op !== 'string' || !OPS.has(rec.op) || !Number.isInteger(rec.pid) || !Number.isInteger(rec.at)) {
    throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次日志第 ${lineNo} 行记录非法（op/pid/at 缺失或类型错误；内容片段：${raw.slice(0, 60)}）——按损坏拒绝发请求`);
  }
  return rec as unknown as JournalRecord;
}

/**
 * 严格读取：ENOENT → null（允许初始化）；其余读取失败/任何行损坏/尾行缺换行 → 抛
 * BATCH_JOURNAL_CORRUPT（保留现场，调用方拒绝发请求）。
 */
function readJournal(file: string): JournalRecord[] | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次日志不可读（${code ?? '未知'}：${file}）——按未知状态拒绝发请求（权限/占用/路径冲突均不当作零消耗）`);
  }
  if (raw.length === 0) return null; // 空文件视为未初始化（首写补头）
  if (!raw.endsWith('\n')) {
    throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次日志尾行不完整（无换行终止——写入中断的现场）：按未知占位拒绝发请求，不删除尾行不少计额度（${file}）`);
  }
  const lines = raw.split('\n');
  lines.pop(); // 末尾空串
  const records: JournalRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) {
      throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次日志第 ${i + 1} 行为空行（部分写入现场）——按损坏拒绝发请求（${file}）`);
    }
    records.push(validateRecord(line, i + 1));
  }
  if (records.length === 0 || records[0]!.op !== 'batch-config') {
    throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次日志缺 batch-config 头（首行 op=${records[0]?.op ?? '无'}）——按损坏拒绝发请求（${file}）`);
  }
  return records;
}

/** 持久化追加：open+write+fsync+close（fsync 实做——崩溃丢行=少计额度=超额方向，不安全）。 */
function appendLine(file: string, line: string, create = false): void {
  const payload = `${line}\n`;
  if (create) {
    const fd = openSync(file, 'w');
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return;
  }
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function serialize(record: JournalRecord): string {
  return JSON.stringify(record);
}

/** 单例锁互斥：身份协议承载（活持锁者任意时长不接管；身份未知 BUSY；死锁原子接管）。 */
function withLock<T>(batchId: string, fn: () => T): T {
  const root = lockRoot(batchId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { mkdirSync(batchJournalDir(), { recursive: true }); break; } catch { /* 重试 */ }
  }
  const acquired = acquireSingletonLock(root);
  if (!acquired.ok) {
    throw new BatchGuardError('BATCH_LOCK_BUSY', `批次日志锁不可用：${acquired.error.message}——fail-closed，不在无法互斥时写共享日志`);
  }
  try {
    return fn();
  } finally {
    acquired.value.release(); // 只释放自己的锁（协议内校验 owner.pid）
  }
}

export interface ReserveInput {
  batchId: string;
  cap: number | null;
  turnId: string;
  /** 归属范围（与头绑定：后开进程换 kind/model 不能借此重立额度边界）。 */
  runtimeKind?: string | null;
  model?: string | null;
}

export interface ReserveResult {
  ok: boolean;
  reserved: number;
  cap: number | null;
}

function currentCapOf(records: JournalRecord[]): number | null {
  let cap = (records[0] as BatchHeader).cap;
  for (const r of records) {
    if (r.op === 'cap-update') cap = r.to ?? cap;
  }
  return cap;
}

/** 原子检查+占位（锁内）：头绑定校验 → 额度判定 → fsync 追加。 */
export function reserveSlot(input: ReserveInput): ReserveResult {
  const file = journalFile(input.batchId);
  return withLock(input.batchId, () => {
    const records = readJournal(file);
    if (records == null) {
      // 初始化：头绑定本次 cap 与范围（此后额度边界以头/cap-update 为准）。
      const header: BatchHeader = {
        op: 'batch-config', batchId: input.batchId, cap: input.cap,
        runtimeKind: input.runtimeKind ?? null, model: input.model ?? null,
        at: Date.now(), pid: process.pid,
      };
      appendLine(file, serialize(header), true);
      appendLine(file, serialize({ op: 'reserve', pid: process.pid, at: Date.now(), turnId: input.turnId }));
      return { ok: true, reserved: 1, cap: input.cap };
    }
    const header = records[0] as BatchHeader;
    if (header.batchId !== input.batchId) {
      throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次日志头的 batchId 不符（${header.batchId} ≠ ${input.batchId}）——按损坏拒绝（${file}）`);
    }
    // 范围绑定：头有值且与本进程解析结果不一致 → 拒绝（不许换 kind/model 重立边界）。
    if (header.runtimeKind != null && input.runtimeKind != null && header.runtimeKind !== input.runtimeKind) {
      throw new BatchGuardError('BATCH_BOUND_MISMATCH', `批次 ${input.batchId} 已绑定 runtime=${header.runtimeKind}，本进程为 ${input.runtimeKind}——额度与范围持久绑定，不得换范围重立`);
    }
    if (header.model != null && input.model != null && header.model !== input.model) {
      throw new BatchGuardError('BATCH_BOUND_MISMATCH', `批次 ${input.batchId} 已绑定 model=${header.model}，本进程为 ${input.model}——额度与范围持久绑定，不得换模型重立`);
    }
    const cap = currentCapOf(records);
    // 额度边界以头/cap-update 为准（持久绑定）：后开进程不得经更大的 env cap 隐式扩额
    // （BATCH_BOUND_MISMATCH）；更小的 env cap 不改变批次边界（批次生效额为准）。
    if (input.cap != null && cap == null) {
      throw new BatchGuardError('BATCH_BOUND_MISMATCH', `批次 ${input.batchId} 以无上限（审计模式）建立，本进程带 cap=${input.cap}——不得经普通 reserve 隐式立额（显式 updateBatchCap 留痕后方可）`);
    }
    if (input.cap != null && cap != null && input.cap > cap) {
      throw new BatchGuardError('BATCH_BOUND_MISMATCH', `批次 ${input.batchId} 生效上限为 ${cap}，本进程配置 cap=${input.cap}（更大）——不得经 env 重新扩额；合法增额须显式 updateBatchCap 留痕`);
    }
    const reserved = records.filter((r) => r.op === 'reserve').length;
    if (cap != null && reserved >= cap) {
      appendLine(file, serialize({ op: 'reject', pid: process.pid, at: Date.now(), turnId: input.turnId, note: `已达上限 ${cap}（预占 ${reserved}）` }));
      return { ok: false, reserved, cap };
    }
    appendLine(file, serialize({ op: 'reserve', pid: process.pid, at: Date.now(), turnId: input.turnId }));
    return { ok: true, reserved: reserved + 1, cap };
  });
}

/** 审计条目（不回收额度）。 */
export function settleSlot(batchId: string, turnId: string, note: string): void {
  const file = journalFile(batchId);
  withLock(batchId, () => {
    if (readJournal(file) == null) {
      throw new BatchGuardError('BATCH_JOURNAL_CORRUPT', `批次 ${batchId} 日志缺失（settle 无头可归属）——拒绝写入匿名条目`);
    }
    appendLine(file, serialize({ op: 'settle', pid: process.pid, at: Date.now(), turnId, note: note.slice(0, 120) }));
  });
}

/**
 * 显式、留痕的批次配置更新（合法增额唯一路径）：fromCap 必须与当前生效 cap 一致
 * （CAS——并发更新只有一方生效），to 为正整数；记录 from/to/note。
 */
export function updateBatchCap(batchId: string, fromCap: number | null, toCap: number, note: string, scope?: { runtimeKind?: string | null; model?: string | null }): DomainResult<{ from: number | null; to: number }> {
  if (!Number.isInteger(toCap) || toCap <= 0) {
    return domainErr('VALIDATION_INVALID', 'updateBatchCap：toCap 必须为正整数');
  }
  const file = journalFile(batchId);
  try {
    return withLock(batchId, (): DomainResult<{ from: number | null; to: number }> => {
      const records = readJournal(file);
      if (records == null) {
        return domainErr('NOT_FOUND', `批次 ${batchId} 日志不存在——先以正式 reserve 立批，再更新 cap`);
      }
      const current = currentCapOf(records);
      if (current !== fromCap) {
        return domainErr('REVISION_CONFLICT', `cap 已变化（当前 ${current ?? '无上限'} ≠ 声明 from ${fromCap ?? '无上限'}）——CAS 拒绝，请读取后重试`);
      }
      const header = records[0] as BatchHeader;
      if (scope != null) {
        if (header.runtimeKind != null && scope.runtimeKind != null && header.runtimeKind !== scope.runtimeKind) {
          return domainErr('BATCH_BOUND_MISMATCH', 'runtime 范围已持久绑定，不可经 cap 更新更换');
        }
        if (header.model != null && scope.model != null && header.model !== scope.model) {
          return domainErr('BATCH_BOUND_MISMATCH', 'model 范围已持久绑定，不可经 cap 更新更换');
        }
      }
      appendLine(file, serialize({ op: 'cap-update', pid: process.pid, at: Date.now(), from: fromCap, to: toCap, note: note.slice(0, 200) }));
      return { ok: true, value: { from: fromCap, to: toCap } };
    });
  } catch (error) {
    if (error instanceof BatchGuardError) return domainErr(error.code, error.message);
    throw error;
  }
}

/** 统计（损坏即抛——调用方呈现诊断，不当零）。 */
export function batchJournalStats(batchId: string): BatchJournalStats {
  const records = readJournal(journalFile(batchId));
  if (records == null) return { reserved: 0, settled: 0, rejected: 0, cap: null };
  return {
    reserved: records.filter((r) => r.op === 'reserve').length,
    settled: records.filter((r) => r.op === 'settle').length,
    rejected: records.filter((r) => r.op === 'reject').length,
    cap: currentCapOf(records),
  };
}

export function batchJournalExists(batchId: string): boolean {
  return existsSync(journalFile(batchId));
}

/** 诊断辅助：文件尺寸/存在性（不动现场）。 */
export function batchJournalDiagnostics(batchId: string): { exists: boolean; size: number | null } {
  const file = journalFile(batchId);
  if (!existsSync(file)) return { exists: false, size: null };
  try {
    return { exists: true, size: statSync(file).size };
  } catch {
    return { exists: true, size: null };
  }
}
