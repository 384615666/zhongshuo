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
  /** r58 返工待执行（验收与执行分离呈现）；r59 含完整执行身份（点击冻结快照）。 */
  reworkPending: { deliveryId: string; deliveryRevision: number; manifestHash: string; sourceRunId: string; note: string | null; queued: boolean } | null;
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
  /** 打开项目在途标记（r58 P4）：首启后台观察器据此让位——手动/显式打开优先于种子竞态
   *（openProjectByPath 入口置位、收尾清除；避免「打开在途时观察器抢代次」覆盖用户选择）。 */
  openInFlight: boolean;
  /**
   * daemon 实时连接态（r55：标题栏接真实断连/重连——首启 ready 不能永久等同在线）。
   * main 进程在管道关闭时发 zs:disconnect、重连成功后发 zs:reconnected；浏览器宿主
   * （探针/无 preload）收不到事件，保持 'online' 缺省并按 boot 呈现。connInfo 为断线
   * 时 main 给出的说明（原样透传，不虚构）。
   */
  conn: 'online' | 'offline';
  connInfo: string | null;
  /** r61 G6：本用户 message 类收藏事实（saved_refs 投影）——消息行书签按钮的已收藏状态
   * 与收藏页取消后的行内同步共用这一份；项目打开时刷新，切换成功即更新。 */
  savedMessageRefs: Record<string, boolean>;
  /** r61 G7：待插入草稿的正文文本（摘录等）——目标 Composer 未挂载时排队，挂载即消费。 */
  draftInserts: Record<string, Array<{ id: number; text: string }>>;
  /** r62 P1 出站账本：交给 bridge **之前**耐久落盘的完整发送意图（stage=sending）——按
   * ok/failed/unknown 收口；重载时全部转 pendingSends（recovered，人工同号确认）。 */
  outboundLedger: Record<string, OutboundLedgerEntry[]>;
  /**
   * r61 P5 草稿/未知信封持久化状态：mode=on（identity 就绪、localStorage 可写）时每次草稿/
   * 信封/上传项变更即快照落盘；error 非空=最近一次持久化失败（内存仍生效，UI 如实提示
   * 「未持久化——刷新/崩溃会丢」，不静默）。mode=off=身份不可用（浏览器宿主/服务未就绪）
   * ——退回内存态，如实标注。
   */
  draftPersist: { mode: 'on' | 'off'; error: string | null; /** r62 P2：快照恢复说明（版本/损坏隔离、TTL 过期计数）——与写入失败 error 分列。 */ recoveryNote: string | null };
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
    boot: 'pending', bootError: null, openInFlight: false,
    conn: 'online', connInfo: null,
    savedMessageRefs: {},
    draftInserts: {},
    outboundLedger: {},
    draftPersist: { mode: 'off', error: null, recoveryNote: null },
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

/* ---------- 引用与摘录（r61 G7：引用=文件/版本引用卡直写草稿；摘录=内容文本插入队列） ---------- */

/**
 * 文件引用直写草稿（r61 G7 重做）：预览「引用文件」把**资源引用卡**写进目标草稿的
 * attachments（同上传附件同一正式链路——发送时进 attachmentRefs，服务端按 ID 做
 * audience/完整性/范围/图片门；正文保持用户文字，全文不自动粘贴）。
 * - 原子：ready 芯片（uploadItems）与草稿 ref 在同一次调用内写入（JS 单线程无中间窗口）；
 * - 去重：同 attachmentId+revision 已在草稿→existed（同文件同版本不积压；新版本=新行）；
 * - 失败零写入：目标缺失/参数非法返回错误，不产生幽灵芯片或幽灵 ref。
 */
export function addFileRefToDraft(draftKey: string, conversationId: string, ref: { attachmentId: string; name: string; kind: string; revision?: number; hash?: string }): { ok: boolean; existed?: boolean; error?: string } {
  if (draftKey.length === 0) return { ok: false, error: '目标草稿未知' };
  if (ref.attachmentId == null || ref.attachmentId.length === 0) return { ok: false, error: '资源身份缺失（attachmentId）——不凭文件名猜身份' };
  const d = getDraftFull(draftKey);
  if (d.attachments.some((a) => a.attachmentId === ref.attachmentId && (a.revision ?? 0) === (ref.revision ?? 0))) {
    return { ok: true, existed: true };
  }
  const item: UploadItem = {
    uploadId: `ref_${Math.random().toString(36).slice(2, 10)}`,
    draftKey, conversationId,
    name: ref.name, size: 0,
    status: 'ready',
    attachmentId: ref.attachmentId, hash: ref.hash, revision: ref.revision, kind: ref.kind,
  };
  setState((s) => ({ ...s, uploadItems: { ...s.uploadItems, [draftKey]: [...(s.uploadItems[draftKey] ?? []), item] } }));
  setDraftFull(draftKey, { ...d, attachments: [...d.attachments, { name: ref.name, size: 0, attachmentId: ref.attachmentId, hash: ref.hash, revision: ref.revision, kind: ref.kind }] });
  return { ok: true, existed: false };
}

/**
 * 摘录/正文插入队列（r61 G7）：目标 Composer 未挂载（成果/详情标签）时先入队，挂载时
 * 消费——不再出现「旧队列无人消费、后续新点击批量灌入」。同文本去重（防双击重复入队）。
 */
export function queueDraftInsert(draftKey: string, text: string): { ok: boolean; queued?: boolean; error?: string } {
  if (draftKey.length === 0) return { ok: false, error: '目标草稿未知' };
  if (text.trim().length === 0) return { ok: false, error: '插入内容为空' };
  const cur = getState().draftInserts[draftKey] ?? [];
  if (cur.some((x) => x.text === text)) return { ok: true, queued: false };
  setState((s) => ({ ...s, draftInserts: { ...s.draftInserts, [draftKey]: [...(s.draftInserts[draftKey] ?? []), { id: Date.now() + Math.floor(Math.random() * 1000), text }] } }));
  return { ok: true, queued: true };
}

/** Composer 挂载/zs:focus-composer 时取走并清空该目标的待插入文本（一次性消费）。 */
export function takeDraftInserts(draftKey: string): Array<{ id: number; text: string }> {
  const cur = getState().draftInserts[draftKey];
  if (cur == null || cur.length === 0) return [];
  setState((s) => { const next = { ...s.draftInserts }; delete next[draftKey]; return { ...s, draftInserts: next }; });
  return cur;
}

/** 草稿目标的正式会话身份（r61 G7 跨会话引用边界）：thread→threadEntities、room→rooms、
 * dm→会话 id。未知返回 null（调用方按「无法核对」如实处理——服务端仍按 audience 终审）。 */
export function conversationOfDraftKey(draftKey: string): string | null {
  const s = getState();
  if (draftKey.startsWith('thread:')) return s.threadEntities[draftKey.slice('thread:'.length)]?.conversationId ?? null;
  if (draftKey.startsWith('room:')) return s.rooms.find((r) => r.id === draftKey.slice('room:'.length))?.conversationId ?? null;
  if (draftKey.startsWith('dm:')) return draftKey.slice('dm:'.length);
  return null;
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
export interface HifiDraft { body: string; mentions: string[]; attachments: HifiDraftAttachment[]; access: string; sendAs: 'ai' | 'record'; rev?: number; /** r62：普通草稿 24h 过期的时间戳（批准 brief §3.3）；未确认发送账本不适用。 */ updatedAt?: number }

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
  persistSnapshot();
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
  persistSnapshot();
}

/**
 * 上传成功回执的**原子结算**（review-r53 §3）：一次调用内同时核 (draftKey, uploadId) 项存在、
 * 未被移除、发起会话一致——全部通过才把上传项置 ready **并把引用写进发起草稿**（两写在同一
 * 同步事务里，JS 单线程下不存在中间被移除的窗口）。任何不通过：回执整体丢弃（移除项即行
 * 清除），**不写任何草稿 ref**——已移除/取消/消失的资源不会经草稿进入下一条真实信封。
 * 幂等：同 uploadId 二次回执或草稿已有同 attachmentId 引用时不再重复写。
 * 返回 true=回执被接受（ready+草稿 ref 均已写）；false=已丢弃（调用方不得再写草稿）。
 */
export function settleUploadReady(draftKey: string, uploadId: string, conversationId: string, receipt: { name: string; size: number; attachmentId: string; hash?: string; revision?: number; kind?: string }): boolean {
  const list = getState().uploadItems[draftKey] ?? [];
  const cur = list.find((x) => x.uploadId === uploadId);
  if (cur == null) return false; // 已消失（被清理）——不复活、不写草稿
  if (cur.removed === true) {
    // 上传中被移除：清项+丢弃回执——芯片已消失，草稿也不得出现该引用。
    setState((s) => ({ ...s, uploadItems: { ...s.uploadItems, [draftKey]: (s.uploadItems[draftKey] ?? []).filter((x) => x.uploadId !== uploadId) } }));
    persistSnapshot();
    return false;
  }
  if (cur.conversationId !== conversationId) {
    // 回执会话与发起会话不一致（跨会话串线）：按失败分列，不写草稿 ref。
    setState((s) => ({ ...s, uploadItems: { ...s.uploadItems, [draftKey]: (s.uploadItems[draftKey] ?? []).map((x) => (x.uploadId === uploadId ? { ...x, status: 'failed' as const, error: `回执会话不一致（${conversationId}）——已丢弃` } : x)) } }));
    persistSnapshot();
    return false;
  }
  if (cur.status === 'ready' && cur.attachmentId === receipt.attachmentId) return true; // 已结算过的同一回执——幂等
  setState((s) => {
    const curList = s.uploadItems[draftKey] ?? [];
    const idx = curList.findIndex((x) => x.uploadId === uploadId);
    if (idx < 0) return s;
    const next = [...curList];
    next[idx] = { ...curList[idx]!, status: 'ready', attachmentId: receipt.attachmentId, hash: receipt.hash, revision: receipt.revision, kind: receipt.kind };
    return { ...s, uploadItems: { ...s.uploadItems, [draftKey]: next } };
  });
  const d = getDraftFull(draftKey);
  if (!d.attachments.some((a) => a.attachmentId === receipt.attachmentId)) {
    setDraftFull(draftKey, { ...d, attachments: [...d.attachments, { name: receipt.name, size: receipt.size, attachmentId: receipt.attachmentId, hash: receipt.hash, revision: receipt.revision, kind: receipt.kind }] });
  }
  return true;
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
  persistSnapshot();
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
  persistSnapshot();
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
  persistSnapshot();
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
  /** r62 P1：重载收口标记——出站账本恢复为「结果未知」人工同号确认项。 */
  recovered?: boolean;
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
  persistSnapshot(); // r61 P5：完整未知信封（含 queued）跨崩溃保留——同号同参重试、业务恰一次
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
  persistSnapshot();
}
const emptyDraft = (): HifiDraft => ({ body: '', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
const drafts = new Map<string, HifiDraft>();
let draftRev = 0;
export function getDraftFull(key: string): HifiDraft { return drafts.get(key) ?? emptyDraft(); }
/** 每次写入递增编辑代次（清算按代次判定——等待期编辑过则不剥离已发内容）。 */
export function setDraftFull(key: string, draft: unknown): void { draftRev += 1; drafts.set(key, { ...(draft as HifiDraft), rev: draftRev, updatedAt: Date.now() }); persistSnapshot(); }

/* ---------- 草稿/未知信封持久化（r61 P5 起；r62 P2 快照防护修订） ----------
 * 批准原型 brief §3.3「版本化草稿、localStorage、刷新保持；updatedAt + 普通草稿 24 小时
 * 过期」：正文/提及/意图/已就绪引用跨 reload/renderer 崩溃保留；重载不自动发送、仅记录
 * 意图不因重载变 AI。**未确认发送账本（pendingSends/staged）独立保存，不受普通草稿 TTL
 * 清理**（r61 注释把「普通草稿亦无过期」当既定约定系误写，r62 按批准约定落实 24h）。
 * 命名空间=数据根+本地用户（app.identity）；在途上传不持久化（恢复=重新选择状态）；
 * ready/failed 项随草稿保留（草稿过期则一并不恢复）；removed 项不落盘。
 * 快照防护（r62）：读入先做 schema/版本/逐条字段校验——不支持版本或整体损坏时**原件逐字
 * 隔离**到 `<key>.quarantine-<ts>` 后才从新空态开始（不覆写唯一原件、不伪正常）；部分条目
 * 损坏时恢复有效条目、隔离原件并经 recoveryNote 如实说明丢弃计数；隔离件中的未确认账本
 * 不解析不自动派发。持久化写入失败：内存仍生效 + draftPersist.error 如实提示。 */

const PERSIST_VERSION = 1;
/** 普通草稿过期（批准 brief §3.3：updatedAt + 24h）。未确认发送账本不适用。 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
let persistKey: string | null = null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 草稿条目字段校验（r62 P2）：结构不符=损坏（不恢复该条；原件进隔离）。 */
function validateDraft(d: unknown): d is HifiDraft {
  if (!isPlainObject(d)) return false;
  if (typeof d.body !== 'string' || !Array.isArray(d.mentions) || d.mentions.some((m) => typeof m !== 'string')) return false;
  if (!Array.isArray(d.attachments) || d.attachments.some((a) => !isPlainObject(a) || typeof a.attachmentId !== 'string' || typeof a.name !== 'string')) return false;
  if (typeof d.access !== 'string' || (d.sendAs !== 'ai' && d.sendAs !== 'record')) return false;
  if (d.rev != null && typeof d.rev !== 'number') return false;
  if (d.updatedAt != null && typeof d.updatedAt !== 'number') return false;
  return true;
}

/** 未确认信封字段校验：commandId/method/params.body/intent/target 逐项——损坏=不恢复（原件隔离，
 * 不自动派发）。queued 递归同判。 */
function validateEnvelope(e: unknown): e is PendingSendEnvelope {
  if (!isPlainObject(e)) return false;
  if (typeof e.commandId !== 'string' || e.commandId.length === 0 || e.method !== 'message.submit') return false;
  const p = e.params;
  if (!isPlainObject(p) || typeof p.body !== 'string' || (p.intent !== 'default' && p.intent !== 'record_only') || !isPlainObject(p.target)) return false;
  if (e.at != null && typeof e.at !== 'number') return false;
  if (e.queued != null && (!Array.isArray(e.queued) || e.queued.some((q) => !validateEnvelope(q)))) return false;
  return true;
}

function validateUploadItem(u: unknown): u is UploadItem {
  if (!isPlainObject(u)) return false;
  if (typeof u.uploadId !== 'string' || typeof u.draftKey !== 'string' || typeof u.conversationId !== 'string' || typeof u.name !== 'string') return false;
  if (u.status !== 'uploading' && u.status !== 'ready' && u.status !== 'failed') return false;
  if (typeof u.size !== 'number') return false;
  return true;
}

function persistSnapshot(): void {
  if (persistKey == null) return; // 未初始化（identity 未就绪/浏览器宿主）——内存态
  try {
    const uploadsOut: Record<string, UploadItem[]> = {};
    for (const [k, list] of Object.entries(state.uploadItems)) {
      const kept = list.filter((x) => x.removed !== true && x.status !== 'uploading');
      if (kept.length > 0) uploadsOut[k] = kept;
    }
    const draftsOut: Record<string, HifiDraft> = {};
    const now = Date.now();
    for (const [k, v] of drafts) draftsOut[k] = v.updatedAt != null ? v : { ...v, updatedAt: now };
    const payload = JSON.stringify({ v: PERSIST_VERSION, savedAt: now, drafts: draftsOut, pendingSends: state.pendingSends, uploadItems: uploadsOut, outboundLedger: state.outboundLedger });
    localStorage.setItem(persistKey, payload);
    if (state.draftPersist.error != null || state.draftPersist.mode === 'off') setState((s) => ({ ...s, draftPersist: { mode: 'on', error: null, recoveryNote: s.draftPersist.recoveryNote } }));
  } catch (e) {
    const msg = `草稿持久化失败：${e instanceof Error ? e.message : String(e)}——本次进程内仍有效，刷新或崩溃会丢失未发送内容`;
    setState((s) => (s.draftPersist.error === msg ? s : { ...s, draftPersist: { ...s.draftPersist, mode: 'on', error: msg } }));
  }
}

/**
 * 初始化（identity 就绪后调用一次）：载入上次快照并立即写一次确认可写性。
 * r62 快照防护：不支持版本/整体损坏/部分条目损坏——**原件逐字隔离**到
 * `<key>.quarantine-<ts>`（localStorage 尽力；失败时至少不覆盖主键并如实说明），恢复
 * 有效部分；能恢复/不能恢复事实经 recoveryNote 分列；隔离件内未确认账本不解析不派发。
 * 普通草稿按批准约定 24h 过期（updatedAt 缺失回退快照 savedAt）；未确认发送账本不清理。
 */
export function initDraftPersistence(ns: string): void {
  persistKey = `zs.hifi.persist.${ns}`;
  let raw: string | null;
  try {
    raw = localStorage.getItem(persistKey);
  } catch (e) {
    persistKey = null;
    setState((s) => ({ ...s, draftPersist: { mode: 'off', error: `草稿持久化不可读：${e instanceof Error ? e.message : String(e)}——草稿仅本次进程内有效`, recoveryNote: null } }));
    return;
  }
  let recoveryNote: string | null = null;
  if (raw != null) {
    let data: unknown = null;
    let parseOk = true;
    try { data = JSON.parse(raw); } catch { parseOk = false; }
    const wholeUnrecoverable = !parseOk || !isPlainObject(data) || data.v !== PERSIST_VERSION;
    let restoredDrafts = 0; let expiredDrafts = 0; let droppedDrafts = 0; let droppedSends = 0; let droppedUploads = 0; let restoredSends = 0;
    let maxRev = 0;
    if (!wholeUnrecoverable && isPlainObject(data)) {
      const snapAt = typeof data.savedAt === 'number' ? data.savedAt : Date.now();
      const now = Date.now();
      for (const [k, d] of Object.entries((data.drafts ?? {}) as Record<string, unknown>)) {
        if (!validateDraft(d)) { droppedDrafts += 1; continue; }
        const age = now - (d.updatedAt ?? snapAt);
        if (age > DRAFT_TTL_MS) { expiredDrafts += 1; continue; } // 普通草稿 24h 过期（批准约定）
        drafts.set(k, d.updatedAt != null ? d : { ...d, updatedAt: snapAt });
        restoredDrafts += 1;
        if (typeof d.rev === 'number' && d.rev > maxRev) maxRev = d.rev;
      }
      const sends: Record<string, PendingSendEnvelope> = {};
      for (const [k, e] of Object.entries((data.pendingSends ?? {}) as Record<string, unknown>)) {
        if (!validateEnvelope(e)) { droppedSends += 1; continue; }
        sends[k] = e; restoredSends += 1; // 未确认账本：无 TTL（不因普通草稿过期清理）
      }
      const uploads: Record<string, UploadItem[]> = {};
      for (const [k, list] of Object.entries((data.uploadItems ?? {}) as Record<string, unknown>)) {
        if (!Array.isArray(list)) { droppedUploads += 1; continue; }
        const kept = list.filter((u): u is UploadItem => validateUploadItem(u) && u.status !== 'uploading' && drafts.has(k));
        if (kept.length !== list.length) droppedUploads += list.length - kept.length;
        if (kept.length > 0) uploads[k] = kept;
      }
      const ledger: Record<string, OutboundLedgerEntry[]> = {};
      for (const [k, list] of Object.entries((data.outboundLedger ?? {}) as Record<string, unknown>)) {
        if (!Array.isArray(list)) { droppedSends += 1; continue; }
        const kept = list.filter((x): x is OutboundLedgerEntry => validateEnvelope(x));
        if (kept.length !== list.length) droppedSends += list.length - kept.length;
        if (kept.length > 0) ledger[k] = kept.map((x) => ({ ...x, stage: 'sending' as const }));
      }
      draftRev = Math.max(draftRev, maxRev);
      setState((s) => ({ ...s, pendingSends: { ...sends, ...s.pendingSends }, uploadItems: { ...uploads, ...s.uploadItems }, outboundLedger: ledger }));
    }
    // 任一不可恢复/丢弃/过期：原件逐字隔离（先隔离后覆写——不销毁唯一原件；隔离尽力而为，
    // 失败时保留主键原样并说明，本轮内存态照常可用）。隔离件中的未确认账本不解析不派发。
    const anythingDropped = wholeUnrecoverable || droppedDrafts + droppedSends + droppedUploads > 0;
    if (anythingDropped) {
      const qKey = `${persistKey}.quarantine-${Date.now()}`;
      let quarantined = false;
      try { localStorage.setItem(qKey, raw); quarantined = true; } catch { quarantined = false; }
      if (wholeUnrecoverable) {
        recoveryNote = `草稿快照无法恢复（${parseOk ? `版本 v${String((data as { v?: unknown })?.v ?? '?')} 不受本程序支持` : 'JSON 损坏'}）——原件已${quarantined ? `逐字隔离于 ${qKey}（含未确认发送账本，不自动派发；如需人工核对请勿编辑该键）` : '无法隔离（localStorage 拒写）——主键保留原样，本轮草稿仅内存态'}，新快照从空态开始`;
      } else {
        const parts: string[] = [];
        if (droppedDrafts > 0) parts.push(`损坏草稿 ${droppedDrafts} 条`);
        if (droppedSends > 0) parts.push(`损坏未确认信封 ${droppedSends} 条（不自动派发）`);
        if (droppedUploads > 0) parts.push(`损坏/悬空上传项 ${droppedUploads} 项`);
        if (expiredDrafts > 0) parts.push(`超过 24 小时过期草稿 ${expiredDrafts} 条（按约定不恢复）`);
        recoveryNote = `草稿快照部分无法恢复：${parts.join('、')}——原件已${quarantined ? `隔离于 ${qKey}` : '无法隔离（主键保留原样）'}；有效部分（草稿 ${restoredDrafts} 条/未确认信封 ${restoredSends} 条）已恢复`;
      }
    }
  }
  persistSnapshot(); // 可写性确认+把「仅有效部分」落为新快照（原件已在隔离键保全）
  recoverLedgerToPending(); // r62 P1：在途发送恢复为未确认横幅（人工同号确认，不自动发送）
  setState((s) => (s.draftPersist.error == null ? { ...s, draftPersist: { mode: 'on', error: null, recoveryNote } } : { ...s, draftPersist: { ...s.draftPersist, recoveryNote } }));
}

/** identity 不可用（服务未就绪/浏览器宿主）：内存态+如实标注（不冒充已持久化）。 */
export function markPersistenceDegraded(reason: string): void {
  setState((s) => (s.draftPersist.mode === 'off' ? s : { ...s, draftPersist: { ...s.draftPersist, mode: 'off', error: reason } }));
}

/* ---------- 出站信封账本（r62 P1，review-r61 §2） ----------
 * 独立反例（early-crash-result.json）：信封只在 sendEnvelope 返回 unknown 后才 park——
 * 「服务已提交→回执未达→20s 超时前 renderer 崩溃」窗口内完整信封只在内存，重载后无原
 * commandId，再次发送换新号→消息 1→2。本账本把**完整发送意图在交给 bridge 之前耐久落盘**
 *（stage=sending），并按结果收口：
 *  - ok → settleOutbound：**先剥已发草稿内容并持久化**（revAtSend 门——等待期编辑保留）、
 *    剥本信封 attachmentRefs、清已结算上传项，**最后**才删账本条目——中途任何崩溃=账本仍在
 *    →重载转未确认横幅→同号重发→daemon 幂等 replayed ok→再次结算，不暴露可重复发送内容；
 *  - failed（明确拒绝）→ dropOutbound：删账本条目（草稿保留——用户改后重发走新号是预期）；
 *  - unknown → confirmOutboundUnknown：转 pendingSends（横幅=人工同号同参确认）。
 * 重载（initDraftPersistence）：账本条目全部转 pendingSends（recovered 标记）——不自动发送、
 * 不静默退回普通草稿；Composer 在「正文与横幅信封一致且未改」时阻止新号发送（防重复）。
 * 存储失败：stageOutbound 返回 ok=false，调用方**取消发送**并如实报错——不以「已安全保存
 * 原信封」的假象继续。 */

/** 出站账本条目（persist 面向未知信封同构，附阶段标记）。 */
export interface OutboundLedgerEntry extends PendingSendEnvelope { stage: 'sending' }

export function stageOutbound(draftKey: string, env: PendingSendEnvelope): { ok: boolean; error?: string } {
  const entry: OutboundLedgerEntry = { ...env, stage: 'sending' };
  setState((s) => ({ ...s, outboundLedger: { ...s.outboundLedger, [draftKey]: [...(s.outboundLedger[draftKey] ?? []), entry] } }));
  persistSnapshot();
  const err = getState().draftPersist.error;
  if (err != null) {
    // 落盘失败=账本不可靠：回滚内存条目并取消发送（不冒充已保存原信封）。
    setState((s) => ({ ...s, outboundLedger: { ...s.outboundLedger, [draftKey]: (s.outboundLedger[draftKey] ?? []).filter((x) => x.commandId !== env.commandId) } }));
    return { ok: false, error: `原信封未能耐久保存（${err}）——本次未发送；存储恢复后重试即自动可用` };
  }
  return { ok: true };
}

/** ok 结算：先剥已发内容（持久化），最后删账（顺序即崩溃安全——见块注释）。 */
/**
 * 统一成功清算（r63 P1——review-r62 §2 双重结算反例收口）：**唯一**的发送成功结算源，一次
 * 写处理正文剥离/mentions 清理/已发 refs 剥离/一次性意图复位/上传项清理（先剥内容并持久化、
 * 最后删账——顺序即崩溃安全）。Composer 成功分支与未知重试成功分支只读结算结果同步 UI，
 * 不再各自 setDraftFull（双结算递增代次会使 revAtSend 门失效，已发 @ 指派残留）。
 * 语义：revAtSend 未变（等待期未编辑）→ 剥本次已发正文、清本次 mentions（payload {member/all}
 * ↔ 草稿 id 串映射）、剥本次 refs、record_only 一次性复位（记录串回 record、其余回 ai）；
 * 等待期新编辑/新 @/新附件保留。返回结算后的草稿（现挂目标 UI 同步用）。
 */
export function settleOutbound(draftKey: string, env: PendingSendEnvelope, opts?: { recordThread?: boolean }): HifiDraft {
  const d = getDraftFull(draftKey);
  const unchanged = env.revAtSend == null || d.rev === env.revAtSend;
  const nextBody = unchanged && d.body.startsWith(env.params.body) ? d.body.slice(env.params.body.length).replace(/^\s+/, '') : d.body;
  const sentMentionKeys = env.params.mentions.map((m) => (m.kind === 'all' ? 'all' : m.memberId ?? ''));
  const mentionsClear = unchanged && d.mentions.length === sentMentionKeys.length && d.mentions.every((m, i) => m === sentMentionKeys[i]);
  const sentIds = new Set(env.params.attachmentRefs ?? []);
  const keptAttachments = d.attachments.filter((a) => !sentIds.has(a.attachmentId));
  const settled: HifiDraft = {
    ...d,
    body: nextBody,
    mentions: mentionsClear ? [] : d.mentions,
    attachments: keptAttachments,
    sendAs: env.params.intent === 'record_only' ? (opts?.recordThread === true ? 'record' : 'ai') : d.sendAs,
  };
  setDraftFull(draftKey, settled);
  clearSettledUploads(draftKey, [...sentIds]);
  setState((s) => {
    const ledger = (s.outboundLedger[draftKey] ?? []).filter((x) => x.commandId !== env.commandId);
    const nextLedger = { ...s.outboundLedger };
    if (ledger.length > 0) nextLedger[draftKey] = ledger; else delete nextLedger[draftKey];
    // 同 commandId 的 parked 条目一并清（同号确认后的收口；跨键不动）。
    const cur = s.pendingSends[draftKey];
    const strip = (e: PendingSendEnvelope): PendingSendEnvelope => (e.queued != null && e.queued.length > 0 ? { ...e, queued: e.queued.filter((q) => q.commandId !== env.commandId) } : e);
    let sends = s.pendingSends;
    if (cur != null) {
      if (cur.commandId === env.commandId && (cur.queued ?? []).length === 0) { const n = { ...s.pendingSends }; delete n[draftKey]; sends = n; }
      else if (cur.commandId === env.commandId && (cur.queued ?? []).length > 0) { const [head, ...rest] = cur.queued as PendingSendEnvelope[]; sends = { ...s.pendingSends, [draftKey]: { ...head, queued: rest } }; }
      else if (cur.queued != null && cur.queued.some((q) => q.commandId === env.commandId)) sends = { ...s.pendingSends, [draftKey]: strip(cur) };
    }
    return { ...s, outboundLedger: nextLedger, pendingSends: sends };
  });
  persistSnapshot();
  return settled;
}

/** 明确拒绝：删账本条目（草稿保留）。 */
export function dropOutbound(draftKey: string, env: PendingSendEnvelope): void {
  setState((s) => {
    const ledger = (s.outboundLedger[draftKey] ?? []).filter((x) => x.commandId !== env.commandId);
    const nextLedger = { ...s.outboundLedger };
    if (ledger.length > 0) nextLedger[draftKey] = ledger; else delete nextLedger[draftKey];
    return { ...s, outboundLedger: nextLedger };
  });
  persistSnapshot();
}

/** 结果未知：账本条目转 pendingSends（横幅=人工同号同参确认；排队语义沿用 park）。 */
export function confirmOutboundUnknown(draftKey: string, env: PendingSendEnvelope): void {
  setState((s) => {
    const ledger = (s.outboundLedger[draftKey] ?? []).filter((x) => x.commandId !== env.commandId);
    const nextLedger = { ...s.outboundLedger };
    if (ledger.length > 0) nextLedger[draftKey] = ledger; else delete nextLedger[draftKey];
    const cur = s.pendingSends[draftKey];
    const pendingSends = cur == null
      ? { ...s.pendingSends, [draftKey]: env }
      : { ...s.pendingSends, [draftKey]: { ...cur, queued: [...(cur.queued ?? []), env] } };
    return { ...s, outboundLedger: nextLedger, pendingSends };
  });
  persistSnapshot();
}

/** 重载收口（initDraftPersistence 调用）：账本条目全部转 pendingSends（recovered 标记——
 * 结果未知的在途发送，人工同号确认，不自动发送）。 */
function recoverLedgerToPending(): void {
  const ledgerNow = getState().outboundLedger;
  const keys = Object.keys(ledgerNow);
  if (keys.length === 0) return;
  for (const k of keys) {
    for (const entry of ledgerNow[k] ?? []) confirmOutboundUnknown(k, { ...entry, recovered: true });
  }
}

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
