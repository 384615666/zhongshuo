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
import { useStore, getDraftFull, setDraftFull } from '../data/store';
import { takePendingQuotes } from '../data/actions-preview';
import { deriveRoute, memberLabel, roomOf } from '../data/selectors';
import { routeModeCopy } from '../lib/format';
import { mockAttachmentDescriptor } from '../data/attachments';
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
    attachments: { name: string; size: number }[];
    commandId: string;
    target: ComposerTarget;
  }) => void;
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
}) {
  /**
   * 成员边界（§4.6）：房间/线程取房间名单，私信取该会话的 audience 名单。
   * @ 候选、方式推导、冻结名单都以它为唯一来源。
   */
  const dm = useStore((s) => (target.kind === 'dm' && target.dmId ? s.dms.find((d) => d.id === target.dmId) : undefined));
  const room = useStore((s) => (target.kind === 'dm' ? undefined : roomOf(s, target.roomId)));
  const memberIds = useMemo(
    () => (target.kind === 'dm' ? (dm?.memberIds ?? []) : (room?.memberIds ?? [])),
    [target.kind, dm, room],
  );
  const allMembers = useStore((s) => s.members);
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
      const prof = profById.get(m.profileId);
      return prof ? byId.get(prof.runtimeInstallationId) ?? '未配置' : '未配置';
    };
  }, [runtimes, profiles]);

  const [body, setBody] = useState('');
  /**
   * 本次发送意图（一次性，2026-09-25 起）：默认 `'ai'`。
   *
   * 历史记录串（无任务的讨论串）是兼容例外：在它们里面默认仍是 `'record'`，
   * 否则删掉切换控件会把"只留字"的长串静默变成一次 AI 调用。
   */
  const [sendAs, setSendAs] = useState<'ai' | 'record'>(recordThread ? 'record' : 'ai');
  const [mentions, setMentions] = useState<string[]>([]);
  const [skipFirstDraft, setSkipFirstDraft] = useState(false);
  const [splitWork, setSplitWork] = useState(false);
  const [access, setAccess] = useState<AccessMode>('plan');
  const [accessOpen, setAccessOpen] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; size: number }[]>([]);
  const [sending, setSending] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  /** 「本次运行设置」弹层（低频选项的收纳处，§6） */
  const [runSettingsAnchor, setRunSettingsAnchor] = useState<{ x: number; y: number } | null>(null);
  /**
   * 草稿保存失败必须可见（§6.2）。
   * 普通保存成功**不作常驻提示**：原来那枚"草稿已保存"的勾一直占位，
   * 而它几乎永远为真，属于无信息的常驻状态。
   */
  const [draftFailed, setDraftFailed] = useState(false);
  // commandId 在"发送中"保持不变：重复点击不会创建多个任务（RT-01）
  const commandIdRef = useRef<string>(newId());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const appliedInsertRef = useRef<number | null>(null);
  /** 同步防重锁：setState 是异步的，挡不住同一 tick 的重复提交（§17.4、RT-01） */
  const sendingRef = useRef(false);
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
    setAttachments(saved.attachments);
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
    setAccessOpen(false);
    commandIdRef.current = newId();
    skipSaveRef.current = draftKey;
  }, [draftKey, recordThread]);

  // 正文与结构化选择变化即写入草稿（草稿不是命令，commandId 保持不变）
  useEffect(() => {
    if (skipSaveRef.current === draftKey) {
      skipSaveRef.current = null;
      return;
    }
    // 保存失败必须显示；成功不占位（§6.2）
    try {
      setDraftFull(draftKey, { body, mentions, attachments, access, sendAs });
      setDraftFailed(false);
    } catch {
      setDraftFailed(true);
    }
  }, [draftKey, body, mentions, attachments, access, sendAs]);

  useEffect(() => {
    if (!insertText || appliedInsertRef.current === insertText.id) return;
    appliedInsertRef.current = insertText.id;
    setBody((current) => {
      const next = current.trim() ? `${current}\n\n${insertText.text}` : insertText.text;
      return next;
    });
    textareaRef.current?.focus();
  }, [insertText]);

  /**
   * 文件预览「引用到」（§7.2）：PreviewPane 派发 zs:focus-composer 并
   * 把固定版本引用排入 pendingQuotes；这里消费入草稿并聚焦。
   * 此前 Composer 没有监听该事件、takePendingQuotes 零消费 ——
   * 引用按钮点击后草稿不变、焦点不动（引用行为核验抓到的真回归）。
   */
  useEffect(() => {
    const onFocusComposer = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== draftKey) return;
      const quotes = takePendingQuotes(draftKey);
      if (quotes.length > 0) {
        setBody((current) => {
          const block = quotes
            .map((q) =>
              `> 引用「${q.title}」v${q.revision}${q.excerpt ? `\n${q.excerpt}` : ''}`,
            )
            .join('\n\n');
          return current.trim() ? `${current}\n\n${block}` : block;
        });
      }
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

  const route = useMemo(() => deriveRoute(mentions, sendAs, memberIds), [mentions, sendAs, memberIds]);

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

  function submit() {
    const text = body.trim();
    if (!text) return;
    if (sendDisabledReason) return;
    // 防重必须用 ref：setSending 是异步的，同一 tick 内两次 click（或 Enter+点击）
    // 都会看到 sending === false，从而创建两个任务 —— §17.4 的不变量会失守。
    // 实测同一 tick 双击会新增 2 个任务；这里用同步锁压成 1 个。
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    onSend({
      body: text,
      sendAs,
      mentionIds: mentions,
      method: { planFirst: access === 'plan', skipFirstDraft, splitWork },
      access,
      attachments,
      commandId: commandIdRef.current,
      target,
    });
    // 发送成功后清空并换新的 commandId（下一次是新的命令）
    setBody('');
    setMentions([]);
    setAttachments([]);
    /**
     * 「仅记录」是**一次性**意图：保存成功后回到该上下文的默认发送方式
     * （记录串回到"保存记录"，其它回到"发送给 AI"）。
     * 只有真正提交出去才复位 —— 否则用户在取消/未发送时会莫名丢掉选择。
     */
    setSendAs(recordThread ? 'record' : 'ai');
    setMentionOpen(false);
    commandIdRef.current = newId();
    // 释放同步锁。放在微任务里，保证同一 tick 内的后续点击仍被挡住。
    queueMicrotask(() => {
      sendingRef.current = false;
      setSending(false);
    });
  }

  function insertMention(id: string) {
    setMentions((prev) => {
      if (id === 'all') return ['all'];
      const next = prev.filter((m) => m !== 'all');
      return next.includes(id) ? next : [...next, id];
    });
    setMentionOpen(false);
    textareaRef.current?.focus();
  }

  // 检测输入中的 @ 触发候选
  function onInput(v: string) {
    setBody(v);
    const at = v.lastIndexOf('@');
    setMentionOpen(at >= 0 && at === v.length - 1);
  }

  /** 参与者名：用于 @ 按钮的 tooltip，让发送前能看到这次会叫上谁 */
  const participantNames = route.resolvedMemberIds
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
      const core = 6 * n + 1;
      const withRevision = 7 * n + 2;
      return {
        calls: withRevision,
        // 公式与推导明细收进 tooltip：主界面只显示"最多 N 次调用"
        detail: `按冻结名单 ${n} 人推导：核心 6N+1=${core}；含一次整合修订 7N+2=${withRevision}。为 SYNTHESIS 1 + RATIFY ${n} 共 ${1 + n} 次预留尾部配额，前面阶段最多占用 ${withRevision - (1 + n)}。`,
      };
    }
    if (route.mode === 'DIRECT') {
      return { calls: 6, detail: 'DIRECT：用户最初输入引发的模型调用；额外输入创建新的预算段。' };
    }
    return { calls: 20, detail: 'AUTO：协调、子任务、审查、返工与整合全部计入。' };
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
                <span key={id} className="chip">
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

      {/* 附件 */}
      {attachments.length > 0 ? (
        <div className="composer-mentions">
          {attachments.map((a, i) => (
            <span key={i} className="chip mono">
              <Icon name="paperclip" size={11} />
              {a.name}
              <span className="faint">{Math.round(a.size / 1024)}KB</span>
              <button onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
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
          onChange={(e) => onInput(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
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
              <span style={{ flex: 1 }}>全体</span>
              <span className="hint">{target.kind === 'dm' ? '冻结该私信全部启用成员' : '冻结当前房间启用名单'}</span>
            </button>
            <div className="menu-sep" />
            {members.map((m) => (
              <button key={m.id} className="menu-item" onClick={() => insertMention(m.id)} disabled={!m.enabled}>
                <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={16} />
                <span style={{ flex: 1 }}>{memberLabel(m)}</span>
                <span className="hint">{runtimeLabelOf(m)}</span>
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
          {methodChip ? (
            <button
              className={`method-chip${methodChip.on ? ' on' : ''}`}
              title={methodChip.hint}
              onClick={() => methodChip.set(!methodChip.on)}
            >
              <Icon name={methodChip.on ? 'check-circle' : 'circle'} size={11} />
              {methodChip.label}
            </button>
          ) : null}

          {/* 附件与提及放在左侧，紧邻输入内容（原来在最右侧，够不着）。
              只读态（私信归档）下附件按钮一并禁用：输入框都写不了，
              还能往草稿里塞附件是自相矛盾的。 */}
          <button
            className="icon-btn sm"
            disabled={Boolean(inputDisabledReason)}
            title={
              inputDisabledReason
                ? `${inputDisabledReason}（只读中不能添加附件）`
                : '添加附件（原型模拟：生成一份可渲染的模拟副本并挂到这条消息；真实文件选择与摄取未接通）'
            }
            onClick={() => setAttachments((p) => [...p, mockAttachmentDescriptor(p.length)])}
          >
            <Icon name="paperclip" size={14} />
          </button>

          {showMentions ? (
            <button
              className={`icon-btn sm${mentionOpen ? ' active' : ''}`}
              title={
                participantNames
                  ? `提及成员（也可以直接打 @）· 当前将叫上：${participantNames}`
                  : '提及成员（也可以直接在输入框里打 @）'
              }
              onClick={() => setMentionOpen((v) => !v)}
            >
              <Icon name="at-sign" size={14} />
            </button>
          ) : null}

          <div className="spacer" />

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
            {sendAs === 'ai' ? (
              <div className="access-picker">
                <button
                  className={`access-trigger${accessOpen ? ' open' : ''}`}
                  disabled={Boolean(inputDisabledReason)}
                  onClick={() => setAccessOpen((v) => !v)}
                  title={inputDisabledReason ?? '本次任务的权限模式（意图声明，不是安全保证）'}
                >
                  <Icon name={currentMode.icon} size={13} />
                  {currentMode.label}
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
            onClick={submit}
            disabled={!body.trim() || sending || Boolean(sendDisabledReason)}
            title={
              !body.trim() || sending || Boolean(sendDisabledReason)
                ? sendDisabledReason ?? (sending ? '正在发送…' : '输入内容后可发送')
                : 'Enter 发送，Shift+Enter 换行'
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
           * 只有**保存失败**才显示，并按真实原因说明后果（§6.2）。
           */}
          {draftFailed ? (
            <span
              className="composer-draft failed"
              title="这段文字没有写进草稿存储：切走目标或刷新会丢失，请先发送或复制出来"
            >
              <Icon name="alert-triangle" size={11} /> 草稿未保存
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
                {methodChip ? (
                  <div className="small faint" style={{ marginTop: 6, lineHeight: 1.6 }}>
                    方式开关「{methodChip.label}」：{methodChip.on ? '已开启' : '未开启'}（在输入区切换）
                  </div>
                ) : null}
              </div>
              <div className="menu-note">
                <div className="row tight"><Icon name="activity" size={12} /> 预算推导</div>
                <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  {target.kind === 'dm'
                    ? '私信暂不创建任务：这条消息只发给该成员，不占用任务预算。'
                    : budgetPreview
                      ? `最多 ${budgetPreview.calls} 次。${budgetPreview.detail}`
                      : '这种方式不产生额外预算。'}
                </div>
              </div>
              <div className="menu-note">
                <div className="row tight"><Icon name="shield" size={12} /> 权限档位</div>
                <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  当前：{currentMode.label} · {currentMode.v01.available ? currentMode.desc : currentMode.v01.reason}
                </div>
              </div>
            </>
          )}

          {/**
           * 入口本身：一次性的"仅记录，不请求回复"。
           * 只有**发给 AI** 的状态下才出现；已经在仅记录时，用输入区的 chip 取消。
           */}
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
