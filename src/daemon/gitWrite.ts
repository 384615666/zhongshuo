/**
 * Git 写操作（DEV-14/RT-24 第十轮；§14.6/§15.2）。
 *
 * 边界（不随完整客户端放宽）：
 * - §14.5 禁令照旧：不做 reset --hard/强制 checkout/rebase/强推/自动 stash——本模块只有
 *   add/restore --staged/commit/log；
 * - §14.2 用户改动保护：批量暂存默认跳过 userPreExisting；文件既含用户原有未提交改动又含
 *   任务改动时按「无法分离」列入冲突（整文件暂存会把用户改动一并纳入，不悄悄代做）；
 * - Commit 与 ChangeSet/任务验收是不同维度：提交不写 application_status/review_status，
 *   合法用户 Git 操作不因 REVIEW 增加验收队列（RT-24⑦⑧）；
 * - 单写者保护：索引/HEAD 写操作前核对 workspace_leases 活跃租约（执行保护中不绕过）；
 * - 提交与预览绑定：expectedHead+expectedIndexDigest 变化即拒绝（不提交用户没看到的内容）；
 * - 幂等与既成事实：git_operations 日志 id=commandId；git 副作用已发生而回执未落库时，
 *   重试按日志/提交尾部标记核对既成事实，不重复 commit、不误报未执行；
 * - 身份配置缺失如实报错，不代改用户全局 Git 配置；远端操作不在本模块（另批）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { statSync, openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { runCommand, getReceipt } from '../persistence/commandGateway.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { captureGit, locateRepo, validateRepoRelativePath, parsePorcelainEntries, isUnmergedXy, type GitCapture, type GitStatusEntry, type RepoLocation } from './gitStatus.ts';
import { listActiveLeases } from './workspaceLocks.ts';
import { resolveDirectoryIdentity, lockDomainsOverlap, comparisonKey } from './directoryIdentity.ts';

export type GitWriteErrorCode =
  | 'NOT_A_GIT_REPO' | 'GIT_COMMAND_FAILED' | 'PATH_OUT_OF_REPO' | 'WORKSPACE_BUSY'
  | 'STALE_REVISION' | 'VALIDATION_INVALID' | 'RESOURCE_NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'STORAGE_UNAVAILABLE'
  | 'PROJECT_MISSING';

export class GitWriteError extends Error {
  readonly code: GitWriteErrorCode;
  readonly details?: unknown;
  constructor(code: GitWriteErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'GitWriteError';
    this.code = code;
    this.details = details;
  }
}

const MAX_PATHS_PER_CALL = 100;

// ---------- 基础设施 ----------

/** 写命令环境：保留用户配置/身份（不剥离），路径按字面语义。 */
function writeEnv(literalPaths: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (literalPaths) env.GIT_LITERAL_PATHSPECS = '1';
  return env;
}

async function mustGit(args: readonly string[], options: { cwd?: string; capBytes?: number; env?: NodeJS.ProcessEnv; what: string }): Promise<GitCapture> {
  const cap = await captureGit(args, { cwd: options.cwd, capBytes: options.capBytes ?? 1024 * 1024, env: options.env });
  if (cap.spawnError != null) throw new GitWriteError('GIT_COMMAND_FAILED', `git ${options.what} 无法执行（${cap.spawnError}）`);
  if (cap.exitCode !== 0) {
    throw new GitWriteError('GIT_COMMAND_FAILED', `git ${options.what} 失败（exit=${cap.exitCode}）：${cap.stderr.trim().slice(0, 200)}`);
  }
  return cap;
}

/** 项目定位 + 路径校验 + 项目范围（子目录项目不悄悄扩大操作范围到项目外）。 */
async function repoGuard(projectRoot: string, paths: string[] = []): Promise<RepoLocation> {
  let loc: RepoLocation;
  try {
    loc = await locateRepo(projectRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes('不是 git 仓库') ? 'NOT_A_GIT_REPO' : 'GIT_COMMAND_FAILED';
    throw new GitWriteError(code, message);
  }
  for (const path of paths) {
    try {
      validateRepoRelativePath(path);
    } catch (error) {
      throw new GitWriteError('PATH_OUT_OF_REPO', error instanceof Error ? error.message : String(error));
    }
    if (loc.projectPrefix !== '' && !(path === loc.projectPrefix || path.startsWith(`${loc.projectPrefix}/`))) {
      throw new GitWriteError('PATH_OUT_OF_REPO', `路径在项目范围外（项目根是仓库子目录 ${loc.projectPrefix}/）：${path}——项目级操作不扩大到项目外，请用你自己的 git 客户端操作仓库其余部分`);
    }
  }
  return loc;
}

/** 单写者保护：项目物理目录上存在未释放租约（active/expired）时，索引/HEAD 写操作拒绝。
 * 目录身份解析失败时**拒绝写操作**（第十一轮一 b：不放行无法确定范围的写）。 */
function assertNoActiveLeases(db: ZhongshuoDatabase, projectRoot: string): void {
  const identity = resolveDirectoryIdentity(projectRoot);
  if (!identity.ok) {
    throw new GitWriteError('PROJECT_MISSING', `项目目录身份无法解析（${identity.error.message}）——写操作拒绝：无法确定保护范围`);
  }
  const holders = listActiveLeases(db).filter((lease) => lockDomainsOverlap(identity.value.identityKey, lease.lock_domain));
  if (holders.length > 0) {
    throw new GitWriteError('WORKSPACE_BUSY', '任务执行保护生效中（写入租约未释放）——请先停止或等待执行结束，再做 Git 写操作；只读查看不受影响', {
      details: { holders: holders.map((h) => ({ ownerTurnId: h.owner_turn_id, lockDomain: h.lock_domain, status: h.status })) },
    });
  }
}

function activeLeasesOf(db: ZhongshuoDatabase, projectRoot: string): Array<{ ownerTurnId: string; status: string }> {
  const identity = resolveDirectoryIdentity(projectRoot);
  if (!identity.ok) return [];
  return listActiveLeases(db)
    .filter((lease) => lockDomainsOverlap(identity.value.identityKey, lease.lock_domain))
    .map((h) => ({ ownerTurnId: h.owner_turn_id, status: h.status }));
}

// ---------- 仓库级写互斥（第十一轮一 b） ----------

/**
 * 同一 Git 工作树（按真实路径身份键——两个项目映射同一工作树时也互斥）的**产品内**写操作
 * 串行执行：stage/unstage/stageTask/commit 等在 await git 子进程期间不得交错破坏彼此的
 * 确认条件（预览/暂存/提交链全程持锁）。
 * 边界如实：这只是**产品内**互斥——外部 Git 客户端不受协调，外部变化仍靠内容/ref 校验
 * （提交的 tree 绑定与 update-ref CAS）兜底，不声称能阻止任意外部客户端。
 * Map 键=comparisonKey(resolve(worktreeRoot))，每工作树至多一项，随项目数有界（不清理）。
 */
const repoWriteLocks = new Map<string, Promise<unknown>>();
const repoWriteDepths = new Map<string, number>();

export function repoWriteLockKey(worktreeRoot: string): string {
  return comparisonKey(resolve(worktreeRoot));
}

export async function withRepoWriteLock<T>(worktreeRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = repoWriteLockKey(worktreeRoot);
  const prev = repoWriteLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  repoWriteLocks.set(key, run.catch(() => undefined)); // 链尾吞错：后续等待者不被前序失败卡死
  repoWriteDepths.set(key, (repoWriteDepths.get(key) ?? 0) + 1);
  try {
    return await run;
  } finally {
    const next = (repoWriteDepths.get(key) ?? 1) - 1;
    if (next <= 0) repoWriteDepths.delete(key); else repoWriteDepths.set(key, next);
  }
}

/** 同步探测某工作树是否有产品内 Git 写操作在途（供同步命令如 changeset.undo 协调拒绝）。 */
export function repoWriteBusy(worktreeRoot: string): boolean {
  return (repoWriteDepths.get(repoWriteLockKey(worktreeRoot)) ?? 0) > 0;
}

/** Git 写前置（租约+撤销协调；互斥锁由各写命令自行包裹全程）。 */
function assertWritable(db: ZhongshuoDatabase, projectId: string, projectRoot: string): void {
  assertNoActiveLeases(db, projectRoot);
  const undoActive = (db.prepare(
    `SELECT count(*) c FROM change_set_undos u JOIN change_sets cs ON cs.id = u.change_set_id
     WHERE cs.project_id = ? AND u.status IN ('in_progress','failed','conflict')`,
  ).get(projectId) as { c: number }).c;
  if (undoActive > 0) {
    throw new GitWriteError('WORKSPACE_BUSY', '该项目的变更撤销未收口（进行中/失败/冲突）——Git 写操作暂不可用；请先在恢复中心完成或处理撤销');
  }
}

/** 当前 porcelain（写操作的状态事实源；截断如实失败，不当空结果）。 */
async function currentStatus(loc: RepoLocation): Promise<GitStatusEntry[]> {
  const cap = await mustGit(['-C', loc.worktreeRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { capBytes: 256 * 1024, what: 'status' });
  if (cap.truncated) throw new GitWriteError('GIT_COMMAND_FAILED', 'git status 输出超采集上限——状态列表不完整，写操作拒绝（请先清理或缩小变更面）');
  return parsePorcelainEntries(cap.stdout.toString('utf8'));
}

interface JournalInput { commandId: string; scope: string; payloadHash: string; now: number }

/** 幂等预检：回执已存在 → 重放原结果（同号不同参=冲突；正文被清理=要求新号）。 */
function replayIfReceipted<T>(db: ZhongshuoDatabase, journal: JournalInput): { replayed: true; data: T } | null {
  const existing = getReceipt(db, journal.scope, journal.commandId);
  if (existing == null) return null;
  if (existing.payload_hash !== journal.payloadHash) {
    throw new GitWriteError('IDEMPOTENCY_CONFLICT', '同 commandId 参数不一致（幂等冲突）——用新 commandId 重新提交');
  }
  if (existing.result_json == null) {
    throw new GitWriteError('STALE_REVISION', '回执正文已按数据清理策略删除；用新 commandId 重新提交');
  }
  return { replayed: true, data: JSON.parse(existing.result_json) as T };
}

export type GitOpAction = 'stage' | 'unstage' | 'stage_task' | 'commit' | 'commit_undo' | 'branch_create' | 'checkout' | 'push' | 'pull' | 'conflict_resolve';

interface OperationRow {
  projectId: string; action: GitOpAction; taskId?: string | null; changeSetIds?: string[];
  request: unknown; /** 恢复核对所需的预期事实（commit: expectedHead/expectedTree/branch）。 */
  headBefore?: string | null; headAfter?: string | null; commitOid?: string | null;
}

/** 副作用前写入持久意图（独立事务）：commandId/参数 hash/目标仓库与预期事实，status=pending。
 * 崩溃后重试按 pending 行核对既成事实——不只凭提交尾标记与父提交（第十一轮三）。 */
function beginPendingOperation(db: ZhongshuoDatabase, journal: JournalInput, row: OperationRow): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO git_operations (id, project_id, action, task_id, change_set_ids_json, request_json, result_json, head_before, head_after, commit_oid, created_at, status, request_hash)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      journal.commandId, row.projectId, row.action, row.taskId ?? null,
      row.changeSetIds != null ? JSON.stringify(row.changeSetIds) : null,
      JSON.stringify(row.request), row.headBefore ?? null, row.headAfter ?? null, row.commitOid ?? null, journal.now, journal.payloadHash,
    );
  });
  tx();
}

/** 已有 pending 行（同 commandId）核对：存在即校参数 hash（异参数=幂等冲突，含本分支）。 */
function requirePendingHashMatch(db: ZhongshuoDatabase, journal: JournalInput, row: { request_hash: string | null }): void {
  if (row.request_hash != null && row.request_hash !== journal.payloadHash) {
    throw new GitWriteError('IDEMPOTENCY_CONFLICT', '同 commandId 参数不一致（日志有、回执无的恢复分支同样拒绝）——用新 commandId 重新提交');
  }
}

/** 操作日志完成 + 命令回执（同一事务；pending 行升级 done、事实列补齐；emit=同事务领域事件）。 */
function persistOperation<T extends object>(
  db: ZhongshuoDatabase,
  journal: JournalInput,
  row: { projectId: string; action: GitOpAction; taskId?: string | null; changeSetIds?: string[]; request: unknown; result: T; headBefore?: string | null; headAfter?: string | null; commitOid?: string | null; emit?: () => void },
): { replayed: boolean; data: T } {
  const outcome = runCommand<T>(db, { idempotencyScope: journal.scope, commandId: journal.commandId, payloadHash: journal.payloadHash, now: journal.now }, () => {
    db.prepare(
      `INSERT OR IGNORE INTO git_operations (id, project_id, action, task_id, change_set_ids_json, request_json, result_json, head_before, head_after, commit_oid, created_at, status, request_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
    ).run(
      journal.commandId, row.projectId, row.action, row.taskId ?? null,
      row.changeSetIds != null ? JSON.stringify(row.changeSetIds) : null,
      JSON.stringify(row.request), JSON.stringify(row.result),
      row.headBefore ?? null, row.headAfter ?? null, row.commitOid ?? null, journal.now, journal.payloadHash,
    );
    db.prepare(
      `UPDATE git_operations SET status = 'done', result_json = ?, head_before = COALESCE(?, head_before), head_after = COALESCE(?, head_after), commit_oid = COALESCE(?, commit_oid), request_hash = COALESCE(request_hash, ?) WHERE id = ?`,
    ).run(JSON.stringify(row.result), row.headBefore ?? null, row.headAfter ?? null, row.commitOid ?? null, journal.payloadHash, journal.commandId);
    row.emit?.();
    return row.result;
  });
  if (!outcome.ok) throw new GitWriteError(outcome.error.code === 'IDEMPOTENCY_CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'STORAGE_UNAVAILABLE', outcome.error.message, { details: outcome.error.details });
  return { replayed: outcome.replayed, data: outcome.data };
}

/** 测试接缝：按给定 journal 上下文写一条 pending 意图行（模拟崩溃窗口；正式路径由各命令内部写入）。 */
export function beginPendingOperationForTest(db: ZhongshuoDatabase, journal: JournalInput, row: OperationRow): void {
  beginPendingOperation(db, journal, row);
}

/** 操作日志行读取（重试核对入口）。 */
function getOperationRow(db: ZhongshuoDatabase, commandId: string): { status: string; request_hash: string | null; result_json: string | null; request_json: string | null } | undefined {
  return db.prepare('SELECT status, request_hash, result_json, request_json FROM git_operations WHERE id = ?').get(commandId) as
    | { status: string; request_hash: string | null; result_json: string | null; request_json: string | null }
    | undefined;
}

// ---------- 暂存 / 取消暂存（单文件与普通按文件） ----------

export interface StageOutcome {
  staged: string[];
  skipped: Array<{ path: string; reason: string }>;
  replayed?: boolean;
}

export async function gitStage(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; paths: string[]; journal: JournalInput }): Promise<StageOutcome> {
  const replay = replayIfReceipted<StageOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  if (input.paths.length === 0 || input.paths.length > MAX_PATHS_PER_CALL) {
    throw new GitWriteError('VALIDATION_INVALID', `paths 数量须在 1..${MAX_PATHS_PER_CALL}`);
  }
  const loc = await repoGuard(input.projectRoot, input.paths);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    // 崩溃重试核对（日志有、回执无）：pending 行按当前事实裁决——不盲目同号重执行。
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as StageOutcome), replayed: true, recovered: true };
      const verdict = await adjudicatePendingStage(loc, input.paths);
      if (verdict.kind === 'blocked') throw new GitWriteError('STALE_REVISION', verdict.message);
      if (verdict.kind === 'satisfied') {
        const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'stage', request: { paths: input.paths }, result: verdict.result });
        return { ...persisted.data, recovered: true };
      }
      // not-executed：意图未生效——沿用 pending 行继续执行。
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'stage', request: { paths: input.paths } });
    }
    const status = await currentStatus(loc);
    const dirtyByPath = new Map(status.map((e) => [e.path, e]));
    const toStage: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const path of input.paths) {
      const entry = dirtyByPath.get(path);
      if (entry == null) {
        skipped.push({ path, reason: '当前无未提交改动（相对 HEAD 与索引均干净）——无需暂存' });
        continue;
      }
      if (entry.category === 'staged' && entry.xy[1] === ' ') {
        skipped.push({ path, reason: '该文件的改动已在暂存区（未再变更）——无需重复暂存' });
        continue;
      }
      toStage.push(path);
    }
    if (toStage.length > 0) {
      await mustGit(['-C', loc.worktreeRoot, 'add', '--', ...toStage], { env: writeEnv(true), what: 'add' });
    }
    const result: StageOutcome = { staged: toStage, skipped };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'stage', request: { paths: input.paths }, result });
    return persisted.data;
  });
}

/** 中断的暂存意图重试裁决：全部「已暂存且无更新未暂存改动」=已达成；有新内容=拒绝同号重试。 */
async function adjudicatePendingStage(loc: RepoLocation, paths: string[]): Promise<{ kind: 'satisfied'; result: StageOutcome } | { kind: 'not-executed' } | { kind: 'blocked'; message: string }> {
  const status = await currentStatus(loc);
  for (const path of paths) {
    const entries = status.filter((e) => e.path === path);
    if (entries.length === 0) {
      return { kind: 'blocked', message: `中断重试核对：${path} 当前无任何未提交改动（外部已处理）——不盲目重试，请用新命令重新确认` };
    }
    if (entries.some((e) => e.category === 'unstaged')) {
      return { kind: 'blocked', message: `中断重试核对：${path} 在意图之后又出现未暂存改动——不能用同号重试暂存新内容；请用新命令重新确认` };
    }
  }
  return { kind: 'satisfied', result: { staged: [...paths], skipped: [] } };
}

export async function gitUnstage(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; paths: string[]; journal: JournalInput }): Promise<StageOutcome> {
  const replay = replayIfReceipted<StageOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  if (input.paths.length === 0 || input.paths.length > MAX_PATHS_PER_CALL) {
    throw new GitWriteError('VALIDATION_INVALID', `paths 数量须在 1..${MAX_PATHS_PER_CALL}`);
  }
  const loc = await repoGuard(input.projectRoot, input.paths);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as StageOutcome), replayed: true, recovered: true };
      const verdict = await adjudicatePendingUnstage(loc, input.paths);
      if (verdict.kind === 'satisfied') {
        const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'unstage', request: { paths: input.paths }, result: verdict.result });
        return { ...persisted.data, recovered: true };
      }
      // not-executed（仍暂存中）：restore --staged 只改索引、无内容风险——安全重执行。
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'unstage', request: { paths: input.paths } });
    }
    const status = await currentStatus(loc);
    const stagedSet = new Set(status.filter((e) => e.category === 'staged').map((e) => e.path));
    const toUnstage: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const path of input.paths) {
      if (!stagedSet.has(path)) {
        skipped.push({ path, reason: '该文件当前不在暂存区——无需取消暂存' });
        continue;
      }
      toUnstage.push(path);
    }
    if (toUnstage.length > 0) {
      // restore --staged 只改索引（不动工作区内容）；新暂存的未跟踪文件回到未跟踪。
      await mustGit(['-C', loc.worktreeRoot, 'restore', '--staged', '--', ...toUnstage], { env: writeEnv(true), what: 'restore --staged' });
    }
    const result: StageOutcome = { staged: toUnstage, skipped };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'unstage', request: { paths: input.paths }, result });
    return persisted.data;
  });
}

/** 中断的取消暂存意图裁决：路径已不在暂存=已达成；仍暂存=可安全重执行（只动索引）。 */
async function adjudicatePendingUnstage(loc: RepoLocation, paths: string[]): Promise<{ kind: 'satisfied'; result: StageOutcome } | { kind: 'not-executed' }> {
  const status = await currentStatus(loc);
  const stagedSet = new Set(status.filter((e) => e.category === 'staged').map((e) => e.path));
  if (paths.some((path) => stagedSet.has(path))) return { kind: 'not-executed' };
  return { kind: 'satisfied', result: { staged: [], skipped: paths.map((path) => ({ path, reason: '该文件当前不在暂存区（意图已达成或外部已处理）' })) } };
}

// ---------- 按任务/改动集批量暂存（§14.2：跳过 userPreExisting） ----------

interface ChangeSetRowInfo {
  id: string;
  /** 定型顺序（change_sets.rowid）——多集同路径按此裁决版本关系。 */
  rowidOrder: number;
  manifest: { scopeKind?: string; truncated?: boolean; scanFailedDirs?: number; scanRejected?: number; preimageRoot?: string; git?: { head?: string | null; dirtyPaths?: string[] | null } };
  beforeByPath: Map<string, { state: string; sha256: string | null; contentRef: string | null; contentUnavailable: string | null }>;
  afterByPath: Map<string, { state: string; sha256: string | null }>;
}

function loadChangeSetRows(db: ZhongshuoDatabase, changeSetId: string): ChangeSetRowInfo | null {
  const row = db.prepare('SELECT id, manifest_json, rowid FROM change_sets WHERE id = ?').get(changeSetId) as { id: string; manifest_json: string | null; rowid: number } | undefined;
  if (row == null) return null;
  const manifest = JSON.parse(row.manifest_json ?? '{}') as ChangeSetRowInfo['manifest'];
  const mk = (role: 'before' | 'after') => new Map(
    (db.prepare('SELECT path, state, sha256, content_ref, content_unavailable FROM change_set_files WHERE change_set_id = ? AND role = ?').all(changeSetId, role) as Array<{ path: string; state: string; sha256: string | null; content_ref: string | null; content_unavailable: string | null }>)
      .map((r) => [r.path, role === 'before'
        ? { state: r.state, sha256: r.sha256, contentRef: r.content_ref, contentUnavailable: r.content_unavailable }
        : { state: r.state, sha256: r.sha256, contentRef: null, contentUnavailable: null }] as [string, { state: string; sha256: string | null; contentRef: string | null; contentUnavailable: string | null }]),
  );
  return { id: row.id, rowidOrder: row.rowid, manifest, beforeByPath: mk('before'), afterByPath: mk('after') };
}

/** 单个改动集的任务改动面（before vs after），基线不完整/unknown 如实返回 undeterminable。 */
function taskChangedPathsOf(cs: ChangeSetRowInfo, loc: RepoLocation): { changed: string[]; undeterminable: Array<{ path: string; reason: string }> } {
  const changed: string[] = [];
  const undeterminable: Array<{ path: string; reason: string }> = [];
  const toWorktree = (p: string): string => (loc.projectPrefix === '' ? p : `${loc.projectPrefix}/${p}`);
  const baselineIncomplete = cs.manifest.truncated === true || (cs.manifest.scanFailedDirs ?? 0) > 0 || (cs.manifest.scanRejected ?? 0) > 0;
  const paths = new Set([...cs.beforeByPath.keys(), ...cs.afterByPath.keys()]);
  for (const projectRel of paths) {
    const before = cs.beforeByPath.get(projectRel);
    const after = cs.afterByPath.get(projectRel);
    const wt = toWorktree(projectRel);
    if (before?.state === 'unknown' || after?.state === 'unknown') {
      undeterminable.push({ path: wt, reason: '改动集该文件状态为 unknown——不能断定归属' });
      continue;
    }
    if (before == null || (before.state === 'absent' && cs.manifest.scopeKind === 'directory-scan' && baselineIncomplete)) {
      undeterminable.push({ path: wt, reason: '基线捕获不完整（扫描截断/失败）——不能断定该文件是任务新增还是遗漏' });
      continue;
    }
    if (before == null) { changed.push(wt); continue; } // 声明将创建 / 扫描完整前提下的任务新增
    if (after == null) { changed.push(wt); continue; } // 任务删除（after 捕获面含 before 路径，缺失=已不存在）
    if (before.sha256 !== after.sha256 || before.state !== after.state) changed.push(wt);
  }
  return { changed, undeterminable };
}

/**
 * 基线时已 dirty 的路径（用户原有改动）。新捕获：manifest.git.dirtyPaths（porcelain -z 解析）。
 * 旧捕获无该字段：逐 before 行核对「基线内容 sha == HEAD blob sha」——不等即基线时已有用户
 * 未提交改动。回退路径对**任务改动面内**不可核对的文件报冲突（不暂存）；面外不可核对的
 * 文件只从 skipped 清单省略（不影响安全面：它们本就不在暂存候选里）。
 */
async function baselineDirtyPaths(cs: ChangeSetRowInfo, loc: RepoLocation, changed: string[]): Promise<{ dirty: Set<string>; unverifiable: Array<{ path: string; reason: string }> }> {
  const dirty = new Set<string>();
  const unverifiable: Array<{ path: string; reason: string }> = [];
  const listed = cs.manifest.git?.dirtyPaths;
  if (listed != null) {
    for (const p of listed) dirty.add(p);
    return { dirty, unverifiable };
  }
  if (cs.manifest.git == null || cs.manifest.git.head == null) {
    for (const wt of changed) unverifiable.push({ path: wt, reason: '改动集无 Git 基线（旧版捕获）——无法排除用户原有改动，保守跳过' });
    return { dirty, unverifiable };
  }
  const changedSet = new Set(changed);
  const toWorktree = (p: string): string => (loc.projectPrefix === '' ? p : `${loc.projectPrefix}/${p}`);
  for (const [projectRel, before] of cs.beforeByPath) {
    if (before.state === 'absent') continue;
    const wt = toWorktree(projectRel);
    const inScope = changedSet.has(wt);
    if (before.sha256 == null || before.contentRef == null || before.contentUnavailable != null) {
      if (inScope) unverifiable.push({ path: wt, reason: '基线前像内容不可用——无法排除用户原有改动，保守跳过' });
      continue;
    }
    const headBlob = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', '--verify', `HEAD:${wt}`], { capBytes: 4096 });
    if (headBlob.exitCode !== 0) {
      dirty.add(wt); // HEAD 无此文件：基线时已是用户未跟踪/新增文件
      continue;
    }
    const blob = await captureGit(['-C', loc.worktreeRoot, 'cat-file', 'blob', headBlob.stdout.toString('utf8').trim()], { capBytes: 8 * 1024 * 1024 });
    if (blob.exitCode !== 0 || blob.truncated) {
      if (inScope) unverifiable.push({ path: wt, reason: 'HEAD 内容读取失败/过大——无法排除用户原有改动，保守跳过' });
      continue;
    }
    const headSha = createHash('sha256').update(blob.stdout).digest('hex');
    if (headSha !== before.sha256) dirty.add(wt);
  }
  return { dirty, unverifiable };
}

export interface StageTaskOutcome {
  changeSetIds: string[];
  included: string[];
  skipped: Array<{ path: string; reason: string }>;
  conflicts: Array<{ path: string; reason: string }>;
  replayed?: boolean;
}

export async function gitStageTask(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; taskId?: string; changeSetId?: string; journal: JournalInput }): Promise<StageTaskOutcome> {
  const replay = replayIfReceipted<StageTaskOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  if ((input.taskId == null) === (input.changeSetId == null)) {
    throw new GitWriteError('VALIDATION_INVALID', 'taskId 与 changeSetId 二选一');
  }
  // 归属校验（第十一轮二）：taskId/changeSetId 必须属于指定项目。
  if (input.taskId != null) {
    const taskRow = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(input.taskId) as { id: string; project_id: string } | undefined;
    if (taskRow == null) throw new GitWriteError('RESOURCE_NOT_FOUND', `任务不存在：${input.taskId}`);
    if (taskRow.project_id !== input.projectId) throw new GitWriteError('RESOURCE_NOT_FOUND', `任务 ${input.taskId} 不属于项目 ${input.projectId}（跨项目改动集不得批量暂存）`);
  }
  if (input.changeSetId != null) {
    const csRow = db.prepare('SELECT id, project_id FROM change_sets WHERE id = ?').get(input.changeSetId) as { id: string; project_id: string } | undefined;
    if (csRow == null) throw new GitWriteError('RESOURCE_NOT_FOUND', `改动集不存在：${input.changeSetId}`);
    if (csRow.project_id !== input.projectId) throw new GitWriteError('RESOURCE_NOT_FOUND', `改动集 ${input.changeSetId} 不属于项目 ${input.projectId}（跨项目改动集不得批量暂存）`);
  }
  const loc = await repoGuard(input.projectRoot);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    // 崩溃重试核对：批量暂存的归属需按当前工作区全量重验——pending 即安全重执行（执行体
    // 自带 after 冻结核对与两遍裁决，部分已暂存的内容重验后仍一致才纳入）。
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as StageTaskOutcome), replayed: true, recovered: true };
      // pending → 重新执行（下方全量重验）。
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'stage_task', taskId: input.taskId ?? null, request: { taskId: input.taskId ?? null, changeSetId: input.changeSetId ?? null } });
    }
    // 目标改动集：指定 changeSetId，或该任务全部已定型（after_ref 非空）改动集，按 rowid 定型序。
    const ids: string[] = input.changeSetId != null
      ? [input.changeSetId]
      : (db.prepare(`SELECT id FROM change_sets WHERE task_id = ? AND project_id = ? AND after_ref != '' ORDER BY rowid`).all(input.taskId!, input.projectId) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) throw new GitWriteError('RESOURCE_NOT_FOUND', input.taskId != null ? `任务 ${input.taskId} 没有已定型的改动集（无 after 前像）——先经正式链路定型` : `改动集不存在：${input.changeSetId}`);
    const sets: ChangeSetRowInfo[] = [];
    for (const id of ids) {
      const cs = loadChangeSetRows(db, id);
      if (cs == null) throw new GitWriteError('RESOURCE_NOT_FOUND', `改动集不存在：${id}`);
      sets.push(cs);
    }
    // 集级门（第十一轮二）：已撤销/部分撤销/撤销未收口/归属无法核实的改动集不盲目批量暂存。
    const setGate = new Map<string, { kind: 'reverted' | 'partial' | 'undo-active' | 'broken'; detail: string }>();
    for (const cs of sets) {
      const appStatus = (db.prepare('SELECT application_status FROM change_sets WHERE id = ?').get(cs.id) as { application_status: string }).application_status;
      if (appStatus === 'reverted') { setGate.set(cs.id, { kind: 'reverted', detail: '该改动集已整体撤销（内容已恢复基线）——不再纳入' }); continue; }
      if (appStatus === 'partial') { setGate.set(cs.id, { kind: 'partial', detail: '该改动集部分撤销（application_status=partial）——归属不可整体核实，不批量暂存' }); continue; }
      const undoRow = db.prepare(`SELECT status FROM change_set_undos WHERE change_set_id = ? ORDER BY id DESC LIMIT 1`).get(cs.id) as { status: string } | undefined;
      if (undoRow != null && undoRow.status !== 'succeeded') {
        setGate.set(cs.id, { kind: 'undo-active', detail: `该改动集撤销未收口（${undoRow.status}）——不批量暂存` });
        continue;
      }
      try {
        JSON.parse(JSON.stringify(cs.manifest));
      } catch {
        setGate.set(cs.id, { kind: 'broken', detail: '改动集清单损坏（归属无法核实）——不批量暂存' });
      }
    }

    // ---- 第一遍：逐集原始判定（不写全局决定） ----
    interface SetVerdict { changed: string[]; undeterminable: Array<{ path: string; reason: string }>; dirty: Set<string>; unverifiable: Array<{ path: string; reason: string }> }
    const verdicts = new Map<string, SetVerdict>();
    for (const cs of sets) {
      // 门控集也计算变更面（其路径要在结果里列出并给出门控原因），只是不参与 include。
      const { changed, undeterminable } = taskChangedPathsOf(cs, loc);
      const { dirty, unverifiable } = await baselineDirtyPaths(cs, loc, changed);
      verdicts.set(cs.id, { changed, undeterminable, dirty, unverifiable });
    }

    // ---- 第二遍：全局裁决（定型序=change_sets rowid；同路径后集覆盖前集，不“先遇到就决定”） ----
    interface Decision { kind: 'include' | 'skip' | 'conflict'; fromCs: string; reason?: string; multiSet?: string[] }
    const decisions = new Map<string, Decision>();
    const multiSetPaths = new Map<string, Set<string>>();
    const record = (wt: string, decision: Decision, csOrder: number): void => {
      const seen = multiSetPaths.get(wt) ?? new Set<string>();
      seen.add(decision.fromCs);
      multiSetPaths.set(wt, seen);
      const prev = decisions.get(wt);
      if (prev != null && prev.fromCs === decision.fromCs) return;
      decisions.set(wt, decision); // 后集覆盖前集（版本关系=定型顺序）
      void csOrder;
    };
    for (const cs of sets) {
      const gate = setGate.get(cs.id);
      const v = verdicts.get(cs.id);
      const scope = v != null ? [...v.changed, ...v.dirty] : [];
      if (gate != null) {
        for (const wt of new Set(scope)) {
          // 已撤销→skip（内容已回基线）；其余门→conflict（保守，人工核实）。
          record(wt, { kind: gate.kind === 'reverted' ? 'skip' : 'conflict', fromCs: cs.id, reason: `${gate.detail}（改动集 ${cs.id}）` }, 0);
        }
        continue;
      }
      if (v == null) continue;
      for (const u of [...v.undeterminable, ...v.unverifiable]) {
        record(u.path, { kind: 'conflict', fromCs: cs.id, reason: u.reason }, 0);
      }
      for (const wt of v.changed) {
        if (v.dirty.has(wt)) {
          // 链式归属（第十一轮二）：基线时的「dirty」若恰好等于**更早定型改动集的 after**
          // （同项目任务链的未提交产出），归属是任务链而非用户——按版本关系纳入本集裁决，
          // 不误判为用户改动；其余情况（真正的用户修改）保持冲突不自动分离。
          const projectRel = loc.projectPrefix === '' || !wt.startsWith(`${loc.projectPrefix}/`) ? wt : wt.slice(loc.projectPrefix.length + 1);
          const beforeSha = cs.beforeByPath.get(projectRel)?.sha256 ?? null;
          const chained = beforeSha != null && chainedToPriorSet(db, input.projectId, cs.rowidOrder, projectRel, beforeSha);
          if (chained) {
            record(wt, { kind: 'include', fromCs: cs.id }, 0);
            continue;
          }
          record(wt, { kind: 'conflict', fromCs: cs.id, reason: `任务开始前该文件已有用户未提交改动，与任务改动无法按文件分离——请单独确认（改动集 ${cs.id}）` }, 0);
          continue;
        }
        record(wt, { kind: 'include', fromCs: cs.id }, 0);
      }
      for (const wt of v.dirty) {
        if (!decisions.has(wt) || decisions.get(wt)!.fromCs === cs.id) {
          record(wt, { kind: 'skip', fromCs: cs.id, reason: 'userPreExisting：任务开始前已存在的用户改动——批量暂存默认跳过，需用户显式操作' }, 0);
        }
      }
    }

    // ---- 第三遍：after 冻结核对（include 路径的当前工作区 == 所选改动集冻结 after） ----
    const included: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    const finalDecisions = new Map<string, Decision>();
    for (const [wt, decision] of decisions) {
      if (decision.kind === 'include') {
        const cs = sets.find((x) => x.id === decision.fromCs)!;
        const projectRel = wt.startsWith(`${loc.projectPrefix}/`) && loc.projectPrefix !== '' ? wt.slice(loc.projectPrefix.length + 1) : wt;
        const after = cs.afterByPath.get(loc.projectPrefix === '' ? wt : projectRel);
        const verify = await worktreeMatchesAfter(loc, projectRel, after);
        if (verify !== true) {
          finalDecisions.set(wt, { ...decision, kind: 'conflict', reason: `任务定型（after 冻结）后该文件已被修改：${verify}——不把后续用户修改纳入（改动集 ${decision.fromCs}）` });
          continue;
        }
        finalDecisions.set(wt, decision);
        continue;
      }
      finalDecisions.set(wt, decision);
    }
    for (const [wt, decision] of finalDecisions) {
      const multi = multiSetPaths.get(wt);
      const multiNote = multi != null && multi.size > 1 ? `〔该路径出现于 ${multi.size} 个改动集，按最新定型 ${decision.fromCs} 裁决〕` : '';
      if (decision.kind === 'include') included.push(wt);
      else if (decision.kind === 'skip') skipped.push({ path: wt, reason: `${decision.reason ?? ''}${multiNote}` });
      else conflicts.push({ path: wt, reason: `${decision.reason ?? ''}${multiNote}` });
    }
    if (included.length > 0) {
      // include 路径已在构造上限定于项目前缀内（change_set 路径→worktree 前缀映射）。
      await mustGit(['-C', loc.worktreeRoot, 'add', '--', ...included], { env: writeEnv(true), what: 'add (batch)' });
    }
    const result: StageTaskOutcome = { changeSetIds: ids, included, skipped, conflicts };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'stage_task', taskId: input.taskId ?? null, changeSetIds: ids, request: { taskId: input.taskId ?? null, changeSetId: input.changeSetId ?? null }, result });
    return persisted.data;
  });
}

/**
 * after 冻结核对（第十一轮二）：include 候选路径的当前工作区内容必须与所选改动集冻结的
 * after 状态一致——任务定型后的用户/外部修改不得自动纳入索引。
 */
async function worktreeMatchesAfter(loc: RepoLocation, projectRel: string, after: { state: string; sha256: string | null } | undefined): Promise<true | string> {
  const wtPath = loc.projectPrefix === '' ? projectRel : `${loc.projectPrefix}/${projectRel}`;
  const fsPath = join(loc.worktreeRoot, ...wtPath.split('/'));
  let st: { isFile: () => boolean; isDirectory: () => boolean } | null;
  try {
    st = statSync(fsPath);
  } catch {
    st = null;
  }
  if (after == null) return '改动集 after 无该路径记录（归属无法核实）';
  if (after.state === 'absent') {
    return st != null ? '任务删除的文件已重新存在（用户重建或类型变化）' : true;
  }
  if (after.state === 'unknown' || after.sha256 == null) return 'after 前像不可用（内容/状态 unknown）——无法核对';
  if (st == null) return '任务产出的文件已不存在（任务后被删除/移走）';
  if (st.isDirectory()) return '路径现为目录（文件类型变化）';
  const fd = openSync(fsPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(8 * 1024 * 1024, 16 * 1024 * 1024));
    const read = readSync(fd, buf, 0, buf.length, 0);
    const actual = createHash('sha256').update(buf.subarray(0, read)).digest('hex');
    if (actual !== after.sha256) return '内容与冻结 after 不一致（任务定型后又被修改）';
    return true;
  } finally {
    closeSync(fd);
  }
}

/** 基线内容与项目内任一**更早定型**改动集的 after 一致 → 该「dirty」是任务链产出而非用户改动。 */
function chainedToPriorSet(db: ZhongshuoDatabase, projectId: string, rowidOrder: number, projectRel: string, beforeSha: string): boolean {
  const rows = db.prepare(`SELECT id FROM change_sets WHERE project_id = ? AND after_ref != '' AND rowid < ?`).all(projectId, rowidOrder) as Array<{ id: string }>;
  for (const r of rows) {
    const after = db.prepare(`SELECT sha256 FROM change_set_files WHERE change_set_id = ? AND role = 'after' AND path = ? LIMIT 1`).get(r.id, projectRel) as { sha256: string | null } | undefined;
    if (after?.sha256 === beforeSha) return true;
  }
  return false;
}

// ---------- 提交内容绑定（第十一轮一：tree 身份 + 原子 CAS） ----------

const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

/** 索引 → tree oid（git write-tree）。同文件内容变化、文件模式变化都会改变 tree——
 * 这是提交预览绑定的**内容身份**（不再用 XY/path 列表摘要）。冲突索引/不可写索引非零退出。 */
async function writeTreeOf(loc: RepoLocation): Promise<string> {
  const cap = await captureGit(['-C', loc.worktreeRoot, 'write-tree'], { capBytes: 4096 });
  if (cap.spawnError != null || cap.exitCode !== 0) {
    throw new GitWriteError('GIT_COMMAND_FAILED', `git write-tree 失败（exit=${cap.exitCode}）：${cap.stderr.trim().slice(0, 160)}——冲突未解决的索引不能定型为 tree`);
  }
  const oid = cap.stdout.toString('utf8').trim();
  if (!OID_RE.test(oid)) throw new GitWriteError('GIT_COMMAND_FAILED', `write-tree 输出非提交对象 id：${oid.slice(0, 60)}`);
  return oid;
}

/** 直接从冻结 tree 构造提交对象（不跑 pre/post-commit 钩子、不使用 commit 模板/gpgsign——
 * 行为如实告知；需要钩子的提交请用用户自己的 git 客户端）。返回新提交 oid。 */
async function commitTreeOf(loc: RepoLocation, tree: string, parent: string | null, fullMessage: string): Promise<string> {
  const args = ['-C', loc.worktreeRoot, 'commit-tree', tree];
  if (parent != null) args.push('-p', parent);
  args.push('-m', fullMessage);
  const cap = await mustGit(args, { capBytes: 4096, env: writeEnv(false), what: 'commit-tree' });
  const oid = cap.stdout.toString('utf8').trim();
  if (!OID_RE.test(oid)) throw new GitWriteError('GIT_COMMAND_FAILED', `commit-tree 输出非提交对象 id：${oid.slice(0, 60)}`);
  return oid;
}

/**
 * 原子推进 HEAD（update-ref 带期望旧值 = compare-and-swap）：
 * - expectedOld=null → 期望 unborn（首提交，用 ZERO_OID 表示「必须不存在」）；
 * - 旧值不匹配（外部已移动 HEAD/创建分支）→ 失败并返回当前实际值（调用方拒绝，不覆盖）。
 * HEAD 为符号引用时 update-ref 默认解引用更新其指向的分支（提交目标=用户批准的分支）。
 */
async function updateRefCas(loc: RepoLocation, ref: string, newOid: string, expectedOld: string | null): Promise<{ ok: true } | { ok: false; current: string | null; stderr: string }> {
  // **显式 ref 的比较交换**：不经可变的 HEAD 解引用（第十二轮一）——外部把 HEAD 切到同旧
  // OID 的其他分支/删除重建目标 ref，都不会让本次更新落到未批准的目标上。
  const cap = await captureGit(['-C', loc.worktreeRoot, 'update-ref', ref, newOid, expectedOld ?? ZERO_OID], { capBytes: 8192 });
  if (cap.spawnError == null && cap.exitCode === 0) return { ok: true };
  const cur = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', '--verify', ref], { capBytes: 4096 });
  return { ok: false, current: cur.exitCode === 0 && OID_RE.test(cur.stdout.toString('utf8').trim()) ? cur.stdout.toString('utf8').trim() : null, stderr: cap.stderr.trim().slice(0, 200) };
}

/** 当前分支（symbolic-ref --short）；detached HEAD 返回 null。 */
async function currentBranchOf(loc: RepoLocation): Promise<string | null> {
  const cap = await captureGit(['-C', loc.worktreeRoot, 'symbolic-ref', '--short', 'HEAD'], { capBytes: 4096 });
  if (cap.exitCode !== 0) return null;
  return cap.stdout.toString('utf8').trim() || null;
}


/** 内置提交路径（commit-tree）无法履行的仓库工作流要求（第十二轮四）——检测到即阻塞内置
 * 提交并说明原因；不设置全局绕过、不改用户配置。长期方案差异记录于本轮报告。 */
async function commitWorkflowConflicts(loc: RepoLocation): Promise<string[]> {
  const conflicts: string[] = [];
  const hooksPathCap = await captureGit(['-C', loc.worktreeRoot, 'config', '--get', 'core.hooksPath'], { capBytes: 4096 });
  const hooksPath = hooksPathCap.exitCode === 0 && hooksPathCap.stdout.toString('utf8').trim() !== ''
    ? resolve(loc.worktreeRoot, hooksPathCap.stdout.toString('utf8').trim())
    : join(loc.worktreeRoot, '.git', 'hooks');
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
    let present: boolean;
    try {
      present = statSync(join(hooksPath, hook)).isFile();
    } catch { present = false; }
    if (present) {
      conflicts.push(`检测到 ${hook} 钩子（${hooksPath}）——内置提交经 commit-tree 构造，不执行任何钩子；为不静默绕过你的工作流，内置提交已阻塞。请用你自己的 git 客户端提交（钩子会正常执行），或临时移除钩子后再用内置提交`);
    }
  }
  const gpgCap = await captureGit(['-C', loc.worktreeRoot, 'config', '--get', 'commit.gpgsign'], { capBytes: 4096 });
  if (gpgCap.exitCode === 0 && gpgCap.stdout.toString('utf8').trim() === 'true') {
    conflicts.push('commit.gpgsign=true——内置提交（commit-tree）不产生签名；为不静默降级签名要求，内置提交已阻塞。请用你自己的 git 客户端提交（签名正常执行）');
  }
  return conflicts;
}

export interface CommitPreview {
  head: string | null;
  /** 当前分支名；detached HEAD 为 null（提交被阻塞）。 */
  branch: string | null;
  staged: Array<{ xy: string; path: string; renamedFrom?: string }>;
  unstagedCount: number;
  untrackedCount: number;
  conflicts: string[];
  identity: { name: string | null; email: string | null };
  /** 索引 tree oid（内容身份绑定：同文件内容/模式变化都会改变 tree；不可定型为 null）。 */
  indexTree: string | null;
  leaseHolders: Array<{ ownerTurnId: string; status: string }>;
  canCommit: boolean;
  blockers: string[];
  /** 执行方式说明（如实告知 commit-tree 不跑钩子）。 */
  notes: string[];
}

export async function gitCommitPreview(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string }): Promise<CommitPreview> {
  const loc = await repoGuard(input.projectRoot);
  return withRepoWriteLock(loc.worktreeRoot, () => commitSnapshot(db, loc, input));
}

/**
 * 提交预览快照（**不持锁**——供已持仓库写锁的调用方复用；公开命令经 gitCommitPreview
 * 持锁进入）。锁不可重入：嵌套持锁会死锁。
 */
async function commitSnapshot(db: ZhongshuoDatabase, loc: RepoLocation, input: { projectId: string; projectRoot: string }): Promise<CommitPreview> {
  {

    const headCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const head = headCap.exitCode === 0 && OID_RE.test(headCap.stdout.toString('utf8').trim()) ? headCap.stdout.toString('utf8').trim() : null;
    const branch = await currentBranchOf(loc);
    const status = await currentStatus(loc);
    const staged = status.filter((e) => e.category === 'staged');
    // 未合并条目在 porcelain 中同时占 X/Y 列（staged+unstaged 各一条）——去重后呈现。
    const conflicts = [...new Set(status.filter((e) => isUnmergedXy(e.xy)).map((e) => e.path))];
    const nameCap = await captureGit(['-C', loc.worktreeRoot, 'config', '--get', 'user.name'], { capBytes: 4096 });
    const emailCap = await captureGit(['-C', loc.worktreeRoot, 'config', '--get', 'user.email'], { capBytes: 4096 });
    const identity = { name: nameCap.exitCode === 0 ? nameCap.stdout.toString('utf8').trim() : null, email: emailCap.exitCode === 0 ? emailCap.stdout.toString('utf8').trim() : null };
    // tree 定型在锁内最后拍快照：预览的 HEAD/分支/状态列表/内容 tree 来自同一时序（产品内
    // 不交错）；外部并发由提交时的 tree 比对 + update-ref CAS 兜底。
    let indexTree: string | null = null;
    let treeError: string | null = null;
    if (conflicts.length === 0 && staged.length > 0) {
      try {
        indexTree = await writeTreeOf(loc);
      } catch (error) {
        treeError = error instanceof Error ? error.message : String(error);
      }
    }
    const leaseHolders = activeLeasesOf(db, input.projectRoot);
    const blockers: string[] = [];
    if (staged.length === 0) blockers.push('暂存区为空（没有可提交内容）');
    if (branch == null) blockers.push('当前处于 detached HEAD——产品内提交要求分支上下文（不悄悄提交到游离头）');
    if (conflicts.length > 0) blockers.push(`存在未解决冲突（${conflicts.length} 个文件）——冲突未解决时禁止提交`);
    if (treeError != null) blockers.push(treeError);
    if (identity.name == null || identity.email == null) blockers.push(`缺少 git 提交身份配置（user.name=${identity.name ?? '未配置'}，user.email=${identity.email ?? '未配置'}）——本产品不代改配置，请在仓库或全局配置后重试`);
    if (leaseHolders.length > 0) blockers.push(`任务执行保护生效中（租约持有者：${leaseHolders.map((h) => h.ownerTurnId).join('、')}）——保护期间不做提交`);
    for (const conflict of await commitWorkflowConflicts(loc)) blockers.push(conflict);
    return {
      head,
      branch,
      staged: staged.map((e) => ({ xy: e.xy, path: e.path, ...(e.renamedFrom != null ? { renamedFrom: e.renamedFrom } : {}) })),
      unstagedCount: status.filter((e) => e.category === 'unstaged').length,
      untrackedCount: status.filter((e) => e.category === 'untracked').length,
      conflicts,
      identity,
      indexTree,
      leaseHolders,
      canCommit: blockers.length === 0,
      blockers,
      notes: [
        '产品内提交经「write-tree → commit-tree → update-ref refs/heads/<分支>（带期望旧值）」原子完成：提交对象由预览时的索引 tree 直接构造，用户批准的分支 ref 用比较交换推进（不经可变的 HEAD 解引用）——预览后内容、分支或目标 ref 变化都会拒绝。',
        '该路径不执行 pre-commit/post-commit 钩子、不使用 commit 模板与 gpg 签名配置；需要钩子的提交请用你自己的 git 客户端。',
      ],
    };
  }
}

export interface CommitOutcome {
  /** 本次构造并落 ref 的提交对象（commit-tree 返回——我们自己知道的 oid）。 */
  commit: string;
  /** 本次明确更新的分支 ref（refs/heads/<branch>）——结果不依赖事后读 HEAD。 */
  updatedRef: string;
  headBefore: string | null;
  subject: string;
  /** 提交后核对的 HEAD；与 commit 不一致＝CAS 之后外部又推进了 HEAD——本次提交仍是 commit， */
  /** 但仓库已前进：如实返回差异，不把别人的 HEAD 记成本次结果、不回滚。 */
  headAfterActual?: string;
  /** false＝提交后核对发现不一致（进入核对流程：审计留痕，不自动 reset/撤销）。 */
  consistent?: boolean;
  /** 崩溃恢复：按持久意图/日志/提交尾标记核对到既成事实——回执补记，未重复提交。 */
  recovered?: boolean;
  replayed?: boolean;
}

/** 提交信息尾部操作标记：崩溃后幂等恢复的既成事实核对键（提交内容不含验收语义）。 */
export const COMMIT_TRAILER_KEY = 'Zhongshuo-Command-Id';

export async function gitCommit(db: ZhongshuoDatabase, input: {
  projectId: string; projectRoot: string; message: string;
  expectedHead: string | null; expectedIndexTree: string | null; expectedBranch: string | null;
  taskId?: string | null; changeSetIds?: string[];
  journal: JournalInput;
  /** 测试接缝：CAS 与提交后核对之间注入外部操作（正式命令不传）。 */
  _between?: () => Promise<void>;
}): Promise<CommitOutcome> {
  const replay = replayIfReceipted<CommitOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  const loc = await repoGuard(input.projectRoot);
  const opRequest = { message: input.message, expectedHead: input.expectedHead, expectedTree: input.expectedIndexTree, branch: input.expectedBranch };
  // 执行链（全程持仓库写锁）：持久意图 → 预览比对 → 冻结 tree 构造提交 → update-ref CAS →
  // 提交后核对。意图行在副作用前落库（status=pending）——崩溃后重试按 pending 行核对既成事实。
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    // 崩溃重试核对（日志有、回执无）：done=重放结果；pending=按 HEAD/标记裁决。
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') {
        const result0 = JSON.parse(existing.result_json ?? '{}') as CommitOutcome;
        const persisted0 = persistOperation(db, input.journal, { projectId: input.projectId, action: 'commit', taskId: input.taskId ?? null, changeSetIds: input.changeSetIds, request: opRequest, result: result0, headBefore: input.expectedHead, headAfter: result0.commit, commitOid: result0.commit });
        return { ...persisted0.data, recovered: true };
      }
      // pending：HEAD 仍在预期父上=未执行（对象可能已建但未落 ref，安全重执行）；
      // 尾标记命中=已执行（恢复结果）；两者皆非=外部推进——进人工核对，不自动执行。
      const headCap0 = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
      const head0 = headCap0.exitCode === 0 && OID_RE.test(headCap0.stdout.toString('utf8').trim()) ? headCap0.stdout.toString('utf8').trim() : null;
      if (head0 !== input.expectedHead) {
        const trailerHit = await findCommitByTrailer(loc, input.journal.commandId, input.expectedHead);
        if (trailerHit != null) {
          const recoveredResult: CommitOutcome = { commit: trailerHit.oid, updatedRef: `refs/heads/${input.expectedBranch ?? ''}`, headBefore: input.expectedHead, subject: trailerHit.subject, recovered: true };
          const persisted1 = persistOperation(db, input.journal, { projectId: input.projectId, action: 'commit', taskId: input.taskId ?? null, changeSetIds: input.changeSetIds, request: opRequest, result: recoveredResult, headBefore: input.expectedHead, headAfter: recoveredResult.commit, commitOid: recoveredResult.commit });
          return persisted1.data;
        }
        throw new GitWriteError('STALE_REVISION', `中断重试核对：HEAD 已被外部推进（当前 ${head0 ?? '空'}）且无本次操作标记——进入人工核对；不自动重试、不回滚`);
      }
      // head0 === expectedHead：未执行——沿用 pending 行继续。
    } else {
      // 无日志行（第十轮遗留崩溃窗口/外部推进）：HEAD 已离开预期父时先按尾标记核对——
      // 命中=我们的提交已落 ref（恢复）；否则如实按 HEAD 移动拒绝。
      const headCapN = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
      const headN = headCapN.exitCode === 0 && OID_RE.test(headCapN.stdout.toString('utf8').trim()) ? headCapN.stdout.toString('utf8').trim() : null;
      if (headN !== input.expectedHead) {
        const trailerHitN = await findCommitByTrailer(loc, input.journal.commandId, input.expectedHead);
        if (trailerHitN != null) {
          const recoveredN: CommitOutcome = { commit: trailerHitN.oid, updatedRef: `refs/heads/${input.expectedBranch ?? ''}`, headBefore: input.expectedHead, subject: trailerHitN.subject, recovered: true };
          const persistedN = persistOperation(db, input.journal, { projectId: input.projectId, action: 'commit', taskId: input.taskId ?? null, changeSetIds: input.changeSetIds, request: opRequest, result: recoveredN, headBefore: input.expectedHead, headAfter: recoveredN.commit, commitOid: recoveredN.commit });
          return persistedN.data;
        }
      }
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'commit', taskId: input.taskId ?? null, changeSetIds: input.changeSetIds, request: opRequest, headBefore: input.expectedHead });
    }
    // --- 原执行链 ---
    assertWritable(db, input.projectId, input.projectRoot);
    // 预览不可提交（tree/分支为 null：冲突/detached/身份缺失/空暂存）——取完整 blockers 拒绝。
    if (input.expectedIndexTree == null || input.expectedBranch == null) {
      const p = await commitSnapshot(db, loc, input); // 已持锁——用不持锁的内部快照
      throw new GitWriteError('VALIDATION_INVALID', `提交前置不满足：${p.blockers.join('；')}`);
    }
    const branchNow = await currentBranchOf(loc);
    if (branchNow !== input.expectedBranch) {
      throw new GitWriteError('STALE_REVISION', `提交目标分支已变化（预览 ${input.expectedBranch} → 当前 ${branchNow ?? 'detached HEAD'}）——请重新预览；不把提交套到另一个分支`);
    }
    for (const conflict of await commitWorkflowConflicts(loc)) {
      throw new GitWriteError('VALIDATION_INVALID', `提交前置不满足：${conflict}`);
    }
    const headCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const headNow = headCap.exitCode === 0 && OID_RE.test(headCap.stdout.toString('utf8').trim()) ? headCap.stdout.toString('utf8').trim() : null;
    if (headNow !== input.expectedHead) {
      throw new GitWriteError('STALE_REVISION', `HEAD 已移动（预览 ${input.expectedHead ?? '空仓库'} → 当前 ${headNow ?? '空仓库'}）——请重新预览后再提交`);
    }
    const treeNow = await writeTreeOf(loc);
    if (treeNow !== input.expectedIndexTree) {
      // 内容级绑定：同文件暂存 A→预览→再暂存 B（路径/状态不变）在此被拒——tree 已不同。
      throw new GitWriteError('STALE_REVISION', `暂存区内容与预览时不一致（索引 tree ${input.expectedIndexTree.slice(0, 8)} → ${treeNow.slice(0, 8)}）——请重新预览；不能提交你没看到的内容`);
    }
    const subject = input.message.split('\n')[0]!.slice(0, 80);
    const fullMessage = `${input.message}\n\n${COMMIT_TRAILER_KEY}: ${input.journal.commandId}`;
    // 构造提交对象（对象库副作用可忽略：CAS 失败时为悬挂对象，gc 自清；不触碰任何 ref）。
    const ourOid = await commitTreeOf(loc, treeNow, input.expectedHead, fullMessage);
    // 更新目标=用户批准的**显式分支 ref**（refs/heads/<branch>）——检查后外部 checkout 到同
    // 旧 OID 的其他分支时，被更新的仍是批准的 ref，绝不经由 HEAD 误写当前分支。
    const targetRef = `refs/heads/${input.expectedBranch}`;
    const cas = await updateRefCas(loc, targetRef, ourOid, input.expectedHead);
    if (!cas.ok) {
      throw new GitWriteError('STALE_REVISION', `目标 ref ${targetRef} 比较交换失败（现值 ${cas.current ?? '（不存在）'}）——本次提交未落 ref，未覆盖任何外部结果：${cas.stderr}`.slice(0, 300));
    }
    if (input._between != null) await input._between();
    // 提交后核对（第十二轮一）：**目标 ref** 必须等于本次提交对象（不依赖事后读 HEAD 猜结果）；
    // HEAD 只作附注记录（外部可能已切走——不影响本次副作用的事实认定）。
    const verifyRef = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', '--verify', targetRef], { capBytes: 4096 });
    const refAfter = verifyRef.exitCode === 0 ? verifyRef.stdout.toString('utf8').trim() : null;
    const verifyHead = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const headAfterActual = verifyHead.exitCode === 0 ? verifyHead.stdout.toString('utf8').trim() : null;
    const branchAfter = await currentBranchOf(loc);
    const treeVerify = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', `${ourOid}^{tree}`], { capBytes: 4096 });
    const treeOk = treeVerify.exitCode === 0 && treeVerify.stdout.toString('utf8').trim() === treeNow;
    const consistent = refAfter === ourOid && treeOk;
    const result: CommitOutcome = {
      commit: ourOid,
      updatedRef: targetRef,
      headBefore: input.expectedHead,
      subject,
      headAfterActual: headAfterActual ?? undefined,
      ...(consistent ? {} : { consistent: false }),
    };
    const persisted = persistOperation(db, input.journal, {
      projectId: input.projectId, action: 'commit', taskId: input.taskId ?? null, changeSetIds: input.changeSetIds,
      request: { message: input.message, expectedHead: input.expectedHead, expectedTree: treeNow, branch: input.expectedBranch }, result,
      headBefore: input.expectedHead, headAfter: headAfterActual, commitOid: ourOid,
      emit: () => {
        appendDomainEvent(db, {
          schemaVersion: 1,
          eventId: `evt_${randomUUID()}`,
          projectId: input.projectId,
          kind: consistent ? 'git.committed' : 'git.commitVerifyInconsistent',
          createdAt: input.journal.now,
          payload: { commit: ourOid, updatedRef: targetRef, refAfter, headAfterActual, branchAfter, taskId: input.taskId ?? null, subject, note: consistent ? undefined : 'CAS 后目标 ref 又被外部推进——本次提交对象为 commit 字段（已落库），目标 ref 现值见 refAfter；不自动回滚，请人工核对' },
        });
      },
    });
    return persisted.data;
  });
}

/** 近窗提交尾部标记检索（精确行匹配 + 父提交核对——恢复路径的既成事实证明）。 */
async function findCommitByTrailer(loc: RepoLocation, commandId: string, expectedHead: string | null): Promise<{ oid: string; subject: string } | null> {
  const cap = await captureGit(['-C', loc.worktreeRoot, 'log', '-n', '30', `--format=%H%x1f%P%x1f%s%x1f%b%x1e`], { capBytes: 512 * 1024 });
  if (cap.exitCode !== 0) return null; // 空仓库/无历史：视为未执行
  const needle = `${COMMIT_TRAILER_KEY}: ${commandId}`;
  for (const record of cap.stdout.toString('utf8').split('\x1e')) {
    const fields = record.split('\x1f');
    if (fields.length < 3) continue;
    const [oid, parents, subject, ...bodyParts] = fields;
    const body = bodyParts.join('\x1f');
    if (body.split('\n').some((line) => line.trim() === needle)) {
      const parent = (parents ?? '').trim().split(' ')[0] ?? '';
      const expectedParent = expectedHead ?? '';
      if (parent !== expectedParent) {
        throw new GitWriteError('STALE_REVISION', `提交标记命中但父提交不符（期望 ${expectedParent || '（空仓库首提交）'}，实际 ${parent || '（首提交）'}）——不套用为本次结果，请人工核对`);
      }
      return { oid: oid!.trim(), subject: subject ?? '' };
    }
  }
  return null;
}

// ---------- 提交历史（含任务/改动集关联） ----------

export interface HistoryItem {
  oid: string;
  parent: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  subject: string;
  /** 经本产品提交时携带的关联（外部提交为空——不虚构归属）。 */
  taskIds: string[];
  changeSetIds: string[];
  /** RT-24⑩：关联交付状态不得伪装成「整个提交已人工审阅」——展示层只列关联，不写已审。 */
}

export async function gitHistory(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; limit?: number; cursor?: number }): Promise<{ items: HistoryItem[]; head: string | null; hasMore: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 200);
  const cursor = Math.max(input.cursor ?? 0, 0);
  const loc = await repoGuard(input.projectRoot);
  const headCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
  const head = headCap.exitCode === 0 ? headCap.stdout.toString('utf8').trim() : null;
  if (head == null) return { items: [], head: null, hasMore: false };
  const cap = await mustGit(
    ['-C', loc.worktreeRoot, 'log', `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e`, '-n', String(limit + 1), '--skip', String(cursor)],
    { capBytes: 512 * 1024, what: 'log' },
  );
  const oids: string[] = [];
  const items: HistoryItem[] = [];
  for (const record of cap.stdout.toString('utf8').split('\x1e')) {
    const fields = record.split('\x1f');
    if (fields.length < 6 || (fields[0] ?? '').trim() === '') continue;
    const [oid, parents, an, ae, at, subject] = fields;
    oids.push(oid!.trim());
    items.push({
      oid: oid!.trim(), parent: (parents ?? '').trim().split(' ')[0] ?? '',
      authorName: an ?? '', authorEmail: ae ?? '',
      timestamp: Number(at ?? 0), subject: subject ?? '',
      taskIds: [], changeSetIds: [],
    });
  }
  // 关联注记（只来自操作日志——外部提交不虚构归属）。
  if (oids.length > 0) {
    const placeholders = oids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT commit_oid, task_id, change_set_ids_json FROM git_operations WHERE project_id = ? AND commit_oid IN (${placeholders})`).all(input.projectId, ...oids) as Array<{ commit_oid: string; task_id: string | null; change_set_ids_json: string | null }>;
    const byOid = new Map(rows.map((r) => [r.commit_oid, r]));
    for (const item of items) {
      const row = byOid.get(item.oid);
      if (row == null) continue;
      if (row.task_id != null) item.taskIds.push(row.task_id);
      if (row.change_set_ids_json != null) {
        try { item.changeSetIds.push(...(JSON.parse(row.change_set_ids_json) as string[])); } catch { /* 残缺关联不虚构 */ }
      }
    }
  }
  return { items: items.slice(0, limit), head, hasMore: items.length > limit };
}

// ---------- RT-24 剩余（第十一轮·三）：分支/切换、单提交 diff、push/pull、冲突解决、撤销提交 ----------

const RT24_PER_FILE_CAP = 64 * 1024;
const RT24_TOTAL_CAP = 512 * 1024;
const RT24_MAX_FILES = 50;

/** 分支名合法性（拒绝控制字符、空格、..、通配与历史改写类符号、前导点杠、@{、结尾 .lock）。 */
export function validateBranchName(name: string): void {
  if (name === '' || name.length > 200) throw new GitWriteError('VALIDATION_INVALID', '分支名为空或超长');
  const bad = name.split('').some((ch) => { const c = ch.charCodeAt(0); return c <= 0x1f || c === 0x7f || ' ~^:?*['.includes(ch) || ch === String.fromCharCode(92); });
  if (bad || name.includes('..') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock') || name.includes('@{') || name.split('/').some((sg) => sg === '' || sg === '.' || sg === '..')) {
    throw new GitWriteError('VALIDATION_INVALID', `分支名不合法：${name}`);
  }
}

export interface BranchItem { name: string; oid: string; lastCommitTs: number }

export async function gitBranchList(input: { projectId: string; projectRoot: string }): Promise<{ current: string | null; branches: BranchItem[]; dirtyCount: number }> {
  const loc = await repoGuard(input.projectRoot);
  const cap = await mustGit(['-C', loc.worktreeRoot, 'for-each-ref', 'refs/heads', '--format=%(refname:short)\x1f%(objectname)\x1f%(committerdate:unix)'], { capBytes: 64 * 1024, what: 'for-each-ref' });
  const branches: BranchItem[] = [];
  for (const line of cap.stdout.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    const [name, oid, ts] = line.split('\x1f');
    if (name == null || oid == null) throw new GitWriteError('GIT_COMMAND_FAILED', `for-each-ref 输出无法解析：${line.slice(0, 60)}`);
    branches.push({ name, oid, lastCommitTs: Number(ts ?? 0) });
  }
  const current = await currentBranchOf(loc);
  const status = await currentStatus(loc);
  const dirty = new Set(status.filter((e) => e.category === 'unstaged' || e.category === 'untracked').map((e) => e.path));
  return { current, branches, dirtyCount: dirty.size };
}

export async function gitBranchCreate(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; name: string; expectedHead: string | null; journal: JournalInput }): Promise<{ name: string; oid: string; replayed?: boolean }> {
  const replay = replayIfReceipted<{ name: string; oid: string; replayed?: boolean }>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  validateBranchName(input.name);
  const loc = await repoGuard(input.projectRoot);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as { name: string; oid: string }), replayed: true };
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'branch_create', request: { name: input.name, expectedHead: input.expectedHead } });
    }
    const headCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const head = headCap.exitCode === 0 ? headCap.stdout.toString('utf8').trim() : null;
    if (head !== input.expectedHead) throw new GitWriteError('STALE_REVISION', `HEAD 已移动（期望 ${input.expectedHead ?? '空'} → 当前 ${head ?? '空'}）——分支将建于用户未确认的位置，请刷新后重试`);
    const at = input.expectedHead ?? 'HEAD';
    const create = await captureGit(['-C', loc.worktreeRoot, 'branch', input.name, at], { capBytes: 8192 });
    if (create.exitCode !== 0) {
      throw new GitWriteError('GIT_COMMAND_FAILED', `创建分支失败：${create.stderr.trim().slice(0, 160)}（同名分支已存在等——如实报错，不覆盖）`);
    }
    const result = { name: input.name, oid: input.expectedHead ?? '' };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'branch_create', request: { name: input.name, expectedHead: input.expectedHead }, result });
    return persisted.data;
  });
}

export interface CheckoutOutcome {
  branch: string;
  headAfter: string | null;
  /** 切换后随行的未提交改动数（不自动 stash——如实告知，§14.6）。 */
  carriedDirtyCount: number;
  replayed?: boolean;
  recovered?: boolean;
}

export async function gitCheckout(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; branch: string; expectedHead: string | null; expectedBranch: string; journal: JournalInput }): Promise<CheckoutOutcome> {
  const replay = replayIfReceipted<CheckoutOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  validateBranchName(input.branch);
  const loc = await repoGuard(input.projectRoot);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as CheckoutOutcome), replayed: true, recovered: true };
      // pending：checkout 已否以当前分支判断——仍在原分支=未执行可重试。
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'checkout', request: { branch: input.branch, expectedHead: input.expectedHead, expectedBranch: input.expectedBranch } });
    }
    const branchNow = await currentBranchOf(loc);
    if (branchNow !== input.expectedBranch) {
      throw new GitWriteError('STALE_REVISION', `当前分支已变化（期望 ${input.expectedBranch} → 实际 ${branchNow ?? 'detached'}）——请刷新后重试`);
    }
    const headCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const head = headCap.exitCode === 0 ? headCap.stdout.toString('utf8').trim() : null;
    if (head !== input.expectedHead) throw new GitWriteError('STALE_REVISION', `HEAD 已移动（期望 ${input.expectedHead ?? '空'} → 当前 ${head ?? '空'}）——请刷新后重试`);
    // checkout 不自动 stash：未提交改动随行；与目标分支冲突时 git 自行拒绝（如实上抛）。
    const co = await captureGit(['-C', loc.worktreeRoot, 'checkout', input.branch], { capBytes: 32 * 1024 });
    if (co.exitCode !== 0) {
      throw new GitWriteError('GIT_COMMAND_FAILED', `切换分支失败（未提交改动与目标冲突等）：${co.stderr.trim().slice(0, 200)}——不自动 stash，请先处理本地改动`);
    }
    const branchAfter = await currentBranchOf(loc);
    const headAfterCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const headAfter = headAfterCap.exitCode === 0 ? headAfterCap.stdout.toString('utf8').trim() : null;
    const status = await currentStatus(loc);
    const dirty = new Set(status.filter((e) => e.category === 'unstaged' || e.category === 'untracked').map((e) => e.path));
    const result: CheckoutOutcome = { branch: branchAfter ?? input.branch, headAfter, carriedDirtyCount: dirty.size };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'checkout', request: { branch: input.branch, expectedHead: input.expectedHead }, result, headBefore: input.expectedHead, headAfter });
    return persisted.data;
  });
}

export interface CommitDiffMeta {
  oid: string; parents: string[]; subject: string; authorName: string; authorEmail: string; timestamp: number;
  /** 本产品操作日志关联（外部提交为空——不虚构归属，RT-24⑩）。 */
  taskIds: string[]; changeSetIds: string[];
}

/** 父提交元信息（多父 diff 的选择面——第十四轮五）。 */
export interface CommitDiffParentMeta { oid: string; short: string; subject: string; timestamp: number }

export async function gitCommitDiff(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; oid: string; parentOid?: string }): Promise<{ commit: CommitDiffMeta; parentsMeta?: CommitDiffParentMeta[]; comparedParent?: string; patches: Array<{ path: string; oldPath?: string; change: string; binary: boolean; truncated: boolean; text: string }>; mergeNote?: string }> {
  if (!OID_RE.test(input.oid)) throw new GitWriteError('VALIDATION_INVALID', `非法提交对象 id：${input.oid}`);
  const loc = await repoGuard(input.projectRoot);
  const typeCap = await captureGit(['-C', loc.worktreeRoot, 'cat-file', '-t', input.oid], { capBytes: 4096 });
  if (typeCap.exitCode !== 0 || typeCap.stdout.toString('utf8').trim() !== 'commit') {
    throw new GitWriteError('RESOURCE_NOT_FOUND', `提交对象不存在：${input.oid}`);
  }
  const metaCap = await mustGit(['-C', loc.worktreeRoot, 'show', '-s', '--format=%P\x1f%an\x1f%ae\x1f%at\x1f%s', input.oid], { capBytes: 16 * 1024, what: 'show -s' });
  const [parentsRaw, an, ae, at, subject] = metaCap.stdout.toString('utf8').split('\x1f');
  const parents = (parentsRaw ?? '').trim().split(' ').filter((p) => p !== '');
  // 关联（仅操作日志——外部提交不虚构归属）。
  const opRow = db.prepare('SELECT task_id, change_set_ids_json FROM git_operations WHERE project_id = ? AND commit_oid = ?').get(input.projectId, input.oid) as { task_id: string | null; change_set_ids_json: string | null } | undefined;
  const taskIds = opRow?.task_id != null ? [opRow.task_id] : [];
  let changeSetIds: string[] = [];
  if (opRow?.change_set_ids_json != null) {
    try { changeSetIds = JSON.parse(opRow.change_set_ids_json) as string[]; } catch { /* 残缺不虚构 */ }
  }
  const commit: CommitDiffMeta = { oid: input.oid, parents, subject: (subject ?? '').trim(), authorName: an ?? '', authorEmail: ae ?? '', timestamp: Number(at ?? 0), taskIds, changeSetIds };
  // 多父 diff（第十四轮五）：数据与展示绑定所选父 OID——未选=只给父清单与注记（不虚构单一
  // “合并 diff”）；所选父必须是本提交的父（跨对象比较拒绝）。
  if (parents.length > 1) {
    const parentsMetaCap = await mustGit(['-C', loc.worktreeRoot, 'show', '-s', '--format=%H\x1f%h\x1f%s\x1f%at', ...parents], { capBytes: 16 * 1024, what: 'show -s parents' });
    const parentsMeta = parentsMetaCap.stdout.toString('utf8').split('\n').filter((l) => l.includes('\x1f')).map((line) => {
      const [pOid, pShort, pSubject, pAt] = line.split('\x1f');
      return { oid: (pOid ?? '').trim(), short: (pShort ?? '').trim(), subject: (pSubject ?? '').trim(), timestamp: Number(pAt ?? 0) };
    });
    if (input.parentOid == null) {
      return { commit, parentsMeta, patches: [], mergeNote: '合并提交：请选择比较父——差异=本提交相对所选父的实际变更（数据与展示绑定该父 OID）；不虚构单一"合并 diff"总览' };
    }
    if (!parents.includes(input.parentOid)) {
      throw new GitWriteError('VALIDATION_INVALID', `parentOid(${input.parentOid.slice(0, 8)}) 不是该提交的父——多父比较只接受本提交的父，拒绝跨对象比较`);
    }
    const patches = await collectDiffPatches(loc, [input.parentOid, input.oid]);
    return { commit, parentsMeta, comparedParent: input.parentOid, patches, mergeNote: `合并提交（对比父 ${input.parentOid.slice(0, 8)}）：差异=相对该父的实际变更——另一侧分支带来的变更会体现为相对此父的新增/修改，属预期语义` };
  }
  if (input.parentOid != null && input.parentOid !== parents[0]) {
    throw new GitWriteError('VALIDATION_INVALID', `parentOid(${input.parentOid.slice(0, 8)}) 不是该提交的父（单父提交）——拒绝跨对象比较`);
  }
  // 单父/根提交：diff-tree -r -M（机器身份 raw -z 复用解析）+ 逐文件正文（cap 同读面）。
  const patches = await collectDiffPatches(loc, ['--root', input.oid]);
  return { commit, patches };
}

/** diff-tree 逐文件聚合（treeRange：['--root', oid] 或 [parentOid, oid]——两形态同读面同容量）。 */
async function collectDiffPatches(loc: RepoLocation, treeRange: string[]): Promise<Array<{ path: string; oldPath?: string; change: string; binary: boolean; truncated: boolean; text: string }>> {
  const rawCap = await mustGit(['-C', loc.worktreeRoot, 'diff-tree', '-r', '-M', '-z', '--no-commit-id', '--no-textconv', '--no-ext-diff', ...treeRange], { capBytes: 256 * 1024, what: 'diff-tree' });
  const { parseRawZ } = await import('./gitStatus.ts');
  const entries = parseRawZ(rawCap.stdout.toString('utf8'));
  const CHANGE: Record<string, string> = { A: 'added', C: 'copied', D: 'deleted', M: 'modified', T: 'modified', R: 'renamed' };
  const patches: Array<{ path: string; oldPath?: string; change: string; binary: boolean; truncated: boolean; text: string }> = [];
  let budget = RT24_TOTAL_CAP;
  for (const entry of entries) {
    if (budget <= 0 || patches.length >= RT24_MAX_FILES) {
      patches.push({ path: entry.path, ...(entry.origPath != null ? { oldPath: entry.origPath } : {}), change: CHANGE[entry.status[0]!] ?? 'modified', binary: false, truncated: true, text: '' });
      continue;
    }
    const textCap = await captureGit(['-C', loc.worktreeRoot, 'diff-tree', '-r', '-M', '-p', '--no-commit-id', '--no-textconv', '--no-ext-diff', '--unified=3', ...treeRange, '--', entry.path], { capBytes: Math.min(RT24_PER_FILE_CAP, budget) + 1, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat' } });
    const text = textCap.stdout.toString('utf8');
    const binary = /^Binary files .* differ$/m.test(text);
    const truncated = text.length > RT24_PER_FILE_CAP;
    budget -= Math.min(text.length, RT24_PER_FILE_CAP);
    patches.push({ path: entry.path, ...(entry.origPath != null ? { oldPath: entry.origPath } : {}), change: CHANGE[entry.status[0]!] ?? 'modified', binary, truncated: truncated || textCap.truncated, text: binary ? '' : truncated ? `${text.slice(0, RT24_PER_FILE_CAP)}\n…（超限截断）` : text });
  }
  return patches;
}

/** URL/输出脱敏：scheme://user:pass@host 与 ?token=… 类凭据打码后才进消息/结果/日志。 */
export function redactRemoteText(text: string): string {
  return text
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]+@/g, '$1***@')
    .replace(/([?&](token|password|access_token|oauth_token|api_key)=)[^&\s]+/gi, '$1***');
}

/** 对**显式 URL** 查询分支头（推送链路核对——不经远端名二次解释 fetch/push 改写）。 */
export async function remoteHeadAtUrl(loc: RepoLocation, url: string, branch: string): Promise<string | null> {
  const cap = await captureGit(['-C', loc.worktreeRoot, 'ls-remote', url, `refs/heads/${branch}`], { capBytes: 16 * 1024 });
  if (cap.spawnError != null || cap.exitCode !== 0) {
    const stderr = cap.stderr.trim();
    if (/authentication|permission|could not read Username|授权|凭据|403|access denied/i.test(stderr)) {
      throw new GitWriteError('VALIDATION_INVALID', `目的地访问被拒（凭据/权限不足，AUTH_REQUIRED 语义；不修改任何全局配置、不回显凭据）：${stderr.slice(0, 120)}`);
    }
    throw new GitWriteError('GIT_COMMAND_FAILED', redactRemoteText(`ls-remote 失败（目的地 ${redactRemoteText(url)}）：${stderr.slice(0, 160)}`));
  }
  const line = cap.stdout.toString('utf8').split('	')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/**
 * 远端名当前**推送传输目的地**（第十三轮三）：
 * - `remote get-url --push`（pushurl 优先于 url——git 推送实际使用面）；
 * - `--all` 枚举：多 push URL **明确拒绝**（一次确认对应一个目的地——不静默向多个未确认
 *   目的地发送；RT-24 推送风险告知口径）；
 * - `--literal` 不在此用：我们核对的是**改写后**实际地址（url.<base>.pushInsteadOf/
 *   insteadOf 生效面）——确认值与执行值取同一改写后目的地，改写变化→复核拒绝；
 * - 返回值已脱敏（凭据不进结果/日志/回执）。
 */
export async function pushUrl(loc: RepoLocation, remote: string): Promise<string> {
  const all = await captureGit(['-C', loc.worktreeRoot, 'remote', 'get-url', '--push', '--all', remote], { capBytes: 16 * 1024 });
  if (all.exitCode !== 0) {
    throw new GitWriteError('RESOURCE_NOT_FOUND', `远端 ${remote} 未配置或地址不可解析（git remote get-url --push 失败）：${redactRemoteText(all.stderr.trim().slice(0, 120))}`);
  }
  const urls = all.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (urls.length === 0) {
    throw new GitWriteError('RESOURCE_NOT_FOUND', `远端 ${remote} 无推送地址`);
  }
  if (urls.length > 1) {
    throw new GitWriteError('VALIDATION_INVALID', `远端 ${remote} 配置了 ${urls.length} 个推送地址（多 push URL 不受支持——一次确认只能对应一个目的地；请先合并配置）：${urls.map(redactRemoteText).join(' 、 ')}`);
  }
  const url = urls[0]!;
  // URL 改写规则核对（第十三轮三）：get-url 返回**改写前**字面量（实测 pushInsteadOf 不在
  // get-url 生效面），而实际推送走改写后地址——确认值与执行值将不一致。受管推送**明确拒绝**
  // 受改写规则影响的目的地（不自行复刻 git 改写逻辑、不静默向不确定目的地发送）。
  const rulesCap = await captureGit(['-C', loc.worktreeRoot, 'config', '--get-regexp', '^url[.].*[.][pP][uU][sS][hH]?[iI][nN][sS][tT][eE][aA][dD][oO][fF]$'], { capBytes: 16 * 1024 });
  if (rulesCap.exitCode === 0) {
    for (const line of rulesCap.stdout.toString('utf8').split('\n')) {
      const m = /^url\.(.+)\.(push)?insteadof (.+)$/i.exec(line.trim());
      if (m == null) continue;
      if (url.startsWith(m[3]!)) {
        throw new GitWriteError('VALIDATION_INVALID', `推送地址 ${redactRemoteText(url)} 受 url.${m[1]}.${m[2] ?? ''}insteadOf 改写规则影响（实际推送目的地为改写后值，与确认面不一致）——受管推送不支持改写目的地；请移除该规则或直接配置最终地址`);
      }
    }
  }
  return url;
}

/** 远端分支当前头（ls-remote；无该分支=null）。AUTH 失败映射明确错误（不回显凭据）。 */
export async function remoteHead(loc: RepoLocation, remote: string, branch: string): Promise<string | null> {
  const cap = await captureGit(['-C', loc.worktreeRoot, 'ls-remote', remote, `refs/heads/${branch}`], { capBytes: 16 * 1024 });
  if (cap.spawnError != null || cap.exitCode !== 0) {
    const stderr = cap.stderr.trim();
    if (/authentication|permission|could not read Username|授权|凭据|403|access denied/i.test(stderr)) {
      throw new GitWriteError('VALIDATION_INVALID', `远端访问被拒（凭据/权限不足，AUTH_REQUIRED 语义；不修改任何全局配置、不回显凭据）：${stderr.slice(0, 120)}`);
    }
    throw new GitWriteError('GIT_COMMAND_FAILED', `ls-remote 失败（远端 ${remote}）：${stderr.slice(0, 160)}`);
  }
  const line = cap.stdout.toString('utf8').split('\t')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

export interface PushOutcome { remote: string; branch: string; from: string | null; to: string; replayed?: boolean; recovered?: boolean }

export async function gitPush(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; remote: string; branch: string; expectedHead: string; expectedRemoteHead: string | null; expectedRemoteUrl: string; journal: JournalInput }): Promise<PushOutcome> {
  const replay = replayIfReceipted<PushOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  const loc = await repoGuard(input.projectRoot);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as PushOutcome), replayed: true, recovered: true };
      // pending：远端状态未知即重查（下方按当前事实核对，push 幂等性=远端已=目标时视作已达成）。
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'push', request: { remote: input.remote, branch: input.branch, expectedHead: input.expectedHead, expectedRemoteHead: input.expectedRemoteHead } });
    }
    // 推送源=确认的不可变提交 OID（refspec 直接用 expectedHead）——本地分支/HEAD 在确认后
    // 前进不影响本次推送对象（第十二轮二）；不再要求本地 HEAD==确认值。
    // 目的地复核先于远端头校验：remote 配置变化（改指向/pushurl 替换/insteadOf 改写变化）
    // 是最根本的目的地不符。复核与确认取同一改写后推送目的地（get-url --push --all）。
    const urlNow = await pushUrl(loc, input.remote);
    if (urlNow !== input.expectedRemoteUrl) {
      throw new GitWriteError('STALE_REVISION', `远端 ${input.remote} 的实际推送地址已变化（确认 ${redactRemoteText(input.expectedRemoteUrl)} → 现在 ${redactRemoteText(urlNow)}）——推送目的地与确认不符，拒绝执行`);
    }
    // 远端头核验针对**已确认的推送目的地**（显式 URL）——ls-remote 经远端名读 fetch URL
    // （url≠pushurl 时核对对象错误）；确认/旧头/推送/结果核对同一目的地。
    const remote = await remoteHeadAtUrl(loc, input.expectedRemoteUrl, input.branch);
    if (remote === input.expectedHead) {
      // 崩溃重试窗口：推送已生效（远端=目标）——按既成事实收口。
      const result: PushOutcome = { remote: input.remote, branch: input.branch, from: input.expectedRemoteHead, to: input.expectedHead };
      const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'push', request: { remote: input.remote, branch: input.branch }, result });
      return { ...persisted.data, recovered: true };
    }
    if (remote !== input.expectedRemoteHead) {
      throw new GitWriteError('STALE_REVISION', `远端分支已被更新（期望 ${input.expectedRemoteHead ?? '（不存在）'} → 实际 ${remote ?? '（不存在）'}）——不覆盖他人结果；请刷新远端状态后重新确认`);
    }
    if (remote != null) {
      const ff = await captureGit(['-C', loc.worktreeRoot, 'merge-base', '--is-ancestor', remote, input.expectedHead], { capBytes: 4096 });
      if (ff.exitCode !== 0) {
        throw new GitWriteError('VALIDATION_INVALID', '推送不是快进（远端含本地没有的提交）——产品内不做强推（§14.6/RT-24）；请先拉取合并');
      }
    }
    // 执行对象绑定（第十二轮二）：refspec 源=用户确认的**不可变提交 OID**（不是可变本地分支）；
    // --force-with-lease=目标:确认旧头 ⇒ 远端旧头必须严格等于确认值（机械约束，非仅前置
    // ls-remote）；未确认的本地新提交不可能被发往远端。
    const push = await captureGit(['-C', loc.worktreeRoot, 'push', `--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteHead ?? ''}`, input.remote, `${input.expectedHead}:refs/heads/${input.branch}`], { capBytes: 32 * 1024 });
    if (push.exitCode !== 0) {
      const stderr = push.stderr.trim();
      if (/stale info|fetch first|rejected.*non-fast-forward|forced update/i.test(stderr)) {
        throw new GitWriteError('STALE_REVISION', redactRemoteText(`远端旧头与确认值不符或非快进——推送被拒（不覆盖远端结果）：${stderr.slice(0, 160)}`));
      }
      if (/timed out|connection|network|reset|unreachable|unable to access/i.test(stderr)) {
        throw new GitWriteError('STALE_REVISION', redactRemoteText(`推送网络失败——副作用不确定（远端可能已更新）：${stderr.slice(0, 120)}。同号重试将按远端现值核对（=目标则按既成事实收口；=确认旧值则重推；其他进人工核对）`));
      }
      throw new GitWriteError('GIT_COMMAND_FAILED', redactRemoteText(`推送失败：${stderr.slice(0, 200)}`));
    }
    const remoteAfter = await remoteHeadAtUrl(loc, input.expectedRemoteUrl, input.branch);
    if (remoteAfter !== input.expectedHead) {
      throw new GitWriteError('STALE_REVISION', redactRemoteText(`推送后远端核对不符（期望 ${input.expectedHead}，实际 ${remoteAfter ?? '无'}）——副作用不确定：同号重试按远端现值核对，不盲目重发`));
    }
    const result: PushOutcome = { remote: input.remote, branch: input.branch, from: input.expectedRemoteHead, to: input.expectedHead };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'push', request: { remote: input.remote, branch: input.branch, expectedHead: input.expectedHead, expectedRemoteHead: input.expectedRemoteHead }, result, headBefore: input.expectedRemoteHead, headAfter: input.expectedHead });
    return persisted.data;
  });
}

export interface PullOutcome { remote: string; branch: string; from: string; to: string; pulledCount: number; replayed?: boolean; recovered?: boolean }

export async function gitPull(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; remote: string; branch: string; expectedHead: string; journal: JournalInput }): Promise<PullOutcome> {
  const replay = replayIfReceipted<PullOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  const loc = await repoGuard(input.projectRoot);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as PullOutcome), replayed: true, recovered: true };
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'pull', request: { remote: input.remote, branch: input.branch, expectedHead: input.expectedHead } });
    }
    const branchNow = await currentBranchOf(loc);
    if (branchNow !== input.branch) throw new GitWriteError('STALE_REVISION', `当前分支 ${branchNow ?? 'detached'} ≠ 拉取分支 ${input.branch}——请刷新`);
    const headCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const head = headCap.exitCode === 0 ? headCap.stdout.toString('utf8').trim() : null;
    if (head !== input.expectedHead) throw new GitWriteError('STALE_REVISION', `本地 HEAD 已移动（期望 ${input.expectedHead} → ${head ?? '空'}）——请刷新后重试`);
    const fetch = await captureGit(['-C', loc.worktreeRoot, 'fetch', input.remote, input.branch], { capBytes: 32 * 1024 });
    if (fetch.exitCode !== 0) throw new GitWriteError('GIT_COMMAND_FAILED', redactRemoteText(`fetch 失败：${fetch.stderr.trim().slice(0, 160)}`));
    // 对象绑定（第十二轮二）：fetch 得到的对象先固化为 OID，合入执行用该 OID——不引用可变的
    // FETCH_HEAD 符号（外部并发 fetch 不改变本次合入对象）。
    const fetchedCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'FETCH_HEAD'], { capBytes: 4096 });
    if (fetchedCap.exitCode !== 0 || !OID_RE.test(fetchedCap.stdout.toString('utf8').trim())) {
      throw new GitWriteError('GIT_COMMAND_FAILED', 'fetch 后无法确定 FETCH_HEAD 对象——拒绝合入（不猜测）');
    }
    const fetchedOid = fetchedCap.stdout.toString('utf8').trim();
    const merge = await captureGit(['-C', loc.worktreeRoot, 'merge', '--ff-only', fetchedOid], { capBytes: 32 * 1024 });
    if (merge.exitCode !== 0) {
      throw new GitWriteError('VALIDATION_INVALID', redactRemoteText(`拉取不是快进（本地与远端分叉）：${merge.stderr.trim().slice(0, 160)}——产品内不自动产生合并提交；请先处理本地提交或用你自己的 git 客户端合并`));
    }
    const headAfterCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const headAfter = headAfterCap.exitCode === 0 ? headAfterCap.stdout.toString('utf8').trim() : null;
    const countCap = await captureGit(['-C', loc.worktreeRoot, 'rev-list', '--count', `${input.expectedHead}..${headAfter}`], { capBytes: 4096 });
    const result: PullOutcome = { remote: input.remote, branch: input.branch, from: input.expectedHead, to: headAfter ?? '', pulledCount: Number(countCap.stdout.toString('utf8').trim() || '0') };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'pull', request: { remote: input.remote, branch: input.branch, expectedHead: input.expectedHead }, result, headBefore: input.expectedHead, headAfter });
    return persisted.data;
  });
}

export interface ConflictContent { path: string; base: string | null; ours: string | null; theirs: string | null }

export async function gitConflictContent(input: { projectId: string; projectRoot: string; path: string }): Promise<ConflictContent> {
  const loc = await repoGuard(input.projectRoot, [input.path]);
  const status = await currentStatus(loc);
  if (!status.some((e) => e.path === input.path && isUnmergedXy(e.xy))) {
    throw new GitWriteError('VALIDATION_INVALID', `该路径当前不处于未合并（冲突）状态：${input.path}`);
  }
  const stage = async (n: 1 | 2 | 3): Promise<string | null> => {
    const cap = await captureGit(['-C', loc.worktreeRoot, 'show', `:${n}:${input.path}`], { capBytes: 64 * 1024 + 1 });
    if (cap.exitCode !== 0) return null;
    return cap.stdout.toString('utf8');
  };
  return { path: input.path, base: await stage(1), ours: await stage(2), theirs: await stage(3) };
}

export async function gitConflictResolve(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; path: string; content: string; journal: JournalInput }): Promise<{ path: string; resolved: true; replayed?: boolean; recovered?: boolean }> {
  const replay = replayIfReceipted<{ path: string; resolved: true; replayed?: boolean }>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  if (input.content.length > 4 * 1024 * 1024) throw new GitWriteError('VALIDATION_INVALID', '解决内容超限（>4MB）');
  const loc = await repoGuard(input.projectRoot, [input.path]);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as { path: string; resolved: true }), replayed: true, recovered: true };
      // pending：路径仍在冲突=未完成可重试；已不在冲突=已完成（下方校验会给出 satisfied）。
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'conflict_resolve', request: { path: input.path, contentHash: createHash('sha256').update(input.content).digest('hex') } });
    }
    const status = await currentStatus(loc);
    const stillConflicted = status.some((e) => e.path === input.path && isUnmergedXy(e.xy));
    if (!stillConflicted) {
      // 崩溃重试窗口：路径已解决——按既成事实收口（内容已由用户确认写入）。
      const result = { path: input.path, resolved: true as const };
      const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'conflict_resolve', request: { path: input.path }, result });
      return { ...persisted.data, recovered: true };
    }
    // 只接受手动解决内容（§14.6：不提供整文件「一键用某边覆盖」）——写工作区+add。
    const fsPath = join(loc.worktreeRoot, ...input.path.split('/'));
    writeFileSyncGuarded(fsPath, input.content);
    await mustGit(['-C', loc.worktreeRoot, 'add', '--', input.path], { env: writeEnv(true), what: 'add (conflict-resolve)' });
    const after = await currentStatus(loc);
    if (after.some((e) => e.path === input.path && isUnmergedXy(e.xy))) {
      throw new GitWriteError('GIT_COMMAND_FAILED', `解决后路径仍处于未合并状态：${input.path}——如实失败`);
    }
    const result = { path: input.path, resolved: true as const };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'conflict_resolve', request: { path: input.path }, result });
    return persisted.data;
  });
}

/** 同目录临时文件+rename 写入（与撤销链一致的防半写方式）。 */
function writeFileSyncGuarded(fsPath: string, content: string): void {
  const tmp = `${fsPath}.zs-resolve-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, fsPath);
}


export interface CommitUndoOutcome {
  undone: string;
  to: string;
  /** 本次回退的显式分支 ref（refs/heads/<branch>）——不依赖读 HEAD 猜结果。 */
  updatedRef: string;
  /** 提交内容回到暂存区的文件数（soft 语义：ref 回退，索引/工作区未动）。 */
  returnedToStaged: number;
  replayed?: boolean;
  recovered?: boolean;
}

export async function gitCommitUndo(db: ZhongshuoDatabase, input: {
  projectId: string; projectRoot: string; commitOid: string; expectedHead: string; expectedBranch: string;
  journal: JournalInput;
}): Promise<CommitUndoOutcome> {
  const replay = replayIfReceipted<CommitUndoOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  if (!OID_RE.test(input.commitOid)) throw new GitWriteError('VALIDATION_INVALID', `非法提交对象 id：${input.commitOid}`);
  const loc = await repoGuard(input.projectRoot);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
    const existing = getOperationRow(db, input.journal.commandId);
    if (existing != null) {
      requirePendingHashMatch(db, input.journal, existing);
      if (existing.status === 'done') return { ...(JSON.parse(existing.result_json ?? '{}') as CommitUndoOutcome), replayed: true };
      // pending 崩溃重试：按目标 ref 当前值核对已回退与否（不重复退到更早提交）。
    } else {
      beginPendingOperation(db, input.journal, { projectId: input.projectId, action: 'commit_undo', request: { commitOid: input.commitOid, expectedHead: input.expectedHead, expectedBranch: input.expectedBranch }, headBefore: input.expectedHead });
    }
    const branch = await currentBranchOf(loc);
    if (branch == null) throw new GitWriteError('VALIDATION_INVALID', 'detached HEAD——撤销提交要求分支上下文');
    if (branch !== input.expectedBranch) throw new GitWriteError('STALE_REVISION', `当前分支 ${branch} ≠ 批准分支 ${input.expectedBranch}——请刷新后重试`);
    const targetRef = `refs/heads/${input.expectedBranch}`;
    const refCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', '--verify', targetRef], { capBytes: 4096 });
    const refNow = refCap.exitCode === 0 && OID_RE.test(refCap.stdout.toString('utf8').trim()) ? refCap.stdout.toString('utf8').trim() : null;
    if (existing != null && existing.status === 'pending') {
      const parentProbe = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', `${input.commitOid}^`], { capBytes: 4096 });
      const parentOid = parentProbe.exitCode === 0 ? parentProbe.stdout.toString('utf8').trim() : null;
      if (refNow === parentOid) {
        const result0 = { undone: input.commitOid, to: parentOid!, updatedRef: targetRef, returnedToStaged: 0 };
        const persisted0 = persistOperation(db, input.journal, { projectId: input.projectId, action: 'commit_undo', request: { commitOid: input.commitOid, expectedHead: input.expectedHead, expectedBranch: input.expectedBranch }, result: result0, headAfter: parentOid });
        return { ...persisted0.data, recovered: true };
      }
      if (refNow !== input.commitOid) {
        throw new GitWriteError('STALE_REVISION', `中断重试核对：目标 ref 现值 ${refNow ?? '（不存在）'} 既非待撤销提交也非其父——进入人工核对，不重复回退`);
      }
      // refNow===commitOid：未回退——继续执行。
    }
    if (refNow !== input.commitOid || refNow !== input.expectedHead) {
      throw new GitWriteError('STALE_REVISION', `目标提交不是 ${targetRef} 当前值（ref=${refNow ?? '空'}；存在后续提交/已回退/外部推进）——只允许撤销分支最新提交，不做任何历史改写`);
    }
    const metaCap = await captureGit(['-C', loc.worktreeRoot, 'show', '-s', '--format=%P', input.commitOid], { capBytes: 4096 });
    const parents = metaCap.exitCode === 0 ? metaCap.stdout.toString('utf8').trim().split(' ').filter((x) => x !== '') : [];
    if (parents.length > 1) {
      throw new GitWriteError('VALIDATION_INVALID', '该提交是合并提交（多父）——软撤销语义未定义，不默认选第一个父提交；请人工处理或用你自己的 git 客户端');
    }
    if (parents.length === 0) throw new GitWriteError('VALIDATION_INVALID', '根提交不可软撤销——请人工处理');
    const parent = parents[0]!;
    // 操作前事实：索引 tree 身份 + porcelain 快照（撤销后必须逐一不变——A/B 无损证明）。
    const indexTreeBefore = await writeTreeOf(loc);
    const statusBefore = await currentStatus(loc);
    // 重叠检测：提交涉及文件 ∩ 撤销前已暂存条目 ≠ ∅ → 无法无损区分（提交内容会与用户暂存
    // 同处索引）——明确拒绝，不先执行再提示。
    const commitFiles = new Set<string>();
    const rawCap = await captureGit(['-C', loc.worktreeRoot, 'diff-tree', '-r', '-M', '-z', '--no-commit-id', '--no-textconv', '--no-ext-diff', input.commitOid], { capBytes: 256 * 1024 });
    if (rawCap.exitCode === 0) {
      const { parseRawZ } = await import('./gitStatus.ts');
      for (const entry of parseRawZ(rawCap.stdout.toString('utf8'))) commitFiles.add(entry.path);
    }
    const stagedBefore = new Set(statusBefore.filter((e) => e.category === 'staged').map((e) => e.path));
    const overlap = [...commitFiles].filter((f) => stagedBefore.has(f));
    if (overlap.length > 0) {
      throw new GitWriteError('VALIDATION_INVALID', `提交涉及文件与当前已暂存内容重叠（${overlap.slice(0, 5).join('、')}${overlap.length > 5 ? ' 等' : ''}）——软撤销无法无损保留你的暂存版本与提交内容；请先提交/取消暂存重叠文件，或用你自己的 git 客户端处理`);
    }
    // 执行：仅回退目标 ref（比较交换）——索引与工作区完全不动（soft 语义：提交差异相对新
    // ref 呈现为已暂存）。无 reset --mixed（它会改写索引、丢失用户暂存内容）。
    const cas = await updateRefCas(loc, targetRef, parent, input.commitOid);
    if (!cas.ok) {
      throw new GitWriteError('STALE_REVISION', `目标 ref ${targetRef} 比较交换失败（现值 ${cas.current ?? '（不存在）'}）——未回退任何对象：${cas.stderr}`.slice(0, 240));
    }
    // 核对：ref=parent；索引 tree 与 porcelain 与操作前逐一一致（A 与 B 均未丢失的直接证明）。
    const refAfterCap = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', '--verify', targetRef], { capBytes: 4096 });
    const refAfter = refAfterCap.exitCode === 0 ? refAfterCap.stdout.toString('utf8').trim() : null;
    if (refAfter !== parent) throw new GitWriteError('GIT_COMMAND_FAILED', `回退后目标 ref 核对不符（期望 ${parent}，实际 ${refAfter ?? '空'}）——如实失败，请人工核对`);
    const indexTreeAfter = await writeTreeOf(loc);
    if (indexTreeAfter !== indexTreeBefore) throw new GitWriteError('GIT_COMMAND_FAILED', '回退后索引内容身份变化（不应发生——软撤销不改索引）——如实失败，请人工核对');
    const statusAfter = await currentStatus(loc);
    // 核对语义（第十二轮三）：软回退后，porcelain 允许的变化**仅限提交涉及的文件**（其差异
    // 以已暂存形式重现——soft 语义本身）；其余条目（用户已有暂存/未暂存内容）必须逐一不变。
    const lineOf = (e: { xy: string; path: string; renamedFrom?: string }) => `${e.xy}\t${e.path}${e.renamedFrom != null ? `\t${e.renamedFrom}` : ''}`;
    const beforeLines = new Set(statusBefore.map(lineOf));
    const afterLines = new Set(statusAfter.map(lineOf));
    const changedPaths = new Set<string>();
    for (const line of [...beforeLines].filter((l) => !afterLines.has(l)).concat([...afterLines].filter((l) => !beforeLines.has(l)))) {
      changedPaths.add(line.split('\t')[1] ?? line);
    }
    const unexpected = [...changedPaths].filter((f) => !commitFiles.has(f));
    if (unexpected.length > 0) {
      throw new GitWriteError('GIT_COMMAND_FAILED', `回退后工作区/暂存状态出现提交文件之外的变化（${unexpected.slice(0, 5).join('、')}）——软撤销不应触碰这些内容，如实失败请人工核对`);
    }
    const result: CommitUndoOutcome = { undone: input.commitOid, to: parent, updatedRef: targetRef, returnedToStaged: commitFiles.size };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'commit_undo', request: { commitOid: input.commitOid, expectedHead: input.expectedHead, expectedBranch: input.expectedBranch }, result, headBefore: input.expectedHead, headAfter: parent });
    return persisted.data;
  });
}
