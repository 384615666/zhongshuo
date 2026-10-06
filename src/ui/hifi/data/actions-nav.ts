/**
 * 导航动作（第十五批 §17.1 / §17.7）。
 *
 * 核心纪律：**焦点与显示是两件事，不能互相推导。**
 *
 *  - 焦点（activeProjectId）：任务派发、项目全停、草稿归属只认它，永远单值。
 *  - 显示（visibleProjectIds）：侧栏列出哪些项目，纯导航，勾选/取消
 *    **不派工、不停止任务、不清草稿、不自动已读、不清待办**（§17.7 第 5 条）。
 *
 * 之前原型把"当前项目"当成唯一的项目上下文，于是"我想同时看到 docs 的任务"
 * 只能靠切换当前项目实现 —— 那会顺带改变任务执行目标。这里拆开后，
 * 看板/搜索的聚合范围由各自的 scope 参数表达，不借用 activeProjectId。
 */

import { getState, setState, recordWrite, recordLocalOnly, persistNav, toast } from './store';
import type { HifiState } from './store';

function commitNav(s: HifiState, detail: string, api: string) {
  persistNav(s);
  recordWrite(api, detail);
}

/** 焦点是否需要在侧栏可见（当前项目不可隐藏） */
function ensureVisible(visible: string[], projectId: string): string[] {
  return visible.includes(projectId) ? visible : [...visible, projectId];
}

/**
 * 切换当前项目（焦点）。
 *
 * 这是**唯一**允许改变 activeProjectId 的入口：顶栏项目名点击、项目菜单、
 * 房间点击、成员页项目切换、看板单项目筛选都走它，保证行为一致。
 * 焦点项目自动加入可见集合（点未勾选的项目名 = 聚焦并显示，不清空其他选择）。
 */
export function focusProject(projectId: string, opts?: { announce?: boolean }): void {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return;

  const wasVisible = s0.visibleProjectIds.includes(projectId);
  const visible = ensureVisible(s0.visibleProjectIds, projectId);
  const next: HifiState = {
    ...s0,
    activeProjectId: projectId,
    visibleProjectIds: visible,
    expandedProjectIds: ensureVisible(s0.expandedProjectIds, projectId),
  };
  setState(() => next);
  commitNav(next, `projectId=${projectId} 焦点切换（不改变其他可见项目）`, 'navigation.preferences.update');

  // 深链/隐藏项目被打开时的轻提示，让"它怎么突然出现了"有解释
  if (!wasVisible && opts?.announce !== false) {
    toast(`已在侧栏显示项目「${p.displayName}」`, 'info');
  }
}

/** 勾选/取消侧栏显示。不改变焦点，也不碰任何任务状态。 */
export function toggleProjectVisible(projectId: string): void {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return;

  const isVisible = s0.visibleProjectIds.includes(projectId);
  if (isVisible && projectId === s0.activeProjectId) {
    // §17.7：当前项目必须在可见集合中，不能直接取消
    toast('当前项目不能隐藏，切换到其他项目后可隐藏', 'warn');
    return;
  }
  const visible = isVisible
    ? s0.visibleProjectIds.filter((id) => id !== projectId)
    : [...s0.visibleProjectIds, projectId];
  const next: HifiState = {
    ...s0,
    visibleProjectIds: visible,
    // 新显示的项目**同时展开**：菜单上写的是"显示在侧栏"，
    // 只冒出一个项目名而看不到房间，用户会以为没生效（还得再点箭头）。
    // 收起是用户自己的选择，取消勾选时保留其展开偏好，便于再次显示时恢复。
    expandedProjectIds: isVisible ? s0.expandedProjectIds : ensureVisible(s0.expandedProjectIds, projectId),
  };
  setState(() => next);
  persistNav(next);
  recordWrite(
    'navigation.preferences.update',
    `${isVisible ? '隐藏' : '显示'} projectId=${projectId}；仅影响侧栏显示，不停止任务、不清草稿、不清待办`,
  );
}

/** 项目节点展开/收起（房间列表）。纯显示偏好。 */
export function toggleProjectExpanded(projectId: string): void {
  const s0 = getState();
  const isOpen = s0.expandedProjectIds.includes(projectId);
  const next: HifiState = {
    ...s0,
    expandedProjectIds: isOpen
      ? s0.expandedProjectIds.filter((id) => id !== projectId)
      : [...s0.expandedProjectIds, projectId],
  };
  setState(() => next);
  persistNav(next);
  recordLocalOnly('nav.project.toggle', `projectId=${projectId} ${isOpen ? '收起' : '展开'}房间列表`);
}

/**
 * 记住"文件与 Git"合页上次停留的标签（按项目各记一份）。
 * §17.7：显式深链的 tab 参数**优先于**记忆，所以这里只在用户主动切标签时写入。
 */
export function rememberFileGitTab(projectId: string, tab: 'files' | 'git'): void {
  const s0 = getState();
  if (s0.fileGitTabs[projectId] === tab) return;
  const next: HifiState = { ...s0, fileGitTabs: { ...s0.fileGitTabs, [projectId]: tab } };
  setState(() => next);
  persistNav(next);
  recordLocalOnly('nav.fileGitTab', `projectId=${projectId} tab=${tab}`);
}

/** 读取该项目该用的标签：URL 显式 tab > 记忆 > 默认 files */
export function resolveFileGitTab(projectId: string, explicit?: string): 'files' | 'git' {
  if (explicit === 'files' || explicit === 'git') return explicit;
  return getState().fileGitTabs[projectId] ?? 'files';
}

/**
 * 打开隐藏项目的深链时调用：先补选、再聚焦、最后让调用方定位内容（§17.7）。
 * 其他可见项目与顺序保持不变，缺失目标追加到末尾。
 *
 * `announce` 由调用方按"这次是否真的把它加入可见集合"决定，
 * 避免每次导航都弹一次提示。
 */
export function revealProjectForDeepLink(projectId: string, opts?: { announce?: boolean }): boolean {
  const s0 = getState();
  const p = s0.projects.find((x) => x.id === projectId);
  if (!p) return false;
  const wasVisible = s0.visibleProjectIds.includes(projectId);
  const visible = ensureVisible(s0.visibleProjectIds, projectId);
  const next: HifiState = {
    ...s0,
    activeProjectId: projectId,
    visibleProjectIds: visible,
    expandedProjectIds: ensureVisible(s0.expandedProjectIds, projectId),
  };
  setState(() => next);
  commitNav(next, `深链补选 projectId=${projectId}（按实体归属聚焦）`, 'navigation.preferences.update');
  if (opts?.announce ?? !wasVisible) {
    toast(`已在侧栏显示项目「${p.displayName}」`, 'info');
  }
  return true;
}