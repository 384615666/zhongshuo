/**
 * DEV-12 主体：Git/非 Git 基线、前后前像、差异与非破坏撤销（2026-09-28 第五轮）。
 *
 * 条款映射：
 * - §14.2 基线：Git 目录记录 HEAD + 索引状态（porcelain）+ 范围内工作区内容前像（含未跟踪
 *   文件——不降级为仅 ref）；非 Git 目录按显式路径清单或整目录扫描做内容级前像（E15）。
 *   超大文件超出快照上限 → contentUnavailable（内容级撤销不可用，提前呈现）。
 * - §14.5 撤销：仅当当前文件仍匹配本变更 after 状态才按 before 恢复；后续被用户/其他任务
 *   修改的文件记冲突（不覆盖，人工处理）；新增/修改/删除分别处理（撤销新增文件也先确认
 *   仍是本次产生的内容）；unknown 不自动撤销；不使用任何 reset --hard/强制 checkout/删除
 *   项目的 Git 历史操作（本模块只做文件级内容恢复）。
 * - §14.1/RT-07/RT-08 单写者：undo 执行前检查 workspace_leases 重叠活跃租约（有则拒绝并列出
 *   持有者）；同项目同时只允许一个进行中的 undo（change_set_undos 活跃行互斥）。undo 自身
 *   不登记 workspace_leases 行（该表 owner 为 turn——FK 语义保留给派发写档，B6 接线）。
 *
 * 原子性与恢复：单文件内容恢复走「同目录临时文件+回读核对+rename」；多文件操作不声称
 * 整体原子——逐步执行、每步结果即时持久化（steps_json），中断/失败后按步幂等重验恢复。
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';
import {
  captureFilePreimage, diffPreimages, readStoredContent, scanDirectoryFiles,
  type PreimageCapture, type PreimageEntry,
} from './preimage.ts';
import { comparisonKey, lockDomainsOverlap } from './directoryIdentity.ts';
import { listActiveLeases } from './workspaceLocks.ts';

// ---------- 类型 ----------

export interface GitBaseline {
  isRepo: boolean;
  /** HEAD commit（40 位）；探测失败为 null 并如实记录 error。 */
  head: string | null;
  /** 索引状态（porcelain 输出，截断保留；不是当前工作区 diff 的替代——内容前像另有）。 */
  indexStatus: string | null;
  error?: string;
}

export interface ChangeSetFileRow {
  role: 'before' | 'after';
  path: string;
  state: 'present' | 'absent' | 'unknown';
  sha256: string | null;
  size: number | null;
  content_ref: string | null;
  content_unavailable: string | null;
  error: string | null;
}

export type UndoStepAction = 'restore-content' | 'delete-added' | 'restore-removed';

export interface UndoStep {
  path: string;
  action: UndoStepAction;
  /** 执行前必须匹配的当前状态（§14.5：当前仍匹配 after 才可撤销）。 */
  expectState: 'present' | 'absent';
  expectSha256?: string;
  /** 恢复用的内容引用（restore-* 动作）。 */
  contentRef?: string;
  status: 'pending' | 'done' | 'conflict' | 'failed' | 'manual';
  detail?: string;
}

export interface UndoOutcome {
  undoId: string;
  status: 'succeeded' | 'failed' | 'conflict';
  steps: UndoStep[];
  /** 冲突/手工/失败路径（不自动处理——三方内容查看/人工决策归 UI 层）。 */
  manualPaths: string[];
}

// ---------- Git 基线 ----------

/** Git HEAD/索引状态探测（本地 git 进程只读调用；失败如实记录，不假装非仓库）。 */
export function captureGitBaseline(root: string): GitBaseline {
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.error != null || head.status !== 0) {
    const notRepo = head.stderr != null && /not a git repository/i.test(head.stderr);
    if (notRepo) return { isRepo: false, head: null, indexStatus: null };
    return { isRepo: true, head: null, indexStatus: null, error: `git rev-parse 失败：${String(head.stderr ?? head.error).slice(0, 160)}` };
  }
  const porcelain = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return {
    isRepo: true,
    head: head.stdout.trim(),
    indexStatus: porcelain.status === 0 ? porcelain.stdout.slice(0, 64 * 1024) : null,
  };
}

// ---------- 基线捕获 / 差异定型 ----------

export interface CaptureBaselineInput {
  projectId: string;
  /** 变更归属（运行/任务身份连接——change_sets 行携带；均可空=项目级手动基线）。 */
  taskId?: string | null;
  runId?: string | null;
  /** 显式变更面（相对项目根的路径列表）；缺省=整目录扫描（非 Git 整目录语义，E15）。 */
  paths?: string[];
  /** 单文件内容存储上限覆盖（策略参数；缺省用 env/默认 8MB）。 */
  maxBytes?: number;
  appDataDir: string;
  now?: number;
}

export interface CaptureBaselineOk {
  changeSetId: string;
  captureId: string;
  git: GitBaseline;
  fileCount: number;
  contentUnavailable: string[];
  truncated: boolean;
}

/** 基线捕获：Git 基线（HEAD+索引状态）+ before 内容前像（含未跟踪文件，不 stash/reset）。 */
export function captureBaseline(db: ZhongshuoDatabase, input: CaptureBaselineInput): DomainResult<CaptureBaselineOk> {
  const project = lookupProject(db, input.projectId);
  if (project == null) return domainErr('RESOURCE_NOT_FOUND', `项目不存在：${input.projectId}`);
  const now = input.now ?? Date.now();
  const root = project.canonical_path;
  const storeDir = join(input.appDataDir, 'preimages', input.projectId);
  const explicit = input.paths != null && input.paths.length > 0;
  const scanned = explicit ? null : scanDirectoryFiles(root);
  const paths = explicit ? input.paths! : scanned!.files.map((f) => f.slice(root.length + 1));
  const git = captureGitBaseline(root);
  const preimage = captureFilePreimage(root, paths, { storeDir, now, maxBytes: input.maxBytes });
  const changeSetId = `cs_${randomUUID()}`;
  const beforeRef = JSON.stringify({
    kind: 'preimage',
    captureId: preimage.captureId,
    capturedAt: preimage.capturedAt,
    git: { isRepo: git.isRepo, head: git.head, indexStatusHash: git.indexStatus != null ? createHash('sha256').update(git.indexStatus).digest('hex') : null, error: git.error ?? null },
  });
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO change_sets (id, project_id, task_id, before_ref, after_ref, application_status, manifest_json)
       VALUES (?, ?, ?, ?, '', 'not_applied', ?)`,
    ).run(changeSetId, input.projectId, input.taskId ?? null, beforeRef, JSON.stringify({
      git,
      preimageRoot: preimage.root,
      scopeKind: explicit ? 'explicit-paths' : 'directory-scan',
      truncated: scanned?.truncated ?? false,
    }));
    insertPreimageRows(db, changeSetId, 'before', preimage.entries);
    emitChangesetEvent(db, input.projectId, input.taskId ?? null, input.runId ?? null, 'changeset.baselineCaptured', {
      changeSetId, captureId: preimage.captureId, isRepo: git.isRepo, gitHead: git.head,
      fileCount: preimage.entries.length,
      contentUnavailable: preimage.entries.filter((e) => e.contentUnavailable != null).map((e) => e.path),
      truncated: scanned?.truncated ?? false,
    }, now);
  });
  tx();
  return domainOk({
    changeSetId,
    captureId: preimage.captureId,
    git,
    fileCount: preimage.entries.length,
    contentUnavailable: preimage.entries.filter((e) => e.contentUnavailable != null).map((e) => e.path),
    truncated: scanned?.truncated ?? false,
  });
}

/** 差异定型：捕获 after 前像 + diff 入库；直接原目录模式下变更已发生 → application_status='applied'（§14.3）。 */
export function finalizeChangeset(
  db: ZhongshuoDatabase,
  input: { changeSetId: string; appDataDir: string; now?: number },
): DomainResult<{ diff: { added: string[]; removed: string[]; modified: string[]; undeterminable: Array<{ path: string; reason: string }> } }> {
  const row = loadChangeSet(db, input.changeSetId);
  if (row == null) return domainErr('RESOURCE_NOT_FOUND', `改动集不存在：${input.changeSetId}`);
  if (row.after_ref.length > 0) return domainErr('STALE_REVISION', `改动集已定型（after 已冻结）：${input.changeSetId}`);
  const project = lookupProject(db, row.project_id);
  if (project == null) return domainErr('RESOURCE_NOT_FOUND', `项目不存在：${row.project_id}`);
  const now = input.now ?? Date.now();
  const root = project.canonical_path;
  const storeDir = join(input.appDataDir, 'preimages', row.project_id);
  const beforeRows = loadFileRows(db, input.changeSetId, 'before');
  if (beforeRows.length === 0) return domainErr('STALE_REVISION', `改动集缺少 before 前像：${input.changeSetId}`);
  // after 捕获面：
  // - directory-scan（整目录语义）：重扫目录（任务新增文件须进捕获面）∪ before 路径
  //   （被删文件须仍被核对）——重扫截断与 before 截断同样如实记录；
  // - explicit-paths：变更面=基线声明的清单（含「将创建」的文件须在基线清单里声明）。
  const manifest = safeParse(row.manifest_json ?? '{}') as { scopeKind?: string; truncated?: boolean };
  const isScan = manifest.scopeKind === 'directory-scan';
  const scanNow = isScan ? scanDirectoryFiles(root) : null;
  const afterPaths = isScan
    ? [...new Set([...scanNow!.files.map((f) => f.slice(root.length + 1).replaceAll('\\', '/')), ...beforeRows.map((r) => r.path)])]
    : beforeRows.map((r) => r.path);
  // 扫描面的基线事实补全：after 有而 before 无行 → 变更前不存在（整目录扫描完整时）；
  // 首扫/重扫截断 → unknown（不能断定变更前不存在，§三态纪律）。
  const beforeTruncated = manifest.truncated === true || scanNow?.truncated === true;
  const beforeByPath = new Map(beforeRows.map((r) => [r.path, r]));
  const beforeEntries: PreimageEntry[] = beforeRows.map(rowToEntry);
  const synthesizedBefore: PreimageEntry[] = [];
  if (isScan) {
    for (const p of afterPaths) {
      if (!beforeByPath.has(p)) {
        const entry: PreimageEntry = beforeTruncated
          ? { path: p, state: 'unknown', error: '目录扫描截断——无法断定变更前状态' }
          : { path: p, state: 'absent' };
        beforeEntries.push(entry);
        synthesizedBefore.push(entry); // 持久化为 before 事实（撤销计划依据）
      }
    }
  }
  const beforeCapture: PreimageCapture = { captureId: `replay_${row.id}`, capturedAt: 0, root, entries: beforeEntries };
  const after = captureFilePreimage(root, afterPaths, { storeDir, now });
  const diff = diffPreimages(beforeCapture, after);
  const afterRef = JSON.stringify({ kind: 'preimage', captureId: after.captureId, capturedAt: after.capturedAt });
  const tx = db.transaction(() => {
    if (synthesizedBefore.length > 0) insertPreimageRows(db, input.changeSetId, 'before', synthesizedBefore);
    insertPreimageRows(db, input.changeSetId, 'after', after.entries);
    db.prepare(`UPDATE change_sets SET after_ref = ?, application_status = 'applied' WHERE id = ?`).run(afterRef, input.changeSetId);
    emitChangesetEvent(db, row.project_id, row.task_id, null, 'changeset.finalized', {
      changeSetId: input.changeSetId,
      added: diff.added, removed: diff.removed, modified: diff.modified, undeterminable: diff.undeterminable,
    }, now);
  });
  tx();
  return domainOk({ diff });
}

// ---------- 非破坏撤销 ----------

/** 撤销计划：逐文件按 before/after 三态推导动作与执行前校验（§14.5）。 */
export function planUndoSteps(before: ChangeSetFileRow[], after: ChangeSetFileRow[]): UndoStep[] {
  const afterByPath = new Map(after.map((r) => [r.path, r]));
  const steps: UndoStep[] = [];
  for (const b of before) {
    const a = afterByPath.get(b.path);
    if (a == null) continue;
    if (b.state === 'unknown' || a.state === 'unknown') {
      steps.push({ path: b.path, action: 'restore-content', expectState: 'present', status: 'manual', detail: `状态未知（before=${b.state}，after=${a.state}）——不自动撤销` });
      continue;
    }
    if (b.state === 'present' && a.state === 'present' && b.sha256 !== a.sha256) {
      // 修改：当前须仍是 after 内容 → 恢复 before 内容。
      if (b.content_ref == null) {
        steps.push({ path: b.path, action: 'restore-content', expectState: 'present', expectSha256: a.sha256 ?? undefined, status: 'manual', detail: b.content_unavailable ?? 'before 内容不可恢复（无受管理内容引用）' });
      } else {
        steps.push({ path: b.path, action: 'restore-content', expectState: 'present', expectSha256: a.sha256 ?? undefined, contentRef: b.content_ref, status: 'pending' });
      }
      continue;
    }
    if (b.state === 'absent' && a.state === 'present') {
      // 新增：当前须仍是本次产生的内容（hash 匹配 after）→ 删除。
      steps.push({ path: b.path, action: 'delete-added', expectState: 'present', expectSha256: a.sha256 ?? undefined, status: 'pending' });
      continue;
    }
    if (b.state === 'present' && a.state === 'absent') {
      // 删除：当前须仍不存在 → 按 before 内容恢复。
      if (b.content_ref == null) {
        steps.push({ path: b.path, action: 'restore-removed', expectState: 'absent', status: 'manual', detail: b.content_unavailable ?? 'before 内容不可恢复（无受管理内容引用）' });
      } else {
        steps.push({ path: b.path, action: 'restore-removed', expectState: 'absent', contentRef: b.content_ref, status: 'pending' });
      }
      continue;
    }
    // 无变化（present→present 同 hash / absent→absent）：无需撤销。
  }
  return steps;
}

export interface UndoInput {
  changeSetId: string;
  appDataDir: string;
  now?: number;
  /** 测试注入：执行到第 N 个 pending 步后抛出（模拟中途失败/中断——恢复语义验证）。 */
  failAfterSteps?: number;
}

/** 非破坏撤销（幂等可恢复）：已有进行中/失败的撤销记录 → 按持久化步骤续跑（不重算计划）。 */
export function undoChangeset(db: ZhongshuoDatabase, input: UndoInput): DomainResult<UndoOutcome> {
  const row = loadChangeSet(db, input.changeSetId);
  if (row == null) return domainErr('RESOURCE_NOT_FOUND', `改动集不存在：${input.changeSetId}`);
  if (row.after_ref.length === 0) return domainErr('STALE_REVISION', `改动集未定型（缺 after 前像）：${input.changeSetId}`);
  const project = lookupProject(db, row.project_id);
  if (project == null) return domainErr('RESOURCE_NOT_FOUND', `项目不存在：${row.project_id}`);
  const now = input.now ?? Date.now();
  const root = project.canonical_path;

  // 单写者约束：重叠锁域存在活跃/过期租约 → 拒绝并列持有者（§14.1/RT-08；expired 同样阻塞，RT-07）。
  const lockCheck = checkNoOverlappingLease(db, root);
  if (lockCheck != null) return lockCheck;
  // 同项目互斥：只允许一个进行中的撤销（undo 自身不占 workspace_leases——owner 为 turn 的 FK 语义留给派发写档）。
  const activeOther = db.prepare(
    `SELECT u.id FROM change_set_undos u JOIN change_sets cs ON cs.id = u.change_set_id
     WHERE cs.project_id = ? AND u.status = 'in_progress' AND u.change_set_id != ?`,
  ).get(row.project_id, input.changeSetId) as { id: string } | undefined;
  if (activeOther != null) return domainErr('STALE_REVISION', `该项目已有进行中的撤销（${activeOther.id}）——单写者互斥`);

  // 续跑或新建：进行中/失败的记录按持久化步骤恢复；已 succeeded 的撤销不重复执行。
  const existing = db.prepare(
    `SELECT * FROM change_set_undos WHERE change_set_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(input.changeSetId) as { id: string; status: string; steps_json: string } | undefined;
  let undoId: string;
  let steps: UndoStep[];
  if (existing != null && (existing.status === 'in_progress' || existing.status === 'failed')) {
    undoId = existing.id;
    steps = JSON.parse(existing.steps_json) as UndoStep[];
  } else if (existing != null && existing.status === 'succeeded') {
    return domainErr('STALE_REVISION', `改动集已撤销（${existing.id}）——不重复执行`);
  } else {
    const before = loadFileRows(db, input.changeSetId, 'before');
    const after = loadFileRows(db, input.changeSetId, 'after');
    if (after.length === 0) return domainErr('STALE_REVISION', `改动集缺 after 前像行：${input.changeSetId}`);
    steps = planUndoSteps(before, after);
    undoId = `undo_${randomUUID()}`;
    persistUndo(db, undoId, input.changeSetId, steps, 'in_progress', now, null);
  }

  const storeDir = join(input.appDataDir, 'preimages', row.project_id);
  let executed = 0;
  for (const step of steps) {
    if (step.status !== 'pending') continue;
    if (input.failAfterSteps != null && executed >= input.failAfterSteps) {
      persistUndo(db, undoId, input.changeSetId, steps, 'failed', now, { error: `注入中断（执行 ${executed} 步后）——步骤进度已持久化，可恢复续跑` });
      return domainOk(summarize(undoId, 'failed', steps));
    }
    const abs = safeJoin(root, step.path);
    if (abs == null) {
      step.status = 'failed';
      step.detail = '路径越出项目边界（拒绝执行）';
      persistUndo(db, undoId, input.changeSetId, steps, 'in_progress', now, null);
      continue;
    }
    // 执行前重验（幂等恢复的核心）：当前状态必须仍匹配 after——被后续修改即冲突，不覆盖。
    const current = hashIfPresent(abs);
    if (step.expectState === 'present') {
      if (current == null) {
        step.status = 'conflict';
        step.detail = `期望仍存在（after hash=${step.expectSha256?.slice(0, 12) ?? '?'}）——当前已不存在`;
      } else if (step.expectSha256 != null && current !== step.expectSha256) {
        step.status = 'conflict';
        step.detail = '当前内容已被后续修改（不匹配本次变更 after）——不覆盖，人工处理（§14.5）';
      }
    } else if (step.expectState === 'absent') {
      if (current != null) {
        step.status = 'conflict';
        step.detail = '期望仍不存在（after=absent）——当前已有内容，不覆盖';
      }
    }
    if (step.status === 'conflict') {
      persistUndo(db, undoId, input.changeSetId, steps, 'in_progress', now, null);
      executed += 1;
      continue;
    }
    try {
      if (step.action === 'delete-added') {
        rmSync(abs, { force: false });
      } else {
        // restore-content / restore-removed：读受管理内容+核对 hash → 同目录临时文件 → rename。
        const ref = step.contentRef!;
        const stored = readStoredContent(storeDir, ref);
        if (!stored.ok) throw new Error(stored.error);
        mkdirSync(dirname(abs), { recursive: true });
        const tmp = `${abs}.zs_undo_${randomUUID().slice(0, 8)}`;
        writeFileSync(tmp, stored.content);
        const written = readFileSync(tmp);
        if (createHash('sha256').update(written).digest('hex') !== ref) {
          rmSync(tmp, { force: true });
          throw new Error('恢复内容写入核对失败（写坏不落位）');
        }
        renameSync(tmp, abs);
      }
      step.status = 'done';
      step.detail = undefined;
    } catch (error) {
      step.status = 'failed';
      step.detail = `执行失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    }
    executed += 1;
    persistUndo(db, undoId, input.changeSetId, steps, 'in_progress', now, null); // 每步即时持久化（中断可恢复）
  }

  const anyFailed = steps.some((s) => s.status === 'failed');
  const anyConflictOrManual = steps.some((s) => s.status === 'conflict' || s.status === 'manual');
  const status: UndoOutcome['status'] = anyFailed ? 'failed' : anyConflictOrManual ? 'conflict' : 'succeeded';
  // change_sets.application_status：全部步骤完成（含 manual？不含——manual=未撤销）才 'reverted'；
  // 部分完成/冲突/失败 → 'partial'（如实）。
  const allDone = steps.every((s) => s.status === 'done') || steps.every((s) => s.status === 'done' || s.status === 'manual');
  const applicationStatus = allDone && steps.some((s) => s.status === 'done') && !anyConflictOrManual && !anyFailed ? 'reverted' : steps.some((s) => s.status === 'done') ? 'partial' : row.application_status;
  const tx = db.transaction(() => {
    persistUndo(db, undoId, input.changeSetId, steps, status, now, status === 'succeeded' ? null : { note: `结束态=${status}` });
    if (applicationStatus !== row.application_status) {
      db.prepare(`UPDATE change_sets SET application_status = ? WHERE id = ?`).run(applicationStatus, input.changeSetId);
    }
    emitChangesetEvent(db, row.project_id, row.task_id, null, 'changeset.undoSettled', {
      changeSetId: input.changeSetId, undoId, status, applicationStatus,
      done: steps.filter((s) => s.status === 'done').length,
      conflict: steps.filter((s) => s.status === 'conflict').map((s) => s.path),
      manual: steps.filter((s) => s.status === 'manual').map((s) => s.path),
      failed: steps.filter((s) => s.status === 'failed').map((s) => s.path),
    }, now);
  });
  tx();
  return domainOk(summarize(undoId, status, steps));
}

// ---------- 查询 ----------

export interface ChangeSetDetail {
  changeSetId: string;
  projectId: string;
  taskId: string | null;
  beforeRef: unknown;
  afterRef: unknown;
  applicationStatus: string;
  before: ChangeSetFileRow[];
  after: ChangeSetFileRow[];
  undo: { undoId: string; status: string; steps: UndoStep[] } | null;
}

export function getChangeSet(db: ZhongshuoDatabase, changeSetId: string): DomainResult<ChangeSetDetail> {
  const row = loadChangeSet(db, changeSetId);
  if (row == null) return domainErr('RESOURCE_NOT_FOUND', `改动集不存在：${changeSetId}`);
  const undoRow = db.prepare(`SELECT id, status, steps_json FROM change_set_undos WHERE change_set_id = ? ORDER BY created_at DESC LIMIT 1`).get(changeSetId) as { id: string; status: string; steps_json: string } | undefined;
  return domainOk({
    changeSetId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    beforeRef: safeParse(row.before_ref),
    afterRef: row.after_ref.length > 0 ? safeParse(row.after_ref) : null,
    applicationStatus: row.application_status,
    before: loadFileRows(db, changeSetId, 'before'),
    after: loadFileRows(db, changeSetId, 'after'),
    undo: undoRow != null ? { undoId: undoRow.id, status: undoRow.status, steps: JSON.parse(undoRow.steps_json) as UndoStep[] } : null,
  });
}

// ---------- 内部 ----------

interface ChangeSetRow {
  id: string;
  project_id: string;
  task_id: string | null;
  before_ref: string;
  after_ref: string;
  application_status: string;
  manifest_json: string | null;
}

function loadChangeSet(db: ZhongshuoDatabase, id: string): ChangeSetRow | undefined {
  return db.prepare('SELECT id, project_id, task_id, before_ref, after_ref, application_status, manifest_json FROM change_sets WHERE id = ?').get(id) as ChangeSetRow | undefined;
}

function lookupProject(db: ZhongshuoDatabase, projectId: string): { canonical_path: string } | undefined {
  return db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(projectId) as { canonical_path: string } | undefined;
}

function insertPreimageRows(db: ZhongshuoDatabase, changeSetId: string, role: 'before' | 'after', entries: PreimageEntry[]): void {
  const stmt = db.prepare(
    `INSERT INTO change_set_files (change_set_id, role, path, state, sha256, size, content_ref, content_unavailable, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of entries) {
    stmt.run(changeSetId, role, e.path, e.state, e.sha256 ?? null, e.size ?? null, e.contentRef ?? null, e.contentUnavailable ?? null, e.error ?? null);
  }
}

function loadFileRows(db: ZhongshuoDatabase, changeSetId: string, role: 'before' | 'after'): ChangeSetFileRow[] {
  return db.prepare(
    `SELECT role, path, state, sha256, size, content_ref, content_unavailable, error FROM change_set_files WHERE change_set_id = ? AND role = ? ORDER BY path`,
  ).all(changeSetId, role) as ChangeSetFileRow[];
}

function rowToEntry(r: ChangeSetFileRow): PreimageEntry {
  return {
    path: r.path, state: r.state,
    sha256: r.sha256 ?? undefined, size: r.size ?? undefined,
    contentRef: r.content_ref ?? undefined,
    contentUnavailable: r.content_unavailable ?? undefined,
    error: r.error ?? undefined,
  };
}

function persistUndo(
  db: ZhongshuoDatabase, undoId: string, changeSetId: string, steps: UndoStep[],
  status: 'in_progress' | 'succeeded' | 'failed' | 'conflict', now: number, failure: unknown,
): void {
  db.prepare(
    `INSERT INTO change_set_undos (id, change_set_id, status, steps_json, created_at, updated_at, failure_json, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, steps_json = excluded.steps_json,
       updated_at = excluded.updated_at, failure_json = excluded.failure_json, summary_json = excluded.summary_json`,
  ).run(
    undoId, changeSetId, status, JSON.stringify(steps), now, now,
    failure != null ? JSON.stringify(failure) : null,
    JSON.stringify({ done: steps.filter((s) => s.status === 'done').length, total: steps.length }),
  );
}

function summarize(undoId: string, status: UndoOutcome['status'], steps: UndoStep[]): UndoOutcome {
  return {
    undoId, status, steps,
    manualPaths: steps.filter((s) => s.status === 'conflict' || s.status === 'manual' || s.status === 'failed').map((s) => s.path),
  };
}

function checkNoOverlappingLease(db: ZhongshuoDatabase, root: string): ReturnType<typeof domainErr> | null {
  const identityKey = comparisonKey(root);
  const overlapping = listActiveLeases(db).filter((lease) => lockDomainsOverlap(lease.lock_domain, identityKey));
  if (overlapping.length === 0) return null;
  return domainErr('WORKSPACE_BUSY', '写入目录被占用：撤销拒绝执行（单写者，§14.1）', {
    details: { holders: overlapping.map((l) => ({ ownerTurnId: l.owner_turn_id, lockDomain: l.lock_domain, status: l.status })) },
  });
}

/** 撤销执行的路径拼接：再次校验边界（计划持久化后 root 理论不变，防御性重验）。 */
function safeJoin(root: string, rel: string): string | null {
  try {
    const normalizedRoot = comparisonKey(root);
    const abs = join(root, rel);
    const key = comparisonKey(abs);
    if (key !== normalizedRoot && !key.startsWith(normalizedRoot + '\\') && !key.startsWith(normalizedRoot + '/')) return null;
    if (rel.split('/').includes('..')) return null;
    return abs;
  } catch {
    return null;
  }
}

function hashIfPresent(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null; // 不存在或不可读（不可读在执行时报 failed/冲突——此处按「不在」处理会被 expectState 捕获差异）
  }
}

function emitChangesetEvent(
  db: ZhongshuoDatabase, projectId: string, taskId: string | null, runId: string | null,
  kind: string, payload: unknown, now: number,
): void {
  let conversation: { conversation_id: string; thread_id: string | null } | null = null;
  if (taskId != null) {
    const taskRow = db.prepare('SELECT conversation_id, conversation_thread_id FROM tasks WHERE id = ?').get(taskId) as { conversation_id: string; conversation_thread_id: string | null } | undefined;
    conversation = taskRow != null ? { conversation_id: taskRow.conversation_id, thread_id: taskRow.conversation_thread_id } : null;
  }
  appendDomainEvent(db, {
    schemaVersion: 1,
    eventId: `evt_${randomUUID()}`,
    projectId,
    conversationId: conversation?.conversation_id ?? null,
    threadId: conversation?.thread_id ?? null,
    taskId: taskId ?? undefined,
    runId: runId ?? undefined,
    kind,
    createdAt: now,
    payload,
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
