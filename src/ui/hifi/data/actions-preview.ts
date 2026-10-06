/**
 * 共享预览的状态动作（R64 原型还原：UX-PREVIEW-01 / §17.9 的正式版）。
 *
 * 与原型 data/actions-preview.ts 的关系：会话状态（标签/收起/放大/并排侧/返回快照/
 * 上下文变更）与三条铁律（打开不发送不执行；收起保留位置与草稿；迟到不覆盖）原样移植；
 * **资源与引用走正式链路**：
 *  - 引用（r61 用户批准合同）：附件/成果资源 → addFileRefToDraft 引用卡（正文保持用户文字）；
 *    摘录选区 → queueDraftInsert 内容插入队列。不再使用原型的 pendingQuotes 内存队列。
 *  - 工作区文件（项目文件树）：只登记只读资源，内容由预览面板经 project.file.read 实际读取；
 *    未上传为会话附件的工作区文件**不能**直接引用进草稿（如实说明，不自动上传）。
 *  - 文件评论（§7.4）：向**源会话**发一条仅记录消息并携带该附件引用卡（真实 message.submit、
 *    不触发模型派发；版本锚定在引用卡内），不再是原型 toast 模拟。
 */
import { getState, recordWrite, setState, toast } from './store';
import { addFileRefToDraft, queueDraftInsert, conversationOfDraftKey } from './store';
import {
  audienceAllows, closeTab as closeTabPure,
  latestRevisionOf, openTab, resourceOf, revisionOf, tabKeyFor,
} from '../lib/resource';
import type {
  ContextLocation, ContextTarget, DraftReference, PreviewResource,
} from './types';

/** 单调递增的请求代次，保证"只接受最新请求"（PV-16/17） */
let generationCounter = 0;

function nextOrdinal(): number {
  const s = getState();
  return s.preview.tabs.reduce((max, t) => Math.max(max, t.ordinal), -1) + 1;
}

/* ============================================================
   上下文描述
   ============================================================ */

/** 把当前路由上下文转成 ContextTarget（用于 openedFrom 与 audience 判定） */
export function contextTargetOf(
  projectId: string,
  opts: {
    roomId?: string;
    threadId?: string;
    roomView?: 'chat' | 'tasks' | 'files';
    dmConversationId?: string;
    filesView?: 'files' | 'git';
    filesSelection?: string;
  },
): ContextTarget {
  if (opts.dmConversationId) {
    return { kind: 'dm', projectId, conversationId: opts.dmConversationId, threadId: opts.threadId };
  }
  // 文件/Git 工作区独立建模，不借虚构 roomId（§7.5）
  if (opts.filesView) {
    return { kind: 'files', projectId, view: opts.filesView, selection: opts.filesSelection };
  }
  if (opts.threadId && opts.roomId) {
    return {
      kind: 'thread', projectId, roomId: opts.roomId, threadId: opts.threadId,
      tab: 'replies',
    };
  }
  return {
    kind: 'room', projectId, roomId: opts.roomId ?? '', view: opts.roomView ?? 'chat',
  };
}

export function contextKey(t: ContextTarget): string {
  switch (t.kind) {
    case 'room':
      return `room:${t.projectId}:${t.roomId}:${t.view}`;
    case 'thread':
      return `thread:${t.projectId}:${t.threadId}:${t.tab}`;
    case 'dm':
      return `dm:${t.projectId}:${t.conversationId}`;
    case 'files':
      return `files:${t.projectId}:${t.view}`;
  }
}

/** 通知"左侧上下文已改变"（§3.4 第 2 条：关闭预览时保留最新选择，不跳回旧任务）。 */
export function noteContextChanged() {
  if (!getState().preview.contextChangedSinceOpen) {
    setState((s) => ({ ...s, preview: { ...s.preview, contextChangedSinceOpen: true } }));
  }
}

/** 主动切换上下文后，预览并排的那一侧跟着走（§3.3）。 */
export function setPreviewContextSide(side: 'thread' | 'pool') {
  if (getState().preview.side === side) return;
  setState((s) => ({ ...s, preview: { ...s.preview, side } }));
}

/* ============================================================
   资源登记（正式侧：真实身份，不伪造内容）
   ============================================================ */

/**
 * 登记一个**会话附件/成果**资源（真实 attachmentId/hash/revision 来自服务端回执或消息摘要）。
 * audience 按来源会话推导：房间/线程→room、私信→dm。内容不内联——预览面板经
 * attachment.preview* 按需装载（正式渲染器）。
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
  const audience: PreviewResource['audience'] = t.kind === 'dm'
    ? { kind: 'dm', conversationId: t.conversationId, memberIds: [] }
    : t.kind === 'room' || t.kind === 'thread'
      ? { kind: 'room', roomId: t.roomId }
      : { kind: 'project' };
  const origin: PreviewResource['origin'] = t.kind === 'dm'
    ? { kind: 'dm', conversationId: t.conversationId }
    : t.kind === 'thread'
      ? { kind: 'message', messageId: t.threadId, roomId: t.roomId, threadId: t.threadId }
      : t.kind === 'room'
        ? { kind: 'message', messageId: t.roomId, roomId: t.roomId }
        : { kind: 'workspace' };
  setState((prev) => {
    if (prev.resources.some((r) => r.id === input.attachmentId)) return prev;
    const res: PreviewResource = {
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
 * 登记一个**项目工作区文件**资源（文件树入口）：内容经 project.file.read 实际读取
 * （安全根内、只读、白名单文本）；hash 在读取成功后由预览面板回填。同路径去重。
 */
export function registerWorktreeResource(projectId: string, relativePath: string, sizeBytes: number): string {
  const resourceId = `res_wt_${projectId}_${relativePath.replace(/[^a-zA-Z0-9]+/g, '_')}`;
  setState((prev) => {
    if (prev.resources.some((r) => r.id === resourceId)) return prev;
    const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
    const res: PreviewResource = {
      id: resourceId,
      projectId,
      kind: 'worktree',
      title: relativePath.split(/[\\/]/).pop() ?? relativePath,
      relativePath,
      mimeType: ext ? `text/${ext}` : 'text/plain',
      origin: { kind: 'workspace' },
      audience: { kind: 'project' },
      mutable: true,
      revisions: [{
        revision: 1,
        hash: '(读取时核验)',
        sizeBytes,
        createdAt: Date.now(),
        content: { kind: 'unsupported', reason: 'not_connected', note: '内容由共享预览按需装载' },
      }],
      createdAt: Date.now(),
      formalWorktree: { projectId, path: relativePath },
    };
    return { ...prev, resources: [...prev.resources, res] };
  });
  return resourceId;
}

/* ============================================================
   打开资源
   ============================================================ */

/** 打开一个资源版本（唯一入口；权限校验=audience 必须允许当前上下文）。 */
export function openPreview(
  resourceId: string,
  revision: number | undefined,
  openedFrom: ContextLocation,
): boolean {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (!res) {
    toast('这份资源不存在或已被移除', 'error');
    return false;
  }
  if (!audienceAllows(res.audience, openedFrom.target)) {
    toast('当前上下文无权查看这份资源（私信附件不能跨会话共享）', 'error');
    recordWrite('preview.open.denied', `resource=${resourceId} audience=${res.audience.kind} → 拒绝：同 projectId 不是共享许可`);
    return false;
  }
  const rev = revision ?? latestRevisionOf(res)?.revision;
  if (rev === undefined || !revisionOf(res, rev)) {
    toast('该版本不可用，未回退到其他版本', 'error');
    return false;
  }
  const generation = ++generationCounter;
  setState((prev) => {
    const { tabs, activeKey } = openTab(prev.preview.tabs, res, rev, openedFrom, nextOrdinal());
    return {
      ...prev,
      preview: {
        ...prev.preview,
        tabs: tabs.map((t) => (t.key === activeKey ? { ...t, requestGeneration: generation } : t)),
        activeKey,
        hidden: false,
        returnSnapshot: prev.preview.returnSnapshot ?? {
          target: openedFrom.target,
          sizes: { ...prev.layout.sizes },
        },
        contextChangedSinceOpen: false,
        side: openedFrom.target.kind === 'thread' ? 'thread' as const : 'pool' as const,
      },
    };
  });
  recordWrite('preview.open', `resource=${resourceId} revision=${rev} origin=${res.origin.kind} from=${openedFrom.target.kind}（只读，不发送/不执行）`);
  return true;
}

/** 激活已打开的标签（不改变其 openedFrom）。 */
export function activatePreview(key: string) {
  setState((s) => ({ ...s, preview: { ...s.preview, activeKey: key, hidden: false } }));
}

/** 记录标签的阅读位置（关闭/收起后恢复）。 */
export function rememberScroll(key: string, scrollTop: number) {
  setState((s) => ({
    ...s,
    preview: {
      ...s.preview,
      tabs: s.preview.tabs.map((t) => (t.key === key ? { ...t, scrollTop } : t)),
    },
  }));
}

/* ============================================================
   关闭 / 收起 / 放大
   ============================================================ */

export function closePreviewTab(key: string) {
  const s = getState();
  const target = s.preview.tabs.find((t) => t.key === key);
  const { tabs, activeKey } = closeTabPure(s.preview.tabs, key);
  setState((prev) => {
    const next = {
      ...prev.preview,
      tabs,
      activeKey,
      returnSnapshot: tabs.length === 0 ? undefined : prev.preview.returnSnapshot,
      side: tabs.length === 0 ? undefined : prev.preview.side,
    };
    return { ...prev, preview: next };
  });
  recordWrite('preview.tab.close', `key=${key} 剩余标签=${tabs.length}${tabs.length === 0 ? ' → 退出预览并恢复上下文' : ''}`);
  if (target) {
    const res = resourceOf(s, target.resourceId);
    toast(`已关闭 ${res?.title ?? key}${tabs.length === 0 ? '（预览已退出）' : ''}`, 'info');
  }
}

/** 收起整个预览区：保留标签与阅读位置（§4.5）。 */
export function hidePreview() {
  setState((s) => ({ ...s, preview: { ...s.preview, hidden: true, maximized: false } }));
  recordWrite('preview.hide', '收起预览区：保留全部标签与阅读位置，未关闭任何文件');
}

export function showPreview() {
  setState((s) => ({ ...s, preview: { ...s.preview, hidden: false } }));
}

export function closeAllPreviews() {
  const n = getState().preview.tabs.length;
  setState((s) => ({
    ...s,
    preview: { ...s.preview, tabs: [], activeKey: undefined, maximized: false, returnSnapshot: undefined, side: undefined },
  }));
  recordWrite('preview.close_all', `清空 ${n} 个标签 → 退出预览；未删除任何磁盘文件`);
  toast(`已关闭全部 ${n} 个文件`, 'info');
}

export function togglePreviewMaximized() {
  setState((s) => ({ ...s, preview: { ...s.preview, maximized: !s.preview.maximized } }));
}

/* ============================================================
   工作区文件重新读取（PV-09）
   ============================================================ */

/** 工作区文件读取到的真实内容/身份回填（预览面板装载后调用——hash/大小为服务端事实）。 */
export function applyWorktreeRead(
  resourceId: string,
  data: { text?: string; hash?: string; sizeBytes?: number; revision?: number; notPreviewable?: 'binary' | 'too_large'; note?: string },
): void {
  setState((prev) => ({
    ...prev,
    resources: prev.resources.map((r) => {
      if (r.id !== resourceId) return r;
      const ext = (r.relativePath ?? '').split('.').pop()?.toLowerCase() ?? '';
      const content = data.notPreviewable != null
        ? { kind: 'unsupported' as const, reason: data.notPreviewable === 'binary' ? 'binary' as const : 'too_large' as const, note: data.note ?? '不可预览' }
        : ext === 'md'
          ? { kind: 'markdown' as const, text: data.text ?? '' }
          : ext === 'csv' || ext === 'tsv'
            ? { kind: 'csv' as const, text: data.text ?? '' }
            : { kind: ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'mjs' || ext === 'json' ? 'code' as const : 'text' as const, language: ext, text: data.text ?? '' };
      return {
        ...r,
        revisions: r.revisions.map((rev) => (rev.revision === (data.revision ?? rev.revision)
          ? { ...rev, hash: data.hash ?? rev.hash, sizeBytes: data.sizeBytes ?? rev.sizeBytes, content }
          : rev)),
      };
    }),
  }));
}

/** 磁盘已更新：新增读取版本但**不自动切换**（用户点"重新加载"才切）。 */
export function markResourceUpdated(resourceId: string) {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (!res) return;
  const latest = latestRevisionOf(res);
  if (!latest) return;
  const nextRev = latest.revision + 1;
  setState((prev) => ({
    ...prev,
    resources: prev.resources.map((r) =>
      r.id !== resourceId
        ? r
        : { ...r, revisions: [...r.revisions, { ...latest, revision: nextRev, createdAt: Date.now(), hash: `${latest.hash}_r${nextRev}` }] },
    ),
    preview: {
      ...prev.preview,
      tabs: prev.preview.tabs.map((t) =>
        t.resourceId === resourceId && res.mutable === true
          ? { ...t, pendingRevision: nextRev }
          : t,
      ),
    },
  }));
  recordWrite('preview.resource.updated', `resource=${resourceId} → 磁盘已更新，提示而不替换正在读的内容`);
}

/** 用户显式重新加载当前文件（更新读取快照）。 */
export function reloadResource(revision: number, key: string) {
  setState((s) => ({
    ...s,
    preview: {
      ...s.preview,
      tabs: s.preview.tabs.map((t) => (t.key === key ? { ...t, revision, pendingRevision: undefined } : t)),
    },
  }));
  recordWrite('preview.resource.reload', `key=${key} revision=${revision}（只更新读取快照，已插入草稿引用仍绑原版本）`);
}

/* ============================================================
   引用（r61 用户批准合同：引用卡默认 + 摘录独立）
   ============================================================ */

/**
 * 把当前文件引用加入指定目标草稿。
 *
 * 正式语义（r61 重做后用户批准的形态）：
 *  - 附件/成果资源（有真实 attachmentId）→ **引用卡**直写目标草稿（addFileRefToDraft：
 *    同文件同版本去重、跨会话拒绝、失败零写入、focus-composer）；
 *  - 摘录文本 → 独立摘录通道（queueDraftInsert：内容前缀插入队列，Composer 挂载即消费）；
 *  - 工作区文件（未上传为会话附件）→ 不能直接引用（如实说明，不自动上传）。
 */
export function quoteResource(
  resourceId: string,
  revision: number,
  targetDraftKey: string,
  targetLabel: string,
  excerpt?: string,
): boolean {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (!res) return false;
  const rev = revisionOf(res, revision);
  if (!rev) {
    toast('该版本已不可用，引用未加入草稿', 'error');
    return false;
  }
  if (res.formalWorktree != null) {
    toast('工作区文件未上传为会话附件——不能直接引用进草稿（打开只是只读预览；需要引用请先把文件拖入输入区上传）', 'warn');
    return false;
  }
  const attachmentId = res.formalAttachment?.attachmentId ?? res.id;
  const conversationId = conversationOfDraftKey(targetDraftKey) ?? res.formalAttachment?.conversationId ?? '';
  const r = addFileRefToDraft(targetDraftKey, conversationId, {
    attachmentId,
    name: res.title,
    kind: res.formalAttachment?.kind ?? res.mimeType,
    revision,
    hash: rev.hash.startsWith('(') ? undefined : rev.hash,
  });
  if (!r.ok) {
    toast(`引用失败：${r.error ?? '未知错误'}（未写入）`, 'error');
    return false;
  }
  if (excerpt != null && excerpt.trim().length > 0) {
    queueDraftInsert(targetDraftKey, `> 摘录「${res.title}」v${revision}：${excerpt.trim().slice(0, 400)}`);
  }
  recordWrite('preview.quote', `resource=${resourceId} revision=${revision} → 目标草稿 ${targetDraftKey}（固定版本；正文保持用户文字）`);
  toast(r.existed === true
    ? `「${res.title}」已在「${targetLabel}」引用（同文件同版本不重复）`
    : `已引用「${res.title}」到「${targetLabel}」的输入区（发送时按正式附件合同携带版本/hash）`, 'success');
  return true;
}

/* ============================================================
   评论（§7.4 / PV-20/21——正式：向源会话仅记录提交）
   ============================================================ */

export interface FileCommentDraft { body: string }

/**
 * 文件评论的正式落点由页面执行（需要 commandId/账本管线）；这里只做归属与参数校验，
 * 返回发送所需的目标。评论=向**源会话**发一条仅记录消息并携带该附件引用卡——
 * 不触发模型派发、不串会话（PV-20）。
 */
export function fileCommentTarget(resourceId: string): {
  ok: boolean;
  kind?: 'thread' | 'room' | 'dm';
  conversationId?: string;
  threadId?: string;
  roomId?: string;
  attachmentId?: string;
  filename?: string;
  error?: string;
} {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (res == null) return { ok: false, error: '资源不存在' };
  if (res.formalWorktree != null) return { ok: false, error: '工作区文件不属于任何会话——评论需要先在某个会话里讨论它' };
  const attachmentId = res.formalAttachment?.attachmentId ?? res.id;
  const o = res.origin;
  if (o.kind === 'message' && o.threadId != null) {
    const t = s.threads.find((x) => x.id === o.threadId);
    return { ok: true, kind: 'thread', threadId: o.threadId, roomId: t?.roomId ?? o.roomId, attachmentId, filename: res.title };
  }
  if (o.kind === 'message') {
    return { ok: true, kind: 'room', roomId: o.roomId, attachmentId, filename: res.title };
  }
  if (o.kind === 'dm') {
    return { ok: true, kind: 'dm', conversationId: o.conversationId, attachmentId, filename: res.title };
  }
  return { ok: false, error: '该资源不属于任何会话' };
}

/* ============================================================
   布局
   ============================================================ */

export function setLayoutSize(mode: string, ratio: number) {
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  setState((s) => ({
    ...s,
    layout: { ...s.layout, sizes: { ...s.layout.sizes, [mode]: clamped } },
  }));
}

export function setNavPinned(pinned: boolean) {
  setState((s) => ({ ...s, layout: { ...s.layout, navPinned: pinned, navAutoHidden: false } }));
  recordWrite('layout.nav.pin', `用户显式${pinned ? '锁定' : '解除锁定'}导航展开；自动隐藏不覆盖该偏好`);
}

/** 导航自动临时隐藏（幂等——值不变不产生新状态，防重渲染循环）。 */
export function setNavAutoHidden(hidden: boolean) {
  setState((s) => {
    if (s.layout.navPinned && hidden) return s;
    if (s.layout.navAutoHidden === hidden) return s;
    return { ...s, layout: { ...s.layout, navAutoHidden: hidden } };
  });
}

/* ============================================================
   DM audience 隔离（§7.5 / PV-32）
   ============================================================ */

export function visibleTabs(target: ContextTarget) {
  const s = getState();
  return s.preview.tabs
    .filter((t) => {
      const res = resourceOf(s, t.resourceId);
      return res ? audienceAllows(res.audience, target) : false;
    })
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function hiddenTabCount(target: ContextTarget): number {
  const s = getState();
  return s.preview.tabs.length - visibleTabs(target).length;
}

/* ============================================================
   兼容入口
   ============================================================ */

export function resourceIdForArtifact(artifactId: string): string | undefined {
  return resourceOf(getState(), artifactId) ? artifactId : undefined;
}

export function activeTab() {
  const s = getState();
  return s.preview.tabs.find((t) => t.key === s.preview.activeKey);
}

export function activeResource(): PreviewResource | undefined {
  const t = activeTab();
  return t ? resourceOf(getState(), t.resourceId) : undefined;
}

export { tabKeyFor };
