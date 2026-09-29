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
import { resolve } from 'node:path';
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

/** 操作日志落库 + 命令回执（同一事务；日志已存在时不重复插入；emit=同事务领域事件）。 */
function persistOperation<T extends object>(
  db: ZhongshuoDatabase,
  journal: JournalInput,
  row: { projectId: string; action: 'stage' | 'unstage' | 'stage_task' | 'commit' | 'commit_undo'; taskId?: string | null; changeSetIds?: string[]; request: unknown; result: T; headBefore?: string | null; headAfter?: string | null; commitOid?: string | null; emit?: () => void },
): { replayed: boolean; data: T } {
  const outcome = runCommand<T>(db, { idempotencyScope: journal.scope, commandId: journal.commandId, payloadHash: journal.payloadHash, now: journal.now }, () => {
    db.prepare(
      `INSERT OR IGNORE INTO git_operations (id, project_id, action, task_id, change_set_ids_json, request_json, result_json, head_before, head_after, commit_oid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      journal.commandId, row.projectId, row.action, row.taskId ?? null,
      row.changeSetIds != null ? JSON.stringify(row.changeSetIds) : null,
      JSON.stringify(row.request), JSON.stringify(row.result),
      row.headBefore ?? null, row.headAfter ?? null, row.commitOid ?? null, journal.now,
    );
    row.emit?.();
    return row.result;
  });
  if (!outcome.ok) throw new GitWriteError(outcome.error.code === 'IDEMPOTENCY_CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'STORAGE_UNAVAILABLE', outcome.error.message, { details: outcome.error.details });
  return { replayed: outcome.replayed, data: outcome.data };
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

export async function gitUnstage(db: ZhongshuoDatabase, input: { projectId: string; projectRoot: string; paths: string[]; journal: JournalInput }): Promise<StageOutcome> {
  const replay = replayIfReceipted<StageOutcome>(db, input.journal);
  if (replay != null) return { ...replay.data, replayed: true };
  if (input.paths.length === 0 || input.paths.length > MAX_PATHS_PER_CALL) {
    throw new GitWriteError('VALIDATION_INVALID', `paths 数量须在 1..${MAX_PATHS_PER_CALL}`);
  }
  const loc = await repoGuard(input.projectRoot, input.paths);
  return withRepoWriteLock(loc.worktreeRoot, async () => {
    assertWritable(db, input.projectId, input.projectRoot);
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

// ---------- 按任务/改动集批量暂存（§14.2：跳过 userPreExisting） ----------

interface ChangeSetRowInfo {
  id: string;
  manifest: { scopeKind?: string; truncated?: boolean; scanFailedDirs?: number; scanRejected?: number; preimageRoot?: string; git?: { head?: string | null; dirtyPaths?: string[] | null } };
  beforeByPath: Map<string, { state: string; sha256: string | null; contentRef: string | null; contentUnavailable: string | null }>;
  afterByPath: Map<string, { state: string; sha256: string | null }>;
}

function loadChangeSetRows(db: ZhongshuoDatabase, changeSetId: string): ChangeSetRowInfo | null {
  const row = db.prepare('SELECT id, manifest_json FROM change_sets WHERE id = ?').get(changeSetId) as { id: string; manifest_json: string | null } | undefined;
  if (row == null) return null;
  const manifest = JSON.parse(row.manifest_json ?? '{}') as ChangeSetRowInfo['manifest'];
  const mk = (role: 'before' | 'after') => new Map(
    (db.prepare('SELECT path, state, sha256, content_ref, content_unavailable FROM change_set_files WHERE change_set_id = ? AND role = ?').all(changeSetId, role) as Array<{ path: string; state: string; sha256: string | null; content_ref: string | null; content_unavailable: string | null }>)
      .map((r) => [r.path, role === 'before'
        ? { state: r.state, sha256: r.sha256, contentRef: r.content_ref, contentUnavailable: r.content_unavailable }
        : { state: r.state, sha256: r.sha256, contentRef: null, contentUnavailable: null }] as [string, { state: string; sha256: string | null; contentRef: string | null; contentUnavailable: string | null }]),
  );
  return { id: row.id, manifest, beforeByPath: mk('before'), afterByPath: mk('after') };
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
  const loc = await repoGuard(input.projectRoot);
  assertNoActiveLeases(db, input.projectRoot);
  // 目标改动集：指定 changeSetId，或该任务全部已定型（after_ref 非空）改动集，按 rowid 序。
  const ids: string[] = input.changeSetId != null
    ? [input.changeSetId]
    : (db.prepare(`SELECT id FROM change_sets WHERE task_id = ? AND after_ref != '' ORDER BY rowid`).all(input.taskId!) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) throw new GitWriteError('RESOURCE_NOT_FOUND', input.taskId != null ? `任务 ${input.taskId} 没有已定型的改动集（无 after 前像）——先经正式链路定型` : `改动集不存在：${input.changeSetId}`);
  const sets: ChangeSetRowInfo[] = [];
  for (const id of ids) {
    const cs = loadChangeSetRows(db, id);
    if (cs == null) throw new GitWriteError('RESOURCE_NOT_FOUND', `改动集不存在：${id}`);
    sets.push(cs);
  }
  const included: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const conflicts: Array<{ path: string; reason: string }> = [];
  const decided = new Map<string, 'include' | 'skip' | 'conflict'>();
  for (const cs of sets) {
    const { changed, undeterminable } = taskChangedPathsOf(cs, loc);
    for (const u of undeterminable) {
      if (decided.get(u.path) !== 'conflict') { decided.set(u.path, 'conflict'); conflicts.push({ path: u.path, reason: `${u.reason}（改动集 ${cs.id}）` }); }
    }
    const { dirty, unverifiable } = await baselineDirtyPaths(cs, loc, changed);
    for (const u of unverifiable) {
      if (decided.get(u.path) !== 'conflict') { decided.set(u.path, 'conflict'); conflicts.push({ path: u.path, reason: `${u.reason}（改动集 ${cs.id}）` }); }
    }
    for (const wt of changed) {
      if (decided.has(wt)) continue;
      if (dirty.has(wt)) {
        // 用户原有改动 + 任务改动同文件：整文件暂存会把用户改动一并纳入——不自动代做（§14.2）。
        decided.set(wt, 'conflict');
        conflicts.push({ path: wt, reason: `任务开始前该文件已有用户未提交改动，与任务改动无法按文件分离——请单独确认（改动集 ${cs.id}）` });
        continue;
      }
      decided.set(wt, 'include');
      included.push(wt);
    }
    for (const wt of dirty) {
      if (!decided.has(wt)) {
        decided.set(wt, 'skip');
        skipped.push({ path: wt, reason: 'userPreExisting：任务开始前已存在的用户改动——批量暂存默认跳过，需用户显式操作' });
      }
    }
  }
  if (included.length > 0) {
    await mustGit(['-C', loc.worktreeRoot, 'add', '--', ...included], { env: writeEnv(true), what: 'add (batch)' });
  }
  const result: StageTaskOutcome = { changeSetIds: ids, included, skipped, conflicts };
  const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'stage_task', taskId: input.taskId ?? null, changeSetIds: ids, request: { taskId: input.taskId ?? null, changeSetId: input.changeSetId ?? null }, result });
  return persisted.data;
}

// ---------- 提交预览 / 提交 ----------

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
async function updateHeadCas(loc: RepoLocation, newOid: string, expectedOld: string | null): Promise<{ ok: true } | { ok: false; current: string | null; stderr: string }> {
  const cap = await captureGit(['-C', loc.worktreeRoot, 'update-ref', 'HEAD', newOid, expectedOld ?? ZERO_OID], { capBytes: 8192 });
  if (cap.spawnError == null && cap.exitCode === 0) return { ok: true };
  const cur = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
  return { ok: false, current: cur.exitCode === 0 && OID_RE.test(cur.stdout.toString('utf8').trim()) ? cur.stdout.toString('utf8').trim() : null, stderr: cap.stderr.trim().slice(0, 200) };
}

/** 当前分支（symbolic-ref --short）；detached HEAD 返回 null。 */
async function currentBranchOf(loc: RepoLocation): Promise<string | null> {
  const cap = await captureGit(['-C', loc.worktreeRoot, 'symbolic-ref', '--short', 'HEAD'], { capBytes: 4096 });
  if (cap.exitCode !== 0) return null;
  return cap.stdout.toString('utf8').trim() || null;
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
        '产品内提交经「write-tree → commit-tree → update-ref（带期望旧值）」原子完成：提交对象由预览时的索引 tree 直接构造，HEAD 用比较交换推进——预览后内容或分支变化都会拒绝。',
        '该路径不执行 pre-commit/post-commit 钩子、不使用 commit 模板与 gpg 签名配置；需要钩子的提交请用你自己的 git 客户端。',
      ],
    };
  }
}

export interface CommitOutcome {
  /** 本次构造并落 ref 的提交对象（commit-tree 返回——我们自己知道的 oid）。 */
  commit: string;
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
  // 既成事实①：操作日志已记录（回执丢失场景）——按日志重放结果。
  const journaled = db.prepare('SELECT result_json FROM git_operations WHERE id = ?').get(input.journal.commandId) as { result_json: string } | undefined;
  if (journaled != null) {
    const result = JSON.parse(journaled.result_json) as CommitOutcome;
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'commit', taskId: input.taskId ?? null, changeSetIds: input.changeSetIds, request: { message: input.message, expectedHead: input.expectedHead }, result, headBefore: input.expectedHead, headAfter: result.commit, commitOid: result.commit });
    return { ...persisted.data, recovered: true };
  }
  // 既成事实②：提交尾部标记命中（git 提交已发生、日志与回执均未落库的崩溃窗口）。
  const trailerHit = await findCommitByTrailer(loc, input.journal.commandId, input.expectedHead);
  if (trailerHit != null) {
    const result: CommitOutcome = { commit: trailerHit.oid, headBefore: input.expectedHead, subject: trailerHit.subject, recovered: true };
    const persisted = persistOperation(db, input.journal, { projectId: input.projectId, action: 'commit', taskId: input.taskId ?? null, changeSetIds: input.changeSetIds, request: { message: input.message, expectedHead: input.expectedHead }, result, headBefore: input.expectedHead, headAfter: result.commit, commitOid: result.commit });
    return persisted.data;
  }
  // 执行链（全程持仓库写锁）：预览比对 → 冻结 tree 构造提交 → update-ref CAS → 提交后核对。
  return withRepoWriteLock(loc.worktreeRoot, async () => {
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
    const cas = await updateHeadCas(loc, ourOid, input.expectedHead);
    if (!cas.ok) {
      throw new GitWriteError('STALE_REVISION', `HEAD 比较交换失败（外部已推进：当前 ${cas.current ?? '空'}）——本次提交未落 ref，未覆盖外部结果：${cas.stderr}`.slice(0, 300));
    }
    if (input._between != null) await input._between();
    // 提交后核对：HEAD/分支/tree 必须与批准对象一致；不一致＝外部又推进——如实记录并留痕，
    // 不自动 reset、不撤销用户修改（进入核对流程）。
    const verifyHead = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', 'HEAD'], { capBytes: 4096 });
    const headAfterActual = verifyHead.exitCode === 0 ? verifyHead.stdout.toString('utf8').trim() : null;
    const branchAfter = await currentBranchOf(loc);
    const treeVerify = await captureGit(['-C', loc.worktreeRoot, 'rev-parse', `${ourOid}^{tree}`], { capBytes: 4096 });
    const treeOk = treeVerify.exitCode === 0 && treeVerify.stdout.toString('utf8').trim() === treeNow;
    const consistent = headAfterActual === ourOid && branchAfter === input.expectedBranch && treeOk;
    const result: CommitOutcome = {
      commit: ourOid,
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
          payload: { commit: ourOid, headAfterActual, branchAfter, taskId: input.taskId ?? null, subject, note: consistent ? undefined : 'CAS 后外部又推进 HEAD——本次提交对象为 commit 字段，仓库现值见 headAfterActual；不自动回滚，请人工核对' },
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
