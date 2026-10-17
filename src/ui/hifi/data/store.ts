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
import type { AppState, ContextTarget, Thread, ThreadCard, RouteMode } from './types';
import type {ThreadMembersSnapshot} from '../../../contracts/threadMembers';
import type {ThreadVisibleProgress} from '../../../contracts/runtimeProgress';
import { openTab } from '../lib/resource';
import { configureReadingPositions, readingPosition, saveReadingPosition } from './readingPositions';

/** 任务详情（第五十一轮 H2）：task.get 的真实 DTO——pendingDelivery 只有 id/revision/manifest_hash
 * 三重身份，不猜其余字段；lastStartupFailureMessage 缺省为 null（服务端没有就不显示）。 */
export interface ThreadTaskDetail {
  responseKind?:'conversation'|'work'|null;
  id: string;
  title: string;
  status: string;
  roomId: string;
  threadId: string | null;
  roomTaskNumber: number;
  revision: number;
  stopGeneration: number;
  objective?: string | null;
  reviewPolicy?: 'auto_deliver' | 'user_review';
  mode?: RouteMode;
  ownerMemberId?: string | null;
  parentTaskId?: string | null;
  currentDeliveryId?: string | null;
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
  threadMemberships: Record<string, ThreadMembersSnapshot>;
  threadProgress:Record<string,{items:ThreadVisibleProgress[];readAt:number}>;
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
   * R75：在途用户打开的**落位目标**（提交时置、收尾清）。
   * 打开窗口内（提交→装载刷新→persistNav）URL 仍是打开前的旧路由：
   * 当目标≠旧路由 pid 且 URL 代次自打开发起未再前进时，旧路由（房间/项目主页对齐）
   * 让位——不再由它们把焦点抢回扚项目（review-r74 §P1：从房间打开弹窗选 B 被旧 A 路由抢回）。
   * 弹窗完成后按本目标 id（而非异步结束时的 activeProjectId）落位导航。
   */
  openInFlightTarget?: { projectId: string; urlSeqAtStart: number } | null;
  /**
   * daemon 实时连接态（r55：标题栏接真实断连/重连——首启 ready 不能永久等同在线）。
   * main 进程在管道关闭时发 zs:disconnect、重连成功后发 zs:reconnected；浏览器宿主
   * （探针/无 preload）收不到事件，保持 'online' 缺省并按 boot 呈现。connInfo 为断线
   * 时 main 给出的说明（原样透传，不虚构）。
   */
  conn: 'online' | 'offline' | 'recovering' | 'failed' | 'suspended';
  connInfo: string | null;
  /** r61 G6：本用户 message 类收藏事实（saved_refs 投影）——消息行书签按钮的已收藏状态
   * 与收藏页取消后的行内同步共用这一份；项目打开时刷新，切换成功即更新。 */
  savedMessageRefs: Record<string, boolean>;
  /** r61 G7：待插入草稿的正文文本（摘录等）——目标 Composer 未挂载时排队，挂载即消费。 */
  draftInserts: Record<string, Array<{ id: number; text: string }>>;
  /** r62 P1 出站账本：交给 bridge **之前**耐久落盘的完整发送意图（stage=sending）——按
   * ok/failed/unknown 收口；重载时全部转 pendingSends（recovered，人工同号确认）。 */
  outboundLedger: Record<string, OutboundLedgerEntry[]>;
  /** r63：成员 runtime 绑定投影（runtime.status memberBindings——kind=null 未绑定；
   * 'unknown'=读取失败不冒充）。发送区未绑定提示与成员页共用。 */
  memberRuntimes: Record<string, { kind: string | null; model: string | null; status: 'bound' | 'unbound' | 'unknown' }>;
  /** r63：本环境派发防护自述（runtime.status dispatchGuard——日常包 fakeAllowed=false）。 */
  dispatchGuard: { fakeAllowed: boolean; realDispatchGuard: boolean } | null;
  /**
   * r61 P5 草稿/未知信封持久化状态：mode=on（identity 就绪、localStorage 可写）时每次草稿/
   * 信封/上传项变更即快照落盘；error 非空=最近一次持久化失败（内存仍生效，UI 如实提示
   * 「未持久化——刷新/崩溃会丢」，不静默）。mode=off=身份不可用（浏览器宿主/服务未就绪）
   * ——退回内存态，如实标注。
   */
  draftPersist: { mode: 'on' | 'off' | 'locked'; error: string | null; /** r62 P2：快照恢复说明（版本/损坏隔离、TTL 过期计数）——与写入失败 error 分列。 */ recoveryNote: string | null;
    /** R68 §2：旧命名空间导入候选（未自动继承的旧 v1 键——真实 v3/v4 目录无标记，需用户显式确认）。
     * 状态可见 + 可重试（重扫）；空=null（无候选或已全部处理）。 */
    legacyImport: { candidates: Array<{ key: string; dir: string; hasStateDb: boolean | null; importedAt?: number | null }>; lastScanAt: number | null; error: string | null } | null };
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
    roomPool: {}, dmHistory: {}, threadEntities: {}, threadAnchors: {}, threadMessages: {}, threadTasks: {}, threadMemberships: {}, threadProgress:{}, threadReadSeq: {}, uploadItems: {}, previewPane: null,
    readErrors: {}, pendingSends: {}, readGate: null, threadReadGate: null,
    legacyActive: false, legacyReason: null,
    boot: 'pending', bootError: null, openInFlight: false, openInFlightTarget: null,
    conn: 'online', connInfo: null,
    savedMessageRefs: {},
    draftInserts: {},
    outboundLedger: {},
    memberRuntimes: {},
    dispatchGuard: null,
    draftPersist: { mode: 'off', error: null, recoveryNote: null, legacyImport: null },
  };
}

let state: HifiState = makeEmptyState();
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
export function getState(): HifiState { return state; }
export function setState(updater: (prev: HifiState) => HifiState) {
  const old=state;state = updater(state);
  if(state.preview!==old.preview){
    const recent=state.preview.tabs.slice(-12);const active=state.preview.tabs.find(t=>t.key===state.preview.activeKey);if(active&&!recent.some(t=>t.key===active.key)){recent.shift();recent.unshift(active);}
    const preview={...state.preview,tabs:recent.map(t=>({...t,openedFrom:{target:t.openedFrom.target,...(t.openedFrom.messageId?{messageId:t.openedFrom.messageId}:{})}})),maximized:false};
    const ids=new Set(preview.tabs.map(t=>t.resourceId));
    const resources=state.resources.filter(r=>ids.has(r.id)&&(r.formalAttachment||r.formalDelivery||r.formalWorktree)).map(r=>({...r,revisions:r.revisions.filter(v=>preview.tabs.some(t=>t.resourceId===r.id&&t.revision===v.revision)).map(v=>({...v,content:{kind:'unsupported',reason:'not_connected',note:'恢复阅读位置，需重新读取原件'}}))}));
    saveReadingPosition('preview',{preview,resources});
  }
  emit();
}
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
export interface HifiDraft { collaboration?: 'deliberate'; body: string; mentions: string[]; attachments: HifiDraftAttachment[]; access: string; sendAs: 'ai' | 'record'; rev?: number; /** r62：普通草稿 24h 过期的时间戳（批准 brief §3.3）；未确认发送账本不适用。 */ updatedAt?: number }

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
  /** R69 P1-D：已保存但提取不可用（Office 软解析失败——分列状态，非上传失败）。 */
  warning?: string;
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

/**
 * 从当前 hash 路由推导上下文（R69 P1-A：store 层统一打开入口需要——此前在 PreviewPane
 * 组件内，首开转换依赖组件挂载形成死锁）。规则与 PreviewPane 旧实现逐条一致。
 */
export function contextTargetFromRoute(projectId: string): ContextTarget {
  const hash = (location.hash ?? '').replace(/^#/, '');
  const path = hash.split('?')[0] ?? '';
  const oldThread = /^\/thread\/([^/?]+)/.exec(path);
  if (oldThread != null) {
    const ent = getState().threadEntities[oldThread[1]!];
    if (ent != null) return { kind: 'thread', projectId: ent.projectId, roomId: ent.roomId, threadId: ent.id, tab: 'replies' };
  }
  const oldRoom = /^\/room\/([^/?]+)/.exec(path);
  if (oldRoom != null) return { kind: 'room', projectId, roomId: oldRoom[1]!, view: 'chat' };
  const th = /^\/project\/([^/]+)\/room\/([^/]+)$/.exec(path);
  if (th != null) {
    const q = new URLSearchParams(hash.split('?')[1] ?? '');
    const tid = q.get('thread');
    return tid != null
      ? { kind: 'thread', projectId, roomId: th[2]!, threadId: tid, tab: 'replies' }
      : { kind: 'room', projectId, roomId: th[2]!, view: 'chat' };
  }
  if (/^\/project\/([^/]+)\/files/.test(path)) return { kind: 'files', projectId, view: 'files' };
  const dm = /^\/dm\/([^/?]+)/.exec(path);
  if (dm != null) return { kind: 'dm', projectId, conversationId: dm[1]! };
  if (path.startsWith('/dm')) {
    const st = getState();
    const cur = st.dms.find((d) => d.id === st.ui.activeThreadId) ?? st.dms[0];
    if (cur != null) return { kind: 'dm', projectId, conversationId: cur.id };
  }
  return { kind: 'room', projectId, roomId: getState().ui.activeRoomId, view: 'chat' };
}

/**
 * 登记一个**会话附件/成果**资源（R69 P1-A：从 actions-preview 移入 store 层——统一打开
 * 入口 store.openPreview 需要在调度层同步完成登记+开标签，不再依赖组件内 effect 桥接）。
 * 语义与原实现逐条一致（audience 按来源会话推导；内容不内联——预览面板按需装载）。
 */
export function registerAttachmentResource(input: {
  attachmentId: string;
  filename: string;
  kind: string;
  revision?: number;
  hash?: string;
  sizeBytes?: number;
  audience: ContextTarget;
  origin?: string;
}): void {
  const t = input.audience;
  const audience: import('./types').PreviewResource['audience'] = t.kind === 'dm'
    ? { kind: 'dm', conversationId: t.conversationId, memberIds: [] }
    : t.kind === 'room' || t.kind === 'thread'
      ? { kind: 'room', roomId: t.roomId }
      : { kind: 'project' };
  const origin: import('./types').PreviewResource['origin'] = t.kind === 'dm'
    ? { kind: 'dm', conversationId: t.conversationId }
    : t.kind === 'thread'
      ? { kind: 'message', messageId: t.threadId, roomId: t.roomId, threadId: t.threadId }
      : t.kind === 'room'
        ? { kind: 'message', messageId: t.roomId, roomId: t.roomId }
        : { kind: 'workspace' };
  setState((prev) => {
    if (prev.resources.some((r) => r.id === input.attachmentId)) return prev;
    const res: import('./types').PreviewResource = {
      id: input.attachmentId,
      projectId: t.projectId,
      kind: 'attachment',
      title: input.filename,
      mimeType: input.kind,
      origin,
      audience,
      revisions: [{
        revision: input.revision ?? 1,
        hash: input.hash ?? '(读取时核验)',
        sizeBytes: input.sizeBytes ?? 0,
        createdAt: Date.now(),
        content: { kind: 'unsupported', reason: 'not_connected', note: '内容由共享预览按需装载' },
      }],
      createdAt: Date.now(),
      formalAttachment: { attachmentId: input.attachmentId, kind: input.kind, conversationId: input.origin ?? '' },
    };
    return { ...prev, resources: [...prev.resources, res] };
  });
}

/**
 * 打开一个附件预览（R69 P1-A 统一入口）：**同步**完成 资源登记→标签会话开启——
 * 不再把单目标态丢给组件内 effect（旧链：RoomPage 只在 preview.tabs 非空才挂 PreviewPane，
 * 而首标签转换 effect 又只在 PreviewPane 内跑 → 首开死锁；草稿 TXT/PNG 点击无面板）。
 * 返回是否成功（失败已 toast：资源不存在/版本不可用）。
 */
export function openPreview(target: PreviewTarget): boolean {
  const ctx = contextTargetFromRoute(getState().activeProjectId);
  registerAttachmentResource({
    attachmentId: target.attachmentId,
    filename: target.filename,
    kind: target.kind,
    hash: target.hashHint,
    revision: typeof target.revisionHint === 'number' ? target.revisionHint : undefined,
    audience: ctx,
    origin: target.conversationId ?? '',
  });
  const s = getState();
  const res = s.resources.find((r) => r.id === target.attachmentId);
  if (res == null) {
    toast('这份资源不存在或已被移除', 'error');
    return false;
  }
  const rev = typeof target.revisionHint === 'number' ? target.revisionHint
    : res.revisions[res.revisions.length - 1]?.revision;
  if (rev === undefined) {
    toast('该版本不可用，未回退到其他版本', 'error');
    return false;
  }
  const ordinal = s.preview.tabs.reduce((max, t) => Math.max(max, t.ordinal), -1) + 1;
  setState((prev) => {
    const { tabs, activeKey } = openTab(prev.preview.tabs, res, rev, { target: ctx }, ordinal);
    return {
      ...prev,
      preview: {
        ...prev.preview,
        tabs,
        activeKey,
        hidden: false,
        // R73-A：对话上下文里打开=用户明确要看见（永不自动收起）；文件页打开=重新武装
        // 自动收起（下一次进入对话上下文时收起，不占房间）。
        explicitShow: ctx.kind !== 'files',
        returnSnapshot: prev.preview.returnSnapshot ?? { target: ctx, sizes: { ...prev.layout.sizes } },
        contextChangedSinceOpen: false,
        side: ctx.kind === 'thread' ? 'thread' as const : 'pool' as const,
      },
    };
  });
  recordWrite('preview.open', `resource=${target.attachmentId} revision=${rev} from=${ctx.kind}（store 统一入口，只读不发送）`);
  return true;
}

/** 兼容保留：单目标态已由标签会话直接接管（R69 P1-A）；不再设置。 */
export function closePreview(): void {
  setState((s) => (s.previewPane == null ? s : { ...s, previewPane: null }));
}

/** 上传项操作（store 层——回执按 draftKey+uploadId 精确收敛，绝不按文件名匹配）。 */
export function addUploadItem(item: UploadItem): void {
  setState((s) => ({ ...s, uploadItems: { ...s.uploadItems, [item.draftKey]: [...(s.uploadItems[item.draftKey] ?? []), item] } }));
  persistSnapshot();
}
export function settleUpload(draftKey: string, uploadId: string, patch: Partial<Pick<UploadItem, 'status' | 'attachmentId' | 'hash' | 'revision' | 'kind' | 'error' | 'warning'>>): void {
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
  params: { target: Record<string, unknown>; body: string; intent: 'default' | 'record_only'; mentions: Array<{ kind: string; memberId?: string }>; attachmentRefs?: string[];threadMemberVersion?:string;collaboration?:'deliberate' };
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
let persistNs: string | null = null;
/** R67：当前逻辑根 id（v2 命名空间时随快照落盘——跨目录继承可离线自证，不依赖旧路径存在）。 */
let persistRootId: string | null = null;
/**
 * r63 P2（review-r62 §3 反例）：快照不可恢复且**隔离写失败**（典型=配额将满：新增大键失败、
 * 覆盖已有键可成）时，原实现仍无条件 persistSnapshot——唯一原件被空快照覆盖、未确认信封
 * 销毁，提示却称「主键保留原样」。锁定后：主键永不覆盖（原件逐字保全）、所有草稿/账本
 * 编辑仅内存态、stageOutbound 拒绝发送（不冒充已耐久落账）；释放存储后重启或显式重试
 * （retryDraftPersistence）→ 隔离成功才解除并允许建立新快照。
 */
let persistLocked = false;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 草稿条目字段校验（r62 P2）：结构不符=损坏（不恢复该条；原件进隔离）。 */
function validateDraft(d: unknown): d is HifiDraft {
  if (!isPlainObject(d)) return false;
  if (typeof d.body !== 'string' || !Array.isArray(d.mentions) || d.mentions.some((m) => typeof m !== 'string')) return false;
  if (!Array.isArray(d.attachments) || d.attachments.some((a) => !isPlainObject(a) || typeof a.attachmentId !== 'string' || typeof a.name !== 'string')) return false;
  if (typeof d.access !== 'string' || (d.sendAs !== 'ai' && d.sendAs !== 'record')) return false;
  if (d.collaboration != null && d.collaboration !== 'deliberate') return false;
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
  if (persistLocked) return; // 主键保全锁定：原件未隔离前禁止覆盖唯一原键（r63 P2）
  try {
    const uploadsOut: Record<string, UploadItem[]> = {};
    for (const [k, list] of Object.entries(state.uploadItems)) {
      const kept = list.filter((x) => x.removed !== true && x.status !== 'uploading');
      if (kept.length > 0) uploadsOut[k] = kept;
    }
    const draftsOut: Record<string, HifiDraft> = {};
    const now = Date.now();
    for (const [k, v] of drafts) draftsOut[k] = v.updatedAt != null ? v : { ...v, updatedAt: now };
    const payload = JSON.stringify({ v: PERSIST_VERSION, savedAt: now, ...(persistRootId != null ? { dataRootId: persistRootId } : {}), drafts: draftsOut, pendingSends: state.pendingSends, uploadItems: uploadsOut, outboundLedger: state.outboundLedger });
    localStorage.setItem(persistKey, payload);
    if (state.draftPersist.error != null || state.draftPersist.mode === 'off') setState((s) => ({ ...s, draftPersist: { mode: 'on', error: null, recoveryNote: s.draftPersist.recoveryNote, legacyImport: s.draftPersist.legacyImport } }));
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
export function initDraftPersistence(ns: string, rootId?: string | null): boolean {
  configureReadingPositions(ns);
  // R81: deep-link panels may mount before the authoritative root identity is ready.
  if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function')window.dispatchEvent(new Event('zs-member-writes'));
  const saved=readingPosition<{preview:HifiState['preview'];resources:HifiState['resources']}>('preview');
  if(state.preview.tabs.length===0&&saved?.preview&&Array.isArray(saved.preview.tabs)&&saved.preview.tabs.length<=12&&Array.isArray(saved.resources)){
    const resources=saved.resources.filter(r=>r&&typeof r.id==='string'&&typeof r.projectId==='string'&&typeof r.title==='string'&&r.origin&&r.audience&&Array.isArray(r.revisions)&&r.revisions.every(v=>typeof v.revision==='number'&&v.content?.kind==='unsupported')&&(r.formalAttachment||r.formalDelivery||r.formalWorktree));
    const tabs=saved.preview.tabs.filter(t=>t&&typeof t.key==='string'&&t.openedFrom?.target&&resources.some(r=>r.id===t.resourceId&&r.revisions.some(v=>v.revision===t.revision)));
    state={...state,resources:[...state.resources,...resources.filter(r=>!state.resources.some(old=>old.id===r.id))],preview:{...state.preview,...saved.preview,tabs,maximized:false}};
  }
  persistNs = ns;
  persistRootId = rootId ?? null;
  persistLocked = false; // 每次初始化重判（重启/显式重试=隔离重试路径）
  persistKey = `zs.hifi.persist.${ns}`;
  let raw: string | null;
  let hadKey = false;
  try {
    raw = localStorage.getItem(persistKey);
    hadKey = raw != null;
  } catch (e) {
    persistKey = null;
    setState((s) => ({ ...s, draftPersist: { mode: 'off', error: `草稿持久化不可读：${e instanceof Error ? e.message : String(e)}——草稿仅本次进程内有效`, recoveryNote: null, legacyImport: s.draftPersist.legacyImport } }));
    return false;
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
      if (!quarantined) {
        // r63 P2：原件未成功保全→锁定主键（禁止任何后续写路径覆盖唯一原键），所有编辑仅
        // 内存态；发送（stageOutbound）拒绝——不冒充已耐久落账。释放存储后重启/显式重试。
        persistLocked = true;
        recoveryNote = `草稿快照无法恢复且隔离写入失败（存储空间/配额不足？）——**主键原件已保全锁定**（逐字保持，含未确认发送账本，不覆盖）；本轮草稿与发送账本仅内存态，发送将被要求先恢复存储；释放空间后重启应用或到「设置 → 草稿存储」点重试`;
        setState((s) => ({ ...s, draftPersist: { ...s.draftPersist, mode: 'locked', error: `草稿快照保全锁定：原件未隔离成功，主键保持原样（未覆盖）；新写入仅内存态`, recoveryNote: null } }));
        return hadKey; // 不 persistSnapshot——覆盖即销毁原件（review-r62 §3 反例）
      }
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
  setState((s) => (s.draftPersist.error == null ? { ...s, draftPersist: { ...s.draftPersist, mode: 'on', error: null, recoveryNote } } : { ...s, draftPersist: { ...s.draftPersist, recoveryNote } }));
  return hadKey;
}

/**
 * R67 P1-B → R68 §2/§3A：**可信继承合并**——把已验证同属当前逻辑数据根的旧命名空间快照合并
 * 进当前状态并立即落盘。所有继承入口（loader 自动继承 / 设置页用户确认导入）统一走本函数，
 * 版本与保全规则与直接初始化路径**同判**：
 *  - **版本门（R68 §3A）**：`data.v !== PERSIST_VERSION` 的来源**整体拒收**（未来版本不恢复、
 *    不重发其未知信封；原件在旧键里逐字保持——本函数从不写旧键）。不支持版本计入
 *    refusedVersions 并在说明中列出，不冒充已消费。
 *  - pendingSends：**按 commandId 并集**（R68 §2——同目标多个不同命令的未知信封全部保留，
 *    进 queued 队列；同 commandId 保留较新；无 TTL、不自动发送、不换号）。
 *  - outboundLedger：按 commandId 并集去重（同号保留现存的；继承件 stage 重置 sending 走
 *    既有 recoverLedgerToPending 收口）；
 *  - drafts/uploadItems：按目标键保留 updatedAt 较新者；普通草稿沿用 24h TTL（过期不继承）。
 * 损坏条目沿用 validateDraft/validateEnvelope 校验（不恢复、不派发），并在 recoveryNote 中
 * 如实分列；旧键原件不动（本函数只读入，不写旧键）。
 */
export interface InheritOutcome {
  mergedDrafts: number;
  mergedSends: number;
  mergedLedger: number;
  dropped: number;
  expired: number;
  refusedVersions: Array<{ sourceDir: string; v: string }>;
}
export function mergeInheritedSnapshots(sources: Array<{ raw: string; sourceDir: string }>, note: string): InheritOutcome {
  const out: InheritOutcome = { mergedDrafts: 0, mergedSends: 0, mergedLedger: 0, dropped: 0, expired: 0, refusedVersions: [] };
  if (persistKey == null) return out;
  for (const src of sources) {
    if (src.raw.length === 0) continue;
    let data: unknown = null;
    try { data = JSON.parse(src.raw); } catch { out.dropped += 1; continue; }
    if (!isPlainObject(data)) { out.dropped += 1; continue; }
    // 版本门：与 initDraftPersistence 同判（v2 是命名空间编号，快照格式版本仍是 PERSIST_VERSION=1）。
    if (data.v !== PERSIST_VERSION) {
      out.refusedVersions.push({ sourceDir: src.sourceDir, v: String((data as { v?: unknown }).v ?? '?') });
      continue;
    }
    const snapAt = typeof data.savedAt === 'number' ? data.savedAt : 0;
    const now = Date.now();
    // 草稿：按键保留较新（同键现存在且更新则不动）。
    for (const [k, d] of Object.entries((data.drafts ?? {}) as Record<string, unknown>)) {
      if (!validateDraft(d)) { out.dropped += 1; continue; }
      const age = now - (d.updatedAt ?? snapAt);
      if (age > DRAFT_TTL_MS) { out.expired += 1; continue; }
      const cur = drafts.get(k);
      if (cur != null && (cur.updatedAt ?? 0) >= (d.updatedAt ?? snapAt)) continue;
      drafts.set(k, d.updatedAt != null ? d : { ...d, updatedAt: snapAt });
      if (typeof d.rev === 'number' && d.rev > draftRev) draftRev = d.rev;
      out.mergedDrafts += 1;
    }
    // 未确认信封：**commandId 并集**——同号保留较新；不同号进 queued（同目标多命令全部保留）。
    for (const [k, e] of Object.entries((data.pendingSends ?? {}) as Record<string, unknown>)) {
      if (!validateEnvelope(e)) { out.dropped += 1; continue; }
      const cur = state.pendingSends[k];
      if (cur == null) { state.pendingSends[k] = e; out.mergedSends += 1; continue; }
      if (cur.commandId === e.commandId) {
        if ((cur.at ?? 0) >= (e.at ?? 0)) continue;
        const queued = (cur.queued ?? []).filter((q) => q.commandId !== e.commandId);
        state.pendingSends[k] = { ...e, queued: [...queued, ...(e.queued ?? [])] };
        out.mergedSends += 1;
        continue;
      }
      // 不同命令：并入 queued（按 commandId 去重——与 parkUnknownEnvelope 同构，全部可同号重试）。
      const queued = cur.queued ?? [];
      if (queued.some((q) => q.commandId === e.commandId)) continue;
      const inheritedQueued = e.queued ?? [];
      const merged = [...queued, e];
      for (const q of inheritedQueued) if (!merged.some((m) => m.commandId === q.commandId)) merged.push(q);
      state.pendingSends[k] = { ...cur, queued: merged };
      out.mergedSends += 1;
    }
    // 出站账本：commandId 并集（同号保留现存；继承件并入后统一经 recover 收口）。
    for (const [k, list] of Object.entries((data.outboundLedger ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(list)) { out.dropped += 1; continue; }
      const existing = state.outboundLedger[k] ?? [];
      const ids = new Set(existing.map((x) => x.commandId));
      for (const x of list) {
        if (!validateEnvelope(x) || ids.has(x.commandId)) continue;
        existing.push({ ...x, stage: 'sending' as const });
        ids.add(x.commandId);
        out.mergedLedger += 1;
      }
      state.outboundLedger[k] = existing;
    }
    // 上传项：仅当对应草稿被继承时并入（ready 项）。
    for (const [k, list] of Object.entries((data.uploadItems ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      if (!drafts.has(k)) continue;
      const kept = list.filter((u): u is UploadItem => validateUploadItem(u) && u.status !== 'uploading');
      if (kept.length === 0) continue;
      const cur = state.uploadItems[k] ?? [];
      const ids = new Set(cur.map((u) => u.uploadId));
      for (const u of kept) if (!ids.has(u.uploadId)) cur.push(u);
      state.uploadItems[k] = cur;
    }
  }
  persistSnapshot();
  recoverLedgerToPending();
  const refused = out.refusedVersions.length > 0 ? `、拒收不支持版本来源 ${out.refusedVersions.length} 个（${out.refusedVersions.map((r) => `${r.sourceDir} v${r.v} 不受本程序支持——原件在旧键逐字保持，未消费未派发`).join('；')}）` : '';
  const detail = `继承完成：草稿 ${out.mergedDrafts} 条、未确认信封 ${out.mergedSends} 条、账本 ${out.mergedLedger} 条${out.expired > 0 ? `、过期草稿 ${out.expired} 条（按 24h 约定不继承）` : ''}${out.dropped > 0 ? `、损坏条目 ${out.dropped} 条（不恢复不派发）` : ''}${refused}。${note}`;
  setState((s) => ({ ...s, draftPersist: { ...s.draftPersist, mode: 'on', recoveryNote: detail } }));
  return out;
}

/** R68 §2：用户显式确认导入单个旧键（设置 → 草稿存储）。版本门/保全规则与自动继承同判；
 * 导入后候选标记 importedAt 并**写回继承标记**（重载后仍是「已导入」——不因重启复活），
 * 旧键原样保留。 */
export function importLegacySnapshot(key: string, dir: string): { ok: boolean; error?: string; outcome?: InheritOutcome } {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch (e) { return { ok: false, error: `旧键读取失败：${e instanceof Error ? e.message : String(e)}` }; }
  if (raw == null) return { ok: false, error: '旧键不存在（可能已被清除）' };
  const outcome = mergeInheritedSnapshots([{ raw, sourceDir: dir }], `用户确认导入旧目录 ${dir} 的键 ${key}（原件保留）`);
  const importedAt = Date.now();
  setState((s) => ({
    ...s,
    draftPersist: {
      ...s.draftPersist,
      legacyImport: s.draftPersist.legacyImport == null ? null : {
        ...s.draftPersist.legacyImport,
        candidates: s.draftPersist.legacyImport.candidates.map((c) => (c.key === key ? { ...c, importedAt } : c)),
      },
    },
  }));
  if (persistNs != null) {
    const m = readInheritMarker(persistNs) ?? { state: 'done' as const, at: importedAt };
    m.candidates = (m.candidates ?? []).map((c) => (c.key === key ? { ...c, importedAt } : c));
    if (!(m.candidates ?? []).some((c) => c.key === key)) m.candidates.push({ key, dir, hasStateDb: null, importedAt });
    writeInheritMarker(persistNs, m);
  }
  return { ok: true, outcome };
}

/** R68 §2：登记/更新未自动继承的旧键候选（loader 扫描结果）。hasStateDb=null 表示未探测。 */
export function setLegacyImportCandidates(candidates: Array<{ key: string; dir: string; hasStateDb: boolean | null; importedAt?: number | null }>, scanError: string | null = null): void {
  setState((s) => ({ ...s, draftPersist: { ...s.draftPersist, legacyImport: { candidates, lastScanAt: Date.now(), error: scanError } } }));
}

/* ---------- R68 §2：继承标记（与 v2 键存在解耦；同时是导入候选队列的**持久层**——
 * 重载/重开后「设置 → 数据与存储」的候选列表由此恢复，不因进程重启丢失后永久跳过） ---------- */

interface InheritMarker { state: 'done' | 'pending'; at: number; auto?: number; candidates?: Array<{ key: string; dir: string; hasStateDb: boolean | null; importedAt?: number | null }> }
function inheritMarkerKeyOf(ns: string): string { return `zs.hifi.inherit.${ns}`; }
export function readInheritMarker(ns: string): InheritMarker | null {
  try {
    const raw = localStorage.getItem(inheritMarkerKeyOf(ns));
    if (raw == null) return null;
    const m = JSON.parse(raw) as InheritMarker;
    if (m == null || typeof m !== 'object') return null;
    return m;
  } catch { return null; }
}
export function writeInheritMarker(ns: string, m: InheritMarker): void {
  try { localStorage.setItem(inheritMarkerKeyOf(ns), JSON.stringify(m)); } catch { /* 标记写失败：下次启动重扫（旧键原样保留，安全） */ }
}

/** 显式重试（r63 P2 恢复路径）：重新初始化=重读主键→再试隔离。隔离成功（存储已释放）→
 * 解除锁定、原件入隔离键、从恢复出的有效部分建立新快照；仍失败→继续锁定。设置页按钮用。 */
export function retryDraftPersistence(): void {
  if (persistNs == null) return;
  initDraftPersistence(persistNs);
}

/** R68：清理**当前活动命名空间**的草稿快照键（设置页「清理本地草稿」）。R67 起 v2 逻辑身份
 * 键与旧绝对路径键并存——必须清活动键（store 记录的 persistKey），不能按绝对路径拼键
 * （旧拼法清的是已不使用的 v1 键，活动键原样保留=清理无效）。内存态照旧保留至页面关闭。 */
export function clearPersistedSnapshot(): { ok: boolean; hadKey: boolean; key: string | null; error?: string } {
  if (persistKey == null) return { ok: false, hadKey: false, key: null, error: '草稿持久化未初始化（身份未就绪/浏览器宿主）——没有活动键可清理' };
  let hadKey = false;
  try {
    hadKey = localStorage.getItem(persistKey) != null;
    if (hadKey) localStorage.removeItem(persistKey);
  } catch (e) {
    return { ok: false, hadKey, key: persistKey, error: `快照键清除失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, hadKey, key: persistKey };
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
  if (persistLocked || getState().draftPersist.mode === 'locked') {
    // r63 P2：主键保全锁定中——发送前无法耐久落账原信封，若继续发送则崩溃窗口的重复发送
    // 防护失效。拒绝发送并给出恢复路径（不冒充已保存）。
    return { ok: false, error: '草稿快照保全锁定中（原件未隔离成功，主键不可覆盖）——发送已取消；请先释放存储空间并到「设置 → 草稿存储」重试，恢复后再发送' };
  }
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

/* ---------- 导航偏好持久化（R64：原型 actions-nav 同名 API——正式侧复用） ---------- */
import { saveNavPrefs } from './navPrefs';

/**
 * 把当前导航偏好写回 localStorage（快速镜像）+ 服务端 navigation_preferences（跨机权威，
 * board.view scope=all 的可见集读本表——review-r64 §4A：不能只写本地叫正式 navigation 命令）。
 * 服务端写为 fire-and-forget（失败不阻塞导航；下次导航动作重写）。
 */
export function persistNav(s: HifiState, isCurrent: () => boolean = () => true): void {
  if (!isCurrent()) return;
  try {
    saveNavPrefs({
      version: 1,
      activeProjectId: s.activeProjectId,
      visibleProjectIds: s.visibleProjectIds,
      expandedProjectIds: s.expandedProjectIds,
      pinnedProjectIds: s.pinnedProjectIds,
      fileGitTabs: s.fileGitTabs,
    });
  } catch { /* localStorage 不可用：偏好仅内存态 */ }
  void (async () => {
    try {
      const { command } = await import('../bridge');
      if (!isCurrent()) return;
      await command('navigation.set', {
        clientId: 'desktop-hifi',
        activeProjectId: s.activeProjectId === '' ? null : s.activeProjectId,
        visibleProjectIds: s.visibleProjectIds,
        expandedProjectIds: s.expandedProjectIds,
        pinnedProjectIds: s.pinnedProjectIds,
        fileGitTabs: s.fileGitTabs,
      });
    } catch { /* 服务端偏好写入失败：本地已生效，下次导航动作重试 */ }
  })();
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
