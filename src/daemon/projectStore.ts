/**
 * 项目仓库：真实目录打开/去重/重定位（§3.3）。
 * 再次打开同一物理目录（含 junction/大小写差异）命中原 projectId；
 * 移动目录经 relocate 保留 projectId；删除项目=移除应用注册，不动源目录。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { Project } from '../contracts/project.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';
import { resolveDirectoryIdentity } from './directoryIdentity.ts';

interface ProjectRow {
  id: string;
  display_name: string;
  root_path: string;
  canonical_path: string;
  directory_identity: string;
  status: string;
  revision: number;
  task_review_enabled: number;
  write_concurrency_policy: string;
  created_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    displayName: row.display_name,
    // R71（R64 登记）：DTO 补 rootPath/canonicalPath——前端 loader 声明早有此二字段，
    // 服务端此前不回（前端回落 project.list/自身路径推导）。registry 行真实路径直出。
    rootPath: row.root_path,
    canonicalPath: row.canonical_path,
    directoryIdentity: JSON.parse(row.directory_identity) as Project['directoryIdentity'],
    status: row.status as Project['status'],
    revision: row.revision,
    taskReviewEnabled: row.task_review_enabled === 1,
    writeConcurrencyPolicy: row.write_concurrency_policy as Project['writeConcurrencyPolicy'],
    createdAt: row.created_at,
  };
}

/**
 * 打开项目：身份命中（未移除）→ 返回既有项目；未命中 → 新建（默认房间等由上层补齐）。
 * directory_identity 列存完整 JSON（含 identityKey），去重按 identityKey。
 */
export function openProject(
  db: ZhongshuoDatabase,
  input: { rootPath: string; displayName?: string; now: number },
): DomainResult<{ project: Project; created: boolean }> {
  const identity = resolveDirectoryIdentity(input.rootPath);
  if (!identity.ok) return identity;

  const existing = db
    .prepare(
      `SELECT * FROM projects WHERE status != 'removed' ORDER BY created_at LIMIT 50`,
    )
    .all() as ProjectRow[];
  const hit = existing.find((row) => {
    try {
      return (JSON.parse(row.directory_identity) as { identityKey: string }).identityKey === identity.value.identityKey;
    } catch {
      return false;
    }
  });
  if (hit != null) {
    // 命中：不新建、不改 ID；原始路径变化（如不同大小写/junction 入口）不重写记录。
    return domainOk({ project: rowToProject(hit), created: false });
  }

  const removed = db.prepare(`SELECT * FROM projects WHERE status='removed' ORDER BY created_at LIMIT 50`).all() as ProjectRow[];
  const removedHit = removed.find((row) => {
    try {
      return (JSON.parse(row.directory_identity) as { identityKey: string }).identityKey === identity.value.identityKey;
    } catch {
      return false;
    }
  });
  if (removedHit != null) {
    db.prepare("UPDATE projects SET status='active', revision=revision+1 WHERE id=?").run(removedHit.id);
    const restored = db.prepare('SELECT * FROM projects WHERE id=?').get(removedHit.id) as ProjectRow;
    return domainOk({ project: rowToProject(restored), created: false });
  }

  const project: Project = {
    id: `prj_${randomUUID()}`,
    displayName: input.displayName ?? identity.value.canonicalPath.split(/[\\/]/).pop() ?? '未命名项目',
    directoryIdentity: identity.value,
    status: 'active',
    revision: 0,
    taskReviewEnabled: false,
    writeConcurrencyPolicy: 'single_writer',
    createdAt: input.now,
  };
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, status,
       revision, task_review_enabled, write_concurrency_policy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.displayName,
    identity.value.rootPath,
    identity.value.canonicalPath,
    JSON.stringify(identity.value),
    project.status,
    project.revision,
    project.taskReviewEnabled ? 1 : 0,
    project.writeConcurrencyPolicy,
    project.createdAt,
  );
  // R71：新建路径同样直出真实路径（与 rowToProject 命中路径一致——open 响应两分支同 DTO）。
  return domainOk({ project: { ...project, rootPath: identity.value.rootPath, canonicalPath: identity.value.canonicalPath }, created: true });
}

export interface EnsureDefaultProjectResult {
  project: Project | null;
  created: boolean;
  reason: 'created' | 'existing_root_project' | 'existing_projects' | 'default_removed';
}

/**
 * R90 first-use bootstrap: create one app-managed project only for a truly empty
 * project registry. Existing roots are never rewritten, renamed or made current.
 * Re-running is duplicate-free; if the app-managed directory is already registered,
 * the same project id is returned.
 */
export function ensureDefaultProject(
  db: ZhongshuoDatabase,
  input: { rootPath: string; displayName: string; now: number },
): DomainResult<EnsureDefaultProjectResult> {
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all() as ProjectRow[];
  if (rows.length > 0) {
    if (!existsSync(input.rootPath)) {
      return domainOk({ project: null, created: false, reason: 'existing_projects' });
    }
    const identity = resolveDirectoryIdentity(input.rootPath);
    if (!identity.ok) {
      return domainOk({ project: null, created: false, reason: 'existing_projects' });
    }
    const hit = rows.find((row) => {
      try {
        return (JSON.parse(row.directory_identity) as { identityKey?: string }).identityKey === identity.value.identityKey;
      } catch {
        return false;
      }
    });
    if (hit == null) return domainOk({ project: null, created: false, reason: 'existing_projects' });
    if (hit.status === 'removed') return domainOk({ project: null, created: false, reason: 'default_removed' });
    if (hit.status !== 'active') return domainOk({ project: null, created: false, reason: 'existing_projects' });
    return domainOk({ project: rowToProject(hit), created: false, reason: 'existing_root_project' });
  }

  mkdirSync(input.rootPath, { recursive: true });
  const opened = openProject(db, { rootPath: input.rootPath, displayName: input.displayName, now: input.now });
  if (!opened.ok) return opened;
  return domainOk({ project: opened.value.project, created: opened.value.created, reason: 'created' });
}

/**
 * 重定位：目录移动后保留 projectId 与全部关联（RT-14：不在错误目录运行，等待重新定位）。
 * 新路径必须真实存在。
 */
export function relocateProject(
  db: ZhongshuoDatabase,
  input: { projectId: string; newRootPath: string; expectedRevision: number },
): DomainResult<Project> {
  const identity = resolveDirectoryIdentity(input.newRootPath);
  if (!identity.ok) return identity;

  const row = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(input.projectId) as ProjectRow | undefined;
  if (row == null) return domainErr('RESOURCE_NOT_FOUND', `项目不存在：${input.projectId}`);
  if (row.revision !== input.expectedRevision) {
    return domainErr('STALE_REVISION', '项目 revision 已变化，请刷新后重试');
  }
  // 不允许重定位到与其他未移除项目相同的物理目录（去重不变量）。
  const conflict = (db
    .prepare("SELECT id, directory_identity FROM projects WHERE status != 'removed' AND id != ?")
    .all(input.projectId) as Array<{ id: string; directory_identity: string }>)
    .find((other) => {
      try {
        return (JSON.parse(other.directory_identity) as { identityKey: string }).identityKey === identity.value.identityKey;
      } catch {
        return false;
      }
    });
  if (conflict != null) {
    return domainErr('VALIDATION_INVALID', '目标目录已是另一项目的物理目录，不能重定位');
  }

  db.prepare(
    `UPDATE projects SET root_path = ?, canonical_path = ?, directory_identity = ?,
       status = 'active', revision = revision + 1 WHERE id = ? AND revision = ?`,
  ).run(
    identity.value.rootPath,
    identity.value.canonicalPath,
    JSON.stringify(identity.value),
    input.projectId,
    input.expectedRevision,
  );
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId) as ProjectRow;
  return domainOk(rowToProject(updated));
}

export function getProject(db: ZhongshuoDatabase, projectId: string): Project | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  return row == null ? undefined : rowToProject(row);
}
