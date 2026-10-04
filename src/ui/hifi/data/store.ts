/**
 * 正式侧状态层（H1 首包，第四十七轮修订）：**替换原型种子 store 的真实实现**。
 *
 * 与原型 `hifi-prototype/src/data/store.ts` 的关系：导出同名 API（useStore/setState/
 * getState/recordLocalOnly/getDraftFull/setDraftFull/toast/clearToast/setTheme），使批准组件
 * 零漂移运行；状态来源=真实命令（loader → bridge → window.zs 正式命令面），**无种子、无 mock**。
 *
 * HifiState = AppState（原型视图模型——正式侧如实填充）+ 正式侧扩展（装载代次/按需快照/
 * 读取错误/接管状态）。未接通集合保持空值，由页面如实呈现；不伪造时间/成员/状态。
 */
import { useSyncExternalStore } from 'react';
import type { AppState } from './types';

/** 正式侧扩展状态（挂在 AppState 之上的真实投影层）。 */
export interface HifiExtension {
  /** 装载代次：openProject +1；迟到的旧项目响应按代次+项目身份双重门丢弃（review-r46 §5）。 */
  loadGen: number;
  /** 房间主池快照：roomId → 根消息（原型 Message 形状）。 */
  roomPool: Record<string, AppState['messages']>;
  /** 私信历史快照：conversationId → 消息。 */
  dmHistory: Record<string, AppState['messages']>;
  /** 读取失败（区别于空态）：key 同上，值为错误消息——保留旧快照并就地呈现错误。 */
  readErrors: Record<string, string>;
  /** 「原界面」接管状态。 */
  legacyActive: boolean;
  legacyReason: string | null;
  /** 首启装载（有界等待）状态。 */
  boot: 'pending' | 'ready' | 'failed';
  bootError: string | null;
}

export type HifiState = AppState & HifiExtension;

function makeEmptyState(): HifiState {
  return {
    projects: [], activeProjectId: '', visibleProjectIds: [], expandedProjectIds: [], pinnedProjectIds: [],
    fileGitTabs: {}, runtimeInstallations: [], profiles: [], members: [], rooms: [], threads: [],
    messages: [], dms: [], tasks: [], runs: [], turns: [], artifacts: [], resources: [],
    messageAttachments: [], pendingQuotes: [], changeSets: [], taskDeliveries: [],
    git: {}, issues: [], attention: [], reminders: [], devices: [], runtimeConfigs: {},
    mcpConnections: [], diagnostics: [],
    startupRecovery: { needsAttention: false, checkedAt: Date.now(), items: [], awaitingUserConfirm: false },
    readStates: {}, subscriptions: {}, followers: {}, absence: {}, writeLocks: {},
    drafts: {}, draftRefs: {},
    layout: { sizes: {}, navAutoHidden: false, navPinned: false },
    appSettings: {
      launchAtLogin: false, keepInTray: false, autoResumeTasks: false, logRetentionDays: 14,
      notifications: { muteAll: false, events: { approval: true, taskFailed: true, taskDone: true, mentioned: true }, channel: 'desktop', sound: true, dnd: { enabled: false, from: '', to: '' } },
      runtimeLimits: { maxActiveTurns: 3, maxTurnsPerMember: 1, providerCapEnabled: false, providerCapTurns: 3 },
    },
    preview: { tabs: [], hidden: true, maximized: false, contextChangedSinceOpen: false },
    ui: { theme: 'light', activeRoomId: '', writeLog: [] },
    // —— 正式侧扩展 ——
    loadGen: 0,
    roomPool: {}, dmHistory: {}, readErrors: {},
    legacyActive: false, legacyReason: null,
    boot: 'pending', bootError: null,
  };
}

let state: HifiState = makeEmptyState();
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
export function getState(): HifiState { return state; }
export function setState(updater: (prev: HifiState) => HifiState) { state = updater(state); emit(); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useStore<T>(selector: (s: HifiState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

/* ---------- 草稿（Composer 契约：按 draftKey 存整份草稿；缺省返回空草稿——原型 seeds 同形） ---------- */
export interface HifiDraft { body: string; mentions: string[]; attachments: Array<{ name: string; size: number }>; access: string; sendAs: 'ai' | 'record' }
const emptyDraft = (): HifiDraft => ({ body: '', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
const drafts = new Map<string, HifiDraft>();
export function getDraftFull(key: string): HifiDraft { return drafts.get(key) ?? emptyDraft(); }
export function setDraftFull(key: string, draft: unknown): void { drafts.set(key, draft as HifiDraft); }

/* ---------- 提示与主题 ---------- */
export type ToastTone = 'info' | 'warn' | 'error' | 'success';
export function toast(text: string, tone: ToastTone = 'info') {
  setState((s) => ({ ...s, ui: { ...s.ui, toast: { text, tone } } }));
  window.setTimeout(() => { clearToast(); }, 4200);
}
export function clearToast() { setState((s) => ({ ...s, ui: { ...s.ui, toast: undefined } })); }
export function setTheme(theme: 'light' | 'dark') {
  setState((s) => ({ ...s, ui: { ...s.ui, theme } }));
  try { localStorage.setItem('zs.hifi.theme', theme); } catch { /* 忽略 */ }
}

/* ---------- 写操作留痕（真实侧：只记不改状态——供诊断展示，H3 归位） ---------- */
export function recordWrite(api: string, detail: string) {
  setState((s) => ({ ...s, ui: { ...s.ui, writeLog: [{ at: Date.now(), api, detail }, ...s.ui.writeLog].slice(0, 60) } }));
}
/** 批准组件内部触发的本地动作（复制正文等）——如实登记「本地动作」，不冒充后端行为。 */
export function recordLocalOnly(name: string, detail: string) { recordWrite(`LOCAL_ONLY:${name}`, detail); }
