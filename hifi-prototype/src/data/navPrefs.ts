/**
 * 导航显示偏好：版本化持久化 + 校验（第十五批 §17.7）。
 *
 * 为什么单独一个 key：
 *  - 这是**本人本客户端**的显示偏好，不是项目权限，也不是任务运行配置。
 *    混进主状态一起序列化会让"重置原型数据"顺带丢掉用户的侧栏布置，
 *    也会让偏好看起来像是会影响 Agent 的东西。
 *  - 正式版落 `navigation_preferences`（viewer_id, client_id 唯一）。
 *
 * 加载时必须做的四件事（§17.7）：校验 ID、去重、补入当前项目、清掉已删除偏好。
 * 任何一步都不能省——localStorage 里可能残留上一版种子或被删项目的 ID。
 */

import type { AppState, NavigationPreferences } from './types';

export const NAV_PREFS_KEY = 'zhongshuo.nav.prefs.v1';

export function defaultNavPrefs(activeProjectId?: string): NavigationPreferences {
  return {
    version: 1,
    activeProjectId,
    visibleProjectIds: activeProjectId ? [activeProjectId] : [],
    expandedProjectIds: activeProjectId ? [activeProjectId] : [],
    fileGitTabs: {},
  };
}

/**
 * 当前项目不可隐藏（§17.7）：它必须始终在可见集合里。
 * 没有可用项目时保持空，界面给空态，不伪造 ID。
 */
function withActive(
  p: NavigationPreferences,
  validIds: string[],
  activeId?: string,
): NavigationPreferences {
  const valid = new Set(validIds);
  const active = activeId && valid.has(activeId) ? activeId : validIds[0];
  if (!active) return { ...p, activeProjectId: undefined, visibleProjectIds: [] };
  const visible = p.visibleProjectIds.filter((id) => valid.has(id));
  if (!visible.includes(active)) visible.unshift(active);
  return { ...p, activeProjectId: active, visibleProjectIds: visible };
}

/** 校验 + 去重 + 补当前项目 + 清失效 ID。输入可以是任意脏数据。 */
export function normalizeNavPrefs(
  raw: unknown,
  validProjectIds: string[],
  fallbackActiveId?: string,
): NavigationPreferences {
  const base = defaultNavPrefs(undefined);
  if (!raw || typeof raw !== 'object') return withActive(base, validProjectIds, fallbackActiveId);
  const r = raw as Partial<NavigationPreferences>;
  // 版本不符一律弃用，不做"猜测式迁移"：偏好丢了只是侧栏顺序变化，猜错会显示错项目
  if (r.version !== 1) return withActive(base, validProjectIds, fallbackActiveId);

  const valid = new Set(validProjectIds);
  const seen = new Set<string>();
  for (const id of Array.isArray(r.visibleProjectIds) ? r.visibleProjectIds : []) {
    if (typeof id === 'string' && valid.has(id) && !seen.has(id)) {
      seen.add(id);
      base.visibleProjectIds.push(id);
    }
  }
  const seenExpanded = new Set<string>();
  for (const id of Array.isArray(r.expandedProjectIds) ? r.expandedProjectIds : []) {
    if (typeof id === 'string' && valid.has(id) && !seenExpanded.has(id)) {
      seenExpanded.add(id);
      base.expandedProjectIds.push(id);
    }
  }
  if (r.fileGitTabs && typeof r.fileGitTabs === 'object') {
    for (const [k, v] of Object.entries(r.fileGitTabs)) {
      if (valid.has(k) && (v === 'files' || v === 'git')) base.fileGitTabs[k] = v;
    }
  }
  const active = typeof r.activeProjectId === 'string' && valid.has(r.activeProjectId)
    ? r.activeProjectId
    : undefined;
  return withActive(base, validProjectIds, active ?? fallbackActiveId);
}

/**
 * 读取偏好。**没有存储时返回 null**，让调用方保留种子里的导航字段
 * （种子里"当前项目默认展开"是有意的初始状态）。
 *
 * 早先这里返回 defaultNavPrefs(undefined)，会把 expandedProjectIds 清空 ——
 * 表现为刷新后侧栏项目都收起了，房间列表看不见。
 */
export function loadNavPrefs(validProjectIds: string[], fallbackActiveId?: string): NavigationPreferences | null {
  try {
    const raw = window.localStorage?.getItem(NAV_PREFS_KEY);
    if (!raw) return null;
    return normalizeNavPrefs(JSON.parse(raw), validProjectIds, fallbackActiveId);
  } catch {
    // 隐私模式 / 配额不足 / JSON 损坏：退回 null，由调用方用种子状态兜底
    return null;
  }
}

export function saveNavPrefs(prefs: NavigationPreferences): void {
  try {
    window.localStorage?.setItem(NAV_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 存不下就只在本次会话生效，不打断使用 */
  }
}

export function clearNavPrefs(): void {
  try {
    window.localStorage?.removeItem(NAV_PREFS_KEY);
  } catch {
    /* 同上 */
  }
}

/** 把偏好并入状态；项目不存在时回落到第一个可用项目。 */
export function applyNavPrefs(s: AppState, p: NavigationPreferences): AppState {
  const ids = s.projects.map((x) => x.id);
  const norm = normalizeNavPrefs(p, ids, s.activeProjectId);
  return {
    ...s,
    activeProjectId: norm.activeProjectId ?? s.activeProjectId,
    visibleProjectIds: norm.visibleProjectIds,
    expandedProjectIds: norm.expandedProjectIds,
    fileGitTabs: norm.fileGitTabs,
  };
}
