/**
 * 输入条（§4.1 / §4.2 / E6 / E8 / E3）
 *
 * 关键口径：
 *  - 普通输入**默认交给 AI**（2026-09-25 起）：不再有常驻的「任务/讨论」二选一；
 *    "只想留字、不要回复"改成 ⋯ 菜单里的一次性意图「仅记录，不请求回复」，
 *    历史记录串里默认仍是保存记录（兼容例外，见 recordThread）
 *  - 协作模式由 @ 结构推导，不手选；发送前持续显示解析结果（§4.1、E6）
 *  - 方式芯片是上下文相关的一个开关，默认全关（E6 方案 A）
 *  - 意图标签显示实际能力，不画锁/盾；说明默认收起，点 ⓘ 才展开（E8、ADR-14）
 *  - E3：点到子任务卡后，输入条出现「→ 子任务 #n」目标标签
 *  - Enter 发送、Shift+Enter 换行、中文输入法组合态不发送（§17.4）
 *  - 发送中的 commandId 不变，重复点击不会创建多个任务（§17.4、RT-01）
 *  - 布局：工具条与状态行都是单行不折行；窄窗靠收窄间距与截断，而不是换行堆叠
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { Avatar, Menu, MenuItem, anchorFromElement, memberColor, Tag } from './ui';
import { useStore, getState, getDraftFull, setDraftFull, clearUnknownEnvelope, addUploadItem, settleUpload, settleUploadReady, removeUploadItem, hydrateUploadRefs, clearSettledUploads, openPreview, takeDraftInserts, settleOutbound } from '../data/store';
import type { PendingSendEnvelope, HifiDraft, HifiDraftAttachment, UploadItem } from '../data/store';
import { deriveRoute, memberLabel, roomOf } from '../data/selectors';
import { routeModeCopy } from '../lib/format';
import { command } from '../bridge';
import { uploadAttachmentFile, classifyAttachmentFile } from '../loader';
import type { ProjectMember, Room } from '../data/types';

/**
 * 意图标签的说明（E8 / ADR-14）。
 * 这里只讲实际能力，不给安全承诺——不画锁，也不写"受保护"。
 */
const INTENT_HINT =
  '当前为交互原型，尚未连接实际执行服务。正式运行时，各档位仅在对应成员的权限能力验证通过后开放；确认的范围取决于实际执行工具。';

/**
 * 权限模式（四档，下拉选择）。
 *
 * 首版可用性（2026-09-20，按修订后的 ADR-14 / §9.6 同步）
 *
 * 首版使用经验证的 runtime 原生限制，adapter 转发确认请求与答复。
 * RT-23/B6 通过前「变更前确认」禁选，原因是尚未验证，并非永久后置。
 * DEV-06/10/14 承担最小确认通道，DEV-20 仅承担完整加固。
 * 此处 available 表示原型可交互，不代表 runtime 能力已认证；正式接入时按
 * runtime/adapter 版本、平台和成员逐项开放，失败不得回退为完全访问。
 *
 * 四档与设计文档的对应关系（选项 → 实际运行参数 → 不支持时如何处理）：
 *
 * | 档位 | §15.2 intent | 正式运行目标 | 当前原型 |
 * |---|---|---|---|
 * | 计划模式 | analyze | 本次止于方案，验证原生写入限制 | 可模拟选择 |
 * | 变更前确认 | modify | 转发原生审批，明确实际确认粒度 | 禁用，待 RT-23/B6 |
 * | 自动编辑 | modify | 授权范围内编辑，额外请求仍走确认 | 可模拟选择 |
 * | 完全访问 | modify | 明确选择后使用可用的更宽策略 | 可模拟选择 |
 *
 * 关于"计划模式"的边界：它**只覆盖只分析那一半**。决策 03「先给方案再执行」
 * 里的"再执行"不靠 approval，而是你看完方案后用新的输入继续 —— 那是一次新的
 * 后续执行，须重新核对有效策略、预算和目录租约，不复用方案确认充当工具审批。
 */
export type AccessMode = 'plan' | 'confirm' | 'auto_edit' | 'full_access';

export const ACCESS_MODES: {
  value: AccessMode;
  label: string;
  desc: string;
  icon: string;
  /** 映射到 §15.2 intent 的权限意图 */
  intent: 'analyze' | 'modify';
  /** 原型是否允许选择；正式能力须另按 runtime 验证记录判断 */
  v01: { available: true } | { available: false; reason: string };
}[] = [
  {
    value: 'plan',
    label: '计划模式',
    desc: '本次只出方案或分析，不自动转入修改。',
    icon: 'sparkles',
    intent: 'analyze',
    v01: { available: true },
  },
  {
    value: 'confirm',
    label: '变更前确认',
    desc: '需要授权的操作由你确认后继续，范围以实际工具能力为准。',
    icon: 'hand',
    intent: 'modify',
    v01: {
      available: false,
      reason: '暂未开放：权限限制与确认通道尚未验证，验证通过后按成员开放。',
    },
  },
  {
    value: 'auto_edit',
    label: '自动编辑',
    desc: '在项目已授权的范围内直接改文件，并记录改动集。',
    icon: 'edit',
    intent: 'modify',
    v01: { available: true },
  },
  {
    value: 'full_access',
    label: '完全访问',
    desc: '允许更宽的访问范围，仍遵守系统限制。',
    icon: 'alert-circle',
    intent: 'modify',
    v01: { available: true },
  },
];

/**
 * 输入条要能一眼看出「我现在是在发起，还是在跟进」（两份评审都把它列为第一优先）。
 *
 * 语义分三种，控件也随之不同：
 *  1. room_root + task       → 发起新任务：显示模式推导、参与者、预算、权限
 *  2. thread + task          → 跟进已有任务：延续该任务，不重建工作流；显示"延续 <模式>"
 *  3. thread/room + 讨论     → 纯备注：不调用 AI，**不显示**权限、预算、模式与分工控件
 */

export interface ComposerTarget {
  kind: 'room_root' | 'thread' | 'dm';
  /** 房间/线程用真实 roomId；私信用 `dm:<conversationId>`（诊断与资源归属都需要稳定 id） */
  roomId: string;
  threadId?: string;
  /** kind === 'dm' 时的会话 id（成员边界取自该私信的 audience，§4.6） */
  dmId?: string;
  /** E3：定向跟进某子任务 */
  subtask?: { taskId: string; number: number; title: string };
  /** 线程内是否显示「另起任务」（§17.4 始终可见） */
  showNewTask?: boolean;
}

/** 每键发送锁（review-r48 §4）：多目标在途互不解除——A 回执的 finally 只清 A 的键。 */
const sendingKeys = new Set<string>();
const imageCheckingKeys = new Set<string>();
/** 附件上传项的稳定空集（selector 引用稳定——useSyncExternalStore 契约）。 */
const EMPTY_UPLOADS: UploadItem[] = [];

/**
 * 未知信封的**完整意图身份**比较（R66 P3）：文件-only 发送的 body 都为空——r62 的
 * 「正文逐字相等」判据会把两条不同文件的发送误判为同一草稿。身份=正文+意图+@提及+
 * 附件引用集合（排序后比较——同一身份换新号必重复；任一不同=新草稿，允许新号发送）。
 */
function pendingIdentityMatches(
  env: PendingSendEnvelope,
  text: string,
  mentionIds: string[],
  sendAs: 'ai' | 'record',
  readyAttachmentIds: string[],
  collaboration?:'deliberate',
): boolean {
  if(env.params.collaboration!==collaboration)return false;
  const p = env.params as {
    body?: string; intent?: string; mentions?: Array<{ kind: string; memberId?: string }>;
    attachmentRefs?: string[];
  };
  if ((p.body ?? '') !== text) return false;
  if ((p.intent === 'record_only' ? 'record' : 'ai') !== sendAs) return false;
  const envRefs = [...(p.attachmentRefs ?? [])].sort().join('|');
  const curRefs = [...readyAttachmentIds].sort().join('|');
  if (envRefs !== curRefs) return false;
  const envMentions = (p.mentions ?? []).map((m) => (m.kind === 'all' ? 'all' : m.memberId ?? '')).sort().join('|');
  const curMentions = [...mentionIds].sort().join('|');
  return envMentions === curMentions;
}

/** 未知信封摘要（文件-only：正文空→按附件数呈现，不显示空洞的「…」）。 */
function pendingEnvSummary(env: PendingSendEnvelope): string {
  const p = env.params as { body?: string; attachmentRefs?: string[] };
  const body = p.body ?? '';
  if (body.trim().length > 0) return body.slice(0, 60);
  const n = p.attachmentRefs?.length ?? 0;
  return n > 0 ? `仅文件发送（${n} 个附件）` : '（空内容）';
}

/** 正式侧发送回执（第四十七轮）：onSend 可返回 Promise——成功才清空，失败/未知保留草稿。 */
export type FormalSendOutcome =
  | { status: 'ok' }
  | { status: 'failed'; error: string }
  | { status: 'unknown'; error: string };

/** 正式侧能力锁定（第四十七轮）：未接通能力在点击前禁用并说明原因，不出现可选却被忽略。 */
export interface FormalLimits {
  attachments?: string;
  method?: string;
  access?: string;
}

export function Composer({
  target,
  draftKey,
  onSend,
  onClearSubtask,
  insertText,
  sendDisabledReason,
  sendDisabledLabel,
  inputDisabledReason,
  runBudget,
  stop,
  recordThread,
  showMentions = true,
  extraAction,
  formalLimits,
  onRetrySend,
  attachmentUpload,
}: {
  target: ComposerTarget;
  draftKey: string;
  onSend: (payload: {
    body: string;
    /** 本次发送意图：ai=交给 AI；record=仅记录、不请求回复（一次性） */
    sendAs: 'ai' | 'record';
    mentionIds: string[];
    method: { planFirst: boolean; skipFirstDraft: boolean; splitWork: boolean };
    access: AccessMode;
    attachments: HifiDraftAttachment[];
    /** 图片能力门显式选择（一次性）：'omit-images'=仅发送文字（图片不送模型并如实注明）。 */
    imageAck?: 'omit-images';
    collaboration?:'deliberate';
    commandId: string;
    target: ComposerTarget;
    /** 发起时草稿编辑代次（页面冻结进信封——清算判定用）。 */
    draftRev?: number;
  }) => void | Promise<FormalSendOutcome | void> | Promise<void>;
  onClearSubtask?: () => void;
  /** 从消息菜单插入引用或更正提示；只改变草稿，不直接派发任务。 */
  insertText?: { id: number; text: string };
  /** 允许保留草稿但暂时不能发送，例如房间还没有成员。 */
  sendDisabledReason?: string;
  /**
   * `sendDisabledReason` 上方那枚提示的文案（默认「只能存草稿」）。
   * 归档私信不能沿用这句：那里是"只读"，连草稿都发不出去，说成"只能存草稿"会误导。
   */
  sendDisabledLabel?: string;
  /**
   * 整个输入区不可写（私信归档态）：textarea 直接禁用、占位写明原因。
   *
   * 为什么不只用 `sendDisabledReason`：房间的"还没有成员"允许先写草稿，
   * 而归档是**只读**——房间里归档后整个输入条会被只读面板取代，
   * 私信保持同一口径（此前也是 disabled），不然"只读"会退化成"能写但发不出去"。
   */
  inputDisabledReason?: string;
  /**
   * 目标摘要（减负 §2.1/§6.2）—— **2026-09-24 第三轮已按用户要求停用**。
   *
   * 曾经作为"我在对哪个任务说话"的常驻一行；用户看过后要求整行去掉（房间名在正上方、
   * 线程身份在详情与 placeholder 里都有）。prop 与 `.composer-target-*` 样式保留但
   * **不再有任何调用方传入**，这样想恢复时只需重新传值，不必重写模板。
   */
  targetSummary?: {
    /** 主文案，例如「跟进 #12」或「发布到 开发大厅」 */
    label: string;
    /** 简短标题（可省略号截断，完整值放 title） */
    short?: string;
    /** 完整标题/摘要，用于 tooltip */
    full?: string;
    /** 点击摘要的去处（任务串 → 详情的任务概况） */
    onOpen?: () => void;
  };
  /**
   * 本次任务的运行预算（§6.1）：只用**既有** run.budget 数据做提示，
   * 不复制 6N+1/7N+2 公式，避免界面出现两套预算值。
   */
  runBudget?: { used: number; max: number };
  /**
   * 停止任务（减负 §2.3）。
   *
   * 停止以前只在「任务详情」里，现在补一个**详情之外可发现**的入口：
   * 位置在输入区操作区，复用既有 stopTask 与状态判定。
   * 是否出现不由输入框 disabled 推断，而由任务真实状态决定；
   * 关闭/返回永远不会触发它。
   */
  stop?: {
    onStop: () => void;
    /** 真实状态：已发出停止、等活跃 turn 结束时显示"停止中"并防重复点击 */
    stopping: boolean;
  };
  /**
   * 历史**记录串**（无任务的讨论串）：默认仍是"保存记录"。
   *
   * 这是兼容例外，不是常驻切换：2026-09-25 起普通输入默认交给 AI，
   * 但已经存在的"只留字"的长串不能因为删掉切换控件就被静默唤醒 ——
   * 在它们里面回复仍然只保存记录（用户可以显式改成本次交给 AI）。
   */
  recordThread?: boolean;
  /**
   * 是否显示 @ 提及（默认显示）。
   * 私信关掉：1 对 1 会话里只有一位成员，@ 没有可选项（成员边界仍由该会话决定）。
   */
  showMentions?: boolean;
  /**
   * 操作簇里的额外动作（私信归档态的「取消归档」）。
   * 放在输入区操作簇内，避免像以前那样在提示"取消归档后才能发送"却找不到入口。
   */
  extraAction?: ReactNode;
  /** 正式侧能力锁定：给出原因的控件在点击前禁用（视觉保持，行为如实）。 */
  formalLimits?: FormalLimits;
  /** 结果未知信封的重发通道（review-r47 §2）：严格重发冻结原信封——由页面接正式命令。 */
  onRetrySend?: (env: PendingSendEnvelope) => Promise<FormalSendOutcome | void>;
  /**
   * 正式附件上传通道（第五十一轮 H2）：页面提供 {conversationId} 时 📎 走真实文件选择
   * + attachment.upload*（回执绑定该会话）；未提供时维持 formalLimits 禁用——不 mock。
   */
  attachmentUpload?: { conversationId: string };
}) {
  /**
   * 成员边界（§4.6）：房间/线程取房间名单，私信取该会话的 audience 名单。
   * @ 候选、方式推导、冻结名单都以它为唯一来源。
   */
  const dm = useStore((s) => (target.kind === 'dm' && target.dmId ? s.dms.find((d) => d.id === target.dmId) : undefined));
  const room = useStore((s) => (target.kind === 'dm' ? undefined : roomOf(s, target.roomId)));
  const threadMembers=useStore(s=>target.kind==='thread'&&target.threadId?s.threadMemberships[target.threadId]:undefined);
  const memberIds = useMemo(
    () => (target.kind === 'dm' ? (dm?.memberIds ?? []) : target.kind==='thread'?(threadMembers?.eligibleMemberIds??[]):(room?.memberIds ?? [])),
    [target.kind, dm, room,threadMembers],
  );
  const allMembers = useStore((s) => s.members);
  const memberRuntimes = useStore((s) => s.memberRuntimes);
  const profiles = useStore((s) => s.profiles);
  const runtimes = useStore((s) => s.runtimeInstallations);

  const members = useMemo(
    () => (memberIds.map((id) => allMembers.find((m) => m.id === id)).filter(Boolean) as ProjectMember[]),
    [memberIds, allMembers],
  );

  /** 成员 → runtime 显示名（成员设置里可改；这里用于 @ 候选） */
  const runtimeLabelOf = useMemo(() => {
    const byId = new Map(runtimes.map((r) => [r.id, r.label]));
    const profById = new Map(profiles.map((p) => [p.id, p]));
    return (m: ProjectMember) => {
      const actual=memberRuntimes[m.id];
      if(actual?.status==='bound')return `${actual.kind} · ${actual.model??'渠道默认模型'}`;
      if(actual?.status==='unbound')return '全局默认渠道';
      const prof = profById.get(m.profileId);
      return prof ? byId.get(prof.runtimeInstallationId) ?? '未配置' : '未配置';
    };
  }, [runtimes, profiles,memberRuntimes]);

  const [body, setBody] = useState('');
  /**
   * 本次发送意图（一次性，2026-09-25 起）：默认 `'ai'`。
   *
   * 历史记录串（无任务的讨论串）是兼容例外：在它们里面默认仍是 `'record'`，
   * 否则删掉切换控件会把"只留字"的长串静默变成一次 AI 调用。
   */
  const [sendAs, setSendAs] = useState<'ai' | 'record'>(recordThread ? 'record' : 'ai');
  const [deliberate,setDeliberate]=useState(false);
  const collaboration=target.kind==='room_root'&&deliberate?'deliberate' as const:undefined;
  const [mentions, setMentions] = useState<string[]>([]);
  const [skipFirstDraft, setSkipFirstDraft] = useState(false);
  const [splitWork, setSplitWork] = useState(false);
  const [access, setAccess] = useState<AccessMode>('plan');
  const [accessOpen, setAccessOpen] = useState(false);
  // 附件真源=store.uploadItems（review-r51 §2 反例修复）：每笔上传绑定发起草稿键+独立
  // uploadId——迟到回执按 (draftKey, uploadId) 精确收敛；切走/卸载/同名文件/上传中移除都
  // 不串到其它草稿、不复活已移除项；A→B→A 回来芯片由 store 恢复。本地不再持有附件状态。
  const uploadItemsRaw = useStore((st) => st.uploadItems[draftKey] ?? EMPTY_UPLOADS);
  const attachments = useMemo(() => uploadItemsRaw.filter((x) => x.removed !== true), [uploadItemsRaw]);
  /** 就绪附件数（R66 P3 文件-only 发送判据：只有 ready 状态才是可发送附件——上传中/失败不算）。 */
  const readyAttachmentCount = useMemo(() => attachments.filter((x) => x.status === 'ready').length, [attachments]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 图片能力门待选（第五十二轮：显式二选一，不再硬拦——发送暂停在选择上）。 */
  const [imageGate, setImageGate] = useState<{ names: string[]; reason?: string } | null>(null);

  /**
   * 真实附件上传：先本地分类+前置限幅（文本 256KB/图片 8MB/PDF、Office 20MiB/CSV 5MB——
   * 服务端为最终裁决）；文本走 fatal UTF-8 解码（非法字节零上传）。成功回执经
   * settleUploadReady **原子结算**（r53 §3）：store 同时核 uploadId 存在/未移除/发起会话一致，
   * 通过才置 ready 并写草稿 ref——上传中被移除的回执整体丢弃，组件不再自行写草稿（那正是
   * 「芯片消失但草稿仍带已移除资源」的根因）。
   */
  const uploadPickedFiles = async (files: File[]): Promise<void> => {
    if (attachmentUpload == null) return;
    for (const f of files) {
      const cls = classifyAttachmentFile(f.name, f.size);
      const uploadId = `upl_${Math.random().toString(36).slice(2, 10)}`;
      if (cls.cls === 'unsupported') {
        addUploadItem({ uploadId, draftKey, conversationId: attachmentUpload.conversationId, name: f.name, size: f.size, status: 'failed', error: `${cls.reason ?? '不支持的附件类型'}（${f.name} · ${f.size}B）——可换支持类型重选` });
        continue;
      }
      addUploadItem({ uploadId, draftKey, conversationId: attachmentUpload.conversationId, name: f.name, size: f.size, status: 'uploading' });
      try {
        const r = await uploadAttachmentFile(attachmentUpload.conversationId, f);
        const accepted = settleUploadReady(draftKey, uploadId, attachmentUpload.conversationId, { name: f.name, size: f.size, attachmentId: r.attachmentId, hash: r.hash, revision: r.revision, kind: r.kind });
        void accepted; // 被丢弃=用户已在上传中移除——不写任何草稿 ref，芯片保持消失
        // R69 P1-D：已保存但提取不可用（分列状态）——芯片就地警示，不算上传失败。
        if (r.previewWarning != null) settleUpload(draftKey, uploadId, { warning: r.previewWarning });
        if (r.extractionFailed != null) settleUpload(draftKey, uploadId, { warning: r.extractionFailed });
      } catch (e) {
        // R69 P1-C：失败原因就地可见（文件/阶段/可行操作），不再只藏 title。
        settleUpload(draftKey, uploadId, { status: 'failed', error: `${f.name}（${f.size}B）：${(e as Error).message}` });
      }
    }
  };
  /** 移除上传项：在途→标记（回执到达即弃，不复活）；已就绪→连同草稿引用一并移除（不再随发送携带）。 */
  const removeAttachment = (uploadId: string): void => {
    const it = uploadItemsRaw.find((x) => x.uploadId === uploadId);
    removeUploadItem(draftKey, uploadId);
    if (it != null && it.attachmentId != null) {
      const d = getDraftFull(draftKey);
      setDraftFull(draftKey, { ...d, attachments: d.attachments.filter((a) => a.attachmentId !== it.attachmentId) });
    }
  };
  /** 行内发送错误（按发起目标键归属——迟到回执不污染当前目标，review-r47 §3）。 */
  const [sendErrorFor, setSendErrorState] = useState<{ key: string; text: string } | null>(null);
  const sendError = sendErrorFor != null && sendErrorFor.key === draftKey ? sendErrorFor.text : null;
  const setSendErrorFor = (key: string, text: string) => setSendErrorState({ key, text });
  /** 当前挂载目标键（结算时核对——迟到回执只在同键在挂时同步当前输入）。 */
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const imageProjectId = useStore((s) => s.activeProjectId);
  const [imageStatus, setImageStatus] = useState<{ key: string; text: string } | null>(null);
  const imageContext = JSON.stringify({ projectId: imageProjectId, target, conversationId: attachmentUpload?.conversationId,
    mentions, collaboration, images: attachments.filter(a => a.status === 'ready' && a.kind === 'image_file').map(a => a.attachmentId) });
  const threadFactRevision=useStore(s=>target.kind==='thread'&&target.threadId?s.threadTasks[target.threadId]?.revision:null);
  const writeContext=JSON.stringify({projectId:imageProjectId,target,conversationId:attachmentUpload?.conversationId,mentions,collaboration,threadFactRevision});
  const [writeHint,setWriteHint]=useState<{key:string;authorized:boolean;fullAccess?:boolean;willDispatch?:boolean;blocked?:boolean;reason:string;readAt:number;error?:string}|null>(null);
  useEffect(()=>{
    if(!formalLimits?.access||sendAs!=='ai')return;
    let cancelled=false,reading=false;
    const read=async()=>{
      if(cancelled||reading||document.visibilityState!=='visible')return;reading=true;
      const conversationId=attachmentUpload?.conversationId??target.dmId??'';
      const formalTarget=target.kind==='room_root'?{kind:target.kind,projectId:imageProjectId,conversationId,roomId:target.roomId}:target.kind==='thread'?{kind:target.kind,projectId:imageProjectId,conversationId,threadId:target.threadId}:{kind:target.kind,projectId:imageProjectId,conversationId};
      try{const c=await command<{modificationAuthorized:boolean;fullAccess?:boolean;willDispatch:boolean;blocked?:boolean;reason:string}>('message.writeCapability',{target:formalTarget,...(collaboration?{collaboration}:{}),mentions:mentions.map(id=>id==='all'?{kind:'all'}:{kind:'member',memberId:id})});if(!cancelled&&draftKeyRef.current===draftKey)setWriteHint({key:writeContext,authorized:c.modificationAuthorized,fullAccess:c.fullAccess,willDispatch:c.willDispatch,blocked:c.blocked,reason:c.reason,readAt:Date.now()});}
      catch(e){if(!cancelled)setWriteHint(old=>old?.key===writeContext?{...old,error:`权限读取失败：${(e as Error).message}；保留上次确认`}:{key:writeContext,authorized:false,reason:'尚未确认执行权限',readAt:0,error:(e as Error).message});}
      finally{reading=false;}
    };
    void read();const timer=window.setInterval(()=>void read(),5000),visible=()=>void read();document.addEventListener('visibilitychange',visible);
    return()=>{cancelled=true;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[writeContext,draftKey,sendAs,formalLimits?.access]);
  useEffect(() => {
    if (!attachments.some(a => a.status === 'ready' && a.kind === 'image_file')) return;
    let cancelled = false; let reading = false;
    const read = async () => {
      if (reading) return; reading = true;
      const conversationId = attachmentUpload?.conversationId ?? target.dmId ?? '';
      const formalTarget = target.kind === 'room_root' ? { kind: target.kind, projectId: imageProjectId, conversationId, roomId: target.roomId }
        : target.kind === 'thread' ? { kind: target.kind, projectId: imageProjectId, conversationId, threadId: target.threadId }
        : { kind: target.kind, projectId: imageProjectId, conversationId };
      try {
        const c = await command<{ willDispatch: boolean; members: Array<{kind:string;model:string;channel:string;configuration:string;protocol:string;status:string;reason:string}> }>('message.imageCapability', { target: formalTarget, ...(collaboration?{collaboration}:{}), mentions: mentions.map(id => id === 'all' ? {kind:'all'} : {kind:'member',memberId:id}) });
        if (!cancelled && draftKeyRef.current === draftKey) setImageStatus({key:imageContext,text:c.willDispatch ? c.members.length&&c.members.every(m=>m.status==='supported')?'图片会随消息发送给所选 AI。':'部分 AI 暂不能接收图片，可换成员或仅记录。' : '图片会保存到本机，可点击预览。'});
      } catch (e) { if (!cancelled) setImageStatus({key:imageContext,text:`图片能力读取失败：${(e as Error).message}；仍可本地预览或仅记录，发送前可重试`}); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
    // imageContext includes the complete read scope; avoid unstable parent target objects.
  }, [imageContext, draftKey]);
  /** 本目标的结果未知信封（store 持有——切走/卸载不丢）。 */
  const pendingEnv = useStore((st) => st.pendingSends[draftKey]);
  const [sending, setSending] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  useEffect(() => {
    if (!mentionOpen) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMentionTrigger(null);
      setMentionOpen(false);
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [mentionOpen]);
  /**
   * @ 触发位置（r55 T2 完整修复）：记录**本次打开候选框的那个 @ 的下标**。选中成员后只
   * 消费这一处触发字符——中文紧邻（「整理任务要点@」）、行首/空白、光标处触发全部覆盖；
   * 不再对正文做全局正则替换（旧实现只匹配行首/空白后的末尾 @，中文紧邻反例即由此残留）。
   * 工具栏 @ 按钮打开=无触发字符（null，选人不动正文）；取消/切草稿/草稿被引用插入等
   * 外部变更都会清掉——正文里其它合法 @/邮箱文本永不被触碰。draftKey 一起记录：迟到
   * 的选择不跨草稿消费。
   */
  const [mentionTrigger, setMentionTrigger] = useState<{ index: number; draftKey: string } | null>(null);
  /** 「本次运行设置」弹层（低频选项的收纳处，§6） */
  const [runSettingsAnchor, setRunSettingsAnchor] = useState<{ x: number; y: number } | null>(null);
  /**
   * 草稿保存失败必须可见（§6.2；r61 P5 改接持久化状态位）。
   * 普通保存成功**不作常驻提示**：原来那枚"草稿已保存"的勾一直占位，
   * 而它几乎永远为真，属于无信息的常驻状态。持久化失败/身份不可用时如实提示
   * 「未持久化」及其后果（刷新/崩溃会丢），不静默。
   */
  const draftPersist = useStore((st) => st.draftPersist);
  // commandId 在"发送中"保持不变：重复点击不会创建多个任务（RT-01）
  const commandIdRef = useRef<string>(newId());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const appliedInsertRef = useRef<number | null>(null);
  /** 刚载入过草稿的 key：让紧接着的一次保存 effect 跳过，避免把草稿清空 */
  const skipSaveRef = useRef<string | null>(null);

  // 载入该目标的草稿；主池与线程草稿分别保存、互不转移（§17.4、TH-04）。
  //
  // 评审指出：只恢复正文、清空 @ 与附件，会**改变发送意图** ——
  // 你原本点名了某人，回来文字还在、接收对象却没了。所以结构化选择一并保存。
  //
  // 两个必须处理的时序问题（都是实测踩出来的）：
  //  1) 初次挂载时 useRef(draftKey) 已经等于 draftKey，若用 `!== draftKey` 做守卫，
  //     载入分支永远不会执行 —— 直接打开某个线程时草稿读不出来。
  //  2) setBody 是异步的：载入后本次渲染里 body 仍是旧值 ''，紧接着保存 effect 会把
  //     空串写回存储，把草稿清掉。因此载入后要让"下一个保存 effect"跳过一轮。
  useEffect(() => {
    const saved = getDraftFull(draftKey);
    setBody(saved.body);
    setMentions(saved.mentions);
    setDeliberate(saved.collaboration==='deliberate');
    // 附件芯片由 store.uploadItems 提供（真源）；已存草稿引用 hydrate 重建（切回/重启恢复）。
    if (attachmentUpload != null) hydrateUploadRefs(draftKey, attachmentUpload.conversationId, saved.attachments);
    setAccess(saved.access as AccessMode);
    /*
     * 意图的恢复规则（2026-09-25）：
     *  · 记录串：**默认仍是"保存记录"**（历史兼容，见 recordThread 注释）；
     *  · 其它上下文：恢复草稿里存着的意图 —— 旧草稿的 `discussion` 已在
     *    store 的 migrateDraft 里迁移成 `record`，所以"上次是仅记录"会原样回来，
     *    不会因为这次改造变成一次 AI 发送。空白的新输入则是默认的 `'ai'`。
     */
    setSendAs(recordThread ? 'record' : saved.sendAs);
    setMentionOpen(false);
    setMentionTrigger(null); // 切草稿即取消：旧触发位置对新草稿无意义
    setAccessOpen(false);
    commandIdRef.current = newId();
    skipSaveRef.current = draftKey;
    // r61 G7：目标未挂载期间排队的摘录/正文插入在此消费（一次性取走——旧队列不在后续
    // 新点击时批量灌入；每条插入恰好一次落正文）。
    applyDraftInserts(takeDraftInserts(draftKey));
  }, [draftKey, recordThread]);

  // 正文与结构化选择变化即写入草稿（草稿不是命令，commandId 保持不变）；持久化状态由
  // store.draftPersist 统一呈现（内存写不失败——失败的是 localStorage 快照，见 persistence 注释）。
  useEffect(() => {
    if (skipSaveRef.current === draftKey) {
      skipSaveRef.current = null;
      return;
    }
    // 附件引用由上传/移除动作维护（防串写），这里只落正文/提及/意图/权限——读取现草稿合并。
    const cur = getDraftFull(draftKey);
    // r61：内容未变不重写——重挂载（切页签回来/崩溃恢复重载）会先 setBody(草稿值)再触发本
    // 效应；若照写一遍会把编辑代次无谓 +1，未知信封重试清算的「代次未变才剥离已发正文」
    // 判定随即失效（发送成功后正文残留）。同内容跳写=代次只在真实编辑时递增。
    const same = cur.body === body
      && cur.mentions.length === mentions.length
      && cur.mentions.every((m, i) => m === mentions[i])
      && cur.access === access
      && cur.sendAs === sendAs
      && cur.collaboration === collaboration;
    if (same) return;
    setDraftFull(draftKey, { ...cur, body, mentions, access, sendAs,collaboration });
  }, [draftKey, body, mentions, access, sendAs,collaboration]);

  useEffect(() => {
    if (!insertText || appliedInsertRef.current === insertText.id) return;
    appliedInsertRef.current = insertText.id;
    setMentionOpen(false); // 正文被外部插入——打开中的候选框触发位置已失效
    setMentionTrigger(null);
    setBody((current) => {
      const next = current.trim() ? `${current}\n\n${insertText.text}` : insertText.text;
      return next;
    });
    textareaRef.current?.focus();
  }, [insertText]);

  /** 正文插入应用（r61 G7：摘录等文本块——一次一条，正文保持用户文字，新插入追加不覆盖）。 */
  const applyDraftInserts = (items: Array<{ id: number; text: string }>): void => {
    if (items.length === 0) return;
    setMentionOpen(false);
    setMentionTrigger(null);
    setBody((current) => items.reduce((acc, it) => (acc.trim() ? `${acc}\n\n${it.text}` : it.text), current));
  };

  /**
   * zs:focus-composer（r56 起；r61 G7 修订）：预览「摘录」/「引用文件」后由 PreviewPane
   * 派发——这里消费该目标的待插入文本并聚焦输入框（文件引用卡本身由 store 驱动，无需消费）。
   */
  useEffect(() => {
    const onFocusComposer = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== draftKey) return;
      applyDraftInserts(takeDraftInserts(draftKey));
      textareaRef.current?.focus();
    };
    window.addEventListener('zs:focus-composer', onFocusComposer);
    return () => window.removeEventListener('zs:focus-composer', onFocusComposer);
  }, [draftKey]);

  /**
   * 输入框随内容自动增高（规范 §5.6）。
   *
   * 规范要求："默认两行高（54px），**随内容增长到 200px 上限后内部滚动**"。
   * 实测原实现只有 CSS `height:54px; max-height:200px`，
   * **没有任何 JS 增高逻辑** —— 于是 `max-height` 永远不会被触及，
   * 输入超过两行时直接在 54px 里滚动，多行需求实际上没有兑现
   * （`scrollHeight` 恒等于 `clientHeight`，行数一多就只能看到两行）。
   *
   * 做法：先把高度重置为 auto 读 `scrollHeight`，再钳到 [54, 200]。
   * 重置这一步是必需的 —— 否则内容变少时高度不会回落（scrollHeight
   * 只会等于或大于当前 height）。
   * `body` 进依赖：所有变更都经 setBody，包括草稿恢复与引用插入。
   */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(200, Math.max(54, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  const route = useMemo(() => deriveRoute(mentions, sendAs, memberIds,collaboration), [mentions, sendAs, memberIds,collaboration]);

  const currentMode = ACCESS_MODES.find((m) => m.value === access) ?? ACCESS_MODES[0];

  const hasAll = mentions.includes('all');
  const namedCount = mentions.filter((m) => m !== 'all').length;

  /* E6：方式芯片随 @ 结构切换；默认全关。
     注意：决策 03「先给方案再执行」已并入右侧的「计划模式」权限档，
     因此不 @ 时这里不再重复出现同义开关。 */
  const methodChip = useMemo(() => {
    if (sendAs === 'record') return null;
    if (hasAll) {
      return {
        key: 'skip_first_draft' as const,
        label: '跳过独立首稿',
        hint: '决策 05：@全体 默认先各自独立出稿再互评；开启后直接进入共同讨论，会削弱独立意见的保留程度。',
        on: skipFirstDraft,
        set: setSkipFirstDraft,
      };
    }
    if (namedCount >= 2) {
      return {
        key: 'split_work' as const,
        label: '分工执行',
        hint: '决策 09：多个 @ 默认是"共同研讨"（各自出报告）；开启后改为由一个成员统筹分工执行。',
        on: splitWork,
        set: setSplitWork,
      };
    }
    return null;
  }, [sendAs, hasAll, namedCount, skipFirstDraft, splitWork]);

  function newId() {
    return `cmd_${Math.random().toString(36).slice(2, 10)}`;
  }

  async function submit(imageAck?: 'omit-images') {
    const text = body.trim();
    // R66 P3（用户已批准）：没有正文但有**就绪附件**也可发送（默认发 AI；仅记录只保存）——
    // 草稿 refs 只含已就绪 attachmentId；真正空白（无正文且无可发送附件）仍拒绝。
    const refsAtGuard = getDraftFull(draftKey).attachments.filter((a) => a.attachmentId != null && a.attachmentId.length > 0);
    if (text.length === 0 && refsAtGuard.length === 0) return;
    if (sendDisabledReason) return;
    // r62 P1 防重复守卫（R66 P3 修订）：文件-only 的 body 都为空——不能只比 body，须比**完整
    // 意图身份**（正文+意图+@提及+附件引用集合）。同一身份=换新号必重复，只允许同号重发或
    // 显式放弃；等待期改了正文/附件/提及=不同身份，允许新号发送（未知信封仍保留）。
    if (pendingEnv != null && pendingIdentityMatches(pendingEnv, text, mentions, sendAs, refsAtGuard.map((a) => a.attachmentId!),collaboration)) {
      setSendErrorFor(draftKey, '上次发送结果未知且内容未改——直接再发会换新命令号，可能与已提交的发送重复；请先点上方「重发原内容」（同号幂等）或「放弃」');
      return;
    }
    // 防重按**目标键**锁（review-r47 §3/r48 §4）：同一目标在途时挡双击/Enter 并发；其它目标
    // 独立可发；A 的回执 finally 只删 A 的键（不清 B 的锁）。
    if (sendingKeys.has(draftKey) || imageCheckingKeys.has(draftKey)) return;
    // 图片能力门（第五十二轮，§6.3）：图片附件+派发意图→**显式二选一**（仅发送文字=图片不送
    // 模型并如实注明；或改为仅记录），选择前不发送；选择结果一次性冻结进信封（imageAck）。
    // R66 P3：选了「仅发送文字」但正文为空且**其余附件也全是图片**→会形成空模型输入——
    // 服务端同判拒绝；此处提前给出可行选择（添加文字/改仅记录），不发出必失败的请求。
    const draftRefs = getDraftFull(draftKey).attachments;
    const imageNames = draftRefs.filter((a) => a.kind === 'image_file').map((a) => a.name);
    if (imageNames.length > 0 && sendAs === 'ai' && imageAck !== 'omit-images') {
      const revisionAtCheck = getDraftFull(draftKey).rev;
      imageCheckingKeys.add(draftKey);
      try {
        const projectId = getState().activeProjectId;
        const conversationId = attachmentUpload?.conversationId ?? target.dmId ?? '';
        const formalTarget = target.kind === 'room_root' ? { kind: target.kind, projectId, conversationId, roomId: target.roomId }
          : target.kind === 'thread' ? { kind: target.kind, projectId, conversationId, threadId: target.threadId }
          : { kind: target.kind, projectId, conversationId };
        const capability = await command<{ supported: boolean; willDispatch: boolean; members: Array<{ kind: string; model: string; status: string; channel: string; reason: string; configuration: string; protocol: string }> }>('message.imageCapability', {
          target: formalTarget, ...(collaboration?{collaboration}:{}), mentions: mentions.map((id) => id === 'all' ? { kind: 'all' } : { kind: 'member', memberId: id }),
        });
        if (draftKeyRef.current !== draftKey || getDraftFull(draftKey).rev !== revisionAtCheck || getState().activeProjectId !== projectId) return;
        if (!capability.supported) { setImageGate({ names: imageNames, reason: capability.members.map((m) => `${m.kind ?? '未配置运行时'} · 模型ID ${m.model ?? '未指定'} · 渠道 ${m.channel ?? '无法确定'} · 配置 ${m.configuration ?? '未知'} · ${m.protocol ?? '协议未验证'} · 图片输入${m.status === 'supported' ? '自动传递；请 @ 单个成员后发送' : '不可用或未确认'}：${m.reason ?? '当前配置无法传递图片'}`).join('；') }); return; }
      } catch (error) {
        setSendErrorFor(draftKey, `图片发送能力读取失败：${(error as Error).message}。草稿与原件保留，可重试或改为仅记录。`);
        return;
      } finally { imageCheckingKeys.delete(draftKey); }

    }
    if (imageAck === 'omit-images' && text.length === 0 && draftRefs.every((a) => a.kind === 'image_file')) {
      setSendErrorFor(draftKey, '已选「仅发送文字」，但没有可用文字（正文为空且附件只有未认证图片）——请先添加文字、改为「仅记录」，或换非图片附件');
      return;
    }
    sendingKeys.add(draftKey);
    setSending(true);
    setSendErrorState(null);
    setImageGate(null);
    const keyAtSend = draftKey;
    const sentMentions = mentions;
    /** 本次实际发送的附件引用（refs 身份——不再按文件名/大小识别，review-r51 §2）。 */
    const sentAttachmentIds = draftRefs.map((a) => a.attachmentId);
    const sentAttachments = draftRefs;
    const sentAs = sendAs;

    const outcome = onSend({
      body: text,
      sendAs,
      mentionIds: mentions,
      ...(collaboration?{collaboration}:{}),
      method: { planFirst: access === 'plan', skipFirstDraft, splitWork },
      access,
      attachments: sentAttachments,
      commandId: commandIdRef.current,
      target,
      draftRev: getDraftFull(draftKey).rev,
      ...(imageAck === 'omit-images' ? { imageAck: 'omit-images' as const } : {}),
    });

    /** 按**发起目标键**结算 STORED 草稿（review-r47 §3：迟到回执只清发起目标的已发内容，
     * 等待期/切目标后的其它草稿与编辑不动）；返回结算后的草稿供同键在挂时同步当前输入。
     * r53 §4 收口：**已发 refs 清算独立于正文保护**——无论等待期是否编辑（代次变没变），
     * 都只剥本次确实发送的 attachmentId 集合并清 store 已结算上传项；正文/提及剥离仍按
     * 代次门（等待期编辑过则保留）。等待期新选的附件（新 attachmentId）不受影响；已发出
     * 的资源不会默默留在草稿里进入下一条信封。 */
    const revAtSend = getDraftFull(keyAtSend).rev;
    const settleForKey = (key: string): HifiDraft => {
      const d = getDraftFull(key);
      const unchanged = d.rev === revAtSend;
      const nextBody = unchanged && d.body.startsWith(text) ? d.body.slice(text.length).replace(/^\s+/, '') : d.body;
      const mentionsClear = unchanged && d.mentions.length === sentMentions.length && d.mentions.every((m, i) => m === sentMentions[i]);
      const sentIds = new Set(sentAttachmentIds);
      const keptAttachments = d.attachments.filter((a) => !sentIds.has(a.attachmentId));
      const settled: HifiDraft = {
        ...d,
        body: nextBody,
        mentions: mentionsClear ? [] : d.mentions,
        attachments: keptAttachments,
        // 「仅记录」一次性：确认成功后回到默认发送方式（失败/未知不复位——重试仍是原意图）。
        sendAs: sentAs === 'record' ? (recordThread ? 'record' : 'ai') : d.sendAs,
      };
      setDraftFull(key, settled);
      clearSettledUploads(key, sentAttachmentIds);
      return settled;
    };
    const syncIfMounted = (key: string, settled: HifiDraft) => {
      if (draftKeyRef.current !== key) return; // 已切目标：不动当前输入（B 的草稿不受 A 回执影响）
      setBody(settled.body);
      setMentions(settled.mentions); // r63：已发 @ 的清理结果随统一清结算同步（此前不同步=芯片残留）
      // 附件芯片由 store 驱动（clearSettledUploads 已按 refs 清）——不同步本地状态。
      setSendAs(settled.sendAs);
      setMentionOpen(false);
    };

    // 正式异步合同：onSend 返回 Promise 时等待可判定结果——成功按发起键结算；确定失败保留
    // 草稿+行内错误（按发起键）+换新命令号；**结果未知**：冻结完整原信封（commandId+target+
    // body+mentions+intent）到 store，立即换新命令号（此后正常发送=新信封，不会同号改参触发
    // IDEMPOTENCY_CONFLICT），重试走「重发原信封」。未返回 Promise（原型同步形态）保持原行为。
    if (outcome != null && typeof (outcome as Promise<unknown>).then === 'function') {
      (outcome as Promise<FormalSendOutcome | void>).then((r) => {
        if (r == null || r.status === 'ok') {
          // r63 P1（review-r62 §2）：成功清算是**页面在 store 层的 settleOutbound 单一来源**
          //（正文/mentions/refs/一次性意图/账本一次写，先剥内容后删账）。此处只读结算后的草稿
          // 同步现挂 UI——不再二次 setDraftFull（双结算递增代次→revAtSend 门失效→已发 @ 残留）。
          syncIfMounted(keyAtSend, getDraftFull(keyAtSend));
          commandIdRef.current = newId(); // 成功后下一次是新的命令
        } else if (r.status === 'failed') {
          commandIdRef.current = newId(); // 确定失败：新命令号重发
          setSendErrorFor(keyAtSend, `发送失败：${r.error}——内容已保留，修正后可重发`);
        } else {
          // 页面已在发送前用正式 builder 冻结完整信封并按 unknown 入库（park）——此处只换新号。
          commandIdRef.current = newId();
          setSendErrorFor(keyAtSend, `发送结果未知（${r.error}）——原信封已保留，可「重发原内容」（同命令号不重复）`);
        }
      }).catch((e: unknown) => {
        // 无明确业务回执的异常：页面按 unknown 已冻结原信封——此处只换新号。
        commandIdRef.current = newId();
        setSendErrorFor(keyAtSend, `发送结果未知（${e instanceof Error ? e.message : String(e)}）——原信封已保留，可「重发原内容」`);
      }).finally(() => {
        sendingKeys.delete(keyAtSend); // 只清发起键（不清其它在途目标——r48 §4）
        setSending(false);
      });
      return;
    }
    // 原型同步形态（onSend 不返回 Promise）兼容分支——正式三页均异步并已在 store 层走
    // settleOutbound 统一清算；此分支不构成第二结算源（r63 P1）。
    const settled = settleForKey(keyAtSend);
    syncIfMounted(keyAtSend, settled);
    commandIdRef.current = newId();
    queueMicrotask(() => {
      sendingKeys.delete(keyAtSend);
      setSending(false);
    });
  }

  /** 重发原信封（结果未知专用）：严格使用冻结参数；成功按发起键结算+清信封；确定失败清信封。 */
  function retryUnknown(env: PendingSendEnvelope): void {
    if (onRetrySend == null) return;
    if (sendingKeys.has(draftKey)) return;
    sendingKeys.add(draftKey);
    setSending(true);
    setSendErrorState(null);
    const keyAtSend = draftKey;
    void onRetrySend(env).then((r) => {
      if (r == null || r.status === 'ok') {
        // r63 P1：重试成功与普通成功共用 settleOutbound 统一清算（正文/mentions/refs/一次性
        // 意图/账本+pendingSends 同号收口与队首顶替；先剥内容后删账的崩溃安全顺序不变）。
        settleOutbound(keyAtSend, env, { recordThread });
        const settled = getDraftFull(keyAtSend);
        if (draftKeyRef.current === keyAtSend) {
          setBody(settled.body);
          setMentions(settled.mentions);
          setSendAs(settled.sendAs);
        }
        return;
      }
      if (r.status === 'failed') {
        clearUnknownEnvelope(keyAtSend); // 原信封被服务明确拒绝：信封作废
        setSendErrorFor(keyAtSend, `重发失败：${r.error}`);
        return;
      }
      setSendErrorFor(keyAtSend, `重发仍未知（${r.error}）——原信封继续保留，可再重试`);
    }).catch((e: unknown) => {
      setSendErrorFor(keyAtSend, `重发仍未知（${e instanceof Error ? e.message : String(e)}）——原信封继续保留`);
    }).finally(() => {
      sendingKeys.delete(keyAtSend);
      setSending(false);
    });
  }

  function insertMention(id: string) {
    setMentions((prev) => {
      if (id === 'all') return ['all'];
      const next = prev.filter((m) => m !== 'all');
      return next.includes(id) ? next : [...next, id];
    });
    // 只消费**本次触发位置**的 @（r55 T2）：记录下标处仍为 @ 才删那一个字符——中文紧邻
    // 「整理任务要点@」、行首/空白、光标处触发全覆盖；工具栏打开（无触发）不动正文；
    // 正文其它合法 @/邮箱文本不被替换。指派事实仍在 mentions/信封（memberId 结构化保留）。
    const trig = mentionTrigger;
    setMentionTrigger(null);
    if (trig != null && trig.draftKey === draftKey) {
      setBody((cur) => (cur.charAt(trig.index) === '@' ? cur.slice(0, trig.index) + cur.slice(trig.index + 1) : cur));
    }
    setMentionOpen(false);
    textareaRef.current?.focus();
  }

  /**
   * @ 触发检测（r55 T2）：以**光标位置**为准——光标前一位是 @ 即打开候选并记录该下标
   * （不再只认「正文末尾的 @」，光标处/中文紧邻触发同判）；IME 组合中不触发（组合结束
   * 再判定一次——输入法过程不被打断，结束时若光标前恰为 @ 候选照常打开）。
   */
  function detectMentionTrigger(ta: HTMLTextAreaElement | null): void {
    if (ta == null || composingRef.current) return;
    const v = ta.value;
    const cur = ta.selectionStart ?? v.length;
    if (cur > 0 && v.charAt(cur - 1) === '@') {
      setMentionOpen(true);
      setMentionTrigger({ index: cur - 1, draftKey });
    } else {
      setMentionOpen(false);
      setMentionTrigger(null);
    }
  }

  function onInput(ta: HTMLTextAreaElement) {
    setBody(ta.value);
    detectMentionTrigger(ta);
  }

  /** 参与者名：用于 @ 按钮的 tooltip，让发送前能看到这次会叫上谁 */
  const participantNames = (route.mode==='AUTO'&&room?.coordinatorMemberId?[room.coordinatorMemberId]:route.resolvedMemberIds)
    .map((id) => memberLabel(allMembers.find((m) => m.id === id)))
    .join('、');

  /**
   * 发送前推导预算（E12 / §10.4）。
   * DELIBERATE 按冻结名单推导：核心 6N+1，含一次修订 7N+2；
   * 并为 SYNTHESIS(1) + RATIFY(N) 预留尾部配额。
   * 原来只在发送后的系统卡里出现，不满足"发送前显示推导值"。
   */
  const budgetPreview = useMemo(() => {
    if (sendAs === 'record') return null;
    const n = route.resolvedMemberIds.length;
    if (route.mode === 'DELIBERATE' && n > 0) {
      const core = 6 * n + 2;
      return {
        calls: core,
        // 公式与推导明细收进 tooltip：主界面只显示"最多 N 次调用"
        detail: `默认按冻结名单 ${n} 人及一次检查点推导 6N+2=${core}；整合与确认预留 ${1+n} 次。实际预算以正式运行快照为准。`,
      };
    }
    if (route.mode === 'DIRECT') {
      return { calls: 6, detail: 'DIRECT：用户最初输入引发的模型调用；额外输入创建新的预算段。' };
    }
    return { calls: 24, detail: 'AUTO 本轮共用最多24次，规划、全部子任务、修复和整合计入，预留2次整合；遵守更小任务预算。实际以正式运行快照为准。' };
  }, [sendAs, route.mode, route.resolvedMemberIds.length]);

  /**
   * 预算可见性（减负 §6.1 / D5 决议）。
   *
   * 开发报告 §10.4 两处明文要求 **DELIBERATE 的推导值发送前显示**（E12），
   * 所以多成员研讨继续保留输入区那枚紧凑 chip（它已经是极简形态）。
   * 普通任务的预算明细收进「本次运行设置」；只有当它**影响本次执行**时
   * （预算已用完 / 接近上限）才在输入区显式提示。
   */
  const budgetVisible = sendAs === 'ai' && route.mode === 'DELIBERATE' && Boolean(budgetPreview);
  const budgetAlert = useMemo(() => {
    if (sendAs === 'record' || !runBudget) return null;
    const { used, max } = runBudget;
    if (max <= 0) return null;
    if (used >= max) return `本次运行预算已用完（${used}/${max} 次），继续会创建新的预算段`;
    if (used >= max - 1) return `本次运行接近上限（${used}/${max} 次）`;
    return null;
  }, [sendAs, runBudget]);

  /**
   * r63：runtime 未绑定提示（发送区就地）——@ 指派成员未绑定（或未指派且项目无任何已绑定
   * agent）时给出原因与直达入口（成员页「配置 runtime」）；能力未认证不在发送前硬拦（派发侧
   * 按认证边界处理），未绑定是明确的配置缺失。
   */
  const navigateToMembers = (): void => { void import('../lib/router').then((m) => m.navigate('/members')); };
  const runtimeHint = useMemo(() => {
    if (sendAs !== 'ai' || target.kind === 'dm') return null; // DM 走成员自身绑定链；仅记录不派发
    // 房间根输入在 M0 非 DIRECT 时先要选定单个成员；此刻未绑定提示指向尚未确定的执行
    // 成员，会与同位置的 M0 派发提示叠成两张警示。选定成员后再核其真实 runtime。
    const bound = (id: string) => memberRuntimes[id]?.status === 'bound';
    const agentIds = memberIds.filter((id) => allMembers.find((m) => m.id === id)?.principalType === 'agent');
    if (agentIds.length === 0) return null;
    const named = route.mode==='AUTO'&&room?.coordinatorMemberId?[room.coordinatorMemberId]:route.resolvedMemberIds.filter((id) => id !== 'all');
    if (named.length > 0) {
      const namedUnbound = named.filter((id) => !bound(id));
      if (namedUnbound.length === 0) return null;
      const names = namedUnbound.map((id) => allMembers.find((m) => m.id === id)?.displayName ?? id).join('、');
      return { text: `${route.mode==='AUTO'?'协调成员':'选中成员'}（${names}）未绑定 runtime——派发前请先在成员页配置渠道与模型`, who: namedUnbound.length };
    }
    if (route.resolvedMemberIds.includes('all') || named.length === 0) {
      // AUTO/全体：项目内没有任何已绑定 agent 时提示（有部分可用即不拦 AUTO 语义之外的行为）
      if (!agentIds.some((id) => bound(id))) return { text: '项目成员都还没绑定 runtime——发送给 AI 前请先在成员页配置渠道与模型', who: agentIds.length };
    }
    return null;
  }, [sendAs, target.kind, memberIds, memberRuntimes, allMembers, route.mode, route.resolvedMemberIds,room?.coordinatorMemberId]);

  return (
    <div className="composer">
      {/**
       * 目标摘要行已按用户要求**整行移除**（2026-09-24 第三轮）。
       *
       * 原来这里是"我在对谁说"的常驻身份行（`发布到 开发大厅` / `跟进 #N · 标题`）。
       * 用户看到后明确要求去掉：房间名就在正上方的房间头部、线程身份在
       * 「详情 → 任务概况」与输入框 placeholder 里都有，这一行是重复占位。
       *
       * ⚠ 代价（已在施工报告与本文件注释中留痕）：placeholder 在**输入后就隐藏**，
       * 所以"正在写长回复时还能一眼看到发给谁"这件事不再由常驻元素保证；
       * 身份仍可从「详情 → 任务概况」（任务号/状态/方式/来源/原始要求）与
       * 归档只读提示里查到。若日后需要恢复，恢复这一行即可（props 与样式都还在）。
       */}

      {/* 目标标签行：E3 子任务定向跟进（定向时覆盖整串目标） */}
      {target.subtask ? (
        <div className="composer-target">
          <span
            className="chip"
            style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
          >
            <Icon name="corner-down-right" size={11} />
            → 子任务 #{target.subtask.number}
            <span className="faint" style={{ marginLeft: 2 }}>{target.subtask.title}</span>
            {onClearSubtask ? (
              <button onClick={onClearSubtask} title="取消定向，回到整串">
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </span>
          {/* 不写内部接口名（task.steer）：用户看到的是"直接交给谁"（减负 §4）。
              仅记录时**不会**定向派发，所以这行说明按意图换口径，避免许诺一件不会发生的事。 */}
          <span className="small faint">
            {sendAs === 'record'
              ? '本次是仅记录：定向只作为备注保留，不会交给该子任务执行'
              : '这条内容直接交给该子任务负责人，不经协调者转述；取消定向即回到整串'}
          </span>
        </div>
      ) : null}

      {/* 已选 mention */}
      {mentions.length > 0 ? (
        <div className="composer-mentions">
          {mentions.includes('all') ? (
            <span
              className="chip"
              style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
            >
              <Icon name="users" size={11} />@全体
              <button onClick={() => setMentions([])}><Icon name="x" size={11} /></button>
            </span>
          ) : null}
          {mentions
            .filter((m) => m !== 'all')
            .map((id) => {
              const m = allMembers.find((x) => x.id === id);
              if (!m) return null;
              return (
                <span key={id} className="chip" title={`成员 ${m.displayName}`}>
                  <Icon name="at-sign" size={11} />
                  {memberLabel(m)}
                  <button onClick={() => setMentions((p) => p.filter((x) => x !== id))}>
                    <Icon name="x" size={11} />
                  </button>
                </span>
              );
            })}
        </div>
      ) : null}

      {/* 发送前说明真实协作路由；不更改草稿中的提及或发送意图。 */}
      {sendAs==='ai'&&writeHint?.key===writeContext&&writeHint.error?<div className="composer-mentions" data-zs-write-hint-error role="alert"><span className="chip record-chip">{writeHint.error}{writeHint.readAt?'（保留上次确认；派发前仍会复查）':''}</span></div>:null}
      {runtimeHint != null && sendDisabledReason == null && inputDisabledReason == null ? (
        <div className="composer-mentions" data-zs-runtime-hint="1">
          <span className="chip record-chip" title={runtimeHint.text}>
            <Icon name="alert-triangle" size={11} />
            {runtimeHint.text}
            <button title="打开成员页配置 runtime（渠道/模型/权限模式）" onClick={() => { navigateToMembers(); }}>去成员页配置</button>
          </span>
        </div>
      ) : null}

      {/* 附件芯片（store 上传项：uploading/ready/failed 如实；失败**原因就地可见**——R69 P1-C
          不再只藏 title；就绪字段统一 名称+大小+v版本+预览（空文件显示 0B 也可预览）；提取
          不可用分列警示（P1-D）。按 uploadId 移除——上传中移除=回执到达即弃，不复活。 */}
      {attachments.length > 0 ? (
        <div className="composer-mentions" data-zs-attach-chips="1">
          {attachments.map((a) => (
            <span key={a.uploadId} className="chip mono" data-zs-att={a.status} title={a.status === 'failed' ? `上传失败：${a.error ?? '未知原因'}` : a.status === 'uploading' ? '上传中…（可移除——回执到达即弃）' : `已上传（${a.kind ?? '?'} v${a.revision ?? '?'} · ${String(a.hash ?? '').slice(0, 8)}…）——随下一条消息发送`}>
              <Icon name="paperclip" size={11} />
              {a.name}
              <span className="faint">{a.size > 0 ? `${Math.max(1, Math.round(a.size / 1024))}KB` : '0B'}</span>
              {a.status === 'uploading' ? <span className="faint">上传中…</span> : null}
              {a.status === 'ready' ? <span className="faint">v{a.revision}</span> : null}
              {a.status === 'ready' && a.size === 0 && (a.kind === 'text_file' || a.kind === 'code_file') ? <span className="faint">空文件</span> : null}
              {a.status === 'ready' && attachmentUpload != null ? (
                <button title="打开共享预览（只读——来源/版本/hash；表格可设注入范围）" onClick={() => openPreview({ attachmentId: a.attachmentId ?? '', filename: a.name, kind: a.kind ?? 'text_file', conversationId: attachmentUpload.conversationId, origin: '草稿附件', draftKey, hashHint: a.hash, revisionHint: a.revision })}>预览</button>
              ) : null}
              <button onClick={() => removeAttachment(a.uploadId)} title={a.status === 'failed' ? '移除失败的附件' : '移除附件（已上传的资源仍在会话附件列表中，不再随发送携带）'}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          {attachments.filter((a) => a.status === 'failed').map((a) => (
            <span key={`${a.uploadId}-err`} className="chip mono zs-att-error" data-zs-att-error={a.name} role="alert" title={a.error ?? '未知原因'}>
              <Icon name="alert-triangle" size={11} />
              <span style={{ color: 'var(--warning)' }}>{a.name} 上传失败：{a.error ?? '未知原因'}</span>
              <button title="重新打开文件选择框（换一个文件或修正后重选）" onClick={() => fileInputRef.current?.click()}>重选文件</button>
            </span>
          ))}
          {attachments.filter((a) => a.status === 'ready' && a.warning != null).map((a) => (
            <span key={`${a.uploadId}-warn`} className="chip mono" data-zs-att-warn={a.name} title={a.warning}>
              <Icon name="alert-triangle" size={11} />
              {a.name} 已保存，但{a.warning}
            </span>
          ))}
        </div>
      ) : null}

      {/* R69 P1-C：空文件发 AI 门——正文为空且可发送附件全是 0B 空文本时，发给 AI 没有任何
          可用内容；就地说明并给可行操作（不静默造空派发、不禁上传——仅记录/补充正文均可）。 */}
      {sendAs === 'ai' && body.trim().length === 0 && readyAttachmentCount > 0
        && attachments.filter((x) => x.status === 'ready').every((x) => x.size === 0 && (x.kind === 'text_file' || x.kind === 'code_file')) ? (
        <div className="composer-mentions" data-zs-empty-text-gate="1">
          <span className="chip record-chip" title="这些附件都是 0 字节空文本——发给 AI 不会带上任何可用内容（不冒充模型已读、不造空派发）">
            <Icon name="alert-triangle" size={11} />
            空文件没有可发送给 AI 的内容（{attachments.filter((x) => x.status === 'ready' && x.size === 0).map((x) => x.name).join('、')}）
            <button title="本次只保存内容、不派发（空文件照常作为记录保存）" onClick={() => setSendAs('record')}>本次仅记录</button>
          </span>
        </div>
      ) : null}

      {/* 图片能力门（第五十二轮 §6.3）：显式二选一——选择前不发送；结果一次性冻结进信封。 */}
      {imageStatus?.key === imageContext && attachments.some(a => a.status === 'ready' && a.kind === 'image_file') ? <div className="composer-mentions" data-zs-image-status="1">
        <span className="chip record-chip" style={{ whiteSpace: 'normal' }}>{sendAs === 'record' ? '本次仅记录：图片本地保存与预览可用。' : ''}{imageStatus.text}</span>
      </div> : null}
      {imageGate != null ? (
        <div className="composer-mentions">
          <span className="chip record-chip" title="模型图片输入能力未认证（IMAGE_INPUT_UNVERIFIED）——图片不会作为模型输入；两种选择都会如实注明">
            <Icon name="image" size={11} />
            {imageGate.reason ?? '当前目标图片输入尚未认证'}：{imageGate.names.join('、')}
            <button disabled={body.trim().length === 0 && attachments.filter((a) => a.status === 'ready').every((a) => a.kind === 'image_file')} title="仅发送文字：图片随消息保存给用户看，但注入文本将如实注明「图片未送给模型」" onClick={() => submit('omit-images')}>仅发送文字（图片不送模型）</button>
            <button title="本次改为仅记录：不派发、不注入，图片只作为记录保存" onClick={() => { setImageGate(null); setSendAs('record'); }}>改为仅记录</button>
            <button title="移除本草稿图片引用；已保存原件保留，其余内容可继续发送" onClick={() => { for (const a of attachments) if (a.kind === 'image_file') removeAttachment(a.uploadId); setImageGate(null); }}>移除图片继续</button>
            {showMentions ? <button title="重新选择已认证图片输入的成员后发送" onClick={() => { setImageGate(null); setMentionTrigger(null); setMentionOpen(true); }}>换可用成员</button> : <button onClick={navigateToMembers}>成员配置</button>}
            <button title="暂不发送" onClick={() => setImageGate(null)}>取消</button>
          </span>
        </div>
      ) : null}

      {/* 结果未知的在途信封（review-r47 §2）：与当前草稿分列——重试严格重发原信封。
          R66 P3：文件-only 信封 body 为空——摘要显示附件数而不是空正文。 */}
      {pendingEnv != null ? (
        <div className="composer-mentions">
          <span className="chip record-chip" title={`结果未知的发送：${pendingEnvSummary(pendingEnv)}（${new Date(pendingEnv.at).toLocaleTimeString()}）`}>
            <Icon name="alert-triangle" size={11} />
            上次发送结果未知：{pendingEnvSummary(pendingEnv).slice(0, 24)}…
            <button title="严格重发原信封（同命令号——服务幂等，不会重复）" onClick={() => retryUnknown(pendingEnv)}>重发原内容</button>
            <button title="放弃该信封（若服务实际已保存，消息会在下次刷新出现）" onClick={() => clearUnknownEnvelope(draftKey)}>放弃</button>
          </span>
        </div>
      ) : null}

{/**
       * 「仅记录」标记（一次性发送意图，2026-09-25）。
       *
       * 它表达的是**这一次**不会请求 AI 回复：
       *  · 可随时用 ✕ 取消，取消后立刻恢复成普通的"发送给 AI"；
       *  · 保存成功后自动消失（意图只用一次）；
       *  · 不改变权限档位的值、不清运行、不停任务。
       * 放在输入框上方与 @／附件同一排，是为了跟"这次要发什么"待在一起，
       * 而不是又造一条常驻栏。
       */}
      {sendAs === 'record' ? (
        <div className="composer-mentions">
          <span
            className="chip record-chip"
            title={
              recordThread
                ? '这是历史记录串：里面的消息一直只保存、不请求 AI 回复；如果你想让它交给 AI，取消这个标记再发送'
                : '仅记录：这次只保存内容，不请求 AI 回复、不创建运行、不占用预算（点右侧 ✕ 取消，恢复发送给 AI）'
            }
          >
            <Icon name="bookmark" size={11} />
            仅记录 · 不请求回复
            <button onClick={() => setSendAs('ai')} title="取消仅记录，恢复发送给 AI" aria-label="取消仅记录">
              <Icon name="x" size={11} />
            </button>
          </span>
        </div>
      ) : null}

      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={2}
          disabled={Boolean(inputDisabledReason)}
          placeholder={
            /*
             * 2026-09-25 起：普通输入默认与 AI 交流，placeholder 直接说明"这条会发给谁"。
             * 不再出现"任务/讨论"二选一，也不再拿"不调用模型"当默认档位 —
             * 只有本次选了「仅记录」（或身处历史记录串）才写成保存记录。
             */
            inputDisabledReason
              ? inputDisabledReason
              : sendAs === 'record'
                ? '保存记录 · 不会请求 AI 回复…'
                : target.kind === 'dm'
                  ? `给 ${dm?.title ?? '这个成员'} 发消息…`
                  : target.kind === 'room_root'
                    ? '发送消息，可 @ 指定成员…'
                    : `跟进当前任务，可 @ 指定成员…`
          }
          value={body}
          onChange={(e) => onInput(e.target)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            // 组合结束再判一次（IME：组合过程不触发，提交后光标前恰为 @ 照常打开候选）。
            detectMentionTrigger(textareaRef.current);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && mentionOpen) {
              // 取消候选（r55）：只关框清触发位置——正文与已选芯片都不动。
              setMentionOpen(false);
              setMentionTrigger(null);
              e.preventDefault();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              // 中文输入法组合态的 Enter 不发送（§17.4）
              if (composingRef.current || e.nativeEvent.isComposing) return;
              e.preventDefault();
              submit();
            }
          }}
        />

        {mentionOpen && showMentions ? (
          <div className="mention-pop">
            <div className="menu-label">提及</div>
            <button className="menu-item" onClick={() => insertMention('all')}>
              <Icon name="users" size={14} />
              <span style={{ flex: 1 }}>{target.kind==='thread'?'本串全体':'全体'}</span>
              <span className="hint">{members.filter(m=>m.enabled).length} 位 AI</span>
            </button>
            <div className="menu-sep" />
            {members.map((m) => (
              <button key={m.id} className="menu-item" onClick={() => insertMention(m.id)} disabled={!m.enabled} data-zs-mention-option={m.id} title={`成员 ${m.displayName}`}>
                <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={16} subject={`member:${m.id}`} />
                <span style={{ flex: 1 }}>{memberLabel(m)}</span>
                <span className="hint">{m.description?`${m.description} · `:''}{runtimeLabelOf(m)}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="composer-toolbar">
          {/**
           * 「任务/讨论」常驻切换已按用户决定**移除**（2026-09-25）：普通输入默认与 AI 交流，
           * 不再要求用户先声明"这次是任务还是备注"。
           * 只想留字不留回复时，从右侧「⋯」菜单选一次性的「仅记录，不请求回复」——
           * 它是一次发送意图，而不是常驻模式（见下方 record chip）。
           */}
          {methodChip&&!formalLimits?.method ? (
            <button
              className={`method-chip${methodChip.on ? ' on' : ''}`}
              title={formalLimits?.method ?? methodChip.hint}
              disabled={Boolean(formalLimits?.method)}
              onClick={() => methodChip.set(!methodChip.on)}
            >
              <Icon name={methodChip.on ? 'check-circle' : 'circle'} size={11} />
              {methodChip.label}
            </button>
          ) : null}

          {/* 附件与提及放在左侧，紧邻输入内容（原来在最右侧，够不着）。
              只读态（私信归档）下附件按钮一并禁用：输入框都写不了，
              还能往草稿里塞附件是自相矛盾的。
              正式通道（第五十一轮 H2）：页面给 attachmentUpload={conversationId} 时经真实
              文件选择+attachment.upload*（格式实际限幅前置，服务端为最终裁决）；未给通道的
              页面维持 formalLimits 禁用说明——不出现「看起来已附上」的 mock 成功。 */}
          <button
            className="icon-btn sm"
            disabled={Boolean(inputDisabledReason) || (attachmentUpload == null && Boolean(formalLimits?.attachments))}
            title={
              attachmentUpload == null && formalLimits?.attachments
                ? formalLimits.attachments
                : inputDisabledReason
                  ? `${inputDisabledReason}（只读中不能添加附件）`
                  : attachmentUpload != null
                    ? '添加附件（真实上传：文本≤256KB、图片≤8MB、PDF/Office≤20MiB、CSV≤5MB——超限会被明确拒绝）'
                    : '附件通道未接入本页'
            }
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="paperclip" size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            data-zs-file-input="1"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = ''; // 允许再次选择同一文件
              if (attachmentUpload == null || files.length === 0) return;
              void uploadPickedFiles(files);
            }}
          />

          {showMentions ? (
            <button
              className={`icon-btn sm${mentionOpen ? ' active' : ''}`}
              title={
                participantNames
                  ? `提及成员（也可以直接打 @）· 当前将叫上：${participantNames}`
                  : '提及成员（也可以直接在输入框里打 @）'
              }
              onClick={() => {
                // 工具栏打开=无触发字符可消费（选人不动正文）；关闭=取消（同样清触发位置）。
                setMentionTrigger(null);
                setMentionOpen((v) => !v);
              }}
            >
              <Icon name="at-sign" size={14} />
            </button>
          ) : null}

          <div className="spacer" />

          {/**
           * 右侧操作簇：预算提示 / 停止 / 本次运行设置 / 权限档位 / 发送。
           *
           * 它们被包成**一个不可拆分的 flex 项**（`.composer-actions`）：
           * 容器不够宽时整簇换行，而不是把「发送」单独挤到下一排
           * （用户反馈：并排预览时发送会掉到第二行，位置飘）。左半边的
           * 任务/讨论、方式、附件、@ 与预算明细先让位。
           */}
          <div className="composer-actions">
            {budgetVisible && budgetPreview ? (
              <span className="composer-budget" title="发送前推导的本次预算；推导明细在「本次运行设置」里">
                <Icon name="activity" size={11} />
                最多 {budgetPreview.calls} 次
              </span>
            ) : null}
            {budgetAlert ? (
              <span className="composer-budget warn" title={budgetAlert}>
                <Icon name="alert-triangle" size={11} />
                {budgetAlert}
              </span>
            ) : null}

            {/* 停止任务：仅在有活动任务时出现，位置在输入区操作区（§2.3） */}
            {stop ? (
              stop.stopping ? (
                <span className="composer-stopping" title="已发出停止，正在等活跃 turn 结束；已产生的文件保留">
                  <Icon name="stop" size={11} /> 停止中…
                </span>
              ) : (
                <button
                  type="button"
                  className="btn danger sm composer-stop"
                  title="停止本次任务：阻止新派发、等待活跃 turn 结束；不等于撤销已产生的改动"
                  onClick={stop.onStop}
                >
                  <Icon name="stop" size={11} /> 停止任务
                </button>
              )
            ) : null}

            {/**
             * 「⋯」菜单（§6）：低频选项的收纳处，同时也是**「仅记录，不请求回复」**的入口
             * （2026-09-25 起，常驻的「任务/讨论」切换被它取代）。
             *
             * 菜单按**是否调用 AI** 分两套内容，避免展示无意义选项：
             *  · 交给 AI：本次方式 / 预算推导 / 权限档位 + 「仅记录」入口；
             *  · 仅记录：只有一句说明（不调用模型、不创建运行）与返回 AI 发送的入口。
             */}
            <button
              type="button"
              className={`icon-btn sm${runSettingsAnchor ? ' active' : ''}`}
              title={sendAs === 'record' ? '本次为仅记录：不请求 AI 回复' : '本次运行设置：本次执行方式、预算推导与说明'}
              aria-label="本次运行设置"
              aria-haspopup="menu"
              onClick={(e) => setRunSettingsAnchor(anchorFromElement(e.currentTarget))}
            >
              <Icon name="more-horizontal" size={14} />
            </button>

            {/* 不能发送时必须说明原因，否则按钮灰着让人不知所措 */}
            {sendDisabledReason ? (
              <span className="composer-budget" title={sendDisabledReason} style={{ color: 'var(--warning)' }}>
                <Icon name="info" size={11} />
                {sendDisabledLabel ?? '只能存草稿'}
              </span>
            ) : null}

            {/* 权限模式下拉（四档，仿常见桌面 agent 客户端）。
                仅记录不调用 AI、不派工，因此**不显示**权限档位 —— 否则会让人以为
                一条纯记录也会触发写入/命令（两份评审都点出过这个歧义）。
                注意：只是"不显示"，**档位的值不会被清空或改掉**（取消仅记录后照旧）。
                只读态（私信归档）下也禁用：这次不会发出去，改档位没有意义。 */}
            {sendAs === 'ai'&&!formalLimits?.access ? (
              <div className="access-picker">
                <button
                  className={`access-trigger${accessOpen ? ' open' : ''}`}
                  disabled={Boolean(inputDisabledReason) || Boolean(formalLimits?.access)}
                  onClick={() => setAccessOpen((v) => !v)}
                  title={formalLimits?.access ? `${writeHint?.key===writeContext?writeHint.reason:'正在读取项目与成员权限'}${writeHint?.error?`；${writeHint.error}`:''}${writeHint?.readAt?`；确认于 ${new Date(writeHint.readAt).toLocaleTimeString()}`:''}` : inputDisabledReason ?? '本次任务的权限模式（意图声明，不是安全保证）'}
                >
                  <Icon name={currentMode.icon} size={13} />
                  {formalLimits?.access ? target.kind==='room_root'&&route.mode!=='DIRECT' ? route.mode==='AUTO'?'自动分工 · 分步骤权限':'多人研讨 · 只读' : writeHint?.key===writeContext&&writeHint.readAt ? writeHint.blocked?'暂不可执行':writeHint.willDispatch===false?'跟进仅记录':writeHint.authorized?writeHint.fullAccess?'CLI 完整权限':'项目内文件编辑':'只读执行' : '权限未确认' : currentMode.label}
                  <Icon name="chevron-down" size={12} />
                </button>

              {accessOpen ? (
                <>
                  <div className="access-scrim" onClick={() => setAccessOpen(false)} />
                  <div className="access-menu" role="menu">
                    {ACCESS_MODES.map((m) => {
                      const unavailable = !m.v01.available;
                      // 先取出原因，避免在闭包里丢失类型收窄
                      const reason = m.v01.available ? undefined : m.v01.reason;
                      return (
                        <button
                          key={m.value}
                          className={`access-item${access === m.value ? ' on' : ''}${unavailable ? ' unavailable' : ''}`}
                          role="menuitemradio"
                          aria-checked={access === m.value}
                          aria-disabled={unavailable}
                          disabled={unavailable}
                          title={reason}
                          onClick={() => {
                            // 未验证的确认档位不允许选中，验证通过后按成员开放（RT-23/B6）
                            if (unavailable) return;
                            setAccess(m.value);
                            setAccessOpen(false);
                          }}
                        >
                          <Icon name={m.icon} size={16} />
                          <span className="access-item-text">
                            <span className="access-item-label">
                              {m.label}
                              {unavailable ? <Tag tone="neutral" icon="slash">待验证</Tag> : null}
                            </span>
                            <span className="access-item-desc">{reason ?? m.desc}</span>
                          </span>
                          {access === m.value ? <Icon name="check" size={14} /> : null}
                        </button>
                      );
                    })}
                    <div className="access-note">{INTENT_HINT}</div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {/**
           * 额外动作（私信归档态的「取消归档」）：放在发送按钮左侧的操作簇里，
           * 与"已归档：只读"的说明同处一地，不再出现"提示说能取消、却找不到入口"。
           */}
          {extraAction}

          <button
            className="btn primary sm composer-send"
            onClick={() => submit()}
            disabled={(body.trim().length === 0 && readyAttachmentCount === 0) || sending || Boolean(sendDisabledReason)}
            title={
              (body.trim().length === 0 && readyAttachmentCount === 0) || sending || Boolean(sendDisabledReason)
                ? sendDisabledReason ?? (sending ? '正在发送…' : '输入内容、或添加就绪附件后可发送（只有文件也可以发送）')
                : 'Enter 发送，Shift+Enter 换行（没有正文但有就绪附件时也可发送）'
            }
          >
            <Icon name="send" size={12} />
            {/**
             * 按钮文案（2026-09-24 第三轮简化）：任务/线程统一「发送」，
             * 讨论串仍是「写入」（它只存消息、不调用模型、不派工，语义确实不同）。
             * 原来线程里写「发送补充」，用户反馈两个字就够 —— 发出去的都是这条串的
             * 一条新消息，"补充"并不改变按钮行为，只是把同一动作说长了一遍。
             */}
            {/*
              按钮文案：普通发送就是「发送」；一次性仅记录（以及历史记录串）
              写「保存记录」，明确区别于"发给 AI"。
            */}
            {sendAs === 'record' ? '保存记录' : '发送'}
          </button>

          {/**
           * 草稿：成功不作常驻提示（它几乎永远为真，占位却没有信息量），
           * 只有**持久化失败/不可用**或**快照恢复有丢弃**才显示，并按真实原因说明后果
           *（§6.2；r61 P5；r62 P2 恢复说明分列）。
           */}
          {draftPersist.error != null ? (
            <span
              className="composer-draft failed"
              title={draftPersist.error}
            >
              <Icon name="alert-triangle" size={11} /> 草稿未持久化
            </span>
          ) : null}
          {draftPersist.error == null && draftPersist.recoveryNote != null ? (
            <span
              className="composer-draft failed"
              title={draftPersist.recoveryNote}
              data-zs-draft-recovery="1"
            >
              <Icon name="alert-triangle" size={11} /> 草稿快照部分未恢复（原件已隔离）
            </span>
          ) : null}

          {/* 正式侧行内发送错误（第四十七轮）：失败/未知都在输入区就地可见，不吞错。 */}
          {sendError != null ? (
            <span
              className="composer-draft failed"
              title={sendError}
              style={{ cursor: 'pointer' }}
              onClick={() => setSendErrorState(null)}
            >
              <Icon name="alert-triangle" size={11} /> {sendError.slice(0, 80)}（点击关闭）
            </span>
          ) : null}
          </div>
        </div>
      </div>

      {/**
       * ⋯ 菜单（§6）——2026-09-25 起它同时是「仅记录，不请求回复」的入口，
       * 常驻的「任务/讨论」切换由这个一次性意图取代。
       *
       * 两套内容按**是否调用 AI** 区分：
       *  · 交给 AI：本次方式 / 预算推导 / 权限档位，外加「仅记录」入口；
       *  · 仅记录：只说明"这次不调用模型、不创建运行、不计预算"，
       *    并给出"改为发送给 AI"的入口 —— 不摆与本次无关的模型执行配置。
       */}
      {runSettingsAnchor ? (
        <Menu anchor={runSettingsAnchor} onClose={() => setRunSettingsAnchor(null)}>
          <div className="menu-label">本次运行设置</div>
          {sendAs === 'record' ? (
            <div className="menu-note">
              <div className="row tight"><Icon name="bookmark" size={12} /> 本次为仅记录</div>
              <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
                只保存内容：不调用模型、不创建运行、不占用预算；@ 了谁也不会因此唤醒 AI。
                保存成功后自动恢复成普通发送。
              </div>
            </div>
          ) : (
            <>
              <div className="menu-note">
                <div className="row tight"><Icon name="git-commit" size={12} /> 本次方式：{routeModeCopy[route.mode].label}</div>
                <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  {target.kind === 'dm'
                    ? '私信只有一种方式：把这条消息发给这个会话的成员，不涉及房间里的其他人。'
                    : routeModeCopy[route.mode].detail}
                </div>
                {methodChip&&!formalLimits?.method ? (
                  <div className="small faint" style={{ marginTop: 6, lineHeight: 1.6 }}>
                    方式开关「{methodChip.label}」：{methodChip.on ? '已开启' : '未开启'}（在输入区切换）
                  </div>
                ) : null}
              </div>
              <div className="menu-note">
                <div className="row tight"><Icon name="activity" size={12} /> 预算推导</div>
                <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  {target.kind === 'dm'
                    ? '本条发给当前私信成员，实际用量可在任务详情查看。'
                    : budgetPreview
                      ? `最多 ${budgetPreview.calls} 次。${budgetPreview.detail}`
                      : '这种方式不产生额外预算。'}
                </div>
              </div>
              <div className="menu-note">
                <div className="row tight"><Icon name="shield" size={12} /> 权限档位</div>
                <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  {formalLimits?.access?(writeHint?.key===writeContext?writeHint.reason:'正在读取 AI 执行权限'):<>当前：{currentMode.label} · {currentMode.v01.available?currentMode.desc:currentMode.v01.reason}</>}
                </div>
              </div>
            </>
          )}

          {/**
           * 入口本身：一次性的"仅记录，不请求回复"。
           * 只有**发给 AI** 的状态下才出现；已经在仅记录时，用输入区的 chip 取消。
           */}
          {target.kind==='room_root'&&sendAs==='ai'&&!inputDisabledReason?<MenuItem icon="users" onClick={()=>{
            const next=!deliberate;setDeliberate(next);
            if(next&&!mentions.includes('all')&&mentions.filter(id=>memberIds.includes(id)).length<2)setMentions(['all']);
            setRunSettingsAnchor(null);
          }}>{deliberate?'改为自然协作':'高级：独立研讨（先独立分析，再互评汇总）'}</MenuItem>:null}
          {sendAs === 'ai' && !inputDisabledReason ? (
            <MenuItem
              icon="bookmark"
              title="仅记录：这次只保存内容，不请求 AI 回复、不创建运行、不占用预算 —— 加 @ 也不会唤醒 AI（一次性意图，发送后自动恢复）"
              onClick={() => {
                setSendAs('record');
                setRunSettingsAnchor(null);
              }}
            >
              仅记录，不请求回复
            </MenuItem>
          ) : null}
        </Menu>
      ) : null}
    </div>
  );
}

export type { ProjectMember, Room };
