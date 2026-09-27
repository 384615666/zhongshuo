/**
 * daemon 单实例锁（§8.3：daemon 采用单实例锁；第二个实例不再启动另一份调度器）。
 *
 * 原子性与接管纪律（修复轮 2 收口）：
 * - 获取：`O_CREAT|O_EXCL` 独占创建——并发启动只有一个进程成功。
 * - 「创建中」窗口（刚创建尚未写完内容的空/半截文件）：不当作陈旧锁接管；
 *   在 createGraceMs 内视为创建中并保守返回 BUSY（宁可误判占用，不可双 daemon），
 *   超过宽限且仍损坏才按陈旧处理。
 * - 陈旧接管三步防误移：①判定持有 pid 已死；②rename 前二次读取确认内容未变
 *   （他人可能已在这期间完成新锁——读到活 pid 即 BUSY）；③rename 到唯一路径后
 *   读回核对内容确实是被判定的旧锁，否则尽力还原并返回 BUSY（我们移走了别人的新锁）。
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

export interface SingletonLockHandle {
  release(): void;
  readonly lockPath: string;
  readonly pid: number;
}

export interface SingletonLockOptions {
  /** 锁文件「创建中」宽限：内容损坏/为空但 mtime 在此窗口内视为创建中，保守 BUSY。 */
  createGraceMs?: number;
}

const DEFAULT_CREATE_GRACE_MS = 2_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryExclusiveCreate(lockPath: string, content: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, content, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

interface LockContent {
  pid: number;
  startedAt: number;
}

function readLock(lockPath: string): { kind: 'ok'; content: LockContent } | { kind: 'unreadable' } | { kind: 'missing' } {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as LockContent;
    if (Number.isFinite(parsed?.pid)) return { kind: 'ok', content: parsed };
    return { kind: 'unreadable' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    // 空文件/半截 JSON（写入未完成）。
    return { kind: 'unreadable' };
  }
}

export function acquireSingletonLock(
  appDataDir: string,
  options: SingletonLockOptions = {},
): DomainResult<SingletonLockHandle> {
  const createGraceMs = options.createGraceMs ?? DEFAULT_CREATE_GRACE_MS;
  const lockPath = join(appDataDir, 'daemon.lock');
  mkdirSync(appDataDir, { recursive: true });
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });

  for (let attempt = 0; attempt < 4; attempt++) {
    if (tryExclusiveCreate(lockPath, content)) {
      return domainOk({
        lockPath,
        pid: process.pid,
        release() {
          try {
            const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
            if (current.pid === process.pid) rmSync(lockPath);
          } catch {
            // 释放失败不阻塞退出。
          }
        },
      });
    }

    const first = readLock(lockPath);
    if (first.kind === 'missing') continue; // 他人刚移走旧锁并已创建/正在创建——重试
    if (first.kind === 'unreadable') {
      // 创建中窗口：不接管。超过宽限仍损坏才按陈旧处理。
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age < createGraceMs) {
        return domainErr('WORKSPACE_BUSY', '锁文件正在创建中（内容未就绪），保守拒绝启动');
      }
      // 陈旧损坏：接管（rename 到唯一路径），随后重试独占创建。
      try {
        renameSync(lockPath, `${lockPath}.corrupt-${Date.now()}-${process.pid}`);
      } catch {
        // 他人已处理。
      }
      continue;
    }

    if (isProcessAlive(first.content.pid)) {
      return domainErr(
        'WORKSPACE_BUSY',
        `daemon 已在运行（pid=${first.content.pid}）；第二个实例不再启动另一份调度器（§8.3）`,
      );
    }

    // 持有者已死：二次读取确认锁内容未变（防止移走他人刚创建的新锁）。
    const second = readLock(lockPath);
    if (second.kind === 'missing') continue;
    if (second.kind !== 'ok' || second.content.pid !== first.content.pid) {
      if (second.kind === 'ok' && isProcessAlive(second.content.pid)) {
        return domainErr('WORKSPACE_BUSY', `daemon 已在运行（pid=${second.content.pid}）`);
      }
      continue; // 内容已变化且仍非活锁：重试整体流程
    }

    // 原子移走旧锁（并发接管仅一个 rename 成功），并读回核对内容确系被判定旧锁。
    const stalePath = `${lockPath}.stale-${Date.now()}-${process.pid}`;
    try {
      renameSync(lockPath, stalePath);
    } catch {
      continue; // 他人已移走
    }
    const moved = readLock(stalePath);
    if (moved.kind !== 'ok' || moved.content.pid !== first.content.pid) {
      // 误移了他人的新锁：尽力还原并拒绝启动。
      try {
        renameSync(stalePath, lockPath);
      } catch {
        // 还原失败：下轮流程会按现有内容重新判定。
      }
      return domainErr('WORKSPACE_BUSY', '锁内容在接管窗口内被替换，放弃接管以避免双实例');
    }
    // 读回一致：确系陈旧锁，继续下一轮独占创建。
  }
  return domainErr('WORKSPACE_BUSY', '单实例锁竞争未收敛：请重试启动');
}

// ---------- 测试辅助 ----------

export function readSingletonLock(appDataDir: string): LockContent | undefined {
  const r = readLock(join(appDataDir, 'daemon.lock'));
  return r.kind === 'ok' ? r.content : undefined;
}

/** 测试辅助：按指定内容与 mtime 写入锁文件（模拟创建中/陈旧窗口）。 */
export function writeLockFileForTest(
  appDataDir: string,
  content: string,
  mtime: Date = new Date(),
): void {
  mkdirSync(appDataDir, { recursive: true });
  const fd = openSync(join(appDataDir, 'daemon.lock'), 'w');
  try {
    writeSync(fd, content, 0, 'utf8');
  } finally {
    closeSync(fd);
  }
  utimesSync(join(appDataDir, 'daemon.lock'), mtime, mtime);
}

export function lockPathOf(appDataDir: string): string {
  return join(appDataDir, 'daemon.lock');
}
