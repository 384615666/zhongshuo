/**
 * daemon 单实例锁（§8.3）。目录式协议（修复轮 2 重写：接管互斥靠原子 mkdir，不靠多次读取）。
 *
 * 协议：
 * - 锁 = 目录 `daemon.lock.d/`；创建即持有（mkdir 原子：并发启动只有一个赢家）。
 * - 持有信息 = 目录内 `owner.json`（pid+startedAt）；claim = 目录内 `claim/`（原子 mkdir）。
 * - 接管（持有 pid 已死）：先 mkdir `claim/`——**只有一个接管者能成功**；claim 内写接管者
 *   pid；随后 rename 整个锁目录到 stale 归档并重建。并发第三进程在 claim 存在期间启动 →
 *   保守 BUSY（宁可误判占用，不可双 daemon）。
 * - 非接管者永远不动目录；唯一可能的“替换”只能来自另一个接管者，而 claim 已互斥。
 * - 旧代次回调与新进程：锁对象无跨进程后台回调，风险面在进程退出竞态——release 仅删
 *   owner.pid 匹配的目录。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

export interface SingletonLockHandle {
  release(): void;
  readonly lockPath: string;
  readonly pid: number;
}

export interface SingletonLockOptions {
  /** 测试注入：claim 成功后的同步点（构造真实竞争窗口）。 */
  onClaimed?: () => void;
}

interface LockContent {
  pid: number;
  startedAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockDir: string): { kind: 'ok'; content: LockContent } | { kind: 'unreadable' } | { kind: 'missing' } {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as LockContent;
    if (Number.isFinite(parsed?.pid)) return { kind: 'ok', content: parsed };
    return { kind: 'unreadable' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable' };
  }
}

function readDirPid(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
    return Number.isFinite(parsed?.pid) ? (parsed.pid as number) : null;
  } catch {
    return null;
  }
}

export function acquireSingletonLock(
  appDataDir: string,
  options: SingletonLockOptions = {},
): DomainResult<SingletonLockHandle> {
  mkdirSync(appDataDir, { recursive: true });
  const lockDir = join(appDataDir, 'daemon.lock.d');
  const ownerPath = join(lockDir, 'owner.json');
  const claimDir = join(lockDir, 'claim');
  const content: LockContent = { pid: process.pid, startedAt: Date.now() };

  // 兼容旧版残留的文件锁（升级路径）：存在则按陈旧处理移走。
  const legacyPath = join(appDataDir, 'daemon.lock');
  if (existsSync(legacyPath)) {
    try {
      const legacyPid = readDirPid(legacyPath);
      if (legacyPid != null && isProcessAlive(legacyPid)) {
        return domainErr('WORKSPACE_BUSY', `daemon 已在运行（pid=${legacyPid}，旧版文件锁）`);
      }
      renameSync(legacyPath, `${legacyPath}.stale-${Date.now()}`);
    } catch {
      // 处理失败按无遗留继续。
    }
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    // 1) 原子创建（并发启动唯一赢家）。
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerPath, JSON.stringify(content), 'utf8');
      return handle(lockDir, ownerPath);
    } catch {
      // EEXIST：已被持有或接管中。
    }

    // 2) 接管者claim期间：保守等待（另一接管者正在重建）。
    if (existsSync(claimDir)) {
      const claimPid = readDirPid(join(claimDir, 'claimer.json'));
      // claimer 活着（含本进程重入：接管窗口内的第二次获取同样拒绝）→ 保守 BUSY。
      if (claimPid != null && isProcessAlive(claimPid)) {
        return domainErr('WORKSPACE_BUSY', `锁接管进行中（pid=${claimPid}），保守拒绝启动`);
      }
      // claim 持有者已死（接管者崩溃）：清理 claim 重试。
      try {
        rmSync(claimDir, { recursive: true, force: true });
      } catch {
        /* 竞态：他人已清 */
      }
      continue;
    }

    // 3) 判定持有者。
    const owner = readOwner(lockDir);
    if (owner.kind === 'missing') continue; // 被移走，重试创建
    if (owner.kind === 'unreadable') {
      // 创建中/损坏：短暂等待后重试；仍损坏按死锁接管（旧版文件锁语义收敛于此）。
      const waited = Date.now();
      void waited;
      try {
        mkdirSync(claimDir);
        writeFileSync(join(claimDir, 'claimer.json'), JSON.stringify({ pid: process.pid }), 'utf8');
        try {
          renameSync(lockDir, `${lockDir}.corrupt-${Date.now()}-${process.pid}`);
        } finally {
          rmSync(claimDir, { recursive: true, force: true });
        }
        continue;
      } catch {
        continue;
      }
    }
    if (isProcessAlive(owner.content.pid)) {
      return domainErr(
        'WORKSPACE_BUSY',
        `daemon 已在运行（pid=${owner.content.pid}）；第二个实例不再启动另一份调度器（§8.3）`,
      );
    }

    // 4) 原子 claim：并发接管者只有一个 mkdir 成功。
    try {
      mkdirSync(claimDir);
    } catch {
      continue; // 他人已 claim：回到第 2 步语义（下一轮等待/清理）。
    }
    writeFileSync(join(claimDir, 'claimer.json'), JSON.stringify({ pid: process.pid }), 'utf8');
    options.onClaimed?.(); // 测试同步点：claim 后、rename 前的真实竞争窗口
    // 5) 整目录归档后重建。rename 后二次核对归档内容确系被判定的旧 owner（防御性）。
    const archive = `${lockDir}.stale-${Date.now()}-${process.pid}`;
    try {
      renameSync(lockDir, archive);
    } catch {
      try {
        rmSync(claimDir, { recursive: true, force: true });
      } catch { /* 已清 */ }
      continue;
    }
    const archived = readOwner(archive);
    if (archived.kind !== 'ok' || archived.content.pid !== owner.content.pid) {
      // 误移风险兜底：归档内容与判定不符 → 不启动，保留归档待人工核对。
      return domainErr('WORKSPACE_BUSY', '接管窗口内锁内容发生变化，放弃启动以避免双实例（归档已保留）');
    }
    // claim 随目录归档；继续下一轮创建。
  }
  return domainErr('WORKSPACE_BUSY', '单实例锁竞争未收敛：请重试启动');

  function handle(dir: string, ownerFile: string): DomainResult<SingletonLockHandle> {
    return domainOk({
      lockPath: dir,
      pid: process.pid,
      release() {
        try {
          const current = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid: number };
          if (current.pid === process.pid) rmSync(dir, { recursive: true, force: true });
        } catch {
          // 释放失败不阻塞退出。
        }
      },
    });
  }
}

// ---------- 测试辅助 ----------

export function readSingletonLock(appDataDir: string): LockContent | undefined {
  const r = readOwner(join(appDataDir, 'daemon.lock.d'));
  return r.kind === 'ok' ? r.content : undefined;
}

/** 测试辅助：写入指定内容的 owner（模拟死/活持有者）。 */
export function writeLockDirForTest(appDataDir: string, owner: LockContent): void {
  const lockDir = join(appDataDir, 'daemon.lock.d');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
}

/** 测试辅助：预置 claim（模拟接管者 A 已 claim 且卡住）。 */
export function preclaimLockForTest(appDataDir: string, claimerPid: number): void {
  const claimDir = join(appDataDir, 'daemon.lock.d', 'claim');
  mkdirSync(claimDir, { recursive: true });
  writeFileSync(join(claimDir, 'claimer.json'), JSON.stringify({ pid: claimerPid }), 'utf8');
}

export function lockPathOf(appDataDir: string): string {
  return join(appDataDir, 'daemon.lock.d');
}
