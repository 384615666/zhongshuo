/**
 * 内存状态层。
 * 原型没有 daemon、SQLite 和 runtime 适配器：所有写操作改的是内存状态，
 * 刷新即回到种子。每次写操作按 §15.2 的命令名留痕，保证界面不会长出
 * 文档里不存在的接口。
 */

import { useSyncExternalStore } from 'react';
import { initialState } from './seeds-core';
import { applyNavPrefs, clearNavPrefs, defaultNavPrefs, loadNavPrefs, saveNavPrefs } from './navPrefs';
import type { AppState } from './types';

/**
 * 启动时把持久化的导航偏好并进种子状态（第十五批 §17.7）。
 * 只并入显示偏好，不动任何任务/成员/交付数据。
 * 没有存储过偏好时保留种子里的导航字段（当前项目默认展开）。
 */
function bootstrap(): AppState {
  const base = structuredClone(initialState);
  const prefs = loadNavPrefs(base.projects.map((p) => p.id), base.activeProjectId);
  return prefs ? applyNavPrefs(base, prefs) : base;
}

let state: AppState = bootstrap();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** 把导航偏好写回 localStorage；导航类动作统一走这里 */
function persistNav(s: AppState) {
  saveNavPrefs({
    version: 1,
    activeProjectId: s.activeProjectId,
    visibleProjectIds: s.visibleProjectIds,
    expandedProjectIds: s.expandedProjectIds,
    pinnedProjectIds: s.pinnedProjectIds,
    fileGitTabs: s.fileGitTabs,
  });
}

export function getState(): AppState {
  return state;
}

export function setState(updater: (prev: AppState) => AppState) {
  state = updater(state);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function resetStore() {
  state = structuredClone(initialState);
  // 重置原型数据同时清掉导航偏好：否则"重置"后侧栏仍按上次的可见项目显示，
  // 用户会以为重置没生效（偏好是独立的 key，不清不会被覆盖）
  clearNavPrefs();
  emit();
}

/**
 * 只清导航偏好（侧栏可见项目、展开、置顶、文件/Git 标签、当前项目焦点）。
 *
 * 为什么与 resetStore 分开（§2.6 的「原型工具」组）：演示前常只需要把界面
 * 摆回初始形态，不想丢掉刚改过的设置与留痕 —— 两个动作的影响范围不一样，
 * 就不能塞进同一个按钮里。
 */
export function resetNavPrefsOnly() {
  clearNavPrefs();
  const base = structuredClone(initialState);
  setState((s) => ({
    ...s,
    activeProjectId: base.activeProjectId,
    visibleProjectIds: base.visibleProjectIds,
    expandedProjectIds: base.expandedProjectIds,
    pinnedProjectIds: base.pinnedProjectIds,
    fileGitTabs: base.fileGitTabs,
  }));
  recordLocalOnly('navigation.preferences.reset', '侧栏可见项目 / 展开 / 置顶 / 文件-Git 标签 / 当前项目 → 回到初始种子');
}

export { persistNav, defaultNavPrefs };

/* ---------- 写操作留痕（原型专用，不属于产品契约） ---------- */

const LOCAL_ONLY = 'LOCAL_ONLY:';

/**
 * 记录一次写操作。
 * @param api §15.2 的命令名；文档里没有的动作用 LOCAL_ONLY: 前缀标出。
 */
export function recordWrite(api: string, detail: string) {
  setState((s) => ({
    ...s,
    ui: {
      ...s.ui,
      writeLog: [{ at: Date.now(), api, detail }, ...s.ui.writeLog].slice(0, 60),
    },
  }));
}

export function recordLocalOnly(name: string, detail: string) {
  recordWrite(`${LOCAL_ONLY}${name}`, detail);
}

export function toast(text: string, tone: 'info' | 'warn' | 'error' | 'success' = 'info') {
  setState((s) => ({ ...s, ui: { ...s.ui, toast: { text, tone } } }));
  window.setTimeout(() => {
    setState((s) => (s.ui.toast?.text === text ? { ...s, ui: { ...s.ui, toast: undefined } } : s));
  }, 3600);
}

export function clearToast() {
  setState((s) => ({ ...s, ui: { ...s.ui, toast: undefined } }));
}

/* ---------- 主题 ---------- */

export function setTheme(theme: 'light' | 'dark') {
  setState((s) => ({ ...s, ui: { ...s.ui, theme } }));
}

/* ---------- 应用级设置（第十六批 §17.8） ---------- */

/**
 * 改一个应用级设置项。
 *
 * 存在的理由：这些开关此前是写死的 `checked`，点击只弹 toast ——
 * 实测点击前后状态完全不变（`[true, true, false]`），用户会以为设置坏了。
 * 现在改的是**内存里的模拟值**，界面会真实变化。
 *
 * 必须如实（§17.8 第 7 条）：原型没有系统桥接，所以这里**不声称**真的
 * 改了开机自启或托盘行为 —— 界面用「原型」标注写明这一点。
 */
export function setAppSetting<K extends keyof AppState['appSettings']>(
  key: K,
  value: AppState['appSettings'][K],
) {
  setState((s) => ({ ...s, appSettings: { ...s.appSettings, [key]: value } }));
  recordLocalOnly(
    'app.settings.update',
    `${key}=${String(value)}（原型只改内存模拟值，未接入系统开机项/托盘）`,
  );
}

/* ---------- 通知偏好 / 运行并发 / 日志保留（第二十八批：应用设置七类重排） ---------- */

/**
 * 通知偏好（应用级这一层）。
 *
 * **单一真相源**：这里改的只是"应用级"层；房间静音与线程关注仍在 `s.subscriptions`，
 * 不另存第二份"通知订阅"状态（§3.2）。
 */
export function setNotificationPref<K extends keyof AppState['appSettings']['notifications']>(
  key: K,
  value: AppState['appSettings']['notifications'][K],
) {
  setState((s) => ({
    ...s,
    appSettings: { ...s.appSettings, notifications: { ...s.appSettings.notifications, [key]: value } },
  }));
  recordLocalOnly('app.settings.update', `notifications.${key}=${String(value)}（原型只改内存模拟值）`);
}

/** 单个事件开关（需要审批 / 任务失败 / 任务完成 / 被提及） */
export function setNotificationEvent(
  kind: keyof AppState['appSettings']['notifications']['events'],
  value: boolean,
) {
  setState((s) => ({
    ...s,
    appSettings: {
      ...s.appSettings,
      notifications: {
        ...s.appSettings.notifications,
        events: { ...s.appSettings.notifications.events, [kind]: value },
      },
    },
  }));
  recordLocalOnly('app.settings.update', `notifications.events.${kind}=${String(value)}（原型只改内存模拟值）`);
}

/** 免打扰时段（应用级覆盖层：> 房间静音 > 线程关注） */
export function setDnd(patch: Partial<AppState['appSettings']['notifications']['dnd']>) {
  setState((s) => ({
    ...s,
    appSettings: {
      ...s.appSettings,
      notifications: { ...s.appSettings.notifications, dnd: { ...s.appSettings.notifications.dnd, ...patch } },
    },
  }));
  recordLocalOnly('app.settings.update', `notifications.dnd=${JSON.stringify(patch)}（原型只改内存模拟值）`);
}

/**
 * 应用级运行并发（§10.3 决策 12）。
 *
 * 改的是**上限**，3 / 1 只是建议起始值；这里不声称能改真实调度器 ——
 * 原型没有调度器，界面用「原型模拟」标注（§4.3）。
 */
export function setRuntimeLimit<K extends keyof AppState['appSettings']['runtimeLimits']>(
  key: K,
  value: AppState['appSettings']['runtimeLimits'][K],
) {
  setState((s) => ({
    ...s,
    appSettings: { ...s.appSettings, runtimeLimits: { ...s.appSettings.runtimeLimits, [key]: value } },
  }));
  recordLocalOnly('app.settings.update', `runtimeLimits.${key}=${String(value)}（原型只改内存模拟值）`);
}

/** 日志保留天数：真实可选值，写入状态（§2.4 选项①） */
export function setLogRetention(days: AppState['appSettings']['logRetentionDays']) {
  setState((s) => ({ ...s, appSettings: { ...s.appSettings, logRetentionDays: days } }));
  recordLocalOnly('app.settings.update', `logRetentionDays=${days}（原型只改内存模拟值，不真的删日志）`);
}

/* ---------- 草稿：主池与线程分别保存，切线程不转移（§4.5 / TH-04） ---------- */

/**
 * 草稿不只是正文。
 *
 * 评审指出：只恢复正文、清空 @ 与附件，会**改变发送意图**（点名了谁、带了什么附件
 * 都属于这次输入的一部分）。因此草稿按"输入目标"整体保存。
 *
 * 2026-09-25 调整（默认与 AI 交流 / 一次性「仅记录」）：
 *  - `intent: 'task' | 'discussion'` 改为 `sendAs: 'ai' | 'record'`；
 *  - 落到 `localStorage`（键 `zhongshuo.drafts.v2`），**刷新后草稿与"仅记录"意图都还在** ——
 *    这正是本次要处理的"刷新恢复"要求（此前草稿只在内存里，刷新即丢）；
 *  - 旧数据（v1，含 `intent: 'discussion'`）按 §6 迁移：discussion → record，
 *    task → ai；**不做静默改写**（旧讨论草稿不会因为删掉切换控件就变成一次 AI 发送）。
 */
export interface FullDraft {
  body: string;
  mentions: string[];
  attachments: { name: string; size: number }[];
  access: string;
  /** 本次发送意图（一次性）：ai=交给 AI；record=仅记录、不请求回复 */
  sendAs: 'ai' | 'record';
  /** 草稿结构版本；v1 = 旧的 { intent: 'task'|'discussion' } 形态 */
  v: 2;
  updatedAt: number;
}

const EMPTY_DRAFT: FullDraft = {
  body: '',
  mentions: [],
  attachments: [],
  access: 'plan',
  sendAs: 'ai',
  v: 2,
  updatedAt: 0,
};

const DRAFTS_KEY = 'zhongshuo.drafts.v2';
/** 草稿保留 24 小时：原型里不该无限堆积只写过一次就放弃的草稿 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** 结构化草稿存储；正文同时镜像进 state.drafts，便于留痕面板观察 */
const fullDrafts = new Map<string, FullDraft>();
let draftsLoaded = false;

/** 旧草稿（v1）→ 新形态：discussion 迁移为 **record**，不是丢弃、也不是变成 AI 发送 */
function migrateDraft(raw: unknown): FullDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const body = typeof r.body === 'string' ? r.body : '';
  const mentions = Array.isArray(r.mentions) ? (r.mentions as string[]) : [];
  const attachments = Array.isArray(r.attachments) ? (r.attachments as { name: string; size: number }[]) : [];
  const access = typeof r.access === 'string' ? r.access : 'plan';
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : Date.now();
  if (r.v === 2) {
    return { body, mentions, attachments, access, sendAs: r.sendAs === 'record' ? 'record' : 'ai', v: 2, updatedAt };
  }
  // v1：intent: 'task' | 'discussion'
  return {
    body,
    mentions,
    attachments,
    access,
    sendAs: r.intent === 'discussion' ? 'record' : 'ai',
    v: 2,
    updatedAt,
  };
}

function loadDrafts() {
  if (draftsLoaded) return;
  draftsLoaded = true;
  try {
    const raw = window.localStorage?.getItem(DRAFTS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed)) {
      const d = migrateDraft(value);
      if (!d) continue;
      if (now - d.updatedAt > DRAFT_TTL_MS) continue; // 过期丢弃
      fullDrafts.set(key, d);
    }
  } catch {
    /* 本地存储不可用（隐私模式/被禁用）时按"没有草稿"处理，不影响输入 */
  }
}

function persistDrafts() {
  try {
    const obj: Record<string, FullDraft> = {};
    for (const [key, value] of fullDrafts) obj[key] = value;
    window.localStorage?.setItem(DRAFTS_KEY, JSON.stringify(obj));
  } catch {
    /* 写不进去时由调用方按"草稿未保存"提示（见 Composer 的 draftFailed） */
  }
}

export function setDraftFull(key: string, draft: Partial<FullDraft>) {
  loadDrafts();
  const prev = fullDrafts.get(key) ?? EMPTY_DRAFT;
  const next: FullDraft = { ...prev, ...draft, v: 2, updatedAt: Date.now() };
  fullDrafts.set(key, next);
  persistDrafts();
  setState((s) => (s.drafts[key] === next.body ? s : { ...s, drafts: { ...s.drafts, [key]: next.body } }));
}

export function getDraftFull(key: string): FullDraft {
  loadDrafts();
  const d = fullDrafts.get(key);
  if (d) return d;
  // 兜底：从 state 里的纯文本正文恢复（老数据或外部写入）
  return { ...EMPTY_DRAFT, body: state.drafts[key] ?? '' };
}

/** 草稿存储的键名（供测试与"清理本地草稿"使用；不导出内部结构） */
export const DRAFTS_STORAGE_KEY = DRAFTS_KEY;

export function setDraft(key: string, text: string) {
  setDraftFull(key, { body: text });
}

export function getDraft(key: string): string {
  return getDraftFull(key).body;
}

/* ---------- 导航态 ---------- */

export function setActiveThread(threadId: string | undefined) {
  setState((s) => ({ ...s, ui: { ...s.ui, activeThreadId: threadId } }));
}

export function setActiveRoom(roomId: string) {
  setState((s) =>
    s.ui.activeRoomId === roomId ? s : { ...s, ui: { ...s.ui, activeRoomId: roomId, activeThreadId: undefined } },
  );
}
