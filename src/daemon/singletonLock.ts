/**
 * daemon 单实例锁（§8.3）。目录式协议（修复轮 4：未知身份保守化 + 代次安全接管）。
 *
 * 规则：
 * - 锁 = 目录 `daemon.lock.d/`（mkdir 原子创建）；owner = 目录内 `owner.json`。
 * - **未知身份一律 BUSY**：owner/claim 的身份缺失、半写入、stat/read 失败、损坏——
 *   无论多久（不以 mtime 宽限后自动清理替代互斥），都不证明持有者死亡，不自动
 *   破坏锁；需要人工核对（ADR-I34）。
 * - 已确认死亡（身份可读且 pid 死）才接管：claim = 原子 mkdir（并发接管唯一赢家）；
 *   接管把 claim 目录**原子 rename** 到唯一归档名并读回校验「与所确认的同一代次」——
 *   校验不符（期间被新接管者替换）则还原归档并放弃，绝不删除他人的新 claim。
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
  /** 测试同步点：claim mkdir 成功后、身份写入前（身份缺失窗口反例）。 */
  onBeforeClaimIdentity?: () => void;
  /** 测试同步点：身份写入后、claim 归档 rename 前（代次替换竞争反例）。 */
  onBeforeClaimArchive?: () => void;
  /** 测试同步点：确认死 claim 后、归档 rename 前（清理者竞争/代次替换反例）。 */
  onBeforeDeadClaimArchive?: () => void;
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

type OwnerRead = { kind: 'ok'; content: LockContent } | { kind: 'unknown' } | { kind: 'missing' };

/** 身份读取：缺失/半写入/损坏/读取失败一律 unknown（不证明死亡）。 */
function readIdentity(path: string): OwnerRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unknown' }; // EPERM/占用等：未知，不自动处理
  }
  try {
    const parsed = JSON.parse(raw) as LockContent;
    if (Number.isFinite(parsed?.pid)) return { kind: 'ok', content: parsed };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' }; // 半写入 JSON
  }
}

function needsManualCheck(where: string, why: string): DomainResult<never> {
  return domainErr(
    'WORKSPACE_BUSY',
    `单实例锁身份未知（${where}：${why}）——不自动破坏锁，请人工核对后重试（ADR-I34）`,
  );
}

export function acquireSingletonLock(
  appDataDir: string,
  options: SingletonLockOptions = {},
): DomainResult<SingletonLockHandle> {
  const lockDir = join(appDataDir, 'daemon.lock.d');
  const ownerPath = join(lockDir, 'owner.json');
  const claimDir = join(lockDir, 'claim');
  const content: LockContent = { pid: process.pid, startedAt: Date.now() };

  // legacy 文件锁兼容：身份未知同样保守 BUSY；可读且死才迁移。
  const legacyPath = join(appDataDir, 'daemon.lock');
  if (existsSync(legacyPath)) {
    const legacy = readIdentity(legacyPath);
    if (legacy.kind === 'unknown') return needsManualCheck('旧版文件锁', '身份缺失/半写入/读取失败');
    if (legacy.kind === 'ok') {
      if (isProcessAlive(legacy.content.pid)) {
        return domainErr('WORKSPACE_BUSY', `daemon 已在运行（pid=${legacy.content.pid}，旧版文件锁）`);
      }
      try {
        renameSync(legacyPath, `${legacyPath}.stale-${Date.now()}-${process.pid}`);
      } catch {
        return needsManualCheck('旧版文件锁', '迁移失败');
      }
    }
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    // 1) 原子创建（并发启动唯一赢家）。
    try {
      mkdirSync(appDataDir, { recursive: true });
      mkdirSync(lockDir);
      writeFileSync(ownerPath, JSON.stringify(content), 'utf8');
      return handle(lockDir, ownerPath);
    } catch {
      // EEXIST：被持有或接管中。
    }

    // 2) claim 存在：身份未知 → BUSY（人工核对）；已知且活（含本进程重入）→ BUSY；
    //    已知且死 → 原子 rename 归档（并发清理者唯一赢家）+ 代次校验，绝不 rmSync 他人 claim。
    if (existsSync(claimDir)) {
      const claimer = readIdentity(join(claimDir, 'claimer.json'));
      if (claimer.kind === 'unknown') {
        return needsManualCheck('锁接管 claim', '接管者身份缺失/半写入/读取失败');
      }
      if (claimer.kind === 'missing') {
        return needsManualCheck('锁接管 claim', '接管者身份文件缺失（写入窗口或异常清理）');
      }
      if (claimer.kind === 'ok') {
        if (isProcessAlive(claimer.content.pid)) {
          return domainErr('WORKSPACE_BUSY', `锁接管进行中（pid=${claimer.content.pid}），保守拒绝启动`);
        }
        const confirmedPid = claimer.content.pid;
        const archive = `${claimDir}.dead-${Date.now()}-${process.pid}`;
        options.onBeforeDeadClaimArchive?.();
        try {
          renameSync(claimDir, archive);
        } catch {
          continue; // 他人已归档：重试整体流程。
        }
        // 代次校验：归档内容必须仍是所确认的同一 pid（否则期间被新接管者替换过）。
        const archived = readIdentity(join(archive, 'claimer.json'));
        if (archived.kind !== 'ok' || archived.content.pid !== confirmedPid) {
          try {
            renameSync(archive, claimDir); // 还原（若 claim 位已被新接管者占据则失败）
          } catch {
            /* 新接管者已就位：归档保留待人工核对 */
          }
          return domainErr('WORKSPACE_BUSY', 'claim 在归档窗口内被替换，放弃启动以避免双实例');
        }
        rmSync(archive, { recursive: true, force: true });
        continue; // claim 已清理：下一轮判定 owner。
      }
    }

    // 3) 判定 owner：未知 → BUSY（人工核对）；活 → BUSY；死 → 走接管。
    const owner = readIdentity(ownerPath);
    if (owner.kind === 'missing') continue; // 被移走，重试创建
    if (owner.kind === 'unknown') {
      return needsManualCheck('锁 owner', '身份缺失/半写入/读取失败');
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
      continue;
    }
    options.onBeforeClaimIdentity?.();
    writeFileSync(join(claimDir, 'claimer.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    options.onBeforeClaimArchive?.();
    // 5) 整目录归档后重建；归档内容复核确系被判定的旧 owner（防御性）。
    const lockArchive = `${lockDir}.stale-${Date.now()}-${process.pid}`;
    try {
      renameSync(lockDir, lockArchive);
    } catch {
      try {
        rmSync(claimDir, { recursive: true, force: true });
      } catch { /* 已清 */ }
      continue;
    }
    const archivedOwner = readIdentity(join(lockArchive, 'owner.json'));
    if (archivedOwner.kind !== 'ok' || archivedOwner.content.pid !== owner.content.pid) {
      return domainErr('WORKSPACE_BUSY', '接管窗口内锁内容发生变化，放弃启动以避免双实例（归档已保留待人工核对）');
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
  const r = readIdentity(join(appDataDir, 'daemon.lock.d', 'owner.json'));
  return r.kind === 'ok' ? r.content : undefined;
}

export function writeLockDirForTest(appDataDir: string, owner: LockContent): void {
  const lockDir = join(appDataDir, 'daemon.lock.d');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
}

export function preclaimLockForTest(appDataDir: string, claimerPid: number | 'unidentifiable'): void {
  const claimDir = join(appDataDir, 'daemon.lock.d', 'claim');
  mkdirSync(claimDir, { recursive: true });
  if (claimerPid === 'unidentifiable') return; // 只建目录不写身份（写入窗口）
  writeFileSync(join(claimDir, 'claimer.json'), JSON.stringify({ pid: claimerPid }), 'utf8');
}

export function lockPathOf(appDataDir: string): string {
  return join(appDataDir, 'daemon.lock.d');
}
