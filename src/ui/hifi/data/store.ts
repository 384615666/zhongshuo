/**
 * 正式侧状态层（H1 首包，第四十六轮）：**替换原型种子 store 的真实实现**。
 *
 * 与原型 `hifi-prototype/src/data/store.ts` 的关系：导出同名 API（useStore/setState/
 * getState/recordLocalOnly/getDraftFull/setDraftFull/toast/clearToast/setTheme），使原样拷贝的
 * 批准组件（MessageView/Composer/ui…）零改写运行；但状态来源=真实命令（bridge.ts →
 * window.zs 正式命令面），**没有种子数据、没有 mock 成功**——尚未装载/未接通的字段保持
 * 空值，由页面如实呈现。写操作（发送/仅记录/建会话）发真实命令并按响应更新状态。
 */
import { useSyncExternalStore } from 'react';
import type { AppState } from './types';

/** 最小可用 AppState：未接通集合一律空（页面按空态如实呈现，不用假数据）。 */
export function makeEmptyState(): AppState {
  return {
    projects: [], activeProjectId: '', visibleProjectIds: [], expandedProjectIds: [], pinnedProjectIds: [],
    fileGitTabs: {}, runtimeInstallations: [], profiles: [], members: [], rooms: [], threads: [],
    messages: [], dms: [], tasks: [], runs: [], turns: [], artifacts: [], resources: [],
    messageAttachments: [], preview: null, pendingQuotes: [], changeSets: [], taskDeliveries: [],
    git: {}, issues: [], attention: [], reminders: [], devices: [], runtimeConfigs: {},
    mcpConnections: [], diagnostics: [], startupRecovery: { needsAttention: false } as AppState['startupRecovery'],
    readStates: {}, subscriptions: {}, followers: {}, absence: {}, writeLocks: {},
    // hifi 正式侧自有扩展（挂在 ui 下，不与原型类型冲突——esbuild 不做结构检查）
    ui: { theme: 'light', toast: null, writeLog: [], booted: false, bootError: null } as unknown as AppState['ui'],
    layout: { navAutoHidden: false } as unknown as AppState['layout'],
    // 真实数据快照（按需装载；RoomPool/DmHistory 为 threadId/convId → Message[]）
    roomPool: {}, dmHistory: {}, legacyActive: false,
  } as unknown as AppState;
}

let state: AppState = makeEmptyState();
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
export function getState(): AppState { return state; }
export function setState(updater: (prev: AppState) => AppState) { state = updater(state); emit(); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

/* ---------- 草稿（Composer 契约：按 draftKey 存整份草稿；缺省返回空草稿——原型 seeds 同形） ---------- */
export interface HifiDraft { body: string; mentions: string[]; attachments: unknown[]; access: string; sendAs: string }
const emptyDraft = (): HifiDraft => ({ body: '', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
const drafts = new Map<string, HifiDraft>();
export function getDraftFull(key: string): HifiDraft { return drafts.get(key) ?? emptyDraft(); }
export function setDraftFull(key: string, draft: unknown): void { drafts.set(key, draft as HifiDraft); }

/* ---------- 提示与主题 ---------- */
export type ToastTone = 'info' | 'warn' | 'error' | 'success';
export function toast(text: string, tone: ToastTone = 'info') {
  setState((s) => ({ ...s, ui: { ...s.ui, toast: { text, tone } } } as AppState));
  window.setTimeout(() => { clearToast(); }, 4200);
}
export function clearToast() { setState((s) => ({ ...s, ui: { ...s.ui, toast: null } } as AppState)); }
export function setTheme(theme: string) {
  setState((s) => ({ ...s, ui: { ...s.ui, theme } } as AppState));
  try { localStorage.setItem('zs.hifi.theme', theme); } catch { /* 忽略 */ }
}

/* ---------- 写操作留痕（真实侧：只记不改状态——供诊断页展示，H3 归位） ---------- */
export function recordWrite(api: string, detail: string) {
  setState((s) => ({ ...s, ui: { ...s.ui, writeLog: [{ at: Date.now(), api, detail }, ...(s.ui.writeLog ?? [])].slice(0, 60) } } as AppState));
}
/** 原型组件内部触发的本地动作（复制正文/引用插入等未接通路径）——如实登记「本地动作」。 */
export function recordLocalOnly(name: string, detail: string) { recordWrite(`LOCAL_ONLY:${name}`, detail); }
