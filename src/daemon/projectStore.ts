/**
 * 项目仓库：真实目录打开/去重/重定位（§3.3）。
 * 再次打开同一物理目录（含 junction/大小写差异）命中原 projectId；
 * 移动目录经 relocate 保留 projectId；删除项目=移除应用注册，不动源目录。
 */
import { randomUUID } from 'node:crypto';
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
  return domainOk({ project, created: true });
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
