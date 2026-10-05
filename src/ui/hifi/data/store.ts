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
import type { AppState, Thread, ThreadCard } from './types';

/** 任务详情（第五十一轮 H2）：task.get 的真实 DTO——pendingDelivery 只有 id/revision/manifest_hash
 * 三重身份，不猜其余字段；lastStartupFailureMessage 缺省为 null（服务端没有就不显示）。 */
export interface ThreadTaskDetail {
  id: string;
  title: string;
  status: string;
  roomId: string;
  threadId: string | null;
  roomTaskNumber: number;
  revision: number;
  stopGeneration: number;
  activeRun: { id: string; status: string } | null;
  pendingDelivery: { id: string; revision: number; manifestHash: string } | null;
  lastStartupFailureMessage?: string | null;
}

/** 正式侧扩展状态（挂在 AppState 之上的真实投影层）。 */
export interface HifiExtension {
  /** 装载代次：openProject +1；迟到的旧项目响应按代次+项目身份双重门丢弃（review-r46 §5）。 */
  loadGen: number;
  /** 房间主池快照（第五十一轮起）：roomId → 线程卡（room.pool 真实投影）。 */
  roomPool: Record<string, ThreadCard[]>;
  /** 私信历史快照：conversationId → 消息。 */
  dmHistory: Record<string, AppState['messages']>;
  /** 线程实体（thread.get）：threadId → 实体（含 conversationId——发送目标用）。 */
  threadEntities: Record<string, Thread>;
  /** 线程根消息（thread.get anchor）：threadId → 根消息（缺失=null，呈现层标注）。 */
  threadAnchors: Record<string, AppState['messages'][number] | null>;
  /** 线程回复（thread.history items）：threadId → 回复列表（含附件摘要）。 */
  threadMessages: Record<string, AppState['messages']>;
  /** 线程任务详情（task.get）：threadId → 详情（记录串无任务则不写键）。 */
  threadTasks: Record<string, ThreadTaskDetail>;
  /** 线程阅读水位（thread.get lastReadSeq——首条未读分隔线用；服务端 thread_read_states 为准）。 */
  threadReadSeq: Record<string, number>;
  /** 附件上传项（第五十二轮 review-r51 §2）：draftKey → 在途/就绪/失败上传——跨页面实例
   * 共享（切线程再回来不丢），回执按 draftKey+uploadId 收敛到发起草稿。 */
  uploadItems: Record<string, import('./store').UploadItem[]>;
  /** 共享预览面板（第五十二轮 §6.1）：当前打开的附件目标（null=关闭）。 */
  previewPane: { target: PreviewTarget } | null;
  /** 读取失败（区别于空态）：key 同上，值为错误消息——保留旧快照并就地呈现错误。 */
  readErrors: Record<string, string>;
  /** 结果未知的在途信封（review-r47 §2）：按目标草稿键持有**不可变原信封**——重试严格重发
   * 原内容；期间新编辑作为独立草稿保留（组件卸载/切目标不丢）。 */
  pendingSends: Record<string, PendingSendEnvelope>;
  /** 标读统一门（review-r47 §4）：页面注册——markRead 发起前**此刻**重查（当前会话/前台/
   * 贴底/接管）；缺省拒绝（安全侧）。 */
  readGate: ((conversationId: string) => boolean) | null;
  /** 线程标读门（review-r50 §4）：**线程独立水位**（thread_message_seq 域）+当前导航代次/
   * 前台/贴底/接管——不与 DM 的 conversationSeq 门混用；缺省拒绝。 */
  threadReadGate: ((threadId: string) => boolean) | null;
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
    roomPool: {}, dmHistory: {}, threadEntities: {}, threadAnchors: {}, threadMessages: {}, threadTasks: {}, threadReadSeq: {}, uploadItems: {}, previewPane: null,
    readErrors: {}, pendingSends: {}, readGate: null, threadReadGate: null,
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

/**
 * 正式附件草稿（第五十二轮修订）：**已就绪引用**（随草稿持久化，恢复即显示）。
 * 上传中/失败态不放草稿——见 UploadItem（按草稿键+uploadId 收敛，review-r51 §2）。
 */
export interface HifiDraftAttachment {
  name: string;
  size: number;
  attachmentId: string;
  hash?: string;
  revision?: number;
  kind?: string;
  /** 表格注入范围（第五十二轮：从预览面板选定——缺省=服务端有界默认窗口）。 */
  range?: string;
}
export interface HifiDraft { body: string; mentions: string[]; attachments: HifiDraftAttachment[]; access: string; sendAs: 'ai' | 'record'; rev?: number }

/**
 * 上传项（review-r51 §2 反例修复）：每笔上传绑定**发起草稿键+独立 uploadId+会话**——
 * 迟到回执只收敛到自己；切走/卸载/同名文件不串到其它草稿；上传中被移除→回执到达即丢弃
 * （removed=true 不复活）；A→B→A 回来仍能看到 A 的上传结果（状态在 store，不在组件）。
 */
export interface UploadItem {
  uploadId: string;
  draftKey: string;
  conversationId: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'failed';
  attachmentId?: string;
  hash?: string;
  revision?: number;
  kind?: string;
  error?: string;
  /** 上传中被移除：回执/失败到达后即整体清除（不复活、不再显示）。 */
  removed?: boolean;
}

/** 预览目标（消息附件/草稿附件芯片点击打开）：hashHint/revisionHint 用于头部身份行。 */
export interface PreviewTarget {
  attachmentId: string;
  filename: string;
  kind: string;
  conversationId?: string;
  origin?: string;
  /** 从草稿芯片打开时携带——表格注入范围写回该草稿。 */
  draftKey?: string;
  hashHint?: string;
  revisionHint?: number | string;
}

export function openPreview(target: PreviewTarget): void {
  setState((s) => ({ ...s, previewPane: { target } }));
}
export function closePreview(): void {
  setState((s) => ({ ...s, previewPane: null }));
}

/** 上传项操作（store 层——回执按 draftKey+uploadId 精确收敛，绝不按文件名匹配）。 */
export function addUploadItem(item: UploadItem): void {
  setState((s) => ({ ...s, uploadItems: { ...s.uploadItems, [item.draftKey]: [...(s.uploadItems[item.draftKey] ?? []), item] } }));
}
export function settleUpload(draftKey: string, uploadId: string, patch: Partial<Pick<UploadItem, 'status' | 'attachmentId' | 'hash' | 'revision' | 'kind' | 'error'>>): void {
  setState((s) => {
    const list = s.uploadItems[draftKey] ?? [];
    const idx = list.findIndex((x) => x.uploadId === uploadId);
    if (idx < 0) return s; // 不存在（已被清理）——不复活
    const cur = list[idx]!;
    // 上传中被移除：丢弃回执并清除该项（不写 ready）。
    if (cur.removed === true) {
      const next = list.filter((x) => x.uploadId !== uploadId);
      return { ...s, uploadItems: { ...s.uploadItems, [draftKey]: next } };
    }
    const next = [...list];
    next[idx] = { ...cur, ...patch };
    return { ...s, uploadItems: { ...s.uploadItems, [draftKey]: next } };
  });
}
export function removeUploadItem(draftKey: string, uploadId: string): void {
  setState((s) => {
    const list = s.uploadItems[draftKey] ?? [];
    const cur = list.find((x) => x.uploadId === uploadId);
    if (cur == null) return s;
    const next = cur.status === 'uploading'
      ? list.map((x) => (x.uploadId === uploadId ? { ...x, removed: true } : x)) // 在途：标记，回执到达即弃
      : list.filter((x) => x.uploadId !== uploadId); // 已结算：直接清
    return { ...s, uploadItems: { ...s.uploadItems, [draftKey]: next } };
  });
}
/** 草稿就绪引用并入上传项（切回草稿时按草稿恢复的 ready 项重建芯片；已存在同 attachmentId 不重复）。 */
export function hydrateUploadRefs(draftKey: string, conversationId: string, refs: HifiDraftAttachment[]): void {
  setState((s) => {
    const list = s.uploadItems[draftKey] ?? [];
    const have = new Set(list.map((x) => x.attachmentId));
    const add = refs.filter((r) => r.attachmentId != null && !have.has(r.attachmentId))
      .map((r) => ({ uploadId: `upl_${Math.random().toString(36).slice(2, 10)}`, draftKey, conversationId, name: r.name, size: r.size, status: 'ready' as const, attachmentId: r.attachmentId, hash: r.hash, revision: r.revision, kind: r.kind }));
    if (add.length === 0) return s;
    return { ...s, uploadItems: { ...s.uploadItems, [draftKey]: [...list, ...add] } };
  });
}
/** 清空已结算项（发送成功按 refs 清——保留仍在途/失败的）。 */
export function clearSettledUploads(draftKey: string, sentAttachmentIds: string[]): void {
  const sent = new Set(sentAttachmentIds);
  setState((s) => {
    const list = s.uploadItems[draftKey] ?? [];
    const next = list.filter((x) => !(x.status !== 'uploading' && x.attachmentId != null && sent.has(x.attachmentId)));
    if (next.length === list.length) return s;
    return { ...s, uploadItems: { ...s.uploadItems, [draftKey]: next } };
  });
}

/** 结果未知的在途信封（不可变快照——重试只发这一份）。 */
export interface PendingSendEnvelope {
  commandId: string;
  method: 'message.submit';
  params: { target: Record<string, unknown>; body: string; intent: 'default' | 'record_only'; mentions: Array<{ kind: string; memberId?: string }>; attachmentRefs?: string[] };
  targetLabel: string;
  at: number;
  /** 发起时的草稿编辑代次（review-r48 §4）：清算只在代次未变时剥离已发内容。 */
  revAtSend?: number;
  /** 同键连续未知（review-r48 §4）：先到先重试，不覆盖前一份未确认信封。 */
  queued?: PendingSendEnvelope[];
}

export function setReadGate(gate: ((conversationId: string) => boolean) | null): void {
  setState((s) => ({ ...s, readGate: gate }));
}

export function canMarkRead(conversationId: string): boolean {
  const gate = getState().readGate;
  try { return gate != null && gate(conversationId); } catch { return false; }
}

/** 线程独立水位门（review-r50 §4）：thread.markRead 发起前此刻重查——当前线程+前台/贴底/
 * 接管状态由 ThreadPage 注册；与 DM 的 conversationSeq 门分开（打开房间≠读完线程）。 */
export function setThreadReadGate(gate: ((threadId: string) => boolean) | null): void {
  setState((s) => ({ ...s, threadReadGate: gate }));
}

export function canMarkThreadRead(threadId: string): boolean {
  const gate = getState().threadReadGate;
  try { return gate != null && gate(threadId); } catch { return false; }
}

export function parkUnknownEnvelope(draftKey: string, env: PendingSendEnvelope): void {
  setState((s) => {
    const cur = s.pendingSends[draftKey];
    if (cur == null) return { ...s, pendingSends: { ...s.pendingSends, [draftKey]: env } };
    // 已有未确认信封：排队（不覆盖前一份——review-r48 §4）。
    return { ...s, pendingSends: { ...s.pendingSends, [draftKey]: { ...cur, queued: [...(cur.queued ?? []), env] } } };
  });
}

/** 清除队首信封：有排队则下一条顶上（banner 连续重试），否则清空。 */
export function clearUnknownEnvelope(draftKey: string): void {
  setState((s) => {
    const cur = s.pendingSends[draftKey];
    if (cur != null && (cur.queued ?? []).length > 0) {
      const [head, ...rest] = cur.queued as PendingSendEnvelope[];
      return { ...s, pendingSends: { ...s.pendingSends, [draftKey]: { ...head, queued: rest } } };
    }
    const next = { ...s.pendingSends }; delete next[draftKey];
    return { ...s, pendingSends: next };
  });
}
const emptyDraft = (): HifiDraft => ({ body: '', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
const drafts = new Map<string, HifiDraft>();
let draftRev = 0;
export function getDraftFull(key: string): HifiDraft { return drafts.get(key) ?? emptyDraft(); }
/** 每次写入递增编辑代次（清算按代次判定——等待期编辑过则不剥离已发内容）。 */
export function setDraftFull(key: string, draft: unknown): void { draftRev += 1; drafts.set(key, { ...(draft as HifiDraft), rev: draftRev }); }

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
