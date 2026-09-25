/**
 * 项目生命周期动作（第十七批 §七 / §十）。
 *
 * 三件事必须分得很清 —— 用户明确要求"置顶、编辑、隐藏、归档、移除的行为互不混淆"：
 *  - **隐藏**：`toggleProjectVisible`（`actions-nav.ts`）—— 只影响侧栏显示，别的都不动；
 *  - **归档**：本文件的 `archiveProject` —— 保留历史、退出日常项目树，其下房间只读、
 *    不再收消息、不建任务、不被调度唤醒；恢复时**不动**各自单独归档的房间；
 *  - **移除**：本文件的 `removeProject` —— 从应用项目列表里移除关联，
 *    **不删磁盘文件、不丢历史数据**，设置里可以重新关联（`restoreRemovedProject`）。
 *
 * 归档/移除都做前置检查（仍在执行或等待用户的工作），**不直接强停、不丢弃任务**：
 * 有阻止项时说明原因，并引导用户去处理（房间页 / 任务看板）。
 */

import { getState, setState, recordWrite, recordLocalOnly, persistNav, toast } from './store';
import { desktop, openPath } from '../lib/desktop';
import type { AppState, Project } from './types';

/** "还没结束的工作"口径与房间归档保持一致（ACTIVE / WAITING_USER / BLOCKED） */
export function unfinishedTasksOfProject(s: AppState, projectId: string) {
  return s.tasks.filter(
    (t) => t.projectId === projectId && ['ACTIVE', 'WAITING_USER', 'BLOCKED'].includes(t.status),
  );
}

/** 除自己之外第一个可用的日常项目（归档/移除的项目不能当落点） */
function fallbackProjectId(s: AppState, excludeId: string): string | undefined {
  return s.projects.find((p) => p.id !== excludeId && !p.archivedAt && !p.removedAt)?.id;
}

/* ---------------- 置顶 ---------------- */

/**
 * 置顶 / 取消置顶（§七）。
 * 只改排列顺序（`pinnedProjectIds`），**不复制出第二个项目入口、不切页面、不切当前项目**。
 */
export function toggleProjectPinned(projectId: string): void {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return;
  const isPinned = s0.pinnedProjectIds.includes(projectId);
  const next: AppState = {
    ...s0,
    pinnedProjectIds: isPinned
      ? s0.pinnedProjectIds.filter((id) => id !== projectId)
      : [...s0.pinnedProjectIds, projectId],
  };
  setState(() => next);
  persistNav(next);
  recordLocalOnly('project.pin', `projectId=${projectId} pinned=${!isPinned}（只改排列顺序）`);
  toast(isPinned ? `已取消置顶「${p.displayName}」` : `已置顶「${p.displayName}」`, 'success');
}

/* ---------------- 编辑项目信息 ---------------- */

/**
 * 编辑显示名称与描述（§七）。
 * **显示名称不重命名磁盘目录**：`rootPath` / `canonicalPath` / `directoryIdentity` 一个字都不改。
 */
export function updateProjectInfo(
  projectId: string,
  info: { displayName?: string; description?: string },
): boolean {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return false;
  const displayName = (info.displayName ?? p.displayName).trim();
  if (!displayName) {
    toast('显示名称不能为空', 'warn');
    return false;
  }
  const description = (info.description ?? p.description ?? '').trim();
  const next: AppState = {
    ...s0,
    projects: s0.projects.map((x) =>
      x.id === projectId
        ? { ...x, displayName, description: description || undefined, revision: x.revision + 1 }
        : x,
    ),
  };
  setState(() => next);
  recordWrite(
    'project.update',
    `projectId=${projectId} displayName=${displayName}；只改显示信息，**不重命名磁盘目录**（${p.rootPath}）`,
  );
  toast('项目信息已更新（磁盘目录未改名）', 'success');
  return true;
}

/* ---------------- 在资源管理器中打开 ---------------- */

/**
 * 在系统资源管理器中打开项目目录（§七）。
 *
 * 如实报告三种结果，**不用成功提示冒充"已打开"**：
 *  - 目录失效（status=missing）：给出准确反馈与已有的重新定位入口；
 *  - 浏览器宿主：没有原生能力，说明限制并指向"重新定位项目目录"；
 *  - 桌面宿主：走 Electron 的 `shell.openPath`。
 */
export async function openProjectInExplorer(projectId: string): Promise<void> {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return;
  if (p.status === 'missing') {
    toast(`「${p.displayName}」的目录不可用（${p.rootPath}）：请先用「重新定位项目目录」重新关联`, 'error');
    return;
  }
  if (!desktop()) {
    toast('浏览器宿主没有系统文件管理器能力：请用桌面客户端，或先用「重新定位项目目录」确认路径', 'warn');
    return;
  }
  const res = await openPath(p.rootPath);
  if (!res) {
    toast('当前宿主没有提供"打开目录"能力，未做替代操作', 'warn');
    return;
  }
  if (res.ok) {
    recordLocalOnly('project.reveal', `projectId=${projectId} path=${p.rootPath}`);
    toast(`已在文件管理器中打开：${p.rootPath}`, 'success');
  } else {
    toast(`无法打开目录：${p.rootPath}（${res.reason ?? '宿主返回失败'}）`, 'error');
  }
}

/* ---------------- 归档 / 恢复 ---------------- */

/**
 * 归档项目（§十）。
 *
 * 规则：
 *  - 还有 ACTIVE/WAITING_USER/BLOCKED 的工作时**拒绝**，说明原因并指向处理入口
 *    （房间页/任务看板），不直接强停、不丢弃任务；
 *  - 归档后其下房间只读：不能发消息、建任务、被调度唤醒（守卫在 actions.ts 的写入路径上）；
 *  - 归档当前正在查看的项目时，调用方负责给一个明确落点（见 App 的项目菜单：跳归档管理）。
 *
 * @returns 'archived' 成功；'blocked' 有未结束工作；'missing' 项目不存在
 */
export function archiveProject(projectId: string): 'archived' | 'blocked' | 'missing' {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return 'missing';
  if (p.archivedAt) return 'archived';

  const unfinished = unfinishedTasksOfProject(s0, projectId);
  if (unfinished.length > 0) {
    toast(
      `不能归档：本项目还有 ${unfinished.length} 个工作未结束（${unfinished
        .slice(0, 3)
        .map((t) => `#${t.roomTaskNumber}`)
        .join('、')}${unfinished.length > 3 ? ' 等' : ''}）。请先处理或到任务看板查看`,
      'error',
    );
    return 'blocked';
  }

  const wasActive = s0.activeProjectId === projectId;
  const fallback = wasActive ? fallbackProjectId(s0, projectId) : undefined;
  const next: AppState = {
    ...s0,
    projects: s0.projects.map((x) =>
      x.id === projectId ? { ...x, archivedAt: Date.now(), revision: x.revision + 1 } : x,
    ),
    // 归档的项目不在侧栏出现：只从**显示集合**里摘掉，不改它原来的勾选偏好，
    // 恢复后仍是原来的可见状态。
    visibleProjectIds: s0.visibleProjectIds.filter((id) => id !== projectId),
    expandedProjectIds: s0.expandedProjectIds.filter((id) => id !== projectId),
    activeProjectId: fallback ?? s0.activeProjectId,
  };
  setState(() => next);
  persistNav(next);
  recordWrite(
    'project.archive',
    `projectId=${projectId} archived=true → 退出日常项目树、其下房间只读；历史保留，可恢复`,
  );
  toast(`「${p.displayName}」已归档：退出项目列表，历史保留只读，可在归档管理里恢复`, 'success');
  return 'archived';
}

/**
 * 恢复项目（§十）。
 *
 * - **不动**各自单独归档的房间：`room.archivedAt` 保持原样（它们不会跟着项目一起恢复）；
 * - **不重放**旧的待派发任务，也不自动启动旧任务（恢复只是让项目重新可用）；
 * - 项目仍在归档时不能单独恢复房间（守卫见 `unarchiveRoom`）。
 */
export function restoreProject(projectId: string): void {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p || !p.archivedAt) return;
  const stillArchivedRooms = s0.rooms.filter((r) => r.projectId === projectId && r.archivedAt).length;
  const next: AppState = {
    ...s0,
    projects: s0.projects.map((x) =>
      x.id === projectId ? { ...x, archivedAt: undefined, revision: x.revision + 1 } : x,
    ),
    visibleProjectIds: s0.visibleProjectIds.includes(projectId)
      ? s0.visibleProjectIds
      : [...s0.visibleProjectIds, projectId],
  };
  setState(() => next);
  persistNav(next);
  recordWrite(
    'project.archive',
    `projectId=${projectId} archived=false → 恢复；${stillArchivedRooms} 个房间保持各自归档，旧任务不自动重放`,
  );
  toast(
    stillArchivedRooms > 0
      ? `「${p.displayName}」已恢复；其中 ${stillArchivedRooms} 个房间仍是归档状态，需要时单独恢复`
      : `「${p.displayName}」已恢复；旧的待派发任务不会自动重放`,
    'success',
  );
}

/* ---------------- 移除 / 重新关联 ---------------- */

/**
 * 移除项目（§七）。
 *
 * 语义（诚实说明，见完成报告）：**从应用的项目列表里移除关联** ——
 * 不删除磁盘文件、不删除会话与任务记录（数据仍在原型状态里），
 * 只是不再出现在侧栏/项目菜单/看板/搜索范围里；可在「应用设置 → 已移除的项目」重新关联。
 * 有未结束工作时同样拒绝，避免"把还在跑的项目藏起来"。
 */
export function removeProject(projectId: string): 'removed' | 'blocked' | 'missing' {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return 'missing';
  const unfinished = unfinishedTasksOfProject(s0, projectId);
  if (unfinished.length > 0) {
    toast(`不能移除：本项目还有 ${unfinished.length} 个工作未结束。可以先归档，或到任务看板查看`, 'error');
    return 'blocked';
  }
  const wasActive = s0.activeProjectId === projectId;
  const fallback = wasActive ? fallbackProjectId(s0, projectId) : undefined;
  const next: AppState = {
    ...s0,
    projects: s0.projects.map((x) => (x.id === projectId ? { ...x, removedAt: Date.now() } : x)),
    visibleProjectIds: s0.visibleProjectIds.filter((id) => id !== projectId),
    expandedProjectIds: s0.expandedProjectIds.filter((id) => id !== projectId),
    pinnedProjectIds: s0.pinnedProjectIds.filter((id) => id !== projectId),
    activeProjectId: fallback ?? s0.activeProjectId,
  };
  setState(() => next);
  persistNav(next);
  recordWrite(
    'project.remove',
    `projectId=${projectId} removed=true → 仅移除应用内的项目关联；磁盘文件未删除、历史数据保留，可重新关联`,
  );
  toast(`已移除「${p.displayName}」：只在应用里移除关联，磁盘文件与历史都还在（设置里可重新关联）`, 'success');
  return 'removed';
}

/** 重新关联（撤销移除）：数据一直都在，这里只是让它重新出现在列表里。 */
export function restoreRemovedProject(projectId: string): void {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p || !p.removedAt) return;
  const next: AppState = {
    ...s0,
    projects: s0.projects.map((x) => (x.id === projectId ? { ...x, removedAt: undefined } : x)),
    visibleProjectIds: s0.visibleProjectIds.includes(projectId)
      ? s0.visibleProjectIds
      : [...s0.visibleProjectIds, projectId],
  };
  setState(() => next);
  persistNav(next);
  recordWrite('project.relink', `projectId=${projectId} removed=false → 按原目录重新关联，历史与任务记录保持不变`);
  toast(`已重新关联「${p.displayName}」：历史会话与任务记录原样保留`, 'success');
}

/** 供完成报告与界面提示复用：一个项目当前处于哪种生命周期状态 */
export function projectLifecycle(p: Project): 'removed' | 'archived' | 'active' {
  if (p.removedAt) return 'removed';
  if (p.archivedAt) return 'archived';
  return 'active';
}
